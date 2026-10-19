/**
 * 交易日志的「一笔交易」= 同一代码**从空仓买进到卖光的一轮**,由「我的股票」的交易流水推出来,不另存成交。
 * 结算口径移植自 Vibe AStock v2.0.0 `duanxian/journal.py::_settle`,同一批成交两边算出的数要逐项一致。
 *
 * 🔴 一份账:成交只在 `trade` 里。持有数量、哪几笔不参与计算,和持仓页(`holdings.ts` replayTrades)是同一个判断 ——
 *    先用 replayTrades 找出它跳过的流水(卖超、缺价格、B 股……),这里同样跳过并列出来,不另做一套规则。
 * 🔴 VA 口径(改之前先读):
 *    - 移动加权平均成本。卖出按卖出那一刻的均价结转,剩下的均价不变。
 *    - 盈亏 % 的分母是**不含费用**的买入成本(realized_cost);金额是净额(扣了买卖费用,买入费用按卖出比例结转)。
 *    - 成交没填费用的按费率估,标「估」。我的股票那边没填的按 0 算 —— 两页金额可能差几块钱。
 *    - `amount` 是这一轮**最多占用**的资金(不含费用),不是买入总额。
 *    - 按每笔卖出发生的那天记净盈亏(realized_by_date):分两天减仓时,单日亏损规则要能分开算。
 *    - 持有天数按自然日(第一笔买入 → 最后一笔卖出)。
 *    - 当天卖出超过开盘前持有的股数,标「没证明有隔夜底仓」:同日买卖不认定为可执行的 A 股做 T。
 * 🔴 和 VA 不同的地方(VA 没有这些):
 *    - 一轮在 VA 里是用户自己圈的一条记录,可以包含几轮进出;这里每回到空仓就是新的一笔。
 *    - 期初持仓也算一轮的开始(成本当买入价、费用 0),标出来:那天不是真实买入日。
 *    - 送转按比例改股数、总成本不变(同持仓页);现金分红单独记,不进盈亏(同持仓页)。
 * 只管 A 股股票(六位代码,不含 ETF、基金、债券、回购):费率、印花税、T+1 都是 A 股股票规则。其余流水不进交易日志,只报代码。
 *
 * 纯函数:不读文件、不取行情。
 */
import { replayOrder, replayTrades, type Trade } from "../holdings.ts";
import { estimateFee, type FeeConfig } from "./fees.ts";
import { daysBetween, pyRound, sum } from "./num.ts";

export const A_SHARE = /^\d{6}$/;
/**
 * 六位代码里不是股票的:1、5 开头的基金 / ETF / LOF / 债券 / 可转债 / 深市回购,沪市 01、02 开头的国债,204 开头的沪市国债逆回购。
 * 🔴 交易日志只算 A 股股票:ETF、债券混进来会算进股票的胜率和纪律统计,还会按股票扣印花税(审计 2026-10-11 Codex 范围 2 第 7 条)。
 *    持仓页照常算它们(那是资产),只是不进交易日志。B 股另由持仓页的规则提示。
 */
export const CN_NOT_STOCK = /^(?:[15]\d{5}|0[12]\d{4}|204\d{3})$/;
/** 能进交易日志的代码:A 股股票(六位代码、不是基金债券回购) */
export const isJournalSymbol = (symbol: string): boolean => A_SHARE.test(symbol) && !CN_NOT_STOCK.test(symbol);
export const JOURNAL_ONLY_STOCKS = "交易日志只管 A 股股票:代码要是 6 位数字,ETF、基金、债券、可转债、回购不记";
const EPS = 1e-8;
export const T0_WARNING = "部分卖出没证明有足够的隔夜底仓,不认定为可执行的 A 股做 T";

export interface EpisodeFill {
  trade_id: string;
  type: "opening" | "buy" | "sell";
  date: string;
  price: number;
  shares: number;
  /** 这笔用的费用:填了用填的,没填按费率估;期初持仓为 0 */
  fee: number;
  fee_estimated: boolean;
}

export interface Episode {
  /** 开这一轮的那笔流水的 id */
  id: string;
  symbol: string;
  name: string;
  /** 这一轮里的全部流水(含分红、送转) */
  trade_ids: string[];
  fills: EpisodeFill[];
  /** 从期初持仓开始:第一天不是真实买入日,持有天数偏短 */
  from_opening: boolean;
  has_split: boolean;
  /** 这一轮里到账的现金分红(元),不计入盈亏 */
  dividends: number;
  /** 开这一轮那笔流水的录入时间(同日入场时排先后用) */
  created_at: string;
  first_buy: string;
  last_sell: string | null;
  closed: boolean;
  buy_shares: number;
  sell_shares: number;
  open_shares: number;
  /** 还有持仓 = 当前均价;卖光了 = 已卖部分的成本均价 */
  avg_cost: number;
  amount: number;
  avg_sell: number | null;
  gross_pnl: number | null;
  fees: number | null;
  fees_are_estimated: boolean | null;
  realized_pnl: number | null;
  realized_by_date: Record<string, number> | null;
  realized_pct: number | null;
  hold_days: number | null;
  settlement_warning: string | null;
}

