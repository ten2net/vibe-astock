/**
 * 自动记账代理执行器:每拍(beat)检查 5 分钟窗口,到了且今天该窗口没跑过 →
 * 取榜单 + 持仓行情 + 分钟资金曲线 → 纯引擎出指令 → 写 trade 台账 + 收件箱。
 *
 * - 窗口防重靠 stateFile(day+5分钟窗口),写成功才算跑过;半落账(台账写到一半失败)**不封窗**,
 *   下拍原窗口重试 —— 重试安全:已成交的买入记录 date=今天会触发买入冷却挡住重复买,
 *   已成交的卖出使持仓清零不会再卖。state 只增不清理(每交易日约 64 个、逐日累积):
 *   它是防重账,不是给用户看的数据,量大也不碍事。
 * - spec 第 8 节的「确定性指令 key」未采用:防重靠 state 文件 + 台账重放的副作用(冷却/持仓),
 *   效果等价,且不需要引擎认识执行器的状态。
 * - 无现金台账:预算由 CONFIG 常量 + 持仓重放估值执行(台账 replay 没有现金概念,
 *   记 opening 只会污染持仓页 —— 这是对 spec §4 初始资金的实现级修正)。
 */
import fs from "node:fs";
import path from "node:path";
import { fetchEndpoint, ledgerSnapshot, ledgerUpsert, type ServiceContext } from "../service.ts";
import type { LedgerRecord } from "../ledger.ts";
import { addInbox, localClock, newId, type GateResult } from "../notify.ts";
import { shortlineFflow, type FflowView } from "./shortline/fflow_pattern.ts";
import { replayTrades, tradeOf } from "./holdings.ts";
import { quoteCodeOf, rowsOf, SCHEDULE_TZ, symbolOfQuoteKey } from "./schedule.ts";
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
/** 原子写:先写临时文件再 rename,中途崩了不会留个写了一半的 state 假封窗 */
const writeState = (dataRoot: string, day: string, winMin: number, v: unknown) => {
  const f = stateFile(dataRoot, day, winMin);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${newId()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v), { flag: "wx" });
  fs.renameSync(tmp, f);
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 可注入的依赖(测试用 fake);默认走真实实现 */
export interface RunnerDeps {
  fetch?: typeof fetchEndpoint;
  /** beat 的窗口判定时钟(默认真实时钟);时间一律按 SCHEDULE_TZ 解释 */
  clock?: () => Date;
  /** 台账写入(默认 ledgerUpsert);注入它用来演练半落账 */
  upsert?: (ctx: ServiceContext, req: { kind: string; record: Record<string, unknown> }) => LedgerRecord;
}

/**
 * 一次取数同时解析日历事实和交易日列表。
 * ⚠️ fetch_trade_calendar 在 registry 没声明 args(白名单只有全局键):这里**不许**带 args,
 *    assertArgs 会直接拒,整个窗口白跑(2026-10-27 评审发现的 bug)。
 */
async function fetchCalendar(
  ctx: ServiceContext, day: string, signal: AbortSignal, deps: RunnerDeps,
): Promise<{ facts: CalendarFacts | null; tradingDayList: string[] | undefined }> {
  try {
    const r = await (deps.fetch ?? fetchEndpoint)(ctx, { endpoint: "fetch_trade_calendar", symbol: "300308", signal });
    const env = r.envelope as {
      evidence?: { field?: string; value?: unknown; period?: string }[];
      extra?: { trading_day_list?: string[] };
    };
    const period = (env.evidence ?? []).find((e) => e.field === "is_today_trading_day")?.period;
    return {
      facts: period === day ? calendarFromEnvelope(env) : null,
      tradingDayList: env.extra?.trading_day_list,
    };
  } catch (e) {
    if (signal.aborted) throw e;
    return { facts: null, tradingDayList: undefined };
  }
}

/** 持仓票的现价:腾讯批量行情(envelope 是证据长表,用 schedule.rowsOf 透视成行) */
async function fetchQuotes(ctx: ServiceContext, symbols: string[], signal: AbortSignal, deps: RunnerDeps): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!symbols.length) return out;
  const r = await (deps.fetch ?? fetchEndpoint)(ctx, { endpoint: "tx_quotes_batch", args: { codes: symbols.map(quoteCodeOf) }, signal });
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

export interface RunResult {
  orders: Order[];
  error?: string;
  /** 半落账:成交没写全,窗口不封,同一窗口允许重试 */
  pending?: boolean;
  /** 成交已全部持久化但收件箱没写进去(照常封窗,beat 文案说明) */
  inboxFailed?: boolean;
}

