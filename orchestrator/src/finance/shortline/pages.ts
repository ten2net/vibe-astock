/**
 * 短线(Vibe AStock)的界面查询。和 VR 原有的页面分开放,由 `../page_queries.ts` 合进 FINANCE_PAGE_QUERIES。
 *
 * 🔴 情绪复盘一页拆成几个查询,页面先取第一个、拿到业务日后再并发取其余的:
 *    冷启动时五个短线端点要约 45 次东财请求,东财按全局节奏一次一个(约 1.3 秒);
 *    放进同一个查询要等最慢的周期(要逐日取近 10 天)一起回来,一分钟后才出第一屏。
 * 后面几个不解析上下文:页面总是把第一个查询定下的那天作为 date 传过来;
 * 不传时端点自己取最近一个已收盘交易日(AI 按名字浏览时也是这一天),不会拿盘中半天的数冒充复盘。
 */
import type { PageQueryDef } from "../../plugin.ts";

/** 只许改日期,别的口径不开放 */
const DATE_ONLY = ["date"] as const;

export const SHORTLINE_PAGE_QUERIES: Record<string, PageQueryDef> = {
  shortline: {
    title: "情绪复盘",
    intent: "短线情绪处在什么温度:昨天涨停的今天赚不赚钱、晋级顺不顺、梯队有没有断层",
    // 默认看已经收完盘的那一天(盘中 = 上一个交易日,盘后 = 今天),由后端解析,不按本地时间猜
    needsContext: true,
    blocks: [
      {
        id: "emotion", title: "情绪四项",
        note: "赚钱效应 / 晋级率 / 连板溢价 / 梯队断层;按这一天和前一个交易日的东财涨停池逐只算",
        endpoint: "cn_shortline_emotion",
        injectContext: true, injectAs: { date: "date" },
        userArgs: DATE_ONLY,
      },
    ],
  },
  shortline_facts: {
    title: "情绪复盘 · 盘面事实",
    intent: "这一天发生了什么:昨日强势股的反馈、亏钱效应、封板质量、关键事件、分涨跌幅制度",
    blocks: [
      { id: "facts", title: "盘面事实", note: "封板质量 / 亏钱效应 / 昨日强势股反馈 / 行业结构 / 关键事件 / 分制度生态", endpoint: "cn_shortline_facts", userArgs: DATE_ONLY },
    ],
  },
  shortline_themes: {
    title: "情绪复盘 · 题材与首板",
    intent: "钱在哪些题材:按涨停原因归组的题材树,和当天的首板名单",
    blocks: [
      { id: "themes", title: "题材事件树", note: "涨停原因来自同花顺涨停揭秘或问财:源站编辑归因,不是公司确认", endpoint: "cn_shortline_themes", userArgs: DATE_ONLY },
      { id: "firstboard", title: "首板名单", note: "连板数 = 1 的涨停股,按首封时间排;反包单独标出", endpoint: "cn_shortline_firstboard", userArgs: DATE_ONLY },
    ],
  },
  shortline_cycle: {
    title: "情绪复盘 · 情绪周期",
    intent: "这一轮情绪从哪天起来、走到第几天(启发式,不是精确的周期划分)",
    blocks: [
      { id: "cycle", title: "情绪周期", note: "近 10 个交易日的涨停数 / 最高连板 / 炸板率合成的相对分", endpoint: "cn_shortline_cycle", userArgs: DATE_ONLY },
    ],
  },
  shortline_ladder: {
    title: "情绪复盘 · 连板天梯",
    intent: "这一天每个连板高度有谁、昨天同一高度的有几只接上了、没接上的今天怎么样",
    blocks: [
      { id: "ladder", title: "连板天梯", note: "按东财连板数分层;晋级 = 昨天 N 板的今天还在涨停池,没接上的写明跌停 / 炸板 / 没涨停", endpoint: "cn_shortline_board_ladder", userArgs: DATE_ONLY },
    ],
  },
  shortline_rotation: {
    title: "情绪复盘 · 题材轮动",
    intent: "近几天涨停题材怎么轮动:哪些连续在前排、哪些新出现、哪些回流、哪些退下去了",
    blocks: [
      // 只开放日期:窗口固定 5 个交易日,和「近 5 天」分页一致
      { id: "rotation", title: "题材轮动", note: "题材 = 同花顺涨停揭秘的涨停原因拆出的标签;某天没取到按缺数处理,不当 0", endpoint: "cn_shortline_theme_rotation", userArgs: DATE_ONLY },
    ],
  },
};
