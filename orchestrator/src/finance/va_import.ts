/**
 * 旧版(Vibe AStock v2.0.0 及更早,Python 版)数据导入:`GET /view/va_import` 给默认目录,`POST /view/va_import` 预览 / 导入。
 *
 * 旧数据目录默认 `~/.duanxian-agents`(旧版的 `ASTOCK_DATA_HOME` 设过就用它),页面上可以改。能导的:
 *   - 交易日志 `journal/trades.json`:每笔成交 → 一笔交易流水(`trade`,和「我的股票」同一份账);
 *     打法 / 按计划 / 计划止损目标 / 备注 → 交易标注(`journal_tag`),挂在每一轮的第一笔上;没有成交明细的 → 补记;
 *   - 费率 `journal/fees.json`、风险规矩 `risk/rules.json`、账户规模 `risk/equity_base.json` → 交易日志设置(新版还没有设置时);
 *   - 模式卡 `modes/cards.json` → `mode_card`(版本原样带过来);
 *   - AI 复盘 `reviews/<日期>.json` 与 `reviews/_versions/` 里的早版本 → `shortline_review`(每份一版,原文照搬);
 *   - 明日验证条件:每晚最后一版复盘里的条件 + `verification/<日期>.json` 里自己写的(同一读数以自己写的为准)→ `verification`;
 *   - 盘中快照 `intraday/<日期>/<时点>.json` → 新版快照文件(换成新格式,新版已有的时点不覆盖);
 *   - 个股深挖 `deepdive/` → 研究记录(`note`,分类「多空辩论」)。
 * 不导的(预览里逐项说明):方向命中评估、涨停池存档、各种缓存、龙头缓存、回测结果、周报缓存、被拒 / 备份 / 废弃的复盘。
 *
 * 🔴 旧目录只读:不改、不删、不挪。
 * 🔴 重复导入不重复写:每条都带 `migrated_from`(`va:` 开头,记旧数据里的 id 或日期),已导过的跳过。
 *    中途断掉的(成交写了、标注没写)再导一次会补上标注;一条旧记录的成交只剩一部分的(删过)不再导,说明原因。
 * 🔴 真写之前先把要写的台账文件原样复制到 `ledger/旧版导入备份-日期/`,附恢复说明;盘中快照只新建文件、从不覆盖。
 * 🔴 个人交易数据只在本机接口里给页面看,不进 AI、不进 MCP(和交易日志同口径);预览也只列代码和日期,不列金额。
 * ⚠️ 导入的复盘没按新版规则重新核对数字和证据,页面标「旧版导入」。旧版的复盘不分「盘中 / 收盘后」,
 *    这里按写完时刻是否晚于那天 15:00 判定。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localClock } from "../notify.ts";
import { nowIso } from "../fsutil.ts";
import type { LedgerRecord } from "../ledger.ts";
import { ServiceError, ledgerCheck, ledgerInsertMany, ledgerSnapshot, safePath, type ServiceContext } from "../service.ts";
import { PRODUCT_NAME } from "../brand.ts";
import { backupDir } from "./holdings_view.ts";
import { B_SHARE, B_SHARE_UNSUPPORTED, tradeOf, type Trade } from "./holdings.ts";
import { SCHEDULE_TZ } from "./schedule.ts";
import { PLAYBOOKS, RULE_KEYS, ruleProblem, type RuleKey } from "./journal/defs.ts";
import { FEE_KEYS, feeProblem } from "./journal/fees.ts";
import { MODE_CHANGES_MAX, MODE_KIND, MODE_NAME_MAX, MODE_TEXT_FIELDS, MODE_TEXT_MAX, MODE_VERSIONS_MAX } from "./journal/modes.ts";
import { pyRound, realDay } from "./journal/num.ts";
import { buildRows, tagOf } from "./journal/rows.ts";
import { JOURNAL_ONLY_STOCKS, buildEpisodes, isJournalSymbol } from "./journal/episodes.ts";
import { settingsOf } from "./journal/view.ts";
import { INTRADAY_DIR_REL, SLOTS, SCHEMA as SNAPSHOT_SCHEMA, driftMinutes, validWindow, writeNewJson, type Cohort, type LiveCounts, type Slot, type Snapshot, type TierStat, type TopBoard } from "./shortline/intraday.ts";
import { CITED_MAX, REVIEW_SECTIONS, SECTION_TEXT_MAX } from "./shortline/review_defs.ts";
import { VERIFY_METRIC_KEYS, type Direction } from "./shortline/verify_metrics.ts";

export const VA_IMPORT_BACKUP_PREFIX = "旧版导入备份";
/** 单个旧文件最多读多大(防把别的大文件当成旧数据读进内存) */
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
/** 交易日志里一条旧记录最多几笔成交(旧版没设上限,这里防坏文件) */
const MAX_FILLS = 500;
const TRADE_NOTE = "从旧版交易日志导入";
const REVIEW_GAP = "从旧版导入:原文照搬,数字和证据编号没有按新版规则重新核对";
const SNAPSHOT_GAP = "从旧版导入:旧版没记连板只数和晋级率,这几项空着;封板率、炸板率按当时的涨停、炸板家数算";
const EPS = 1e-8;

/* ---------------- 读旧目录 ---------------- */

const expandHome = (p: string) => (p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

/** 旧版默认的数据目录:设过 ASTOCK_DATA_HOME(绝对路径)就用它,否则 ~/.duanxian-agents(旧版 paths.py 同口径) */
export function defaultVaDir(env: NodeJS.ProcessEnv = process.env): string {
  const v = expandHome(String(env.ASTOCK_DATA_HOME ?? "").trim());
  return v && path.isAbsolute(v) ? v : path.join(os.homedir(), ".duanxian-agents");
}

/** 旧版数据目录里认得的子目录;一个都没有就不是旧版数据目录 */
const VA_DIRS = ["journal", "reviews", "modes", "risk", "verification", "intraday", "deepdive"] as const;

export function resolveVaDir(ctx: Pick<ServiceContext, "dataRoot">, input: unknown): string {
  const raw = typeof input === "string" && input.trim() ? input.trim() : defaultVaDir();
  if (raw.length > 1000) throw new ServiceError("bad_request", "旧版数据目录太长了");
  const p = expandHome(raw);
  if (!path.isAbsolute(p)) throw new ServiceError("bad_request", "旧版数据目录要写完整路径(以 / 或 ~ 开头)");
  let real: string;
  try { real = fs.realpathSync(p); } catch { throw new ServiceError("not_found", `找不到旧版数据目录:${p}`); }
  if (!fs.statSync(real).isDirectory()) throw new ServiceError("bad_request", `${p} 不是文件夹`);
  let root = path.resolve(ctx.dataRoot);
  try { root = fs.realpathSync(root); } catch { /* 数据目录还没建:按原路径比 */ }
  if (real === root || real.startsWith(root + path.sep) || root.startsWith(real + path.sep)) {
    throw new ServiceError("bad_request", "旧版数据目录不能是新版自己的数据目录(也不能包含它或在它里面)");
  }
  if (!VA_DIRS.some((d) => isDir(path.join(real, d)))) {
    throw new ServiceError("bad_request", `${p} 里没有旧版数据(${VA_DIRS.join("、")} 这几个文件夹一个都没有)`);
  }
  return real;
}

function isDir(p: string): boolean {
  try { return fs.lstatSync(p).isDirectory(); } catch { return false; }
}

type Read = { value: unknown } | { why: string } | null;

/** planImport 期间的导入根目录(planImport 全程同步,不会和另一次导入交错) */
let scanRoot = "";

/**
 * `p` 本身或它在导入根目录以下的哪一层是符号链接(快捷方式)。
 * 🔴 只查最后那个文件不够:`journal/` 整个指向目录外时,`journal/trades.json` 自己是普通文件,照样会读到目录外的东西。
 */
function underLink(p: string): boolean {
  if (!scanRoot) return false;
  for (let cur = path.resolve(p); cur.startsWith(scanRoot + path.sep); cur = path.dirname(cur)) {
    try { if (fs.lstatSync(cur).isSymbolicLink()) return true; } catch { return false; }
  }
  return false;
}

const LINKED = "是符号链接(快捷方式),没读";

/** 读一个旧 JSON 文件:没有 = null;读不出 = 原因。符号链接(包括所在文件夹是符号链接)、超大文件不读 */
function readJson(file: string): Read {
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch { return null; }
  if (st.isSymbolicLink()) return { why: LINKED };
  if (underLink(path.dirname(file))) return { why: `所在文件夹${LINKED}` };
  if (!st.isFile()) return { why: "不是普通文件,没读" };
  if (st.size > MAX_FILE_BYTES) return { why: `文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB,没读` };
  try { return { value: JSON.parse(fs.readFileSync(file, "utf8")) }; } catch { return { why: "文件读不出来(不是有效的 JSON)" }; }
}

/**
 * 目录下的文件名 / 子目录名。文件这边符号链接也列出来(读的时候说明没读),子目录只认真文件夹。
 * 目录本身(或上级)是符号链接、或者读不了(权限 / 读写错误)时交给 `onErr` 说明;只有「不存在」才当空目录
 * —— 原来一律当空,整组旧数据会悄悄漏掉、预览里也看不出来。
 */
function entries(dir: string, want: "file" | "dir", onErr?: (why: string) => void): string[] {
  if (underLink(dir)) { onErr?.(LINKED); return []; }
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => (want === "file" ? e.isFile() || e.isSymbolicLink() : e.isDirectory()))
      .map((e) => e.name).sort();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") onErr?.(`文件夹读不了(${code ?? "未知错误"}),这一组可能没导全`);
    return [];
  }
}

