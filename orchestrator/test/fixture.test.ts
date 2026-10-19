import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  FIXTURE_MANIFEST, FixtureError, assertSafeRel, createFixture, fixtureFreshness, listFiles,
  readFixture, seedRunDir, shanghaiDay, treeHash, verifyFixture,
} from "../src/fixture.ts";
import { checkFixture, seedFixtureInto } from "../src/orchestrate.ts";
import { manifestSchema, validateWith } from "../src/schemas.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
const SEEDED = ["profile", "financials", "estimates", "valuation"];
const FP = { registry_version: "1.0.0", endpoint_scope: "full", calc_version: "0.3.2", repo_version: "abc123" };

/** 造一个"跑完六阶段"的运行目录(合成数据) */
function mkRun(startedAt = "2026-08-24T09:00:00+08:00", fp = FP): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-run-"));
  for (const sub of ["fetch", "raw", "calcs", "stages"]) fs.mkdirSync(path.join(d, sub));
  fs.writeFileSync(path.join(d, "fetch", "_ledger.json"), JSON.stringify({ fetch_profile: { script: "fetch_profile", status: "ok" } }));
  fs.writeFileSync(path.join(d, "fetch", "fetch_profile.json"), JSON.stringify({ evidence: [{ id: "ev-aa11aa11aa11" }] }));
  fs.writeFileSync(path.join(d, "raw", "r1.json"), "{}");
  fs.writeFileSync(path.join(d, "calcs", "c1.json"), "{}");
  for (const s of [...SEEDED, "risk", "report"]) fs.writeFileSync(path.join(d, "stages", `${s}.json`), JSON.stringify({ stage: s, summary: s }));
  fs.writeFileSync(path.join(d, "report.md"), "# 报告");        // 终态产物,不该进夹具
  fs.writeFileSync(path.join(d, "manifest.json"), JSON.stringify({ started_at: startedAt, symbol: "000001", market: "SZ", run_id: "r-1", ...fp }));
  return d;
}

const mkFixture = (runDir: string) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "vra-fx-"));
  const m = createFixture(runDir, out, { stages: SEEDED, symbol: "000001", market: "SZ", runId: "r-1" });
  return { out, m };
};

test("createFixture:只收前几阶段的中间产物,不收终态产物,也不收 risk / report 的阶段 JSON", () => {
  const { out, m } = mkFixture(mkRun());
  assert.deepEqual(Object.keys(m.files).sort(), ["calcs/c1.json", "fetch/_ledger.json", "fetch/fetch_profile.json", "raw/r1.json",
    "stages/estimates.json", "stages/financials.json", "stages/profile.json", "stages/valuation.json"]);
  assert.equal(fs.existsSync(path.join(out, "report.md")), false);
  assert.equal(fs.existsSync(path.join(out, "manifest.json")), false);
  assert.equal(m.tree_sha256, treeHash(m.files));
  assert.deepEqual(m.fingerprint, FP);
});

test("🔴 数据日取**来源运行**的开始时刻,不是建夹具的时刻", () => {
  // 今天拿三天前的运行建夹具:若用创建时间当数据日,新鲜度检查就形同虚设
  const { m } = mkFixture(mkRun("2026-08-21T09:30:00+08:00"));
  assert.equal(m.data_day, "2026-08-21");
  assert.equal(fixtureFreshness(m, new Date("2026-08-24T10:00:00+08:00")).fresh, false);
});

test("createFixture:缺阶段产物 / 缺 manifest / started_at 不合法 都要抛", () => {
  const a = mkRun(); fs.rmSync(path.join(a, "stages", "valuation.json"));
  assert.throws(() => mkFixture(a), /缺少阶段产物/);
  const b = mkRun(); fs.rmSync(path.join(b, "manifest.json"));
  assert.throws(() => mkFixture(b), /缺 manifest\.json/);
  const c = mkRun("不是时间");
  assert.throws(() => mkFixture(c), /started_at 缺失或不合法/);
});

test("verifyFixture:改内容 / 少文件 / 多文件 / 改清单 都要抓", () => {
  const good = () => mkFixture(mkRun()).out;
  assert.doesNotThrow(() => verifyFixture(good()));

  const a = good();
  fs.writeFileSync(path.join(a, "fetch", "fetch_profile.json"), '{"evidence":[{"id":"ev-ffffffffffff"}]}');
  assert.throws(() => verifyFixture(a), /已被改动/);

  const b = good();
  fs.rmSync(path.join(b, "raw", "r1.json"));
  assert.throws(() => verifyFixture(b), /缺文件/);

  // 清单外的残留文件会以静默方式改变播种结果
  const c = good();
  fs.writeFileSync(path.join(c, "fetch", "leftover.json"), "{}");
  assert.throws(() => verifyFixture(c), /清单之外的文件/);

  const e = good();
  const m = readFixture(e); m.tree_sha256 = "0".repeat(64);
  fs.writeFileSync(path.join(e, FIXTURE_MANIFEST), JSON.stringify(m));
  assert.throws(() => verifyFixture(e), /tree_sha256/);
});

