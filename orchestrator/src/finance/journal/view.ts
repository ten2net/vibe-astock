/**
 * 交易日志视图(`GET /view/journal`)与写入动作(`POST /view/journal`)。移植自 VA v2.0.0 的交易日志。
 *
 * 读:交易流水(`trade`,和「我的股票」同一份)切成一轮一轮(episodes.ts),挂上交易标注(rows.ts),
 *     按打法 / 是否按计划 / 持有天数分组统计(stats.ts);风险与纪律、在险资金(risk.ts)、复查清单(inbox.ts)。
 *     设置(费率、规矩、账户规模)一起给。
 * 写(act):
 *   - `tag`:给某一笔交易写打法、是否按计划、计划止损 / 目标、备注(一笔一条标注,有就改);
 *   - `manual`:没有成交明细的补记(日期 + 盈亏 %),新建或修改;
 *   - `record`:记一笔交易 —— 几笔买卖成交一次写进交易流水(要么全写、要么全不写),再写标注;
 *   - `delete_tag`:删一条标注(补记就是删掉这条补记);
 *   - `settings`:改费率 / 规矩 / 账户规模;
 *   - `mode_save` / `mode_delete`:模式卡(modes.ts)。改了打法内容就开新版本、从次日生效,旧版本不动。
 * 最大浮盈浮亏要逐笔取行情、归因要读复盘条件,各自单独一个视图(excursion.ts / attribution.ts),
 * 这里的复查清单只用已缓存的行情,一次网络请求都不发。
 *
 * 🔴 个人交易数据不进 AI:这一页不往 AI 提问上下文里放任何东西(VA 合规口径),MCP 也不给交易日志工具。
 * 🔴 成交只在 `trade` 里:改数量、价格、删成交去「我的股票」,这里不另存一份。
 */
import { localClock } from "../../notify.ts";
import type { LedgerIssue, LedgerRecord } from "../../ledger.ts";
import { ServiceError, ledgerCheck, ledgerInsertMany, ledgerRemove, ledgerSnapshot, ledgerUpsert, type ServiceContext } from "../../service.ts";
import { SCHEDULE_TZ } from "../schedule.ts";
import { replayTrades, tradeOf, tradeProblem, type Trade } from "../holdings.ts";
import { DEFAULT_RULES, PLAYBOOKS, RULE_KEYS, RULE_LABELS, ruleProblem, type Rules } from "./defs.ts";
import { JOURNAL_ONLY_STOCKS, buildEpisodes, isJournalSymbol, type Episode, type EpisodeIssue } from "./episodes.ts";
import { DEFAULT_FEES, FEE_KEYS, FEE_LABELS, feeProblem, type FeeConfig } from "./fees.ts";
import { cachedExcursions, computeExcursions } from "./excursion.ts";
import { buildInbox, type ExcursionLite } from "./inbox.ts";
import { MODE_CHANGES_MAX, MODE_KIND, MODE_NAME_MAX, MODE_TEXT_FIELDS, MODE_TEXT_LABELS, MODE_TEXT_MAX, MODE_VERSIONS_MAX, cardOf, isPlaybook, modeChanged, modesPerformance, type ModeCard, type ModeTextField, type ModeVersion } from "./modes.ts";
import { realDay } from "./num.ts";
import { atRisk, discipline, equityCurve, rolling, violations } from "./risk.ts";
import { buildRows, tagOf, type JournalRow, type Tag, type TagProblem } from "./rows.ts";
import { journalStats, type JournalStats } from "./stats.ts";

/* ---------------- 设置 ---------------- */

export interface JournalSettings {
  /** 生效的费率;null = 设置有问题,算不了(看 problem) */
  fees: FeeConfig | null;
  fees_default: boolean;
  rules: Rules;
  rules_default: boolean;
  /** 用户填的账户规模;null = 没填,所有「占账户的比例」都不算 */
  equity_base: number | null;
  /** 设置本身的问题(字段不合规则、费率只填了一部分);有问题时交易日志不出数,页面只给改设置 */
  problem: string | null;
  /** 原样的设置记录(有问题时编辑框靠它回填) */
  raw: Record<string, unknown> | null;
  record_id: string | null;
  /** 台账里多出来的设置记录条数(只认最后修改的那条) */
  extra_records: number;
  labels: { fees: Record<string, string>; rules: Record<string, string> };
  defaults: { fees: FeeConfig; rules: Rules };
}

