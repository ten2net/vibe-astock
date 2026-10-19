/**
 * 明日验证:复盘那晚写下「下一个交易日用哪几个市场读数检验今晚的判断」,下一场收盘后逐条对账。
 * 移植自 Vibe AStock v2.0.0 的 duanxian/verification.py(指标清单、阈值、基准发生率与超额的口径不变)。
 *
 * 这不是"明天买什么":只收市场层面读数,不涉及个股、点位或买卖时机。
 * 条件存在用户自有台账的 `verification` 种类里(一条一个读数):跟着数据根走,agent 也读得到。
 * 读数:六项来自每天一次的 `cn_shortline_daily`(和情绪历史共用同一份缓存);
 *   头部题材集中度、全市场跌停家数来自 `cn_shortline_facts`,这两项没有历史序列,不给基准发生率(VA 同)。
 * 相对 VA 的改动:
 * - 下一场 09:15 开盘竞价以后才写或改的条件标「事后」:照样对账,不计入战绩。VA 不查,事后补写会把命中率刷高。
 * - 下一场还没收盘时的对账标「暂定」,也不计入战绩。
 * - 战绩:近 60 个交易日里每晚的条件逐条对账再汇总(VA 在归因模块里汇总)。
 * - 同一晚同一个读数只能写一条(VA 允许重复,合并时后写的覆盖前面的)。
 * AI 从复盘里提炼的条件随五段式复盘一起移植。
 * run 只读;写条件走 act(整晚一起替换,没变的条目不重写,免得改理由也被当成事后改)。
 */
import type { LedgerRecord } from "../../ledger.ts";
import { localClock } from "../../notify.ts";
import { ServiceError, fetchEndpoint, ledgerCheck, ledgerList, ledgerReplace, type ServiceContext } from "../../service.ts";
import { klineBars } from "../abnormal.ts";
import { calendarFromEnvelope } from "../session.ts";
import { SCHEDULE_TZ, failedNote, pool } from "../schedule.ts";
import { DAYS_MAX, consistencyFor, dailySeries, noteOf, retentionFloor, roundTo, validDate, type DayRow } from "./history.ts";
import { DIRECTIONS, DIRECTION_LABELS, VERIFY_METRICS, type Direction, type VerifyMetric } from "./verify_metrics.ts";

export const LEDGER_KIND = "verification";
/** 基准发生率看多少个交易日(VA 同) */
export const BASELINE_DAYS = DAYS_MAX;
/** 可比的日子对少于这么多,基准发生率会误导,不给 */
export const MIN_BASELINE_SAMPLES = 12;
/** 方向常见到这个程度,判对了没什么信息量 */
export const TRIVIAL_BASELINE = 0.7;
/** 方向罕见到这个程度,判对一次含量高 */
export const RARE_BASELINE = 0.3;
export const MAX_ITEMS = VERIFY_METRICS.length;
export const REASON_MAX = 200;
/** 下一场从几点起算「已经开始」:集合竞价 09:15 起盘面就在给信息了 */
export const CUTOFF_HM = "09:15";
const CONCURRENCY = 3;
const KLINE_MAX_AGE_MS = 5 * 60 * 1000;
export const VERIFY_SOURCE = "东财涨停 / 炸板 / 昨日涨停池(每天一次 cn_shortline_daily;题材集中度、全市场跌停另取 cn_shortline_facts)";

const BY_KEY = new Map(VERIFY_METRICS.map((m) => [m.key, m]));
const isWeekday = (d: string) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w !== 0 && w !== 6; };
/** date 之后的第一个工作日(交易日历取不到时,按它保守地当成下一场) */
const firstWeekdayAfter = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  do t.setUTCDate(t.getUTCDate() + 1); while (t.getUTCDay() === 0 || t.getUTCDay() === 6);
  return t.toISOString().slice(0, 10);
};