/** entries 的出错说明记进这一组的「没导」 */
const skipDir = (g: Group, what: string) => (why: string) => g.skipped.push({ what, why });

function countFiles(dir: string, depth = 3): number {
  if (depth < 0 || underLink(dir)) return 0;
  let n = 0;
  for (const e of (() => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } })()) {
    if (e.isFile()) n++;
    else if (e.isDirectory()) n += countFiles(path.join(dir, e.name), depth - 1);
  }
  return n;
}

/* ---------------- 小工具 ---------------- */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = Infinity) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pos = (v: unknown): number | null => { const n = fin(v); return n !== null && n > 0 ? n : null; };

/** 旧版的时间写法「YYYY-MM-DD HH:MM[:SS] CST」→ 新版台账的写法(北京时间 ISO,+08:00);读不出返回空串 */
export function vaTime(v: unknown): string {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\s*CST)?$/.exec(str(v));
  if (!m || !realDay(m[1]!) || Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4] ?? 0) > 59) return "";
  return `${m[1]}T${m[2]}:${m[3]}:${m[4] ?? "00"}.000+08:00`;
}

/** 旧版复盘的 HTML 片段 → 纯文字(段落换行,标签去掉,常见实体还原) */
export function htmlText(html: unknown): string {
  return str(html)
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
}

const DIRECTION_OF: Record<string, Direction> = { 上升: "up", 下降: "down", 持平: "flat", up: "up", down: "down", flat: "flat" };

/* ---------------- 计划 ---------------- */

export interface Skip { what: string; why: string }
export interface Group { key: string; label: string; found: number; add: number; already: number; skipped: Skip[]; notes: string[] }

/** 一条旧交易记录要写的东西:成交 → 流水(fills 里的下标做来源),每轮一条标注;没有成交 = 补记 */
interface JournalItem {
  va_id: string; symbol: string; date: string;
  trades: Record<string, unknown>[];
  /** 已经导过的成交:来源 → 新版流水 id(全部导过时才有) */
  existing: Map<string, string>;
  tags: { record: Record<string, unknown>; trade_key: string | null }[];
}

export interface ImportPlan {
  dir: string;
  groups: Group[];
  journal: JournalItem[];
  records: Record<string, Record<string, unknown>[]>;
  snapshots: { date: string; slot: Slot; file: string; snapshot: Snapshot }[];
  /** 导入后交易日志里会对不上的(按新版规则重放) */
  warnings: string[];
  not_imported: { label: string; count: number; why: string }[];
}

const group = (key: string, label: string): Group => ({ key, label, found: 0, add: 0, already: 0, skipped: [], notes: [] });

const migratedSet = (rs: readonly LedgerRecord[] | undefined) => new Set((rs ?? []).map((r) => str(r.migrated_from)).filter(Boolean));

/** 台账规则先过一遍,不合规的不写、列原因(insertRecords 一条不合规整批不写,所以要先筛) */
function checked(ctx: ServiceContext, kind: string, rec: Record<string, unknown>, what: string, g: Group): boolean {
  const why = ledgerCheck(ctx, kind, rec);
  if (why) g.skipped.push({ what, why: `不合新版台账规则:${why}` });
  return !why;
}

/* ---- 交易日志 ---- */

interface VaFill { side: "buy" | "sell"; date: string; price: number; shares: number; fee: number | null }

function vaFills(raw: unknown): VaFill[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return "成交明细格式不对";
  if (raw.length > MAX_FILLS) return `成交超过 ${MAX_FILLS} 笔,像是坏文件`;
  const out: VaFill[] = [];
  for (const [i, f] of raw.entries()) {
    if (!isObj(f)) return `第 ${i + 1} 笔成交格式不对`;
    const side = str(f.side).toLowerCase();
    const date = str(f.date);
    const price = pos(f.price), shares = pos(f.shares);
    if (side !== "buy" && side !== "sell") return `第 ${i + 1} 笔不是买也不是卖`;
    if (!realDay(date)) return `第 ${i + 1} 笔日期不对`;
    if (price === null || shares === null) return `第 ${i + 1} 笔价格或股数不对`;
    const fee = f.fee === undefined || f.fee === null || f.fee === "" ? null : fin(f.fee);
    if (fee !== null && fee < 0) return `第 ${i + 1} 笔费用是负数`;
    if (f.fee !== undefined && f.fee !== null && f.fee !== "" && fee === null) return `第 ${i + 1} 笔费用不是数字`;
    out.push({ side, date, price, shares, fee });
  }
  // 旧版只按日期排、同日保持录入顺序(稳定排序),这里一样
  return out.map((f, i) => ({ f, i })).sort((a, b) => (a.f.date < b.f.date ? -1 : a.f.date > b.f.date ? 1 : a.i - b.i)).map((x) => x.f);
}

