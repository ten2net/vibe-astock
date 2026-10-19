/**
 * 交易日志:按入场日环境分组(environment.ts)。期望值全部手算。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import "../src/finance/register_tasks.ts";
import { detectPython } from "../src/init.ts";
import { ledgerInsertMany, ledgerUpsert, type ServiceContext } from "../src/service.ts";
import { listViews } from "../src/views.ts";
import { boardOf, journalEnvironment } from "../src/finance/journal/environment.ts";
import type { ZtStock } from "../src/finance/review_tiers.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";
const sig = new AbortController().signal;

const zt = (symbol: string, boards: number | null, first_seal: string | null = null, extra: Partial<ZtStock> = {}): ZtStock => ({ symbol, name: "", industry: "", boards, first_seal, ...extra });
const NONE = { boards: null, first_seal: null, broken_times: null, industry: null };

test("当时板位:涨停池里按连板数分;不在涨停池看炸板池;池没取到分别说清,不当「非涨停」;带炸板次数和行业(VA 同)", () => {
  const pool = [zt("600519", 2, "09:30:00", { broken_times: 1, industry: "白酒" }), zt("600000", null, null, { industry: "未分类" }), zt("002594", 5)];
  assert.deepEqual(boardOf("600519", pool, []), { board: "2板", boards: 2, first_seal: "09:30:00", broken_times: 1, industry: "白酒" });
  // 没给连板数的按首板(VA 同);「未分类」和空行业都不写
  assert.deepEqual(boardOf("600000", pool, null), { board: "首板", boards: 1, first_seal: null, broken_times: null, industry: null });
  assert.equal(boardOf("002594", pool, null).board, "3板及以上");
  assert.equal(boardOf("002594", pool, null).industry, null);
  // 炸板池里的也带当天炸了几次、行业;连板数和首封不写
  assert.deepEqual(boardOf("000001", pool, [zt("000001", 2, "10:00:00", { broken_times: 3, industry: "银行" })]), { board: "炸板", ...NONE, broken_times: 3, industry: "银行" });
  assert.deepEqual(boardOf("000001", pool, [zt("300750", null, null, { broken_times: 2, industry: "电池" })]), { board: "没碰涨停", ...NONE });
  assert.deepEqual(boardOf("000001", pool, null), { board: "非涨停(没分出炸板)", ...NONE });
  assert.deepEqual(boardOf("600519", null, [zt("600519", null)]), { board: "没取到", ...NONE });
});

const FAKE = String.raw`import json,sys,os
a=sys.argv; ep=a[a.index('--endpoint')+1]; out=a[a.index('--out-dir')+1]
args=json.loads(a[a.index('--args')+1]) if '--args' in a else {}
cfg=json.load(open('cfg.json'))
open('calls.log','a').write(json.dumps({'ep':ep,'args':args})+'\n')
os.makedirs(os.path.join(out,'raw'),exist_ok=True)
def done(env,code=0): print(json.dumps(env)); sys.exit(code)
d=args.get('date','')
if ep=='cn_shortline_daily':
  v=cfg.get('daily',{}).get(d)
  if v is None: done({'status':'failed','reason':'东财池为空','evidence':[]},3)
  done({'status':'ok','extra':{'settled':True},'evidence':[{'field':k,'value':x,'raw_ref':'raw/x.json'} for k,x in v.items()]})
if ep in ('em_zt_pool','em_zb_pool'):
  p=cfg.get('zt' if ep=='em_zt_pool' else 'zb',{}).get(d)
  if p is None: done({'status':'failed','reason':'池子取不到','evidence':[]},3)
  ref='raw/%s_%s_%d.json'%(ep,d,os.getpid())
  json.dump({'data':{'pool':[dict({'c':e[0],'n':'x','lbc':e[1],'fbt':e[2],'hybk':'行业'},**({'zbc':e[3]} if len(e)>3 else {})) for e in p]}},open(os.path.join(out,ref),'w'))
  done({'status':'ok','evidence':[{'field':'pool_size','value':len(p),'raw_ref':ref}]})
done({'status':'failed','reason':'unknown','evidence':[]},3)
`;

type Call = { ep: string; args: Record<string, unknown> };
function fakeCtx(): ServiceContext & { setCfg(c: unknown): void; calls(): Call[] } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "va-journal-env-"));
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
    calls: () => { try { return fs.readFileSync(path.join(repo, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call); } catch { return []; } },
  };
}
const cleanup = (ctx: ServiceContext) => fs.rmSync(ctx.repoRoot, { recursive: true, force: true });
const round = (symbol: string, buy: string, sell: string | null, bp: number, sp: number) => [
  { symbol, type: "buy", date: buy, shares: 100, price: bp, fee: 0 },
  ...(sell ? [{ symbol, type: "sell", date: sell, shares: 100, price: sp, fee: 0 }] : []),
];
const day = (lu: number, hb: number, br: number | null) => ({ limit_up_count: lu, ladder_highest: hb, ...(br === null ? {} : { broken_rate: br }), money_effect_median_ret: 1.5 });

/**
 * 情绪分 = 涨停 × (1 + 最高板) × (1 − 炸板率):
 *   09-14 160 · 09-15 90 · 09-16 432 · 09-17 45 · 09-18 240 · 09-21 24;09-22 缺炸板率、09-23 没取到、09-01 超过保留期
 *   排好 [24, 45, 90, 160, 240, 432] ⇒ 弱 ≤ 90 < 中 < 240 ≤ 强
 * 每笔 100 股、费用 0:A 600519 +10% / +100 · B 000001 −5% / −50 · C 600000 +8% / +80 · D 300750 −5% / −100
 *   E 002594 +4% / +40 · F 600036 0 · G 601318 +3% / +30 · H 补记 000002 −2% · I 600900 +5% / +50 · J 601012 今天买、没收盘
 */
