/**
 * 情绪历史:复盘那天的六项情绪读数在近 N 个交易日里算什么位置、跟前一天比有什么不同、近几天怎么走。
 * 移植自 Vibe AStock v2.0.0 的 duanxian/stats_context.py(分位定义、阈值、噪声门槛不变)。
 *
 * 原料:每个交易日一次 `cn_shortline_daily`(取数层算好的六项,带证据)。
 *   🔴 东财的涨停 / 炸板 / 昨日涨停池只留最近一个月左右 —— 更早的日子靠取数服务的快照:
 *      已收盘那天的结果长期缓存,所以历史越用越长;没收盘的那天端点标 partial,快照层不存,每次现取。
 *   🔴 超过东财保留期的日子**只读缓存、不发请求**:没缓存过就是取不到,每次打开都去白问一遍
 *      会让每次复盘多等一分多钟(VA 实测 82 秒;2026-10-10 实测保留期 29 个日历日)。
 *   上证A股指数日 K 只用来列出交易日(和异动接近度、涨停分档共用同一份缓存)。
 * 只读,不写盘(快照是取数服务自己写的)。
 */
import { localClock } from "../../notify.ts";
import { fetchEndpoint, ServiceError, type ServiceContext } from "../../service.ts";
import { klineBars } from "../abnormal.ts";
import { SCHEDULE_TZ, failedNote, pool } from "../schedule.ts";

export type ReadingKind = "count" | "rate" | "pct";

export interface ReadingDef {
  key: string;
  label: string;
  unit: string;
  kind: ReadingKind;
  /** 高分位怎么读:涨停家数高 = 热,炸板率高 = 冷 */
  higher_is_hotter: boolean;
  /** 跟前一天比的噪声门槛(同单位):变化不超过它不算「不同」,否则每天几十条噪声等于没比 */
  diff_eps: number;
  /** 取 `cn_shortline_daily` 证据的哪个字段 */
  field: string;
  record_key?: string;
}

export const READINGS: ReadingDef[] = [
  { key: "limit_up", label: "涨停家数", unit: "家", kind: "count", higher_is_hotter: true, diff_eps: 8, field: "limit_up_count" },
  { key: "highest_board", label: "最高连板", unit: "板", kind: "count", higher_is_hotter: true, diff_eps: 0.5, field: "ladder_highest" },
  { key: "broken_rate", label: "炸板率", unit: "", kind: "rate", higher_is_hotter: false, diff_eps: 0.08, field: "broken_rate" },
  { key: "money_effect", label: "赚钱效应中位数", unit: "%", kind: "pct", higher_is_hotter: true, diff_eps: 1.0, field: "money_effect_median_ret" },
  { key: "deep_loss", label: "跌超5%家数", unit: "家", kind: "count", higher_is_hotter: false, diff_eps: 8, field: "loss_deep5_count" },
  { key: "promotion_1to2", label: "1进2 晋级率", unit: "", kind: "rate", higher_is_hotter: true, diff_eps: 0.08, field: "promotion_rate", record_key: "1进2" },
];

/** 少于这么多天不给分位 —— 样本不够时「分位」是误导 */
export const MIN_SAMPLES = 10;
/** 到这个分位就标出来(两头都算) */
export const HIGH = 0.85;
export const LOW = 0.15;
export const DAYS_DEFAULT = 30;
export const DAYS_MIN = 5;
export const DAYS_MAX = 60;
/** 第一次要把每天算一遍(每天约 4 次东财请求):并发压低,别把东财打到限流 */
const CONCURRENCY = 3;
const KLINE_MAX_AGE_MS = 5 * 60 * 1000;
/** 东财涨停 / 炸板 / 昨日涨停池能往回查多少个日历日(2026-10-10 实测 29 天,留一天余量)。更早的只读缓存 */
export const SOURCE_RETENTION_DAYS = 28;
export const HISTORY_SOURCE = "东财涨停 / 炸板 / 昨日涨停池(每天一次 cn_shortline_daily,已收盘的日子读缓存)";

