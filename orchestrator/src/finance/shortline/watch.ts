/**
 * 盯盘 · 实时动态(移植自 Vibe AStock v2.0.0 vr/watchtower.py)。
 *
 * VA 用常驻线程每 3 秒全量轮询;这里改成**页面开着时由页面带动**:盯盘页每隔几秒请求一次,
 * 后台取行情、和上几次比、发现异动就记下来。判断状态放在后台进程里,开几个窗口都只算一份、不会重复报;页面关了就不取。
 *
 * - 名单:持仓、自选、昨日梯队(昨日涨停股)、昨日成交额前十每次都取;500 亿以上大票(约 380 只)每 30 秒取一次。
 * - 规则(VA 同口径):3 分钟内涨跌 ≥ 1.5% 报急拉 / 急跌(至少攒够 1 分钟才判);碰到涨停价报封板,离开涨停价报开板;
 *   同一只同一类 5 分钟内不重复。只在连续竞价时段、且行情时间是今天(上午 ≥ 09:30、下午 ≥ 13:00)时判断;
 *   竞价和午休的报价不进比较基准(午休后重新攒)。
 * - 当天的异动追加写进 `<数据目录>/shortline/alerts/<日期>.jsonl`,后台重启后接着显示。
 * - 只列客观读数,不排序打分、不给买卖倾向。
 */
import fs from "node:fs";
import path from "node:path";

import type { LedgerRecord } from "../../ledger.ts";
import { ServiceError, fetchEndpoint, ledgerSnapshot, type FetchResult, type ServiceContext } from "../../service.ts";
import { heldFromLedger, replayTrades, tradeOf } from "../holdings.ts";
import type { CalendarFacts } from "../session.ts";
import { SCHEDULE_TZ, failedNote, pool, rowsOf } from "../schedule.ts";
import { roundTo, validDate } from "./history.ts";
import { clockOf, fetchTodayCalendar } from "./intraday.ts";

export const POLL_MS = 3_000;
export const BIGCAP_EVERY_MS = 30_000;
export const SURGE_WINDOW_MS = 180_000;
export const SURGE_MIN_SPAN_MS = 60_000;
export const SURGE_PCT = 1.5;
export const COOLDOWN_MS = 300_000;
export const FRAME_KEEP = 120;
export const ALERTS_KEEP = 500;
/** 名单(梯队、成交额前十、大票、持仓自选)多久重读一次 */
export const LISTS_EVERY_MS = 120_000;
const QUOTE_BATCH = 50;
export const ALERTS_DIR_REL = path.join("shortline", "alerts");
export const WATCH_SOURCE = "腾讯实时行情;名单:持仓与自选(台账)、昨日梯队 cn_shortline_ladder、昨日成交额前十 cn_shortline_turnover_top、500 亿以上 cn_shortline_bigcaps";

// ---------------------------------------------------------------- 时段

export type Phase = "weekend" | "pre_open" | "auction" | "morning" | "lunch" | "afternoon" | "closing_auction" | "closed";
const PHASE_LABELS: Record<Phase, string> = {
  weekend: "周末休市", pre_open: "开盘前", auction: "集合竞价", morning: "上午连续竞价", lunch: "午间休市",
  afternoon: "下午连续竞价", closing_auction: "收盘集合竞价", closed: "已收盘",
};

/** 按北京时间钟点分时段(节假日另靠交易日历和行情时间判断) */
export function phaseOf(now: Date): Phase {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: SCHEDULE_TZ, weekday: "short" }).format(now);
  if (wd === "Sat" || wd === "Sun") return "weekend";
  const { hm } = clockOf(now);
  if (hm < "09:15") return "pre_open";
  if (hm < "09:30") return "auction";
  if (hm < "11:30") return "morning";
  if (hm < "13:00") return "lunch";
  if (hm < "14:57") return "afternoon";
  if (hm < "15:00") return "closing_auction";
  return "closed";
}
const continuous = (p: Phase) => p === "morning" || p === "afternoon";
/** 下一次请求隔多久:连续竞价 3 秒,竞价 / 午休 15 秒,其余 60 秒(页面切走时页面自己停) */
export const pollMsOf = (p: Phase, tradingDay: boolean | null) =>
  tradingDay === false ? 60_000 : continuous(p) ? POLL_MS : p === "auction" || p === "lunch" || p === "closing_auction" ? 15_000 : 60_000;