function planJournal(ctx: ServiceContext, dir: string, snap: ReturnType<typeof ledgerSnapshot>, g: Group): JournalItem[] {
  const r = readJson(path.join(dir, "journal", "trades.json"));
  if (!r) return [];
  if ("why" in r) { g.skipped.push({ what: "journal/trades.json", why: r.why }); return []; }
  const env = r.value;
  if (!isObj(env) || !Array.isArray(env.trades) || ![1, 2, 3].includes(Number(env.schema))) {
    g.skipped.push({ what: "journal/trades.json", why: "不是旧版交易日志的格式(schema 1–3)" });
    return [];
  }
  const tradeIds = new Map<string, string>();
  for (const t of snap.records.trade ?? []) if (str(t.migrated_from)) tradeIds.set(str(t.migrated_from), t.id);
  const tagDone = migratedSet(snap.records.journal_tag);
  const out: JournalItem[] = [];
  // 旧版列表是记录先后;按录入时间排,同一天的成交在新版里也按这个先后
  const list = (env.trades as unknown[]).map((x, i) => ({ x, i }))
    .sort((a, b) => {
      const ca = isObj(a.x) ? str(a.x.created_at) : "", cb = isObj(b.x) ? str(b.x.created_at) : "";
      return ca !== cb ? (ca < cb ? -1 : 1) : a.i - b.i;
    });
  for (const { x, i } of list) {
    g.found++;
    if (!isObj(x)) { g.skipped.push({ what: `第 ${i + 1} 条`, why: "格式不对" }); continue; }
    const vaId = str(x.id);
    const code = str(x.code);
    const what = `${code || "?"} ${str(x.date) || "?"}`;
    if (!/^[0-9A-Za-z_-]{1,40}$/.test(vaId)) { g.skipped.push({ what, why: "没有记录编号,没法防重复导入" }); continue; }
    if (!/^\d{6}$/.test(code)) { g.skipped.push({ what, why: "代码不是 6 位数字" }); continue; }
    if (B_SHARE.test(code)) { g.skipped.push({ what, why: B_SHARE_UNSUPPORTED }); continue; }
    if (!isJournalSymbol(code)) { g.skipped.push({ what, why: JOURNAL_ONLY_STOCKS }); continue; } // 和新版手记同一条规则
    const fills = vaFills(x.fills);
    if (typeof fills === "string") { g.skipped.push({ what, why: fills }); continue; }
    const name = str(x.name, 40);
    const pb = str(x.playbook);
    const label = {
      ...((PLAYBOOKS as readonly string[]).includes(pb) ? { playbook: pb } : {}),
      ...(typeof x.as_planned === "boolean" ? { as_planned: x.as_planned } : {}),
      ...(str(x.note) ? { note: str(x.note, 500) } : {}),
    };
    const stop = pos(x.planned_stop), target = pos(x.planned_target);
    const planned = {
      ...(stop !== null ? { planned_stop: stop } : {}), ...(target !== null ? { planned_target: target } : {}),
      ...(stop !== null || target !== null ? { planned_at: vaTime(x.planned_edited_at) || vaTime(x.created_at) } : {}),
    };
    if ("planned_at" in planned && !planned.planned_at) delete (planned as { planned_at?: string }).planned_at;

    if (!fills.length) {
      const key = `va:journal:${vaId}`;
      const date = str(x.date);
      if (tagDone.has(key)) { g.already++; continue; }
      const pnl = fin(x.pnl_pct);
      const rec = { symbol: code, ...(name ? { name } : {}), date, ...label, ...planned, ...(pnl !== null ? { pnl_pct: pnl } : {}), migrated_from: key };
      if (!realDay(date)) { g.skipped.push({ what, why: "没有成交明细、也没有有效日期" }); continue; }
      if (!checked(ctx, "journal_tag", rec, what, g)) continue;
      out.push({ va_id: vaId, symbol: code, date, trades: [], existing: new Map(), tags: [{ record: rec, trade_key: null }] });
      g.add++;
      continue;
    }

    const keys = fills.map((_, k) => `va:journal:${vaId}:${k}`);
    const have = keys.filter((k) => tradeIds.has(k));
    if (have.length && have.length < keys.length) {
      g.skipped.push({ what, why: `这条的 ${keys.length} 笔成交只有 ${have.length} 笔还在(可能删过),没再导;要重导先到「我的股票」把剩下那几笔删掉` });
      continue;
    }
    const trades = have.length ? [] : fills.map((f, k) => ({
      symbol: code, ...(name ? { name } : {}), type: f.side, date: f.date, shares: f.shares, price: f.price,
      ...(f.fee !== null ? { fee: f.fee } : {}), note: TRADE_NOTE, migrated_from: keys[k],
    }));
    if (trades.some((t) => !checked(ctx, "trade", t, what, g))) continue;
    // 一条旧记录可以有几轮进出(回到空仓再买):每轮一条标注,挂在这一轮的第一笔上;计划止损 / 目标只给第一轮
    // 旧版每条记录自己结算、不许卖超(_settle 会报错);卖超的只可能是坏文件,不导
    const starts: number[] = [];
    let held = 0, oversold = false;
    fills.forEach((f, k) => {
      if (f.side === "buy" && held <= EPS) starts.push(k);
      held += f.side === "buy" ? f.shares : -f.shares;
      if (held < -EPS) oversold = true;
    });
    if (oversold) { g.skipped.push({ what, why: "成交明细里卖出超过了持有(旧版也不让这样记,像是文件被改坏了)" }); continue; }
    if (!starts.length) starts.push(0);
    const tags = starts.map((s, n) => ({
      record: { symbol: code, ...(name ? { name } : {}), trade_id: "", ...label, ...(n === 0 ? planned : {}), migrated_from: `va:journal:${vaId}#${n}` },
      trade_key: keys[s]!,
    })).filter((t) => !tagDone.has(String(t.record.migrated_from)));
    if (!trades.length && !tags.length) { g.already++; continue; }
    if (tags.some((t) => !checked(ctx, "journal_tag", { ...t.record, trade_id: "x" }, what, g))) continue;
    if (!trades.length) g.notes.push(`${what}:成交以前导过了,这次只补上标注`);
    out.push({ va_id: vaId, symbol: code, date: fills[0]!.date, trades, existing: new Map(have.map((k) => [k, tradeIds.get(k)!])), tags });
    g.add++;
  }
  return out;
}

/**
 * 预演:把要导的流水和标注加进现有的,按新版规则重放一遍,列出会对不上的(卖超、同一轮几条标注……)。
 * 只列代码、日期、方向和原因,不列成交价和股数(重放的原因里会有「卖出 N 股」,页面隐私模式按措辞遮)。
 */
function journalWarnings(snap: ReturnType<typeof ledgerSnapshot>, items: readonly JournalItem[], now: Date): string[] {
  if (!items.length) return [];
  const settings = settingsOf(snap.records.journal_settings ?? [], snap.issues.journal_settings ?? []);
  const fees = settings.fees ?? settings.defaults.fees;
  const base = (snap.records.trade ?? []).map(tradeOf);
  // 真写入时新记录的录入 / 修改时间是写入那一刻,晚于已有的一切:同一天的先后、几条标注谁算数都按这个模拟
  const at = Math.max(now.getTime(), ...[...(snap.records.trade ?? []), ...(snap.records.journal_tag ?? [])]
    .flatMap((r) => [Date.parse(r.created_at), Date.parse(r.updated_at)]).filter(Number.isFinite)) + 1;
  const planned: Trade[] = [];
  const keyToId = new Map<string, string>();
  let n = 0;
  for (const it of items) {
    for (const [k, id] of it.existing) keyToId.set(k, id);
    for (const t of it.trades) {
      const id = `预演-${++n}`;
      keyToId.set(String(t.migrated_from), id);
      planned.push(tradeOf({ ...t, id, kind: "trade", created_at: nowIso(new Date(at + n)), updated_at: "" } as LedgerRecord));
    }
  }
  const plannedIds = new Set(planned.map((t) => t.id));
  const before = new Set(buildEpisodes(base, fees, snap.issues.trade ?? []).issues.map((i) => i.id));
  const ep = buildEpisodes([...base, ...planned], fees, snap.issues.trade ?? []);
  const out: string[] = [];
  // 新版里已经手记过同一笔(同代码、同一天、同方向、同价同量;费用不比,两边常常一边没填):导入会记重,先提醒
  const same = (t: Trade) => [t.symbol.toUpperCase(), t.type, t.date, t.shares, t.price].join("|");
  const had = new Set(base.filter((t) => t.type === "buy" || t.type === "sell").map(same));
  for (const t of planned) {
    if (had.has(same(t))) out.push(`导入的 ${t.symbol} ${t.date} 那笔${t.type === "buy" ? "买入" : "卖出"}和已记的一笔同价同量,一模一样;如果是同一笔就记重了,导入后到「我的股票」的交易流水删掉多的那笔`);
  }
  for (const i of ep.issues) {
    if (plannedIds.has(i.id)) out.push(`导入的 ${i.symbol} ${i.date} 那笔算不了:${i.why}`);
    else if (!before.has(i.id)) out.push(`已记的 ${i.symbol} ${i.date} 那笔会因为导入的流水变成算不了:${i.why}`);
  }
  const tagBad = new Set((snap.issues.journal_tag ?? []).map((i) => i.id));
  const tags = (snap.records.journal_tag ?? []).filter((r) => !tagBad.has(r.id)).map(tagOf);
  let m = 0;
  for (const it of items) for (const t of it.tags) {
    const id = `预演标注-${++m}`;
    tags.push(tagOf({ ...t.record, trade_id: t.trade_key ? keyToId.get(t.trade_key) ?? "" : "", id, kind: "journal_tag", created_at: nowIso(new Date(at + n + m)), updated_at: nowIso(new Date(at + n + m)) } as LedgerRecord));
  }
  const skipped = new Map(ep.issues.map((i) => [i.id, i.why]));
  const rows = buildRows(ep.episodes, tags, skipped, new Set([...base, ...planned].map((t) => t.id)));
  for (const p of [...rows.orphans, ...rows.conflicts]) {
    if (p.id.startsWith("预演标注-")) out.push(`导入的 ${p.symbol} 的标注:${p.why}`);
  }
  for (const p of rows.conflicts) {
    if (!p.id.startsWith("预演标注-")) out.push(`已记的 ${p.symbol} 的标注会被导入的标注顶掉(同一笔交易只认最后修改的那条)`);
  }
  return [...new Set(out)];
}

