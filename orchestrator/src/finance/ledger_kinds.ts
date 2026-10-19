/**
 * 金融垂类的**台账记录种类**。Core 只提供存储与校验(`src/ledger.ts`),种类与字段全在这里。
 *
 * 核心四种构成一个闭环:
 *   计划(thesis) → 判据(criterion) → 现状(position) → 到期要做的事(action)
 * **顺序是有意的**:先写下目标与判据,后面所有"偏离"才有参照物。
 * 另两种在闭环之外:`watch`(自选,还没到写论点的程度)与 `note`(研究记录,只留痕不判定)。
 *
 * 🔴 红线:这些是**用户自己写下的东西**,产品不替他生成建仓建议。
 *    界面只做两件事:把他写的原样呈现出来,以及把"哪条到期了"算出来。
 */
import type { LedgerKindDef } from "../plugin.ts";
import { CITED_MAX, MAX_CONDITIONS, REVIEW_SECTIONS, REVIEW_SECTION_IDS, REVIEW_SECTION_STATUSES, SECTION_TEXT_MAX, WEEKLY_SECTIONS, WEEKLY_SECTION_IDS } from "./shortline/review_defs.ts";
import { DIRECTIONS, DIRECTION_LABELS, VERIFY_METRICS, VERIFY_METRIC_KEYS } from "./shortline/verify_metrics.ts";
import { DEFAULT_RULES, PLAYBOOKS, isFractionRule, type RuleKey } from "./journal/defs.ts";
import { MAX_RATE } from "./journal/fees.ts";
import { MODE_CHANGES_MAX, MODE_NAME_MAX, MODE_TEXT_FIELDS, MODE_TEXT_MAX, MODE_VERSIONS_MAX } from "./journal/modes.ts";

/**
 * 主体代码的台账规范形:
 * A 股 `600519` / 港股 `00700.HK` / 美股 `AAPL` 或 `BRK.B`。
 * 界面负责把 `hk00700` 等常见写法归一化，台账只收唯一写法。
 */
const US_SYMBOL_VALUE = "(?:[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,4})?)";
const SYMBOL_VALUE = `(?:[0-9]{6}|[0-9]{5}\\.HK|${US_SYMBOL_VALUE})`;
const SYMBOL = { type: "string", pattern: `^(?:${SYMBOL_VALUE})?$` };
const REQUIRED_SYMBOL = { type: "string", pattern: `^${SYMBOL_VALUE}$` };
/**
 * 日期:留空,或一个**真实存在的日历日**。
 * 🔴 只写 `^\d{4}-\d{2}-\d{2}$` 是不够的 —— `2026-99-99` / `2026-02-31` 都能过,
 *    然后进"到期清单"参与排序与提醒:**永远不触发,保存却报成功**。
 * `format: "date"` 由 Core 的 `ledger.ts` 自己注册(不依赖 ajv-formats 插件,
 * 所以不存在"没装就静默不校验"那种情况)。
 */
const DATE = { type: "string", anyOf: [{ maxLength: 0 }, { format: "date" }] };
const TEXT = (max = 500) => ({ type: "string", maxLength: max });
const NONEMPTY = (max = 500) => ({ type: "string", minLength: 1, maxLength: max, pattern: "\\S" });
const COUNT = { type: "integer", minimum: 0 };

/** AI 复盘 / 周报的一段:正文 + 数字核对(三档分开)+ 引到的证据行(「查看依据」) */
const reviewSection = (ids: readonly string[]) => ({
  type: "object", additionalProperties: false, required: ["id", "label", "status"],
  properties: {
    id: { type: "string", enum: ids },
    label: TEXT(20),
    status: { type: "string", enum: REVIEW_SECTION_STATUSES },
    text: TEXT(SECTION_TEXT_MAX),
    error: TEXT(500),
    /** 这一段的资料包里有多少条证据 */
    evidence_count: COUNT,
    audit: {
      type: "object", additionalProperties: false, required: ["total", "bound", "derived", "loose", "bad_math"],
      properties: {
        total: COUNT, bound: COUNT, derived: COUNT, loose: COUNT,
        bad_math: {
          type: "array", maxItems: 20,
          items: { type: "object", additionalProperties: false, required: ["raw", "stated", "recomputed"], properties: { raw: TEXT(200), stated: { type: "number" }, recomputed: { type: "number" }, percent: { type: "boolean" } } },
        },
      },
    },
    cited: {
      type: "array", maxItems: CITED_MAX,
      items: { type: "object", additionalProperties: false, required: ["id", "line"], properties: { id: { type: "string", pattern: "^ev-[0-9a-f]{6,}$" }, line: TEXT(600) } },
    },
    /** 引了、但资料包里没有的编号 */
    unknown_cites: { type: "array", maxItems: 40, items: TEXT(60) },
  },
});