export interface EpisodeIssue { id: string; symbol: string; date: string; type: string; why: string }

export interface EpisodeResult {
  episodes: Episode[];
  /** 不参与计算的流水和原因(与持仓页同一个判断) */
  issues: EpisodeIssue[];
  /** 不是 A 股的代码个数(港美股不进交易日志) */
  skipped_non_a: string[];
  /** 没有任何一轮可挂的分红笔数(买入之前就到账的) */
  orphan_dividends: number;
}

interface Builder {
  id: string; symbol: string; name: string; created_at: string;
  trade_ids: string[]; fills: EpisodeFill[];
  from_opening: boolean; has_split: boolean; dividends: number;
  peak: number;
  gross: number; rCost: number; rShares: number; rFee: number;
  byDate: Map<string, number>;
  unverified: boolean;
}

interface Book {
  cur: Builder | null;
  last: Builder | null;
  /** 当前这一轮:股数、不含费用的总成本、还没结转的买入费用 */
  pos: number; cost: number; fee: number;
  /** 今天开盘前持有的股数(T+1 可卖) */
  sellable: number;
  day: string;
}

function finalize(b: Builder, pos: number, cost: number): Episode {
  const buys = b.fills.filter((f) => f.type !== "sell");
  const sells = b.fills.filter((f) => f.type === "sell");
  const buyShares = sum(buys.map((f) => f.shares));
  const sellShares = pyRound(sum(sells.map((f) => f.shares)), 2);
  const avg = pos > EPS ? cost / pos
    : b.rShares > 0 ? b.rCost / b.rShares
      : sum(buys.map((f) => f.price * f.shares)) / buyShares;
  const ep: Episode = {
    id: b.id, symbol: b.symbol, name: b.name, trade_ids: b.trade_ids, fills: b.fills,
    from_opening: b.from_opening, has_split: b.has_split, dividends: pyRound(b.dividends, 2),
    created_at: b.created_at, first_buy: buys[0]!.date,
    last_sell: sells.length ? sells[sells.length - 1]!.date : null,
    closed: sells.length > 0 && pos <= EPS,
    buy_shares: pyRound(buyShares, 2), sell_shares: sellShares, open_shares: pyRound(pos, 2),
    avg_cost: pyRound(avg, 4), amount: pyRound(b.peak, 2),
    avg_sell: null, gross_pnl: null, fees: null, fees_are_estimated: null,
    realized_pnl: null, realized_by_date: null, realized_pct: null, hold_days: null, settlement_warning: null,
  };
  if (sells.length) {
    const net = b.gross - b.rFee;
    ep.avg_sell = pyRound(sum(sells.map((f) => f.price * f.shares)) / sellShares, 4);
    ep.gross_pnl = pyRound(b.gross, 2);
    ep.fees = pyRound(b.rFee, 2);
    ep.fees_are_estimated = b.fills.some((f) => f.fee_estimated);
    ep.realized_pnl = pyRound(net, 2);
    ep.realized_by_date = Object.fromEntries(b.byDate);
    // 成本 ≤ 0(期初持仓吃够分红送转后)时百分比没有意义,不给
    ep.realized_pct = b.rCost > 0 ? pyRound((net / b.rCost) * 100, 2) : null;
    ep.hold_days = daysBetween(ep.first_buy, ep.last_sell!);
    if (b.unverified) ep.settlement_warning = T0_WARNING;
  }
  return ep;
}

/**
 * 把流水切成一轮一轮。`ledgerIssues` 是台账快照里这一种的问题清单(字段不合规的记录,持仓页也不算)。
 * 结果按入场日从新到旧。
 */
