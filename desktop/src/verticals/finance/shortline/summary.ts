/**
 * 「今日情绪」这一屏写给 AI 的文字:只摆读数和口径,不下结论。
 * 🔴 没取到 / 还在取的块要明说 —— 漏写一块,模型会把「没有这项数据」读成「这项是零」。
 */
import type { Panel } from "./api";
import { ladderSummary } from "./BoardLadderPanel";
import { finite, hhmm, ladderRows, rate, safeArray, safeRecord, signed, tierOrder } from "./format";
import type { BoardLadderResult, CycleResult, EmotionResult, FactsResult, FeedbackCell, FirstBoardResult, FirstBoardStock, LedgerEvent, PromotionTier, ThemeNode, ThemesResult } from "./types";

function missing<T>(label: string, p: Panel<T>): string | null {
  if (p.state === "loading") return `${label}:还在取,先别据此下结论`;
  if (!p.result) return `${label}:这次没取到(${p.why || "原因不明"}),不代表是零`;
  return null;
}

const off = (label: string, x?: { available?: boolean; reason?: string }) =>
  x && x.available === false ? `${label}:没算出来(${x.reason ?? "原因不明"})` : null;

export function todaySummary(day: string | null, p: {
  emotion: Panel<EmotionResult>; facts: Panel<FactsResult>; themes: Panel<ThemesResult>;
  firstboard: Panel<FirstBoardResult>; cycle: Panel<CycleResult>; ladder: Panel<BoardLadderResult>;
}): string {
  const out: string[] = [];
  const e = p.emotion.state === "done" ? p.emotion.result : null;
  const settled = e?.settled;
  out.push(`复盘日 ${day ?? "未知"}${e?.prev_date ? `(对比前一交易日 ${e.prev_date})` : ""};${settled === false ? "这一天还没收盘,数字还会变" : settled ? "已收盘定稿" : "是否收盘未知"}。`);

  const m1 = missing("情绪四项", p.emotion);
  if (m1) out.push(m1);
  else if (e) {
    const me = e.money_effect;
    out.push(off("赚钱效应", me) ?? `赚钱效应(昨日涨停股当天收盘对收盘):中位 ${signed(me?.median)},均值 ${signed(me?.avg)},翻红率 ${rate(me?.positive_rate)},再度涨停 ${rate(me?.limit_up_again_rate)},样本 ${me?.sample ?? "—"} 只${me?.partial ? "(行情没取全)" : ""}`);
    const pr = e.promotion;
    const tiers = Object.entries(safeRecord<PromotionTier>(pr?.tiers)).filter(([, t]) => (finite(t?.base) ?? 0) > 0).map(([k, t]) => `${k} ${t.promoted}/${t.base}(${rate(t.rate)})`);
    out.push(off("晋级率", pr) ?? `晋级率:整体 ${pr?.overall ? `${pr.overall.promoted}/${pr.overall.base}(${rate(pr.overall.rate)})` : "—"};${tiers.join(",") || "没有可算的连板档"};涨停 ${pr?.limit_up_count ?? "—"} 家(前一交易日 ${pr?.prev_limit_up_count ?? "—"} 家)`);
    const cp = e.consec_premium;
    out.push(off("连板溢价", cp) ?? `连板溢价(昨日 2 板以上):中位 ${signed(cp?.median)},均值 ${signed(cp?.avg)},翻红率 ${rate(cp?.positive_rate)},样本 ${cp?.sample ?? "—"} 只`);
    const lg = e.ladder_gap;
    const rows = lg ? ladderRows(lg) : [];
    out.push(off("梯队", lg) ?? `梯队(当天收盘涨停,2 板以上,全市场不分题材):${rows.map((r) => (r.count == null ? `${r.board}板缺` : `${r.board}板×${r.count}`)).join(" ") || "没有 2 板以上"}`);
  }

  const ml = missing("连板天梯", p.ladder);
  if (ml) out.push(ml);
  else if (p.ladder.state === "done" && p.ladder.result) out.push(ladderSummary(p.ladder.result));

  const m2 = missing("盘面事实", p.facts);
  if (m2) out.push(m2);
  else if (p.facts.state === "done" && p.facts.result) {
    const f = p.facts.result;
    const sq = f.seal_quality;
    out.push(off("封板质量", sq) ?? `封板质量:涨停 ${sq?.total ?? "—"} 家,没炸过 ${sq?.never_broken ?? "—"}(${rate(sq?.never_broken_rate)}),炸后回封 ${sq?.reopened ?? "—"};炸板率 ${rate(sq?.broken_rate)}(炸板未回封 ${sq?.broken_pool ?? "—"} 家);开盘秒板 ${sq?.opening_seconds ?? "—"}、14:30 后才封 ${sq?.late_seal ?? "—"}`);
    const le = f.loss_effect;
    out.push(off("亏钱效应", le) ?? `亏钱效应(只算昨日涨停那批,不是全市场):样本 ${le?.sample ?? "—"} 只,跌超5% ${le?.deep_loss_5_count ?? "—"}、跌超7% ${le?.deep_loss_7_count ?? "—"}、跌停 ${le?.limit_down_count ?? "—"},最差 ${signed(le?.worst)};全市场跌停 ${le?.market_limit_down ?? "—"} 家`);
    const fm = f.feedback;
    const matrix = safeRecord<FeedbackCell>(fm?.matrix);
    const fl = Object.keys(matrix).sort((a, b) => tierOrder(a) - tierOrder(b)).map((t) => {
      const c = matrix[t]!;
      return `${t}(${c.合计}):晋级 ${c.晋级涨停} / 收红 ${c.收红} / 小跌 ${c.小跌} / 跌超5% ${c["跌超5%"]} / 跌停 ${c.跌停},晋级率 ${rate(c.晋级率)}`;
    });
    out.push(off("昨日强势股反馈", fm) ?? `昨日强势股反馈:${fl.join(";") || "没有可统计的板位"}${fm?.note ? `(${fm.note})` : ""}`);
    const el = f.events;
    const brief = (xs: LedgerEvent[] | undefined) => safeArray<LedgerEvent>(xs).slice(0, 4).map((x) => `${x.name}(${x.tag},${x.note})`).join(";");
    out.push(off("关键事件", el) ?? `关键事件:钱亏在 ${safeArray(el?.loss_events).length} 起:${brief(el?.loss_events) || "无"};钱赚在 ${safeArray(el?.gain_events).length} 起:${brief(el?.gain_events) || "无"}`);
    const bb = f.by_board;
    const boards = Object.entries(safeRecord<{ limit_up: number; highest: number; promotion_rate: number | null }>(bb?.boards)).map(([k, g]) => `${k} 涨停 ${g.limit_up}、最高 ${g.highest} 板、晋级率 ${rate(g.promotion_rate)}`);
    if (boards.length) out.push(`分涨跌幅制度:${boards.join(";")}`);
  }

  const m3 = missing("题材事件树", p.themes);
  if (m3) out.push(m3);
  else if (p.themes.state === "done" && p.themes.result) {
    const t = p.themes.result.tree;
    const list = safeArray<ThemeNode>(t?.themes).slice(0, 10).map((n) =>
      `${n.tag}[${n.state}] 涨停 ${n.limit_up}(首板${n.first_boards}/连板${n.consec_boards})最高 ${n.highest} 板${n.broken ? `,炸 ${n.broken}` : ""}${n.continuation_rate != null ? `,昨日该题材延续 ${rate(n.continuation_rate)}` : ""}${n.first_seal ? `,首封 ${hhmm(n.first_seal)}` : ""}`);
    out.push(off("题材事件树", t) ?? `题材事件树(按涨停原因归组,源站编辑归因非公司确认):${list.join(";") || "没有可聚合的题材"}`);
  }

  const m4 = missing("情绪周期", p.cycle);
  if (m4) out.push(m4);
  else if (p.cycle.state === "done" && p.cycle.result) {
    const cy = p.cycle.result.cycle;
    out.push(off("情绪周期", cy) ?? `情绪周期(启发式,不是精确划分):近 ${cy?.window ?? "—"} 日低点 ${cy?.trough_date ?? "—"},这一天是第 ${cy?.day_n ?? "—"} 天,情绪分 ${finite(cy?.current_score)?.toFixed(2) ?? "—"},走向 ${cy?.trend ?? "—"},区间分位 ${rate(cy?.pctile)}`);
  }

  const m5 = missing("首板名单", p.firstboard);
  if (m5) out.push(m5);
  else if (p.firstboard.state === "done" && p.firstboard.result) {
    const fb = p.firstboard.result;
    const first = safeArray<FirstBoardStock>(fb.stocks).slice(0, 12).map((s) => `${s.name}${s.rebound ? "(反包)" : ""} ${hhmm(s.first_seal)} ${s.reason || s.sector}`);
    out.push(fb.available ? `首板 ${fb.first_count ?? "—"} 家(反包 ${fb.rebound_count ?? 0}),按首封时间前 12 只:${first.join(";") || "无"}` : `首板名单:没取到(${fb.reason ?? "原因不明"})`);
  }
  return out.join("\n");
}
