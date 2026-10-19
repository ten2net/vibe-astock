/**
 * 把交易标注(`journal_tag`)挂到「一笔交易」上,得到交易日志的一行;没有成交明细的补记单独成行。
 *
 * - 标注填的是这一轮里任意一笔流水的 id,挂到包含它的那一轮。
 * - 一轮有多条标注:取最后修改的那条,其余列成「重复标注」让用户删。
 * - 挂不上的(流水删了、那笔不参与计算、代码对不上、不是 A 股)列成「挂不上的标注」,不丢。
 * - 补记(没填 trade_id):只有日期和盈亏 %,金额类统计不算它(VA 同口径:只填 % 的不进金额)。
 *
 * 纯函数。
 */
import type { LedgerRecord } from "../../ledger.ts";
import { PLAYBOOKS } from "./defs.ts";
import { isJournalSymbol, type Episode } from "./episodes.ts";
import { realDay } from "./num.ts";

export interface Tag {
  id: string; symbol: string; name: string; trade_id: string; date: string;
  playbook: string | null; as_planned: boolean | null;
  planned_stop: number | null; planned_target: number | null; pnl_pct: number | null;
  note: string; planned_at: string; migrated_from: string;
  created_at: string; updated_at: string;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function tagOf(r: LedgerRecord): Tag {
  const pb = str(r.playbook);
  return {
    id: r.id, symbol: str(r.symbol), name: str(r.name), trade_id: str(r.trade_id), date: str(r.date),
    playbook: (PLAYBOOKS as readonly string[]).includes(pb) ? pb : null,
    as_planned: typeof r.as_planned === "boolean" ? r.as_planned : null,
    planned_stop: num(r.planned_stop), planned_target: num(r.planned_target), pnl_pct: num(r.pnl_pct),
    note: str(r.note), planned_at: str(r.planned_at), migrated_from: str(r.migrated_from),
    created_at: str(r.created_at), updated_at: str(r.updated_at),
  };
}

/** 台账时间戳(ISO)对应的北京时间日期;读不出返回 null */
export function cnDay(iso: string): string | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + 8 * 3600_000).toISOString().slice(0, 10) : null;
}

export interface JournalRow {
  /** 一轮 = 开这一轮的流水 id;补记 = 标注 id */
  key: string;
  kind: "episode" | "manual";
  symbol: string;
  name: string;
  /** 入场日:一轮 = 第一笔买入(或期初持仓)那天;补记 = 用户填的日期 */
  date: string;
  /** 录入时间:一轮 = 开这一轮那笔流水的;补记 = 标注的。同日入场按它排先后(VA 同) */
  created_at: string;
  episode: Episode | null;
  tag_id: string | null;
  playbook: string | null;
  as_planned: boolean | null;
  planned_stop: number | null;
  planned_target: number | null;
  /** 止损 / 目标是在买入日之后才写下的(在险资金口径会失真,页面标出来) */
  plan_late: boolean;
  note: string;
  /** 一轮 = 按流水算的已实现 %(还没卖过是 null);补记 = 用户填的 */
  pnl_pct: number | null;
  realized_pnl: number | null;
  hold_days: number | null;
}

export interface TagProblem { id: string; symbol: string; why: string }

export interface RowsResult {
  rows: JournalRow[];
  /** 挂不上的标注 */
  orphans: TagProblem[];
  /** 同一轮的多余标注(只认最后修改的那条) */
  conflicts: TagProblem[];
}

const newer = (a: Tag, b: Tag) => (a.updated_at !== b.updated_at ? a.updated_at > b.updated_at : a.id > b.id);

/**
 * @param skippedTradeIds 不参与计算的流水 id → 原因(交易日志里列出的那些)
 * @param knownTradeIds 台账里现有的全部流水 id(区分「流水删了」和「那笔不参与计算」)
 */
export function buildRows(
  episodes: readonly Episode[], tags: readonly Tag[],
  skippedTradeIds: ReadonlyMap<string, string>, knownTradeIds: ReadonlySet<string>,
): RowsResult {
  const byTrade = new Map<string, Episode>();
  for (const ep of episodes) for (const id of ep.trade_ids) byTrade.set(id, ep);
  const orphans: TagProblem[] = [];
  const conflicts: TagProblem[] = [];
  const winner = new Map<string, Tag>();
  const manual: JournalRow[] = [];

  for (const t of tags) {
    if (!isJournalSymbol(t.symbol)) { orphans.push({ id: t.id, symbol: t.symbol, why: "交易日志只管 A 股股票(ETF、基金、债券不记)" }); continue; }
    if (!t.trade_id) {
      if (!realDay(t.date)) { orphans.push({ id: t.id, symbol: t.symbol, why: "没有成交明细的补记要写日期" }); continue; }
      manual.push({
        key: t.id, kind: "manual", symbol: t.symbol, name: t.name, date: t.date, created_at: t.created_at, episode: null, tag_id: t.id,
        playbook: t.playbook, as_planned: t.as_planned, planned_stop: t.planned_stop, planned_target: t.planned_target,
        plan_late: false, note: t.note, pnl_pct: t.pnl_pct, realized_pnl: null, hold_days: null,
      });
      continue;
    }
    const ep = byTrade.get(t.trade_id);
    if (!ep) {
      const why = skippedTradeIds.get(t.trade_id);
      orphans.push({
        id: t.id, symbol: t.symbol,
        why: why !== undefined ? `对应的那笔流水不参与计算(${why})` : knownTradeIds.has(t.trade_id) ? "对应的流水不是 A 股买卖" : "对应的流水已经删了",
      });
      continue;
    }
    if (ep.symbol !== t.symbol) { orphans.push({ id: t.id, symbol: t.symbol, why: `代码和对应流水(${ep.symbol})对不上` }); continue; }
    const cur = winner.get(ep.id);
    if (!cur) { winner.set(ep.id, t); continue; }
    const [keep, drop] = newer(t, cur) ? [t, cur] : [cur, t];
    winner.set(ep.id, keep);
    conflicts.push({ id: drop.id, symbol: drop.symbol, why: "同一笔交易有多条标注,只认最后修改的那条" });
  }

  const rows: JournalRow[] = episodes.map((ep) => {
    const t = winner.get(ep.id) ?? null;
    const planDay = t && (t.planned_stop !== null || t.planned_target !== null) ? cnDay(t.planned_at) : null;
    return {
      key: ep.id, kind: "episode", symbol: ep.symbol, name: ep.name || t?.name || "", date: ep.first_buy, created_at: ep.created_at, episode: ep,
      tag_id: t?.id ?? null, playbook: t?.playbook ?? null, as_planned: t?.as_planned ?? null,
      planned_stop: t?.planned_stop ?? null, planned_target: t?.planned_target ?? null,
      // 没记标注时间(旧数据)不算事后:不知道就不指控
      plan_late: planDay !== null && planDay > ep.first_buy,
      note: t?.note ?? "",
      // 有明细的只按流水算:标注里的 pnl_pct 只给补记用(标注接口对有明细的拒收)
      pnl_pct: ep.realized_pct,
      realized_pnl: ep.realized_pnl, hold_days: ep.hold_days,
    };
  });
  rows.push(...manual);
  // VA 的列表顺序:入场日新的在前,同一天后录的在前(风险计算按这个顺序累加,见 risk.ts vaOrder)
  rows.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1)
    : a.created_at !== b.created_at ? (a.created_at < b.created_at ? 1 : -1)
      : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { rows, orphans, conflicts };
}
