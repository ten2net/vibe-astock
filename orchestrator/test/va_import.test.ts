import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register_tasks.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { ServiceError, ledgerList, ledgerRemove, ledgerUpsert, type ServiceContext } from "../src/service.ts";
import { runViewAction } from "../src/views.ts";
import { journalView } from "../src/finance/journal/view.ts";
import { B_SHARE_UNSUPPORTED } from "../src/finance/holdings.ts";
import { JOURNAL_ONLY_STOCKS } from "../src/finance/journal/episodes.ts";
import { loadDay } from "../src/finance/shortline/intraday.ts";
import { isLate, itemsByDate } from "../src/finance/shortline/verification.ts";
import { shortlineReview } from "../src/finance/shortline/review.ts";
import { htmlText, planImport, previewOf, resolveVaDir, runImport, snapshotOf, vaTime, type ImportPreview, type ImportResult } from "../src/finance/va_import.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** 旧版数据样本:交易日志、费率、风险规矩、账户规模、模式卡、自设条件由旧版自己的代码生成;复盘、快照、深挖照旧版格式手写 */
const FIXTURE = path.join(REPO, "orchestrator", "test", "fixtures", "va-import");
const NOW = new Date("2026-10-10T12:00:00+08:00");
const sig = new AbortController().signal;

function withRoot(fn: (ctx: ServiceContext, va: string) => Promise<void> | void) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vra-va-import-"));
    const va = path.join(tmp, "old");
    fs.cpSync(FIXTURE, va, { recursive: true });
    const dataRoot = path.join(tmp, "data");
    fs.mkdirSync(dataRoot);
    try { await fn({ repoRoot: REPO, dataRoot, python: "false", node: process.execPath }, va); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  };
}

const act = async (ctx: ServiceContext, body: Record<string, unknown>) => runViewAction(ctx, "va_import", body, sig);
const list = (ctx: ServiceContext, kind: string): LedgerRecord[] => ledgerList(ctx, kind)[kind] ?? [];
const grp = (p: ImportPreview, key: string) => p.groups.find((g) => g.key === key)!;
const reasons = (p: ImportPreview, key: string) => grp(p, key).skipped.map((s) => s.why);

function hashTree(dir: string): string {
  const h = crypto.createHash("sha256");
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      h.update(path.relative(dir, p));
      if (e.isDirectory()) walk(p); else h.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

test("vaTime / htmlText:旧版时间换成北京时间 ISO;HTML 片段换成纯文字", () => {
  assert.equal(vaTime("2026-09-08 21:50 CST"), "2026-09-08T21:50:00.000+08:00");
  assert.equal(vaTime("2026-09-08 07:05:09 CST"), "2026-09-08T07:05:09.000+08:00");
  assert.equal(vaTime("2026-07-24 13:06"), "2026-07-24T13:06:00.000+08:00");
  for (const bad of ["", "2026-02-30 10:00", "2026-09-08 24:00", "2026-09-08", null, 5]) assert.equal(vaTime(bad), "", String(bad));
  assert.equal(htmlText("<p><strong>情绪</strong>早一版&amp;草稿</p><ul><li>第一点</li></ul>"), "情绪早一版&草稿\n- 第一点");
  assert.equal(htmlText("<p>题材<br>电力</p>"), "题材\n电力");
  assert.equal(htmlText(undefined), "");
});

test("目录:只认绝对路径、存在、有旧版数据的文件夹;不能是新版自己的数据目录", withRoot((ctx, va) => {
  assert.equal(resolveVaDir(ctx, va), fs.realpathSync(va));
  const bad = (code: string, re: RegExp) => (e: unknown) => e instanceof ServiceError && e.code === code && re.test(e.message);
  assert.throws(() => resolveVaDir(ctx, "old"), bad("bad_request", /完整路径/));
  assert.throws(() => resolveVaDir(ctx, path.join(va, "nope")), bad("not_found", /找不到/));
  assert.throws(() => resolveVaDir(ctx, path.join(va, "journal", "trades.json")), bad("bad_request", /不是文件夹/));
  assert.throws(() => resolveVaDir(ctx, ctx.dataRoot), bad("bad_request", /新版自己的数据目录/));
  // 新版数据目录在旧目录里面 / 旧目录在新版数据目录里面,都不行
  const inner = path.join(ctx.dataRoot, "x");
  fs.cpSync(va, inner, { recursive: true });
  assert.throws(() => resolveVaDir(ctx, inner), bad("bad_request", /新版自己的数据目录/));
  assert.throws(() => resolveVaDir({ dataRoot: path.join(va, "journal") }, va), bad("bad_request", /新版自己的数据目录/));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "vra-va-empty-"));
  try { assert.throws(() => resolveVaDir(ctx, empty), bad("bad_request", /没有旧版数据/)); } finally { fs.rmSync(empty, { recursive: true }); }
}));

