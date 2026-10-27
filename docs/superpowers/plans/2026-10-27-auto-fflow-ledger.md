# 分时资金榜自动持仓记账代理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 依据分时资金横盘→拉升榜的自动模拟盘记账代理（方案 A 定稿）：盘中信号即买、四条卖出规则、恒定半仓滚动，成交写 `trade` 台账，持仓页可见。

**Architecture:** 纯函数规则引擎 `auto_trade.ts`（可单测）+ IO 执行器 `auto_trade_runner.ts`（挂进 `FINANCE_SCHEDULE.beat`，每拍检查 5 分钟窗口，写台账 + 收件箱）。初始资金记账用执行器侧状态文件（台账 replay 没有现金概念，`opening` 只会污染持仓页，这是对 spec 第 4 节的实现级修正）。信号复用 `shortlineFflow` 的 45s 进程内缓存；三条调研发现的硬约束（`source` 标记进 `note`、beat 不发收件箱需导出 `addInbox`、`trading_day_list` 需扩 Python 脚本）分别在 Task 1/2 处理。

**Tech Stack:** TypeScript（Node ≥22.18，`node:test`），Python 取数脚本（data-access skill），复用 orchestrator 现有 service/ledger/notify/schedule 层。

**Spec:** `docs/superpowers/specs/2026-10-27-auto-fflow-ledger-design.md`（commit f92e460，两处实现级修正见 Task 2 Step 5 与 Task 3 Step 7）

**测试基线:** orchestrator 全量 1462 测固定 10 个环境失败（与本计划无关）；跑测试用 `env -u PYTHONPATH`。

---

### Task 1: `fetch_trade_calendar` 输出逐日交易日列表

**Files:**
- Modify: `.agents/skills/data-access/scripts/fetch_trade_calendar.py`
- Test: `.agents/skills/data-access/scripts/tests/test_fetch_trade_calendar.py`

- [x] **Step 1: 读现状**

Read `.agents/skills/data-access/scripts/fetch_trade_calendar.py`，确认 `trading` 列表变量名与 `extra` 构造位置（约 :35-61 算列表、:118 附近落 extra）。注意脚本结尾 `finish()` 会 `sys.exit`，测试用 `pytest.raises(SystemExit)` 包。

- [x] **Step 2: 写失败测试（新建测试文件）**

新建 `.agents/skills/data-access/scripts/tests/test_fetch_trade_calendar.py`（该文件不存在；mock 细节与落盘路径以目录现有测试 test_kline_freshness.py 的真实契约为准，计划的 result.json/meta 只是示意）。测试要点：

```python
def test_trading_day_list_in_extra(monkeypatch, tmp_path):
    """extra.trading_day_list 含完整逐日交易日列表(升序、含今天、无未来日、无遗漏)"""
    # mock 主源返回升序且含未来日的日历;备源 mock 成 pytest.fail(防走降级)
    # 断言:SystemExit.code == 0;days == sorted(days);today in days;future not in days
    # 加固(质量评审意见):monkeypatch fetch_trade_calendar.today_str 固定时钟防午夜 flaky;
    # 再补一条 assert days == sorted(d for d in mocked_calendar if d <= fixed_today) 钉死无遗漏
```

- [x] **Step 3: 跑测试确认失败**

Run: `cd .agents/skills/data-access/scripts && env -u PYTHONPATH PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest tests/test_fetch_trade_calendar.py -x -q`
Expected: FAIL（`KeyError: 'trading_day_list'`）

- [x] **Step 4: 实现**

在 `fetch_trade_calendar.py` 的 `extra` 构造处加一行（`trading` 为已算好的升序交易日列表）：

```python
extra["trading_day_list"] = trading
```

- [x] **Step 5: 跑测试确认通过 + 全量回归**

Run: `cd .agents/skills/data-access/scripts && env -u PYTHONPATH PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest tests/ -q`
Expected: 全部 PASS（该 skill 脚本 787 测基线全绿，不得新增失败）

