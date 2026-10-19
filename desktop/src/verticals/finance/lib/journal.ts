/**
 * 交易日志页的界面数据与纯函数(后端见 orchestrator/src/finance/journal/)。移植自 Vibe AStock v2.0.0 的交易日志页。
 *
 * 🔴 个人交易数据只给界面看:这一页不登记 AI 页面上下文,不进任何 AI 提问(VA 合规口径)。
 * 🔴 隐私模式:金额、股数、自己的成交价 / 成本 / 止损 / 目标遮成 ••••;百分比、笔数、天数不遮。
 *    后端拼好的句子里也带金额(「占用 12,000 元」),显示前用 maskJournalText 遮掉。
 */
import type { ChartPalette } from "./backtestView.ts";
import { MASK } from "./privacy.ts";

/* ---------------- 后端返回的形状 ---------------- */

export interface Bucket {
  count: number; scored: number; money_scored: number;
  net_pnl: number | null; win_rate: number | null; avg: number | null; best: number | null; worst: number | null;
}
export interface Group extends Bucket { key: string }

export interface EpisodeFill { trade_id: string; type: "opening" | "buy" | "sell"; date: string; price: number; shares: number; fee: number; fee_estimated: boolean }
export interface Episode {
  id: string; symbol: string; name: string; trade_ids: string[]; fills: EpisodeFill[];
  from_opening: boolean; has_split: boolean; dividends: number;
  first_buy: string; last_sell: string | null; closed: boolean;
  open_shares: number; avg_cost: number; amount: number;
  gross_pnl: number | null; fees: number | null; fees_are_estimated: boolean | null;
  realized_pnl: number | null; realized_pct: number | null; hold_days: number | null;
  settlement_warning: string | null;
}
export interface JournalRow {
  key: string; kind: "episode" | "manual"; symbol: string; name: string; date: string; created_at: string;
  episode: Episode | null; tag_id: string | null;
  playbook: string | null; as_planned: boolean | null;
  planned_stop: number | null; planned_target: number | null; plan_late: boolean;
  note: string; pnl_pct: number | null; realized_pnl: number | null; hold_days: number | null;
}
export interface Problem { id: string; symbol: string; why: string }
export interface TradeProblem { id: string; symbol: string; date: string; type: string; why: string }

export type FeeKey = "commission_rate" | "commission_min" | "stamp_tax_rate" | "transfer_fee_rate";
export type RuleKey = "max_loss_per_trade_pct" | "max_loss_per_day_pct" | "max_positions" | "max_trades_per_day" | "pause_after_losses" | "max_unplanned_ratio";
export interface JournalSettings {
  fees: Record<FeeKey, number> | null; fees_default: boolean;
  rules: Record<RuleKey, number>; rules_default: boolean;
  equity_base: number | null; problem: string | null;
  raw: Record<string, unknown> | null; record_id: string | null; extra_records: number;
  labels: { fees: Record<FeeKey, string>; rules: Record<RuleKey, string> };
  defaults: { fees: Record<FeeKey, number>; rules: Record<RuleKey, number> };
}

type Off = { available: false; reason: string };

