import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import "../src/finance/register_tasks.ts";
import { FINANCE_ENUM_LABELS, FINANCE_LEDGER_KINDS } from "../src/finance/ledger_kinds.ts";
import { MIN_BASELINE_SAMPLES, actualDirection, baselineNote, directionBaseline, isLate, itemsByDate, metricValues, shortlineVerify, shortlineVerifyAct, summarize, verifyItems, type Baseline, type Item, type MetricValues } from "../src/finance/shortline/verification.ts";
import { VERIFY_METRICS, VERIFY_METRIC_KEYS } from "../src/finance/shortline/verify_metrics.ts";
import { detectPython } from "../src/init.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { ServiceError, ledgerList, type ServiceContext } from "../src/service.ts";
import { listViews } from "../src/views.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";
const NO_BASELINE: Baseline = { available: false, samples: null, rates: null, reason: "x" };
const item = (metric: string, direction: Item["direction"], extra: Partial<Item> = {}): Item =>
  ({ id: `${metric}-${direction}`, date: "2026-10-08", metric, direction, reason: "r", created_at: "2026-10-08T20:00:00.000+08:00", updated_at: "2026-10-08T20:00:00.000+08:00", ...extra });
const mv = (v: Partial<MetricValues>): MetricValues => ({ ...Object.fromEntries(VERIFY_METRIC_KEYS.map((k) => [k, null])), ...v }) as MetricValues;

// ── 搬自 VA test_core_logic.py:TestDeltaDir / TestVerification / TestVerificationBaseline ──
test("方向:超过阈值才算升降,恰好等于阈值算持平,缺一边不判", () => {
  assert.equal(actualDirection(0.30, 0.10, 0.03), "up");
  assert.equal(actualDirection(0.10, 0.30, 0.03), "down");
  assert.equal(actualDirection(0.31, 0.30, 0.03), "flat");
  assert.equal(actualDirection(0.33, 0.30, 0.03), "flat", "0.33−0.30 在浮点里略大于 0.03,仍算持平");
  assert.equal(actualDirection(null, 0.30, 0.03), null);
  assert.equal(actualDirection(0.30, null, 0.03), null);
});

test("对账:判对 / 判错 / 噪声算持平 / 取不到不算判错 / 认不出的读数不进结果", () => {
  const up = [item("limit_up_count", "up")];
  const r1 = verifyItems(up, mv({ limit_up_count: 40 }), mv({ limit_up_count: 60 }), "2026-10-09", () => NO_BASELINE);
  assert.equal(r1[0]!.actual, "up"); assert.equal(r1[0]!.verified, true); assert.equal(r1[0]!.actual_label, "上升");
  const r2 = verifyItems(up, mv({ limit_up_count: 60 }), mv({ limit_up_count: 30 }), "2026-10-09", () => NO_BASELINE);
  assert.equal(r2[0]!.actual, "down"); assert.equal(r2[0]!.verified, false);
  const r3 = verifyItems(up, mv({ limit_up_count: 40 }), mv({ limit_up_count: 45 }), "2026-10-09", () => NO_BASELINE);
  assert.equal(r3[0]!.actual, "flat", "涨停 40→45 正好等于阈值 5,不算上升"); assert.equal(r3[0]!.verified, false);
  const r4 = verifyItems(up, mv({ limit_up_count: 40 }), mv({}), "2026-10-09", () => NO_BASELINE);
  assert.equal(r4[0]!.actual, null); assert.equal(r4[0]!.verified, null);
  assert.equal(summarize(r4).decided, 0, "判不了的不进分母");
  assert.deepEqual(verifyItems([item("凭感觉", "up")], mv({}), mv({}), "2026-10-09", () => NO_BASELINE), []);
});

