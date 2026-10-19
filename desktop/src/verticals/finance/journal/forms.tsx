/**
 * 交易日志的录入和设置表单:记一笔、改标注、改补记、补成交、费率、规矩、账户规模。
 * 🔴 改标注是「整条换掉」:没传的字段会被清空,所以编辑框总是把要保留的字段全部带上。
 */
import { useState, type ReactNode } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { hideIf, maskPrivateText } from "@/lib/privacy";
import {
  fillsPayload, parseNum, ruleValueText, sharesText,
  type FeeKey, type FillDraft, type JournalRow, type JournalSettings, type RuleKey,
} from "@/lib/journal";
import { BTN, BTN_GHOST, INPUT, PlannedToggle } from "./bits";
import { errText, type JournalAction } from "./useJournal";

export type Act = (body: JournalAction) => Promise<unknown>;

const A_SHARE = /^\d{6}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Msg = { ok: boolean; text: string } | null;

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const run = async (fn: () => Promise<unknown>, okText: string): Promise<boolean> => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: okText });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, msg, setMsg, run };
}

function MsgLine({ m, hide = false }: { m: Msg; hide?: boolean }) {
  if (!m) return null;
  // 后端的报错会带上股数(「卖出 300 股超过…」),隐私模式下按措辞遮
  return <p role="status" className={cn("text-[12px]", m.ok ? "text-muted-foreground" : "text-destructive")}>{hide ? maskPrivateText(m.text) : m.text}</p>;
}

/**
 * 自己的成交价、股数、费用、计划价位的输入框:隐私模式下换成密码样式,录屏时不露原值
 * (照常能输入,存的还是原值)。切换隐私模式时跟着变。
 */
const secret = (hide: boolean) => ({ type: hide ? "password" : "text", autoComplete: "off" }) as const;

function SubmitBtn({ busy, children, onClick }: { busy: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={busy} className={BTN}>
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{children}
    </button>
  );
}

/** 选填的价格:空 = 不填;填了要是正数 */
function optPrice(s: string, label: string): number | null {
  const v = parseNum(s);
  if (v === null) return null;
  if (v === undefined || v <= 0) throw new Error(`${label}要是大于 0 的数`);
  return v;
}

/** 打法 / 按计划 / 备注:只带填了的(后端不收空值) */
function tagBody(playbook: string, planned: boolean | null, note: string): Record<string, unknown> {
  return {
    ...(playbook ? { playbook } : {}),
    ...(planned !== null ? { as_planned: planned } : {}),
    ...(note.trim() ? { note: note.trim() } : {}),
  };
}

function PlaybookSelect({ value, onChange, playbooks, label = "打法" }: { value: string; onChange: (v: string) => void; playbooks: readonly string[]; label?: string }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={INPUT}>
      <option value="">打法(不填)</option>
      {playbooks.map((p) => <option key={p} value={p}>{p}</option>)}
    </select>
  );
}

const emptyFill = (type: "buy" | "sell", date: string): FillDraft => ({ type, date, price: "", shares: "", fee: "" });

