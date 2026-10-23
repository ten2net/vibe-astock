/**
 * 实时动态 · 分时资金「先横盘、后稳步拉升」榜(当日,前 20)。
 *
 * 口径(全部客观公开数据,非推荐、非预测、不评分):
 *  - 扫描名单 = 全市场**资金流榜前 N**(主力/大单净额降序):新浪 hs_a 榜为主,
 *    东财主力净流入榜兜底(有的网络 push2 被墙,新浪榜是替代通道);
 *  - 逐只取当日**分钟资金累计曲线**:腾讯分钟线按「分钟涨跌方向 × 成交额增量」估算
 *    累计主动净买入(DDX 近似;东财分钟资金流存在时优先,那是真大单口径);
 *  - 曲线统一换算成 bp 再比形态:有流通市值按流通市值(万分比),没有按当日成交额
 *    (估算通道没有市值,bp 阈值相应放宽)——不然大盘股波动天然压过小票;
 *  - 形态 = **横盘段**(累计曲线带宽 ≤ 阈值,至少 FLAT_MIN_MINUTES 分钟)
 *    接**拉升段**(其后到最新:涨幅 ≥ 阈值、上涨分钟占比 ≥ UP_RATIO、
 *    且最后一个分钟点仍在向上);
 *  - 按 score = 拉升幅度 − 0.5×横盘带宽(+横盘时长小幅加成)取前 20。
 *
 * 数据约束:盘中分钟曲线随时间变长,**早盘点数不够时不硬算**(最少 MIN_POINTS 个分钟点),
 * 页面相应提示;收盘后为全天形态。结果进程内缓存 RESULT_TTL_MS,不每轮打上游。
 */
import { fetchEndpoint, type FetchResult, type ServiceContext } from "../../service.ts";
import { pool } from "../schedule.ts";

export interface FflowPoint { time: string; main: number | null }
export interface FflowCandidate {
  code: string; name: string; price: number | null; pct: number | null;
  main_net: number | null; float_cap: number | null;
  points: number;
  flat_minutes: number; rise_minutes: number;
  flat_band_bp: number; rise_bp: number; up_ratio: number; score: number;
  series_bp: number[];
}
export interface FflowView {
  day: string | null;
  as_of: string | null;
  /** 这轮实际走的数据通道(展示给用户) */
  source_label: string;
  poll_ms: number;
  total_scanned: number;
  with_data: number;
  matched: number;
  stocks: FflowCandidate[];
  notes: string[];
}

// —— 形态参数(bp = 万分比;分母是流通市值或当日成交额,见 detectSidewaysRise)——
export const UP_RATIO = 0.6;          // 拉升段上涨桶占比下限
const UNIVERSE_N = 150;
const TOP_N = 20;
const RESULT_TTL_MS = 45_000;
const MINUTE_STALE_MS = 150_000;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * 横盘→拉升识别(纯函数,便于单测)。**相对自身曲线**的形态判定:
 * 「横盘」不看绝对窄幅(分钟方向估算的开盘噪声就有几百 bp,绝对口径谁也过不了),
 * 看**日内主要涨幅是不是在后半段稳稳地创出来的**。
 *
 * 判定(曲线已换算成 bp,见 denomYuan):
 *  - R = 全日振幅;R < MIN_RANGE_BP → 没有值得看的资金动作,拒;
 *  - 分段点 b:前段带宽 ≤ max(FLAT_ABS_BP, FLAT_RANGE_RATIO×R)(横住了)
 *    且 b 落在日内低位区(≤ min + LOWS_RANGE_RATIO×R)(拉升从低位起);
 *  - 后段:涨幅 ≥ RISE_RANGE_RATIO×R(日内主要涨幅在后段)、上涨桶占比 ≥ UP_RATIO(稳)、
 *    末桶仍向上、且**后段斜率 ≥ 前段斜率 × SLOPE_RATIO**(必须有节奏切换 ——
 *    从开盘一路匀速上涨的票,前段带宽随涨幅一起放大,靠斜率比拒掉);
 *  - score = 后段涨幅(bp) − 0.5×前段带宽 + 横盘时长小幅加成,取最优 b。
 */
export const MIN_RANGE_BP = 30;          // 全日振幅下限(没有这个幅度谈不上「拉升」)
export const FLAT_ABS_BP = 20;           // 前段带宽的绝对上限(覆盖小 R 的日子)
export const FLAT_RANGE_RATIO = 0.30;    // 前段带宽 ≤ 30% 全日振幅(相对口径)
export const LOWS_RANGE_RATIO = 0.35;    // 分段点须落在日内低位区
export const RISE_RANGE_RATIO = 0.55;    // 后段涨幅 ≥ 55% 全日振幅
export const SLOPE_RATIO = 1.8;          // 后段斜率 / 前段斜率的切换倍数
export const MIN_BARS = 10;              // 最少桶数(早盘不够不硬算)
export const FLAT_MIN_BARS = 3;          // 横盘至少 3 桶
export const RISE_MIN_BARS = 3;          // 拉升至少 3 桶

