"""内部订单 —— 把 Waffo 交易与站内用户 / 商品 / 额度流水关联起来。

设计文档 §5.1：服务端先建**带内部订单号**的待处理订单，再（后续步骤）创建
Waffo 支付会话并把订单号传过去。本模块只负责订单本身：创建、查询、状态流转。

- 下单瞬间把商品配置**快照**进订单（price_cents / currency / credits），
  之后商品表调价不影响已建订单。
- ``waffo_txn_id`` 上的 UNIQUE 约束是后续 Webhook 幂等的种子（§5.3）。
- 骨架阶段不创建支付会话、不发额度、不接 Waffo API。

状态机（骨架只实现到 pending；paid/refunded 留给后续 Webhook 步骤驱动）：
    pending ──(验签通过的支付事件)──> paid ──(退款事件)──> refunded
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


def set_status(conn: sqlite3.Connection, order_id: str, new_status: str) -> dict:
    """按状态机流转。非法跳转（含 paid→pending）抛 ``IllegalTransition``。

    后续 Webhook 在**同一个事务**里调用本函数 + 发放额度，保证原子性（§5.3）。
    """
    if new_status not in _ALLOWED_STATUSES:
        raise OrderError(f"未知状态：{new_status!r}")
    current = get(conn, order_id)["status"]
    if new_status not in _ALLOWED_TRANSITIONS[current]:
        raise IllegalTransition(f"不允许 {current} → {new_status}")
    with transaction(conn):
        conn.execute(
            "UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?",
            (new_status, _now(), order_id),
        )
    return get(conn, order_id)


def attach_waffo_session(conn: sqlite3.Connection, order_id: str, session_id: str) -> dict:
    """后续建会话成功后回填 Waffo 会话 id（骨架不调用）。"""
    get(conn, order_id)  # 存在性校验
    with transaction(conn):
        conn.execute(
            "UPDATE orders SET waffo_session_id = ?, updated_at = ? WHERE order_id = ?",
            (session_id, _now(), order_id),
        )
    return get(conn, order_id)
