import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import "../src/finance/register_tasks.ts";
import { compareWindows, fieldDrift, shortlineStructure, structureOf, type DayStructure } from "../src/finance/shortline/structure.ts";
import { followthrough, leadersOf, peakDrawdown, shortlineWeekly } from "../src/finance/shortline/weekly.ts";
import { detectPython } from "../src/init.ts";
import { ServiceError, ledgerInsertMany, type ServiceContext } from "../src/service.ts";
import { listViews } from "../src/views.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";
const ev = (field: string, value: unknown, record_key?: string) => ({ field, value, ...(record_key ? { record_key } : {}) });
const day = (date: string, values: Partial<Record<string, number | null>> = {}, fields: Record<string, string> = {}): DayStructure =>
  ({ date, values: { limit_up: null, share_20cm: null, share_10cm: null, share_bj: null, ...values }, fields });

// ── 纯逻辑(搬自 VA drift.py 的口径) ──
test("从信封读结构:同名数字只认不带 record_key 的那条;字段清单按池子", () => {
  const d = structureOf("2026-10-09", { evidence: [
    ev("limit_up_count", 60), ev("limit_up_count", 999, "某档"), ev("structure_mix_count", 30, "20%"), ev("structure_share_20cm", 0.5), ev("structure_share_bj", 0.1),
    ev("raw_fields", "c,n,zdp", "zt"), ev("raw_fields", "c,n", "yzt"), ev("leader_name", "甲", "600001"),
  ] });
  assert.deepEqual(d.values, { limit_up: 60, share_20cm: 0.5, share_10cm: null, share_bj: 0.1 });
  assert.deepEqual(d.fields, { zt: "c,n,zdp", yzt: "c,n" });
  assert.deepEqual(structureOf("x", null).values.limit_up, null);
});

test("窗口比较:计数看相对变化 ≥35%、占比看绝对变化 ≥0.10(边界算);一律中位数;天数不够的那项不比", () => {
  const prior = Array.from({ length: 6 }, (_, i) => day(`2026-09-0${i + 1}`, { limit_up: 40, share_20cm: 0.25, share_10cm: 0.7, share_bj: 0.05 }));
  const recent = Array.from({ length: 5 }, (_, i) => day(`2026-09-2${i}`, { limit_up: i === 0 ? 500 : 54, share_20cm: 0.35, share_10cm: 0.62, share_bj: null }));
  const { metrics, skipped } = compareWindows(recent, prior);
  const by = Object.fromEntries(metrics.map((m) => [m.metric, m]));
  assert.equal(by.limit_up!.recent, 54, "一天 500 家涨停不该把中位数拉飞");
  assert.equal(by.limit_up!.rel_change, 0.35);
  assert.equal(by.limit_up!.shifted, true, "35% 整算移位");
  assert.equal(by.share_20cm!.shifted, true, "0.35 − 0.25 在浮点里是 0.0999…,也要算到了 0.10");
  assert.equal(by.share_10cm!.shifted, false);
  assert.equal(by.share_20cm!.rel_change, null, "占比不算相对变化");
  assert.ok(!by.share_bj && skipped[0]!.startsWith("北交所占比(最近 0 天"));
  const few = compareWindows(recent.map((d, i) => day(d.date, { ...d.values, share_bj: i < 4 ? 0.2 : null })), prior);
  assert.ok(!few.metrics.some((m) => m.metric === "share_bj") && few.skipped[0]!.startsWith("北交所占比(最近 4 天"), "4 天不够,不比");
  const zero = compareWindows(recent, prior.map((d) => day(d.date, { limit_up: 0 })));
  assert.equal(zero.metrics.find((m) => m.metric === "limit_up")!.shifted, false, "之前是 0 时没法算相对变化,不报移位");
});

test("字段清单:按日期排、连续相同算一版;变了列新增和消失的字段;摘要版比不出明细;不到 2 天检不出", () => {
  const days = [day("2026-09-03", {}, { zt: "a,b,d" }), day("2026-09-01", {}, { zt: "a,b,c", yzt: "x" }), day("2026-09-02", {}, { zt: "a,b,c" })];
  const by = Object.fromEntries(fieldDrift(days).map((d) => [d.pool, d]));
  assert.deepEqual(by.zt!.versions.map((v) => [v.since, v.until, v.count]), [["2026-09-01", "2026-09-02", 3], ["2026-09-03", "2026-09-03", 3]]);
  assert.ok(by.zt!.changed && by.zt!.note.includes("2026-09-03 变过"));
  assert.deepEqual([by.zt!.added, by.zt!.removed], [["d"], ["c"]]);
  assert.ok(!by.yzt!.detectable && by.yzt!.note.startsWith("还检不出:只有 1 天"));
  assert.ok(!by.dt!.changed && by.dt!.days === 0);
  const dig = fieldDrift([day("2026-09-01", {}, { zb: "a,b" }), day("2026-09-02", {}, { zb: "41 个字段,摘要 sha1:0123456789ab" })]).find((d) => d.pool === "zb")!;
  assert.ok(dig.changed && dig.added === null && dig.removed === null && dig.versions[1]!.count === 41);
  const stable = fieldDrift([day("2026-09-01", {}, { zt: "a" }), day("2026-09-02", {}, { zt: "a" })]).find((d) => d.pool === "zt")!;
  assert.ok(!stable.changed && stable.note.startsWith("字段清单稳定(2 天)") && stable.note.includes("只覆盖 2026-09-01 至 2026-09-02"));
});

