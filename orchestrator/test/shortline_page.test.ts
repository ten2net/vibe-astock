/**
 * 情绪复盘页的界面查询:默认看哪一天、用户选日期时用哪一天、别的参数改不了。全程不联网 —— 取数换成假的。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import "../src/finance/register.ts";
import { currentPlugin } from "../src/plugin.ts";
import { pageQuery, type FetchResult, type ServiceContext } from "../src/service.ts";

const CAL = (phase: string) => ({
  status: "ok",
  evidence: [
    { field: "last_trading_day", value: "2026-10-09" },
    { field: "previous_trading_day", value: "2026-10-08" },
    { field: "is_today_trading_day", value: true },
    { field: "session_phase", value: phase },
  ],
});

type Call = { endpoint: string; args?: Record<string, unknown> };
function fakeFetch(phase: string) {
  const calls: Call[] = [];
  const fetch = (async (_ctx: ServiceContext, req: { endpoint: string; args?: Record<string, unknown> }): Promise<FetchResult> => {
    calls.push({ endpoint: req.endpoint, args: req.args });
    const env = req.endpoint === "fetch_trade_calendar" ? CAL(phase) : { status: "ok", evidence: [{ field: "x", value: 1 }] };
    return { envelope: env, exit_code: 0, out_dir: "", duration_ms: 1, stderr_tail: "", cached: false, fetched_at: "2026-10-09T13:00:00+08:00" };
  }) as never;
  return { calls, fetch };
}
const ctx = {} as ServiceContext;
const emotionArgs = (calls: Call[]) => calls.filter((c) => c.endpoint === "cn_shortline_emotion").map((c) => c.args);

test("情绪复盘拆成几个查询:第一个解析业务日,其余只吃页面传来的日期", () => {
  const qs = currentPlugin().pageQueries ?? {};
  const ends = (q: string) => qs[q]?.blocks.map((b) => b.endpoint);
  assert.deepEqual(ends("shortline"), ["cn_shortline_emotion"]);
  assert.deepEqual(ends("shortline_facts"), ["cn_shortline_facts"]);
  assert.deepEqual(ends("shortline_themes"), ["cn_shortline_themes", "cn_shortline_firstboard"]);
  assert.deepEqual(ends("shortline_cycle"), ["cn_shortline_cycle"]);
  assert.deepEqual(ends("shortline_ladder"), ["cn_shortline_board_ladder"]);
  assert.deepEqual(ends("shortline_rotation"), ["cn_shortline_theme_rotation"]);
  assert.equal(qs.shortline!.needsContext, true);
  const rest = ["shortline_facts", "shortline_themes", "shortline_cycle", "shortline_ladder", "shortline_rotation"];
  for (const q of ["shortline", ...rest]) {
    for (const b of qs[q]!.blocks) assert.deepEqual([...(b.userArgs ?? [])], ["date"], `${q}/${b.id} 只开放日期`);
  }
  for (const q of rest) assert.ok(!qs[q]!.needsContext, `${q} 不再解析一次上下文`);
  // 原有各页的顺序不变(AI 浏览、测试里取第一个查询的地方都不受影响)
  assert.equal(Object.keys(qs)[0], "today");
});

test("🔴 盘中打开看上一个交易日(半天的数不是复盘),收盘后看今天", async () => {
  const a = fakeFetch("trading");
  const r = await pageQuery(ctx, { query: "shortline" }, { fetch: a.fetch });
  assert.equal(r.context?.review_date, "2026-10-08");
  assert.deepEqual(emotionArgs(a.calls), [{ date: "2026-10-08" }], "注入的是 YYYY-MM-DD");

  const b = fakeFetch("post_close");
  await pageQuery(ctx, { query: "shortline" }, { fetch: b.fetch });
  assert.deepEqual(emotionArgs(b.calls), [{ date: "2026-10-09" }]);
});

test("用户选了日期就用那天;夹带的其它参数一律丢掉", async () => {
  const { calls, fetch } = fakeFetch("trading");
  const r = await pageQuery(ctx, { query: "shortline", blockArgs: { emotion: { date: "2026-09-30", lookback: 99 } } }, { fetch });
  assert.deepEqual(emotionArgs(calls), [{ date: "2026-09-30" }]);
  assert.equal(r.context?.review_date, "2026-10-08", "业务日照常给出,页面据此知道默认那天");
  assert.deepEqual(r.blocks[0]!.applied_args, { date: "2026-09-30" });
});

test("后面几个查询:页面传来的日期原样交给端点;不传就按端点默认(最近一个已收盘交易日),不偷偷解析上下文", async () => {
  const a = fakeFetch("trading");
  await pageQuery(ctx, { query: "shortline_themes", blockArgs: { themes: { date: "2026-10-08" }, firstboard: { date: "2026-10-08" } } }, { fetch: a.fetch });
  assert.deepEqual(a.calls.map((c) => [c.endpoint, c.args]).sort(), [["cn_shortline_firstboard", { date: "2026-10-08" }], ["cn_shortline_themes", { date: "2026-10-08" }]]);
  const b = fakeFetch("trading");
  await pageQuery(ctx, { query: "shortline_cycle" }, { fetch: b.fetch });
  assert.deepEqual(b.calls, [{ endpoint: "cn_shortline_cycle", args: {} }]);
  // 轮动的窗口不开放:页面夹带 days 也丢掉,端点按默认 5 天
  const c = fakeFetch("trading");
  await pageQuery(ctx, { query: "shortline_rotation", blockArgs: { rotation: { date: "2026-10-08", days: 10 } } }, { fetch: c.fetch });
  assert.deepEqual(c.calls, [{ endpoint: "cn_shortline_theme_rotation", args: { date: "2026-10-08" } }]);
});
