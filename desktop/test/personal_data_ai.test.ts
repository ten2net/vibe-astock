// Vibe AStock 沿用旧版规矩:用户自己的成交、持仓、盈亏不放进发给 AI 的页面上下文(旧版「个人交易记录不接入任何 AI」)。
// 后端那一半(聊天助手读台账)见 orchestrator/test/assistant_ledger_privacy.test.ts。
import assert from "node:assert/strict";
import test from "node:test";
import { withRenderer } from "./helpers/render.ts";
import { PERSONAL_TRADES_TO_AI } from "../src/verticals/finance/lib/brand.ts";
import { PERSONAL_DATA_WITHHELD } from "../src/verticals/finance/lib/privacy.ts";
import { aiVisibleEvents, type CalendarEvent, type CalendarResult } from "../src/verticals/finance/lib/calendar.ts";
import type { CandidateResult } from "../src/verticals/finance/lib/candidates.ts";

test("本仓库不把持仓发给 AI", () => {
  assert.equal(PERSONAL_TRADES_TO_AI, false);
  assert.match(PERSONAL_DATA_WITHHELD, /不发给 AI/);
});

test("持仓页登记给 AI 的只有一段说明,没有任何持仓数据", async () => {
  const { portfolioAiContext } = await withRenderer((r) => r.load("/src/verticals/finance/pages/Portfolio.tsx"));
  const full = "我的持仓（本地数据）：\n平安银行(000001) 1000股 成本12.34 浮盈2000(16%)";
  const got = portfolioAiContext(full);
  assert.equal(got, PERSONAL_DATA_WITHHELD);
  for (const s of ["000001", "平安银行", "1000", "12.34", "2000"]) assert.equal(got.includes(s), false, s);
});

const cand = (id: string): CandidateResult => ({
  universe: { id, label: id === "position" ? "我的持仓" : "我的自选", size: 2, as_of: null, source: "台账" },
  quotes: { source: "腾讯行情", fetched_at: "2026-10-11 10:00", cached: false },
  conditions: [{ id: "pb", label: "市净率 ≤ 1.5", source: "腾讯" }],
  rows: [
    { symbol: "600036", name: "招商银行", verdict: "met", checks: [{ id: "pb", state: "met", value: 0.9, shown: "0.90" }] },
    { symbol: "000001", name: "平安银行", verdict: "missing", checks: [{ id: "pb", state: "missing", value: null, shown: "—" }] },
  ],
  counts: { met: 1, missing: 1, unmet: 0 }, generated_at: "", gaps: ["腾讯行情没有返回 1 只:000001(代码可能已变更)"],
});

test("候选池范围是「我的持仓」时,给 AI 的上下文不列代码、不列缺口;自选照常列", async () => {
  const { candidatesAiContext } = await withRenderer((r) => r.load("/src/verticals/finance/pages/Candidates.tsx"));
  const held: string = candidatesAiContext(cand("position"));
  for (const s of ["600036", "招商银行", "000001", "平安银行"]) assert.equal(held.includes(s), false, s);
  assert.match(held, /不发给 AI/);
  assert.match(held, /全部满足 1 只/);
  const watch: string = candidatesAiContext(cand("watch"));
  assert.match(watch, /600036 招商银行/);
  assert.match(watch, /没取到:腾讯行情没有返回 1 只:000001/);
});

const ev = (kind: CalendarEvent["kind"], symbol: string | null, title: string): CalendarEvent =>
  ({ date: "2026-10-20", kind, symbol, name: "", title, detail: [], source: "s", fetched_at: null });

test("事件日历给 AI 的事件:只在持仓里的股票不给公司事件;自选、自己写的判据和宏观照常给", () => {
  const r: Pick<CalendarResult, "symbols"> = { symbols: [
    { symbol: "000001", name: "平安银行", origin: ["持有"] },
    { symbol: "600036", name: "招商银行", origin: ["自选", "持有"] },
    { symbol: "300750", name: "宁德时代", origin: ["自选"] },
  ] };
  const events = [
    ev("dividend", "000001", "持有分红"), ev("disclosure", "000001", "持有年报"), ev("criterion", "000001", "自己的判据"),
    ev("dividend", "600036", "两边都在"), ev("lockup", "300750", "自选解禁"), ev("macro", null, "CPI"),
  ];
  assert.deepEqual(aiVisibleEvents(r, events, false).map((e) => e.title), ["自己的判据", "两边都在", "自选解禁", "CPI"]);
  assert.equal(aiVisibleEvents(r, events, true).length, events.length);
});
