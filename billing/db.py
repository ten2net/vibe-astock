"""billing 的 SQLite 存储与事务基础。

存储根沿用 ``ASTOCK_AGENT_HOME``（与 server.py 的 review agent 根一致），
落在 ``<root>/billing/billing.db``，**不进浏览器本地存储**，也**不**混入
``ASTOCK_DATA_HOME``（~/.duanxian-agents）的复盘/台账目录。见设计文档 §4。

本模块只提供连接、建表、事务三件事；不含任何支付、验签、授权逻辑。
所有函数都显式接收连接或路径，便于离线单测注入 tmp_path，不依赖全局状态。
"""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

_DB_FILENAME = "billing.db"


def default_db_path() -> Path:
    """运行环境默认库路径。测试不要用它，应显式传 tmp_path。"""
    root = Path(os.environ.get("ASTOCK_AGENT_HOME", "~/.vibe-astock-agent")).expanduser().resolve()
    return root / "billing" / _DB_FILENAME


def connect(path: str | Path) -> sqlite3.Connection:
    """打开（必要时创建目录）并返回一个已配置好的连接。调用方负责 close。"""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _add_columns_if_missing(conn: sqlite3.Connection, table: str, columns: dict[str, str]) -> None:
    """给老库补列（SQLite 不支持 ``ADD COLUMN IF NOT EXISTS``）。"""
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    for name, decl in columns.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


def init_schema(conn: sqlite3.Connection) -> None:
    """建表（幂等，全部 ``IF NOT EXISTS``，老库通过 ``ALTER`` 平滑升级）。

    - ``orders``：内部订单（§12-1）；§12-2 补了 checkout_url / waffo_order_id 等回写列
    - ``entitlements`` / ``credit_ledger``：额度账本（§12-3 内核，同时是 §12-2
      Webhook「发额度」的落点）
    - ``processed_webhooks``：官方推荐的幂等去重表（``eventType + eventId`` 唯一约束），
      同时留存原始事件与处理结果供 §7 对账
    """
    with transaction(conn):
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS orders (
                order_id          TEXT PRIMARY KEY,          -- 内部订单号（我们自己生成）
                user_id           TEXT NOT NULL,
                product_id        TEXT NOT NULL,
                -- 下单瞬间的商品快照：价格/币种/额度由服务端定，落库后不再随商品表变化
                price_cents       INTEGER NOT NULL,
                currency          TEXT NOT NULL,
                credits           INTEGER NOT NULL,
                status            TEXT NOT NULL DEFAULT 'pending',  -- pending / paid / refunded
                waffo_session_id  TEXT,                            -- Waffo 会话 id（cs_xxx）
                waffo_txn_id      TEXT UNIQUE,                     -- Waffo 支付/订单 id
                created_at        TEXT NOT NULL,
                updated_at        TEXT NOT NULL
            )
            """
        )
        # §12-2 新增列：老库升级用 ALTER，新库由上面 CREATE 不含这些列、靠这里补齐。
        _add_columns_if_missing(conn, "orders", {
            "checkout_url": "TEXT",          # 收银台 URL，返回给前端跳转
            "checkout_expires_at": "TEXT",   # 会话过期时间
            "waffo_order_id": "TEXT",        # webhook data.orderId（ORD_xxx）
            "buyer_email": "TEXT",           # webhook data.buyerEmail
            "waffo_event_id": "TEXT",        # 触发 paid 的 eventId（PAY_xxx）
        })
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS entitlements (
                user_id     TEXT PRIMARY KEY,
                credits     INTEGER NOT NULL DEFAULT 0,   -- 当前托管 AI 额度余额
                tier        TEXT NOT NULL DEFAULT 'community',  -- community / pro
                expires_at  TEXT,                          -- 订阅到期（积分包购买不设）
                updated_at  TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS credit_ledger (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                idempotency_key   TEXT NOT NULL UNIQUE,   -- grant-<order_id> / consume-<ref_id>
                user_id           TEXT NOT NULL,
                delta             INTEGER NOT NULL,        -- 正=发放，负=扣减
                reason            TEXT NOT NULL,          -- grant / consume / refund
                ref_id            TEXT,                   -- 关联订单号 / 请求号，供对账（§7）
                created_at        TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS processed_webhooks (
                event_type    TEXT NOT NULL,
                event_id      TEXT NOT NULL,
                mode          TEXT,                       -- test / prod
                store_id      TEXT,
                order_id      TEXT,                       -- 关联站内内部订单（可空）
                outcome       TEXT NOT NULL,              -- granted / duplicate / ignored / refunded / error
                raw_payload   TEXT,                       -- 原始 body，供对账/恢复（§7、§5.5）
                received_at   TEXT NOT NULL,
                PRIMARY KEY (event_type, event_id)
            )
            """
        )


@contextmanager
def transaction(conn: sqlite3.Connection):
    """原子事务：正常提交，异常回滚。

    设计文档 §5.3 要求「订单与额度在一个事务内处理」；额度表后续加入时复用本上下文，
    避免出现「订单已付但额度没到」这类半状态。
    """
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
