import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { api } from "../src/verticals/finance/lib/api.ts";
import { backend, type FetchResult } from "../src/verticals/finance/lib/backend.ts";
import { mergePolledQuotes, missingQuotes, noQuotesBack, quoteFailure, quoteSnapshotTime } from "../src/verticals/finance/lib/quoteSnapshot.ts";

test("轮询合并：这一轮问了却没返回的股票不留上一轮的旧价；没问的（休市市场）保留（审计 C5）", () => {
  const full = { A: { price: 10 }, B: { price: 20 }, HK1: { price: 300 } };
  assert.deepEqual(mergePolledQuotes(full, { A: { price: 11 } }, ["A", "B"]), { A: { price: 11 }, HK1: { price: 300 } }, "B 这轮没回来：显示「—」");
  assert.deepEqual(mergePolledQuotes(full, { A: { price: 11 }, B: { price: 21 } }, ["A", "B"]), { A: { price: 11 }, B: { price: 21 }, HK1: { price: 300 } });
  assert.deepEqual(mergePolledQuotes(full, { A: { price: 11 } }), { A: { price: 11 } }, "首次 / 手动刷新整体替换");
  const hook = readFileSync(new URL("../src/verticals/finance/hooks/useLiveQuotes.ts", import.meta.url), "utf8");
  assert.ok(hook.includes("setQuotes((prev) => mergePolledQuotes(prev, data, onlyCodes));"));
  assert.ok(!hook.includes("{ ...prev, ...data }"), "不再直接叠在旧快照上");
});

test("自动取数要求 fresh，时间跟随价格证据，不把缓存收到时间冒充源时间", async () => {
  const original = backend.fetch;
  const seen: unknown[] = [];
  const stamp = "2026-09-04T01:30:00Z";
  backend.fetch = async (endpoint, opts) => {
    seen.push({ endpoint, opts });
    return { cached: true, fetched_at: "2026-09-05T01:30:00Z", envelope: {
      fetched_at: "2026-09-05T01:30:00Z", evidence: [
        { record_key: "sh600519", field: "price", value: 100, period: "2026-09-04", fetched_at: stamp },
        { record_key: "sh600519", field: "quote_time", value: "20260904093000", period: "2026-09-04" },
      ],
    } } as FetchResult;
  };
  try {
    const quotes = await api.quote("600519", true);
    assert.equal(quotes["600519"]?.price, 100);
    assert.equal(quotes["600519"]?.fetched_at, stamp);
    assert.equal(quotes["600519"]?.quote_time, "20260904093000", "成交时间原样带下去，首页当日盈亏靠它认节假日");
    assert.equal(quoteSnapshotTime(quotes), Date.parse(stamp));
    assert.deepEqual(seen, [{ endpoint: "tx_quotes_batch", opts: { args: { codes: ["600519"] }, refresh: true } }]);
    const hook = readFileSync(new URL("../src/verticals/finance/hooks/useLiveQuotes.ts", import.meta.url), "utf8");
    assert.match(hook, /api\.quote\(requested, true\)/);
    assert.doesNotMatch(hook, /setUpdatedAt\(Date\.now\(\)\)/);
  } finally { backend.fetch = original; }
});

test("混合市场显示最早快照；空值与缺时间不伪造新时间", () => {
  const old = { price: 10, fetched_at: "2026-09-03T12:00:00Z" };
  const fresh = { price: 20, fetched_at: "2026-09-04T12:00:00Z" };
  assert.equal(quoteSnapshotTime({ old, fresh }), Date.parse(old.fetched_at));
  assert.equal(quoteSnapshotTime({}), null);
  assert.equal(quoteSnapshotTime({ empty: { price: null, fetched_at: fresh.fetched_at } }), null);
  assert.equal(quoteSnapshotTime({ old, unknown: { price: 30 } }), null);
  assert.equal(quoteSnapshotTime({ bad: { price: 30, fetched_at: "bad" } }), null);
});