// ---------------------------------------------------------------- 异动判断(纯计算)

export type AlertKind = "急拉" | "急跌" | "封板" | "开板";
export interface Alert { ts: string; code: string; name: string; kind: AlertKind; change_pct: number | null; price: number | null; pct: number | null; msg: string; sources: string[] }
export interface Frame { t: number; price: number }
export interface DetectState { frames: Map<string, Frame[]>; limit: Map<string, boolean>; cooldown: Map<string, number> }
export const newDetectState = (): DetectState => ({ frames: new Map(), limit: new Map(), cooldown: new Map() });

const signed = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;

/** 这一只这一刻的报价进来,和之前几帧比,返回新异动(已过冷却) */
export function detect(st: DetectState, code: string, q: { name: string; price: number; pct: number | null; limit_up: number | null }, t: number, ts: string, sources: string[]): Alert[] {
  const out: Alert[] = [];
  const emit = (kind: AlertKind, msg: string, change: number | null) => {
    const k = `${code}|${kind}`;
    if (t - (st.cooldown.get(k) ?? -Infinity) < COOLDOWN_MS) return;
    st.cooldown.set(k, t);
    out.push({ ts, code, name: q.name, kind, change_pct: change === null ? null : roundTo(change, 2), price: q.price, pct: q.pct, msg, sources });
  };
  const frames = st.frames.get(code) ?? [];
  frames.push({ t, price: q.price });
  if (frames.length > FRAME_KEEP) frames.splice(0, frames.length - FRAME_KEEP);
  st.frames.set(code, frames);
  const today = q.pct === null ? "" : `,今日 ${signed(q.pct)}`;
  // 规则①:窗口里最早的一帧和现在比;至少攒够 1 分钟才判
  const old = frames.find((f) => t - f.t <= SURGE_WINDOW_MS);
  if (old && old.price > 0 && t - old.t >= SURGE_MIN_SPAN_MS) {
    const delta = (q.price / old.price - 1) * 100;
    const mins = Math.round((t - old.t) / 60_000);
    if (delta >= SURGE_PCT - 1e-9) emit("急拉", `${mins} 分钟 ${signed(delta)}(现价 ${q.price}${today})`, delta);
    else if (delta <= -SURGE_PCT + 1e-9) emit("急跌", `${mins} 分钟 ${signed(delta)}(现价 ${q.price}${today})`, delta);
  }
  // 规则②:涨停价来自行情本身(含创业板 / 科创板 20%、北交所 30%);第一次见到只记状态不报
  if (q.limit_up !== null && q.limit_up > 0) {
    const at = q.price >= q.limit_up - 1e-6;
    const was = st.limit.get(code);
    if (was !== undefined) {
      if (at && !was) emit("封板", `触及涨停 ${q.limit_up}`, null);
      else if (!at && was) emit("开板", `涨停打开(现价 ${q.price}${today})`, null);
    }
    st.limit.set(code, at);
  }
  return out;
}

// ---------------------------------------------------------------- 行情

export interface WQuote { name: string; price: number | null; pct: number | null; amount_yuan: number | null; limit_up: number | null; quote_time: string }
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 腾讯批量行情 → 6 位代码(名单里只有个股)→ 读数 */
export function wquotesOf(envs: readonly unknown[]): Map<string, WQuote> {
  const out = new Map<string, WQuote>();
  for (const env of envs) {
    for (const r of rowsOf(env)) {
      const m = /^(?:sh|sz|bj)?(\d{6})$/i.exec(r.key);
      if (!m) continue;
      const amt = num(r.f.turnover_amount?.value);
      out.set(m[1]!, {
        name: str(r.f.security_name?.value), price: num(r.f.price?.value), pct: num(r.f.change_pct?.value),
        amount_yuan: amt === null ? null : amt * 1e4,   // 端点给万元
        limit_up: num(r.f.limit_up_price?.value), quote_time: str(r.f.quote_time?.value),
      });
    }
  }
  return out;
}

/** 这笔报价是不是今天连续竞价里的(上午 ≥ 09:30、下午 ≥ 13:00):竞价、午休、节前的报价不进比较 */
export function inSessionQuote(q: WQuote, day: string, phase: Phase): boolean {
  const ymd = day.replaceAll("-", "");
  if (q.quote_time.length !== 14 || !q.quote_time.startsWith(ymd)) return false;
  return q.quote_time.slice(8, 12) >= (phase === "afternoon" ? "1300" : "0930");
}

