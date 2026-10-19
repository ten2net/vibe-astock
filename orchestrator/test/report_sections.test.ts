import assert from "node:assert/strict";
import { test } from "node:test";
import { extraTopics } from "../src/schemas.ts";

import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
import {
  topicSections, topicsWithoutSection, citedIds, extraSectionErrors, extraSectionsPromptBlock,
  headingBlocks, missingExtraSections, normalizeHeading, requiredExtraSections,
} from "../src/report_sections.ts";

const risk = (...topics: [string, string[]][]) => ({ extra_findings: topics.map(([topic, evidence_ids]) => ({ topic, evidence_ids })) });
const errs = (report: string, ...topics: [string, string[]][]) => extraSectionErrors(report, requiredExtraSections(risk(...topics)));

test("映射表覆盖 risk 的全部合法 topic:要么有专属章节,要么明确登记为无章节", () => {
  // 防的是"加了新 topic 却忘了决定它进哪一章"。即使漏了,运行时也会 fail-safe 退化成全文要求(见下一条测试)。
  for (const t of extraTopics().risk) {
    const known = t in topicSections() || topicsWithoutSection().includes(t);
    assert.equal(known, true, `risk topic「${t}」既没有专属章节也没登记为无章节`);
  }
});

test("fail-safe:无专属章节 / 未知 topic 的证据仍须在全文被引用", () => {
  // ht27 事故里丢的正是「其他线索」(4 条证据一条没引)。旧版把它整个跳过 = 静默失效。
  assert.equal(errs("## 结论摘要\n什么都没引\n", ["其他线索", ["ev-a1a1a1"]]).length, 1);
  assert.equal(errs("## 结论摘要\n提到 [ev-a1a1a1]\n", ["其他线索", ["ev-a1a1a1"]]).length, 0);
  assert.equal(errs("## 结论摘要\n无\n", ["未来某个新topic", ["ev-b2b2b2"]]).length, 1, "未知 topic 必须 fail-safe 而不是跳过");
  const e = errs("## 裁决点\n无\n", ["数据日历", ["ev-c3c3c3"]]);
  assert.match(e[0], /裁决点/);
});

test("requiredExtraSections:同章多个 topic 合并章节,但证据分开保留", () => {
  const req = requiredExtraSections(risk(["资金行为", ["ev-a1a1a1"]], ["解禁", ["ev-b2b2b2"]]));
  assert.deepEqual(req.sections.map((r) => r.section), ["资金与市场行为"]);
  assert.deepEqual(req.sections[0].topics.map((t) => t.topic), ["资金行为", "解禁"]);
  // 只引了资金行为的证据 → 解禁仍算丢失(旧版取并集会放行)
  const only = errs("## 资金与市场行为\n两融 [ev-a1a1a1]\n", ["资金行为", ["ev-a1a1a1"]], ["解禁", ["ev-b2b2b2"]]);
  assert.equal(only.length, 1);
  assert.match(only[0], /topic「解禁」/);
  assert.equal(errs("## 资金与市场行为\n两融 [ev-a1a1a1] 解禁 [ev-b2b2b2]\n", ["资金行为", ["ev-a1a1a1"]], ["解禁", ["ev-b2b2b2"]]).length, 0);
});

test("requiredExtraSections:畸形输入不炸;空白 id 不得让判定永远为真", () => {
  assert.deepEqual(requiredExtraSections(null).sections, []);
  assert.deepEqual(requiredExtraSections({ extra_findings: "不是数组" }).sections, []);
  // 空串 id 若保留,body.includes("") 恒真 → 任何章节都能蒙混
  const req = requiredExtraSections({ extra_findings: [{ topic: "招聘信号", evidence_ids: ["", "  "] }] });
  assert.deepEqual(req.sections[0].topics[0].evidenceIds, []);
  assert.equal(extraSectionErrors("## 招聘信号\n(空)\n", req).length, 0, "一条有效证据都没有时不制造无法满足的要求");
});

test("标题匹配:容忍分隔符 / 空白 / 层级 / 前导空格,不容忍合并改名", () => {
  assert.equal(normalizeHeading("公告 · 互动易 · 新闻线索"), normalizeHeading("公告·互动易·新闻线索"));
  assert.deepEqual(missingExtraSections("## 公告·互动易·新闻线索\n", ["公告 · 互动易 · 新闻线索"]), []);
  // ht27 实测:agent 把扩展章节降级成 ### 挂在「风险与反证」下,内容与护栏都在 → 算在场
  assert.deepEqual(missingExtraSections("## 风险与反证\n### 产业温度计\nx\n", ["产业温度计"]), []);
  assert.deepEqual(missingExtraSections("  ## 市场声音\n", ["市场声音"]), [], "CommonMark 允许 0-3 个前导空格");
  // 合并成一个含糊标题 → 三个都判缺(否则逐 topic 护栏无从核验)
  assert.deepEqual(
    missingExtraSections("## 市场声音、海外头条与招聘信号\n", ["市场声音", "海外头条", "招聘信号"]).sort(),
    ["市场声音", "招聘信号", "海外头条"].sort(),
  );
});

