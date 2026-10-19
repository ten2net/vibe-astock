import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import "../src/finance/register_tasks.ts";
import { SEAL_UNKNOWN, STRATEGIES, dayContext, entryScore, regimeCuts, regimeOf, rowsOf, sealCurve, shortlineSamples, stats, type SampleRow } from "../src/finance/shortline/samples.ts";
import { detectPython } from "../src/init.ts";
import { ServiceError, type ServiceContext } from "../src/service.ts";
import { listViews } from "../src/views.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";
const row = (o: Partial<SampleRow> = {}): SampleRow => ({ code: "000001", name: "甲", ret: 0, prev_boards: 1, seal_time: "093500", sector: "电网设备", limit_up: null, ...o });
const strat = (name: string) => STRATEGIES.find((s) => s.name === name)!;

// ── 搬自 VA test_core_logic.py:TestSealTimeCurve / TestBacktestFilters ──
test("封板时间分档:上界含;只看首板;缺失单独一档;超出最后一档归最后一档;没样本各项是 null", () => {
  const c = (rows: SampleRow[]) => Object.fromEntries(sealCurve(new Map([["2026-07-24", rows]])).map((b) => [b.bucket, b]));
  let r = c([row({ seal_time: "093500" }), row({ seal_time: "093501" })]);
  assert.deepEqual([r["开盘秒板"]!.sample, r["9:35-10:00"]!.sample], [1, 1]);
  r = c([row({ seal_time: "093000" }), row({ seal_time: "093000", prev_boards: 3 })]);
  assert.equal(r["开盘秒板"]!.sample, 1, "连板股的封板时间含义不同,不进分档");
  r = c([row({ seal_time: "" }), row({ seal_time: "093000" })]);
  assert.deepEqual([r[SEAL_UNKNOWN]!.sample, r["开盘秒板"]!.sample], [1, 1]);
  assert.equal(c([row({ seal_time: "235959" })])["14:00后"]!.sample, 1);
  const empty = sealCurve(new Map());
  assert.ok(empty.every((b) => b.sample === 0 && b.avg === null) && !empty.some((b) => b.bucket === SEAL_UNKNOWN), "没有缺失的就不列「缺失」档");
});

test("策略过滤:早封 / 尾盘封互斥,空封板时间两边都不算;前二行业只管首板、行业缺失不算", () => {
  const ctx = { main_sectors: new Set(["电网设备"]) };
  const early = strat("首板·早封").filter, late = strat("首板·尾盘封").filter;
  assert.ok(early(row({ seal_time: "093500" }), ctx) && !late(row({ seal_time: "093500" }), ctx));
  assert.ok(early(row({ seal_time: "100000" }), ctx), "10:00:00 整算早封(含)");
  assert.ok(late(row({ seal_time: "145900" }), ctx) && !early(row({ seal_time: "145900" }), ctx));
  assert.ok(late(row({ seal_time: "143000" }), ctx), "14:30:00 整算尾盘封(含)");
  assert.ok(!early(row({ seal_time: "" }), ctx) && !late(row({ seal_time: "" }), ctx));
  const main = strat("首板·涨停数前二行业").filter;
  assert.ok(main(row(), ctx) && !main(row({ sector: "房地产" }), ctx) && !main(row({ sector: "" }), ctx) && !main(row({ prev_boards: 2 }), ctx));
  assert.ok(strat("连板接力").filter(row({ prev_boards: 2 }), ctx) && !strat("连板接力").filter(row(), ctx));
  assert.ok(strat("高标接力").filter(row({ prev_boards: 3 }), ctx) && !strat("高标接力").filter(row({ prev_boards: 2 }), ctx));
  assert.deepEqual(STRATEGIES.map((s) => s.name), ["首板打板", "首板·早封", "首板·尾盘封", "首板·涨停数前二行业", "连板接力", "高标接力", "全体涨停"]);
});

test("前二行业:按家数取前二;并列按行业名排(不随数据源顺序变);行业缺失不计", () => {
  const rows = [...Array(5).fill(row({ sector: "A" })), ...Array(3).fill(row({ sector: "B" })), row({ sector: "C" }), row({ sector: "" }), row({ sector: "" }), row({ sector: "" }), row({ sector: "" }), row({ sector: "" }), row({ sector: "" })];
  assert.deepEqual([...dayContext(rows).main_sectors].sort(), ["A", "B"]);
  const tie = (order: string[]) => [...dayContext(order.map((s) => row({ sector: s }))).main_sectors].sort();
  assert.deepEqual(tie(["丙", "乙", "甲"]), tie(["甲", "乙", "丙"]));
  assert.deepEqual(tie(["丙", "乙", "甲"]).length, 2);
});