test("预览:逐类列出能导的、已导过的、跳过的和原因;不写任何东西", withRoot(async (ctx, va) => {
  const before = hashTree(va);
  const p = await act(ctx, { action: "preview", dir: va }) as ImportPreview;
  assert.deepEqual(p.groups.map((g) => [g.key, g.found, g.add, g.already, g.skipped.length]), [
    ["journal", 4, 4, 0, 0],
    ["settings", 3, 1, 0, 0],
    ["modes", 1, 1, 0, 0],
    ["reviews", 4, 3, 0, 1],
    ["verification", 3, 3, 0, 1],
    ["intraday", 6, 2, 0, 4],
    ["deepdive", 3, 1, 1, 1],
  ]);
  assert.equal(p.total, 15);
  assert.deepEqual(p.warnings, []);
  assert.match(reasons(p, "reviews")[0]!, /不是旧版的日复盘/);
  assert.match(reasons(p, "verification")[0]!, /1 条读数或方向新版不认识/);
  assert.deepEqual(grp(p, "intraday").skipped.map((s) => s.what).sort(), ["2026-09-08 09:20", "2026-09-08 09:35", "2026-09-08 14:00", "2026-09-08 15:00"]);
  assert.match(reasons(p, "deepdive")[0]!, /没有正文/);
  assert.deepEqual(p.not_imported.map((x) => [x.label, x.count]), [["方向命中评估", 1], ["每天的涨停池存档", 1], ["取数缓存", 1], ["被拒的复盘", 1]]);
  assert.ok(grp(p, "journal").notes.some((n) => /我的股票/.test(n)));
  // 只读:新版数据目录里什么都没有,旧目录一个字节没变
  assert.deepEqual(fs.readdirSync(ctx.dataRoot), []);
  assert.equal(hashTree(va), before);
  await assert.rejects(act(ctx, { action: "nope", dir: va }), (e: unknown) => e instanceof ServiceError && e.code === "bad_request");
}));