test("龙头走势:从上榜那天收盘算累计;那天没收盘价算不了;最高点与回撤按收盘价,在最高点时回撤是 0", () => {
  const bars = [{ date: "2026-10-05", close: 9 }, { date: "2026-10-06", close: 10 }, { date: "2026-10-07", close: 11 }, { date: "2026-10-08", close: 12.1 }, { date: "2026-10-09", close: 11.5 }];
  const pts = followthrough(bars, "2026-10-06", "2026-10-09");
  assert.deepEqual(pts, [{ date: "2026-10-06", cum_ret: 0 }, { date: "2026-10-07", cum_ret: 10 }, { date: "2026-10-08", cum_ret: 21 }, { date: "2026-10-09", cum_ret: 15 }]);
  assert.deepEqual(peakDrawdown(pts), { peak: 21, drawdown: -4.96 });
  assert.deepEqual(followthrough(bars, "2026-10-04", "2026-10-09"), [], "上榜那天没有收盘价");
  assert.deepEqual(followthrough(bars, "2026-10-06", "2026-10-07").length, 2, "到页面选的那天为止");
  const top = peakDrawdown([{ date: "a", cum_ret: 0 }, { date: "b", cum_ret: 7.3 }]);
  assert.ok(top.drawdown === 0 && !Object.is(top.drawdown, -0));
  assert.deepEqual(peakDrawdown([{ date: "a", cum_ret: 0 }]), { peak: null, drawdown: null });
  const noise = peakDrawdown([{ date: "a", cum_ret: 1000.01 }, { date: "b", cum_ret: 1000 }]);
  assert.ok(noise.drawdown === 0 && !Object.is(noise.drawdown, -0), "差一点点的回撤四舍五入后是 -0.00,要钳成 0");
});

test("从信封读最高标:保持端点给的顺序;总数另给", () => {
  const r = leadersOf({ evidence: [ev("structure_leader_total", 7), ev("leader_name", "乙", "600002"), ev("leader_boards", 3, "600002"), ev("leader_name", "甲", "600001"),
    ev("leader_sector", "电力", "600001"), ev("leader_first_seal", "093000", "600001"), ev("limit_up_count", 50)] });
  assert.equal(r.total, 7);
  assert.deepEqual(r.leaders, [{ code: "600002", name: "乙", boards: 3, sector: "", first_seal: "" }, { code: "600001", name: "甲", boards: null, sector: "电力", first_seal: "093000" }]);
});

// ── 整条链路:假取数器 ──
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
  if sym=='sh000002': rows=[[x,1000] for x in cfg.get('klines',[])]
  else: rows=[r for r in cfg.get('stocks',{}).get(sym,[]) if args.get('start','')<=r[0]<=args.get('end','9999')]
  if not rows: done({'status':'failed','reason':'腾讯 K 线返回 0 根','evidence':[]})
  ref='raw/extracted_tencent_tencent_kline_%s_%d.json'%(sym,n)
  json.dump({'rows':[{'date':x,'open':1,'high':1,'low':1,'close':c,'volume':1} for x,c in rows]},open(os.path.join(out,ref),'w'))
  done({'status':'ok','evidence':[{'field':'kline_points','value':len(rows),'raw_ref':ref}]})
if ep=='cn_shortline_daily':
  v=cfg.get('daily',{}).get(d)
  if v is None: done({'status':'failed','reason':'东财池为空','evidence':[]},3)
  fin([{'field':k,'value':x,'raw_ref':'raw/x.json'} for k,x in v.items()])
