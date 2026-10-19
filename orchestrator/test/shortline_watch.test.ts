import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import "../src/finance/register.ts";
import "../src/finance/register_tasks.ts";
import { ServiceError, ledgerSnapshot, ledgerUpsert, type ServiceContext } from "../src/service.ts";
import {
  COOLDOWN_MS, alertsFile, detect, pnlPct, inSessionQuote, loadAlerts, myStocks, newDetectState, phaseOf, pollMsOf, resetWatchState,
  shortlineWatchAct, shortlineWatchAlerts, sourcesOf, wquotesOf, type WQuote,
} from "../src/finance/shortline/watch.ts";
import { listViews } from "../src/views.ts";

const DAY = "2026-10-12";             // 周一
const PREV = "2026-10-09";
const sh = (hms: string, day = DAY) => new Date(`${day}T${hms.length === 5 ? `${hms}:00` : hms}+08:00`);
const signal = new AbortController().signal;

function tmpCtx(): ServiceContext {
  return { repoRoot: process.cwd(), dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), "vra-watch-")), python: "python3", node: process.execPath };
}
const clean = (ctx: ServiceContext) => { fs.rmSync(ctx.dataRoot, { recursive: true, force: true }); resetWatchState(); };

const key = (c: string) => `${/^6/.test(c) ? "sh" : "sz"}${c}`;
type Q = { price: number; pct?: number; limit_up?: number; time?: string; name?: string; amount_wan?: number };
const quoteEnv = (rows: Record<string, Q>) => ({
  status: "ok",
  evidence: Object.entries(rows).flatMap(([c, q]) => Object.entries({
    price: q.price, change_pct: q.pct ?? 0, limit_up_price: q.limit_up ?? Number((q.price * 1.1).toFixed(2)),
    quote_time: q.time ?? "20261012100000", security_name: q.name ?? `股${c}`, turnover_amount: q.amount_wan ?? 1000,
  }).map(([field, value]) => ({ record_key: key(c), field, value, period: DAY }))),
});
const calEnv = (isToday = true, period = DAY) => ({
  status: "ok",
  evidence: Object.entries({ last_trading_day: isToday ? DAY : PREV, previous_trading_day: PREV, is_today_trading_day: isToday, session_phase: "continuous" })
    .map(([field, value]) => ({ field, value, period })),
});
const LADDER = [
  { code: "600825", name: "新华传媒", boards: 4, label: "4板", sector: "出版" },
  { code: "000001", name: "甲", boards: 1, label: "首板", sector: "银行" },
];
const BIG = Array.from({ length: 60 }, (_, i) => ({ code: String(600100 + i), name: `大${i}`, mcap: 900 - i }));

/** 假取数:行情按 prices 表回(prices 可随时改);记下调用 */
function world(over: Partial<Record<string, unknown>> = {}) {
  const prices: Record<string, Q> = {};
  const calls: { endpoint: string; args?: Record<string, unknown>; consistency?: unknown }[] = [];
  const fetch = async (_ctx: ServiceContext, req: { endpoint: string; args?: Record<string, unknown>; consistency?: unknown }) => {
    calls.push({ endpoint: req.endpoint, args: req.args, consistency: req.consistency });
    if (req.endpoint in over) {
      const v = over[req.endpoint];
      if (v instanceof Error) throw v;
      return { envelope: (typeof v === "function" ? (v as (r: typeof req) => unknown)(req) : v) as Record<string, unknown> };
    }
    if (req.endpoint === "fetch_trade_calendar") return { envelope: calEnv() };
    if (req.endpoint === "cn_shortline_ladder") return { envelope: { status: "ok", evidence: [], extra: { result: { quote_date: req.args!.date, sample_date: PREV, stocks: LADDER, highest: 4 } } } };
    if (req.endpoint === "cn_shortline_turnover_top") return { envelope: { status: "ok", evidence: [], extra: { result: { date: req.args!.date, stocks: [{ code: "300750", name: "宁德时代", amount: 1e10, rank: 1 }] } } } };
    if (req.endpoint === "cn_shortline_bigcaps") return { envelope: { status: "ok", evidence: [], extra: { result: { date: DAY, count: BIG.length, stocks: BIG } } } };
    if (req.endpoint === "tx_quotes_batch") {
      const codes = req.args!.codes as string[];
      return { envelope: quoteEnv(Object.fromEntries(codes.filter((c) => prices[c]).map((c) => [c, prices[c]!]))) };
    }
    throw new Error(`没料到的端点 ${req.endpoint}`);
  };
  return { fetch, calls, prices };
}
/** 可拨的钟 */
function dial(hms: string) {
  let t = sh(hms);
  return { clock: () => t, set: (x: string) => { t = sh(x); } };
}
const poll = (ctx: ServiceContext, w: ReturnType<typeof world>, c: ReturnType<typeof dial>) =>
  shortlineWatchAct(ctx, { action: "poll" }, signal, { fetch: w.fetch, clock: c.clock });
