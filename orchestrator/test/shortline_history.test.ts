import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import "../src/finance/register_tasks.ts";
import { detectPython } from "../src/init.ts";
import { ServiceError, type ServiceContext } from "../src/service.ts";
import { listViews } from "../src/views.ts";
import { DAYS_MAX, MIN_SAMPLES, READINGS, SOURCE_RETENTION_DAYS, contextFor, diffFor, percentile, shortlineHistory, valuesOf, type Values } from "../src/finance/shortline/history.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const vals = (v: Partial<Values>): Values => ({ limit_up: null, highest_board: null, broken_rate: null, money_effect: null, deep_loss: null, promotion_1to2: null, ...v });

// ── 搬自 VA test_core_logic.py 的 TestStatsContext ──
test("分位:样本不到 10 天不给;小于等于它的比例;值缺失不给", () => {
  assert.equal(MIN_SAMPLES, 10);
  assert.equal(percentile(5, [1, 2, 3]), null, "3 个样本不该给分位");
  assert.notEqual(percentile(5, range(1, 20)), null);
  assert.equal(percentile(5, range(1, 10)), 0.5);
  assert.equal(percentile(100, range(1, 10)), 1);
  assert.equal(percentile(0, range(1, 10)), 0);
  assert.equal(percentile(null, range(1, 10)), null);
  assert.equal(percentile(5, [...range(1, 9), null, null]), null, "缺的日子不算样本");
  assert.equal(percentile(2, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 0.167);
});

test("六项读数:方向和噪声门槛跟 VA 一样", () => {
  const by = Object.fromEntries(READINGS.map((r) => [r.key, r]));
  assert.deepEqual(READINGS.map((r) => r.key), ["limit_up", "highest_board", "broken_rate", "money_effect", "deep_loss", "promotion_1to2"]);
  assert.equal(by.limit_up!.higher_is_hotter, true);
  assert.equal(by.broken_rate!.higher_is_hotter, false, "炸板率高 = 情绪冷");
  assert.equal(by.deep_loss!.higher_is_hotter, false);
  assert.ok(by.limit_up!.diff_eps >= 5, "涨停家数的门槛太小会被日常波动刷屏");
  assert.deepEqual(READINGS.map((r) => r.diff_eps), [8, 0.5, 0.08, 1.0, 8, 0.08]);
});

const hist = (n: number, f: (i: number) => Partial<Values>) => range(1, n).map((i) => ({ date: `2026-09-${String(i).padStart(2, "0")}`, values: vals(f(i)) }));

test("历史位置:分位只跟之前比、不含当天;同样的高分位,涨停多是偏热、炸板率高是偏冷", () => {
  const rows = [...hist(12, (i) => ({ limit_up: 40 + i, broken_rate: 0.1 + i / 100, money_effect: i % 2 ? 1 : -1 })),
    { date: "2026-10-09", values: vals({ limit_up: 90, broken_rate: 0.5, money_effect: 0 }) }];
  const c = contextFor("2026-10-09", rows);
  assert.ok(c.available);
  assert.equal(c.sample_days, 12);
  const it = Object.fromEntries(c.items.map((x) => [x.key, x]));
  assert.equal(it.limit_up!.percentile, 1); assert.equal(it.limit_up!.extreme, "偏热");
  assert.equal(it.broken_rate!.percentile, 1); assert.equal(it.broken_rate!.extreme, "偏冷");
  assert.equal(it.money_effect!.percentile, 0.5); assert.equal(it.money_effect!.extreme, null);
  assert.equal(it.limit_up!.hist_min, 41); assert.equal(it.limit_up!.hist_max, 52); assert.equal(it.limit_up!.hist_median, 46.5);
  assert.equal(it.highest_board!.value, null); assert.equal(it.highest_board!.percentile, null); assert.equal(it.highest_board!.hist_median, null);
  assert.equal(c.extreme_count, 2);
  // 低分位:涨停少是偏冷、炸板率低是偏热
  const low = contextFor("2026-10-09", [...rows.slice(0, -1), { date: "2026-10-09", values: vals({ limit_up: 10, broken_rate: 0.01 }) }]);
  assert.ok(low.available);
  assert.deepEqual(low.items.filter((x) => x.extreme).map((x) => [x.key, x.extreme]), [["limit_up", "偏冷"], ["broken_rate", "偏热"]]);
});

test("历史位置:那天没数据就不给;样本不够只报数不给分位", () => {
  assert.deepEqual(contextFor("2026-10-09", []), { available: false, reason: "历史读数一天都没有" });
  assert.deepEqual(contextFor("2026-10-09", hist(3, () => ({ limit_up: 50 }))), { available: false, reason: "2026-10-09 的读数没取到" });
  const c = contextFor("2026-09-05", hist(5, (i) => ({ limit_up: 40 + i })));
  assert.ok(c.available);
  assert.equal(c.items[0]!.value, 45);
  assert.equal(c.items[0]!.percentile, null, "4 天历史不给分位");
  assert.equal(c.extreme_count, 0);
});

test("跟前一天比:不超过门槛的不列;方向按冷热翻译;按「变化 ÷ 门槛」排", () => {
  const rows = [
    { date: "2026-10-08", values: vals({ limit_up: 43, highest_board: 8, broken_rate: 0.427, money_effect: -1.85, deep_loss: 11, promotion_1to2: 0.075 }) },
    { date: "2026-10-09", values: vals({ limit_up: 69, highest_board: 9, broken_rate: 0.169, money_effect: 1.95, deep_loss: 3, promotion_1to2: 0.242 }) },
  ];
  const d = diffFor("2026-10-09", rows);
  assert.ok(d.available);
  assert.equal(d.prev_date, "2026-10-08");
  // 涨停 +26/8=3.25、最高板 +1/0.5=2、炸板率 −0.258/0.08=3.2、赚钱效应 +3.8/1=3.8、跌超5% −8 不超过 8 → 不列、1进2 +0.167/0.08=2.09
  assert.deepEqual(d.changes.map((c) => [c.key, c.delta, c.hotter]), [
    ["money_effect", 3.8, true], ["limit_up", 26, true], ["broken_rate", -0.26, true], ["promotion_1to2", 0.17, true], ["highest_board", 1, true],
  ]);
  assert.equal(d.unchanged_count, 1);
  const noise = diffFor("2026-10-09", [rows[0]!, { date: "2026-10-09", values: vals({ limit_up: 50, broken_rate: 0.55, deep_loss: 4 }) }]);
  assert.ok(noise.available);
  assert.deepEqual(noise.changes.map((c) => [c.key, c.hotter]), [["broken_rate", false]], "涨停 43→50、跌超5% 11→4 都在噪声里;炸板率上升是转冷");
  assert.ok(diffFor("2026-10-09", [rows[0]!, { date: "2026-10-09", values: vals({ broken_rate: 0.5 }) }]).available);
  assert.deepEqual((diffFor("2026-10-09", [rows[0]!, { date: "2026-10-09", values: vals({ broken_rate: 0.507 }) }]) as { changes: unknown[] }).changes, [], "+0.08 正好等于门槛也不算");
  assert.deepEqual(diffFor("2026-10-09", rows.slice(1)), { available: false, reason: "历史不足两天,没法比较" });
  assert.deepEqual(diffFor("2026-10-10", rows), { available: false, reason: "2026-10-10 的读数没取到" });
});

test("从信封取数:按字段和 record_key 取,1进2 只认 record_key=1进2;不是数字就是 null", () => {
  const env = { evidence: [
    { field: "limit_up_count", value: 69 }, { field: "ladder_highest", value: "9" },
    { field: "promotion_rate", record_key: "2进3", value: 0.5 }, { field: "promotion_rate", record_key: "1进2", value: 0.242 },
    { field: "money_effect_median_ret", value: Number.NaN }, null, "x",
  ] };
  assert.deepEqual(valuesOf(env), vals({ limit_up: 69, promotion_1to2: 0.242 }));
  assert.deepEqual(valuesOf(null), vals({}));
});

// ── 整条链路:假取数器(读仓库根目录的 cfg.json,每次调用记一行 calls.log) ──
const FAKE = String.raw`import json,sys,os
a=sys.argv; ep=a[a.index('--endpoint')+1]; out=a[a.index('--out-dir')+1]
sym=a[a.index('--symbol')+1] if '--symbol' in a else ''
args=json.loads(a[a.index('--args')+1]) if '--args' in a else {}
cfg=json.load(open('cfg.json'))
open('calls.log','a').write(json.dumps({'ep':ep,'sym':sym,'args':args})+'\n')
os.makedirs(os.path.join(out,'raw'),exist_ok=True)
n=os.getpid()
def done(env,code=0): print(json.dumps(env)); sys.exit(code)
if ep=='tx_kline':
  rows=cfg.get('klines',[])
  if not rows: done({'status':'failed','reason':'腾讯 K 线返回 0 根','evidence':[]})
  ref='raw/extracted_tencent_tencent_kline_%s_%d.json'%(sym,n)
  json.dump({'rows':[{'date':d,'open':1,'high':1,'low':1,'close':1000,'volume':1} for d in rows]},open(os.path.join(out,ref),'w'))
  done({'status':'ok','evidence':[{'field':'kline_points','value':len(rows),'raw_ref':ref}]})
if ep=='cn_shortline_daily':
  d=args.get('date','')
  if d in cfg.get('fail',[]): done({'status':'failed','reason':'%s 不是交易日'%d,'evidence':[],'missing':[]},3)
  v=cfg.get('daily',{}).get(d)
  if v is None: done({'status':'failed','reason':'东财池为空','evidence':[]},3)
  evs=[{'field':k,'value':x,'raw_ref':'raw/x.json',**({'record_key':'1进2'} if k=='promotion_rate' else {})} for k,x in v.items()]
  if d in cfg.get('unsettled',[]): done({'status':'partial','extra':{'degraded':'这一天还没收盘：数字收盘前还会变，本次结果不缓存','settled':False},'evidence':evs},2)
  done({'status':'ok','extra':{'settled':True},'evidence':evs})
done({'status':'failed','reason':'unknown','evidence':[]},3)
`;

interface Cfg { klines?: string[]; daily?: Record<string, Record<string, number>>; fail?: string[]; unsettled?: string[] }
type Call = { ep: string; sym: string; args: { date?: string; count?: number } };

function fakeCtx(): ServiceContext & { setCfg(c: Cfg): void; calls(): Call[] } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "va-shist-"));
  fs.mkdirSync(path.join(repo, "datasources"));
  fs.copyFileSync(path.join(REPO, "datasources", "registry.json"), path.join(repo, "datasources", "registry.json"));
  const scripts = path.join(repo, ".agents", "skills", "data-access", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "fetch_endpoint.py"), FAKE);
  const dataRoot = path.join(repo, ".local");
  fs.mkdirSync(dataRoot);
  return {
    repoRoot: repo, dataRoot, python: PY, node: process.execPath,
    setCfg: (c) => fs.writeFileSync(path.join(repo, "cfg.json"), JSON.stringify(c)),
    calls: () => { try { return fs.readFileSync(path.join(repo, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call); } catch { return []; } },
  };
}
const run = (ctx: ServiceContext, query: Record<string, string>, now: string) => shortlineHistory(ctx, query, new AbortController().signal, new Date(now));
const cleanup = (ctx: ServiceContext) => fs.rmSync(ctx.repoRoot, { recursive: true, force: true });
const dailyCalls = (calls: Call[]) => calls.filter((c) => c.ep === "cn_shortline_daily").map((c) => c.args.date ?? "");
const day = (lu: number) => ({ limit_up_count: lu, ladder_highest: 5, broken_rate: 0.2, money_effect_median_ret: 1.0, loss_deep5_count: 5, promotion_rate: 0.25 });

