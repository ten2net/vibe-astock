"""Waffo Webhook 事件处理（§12-2 核心）。

官方契约：https://docs.waffo.ai/api-reference/webhooks.md

设计要点：
- **幂等**：官方推荐用 ``eventType + eventId`` 去重（``processed_webhooks`` 联合主键），
  不是靠收紧时间窗。重试会带**同一个** ``eventId`` 和原始签名头，所以重复投递
  必须安全跳过。
- **原子**：事件去重标记、订单置 paid、发放/扣回额度**全部在单个事务**内
  （``db.transaction`` + ``*_in_tx`` 变体，避免嵌套事务提前提交），满足 §5.3
  「订单与额度一起处理」。
- **可核对**：每个事件（含被忽略/重复的）都落 ``processed_webhooks`` 并保留原始
  payload，供 §7 对账与 §5.5 的「回调早于建单 / 乱序」恢复路径，不假装成功。
- **响应**：官方要求「10 秒内返回 2xx，先返回再异步处理」。本实现处理的是本地
  SQLite（毫秒级、无外部 IO），故**同步处理完再返回 200**：既在时限内，又能让
  意外失败返回非 2xx 触发 Waffo 重试（重试安全，因为幂等）。这是对官方「建议
  异步」的刻意简化，理由见设计文档 §13。

事件覆盖（官方 Event Types 的子集，够 v2 付费版用）：
    order.completed                 一次性积分包/商品购买成功 → 置 paid + 发放额度
    subscription.payment_succeeded 订阅每次扣款成功（含首次与续费）→ 发放该期额度
    refund.succeeded                退款完成 → 幂等扣回额度
    其余事件（subscription.activated / renewed / canceled / past_due / store.* 等）
    仅记录待处理，不改额度（订阅状态机留待后续，§5.5）。

金额字段按官方「Deprecated amount fields」用主体命名（``chargedAmount`` /
``listPrice.total`` / ``refundedAmount`` / ``originalPayment.total`` / ``planPrice.total``），
**断言绝不依赖 ``amount == total``**（见 ``waffo.parse_amount`` 与设计文档 §5.4）。
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

from . import entitlement, orders, waffo
from .db import transaction


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _resolve_order_id(event: dict) -> str | None:
    """从 webhook 找回站内内部订单号。

    建会话时我们把内部订单号同时写进 ``orderMerchantExternalId`` 与
    ``metadata.orderId``，官方文档说明它们分别透传到 ``data.orderMerchantExternalId``
    与 ``data.orderMetadata``。两处都试，取第一个非空值。
    """
    data = waffo.event_data(event)
    ext = data.get("orderMerchantExternalId")
    if isinstance(ext, str) and ext:
        return ext
    meta = data.get("orderMetadata") or {}
    oid = meta.get("orderId") if isinstance(meta, dict) else None
    return oid if isinstance(oid, str) and oid else None


def _record(conn: sqlite3.Connection, event: dict, raw: str, outcome: str,
            order_id: str | None) -> None:
    """落一条事件记录（含原始 payload）。表已在 ``init_schema`` 建好。"""
    conn.execute(
        """
        INSERT OR IGNORE INTO processed_webhooks
            (event_type, event_id, mode, store_id, order_id, outcome, raw_payload, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(event.get("eventType", "")),
            str(event.get("eventId") or event.get("id") or ""),
            event.get("mode"),
            event.get("storeId"),
            order_id,
            outcome,
            raw,
            _now(),
        ),
    )


def process_event(conn: sqlite3.Connection, event: dict, *, raw_payload: str) -> dict:
    """处理一个**已验签**的事件。返回结果 dict（``outcome`` 等）。

    整个流程在一个事务内；异常向上抛（由 router 转成 5xx 触发 Waffo 重试）。
    重复事件（同 eventType + eventId）直接返回 ``duplicate``，不再动余额。
    """
    etype = str(event.get("eventType", ""))
    eid = str(event.get("eventId") or event.get("id") or "")
    order_id = _resolve_order_id(event)
    data = waffo.event_data(event)

    with transaction(conn):
        # 1) 幂等闸门：同事件已处理 → 直接返回，事务内不做任何业务变更
        cur = conn.execute(
            "INSERT OR IGNORE INTO processed_webhooks "
            "(event_type, event_id, mode, store_id, order_id, outcome, raw_payload, received_at) "
            "VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
            (etype, eid, event.get("mode"), event.get("storeId"), order_id, raw_payload, _now()),
        )
        if cur.rowcount == 0:
            return {"outcome": "duplicate", "event_type": etype, "event_id": eid}

        outcome = "ignored"
        detail = ""

        # 2) 按事件主体分发
        if etype in waffo.PAYMENT_EVENTS or etype == "refund.succeeded":
            if not order_id:
                # 回调早于建单 / 关联不上：留原始记录待人工或下一轮核对，不假装成功（§5.5）
                outcome = "ignored"
                detail = "无法关联站内内部订单号"
            else:
                try:
                    order = orders.get(conn, order_id)
                except orders.UnknownOrder:
                    outcome = "ignored"
                    detail = "内部订单不存在"
                else:
                    if etype == "refund.succeeded":
                        # 退款：幂等扣回该订单对应额度（按退款 eventId 作幂等主体，
                        # 支持同一订单多笔部分退款；v1 按整单额度扣回，§5.5 细则待定）
                        entitlement.refund_clawback_in_tx(
                            conn, order["user_id"], order["credits"],
                            ref_id=order_id, key=f"{order_id}-{eid}",
                        )
                        # 已 paid 才能转 refunded；若仍 pending 则仅记录（避免非法流转）
                        if order["status"] == "paid":
                            orders.set_status_in_tx(conn, order_id, "refunded")
                        outcome = "refunded"
                        detail = f"扣回 {order['credits']} 额度"
                    else:
                        # 支付成功：置 paid（已是 paid 的续费跳过状态变更）+ 发放额度
                        if order["status"] == "pending":
                            orders.set_status_in_tx(
                                conn, order_id, "paid",
                                waffo_order_id=data.get("orderId"),
                                buyer_email=data.get("buyerEmail"),
                                waffo_event_id=eid,
                            )
                        # 幂等键：一次性订单用订单号；订阅按 payment eventId，
                        # 这样每次续费各发一期、又不会因重试重复发。
                        grant_key = None if etype == "order.completed" else eid
                        entitlement.grant_in_tx(
                            conn, order["user_id"], order["credits"],
                            ref_id=order_id, key=grant_key,
                        )
                        outcome = "granted"
                        detail = f"发放 {order['credits']} 额度"
        else:
            # 订阅状态变更 / store 事件：v1 只记录，订阅状态机留待后续（§5.5）
            outcome = "ignored"
            detail = "该事件类型不触发额度变更"

        # 3) 把最终结论写回同一条事件记录（同一事务）
        conn.execute(
            "UPDATE processed_webhooks SET outcome = ? WHERE event_type = ? AND event_id = ?",
            (outcome, etype, eid),
        )
        return {
            "outcome": outcome,
            "event_type": etype,
            "event_id": eid,
            "order_id": order_id,
            "detail": detail,
        }