test("基准发生率:没有历史序列的两项明确不给;样本不足不给;跨过取不到的日子不配对;只看给定的日子", () => {
  for (const k of ["theme_concentration", "market_limit_down"]) {
    const b = directionBaseline(k, [mv({ [k]: 1 }), mv({ [k]: 2 })]);
    assert.equal(b.available, false); assert.match(b.reason!, /没有历史序列/);
  }
  const r = verifyItems([item("theme_concentration", "up")], mv({ theme_concentration: 0.1 }), mv({ theme_concentration: 0.3 }), "2026-10-09",
    (m) => directionBaseline(m, []));
  assert.equal(r[0]!.verified, true); assert.equal(r[0]!.baseline, null); assert.equal(r[0]!.edge, null, "没有基准就不算超额");
  assert.match(r[0]!.baseline_reason!, /没有历史序列/);

  assert.equal(MIN_BASELINE_SAMPLES, 12);
  const seq = (xs: (number | null)[]) => xs.map((x) => mv({ limit_up_count: x }));
  const few = directionBaseline("limit_up_count", seq([40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150]));
  assert.equal(few.available, false); assert.equal(few.samples, 11);
  // 13 天 12 对:8 次上升(+10)、2 次下降(−10)、2 次持平(+3);中间一天取不到 → 那两对不算
  const xs = [40, 50, 60, 70, 80, 90, 100, 110, 120, 110, 100, 103, 106];
  const b = directionBaseline("limit_up_count", seq(xs));
  assert.deepEqual([b.available, b.samples, b.rates], [true, 12, { up: 0.667, down: 0.167, flat: 0.167 }]);
  const holed = directionBaseline("limit_up_count", seq([...xs.slice(0, 5), null, ...xs.slice(5)]));
  assert.equal(holed.available, false, "缺一天少两对,只剩 11 对"); assert.equal(holed.samples, 11);
});

test("基准说明:0 不叫「含量高」;少见与常见各有说法;中间不说", () => {
  const lu = VERIFY_METRICS[0]!;
  const zero = baselineNote(0, lu);
  assert.match(zero, /一次都没出现过/); assert.doesNotMatch(zero, /含量高/); assert.match(zero, /不超过 5/);
  assert.match(baselineNote(0.2), /含量高/);
  assert.match(baselineNote(0.85), /信息量低/);
  assert.equal(baselineNote(0.5), "");
  assert.equal(baselineNote(null), "");
});

test("汇总:超额只在有基准的条目上算,判不了的两边都不进", () => {
  const s = summarize([
    { verified: true, baseline: 0.6 }, { verified: false, baseline: 0.2 },
    { verified: true, baseline: null }, { verified: null, baseline: 0.5 },
  ]);
  assert.deepEqual([s.total, s.decided, s.hit, s.undecidable, s.baseline_covered], [4, 3, 2, 1, 2]);
  assert.equal(s.rate, 0.667); assert.equal(s.expected_rate, 0.4); assert.equal(s.edge, 0.1);
  assert.deepEqual(summarize([]), { total: 0, decided: 0, hit: 0, rate: null, undecidable: 0, baseline_covered: 0, expected_rate: null, edge: null });
});

// ── 本仓库的改动 ──
test("事后:被检验那一场 09:15 竞价开始以后写或改的算事后;时间认不出也算", () => {
  assert.equal(isLate({ updated_at: "2026-10-09T09:14:59.999+08:00" }, "2026-10-09"), false);
  assert.equal(isLate({ updated_at: "2026-10-09T09:15:00.000+08:00" }, "2026-10-09"), true);
  assert.equal(isLate({ updated_at: "2026-10-09T01:20:00.000Z" }, "2026-10-09"), true, "UTC 01:20 = 北京 09:20");
  assert.equal(isLate({ updated_at: "昨晚" }, "2026-10-09"), true);
});

test("台账记录:不合规的跳过并计数;同一晚同一读数留最后改的;按清单顺序排", () => {
  const rec = (o: Record<string, unknown>): LedgerRecord => ({ id: String(o.id), kind: "verification", created_at: "t", updated_at: String(o.updated_at ?? "2026-10-08T20:00:00.000+08:00"), ...o });
  const { byDate, skipped } = itemsByDate([
    rec({ id: "a", date: "2026-10-08", metric: "broken_rate", direction: "down" }),
    rec({ id: "b", date: "2026-10-08", metric: "limit_up_count", direction: "up", reason: "旧" }),
    rec({ id: "c", date: "2026-10-08", metric: "limit_up_count", direction: "down", reason: "新", updated_at: "2026-10-08T21:00:00.000+08:00" }),
    rec({ id: "d", date: "2026-10-08", metric: "凭感觉", direction: "up" }),
    rec({ id: "e", date: "2026-10-08", metric: "highest_board", direction: "上升" }),
    rec({ id: "f", date: "2026-02-31", metric: "highest_board", direction: "up" }),
    rec({ id: "g", date: "2026-10-09", metric: "highest_board", direction: "flat" }),
  ]);
  assert.equal(skipped, 4, "三条不合规 + 一条被覆盖的重复");
  assert.deepEqual(byDate.get("2026-10-08")!.map((x) => [x.id, x.metric, x.direction, x.reason]), [["c", "limit_up_count", "down", "新"], ["a", "broken_rate", "down", ""]]);
  assert.deepEqual(byDate.get("2026-10-09")!.map((x) => x.id), ["g"]);
});

