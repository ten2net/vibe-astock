import assert from "node:assert/strict";
import test from "node:test";

import { registerPlugin, resetPlugin, currentPlugin, type Plugin } from "../src/plugin.ts";
import { stageOutputSchema } from "../src/schemas.ts";
import { regionOf } from "../src/registry.ts";

/**
 * **第二个垂类的验收装置**。
 *
 * 全审 r4 的结论是「新增一个垂类包**跑不起来**」:9 个入口无条件注册金融、Core 主循环直接 import
 * 金融模块、按字面量阶段名分支散落四处、契约本身是金融命名。这个测试把"能不能"变成可判定的:
 * 一个**完全不含金融概念**的最小包(餐饮),不改任何 Core 代码,能注册、能拿到自己的 schema、
 * 能按自己的口径解析作用域。
 *
 * ⚠️ 它不证明整条研究链能跑通(那要真取数、真 agent);它证明的是**契约面够不够** ——
 * 也就是 r4 列的那些"必须改 Core"的地方是不是真的不用改了。
 */
const RESTAURANT = {
  id: "restaurant",
  stages: ["intake", "menu", "competition", "report"],
  stageScripts: {
    intake: { required: ["fetch_shop"], optional: [] },
    menu: { required: [], optional: ["fetch_menu"] },
    competition: { required: [], optional: [] },
    report: { required: [], optional: [] },
  },
  criticalScripts: ["fetch_shop"],
  stageCalcs: { intake: [], menu: [], competition: [], report: [] },
  extraTopics: { intake: [], menu: [], competition: ["外卖平台反馈"], report: [] },
  stageLabels: { intake: "门店", menu: "菜单", competition: "竞品", report: "报告" },
  topicSections: { 外卖平台反馈: "竞争与口碑" },
  /**
   * 🔴 **必填**,而且是这个垂类**自己的**红线 —— 金融那套("建仓 / 目标价")
   *    在餐饮这里一个字都用不上。这一条正是"边界切开了没有"的验收点:
   *    Core 不认识任何一个词,只负责匹配与拒付。
   */
  gate: {
    patterns: ["保证客流", "承诺翻台", "建议定价"],
    regexps: [{ name: "承诺型", re: /(保证|承诺)[^,。;\n]{0,10}(涨|翻倍|回本)/ }],
    exemptLines: ["本报告不替商家做定价与客流承诺。"],
    mentionableInStage: [],
    probeLine: "建议定价 38 元并保证客流翻倍",
  },
  extraSectionsAfter: "结论",
  // 这个垂类不需要"并入别处"的议题 —— 空表是合法的(不是每个垂类都有兜底议题)
  topicMerge: {},
  reportSections: ["结论", "数据缺口"],
  evidence: { markets: ["SG", "CN"], adjustments: ["none"], marketWideCodes: [], marketWideOnlyCodes: [] },
  standardColumns: ["客单价"],
  standardColumnLabels: { 客单价: "客单价" },
  standardColumnsStage: "competition",
  stageSchemas: {
    intake: { properties: { shop_status: { type: "string", enum: ["open", "closed"] } }, required: ["shop_status"] },
  },
  stageValidators: {
    intake: (ctx: { output: Record<string, unknown> }) => (ctx.output.shop_status === "closed" ? ["门店已歇业,后续阶段无意义"] : []),
  },
  reportStage: "report",
  topicsSourceStage: "competition",
  roles: [],
  semanticSlots: {},
  alertFields: [],
  selfTestCalc: null,
  quoteDecision: () => ({ decision: "normal", reason: "餐饮没有报价新鲜度这回事" }),
  baselinePeriod: () => null,
  marketRegion: (m: string) => (m === "SG" ? "SG" : "CN"),
  buildStagePrompt: (stage: string) => `请完成 ${stage} 阶段`,
  buildRewritePrompt: () => "请重写",
  // 词表是**通用机制**(给数字忠实度判"这个数字是不是主张"用),只是字段按金融场景命名。
  // 餐饮给一套自己的:金额语境是"客单价/人均",没有主体编号,窗口标签是"近 N 天"。
  lexicon: {
    moneyBefore: /(客单价|人均|营业额)[^0-9]{0,6}$/,
    moneyAfter: /^\s*(元|新元|SGD)/,
    categoryLabelContext: /(套餐|菜品)[^0-9]{0,4}$/,
    subjectCodePatterns: [],
    windowLabelPattern: /近\s*\d+\s*(天|周|月)/g,
    subjectCodeIsSixDigits: false,
  },
  archive: {
    validDays: 30,
    maxFacts: 10,
    sections: [
      { title: "1. 门店", blocks: [{ kind: "stageSummary", stage: "intake" }] },
      { title: "2. 缺口", tail: true, blocks: [{ kind: "gaps" }] },
    ],
  },
} as unknown as Plugin;

