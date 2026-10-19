/**
 * 交易日志的固定清单(台账字段定义和计算共用,所以单独放、不依赖别的模块)。移植自 VA v2.0.0。
 */

/** 打法:VA 的六种,台账只收这几个值 */
export const PLAYBOOKS = ["打板", "低吸", "接力", "半路", "套利", "其它"] as const;
export type Playbook = (typeof PLAYBOOKS)[number];

/**
 * 风险规矩的初值(VA `risk.DEFAULT_RULES`)。全部是**用户自己的规矩**,不是推荐值 ——
 * 资金量、打法不同,合理阈值差得远,这里只给一套能跑起来的初值,页面标「默认」。
 */
export const DEFAULT_RULES = {
  max_loss_per_trade_pct: 5, // 单笔最大亏损(%)
  max_loss_per_day_pct: 8, // 单日最大亏损(占用户填写的账户规模)
  max_positions: 3, // 最多同时持仓
  max_trades_per_day: 5, // 单日最多开仓
  pause_after_losses: 3, // 连亏几笔后停手
  max_unplanned_ratio: 0.2, // 计划外交易占比上限
};
export type RuleKey = keyof typeof DEFAULT_RULES;
export type Rules = Record<RuleKey, number>;
export const RULE_KEYS = Object.keys(DEFAULT_RULES) as RuleKey[];
export const RULE_LABELS: Record<RuleKey, string> = {
  max_loss_per_trade_pct: "单笔最大亏损",
  max_loss_per_day_pct: "单日最大亏损",
  max_positions: "最多同时持仓",
  max_trades_per_day: "单日最多开仓",
  pause_after_losses: "连亏几笔后停手",
  max_unplanned_ratio: "计划外交易占比上限",
};
/** 百分比 / 占比类可以带小数,其余是笔数、只数,要整数 */
export const isFractionRule = (k: RuleKey) => k.endsWith("_pct") || k.endsWith("_ratio");

/** 一条规矩的值哪里不对;没问题返回 null(VA `save_rules` 同一套判断) */
export function ruleProblem(k: RuleKey, v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return `${RULE_LABELS[k]} 要是数字`;
  if (v < 0 || (v === 0 && k !== "max_unplanned_ratio")) return `${RULE_LABELS[k]} 要是正数`;
  if (k.endsWith("_ratio") && v > 1) return "计划外交易占比要在 0 到 1 之间";
  if (!isFractionRule(k) && !Number.isInteger(v)) return `${RULE_LABELS[k]} 要是整数`;
  return null;
}