test("台账种类:读数枚举就是清单,方向三选一,显示名都有", () => {
  const k = FINANCE_LEDGER_KINDS.verification!;
  assert.equal(k.label, "验证条件");
  assert.deepEqual((k.properties.metric as { enum: string[] }).enum, VERIFY_METRIC_KEYS);
  assert.deepEqual((k.properties.direction as { enum: string[] }).enum, ["up", "down", "flat"]);
  assert.deepEqual(k.required, ["date", "metric", "direction"]);
  for (const key of [...VERIFY_METRIC_KEYS, "up", "down", "flat"]) assert.ok(FINANCE_ENUM_LABELS[key], key);
  assert.equal(FINANCE_ENUM_LABELS.flat, "持平");
});

test("一天的八项:六项取每日读数,两项取事实表;那天没取到就全是 null", () => {
  const row = { values: { limit_up: 50, highest_board: 5, broken_rate: 0.2, money_effect: 1.5, deep_loss: 4, promotion_1to2: 0.3 }, status: "ok" as const };
  const v = metricValues(row, { theme_concentration: 0.25, market_limit_down: 3 });
  assert.deepEqual(v, { limit_up_count: 50, highest_board: 5, promotion_1to2: 0.3, money_effect_median: 1.5, broken_rate: 0.2, deep_loss_count: 4, theme_concentration: 0.25, market_limit_down: 3 });
  assert.deepEqual(metricValues({ ...row, status: "missing" }, undefined), mv({}));
});

// ── 整条链路:假取数器(cfg.json 给数,calls.log 记每次调用) ──
const FAKE = String.raw`import json,sys,os
a=sys.argv; ep=a[a.index('--endpoint')+1] if '--endpoint' in a else 'fetch_trade_calendar'; out=a[a.index('--out-dir')+1]
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
if ep in ('cn_shortline_daily','cn_shortline_facts'):
  d=args.get('date','')
  v=cfg.get('daily' if ep=='cn_shortline_daily' else 'facts',{}).get(d)
  if v is None: done({'status':'failed','reason':'东财池为空','evidence':[]},3)
  evs=[{'field':k,'value':x,'raw_ref':'raw/x.json',**({'record_key':'1进2'} if k=='promotion_rate' else {})} for k,x in v.items()]
  if d in cfg.get('unsettled',[]): done({'status':'partial','extra':{'degraded':'这一天还没收盘：本次结果不缓存','settled':False},'evidence':evs},2)
  done({'status':'ok','extra':{'settled':True},'evidence':evs})
if ep=='fetch_trade_calendar':
  c=cfg.get('calendar')
  if not c: done({'status':'failed','reason':'日历没取到','evidence':[]},3)
  ev=lambda f,v,**k: {'field':f,'value':v,'raw_ref':'raw/x.json','symbol':'MARKET','market':'CN',**k}
  done({'status':'ok','evidence':[ev('is_today_trading_day',c['trading'],period=c['day']),ev('last_trading_day',c.get('last','2026-10-09')),ev('previous_trading_day',c.get('prev','2026-10-08')),ev('session_phase','pre_open')]})
done({'status':'failed','reason':'unknown','evidence':[]},3)
`;

interface Cfg { klines?: string[]; daily?: Record<string, Record<string, number>>; facts?: Record<string, Record<string, number>>; unsettled?: string[]; calendar?: { day: string; trading: boolean } }
type Call = { ep: string; sym: string; args: { date?: string } };