/** 今天开不开市(交易所日历);取不到 → null。只认日期对得上今天的结果 */
async function todayIsTradingDay(ctx: ServiceContext, today: string, signal: AbortSignal): Promise<boolean | null> {
  try {
    const r = await fetchEndpoint(ctx, { endpoint: "fetch_trade_calendar", symbol: "300308", consistency: { mode: "prefer_cache", max_age_ms: KLINE_MAX_AGE_MS }, signal });
    const env = r.envelope as { status?: unknown; evidence?: { field?: string; value?: unknown; period?: string }[] };
    if (env.status === "failed" || (env.evidence ?? []).find((e) => e.field === "is_today_trading_day")?.period !== today) return null;
    return calendarFromEnvelope(env)?.is_today_trading_day ?? null;
  } catch (e) {
    if (signal.aborted) throw e;
    return null;
  }
}
const isDirection = (v: unknown): v is Direction => typeof v === "string" && (DIRECTIONS as string[]).includes(v);

export type MetricValues = Record<string, number | null>;

export interface Item {
  id: string;
  date: string;
  metric: string;
  direction: Direction;
  reason: string;
  created_at: string;
  updated_at: string;
  /** 从旧版导入、导入后没改过的条件:旧版里当初写下的时间(判「事后」用它,不用导入时刻) */
  written_at?: string;
}

export interface Baseline {
  available: boolean;
  samples: number | null;
  rates: Record<Direction, number> | null;
  reason: string | null;
}

export interface ItemResult {
  id: string;
  metric: string; label: string; unit: string; kind: VerifyMetric["kind"]; higher_is_hotter: boolean; eps: number;
  direction: Direction; direction_label: string; reason: string;
  prev_value: number | null; cur_value: number | null;
  actual: Direction | null; actual_label: string | null;
  /** 成立 / 不成立;数据取不到是 null(不算判错 —— 把"没数据"和"判错了"混为一谈会污染战绩) */
  verified: boolean | null;
  /** 下一场开盘竞价后才写或改的:照样对账,不计入战绩 */
  late: boolean;
  baseline: number | null; baseline_samples: number | null; baseline_reason: string | null; baseline_note: string;
  /** 单条超额:成立记 1、不成立记 0,减去基准发生率 */
  edge: number | null;
  written_at: string;
}

export interface Summary {
  total: number; decided: number; hit: number; rate: number | null; undecidable: number;
  baseline_covered: number; expected_rate: number | null; edge: number | null;
}

export type Check =
  | { available: false; reason: string }
  | { available: true; set_date: string; date: string; provisional: boolean; results: ItemResult[]; summary: Summary };

export interface PlanItem {
  id: string; metric: string; label: string; unit: string; kind: VerifyMetric["kind"]; higher_is_hotter: boolean; eps: number;
  direction: Direction; direction_label: string; reason: string;
  /** 复盘那天的读数:下一场跟它比 */
  base_value: number | null;
  baseline: number | null; baseline_samples: number | null; baseline_reason: string | null; baseline_note: string;
  written_at: string;
}

export interface TrackDay { set_date: string; date: string; total: number; decided: number; hit: number; excluded: number }

export interface VerifyResult {
  date: string;
  metrics: Omit<VerifyMetric, "reading" | "facts_field">[];
  directions: { key: Direction; label: string }[];
  /** 前一晚写的条件,用这一天的读数对账 */
  check: Check;
  /** 这一晚写给下一场的条件 */
  plan: { date: string; items: PlanItem[] };
  /** 近 N 个交易日每晚的条件对账汇总(事后写的、暂定的不计入) */
  track: { from: string; to: string; summary: Summary; days: TrackDay[]; excluded_late: number; excluded_provisional: number };
  generated_at: string;
  gaps: string[];
  source: string;
}

// ---------------------------------------------------------------- 纯计算(VA 同口径)

export function actualDirection(cur: number | null, prev: number | null, eps: number): Direction | null {
  if (cur === null || prev === null) return null;
  const diff = cur - prev;
  if (Math.abs(diff) <= eps + 1e-9) return "flat";   // 浮点容差:别让噪声翻转方向
  return diff > 0 ? "up" : "down";
}

