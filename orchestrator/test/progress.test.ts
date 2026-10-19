import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { ProgressReporter, clip, humanElapsed } from "../src/progress.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
/** 收集器 + 可控时钟:进度行必须完全确定,不能依赖真实时间 */
function harness(runDir: string, startMs = 0) {
  const lines: string[] = [];
  let clock = startMs;
  const rep = new ProgressReporter({ runDir, write: (l) => lines.push(l), now: () => clock, maxSummary: 40 });
  return { lines, rep, at: (ms: number) => { clock = startMs + ms; } };
}

function mkRun(stages: Record<string, unknown> = {}): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-prog-"));
  fs.mkdirSync(path.join(d, "stages"));
  for (const [k, v] of Object.entries(stages)) fs.writeFileSync(path.join(d, "stages", `${k}.json`), JSON.stringify(v));
  return d;
}

test("humanElapsed / clip:秒与分秒;按字符截断不切坏中文", () => {
  assert.equal(humanElapsed(0), "0秒");
  assert.equal(humanElapsed(59_400), "59秒");
  assert.equal(humanElapsed(80_000), "1分20秒");
  assert.equal(humanElapsed(-5), "0秒");
  assert.equal(clip("中际旭创处于上市状态", 4), "中际旭创…");
  assert.equal(clip("  多余   空白\n折行 ", 100), "多余 空白 折行");
});