test("视图已登记;参数不对什么都不取", async () => {
  assert.ok(listViews().some((v) => v.id === "shortline_history" && v.label === "情绪历史"));
  const ctx = fakeCtx();
  try {
    ctx.setCfg({});
    for (const q of [{}, { date: "2026-13-01" }, { date: "20261009" }, { date: "2026-10-09", refresh: "true" },
      { date: "2026-10-09", days: "4" }, { date: "2026-10-09", days: String(DAYS_MAX + 1) }, { date: "2026-10-09", days: "7.5" }, { date: "2026-10-12" }] as Record<string, string>[]) {
      await assert.rejects(run(ctx, q, "2026-10-10T08:00:00Z"), (e: unknown) => e instanceof ServiceError && e.code === "bad_query", JSON.stringify(q));
    }
    assert.deepEqual(ctx.calls(), []);
  } finally { cleanup(ctx); }
});

test("链路:窗口 = 日 K 里之前 N−1 个交易日 + 那天;已收盘的日子第二次读缓存;没收盘的那天每次现取", async () => {
  const ctx = fakeCtx();
  const K = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-08", "2026-10-09", "2026-10-12"];
  try {
    ctx.setCfg({ klines: K, unsettled: ["2026-10-12"], daily: { "2026-09-29": day(57), "2026-09-30": day(52), "2026-10-08": day(43), "2026-10-09": day(69), "2026-10-12": day(80) } });
    const r = await run(ctx, { date: "2026-10-12", days: "5" }, "2026-10-12T05:00:00Z");
    assert.deepEqual(r.series.map((s) => s.date), ["2026-09-29", "2026-09-30", "2026-10-08", "2026-10-09", "2026-10-12"]);
    assert.deepEqual(r.series.map((s) => s.status), ["ok", "ok", "ok", "ok", "partial"]);
    assert.match(r.series[4]!.note, /还没收盘/, "端点的说明在 extra.degraded 里(信封顶层没有)");
    assert.deepEqual(r.series.map((s) => s.settled), [true, true, true, true, false]);
    assert.equal(r.series[3]!.values.limit_up, 69);
    assert.ok(r.context.available && r.context.sample_days === 4 && r.context.items[0]!.value === 80);
    assert.ok(r.diff.available && r.diff.prev_date === "2026-10-09" && r.diff.changes[0]!.key === "limit_up");
    assert.deepEqual(r.gaps, []);
    assert.deepEqual(r.readings.map((x) => Object.keys(x).sort()), READINGS.map(() => ["diff_eps", "higher_is_hotter", "key", "kind", "label", "unit"]));
    assert.deepEqual(dailyCalls(ctx.calls()).sort(), r.series.map((s) => s.date));
    const r2 = await run(ctx, { date: "2026-10-12", days: "5" }, "2026-10-12T05:01:00Z");
    assert.deepEqual(dailyCalls(ctx.calls()).slice(5).sort(), ["2026-10-12"], "已收盘的四天读快照;没收盘的那天不进快照,每次现取");
    assert.deepEqual(r2.series.map((s) => s.cached), [true, true, true, true, false]);
    // 刷新只重取那一天
    await run(ctx, { date: "2026-10-09", days: "5", refresh: "1" }, "2026-10-12T05:02:00Z");
    assert.deepEqual(dailyCalls(ctx.calls()).slice(6).sort(), ["2026-09-28", "2026-10-09"], "09-28 第一次进窗口要取;10-09 显式刷新");
  } finally { cleanup(ctx); }
});