/** 某个读数各方向在 rows(升序,取不到的日子值为 null)里逐日 d−1 → d 的发生频率。跨过取不到的日子不配对 */
export function directionBaseline(metric: string, rows: MetricValues[]): Baseline {
  const m = BY_KEY.get(metric);
  if (!m) return { available: false, samples: null, rates: null, reason: `未知读数 ${metric}` };
  if (!m.reading) return { available: false, samples: null, rates: null, reason: `${m.label} 没有历史序列,算不出基准发生率(不拿别的读数凑)` };
  const counts: Record<Direction, number> = { up: 0, down: 0, flat: 0 };
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const d = actualDirection(rows[i]![metric] ?? null, rows[i - 1]![metric] ?? null, m.eps);
    if (d === null) continue;
    counts[d]++;
    n++;
  }
  if (n < MIN_BASELINE_SAMPLES) return { available: false, samples: n, rates: null, reason: `只有 ${n} 对可比日,样本太少,基准发生率会误导` };
  return { available: true, samples: n, rates: { up: roundTo(counts.up / n, 3), down: roundTo(counts.down / n, 3), flat: roundTo(counts.flat / n, 3) }, reason: null };
}

/** 把基准发生率翻成一句人话 */
export function baselineNote(rate: number | null, m?: VerifyMetric): string {
  if (rate === null) return "";
  if (rate <= 1e-9) return `历史上一次都没出现过这个方向,这条几乎不可能被验证成立${m ? `(${m.label}的「持平」要求变化不超过 ${m.eps})` : ""}`;
  if (rate >= TRIVIAL_BASELINE) return "这个方向历史上本来就常发生,判对了信息量低";
  if (rate <= RARE_BASELINE) return "少见方向,判对一次含量高";
  return "";
}

function withBaseline(b: Baseline, direction: Direction, m: VerifyMetric) {
  const rate = b.available && b.rates ? b.rates[direction] : null;
  return { baseline: rate, baseline_samples: b.available ? b.samples : null, baseline_reason: b.available ? null : b.reason, baseline_note: baselineNote(rate, m) };
}

const metricView = (m: VerifyMetric) => ({ metric: m.key, label: m.label, unit: m.unit, kind: m.kind, higher_is_hotter: m.higher_is_hotter, eps: m.eps });

/** 逐条对账。`nextDay` = 被检验的那一场(用来判「事后」);认不出的读数不进结果 */
export function verifyItems(items: Item[], prev: MetricValues, cur: MetricValues, nextDay: string, baseline: (metric: string) => Baseline): ItemResult[] {
  const out: ItemResult[] = [];
  for (const it of items) {
    const m = BY_KEY.get(it.metric);
    if (!m) continue;
    const p = prev[m.key] ?? null, c = cur[m.key] ?? null;
    const actual = actualDirection(c, p, m.eps);
    const verified = actual === null ? null : actual === it.direction;
    const b = withBaseline(baseline(m.key), it.direction, m);
    out.push({
      id: it.id, ...metricView(m),
      direction: it.direction, direction_label: DIRECTION_LABELS[it.direction], reason: it.reason,
      prev_value: p, cur_value: c, actual, actual_label: actual ? DIRECTION_LABELS[actual] : null,
      verified, late: isLate(it, nextDay), ...b,
      edge: verified === null || b.baseline === null ? null : roundTo((verified ? 1 : 0) - b.baseline, 3),
      written_at: it.written_at || it.updated_at,
    });
  }
  return out;
}