export type Values = Record<string, number | null>;

export interface DayRow {
  date: string;
  values: Values;
  /** ok = 六项都有;partial = 缺几项或没收盘;missing = 一项都没取到(不进分位) */
  status: "ok" | "partial" | "missing";
  /** 端点说这天已收盘(数字定稿)。没收盘 = false;没取到或没说 = null */
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

export interface DiffChange {
  key: string; label: string; unit: string; kind: ReadingKind;
  prev: number; cur: number; delta: number;
  /** 变热还是变冷(按 higher_is_hotter 翻译方向) */
  hotter: boolean;
}
export type HistoryDiff =
  | { available: false; reason: string }
  | { available: true; date: string; prev_date: string; changes: DiffChange[]; unchanged_count: number };

export interface ShortlineHistoryResult {
  date: string;
  days: number;
  readings: Omit<ReadingDef, "field" | "record_key">[];
  /** 升序;missing 的日子也列出来(界面要能说哪天没取到) */
  series: DayRow[];
  context: HistoryContext;
  diff: HistoryDiff;
  generated_at: string;
  gaps: string[];
  source: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const validDate = (d: string) => DATE_RE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
/** 和 Python round(x, n) 对齐到同一个十进制位(按 double 的真实值舍入) */
export const roundTo = (x: number, n: number) => Number(x.toFixed(n));

/** value 在 hist 里的分位(0~1):小于等于它的比例。样本不足或值缺失给 null */
export function percentile(value: number | null, hist: (number | null)[]): number | null {
  if (value === null) return null;
  const vals = hist.filter((v): v is number => v !== null);
  if (vals.length < MIN_SAMPLES) return null;
  return roundTo(vals.filter((v) => v <= value).length / vals.length, 3);
}

export function median(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** 复盘那天各项 + 在之前那些天里的分位 + 两头标记。`rows` 升序、只含有数的日子,最后一行应是那天 */
export function contextFor(date: string, rows: { date: string; values: Values }[]): HistoryContext {
  if (!rows.length) return { available: false, reason: "历史读数一天都没有" };
  const today = rows[rows.length - 1]!;
  if (today.date !== date) return { available: false, reason: `${date} 的读数没取到` };
  const past = rows.slice(0, -1);   // 分位只跟之前比,不含当天自己
  const items = READINGS.map((r): ContextItem => {
    const cur = today.values[r.key] ?? null;
    const hist = past.map((h) => h.values[r.key] ?? null).filter((v): v is number => v !== null);
    const pct = percentile(cur, hist);
    let extreme: ContextItem["extreme"] = null;
    if (pct !== null) {
      if (pct >= HIGH) extreme = r.higher_is_hotter ? "偏热" : "偏冷";
      else if (pct <= LOW) extreme = r.higher_is_hotter ? "偏冷" : "偏热";
    }
    return {
      key: r.key, label: r.label, unit: r.unit, kind: r.kind, higher_is_hotter: r.higher_is_hotter,
      value: cur, percentile: pct, extreme,
      hist_min: hist.length ? Math.min(...hist) : null,
      hist_max: hist.length ? Math.max(...hist) : null,
      hist_median: hist.length ? roundTo(median(hist), 2) : null,
    };
  });
  // 一项都不在两头,说明是平淡的一天 —— 这本身也是信息
  return { available: true, date, sample_days: past.length, min_samples: MIN_SAMPLES, items, extreme_count: items.filter((x) => x.extreme).length };
}

/** 跟上一个有数的交易日比,只列超过噪声门槛的变化;按「变化 ÷ 门槛」从大到小排 */
export function diffFor(date: string, rows: { date: string; values: Values }[]): HistoryDiff {
  if (rows.length < 2) return { available: false, reason: "历史不足两天,没法比较" };
  const today = rows[rows.length - 1]!, prev = rows[rows.length - 2]!;
  if (today.date !== date) return { available: false, reason: `${date} 的读数没取到` };
  const changes: DiffChange[] = [];
  for (const r of READINGS) {
    const a = prev.values[r.key] ?? null, b = today.values[r.key] ?? null;
    if (a === null || b === null) continue;
    const delta = b - a;
    // 容差:0.507 − 0.427 在浮点里是 0.08000000000000002,正好等于门槛也该算噪声(VA 原版这里会误列)
    if (Math.abs(delta) <= r.diff_eps + 1e-9) continue;
    changes.push({ key: r.key, label: r.label, unit: r.unit, kind: r.kind, prev: a, cur: b, delta: roundTo(delta, 2), hotter: delta > 0 === r.higher_is_hotter });
  }
  const eps = new Map(READINGS.map((r) => [r.key, r.diff_eps]));
  changes.sort((x, y) => Math.abs(y.delta) / Math.max(eps.get(y.key)!, 1e-9) - Math.abs(x.delta) / Math.max(eps.get(x.key)!, 1e-9));
  return { available: true, date, prev_date: prev.date, changes, unchanged_count: READINGS.length - changes.length };
}

/** 从 `cn_shortline_daily` 的信封里按字段取六项。证据就是 AI 那边能引用的同一份数 */
export function valuesOf(env: unknown): Values {
  const evs = env && typeof env === "object" && Array.isArray((env as { evidence?: unknown }).evidence) ? (env as { evidence: unknown[] }).evidence : [];
  const out: Values = {};
  for (const r of READINGS) {
    const e = evs.find((x): x is { value: unknown } => !!x && typeof x === "object"
      && (x as { field?: unknown }).field === r.field && ((x as { record_key?: unknown }).record_key ?? undefined) === r.record_key);
    out[r.key] = typeof e?.value === "number" && Number.isFinite(e.value) ? e.value : null;
  }
  return out;
}

/** 东财那几张池能现查的最早一天;更早的只读缓存 */
export function retentionFloor(now: Date): string {
  const today = localClock(now, SCHEDULE_TZ).day;
  return new Date(Date.parse(`${today}T00:00:00Z`) - SOURCE_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/** 取某天的取数方式:显式刷新的那天现取;超过保留期的只读缓存;其余优先缓存(没收盘的那天快照层本来就不存) */
export function consistencyFor(d: string, oldest: string, fresh: boolean) {
  return fresh ? { mode: "fresh" as const } : d < oldest ? { mode: "cache_only" as const } : { mode: "prefer_cache" as const };
}

export const noteOf = (e: unknown) => e instanceof ServiceError && e.code === "no_snapshot" ? "超过东财保留期,当时也没缓存" : e instanceof Error ? e.message.slice(0, 60) : "没取到";

/**
 * 那天和它之前 days−1 个交易日(升序)。交易日 = 上证A股指数日 K 里早于那天的日子 + 那天本身
 * (那天是不是交易日由各端点判,不是就取不到并说明)。日 K 取不到时只有那天,gap 说明。
 */
export async function tradeWindow(ctx: ServiceContext, date: string, days: number, signal: AbortSignal): Promise<{ window: string[]; gap: string | null }> {
  if (days <= 1) return { window: [date], gap: null };
  let before: string[] = [];
  try {
    const k = await fetchEndpoint(ctx, { endpoint: "tx_kline", symbol: "sh000002", args: { count: 100 }, consistency: { mode: "prefer_cache", max_age_ms: KLINE_MAX_AGE_MS }, signal });
    before = klineBars(ctx, k.envelope, k.out_dir).map((b) => b.date).filter((d) => d < date).slice(-(days - 1));
  } catch (e) {
    if (signal.aborted) throw e;
  }
  return { window: [...before, date], gap: before.length ? null : "上证A股指数日 K 没取到,列不出之前的交易日,只看这一天" };
}

/**
 * 那天和它之前 days−1 个交易日的六项读数(升序;取不到的日子也列出来,值是 null)。情绪历史和明日验证共用。
 * `refresh` 只重取那一天。
 */
export async function dailySeries(ctx: ServiceContext, date: string, days: number, refresh: boolean, signal: AbortSignal, now: Date): Promise<{ series: DayRow[]; gaps: string[] }> {
  const oldest = retentionFloor(now);
  const gaps: string[] = [];
  const { window, gap } = await tradeWindow(ctx, date, days, signal);
  if (gap) gaps.push(gap);

  const series = await pool(window, CONCURRENCY, async (d): Promise<DayRow> => {
    try {
      const r = await fetchEndpoint(ctx, { endpoint: "cn_shortline_daily", args: { date: d }, consistency: consistencyFor(d, oldest, refresh && d === date), signal });
      // ⚠️ 端点自己的说明(degraded / settled)在 extra 里,信封顶层没有
      const env = r.envelope as { status?: string; extra?: { degraded?: unknown; settled?: unknown } };
      const settled = typeof env?.extra?.settled === "boolean" ? env.extra.settled : null;
      if (env?.status === "failed") return { date: d, values: valuesOf(null), status: "missing", settled: null, note: failedNote(env) || "没取到", cached: r.cached, fetched_at: r.fetched_at };
      const values = valuesOf(env);
      const lacks = READINGS.filter((x) => values[x.key] === null).map((x) => x.label);
      const note = [typeof env?.extra?.degraded === "string" ? env.extra.degraded : "", lacks.length ? `缺 ${lacks.join("、")}` : ""].filter(Boolean).join(";");
      const status = lacks.length === READINGS.length ? "missing" : lacks.length || env?.status === "partial" ? "partial" : "ok";
      return { date: d, values, status, settled, note, cached: r.cached, fetched_at: r.fetched_at };
    } catch (e) {
      if (signal.aborted) throw e;
      return { date: d, values: valuesOf(null), status: "missing", settled: null, note: noteOf(e), cached: false, fetched_at: null };
    }
  });

  const older = series.filter((s) => s.status === "missing" && s.date !== date).length;
  if (older) gaps.push(`${older} 个交易日没取到读数(东财这几张池只留最近一个月左右,更早又没缓存过的日子取不到),不进统计`);
  const target = series[series.length - 1]!;
  if (target.status === "missing") gaps.unshift(`${date} 的读数没取到${target.note ? `(${target.note})` : ""}`);
  return { series, gaps };
}

export async function shortlineHistory(ctx: ServiceContext, query: Record<string, string>, signal: AbortSignal, now = new Date()): Promise<ShortlineHistoryResult> {
  const date = query.date ?? "";
  if (!validDate(date)) throw new ServiceError("bad_query", "date 要写成 YYYY-MM-DD");
  if (query.refresh !== undefined && query.refresh !== "1") throw new ServiceError("bad_query", "refresh 只能是 1");
  const days = query.days === undefined ? DAYS_DEFAULT : Number(query.days);
  if (!Number.isInteger(days) || days < DAYS_MIN || days > DAYS_MAX) throw new ServiceError("bad_query", `days 要是 ${DAYS_MIN}–${DAYS_MAX} 的整数`);
  if (date > localClock(now, SCHEDULE_TZ).day) throw new ServiceError("bad_query", `${date} 还没到`);
  const { series, gaps } = await dailySeries(ctx, date, days, query.refresh === "1", signal, now);
  const rows = series.filter((s) => s.status !== "missing");
  return {
    date, days,
    readings: READINGS.map(({ field: _f, record_key: _k, ...r }) => r),
    series,
    context: contextFor(date, rows),
    diff: diffFor(date, rows),
    generated_at: now.toISOString(),
    gaps,
    source: HISTORY_SOURCE,
  };
}