const quotesAsked = (w: ReturnType<typeof world>) => w.calls.filter((c) => c.endpoint === "tx_quotes_batch").flatMap((c) => c.args!.codes as string[]);

test("时段按北京时间分;请求间隔:连续竞价 3 秒、竞价午休 15 秒、其余和休市日 60 秒", () => {
  assert.deepEqual(["09:14", "09:15", "09:29:59", "09:30", "11:29:59", "11:30", "12:59", "13:00", "14:56:59", "14:57", "14:59:59", "15:00"].map((h) => phaseOf(sh(h))),
    ["pre_open", "auction", "auction", "morning", "morning", "lunch", "lunch", "afternoon", "afternoon", "closing_auction", "closing_auction", "closed"]);
  assert.equal(phaseOf(sh("10:00", "2026-10-11")), "weekend");
  assert.equal(phaseOf(new Date("2026-10-12T01:59:00Z")), "morning", "用北京时间,不用本机时区");
  assert.deepEqual([pollMsOf("morning", true), pollMsOf("morning", null), pollMsOf("lunch", true), pollMsOf("pre_open", true), pollMsOf("closed", true), pollMsOf("morning", false)],
    [3000, 3000, 15000, 60000, 60000, 60000]);
});

test("异动判断:攒够 1 分钟才比;和 3 分钟窗口里最早一帧比,涨跌 ≥ 1.5% 报急拉 / 急跌;5 分钟冷却;封板开板只在状态变化时报", () => {
  const st = newDetectState();
  const at = (s: number) => sh("10:00").getTime() + s * 1000;
  const q = (price: number, limit_up: number | null = 11) => ({ name: "甲", price, pct: 1, limit_up });
  assert.deepEqual(detect(st, "000001", q(10), at(0), "10:00:00", ["持仓"]), [], "第一帧只记,封板状态也只记");
  assert.deepEqual(detect(st, "000001", q(10.2), at(30), "10:00:30", ["持仓"]), [], "不到 1 分钟不判");
  const a = detect(st, "000001", q(10.2), at(60), "10:01:00", ["持仓"]);
  assert.equal(a.length, 1);
  assert.deepEqual([a[0]!.kind, a[0]!.change_pct, a[0]!.sources, a[0]!.ts], ["急拉", 2, ["持仓"], "10:01:00"]);
  assert.match(a[0]!.msg, /1 分钟 \+2\.0%/);
  assert.deepEqual(detect(st, "000001", q(10.4), at(90), "10:01:30", []), [], "5 分钟内同类不再报");
  // 10@0 已滑出 3 分钟窗口,和窗口内最早的 10.2@30 比:跌 1.96%(要是还和 10@0 比就是 0%)
  assert.deepEqual(detect(st, "000001", q(10), at(200), "10:03:20", []).map((x) => [x.kind, x.change_pct]), [["急跌", -1.96]]);
  assert.deepEqual(detect(st, "000001", q(11), at(210), "10:03:30", []).map((x) => x.kind), ["封板"], "急拉还在冷却,只报封板");
  assert.deepEqual(detect(st, "000001", q(10.5), at(260), "10:04:20", []).map((x) => x.kind), ["开板"]);
  // 冷却:每 30 秒涨 1%,一直满足急拉条件 —— 只在 60 秒和冷却期满的 360 秒报
  const st2 = newDetectState();
  const fired: number[] = [];
  for (let t = 0; t <= 420; t += 30) if (detect(st2, "600001", q(10 * (1 + 0.01 * t / 30), null), t * 1000, "", []).some((x) => x.kind === "急拉")) fired.push(t);
  assert.deepEqual(fired, [60, 360]);
  assert.equal(COOLDOWN_MS, 300_000);
  // 没有涨停价(行情没给)就不判封板
  const st3 = newDetectState();
  detect(st3, "000002", q(10, null), 0, "", []);
  assert.deepEqual(detect(st3, "000002", q(10, null), 1000, "", []), []);
  assert.equal(st3.limit.size, 0);
});

