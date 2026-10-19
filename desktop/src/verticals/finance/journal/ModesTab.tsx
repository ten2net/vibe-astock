/**
 * 交易日志 · 模式卡:把自己的打法写下来、带版本,业绩按版本分段。
 * 🔴 不预填任何规则内容:那就成了我们在教用户怎么交易。
 */
import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { pctSigned, rateDelta, ratePct, tone, type ModeCardPerf, type Modes } from "@/lib/journal";
import { BTN, BTN_GHOST, INPUT, Panel } from "./bits";
import type { Act } from "./forms";
import { errText } from "./useJournal";

const TEXT_FIELDS = [
  ["setup", "什么情况下做"], ["entry", "怎么进"], ["exit", "怎么出"], ["sizing", "仓位"], ["phase", "适用的情绪阶段"],
] as const;
type TextKey = (typeof TEXT_FIELDS)[number][0];
interface Draft { card_id: string | null; name: string; playbook: string; changes: string; text: Record<TextKey, string> }

const blank = (playbook: string): Draft => ({ card_id: null, name: "", playbook, changes: "", text: { setup: "", entry: "", exit: "", sizing: "", phase: "" } });
const draftOf = (c: ModeCardPerf): Draft => {
  const v = c.by_version.at(-1);
  return { card_id: c.id, name: c.name, playbook: v?.playbook || c.playbook, changes: "", text: { setup: v?.setup ?? "", entry: v?.entry ?? "", exit: v?.exit ?? "", sizing: v?.sizing ?? "", phase: v?.phase ?? "" } };
};

function Editor({ draft, playbooks, act, onDone }: { draft: Draft; playbooks: readonly string[]; act: Act; onDone: () => void }) {
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const save = async () => {
    if (!d.name.trim()) { setMsg("模式卡要有名字"); return; }
    setBusy(true);
    setMsg("");
    try {
      await act({ action: "mode_save", ...(d.card_id ? { card_id: d.card_id, changes: d.changes } : {}), name: d.name, playbook: d.playbook, ...d.text });
      onDone();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap gap-2">
        <input aria-label="模式名" placeholder="模式名,如「首板早封」" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} className={cn(INPUT, "min-w-[12rem] flex-1")} />
        <select aria-label="打法" value={d.playbook} onChange={(e) => setD({ ...d, playbook: e.target.value })} className={INPUT}>
          {playbooks.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      {TEXT_FIELDS.map(([k, label]) => (
        <label key={k} className="block text-[12px]">
          <span className="text-muted-foreground">{label}</span>
          <textarea rows={2} value={d.text[k]} onChange={(e) => setD({ ...d, text: { ...d.text, [k]: e.target.value } })} className={cn(INPUT, "mt-1 w-full resize-y text-[12px]")} />
        </label>
      ))}
      {d.card_id && (
        <input aria-label="这次改了什么" placeholder="这次改了什么(会记进新版本)" value={d.changes} onChange={(e) => setD({ ...d, changes: e.target.value })} className={cn(INPUT, "w-full text-[12px]")} />
      )}
      <p className="text-[11px] text-muted-foreground">
        {d.card_id ? "打法或上面五段有改动就开一个新版本,从明天起生效;今天和以前的交易仍按原版本统计。只改名字不开新版本。" : "第一版从今天起生效,不回溯到更早的交易。"}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={save} disabled={busy} className={BTN}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}保存</button>
        <button type="button" onClick={onDone} className={BTN_GHOST}>取消</button>
        {msg && <p role="status" className="text-[12px] text-destructive">{msg}</p>}
      </div>
    </div>
  );
}