export type Equity = Off | {
  available: true; points: { date: string; cum_pnl: number; pnl: number; drawdown: number }[]; date_note: string;
  trades: number; net_pnl: number; peak: number; peak_date: string | null; current_drawdown: number; max_drawdown: number;
  max_drawdown_since: string | null; trades_since_peak: number; longest_underwater: number;
  win_rate: number | null; avg_win: number | null; avg_loss: number | null; payoff_ratio: number | null; profit_factor: number | null;
  worst_losing_streak: number; worst_trade: number; net_without_best1: number; net_without_best3: number; best_trade_share: number | null;
};
export interface WindowStats {
  trades: number; net_pnl?: number; win_rate?: number | null; payoff_ratio?: number | null; profit_factor?: number | null;
  execution_rate?: number | null; date_from?: string; date_to?: string; window?: number; enough?: boolean;
}
export type Rolling = Off | { available: true; windows: Record<string, WindowStats>; lifetime: WindowStats; win_rate_drift?: number; profit_factor_drift?: number; note: string };
export interface DisciplineBucket { count: number; win_rate: number | null; avg_pct: number | null; net_pnl: number | null }
export type Discipline = Off | {
  available: true; planned: DisciplineBucket; unplanned: DisciplineBucket; untagged: DisciplineBucket; execution_rate: number | null;
  what_if_only_planned: { actual_net: number | null; planned_only_net: number | null; cost_of_indiscipline: number | null }; note: string;
};
export interface Violation { date: string; rule: RuleKey; label: string; limit: number; actual: number; detail: string }
export type Violations = Off | {
  available: true; rules: Record<RuleKey, number>; is_default_rules: boolean; rule_status: Record<string, string>; unchecked: string[];
  violations: Violation[]; violation_count: number;
  after_loss_streak: { threshold: number; trades: number; avg_pct: number | null; win_rate: number | null };
};
export interface AtRiskPosition {
  key: string; symbol: string; name: string; date: string; playbook: string | null; shares: number; avg_cost: number; capital: number;
  planned_stop: number | null; planned_target: number | null; plan_late: boolean; at_risk: number | null; at_risk_pct: number | null; bounded: boolean;
}
export type AtRisk = Off | {
  available: true; positions: AtRiskPosition[]; position_count: number; total_capital: number; total_at_risk: number;
  bounded_count: number; unbounded_count: number; unbounded_capital: number; equity_base: number | null;
  rules: { max_loss_per_trade_pct: number; max_positions: number; is_default: boolean };
  at_risk_of_equity_pct: number | null; capital_of_equity_pct: number | null;
  over_per_trade_limit: { name: string; code: string; pct_of_equity: number }[] | null;
  equity_base_hint: string | null; over_position_limit: { actual: number; limit: number } | null; unbounded_note: string | null;
};
export interface InboxItem { key: string; date: string; symbol: string; name: string; playbook: string | null; pnl_pct: number | null; note: string; closed: boolean; flags: { key: string; text: string }[] }
export type Inbox = Off | {
  available: true; items: InboxItem[]; count: number; scanned: number; by_flag: Record<string, number>;
  baseline: { median_capital: number | null; median_hold_days: number | null; history_enough: boolean; min_history: number };
  rules_is_default: boolean; excursion_available: boolean; excursion_skipped: number; excursion_hint: string | null; note: string;
};
export interface ModeVersionPerf {
  version: number; since: string; changes: string; playbook: string;
  setup: string; entry: string; exit: string; sizing: string; phase: string; saved_at: string;
  trades: number; win_rate: number | null; median_pct: number | null; avg_pct: number | null; best: number | null; worst: number | null; enough: boolean;
}
export interface ModeCardPerf {
  id: string; name: string; playbook: string; version_count: number; by_version: ModeVersionPerf[]; matched_trades: number;
  before_card: { trades: number; win_rate: number | null; median_pct: number | null; enough: boolean } | null;
  latest_vs_prev: { win_rate_delta: number; median_delta: number; from_version: number; to_version: number } | null;
  compare_blocked: boolean;
}
export type Modes = Off | { available: true; cards: ModeCardPerf[]; min_per_version: number; truncated: boolean; note: string };

export interface JournalStats { overall: Bucket; by_playbook: Group[]; by_planned: Group[]; by_hold: Group[] }

interface ViewCommon { settings: JournalSettings; playbooks: string[]; today: string }
export type JournalView =
  | (ViewCommon & { available: false; reason: string })
  | (ViewCommon & {
    available: true; stats: JournalStats; rows: JournalRow[]; episodes: Episode[];
    issues: TradeProblem[]; orphans: Problem[]; conflicts: Problem[]; skipped_non_a: string[]; orphan_dividends: number;
    risk: { equity: Equity; rolling: Rolling; discipline: Discipline; violations: Violations };
    at_risk: AtRisk; inbox: Inbox; modes: Modes; invalid_cards: number;
  });

export interface ExcursionItem {
  key: string; symbol: string; name: string; date: string; exit_date: string;
  realized_pct: number; mfe_pct: number; mae_pct: number; mfe_certain: number | null; mae_certain: number | null; certain_note: string | null;
  bars: number; bars_inner: number; same_day: boolean; precision: string; give_back_pct: number; capture_rate: number | null; capture_note: string | null;
}
interface ExcursionBase {
  scanned: number; counts: { not_closed: number; split: number; bj: number; failed: number }; cached: number;
  failures: { key: string; symbol: string; name: string; date: string; why: string }[];
  intraday_note: string | null; not_counted_note: string | null;
}
export type ExcursionView = (Off & Partial<ExcursionBase>) | (ExcursionBase & {
  available: true; trades: number; enough_samples: boolean; median_capture_rate: number | null; capture_samples: number;
  median_give_back: number | null; median_mae: number | null; endured_count: number; bad_entry_count: number;
  same_day_count: number; lost_with_move_count: number; capture_note: string | null; items: ExcursionItem[]; bias_note: string; caveat: string;
});

