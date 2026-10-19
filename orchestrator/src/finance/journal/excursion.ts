/**
 * 最大浮盈浮亏(移植自 VA `duanxian/excursion.py`,MFE / MAE 与盈利回吐)。
 *
 * 一笔交易的盈亏只说了终点,不说过程:
 *   - 最大浮盈(MFE):这笔最多曾赚到多少。远高于实际落袋 = 盈利回吐;
 *   - 最大浮亏(MAE):这笔最多曾亏到多少;
 *   - 捕获率 = 实际落袋 ÷ 最大浮盈。
 *
 * ⚠️ 日 K 的先天限制(必须如实标出):只有日线最高 / 最低价,看不出极值发生在盘中买入之前还是之后。
 *    同日进出整段存疑,最大浮盈只是上界;跨日持有时中间完整交易日的高低点一定在持仓期内,只有两头存疑。
 *    所以另给 `*_certain`(只取严格落在买入日与卖出日之间的完整交易日),两个方向相反:
 *    `mfe_certain` = 确定至少赚到过这么多;`mae_certain` = 确定至少差到过这个程度(**可能是正数 = 那几天从未浮亏**)。
 * ⚠️ 用的是**不复权**日线对照成交成本(VA 同):期间有送转的整轮不算(价格腰斩会被读成深度浮亏),
 *    现金分红除息仍会让低点偏低,在说明里写明。
 * 🔴 和 VA 不同:只算**卖光了的**一轮(VA 部分卖出的也算,但那时「实际落袋」只是卖掉那部分);北交所腾讯 K 线取不到,不算。
 * ⛔ 这些数据不进任何 AI 提示词。
 */
import { ServiceError, fetchEndpoint, type ServiceContext } from "../../service.ts";
import { readRawDoc } from "../candidates.ts";
import { failedNote, pool } from "../schedule.ts";
import { median, pyRound } from "./num.ts";
import { pyFixed } from "./risk.ts";
import type { ExcursionLite } from "./inbox.ts";
import type { JournalRow } from "./rows.ts";

/** 少于这么多笔不给汇总性描述(几笔的捕获率中位数没有意义) */
export const EXC_MIN_TRADES = 6;
/** 最大浮盈低于这个值(%)时捕获率没有讨论价值:买进去就没怎么涨过,谈不上卖早了 */
export const MEANINGFUL_MFE = 3.0;
/** 捕获率低于这个值提示「几乎没吃到」 */
export const LOW_CAPTURE_HINT = 0.3;
/** 只看最近这么多笔(VA 同) */
export const EXCURSION_LIMIT = 300;
const CONCURRENCY = 4;
/** 卖出那天 15:30(北京时间)以后取到的日线才算收盘定稿;之前取的只是盘中价 */
const SETTLE_UTC = "T07:30:00.000Z";

export const isBj = (symbol: string) => /^(4|8|92)/.test(symbol);

export interface HLBar { date: string; high: number; low: number }

