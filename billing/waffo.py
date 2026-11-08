"""Waffo Pancake 适配层 —— 按官方集成文档实现（Python / FastAPI 手动 REST 接入）。

官方文档（本实现的唯一契约来源）：
- https://docs.waffo.ai/api-reference/webhooks.md           验签、payload、事件类型、响应要求
- https://docs.waffo.ai/api-reference/endpoints/orders/create-checkout-session.md  建会话
- https://docs.waffo.ai/api-reference/authentication.md     API Key 请求签名
- https://docs.waffo.ai/integrate/ai-integration.md         SDK/环境变量概览

为什么用 Python 手动 REST 而不是官方 ``@waffo/pancake-ts`` SDK：后端是 Python/FastAPI
单进程单端口，官方 SDK 是 TypeScript；官方文档同时给出了 Python 手动签名/验签的完整
示例（``cryptography`` + ``requests``），手动接入零新增服务、最贴合现有栈。

三块真实契约：

1) **Webhook 验签**（webhooks.md「Signature Verification」）
   - 头 ``X-Waffo-Signature: t=<毫秒时间戳>,v1=<base64签名>``
   - 签名输入 ``f"{t}.{raw_body}"``（**原始 body，绝不先 JSON 解析**）
   - ``RSA-SHA256`` + ``PKCS1v15`` + ``SHA256``，用 Dashboard 的 Webhook 公钥 PEM
   - 时间容差 **45 分钟（不是 5 分钟）**：重试带的是原始 t，最后一次重试在首次
     投递 31+ 分钟后；真正的防重放靠 ``eventType + eventId`` 去重，不靠收紧时间窗
   - ``mode`` = ``test`` / ``prod`` 决定用哪把公钥（测试/生产各一把，平台级）

2) **API Key 请求签名**（authentication.md「Manual Integration」）
   - ``canonical = METHOD + "\\n" + PATH + "\\n" + TIMESTAMP + "\\n" + SHA256_BASE64(BODY)``
   - ``X-Signature = Base64(RSA-SHA256(canonical, privateKey))``，头带
     ``X-Merchant-Id`` / ``X-Timestamp`` / ``X-Signature``；**不需要** ``X-Environment``
     （每个 API Key 在创建时绑定 test 或 prod）
   - 时间戳窗口：落后服务器 ≤5 分钟、超前 ≤1 分钟（出站请求，与 webhook 的 45 分钟不同）

3) **建会话**（create-checkout-session.md）
   - ``POST /v1/actions/checkout/create-session``，body 至少 ``productId`` + ``currency``
   - ``orderMerchantExternalId`` 透传业务订单号 → webhook ``data.orderMerchantExternalId``
   - ``metadata`` 透传 → webhook ``data.orderMetadata``
   - 响应 ``{data:{sessionId, checkoutUrl, expiresAt}}``
   - 价格以 Waffo 后台商品定价为准（官方推荐的「Path B：复用控制台商品」），
     ``products.py`` 的 price_cents 用于展示与发放积分，**必须与后台商品价一致**；
     前端无法篡改（用 API Key 服务端发起，非 Store Slug）。

配置全部走环境变量，绝不硬编码密钥；缺配置一律明确报错（fail closed）。
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import time
from dataclasses import dataclass
from typing import Any, Callable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

_API_BASE_DEFAULT = "https://api.waffo.ai"
_CHECKOUT_PATH = "/v1/actions/checkout/create-session"
# 官方文档：45 分钟，不是 5 分钟（重试带原始 t，最后一次重试在 31+ 分钟后）
_SIGNATURE_TOLERANCE_MS = 45 * 60 * 1000


class WaffoError(ValueError):
    """配置/契约错误基类。"""


class ConfigError(WaffoError):
    """环境变量缺失或格式错误。fail closed，不使用任何默认密钥。"""


class SignatureError(WaffoError):
    """验签失败：头格式错、时间窗外、签名不匹配、公钥不匹配。"""


class UnknownEventType(WaffoError):
    """未知事件主体（parse_amount）。"""


# ---------------------------------------------------------------- 配置

@dataclass(frozen=True)
class WaffoConfig:
    merchant_id: str
    private_key_pem: str
    public_key_test_pem: str
    public_key_prod_pem: str
    api_base: str = _API_BASE_DEFAULT

    @classmethod
    def from_env(cls) -> "WaffoConfig":
        """从环境变量构造。测试请直接构造 dataclass，不依赖全局环境。"""
        def need(name: str) -> str:
            v = os.environ.get(name, "").strip()
            if not v:
                raise ConfigError(f"未配置 {name}；Waffo 集成拒绝以无凭据状态运行")
            return v

        # 私钥支持转义换行 ``\n``（文档 Option A）与 Base64（Option B，环境变量名带 _BASE64）
        private = os.environ.get("WAFFO_PRIVATE_KEY", "").strip()
        if not private:
            b64 = os.environ.get("WAFFO_PRIVATE_KEY_BASE64", "").strip()
            if not b64:
                raise ConfigError("未配置 WAFFO_PRIVATE_KEY / WAFFO_PRIVATE_KEY_BASE64")
            private = base64.b64decode(b64).decode("utf-8")
        private = private.replace("\\n", "\n")

        def pubkey(name: str) -> str:
            v = os.environ.get(name, "").strip().replace("\\n", "\n")
            if not v:
                raise ConfigError(f"未配置 {name}（Dashboard → Settings → Webhooks 的公钥）")
            return v

        return cls(
            merchant_id=need("WAFFO_MERCHANT_ID"),
            private_key_pem=private,
            public_key_test_pem=pubkey("WAFFO_WEBHOOK_PUBLIC_KEY_TEST"),
            public_key_prod_pem=pubkey("WAFFO_WEBHOOK_PUBLIC_KEY_PROD"),
            api_base=os.environ.get("WAFFO_API_BASE", _API_BASE_DEFAULT).rstrip("/"),
        )

    def public_key_for_mode(self, mode: str) -> str:
        """按 webhook ``mode`` 选公钥；测试公钥验不了生产事件，反之亦然（文档警告）。"""
        if mode == "test":
            return self.public_key_test_pem
        if mode == "prod":
            return self.public_key_prod_pem
        raise ConfigError(f"未知 webhook 环境 mode={mode!r}（应为 test / prod）")


def resolve_waffo_product_id(product_id: str) -> str:
    """把站内商品 id 映射到 Waffo 后台 Product ID（``PROD_xxx``）。

    真实 Product ID 属于运行时配置，不硬编码进代码（文档「Store ID 和 Product ID
    属于运行时值」）。约定环境变量 ``WAFFO_PRODUCT_<大写站内ID>``，例如
    ``WAFFO_PRODUCT_PRO_MONTH=PROD_xxx``。未配置即拒绝发起，防止误用占位值。
    """
    env_name = "WAFFO_PRODUCT_" + product_id.upper()
    value = os.environ.get(env_name, "").strip()
    if not value:
        raise ConfigError(f"未配置 {env_name}（站内商品 {product_id} 对应的 Waffo Product ID）")
    return value


# ---------------------------------------------------------------- Webhook 验签

def _parse_signature_header(header: str) -> tuple[str, str]:
    """解析 ``t=<ms>,v1=<base64>``。缺项或格式错抛 ``SignatureError``。"""
    parts: dict[str, str] = {}
    for pair in header.split(","):
        if "=" in pair:
            k, v = pair.split("=", 1)
            parts[k.strip()] = v.strip()
    t, v1 = parts.get("t"), parts.get("v1")
    if not t or not v1:
        raise SignatureError("X-Waffo-Signature 缺少 t 或 v1")
    return t, v1


def verify_webhook(raw_body: str | bytes, signature_header: str, public_key_pem: str,
                   *, now_ms: float | None = None,
                   tolerance_ms: int = _SIGNATURE_TOLERANCE_MS) -> dict:
    """校验验签并返回解析后的事件 dict；任何失败抛 ``SignatureError``。

    ``raw_body`` 必须是**未经 JSON 解析的原始请求体**（``request.body()``），
    先解析再重新序列化会改变空白字符，导致验签失败（文档「常见陷阱」第一条）。
    ``now_ms`` 显式注入便于离线单测时间戳容差，缺省用当前毫秒时间。
    """
    if not signature_header:
        raise SignatureError("缺少 X-Waffo-Signature 头")
    t, v1 = _parse_signature_header(signature_header)
    try:
        t_ms = int(t)
    except ValueError as exc:
        raise SignatureError(f"签名时间戳非整数：{t!r}") from exc

    now = int(time.time() * 1000 if now_ms is None else now_ms)
    if abs(now - t_ms) > tolerance_ms:
        raise SignatureError("签名时间戳超出 45 分钟容差")

    # 必须用原始字节拼签名输入：f"{t}.{raw_body}"
    body_bytes = raw_body.encode("utf-8") if isinstance(raw_body, str) else raw_body
    signature_input = t.encode("ascii") + b"." + body_bytes
    try:
        public_key = serialization.load_pem_public_key(public_key_pem.encode("utf-8"))
        public_key.verify(
            base64.b64decode(v1), signature_input, padding.PKCS1v15(), hashes.SHA256()
        )
    except (InvalidSignature, ValueError, TypeError) as exc:
        raise SignatureError("RSA-SHA256 验签失败（签名或公钥不匹配）") from exc

    try:
        event = json.loads(body_bytes.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise SignatureError("验签通过但 body 不是合法 JSON") from exc
    if not isinstance(event, dict):
        raise SignatureError("事件 body 不是 JSON 对象")
    return event


def select_and_verify(raw_body: str | bytes, signature_header: str, config: WaffoConfig,
                      *, now_ms: float | None = None) -> dict:
    """先按 payload 里的 ``mode`` 选公钥，再验签。

    注意：``mode`` 来自**未验签**的 body，只能用来选公钥，不能作为可信事实；
    选错公钥会验签失败（测试公钥验不了生产事件），因此不构成绕过。
    """
    try:
        probe = json.loads(raw_body.decode("utf-8") if isinstance(raw_body, bytes) else raw_body)
        mode = probe.get("mode", "") if isinstance(probe, dict) else ""
    except (ValueError, UnicodeDecodeError):
        mode = ""
    # mode 缺失/非法的 body 一律当作验签失败（401），不要误报成「配置缺失」(503)。
    # 严格按 mode 选公钥：测试公钥验不了生产事件，反之亦然（官方文档警告）。
    if mode not in ("test", "prod"):
        raise SignatureError(f"事件缺少或非法的 mode：{mode!r}")
    key = config.public_key_for_mode(mode)
    return verify_webhook(raw_body, signature_header, key, now_ms=now_ms)


def check_event_scope(event: dict, *, expected_mode: str | None = None,
                      expected_store_id: str | None = None) -> None:
    """验签通过后做店铺/环境校验（设计文档 §5.3「错误店铺、错误环境一律拒绝」）。

    ``expected_*`` 为 None 表示不启用该校验（便于本地/测试）。生产应配置
    ``WAFFO_EXPECTED_MODE`` 与 ``WAFFO_STORE_ID``，确保测试事件不触发生产逻辑、
    别的店铺的事件不被本店接收。任何不符抛 ``SignatureError``。
    """
    if expected_mode is not None and event.get("mode") != expected_mode:
        raise SignatureError(
            f"事件环境不符：mode={event.get('mode')!r}，期望 {expected_mode!r}"
        )
    if expected_store_id is not None and event.get("storeId") != expected_store_id:
        raise SignatureError(
            f"事件店铺不符：storeId={event.get('storeId')!r}，期望 {expected_store_id!r}"
        )


# ---------------------------------------------------------------- API Key 请求签名（出站）

def build_signed_headers(config: WaffoConfig, method: str, path: str, body_str: str,
                         *, timestamp: str | None = None) -> dict[str, str]:
    """构造 API Key 认证头（纯函数，可离线单测）。

    canonical = METHOD + "\\n" + PATH + "\\n" + TIMESTAMP + "\\n" + SHA256_BASE64(BODY)
    X-Signature = Base64(RSA-SHA256(canonical, privateKey, PKCS1v15))
    """
    ts = timestamp if timestamp is not None else str(int(time.time()))
    body_hash = base64.b64encode(hashlib.sha256(body_str.encode("utf-8")).digest()).decode("ascii")
    canonical = f"{method}\n{path}\n{ts}\n{body_hash}"
    try:
        private_key = serialization.load_pem_private_key(
            config.private_key_pem.encode("utf-8"), password=None
        )
        signature = private_key.sign(
            canonical.encode("utf-8"), padding.PKCS1v15(), hashes.SHA256()
        )
    except (ValueError, TypeError) as exc:
        raise ConfigError("WAFFO_PRIVATE_KEY 不是合法的 RSA PEM 私钥") from exc
    return {
        "Content-Type": "application/json",
        "X-Merchant-Id": config.merchant_id,
        "X-Timestamp": ts,
        "X-Signature": base64.b64encode(signature).decode("ascii"),
    }


def build_checkout_body(*, waffo_product_id: str, currency: str, order_id: str,
                        metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    """建会话请求体。**不含价格**：用 Waffo 后台商品定价（官方 Path B）。

    ``orderMerchantExternalId`` 与 ``metadata.orderId`` 都会透传到 webhook，
    用来把 Waffo 订单关联回站内内部订单（冗余两处，便于对账）。
    前端无法影响这些值——请求由服务端用 API Key 发起，不是 Store Slug。
    """
    return {
        "productId": waffo_product_id,
        "currency": currency,
        "orderMerchantExternalId": order_id,
        "metadata": {"orderId": order_id, **(metadata or {})},
    }


def create_checkout_session(config: WaffoConfig, *, waffo_product_id: str, currency: str,
                            order_id: str, metadata: dict[str, Any] | None = None,
                            poster: Callable[..., Any] | None = None,
                            timestamp: str | None = None) -> dict[str, Any]:
    """创建收银台会话，返回 ``{sessionId, checkoutUrl, expiresAt}``。

    ``poster`` 显式注入便于离线单测（不打网络）；缺省用 ``requests.post``。
    响应/错误按官方 ``{data: ...}`` / ``{errors: [...]}`` 结构解析。
    """
    import requests  # 延迟导入：纯函数单测不需要它

    body = build_checkout_body(
        waffo_product_id=waffo_product_id, currency=currency,
        order_id=order_id, metadata=metadata,
    )
    body_str = json.dumps(body, separators=(",", ":"))
    headers = build_signed_headers(config, "POST", _CHECKOUT_PATH, body_str, timestamp=timestamp)
    url = config.api_base + _CHECKOUT_PATH

    do_post = poster or (lambda u, **kw: requests.post(u, **kw))
    resp = do_post(url, headers=headers, data=body_str, timeout=15)
    status = getattr(resp, "status_code", None)
    payload = resp.json() if hasattr(resp, "json") else {}
    if status is None or not (200 <= int(status) < 300):
        errs = payload.get("errors") if isinstance(payload, dict) else None
        msg = (errs[0].get("message") if errs else None) or f"HTTP {status}"
        raise WaffoError(f"Waffo 建会话失败：{msg}")
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict) or not data.get("checkoutUrl"):
        raise WaffoError("Waffo 建会话响应缺少 data.checkoutUrl")
    return {
        "sessionId": data.get("sessionId"),
        "checkoutUrl": data["checkoutUrl"],
        "expiresAt": data.get("expiresAt"),
    }


# ---------------------------------------------------------------- 事件解析

# 官方事件类型（webhooks.md「Event Types」）。支付类会触发发放额度。
PAYMENT_EVENTS = frozenset({"order.completed", "subscription.payment_succeeded"})
REFUND_EVENTS = frozenset({"refund.succeeded", "refund.failed"})


@dataclass(frozen=True)
class AmountView:
    """按事件主体命名的金额视图。金额是 Waffo 的 **display 格式字符串**（如 "98.00"），
    不做单位换算、不与 ``amount`` 比对（``amount`` 已被官方标记 Deprecated）。"""

    charged: str | None          # 支付：data.chargedAmount（实扣）
    list_total: str | None       # 支付：data.listPrice.total（标价）
    refunded: str | None         # 退款：data.refundedAmount
    original_total: str | None   # 退款：data.originalPayment.total
    plan_total: str | None       # 订阅状态事件：data.planPrice.total


def event_data(event: dict) -> dict:
    """取事件 ``data``（官方文档的嵌套结构，不是平铺）。"""
    data = event.get("data")
    return data if isinstance(data, dict) else {}


def parse_amount(event: dict) -> AmountView:
    """按 ``eventType`` 主体命名字段解析金额，**绝不复用 ``amount`` 走三种语义**。

    官方「Deprecated amount fields」：``amount`` 在支付/退款/订阅三类事件里指三种
    不同的东西，统一改用 ``chargedAmount`` / ``refundedAmount`` / ``planPrice.total``；
    ``total`` 在支付事件对应 ``listPrice.total``、退款对应 ``originalPayment.total``。
    设计文档 §5.4 与公众号文章所述一致，官方文档进一步确认了层级（都在 ``data`` 下）
    与类型（字符串）。

    返回全 None 的视图表示「该事件不携带金额」（如订阅状态变更、store 事件），不抛错；
    只有未知主体才抛 ``UnknownEventType``。
    """
    etype = str(event.get("eventType", ""))
    d = event_data(event)
    lp = d.get("listPrice") or {}
    op = d.get("originalPayment") or {}
    pp = d.get("planPrice") or {}

    if etype in PAYMENT_EVENTS:
        return AmountView(charged=d.get("chargedAmount"), list_total=lp.get("total"),
                          refunded=None, original_total=None, plan_total=None)
    if etype in REFUND_EVENTS:
        return AmountView(charged=None, list_total=None,
                          refunded=d.get("refundedAmount"), original_total=op.get("total"),
                          plan_total=None)
    if etype.startswith("subscription."):
        return AmountView(charged=None, list_total=None, refunded=None,
                          original_total=None, plan_total=pp.get("total"))
    if etype.startswith("store.") or etype == "":
        return AmountView(None, None, None, None, None)
    raise UnknownEventType(f"未知事件类型：{etype!r}")