test("导入:写进新版各处、先备份;交易日志按轮拆开、标注挂在每轮第一笔;再导一次什么都不写", withRoot(async (ctx, va) => {
  ledgerUpsert(ctx, { kind: "note", record: { title: "已有的笔记", body: "x", category: "review" } });
  const before = hashTree(va);
  const r = await act(ctx, { action: "import", dir: va }) as ImportResult;
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.written, { trade: 9, journal_tag: 6, journal_settings: 1, mode_card: 1, shortline_review: 3, verification: 3, note: 1, intraday: 2 });
  assert.equal(hashTree(va), before, "旧目录不能动");

  // 备份:只备份导入前已经有的台账文件,README 说清怎么恢复
  assert.match(r.backup!, /^ledger\/旧版导入备份-\d{4}-\d{2}-\d{2}/);
  const bdir = path.join(ctx.dataRoot, r.backup!);
  assert.deepEqual(fs.readdirSync(bdir).sort(), ["README.md", "note.json"]);
  const readme = fs.readFileSync(path.join(bdir, "README.md"), "utf8");
  assert.match(readme, /导入前还没有:trade\.json/);
  assert.match(readme, /新建了 2 个快照文件/);
  assert.match(readme, /旧版的数据目录没有动过/);

  // 交易:每笔成交一条流水,带来源;费用只有旧版填了实际费用的才带
  const trades = list(ctx, "trade");
  assert.ok(trades.every((t) => /^va:journal:[0-9a-f]{12}:\d+$/.test(String(t.migrated_from)) && t.note === "从旧版交易日志导入"));
  assert.deepEqual(trades.filter((t) => t.fee !== undefined).map((t) => [t.symbol, t.fee]), [["300750", 5], ["300750", 6.2]]);
  // 同日做 T 保持旧版的录入先后(买卖买卖),不被排成买买卖卖
  assert.deepEqual(trades.filter((t) => t.symbol === "002463").map((t) => t.type), ["buy", "sell", "buy", "sell"]);

  const v = await journalView(ctx, {}, sig, NOW);
  assert.ok(v.available);
  if (!v.available) return;
  assert.deepEqual(v.issues, []);
  assert.deepEqual(v.orphans, []);
  assert.deepEqual(v.conflicts, []);
  const rows = v.rows.map((x) => [x.symbol, x.kind, x.date, x.playbook, x.as_planned, x.planned_stop, x.planned_target, x.plan_late]).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[2]).localeCompare(String(b[2])));
  assert.deepEqual(rows, [
    ["000001", "manual", "2026-09-02", "低吸", false, null, null, false],
    ["002463", "episode", "2026-09-08", "半路", null, null, null, false],
    ["002463", "episode", "2026-09-08", "半路", null, null, null, false],
    // 第一轮带计划止损目标;止损是后来改过的(旧版留了改动时间)→ 标「事后写的」;第二轮不带
    ["300750", "episode", "2026-09-02", "接力", null, null, null, false],
    ["600519", "episode", "2026-09-01", "打板", true, 9.6, 12, true],
    ["600519", "episode", "2026-09-07", "打板", true, null, null, false],
  ]);
  assert.equal(v.rows.find((x) => x.symbol === "000001")!.pnl_pct, 3.5);
  // 设置:费率、风险规矩、账户规模
  assert.equal(v.settings.fees!.commission_rate, 0.0002);
  assert.equal(v.settings.rules.max_loss_per_trade_pct, 4);
  assert.equal(v.settings.rules.max_positions, 2);
  assert.equal(v.settings.equity_base, 200000);
  // 模式卡:两个版本原样带过来,老版本的打法不被新值覆盖
  const card = list(ctx, "mode_card")[0]!;
  assert.deepEqual((card.versions as Record<string, unknown>[]).map((x) => [x.version, x.playbook, x.exit]), [[1, "打板", "次日不及预期走"], [2, "接力", "次日冲高走"]]);

  // 盘中快照:新版自己读得回来(和当场存的同一套检查)
  const day = loadDay(ctx.dataRoot, "2026-09-08");
  assert.deepEqual(day.warnings, []);
  assert.deepEqual(day.snapshots.map((s) => s.slot), ["09:25", "10:00"]);
  const [s925, s1000] = day.snapshots;
  assert.equal(s925!.basis, "open");
  assert.equal(s925!.cohort.coverage_rate, 0.889);
  assert.deepEqual(s925!.live, { limit_up: 40, broken: 10, limit_down: 3, highest_board: 6, consec_count: null, seal_rate: 0.8, broken_rate: 0.2, promotion_1to2: null, promotion_all: null });
  assert.equal(s1000!.cohort.expected, 100);
  assert.equal(s1000!.live, null);
  assert.match(s1000!.live_reason!, /旧版这个时点没取到/);
  assert.ok(s1000!.gaps.some((g) => /没记价格口径/.test(g)));

  // 深挖 → 研究记录
  const notes = list(ctx, "note").filter((n) => n.migrated_from);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.category, "debate");
  assert.match(String(notes[0]!.title), /测试甲\(600519\)个股深挖 · 2026-09-07\(旧版导入\)/);
  assert.match(String(notes[0]!.body), /### 正方\n\n【参与派论证】有弹性/);
  assert.match(String(notes[0]!.body), /### 反方\n\n风险大/);

  // 再导一次:什么都不写、也不再备份
  const again = await act(ctx, { action: "import", dir: va }) as ImportResult;
  assert.equal(again.total, 0);
  assert.equal(again.backup, null);
  assert.deepEqual(again.written, {});
  assert.deepEqual(again.groups.map((g) => g.already), [4, 0, 1, 3, 3, 2, 2]);
  assert.equal(list(ctx, "trade").length, 9);
}));