function fakeCtx(): ServiceContext & { setCfg(c: Cfg): void; calls(): Call[]; writeItems(rs: Record<string, unknown>[]): void } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "va-verify-"));
  fs.mkdirSync(path.join(repo, "datasources"));
  fs.copyFileSync(path.join(REPO, "datasources", "registry.json"), path.join(repo, "datasources", "registry.json"));
  const scripts = path.join(repo, ".agents", "skills", "data-access", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "fetch_endpoint.py"), FAKE);
  fs.writeFileSync(path.join(scripts, "fetch_trade_calendar.py"), FAKE);   // 交易日历是 legacy 脚本,单独一个文件
  const dataRoot = path.join(repo, ".local");
  fs.mkdirSync(path.join(dataRoot, "ledger"), { recursive: true });
  return {
    repoRoot: repo, dataRoot, python: PY, node: process.execPath,
    setCfg: (c) => fs.writeFileSync(path.join(repo, "cfg.json"), JSON.stringify(c)),
    calls: () => { try { return fs.readFileSync(path.join(repo, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call); } catch { return []; } },
    // 直接写台账文件:要控制 updated_at(事后与否)
    writeItems: (rs) => fs.writeFileSync(path.join(dataRoot, "ledger", "verification.json"), JSON.stringify({ schema_version: 1, kind: "verification",
      records: rs.map((r, i) => ({ id: `v${i}`, kind: "verification", created_at: r.updated_at ?? "2026-09-01T20:00:00.000+08:00", updated_at: "2026-09-01T20:00:00.000+08:00", ...r })) })),
  };
}
const cleanup = (ctx: ServiceContext) => fs.rmSync(ctx.repoRoot, { recursive: true, force: true });
const run = (ctx: ServiceContext, q: Record<string, string>, now: string) => shortlineVerify(ctx, q, new AbortController().signal, new Date(now));
const act = (ctx: ServiceContext, body: Record<string, unknown>, now: string) => shortlineVerifyAct(ctx, body, new AbortController().signal, new Date(now));
const day = (lu: number, br = 0.2) => ({ limit_up_count: lu, ladder_highest: 5, broken_rate: br, money_effect_median_ret: 1.0, loss_deep5_count: 5, promotion_rate: 0.25 });
// 9 月 14 日起 20 个交易日(跳过周末与国庆)
const K = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25",
  "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-08", "2026-10-09"];
const at = (d: string, hm: string) => `${d}T${hm}:00.000+08:00`;

test("视图已登记,带写动作;参数不对什么都不取", async () => {
  assert.ok(listViews().some((v) => v.id === "shortline_verify" && v.label === "明日验证"));
  const ctx = fakeCtx();
  try {
    ctx.setCfg({});
    for (const q of [{}, { date: "2026-02-31" }, { date: "2026-10-09", refresh: "yes" }, { date: "2026-10-12" }] as Record<string, string>[]) {
      await assert.rejects(run(ctx, q, "2026-10-10T08:00:00Z"), (e: unknown) => e instanceof ServiceError && e.code === "bad_query", JSON.stringify(q));
    }
    assert.deepEqual(ctx.calls(), []);
  } finally { cleanup(ctx); }
});

