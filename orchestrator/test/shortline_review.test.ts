import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import "../src/finance/register_tasks.ts";
import { FINANCE_LEDGER_KINDS } from "../src/finance/ledger_kinds.ts";
import {
  MAX_DOSSIER, SOURCES, auditText, cancelReview, citationsOf, evidenceLine, formatOk, parseConditions, renderDossier, resetReviews, reviewFinished,
  selectEvidence, shortlineReview, shortlineReviewAct, startReview, type TurnFn,
} from "../src/finance/shortline/review.ts";
import { detectPython } from "../src/init.ts";
import { ServiceError, agentTurnFor, ledgerList, type ServiceContext } from "../src/service.ts";
import { listViews } from "../src/views.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";
const NOW = new Date("2026-10-10T08:00:00Z");
const DATE = "2026-10-09";
const sig = () => new AbortController().signal;
const id = (name: string) => `ev-${crypto.createHash("sha1").update(name).digest("hex").slice(0, 12)}`;
interface Ev { id: string; field: string; value: unknown; unit?: string; period?: string; record_key?: string; note?: string }
const ev = (name: string, field: string, value: unknown, extra: Partial<Ev> = {}): Ev => ({ id: id(name), field, value, period: DATE, ...extra });

afterEach(() => resetReviews());

// ── 资料包:日期过滤 / 截取 / 写法 ──
test("证据过滤:复盘日之后的去掉并说明;全是之后的一条不用;区间按结束日算;没日期的留着", () => {
  const src = SOURCES.margin!;
  const raw = [
    ev("m1", "market_financing_net_buy", 1, { period: "2026-10-08", record_key: "margin|2026-10-08" }),
    ev("m2", "market_financing_net_buy", 2, { period: "2026-10-12", record_key: "margin|2026-10-12" }),
    ev("m3", "market_financing_net_buy", 3, { period: "2026-09-30..2026-10-09" }),
    ev("m4", "market_financing_net_buy", 4, { period: "2026-10-01..2026-10-12" }),
    ev("m5", "x", 5, { period: undefined }),
  ];
  const r = selectEvidence(src, raw, DATE);
  assert.deepEqual(r.kept.map((e) => e.value), [1, 3, 5]);
  assert.equal(r.gaps.length, 1); assert.match(r.gaps[0]!, /去掉了 2 条 2026-10-09 之后/);
  const none = selectEvidence(src, [raw[1]!], DATE);
  assert.deepEqual(none.kept, []); assert.match(none.gaps[0]!, /只有 2026-10-09 之后的数据,不用/);
  assert.deepEqual(selectEvidence(src, [], DATE), { kept: [], gaps: [] }, "本来就没数据:不在这里编缺口(由取数那一层说)");
});