export type Quadrant = "right_win" | "right_lose" | "wrong_win" | "wrong_lose";
export interface AttrDay { date: string; pnl: number; trades: number; unplanned: number; set_date: string; decided: number; hit: number; right: boolean }
interface AttrSkips { skipped_no_amount?: number; skipped_no_read?: number; skipped_undecided?: number }
export type AttributionView = (Off & AttrSkips & { window?: { from: string; to: string }; gaps?: string[] }) | (Required<AttrSkips> & {
  available: true; days_counted: number; enough_samples: boolean; min_days: number; quadrant_labels: Record<Quadrant, string>;
  quadrants: Record<Quadrant, { days: number; pnl: number; days_list: string[] }>; cells: Record<Quadrant, AttrDay[]>;
  note: string; window: { from: string; to: string }; gaps: string[];
});

export type BoardGroup = "首板" | "2板" | "3板及以上" | "炸板" | "没碰涨停" | "非涨停(没分出炸板)" | "没取到";
export interface EnvRow {
  key: string; date: string; regime: string | null; score: number | null; money_effect: number | null;
  board: BoardGroup | null; boards: number | null; first_seal: string | null;
  /** 炸板次数:涨停的是封住前炸开过几次,炸板的是当天炸了几次 */
  broken_times: number | null;
  industry: string | null;
}
export type EnvView = (Off & { gaps?: string[] }) | {
  available: true; rows: EnvRow[]; by_regime: Group[]; by_board: Group[];
  regime_cuts: { low: number | null; high: number | null }; scored_days: number; unsettled_trades: number; scanned: number;
  days: number; gaps: string[]; note: string; source: string;
};

/* ---------------- 格式 ---------------- */

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 金额(元):最多两位小数、千分位 */
export const money = (v: number | null | undefined) => (fin(v) ? v.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "—");
export const moneySigned = (v: number | null | undefined) => (fin(v) ? `${v > 0 ? "+" : ""}${money(v)}` : "—");
/** 股价:最多三位小数(基金、可转债有三位) */
export const priceText = (v: number | null | undefined) => (fin(v) ? v.toLocaleString("zh-CN", { maximumFractionDigits: 3 }) : "—");
export const sharesText = (v: number | null | undefined) => (fin(v) ? v.toLocaleString("zh-CN") : "—");
/** 已经是百分数的值 → 带符号文本 */
export const pctSigned = (v: number | null | undefined, digits = 2) => (fin(v) ? `${v > 0 ? "+" : ""}${v.toFixed(digits)}%` : "—");
/** 0~1 的比率 → 百分比 */
export const ratePct = (v: number | null | undefined) => (fin(v) ? `${Math.round(v * 100)}%` : "—");
/** 比率的差(0.12 → +12 个百分点) */
export const rateDelta = (v: number | null | undefined) => (fin(v) ? `${v > 0 ? "+" : ""}${Math.round(v * 100)} 个百分点` : "—");
/** 红涨绿跌;没有数灰色 */
export const tone = (v: number | null | undefined) => (!fin(v) ? "text-muted-foreground" : v > 0 ? "text-danger" : v < 0 ? "text-success" : "");

/** 后端句子里的金额:「N 元」和「中位仓位(N)」 */
export function maskJournalText(text: string, on: boolean): string {
  if (!on) return text;
  return text
    .replace(/[-+]?\d[\d,]*(?:\.\d+)?(?=\s*元)/g, MASK)
    .replace(/(中位仓位\()[-+]?\d[\d,]*(?:\.\d+)?(\))/g, `$1${MASK}$2`);
}

/** 规矩的值怎么写:百分比类带 %、占比类写成百分数,其余是笔数 / 只数 */
export function ruleValueText(k: RuleKey, v: number | null | undefined): string {
  if (!fin(v)) return "—";
  if (k === "max_unplanned_ratio") return `${Math.round(v * 100)}%`;
  if (k.endsWith("_pct")) return `${v}%`;
  return k === "max_positions" ? `${v} 只` : `${v} 笔`;
}

/** 规矩检查的那句话:隐私模式下单日亏损只说占比,不说元 */
export function violationText(v: Violation, hide: boolean): string {
  if (hide && v.rule === "max_loss_per_day_pct") return `${v.date} 当日净亏占账户 ${v.actual}%`;
  return maskJournalText(v.detail, hide);
}

