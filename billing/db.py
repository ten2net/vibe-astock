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


def init_schema(conn: sqlite3.Connection) -> None:
    """建表（幂等）。骨架阶段只建 ``orders``；权益/事件表留到后续步骤。"""
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
                waffo_session_id  TEXT,                            -- 后续步骤回填
                waffo_txn_id      TEXT UNIQUE,                     -- 后续步骤回填；唯一约束是幂等种子
                created_at        TEXT NOT NULL,
                updated_at        TEXT NOT NULL
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
