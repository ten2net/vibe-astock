/**
 * 定时任务「盘前提醒」(09:05,集合竞价前):把和短线有关、隔夜发生的事实列一遍,进收件箱。
 * 借鉴 GitHub 上几个短线仓库的「盘前推送」(只借思路,没有搬代码)。只报事实,不给方向、不点名该买该卖:
 *   1. 隔夜外围:美股三大指数、A50 期指(较前结算)、美元兑人民币
 *   2. 前一交易日的连板股(东财连板数 ≥ 2,来自 `cn_shortline_board_ladder`):
 *      - 前一交易日以来的公告标题,停牌 / 异常波动 / 问询 / 减持这类先列
 *      - 今天在停复牌名单里的
 *      - 按交易所规则推算、离严重异常波动较近的(推算,以交易所公告为准)
 *   3. 今天申购 / 上市的新股
 * 哪一项没取到就写没取到,不当成「没有」。
 * 程序上午没开、过了 11:30 才补跑就不发了(盘前的东西那时已经没用);手动「立即运行」照发。
 */
import { localClock, type JobContext, type JobResult, type NotifyMessage } from "../../notify.ts";
import { fetchEndpoint, type FetchResult, type ServiceContext } from "../../service.ts";
import { BOARD_RULES, KLINE_COUNT, boardOf, critRatio, klineBars, proximity, type Bar, type Board, type Proximity } from "../abnormal.ts";
import { readRawDoc } from "../candidates.ts";
import { SCHEDULE_TZ, failedNote, pool, rowsOf } from "../schedule.ts";
import { calendarFromEnvelope } from "../session.ts";

export const PREMARKET_AT = "09:05";
/** 过了这个时刻才补跑的不发 */
const LATE_AFTER = "11:30";
/** 公告和异常波动只查板数最高的这么多只 */
export const LADDER_MAX = 20;
const CONCURRENCY = 4;
const INDEX_COUNT = 100;
const US_INDEX = ["usDJI", "usIXIC", "usINX"] as const;
const US_NAME: Record<(typeof US_INDEX)[number], string> = { usDJI: "道琼斯", usIXIC: "纳斯达克", usINX: "标普500" };
/** 公告标题里出现这些词的先列,并把词标出来(只是按字面挑出来,不代表好坏) */
export const RISK_WORDS = ["停牌", "复牌", "核查", "严重异常", "异常波动", "风险提示", "减持", "问询", "关注函", "监管", "立案", "处罚", "退市", "澄清", "终止"] as const;
/** 离严重异常波动标准到七成以上才写(与自选变化里的异动接近度同一个门槛) */
const NEAR = 0.7;
const ANN_LINES = 10;

type Fetch = (ctx: ServiceContext, req: Parameters<typeof fetchEndpoint>[1]) => Promise<Pick<FetchResult, "envelope" | "out_dir">>;
export interface PremarketDeps {
  fetch?: Fetch;
  /** 日收盘序列(前复权);测试替换用 */
  bars?: (code: string, count: number) => Promise<{ bars: Bar[]; note: string }>;
}

