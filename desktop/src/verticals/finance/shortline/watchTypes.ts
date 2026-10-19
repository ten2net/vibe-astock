/**
 * 盯盘两个分页的数据形状,照后端 orchestrator/src/finance/shortline/watch.ts 与 intraday.ts。
 */
import type { Direction, ReadingKind } from "./viewTypes";

export type Phase = "weekend" | "pre_open" | "auction" | "morning" | "lunch" | "afternoon" | "closing_auction" | "closed";
export type AlertKind = "急拉" | "急跌" | "封板" | "开板";
export interface WatchAlert { ts: string; code: string; name: string; kind: AlertKind; change_pct: number | null; price: number | null; pct: number | null; msg: string; sources: string[] }
export interface WatchRow { code: string; name: string; price: number | null; pct: number | null; amount_yuan: number | null; quote_time: string | null; today: boolean }
export interface LadderWatchRow extends WatchRow { boards: number; label: string; sector: string; at_limit: boolean | null }
export interface WatchView {
  date: string; clock: string; phase: Phase; phase_label: string;
  trading_day: boolean | null;
  detecting: boolean; poll_ms: number;
  quote_day: string | null;
  holdings: (WatchRow & { pnl_pct: number | null })[];
  watchlist: WatchRow[];
  ladder: { sample_date: string; quote_date: string; highest: number; rows: LadderWatchRow[] } | null;
  turnover: { date: string; rows: (WatchRow & { rank: number })[] } | null;
  bigcap: { total: number; date: string; refreshed_at: string | null; top: WatchRow[]; bottom: WatchRow[] } | null;
  alerts: WatchAlert[];
  notes: string[];
  rules: { surge_pct: number; window_min: number; cooldown_min: number };
  source: string;
}

export type Slot = "09:25" | "09:35" | "10:00" | "11:30" | "14:00" | "15:00";
export type Basis = "open" | "latest";
export interface TierStat { sample: number; avg: number; median: number; up_rate: number }
export interface TopBoard { code: string; name: string; boards: number; sector: string; pct: number | null; at_limit: boolean | null }
export interface Cohort {
  expected: number; sample: number; coverage_rate: number;
  avg: number; median: number; up_count: number; down_count: number; up_rate: number; deep_loss_5: number;
  by_tier: Record<string, TierStat>;
  top_board_level: number; top_boards: TopBoard[];
}
export interface LiveCounts {
  limit_up: number | null; broken: number | null; limit_down: number | null; highest_board: number | null; consec_count: number | null;
  seal_rate: number | null; broken_rate: number | null; promotion_1to2: number | null; promotion_all: number | null;
}
export interface Snapshot {
  schema: number; date: string; slot: Slot;
  captured_at: string; clock: string; drift_minutes: number;
  basis: Basis; prev_date: string;
  cohort: Cohort;
  live: LiveCounts | null;
  live_reason?: string;
  gaps: string[];
}
export type SlotState = "saved" | "failed" | "skipped" | "missing" | "upcoming";
export interface SlotRow { slot: Slot; window_end: string; state: SlotState; reason: string | null; snapshot: Snapshot | null }
export interface CheckPoint { slot: Slot; value: number | null; actual: Direction | null; actual_label: string | null; verified: boolean | null }
export interface CheckItem {
  id: string; metric: string; label: string; unit: string; kind: ReadingKind; eps: number;
  direction: Direction; direction_label: string; reason: string;
  base_value: number | null; close_only: boolean; points: CheckPoint[];
}
export interface IntradayResult {
  date: string; today: boolean;
  /** 这一天开不开市;null = 没查到 */
  trading_day: boolean | null;
  slots: SlotRow[];
  auction: Snapshot | null;
  auction_reason: string | null;
  checks: { set_date: string | null; items: CheckItem[] };
  warnings: string[];
  gaps: string[];
  basis_labels: Record<Basis, string>;
  source: string;
  generated_at: string;
}
export interface CaptureResult { slot: string; ok: boolean; already: boolean; reason: string | null }