test("🔴 路径越界:清单里写 ../ 或绝对路径,校验与播种都要拒绝", () => {
  for (const bad of ["../../target", "fetch/../../x", "/etc/passwd", "C:/x", "fetch//a", "fetch/./a", "outside/a", "fetch\\a"]) {
    assert.throws(() => assertSafeRel(bad), FixtureError, bad);
  }
  assert.doesNotThrow(() => assertSafeRel("fetch/a.json"));
  assert.doesNotThrow(() => assertSafeRel("raw/sub/b.json"));

  // 端到端:改过的清单必须在 verify 就被拦住
  const { out } = mkFixture(mkRun());
  const m = readFixture(out);
  m.files["../../escaped.json"] = "0".repeat(64);
  m.tree_sha256 = treeHash(m.files);
  fs.writeFileSync(path.join(out, FIXTURE_MANIFEST), JSON.stringify(m));
  assert.throws(() => verifyFixture(out), /非法路径/);
  // 纵深:即使绕过 verify 直接播种,也不许写出运行目录
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "vra-seed-"));
  assert.throws(() => seedRunDir(out, run, m), FixtureError);
});

test("readFixture:不是夹具目录 / 坏 JSON / 缺字段,都要给出能懂的错", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "vra-fx-"));
  assert.throws(() => readFixture(empty), /不是夹具目录/);
  fs.writeFileSync(path.join(empty, FIXTURE_MANIFEST), "{ 坏");
  assert.throws(() => readFixture(empty), /不是合法 JSON/);
  fs.writeFileSync(path.join(empty, FIXTURE_MANIFEST), JSON.stringify({ version: 1, files: {}, stages: ["profile"] }));
  assert.throws(() => readFixture(empty), /格式不对/);      // 缺 fingerprint
});

test("新鲜度按 Asia/Shanghai 的日历日判", () => {
  const { m } = mkFixture(mkRun("2026-08-24T10:00:00+08:00"));
  assert.equal(fixtureFreshness(m, new Date("2026-08-24T23:00:00+08:00")).fresh, true);
  assert.equal(fixtureFreshness(m, new Date("2026-08-25T01:00:00+08:00")).fresh, false);
  assert.equal(shanghaiDay(new Date("2026-08-24T17:00:00Z")), "2026-08-25");   // 同一 UTC 时刻在上海已是次日
});

test("seedRunDir:文件逐份还原,内容一致", () => {
  const { out, m } = mkFixture(mkRun());
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "vra-seed-"));
  assert.equal(seedRunDir(out, run, m).length, Object.keys(m.files).length);
  for (const rel of Object.keys(m.files)) {
    assert.equal(fs.readFileSync(path.join(run, ...rel.split("/")), "utf8"),
      fs.readFileSync(path.join(out, ...rel.split("/")), "utf8"), rel);
  }
  assert.equal(listFiles(run, "stages").length, 4);
});

test("checkFixture:标的 / 口径指纹(含 calc 版本)/ 数据日,任一不符都拒绝", () => {
  // 测试 cfg 的 python 不可用 → calcVersionOf 落到 "unknown",故夹具指纹也用 "unknown" 才算一致
  const { out } = mkFixture(mkRun("2020-01-02T09:30:00+08:00"));   // 指纹 calc_version = 0.3.2
  const cfg = (over: Record<string, unknown> = {}) => ({
    symbol: "000001", market: "SZ", seedFrom: out, allowStaleFixture: false,
    registryVersion: "1.0.0", endpointScope: "full", ...over,
  }) as never;

  const chk = (o: Record<string, unknown> = {}) => checkFixture(cfg(o), "0.3.2");
  assert.throws(() => chk({ symbol: "600519" }), /夹具是 000001\.SZ 的/);
  assert.throws(() => chk({ registryVersion: "1.1.0" }), /registry 1\.0\.0 ≠ 1\.1\.0/);
  assert.throws(() => chk({ endpointScope: "core" }), /endpoint scope full ≠ core/);
  // calc 版本不一致:早先只记录不强制,与接口注释自相矛盾,已改为强制
  const { out: o2 } = mkFixture(mkRun("2020-01-02T09:30:00+08:00", { ...FP, calc_version: "0.9.9" }));
  assert.throws(() => checkFixture({ ...(cfg({ allowStaleFixture: true }) as object), seedFrom: o2 } as never, "0.3.2"), /calc 版本 0\.9\.9 ≠ 0\.3\.2/);
  // "两边都探不到"不能算一致 —— 那只证明两边都没探到
  assert.throws(() => checkFixture(cfg({ allowStaleFixture: true }), "unknown"), /本次 calc 版本 未知/);
  assert.throws(() => chk(), /不是今天/);
  // 显式承担代价才放行
  assert.doesNotThrow(() => chk({ allowStaleFixture: true }));

  const run = fs.mkdtempSync(path.join(os.tmpdir(), "vra-seed-"));
  seedFixtureInto(cfg({ allowStaleFixture: true }), run, "0.3.2");
  assert.equal(fs.existsSync(path.join(run, "stages", "profile.json")), true);
});

