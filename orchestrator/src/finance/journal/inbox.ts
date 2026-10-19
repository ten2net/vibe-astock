/**
 * 复查清单(移植自 VA `duanxian/inbox.py`「异常交易收件箱」):按客观条件筛出少数几笔值得回头看的交易,附上为什么进来。
 *
 * ⚠️ 判定基准全部来自用户自己:「仓位偏大」相对他自己的中位仓位,「持有偏久」相对他自己的中位持有天数,
 *    亏损上限用他写下的规矩。不塞行业标准,不排「严重程度」(按日期倒序),不给建议。
 * ⚠️ 最大浮盈浮亏类判定(扛过大幅浮亏、没吃到行情)只用**已缓存**的行情,一次网络请求都不发;
 *    没缓存的笔数如实报出来,提示先去「复查」页打开最大浮盈浮亏把行情存下来。
 * ⛔ 这些数据不进任何 AI 提示词。
 */
import type { Rules } from "./defs.ts";
import { median, pyRound } from "./num.ts";
import { pyFixed } from "./risk.ts";
import type { JournalRow } from "./rows.ts";

/** 偏离自己中位数多少倍算不寻常:不是行业标准,只是宽松的筛子,宁可少报 */
export const DEVIATION_X = 2;
/** 少于这么多笔不做「相对自己习惯」的判定(3 笔的中位数不是习惯) */
export const MIN_HISTORY = 8;
/** 中途浮亏深到这个程度(相对成本 %)算扛过大幅浮亏 */
export const DEEP_MAE = -8;
/** 捕获率低于这个值且行情本来有肉 = 看对了没吃到 */
export const LOW_CAPTURE = 0.3;
/** 只看最近这么多笔(VA 同):几百笔之后再往前翻的意义不大 */
export const INBOX_LIMIT = 500;

/** 一笔交易的最大浮盈浮亏(由 excursion 模块从缓存行情算出) */
export interface ExcursionLite { mfe_pct: number; mae_pct: number; realized_pct: number; capture_rate: number | null; same_day: boolean }
export interface InboxFlag { key: string; text: string }
export interface InboxItem { key: string; date: string; symbol: string; name: string; playbook: string | null; pnl_pct: number | null; note: string; closed: boolean; flags: InboxFlag[] }

const money0 = (x: number) => Math.round(pyRound(x, 0)).toLocaleString("en-US");
const g = (x: number) => String(x);

/**
 * @param rows VA 顺序(入场日新的在前)
 * @param excursions 已缓存行情算出的最大浮盈浮亏(按行 key);null = 这一类判定整个没做
 * @param excursionSkipped 卖光了、但行情没缓存所以跳过的笔数
 */
export function buildInbox(rows: readonly JournalRow[], rules: Rules, rulesDefault: boolean, excursions: ReadonlyMap<string, ExcursionLite> | null = null, excursionSkipped = 0) {
  const recent = rows.slice(0, INBOX_LIMIT);
  if (!recent.length) return { available: false as const, reason: "还没有交易记录" };
  const capOf = (r: JournalRow) => r.episode?.amount ?? null;
  const caps = recent.map(capOf).filter((c): c is number => !!c);
  const holds = recent.map((r) => r.hold_days).filter((h): h is number => h !== null);
  const medCap = caps.length >= MIN_HISTORY ? median(caps) : null;
  const medHold = holds.length >= MIN_HISTORY ? median(holds) : null;
  const items: InboxItem[] = [];
  for (const r of recent) {
    const flags: InboxFlag[] = [];
    const lim = rules.max_loss_per_trade_pct, pnl = r.pnl_pct;
    if (lim && pnl !== null && pnl < -lim) flags.push({ key: "over_loss_limit", text: `亏 ${pyFixed(pnl, 1)}%,超过你自己写的单笔上限 ${g(lim)}%` });
    const cap = capOf(r);
    if (medCap && cap && cap > medCap * DEVIATION_X) flags.push({ key: "oversized", text: `占用 ${money0(cap)} 元,是你中位仓位(${money0(medCap)})的 ${pyFixed(cap / medCap, 1)} 倍` });
    const hold = r.hold_days;
    if (medHold !== null && hold !== null && medHold > 0 && hold > medHold * DEVIATION_X) flags.push({ key: "held_long", text: `持有 ${hold} 天,是你中位持有(${g(medHold)} 天)的 ${pyFixed(hold / medHold, 1)} 倍` });
    if (r.as_planned === false) flags.push({ key: "unplanned", text: "自己标了「计划外」" });
    if (r.episode && !r.episode.closed && !r.planned_stop) flags.push({ key: "no_stop", text: "还在手上,但没写计划止损 —— 最坏情况无从估计" });
    const ex = excursions?.get(r.key);
    if (ex) {
      if (ex.mae_pct <= DEEP_MAE) flags.push({ key: "deep_mae", text: `中途最多浮亏 ${pyFixed(ex.mae_pct, 1)}%(${ex.realized_pct > 0 ? "最后还是赚的" : "最后亏了"})` });
      const cr = ex.capture_rate;
      if (cr !== null && cr < LOW_CAPTURE) flags.push({ key: "low_capture", text: `这段最多能赚 ${pyFixed(ex.mfe_pct, 1)}%,实际落袋 ${pyFixed(ex.realized_pct, 1)}%(吃到 ${pyFixed(cr * 100, 0)}%)${ex.same_day ? ";同日进出,最大浮盈只是上界" : ""}` });
    }
    if (flags.length) items.push({ key: r.key, date: r.date, symbol: r.symbol, name: r.name, playbook: r.playbook, pnl_pct: pnl, note: r.note, closed: r.episode ? r.episode.closed : true, flags });
  }
  // 按日期倒序(稳定排序),不按「我们觉得多严重」排 —— 那是替用户判断
  const ordered = items.map((it, i) => ({ it, i })).sort((a, b) => (a.it.date !== b.it.date ? (a.it.date < b.it.date ? 1 : -1) : a.i - b.i)).map((x) => x.it);
  const byFlag: Record<string, number> = {};
  for (const it of ordered) for (const f of it.flags) byFlag[f.key] = (byFlag[f.key] ?? 0) + 1;
  return {
    available: true as const,
    items: ordered,
    count: ordered.length,
    scanned: recent.length,
    by_flag: byFlag,
    baseline: { median_capital: medCap, median_hold_days: medHold, history_enough: medCap !== null, min_history: MIN_HISTORY },
    rules_is_default: rulesDefault,
    excursion_available: !!excursions && excursions.size > 0,
    excursion_skipped: excursionSkipped,
    excursion_hint: excursionSkipped ? `${excursionSkipped} 笔的行情还没缓存,扛大幅浮亏 / 没吃到行情这两类判定暂时跳过了 —— 打开「复查」里的最大浮盈浮亏会把行情存下来,之后刷新这里就有了。` : null,
    note: "判定基准全部来自你自己:仓位大不大、持有久不久是相对你自己的中位数,亏损上限用的是你写下的规矩。这里只说哪里不寻常,不说该怎么做。",
  };
}
