// 情绪复盘 · AI 周报:字段照后端 orchestrator/src/finance/shortline/weekly_review.ts,断言用户看得到什么。
// 「本周我的交易」只在本机算、只在页面显示:这里也断言它不进给 AI 的页面上下文。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { textOf, withRenderer } from "./helpers/render.ts";

const FILE = "/src/verticals/finance/shortline/WeeklyReviewTab.tsx";
const noop = () => {};
const A = "ev-aaaaaaaaaaaa";
const SECTIONS = [
  { id: "trend", label: "情绪走势", desc: "每天的情绪读数" },
  { id: "themes", label: "题材轮动", desc: "每天的前几个题材" },
  { id: "verify", label: "验证回看", desc: "明日验证对账" },
  { id: "summary", label: "本周汇总", desc: "最重要的几点" },
];
const stage = (id: string, extra: Record<string, unknown> = {}) => ({ ...SECTIONS.find((s) => s.id === id)!, status: "done", text: "", evidence_count: 3, cited: [], unknown_cites: [], ...extra });
const audit = (extra: Record<string, unknown> = {}) => ({ total: 1, bound: 1, derived: 0, loose: 0, bad_math: [], ...extra });

const SAVED = {
  id: "w2", date: "2026-10-09", week_start: "2026-10-05", days: ["2026-10-08", "2026-10-09"], settled: true, ai: "Claude订阅",
  started_at: "2026-10-10T10:40:00.000Z", finished_at: "2026-10-10T10:46:00.000Z", created_at: "2026-10-10T10:46:00.000Z",
  sections: [
    stage("trend", { text: `涨停从 43 只到 69 只[${A}]。`, audit: audit(), cited: [{ id: A, line: "limit_up_count = 69只 (2026-10-09) [ev-aaaaaaaaaaaa]" }] }),
    stage("themes", { text: "算力连续两天排第一。", audit: audit({ total: 0, bound: 0 }) }),
    stage("verify", { status: "skipped", error: "本周没有要对账的明日验证条件", evidence_count: 0 }),
    stage("summary", { text: `这一周情绪回暖[${A}]。下周看:如果涨停家数继续增加,说明延续。`, audit: audit(), cited: [{ id: A, line: "limit_up_count = 69只" }] }),
  ],
  gaps: ["题材 2026-10-08:共 9 条记录,资料包只放了前 6 条和后 2 条,其余 1 条没放进来"],
};
const OLDER = { ...SAVED, id: "w1", date: "2026-10-08", days: ["2026-10-08"], settled: false, finished_at: "2026-10-09T09:00:00.000Z", created_at: "2026-10-09T09:00:00.000Z" };
const base = { date: "2026-10-09", week_start: "2026-10-05", sections: SECTIONS, versions: [] as unknown[], weeks: [], runs: [] as unknown[] };

const ep = (id: string, first_buy: string, last_sell: string | null, realized_pnl: number | null, as_planned: boolean | null = null, closed = last_sell !== null) => ({
  key: id, kind: "episode", symbol: "600000", name: "浦发银行", date: first_buy, created_at: "", tag_id: null, playbook: null, as_planned,
  planned_stop: null, planned_target: null, plan_late: false, note: "", pnl_pct: null, realized_pnl, hold_days: null,
  episode: { id, first_buy, last_sell, closed, realized_pnl },
});
const manual = (id: string, date: string, pnl_pct: number | null, as_planned: boolean | null = null) => ({
  key: id, kind: "manual", symbol: "000001", name: "平安银行", date, created_at: "", tag_id: null, playbook: null, as_planned,
  planned_stop: null, planned_target: null, plan_late: false, note: "", pnl_pct, realized_pnl: null, hold_days: null, episode: null,
});
const ROWS = [
  ep("e1", "2026-09-28", "2026-10-06", 1234.567, true), // 上周买、本周卖光:赚
  ep("e2", "2026-10-05", "2026-10-09", -300, false), // 本周买、本周卖光:亏,也算新开
  ep("e3", "2026-10-08", null, null), // 本周新开、还没卖完:只算新开
  ep("e4", "2026-09-21", "2026-10-02", 999), // 上周卖光:不算
  ep("e5", "2026-10-06", "2026-10-10", 50), // 卖在这天之后:不算卖光,只算新开
  ep("e6", "2026-09-30", "2026-10-07", 80, true, false), // 本周卖了一部分、没卖完:不算卖光,也不是本周新开
  manual("m1", "2026-10-07", -2.5, true), // 本周补记:亏,不进金额合计
  manual("m2", "2026-10-02", 8), // 上周补记:不算
];

