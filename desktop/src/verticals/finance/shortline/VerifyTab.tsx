/**
 * 情绪复盘 · 明日验证:复盘那晚自己写下「明天哪个读数会往哪走」,下一个交易日收盘后自动对账。
 * 移植自 Vibe AStock v2.0.0 的「我自己的验证条件」;另加两样 VA 没有的:
 *   - 基准发生率:这个方向历史上本来多常见,判对一次值多少;
 *   - 「事后」:下一场开盘竞价(09:15)以后才写或改的条件照样对账,但不计入命中率。
 */
import { useEffect, useState } from "react";
import { ClipboardCheck, History, PenLine, Plus, X } from "lucide-react";
import { backend } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { useAiPage } from "../../../core/ai/pageContext";
import { cleanReason } from "./api";
import { Section } from "./FactsPanels";
import { rate, reading, safeArray } from "./format";
import { useShortlineView } from "./useView";
import type { Check, Direction, ItemResult, PlanItem, ReadingKind, Summary, TrackDay, VerifyMetric, VerifyResult } from "./viewTypes";
import { GapsAndSource, ViewSlot } from "./ViewBits";
import type { ViewTabProps } from "./WeeklyTab";

export const MAX_ITEMS = 8;
export const REASON_MAX = 200;

/** 噪声阈值:比率与涨跌幅都按「个百分点」说,别写成「超过 0.05」 */
export function epsText(eps: number, kind: ReadingKind, unit: string): string {
  if (kind === "rate") return `${Math.round(eps * 100)} 个百分点`;
  if (kind === "pct") return `${eps} 个百分点`;
  return `${eps}${unit}`;
}

/** 多大的变动才算升降:家数 / 板数阈值不到 1 时,差 1 就算 */
export function moveRule(eps: number, kind: ReadingKind, unit: string): string {
  if (kind === "count" && eps < 1) return `差 1${unit}就算升降`;
  return `变动超过 ${epsText(eps, kind, unit)} 才算升降`;
}

const DIR_TONE: Record<Direction, string> = { up: "bg-danger/15 text-danger", down: "bg-success/15 text-success", flat: "bg-muted text-muted-foreground" };

function Verdict({ v }: { v: boolean | null }) {
  if (v === null) return <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">判不了</span>;
  return v
    ? <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-bold text-primary">成立</span>
    : <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold text-foreground/70">不成立</span>;
}

/** 汇总一句:分母只算判得了的;超额只在有基准的那批上算 */
export function summaryText(s: Summary): string {
  if (!s.total) return "";
  const parts = [`${s.total} 条里判得了 ${s.decided} 条,成立 ${s.hit} 条${s.rate != null ? `(命中率 ${rate(s.rate)})` : ""}`];
  if (s.undecidable) parts.push(`${s.undecidable} 条读数没取到、判不了`);
  if (s.baseline_covered && s.expected_rate != null) {
    parts.push(`有历史基准的 ${s.baseline_covered} 条:照历史常态随口猜能对 ${rate(s.expected_rate)}${s.edge != null ? `,实际${s.edge >= 0 ? "多" : "少"}对 ${Math.round(Math.abs(s.edge) * 100)} 个百分点` : ""}`);
  }
  return parts.join(";");
}

function Baseline({ x }: { x: Pick<ItemResult, "baseline" | "baseline_samples" | "baseline_reason" | "baseline_note"> }) {
  if (x.baseline == null) return x.baseline_reason ? <p className="text-[11px] text-muted-foreground/70">基准发生率算不出:{x.baseline_reason}</p> : null;
  return (
    <p className="text-[11px] text-muted-foreground">
      这个方向历史上出现过 {rate(x.baseline)}({x.baseline_samples} 对可比日){x.baseline_note && <span className="text-warning"> · {x.baseline_note}</span>}
    </p>
  );
}