test("取不到的日子不补零:不进分位、说明原因;那天本身取不到就不给位置", async () => {
  const ctx = fakeCtx();
  const K = range(14, 30).map((d) => `2026-09-${d}`).concat(["2026-10-08", "2026-10-09"]);
  try {
    const daily: Record<string, Record<string, number>> = {};
    K.forEach((d, i) => { daily[d] = day(40 + i); });
    delete daily["2026-09-20"];
    ctx.setCfg({ klines: K, daily, fail: ["2026-09-21"] });
    const r = await run(ctx, { date: "2026-10-09", days: "19" }, "2026-10-10T08:00:00Z");
    assert.equal(r.series.length, 19);
    const miss = r.series.filter((s) => s.status === "missing");
    assert.deepEqual(miss.map((s) => [s.date, s.note]), [["2026-09-20", "东财池为空"], ["2026-09-21", "2026-09-21 不是交易日"]]);
    assert.ok(miss.every((s) => Object.values(s.values).every((v) => v === null)), "没取到写 null,不是 0");
    assert.ok(r.context.available && r.context.sample_days === 16);
    assert.match(r.gaps.join(""), /2 个交易日没取到读数/);
    ctx.setCfg({ klines: K, daily, fail: ["2026-10-09"] });
    const r2 = await run(ctx, { date: "2026-10-09", days: "19", refresh: "1" }, "2026-10-10T08:00:00Z");
    assert.deepEqual(r2.context, { available: false, reason: "2026-10-09 的读数没取到" });
    assert.match(r2.gaps[0]!, /^2026-10-09 的读数没取到\(2026-10-09 不是交易日\)/);
  } finally { cleanup(ctx); }
});

