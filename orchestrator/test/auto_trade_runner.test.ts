import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register_tasks.ts";
import { ledgerList, type ServiceContext } from "../src/service.ts";
import { runOnce } from "../src/finance/auto_trade_runner.ts";

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

interface Call { endpoint?: string; symbol?: string; args?: unknown }

/** fake fetch:记录全部调用参数;日历可按用例改成抛错或 period 对不上 */
const makeFetch = (calls: Call[], opts: { calendarError?: boolean; calendarPeriod?: string } = {}) =>
  async (_c: unknown, req: Call) => {
    calls.push(req);
    if (req.endpoint === "fetch_trade_calendar") {
      if (opts.calendarError) throw new Error("baostock 登录失败");
      return { envelope: calEnv(opts.calendarPeriod) };
    }
    if (req.endpoint === "sina_market_money_rank") return { envelope: rankEnv };
    if (req.endpoint === "tx_minute_today") return { envelope: minuteEnv };
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
