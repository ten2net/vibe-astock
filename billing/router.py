"""billing 的最小 APIRouter（骨架阶段）。

设计文档 §4 / §12 第 1 步。当前只暴露三个**不碰钱**的端点：
    GET  /api/billing/products          商品列表（只读）
    POST /api/billing/orders            创建待处理订单（仅落库，不发支付会话）
    GET  /api/billing/orders/{id}       查询订单

**刻意不做**（留给后续步骤）：
    /checkout（§12-2，Waffo 建会话）、/webhook（§12-2，验签+幂等+发额度）、
    /entitlement 与 /api/ai/* gate（§12-3，授权与额度）。

路由默认不挂载：server.py 用 ``ASTOCK_BILLING_ENABLED`` 开关控制，默认关闭，
因此骨架阶段**不改变现有线上 API 行为**。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import orders, products
from .db import connect, init_schema


class CreateOrderBody(BaseModel):
    # 骨架阶段无鉴权（§12-3 才引入 JWT），user_id 由调用方显式给出；
    # 接上授权后改为从 JWT 取，不再信任请求体。
    user_id: str = Field(min_length=1)
    product_id: str = Field(min_length=1)
    # 注意：这里**没有** price / currency / credits 字段。
    # 即便前端硬塞进来，pydantic 默认会忽略额外字段，服务端一律按商品表定。


def create_router(db_path: str | Path | None = None) -> APIRouter:
    """构造 router。``db_path`` 显式注入（测试传 tmp_path）；缺省用默认库路径。"""
    from .db import default_db_path

    path = Path(db_path) if db_path is not None else default_db_path()
    # 启动时确保表存在；连接按请求短开短关，避免跨线程共享 sqlite 连接。
    _bootstrap = connect(path)
    try:
        init_schema(_bootstrap)
    finally:
        _bootstrap.close()

    router = APIRouter(prefix="/api/billing", tags=["billing"])

    def _conn() -> sqlite3.Connection:
        return connect(path)

    @router.get("/products")
    def list_products():
        return {"products": products.list_public()}

    @router.post("/orders", status_code=201)
    def create_order(body: CreateOrderBody):
        try:
            conn = _conn()
            try:
                return orders.create_pending(conn, body.user_id, body.product_id)
            finally:
                conn.close()
        except products.UnknownProduct as exc:
            # 前端传了服务端商品表里没有的 id → 拒绝建单（§5.1「无映射就拒绝」）
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.get("/orders/{order_id}")
    def get_order(order_id: str):
        conn = _conn()
        try:
            try:
                return orders.get(conn, order_id)
            except orders.UnknownOrder as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
        finally:
            conn.close()

    return router
