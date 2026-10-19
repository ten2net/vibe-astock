/**
 * 情绪复盘 · AI 复盘:情绪 / 资金 / 题材 / 龙虎榜 / 龙头 五段,最后汇总并给明日验证提建议。
 * 移植自 Vibe AStock v2.0.0 的五分项复盘。每段只看自己那几块数据、用一个新对话写;写完由程序核对:
 *   - 数字分三档(对得上资料包 / 写了算式且重算通过 / 没有交代出处),算式算错的单独标红 —— 和多空辩论同一套;
 *   - 「查看依据」:正文里引到的每条证据原样列出;引了资料包里没有的编号,也标出来。
 * 后台一段段写,切走页面不会打断;写完自动存一版,不覆盖旧版。
 */
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, ClipboardCheck, FileSearch, Loader2, Sparkles, Square } from "lucide-react";
import { backend } from "@/lib/backend";
import { hasLlm } from "@/lib/llm";
import { cn } from "@/lib/utils";
import { useAiPage } from "../../../core/ai/pageContext";
import { cleanReason } from "./api";
import { Section } from "./FactsPanels";
import { safeArray } from "./format";
import { useShortlineView } from "./useView";
import type { Direction, PlanItem, ReviewAudit, ReviewCondition, ReviewResult, ReviewRun, ReviewStage, SavedReview, VerifyResult } from "./viewTypes";
import { GapsAndSource, ViewSlot } from "./ViewBits";
import { MAX_ITEMS } from "./VerifyTab";
import type { ViewTabProps } from "./WeeklyTab";

/** 写的时候多久查一次进度 */
export const POLL_MS = 3000;

const STATUS_TEXT: Record<ReviewStage["status"], string> = {
  pending: "排队中", running: "在写…", done: "", failed: "没写成", skipped: "跳过", cancelled: "已停止",
};
const DIR_TONE: Record<Direction, string> = { up: "bg-danger/15 text-danger", down: "bg-success/15 text-success", flat: "bg-muted text-muted-foreground" };

