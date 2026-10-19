/** 交易日志各分页共用的小件:面板、读数格、分组表、提示行、慢视图的加载与失败 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { hideIf } from "@/lib/privacy";
import { moneySigned, pctSigned, ratePct, tone, type Group } from "@/lib/journal";
import type { Load } from "./useJournal";

/** 少于这么多笔有盈亏,分组读数只是噪声(VA 同) */
export const SMALL_SAMPLE = 10;

export function Panel({ title, hint, actions, children, className }: { title: ReactNode; hint?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("glass p-4 sm:p-5", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {hint && <p className="mb-3 mt-1 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
      {!hint && <div className="mb-3" />}
      {children}
    </section>
  );
}

export function Tile({ k, v, sub, cls, title }: { k: string; v: string; sub?: ReactNode; cls?: string; title?: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/30 p-3" title={title}>
      <p className="text-[11px] text-muted-foreground">{k}</p>
      <p className={cn("mt-0.5 truncate font-mono text-base font-bold tabular-nums", cls)}>{v}</p>
      {sub && <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{sub}</p>}
    </div>
  );
}

/** 一组分组读数。净盈亏是金额,隐私模式遮;百分比不遮 */
export function GroupTable({ title, hint, groups, hide, empty }: { title: string; hint: string; groups: readonly Group[]; hide: boolean; empty?: string }) {
  const rows = groups.filter((g) => g.count > 0);
  return (
    <Panel title={title} hint={hint}>
      {!rows.length ? <p className="text-[12px] text-muted-foreground">{empty ?? "还没有可分组的交易"}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[460px] text-[12px] tabular-nums">
            <thead>
              <tr className="border-b border-border text-[11px] text-muted-foreground">
                <th className="py-1.5 pr-2 text-left font-normal">分组</th>
                <th className="px-2 py-1.5 text-right font-normal">笔数</th>
                <th className="px-2 py-1.5 text-right font-normal">平均每笔</th>
                <th className="px-2 py-1.5 text-right font-normal">胜率</th>
                <th className="px-2 py-1.5 text-right font-normal">最好 / 最差</th>
                <th className="px-2 py-1.5 text-right font-normal">净盈亏(元)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.key} className="border-b border-border/40 last:border-0">
                  <td className="py-1.5 pr-2 font-medium">{g.key}</td>
                  <td className="px-2 py-1.5 text-right">
                    {g.scored}/{g.count}
                    {g.scored > 0 && g.scored < SMALL_SAMPLE && <span className="ml-1 text-[10px] text-warning">样本少</span>}
                  </td>
                  <td className={cn("px-2 py-1.5 text-right font-semibold", tone(g.avg))}>{pctSigned(g.avg)}</td>
                  <td className="px-2 py-1.5 text-right">{ratePct(g.win_rate)}</td>
                  <td className="px-2 py-1.5 text-right">
                    <span className={tone(g.best)}>{pctSigned(g.best)}</span>
                    <span className="mx-1 text-muted-foreground">/</span>
                    <span className={tone(g.worst)}>{pctSigned(g.worst)}</span>
                  </td>
                  <td className={cn("px-2 py-1.5 text-right", tone(g.net_pnl))}>
                    {hideIf(hide, moneySigned(g.net_pnl))}
                    {g.net_pnl !== null && g.money_scored < g.count && <span className="ml-1 text-[10px] text-muted-foreground">{g.money_scored} 笔</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[10px] text-muted-foreground/80">笔数写成「有盈亏的 / 全部」;胜率不算持平;净盈亏只加有成交明细的、已卖出的部分。</p>
    </Panel>
  );
}

/** 一串提示:warn 黄色、muted 灰色 */
export function Notes({ items, kind = "muted" }: { items: readonly (string | null | undefined | false)[]; kind?: "warn" | "muted" }) {
  const xs = items.filter((x): x is string => typeof x === "string" && !!x.trim());
  if (!xs.length) return null;
  return (
    <div className={cn("space-y-1 text-[11px] leading-relaxed", kind === "warn" ? "text-warning" : "text-muted-foreground")}>
      {xs.map((x) => <p key={x} role={kind === "warn" ? "status" : undefined}>{kind === "warn" ? "⚠️ " : ""}{x}</p>)}
    </div>
  );
}

/** 慢视图的三种状态 */
export function Slot<T>({ st, label, slow, children }: { st: Load<T>; label: string; slow?: string; children: (d: T) => ReactNode }) {
  if (st.state === "loading") {
    return (
      <div className="glass flex min-h-[8rem] flex-col items-center justify-center gap-1 p-6 text-center">
        <p role="status" className="text-sm text-muted-foreground">{label}加载中…</p>
        {slow && <p className="text-[11px] text-muted-foreground/70">{slow}</p>}
      </div>
    );
  }
  if (st.state === "failed") {
    return <div className="glass p-5"><p role="status" className="text-sm text-muted-foreground">{label}这次没取到:{st.why || "原因不明"}。可点右上角刷新重试。</p></div>;
  }
  return <>{children(st.data)}</>;
}

/** 按计划 / 计划外 / 不填 三态切换 */
export function PlannedToggle({ value, onChange }: { value: boolean | null; onChange: (v: boolean | null) => void }) {
  return (
    <div role="group" aria-label="按不按计划" className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
      {([["按计划", true], ["计划外", false]] as const).map(([label, v]) => (
        <button key={label} type="button" aria-pressed={value === v} onClick={() => onChange(value === v ? null : v)}
          className={cn("rounded-md px-2 py-1 text-[12px] transition-colors", value === v ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:text-foreground")}>
          {label}
        </button>
      ))}
    </div>
  );
}

export const INPUT = "rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm outline-none focus:border-primary/60";
export const BTN = "inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50";
export const BTN_GHOST = "inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50";
