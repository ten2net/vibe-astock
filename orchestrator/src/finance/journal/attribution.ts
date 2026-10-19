/**
 * 判断 vs 执行归因(移植自 VA `duanxian/attribution.py`):把「市场判断成没成立」和「自己赚没赚钱」交叉起来。
 *
 * 只看一层会得出错的结论:看对了却亏钱和看错了才亏钱,要改的地方不同(前者改执行,后者改判断)。
 *
 *              自己赚钱      自己亏钱
 *   判对了      顺风顺水      执行问题
 *   判错了      运气          判断问题
 * 「判错还赚钱」那格必须单独点出来,不能混进「总体盈利」里。
 *
 * 🔴 对齐哪一天:交易在 D 日入场,依据是 D-1 晚那份判断 ⇒ 交易的**入场日**对应条件的**被检验日**。
 *    不能按卖出日对齐:D 日买、D+2 日卖,按卖出日会去比 D+1 晚的判断 —— 那份判断没参与这笔决策。
 * 🔴 和 VA 不同:VA 的「判对没判对」来自情绪阶段回看;这里用短线复盘里写给下一场的**验证条件**对账结果
 *    (事后写的、暂定的不算,与「复盘 → 条件对账」同一份):判定了的条件过半成立 = 判对,不到一半 = 判错,
 *    正好一半或一条都判不了的日子不进四格。只覆盖条件对账能回看的最近约 60 个交易日。
 * ⛔ 这些数据不进任何 AI 提示词。
 */
import { localClock } from "../../notify.ts";
import { ServiceError, fetchEndpoint, type ServiceContext } from "../../service.ts";
import { klineBars } from "../abnormal.ts";
import { SCHEDULE_TZ } from "../schedule.ts";
import { shortlineVerify, type TrackDay } from "../shortline/verification.ts";
import { pyRound, realDay, sum } from "./num.ts";
import type { JournalRow } from "./rows.ts";
import { loadJournalData, computeJournal } from "./view.ts";

/** 四格。顺序别改,页面按 key 取 */
export const QUADRANTS = {
  right_win: "判对 + 赚钱",
  right_lose: "判对 + 亏钱",
  wrong_win: "判错 + 赚钱",
  wrong_lose: "判错 + 亏钱",
} as const;
export type Quadrant = keyof typeof QUADRANTS;
/** 少于这么多天,四格分布是噪声,不给倾向性描述 */
export const ATTR_MIN_DAYS = 8;
/** 只看最近这么多笔(VA 同) */
export const ATTR_LIMIT = 500;

export interface DayRead { set_date: string; decided: number; hit: number; verdict: "right" | "wrong" | "undecided" }

/** 条件对账 → 每个被检验日判对 / 判错 / 判不了 */
export function readsOf(days: readonly TrackDay[]): Map<string, DayRead> {
  const out = new Map<string, DayRead>();
  for (const d of days) {
    const verdict = d.decided > 0 && d.hit * 2 > d.decided ? "right" : d.decided > 0 && d.hit * 2 < d.decided ? "wrong" : "undecided";
    out.set(d.date, { set_date: d.set_date, decided: d.decided, hit: d.hit, verdict });
  }
  return out;
}

export interface AttrDay { date: string; pnl: number; trades: number; unplanned: number; set_date: string; decided: number; hit: number; right: boolean }

/**
 * @param rows VA 顺序(入场日新的在前);当天盈亏按这个顺序逐笔累加再四舍五入(和 VA 的浮点顺序一样)
 * @param reads 入场日 → 那天的判断对不对
 */