interface Ev { field?: string; value?: unknown; period?: string; note?: string; record_key?: string; raw_ref?: string }
const evs = (env: unknown): Ev[] => (env && typeof env === "object" && Array.isArray((env as { evidence?: unknown }).evidence) ? (env as { evidence: Ev[] }).evidence : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const sign = (v: number, d = 2) => `${v > 0 ? "+" : ""}${v.toFixed(d)}%`;
const usable = (env: unknown) => !!env && typeof env === "object" && (env as { status?: unknown }).status !== "failed";

// ---------------------------------------------------------------- 各段

export interface LadderStock { code: string; name: string; label: string; boards: number }
export interface LadderPick { date: string | null; stocks: LadderStock[]; reason: string }

/** `cn_shortline_board_ladder` 信封 → 连板股(≥ 2 板),按板数从高到低、同板按首封先后 */
export function ladderOf(env: unknown): LadderPick {
  const res = (env as { extra?: { result?: { date?: unknown; ladder?: { available?: boolean; reason?: string; levels?: unknown[] } } } } | undefined)?.extra?.result;
  const date = typeof res?.date === "string" ? res.date : null;
  if (!usable(env) || !res?.ladder) return { date, stocks: [], reason: failedNote(env) || "没取到" };
  if (!res.ladder.available) return { date, stocks: [], reason: res.ladder.reason || "没算出来" };
  const stocks: LadderStock[] = [];
  for (const lv of Array.isArray(res.ladder.levels) ? res.ladder.levels : []) {
    const l = lv as { boards?: unknown; stocks?: unknown[] };
    if (!(num(l.boards)! >= 2)) continue;
    for (const s of Array.isArray(l.stocks) ? l.stocks : []) {
      const x = s as { code?: unknown; name?: unknown; label?: unknown; boards?: unknown };
      if (typeof x.code === "string") stocks.push({ code: x.code, name: String(x.name ?? ""), label: String(x.label ?? `${l.boards}板`), boards: num(x.boards) ?? num(l.boards)! });
    }
  }
  stocks.sort((a, b) => b.boards - a.boards);
  return { date, stocks, reason: "" };
}

/** 隔夜外围一行:美股三大指数(报价时间)、A50 期指较前结算、美元兑人民币 */
export function overnightLine(us: unknown, a50: unknown, fx: unknown): string {
  const parts: string[] = [];
  const rows = usable(us) ? rowsOf(us) : [];
  const idx = US_INDEX.map((code) => {
    const r = rows.find((x) => x.key === code);
    const c = num(r?.f.change_pct?.value);
    if (!r || c === null) return { name: US_NAME[code], c: null, t: "" };
    const t = typeof r.f.quote_time?.value === "string" ? r.f.quote_time.value : "";
    const name = typeof r.f.security_name?.value === "string" ? r.f.security_name.value : r.note.replace(/\(.*$/, "").trim();
    return { name: name || US_NAME[code], c, t };
  });
  const got = idx.filter((x) => x.c !== null);
  if (got.length) {
    // 只写报价日期(源站时间不带时区,不换算);缺的那几个逐个写没取到
    const days = [...new Set(got.map((x) => x.t.slice(0, 10).replace(/\//g, "-")).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
    parts.push(`${idx.map((x) => (x.c === null ? `${x.name}没取到` : `${x.name} ${sign(x.c)}`)).join(" · ")}${days.length ? `(报价日 ${days.map((d) => d.slice(5)).join(" / ")})` : ""}`);
  } else parts.push("美股指数没取到");

  const a = usable(a50) ? evs(a50) : [];
  const last = num(a.find((e) => e.field === "a50_last")?.value), pre = num(a.find((e) => e.field === "a50_pre_settle")?.value);
  if (last !== null && pre !== null && pre > 0) {
    const at = /datetime=(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(a.find((e) => e.field === "a50_last")?.note ?? "")?.[1];
    parts.push(`A50 期指 ${last}(较前结算 ${sign((last / pre - 1) * 100)}${at ? `,报价 ${at.slice(5)}` : ""})`);
  } else parts.push("A50 期指没取到");

  const usd = usable(fx) ? evs(fx).find((e) => e.field === "fx_usd_cny") : undefined;
  parts.push(num(usd?.value) !== null ? `美元兑人民币 ${num(usd!.value)}${usd!.period ? `(${usd!.period})` : ""}` : "汇率没取到");
  return `隔夜外围:${parts.join(";")}`;
}

export interface Ann { code: string; date: string; title: string }

/** 标题里命中的第一个词;没命中 = null */
export function riskWordOf(title: string): string | null {
  return RISK_WORDS.find((w) => title.includes(w)) ?? null;
}

/** 公告段:命中关键词的先列(标出词),其余按日期;最多 ANN_LINES 行 */
export function announcementLines(since: string, names: Map<string, string>, anns: Ann[], checked: number, failed: string[]): string[] {
  const label = (c: string) => `${names.get(c) || c}`;
  const out: string[] = [];
  const sorted = [...anns].sort((a, b) => Number(!riskWordOf(a.title)) - Number(!riskWordOf(b.title)) || b.date.localeCompare(a.date) || a.code.localeCompare(b.code));
  const ok = checked - failed.length;
  if (sorted.length) {
    out.push(`连板股 ${since} 以来的公告 ${sorted.length} 条(只列标题;方括号是标题里的字眼,不代表好坏):`);
    for (const a of sorted.slice(0, ANN_LINES)) {
      const w = riskWordOf(a.title);
      const n = names.get(a.code);
      const bare = n && a.title.startsWith(n) ? a.title.slice(n.length).replace(/^[:：]\s*/, "") || a.title : a.title;
      out.push(`${label(a.code)} ${a.date.slice(5)}${w ? ` [${w}]` : ""} ${bare}`);
    }
    if (sorted.length > ANN_LINES) out.push(`另有 ${sorted.length - ANN_LINES} 条没列出`);
  } else if (ok > 0) out.push(`已查的 ${ok} 只连板股 ${since} 以来没有新公告`);
  if (failed.length) out.push(`公告没取到:${failed.slice(0, 8).map(label).join("、")}${failed.length > 8 ? ` 等 ${failed.length} 只` : ""}`);
  return out;
}

/** 停复牌名单里的连板股;名单本身没取到要说 */
export function suspensionLines(env: unknown, names: Map<string, string>): string[] {
  if (!usable(env)) return [`今天的停复牌名单没取到${failedNote(env) ? `(${failedNote(env)})` : ""}`];
  const items = evs(env).filter((e) => e.field === "suspension_item");
  const hits = items.filter((e) => e.record_key && names.has(e.record_key) && typeof e.value === "string");
  const total = num(evs(env).find((e) => e.field === "suspension_count")?.value);
  const out = hits.length ? [`连板股在今天的停复牌名单里:${hits.map((e) => String(e.value)).join(";")}`] : [];
  // 名单条数比写出来的多:没列出的那几条里可能有
  if (total !== null && total > items.length) out.push(`今天的停复牌名单 ${total} 条,只核对了前 ${items.length} 条`);
  return out;
}

/**
 * 离严重异常波动多近的说明;不够近 = null。
 * 近 30 个交易日里按规则已达到过的照写(交易所可能已公告或停牌核查);达到后指标重新算,所以再看还差多少。
 * 接近度只看向上(连板股)。
 */
export function severeNote(p: Proximity): string | null {
  const parts: string[] = [];
  const sev = p.recent.filter((x) => x.kind === "severe").sort((a, b) => a.date.localeCompare(b.date)).pop();
  for (const c of [p.severe10, p.severe30]) {
    if (c.up !== null && critRatio({ ...c, down: null }) >= NEAR) parts.push(`${c.days} 日累计偏离 ${sign(c.up, 1)}(严重异常标准 +${c.limit[0]}%)`);
  }
  // same_dir 不含当天;当天达到异常波动的再加一次
  const n = p.same_dir.up + (p.abnormal.reached === "up" ? 1 : 0);
  if (n > 0 && n >= p.same_dir.need - 1) parts.push(`10 个交易日内向上异常波动 ${n} 次(同向第 ${p.same_dir.need} 次构成严重异常)`);
  const out = [sev ? `${sev.date} 已达到(${sev.why})` : "", parts.length ? `截至 ${p.as_of}:${parts.join(";")}` : ""].filter(Boolean);
  return out.length ? out.join(";") : null;
}

export interface IpoRow { code: string; name: string; apply: string; listing: string; price: number | null }

/** 新股日历全表:证据只写最近 30 条,全表在取数器落盘的 extracted 文件里(读法同 klineBars);读不到 = null */
export function ipoRows(ctx: Pick<ServiceContext, "dataRoot">, env: unknown, outDir: string): IpoRow[] | null {
  const ref = evs(env).map((e) => (typeof e.raw_ref === "string" ? e.raw_ref : "")).find((r) => r.startsWith("raw/extracted_"));
  const doc = ref ? readRawDoc(ctx, outDir, ref) as { rows?: unknown } | null : null;
  if (!Array.isArray(doc?.rows)) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return (doc!.rows as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === "object").map((r) => ({
    code: str(r.code), name: str(r.name), apply: str(r.apply_date), listing: str(r.listing_date), price: num(r.issue_price),
  }));
}

/** 今天申购 / 上市的新股;全表没读到或是空表,不说「没有」 */
export function ipoLine(env: unknown, day: string, rows: IpoRow[] | null): string {
  if (!usable(env)) return `新股日历没取到${failedNote(env) ? `(${failedNote(env)})` : ""}`;
  if (rows === null) return "新股日历的完整名单没读到,今天有没有新股申购或上市没法确认";
  if (!rows.length) return "新股日历是空的,今天有没有新股申购或上市没法确认";
  const nm = (r: IpoRow) => `${r.code} ${r.name}`.trim();
  const apply = rows.filter((r) => r.apply === day), listing = rows.filter((r) => r.listing === day);
  if (!apply.length && !listing.length) return "今天没有新股申购或上市";
  return [
    apply.length ? `今天申购 ${apply.length} 只:${apply.map((r) => `${nm(r)}${r.price !== null ? `(发行价 ${r.price} 元)` : ""}`).join("、")}` : "",
    listing.length ? `今天上市 ${listing.length} 只:${listing.map(nm).join("、")}` : "",
  ].filter(Boolean).join(";");
}

// ---------------------------------------------------------------- 组装

export interface PremarketParts {
  day: string;
  overnight: string;
  ladder: LadderPick;
  checked: number;
  anns: Ann[];
  annFailed: string[];
  suspension: string[];
  severe: { name: string; code: string; note: string }[];
  severeGaps: string[];
  ipo: string;
}

export function premarketMessage(p: PremarketParts): NotifyMessage {
  const lines = [p.overnight];
  const { ladder } = p;
  const names = new Map(ladder.stocks.map((s) => [s.code, s.name]));
  if (!ladder.stocks.length) {
    lines.push(ladder.reason ? `前一交易日的连板股没取到(${ladder.reason})` : `${ladder.date ?? "前一交易日"} 没有连板股`);
  } else {
    const shown = ladder.stocks.slice(0, 12).map((s) => `${s.name} ${s.label}`);
    lines.push(`${ladder.date} 连板 ${ladder.stocks.length} 只:${shown.join("、")}${ladder.stocks.length > 12 ? ` 等` : ""}`);
    if (ladder.stocks.length > p.checked) lines.push(`公告和异常波动只查了板数最高的 ${p.checked} 只`);
    lines.push(...announcementLines(ladder.date ?? p.day, names, p.anns, p.checked, p.annFailed));
    lines.push(...p.suspension);
    if (p.severe.length) {
      lines.push("严重异常波动已达到或较近的(按交易所规则推算,以交易所公告为准):");
      for (const s of p.severe) lines.push(`${s.name} ${s.code} ${s.note}`);
    }
    lines.push(...p.severeGaps);
  }
  lines.push(p.ipo);
  return { title: `盘前提醒 ${p.day}`, lines, link: "/shortline", dedupeKey: `shortline_premarket:${p.day}` };
}

// ---------------------------------------------------------------- 任务

export async function shortlinePremarket(j: JobContext, deps: PremarketDeps = {}): Promise<JobResult> {
  const hm = localClock(j.now, SCHEDULE_TZ).hm;
  // 设在上午、拖到 11:30 以后才补跑的不发(已经过时);用户自己设到 11:30 以后的照发
  if (!j.manual && hm > LATE_AFTER && (j.at ?? PREMARKET_AT) <= LATE_AFTER) return { messages: [], note: `程序 ${hm} 才运行,过了上午,今天的盘前提醒不补发` };
  const fetch = deps.fetch ?? fetchEndpoint;
  const fresh = { mode: "fresh" as const };
  const get = (endpoint: string, extra: { symbol?: string; args?: Record<string, unknown> } = {}) =>
    fetch(j.ctx, { endpoint, ...extra, consistency: fresh, signal: j.signal }).catch((e: unknown) => {
      if (j.signal.aborted) throw e;
      return { envelope: { status: "failed", reason: e instanceof Error ? e.message.slice(0, 80) : "没取到" }, out_dir: "" };
    });

  // 前一交易日:日历端点要一个主体,只用来定位市场(与门判定同一个写法)
  const cal = await get("fetch_trade_calendar", { symbol: "300308" });
  const facts = usable(cal.envelope) ? calendarFromEnvelope(cal.envelope as never) : null;
  // 今天是交易日:日历的「最近交易日」就是今天,前一交易日是 previous;周末手动运行时最近交易日(周五)就是要的那天
  const prev = !facts ? null : facts.last_trading_day < j.day ? facts.last_trading_day : facts.previous_trading_day < j.day ? facts.previous_trading_day : null;

  const [us, a50, fx, ipo, sus, lad] = await Promise.all([
    get("tx_quotes_batch", { args: { codes: [...US_INDEX] } }),
    get("a50_futures"),
    get("fx_rates"),
    get("ipo_calendar"),
    get("em_suspensions"),
    // 🔴 一定带日期(不带日期 = 「最近一个交易日」,周一早上可能还是上周五盘中那份);也要重新取:
    // 前一天盘中打开过页面的话,缓存里是没收盘的名单
    prev ? get("cn_shortline_board_ladder", { args: { date: prev } })
      : Promise.resolve({ envelope: { status: "failed", reason: "交易日历没取到,不知道前一交易日是哪天" }, out_dir: "" }),
  ]);

  const ladder = ladderOf(lad.envelope);
  if (!ladder.date && prev) ladder.date = prev;
  const picked = ladder.stocks.slice(0, LADDER_MAX);
  const since = ladder.date ?? prev ?? j.day;

  // 公告:每只取最近 30 条,留前一交易日以来的
  const anns: Ann[] = [];
  const annFailed: string[] = [];
  await pool(picked, CONCURRENCY, async (s) => {
    const r = await get("fetch_announcements", { symbol: s.code });
    if (!usable(r.envelope)) { annFailed.push(s.code); return; }
    const seen = new Set<string>();
    for (const e of evs(r.envelope)) {
      if (e.field !== "announcement_title" || typeof e.value !== "string" || !e.period || e.period < since) continue;
      const k = e.record_key ?? `${e.period}|${e.value}`;
      if (seen.has(k)) continue;
      seen.add(k);
      anns.push({ code: s.code, date: e.period, title: e.value });
    }
  });

  // 离严重异常波动多近:沿用自选「异动接近度」的推算(abnormal.ts),这里只挑够近的写
  const bars = deps.bars ?? (async (code: string, count: number) => {
    const r = await get("tx_kline", { symbol: code, args: { count } });
    return usable(r.envelope) ? { bars: klineBars(j.ctx, r.envelope, r.out_dir), note: "" } : { bars: [], note: failedNote(r.envelope) };
  });
  const severeGaps: string[] = [];
  // 退市整理期不纳入计算(与自选的异动接近度同一个判断)
  const cn = picked.filter((s) => { const b = boardOf(s.code); return b !== null && b !== "bse" && !/退$|^退市/.test(s.name.replace(/\s/g, "")); });
  const bse = picked.filter((s) => boardOf(s.code) === "bse");
  if (bse.length) severeGaps.push(`北交所 ${bse.map((s) => s.name).join("、")}:腾讯 K 线不支持,异常波动没算`);
  const boards = [...new Set(cn.map((s) => boardOf(s.code)!))];
  const index = new Map<Board, Bar[]>();
  await pool(boards, CONCURRENCY, async (b) => { index.set(b, (await bars(BOARD_RULES[b].index.code, INDEX_COUNT)).bars); });
  const lost: string[] = [], unsure: string[] = [];
  const severe = (await pool(cn, CONCURRENCY, async (s) => {
    const rule = BOARD_RULES[boardOf(s.code)!];
    const idx = index.get(boardOf(s.code)!) ?? [];
    const got = idx.length ? await bars(s.code, KLINE_COUNT) : { bars: [], note: "" };
    // 🔴 只算到前一交易日:上午补跑时腾讯日 K 会带今天盘中那一根,盘中越线不等于收盘越线
    const mine = got.bars.filter((b) => b.date <= since);
    if (!idx.length || !mine.length) { lost.push(s.name || s.code); return null; }
    // 上市不久按取到的根数判断(截掉今天那根之前,否则满 80 根的也会少一根)
    const listedInRange = got.bars.length < KLINE_COUNT && got.bars[0]!.date > (idx[0]?.date ?? "");
    const p = proximity(mine, idx, rule, { listedInRange });
    if ("error" in p) { unsure.push(`${s.name || s.code}(${p.error})`); return null; }
    const note = severeNote(p);
    return note ? { name: s.name, code: s.code, note } : null;
  })).filter((x): x is { name: string; code: string; note: string } => !!x);
  if (lost.length) severeGaps.push(`异常波动没算出来(日 K 或指数没取到):${lost.slice(0, 8).join("、")}${lost.length > 8 ? ` 等 ${lost.length} 只` : ""}`);
  if (unsure.length) severeGaps.push(`异常波动没算出来:${unsure.slice(0, 8).join("、")}${unsure.length > 8 ? ` 等 ${unsure.length} 只` : ""}`);

  const nothing = [us, a50, fx, ipo, sus, lad].every((r) => !usable(r.envelope));
  if (nothing) throw new Error("外围、连板股、停复牌和新股都没取到");
  // 停复牌是一张全市场名单,全部连板股都核对(不受只查前 LADDER_MAX 只的限制)
  const names = new Map(ladder.stocks.map((s) => [s.code, s.name]));
  return {
    messages: [premarketMessage({
      day: j.day,
      overnight: overnightLine(us.envelope, a50.envelope, fx.envelope),
      ladder, checked: picked.length, anns, annFailed,
      suspension: ladder.stocks.length ? suspensionLines(sus.envelope, names) : [],
      severe, severeGaps,
      ipo: ipoLine(ipo.envelope, j.day, usable(ipo.envelope) ? ipoRows(j.ctx, ipo.envelope, ipo.out_dir) : null),
    })],
  };
}