- [x] **Step 6: Commit**

```bash
git add .agents/skills/data-access/scripts/fetch_trade_calendar.py .agents/skills/data-access/scripts/tests/test_fetch_trade_calendar.py
git commit -m "feat(data-access): fetch_trade_calendar 输出逐日交易日列表"
```

---

### Task 2: `auto_fflow_trade` 金融垂类 beat（含执行器与 notify.ts 扩展）

**Files:**
- Modify: `orchestrator/src/notify.ts`（导出 `addInbox`，约 :295）
- Create: `orchestrator/src/finance/auto_trade.ts`（纯规则引擎）
- Create: `orchestrator/src/finance/auto_trade_runner.ts`（IO 执行器 + beat）
- Modify: `orchestrator/src/finance/schedule.ts:300-306`（FINANCE_SCHEDULE 增加 beat 分支与 `idFilter`）
- Test: `orchestrator/test/auto_trade.test.ts`

- [x] **Step 1: 导出 addInbox**

`orchestrator/src/notify.ts` 约 :295-301，`function addInbox(...)` 改导出（其余不动）：

```ts
export function addInbox(dataRoot: string, items: InboxItem[]): Promise<void> { ... }
```

- [x] **Step 2: 写引擎常量与买入过滤的失败测试**

Create `orchestrator/test/auto_trade.test.ts`（setup 沿用 `orchestrator/test/holdings.test.ts:194-235` 惯例，见 Step 5）：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buyOrders, BUY_COOLDOWN_DAYS, limitPctOf, parseAutoNote, PCT_MAX, PCT_MIN,
  RISE_BP_MIN, UP_RATIO_MIN, MAIN_BP_MIN, MAIN_NET_ABS_MIN,
  type AutoTradeConfig, type CandidateQuote,
} from "../src/finance/auto_trade.ts";

const CFG: AutoTradeConfig = {
  totalYuan: 1_000_000, positionRatio: 0.5, maxPositions: 5,
  stopLoss: 0.95, takeProfit: 1.08, holdDays: 3,
  buyCooldownDays: BUY_COOLDOWN_DAYS, sellCooldownDays: 1,
};

const cand = (over: Partial<CandidateQuote> = {}): CandidateQuote => ({
  code: "600519", name: "贵州茅台", price: 1700, pct: 4.0, mainNet: 5e8,
  floatCap: 8e11, upRatio: 0.8, riseBp: 40, score: 30, ...over,
});

test("涨幅在 3%~6% 之外不买", () => {
  assert.equal(buyOrders(CFG, [cand({ pct: PCT_MIN - 0.1 })], []).length, 0);
  assert.equal(buyOrders(CFG, [cand({ pct: PCT_MAX + 0.1 })], []).length, 0);
  assert.equal(buyOrders(CFG, [cand()], []).length, 1);
});

test("ST、涨停附近、稳步度不够、主力净额不足都剔除", () => {
  assert.equal(buyOrders(CFG, [cand({ name: "ST某某" })], []).length, 0);
  assert.equal(buyOrders(CFG, [cand({ code: "600000", pct: 9.6 })], []).length, 0);   // 主板涨停
  assert.equal(buyOrders(CFG, [cand({ code: "300308", pct: 19.2 })], []).length, 0);  // 创业板涨停
  assert.equal(buyOrders(CFG, [cand({ upRatio: UP_RATIO_MIN - 0.05 })], []).length, 0);
  assert.equal(buyOrders(CFG, [cand({ riseBp: RISE_BP_MIN - 1 })], []).length, 0);
  assert.equal(buyOrders(CFG, [cand({ mainNet: 1e6, floatCap: 8e11 })], []).length, 0); // 0.0125bp < 5bp
});