test("按入场日环境分组:情绪三等分、当时板位;没取到 / 超过保留期 / 没收盘各自说清;已收盘的池子缓存后不重取", async () => {
  assert.ok(listViews().some((v) => v.id === "journal_env"));
  const ctx = fakeCtx();
  try {
    ctx.setCfg({
      daily: {
        "2026-09-14": day(50, 3, 0.2), "2026-09-15": day(40, 2, 0.25), "2026-09-16": day(80, 5, 0.1),
        "2026-09-17": day(30, 2, 0.5), "2026-09-18": day(60, 4, 0.2), "2026-09-21": day(20, 1, 0.4), "2026-09-22": day(10, 1, null),
      },
      zt: {
        "20260914": [["600519", 2, 93000, 1], ["300750", 1, 100000]], "20260915": [["600519", 3, 93000]], "20260916": [["600000", 1, 141000]],
        "20260917": [["600519", 1, 93000]], "20260918": [["002594", 4, 92500]], "20260921": [["000001", 1, 93000]], "20260923": [["000002", 1, 100000]],
      },
      zb: {
        "20260914": [], "20260915": [["000001", 1, 93000, 2]], "20260916": [["300750", 1, 93000]], "20260917": [["000001", 1, 93000]],
        "20260918": [["600000", 1, 93000]], "20260921": [], "20260923": [["000001", 1, 93000]],
      },
    });
    ledgerInsertMany(ctx, { kind: "trade", records: [
      ...round("600519", "2026-09-14", "2026-09-15", 10, 11), ...round("000001", "2026-09-15", "2026-09-16", 10, 9.5),
      ...round("600000", "2026-09-16", "2026-09-17", 10, 10.8), ...round("300750", "2026-09-17", "2026-09-18", 20, 19),
      ...round("002594", "2026-09-18", "2026-09-21", 10, 10.4), ...round("600036", "2026-09-21", "2026-09-22", 10, 10),
      ...round("601318", "2026-09-22", "2026-09-23", 10, 10.3), ...round("600900", "2026-09-01", "2026-09-02", 10, 10.5),
      ...round("601012", "2026-10-12", null, 10, 0),
    ] });
    ledgerUpsert(ctx, { kind: "journal_tag", record: { symbol: "000002", date: "2026-09-23", pnl_pct: -2 } });
    // 10-12 13:00(北京):保留期从 09-14 起,09-01 只读缓存;10-12 还没收盘
    const NOW = new Date("2026-10-12T05:00:00Z");
    const r = await journalEnvironment(ctx, {}, sig, NOW);
    assert.ok(r.available, JSON.stringify(r));
    if (!r.available) return;
    assert.deepEqual(r.regime_cuts, { low: 90, high: 240 });
    assert.deepEqual([r.scored_days, r.days, r.unsettled_trades, r.scanned], [6, 9, 1, 10]);
    const pick = (g: { key: string; count: number; scored: number; money_scored: number; net_pnl: number | null; win_rate: number | null; avg: number | null; best: number | null; worst: number | null }) =>
      [g.key, g.count, g.scored, g.money_scored, g.net_pnl, g.win_rate, g.avg, g.best, g.worst];
    assert.deepEqual(r.by_regime.map(pick), [
      ["情绪强", 2, 2, 2, 120, 1, 6, 8, 4],
      ["情绪中", 1, 1, 1, 100, 1, 10, 10, 10],
      ["情绪弱", 3, 3, 3, -150, 0, -3.33, 0, -5],
      ["环境未覆盖", 3, 3, 2, 80, 0.667, 2, 5, -2],
    ]);
    assert.deepEqual(r.by_board.map(pick), [
      ["首板", 2, 2, 1, 80, 0.5, 3, 8, -2],
      ["2板", 1, 1, 1, 100, 1, 10, 10, 10],
      ["3板及以上", 1, 1, 1, 40, 1, 4, 4, 4],
      ["炸板", 1, 1, 1, -50, 0, -5, -5, -5],
      ["没碰涨停", 1, 1, 1, -100, 0, -5, -5, -5],
      ["非涨停(没分出炸板)", 1, 1, 1, 0, null, 0, 0, 0],
      ["没取到", 2, 2, 2, 80, 1, 4, 5, 3],
    ]);
    assert.equal(new Set(r.rows.map((x) => x.key)).size, 10);
    const a = r.rows.find((x) => x.date === "2026-09-14")!;
    assert.deepEqual({ ...a, key: "" }, { key: "", date: "2026-09-14", regime: "情绪中", score: 160, money_effect: 1.5, board: "2板", boards: 2, first_seal: "09:30:00", broken_times: 1, industry: "行业" });
    // 炸板的带当天炸了几次和行业;没碰涨停的都不写
    const b = r.rows.find((x) => x.date === "2026-09-15")!;
    assert.deepEqual([b.board, b.boards, b.first_seal, b.broken_times, b.industry], ["炸板", null, null, 2, "行业"]);
    const d = r.rows.find((x) => x.date === "2026-09-17")!;
    assert.deepEqual([d.board, d.broken_times, d.industry], ["没碰涨停", null, null]);
    const j = r.rows.find((x) => x.date === "2026-10-12")!;
    assert.deepEqual([j.regime, j.board, j.score, j.broken_times, j.industry], [null, null, null, null, null]);
    assert.deepEqual(r.gaps, [
      "1 笔的入场日还没收盘,不分组",
      "1 天的情绪读数没取到(超过东财保留期,当时也没缓存):2026-09-01",
      "1 天的情绪读数没取到(情绪读数缺涨停家数、最高连板、炸板率中的一项):2026-09-22",
      "1 天的情绪读数没取到(东财池为空):2026-09-23",
      "1 天的涨停池没取到(超过东财保留期,当时也没缓存):2026-09-01",
      "1 天的涨停池没取到(池子取不到):2026-09-22",
      "2 天的炸板池没取到(池是空的(超过东财保留期或不是交易日时如此)):2026-09-14、2026-09-21",
    ]);
    // 超过保留期的不发请求;没收盘的那天什么都不取
    const calls = ctx.calls();
    assert.ok(!calls.some((c) => c.args.date === "2026-09-01" || c.args.date === "20260901"), "超过保留期只读缓存");
    assert.ok(!calls.some((c) => c.args.date === "2026-10-12" || c.args.date === "20261012"), "没收盘的那天不取");
    const zt14 = () => ctx.calls().filter((c) => c.ep === "em_zt_pool" && c.args.date === "20260914").length;
    assert.equal(zt14(), 1);
    // 再开一次:收盘后取到的池子和读数都读缓存(取失败的不缓存,会重取)
    const before = ctx.calls().length;
    const r2 = await journalEnvironment(ctx, {}, sig, NOW);
    assert.ok(r2.available);
    assert.equal(zt14(), 1);
    const again = ctx.calls().slice(before).map((c) => `${c.ep}:${String(c.args.date)}`).sort();
    assert.deepEqual(again, ["cn_shortline_daily:2026-09-23", "em_zt_pool:20260922"]);
  } finally {
    cleanup(ctx);
  }
});