test("行情读取:只认 6 位个股;成交额万元换成元;行情时间必须是今天、上午过 09:30、下午过 13:00", () => {
  const m = wquotesOf([quoteEnv({ "600825": { price: 11, pct: 10, amount_wan: 12345, time: "20261012100003" } })]);
  assert.deepEqual(m.get("600825"), { name: "股600825", price: 11, pct: 10, amount_yuan: 123_450_000, limit_up: 12.1, quote_time: "20261012100003" });
  const q = (time: string): WQuote => ({ name: "", price: 1, pct: 0, amount_yuan: null, limit_up: null, quote_time: time });
  assert.equal(inSessionQuote(q("20261012093001"), DAY, "morning"), true);
  assert.equal(inSessionQuote(q("20261012092503"), DAY, "morning"), false, "开盘竞价的报价不进比较");
  assert.equal(inSessionQuote(q("20261012113000"), DAY, "afternoon"), false, "午休前最后一笔不算下午");
  assert.equal(inSessionQuote(q("20261009150003"), DAY, "morning"), false, "节前的报价");
  assert.equal(inSessionQuote(q("202610121000"), DAY, "morning"), false, "格式不对");
});

test("名单:持仓和自选只要 A 股(B 股、港美股不进);每只票带上为什么在名单里", () => {
  const ctx = tmpCtx();
  try {
    ledgerUpsert(ctx, { kind: "position", record: { symbol: "600825", name: "新华传媒", shares: 100, cost: 5 } });
    ledgerUpsert(ctx, { kind: "position", record: { symbol: "900901", name: "B股", shares: 100, cost: 1 } });
    ledgerUpsert(ctx, { kind: "watch", record: { symbol: "300750", name: "宁德时代" } });
    ledgerUpsert(ctx, { kind: "watch", record: { symbol: "AAPL", name: "苹果" } });
    ledgerUpsert(ctx, { kind: "watch", record: { symbol: "00700.HK", name: "腾讯" } });
    const snap = ledgerSnapshot(ctx);
    const { holdings, watch } = myStocks(snap.records, snap.issues);
    assert.deepEqual(holdings, [{ code: "600825", name: "新华传媒" }]);
    assert.deepEqual(watch, [{ code: "300750", name: "宁德时代" }]);
    // 浮动盈亏:旧持有记录的 cost 是每股成本;两个账户合起来算;成本 ≤ 0 算不出比例
    ledgerUpsert(ctx, { kind: "position", record: { symbol: "600825", name: "新华传媒", account: "另一户", shares: 300, cost: 7 } });
    ledgerUpsert(ctx, { kind: "position", record: { symbol: "000002", name: "乙", shares: 100, cost: -1 } });
    const s2 = ledgerSnapshot(ctx);
    const costs = myStocks(s2.records, s2.issues).costs;
    assert.deepEqual(costs.get("600825"), { shares: 400, cost_total: 2600 });
    assert.equal(pnlPct(7.8, costs.get("600825")), 20);
    assert.equal(pnlPct(7.8, costs.get("000002")), null);
    assert.equal(pnlPct(null, costs.get("600825")), null);
    const tags = sourcesOf({
      holdings: [{ code: "600825", name: "" }], watch: [{ code: "600825", name: "" }],
      ladder: { sample_date: PREV, quote_date: DAY, highest: 4, stocks: [{ code: "600825", name: "", boards: 4, label: "4板", sector: "" }] },
      turnover: null, bigcaps: { date: DAY, total: 1, stocks: [{ code: "600519", name: "" }] },
    });
    assert.deepEqual(tags.get("600825"), ["持仓", "自选", "昨日4板"]);
    assert.deepEqual(tags.get("600519"), ["大票"]);
  } finally { clean(ctx); }
});

