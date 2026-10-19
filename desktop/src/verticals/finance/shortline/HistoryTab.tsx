/**
 * 情绪复盘 · 情绪历史:六项读数近 N 个交易日的走势,复盘日在历史里排第几,和前一天比哪几项真变了。
 * 「历史统计位置」「今日 vs 昨日」移植自 Vibe AStock v2.0.0 的 StatsView / DiffView,口径说明原样保留;
 * 转热 = 红、转冷 = 绿(和涨跌同一套)。
 */
import { useState } from "react";
import { ArrowLeftRight, Gauge, Table2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAiPage } from "../../../core/ai/pageContext";
import { Section } from "./FactsPanels";
import { finite, pctColor, reading, safeArray } from "./format";
import { useShortlineView } from "./useView";
import type { ContextItem, DayRow, DiffChange, HistoryContext, HistoryDiff, HistoryResult, Reading, ReadingKind } from "./viewTypes";
import { GapsAndSource, ViewSlot, WindowPicker } from "./ViewBits";
import type { ViewTabProps } from "./WeeklyTab";

export const HISTORY_WINDOWS = [10, 20, 30, 60];

/** 变化量:比率和涨跌幅都按「个百分点」说,家数 / 板数带单位 */
export function deltaText(delta: number, kind: ReadingKind, unit: string): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const a = Math.abs(delta);
  if (kind === "rate") return `${sign}${Math.round(a * 100)} 个百分点`;
  if (kind === "pct") return `${sign}${a.toFixed(2)} 个百分点`;
  return `${sign}${Number.isInteger(a) ? a : a.toFixed(1)}${unit}`;
}

const hot = (hotter: boolean) => (hotter ? "text-danger" : "text-success");
const hotBadge = (hotter: boolean) => (hotter ? "bg-danger/15 text-danger" : "bg-success/15 text-success");

function StatsView({ c }: { c: HistoryContext }) {
  const items = c.available ? safeArray<ContextItem>(c.items).filter((it) => finite(it.value) != null) : [];
  return (
    <Section
      icon={Gauge}
      title="历史统计位置"
      hint={"「涨停 40 家」是多还是少?光看绝对值判断不了 —— 要看它在历史上排第几。"
        + "每行第二个百分数是历史分位(77% = 比 77% 的日子高),不是胜率;两头(≥85% 或 ≤15%)才额外标偏热 / 偏冷。"
        + "炸板率、跌超5%家数是越高越冷,偏热 / 偏冷已经按这个方向判过。"}
      available={c.available}
      reason={c.available ? undefined : c.reason}
    >
      {c.available && (
        <>
          <div className="space-y-1.5">
            {items.map((it) => (
              <div key={it.key} className="flex flex-wrap items-center gap-2 text-[12px] tabular-nums">
                <span className="w-28 shrink-0 text-muted-foreground">{it.label}</span>
                <span className="w-16 font-bold">{reading(it.value, it.kind, it.unit)}</span>
                {it.percentile != null ? (
                  <>
                    <span className="relative h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                      <span className={cn("absolute inset-y-0 left-0 rounded-full",
                        it.extreme === "偏热" ? "bg-danger" : it.extreme === "偏冷" ? "bg-success" : "bg-primary/60")}
                        style={{ width: `${Math.max(2, Math.min(100, it.percentile * 100))}%` }} />
                    </span>
                    <span className="w-10 text-muted-foreground">{Math.round(it.percentile * 100)}%</span>
                    {it.extreme && <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", hotBadge(it.extreme === "偏热"))}>{it.extreme}</span>}
                    {it.hist_median != null && <span className="text-[10px] text-muted-foreground/70">历史中位 {reading(it.hist_median, it.kind, it.unit)}</span>}
                  </>
                ) : (
                  <span className="text-[11px] text-muted-foreground/70">样本不足 {c.min_samples} 天,暂不给分位</span>
                )}
              </div>
            ))}
          </div>
          <p className="mt-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
            对比复盘日之前的 <b className="text-foreground">{c.sample_days}</b> 个交易日
            {c.extreme_count > 0 ? ` · ${c.extreme_count} 项处在两头` : " · 各项都不极端(平淡的一天,这本身也是信息)"}
            {c.sample_days < 30 && " ⚠️ 样本还短,现在的分位仅供粗判"}
          </p>
        </>
      )}
    </Section>
  );
}