/** 汇总。分母只算判定得了的条目;超额只在有基准的那批上算(实际命中率 − 按历史常态随口猜的命中率) */
export function summarize(results: Pick<ItemResult, "verified" | "baseline">[]): Summary {
  const decided = results.filter((r) => r.verified !== null);
  const hit = decided.filter((r) => r.verified).length;
  const withB = decided.filter((r) => r.baseline !== null);
  const exp = withB.length ? withB.reduce((s, r) => s + r.baseline!, 0) / withB.length : null;
  const hitB = withB.length ? withB.filter((r) => r.verified).length / withB.length : null;
  return {
    total: results.length, decided: decided.length, hit, rate: decided.length ? roundTo(hit / decided.length, 3) : null,
    undecidable: results.length - decided.length,
    baseline_covered: withB.length, expected_rate: exp === null ? null : roundTo(exp, 3),
    edge: exp === null || hitB === null ? null : roundTo(hitB - exp, 3),
  };
}

/** 下一场开盘竞价以后才写或改的条件(按最后一次修改算;旧版导入、没改过的按旧版当初写下的时间) */
export function isLate(it: Pick<Item, "updated_at" | "written_at">, nextDay: string): boolean {
  const at = Date.parse(it.written_at || it.updated_at);
  return !Number.isFinite(at) || at >= Date.parse(`${nextDay}T${CUTOFF_HM}:00+08:00`);
}

/** 从事实表信封里取那两项(没有 record_key 的同名证据) */
export function factsValuesOf(env: unknown): MetricValues {
  const evs = env && typeof env === "object" && Array.isArray((env as { evidence?: unknown }).evidence) ? (env as { evidence: unknown[] }).evidence : [];
  const out: MetricValues = {};
  for (const m of VERIFY_METRICS) {
    if (!m.facts_field) continue;
    const e = evs.find((x): x is { value: unknown } => !!x && typeof x === "object" && (x as { field?: unknown }).field === m.facts_field && (x as { record_key?: unknown }).record_key == null);
    out[m.key] = typeof e?.value === "number" && Number.isFinite(e.value) ? e.value : null;
  }
  return out;
}

/** 一天的八项:六项来自每日读数,两项来自事实表(没取就是 null) */
export function metricValues(row: Pick<DayRow, "values" | "status"> | undefined, facts: MetricValues | undefined): MetricValues {
  const out: MetricValues = {};
  for (const m of VERIFY_METRICS) {
    out[m.key] = m.reading ? (row && row.status !== "missing" ? row.values[m.reading] ?? null : null) : facts?.[m.key] ?? null;
  }
  return out;
}

/**
 * 旧版导入的条件当初写下的时间:只认带 `va:` 来源、导入后没改过(updated_at = created_at)、而且早于导入时刻的。
 * 导入后改过的按改的时间算(和自己写的一样);写下时间读不出来的也按导入时刻(= 事后)。
 */
function originalTime(r: LedgerRecord): { written_at?: string } {
  const w = typeof r.written_at === "string" ? r.written_at : "";
  const at = Date.parse(w);
  return typeof r.migrated_from === "string" && r.migrated_from.startsWith("va:") && r.updated_at === r.created_at
    && Number.isFinite(at) && at <= Date.parse(r.created_at) ? { written_at: w } : {};
}

/** 台账记录 → 条件,按日期分组。不合规的跳过并说明;同一晚同一个读数重复时留最后改的那条 */
export function itemsByDate(records: LedgerRecord[]): { byDate: Map<string, Item[]>; skipped: number } {
  const latest = new Map<string, Item>();
  let skipped = 0;
  for (const r of records) {
    const date = typeof r.date === "string" ? r.date : "";
    const metric = typeof r.metric === "string" ? r.metric : "";
    if (!validDate(date) || !BY_KEY.has(metric) || !isDirection(r.direction) || (r.reason !== undefined && typeof r.reason !== "string")) { skipped++; continue; }
    const it: Item = { id: r.id, date, metric, direction: r.direction, reason: (r.reason as string | undefined) ?? "", created_at: r.created_at, updated_at: r.updated_at, ...originalTime(r) };
    const k = `${date}|${metric}`;
    const prev = latest.get(k);
    if (prev) skipped++;
    if (!prev || it.updated_at >= prev.updated_at) latest.set(k, it);
  }
  const byDate = new Map<string, Item[]>();
  for (const it of latest.values()) byDate.set(it.date, [...(byDate.get(it.date) ?? []), it]);
  const order = new Map(VERIFY_METRICS.map((m, i) => [m.key, i]));
  for (const list of byDate.values()) list.sort((a, b) => order.get(a.metric)! - order.get(b.metric)!);
  return { byDate, skipped };
}

