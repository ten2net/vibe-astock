"""billing / 授权 gate / Waffo 支付的 APIRouter（§12-1 + §12-2 + §12-3 内核）。

端点：
    GET  /api/billing/products            商品列表（只读）
    POST /api/billing/orders              创建待处理订单（需 Bearer JWT）
    GET  /api/billing/orders/{id}         查询订单
    GET  /api/billing/entitlement         当前额度/等级（需 Bearer JWT）
    POST /api/billing/checkout            建 Waffo 收银台会话（需 Bearer JWT）
    POST /api/billing/webhook             Waffo 事件回调（**验签**，不需要 JWT）
    POST /api/ai/explain                  Pro 托管 AI 解读（JWT → 扣额度 → 隔离引擎）
    GET  /api/ai/turn/{turn_id}           轮询托管 AI 回合状态（同一 JWT gate）
    POST /api/ai/echo                     gate 冒烟：校验 JWT → 查额度 → 扣减 → 返回 stub

**刻意不做**（§12-3 之后）：真实账号/登录体系、``agent`` 模式证据解读（当前用
``direct``）、订阅状态机（subscription.* 事件目前只记录不发额度）。
``echo`` 只是证明 gate 链路通，不调用任何大模型；真实解读走 ``explain``。

路由默认不挂载：server.py 用 ``ASTOCK_BILLING_ENABLED`` 开关控制，默认关闭。
生产部署注意：``/api/billing/webhook`` 需公网可达，``_vr_guard`` 的 Host 白名单
要求把对外域名写进 ``VIBE_ALLOW_HOSTS``，否则 Waffo 的回调会被 403（见设计文档 §13）。
"""
from __future__ import annotations

import logging
import os
import sqlite3
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

from . import auth, entitlement, hosted_llm, orders, products, waffo, webhooks
from .db import connect, init_schema

logger = logging.getLogger(__name__)

# 一次托管 AI 调用扣减的额度。后续按模型/token 计价时改为按量计算（§6）。
AI_CALL_COST = 10


class CreateOrderBody(BaseModel):
    product_id: str = Field(min_length=1)
    # 注意：这里**没有** price / currency / credits 字段。
    # 即便前端硬塞进来，pydantic 默认忽略额外字段，服务端一律按商品表定。
    # user_id 从 JWT 取，不再信任请求体（§12-3）。


class CheckoutBody(BaseModel):
    product_id: str = Field(min_length=1)


class AiEchoBody(BaseModel):
    prompt: str = Field(default="", max_length=2000)
    # 客户端可给请求级 id 做幂等；不给则服务端生成，重复请求不会重复扣费。
    request_id: str | None = None


class AiExplainBody(BaseModel):
    """Pro 托管 AI 解读请求。**不含** llm / apiKey —— 凭据由服务端注入。"""

    question: str = Field(min_length=1, max_length=2000)
    anchor: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    # 客户端可给请求级 id 做扣费幂等；不给则服务端生成。
    request_id: str | None = None


def _require_user(request: Request) -> str:
    """FastAPI 依赖：从 ``X-Account-Token`` 头读 JWT。

    **不占用 ``Authorization``**：那个头归 ``VR_API_KEY``（前端 ``api.ts::authHeaders``
    写入、``_vr_guard`` 校验），若 JWT 也放进去会与之冲突。设计文档 §6 决策。
    任何异常都转成合适的 HTTP 状态。
    """
    token = request.headers.get("x-account-token", "").strip()
    if not token:
        raise HTTPException(status_code=401, detail="缺少 X-Account-Token 令牌")
    try:
        payload = auth.verify(token)
    except RuntimeError as exc:  # 未配置 JWT 密钥 → 服务未就绪，不是 401
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except auth.AuthError:
        raise HTTPException(status_code=401, detail="令牌无效或已过期") from None
    return str(payload["sub"])