test("weekTrades:按最后一笔卖出的日子算卖光、补记按日子;赚亏按金额(补记按 %),合计只加卖光的;新开含没卖完的", async () => {
  await withRenderer(async (r) => {
    const { weekTrades } = await r.load(FILE);
    assert.deepEqual(weekTrades(ROWS, "2026-10-05", "2026-10-09"),
      { closed: 2, win: 1, loss: 2, even: 0, net: 934.57, manual: 1, opened: 3, planned: 2, unplanned: 1, untagged: 0 });
    // 只有补记:金额合计算不出(null,不是 0);卖光但金额缺:不分输赢、合计也不当 0
    assert.equal(weekTrades([manual("m", "2026-10-06", 3)], "2026-10-05", "2026-10-09").net, null);
    const gap = weekTrades([ep("x", "2026-10-05", "2026-10-06", null)], "2026-10-05", "2026-10-09");
    assert.deepEqual([gap.closed, gap.win + gap.loss + gap.even, gap.net, gap.untagged], [1, 0, null, 1]);
    assert.equal(weekTrades([ep("z", "2026-10-05", "2026-10-06", 0)], "2026-10-05", "2026-10-09").even, 1);
    assert.deepEqual(weekTrades([], "2026-10-05", "2026-10-09"), { closed: 0, win: 0, loss: 0, even: 0, net: null, manual: 0, opened: 0, planned: 0, unplanned: 0, untagged: 0 });
  });
});

test("本周我的交易:写明只在本机、不发给 AI;隐私模式下金额打码,笔数照常;日志算不了写原因;空的一周说没有", async () => {
  await withRenderer(async (r) => {
    const { MyWeekCard } = await r.load(FILE);
    const { MemoryRouter } = await r.load("react-router-dom");
    const show = (props: Record<string, unknown>) => textOf(r.html(() => createElement(MemoryRouter, null, createElement(MyWeekCard, props)), {}));
    const view = { available: true, rows: ROWS };
    const t = show({ view, from: "2026-10-05", to: "2026-10-09", hide: false });
    assert.match(t, /本周我的交易 10-05 到 10-09 · 只在本机算、只在这里显示,不发给 AI/);
    assert.match(t, /卖光 2 笔、补记 1 笔:赚 1 · 亏 2 · 卖光那几笔合计 \+934\.57/);
    assert.match(t, /按计划 2 · 没按计划 1/);
    assert.doesNotMatch(t, /没标/);
    assert.match(t, /这一周新开 3 笔\(含还没卖完的\)/);
    assert.match(t, /去交易日志看明细/);
    const hidden = show({ view, from: "2026-10-05", to: "2026-10-09", hide: true });
    assert.match(hidden, /卖光那几笔合计 •••• /);
    assert.doesNotMatch(hidden, /934/);
    assert.match(hidden, /卖光 2 笔/);
    assert.match(show({ view: { available: false, reason: "交易流水读不了" }, from: "2026-10-05", to: "2026-10-09", hide: false }), /交易日志暂时算不了:交易流水读不了/);
    assert.match(show({ view: { available: true, rows: [] }, from: "2026-10-05", to: "2026-10-09", hide: false }), /这一周没有卖光的交易,也没有新开的。/);
    assert.match(show({ view: null, from: "2026-10-05", to: "2026-10-09", hide: false }), /交易日志读取中/);
  });
});

test("写好的周报:汇总在前;写的 AI、时间、算进来的交易日;几版可选;本周我的交易夹在按钮和正文之间;缺口和来源在下", async () => {
  await withRenderer(async (r) => {
    const { WeeklyReviewView } = await r.load(FILE);
    const html = r.html(WeeklyReviewView, { r: { ...base, versions: [SAVED, OLDER] }, onChanged: noop, myWeek: createElement("p", null, "【我的交易卡】") });
    const t = textOf(html);
    assert.match(t, /写 2026-10-05 起这一周\(到 2026-10-09 为止\)/);
    assert.match(t, /再写一版/);
    assert.match(t, /这一周写过 2 版: 截至 10-09 · 10-10 18:46\(最新\) 截至 10-08 · 10-09 17:00/);
    assert.match(t, /Claude订阅 写 · 10-10 18:46 写完 · 算进来的交易日 10-08、10-09/);
    assert.doesNotMatch(t, /还没收盘/, "默认看最新那版(已收盘)");
    // 选中的版本由外层传进来时照它显示(外层再用同一个选择生成 Agent 上下文)
    const pickedOld = textOf(r.html(WeeklyReviewView, { r: { ...base, versions: [SAVED, OLDER] }, onChanged: noop, pick: "w1", onPick: noop }));
    assert.match(pickedOld, /还没收盘/);
    assert.match(pickedOld, /算进来的交易日 10-08(?!、)/);
    assert.ok(t.indexOf("【我的交易卡】") > t.indexOf("再写一版") && t.indexOf("【我的交易卡】") < t.indexOf("本周汇总"));
    assert.ok(t.indexOf("本周汇总") < t.indexOf("情绪走势 每天的情绪读数"), "汇总排第一");
    assert.match(t, /涨停从 43 只到 69 只 \[1\] 。/);
    assert.match(t, /验证回看 明日验证对账 跳过 本周没有要对账的明日验证条件/);
    assert.match(t, /⚠️ 题材 2026-10-08:共 9 条记录.*来源:AI 按这一周每天的情绪读数、题材、最高标和明日验证对账写.*不含个人交易/);
  });
});