// ---------------------------------------------------------------- 名单

const A_SHARE = /^\d{6}$/;
const B_SHARE = /^(?:900|200)\d{3}$/;
export interface LadderRow { code: string; name: string; boards: number; label: string; sector: string }
interface Lists {
  at: number; quote_day: string | null; sample_day: string | null;
  holdings: { code: string; name: string }[]; watch: { code: string; name: string }[];
  /** 只在后台用来算浮动盈亏 %,不进页面 */
  costs: Map<string, { shares: number; cost_total: number }>;
  ladder: { sample_date: string; quote_date: string; highest: number; stocks: LadderRow[] } | null;
  turnover: { date: string; stocks: { code: string; name: string; rank: number }[] } | null;
  bigcaps: { date: string; total: number; stocks: { code: string; name: string }[] } | null;
  notes: string[];
}

type Fetch = (ctx: ServiceContext, req: Parameters<typeof fetchEndpoint>[1]) => Promise<Pick<FetchResult, "envelope">>;
const resultOf = (env: unknown): Record<string, unknown> | null => {
  const r = (env as { extra?: { result?: unknown } } | null)?.extra?.result;
  return r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : null;
};
const failed = (env: unknown) => !env || typeof env !== "object" || (env as { status?: unknown }).status === "failed";

/**
 * 持仓的股数和总成本(流水按移动加权平均回放 + 还没迁成流水的旧持有记录;多个账户同一只合在一起),
 * 只用来算浮动盈亏的百分比 —— 股数和成本本身不进页面。口径与「自选与持仓」页一致。
 */
export function holdingCosts(records: Readonly<Record<string, readonly LedgerRecord[]>>, issues: Parameters<typeof heldFromLedger>[1] = {}): Map<string, { shares: number; cost_total: number }> {
  const out = new Map<string, { shares: number; cost_total: number }>();
  const add = (s: string, shares: number, cost: number) => {
    const a = out.get(s) ?? { shares: 0, cost_total: 0 };
    out.set(s, { shares: a.shares + shares, cost_total: a.cost_total + cost });
  };
  const trades = (records.trade ?? []).map(tradeOf);
  const bad = new Set((issues.trade ?? []).map((i) => i.id));
  for (const h of replayTrades(trades.filter((t) => !bad.has(t.id)), "average").holdings) add(h.symbol, h.shares, h.cost_total);
  const migrated = new Set(trades.map((t) => t.migrated_from).filter(Boolean));
  for (const r of records.position ?? []) {
    const sh = num(r.shares), c = num(r.cost);
    if (!str(r.symbol) || migrated.has(r.id) || sh === null || sh <= 0 || c === null) continue;
    add(str(r.symbol), sh, sh * c);
  }
  return out;
}

/** 浮动盈亏 %:总成本 ≤ 0(分红送转吃够了)算不出比例,不给 */
export function pnlPct(price: number | null, c: { shares: number; cost_total: number } | undefined): number | null {
  if (price === null || !c || !(c.cost_total > 0) || !(c.shares > 0)) return null;
  return roundTo(((price * c.shares - c.cost_total) / c.cost_total) * 100, 2);
}

/** 台账里的自选和持仓(只要 A 股;B 股不支持) */
export function myStocks(records: Readonly<Record<string, readonly LedgerRecord[]>>, issues: Parameters<typeof heldFromLedger>[1] = {}) {
  const pick = (xs: { symbol: string; name: string }[]) => [...new Map(xs.filter((x) => A_SHARE.test(x.symbol) && !B_SHARE.test(x.symbol)).map((x) => [x.symbol, { code: x.symbol, name: x.name }])).values()];
  const watch = (records.watch ?? []).map((r) => ({ symbol: str(r.symbol), name: str(r.name) }));
  return { holdings: pick(heldFromLedger(records, issues)), watch: pick(watch), costs: holdingCosts(records, issues) };
}

