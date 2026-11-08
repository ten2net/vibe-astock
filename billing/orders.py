"""内部订单 —— 把 Waffo 交易与站内用户 / 商品 / 额度流水关联起来。

设计文档 §5.1：服务端先建**带内部订单号**的待处理订单，再（后续步骤）创建
Waffo 支付会话并把订单号传过去。本模块只负责订单本身：创建、查询、状态流转。

- 下单瞬间把商品配置**快照**进订单（price_cents / currency / credits），
  之后商品表调价不影响已建订单。
- ``waffo_txn_id`` 上的 UNIQUE 约束是订单级幂等的补充；官方推荐的事件级幂等
  （``eventType + eventId``）在 ``processed_webhooks`` 表，见 ``webhooks.py``。

状态机（由验签通过的 Webhook 驱动，见 ``webhooks.py``）：
    pending ──(order.completed / subscription.payment_succeeded)──> paid ──(refund.succeeded)──> refunded
"""
from __future__ import annotations

import sqlite3
import uuid
from datetime import datetime, timezone

from . import products
from .db import transaction

_ALLOWED_STATUSES = frozenset({"pending", "paid", "refunded"})
# 允许的状态流转（后续步骤复用本表，避免乱序回调把 paid 改回 pending）
_ALLOWED_TRANSITIONS = {
    "pending": frozenset({"paid"}),
    "paid": frozenset({"refunded"}),
    "refunded": frozenset(),
}


class OrderError(ValueError):
    pass


class UnknownOrder(OrderError):
    pass


class IllegalTransition(OrderError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _row_to_dict(row: sqlite3.Row) -> dict:
    return dict(row)


def create_pending(
    conn: sqlite3.Connection,
    user_id: str,
    product_id: str,
) -> dict:
    """创建待处理订单。

    ``product_id`` 经服务端商品表解析；价格 / 币种 / 积分**全部**来自服务端快照，
    函数签名里没有、也不接受任何来自前端的金额或积分参数。
    """
    product = products.resolve(product_id)  # 未知 id → UnknownProduct → 上层 4xx
    order_id = uuid.uuid4().hex
    ts = _now()
    with transaction(conn):
        conn.execute(
            """
            INSERT INTO orders
                (order_id, user_id, product_id, price_cents, currency, credits,
                 status, waffo_session_id, waffo_txn_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)
            """,
            (order_id, user_id, product_id, product.price_cents, product.currency,
             product.credits, ts, ts),
        )
    return get(conn, order_id)


def get(conn: sqlite3.Connection, order_id: str) -> dict:
    row = conn.execute("SELECT * FROM orders WHERE order_id = ?", (order_id,)).fetchone()
    if row is None:
        raise UnknownOrder(f"订单不存在：{order_id!r}")
    return _row_to_dict(row)


def _set_status_unlocked(conn: sqlite3.Connection, order_id: str, new_status: str,
                         *, waffo_order_id: str | None = None,
                         buyer_email: str | None = None,
                         waffo_event_id: str | None = None) -> dict:
    """状态流转核心（不自行开事务），并可选回填 Waffo 侧标识。"""
    if new_status not in _ALLOWED_STATUSES:
        raise OrderError(f"未知状态：{new_status!r}")
    current = get(conn, order_id)["status"]
    if new_status not in _ALLOWED_TRANSITIONS[current]:
        raise IllegalTransition(f"不允许 {current} → {new_status}")
    conn.execute(
        """
        UPDATE orders
           SET status = ?, updated_at = ?,
               waffo_order_id = COALESCE(?, waffo_order_id),
               buyer_email = COALESCE(?, buyer_email),
               waffo_event_id = COALESCE(?, waffo_event_id)
         WHERE order_id = ?
        """,
        (new_status, _now(), waffo_order_id, buyer_email, waffo_event_id, order_id),
    )
    return get(conn, order_id)


def set_status(conn: sqlite3.Connection, order_id: str, new_status: str) -> dict:
    """按状态机流转。非法跳转（含 paid→pending）抛 ``IllegalTransition``。"""
    with transaction(conn):
        return _set_status_unlocked(conn, order_id, new_status)


def set_status_in_tx(conn: sqlite3.Connection, order_id: str, new_status: str,
                     *, waffo_order_id: str | None = None,
                     buyer_email: str | None = None,
                     waffo_event_id: str | None = None) -> dict:
    """``set_status`` 的事务内版本（§12-2 Webhook 用，与发放额度共享一个事务）。"""
    return _set_status_unlocked(
        conn, order_id, new_status,
        waffo_order_id=waffo_order_id, buyer_email=buyer_email, waffo_event_id=waffo_event_id,
    )


def attach_waffo_session(conn: sqlite3.Connection, order_id: str, *,
                         session_id: str, checkout_url: str,
                         expires_at: str | None = None) -> dict:
    """建会话成功后回填 Waffo 会话 id / 收银台 URL / 过期时间（§12-2）。"""
    get(conn, order_id)  # 存在性校验
    with transaction(conn):
        conn.execute(
            """
            UPDATE orders
               SET waffo_session_id = ?, checkout_url = ?, checkout_expires_at = ?, updated_at = ?
             WHERE order_id = ?
            """,
            (session_id, checkout_url, expires_at, _now(), order_id),
        )
    return get(conn, order_id)
