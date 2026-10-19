/**
 * 情绪复盘 · 近 5 天:5 个交易日的热度、题材轮动,和前几天的龙头现在怎么样了。
 * 热度和龙头谱系移植自 Vibe AStock v2.0.0 的「近5天热度」,口径说明原样保留;颜色改成强 = 红、弱 = 绿。
 * 题材轮动是另一个查询(`shortline_rotation`),各自回来各自显示,一边没取到不影响另一边。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarRange, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAiPage } from "../../../core/ai/pageContext";
import { LOADING, loadBlocks, type Panel } from "./api";
import { Section } from "./FactsPanels";
import { finite, pctColor, rate, safeArray, signed } from "./format";
import { ThemeRotationSection, rotationSummary } from "./ThemeRotationPanel";
import type { ThemeRotationResult } from "./types";
import { useShortlineView } from "./useView";
import type { LineageItem, WeeklyDay, WeeklyResult } from "./viewTypes";
import { GapsAndSource, ViewSlot } from "./ViewBits";

export interface ViewTabProps { day: string; refreshNonce: number; onBusy: (busy: boolean) => void }

const HEAT_CALIBER =
  "「近5天」= 最近 5 个**交易日**,周末与休市不算。\n" +
  "涨停家数 = 当日最终封住涨停的家数;最高板 = 当日连板数最高那只的连板数。\n" +
  "炸板率 = 炸板家数 ÷(炸板 + 涨停),与其它几处同一个算法;\n" +
  "某天炸板池取数失败时那天留空,**不会当成 0**。\n" +
  "当日并列最高标 = 当日涨停池里连板数最高的那只;并列最高全部列出,\n" +
  "不看成交额也不看封单 —— 所以它不等于市场公认的那只龙头。";

const LINEAGE_CALIBER =
  "这里的大号百分比**不是当日跌幅**,是「距登顶后最高点的回撤」:\n" +
  "以登顶那天的收盘价为基准算每天累计涨跌,取这段里最高的那个当高点,再看现在距它跌了多少。\n" +
  "全部用收盘价,不看盘中最高最低;就在收盘价区间高点时显示「在收盘价区间高点」。\n" +
  "「登顶」= 那天它是全市场连板数最高的那只(同上,并列全部纳入);\n" +
  "一只票多次当过龙头只算**最早**那一天。「区间」= 登顶日到复盘日。\n" +
  "「自登顶累计」= 登顶日收盘 → 复盘日收盘;「最高到过」= 这段里累计涨跌的最高值。";

function leadersText(d: WeeklyDay): string {
  const ls = safeArray<WeeklyDay["leaders"][number]>(d.leaders);
  if (!ls.length) return "—";
  const more = (finite(d.leader_total) ?? ls.length) > ls.length ? ` 等 ${d.leader_total} 只` : "";
  return ls.map((l) => `${l.name} ${l.boards ?? "—"}板${l.sector ? ` · ${l.sector}` : ""}`).join(";") + more;
}

function Sparkline({ l }: { l: LineageItem }) {
  const s = safeArray<{ date: string; cum_ret: number }>(l.series);
  if (s.length < 2) {
    return <p className="mt-1 text-[12px] text-muted-foreground">{s.length === 1 ? "(当日登顶,暂无后续交易日)" : "(没有后续行情)"}</p>;
  }
  const vals = s.map((x) => finite(x.cum_ret)).filter((v): v is number => v !== null);
  if (vals.length < 2) return <p className="mt-1 text-[11px] text-muted-foreground/70">(有效点不足,画不出来)</p>;
  const min = Math.min(0, ...vals), max = Math.max(0, ...vals), rng = (max - min) || 1;
  const W = 200, H = 34, n = vals.length;
  const pts = vals.map((v, i) => `${(i / (n - 1) * W).toFixed(1)},${(H - (v - min) / rng * H).toFixed(1)}`).join(" ");
  const zeroY = (H - (0 - min) / rng * H).toFixed(1);
  const up = vals[vals.length - 1]! >= 0;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="200" height="34" className="mt-1.5" role="img" aria-label={`登顶以来累计涨跌走势,最新 ${signed(vals[vals.length - 1])}`}>
      <line x1="0" x2={W} y1={zeroY} y2={zeroY} stroke="hsl(var(--border))" strokeDasharray="2,2" />
      <polyline points={pts} fill="none" stroke={up ? "hsl(var(--danger))" : "hsl(var(--success))"} strokeWidth="2" />
    </svg>
  );
}

export function weeklySummary(r: WeeklyResult): string {
  const out = [`近 5 个交易日(截至 ${r.date})的短线热度。炸板率取不到的日子留空,不是 0。`];
  for (const d of safeArray<WeeklyDay>(r.days)) {
    out.push(`${d.date}:涨停 ${d.limit_up != null ? `${d.limit_up} 家` : "没取到"},最高 ${d.highest_board != null ? `${d.highest_board} 板` : "没取到"},炸板率 ${d.broken_rate != null ? rate(d.broken_rate) : "没取到"},当日并列最高标 ${leadersText(d)}${d.settled === false ? "(还没收盘)" : ""}${d.note ? `(${d.note})` : ""}`);
  }
  const ls = safeArray<LineageItem>(r.lineage);
  out.push(ls.length ? "龙头谱系(登顶日收盘起算,收盘价口径):" : "龙头谱系:这几天没有可跟踪的最高标");
  for (const l of ls) {
    out.push(`${l.name}(${l.code},${l.sector || "行业未知"})${l.appear_date} 登顶时 ${l.boards_then ?? "—"} 板,自登顶累计 ${signed(l.cum_return_since)},最高到过 ${signed(l.peak_cum_ret)},距区间高点 ${l.drawdown_from_peak == null ? "算不出" : l.drawdown_from_peak === 0 ? "就在高点" : signed(l.drawdown_from_peak)}${l.is_current_top ? ",是复盘日的最高标" : ""}${l.series_warning ? `(${l.series_warning})` : ""}`);
  }
  if (r.gaps.length) out.push(`缺口:${r.gaps.join(";")}`);
  return out.join("\n");
}

/** 题材轮动在热度表下面;近 5 天的视图没取到时,页面把它单独摆在下面 */
export function WeeklyView({ r, rotation }: { r: WeeklyResult; rotation?: ReactNode }) {
  const days = safeArray<WeeklyDay>(r.days);
  const maxLu = Math.max(1, ...days.map((d) => finite(d.limit_up) ?? 0));
  const lineage = safeArray<LineageItem>(r.lineage);
  return (
    <div className="space-y-4">
      <Section icon={CalendarRange} title="近 5 天情绪热度" caliber={HEAT_CALIBER}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-[13px] tabular-nums">
            <thead>
              <tr className="border-b border-border/60 text-left text-[11px] text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">日期</th>
                <th className="py-1.5 pr-3 font-medium">涨停家数</th>
                <th className="py-1.5 pr-3 text-center font-medium">最高板</th>
                <th className="py-1.5 pr-3 text-right font-medium">炸板率</th>
                <th className="py-1.5 font-medium">当日并列最高标</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => {
                const lu = finite(d.limit_up);
                return (
                  <tr key={d.date} className="border-b border-border/40 last:border-0">
                    <td className="py-2 pr-3 text-muted-foreground">
                      {d.date}
                      {d.settled === false && <span className="ml-1 text-[10px] text-warning">未收盘</span>}
                    </td>
                    <td className="w-[38%] py-2 pr-3">
                      {lu == null ? <span className="text-muted-foreground">没取到</span> : (
                        <span className="flex h-5 items-center rounded bg-danger/60 px-2 text-xs font-semibold text-white"
                          style={{ width: `${Math.max(8, (lu / maxLu) * 100)}%` }}>{lu}</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-center font-bold text-danger">{d.highest_board != null ? `${d.highest_board}板` : "—"}</td>
                    <td className="py-2 pr-3 text-right">{rate(d.broken_rate)}</td>
                    <td className="py-2 text-[12px]">
                      {leadersText(d)}
                      {d.note && <p className="text-[11px] text-warning">{d.note}</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {rotation}

      <Section icon={GitBranch} title="龙头谱系 · 前几天的龙头现在怎么样了" caliber={LINEAGE_CALIBER}>
        {lineage.length === 0 ? <p className="text-[13px] text-muted-foreground">这几天没有可跟踪的最高标。</p> : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {lineage.map((l) => {
              const dd = finite(l.drawdown_from_peak);
              const atPeak = dd === 0;
              return (
                <div key={l.code} className={cn("rounded-xl border border-border/60 border-l-4 bg-muted/10 p-3",
                  dd == null ? "border-l-border" : atPeak ? "border-l-danger" : "border-l-success")}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="flex flex-wrap items-baseline gap-1.5 text-[15px] font-bold">
                      {l.name}
                      <span className="text-xs font-normal text-muted-foreground">{l.code}</span>
                      {/* 只标「当前最高标」不写板数:后端按复盘日的最高标判,前几天的高标断板了板数也照样最大 */}
                      {l.is_current_top && <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-bold text-primary">当前最高标</span>}
                    </span>
                    <span className={cn("shrink-0 text-lg font-extrabold tabular-nums", dd == null ? "text-muted-foreground" : atPeak ? "text-danger" : "text-success")}>
                      {dd == null ? "—" : atPeak ? "在收盘价区间高点" : signed(dd)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {l.appear_date} 登顶{l.boards_then != null && `(${l.boards_then}板)`} · {l.sector || "行业未知"} · 距区间最高点(收盘价口径)
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground/80">
                    自登顶累计 <b className={pctColor(l.cum_return_since)}>{signed(l.cum_return_since)}</b>
                    {finite(l.peak_cum_ret) != null && <> · 最高到过 {signed(l.peak_cum_ret)}</>}
                  </p>
                  {l.series_warning && <p role="status" className="text-xs text-warning">{l.series_warning}</p>}
                  <Sparkline l={l} />
                </div>
              );
            })}
          </div>
        )}
      </Section>
      <GapsAndSource gaps={safeArray<string>(r.gaps)} source={r.source} />
    </div>
  );
}

/** 题材轮动:同一天、同一个「刷新」;换天作废旧请求 */
function useRotation(day: string, refreshNonce: number): Panel<ThemeRotationResult> {
  const [p, setP] = useState<Panel<ThemeRotationResult>>(LOADING);
  const seenNonce = useRef(refreshNonce);
  useEffect(() => {
    const refresh = seenNonce.current !== refreshNonce;
    seenNonce.current = refreshNonce;
    let live = true;
    setP(LOADING);
    void loadBlocks("shortline_rotation", ["rotation"], day, refresh).then((got) => {
      if (live) setP(got.rotation as Panel<ThemeRotationResult>);
    });
    return () => { live = false; };
  }, [day, refreshNonce]);
  return p;
}

export function WeeklyTab({ day, refreshNonce, onBusy }: ViewTabProps) {
  const [st] = useShortlineView<WeeklyResult>("shortline_weekly", day, undefined, refreshNonce, onBusy);
  const rot = useRotation(day, refreshNonce);
  const r = st.state === "done" ? st.data : null;
  useAiPage(r ? {
    key: `shortline:weekly:${day}`,
    title: `近 5 天情绪 ${day}`,
    context: `${weeklySummary(r)}\n${rotationSummary(rot)}`,
    suggestions: ["这 5 天情绪是在升温还是退潮?依据是哪几项", "哪些题材连续在前排、哪些是回流或新出现的", "前几天的龙头现在离高点多远,对接力意味着什么"],
  } : null);
  const rotation = <ThemeRotationSection p={rot} />;
  const body = <ViewSlot st={st} label="近 5 天热度">{(d) => <WeeklyView r={d} rotation={rotation} />}</ViewSlot>;
  return st.state === "done" ? body : <div className="space-y-4">{body}{rotation}</div>;
}
