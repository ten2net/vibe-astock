/**
 * 情绪复盘 · AI 周报:选中那天所在的一周(周一起、到那天为止),情绪走势 / 题材轮动 / 验证回看 三段 + 本周汇总。
 * 写法、核对和 AI 复盘同一套(段落卡片、数字三档、查看依据直接复用 ReviewTab 的部件);后台写,切走页面不打断。
 * 旁边的「本周我的交易」从交易日志在本机算:🔴 只在页面上显示,不进 AI 资料包,也不登记成 AI 页面上下文。
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, BookOpenCheck, Loader2, NotebookPen, Square } from "lucide-react";
import { backend } from "@/lib/backend";
import { hasLlm } from "@/lib/llm";
import { moneySigned, tone, type JournalRow, type JournalView } from "@/lib/journal";
import { hideIf } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { usePrivacyMode } from "@/hooks/usePrivacyMode";
import { useAiPage } from "../../../core/ai/pageContext";
import { cleanReason } from "./api";
import { Section } from "./FactsPanels";
import { safeArray } from "./format";
import { POLL_MS, StageCard, clock, unsavedNote } from "./ReviewTab";
import { useShortlineView } from "./useView";
import type { ReviewRun, ReviewStage, SavedWeekly, WeeklyReviewResult } from "./viewTypes";
import { GapsAndSource, ViewSlot } from "./ViewBits";
import type { ViewTabProps } from "./WeeklyTab";

const STATUS_TEXT: Record<ReviewStage["status"], string> = { pending: "排队中", running: "在写…", done: "", failed: "没写成", skipped: "跳过", cancelled: "已停止" };
const md = (d: string) => d.slice(5);

// ---------------------------------------------------------------- 本周我的交易(只在本机)
export interface WeekTrades {
  /** 这一周卖光的(按最后一笔卖出的日子算) */
  closed: number; win: number; loss: number; even: number;
  /** 卖光那几笔的已实现盈亏合计;一笔都算不出就是 null */
  net: number | null;
  /** 这一周补记的(没有成交明细,只有盈亏 %) */
  manual: number;
  /** 这一周第一次买入的(含还没卖完的) */
  opened: number;
  planned: number; unplanned: number; untagged: number;
}

/** 从交易日志的行里数出 from..to(含两头)这一周的交易。卖光的按盈亏金额分输赢,补记的按盈亏 % 分 */
export function weekTrades(rows: JournalRow[], from: string, to: string): WeekTrades {
  const inWeek = (d: string | null | undefined) => !!d && d >= from && d <= to;
  const out: WeekTrades = { closed: 0, win: 0, loss: 0, even: 0, net: null, manual: 0, opened: 0, planned: 0, unplanned: 0, untagged: 0 };
  for (const r of rows) {
    const ep = r.kind === "episode" ? r.episode : null;
    if (ep && inWeek(ep.first_buy)) out.opened++;
    const done = ep ? ep.closed && inWeek(ep.last_sell) : r.kind === "manual" && inWeek(r.date);
    if (!done) continue;
    if (ep) out.closed++; else out.manual++;
    const v = ep ? ep.realized_pnl : r.pnl_pct;
    if (typeof v === "number" && Number.isFinite(v)) {
      if (v > 0) out.win++; else if (v < 0) out.loss++; else out.even++;
      if (ep) out.net = (out.net ?? 0) + v;
    }
    if (r.as_planned === true) out.planned++; else if (r.as_planned === false) out.unplanned++; else out.untagged++;
  }
  if (out.net !== null) out.net = Math.round(out.net * 100) / 100;
  return out;
}

export function MyWeekCard({ view, from, to, hide }: { view: JournalView | null; from: string; to: string; hide: boolean }) {
  const head = (
    <p className="mb-2 flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
      <span className="inline-flex items-center gap-1.5"><BookOpenCheck className="h-4 w-4 text-primary" /> 本周我的交易</span>
      <span className="text-[11px] font-normal text-muted-foreground">{md(from)} 到 {md(to)} · 只在本机算、只在这里显示,不发给 AI</span>
    </p>
  );
  if (!view) return <div className="glass p-4">{head}<p className="text-[12px] text-muted-foreground">交易日志读取中…</p></div>;
  if (!view.available) return <div className="glass p-4">{head}<p className="text-[12px] text-muted-foreground">交易日志暂时算不了:{view.reason}</p></div>;
  const w = weekTrades(safeArray<JournalRow>(view.rows), from, to);
  const done = w.closed + w.manual;
  return (
    <div className="glass p-4">
      {head}
      {!done && !w.opened ? <p className="text-[12px] text-muted-foreground">这一周没有卖光的交易,也没有新开的。</p> : (
        <ul className="space-y-1 text-[12px]">
          {done > 0 && (
            <li>
              卖光 <b>{w.closed}</b> 笔{w.manual ? <>、补记 <b>{w.manual}</b> 笔</> : null}:赚 <b className="text-danger">{w.win}</b> · 亏 <b className="text-success">{w.loss}</b>
              {w.even ? <> · 持平 {w.even}</> : null}
              {w.net !== null && <> · 卖光那几笔合计 <b className={tone(w.net)}>{hideIf(hide, moneySigned(w.net))}</b></>}
            </li>
          )}
          {done > 0 && <li className="text-muted-foreground">按计划 {w.planned} · 没按计划 {w.unplanned}{w.untagged ? ` · 没标 ${w.untagged}` : ""}</li>}
          {w.opened > 0 && <li className="text-muted-foreground">这一周新开 {w.opened} 笔(含还没卖完的)</li>}
        </ul>
      )}
      <Link to="/journal" className="mt-2 inline-block text-[12px] text-primary">去交易日志看明细 →</Link>
    </div>
  );
}

