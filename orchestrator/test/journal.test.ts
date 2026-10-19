import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register_tasks.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { ServiceError, ledgerList, ledgerRemove, ledgerUpsert, type ServiceContext } from "../src/service.ts";
import { replayTrades, tradeOf, type Trade } from "../src/finance/holdings.ts";
import { T0_WARNING, buildEpisodes } from "../src/finance/journal/episodes.ts";
import { DEFAULT_FEES, estimateFee } from "../src/finance/journal/fees.ts";
import { mean, median, pyRound, sum } from "../src/finance/journal/num.ts";
import { buildRows, type JournalRow, type Tag } from "../src/finance/journal/rows.ts";
import { bucketStats, journalStats } from "../src/finance/journal/stats.ts";
import { journalAct, journalView, type JournalView } from "../src/finance/journal/view.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let n = 0;
const tr = (fields: Record<string, unknown>): Trade => {
  n += 1;
  const at = new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
  return tradeOf({ id: `t${String(n).padStart(4, "0")}`, kind: "trade", created_at: at, updated_at: at, symbol: "600519", ...fields } as LedgerRecord);
};
const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ""} ${a} ≠ ${b}`);

test("pyRound 与 Python round 一致:恰好一半取偶、按 double 精确值舍入", () => {
  // 期望值由 Python 3.12 round() 实算
  const cases: [number, number, number][] = [
    [2.675, 2, 2.67], [0.125, 2, 0.12], [0.375, 2, 0.38], [-0.125, 2, -0.12], [1.5, 0, 2], [2.5, 0, 2],
    [9.995, 2, 9.99], [1.005, 2, 1], [972 / 22000 * 100, 2, 4.42], [39.4545, 2, 39.45], [5.01 + 5.5355, 2, 10.55],
    [1234.5678, 3, 1234.568], [0.5, 0, 0], [-2.5, 0, -2], [99.995, 2, 100], [0.0049999, 2, 0],
  ];
  for (const [x, d, want] of cases) assert.equal(pyRound(x, d), want, `round(${x}, ${d})`);
  assert.ok(Object.is(pyRound(-0.001, 2), 0) || pyRound(-0.001, 2) === 0);
  // 补偿求和,和 Python 3.12 sum() 逐位一致(期望值由 Python 实算);普通累加 0.1+0.2+0.3 是 0.6000000000000001
  assert.equal(sum([0.1, 0.2, 0.3]), 0.6);
  assert.equal(sum(Array(10).fill(0.1)), 1);
  assert.equal(sum([0.1, 0.2, 0.3, -0.6]), 2.7755575615628914e-17);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  // 平均数和 statistics.mean 一样只舍入一次(期望值由 Python 实算);sum / n 两次舍入,保留两位时差一分
  const m1 = [39.25, -485.94, -496.36, -97.95, 431.44, 405.31, 224.73, -494.88, -100.95, 21.09, -370.9, 268.34];
  assert.equal(mean(m1), -54.735);
  assert.equal(pyRound(mean(m1), 2), -54.73);
  assert.equal(pyRound(sum(m1) / m1.length, 2), -54.74);
  assert.equal(mean([-1.698, 1.942, -2.585, -0.998, 2.649, -1.772, -0.822, -0.431, 2.522, 1.77, -2.294, 2.257]), 0.045);
  // 恰好落在两个 double 正中间:取偶(期望值由 Python 实算)
  assert.equal(mean([1, 1 + 2 ** -52]), 1);
  assert.equal(mean([1 + 2 ** -52, 1 + 2 ** -51]), 1 + 2 ** -51);
  assert.equal(mean([1, 1, 1 + 2 ** -51]), 1 + 2 ** -52);
  assert.equal(mean([5e-324, 5e-324]), 5e-324);
  assert.equal(mean([1e308, 1e308]), 1e308);
});

test("费用估算:佣金有最低、印花税只在卖出", () => {
  close(estimateFee("buy", 10, 100, DEFAULT_FEES), 5 + 1000 * 0.00001);
  close(estimateFee("sell", 10.5, 100, DEFAULT_FEES), 5 + 1050 * 0.00001 + 1050 * 0.0005);
  close(estimateFee("buy", 100, 1000, DEFAULT_FEES), 100000 * 0.00025 + 100000 * 0.00001);
});

/**
 * 手算(费用都填了):
 *   3/3 买 1000 @10 费 5;3/4 买 1000 @12 费 6 → 2000 股,不含费成本 22000,买入费 11,最多占用 22000
 *   3/5 卖 500 @13 费 8:均价 11,毛利 1000,结转买入费 11×0.25 = 2.75 → 当日净 1000 − 10.75 = 989.25
 *   3/6 卖 1500 @11 费 9:毛利 0,结转剩余买入费 8.25 → 当日净 −17.25
 *   合计毛利 1000、费用 28、净 972;% = 972 / 22000 = 4.42;持有 3 天
 */
test("一轮结算:VA 口径逐项(均价、净额、按卖出日记盈亏、% 分母不含费用)", () => {
  const ts = [
    tr({ type: "buy", date: "2025-03-03", shares: 1000, price: 10, fee: 5, name: "贵州茅台" }),
    tr({ type: "buy", date: "2025-03-04", shares: 1000, price: 12, fee: 6 }),
    tr({ type: "sell", date: "2025-03-05", shares: 500, price: 13, fee: 8 }),
    tr({ type: "sell", date: "2025-03-06", shares: 1500, price: 11, fee: 9 }),
  ];
  const r = buildEpisodes(ts, DEFAULT_FEES);
  assert.deepEqual(r.issues, []);
  assert.equal(r.episodes.length, 1);
  const e = r.episodes[0]!;
  assert.equal(e.id, ts[0]!.id);
  assert.equal(e.name, "贵州茅台");
  assert.equal(e.closed, true);
  assert.equal(e.first_buy, "2025-03-03");
  assert.equal(e.last_sell, "2025-03-06");
  assert.equal(e.buy_shares, 2000);
  assert.equal(e.sell_shares, 2000);
  assert.equal(e.open_shares, 0);
  assert.equal(e.avg_cost, 11);
  assert.equal(e.amount, 22000);
  assert.equal(e.avg_sell, 11.5);
  assert.equal(e.gross_pnl, 1000);
  assert.equal(e.fees, 28);
  assert.equal(e.fees_are_estimated, false);
  assert.equal(e.realized_pnl, 972);
  assert.deepEqual(e.realized_by_date, { "2025-03-05": 989.25, "2025-03-06": -17.25 });
  assert.equal(e.realized_pct, 4.42);
  assert.equal(e.hold_days, 3);
  assert.equal(e.settlement_warning, null);
  // 费用都填了时,净额必须和持仓页(加权平均)的已实现盈亏一致 —— 一份账、两处展示
  const rep = replayTrades(ts, "average");
  close(rep.realized.reduce((s, x) => s + x.pnl, 0), 972);
});

test("同日买卖没有隔夜底仓:标出来;没填费用按费率估并标「估」", () => {
  const ts = [
    tr({ type: "buy", date: "2025-03-10", shares: 100, price: 10 }),
    tr({ type: "sell", date: "2025-03-10", shares: 100, price: 10.5 }),
  ];
  const e = buildEpisodes(ts, DEFAULT_FEES).episodes[0]!;
  assert.equal(e.settlement_warning, T0_WARNING);
  assert.equal(e.hold_days, 0);
  assert.equal(e.fees_are_estimated, true);
  assert.equal(e.fees, 10.55);
  assert.equal(e.realized_pnl, 39.45);
  assert.deepEqual(e.fills.map((f) => f.fee_estimated), [true, true]);
  // 期初持仓当天就能卖:不标
  const o = buildEpisodes([
    tr({ type: "opening", date: "2025-03-10", shares: 100, price: 9 }),
    tr({ type: "sell", date: "2025-03-10", shares: 100, price: 10, fee: 6 }),
  ], DEFAULT_FEES).episodes[0]!;
  assert.equal(o.settlement_warning, null);
  assert.equal(o.from_opening, true);
  assert.equal(o.fills[0]!.fee, 0);
  assert.equal(o.fills[0]!.fee_estimated, false);
  assert.equal(o.realized_pnl, 94);
  // 最多占用的资金 ≠ 买入总额:买 1000@10、卖 500、再买 500@12 → 峰值 5000 + 6000 = 11000(不是 16000)
  const pk = buildEpisodes([
    tr({ type: "buy", date: "2025-03-11", shares: 1000, price: 10, fee: 5 }),
    tr({ type: "sell", date: "2025-03-12", shares: 500, price: 10, fee: 5 }),
    tr({ type: "buy", date: "2025-03-13", shares: 500, price: 12, fee: 5 }),
  ], DEFAULT_FEES).episodes[0]!;
  assert.equal(pk.amount, 11000);
  assert.equal(pk.avg_cost, 11);
  // 有隔夜底仓的做 T 不标:前一天买 200,今天先买 100 再卖 100
  const t = buildEpisodes([
    tr({ type: "buy", date: "2025-03-11", shares: 200, price: 10, fee: 5 }),
    tr({ type: "buy", date: "2025-03-12", shares: 100, price: 9.5, fee: 5 }),
    tr({ type: "sell", date: "2025-03-12", shares: 100, price: 10.2, fee: 5 }),
  ], DEFAULT_FEES).episodes[0]!;
  assert.equal(t.settlement_warning, null);
  assert.equal(t.closed, false);
  assert.equal(t.open_shares, 200);
});

test("切轮:卖光就是一笔;再买是新的一笔;送转改股数不改成本;分红挂到当轮或上一轮、不进盈亏", () => {
  const ts = [
    tr({ type: "buy", date: "2025-04-01", shares: 100, price: 10, fee: 5 }),
    tr({ type: "split", date: "2025-04-02", ratio: 2 }),
    tr({ type: "sell", date: "2025-04-03", shares: 200, price: 6, fee: 5 }),
    tr({ type: "dividend", date: "2025-04-10", amount: 20 }),
    tr({ type: "buy", date: "2025-05-06", shares: 300, price: 7, fee: 5 }),
  ];
  const r = buildEpisodes(ts, DEFAULT_FEES);
  assert.equal(r.episodes.length, 2);
  const [open, done] = r.episodes; // 新的在前
  assert.equal(open!.first_buy, "2025-05-06");
  assert.equal(open!.closed, false);
  assert.equal(open!.realized_pnl, null);
  assert.equal(open!.avg_cost, 7);
  assert.equal(done!.closed, true);
  assert.equal(done!.has_split, true);
  assert.equal(done!.dividends, 20);
  assert.equal(done!.realized_pnl, 200 - 10); // (6 − 5) × 200 − 两笔费用
  assert.equal(done!.realized_pct, 19); // 净 190 / 不含费成本 1000
  assert.equal(done!.avg_cost, 5);
  assert.deepEqual(done!.trade_ids, ts.slice(0, 4).map((t) => t.id));
  // 买入之前就到账的分红没有可挂的一轮
  assert.equal(buildEpisodes([tr({ type: "dividend", date: "2025-01-01", amount: 3 })], DEFAULT_FEES).orphan_dividends, 1);
});

test("不参与计算的流水和持仓页同一个判断;港美股不进交易日志;台账问题照列", () => {
  const ok = tr({ type: "buy", date: "2025-06-02", shares: 100, price: 10, fee: 5 });
  const over = tr({ type: "sell", date: "2025-06-03", shares: 300, price: 11, fee: 5 });
  const bshare = tr({ symbol: "900901", type: "buy", date: "2025-06-02", shares: 100, price: 1 });
  const hk = tr({ symbol: "00700.HK", type: "buy", date: "2025-06-02", shares: 100, price: 300 });
  const broken = tr({ type: "buy", date: "2025-06-04", shares: 100, price: 10 });
  const r = buildEpisodes([ok, over, bshare, hk, broken], DEFAULT_FEES, [{ id: broken.id, why: "shares 不对" }]);
  assert.deepEqual(r.issues.map((i) => i.id).sort(), [over.id, bshare.id, broken.id].sort());
  assert.match(r.issues.find((i) => i.id === over.id)!.why, /超过当时持有/);
  assert.match(r.issues.find((i) => i.id === broken.id)!.why, /不合台账规则/);
  assert.deepEqual(r.skipped_non_a, ["00700.HK"]);
  assert.equal(r.episodes.length, 1);
  // 🔴 ETF、可转债、国债逆回购不是股票:不进交易日志,不按股票扣印花税(审计 2026-10-11 Codex 范围 2 第 7 条)
  const notStock = ["510300", "159915", "113050", "123100", "204001", "131810", "019547"].flatMap((symbol) => [
    tr({ symbol, type: "buy", date: "2025-06-02", shares: 10000, price: 4 }), tr({ symbol, type: "sell", date: "2025-06-03", shares: 10000, price: 4.01 })]);
  const r2 = buildEpisodes([ok, ...notStock], DEFAULT_FEES);
  assert.equal(r2.episodes.length, 1, "只剩那只股票");
  assert.deepEqual(r2.skipped_non_a, ["019547", "113050", "123100", "131810", "159915", "204001", "510300"]);
  // 股票的各个板块照常进(沪深主板、科创板、创业板、北交所新老代码)
  for (const symbol of ["600519", "605001", "688981", "000001", "001979", "002594", "003816", "300750", "301001", "302132", "920001", "430047", "833171"]) {
    assert.equal(buildEpisodes([tr({ symbol, type: "buy", date: "2025-06-02", shares: 100, price: 10 })], DEFAULT_FEES).episodes.length, 1, symbol);
  }
  assert.equal(r.episodes[0]!.open_shares, 100);
  // 被跳过的卖出不改状态:和持仓页同样的持有数
  assert.equal(replayTrades([ok, over], "average").holdings[0]!.shares, 100);
});

const tag = (f: Partial<Tag>): Tag => ({
  id: `g${(n += 1)}`, symbol: "600519", name: "", trade_id: "", date: "", playbook: null, as_planned: null,
  planned_stop: null, planned_target: null, pnl_pct: null, note: "", planned_at: "", migrated_from: "",
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", ...f,
});

test("标注:挂到包含那笔流水的一轮;多条只认最后修改的;挂不上的列出原因;补记单独成行", () => {
  const b1 = tr({ type: "buy", date: "2025-07-01", shares: 100, price: 10, fee: 5 });
  const s1 = tr({ type: "sell", date: "2025-07-02", shares: 100, price: 11, fee: 5 });
  const over = tr({ type: "sell", date: "2025-07-03", shares: 100, price: 11, fee: 5 });
  const ep = buildEpisodes([b1, s1, over], DEFAULT_FEES);
  const skipped = new Map(ep.issues.map((i) => [i.id, i.why]));
  const known = new Set([b1.id, s1.id, over.id]);
  const old = tag({ trade_id: s1.id, playbook: "低吸", updated_at: "2026-01-01T00:00:00.000Z" });
  const nw = tag({ trade_id: b1.id, playbook: "打板", as_planned: true, planned_stop: 9.5, planned_at: "2025-07-02T01:00:00.000Z", updated_at: "2026-02-01T00:00:00.000Z" });
  const gone = tag({ trade_id: "deleted" });
  const skip = tag({ trade_id: over.id });
  const wrongSym = tag({ trade_id: b1.id, symbol: "000001" });
  const hk = tag({ symbol: "00700.HK", trade_id: b1.id });
  const etf = tag({ symbol: "510300", date: "2025-06-30", pnl_pct: 1 });
  const man = tag({ date: "2025-06-30", pnl_pct: -3, playbook: "接力" });
  const noDate = tag({ pnl_pct: 2 });
  const r = buildRows(ep.episodes, [old, nw, gone, skip, wrongSym, hk, etf, man, noDate], skipped, known);
  assert.equal(r.rows.length, 2);
  const row = r.rows.find((x) => x.kind === "episode")!;
  assert.equal(row.tag_id, nw.id);
  assert.equal(row.playbook, "打板");
  assert.equal(row.as_planned, true);
  // 止损在买入日(北京时间 7/1)之后的 7/2 才写下
  assert.equal(row.plan_late, true);
  assert.equal(row.pnl_pct, 9);
  assert.deepEqual(r.conflicts.map((c) => c.id), [old.id]);
  const why = Object.fromEntries(r.orphans.map((o) => [o.id, o.why]));
  assert.match(why[gone.id]!, /已经删了/);
  assert.match(why[skip.id]!, /不参与计算/);
  assert.match(why[wrongSym.id]!, /对不上/);
  assert.match(why[hk.id]!, /只管 A 股/);
  assert.match(why[etf.id]!, /ETF/, "ETF 的补记也不进交易日志");
  assert.match(why[noDate.id]!, /要写日期/);
  const m = r.rows.find((x) => x.kind === "manual")!;
  assert.equal(m.key, man.id);
  assert.equal(m.pnl_pct, -3);
  assert.equal(m.realized_pnl, null);
  // 没记标注时间的旧数据不算事后
  const legacy = buildRows(ep.episodes, [tag({ trade_id: b1.id, planned_stop: 9 })], skipped, known);
  assert.equal(legacy.rows[0]!.plan_late, false);
});

const row = (f: Partial<JournalRow>): JournalRow => ({
  key: `r${(n += 1)}`, kind: "episode", symbol: "600519", name: "", date: "2025-01-01", created_at: "", episode: null, tag_id: null,
  playbook: null, as_planned: null, planned_stop: null, planned_target: null, plan_late: false, note: "",
  pnl_pct: null, realized_pnl: null, hold_days: null, ...f,
});

test("交易记录顺序:入场日新的在前,同一天后录的在前(和 VA 一样,不按 id)", () => {
  const early = tr({ id: "aa1", created_at: "2026-01-01T00:00:00.000Z", symbol: "600001", type: "buy", date: "2025-08-01", shares: 100, price: 10, fee: 5 });
  const late = tr({ id: "zz1", created_at: "2026-01-02T00:00:00.000Z", symbol: "600002", type: "buy", date: "2025-08-01", shares: 100, price: 10, fee: 5 });
  const older = tr({ id: "mm1", created_at: "2026-01-03T00:00:00.000Z", symbol: "600003", type: "buy", date: "2025-07-01", shares: 100, price: 10, fee: 5 });
  const ep = buildEpisodes([early, late, older], DEFAULT_FEES);
  const out = buildRows(ep.episodes, [], new Map(), new Set([early.id, late.id, older.id]));
  assert.deepEqual(out.rows.map((r) => r.key), ["zz1", "aa1", "mm1"]);
  assert.deepEqual(out.rows.map((r) => r.created_at), [late.created_at, early.created_at, older.created_at]);
});

test("分组统计:胜率不算持平、全持平给 null;补记只进 %;持有天数分组", () => {
  const b = bucketStats([row({ pnl_pct: 5, realized_pnl: 100 }), row({ pnl_pct: -3, realized_pnl: -40 }), row({ pnl_pct: 0, realized_pnl: 0 }), row({ kind: "manual", pnl_pct: 2 }), row({})]);
  assert.deepEqual(b, { count: 5, scored: 4, money_scored: 3, net_pnl: 60, win_rate: 0.667, avg: 1, best: 5, worst: -3 });
  assert.equal(bucketStats([row({ pnl_pct: 0 })]).win_rate, null);
  assert.deepEqual(bucketStats([]), { count: 0, scored: 0, money_scored: 0, net_pnl: null, win_rate: null, avg: null, best: null, worst: null });
  const s = journalStats([
    row({ hold_days: 0, pnl_pct: 1, playbook: "打板", as_planned: true }), row({ hold_days: 1, pnl_pct: -1, playbook: "打板", as_planned: false }),
    row({ hold_days: 12, pnl_pct: 2 }), row({ hold_days: 3, pnl_pct: 2 }), row({}), row({ kind: "manual", pnl_pct: 4, playbook: "低吸" }),
  ]);
  assert.deepEqual(s.by_hold.map((g) => [g.key, g.count]), [["同日买卖(底仓待核)", 1], ["隔日", 1], ["持有3天", 1], ["持有12天", 1], ["还没卖", 1], ["未填明细", 1]]);
  assert.deepEqual(s.by_playbook.map((g) => [g.key, g.count]), [["打板", 2], ["低吸", 1], ["未标注", 3]]);
  assert.deepEqual(s.by_planned.map((g) => [g.key, g.count]), [["按计划", 1], ["计划外", 1], ["未标注", 4]]);
  assert.equal(s.by_playbook[0]!.win_rate, 0.5);
});

/* ---------------- 视图与动作(临时数据目录) ---------------- */

function withRoot(fn: (ctx: ServiceContext) => Promise<void>) {
  return async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vra-journal-"));
    try { await fn({ repoRoot: REPO, dataRoot, python: "false", node: process.execPath }); } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
  };
}
const NOW = new Date("2026-10-09T06:00:00Z"); // 北京时间 14:00
const sig = new AbortController().signal;
const bad = (re: RegExp) => (e: unknown) => e instanceof ServiceError && e.code === "bad_request" && re.test(e.message);
type Avail = Extract<JournalView, { available: true }>;
const view = async (ctx: ServiceContext) => (await journalView(ctx, {}, sig, NOW)) as JournalView;
const act = async (ctx: ServiceContext, body: Record<string, unknown>) => journalAct(ctx, body, sig, NOW);

test("视图:空账本也能打开;设置默认值标出来;没有流水就没有交易", withRoot(async (ctx) => {
  const v = await view(ctx);
  assert.equal(v.available, true);
  const a = v as Avail;
  assert.deepEqual(a.rows, []);
  assert.equal(a.settings.fees_default, true);
  assert.equal(a.settings.rules_default, true);
  assert.equal(a.settings.equity_base, null);
  assert.deepEqual(a.settings.fees, DEFAULT_FEES);
  assert.equal(a.stats.overall.count, 0);
  assert.equal(a.risk.equity.available, false);
  assert.equal(a.risk.violations.available, false);
  assert.equal(a.at_risk.available, false);
  assert.equal(a.inbox.available, false);
  assert.equal(a.today, "2026-10-09");
}));

test("记一笔:成交整批写进交易流水并写标注;算不了的一条都不写;中间卖光过的要分开记", withRoot(async (ctx) => {
  const fills = [
    { type: "buy", date: "2026-10-09", shares: 1000, price: 10, fee: 5 },
    { type: "sell", date: "2026-10-09", shares: 400, price: 10.5 },
  ];
  const out = await act(ctx, { action: "record", symbol: "600519", name: "贵州茅台", fills, playbook: "打板", as_planned: true, planned_stop: 9.5, note: "首板" });
  const res = out.result as { trade_ids: string[]; tag: LedgerRecord };
  assert.equal(res.trade_ids.length, 2);
  assert.equal(res.tag.trade_id, res.trade_ids[0]);
  assert.equal(res.tag.planned_at, NOW.toISOString());
  const trades = ledgerList(ctx, "trade").trade!;
  assert.equal(trades.length, 2);
  assert.equal(trades[1]!.fee, undefined); // 没填费用就不写,交易日志里按费率估
  const v = out.view as Avail;
  assert.equal(v.rows.length, 1);
  const r = v.rows[0]!;
  assert.equal(r.playbook, "打板");
  assert.equal(r.plan_late, false); // 当天写下的
  assert.equal(r.episode!.open_shares, 600);
  assert.equal(r.episode!.settlement_warning, T0_WARNING);
  // 风险、在险资金、复查清单一起给:还剩 600 股,成本 10(不含费用),止损 9.5 → 在险 300
  assert.ok(v.at_risk.available);
  if (v.at_risk.available) assert.deepEqual([v.at_risk.positions[0]!.shares, v.at_risk.positions[0]!.at_risk, v.at_risk.total_at_risk], [600, 300, 300]);
  assert.ok(v.risk.equity.available && v.risk.equity.trades === 1);
  assert.equal(v.risk.violations.available && v.risk.violations.rule_status.max_loss_per_day_pct, "unavailable:没填账户规模,单日亏损占比没有分母");
  assert.ok(v.inbox.available && v.inbox.count === 0);

  // 卖超:一条都不写
  await assert.rejects(act(ctx, { action: "record", symbol: "600519", fills: [{ type: "sell", date: "2026-10-10", shares: 5000, price: 11 }] }), bad(/算不了.*超过当时持有/));
  // 补一笔更早的卖出会让已记的卖出变成卖超
  await assert.rejects(act(ctx, { action: "record", symbol: "600519", fills: [{ type: "buy", date: "2026-10-01", shares: 100, price: 9 }, { type: "sell", date: "2026-10-02", shares: 100, price: 9 }, { type: "sell", date: "2026-10-08", shares: 1, price: 9 }] }), bad(/算不了/));
  // 新的几笔自己能算,但会让已记的卖出变成卖超(在它之前补了一笔卖出)
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "000002", type: "buy", date: "2026-09-01", shares: 1000, price: 10 } });
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "000002", type: "sell", date: "2026-09-09", shares: 900, price: 10 } });
  await assert.rejects(act(ctx, { action: "record", symbol: "000002", fills: [{ type: "sell", date: "2026-09-05", shares: 500, price: 11 }] }), bad(/会让已记的 1 笔流水算不了/));
  // 中间卖光过
  await assert.rejects(act(ctx, { action: "record", symbol: "000001", fills: [{ type: "buy", date: "2026-09-01", shares: 100, price: 9 }, { type: "sell", date: "2026-09-02", shares: 100, price: 9 }, { type: "buy", date: "2026-09-03", shares: 100, price: 9 }] }), bad(/分开记/));
  // 标注不合规则:先拒,流水也不写
  await assert.rejects(act(ctx, { action: "record", symbol: "000001", fills: [{ type: "buy", date: "2026-09-01", shares: 100, price: 9 }], planned_stop: -1 }), bad(/标注写不进去/));
  await assert.rejects(act(ctx, { action: "record", symbol: "00700.HK", fills: [{ type: "buy", date: "2026-09-01", shares: 100, price: 9 }] }), bad(/只管 A 股/));
  await assert.rejects(act(ctx, { action: "record", symbol: "510300", fills: [{ type: "buy", date: "2026-09-01", shares: 100, price: 4 }] }), bad(/ETF/));
  await assert.rejects(act(ctx, { action: "record", symbol: "000001", fills: [{ type: "buy", date: "2026-02-31", shares: 100, price: 9 }] }), bad(/写不进去/));
  await assert.rejects(act(ctx, { action: "record", symbol: "000001", fills: [{ type: "buy", date: "2026-09-01", shares: 100, price: 9 }], pnl_pct: 3 }), bad(/不能手填/));
  assert.equal(ledgerList(ctx, "trade").trade!.length, 4);
  assert.equal(ledgerList(ctx, "journal_tag").journal_tag!.length, 1);
}));

test("标注:有就改;只改备注不重盖标注时间;改了止损重盖", withRoot(async (ctx) => {
  const b = ledgerUpsert(ctx, { kind: "trade", record: { symbol: "600519", type: "buy", date: "2026-10-08", shares: 100, price: 10, fee: 5 } });
  const first = (await act(ctx, { action: "tag", trade_id: b.id, planned_stop: 9, playbook: "低吸" })).result as LedgerRecord;
  assert.equal(first.planned_at, NOW.toISOString());
  const later = new Date("2026-10-12T02:00:00Z");
  const second = (await journalAct(ctx, { action: "tag", trade_id: b.id, planned_stop: 9, playbook: "低吸", note: "补个备注" }, sig, later)).result as LedgerRecord;
  assert.equal(second.id, first.id);
  assert.equal(second.planned_at, NOW.toISOString());
  const third = (await journalAct(ctx, { action: "tag", trade_id: b.id, planned_stop: 8.8, playbook: "低吸" }, sig, later)).result as LedgerRecord;
  assert.equal(third.planned_at, later.toISOString());
  assert.equal(third.note, undefined); // 整条替换:没传的备注清掉
  const v = (await view(ctx)) as Avail;
  assert.equal(v.rows[0]!.plan_late, true);
  assert.equal(ledgerList(ctx, "journal_tag").journal_tag!.length, 1);
  await assert.rejects(act(ctx, { action: "tag", trade_id: "nope" }), bad(/找不到这笔交易/));
  await assert.rejects(act(ctx, { action: "tag", trade_id: b.id, playbook: "追涨" }), bad(/打法只能是/));
  await assert.rejects(act(ctx, { action: "tag", trade_id: b.id, as_planned: "yes" }), bad(/按计划/));
  // 流水删了:标注挂不上,列出来
  ledgerRemove(ctx, { kind: "trade", id: b.id });
  const gone = (await view(ctx)) as Avail;
  assert.equal(gone.rows.length, 0);
  assert.match(gone.orphans[0]!.why, /已经删了/);
}));

test("补记:新建、修改、删除;不收止损;要 A 股和有效日期", withRoot(async (ctx) => {
  const m = (await act(ctx, { action: "manual", symbol: "000001", date: "2025-01-02", pnl_pct: 3.5, playbook: "接力", as_planned: false })).result as LedgerRecord;
  let v = (await view(ctx)) as Avail;
  assert.equal(v.rows[0]!.kind, "manual");
  assert.equal(v.stats.overall.scored, 1);
  assert.equal(v.stats.overall.money_scored, 0);
  await act(ctx, { action: "manual", id: m.id, symbol: "000001", date: "2025-01-03", pnl_pct: -1 });
  v = (await view(ctx)) as Avail;
  assert.equal(v.rows[0]!.date, "2025-01-03");
  assert.equal(v.rows[0]!.playbook, null);
  await assert.rejects(act(ctx, { action: "manual", symbol: "000001", date: "2025-01-02", planned_stop: 9 }), bad(/不收计划止损/));
  await assert.rejects(act(ctx, { action: "manual", symbol: "AAPL", date: "2025-01-02" }), bad(/只管 A 股/));
  await assert.rejects(act(ctx, { action: "manual", symbol: "113050", date: "2025-01-02" }), bad(/可转债/));
  await assert.rejects(act(ctx, { action: "manual", symbol: "000001", date: "2025-13-01" }), bad(/有效日期/));
  await assert.rejects(act(ctx, { action: "manual", symbol: "000001", date: "2025-01-02", pnl_pct: 2000 }), bad(/标注写不进去/));
  await assert.rejects(act(ctx, { action: "manual", id: "nope", symbol: "000001", date: "2025-01-02" }), bad(/没有这条补记/));
  await act(ctx, { action: "delete_tag", id: m.id });
  v = (await view(ctx)) as Avail;
  assert.equal(v.rows.length, 0);
  await assert.rejects(act(ctx, { action: "wipe" }), bad(/不认识的动作/));
}));

test("设置:费率四项一起存或一起改回默认;规矩可以只改一项;坏设置明说、不退回默认", withRoot(async (ctx) => {
  await assert.rejects(act(ctx, { action: "settings", fees: { commission_rate: 0.0002 } }), bad(/四项都填/));
  await assert.rejects(act(ctx, { action: "settings", fees: { ...DEFAULT_FEES, stamp_tax_rate: 0.5 } }), bad(/不像费率/));
  await assert.rejects(act(ctx, { action: "settings", rules: { max_positions: 2.5 } }), bad(/整数/));
  await assert.rejects(act(ctx, { action: "settings", rules: { max_unplanned_ratio: 1.5 } }), bad(/0 到 1/));
  await assert.rejects(act(ctx, { action: "settings", rules: { max_loss_per_trade_pct: 0 } }), bad(/正数/));
  await assert.rejects(act(ctx, { action: "settings", rules: { nope: 1 } }), bad(/不认识的规矩/));
  await assert.rejects(act(ctx, { action: "settings", equity_base: -5 }), bad(/账户规模/));

  const fees = { commission_rate: 0.0001, commission_min: 0, stamp_tax_rate: 0.0005, transfer_fee_rate: 0.00001 };
  await act(ctx, { action: "settings", fees, rules: { max_positions: 2, max_unplanned_ratio: 0 }, equity_base: 200000 });
  await act(ctx, { action: "settings", rules: { pause_after_losses: 4 } });
  let v = (await view(ctx)) as Avail;
  assert.deepEqual(v.settings.fees, fees);
  assert.equal(v.settings.fees_default, false);
  assert.equal(v.settings.rules.max_positions, 2);
  assert.equal(v.settings.rules.max_unplanned_ratio, 0);
  assert.equal(v.settings.rules.pause_after_losses, 4);
  assert.equal(v.settings.rules.max_trades_per_day, 5);
  assert.equal(v.settings.rules_default, false);
  assert.equal(v.settings.equity_base, 200000);
  assert.equal(ledgerList(ctx, "journal_settings").journal_settings!.length, 1);
  // 估的费用用新费率:佣金最低 0
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "600519", type: "buy", date: "2026-10-08", shares: 100, price: 10 } });
  v = (await view(ctx)) as Avail;
  close(v.episodes[0]!.fills[0]!.fee, 1000 * 0.0001 + 1000 * 0.00001);

  await act(ctx, { action: "settings", fees: null, rules: { max_positions: null }, equity_base: null });
  v = (await view(ctx)) as Avail;
  assert.equal(v.settings.fees_default, true);
  assert.equal(v.settings.rules.max_positions, 3);
  assert.equal(v.settings.equity_base, null);

  // 手改文件留下半套费率:不出数、明说,编辑框拿得到原样设置;存一套完整的就修好
  const file = path.join(ctx.dataRoot, "ledger", "journal_settings.json");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.records[0].commission_rate = 0.0003;
  fs.writeFileSync(file, JSON.stringify(doc));
  const broken = await view(ctx);
  assert.equal(broken.available, false);
  assert.match((broken as { reason: string }).reason, /四项都填/);
  assert.equal(broken.settings.raw?.commission_rate, 0.0003);
  await act(ctx, { action: "settings", fees });
  assert.equal((await view(ctx)).available, true);
}));
