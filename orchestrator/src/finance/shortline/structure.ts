/**
 * 结构变化:图上这个断点,是市场变了、数据源变了,还是规则变了。
 * 移植自 Vibe AStock v2.0.0 的 duanxian/drift.py(窗口、阈值、中位数口径不变),三类分开看:
 *   ① 数据源:四张池子的上游字段清单变没变(变了 = 源改了,跟市场无关);
 *   ② 市场:最近 10 个交易日 vs 之前 20 个交易日的涨停结构(涨停家数、各涨跌幅制度占比);
 *   ③ 制度:**只收人工登记的**(台账 regime_event)。从数据反推「这天大概改了规则」是猜,猜错会把市场波动当成制度事件。
 * 只报「这里不连续」,不报「所以该怎么改打法」。
 *
 * 原料:每个交易日一次 `cn_shortline_structure`(已收盘的日子长期缓存)。跟 VA 的不同:
 *   - 不靠本地归档:东财只留一个月左右,历史靠快照越积越长;刚装好时之前那个窗口天数可能不够,如实说。
 *   - 窗口按交易日固定(最近 10 个交易日 / 再往前 20 个),取不到或没收盘的日子从各自窗口里剔除;VA 按「归档里有的日子」排窗口。
 *   - 制度构成按当天的涨跌幅规则归类(端点里做);VA 老归档回退现行规则。
 *   - 字段清单变了会列出新增和消失的字段;VA 只说变了。
 *   - 制度事件可以登记未来日期(规则多是提前公布),标「还没施行」;VA 拒收未来日期。
 * 只读,不写盘。
 */
import { localClock } from "../../notify.ts";
import { fetchEndpoint, ledgerList, ServiceError, type ServiceContext } from "../../service.ts";
import { SCHEDULE_TZ, failedNote, pool } from "../schedule.ts";
import { consistencyFor, median, noteOf, retentionFloor, roundTo, tradeWindow, validDate } from "./history.ts";

export const RECENT = 10;
export const PRIOR = 20;
/** 计数类:相对变化到这个比例才算移位(宁可少报) */
export const SHIFT_RATIO = 0.35;
/** 占比类(0~1):绝对变化到这个值才算移位,免得小基数被放大 */
export const SHIFT_ABS = 0.1;
/** 两个窗口各自至少要这么多天才比 */
export const MIN_DAYS = 5;
const CONCURRENCY = 3;
export const LEDGER_KIND = "regime_event";
export const STRUCTURE_SOURCE = "东财涨停 / 炸板 / 跌停 / 昨日涨停池(每天一次 cn_shortline_structure,已收盘的日子读缓存)+ 台账里人工登记的制度事件";

export type MetricKind = "count" | "share";
export const STRUCTURE_METRICS: { key: string; label: string; kind: MetricKind; field: string }[] = [
  { key: "limit_up", label: "涨停家数", kind: "count", field: "limit_up_count" },
  { key: "share_20cm", label: "20% 制度占比", kind: "share", field: "structure_share_20cm" },
  { key: "share_10cm", label: "10% 制度占比", kind: "share", field: "structure_share_10cm" },
  { key: "share_bj", label: "北交所占比", kind: "share", field: "structure_share_bj" },
];
export const POOL_LABELS: Record<string, string> = { zt: "涨停池", zb: "炸板池", dt: "跌停池", yzt: "昨日涨停池" };

export interface DayStructure {
  date: string;
  values: Record<string, number | null>;
  /** 池子 → 字段清单文字(逗号连接,或「N 个字段,摘要 sha1:…」) */
  fields: Record<string, string>;
}

