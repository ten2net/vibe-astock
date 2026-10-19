/**
 * 从旧版(Python 版 Vibe AStock)导入:类型与给人看的文字。后端见 orchestrator/src/finance/va_import.ts。
 * 先预览(不写)→ 用户确认 → 导入(先备份涉及的台账文件)。已经导过的按来源跳过,可以重复导。
 */

export interface VaImportInfo { default_dir: string; exists: boolean }
export interface VaSkip { what: string; why: string }
export interface VaGroup { key: string; label: string; found: number; add: number; already: number; skipped: VaSkip[]; notes: string[] }
export interface VaImportPreview {
  dir: string;
  groups: VaGroup[];
  /** 导入后交易日志里会对不上的(按新版规则重放) */
  warnings: string[];
  not_imported: { label: string; count: number; why: string }[];
  /** 一共要新写几项(0 = 没有要导的) */
  total: number;
}
export interface VaImportResult extends VaImportPreview {
  /** 备份文件夹(数据目录下的相对路径);没写任何东西时为 null */
  backup: string | null;
  written: Record<string, number>;
  failed: VaSkip[];
}

export const KIND_LABELS: Record<string, string> = {
  trade: "交易流水", journal_tag: "交易标注", journal_settings: "交易日志设置", mode_card: "模式卡",
  shortline_review: "AI 复盘", verification: "明日验证条件", note: "研究记录", intraday: "盘中快照",
};

/** 写进去的各类条数,按固定顺序写成一句;一条都没写返回空串 */
export function writtenText(written: Record<string, number>): string {
  const order = Object.keys(KIND_LABELS);
  return Object.entries(written).filter(([, n]) => n > 0)
    .sort(([a], [b]) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)))
    .map(([k, n]) => `${KIND_LABELS[k] ?? k} ${n} 条`).join("、");
}
