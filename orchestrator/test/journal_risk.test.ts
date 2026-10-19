import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_RULES, type Rules } from "../src/finance/journal/defs.ts";
import type { Episode } from "../src/finance/journal/episodes.ts";
import { buildInbox } from "../src/finance/journal/inbox.ts";
import { atRisk, discipline, equityCurve, rolling, vaOrder, violations } from "../src/finance/journal/risk.ts";
import type { JournalRow } from "../src/finance/journal/rows.ts";

let n = 0;
/** 只填风险计算会读的字段 */
function ep(f: Partial<Episode>): Episode {
  return {
    id: `e${(n += 1)}`, symbol: "600000", name: "", trade_ids: [], fills: [], from_opening: false, has_split: false, dividends: 0,
    created_at: "", first_buy: "2025-01-01", last_sell: null, closed: false, buy_shares: 0, sell_shares: 0, open_shares: 0,
    avg_cost: 10, amount: 10000, avg_sell: null, gross_pnl: null, fees: null, fees_are_estimated: null, realized_pnl: null,
    realized_by_date: null, realized_pct: null, hold_days: null, settlement_warning: null, ...f,
  };
}
function row(f: Partial<JournalRow> & { ep?: Partial<Episode> | null }): JournalRow {
  const { ep: e, ...rest } = f;
  const key = `r${(n += 1)}`;
  const episode = e === null ? null : ep({ symbol: rest.symbol ?? "600000", first_buy: rest.date ?? "2025-01-01", realized_pnl: rest.realized_pnl ?? null, hold_days: rest.hold_days ?? null, ...(e ?? {}) });
  return {
    key, kind: episode ? "episode" : "manual", symbol: "600000", name: "", date: "2025-01-01", created_at: `2026-01-01T00:00:${String(n % 60).padStart(2, "0")}.000Z`,
    episode, tag_id: null, playbook: null, as_planned: null, planned_stop: null, planned_target: null, plan_late: false, note: "",
    pnl_pct: null, realized_pnl: null, hold_days: null, ...rest,
  };
}
const rules = (f: Partial<Rules> = {}): Rules => ({ ...DEFAULT_RULES, ...f });

/**
 * 手算权益曲线(按最后卖出日):+100、−50、−30、+200、0、−10
 *   累计 100 / 50 / 20 / 220 / 220 / 210;最大回撤 80(从第 2 笔那天起);高点 220(第 5 笔那天,持平也算新高)
 *   胜率 2/5(持平不算);盈亏比 150/30 = 5;PF 300/90 = 3.33;最长连亏 2;去掉最好 1 笔 10、最好 3 笔 −90
 */
test("权益曲线:VA 口径逐项", () => {
  const pnls = [100, -50, -30, 200, 0, -10];
  const rows = pnls.map((p, i) => row({ date: "2025-02-01", realized_pnl: p, ep: { last_sell: `2025-02-${String(i + 2).padStart(2, "0")}`, closed: true } }));
  const e = equityCurve(vaOrder(rows));
  assert.equal(e.available, true);
  if (!e.available) return;
  assert.deepEqual(e.points.map((p) => p.cum_pnl), [100, 50, 20, 220, 220, 210]);
  assert.deepEqual(e.points.map((p) => p.drawdown), [0, 50, 80, 0, 0, 10]);
  assert.equal(e.net_pnl, 210);
  assert.equal(e.peak, 220);
  assert.equal(e.peak_date, "2025-02-06");
  assert.equal(e.current_drawdown, 10);
  assert.equal(e.max_drawdown, 80);
  assert.equal(e.max_drawdown_since, "2025-02-03");
  assert.equal(e.trades_since_peak, 1);
  assert.equal(e.longest_underwater, 2);
  assert.equal(e.win_rate, 0.4);
  assert.equal(e.avg_win, 150);
  assert.equal(e.avg_loss, -30);
  assert.equal(e.payoff_ratio, 5);
  assert.equal(e.profit_factor, 3.33);
  assert.equal(e.worst_losing_streak, 2);
  assert.equal(e.worst_trade, -50);
  assert.equal(e.net_without_best1, 10);
  assert.equal(e.net_without_best3, -90);
  assert.equal(e.best_trade_share, 0.952);
  assert.equal(e.date_note, "按平仓日排列");
  // 去掉最好 3 笔:第三好的不是 0 时也要扣(50、30、20、10 → 扣 100 剩 10)
  const e2 = equityCurve(vaOrder([50, 30, 20, 10].map((p, i) => row({ realized_pnl: p, ep: { last_sell: `2025-03-0${i + 1}`, closed: true } }))));
  assert.ok(e2.available && e2.net_without_best1 === 60 && e2.net_without_best3 === 10 && e2.best_trade_share === 0.455);
  // 没卖过的、补记都不进曲线
  assert.equal(equityCurve([row({ pnl_pct: 3, ep: null })]).available, false);
});