const newest = (rs: readonly LedgerRecord[]) =>
  [...rs].sort((a, b) => (a.updated_at !== b.updated_at ? (a.updated_at < b.updated_at ? 1 : -1) : a.id < b.id ? 1 : -1))[0] ?? null;

export function settingsOf(recs: readonly LedgerRecord[], issues: readonly LedgerIssue[]): JournalSettings {
  const rec = newest(recs);
  const base = {
    record_id: rec?.id ?? null, extra_records: Math.max(0, recs.length - 1),
    labels: { fees: { ...FEE_LABELS }, rules: { ...RULE_LABELS } },
    defaults: { fees: { ...DEFAULT_FEES }, rules: { ...DEFAULT_RULES } },
  };
  if (!rec) return { ...base, fees: { ...DEFAULT_FEES }, fees_default: true, rules: { ...DEFAULT_RULES }, rules_default: true, equity_base: null, problem: null, raw: null };
  const raw: Record<string, unknown> = Object.fromEntries(Object.entries(rec).filter(([k]) => !["id", "kind", "created_at", "updated_at"].includes(k)));
  const bad = issues.find((i) => i.id === rec.id);
  const rulesSaved = RULE_KEYS.filter((k) => raw[k] !== undefined);
  const rules = { ...DEFAULT_RULES, ...Object.fromEntries(rulesSaved.map((k) => [k, raw[k] as number])) } as Rules;
  const feesSaved = FEE_KEYS.filter((k) => raw[k] !== undefined);
  // 🔴 坏了就明说,不退回默认值:退回默认等于悄悄换成一套更宽松(或更严)的口径,用户却以为是自己定的
  const problem = bad ? `交易日志设置不合台账规则:${bad.why}` : feesSaved.length && feesSaved.length < FEE_KEYS.length ? feeProblem(raw) : null;
  const eq = typeof raw.equity_base === "number" && raw.equity_base > 0 ? raw.equity_base : null;
  return {
    ...base, raw, problem,
    fees: problem ? null : feesSaved.length ? (Object.fromEntries(FEE_KEYS.map((k) => [k, raw[k]])) as unknown as FeeConfig) : { ...DEFAULT_FEES },
    fees_default: !feesSaved.length,
    rules, rules_default: !rulesSaved.length,
    equity_base: eq,
  };
}

/* ---------------- 读 ---------------- */

export interface JournalData {
  trades: Trade[];
  tradeIssues: readonly LedgerIssue[];
  tags: Tag[];
  settings: JournalSettings;
  /** 模式卡(建卡顺序);不合台账规则的不用,只计数 */
  cards: ModeCard[];
  invalid_cards: number;
}

export function loadJournalData(ctx: ServiceContext): JournalData {
  const snap = ledgerSnapshot(ctx);
  const tagIssues = new Set((snap.issues.journal_tag ?? []).map((i) => i.id));
  return {
    trades: (snap.records.trade ?? []).map(tradeOf),
    tradeIssues: snap.issues.trade ?? [],
    // 字段不合规则的标注不用(台账页会列出来),和流水同一个处理
    tags: (snap.records.journal_tag ?? []).filter((r) => !tagIssues.has(r.id)).map(tagOf),
    settings: settingsOf(snap.records.journal_settings ?? [], snap.issues.journal_settings ?? []),
    ...cardsOf(snap.records[MODE_KIND] ?? [], snap.issues[MODE_KIND] ?? []),
  };
}

