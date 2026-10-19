/** 交易日志 · 复查:值得回头看的单子、是不是总在高点前就跑了、看错了还是没执行好 */
import { useState } from "react";
import { cn } from "@/lib/utils";
import { hideIf } from "@/lib/privacy";
import {
  maskJournalText, moneySigned, pctSigned, ratePct, tone,
  type AttributionView, type ExcursionView, type Inbox, type Quadrant,
} from "@/lib/journal";
import { BTN_GHOST, Notes, Panel, Slot, Tile } from "./bits";
import type { Load } from "./useJournal";

function InboxPanel({ inbox, hide }: { inbox: Inbox; hide: boolean }) {
  const title = "值得回头看一眼的";
  if (!inbox.available) return <Panel title={title}><p className="text-[12px] text-muted-foreground">{inbox.reason}。</p></Panel>;
  return (
    <Panel title={<>{title}<span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">{inbox.count} / {inbox.scanned} 笔</span></>}
      hint={inbox.note}>
      <Notes kind="warn" items={[
        !inbox.baseline.history_enough && `交易还不到 ${inbox.baseline.min_history} 笔,「和自己的习惯比」那几类暂时不查:几笔的中位数不是习惯。`,
        inbox.rules_is_default && "规矩还是初值,「超过自己的规矩」那几类按初值查的。",
        inbox.excursion_hint,
      ]} />
      {!inbox.items.length ? <p className="mt-2 text-[12px] text-muted-foreground">最近的单子里没有特别不寻常的。</p> : (
        <div className="mt-2 max-h-[28rem] space-y-2 overflow-y-auto">
          {inbox.items.map((it) => (
            <div key={it.key} className="rounded-lg border border-border bg-muted/10 p-2.5">
              <div className="flex flex-wrap items-baseline gap-2 text-[12px]">
                <span className="tabular-nums text-muted-foreground">{it.date}</span>
                <b>{it.name || it.symbol}</b>
                {it.playbook && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{it.playbook}</span>}
                <span className={cn("font-semibold tabular-nums", tone(it.pnl_pct))}>{pctSigned(it.pnl_pct)}</span>
                {!it.closed && <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">还在手上</span>}
              </div>
              <ul className="mt-1 space-y-0.5">
                {it.flags.map((f) => <li key={f.key} className="text-[11px] text-muted-foreground">· {maskJournalText(f.text, hide)}</li>)}
              </ul>
              {it.note && <p className="mt-1 text-[11px] text-muted-foreground/80">备注:{it.note}</p>}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function ExcursionPanel({ st }: { st: Load<ExcursionView> }) {
  const [open, setOpen] = useState(false);
  const title = "是不是总在最高点前就跑了";
  const hint = "结果只说了终点。最大浮盈 = 这笔最多曾赚到多少,最大浮亏 = 最多曾亏到多少,都按持有期的日线高低价算,是区间的边界,不代表盘中真能按那个价成交。";
  return (
    <Slot st={st} label="最大浮盈浮亏" slow="第一次要逐笔取日线,可能要一会儿;取过的会缓存">
      {(x) => {
        const foot = <Notes items={[x.not_counted_note && `没算进来:${x.not_counted_note}。`, x.intraday_note]} />;
        if (!x.available) return <Panel title={title} hint={hint}><p className="mb-2 text-[12px] text-muted-foreground">{x.reason}。</p>{foot}</Panel>;
        return (
          <Panel title={title} hint={hint}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile k="捕获率中位数" v={ratePct(x.median_capture_rate)} sub={`${x.capture_samples} 笔有过浮盈`} />
              <Tile k="盈利回吐中位数" v={pctSigned(x.median_give_back)} cls="text-warning" />
              <Tile k="最大浮亏中位数" v={pctSigned(x.median_mae)} cls={tone(x.median_mae)} />
              <Tile k="进场就不对 / 深亏扛回来" v={`${x.bad_entry_count} / ${x.endured_count}`} sub={x.same_day_count ? `${x.same_day_count} 笔同日进出` : undefined} />
            </div>
            {x.capture_note && <p className="mt-3 border-t border-border pt-2.5 text-[11px] leading-relaxed text-warning">{x.capture_note}</p>}
            <p className="mt-3 border-t border-border pt-2.5 text-[11px] leading-relaxed text-warning">{x.bias_note}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{x.caveat}</p>
            {!x.enough_samples && <p role="status" className="mt-1 text-[11px] font-semibold text-warning">只有 {x.trades} 笔,样本太少,别下结论。</p>}
            <div className="mt-1">{foot}</div>
            <button type="button" onClick={() => setOpen((o) => !o)} className={cn(BTN_GHOST, "mt-2")}>{open ? "收起逐笔" : `看逐笔(${x.items.length} 笔)`}</button>
            {open && (
              <div className="mt-2 max-h-80 overflow-auto">
                <table className="w-full min-w-[640px] text-[12px] tabular-nums">
                  <thead>
                    <tr className="border-b border-border text-[11px] text-muted-foreground">
                      {["买入 → 卖出", "标的", "落袋", "最大浮盈", "最大浮亏", "回吐", "捕获", "精度"].map((h, i) => (
                        <th key={h} className={cn("px-2 py-1.5 font-normal", i < 2 || i === 7 ? "text-left" : "text-right")}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {x.items.map((r) => (
                      <tr key={r.key} className="border-b border-border/40 last:border-0">
                        <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">{r.date}{r.exit_date !== r.date && ` → ${r.exit_date}`}</td>
                        <td className="px-2 py-1.5">{r.name || r.symbol}</td>
                        <td className={cn("px-2 py-1.5 text-right font-semibold", tone(r.realized_pct))}>{pctSigned(r.realized_pct)}</td>
                        {/* 最大浮盈可能是负数:那段最高价从没超过成本,不能写成「+-」也不能涂成涨色 */}
                        <td className={cn("px-2 py-1.5 text-right", r.mfe_pct > 0 ? "text-danger" : "text-muted-foreground")}>
                          {pctSigned(r.mfe_pct)}
                          {r.mfe_certain !== null && <span className="ml-0.5 text-[10px] text-muted-foreground/70" title="确定赚到过(只算中间完整交易日)">≥{r.mfe_certain}</span>}
                        </td>
                        <td className={cn("px-2 py-1.5 text-right", tone(r.mae_pct))} title={r.certain_note ?? undefined}>{pctSigned(r.mae_pct)}</td>
                        <td className="px-2 py-1.5 text-right text-warning">{pctSigned(r.give_back_pct)}</td>
                        <td className={cn("px-2 py-1.5 text-right", (r.capture_rate ?? 0) < 0 && "text-success")} title={r.capture_note ?? undefined}>{ratePct(r.capture_rate)}</td>
                        <td className={cn("px-2 py-1.5 text-[10px]", r.bars_inner > 0 ? "text-muted-foreground/80" : "text-warning")} title={r.precision}>
                          {r.bars_inner > 0 ? `中间 ${r.bars_inner} 天可靠` : r.same_day ? "同日 · 只有上界" : "相邻两天 · 只有上界"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {x.failures.length > 0 && (
              <details className="mt-2 text-[11px] text-muted-foreground">
                <summary className="cursor-pointer">没取到行情的 {x.failures.length} 笔</summary>
                <ul className="mt-1 space-y-0.5">{x.failures.map((f) => <li key={f.key}>{f.date} {f.name || f.symbol}:{f.why}</li>)}</ul>
              </details>
            )}
          </Panel>
        );
      }}
    </Slot>
  );
}

const CELLS: { key: Quadrant; tag?: string; tint: string }[] = [
  { key: "right_win", tint: "border-border bg-muted/20" },
  { key: "right_lose", tag: "执行问题", tint: "border-warning/40 bg-warning/10" },
  { key: "wrong_win", tag: "运气", tint: "border-warning/40 bg-warning/10" },
  { key: "wrong_lose", tag: "判断问题", tint: "border-border bg-muted/20" },
];

function AttributionPanel({ st, hide }: { st: Load<AttributionView>; hide: boolean }) {
  const title = "看错了,还是没执行好";
  const hint = "把「前一晚写给下一场的验证条件成立没成立」和「那天自己赚没赚」交叉起来。看对了却亏钱和看错了才亏钱是两个病:一个要改执行,一个要改读盘。";
  return (
    <Slot st={st} label="判断与执行归因">
      {(a) => {
        const skips = [
          a.skipped_no_read ? `${a.skipped_no_read} 笔那天前一晚没写验证条件(或还没对账),没算进来` : null,
          a.skipped_undecided ? `${a.skipped_undecided} 笔那天的条件一半成立一半不成立,不算判对也不算判错` : null,
          a.skipped_no_amount ? `${a.skipped_no_amount} 笔没有成交明细或还没卖,算不出金额` : null,
        ];
        if (!a.available) return <Panel title={title} hint={hint}><p className="mb-2 text-[12px] text-muted-foreground">{a.reason}。</p><Notes items={skips} /><Notes kind="warn" items={a.gaps ?? []} /></Panel>;
        return (
          <Panel title={title} hint={<>{hint} {a.note}</>}>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {CELLS.map((c) => {
                const q = a.quadrants[c.key];
                return (
                  <div key={c.key} className={cn("rounded-lg border p-3", q.days > 0 ? c.tint : "border-border bg-muted/10")}>
                    <div className="flex flex-wrap items-baseline gap-1.5">
                      <span className="text-[12px] font-semibold">{a.quadrant_labels[c.key]}</span>
                      {c.tag && q.days > 0 && <span className="text-[10px] text-warning">{c.tag}</span>}
                    </div>
                    <div className="mt-1 flex items-baseline gap-2">
                      <span className={cn("text-lg font-bold tabular-nums", !q.days && "text-muted-foreground/50")}>{q.days}</span>
                      <span className="text-[11px] text-muted-foreground">天</span>
                      {q.days > 0 && <span className={cn("text-[12px] font-semibold tabular-nums", tone(q.pnl))}>{hideIf(hide, moneySigned(q.pnl))} 元</span>}
                    </div>
                    {q.days > 0 && <p className="mt-1 text-[10px] text-muted-foreground/80">{q.days_list.slice(-6).join("、")}{q.days_list.length > 6 && " 等"}</p>}
                  </div>
                );
              })}
            </div>
            <p className="mt-2.5 text-[11px] text-muted-foreground">
              共 {a.days_counted} 个有盈亏的交易日({a.window.from} 至 {a.window.to})
              {!a.enough_samples && <b className="text-warning"> · 不到 {a.min_days} 天,样本太少,别急着下结论</b>}
            </p>
            <Notes items={skips} />
            <Notes kind="warn" items={a.gaps} />
          </Panel>
        );
      }}
    </Slot>
  );
}

export function ReviewTab({ inbox, excursion, attribution, hide }: { inbox: Inbox; excursion: Load<ExcursionView>; attribution: Load<AttributionView>; hide: boolean }) {
  return (
    <div className="space-y-4">
      <InboxPanel inbox={inbox} hide={hide} />
      <ExcursionPanel st={excursion} />
      <AttributionPanel st={attribution} hide={hide} />
    </div>
  );
}