test("第二个垂类:不改任何 Core 代码就能注册,并按自己的口径工作(全审 r4 的验收)", () => {
  resetPlugin();
  assert.doesNotThrow(() => registerPlugin(RESTAURANT), "契约面若还带金融概念,这里就会因为缺字段而抛");
  assert.deepEqual([...currentPlugin().stages], ["intake", "menu", "competition", "report"]);

  // 阶段专属字段来自插件,而不是 Core 写死的报价判定 / 不可替代性标签
  const intake = stageOutputSchema("intake" as never) as { properties: Record<string, unknown>; required: string[] };
  assert.ok("shop_status" in intake.properties, "插件声明的字段必须进 schema");
  assert.ok(!("quote_decision" in intake.properties) && !("moat_tag" in intake.properties), "不该被塞金融字段");
  assert.ok(intake.required.includes("shop_status"));

  // 标准列跟着 standardColumnsStage 走,不是写死的那个阶段
  const comp = stageOutputSchema("competition" as never) as { properties: Record<string, unknown> };
  assert.ok("standard_columns" in comp.properties, "标准列该出现在插件指定的阶段");
  const menu = stageOutputSchema("menu" as never) as { properties: Record<string, unknown> };
  assert.ok(!("standard_columns" in menu.properties));

  // 作用域解析用插件的映射,Core 不认识任何市场代码
  assert.equal(regionOf("SG"), "SG");
  assert.equal(regionOf("CN"), "CN");

  // 阶段专属校验也来自插件
  const errs = currentPlugin().stageValidators.intake({ stage: "intake", output: { shop_status: "closed" }, run: {} as never });
  assert.deepEqual(errs, ["门店已歇业,后续阶段无意义"]);

  // 可选钩子不提供时,Core 必须能正常跳过(不是崩)
  assert.equal(currentPlugin().afterFetch, undefined);
  assert.equal(currentPlugin().beforeFetch, undefined);
  assert.equal(currentPlugin().doctorChecks, undefined);
});

test("第二个垂类:契约仍会拒掉自相矛盾的声明(不是把校验一起放松了)", () => {
  const bad = (over: Record<string, unknown>) => {
    resetPlugin();
    assert.throws(() => registerPlugin({ ...RESTAURANT, ...over } as Plugin));
  };
  bad({ reportStage: "menu" });                                   // 报告阶段必须是最后一个
  bad({ topicsSourceStage: "不存在的阶段" });
  bad({ standardColumnsStage: "不存在的阶段" });
  bad({ stageSchemas: { 不存在的阶段: { properties: {}, required: [] } } });
  bad({ stageValidators: { 不存在的阶段: () => [] } });
  resetPlugin();
});

test("注册期就拒掉'能过注册、运行期才炸'的插件(修复复审 r1-P1-1 / P1-2)", () => {
  const bad = (over: Record<string, unknown>, re: RegExp) => {
    resetPlugin();
    assert.throws(() => registerPlugin({ ...RESTAURANT, ...over } as Plugin), re);
  };
  // stageValidators 的值不是函数 → 旧实现能注册,跑到该阶段才 TypeError
  bad({ stageValidators: { intake: "not-a-function" } }, /必须是函数/);
  // stageSchemas 内层不是合法 JSON Schema → 旧实现要等首次编译该阶段 schema 才炸
  bad({ stageSchemas: { intake: { properties: { x: { type: "definitely-not-a-type" } }, required: [] } } }, /不是合法 JSON Schema/);
  // required 里的字段没在 properties 里声明(additionalProperties:false 下必然永远过不了)
  bad({ stageSchemas: { intake: { properties: {}, required: ["缺失字段"] } } }, /没有对应的 properties 定义/);
  // $ref 跨核心骨架:注册期解析不了(运行期的根是合并后的),显式拒绝而不是误拒或拖到运行期(修复复审 r2-P2-1)
  bad({ stageSchemas: { intake: { properties: { alias: { $ref: "#/properties/summary" } }, required: [] } } }, /不支持 \$ref/);
  resetPlugin();
});