test("链路:前一晚的条件用这一天对账;基准只用写条件那晚及以前;事后写的标出来、不进战绩;事实表只取用得到的日子", async () => {
  const ctx = fakeCtx();
  try {
    // 涨停家数逐日 +10(每对都是上升),10-09 回落到 60;炸板率一路 0.2,10-09 升到 0.4
    const daily: Record<string, Record<string, number>> = {};
    K.forEach((d, i) => { daily[d] = day(40 + i * 10); });
    daily["2026-10-09"] = day(60, 0.4);
    ctx.setCfg({ klines: K, daily, facts: { "2026-10-08": { theme_concentration: 0.2, limit_down_count: 3 }, "2026-10-09": { theme_concentration: 0.35, limit_down_count: 12 } } });
    ctx.writeItems([
      { date: "2026-10-08", metric: "limit_up_count", direction: "up", reason: "延续", updated_at: at("2026-10-08", "21:00") },
      { date: "2026-10-08", metric: "broken_rate", direction: "up", reason: "分歧加大", updated_at: at("2026-10-08", "21:00") },
      { date: "2026-10-08", metric: "theme_concentration", direction: "up", updated_at: at("2026-10-09", "08:59") },
      { date: "2026-10-08", metric: "highest_board", direction: "flat", updated_at: at("2026-10-09", "14:00") },
      { date: "2026-09-29", metric: "limit_up_count", direction: "down", updated_at: at("2026-09-29", "20:00") },
      { date: "2026-10-09", metric: "deep_loss_count", direction: "down", reason: "修复", updated_at: at("2026-10-09", "20:00") },
      { date: "2026-10-09", metric: "market_limit_down", direction: "down", updated_at: at("2026-10-09", "20:00") },
    ]);
    const r = await run(ctx, { date: "2026-10-09" }, "2026-10-10T08:00:00Z");
    assert.ok(r.check.available);
    assert.deepEqual([r.check.set_date, r.check.date, r.check.provisional], ["2026-10-08", "2026-10-09", false]);
    const c = Object.fromEntries(r.check.results.map((x) => [x.metric, x]));
    assert.deepEqual([c.limit_up_count!.prev_value, c.limit_up_count!.cur_value, c.limit_up_count!.actual, c.limit_up_count!.verified], [170, 60, "down", false]);
    assert.equal(c.limit_up_count!.baseline, 1, "09-14 到 10-08 每对都是上升:基准不含 10-08→10-09 这一对");
    assert.equal(c.limit_up_count!.baseline_samples, 13);
    assert.match(c.limit_up_count!.baseline_note, /信息量低/);
    assert.equal(c.limit_up_count!.edge, -1);
    assert.deepEqual([c.broken_rate!.actual, c.broken_rate!.verified, c.broken_rate!.baseline], ["up", true, 0], "炸板率一直不变:历史上从没上升过");
    assert.match(c.broken_rate!.baseline_note, /一次都没出现过/);
    assert.deepEqual([c.theme_concentration!.prev_value, c.theme_concentration!.cur_value, c.theme_concentration!.verified, c.theme_concentration!.late, c.theme_concentration!.baseline],
      [0.2, 0.35, true, false, null], "08:59 写的不算事后;这项没有基准");
    assert.deepEqual([c.highest_board!.verified, c.highest_board!.late], [true, true], "14:00 才写:照样对账,标事后");
    assert.equal(r.check.summary.decided, 4);

    // 计划:这晚写给下一场的,带今天的读数作对照
    assert.deepEqual(r.plan.items.map((x) => [x.metric, x.direction_label, x.base_value]), [["deep_loss_count", "下降", 5], ["market_limit_down", "下降", 12]]);
    assert.equal(r.plan.items[0]!.baseline_reason, null);
    assert.deepEqual(r.plan.items[0]!.baseline_samples, 14, "计划的基准包含今天");

    // 战绩:09-29 那晚(判下降,实际 +10 上升,判错)+ 10-08 三条(事后那条不计)
    assert.deepEqual(r.track.days.map((d) => [d.set_date, d.date, d.total, d.decided, d.hit, d.excluded]),
      [["2026-09-29", "2026-09-30", 1, 1, 0, 0], ["2026-10-08", "2026-10-09", 4, 3, 2, 1]]);
    assert.deepEqual([r.track.summary.decided, r.track.summary.hit, r.track.excluded_late, r.track.excluded_provisional], [4, 2, 1, 0]);
    assert.equal(r.track.from, "2026-09-14");

    // 事实表只取写了那两项的晚上和下一场:10-08、10-09(10-09 自己写了跌停那项,没有下一场)
    assert.deepEqual(ctx.calls().filter((x) => x.ep === "cn_shortline_facts").map((x) => x.args.date).sort(), ["2026-10-08", "2026-10-09"]);
    assert.deepEqual(r.gaps, []);
    assert.deepEqual(r.directions.map((d) => d.label), ["上升", "下降", "持平"]);
    assert.ok(r.metrics.every((m) => !("reading" in m) && !("facts_field" in m)));
  } finally { cleanup(ctx); }
});

