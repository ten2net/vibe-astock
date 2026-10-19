// 情绪复盘 · AI 复盘:字段照后端 orchestrator/src/finance/shortline/review.ts,断言用户看得到什么。
import assert from "node:assert/strict";
import test from "node:test";
import { textOf, withRenderer } from "./helpers/render.ts";

const FILE = "/src/verticals/finance/shortline/ReviewTab.tsx";
const noop = () => {};
const A = "ev-aaaaaaaaaaaa", B = "ev-bbbbbbbbbbbb", C = "ev-cccccccccccc";
const SECTIONS = [
  { id: "sentiment", label: "情绪", desc: "赚钱效应、晋级率" },
  { id: "capital", label: "资金", desc: "两市成交额、两融" },
  { id: "theme", label: "题材", desc: "题材事件树、首板名单" },
  { id: "dragon_tiger", label: "龙虎榜", desc: "上榜只数" },
  { id: "leader", label: "龙头", desc: "最高标" },
  { id: "summary", label: "汇总", desc: "最重要的几点" },
];
const METRICS = [
  { key: "limit_up_count", label: "涨停家数", unit: "家", kind: "count", eps: 5 },
  { key: "broken_rate", label: "炸板率", unit: "", kind: "rate", eps: 0.05 },
];
const DIRS = [{ key: "up", label: "上升" }, { key: "down", label: "下降" }, { key: "flat", label: "持平" }];
const stage = (id: string, extra: Record<string, unknown> = {}) => ({ ...SECTIONS.find((s) => s.id === id)!, status: "done", text: "", evidence_count: 3, cited: [], unknown_cites: [], ...extra });
const audit = (extra: Record<string, unknown> = {}) => ({ total: 3, bound: 2, derived: 1, loose: 0, bad_math: [], ...extra });

const SAVED = {
  id: "v2", date: "2026-10-09", settled: true, ai: "Claude订阅", started_at: "2026-10-10T10:40:00.000Z", finished_at: "2026-10-10T10:46:00.000Z", created_at: "2026-10-10T10:46:00.000Z",
  sections: [
    stage("sentiment", {
      text: `涨停 69 只[${A}],比昨天多 69-43=26 只。\n炸板率 16.9%[${A}, ${B}];另见[ev-deadbeef0000]。`,
      audit: audit({ loose: 1, bad_math: [{ raw: "4+1=6", stated: 6, recomputed: 5, percent: false }] }),
      cited: [{ id: A, line: "limit_up_count = 69只 (2026-10-09) [ev-aaaaaaaaaaaa]" }, { id: B, line: "broken_rate = 0.169(小数) (2026-10-09) [ev-bbbbbbbbbbbb]" }],
      unknown_cites: ["ev-deadbeef0000"],
    }),
    stage("capital", { text: `两市成交额 19005.4 亿元[${C}]。`, audit: audit({ total: 1, bound: 1, derived: 0 }), cited: [{ id: C, line: "market_amount_total = 1900540000000元 [ev-cccccccccccc]" }] }),
    stage("theme", { status: "failed", error: "bad_output_format:模型没有交回可用的中文正文,已重试一次" }),
    stage("dragon_tiger", { status: "skipped", error: "资料都没取到,这一段不写:龙虎榜(按净买额排):没取到(东财超时)", evidence_count: 0 }),
    stage("leader", { text: "最高 9 板。", audit: audit({ total: 0, bound: 0, derived: 0 }) }),
    stage("summary", { text: `今天涨停 69 只[${A}]。`, audit: audit({ total: 1, bound: 1, derived: 0 }), cited: [{ id: A, line: "limit_up_count = 69只" }] }),
  ],
  gaps: ["首板名单(按首封时间):共 57 条记录,资料包只放了前 15 条,其余 42 条没放进来"],
  conditions: [{ metric: "limit_up_count", direction: "up", reason: "如果涨停继续增加,说明情绪延续" }, { metric: "broken_rate", direction: "down", reason: "" }],
  conditions_note: "另有 1 条建议不在读数清单里,没采用",
};
const OLDER = { ...SAVED, id: "v1", finished_at: "2026-10-10T09:00:00.000Z", created_at: "2026-10-10T09:00:00.000Z", settled: false };
const base = { date: "2026-10-09", sections: SECTIONS, metrics: METRICS, directions: DIRS, versions: [] as unknown[], dates: [], runs: [] as unknown[] };