async function loadLists(ctx: ServiceContext, cal: CalendarFacts | null, fetch: Fetch, signal: AbortSignal): Promise<Lists> {
  const notes: string[] = [];
  let holdings: Lists["holdings"] = [], watch: Lists["watch"] = [], costs: Lists["costs"] = new Map();
  try {
    const snap = ledgerSnapshot(ctx);
    ({ holdings, watch, costs } = myStocks(snap.records, snap.issues));
  } catch {
    notes.push("持仓和自选没读出来(台账有问题,去「我的股票」看看)");
  }
  const quoteDay = cal?.last_trading_day ?? null;
  const grab = async (label: string, req: Parameters<Fetch>[1]) => {
    try {
      const r = await fetch(ctx, { ...req, signal });
      if (failed(r.envelope)) { notes.push(`${label}没取到${failedNote(r.envelope) ? `(${failedNote(r.envelope)})` : ""}`); return null; }
      return resultOf(r.envelope);
    } catch (e) {
      if (signal.aborted) throw e;
      notes.push(`${label}没取到`);
      return null;
    }
  };
  if (!quoteDay) notes.push("交易日历没取到,昨日梯队和昨日成交额前十先不列");
  const [lad, big] = await Promise.all([
    quoteDay ? grab("昨日梯队", { endpoint: "cn_shortline_ladder", args: { date: quoteDay } }) : Promise.resolve(null),
    grab("500 亿以上大票名单", { endpoint: "cn_shortline_bigcaps", args: { min_cap_yi: 500 } }),
  ]);
  let ladder: Lists["ladder"] = null;
  if (lad && Array.isArray(lad.stocks) && str(lad.quote_date) === quoteDay) {
    const stocks = lad.stocks.flatMap((x): LadderRow[] => {
      const s = x as Record<string, unknown>;
      const code = str(s.code), boards = num(s.boards);
      return A_SHARE.test(code) && boards !== null ? [{ code, name: str(s.name), boards, label: str(s.label) || `${boards}板`, sector: str(s.sector) }] : [];
    });
    ladder = { sample_date: str(lad.sample_date), quote_date: quoteDay!, highest: num(lad.highest) ?? Math.max(0, ...stocks.map((s) => s.boards)), stocks };
  } else if (lad) notes.push(`昨日梯队盯的场次(${str(lad.quote_date) || "未知"})和交易日历(${quoteDay})对不上,先不列`);
  const sampleDay = ladder?.sample_date ?? (cal?.is_today_trading_day ? cal.previous_trading_day : null);
  const turn = sampleDay ? await grab("昨日成交额前十", { endpoint: "cn_shortline_turnover_top", args: { date: sampleDay, top: 10 } }) : null;
  const turnover: Lists["turnover"] = turn && Array.isArray(turn.stocks)
    ? { date: str(turn.date), stocks: turn.stocks.flatMap((x) => { const s = x as Record<string, unknown>; const code = str(s.code); return A_SHARE.test(code) ? [{ code, name: str(s.name), rank: num(s.rank) ?? 0 }] : []; }) }
    : null;
  const bigcaps: Lists["bigcaps"] = big && Array.isArray(big.stocks)
    ? { date: str(big.date), total: num(big.count) ?? big.stocks.length, stocks: big.stocks.flatMap((x) => { const s = x as Record<string, unknown>; const code = str(s.code); return A_SHARE.test(code) ? [{ code, name: str(s.name) }] : []; }) }
    : null;
  return { at: 0, quote_day: quoteDay, sample_day: sampleDay, holdings, watch, costs, ladder, turnover, bigcaps, notes };
}

/** 每只票为什么在名单里(异动流里显示「持仓 · 昨日3板」) */
export function sourcesOf(l: Pick<Lists, "holdings" | "watch" | "ladder" | "turnover" | "bigcaps">): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const add = (code: string, tag: string) => { const xs = m.get(code) ?? []; if (!xs.includes(tag)) xs.push(tag); m.set(code, xs); };
  for (const h of l.holdings) add(h.code, "持仓");
  for (const w of l.watch) add(w.code, "自选");
  for (const s of l.ladder?.stocks ?? []) add(s.code, `昨日${s.boards}板`);
  for (const t of l.turnover?.stocks ?? []) add(t.code, "昨日成交额前十");
  for (const b of l.bigcaps?.stocks ?? []) add(b.code, "大票");
  return m;
}

// ---------------------------------------------------------------- 存取异动

export const alertsFile = (dataRoot: string, day: string) => path.join(dataRoot, ALERTS_DIR_REL, `${day}.jsonl`);
const KINDS: AlertKind[] = ["急拉", "急跌", "封板", "开板"];

