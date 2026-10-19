import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { BOARD_RULES, proximity, type Bar, type Proximity } from "../src/finance/abnormal.ts";
import {
  announcementLines, ipoLine, ipoRows, ladderOf, overnightLine, riskWordOf, severeNote, shortlinePremarket, suspensionLines,
} from "../src/finance/shortline/premarket.ts";
import type { JobContext } from "../src/notify.ts";
import type { ServiceContext } from "../src/service.ts";

const DAY = "2026-10-12";             // 周一
const PREV = "2026-10-09";
const sh = (hm: string, day = DAY) => new Date(`${day}T${hm}:00+08:00`);
const signal = new AbortController().signal;
// 新股日历全表落在数据区(和取数器一样的 out_dir/raw/extracted_*.json)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "va-premarket-"));
const ctx: ServiceContext = { repoRoot: "", dataRoot: ROOT, python: "", node: "" };
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const job = (over: Partial<JobContext> = {}): JobContext => ({ ctx, day: DAY, now: sh("09:05"), signal, state: undefined, manual: false, ...over });

/** 结束于 end、长度 n 的工作日序列(够推算用,不管节假日) */
function weekdays(n: number, end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${end}T00:00:00Z`);
  while (out.length < n) {
    if (d.getUTCDay() % 6 !== 0) out.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}
const DATES = weekdays(100, PREV);
const flat = (n: number, v = 10): Bar[] => DATES.slice(-n).map((date) => ({ date, close: v }));
/** 最后 k 天每天涨 10%(连板) */
const run = (k: number): Bar[] => DATES.slice(-80).map((date, i, a) => ({ date, close: +(10 * 1.1 ** Math.max(0, i - (a.length - 1 - k))).toFixed(2) }));
const prox = (bars: Bar[]) => proximity(bars, flat(100, 100), BOARD_RULES.sh_main) as Proximity;

// ---------------------------------------------------------------- 真实形状的信封(2026-10-10 / 10-11 实取后精简)

const US = {
  status: "partial",
  evidence: [
    ["hkHSI", "恒生指数", 1.79, "2026/10/09 18:31:07"],
    ["usINX", "标普500", 0.59, "2026-10-09 17:29:56"],
    ["usDJI", "道琼斯", 0.83, "2026-10-09 16:37:50"],
    ["usIXIC", "纳斯达克", 0.64, "2026-10-09 17:15:59"],
  ].flatMap(([k, name, c, t]) => [
    { record_key: k, field: "change_pct", value: c, period: "2026-10-11", note: `${name}(${k})` },
    { record_key: k, field: "security_name", value: name, period: "2026-10-11", note: `${name}(${k})` },
    { record_key: k, field: "quote_time", value: t, period: "2026-10-11", note: `${name}(${k})` },
  ]),
};
const A50 = {
  status: "ok",
  evidence: [
    { field: "a50_last", value: 13729.16, period: "2026-10-10", note: "富时中国A50期货;datetime=2026-10-10 05:14:47", record_key: "a50" },
    { field: "a50_pre_settle", value: 13753.0, period: "2026-10-10", note: "富时中国A50期货;datetime=2026-10-10 05:14:47", record_key: "a50" },
  ],
};
const FX = { status: "ok", evidence: [{ field: "fx_usd_cny", value: 6.6925, period: "2026-10-09", note: "腾讯外汇 USDCNY" }] };
const IPO_REF = "raw/extracted_ipo_calendar.json";
const ipoEv = (code: string, name: string, field: string, value: unknown, period: string) =>
  ({ record_key: `ipo:${code}`, field, value, period, raw_ref: IPO_REF, note: `${code} ${name};深圳证券交易所/深交所创业板;申购代码=${code}` });
// 全表按申购日倒序;今天上市的丙半导体排在第 34 行,证据只写前 30 行,只有全表里有它
const IPO_ROWS = [
  { code: "920888", name: "乙光电", apply_date: "2026-10-14", listing_date: null, issue_price: 11.45 },
  { code: "301999", name: "甲新材", apply_date: DAY, listing_date: null, issue_price: 26.88 },
  ...Array.from({ length: 31 }, (_, i) => ({ code: `3015${String(i).padStart(2, "0")}`, name: `旧股${i}`, apply_date: "2026-09-01", listing_date: "2026-09-30", issue_price: 10 })),
  { code: "301777", name: "丙半导体", apply_date: "2026-08-24", listing_date: DAY, issue_price: 12.01 },
  { code: "301666", name: "丁药业", apply_date: "2026-08-21", listing_date: "2026-10-09", issue_price: null },
];
fs.mkdirSync(path.join(ROOT, "ipo", "raw"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "ipo", IPO_REF), JSON.stringify({ endpoint: "ipo_calendar", rows: IPO_ROWS, attrs: {} }));
const IPO = {
  status: "ok",
  evidence: [
    { field: "ipo_count", value: IPO_ROWS.length, period: "2026-08-21..2026-10-14", raw_ref: IPO_REF },
    ipoEv("920888", "乙光电", "ipo_issue_price", 11.45, "2026-10-14"),
    ipoEv("301999", "甲新材", "ipo_issue_price", 26.88, DAY),
    ipoEv("301999", "甲新材", "ipo_issue_pe", 44.72, DAY),
  ],
};
const SUS = {
  status: "ok",
  evidence: [
    { field: "suspension_count", value: 2, period: DAY },
    { field: "suspension_item", value: "002222 乙科技 · 刊登重要公告 · 连续停牌 · 停牌起 2026-10-12 09:30 · 预计复牌日未披露", period: DAY, record_key: "002222" },
    { field: "suspension_item", value: "000582 北部湾港 · 刊登重要公告 · 连续停牌 · 停牌起 2026-10-08 09:30 · 预计复牌日未披露", period: DAY, record_key: "000582" },
  ],
};
const CAL = (last = DAY, prev = PREV) => ({
  status: "ok",
  evidence: [
    { field: "last_trading_day", value: last, period: DAY },
    { field: "previous_trading_day", value: prev, period: DAY },
    { field: "is_today_trading_day", value: last === DAY, period: DAY },
    { field: "session_phase", value: last === DAY ? "pre_open" : "non_trading_day", period: DAY },
  ],
});
const LADDER = {
  status: "ok",
  evidence: [],
  extra: {
    result: {
      date: PREV,
      ladder: {
        available: true,
        levels: [
          { boards: 7, stocks: [{ code: "600880", name: "甲传媒", label: "7板", boards: 7 }] },
          { boards: 5, stocks: [{ code: "600111", name: "甲股份", label: "6天5板", boards: 5 }] },
          { boards: 3, stocks: [] },
          { boards: 2, stocks: [{ code: "002222", name: "乙科技", label: "2板", boards: 2 }, { code: "920111", name: "丙光电", label: "2板", boards: 2 }] },
          { boards: 1, stocks: [{ code: "000001", name: "首板股", label: "首板", boards: 1 }] },
        ],
      },
    },
  },
};
const ann = (value: string, period: string, record_key: string) => ({ field: "announcement_title", value, period, record_key });
const ANNS: Record<string, unknown> = {
  "600880": { status: "ok", evidence: [ann("甲传媒:关于股票交易严重异常波动的公告", PREV, "a1"), ann("甲传媒:2026年半年度报告", "2026-08-20", "a0")] },
  "600111": { status: "ok", evidence: [ann("甲股份:关于召开2026年第二次临时股东大会的通知", DAY, "b1"), ann("甲股份:关于召开2026年第二次临时股东大会的通知", DAY, "b1")] },
  "002222": { status: "failed", errors: [{ source: "cninfo", error: "Read timed out" }] },
  "920111": { status: "ok", evidence: [] },
};

type Req = { endpoint: string; symbol?: string; args?: Record<string, unknown>; consistency?: { mode: string } };
function fakeFetch(over: Partial<Record<string, unknown>> = {}) {
  const calls: Req[] = [];
  const fetch = async (_c: ServiceContext, req: Req) => {
    calls.push(req);
    const by: Record<string, unknown> = {
      fetch_trade_calendar: CAL(), tx_quotes_batch: US, a50_futures: A50, fx_rates: FX, ipo_calendar: IPO, em_suspensions: SUS,
      cn_shortline_board_ladder: LADDER, ...over,
    };
    const env = req.endpoint === "fetch_announcements" ? ANNS[req.symbol!] : by[req.endpoint];
    if (env instanceof Error) throw env;
    if (!env) throw new Error(`没准备 ${req.endpoint}`);
    return { envelope: env as Record<string, unknown>, out_dir: req.endpoint === "ipo_calendar" ? "ipo" : "" };
  };
  return { calls, fetch };
}
const barCalls: string[] = [];
const fakeBars = async (code: string) => {
  barCalls.push(code);
  if (code.length > 6) return { bars: flat(100, 100), note: "" };                       // 指数
  if (code === "600880") return { bars: run(7), note: "" };                             // 10 日 +94.9%,向上异常波动 3 次
  if (code === "002222") return { bars: [], note: "连不上" };
  return { bars: flat(80), note: "" };
};

// ---------------------------------------------------------------- 各段

test("隔夜外围:三大指数只写报价日、A50 较前结算、汇率带资料期;没取到的逐项写明", () => {
  assert.equal(overnightLine(US, A50, FX),
    "隔夜外围:道琼斯 +0.83% · 纳斯达克 +0.64% · 标普500 +0.59%(报价日 10-09);A50 期指 13729.16(较前结算 -0.17%,报价 10-10 05:14);美元兑人民币 6.6925(2026-10-09)");
  assert.equal(overnightLine({ status: "failed" }, undefined, { status: "ok", evidence: [] }), "隔夜外围:美股指数没取到;A50 期指没取到;汇率没取到");
  // 只缺一两个:逐个写没取到,不悄悄省掉
  const part = { status: "partial", evidence: US.evidence.filter((e) => e.record_key !== "usIXIC" && !(e.record_key === "usINX" && e.field === "change_pct")) };
  assert.equal(overnightLine(part, A50, FX).split(";")[0], "隔夜外围:道琼斯 +0.83% · 纳斯达克没取到 · 标普500没取到(报价日 10-09)");
  // 恒指不在三大指数里,不混进来;报价日跨两天的都列
  const two = structuredClone(US);
  (two.evidence.find((e) => e.record_key === "usINX" && e.field === "quote_time")!).value = "2026-10-10 04:00:00";
  assert.match(overnightLine(two, A50, FX), /^隔夜外围:道琼斯 \+0\.83% · 纳斯达克 \+0\.64% · 标普500 \+0\.59%\(报价日 10-09 \/ 10-10\);/);
});

test("连板股:只取 2 板及以上,按板数从高到低;没算出来 / 没取到写原因", () => {
  const l = ladderOf(LADDER);
  assert.equal(l.date, PREV);
  assert.deepEqual(l.stocks.map((s) => [s.code, s.label, s.boards]), [["600880", "7板", 7], ["600111", "6天5板", 5], ["002222", "2板", 2], ["920111", "2板", 2]]);
  // 层的顺序不靠源站:倒过来给也按板数从高到低
  const rev = structuredClone(LADDER);
  rev.extra.result.ladder.levels.reverse();
  assert.deepEqual(ladderOf(rev).stocks.map((s) => s.code), ["600880", "600111", "002222", "920111"]);
  assert.equal(ladderOf({ status: "ok", extra: { result: { date: PREV, ladder: { available: false, reason: "东财涨停池没取到" } } } }).reason, "东财涨停池没取到");
  assert.equal(ladderOf({ status: "failed", errors: [{ source: "eastmoney", error: "connection reset" }] }).reason, "eastmoney 连不上");
});

test("公告:标题里有停牌 / 异常波动这类字眼的排前面并标出来,多了折叠;没取到的单独列", () => {
  assert.equal(riskWordOf("关于股票交易严重异常波动的公告"), "严重异常");
  assert.equal(riskWordOf("关于召开股东大会的通知"), null);
  const names = new Map([["600880", "甲传媒"], ["600111", "甲股份"], ["002222", "乙科技"]]);
  const lines = announcementLines(PREV, names, [
    { code: "600111", date: DAY, title: "甲股份:关于召开股东大会的通知" },
    { code: "600880", date: PREV, title: "甲传媒:关于股票交易严重异常波动的公告" },
  ], 3, ["002222"]);
  assert.deepEqual(lines, [
    `连板股 ${PREV} 以来的公告 2 条(只列标题;方括号是标题里的字眼,不代表好坏):`,
    "甲传媒 10-09 [严重异常] 关于股票交易严重异常波动的公告",
    "甲股份 10-12 关于召开股东大会的通知",
    "公告没取到:乙科技",
  ]);
  const many = Array.from({ length: 13 }, (_, i) => ({ code: "600111", date: PREV, title: `公告${i}` }));
  const l2 = announcementLines(PREV, names, many, 1, []);
  assert.equal(l2.length, 1 + 10 + 1);
  assert.equal(l2.at(-1), "另有 3 条没列出");
  assert.deepEqual(announcementLines(PREV, names, [], 3, ["002222"]), [`已查的 2 只连板股 ${PREV} 以来没有新公告`, "公告没取到:乙科技"]);
  // 全没取到:不能说「没有新公告」
  assert.deepEqual(announcementLines(PREV, names, [], 1, ["002222"]), ["公告没取到:乙科技"]);
});

test("停复牌:只列名单里的连板股;名单没取到要说,不当成没停牌", () => {
  const names = new Map([["002222", "乙科技"], ["600880", "甲传媒"]]);
  assert.deepEqual(suspensionLines(SUS, names), ["连板股在今天的停复牌名单里:002222 乙科技 · 刊登重要公告 · 连续停牌 · 停牌起 2026-10-12 09:30 · 预计复牌日未披露"]);
  assert.deepEqual(suspensionLines(SUS, new Map([["600880", "甲传媒"]])), []);
  // 名单比写出来的条数多:说只核对了前几条
  const cut = { ...SUS, evidence: [{ ...SUS.evidence[0]!, value: 250 }, ...SUS.evidence.slice(1)] };
  assert.deepEqual(suspensionLines(cut, new Map([["600880", "甲传媒"]])), ["今天的停复牌名单 250 条,只核对了前 2 条"]);
  assert.deepEqual(suspensionLines({ status: "failed", errors: [{ source: "eastmoney", error: "timed out" }] }, names), ["今天的停复牌名单没取到(eastmoney 超时)"]);
});

test("异常波动:够近的才写(七成门槛 / 同向次数差一次),近 30 日已达到严重异常的照写日期", () => {
  assert.equal(severeNote(prox(run(3))), null, "3 连板:10 日 +33%、向上异常 1 次,不够近");
  assert.equal(severeNote(prox(run(5))), null, "5 连板:+61%(六成)、2 次,不够近");
  assert.equal(severeNote(prox(run(7))),
    `截至 ${PREV}:10 日累计偏离 +94.9%(严重异常标准 +100%);10 个交易日内向上异常波动 3 次(同向第 4 次构成严重异常)`);
  assert.equal(severeNote(prox(run(9))),
    "2026-10-08 已达到(10 个交易日内第 4 次向上异常波动;10 个交易日内累计偏离 +114.4%(标准 +100% / -50%))");
  assert.equal(severeNote(prox(flat(80))), null);
  // 近 30 日达到过不止一次:写最近那次,不看数组先后
  const p9 = prox(run(9));
  const early = { date: "2026-09-21", kind: "severe" as const, dir: "up" as const, why: "更早那次" };
  assert.match(severeNote({ ...p9, recent: [...p9.recent, early] })!, /^2026-10-08 已达到/);
  assert.match(severeNote({ ...p9, recent: [early, ...p9.recent] })!, /^2026-10-08 已达到/);
  // 当天刚达到异常波动的那一次要算进次数(same_dir 不含当天)
  const p = prox(run(5));
  assert.equal(severeNote({ ...p, abnormal: { ...p.abnormal, reached: "up" } }), `截至 ${PREV}:10 个交易日内向上异常波动 3 次(同向第 4 次构成严重异常)`);
});

test("新股:申购日 = 资料期、上市日 = 值;都没有 / 没取到分开说", () => {
  const rows = ipoRows(ctx, IPO, "ipo");
  assert.equal(rows?.length, 35);
  // 今天上市的在全表第 34 行(证据里没有),照样找得到
  assert.equal(ipoLine(IPO, DAY, rows), "今天申购 1 只:301999 甲新材(发行价 26.88 元);今天上市 1 只:301777 丙半导体");
  assert.equal(ipoLine(IPO, "2026-10-09", rows), "今天上市 1 只:301666 丁药业");
  assert.equal(ipoLine(IPO, "2026-10-13", rows), "今天没有新股申购或上市");
  // 全表没读到 / 空表:不说「没有」
  assert.equal(ipoRows(ctx, IPO, ""), null);
  assert.equal(ipoRows(ctx, { status: "ok", evidence: [{ field: "ipo_count", value: 3 }] }, "ipo"), null);
  assert.equal(ipoLine(IPO, DAY, null), "新股日历的完整名单没读到,今天有没有新股申购或上市没法确认");
  assert.equal(ipoLine({ status: "partial", evidence: [{ field: "ipo_count", value: 0 }] }, DAY, []), "新股日历是空的,今天有没有新股申购或上市没法确认");
  assert.equal(ipoLine({ status: "failed", reason: "东财新股日历超时" }, DAY, null), "新股日历没取到(东财新股日历超时)");
});

// ---------------------------------------------------------------- 整个任务

test("盘前提醒:前一交易日带日期现取连板天梯;公告 / 停牌 / 异常波动 / 外围 / 新股拼成一条", async () => {
  const { calls, fetch } = fakeFetch();
  barCalls.length = 0;
  const r = await shortlinePremarket(job(), { fetch: fetch as never, bars: fakeBars });
  assert.equal(r.messages.length, 1);
  const m = r.messages[0]!;
  assert.equal(m.title, `盘前提醒 ${DAY}`);
  assert.equal(m.dedupeKey, `shortline_premarket:${DAY}`);
  assert.equal(m.link, "/shortline");
  assert.deepEqual(m.lines, [
    "隔夜外围:道琼斯 +0.83% · 纳斯达克 +0.64% · 标普500 +0.59%(报价日 10-09);A50 期指 13729.16(较前结算 -0.17%,报价 10-10 05:14);美元兑人民币 6.6925(2026-10-09)",
    `${PREV} 连板 4 只:甲传媒 7板、甲股份 6天5板、乙科技 2板、丙光电 2板`,
    `连板股 ${PREV} 以来的公告 2 条(只列标题;方括号是标题里的字眼,不代表好坏):`,
    "甲传媒 10-09 [严重异常] 关于股票交易严重异常波动的公告",
    "甲股份 10-12 关于召开2026年第二次临时股东大会的通知",
    "公告没取到:乙科技",
    "连板股在今天的停复牌名单里:002222 乙科技 · 刊登重要公告 · 连续停牌 · 停牌起 2026-10-12 09:30 · 预计复牌日未披露",
    "严重异常波动已达到或较近的(按交易所规则推算,以交易所公告为准):",
    `甲传媒 600880 截至 ${PREV}:10 日累计偏离 +94.9%(严重异常标准 +100%);10 个交易日内向上异常波动 3 次(同向第 4 次构成严重异常)`,
    "北交所 丙光电:腾讯 K 线不支持,异常波动没算",
    "异常波动没算出来(日 K 或指数没取到):乙科技",
    "今天申购 1 只:301999 甲新材(发行价 26.88 元);今天上市 1 只:301777 丙半导体",
  ]);
  // 🔴 连板天梯一定带前一交易日的日期;所有取数都现取
  assert.deepEqual(calls.find((c) => c.endpoint === "cn_shortline_board_ladder")!.args, { date: PREV });
  assert.ok(calls.every((c) => c.consistency?.mode === "fresh"), "都是现取");
  assert.deepEqual(calls.filter((c) => c.endpoint === "fetch_announcements").map((c) => c.symbol).sort(), ["002222", "600111", "600880", "920111"]);
  assert.deepEqual(calls.find((c) => c.endpoint === "tx_quotes_batch")!.args, { codes: ["usDJI", "usIXIC", "usINX"] });
  // 指数一个板块取一次;北交所不取
  assert.deepEqual(barCalls.sort(), ["002222", "600111", "600880", "sh000002", "sz399107"]);
  assert.doesNotMatch(m.lines.join("\n"), /建议|买入|卖出|看好|看空|利好|利空|机会/);
});

test("盘前提醒:上午补跑时日 K 带着今天盘中那一根,也只算到前一交易日", async () => {
  const { fetch } = fakeFetch();
  const line = (r: { messages: { lines: string[] }[] }) => r.messages[0]!.lines.find((l) => l.startsWith("甲传媒 600880"));
  const base = line(await shortlinePremarket(job(), { fetch: fetch as never, bars: fakeBars }));
  // 腾讯盘中的日 K:最后一根是今天(甲传媒盘中又涨 10%),根数不变
  const withToday = async (code: string) => {
    const b = await fakeBars(code);
    if (!b.bars.length) return b;
    const last = b.bars.at(-1)!;
    return { ...b, bars: [...b.bars.slice(1), { date: DAY, close: +(last.close * (code === "600880" ? 1.1 : 1)).toFixed(2) }] };
  };
  const late = line(await shortlinePremarket(job({ now: sh("10:30") }), { fetch: fetch as never, bars: withToday }));
  assert.match(base!, new RegExp(`^甲传媒 600880 截至 ${PREV}:`));
  assert.equal(late, base);
});

test("盘前提醒:日 K 取到了但算不出来(根数不够),写明没算出来,不当成离标准远", async () => {
  const { fetch } = fakeFetch();
  const r = await shortlinePremarket(job(), { fetch: fetch as never, bars: async (code: string) => (code === "600111" ? { bars: flat(1), note: "" } : fakeBars(code)) });
  assert.ok(r.messages[0]!.lines.some((l) => /^异常波动没算出来:甲股份\(.+\)$/.test(l)), r.messages[0]!.lines.join("\n"));
});

test("盘前提醒:周末手动跑,前一交易日取最近交易日(周五)", async () => {
  const sat = "2026-10-10";
  const { calls, fetch } = fakeFetch({ fetch_trade_calendar: CAL(PREV, "2026-10-08") });
  await shortlinePremarket(job({ day: sat, now: sh("10:00", sat), manual: true }), { fetch: fetch as never, bars: fakeBars });
  assert.deepEqual(calls.find((c) => c.endpoint === "cn_shortline_board_ladder")!.args, { date: PREV });
});

test("盘前提醒:过了 11:30 才补跑的不发;手动照发", async () => {
  const { calls, fetch } = fakeFetch();
  const late = await shortlinePremarket(job({ now: sh("11:31") }), { fetch: fetch as never, bars: fakeBars });
  assert.deepEqual(late.messages, []);
  assert.match(late.note!, /11:31 才运行.*不补发/);
  assert.equal(calls.length, 0, "不取数");
  const at = await shortlinePremarket(job({ now: sh("11:30") }), { fetch: fetch as never, bars: fakeBars });
  assert.equal(at.messages.length, 1, "11:30 整还发");
  const manual = await shortlinePremarket(job({ now: sh("14:00"), manual: true }), { fetch: fetch as never, bars: fakeBars });
  // 用户自己把时刻改到 11:30 以后:照发,不是每天都「不补发」
  assert.equal((await shortlinePremarket(job({ now: sh("12:05"), at: "12:00" }), { fetch: fetch as never, bars: fakeBars })).messages.length, 1);
  assert.equal((await shortlinePremarket(job({ now: sh("13:00"), at: "11:30" }), { fetch: fetch as never, bars: fakeBars })).messages.length, 0);
  assert.equal(manual.messages.length, 1);
});

test("盘前提醒:日历没取到 → 连板股写明没取到(不猜日期);全没取到算失败让定时任务重试", async () => {
  const { calls, fetch } = fakeFetch({ fetch_trade_calendar: new Error("baostock 登录失败") });
  const r = await shortlinePremarket(job(), { fetch: fetch as never, bars: fakeBars });
  assert.ok(!calls.some((c) => c.endpoint === "cn_shortline_board_ladder"), "不知道哪天就不取");
  assert.deepEqual(r.messages[0]!.lines.slice(1), ["前一交易日的连板股没取到(交易日历没取到,不知道前一交易日是哪天)", "今天申购 1 只:301999 甲新材(发行价 26.88 元);今天上市 1 只:301777 丙半导体"]);

  const empty = fakeFetch({ cn_shortline_board_ladder: { status: "ok", extra: { result: { date: PREV, ladder: { available: true, levels: [{ boards: 1, stocks: [{ code: "000001", name: "首板股" }] }] } } } } });
  const r2 = await shortlinePremarket(job(), { fetch: empty.fetch as never, bars: fakeBars });
  assert.equal(r2.messages[0]!.lines[1], `${PREV} 没有连板股`);
  assert.ok(!empty.calls.some((c) => c.endpoint === "fetch_announcements" || c.endpoint === "tx_kline"));

  await assert.rejects(shortlinePremarket(job(), { fetch: (async () => { throw new Error("断网"); }) as never, bars: fakeBars }), /都没取到/);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(shortlinePremarket(job({ signal: ac.signal }), { fetch: (async () => { throw new Error("已取消"); }) as never, bars: fakeBars }), /已取消/);
});

test("盘前提醒:连板股超过上限只查板数最高的,并写明", async () => {
  const many = { boards: 2, stocks: Array.from({ length: 25 }, (_, i) => ({ code: `6001${String(i).padStart(2, "0")}`, name: i === 1 ? "退市股1" : `股${i}`, label: "2板", boards: 2 })) };
  const lad = structuredClone(LADDER);
  lad.extra.result.ladder.levels = [LADDER.extra.result.ladder.levels[0]!, many] as never;
  const sus = { status: "ok", evidence: [{ field: "suspension_count", value: 1, period: DAY }, { field: "suspension_item", value: "600124 股24 · 拟筹划重大资产重组", period: DAY, record_key: "600124" }] };
  const { calls, fetch } = fakeFetch({ cn_shortline_board_ladder: lad, em_suspensions: sus });
  barCalls.length = 0;
  const none = { status: "ok", evidence: [] };
  const r = await shortlinePremarket(job(), { fetch: (async (c: ServiceContext, req: Req) => (req.endpoint === "fetch_announcements" ? { envelope: none, out_dir: "" } : fetch(c, req))) as never, bars: fakeBars });
  const lines = r.messages[0]!.lines;
  assert.match(lines[1]!, /^2026-10-09 连板 26 只:甲传媒 7板、股0 2板、退市股1 2板、.*股10 2板 等$/);
  assert.equal(lines[2], "公告和异常波动只查了板数最高的 20 只");
  assert.equal(lines[3], `已查的 20 只连板股 ${PREV} 以来没有新公告`);
  assert.equal(calls.filter((c) => c.endpoint === "fetch_announcements").length, 0, "公告走了上面替换的那个");
  assert.ok(!barCalls.includes("600101"), "退市整理期不算异常波动");
  assert.ok(barCalls.includes("600118") && !barCalls.includes("600119"), "只算前 20 只");
  // 停复牌是一张全市场名单:排在第 20 只以后的也核对
  assert.ok(lines.includes("连板股在今天的停复牌名单里:600124 股24 · 拟筹划重大资产重组"));
});