test("证据截取:按记录取前后几条,只截指定字段,不带 key 的汇总数全留;截了要说", () => {
  // 龙虎榜:前 20 后 10
  const dragon = SOURCES.dragon!;
  const rows = Array.from({ length: 35 }, (_, i) => [
    ev(`d${i}a`, "dragon_tiger_market_net_buy", 100 - i, { record_key: `s${i}` }),
    ev(`d${i}b`, "dragon_tiger_market_change_pct", 10, { record_key: `s${i}` }),
  ]).flat();
  const total = ev("dt", "dragon_tiger_market_count", 35);
  const r = selectEvidence(dragon, [total, ...rows], DATE);
  const keys = new Set(r.kept.filter((e) => e.record_key).map((e) => e.record_key));
  assert.equal(keys.size, 30); assert.ok(keys.has("s0") && keys.has("s19") && !keys.has("s20") && !keys.has("s24") && keys.has("s25") && keys.has("s34"));
  assert.ok(r.kept.includes(total), "汇总数不截");
  assert.equal(r.kept.length, 61);
  assert.match(r.gaps[0]!, /共 35 条记录,资料包只放了前 20 条和后 10 条,其余 5 条没放进来/);
  // 两市成交额:只截 market_amount_total,只留后 10 天;指数那几项不动
  const trend = SOURCES.trend!;
  const amounts = Array.from({ length: 60 }, (_, i) => ev(`a${i}`, "market_amount_total", i, { record_key: `amount|${i}` }));
  const idx = [ev("i1", "index_close", 3000, { record_key: "index|000001" }), ev("i2", "index_change_pct", 0.1, { record_key: "index|000001" })];
  const t = selectEvidence(trend, [...idx, ...amounts], DATE);
  assert.deepEqual(t.kept.filter((e) => e.field === "market_amount_total").map((e) => e.value), [50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
  assert.equal(t.kept.filter((e) => e.field.startsWith("index_")).length, 2);
  assert.match(t.gaps[0]!, /共 60 条记录,资料包只放了后 10 条,其余 50 条没放进来/);
  // 没超就不截、不说
  assert.deepEqual(selectEvidence(dragon, rows.slice(0, 60), DATE).gaps, []);
});

test("资料包写法:当天日期不写、同一字段同一句说明只写一次;「查看依据」用的原行是完整的;超长截断要说", () => {
  const src = SOURCES.themes!;
  const evs = [
    ev("t1", "topic_limit_up", 4, { unit: "只", record_key: "固态电池", note: "按涨停原因串归组" }),
    ev("t2", "topic_limit_up", 3, { unit: "只", record_key: "创新药", note: "按涨停原因串归组" }),
    ev("t3", "topic_broken_rate", 0.2, { unit: "小数", record_key: "创新药", note: "炸板 ÷ (涨停 + 炸板)", period: "2026-10-08" }),
    ev("t4", "topic_members", "华北制药\u0007(600812)2板", { unit: "text", record_key: "创新药" }),
  ];
  const d = renderDossier([{ source: src, evidence: evs, gaps: ["题材事件树:x"], settled: true }], DATE);
  const lines = d.text.split("\n");
  assert.equal(lines[0], "### 题材事件树");
  assert.equal(lines[1], `- 固态电池 topic_limit_up = 4只 [${id("t1")}] — 按涨停原因串归组`);
  assert.equal(lines[2], `- 创新药 topic_limit_up = 3只 [${id("t2")}]`, "同一句说明不再写");
  assert.equal(lines[3], `- 创新药 topic_broken_rate = 0.2(小数) (2026-10-08) [${id("t3")}] — 炸板 ÷ (涨停 + 炸板)`, "不是当天的要写日期");
  assert.equal(lines[4], `- 创新药 topic_members = 华北制药 (600812)2板 [${id("t4")}]`, "控制字符剥掉、text 单位不写");
  assert.equal(d.lines.get(id("t2")), `创新药 topic_limit_up = 3只 (2026-10-09) [${id("t2")}] — 按涨停原因串归组`);
  assert.deepEqual([d.count, d.values, d.gaps], [4, [4, 3, 0.2], ["题材事件树:x"]]);
  assert.equal(evidenceLine(evs[0]!, { note: false }), `固态电池 topic_limit_up = 4只 (2026-10-09) [${id("t1")}]`);

  const many = Array.from({ length: 400 }, (_, i) => ev(`big${i}`, `f${i}`, i, { note: "说明".repeat(20) }));
  const big = renderDossier([{ source: src, evidence: many, gaps: [], settled: null }], DATE);
  assert.ok(big.text.length <= MAX_DOSSIER + 40);
  assert.match(big.text, /资料包过长已截断/);
  assert.match(big.gaps.at(-1)!, new RegExp(`超过 ${MAX_DOSSIER} 字已截断`));
});

test("资料包里写成文字的数也算出处:理由里的阈值、首封时间、缺口里的条数;日期、编号不算", () => {
  const d = renderDossier([{
    source: SOURCES.dragon!,
    evidence: [
      ev("d1", "dragon_tiger_market_net_buy", 18758.2, { unit: "万元", record_key: "300821|日涨幅达到15%的前5只证券", note: "300821 东岳硅材:日涨幅达到15%的前5只证券" }),
      ev("d2", "topic_first_seal", "133925", { unit: "text", record_key: "AI漫剧", note: "该题材第一只涨停的首封时间（HHMMSS）" }),
      ev("d3", "topic_count", "266", { unit: "text", note: "不是时刻的 6 位以内文字照原样" }),
    ],
    gaps: ["龙虎榜(按净买额排):共 82 条记录,资料包只放了前 20 条和后 10 条,其余 52 条没放进来", "行业资金流:这个来源只给当天,复盘 2026-10-09 时没有"],
    settled: true,
  }], DATE);
  assert.match(d.text, /AI漫剧 topic_first_seal = 13:39:25 \[/, "HHMMSS 写成时刻");
  assert.match(d.lines.get(id("d2"))!, / = 13:39:25 \(2026-10-09\)/, "「查看依据」同一种写法");
  assert.match(d.text, /topic_count = 266 \[/);
  for (const n of [18758.2, 15, 39, 25, 82, 52, 266]) assert.ok(d.values.includes(n), `${n} 应在出处里:${JSON.stringify(d.values)}`);
  assert.ok(!d.values.includes(133925), "6 位原样不进出处,正文里不会这么写");
  // 和核对正文同一个取数规则:日期整段不算
  for (const n of [2026, 10, 9, -10, -9]) assert.ok(!d.values.includes(n), `${n} 不该算出处:${JSON.stringify(d.values)}`);
  // 端到端:照着这些写的数不再算「没交代出处」
  const a = auditText("东岳硅材因日涨幅达15%上榜;首封在 13:39:25;其余 52 条资料包里没有", d.values);
  assert.equal(a.loose, 0, JSON.stringify(a));
});

// ── 正文核对 ──
test("引用:资料包里有的给出原行,编出来的编号单列;同一编号只算一次", () => {
  const lines = new Map([[id("a"), "A 行"], [id("b"), "B 行"]]);
  const c = citationsOf(`x[${id("a")}] y[${id("a")}] z[ev-deadbeef0000] w[${id("b")}]`, lines);
  assert.deepEqual(c.cited, [{ id: id("a"), line: "A 行" }, { id: id("b"), line: "B 行" }]);
  assert.deepEqual(c.unknown, ["ev-deadbeef0000"]);
});

test("明日验证建议:取最后一个 json 块并从正文拿掉;不在清单 / 方向不对 / 重复 / 超 4 条的丢掉并说明;格式坏了不采用", () => {
  const good = parseConditions([
    "汇总正文。", "```json", JSON.stringify([
      { metric: "limit_up_count", direction: "up", reason: "如果涨停继续增加,说明情绪延续" },
      { metric: "凭感觉", direction: "up" },
      { metric: "broken_rate", direction: "sideways" },
      { metric: "limit_up_count", direction: "down" },
      { metric: "broken_rate", direction: "down" },
      { metric: "highest_board", direction: "flat" },
      { metric: "deep_loss_count", direction: "down" },
      { metric: "promotion_1to2", direction: "up" },
    ]), "```",
  ].join("\n"));
  assert.equal(good.body, "汇总正文。");
  assert.deepEqual(good.conditions.map((c) => `${c.metric}:${c.direction}`), ["limit_up_count:up", "broken_rate:down", "highest_board:flat", "deep_loss_count:down"]);
  assert.equal(good.conditions[0]!.reason, "如果涨停继续增加,说明情绪延续");
  assert.match(good.note, /另有 4 条/);
  assert.deepEqual(parseConditions("正文\n```json\n[]\n```"), { body: "正文", conditions: [], note: "" });
  assert.match(parseConditions("正文\n```json\n{oops\n```").note, /格式不对/);
  assert.match(parseConditions("正文\n```json\n{\"metric\":\"limit_up_count\"}\n```").note, /格式不对/);
  assert.deepEqual(parseConditions("只有正文"), { body: "只有正文", conditions: [], note: "AI 没给明日验证建议" });
});

test("正文格式:要有中文;编号、网址、代码块不算英文", () => {
  assert.equal(formatOk(""), false);
  assert.equal(formatOk("I will now analyze the dossier and write the section."), false);
  assert.equal(formatOk(`涨停 69 只[${id("x")}],见 https://example.com/aaaaaaaaaaaaaaaaaaaa`), true);
});

// ── 整条链路:假取数器 + 假 AI ──
const FAKE = String.raw`import json,sys,os
a=sys.argv; ep=a[a.index('--endpoint')+1]
args=json.loads(a[a.index('--args')+1]) if '--args' in a else {}
cfg=json.load(open('cfg.json'))
open('calls.log','a').write(json.dumps({'ep':ep,'args':args})+'\n')
key=args.get('date') or args.get('trade_date') or args.get('end') or '*'
env=cfg.get(ep,{}).get(key) or cfg.get(ep,{}).get('*')
if env is None: print(json.dumps({'status':'failed','reason':'假取数器没这份','evidence':[]})); sys.exit(3)
print(json.dumps(env)); sys.exit(2 if env.get('status')=='partial' else 0)
`;
type Cfg = Record<string, Record<string, unknown>>;
function fakeCtx(): ServiceContext & { setCfg(c: Cfg): void; calls(): { ep: string; args: Record<string, unknown> }[] } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "va-review-"));
  fs.mkdirSync(path.join(repo, "datasources"));
  fs.copyFileSync(path.join(REPO, "datasources", "registry.json"), path.join(repo, "datasources", "registry.json"));
  const scripts = path.join(repo, ".agents", "skills", "data-access", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "fetch_endpoint.py"), FAKE);
  const dataRoot = path.join(repo, ".local");
  fs.mkdirSync(path.join(dataRoot, "ledger"), { recursive: true });
  return {
    repoRoot: repo, dataRoot, python: PY, node: process.execPath,
    setCfg: (c) => fs.writeFileSync(path.join(repo, "cfg.json"), JSON.stringify(c)),
    calls: () => { try { return fs.readFileSync(path.join(repo, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
  };
}
const cleanup = (ctx: ServiceContext) => fs.rmSync(ctx.repoRoot, { recursive: true, force: true });
const ok = (evidence: Ev[], extra: Record<string, unknown> = {}) => ({ status: "ok", extra: { settled: true, ...extra }, evidence });

const E = {
  lu: ev("lu", "limit_up_count", 69, { unit: "只" }),
  br: ev("br", "broken_rate", 0.2, { unit: "小数" }),
  cyc: ev("cyc", "cycle_phase", "分歧", { unit: "text" }),
  fact: ev("fact", "event_ret", 3.5, { unit: "%", record_key: "昨日涨停" }),
  theme: ev("theme", "topic_limit_up", 4, { unit: "只", record_key: "固态电池" }),
  first: ev("first", "first_seal", "092500", { unit: "text", record_key: "002058" }),
  ladder: ev("ladder", "ladder_highest", 4, { unit: "板" }),
  turn: ev("turn", "turnover_amount", 16028123330.46, { unit: "元", record_key: "stock|300750" }),
  amt: ev("amt", "market_amount_total", 2077100295691.36, { unit: "元", record_key: `amount|${DATE}` }),
  margin: ev("margin", "market_financing_net_buy", 14187560664, { unit: "元", period: "2026-10-08", record_key: "margin|2026-10-08" }),
  marginLate: ev("marginLate", "market_financing_net_buy", 999, { unit: "元", period: "2026-10-12", record_key: "margin|2026-10-12" }),
};
const CFG: Cfg = {
  cn_shortline_emotion: { [DATE]: ok([E.lu, E.br]) },
  cn_shortline_cycle: { [DATE]: ok([E.cyc]) },
  cn_shortline_facts: { [DATE]: ok([E.fact]) },
  cn_shortline_themes: { [DATE]: ok([E.theme]) },
  cn_shortline_firstboard: { [DATE]: ok([E.first]) },
  cn_shortline_ladder: { [DATE]: ok([E.ladder]) },
  cn_shortline_turnover_top: { [DATE]: ok([E.turn]) },
  em_market_trend: { [DATE]: ok([E.amt]) },
  em_market_margin: { "*": ok([E.margin, E.marginLate]) },
  em_board_fund_flow: { "*": ok([ev("bf", "board_net", 1, { period: "2026-10-10" })]) },
  // 龙虎榜:假取数器里没有 → 没取到 → 这一段跳过
};

/** 假 AI:按会话名里的分段 id 给正文;记下每次收到的消息 */
function fakeTurn(texts: Partial<Record<string, string | ((n: number) => string)>>): TurnFn & { seen: { session: string; message: string }[] } {
  const seen: { session: string; message: string }[] = [];
  const counts = new Map<string, number>();
  const fn = (async (message: string, session: string) => {
    seen.push({ session, message });
    const sec = Object.keys(texts).find((k) => new RegExp(`-${k}(-format-retry)?$`).test(session));
    if (!sec) throw new Error(`没给 ${session} 准备正文`);
    const n = (counts.get(sec) ?? 0) + 1; counts.set(sec, n);
    const t = texts[sec]!;
    return typeof t === "function" ? t(n) : t;
  }) as TurnFn & { seen: typeof seen };
  fn.seen = seen;
  return fn;
}
const SUMMARY = `今天涨停 69 只[${E.lu.id}],情绪和题材两段说法一致。\n\`\`\`json\n${JSON.stringify([
  { metric: "limit_up_count", direction: "up", reason: "如果涨停继续增加,说明情绪延续" }, { metric: "凭感觉", direction: "up" }])}\n\`\`\``;
const TEXTS = {
  sentiment: `涨停 69 只[${E.lu.id}],比前一天多 69-57=12 只;炸板率 0.2[${E.br.id}]。另见[ev-deadbeef0000]。`,
  capital: `两市成交额 20771 亿元[${E.amt.id}];融资净买入 141.9 亿元[${E.margin.id}],这是前一交易日的数。`,
  theme: `固态电池涨停 4 只[${E.theme.id}]。`,
  leader: `最高标 4 板[${E.ladder.id}],算式 4+1=6。`,
  summary: SUMMARY,
};

test("视图已登记、带写动作;日期不对不取数", async () => {
  assert.ok(listViews().some((v) => v.id === "shortline_review" && v.label === "AI 复盘"));
  assert.equal(FINANCE_LEDGER_KINDS.shortline_review?.label, "AI 复盘");
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CFG);
    await assert.rejects(shortlineReview(ctx, { date: "2026-02-31" }, sig()), (e: unknown) => e instanceof ServiceError && e.code === "bad_query");
    for (const date of ["2026-02-31", "2026-10-11", ""]) {
      await assert.rejects(startReview(ctx, { date }, sig(), NOW, fakeTurn({})), (e: unknown) => e instanceof ServiceError && e.code === "bad_request", date);
    }
    await assert.rejects(shortlineReviewAct(ctx, { action: "rerun", date: DATE }, sig()), (e: unknown) => e instanceof ServiceError && e.code === "bad_request");
    const v = await shortlineReview(ctx, { date: DATE }, sig());
    assert.deepEqual(v.sections.map((s) => s.label), ["情绪", "资金", "题材", "龙虎榜", "龙头", "汇总"]);
    assert.deepEqual([v.versions, v.runs, v.dates], [[], [], []]);
    assert.equal(v.metrics.length, 8);
    assert.deepEqual(ctx.calls(), []);
  } finally { cleanup(ctx); }
});

test("没接 AI 不取数;情绪数据没取到不开工、也不调 AI", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CFG);
    await assert.rejects(shortlineReviewAct(ctx, { action: "start", date: DATE, executionMode: "direct" }, sig()),
      (e: unknown) => e instanceof ServiceError && e.code === "agent_required");
    assert.deepEqual(ctx.calls(), []);
    ctx.setCfg({ ...CFG, cn_shortline_emotion: {} });
    const turn = fakeTurn(TEXTS);
    await assert.rejects(startReview(ctx, { date: DATE }, sig(), NOW, turn), (e: unknown) => e instanceof ServiceError && e.code === "no_data" && /假取数器没这份/.test(e.message));
    assert.deepEqual(turn.seen, []);
  } finally { cleanup(ctx); }
});