test("被检验那一场没收盘:对账标暂定,不进战绩;前一晚没写条件就是空的", async () => {
  const ctx = fakeCtx();
  try {
    const daily = Object.fromEntries(K.map((d, i) => [d, day(40 + i)]));
    ctx.setCfg({ klines: K, daily, unsettled: ["2026-10-09"] });
    ctx.writeItems([{ date: "2026-10-08", metric: "limit_up_count", direction: "flat", updated_at: at("2026-10-08", "21:00") }]);
    const r = await run(ctx, { date: "2026-10-09" }, "2026-10-09T03:00:00Z");
    assert.ok(r.check.available && r.check.provisional);
    assert.equal(r.check.results[0]!.verified, true);
    assert.deepEqual([r.track.summary.total, r.track.excluded_provisional, r.track.days[0]!.excluded], [0, 1, 1]);
    const r2 = await run(ctx, { date: "2026-10-08" }, "2026-10-09T03:00:00Z");
    assert.ok(r2.check.available);
    assert.deepEqual(r2.check.results, []);
    assert.equal(r2.plan.items.length, 1);
  } finally { cleanup(ctx); }
});

test("取不到的说清楚:日 K 没取到就没有前一晚;事实表没取到相关条件判不了;台账里坏的条目计数", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ daily: { "2026-10-09": day(60) } });
    const r = await run(ctx, { date: "2026-10-09" }, "2026-10-10T08:00:00Z");
    assert.deepEqual(r.check, { available: false, reason: "列不出前一个交易日(上证A股指数日 K 没取到)" });
    assert.match(r.gaps.join(""), /日 K 没取到/);

    ctx.setCfg({ klines: K, daily: Object.fromEntries(K.map((d) => [d, day(50)])) });
    ctx.writeItems([
      { date: "2026-10-08", metric: "market_limit_down", direction: "up", updated_at: at("2026-10-08", "21:00") },
      { date: "2026-10-08", metric: "凭感觉", direction: "up" },
    ]);
    const r2 = await run(ctx, { date: "2026-10-09" }, "2026-10-10T08:00:00Z");
    assert.ok(r2.check.available);
    assert.equal(r2.check.results[0]!.verified, null, "跌停家数没取到:判不了,不算判错");
    assert.match(r2.gaps.join("|"), /全市场跌停没取到\(2026-10-08:东财池为空;2026-10-09:东财池为空\)/);
    assert.match(r2.gaps.join("|"), /1 条验证条件不合规或重复/);
  } finally { cleanup(ctx); }
});

test("写条件:整晚替换;没变的不重写;下一场开盘后不收;不是交易日、重复、超量、乱填都拒", async () => {
  const ctx = fakeCtx();
  const list = () => ledgerList(ctx, "verification").verification!;
  try {
    ctx.setCfg({ klines: K });
    const r = await act(ctx, { action: "save", date: "2026-10-09", items: [
      { metric: "limit_up_count", direction: "up", reason: " 延续 " }, { metric: "broken_rate", direction: "down" }] }, "2026-10-09T12:00:00Z");
    assert.deepEqual(r.items.map((x) => [x.metric, x.direction, x.reason]), [["limit_up_count", "up", "延续"], ["broken_rate", "down", ""]]);
    const before = Object.fromEntries(list().map((x) => [x.metric, x.updated_at]));

    // 第二次:涨停那条没变、炸板率改方向、新增最高板 → 涨停那条 updated_at 不动
    await new Promise((res) => setTimeout(res, 5));
    await act(ctx, { action: "save", date: "2026-10-09", items: [
      { metric: "limit_up_count", direction: "up", reason: "延续" }, { metric: "broken_rate", direction: "up" }, { metric: "highest_board", direction: "flat" }] }, "2026-10-09T13:00:00Z");
    const after = Object.fromEntries(list().map((x) => [x.metric, x]));
    assert.equal(after.limit_up_count!.updated_at, before.limit_up_count, "没变就不重写,免得被当成事后改");
    assert.notEqual(after.broken_rate!.updated_at, before.broken_rate);
    assert.equal(after.broken_rate!.direction, "up");
    assert.equal(list().length, 3);
    // 清空
    await act(ctx, { action: "save", date: "2026-10-09", items: [] }, "2026-10-09T13:00:00Z");
    assert.equal(list().length, 0);

    // 下一场(10-09)09:15 以后不能再写 10-08 那晚;09:14 还行
    await act(ctx, { action: "save", date: "2026-10-08", items: [{ metric: "limit_up_count", direction: "up" }] }, "2026-10-09T01:14:00Z");
    await assert.rejects(act(ctx, { action: "save", date: "2026-10-08", items: [{ metric: "limit_up_count", direction: "down" }] }, "2026-10-09T01:15:00Z"),
      (e: unknown) => e instanceof ServiceError && /已经开盘/.test(e.message));
    assert.equal(list()[0]!.direction, "up");

    const bad: [Record<string, unknown>, RegExp][] = [
      [{ action: "delete", date: "2026-10-09", items: [] }, /action=save/],
      [{ action: "save", date: "2026-10-10", items: [] }, /不是交易日/],
      [{ action: "save", date: "2026-10-12", items: [] }, /还没到/],
      [{ action: "save", date: "2026-10-09", items: {} }, /数组/],
      [{ action: "save", date: "2026-10-09", items: [{ metric: "凭感觉", direction: "up" }] }, /清单/],
      [{ action: "save", date: "2026-10-09", items: [{ metric: "limit_up_count", direction: "上升" }] }, /方向/],
      [{ action: "save", date: "2026-10-09", items: [{ metric: "limit_up_count", direction: "up" }, { metric: "limit_up_count", direction: "down" }] }, /写了两条/],
      [{ action: "save", date: "2026-10-09", items: [{ metric: "limit_up_count", direction: "up", reason: "字".repeat(201) }] }, /200 字/],
      [{ action: "save", date: "2026-10-09", items: [{ metric: "limit_up_count", direction: "up", reason: 3 }] }, /文字/],
      [{ action: "save", date: "2026-10-09", items: Array.from({ length: 9 }, () => ({ metric: "limit_up_count", direction: "up" })) }, /最多 8 条/],
    ];
    for (const [b, re] of bad) {
      await assert.rejects(act(ctx, b, "2026-10-10T08:00:00Z"), (e: unknown) => e instanceof ServiceError && re.test(e.message), JSON.stringify(b).slice(0, 80));
    }
    assert.equal(list().length, 1, "拒掉的一条都没写");
  } finally { cleanup(ctx); }
});

