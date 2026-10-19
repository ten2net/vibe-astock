/**
 * 定时任务「短线收盘取数」:收盘后把当天定稿的几份短线数据先取好,存进取数快照。
 *
 * 情绪历史、明日验证、涨停样本、结构变化都按交易日逐天取;东财请求在进程之间统一限速(每次约 1.3 秒),
 * 第一次打开要等很久,而且东财这几张池只留约 29 个自然日 —— 当天不取,过了保留期就再也取不到。
 * 这里每个交易日收盘后取一次:以后打开页面读缓存,历史也越攒越长。不推送消息,只在定时任务里写一句结果。
 */
import type { JobContext, JobResult } from "../../notify.ts";
import { fetchEndpoint, type FetchResult, type ServiceContext } from "../../service.ts";
import { failedNote } from "../schedule.ts";

export const CLOSE_FETCH_ENDPOINTS: readonly { endpoint: string; label: string }[] = [
  { endpoint: "cn_shortline_daily", label: "每日情绪读数" },
  { endpoint: "cn_shortline_settled", label: "昨日涨停股今日表现" },
  { endpoint: "cn_shortline_structure", label: "涨停结构" },
  { endpoint: "cn_shortline_facts", label: "事实表" },
  { endpoint: "cn_shortline_board_ladder", label: "连板天梯" },
];

type Fetch = (ctx: ServiceContext, req: Parameters<typeof fetchEndpoint>[1]) => Promise<Pick<FetchResult, "envelope">>;

export async function shortlineCloseFetch(j: JobContext, fetch: Fetch = fetchEndpoint): Promise<JobResult> {
  const ok: string[] = [];
  const bad: string[] = [];
  // 一个一个取:东财本来就排队限速,并发只会让每个都更慢、更容易超时
  for (const t of CLOSE_FETCH_ENDPOINTS) {
    try {
      // 现取:当天如果白天看过没收盘的版本,这里要换成收盘后的定稿
      const r = await fetch(j.ctx, { endpoint: t.endpoint, args: { date: j.day }, consistency: { mode: "fresh" }, signal: j.signal });
      const status = (r.envelope as { status?: unknown }).status;
      if (status === "failed") bad.push(`${t.label}(${failedNote(r.envelope) || "没取到"})`);
      else ok.push(status === "partial" ? `${t.label}(部分)` : t.label);
    } catch (e) {
      if (j.signal.aborted) throw e;
      bad.push(`${t.label}(${e instanceof Error ? e.message.slice(0, 60) : "没取到"})`);
    }
  }
  // 全没取到才算失败(定时任务会隔 10 分钟再试);取到一部分照实写
  if (!ok.length) throw new Error(`${j.day} 的短线数据都没取到:${bad.join(";")}`);
  return { messages: [], note: `${j.day} 已取好:${ok.join("、")}${bad.length ? `;没取到:${bad.join(";")}` : ""}` };
}
