// 盯盘两个分页:实时动态、竞价与盘中路径。数据形状照后端 watch.ts / intraday.ts,断言用户看得到什么。
import assert from "node:assert/strict";
import test from "node:test";
import { textOf, withRenderer } from "./helpers/render.ts";
import type { IntradayResult, Snapshot, WatchView } from "../src/verticals/finance/shortline/watchTypes.ts";

const DIR = "/src/verticals/finance/shortline";
const noop = () => {};
const row = (code: string, name: string, price: number | null, pct: number | null, today = true) =>
  ({ code, name, price, pct, amount_yuan: price === null ? null : 3.2e8, quote_time: today ? "20261012100130" : "20261009150003", today });

const LIVE: WatchView = {
  date: "2026-10-12", clock: "10:01:32", phase: "morning", phase_label: "上午连续竞价", trading_day: true, detecting: true, poll_ms: 3000, quote_day: "2026-10-12",
  holdings: [{ ...row("000001", "平安银行", 12, 1.2), pnl_pct: 20 }, { ...row("600000", "浦发银行", null, null), pnl_pct: null }],
  watchlist: [row("300750", "宁德时代", 250.5, -0.8, false)],
  ladder: { sample_date: "2026-10-09", quote_date: "2026-10-12", highest: 9, rows: [
    { ...row("600825", "新华传媒", 8.8, 10), boards: 9, label: "9板", sector: "出版", at_limit: true },
    { ...row("002001", "新和成", 20, -3.5), boards: 2, label: "2板", sector: "化工", at_limit: false },
    { ...row("000002", "万科A", null, null), boards: 1, label: "首板", sector: "地产", at_limit: null },
  ] },
  turnover: { date: "2026-10-09", rows: [{ ...row("601138", "工业富联", 60, 2.1), rank: 1 }] },
  bigcap: { total: 378, date: "2026-10-12", refreshed_at: "2026-10-12T02:01:20.000Z", top: [row("601318", "中国平安", 50, 3.3)], bottom: [row("600519", "贵州茅台", 1400, -2.2)] },
  alerts: [
    { ts: "10:01:30", code: "600825", name: "新华传媒", kind: "封板", change_pct: null, price: 8.8, pct: 10, msg: "触及涨停 8.8", sources: ["昨日9板"] },
    { ts: "10:01:00", code: "000001", name: "平安银行", kind: "急拉", change_pct: 2, price: 12, pct: 1.2, msg: "1 分钟 +2.0%(现价 12,今日 +1.2%)", sources: ["持仓"] },
    { ts: "09:58:12", code: "601318", name: "中国平安", kind: "急跌", change_pct: -1.6, price: 50, pct: 3.3, msg: "2 分钟 -1.6%(现价 50,今日 +3.3%)", sources: ["大票"] },
  ],
  notes: ["行情这一轮分 9 批取,1 批没取到,稍后自动重试"],
  rules: { surge_pct: 1.5, window_min: 3, cooldown_min: 5 },
  source: "腾讯实时行情",
};

