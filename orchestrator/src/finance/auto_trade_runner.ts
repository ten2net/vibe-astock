/**
 * 自动记账代理执行器:每拍(beat)检查 5 分钟窗口,到了且今天该窗口没跑过 →
 * 取榜单 + 持仓行情 + 分钟资金曲线 → 纯引擎出指令 → 写 trade 台账 + 收件箱。
 * 窗口防重靠 stateFile(day+窗口分钟);崩溃重启同窗口不重复成交。
 */
import fs from "node:fs";
import path from "node:path";
import { fetchEndpoint, ledgerSnapshot, ledgerUpsert, type ServiceContext } from "../service.ts";
import { addInbox, newId, type GateResult } from "../notify.ts";
import { shortlineFflow, type FflowView } from "./shortline/fflow_pattern.ts";
import { replayTrades, tradeOf } from "./holdings.ts";
import { quoteCodeOf, rowsOf, symbolOfQuoteKey } from "./schedule.ts";
import { calendarFromEnvelope, type CalendarFacts } from "./session.ts";
import {
  buyOrders, sellOrders, parseAutoNote,
  type AutoTradeConfig, type AutoTradeHolding, type CandidateQuote, type Order,
} from "./auto_trade.ts";

export const AUTO_TRADE_JOB_ID = "auto_fflow_trade";
const STATE_DIR = "auto_trade";
const WIN_START = "09:35", WIN_END = "14:50";
const CONFIG: AutoTradeConfig = {
  totalYuan: 1_000_000, positionRatio: 0.5, maxPositions: 5,
  stopLoss: 0.95, takeProfit: 1.08, holdDays: 3,
  buyCooldownDays: 3, sellCooldownDays: 1,
};

const stateFile = (dataRoot: string, day: string, winMin: number) =>
  path.join(dataRoot, STATE_DIR, `${day}-${String(winMin).padStart(4, "0")}.json`);
const writeState = (dataRoot: string, day: string, winMin: number, v: unknown) => {
  const f = stateFile(dataRoot, day, winMin);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v));
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function fetchCalendar(ctx: ServiceContext, day: string, signal: AbortSignal): Promise<CalendarFacts | null> {
  try {
    const r = await fetchEndpoint(ctx, { endpoint: "fetch_trade_calendar", symbol: "300308", signal });
    const env = r.envelope as { evidence?: { field?: string; value?: unknown; period?: string }[] };
    const period = (env.evidence ?? []).find((e) => e.field === "is_today_trading_day")?.period;
    return period === day ? calendarFromEnvelope(env) : null;
  } catch { return null; }
}

/** 持仓票的现价:腾讯批量行情(envelope 是证据长表,用 schedule.rowsOf 透视成行) */
async function fetchQuotes(ctx: ServiceContext, symbols: string[], signal: AbortSignal): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!symbols.length) return out;
  const r = await fetchEndpoint(ctx, { endpoint: "tx_quotes_batch", args: { codes: symbols.map(quoteCodeOf) }, signal });
  for (const row of rowsOf(r.envelope)) {
    const price = num(row.f.price?.value);
    if (price !== null) out.set(symbolOfQuoteKey(row.key), price);
  }
  return out;
}

/** 资金曲线由正转负的持续分钟数(累计净额末段为负时,从最后一个 ≥0 点算起) */
function negativeMinutes(series: { main: number | null }[], barMinutes: number): { neg: number; last: number | null } {
  const vals = series.map((p) => p.main).filter((v): v is number => v !== null);
  if (!vals.length) return { neg: 0, last: null };
  if (vals[vals.length - 1]! >= 0) return { neg: 0, last: vals[vals.length - 1]! };
  let i = vals.length - 1;
  while (i > 0 && vals[i - 1]! < 0) i--;
  return { neg: (vals.length - i) * barMinutes, last: vals[vals.length - 1]! };
}