function useJournalOnce(): JournalView | null {
  const [v, setV] = useState<JournalView | null>(null);
  useEffect(() => {
    const c = new AbortController();
    backend.journal(c.signal).then((d) => { if (!c.signal.aborted) setV(d); })
      .catch((e: unknown) => { if (!c.signal.aborted) setV({ available: false, reason: cleanReason(e instanceof Error ? e.message : String(e)) } as JournalView); });
    return () => c.abort();
  }, []);
  return v;
}

// ---------------------------------------------------------------- 周报正文
type Shown = { date: string; settled: boolean | null; ai: string; gaps: string[]; stages: ReviewStage[]; when: string; days: string[] };

export function WeeklyBody({ v }: { v: Shown }) {
  const summary = v.stages.find((s) => s.id === "summary");
  const parts = v.stages.filter((s) => s.id !== "summary");
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground">
        {[v.ai && `${v.ai} 写`, v.when, v.days.length ? `算进来的交易日 ${v.days.map(md).join("、")}` : ""].filter(Boolean).join(" · ")}
      </p>
      {v.settled === false && (
        <p role="status" className="text-[12px] text-warning">写的时候 {v.date} 还没收盘,那天的数字后来可能变了;收盘后可以再写一版。</p>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {summary && <StageCard s={summary} wide />}
        {parts.map((s) => <StageCard key={s.id} s={s} />)}
      </div>
      <GapsAndSource gaps={safeArray<string>(v.gaps)} source="AI 按这一周每天的情绪读数、题材、最高标和明日验证对账写(和其余分页同源);数字和证据编号由程序核对。不含个人交易" />
    </div>
  );
}

const fromRun = (x: ReviewRun, days: string[]): Shown => ({ ...x, days, when: `${clock(x.started_at)} 开始` });
const fromSaved = (x: SavedWeekly): Shown => ({ ...x, stages: safeArray<ReviewStage>(x.sections), days: safeArray<string>(x.days), when: `${clock(x.finished_at || x.created_at)} 写完` });

/** 页面显示哪一份(见 ReviewTab.shownReview):Agent 面板的上下文用同一个函数取 */
export function shownWeekly(r: WeeklyReviewResult, pick: string | null): { running: ReviewRun | null; saved: SavedWeekly | null; index: number } {
  const running = safeArray<ReviewRun>(r.runs).find((x) => !x.done) ?? null;
  const versions = safeArray<SavedWeekly>(r.versions);
  const i = Math.max(0, versions.findIndex((x) => x.id === pick));
  return { running, saved: versions[i] ?? null, index: i };
}

export function WeeklyReviewView({ r, onChanged, myWeek, pick: pickProp, onPick }: { r: WeeklyReviewResult; onChanged: () => void; myWeek?: React.ReactNode; pick?: string | null; onPick?: (id: string | null) => void }) {
  const runs = safeArray<ReviewRun>(r.runs);
  const versions = safeArray<SavedWeekly>(r.versions);
  const lastUnsaved = runs.filter((x) => x.done).map(unsavedNote).find((x) => x !== null) ?? null;
  const [ownPick, setOwnPick] = useState<string | null>(null);
  const pick = pickProp !== undefined ? pickProp : ownPick;
  const setPick = onPick ?? setOwnPick;
  const { running, saved: shown } = shownWeekly(r, pick);
  const [needConfig, setNeedConfig] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const start = async () => {
    if (!hasLlm()) { setNeedConfig(true); return; }
    setNeedConfig(false); setBusy(true); setErr(null);
    try { await backend.shortlineWeeklyReviewStart(r.date); setPick(null); onChanged(); }
    catch (e) { setErr(cleanReason(e instanceof Error ? e.message : String(e))); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    if (!running) return;
    setBusy(true); setErr(null);
    try { await backend.shortlineWeeklyReviewCancel(running.id); onChanged(); }
    catch (e) { setErr(cleanReason(e instanceof Error ? e.message : String(e))); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <Section icon={NotebookPen} title="AI 周报"
        hint={`写 ${r.week_start} 起这一周(到 ${r.date} 为止):情绪走势、题材轮动、明日验证回看三段各看自己那几块数据、各用一个新对话写,最后汇总并写下周看什么。写完程序逐个核对数字和证据编号。同一周写的几版都存着;写一次要几分钟,可以切去别的页面。`}>
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <>
              <span role="status" className="inline-flex items-center gap-1.5 text-[13px] text-primary">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在写 {running.stages.filter((s) => s.status !== "pending" && s.status !== "running").length}/{running.stages.length} 段
              </span>
              <button type="button" onClick={stop} disabled={busy}
                className="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1 text-[12px] hover:bg-muted disabled:opacity-40">
                <Square className="h-3 w-3" /> 停止
              </button>
            </>
          ) : (
            <button type="button" onClick={start} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <NotebookPen className="h-4 w-4" />}
              {versions.length ? "再写一版" : `让 AI 写 ${md(r.week_start)} 这一周的周报`}
            </button>
          )}
        </div>
        {needConfig && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-muted-foreground">
            <AlertCircle className="h-4 w-4 shrink-0 text-warning" />
            还没有接入 AI。<Link to="/settings" className="text-primary">先接入 AI</Link>,之后一键出周报。
          </div>
        )}
        {err && <p role="alert" className="mt-3 text-[12px] text-destructive">{err}</p>}
        {!running && lastUnsaved && <p role="status" className="mt-2 text-[12px] text-warning">{lastUnsaved}</p>}
      </Section>

      {myWeek}

      {running ? <WeeklyBody v={fromRun(running, [])} />
        : shown ? (
          <>
            {versions.length > 1 && (
              <div role="group" aria-label="周报版本" className="flex flex-wrap items-center gap-1 text-xs">
                <span className="text-muted-foreground">这一周写过 {versions.length} 版:</span>
                {versions.map((x, i) => (
                  <button key={x.id} type="button" aria-pressed={x.id === shown.id} onClick={() => setPick(x.id)}
                    className={cn("rounded-md border border-border/60 px-2 py-0.5 tabular-nums", x.id === shown.id ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:text-foreground")}>
                    截至 {md(x.date)} · {clock(x.finished_at || x.created_at)}{i === 0 ? "(最新)" : ""}
                  </button>
                ))}
              </div>
            )}
            <WeeklyBody v={fromSaved(shown)} />
          </>
        )
        : <p className="glass p-6 text-sm text-muted-foreground">{r.week_start} 起这一周还没写过 AI 周报。</p>}
    </div>
  );
}

const stageLines = (stages: ReviewStage[]) => stages.map((s) => `【${s.label}】${s.status === "done" ? s.text : STATUS_TEXT[s.status] || "没写成"}`);

/** 给右下角 Agent 面板的页面上下文:页面上正显示的那一份周报正文(市场数据);「本周我的交易」不放进来 */
export function weeklySummary(r: WeeklyReviewResult, pick: string | null = null): string {
  const { running, saved: v, index } = shownWeekly(r, pick);
  if (running) return [`${r.week_start} 起这一周的 AI 周报正在写(${clock(running.started_at)} 开始),页面上是写到一半的这一版:`, ...stageLines(safeArray<ReviewStage>(running.stages))].join("\n");
  if (!v) return `${r.week_start} 起这一周还没写过 AI 周报。`;
  const n = safeArray<SavedWeekly>(r.versions).length;
  const which = n > 1 ? `;这一周写过 ${n} 版,这是${index === 0 ? "最新一版" : "用户选的较早一版,不是最新"}` : "";
  return [`${r.week_start} 起这一周的 AI 周报(截至 ${v.date},${clock(v.finished_at || v.created_at)} 写完${which}):`,
    ...stageLines(safeArray<ReviewStage>(v.sections))].join("\n");
}

export function WeeklyReviewTab({ day, refreshNonce, onBusy }: ViewTabProps) {
  const [st, reload] = useShortlineView<WeeklyReviewResult>("shortline_weekly_review", day, undefined, refreshNonce, onBusy);
  const r = st.state === "done" ? st.data : null;
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => { setPick(null); }, [day]);
  const running = !!r && safeArray<ReviewRun>(r.runs).some((x) => !x.done);
  const journal = useJournalOnce();
  const { on: hide } = usePrivacyMode();
  useEffect(() => {
    if (!running) return;
    const t = setTimeout(reload, POLL_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, st]);
  useAiPage(r ? {
    key: `shortline:weekly-review:${r.week_start}`,
    title: `AI 周报 ${r.week_start} 起`,
    context: weeklySummary(r, pick),
    suggestions: ["这份周报里哪几句证据最弱", "情绪走势和题材轮动两段有没有矛盾", "下周要看的几条条件合不合理"],
  } : null);
  return (
    <ViewSlot st={st} label="AI 周报">
      {(d) => <WeeklyReviewView r={d} onChanged={reload} pick={pick} onPick={setPick} myWeek={<MyWeekCard view={journal} from={d.week_start} to={d.date} hide={hide} />} />}
    </ViewSlot>
  );
}
