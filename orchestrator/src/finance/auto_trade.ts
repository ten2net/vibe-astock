/**
 * 分时资金榜自动记账代理 · 纯规则引擎(方案 A 定稿,见 docs/superpowers/specs/2026-10-27-auto-fflow-ledger-design.md)。
 * 只算决策不碰 IO:输入 = 榜单候选 + 当前持仓 + 自动成交历史 + 交易日历,输出 = 买卖指令。
 * `source=auto_fflow` 标记写进 trade 记录的 note 前缀(trade schema additionalProperties: false,加不了字段)。
 */
import type { CalendarFacts } from "./session.ts";
export type { CalendarFacts };

export const PCT_MIN = 3, PCT_MAX = 6;
export const UP_RATIO_MIN = 0.6;          // 与 shortline/fflow_pattern.ts 的 UP_RATIO 同值,独立常量以免引擎依赖取数模块
export const RISE_BP_MIN = 10;            // 候选已过 fflow_pattern 形态判定,此处为兜底下限
export const MAIN_BP_MIN = 5;             // main_net 占流通市值 ≥ 5bp
export const MAIN_NET_ABS_MIN = 2e7;      // 无流通市值时主力净额 ≥ 2000 万(新浪通道兜底)
export const BUY_COOLDOWN_DAYS = 3;       // 近 3 个交易日内买过不买
export const SELL_COOLDOWN_DAYS = 1;      // 卖出后 1 个交易日冷却
export const CURVE_NEG_MIN_MINUTES = 30;  // 资金曲线转负持续 ≥30 分钟卖出
const SLIP = 1.001, LOT = 100;

export interface AutoTradeConfig {
  totalYuan: number; positionRatio: number; maxPositions: number;
  stopLoss: number; takeProfit: number; holdDays: number;
  buyCooldownDays: number; sellCooldownDays: number;
}

export interface CandidateQuote {
  code: string; name: string;
  price: number | null; pct: number | null; mainNet: number | null;
  floatCap: number | null; upRatio: number; riseBp: number; score: number;
}

export interface AutoTradeHolding {
  symbol: string; name: string; shares: number; unitCost: number;
  openedAt: string;                      // 这段持有开始的交易日
  price: number | null;                  // 现价,取不到为 null
  mainToday: number | null;              // 当日主力净额(累计曲线末值)
  negMinutes: number;                    // 资金曲线由正转负持续分钟数(runner 算好传入)
  positionValue?: number;                // 市值;缺省用 shares × max(price, unitCost) 估算
}

export interface AutoTradeHistory { trades: { symbol: string; type: "buy" | "sell"; date: string }[] }

export type Order =
  | { kind: "buy"; symbol: string; name: string; shares: number; price: number; reason: string; note: string }
  | { kind: "sell"; symbol: string; name: string; shares: number; price: number; reason: string; note: string };

/** 各板块涨停阈值(百分数),均按「买不进」处理:主板 10% 板留 0.5% 余量,20cm/30cm 板留 1% 余量(档位不同,余量不同) */
export function limitPctOf(code: string): number {
  if (/^(?:30|68)/.test(code)) return 19;
  if (/^(?:4|8|92)/.test(code)) return 29;
  return 9.5;
}

export function parseAutoNote(note: unknown): { rule: string } | null {
  const m = typeof note === "string" && note.match(/^auto_fflow\|rule=([a-z_]+)/);
  return m ? { rule: m[1]! } : null;
}

const slotYuan = (cfg: AutoTradeConfig) => (cfg.totalYuan * cfg.positionRatio) / cfg.maxPositions;