test("统计:胜率不算平盘;再涨停率判不了的不进分母,全判不了是 null;没样本各项 null", () => {
  const s = stats([row({ ret: 5, limit_up: true }), row({ ret: 0, limit_up: false }), row({ ret: -3, limit_up: null }), row({ ret: 2, limit_up: false })]);
  assert.deepEqual(s, { sample: 4, win_rate: 0.5, avg: 1, median: 1, best: 5, worst: -3, limit_up_rate: 0.333 });
  assert.equal(stats([row({ ret: 9.9 }), row({ ret: 5 })]).limit_up_rate, null, "拿不到涨停判断时不用统一阈值糊弄");
  assert.deepEqual(stats([]), { sample: 0, win_rate: null, avg: null, median: null, best: null, worst: null, limit_up_rate: null });
});

test("情绪分:三项缺一不打分;不足 6 天不分档;分档按三等分,两头含边界", () => {
  assert.equal(entryScore({ limit_up: 50, highest_board: 4, broken_rate: 0.2 }), 200);
  assert.equal(entryScore({ limit_up: 50, highest_board: null, broken_rate: 0.2 }), null);
  assert.equal(entryScore({ limit_up: 50, highest_board: 4, broken_rate: null }), null, "炸板率缺了不能当 0(VA 当 30%)");
  assert.equal(entryScore({ limit_up: null, highest_board: 4, broken_rate: 0.2 }), null);
  assert.equal(entryScore(undefined), null);
  assert.deepEqual(regimeCuts([1, 2, 3, 4, 5, null, null]), { low: null, high: null });
  const cuts = regimeCuts([60, 10, 50, 20, 40, 30, null]);
  assert.deepEqual(cuts, { low: 30, high: 50 });
  assert.deepEqual([10, 30, 31, 49, 50, 60, null].map((s) => regimeOf(s, cuts)), ["情绪弱", "情绪弱", "情绪中", "情绪中", "情绪强", "情绪强", "环境未覆盖"]);
});

test("从信封拼回逐只明细:没有涨跌幅的不要;是否再涨停只认「是 / 否」;别的字段不混进来", () => {
  const ev = (field: string, value: unknown, record_key?: string) => ({ field, value, ...(record_key ? { record_key } : {}) });
  const rows = rowsOf({ evidence: [
    ev("settled_sample", 3),
    ev("settled_name", "甲", "000001"), ev("settled_ret", 3.2, "000001"), ev("settled_prev_boards", 2, "000001"), ev("settled_seal_time", "093000", "000001"),
    ev("settled_sector", "电力", "000001"), ev("settled_limit_up", "是", "000001"),
    ev("settled_name", "乙", "000002"), ev("settled_ret", -1, "000002"), ev("settled_limit_up", "否", "000002"),
    ev("settled_name", "丙", "000003"), ev("settled_prev_boards", 1, "000003"),
    ev("first_board_ret", 9, "000004"),
  ] });
  assert.deepEqual(rows, [
    { code: "000001", name: "甲", ret: 3.2, prev_boards: 2, seal_time: "093000", sector: "电力", limit_up: true },
    { code: "000002", name: "乙", ret: -1, prev_boards: 1, seal_time: "", sector: "", limit_up: false },
  ]);
  assert.deepEqual(rowsOf(null), []);
});