def create_router(db_path: str | Path | None = None, *,
                  waffo_config: "waffo.WaffoConfig | None" = None,
                  checkout_poster=None, review_agent_getter=None) -> APIRouter:
    """构造 router。

    ``db_path`` 显式注入（测试传 tmp_path）；``waffo_config`` / ``checkout_poster``
    / ``review_agent_getter`` 注入便于离线单测（不打网络、不依赖真实引擎）。
    缺省时 Waffo 配置按请求从环境变量惰性读取；``review_agent_getter`` 缺省时从
    ``request.app.state.review_agent`` 取（server.py 的 ``_lifespan`` 注入的现成 Manager，
    不自己 new，避免抢 ``backend.lock``）。
    """
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

    def _config() -> waffo.WaffoConfig:
        if waffo_config is not None:
            return waffo_config
        return waffo.WaffoConfig.from_env()

    def _manager(request: Request):
        """取现成的 review_agent Manager；未就绪返回 None。"""
        if review_agent_getter is not None:
            return review_agent_getter()
        return getattr(request.app.state, "review_agent", None)

    @router.get("/api/billing/products")
    def list_products():
        return {"products": products.list_public()}

    @router.post("/api/billing/orders", status_code=201)
    def create_order(body: CreateOrderBody, user_id: str = Depends(_require_user)):
        try:
            conn = _conn()
            try:
                return orders.create_pending(conn, user_id, body.product_id)
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

    @router.post("/api/billing/checkout", status_code=201)
    def checkout(body: CheckoutBody, user_id: str = Depends(_require_user)):
        """服务端建单 → 调 Waffo 建会话 → 回填 → 返回收银台 URL（§5.1）。

        价格/币种/额度**全部**来自服务端 ``products.py``；Waffo 侧用后台商品定价，
        内部订单号通过 ``orderMerchantExternalId`` + ``metadata`` 透传给 webhook。
        前端只传 product_id，无法影响金额或订单归属。
        """
        try:
            product = products.resolve(body.product_id)
            conn = _conn()
            try:
                order = orders.create_pending(conn, user_id, body.product_id)
            finally:
                conn.close()
            cfg = _config()
            waffo_pid = waffo.resolve_waffo_product_id(body.product_id)
            session = waffo.create_checkout_session(
                cfg,
                waffo_product_id=waffo_pid,
                currency=product.currency,
                order_id=order["order_id"],
                poster=checkout_poster,
            )
        except products.UnknownProduct as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except waffo.ConfigError as exc:
            # 配置缺失：fail closed，且不留下「幽灵订单」之外的误导信息
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except waffo.WaffoError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        conn = _conn()
        try:
            orders.attach_waffo_session(
                conn, order["order_id"],
                session_id=session["sessionId"], checkout_url=session["checkoutUrl"],
                expires_at=session.get("expiresAt"),
            )
        finally:
            conn.close()
        return {
            "order_id": order["order_id"],
            "checkout_url": session["checkoutUrl"],
            "expires_at": session.get("expiresAt"),
        }

    @router.post("/api/billing/webhook")
    async def webhook(request: Request):
        """Waffo 事件回调。用**原始 body**验签，不需要 JWT，但受 Host 白名单保护。

        官方要求 10 秒内返回 2xx；本地 SQLite 处理为毫秒级，故同步处理完再返回。
        验签/环境/店铺失败 → 401；配置缺失 → 503；意外失败 → 500（触发 Waffo 重试，
        重试因 ``eventType + eventId`` 幂等而安全）。
        """
        raw_bytes = await request.body()          # 原始字节，绝不先 JSON 解析
        raw = raw_bytes.decode("utf-8")
        sig = request.headers.get("x-waffo-signature", "")
        try:
            cfg = _config()
            event = waffo.select_and_verify(raw_bytes, sig, cfg)
            waffo.check_event_scope(
                event,
                expected_mode=os.environ.get("WAFFO_EXPECTED_MODE") or None,
                expected_store_id=os.environ.get("WAFFO_STORE_ID") or None,
            )
        except waffo.ConfigError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except waffo.SignatureError as exc:
            logger.warning("Waffo webhook 验签/范围校验失败：%s", exc)
            raise HTTPException(status_code=401, detail=str(exc)) from None

        conn = _conn()
        try:
            result = webhooks.process_event(conn, event, raw_payload=raw)
        except Exception as exc:  # noqa: BLE001  事务已回滚，返回非 2xx 让 Waffo 重试
            logger.exception("Waffo webhook 处理失败，等待重试：%s", exc)
            raise HTTPException(status_code=500, detail="事件处理失败，请重试") from None
        finally:
            conn.close()
        return {"ok": True, **result}

    @router.post("/api/ai/echo")
    def ai_echo(body: AiEchoBody, user_id: str = Depends(_require_user),
                x_request_id: str | None = Header(default=None)):
        """gate 冒烟端点：验证 JWT → 查额度 → 原子扣减 → 返回 stub。

        保留用于离线验证 gate 链路（鉴权 + 计费），**不调用任何真实大模型**；
        真实托管解读走 ``/api/ai/explain``。托管额度耗尽 402 引导积分包，
        **不降级到用户自配 Key 旁路**（§6）。
        """
        ref_id = body.request_id or x_request_id or uuid.uuid4().hex
        conn = _conn()
        try:
            try:
                view = entitlement.consume(conn, user_id, AI_CALL_COST, ref_id=ref_id)
            except entitlement.InsufficientCredits:
                raise HTTPException(status_code=402, detail="托管额度不足，请购买积分包") from None
            return {
                "stub": True,
                "user_id": user_id,
                "echo": body.prompt,
                "charged_credits": AI_CALL_COST,
                "remaining_credits": view["credits"],
            }
        finally:
            conn.close()

    @router.post("/api/ai/explain")
    def ai_explain(request: Request, body: AiExplainBody,
                   user_id: str = Depends(_require_user)):
        """Pro 托管 AI 解读：JWT → 扣额度 → 服务端注入 llm → 进隔离引擎。

        - ``llm`` 由 ``hosted_llm.from_env()`` 从环境变量注入，**绝不取自请求体**，
          未配置返回 503（fail closed，不降级到用户自配 Key）。
        - 用 ``scope.mode='direct'``：普通受控对话、无工具/联网、自动套
          ``PRODUCT_POLICY`` + ``has_trade_recommendation`` 拦截（设计文档 §6 决策）。
          已知限制见文档：direct 不走 FrozenInputs / 引用校验全套。
        - ``Manager.submit`` 是异步的（内部起 daemon 线程），立即返回 ``turn_id``，
          前端再用 ``GET /api/ai/turn/{id}`` 轮询终态。
        - 额度扣减在 submit **之前**；submit 抛 ``EvidenceError``（全局单活跃等）时
          要**退还**已扣额度，避免扣了钱没干活。
        """
        from datetime import datetime, timezone
        from review_agent.api import TurnInput
        from review_agent.evidence import EvidenceError

        # 1) 托管 LLM 配置（服务端注入）
        try:
            llm = hosted_llm.from_env().as_model_input()
        except hosted_llm.HostedLLMNotConfigured as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

        # 2) 现成 Manager（server.py 注入），不自己 new
        manager = _manager(request)
        if manager is None:
            raise HTTPException(status_code=503, detail="复盘 Agent 服务尚未启动")

        ref_id = body.request_id or uuid.uuid4().hex
        anchor = body.anchor or datetime.now(timezone.utc).astimezone().date().isoformat()

        # 3) 扣额度（原子、幂等）
        conn = _conn()
        try:
            try:
                view = entitlement.consume(conn, user_id, AI_CALL_COST, ref_id=ref_id)
            except entitlement.InsufficientCredits:
                raise HTTPException(status_code=402, detail="托管额度不足，请购买积分包") from None
        finally:
            conn.close()

        # 4) 进隔离引擎；失败退还额度（用一个反向 grant 抵消，幂等 key 独立）
        try:
            turn = manager.submit(TurnInput(
                anchor=anchor,
                question=body.question,
                request_id=uuid.uuid4().hex,   # 引擎内部 32hex 幂等键，与计费 ref_id 分开
                llm=llm,
                scope={"mode": "direct", "page": "账号与订阅"},
            ))
        except EvidenceError as exc:
            conn = _conn()
            try:
                entitlement.grant(conn, user_id, AI_CALL_COST, order_id=f"refund-{ref_id}")
            finally:
                conn.close()
            raise HTTPException(status_code=409, detail=str(exc)) from None
        except Exception as exc:  # noqa: BLE001  pydantic/运行时异常同样退还，避免静默扣费
            logger.exception("托管 AI submit 失败：%s", exc)
            conn = _conn()
            try:
                entitlement.grant(conn, user_id, AI_CALL_COST, order_id=f"refund-{ref_id}")
            finally:
                conn.close()
            raise HTTPException(status_code=502, detail="托管 AI 调用失败，额度已退还") from None

        return {
            "turn_id": turn["id"],
            "conversation_id": turn.get("conversation_id"),
            "status": turn.get("status"),
            "charged_credits": AI_CALL_COST,
            "remaining_credits": view["credits"],
        }

    @router.get("/api/ai/turn/{turn_id}")
    def ai_turn(turn_id: str, request: Request, user_id: str = Depends(_require_user)):
        """轮询托管 AI 回合状态。走同一套 JWT gate，不复用 review-agent 的
        ``VR_API_KEY`` 路由，避免前端混用两套认证。只读 ``manager.store.turn``。"""
        from review_agent.evidence import EvidenceError

        manager = _manager(request)
        if manager is None:
            raise HTTPException(status_code=503, detail="复盘 Agent 服务尚未启动")
        try:
            return manager.store.turn(turn_id)
        except EvidenceError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None

    return router