export function buyOrders(
  cfg: AutoTradeConfig,
  candidates: CandidateQuote[],
  holdings: AutoTradeHolding[],
  history?: AutoTradeHistory,
  cal?: CalendarFacts,
  tradingDays?: string[],
): Order[] {
  const heldSyms = new Set(holdings.map((h) => h.symbol));
  const busy = holdings.reduce((s, h) => s + (h.positionValue ?? h.shares * Math.max(h.price ?? 0, h.unitCost)), 0);
  const budget = cfg.totalYuan * cfg.positionRatio;
  const orders: Order[] = [];
  // 冷却窗口:recent(n) = 含今天的最近 n+1 个交易日。买入冷却 3 日 → n=2;
  // 卖出冷却 1 日 → n=1(卖出当日 + 次日不买,防止止损当日反复接回)。
  // indexOf 找不到返回 -1(不是 NaN):日历与 tradingDays 不一致时返回 null,显式禁用冷却,不静默误判。
  const recent = (n: number) => {
    if (!tradingDays || !cal) return null;
    const tdi = tradingDays.indexOf(cal.last_trading_day);
    return tdi < 0 ? null : new Set(tradingDays.slice(Math.max(0, tdi - n), tdi + 1));
  };
  const rb = recent(cfg.buyCooldownDays - 1), rs = recent(cfg.sellCooldownDays);
  const list = [...candidates].sort((a, b) => b.score - a.score);
  for (const c of list) {
    if (orders.length + holdings.length >= cfg.maxPositions) break;
    if (heldSyms.has(c.code)) continue;
    const spent = orders.reduce((s, o) => s + (o.kind === "buy" ? o.shares * o.price : 0), 0);
    if (busy + spent + slotYuan(cfg) > budget) break;
    if (c.price === null || !(c.price > 0)) continue;
    if (c.name.toUpperCase().includes("ST")) continue;
    if (c.pct === null || c.pct < PCT_MIN || c.pct > PCT_MAX) continue;
    if (c.pct >= limitPctOf(c.code)) continue;                       // 一字/涨停买不进
    if (c.upRatio < UP_RATIO_MIN || c.riseBp < RISE_BP_MIN) continue;
    if (c.mainNet === null) continue;
    if (c.floatCap && c.floatCap > 0) {
      if ((c.mainNet / c.floatCap) * 1e4 < MAIN_BP_MIN) continue;
    } else if (c.mainNet < MAIN_NET_ABS_MIN) continue;               // 新浪通道无市值,绝对额兜底
    if (rb && history?.trades.some((t) => t.symbol === c.code && t.type === "buy" && rb.has(t.date))) continue;
    if (rs && history?.trades.some((t) => t.symbol === c.code && t.type === "sell" && rs.has(t.date))) continue;
    const price = Math.round(c.price * SLIP * 100) / 100;
    const shares = Math.floor(slotYuan(cfg) / price / LOT) * LOT;
    if (shares <= 0) continue;
    orders.push({
      kind: "buy", symbol: c.code, name: c.name, shares, price,
      reason: "buy_fflow",
      note: `auto_fflow|rule=buy_fflow|pct=${c.pct}|main_bp=${
        c.floatCap ? ((c.mainNet / c.floatCap) * 1e4).toFixed(2) : "n/a"
      }|rise_bp=${c.riseBp}|up=${c.upRatio}|score=${c.score}`,
    });
  }
  return orders;
}

export function sellOrders(
  cfg: AutoTradeConfig,
  holdings: AutoTradeHolding[],
  history: AutoTradeHistory,
  cal: CalendarFacts,
  tradingDays?: string[],
): Order[] {
  const orders: Order[] = [];
  const boughtToday = new Set(
    history.trades.filter((t) => t.type === "buy" && t.date === cal.last_trading_day).map((t) => t.symbol));
  const tdi = tradingDays ? tradingDays.indexOf(cal.last_trading_day) : Number.NaN;
  for (const h of holdings) {
    if (h.price === null || !(h.price > 0)) continue;              // 停牌等,这轮放弃
    if (boughtToday.has(h.symbol)) continue;                        // T+1(有当日买入记录)
    if (h.openedAt === cal.last_trading_day) continue;              // T+1 防御:history 缺记录时也跳过当日新仓
    const price = Math.round(h.price / SLIP * 100) / 100;
    const cost = h.unitCost;
    const tag = (rule: string) => ({
      kind: "sell" as const, symbol: h.symbol, name: h.name, shares: h.shares, price, reason: rule,
      note: `auto_fflow|rule=${rule}|px=${h.price}|cost=${cost.toFixed(3)}|neg_min=${h.negMinutes}|main=${h.mainToday ?? "n/a"}`,
    });
    if (price <= cost * cfg.stopLoss) { orders.push(tag("sell_stop")); continue; }
    if (price >= cost * cfg.takeProfit) { orders.push(tag("sell_take_profit")); continue; }
    if (h.negMinutes >= CURVE_NEG_MIN_MINUTES) { orders.push(tag("sell_curve")); continue; }
    // 到期强平:openedAt 之后满 holdDays 个交易日(含今天);tdi=-1(日历不一致)时不触发,保守不卖
    if (tradingDays && tdi >= 0) {
      const oi = tradingDays.indexOf(h.openedAt);
      if (oi >= 0 && tdi - oi >= cfg.holdDays) orders.push(tag("sell_expiry"));
    }
  }
  return orders;
}