test("复盘:每份一版、标「旧版导入」;同一晚按写完时刻排新在前;证据编号带上、没有的列出来", withRoot(async (ctx, va) => {
  runImport(ctx, va, NOW);
  const r = await shortlineReview(ctx, { date: "2026-09-07" }, sig) as unknown as { versions: Record<string, unknown>[] };
  assert.deepEqual(r.versions.map((x) => [x.finished_at, x.imported, x.settled]), [
    ["2026-09-08T21:50:00.000+08:00", true, true],
    ["2026-09-07T15:40:00.000+08:00", true, true],
  ]);
  const latest = r.versions[0]!;
  const secs = latest.sections as Record<string, unknown>[];
  const sentiment = secs.find((s) => s.id === "sentiment")!;
  assert.equal(sentiment.status, "done");
  assert.equal(sentiment.text, "涨停家数扩大 [ev-0a1b2c3d4e5f60718293]\n\n1进2 回暖 [ev-1b2c3d4e5f6071829304, ev-ffff00001111222233334]");
  assert.deepEqual(sentiment.cited, [
    { id: "ev-0a1b2c3d4e5f60718293", line: "盘口统计:[真实数据 2026-09-07] 涨停 93 家" },
    { id: "ev-1b2c3d4e5f6071829304", line: "晋级:1进2 0.3" },
  ]);
  assert.deepEqual(sentiment.unknown_cites, ["ev-ffff00001111222233334"]);
  assert.equal(sentiment.evidence_count, 2);
  // 证据表里这一段没有发现 → 用旧版的分析原文
  assert.equal(secs.find((s) => s.id === "capital")!.text, "资金面旧文");
  const summary = secs.find((s) => s.id === "summary")!;
  assert.match(String(summary.text), /^情绪阶段:发酵\n一句话:涨停家数扩大\(核对过\) \[ev-0a1b2c3d4e5f60718293\]\n关注方向:\n- 元件:涨停家数靠前 \[ev-0a1b2c3d4e5f60718293\] 风险:都停在首板\n风险提示:\n- 宽度没取到$/);
  assert.equal(latest.ai, "旧版导入(claude · default)");
  assert.deepEqual(latest.gaps, ["从旧版导入:原文照搬,数字和证据编号没有按新版规则重新核对", "全市场跌停家数没取到"]);
  assert.deepEqual(latest.conditions, []);
  assert.match(String(latest.conditions_note), /明日验证条件已经导进「明日验证」/);
  assert.match(String(r.versions[1]!.conditions_note), /较早写的一版.*没有导入/);
  // 早一版没有证据表:没有的段落标跳过
  const early = r.versions[1]!.sections as Record<string, unknown>[];
  assert.deepEqual(early.map((s) => s.status), ["done", "skipped", "skipped", "skipped", "skipped", "done"]);

  // 7 月的早期格式:盘中写的(14:20,没说收盘)→ 不算收盘后;多空辩论是进攻派 / 退潮派
  // 导入之后才存进来、但写完得更早的一版(比如新版自己补跑的):按写完时刻排,不按存进来的先后
  const src = list(ctx, "shortline_review").find((x) => x.finished_at === "2026-09-08T21:50:00.000+08:00")!;
  const { id: _i, kind: _k, created_at: _c, updated_at: _u, migrated_from: _m, ...rest } = src;
  ledgerUpsert(ctx, { kind: "shortline_review", record: { ...rest, finished_at: "2026-09-07T16:00:00.000+08:00" } });
  const again = await shortlineReview(ctx, { date: "2026-09-07" }, sig) as unknown as { versions: Record<string, unknown>[] };
  assert.deepEqual(again.versions.map((x) => [x.finished_at, x.imported]), [
    ["2026-09-08T21:50:00.000+08:00", true], ["2026-09-07T16:00:00.000+08:00", false], ["2026-09-07T15:40:00.000+08:00", true],
  ]);

  const jul = await shortlineReview(ctx, { date: "2026-07-22" }, sig) as unknown as { versions: Record<string, unknown>[] };
  assert.equal(jul.versions.length, 1);
  assert.equal(jul.versions[0]!.settled, false);
  const js = (jul.versions[0]!.sections as Record<string, unknown>[]).find((s) => s.id === "summary")!;
  assert.equal(js.text, "情绪阶段:退潮\n一句话:情绪退潮初期\n多空辩论结论:进攻派认为还有局部机会\n进攻派:局部机会在电力\n退潮派:退潮派认为见顶");
  assert.equal((jul.versions[0]!.sections as Record<string, unknown>[]).find((s) => s.id === "theme")!.text, "题材\n电力");
}));

