/**
 * 短线端点(cn_shortline_*)返回结果的形状 —— 都在信封的 `extra.result` 里。
 * 移植自 Vibe AStock v2.0.0 的 lib/agent.ts,字段按 2026-10-09 真实返回核对过。
 * 和 VA 的不同:四项读数、盘面事实、题材树、周期、首板各是一个端点,不再塞在一份复盘快照里;
 * 样本类读数多了 coverage / coverage_rate / partial(行情只取到一部分时如实说)。
 */

interface Base { available: boolean; reason?: string; prev_date?: string; note?: string }
/** 样本是逐只取当天行情算的:取到几只、占多少;partial = 没取全 */
interface Coverage { sample?: number; expected_sample?: number; coverage?: number; coverage_rate?: number; partial?: boolean; source?: string }

// ---------- 情绪四项(cn_shortline_emotion)----------
export interface MoneyEffect extends Base, Coverage {
  avg?: number; median?: number; positive_rate?: number; limit_up_again_rate?: number;
}
export interface PromotionTier { base: number; promoted: number; rate: number | null }
export interface Promotion extends Base {
  tiers?: Record<string, PromotionTier>;
  overall?: PromotionTier;
  limit_up_count?: number;
  prev_limit_up_count?: number;
}
export interface ConsecPremium extends Base, Coverage { avg?: number; median?: number; positive_rate?: number }
/** 连板梯队断层:2 板到最高板之间有没有空档 */
export interface LadderGap extends Base {
  highest?: number;
  /** { "9": 1, "5": 2, ... } 各档家数 */
  tiers?: Record<string, number>;
  /** 缺的档位,如 [3, 4] */
  gaps?: number[];
  continuous?: boolean;
}
export interface EmotionResult {
  date: string;
  prev_date?: string | null;
  settled?: boolean;
  money_effect?: MoneyEffect;
  promotion?: Promotion;
  consec_premium?: ConsecPremium;
  ladder_gap?: LadderGap;
}

// ---------- 情绪周期(cn_shortline_cycle)----------
export interface CycleDay { date: string; limit_up: number; highest_consec: number; broken_rate: number | null; score: number | null }
export interface EmotionCycle extends Base {
  window?: number;
  requested_window?: number;
  trough_date?: string;
  trough_score?: number;
  current_score?: number;
  current_date?: string;
  day_n?: number;
  rising?: boolean;
  /** 最近走向:连续两日走强 / 今日转弱 / 基本走平 … */
  trend?: string;
  /** 当前值在窗口区间的分位(0~1) */
  pctile?: number | null;
  series?: CycleDay[];
}
export interface CycleResult { date: string; settled?: boolean; cycle?: EmotionCycle }

// ---------- 盘面事实(cn_shortline_facts)----------
export interface SealQuality extends Base {
  total?: number;
  /** 全天一次没炸过的家数 —— 板的成色 */
  never_broken?: number; never_broken_rate?: number;
  opening_seconds?: number;
  late_seal?: number;
  reopened?: number;
  avg_broken_times?: number;
  /** 真炸板率 = 炸板未回封 ÷(涨停 + 炸板未回封)。不是「1 - 从未炸板占比」 */
  broken_rate?: number | null;
  broken_pool?: number;
  ever_opened_rate?: number;
}
export interface LossEffect extends Base, Coverage {
  deep_loss_5_count?: number; deep_loss_5_rate?: number; deep_loss_7_count?: number;
  limit_down_count?: number; worst?: number; market_limit_down?: number;
  /** 昨日炸板股今天修复了没 —— 试错代价的直接读数 */
  prev_broken_recovery?: { sample: number; avg: number; positive_rate: number } | null;
}
export interface FeedbackCell {
  晋级涨停: number; 收红: number; 小跌: number; "跌超5%": number; 跌停: number;
  合计: number; 晋级率: number | null;
}
export interface FeedbackDetail {
  code: string; name: string; board: number | string; prev_tier: string;
  ret: number; result: string; sector: string;
}
export interface FeedbackMatrix extends Base, Coverage {
  result_order?: string[];
  matrix?: Record<string, FeedbackCell>;
  details?: FeedbackDetail[];
}
export interface ThemeRow {
  sector: string; limit_up: number; first_boards: number; consec_boards: number;
  highest: number; broken: number; broken_rate: number | null;
  first_seal: string | null; last_seal: string | null;
  names: { code: string; name: string; boards: number; first_seal: string; broken_times: number }[];
}
export interface ThemeStructure extends Base {
  themes?: ThemeRow[]; theme_count?: number; concentration?: number | null;
  timeline?: { slot: string; count: number }[];
}
export interface LedgerEvent {
  tag: string; code: string; name: string; board: string; boards: number;
  sector: string; ret: number | null; first_seal: string | null; last_seal: string | null;
  broken_times: number; turnover?: number | null; note: string; prev_boards?: number;
}
export interface EventLedger extends Base {
  events?: LedgerEvent[]; count?: number;
  loss_events?: LedgerEvent[];
  gain_events?: LedgerEvent[];
  split_events?: LedgerEvent[];
}
export interface BoardStat {
  limit_up: number; highest: number; broken?: number; limit_down?: number;
  prev_base?: number; promoted?: number; promotion_rate: number | null;
}
export interface ByBoard extends Base { prev_available?: boolean; boards?: Record<string, BoardStat> }
export interface FactsResult {
  date: string;
  prev_date?: string | null;
  settled?: boolean;
  seal_quality?: SealQuality;
  loss_effect?: LossEffect;
  feedback?: FeedbackMatrix;
  themes?: ThemeStructure;
  events?: EventLedger;
  by_board?: ByBoard;
}