test("🔴 写条件整晚只落一次盘:写盘失败时原来那晚一条不少(审计 2026-10-11 Codex 范围 2 第 4 条)", async () => {
  const ctx = fakeCtx();
  const list = () => ledgerList(ctx, "verification").verification!;
  const ledgerDir = path.resolve(ctx.dataRoot, "ledger");
  const realRename = fs.renameSync;
  let writes = 0;
  let failFirst = false;
  try {
    ctx.setCfg({ klines: K });
    await act(ctx, { action: "save", date: "2026-10-09", items: [{ metric: "limit_up_count", direction: "up", reason: "A" }, { metric: "broken_rate", direction: "down" }] }, "2026-10-09T12:00:00Z");
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).startsWith(ledgerDir + path.sep)) {
        writes++;
        if (failFirst) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return realRename(from, to);
    }) as typeof fs.renameSync;
    // 换成完全不同的两条(要删两条、加两条):只许写一次
    await act(ctx, { action: "save", date: "2026-10-09", items: [{ metric: "highest_board", direction: "flat" }, { metric: "market_limit_down", direction: "up" }] }, "2026-10-09T12:10:00Z");
    assert.equal(writes, 1, "删和加在同一次写盘里");
    assert.deepEqual(list().map((x) => x.metric).sort(), ["highest_board", "market_limit_down"]);
    // 磁盘写失败:这晚原样不动,不会只剩一半
    failFirst = true;
    await assert.rejects(act(ctx, { action: "save", date: "2026-10-09", items: [{ metric: "limit_up_count", direction: "down" }] }, "2026-10-09T12:20:00Z"));
    assert.deepEqual(list().map((x) => x.metric).sort(), ["highest_board", "market_limit_down"]);
  } finally { fs.renameSync = realRename; cleanup(ctx); }
});

test("写条件:今天是工作日、日 K 还没有今天也放行;日 K 取不到放行(对账时照样查事后)", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ klines: K });
    const r = await act(ctx, { action: "save", date: "2026-10-12", items: [{ metric: "limit_up_count", direction: "up" }] }, "2026-10-12T00:30:00Z");
    assert.equal(r.items.length, 1);
    await assert.rejects(act(ctx, { action: "save", date: "2026-10-10", items: [] }, "2026-10-10T08:00:00Z"), /不是交易日/, "今天是周六:不放行");
  } finally { cleanup(ctx); }
  const blind = fakeCtx();   // 新的数据根:没有日 K 快照
  try {
    blind.setCfg({});
    const r2 = await act(blind, { action: "save", date: "2026-10-10", items: [{ metric: "broken_rate", direction: "up" }] }, "2026-10-10T08:00:00Z");
    assert.equal(r2.items.length, 1);
  } finally { cleanup(blind); }
});