test("盘中轮询:持仓 / 梯队每次现取,大票 30 秒一次;3 分钟内拉升记成异动并写进当天文件;多个窗口 2.5 秒内共用一次结果", async () => {
  const ctx = tmpCtx();
  try {
    ledgerUpsert(ctx, { kind: "position", record: { symbol: "000001", name: "甲", shares: 100, cost: 5 } });
    ledgerUpsert(ctx, { kind: "watch", record: { symbol: "900901", name: "B股" } });
    const w = world();
    for (const s of [...LADDER.map((x) => x.code), "300750", ...BIG.map((x) => x.code)]) w.prices[s] = { price: 10, pct: 1 };
    w.prices["600825"] = { price: 11, pct: 10, limit_up: 11 };
    const c = dial("10:00:00");
    const v1 = await poll(ctx, w, c);
    assert.equal(v1.phase, "morning");
    assert.equal(v1.detecting, true);
    assert.equal(v1.poll_ms, 3000);
    assert.equal(v1.trading_day, true);
    assert.deepEqual(v1.holdings.map((h) => [h.code, h.price, h.pct, h.pnl_pct]), [["000001", 10, 1, 100]]);
    assert.ok(!("shares" in v1.holdings[0]!) && !("cost" in v1.holdings[0]!), "持仓只列价格涨跌,不带股数成本");
    assert.deepEqual(v1.watchlist, [], "B 股不进");
    assert.deepEqual(v1.ladder!.rows.map((r) => [r.code, r.label, r.at_limit]), [["600825", "4板", true], ["000001", "首板", false]]);
    assert.equal(v1.turnover!.date, PREV, "昨日成交额前十按梯队的样本日取");
    assert.deepEqual(v1.turnover!.rows.map((r) => r.code), ["300750"]);
    assert.equal(v1.bigcap!.total, 60);
    assert.equal(v1.bigcap!.top.length, 10);
    assert.equal(w.calls.find((x) => x.endpoint === "cn_shortline_ladder")!.args!.date, DAY, "梯队盯今天这一场");
    assert.ok(w.calls.filter((x) => x.endpoint === "tx_quotes_batch").every((x) => JSON.stringify(x.consistency) === '{"mode":"fresh"}'), "连续竞价里行情现取");
    const first = quotesAsked(w).length;
    assert.equal(first, 3 + 60, "持仓、梯队、前十去重后 3 只 + 大票 60 只");

    // 1 秒后另一个窗口来问:共用上一次结果,不再取
    c.set("10:00:01");
    const again = await poll(ctx, w, c);
    assert.equal(again, v1);
    assert.equal(quotesAsked(w).length, first);

    // 同时来两个请求:只取一份
    c.set("10:00:05");
    w.prices["000001"] = { price: 10.05, pct: 1.5 };
    const [p1, p2] = await Promise.all([poll(ctx, w, c), poll(ctx, w, c)]);
    assert.equal(p1, p2);
    const asked = quotesAsked(w).slice(first);
    assert.ok(!asked.includes("600100"), "大票不到 30 秒不重取");
    assert.ok(asked.includes("000001") && asked.includes("600825"));

    // 90 秒后持仓急拉 2%,梯队 4 板开板
    c.set("10:01:30");
    w.prices["000001"] = { price: 10.2, pct: 3, time: "20261012100130" };
    w.prices["600825"] = { price: 10.8, pct: 8, limit_up: 11, time: "20261012100130" };
    const v2 = await poll(ctx, w, c);
    const kinds = v2.alerts.map((a) => `${a.code}${a.kind}`).sort();
    assert.deepEqual(kinds, ["000001急拉", "600825急跌", "600825开板"].sort());
    const up = v2.alerts.find((a) => a.kind === "急拉")!;
    assert.deepEqual([up.ts, up.sources], ["10:01:30", ["持仓", "昨日1板"]]);
    assert.ok(quotesAsked(w).includes("600100"), "过了 30 秒大票重取");
    // 写进当天文件,后台重启后接着显示
    assert.equal(fs.readFileSync(alertsFile(ctx.dataRoot, DAY), "utf8").trim().split("\n").length, 3);
    resetWatchState();
    c.set("10:01:40");
    const v3 = await poll(ctx, w, c);
    assert.equal(v3.alerts.length, 3);
    assert.deepEqual((await shortlineWatchAlerts(ctx, {}, signal, sh("10:02"))).alerts.length, 3);
  } finally { clean(ctx); }
});

