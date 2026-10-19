/**
 * 涨停样本统计:几种经典短线打法(首板 / 早封 / 尾盘封 / 连板接力 …)在近 N 个交易日里的历史表现,
 * 整体、按入场那天的情绪强弱分开、按封板时间分档。
 * 移植自 Vibe AStock v2.0.0 的 duanxian/backtest.py(策略、封板时间分档、统计口径、分环境方法不变)。
 *
 * 🔴 这是「市场现象统计」,不是策略回测,更不是打板收益:样本是前一天收盘还封在涨停板上的票(事后名单),
 *    冲板没封住的、排队买不到的、一字板根本买不进的都没区分;收益 = 前一天收盘 → 当天收盘,等权,没有滑点和成交概率。
 *    真去打板,结果只会更差。界面和给 AI 的文字都必须带着这层口径。
 * 🔴 分环境用**入场那天**(前一交易日)的情绪,不用当天的:决策发生在前一天收盘,那时看不到当天的情绪(VA v2 修过的前视偏差)。
 *
 * 原料:每个交易日一次 `cn_shortline_settled`(逐只明细);入场日情绪用 `cn_shortline_daily`(和情绪历史共用 dailySeries)。
 * 跟 VA 的不同:
 *   - 不另存结果缓存:每天的明细由取数服务快照(已收盘的日子长期缓存),重算只是毫秒级。
 *     VA 为防结果缓存返回旧数做的指纹 + 结构版本号 + 策略版本号,这里都不需要。
 *   - 窗口截止到页面选的那天;那天还没收盘就不进统计(盘中的涨跌幅收盘前还会变)。
 *   - 是否再涨停按那一天的涨跌幅制度判(VA 按现行制度,主板 ST 7 月 6 日前后会判错)。
 *   - 涨停数前二行业并列时按行业名排(VA 按出现顺序,换个数据源排序结果就变)。
 * 只读,不写盘。
 */
import { localClock } from "../../notify.ts";
import { fetchEndpoint, ServiceError, type ServiceContext } from "../../service.ts";
import { SCHEDULE_TZ, failedNote, pool } from "../schedule.ts";
import { consistencyFor, dailySeries, median, noteOf, retentionFloor, roundTo, validDate, type DayRow } from "./history.ts";

export const SAMPLE_DAYS_DEFAULT = 30;
export const SAMPLE_DAYS_MIN = 10;
export const SAMPLE_DAYS_MAX = 90;
/** 取到的交易日少于这么多就不出统计(VA 同值) */
export const MIN_DAYS = 5;
/** 入场日情绪分少于这么多天就不分环境:三等分要每档至少两天 */
export const MIN_REGIME_DAYS = 6;
const CONCURRENCY = 3;
/** 「早封」「尾盘封」的界线(HHMMSS,比的是前一天的**最后**封板时间) */
export const EARLY_SEAL = "100000";
export const LATE_SEAL = "143000";
const MAIN_SECTOR_TOP = 2;
export const SAMPLES_SOURCE = "东财昨日涨停池(每天一次 cn_shortline_settled)+ 入场日情绪读数(cn_shortline_daily),已收盘的日子读缓存";
export const SAMPLE_CAVEAT = "样本 = 前一天收盘还封在涨停板上的票(事后名单)。包含一字板等未必买得进的票,没排除排队买不到的情况;冲板没封住的不在样本里。"
  + "收益按前一天收盘到当天收盘、等权计算,没有成交模拟,不能推出真实收益或打法期望。这是市场现象统计,不是策略回测。";

export interface SampleRow {
  code: string;
  name: string;
  /** 当天涨跌幅(%) */
  ret: number;
  /** 前一天的连板数 */
  prev_boards: number;
  /** 前一天的最后封板时间(HHMMSS);缺失 = "" */
  seal_time: string;
  /** 东财行业(不是题材);缺失 = "" */
  sector: string;
  /** 当天收盘是否在涨停价;判不了 = null */
  limit_up: boolean | null;
}

interface DayCtx { main_sectors: Set<string> }

const isEarly = (r: SampleRow) => !!r.seal_time && r.seal_time <= EARLY_SEAL;
const isLate = (r: SampleRow) => !!r.seal_time && r.seal_time >= LATE_SEAL;

export interface Strategy { name: string; desc: string; filter: (r: SampleRow, c: DayCtx) => boolean }