export function detectSidewaysRise(series: readonly FflowPoint[], denomYuan: number | null, barMinutes = 1):
  Omit<FflowCandidate, "code" | "name" | "price" | "pct" | "main_net" | "float_cap"> | null {
  const denom = denomYuan;
  if (!denom || !(denom > 0)) return null;
  const curve: number[] = [];
  for (const p of series) {
    const m = num(p.main);
    if (m === null) continue;
    curve.push((m / denom) * 1e4);
  }
  const n = curve.length;
  if (n < MIN_BARS) return null;
  const lo = Math.min(...curve), hi = Math.max(...curve);
  const range = hi - lo;
  if (range < MIN_RANGE_BP) return null;
  if (curve[n - 1]! - curve[n - 2]! < 0) return null;   // 末桶已回落,不算「正在稳步拉升」
  const preMin: number[] = [curve[0]!], preMax: number[] = [curve[0]!];
  for (let i = 1; i < n; i++) {
    preMin.push(Math.min(preMin[i - 1]!, curve[i]!));
    preMax.push(Math.max(preMax[i - 1]!, curve[i]!));
  }
  const deltaUp = (i: number) => (curve[i]! - curve[i - 1]! >= 0 ? 1 : 0);
  const suffixUp: number[] = new Array(n).fill(0);
  for (let i = n - 1; i >= 1; i--) suffixUp[i - 1] = suffixUp[i]! + deltaUp(i);

  let best: { score: number; b: number; band: number; rise: number; up: number } | null = null;
  for (let b = FLAT_MIN_BARS - 1; b <= n - RISE_MIN_BARS - 1; b++) {
    const band = preMax[b]! - preMin[b]!;
    if (band > Math.max(FLAT_ABS_BP, FLAT_RANGE_RATIO * range)) continue;  // 前段不横盘
    if (curve[b]! > lo + LOWS_RANGE_RATIO * range) continue;               // 分段点不在低位区
    const rise = curve[n - 1]! - curve[b]!;
    if (rise < RISE_RANGE_RATIO * range) continue;                         // 日内主要涨幅不在后段
    const earlySlope = (curve[b]! - curve[0]!) / (b + 1);
    const lateSlope = (curve[n - 1]! - curve[b]!) / (n - 1 - b);
    if (lateSlope < SLOPE_RATIO * earlySlope + 0.02) continue;             // 没有横盘→拉升的节奏切换
    const upRatio = suffixUp[b]! / (n - 1 - b);
    if (upRatio < UP_RATIO) continue;                                      // 后段回吐桶太多,不"稳"
    const score = rise - 0.5 * band + Math.min(b + 1, 18) * 0.05;
    if (!best || score > best.score) best = { score, b, band, rise, up: upRatio };
  }
  if (!best) return null;
  return {
    points: n,
    flat_minutes: (best.b + 1) * barMinutes,
    rise_minutes: (n - 1 - best.b) * barMinutes,
    flat_band_bp: Math.round(best.band * 100) / 100,
    rise_bp: Math.round(best.rise * 100) / 100,
    up_ratio: Math.round(best.up * 100) / 100,
    score: Math.round(best.score * 100) / 100,
    series_bp: curve.slice(-60).map((v) => Math.round(v * 100) / 100),
  };
}

// ---------------------------------------------------------------- 取数

type Fetch = (ctx: ServiceContext, req: Parameters<typeof fetchEndpoint>[1]) => Promise<Pick<FetchResult, "envelope">>;

interface RankRow { code: string; name: string; price: number | null; pct: number | null; main_net: number | null; float_cap: number | null }

const extraOf = (env: unknown): Record<string, unknown> => {
  const e = (env as { extra?: unknown } | null)?.extra;
  return e && typeof e === "object" && !Array.isArray(e) ? e as Record<string, unknown> : {};
};

function rankRows(env: unknown): RankRow[] {
  const rows = extraOf(env).rows;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      code: str(o.code), name: str(o.name) || str(o.code),
      price: num(o.price), pct: num(o.pct),
      main_net: num(o.main_net), float_cap: num(o.float_cap),
    };
  }).filter((r) => /^\d{6}$/.test(r.code));
}

function minuteSeries(env: unknown): { series: FflowPoint[]; fetchedAt: string | null; dayAmount: number | null; barMinutes: number } {
  const ms = extraOf(env).minute_series;
  const fetchedAt = str((env as { fetched_at?: unknown })?.fetched_at ?? "") || null;
  const dayAmount = num(extraOf(env).day_amount);
  const barMinutes = num(extraOf(env).bar_minutes) ?? 1;
  if (!Array.isArray(ms)) return { series: [], fetchedAt, dayAmount, barMinutes };
  return {
    series: ms.map((p) => {
      const o = p as Record<string, unknown>;
      return { time: str(o.time), main: num(o.main) };
    }),
    fetchedAt,
    dayAmount,
    barMinutes,
  };
}