export function CheckView({ c }: { c: Check }) {
  if (!c.available) return <Section icon={ClipboardCheck} title="上一晚写的条件,对上了吗" available={false} reason={c.reason}>{null}</Section>;
  const results = safeArray<ItemResult>(c.results);
  return (
    <Section icon={ClipboardCheck} title={`${c.set_date} 晚写的条件 → ${c.date} 对账`}
      hint="读数按这两天收盘的值比;变动没超过噪声阈值算「持平」。">
      {c.provisional && <p role="status" className="mb-2 text-[12px] text-warning">{c.date} 还没收盘(或东财还没定稿):结果是暂定的,不计入累计战绩。</p>}
      {results.length === 0 ? <p className="text-[13px] text-muted-foreground">{c.set_date} 那晚没写条件。</p> : (
        <div className="space-y-2">
          {results.map((x) => (
            <div key={x.id} className="rounded-lg border border-border/60 bg-muted/10 px-3 py-2">
              <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold">
                {x.label}
                <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-bold", DIR_TONE[x.direction])}>写的:{x.direction_label}</span>
                <span className="text-[12px] font-normal text-muted-foreground">实际:{x.actual_label ?? "读数没取到"}</span>
                <Verdict v={x.verified} />
                {x.late && <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-bold text-warning" title="下一场开盘竞价(09:15)以后才写或改的">事后,不计入</span>}
              </div>
              <p className="mt-0.5 text-[11px] tabular-nums text-foreground/80">
                {c.set_date} {reading(x.prev_value, x.kind, x.unit)} → {c.date} {reading(x.cur_value, x.kind, x.unit)} · {moveRule(x.eps, x.kind, x.unit)}
              </p>
              {x.reason && <p className="text-[11px] text-muted-foreground">理由:{x.reason}</p>}
              <Baseline x={x} />
            </div>
          ))}
          <p className="border-t border-border pt-2 text-[12px] text-muted-foreground">{summaryText(c.summary)}</p>
        </div>
      )}
    </Section>
  );
}

type Draft = { metric: string; direction: Direction; reason: string };
const toDraft = (items: PlanItem[]): Draft[] => items.map((x) => ({ metric: x.metric, direction: x.direction, reason: x.reason ?? "" }));
const sameDrafts = (a: Draft[], b: Draft[]) => JSON.stringify(a) === JSON.stringify(b);

export function PlanEditor({ r, onSaved }: { r: VerifyResult; onSaved: () => void }) {
  const metrics = safeArray<VerifyMetric>(r.metrics);
  const directions = safeArray<{ key: Direction; label: string }>(r.directions);
  const saved = safeArray<PlanItem>(r.plan?.items);
  const savedDrafts = toDraft(saved);
  const [items, setItems] = useState<Draft[]>(savedDrafts);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // 换日期 / 重读后以后端为准
  useEffect(() => { setItems(toDraft(saved)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [r]);

  const used = new Set(items.map((x) => x.metric));
  const free = metrics.filter((m) => !used.has(m.key));
  const dirty = !sameDrafts(items, savedDrafts);
  const byKey = new Map(metrics.map((m) => [m.key, m]));
  const savedBy = new Map(saved.map((x) => [x.metric, x]));
  const put = (i: number, patch: Partial<Draft>) => setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function save() {
    setSaving(true); setMsg(null);
    try {
      await backend.shortlineVerifySave(r.date, items.map((x) => ({ ...x, reason: x.reason.trim() })));
      setMsg({ ok: true, text: items.length ? "已保存,下一个交易日收盘后自动对账" : "已清空这晚的条件" });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: `没保存上:${cleanReason(e instanceof Error ? e.message : String(e))}` });
    } finally { setSaving(false); }
  }

  return (
    <Section icon={PenLine} title={`${r.date} 晚写给下一个交易日的条件`}
      hint={`自己写下的,明天才会想回来看对没对。一个读数一条,最多 ${MAX_ITEMS} 条;下一个交易日 09:15 开盘竞价以后就不能再写或改 —— 看过盘再写的判断不算数。`}>
      <div className="space-y-2">
        {items.length === 0 && <p className="text-[13px] text-muted-foreground">这晚还没写条件。</p>}
        {items.map((it, i) => {
          const m = byKey.get(it.metric);
          const s = savedBy.get(it.metric);
          return (
            <div key={i} className="rounded-lg border border-border/60 px-3 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <select aria-label={`第 ${i + 1} 条的读数`} value={it.metric} onChange={(e) => put(i, { metric: e.target.value })}
                  className="rounded border border-border bg-card px-2 py-1 text-[12px]">
                  {metrics.filter((x) => x.key === it.metric || !used.has(x.key)).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
                <select aria-label={`第 ${i + 1} 条的方向`} value={it.direction} onChange={(e) => put(i, { direction: e.target.value as Direction })}
                  className="rounded border border-border bg-card px-2 py-1 text-[12px]">
                  {directions.map((d) => <option key={d.key} value={d.key}>明天{d.label}</option>)}
                </select>
                <input aria-label={`第 ${i + 1} 条的理由`} value={it.reason} maxLength={REASON_MAX} placeholder="为什么(可选)"
                  onChange={(e) => put(i, { reason: e.target.value })}
                  className="min-w-[12rem] flex-1 rounded border border-border bg-card px-2 py-1 text-[12px]" />
                <button type="button" aria-label={`删掉第 ${i + 1} 条`} onClick={() => setItems(items.filter((_, j) => j !== i))}
                  className="rounded p-1 text-muted-foreground/60 hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
              </div>
              {m && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {m.hint}
                  {s && s.base_value != null && <> · 今天 <b className="text-foreground">{reading(s.base_value, m.kind, m.unit)}</b></>}
                  {` · ${moveRule(m.eps, m.kind, m.unit)}`}
                </p>
              )}
              {s && s.direction === it.direction && <Baseline x={s} />}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" disabled={items.length >= MAX_ITEMS || !free.length}
          onClick={() => setItems([...items, { metric: free[0]!.key, direction: directions[0]?.key ?? "up", reason: "" }])}
          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[12px] hover:bg-muted disabled:opacity-40">
          <Plus className="h-3.5 w-3.5" /> 加一条
        </button>
        <button type="button" onClick={save} disabled={saving || !dirty}
          className="rounded bg-primary px-3 py-1 text-[12px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40">
          {saving ? "保存中…" : "保存"}
        </button>
        {dirty && !saving && <span className="text-[11px] text-warning">有改动还没保存</span>}
        {msg && <span role="status" className={cn("text-[12px]", msg.ok ? "text-muted-foreground" : "text-destructive")}>{msg.text}</span>}
      </div>
    </Section>
  );
}

export function TrackView({ t }: { t: VerifyResult["track"] }) {
  const days = safeArray<TrackDay>(t.days);
  return (
    <Section icon={History} title="累计战绩" hint={`${t.from} ~ ${t.to} 之间写过并已对账的条件。事后写的、对账那天还没收盘的,不计入。`}>
      {t.summary.total === 0 && !t.excluded_late && !t.excluded_provisional
        ? <p className="text-[13px] text-muted-foreground">这段时间还没有对过账的条件。</p>
        : (
          <>
            <p className="text-[13px]">{summaryText(t.summary) || "没有计入的条件"}</p>
            {(t.excluded_late > 0 || t.excluded_provisional > 0) && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                没计入:{t.excluded_late > 0 && `事后写的 ${t.excluded_late} 条`}{t.excluded_late > 0 && t.excluded_provisional > 0 && "、"}{t.excluded_provisional > 0 && `对账日还没收盘的 ${t.excluded_provisional} 条`}
              </p>
            )}
            {days.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-[12px] tabular-nums text-muted-foreground">
                {[...days].reverse().map((d) => (
                  <li key={d.set_date}>{d.set_date} → {d.date}:{d.total} 条,判得了 {d.decided},成立 <b className="text-foreground">{d.hit}</b>{d.excluded ? `,不计入 ${d.excluded}` : ""}</li>
                ))}
              </ul>
            )}
          </>
        )}
    </Section>
  );
}

export function verifySummary(r: VerifyResult): string {
  const out = [`明日验证:复盘日 ${r.date}。条件写在复盘那晚,下一个交易日收盘后对账;变动没超过噪声阈值算持平。`];
  const c = r.check;
  if (!c.available) out.push(`上一晚的对账:没算出来(${c.reason})`);
  else {
    const rs = safeArray<ItemResult>(c.results);
    out.push(rs.length ? `${c.set_date} 晚写的条件在 ${c.date} 对账${c.provisional ? "(还没收盘,暂定)" : ""}:` : `${c.set_date} 那晚没写条件。`);
    for (const x of rs) {
      out.push(`- ${x.label} 写的${x.direction_label},实际${x.actual_label ?? "读数没取到"}(${reading(x.prev_value, x.kind, x.unit)}→${reading(x.cur_value, x.kind, x.unit)}):${x.verified == null ? "判不了" : x.verified ? "成立" : "不成立"}${x.late ? ",事后写的不计入" : ""}${x.baseline != null ? `;这个方向历史上出现过 ${rate(x.baseline)}` : ""}${x.reason ? `;理由:${x.reason}` : ""}`);
    }
    if (rs.length) out.push(summaryText(c.summary));
  }
  const plan = safeArray<PlanItem>(r.plan?.items);
  out.push(plan.length ? `${r.date} 晚写给下一个交易日的条件:` + plan.map((x) => `${x.label}${x.direction_label}(今天 ${reading(x.base_value, x.kind, x.unit)})${x.reason ? `,理由:${x.reason}` : ""}`).join(";") : `${r.date} 晚还没写条件。`);
  const t = r.track;
  out.push(`累计战绩(${t.from} ~ ${t.to}):${summaryText(t.summary) || "还没有计入的条件"}`);
  out.push(`可选读数:${safeArray<VerifyMetric>(r.metrics).map((m) => `${m.label}(${m.hint})`).join(";")}`);
  if (r.gaps.length) out.push(`缺口:${r.gaps.join(";")}`);
  return out.join("\n");
}

export function VerifyView({ r, onSaved }: { r: VerifyResult; onSaved: () => void }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <CheckView c={r.check} />
        <PlanEditor r={r} onSaved={onSaved} />
      </div>
      <TrackView t={r.track} />
      <GapsAndSource gaps={safeArray<string>(r.gaps)} source={r.source} />
    </div>
  );
}

export function VerifyTab({ day, refreshNonce, onBusy }: ViewTabProps) {
  const [st, reload] = useShortlineView<VerifyResult>("shortline_verify", day, undefined, refreshNonce, onBusy);
  const r = st.state === "done" ? st.data : null;
  useAiPage(r ? {
    key: `shortline:verify:${day}`,
    title: `明日验证 ${day}`,
    context: verifySummary(r),
    suggestions: ["结合这一天的情绪读数,明天哪几个读数值得写成验证条件", "上一晚的条件哪些对了、哪些错了,错在哪", "我写的条件是不是太容易成立了(看基准发生率)"],
  } : null);
  return (
    <ViewSlot st={st} label="明日验证">{(d) => <VerifyView r={d} onSaved={reload} />}</ViewSlot>
  );
}