/* ---- 交易日志设置 ---- */

function planSettings(ctx: ServiceContext, dir: string, snap: ReturnType<typeof ledgerSnapshot>, g: Group): Record<string, unknown>[] {
  const rec: Record<string, unknown> = {};
  const parts: string[] = [];
  const fees = readJson(path.join(dir, "journal", "fees.json"));
  if (fees) {
    g.found++;
    if ("why" in fees) g.skipped.push({ what: "费率", why: fees.why });
    else if (!isObj(fees.value) || feeProblem(fees.value)) g.skipped.push({ what: "费率", why: isObj(fees.value) ? feeProblem(fees.value)! : "格式不对" });
    else { for (const k of FEE_KEYS) rec[k] = fees.value[k]; parts.push("费率"); }
  }
  const rules = readJson(path.join(dir, "risk", "rules.json"));
  if (rules) {
    g.found++;
    const r = "value" in rules && isObj(rules.value) && rules.value.schema === 1 && isObj(rules.value.rules) ? rules.value.rules : null;
    const bad = r ? Object.entries(r).map(([k, v]) => (RULE_KEYS as string[]).includes(k) ? ruleProblem(k as RuleKey, v) : `不认识的规矩 ${k}`).find(Boolean) : null;
    if (!r || bad || !Object.keys(r).length) g.skipped.push({ what: "风险规矩", why: "why" in rules ? rules.why : bad ?? "格式不对" });
    else { Object.assign(rec, r); parts.push("风险规矩"); }
  }
  const eq = readJson(path.join(dir, "risk", "equity_base.json"));
  if (eq) {
    g.found++;
    const v = "value" in eq && isObj(eq.value) && eq.value.schema === 1 ? pos(eq.value.equity_base) : null;
    if (v === null) g.skipped.push({ what: "账户规模", why: "why" in eq ? eq.why : "格式不对" });
    else { rec.equity_base = v; parts.push("账户规模"); }
  }
  if (!parts.length) return [];
  if ((snap.records.journal_settings ?? []).length) {
    g.skipped.push({ what: parts.join("、"), why: "新版已经有交易日志设置,没覆盖;要用旧版的值请到交易日志页手动改" });
    return [];
  }
  if (!checked(ctx, "journal_settings", rec, parts.join("、"), g)) return [];
  g.add++;
  g.notes.push(`带过来:${parts.join("、")}`);
  return [rec];
}

/* ---- 模式卡 ---- */

function planModes(ctx: ServiceContext, dir: string, snap: ReturnType<typeof ledgerSnapshot>, g: Group): Record<string, unknown>[] {
  const r = readJson(path.join(dir, "modes", "cards.json"));
  if (!r) return [];
  if ("why" in r) { g.skipped.push({ what: "modes/cards.json", why: r.why }); return []; }
  if (!isObj(r.value) || r.value.schema !== 1 || !Array.isArray(r.value.cards)) {
    g.skipped.push({ what: "modes/cards.json", why: "不是旧版模式卡的格式" });
    return [];
  }
  const done = migratedSet(snap.records[MODE_KIND]);
  const out: Record<string, unknown>[] = [];
  for (const c of r.value.cards as unknown[]) {
    g.found++;
    if (!isObj(c)) { g.skipped.push({ what: "一张卡", why: "格式不对" }); continue; }
    const name = str(c.name, MODE_NAME_MAX);
    const id = str(c.id);
    const key = `va:mode:${id}`;
    if (!/^[0-9A-Za-z_-]{1,40}$/.test(id)) { g.skipped.push({ what: name || "一张卡", why: "没有卡片编号,没法防重复导入" }); continue; }
    if (done.has(key)) { g.already++; continue; }
    const cardPb = str(c.playbook);
    const versions = (Array.isArray(c.versions) ? c.versions : []).filter(isObj).map((v) => ({
      version: v.version, since: str(v.since),
      ...(str(v.changes) ? { changes: str(v.changes, MODE_CHANGES_MAX) } : {}),
      // 旧版老版本没有 playbook 字段时用卡片的(旧版 performance() 同口径)
      playbook: str(v.playbook) || cardPb,
      ...Object.fromEntries(MODE_TEXT_FIELDS.map((k) => [k, str(v[k], MODE_TEXT_MAX)])),
      ...(vaTime(v.saved_at) ? { saved_at: vaTime(v.saved_at) } : {}),
    }));
    if (versions.length > MODE_VERSIONS_MAX) { g.skipped.push({ what: name, why: `版本超过 ${MODE_VERSIONS_MAX} 个` }); continue; }
    const rec = { name, playbook: cardPb, versions, migrated_from: key };
    if (!checked(ctx, MODE_KIND, rec, name || "一张卡", g)) continue;
    out.push(rec);
    g.add++;
  }
  return out;
}

/* ---- AI 复盘 + 明日验证 ---- */

interface VaReview { file: string; rel: string; date: string; d: Record<string, unknown>; finished: string; latest: boolean }

