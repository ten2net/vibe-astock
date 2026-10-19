/**
 * 情绪复盘 · 结构变化:所有历史统计都隐含「过去和现在是同一个游戏」,这个假设经常不成立。
 * 三类分开看:市场结构真的移位了 / 数据源改了字段 / 制度改了(人工登记)。把前两类读成第三类,就会基于一个假信号调整打法。
 * 移植自 Vibe AStock v2.0.0 的「结构漂移检测」和制度日历;登记 / 删除制度事件走台账。
 */
import { useState } from "react";
import { Database, Landmark, Shuffle, Trash2 } from "lucide-react";
import { backend } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { useAiPage } from "../../../core/ai/pageContext";
import { cleanReason } from "./api";
import { Section } from "./FactsPanels";
import { plain, rate, safeArray } from "./format";
import { useShortlineView } from "./useView";
import type { MetricShift, PoolDrift, RegimeEvent, StructureResult, WindowInfo } from "./viewTypes";
import { GapsAndSource, ViewSlot } from "./ViewBits";
import type { ViewTabProps } from "./WeeklyTab";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const shiftVal = (m: MetricShift, v: number) => (m.kind === "share" ? rate(v) : `${Number.isInteger(v) ? v : v.toFixed(1)} 家`);
/** 占比按「个百分点」、家数按相对变化 */
const shiftDelta = (m: MetricShift) => (m.kind === "share" ? `${m.delta > 0 ? "+" : m.delta < 0 ? "-" : ""}${Math.round(Math.abs(m.delta) * 100)} 个百分点` : m.rel_change != null ? `${m.rel_change > 0 ? "+" : ""}${Math.round(m.rel_change * 100)}%` : "");
const win = (w: WindowInfo, name: string) => `${name} ${w.days} 个交易日(取到 ${w.used} 天${w.from ? `,${w.from} ~ ${w.to}` : ""})`;

