/**
 * 风险与纪律(移植自 VA `duanxian/risk.py` 和 `at_risk.py`):权益曲线、近 10/20/50 笔、纪律归因、规矩逐条检查、在险资金。
 *
 * ⚠️ 这里只对照**用户自己写下的规矩**和他自己的交易,不替他判断该不该交易、止损该放哪。
 * ⛔ 这些数据不进任何 AI 提示词。
 * 🔴 VA 口径(改之前先读):
 *    - 权益曲线、滚动窗口按**最后卖出日**排(盈亏在那天落地);有卖出就算(还没卖完的那部分不算浮盈)。
 *    - 累计盈亏逐笔相加(VA 就是普通浮点累加,对账要同一个加法顺序);胜率不算持平。
 *    - 单日亏损按每笔卖出发生的那天算(realized_by_date),分母只能是用户填的账户规模,没填就不查、标出来。
 *    - 同时持仓按**代码**、用持有区间 [买入日, 卖光日) 判断:卖出当天不算,当日进出不占仓位。
 *    - 每条规矩都报「查了没有」:没查和查了没违反是两回事。
 *    - 没写计划止损的持仓,在险是「未知」不是 0:不进总数,单独报个数和本金,总数标成下限。
 * 🔴 和 VA 不同的地方:
 *    - 纪律归因里各组的胜率、连亏后那几笔的胜率:VA 把持平算进分母,和它自己「胜率不算持平」的约定不一致,这里统一不算持平。
 *    - 补记(没有成交明细)一律当「缺日期」:VA 里没填盈亏的补记会被当成从那天起一直持有,这里没有这种记录(持仓都在交易流水里)。
 */
import { RULE_LABELS, type Rules } from "./defs.ts";
import { mean, pyRound, sum } from "./num.ts";
import type { JournalRow } from "./rows.ts";

/** 和 Python f"{x:.{n}f}" 同样的写法(恰好一半取偶),用在说明文字里 */
export const pyFixed = (x: number, n: number) => pyRound(x, n).toFixed(n);
const money0 = (x: number) => Math.round(pyRound(x, 0)).toLocaleString("en-US");

/** VA 的列表顺序:入场日新的在前,同一天后录的在前。各项计算按这个顺序遍历(浮点累加顺序要和 VA 一样) */
export function vaOrder(rows: readonly JournalRow[]): JournalRow[] {
  return [...rows].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.created_at !== b.created_at ? (a.created_at < b.created_at ? 1 : -1) : 0));
}

const exitDay = (r: JournalRow) => r.episode?.last_sell ?? r.date;
/** 有已实现盈亏的,按最后卖出日 → 录入时间排(稳定排序,同键保持 VA 列表顺序) */
function closedByExit(rows: readonly JournalRow[]): JournalRow[] {
  return rows.filter((r) => r.realized_pnl !== null)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const da = exitDay(a.r), db = exitDay(b.r);
      if (da !== db) return da < db ? -1 : 1;
      if (a.r.created_at !== b.r.created_at) return a.r.created_at < b.r.created_at ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.r);
}
const dateNote = (rows: readonly JournalRow[]) => (rows.some((r) => !r.episode?.last_sell) ? "缺平仓日期的记录按录入日排列" : "按平仓日排列");

/* ---------------- 权益曲线 ---------------- */