test(`超过东财保留期(${SOURCE_RETENTION_DAYS} 天)又没缓存的日子:不发请求,说明取不到的原因`, async () => {
  const ctx = fakeCtx();
  const K = ["2026-09-01", "2026-09-02", "2026-09-11", "2026-09-14", "2026-10-09"];
  try {
    ctx.setCfg({ klines: K, daily: Object.fromEntries(K.map((d) => [d, day(50)])) });
    const r = await run(ctx, { date: "2026-10-09", days: "5" }, "2026-10-10T08:00:00Z");
    assert.deepEqual(dailyCalls(ctx.calls()).sort(), ["2026-09-14", "2026-10-09"], "09-12 以前的日子(早于 10-10 往回 28 天)只读缓存");
    assert.deepEqual(r.series.filter((s) => s.status === "missing").map((s) => [s.date, s.note]),
      [["2026-09-01", "超过东财保留期,当时也没缓存"], ["2026-09-02", "超过东财保留期,当时也没缓存"], ["2026-09-11", "超过东财保留期,当时也没缓存"]]);
    // 那几天当初取到过(快照还在)→ 照用,历史越积越长
    const early = fakeCtx();
    try {
      early.setCfg({ klines: K.slice(0, 2), daily: { "2026-09-01": day(30), "2026-09-02": day(31) } });
      await run(early, { date: "2026-09-02", days: "5" }, "2026-09-02T08:00:00Z");
      fs.cpSync(path.join(early.dataRoot, "snapshots"), path.join(ctx.dataRoot, "snapshots"), { recursive: true });
    } finally { cleanup(early); }
    const r2 = await run(ctx, { date: "2026-10-09", days: "5" }, "2026-10-10T08:00:00Z");
    assert.deepEqual(r2.series.filter((s) => s.status === "ok").map((s) => [s.date, s.cached, s.values.limit_up]),
      [["2026-09-01", true, 30], ["2026-09-02", true, 31], ["2026-09-14", true, 50], ["2026-10-09", true, 50]]);
  } finally { cleanup(ctx); }
});

test("日 K 取不到:只看那一天,并说明", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ daily: { "2026-10-09": day(69) } });
    const r = await run(ctx, { date: "2026-10-09" }, "2026-10-10T08:00:00Z");
    assert.deepEqual(r.series.map((s) => s.date), ["2026-10-09"]);
    assert.match(r.gaps[0]!, /日 K 没取到/);
    assert.ok(r.context.available && r.context.sample_days === 0);
    assert.deepEqual(r.diff, { available: false, reason: "历史不足两天,没法比较" });
  } finally { cleanup(ctx); }
});