test("竞价和午休的报价不进比较(VA 同口径):午休清掉比较基准,下午第一帧只记;竞价那一笔不当基准", async () => {
  const ctx = tmpCtx();
  try {
    ledgerUpsert(ctx, { kind: "watch", record: { symbol: "000001", name: "甲" } });
    const w = world({ cn_shortline_bigcaps: { status: "ok", evidence: [], extra: { result: { date: DAY, count: 0, stocks: [] } } } });
    w.prices["000001"] = { price: 11, limit_up: 11, time: "20261012112958" };
    const c = dial("11:29:00");
    const am = await poll(ctx, w, c);
    const atLimit = (v: typeof am) => v.ladder!.rows.find((r) => r.code === "000001")!.at_limit;
    assert.equal(atLimit(am), true);
    c.set("11:31:00");
    const lunch = await poll(ctx, w, c);
    assert.deepEqual([lunch.phase, lunch.detecting, lunch.poll_ms], ["lunch", false, 15000]);
    assert.equal(atLimit(lunch), null, "午休时不说封没封");
    c.set("13:00:10");
    w.prices["000001"] = { price: 10.8, limit_up: 11, time: "20261012130008" };
    assert.equal((await poll(ctx, w, c)).alerts.length, 0, "封板状态午休时清掉了:下午第一帧只记,不报开板");
    c.set("13:01:20");
    w.prices["000001"] = { price: 11, limit_up: 11, time: "20261012130118" };
    assert.deepEqual((await poll(ctx, w, c)).alerts.map((a) => a.kind).sort(), ["封板", "急拉"].sort(), "下午内部的变化照常报(10.8 → 11 同时是 70 秒涨 1.85%)");

    // 开盘竞价:报价时间停在 09:25 的那一笔不进比较
    resetWatchState();
    w.prices["000001"] = { price: 9, limit_up: 11, time: "20261012092503" };
    c.set("09:26:00");
    const auc = await poll(ctx, w, c);
    assert.deepEqual([auc.phase, auc.detecting, auc.poll_ms], ["auction", false, 15000]);
    const base = auc.alerts.length;   // 下午那两条已写进当天文件,重启后接着显示
    c.set("09:30:02");
    assert.equal((await poll(ctx, w, c)).alerts.length, base, "连续竞价开始了但行情还停在竞价那一笔");
    c.set("09:31:10");
    w.prices["000001"] = { price: 9.5, limit_up: 11, time: "20261012093108" };
    await poll(ctx, w, c);
    c.set("09:32:20");
    assert.equal((await poll(ctx, w, c)).alerts.length, base, "9 → 9.5 的竞价差没被当成急拉");
  } finally { clean(ctx); }
});

