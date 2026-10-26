import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import "../src/finance/register_tasks.ts";
import { listViews } from "../src/views.ts";
import { type ServiceContext } from "../src/service.ts";
import {
  MIN_BARS, MIN_RANGE_BP, detectSidewaysRise, shortlineFflow,
  type FflowView,
} from "../src/finance/shortline/fflow_pattern.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CAP = 1e10; // 流通市值/成交额分母;bp = 元 / 1e10 * 1e4 → 1bp = 100 万元
const yuan = (bp: number) => (bp * CAP) / 1e4;

/**
 * 构造 5 分钟桶曲线(元):前 nFlat 桶在 ±bandBp 内横盘,其后线性稳步上行到 riseBp
 * (80% 桶上行,模拟真实「稳步」)。返回累计主动净额序列。
 */
function makeBars(nBars: number, nFlat: number, bandBp: number, riseBp: number): { time: string; main: number | null }[] {
  const out: { time: string; main: number | null }[] = [];
  let cum = 0;
  for (let i = 0; i < nBars; i++) {
    if (i < nFlat) {
      cum = yuan(i % 2 ? bandBp * 0.4 : bandBp * 0.8);
    } else {
      cum += yuan((riseBp / (nBars - nFlat)) * (i % 5 === 0 ? 0.3 : 1.2));
    }
    out.push({ time: `b${i}`, main: Math.round(cum) });
  }
  return out;
}

test("视图已注册", () => {
  assert.ok(listViews().some((v) => v.id === "shortline_fflow"), "shortline_fflow 必须注册");
});

test("横盘→稳步拉升:前段窄幅 + 日内主要涨幅在后段 + 斜率切换 → 命中", () => {
  const r = detectSidewaysRise(makeBars(28, 12, 4, 80), CAP, 5);
  assert.ok(r, "标准横盘→拉升形态必须命中");
  assert.equal(r.points, 28);
  assert.equal(r.flat_minutes % 5, 0, "横盘时长按 bar_minutes 换算");
  assert.ok(r.flat_minutes >= 15 && r.flat_minutes <= 70, `flat_minutes=${r.flat_minutes}`);
  assert.ok(r.rise_bp >= 40, `后段拉升应为主要涨幅,rise_bp=${r.rise_bp}`);
  assert.ok(r.up_ratio >= 0.6);
  assert.equal(r.series_bp.length, 28, "序列尾巴完整(bp)");
});

test("从开盘一路匀速拉升(无横盘段、无节奏切换)不命中", () => {
  const monotone = Array.from({ length: 28 }, (_, i) => ({ time: `b${i}`, main: Math.round(yuan(i * 2)) }));
  assert.equal(detectSidewaysRise(monotone, CAP), null, "匀速单边:斜率比拒");
});

test("全天横盘(振幅不够)/ 桶数不够 / 缺分母 → 不命中", () => {
  const flat = Array.from({ length: 28 }, (_, i) => ({ time: `b${i}`, main: Math.round(yuan(i % 2 ? 1 : 2)) }));
  assert.equal(detectSidewaysRise(flat, CAP), null, `R=${2 - 0}bp < ${MIN_RANGE_BP}bp`);
  const short = makeBars(MIN_BARS - 1, 4, 4, 80);
  assert.equal(detectSidewaysRise(short, CAP), null, "桶数不够不硬算");
  const ok = makeBars(28, 12, 4, 80);
  assert.equal(detectSidewaysRise(ok, null), null, "没有分母无法换算 bp");
  assert.equal(detectSidewaysRise(ok, 0), null);
});

test("末桶回落不命中;后段回吐太多(up_ratio 过低)不命中", () => {
  const fallingTail = makeBars(28, 12, 4, 80);
  const lastMain = fallingTail.at(-1)!.main!;
  fallingTail[fallingTail.length - 1] = { time: "bend", main: lastMain - yuan(10) };
  assert.equal(detectSidewaysRise(fallingTail, CAP), null, "最后一桶回落不算正在拉升");
  const choppy = makeBars(28, 12, 4, 80).map((p, i) => {
    if (i > 15 && i % 2 === 0) return { time: p.time, main: (p.main ?? 0) - yuan(6) };
    return p;
  });
  const r = detectSidewaysRise(choppy, CAP);
  if (r) assert.ok(r.up_ratio >= 0.6, "命中了就必须满足 up_ratio");
});

test("先拉升后横盘(顺序反了)不命中:分段点高位区/后段斜率不达标", () => {
  // 前 16 桶拉到 100bp,后 12 桶横在 ±5bp
  const inv: { time: string; main: number | null }[] = [];
  let cum = 0;
  for (let i = 0; i < 28; i++) {
    cum = i < 16 ? yuan(i * 6) : yuan(96 + (i % 2 ? 0 : 4));
    inv.push({ time: `b${i}`, main: Math.round(cum) });
  }
  assert.equal(detectSidewaysRise(inv, CAP), null, "拉升在前的形态不命中");
});

function tmpCtx(): ServiceContext {
  return { repoRoot: REPO, dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), "vra-fflow-")), python: "python3", node: process.execPath };
}

const rankEnv = (codes: string[]) => ({
  // 新浪榜 schema:不给 float_cap(分母回落到当日成交额),带 amount
  extra: {
    rows: codes.map((c, i) => ({ rank: i + 1, code: c, name: `股${c}`, price: 10 + i, pct: 0.015, main_net: 5e7 - i * 1e6, float_cap: null, amount: 8e8 })),
    total: 5000,
  },
});
const minuteEnv = (series: { time: string; main: number | null }[], fetchedAt = "2026-10-23 14:00:00", dayAmount: number | null = null, barMinutes = 1) => ({
  fetched_at: fetchedAt,
  extra: { minute_series: series.map((p) => ({ time: p.time, main: p.main })), first_time: series[0]?.time, last_time: series.at(-1)?.time, day_amount: dayAmount, bar_minutes: barMinutes },
});

