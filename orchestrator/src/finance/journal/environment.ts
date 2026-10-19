/**
 * 按入场那天的市场环境分组(移植自 VA 交易日志的「按情绪环境」「按当时板位」两组)。
 *
 * 两样都按**入场日**取(一轮 = 第一笔买入那天,补记 = 填的日期):
 *   - 情绪强 / 中 / 弱:入场日情绪分(和涨停样本统计同一个算式:涨停家数 × (1 + 最高连板) × (1 − 炸板率)),
 *     在你交易过的这些日子之间三等分。是相对强弱:只在强势市场里做的人,也会有三分之一的日子分到「弱」。
 *     VA 用 AI 复盘写的情绪档位(没复盘的日子归「未记录」);新版没有这个字段。
 *   - 当时板位:入场那天收盘时这只票在不在东财涨停池里、几板;不在涨停池、在炸板池里 = 炸板。
 *     VA 把炸板并进「非涨停」;短线上「买进当天炸板」和「当天没碰板」是两回事,这里分开。
 * 🔴 VA 涨停池取不到时把那天的票全当「非涨停」,这里归「没取到」。
 * 🔴 入场那天还没收盘的不分组:盘中的涨停池和情绪读数收盘前还会变。
 * 东财这几张池只留约一个月,更早的日子只读本机缓存(情绪历史、涨停样本、收盘后定时任务取过的才有)。
 * 只读,不写盘。⛔ 这些数据不进任何 AI 提示词。
 */
import { localClock } from "../../notify.ts";
import { fetchEndpoint, type ServiceContext } from "../../service.ts";
import { readRawDoc } from "../candidates.ts";
import { UNCLASSIFIED, parsePool, type ZtStock } from "../review_tiers.ts";
import { SCHEDULE_TZ, failedNote, pool } from "../schedule.ts";
import { consistencyFor, noteOf, retentionFloor, valuesOf } from "../shortline/history.ts";
import { MIN_REGIME_DAYS, REGIMES, entryScore, regimeCuts, regimeOf, type Regime } from "../shortline/samples.ts";
import type { JournalRow } from "./rows.ts";
import { groupBy, type Group } from "./stats.ts";
import { computeJournal, loadJournalData } from "./view.ts";

/** 只看最近这么多笔(同复查清单) */
export const ENV_LIMIT = 500;
const CONCURRENCY = 3;
/** 那天 15:30(北京)以后才算收盘定稿,和最大浮盈浮亏同一条线 */
const SETTLE_UTC = "T07:30:00.000Z";
/** 池子快照要在那天 15:05(北京)以后取的才算收盘后的池 */
const POOL_CLOSE_HM = "15:05";

export const BOARD_GROUPS = ["首板", "2板", "3板及以上", "炸板", "没碰涨停", "非涨停(没分出炸板)", "没取到"] as const;
export type BoardGroup = (typeof BOARD_GROUPS)[number];

export interface DayEnv {
  /** 入场日情绪分;null = 没取到或缺项 */
  score: number | null;
  money_effect: number | null;
  emotion_note: string;
  /** 收盘涨停池;null = 没取到 */
  zt: ZtStock[] | null;
  /** 炸板池;null = 没取到 */
  zb: ZtStock[] | null;
  pool_note: string;
}

export interface EnvRow {
  key: string; date: string;
  /** null = 入场那天还没收盘,不分组 */
  regime: Regime | null;
  score: number | null;
  money_effect: number | null;
  board: BoardGroup | null;
  boards: number | null;
  first_seal: string | null;
  /** 炸板次数:涨停的是封住前炸开过几次,炸板的是当天炸了几次 */
  broken_times: number | null;
  /** 东财行业;不在两张池里、或没归类的是 null */
  industry: string | null;
}

export type BoardInfo = Pick<EnvRow, "boards" | "first_seal" | "broken_times" | "industry"> & { board: BoardGroup };
const NONE = { boards: null, first_seal: null, broken_times: null, industry: null } as const;
const industryOf = (s: ZtStock) => (s.industry && s.industry !== UNCLASSIFIED ? s.industry : null);

/** 这只票入场那天的板位。涨停池里没给连板数的按首板(VA 同) */
export function boardOf(symbol: string, zt: readonly ZtStock[] | null, zb: readonly ZtStock[] | null): BoardInfo {
  if (!zt) return { board: "没取到", ...NONE };
  const hit = zt.find((s) => s.symbol === symbol);
  if (hit) {
    const b = hit.boards ?? 1;
    return { board: b === 1 ? "首板" : b === 2 ? "2板" : "3板及以上", boards: b, first_seal: hit.first_seal ?? null, broken_times: hit.broken_times ?? null, industry: industryOf(hit) };
  }
  if (!zb) return { board: "非涨停(没分出炸板)", ...NONE };
  const broke = zb.find((s) => s.symbol === symbol);
  return broke ? { board: "炸板", ...NONE, broken_times: broke.broken_times ?? null, industry: industryOf(broke) } : { board: "没碰涨停", ...NONE };
}