test("主力净额绝对兜底:无流通市值时要求 ≥ 2000 万", () => {
  assert.equal(buyOrders(CFG, [cand({ floatCap: null, mainNet: 1e7 })], []).length, 0);
  assert.equal(buyOrders(CFG, [cand({ floatCap: null, mainNet: MAIN_NET_ABS_MIN })], []).length, 1);
});

test("涨停阈值按板块区分", () => {
  assert.equal(limitPctOf("600000"), 9.5);   // 主板 10%
  assert.equal(limitPctOf("300308"), 19);    // 创业板 20%
  assert.equal(limitPctOf("688981"), 19);    // 科创板 20%
  assert.equal(limitPctOf("830799"), 29);    // 北交所 30%
});
```

- [x] **Step 3: 写仓位、冷却、卖出规则、note 的失败测试（同文件追加）**

```ts
import type { AutoTradeHistory, AutoTradeHolding, CalendarFacts, Order } from "../src/finance/auto_trade.ts";

const CAL: CalendarFacts = {
  last_trading_day: "2026-10-27", previous_trading_day: "2026-10-26",
  is_today_trading_day: true, session_phase: "trading",
};
const hist = (trades: AutoTradeHistory["trades"]): AutoTradeHistory => ({ trades });
const held = (over: Partial<AutoTradeHolding> = {}): AutoTradeHolding => ({
  symbol: "600519", name: "贵州茅台", shares: 500, unitCost: 1700 * 1.001,
  openedAt: "2026-10-23", price: 1700, mainToday: 5e8, negMinutes: 0, ...over,
});

test("单笔 10 万整手、目标仓位 50%、最多 5 只", () => {
  const [o] = buyOrders(CFG, [cand({ price: 10 })], []) as Extract<Order, { kind: "buy" }>[];
  assert.equal(o.shares, 9900);            // floor(100000/10.01/100)*100
  assert.equal(o.price, 10.01);            // +0.1% 滑点
  assert.ok(o.note.startsWith("auto_fflow|"));
  const five = [1, 2, 3, 4, 5].map((i) => cand({ code: `60000${i}`, name: `票${i}`, price: 10 }));
  assert.equal(buyOrders(CFG, five, []).length, 5);
  assert.equal(buyOrders(CFG, [...five, cand({ code: "600006", name: "票6", price: 10 })], []).length, 5);  // 第 6 只被额度拒
  assert.equal(buyOrders(CFG, [cand({ code: "600007" })], [held()]), []);  // 已持有不买
});

test("已持有不买;买入冷却 3 个交易日、卖出冷却当日+次日", () => {
  assert.equal(buyOrders(CFG, [cand()], [held()]).length, 0);
  const DAYS = ["2026-10-23", "2026-10-26", "2026-10-27"];   // 含今天的最近 3 个交易日
  const boughtYesterday: AutoTradeHistory = hist([
    { symbol: "600519", type: "buy", date: "2026-10-26" }]);
  assert.equal(buyOrders(CFG, [cand()], [], boughtYesterday, CAL, DAYS).length, 0);
  const soldYesterday: AutoTradeHistory = hist([
    { symbol: "600519", type: "sell", date: "2026-10-26" }]);
  assert.equal(buyOrders(CFG, [cand()], [], soldYesterday, CAL, DAYS).length, 0);
  const soldBeforeYesterday: AutoTradeHistory = hist([
    { symbol: "600519", type: "sell", date: "2026-10-23" }]);
  assert.equal(buyOrders(CFG, [cand()], [], soldBeforeYesterday, CAL, DAYS).length, 1);
});

