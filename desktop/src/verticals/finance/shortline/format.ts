/**
 * 短线页面共用的取值与格式化。移植自 Vibe AStock v2.0.0 的 lib/agent.ts 与 lib/colors.ts。
 * 红涨绿跌(强 = 红、弱 = 绿),和整个工作台一致。
 */
import type { LadderGap } from "./types";

export function safeArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** 只取普通对象;数组和 null 都不算,避免 Object.entries 崩或产出怪结果 */
export function safeRecord<T>(v: unknown): Record<string, T> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, T>) : {};
}

/** 有限数才算数:NaN / Infinity 会溜过 `v == null`,最后显示成 "NaN%" 或灌进 CSS 宽高 */
export function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 去掉写给模型看的 Markdown 粗体记号 */
export function plain(v: string | null | undefined): string {
  return (v ?? "").replace(/\*\*/g, "");
}

/** 0~1 的比率 → 百分比文本 */
export function rate(v?: number | null): string {
  const n = finite(v);
  return n == null ? "—" : `${Math.round(n * 100)}%`;
}

/** 涨跌幅数字(已经是百分数)→ 带符号文本 */
export function signed(v?: number | null, digits = 2): string {
  const n = finite(v);
  return n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

/** 上游的时间写成 093148 / 0931 → 09:31 */
export function hhmm(t?: string | null): string {
  if (!t || t.length < 4) return "—";
  return `${t.slice(0, 2)}:${t.slice(2, 4)}`;
}

/** 元 → 亿 */
export function yi(v?: number | null): string {
  const n = finite(v);
  return n == null ? "—" : `${(n / 1e8).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 亿`;
}

/** 只数 → 占样本的比例 */
export function ratioOf(count?: number | null, sample?: number | null): number | null {
  const c = finite(count), n = finite(sample);
  return c == null || n == null || n <= 0 ? null : c / n;
}

/** 涨(正向、强)用的文字色 */
export const UP_TEXT = "text-danger";
/** 跌(负向、弱)用的文字色 */
export const DOWN_TEXT = "text-success";
const FLAT_TEXT = "text-muted-foreground";

export function pctColor(v: number | null | undefined): string {
  const n = finite(v);
  if (n == null) return FLAT_TEXT;
  return n > 0 ? UP_TEXT : n < 0 ? DOWN_TEXT : FLAT_TEXT;
}

/**
 * 涨停 / 跌停**家数**这类计数的颜色。方向是写死的,不看数值正负(跌停 30 家,30 是正数,但它表达的是「跌」)。
 */
export function countColor(direction: "up" | "down"): string {
  return direction === "up" ? UP_TEXT : DOWN_TEXT;
}

/** 强弱类读数(走强 / 转弱、没炸过、延续率高低):强 = 红、弱 = 绿,和涨跌同一套色觉习惯 */
export function strengthColor(strong: boolean | null | undefined): string {
  if (strong == null) return FLAT_TEXT;
  return strong ? UP_TEXT : DOWN_TEXT;
}

/** 走向文字的颜色:走强红、转弱绿,其它不上色 */
export function trendColor(trend?: string | null): string {
  if (!trend) return "text-foreground";
  return trend.includes("走强") ? UP_TEXT : trend.includes("转弱") ? DOWN_TEXT : "text-foreground";
}

/** 样本没取全时的一句话;取全了返回空 */
export function coverageNote(c?: { partial?: boolean; sample?: number; expected_sample?: number; coverage_rate?: number } | null): string {
  if (!c?.partial) return "";
  return `当天行情只取到 ${c.sample ?? "—"}/${c.expected_sample ?? "—"} 只(${rate(c.coverage_rate)}),读数按取到的算`;
}

/**
 * 断层那句按结构化字段现场组,不直接印后端的 `note`:这句话曾把方向写反(写成「最高标上方悬空」——
 * 缺的档在最高标**下面**),落盘的旧句子会一直留在历史复盘里;用 gaps / highest 组句,翻回旧日子也说得对。
 */
export function ladderNote(lg: LadderGap): string {
  const gaps = safeArray<number>(lg.gaps);
  if (!gaps.length) return plain(lg.note);
  const hi = lg.highest != null ? `(${lg.highest}板)` : "";
  return `板位缺档 ${gaps.map((g) => `${g}板`).join("、")} → 最高标${hi}下方断层,是否有同题材承接需另查,板位缺档本身不能判定`;
}

/** 梯队从高到低:有票的档写家数,缺的档插在原位 */
export function ladderRows(lg: LadderGap): { board: number; count: number | null }[] {
  const tiers = safeRecord<number>(lg.tiers);
  const rows = new Map<number, number | null>();
  for (const [b, c] of Object.entries(tiers)) { const n = Number(b); if (Number.isFinite(n)) rows.set(n, finite(c)); }
  for (const g of safeArray<number>(lg.gaps)) if (Number.isFinite(g) && !rows.has(g)) rows.set(g, null);
  return [...rows].sort((a, b) => b[0] - a[0]).map(([board, count]) => ({ board, count }));
}

/** 板位排序:首板最前、「昨日炸板」最后,中间按数字升序 */
export function tierOrder(t: string): number {
  return t === "首板" ? 1 : t === "昨日炸板" ? Number.MAX_SAFE_INTEGER : (parseInt(t, 10) || Number.MAX_SAFE_INTEGER - 1);
}

/** 按读数类型写数:家数 / 板数带单位,比例写成百分数,涨跌幅带正负号 */
export function reading(v: number | null | undefined, kind: "count" | "rate" | "pct" | "share", unit = ""): string {
  const n = finite(v);
  if (n == null) return "—";
  if (kind === "rate" || kind === "share") return rate(n);
  if (kind === "pct") return signed(n);
  return `${Number.isInteger(n) ? n : n.toFixed(1)}${unit}`;
}