test("缓存的池子是那天收盘前取的:保留期内重取一次;超过保留期取不回来,算没取到(不拿盘中的池子分组)", async () => {
  const ctx = fakeCtx();
  try {
    // 取数时间是真实时钟,2099 年那天的收盘还没到 ⇒ 缓存一定是「收盘前取的」
    ctx.setCfg({ daily: { "2099-01-05": day(50, 3, 0.2) }, zt: { "20990105": [["600519", 1, 93000]] }, zb: { "20990105": [["000001", 1, 93000]] } });
    ledgerInsertMany(ctx, { kind: "trade", records: round("600519", "2099-01-05", "2099-01-06", 10, 11) });
    const NOW = new Date("2099-01-06T08:00:00Z");
    const count = (ep: string) => ctx.calls().filter((c) => c.ep === ep).length;
    const r1 = await journalEnvironment(ctx, {}, sig, NOW);
    assert.ok(r1.available && r1.rows[0]!.board === "首板");
    assert.deepEqual([count("em_zt_pool"), count("em_zb_pool"), count("cn_shortline_daily")], [1, 1, 1]);
    await journalEnvironment(ctx, {}, sig, NOW);
    // 池子:缓存是收盘前的 ⇒ 重取;情绪读数快照层只存收盘后的,照常读缓存
    assert.deepEqual([count("em_zt_pool"), count("em_zb_pool"), count("cn_shortline_daily")], [2, 2, 1]);
    // 两个月后:超过保留期,只读缓存,而缓存又是收盘前的 ⇒ 没取到
    const r3 = await journalEnvironment(ctx, {}, sig, new Date("2099-03-06T08:00:00Z"));
    assert.ok(r3.available);
    assert.equal(r3.rows[0]!.board, "没取到");
    assert.equal(count("em_zt_pool"), 2);
    assert.ok(r3.gaps.includes("1 天的涨停池没取到(本机只存了那天盘中的池子):2099-01-05"), JSON.stringify(r3.gaps));
  } finally {
    cleanup(ctx);
  }
});

