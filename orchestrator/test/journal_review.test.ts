/**
 * 交易日志第三段:模式卡、最大浮盈浮亏、判断 vs 执行归因。期望值都是手算的(写在每个用例上方)。
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
import type { LedgerRecord } from "../src/ledger.ts";
import { ServiceError, ledgerInsertMany, ledgerList, ledgerUpsert, type ServiceContext } from "../src/service.ts";
import { listViews } from "../src/views.ts";
import type { TrackDay } from "../src/finance/shortline/verification.ts";
import { computeAttribution, journalAttribution, readsOf, type DayRead } from "../src/finance/journal/attribution.ts";
import type { Episode } from "../src/finance/journal/episodes.ts";
import { computeExcursion, eligibility, excursionSummary, settledFetch, type ExcursionInput, type HLBar } from "../src/finance/journal/excursion.ts";
import { MIN_PER_VERSION, modeChanged, modesPerformance, versionAt, type ModeCard, type ModeVersion } from "../src/finance/journal/modes.ts";
import type { JournalRow } from "../src/finance/journal/rows.ts";
import { journalAct, journalExcursion, journalView, type JournalView } from "../src/finance/journal/view.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";
const sig = new AbortController().signal;
const bad = (re: RegExp) => (e: unknown) => e instanceof ServiceError && e.code === "bad_request" && re.test(e.message);
type Avail = Extract<JournalView, { available: true }>;

let n = 0;
function ep(f: Partial<Episode>): Episode {
  return {
    id: `e${(n += 1)}`, symbol: "600000", name: "", trade_ids: [], fills: [], from_opening: false, has_split: false, dividends: 0,
    created_at: "", first_buy: "2025-01-01", last_sell: null, closed: false, buy_shares: 0, sell_shares: 0, open_shares: 0,
    avg_cost: 10, amount: 10000, avg_sell: null, gross_pnl: null, fees: null, fees_are_estimated: null, realized_pnl: null,
    realized_by_date: null, realized_pct: null, hold_days: null, settlement_warning: null, ...f,
  };
}
function row(f: Partial<JournalRow> & { ep?: Partial<Episode> | null }): JournalRow {
  const { ep: e, ...rest } = f;
  const key = `r${(n += 1)}`;
  const episode = e === null ? null : ep({ symbol: rest.symbol ?? "600000", first_buy: rest.date ?? "2025-01-01", realized_pnl: rest.realized_pnl ?? null, ...(e ?? {}) });
  return {
    key, kind: episode ? "episode" : "manual", symbol: "600000", name: "", date: "2025-01-01", created_at: "",
    episode, tag_id: null, playbook: null, as_planned: null, planned_stop: null, planned_target: null, plan_late: false, note: "",
    pnl_pct: null, realized_pnl: null, hold_days: null, ...rest,
  };
}
const desc = (rows: JournalRow[]) => [...rows].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
const ver = (version: number, since: string, playbook: string): ModeVersion =>
  ({ version, since, changes: "", playbook, setup: "", entry: "", exit: "", sizing: "", phase: "", saved_at: "" });
const card = (id: string, versions: ModeVersion[]): ModeCard => ({ id, name: id, playbook: versions.at(-1)!.playbook, versions, migrated_from: "", created_at: "", updated_at: "" });

/* ---------------- 模式卡 ---------------- */

/**
 * 卡 c1:v1 09-01 打板 / v2、v3 同在 09-10 生效(当天改了两次,以 v3 为准)/ v4 09-20 改成低吸
 *   建卡前:08-20 打板 +2 → 单列;08-25 低吸 → 不算(第一版是打板)
 *   v1 [09-01, 09-10) 打板 6 笔 +3 −1 +2 0 +4 −2 → 胜 3 负 2 = 0.6;中位 (0+2)/2 = 1;均 6/6 = 1;最好 4 最差 −2;够数
 *   v3 [09-10, 09-20) 打板 6 笔 +1 +1 −3 +5 −1 +2 → 4/6 = 0.667;中位 1;均 5/6 = 0.83
 *   v4 低吸 3 笔 +2 −4 +1(另 1 笔没盈亏)→ 不够 6 笔 ⇒ 不比较、标 compare_blocked;09-25 那笔打板不归 v4
 *   matched = 1 + 6 + 6 + 3 = 16
 * 卡 c2:v1 09-01 打板 / v2 09-10 打板 → v2 = c1 的 v3 那 6 笔 + 09-25 打板 +6 = 7 笔,5/7 = 0.714,中位 1,均 11/7 = 1.57
 *   比较:胜率 0.714 − 0.6 = 0.114;中位差 0
 * 卡 c3:v1 09-01 / v2、v3 同在 09-10(最后一天改了两次)→ 只认 v3,和 v1 比(v2 一笔没有,拿它比就成了「不够」)
 */
