"""Waffo 适配层 —— **协议未定，只放不依赖官方文档的部分**。

设计文档 §5.4（金额字段语义）来自那篇公众号文章，字段名是明确的，可以先落地；
但签名算法、请求头、Webhook 事件外层结构、收银台会话创建端点，文章明确说
「字段细节以官方集成文档为准」，仓库里也没有 SDK。**在用户提供官方文档前，
这里绝不写假的验签或假的 HTTP 调用**——那是 §5.3 最该避免的东西。

本模块当前只有两样：
1. ``parse_amount``：按事件主体解析金额（纯函数，可离线单测）。
2. ``WebhookVerifier`` / ``CheckoutClient``：``typing.Protocol`` 契约形状，
   仅声明 §12-2 要实现的接口，等官方文档到位后填具体实现。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class AmountView:
    """一次事件的金额视图（单位与 Waffo 原始字段一致，不做币种换算）。"""

    event_type: str          # payment / refund / subscription
    charged: int | None      # 实际扣款（支付事件）
    list_total: int | None   # 标价（支付事件，listPrice.total）
    refunded: int | None     # 退款金额（退款事件）
    original: int | None     # 原支付金额（退款事件，originalPayment）
    plan_price: int | None   # 订阅计划价（订阅事件）


class UnknownEventType(ValueError):
    pass


def parse_amount(event: dict) -> AmountView:
    """按事件主体命名字段解析金额，**绝不复用一个 ``amount`` 走三种语义**。

    设计文档 §5.4 / 文章原话：
    - Waffo 自 2026-09-21 起 ``amount`` 变为「通道实际扣款」（与 chargedAmount 一致），
      不再是下单标价；**禁止**再断言 ``amount == total``。
    - 支付事件：``chargedAmount``（实扣）配 ``listPrice.total``（标价）；
      两者仅在按比例退款或零元卡验证时不同，其他情况一样。
    - 退款事件：``refundedAmount`` / ``originalPayment``。
    - 订阅事件：``planPrice``。

    ``event[\"type\"]`` 取值按文章所述三种主体；未知类型直接抛错，不猜。
    """
    etype = str(event.get("type", ""))
    list_price = event.get("listPrice") or {}
    if etype == "payment":
        return AmountView(
            event_type=etype,
            charged=event.get("chargedAmount"),
            list_total=list_price.get("total"),
            refunded=None, original=None, plan_price=None,
        )
    if etype == "refund":
        return AmountView(
            event_type=etype,
            charged=None, list_total=None,
            refunded=event.get("refundedAmount"),
            original=event.get("originalPayment"),
            plan_price=None,
        )
    if etype == "subscription":
        return AmountView(
            event_type=etype,
            charged=None, list_total=None, refunded=None, original=None,
            plan_price=event.get("planPrice"),
        )
    raise UnknownEventType(f"未知事件类型：{etype!r}")


# ---------------------------------------------------------------- 待接入契约（§12-2）

class WebhookVerifier(Protocol):
    """保留请求原始字节，校验签名 / 时间 / 店铺 / 环境后，返回解析好的事件 dict。

    测试与生产公钥分开放；签名错、过期、错误店铺、错误环境的事件一律拒绝（§5.3）。
    **实现 pending：等 Waffo 官方文档给出签名算法与请求头。**
    """

    def verify(self, raw_body: bytes, headers: dict[str, str]) -> dict[str, Any]: ...


class CheckoutClient(Protocol):
    """用服务端内部订单号 + 商品映射创建 Waffo 支付会话，返回会话 id / 收银台 URL。

    价格 / 币种 / 积分数一律由服务端 ``products.py`` 定，不信任前端（§5.1）。
    **实现 pending：等 Waffo 官方文档给出会话创建端点与字段。**
    """

    def create_session(self, *, order_id: str, product_id: str,
                       price_cents: int, currency: str) -> dict[str, Any]: ...