export function computeAttribution(rows: readonly JournalRow[], reads: ReadonlyMap<string, DayRead>) {
  const byDay = new Map<string, AttrDay>();
  let noAmount = 0, noRead = 0, undecided = 0;
  for (const r of rows.slice(0, ATTR_LIMIT)) {
    // 没有成交明细就没有金额:拿百分比按笔数平均会把 1 万的仓和 1 千的仓当成一样重
    const pnl = r.episode?.realized_pnl ?? null;
    if (pnl === null) { noAmount += 1; continue; }
    const read = reads.get(r.date);
    if (!read) { noRead += 1; continue; }
    if (read.verdict === "undecided") { undecided += 1; continue; }
    let b = byDay.get(r.date);
    if (!b) { b = { date: r.date, pnl: 0, trades: 0, unplanned: 0, set_date: read.set_date, decided: read.decided, hit: read.hit, right: read.verdict === "right" }; byDay.set(r.date, b); }
    b.pnl += pnl;
    b.trades += 1;
    if (r.as_planned === false) b.unplanned += 1;
  }
  const skipped = { skipped_no_amount: noAmount, skipped_no_read: noRead, skipped_undecided: undecided };
  if (!byDay.size) {
    return { available: false as const, ...skipped, reason: "没有能归因的交易日 —— 要有成交明细、已有卖出的交易,而且入场那天前一晚的复盘写了验证条件、已经对完账" };
  }
  const cells: Record<Quadrant, AttrDay[]> = { right_win: [], right_lose: [], wrong_win: [], wrong_lose: [] };
  for (const b of [...byDay.values()].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0))) {
    b.pnl = pyRound(b.pnl, 2);
    // 盈亏恰好为 0 的日子不进任何一格:硬塞进「亏钱」格会凭空造出执行问题(同战绩里「持平不进分母」)
    if (Math.abs(b.pnl) < 1e-6) continue;
    cells[`${b.right ? "right" : "wrong"}_${b.pnl > 0 ? "win" : "lose"}` as Quadrant].push(b);
  }
  const quadrants = Object.fromEntries((Object.keys(QUADRANTS) as Quadrant[]).map((k) => [k, { days: cells[k].length, pnl: pyRound(sum(cells[k].map((d) => d.pnl)), 2), days_list: cells[k].map((d) => d.date) }])) as Record<Quadrant, { days: number; pnl: number; days_list: string[] }>;
  const counted = Object.values(quadrants).reduce((n, q) => n + q.days, 0);
  return {
    available: true as const,
    days_counted: counted,
    enough_samples: counted >= ATTR_MIN_DAYS,
    min_days: ATTR_MIN_DAYS,
    quadrant_labels: QUADRANTS,
    quadrants,
    cells,
    ...skipped,
    note: "按入场日对齐:那天的操作依据是前一晚写给下一场的验证条件。判定了的条件过半成立算判对、不到一半算判错,正好一半的日子不算;盈亏为 0 的日子不进任何一格。",
  };
}

const KLINE_MAX_AGE_MS = 5 * 60 * 1000;
const prevWeekday = (day: string) => {
  const t = new Date(`${day}T00:00:00Z`);
  do t.setUTCDate(t.getUTCDate() - 1); while (t.getUTCDay() === 0 || t.getUTCDay() === 6);
  return t.toISOString().slice(0, 10);
};

/** 最近一个交易日(今天开盘了算今天);上证A股指数日 K 取不到时退回最近一个工作日 */
async function latestTradingDay(ctx: ServiceContext, today: string, signal: AbortSignal): Promise<string> {
  try {
    const k = await fetchEndpoint(ctx, { endpoint: "tx_kline", symbol: "sh000002", args: { count: 30 }, consistency: { mode: "prefer_cache", max_age_ms: KLINE_MAX_AGE_MS }, signal });
    const days = klineBars(ctx, k.envelope, k.out_dir).map((b) => b.date).filter((d) => d <= today);
    if (days.length) return days.at(-1)!;
  } catch (e) {
    if (signal.aborted) throw e;
  }
  const wd = new Date(`${today}T00:00:00Z`).getUTCDay();
  return wd === 0 || wd === 6 ? prevWeekday(today) : today;
}

/** `GET /view/journal_attribution?date=` —— 交易日志「复查」页的判断 vs 执行四格 */
export async function journalAttribution(ctx: ServiceContext, query: Record<string, string>, signal: AbortSignal, now = new Date()) {
  const today = localClock(now, SCHEDULE_TZ).day;
  if (query.date !== undefined && (!realDay(query.date) || query.date > today)) throw new ServiceError("bad_query", "date 要写成 YYYY-MM-DD,而且不能晚于今天");
  const d = loadJournalData(ctx);
  if (!d.settings.fees) return { available: false as const, reason: d.settings.problem ?? "交易日志设置有问题", gaps: [] as string[] };
  const date = query.date ?? await latestTradingDay(ctx, today, signal);
  const v = await shortlineVerify(ctx, { date }, signal, now);
  const reads = readsOf(v.track.days);
  const window = { from: v.track.from, to: v.track.to };
  if (![...reads.values()].some((r) => r.verdict !== "undecided")) {
    return { available: false as const, window, gaps: v.gaps, reason: "最近还没有对完账的验证条件(短线复盘里写给下一场的条件)—— 没有「判对没判对」,就没法做归因" };
  }
  const { rows } = computeJournal(d, d.settings.fees);
  return { ...computeAttribution(rows, reads), window, gaps: v.gaps };
}