test("🔴 符号链接:夹具内的链接文件与链接目录都要拒绝(词法校验挡不住)", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vra-out-"));
  fs.writeFileSync(path.join(outside, "secret.json"), '{"evidence":[{"id":"ev-secret000000"}]}');

  // 夹具里的文件是链接
  const { out } = mkFixture(mkRun());
  fs.rmSync(path.join(out, "fetch", "fetch_profile.json"));
  fs.symlinkSync(path.join(outside, "secret.json"), path.join(out, "fetch", "fetch_profile.json"));
  assert.throws(() => verifyFixture(out), /符号链接/);

  // 播种目标目录是链接
  const { out: ok } = mkFixture(mkRun());
  const m = readFixture(ok);
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "vra-seed-"));
  fs.symlinkSync(outside, path.join(run, "fetch"));
  assert.throws(() => seedRunDir(ok, run, m), /符号链接/);
});

test("manifest schema 认得 seeded_from(加了 TS 类型却忘了 schema,整次运行会被判 failed)", () => {
  // 这正是首次实测踩到的:两个阶段都 complete,却因 manifest schema 不认新字段而 status=failed
  const base = { seeded_from: { fixture_data_day: "2026-08-24", source_run_id: "r-1", stages: ["profile"], stale: false } };
  const err = (o: unknown) => validateWith("manifest-t", manifestSchema(), o).join(" | ");
  assert.doesNotMatch(err(base), /seeded_from/);
  assert.match(err({ seeded_from: { ...base.seeded_from, stale: "yes" } }), /stale must be boolean/);
  assert.match(err({ seeded_from: { ...base.seeded_from, x: 1 } }), /additional properties/);
  assert.doesNotMatch(err({ seeded_from: null }), /seeded_from/);   // 非播种运行显式为 null 也合法
});

test("Deep 允许的 16 份圈选资料与 manifest 上限一致", () => {
  const schema = manifestSchema() as unknown as { properties: { user_reports: { maxItems: number } } };
  assert.equal(schema.properties.user_reports.maxItems, 16,
    "任务层允许 16 份，但 manifest 若仍只允许 5 份，真实运行会在最终校验才失败");
});

test("🔴 createFixture 的输出目录不得与来源运行目录相同或互相包含(否则会先删掉来源)", () => {
  const run = mkRun();
  assert.throws(() => createFixture(run, run, { stages: SEEDED, symbol: "000001", market: "SZ", runId: "r-1" }), /不得相同或互相包含/);
  assert.throws(() => createFixture(run, path.dirname(run), { stages: SEEDED, symbol: "000001", market: "SZ", runId: "r-1" }), /不得相同或互相包含/);
  assert.equal(fs.existsSync(path.join(run, "stages", "profile.json")), true, "来源必须原封不动");
});

test("🔴 身份字段必须与来源 manifest 一致(夹具不能谎报它是谁的数据)", () => {
  const run = mkRun();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "vra-fx-"));
  assert.throws(() => createFixture(run, out, { stages: SEEDED, symbol: "600519", market: "SH", runId: "r-1" }), /与声称的 600519\.SH 不符/);
  assert.throws(() => createFixture(run, out, { stages: SEEDED, symbol: "000001", market: "SZ", runId: "别的run" }), /run_id .* 与声称的 别的run 不符/);
});

test("指纹:任一边为空或 unknown 都判不一致(两边都不知道证明不了相同)", () => {
  const { out } = mkFixture(mkRun("2026-08-24T09:00:00+08:00"));
  const cfg = (o: Record<string, unknown> = {}) => ({ symbol: "000001", market: "SZ", seedFrom: out,
    allowStaleFixture: true, registryVersion: "1.0.0", endpointScope: "full", ...o }) as never;
  assert.throws(() => checkFixture(cfg({ registryVersion: "" }), "0.3.2"), /本次 registry 未知/);
  assert.throws(() => checkFixture(cfg({ endpointScope: "unknown" }), "0.3.2"), /本次 endpoint scope 未知/);
  assert.doesNotThrow(() => checkFixture(cfg(), "0.3.2"));
});