// ── 整条链路:假取数器(cfg.json 给数,calls.log 记每次调用) ──
const FAKE = String.raw`import json,sys,os
a=sys.argv; ep=a[a.index('--endpoint')+1]; out=a[a.index('--out-dir')+1]
sym=a[a.index('--symbol')+1] if '--symbol' in a else ''
args=json.loads(a[a.index('--args')+1]) if '--args' in a else {}
cfg=json.load(open('cfg.json'))
open('calls.log','a').write(json.dumps({'ep':ep,'sym':sym,'args':args})+'\n')
os.makedirs(os.path.join(out,'raw'),exist_ok=True)
n=os.getpid()
def done(env,code=0): print(json.dumps(env)); sys.exit(code)
d=args.get('date','')
un=d in cfg.get('unsettled',[])
def fin(evs):
  if un: done({'status':'partial','extra':{'degraded':'这一天还没收盘：本次结果不缓存','settled':False},'evidence':evs},2)
  done({'status':'ok','extra':{'settled':True},'evidence':evs})
if ep=='tx_kline':
  rows=cfg.get('klines',[])
  if not rows: done({'status':'failed','reason':'腾讯 K 线返回 0 根','evidence':[]})
  ref='raw/extracted_tencent_tencent_kline_%s_%d.json'%(sym,n)
  json.dump({'rows':[{'date':x,'open':1,'high':1,'low':1,'close':1000,'volume':1} for x in rows]},open(os.path.join(out,ref),'w'))
  done({'status':'ok','evidence':[{'field':'kline_points','value':len(rows),'raw_ref':ref}]})
if ep=='cn_shortline_daily':
  v=cfg.get('daily',{}).get(d)
  if v is None: done({'status':'failed','reason':'东财池为空','evidence':[]},3)
  fin([{'field':k,'value':x,'raw_ref':'raw/x.json'} for k,x in v.items()])
if ep=='cn_shortline_settled':
  rs=cfg.get('settled',{}).get(d)
  if rs is None: done({'status':'failed','reason':'东财昨日涨停池没取到(或当天为空)','evidence':[]},3)
  evs=[{'field':'settled_sample','value':len(rs),'raw_ref':'raw/x.json'}]
  for r in rs:
    k=r['code']
    for f in ('name','ret','prev_boards','seal_time','sector'):
      if r.get(f) not in (None,''): evs.append({'field':'settled_'+f,'value':r[f],'record_key':k,'raw_ref':'raw/x.json'})
    if r.get('limit_up') is not None: evs.append({'field':'settled_limit_up','value':'是' if r['limit_up'] else '否','record_key':k,'raw_ref':'raw/x.json'})
  fin(evs)
done({'status':'failed','reason':'unknown','evidence':[]},3)
`;

interface Cfg { klines?: string[]; daily?: Record<string, Record<string, number>>; settled?: Record<string, Partial<SampleRow>[]>; unsettled?: string[] }
type Call = { ep: string; sym: string; args: { date?: string } };

function fakeCtx(): ServiceContext & { setCfg(c: Cfg): void; calls(): Call[] } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "va-samples-"));
  fs.mkdirSync(path.join(repo, "datasources"));
  fs.copyFileSync(path.join(REPO, "datasources", "registry.json"), path.join(repo, "datasources", "registry.json"));
  const scripts = path.join(repo, ".agents", "skills", "data-access", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "fetch_endpoint.py"), FAKE);
  const dataRoot = path.join(repo, ".local");
  fs.mkdirSync(dataRoot, { recursive: true });
  return {
    repoRoot: repo, dataRoot, python: PY, node: process.execPath,
    setCfg: (c) => fs.writeFileSync(path.join(repo, "cfg.json"), JSON.stringify(c)),
    calls: () => { try { return fs.readFileSync(path.join(repo, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call); } catch { return []; } },
  };
}
const cleanup = (ctx: ServiceContext) => fs.rmSync(ctx.repoRoot, { recursive: true, force: true });
const run = (ctx: ServiceContext, q: Record<string, string>, now = "2026-10-10T08:00:00Z") => shortlineSamples(ctx, q, new AbortController().signal, new Date(now));
// 9 月 14 日起 15 个交易日(跳过周末与国庆)
const K = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25",
  "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-08", "2026-10-09"];
/** 偶数位的日子情绪热(涨停 100 → 分 200),奇数位冷(涨停 10 → 分 20):入场日和当天的冷热正好相反,用错一天就整个反过来 */
const DAILY = Object.fromEntries(K.map((d, i) => [d, { limit_up_count: i % 2 ? 10 : 100, ladder_highest: 1, broken_rate: 0 }]));
const hotEntry = (d: string) => K.indexOf(d) % 2 === 1;   // 前一天在偶数位
/** 每天 6 只:首板 A(早封)/ B(尾盘封)/ C(封板时间缺失)/ F(10:00-11:00),2 板 D,3 板 E。行业三家各两只 → 前二按名取军工、电力 */
const dayRows = (d: string): Partial<SampleRow>[] => {
  const r = hotEntry(d) ? 5 : -3;
  return [
    { code: "000001", name: "A", ret: r, prev_boards: 1, seal_time: "093000", sector: "电力", limit_up: hotEntry(d) },
    { code: "000002", name: "B", ret: r, prev_boards: 1, seal_time: "145000", sector: "电力", limit_up: false },
    { code: "000003", name: "C", ret: r, prev_boards: 1, seal_time: "", sector: "芯片" },
    { code: "000006", name: "F", ret: r, prev_boards: 1, seal_time: "110000", sector: "军工", limit_up: false },
    { code: "000004", name: "D", ret: 2, prev_boards: 2, seal_time: "100000", sector: "芯片", limit_up: false },
    { code: "000005", name: "E", ret: -1, prev_boards: 3, seal_time: "093000", sector: "军工", limit_up: false },
  ];
};