async function runOnce(
  ctx: ServiceContext, day: string, signal: AbortSignal,
): Promise<{ orders: Order[]; error?: string }> {
  const cal = await fetchCalendar(ctx, day, signal);
  if (!cal || !cal.is_today_trading_day) return { orders: [], error: "交易日历取不到或今天不是交易日" };
  const tradingDays = ((await fetchEndpoint(ctx, { endpoint: "fetch_trade_calendar", symbol: "300308", args: { days: 40 }, signal }))
    .envelope as { extra?: { trading_day_list?: string[] } }).extra?.trading_day_list;

  const view: FflowView = await shortlineFflow(ctx, {}, signal);
  const candidates: CandidateQuote[] = view.stocks.map((s) => ({
    code: s.code, name: s.name, price: s.price, pct: s.pct, mainNet: s.main_net,
    floatCap: s.float_cap, upRatio: s.up_ratio, riseBp: s.rise_bp, score: s.score,
  }));

  const snap = ledgerSnapshot(ctx);
  const bad = new Set((snap.issues.trade ?? []).map((i) => i.id));
  const autoTrades = (snap.records.trade ?? [])
    .filter((r) => !bad.has(r.id) && parseAutoNote(r.note))
    .map((r) => ({ symbol: String(r.symbol), type: r.type as "buy" | "sell", date: String(r.date) }));
  const history = { trades: autoTrades };

  const replay = replayTrades(
    (snap.records.trade ?? []).filter((r) => !bad.has(r.id)).map(tradeOf), "fifo");
  const quotes = await fetchQuotes(ctx, replay.holdings.map((h) => h.symbol), signal);
  const holdings: AutoTradeHolding[] = [];
  for (const h of replay.holdings) {
    let mainToday: number | null = null, neg = 0;
    try {
      const env = (await fetchEndpoint(ctx, { endpoint: "em_fund_flow_minute", symbol: h.symbol, signal })).envelope as {
        extra?: { minute_series?: { main: number | null }[]; bar_minutes?: number } };
      const r = negativeMinutes(env.extra?.minute_series ?? [], env.extra?.bar_minutes ?? 1);
      mainToday = r.last; neg = r.neg;
    } catch { /* 分钟曲线取不到:只用价格规则 */ }
    holdings.push({
      symbol: h.symbol, name: h.name, shares: h.shares, unitCost: h.unit_cost,
      openedAt: h.opened_at, price: quotes.get(h.symbol) ?? null,
      mainToday, negMinutes: neg,
    });
  }

  const orders = [
    ...sellOrders(CONFIG, holdings, history, cal, tradingDays),
    ...buyOrders(CONFIG, candidates, holdings, history, cal, tradingDays),
  ];
  for (const o of orders) {
    ledgerUpsert(ctx, {
      kind: "trade",
      record: {
        symbol: o.symbol, name: o.name, type: o.kind, date: day,
        shares: o.shares, price: o.price, note: o.note,
      },
    });
  }
  if (orders.length) {
    await addInbox(ctx.dataRoot, [{
      id: newId(), at: new Date().toISOString(), job: AUTO_TRADE_JOB_ID, job_label: "自动记账",
      title: `自动记账 ${orders.length} 笔`, read: false, kind: "message",
      lines: orders.map((o) =>
        `${o.kind === "buy" ? "买入" : "卖出"} ${o.name}(${o.symbol}) ${o.shares}股 @ ${o.price} — ${o.reason}`),
    }]);
  }
  return { orders };
}

/** FINANCE_SCHEDULE.beat 分支:窗口 = 5 分钟一格的 [09:35, 14:50] */
export async function autoTradeBeat(
  b: { ctx: ServiceContext; signal: AbortSignal; gate: () => Promise<GateResult> },
): Promise<string | void> {
  const now = new Date();
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  if (hm < WIN_START || hm > WIN_END) return;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);  // YYYY-MM-DD
  const winMin = Math.floor((Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3))) / 5) * 5;
  if (fs.existsSync(stateFile(b.ctx.dataRoot, day, winMin))) return;
  const gate = await b.gate();
  if (gate.status === "closed") return;
  let result: { orders: Order[]; error?: string };
  try {
    result = await runOnce(b.ctx, day, b.signal);
  } catch (e) {
    result = { orders: [], error: e instanceof Error ? e.message : String(e) };
  }
  writeState(b.ctx.dataRoot, day, winMin, { at: now.toISOString(), ...result });
  if (result.error) return `auto_fflow_trade ${String(winMin).padStart(4, "0")}: 未执行(${result.error})`;
  if (result.orders.length) return `auto_fflow_trade ${String(winMin).padStart(4, "0")}: 成交 ${result.orders.length} 笔`;
}