/** 当天的异动(新的在前)。坏行跳过 */
export function loadAlerts(dataRoot: string, day: string): Alert[] {
  let text = "";
  try { text = fs.readFileSync(alertsFile(dataRoot, day), "utf8"); } catch { return []; }
  const out: Alert[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const a = JSON.parse(line) as Alert;
      if (typeof a.ts === "string" && A_SHARE.test(a.code) && KINDS.includes(a.kind) && typeof a.msg === "string" && Array.isArray(a.sources)) out.push(a);
    } catch { /* 坏行跳过 */ }
  }
  return out.reverse().slice(0, ALERTS_KEEP);
}

function appendAlerts(dataRoot: string, day: string, alerts: Alert[]): string | null {
  if (!alerts.length) return null;
  try {
    fs.mkdirSync(path.dirname(alertsFile(dataRoot, day)), { recursive: true });
    fs.appendFileSync(alertsFile(dataRoot, day), alerts.map((a) => JSON.stringify(a)).join("\n") + "\n", "utf8");
    return null;
  } catch {
    return "异动没存上(检查数据目录的权限或磁盘空间),页面上照常显示";
  }
}

// ---------------------------------------------------------------- 轮询

export interface WatchRow { code: string; name: string; price: number | null; pct: number | null; amount_yuan: number | null; quote_time: string | null; today: boolean }
export interface WatchView {
  date: string; clock: string; phase: Phase; phase_label: string;
  /** 交易日历说今天开不开市(没取到 = null) */
  trading_day: boolean | null;
  detecting: boolean; poll_ms: number;
  quote_day: string | null;
  /** 持仓只给现价、涨跌和浮动盈亏 %,不给股数和成本 */
  holdings: (WatchRow & { pnl_pct: number | null })[]; watchlist: WatchRow[];
  ladder: { sample_date: string; quote_date: string; highest: number; rows: (WatchRow & { boards: number; label: string; sector: string; at_limit: boolean | null })[] } | null;
  turnover: { date: string; rows: (WatchRow & { rank: number })[] } | null;
  bigcap: { total: number; date: string; refreshed_at: string | null; top: WatchRow[]; bottom: WatchRow[] } | null;
  alerts: Alert[];
  notes: string[];
  rules: { surge_pct: number; window_min: number; cooldown_min: number };
  source: string;
}

interface State {
  day: string; detect: DetectState; alerts: Alert[];
  quotes: Map<string, WQuote>;
  focusAt: number; bigAt: number; bigRefreshed: string | null;
  cal: { facts: CalendarFacts | null; at: number; ok: boolean; day: string };
  lists: Lists | null;
  inflight: Promise<WatchView> | null;
  last: WatchView | null; lastAt: number;
}
const states = new Map<string, State>();

function stateFor(ctx: ServiceContext, day: string): State {
  let st = states.get(ctx.dataRoot);
  if (!st || st.day !== day) {
    st = {
      day, detect: newDetectState(), alerts: loadAlerts(ctx.dataRoot, day), quotes: new Map(), focusAt: 0, bigAt: 0, bigRefreshed: null,
      cal: st?.cal ?? { facts: null, at: 0, ok: false, day: "" }, lists: null, inflight: null, last: null, lastAt: 0,
    };
    states.set(ctx.dataRoot, st);
  }
  return st;
}

/** 测试用:清掉进程里的盯盘状态 */
export function resetWatchState(): void { states.clear(); }

async function calendar(ctx: ServiceContext, st: State, day: string, nowMs: number, fetch: Fetch, signal: AbortSignal): Promise<CalendarFacts | null> {
  const fresh = st.cal.day === day && nowMs - st.cal.at < (st.cal.ok ? 30 * 60_000 : 60_000);
  if (fresh) return st.cal.facts;
  const facts = await fetchTodayCalendar(ctx, day, fetch, signal);
  st.cal = { facts, at: nowMs, ok: facts !== null, day };
  return facts;
}

