/**
 * AI 复盘的分段名单(移植自 Vibe AStock v2.0.0 review_agent/grounding.py 的 ROLE_SOURCES:情绪 / 资金 / 题材 / 龙虎榜 / 龙头 + 汇总)。
 * 单独成文件:台账种类(ledger_kinds.ts)要拿分段 id 做枚举,不该为此导入取数和调 AI 的代码。
 */
export const REVIEW_SECTIONS = [
  { id: "sentiment", label: "情绪" },
  { id: "capital", label: "资金" },
  { id: "theme", label: "题材" },
  { id: "dragon_tiger", label: "龙虎榜" },
  { id: "leader", label: "龙头" },
  { id: "summary", label: "汇总" },
] as const;

export type ReviewSectionId = (typeof REVIEW_SECTIONS)[number]["id"];
export const REVIEW_SECTION_IDS: ReviewSectionId[] = REVIEW_SECTIONS.map((s) => s.id);

/** AI 周报的分段:情绪走势 / 题材轮动 / 验证回看 + 汇总(VA 没有,沿用日复盘那套分段写、程序核对) */
export const WEEKLY_SECTIONS = [
  { id: "trend", label: "情绪走势" },
  { id: "themes", label: "题材轮动" },
  { id: "verify", label: "验证回看" },
  { id: "summary", label: "本周汇总" },
] as const;

export type WeeklySectionId = (typeof WEEKLY_SECTIONS)[number]["id"];
export const WEEKLY_SECTION_IDS: WeeklySectionId[] = WEEKLY_SECTIONS.map((s) => s.id);
export const REVIEW_SECTION_STATUSES = ["done", "failed", "skipped", "cancelled"] as const;
/** 汇总里给明日验证提的建议最多几条 —— 多了就没重点 */
export const MAX_CONDITIONS = 4;
/** 一段正文最多存多少字(超了是模型跑偏,截断并在缺口里说) */
export const SECTION_TEXT_MAX = 20000;
/** 一段里引到的证据最多存几条(「查看依据」用) */
export const CITED_MAX = 80;