export function equityCurve(rows: readonly JournalRow[]) {
  const closed = closedByExit(rows);
  if (!closed.length) return { available: false as const, reason: "还没有已平仓且填了成交明细的交易" };
  const points: { date: string; cum_pnl: number; pnl: number; drawdown: number }[] = [];
  let cum = 0, peak = 0, peakDate: string | null = null, maxDd = 0, maxDdFrom: string | null = null, ddStart: string | null = null;
  let longest = 0, under = 0;
  for (const r of closed) {
    const pnl = r.realized_pnl!;
    cum += pnl;
    const d = exitDay(r);
    if (cum >= peak) { peak = cum; peakDate = d; under = 0; ddStart = null; }
    else {
      under += 1; longest = Math.max(longest, under);
      if (ddStart === null) ddStart = d;
      const dd = peak - cum;
      if (dd > maxDd) { maxDd = dd; maxDdFrom = ddStart; }
    }
    points.push({ date: d, cum_pnl: pyRound(cum, 2), pnl: pyRound(pnl, 2), drawdown: pyRound(peak - cum, 2) });
  }
  const pnls = closed.map((r) => r.realized_pnl!);
  const wins = pnls.filter((v) => v > 0), losses = pnls.filter((v) => v < 0);
  let streak = 0, worst = 0;
  for (const v of pnls) { streak = v < 0 ? streak + 1 : 0; worst = Math.max(worst, streak); }
  const top = [...pnls].sort((a, b) => b - a);
  return {
    available: true as const,
    points,
    date_note: dateNote(closed),
    trades: closed.length,
    net_pnl: pyRound(cum, 2),
    peak: pyRound(peak, 2),
    peak_date: peakDate,
    current_drawdown: pyRound(peak - cum, 2),
    max_drawdown: pyRound(maxDd, 2),
    max_drawdown_since: maxDdFrom,
    /** 多久没创新高(按笔数,不是日历天) */
    trades_since_peak: under,
    longest_underwater: longest,
    win_rate: wins.length || losses.length ? pyRound(wins.length / (wins.length + losses.length), 3) : null,
    avg_win: wins.length ? pyRound(mean(wins), 2) : null,
    avg_loss: losses.length ? pyRound(mean(losses), 2) : null,
    payoff_ratio: wins.length && losses.length ? pyRound(mean(wins) / Math.abs(mean(losses)), 2) : null,
    profit_factor: losses.length && sum(losses) ? pyRound(sum(wins) / Math.abs(sum(losses)), 2) : null,
    worst_losing_streak: worst,
    worst_trade: pyRound(Math.min(...pnls), 2),
    /** 去掉最好的 1 / 3 笔之后还剩多少:最能看出是不是靠一两笔运气 */
    net_without_best1: pyRound(cum - (top[0] ?? 0), 2),
    net_without_best3: pyRound(cum - sum(top.slice(0, 3)), 2),
    best_trade_share: top.length && cum > 0 ? pyRound(top[0]! / cum, 3) : null,
  };
}

/* ---------------- 近 10 / 20 / 50 笔 ---------------- */

export const WINDOWS = [10, 20, 50] as const;

function windowStats(closed: readonly JournalRow[]) {
  const pnls = closed.map((r) => r.realized_pnl!);
  if (!pnls.length) return { trades: 0 };
  const wins = pnls.filter((v) => v > 0), losses = pnls.filter((v) => v < 0);
  const decided = wins.length + losses.length;
  const grossWin = sum(wins), grossLoss = -sum(losses);
  const planned = closed.filter((r) => r.as_planned === true).length, unplanned = closed.filter((r) => r.as_planned === false).length;
  return {
    trades: pnls.length,
    net_pnl: pyRound(sum(pnls), 2),
    win_rate: decided ? pyRound(wins.length / decided, 3) : null,
    avg_win: wins.length ? pyRound(grossWin / wins.length, 2) : null,
    avg_loss: losses.length ? pyRound(-grossLoss / losses.length, 2) : null,
    payoff_ratio: wins.length && losses.length ? pyRound((grossWin / wins.length) / (grossLoss / losses.length), 2) : null,
    profit_factor: grossLoss > 0 ? pyRound(grossWin / grossLoss, 2) : null,
    execution_rate: planned || unplanned ? pyRound(planned / (planned + unplanned), 3) : null,
    date_note: dateNote(closed),
    date_from: exitDay(closed[0]!),
    date_to: exitDay(closed[closed.length - 1]!),
  };
}
type WindowStats = ReturnType<typeof windowStats> & { win_rate?: number | null; profit_factor?: number | null };

export function rolling(rows: readonly JournalRow[]) {
  const closed = closedByExit(rows);
  if (!closed.length) return { available: false as const, reason: "还没有已平仓且填了成交明细的交易" };
  const lifetime = windowStats(closed) as WindowStats;
  const windows: Record<string, WindowStats & { window: number; enough: boolean }> = {};
  // 样本不够时不拿全部冒充那个窗口:只有 12 笔却报「近 50 笔」,会让人以为打法在 50 笔的尺度上验证过
  for (const n of WINDOWS) windows[String(n)] = { ...(windowStats(closed.slice(-n)) as WindowStats), window: n, enough: closed.length >= n };
  const w10 = windows["10"]!;
  const out: Record<string, unknown> = { available: true, windows, lifetime };
  if (w10.enough && w10.win_rate != null && lifetime.win_rate != null) out.win_rate_drift = pyRound(w10.win_rate - lifetime.win_rate, 3);
  if (w10.enough && w10.profit_factor != null && lifetime.profit_factor != null) out.profit_factor_drift = pyRound(w10.profit_factor - lifetime.profit_factor, 2);
  out.note = "10 笔看状态、20 笔看节奏、50 笔看打法是否还成立。终身统计会把最近的退化藏起来 —— 前面赚够了,最近一直亏,终身数字照样漂亮。";
  return out as { available: true; windows: typeof windows; lifetime: WindowStats; win_rate_drift?: number; profit_factor_drift?: number; note: string };
}