test("视图已登记;参数不对什么都不取", async () => {
  assert.ok(listViews().some((v) => v.id === "shortline_samples" && v.label === "涨停样本统计"));
  const ctx = fakeCtx();
  try {
    ctx.setCfg({});
    for (const q of [{}, { date: "2026-02-31" }, { date: "2026-10-09", refresh: "yes" }, { date: "2026-10-12" }, { date: "2026-10-09", days: "9" }, { date: "2026-10-09", days: "91" }, { date: "2026-10-09", days: "30.5" }] as Record<string, string>[]) {
      await assert.rejects(run(ctx, q), (e: unknown) => e instanceof ServiceError && e.code === "bad_query", JSON.stringify(q));
    }
    assert.deepEqual(ctx.calls(), []);
  } finally { cleanup(ctx); }
});

test("链路:分环境用入场那天(前一交易日)的情绪;七条打法、封板分档、净值都按样本算", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ klines: K, daily: DAILY, settled: Object.fromEntries(K.map((d) => [d, dayRows(d)])) });
    const r = await run(ctx, { date: "2026-10-09", days: "10" });
    assert.ok(r.available, r.reason ?? "");
    assert.deepEqual([r.layer, r.days_used, r.date_from, r.date_to, r.missing_days, r.unsettled_days, r.gaps], ["market_phenomenon", 10, "2026-09-21", "2026-10-09", [], [], []]);
    assert.match(r.sample_caveat, /事后名单/);
    assert.match(r.sample_caveat, /不是策略回测/);
    // 只取窗口里的 10 天明细;情绪读数多取一天(窗口第一天的入场日)
    const settledDays = ctx.calls().filter((c) => c.ep === "cn_shortline_settled").map((c) => c.args.date).sort();
    assert.deepEqual(settledDays, K.slice(5));
    assert.deepEqual(ctx.calls().filter((c) => c.ep === "cn_shortline_daily").map((c) => c.args.date).sort(), K.slice(4));

    assert.deepEqual(r.regime_cuts, { low: 20, high: 200 });
    const s = Object.fromEntries(r.strategies.map((x) => [x.name, x]));
    const first = s["首板打板"]!;
    assert.deepEqual(first.overall, { sample: 40, win_rate: 0.5, avg: 1, median: 1, best: 5, worst: -3, limit_up_rate: 0.167 });
    assert.deepEqual([first.by_regime["情绪强"].avg, first.by_regime["情绪强"].sample, first.by_regime["情绪弱"].avg, first.by_regime["情绪中"].sample, first.by_regime["环境未覆盖"].sample],
      [5, 20, -3, 0, 0], "用当天情绪分档会把强弱整个弄反");
    assert.equal(first.by_regime["情绪中"].avg, null);
    assert.deepEqual(first.daily.slice(0, 2), [
      { date: "2026-09-21", sample: 4, avg: 5, regime: "情绪强", equity: 105 },
      { date: "2026-09-22", sample: 4, avg: -3, regime: "情绪弱", equity: 101.85 },
    ]);
    assert.equal(first.final_equity, 109.6, "1.05 × 0.97 连乘 5 次");
    assert.deepEqual(Object.fromEntries(r.strategies.map((x) => [x.name, x.overall.sample])),
      { "首板打板": 40, "首板·早封": 10, "首板·尾盘封": 10, "首板·涨停数前二行业": 30, "连板接力": 20, "高标接力": 10, "全体涨停": 60 });
    assert.deepEqual([s["连板接力"]!.overall.avg, s["高标接力"]!.overall.avg, s["连板接力"]!.overall.limit_up_rate], [0.5, -1, 0]);
    assert.equal(s["首板·早封"]!.overall.limit_up_rate, 0.5, "A 只在入场日热的那 5 天再涨停");
    assert.deepEqual(r.seal_curve.map((b) => [b.bucket, b.sample]),
      [["开盘秒板", 10], ["9:35-10:00", 0], ["10:00-11:00", 10], ["11:00-14:00", 0], ["14:00后", 10], [SEAL_UNKNOWN, 10]]);
  } finally { cleanup(ctx); }
});