test("实时动态:盯盘中的状态、异动流带来源;持仓只列现价涨跌和浮动盈亏 %;没取到写「没取到」;非今天的行情标出来", async () => {
  await withRenderer(async (r) => {
    const { LiveView } = await r.load(`${DIR}/LiveTab.tsx`);
    const props = { v: LIVE, threshold: 1.5, scope: "all", ladderMin: 1, onThreshold: noop, onScope: noop, onLadderMin: noop, error: null };
    const html = r.html(LiveView, props);
    const t = textOf(html);
    assert.match(t, /盯盘中 · 上午连续竞价 北京时间 10:01:32 · 每 3 秒刷新/);
    assert.match(t, /10:01:30 封板 新华传媒 600825 触及涨停 8\.8 昨日9板/);
    assert.match(t, /10:01:00 急拉 平安银行 000001 1 分钟 \+2\.0%\(现价 12,今日 \+1\.2%\) 持仓/);
    assert.match(t, /平安银行 000001 12 \+1\.20% \+20\.00%/, "持仓:现价、今日、浮动盈亏");
    assert.match(t, /浦发银行 600000 没取到 —/);
    assert.match(t, /持仓 只列现价、今日涨跌和浮动盈亏 %;股数和成本在「自选与持仓」页。 名称 现价 今日 浮动盈亏 平安银行/, "持仓表只有这四列");
    assert.match(t, /宁德时代 300750 250\.5 非今日/);
    assert.match(t, /昨日梯队\(2026-10-09 涨停 3 只,最高 9 板\)/);
    assert.match(t, /取到今天行情 2\/3 只 · 上涨 1 · 下跌 1 · 封住 1/);
    assert.match(t, /昨日 名称 行业 现价 今日/, "这一列是东财行业,不是题材");
    assert.match(t, /9板 新华传媒 600825 出版 8\.8 \+10\.00% 封住/);
    assert.match(t, /大票涨幅前十\(500 亿以上 378 只\)/);
    assert.match(t, /跌幅前五 名称 现价 今日 成交额 贵州茅台 600519 1400 -2\.20%/);
    assert.match(t, /昨日成交额前十\(2026-10-09\) 上一个交易日成交额最大的十只,看今天的表现;成交额是今天的。 # 名称 现价 今日 成交额 1 工业富联 601138 60 \+2\.10% 3\.2 亿/);
    assert.match(t, /⚠️ 行情这一轮分 9 批取,1 批没取到/);
    // 红涨绿跌
    assert.match(html, /text-danger">\+1\.20%</);
    assert.match(html, /text-success">-3\.50%</);
    // 取不到时的提示
    assert.match(textOf(r.html(LiveView, { ...props, error: "超时" })), /这次没取到:超时。先显示上一次的内容,稍后自动重试/);
    const paused = textOf(r.html(LiveView, { ...props, paused: true }));
    assert.match(paused, /页面在后台,已暂停刷新\(北京时间 \S+ 的读数\);切回来就接着取/, "切到后台要说已暂停");
    assert.doesNotMatch(paused, /盯盘中|每 3 秒刷新/, "暂停时不说在盯");
  });
});

test("异动筛选:幅度只筛急拉急跌,封板开板一直在;「只看持仓与自选」按来源筛;梯队按板位筛", async () => {
  await withRenderer(async (r) => {
    const { LiveView, filterAlerts, ladderStats, liveSummary } = await r.load(`${DIR}/LiveTab.tsx`);
    const props = { v: LIVE, threshold: 1.5, scope: "all", ladderMin: 1, onThreshold: noop, onScope: noop, onLadderMin: noop, error: null };
    assert.deepEqual(filterAlerts(LIVE.alerts, 1.5, "all").map((a: { kind: string }) => a.kind), ["封板", "急拉", "急跌"]);
    assert.deepEqual(filterAlerts(LIVE.alerts, 3, "all").map((a: { kind: string }) => a.kind), ["封板"]);
    assert.deepEqual(filterAlerts(LIVE.alerts, 1.5, "mine").map((a: { kind: string }) => a.kind), ["急拉"]);
    assert.deepEqual(filterAlerts(LIVE.alerts, 1.6, "all").map((a: { kind: string }) => a.kind), ["封板", "急拉", "急跌"], "1.6 正好够 1.6");
    assert.deepEqual(ladderStats(LIVE.ladder!.rows), { total: 3, sample: 2, up: 1, down: 1, sealed: 1 });
    // 午休 / 休市:后端不说封没封 → 不写 0;今天一只都没取到 → 说下面是哪天的读数,不写「上涨 0 · 下跌 0」
    const noSeal = LIVE.ladder!.rows.map((x) => ({ ...x, at_limit: null }));
    assert.equal(ladderStats(noSeal).sealed, null);
    assert.match(textOf(r.html(LiveView, { ...props, v: { ...LIVE, ladder: { ...LIVE.ladder!, rows: noSeal } } })), /取到今天行情 2\/3 只 · 上涨 1 · 下跌 1 · 封住 —/);
    const weekend = { ...LIVE, date: "2026-10-10", quote_day: "2026-10-09", phase_label: "周末休市", trading_day: false, detecting: false,
      ladder: { ...LIVE.ladder!, rows: noSeal.map((x) => ({ ...x, today: false })) } };
    const wt = textOf(r.html(LiveView, { ...props, v: weekend }));
    assert.match(wt, /今天还没取到这 3 只的行情,下面是 2026-10-09 的读数\(标「非今日」\)/);
    assert.doesNotMatch(wt, /上涨 0|下跌 0|封住 0/);
    assert.match(liveSummary(weekend), /今天还没取到这 3 只的行情,下面是 2026-10-09 的读数/);
    const base = { v: LIVE, threshold: 5, scope: "mine", ladderMin: 2, onThreshold: noop, onScope: noop, onLadderMin: noop, error: null };
    const t = textOf(r.html(LiveView, base));
    assert.match(t, /按当前筛选没有异动\(今天共记下 3 条\)/);
    assert.match(t, /2板 新和成/);
    assert.doesNotMatch(t, /首板 万科A/, "2板以上不列首板");
  });
});

test("实时动态:收盘后 / 休市不判断异动,写清原因和刷新间隔", async () => {
  await withRenderer(async (r) => {
    const { LiveView } = await r.load(`${DIR}/LiveTab.tsx`);
    const props = { threshold: 1.5, scope: "all", ladderMin: 1, onThreshold: noop, onScope: noop, onLadderMin: noop, error: null };
    const closed = textOf(r.html(LiveView, { ...props, v: { ...LIVE, phase: "closed", phase_label: "已收盘", detecting: false, poll_ms: 60000, alerts: [] } }));
    assert.match(closed, /已收盘 北京时间 10:01:32 · 每 60 秒刷新/);
    assert.match(closed, /已收盘,不判断异动;连续竞价时段\(9:30–11:30、13:00–14:57\)页面开着就会盯/);
    const holiday = textOf(r.html(LiveView, { ...props, v: { ...LIVE, phase_label: "今天休市", trading_day: false, detecting: false, poll_ms: 60000, alerts: [], ladder: null, bigcap: null, turnover: null } }));
    assert.match(holiday, /今天休市,不判断异动。/);
    assert.match(holiday, /昨日梯队这次没取到/);
    assert.match(holiday, /大票名单这次没取到/);
  });
});

test("给 AI 的实时动态摘要:异动、自选、梯队强弱;不含持仓(只因持仓才盯的异动也不给)", async () => {
  await withRenderer(async (r) => {
    const { liveSummary } = await r.load(`${DIR}/LiveTab.tsx`);
    const mixed = { ts: "09:59:00", code: "002001", name: "新和成", kind: "急跌", change_pct: -1.8, price: 20, pct: -3.5, msg: "2 分钟 -1.8%", sources: ["持仓", "昨日2板"] };
    const s = liveSummary({ ...LIVE, alerts: [...LIVE.alerts, mixed] });
    assert.match(s, /北京时间 2026-10-12 10:01:32,上午连续竞价,正在判断异动/);
    assert.match(s, /10:01:30 封板 新华传媒\(600825\) 触及涨停 8\.8 \[昨日9板\]/);
    assert.match(s, /09:59:00 急跌 新和成\(002001\) 2 分钟 -1\.8% \[昨日2板\]/, "同时在梯队里的,异动照给、去掉持仓标签");
    assert.match(s, /用户的持仓按产品规则不发给 AI/);
    assert.match(s, /自选:宁德时代\(300750\) 250\.5 -0\.80%\(非今日行情\)/);
    assert.match(s, /昨日梯队\(2026-10-09 涨停 3 只,最高 9 板\):取到今天行情 2\/3 只 · 上涨 1 · 下跌 1 · 封住 1。2 板以上:9板 新华传媒\(600825\) 8\.8 \+10\.00% · 出版 封住;2板 新和成/);
    for (const x of ["平安银行", "000001", "浦发银行", "600000", "浮动盈亏", "[持仓", "、持仓", "持仓:"]) assert.equal(s.includes(x), false, x);
    assert.doesNotMatch(s, /股数|成本/);
  });
});

const snap = (slot: Snapshot["slot"], median: number, live: Snapshot["live"] = null, clock = `${slot}:20`): Snapshot => ({
  schema: 1, date: "2026-10-12", slot, captured_at: "", clock, drift_minutes: 0, basis: slot === "09:25" ? "open" : "latest", prev_date: "2026-10-09",
  cohort: { expected: 43, sample: slot === "10:00" ? 30 : 42, coverage_rate: slot === "10:00" ? 0.7 : 0.98, avg: median + 0.3, median, up_count: 25, down_count: 17, up_rate: 0.6, deep_loss_5: 3,
    by_tier: { 首板: { sample: 30, avg: 1, median: 0.8, up_rate: 0.6 }, "3板及以上": { sample: 5, avg: 4, median: 5.1, up_rate: 0.8 } },
    top_board_level: 9, top_boards: [{ code: "600825", name: "新华传媒", boards: 9, sector: "出版", pct: 10, at_limit: null }] },
  live, ...(live ? {} : { live_reason: "集合竞价阶段还没有当天的涨停 / 炸板池" }), gaps: [],
});
const LIVE_COUNTS = { limit_up: 52, broken: 13, limit_down: 4, highest_board: 10, consec_count: 9, seal_rate: 0.8, broken_rate: 0.2, promotion_1to2: 0.25, promotion_all: 0.3 };
const INTRA: IntradayResult = {
  date: "2026-10-12", today: true, trading_day: true,
  slots: [
    { slot: "09:25", window_end: "09:29", state: "saved", reason: null, snapshot: snap("09:25", 1.2) },
    { slot: "09:35", window_end: "09:43", state: "failed", reason: "行情只取到 0 只", snapshot: null },
    { slot: "10:00", window_end: "10:08", state: "saved", reason: null, snapshot: snap("10:00", -0.8, LIVE_COUNTS) },
    { slot: "11:30", window_end: "11:38", state: "missing", reason: "这个时点没存到快照(当时程序没开着、不是交易日,或取数失败)", snapshot: null },
    { slot: "14:00", window_end: "14:08", state: "upcoming", reason: null, snapshot: null },
    { slot: "15:00", window_end: "15:08", state: "upcoming", reason: null, snapshot: null },
  ],
  auction: snap("09:25", 1.2), auction_reason: null,
  checks: { set_date: "2026-10-09", items: [
    { id: "c1", metric: "limit_up_count", label: "涨停家数", unit: "家", kind: "count", eps: 5, direction: "up", direction_label: "走高", reason: "主线还在", base_value: 69, close_only: false,
      points: [{ slot: "10:00", value: 52, actual: "down", actual_label: "走低", verified: false }] },
    { id: "c2", metric: "money_effect_median", label: "赚钱效应", unit: "", kind: "pct", eps: 0.5, direction: "up", direction_label: "走高", reason: "", base_value: 1.95, close_only: false,
      points: [{ slot: "09:25", value: 1.2, actual: null, actual_label: null, verified: null }] },
    { id: "c3", metric: "theme_concentration", label: "题材集中度", unit: "", kind: "rate", eps: 0.05, direction: "up", direction_label: "走高", reason: "", base_value: 0.4, close_only: true, points: [] },
  ] },
  warnings: ["10:00 的快照文件被改过,已跳过"], gaps: [],
  basis_labels: { open: "当日开盘价 ÷ 昨收", latest: "抓取时最新价 ÷ 昨收" },
  source: "腾讯实时行情", generated_at: "",
};

test("竞价与盘中路径:时点状态、09:25 竞价强弱、路径表(09:25 是高开、之后是红盘)、盘中核验标「暂」", async () => {
  await withRenderer(async (r) => {
    const { IntradayView } = await r.load(`${DIR}/IntradayTab.tsx`);
    const html = r.html(IntradayView, { r: INTRA, onCapture: noop, capturing: false, captureMsg: null });
    const t = textOf(html);
    assert.match(t, /2026-10-12\(今天\)/);
    assert.match(t, /现在存一张/);
    assert.match(t, /09:25 已存 09:25:20 存 · 42\/43 只 09:35 没存成 行情只取到 0 只 10:00 已存/);
    assert.match(t, /11:30 没存到 这个时点没存到快照/);
    assert.match(t, /14:00 待存 14:00–14:08 自动存/);
    assert.match(t, /昨日涨停股 · 今日竞价强弱\(09:25:20 存\) 样本是 2026-10-09 收盘封住的 43 只,取到竞价行情 42 只。口径:当日开盘价 ÷ 昨收。/);
    assert.match(t, /\+1\.20% 中位数\(多数人的体感\) \+1\.50% 均值 60% 高开占比\(25\/42\) 3 低开超 5%/);
    assert.match(t, /3板及以上 \(5 只\) \+5\.10% 高开 80%/);
    assert.match(t, /最高标\(9 板\)· 客观读数 新华传媒 600825 · 出版 \+10\.00%/);
    assert.match(t, /09:25 09:25:20 \+1\.20% \+1\.50% 高开 60% 3 42\/43 — — — — — —/, "竞价那行没有全市场家数");
    assert.match(t, /10:00 10:00:20 -0\.80% -0\.50% 红盘 60% 3 30\/43 52 13 4 10板 80% 25%/);
    assert.match(html, /text-warning">30\/43</, "样本不到八成标黄");
    assert.match(html, /\+1\.20%<\/div><div class="[^"]*bg-danger\/60/, "正的路径柱红");
    assert.match(html, /-0\.80%<\/div><div class="[^"]*bg-success\/60/, "负的路径柱绿");
    assert.match(t, /涨停家数 预期走高 昨天 69家 · 主线还在 10:00 52家 走低 暂不成立/);
    assert.match(t, /赚钱效应 预期走高 昨天 \+1\.95% 09:25 \+1\.20% 判不了/);
    assert.match(t, /题材集中度 .*这项只在收盘后才有读数,盘中不判断/);
    assert.match(t, /⚠️ 10:00 的快照文件被改过,已跳过/);
    // 回看以前的日子:没有手动存的按钮;没有竞价快照时说原因
    const old = textOf(r.html(IntradayView, { r: { ...INTRA, today: false, auction: null, auction_reason: "09:25 竞价快照没有:当时程序没开着。过了时点补不回来" }, onCapture: null, capturing: false, captureMsg: null }));
    assert.doesNotMatch(old, /现在存一张|今天/);
    assert.match(old, /09:25 竞价快照没有:当时程序没开着。过了时点补不回来/);
    const empty = textOf(r.html(IntradayView, { r: { ...INTRA, slots: INTRA.slots.map((s) => ({ ...s, snapshot: null, state: "missing" as const })), auction: null, checks: { set_date: "2026-10-09", items: [] } }, onCapture: null, capturing: false, captureMsg: null }));
    assert.match(empty, /这一天还没有存到时点快照/);
    assert.match(empty, /2026-10-09 晚上没写验证条件/);
    const pastEmpty = textOf(r.html(IntradayView, { r: { ...INTRA, today: false, slots: INTRA.slots.map((s) => ({ ...s, snapshot: null, state: "missing" as const })), auction: null, checks: { set_date: null, items: [] } }, onCapture: null, capturing: false, captureMsg: null }));
    assert.match(pastEmpty, /这一天没存到时点快照\(当时程序没开着,或取数失败\)/);
    assert.match(pastEmpty, /这一天没存到时点快照,没有盘中读数可对/);
    assert.doesNotMatch(pastEmpty, /存下第一张|程序开着就行/, "过去的日子补不回来,不说「存下第一张」");
    // 今天还没存到快照(开盘前):不说「没找到上一个交易日」
    const early = textOf(r.html(IntradayView, { r: { ...INTRA, slots: INTRA.slots.map((s) => ({ ...s, snapshot: null, state: "upcoming" as const })), auction: null, checks: { set_date: null, items: [] } }, onCapture: noop, capturing: false, captureMsg: null }));
    assert.match(early, /还没存到时点快照,存下第一张后才有读数可对/);
    assert.match(early, /现在存一张/);
    // 休市:时点标「休市」、没有存的按钮、各块直说休市
    const closedSlots = INTRA.slots.map((s) => ({ ...s, snapshot: null, state: "skipped" as const, reason: "周末休市" }));
    const shut = { ...INTRA, date: "2026-10-10", trading_day: false, slots: closedSlots, auction: null, auction_reason: "周末休市,没有竞价", checks: { set_date: null, items: [] } };
    const ct = textOf(r.html(IntradayView, { r: shut, onCapture: noop, capturing: false, captureMsg: null }));
    assert.match(ct, /2026-10-10\(今天\) · 休市,不存快照/);
    assert.doesNotMatch(ct, /现在存一张|没找到上一个交易日|没存到/);
    assert.match(ct, /09:25 休市/);
    assert.match(ct, /周末休市,没有竞价/);
    assert.match(ct, /这一天休市,没有盘中路径/);
    assert.match(ct, /2026-10-10 休市,没有盘中读数/);
  });
});

test("给 AI 的竞价与盘中摘要:时点状态、竞价读数、路径、盘中核验(临时)", async () => {
  await withRenderer(async (r) => {
    const { intradaySummary } = await r.load(`${DIR}/IntradayTab.tsx`);
    assert.match(intradaySummary({ ...INTRA, trading_day: false }), /竞价与盘中路径,2026-10-12\(今天\),休市。/);
    const s = intradaySummary(INTRA);
    assert.match(s, /时点快照:09:25 已存;09:35 没存成\(行情只取到 0 只\);10:00 已存;11:30 没存到/);
    assert.match(s, /09:25 竞价\(2026-10-09 涨停 43 只,取到 42 只,当日开盘价 ÷ 昨收\):中位 \+1\.20%/);
    assert.match(s, /盘中路径:10:00 昨日涨停股中位 -0\.80%,红盘 60%,全市场涨停 52 炸板 13 跌停 4 最高 10板/);
    assert.match(s, /涨停家数 预期走高\(昨 69家\):10:00 52家 暂不成立/);
    assert.match(s, /题材集中度 预期走高\(昨 40%\):只在收盘后判断/);
  });
});
