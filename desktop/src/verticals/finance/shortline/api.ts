/**
 * 情绪复盘页取数:先取 `shortline`(定业务日 + 情绪四项),再按同一天并发取盘面事实、题材与首板、情绪周期、连板天梯。
 * 「近 5 天」分页的题材轮动也走这里(`shortline_rotation`)。
 * 页面只认查询名,端点 id 只在后端的查询声明里(orchestrator/src/finance/shortline/pages.ts)。
 */
import { backend, type PageBlock, type PageContext } from "@/lib/backend";
import type { EmotionResult } from "./types";

/** 一块数据:还在取 / 取完(结果可能为空,原因照实说) */
export type Panel<T> =
  | { state: "loading" }
  | { state: "done"; status: PageBlock["status"]; result: T | null; why: string; settled: boolean | null; cached: boolean; fetched_at: string | null };

export const LOADING = { state: "loading" } as const;

/** 取数层的报错带着异常类名(「DataNotAvailable: 2026-10-04 不是交易日」),给人看时去掉 */
export function cleanReason(s: string): string {
  return s.replace(/^[A-Za-z_][\w.]*(Error|Exception|NotAvailable|Timeout)?:\s*/, "").trim();
}

/** 块没取到的原因:主源抛错 / 信封写的原因 / 信封里第一条错误 */
export function blockWhy(b: PageBlock | undefined): string {
  if (!b) return "这一块没有返回";
  const env = b.envelope as { reason?: unknown; missing?: { reason?: unknown }[]; errors?: { error?: unknown }[] } | undefined;
  const parts = [
    b.error,
    typeof env?.reason === "string" ? env.reason : "",
    Array.isArray(env?.missing) ? String(env!.missing[0]?.reason ?? "") : "",
    Array.isArray(env?.errors) ? String(env!.errors[0]?.error ?? "") : "",
  ];
  const why = parts.find((p) => typeof p === "string" && p.trim());
  return why ? cleanReason(why).slice(0, 200) : "上游没回数据";
}

/** 页面块 → 面板。结果在信封的 extra.result;failed 时结果作废,只留原因 */
export function panelOf<T>(b: PageBlock | undefined): Panel<T> {
  if (!b) return { state: "done", status: "missing", result: null, why: "这一块没有返回", settled: null, cached: false, fetched_at: null };
  const raw = b.status === "ok" || b.status === "partial" ? (b.envelope?.extra as { result?: unknown } | undefined)?.result : undefined;
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { settled?: unknown }) : null;
  const result = obj ? (obj as T) : null;
  const settled = typeof obj?.settled === "boolean" ? obj.settled : null;
  return {
    state: "done", status: b.status, result, settled,
    why: result ? "" : blockWhy(b),
    cached: !!b.cached, fetched_at: b.fetched_at ?? null,
  };
}

/** 选的日子本身不能复盘(节假日 / 还没到):换哪一块都一样,不必再取、也别叫人刷新重试 */
export function badDayReason(p: Panel<unknown>): string | null {
  return p.state === "done" && !p.result && /(不是交易日|还没到)$/.test(p.why) ? p.why : null;
}

const failed = (e: unknown): Panel<never> => ({
  state: "done", status: "missing", result: null, settled: null, cached: false, fetched_at: null,
  why: e instanceof Error ? e.message : String(e),
});

export interface DayHead { context: PageContext | null; contextError: string | null; day: string | null }

/** 第一步:业务日 + 情绪四项。`date` 不给 = 后端解析的默认那天 */
export async function loadEmotion(opts: { date?: string; refresh?: boolean }) {
  try {
    const page = await backend.page("shortline", { ...(opts.refresh ? { refresh: true } : {}), ...(opts.date ? { blockArgs: { emotion: { date: opts.date } } } : {}) });
    const ctx = page.context as (PageContext & { error?: string }) | null;
    const contextError = ctx && typeof ctx.error === "string" ? ctx.error : null;
    const emotion = panelOf<EmotionResult>(page.blocks.find((b) => b.id === "emotion"));
    const def = contextError ? null : ctx?.review_date ?? ctx?.last_trading_day ?? null;
    // 这一屏在看哪一天:用户选的 > 端点算的那天 > 后端解析的默认那天;都拿不到就是 null,不拿本地日期顶上
    const day = opts.date ?? (emotion.state === "done" ? emotion.result?.date : undefined) ?? def;
    return { head: { context: contextError ? null : ctx, contextError, day } as DayHead, emotion, defaultDay: def };
  } catch (e) {
    return { head: { context: null, contextError: e instanceof Error ? e.message : String(e), day: opts.date ?? null } as DayHead, emotion: failed(e), defaultDay: null };
  }
}

/** 第二步:同一天的其余面板,各自回来各自显示 */
export type BlockQuery = "shortline_facts" | "shortline_themes" | "shortline_cycle" | "shortline_ladder" | "shortline_rotation";

export async function loadBlocks(query: BlockQuery, ids: string[], date: string, refresh: boolean): Promise<Record<string, Panel<unknown>>> {
  try {
    const page = await backend.page(query, { ...(refresh ? { refresh: true } : {}), blockArgs: Object.fromEntries(ids.map((id) => [id, { date }])) });
    return Object.fromEntries(ids.map((id) => [id, panelOf(page.blocks.find((b) => b.id === id))]));
  } catch (e) {
    return Object.fromEntries(ids.map((id) => [id, failed(e)]));
  }
}