function CardView({ c, minPer, onEdit, onDelete }: { c: ModeCardPerf; minPer: number; onEdit: () => void; onDelete: () => void }) {
  const cmp = c.latest_vs_prev;
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <b>{c.name}</b>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{c.playbook}</span>
        <span className="text-muted-foreground">{c.version_count} 个版本 · 对上 {c.matched_trades} 笔</span>
        <span className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={onEdit} className={BTN_GHOST}>编辑</button>
          <button type="button" onClick={onDelete} aria-label={`删除模式卡「${c.name}」`} title="删除这张模式卡" className="p-1 text-muted-foreground/60 hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
        </span>
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[520px] text-[12px] tabular-nums">
          <thead>
            <tr className="border-b border-border text-[11px] text-muted-foreground">
              {["版本", "生效", "打法", "笔数", "胜率", "中位", "改了什么"].map((h, i) => (
                <th key={h} className={cn("px-2 py-1.5 font-normal", i >= 3 && i <= 5 ? "text-right" : "text-left")}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {c.by_version.map((v) => (
              <tr key={v.version} className="border-b border-border/40 align-top last:border-0">
                <td className="px-2 py-1.5">v{v.version}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">{v.since}</td>
                <td className="px-2 py-1.5 text-muted-foreground">{v.playbook}</td>
                <td className={cn("px-2 py-1.5 text-right", v.enough ? "font-semibold" : "text-muted-foreground/70")}>{v.trades}{!v.enough && "*"}</td>
                <td className="px-2 py-1.5 text-right">{ratePct(v.win_rate)}</td>
                <td className={cn("px-2 py-1.5 text-right", tone(v.median_pct))}>{pctSigned(v.median_pct)}</td>
                <td className="px-2 py-1.5 text-[11px] text-muted-foreground">{v.changes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {c.by_version.some((v) => !v.enough) && <p className="mt-1 text-[11px] text-warning">* 不到 {minPer} 笔(或历史没载全),这个版本的读数单看没意义,也不拿来比较。</p>}
      {c.compare_blocked && <p className="mt-1 text-[11px] text-warning">版本样本不够或历史不完整,<b>暂不比较</b>:3 笔对 12 笔的「变差了」没有意义。</p>}
      {cmp && (
        <p className="mt-1 text-[12px]">
          v{cmp.from_version} → v{cmp.to_version}:胜率 <b className={tone(cmp.win_rate_delta)}>{rateDelta(cmp.win_rate_delta)}</b>,
          中位收益 <b className={tone(cmp.median_delta)}>{pctSigned(cmp.median_delta)}</b>
          <span className="ml-1 text-[11px] text-muted-foreground">(你自己的历史统计,不是对下一笔的预测)</span>
        </p>
      )}
      {c.before_card && c.before_card.trades > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          另有 {c.before_card.trades} 笔发生在建卡之前(胜率 {ratePct(c.before_card.win_rate)}、中位 {pctSigned(c.before_card.median_pct)}),<b>不进任何版本</b>:否则等于拿现在的规则评价更早的操作。
        </p>
      )}
    </div>
  );
}

export function ModesTab({ modes, playbooks, act }: { modes: Modes; playbooks: readonly string[]; act: Act }) {
  const [editing, setEditing] = useState<Draft | null>(null);
  const [msg, setMsg] = useState("");
  const remove = async (c: ModeCardPerf) => {
    if (!window.confirm(`删除模式卡「${c.name}」?\n\n它的 ${c.version_count} 个版本会一起删掉,按版本分段的统计不能恢复(交易记录本身不受影响)。`)) return;
    setMsg("");
    try {
      await act({ action: "mode_delete", card_id: c.id });
      if (editing?.card_id === c.id) setEditing(null);
    } catch (e) {
      setMsg(errText(e));
    }
  };
  return (
    <Panel title="我这套打法"
      hint="打法改过之后,改动前后的统计不能混在一起算:混了那个平均数谁都用不上。写下来并带版本,业绩就能按版本分段,回答「上次那个改动到底是好是坏」;也给「按计划」一个具体的参照。胜率不算持平,和「自我体检」同一口径。"
      actions={!editing && <button type="button" onClick={() => setEditing(blank(playbooks[0] ?? ""))} className={BTN}>+ 新建模式卡</button>}>
      {editing && <div className="mb-3"><Editor key={editing.card_id ?? "new"} draft={editing} playbooks={playbooks} act={act} onDone={() => setEditing(null)} /></div>}
      {msg && <p role="status" className="mb-2 text-[12px] text-destructive">{msg}</p>}
      {!modes.available ? <p className="text-[12px] text-muted-foreground">{modes.reason}。</p> : (
        <div className="space-y-3">
          <p className="text-[11px] leading-relaxed text-muted-foreground">{modes.note}</p>
          {modes.truncated && <p role="status" className="text-[11px] text-warning">只载入了最近一部分交易,历史样本不完整,暂停版本比较。</p>}
          {modes.cards.map((c) => (
            <CardView key={c.id} c={c} minPer={modes.min_per_version} onEdit={() => setEditing(draftOf(c))} onDelete={() => remove(c)} />
          ))}
        </div>
      )}
    </Panel>
  );
}