/* ---------------- 纪律归因 ---------------- */

/** 胜率不算持平(全页统一口径;VA 这里原先把持平算进分母) */
const winRate = (vals: readonly number[]) => {
  const w = vals.filter((v) => v > 0).length, decided = w + vals.filter((v) => v < 0).length;
  return decided ? pyRound(w / decided, 3) : null;
};

export function discipline(rows: readonly JournalRow[]) {
  const scored = rows.filter((r) => r.pnl_pct !== null || r.realized_pnl !== null);
  if (!scored.length) return { available: false as const, reason: "还没有可统计的交易" };
  const bucket = (rs: readonly JournalRow[]) => {
    const pcts = rs.map((r) => r.pnl_pct).filter((v): v is number => v !== null);
    const moneys = rs.map((r) => r.realized_pnl).filter((v): v is number => v !== null);
    return { count: rs.length, win_rate: winRate(pcts), avg_pct: pcts.length ? pyRound(mean(pcts), 2) : null, net_pnl: moneys.length ? pyRound(sum(moneys), 2) : null };
  };
  const planned = scored.filter((r) => r.as_planned === true);
  const unplanned = scored.filter((r) => r.as_planned === false);
  const untagged = scored.filter((r) => r.as_planned === null);
  const allMoney = scored.map((r) => r.realized_pnl).filter((v): v is number => v !== null);
  const plannedMoney = planned.map((r) => r.realized_pnl).filter((v): v is number => v !== null);
  return {
    available: true as const,
    planned: bucket(planned), unplanned: bucket(unplanned), untagged: bucket(untagged),
    execution_rate: planned.length || unplanned.length ? pyRound(planned.length / (planned.length + unplanned.length), 3) : null,
    /** 只做按计划的交易,账户会是什么样 */
    what_if_only_planned: {
      actual_net: allMoney.length ? pyRound(sum(allMoney), 2) : null,
      planned_only_net: plannedMoney.length ? pyRound(sum(plannedMoney), 2) : null,
      cost_of_indiscipline: allMoney.length && plannedMoney.length ? pyRound(sum(allMoney) - sum(plannedMoney), 2) : null,
    },
    note: "「计划外」要你自己在记录时标 —— 没标的归到未标注,不猜。这不是市场分析,是你自己的行为统计。",
  };
}

/* ---------------- 规矩逐条检查 ---------------- */

export interface Violation { date: string; rule: string; label: string; limit: number; actual: number; detail: string }