/** 从信封证据里读一天的结构读数和字段清单。 */
export function structureOf(date: string, env: unknown): DayStructure {
  const evs = env && typeof env === "object" && Array.isArray((env as { evidence?: unknown }).evidence) ? (env as { evidence: unknown[] }).evidence : [];
  const values: Record<string, number | null> = Object.fromEntries(STRUCTURE_METRICS.map((m) => [m.key, null]));
  const byField = new Map(STRUCTURE_METRICS.map((m) => [m.field, m.key] as const));
  const fields: Record<string, string> = {};
  for (const x of evs) {
    if (!x || typeof x !== "object") continue;
    const { field, record_key: k, value } = x as { field?: unknown; record_key?: unknown; value?: unknown };
    if (typeof field !== "string") continue;
    const key = byField.get(field);
    if (key && (k === undefined || k === null) && typeof value === "number" && Number.isFinite(value)) values[key] = value;
    else if (field === "raw_fields" && typeof k === "string" && k && typeof value === "string") fields[k] = value;
  }
  return { date, values, fields };
}

export interface MetricShift {
  metric: string;
  label: string;
  kind: MetricKind;
  recent: number;
  prior: number;
  delta: number;
  rel_change: number | null;
  shifted: boolean;
  recent_days: number;
  prior_days: number;
}

/** 两个窗口逐项比中位数;任一窗口不足 MIN_DAYS 天的那项不比(列进 skipped)。 */
export function compareWindows(recent: DayStructure[], prior: DayStructure[]): { metrics: MetricShift[]; skipped: string[] } {
  const metrics: MetricShift[] = [];
  const skipped: string[] = [];
  for (const m of STRUCTURE_METRICS) {
    const r = recent.map((d) => d.values[m.key]).filter((v): v is number => v !== null);
    const p = prior.map((d) => d.values[m.key]).filter((v): v is number => v !== null);
    if (r.length < MIN_DAYS || p.length < MIN_DAYS) { skipped.push(`${m.label}(最近 ${r.length} 天 / 之前 ${p.length} 天)`); continue; }
    // 一律中位数:一两天涨停潮或大面就能把均值拉飞,看起来像「结构变了」
    const rv = median(r), pv = median(p);
    const rel = m.kind === "count" && pv ? (rv - pv) / pv : null;
    const shifted = m.kind === "share" ? Math.abs(rv - pv) >= SHIFT_ABS - 1e-9 : rel !== null && Math.abs(rel) >= SHIFT_RATIO - 1e-9;
    metrics.push({ metric: m.key, label: m.label, kind: m.kind, recent: roundTo(rv, 4), prior: roundTo(pv, 4), delta: roundTo(rv - pv, 4),
      rel_change: rel === null ? null : roundTo(rel, 3), shifted, recent_days: r.length, prior_days: p.length });
  }
  return { metrics, skipped };
}

export interface FieldVersion { since: string; until: string; fields: string; count: number | null }
export interface PoolDrift {
  pool: string;
  label: string;
  days: number;
  versions: FieldVersion[];
  changed: boolean;
  /** 最近一次变化新增 / 消失的字段;写成摘要的那版比不出来,两个都是 null */
  added: string[] | null;
  removed: string[] | null;
  detectable: boolean;
  note: string;
}

const DIGEST_RE = /^(\d+) 个字段,摘要 sha1:[0-9a-f]+$/;
const splitFields = (s: string): string[] | null => (DIGEST_RE.test(s) ? null : s.split(",").filter(Boolean));

/** 按日期顺序看每张池子的字段清单变过几次。 */
export function fieldDrift(days: DayStructure[]): PoolDrift[] {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  return Object.entries(POOL_LABELS).map(([pool, label]) => {
    const seen = sorted.filter((d) => d.fields[pool]);
    const versions: FieldVersion[] = [];
    for (const d of seen) {
      const f = d.fields[pool]!;
      const last = versions[versions.length - 1];
      if (last && last.fields === f) { last.until = d.date; continue; }
      const parts = splitFields(f);
      versions.push({ since: d.date, until: d.date, fields: f, count: parts ? parts.length : Number(DIGEST_RE.exec(f)?.[1] ?? NaN) || null });
    }
    const changed = versions.length > 1;
    let added: string[] | null = null, removed: string[] | null = null;
    if (changed) {
      const a = splitFields(versions[versions.length - 2]!.fields), b = splitFields(versions[versions.length - 1]!.fields);
      if (a && b) { added = b.filter((x) => !a.includes(x)); removed = a.filter((x) => !b.includes(x)); }
    }
    const span = seen.length ? `;只覆盖 ${seen[0]!.date} 至 ${seen[seen.length - 1]!.date},不能证明之外的日子字段没变` : "";
    const note = changed ? `字段清单在 ${versions[versions.length - 1]!.since} 变过 —— 跨这一天的统计要小心,断点可能来自数据源而不是市场`
      : seen.length >= 2 ? `字段清单稳定(${seen.length} 天)` : `还检不出:只有 ${seen.length} 天看得到字段,至少要 2 天`;
    return { pool, label, days: seen.length, versions, changed, added, removed, detectable: seen.length >= 2, note: note + span };
  });
}