test("没写过 / 正在写(进度、停止) / 旧版没收盘要说 / 刚才那次没存下来", async () => {
  await withRenderer(async (r) => {
    const { WeeklyReviewView, WeeklyBody } = await r.load(FILE);
    const none = textOf(r.html(WeeklyReviewView, { r: base, onChanged: noop }));
    assert.match(none, /让 AI 写 10-05 这一周的周报/);
    assert.match(none, /2026-10-05 起这一周还没写过 AI 周报。/);

    const run = { id: "run1", date: "2026-10-09", settled: true, ai: "Claude订阅", started_at: "2026-10-10T10:40:00.000Z", done: false, saved_id: null, error: null, gaps: [],
      stages: [stage("trend", { text: "写完了一段" }), stage("themes", { status: "running" }), stage("verify", { status: "pending" }), stage("summary", { status: "pending" })] };
    const t = textOf(r.html(WeeklyReviewView, { r: { ...base, versions: [SAVED], runs: [run] }, onChanged: noop }));
    assert.match(t, /正在写 1\/4 段 停止/);
    assert.doesNotMatch(t, /再写一版/);
    assert.match(t, /Claude订阅 写 · 10-10 18:40 开始/, "正在写时显示这一次,不显示存过的版本");
    assert.doesNotMatch(t, /算力连续两天/);

    const old = textOf(r.html(WeeklyBody, { v: { ...OLDER, stages: OLDER.sections, when: "x" } }));
    assert.match(old, /写的时候 2026-10-08 还没收盘,那天的数字后来可能变了/);

    const failed = { ...run, done: true, error: "AI 没写成", stages: run.stages.map((s) => ({ ...s, status: "failed" })) };
    const f = textOf(r.html(WeeklyReviewView, { r: { ...base, runs: [failed] }, onChanged: noop }));
    assert.match(f, /让 AI 写 10-05 这一周的周报/);
    assert.match(f, /18:40 开始的那次一段都没写成,没存。/);
    assert.match(f, /还没写过 AI 周报/);
  });
});

test("给 AI 面板的页面上下文只有周报正文;没写过时说没写过", async () => {
  await withRenderer(async (r) => {
    const { weeklySummary } = await r.load(FILE);
    const ctx = weeklySummary({ ...base, versions: [SAVED, OLDER] });
    assert.match(ctx, /^2026-10-05 起这一周的 AI 周报\(截至 2026-10-09,10-10 18:46 写完;这一周写过 2 版,这是最新一版\):/);
    // 🔴 选了旧版 / 正在写:发给 Agent 的和页面上显示的是同一份(2026-10-11 审计)
    const old = { ...OLDER, sections: [stage("trend", { text: "旧版:涨停 50 只。" })] };
    assert.equal(weeklySummary({ ...base, versions: [SAVED, old] }, "w1"),
      "2026-10-05 起这一周的 AI 周报(截至 2026-10-08,10-09 17:00 写完;这一周写过 2 版,这是用户选的较早一版,不是最新):\n【情绪走势】旧版:涨停 50 只。");
    const writing = { id: "r9", date: "2026-10-09", settled: true, ai: "x", started_at: "2026-10-10T11:00:00.000Z", finished_at: null, done: false, outcome: "running", saved_id: null, save_error: null,
      stages: [stage("trend", { text: "新写的。" })], gaps: [], conditions: [], conditions_note: "" };
    assert.match(weeklySummary({ ...base, versions: [SAVED, old], runs: [writing] }, "w1"), /正在写\(10-10 19:00 开始\),页面上是写到一半的这一版:\n【情绪走势】新写的。$/);
    assert.match(ctx, /【情绪走势】涨停从 43 只到 69 只/);
    assert.match(ctx, /【验证回看】跳过/);
    assert.match(ctx, /【本周汇总】这一周情绪回暖/);
    assert.doesNotMatch(ctx, /交易|盈亏|卖光/, "个人交易不进 AI 上下文");
    assert.equal(weeklySummary(base), "2026-10-05 起这一周还没写过 AI 周报。");
  });
});