function readReviews(dir: string, g: Group): VaReview[] {
  const out: VaReview[] = [];
  const add = (file: string, rel: string, latest: boolean) => {
    const r = readJson(file);
    if (!r) return;
    g.found++;
    if ("why" in r) { g.skipped.push({ what: rel, why: r.why }); return; }
    const d = r.value;
    if (!isObj(d) || d.run_type !== "daily_review") { g.skipped.push({ what: rel, why: "不是旧版的日复盘" }); return; }
    const date = str(d.trade_date);
    if (!realDay(date) || !rel.replace(/^_versions\//, "").startsWith(date)) { g.skipped.push({ what: rel, why: "复盘日期和文件名对不上" }); return; }
    out.push({ file, rel, date, d, finished: vaTime(d.generated_at), latest });
  };
  const base = path.join(dir, "reviews");
  for (const f of entries(base, "file", skipDir(g, "reviews/"))) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) add(path.join(base, f), f, true);
  for (const f of entries(path.join(base, "_versions"), "file", skipDir(g, "reviews/_versions/"))) if (/^\d{4}-\d{2}-\d{2}\.[0-9a-f]{6,64}\.json$/.test(f)) add(path.join(base, "_versions", f), `_versions/${f}`, false);
  return out;
}

type Cite = { id: string; line: string };

/** 多空辩论的两方:个股深挖和后期复盘是 join / avoid(正方 / 反方),7 月的早期复盘是 attack / ebb(进攻派 / 退潮派) */
const DEBATE_SIDES = [["join", "正方"], ["avoid", "反方"], ["attack", "进攻派"], ["ebb", "退潮派"]] as const;

function debateSides(v: unknown): [string, string][] {
  if (!isObj(v)) return [];
  return DEBATE_SIDES.flatMap(([k, label]) => {
    const t = htmlText(v[k]).replace(/^(正方|反方|参与派|回避派|进攻派|退潮派)\s*[::]\s*/, "");
    return t ? [[label, t] as [string, string]] : [];
  });
}

/** 证据行:旧版证据表的一条 → 「查看依据」里的一行 */
function evidenceLines(d: Record<string, unknown>): Map<string, string> {
  const rg = isObj(d.report_grounding) ? d.report_grounding : null;
  const lines = new Map<string, string>();
  for (const r of Array.isArray(rg?.records) ? rg!.records as unknown[] : []) {
    if (!isObj(r) || !/^ev-[0-9a-f]{6,}$/.test(str(r.id))) continue;
    const body = str(r.text) || [str(r.metric), r.value === undefined ? "" : String(r.value), str(r.unit)].filter(Boolean).join(" ");
    lines.set(str(r.id), [str(r.label), body].filter(Boolean).join(":").slice(0, 600));
  }
  return lines;
}

function citeIds(v: unknown): string[] {
  return (Array.isArray(v) ? v : []).map((x) => str(x)).filter((x) => /^ev-[0-9a-f]{6,}$/.test(x));
}

const withCites = (text: string, ids: readonly string[]) => (ids.length ? `${text} [${ids.join(", ")}]` : text);

function cites(text: string, lines: ReadonlyMap<string, string>): { cited: Cite[]; unknown_cites: string[] } {
  const ids = [...new Set([...text.matchAll(/ev-[0-9a-f]{6,}/g)].map((m) => m[0]))];
  return {
    cited: ids.filter((id) => lines.has(id)).slice(0, CITED_MAX).map((id) => ({ id, line: lines.get(id)! })),
    unknown_cites: ids.filter((id) => !lines.has(id)).slice(0, 40),
  };
}

/** 汇总段:旧版的「复盘焦点」(情绪阶段、一句话、关注方向、风险提示、多空辩论)拼成文字;有证据编号的带上 */
function summaryText(d: Record<string, unknown>): string {
  const focus = isObj(d.focus) ? d.focus : {};
  const rg = isObj(d.report_grounding) && isObj(d.report_grounding.summary) ? d.report_grounding.summary : null;
  const cited = (plain: unknown, g: unknown) => (isObj(g) ? withCites(str(g.text) || str(plain), citeIds(g.citations)) : str(plain));
  const out: string[] = [];
  if (str(focus.emotion_phase)) out.push(`情绪阶段:${str(focus.emotion_phase)}`);
  if (str(focus.market_oneliner)) out.push(`一句话:${cited(focus.market_oneliner, rg?.market_oneliner)}`);
  const dirs = Array.isArray(focus.focus_directions) ? focus.focus_directions.filter(isObj) : [];
  const gdirs = Array.isArray(rg?.focus_directions) ? (rg!.focus_directions as unknown[]) : [];
  if (dirs.length) {
    out.push("关注方向:");
    dirs.forEach((x, i) => {
      const gx = isObj(gdirs[i]) ? gdirs[i] as Record<string, unknown> : {};
      out.push(`- ${str(x.direction)}:${cited(x.logic, gx.logic)}${str(x.risk) ? ` 风险:${cited(x.risk, gx.risk)}` : ""}`);
    });
  }
  const risks = Array.isArray(focus.risk_alerts) ? focus.risk_alerts : [];
  const grisks = Array.isArray(rg?.risk_alerts) ? (rg!.risk_alerts as unknown[]) : [];
  if (risks.length) {
    out.push("风险提示:");
    risks.forEach((x, i) => out.push(`- ${cited(x, grisks[i])}`));
  }
  if (str(focus.debate_takeaway)) out.push(`多空辩论结论:${str(focus.debate_takeaway)}`);
  for (const [label, t] of debateSides(d.debate)) out.push(`${label}:${t}`);
  return out.join("\n");
}

function vaItems(d: Record<string, unknown>): { metric: string; direction: Direction; reason: string }[] | null {
  const focus = isObj(d.focus) ? d.focus : {};
  if (!Array.isArray(focus.verification_items)) return null;
  return focus.verification_items.filter(isObj).flatMap((v) => {
    const dir = DIRECTION_OF[str(v.direction)];
    const metric = str(v.metric);
    return dir && VERIFY_METRIC_KEYS.includes(metric) ? [{ metric, direction: dir, reason: str(v.reason, 200) }] : [];
  });
}

function reviewRecord(v: VaReview, key: string): Record<string, unknown> {
  const d = v.d;
  const lines = evidenceLines(d);
  const rg = isObj(d.report_grounding) ? d.report_grounding : null;
  const rgSections = new Map((Array.isArray(rg?.sections) ? rg!.sections as unknown[] : []).filter(isObj).map((s) => [str(s.key), s]));
  const analysts = new Map((Array.isArray(d.analysts) ? d.analysts : []).filter(isObj).map((a) => [str(a.key), a]));
  const sections = REVIEW_SECTIONS.map((s) => {
    if (s.id === "summary") {
      const text = summaryText(d).slice(0, SECTION_TEXT_MAX);
      const c = cites(text, lines);
      return text ? { id: s.id, label: s.label, status: "done", text, evidence_count: c.cited.length, ...c }
        : { id: s.id, label: s.label, status: "skipped", text: "", error: "旧版这一版没有汇总", evidence_count: 0 };
    }
    const g = rgSections.get(s.id);
    const findings = Array.isArray(g?.findings) ? (g!.findings as unknown[]).filter(isObj) : [];
    const text = (findings.length
      ? findings.map((f) => withCites(str(f.text), citeIds(f.citations))).filter((t) => t.trim()).join("\n\n")
      : htmlText(analysts.get(s.id)?.html)).slice(0, SECTION_TEXT_MAX);
    if (!text) return { id: s.id, label: s.label, status: "skipped", text: "", error: "旧版这一版没有这一段", evidence_count: 0 };
    const c = cites(text, lines);
    return { id: s.id, label: s.label, status: "done", text, evidence_count: c.cited.length, ...c };
  });
  const ai = isObj(d.ai_source) && (str(d.ai_source.provider) || str(d.ai_source.model))
    ? `旧版导入(${[str(d.ai_source.provider), str(d.ai_source.model)].filter(Boolean).join(" · ")})` : "旧版导入";
  const warnings = (Array.isArray(d.warnings) ? d.warnings : []).map((w) => str(w).replace(/^\[(.*)\]$/s, "$1").trim().slice(0, 400)).filter(Boolean);
  const asof = str(d.data_as_of);
  const settled = asof.includes("收盘") ? true
    : v.finished ? Date.parse(v.finished) >= Date.parse(`${v.date}T15:00:00+08:00`) : undefined;
  const items = vaItems(d);
  return {
    date: v.date, ...(settled === undefined ? {} : { settled }), ai: ai.slice(0, 80),
    started_at: "", finished_at: v.finished, sections,
    gaps: [REVIEW_GAP, ...warnings].slice(0, 80), conditions: [],
    conditions_note: items?.length
      ? v.latest ? "旧版这一晚的明日验证条件已经导进「明日验证」(旧版里它们自动生效,不用再点采用;同一读数自己写过的以自己写的为准)"
        : "这是当晚较早写的一版;旧版以最后一版的条件为准,这一版的条件没有导入"
      : "",
    migrated_from: key,
  };
}

function planReviews(ctx: ServiceContext, dir: string, snap: ReturnType<typeof ledgerSnapshot>, g: Group, vg: Group): { reviews: Record<string, unknown>[]; verification: Record<string, unknown>[] } {
  const list = readReviews(dir, g).sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.finished !== b.finished ? (a.finished < b.finished ? -1 : 1) : a.rel < b.rel ? -1 : 1));
  const done = migratedSet(snap.records.shortline_review);
  const reviews: Record<string, unknown>[] = [];
  const seen = new Map<string, number>();
  for (const v of list) {
    // 来源键按「复盘日 + 写完时刻」:旧版重写一版时原文件挪进 _versions、文件名会变,写完时刻不变
    const base = `va:review:${v.date}@${v.finished ? v.finished.slice(0, 16) : v.rel.replace(/\.json$/, "")}`.slice(0, 74);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const key = n > 1 ? `${base}#${n}` : base;
    if (done.has(key)) { g.already++; continue; }
    const rec = reviewRecord(v, key);
    if (!checked(ctx, "shortline_review", rec, `${v.date} 的复盘(${v.rel})`, g)) continue;
    reviews.push(rec);
    g.add++;
  }

  // 明日验证:每晚最后一版复盘的条件 + 自己写的(同一读数自己写的为准,旧版 merged_items 同口径)
  const latest = new Map(list.filter((v) => v.latest).map((v) => [v.date, v]));
  const byDate = new Map<string, Map<string, { metric: string; direction: Direction; reason: string; written_at: string }>>();
  for (const [date, v] of latest) {
    const items = vaItems(v.d) ?? [];
    const raw = isObj(v.d.focus) && Array.isArray(v.d.focus.verification_items) ? v.d.focus.verification_items.length : 0;
    if (raw > items.length) vg.skipped.push({ what: `${date} 那晚的条件`, why: `${raw - items.length} 条读数或方向新版不认识` });
    byDate.set(date, new Map(items.map((it) => [it.metric, { ...it, written_at: v.finished }])));
  }
  const udir = path.join(dir, "verification");
  for (const f of entries(udir, "file", skipDir(vg, "verification/"))) {
    const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
    if (!m || !realDay(m[1]!)) continue;
    const r = readJson(path.join(udir, f));
    if (!r) continue;
    const env = "value" in r && isObj(r.value) && r.value.schema === 1 && r.value.date === m[1] && Array.isArray(r.value.items) ? r.value : null;
    if (!env) { vg.skipped.push({ what: `verification/${f}`, why: "why" in r ? r.why : "不是旧版自设条件的格式" }); continue; }
    const day = byDate.get(m[1]!) ?? new Map();
    for (const it of (env.items as unknown[]).filter(isObj)) {
      const dir2 = DIRECTION_OF[str(it.direction)];
      const metric = str(it.metric);
      if (!dir2 || !VERIFY_METRIC_KEYS.includes(metric)) { vg.skipped.push({ what: `${m[1]} 自己写的条件`, why: `读数「${metric}」或方向新版不认识` }); continue; }
      // 自己写的没有记写下时间:不知道就按导入时刻算(= 事后),不替用户认定是当晚写的
      day.set(metric, { metric, direction: dir2, reason: str(it.reason, 200), written_at: "" });
    }
    byDate.set(m[1]!, day);
  }
  const vdone = migratedSet(snap.records.verification);
  const own = new Set((snap.records.verification ?? []).filter((r) => !str(r.migrated_from)).map((r) => `${r.date}|${r.metric}`));
  const verification: Record<string, unknown>[] = [];
  for (const [date, items] of [...byDate].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const it of items.values()) {
      vg.found++;
      const key = `va:verify:${date}:${it.metric}`;
      if (vdone.has(key)) { vg.already++; continue; }
      if (own.has(`${date}|${it.metric}`)) { vg.skipped.push({ what: `${date} ${it.metric}`, why: "新版里这一晚已经有这个读数的条件,没覆盖" }); continue; }
      const rec = { date, metric: it.metric, direction: it.direction, ...(it.reason ? { reason: it.reason } : {}), migrated_from: key, ...(it.written_at ? { written_at: it.written_at } : {}) };
      if (!checked(ctx, "verification", rec, `${date} ${it.metric}`, vg)) continue;
      verification.push(rec);
      vg.add++;
    }
  }
  if (verification.length) vg.notes.push("旧版复盘写完时已经过了下一个交易日 09:15 的条件、以及自己写的条件(旧版没记写下时间),新版标「事后」、不计入战绩(旧版不分)");
  return { reviews, verification };
}

