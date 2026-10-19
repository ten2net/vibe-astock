/**
 * 交易日志的分组统计(移植自 VA `journal._bucket_stats` / `stats`)。
 *
 * ⚠️ 这是对使用者**自己历史行为**的统计,不是对市场的预测,不产出任何操作建议。样本少时读数没有意义,每组都带笔数。
 * 🔴 口径(和 VA、模式卡同一个,改要一起改):
 *    - 胜率只算分出胜负的:持平(0%)不进分母;全部持平给 null(那是「没有胜负可言」,不是「没赢过」)。
 *    - 百分比和金额是两个口径:补记只有 %,不进金额;仓位不同时两者结论可能相反,所以都给。
 */
import { PLAYBOOKS } from "./defs.ts";
import { mean, pyRound, sum } from "./num.ts";
import type { JournalRow } from "./rows.ts";

export interface Bucket {
  count: number;
  /** 有盈亏 % 的笔数 */
  scored: number;
  /** 有盈亏金额的笔数(按流水算出的) */
  money_scored: number;
  net_pnl: number | null;
  win_rate: number | null;
  avg: number | null;
  best: number | null;
  worst: number | null;
}
export interface Group extends Bucket { key: string }

export function bucketStats(rows: readonly JournalRow[]): Bucket {
  const vals = rows.map((r) => r.pnl_pct).filter((v): v is number => v !== null);
  const money = rows.map((r) => r.realized_pnl).filter((v): v is number => v !== null);
  const base = { count: rows.length, scored: vals.length, money_scored: money.length, net_pnl: money.length ? pyRound(sum(money), 2) : null };
  if (!vals.length) return { ...base, win_rate: null, avg: null, best: null, worst: null };
  const wins = vals.filter((v) => v > 0).length;
  const decided = wins + vals.filter((v) => v < 0).length;
  return {
    ...base,
    win_rate: decided ? pyRound(wins / decided, 3) : null,
    avg: pyRound(mean(vals), 2),
    best: pyRound(Math.max(...vals), 2),
    worst: pyRound(Math.min(...vals), 2),
  };
}

export const UNTAGGED = "未标注";
export const plannedKey = (v: boolean | null) => (v === true ? "按计划" : v === false ? "计划外" : UNTAGGED);
export function holdKey(r: JournalRow): string {
  const d = r.hold_days;
  if (d === null) return r.kind === "manual" ? "未填明细" : "还没卖";
  return d === 0 ? "同日买卖(底仓待核)" : d === 1 ? "隔日" : `持有${d}天`;
}
const holdRank = (k: string) => (k === "同日买卖(底仓待核)" ? 0 : k === "隔日" ? 1 : k === "还没卖" ? 1e6 : k === "未填明细" ? 1e6 + 1 : Number(k.replace(/\D/g, "")));

/** 按 keyOf 分组;order 给出组的先后(不在里面的排最后,按名字) */
export function groupBy(rows: readonly JournalRow[], keyOf: (r: JournalRow) => string, order: (k: string) => number): Group[] {
  const m = new Map<string, JournalRow[]>();
  for (const r of rows) { const k = keyOf(r); m.set(k, [...(m.get(k) ?? []), r]); }
  return [...m.entries()]
    .sort(([a], [b]) => order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, rs]) => ({ key, ...bucketStats(rs) }));
}

export interface JournalStats {
  overall: Bucket;
  by_playbook: Group[];
  by_planned: Group[];
  by_hold: Group[];
}

export function journalStats(rows: readonly JournalRow[]): JournalStats {
  const pbRank = (k: string) => { const i = (PLAYBOOKS as readonly string[]).indexOf(k); return i < 0 ? PLAYBOOKS.length : i; };
  const plRank = (k: string) => ["按计划", "计划外", UNTAGGED].indexOf(k);
  return {
    overall: bucketStats(rows),
    by_playbook: groupBy(rows, (r) => r.playbook ?? UNTAGGED, pbRank),
    by_planned: groupBy(rows, (r) => plannedKey(r.as_planned), plRank),
    by_hold: groupBy(rows, holdKey, holdRank),
  };
}
