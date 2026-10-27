import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buyOrders, sellOrders, BUY_COOLDOWN_DAYS, limitPctOf, parseAutoNote, PCT_MAX, PCT_MIN,
  RISE_BP_MIN, UP_RATIO_MIN, MAIN_BP_MIN, MAIN_NET_ABS_MIN,
  type AutoTradeConfig, type AutoTradeHolding, type AutoTradeHistory,
  type CalendarFacts, type CandidateQuote, type Order,
} from "../src/finance/auto_trade.ts";

const CFG: AutoTradeConfig = {
  totalYuan: 1_000_000, positionRatio: 0.5, maxPositions: 5,
  stopLoss: 0.95, takeProfit: 1.08, holdDays: 3,
  buyCooldownDays: BUY_COOLDOWN_DAYS, sellCooldownDays: 1,
};

const cand = (over: Partial<CandidateQuote> = {}): CandidateQuote => ({
  code: "600519", name: "贵州茅台", price: 20, pct: 4.0, mainNet: 5e8,
  floatCap: 8e11, upRatio: 0.8, riseBp: 40, score: 30, ...over,
});

test("涨幅在 3%~6% 之外不买", () => {
  assert.equal(buyOrders(CFG, [cand({ pct: PCT_MIN - 0.1 })], []).length, 0);
  assert.equal(buyOrders(CFG, [cand({ pct: PCT_MAX + 0.1 })], []).length, 0);
  assert.equal(buyOrders(CFG, [cand()], []).length, 1);
});

test("ST、涨停附近、稳步度不够、主力净额不足都剔除", () => {
  assert.equal(buyOrders(CFG, [cand({ name: "ST某某" })], []).length, 0);
  assert.equal(buyOrders(CFG, [cand({ code: "600000", pct: 9.6 })], []).length, 0);   // 被 PCT_MAX=6 拦下(涨停守卫在 buyOrders 内不可达,属防御常量)
  assert.equal(buyOrders(CFG, [cand({ code: "300308", pct: 19.2 })], []).length, 0);  // 被 PCT_MAX=6 拦下(同上)
  assert.equal(buyOrders(CFG, [cand({ upRatio: UP_RATIO_MIN - 0.05 })], []).length, 0);
  assert.equal(buyOrders(CFG, [cand({ riseBp: RISE_BP_MIN - 1 })], []).length, 0);
  assert.equal(buyOrders(CFG, [cand({ mainNet: 1e6, floatCap: 8e11 })], []).length, 0); // 0.0125bp < 5bp
});

test("主力净额绝对兜底:无流通市值时要求 ≥ 2000 万", () => {
  assert.equal(buyOrders(CFG, [cand({ floatCap: null, mainNet: 1e7 })], []).length, 0);
  assert.equal(buyOrders(CFG, [cand({ floatCap: null, mainNet: MAIN_NET_ABS_MIN })], []).length, 1);
});

test("涨停阈值按板块区分", () => {
  assert.equal(limitPctOf("600000"), 9.5);   // 主板 10%
  assert.equal(limitPctOf("300308"), 19);    // 创业板 20%
  assert.equal(limitPctOf("688981"), 19);    // 科创板 20%
  assert.equal(limitPctOf("830799"), 29);    // 北交所 30%
});

const CAL: CalendarFacts = {
  last_trading_day: "2026-10-27", previous_trading_day: "2026-10-26",
  is_today_trading_day: true, session_phase: "trading",
};
const hist = (trades: AutoTradeHistory["trades"]): AutoTradeHistory => ({ trades });
const held = (over: Partial<AutoTradeHolding> = {}): AutoTradeHolding => ({
  symbol: "600519", name: "贵州茅台", shares: 500, unitCost: 1700 * 1.001,
  openedAt: "2026-10-23", price: 1700, mainToday: 5e8, negMinutes: 0, ...over,
});

test("单笔 10 万整手、目标仓位 50%、最多 5 只", () => {
  const [o] = buyOrders(CFG, [cand({ price: 10 })], []) as Extract<Order, { kind: "buy" }>[];
  assert.equal(o.shares, 9900);            // floor(100000/10.01/100)*100
  assert.equal(o.price, 10.01);            // +0.1% 滑点
  assert.ok(o.note.startsWith("auto_fflow|"));
  const five = [1, 2, 3, 4, 5].map((i) => cand({ code: `60000${i}`, name: `票${i}`, price: 10 }));
  assert.equal(buyOrders(CFG, five, []).length, 5);
  assert.equal(buyOrders(CFG, [...five, cand({ code: "600006", name: "票6", price: 10 })], []).length, 5);  // 第 6 只被额度拒
  assert.equal(buyOrders(CFG, [cand({ code: "600519" })], [held()]).length, 0);  // 已持有不买
});