test("headingBlocks:正文切到下一个同级或更高级标题为止", () => {
  const b = headingBlocks("# T\n## A\na1\n### A1\na2\n## B\nb1\n");
  assert.deepEqual(b.map((x) => x.title), ["T", "A", "A1", "B"]);
  assert.equal(b.find((x) => x.title === "A")!.body.includes("a2"), true);
  assert.equal(b.find((x) => x.title === "A")!.body.includes("b1"), false);
});

test("空壳章节:后面那节的 id 不算前面那节写了", () => {
  // 「## 市场声音」是空的,「### 招聘信号」在它下面 —— 按层级切块会把招聘的 id 算进市场声音
  const report = "## 市场声音\n\n### 招聘信号\n在招 N 个 [ev-b2b2b2]\n";
  const e = errs(report, ["市场声音", ["ev-a1a1a1"]], ["招聘信号", ["ev-b2b2b2"]]);
  assert.equal(e.length, 1);
  assert.match(e[0], /「市场声音」章节没有引用/);
});

test("id 必须整 token 相等 —— 前缀不算引用", () => {
  assert.deepEqual([...citedIds("见 [ev-abc1234] 与 calc-0123456789abcdef")].sort(), ["calc-0123456789abcdef", "ev-abc1234"]);
  const e = errs("## 招聘信号\n见 [ev-abc1234]\n", ["招聘信号", ["ev-abc123"]]);
  assert.equal(e.length, 1, "ev-abc123 不该被 ev-abc1234 满足");
});

test("章节在场且引了自己的证据就放行,不对结论提任何要求", () => {
  // 如实写"数据不足"也必须能过 —— 本产品宁可写没有,不可以编
  assert.deepEqual(errs("## 管制与准入\n检索未确认,信息不足 [ev-b2b2b2]\n", ["管制与准入", ["ev-a1a1a1", "ev-b2b2b2"]]), []);
});

test("提示词块:点名每章与每个 topic,并写明不得合并", () => {
  assert.equal(extraSectionsPromptBlock(null), "");
  const blk = extraSectionsPromptBlock(risk(["市场声音", ["ev-a1a1a1"]], ["招聘信号", ["ev-b2b2b2"]], ["数据日历", ["ev-c3c3c3"]]));
  assert.match(blk, /## 市场声音/);
  assert.match(blk, /## 招聘信号/);
  assert.match(blk, /数据日历/);
  assert.match(blk, /不得与别的扩展章节合并/);
  assert.match(blk, /这 2 个章节标题/);
});

test("围栏代码块里的标题不算章节(既不能假通过也不能截断真章节)", () => {
  // 报告若引用 Markdown 片段,```内的 ## 市场声音 不是真章节
  const fake = "## 结论摘要\n```md\n## 市场声音\n示例 [ev-a1a1a1]\n```\n";
  assert.deepEqual(missingExtraSections(fake, ["市场声音"]), ["市场声音"], "代码块里的标题不能让缺失章节假通过");
  // 反向:真章节内含代码块时不得被块内标题提前截断
  const real = "## 市场声音\n```md\n### 招聘信号\n```\n真内容 [ev-a1a1a1]\n";
  assert.deepEqual(errs(real, ["市场声音", ["ev-a1a1a1"]]), []);
});

test("citedIds:两端要有标识符边界", () => {
  assert.equal(citedIds("ev-abc123xyz").has("ev-abc123"), false, "更长的非法标识不能截出合法前缀");
  assert.equal(citedIds("foo-ev-abc123").has("ev-abc123"), false);
  assert.equal(citedIds("见 [ev-abc123]。").has("ev-abc123"), true, "正常括号与标点必须仍能识别");
});

test("提示词绝不写出无法满足的指令(无有效证据时不得要求引用)", () => {
  const blk = extraSectionsPromptBlock({ extra_findings: [{ topic: "招聘信号", evidence_ids: ["  "] }] });
  assert.doesNotMatch(blk, /至少引 1 条/, "没有有效 id 时不得要求引用");
  assert.match(blk, /不得编造/);
});

test("波浪线围栏的 info string 允许含 ~(CommonMark),不得连锁吞掉后文", () => {
  const r = "## 结论摘要\n~~~text title=a~b\n## 市场声音\n~~~\n## 招聘信号\n在招 [ev-b2b2b2]\n";
  assert.deepEqual(missingExtraSections(r, ["市场声音"]), ["市场声音"], "块内标题不是真章节");
  assert.deepEqual(errs(r, ["招聘信号", ["ev-b2b2b2"]]), [], "闭栏后的真章节不能被吞");
  // 反引号围栏仍按 CommonMark 禁止 info string 含反引号
  assert.deepEqual(missingExtraSections("```a`b\n## 市场声音\n", ["市场声音"]), [], "非法开栏 → 其后标题仍是真章节");
});

test("自查句不得对无有效证据的 topic 要求引用", () => {
  const blk = extraSectionsPromptBlock({ extra_findings: [{ topic: "招聘信号", evidence_ids: [""] }] });
  assert.match(blk, /有有效证据 id 的/);
  assert.match(blk, /不得编造/);
});