test("写条件:日 K 里还没有下一场、日历说今天开市 → 今天 09:15 起锁;工作日休市的今天不收(审计 2026-10-11 Opus 范围 2 第 2、4 条)", async () => {
  const ctx = fakeCtx();
  try {
    // 10-12(周一)09:20:日 K 只到 10-09,今天这根还没出来;日历说今天开市 → 10-09 那晚的条件锁了
    ctx.setCfg({ klines: K, calendar: { day: "2026-10-12", trading: true } });
    await act(ctx, { action: "save", date: "2026-10-09", items: [{ metric: "limit_up_count", direction: "up" }] }, "2026-10-12T01:10:00Z");
    await assert.rejects(act(ctx, { action: "save", date: "2026-10-09", items: [] }, "2026-10-12T01:20:00Z"),
      (e: unknown) => e instanceof ServiceError && /2026-10-12 已经开盘/.test(e.message), "开盘后删条件也不行");
    assert.equal(ledgerList(ctx, "verification").verification!.length, 1);
    // 日历说今天休市(工作日):下一场还没到,照常能改
    ctx.setCfg({ klines: K, calendar: { day: "2026-10-12", trading: false } });
    await act(ctx, { action: "save", date: "2026-10-09", items: [] }, "2026-10-12T02:00:00Z");
    assert.equal(ledgerList(ctx, "verification").verification!.length, 0);
    // 国庆:今天(10-01,周四)是工作日但休市 → 不收今天的条件
    ctx.setCfg({ klines: K.filter((d) => d <= "2026-09-30"), calendar: { day: "2026-10-01", trading: false } });
    await assert.rejects(act(ctx, { action: "save", date: "2026-10-01", items: [{ metric: "limit_up_count", direction: "up" }] }, "2026-10-01T12:00:00Z"),
      (e: unknown) => e instanceof ServiceError && /休市/.test(e.message));
  } finally { cleanup(ctx); }
});

test("写条件:日 K 和日历都取不到时,下一个工作日 09:15 起不许删(删掉的不留记录);改写照常放行、对账时标事后", async () => {
  const ctx = fakeCtx();
  const list = () => ledgerList(ctx, "verification").verification!;
  try {
    ctx.setCfg({});
    await act(ctx, { action: "save", date: "2026-10-08", items: [{ metric: "limit_up_count", direction: "up" }, { metric: "broken_rate", direction: "down" }] }, "2026-10-08T12:00:00Z");
    await assert.rejects(act(ctx, { action: "save", date: "2026-10-08", items: [{ metric: "limit_up_count", direction: "up" }] }, "2026-10-09T02:00:00Z"),
      (e: unknown) => e instanceof ServiceError && /不能删/.test(e.message));
    assert.equal(list().length, 2);
    await act(ctx, { action: "save", date: "2026-10-08", items: [{ metric: "limit_up_count", direction: "down" }, { metric: "broken_rate", direction: "down" }] }, "2026-10-09T02:00:00Z");
    assert.equal(list().find((x) => x.metric === "limit_up_count")!.direction, "down", "改写放行(写下时间在 09:15 之后,对账时是事后)");
    // 09:15 以前删,放行
    await act(ctx, { action: "save", date: "2026-10-08", items: [{ metric: "limit_up_count", direction: "down" }] }, "2026-10-09T01:00:00Z");
    assert.equal(list().length, 1);
  } finally { cleanup(ctx); }
  const wk = fakeCtx();
  try {
    // 周六:日 K 取到了、下一场还没到 → 删除照常
    wk.setCfg({ klines: K });
    await act(wk, { action: "save", date: "2026-10-09", items: [{ metric: "limit_up_count", direction: "up" }] }, "2026-10-09T12:00:00Z");
    await act(wk, { action: "save", date: "2026-10-09", items: [] }, "2026-10-10T08:00:00Z");
    assert.equal(ledgerList(wk, "verification").verification!.length, 0);
  } finally { cleanup(wk); }
});