test("链路:各段只看自己的证据;之后的数不进;只给当天的来源不取;核对算式和编号;汇总拆出建议;存一版", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CFG);
    const turn = fakeTurn(TEXTS);
    const started = await startReview(ctx, { date: DATE, ai: "Claude 订阅\u0007" }, sig(), NOW, turn);
    assert.equal(started.done, false);
    assert.equal(started.stages.find((s) => s.id === "dragon_tiger")!.status, "skipped");
    await assert.rejects(startReview(ctx, { date: DATE }, sig(), NOW, turn), (e: unknown) => e instanceof ServiceError && e.code === "review_busy");
    const r = await reviewFinished(started.id);

    assert.equal(r.outcome, "completed");
    assert.deepEqual(r.stages.map((s) => `${s.id}:${s.status}`), ["sentiment:done", "capital:done", "theme:done", "dragon_tiger:skipped", "leader:done", "summary:done"]);
    assert.match(r.stages[3]!.error!, /资料都没取到.*假取数器没这份/);
    // 只给当天的行业资金流:复盘 10-09 时不取
    assert.ok(!ctx.calls().some((c) => c.ep === "em_board_fund_flow" || c.ep === "sina_board_flow"));
    assert.ok(r.gaps.some((g) => /只给当天,复盘 2026-10-09 时没有/.test(g)));
    assert.ok(r.gaps.some((g) => /两融余额.*去掉了 1 条 2026-10-09 之后/.test(g)));

    const msg = (sec: string) => turn.seen.find((x) => x.session.endsWith(`-${sec}`))!.message;
    assert.ok(msg("sentiment").includes(E.lu.id) && msg("sentiment").includes(E.cyc.id) && !msg("sentiment").includes(E.theme.id), "情绪段只看情绪的证据");
    assert.ok(msg("capital").includes(E.margin.id) && !msg("capital").includes(E.marginLate.id), "复盘日之后的两融不进资料包");
    assert.ok(!msg("capital").includes(E.lu.id));
    assert.ok(msg("leader").includes(E.ladder.id) && msg("leader").includes(E.lu.id));
    assert.match(msg("sentiment"), /复盘日:2026-10-09/);
    assert.doesNotMatch(msg("sentiment"), /还没收盘/);
    const sum = msg("summary");
    assert.ok(sum.includes(TEXTS.sentiment) && sum.includes(TEXTS.leader), "汇总看到各段正文");
    assert.match(sum, /这些分项跳过了,原因如下;别当它们不存在,也别说成没写成】\n- 龙虎榜:资料都没取到,这一段不写/, "跳过的写原因,不说成没写成");
    assert.doesNotMatch(sum, /没写成,别当它们不存在】/, "没有真没写成的段");
    assert.match(sum, /每段只看到自己那几块数据/);
    assert.ok(!sum.includes("【资料包"), "汇总不再给资料包");
    assert.equal(new Set(turn.seen.map((x) => x.session)).size, turn.seen.length, "每段一个新会话");

    const s = Object.fromEntries(r.stages.map((x) => [x.id, x]));
    assert.deepEqual(s.sentiment!.unknown_cites, ["ev-deadbeef0000"]);
    assert.deepEqual(s.sentiment!.cited!.map((c) => c.id), [E.lu.id, E.br.id]);
    assert.match(s.sentiment!.cited![0]!.line, /limit_up_count = 69只 \(2026-10-09\)/);
    assert.equal(s.sentiment!.audit!.bad_math.length, 0);
    assert.deepEqual(s.leader!.audit!.bad_math.map((b) => [b.stated, b.recomputed]), [[6, 5]], "4+1=6 要标出来");
    assert.equal(s.capital!.audit!.loose, 0, "亿元换算对得上元");
    assert.deepEqual(s.summary!.cited!.map((c) => c.id), [E.lu.id], "汇总的编号对照前面各段的资料包");
    assert.doesNotMatch(s.summary!.text, /```/);
    assert.deepEqual(r.conditions, [{ metric: "limit_up_count", direction: "up", reason: "如果涨停继续增加,说明情绪延续" }]);
    assert.match(r.conditions_note, /另有 1 条/);

    assert.ok(r.saved_id); assert.equal(r.save_error, null);
    const saved = ledgerList(ctx, "shortline_review").shortline_review!;
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.ai, "Claude 订阅");
    assert.equal(saved[0]!.settled, true);
    const v = await shortlineReview(ctx, { date: DATE }, sig());
    assert.equal(v.versions.length, 1);
    assert.equal(v.versions[0]!.sections.find((x) => x.id === "sentiment")!.text, TEXTS.sentiment);
    assert.deepEqual(v.versions[0]!.conditions, r.conditions);
    assert.deepEqual(v.dates, [{ date: DATE, count: 1 }]);
    assert.equal(v.runs[0]!.id, r.id);
    assert.deepEqual((await shortlineReview(ctx, { date: "2026-10-08" }, sig())).versions, []);

    // 再写一版:不覆盖,新的在前
    const r2 = await reviewFinished((await startReview(ctx, { date: DATE }, sig(), NOW, fakeTurn(TEXTS))).id);
    const v2 = await shortlineReview(ctx, { date: DATE }, sig());
    assert.deepEqual(v2.versions.map((x) => x.id), [r2.saved_id, r.saved_id]);
  } finally { cleanup(ctx); }
});

test("同时点开工:取资料那几秒里也占名额;同一天只开一份、合计不超上限;没开成的放回名额", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CFG);
    const turn = fakeTurn(TEXTS);
    const isCode = (code: string) => (r: PromiseSettledResult<unknown>) => r.status === "rejected" && r.reason instanceof ServiceError && r.reason.code === code;
    // 同一天两次几乎同时:只有一份开得成
    const same = await Promise.allSettled([startReview(ctx, { date: DATE }, sig(), NOW, turn), startReview(ctx, { date: DATE }, sig(), NOW, turn)]);
    assert.equal(same.filter((r) => r.status === "fulfilled").length, 1);
    assert.ok(same.some(isCode("review_busy")));
    const first = same.find((r) => r.status === "fulfilled")! as PromiseFulfilledResult<Awaited<ReturnType<typeof startReview>>>;
    // 已有一份在写,再同时点两天:第二天还在取资料时第三天就满了
    const more = await Promise.allSettled([startReview(ctx, { date: "2026-10-08" }, sig(), NOW, turn), startReview(ctx, { date: "2026-10-07" }, sig(), NOW, turn)]);
    assert.ok(isCode("no_data")(more[0]!), "10-08 没情绪数据,取完资料后不开");
    assert.ok(isCode("capacity_full")(more[1]!), "10-08 取资料时占着名额");
    // 10-08 没开成,名额放回:再开 10-07 走到取资料那一步(没数据),不是名额满
    await assert.rejects(startReview(ctx, { date: "2026-10-07" }, sig(), NOW, turn), (e: unknown) => e instanceof ServiceError && e.code === "no_data");
    await reviewFinished(first.value.id);
  } finally { cleanup(ctx); }
});

test("还没收盘:提示 AI 并存成未收盘版;当天的行业资金流东财没取到改用新浪并说明", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({
      ...CFG,
      cn_shortline_emotion: { "2026-10-12": { status: "partial", extra: { settled: false, degraded: "这一天还没收盘" }, evidence: [{ ...E.lu, period: "2026-10-12" }] } },
      em_board_fund_flow: {},
      sina_board_flow: { "*": ok([ev("sina", "board_net_sina", 4937162754.74, { unit: "元", period: "2026-10-12", record_key: "industry|x" })]) },
    });
    const turn = fakeTurn(TEXTS);
    const now = new Date("2026-10-12T06:00:00Z");
    const r = await reviewFinished((await startReview(ctx, { date: "2026-10-12" }, sig(), now, turn)).id);
    assert.equal(r.settled, false);
    assert.match(turn.seen[0]!.message, /这一天还没收盘/);
    assert.ok(r.gaps.some((g) => /情绪四项:不完整\(这一天还没收盘\)/.test(g)));
    assert.ok(r.gaps.some((g) => /改用行业资金流\(新浪口径/.test(g)));
    assert.ok(turn.seen.find((x) => x.session.endsWith("-capital"))!.message.includes(id("sina")));
    assert.equal(ledgerList(ctx, "shortline_review").shortline_review![0]!.settled, false);
  } finally { cleanup(ctx); }
});

test("格式不对重试一次;再不对这段算失败,其余照写;一段都没写成不存、不汇总", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CFG);
    const turn = fakeTurn({
      ...TEXTS,
      sentiment: (n) => (n === 1 ? "Let me think about the dossier first." : TEXTS.sentiment),
      capital: "I cannot answer.",
    });
    const r = await reviewFinished((await startReview(ctx, { date: DATE }, sig(), NOW, turn)).id);
    assert.equal(r.outcome, "completed_with_errors");
    assert.equal(r.stages[0]!.status, "done");
    assert.ok(turn.seen.some((x) => x.session.endsWith("-sentiment-format-retry")));
    assert.equal(r.stages[1]!.status, "failed"); assert.match(r.stages[1]!.error!, /^bad_output_format/);
    assert.ok(r.saved_id);

    const ctx2 = fakeCtx();
    try {
      ctx2.setCfg(CFG);
      const boom = (async () => { throw new Error("AI 掉线"); }) as TurnFn;
      const f = await reviewFinished((await startReview(ctx2, { date: DATE }, sig(), NOW, boom)).id);
      assert.equal(f.outcome, "failed");
      assert.deepEqual(f.stages.map((s) => s.status), ["failed", "failed", "failed", "skipped", "failed", "skipped"]);
      assert.match(f.stages[5]!.error!, /前面五段都没写成/);
      assert.equal(f.saved_id, null);
      assert.deepEqual(ledgerList(ctx2, "shortline_review").shortline_review ?? [], []);
    } finally { cleanup(ctx2); }
  } finally { cleanup(ctx); }
});

test("🔴 开工后 AI 来源换了:这一轮不调 AI 直接停,后面几段也不再调;已写好的照存(审计 2026-10-11 Codex 范围 2 第 6 条)", async () => {
  const ctx = fakeCtx();
  const saved = process.env.VRA_PROVIDER;
  delete process.env.VRA_PROVIDER;
  try {
    // 没指定 llm = 用后台默认;开工时是 Claude 订阅,中途被改成 Codex 订阅
    const cfg = (profile: string) => fs.writeFileSync(path.join(ctx.dataRoot, "config.json"), JSON.stringify({ provider: { profile } }));
    cfg("cli-claude");
    const agent = agentTurnFor(ctx, { executionMode: "agent" });
    cfg("cli-codex");
    await assert.rejects(agent.turn("写一段", "s1"), (e: unknown) => e instanceof ServiceError && e.code === "ai_source_changed");

    ctx.setCfg(CFG);
    const seen: string[] = [];
    const turn: TurnFn = async (_m, session) => {
      seen.push(session);
      if (session.endsWith("-sentiment")) return TEXTS.sentiment;
      throw new ServiceError("ai_source_changed", "开工以后 AI 来源改了");
    };
    const r = await reviewFinished((await startReview(ctx, { date: DATE }, sig(), NOW, turn)).id);
    assert.deepEqual(r.stages.map((x) => x.status), ["done", "failed", "failed", "skipped", "failed", "failed"]);
    assert.equal(seen.length, 2, "换了来源以后一次都不再调");
    assert.match(r.stages[2]!.error!, /ai_source_changed/);
    assert.ok(r.saved_id, "换之前写好的那段照存");
  } finally {
    if (saved === undefined) delete process.env.VRA_PROVIDER; else process.env.VRA_PROVIDER = saved;
    cleanup(ctx);
  }
});

test("中途停:已写好的留着,正在写的和后面的都标已停止;整次不存", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CFG);
    let entered!: () => void;
    const inTurn = new Promise<void>((r) => { entered = r; });
    // 情绪段先写完,停在资金段
    const turn: TurnFn = async (_m, session, signal) => {
      if (session.endsWith("-sentiment")) return TEXTS.sentiment;
      return new Promise((_, reject) => {
        entered();
        signal!.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
    const s = await startReview(ctx, { date: DATE }, sig(), NOW, turn);
    await inTurn;
    const c = cancelReview(s.id);
    assert.equal(c.done, false);
    const r = await reviewFinished(s.id);
    assert.equal(r.outcome, "cancelled");
    assert.deepEqual(r.stages.map((x) => x.status), ["done", "cancelled", "cancelled", "skipped", "cancelled", "cancelled"]);
    assert.equal(r.saved_id, null);
    assert.deepEqual(ledgerList(ctx, "shortline_review").shortline_review ?? [], []);
    assert.throws(() => cancelReview("nope"), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
  } finally { cleanup(ctx); }
});