const cache = new Map<string, { at: number; result: FflowView }>();

/**
 * 数据通道:主通道 新浪资金榜 + 腾讯分钟线估算(本部署实测可达);兜底 东财资金流
 * (push2 在部分网络被墙,通的时候是真正的大单口径)。两条通道的 extra.rows /
 * extra.minute_series schema 一致,识别层不区分。
 */
interface FflowChannel { rank: string; series: string; label: string }
const CHANNELS: readonly FflowChannel[] = [
  { rank: "sina_market_money_rank", series: "tx_minute_today", label: "新浪资金流榜 + 腾讯分钟线估算" },
  { rank: "em_market_main_net_rank", series: "em_fund_flow_minute", label: "东财资金流(分钟大单口径)" },
];

export async function shortlineFflow(ctx: ServiceContext, _query: Record<string, string>, signal: AbortSignal,
  deps: { fetch?: Fetch; now?: () => number } = {}): Promise<FflowView> {
  const now = deps.now ?? Date.now;
  const fetch = deps.fetch ?? ((c: ServiceContext, req: Parameters<typeof fetchEndpoint>[1]) => fetchEndpoint(c, req));
  const hit = cache.get(ctx.dataRoot);
  if (hit && now() - hit.at < RESULT_TTL_MS) return hit.result;

  const notes: string[] = [];
  let universe: RankRow[] = [];
  let channel: FflowChannel = CHANNELS[0]!;
  for (const ch of CHANNELS) {
    try {
      const rankEnv = await fetch(ctx, { endpoint: ch.rank, args: { top_n: UNIVERSE_N }, consistency: { mode: "fresh" }, signal });
      const rows = rankRows(rankEnv.envelope).slice(0, UNIVERSE_N);
      if (rows.length) { universe = rows; channel = ch; break; }
    } catch { /* 通道不通,试下一条 */ }
  }
  if (!universe.length) throw new Error("资金流榜取不到(新浪与东财两个通道都不通),稍后再试");

  const staleMinute = (fetchedAt: string | null) => {
    if (!fetchedAt) return true;
    const t = Date.parse(fetchedAt.replace(" ", "T"));
    return !Number.isFinite(t) || now() - t > MINUTE_STALE_MS;
  };

  const scanned = await pool(universe, 8, async (row) => {
    let env = await fetch(ctx, { endpoint: channel.series, symbol: row.code, signal });
    let { series, fetchedAt, dayAmount, barMinutes } = minuteSeries(env.envelope);
    if (staleMinute(fetchedAt)) {
      env = await fetch(ctx, { endpoint: channel.series, symbol: row.code, consistency: { mode: "fresh" }, signal });
      ({ series, fetchedAt, dayAmount, barMinutes } = minuteSeries(env.envelope));
    }
    if (!series.length) return null;   // 无分钟数据:不计入 with_data
    // 分母:优先流通市值(bp 口径),估算通道没有市值就用当日成交额
    const denom = row.float_cap && row.float_cap > 0 ? row.float_cap
      : dayAmount && dayAmount > 0 ? dayAmount : null;
    if (!denom) return { row, pat: null, fetchedAt: fetchedAt ?? "" };
    const pat = detectSidewaysRise(series, denom, barMinutes);
    return { row, pat, fetchedAt: fetchedAt ?? "" };
  });

  const withData = scanned.filter((s): s is NonNullable<typeof s> => s !== null);
  const hits = withData.flatMap((s) => (s.pat ? [{ ...s.row, ...s.pat }] : []));
  const stocks = hits.sort((a, b) => b.score - a.score).slice(0, TOP_N);
  const asOf = withData.map((s) => s.fetchedAt).sort().at(-1) ?? null;
  const day = asOf ? asOf.slice(0, 10) : null;
  notes.push(`名单:资金流榜(主力/大单净额)前 ${universe.length} 只;通道 ${channel.label};有分钟数据 ${withData.length} 只,命中形态 ${hits.length} 只,取前 ${TOP_N}`);
  if (!hits.length) notes.push(`分钟数据不够 ${MIN_BARS} 桶或形态未出现 —— 早盘数据短时常见,盘中稍后再看`);

  const result: FflowView = {
    day, as_of: asOf, source_label: channel.label, poll_ms: 60_000,
    total_scanned: universe.length, with_data: withData.length, matched: stocks.length,
    stocks, notes,
  };
  cache.set(ctx.dataRoot, { at: now(), result });
  return result;
}