test("链路:取不到的日子剔除并说明;没收盘的那天不进统计;入场日读数缺了归「环境未覆盖」", async () => {
  const ctx = fakeCtx();
  try {
    const settled = Object.fromEntries(K.map((d) => [d, dayRows(d)]));
    delete settled["2026-09-21"];
    const daily = { ...DAILY };
    delete daily["2026-09-22"];   // 09-23 的入场日
    ctx.setCfg({ klines: K, daily, settled, unsettled: ["2026-10-09"] });
    const r = await run(ctx, { date: "2026-10-09", days: "10" }, "2026-10-09T05:00:00Z");
    assert.ok(r.available);
    assert.deepEqual([r.days_used, r.date_from, r.date_to, r.missing_days, r.unsettled_days], [8, "2026-09-22", "2026-10-08", ["2026-09-21"], ["2026-10-09"]]);
    assert.deepEqual(r.gaps, [
      "1 个交易日的涨停样本没取到(东财只留最近一个月左右,更早又没缓存过的日子取不到),已剔除",
      "2026-10-09 还没收盘,不进统计",
      "1 天的入场日情绪读数没取到,归「环境未覆盖」",
    ]);
    const first = r.strategies.find((x) => x.name === "首板打板")!;
    assert.equal(first.daily.find((x) => x.date === "2026-09-23")!.regime, "环境未覆盖");
    assert.equal(first.by_regime["环境未覆盖"].sample, 4);
    assert.ok(!first.daily.some((x) => x.date === "2026-10-09"));
  } finally { cleanup(ctx); }
});

test("链路:取到的日子不足 5 天不出统计;K 线取不到只看这一天;那天没取到要说", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ klines: K, daily: DAILY, settled: Object.fromEntries(K.slice(-4).map((d) => [d, dayRows(d)])) });
    const r = await run(ctx, { date: "2026-10-09", days: "10" });
    assert.equal(r.available, false);
    assert.equal(r.reason, "取到样本的交易日不足(4/10,至少 5 天)");
    assert.deepEqual([r.strategies, r.seal_curve, r.missing_days.length], [[], [], 6]);
  } finally { cleanup(ctx); }
  // 新的数据目录:上面那次的 K 线和明细快照会盖住「取不到」
  const fresh = fakeCtx();
  try {
    fresh.setCfg({ daily: DAILY, settled: {} });
    const r = await run(fresh, { date: "2026-10-08", days: "10" });
    assert.equal(r.available, false);
    assert.deepEqual(r.gaps, ["上证A股指数日 K 没取到,列不出之前的交易日,只统计这一天", "2026-10-08 的涨停样本没取到(东财昨日涨停池没取到(或当天为空))"]);
    assert.deepEqual(r.missing_days, ["2026-10-08"]);
  } finally { cleanup(fresh); }
});

test("情绪读数不足 6 天不分环境,统计照出", async () => {
  const ctx = fakeCtx();
  try {
    const daily = Object.fromEntries(K.slice(-5).map((d) => [d, DAILY[d]!]));
    ctx.setCfg({ klines: K, daily, settled: Object.fromEntries(K.map((d) => [d, dayRows(d)])) });
    const r = await run(ctx, { date: "2026-10-09", days: "10" });
    assert.ok(r.available);
    assert.deepEqual(r.regime_cuts, { low: null, high: null });
    assert.deepEqual(r.gaps, ["入场日情绪读数只有 4 天,不足 6 天,不分环境"]);
    assert.ok(r.strategies.every((x) => x.by_regime["环境未覆盖"].sample === x.overall.sample));
  } finally { cleanup(ctx); }
});

test("刷新只重取那一天;超过东财保留期的日子只读缓存、不发请求", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ klines: K, daily: DAILY, settled: Object.fromEntries(K.map((d) => [d, dayRows(d)])) });
    await run(ctx, { date: "2026-10-09", days: "10" });
    const before = ctx.calls().length;
    const r = await run(ctx, { date: "2026-10-09", days: "10", refresh: "1" });
    assert.ok(r.available);
    const again = ctx.calls().slice(before).filter((c) => c.ep !== "tx_kline").map((c) => `${c.ep}:${c.args.date}`).sort();
    assert.deepEqual(again, ["cn_shortline_daily:2026-10-09", "cn_shortline_settled:2026-10-09"]);
  } finally { cleanup(ctx); }
  const late = fakeCtx();
  try {
    late.setCfg({ klines: K, daily: DAILY, settled: Object.fromEntries(K.map((d) => [d, dayRows(d)])) });
    const r = await run(late, { date: "2026-10-09", days: "10" }, "2026-11-20T08:00:00Z");
    assert.deepEqual(late.calls().filter((c) => c.ep !== "tx_kline"), [], "保留期外没缓存过的日子不去白问");
    assert.equal(r.available, false);
    assert.equal(r.gaps[0], "2026-10-09 的涨停样本没取到(超过东财保留期,当时也没缓存)");
  } finally { cleanup(late); }
});
