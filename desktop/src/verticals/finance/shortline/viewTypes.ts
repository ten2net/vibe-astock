/**
 * 短线五个视图返回的界面数据(后端见 orchestrator/src/finance/shortline/:history / verification / samples / structure / weekly)。
 * 字段照后端抄;界面只读,取不到的一律是 null,不是 0。
 */

export type ReadingKind = "count" | "rate" | "pct";

// ---------------------------------------------------------------- 情绪历史
export interface Reading { key: string; label: string; unit: string; kind: ReadingKind; higher_is_hotter: boolean; diff_eps: number }
export interface DayRow {
  date: string;
  values: Record<string, number | null>;
  status: "ok" | "partial" | "missing";
  settled: boolean | null;
  note: string;
  cached: boolean;
  fetched_at: string | null;
}
export interface ContextItem {
  key: string; label: string; unit: string; kind: ReadingKind; higher_is_hotter: boolean;
  value: number | null;
  percentile: number | null;
  extreme: "偏热" | "偏冷" | null;
  hist_min: number | null; hist_max: number | null; hist_median: number | null;
}
export type HistoryContext =
  | { available: false; reason: string }
  | { available: true; date: string; sample_days: number; min_samples: number; items: ContextItem[]; extreme_count: number };
export interface DiffChange { key: string; label: string; unit: string; kind: ReadingKind; prev: number; cur: number; delta: number; hotter: boolean }
export type HistoryDiff =
  | { available: false; reason: string }
  | { available: true; date: string; prev_date: string; changes: DiffChange[]; unchanged_count: number };
export interface HistoryResult {
  date: string;
  days: number;
  readings: Reading[];
  series: DayRow[];
  context: HistoryContext;
  diff: HistoryDiff;
  generated_at: string;
  gaps: string[];
  source: string;
}

// ---------------------------------------------------------------- 明日验证
export type Direction = "up" | "down" | "flat";
export interface VerifyMetric { key: string; label: string; hint: string; eps: number; higher_is_hotter: boolean; unit: string; kind: ReadingKind }
export interface Summary {
  total: number; decided: number; hit: number; rate: number | null; undecidable: number;
  baseline_covered: number; expected_rate: number | null; edge: number | null;
}
export interface ItemResult {
  id: string;
  metric: string; label: string; unit: string; kind: ReadingKind; higher_is_hotter: boolean; eps: number;
  direction: Direction; direction_label: string; reason: string;
  prev_value: number | null; cur_value: number | null;
  actual: Direction | null; actual_label: string | null;
  verified: boolean | null;
  late: boolean;
  baseline: number | null; baseline_samples: number | null; baseline_reason: string | null; baseline_note: string;
  edge: number | null;
  written_at: string;
}
export type Check =
  | { available: false; reason: string }
  | { available: true; set_date: string; date: string; provisional: boolean; results: ItemResult[]; summary: Summary };
export interface PlanItem {
  id: string; metric: string; label: string; unit: string; kind: ReadingKind; higher_is_hotter: boolean; eps: number;
  direction: Direction; direction_label: string; reason: string;
  base_value: number | null;
  baseline: number | null; baseline_samples: number | null; baseline_reason: string | null; baseline_note: string;
  written_at: string;
}
export interface TrackDay { set_date: string; date: string; total: number; decided: number; hit: number; excluded: number }
export interface VerifyResult {
  date: string;
  metrics: VerifyMetric[];
  directions: { key: Direction; label: string }[];
  check: Check;
  plan: { date: string; items: PlanItem[] };
  track: { from: string; to: string; summary: Summary; days: TrackDay[]; excluded_late: number; excluded_provisional: number };
  generated_at: string;
  gaps: string[];
  source: string;
}

// ---------------------------------------------------------------- 涨停样本统计
export const REGIMES = ["情绪强", "情绪中", "情绪弱", "环境未覆盖"] as const;
export type Regime = typeof REGIMES[number];
export interface Stats {
  sample: number;
  win_rate: number | null;
  avg: number | null;
  median: number | null;
  best: number | null;
  worst: number | null;
  limit_up_rate: number | null;
}
export interface SealBucket extends Stats { bucket: string }
export interface StrategyDay { date: string; sample: number; avg: number | null; regime: Regime; equity: number }
export interface StrategyResult { name: string; desc: string; overall: Stats; by_regime: Record<Regime, Stats>; daily: StrategyDay[]; final_equity: number }
export interface SamplesResult {
  date: string;
  days: number;
  layer: "market_phenomenon";
  sample_caveat: string;
  available: boolean;
  reason: string | null;
  days_used: number;
  date_from: string | null;
  date_to: string | null;
  missing_days: string[];
  unsettled_days: string[];
  regime_cuts: { low: number | null; high: number | null };
  seal_curve: SealBucket[];
  strategies: StrategyResult[];
  generated_at: string;
  gaps: string[];
  source: string;
}