test("卖出四规则:止损/止盈/形态破坏/到期强平,T+1 新仓不卖", () => {
  const DAYS = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27"];
  const orders = (h: AutoTradeHolding, trades: AutoTradeHistory["trades"] = [], cal: CalendarFacts = CAL, days = DAYS) =>
    sellOrders(CFG, [h], hist(trades), cal, days);
  const stop = orders(held({ price: 1700 * 0.95 * 0.999 }));       // 刚好破 -5%
  assert.equal(stop[0]?.reason, "sell_stop");
  const tp = orders(held({ price: 1700 * 1.08 * 1.001 }));
  assert.equal(tp[0]?.reason, "sell_take_profit");
  const curve = orders(held({ negMinutes: 30, price: 1700 }));
  assert.equal(curve[0]?.reason, "sell_curve");
  assert.equal(orders(held({ negMinutes: 25, price: 1700 })).length, 0);  // 不足 30 分钟
  const expiry = orders(held({ openedAt: "2026-10-22", price: 1700 }));
  assert.equal(expiry[0]?.reason, "sell_expiry");                  // 10-23/26/27 满 3 个交易日
  const boughtToday = orders(held({ openedAt: "2026-10-27", price: 1700 * 0.9 }),
    [{ symbol: "600519", type: "buy", date: "2026-10-27" }]);
  assert.equal(boughtToday.length, 0);                             // T+1(今天有买入记录)
  const stopNote = (stop[0] as Extract<Order, { kind: "sell" }>).note;
  assert.ok(stopNote.includes("rule=sell_stop") && stopNote.includes("cost="));
});

test("parseAutoNote 只认 auto_fflow 前缀,其余返回 null", () => {
  assert.equal(parseAutoNote("auto_fflow|rule=buy|pct=4")?.rule, "buy");
  assert.equal(parseAutoNote("手工记账"), null);
  assert.equal(parseAutoNote(""), null);
});
```

注意「最多 5 只」用例：`buyOrders` 的签名统一为（见 Step 5，positionValue 缺省由 holdings 自行估算）：

```ts
export function buyOrders(
  cfg: AutoTradeConfig,
  candidates: CandidateQuote[],
  holdings: AutoTradeHolding[],
  history?: AutoTradeHistory,
  cal?: CalendarFacts,
  tradingDays?: string[],
): Order[]
```

修正上面用例：`buyOrders(CFG, [...five, cand({ code: "600006" })], [])` 应只产出 5 笔（额度 50 万 ÷ 10 万/笔 = 5 笔），第 6 只被额度拒掉。把该断言改为 `assert.equal(buyOrders(CFG, [...five, cand({ code: "600006" })], []).length, 5)`。

- [x] **Step 4: 跑测试确认失败**

Run: `cd orchestrator && env -u PYTHONPATH node --test test/auto_trade.test.ts`
Expected: FAIL（`Cannot find module ... auto_trade.ts`）

- [x] **Step 5: 实现 auto_trade.ts（纯函数引擎）**

Create `orchestrator/src/finance/auto_trade.ts`：

```ts
/**
 * 分时资金榜自动记账代理 · 纯规则引擎(方案 A 定稿,见 docs/superpowers/specs/2026-10-27-auto-fflow-ledger-design.md)。
 * 只算决策不碰 IO:输入 = 榜单候选 + 当前持仓 + 自动成交历史 + 交易日历,输出 = 买卖指令。
 * `source=auto_fflow` 标记写进 trade 记录的 note 前缀(trade schema additionalProperties: false,加不了字段)。
 */
import type { CalendarFacts } from "./session.ts";

export const PCT_MIN = 3, PCT_MAX = 6;
export const UP_RATIO_MIN = 0.6;
export const RISE_BP_MIN = 10;
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