function FillRows({ fills, hide, onChange }: { fills: FillDraft[]; hide: boolean; onChange: (f: FillDraft[]) => void }) {
  const set = (i: number, patch: Partial<FillDraft>) => onChange(fills.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <div className="space-y-1.5">
      {fills.map((f, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5">
          <span className={cn("w-9 rounded px-1.5 py-1 text-center text-[11px] font-bold", f.type === "buy" ? "bg-danger/15 text-danger" : "bg-success/15 text-success")}>
            {f.type === "buy" ? "买" : "卖"}
          </span>
          <input type="date" aria-label={`第 ${i + 1} 笔成交日期`} value={f.date} onChange={(e) => set(i, { date: e.target.value })} className={cn(INPUT, "py-1 text-[12px]")} />
          <input {...secret(hide)} inputMode="decimal" aria-label={`第 ${i + 1} 笔成交价`} placeholder="成交价" value={f.price} onChange={(e) => set(i, { price: e.target.value })} className={cn(INPUT, "w-24 py-1 text-[12px]")} />
          <input {...secret(hide)} inputMode="numeric" aria-label={`第 ${i + 1} 笔股数`} placeholder="股数" value={f.shares} onChange={(e) => set(i, { shares: e.target.value })} className={cn(INPUT, "w-24 py-1 text-[12px]")} />
          <input {...secret(hide)} inputMode="decimal" aria-label={`第 ${i + 1} 笔费用`} placeholder="费用(不填按费率估)" value={f.fee} onChange={(e) => set(i, { fee: e.target.value })} className={cn(INPUT, "w-36 py-1 text-[12px]")} />
          <button type="button" aria-label={`删掉第 ${i + 1} 笔`} onClick={() => onChange(fills.filter((_, j) => j !== i))} className="p-1 text-muted-foreground/60 hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * 记一笔。两种:有成交明细(写进交易流水,盈亏按流水扣费算)/ 只记盈亏%(补记,不进持仓)。
 * 打法默认不填:VA 默认「打板」,不改就会把低吸记成打板。
 */
export function RecordForm({ today, playbooks, openShares, hide, act }: {
  today: string; playbooks: readonly string[]; hide: boolean; act: Act;
  /** 这只票还没卖完的股数(没有 = undefined):新成交会并进那一笔 */
  openShares: (symbol: string) => number | undefined;
}) {
  const [mode, setMode] = useState<"fills" | "manual">("fills");
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [playbook, setPlaybook] = useState("");
  const [planned, setPlanned] = useState<boolean | null>(null);
  const [note, setNote] = useState("");
  const [date, setDate] = useState(today);
  const [pnl, setPnl] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [fills, setFills] = useState<FillDraft[]>([emptyFill("buy", today)]);
  const { busy, msg, setMsg, run } = useSubmit();
  const code = symbol.trim();
  const open = A_SHARE.test(code) ? openShares(code) : undefined;

  const reset = () => {
    setSymbol(""); setName(""); setPlaybook(""); setPlanned(null); setNote(""); setPnl(""); setStop(""); setTarget("");
    setFills([emptyFill("buy", today)]);
  };

  const submit = async () => {
    if (!A_SHARE.test(code)) { setMsg({ ok: false, text: "代码要是 6 位数字(交易日志只管 A 股)" }); return; }
    let body: JournalAction;
    try {
      const tags = tagBody(playbook, planned, note);
      if (mode === "fills") {
        const f = fillsPayload(fills);
        if ("error" in f) throw new Error(f.error);
        const s = optPrice(stop, "计划止损价"), t = optPrice(target, "计划目标价");
        const plan = { ...(s !== null ? { planned_stop: s } : {}), ...(t !== null ? { planned_target: t } : {}) };
        // 🔴 并进还没卖完的那一笔时,带标注会把那一笔原来的标注整条换掉
        if (open !== undefined && Object.keys({ ...tags, ...plan }).length) {
          throw new Error("这只股票还有一笔没卖完,新成交会并进那一笔。只填成交再记;打法、备注、止损在下面交易记录里用「编辑标注」改");
        }
        body = { action: "record", symbol: code, ...(name.trim() ? { name: name.trim() } : {}), fills: f.fills, ...tags, ...plan };
      } else {
        if (!DAY.test(date)) throw new Error("日期没填");
        const p = parseNum(pnl);
        if (p === undefined) throw new Error("盈亏% 要是数字,例如 3.2 或 -5");
        body = { action: "manual", symbol: code, date, ...(name.trim() ? { name: name.trim() } : {}), ...tags, ...(p !== null ? { pnl_pct: p } : {}) };
      }
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
      return;
    }
    if (await run(() => act(body), mode === "fills" ? "已记录,成交也进了「我的股票」的交易流水" : "已补记")) reset();
  };

  return (
    <div className="space-y-3">
      <div role="group" aria-label="记哪一种" className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
        {([["fills", "有成交明细"], ["manual", "只记盈亏%"]] as const).map(([k, label]) => (
          <button key={k} type="button" aria-pressed={mode === k} onClick={() => { setMode(k); setMsg(null); }}
            className={cn("rounded-md px-2.5 py-1 text-[12px]", mode === k ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:text-foreground")}>
            {label}
          </button>
        ))}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {mode === "fills"
          ? "成交会写进「我的股票」的交易流水,盈亏按流水扣掉佣金、印花税、过户费算(费用不填就按页面底部的费率估);成交要改要删也去那里。"
          : "没有成交明细时用这个:只记一个盈亏百分比,参与胜率、平均每笔这些统计,不算金额、不进持仓。"}
      </p>
      <div className="flex flex-wrap gap-2">
        {mode === "manual" && <input type="date" aria-label="日期" value={date} onChange={(e) => setDate(e.target.value)} className={INPUT} />}
        <input aria-label="代码" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="代码 如 002879" inputMode="numeric" className={cn(INPUT, "w-32")} />
        <input aria-label="简称" value={name} onChange={(e) => setName(e.target.value)} placeholder="简称(可选)" className={cn(INPUT, "w-32")} />
        <PlaybookSelect value={playbook} onChange={setPlaybook} playbooks={playbooks} />
        {mode === "manual" && <input aria-label="盈亏%" value={pnl} onChange={(e) => setPnl(e.target.value)} placeholder="盈亏% 如 3.2 / -5" className={cn(INPUT, "w-32")} />}
        <PlannedToggle value={planned} onChange={setPlanned} />
      </div>
      <input aria-label="备注" value={note} onChange={(e) => setNote(e.target.value)} placeholder="当时为什么做这笔(复盘时最值钱的一栏)" className={cn(INPUT, "w-full")} />
      {open !== undefined && mode === "fills" && (
        <p className="text-[11px] text-warning">这只股票还有 {hideIf(hide, sharesText(open))} 股没卖完:新成交会并进那一笔。</p>
      )}
      {mode === "fills" && (
        <>
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3 text-[12px]">
            <span className="font-semibold">计划退出</span>
            <span className="text-[11px] text-muted-foreground">下单时就想好的价位(在险资金按计划止损算;事后补的会标出来)</span>
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">亏到</span>
              <input {...secret(hide)} inputMode="decimal" aria-label="计划止损价" value={stop} onChange={(e) => setStop(e.target.value)} placeholder="止损价" className={cn(INPUT, "w-24 py-1 text-right text-[12px]")} />
              <span className="text-muted-foreground">就走</span>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">赚到</span>
              <input {...secret(hide)} inputMode="decimal" aria-label="计划目标价" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="目标价(可选)" className={cn(INPUT, "w-28 py-1 text-right text-[12px]")} />
              <span className="text-muted-foreground">就走</span>
            </label>
          </div>
          <div className="space-y-2 border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-semibold">成交明细</span>
              <span className="text-[11px] text-muted-foreground">同一笔交易的几次买卖一起记(分批、隔日卖都行);中间卖光过的要分开记。</span>
              <button type="button" onClick={() => setFills([...fills, emptyFill("buy", today)])} className="rounded border border-danger/40 px-2 py-0.5 text-[11px] text-danger hover:bg-danger/10">+ 买入</button>
              <button type="button" onClick={() => setFills([...fills, emptyFill("sell", today)])} className="rounded border border-success/40 px-2 py-0.5 text-[11px] text-success hover:bg-success/10">+ 卖出</button>
            </div>
            <FillRows fills={fills} hide={hide} onChange={setFills} />
          </div>
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <SubmitBtn busy={busy} onClick={submit}>记录</SubmitBtn>
        <MsgLine m={msg} hide={hide} />
      </div>
    </div>
  );
}

/** 改有成交明细那一笔的标注:打法、按计划、备注、计划止损 / 目标(整条换掉) */
export function TagEditor({ row, playbooks, hide, act, onDone }: { row: JournalRow; playbooks: readonly string[]; hide: boolean; act: Act; onDone: () => void }) {
  const [playbook, setPlaybook] = useState(row.playbook ?? "");
  const [planned, setPlanned] = useState<boolean | null>(row.as_planned);
  const [note, setNote] = useState(row.note);
  const [stop, setStop] = useState(row.planned_stop === null ? "" : String(row.planned_stop));
  const [target, setTarget] = useState(row.planned_target === null ? "" : String(row.planned_target));
  const { busy, msg, setMsg, run } = useSubmit();
  const submit = async () => {
    let body: JournalAction;
    try {
      const s = optPrice(stop, "计划止损价"), t = optPrice(target, "计划目标价");
      body = { action: "tag", trade_id: row.key, ...tagBody(playbook, planned, note), ...(s !== null ? { planned_stop: s } : {}), ...(t !== null ? { planned_target: t } : {}) };
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
      return;
    }
    if (await run(() => act(body), "已保存")) onDone();
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-semibold">编辑标注</span>
        <PlaybookSelect value={playbook} onChange={setPlaybook} playbooks={playbooks} />
        <PlannedToggle value={planned} onChange={setPlanned} />
        <label className="flex items-center gap-1.5 text-[12px]">
          <span className="text-muted-foreground">止损</span>
          <input {...secret(hide)} inputMode="decimal" aria-label="计划止损价" value={stop} onChange={(e) => setStop(e.target.value)} className={cn(INPUT, "w-24 py-1 text-right text-[12px]")} />
        </label>
        <label className="flex items-center gap-1.5 text-[12px]">
          <span className="text-muted-foreground">目标</span>
          <input {...secret(hide)} inputMode="decimal" aria-label="计划目标价" value={target} onChange={(e) => setTarget(e.target.value)} className={cn(INPUT, "w-24 py-1 text-right text-[12px]")} />
        </label>
      </div>
      <input aria-label="备注" value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注" className={cn(INPUT, "w-full")} />
      <p className="text-[11px] text-muted-foreground">清空的栏会被删掉。止损 / 目标改了会按今天重新记时间;建仓后才写的会标「事后补」。</p>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitBtn busy={busy} onClick={submit}>保存</SubmitBtn>
        <button type="button" onClick={onDone} className={BTN_GHOST}>取消</button>
        <MsgLine m={msg} hide={hide} />
      </div>
    </div>
  );
}

/** 改一条补记(整条换掉) */
export function ManualEditor({ row, playbooks, act, onDone }: { row: JournalRow; playbooks: readonly string[]; act: Act; onDone: () => void }) {
  const [date, setDate] = useState(row.date);
  const [name, setName] = useState(row.name);
  const [playbook, setPlaybook] = useState(row.playbook ?? "");
  const [planned, setPlanned] = useState<boolean | null>(row.as_planned);
  const [note, setNote] = useState(row.note);
  const [pnl, setPnl] = useState(row.pnl_pct === null ? "" : String(row.pnl_pct));
  const { busy, msg, setMsg, run } = useSubmit();
  const submit = async () => {
    const p = parseNum(pnl);
    if (!DAY.test(date)) { setMsg({ ok: false, text: "日期没填" }); return; }
    if (p === undefined) { setMsg({ ok: false, text: "盈亏% 要是数字" }); return; }
    const body: JournalAction = {
      action: "manual", id: row.tag_id, symbol: row.symbol, date, ...(name.trim() ? { name: name.trim() } : {}),
      ...tagBody(playbook, planned, note), ...(p !== null ? { pnl_pct: p } : {}),
    };
    if (await run(() => act(body), "已保存")) onDone();
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-semibold">改补记</span>
        <input type="date" aria-label="日期" value={date} onChange={(e) => setDate(e.target.value)} className={cn(INPUT, "py-1 text-[12px]")} />
        <input aria-label="简称" value={name} onChange={(e) => setName(e.target.value)} placeholder="简称" className={cn(INPUT, "w-28 py-1 text-[12px]")} />
        <PlaybookSelect value={playbook} onChange={setPlaybook} playbooks={playbooks} />
        <input aria-label="盈亏%" value={pnl} onChange={(e) => setPnl(e.target.value)} placeholder="盈亏%" className={cn(INPUT, "w-24 py-1 text-[12px]")} />
        <PlannedToggle value={planned} onChange={setPlanned} />
      </div>
      <input aria-label="备注" value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注" className={cn(INPUT, "w-full")} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitBtn busy={busy} onClick={submit}>保存</SubmitBtn>
        <button type="button" onClick={onDone} className={BTN_GHOST}>取消</button>
        <MsgLine m={msg} />
      </div>
    </div>
  );
}

/** 给还没卖完的那一笔补一次卖出 / 加仓。不带标注字段:标注原样保留 */
export function AppendFill({ row, today, hide, act, onDone }: { row: JournalRow; today: string; hide: boolean; act: Act; onDone: () => void }) {
  const open = row.episode?.open_shares ?? 0;
  const [fill, setFill] = useState<FillDraft>(emptyFill("sell", today));
  const { busy, msg, setMsg, run } = useSubmit();
  const submit = async () => {
    const f = fillsPayload([fill]);
    if ("error" in f) { setMsg({ ok: false, text: f.error.replace("第 1 笔成交:", "") }); return; }
    if (await run(() => act({ action: "record", symbol: row.symbol, ...(row.name ? { name: row.name } : {}), fills: f.fills }), "已补上")) onDone();
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      <span className="font-semibold">补一笔成交</span>
      <span className="text-muted-foreground">现在还有 {hideIf(hide, sharesText(open))} 股</span>
      <div role="group" aria-label="买还是卖" className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
        {(["sell", "buy"] as const).map((v) => (
          <button key={v} type="button" aria-pressed={fill.type === v} onClick={() => setFill({ ...fill, type: v })}
            className={cn("rounded-md px-2 py-1 text-[11px]", fill.type === v ? (v === "sell" ? "bg-success/15 text-success" : "bg-danger/15 text-danger") : "text-muted-foreground hover:text-foreground")}>
            {v === "sell" ? "卖出" : "加仓"}
          </button>
        ))}
      </div>
      <input type="date" aria-label="成交日期" value={fill.date} onChange={(e) => setFill({ ...fill, date: e.target.value })} className={cn(INPUT, "py-1 text-[12px]")} />
      <input {...secret(hide)} inputMode="decimal" aria-label="成交价" placeholder="成交价" value={fill.price} onChange={(e) => setFill({ ...fill, price: e.target.value })} className={cn(INPUT, "w-24 py-1 text-[12px]")} />
      <input {...secret(hide)} inputMode="numeric" aria-label="股数" placeholder="股数" value={fill.shares} onChange={(e) => setFill({ ...fill, shares: e.target.value })} className={cn(INPUT, "w-24 py-1 text-[12px]")} />
      {fill.type === "sell" && open > 0 && (
        <button type="button" onClick={() => setFill({ ...fill, shares: String(open) })} className="text-[11px] text-primary hover:underline">全部</button>
      )}
      <input {...secret(hide)} inputMode="decimal" aria-label="费用" placeholder="费用(可不填)" value={fill.fee} onChange={(e) => setFill({ ...fill, fee: e.target.value })} className={cn(INPUT, "w-28 py-1 text-[12px]")} />
      <SubmitBtn busy={busy} onClick={submit}>保存</SubmitBtn>
      <button type="button" onClick={onDone} className={BTN_GHOST}>取消</button>
      <span className="text-[11px] text-muted-foreground/70">建仓日期和下单时写的计划止损都原样保留</span>
      <MsgLine m={msg} hide={hide} />
    </div>
  );
}

const FEE_KEYS: FeeKey[] = ["commission_rate", "commission_min", "stamp_tax_rate", "transfer_fee_rate"];

/** 交易费率。初值只是能跑起来的数,不是推荐值,也不是你的真实费率 */
export function FeeSettings({ settings, act }: { settings: JournalSettings; act: Act }) {
  const start = (k: FeeKey) => {
    const v = settings.fees?.[k] ?? settings.raw?.[k];
    return typeof v === "number" ? String(v) : "";
  };
  const [draft, setDraft] = useState<Record<FeeKey, string>>(() => Object.fromEntries(FEE_KEYS.map((k) => [k, start(k)])) as Record<FeeKey, string>);
  const { busy, msg, setMsg, run } = useSubmit();
  const save = async () => {
    const fees: Partial<Record<FeeKey, number>> = {};
    for (const k of FEE_KEYS) {
      const v = parseNum(draft[k]);
      if (v === null || v === undefined || v < 0) { setMsg({ ok: false, text: `${settings.labels.fees[k]} 要填不小于 0 的数` }); return; }
      fees[k] = v;
    }
    await run(() => act({ action: "settings", fees }), "费率已保存,盈亏已按新费率重算");
  };
  const restore = async () => {
    if (!window.confirm("把费率改回初值?初值不是你的真实费率,统计会带着偏差。")) return;
    if (await run(() => act({ action: "settings", fees: null }), "已改回初值")) {
      setDraft(Object.fromEntries(FEE_KEYS.map((k) => [k, String(settings.defaults.fees[k])])) as Record<FeeKey, string>);
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">交易费率</h3>
        {settings.fees_default && <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">还在用初值</span>}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        所有盈亏都按净额算:毛盈亏 − 佣金 − 印花税 − 过户费。成交里填了实际费用的以那个为准,没填的按这里估(列表里标「费估」)。
        对高换手的短线打法,费用不是小数:一堆薄利交易扣完费可能接近持平甚至转亏。初值不是推荐值,改成自己券商的真实费率。
      </p>
      <div className="flex flex-wrap gap-3">
        {FEE_KEYS.map((k) => (
          <label key={k} className="flex items-center gap-1.5 text-[12px]">
            <span className="text-muted-foreground">{settings.labels.fees[k]}</span>
            <input inputMode="decimal" aria-label={settings.labels.fees[k]} value={draft[k]} disabled={busy}
              onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} className={cn(INPUT, "w-28 py-1 text-right text-[12px]")} />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitBtn busy={busy} onClick={save}>保存费率</SubmitBtn>
        {!settings.fees_default && <button type="button" onClick={restore} disabled={busy} className={BTN_GHOST}>改回初值</button>}
        <MsgLine m={msg} />
      </div>
      <p className="text-[11px] text-muted-foreground/70">万 2.5 填 0.00025;印花税 0.05% 填 0.0005;最低佣金按元填。</p>
    </div>
  );
}

const RULE_KEYS: RuleKey[] = ["max_loss_per_trade_pct", "max_loss_per_day_pct", "max_positions", "max_trades_per_day", "pause_after_losses", "max_unplanned_ratio"];
const RULE_UNIT: Record<RuleKey, string> = {
  max_loss_per_trade_pct: "%", max_loss_per_day_pct: "%(占账户)", max_positions: "只", max_trades_per_day: "笔", pause_after_losses: "笔", max_unplanned_ratio: "(0~1)",
};

/** 自己的规矩。这些数是用户自己的规矩,不是推荐值;系统只照着检查 */
export function RulesEditor({ settings, act, onDone }: { settings: JournalSettings; act: Act; onDone?: () => void }) {
  const [draft, setDraft] = useState<Record<RuleKey, string>>(() => Object.fromEntries(RULE_KEYS.map((k) => [k, String(settings.rules[k])])) as Record<RuleKey, string>);
  const { busy, msg, setMsg, run } = useSubmit();
  const save = async () => {
    const rules: Partial<Record<RuleKey, number>> = {};
    for (const k of RULE_KEYS) {
      const v = parseNum(draft[k]);
      if (v === null || v === undefined) { setMsg({ ok: false, text: `${settings.labels.rules[k]} 要填数字` }); return; }
      rules[k] = v;
    }
    if (await run(() => act({ action: "settings", rules }), "规矩已保存")) onDone?.();
  };
  const restore = async () => {
    if (await run(() => act({ action: "settings", rules: Object.fromEntries(RULE_KEYS.map((k) => [k, null])) }), "已改回初值")) {
      setDraft(Object.fromEntries(RULE_KEYS.map((k) => [k, String(settings.defaults.rules[k])])) as Record<RuleKey, string>);
    }
  };
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        这些数是<b className="text-foreground">你自己的规矩</b>,不是推荐值:资金量和打法不同,合理的数差得远。按自己的习惯填,系统只照着检查。
      </p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {RULE_KEYS.map((k) => (
          <label key={k} className="flex items-center justify-between gap-2 text-[12px]">
            <span className="text-muted-foreground">{settings.labels.rules[k]}</span>
            <span className="flex items-center gap-1">
              <input inputMode="decimal" aria-label={settings.labels.rules[k]} value={draft[k]} disabled={busy}
                onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} className={cn(INPUT, "w-20 py-1 text-right text-[12px]")} />
              <span className="w-16 text-[11px] text-muted-foreground">{RULE_UNIT[k]}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitBtn busy={busy} onClick={save}>保存我的规矩</SubmitBtn>
        {!settings.rules_default && <button type="button" onClick={restore} disabled={busy} className={BTN_GHOST}>改回初值</button>}
        <MsgLine m={msg} />
      </div>
      <p className="text-[11px] text-muted-foreground/70">
        初值:{RULE_KEYS.map((k) => `${settings.labels.rules[k]} ${ruleValueText(k, settings.defaults.rules[k])}`).join(" · ")}
      </p>
    </div>
  );
}

/** 账户规模:填了才算「占账户百分之几」;不填绝不拿别的数代替 */
export function EquityBaseEditor({ value, hide, hint, act }: { value: number | null; hide: boolean; hint: string | null; act: Act }) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const { busy, msg, setMsg, run } = useSubmit();
  const save = async () => {
    const v = parseNum(draft);
    if (v === undefined || (v !== null && v <= 0)) { setMsg({ ok: false, text: "账户规模要是大于 0 的数(元)" }); return; }
    await run(() => act({ action: "settings", equity_base: v }), v === null ? "已清掉账户规模" : "已保存");
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5 text-[12px]">
      <span className="text-muted-foreground">账户规模(元)</span>
      <input {...secret(hide)} inputMode="decimal" aria-label="账户规模" value={draft} onChange={(e) => setDraft(e.target.value)}
        placeholder="填了才有占比" className={cn(INPUT, "w-32 py-1 text-right text-[12px]")} />
      <SubmitBtn busy={busy} onClick={save}>保存</SubmitBtn>
      <MsgLine m={msg} hide={hide} />
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}