export async function runOnce(
  ctx: ServiceContext, day: string, signal: AbortSignal, deps: RunnerDeps = {},
): Promise<RunResult> {
  const cal = await fetchCalendar(ctx, day, signal, deps);
  if (!cal.facts || !cal.facts.is_today_trading_day) return { orders: [], error: "交易日历取不到或今天不是交易日" };
  const tradingDays = cal.tradingDayList;

  const view: FflowView = await shortlineFflow(ctx, {}, signal, { fetch: deps.fetch ?? fetchEndpoint });
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
  const quotes = await fetchQuotes(ctx, replay.holdings.map((h) => h.symbol), signal, deps);
  const holdings: AutoTradeHolding[] = [];
  for (const h of replay.holdings) {
    let mainToday: number | null = null, neg = 0;
    try {
      const env = (await (deps.fetch ?? fetchEndpoint)(ctx, { endpoint: "em_fund_flow_minute", symbol: h.symbol, signal })).envelope as {
        extra?: { minute_series?: { main: number | null }[]; bar_minutes?: number } };
      const r = negativeMinutes(env.extra?.minute_series ?? [], env.extra?.bar_minutes ?? 1);
      mainToday = r.last; neg = r.neg;
    } catch (e) {
      if (signal.aborted) throw e;
      console.error(`[${AUTO_TRADE_JOB_ID}] ${h.symbol} 分钟资金曲线没取到,这只只用价格规则:${e instanceof Error ? e.message : String(e)}`);
    }
    holdings.push({
      symbol: h.symbol, name: h.name, shares: h.shares, unitCost: h.unit_cost,
      openedAt: h.opened_at, price: quotes.get(h.symbol) ?? null,
      mainToday, negMinutes: neg,
    });
  }

  const orders = [
    ...sellOrders(CONFIG, holdings, history, cal.facts, tradingDays),
    ...buyOrders(CONFIG, candidates, holdings, history, cal.facts, tradingDays),
  ];
  // 逐条落账、收集成败:有一笔失败就是半落账 —— 不封窗(由 beat 跳过 writeState),
  // 下拍原窗口重试;重试不会重复成交(冷却挡重复买、持仓清零不再卖)。
  const upsert = deps.upsert ?? ledgerUpsert;
  const done: Order[] = [];
  let firstFail = "";
  for (const o of orders) {
    try {
      upsert(ctx, {
        kind: "trade",
        record: {
          symbol: o.symbol, name: o.name, type: o.kind, date: day,
          shares: o.shares, price: o.price, note: o.note,
        },
      });
      done.push(o);
    } catch (e) {
      if (!firstFail) firstFail = e instanceof Error ? e.message : String(e);
    }
  }
  if (firstFail) return { orders: done, error: `成交 ${done.length}/${orders.length} 笔:${firstFail},窗口未关闭`, pending: true };
  let inboxFailed = false;
  if (done.length) {
    try {
      await addInbox(ctx.dataRoot, [{
        id: newId(), at: new Date().toISOString(), job: AUTO_TRADE_JOB_ID, job_label: "自动记账",
        title: `自动记账 ${done.length} 笔`, read: false, kind: "message",
        lines: done.map((o) =>
          `${o.kind === "buy" ? "买入" : "卖出"} ${o.name}(${o.symbol}) ${o.shares}股 @ ${o.price} — ${o.reason}`),
      }]);
    } catch (e) {
      // 成交已全部持久化:照常封窗,只如实说明收件箱没写进去
      inboxFailed = true;
      console.error(`[${AUTO_TRADE_JOB_ID}] 成交 ${done.length} 笔已记账,收件箱没写进去:${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { orders: done, ...(inboxFailed ? { inboxFailed: true as const } : {}) };
}

/** FINANCE_SCHEDULE.beat 分支:窗口 = 5 分钟一格的 [09:35, 14:50] */
export async function autoTradeBeat(
  b: { ctx: ServiceContext; signal: AbortSignal; gate: () => Promise<GateResult> },
  deps: RunnerDeps = {},
): Promise<string | void> {
  const now = (deps.clock ?? (() => new Date()))();
  const { day, hm } = localClock(now, SCHEDULE_TZ);
  if (hm < WIN_START || hm > WIN_END) return;
  const winMin = Math.floor((Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3))) / 5) * 5;
  if (fs.existsSync(stateFile(b.ctx.dataRoot, day, winMin))) return;
  const gate = await b.gate();
  if (gate.status === "closed") return;
  const head = `auto_fflow_trade ${String(winMin).padStart(4, "0")}`;
  let result: RunResult;
  try {
    result = await runOnce(b.ctx, day, b.signal, deps);
  } catch (e) {
    result = { orders: [], error: e instanceof Error ? e.message : String(e) };
  }
  // 半落账不封窗:下拍原窗口重试(重试不重复成交,见 runOnce 落账注释)
  if (!result.pending) writeState(b.ctx.dataRoot, day, winMin, { at: now.toISOString(), ...result });
  if (result.error) return result.pending ? `${head}: ${result.error}` : `${head}: 未执行(${result.error})`;
  if (result.orders.length) return `${head}: 成交 ${result.orders.length} 笔${result.inboxFailed ? ",收件箱未写入" : ""}`;
}
