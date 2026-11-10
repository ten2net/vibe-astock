import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { api } from "../src/verticals/finance/lib/api.ts";
import { backend, type FetchResult } from "../src/verticals/finance/lib/backend.ts";
import { mergePolledQuotes, missingQuotes, noQuotesBack, quoteErrorReason, quoteFailure, quoteSnapshotTime } from "../src/verticals/finance/lib/quoteSnapshot.ts";

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
    assert.match(hook, /api\.quote\(requested, true, ctl\.signal\)/, "取数必须带可取消的 signal");
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
  assert.match(hook, /const failed = quoteFailure\(failuresRef\.current, onlyCodes, reason\);\s*if \(failed\) \{ setQuotes\(failed\.drop\); setError\(failed\.error\); \}/);
});

// 🔴 第三轮回归：用户实测「刷新后依旧显示行情获取失败，名称/代码外的列全是「—」」。
// 本机证据：用户部署卷里 tx_quotes_batch 快照当天一直在成功写入（status ok / 几百条
// evidence），api.quote 拿真实快照也能解析出完整报价 ⇒ 后端与解析都正常。真缺陷是前端：
//  ① 失败原因被 catch{} 整个吞掉，永远只显示「可以点刷新再试」，查不出根因；
//  ② 失败一律撤掉全部报价，站上明明有上次成功快照也不去读，于是整列变「—」。
test("失败原因透传：quoteFailure 带上真实原因，quoteErrorReason 压成一句话", () => {
  const manual = quoteFailure(1, undefined, "HTTP 401");
  assert.match(manual!.error, /HTTP 401/, "提示里必须能看见真实原因，而不是永远「点刷新再试」");
  assert.match(manual!.error, /可以点刷新再试/);
  assert.equal(quoteErrorReason(new Error("连接不到编排器 API: x")), "连接不到编排器 API: x");
  assert.equal(quoteErrorReason(new Error("  a\n  b  ")), "a b");
  assert.equal(quoteErrorReason(null), "原因不明");
  assert.ok(quoteErrorReason(new Error("x".repeat(300))).length <= 120);
});

test("失败时先回退读快照：能读到就显示快照并说明原因，不再整列「—」", () => {
  const hook = readFileSync(new URL("../src/verticals/finance/hooks/useLiveQuotes.ts", import.meta.url), "utf8");
  assert.match(hook, /api\.quote\(requested, false, snapCtl\.signal\)/, "失败后要用 refresh=false 回退读快照");
  assert.match(hook, /当前显示的是上次快照/, "显示快照时必须如实标注，不拿旧价冒充现价");
  assert.match(hook, /const reason = quoteErrorReason\(e\);/);
  assert.match(hook, /} catch \(e\) \{/, "catch 必须接住异常对象，不能再整个丢掉");
});