/** 每条 = 对「前一天涨停的票」这个群体的一条过滤规则,不挑个股 */
export const STRATEGIES: Strategy[] = [
  { name: "首板打板", desc: "前一天首次涨停的全部个股,持有到当天收盘", filter: (r) => r.prev_boards === 1 },
  { name: "首板·早封", desc: "前一天首板且 10:00 前最终封板(早盘封住且之后没再炸开)", filter: (r) => r.prev_boards === 1 && isEarly(r) },
  { name: "首板·尾盘封", desc: "前一天首板但 14:30 后才最终封板(含尾盘偷袭和全天反复炸板后回封)", filter: (r) => r.prev_boards === 1 && isLate(r) },
  // 叫「涨停数前二行业」不叫「主线」:短线说的主线是题材,不是东财行业分类
  { name: "首板·涨停数前二行业", desc: "前一天首板且属于那批涨停股里家数最多的两个行业(行业 ≠ 题材)", filter: (r, c) => r.prev_boards === 1 && !!r.sector && c.main_sectors.has(r.sector) },
  { name: "连板接力", desc: "前一天已经 2 板及以上的个股,持有到当天收盘", filter: (r) => r.prev_boards >= 2 },
  { name: "高标接力", desc: "前一天 3 板及以上的高位股,持有到当天收盘", filter: (r) => r.prev_boards >= 3 },
  { name: "全体涨停", desc: "前一天涨停的全部个股(基准线,对照其它打法有没有多赚)", filter: () => true },
];

/** 首板按最后封板时间分档(HHMMSS 上界,含)。晚 = 封得晚,或中途炸开过又回封 */
export const SEAL_BUCKETS: [string, string][] = [
  ["开盘秒板", "093500"],
  ["9:35-10:00", "100000"],
  ["10:00-11:00", "110000"],
  ["11:00-14:00", "140000"],
  ["14:00后", "150500"],
];
export const SEAL_UNKNOWN = "封板时间缺失";

export const REGIMES = ["情绪强", "情绪中", "情绪弱", "环境未覆盖"] as const;
export type Regime = typeof REGIMES[number];

export interface Stats {
  sample: number;
  win_rate: number | null;
  avg: number | null;
  median: number | null;
  best: number | null;
  worst: number | null;
  /** 当天再涨停的比例;判不了的不进分母,全判不了 = null */
  limit_up_rate: number | null;
}

/** 一组样本的统计。没有样本时各项给 null,不伪装成 0 */
export function stats(rows: SampleRow[]): Stats {
  if (!rows.length) return { sample: 0, win_rate: null, avg: null, median: null, best: null, worst: null, limit_up_rate: null };
  const rets = rows.map((r) => r.ret);
  const judged = rows.filter((r) => r.limit_up !== null);
  return {
    sample: rows.length,
    win_rate: roundTo(rets.filter((x) => x > 0).length / rets.length, 3),
    avg: roundTo(rets.reduce((a, b) => a + b, 0) / rets.length, 2),
    median: roundTo(median(rets), 2),
    best: roundTo(Math.max(...rets), 2),
    worst: roundTo(Math.min(...rets), 2),
    limit_up_rate: judged.length ? roundTo(judged.filter((r) => r.limit_up).length / judged.length, 3) : null,
  };
}