test("近 10/20/50 笔:样本不够标出来,不拿全部冒充;近 10 笔和终身的落差", () => {
  // 12 笔:前 2 笔大赚,后 10 笔一赚一亏
  const pnls = [500, 500, ...Array.from({ length: 10 }, (_, i) => (i % 2 ? -100 : 50))];
  const rows = pnls.map((p, i) => row({ date: "2025-03-01", realized_pnl: p, as_planned: i < 6 ? true : i < 9 ? false : null, ep: { last_sell: `2025-03-${String(i + 2).padStart(2, "0")}`, closed: true } }));
  const r = rolling(vaOrder(rows));
  assert.equal(r.available, true);
  if (!r.available) return;
  const w10 = r.windows["10"]!, w20 = r.windows["20"]!;
  assert.equal(w10.enough, true);
  assert.equal(w20.enough, false);
  assert.equal(w20.trades, 12); // 内容是全部,但标了不够
  assert.equal(w10.win_rate, 0.5);
  assert.equal(r.lifetime.win_rate, 0.583);
  assert.equal(r.win_rate_drift, -0.083);
  assert.equal(w10.profit_factor, 0.5); // 250 / 500
  assert.equal(r.lifetime.profit_factor, 2.5);
  assert.equal(r.profit_factor_drift, -2);
  assert.equal(w10.date_from, "2025-03-04");
  assert.equal(w10.execution_rate, 0.571); // 窗口里按计划 4、计划外 3
});

test("纪律归因:三组 + 只做按计划会怎样;胜率不算持平", () => {
  const rows = [
    row({ as_planned: true, pnl_pct: 5, realized_pnl: 500, ep: { last_sell: "2025-01-03", closed: true } }),
    row({ as_planned: true, pnl_pct: 0, realized_pnl: 0, ep: { last_sell: "2025-01-03", closed: true } }),
    row({ as_planned: false, pnl_pct: -4, realized_pnl: -300, ep: { last_sell: "2025-01-03", closed: true } }),
    row({ as_planned: null, pnl_pct: 2, ep: null }),
    row({ as_planned: true }), // 没卖过、没盈亏:不进
  ];
  const d = discipline(rows);
  assert.equal(d.available, true);
  if (!d.available) return;
  assert.deepEqual(d.planned, { count: 2, win_rate: 1, avg_pct: 2.5, net_pnl: 500 });
  assert.deepEqual(d.unplanned, { count: 1, win_rate: 0, avg_pct: -4, net_pnl: -300 });
  assert.deepEqual(d.untagged, { count: 1, win_rate: 1, avg_pct: 2, net_pnl: null });
  assert.equal(d.execution_rate, 0.667);
  assert.deepEqual(d.what_if_only_planned, { actual_net: 200, planned_only_net: 500, cost_of_indiscipline: -300 });
});

