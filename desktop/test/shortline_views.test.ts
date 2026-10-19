// 情绪复盘的其余五个分页：用 2026-10-09 收盘后真实取到的视图输出渲染，断言用户看得到什么。
// 明日验证那天没写条件，对账结果在下面另造（字段照后端 verification.ts）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { textOf, withRenderer } from "./helpers/render.ts";

const FX = JSON.parse(readFileSync(new URL("./fixtures/shortline-views-2026-10-09.json", import.meta.url), "utf8"));
const DIR = "/src/verticals/finance/shortline";
const noop = () => {};

const DAY = JSON.parse(readFileSync(new URL("./fixtures/shortline-2026-10-09.json", import.meta.url), "utf8"));

test("近 5 天 · 题材轮动:题材 × 日期的只数和名次,状态写连续 / 回流 / 首次出现;某天没取到画「—」不画 0", async () => {
  await withRenderer(async (r) => {
    const { WeeklyView } = await r.load(`${DIR}/WeeklyTab.tsx`);
    const { ThemeRotationSection, rotationSummary } = await r.load(`${DIR}/ThemeRotationPanel.tsx`);
    const done = (result: unknown, why = "") => ({ state: "done", status: result ? "ok" : "failed", result, why, settled: true, cached: false, fetched_at: null });
    const rot = DAY.rotation;
    const t = textOf(r.html(ThemeRotationSection, { p: done(rot) }));
    assert.match(t, /题材 09-28 涨停 \d+ 09-29 涨停 \d+ 09-30 涨停 \d+ 10-08 涨停 \d+ 10-09 涨停 69 状态/);
    // 固态电池 [0,7,4,5,4],名次 [-,1,2,1,1]:连续 4 天,4 天进前三
    assert.match(t, /固态电池 · 7 #1 4 #2 5 #1 4 #1 连续 4 天 4 4 紫竹高科、雄韬股份、丰元股份/);
    assert.match(t, /AI漫剧 · 1 #14 2 #3 · 4 #1 隔 1 天回流/);
    assert.match(t, /微短剧 · · · · 3 #3 窗口内首次出现/);
    assert.match(t, /这几天一共 502 个题材标签,表里只列今天前 12 个。客观公开榜单,非推荐 \/ 非预测/);
    assert.doesNotMatch(t, /今天退下去了|昨天还有 2 只以上/, "那天没有退下去的题材,不出这一段");

    // 10-08 没取到:那一列「—」、表头写没取到、上面明说按缺数处理;后端会把跨过它的状态改成「说不准」
    const gap = structuredClone(rot);
    const i = gap.rotation.dates.indexOf("2026-10-08");
    gap.rotation.days[i] = { date: "2026-10-08", available: false, reason: "2026-10-08 东财涨停池没取到" };
    gap.rotation.missing_days = ["2026-10-08"];
    for (const th of gap.rotation.themes) { th.series[i] = null; th.ranks[i] = null; }
    // 退下去的一行:昨天(10-09 前一天)有、今天 0
    gap.rotation.themes.push({ ...gap.rotation.themes[0], tag: "锂矿", series: [0, 0, 3, null, 0], ranks: [null, null, 2, null, null], today: 0, status: "今天没有涨停", members: [] });
    const t2 = textOf(r.html(ThemeRotationSection, { p: done(gap) }));
    assert.match(t2, /10-08 没取到/);
    assert.match(t2, /2026-10-08 没取到:那几列画「—」,按缺数处理\(不是 0\)/);
    assert.match(t2, /固态电池 · 7 #1 4 #2 — 4 #1/);
    assert.match(t2, /昨天还有 2 只以上、今天一只都没有的: 锂矿 · · 3 #2 — · 今天退下去了/);
    const s = rotationSummary(done(gap));
    assert.match(s, /固态电池:0\/7\/4\/缺\/4/);
    assert.match(s, /「缺」= 那天没取到或说不准,不是 0/);
    assert.match(s, /没取到的日子:2026-10-08/);

    // 今天有 2 只沪深涨停股没有原因:表头标「缺原因 2」,上面说清楚没出现的画「—」、出现的是下限
    const part = structuredClone(rot);
    part.rotation.days.at(-1).unknown = 2;
    part.rotation.partial_days = ["2026-10-09"];
    const t3 = textOf(r.html(ThemeRotationSection, { p: done(part) }));
    assert.match(t3, /10-09 涨停 69 缺原因 2/);
    assert.match(t3, /2026-10-09 有沪深涨停股没有涨停原因:那几天没出现的题材画「—」\(可能有\),出现的只数是下限/);
    assert.doesNotMatch(t, /缺原因|有沪深涨停股没有涨停原因/, "都有原因时不出这两处");
    assert.match(rotationSummary(done(part)), /有沪深涨停股缺原因的日子\(那天没出现的题材写「缺」,出现的只数是下限\):2026-10-09/);

    // 还在取 / 没取到 / 整块没算出来
    assert.match(textOf(r.html(ThemeRotationSection, { p: { state: "loading" } })), /题材轮动加载中…/);
    assert.match(textOf(r.html(ThemeRotationSection, { p: done(null, "同花顺超时") })), /这次没取到:同花顺超时。不代表没有/);
    assert.match(textOf(r.html(ThemeRotationSection, { p: done({ ...rot, rotation: { available: false, reason: "2026-10-09 涨停原因没取到" } }) })), /题材轮动没算出来:2026-10-09 涨停原因没取到/);
    assert.equal(rotationSummary({ state: "loading" }), "题材轮动:还在取,先别据此下结论");

    // 摆在热度表和龙头谱系中间
    const w = textOf(r.html(WeeklyView, { r: FX.weekly, rotation: createElement(ThemeRotationSection, { p: done(rot) }) }));
    const at = (x: string) => w.indexOf(x);
    assert.ok(at("近 5 天情绪热度") < at("题材轮动") && at("题材轮动") < at("龙头谱系"), "热度表 → 题材轮动 → 龙头谱系");
  });
});

test("近 5 天：五个交易日、并列最高标、龙头谱系在高点；取不到的写「没取到」不写 0", async () => {
  await withRenderer(async (r) => {
    const { WeeklyView, weeklySummary } = await r.load(`${DIR}/WeeklyTab.tsx`);
    const t = textOf(r.html(WeeklyView, { r: FX.weekly }));
    for (const d of ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-08", "2026-10-09"]) assert.match(t, new RegExp(d));
    assert.match(t, /2026-10-08 43 8板 43% 新华传媒 8板 · 出版/);
    assert.match(t, /新华传媒 600825 当前最高标 在收盘价区间高点/);
    assert.match(t, /自登顶累计 \+46\.55%/);

    // 某天没取到 + 龙头离高点回撤:回撤是跌,用绿色
    const gap = { ...FX.weekly.days[0], limit_up: null, broken_rate: null, leaders: [], note: "那天涨停池没取到" };
    const dd = { ...FX.weekly.lineage[0], is_current_top: false, drawdown_from_peak: -12.3, peak_cum_ret: 60 };
    const html = r.html(WeeklyView, { r: { ...FX.weekly, days: [gap], lineage: [dd] } });
    const t2 = textOf(html);
    assert.match(t2, /2026-09-28 没取到 5板 — — 那天涨停池没取到/);
    assert.doesNotMatch(t2, /当前最高标/);
    assert.match(html, /text-success">-12\.30%</, "回撤是跌,绿色");

    const s = weeklySummary({ ...FX.weekly, days: [gap, ...FX.weekly.days.slice(1)] });
    assert.match(s, /2026-09-28:涨停 没取到,最高 5 板,炸板率 没取到/);
    assert.match(s, /2026-10-09:涨停 69 家,最高 9 板,炸板率 17%,当日并列最高标 新华传媒 9板 · 出版/);
    assert.match(s, /新华传媒\(600825,出版\)2026-09-28 登顶时 5 板,自登顶累计 \+46\.55%.*就在高点,是复盘日的最高标/);
  });
});

test("情绪历史：分位与偏热、和前一天比只列真变化、连续取不到的日子并成一行", async () => {
  await withRenderer(async (r) => {
    const { HistoryView, historySummary, seriesLines, deltaText } = await r.load(`${DIR}/HistoryTab.tsx`);
    const t = textOf(r.html(HistoryView, { r: FX.history }));
    assert.match(t, /涨停家数 69家 77% 历史中位 52家/);
    assert.match(t, /最高连板 9板 100% 偏热 历史中位 5板/);
    assert.match(t, /对比复盘日之前的 13 个交易日 · 1 项处在两头/);
    assert.match(t, /复盘日 vs 2026-10-08/);
    assert.match(t, /涨停家数 43家 ↑ 69家 \(\+26家\) 转热/);
    assert.match(t, /炸板率 43% ↓ 17% \(-26 个百分点\) 转热/, "炸板率降了是转热");
    assert.match(t, /另有 1 项变化在阈值内,未列出/);
    // 逐日表:新的在上;16 天取不到的并成一行,写原因不写 0
    assert.match(t, /2026-10-09 69家 9板 17% \+1\.95% 3家 24% 2026-10-08 43家/);
    assert.match(t, /2026-08-21 ~ 2026-09-11 16 个交易日没取到:超过东财保留期,当时也没缓存/);
    assert.equal((t.match(/没取到:超过东财保留期/g) ?? []).length, 1, "连续缺口只占一行");

    const lines = seriesLines([
      { date: "d1", status: "missing", note: "A", values: {} }, { date: "d2", status: "missing", note: "A", values: {} },
      { date: "d3", status: "missing", note: "B", values: {} }, { date: "d4", status: "ok", note: "", values: {} },
    ]);
    assert.deepEqual(lines.map((l: { kind: string; count?: number }) => l.kind === "gap" ? `gap${l.count}` : "day"), ["day", "gap1", "gap2"], "原因不同的缺口不合并");
    assert.equal(deltaText(0.17, "rate", ""), "+17 个百分点");
    assert.equal(deltaText(-1.5, "pct", "%"), "-1.50 个百分点");
    assert.equal(deltaText(26, "count", "家"), "+26家");

    const off = textOf(r.html(HistoryView, { r: { ...FX.history, context: { available: false, reason: "样本只有 3 天" }, diff: { available: false, reason: "前一交易日没取到" } } }));
    assert.match(off, /这一项没算出来:样本只有 3 天/);
    assert.match(off, /这一项没算出来:前一交易日没取到/);

    const s = historySummary(FX.history);
    assert.match(s, /最高连板 9板 分位 100%\(偏热\)/);
    assert.match(s, /取到 14\/30 天,没取到的日子不是 0/);
    assert.match(s, /缺口:16 个交易日没取到读数/);
  });
});

// ---------------------------------------------------------------- 明日验证
const m = (key: string) => FX.verify.metrics.find((x: { key: string }) => x.key === key);
const view = (k: string) => { const x = m(k); return { metric: x.key, label: x.label, unit: x.unit, kind: x.kind, higher_is_hotter: x.higher_is_hotter, eps: x.eps }; };
const RESULTS = [
  { id: "a", ...view("limit_up_count"), direction: "up", direction_label: "上升", reason: "情绪回暖", prev_value: 43, cur_value: 69, actual: "up", actual_label: "上升", verified: true, late: false,
    baseline: 0.385, baseline_samples: 13, baseline_reason: null, baseline_note: "", edge: 0.615, written_at: "2026-10-08T12:00:00.000Z" },
  { id: "b", ...view("broken_rate"), direction: "up", direction_label: "上升", reason: "", prev_value: 0.427, cur_value: 0.169, actual: "down", actual_label: "下降", verified: false, late: true,
    baseline: 0.3, baseline_samples: 13, baseline_reason: null, baseline_note: "", edge: -0.3, written_at: "2026-10-09T02:00:00.000Z" },
  { id: "c", ...view("theme_concentration"), direction: "flat", direction_label: "持平", reason: "", prev_value: null, cur_value: 0.2, actual: null, actual_label: null, verified: null, late: false,
    baseline: null, baseline_samples: null, baseline_reason: "头部题材集中度 没有历史序列,算不出基准发生率(不拿别的读数凑)", baseline_note: "", edge: null, written_at: "2026-10-08T12:00:00.000Z" },
];
const SUMMARY = { total: 3, decided: 2, hit: 1, rate: 0.5, undecidable: 1, baseline_covered: 2, expected_rate: 0.343, edge: 0.157 };
const PLAN = [{ id: "p", ...view("highest_board"), direction: "down", direction_label: "下降", reason: "9 板已经很高", base_value: 9,
  baseline: 0.231, baseline_samples: 13, baseline_reason: null, baseline_note: "少见方向,判对一次含量高", written_at: "2026-10-09T12:00:00.000Z" }];

test("明日验证：对账写成立 / 不成立 / 判不了，事后写的标出来；今晚的条件带今天的值和阈值", async () => {
  await withRenderer(async (r) => {
    const { VerifyView, verifySummary, summaryText, moveRule, epsText } = await r.load(`${DIR}/VerifyTab.tsx`);
    const empty = textOf(r.html(VerifyView, { r: FX.verify, onSaved: noop }));
    assert.match(empty, /2026-10-08 晚写的条件 → 2026-10-09 对账/);
    assert.match(empty, /2026-10-08 那晚没写条件。/);
    assert.match(empty, /这晚还没写条件。/);
    assert.match(empty, /这段时间还没有对过账的条件。/);
    assert.match(empty, /46 个交易日没取到读数/);

    const filled = { ...FX.verify, check: { ...FX.verify.check, results: RESULTS, summary: SUMMARY }, plan: { date: "2026-10-09", items: PLAN } };
    const t = textOf(r.html(VerifyView, { r: filled, onSaved: noop }));
    assert.match(t, /涨停家数 写的:上升 实际:上升 成立 2026-10-08 43家 → 2026-10-09 69家 · 变动超过 5家 才算升降 理由:情绪回暖 这个方向历史上出现过 39%\(13 对可比日\)/);
    assert.match(t, /炸板率 写的:上升 实际:下降 不成立 事后,不计入 2026-10-08 43% → 2026-10-09 17% · 变动超过 5 个百分点 才算升降/);
    assert.match(t, /头部题材集中度 写的:持平 实际:读数没取到 判不了 2026-10-08 — → 2026-10-09 20%/);
    assert.match(t, /基准发生率算不出:头部题材集中度 没有历史序列/);
    assert.match(t, /3 条里判得了 2 条,成立 1 条\(命中率 50%\);1 条读数没取到、判不了;有历史基准的 2 条:照历史常态随口猜能对 34%,实际多对 16 个百分点/);
    // 今晚的条件:今天的值、阈值、基准
    assert.match(t, /情绪的天花板，压缩=周期见顶 · 今天 9板 · 差 1板就算升降 这个方向历史上出现过 23%\(13 对可比日\) · 少见方向,判对一次含量高/);

    const prov = textOf(r.html(VerifyView, { r: { ...filled, check: { ...filled.check, provisional: true } }, onSaved: noop }));
    assert.match(prov, /2026-10-09 还没收盘\(或东财还没定稿\):结果是暂定的,不计入累计战绩/);

    assert.equal(moveRule(0.5, "count", "板"), "差 1板就算升降");
    assert.equal(moveRule(0.05, "rate", ""), "变动超过 5 个百分点 才算升降");
    assert.equal(epsText(0.5, "pct", "%"), "0.5 个百分点");
    assert.match(summaryText({ ...SUMMARY, edge: -0.2 }), /实际少对 20 个百分点/);
    assert.equal(summaryText({ ...SUMMARY, total: 0 }), "");

    const s = verifySummary(filled);
    assert.match(s, /- 炸板率 写的上升,实际下降\(43%→17%\):不成立,事后写的不计入/);
    assert.match(s, /- 头部题材集中度 写的持平,实际读数没取到\(—→20%\):判不了/);
    assert.match(s, /2026-10-09 晚写给下一个交易日的条件:最高连板高度下降\(今天 9板\),理由:9 板已经很高/);
  });
});

test("涨停样本：封板时间曲线、各打法对基准、样本偏小；最好红最差绿", async () => {
  await withRenderer(async (r) => {
    const { SamplesView, samplesSummary } = await r.load(`${DIR}/SamplesTab.tsx`);
    const html = r.html(SamplesView, { r: FX.samples });
    const t = textOf(html);
    assert.match(t, /2026-09-14 ~ 2026-10-09 · 请求 30 个交易日,实际可用 14 天/);
    assert.match(t, /≤197\.7 算弱,≥337\.8 算强/);
    assert.match(t, /开盘秒板 \+2\.24% 胜 59% · 再涨停 32% 59 只次/);
    assert.match(t, /14:00后 0\.00% 胜 44%/);
    assert.match(t, /全体涨停 基准/);
    assert.match(t, /首板打板 比基准 -0\.40%/, "1.05 − 1.45");
    assert.match(t, /首板·尾盘封 比基准 -2\.34% 样本偏小/, "56 只次 < 60");
    assert.doesNotMatch(t, /首板打板 比基准 -0\.40% 样本偏小/);
    assert.match(t, /情绪强 \+0\.34% 胜 44% 283 只次/);
    assert.match(t, /没取到、已剔除的 16 个交易日:2026-08-21、2026-08-24/);
    // VA 把最好 / 最差的颜色写反过:涨红跌绿
    assert.match(html, /最好 <b class="text-danger">\+24\.12%<\/b>/);
    assert.match(html, /最差 <b class="text-success">-12\.70%<\/b>/);

    const off = textOf(r.html(SamplesView, { r: { ...FX.samples, available: false, reason: "取到样本的交易日不足(3/30,至少 5 天)", strategies: [], seal_curve: [] } }));
    assert.match(off, /这个窗口统计不了:取到样本的交易日不足/);

    const s = samplesSummary(FX.samples);
    assert.match(s, /^涨停样本统计\(市场现象,不是策略回测\)/);
    assert.match(s, /口径:样本 = 前一天收盘还封在涨停板上的票\(事后名单\)/);
    assert.match(s, /首板·尾盘封.*56 只次,均 -0\.89%.*样本偏小/);
  });
});

test("结构变化：比不了写原因；移位按日中位比、占比写个百分点；制度事件可登记，未施行的标出来", async () => {
  await withRenderer(async (r) => {
    const { StructureView, structureSummary } = await r.load(`${DIR}/StructureTab.tsx`);
    const t = textOf(r.html(StructureView, { r: FX.structure, onChanged: noop }));
    assert.match(t, /结构比较暂不可用\(最近 10 个交易日取到 10 天、之前 20 个交易日取到 4 天,每个窗口至少要 5 天\)/);
    assert.match(t, /这一项没算出来:最近 10 个交易日取到 10 天、之前 20 个交易日取到 4 天/);
    assert.match(t, /涨停池 稳定 14 天/);
    assert.match(t, /昨日涨停池 稳定 14 天/);
    assert.match(t, /还没登记。/);
    assert.match(t, /登记/);

    const shifted = {
      ...FX.structure,
      structure: { available: true, reason: null, skipped: [], shifted: [], metrics: [
        { metric: "limit_up", label: "涨停家数", kind: "count", recent: 55, prior: 40, delta: 15, rel_change: 0.375, shifted: true, recent_days: 10, prior_days: 20 },
        { metric: "share_20cm", label: "20% 制度占比", kind: "share", recent: 0.32, prior: 0.2, delta: 0.12, rel_change: null, shifted: true, recent_days: 10, prior_days: 20 },
        { metric: "share_bj", label: "北交所占比", kind: "share", recent: 0.03, prior: 0.04, delta: -0.01, rel_change: null, shifted: false, recent_days: 10, prior_days: 20 },
      ] },
      field_drift: [{ ...FX.structure.field_drift[0], changed: true, added: ["zttj.new"], removed: null,
        versions: [{ since: "2026-09-14", until: "2026-09-30", fields: "a,b", count: 18 }, { since: "2026-10-08", until: "2026-10-09", fields: "a,b,c", count: 19 }] }],
      regime_events: [{ id: "e1", date: "2026-10-12", title: "某规则调整", note: "提前公布", upcoming: true }],
    };
    const t2 = textOf(r.html(StructureView, { r: shifted, onChanged: noop }));
    assert.match(t2, /涨停家数 55 家 40 家 ⚠ 明显移位 \(\+38%\)/);
    assert.match(t2, /20% 制度占比 32% 20% ⚠ 明显移位 \(\+12 个百分点\)/);
    assert.match(t2, /北交所占比 3% 4% 稳定 \(-1 个百分点\)/);
    assert.match(t2, /涨停池 字段变过 14 天 2026-09-14 ~ 2026-09-30:18 个字段 2026-10-08 ~ 2026-10-09:19 个字段 新增:zttj\.new/);
    assert.match(t2, /2026-10-12 某规则调整 还没施行 提前公布/);

    const s = structureSummary(shifted);
    assert.match(s, /20% 制度占比 日中位 32%\(之前 20%,\+12 个百分点\) 明显移位/);
    assert.match(s, /人工登记的制度事件:2026-10-12 某规则调整\(还没施行\):提前公布/);
    assert.match(structureSummary(FX.structure), /制度事件:还没登记\(系统不自动推断,没登记不代表没有\)/);
  });
});

test("分页取数状态：加载中写慢的原因，没取到写原因并说明不代表没有", async () => {
  await withRenderer(async (r) => {
    const { ViewSlot } = await r.load(`${DIR}/ViewBits.tsx`);
    const loading = textOf(r.html(ViewSlot, { st: { state: "loading" }, label: "情绪历史", slow: "第一次取要逐日拉东财数据", children: () => "内容" }));
    assert.equal(loading, "情绪历史加载中… 第一次取要逐日拉东财数据");
    const failed = textOf(r.html(ViewSlot, { st: { state: "failed", why: "超时" }, label: "涨停样本", children: () => "内容" }));
    assert.equal(failed, "涨停样本这次没取到:超时。不代表没有,可点右上角刷新重试。");
    const done = textOf(r.html(ViewSlot, { st: { state: "done", data: 1 }, label: "x", children: (d: number) => `数据 ${d}` }));
    assert.equal(done, "数据 1");
  });
});

test("🔴 AI 复盘写作中某一次静默刷新没取到:进度留着、标一句没取到,轮询看的 run 仍是没写完(Opus 审计 3.3)", async () => {
  await withRenderer(async (r) => {
    const { failedView } = await r.load(`${DIR}/useView.ts`);
    const { ViewSlot } = await r.load(`${DIR}/ViewBits.tsx`);
    const writing = { state: "done", data: { runs: [{ id: "r1", done: false }] } };
    const after = failedView(writing, "本机 API 连不上", true);
    assert.deepEqual(after, { state: "done", data: writing.data, stale: "本机 API 连不上" }, "上一次取到的写作进度留着");
    assert.equal(after.data.runs[0].done, false, "轮询看的是这个 run:没写完就接着排下一次");
    assert.deepEqual(failedView(writing, "超时", false), { state: "failed", why: "超时" }, "换日期 / 点刷新那种非静默重取,失败照旧换成没取到");
    assert.deepEqual(failedView({ state: "loading" }, "超时", true), { state: "failed", why: "超时" }, "还没有内容可留时照旧报没取到");
    const text = textOf(r.html(ViewSlot, { st: after, label: "AI 复盘", children: () => "写到一半的复盘" }));
    assert.equal(text, "AI 复盘最近一次刷新没取到:本机 API 连不上。下面是上一次取到的内容。 写到一半的复盘");
    const back = textOf(r.html(ViewSlot, { st: { state: "done", data: 1 }, label: "AI 复盘", children: () => "新内容" }));
    assert.equal(back, "新内容", "下一次取到就不再提");
  });
  const hook = readFileSync(new URL("../src/verticals/finance/shortline/useView.ts", import.meta.url), "utf8");
  assert.match(hook, /setSt\(\(prev\) => failedView\(prev, why, quiet\)\);/);
  for (const f of ["ReviewTab.tsx", "WeeklyReviewTab.tsx"]) {
    const src = readFileSync(new URL(`../src/verticals/finance/shortline/${f}`, import.meta.url), "utf8");
    assert.match(src, /const r = st\.state === "done" \? st\.data : null;/, `${f}:轮询按留着的内容判断写完没有`);
  }
});