test("视图:取榜→逐只识别→按 score 取前 20,结果带通道标注且 45s 内走缓存", async () => {
  const ctx = tmpCtx();
  try {
    const codes = Array.from({ length: 25 }, (_, i) => String(600000 + i));
    const calls: string[] = [];
    let now = Date.parse("2026-10-23T14:05:00+08:00");
    const fetch = async (_c: unknown, req: { endpoint?: string; symbol?: string; consistency?: { mode?: string } }) => {
      calls.push(`${req.consistency?.mode ?? "cached"}:${req.endpoint}${req.symbol ? `:${req.symbol}` : ""}`);
      if (req.endpoint === "sina_market_money_rank") return { envelope: rankEnv(codes) };
      if (req.endpoint === "em_market_main_net_rank") throw new Error("push2 blocked in this test");
      const idx = codes.indexOf(String(req.symbol));
      // 前 3 只横盘→拉升(score 递减),其余从开盘一路拉升(斜率比拒掉)
      const series = idx >= 0 && idx < 3
        ? makeBars(28, 12 + idx, 4 + idx, 90 - idx * 10)
        : Array.from({ length: 28 }, (_, i) => ({ time: `b${i}`, main: Math.round(yuan(i * 3)) }));
      return { envelope: minuteEnv(series, "2026-10-23 14:00:00", CAP, 5) };
    };
    const v1 = await shortlineFflow(ctx, {}, new AbortController().signal, { fetch: fetch as never, now: () => now }) as FflowView;
    assert.equal(v1.stocks.length, 3, "只有 3 只命中");
    assert.equal(v1.stocks[0]!.code, "600000", "横盘最紧+拉升最大者排第一");
    assert.equal(v1.total_scanned, 25);
    assert.equal(v1.with_data, 25);
    assert.equal(v1.day, "2026-10-23");
    assert.match(v1.source_label, /新浪/, "主通道必须是新浪榜(东财抛错时不能误用)");
    assert.ok(calls.some((c) => c.includes("tx_minute_today:600000")), "分钟线走腾讯通道");
    assert.ok(!calls.some((c) => c.includes("em_fund_flow_minute")), "主通道可用时不该碰东财分钟");
    assert.equal(v1.stocks[0]!.flat_minutes % 5, 0, "5 分钟桶换算成分钟");
    assert.equal(v1.stocks[0]!.pct, 1.5, "榜单源是小数比率(0.015),视图统一输出百分数单位(1.5)");
    const callsAfterFirst = calls.length;
    const v2 = await shortlineFflow(ctx, {}, new AbortController().signal, { fetch: fetch as never, now: () => now + 10_000 }) as FflowView;
    assert.equal(calls.length, callsAfterFirst, "45s 内必须走缓存,不再取数");
    assert.deepEqual(v2.stocks.map((s) => s.code), v1.stocks.map((s) => s.code));
    await shortlineFflow(ctx, {}, new AbortController().signal, { fetch: fetch as never, now: () => now + 60_000 });
    assert.ok(calls.length > callsAfterFirst, "TTL 过期后重新取数");
  } finally { fs.rmSync(ctx.dataRoot, { recursive: true, force: true }); }
});

test("视图:主通道(新浪)不通时兜底东财通道;分母用流通市值", async () => {
  const ctx = tmpCtx();
  try {
    let now = Date.parse("2026-10-23T14:05:00+08:00");
    const fetch = async (_c: unknown, req: { endpoint?: string; symbol?: string }) => {
      if (req.endpoint === "sina_market_money_rank") return { envelope: { extra: { rows: [] } } };
      if (req.endpoint === "em_market_main_net_rank") {
        return { envelope: { extra: { rows: [{ code: "600519", name: "贵州茅台", price: 1335, pct: 0.0176, main_net: 5.2e8, float_cap: CAP, amount: 7.6e9 }] } } };
      }
      return { envelope: minuteEnv(makeBars(240, 100, 4, 80), "2026-10-23 15:00:00", null, 1) };
    };
    const v = await shortlineFflow(ctx, {}, new AbortController().signal, { fetch: fetch as never, now: () => now }) as FflowView;
    assert.match(v.source_label, /东财/, "新浪空榜必须切到东财通道");
    assert.equal(v.stocks.length, 1);
    assert.ok(v.stocks[0]!.rise_bp >= 40, "东财通道(1 分钟桶)同样命中");
  } finally { fs.rmSync(ctx.dataRoot, { recursive: true, force: true }); }
});

test("视图:两条通道都不通时给可行动错误,不返回空壳", async () => {
  const ctx = tmpCtx();
  try {
    const fetch = async (_c: unknown, req: { endpoint?: string }) =>
      (req.endpoint === "sina_market_money_rank" || req.endpoint === "em_market_main_net_rank")
        ? { envelope: { extra: { rows: [] } } } : { envelope: {} };
    await assert.rejects(
      () => shortlineFflow(ctx, {}, new AbortController().signal, { fetch: fetch as never }),
      (e: unknown) => e instanceof Error && /资金流榜取不到/.test(e.message),
    );
  } finally { fs.rmSync(ctx.dataRoot, { recursive: true, force: true }); }
});
