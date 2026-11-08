"""额度账本 —— 托管 AI 额度的发放 / 扣减 / 查询（协议无关内核）。

设计文档 §6、§7、§5.3：
- 这是 §12-2 Webhook「发额度」的落点（``grant``），也是 §12-3 ``/api/ai/*``
  gate「扣额度」的落点（``consume``）。
- **幂等**：每次发放/扣减带 ``idempotency_key``（如 ``grant-<order_id>``），
  ``credit_ledger.idempotency_key`` 上 UNIQUE + ``INSERT OR IGNORE``，
  重复回调 / 重试只会生效一次。
- **原子**：余额变更与流水写入在**同一个事务**内（``db.transaction``），
  不会出现「订单已付但额度没到」这类半状态（§5.3）。
- 追加式 ``credit_ledger`` 同时充当 §7 的对账流水。

不依赖 Waffo 协议；接上 Webhook 后，验签通过的事件在事务里调用 ``grant`` 即可。
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

from .db import transaction

_GRANT = "grant"
_CONSUME = "consume"
_REFUND = "refund"


class InsufficientCredits(Exception):
    """余额不足。事务会回滚，连流水都不落，idempotency_key 不会被烧掉。"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def balance(conn: sqlite3.Connection, user_id: str) -> int:
    row = conn.execute("SELECT credits FROM entitlements WHERE user_id = ?", (user_id,)).fetchone()
    return int(row["credits"]) if row is not None else 0


def entitlement(conn: sqlite3.Connection, user_id: str) -> dict:
    row = conn.execute(
        "SELECT user_id, credits, tier, expires_at, updated_at FROM entitlements WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    if row is None:
        return {"user_id": user_id, "credits": 0, "tier": "community", "expires_at": None}
    return dict(row)


def _apply_unlocked(conn: sqlite3.Connection, *, user_id: str, delta: int, reason: str,
                    ref_id: str | None, idempotency_key: str,
                    allow_negative_balance: bool) -> dict:
    """发放/扣减的核心实现，**不自行开事务**。

    调用方必须已经在 ``db.transaction`` 内（或自己用 ``_apply`` 包装）。
    这样 §12-2 Webhook 才能在**同一个事务**里同时完成「订单置 paid + 发放额度 +
    事件去重标记」三件事，避免嵌套事务提前提交（§5.3 原子性要求）。
    """
    ts = _now()
    # 1) 幂等闸门：同一 key 已处理过 → 直接返回现状，不再动余额
    cur = conn.execute(
        """
        INSERT OR IGNORE INTO credit_ledger
            (idempotency_key, user_id, delta, reason, ref_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (idempotency_key, user_id, delta, reason, ref_id, ts),
    )
    if cur.rowcount == 0:
        return entitlement(conn, user_id)

    # 2) 扣减前校验余额（发放不校验）
    if not allow_negative_balance:
        current = balance(conn, user_id)
        if current < -delta:
            raise InsufficientCredits(f"额度不足：当前 {current}，需要 {-delta}")

    # 3) 更新余额；与上面的流水在同一事务里，要么全成要么全滚
    conn.execute(
        """
        INSERT INTO entitlements (user_id, credits, tier, expires_at, updated_at)
        VALUES (?, ?, 'pro', NULL, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            credits = credits + excluded.credits,
            tier = 'pro',
            updated_at = excluded.updated_at
        """,
        (user_id, delta, ts),
    )
    return entitlement(conn, user_id)


def _apply(conn: sqlite3.Connection, **kw) -> dict:
    """独立调用时自行包裹事务（普通路径用）。"""
    with transaction(conn):
        return _apply_unlocked(conn, **kw)


def grant(conn: sqlite3.Connection, user_id: str, credits: int, *, order_id: str) -> dict:
    """发放额度（§12-2 Webhook 支付成功时调用）。

    ``order_id`` 作为幂等键的一部分：同一笔订单无论回调重发多少次，只发一次。
    """
    if credits <= 0:
        raise ValueError("发放额度必须为正")
    return _apply(
        conn, user_id=user_id, delta=credits, reason=_GRANT, ref_id=order_id,
        idempotency_key=f"grant-{order_id}", allow_negative_balance=True,
    )


def consume(conn: sqlite3.Connection, user_id: str, amount: int, *, ref_id: str) -> dict:
    """扣减额度（§12-3 ``/api/ai/*`` gate 调用）。

    ``ref_id`` 用请求级唯一 id 作幂等键；余额不足抛 ``InsufficientCredits``，
    整个事务回滚，不产生半扣减。
    """
    if amount <= 0:
        raise ValueError("扣减额度必须为正")
    return _apply(
        conn, user_id=user_id, delta=-amount, reason=_CONSUME, ref_id=ref_id,
        idempotency_key=f"consume-{ref_id}", allow_negative_balance=False,
    )


def refund_clawback(conn: sqlite3.Connection, user_id: str, credits: int, *, order_id: str) -> dict:
    """退款时幂等扣回额度（§5.5）。细则随订阅策略定，这里先给可复用原子操作。"""
    if credits <= 0:
        raise ValueError("扣回额度必须为正")
    return _apply(
        conn, user_id=user_id, delta=-credits, reason=_REFUND, ref_id=order_id,
        idempotency_key=f"refund-{order_id}", allow_negative_balance=True,
    )


# --- 供 Webhook 在共享事务内调用（不自行开事务）---------------------------------

def grant_in_tx(conn: sqlite3.Connection, user_id: str, credits: int, *,
                ref_id: str, key: str | None = None) -> dict:
    """``grant`` 的事务内版本：调用方已持有 ``db.transaction``。

    ``ref_id`` 落流水供对账（内部订单号）；``key`` 是幂等键主体，缺省同 ``ref_id``。
    订阅续费传 ``key=eventId``（每期扣款各发一次、重试不重复），一次性购买用订单号。
    """
    if credits <= 0:
        raise ValueError("发放额度必须为正")
    k = key or ref_id
    return _apply_unlocked(
        conn, user_id=user_id, delta=credits, reason=_GRANT, ref_id=ref_id,
        idempotency_key=f"grant-{k}", allow_negative_balance=True,
    )


def refund_clawback_in_tx(conn: sqlite3.Connection, user_id: str, credits: int, *,
                          ref_id: str, key: str | None = None) -> dict:
    """``refund_clawback`` 的事务内版本：调用方已持有 ``db.transaction``。"""
    if credits <= 0:
        raise ValueError("扣回额度必须为正")
    k = key or ref_id
    return _apply_unlocked(
        conn, user_id=user_id, delta=-credits, reason=_REFUND, ref_id=ref_id,
        idempotency_key=f"refund-{k}", allow_negative_balance=True,
    )