function DiffView({ d }: { d: HistoryDiff }) {
  const changes = d.available ? safeArray<DiffChange>(d.changes) : [];
  return (
    <Section
      icon={ArrowLeftRight}
      title={d.available ? `复盘日 vs ${d.prev_date}` : "复盘日 vs 前一交易日"}
      hint="复盘最该先回答的是「今天和昨天有什么不同」。只列超过噪声阈值的变化 —— 涨停 40→43 不算变化。"
      available={d.available}
      reason={d.available ? undefined : d.reason}
    >
      {d.available && (changes.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">关键读数全部在噪声阈值内 —— 这一天与前一天没有实质变化。</p>
      ) : (
        <div className="space-y-1.5">
          {changes.map((c) => (
            <div key={c.key} className="flex flex-wrap items-center gap-2 text-[12px] tabular-nums">
              <span className="w-28 shrink-0 text-muted-foreground">{c.label}</span>
              <span className="text-muted-foreground/80">{reading(c.prev, c.kind, c.unit)}</span>
              <span className={cn("font-bold", hot(c.hotter))}>{c.delta > 0 ? "↑" : "↓"}</span>
              <span className="font-bold">{reading(c.cur, c.kind, c.unit)}</span>
              <span className="text-[11px] text-muted-foreground">({deltaText(c.delta, c.kind, c.unit)})</span>
              <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", hotBadge(c.hotter))}>{c.hotter ? "转热" : "转冷"}</span>
            </div>
          ))}
          {d.unchanged_count > 0 && <p className="mt-2 text-[11px] text-muted-foreground/70">另有 {d.unchanged_count} 项变化在阈值内,未列出</p>}
        </div>
      ))}
    </Section>
  );
}

/** 逐日表从新到旧;连着取不到、原因相同的日子并成一行 */
type SeriesLine = { kind: "day"; row: DayRow } | { kind: "gap"; from: string; to: string; count: number; note: string };
export function seriesLines(series: DayRow[]): SeriesLine[] {
  const out: SeriesLine[] = [];
  for (const row of [...series].reverse()) {
    const last = out[out.length - 1];
    if (row.status === "missing") {
      if (last?.kind === "gap" && last.note === row.note) { last.from = row.date; last.count++; continue; }
      out.push({ kind: "gap", from: row.date, to: row.date, count: 1, note: row.note });
    } else out.push({ kind: "day", row });
  }
  return out;
}

