/** 情绪复盘各分页共用的小件:加载中、没取到、缺口与来源、窗口选择 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ViewState } from "./useView";

export function ViewSlot<T>({ st, label, slow, children }: { st: ViewState<T>; label: string; slow?: string; children: (d: T) => ReactNode }) {
  if (st.state === "loading") {
    return (
      <div className="glass flex min-h-[10rem] flex-col items-center justify-center gap-1 p-6 text-center">
        <p role="status" className="text-sm text-muted-foreground">{label}加载中…</p>
        {slow && <p className="text-[11px] text-muted-foreground/70">{slow}</p>}
      </div>
    );
  }
  if (st.state === "failed") {
    return (
      <div className="glass p-6">
        <p role="status" className="text-sm text-muted-foreground">{label}这次没取到:{st.why || "原因不明"}。不代表没有,可点右上角刷新重试。</p>
      </div>
    );
  }
  return (
    <>
      {st.stale !== undefined && (
        <p role="status" className="mb-2 text-xs text-warning">{label}最近一次刷新没取到:{st.stale || "原因不明"}。下面是上一次取到的内容。</p>
      )}
      {children(st.data)}
    </>
  );
}

/** 缺口(哪些天没取到、哪项没算)和来源,放在每个分页最下面 */
export function GapsAndSource({ gaps, source }: { gaps: string[]; source: string }) {
  if (!gaps.length && !source) return null;
  return (
    <div className="space-y-1 text-[11px] leading-relaxed">
      {gaps.map((g) => <p key={g} role="status" className="text-warning">⚠️ {g}</p>)}
      {source && <p className="text-muted-foreground/70">来源:{source}</p>}
    </div>
  );
}

/** 看多少个交易日 */
export function WindowPicker({ value, options, onChange, label }: { value: number; options: number[]; onChange: (n: number) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex items-center gap-1 rounded-lg border border-border/60 p-0.5 text-xs">
      {options.map((n) => (
        <button key={n} type="button" aria-pressed={value === n} onClick={() => onChange(n)}
          className={cn("rounded-md px-2 py-0.5 tabular-nums", value === n ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:text-foreground")}>
          近 {n} 天
        </button>
      ))}
    </div>
  );
}