async function fetchQuotes(ctx: ServiceContext, codes: string[], fresh: boolean, fetch: Fetch, signal: AbortSignal): Promise<{ quotes: Map<string, WQuote>; failedBatches: number; batches: number }> {
  const batches: string[][] = [];
  for (let i = 0; i < codes.length; i += QUOTE_BATCH) batches.push(codes.slice(i, i + QUOTE_BATCH));
  const envs = await pool(batches, 3, async (b) => {
    try {
      const r = await fetch(ctx, { endpoint: "tx_quotes_batch", args: { codes: b }, ...(fresh ? { consistency: { mode: "fresh" as const } } : {}), signal });
      return failed(r.envelope) ? undefined : r.envelope;
    } catch (e) {
      if (signal.aborted) throw e;
      return undefined;
    }
  });
  return { quotes: wquotesOf(envs.filter(Boolean)), failedBatches: envs.filter((e) => !e).length, batches: batches.length };
}

export interface PollDeps { fetch?: Fetch; clock?: () => Date }

async function pollOnce(ctx: ServiceContext, st: State, signal: AbortSignal, deps: PollDeps): Promise<WatchView> {
  const fetch: Fetch = deps.fetch ?? fetchEndpoint;
  const clock = deps.clock ?? (() => new Date());
  const now = clock();
  const nowMs = now.getTime();
  const { day, hms } = clockOf(now);
  const phase = phaseOf(now);
  const cal = await calendar(ctx, st, day, nowMs, fetch, signal);
  const tradingDay = cal ? cal.is_today_trading_day : phase === "weekend" ? false : null;
  const live = continuous(phase) && tradingDay !== false;

  if (!st.lists || nowMs - st.lists.at >= LISTS_EVERY_MS || st.lists.quote_day !== (cal?.last_trading_day ?? null)) {
    st.lists = { ...(await loadLists(ctx, cal, fetch, signal)), at: nowMs };
  }
  const lists = st.lists;
  const tags = sourcesOf(lists);
  const bigSet = new Set((lists.bigcaps?.stocks ?? []).map((s) => s.code));
  // 大票只在名单里挂「大票」一个标签的 30 秒取一次;同时是持仓 / 自选 / 梯队的,跟着重点名单每次取
  const focus = [...tags.keys()].filter((c) => !bigSet.has(c) || tags.get(c)!.length > 1);
  const focusSet = new Set(focus);
  const big = [...bigSet].filter((c) => !focusSet.has(c));
  const notes = [...lists.notes];

  // 连续竞价里现取;其余时段行情不怎么变,允许用 5 分钟内的缓存、拉长间隔
  const focusDue = nowMs - st.focusAt >= (live ? POLL_MS - 500 : 60_000);
  const bigDue = nowMs - st.bigAt >= (live ? BIGCAP_EVERY_MS : 5 * 60_000);
  const want = [...(focusDue ? focus : []), ...(bigDue ? big : [])];
  if (want.length) {
    const r = await fetchQuotes(ctx, want, live, fetch, signal);
    // 这一轮问了却没返回的,旧价不留着当现价
    for (const c of want) st.quotes.delete(c);
    for (const [c, q] of r.quotes) st.quotes.set(c, q);
    if (focusDue) st.focusAt = nowMs;
    if (bigDue) { st.bigAt = nowMs; st.bigRefreshed = now.toISOString(); }
    if (r.failedBatches) notes.push(`行情这一轮分 ${r.batches} 批取,${r.failedBatches} 批没取到,稍后自动重试`);

    if (live) {
      const fresh: Alert[] = [];
      for (const c of want) {
        const q = r.quotes.get(c);
        if (!q || q.price === null || !inSessionQuote(q, day, phase)) continue;
        fresh.push(...detect(st.detect, c, { name: q.name || c, price: q.price, pct: q.pct, limit_up: q.limit_up }, nowMs, hms, tags.get(c) ?? []));
      }
      if (fresh.length) {
        const err = appendAlerts(ctx.dataRoot, day, fresh);
        if (err) notes.push(err);
        st.alerts = [...fresh.reverse(), ...st.alerts].slice(0, ALERTS_KEEP);
      }
    }
  }
  // 竞价、午休、收盘后的报价不进连续竞价的比较基准:下一段重新攒
  if (!live) { st.detect.frames.clear(); st.detect.limit.clear(); }

  const row = (code: string, name = ""): WatchRow => {
    const q = st.quotes.get(code);
    return { code, name: q?.name || name || code, price: q?.price ?? null, pct: q?.pct ?? null, amount_yuan: q?.amount_yuan ?? null,
      quote_time: q?.quote_time || null, today: !!q && q.quote_time.startsWith(day.replaceAll("-", "")) };
  };
  // 封没封只在连续竞价和收盘后、行情时间是今天时说;竞价 / 午休里的价位碰到涨停价不算
  const limitKnown = (phase === "morning" || phase === "afternoon" || phase === "closed") && tradingDay !== false;
  const ladder = lists.ladder ? {
    sample_date: lists.ladder.sample_date, quote_date: lists.ladder.quote_date, highest: lists.ladder.highest,
    rows: [...lists.ladder.stocks].sort((a, b) => b.boards - a.boards).map((s) => {
      const r = row(s.code, s.name);
      const q = st.quotes.get(s.code);
      const at = limitKnown && r.today && q?.price != null && q.limit_up != null && q.limit_up > 0 ? q.price >= q.limit_up - 1e-6 : null;
      return { ...r, boards: s.boards, label: s.label, sector: s.sector, at_limit: at };
    }),
  } : null;
  const bigRows = (lists.bigcaps?.stocks ?? []).map((s) => row(s.code, s.name)).filter((r) => r.pct !== null);
  const byPct = [...bigRows].sort((a, b) => b.pct! - a.pct!);
  if (tradingDay === null && phase !== "weekend") notes.push("交易日历没取到:今天是否开市以行情时间为准");

  return {
    date: day, clock: hms, phase, phase_label: tradingDay === false && phase !== "weekend" ? "今天休市" : PHASE_LABELS[phase],
    trading_day: tradingDay, detecting: live, poll_ms: pollMsOf(phase, tradingDay), quote_day: lists.quote_day,
    holdings: lists.holdings.map((h) => { const r = row(h.code, h.name); return { ...r, pnl_pct: pnlPct(r.price, lists.costs.get(h.code)) }; }),
    watchlist: lists.watch.map((w) => row(w.code, w.name)),
    ladder,
    turnover: lists.turnover ? { date: lists.turnover.date, rows: lists.turnover.stocks.map((t) => ({ ...row(t.code, t.name), rank: t.rank })) } : null,
    bigcap: lists.bigcaps ? { total: lists.bigcaps.total, date: lists.bigcaps.date, refreshed_at: st.bigRefreshed, top: byPct.slice(0, 10), bottom: byPct.slice(-5).reverse() } : null,
    alerts: st.alerts,
    notes,
    rules: { surge_pct: SURGE_PCT, window_min: SURGE_WINDOW_MS / 60_000, cooldown_min: COOLDOWN_MS / 60_000 },
    source: WATCH_SOURCE,
  };
}