test("模式卡业绩:按入场日落在哪个版本分段,归属看当时那版的打法;同一天改两次以后一版为准;样本不够不比较", () => {
  const rows: JournalRow[] = [];
  const add = (date: string, playbook: string, pnl: number | null) => rows.push(row({ date, playbook, pnl_pct: pnl }));
  add("2026-08-20", "打板", 2); add("2026-08-25", "低吸", 5);
  [3, -1, 2, 0, 4, -2].forEach((p, i) => add(`2026-09-0${i + 1}`, "打板", p));
  add("2026-09-05", "低吸", 10);
  [1, 1, -3, 5, -1, 2].forEach((p, i) => add(`2026-09-1${i}`, "打板", p));
  [2, -4, 1].forEach((p, i) => add(`2026-09-2${i}`, "低吸", p));
  add("2026-09-23", "低吸", null);
  add("2026-09-25", "打板", 6);
  const c1 = card("c1", [ver(1, "2026-09-01", "打板"), ver(2, "2026-09-10", "打板"), ver(3, "2026-09-10", "打板"), ver(4, "2026-09-20", "低吸")]);
  const c2 = card("c2", [ver(1, "2026-09-01", "打板"), ver(2, "2026-09-10", "打板")]);
  const c3 = card("c3", [ver(1, "2026-09-01", "打板"), ver(2, "2026-09-10", "打板"), ver(3, "2026-09-10", "打板")]);
  const m = modesPerformance([c1, c2, c3], desc(rows));
  assert.ok(m.available);
  if (!m.available) return;
  assert.equal(m.truncated, false);
  assert.equal(m.min_per_version, MIN_PER_VERSION);
  const [a, b, c] = m.cards;
  const pick = (v: (typeof a.by_version)[number]) => [v.version, v.trades, v.win_rate, v.median_pct, v.avg_pct, v.best, v.worst, v.enough];
  assert.deepEqual(a!.by_version.map(pick), [
    [1, 6, 0.6, 1, 1, 4, -2, true], [2, 0, null, null, null, null, null, false], [3, 6, 0.667, 1, 0.83, 5, -3, true], [4, 3, 0.667, 1, -0.33, 2, -4, false],
  ]);
  assert.equal(a!.matched_trades, 16);
  assert.deepEqual(a!.before_card, { trades: 1, win_rate: 1, median_pct: 2, avg_pct: 2, best: 2, worst: 2, enough: false });
  assert.equal(a!.latest_vs_prev, null);
  assert.equal(a!.compare_blocked, true);
  assert.deepEqual(b!.by_version.map(pick), [[1, 6, 0.6, 1, 1, 4, -2, true], [2, 7, 0.714, 1, 1.57, 6, -3, true]]);
  assert.deepEqual(b!.latest_vs_prev, { win_rate_delta: 0.114, median_delta: 0, from_version: 1, to_version: 2 });
  assert.equal(b!.compare_blocked, false);
  assert.equal(b!.matched_trades, 14);
  assert.deepEqual(c!.latest_vs_prev, { win_rate_delta: 0.114, median_delta: 0, from_version: 1, to_version: 3 });
  assert.equal(c!.compare_blocked, false);

  // 超过 1000 笔:只看最近 1000 笔,整个暂停比较
  const many = desc(Array.from({ length: 1001 }, (_, i) => row({ date: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}`, playbook: "打板", pnl_pct: 1 })));
  const t = modesPerformance([c2], many);
  assert.ok(t.available && t.truncated);
  if (t.available) {
    assert.ok(t.cards[0]!.by_version.every((v) => !v.enough));
    assert.equal(t.cards[0]!.by_version.reduce((s, v) => s + v.trades, 0), 1000);
    assert.match(t.note, /只看最近 1000 笔/);
  }
  assert.deepEqual(modesPerformance([], rows), { available: false, reason: "还没有模式卡 —— 先把「我这套打法」写下来,统计才有分段依据" });

  // 版本归属与「改没改」
  assert.equal(versionAt(c1.versions, "2026-08-31"), null);
  assert.equal(versionAt(c1.versions, "2026-09-10")!.version, 3);
  assert.equal(versionAt(c1.versions, "2026-09-19")!.version, 3);
  assert.equal(versionAt(c1.versions, "2026-09-20")!.version, 4);
  assert.equal(modeChanged(null, { setup: "", entry: "", exit: "", sizing: "", phase: "", playbook: "打板" }), true);
  assert.equal(modeChanged(c2.versions[1]!, { setup: "", entry: "", exit: "", sizing: "", phase: "", playbook: "打板" }), false);
  assert.equal(modeChanged(c2.versions[1]!, { setup: "", entry: "", exit: "x", sizing: "", phase: "", playbook: "打板" }), true);
  assert.equal(modeChanged(c2.versions[1]!, { setup: "", entry: "", exit: "", sizing: "", phase: "", playbook: "低吸" }), true);
});

function withRoot(fn: (ctx: ServiceContext) => Promise<void>) {
  return async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vra-journal-review-"));
    try { await fn({ repoRoot: REPO, dataRoot, python: "false", node: process.execPath }); } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
  };
}
const NOW = new Date("2026-10-09T06:00:00Z"); // 北京时间 10-09 14:00
const LATER = new Date("2026-10-09T13:00:00Z");
const view = async (ctx: ServiceContext) => (await journalView(ctx, {}, sig, NOW)) as Avail;

test("模式卡写入:建卡当天是第一版;内容改了开新版本、次日生效,旧版本不动;只改名字不开;超长拒收不截断", withRoot(async (ctx) => {
  assert.equal((await view(ctx)).modes.available, false);
  const r1 = (await journalAct(ctx, { action: "mode_save", name: "首板", playbook: "打板", setup: " 情绪回暖 ", entry: "排板" }, sig, NOW)).result as { card: LedgerRecord; created: boolean };
  assert.equal(r1.created, true);
  const id = r1.card.id;
  assert.deepEqual(r1.card.versions, [{ version: 1, since: "2026-10-09", changes: "初版", playbook: "打板", setup: "情绪回暖", entry: "排板", exit: "", sizing: "", phase: "", saved_at: NOW.toISOString() }]);

  // 只改名字:不开新版本,只更新保存时间
  const r2 = (await journalAct(ctx, { action: "mode_save", card_id: id, name: "首板接力", playbook: "打板", setup: "情绪回暖", entry: "排板" }, sig, LATER)).result as { card: LedgerRecord; new_version: boolean };
  assert.equal(r2.new_version, false);
  assert.equal(r2.card.name, "首板接力");
  assert.deepEqual((r2.card.versions as ModeVersion[]).map((v) => [v.version, v.since, v.saved_at]), [[1, "2026-10-09", LATER.toISOString()]]);

  // 改了怎么进:开 v2,从次日生效;v1 原样
  const r3 = (await journalAct(ctx, { action: "mode_save", card_id: id, name: "首板接力", playbook: "打板", setup: "情绪回暖", entry: "半路", changes: "排板改半路" }, sig, LATER)).result as { card: LedgerRecord; new_version: boolean };
  assert.equal(r3.new_version, true);
  const vs3 = r3.card.versions as ModeVersion[];
  assert.deepEqual(vs3.map((v) => [v.version, v.since, v.changes, v.entry]), [[1, "2026-10-09", "初版", "排板"], [2, "2026-10-10", "排板改半路", "半路"]]);

  // 改打法也开新版本;没写改了什么给占位
  const r4 = (await journalAct(ctx, { action: "mode_save", card_id: id, name: "首板接力", playbook: "低吸", setup: "情绪回暖", entry: "半路" }, sig, LATER)).result as { card: LedgerRecord };
  assert.equal(r4.card.playbook, "低吸");
  assert.deepEqual((r4.card.versions as ModeVersion[]).map((v) => [v.version, v.since, v.playbook, v.changes]),
    [[1, "2026-10-09", "打板", "初版"], [2, "2026-10-10", "打板", "排板改半路"], [3, "2026-10-10", "低吸", "(没写改了什么)"]]);

  const save = (body: Record<string, unknown>) => journalAct(ctx, { action: "mode_save", ...body }, sig, NOW);
  await assert.rejects(save({ name: " ", playbook: "打板" }), bad(/要有名字/));
  await assert.rejects(save({ name: "x".repeat(61), playbook: "打板" }), bad(/名字」最多 60 字/));
  await assert.rejects(save({ name: "a", playbook: "追涨" }), bad(/打法只能是/));
  await assert.rejects(save({ name: "a", playbook: "打板", setup: "x".repeat(801) }), bad(/什么情况下做」最多 800 字\(现在 801 字\)/));
  await assert.rejects(save({ name: "a", playbook: "打板", exit: 3 }), bad(/怎么出」要是文字/));
  await assert.rejects(save({ name: "a", playbook: "打板", card_id: "nope" }), bad(/没找到这张模式卡/));
  assert.equal((ledgerList(ctx, "mode_card").mode_card ?? []).length, 1, "拒收的一条都没写");

  // 视图:卡片带业绩分段(没有交易也能看)
  const v = await view(ctx);
  assert.ok(v.modes.available);
  if (v.modes.available) assert.deepEqual(v.modes.cards.map((c) => [c.name, c.version_count, c.matched_trades]), [["首板接力", 3, 0]]);

  // 台账里一张坏卡:不用、计数;不能在它上面改
  const file = path.join(ctx.dataRoot, "ledger", "mode_card.json");
  const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { records: Record<string, unknown>[] };
  doc.records.push({ id: "broken", kind: "mode_card", created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z", name: "坏卡", playbook: "打板", versions: [] });
  fs.writeFileSync(file, JSON.stringify(doc));
  assert.equal((await view(ctx)).invalid_cards, 1);
  await assert.rejects(save({ name: "a", playbook: "打板", card_id: "broken" }), bad(/不合台账规则/));

  // 旧数据导入的卡:改了以后还记得从哪来
  const old = ledgerUpsert(ctx, { kind: "mode_card", record: { name: "旧卡", playbook: "打板", migrated_from: "va:abc", versions: [{ version: 1, since: "2026-09-01", playbook: "打板", changes: "初版" }] } });
  const mig = (await save({ card_id: old.id, name: "旧卡", playbook: "打板", setup: "新写的" })).result as { card: LedgerRecord; new_version: boolean };
  assert.deepEqual([mig.new_version, mig.card.migrated_from, (mig.card.versions as ModeVersion[]).map((v) => [v.version, v.since])], [true, "va:abc", [[1, "2026-09-01"], [2, "2026-10-10"]]]);

  await journalAct(ctx, { action: "mode_delete", card_id: id }, sig, NOW);
  await assert.rejects(journalAct(ctx, { action: "mode_delete", card_id: id }, sig, NOW), bad(/没找到这张模式卡/));
  await assert.rejects(journalAct(ctx, { action: "mode_delete" }, sig, NOW), bad(/要给出模式卡的 id/));
}));

/* ---------------- 最大浮盈浮亏(纯计算) ---------------- */

const bars = (...rows: [string, number, number][]): HLBar[] => rows.map(([date, high, low]) => ({ date, high, low }));
const input = (f: Partial<ExcursionInput>): ExcursionInput => ({ key: "k", symbol: "600519", name: "", cost: 10, buy: "2026-09-14", sell: "2026-09-17", realized_pct: 9.9, ...f });

/**
 * 成本 10,09-14 买、09-17 卖,落袋 9.9%
 *   全段最高 12.5(卖出日)→ 最大浮盈 25.00;最低 9.0(买入日)→ 最大浮亏 −10.00
 *   中间两天(09-15、09-16)最高 12、最低 9.5 → 确定赚到过 20.00、确定差到过 −5.00
 *   回吐 25 − 9.9 = 15.1;捕获率 9.9 / 25 = 0.396(≥ 0.3,不提示)
 */
test("最大浮盈浮亏:全段与中间完整交易日分开;同日进出只给上界;捕获率只在浮盈 ≥ 3% 时算,负数单独说明", () => {
  const a = computeExcursion(input({}), bars(["2026-09-14", 10.5, 9.0], ["2026-09-15", 12, 9.5], ["2026-09-16", 11.8, 9.9], ["2026-09-17", 12.5, 10.6]))!;
  assert.deepEqual([a.mfe_pct, a.mae_pct, a.mfe_certain, a.mae_certain, a.give_back_pct, a.capture_rate, a.capture_note], [25, -10, 20, -5, 15.1, 0.396, null]);
  assert.deepEqual([a.bars, a.bars_inner, a.same_day, a.precision], [4, 2, false, "买卖日两头存疑,中间完整交易日可靠"]);
  assert.equal(a.certain_note, "中间完整交易日里确定浮亏过 -5.00%");

  // 中间几天从没跌破成本:确定差到过是正数,换一句话说
  const up = computeExcursion(input({}), bars(["2026-09-14", 10.5, 9.0], ["2026-09-15", 12, 10.1], ["2026-09-17", 12.5, 10.6]))!;
  assert.equal(up.mae_certain, 1);
  assert.equal(up.certain_note, "中间完整交易日里从未浮亏(最差时仍 +1.00%)");

  // 同日进出:上界;浮盈 2% < 3%,捕获率不算
  const t0 = computeExcursion(input({ buy: "2026-09-18", sell: "2026-09-18", realized_pct: -3 }), bars(["2026-09-18", 10.2, 9.7]))!;
  assert.deepEqual([t0.mfe_pct, t0.mae_pct, t0.mfe_certain, t0.same_day, t0.capture_rate, t0.give_back_pct], [2, -3, null, true, null, 5]);
  assert.match(t0.precision, /^上界\(同日进出/);
  // 相邻两日:没有完整的中间交易日
  const adj = computeExcursion(input({ sell: "2026-09-15" }), bars(["2026-09-14", 10.5, 9.8], ["2026-09-15", 10.6, 10]))!;
  assert.match(adj.precision, /相邻两日/);
  // 涨过 4% 最后亏 2%:捕获率 −0.5,比「没吃到」更差
  const neg = computeExcursion(input({ realized_pct: -2 }), bars(["2026-09-14", 10.4, 9.5], ["2026-09-17", 10.1, 9.7]))!;
  assert.deepEqual([neg.capture_rate, neg.capture_note], [-0.5, "这段涨过,但最后是亏损离场 —— 比「没吃到」更差的一档"]);
  // 涨过 10% 只拿了 2%:0.2 < 0.3
  const low = computeExcursion(input({ realized_pct: 2 }), bars(["2026-09-14", 11, 9.9], ["2026-09-17", 10.3, 10]))!;
  assert.deepEqual([low.capture_rate, low.capture_note], [0.2, "几乎没吃到这段行情"]);
  // 没行情 / 成本不对:算不了
  assert.equal(computeExcursion(input({}), []), null);
  assert.equal(computeExcursion(input({ cost: 0 }), bars(["2026-09-14", 10.5, 9.0])), null);

  // 汇总:中位数;赚钱收场但中途浮亏 ≥ 5% 算「扛出来的」,亏钱收场且浮盈 < 3% 算「进场就不对」
  const s = excursionSummary([a, t0, neg]);
  assert.deepEqual([s.trades, s.enough_samples, s.median_capture_rate, s.capture_samples, s.median_give_back, s.median_mae],
    [3, false, -0.052, 2, 6, -5]);
  assert.deepEqual([s.endured_count, s.bad_entry_count, s.same_day_count, s.lost_with_move_count], [1, 1, 1, 1]);
  assert.match(s.capture_note!, /1 笔捕获率是负数/);
  assert.deepEqual(s.items.map((x) => x.date), ["2026-09-18", "2026-09-14", "2026-09-14"]);

  // 能不能算:要卖光;期间送转、北交所不算
  assert.deepEqual(eligibility(row({ date: "2026-09-14", ep: { closed: false, last_sell: "2026-09-15", realized_pct: 1 } })), { ok: false, why: "not_closed" });
  assert.deepEqual(eligibility(row({ ep: null })), { ok: false, why: "not_closed" });
  assert.deepEqual(eligibility(row({ date: "2026-09-14", ep: { closed: true, last_sell: "2026-09-15", realized_pct: 1, has_split: true } })), { ok: false, why: "split" });
  assert.deepEqual(eligibility(row({ symbol: "830799", date: "2026-09-14", ep: { closed: true, last_sell: "2026-09-15", realized_pct: 1 } })), { ok: false, why: "bj" });
  const ok = eligibility(row({ symbol: "600519", date: "2026-09-14", ep: { closed: true, last_sell: "2026-09-15", realized_pct: 1, avg_cost: 12 } }));
  assert.ok(ok.ok && ok.input.cost === 12 && ok.input.sell === "2026-09-15");

  // 卖出那天 15:30(北京)以后取的才算定稿
  assert.equal(settledFetch("2026-09-15T07:29:59.999Z", "2026-09-15"), false);
  assert.equal(settledFetch("2026-09-15T07:30:00.000Z", "2026-09-15"), true);
});

/* ---------------- 整条链路:假取数器 ---------------- */

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
  if sym in cfg.get('fail',[]): done({'status':'failed','evidence':[],'errors':[{'source':'tencent','error':'HTTP 502'}]})
  if sym in cfg.get('hl',{}):
    rows=[{'date':d,'open':h,'high':h,'low':l,'close':l,'volume':1} for d,h,l in cfg['hl'][sym]]
  else:
    rows=[{'date':d,'open':1,'high':1,'low':1,'close':1000,'volume':1} for d in cfg.get('klines',[])]
  if not rows: done({'status':'failed','reason':'腾讯 K 线返回 0 根','evidence':[]})
  ref='raw/extracted_tencent_tencent_kline_%s_%d_%d.json'%(sym,n,len(rows))
  json.dump({'rows':rows},open(os.path.join(out,ref),'w'))
  done({'status':'ok','evidence':[{'field':'kline_points','value':len(rows),'raw_ref':ref}]})
if ep in ('cn_shortline_daily','cn_shortline_facts'):
  d=args.get('date','')
  v=cfg.get('daily' if ep=='cn_shortline_daily' else 'facts',{}).get(d)
  if v is None: done({'status':'failed','reason':'东财池为空','evidence':[]},3)
  evs=[{'field':k,'value':x,'raw_ref':'raw/x.json',**({'record_key':'1进2'} if k=='promotion_rate' else {})} for k,x in v.items()]
  done({'status':'ok','extra':{'settled':True},'evidence':evs})
done({'status':'failed','reason':'unknown','evidence':[]},3)
`;

interface Cfg { hl?: Record<string, [string, number, number][]>; fail?: string[]; klines?: string[]; daily?: Record<string, Record<string, number>>; facts?: Record<string, Record<string, number>> }
type Call = { ep: string; sym: string; args: Record<string, unknown> };

function fakeCtx(): ServiceContext & { setCfg(c: Cfg): void; calls(): Call[] } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "va-journal-fake-"));
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
const fill = (symbol: string, type: string, date: string, shares: number, price: number, extra: Record<string, unknown> = {}) => ({ symbol, type, date, shares, price, fee: 5, ...extra });

/**
 * 600519:1000 股 @10 买(09-14)、@11 卖(09-17),费 5+5 → 落袋 990 / 10000 = 9.9%;行情同纯计算用例 ⇒ 浮盈 25 / 浮亏 −10
 * 000001:同日 100 股 @10 买、@9.8 卖,费 5+5 → −30 / 1000 = −3%;当天最高 10.2 最低 9.7 ⇒ 浮盈 2 / 浮亏 −3
 * 600000 还没卖、300750 期间送转、830799 北交所、600036 行情取不到
 * 汇总:捕获率只有 600519 一笔 0.396;回吐中位 (15.1 + 5) / 2 = 10.05;浮亏中位 (−10 − 3) / 2 = −6.5
 */
test("最大浮盈浮亏视图:逐笔取不复权日 K(区间 = 买入到卖出),取到就缓存;没算的分类报;复查清单只读缓存", async () => {
  assert.ok(listViews().some((v) => v.id === "journal_excursion"));
  assert.ok(listViews().some((v) => v.id === "journal_attribution"));
  const ctx = fakeCtx();
  try {
    ctx.setCfg({
      hl: {
        "600519": [["2026-09-11", 99, 1], ["2026-09-14", 10.5, 9.0], ["2026-09-15", 12, 9.5], ["2026-09-16", 11.8, 9.9], ["2026-09-17", 12.5, 10.6], ["2026-09-18", 99, 1]],
        "000001": [["2026-09-18", 10.2, 9.7]],
      },
      fail: ["600036"],
    });
    ledgerInsertMany(ctx, { kind: "trade", records: [
      fill("600519", "buy", "2026-09-14", 1000, 10), fill("600519", "sell", "2026-09-17", 1000, 11),
      fill("000001", "buy", "2026-09-18", 100, 10), fill("000001", "sell", "2026-09-18", 100, 9.8),
      fill("600000", "buy", "2026-09-18", 100, 10),
      fill("300750", "buy", "2026-09-14", 100, 10), { symbol: "300750", type: "split", date: "2026-09-15", ratio: 2 }, fill("300750", "sell", "2026-09-17", 200, 5),
      fill("830799", "buy", "2026-09-14", 100, 10), fill("830799", "sell", "2026-09-15", 100, 11),
      fill("600036", "buy", "2026-09-14", 100, 30), fill("600036", "sell", "2026-09-16", 100, 31),
    ] });
    const r = await journalExcursion(ctx, {}, sig, NOW);
    assert.ok(r.available, JSON.stringify(r));
    if (!r.available) return;
    assert.deepEqual(r.counts, { not_closed: 1, split: 1, bj: 1, failed: 1 });
    assert.equal(r.scanned, 6);
    assert.deepEqual(r.failures.map((f) => [f.symbol, f.date]), [["600036", "2026-09-14"]]);
    assert.match(r.failures[0]!.why, /502/);
    assert.match(r.not_counted_note!, /1 笔还没卖光.*1 笔期间有送转.*1 笔是北交所.*1 笔行情没取到/);
    const by = Object.fromEntries(r.items.map((x) => [x.symbol, x]));
    assert.deepEqual([by["600519"]!.mfe_pct, by["600519"]!.mae_pct, by["600519"]!.realized_pct, by["600519"]!.capture_rate, by["600519"]!.bars], [25, -10, 9.9, 0.396, 4], "区间外的行不算");
    assert.deepEqual([by["000001"]!.mfe_pct, by["000001"]!.mae_pct, by["000001"]!.realized_pct, by["000001"]!.same_day], [2, -3, -3, true]);
    assert.deepEqual([r.trades, r.median_capture_rate, r.median_give_back, r.median_mae, r.endured_count, r.bad_entry_count], [2, 0.396, 10.05, -6.5, 1, 1]);
    assert.equal(r.cached, 0);
    const kl = ctx.calls().filter((c) => c.ep === "tx_kline");
    assert.deepEqual(kl.map((c) => c.sym).sort(), ["000001", "600036", "600519"]);
    assert.deepEqual(kl.find((c) => c.sym === "600519")!.args, { period: "day", adjust: "", start: "2026-09-14", end: "2026-09-17" });

    // 再开一次:取到的读缓存,没取到的重取
    const again = await journalExcursion(ctx, {}, sig, NOW);
    assert.ok(again.available && again.cached === 2);
    assert.deepEqual(ctx.calls().filter((c) => c.ep === "tx_kline").length, 4);

    // 复查清单:只读缓存,一次都不取;600036 没缓存 → 跳过并提示
    const before = ctx.calls().length;
    const v = await view(ctx);
    assert.equal(ctx.calls().length, before, "打开交易日志不发任何取数请求");
    assert.ok(v.inbox.available);
    if (!v.inbox.available) return;
    assert.equal(v.inbox.excursion_available, true);
    assert.equal(v.inbox.excursion_skipped, 1);
    const item = v.inbox.items.find((x) => x.symbol === "600519")!;
    assert.deepEqual(item.flags.map((f) => [f.key, f.text]), [["deep_mae", "中途最多浮亏 -10.0%(最后还是赚的)"]]);
  } finally { cleanup(ctx); }
});

/**
 * 卖出那天收盘前取的行情不算定稿:当时照样给数(标盘中),复查清单不用它;收盘后再打开重取一次。
 * (快照时间是真实时钟,所以用一个远在将来的卖出日来造「收盘前」)
 */
test("最大浮盈浮亏视图:卖出当天收盘前取的行情不定稿,收盘后重取;复查清单不用没定稿的", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ hl: { "600519": [["2099-01-05", 10.5, 9.8], ["2099-01-06", 11, 10]] } });
    ledgerInsertMany(ctx, { kind: "trade", records: [fill("600519", "buy", "2099-01-05", 1000, 10), fill("600519", "sell", "2099-01-06", 1000, 10.5)] });
    const kl = () => ctx.calls().filter((c) => c.ep === "tx_kline").length;
    const before = await journalExcursion(ctx, {}, sig, new Date("2099-01-06T03:00:00Z"));
    assert.ok(before.available);
    assert.match(before.intraday_note!, /1 笔是今天卖的、还没收盘/);
    assert.equal(kl(), 1);
    const same = await journalExcursion(ctx, {}, sig, new Date("2099-01-06T05:00:00Z"));
    assert.ok(same.available && same.cached === 1, "还没收盘:读缓存");
    assert.equal(kl(), 1);
    const v = (await journalView(ctx, {}, sig, new Date("2099-01-06T05:00:00Z"))) as Avail;
    assert.ok(v.inbox.available && v.inbox.excursion_skipped === 1 && !v.inbox.excursion_available, "复查清单不用盘中取的");
    const after = await journalExcursion(ctx, {}, sig, new Date("2099-01-06T08:00:00Z"));
    assert.ok(after.available);
    assert.equal(kl(), 2, "收盘后:重取");
  } finally { cleanup(ctx); }
});