function SeriesTable({ r }: { r: HistoryResult }) {
  const readings = safeArray<Reading>(r.readings);
  const lines = seriesLines(safeArray<DayRow>(r.series));
  return (
    <Section icon={Table2} title="逐日读数" hint="从新到旧。取不到的日子写原因、不填 0;没收盘的日子数字还会变。">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-[12px] tabular-nums">
          <thead>
            <tr className="border-b border-border/60 text-[11px] text-muted-foreground">
              <th className="py-1.5 pr-3 text-left font-medium">日期</th>
              {readings.map((x) => <th key={x.key} className="px-2 py-1.5 text-right font-medium">{x.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {lines.map((ln) => ln.kind === "gap" ? (
              <tr key={`gap-${ln.to}`} className="border-b border-border/40 text-muted-foreground/80">
                <td className="py-1.5 pr-3">{ln.count > 1 ? `${ln.from} ~ ${ln.to}` : ln.to}</td>
                <td colSpan={readings.length} className="px-2 py-1.5 text-[11px]">
                  {ln.count > 1 ? `${ln.count} 个交易日` : ""}没取到{ln.note ? `:${ln.note}` : ""}
                </td>
              </tr>
            ) : (
              <tr key={ln.row.date} className={cn("border-b border-border/40 last:border-0", ln.row.date === r.date && "bg-primary/5")}>
                <td className="py-1.5 pr-3 text-muted-foreground">
                  {ln.row.date}
                  {ln.row.settled === false && <span className="ml-1 text-[10px] text-warning">未收盘</span>}
                  {ln.row.status === "partial" && <span className="ml-1 text-[10px] text-warning" title={ln.row.note}>部分</span>}
                </td>
                {readings.map((x) => {
                  const v = finite(ln.row.values?.[x.key]);
                  return <td key={x.key} className={cn("px-2 py-1.5 text-right", x.kind === "pct" && pctColor(v))}>{reading(v, x.kind, x.unit)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

export function historySummary(r: HistoryResult): string {
  const out = [`情绪历史:复盘日 ${r.date},窗口近 ${r.days} 个交易日。`];
  const c = r.context;
  if (c.available) {
    out.push(`历史统计位置(对比之前 ${c.sample_days} 个交易日,分位 = 比多少比例的日子高,不是胜率):` + safeArray<ContextItem>(c.items).map((it) =>
      `${it.label} ${reading(it.value, it.kind, it.unit)}${it.percentile != null ? ` 分位 ${Math.round(it.percentile * 100)}%${it.extreme ? `(${it.extreme})` : ""},历史中位 ${reading(it.hist_median, it.kind, it.unit)}` : ",样本不足不给分位"}`).join(";"));
  } else out.push(`历史统计位置:没算出来(${c.reason})`);
  const d = r.diff;
  if (d.available) {
    const ch = safeArray<DiffChange>(d.changes);
    out.push(ch.length ? `对比 ${d.prev_date} 超过噪声阈值的变化:` + ch.map((x) => `${x.label} ${reading(x.prev, x.kind, x.unit)}→${reading(x.cur, x.kind, x.unit)}(${x.hotter ? "转热" : "转冷"})`).join(";") + (d.unchanged_count ? `;另 ${d.unchanged_count} 项在阈值内` : "") : `对比 ${d.prev_date}:关键读数都在噪声阈值内`);
  } else out.push(`和前一交易日比:没算出来(${d.reason})`);
  const readings = safeArray<Reading>(r.readings);
  const rows = safeArray<DayRow>(r.series);
  const got = rows.filter((x) => x.status !== "missing");
  out.push(`逐日读数(${readings.map((x) => x.label).join(" / ")}),取到 ${got.length}/${rows.length} 天,没取到的日子不是 0:`);
  for (const row of got) out.push(`${row.date}${row.settled === false ? "(未收盘)" : ""}:${readings.map((x) => reading(row.values?.[x.key], x.kind, x.unit)).join(" / ")}`);
  if (r.gaps.length) out.push(`缺口:${r.gaps.join(";")}`);
  return out.join("\n");
}

export function HistoryView({ r }: { r: HistoryResult }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <StatsView c={r.context} />
        <DiffView d={r.diff} />
      </div>
      <SeriesTable r={r} />
      <GapsAndSource gaps={safeArray<string>(r.gaps)} source={r.source} />
    </div>
  );
}

export function HistoryTab({ day, refreshNonce, onBusy }: ViewTabProps) {
  const [days, setDays] = useState(30);
  const [st] = useShortlineView<HistoryResult>("shortline_history", day, days, refreshNonce, onBusy);
  const r = st.state === "done" ? st.data : null;
  useAiPage(r ? {
    key: `shortline:history:${day}:${days}`,
    title: `情绪历史 ${day}`,
    context: historySummary(r),
    suggestions: ["复盘日的情绪在近一个月里算热还是冷?哪几项在两头", "和前一天比哪几项真的变了,方向一致吗", "这段时间情绪有没有明显的拐点"],
  } : null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-muted-foreground">六项读数在近 {days} 个交易日里的位置和走势</p>
        <WindowPicker value={days} options={HISTORY_WINDOWS} onChange={setDays} label="情绪历史看多少个交易日" />
      </div>
      <ViewSlot st={st} label="情绪历史" slow="第一次取要逐日拉东财数据,可能要几十秒">{(d) => <HistoryView r={d} />}</ViewSlot>
    </div>
  );
}