/* ---- 盘中快照 ---- */

const rate = (hit: number, total: number) => (total ? pyRound(hit / total, 3) : null);

/** 旧版快照(schema 3)→ 新版快照;不能当作那个时点的快照的返回原因 */
export function snapshotOf(raw: unknown, day: string, slot: Slot): Snapshot | string {
  if (!isObj(raw)) return "格式不对";
  if (raw.schema !== 3) return `旧版早期格式(schema ${String(raw.schema)}),没有盘面家数和覆盖率,没导`;
  if (raw.date !== day || raw.slot !== slot) return "文件里的日期、时点和文件名对不上";
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?: CST)?$/.exec(str(raw.captured_at));
  if (!m || m[1] !== day) return "抓取时间不是这一天";
  const hms = m[2]!;
  if (!validWindow(slot, hms.slice(0, 5))) return "抓取时刻不在这个时点的有效窗口里(旧版也不认)";
  const basis = slot === "09:25" ? "open" : "latest";
  // 早期快照没记价格口径:旧版对盘中时点照用(只可能是最新价),09:25 必须证明是开盘价(旧版 _opening_basis 同口径)
  const key = raw.basis_key;
  const opening = key === "open_vs_prev_close" || (key === undefined && raw.price_basis === "当日开盘价 / 昨收");
  if (slot === "09:25" ? !opening : key !== undefined && key !== "latest_vs_prev_close") {
    return slot === "09:25" ? "早期的竞价快照没记是不是按开盘价算的(旧版也不认)" : "价格口径和时点对不上";
  }
  const sample = fin(raw.sample);
  if (sample === null || sample <= 0 || !Number.isInteger(sample)) return "样本数不对";
  const nums = ["avg", "median", "up_count", "down_count", "up_rate", "deep_loss_5", "top_board_level"].map((k) => fin(raw[k]));
  if (nums.some((x) => x === null)) return "缺读数";
  const [avg, median, up, down, upRate, deep, topLevel] = nums as number[];
  const exp = pos(raw.expected_sample);
  const cov = pos(raw.coverage_rate);
  const expected = exp !== null ? exp : cov !== null ? Math.round(sample / cov) : null;
  if (expected === null || expected < sample) return "没记应有样本数和覆盖率";
  const byTier: Record<string, TierStat> = {};
  for (const [k, v] of Object.entries(isObj(raw.by_tier) ? raw.by_tier : {})) {
    if (!isObj(v)) continue;
    const t = [fin(v.sample), fin(v.avg), fin(v.median), fin(v.up_rate)];
    if (t.every((x) => x !== null)) byTier[k] = { sample: t[0]!, avg: t[1]!, median: t[2]!, up_rate: t[3]! };
  }
  const tops: TopBoard[] = (Array.isArray(raw.top_boards) ? raw.top_boards : []).filter(isObj).map((t) => ({
    code: str(t.code), name: str(t.name), boards: fin(t.boards) ?? 0, sector: str(t.sector), pct: fin(t.pct), at_limit: null,
  }));
  const cohort: Cohort = {
    expected, sample, coverage_rate: exp !== null ? pyRound(sample / expected, 3) : cov!,
    avg, median, up_count: up, down_count: down, up_rate: upRate, deep_loss_5: deep,
    by_tier: byTier, top_board_level: topLevel, top_boards: tops,
  };
  const lv = isObj(raw.live) ? raw.live : null;
  const zt = lv ? fin(lv.limit_up) : null, zb = lv ? fin(lv.broken) : null;
  const live: LiveCounts | null = lv ? {
    limit_up: zt, broken: zb, limit_down: fin(lv.limit_down), highest_board: fin(lv.highest_board), consec_count: null,
    seal_rate: zt !== null && zb !== null ? rate(zt, zt + zb) : null, broken_rate: zt !== null && zb !== null ? rate(zb, zt + zb) : null,
    promotion_1to2: null, promotion_all: null,
  } : null;
  return {
    schema: SNAPSHOT_SCHEMA, date: day, slot, captured_at: new Date(`${day}T${hms}+08:00`).toISOString(), clock: hms,
    drift_minutes: fin(raw.drift_minutes) ?? driftMinutes(slot, hms.slice(0, 5)) ?? 0,
    basis, prev_date: realDay(str(raw.prev_date)) ? str(raw.prev_date) : "",
    cohort, live, ...(live ? {} : { live_reason: "旧版这个时点没取到盘面家数" }),
    gaps: [SNAPSHOT_GAP, ...(key === undefined && slot !== "09:25" ? ["旧版早期快照没记价格口径;盘中时点按最新价对昨收算(旧版同样照用)"] : [])],
  };
}