test("明日验证:最后一版复盘的条件 + 自己写的(同一读数以自己写的为准);写下时刻按旧版的,事后的照样标事后", withRoot(async (ctx, va) => {
  runImport(ctx, va, NOW);
  const recs = list(ctx, "verification");
  assert.deepEqual(recs.map((r) => [r.date, r.metric, r.direction, r.reason ?? "", r.written_at ?? ""]).sort(), [
    ["2026-09-07", "broken_rate", "up", "", ""],
    ["2026-09-07", "highest_board", "up", "高度打开", "2026-09-08T21:50:00.000+08:00"],
    ["2026-09-07", "limit_up_count", "down", "我觉得会降", ""],
  ]);
  const items = itemsByDate(recs).byDate.get("2026-09-07")!;
  const hb = items.find((i) => i.metric === "highest_board")!;
  assert.equal(hb.written_at, "2026-09-08T21:50:00.000+08:00");
  // 旧版复盘 09-08 21:50 才写完,早过了 09-08 09:15 → 事后;写在 09:15 前的不算事后
  assert.equal(isLate(hb, "2026-09-08"), true);
  assert.equal(isLate({ ...hb, written_at: "2026-09-08T09:10:00.000+08:00" }, "2026-09-08"), false);
  // 自己写的没记时间 → 按导入时刻算,也是事后
  assert.equal(isLate(items.find((i) => i.metric === "limit_up_count")!, "2026-09-08"), true);
  // 导入后又改过的条件,写下时刻按改的那一刻(旧版的时间不再算数)
  const edited = ledgerUpsert(ctx, { kind: "verification", record: { ...recs.find((r) => r.metric === "highest_board")!, reason: "改过" } });
  const ei = itemsByDate([edited]).byDate.get("2026-09-07")![0]!;
  assert.equal(ei.written_at, undefined);
  assert.equal(ei.updated_at, edited.updated_at);
  // 不是导入来的,带了 written_at 也不认;写下时间比录入还晚的也不认
  const own = { ...edited, migrated_from: undefined, updated_at: edited.created_at };
  assert.equal(itemsByDate([own as LedgerRecord]).byDate.get("2026-09-07")![0]!.written_at, undefined);
  const future = { ...edited, updated_at: edited.created_at, written_at: "2099-01-01T00:00:00.000+08:00" };
  assert.equal(itemsByDate([future as LedgerRecord]).byDate.get("2026-09-07")![0]!.written_at, undefined);
  const orig = { ...edited, updated_at: edited.created_at };
  assert.equal(itemsByDate([orig as LedgerRecord]).byDate.get("2026-09-07")![0]!.written_at, "2026-09-08T21:50:00.000+08:00");
}));

test("中途断掉 / 删过:标注没写进去的再导会补上;成交只剩一部分的不再导、说原因", withRoot(async (ctx, va) => {
  runImport(ctx, va, NOW);
  // 删掉两条标注 → 再导只补标注,成交不重复
  const tags = list(ctx, "journal_tag");
  for (const t of tags.filter((x) => x.symbol === "600519")) ledgerRemove(ctx, { kind: "journal_tag", id: t.id });
  const p = previewOf(planImport(ctx, resolveVaDir(ctx, va), NOW));
  assert.deepEqual([grp(p, "journal").add, grp(p, "journal").already], [1, 3]);
  assert.ok(grp(p, "journal").notes.some((n) => /只补上标注/.test(n)));
  const r = runImport(ctx, resolveVaDir(ctx, va), NOW);
  assert.deepEqual(r.written, { journal_tag: 2 });
  assert.equal(list(ctx, "trade").length, 9);
  const v = await journalView(ctx, {}, sig, NOW);
  assert.ok(v.available && v.orphans.length === 0 && v.conflicts.length === 0);
  // 删掉 002463 的一笔成交 → 这条不再导,说明原因
  const one = list(ctx, "trade").find((t) => t.symbol === "002463")!;
  ledgerRemove(ctx, { kind: "trade", id: one.id });
  const p2 = previewOf(planImport(ctx, resolveVaDir(ctx, va), NOW));
  assert.equal(grp(p2, "journal").add, 0);
  assert.match(reasons(p2, "journal")[0]!, /4 笔成交只有 3 笔还在/);
}));