test("200 但一只都没回来算失败，不能当成成功把表刷成空", () => {
  // 接口返回空表时，旧逻辑算「成功」→ 整体替换成 {} → 每行显示「—」、无提示、刷新无感
  assert.equal(noQuotesBack(["600519", "300308"], {}), true);
  assert.equal(noQuotesBack(["600519"], { "600519": { price: 1 } }), false, "有数据就是成功");
  assert.equal(noQuotesBack([], {}), false, "没有要问的代码不算失败");
  assert.deepEqual(missingQuotes(["600519", "300308"], { "600519": {} }), ["300308"], "部分缺失要点名");
  const hook = readFileSync(new URL("../src/verticals/finance/hooks/useLiveQuotes.ts", import.meta.url), "utf8");
  assert.match(hook, /if \(noQuotesBack\(.*\)\) throw new Error\("empty_quotes"\)/, "空结果必须走失败分支");
});

test("取数失败不把旧价留着当现价：手动刷新失败马上撤价并提示，轮询连续失败才撤（第四轮审计 C1）", () => {
  const prev = { A: { price: 10 }, B: { price: 20 }, HK1: { price: 300 } };
  const manual = quoteFailure(1);
  assert.ok(manual, "手动 / 首次取数第一次失败就要处理（自动取数关着时没有下一拍来纠正）");
  assert.deepEqual(manual.drop(prev), {});
  assert.match(manual.error, /行情获取失败/);
  assert.equal(quoteFailure(1, ["A", "B"]), null, "轮询第一次失败先不打扰");
  const polled = quoteFailure(2, ["A", "B"]);
  assert.ok(polled);
  assert.deepEqual(polled.drop(prev), { HK1: { price: 300 } }, "只撤这一轮问了的，休市市场的快照保留");
  const hook = readFileSync(new URL("../src/verticals/finance/hooks/useLiveQuotes.ts", import.meta.url), "utf8");
  assert.match(hook, /const failed = quoteFailure\(failuresRef\.current, onlyCodes\);\s*if \(failed\) \{ setQuotes\(failed\.drop\); setError\(failed\.error\); \}/);
});

// 🔴 回归：提示「行情获取失败，可以点刷新再试」后点刷新无效。
// 根因：fetchOnce 用布尔 inFlightRef 当并发锁，在途（尤其 finally 触发的补拉卡住）
// 时手动刷新被静默 return 掉，一个请求都没发、界面毫无反馈（旧 core 的
// useArchiveThenRefresh 早用 run 号修过同类坑，见其 51-57 行注释）。
// 手动刷新是用户显式意图，必须另起一趟、立即给反馈，且旧请求结果不能覆盖它。
test("手动刷新不受在途布尔锁吞掉：另起一趟、旧结果作废（点刷新无效回归）", () => {
  const hook = readFileSync(new URL("../src/verticals/finance/hooks/useLiveQuotes.ts", import.meta.url), "utf8");
  // 1) refresh 必须带 manual 标记，走与自动轮询不同的分支
  assert.match(hook, /const refresh = useCallback\(\(\) => \{\s*void fetchOnce\(undefined, true\);/,
    "refresh 必须显式传 manual=true，否则仍会被 inFlight 布尔锁当成重复的一拍吞掉");
  // 2) 在途拦截只对「非手动」生效：手动刷新要能穿透
  assert.match(hook, /if \(inFlightRef\.current && !manual\)/,
    "在途布尔锁只能拦自动轮询/补拉，不能拦用户点的刷新");
  // 3) 每趟带递增 run 号，回来时与当前 run 比对，过期结果直接丢弃
  assert.match(hook, /const run = \+\+runRef\.current;/);
  assert.match(hook, /run !== runRef\.current/,
    "旧请求（被手动刷新取代的那趟）回来时不能写 quotes/error/loading");
  // 4) 手动刷新立刻清掉旧错误提示并进入 loading，让用户看到「收到，正在重试」
  assert.match(hook, /if \(manual\) setError\(null\);/);
});
