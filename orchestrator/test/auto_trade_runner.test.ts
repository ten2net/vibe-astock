import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register_tasks.ts";
import { ledgerList, type ServiceContext } from "../src/service.ts";
import { autoTradeBeat, runOnce } from "../src/finance/auto_trade_runner.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAY = "2026-10-23"; // 周五
const PREV = "2026-10-22";
/** 升序、含今天、无未来日(与 fetch_trade_calendar extra.trading_day_list 契约一致) */
const TRADING_DAYS = ["2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21", PREV, DAY];

const calEnv = (period = DAY, isToday = true) => ({
  status: "ok",
  evidence: [
    { field: "last_trading_day", value: isToday ? period : PREV, period },
    { field: "previous_trading_day", value: "2026-10-16", period },
    { field: "is_today_trading_day", value: isToday, period },
    { field: "session_phase", value: "trading", period },
  ],
  extra: { trading_day_list: TRADING_DAYS },
});

/** 新浪榜 schema;一只票(600000),刻意让它的分钟曲线不命中形态 → 榜单无候选 */
const rankEnv = {
  extra: {
    rows: [{ rank: 1, code: "600000", name: "测试股", price: 10, pct: 0.01, main_net: 1e7, float_cap: null, amount: 8e8 }],
    total: 1,
  },
};

/** 从开盘一路匀速拉升(无横盘段、无节奏切换)→ detectSidewaysRise 拒,引擎拿不到候选 */
const minuteEnv = (() => {
  const series = Array.from({ length: 28 }, (_, i) => ({ time: `b${i}`, main: i * 3000 }));
  return {
    fetched_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    extra: { minute_series: series, bar_minutes: 5 },
  };
})();

// —— 造两只「横盘→拉升」命中形态候选(600000 / 600001),让引擎真出两笔买入 ——
const CAP = 1e10; // 分母;bp = 元 / 1e10 * 1e4 → 1bp = 100 万元
const yuan = (bp: number) => (bp * CAP) / 1e4;
const makeBars = (nBars: number, nFlat: number, bandBp: number, riseBp: number) => {
  const out: { time: string; main: number }[] = [];
  let cum = 0;
  for (let i = 0; i < nBars; i++) {
    if (i < nFlat) cum = yuan(i % 2 ? bandBp * 0.4 : bandBp * 0.8);
    else cum += yuan((riseBp / (nBars - nFlat)) * (i % 5 === 0 ? 0.3 : 1.2));
    out.push({ time: `b${i}`, main: Math.round(cum) });
  }
  return out;
};
const candRankEnv = {
  extra: {
    rows: [
      { rank: 1, code: "600000", name: "测试甲", price: 10, pct: 0.04, main_net: 5e7, float_cap: null, amount: 8e8 },
      { rank: 2, code: "600001", name: "测试乙", price: 10, pct: 0.04, main_net: 5e7, float_cap: null, amount: 8e8 },
    ],
    total: 2,
  },
};
const candMinuteEnv = {
  fetched_at: new Date().toISOString().replace("T", " ").slice(0, 19),
  extra: { minute_series: makeBars(28, 12, 4, 90), day_amount: CAP, bar_minutes: 5 },
};

interface Call { endpoint?: string; symbol?: string; args?: unknown }

/** fake fetch:记录全部调用参数;日历可按用例改成抛错或 period 对不上 */
const makeFetch = (calls: Call[], opts: { calendarError?: boolean; calendarPeriod?: string; candidates?: boolean } = {}) =>
  async (_c: unknown, req: Call) => {
    calls.push(req);
    if (req.endpoint === "fetch_trade_calendar") {
      if (opts.calendarError) throw new Error("baostock 登录失败");
      return { envelope: calEnv(opts.calendarPeriod) };
    }
    if (req.endpoint === "sina_market_money_rank") return { envelope: opts.candidates ? candRankEnv : rankEnv };
    if (req.endpoint === "tx_minute_today") return { envelope: opts.candidates ? candMinuteEnv : minuteEnv };
    if (req.endpoint === "em_market_main_net_rank") throw new Error("push2 blocked in this test");
    throw new Error(`没预料到的端点:${req.endpoint}`);
  };