/**
 * 盯盘页每隔几秒调一次:`{ action: "poll" }`。同时开着几个窗口时,2.5 秒内的请求共用上一次结果,在途的请求不重复发。
 */
export async function shortlineWatchAct(ctx: ServiceContext, body: Record<string, unknown>, _signal: AbortSignal, deps: PollDeps = {}): Promise<WatchView> {
  if (body.action !== "poll") throw new ServiceError("bad_request", "action 只能是 poll");
  const clock = deps.clock ?? (() => new Date());
  const now = clock();
  const st = stateFor(ctx, clockOf(now).day);
  if (st.inflight) return st.inflight;
  if (st.last && now.getTime() - st.lastAt < POLL_MS - 500) return st.last;
  // 在途请求和发起它的页面解耦:那个页面关了,别的窗口还在等同一份结果
  const p = pollOnce(ctx, st, new AbortController().signal, deps)
    .then((v) => { st.last = v; st.lastAt = clock().getTime(); return v; })
    .finally(() => { st.inflight = null; });
  st.inflight = p;
  return p;
}

/** 某天记下的异动(复盘时回看):`?date=YYYY-MM-DD`,默认今天 */
export async function shortlineWatchAlerts(ctx: ServiceContext, query: Record<string, string>, _signal: AbortSignal, now = new Date()): Promise<{ date: string; alerts: Alert[] }> {
  const today = clockOf(now).day;
  const date = query.date ?? today;
  if (!validDate(date)) throw new ServiceError("bad_query", "date 要写成 YYYY-MM-DD");
  if (date > today) throw new ServiceError("bad_query", `${date} 还没到`);
  return { date, alerts: loadAlerts(ctx.dataRoot, date) };
}