test("今天休市:不判断、间隔 60 秒、写明休市;行情时间不是今天的行标成「不是今天」", async () => {
  const ctx = tmpCtx();
  try {
    ledgerUpsert(ctx, { kind: "watch", record: { symbol: "000001", name: "甲" } });
    const w = world({ fetch_trade_calendar: calEnv(false) });
    w.prices["000001"] = { price: 10, time: "20261009150003" };
    const c = dial("10:00:00");
    const v = await poll(ctx, w, c);
    assert.deepEqual([v.trading_day, v.detecting, v.poll_ms, v.phase_label], [false, false, 60000, "今天休市"]);
    assert.equal(v.watchlist[0]!.today, false);
    assert.equal(w.calls.find((x) => x.endpoint === "cn_shortline_ladder")!.args!.date, PREV, "休市日梯队盯最近一个交易日");
    assert.ok(w.calls.filter((x) => x.endpoint === "tx_quotes_batch").every((x) => x.consistency === undefined), "非连续竞价允许用缓存");
    // 60 秒内再问:不重取行情
    const n = quotesAsked(w).length;
    c.set("10:00:30");
    await poll(ctx, w, c);
    assert.equal(quotesAsked(w).length, n);
  } finally { clean(ctx); }
});

test("取不到的照实说:日历没取到、日历日期对不上、名单没取到、某批行情没取到 —— 不拿旧价冒充现价", async () => {
  const ctx = tmpCtx();
  try {
    ledgerUpsert(ctx, { kind: "watch", record: { symbol: "000001", name: "甲" } });
    let fail = false;
    const w = world({
      fetch_trade_calendar: calEnv(true, PREV),     // 日期不是今天 = 没取到
      cn_shortline_bigcaps: new Error("网络断了"),
      tx_quotes_batch: () => (fail ? { status: "failed", evidence: [] } : quoteEnv({ "000001": { price: 10, time: "20261012100000" } })),
    });
    const c = dial("10:00:00");
    const v = await poll(ctx, w, c);
    assert.equal(v.trading_day, null);
    assert.equal(v.ladder, null);
    assert.equal(v.bigcap, null);
    assert.match(v.notes.join("\n"), /交易日历没取到/);
    assert.match(v.notes.join("\n"), /500 亿以上大票名单没取到/);
    assert.equal(v.detecting, true, "日历没取到时照常判断,靠行情时间挡节假日");
    assert.equal(v.watchlist[0]!.price, 10);
    fail = true;
    c.set("10:00:04");
    const v2 = await poll(ctx, w, c);
    assert.equal(v2.watchlist[0]!.price, null, "这轮没取到就显示没取到");
    assert.match(v2.notes.join("\n"), /1 批没取到/);
  } finally { clean(ctx); }
});

test("异动回看:坏行跳过;日期要合法、不能是以后;写动作只认 poll;视图已登记", async () => {
  const ctx = tmpCtx();
  try {
    fs.mkdirSync(path.dirname(alertsFile(ctx.dataRoot, PREV)), { recursive: true });
    fs.writeFileSync(alertsFile(ctx.dataRoot, PREV), [
      JSON.stringify({ ts: "10:00:00", code: "000001", name: "甲", kind: "急拉", change_pct: 2, price: 10, pct: 3, msg: "x", sources: [] }),
      "{坏行",
      JSON.stringify({ ts: "10:01:00", code: "00700", name: "港股", kind: "急拉", msg: "x", sources: [] }),
      JSON.stringify({ ts: "10:02:00", code: "000002", name: "乙", kind: "乱写", msg: "x", sources: [] }),
      JSON.stringify({ ts: "10:03:00", code: "000003", name: "丙", kind: "封板", change_pct: null, price: 11, pct: 10, msg: "y", sources: ["自选"] }),
    ].join("\n"));
    assert.deepEqual(loadAlerts(ctx.dataRoot, PREV).map((a) => a.code), ["000003", "000001"], "新的在前");
    assert.deepEqual((await shortlineWatchAlerts(ctx, { date: PREV }, signal, sh("10:00"))).alerts.length, 2);
    await assert.rejects(shortlineWatchAlerts(ctx, { date: "2026-13-01" }, signal, sh("10:00")), ServiceError);
    await assert.rejects(shortlineWatchAlerts(ctx, { date: "2026-10-13" }, signal, sh("10:00")), /还没到/);
    await assert.rejects(shortlineWatchAct(ctx, { action: "capture" }, signal), /只能是 poll/);
    assert.ok(listViews().some((v) => v.id === "shortline_watch"));
  } finally { clean(ctx); }
});