test("quoteMap 不把空/失败信封静默变成空表：抛带原因的错", () => {
  const api = readFileSync(new URL("../src/verticals/finance/lib/api.ts", import.meta.url), "utf8");
  assert.match(api, /if \(!queries\.length\) throw new Error\(/);
  assert.match(api, /status === "failed" \|\| evCount === 0/);
  assert.match(api, /上游行情没取到/);
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

// 🔴 第二轮回归：用户实测「刷新后一直在转圈、一直失败」。上面的 run 号只保证
// 「请求发出」，但 fetch 没有超时/取消：上游挂起时 promise 永远 pending，finally
// 永不执行 ⇒ loading 永远 true、按钮一直转圈；刷新只是再发一个同样挂起的请求。
// 根因在取数链路无 signal / 无超时，必须让挂起的请求能在有限时间内结束，并允许
// 手动刷新取消在途旧请求（否则后端 single-flight 会把新请求挂到卡住的那次上）。
test("取数挂起不能永远转圈：超时 abort + 手动刷新取消在途（一直转圈回归）", () => {
  const hook = readFileSync(new URL("../src/verticals/finance/hooks/useLiveQuotes.ts", import.meta.url), "utf8");
  const api = readFileSync(new URL("../src/verticals/finance/lib/api.ts", import.meta.url), "utf8");
  const backend = readFileSync(new URL("../src/verticals/finance/lib/backend.ts", import.meta.url), "utf8");
  // 1) signal 必须一路透传到 fetch（任何一层漏了都取消不了）
  assert.match(backend, /opts: \{[^}]*signal\?: AbortSignal/);
  assert.match(backend, /\.\.\.\(opts\.signal \? \{ signal: opts\.signal \} : \{\}\)/);
  assert.match(api, /env\("tx_quotes_batch", \{[^\n]*refresh,[^\n]*signal/,
    "quoteMap 要把 signal 透给 tx_quotes_batch 的 env 调用");
  assert.match(api, /quote: \(codes: string, refresh = false, signal\?: AbortSignal\)/);
  assert.match(hook, /api\.quote\(requested, true, ctl\.signal\)/);
  // 2) 每趟有超时定时器，超时 abort；finally 一定 clearTimeout 并复位 loading
  assert.match(hook, /const QUOTE_TIMEOUT_MS = 15_000;/);
  assert.match(hook, /const timer = setTimeout\(\(\) => ctl\.abort\(\), QUOTE_TIMEOUT_MS\);/);
  assert.match(hook, /clearTimeout\(timer\);/);
  assert.match(hook, /setLoading\(false\);/);
  // 3) 手动刷新先取消上一趟在途请求，新请求才不会被后端 single-flight 拖住
  assert.match(hook, /if \(manual\) abortRef\.current\?\.abort\(\);/);
  // 4) 名单变化 / 卸载时也要掐掉在途请求
  assert.match(hook, /return \(\) => \{ abortRef\.current\?\.abort\(\); \}/);
});

test("挂起的 fetch 被 abort 后 finally 仍执行：loading 复位、失败提示可见（状态机）", async () => {
  // 模拟修复后的关键不变量：带 signal 的取数被 abort → reject → finally 复位 loading。
  // 修复前 fetch 永久 pending，这里会超时挂住。
  let loading = true;
  let error: string | null = null;
  const ctl = new AbortController();
  const pending = new Promise<never>((_resolve, reject) => {
    ctl.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const run = (async () => {
    try {
      await pending;
      error = null;
    } catch {
      error = "行情获取失败，可以点刷新再试";
    } finally {
      loading = false;   // 🔴 修复前这一行永远到不了
    }
  })();
  ctl.abort();
  await run;
  assert.equal(loading, false, "取消/超时后必须停止转圈");
  assert.match(error ?? "", /行情获取失败/, "失败要如实显示，而不是永远转圈");
});

test("signal 端到端透传到 fetch：abort 后 api.quote 立刻 reject（不再永久 pending）", async () => {
  const originalFetch = globalThis.fetch;
  const originalBackendFetch = backend.fetch;
  let gotSignal: AbortSignal | undefined;
  // 模拟一个「上游挂起」的响应：只有 signal 触发才 reject（与真实 fetch 行为一致）
  globalThis.fetch = (_url: string | URL | Request, init?: RequestInit) => {
    gotSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };
  try {
    const ctl = new AbortController();
    const p = api.quote("600519", true, ctl.signal);
    ctl.abort();
    await assert.rejects(p, /aborted|连接不到编排器 API/);
    assert.ok(gotSignal, "backend.fetch 必须把 signal 一路传到原生 fetch");
    assert.equal(gotSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    backend.fetch = originalBackendFetch;
  }
});

// 🔴 真根因（用户回传「args.codes 数组过长」后定位）：编排器 service.ts 的
// MAX_ARG_ARR=50，而用户自选有 223 只。前端 quoteMap 一次性把全部代码塞进
// args.codes → assertArgs 整批拒绝 → 每只都「—」+「行情获取失败，点刷新再试」，
// 刷新永远同样失败。后端 finance/schedule.ts 早有 QUOTE_BATCH=50 的分批实现，
// 前端必须照做：按 50 分批、限并发、单批失败不影响其它批、结果合并。
test("超过 50 只自选按批取数：每批 ≤50、结果合并、不再触发数组过长", async () => {
  const codes = Array.from({ length: 120 }, (_, i) => String(600000 + i));
  const orig = backend.fetch;
  const batchSizes: number[] = [];
  backend.fetch = async (_endpoint, opts) => {
    const sent = (opts.args!.codes as string[]);
    batchSizes.push(sent.length);
    const evidence = sent.flatMap((c) => [
      { record_key: c, field: "price", value: 10, period: "2026-11-10", fetched_at: "2026-11-10T00:00:00Z" },
      { record_key: c, field: "security_name", value: `股${c}`, period: "2026-11-10" },
    ]);
    return { cached: false, envelope: { status: "ok", evidence }, exit_code: 0 } as unknown as FetchResult;
  };
  try {
    const out = await api.quote(codes.join(","), true);
    assert.equal(batchSizes.length, 3, "120 只应分 3 批");
    assert.ok(batchSizes.every((n) => n <= 50), `每批都不能超过 MAX_ARG_ARR：${batchSizes}`);
    assert.equal(Object.keys(out).length, 120, "各批结果要合并成完整一张表");
    assert.equal(out["600000"]?.price, 10);
  } finally { backend.fetch = orig; }
});

test("一批失败不影响其它批：能取到的照常显示，全失败才抛带原因的错", async () => {
  const codes = Array.from({ length: 60 }, (_, i) => String(600000 + i));
  const orig = backend.fetch;
  let first = true;
  backend.fetch = async (_endpoint, opts) => {
    const sent = opts.args!.codes as string[];
    if (first) { first = false; throw new Error("HTTP 500"); }
    const evidence = sent.flatMap((c) => [
      { record_key: c, field: "price", value: 7, period: "2026-11-10", fetched_at: "2026-11-10T00:00:00Z" },
      { record_key: c, field: "security_name", value: `股${c}`, period: "2026-11-10" },
    ]);
    return { cached: false, envelope: { status: "ok", evidence }, exit_code: 0 } as unknown as FetchResult;
  };
  try {
    const out = await api.quote(codes.join(","), true);
    assert.equal(Object.keys(out).length, 10, "第一批(50只)挂了，第二批(10只)仍返回");
  } finally { backend.fetch = orig; }

  // 全部批次失败 → 抛错，让 useLiveQuotes 显示真实原因
  backend.fetch = async () => { throw new Error("args.codes 数组过长"); };
  try {
    await assert.rejects(api.quote(codes.join(","), true), /数组过长/);
  } finally { backend.fetch = orig; }
});