/** 各板块涨停阈值(百分数):主板 10%、创业/科创 20%、北交所 30%,留 0.5% 买不进余量 */
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
  // 卖出冷却 1 日 → n=1(卖出当日 + 次日不买,防止损当日反复接回)。
  const recent = (n: number) => {
    if (!tradingDays || !cal) return null;
    const tdi = tradingDays.indexOf(cal.last_trading_day);
    return Number.isNaN(tdi) ? null : new Set(tradingDays.slice(Math.max(0, tdi - n), tdi + 1));
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
    if (boughtToday.has(h.symbol)) continue;                        // T+1
    const price = Math.round(h.price / SLIP * 100) / 100;
    const cost = h.unitCost;
    const tag = (rule: string) => ({
      kind: "sell" as const, symbol: h.symbol, name: h.name, shares: h.shares, price, reason: rule,
      note: `auto_fflow|rule=${rule}|px=${h.price}|cost=${cost.toFixed(3)}|neg_min=${h.negMinutes}|main=${h.mainToday ?? "n/a"}`,
    });
    if (price <= cost * cfg.stopLoss) { orders.push(tag("sell_stop")); continue; }
    if (price >= cost * cfg.takeProfit) { orders.push(tag("sell_take_profit")); continue; }
    if (h.negMinutes >= CURVE_NEG_MIN_MINUTES) { orders.push(tag("sell_curve")); continue; }
    // 到期强平:openedAt 之后满 holdDays 个交易日(含今天)
    if (tradingDays && !Number.isNaN(tdi)) {
      const oi = tradingDays.indexOf(h.openedAt);
      if (oi >= 0 && tdi - oi >= cfg.holdDays) orders.push(tag("sell_expiry"));
    }
  }
  return orders;
}
```

实现纪律：上面就是最终代码形状——所有参数带全 TS 类型（照上文 interface 补全，如 `cfg: AutoTradeConfig`），不得留简写占位；写完以 `npx tsc --noEmit` 零新增错误为准。

实现时删除 `oi` placeholder 行（那是草稿残留）；引擎里所有 `cfg, candidates, ...` 参数补全 TS 类型（照上文 interface）。

- [x] **Step 6: 跑引擎测试确认通过**

Run: `cd orchestrator && env -u PYTHONPATH node --test test/auto_trade.test.ts`
Expected: 全部 PASS

- [x] **Step 7: 修 spec 的两处实现级偏差**

Edit `docs/superpowers/specs/2026-10-27-auto-fflow-ledger-design.md`：
1. 第 4 节改为：「初始资金 100 万由执行器状态文件记账（台账 replay 无现金概念，`opening` 只会生成伪持仓污染持仓页）；成交仍全部写 `trade`，盈亏由重放算出。」
2. 第 5 节「非上市 <60 日新股」改为：「无上市日期数据源，v1 不做新股过滤（榜单候选本身已排除大部分次新异动票）」。

- [x] **Step 8: 实现 auto_trade_runner.ts**

Create `orchestrator/src/finance/auto_trade_runner.ts`：

```ts
/**
 * 自动记账代理执行器:每拍(beat)检查 5 分钟窗口,到了且今天该窗口没跑过 →
 * 取榜单 + 持仓行情 + 分钟资金曲线 → 纯引擎出指令 → 写 trade 台账 + 收件箱。
 * 窗口防重靠 stateFile(day+窗口分钟);崩溃重启同窗口不重复成交。
 */
import fs from "node:fs";
import path from "node:path";
import { fetchEndpoint, ledgerSnapshot, ledgerUpsert, type ServiceContext } from "../service.ts";
import { addInbox, newId, type GateResult } from "../notify.ts";
import { shortlineFflow, type FflowView } from "./shortline/fflow_pattern.ts";
import { replayTrades, tradeOf, type Trade } from "./holdings.ts";
import { quoteCodeOf, symbolOfQuoteKey } from "./schedule.ts";
import { calendarFromEnvelope, type CalendarFacts, type SessionPhase } from "./session.ts";
import {
  buyOrders, sellOrders, parseAutoNote,
  type AutoTradeConfig, type AutoTradeHolding, type CandidateQuote, type Order,
} from "./auto_trade.ts";

export const AUTO_TRADE_JOB_ID = "auto_fflow_trade";
const STATE_DIR = "auto_trade";
const WIN_START = "09:35", WIN_END = "14:50";
const CONFIG: AutoTradeConfig = {
  totalYuan: 1_000_000, positionRatio: 0.5, maxPositions: 5,
  stopLoss: 0.95, takeProfit: 1.08, holdDays: 3,
  buyCooldownDays: 3, sellCooldownDays: 1,
};