test("不覆盖新版已有的:设置已存在不动;同一晚同一读数自己写过的不导;快照时点已有的跳过", withRoot(async (ctx, va) => {
  ledgerUpsert(ctx, { kind: "journal_settings", record: { commission_rate: 0.0001 } });
  ledgerUpsert(ctx, { kind: "verification", record: { date: "2026-09-07", metric: "highest_board", direction: "down" } });
  const dest = path.join(ctx.dataRoot, "shortline", "intraday", "2026-09-08");
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "0925.json"), "{}");
  const p = previewOf(planImport(ctx, resolveVaDir(ctx, va), NOW));
  assert.equal(grp(p, "settings").add, 0);
  assert.match(reasons(p, "settings").join(), /已经有交易日志设置,没覆盖/);
  assert.equal(grp(p, "verification").add, 2);
  assert.match(reasons(p, "verification").join(), /已经有这个读数的条件,没覆盖/);
  assert.deepEqual([grp(p, "intraday").add, grp(p, "intraday").already], [1, 1]);
  const r = runImport(ctx, resolveVaDir(ctx, va), NOW);
  assert.equal(fs.readFileSync(path.join(dest, "0925.json"), "utf8"), "{}");
  assert.equal(list(ctx, "journal_settings").length, 1);
  assert.equal(list(ctx, "journal_settings")[0]!.commission_rate, 0.0001);
  // 备份只备份这次要写的:条件写了 → 备份里有导入前的;设置没写 → 不备份
  assert.ok(fs.existsSync(path.join(ctx.dataRoot, r.backup!, "verification.json")));
  assert.ok(!fs.existsSync(path.join(ctx.dataRoot, r.backup!, "journal_settings.json")));
}));

test("坏文件:读不出 / 符号链接 / 卖超 都跳过并说明,不影响其余", withRoot(async (ctx, va) => {
  fs.writeFileSync(path.join(va, "modes", "cards.json"), "{坏的");
  fs.rmSync(path.join(va, "deepdive", "600519.json"));
  fs.rmSync(path.join(va, "deepdive", "versions"), { recursive: true });
  fs.symlinkSync(path.join(FIXTURE, "deepdive", "600519.json"), path.join(va, "deepdive", "600519.json"));
  const env = JSON.parse(fs.readFileSync(path.join(va, "journal", "trades.json"), "utf8"));
  env.trades.push({ id: "badbadbad001", code: "600000", date: "2026-09-01", fills: [{ side: "sell", date: "2026-09-01", price: 10, shares: 100 }] });
  env.trades.push({ id: "badbadbad002", code: "60000", date: "2026-09-01", fills: [] });
  env.trades.push({ id: "badbadbad003", code: "600000", date: "2026-09-01", fills: [{ side: "buy", date: "2026-09-01", price: -1, shares: 100 }] });
  env.trades.push({ id: "badbadbad004", code: "900901", date: "2026-09-01", fills: [{ side: "buy", date: "2026-09-01", price: 1, shares: 100 }] });
  env.trades.push({ id: "badbadbad005", code: "510300", date: "2026-09-01", fills: [{ side: "buy", date: "2026-09-01", price: 4, shares: 1000 }] });
  fs.writeFileSync(path.join(va, "journal", "trades.json"), JSON.stringify(env));
  const p = previewOf(planImport(ctx, resolveVaDir(ctx, va), NOW));
  assert.match(reasons(p, "modes")[0]!, /不是有效的 JSON/);
  assert.match(reasons(p, "deepdive").join(), /符号链接/);
  assert.deepEqual(reasons(p, "journal").map((w) => w.slice(0, 16)), ["成交明细里卖出超过了持有(旧版也", "代码不是 6 位数字", "第 1 笔价格或股数不对", B_SHARE_UNSUPPORTED.slice(0, 16), JOURNAL_ONLY_STOCKS.slice(0, 16)]);
  assert.equal(grp(p, "journal").add, 4);
  assert.deepEqual(p.warnings, []);
}));