export const settledDay = (day: string, now: Date) => now.toISOString() >= `${day}${SETTLE_UTC}`;

/**
 * 纯计算:每笔挂上入场日环境,再分两组统计。
 * @param rows VA 顺序(入场日新的在前)
 * @param days 入场日 → 那天的环境(收盘后的才给;没收盘的日子不在里面)
 */
export function computeEnvironment(rows: readonly JournalRow[], days: ReadonlyMap<string, DayEnv>) {
  const recent = rows.slice(0, ENV_LIMIT);
  const scored = [...days.values()].map((d) => d.score);
  const cuts = regimeCuts(scored);
  const out: EnvRow[] = [];
  const settled: { r: JournalRow; regime: Regime; board: BoardGroup }[] = [];
  for (const r of recent) {
    const d = days.get(r.date);
    if (!d) {
      out.push({ key: r.key, date: r.date, regime: null, score: null, money_effect: null, board: null, ...NONE });
      continue;
    }
    const regime = regimeOf(d.score, cuts);
    const b = boardOf(r.symbol, d.zt, d.zb);
    out.push({ key: r.key, date: r.date, regime, score: d.score, money_effect: d.money_effect, ...b });
    settled.push({ r, regime, board: b.board });
  }
  const byRegime = new Map(settled.map((x) => [x.r, x.regime] as const));
  const byBoard = new Map(settled.map((x) => [x.r, x.board] as const));
  const rank = (list: readonly string[]) => (k: string) => list.indexOf(k);
  return {
    rows: out,
    by_regime: groupBy(settled.map((x) => x.r), (r) => byRegime.get(r)!, rank(REGIMES)),
    by_board: groupBy(settled.map((x) => x.r), (r) => byBoard.get(r)!, rank(BOARD_GROUPS)),
    regime_cuts: cuts,
    scored_days: scored.filter((s) => s !== null).length,
    unsettled_trades: out.filter((x) => x.regime === null).length,
    scanned: recent.length,
  };
}

const afterClose = (fetchedAt: string, day: string) => {
  const at = localClock(new Date(fetchedAt), SCHEDULE_TZ);
  return at.day > day || (at.day === day && at.hm >= POOL_CLOSE_HM);
};

/** 信封里的池子全表:取失败给原因;有 raw_ref 但文件读不到算 lost */
function readPool(ctx: ServiceContext, r: { envelope: unknown; out_dir: string }): { failed: string | null; doc: unknown; lost: boolean } {
  const env = r.envelope as { status?: string; evidence?: { raw_ref?: unknown }[] };
  if (env?.status === "failed") return { failed: failedNote(env), doc: null, lost: false };
  const ref = (Array.isArray(env?.evidence) ? env.evidence : []).map((e) => (typeof e?.raw_ref === "string" ? e.raw_ref : "")).find(Boolean);
  const doc = ref ? readRawDoc(ctx, r.out_dir, ref) : null;
  return { failed: null, doc, lost: Boolean(ref) && doc === null };
}

async function poolOf(ctx: ServiceContext, endpoint: "em_zt_pool" | "em_zb_pool", day: string, oldest: string, signal: AbortSignal): Promise<{ stocks: ZtStock[] | null; note: string }> {
  try {
    const args = { date: day.replaceAll("-", "") };
    let r = await fetchEndpoint(ctx, { endpoint, args, consistency: consistencyFor(day, oldest, false), signal });
    if (r.cached && !afterClose(r.fetched_at, day)) {
      // 缓存的是那天收盘前的池子:保留期内重取;超出保留期取不回来,只能算没取到
      if (day < oldest) return { stocks: null, note: "本机只存了那天盘中的池子" };
      r = await fetchEndpoint(ctx, { endpoint, args, consistency: { mode: "fresh" }, signal });
    }
    let got = readPool(ctx, r);
    if (r.cached && got.lost) {
      // 快照还在、落盘的全表没了(数据目录搬过或清理过):保留期内重取,超出说清楚,不当成空池
      if (day < oldest) return { stocks: null, note: "本机缓存的池子全表不见了" };
      r = await fetchEndpoint(ctx, { endpoint, args, consistency: { mode: "fresh" }, signal });
      got = readPool(ctx, r);
    }
    if (got.failed !== null) return { stocks: null, note: got.failed || "没取到" };
    if (got.lost) return { stocks: null, note: "池子全表的文件读不到" };
    const stocks = parsePool(got.doc);
    // 东财超过保留期或日期不对时回空池、不报错:空池一律按没取到
    if (!stocks?.length) return { stocks: null, note: "池是空的(超过东财保留期或不是交易日时如此)" };
    return { stocks, note: "" };
  } catch (e) {
    if (signal.aborted) throw e;
    return { stocks: null, note: noteOf(e) };
  }
}

