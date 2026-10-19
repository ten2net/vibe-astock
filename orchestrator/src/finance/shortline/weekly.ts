/**
 * 近 5 天热度与龙头谱系:每天的涨停家数 / 最高连板 / 炸板率,加上每天的最高标后来走得怎么样(「前几天的龙头现在怎么样」)。
 * 移植自 Vibe AStock v2.0.0 的 duanxian/weekly.py,口径不变:累计收益按收盘价、从上榜那天收盘算起。
 * 跟 VA 的不同:
 *   - 三项读数和情绪历史共用 dailySeries;最高标来自 `cn_shortline_structure`(同高按首封时间排、每天最多 5 只,总数另给)。
 *     所以 5 天最多 25 只走势,VA 那道「最多查 40 只」的闸用不上,去掉了。
 *   - 走势用腾讯前复权日 K;VA 用不复权,区间里有分红送转就会算出一段假跌幅。北交所腾讯不支持,如实说。
 *   - 窗口截止到页面选的那天,不是固定从今天往前数。
 * 只读,不写盘。
 */
import { localClock } from "../../notify.ts";
import { fetchEndpoint, ServiceError, type ServiceContext } from "../../service.ts";
import { klineBars } from "../abnormal.ts";
import { SCHEDULE_TZ, failedNote, pool } from "../schedule.ts";
import { consistencyFor, dailySeries, noteOf, retentionFloor, roundTo, validDate } from "./history.ts";

export const WEEKLY_DAYS = 5;
const CONCURRENCY = 3;
const KLINE_MAX_AGE_MS = 5 * 60 * 1000;
export const WEEKLY_SOURCE = "东财涨停 / 炸板 / 昨日涨停池(cn_shortline_daily、cn_shortline_structure,已收盘的日子读缓存)+ 腾讯前复权日 K(tx_kline)";

export interface Leader { code: string; name: string; boards: number | null; sector: string; first_seal: string }

/** 从 `cn_shortline_structure` 的证据里读最高标(保持端点给的顺序)和总数。 */
export function leadersOf(env: unknown): { leaders: Leader[]; total: number | null } {
  const evs = env && typeof env === "object" && Array.isArray((env as { evidence?: unknown }).evidence) ? (env as { evidence: unknown[] }).evidence : [];
  const by = new Map<string, Record<string, unknown>>();
  let total: number | null = null;
  for (const x of evs) {
    if (!x || typeof x !== "object") continue;
    const { field, record_key: k, value } = x as { field?: unknown; record_key?: unknown; value?: unknown };
    if (field === "structure_leader_total" && typeof value === "number") total = value;
    if (typeof field !== "string" || !field.startsWith("leader_") || typeof k !== "string" || !k) continue;
    by.set(k, { ...(by.get(k) ?? {}), [field]: value });
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    total,
    leaders: [...by].map(([code, o]) => ({ code, name: str(o.leader_name), boards: typeof o.leader_boards === "number" ? o.leader_boards : null,
      sector: str(o.leader_sector), first_seal: str(o.leader_first_seal) })),
  };
}

export interface Point { date: string; cum_ret: number }

/** 上榜那天收盘起到 end 的每日累计收益(%)。上榜那天没有收盘价 = 算不了,返回空。 */
export function followthrough(bars: { date: string; close: number }[], appear: string, end: string): Point[] {
  const base = bars.find((b) => b.date === appear)?.close;
  if (!base || base <= 0) return [];
  return bars.filter((b) => b.date >= appear && b.date <= end).map((b) => ({ date: b.date, cum_ret: roundTo((b.close / base - 1) * 100, 2) }));
}

/** (区间最高累计收益, 最新收盘距那个最高点的跌幅%),都按收盘价;不到两个点不算。 */
export function peakDrawdown(series: Point[]): { peak: number | null; drawdown: number | null } {
  const vals = series.map((s) => s.cum_ret).filter((v) => Number.isFinite(v));
  if (vals.length < 2) return { peak: null, drawdown: null };
  const peak = Math.max(...vals), cur = vals[vals.length - 1]!;
  if (1 + peak / 100 <= 0) return { peak: roundTo(peak, 2), drawdown: null };
  // 浮点噪声会让「就在最高点」变成 -0.00,钳到 0
  return { peak: roundTo(peak, 2), drawdown: roundTo(Math.min(((1 + cur / 100) / (1 + peak / 100) - 1) * 100, 0), 2) || 0 };
}

const isBj = (code: string) => /^(4|8|92)/.test(code);

export interface WeeklyDay {
  date: string;
  limit_up: number | null;
  highest_board: number | null;
  broken_rate: number | null;
  leaders: Leader[];
  leader_total: number | null;
  settled: boolean | null;
  note: string;
}