// ---------------------------------------------------------------- 视图

const usesFacts = (items: Item[] | undefined) => !!items?.some((it) => !BY_KEY.get(it.metric)?.reading);

export async function shortlineVerify(ctx: ServiceContext, query: Record<string, string>, signal: AbortSignal, now = new Date()): Promise<VerifyResult> {
  const date = query.date ?? "";
  if (!validDate(date)) throw new ServiceError("bad_query", "date 要写成 YYYY-MM-DD");
  if (query.refresh !== undefined && query.refresh !== "1") throw new ServiceError("bad_query", "refresh 只能是 1");
  if (date > localClock(now, SCHEDULE_TZ).day) throw new ServiceError("bad_query", `${date} 还没到`);
  const refresh = query.refresh === "1";
  const { byDate, skipped } = itemsByDate(ledgerList(ctx, LEDGER_KIND)[LEDGER_KIND] ?? []);
  const { series, gaps } = await dailySeries(ctx, date, BASELINE_DAYS, refresh, signal, now);
  if (skipped) gaps.push(`台账里有 ${skipped} 条验证条件不合规或重复,没算进来`);

  // 事实表只取用得到的日子:写了那两项的晚上和它的下一场
  const need = new Set<string>();
  series.forEach((s, i) => {
    if (!usesFacts(byDate.get(s.date))) return;
    need.add(s.date);
    if (i + 1 < series.length) need.add(series[i + 1]!.date);
  });
  const oldest = retentionFloor(now);
  const factsNotes: string[] = [];
  const factsList = await pool([...need].sort(), CONCURRENCY, async (d) => {
    try {
      const r = await fetchEndpoint(ctx, { endpoint: "cn_shortline_facts", args: { date: d }, consistency: consistencyFor(d, oldest, refresh && d === date), signal });
      if ((r.envelope as { status?: string })?.status === "failed") { factsNotes.push(`${d}:${failedNote(r.envelope) || "没取到"}`); return [d, undefined] as const; }
      return [d, factsValuesOf(r.envelope)] as const;
    } catch (e) {
      if (signal.aborted) throw e;
      factsNotes.push(`${d}:${noteOf(e)}`);
      return [d, undefined] as const;
    }
  });
  if (factsNotes.length) gaps.push(`题材集中度 / 全市场跌停没取到(${factsNotes.sort().join(";")}),相关条件判不了`);
  const facts = new Map(factsList);
  const values = series.map((s) => metricValues(s, facts.get(s.date)));

  // 基准发生率:只用写下条件那晚及以前的日子(不含被检验的那一场)
  const baselineAt = (i: number) => {
    const memo = new Map<string, Baseline>();
    return (metric: string) => {
      if (!memo.has(metric)) memo.set(metric, directionBaseline(metric, values.slice(0, i + 1)));
      return memo.get(metric)!;
    };
  };

  const days: TrackDay[] = [];
  const counted: ItemResult[] = [];
  let excludedLate = 0, excludedProvisional = 0;
  let check: Check = { available: false, reason: "列不出前一个交易日(上证A股指数日 K 没取到)" };
  for (let i = 0; i + 1 < series.length; i++) {
    const set = series[i]!, next = series[i + 1]!;
    const items = byDate.get(set.date) ?? [];
    const results = verifyItems(items, values[i]!, values[i + 1]!, next.date, baselineAt(i));
    const provisional = next.settled !== true;
    if (next.date === date) check = { available: true, set_date: set.date, date, provisional, results, summary: summarize(results) };
    if (!results.length) continue;
    const keep = results.filter((r) => !r.late && !provisional);
    excludedLate += results.filter((r) => r.late).length;
    if (provisional) excludedProvisional += results.filter((r) => !r.late).length;
    counted.push(...keep);
    const s = summarize(keep);
    days.push({ set_date: set.date, date: next.date, total: results.length, decided: s.decided, hit: s.hit, excluded: results.length - keep.length });
  }

  const last = series.length - 1;
  const planBaseline = baselineAt(last);
  const plan = (byDate.get(date) ?? []).flatMap((it): PlanItem[] => {
    const m = BY_KEY.get(it.metric);
    if (!m) return [];
    return [{ id: it.id, ...metricView(m), direction: it.direction, direction_label: DIRECTION_LABELS[it.direction], reason: it.reason,
      base_value: values[last]![m.key] ?? null, ...withBaseline(planBaseline(m.key), it.direction, m), written_at: it.written_at || it.updated_at }];
  });

  return {
    date,
    metrics: VERIFY_METRICS.map(({ reading: _r, facts_field: _f, ...m }) => m),
    directions: DIRECTIONS.map((key) => ({ key, label: DIRECTION_LABELS[key] })),
    check,
    plan: { date, items: plan },
    track: { from: series[0]!.date, to: date, summary: summarize(counted), days, excluded_late: excludedLate, excluded_provisional: excludedProvisional },
    generated_at: now.toISOString(),
    gaps,
    source: VERIFY_SOURCE,
  };
}