test("取数汇总在第一分钟内出现,并点名失败的源", () => {
  const d = mkRun();
  const { lines, rep, at } = harness(d);
  at(1100); rep.onEvent({ stage: "profile", type: "fetch.executed", status: "ok", script: "fetch_profile" });
  at(3900); rep.onEvent({ stage: "profile", type: "fetch.executed", status: "failed", script: "sw_industry" });
  at(4600); rep.onEvent({ stage: "profile", type: "turn.prompt", attempt: 1 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[5秒\] 公司画像:取数 2 个源,成功 1 · 失败 1\(sw_industry\)/);
});

test("补跑不重复播报同一批取数", () => {
  const d = mkRun();
  const { lines, rep, at } = harness(d);
  at(1000); rep.onEvent({ stage: "profile", type: "fetch.executed", status: "ok", script: "a" });
  at(2000); rep.onEvent({ stage: "profile", type: "turn.prompt", attempt: 1 });
  at(9000); rep.onEvent({ stage: "profile", type: "turn.prompt", attempt: 2 });   // 补跑,没有新取数
  assert.equal(lines.length, 1);
});

test("阶段完成时打出该阶段落盘的 summary(读不到就明说,绝不编)", () => {
  const d = mkRun({ profile: { summary: "中际旭创处于上市状态,baostock 与东财公司名称一致;证监会行业分类与东财行业属于不同分类体系,不判为冲突;申万行业端点失败,当前申万归属未获取。" } });
  const { lines, rep, at } = harness(d);
  at(109_000); rep.onEvent({ stage: "profile", type: "stage.completed", status: "complete" });
  assert.match(lines[0], /^\[1分49秒\] ✓ 公司画像 complete$/);
  assert.match(lines[1], /^ {4}中际旭创处于上市状态/);
  assert.ok(lines[1].endsWith("…"), "超长 summary 要截断");

  const d2 = mkRun();     // 没有 stages/risk.json
  const h2 = harness(d2);
  h2.rep.onEvent({ stage: "risk", type: "stage.completed", status: "incomplete" });
  assert.equal(h2.lines.length, 1);
  assert.match(h2.lines[0], /△ 风险与线索 incomplete\(无 summary\)/);
});

test("校验未过要出声(用户得知道它在补跑,而不是以为卡住了);通过则不打扰", () => {
  const d = mkRun();
  const { lines, rep } = harness(d);
  rep.onEvent({ stage: "risk", type: "validator", ok: true, errors: [] });
  assert.equal(lines.length, 0);
  rep.onEvent({ stage: "risk", type: "validator", ok: false, errors: ["report.md 缺少扩展章节「招聘信号」", "b"] });
  assert.match(lines[0], /风险与线索:校验未过\(2 项\),自动补跑 —— report\.md 缺少扩展章节/);
});

test("产业门控:未命中要说明「不是数据缺口」,避免用户误读成漏取", () => {
  const d = mkRun();
  const { lines, rep } = harness(d);
  rep.onEvent({ stage: "risk", type: "industry.gate", tags: ["ai_compute"] });
  assert.match(lines[0], /命中产业标签 ai_compute/);
  rep.onEvent({ stage: "risk", type: "industry.gate", tags: [] });
  assert.match(lines[1], /未命中任何产业标签.*不是数据缺口/);
});

test("显示层永不影响运行:事件畸形 / 阶段文件是坏 JSON 都不得抛", () => {
  const d = mkRun();
  fs.writeFileSync(path.join(d, "stages", "profile.json"), "{ 这不是 JSON");
  const { lines, rep } = harness(d);
  assert.doesNotThrow(() => rep.onEvent({ stage: "profile", type: "stage.completed", status: "complete" }));
  assert.match(lines[0], /无 summary/);
  for (const bad of [null, undefined, 42, "x", { type: 1 }, { type: "fetch.executed", status: null }]) {
    assert.doesNotThrow(() => rep.onEvent(bad as never));
  }
});

test("未知事件类型一律忽略(事件流以后加类型不会刷屏)", () => {
  const d = mkRun();
  const { lines, rep } = harness(d);
  for (const t of ["command", "agent_message", "hooks.summary", "thread.started", "将来的新事件"]) {
    rep.onEvent({ stage: "risk", type: t });
  }
  assert.equal(lines.length, 0);
});

test("终端注入:ANSI / OSC / 控制字符 / 双向控制一律剥掉,不能伪造进度行", () => {
  const evil = "\u001b[2J\u001b[H伪造\u001b]0;改标题\u0007内容\u0008\u202e反转\u007f";
  const out = clip(evil, 200);
  assert.doesNotMatch(out, /\u001b/, "ESC 必须剥掉");
  assert.doesNotMatch(out, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/, "控制字符必须剥掉");
  assert.doesNotMatch(out, /[\u202a-\u202e\u2066-\u2069]/, "双向控制必须剥掉");
  assert.match(out, /伪造.*内容.*反转/);
  // agent 写的 summary 走同一条路
  const d = mkRun({ profile: { summary: "\u001b[31m红\u001b[0m色\n\n第二段" } });
  const { lines, rep } = harness(d);
  rep.onEvent({ stage: "profile", type: "stage.completed", status: "complete" });
  assert.equal(lines[1], "    红色 第二段");
});

test("自由文本里的绝对路径与密钥要抹掉(事件字段不取路径 ≠ 正文里没有路径)", () => {
  assert.match(clip("失败:/Users/someone/proj/.venv/bin/python 不存在", 200), /失败:<路径> 不存在/);
  assert.match(clip("C:\\Users\\x\\secret.json 读不到", 200), /<路径> 读不到/);
  assert.doesNotMatch(clip("api_key=abcdef1234567890 无效", 200), /abcdef1234567890/);
  assert.match(clip("硅光/光互连 锚点", 200), /硅光\/光互连/, "普通斜杠不能被误当路径");
  // 起点不限于 /Users 白名单 —— /etc /usr /Library 一样会泄露
  assert.equal(clip("证书读取失败:/etc/ssl/private/server.key", 200), "证书读取失败:<路径>");
  assert.equal(clip("/usr/local/lib/x.so 缺失", 200), "<路径> 缺失");
  // 🔴 本产品报告全是中文,**全角标点才是常态** —— 只认半角边界等于没脱敏
  assert.equal(clip("证书读取失败：/etc/ssl/private/server.key。", 200), "证书读取失败：<路径>。");
  assert.equal(clip("配置（/opt/app/conf.json）损坏", 200), "配置（<路径>）损坏");
  assert.equal(clip("「/usr/lib/x.so」缺失", 200), "「<路径>」缺失");
  // 中文目录名带全角括号:遇全角标点时"后面还有分隔符才继续",两个方向都要对
  assert.equal(clip("读取失败：/Users/alice/Documents/客户（机密）/财报.json", 200), "读取失败：<路径>");
  assert.equal(clip("读取失败，/var/log/a.log 不存在", 200), "读取失败，<路径> 不存在");
  // 防误伤:这些都**不是**路径
  for (const [text, why] of [["速率 1.6T 与 800G", "速率"], ["2026/08/24 的数据", "日期"],
    ["published=N/A 的写日期不详", "N/A"], ["买入 / 卖出 两个动作", "孤立斜杠"],
    ["硅光/光互连 与 CPO/LPO", "中文与缩写斜杠"], ["扣非×4 PE 为 34.51 倍", "普通数字"]]) {
    assert.equal(clip(text, 200), text, why);
  }
});

test("路径穿越:payload 覆盖 stage 也读不到 stages/ 以外的文件", () => {
  const d = mkRun({ profile: { summary: "正常" } });
  fs.writeFileSync(path.join(d, "secret.json"), JSON.stringify({ summary: "不该被打出来" }));
  const { lines, rep } = harness(d);
  for (const bad of ["../secret", "../../etc/passwd", "profile/../../secret", "不在白名单里的阶段"]) {
    rep.onEvent({ stage: bad, type: "stage.completed", status: "complete" });
  }
  assert.equal(lines.every((l) => !l.includes("不该被打出来")), true);
  assert.equal(lines.every((l) => /无 summary/.test(l)), true);
});

test("取数批次按阶段各存一份:不串数、补跑不累计", () => {
  const d = mkRun();
  const { lines, rep } = harness(d);
  // report 阶段没有任何取数 → 不得播报上一阶段的计数
  rep.onEvent({ stage: "risk", type: "fetch.executed", status: "ok", script: "a" });
  rep.onEvent({ stage: "risk", type: "fetch.executed", status: "ok", script: "b" });
  rep.onEvent({ stage: "risk", type: "turn.prompt", attempt: 1 });
  rep.onEvent({ stage: "report", type: "turn.prompt", attempt: 1 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /风险与线索:取数 2 个源/);
  // 同阶段补跑再取数 → 新一批从零算,不与上一轮合并
  rep.onEvent({ stage: "risk", type: "fetch.executed", status: "ok", script: "c" });
  rep.onEvent({ stage: "risk", type: "turn.prompt", attempt: 2 });
  assert.match(lines[1], /风险与线索:取数 1 个源,成功 1/);
});


test("带空格的绝对路径要整段抹掉,但正常句子不被过度吞", () => {
  assert.equal(clip("失败:/Users/alice/Secret Project/api-key.txt 读不到", 200), "失败:<路径> 读不到");
  assert.equal(clip("配置在 C:\\Users\\x\\My Docs\\a.json 里", 200), "配置在 <路径> 里");
  assert.equal(clip("读取失败：C:/Users/alice/Documents/客户机密/财报.json", 200), "读取失败：<路径>", "盘符正斜杠写法");
  assert.equal(clip("/tmp/a/b 不存在", 200), "<路径> 不存在");
  // 目录名里带逗号 / 括号:只认空白会在标点处断掉、泄露后半段
  assert.equal(clip("读取 /Users/alice/Documents/Acme, Inc/client/a.json 失败", 200), "读取 <路径> 失败");
  assert.equal(clip("(见 /var/log/x.log) 之后", 200), "(见 <路径>) 之后");
  // 目录名带括号(Report (Final))—— 右括号后直接接 / 时不能断在这里
  assert.equal(clip("读取 /Users/alice/Documents/Report (Final)/client/a.json 失败", 200), "读取 <路径> 失败");
  assert.equal(clip("申万行业端点失败,当前申万归属未获取。", 200), "申万行业端点失败,当前申万归属未获取。");
  assert.match(clip("硅光/光互连 与 CPO/LPO 两条路线", 200), /硅光\/光互连 与 CPO\/LPO 两条路线/);
});

test("符号链接读不到:stages 里的链接一律拒绝", () => {
  const d = mkRun({ profile: { summary: "正常" } });
  fs.writeFileSync(path.join(d, "outside.json"), JSON.stringify({ summary: "不该被打出来" }));
  fs.rmSync(path.join(d, "stages", "profile.json"));
  fs.symlinkSync(path.join(d, "outside.json"), path.join(d, "stages", "profile.json"));
  const { lines, rep } = harness(d);
  rep.onEvent({ stage: "profile", type: "stage.completed", status: "complete" });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /无 summary/);
});

test("非白名单 stage:标签要净化,且不得为它建批次(防 Map 无界增长)", () => {
  const d = mkRun();
  const { lines, rep } = harness(d);
  rep.onEvent({ stage: "\u001b[2J伪造\n第二行", type: "turn.done", duration_ms: 1000 });
  assert.equal(lines.length, 1, "换行必须被折叠,不能变成两行");
  assert.doesNotMatch(lines[0], /\u001b/);
  for (let i = 0; i < 50; i++) rep.onEvent({ stage: `攻击-${i}`, type: "fetch.executed", status: "ok", script: "x" });
  for (let i = 0; i < 50; i++) rep.onEvent({ stage: `攻击-${i}`, type: "turn.prompt", attempt: 1 });
  assert.equal(lines.length, 1, "非白名单阶段不建批次也不播报");
});

test("失败源超过 20 个时总数仍然准确(计数与明细分开)", () => {
  const d = mkRun();
  const { lines, rep } = harness(d);
  for (let i = 0; i < 25; i++) rep.onEvent({ stage: "risk", type: "fetch.executed", status: "failed", script: `src${i}` });
  rep.onEvent({ stage: "risk", type: "turn.prompt", attempt: 1 });
  assert.match(lines[0], /取数 25 个源,成功 0 · 失败 25\(src0, src1, src2 等\)/);
});

test("stages 目录本身是符号链接时也一律拒绝", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vra-out-"));
  fs.writeFileSync(path.join(outside, "profile.json"), JSON.stringify({ summary: "不该被打出来" }));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-prog-"));
  fs.symlinkSync(outside, path.join(d, "stages"));
  const { lines, rep } = harness(d);
  rep.onEvent({ stage: "profile", type: "stage.completed", status: "complete" });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /无 summary/);
});

test("命名管道 / 非普通文件不读(同步读 FIFO 会永久阻塞,try/catch 救不了)", () => {
  const d = mkRun();
  const { execFileSync } = createRequire(import.meta.url)("node:child_process");
  const fifo = path.join(d, "stages", "profile.json");
  try { execFileSync("mkfifo", [fifo]); } catch { return; }   // 平台没有 mkfifo 就跳过
  const { lines, rep } = harness(d);
  const t = setTimeout(() => { throw new Error("读 FIFO 阻塞了"); }, 3000);
  rep.onEvent({ stage: "profile", type: "stage.completed", status: "complete" });
  clearTimeout(t);
  assert.match(lines[0], /无 summary/);
});
