/**
 * 模式卡(移植自 VA `duanxian/modes.py`):把自己的打法写下来,**带版本**,按版本分段统计业绩。
 *
 * 打法改了以后,改之前和改之后的交易不能混在一起算平均。所以每个版本带生效日(`since`),
 * 交易按**入场日落在哪个版本的区间**归属,回答「上次调整之后表现有没有变化」。
 *
 * 🔴 三条约束(VA 原样,改代码时别破坏):
 *    1. 不预填任何规则内容 —— 卡片文字全由用户写,系统只存,不校验内容、不给建议。
 *    2. 开新版本不覆盖旧版本 —— 已发生的交易永远归它当时生效的版本,历史不能被追溯改写。
 *       打法(playbook)也进版本:它决定哪些交易归这张卡,只放卡片层的话改一次就把历史全部重新归属了。
 *    3. 样本不够不比较 —— 每个版本少于 6 笔标「不够」,不给倾向性结论。
 * 🔴 生效日:建卡当天就是第一版;之后改动从**次日**生效(当天的交易不做日内先后归因)。
 * ⛔ 这些数据不进任何 AI 提示词。
 */
import type { LedgerRecord } from "../../ledger.ts";
import { PLAYBOOKS } from "./defs.ts";
import { median, pyRound, sum } from "./num.ts";
import type { JournalRow } from "./rows.ts";

export const MODE_KIND = "mode_card";
/** 每个版本至少这么多笔,才单独给业绩读数、才拿来比较 */
export const MIN_PER_VERSION = 6;
/** 只看最近这么多笔(VA 同) */
export const MODES_LIMIT = 1000;
export const MODE_TEXT_FIELDS = ["setup", "entry", "exit", "sizing", "phase"] as const;
export type ModeTextField = (typeof MODE_TEXT_FIELDS)[number];
export const MODE_TEXT_LABELS: Record<ModeTextField, string> = { setup: "什么情况下做", entry: "怎么进", exit: "怎么出", sizing: "仓位", phase: "适用的情绪阶段" };
export const MODE_TEXT_MAX = 800;
export const MODE_NAME_MAX = 60;
export const MODE_CHANGES_MAX = 300;
export const MODE_VERSIONS_MAX = 200;

export interface ModeVersion {
  version: number; since: string; changes: string; playbook: string;
  setup: string; entry: string; exit: string; sizing: string; phase: string;
  saved_at: string;
}
export interface ModeCard { id: string; name: string; playbook: string; versions: ModeVersion[]; migrated_from: string; created_at: string; updated_at: string }

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function versionOf(v: Record<string, unknown>, cardPlaybook: string): ModeVersion {
  return {
    version: typeof v.version === "number" && Number.isInteger(v.version) ? v.version : 1,
    since: str(v.since), changes: str(v.changes),
    // 老版本没存打法时退回卡片层(VA 同)
    playbook: str(v.playbook) || cardPlaybook,
    setup: str(v.setup), entry: str(v.entry), exit: str(v.exit), sizing: str(v.sizing), phase: str(v.phase),
    saved_at: str(v.saved_at),
  };
}

export function cardOf(r: LedgerRecord): ModeCard {
  const pb = str(r.playbook);
  const vs = Array.isArray(r.versions) ? (r.versions as unknown[]).filter((v): v is Record<string, unknown> => !!v && typeof v === "object") : [];
  return { id: r.id, name: str(r.name), playbook: pb, versions: vs.map((v) => versionOf(v, pb)), migrated_from: str(r.migrated_from), created_at: str(r.created_at), updated_at: str(r.updated_at) };
}

/** 这笔交易发生时哪个版本在生效:since ≤ 入场日里最晚的(同一天以版本号大的为准);早于第一版返回 null */
export function versionAt(versions: readonly ModeVersion[], date: string): ModeVersion | null {
  let best: ModeVersion | null = null;
  for (const v of versions) {
    if (!(v.since <= date)) continue;
    if (!best || v.since > best.since || (v.since === best.since && v.version > best.version)) best = v;
  }
  return best;
}

export interface ModeStats { trades: number; win_rate: number | null; median_pct: number | null; avg_pct: number | null; best: number | null; worst: number | null }

