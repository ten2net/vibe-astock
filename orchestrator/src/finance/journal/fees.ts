/**
 * 交易费用:成交没填费用时按费率估(移植自 VA duanxian/journal.py)。
 *
 * ⚠️ 默认费率是**能跑起来的初值,不是推荐值,也不是用户的真实费率**:各家券商佣金差得远,印花税、过户费也会随政策调整。
 *    短线换手高,费用不是小数 —— 一堆薄利交易计费后可能接近持平甚至转亏,所以宁可估出来标「估」,也不默默按 0 算。
 * ⚠️ 「我的股票」那边没填的费用按 0 算(它不估),两页同一笔的金额可能差几块钱,页面要写明。
 */

export interface FeeConfig {
  commission_rate: number;
  commission_min: number;
  stamp_tax_rate: number;
  transfer_fee_rate: number;
}
export type FeeKey = keyof FeeConfig;

export const DEFAULT_FEES: FeeConfig = {
  commission_rate: 0.00025, // 佣金(双向),万 2.5
  commission_min: 5, // 单笔佣金最低(元)
  stamp_tax_rate: 0.0005, // 印花税,只在卖出收
  transfer_fee_rate: 0.00001, // 过户费(双向)
};
export const FEE_KEYS = Object.keys(DEFAULT_FEES) as FeeKey[];
export const FEE_LABELS: Record<FeeKey, string> = {
  commission_rate: "佣金费率(双向)",
  commission_min: "单笔佣金最低(元)",
  stamp_tax_rate: "印花税(仅卖出)",
  transfer_fee_rate: "过户费(双向)",
};
/** 费率上限:万 2.5 应填 0.00025,填成 2.5 这种一看就不是费率 */
export const MAX_RATE = 0.01;

/** 一笔成交按费率估的费用(元)。填了实际费用的不走这里 */
export function estimateFee(side: "buy" | "sell", price: number, shares: number, cfg: FeeConfig): number {
  const amt = price * shares;
  let fee = Math.max(amt * cfg.commission_rate, cfg.commission_min);
  fee += amt * cfg.transfer_fee_rate;
  if (side === "sell") fee += amt * cfg.stamp_tax_rate;
  return fee;
}

/** 一组费率哪里不对(保存和读取共用);没问题返回 null。缺项不用初值补 —— 补了用户就不知道哪一项是自己填的 */
export function feeProblem(raw: Partial<Record<FeeKey, unknown>>): string | null {
  for (const k of FEE_KEYS) {
    const v = raw[k];
    if (v === undefined || v === null) return `费率要四项都填(缺「${FEE_LABELS[k]}」),缺项不会自动用初值`;
    if (typeof v !== "number" || !Number.isFinite(v)) return `${FEE_LABELS[k]} 要是数字`;
    if (v < 0) return `${FEE_LABELS[k]} 不能是负数`;
    if (k.endsWith("_rate") && v > MAX_RATE) return `${FEE_LABELS[k]} 看起来不像费率(${v}),万 2.5 应填 0.00025`;
  }
  return null;
}