test("文件夹是符号链接 / 读不了:整组不读并说明(不只查最后那个文件);同一分钟的两个深挖版本都导", withRoot(async (ctx, va) => {
  const outside = path.join(path.dirname(va), "outside");
  fs.mkdirSync(outside);
  // journal/ 整个指向目录外:trades.json 自己是普通文件,原来照样会读
  fs.renameSync(path.join(va, "journal"), path.join(outside, "journal"));
  fs.symlinkSync(path.join(outside, "journal"), path.join(va, "journal"));
  fs.renameSync(path.join(va, "reviews", "_versions"), path.join(outside, "_versions"));
  fs.symlinkSync(path.join(outside, "_versions"), path.join(va, "reviews", "_versions"));
  // 深挖:同一只、同一分钟的两个不同版本(各有 job_id)
  const base = JSON.parse(fs.readFileSync(path.join(va, "deepdive", "600519.json"), "utf8"));
  fs.rmSync(path.join(va, "deepdive", "versions"), { recursive: true });
  fs.mkdirSync(path.join(va, "deepdive", "versions"));
  const j1 = "a".repeat(32), j2 = "b".repeat(32);
  fs.writeFileSync(path.join(va, "deepdive", "versions", `${j1}.json`), JSON.stringify({ ...base, job_id: j1, verdict_md: "# 第一版\n\n- 甲" }));
  fs.writeFileSync(path.join(va, "deepdive", "versions", `${j2}.json`), JSON.stringify({ ...base, job_id: j2, verdict_md: "# 第二版\n\n- 乙" }));
  fs.writeFileSync(path.join(va, "deepdive", "600519.json"), JSON.stringify({ ...base, job_id: j2, verdict_md: "# 第二版\n\n- 乙" }));
  fs.chmodSync(path.join(va, "intraday"), 0o000);
  try {
    const p = previewOf(planImport(ctx, resolveVaDir(ctx, va), NOW));
    assert.equal(grp(p, "journal").add, 0);
    assert.match(reasons(p, "journal").join(), /所在文件夹是符号链接/);
    assert.match(reasons(p, "settings").join(), /所在文件夹是符号链接/, "journal/fees.json 也不读");
    assert.ok(grp(p, "reviews").skipped.some((x) => x.what === "reviews/_versions/" && /符号链接/.test(x.why)), JSON.stringify(grp(p, "reviews").skipped));
    assert.ok(grp(p, "intraday").skipped.some((x) => x.what === "intraday/" && /读不了\(EACCES\)/.test(x.why)), JSON.stringify(grp(p, "intraday").skipped));
    assert.deepEqual([grp(p, "deepdive").add, grp(p, "deepdive").already], [2, 1], "两个版本各导一份;当前那份和第二版内容相同,算一份");
    runImport(ctx, resolveVaDir(ctx, va), NOW);
    const again = previewOf(planImport(ctx, resolveVaDir(ctx, va), NOW));
    assert.deepEqual([grp(again, "deepdive").add, grp(again, "deepdive").already], [0, 3]);
  } finally { fs.chmodSync(path.join(va, "intraday"), 0o755); }
}));

test("预演:旧版各条记录各算各的,新版同一只票的流水合在一起算 —— 合起来对不上的,导入前先列出来", withRoot(async (ctx, va) => {
  const env = JSON.parse(fs.readFileSync(path.join(va, "journal", "trades.json"), "utf8"));
  // 两条旧记录时间交叠:新版合成一轮,两条标注抢同一轮
  env.trades.push({ id: "overlap00001", code: "600036", date: "2026-09-01", playbook: "低吸", created_at: "2026-09-01 15:00:00 CST", fills: [{ side: "buy", date: "2026-09-01", price: 10, shares: 100 }, { side: "sell", date: "2026-09-05", price: 11, shares: 100 }] });
  env.trades.push({ id: "overlap00002", code: "600036", date: "2026-09-03", playbook: "打板", created_at: "2026-09-03 15:00:00 CST", fills: [{ side: "buy", date: "2026-09-03", price: 10, shares: 100 }, { side: "sell", date: "2026-09-04", price: 11, shares: 100 }] });
  fs.writeFileSync(path.join(va, "journal", "trades.json"), JSON.stringify(env));
  // 新版里已经记过、带标注的一轮:导入的流水和它合成一轮 → 已记的标注会被顶掉
  const mine = ledgerUpsert(ctx, { kind: "trade", record: { symbol: "300750", type: "buy", date: "2026-09-03", shares: 100, price: 200 } });
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "300750", type: "sell", date: "2026-09-05", shares: 100, price: 210 } });
  ledgerUpsert(ctx, { kind: "journal_tag", record: { symbol: "300750", trade_id: mine.id, playbook: "打板" } });
  const p = previewOf(planImport(ctx, resolveVaDir(ctx, va), NOW));
  assert.ok(p.warnings.some((w) => /^导入的 600036 的标注:同一笔交易有多条标注/.test(w)), p.warnings.join("\n"));
  assert.ok(p.warnings.includes("已记的 300750 的标注会被导入的标注顶掉(同一笔交易只认最后修改的那条)"), p.warnings.join("\n"));
  assert.ok(!p.warnings.some((w) => /算不了/.test(w)), p.warnings.join("\n"));
  // 预演不写东西
  assert.equal(list(ctx, "trade").length, 2);
  assert.equal(list(ctx, "journal_tag").length, 1);
}));

