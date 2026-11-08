"""服务端商品表 —— 价格 / 币种 / 积分数的**唯一真源**。

设计文档 §3.2、§5.1：前端只能传 ``product_id``，最终 price / currency / credits
一律由这里按商品配置确定，**绝不能相信浏览器提交的金额或积分**。
「无映射、规格不符，就拒绝发起」——``resolve`` 对未知 id 直接抛错。

骨架阶段商品是静态常量（不接后台、不接真钱）；后续接 Waffo 时，Waffo 后台的
商品与这里按 ``waffo_product_id`` 对齐，但**定价与积分映射仍以本表为准**。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

ProductKind = Literal["subscription", "credit_pack"]


@dataclass(frozen=True)
class Product:
    product_id: str
    kind: ProductKind
    # 标价用最小货币单位（分），避免浮点误差；对外展示时再格式化。
    price_cents: int
    currency: str          # ISO 4217，如 USD / CNY
    credits: int           # 该商品发放的托管 AI 额度（积分）
    period: str | None     # subscription: month / year；credit_pack: None
    waffo_product_id: str  # Waffo 后台对应商品；骨架阶段仅占位，不用于发起支付
    label: str


# 商品目录：一次性积分包 + 订阅混在一个店铺里（设计文档 §3.2）。
# 最低客单价需覆盖 Waffo 手续费 3.9% + $0.50 里的固定 $0.50，故不设过小额包。
CATALOG: dict[str, Product] = {
    p.product_id: p
    for p in (
        Product("pro_month", "subscription", 2900, "USD", 3000, "month", "waffo_pro_month", "Pro 月付"),
        Product("pro_year", "subscription", 29900, "USD", 36000, "year", "waffo_pro_year", "Pro 年付"),
        Product("credits_small", "credit_pack", 990, "USD", 1000, None, "waffo_credits_small", "积分包 · 1000"),
        Product("credits_large", "credit_pack", 4900, "USD", 6000, None, "waffo_credits_large", "积分包 · 6000"),
    )
}


class UnknownProduct(ValueError):
    """前端传来的 product_id 不在服务端商品表 —— 拒绝建单。"""


def resolve(product_id: str) -> Product:
    """把前端给的 ``product_id`` 解析成服务端商品配置；未知 id 抛 ``UnknownProduct``。

    注意：只接受 id，不接受任何来自前端的 price / currency / credits 参数，
    从签名上就杜绝「浏览器提交金额」这条路。
    """
    try:
        return CATALOG[product_id]
    except KeyError as exc:
        raise UnknownProduct(f"未知商品 id：{product_id!r}") from exc


def as_public(p: Product) -> dict:
    """给前端的商品描述。刻意**不含** credits 的写权限语义，只作展示。"""
    return {
        "product_id": p.product_id,
        "kind": p.kind,
        "price_cents": p.price_cents,
        "currency": p.currency,
        "credits": p.credits,
        "period": p.period,
        "label": p.label,
    }


def list_public() -> list[dict]:
    return [as_public(p) for p in CATALOG.values()]
