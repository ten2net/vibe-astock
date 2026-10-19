/**
 * 明日验证能选的市场读数(移植自 Vibe AStock v2.0.0 duanxian/verification.py 的 METRICS,阈值不变)。
 * 单独成文件:台账种类(ledger_kinds.ts)要拿键名做枚举,不该为此导入取数和视图代码。
 *
 * `eps` 是「变了才算变」的阈值:没有它,涨停家数 40→41 就成了「上升」,噪声被当成判断兑现。
 * `higher_is_hotter` 只给界面提示语义(炸板率升 = 情绪转弱),不影响对账。
 */
export type VerifyKind = "count" | "rate" | "pct";

export interface VerifyMetric {
  key: string;
  label: string;
  hint: string;
  eps: number;
  higher_is_hotter: boolean;
  unit: string;
  kind: VerifyKind;
  /** 读数来自 `cn_shortline_daily` 的哪一项(情绪历史 READINGS 的 key);没有 = 来自事实表 */
  reading?: string;
  /** 读数来自 `cn_shortline_facts` 的哪个证据字段 */
  facts_field?: string;
}

export const VERIFY_METRICS: VerifyMetric[] = [
  { key: "limit_up_count", label: "涨停家数", hint: "市场整体的赚钱意愿", eps: 5, higher_is_hotter: true, unit: "家", kind: "count", reading: "limit_up" },
  { key: "highest_board", label: "最高连板高度", hint: "情绪的天花板，压缩=周期见顶", eps: 0.5, higher_is_hotter: true, unit: "板", kind: "count", reading: "highest_board" },
  { key: "promotion_1to2", label: "1进2 晋级率", hint: "最敏感的一档，走低=接力意愿收缩", eps: 0.05, higher_is_hotter: true, unit: "", kind: "rate", reading: "promotion_1to2" },
  { key: "money_effect_median", label: "赚钱效应中位数", hint: "多数人的体感", eps: 0.5, higher_is_hotter: true, unit: "%", kind: "pct", reading: "money_effect" },
  { key: "broken_rate", label: "炸板率", hint: "资金分歧程度（炸板未回封占尝试数）", eps: 0.05, higher_is_hotter: false, unit: "", kind: "rate", reading: "broken_rate" },
  { key: "deep_loss_count", label: "跌超5%家数", hint: "大面的量级，判退潮先看它", eps: 5, higher_is_hotter: false, unit: "家", kind: "count", reading: "deep_loss" },
  { key: "theme_concentration", label: "头部题材集中度", hint: "一枝独秀还是遍地开花", eps: 0.05, higher_is_hotter: true, unit: "", kind: "rate", facts_field: "theme_concentration" },
  { key: "market_limit_down", label: "全市场跌停家数", hint: "极端风险的直接读数", eps: 5, higher_is_hotter: false, unit: "家", kind: "count", facts_field: "limit_down_count" },
];

export const VERIFY_METRIC_KEYS = VERIFY_METRICS.map((m) => m.key);

export type Direction = "up" | "down" | "flat";
export const DIRECTIONS: Direction[] = ["up", "down", "flat"];
export const DIRECTION_LABELS: Record<Direction, string> = { up: "上升", down: "下降", flat: "持平" };