function planSnapshots(ctx: ServiceContext, dir: string, g: Group): ImportPlan["snapshots"] {
  const out: ImportPlan["snapshots"] = [];
  const base = path.join(dir, "intraday");
  for (const day of entries(base, "dir", skipDir(g, "intraday/"))) {
    if (!realDay(day)) continue;
    for (const f of entries(path.join(base, day), "file", skipDir(g, `intraday/${day}/`))) {
      const m = /^(\d{2})(\d{2})\.json$/.exec(f);
      if (!m) continue;
      g.found++;
      const slot = `${m[1]}:${m[2]}`;
      if (!(SLOTS as readonly string[]).includes(slot)) { g.skipped.push({ what: `${day} ${slot}`, why: "不是新版认的时点(09:25 / 09:35 / 10:00 / 11:30 / 14:00 / 15:00)" }); continue; }
      const dest = safePath(ctx, INTRADAY_DIR_REL, day, f);
      if (fs.existsSync(dest)) { g.already++; continue; }
      const r = readJson(path.join(base, day, f));
      if (!r) continue;
      if ("why" in r) { g.skipped.push({ what: `${day} ${slot}`, why: r.why }); continue; }
      const s = snapshotOf(r.value, day, slot as Slot);
      if (typeof s === "string") { g.skipped.push({ what: `${day} ${slot}`, why: s }); continue; }
      out.push({ date: day, slot: slot as Slot, file: dest, snapshot: s });
      g.add++;
    }
  }
  return out;
}

/* ---- 个股深挖 ---- */

const REPORT_LABELS: Record<string, string> = { capital: "资金", risk: "风险", technical: "技术", theme: "题材", sentiment: "情绪", fundamental: "基本面", news: "消息" };

function deepdiveNote(d: Record<string, unknown>, key: string): Record<string, unknown> | string {
  const code = str(d.code);
  if (!/^\d{6}$/.test(code)) return "代码不是 6 位数字";
  const md = str(d.verdict_md);
  const parts: string[] = [];
  const ai = isObj(d.ai_source) ? [str(d.ai_source.provider), str(d.ai_source.model)].filter(Boolean).join(" · ") : "";
  parts.push(`> 从旧版导入${ai ? `(${ai})` : ""}${str(d.generated_at) ? `,${str(d.generated_at)} 写` : ""}。原文照搬,没有按新版规则重新核对。`);
  if (md) parts.push(md);
  const reports = isObj(d.reports) ? d.reports : {};
  const rep = Object.entries(reports).map(([k, v]) => [k, isObj(v) ? htmlText(v.html ?? v.text ?? v.md) : htmlText(v)] as const).filter(([, t]) => t);
  if (rep.length) parts.push("## 分项报告", ...rep.map(([k, t]) => `### ${REPORT_LABELS[k] ?? k}\n\n${t}`));
  const sides = debateSides(d.debate);
  if (sides.length) parts.push("## 多空辩论", ...sides.map(([l, t]) => `### ${l}\n\n${t}`));
  if (parts.length < 2) return "旧版这份深挖没有正文";
  const day = str(d.trade_date);
  return {
    symbol: code, category: "debate",
    title: `${str(d.name, 20) || code}(${code})个股深挖${realDay(day) ? ` · ${day}` : ""}(旧版导入)`.slice(0, 160),
    body: parts.join("\n\n").slice(0, 100000), migrated_from: key,
  };
}

function planDeepdive(ctx: ServiceContext, dir: string, snap: ReturnType<typeof ledgerSnapshot>, g: Group): Record<string, unknown>[] {
  const base = path.join(dir, "deepdive");
  const files = [
    ...entries(base, "file", skipDir(g, "deepdive/")).filter((f) => /^\d{6}\.json$/.test(f)).map((f) => ({ file: path.join(base, f), rel: f })),
    ...entries(path.join(base, "versions"), "file", skipDir(g, "deepdive/versions/")).filter((f) => /^[0-9a-f]{6,64}\.json$/.test(f)).map((f) => ({ file: path.join(base, "versions", f), rel: `versions/${f}` })),
  ];
  const done = migratedSet(snap.records.note);
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const { file, rel } of files) {
    const r = readJson(file);
    if (!r) continue;
    g.found++;
    if ("why" in r) { g.skipped.push({ what: `deepdive/${rel}`, why: r.why }); continue; }
    if (!isObj(r.value)) { g.skipped.push({ what: `deepdive/${rel}`, why: "格式不对" }); continue; }
    // 🔴 版本身份 = 代码 + 生成时间 + 正文摘要:当前那份和 versions/ 里同一版内容相同,算一份;
    //    原来只按「代码 + 生成时间(到分钟)」,同一分钟的两个不同版本会被当成一份,另一份永远导不进来
    const at = vaTime(r.value.generated_at);
    const digest = crypto.createHash("sha256").update(JSON.stringify([r.value.verdict_md ?? null, r.value.reports ?? null, r.value.debate ?? null])).digest("hex").slice(0, 12);
    const key = `va:deepdive:${str(r.value.code)}@${at ? at.slice(0, 16) : rel.replace(/\.json$/, "")}#${digest}`.slice(0, 80);
    if (seen.has(key)) { g.already++; continue; }
    seen.add(key);
    if (done.has(key)) { g.already++; continue; }
    const rec = deepdiveNote(r.value, key);
    if (typeof rec === "string") { g.skipped.push({ what: `deepdive/${rel}`, why: rec }); continue; }
    if (!checked(ctx, "note", rec, `deepdive/${rel}`, g)) continue;
    out.push(rec);
    g.add++;
  }
  return out;
}

/* ---- 不导的 ---- */

function notImported(dir: string): ImportPlan["not_imported"] {
  const rows: [string, string, string][] = [
    ["reflections", "方向命中评估", "新版「明日验证」按导入的条件和行情重新对账(很早的日期数据源可能已经取不到)"],
    ["archive", "每天的涨停池存档", "市场数据,新版直接从数据源取"],
    ["cache", "取数缓存", "缓存,新版会自己重新取"],
    ["leaders", "龙头缓存", "缓存,新版会自己重新取"],
    ["backtest", "回测结果", "新版的回测另算,口径不同"],
    ["weekly", "周报缓存", "新版的周报按数据重新整理,AI 周报另写"],
    ["drift", "开盘漂移缓存", "缓存"],
    [path.join("reviews", "_rejected"), "被拒的复盘", "旧版没通过检查的复盘,不当成复盘导入"],
  ];
  const out = rows.map(([rel, label, why]) => ({ label, count: countFiles(path.join(dir, rel)), why })).filter((r) => r.count > 0);
  const extra = entries(path.join(dir, "reviews"), "dir").filter((d) => d.startsWith("_备份") || d.startsWith("_废弃"));
  for (const d of extra) out.push({ label: `复盘文件夹 ${d}`, count: countFiles(path.join(dir, "reviews", d)), why: "旧版自己挪开的备份 / 废弃件,不导" });
  return out;
}

/* ---------------- 预览 / 导入 ---------------- */

export function planImport(ctx: ServiceContext, dir: string, now = new Date()): ImportPlan {
  scanRoot = path.resolve(dir);
  try { return planImportIn(ctx, dir, now); } finally { scanRoot = ""; }
}