const stateFile = (dataRoot: string, day: string, winMin: number) =>
  path.join(dataRoot, STATE_DIR, `${day}-${String(winMin).padStart(4, "0")}.json`);
const writeState = (dataRoot: string, day: string, winMin: number, v: unknown) => {
  const f = stateFile(dataRoot, day, winMin);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v));
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function fetchCalendar(ctx: ServiceContext, day: string, signal: AbortSignal): Promise<CalendarFacts | null> {
  try {
    const r = await fetchEndpoint(ctx, { endpoint: "fetch_trade_calendar", symbol: "300308", signal });
    const env = r.envelope as { evidence?: { field?: string; value?: unknown; period?: string }[] };
    const period = (env.evidence ?? []).find((e) => e.field === "is_today_trading_day")?.period;
    return period === day ? calendarFromEnvelope(env) : null;
  } catch { return null; }
}

/** 持仓票的现价:腾讯批量行情 */
async function fetchQuotes(ctx: ServiceContext, symbols: string[], signal: AbortSignal): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!symbols.length) return out;
  const r = await fetchEndpoint(ctx, { endpoint: "tx_quotes_batch", args: { codes: symbols.map(quoteCodeOf) }, signal });
  for (const row of (r.envelope as { rows?: Record<string, unknown>[] }).rows ?? []) {
    const key = String((row as { key?: unknown }).key ?? "");
    const price = num((row as { f?: { price?: { value?: unknown } } }).f?.price?.value);
    if (key && price !== null) out.set(symbolOfQuoteKey(key), price);
  }
  return out;
}

/** 资金曲线由正转负的持续分钟数(累计净额末段为负时,从最后一个 ≥0 点算起) */
function negativeMinutes(series: { main: number | null }[], barMinutes: number): { neg: number; last: number | null } {
  const vals = series.map((p) => p.main).filter((v): v is number => v !== null);
  if (!vals.length) return { neg: 0, last: null };
  if (vals[vals.length - 1]! >= 0) return { neg: 0, last: vals[vals.length - 1]! };
  let i = vals.length - 1;
  while (i > 0 && vals[i - 1]! < 0) i--;
  return { neg: (vals.length - i) * barMinutes, last: vals[vals.length - 1]! };
}