test("缓存还在、落盘的池子全表没了:保留期内重取;超出保留期说「全表不见了」,不当成空池", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ daily: { "2026-09-30": day(50, 3, 0.2) }, zt: { "20260930": [["600519", 1, 93000]] }, zb: { "20260930": [["000001", 1, 93000]] } });
    ledgerInsertMany(ctx, { kind: "trade", records: round("600519", "2026-09-30", "2026-10-09", 10, 11) });
    const NOW = new Date("2026-10-12T08:00:00Z");
    const count = (ep: string) => ctx.calls().filter((c) => c.ep === ep).length;
    const lose = () => {
      const files = fs.readdirSync(ctx.dataRoot, { recursive: true }).map(String).filter((f) => /em_z[tb]_pool_20260930_\d+\.json$/.test(f));
      assert.ok(files.length >= 2, `落盘的池子文件: ${files.join(",")}`);
      for (const f of files) fs.rmSync(path.join(ctx.dataRoot, f));
    };
    const r1 = await journalEnvironment(ctx, {}, sig, NOW);
    assert.ok(r1.available && r1.rows[0]!.board === "首板");
    assert.deepEqual([count("em_zt_pool"), count("em_zb_pool")], [1, 1]);
    lose();
    const r2 = await journalEnvironment(ctx, {}, sig, NOW);
    assert.ok(r2.available);
    assert.equal(r2.rows[0]!.board, "首板", "重取回来照常分");
    assert.deepEqual([count("em_zt_pool"), count("em_zb_pool")], [2, 2]);
    assert.ok(!r2.gaps.some((g) => g.includes("池")), JSON.stringify(r2.gaps));
    lose();
    const r3 = await journalEnvironment(ctx, {}, sig, new Date("2026-12-14T08:00:00Z"));
    assert.ok(r3.available);
    assert.equal(r3.rows[0]!.board, "没取到");
    assert.deepEqual([count("em_zt_pool"), count("em_zb_pool")], [2, 2], "超出保留期不重取");
    assert.ok(r3.gaps.includes("1 天的涨停池没取到(本机缓存的池子全表不见了):2026-09-30"), JSON.stringify(r3.gaps));
    assert.ok(!r3.gaps.some((g) => g.includes("池是空的")), JSON.stringify(r3.gaps));
  } finally {
    cleanup(ctx);
  }
});

test("没有交易记录 / 设置坏了:不可用并说明", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({});
    const r = await journalEnvironment(ctx, {}, sig, new Date("2026-10-12T08:00:00Z"));
    assert.deepEqual(r, { available: false, reason: "还没有交易记录" });
    assert.equal(ctx.calls().length, 0);
  } finally {
    cleanup(ctx);
  }
});