export function buildEpisodes(trades: readonly Trade[], cfg: FeeConfig, ledgerIssues: readonly { id: string; why: string }[] = []): EpisodeResult {
  const issues: EpisodeIssue[] = [];
  const bad = new Map(ledgerIssues.map((i) => [i.id, i.why]));
  const nonA = new Set<string>();
  const valid: Trade[] = [];
  for (const t of trades) {
    const why = bad.get(t.id);
    if (why !== undefined) { issues.push({ id: t.id, symbol: t.symbol, date: t.date, type: t.type, why: `不合台账规则:${why}` }); continue; }
    if (!isJournalSymbol(t.symbol)) { if (t.symbol) nonA.add(t.symbol); continue; }
    valid.push(t);
  }
  // 持仓页跳过哪几笔,这里就跳过哪几笔:被跳过的流水不改任何状态,所以先剔掉再走一遍,状态序列和持仓页完全相同
  const rep = replayTrades(valid, "average");
  issues.push(...rep.issues);
  const skip = new Set(rep.issues.map((i) => i.id));

  const books = new Map<string, Book>();
  // 卖光的一轮先留着,最后再出结果:卖光之后到账的分红还要挂进来
  const done: Builder[] = [];
  let orphanDividends = 0;
  for (const t of valid.filter((x) => !skip.has(x.id)).sort(replayOrder)) {
    let bk = books.get(t.symbol);
    if (!bk) { bk = { cur: null, last: null, pos: 0, cost: 0, fee: 0, sellable: 0, day: "" }; books.set(t.symbol, bk); }
    if (t.date !== bk.day) { bk.day = t.date; bk.sellable = bk.pos; }

    if (t.type === "split") {
      // 空仓时的送转不改股数(持仓页同样不改)
      if (bk.cur && bk.pos > EPS) {
        bk.pos *= t.ratio!; bk.sellable *= t.ratio!;
        bk.cur.trade_ids.push(t.id); bk.cur.has_split = true;
      }
      continue;
    }
    if (t.type === "dividend") {
      // 卖光之后才到账的分红(登记日还拿着)挂到上一轮
      const target = bk.cur ?? bk.last;
      if (target) { target.dividends += t.amount!; target.trade_ids.push(t.id); } else orphanDividends += 1;
      continue;
    }

    const n = t.shares!, px = t.price!;
    if (t.type === "opening" || t.type === "buy") {
      if (!bk.cur || bk.pos <= EPS) {
        bk.cur = {
          id: t.id, symbol: t.symbol, name: "", created_at: t.created_at, trade_ids: [], fills: [],
          from_opening: t.type === "opening", has_split: false, dividends: 0,
          peak: 0, gross: 0, rCost: 0, rShares: 0, rFee: 0, byDate: new Map(), unverified: false,
        };
        bk.pos = 0; bk.cost = 0; bk.fee = 0;
      }
      const b = bk.cur;
      const estimated = t.type === "buy" && t.fee === null;
      const fee = t.type === "opening" ? 0 : t.fee ?? estimateFee("buy", px, n, cfg);
      bk.pos += n; bk.cost += px * n; bk.fee += fee;
      // 期初持仓是开始记账前就拿着的,当天就能卖
      if (t.type === "opening") bk.sellable += n;
      b.peak = Math.max(b.peak, bk.cost);
      b.fills.push({ trade_id: t.id, type: t.type, date: t.date, price: px, shares: n, fee, fee_estimated: estimated });
      b.trade_ids.push(t.id);
      if (t.name) b.name = t.name;
      continue;
    }

    // 卖出:replayTrades 已保证不超过当时持有,所以这一轮一定开着
    const b = bk.cur!;
    if (n > bk.sellable + 1e-6) b.unverified = true;
    bk.sellable = Math.max(0, bk.sellable - n);
    const unit = bk.cost / bk.pos;
    const ratio = n / bk.pos;
    const estimated = t.fee === null;
    const sellFee = t.fee ?? estimateFee("sell", px, n, cfg);
    const legFee = bk.fee * ratio + sellFee;
    b.gross += (px - unit) * n;
    b.rCost += unit * n;
    b.rShares += n;
    b.rFee += legFee;
    b.byDate.set(t.date, pyRound((b.byDate.get(t.date) ?? 0) + (px - unit) * n - legFee, 2));
    bk.fee -= bk.fee * ratio;
    bk.cost -= unit * n;
    bk.pos -= n;
    b.fills.push({ trade_id: t.id, type: "sell", date: t.date, price: px, shares: n, fee: sellFee, fee_estimated: estimated });
    b.trade_ids.push(t.id);
    if (t.name) b.name = t.name;
    if (bk.pos <= EPS) {
      done.push(b);
      bk.last = b; bk.cur = null; bk.pos = 0; bk.cost = 0; bk.fee = 0;
    }
  }
  const out = done.map((b) => finalize(b, 0, 0));
  for (const bk of books.values()) if (bk.cur) out.push(finalize(bk.cur, bk.pos, bk.cost));
  out.sort((a, b) => (a.first_buy !== b.first_buy ? (a.first_buy < b.first_buy ? 1 : -1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { episodes: out, issues, skipped_non_a: [...nonA].sort(), orphan_dividends: orphanDividends };
}