test("规矩逐条检查:单日亏损按卖出日 / 同时持仓按代码与区间 / 单日开仓 / 单笔亏损 / 连亏之后;每条报查没查", () => {
  const r = rules({ max_positions: 1, max_trades_per_day: 1, max_loss_per_day_pct: 1, pause_after_losses: 2, max_unplanned_ratio: 0.5 });
  const rows = vaOrder([
    row({ symbol: "600001", name: "甲", date: "2025-01-02", pnl_pct: -6, realized_pnl: -150, as_planned: false, ep: { last_sell: "2025-01-05", closed: true, realized_by_date: { "2025-01-05": -150 } } }),
    row({ symbol: "600002", date: "2025-01-02", pnl_pct: 2, realized_pnl: 50, as_planned: true, ep: { last_sell: "2025-01-03", closed: true, realized_by_date: { "2025-01-03": 50 } } }),
    row({ symbol: "600003", date: "2025-01-04" }),
    row({ symbol: "600009", date: "2025-01-04", ep: { first_buy: "2025-01-04", last_sell: "2025-01-04", closed: true, realized_by_date: { "2025-01-04": 0 } }, pnl_pct: 0, realized_pnl: 0 }),
    row({ date: "2025-01-06", pnl_pct: -3, ep: null }),
    row({ date: "2025-01-07", pnl_pct: -1, ep: null }),
    row({ date: "2025-01-08", pnl_pct: 4, ep: null }),
    row({ date: "2025-01-09", pnl_pct: 0, ep: null }),
  ]);
  const v = violations(rows, r, false, 10000);
  assert.equal(v.available, true);
  if (!v.available) return;
  const got = v.violations.map((x) => `${x.rule}@${x.date}:${x.actual}`).sort();
  assert.deepEqual(got, [
    "max_loss_per_day_pct@2025-01-05:-1.5",
    "max_loss_per_trade_pct@2025-01-02:-6",
    "max_positions@2025-01-02:2",
    "max_positions@2025-01-04:2", // 当日进出的 600009 不占仓位;600002 在 1/3 卖出当天已不算
    "max_trades_per_day@2025-01-02:2",
    "max_trades_per_day@2025-01-04:2",
  ]);
  assert.equal(v.violation_count, 6);
  assert.match(v.rule_status.max_positions!, /^unavailable:有没有成交明细的补记/);
  assert.equal(v.rule_status.max_loss_per_day_pct, "checked");
  assert.deepEqual(v.unchecked, ["max_positions"]);
  // 1/2 那天计划外 1/2 = 0.5,不超过 0.5
  assert.ok(!v.violations.some((x) => x.rule === "max_unplanned_ratio"));
  // 连亏 2 笔之后:按入场日排 −6、2、−3、−1、【4】、0
  assert.deepEqual(v.after_loss_streak, { threshold: 2, trades: 1, avg_pct: 4, win_rate: 1 });
  // 没填账户规模:单日亏损这条不查,标出来(不是「没违反」)
  const noBase = violations(rows, r, false, null);
  assert.ok(noBase.available && /没填账户规模/.test(noBase.rule_status.max_loss_per_day_pct!));
  assert.ok(noBase.available && !noBase.violations.some((x) => x.rule === "max_loss_per_day_pct"));
  const noTags = violations([row({ pnl_pct: 1, ep: null })], r, true, null);
  assert.ok(noTags.available && noTags.unchecked.includes("max_unplanned_ratio") && noTags.is_default_rules);
});