function ShiftView({ r }: { r: StructureResult }) {
  const st = r.structure;
  const th = r.thresholds;
  return (
    <Section icon={Shuffle} title="市场结构有没有移位"
      hint={`${win(r.recent_window, "最近")} 对比 ${win(r.prior_window, "之前")}。`}
      caliber={`两个窗口各取逐日读数的中位数来比(一两天涨停潮或大面就能把均值拉飞)。\n占比类读数变动超过 ${Math.round(th.share_abs * 100)} 个百分点、家数类变动超过 ${Math.round(th.count_rel * 100)}% 才算「明显移位」;每个窗口至少要 ${th.min_days} 天才比。\n移位只说明结构变了,不说明为什么 —— 先看下面的字段清单和制度事件。`}
      available={st.available} reason={st.reason ?? undefined}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-[12px] tabular-nums">
          <thead>
            <tr className="border-b border-border/60 text-[11px] text-muted-foreground">
              <th className="py-1.5 pr-3 text-left font-medium">读数</th>
              <th className="px-2 py-1.5 text-right font-medium">最近(日中位)</th>
              <th className="px-2 py-1.5 text-right font-medium">之前(日中位)</th>
              <th className="px-2 py-1.5 text-left font-medium">判断</th>
            </tr>
          </thead>
          <tbody>
            {safeArray<MetricShift>(st.metrics).map((m) => (
              <tr key={m.metric} className="border-b border-border/40 last:border-0">
                <td className="py-1.5 pr-3 text-muted-foreground">{m.label}</td>
                <td className="px-2 py-1.5 text-right font-semibold">{shiftVal(m, m.recent)}</td>
                <td className="px-2 py-1.5 text-right text-muted-foreground">{shiftVal(m, m.prior)}</td>
                <td className={cn("px-2 py-1.5", m.shifted ? "text-warning" : "text-muted-foreground")}>
                  {m.shifted ? "⚠ 明显移位" : "稳定"}
                  {shiftDelta(m) && ` (${shiftDelta(m)})`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {safeArray<string>(st.skipped).length > 0 && <p className="mt-1 text-[11px] text-muted-foreground">没比的:{st.skipped.join("、")}</p>}
    </Section>
  );
}

function DriftView({ r }: { r: StructureResult }) {
  const pools = safeArray<PoolDrift>(r.field_drift);
  return (
    <Section icon={Database} title="数据源字段有没有变"
      hint="数据源改字段会在派生曲线上造出一个假断点,跟市场无关。这里按天比对东财几张池返回的字段清单。">
      {pools.length === 0 ? <p className="text-[13px] text-muted-foreground">还没有可比对的字段记录。</p> : (
        <div className="space-y-2">
          {pools.map((p) => (
            <div key={p.pool} className="text-[12px]">
              <div className="flex flex-wrap items-center gap-2">
                <b>{p.label}</b>
                <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold",
                  !p.detectable ? "bg-muted text-muted-foreground" : p.changed ? "bg-warning/15 text-warning" : "bg-muted text-foreground/70")}>
                  {!p.detectable ? "判断不了" : p.changed ? "字段变过" : "稳定"}
                </span>
                <span className="text-[11px] text-muted-foreground">{p.days} 天</span>
              </div>
              {p.changed && (
                <ul className="ml-3 mt-0.5 space-y-0.5 text-[11px] text-muted-foreground">
                  {safeArray<PoolDrift["versions"][number]>(p.versions).map((v) => <li key={v.since}>{v.since} ~ {v.until}:{v.count ?? "—"} 个字段</li>)}
                  {!!p.added?.length && <li className="text-warning">新增:{p.added.join("、")}</li>}
                  {!!p.removed?.length && <li className="text-warning">去掉:{p.removed.join("、")}</li>}
                </ul>
              )}
              {p.note && <p className="text-[11px] text-muted-foreground/80">{p.note}</p>}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function RegimeView({ r, onChanged }: { r: StructureResult; onChanged: () => void }) {
  const events = safeArray<RegimeEvent>(r.regime_events);
  const [date, setDate] = useState("");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const canAdd = ISO_DAY.test(date) && title.trim().length > 0 && !busy;

  async function add() {
    setBusy(true); setMsg(null);
    try {
      await backend.ledgerSave("regime_event", { date, title: title.trim(), ...(note.trim() ? { note: note.trim() } : {}) });
      setDate(""); setTitle(""); setNote("");
      setMsg({ ok: true, text: "已登记" });
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: `没登记上:${cleanReason(e instanceof Error ? e.message : String(e))}` });
    } finally { setBusy(false); }
  }
  async function remove(id: string) {
    setBusy(true); setMsg(null); setConfirming(null);
    try {
      await backend.ledgerDelete("regime_event", id);
      setMsg({ ok: true, text: "已删除" });
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: `没删掉:${cleanReason(e instanceof Error ? e.message : String(e))}` });
    } finally { setBusy(false); }
  }

  return (
    <Section icon={Landmark} title="制度事件" hint={plain(r.regime_note)}>
      {events.length === 0 ? <p className="text-[13px] text-muted-foreground">还没登记。涨跌幅改制、号段启用、连板口径变化这类规则变化,在这里记一笔。</p> : (
        <ul className="space-y-1.5">
          {events.map((e) => (
            <li key={e.id} className="flex items-start gap-2 text-[12px]">
              <span className="w-24 shrink-0 tabular-nums text-muted-foreground">{e.date}</span>
              <span className="min-w-0 flex-1">
                <b>{e.title}</b>
                {e.upcoming && <span className="ml-1.5 rounded bg-info/15 px-1.5 py-0.5 text-[10px] font-bold text-info">还没施行</span>}
                {e.note && <span className="block text-[11px] text-muted-foreground">{e.note}</span>}
              </span>
              {confirming === e.id ? (
                <span className="flex shrink-0 items-center gap-1 text-[11px]">
                  <button type="button" onClick={() => remove(e.id)} disabled={busy} className="rounded bg-destructive/15 px-1.5 py-0.5 text-destructive hover:bg-destructive/25">确认删除</button>
                  <button type="button" onClick={() => setConfirming(null)} className="rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground">取消</button>
                </span>
              ) : (
                <button type="button" aria-label={`删除制度事件:${e.title}`} onClick={() => setConfirming(e.id)} disabled={busy}
                  className="shrink-0 rounded p-1 text-muted-foreground/60 hover:text-foreground"><Trash2 className="h-3.5 w-3.5" /></button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-dashed border-border pt-3">
        <input type="date" aria-label="制度事件的日期" value={date} onChange={(e) => setDate(e.target.value)}
          className="rounded border border-border bg-card px-2 py-1 text-[12px] [color-scheme:dark]" />
        <input aria-label="制度事件的标题" value={title} maxLength={120} placeholder="改了什么(如:创业板涨跌幅改为 20%)" onChange={(e) => setTitle(e.target.value)}
          className="min-w-[14rem] flex-1 rounded border border-border bg-card px-2 py-1 text-[12px]" />
        <input aria-label="制度事件的备注" value={note} maxLength={500} placeholder="备注(可选)" onChange={(e) => setNote(e.target.value)}
          className="min-w-[10rem] flex-1 rounded border border-border bg-card px-2 py-1 text-[12px]" />
        <button type="button" onClick={add} disabled={!canAdd}
          className="rounded bg-primary px-3 py-1 text-[12px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40">登记</button>
        {msg && <span role="status" className={cn("text-[12px]", msg.ok ? "text-muted-foreground" : "text-destructive")}>{msg.text}</span>}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground/70">日期可以是周末(规则常在周末公布),也可以是还没到的施行日。</p>
    </Section>
  );
}

export function structureSummary(r: StructureResult): string {
  const out = [`结构变化:截至 ${r.date}。${plain(r.summary)}`, plain(r.note)];
  const st = r.structure;
  if (st.available) {
    out.push(`${win(r.recent_window, "最近")} 对比 ${win(r.prior_window, "之前")}:` + safeArray<MetricShift>(st.metrics).map((m) => `${m.label} 日中位 ${shiftVal(m, m.recent)}(之前 ${shiftVal(m, m.prior)},${shiftDelta(m) || "—"})${m.shifted ? " 明显移位" : " 稳定"}`).join(";"));
  } else out.push(`结构比较暂不可用:${st.reason ?? "原因不明"}`);
  out.push("数据源字段:" + safeArray<PoolDrift>(r.field_drift).map((p) => `${p.label} ${!p.detectable ? "判断不了" : p.changed ? "字段变过" : "稳定"}(${p.days} 天)`).join(";"));
  const ev = safeArray<RegimeEvent>(r.regime_events);
  out.push(ev.length ? "人工登记的制度事件:" + ev.map((e) => `${e.date} ${e.title}${e.upcoming ? "(还没施行)" : ""}${e.note ? `:${e.note}` : ""}`).join(";") : "制度事件:还没登记(系统不自动推断,没登记不代表没有)");
  if (r.gaps.length) out.push(`缺口:${r.gaps.join(";")}`);
  return out.join("\n");
}

export function StructureView({ r, onChanged }: { r: StructureResult; onChanged: () => void }) {
  return (
    <div className="space-y-4">
      <div className={cn("rounded-lg border px-3 py-2 text-[12px] leading-relaxed",
        safeArray(r.structure.shifted).length || safeArray(r.field_changed).length ? "border-warning/40 bg-warning/10 text-warning" : "border-border bg-muted/20 text-muted-foreground")}>
        <p><b className="text-foreground">{plain(r.summary)}</b></p>
        <p className="mt-0.5">{plain(r.note)}</p>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <ShiftView r={r} />
        <DriftView r={r} />
      </div>
      <RegimeView r={r} onChanged={onChanged} />
      <GapsAndSource gaps={safeArray<string>(r.gaps)} source={r.source} />
    </div>
  );
}

export function StructureTab({ day, refreshNonce, onBusy }: ViewTabProps) {
  const [st, reload] = useShortlineView<StructureResult>("shortline_structure", day, undefined, refreshNonce, onBusy);
  const r = st.state === "done" ? st.data : null;
  useAiPage(r ? {
    key: `shortline:structure:${day}`,
    title: `结构变化 ${day}`,
    context: structureSummary(r),
    suggestions: ["最近的涨停结构和之前比变了吗,可能是哪一类原因", "数据源字段变化会影响哪些历史统计", "登记的制度事件前后,哪些读数不能直接比"],
  } : null);
  return (
    <ViewSlot st={st} label="结构变化">{(d) => <StructureView r={d} onChanged={reload} />}</ViewSlot>
  );
}