const tmpCtx = () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vra-autotrade-"));
  return { ctx: { repoRoot: REPO, dataRoot, python: "false", node: process.execPath } as ServiceContext, dataRoot };
};

test("回归:日历只取一次且不带 args(带 days 会被 assertArgs 拒,整窗白跑);空候选 → 无订单、不抛错", async () => {
  const { ctx, dataRoot } = tmpCtx();
  try {
    const calls: Call[] = [];
    const r = await runOnce(ctx, DAY, new AbortController().signal, { fetch: makeFetch(calls) as never });
    assert.deepEqual(r.orders, []);
    assert.equal(r.error, undefined, `不该有错误:${r.error ?? ""}`);
    const calCalls = calls.filter((c) => c.endpoint === "fetch_trade_calendar");
    assert.equal(calCalls.length, 1, "日历只取一次(第二次带 days 的调用必须已去掉)");
    for (const c of calCalls) {
      assert.equal(c.args, undefined, `fetch_trade_calendar 不接受 args(registry 没声明),实际:${JSON.stringify(c.args)}`);
    }
    assert.ok(!fs.existsSync(path.join(dataRoot, "notify", "inbox.json")), "没成交不该写收件箱");
  } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
});

test("happy path 最小用例:交易日 + 榜单无候选 → 无订单,不写台账、不写收件箱", async () => {
  const { ctx, dataRoot } = tmpCtx();
  try {
    const calls: Call[] = [];
    const r = await runOnce(ctx, DAY, new AbortController().signal, { fetch: makeFetch(calls) as never });
    assert.deepEqual(r, { orders: [] });
    assert.deepEqual(ledgerList(ctx, "trade").trade ?? [], [], "不该写 trade 台账");
    assert.ok(!fs.existsSync(path.join(dataRoot, "notify", "inbox.json")), "不该写收件箱");
    assert.ok(calls.some((c) => c.endpoint === "sina_market_money_rank"), "榜单取数该走到");
  } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
});

test("日历取不到:fake 抛错 → 返回 error、orders 为空、不抛异常", async () => {
  const { ctx, dataRoot } = tmpCtx();
  try {
    const calls: Call[] = [];
    const r = await runOnce(ctx, DAY, new AbortController().signal, { fetch: makeFetch(calls, { calendarError: true }) as never });
    assert.deepEqual(r.orders, []);
    assert.match(r.error ?? "", /交易日历取不到/);
    assert.equal(calls.filter((c) => c.endpoint === "sina_market_money_rank").length, 0, "日历没过,不该取榜单");
    assert.ok(!fs.existsSync(path.join(dataRoot, "notify", "inbox.json")));
  } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
});

test("日历日期对不上(period≠今天)→ 同样返回 error、orders 为空", async () => {
  const { ctx, dataRoot } = tmpCtx();
  try {
    const r = await runOnce(ctx, DAY, new AbortController().signal,
      { fetch: makeFetch([], { calendarPeriod: PREV }) as never });
    assert.deepEqual(r.orders, []);
    assert.match(r.error ?? "", /交易日历取不到/);
  } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
});

// —— beat:窗口判定与防重(注入时钟,北京时间 = UTC+8)——
const bj = (hm: string) => new Date(`2026-10-23T${hm}:00Z`); // "01:35" → 北京 09:35
const beatArg = (ctx: ServiceContext) => ({
  ctx, signal: new AbortController().signal,
  gate: () => Promise.resolve({ status: "open" as const }),
});
const statePath = (dataRoot: string) => path.join(dataRoot, "auto_trade", "2026-10-23-0575.json");