test("在险资金:有止损的加总,没写止损的单列且总数标下限;止损高于成本算 0;占账户比例只用填的规模", () => {
  const rows = vaOrder([
    row({ symbol: "600003", name: "丙", date: "2025-01-04", planned_stop: 9.5, ep: { open_shares: 1000, avg_cost: 10 } }),
    row({ symbol: "600004", name: "丁", date: "2025-01-05", ep: { open_shares: 500, avg_cost: 20 } }),
    row({ symbol: "600005", date: "2025-01-06", planned_stop: 11, ep: { open_shares: 100, avg_cost: 10 } }),
    row({ symbol: "600006", date: "2025-01-01", ep: { open_shares: 0, closed: true, last_sell: "2025-01-02" } }),
    row({ date: "2025-01-01", pnl_pct: 1, ep: null }),
  ]);
  const a = atRisk(rows, rules({ max_positions: 2, max_loss_per_trade_pct: 4 }), false, 10000);
  assert.equal(a.available, true);
  if (!a.available) return;
  assert.deepEqual(a.positions.map((p) => [p.symbol, p.capital, p.at_risk, p.at_risk_pct, p.bounded]), [
    ["600003", 10000, 500, 5, true], ["600004", 10000, null, null, false], ["600005", 1000, 0, 0, true],
  ]);
  assert.equal(a.total_at_risk, 500);
  assert.equal(a.total_capital, 21000);
  assert.equal(a.unbounded_count, 1);
  assert.equal(a.unbounded_capital, 10000);
  assert.equal(a.at_risk_of_equity_pct, 5);
  assert.equal(a.capital_of_equity_pct, 210);
  assert.deepEqual(a.over_per_trade_limit, [{ name: "丙", code: "600003", pct_of_equity: 5 }]);
  assert.deepEqual(a.over_position_limit, { actual: 3, limit: 2 });
  assert.match(a.unbounded_note!, /另有 1 笔没写计划止损、占用本金 10,000 元.*下限/);
  const noBase = atRisk(rows, rules(), true, null);
  assert.ok(noBase.available && noBase.at_risk_of_equity_pct === null && /填了账户规模/.test(noBase.equity_base_hint!));
  assert.equal(atRisk([row({ pnl_pct: 1, ep: null })], rules(), true, null).available, false);
});

test("复查清单:基准全部来自自己(中位仓位、中位持有,样本够 8 笔才比);按日期倒序", () => {
  const base = Array.from({ length: 8 }, (_, i) => row({ date: `2025-04-${String(i + 1).padStart(2, "0")}`, hold_days: 1, pnl_pct: 1, realized_pnl: 10, ep: { amount: 10000, closed: true, last_sell: "2025-04-20" } }));
  const big = row({ date: "2025-04-10", hold_days: 1, pnl_pct: -6, realized_pnl: -1800, ep: { amount: 30000, closed: true, last_sell: "2025-04-11" } });
  const long = row({ date: "2025-04-12", hold_days: 5, pnl_pct: 1, realized_pnl: 100, as_planned: false, ep: { amount: 10000, closed: true, last_sell: "2025-04-17" } });
  const open = row({ date: "2025-04-15", ep: { amount: 10000 } });
  const ib = buildInbox(vaOrder([...base, big, long, open]), rules(), true);
  assert.equal(ib.available, true);
  if (!ib.available) return;
  assert.deepEqual(ib.items.map((it) => [it.date, it.flags.map((f) => f.key)]), [
    ["2025-04-15", ["no_stop"]],
    ["2025-04-12", ["held_long", "unplanned"]],
    ["2025-04-10", ["over_loss_limit", "oversized"]],
  ]);
  assert.deepEqual(ib.baseline, { median_capital: 10000, median_hold_days: 1, history_enough: true, min_history: 8 });
  assert.match(ib.items[2]!.flags[1]!.text, /占用 30,000 元,是你中位仓位\(10,000\)的 3\.0 倍/);
  assert.deepEqual(ib.by_flag, { no_stop: 1, held_long: 1, unplanned: 1, over_loss_limit: 1, oversized: 1 });
  // 样本不够 8 笔:不做「相对自己」的判定
  const few = buildInbox(vaOrder([big, long]), rules(), true);
  assert.ok(few.available && few.baseline.median_capital === null && few.items.every((it) => !it.flags.some((f) => f.key === "oversized" || f.key === "held_long")));
  // 最大浮盈浮亏(只用缓存):扛过大幅浮亏、没吃到行情
  const ex = new Map([[big.key, { mfe_pct: 10, mae_pct: -9, realized_pct: -6, capture_rate: -0.6, same_day: false }]]);
  const withEx = buildInbox(vaOrder([...base, big]), rules(), true, ex, 3);
  assert.ok(withEx.available);
  const flags = withEx.available ? withEx.items.find((it) => it.key === big.key)!.flags.map((f) => f.key) : [];
  assert.deepEqual(flags, ["over_loss_limit", "oversized", "deep_mae", "low_capture"]);
  assert.ok(withEx.available && withEx.excursion_skipped === 3 && /3 笔的行情还没缓存/.test(withEx.excursion_hint!));
});