/** 胜率不算持平(和交易日志分组统计同一口径);平均数照 VA 写法 sum / 笔数 */
export function modeStats(pnls: readonly number[]): ModeStats {
  if (!pnls.length) return { trades: 0, win_rate: null, median_pct: null, avg_pct: null, best: null, worst: null };
  const wins = pnls.filter((v) => v > 0).length, decided = wins + pnls.filter((v) => v < 0).length;
  return {
    trades: pnls.length,
    win_rate: decided ? pyRound(wins / decided, 3) : null,
    median_pct: pyRound(median(pnls), 2),
    avg_pct: pyRound(sum(pnls) / pnls.length, 2),
    best: pyRound(Math.max(...pnls), 2),
    worst: pyRound(Math.min(...pnls), 2),
  };
}

/**
 * 每张卡、每个版本的业绩分段。
 * @param rows VA 顺序(入场日新的在前);只取最近 MODES_LIMIT 笔,超出时整个暂停比较(样本被截断了)
 */
export function modesPerformance(cards: readonly ModeCard[], rows: readonly JournalRow[]) {
  if (!cards.length) return { available: false as const, reason: "还没有模式卡 —— 先把「我这套打法」写下来,统计才有分段依据" };
  const truncated = rows.length > MODES_LIMIT;
  const scored = rows.slice(0, MODES_LIMIT).filter((r) => r.pnl_pct !== null);
  const out = cards.map((c) => {
    const vers = c.versions;
    const buckets = new Map<number, number[]>();
    const before: number[] = [];
    let matched = 0;
    // 卡片诞生之前的交易:用第一版的打法判断算不算这张卡的历史,单独列、不进任何版本
    const firstPb = vers[0]?.playbook || c.playbook;
    for (const r of scored) {
      const v = versionAt(vers, r.date);
      if (!v) {
        if (r.playbook === firstPb) { matched += 1; before.push(r.pnl_pct!); }
        continue;
      }
      // 归属看「那天生效的那个版本的打法」,不是卡片现在的打法
      if (r.playbook !== v.playbook) continue;
      matched += 1;
      buckets.set(v.version, [...(buckets.get(v.version) ?? []), r.pnl_pct!]);
    }
    const byVersion = vers.map((v) => {
      const st = modeStats(buckets.get(v.version) ?? []);
      return { ...v, ...st, enough: !truncated && st.trades >= MIN_PER_VERSION };
    });
    // 同一天生效的几个版本只认最后那个(当天改了两次)
    const effective = byVersion.filter((v, i) => !byVersion.slice(i + 1).some((later) => later.since === v.since));
    const latest = effective.at(-1) ?? null, prev = effective.length >= 2 ? effective.at(-2)! : null;
    const cmp = latest && prev && latest.enough && prev.enough && latest.win_rate !== null && prev.win_rate !== null
      ? { win_rate_delta: pyRound(latest.win_rate - prev.win_rate, 3), median_delta: pyRound((latest.median_pct ?? 0) - (prev.median_pct ?? 0), 2), from_version: prev.version, to_version: latest.version }
      : null;
    const beforeStats = before.length ? { ...modeStats(before), enough: !truncated && before.length >= MIN_PER_VERSION } : null;
    return {
      id: c.id, name: c.name, playbook: c.playbook, version_count: vers.length, by_version: byVersion,
      matched_trades: matched, before_card: beforeStats, latest_vs_prev: cmp, compare_blocked: !!(latest && prev) && cmp === null,
    };
  });
  return {
    available: true as const,
    cards: out,
    min_per_version: MIN_PER_VERSION,
    truncated,
    note: `${truncated ? `交易超过 ${MODES_LIMIT} 笔,只看最近 ${MODES_LIMIT} 笔,暂停版本比较。` : ""}交易按打法归到卡片,再按入场日落在哪个版本的生效区间分段。建卡当天算第一版,之后的修改从次日生效;不做日内先后归因。建卡之前的交易单独列出、不进任何版本 —— 否则等于拿现在的规则评价更早的操作。`,
  };
}

/** 卡片文字是否改了(决定要不要开新版本) */
export function modeChanged(last: ModeVersion | null, body: Record<ModeTextField | "playbook", string>): boolean {
  if (!last) return true;
  return [...MODE_TEXT_FIELDS, "playbook" as const].some((k) => last[k] !== body[k]);
}

export const isPlaybook = (s: string) => (PLAYBOOKS as readonly string[]).includes(s);