export interface RegimeEvent { id: string; date: string; title: string; note: string; upcoming: boolean }

/** 台账里人工登记的制度事件(按日期排);日期不合法的跳过并说明。 */
export function regimeEvents(ctx: ServiceContext, today: string): { events: RegimeEvent[]; skipped: number } {
  const rows = ledgerList(ctx, LEDGER_KIND)[LEDGER_KIND] ?? [];
  const events: RegimeEvent[] = [];
  let skipped = 0;
  for (const r of rows) {
    const date = typeof r.date === "string" ? r.date : "";
    const title = typeof r.title === "string" ? r.title.trim() : "";
    if (!validDate(date) || !title) { skipped++; continue; }
    events.push({ id: String(r.id), date, title, note: typeof r.note === "string" ? r.note : "", upcoming: date > today });
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  return { events, skipped };
}

export interface WindowInfo { days: number; used: number; from: string | null; to: string | null }

export interface ShortlineStructureResult {
  date: string;
  available: boolean;
  recent_window: WindowInfo;
  prior_window: WindowInfo;
  structure: { available: boolean; reason: string | null; metrics: MetricShift[]; shifted: MetricShift[]; skipped: string[] };
  thresholds: { share_abs: number; count_rel: number; min_days: number };
  field_drift: PoolDrift[];
  field_changed: string[];
  regime_events: RegimeEvent[];
  regime_note: string;
  missing_days: string[];
  unsettled_days: string[];
  summary: string;
  note: string;
  generated_at: string;
  gaps: string[];
  source: string;
}

export const STRUCTURE_NOTE = "结构移位不等于制度变化 —— 也可能是数据源改了字段(看字段清单),或就是市场真的变了。三类分开看,别把前两类读成第三类。";
export const REGIME_NOTE = "制度变化只收人工登记的条目,系统不从数据反推「这天大概改了规则」—— 猜错会把市场波动当成制度事件,宁可留空。";

const info = (dates: string[], used: DayStructure[]): WindowInfo => ({ days: dates.length, used: used.length, from: used[0]?.date ?? null, to: used[used.length - 1]?.date ?? null });

export function summarize(fieldChanged: string[], structure: ShortlineStructureResult["structure"], events: RegimeEvent[]): string {
  const bits: string[] = [];
  if (fieldChanged.length) bits.push(`${fieldChanged.length} 张池子的上游字段变过(${fieldChanged.join("、")})—— 跨那些日期的统计里可能有一个跟市场无关的断点`);
  if (structure.available) bits.push(structure.shifted.length ? `结构比较:${structure.shifted.map((s) => s.label).join("、")}明显移位` : "结构比较:没有明显移位");
  else bits.push(`结构比较暂不可用(${structure.reason})`);
  const past = events.filter((e) => !e.upcoming).length, upcoming = events.length - past;
  bits.push(events.length ? `已登记 ${past} 条制度事件${upcoming ? `,另有 ${upcoming} 条还没施行` : ""}` : "还没登记制度事件(要人工登记,系统不自动推断)");
  return bits.join(";") + "。";
}

export async function shortlineStructure(ctx: ServiceContext, query: Record<string, string>, signal: AbortSignal, now = new Date()): Promise<ShortlineStructureResult> {
  const date = query.date ?? "";
  if (!validDate(date)) throw new ServiceError("bad_query", "date 要写成 YYYY-MM-DD");
  if (query.refresh !== undefined && query.refresh !== "1") throw new ServiceError("bad_query", "refresh 只能是 1");
  const today = localClock(now, SCHEDULE_TZ).day;
  if (date > today) throw new ServiceError("bad_query", `${date} 还没到`);
  const refresh = query.refresh === "1";
  const gaps: string[] = [];

  const { window, gap } = await tradeWindow(ctx, date, RECENT + PRIOR, signal);
  if (gap) gaps.push(gap);
  const oldest = retentionFloor(now);
  const fetched = await pool(window, CONCURRENCY, async (d) => {
    try {
      const r = await fetchEndpoint(ctx, { endpoint: "cn_shortline_structure", args: { date: d }, consistency: consistencyFor(d, oldest, refresh && d === date), signal });
      const env = r.envelope as { status?: string; extra?: { settled?: unknown } };
      if (env?.status === "failed") return { d, day: null, settled: false, note: failedNote(env) || "没取到" };
      return { d, day: structureOf(d, env), settled: env?.extra?.settled === true, note: "" };
    } catch (e) {
      if (signal.aborted) throw e;
      return { d, day: null, settled: false, note: noteOf(e) };
    }
  });

  const usable = new Map<string, DayStructure>();
  const missing: string[] = [], unsettled: string[] = [];
  for (const f of fetched) {
    if (!f.day) { missing.push(f.d); continue; }
    if (!f.settled) { unsettled.push(f.d); continue; }
    usable.set(f.d, f.day);
  }
  const target = fetched.find((f) => f.d === date);
  if (target && !target.day) gaps.push(`${date} 的涨停结构没取到${target.note ? `(${target.note})` : ""}`);
  const older = missing.filter((d) => d !== date);
  if (older.length) gaps.push(`${older.length} 个交易日的涨停结构没取到(东财只留最近一个月左右,更早又没缓存过的日子取不到),已剔除`);
  for (const d of unsettled) gaps.push(`${d} 还没收盘,不进比较`);

  const recentDates = window.slice(-RECENT), priorDates = window.slice(0, -RECENT);
  const pick = (ds: string[]) => ds.map((d) => usable.get(d)).filter((x): x is DayStructure => !!x);
  const recent = pick(recentDates), prior = pick(priorDates);
  let structure: ShortlineStructureResult["structure"];
  if (recent.length < MIN_DAYS || prior.length < MIN_DAYS) {
    structure = { available: false, reason: `最近 ${recentDates.length} 个交易日取到 ${recent.length} 天、之前 ${priorDates.length} 个交易日取到 ${prior.length} 天,每个窗口至少要 ${MIN_DAYS} 天`, metrics: [], shifted: [], skipped: [] };
  } else {
    const { metrics, skipped } = compareWindows(recent, prior);
    structure = metrics.length
      ? { available: true, reason: null, metrics, shifted: metrics.filter((m) => m.shifted), skipped }
      : { available: false, reason: "每一项都不够天数比较", metrics: [], shifted: [], skipped };
  }
  const drift = fieldDrift([...usable.values()]);
  const changed = drift.filter((d) => d.changed).map((d) => d.label);
  const { events, skipped } = regimeEvents(ctx, today);
  if (skipped) gaps.push(`${skipped} 条制度事件日期或标题不对,没列出`);

  return {
    date, available: structure.available || drift.some((d) => d.days > 0) || events.length > 0,
    recent_window: info(recentDates, recent), prior_window: info(priorDates, prior),
    structure, thresholds: { share_abs: SHIFT_ABS, count_rel: SHIFT_RATIO, min_days: MIN_DAYS },
    field_drift: drift, field_changed: changed, regime_events: events, regime_note: REGIME_NOTE,
    missing_days: missing, unsettled_days: unsettled,
    summary: summarize(changed, structure, events), note: STRUCTURE_NOTE,
    generated_at: now.toISOString(), gaps, source: STRUCTURE_SOURCE,
  };
}