/** 时间按北京时间写成「10-10 18:25」;认不出就原样 */
export function clock(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * 正文里的证据编号换成小角标:引到资料包里的按「查看依据」的序号标,编出来的标红问号。
 * AI 可能写成 [ev-a] 也可能写成 [ev-a, ev-b],两种都认。
 */
export function CitedText({ text, cited }: { text: string; cited: { id: string; line: string }[] }) {
  const order = new Map(cited.map((c, i) => [c.id, i + 1]));
  const lineOf = new Map(cited.map((c) => [c.id, c.line]));
  const paras = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  return (
    <div className="space-y-2 text-[13px] leading-relaxed">
      {paras.map((p, i) => (
        <p key={i}>
          {p.split(/(\[(?:\s*ev-[0-9a-f]{6,}\s*[,，、]?\s*)+\])/).map((part, j) => {
            if (!/^\[\s*ev-/.test(part)) return <Fragment key={j}>{part}</Fragment>;
            const ids = part.match(/ev-[0-9a-f]{6,}/g) ?? [];
            return (
              <sup key={j} className="ml-0.5 space-x-0.5 text-[10px]">
                {ids.map((id) => order.has(id)
                  ? <span key={id} title={lineOf.get(id)} className="cursor-help text-primary">[{order.get(id)}]</span>
                  : <span key={id} title={`资料包里没有 ${id}`} className="cursor-help font-bold text-destructive">[?]</span>)}
              </sup>
            );
          })}
        </p>
      ))}
    </div>
  );
}

/** 数字核对:三档分开说;算式算错是唯一能断言「错了」的一类,要显眼。「没有交代出处」不等于错 */
export function AuditLine({ a, unknown }: { a?: ReviewAudit; unknown: string[] }) {
  const bad = safeArray<ReviewAudit["bad_math"][number]>(a?.bad_math);
  if (!a && !unknown.length) return null;
  return (
    <div className="mt-3 space-y-1.5 border-t border-border/40 pt-2 text-[11px]">
      {bad.length > 0 && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/[0.07] p-2">
          <p className="font-semibold text-destructive">🔴 有 {bad.length} 处算式重算对不上(算式是它自己写的):</p>
          <ul className="mt-1 space-y-0.5 font-mono text-muted-foreground">
            {bad.slice(0, 4).map((b, i) => (
              <li key={i}>「{b.raw}」→ 重算应为 <b className="text-destructive">{b.recomputed.toFixed(2)}{b.percent ? "%" : ""}</b></li>
            ))}
          </ul>
        </div>
      )}
      {unknown.length > 0 && (
        <p className="font-semibold text-destructive">🔴 引了 {unknown.length} 个资料包里没有的证据编号(正文里标成红色问号),那几处说法没有出处。</p>
      )}
      {a && a.total > 0 && (
        <p className="text-muted-foreground/70">
          数字 {a.total} 个:<b className="text-foreground/70">{a.bound}</b> 个对得上资料包 ·{" "}
          <b className="text-foreground/70">{a.derived}</b> 个写了算式且重算通过 ·{" "}
          <b className={a.loose ? "text-warning" : "text-foreground/70"}>{a.loose}</b> 个没有交代出处
          {a.loose > 0 && <span className="text-muted-foreground/60">(不等于错,但这一档没经过核对)</span>}
        </p>
      )}
    </div>
  );
}

function Evidence({ cited }: { cited: { id: string; line: string }[] }) {
  if (!cited.length) return null;
  return (
    <details className="mt-2 text-[11px]">
      <summary className="inline-flex cursor-pointer items-center gap-1 text-primary"><FileSearch className="h-3.5 w-3.5" /> 查看依据({cited.length} 条)</summary>
      <ol className="mt-1.5 space-y-1 font-mono leading-relaxed text-muted-foreground">
        {cited.map((c, i) => <li key={c.id} className="break-all"><span className="text-primary">[{i + 1}]</span> {c.line}</li>)}
      </ol>
    </details>
  );
}

export function StageCard({ s, wide, children }: { s: ReviewStage; wide?: boolean; children?: ReactNode }) {
  const cited = safeArray<{ id: string; line: string }>(s.cited);
  const unknown = safeArray<string>(s.unknown_cites);
  return (
    <div className={cn("glass p-4", wide && "md:col-span-2")}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="text-sm font-semibold">{s.label}</h3>
        <span className="text-[11px] text-muted-foreground">{s.desc}</span>
        {s.status !== "done" && (
          <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold",
            s.status === "failed" ? "bg-destructive/15 text-destructive" : s.status === "running" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}>
            {s.status === "running" && <Loader2 className="mr-0.5 inline h-3 w-3 animate-spin" />}{STATUS_TEXT[s.status]}
          </span>
        )}
      </div>
      {s.status === "done"
        ? <CitedText text={s.text} cited={cited} />
        : s.error && s.status !== "pending" && s.status !== "running"
          ? <p className="text-[12px] text-muted-foreground">{cleanReason(s.error)}</p>
          : null}
      {s.status === "done" && <AuditLine a={s.audit} unknown={unknown} />}
      {s.status === "done" && <Evidence cited={cited} />}
      {children}
    </div>
  );
}

type Draft = { metric: string; direction: Direction; reason: string };
/**
 * 把 AI 的建议并进这晚已写的条件:已写过的读数不改(人写的优先),满 MAX_ITEMS 条就不再加。
 * 返回要整晚保存的条件(null = 一条都没加,不用存)和一句给人看的结果。
 */