/**
 * 字段键 / 枚举值的**中文显示名**。
 *
 * 🔴 这些以前写死在 Core 的表单组件里 —— "cost=成本""decision_point=裁决点"
 *    只在这个行业成立,换个垂类就得改 Core。而前端的纯净度棘轮词表里恰好
 *    没有"成本 / 账户 / 裁决点"这几个词,于是**一路绿灯**。
 *    ⇒ 教训与后端那条一样:词表挡不住它没收录的词,别拿"棘轮是绿的"当边界证明。
 *
 * ⚠️ 不必登记全部字段:界面对没登记的退回**原键名**照常渲染。
 */
export const FINANCE_FIELD_LABELS: Record<string, string> = {
  symbol: "代码", name: "名称", account: "账户", shares: "数量", cost: "成本",
  opened_at: "建立日期", note: "备注", title: "标题", statement: "内容",
  review_by: "复核日期", status: "状态", type: "类型", thesis_id: "关联论点",
  due: "到期日", ref: "关联", tag: "分组", category: "分类", body: "正文",
  judged_at: "判定日", verdict_note: "判定说明",
  date: "日期", price: "价格", fee: "费用", amount: "金额", ratio: "比例", migrated_from: "迁移自", written_at: "当初写下时间",
  metric: "读数", direction: "预期方向", reason: "理由",
  trade_id: "所属交易", playbook: "打法", as_planned: "按计划", planned_stop: "计划止损价", planned_target: "计划目标价",
  pnl_pct: "盈亏 %", planned_at: "标注时间",
  commission_rate: "佣金费率", commission_min: "单笔佣金最低", stamp_tax_rate: "印花税", transfer_fee_rate: "过户费",
  max_loss_per_trade_pct: "单笔最大亏损 %", max_loss_per_day_pct: "单日最大亏损 %", max_positions: "最多同时持仓",
  max_trades_per_day: "单日最多开仓", pause_after_losses: "连亏几笔后停手", max_unplanned_ratio: "计划外占比上限", equity_base: "账户规模",
  versions: "版本", version: "版本号", since: "生效日", changes: "改了什么", saved_at: "保存时间",
  setup: "什么情况下做", entry: "怎么进", exit: "怎么出", sizing: "仓位", phase: "适用的情绪阶段",
};

export const FINANCE_ENUM_LABELS: Record<string, string> = {
  active: "进行中", paused: "暂停", closed: "已结束",
  decision_point: "裁决点", falsifier: "证伪条件",
  pending: "待判", met: "已达成", broken: "已触发", dropped: "已放弃",
  open: "待办", done: "已完成",
  review: "复盘", highlight: "今日要点", ask: "问 Agent", debate: "多空辩论", audit: "反思审计",
  backtest: "回测", compare: "研究对比",
  opening: "期初持仓", buy: "买入", sell: "卖出", dividend: "现金分红", split: "送转 / 拆股",
  ...DIRECTION_LABELS,
  ...Object.fromEntries(VERIFY_METRICS.map((m) => [m.key, m.label])),
};

/**
 * 🔴 `hiddenFromAssistant: true` 的六种(清仓、交易流水、持有、交易标注、交易日志设置、模式卡)是用户自己的成交与持仓,
 *    **不交给模型**:聊天助手读台账时看不到它们,页面也不把它们放进发给 AI 的页面上下文(沿用旧版 VA「个人交易记录不接入任何 AI」)。
 *    自选、笔记、论点、判据、复盘这些可以给模型看。新增种类时想清楚放哪边。
 */