export interface LineageItem {
  code: string;
  name: string;
  sector: string;
  appear_date: string;
  boards_then: number | null;
  cum_return_since: number | null;
  series: Point[];
  series_warning: string;
  peak_cum_ret: number | null;
  drawdown_from_peak: number | null;
  is_current_top: boolean;
}

export interface ShortlineWeeklyResult {
  date: string;
  days: WeeklyDay[];
  lineage: LineageItem[];
  generated_at: string;
  gaps: string[];
  source: string;
}

export async function shortlineWeekly(ctx: ServiceContext, query: Record<string, string>, signal: AbortSignal, now = new Date()): Promise<ShortlineWeeklyResult> {
  const date = query.date ?? "";
  if (!validDate(date)) throw new ServiceError("bad_query", "date 要写成 YYYY-MM-DD");
  if (query.refresh !== undefined && query.refresh !== "1") throw new ServiceError("bad_query", "refresh 只能是 1");
  if (date > localClock(now, SCHEDULE_TZ).day) throw new ServiceError("bad_query", `${date} 还没到`);
  const refresh = query.refresh === "1";

  const { series, gaps } = await dailySeries(ctx, date, WEEKLY_DAYS, refresh, signal, now);
  const oldest = retentionFloor(now);
  const structures = await pool(series.map((s) => s.date), CONCURRENCY, async (d) => {
    try {
      const r = await fetchEndpoint(ctx, { endpoint: "cn_shortline_structure", args: { date: d }, consistency: consistencyFor(d, oldest, refresh && d === date), signal });
      const env = r.envelope as { status?: string };
      if (env?.status === "failed") return { leaders: [], total: null, note: failedNote(env) || "没取到" };
      return { ...leadersOf(env), note: "" };
    } catch (e) {
      if (signal.aborted) throw e;
      return { leaders: [], total: null, note: noteOf(e) };
    }
  });

  const days: WeeklyDay[] = series.map((s, i) => {
    const st = structures[i]!;
    const note = [s.note, st.note ? `最高标没取到(${st.note})` : ""].filter(Boolean).join(";");
    return { date: s.date, limit_up: s.values.limit_up ?? null, highest_board: s.values.highest_board ?? null, broken_rate: s.values.broken_rate ?? null,
      leaders: st.leaders, leader_total: st.total, settled: s.settled, note };
  });
  const last = days[days.length - 1];
  if (last && !last.leaders.length) gaps.push(`${last.date} 的最高标没取到,现在的最高标未知`);

  // 龙头谱系:按上榜先后去重
  const firsts: { leader: Leader; day: string }[] = [];
  const seen = new Set<string>();
  for (const d of days) for (const l of d.leaders) if (!seen.has(l.code)) { seen.add(l.code); firsts.push({ leader: l, day: d.date }); }
  const current = new Set(last?.leaders.map((l) => l.code) ?? []);
  const endSettled = last?.settled === true;
  const kline = refresh ? { mode: "fresh" as const } : endSettled ? { mode: "prefer_cache" as const } : { mode: "prefer_cache" as const, max_age_ms: KLINE_MAX_AGE_MS };
  const lineage = await pool(firsts, CONCURRENCY, async ({ leader: l, day }): Promise<LineageItem> => {
    const base = { code: l.code, name: l.name, sector: l.sector, appear_date: day, boards_then: l.boards, is_current_top: current.has(l.code) };
    const none = (why: string): LineageItem => ({ ...base, cum_return_since: null, series: [], series_warning: why, peak_cum_ret: null, drawdown_from_peak: null });
    if (isBj(l.code)) return none("腾讯 K 线不支持北交所,算不了走势");
    try {
      const r = await fetchEndpoint(ctx, { endpoint: "tx_kline", symbol: l.code, args: { start: day, end: date }, consistency: kline, signal });
      const pts = followthrough(klineBars(ctx, r.envelope, r.out_dir), day, date);
      if (!pts.length) return none("后续收盘行情没取到,算不了走势");
      const { peak, drawdown } = peakDrawdown(pts);
      return { ...base, cum_return_since: pts[pts.length - 1]!.cum_ret, series: pts, series_warning: "", peak_cum_ret: peak, drawdown_from_peak: drawdown };
    } catch (e) {
      if (signal.aborted) throw e;
      return none(`后续收盘行情没取到(${noteOf(e)})`);
    }
  });
  if (!endSettled && last) gaps.push(`${last.date} 还没收盘,最后一天的读数和走势收盘前还会变`);

  return { date, days, lineage, generated_at: now.toISOString(), gaps, source: WEEKLY_SOURCE };
}