/** 那一天的群体上下文:那批涨停股里家数最多的两个行业(并列按行业名) */
export function dayContext(rows: SampleRow[]): DayCtx {
  const counts = new Map<string, number>();
  for (const r of rows) if (r.sector) counts.set(r.sector, (counts.get(r.sector) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, MAIN_SECTOR_TOP).map(([s]) => s);
  return { main_sectors: new Set(top) };
}

export interface SealBucket extends Stats { bucket: string }

/** 首板按最后封板时间分档的表现。只看首板:连板股的封板时间含义不同,混进来会污染结论 */
export function sealCurve(perDay: Map<string, SampleRow[]>): SealBucket[] {
  const buckets = new Map<string, SampleRow[]>(SEAL_BUCKETS.map(([n]) => [n, []]));
  const unknown: SampleRow[] = [];
  for (const rows of perDay.values()) {
    for (const r of rows) {
      if (r.prev_boards !== 1) continue;
      if (!r.seal_time) { unknown.push(r); continue; }
      const hit = SEAL_BUCKETS.find(([, upper]) => r.seal_time <= upper) ?? SEAL_BUCKETS[SEAL_BUCKETS.length - 1]!;
      buckets.get(hit[0])!.push(r);
    }
  }
  const out: SealBucket[] = [...buckets].map(([bucket, rs]) => ({ bucket, ...stats(rs) }));
  if (unknown.length) out.push({ bucket: SEAL_UNKNOWN, ...stats(unknown) });
  return out;
}

/** 入场日情绪分:涨停家数 × (1 + 最高连板) × (1 − 炸板率)。只要相对强弱;三项缺一项就不打分 */
export function entryScore(v: DayRow["values"] | undefined): number | null {
  const lu = v?.limit_up ?? null, hb = v?.highest_board ?? null, br = v?.broken_rate ?? null;
  if (lu === null || hb === null || br === null) return null;
  return roundTo(lu * (1 + hb) * (1 - br), 1);
}

export function regimeCuts(scores: (number | null)[]): { low: number | null; high: number | null } {
  const valid = scores.filter((s): s is number => s !== null).sort((a, b) => a - b);
  if (valid.length < MIN_REGIME_DAYS) return { low: null, high: null };
  return { low: valid[Math.floor(valid.length / 3)]!, high: valid[Math.floor((valid.length * 2) / 3)]! };
}

export function regimeOf(score: number | null, cuts: { low: number | null; high: number | null }): Regime {
  if (score === null || cuts.low === null || cuts.high === null) return "环境未覆盖";
  return score <= cuts.low ? "情绪弱" : score >= cuts.high ? "情绪强" : "情绪中";
}

export interface StrategyDay { date: string; sample: number; avg: number | null; regime: Regime; equity: number }
export interface StrategyResult {
  name: string;
  desc: string;
  overall: Stats;
  by_regime: Record<Regime, Stats>;
  daily: StrategyDay[];
  /** 起点 100,每天等权满仓、按日复利。只是把每日平均串起来看走势,不是可实现的收益 */
  final_equity: number;
}

export function runStrategy(s: Strategy, perDay: Map<string, SampleRow[]>, regimes: Map<string, Regime>): StrategyResult {
  const all: SampleRow[] = [];
  const byRegime = Object.fromEntries(REGIMES.map((r) => [r, [] as SampleRow[]])) as Record<Regime, SampleRow[]>;
  const daily: StrategyDay[] = [];
  let equity = 100;
  for (const [d, rows] of [...perDay].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const ctx = dayContext(rows);
    const hit = rows.filter((r) => s.filter(r, ctx));
    all.push(...hit);
    const regime = regimes.get(d) ?? "环境未覆盖";
    byRegime[regime].push(...hit);
    const avg = hit.length ? roundTo(hit.reduce((a, r) => a + r.ret, 0) / hit.length, 2) : null;
    if (avg !== null) equity *= 1 + avg / 100;
    daily.push({ date: d, sample: hit.length, avg, regime, equity: roundTo(equity, 2) });
  }
  return {
    name: s.name, desc: s.desc, overall: stats(all),
    by_regime: Object.fromEntries(REGIMES.map((r) => [r, stats(byRegime[r])])) as Record<Regime, Stats>,
    daily, final_equity: roundTo(equity, 2),
  };
}

/** 从 `cn_shortline_settled` 的信封里按代码拼回逐只明细。没有涨跌幅的行不要 */
export function rowsOf(env: unknown): SampleRow[] {
  const evs = env && typeof env === "object" && Array.isArray((env as { evidence?: unknown }).evidence) ? (env as { evidence: unknown[] }).evidence : [];
  const by = new Map<string, Record<string, unknown>>();
  for (const x of evs) {
    if (!x || typeof x !== "object") continue;
    const { field, record_key: k, value } = x as { field?: unknown; record_key?: unknown; value?: unknown };
    if (typeof field !== "string" || !field.startsWith("settled_") || typeof k !== "string" || !k) continue;
    const o = by.get(k) ?? {};
    o[field] = value;
    by.set(k, o);
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const out: SampleRow[] = [];
  for (const [code, o] of by) {
    const ret = num(o.settled_ret);
    if (ret === null) continue;
    const lu = o.settled_limit_up;
    out.push({
      code, name: str(o.settled_name), ret, prev_boards: num(o.settled_prev_boards) ?? 1,
      seal_time: str(o.settled_seal_time), sector: str(o.settled_sector),
      limit_up: lu === "是" ? true : lu === "否" ? false : null,
    });
  }
  return out;
}

export interface ShortlineSamplesResult {
  date: string;
  days: number;
  /** 固定 market_phenomenon:让界面必须面对这层口径 */
  layer: "market_phenomenon";
  sample_caveat: string;
  available: boolean;
  reason: string | null;
  days_used: number;
  date_from: string | null;
  date_to: string | null;
  /** 取不到样本的交易日(已剔除) */
  missing_days: string[];
  /** 还没收盘、不进统计的日子 */
  unsettled_days: string[];
  regime_cuts: { low: number | null; high: number | null };
  seal_curve: SealBucket[];
  strategies: StrategyResult[];
  generated_at: string;
  gaps: string[];
  source: string;
}

export async function shortlineSamples(ctx: ServiceContext, query: Record<string, string>, signal: AbortSignal, now = new Date()): Promise<ShortlineSamplesResult> {
  const date = query.date ?? "";
  if (!validDate(date)) throw new ServiceError("bad_query", "date 要写成 YYYY-MM-DD");
  if (query.refresh !== undefined && query.refresh !== "1") throw new ServiceError("bad_query", "refresh 只能是 1");
  const days = query.days === undefined ? SAMPLE_DAYS_DEFAULT : Number(query.days);
  if (!Number.isInteger(days) || days < SAMPLE_DAYS_MIN || days > SAMPLE_DAYS_MAX) throw new ServiceError("bad_query", `days 要是 ${SAMPLE_DAYS_MIN}–${SAMPLE_DAYS_MAX} 的整数`);
  if (date > localClock(now, SCHEDULE_TZ).day) throw new ServiceError("bad_query", `${date} 还没到`);
  const refresh = query.refresh === "1";
  const gaps: string[] = [];

  // 多取一天:窗口第一天的入场日是它前一个交易日
  const { series } = await dailySeries(ctx, date, days + 1, refresh, signal, now);
  if (series.length < 2) gaps.push("上证A股指数日 K 没取到,列不出之前的交易日,只统计这一天");
  const window = series.slice(-days).map((s) => s.date);
  const entryOf = new Map(series.slice(1).map((s, i) => [s.date, series[i]!] as const));

  const oldest = retentionFloor(now);
  const fetched = await pool(window, CONCURRENCY, async (d) => {
    try {
      const r = await fetchEndpoint(ctx, { endpoint: "cn_shortline_settled", args: { date: d }, consistency: consistencyFor(d, oldest, refresh && d === date), signal });
      const env = r.envelope as { status?: string; extra?: { settled?: unknown } };
      if (env?.status === "failed") return { d, rows: null, settled: false, note: failedNote(env) || "没取到" };
      const rows = rowsOf(env);
      return { d, rows: rows.length ? rows : null, settled: env?.extra?.settled === true, note: rows.length ? "" : "明细是空的" };
    } catch (e) {
      if (signal.aborted) throw e;
      return { d, rows: null, settled: false, note: noteOf(e) };
    }
  });

  const perDay = new Map<string, SampleRow[]>();
  const missing: string[] = [], unsettled: string[] = [];
  for (const f of fetched) {
    if (!f.rows) { missing.push(f.d); continue; }
    if (!f.settled) { unsettled.push(f.d); continue; }
    perDay.set(f.d, f.rows);
  }
  const target = fetched.find((f) => f.d === date);
  if (target && !target.rows) gaps.push(`${date} 的涨停样本没取到${target.note ? `(${target.note})` : ""}`);
  const older = missing.filter((d) => d !== date);
  if (older.length) gaps.push(`${older.length} 个交易日的涨停样本没取到(东财只留最近一个月左右,更早又没缓存过的日子取不到),已剔除`);
  for (const d of unsettled) gaps.push(`${d} 还没收盘,不进统计`);

  const used = [...perDay.keys()].sort();
  const base = {
    date, days, layer: "market_phenomenon" as const, sample_caveat: SAMPLE_CAVEAT,
    days_used: used.length, date_from: used[0] ?? null, date_to: used[used.length - 1] ?? null,
    missing_days: missing, unsettled_days: unsettled, generated_at: now.toISOString(), source: SAMPLES_SOURCE,
  };
  if (used.length < MIN_DAYS) {
    return { ...base, available: false, reason: `取到样本的交易日不足(${used.length}/${window.length},至少 ${MIN_DAYS} 天)`, regime_cuts: { low: null, high: null }, seal_curve: [], strategies: [], gaps };
  }

  const scores = new Map(used.map((d) => [d, entryScore(entryOf.get(d)?.values)] as const));
  const cuts = regimeCuts([...scores.values()]);
  const unscored = [...scores.values()].filter((s) => s === null).length;
  if (cuts.low === null) gaps.push(`入场日情绪读数只有 ${used.length - unscored} 天,不足 ${MIN_REGIME_DAYS} 天,不分环境`);
  else if (unscored) gaps.push(`${unscored} 天的入场日情绪读数没取到,归「环境未覆盖」`);
  const regimes = new Map(used.map((d) => [d, regimeOf(scores.get(d) ?? null, cuts)] as const));

  return {
    ...base, available: true, reason: null, regime_cuts: cuts,
    seal_curve: sealCurve(perDay),
    strategies: STRATEGIES.map((s) => runStrategy(s, perDay, regimes)),
    gaps,
  };
}