if ep=='cn_shortline_structure':
  s=cfg.get('structure',{}).get(d)
  if s is None: done({'status':'failed','reason':'东财涨停池为空(数据还没出,或超过东财保留期)','evidence':[]},3)
  evs=[{'field':k,'value':x,'raw_ref':'raw/x.json'} for k,x in s.get('values',{}).items()]
  evs+=[{'field':'raw_fields','value':f,'record_key':k,'raw_ref':'raw/x.json'} for k,f in s.get('fields',{}).items()]
  if 'leaders' in s: evs.append({'field':'structure_leader_total','value':s.get('total',len(s['leaders'])),'raw_ref':'raw/x.json'})
  for l in s.get('leaders',[]):
    for f in ('name','boards','sector','first_seal'):
      if l.get(f) not in (None,''): evs.append({'field':'leader_'+f,'value':l[f],'record_key':l['code'],'raw_ref':'raw/x.json'})
  fin(evs)
done({'status':'failed','reason':'unknown','evidence':[]},3)
`;

interface Leader { code: string; name: string; boards: number; sector?: string; first_seal?: string }
interface Cfg {
  klines?: string[];
  daily?: Record<string, Record<string, number>>;
  structure?: Record<string, { values?: Record<string, number>; fields?: Record<string, string>; leaders?: Leader[]; total?: number }>;
  stocks?: Record<string, [string, number][]>;
  unsettled?: string[];
}
type Call = { ep: string; sym: string; args: { date?: string; start?: string; end?: string } };

function fakeCtx(): ServiceContext & { setCfg(c: Cfg): void; calls(): Call[]; clearCalls(): void } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "va-structure-"));
  fs.mkdirSync(path.join(repo, "datasources"));
  fs.copyFileSync(path.join(REPO, "datasources", "registry.json"), path.join(repo, "datasources", "registry.json"));
  const scripts = path.join(repo, ".agents", "skills", "data-access", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "fetch_endpoint.py"), FAKE);
  const dataRoot = path.join(repo, ".local");
  fs.mkdirSync(dataRoot, { recursive: true });
  const log = path.join(repo, "calls.log");
  return {
    repoRoot: repo, dataRoot, python: PY, node: process.execPath,
    setCfg: (c) => fs.writeFileSync(path.join(repo, "cfg.json"), JSON.stringify(c)),
    calls: () => { try { return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call); } catch { return []; } },
    clearCalls: () => fs.rmSync(log, { force: true }),
  };
}
const cleanup = (ctx: ServiceContext) => fs.rmSync(ctx.repoRoot, { recursive: true, force: true });
const NOW = new Date("2026-10-10T08:00:00Z");
const sig = () => new AbortController().signal;

/** 2026-10-09 往前 32 个工作日(不管节假日,假数据而已) */
const WEEKDAYS: string[] = (() => {
  const out: string[] = [];
  for (let t = Date.parse("2026-10-09T00:00:00Z"); out.length < 32; t -= 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
  }
  return out;
})();
const WINDOW = WEEKDAYS.slice(-30);
const RECENT_D = WINDOW.slice(-10), PRIOR_D = WINDOW.slice(0, 20);
const CHANGE_DAY = RECENT_D[3]!;
const structureCfg = (skipPrior = 0) => Object.fromEntries([
  ...PRIOR_D.slice(skipPrior).map((d) => [d, { values: { limit_up_count: 50, structure_share_20cm: 0.3, structure_share_10cm: 0.7, structure_share_bj: 0 }, fields: { zt: "a,b,c", dt: "x" } }]),
  ...RECENT_D.map((d) => [d, { values: { limit_up_count: 100, structure_share_20cm: 0.5, structure_share_10cm: 0.5, structure_share_bj: 0 }, fields: { zt: d >= CHANGE_DAY ? "a,b,d" : "a,b,c", dt: "x" } }]),
]);

test("结构变化:视图已登记;参数不对什么都不取", async () => {
  assert.ok(listViews().some((v) => v.id === "shortline_structure" && v.label === "结构变化"));
  assert.ok(listViews().some((v) => v.id === "shortline_weekly"));
  const ctx = fakeCtx();
  try {
    ctx.setCfg({});
    for (const q of [{}, { date: "2026-02-31" }, { date: "2026-10-09", refresh: "yes" }, { date: "2026-10-12" }] as Record<string, string>[]) {
      await assert.rejects(shortlineStructure(ctx, q, sig(), NOW), (e: unknown) => e instanceof ServiceError && e.code === "bad_query");
      await assert.rejects(shortlineWeekly(ctx, q, sig(), NOW), (e: unknown) => e instanceof ServiceError && e.code === "bad_query");
    }
    assert.equal(ctx.calls().length, 0);
  } finally { cleanup(ctx); }
});

test("结构变化:最近 10 天 vs 之前 20 天;字段变化列出明细;制度事件只读台账,未来日期标还没施行;取不到的日子剔除并说明", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ klines: WEEKDAYS, structure: structureCfg(3) });
    // 东财只留一个月左右:10-10 打开时 9 月 12 日以前的日子只读缓存。先在 9 月 26 日打开过一次,那时取到的就留下了
    const early = await shortlineStructure(ctx, { date: "2026-09-25" }, sig(), new Date("2026-09-26T08:00:00Z"));
    assert.ok(early.structure.available && early.structure.shifted.length === 0, "那时两边都是同一种结构");
    ctx.clearCalls();
    ledgerInsertMany(ctx, { kind: "regime_event", records: [
      { date: "2026-11-01", title: "新规施行", note: "提前公布" },
      { date: "2026-07-06", title: "主板 ST 涨跌幅改 10%" },
    ] });
    const r = await shortlineStructure(ctx, { date: "2026-10-09" }, sig(), NOW);
    assert.ok(r.available && r.structure.available);
    assert.deepEqual([r.recent_window.used, r.prior_window.days, r.prior_window.used, r.prior_window.from], [10, 20, 17, PRIOR_D[3]]);
    const by = Object.fromEntries(r.structure.metrics.map((m) => [m.metric, m]));
    assert.deepEqual([by.limit_up!.prior, by.limit_up!.recent, by.limit_up!.rel_change, by.limit_up!.shifted], [50, 100, 1, true]);
    assert.deepEqual(r.structure.shifted.map((m) => m.metric), ["limit_up", "share_20cm", "share_10cm"]);
    assert.equal(by.share_bj!.shifted, false);
    const zt = r.field_drift.find((d) => d.pool === "zt")!;
    assert.ok(zt.changed && zt.versions[1]!.since === CHANGE_DAY);
    assert.deepEqual([zt.added, zt.removed], [["d"], ["c"]]);
    assert.deepEqual(r.field_changed, ["涨停池"]);
    assert.deepEqual(r.regime_events.map((e) => [e.date, e.upcoming]), [["2026-07-06", false], ["2026-11-01", true]]);
    assert.ok(r.summary.includes("1 张池子的上游字段变过(涨停池)") && r.summary.includes("涨停家数、20% 制度占比、10% 制度占比明显移位"));
    assert.ok(r.summary.includes("已登记 1 条制度事件,另有 1 条还没施行"));
    assert.deepEqual(r.missing_days, PRIOR_D.slice(0, 3), "当时就没取到、又过了保留期的,剔除");
    assert.ok(r.gaps.some((g) => g.startsWith("3 个交易日的涨停结构没取到")));
    assert.deepEqual(ctx.calls().filter((c) => c.ep === "cn_shortline_structure").map((c) => c.args.date).sort(), RECENT_D.filter((d) => d > "2026-09-25"),
      "9 月 26 日那次取到的日子读缓存;过了保留期的不再去取");

    // 再开一次全读缓存;refresh 只重取那一天
    ctx.clearCalls();
    await shortlineStructure(ctx, { date: "2026-10-09" }, sig(), NOW);
    assert.equal(ctx.calls().filter((c) => c.ep === "cn_shortline_structure").length, 0);
    await shortlineStructure(ctx, { date: "2026-10-09", refresh: "1" }, sig(), NOW);
    assert.deepEqual(ctx.calls().filter((c) => c.ep === "cn_shortline_structure").map((c) => c.args.date), ["2026-10-09"]);
  } finally { cleanup(ctx); }
});

test("结构变化:之前窗口不够 5 天就不比结构,但字段清单和制度事件照出;没收盘的日子不进比较", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ klines: WEEKDAYS, structure: structureCfg(16), unsettled: ["2026-10-09"] });
    const r = await shortlineStructure(ctx, { date: "2026-10-09" }, sig(), NOW);
    assert.equal(r.structure.available, false);
    assert.equal(r.structure.reason, "最近 10 个交易日取到 9 天、之前 20 个交易日取到 4 天,每个窗口至少要 5 天");
    assert.ok(r.available && r.field_drift.find((d) => d.pool === "zt")!.changed, "结构比不了,字段清单照样看");
    assert.deepEqual(r.unsettled_days, ["2026-10-09"]);
    assert.ok(r.gaps.includes("2026-10-09 还没收盘,不进比较"));
    assert.ok(r.summary.includes("结构比较暂不可用") && r.summary.includes("还没登记制度事件"));
  } finally { cleanup(ctx); }
});

test("结构变化:上证日 K 取不到就只看那一天,说清楚", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ structure: structureCfg() });
    const r = await shortlineStructure(ctx, { date: "2026-10-09" }, sig(), NOW);
    assert.ok(r.gaps[0]!.startsWith("上证A股指数日 K 没取到"));
    assert.deepEqual([r.recent_window.days, r.prior_window.days, r.structure.available], [1, 0, false]);
  } finally { cleanup(ctx); }
});

const W5 = WEEKDAYS.slice(-5);
const weeklyCfg = (): Cfg => ({
  klines: WEEKDAYS,
  daily: Object.fromEntries(W5.map((d, i) => [d, { limit_up_count: 40 + i * 10, ladder_highest: 2 + i, broken_rate: 0.2 }])),
  structure: {
    [W5[0]!]: { leaders: [{ code: "600001", name: "甲", boards: 2, sector: "电力" }] },
    [W5[1]!]: { leaders: [{ code: "600001", name: "甲", boards: 3 }, { code: "600002", name: "乙", boards: 3 }] },
    [W5[2]!]: { leaders: [{ code: "920001", name: "北", boards: 4 }], total: 1 },
    // W5[3] 取不到
    [W5[4]!]: { leaders: [{ code: "600003", name: "丙", boards: 6 }] },
  },
  stocks: {
    "600001": W5.map((d, i) => [d, [10, 11, 12.1, 11, 11.5][i]!]),
    "600002": W5.map((d, i) => [d, [9, 10, 9, 8, 8][i]!]),
    "600003": W5.map((d) => [d, 20]),
  },
});

test("近 5 天热度与龙头谱系:每天三项读数 + 最高标;谱系按上榜先后去重、累计从上榜那天收盘算;北交所和取不到的如实说", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(weeklyCfg());
    const r = await shortlineWeekly(ctx, { date: "2026-10-09" }, sig(), NOW);
    assert.deepEqual(r.days.map((d) => d.date), W5);
    assert.deepEqual(r.days.map((d) => [d.limit_up, d.highest_board, d.broken_rate]), W5.map((_, i) => [40 + i * 10, 2 + i, 0.2]));
    assert.deepEqual(r.days[1]!.leaders.map((l) => l.code), ["600001", "600002"]);
    assert.ok(r.days[3]!.leaders.length === 0 && r.days[3]!.note.includes("最高标没取到"));
    const by = Object.fromEntries(r.lineage.map((x) => [x.code, x]));
    assert.deepEqual(r.lineage.map((x) => [x.code, x.appear_date]), [["600001", W5[0]], ["600002", W5[1]], ["920001", W5[2]], ["600003", W5[4]]]);
    assert.deepEqual([by["600001"]!.cum_return_since, by["600001"]!.peak_cum_ret, by["600001"]!.drawdown_from_peak, by["600001"]!.boards_then], [15, 21, -4.96, 2]);
    assert.deepEqual([by["600002"]!.cum_return_since, by["600002"]!.series.length], [-20, 4]);
    assert.ok(by["920001"]!.series_warning.includes("不支持北交所") && by["920001"]!.cum_return_since === null);
    assert.deepEqual([by["600003"]!.cum_return_since, by["600003"]!.peak_cum_ret, by["600003"]!.is_current_top, by["600001"]!.is_current_top], [0, null, true, false]);
    const kl = ctx.calls().filter((c) => c.ep === "tx_kline" && c.sym !== "sh000002");
    assert.deepEqual(kl.map((c) => [c.sym, c.args.start, c.args.end]).sort(), [["600001", W5[0], "2026-10-09"], ["600002", W5[1], "2026-10-09"], ["600003", W5[4], "2026-10-09"]]);
    assert.equal(r.gaps.length, 0);
  } finally { cleanup(ctx); }
});

test("近 5 天:最后一天没取到最高标、没收盘都要说;个股 K 线取不到不拖累别的", async () => {
  const ctx = fakeCtx();
  try {
    const cfg = weeklyCfg();
    delete cfg.structure![W5[4]!];
    delete cfg.stocks!["600002"];
    ctx.setCfg({ ...cfg, unsettled: [W5[4]!] });
    const r = await shortlineWeekly(ctx, { date: "2026-10-09" }, sig(), NOW);
    assert.ok(r.gaps.includes(`${W5[4]} 的最高标没取到,现在的最高标未知`));
    assert.ok(r.gaps.includes(`${W5[4]} 还没收盘,最后一天的读数和走势收盘前还会变`));
    const by = Object.fromEntries(r.lineage.map((x) => [x.code, x]));
    assert.ok(by["600002"]!.series_warning.startsWith("后续收盘行情没取到") && by["600001"]!.cum_return_since === 15);
    assert.ok(r.lineage.every((x) => !x.is_current_top));
  } finally { cleanup(ctx); }
});