/** 腾讯 K 线信封 → [start, end] 内的日最高 / 最低价(全表在取数器落盘的 extracted 文件里) */
export function klineHighLow(ctx: Pick<ServiceContext, "dataRoot">, env: unknown, outDir: string, start: string, end: string): HLBar[] {
  const evs = env && typeof env === "object" && Array.isArray((env as { evidence?: unknown }).evidence) ? (env as { evidence: { raw_ref?: unknown }[] }).evidence : [];
  const ref = evs.map((e) => (typeof e?.raw_ref === "string" ? e.raw_ref : "")).find((r) => r.startsWith("raw/extracted_"));
  const doc = ref ? readRawDoc(ctx, outDir, ref) as { rows?: unknown } | null : null;
  const by = new Map<string, HLBar>();
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  for (const r of (Array.isArray(doc?.rows) ? doc!.rows : []) as { date?: unknown; high?: unknown; low?: unknown }[]) {
    if (!r || typeof r !== "object") continue;
    const d = typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : "";
    const h = num(r.high), l = num(r.low);
    if (d && d >= start && d <= end && h !== null && l !== null && h >= l) by.set(d, { date: d, high: h, low: l });
  }
  return [...by.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 算这一轮要用的东西:都来自卖光了的一轮 */
export interface ExcursionInput { key: string; symbol: string; name: string; cost: number; buy: string; sell: string; realized_pct: number }

export interface ExcursionItem extends ExcursionLite {
  key: string; symbol: string; name: string;
  date: string; exit_date: string;
  mfe_certain: number | null; mae_certain: number | null; certain_note: string | null;
  bars: number; bars_inner: number;
  precision: string;
  give_back_pct: number;
  capture_note: string | null;
}

const pct = (v: number, cost: number) => pyRound((v / cost - 1) * 100, 2);
const signed2 = (x: number) => `${x < 0 ? "" : "+"}${pyFixed(x, 2)}`;

/** 给定行情算最大浮盈浮亏。纯计算、不碰网络(只读缓存的调用方复用同一套算法) */
export function computeExcursion(t: ExcursionInput, rows: readonly HLBar[]): ExcursionItem | null {
  if (!(t.cost > 0) || !t.buy || !t.sell || !rows.length) return null;
  const mfe = pct(Math.max(...rows.map((r) => r.high)), t.cost);
  const mae = pct(Math.min(...rows.map((r) => r.low)), t.cost);
  // 只取严格在买卖日之间的完整交易日:这几天一定在持仓期内
  const inner = rows.filter((r) => t.buy < r.date && r.date < t.sell);
  const mfeCertain = inner.length ? pct(Math.max(...inner.map((r) => r.high)), t.cost) : null;
  const maeCertain = inner.length ? pct(Math.min(...inner.map((r) => r.low)), t.cost) : null;
  const sameDay = t.buy === t.sell;
  const realized = pyRound(t.realized_pct, 2);
  const capture = mfe >= MEANINGFUL_MFE ? pyRound(realized / mfe, 3) : null;
  return {
    key: t.key, symbol: t.symbol, name: t.name,
    date: t.buy, exit_date: t.sell,
    realized_pct: realized,
    mfe_pct: mfe, mae_pct: mae,
    mfe_certain: mfeCertain, mae_certain: maeCertain,
    certain_note: maeCertain === null ? null
      : maeCertain > 0 ? `中间完整交易日里从未浮亏(最差时仍 ${signed2(maeCertain)}%)`
        : `中间完整交易日里确定浮亏过 ${signed2(maeCertain)}%`,
    bars: rows.length, bars_inner: inner.length,
    same_day: sameDay,
    precision: sameDay ? "上界(同日进出,日线分不清高点在买入前还是后)"
      : inner.length ? "买卖日两头存疑,中间完整交易日可靠" : "上界(相邻两日,没有完整的中间交易日)",
    // 盈利回吐:曾经到过的最好 减 实际落袋
    give_back_pct: pyRound(mfe - realized, 2),
    capture_rate: capture,
    // 捕获率可能是负数:这段确实涨过、最后却亏着走 —— 比「没吃到」更差的一档,得给一句人话
    capture_note: capture !== null && capture < 0 ? "这段涨过,但最后是亏损离场 —— 比「没吃到」更差的一档"
      : capture !== null && capture < LOW_CAPTURE_HINT ? "几乎没吃到这段行情" : null,
  };
}

/** 一笔交易能不能算最大浮盈浮亏;不能的给原因分类 */
export type Eligibility = { ok: true; input: ExcursionInput } | { ok: false; why: "not_closed" | "split" | "bj" };

export function eligibility(r: JournalRow): Eligibility {
  const ep = r.episode;
  if (!ep || !ep.closed || !ep.last_sell || ep.realized_pct === null || !(ep.avg_cost > 0)) return { ok: false, why: "not_closed" };
  if (ep.has_split) return { ok: false, why: "split" };
  if (isBj(r.symbol)) return { ok: false, why: "bj" };
  return { ok: true, input: { key: r.key, symbol: r.symbol, name: r.name, cost: ep.avg_cost, buy: ep.first_buy, sell: ep.last_sell, realized_pct: ep.realized_pct } };
}

const klineArgs = (t: ExcursionInput) => ({ period: "day", adjust: "", start: t.buy, end: t.sell });
/** 这份行情是不是卖出那天收盘以后取的(之前取的高低点可能还会变) */
export const settledFetch = (fetchedAt: string, sell: string) => fetchedAt >= `${sell}${SETTLE_UTC}`;

/**
 * 只读缓存算(复查清单用):一次网络请求都不发。
 * @returns 能算的(按行 key)与跳过的笔数(没缓存 / 缓存是卖出当天盘中取的)
 */
export async function cachedExcursions(ctx: ServiceContext, rows: readonly JournalRow[]): Promise<{ map: Map<string, ExcursionLite>; skipped: number }> {
  const map = new Map<string, ExcursionLite>();
  let skipped = 0;
  for (const r of rows) {
    const el = eligibility(r);
    if (!el.ok) continue;
    const t = el.input;
    try {
      const got = await fetchEndpoint(ctx, { endpoint: "tx_kline", symbol: t.symbol, args: klineArgs(t), consistency: { mode: "cache_only" } });
      const ex = settledFetch(got.fetched_at, t.sell) ? computeExcursion(t, klineHighLow(ctx, got.envelope, got.out_dir, t.buy, t.sell)) : null;
      if (ex) map.set(t.key, ex); else skipped += 1;
    } catch (e) {
      if (e instanceof ServiceError && e.code === "no_snapshot") { skipped += 1; continue; }
      throw e;
    }
  }
  return { map, skipped };
}

export interface ExcursionFailure { key: string; symbol: string; name: string; date: string; why: string }

/** 汇总(VA `summary`),外加各类没算的笔数 */
export function excursionSummary(items: readonly ExcursionItem[]) {
  const caps = items.map((r) => r.capture_rate).filter((c): c is number => c !== null);
  const sameDay = items.filter((r) => r.same_day).length;
  const lostWithMove = caps.filter((c) => c < 0).length;
  return {
    trades: items.length,
    enough_samples: items.length >= EXC_MIN_TRADES,
    // 一律用中位数:少数极端值会把均值拉得看不出典型情况
    median_capture_rate: caps.length ? pyRound(median(caps), 3) : null,
    capture_samples: caps.length,
    median_give_back: items.length ? pyRound(median(items.map((r) => r.give_back_pct)), 2) : null,
    median_mae: items.length ? pyRound(median(items.map((r) => r.mae_pct)), 2) : null,
    // 赚钱收场但中途深亏过 —— 这次扛出来了,但是坏习惯的样本
    endured_count: items.filter((r) => r.realized_pct > 0 && r.mae_pct <= -5).length,
    // 亏钱收场且从没怎么浮盈过 —— 进场就不对,不是拿不住
    bad_entry_count: items.filter((r) => r.realized_pct < 0 && r.mfe_pct < MEANINGFUL_MFE).length,
    same_day_count: sameDay,
    lost_with_move_count: lostWithMove,
    capture_note: lostWithMove ? `其中 ${lostWithMove} 笔捕获率是负数 —— 那段确实涨过,但最后是亏损离场,比「没吃到」更差的一档(所以中位数可能是负的,不是算错了)。` : null,
    // 入场日新的在前(稳定排序)
    items: items.map((it, i) => ({ it, i })).sort((a, b) => (a.it.date !== b.it.date ? (a.it.date < b.it.date ? 1 : -1) : a.i - b.i)).map((x) => x.it),
    // 偏差必须和结论摆在一起
    bias_note: `最大浮盈取的是日线高点,含「买入之前」的那部分 → 捕获率被系统性低估。其中 ${sameDay} 笔是同日进出,整段只能给上界。真实的最大浮盈落在每笔的「确定赚到过」与上界之间。最大浮亏同样包含入场前或离场后的日线低点,只能当最不利的边界,不能当实际持仓里的最大浮亏。`,
    caveat: "日线看不出最高点发生在盘中买入之前还是之后。跨日持有时,中间完整交易日的高低点在持仓期内。这里用不复权日线对照你的成交成本:期间有送转的整轮不算;遇到除息,低点会偏低,应自己核对,不据此判断真实得失。",
  };
}

/**
 * 逐笔取行情算(「复查」页的最大浮盈浮亏)。历史行情取到就永久缓存,首次会慢。
 * 🔴 卖出当天收盘前取的那份不算定稿:收盘后再打开会重取一次。
 */
export async function computeExcursions(ctx: ServiceContext, rows: readonly JournalRow[], signal: AbortSignal, now: Date) {
  const recent = rows.slice(0, EXCURSION_LIMIT);
  const counts = { not_closed: 0, split: 0, bj: 0, failed: 0 };
  const todo: ExcursionInput[] = [];
  for (const r of recent) {
    const el = eligibility(r);
    if (el.ok) todo.push(el.input); else counts[el.why] += 1;
  }
  const nowIso = now.toISOString();
  const failures: ExcursionFailure[] = [];
  let intraday = 0, cachedN = 0;
  const results = await pool(todo, CONCURRENCY, async (t): Promise<ExcursionItem | null> => {
    const fail = (why: string) => { failures.push({ key: t.key, symbol: t.symbol, name: t.name, date: t.buy, why }); return null; };
    try {
      let got = await fetchEndpoint(ctx, { endpoint: "tx_kline", symbol: t.symbol, args: klineArgs(t), consistency: { mode: "prefer_cache" }, signal });
      const closeAt = `${t.sell}${SETTLE_UTC}`;
      if (got.cached && !settledFetch(got.fetched_at, t.sell) && nowIso >= closeAt) {
        got = await fetchEndpoint(ctx, { endpoint: "tx_kline", symbol: t.symbol, args: klineArgs(t), consistency: { mode: "fresh" }, signal });
      }
      const env = got.envelope as { status?: unknown };
      if (env?.status === "failed") return fail(failedNote(env) || "取不到这段的日线行情");
      const ex = computeExcursion(t, klineHighLow(ctx, got.envelope, got.out_dir, t.buy, t.sell));
      if (!ex) return fail("这段的日线行情是空的");
      if (got.cached) cachedN += 1;
      if (!settledFetch(got.fetched_at, t.sell)) intraday += 1;
      return ex;
    } catch (e) {
      if (signal.aborted) throw e;
      return fail(e instanceof Error ? e.message.slice(0, 80) : "取数失败");
    }
  });
  const items = results.filter((x): x is ExcursionItem => x !== null);
  counts.failed = failures.length;
  failures.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const base = {
    scanned: recent.length, counts, cached: cachedN,
    failures: failures.slice(0, 30),
    intraday_note: intraday ? `${intraday} 笔是今天卖的、还没收盘,高低点按盘中价算,收盘后再看会更新。` : null,
    not_counted_note: [
      counts.not_closed ? `${counts.not_closed} 笔还没卖光或没有成交明细` : "",
      counts.split ? `${counts.split} 笔期间有送转(不复权行情和成本不可比)` : "",
      counts.bj ? `${counts.bj} 笔是北交所(腾讯 K 线取不到)` : "",
      counts.failed ? `${counts.failed} 笔行情没取到` : "",
    ].filter(Boolean).join(";") || null,
  };
  if (!items.length) {
    return { available: false as const, ...base, reason: "还没有能算最大浮盈浮亏的交易(要卖光了、有成交明细、能取到行情)" };
  }
  return { available: true as const, ...base, ...excursionSummary(items) };
}