export function violations(rows: readonly JournalRow[], rules: Rules, rulesDefault: boolean, equityBase: number | null) {
  if (!rows.length) return { available: false as const, reason: "还没有交易记录" };
  const checked: Record<string, string> = {};
  const found: Violation[] = [];

  // 单日最大亏损:按每笔卖出发生的那天汇总净盈亏(逐笔相加,和 VA 同顺序)
  const dayPnl = new Map<string, number>();
  for (const r of rows) {
    const by = r.episode?.realized_by_date;
    if (by && Object.keys(by).length) for (const [d, v] of Object.entries(by)) dayPnl.set(d, (dayPnl.get(d) ?? 0) + v);
  }
  if (!dayPnl.size) checked.max_loss_per_day_pct = "unavailable:没有带成交明细的已平仓交易,算不出单日盈亏";
  else if (!equityBase) checked.max_loss_per_day_pct = "unavailable:没填账户规模,单日亏损占比没有分母";
  else {
    checked.max_loss_per_day_pct = "checked";
    const cap = Math.abs(rules.max_loss_per_day_pct);
    for (const [day, pnl] of [...dayPnl.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const pct = (pnl / equityBase) * 100;
      if (pct < -cap) found.push({ date: day, rule: "max_loss_per_day_pct", label: RULE_LABELS.max_loss_per_day_pct, limit: -cap, actual: pyRound(pct, 2), detail: `${day} 当日净亏 ${pyRound(pnl, 2)} 元,占账户 ${pyRound(pct, 2)}%` });
    }
  }

  // 最多同时持仓:按代码、[买入日, 卖光日)
  const spans: { code: string; start: string; end: string | null }[] = [];
  let undated = 0;
  for (const r of rows) {
    const ep = r.episode;
    if (!ep) { undated += 1; continue; }
    spans.push({ code: ep.symbol, start: ep.first_buy, end: ep.closed ? ep.last_sell : null });
  }
  if (!spans.length) checked.max_positions = "unavailable:没有可用的建仓/平仓日期";
  else {
    checked.max_positions = "checked";
    const capN = Math.trunc(rules.max_positions);
    const days = [...new Set(spans.flatMap((s) => [s.start, s.end]).filter((d): d is string => !!d))].sort();
    for (const day of days) {
      const holding = new Set(spans.filter((s) => s.start <= day && (s.end === null || day < s.end)).map((s) => s.code));
      if (holding.size > capN) found.push({ date: day, rule: "max_positions", label: RULE_LABELS.max_positions, limit: capN, actual: holding.size, detail: `${day} 同时持有 ${holding.size} 只` });
    }
  }
  if (undated) checked.max_positions = "unavailable:有没有成交明细的补记(缺买入、卖出日期),未能完整核对历史持仓上限;已确认的超限仍展示,结果可能漏计";

  const byDay = new Map<string, JournalRow[]>();
  for (const r of rows) byDay.set(r.date, [...(byDay.get(r.date) ?? []), r]);
  for (const [day, rs] of [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (rs.length > rules.max_trades_per_day) found.push({ date: day, rule: "max_trades_per_day", label: RULE_LABELS.max_trades_per_day, limit: rules.max_trades_per_day, actual: rs.length, detail: `${day} 开仓 ${rs.length} 笔` });
    for (const r of rs) {
      const p = r.pnl_pct;
      if (p !== null && p < -Math.abs(rules.max_loss_per_trade_pct)) found.push({ date: day, rule: "max_loss_per_trade_pct", label: RULE_LABELS.max_loss_per_trade_pct, limit: -Math.abs(rules.max_loss_per_trade_pct), actual: p, detail: `${r.name || r.symbol} 亏 ${p}%` });
    }
    const tagged = rs.filter((r) => r.as_planned !== null);
    if (tagged.length) {
      const un = tagged.filter((r) => r.as_planned === false).length;
      const ratio = un / tagged.length;
      if (ratio > rules.max_unplanned_ratio) found.push({ date: day, rule: "max_unplanned_ratio", label: RULE_LABELS.max_unplanned_ratio, limit: rules.max_unplanned_ratio, actual: pyRound(ratio, 3), detail: `${day} 计划外 ${un}/${tagged.length} 笔` });
    }
  }

  // 连亏到自己的阈值之后还继续做的那些笔:只陈述历史,不下「该停手」的结论
  const scored = rows.map((r, i) => ({ r, i })).filter((x) => x.r.pnl_pct !== null)
    .sort((a, b) => (a.r.date !== b.r.date ? (a.r.date < b.r.date ? -1 : 1) : a.r.created_at !== b.r.created_at ? (a.r.created_at < b.r.created_at ? -1 : 1) : a.i - b.i))
    .map((x) => x.r.pnl_pct!);
  const limit = Math.trunc(rules.pause_after_losses);
  const after: number[] = [];
  let streak = 0;
  for (const v of scored) { if (streak >= limit) after.push(v); streak = v < 0 ? streak + 1 : 0; }
  checked.max_trades_per_day = "checked";
  checked.max_loss_per_trade_pct = "checked";
  checked.max_unplanned_ratio = rows.some((r) => r.as_planned !== null) ? "checked" : "unavailable:还没有标注过「按计划 / 计划外」的交易";
  checked.pause_after_losses = "checked";
  return {
    available: true as const,
    rules: { ...rules },
    is_default_rules: rulesDefault,
    /** 每条规矩查了没有:界面要把「没查」和「查了没违反」分开显示 */
    rule_status: checked,
    unchecked: Object.entries(checked).filter(([, v]) => v.startsWith("unavailable")).map(([k]) => k),
    violations: found,
    violation_count: found.length,
    after_loss_streak: { threshold: limit, trades: after.length, avg_pct: after.length ? pyRound(mean(after), 2) : null, win_rate: winRate(after) },
  };
}

/* ---------------- 在险资金 ---------------- */

export interface AtRiskPosition {
  key: string; symbol: string; name: string; date: string; playbook: string | null;
  shares: number; avg_cost: number; capital: number;
  planned_stop: number | null; planned_target: number | null; plan_late: boolean;
  at_risk: number | null; at_risk_pct: number | null; bounded: boolean;
}

export function atRisk(rows: readonly JournalRow[], rules: Rules, rulesDefault: boolean, equityBase: number | null) {
  const pos: AtRiskPosition[] = [];
  for (const r of rows) {
    const ep = r.episode;
    if (!ep || ep.closed) continue;
    const shares = ep.open_shares, cost = ep.avg_cost;
    if (shares <= 0 || !cost) continue;
    const stop = r.planned_stop;
    const item: AtRiskPosition = {
      key: r.key, symbol: r.symbol, name: r.name, date: ep.first_buy, playbook: r.playbook,
      shares, avg_cost: cost, capital: pyRound(cost * shares, 2),
      planned_stop: stop, planned_target: r.planned_target, plan_late: r.plan_late,
      at_risk: null, at_risk_pct: null, bounded: false,
    };
    if (stop) {
      // 止损高于成本时在险是 0(已锁定盈利),不算负数 —— 负数会把总数拉低,看着像风险更小
      item.at_risk = pyRound(Math.max(0, (cost - stop) * shares), 2);
      item.at_risk_pct = pyRound(Math.max(0, 1 - stop / cost) * 100, 2);
      item.bounded = true;
    }
    pos.push(item);
  }
  if (!pos.length) return { available: false as const, reason: "当前没有还没卖完的持仓" };
  pos.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const bounded = pos.filter((p) => p.bounded), unbounded = pos.filter((p) => !p.bounded);
  const totalRisk = pyRound(sum(bounded.map((p) => p.at_risk!)), 2);
  const totalCapital = pyRound(sum(pos.map((p) => p.capital)), 2);
  const unboundedCapital = pyRound(sum(unbounded.map((p) => p.capital)), 2);
  const codes = new Set(pos.map((p) => p.symbol)).size;
  const out = {
    available: true as const,
    positions: pos,
    position_count: pos.length,
    total_capital: totalCapital,
    /** 只加有边界的;没写止损的不能当 0 混进来 */
    total_at_risk: totalRisk,
    bounded_count: bounded.length,
    unbounded_count: unbounded.length,
    unbounded_capital: unboundedCapital,
    equity_base: equityBase,
    rules: { max_loss_per_trade_pct: rules.max_loss_per_trade_pct, max_positions: rules.max_positions, is_default: rulesDefault },
    at_risk_of_equity_pct: null as number | null,
    capital_of_equity_pct: null as number | null,
    over_per_trade_limit: null as { name: string; code: string; pct_of_equity: number }[] | null,
    equity_base_hint: null as string | null,
    over_position_limit: null as { actual: number; limit: number } | null,
    unbounded_note: null as string | null,
  };
  if (equityBase) {
    out.at_risk_of_equity_pct = pyRound((totalRisk / equityBase) * 100, 2);
    out.capital_of_equity_pct = pyRound((totalCapital / equityBase) * 100, 2);
    out.over_per_trade_limit = bounded.filter((p) => (p.at_risk! / equityBase) * 100 > rules.max_loss_per_trade_pct + 1e-9)
      .map((p) => ({ name: p.name, code: p.symbol, pct_of_equity: pyRound((p.at_risk! / equityBase) * 100, 2) }));
  } else out.equity_base_hint = "填了账户规模才能给占比 —— 绝对金额说明不了这个风险相对你的账户算大还是小。";
  if (codes > Math.trunc(rules.max_positions)) out.over_position_limit = { actual: codes, limit: Math.trunc(rules.max_positions) };
  if (unbounded.length) out.unbounded_note = `另有 ${unbounded.length} 笔没写计划止损、占用本金 ${money0(unboundedCapital)} 元,最坏情况无从估计 —— 它们没算进上面的总在险,所以那个数是下限。`;
  return out;
}