// ---------- 题材事件树(cn_shortline_themes)----------
export interface ThemeNode {
  tag: string; state: string;
  limit_up: number; first_boards: number; consec_boards: number; highest: number;
  broken: number; limit_down: number; broken_rate: number | null;
  first_seal: string | null; last_seal: string | null;
  prev_members: number; prev_still_up: number; prev_broken_or_down: number;
  continuation_rate: number | null;
  members: { code: string; name: string; boards: number; label?: string; first_seal: string | null; broken_times: number }[];
}
export interface ThemeTree extends Base {
  source_note?: string;
  tag_count?: number;
  themes?: ThemeNode[]; concentration?: number | null;
  covered?: number; total_limit_up?: number; coverage_rate?: number | null;
  has_prev?: boolean; prev_covered?: number; prev_total?: number;
}
export interface ThemesResult { date: string; prev_date?: string | null; settled?: boolean; top?: number; tree?: ThemeTree }

// ---------- 首板名单(cn_shortline_firstboard)----------
export interface FirstBoardStock {
  code: string; name: string; board: string;
  close: number | null; ret: number | null; amount: number | null; float_cap: number | null;
  sector: string; first_seal: string; broken_times: number;
  label: string; rebound: boolean; reason: string;
}
export interface FirstBoardResult {
  date: string; settled?: boolean;
  available: boolean; reason?: string;
  total_limit_up?: number; first_count?: number; rebound_count?: number;
  reason_available?: boolean; reason_covered?: number; reason_note?: string;
  stocks?: FirstBoardStock[];
}

// ---------- 连板天梯(cn_shortline_board_ladder)----------
export interface LadderStock {
  code: string; name: string; board: string; boards: number;
  /** 「4板」或「5天4板」(反包) */
  label: string; rebound: boolean;
  first_seal: string; last_seal: string; broken_times: number;
  seal_fund: number | null; amount: number | null; float_cap: number | null; turnover: number | null;
  reason: string; tags: string[];
}
/** 昨天在这一层下面一层、今天没接上的 */
export interface LadderFell { code: string; name: string; prev_boards: number; prev_label: string; outcome: "跌停" | "炸板" | "没涨停" | "没取到"; ret: number | null }
export interface LadderLevel {
  boards: number; stocks: LadderStock[]; fell: LadderFell[];
  /** 昨天 boards-1 板的只数;首板层和昨天池子没取到时没有 */
  base: number | null; promoted: number | null; rate: number | null;
}
export interface BoardLadder {
  available: boolean; reason?: string;
  levels?: LadderLevel[]; total_limit_up?: number; highest?: number | null; consec_count?: number;
  prev_available?: boolean; prev_note?: string;
  reason_available?: boolean; reason_covered?: number; reason_note?: string;
  /** 原因串取到了、但没有原因的沪深涨停股(北交所同花顺不收录,不算) */
  reason_missing?: string[];
}
export interface BoardLadderResult { date: string; prev_date: string | null; settled?: boolean; ladder: BoardLadder }

// ---------- 题材轮动(cn_shortline_theme_rotation)----------
/** unknown = 这天没有涨停原因的沪深涨停股只数;>0 时没出现的题材是 null(说不准),出现的只数是下限 */
export interface RotationDay { date: string; available: boolean; reason?: string; limit_up?: number; covered?: number; top?: string[]; unknown?: number }
export interface RotationTheme {
  tag: string;
  /** 每天的涨停只数,和 dates 一一对应;null = 那天没取到或说不准(不是 0) */
  series: (number | null)[]; ranks: (number | null)[]; highest: (number | null)[];
  today: number; total: number; active_days: number; top3_days: number;
  streak: number; streak_partial: boolean; status: string; first_day: string | null;
  /** 今天这个题材里板数最高的几只(名字) */
  members: string[];
}
export interface ThemeRotation {
  available: boolean; reason?: string;
  dates?: string[]; days?: RotationDay[]; themes?: RotationTheme[];
  tag_count?: number; missing_days?: string[]; prev_available?: boolean;
  /** 有沪深涨停股没有涨停原因的日子 */
  partial_days?: string[];
}
export interface ThemeRotationResult { date: string; days: number; settled?: boolean; rotation: ThemeRotation }