function planImportIn(ctx: ServiceContext, dir: string, now: Date): ImportPlan {
  const snap = ledgerSnapshot(ctx);
  const gj = group("journal", "交易记录"), gs = group("settings", "交易日志设置"), gm = group("modes", "模式卡");
  const gr = group("reviews", "AI 复盘"), gv = group("verification", "明日验证条件"), gi = group("intraday", "盘中快照"), gd = group("deepdive", "个股深挖");
  const journal = planJournal(ctx, dir, snap, gj);
  const settings = planSettings(ctx, dir, snap, gs);
  const modes = planModes(ctx, dir, snap, gm);
  const { reviews, verification } = planReviews(ctx, dir, snap, gr, gv);
  const snapshots = planSnapshots(ctx, dir, gi);
  const notes = planDeepdive(ctx, dir, snap, gd);
  if (journal.some((j) => j.trades.length)) gj.notes.push("成交会写进「我的股票」的交易流水(和交易日志同一份账);还没卖光的会显示成持仓");
  return {
    dir,
    groups: [gj, gs, gm, gr, gv, gi, gd],
    journal,
    records: { journal_settings: settings, [MODE_KIND]: modes, shortline_review: reviews, verification, note: notes },
    snapshots,
    warnings: journalWarnings(snap, journal, now),
    not_imported: notImported(dir),
  };
}

export interface ImportPreview {
  dir: string;
  groups: Group[];
  warnings: string[];
  not_imported: ImportPlan["not_imported"];
  /** 一共要新写几项(0 = 没有要导的) */
  total: number;
}

export const previewOf = (p: ImportPlan): ImportPreview => ({
  dir: p.dir, groups: p.groups, warnings: p.warnings, not_imported: p.not_imported,
  total: p.groups.reduce((s, g) => s + g.add, 0),
});

export interface ImportResult extends ImportPreview {
  backup: string | null;
  written: Record<string, number>;
  failed: Skip[];
}

const KIND_LABELS: Record<string, string> = {
  trade: "交易流水", journal_tag: "交易标注", journal_settings: "交易日志设置", [MODE_KIND]: "模式卡",
  shortline_review: "AI 复盘", verification: "明日验证条件", note: "研究记录",
};

function backup(ctx: ServiceContext, now: Date, kinds: readonly string[], snapshots: number): string {
  const dir = backupDir(ctx, now, VA_IMPORT_BACKUP_PREFIX);
  fs.mkdirSync(dir, { recursive: true });
  const copied: string[] = [], absent: string[] = [];
  for (const k of kinds) {
    const src = safePath(ctx, "ledger", `${k}.json`);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dir, `${k}.json`), fs.constants.COPYFILE_EXCL); copied.push(k); } else absent.push(k);
  }
  const at = localClock(now, SCHEDULE_TZ);
  const lines = [
    `# ${VA_IMPORT_BACKUP_PREFIX}`, "",
    `时间:${at.day} ${at.hm}(${SCHEDULE_TZ})`,
    "原因:从旧版导入数据(交易日志、模式卡、AI 复盘、明日验证、个股深挖等)", "",
    "这个文件夹里是导入前的原样文件:",
    ...copied.map((k) => `- ${k}.json:${KIND_LABELS[k] ?? k}`),
    ...(absent.length ? [`- 导入前还没有:${absent.map((k) => `${k}.json(${KIND_LABELS[k] ?? k})`).join("、")}`] : []),
    "",
    `恢复:先退出 ${PRODUCT_NAME},把这里的文件复制回上一级 ledger 文件夹、覆盖同名文件;`
      + (absent.length ? `导入前没有的(${absent.map((k) => `${k}.json`).join("、")})从 ledger 里删掉;` : "") + "再打开就回到导入前。",
    ...(snapshots ? ["", `盘中快照:这次新建了 ${snapshots} 个快照文件(在 shortline/intraday 下按日期分的文件夹里,带「从旧版导入」字样),只新建、没覆盖任何已有文件;不要的话直接删掉那几个文件。`] : []),
    "",
    "旧版的数据目录没有动过。",
    "",
  ];
  fs.writeFileSync(path.join(dir, "README.md"), lines.join("\n"), { flag: "wx" });
  return path.relative(path.resolve(ctx.dataRoot), dir).split(path.sep).join("/");
}

/**
 * 真导入。先备份涉及的台账文件,再按种类整批写:流水 → 标注(要流水的新 id)→ 其余;最后新建快照文件。
 * 某一种写失败(磁盘、并发改动)记进 failed、其余照写;再导一次会把没写进去的补上(已写的按来源跳过)。
 */
export function runImport(ctx: ServiceContext, dir: string, now = new Date()): ImportResult {
  const plan = planImport(ctx, dir, now);
  const preview = previewOf(plan);
  const result: ImportResult = { ...preview, backup: null, written: {}, failed: [] };
  if (!preview.total) return result;
  const trades = plan.journal.flatMap((j) => j.trades);
  const kinds = [
    ...(trades.length ? ["trade"] : []),
    ...(plan.journal.some((j) => j.tags.length) ? ["journal_tag"] : []),
    ...Object.entries(plan.records).filter(([, rs]) => rs.length).map(([k]) => k),
  ];
  result.backup = backup(ctx, now, kinds, plan.snapshots.length);
  const write = (kind: string, records: Record<string, unknown>[]): LedgerRecord[] | null => {
    if (!records.length) return [];
    try {
      const added = ledgerInsertMany(ctx, { kind, records });
      result.written[kind] = added.length;
      return added;
    } catch (e) {
      result.failed.push({ what: KIND_LABELS[kind] ?? kind, why: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };
  const added = write("trade", trades);
  if (added) {
    const ids = new Map(added.map((r) => [str(r.migrated_from), r.id]));
    for (const j of plan.journal) for (const [k, id] of j.existing) ids.set(k, id);
    const tags = plan.journal.flatMap((j) => j.tags.map((t) => ({ ...t.record, ...(t.trade_key ? { trade_id: ids.get(t.trade_key) ?? "" } : {}) })))
      .filter((t) => !("trade_id" in t) || t.trade_id);
    write("journal_tag", tags.map((t) => (t.trade_id === "" ? (({ trade_id: _drop, ...rest }) => rest)(t) : t)));
  } else if (plan.journal.some((j) => j.tags.length)) {
    result.failed.push({ what: KIND_LABELS.journal_tag!, why: "交易流水没写进去,标注也没写(再导一次会一起补上)" });
  }
  for (const [kind, rs] of Object.entries(plan.records)) write(kind, rs);
  let made = 0;
  for (const s of plan.snapshots) {
    // 只新建、绝不覆盖(和定时存档同一个写法)
    try {
      if (writeNewJson(s.file, s.snapshot)) made++;
      else result.failed.push({ what: `${s.date} ${s.slot} 的盘中快照`, why: "新版这个时点刚好已经有快照了,没覆盖" });
    } catch (e) {
      result.failed.push({ what: `${s.date} ${s.slot} 的盘中快照`, why: e instanceof Error ? e.message : String(e) });
    }
  }
  if (made) result.written.intraday = made;
  return result;
}

/* ---------------- 视图 ---------------- */

export interface VaImportInfo { default_dir: string; exists: boolean }

export async function vaImportView(_ctx: ServiceContext, _query: Record<string, string>, _signal?: AbortSignal): Promise<VaImportInfo> {
  const d = defaultVaDir();
  return { default_dir: d, exists: isDir(d) };
}

export async function vaImportAct(ctx: ServiceContext, body: Record<string, unknown>, _signal?: AbortSignal, now = new Date()): Promise<ImportPreview | ImportResult> {
  if (body.action !== "preview" && body.action !== "import") throw new ServiceError("bad_request", "只支持 action=preview / import");
  const dir = resolveVaDir(ctx, body.dir);
  return body.action === "preview" ? previewOf(planImport(ctx, dir, now)) : runImport(ctx, dir, now);
}