export function mergeConditions(have: Pick<PlanItem, "metric" | "direction" | "reason">[], conds: ReviewCondition[]): { items: Draft[] | null; text: string } {
  const used = new Set(have.map((x) => x.metric));
  const fresh = conds.filter((c) => !used.has(c.metric));
  const take = fresh.slice(0, Math.max(0, MAX_ITEMS - have.length));
  const parts: string[] = [];
  if (take.length) parts.push(`加了 ${take.length} 条到「明日验证」`);
  if (conds.length - fresh.length) parts.push(`${conds.length - fresh.length} 条的读数这晚已经写过,没改`);
  if (fresh.length - take.length) parts.push(`${fresh.length - take.length} 条超出 ${MAX_ITEMS} 条上限没加`);
  return {
    items: take.length ? [...have.map((x) => ({ metric: x.metric, direction: x.direction, reason: x.reason ?? "" })), ...take.map((c) => ({ metric: c.metric, direction: c.direction, reason: c.reason }))] : null,
    text: parts.join(";"),
  };
}

/** 汇总给的明日验证建议:点一下加进这晚的「明日验证」(已经写过的读数不改,满 8 条就不加) */
export function Conditions({ date, conds, note, metrics, directions }: {
  date: string; conds: ReviewCondition[]; note: string;
  metrics: ReviewResult["metrics"]; directions: ReviewResult["directions"];
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!conds.length && !note) return null;
  const label = (k: string) => metrics.find((m) => m.key === k)?.label ?? k;
  const dirLabel = (d: Direction) => directions.find((x) => x.key === d)?.label ?? d;
  const adopt = async () => {
    setBusy(true); setMsg(null);
    try {
      const v = await backend.shortlineView<VerifyResult>("shortline_verify", { date });
      const m = mergeConditions(safeArray<PlanItem>(v.plan?.items), conds);
      if (m.items) await backend.shortlineVerifySave(date, m.items);
      setMsg({ ok: true, text: m.text });
    } catch (e) {
      setMsg({ ok: false, text: `没加上:${cleanReason(e instanceof Error ? e.message : String(e))}` });
    } finally { setBusy(false); }
  };
  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-muted/10 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold"><ClipboardCheck className="h-3.5 w-3.5 text-primary" /> {conds.length ? "AI 建议明天看这几个读数" : "明日验证"}</p>
      {conds.length > 0 && (
        <ul className="space-y-1.5">
          {conds.map((c) => (
            <li key={c.metric} className="flex flex-wrap items-center gap-1.5 text-[12px]">
              <span className="font-medium">{label(c.metric)}</span>
              <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-bold", DIR_TONE[c.direction])}>{dirLabel(c.direction)}</span>
              {c.reason && <span className="text-muted-foreground">{c.reason}</span>}
            </li>
          ))}
        </ul>
      )}
      {note && <p className="mt-1.5 text-[11px] text-muted-foreground/70">{note}</p>}
      {conds.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" onClick={adopt} disabled={busy}
            className="rounded bg-primary px-3 py-1 text-[12px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40">
            {busy ? "加入中…" : "加进明日验证"}
          </button>
          <span className="text-[11px] text-muted-foreground">加进去的条件下一个交易日收盘后自动对账;要改去「明日验证」分页。</span>
          {msg && <span role="status" className={cn("text-[12px]", msg.ok ? "text-muted-foreground" : "text-destructive")}>{msg.text}</span>}
        </div>
      )}
    </div>
  );
}

type Shown = Pick<SavedReview, "date" | "settled" | "ai" | "gaps" | "conditions" | "conditions_note" | "imported"> & { stages: ReviewStage[]; when: string };

const SOURCE = "AI 按这一天的情绪、资金、题材、龙虎榜、梯队数据写(和其余分页同源);数字和证据编号由程序核对";
/** 旧版导入的那几版:新版没有重算,不能说「由程序核对」 */
const IMPORTED_SOURCE = "旧版 Vibe AStock 当时写的复盘,原文照搬;证据编号对照的是旧版当时的资料包,数字没有重算";