async function runOnce(
  ctx: ServiceContext, day: string, signal: AbortSignal,
): Promise<{ orders: Order[]; error?: string }> {
  const cal = await fetchCalendar(ctx, day, signal);
  if (!cal || !cal.is_today_trading_day) return { orders: [], error: "交易日历取不到或今天不是交易日" };
  const tradingDays = ((await fetchEndpoint(ctx, { endpoint: "fetch_trade_calendar", symbol: "300308", args: { days: 40 }, signal }))
    .envelope as { extra?: { trading_day_list?: string[] } }).extra?.trading_day_list;

  const view: FflowView = await shortlineFflow(ctx, {}, signal);
  const candidates: CandidateQuote[] = view.stocks.map((s) => ({
    code: s.code, name: s.name, price: s.price, pct: s.pct, mainNet: s.main_net,
    floatCap: s.float_cap, upRatio: s.up_ratio, riseBp: s.rise_bp, score: s.score,
  }));

  const snap = ledgerSnapshot(ctx);
  const bad = new Set((snap.issues.trade ?? []).map((i) => i.id));
  const autoTrades = (snap.records.trade ?? [])
    .filter((r) => !bad.has(r.id) && parseAutoNote(r.note))
    .map((r) => ({ symbol: String(r.symbol), type: r.type as "buy" | "sell", date: String(r.date) }));
  const history = { trades: autoTrades };

  const replay = replayTrades(
    (snap.records.trade ?? []).filter((r) => !bad.has(r.id)).map(tradeOf), "fifo");
  const quotes = await fetchQuotes(ctx, replay.holdings.map((h) => h.symbol), signal);
  const holdings: AutoTradeHolding[] = [];
  for (const h of replay.holdings) {
    let mainToday: number | null = null, neg = 0;
    try {
      const env = (await fetchEndpoint(ctx, { endpoint: "em_fund_flow_minute", symbol: h.symbol, signal })).envelope as {
        extra?: { minute_series?: { main: number | null }[]; bar_minutes?: number } };
      const r = negativeMinutes(env.extra?.minute_series ?? [], env.extra?.bar_minutes ?? 1);
      mainToday = r.last; neg = r.neg;
    } catch { /* 分钟曲线取不到:只用价格规则 */ }
    holdings.push({
      symbol: h.symbol, name: h.name, shares: h.shares, unitCost: h.unit_cost,
      openedAt: h.opened_at, price: quotes.get(h.symbol) ?? null,
      mainToday, negMinutes: neg,
    });
  }

  const orders = [
    ...sellOrders(CONFIG, holdings, history, cal, tradingDays),
    ...buyOrders(CONFIG, candidates, holdings, history, cal, tradingDays),
  ];
  for (const o of orders) {
    ledgerUpsert(ctx, {
      kind: "trade",
      record: {
        symbol: o.symbol, name: o.name, type: o.kind, date: day,
        shares: o.shares, price: o.price, note: o.note,
      },
    });
  }
  if (orders.length) {
    await addInbox(ctx.dataRoot, [{
      id: newId(), at: new Date().toISOString(), job: AUTO_TRADE_JOB_ID, job_label: "自动记账",
      title: `自动记账 ${orders.length} 笔`, read: false, kind: "message",
      lines: orders.map((o) =>
        `${o.kind === "buy" ? "买入" : "卖出"} ${o.name}(${o.symbol}) ${o.shares}股 @ ${o.price} — ${o.reason}`),
    }]);
  }
  return { orders };
}

/** FINANCE_SCHEDULE.beat 分支:窗口 = 5 分钟一格的 [09:35, 14:50] */
export async function autoTradeBeat(
  b: { ctx: ServiceContext; signal: AbortSignal; gate: () => Promise<GateResult> },
): Promise<string | void> {
  const now = new Date();
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  if (hm < WIN_START || hm > WIN_END) return;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);  // YYYY-MM-DD
  const winMin = Math.floor((Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3))) / 5) * 5;
  if (fs.existsSync(stateFile(b.ctx.dataRoot, day, winMin))) return;
  const gate = await b.gate();
  if (gate.status === "closed") return;
  let result: { orders: Order[]; error?: string };
  try {
    result = await runOnce(b.ctx, day, b.signal);
  } catch (e) {
    result = { orders: [], error: e instanceof Error ? e.message : String(e) };
  }
  writeState(b.ctx.dataRoot, day, winMin, { at: now.toISOString(), ...result });
  if (result.error) return `auto_fflow_trade ${String(winMin).padStart(4, "0")}: 未执行(${result.error})`;
  if (result.orders.length) return `auto_fflow_trade ${String(winMin).padStart(4, "0")}: 成交 ${result.orders.length} 笔`;
}
```

注意：`newId` 需确认 notify.ts 有同名导出（deliver 里用了 `newId()`，如无导出则补导出或改用 `crypto.randomUUID()`）。`rowsOf` 若未从 schedule.ts 导出则一并补导出（quoteCodeOf/symbolOfQuoteKey 同理，以编译为准）。`SessionPhase` 未用则不 import。卖出冷却语义：「冷却 1 个交易日」实现为**卖出当日 + 次日**不买（防止止损当日反复接回），与测试用例一致。

- [x] **Step 9: 编译检查**

Run: `cd orchestrator && npx tsc --noEmit`
Expected: 无新增错误（若有存量错误，与基线对比）

- [x] **Step 10: 接入 FINANCE_SCHEDULE.beat**

Edit `orchestrator/src/finance/schedule.ts:300-306`：

```ts
  beat: async (b) => {
    const intraday = await import("./shortline/intraday.ts");
    const autoTrade = await import("./auto_trade_runner.ts");
    await autoTrade.autoTradeBeat(b);          // 先记账(读榜单缓存),再存快照
    return intraday.intradayBeat(b);
  },