/**
 * 写条件:`{ action: "save", date, items: [{ metric, direction, reason? }] }`,整晚一起替换(给空数组 = 清掉这晚的)。
 * 下一场开盘竞价后就不收了 —— 看过盘再写的「判断」不算数。
 * 下一场:日 K 里 date 之后的第一根;日 K 里还没有(今天这根要开盘后才有,读的又是 5 分钟缓存)而今天开市,就是今天。
 * 日 K 和日历都取不到时,新写和改写放行(对账时按写下时间照样标「事后」),但**删除**不放行 ——
 * 删掉的条件不留痕迹,会直接从战绩里消失(审计 2026-10-11 Opus 范围 2 第 2 条)。
 */
export async function shortlineVerifyAct(ctx: ServiceContext, body: Record<string, unknown>, signal: AbortSignal, now = new Date()): Promise<{ date: string; items: Item[] }> {
  if (body.action !== "save") throw new ServiceError("bad_request", "只支持 action=save");
  const date = typeof body.date === "string" ? body.date : "";
  if (!validDate(date)) throw new ServiceError("bad_request", "date 要写成 YYYY-MM-DD");
  const today = localClock(now, SCHEDULE_TZ).day;
  if (date > today) throw new ServiceError("bad_request", `${date} 还没到`);
  if (!Array.isArray(body.items)) throw new ServiceError("bad_request", "items 要是数组");
  if (body.items.length > MAX_ITEMS) throw new ServiceError("bad_request", `最多 ${MAX_ITEMS} 条(一个读数一条),太多了反而没重点`);
  const seen = new Set<string>();
  const want = body.items.map((raw, i) => {
    const x = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
    if (!x) throw new ServiceError("bad_request", `第 ${i + 1} 条格式不对`);
    const metric = typeof x.metric === "string" ? x.metric.trim() : "";
    if (!BY_KEY.has(metric)) throw new ServiceError("bad_request", `第 ${i + 1} 条:读数只能从清单里选(${VERIFY_METRICS.map((m) => m.key).join(" / ")})`);
    if (seen.has(metric)) throw new ServiceError("bad_request", `「${BY_KEY.get(metric)!.label}」写了两条,同一晚一个读数只写一条`);
    seen.add(metric);
    if (!isDirection(x.direction)) throw new ServiceError("bad_request", `第 ${i + 1} 条:方向只能是 up(上升)/ down(下降)/ flat(持平)`);
    if (x.reason !== undefined && typeof x.reason !== "string") throw new ServiceError("bad_request", `第 ${i + 1} 条:理由要是文字`);
    const reason = ((x.reason as string | undefined) ?? "").trim();
    if (reason.length > REASON_MAX) throw new ServiceError("bad_request", `第 ${i + 1} 条:理由最多 ${REASON_MAX} 字`);
    return { date, metric, direction: x.direction, reason };
  });
  for (const w of want) {
    const why = ledgerCheck(ctx, LEDGER_KIND, w);
    if (why) throw new ServiceError("bad_request", why);
  }

  // 下一场已经开盘竞价:不收
  let bars: string[] = [];
  try {
    const k = await fetchEndpoint(ctx, { endpoint: "tx_kline", symbol: "sh000002", args: { count: 100 }, consistency: { mode: "prefer_cache", max_age_ms: KLINE_MAX_AGE_MS }, signal });
    bars = klineBars(ctx, k.envelope, k.out_dir).map((b) => b.date);
  } catch (e) {
    if (signal.aborted) throw e;
  }
  let next = bars.find((d) => d > date);
  // 今天的日 K 开盘后才有:今天要不要算问日历(工作日也可能休市,比如国庆)
  const askToday = isWeekday(today) && (date === today || (!next && date < today));
  const todayOpen = askToday ? await todayIsTradingDay(ctx, today, signal) : null;
  if (date === today && todayOpen === false) throw new ServiceError("bad_request", `${date} 休市;条件写在复盘的那个交易日上`);
  if (bars.length && !bars.includes(date) && !(date === today && isWeekday(date))) throw new ServiceError("bad_request", `${date} 不是交易日;条件写在复盘的那个交易日上`);
  if (!next && date < today && todayOpen === true) next = today;
  const late = (d: string) => isLate({ updated_at: now.toISOString() }, d);
  if (next && late(next)) throw new ServiceError("bad_request", `${next} 已经开盘,${date} 那晚的条件不能再写或改了(看过盘再写的判断不算数)`);
  // 下一场开没开始说不准:日 K 没取到,或日 K 里还没有下一场、日历也没取到
  const unsure = !next && date < today && (bars.length === 0 || (isWeekday(today) && todayOpen === null));

  const existing = (ledgerList(ctx, LEDGER_KIND)[LEDGER_KIND] ?? []).filter((r) => r.date === date);
  const keepMetrics = new Set(want.map((w) => w.metric));
  const removes = existing.some((r) => !keepMetrics.has(String(r.metric)));
  if (unsure && removes && late(firstWeekdayAfter(date))) {
    throw new ServiceError("bad_request", `交易日历和日 K 暂时都没取到,确认下一场还没开盘之前不能删 ${date} 那晚的条件(删掉的不留记录);稍后再试`);
  }
  // 🔴 整晚一次落盘(审计 2026-10-11 Codex 范围 2 第 4 条):原来逐条删、逐条加,删完、加之前出错或进程退出,这晚就永久残缺
  const byMetric = new Map<string, LedgerRecord>();
  for (const r of existing) if (!byMetric.has(String(r.metric))) byMetric.set(String(r.metric), r);
  const records = want.map((w): Record<string, unknown> => {
    const keep = byMetric.get(w.metric);
    if (!keep) return w;
    // 没变就原样交回:updated_at 不动,下一场开盘后才重存一遍的条目不会被当成「事后改」
    const same = keep.direction === w.direction && (keep.reason ?? "") === w.reason && !ledgerCheck(ctx, LEDGER_KIND, keep);
    return same ? keep : { id: keep.id, ...w };
  });
  ledgerReplace(ctx, { kind: LEDGER_KIND, match: (r) => r.date === date, records });
  return { date, items: itemsByDate(ledgerList(ctx, LEDGER_KIND)[LEDGER_KIND] ?? []).byDate.get(date) ?? [] };
}
