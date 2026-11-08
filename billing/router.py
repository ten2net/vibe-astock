"""billing / 授权 gate 的 APIRouter（骨架阶段，§12-1 + §12-3 内核）。

端点：
    GET  /api/billing/products            商品列表（只读）
    POST /api/billing/orders              创建待处理订单（仅落库，不发支付会话）
    GET  /api/billing/orders/{id}         查询订单
    GET  /api/billing/entitlement         当前额度/等级（需 Bearer JWT）
    POST /api/ai/echo                     gate 占位：校验 JWT → 查额度 → 扣减 → 返回 stub

**刻意不做**（等 Waffo 官方文档，§12-2）：
    /checkout（建会话）、/webhook（验签+幂等+发额度）。waffo.py 只定义了
    WebhookVerifier / CheckoutClient 的 Protocol 契约，具体实现 pending。
**刻意不做**（§12-3 之后）：真实账号/登录体系、``/api/ai/*`` 接真实
    ``review_agent`` 隔离引擎。``echo`` 只是证明 gate 链路通，不调用任何大模型。

路由默认不挂载：server.py 用 ``ASTOCK_BILLING_ENABLED`` 开关控制，默认关闭，
因此骨架阶段**不改变现有线上 API 行为**。
"""
from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

from . import auth, entitlement, orders, products
from .db import connect, init_schema

# 一次托管 AI 调用扣减的额度。后续按模型/token 计价时改为按量计算（§6）。
AI_CALL_COST = 10


class CreateOrderBody(BaseModel):
    # 骨架阶段建单仍用请求体里的 user_id；接上真实登录 + checkout（§12-2）后
    # 改为从 JWT 取，不再信任请求体（§12-3 注释）。当前端点不碰钱。
    user_id: str = Field(min_length=1)
    product_id: str = Field(min_length=1)
    # 注意：这里**没有** price / currency / credits 字段。
    # 即便前端硬塞进来，pydantic 默认会忽略额外字段，服务端一律按商品表定。


class AiEchoBody(BaseModel):
    prompt: str = Field(default="", max_length=2000)
    # 客户端可给请求级 id 做幂等；不给则服务端生成，重复请求不会重复扣费。
    request_id: str | None = None


def _require_user(request: Request) -> str:
    """FastAPI 依赖：从 Bearer JWT 取 user_id。任何异常都转成合适的 HTTP 状态。"""
    header = request.headers.get("authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="缺少 Bearer 令牌")
    token = header[len("Bearer "):].strip()
    try:
        payload = auth.verify(token)
    except RuntimeError as exc:  # 未配置 JWT 密钥 → 服务未就绪，不是 401
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except auth.AuthError:
        raise HTTPException(status_code=401, detail="令牌无效或已过期") from None
    return str(payload["sub"])


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

    # 单一 router + 全路径：既能挂 /api/billing/* 也能挂 /api/ai/*，
    # 同时保持 §12-1 已验证的 /api/billing/* 路径不变。
    router = APIRouter(tags=["billing"])

    def _conn() -> sqlite3.Connection:
        return connect(path)

    @router.get("/api/billing/products")
    def list_products():
        return {"products": products.list_public()}

    @router.post("/api/billing/orders", status_code=201)
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

    @router.get("/api/billing/orders/{order_id}")
    def get_order(order_id: str):
        conn = _conn()
        try:
            try:
                return orders.get(conn, order_id)
            except orders.UnknownOrder as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
        finally:
            conn.close()

    @router.get("/api/billing/entitlement")
    def get_entitlement(user_id: str = Depends(_require_user)):
        conn = _conn()
        try:
            return entitlement.entitlement(conn, user_id)
        finally:
            conn.close()

    @router.post("/api/ai/echo")
    def ai_echo(body: AiEchoBody, user_id: str = Depends(_require_user),
                x_request_id: str | None = Header(default=None)):
        """gate 占位端点：验证 JWT → 查额度 → 原子扣减 → 返回 stub。

        只证明 §6 的 gate 链路（鉴权 + 计费）通；**不调用任何真实大模型**，
        真实 handler 接 ``review_agent`` 隔离引擎后替换本函数体（§12-3 之后）。
        托管额度耗尽时返回 402 并引导积分包，**不降级到用户自配 Key 旁路**（§6）。
        """
        ref_id = body.request_id or x_request_id or uuid.uuid4().hex
        conn = _conn()
        try:
            try:
                view = entitlement.consume(conn, user_id, AI_CALL_COST, ref_id=ref_id)
            except entitlement.InsufficientCredits:
                raise HTTPException(status_code=402, detail="托管额度不足，请购买积分包") from None
            # 占位：真实实现在这里走 review_agent.isolated engine（FrozenInputs /
            # DISABLED / ANSWER_SCHEMA / has_trade_recommendation 全部不变）。
            return {
                "stub": True,
                "user_id": user_id,
                "echo": body.prompt,
                "charged_credits": AI_CALL_COST,
                "remaining_credits": view["credits"],
            }
        finally:
            conn.close()

    return router