export function ReviewBody({ v, r }: { v: Shown; r: ReviewResult }) {
  const summary = v.stages.find((s) => s.id === "summary");
  const parts = v.stages.filter((s) => s.id !== "summary");
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground">{[v.ai && `${v.ai} 写`, v.when].filter(Boolean).join(" · ")}</p>
      {v.settled === false && (
        <p role="status" className="text-[12px] text-warning">写的时候 {v.date} 还没收盘,里面的数字后来可能变了;收盘后可以再写一版。</p>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {summary && (
          <StageCard s={summary} wide>
            {summary.status === "done" && (
              <Conditions date={v.date} conds={safeArray<ReviewCondition>(v.conditions)} note={v.conditions_note} metrics={safeArray(r.metrics)} directions={safeArray(r.directions)} />
            )}
          </StageCard>
        )}
        {parts.map((s) => <StageCard key={s.id} s={s} />)}
      </div>
      <GapsAndSource gaps={safeArray<string>(v.gaps)} source={v.imported ? IMPORTED_SOURCE : SOURCE} />
    </div>
  );
}

const fromRun = (x: ReviewRun): Shown => ({ ...x, when: `${clock(x.started_at)} 开始` });
const fromSaved = (x: SavedReview): Shown => ({ ...x, stages: safeArray<ReviewStage>(x.sections), when: `${clock(x.finished_at || x.created_at)} 写完` });

/** 刚结束但没存下来的那次:说清为什么 */
export function unsavedNote(x: ReviewRun): string | null {
  if (!x.done || x.saved_id) return null;
  if (x.outcome === "cancelled") return `${clock(x.started_at)} 开始的那次已停止,没存。`;
  if (x.save_error) return `${clock(x.started_at)} 开始的那次写完了但${x.save_error}。`;
  const why = x.stages.map((s) => s.error).find(Boolean);
  return `${clock(x.started_at)} 开始的那次一段都没写成,没存${why ? `:${cleanReason(why)}` : ""}。`;
}

/**
 * 页面显示哪一份:正在写就是正在写的那次,否则是选中的版本(没选 = 最新)。
 * Agent 面板的上下文用同一个函数取,页面和发给 AI 的始终是同一份(2026-10-11 审计)。
 */
export function shownReview(r: ReviewResult, pick: string | null): { running: ReviewRun | null; saved: SavedReview | null; index: number } {
  const running = safeArray<ReviewRun>(r.runs).find((x) => !x.done) ?? null;
  const versions = safeArray<SavedReview>(r.versions);
  const i = Math.max(0, versions.findIndex((x) => x.id === pick));
  return { running, saved: versions[i] ?? null, index: i };
}

export function ReviewView({ r, onChanged, pick: pickProp, onPick }: { r: ReviewResult; onChanged: () => void; pick?: string | null; onPick?: (id: string | null) => void }) {
  const runs = safeArray<ReviewRun>(r.runs);
  const versions = safeArray<SavedReview>(r.versions);
  const lastUnsaved = runs.filter((x) => x.done).map(unsavedNote).find((x) => x !== null) ?? null;
  // 选中的版本由外层(ReviewTab)管,好让 Agent 面板拿到同一份;单独渲染时自己管
  const [ownPick, setOwnPick] = useState<string | null>(null);
  const pick = pickProp !== undefined ? pickProp : ownPick;
  const setPick = onPick ?? setOwnPick;
  const { running, saved: shown } = shownReview(r, pick);
  const [needConfig, setNeedConfig] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const start = async () => {
    if (!hasLlm()) { setNeedConfig(true); return; }
    setNeedConfig(false); setBusy(true); setErr(null);
    try { await backend.shortlineReviewStart(r.date); setPick(null); onChanged(); }
    catch (e) { setErr(cleanReason(e instanceof Error ? e.message : String(e))); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    if (!running) return;
    setBusy(true); setErr(null);
    try { await backend.shortlineReviewCancel(running.id); onChanged(); }
    catch (e) { setErr(cleanReason(e instanceof Error ? e.message : String(e))); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <Section icon={Sparkles} title="AI 复盘"
        hint="情绪、资金、题材、龙虎榜、龙头五段各看自己那几块数据、各用一个新对话写,最后汇总并给明日验证提建议。写完程序逐个核对数字和证据编号。每次写完存一版,不覆盖旧版;写一次要几分钟,可以切去别的页面。">
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
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {versions.length ? "再写一版" : `让 AI 复盘 ${r.date}`}
            </button>
          )}
        </div>
        {needConfig && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-muted-foreground">
            <AlertCircle className="h-4 w-4 shrink-0 text-warning" />
            还没有接入 AI。<Link to="/settings" className="text-primary">先接入 AI</Link>,之后一键出复盘。
          </div>
        )}
        {err && <p role="alert" className="mt-3 text-[12px] text-destructive">{err}</p>}
        {!running && lastUnsaved && <p role="status" className="mt-2 text-[12px] text-warning">{lastUnsaved}</p>}
      </Section>

      {running ? <ReviewBody v={fromRun(running)} r={r} />
        : shown ? (
          <>
            {versions.length > 1 && (
              <div role="group" aria-label="复盘版本" className="flex flex-wrap items-center gap-1 text-xs">
                <span className="text-muted-foreground">这一天写过 {versions.length} 版:</span>
                {versions.map((x, i) => (
                  <button key={x.id} type="button" aria-pressed={x.id === shown.id} onClick={() => setPick(x.id)}
                    className={cn("rounded-md border border-border/60 px-2 py-0.5 tabular-nums", x.id === shown.id ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:text-foreground")}>
                    {clock(x.finished_at || x.created_at)}{i === 0 ? "(最新)" : ""}
                  </button>
                ))}
              </div>
            )}
            <ReviewBody v={fromSaved(shown)} r={r} />
          </>
        )
        : <p className="glass p-6 text-sm text-muted-foreground">{r.date} 还没写过 AI 复盘。</p>}
    </div>
  );
}

const stageLines = (stages: ReviewStage[]) => stages.map((s) => `【${s.label}】${s.status === "done" ? s.text : STATUS_TEXT[s.status] || "没写成"}`);

/** 给右下角 Agent 面板的页面上下文:页面上正显示的那一份的汇总和五段正文(证据编号原样保留) */
export function reviewSummary(r: ReviewResult, pick: string | null = null): string {
  const { running, saved: v, index } = shownReview(r, pick);
  if (running) return [`${r.date} 的 AI 复盘正在写(${clock(running.started_at)} 开始),页面上是写到一半的这一版:`, ...stageLines(safeArray<ReviewStage>(running.stages))].join("\n");
  if (!v) return `${r.date} 还没写过 AI 复盘。`;
  const n = safeArray<SavedReview>(r.versions).length;
  const which = n > 1 ? `;这一天写过 ${n} 版,这是${index === 0 ? "最新一版" : "用户选的较早一版,不是最新"}` : "";
  return [`${r.date} 的 AI 复盘(${clock(v.finished_at || v.created_at)} 写完${which}${v.imported ? ";从旧版导入,原文照搬,数字没按新版规则核对" : ""}):`,
    ...stageLines(safeArray<ReviewStage>(v.sections))].join("\n");
}

export function ReviewTab({ day, refreshNonce, onBusy }: ViewTabProps) {
  const [st, reload] = useShortlineView<ReviewResult>("shortline_review", day, undefined, refreshNonce, onBusy);
  const r = st.state === "done" ? st.data : null;
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => { setPick(null); }, [day]);
  const running = !!r && safeArray<ReviewRun>(r.runs).some((x) => !x.done);
  // 写的时候隔几秒查一次进度(不带 refresh,只读内存里的状态和台账)
  useEffect(() => {
    if (!running) return;
    const t = setTimeout(reload, POLL_MS);
    return () => clearTimeout(t);
    // reload 每次渲染是新函数,但只是给计数器加一;按 st 变化重排下一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, st]);
  useAiPage(r ? {
    key: `shortline:review:${day}`,
    title: `AI 复盘 ${day}`,
    context: reviewSummary(r, pick),
    suggestions: ["这份复盘里哪几句证据最弱", "五段之间有没有互相矛盾的地方", "汇总给的明日验证建议合不合理"],
  } : null);
  return <ViewSlot st={st} label="AI 复盘">{(d) => <ReviewView r={d} onChanged={reload} pick={pick} onPick={setPick} />}</ViewSlot>;
}