// ---------------------------------------------------------------- 结构变化
export interface MetricShift {
  metric: string; label: string; kind: "count" | "share";
  recent: number; prior: number; delta: number; rel_change: number | null; shifted: boolean;
  recent_days: number; prior_days: number;
}
export interface FieldVersion { since: string; until: string; fields: string; count: number | null }
export interface PoolDrift {
  pool: string; label: string; days: number; versions: FieldVersion[]; changed: boolean;
  added: string[] | null; removed: string[] | null; detectable: boolean; note: string;
}
export interface RegimeEvent { id: string; date: string; title: string; note: string; upcoming: boolean }
export interface WindowInfo { days: number; used: number; from: string | null; to: string | null }
export interface StructureResult {
  date: string;
  available: boolean;
  recent_window: WindowInfo;
  prior_window: WindowInfo;
  structure: { available: boolean; reason: string | null; metrics: MetricShift[]; shifted: MetricShift[]; skipped: string[] };
  thresholds: { share_abs: number; count_rel: number; min_days: number };
  field_drift: PoolDrift[];
  field_changed: string[];
  regime_events: RegimeEvent[];
  regime_note: string;
  missing_days: string[];
  unsettled_days: string[];
  summary: string;
  note: string;
  generated_at: string;
  gaps: string[];
  source: string;
}

// ---------------------------------------------------------------- 近 5 天
export interface Leader { code: string; name: string; boards: number | null; sector: string; first_seal: string }
export interface WeeklyDay {
  date: string; limit_up: number | null; highest_board: number | null; broken_rate: number | null;
  leaders: Leader[]; leader_total: number | null; settled: boolean | null; note: string;
}
export interface LineageItem {
  code: string; name: string; sector: string; appear_date: string; boards_then: number | null;
  cum_return_since: number | null; series: { date: string; cum_ret: number }[]; series_warning: string;
  peak_cum_ret: number | null; drawdown_from_peak: number | null; is_current_top: boolean;
}
export interface WeeklyResult { date: string; days: WeeklyDay[]; lineage: LineageItem[]; generated_at: string; gaps: string[]; source: string }

// ── AI 复盘(orchestrator/src/finance/shortline/review.ts) ──
export type ReviewSectionId = "sentiment" | "capital" | "theme" | "dragon_tiger" | "leader" | "summary";
/** AI 周报的分段(orchestrator/src/finance/shortline/weekly_review.ts);和日复盘共用一套段落显示 */
export type WeeklySectionId = "trend" | "themes" | "verify" | "summary";
export type ReviewStageStatus = "pending" | "running" | "done" | "failed" | "skipped" | "cancelled";
export interface ReviewAudit { total: number; bound: number; derived: number; loose: number; bad_math: { raw: string; stated: number; recomputed: number; percent: boolean }[] }
export interface ReviewStage {
  id: ReviewSectionId | WeeklySectionId; label: string; desc: string; status: ReviewStageStatus;
  text: string; error?: string; evidence_count: number;
  audit?: ReviewAudit; cited?: { id: string; line: string }[]; unknown_cites?: string[];
}
export interface ReviewCondition { metric: string; direction: Direction; reason: string }
export interface ReviewRun {
  id: string; date: string; settled: boolean | null; ai: string; started_at: string; finished_at: string | null;
  stages: ReviewStage[]; gaps: string[]; conditions: ReviewCondition[]; conditions_note: string;
  done: boolean; outcome: "running" | "completed" | "completed_with_errors" | "failed" | "cancelled";
  saved_id: string | null; save_error: string | null;
}
export interface SavedReview {
  id: string; date: string; settled: boolean | null; ai: string; started_at: string; finished_at: string; created_at: string;
  sections: ReviewStage[]; gaps: string[]; conditions: ReviewCondition[]; conditions_note: string;
  /** 从旧版导入的(原文照搬,数字和证据编号没按新版规则核对) */
  imported?: boolean;
}
export interface ReviewResult {
  date: string;
  sections: { id: ReviewSectionId; label: string; desc: string }[];
  metrics: { key: string; label: string; unit: string; kind: ReadingKind; eps: number }[];
  directions: { key: Direction; label: string }[];
  versions: SavedReview[];
  dates: { date: string; count: number }[];
  runs: ReviewRun[];
}
export interface SavedWeekly extends Omit<SavedReview, "conditions" | "conditions_note"> { week_start: string; days: string[] }
export interface WeeklyReviewResult {
  date: string;
  /** 这一天所在那周的周一 */
  week_start: string;
  sections: { id: WeeklySectionId; label: string; desc: string }[];
  /** 这一周存下的各版,新的在前 */
  versions: SavedWeekly[];
  weeks: { week_start: string; count: number }[];
  runs: ReviewRun[];
}