async function emotionOf(ctx: ServiceContext, day: string, oldest: string, signal: AbortSignal): Promise<{ score: number | null; money_effect: number | null; note: string }> {
  try {
    const r = await fetchEndpoint(ctx, { endpoint: "cn_shortline_daily", args: { date: day }, consistency: consistencyFor(day, oldest, false), signal });
    // ⚠️ 端点自己的说明(settled)在 extra 里
    const env = r.envelope as { status?: string; extra?: { settled?: unknown } };
    if (env?.status === "failed") return { score: null, money_effect: null, note: failedNote(env) || "没取到" };
    if (env?.extra?.settled === false) return { score: null, money_effect: null, note: "读数是那天收盘前的" };
    const v = valuesOf(env);
    const score = entryScore(v);
    return { score, money_effect: v.money_effect ?? null, note: score === null ? "情绪读数缺涨停家数、最高连板、炸板率中的一项" : "" };
  } catch (e) {
    if (signal.aborted) throw e;
    return { score: null, money_effect: null, note: noteOf(e) };
  }
}

/** 同一种原因的日子合成一条,最多列 3 天 */
function gapLines(items: { day: string; note: string }[], what: string): string[] {
  const by = new Map<string, string[]>();
  for (const x of items) by.set(x.note, [...(by.get(x.note) ?? []), x.day]);
  return [...by.entries()].map(([note, ds]) => `${ds.length} 天的${what}没取到(${note}):${ds.slice(0, 3).join("、")}${ds.length > 3 ? " 等" : ""}`);
}

/** `GET /view/journal_env` —— 交易日志「交易记录」页的按入场日环境分组 */
export async function journalEnvironment(ctx: ServiceContext, _query: Record<string, string>, signal: AbortSignal, now = new Date()) {
  const d = loadJournalData(ctx);
  if (!d.settings.fees) return { available: false as const, reason: d.settings.problem ?? "交易日志设置有问题" };
  const { rows } = computeJournal(d, d.settings.fees);
  if (!rows.length) return { available: false as const, reason: "还没有交易记录" };
  const recent = rows.slice(0, ENV_LIMIT);
  const oldest = retentionFloor(now);
  const today = localClock(now, SCHEDULE_TZ).day;
  const dates = [...new Set(recent.map((r) => r.date))].filter((x) => x <= today && settledDay(x, now)).sort();
  const fetched = await pool(dates, CONCURRENCY, async (day) => {
    const emo = await emotionOf(ctx, day, oldest, signal);
    const zt = await poolOf(ctx, "em_zt_pool", day, oldest, signal);
    // 涨停池没取到,板位整天都是「没取到」,炸板池不必再取(少一次东财请求)
    const zb = zt.stocks ? await poolOf(ctx, "em_zb_pool", day, oldest, signal) : { stocks: null, note: "" };
    return { day, env: { score: emo.score, money_effect: emo.money_effect, emotion_note: emo.note, zt: zt.stocks, zb: zb.stocks, pool_note: zt.note } satisfies DayEnv, zbNote: zb.note };
  });
  const days = new Map(fetched.map((f) => [f.day, f.env] as const));
  const c = computeEnvironment(rows, days);
  const gaps: string[] = [];
  if (c.unsettled_trades) gaps.push(`${c.unsettled_trades} 笔的入场日还没收盘,不分组`);
  gaps.push(...gapLines(fetched.filter((f) => f.env.score === null).map((f) => ({ day: f.day, note: f.env.emotion_note })), "情绪读数"));
  if (c.regime_cuts.low === null) gaps.push(`取到情绪读数的交易日只有 ${c.scored_days} 天,不足 ${MIN_REGIME_DAYS} 天,不分强中弱`);
  gaps.push(...gapLines(fetched.filter((f) => !f.env.zt).map((f) => ({ day: f.day, note: f.env.pool_note })), "涨停池"));
  gaps.push(...gapLines(fetched.filter((f) => f.env.zt && !f.env.zb).map((f) => ({ day: f.day, note: f.zbNote })), "炸板池"));
  return {
    available: true as const,
    ...c,
    days: dates.length,
    gaps,
    note: "按入场那天的市场环境分组。情绪强中弱是你交易过的这些日子之间相对比较(情绪分 = 涨停家数 × (1 + 最高连板) × (1 − 炸板率),同涨停样本统计);当时板位看入场那天收盘时这只票在不在涨停池、炸板池里。这是你自己的行为统计,不是对市场的预测。",
    source: "东财涨停池 / 炸板池(em_zt_pool / em_zb_pool)+ 每日情绪读数(cn_shortline_daily);东财只留约一个月,更早的日子只读本机缓存",
  };
}