export const FINANCE_LEDGER_KINDS: Record<string, LedgerKindDef> = {
  /** 用户手动记录已发生的清仓，不下单、不自动扣减另一张持有台账。 */
  closed_position: {
    label: "清仓记录",
    hiddenFromAssistant: true,
    properties: {
      symbol: REQUIRED_SYMBOL,
      name: TEXT(40),
      closed_at: { type: "string", format: "date" },
      note: TEXT(1000),
      price: { type: "number", exclusiveMinimum: 0 },
      shares: { type: "number", exclusiveMinimum: 0 },
      cost: { type: "number" },
    },
    required: ["symbol", "closed_at", "price", "shares", "cost"],
  },
  /**
   * 交易流水:持仓页的唯一真相。持有多少、成本、已实现盈亏、分红都由 `holdings.ts` 按日期重放算出,不另存。
   * 各类型要哪些字段(买卖要数量和成交价、分红要金额、送转要比例)由重放逐条检查,不对的写原因、不参与计算 ——
   * 这里只做类型与范围校验(台账校验不支持「按类型要求字段」)。
   * `migrated_from`:从旧 `position` 记录迁移来的期初持仓,记原记录 id,迁移据此去重。
   */
  trade: {
    label: "交易流水",
    hiddenFromAssistant: true,
    properties: {
      symbol: REQUIRED_SYMBOL,
      name: TEXT(40),
      account: TEXT(40),
      type: { type: "string", enum: ["opening", "buy", "sell", "dividend", "split"] },
      date: { type: "string", format: "date" },
      shares: { type: "number", exclusiveMinimum: 0 },
      /** 期初持仓的每股成本可以是负数(分红 / 送转摊薄后),买卖成交价由重放要求大于 0 */
      price: { type: "number" },
      fee: { type: "number", minimum: 0 },
      /** 现金分红到账金额(税后,用户账户实际收到的) */
      amount: { type: "number", exclusiveMinimum: 0 },
      /** 送转拆股:每 1 股变成几股(10 转 5 = 1.5,1 拆 4 = 4,10 合 1 = 0.1) */
      ratio: { type: "number", exclusiveMinimum: 0 },
      note: TEXT(1000),
      migrated_from: TEXT(80),
    },
    required: ["symbol", "type", "date"],
  },
  /**
   * 旧的持有记录(一只一条:数量 + 均价)。现在只当**收件箱**:Agent / MCP / 导入仍可往这里写,
   * 持仓页打开时迁成一笔期初持仓流水(先备份)。还没迁的照样算「持有」(见 `holdings.ts` heldFromLedger)。
   * 成本与数量是用户自己的事实,产品不猜也不改。
   * ⚠️ 显示名保持「持有」:截图导入的提示词用它(「把资料转写成「持有」记录」)。
   */
  position: {
    label: "持有",
    hiddenFromAssistant: true,
    properties: {
      symbol: REQUIRED_SYMBOL,
      name: TEXT(40),
      account: TEXT(40),
      shares: { type: "number", minimum: 0 },
      // 🔴 **成本不设下限**：分红 / 送转吃够了之后，成本价变成负数是真实存在的持仓状态
      //    （开源版 Vibe-Research issue #3 就是用户拿这个来报的）。卡一个 `minimum: 0`
      //    的后果是这类持仓**根本录不进来**，而盈亏本来就按 (现价 − 成本) × 股数 算，
      //    成本为负照样算得出正确结果 —— 拦它换不来任何正确性。
      cost: { type: "number" },
      opened_at: DATE,
      note: TEXT(1000),
    },
    required: ["symbol", "shares", "cost"],
  },

  /** 论点:为什么持有 / 为什么关注。**这是经营闭环的地基** —— 没有它就谈不上"偏离" */
  thesis: {
    label: "论点",
    properties: {
      symbol: SYMBOL,
      title: NONEMPTY(120),
      statement: TEXT(4000),
      review_by: DATE,
      status: { type: "string", enum: ["active", "paused", "closed"] },
      note: TEXT(1000),
    },
    required: ["title"],
  },

  /**
   * 判据:到期必裁的**裁决点**,或写死的**证伪条件**。
   * 两者共用一种记录、靠 `type` 区分 —— 它们的生命周期完全一样(写下 → 到期 → 判定),
   * 拆成两种只会让"到期清单"要去合并两张表。
   */
  criterion: {
    label: "判据",
    properties: {
      symbol: SYMBOL,
      thesis_id: TEXT(80),
      type: { type: "string", enum: ["decision_point", "falsifier"] },
      statement: NONEMPTY(1000),
      /** 到期日:裁决点通常有,证伪条件可以没有(它是随时可能触发的条件,不是日程) */
      due: DATE,
      status: { type: "string", enum: ["pending", "met", "broken", "dropped"] },
      note: TEXT(1000),
      /** 判定那天与判定时写的理由(事件日历页「判据回看」写入;改回待判时清掉) */
      judged_at: DATE,
      verdict_note: TEXT(1000),
    },
    required: ["type", "statement"],
  },

  /**
   * 自选:只是"我盯着它",还没到写论点的程度。
   *
   * 🔴 与产品自带的**研究线**(界面里那几个可展开的分组)是两回事:
   *    那是随产品发的默认清单(让新用户一打开就知道这一页是干嘛的),
   *    这里是**用户自己加的**。两者混成一张表的话,产品更新默认清单就会动到用户的数据。
   * ⚠️ 自选里出现过不代表持有 —— 持有是 `position`,两张表刻意不互相推断。
   */
  watch: {
    label: "自选",
    properties: {
      symbol: REQUIRED_SYMBOL,
      name: TEXT(40),
      /** 用户自己的分组名(想按什么分就按什么分,产品不给固定选项) */
      tag: TEXT(40),
      note: TEXT(1000),
    },
    required: ["symbol"],
  },

  /**
   * 研究记录:把复盘 / 要点 / 问 Agent 的结果沉淀下来,回头能翻。
   *
   * 🔴 分类字段叫 `category` 而**不是 `kind`** —— `kind` 是 Core 的信封键
   *    (`LEDGER_ENVELOPE_KEYS`),重名会被注册期当场拒。这不是风格问题:
   *    真让它重名,记录的"种类"与"分类"会在同一个键上打架。
   * ⚠️ 与判据 / 论点的区别:那两种是**要拿来对账的**(有到期日、有状态);
   *    这里是**留痕**,不参与任何自动判定。
   */
  note: {
    label: "研究记录",
    properties: {
      symbol: SYMBOL,
      category: { type: "string", enum: ["review", "highlight", "ask", "debate", "audit", "backtest", "compare"] },
      title: NONEMPTY(160),
      /** markdown 正文；回测 / 多空辩论会保留完整多阶段报告，不能沿用短笔记的 2 万字上限。 */
      body: TEXT(100000),
      /** 从旧版导入的(个股深挖),记旧数据的来源,重复导入据此跳过 */
      migrated_from: TEXT(80),
    },
    required: ["title"],
  },

  /**
   * 明日验证条件:复盘那晚写下「下一个交易日用哪个市场读数检验今晚的判断」,一条一个读数(移植自 VA)。
   * `date` 是写下条件的那个复盘日,对账用它的下一个交易日。
   * 只收市场层面读数(涨停家数、炸板率……),不涉及个股、点位或买卖时机。
   * 对账、基准发生率和战绩在 `shortline/verification.ts`;下一场开盘竞价后才写 / 改的条件在那里标「事后」、不计入战绩。
   */
  verification: {
    label: "验证条件",
    // 只能从「明日验证」页面写(shortline/verification.ts 的 act):那里按 09:15 开盘竞价锁删除、判「事后」;
    // 通用台账接口能直接写 written_at、删条目,就绕过了这把锁
    managedWrites: true,
    properties: {
      date: { type: "string", format: "date" },
      metric: { type: "string", enum: VERIFY_METRIC_KEYS },
      direction: { type: "string", enum: DIRECTIONS },
      reason: TEXT(200),
      /** 从旧版导入的条件:记旧数据来源,重复导入据此跳过 */
      migrated_from: TEXT(80),
      /**
       * 旧版里这条条件当初写下的时间(旧版那晚复盘写完的时刻)。只对从旧版导入、导入后没改过的条件生效,
       * 用来判「事后」;不然导入那一刻就成了写下时间,全部算事后。见 shortline/verification.ts itemsByDate。
       */
      written_at: TEXT(40),
    },
    required: ["date", "metric", "direction"],
  },

  /**
   * 制度事件:涨跌幅改制、注册制、号段启用这类规则变化,人工登记(移植自 VA 的制度日历)。
   * 「结构变化」视图把它和数据断点放在一起看;系统**不从数据反推**制度变化。
   * 日期可以是周末(规则常周末公布)也可以是未来(提前公布、还没施行的,视图标出来)。
   */
  regime_event: {
    label: "制度事件",
    properties: {
      date: { type: "string", format: "date" },
      title: NONEMPTY(120),
      note: TEXT(500),
    },
    required: ["date", "title"],
  },

  /**
   * AI 复盘(五段式,移植自 VA):每次生成存一版,不覆盖旧版。
   * 正文、数字核对结果和引到的证据行一起存:回头翻能看到当时依据了什么(资料包本身不存,太长)。
   * 由「情绪复盘 · AI 复盘」写入(shortline/review.ts)。`conditions` 只是 AI 的建议,用户点了才写进 `verification`。
   */
  shortline_review: {
    label: "AI 复盘",
    managedWrites: true, // 只由 AI 复盘自己写(连同数字核对结果),不许经通用接口改
    properties: {
      date: { type: "string", format: "date" },
      /** 写的时候那一天收盘了没有;false = 盘中写的,数字后来还会变 */
      settled: { type: "boolean" },
      /** 用的哪个 AI(界面显示名) */
      ai: TEXT(80),
      started_at: TEXT(40),
      finished_at: TEXT(40),
      sections: { type: "array", minItems: 1, maxItems: REVIEW_SECTIONS.length, items: reviewSection(REVIEW_SECTION_IDS) },
      gaps: { type: "array", maxItems: 80, items: TEXT(400) },
      conditions: {
        type: "array", maxItems: MAX_CONDITIONS,
        items: {
          type: "object", additionalProperties: false, required: ["metric", "direction"],
          properties: { metric: { type: "string", enum: VERIFY_METRIC_KEYS }, direction: { type: "string", enum: DIRECTIONS }, reason: TEXT(200) },
        },
      },
      /** 建议没采用的原因(格式不对、读数不在清单里……) */
      conditions_note: TEXT(300),
      /** 从旧版导入的那一版:记旧数据来源,重复导入据此跳过;页面据此标「旧版导入、没按新版核对」 */
      migrated_from: TEXT(80),
    },
    required: ["date", "sections"],
  },

  /** AI 周报:一周(周一起)的情绪走势、题材轮动、明日验证对账回看 + 汇总。只看市场数据,不含个人交易 */
  shortline_weekly_review: {
    label: "AI 周报",
    managedWrites: true,
    properties: {
      /** 写到哪一天为止(这一周里的最后一个交易日,或写的那天) */
      date: { type: "string", format: "date" },
      /** 这一周的周一:同一周写的几版按它归在一起 */
      week_start: { type: "string", format: "date" },
      /** 这一周算进来的交易日 */
      days: { type: "array", maxItems: 7, items: { type: "string", format: "date" } },
      settled: { type: "boolean" },
      ai: TEXT(80),
      started_at: TEXT(40),
      finished_at: TEXT(40),
      sections: { type: "array", minItems: 1, maxItems: WEEKLY_SECTIONS.length, items: reviewSection(WEEKLY_SECTION_IDS) },
      gaps: { type: "array", maxItems: 80, items: TEXT(400) },
    },
    required: ["date", "week_start", "sections"],
  },

  /**
   * 交易标注(交易日志用,移植自 VA 的交易记录):给「一笔交易」(同一代码从买进到卖光的一轮,由交易流水推出)
   * 写打法、是否按计划、下单时的计划止损 / 目标、备注。成交本身只在 `trade` 里,这里不存数量和价格。
   * `trade_id` 填这一轮里任意一笔流水的 id;留空 = 没有成交明细的补记(只填盈亏 %,`date` 必填,由交易日志检查)。
   * 🔴 `planned_stop` 必须是**下单时**写下的:在险资金按它算,事后补填会让这个口径失真 ——
   *    `planned_at` 记第一次写下止损 / 目标的时间,晚于买入日的页面标「事后补填」。
   * `as_planned` 不写 = 未标注(不是「计划外」)。
   */
  journal_tag: {
    label: "交易标注",
    hiddenFromAssistant: true,
    properties: {
      symbol: REQUIRED_SYMBOL,
      name: TEXT(40),
      trade_id: TEXT(80),
      date: DATE,
      playbook: { type: "string", enum: PLAYBOOKS },
      as_planned: { type: "boolean" },
      planned_stop: { type: "number", exclusiveMinimum: 0 },
      planned_target: { type: "number", exclusiveMinimum: 0 },
      /** 只用于没有成交明细的补记;有明细的按流水算出的为准 */
      pnl_pct: { type: "number", minimum: -100, maximum: 1000 },
      note: TEXT(500),
      planned_at: TEXT(40),
      migrated_from: TEXT(80),
    },
    required: ["symbol"],
  },

  /**
   * 交易日志设置:费率、风险规矩、账户规模。只认一条(多条时取最后修改的那条,页面提示)。
   * 费率四项要么都不填(用默认、标「默认」),要么都填;只填一部分由交易日志报出来,不拿默认值补。
   * 规矩不填的那项用默认值(VA 同口径)。账户规模不填就不算任何「占账户的比例」,产品不替用户估。
   */
  journal_settings: {
    label: "交易日志设置",
    hiddenFromAssistant: true,
    properties: {
      commission_rate: { type: "number", minimum: 0, maximum: MAX_RATE },
      commission_min: { type: "number", minimum: 0 },
      stamp_tax_rate: { type: "number", minimum: 0, maximum: MAX_RATE },
      transfer_fee_rate: { type: "number", minimum: 0, maximum: MAX_RATE },
      ...Object.fromEntries((Object.keys(DEFAULT_RULES) as RuleKey[]).map((k) => [k,
        k === "max_unplanned_ratio" ? { type: "number", minimum: 0, maximum: 1 }
          : isFractionRule(k) ? { type: "number", exclusiveMinimum: 0 }
            : { type: "integer", minimum: 1 }])),
      equity_base: { type: "number", exclusiveMinimum: 0 },
    },
    required: [],
  },

  /**
   * 模式卡:自己写下的打法,带版本。一张卡一条,版本只追加不覆盖(交易日志页的「模式卡」负责开新版本)。
   * 卡片文字全由用户写,系统只存、不校验内容;打法也进版本(决定哪些交易归这张卡)。
   */
  mode_card: {
    label: "模式卡",
    hiddenFromAssistant: true,
    properties: {
      name: NONEMPTY(MODE_NAME_MAX),
      playbook: { type: "string", enum: PLAYBOOKS },
      versions: {
        type: "array", minItems: 1, maxItems: MODE_VERSIONS_MAX,
        items: {
          type: "object", additionalProperties: false, required: ["version", "since", "playbook"],
          properties: {
            version: { type: "integer", minimum: 1 },
            since: { type: "string", format: "date" },
            changes: TEXT(MODE_CHANGES_MAX),
            playbook: { type: "string", enum: PLAYBOOKS },
            ...Object.fromEntries(MODE_TEXT_FIELDS.map((k) => [k, TEXT(MODE_TEXT_MAX)])),
            saved_at: TEXT(40),
          },
        },
      },
      migrated_from: TEXT(80),
    },
    required: ["name", "playbook", "versions"],
  },

  /** 行动:待办。可由判据到期生成,也可以自己写 */
  action: {
    label: "行动",
    properties: {
      symbol: SYMBOL,
      title: NONEMPTY(200),
      due: DATE,
      status: { type: "string", enum: ["open", "done", "dropped"] },
      /** 关联的判据 / 论点 / 研究运行 id —— 只存字符串,不做外键约束 */
      ref: TEXT(120),
      note: TEXT(1000),
    },
    required: ["title"],
  },
};