test("已持有不买;买入冷却 3 个交易日、卖出冷却当日+次日", () => {
  assert.equal(buyOrders(CFG, [cand()], [held()]).length, 0);
  const DAYS = ["2026-10-23", "2026-10-26", "2026-10-27"];   // 含今天的最近 3 个交易日
  const boughtYesterday: AutoTradeHistory = hist([
    { symbol: "600519", type: "buy", date: "2026-10-26" }]);
  assert.equal(buyOrders(CFG, [cand()], [], boughtYesterday, CAL, DAYS).length, 0);
  const soldYesterday: AutoTradeHistory = hist([
    { symbol: "600519", type: "sell", date: "2026-10-26" }]);
  assert.equal(buyOrders(CFG, [cand()], [], soldYesterday, CAL, DAYS).length, 0);
  const soldBeforeYesterday: AutoTradeHistory = hist([
    { symbol: "600519", type: "sell", date: "2026-10-23" }]);
  assert.equal(buyOrders(CFG, [cand()], [], soldBeforeYesterday, CAL, DAYS).length, 1);
});

test("卖出四规则:止损/止盈/形态破坏/到期强平,T+1 新仓不卖", () => {
  const DAYS = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27"];
  const orders = (h: AutoTradeHolding, trades: AutoTradeHistory["trades"] = [], cal: CalendarFacts = CAL, days = DAYS) =>
    sellOrders(CFG, [h], hist(trades), cal, days);
  const stop = orders(held({ price: 1700 * 0.95 * 0.999 }));       // 刚好破 -5%
  assert.equal(stop[0]?.reason, "sell_stop");
  const tp = orders(held({ price: 1700 * 1.001 * 1.08 * 1.001 }));  // 滑点后仍 ≥ cost×1.08
  assert.equal(tp[0]?.reason, "sell_take_profit");
  const curve = orders(held({ negMinutes: 30, price: 1700 }));
  assert.equal(curve[0]?.reason, "sell_curve");
  assert.equal(orders(held({ negMinutes: 25, price: 1700 })).length, 0);  // 不足 30 分钟
  const expiry = orders(held({ openedAt: "2026-10-22", price: 1700 }));
  assert.equal(expiry[0]?.reason, "sell_expiry");                  // 10-23/26/27 满 3 个交易日
  const boughtToday = orders(held({ openedAt: "2026-10-27", price: 1700 * 0.9 }),
    [{ symbol: "600519", type: "buy", date: "2026-10-27" }]);
  assert.equal(boughtToday.length, 0);                             // T+1(今天有买入记录)
  const stopNote = (stop[0] as Extract<Order, { kind: "sell" }>).note;
  assert.ok(stopNote.includes("rule=sell_stop") && stopNote.includes("cost="));
});

test("parseAutoNote 只认 auto_fflow 前缀,其余返回 null", () => {
  assert.equal(parseAutoNote("auto_fflow|rule=buy|pct=4")?.rule, "buy");
  assert.equal(parseAutoNote("手工记账"), null);
  assert.equal(parseAutoNote(""), null);
});

test("日历与 tradingDays 不一致(indexOf=-1):冷却显式禁用放行、不崩溃,到期强平不触发", () => {
  const days = ["2026-10-20", "2026-10-21", "2026-10-22"];   // 不含 cal.last_trading_day
  const h = hist([
    { symbol: "600519", type: "buy", date: "2026-10-26" },
    { symbol: "600519", type: "sell", date: "2026-10-26" }]);
  // 冷却判定视为不可用(null):即使 history 里近 3 日有买卖,也放行且不崩溃
  assert.equal(buyOrders(CFG, [cand()], [], h, CAL, days).length, 1);
  // 到期强平不触发:openedAt 之后满几个交易日无法确认,保守不卖
  const expiry = sellOrders(CFG, [held({ openedAt: "2026-10-20", price: 1700 })], hist([]), CAL, days);
  assert.equal(expiry.length, 0);
});

test("T+1 防御:openedAt=今天即不卖,即使 history 缺当日买入记录", () => {
  const DAYS = ["2026-10-23", "2026-10-26", "2026-10-27"];
  const orders = sellOrders(CFG, [held({ openedAt: "2026-10-27", price: 1700 * 0.9 })], hist([]), CAL, DAYS);
  assert.equal(orders.length, 0);   // 现价破止损,但 T+1 新仓必须跳过
});

test("卖出释放额度补位:5 只吃满 50 万预算时新票被拒,卖出一只后同候选补 1 笔", () => {
  const fiveHeld: AutoTradeHolding[] = [1, 2, 3, 4, 5].map((i) => ({
    symbol: `60001${i}`, name: `持${i}`, shares: 5000, unitCost: 20,
    openedAt: "2026-10-23", price: 20, mainToday: 1e8, negMinutes: 0,
    positionValue: 1e5,                    // 每只 10 万,吃满 50 万预算
  }));
  const signal = cand({ code: "600099", name: "新票", price: 10 });
  assert.equal(buyOrders(CFG, [signal], fiveHeld).length, 0);   // 额度满(上限 5 只,预算也满)
  const afterSell = fiveHeld.slice(0, 4);                       // 卖出一只:重放后 holdings 只剩 4 只
  const [o] = buyOrders(CFG, [signal], afterSell) as Extract<Order, { kind: "buy" }>[];
  assert.equal(o.symbol, "600099");
  assert.equal(o.shares, 9900);                                 // 仍按单笔 10 万整手补位
});