test("beat:注入时钟 —— 09:34 不在窗口、09:35 跑并封窗、09:36 同窗口直接跳过、14:51 过窗不跑", async () => {
  const { ctx, dataRoot } = tmpCtx();
  try {
    const calls: Call[] = [];
    const deps = { fetch: makeFetch(calls) as never, clock: () => bj("01:34") };
    assert.equal(await autoTradeBeat(beatArg(ctx), deps), undefined, "09:34 未到窗口");
    assert.equal(calls.length, 0, "窗口外不取数");
    deps.clock = () => bj("01:35");
    assert.equal(await autoTradeBeat(beatArg(ctx), deps), undefined, "09:35 跑了(无订单无话术)");
    assert.ok(fs.existsSync(statePath(dataRoot)), "09:35 该封窗");
    const calCalls = calls.filter((c) => c.endpoint === "fetch_trade_calendar").length;
    deps.clock = () => bj("01:36");
    assert.equal(await autoTradeBeat(beatArg(ctx), deps), undefined, "09:36 同窗口");
    assert.equal(calls.filter((c) => c.endpoint === "fetch_trade_calendar").length, calCalls,
      "同窗口第二次调用直接跳过,不再取数");
    deps.clock = () => bj("06:51");
    assert.equal(await autoTradeBeat(beatArg(ctx), deps), undefined, "14:51 过了 14:50 收窗");
    assert.equal(calls.filter((c) => c.endpoint === "fetch_trade_calendar").length, calCalls);
  } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
});

test("半落账:第二笔台账写失败 → 成交 1/2 笔、不封窗、文案如实,下拍原窗口重试且不重复成交", async () => {
  const { ctx, dataRoot } = tmpCtx();
  try {
    const calls: Call[] = [];
    const upsertLog: unknown[] = [];
    // 每笔 round 第 2 笔写失败:第一笔已成功落账
    const upsert = (_c: unknown, req: unknown) => {
      upsertLog.push(req);
      if (upsertLog.length % 2 === 0) throw new Error("磁盘写满");
      return req as never;
    };
    const deps = { fetch: makeFetch(calls, { candidates: true }) as never, clock: () => bj("01:35"), upsert: upsert as never };
    const note = await autoTradeBeat(beatArg(ctx), deps);
    assert.match(note ?? "", /auto_fflow_trade 0575: 成交 1\/2 笔:磁盘写满,窗口未关闭/);
    assert.ok(!fs.existsSync(statePath(dataRoot)), "半落账不许封窗");
    assert.equal(upsertLog.length, 2, "两笔都尝试过");
    assert.ok(!fs.existsSync(path.join(dataRoot, "notify", "inbox.json")), "半落账不发收件箱");
    // 下拍同窗口重试:引擎重新出同样的两笔(第一笔买入没落账,冷却挡不了),再试一遍
    const note2 = await autoTradeBeat(beatArg(ctx), deps);
    assert.match(note2 ?? "", /成交 1\/2 笔/);
    assert.equal(upsertLog.length, 4, "窗口未封,真的重试了");
    assert.ok(!fs.existsSync(statePath(dataRoot)));
    // runOnce 直跑同样语义
    const r = await runOnce(ctx, DAY, new AbortController().signal,
      { fetch: makeFetch([], { candidates: true }) as never, upsert: upsert as never });
    assert.equal(r.orders.length, 1);
    assert.equal(r.pending, true);
    assert.match(r.error ?? "", /成交 1\/2 笔/, "每轮都是两笔里成一笔");
  } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
});

test("signal 已取消:日历取数失败原样上抛,不被当成「取不到」", async () => {
  const { ctx, dataRoot } = tmpCtx();
  try {
    const ac = new AbortController();
    ac.abort();
    const fetch = async () => { throw new Error("取数已取消"); };
    await assert.rejects(
      () => runOnce(ctx, DAY, ac.signal, { fetch: fetch as never }),
      /取数已取消/,
    );
  } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
});