test("写好的复盘:汇总在前带建议,正文的证据编号换成角标、编出来的标红;数字三档、算式算错标红;没写成的写原因;缺口在下", async () => {
  await withRenderer(async (r) => {
    const { ReviewView } = await r.load(FILE);
    const html = r.html(ReviewView, { r: { ...base, versions: [SAVED, OLDER] }, onChanged: noop });
    const t = textOf(html);
    assert.match(t, /再写一版/);
    assert.match(t, /这一天写过 2 版: 10-10 18:46\(最新\) 10-10 17:00/);
    assert.match(t, /Claude订阅 写 · 10-10 18:46 写完/);
    assert.doesNotMatch(t, /还没收盘/, "默认看最新那版(已收盘)");
    const pickedOld = textOf(r.html(ReviewView, { r: { ...base, versions: [SAVED, OLDER] }, onChanged: noop, pick: "v1", onPick: noop }));
    assert.match(pickedOld, /还没收盘/, "外层传进来的选择照用(外层用同一个选择生成 Agent 上下文)");
    // 汇总排第一,建议的读数和方向用名字写
    assert.ok(t.indexOf("汇总") < t.indexOf("情绪 赚钱效应"));
    assert.match(t, /AI 建议明天看这几个读数 涨停家数 上升 如果涨停继续增加,说明情绪延续 炸板率 下降 另有 1 条建议不在读数清单里,没采用 加进明日验证/);
    assert.match(html, /bg-danger\/15 text-danger">上升</, "上升红");
    assert.match(html, /bg-success\/15 text-success">下降</, "下降绿");
    // 角标:按查看依据的序号;[A, B] 两个都认;资料包里没有的标红问号
    assert.match(t, /涨停 69 只 \[1\] ,比昨天多 69-43=26 只。/);
    assert.match(t, /炸板率 16\.9% \[1\] \[2\] ;另见 \[\?\] 。/);
    assert.doesNotMatch(t.slice(0, t.indexOf("查看依据")), /ev-aaaaaaaaaaaa/, "正文里不露出编号原文(只在查看依据里)");
    assert.match(html, /title="limit_up_count = 69只 \(2026-10-09\) \[ev-aaaaaaaaaaaa\]"/, "角标悬停看原行");
    assert.match(html, /title="资料包里没有 ev-deadbeef0000" class="cursor-help font-bold text-destructive">\[\?\]/);
    assert.match(t, /🔴 有 1 处算式重算对不上\(算式是它自己写的\): 「4\+1=6」→ 重算应为 5\.00/);
    assert.match(t, /🔴 引了 1 个资料包里没有的证据编号/);
    assert.match(t, /数字 3 个: 2 个对得上资料包 · 1 个写了算式且重算通过 · 1 个没有交代出处 \(不等于错,但这一档没经过核对\)/);
    assert.match(t, /查看依据\(2 条\) \[1\] limit_up_count = 69只 \(2026-10-09\) \[ev-aaaaaaaaaaaa\] \[2\] broken_rate/);
    // 没写成 / 跳过:状态 + 原因(去掉错误码前缀),不显示核对
    assert.match(t, /题材 题材事件树、首板名单 没写成 模型没有交回可用的中文正文,已重试一次/, "错误码前缀不给人看");
    assert.match(t, /龙虎榜 上榜只数 跳过 资料都没取到,这一段不写/);
    assert.match(t, /龙头 最高标 最高 9 板。/);
    assert.doesNotMatch(t.slice(t.indexOf("龙头 最高标")), /数字 0 个/, "没有数字不写核对行");
    assert.match(t, /⚠️ 首板名单\(按首封时间\):共 57 条记录.*来源:AI 按这一天/);
  });
});

test("没写过 / 正在写 / 刚才那次没存下来;旧版是没收盘时写的要说", async () => {
  await withRenderer(async (r) => {
    const { ReviewView, ReviewBody, unsavedNote, clock } = await r.load(FILE);
    const empty = textOf(r.html(ReviewView, { r: base, onChanged: noop }));
    assert.match(empty, /让 AI 复盘 2026-10-09/);
    assert.match(empty, /2026-10-09 还没写过 AI 复盘。/);
    assert.doesNotMatch(empty, /先接入 AI/, "还没点就不提示");

    const run = {
      id: "r1", date: "2026-10-09", settled: true, ai: "Codex订阅版", started_at: "2026-10-10T10:43:00.000Z", finished_at: null,
      stages: [stage("sentiment", { text: `涨停 69 只[${A}]。`, audit: audit(), cited: [{ id: A, line: "x" }] }),
        stage("capital", { status: "running", text: "" }), stage("theme", { status: "pending", text: "" }),
        stage("dragon_tiger", { status: "skipped", error: "资料都没取到" }), stage("leader", { status: "pending" }), stage("summary", { status: "pending" })],
      gaps: [], conditions: [], conditions_note: "", done: false, outcome: "running", saved_id: null, save_error: null,
    };
    const t = textOf(r.html(ReviewView, { r: { ...base, versions: [SAVED], runs: [run] }, onChanged: noop }));
    assert.match(t, /正在写 2\/6 段 停止/, "写完和跳过的都算");
    assert.doesNotMatch(t, /再写一版/);
    assert.match(t, /Codex订阅版 写 · 10-10 18:43 开始/);
    assert.match(t, /资金 两市成交额、两融 在写…/);
    assert.match(t, /题材 题材事件树、首板名单 排队中/);
    assert.match(t, /汇总 最重要的几点 排队中/);
    assert.doesNotMatch(t, /这一天写过/, "正在写时不显示旧版");

    const cancelled = { ...run, done: true, outcome: "cancelled" };
    assert.equal(unsavedNote(cancelled), "10-10 18:43 开始的那次已停止,没存。");
    assert.equal(unsavedNote({ ...run, done: true, outcome: "failed", stages: [stage("sentiment", { status: "failed", error: "ValueError: AI 掉线" })] }),
      "10-10 18:43 开始的那次一段都没写成,没存:AI 掉线。");
    assert.equal(unsavedNote({ ...run, done: true, outcome: "completed", save_error: "没存上:sections 不对" }), "10-10 18:43 开始的那次写完了但没存上:sections 不对。");
    assert.equal(unsavedNote({ ...run, done: true, outcome: "completed", saved_id: "x" }), null);
    assert.equal(unsavedNote(run), null);
    const shown = textOf(r.html(ReviewView, { r: { ...base, versions: [SAVED], runs: [cancelled] }, onChanged: noop }));
    assert.match(shown, /10-10 18:43 开始的那次已停止,没存。/);
    assert.match(shown, /Claude订阅 写 · 10-10 18:46 写完/, "没存下的那次不挡住已存的版本");

    const old = textOf(r.html(ReviewBody, { v: { ...OLDER, stages: OLDER.sections, when: "x" }, r: base }));
    assert.match(old, /写的时候 2026-10-09 还没收盘,里面的数字后来可能变了/);
    assert.match(old, /数字和证据编号由程序核对/);
    // 旧版导入的:不能说「由程序核对」,改说原文照搬;导入时写进 gaps 的提示照常显示
    const imp = { ...OLDER, imported: true, ai: "旧版导入(deepseek)", gaps: ["从旧版导入:原文照搬,数字和证据编号没有按新版规则重新核对"],
      conditions: [], conditions_note: "旧版这一晚的明日验证条件已经导进「明日验证」" };
    const impText = textOf(r.html(ReviewBody, { v: { ...imp, stages: imp.sections, when: "x" }, r: base }));
    assert.match(impText, /旧版导入\(deepseek\) 写/);
    assert.match(impText, /⚠️ 从旧版导入:原文照搬,数字和证据编号没有按新版规则重新核对/);
    assert.match(impText, /来源:旧版 Vibe AStock 当时写的复盘,原文照搬;证据编号对照的是旧版当时的资料包,数字没有重算/);
    assert.doesNotMatch(impText, /由程序核对/);
    // 条件已经直接导进「明日验证」:只剩说明、没有可点的建议,标题不再说「AI 建议」
    assert.match(impText, /明日验证 旧版这一晚的明日验证条件已经导进「明日验证」/);
    assert.doesNotMatch(impText, /AI 建议明天看这几个读数|加进明日验证/);
    assert.equal(clock("2026-10-09T23:05:00.000Z"), "10-10 07:05", "按北京时间");
    assert.equal(clock("不是时间"), "不是时间");
    assert.equal(clock(null), "");
  });
});

test("加进明日验证:人写过的读数不改,满 8 条不再加;一条都没加就不存", async () => {
  await withRenderer(async (r) => {
    const { mergeConditions, reviewSummary } = await r.load(FILE);
    const have = [{ metric: "broken_rate", direction: "up", reason: "我自己写的" }];
    const conds = [{ metric: "limit_up_count", direction: "up", reason: "AI" }, { metric: "broken_rate", direction: "down", reason: "AI" }];
    const m = mergeConditions(have, conds);
    assert.deepEqual(m.items, [{ metric: "broken_rate", direction: "up", reason: "我自己写的" }, { metric: "limit_up_count", direction: "up", reason: "AI" }]);
    assert.equal(m.text, "加了 1 条到「明日验证」;1 条的读数这晚已经写过,没改");
    const full = Array.from({ length: 7 }, (_, i) => ({ metric: `m${i}`, direction: "up", reason: "" }));
    const f = mergeConditions(full, [...conds, { metric: "deep_loss_count", direction: "down", reason: "" }]);
    assert.equal(f.items.length, 8);
    assert.equal(f.text, "加了 1 条到「明日验证」;2 条超出 8 条上限没加");
    const none = mergeConditions(have, [conds[1]]);
    assert.equal(none.items, null);
    assert.equal(none.text, "1 条的读数这晚已经写过,没改");

    assert.equal(reviewSummary(base), "2026-10-09 还没写过 AI 复盘。");
    const s = reviewSummary({ ...base, versions: [SAVED, OLDER] });
    assert.match(s, /^2026-10-09 的 AI 复盘\(10-10 18:46 写完;这一天写过 2 版,这是最新一版\):\n【情绪】涨停 69 只\[ev-aaaaaaaaaaaa\]/);
    // 🔴 选了旧版:发给 Agent 的是页面上那一版,不是最新版(2026-10-11 审计)
    const old = { ...OLDER, sections: [stage("sentiment", { text: "旧版写的:涨停 50 只。" })] };
    const picked = reviewSummary({ ...base, versions: [SAVED, old] }, "v1");
    assert.match(picked, /^2026-10-09 的 AI 复盘\(10-10 17:00 写完;这一天写过 2 版,这是用户选的较早一版,不是最新\):\n【情绪】旧版写的:涨停 50 只。$/);
    assert.equal(reviewSummary({ ...base, versions: [SAVED, old] }, "不存在"), s, "选的版本没了就回到最新");
    // 正在写新一版:页面显示写到一半的,发给 Agent 的也是它
    const writing = { id: "r9", date: "2026-10-09", settled: true, ai: "x", started_at: "2026-10-10T11:00:00.000Z", finished_at: null, done: false, outcome: "running", saved_id: null, save_error: null,
      stages: [stage("sentiment", { text: "新写的一段。" }), stage("capital", { status: "running", text: "" })], gaps: [], conditions: [], conditions_note: "" };
    assert.equal(reviewSummary({ ...base, versions: [SAVED, old], runs: [writing] }, "v1"),
      "2026-10-09 的 AI 复盘正在写(10-10 19:00 开始),页面上是写到一半的这一版:\n【情绪】新写的一段。\n【资金】在写…");
    assert.match(s, /【题材】没写成\n【龙虎榜】跳过/);
    assert.match(reviewSummary({ ...base, versions: [{ ...SAVED, imported: true }] }), /^2026-10-09 的 AI 复盘\(10-10 18:46 写完;从旧版导入,原文照搬,数字没按新版规则核对\):/);
  });
});