function cardsOf(recs: readonly LedgerRecord[], issues: readonly LedgerIssue[]): { cards: ModeCard[]; invalid_cards: number } {
  const bad = new Set(issues.map((i) => i.id));
  const ok = recs.filter((r) => !bad.has(r.id)).map(cardOf)
    .sort((a, b) => (a.created_at !== b.created_at ? (a.created_at < b.created_at ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { cards: ok, invalid_cards: recs.length - ok.length };
}

export interface JournalComputed {
  episodes: Episode[];
  rows: JournalRow[];
  issues: EpisodeIssue[];
  orphans: TagProblem[];
  conflicts: TagProblem[];
  skipped_non_a: string[];
  orphan_dividends: number;
}

export function computeJournal(d: JournalData, fees: FeeConfig): JournalComputed {
  const ep = buildEpisodes(d.trades, fees, d.tradeIssues);
  const skipped = new Map(ep.issues.map((i) => [i.id, i.why]));
  const rows = buildRows(ep.episodes, d.tags, skipped, new Set(d.trades.map((t) => t.id)));
  return { episodes: ep.episodes, rows: rows.rows, issues: ep.issues, orphans: rows.orphans, conflicts: rows.conflicts, skipped_non_a: ep.skipped_non_a, orphan_dividends: ep.orphan_dividends };
}

/**
 * 风险与纪律、在险资金、复查清单:都只对照用户自己的规矩和历史。
 * @param excursions 复查清单用的、已缓存行情算出的最大浮盈浮亏;null = 这一类判定不做
 */
export function journalRisk(rows: readonly JournalRow[], s: JournalSettings, excursions: { map: ReadonlyMap<string, ExcursionLite>; skipped: number } | null = null) {
  return {
    risk: {
      equity: equityCurve(rows),
      rolling: rolling(rows),
      discipline: discipline(rows),
      violations: violations(rows, s.rules, s.rules_default, s.equity_base),
    },
    at_risk: atRisk(rows, s.rules, s.rules_default, s.equity_base),
    inbox: buildInbox(rows, s.rules, s.rules_default, excursions?.map ?? null, excursions?.skipped ?? 0),
  };
}
export type JournalRisk = ReturnType<typeof journalRisk>;
export type JournalModes = { modes: ReturnType<typeof modesPerformance>; invalid_cards: number };

export type JournalView =
  | { available: false; reason: string; settings: JournalSettings; playbooks: readonly string[]; today: string }
  | ({ available: true; settings: JournalSettings; stats: JournalStats; playbooks: readonly string[]; today: string } & JournalComputed & JournalRisk & JournalModes);

const today = (now: Date) => localClock(now, SCHEDULE_TZ).day;

export async function buildJournalView(ctx: ServiceContext, now = new Date()): Promise<JournalView> {
  const d = loadJournalData(ctx);
  const common = { settings: d.settings, playbooks: PLAYBOOKS, today: today(now) };
  if (!d.settings.fees) return { available: false, reason: d.settings.problem ?? "交易日志设置有问题", ...common };
  const c = computeJournal(d, d.settings.fees);
  // 复查清单只看最近 500 笔(INBOX_LIMIT),只读缓存
  const ex = await cachedExcursions(ctx, c.rows.slice(0, 500));
  return {
    available: true, ...common, ...c, stats: journalStats(c.rows), ...journalRisk(c.rows, d.settings, ex),
    modes: modesPerformance(d.cards, c.rows), invalid_cards: d.invalid_cards,
  };
}

export async function journalView(ctx: ServiceContext, _query: Record<string, string>, _signal?: AbortSignal, now = new Date()): Promise<JournalView> {
  return buildJournalView(ctx, now);
}

/** `GET /view/journal_excursion` —— 「复查」页的最大浮盈浮亏:逐笔取行情(取到就永久缓存) */
export async function journalExcursion(ctx: ServiceContext, _query: Record<string, string>, signal: AbortSignal, now = new Date()) {
  const d = loadJournalData(ctx);
  if (!d.settings.fees) return { available: false as const, reason: d.settings.problem ?? "交易日志设置有问题" };
  return computeExcursions(ctx, computeJournal(d, d.settings.fees).rows, signal, now);
}

/* ---------------- 写 ---------------- */

const bad = (msg: string): never => { throw new ServiceError("bad_request", msg); };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const NOTE_MAX = 500;

/** 标注里用户能改的几个字段:取值检查交给台账规则,这里只管「传了什么」 */
function tagFields(body: Record<string, unknown>, opts: { manual: boolean }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body.playbook !== undefined && body.playbook !== null && body.playbook !== "") {
    if (!(PLAYBOOKS as readonly unknown[]).includes(body.playbook)) bad(`打法只能是 ${PLAYBOOKS.join(" / ")}`);
    out.playbook = body.playbook;
  }
  if (body.as_planned !== undefined && body.as_planned !== null) {
    if (typeof body.as_planned !== "boolean") bad("「按计划」只能是 是 / 否 / 不填");
    out.as_planned = body.as_planned;
  }
  if (typeof body.note === "string" && body.note.trim()) {
    if (body.note.trim().length > NOTE_MAX) bad(`备注最多 ${NOTE_MAX} 字`);
    out.note = body.note.trim();
  }
  if (opts.manual) {
    if (body.pnl_pct !== undefined && body.pnl_pct !== null) out.pnl_pct = body.pnl_pct;
    if (body.planned_stop != null || body.planned_target != null) bad("补记没有成交明细,在险资金算不了,不收计划止损 / 目标");
  } else {
    if (body.pnl_pct !== undefined && body.pnl_pct !== null) bad("有成交明细的交易,盈亏按流水算,不能手填");
    if (body.planned_stop != null) out.planned_stop = body.planned_stop;
    if (body.planned_target != null) out.planned_target = body.planned_target;
  }
  return out;
}

function checkTag(ctx: ServiceContext, rec: Record<string, unknown>): void {
  const why = ledgerCheck(ctx, "journal_tag", rec);
  if (why) bad(`标注写不进去:${why}`);
}

/** 写标注的公共部分:找到这一轮已有的那条(有就改),止损 / 目标变了就重盖标注时间 */
function saveTag(ctx: ServiceContext, d: JournalData, ep: Episode, fields: Record<string, unknown>, now: Date): LedgerRecord {
  const c = computeJournal(d, d.settings.fees ?? DEFAULT_FEES);
  const row = c.rows.find((r) => r.kind === "episode" && r.key === ep.id);
  const prev = row?.tag_id ? d.tags.find((t) => t.id === row.tag_id) ?? null : null;
  const rec: Record<string, unknown> = { symbol: ep.symbol, trade_id: ep.id, ...fields };
  if (ep.name) rec.name = ep.name;
  const hasPlan = rec.planned_stop !== undefined || rec.planned_target !== undefined;
  const samePlan = prev && (prev.planned_stop ?? undefined) === rec.planned_stop && (prev.planned_target ?? undefined) === rec.planned_target;
  // 🔴 止损 / 目标没变就沿用原来的标注时间:只改备注不该把它变成「事后补填」;改了止损就是新写下的,重盖
  if (hasPlan) rec.planned_at = samePlan && prev!.planned_at ? prev!.planned_at : now.toISOString();
  if (prev?.migrated_from) rec.migrated_from = prev.migrated_from;
  checkTag(ctx, rec);
  return ledgerUpsert(ctx, { kind: "journal_tag", record: prev ? { ...rec, id: prev.id } : rec });
}

function actTag(ctx: ServiceContext, body: Record<string, unknown>, now: Date): LedgerRecord {
  const tradeId = typeof body.trade_id === "string" ? body.trade_id : "";
  if (!tradeId) bad("要给出这笔交易里任意一笔流水的 id");
  const d = loadJournalData(ctx);
  const { episodes } = computeJournal(d, d.settings.fees ?? DEFAULT_FEES);
  const ep = episodes.find((e) => e.trade_ids.includes(tradeId));
  if (!ep) bad("找不到这笔交易:对应的流水可能删了、不参与计算,或不是 A 股股票");
  return saveTag(ctx, d, ep!, tagFields(body, { manual: false }), now);
}

function actManual(ctx: ServiceContext, body: Record<string, unknown>): LedgerRecord {
  const symbol = typeof body.symbol === "string" ? body.symbol.trim() : "";
  if (!isJournalSymbol(symbol)) bad(JOURNAL_ONLY_STOCKS);
  const date = typeof body.date === "string" ? body.date.trim() : "";
  if (!realDay(date)) bad("补记要写有效日期");
  const rec: Record<string, unknown> = { symbol, date, ...tagFields(body, { manual: true }) };
  if (typeof body.name === "string" && body.name.trim()) rec.name = body.name.trim();
  checkTag(ctx, rec);
  const id = typeof body.id === "string" && body.id ? body.id : null;
  if (id) {
    const d = loadJournalData(ctx);
    const prev = d.tags.find((t) => t.id === id);
    if (!prev) bad("没有这条补记(可能已经删了)");
    if (prev!.trade_id) bad("这条是有成交明细的交易的标注,不是补记");
    if (prev!.migrated_from) rec.migrated_from = prev!.migrated_from;
    return ledgerUpsert(ctx, { kind: "journal_tag", record: { ...rec, id } });
  }
  return ledgerUpsert(ctx, { kind: "journal_tag", record: rec });
}

/** 记一笔交易:成交 → 交易流水(整批),再写标注 */
export const RECORD_MAX_FILLS = 50;
function actRecord(ctx: ServiceContext, body: Record<string, unknown>, now: Date): { trade_ids: string[]; tag: LedgerRecord | null } {
  const symbol = typeof body.symbol === "string" ? body.symbol.trim() : "";
  if (!isJournalSymbol(symbol)) bad(JOURNAL_ONLY_STOCKS);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const fills = body.fills;
  if (!Array.isArray(fills) || !fills.length) bad("至少要有一笔成交");
  if ((fills as unknown[]).length > RECORD_MAX_FILLS) bad(`一次最多 ${RECORD_MAX_FILLS} 笔成交`);
  const recs = (fills as unknown[]).map((f, i) => {
    if (!isObj(f)) bad(`第 ${i + 1} 笔成交格式不对`);
    const x = f as Record<string, unknown>;
    if (x.type !== "buy" && x.type !== "sell") bad(`第 ${i + 1} 笔成交:类型只能是买入或卖出`);
    const r: Record<string, unknown> = { symbol, type: x.type, date: x.date, shares: x.shares, price: x.price };
    if (name) r.name = name;
    if (x.fee !== undefined && x.fee !== null && x.fee !== "") r.fee = x.fee;
    return r;
  });
  const tag = tagFields(body, { manual: false });
  // 先把所有检查做完再写:写了流水、标注却写不进去,用户就得去两个地方收拾
  if (Object.keys(tag).length) checkTag(ctx, { symbol, trade_id: "x", ...tag });
  const d = loadJournalData(ctx);
  const fees = d.settings.fees ?? DEFAULT_FEES;
  const pending: Trade[] = recs.map((r, i) => {
    const why = ledgerCheck(ctx, "trade", r);
    if (why) bad(`第 ${i + 1} 笔成交写不进去:${why}`);
    const t = tradeOf({ ...r, id: `new:${i}`, kind: "trade", created_at: `~${String(i).padStart(3, "0")}`, updated_at: "" } as LedgerRecord);
    const p = tradeProblem(t);
    if (p) bad(`第 ${i + 1} 笔成交:${p}`);
    return t;
  });
  // 写进去以后重放:新的几笔都要能算,已记的也不能因此变成算不了(比如补了一笔更早的卖出)
  const badIds = new Set(d.tradeIssues.map((i) => i.id));
  const usable = d.trades.filter((t) => !badIds.has(t.id));
  const before = new Set(replayTrades(usable, "average").issues.map((i) => i.id));
  const after = replayTrades([...usable, ...pending], "average").issues;
  const mine = after.filter((i) => i.id.startsWith("new:"));
  if (mine.length) bad(`这样记算不了:${mine.map((i) => `第 ${Number(i.id.slice(4)) + 1} 笔 ${i.why}`).join(";")}`);
  const broken = after.filter((i) => !i.id.startsWith("new:") && !before.has(i.id));
  if (broken.length) bad(`这样记会让已记的 ${broken.length} 笔流水算不了:${broken.slice(0, 3).map((i) => `${i.date} ${i.why}`).join(";")}`);
  const hypo = buildEpisodes([...d.trades, ...pending], fees, d.tradeIssues).episodes;
  const holders = new Set(pending.map((t) => hypo.find((e) => e.trade_ids.includes(t.id))?.id ?? ""));
  if (holders.size !== 1) bad("这几笔成交中间卖光过,不是同一笔交易:请分开记");

  const added = ledgerInsertMany(ctx, { kind: "trade", records: recs });
  const ids = added.map((r) => r.id);
  if (!Object.keys(tag).length) return { trade_ids: ids, tag: null };
  const fresh = loadJournalData(ctx);
  const ep = computeJournal(fresh, fresh.settings.fees ?? DEFAULT_FEES).episodes.find((e) => e.trade_ids.includes(ids[0]!));
  if (!ep) throw new ServiceError("partial", "成交已记上,但回读时找不到这笔交易,标注没写:请刷新后在交易记录里补标注");
  try {
    return { trade_ids: ids, tag: saveTag(ctx, fresh, ep, tag, now) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ServiceError("partial", `成交已记上,标注没写进去(${msg}):请在交易记录里补标注`);
  }
}

function actDeleteTag(ctx: ServiceContext, body: Record<string, unknown>): { removed: boolean } {
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) bad("要给出标注的 id");
  return ledgerRemove(ctx, { kind: "journal_tag", id });
}

/** 改设置:没传的保持原样;传 null = 改回默认(费率是四项一起) */
function actSettings(ctx: ServiceContext, body: Record<string, unknown>): LedgerRecord {
  const snap = ledgerSnapshot(ctx);
  const cur = settingsOf(snap.records.journal_settings ?? [], snap.issues.journal_settings ?? []);
  // 现有设置坏了:不在坏数据上合并,只用这次传进来的(VA 同样:完整输入可以修好坏配置)
  const rec: Record<string, unknown> = cur.problem ? {} : { ...(cur.raw ?? {}) };
  if (body.fees !== undefined) {
    for (const k of FEE_KEYS) delete rec[k];
    if (body.fees !== null) {
      if (!isObj(body.fees)) bad("费率格式不对");
      const p = feeProblem(body.fees as Record<string, unknown>);
      if (p) bad(p);
      for (const k of FEE_KEYS) rec[k] = (body.fees as Record<string, unknown>)[k];
    }
  }
  if (body.rules !== undefined) {
    if (!isObj(body.rules)) bad("规矩格式不对");
    for (const [k, v] of Object.entries(body.rules as Record<string, unknown>)) {
      if (!(RULE_KEYS as string[]).includes(k)) bad(`不认识的规矩 ${JSON.stringify(k)}`);
      const rk = k as (typeof RULE_KEYS)[number];
      if (v === null) { delete rec[rk]; continue; }
      const p = ruleProblem(rk, v);
      if (p) bad(p);
      rec[rk] = v;
    }
  }
  if (body.equity_base !== undefined) {
    if (body.equity_base === null) delete rec.equity_base;
    else if (typeof body.equity_base !== "number" || !Number.isFinite(body.equity_base) || body.equity_base <= 0) bad("账户规模要是大于 0 的数字(元)");
    else rec.equity_base = body.equity_base;
  }
  // 费率只有一部分(坏设置残留)也不让存
  const left = FEE_KEYS.filter((k) => rec[k] !== undefined);
  if (left.length && left.length < FEE_KEYS.length) bad(feeProblem(rec) ?? "费率要四项都填");
  const why = ledgerCheck(ctx, "journal_settings", rec);
  if (why) bad(`设置写不进去:${why}`);
  return ledgerUpsert(ctx, { kind: "journal_settings", record: cur.record_id ? { ...rec, id: cur.record_id } : rec });
}

/* ---------------- 模式卡 ---------------- */

const addDay = (day: string) => {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};
const textOf = (body: Record<string, unknown>, key: string, label: string, max: number): string => {
  const v = body[key];
  if (v !== undefined && v !== null && typeof v !== "string") bad(`「${label}」要是文字`);
  const t = typeof v === "string" ? v.trim() : "";
  if (t.length > max) bad(`「${label}」最多 ${max} 字(现在 ${t.length} 字)`);
  return t;
};

/**
 * 新建或修改模式卡。带 `card_id` 是修改:打法或五段文字有变化就开新版本(次日生效),旧版本原样保留;
 * 只改名字不开新版本。🔴 VA 超长会悄悄截断,这里直接拒收(截断等于替用户改了规则)。
 */
function actModeSave(ctx: ServiceContext, body: Record<string, unknown>, now: Date): { card: LedgerRecord; created: boolean; new_version: boolean } {
  const name = textOf(body, "name", "名字", MODE_NAME_MAX);
  if (!name) bad("模式卡要有名字");
  const playbook = typeof body.playbook === "string" ? body.playbook.trim() : "";
  if (!isPlaybook(playbook)) bad(`打法只能是 ${PLAYBOOKS.join(" / ")}`);
  const text = Object.fromEntries(MODE_TEXT_FIELDS.map((k) => [k, textOf(body, k, MODE_TEXT_LABELS[k], MODE_TEXT_MAX)])) as Record<ModeTextField, string>;
  const changes = textOf(body, "changes", "改了什么", MODE_CHANGES_MAX);
  const day = today(now), stamp = now.toISOString();
  const id = typeof body.card_id === "string" && body.card_id ? body.card_id : null;
  const write = (rec: Record<string, unknown>) => {
    const why = ledgerCheck(ctx, MODE_KIND, rec);
    if (why) bad(`模式卡写不进去:${why}`);
    return ledgerUpsert(ctx, { kind: MODE_KIND, record: rec });
  };
  if (!id) {
    // 第一版从今天生效,不回溯到更早
    const v1: ModeVersion = { version: 1, since: day, changes: "初版", playbook, ...text, saved_at: stamp };
    return { card: write({ name, playbook, versions: [v1] }), created: true, new_version: false };
  }
  const snap = ledgerSnapshot(ctx);
  const prev = (snap.records[MODE_KIND] ?? []).find((r) => r.id === id);
  if (!prev) bad("没找到这张模式卡,可能已经删了;请刷新后重试");
  if ((snap.issues[MODE_KIND] ?? []).some((i) => i.id === id)) bad("这张模式卡不合台账规则(可能在台账页被改过),先在台账页修好再改");
  const card = cardOf(prev!);
  // 老版本没存打法的,读出来时已用卡片层的打法回填,再比较 —— 否则「没改」会被当成「改了」,每存一次开一个新版本
  const last = card.versions.at(-1) ?? null;
  const changed = modeChanged(last, { ...text, playbook });
  let versions: ModeVersion[];
  if (changed) {
    versions = [...card.versions, { version: (last?.version ?? 0) + 1, since: addDay(day), changes: changes || "(没写改了什么)", playbook, ...text, saved_at: stamp }];
    if (versions.length > MODE_VERSIONS_MAX) bad(`一张卡最多 ${MODE_VERSIONS_MAX} 个版本;换了一套打法就新建一张卡`);
  } else {
    versions = [...card.versions.slice(0, -1), { ...last!, saved_at: stamp }];
  }
  const rec: Record<string, unknown> = { id, name, playbook, versions };
  if (card.migrated_from) rec.migrated_from = card.migrated_from;
  return { card: write(rec), created: false, new_version: changed };
}

function actModeDelete(ctx: ServiceContext, body: Record<string, unknown>): { removed: boolean } {
  const id = typeof body.card_id === "string" ? body.card_id : "";
  if (!id) bad("要给出模式卡的 id");
  const r = ledgerRemove(ctx, { kind: MODE_KIND, id });
  if (!r.removed) bad("没找到这张模式卡,可能已经删了");
  return r;
}

export async function journalAct(ctx: ServiceContext, body: Record<string, unknown>, _signal?: AbortSignal, now = new Date()): Promise<{ result: unknown; view: JournalView }> {
  const a = body.action;
  const result = a === "tag" ? actTag(ctx, body, now)
    : a === "manual" ? actManual(ctx, body)
    : a === "record" ? actRecord(ctx, body, now)
    : a === "delete_tag" ? actDeleteTag(ctx, body)
    : a === "settings" ? actSettings(ctx, body)
    : a === "mode_save" ? actModeSave(ctx, body, now)
    : a === "mode_delete" ? actModeDelete(ctx, body)
    : bad(`不认识的动作 ${JSON.stringify(a)}(只有 tag / manual / record / delete_tag / settings / mode_save / mode_delete)`);
  return { result, view: await buildJournalView(ctx, now) };
}