/* ---------------- 判断 vs 执行归因 ---------------- */

test("归因:条件过半成立算判对、不到一半算判错,正好一半不算;按入场日对齐;当天逐笔累加后再四舍五入;盈亏为 0 的日子不进格", () => {
  const td = (date: string, decided: number, hit: number): TrackDay => ({ set_date: "prev", date, total: decided, decided, hit, excluded: 0 });
  const reads = readsOf([td("d1", 3, 2), td("d2", 3, 1), td("d3", 2, 1), td("d4", 0, 0)]);
  assert.deepEqual([...reads.entries()].map(([d, r]) => [d, r.verdict]), [["d1", "right"], ["d2", "wrong"], ["d3", "undecided"], ["d4", "undecided"]]);

  const R = (date: string, verdict: DayRead["verdict"]): [string, DayRead] => [date, { set_date: "x", decided: 3, hit: verdict === "right" ? 2 : 1, verdict }];
  const map = new Map([R("2026-09-01", "right"), R("2026-09-02", "wrong"), R("2026-09-03", "right"), R("2026-09-04", "undecided"), R("2026-09-05", "wrong")]);
  const rows = desc([
    row({ date: "2026-09-01", realized_pnl: 0.1 }), row({ date: "2026-09-01", realized_pnl: 0.2, as_planned: false }),
    row({ date: "2026-09-02", realized_pnl: 50 }),
    row({ date: "2026-09-03", realized_pnl: 10 }), row({ date: "2026-09-03", realized_pnl: -10 }),
    row({ date: "2026-09-04", realized_pnl: 5 }),
    row({ date: "2026-09-05", realized_pnl: -7 }),
    row({ date: "2026-09-06", realized_pnl: 1 }),
    row({ date: "2026-09-01", ep: null }), row({ date: "2026-09-01", ep: { realized_pnl: null } }), row({ date: "2026-09-06", ep: null }),
  ]);
  const a = computeAttribution(rows, map);
  assert.ok(a.available);
  if (!a.available) return;
  // 09-01:0.1 + 0.2 = 0.30000000000000004 → 0.3,判对赚钱;09-03 正好 0 不进格
  assert.deepEqual(a.quadrants, {
    right_win: { days: 1, pnl: 0.3, days_list: ["2026-09-01"] }, right_lose: { days: 0, pnl: 0, days_list: [] },
    wrong_win: { days: 1, pnl: 50, days_list: ["2026-09-02"] }, wrong_lose: { days: 1, pnl: -7, days_list: ["2026-09-05"] },
  });
  assert.deepEqual([a.days_counted, a.enough_samples, a.skipped_no_amount, a.skipped_no_read, a.skipped_undecided], [3, false, 3, 1, 1], "没金额又没读数的先算没金额(VA 顺序)");
  assert.deepEqual([a.cells.right_win[0]!.trades, a.cells.right_win[0]!.unplanned, a.cells.right_win[0]!.pnl], [2, 1, 0.3]);
  const none = computeAttribution(rows, new Map());
  assert.equal(none.available, false);
});