test("预演:新版里已经手记过同一笔成交(同代码、同一天、同方向、同价同量),导入前提醒可能记重", withRoot(async (ctx, va) => {
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "600519", type: "buy", date: "2026-09-01", shares: 100, price: 10, fee: 5 } }); // 费用不比
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "300750", type: "buy", date: "2026-09-02", shares: 100, price: 200.01 } }); // 价不同
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "002463", type: "buy", date: "2026-09-08", shares: 200, price: 20 } }); // 量不同
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "300750", type: "sell", date: "2026-09-02", shares: 100, price: 200 } }); // 方向不同
  const dup = (p: { warnings: string[] }) => p.warnings.filter((w) => w.includes("和已记的一笔同价同量"));
  const p = previewOf(planImport(ctx, resolveVaDir(ctx, va), NOW));
  assert.deepEqual(dup(p), ["导入的 600519 2026-09-01 那笔买入和已记的一笔同价同量,一模一样;如果是同一笔就记重了,导入后到「我的股票」的交易流水删掉多的那笔"]);
  // 导完再预览:导过的按来源跳过,不再拿自己导进去的那笔当重复
  runImport(ctx, resolveVaDir(ctx, va), NOW);
  assert.deepEqual(dup(previewOf(planImport(ctx, resolveVaDir(ctx, va), NOW))), []);
}));

test("snapshotOf:只收旧版 schema 3、时点和日期对得上、09:25 必须证明是开盘价", () => {
  const base = JSON.parse(fs.readFileSync(path.join(FIXTURE, "intraday", "2026-09-08", "0925.json"), "utf8"));
  assert.equal(typeof snapshotOf(base, "2026-09-08", "09:25"), "object");
  assert.match(String(snapshotOf(base, "2026-09-09", "09:25")), /对不上/);
  assert.match(String(snapshotOf({ ...base, schema: 2 }, "2026-09-08", "09:25")), /早期格式/);
  const { basis_key: _drop, ...noBasis } = base;
  assert.match(String(snapshotOf(noBasis, "2026-09-08", "09:25")), /没记是不是按开盘价/);
  assert.equal(typeof snapshotOf({ ...noBasis, price_basis: "当日开盘价 / 昨收" }, "2026-09-08", "09:25"), "object");
  assert.match(String(snapshotOf({ ...base, captured_at: "2026-09-08 09:31:00 CST" }, "2026-09-08", "09:25")), /有效窗口/);
  assert.match(String(snapshotOf({ ...base, expected_sample: null, coverage_rate: null }, "2026-09-08", "09:25")), /应有样本数/);
  assert.match(String(snapshotOf({ ...base, sample: 0 }, "2026-09-08", "09:25")), /样本数/);
  // 覆盖率按「样本 / 应有」现算(旧版的覆盖率字段缺了也一样);只有覆盖率没有应有数时反推应有数
  const noCov = snapshotOf({ ...base, coverage_rate: undefined }, "2026-09-08", "09:25");
  assert.ok(typeof noCov === "object" && noCov.cohort.coverage_rate === 0.889 && noCov.cohort.expected === 90);
  const noExp = snapshotOf({ ...base, expected_sample: undefined, coverage_rate: 0.5 }, "2026-09-08", "09:25");
  assert.ok(typeof noExp === "object" && noExp.cohort.coverage_rate === 0.5 && noExp.cohort.expected === 160);
  assert.match(String(snapshotOf({ ...base, median: null }, "2026-09-08", "09:25")), /缺读数/);
  const s = snapshotOf({ ...base, live: { limit_up: 0, broken: 0, limit_down: 0, highest_board: 0 } }, "2026-09-08", "09:25");
  assert.ok(typeof s === "object" && s.live!.seal_rate === null && s.live!.broken_rate === null);
});