/** 当时在涨停池里的位置;涨停的带首封、炸开过几次、行业,炸板的带炸了几次、行业(VA 同) */
export function boardText(e: EnvRow | undefined): string {
  if (!e || !e.board) return "—";
  const seal = e.first_seal ? ` · 首封 ${e.first_seal.slice(0, 5)}` : "";
  const ind = e.industry ? ` · ${e.industry}` : "";
  const broke = e.broken_times ? ` · 炸 ${e.broken_times} 次` : "";
  if (e.board === "首板") return `首板${seal}${broke}${ind}`;
  if (e.board === "2板" || e.board === "3板及以上") return `${e.boards ? `${e.boards}板` : e.board}${seal}${broke}${ind}`;
  if (e.board === "炸板") return `炸板${e.broken_times ? ` ${e.broken_times} 次` : ""}${ind}`;
  return e.board;
}

/** 这一行现在是什么状态 */
export function rowState(r: JournalRow): "closed" | "open" | "manual" {
  return r.kind === "manual" ? "manual" : r.episode?.closed ? "closed" : "open";
}

/* ---------------- 录入 ---------------- */

/** 输入框里的数:空 = 没填(null);写错 = undefined。盈亏允许末尾带 % */
export function parseNum(s: string): number | null | undefined {
  const t = s.trim().replace(/[%％]$/, "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export interface FillDraft { type: "buy" | "sell"; date: string; price: string; shares: string; fee: string }
export interface FillPayload { type: "buy" | "sell"; date: string; price: number; shares: number; fee?: number }

/**
 * 成交草稿 → 发给后端的成交。整行空着的跳过;填了一半的报出是第几笔、哪里不对。
 * 只做格式检查;能不能算(卖多了、日期顺序)交给后端重放,它会说清楚。
 */
export function fillsPayload(drafts: readonly FillDraft[]): { fills: FillPayload[] } | { error: string } {
  const out: FillPayload[] = [];
  for (const [i, d] of drafts.entries()) {
    if (!d.price.trim() && !d.shares.trim() && !d.fee.trim()) continue;
    const at = `第 ${i + 1} 笔成交`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return { error: `${at}:日期没填` };
    const price = parseNum(d.price), shares = parseNum(d.shares), fee = parseNum(d.fee);
    if (!fin(price) || price <= 0) return { error: `${at}:价格要是大于 0 的数` };
    if (!fin(shares) || shares <= 0 || !Number.isInteger(shares)) return { error: `${at}:股数要是正整数` };
    if (fee === undefined || (fin(fee) && fee < 0)) return { error: `${at}:费用要是不小于 0 的数(不填就按费率估)` };
    out.push({ type: d.type, date: d.date, price, shares, ...(fin(fee) ? { fee } : {}) });
  }
  return out.length ? { fills: out } : { error: "至少要填一笔成交(价格和股数)" };
}

/* ---------------- 图 ---------------- */

type Obj = Record<string, unknown>;

/**
 * 权益曲线:累计净盈亏 + 距高点回撤(元)。
 * 🔴 隐私模式下不画:只遮纵轴和提示不够,曲线的高低、斜率、面积就是每笔盈亏的相对大小(2026-10-11 审计)。
 */
export function equityChart(points: readonly { date: string; cum_pnl: number; drawdown: number }[], p: ChartPalette, hide: boolean): Obj | null {
  if (points.length < 2 || hide) return null;
  const fmt = (x: unknown) => (typeof x === "number" ? money(x) : "—");
  return {
    animation: false,
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    legend: { top: 0, right: 8, textStyle: { color: p.text, fontSize: 12 }, itemWidth: 14, itemHeight: 8 },
    tooltip: { trigger: "axis", backgroundColor: p.tooltipBg, borderColor: p.axis, textStyle: { color: p.tooltipText, fontSize: 12 }, valueFormatter: fmt },
    xAxis: { type: "category", data: points.map((x, i) => `${i + 1} · ${x.date}`), boundaryGap: false,
      axisLabel: { color: p.text, fontSize: 11, formatter: (s: string) => s.split(" · ")[1] ?? s },
      axisLine: { lineStyle: { color: p.axis } }, axisTick: { show: false } },
    yAxis: { type: "value", scale: true, axisLabel: { color: p.text, fontSize: 11, formatter: (x: number) => money(x) }, splitLine: { lineStyle: { color: p.grid } } },
    series: [
      { name: "累计净盈亏", type: "line", showSymbol: false, lineStyle: { width: 1.6, color: p.primary }, itemStyle: { color: p.primary }, data: points.map((x) => x.cum_pnl),
        markLine: { silent: true, symbol: "none", lineStyle: { color: p.axis, type: "dashed" }, label: { show: false }, data: [{ yAxis: 0 }] } },
      { name: "距高点回撤", type: "line", showSymbol: false, lineStyle: { width: 1, color: p.fall }, itemStyle: { color: p.fall }, areaStyle: { color: p.fall, opacity: 0.12 }, data: points.map((x) => -x.drawdown) },
    ],
  };
}