// 与「明日验证」测试同一套读数:09-29 晚判下降(实际上升,判错);10-08 晚三条判定了两条对(判对)
const K = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25",
  "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-08", "2026-10-09"];
const day = (lu: number, br = 0.2) => ({ limit_up_count: lu, ladder_highest: 5, broken_rate: br, money_effect_median_ret: 1.0, loss_deep5_count: 5, promotion_rate: 0.25 });
const at = (d: string, hm: string) => `${d}T${hm}:00.000+08:00`;

/**
 * 600519 09-30 入场(判错那天),+500 − 10 = 490 → 判错 + 赚钱
 * 000001 与 600036 都在 10-09 入场(判对那天):−200 − 10 = −210、+100 − 10 = 90,当天合计 −120 → 判对 + 亏钱(600036 计划外)
 * 600000 09-22 入场:那天没有条件 → 没读数;601318 还没卖 → 没金额
 */
test("归因视图:默认用最近一个交易日的条件对账;按入场日把有金额的交易归进四格", async () => {
  const ctx = fakeCtx();
  try {
    const daily: Record<string, Record<string, number>> = {};
    K.forEach((d, i) => { daily[d] = day(40 + i * 10); });
    daily["2026-10-09"] = day(60, 0.4);
    ctx.setCfg({ klines: K, daily, facts: { "2026-10-08": { theme_concentration: 0.2, limit_down_count: 3 }, "2026-10-09": { theme_concentration: 0.35, limit_down_count: 12 } } });
    const items = [
      { date: "2026-10-08", metric: "limit_up_count", direction: "up", updated_at: at("2026-10-08", "21:00") },
      { date: "2026-10-08", metric: "broken_rate", direction: "up", updated_at: at("2026-10-08", "21:00") },
      { date: "2026-10-08", metric: "theme_concentration", direction: "up", updated_at: at("2026-10-09", "08:59") },
      { date: "2026-10-08", metric: "highest_board", direction: "flat", updated_at: at("2026-10-09", "14:00") },
      { date: "2026-09-29", metric: "limit_up_count", direction: "down", updated_at: at("2026-09-29", "20:00") },
    ];
    fs.writeFileSync(path.join(ctx.dataRoot, "ledger", "verification.json"), JSON.stringify({ schema_version: 1, kind: "verification",
      records: items.map((r, i) => ({ id: `v${i}`, kind: "verification", created_at: r.updated_at, ...r })) }));
    const ids = ledgerInsertMany(ctx, { kind: "trade", records: [
      fill("600519", "buy", "2026-09-30", 1000, 10), fill("600519", "sell", "2026-10-08", 1000, 10.5),
      fill("000001", "buy", "2026-10-09", 1000, 10), fill("000001", "sell", "2026-10-09", 1000, 9.8),
      fill("600036", "buy", "2026-10-09", 100, 20), fill("600036", "sell", "2026-10-09", 100, 21),
      fill("600000", "buy", "2026-09-22", 100, 10), fill("600000", "sell", "2026-09-23", 100, 11),
      fill("601318", "buy", "2026-10-08", 100, 50),
    ] }).map((x) => x.id);
    await journalAct(ctx, { action: "tag", trade_id: ids[4], as_planned: false }, sig, NOW);

    const now = new Date("2026-10-10T08:00:00Z"); // 周六
    await assert.rejects(journalAttribution(ctx, { date: "2026-02-31" }, sig, now), (e: unknown) => e instanceof ServiceError && e.code === "bad_query");
    await assert.rejects(journalAttribution(ctx, { date: "2026-10-11" }, sig, now), (e: unknown) => e instanceof ServiceError && e.code === "bad_query");
    const r = await journalAttribution(ctx, {}, sig, now);
    assert.ok(r.available, JSON.stringify(r));
    if (!r.available) return;
    assert.deepEqual(r.window, { from: "2026-09-14", to: "2026-10-09" }, "周六打开:用最近一个交易日 10-09");
    assert.deepEqual(r.quadrants, {
      right_win: { days: 0, pnl: 0, days_list: [] }, right_lose: { days: 1, pnl: -120, days_list: ["2026-10-09"] },
      wrong_win: { days: 1, pnl: 490, days_list: ["2026-09-30"] }, wrong_lose: { days: 0, pnl: 0, days_list: [] },
    });
    const d = r.cells.right_lose[0]!;
    assert.deepEqual([d.trades, d.unplanned, d.set_date, d.decided, d.hit], [2, 1, "2026-10-08", 3, 2]);
    assert.deepEqual([r.skipped_no_amount, r.skipped_no_read, r.skipped_undecided], [1, 1, 0]);
  } finally { cleanup(ctx); }
});

test("归因视图:没有对完账的条件就不出四格", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ klines: K, daily: {} });
    const r = await journalAttribution(ctx, { date: "2026-10-09" }, sig, new Date("2026-10-10T08:00:00Z"));
    assert.equal(r.available, false);
    assert.match((r as { reason: string }).reason, /还没有对完账的验证条件/);
  } finally { cleanup(ctx); }
});