```

- [x] **Step 11: 给 beat 加 idFilter（同日失败重试不连环炸）**

Edit `orchestrator/src/notify.ts` 的 `ScheduleDef`（约 :83-88）加可选字段：

```ts
  /** 可选:beat 每次跑前对运行 id 做正则过滤(如 ^15:),不匹配直接跳过;同一天内失败会重试,用来避免新 beat 把老 beat 的失败重试全炸一遍 */
  idFilter?: RegExp;
```

在 tick 的 beat 调用点（tick 内与 `st.beat_run` 比较前，约 :765）加：

```ts
        if (def.idFilter && !def.idFilter.test(String(r.beat))) continue;
```

实现说明：`r.beat` 是 beat 返回的 id 字符串（参照 tick 现有日志逻辑）；把这条过滤插在「解析出 beat id、与 beat_run 对比」的循环里，不匹配就跳过该条重试。若 tick 现有结构不便插拔，退而求其次：在 `runJob` 的 beat 分支调用处统一过滤（同一语义）。

- [x] **Step 12: 全量测试 + Commit**

Run: `cd orchestrator && env -u PYTHONPATH node --test --test-concurrency=1 test/auto_trade.test.ts test/schedule.test.ts test/notify.test.ts test/holdings.test.ts test/shortline_fflow.test.ts test/shortline_intraday.test.ts`
Expected: 全 PASS（这些文件原有用例不得回归）

```bash
git add orchestrator/src/notify.ts orchestrator/src/finance/auto_trade.ts orchestrator/src/finance/auto_trade_runner.ts orchestrator/src/finance/schedule.ts orchestrator/test/auto_trade.test.ts docs/superpowers/specs/2026-10-27-auto-fflow-ledger-design.md
git commit -m "feat(finance): 分时资金榜自动记账代理(规则引擎+beat 执行器)"
```

---

### Task 3: 全量回归 + 容器部署 + 实盘验证

**Files:**
- 无新文件；部署与验证

- [x] **Step 1: orchestrator 全量测试**

Run: `cd orchestrator && env -u PYTHONPATH node --test --test-concurrency=1 test/*.test.ts`
Expected: 1462 + 新增 ≈ 1480 测，除固定 10 个环境基线失败外全 PASS

- [x] **Step 2: 重建 v2 容器**

```bash
docker compose up -d --build vibe-astock-v2 cloudflared-v2
docker logs --tail 30 vibe-astock-v2   # 确认启动无异常
```

- [x] **Step 3: 检查公网可访问**

```bash
docker exec vibe-astock-v2 sh -c "tr -d '\n' < /app/.local/access.token"   # 拿口令
curl -s -c /tmp/jar "https://a2.luckybrother.cc/?access=<口令>" -o /dev/null -w "%{http_code}\n"   # 期望 200/302,非 530
```

- [x] **Step 4: 手工触发一次 beat 验证**

交易日的 09:35–14:50 之间观察：

```bash
docker logs --tail 50 vibe-astock-v2 | grep auto_fflow_trade
ls /app/.local/auto_trade/ 2>/dev/null   # 窗口 state 文件应逐 5 分钟出现
```

窗口外或非交易日不执行即正确行为。成交发生时：持仓页（/view/holdings）出现带 auto_fflow note 的持仓，收件箱有「自动记账」条目。

- [x] **Step 5: Commit + Push**

```bash
git log --oneline -3   # 确认 Task 1/2 的提交都在
git push origin main 2>&1 | tail -2   # 代理挂则 git -c http.proxy= push origin main
```
