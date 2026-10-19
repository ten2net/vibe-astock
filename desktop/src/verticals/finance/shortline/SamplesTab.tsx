/**
 * 情绪复盘 · 涨停样本:前一天涨停的票,第二天收盘表现的历史统计(按打法、按封板时间、按入场那天的情绪强弱分开)。
 * 移植自 Vibe AStock v2.0.0 的「历史统计」页,事后名单的警告原样保留、不弱化;
 * 和 VA 的不同:最好 / 最差按红涨绿跌上色(VA 那里写反了)。
 */
import { useState } from "react";
import { Clock3, Info, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAiPage } from "../../../core/ai/pageContext";
import { Section } from "./FactsPanels";
import { finite, pctColor, rate, safeArray, signed } from "./format";
import { useShortlineView } from "./useView";
import { REGIMES, type Regime, type SamplesResult, type SealBucket, type Stats, type StrategyDay, type StrategyResult } from "./viewTypes";
import { GapsAndSource, ViewSlot, WindowPicker } from "./ViewBits";
import type { ViewTabProps } from "./WeeklyTab";

export const SAMPLE_WINDOWS = [20, 30, 60, 90];
/** 「全体涨停」是基准线,其它打法对照它才知道有没有多赚 */
export const BASELINE = "全体涨停";
const SMALL_SAMPLE = 60;
const EMPTY: Stats = { sample: 0, win_rate: null, avg: null, median: null, best: null, worst: null, limit_up_rate: null };
const tone = (v?: number | null) => (finite(v) == null ? "text-muted-foreground" : pctColor(v));

function RegimeRow({ name, s }: { name: string; s: Stats }) {
  if (!s.sample) return null;
  return (
    <div className="flex items-center gap-2 text-[12px] tabular-nums">
      <span className="w-20 shrink-0 text-muted-foreground">{name}</span>
      <span className={cn("w-16 shrink-0 text-right font-semibold", tone(s.avg))}>{signed(s.avg)}</span>
      <span className="w-14 shrink-0 text-right text-muted-foreground">胜 {rate(s.win_rate)}</span>
      <span className="text-muted-foreground/70">{s.sample} 只次</span>
    </div>
  );
}

function SealCurve({ curve }: { curve: SealBucket[] }) {
  const rows = curve.filter((b) => b.sample > 0);
  return (
    <Section icon={Clock3} title="首板 · 最后封板时间曲线"
      hint={"同样是首板,什么时候把板最终封住决定了期望是正是负。数据源给的是最后封板时间,"
        + "所以「晚」同时意味着封得晚、或中途炸开过又回封 —— 两者都指向同一件事:这个板不稳。"
        + "只统计首板,连板股的封板时间含义不同,混在一起会污染结论。"}>
      {rows.length === 0 ? <p className="text-[13px] text-muted-foreground">这个窗口里没有首板样本。</p> : (
        <div className="space-y-2">
          {rows.map((b) => {
            const avg = finite(b.avg) ?? 0;
            const w = Math.min(100, Math.abs(avg) * 30);
            return (
              <div key={b.bucket} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] tabular-nums sm:flex-nowrap">
                <span className="w-24 shrink-0 text-muted-foreground">{b.bucket}</span>
                {/* 以 0 为中轴:左绿(跌)右红(涨) */}
                <div className="flex min-w-[8rem] flex-1 items-center" aria-hidden>
                  <div className="flex h-4 w-1/2 justify-end">{avg < 0 && <div className="h-full rounded-l bg-success/70" style={{ width: `${w}%` }} />}</div>
                  <div className="h-4 w-px bg-border" />
                  <div className="flex h-4 w-1/2">{avg > 0 && <div className="h-full rounded-r bg-danger/70" style={{ width: `${w}%` }} />}</div>
                </div>
                <span className={cn("w-16 shrink-0 text-right font-bold", tone(b.avg))}>{signed(b.avg)}</span>
                <span className="w-32 shrink-0 text-right text-muted-foreground">胜 {rate(b.win_rate)} · 再涨停 {rate(b.limit_up_rate)}</span>
                <span className="w-16 shrink-0 text-right text-muted-foreground/70">{b.sample} 只次</span>
              </div>
            );
          })}
          <p className="pt-1 text-[11px] text-muted-foreground/70">柱长 = 次日均收益;以 0 为中轴,右红左绿(红涨绿跌)。</p>
        </div>
      )}
    </Section>
  );
}

function StrategyCard({ s, base }: { s: StrategyResult; base: number | null }) {
  const o = s.overall ?? EMPTY;
  const daily = safeArray<StrategyDay>(s.daily);
  const isBase = s.name === BASELINE;
  const avg = finite(o.avg);
  const excess = !isBase && base != null && avg != null ? avg - base : null;
  return (
    <div className={cn("glass p-4", isBase && "border border-dashed border-border")}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-bold">{s.name}</h3>
        {isBase && <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">基准</span>}
        {excess != null && (
          <span className={cn("rounded px-2 py-0.5 text-[10px] font-bold", excess > 0 ? "bg-danger/15 text-danger" : excess < 0 ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")}>
            比基准 {signed(excess)}
          </span>
        )}
        {!!o.sample && o.sample < SMALL_SAMPLE && <span className="rounded bg-warning/15 px-2 py-0.5 text-[10px] font-bold text-warning">样本偏小</span>}
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">{s.desc}</p>
      {!o.sample ? <p className="text-[13px] text-muted-foreground">这个窗口里没有样本。</p> : (
        <>
          <div className="flex flex-wrap items-end gap-6">
            <div><div className={cn("font-mono text-2xl font-bold tabular-nums", tone(o.avg))}>{signed(o.avg)}</div><div className="text-[11px] text-muted-foreground">次日均值</div></div>
            <div><div className={cn("font-mono text-2xl font-bold tabular-nums", tone(o.median))}>{signed(o.median)}</div><div className="text-[11px] text-muted-foreground">中位数</div></div>
            <div><div className="font-mono text-2xl font-bold tabular-nums">{rate(o.win_rate)}</div><div className="text-[11px] text-muted-foreground">收红比例</div></div>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-dashed border-border pt-2 text-[12px] text-muted-foreground">
            <span>样本 {o.sample} 只次</span>
            <span>再涨停 <b className="text-foreground">{rate(o.limit_up_rate)}</b></span>
            <span>最好 <b className={tone(o.best)}>{signed(o.best)}</b></span>
            <span>最差 <b className={tone(o.worst)}>{signed(o.worst)}</b></span>
          </div>
          <div className="mt-3 space-y-1 border-t border-dashed border-border pt-2">
            <div className="mb-1 text-[11px] font-semibold text-primary">分情绪环境(按入场那天)</div>
            {REGIMES.map((k) => <RegimeRow key={k} name={k} s={s.by_regime?.[k as Regime] ?? EMPTY} />)}
          </div>
          {/* 逐日均收益:一眼看出赚亏集中在哪几天 */}
          <div className="mt-3 flex h-9 items-stretch gap-px border-t border-dashed border-border pt-2" aria-hidden>
            {daily.map((d) => {
              const a = finite(d.avg) ?? 0;
              const h = `${Math.min(100, Math.abs(a) * 10)}%`;
              return (
                <div key={d.date} title={`${d.date} | ${d.regime} | 均 ${signed(d.avg)} | ${d.sample} 只`} className="flex flex-1 flex-col justify-center">
                  <div className="flex h-1/2 items-end">{a > 0 && <div className="w-full bg-danger/70" style={{ height: h }} />}</div>
                  <div className="flex h-1/2 items-start">{a < 0 && <div className="w-full bg-success/70" style={{ height: h }} />}</div>
                </div>
              );
            })}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground/70">逐日均收益(上红下绿 · 红涨绿跌)</div>
        </>
      )}
    </div>
  );
}

export function SamplesView({ r }: { r: SamplesResult }) {
  const strategies = safeArray<StrategyResult>(r.strategies);
  const base = finite(strategies.find((s) => s.name === BASELINE)?.overall?.avg);
  const missing = safeArray<string>(r.missing_days);
  const unsettled = safeArray<string>(r.unsettled_days);
  const cuts = r.regime_cuts;
  return (
    <div className="space-y-4">
      {!r.available ? (
        <div className="glass p-4 text-[13px] text-muted-foreground">这个窗口统计不了:{r.reason || "原因不明"}</div>
      ) : (
        <>
          <div className="glass flex flex-wrap items-start gap-x-6 gap-y-1 p-4 text-[12px] text-muted-foreground">
            <span><Info className="mr-1 inline h-3.5 w-3.5 text-primary" />{r.date_from} ~ {r.date_to} · 请求 {r.days} 个交易日,实际可用 <b className="text-foreground">{r.days_used}</b> 天</span>
            {cuts.low != null && cuts.high != null && (
              <span>情绪环境 = 入场那天的情绪分(涨停家数 ×(1 + 最高连板)×(1 − 炸板率))在这个窗口里三等分:≤{cuts.low} 算弱,≥{cuts.high} 算强</span>
            )}
          </div>
          <SealCurve curve={safeArray<SealBucket>(r.seal_curve)} />
          <div className="flex items-center gap-1.5 pt-1">
            <ListChecks className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">按打法分开看</h3>
            <span className="text-[11px] text-muted-foreground">样本少于 {SMALL_SAMPLE} 只次的标「样本偏小」,读数波动大</span>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {strategies.map((s) => <StrategyCard key={s.name} s={s} base={base} />)}
          </div>
        </>
      )}
      {missing.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          没取到、已剔除的 {missing.length} 个交易日:{missing.slice(0, 6).join("、")}{missing.length > 6 ? " …" : ""}
        </p>
      )}
      {unsettled.length > 0 && <p role="status" className="text-[11px] text-warning">还没收盘、没算进去的:{unsettled.join("、")}</p>}
      <GapsAndSource gaps={safeArray<string>(r.gaps)} source={r.source} />
    </div>
  );
}

export function samplesSummary(r: SamplesResult): string {
  const out = [`涨停样本统计(市场现象,不是策略回测):截至 ${r.date},请求 ${r.days} 个交易日。`, `口径:${r.sample_caveat}`];
  if (!r.available) { out.push(`这个窗口统计不了:${r.reason ?? "原因不明"}`); return out.join("\n"); }
  out.push(`实际可用 ${r.days_used} 天(${r.date_from} ~ ${r.date_to})${r.missing_days.length ? `,剔除 ${r.missing_days.length} 天没取到的` : ""}。`);
  if (r.regime_cuts.low != null) out.push(`情绪环境按入场那天的情绪分三等分:≤${r.regime_cuts.low} 弱,≥${r.regime_cuts.high} 强。`);
  out.push("首板按最后封板时间:" + safeArray<SealBucket>(r.seal_curve).filter((b) => b.sample > 0).map((b) => `${b.bucket} 均 ${signed(b.avg)} 中位 ${signed(b.median)} 收红 ${rate(b.win_rate)} 再涨停 ${rate(b.limit_up_rate)}(${b.sample} 只次)`).join(";"));
  for (const s of safeArray<StrategyResult>(r.strategies)) {
    const o = s.overall ?? EMPTY;
    const reg = REGIMES.map((k) => s.by_regime?.[k as Regime]).map((x, i) => (x?.sample ? `${REGIMES[i]} 均 ${signed(x.avg)}(${x.sample})` : null)).filter(Boolean).join(",");
    out.push(`${s.name}(${s.desc}):${o.sample} 只次,均 ${signed(o.avg)},中位 ${signed(o.median)},收红 ${rate(o.win_rate)},再涨停 ${rate(o.limit_up_rate)}${o.sample < SMALL_SAMPLE ? ",样本偏小" : ""}${reg ? `;分环境:${reg}` : ""}`);
  }
  if (r.gaps.length) out.push(`缺口:${r.gaps.join(";")}`);
  return out.join("\n");
}

export function SamplesTab({ day, refreshNonce, onBusy }: ViewTabProps) {
  const [days, setDays] = useState(30);
  const [st] = useShortlineView<SamplesResult>("shortline_samples", day, days, refreshNonce, onBusy);
  const r = st.state === "done" ? st.data : null;
  useAiPage(r ? {
    key: `shortline:samples:${day}:${days}`,
    title: `涨停样本 ${day}`,
    context: samplesSummary(r),
    suggestions: ["哪种打法相对「全体涨停」基准真的多赚,样本够不够", "情绪强弱对次日表现影响有多大", "封板时间曲线的悬崖在哪个时段"],
  } : null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-muted-foreground">前一天涨停的票,第二天收盘怎么样 · 不是策略回测</p>
        <WindowPicker value={days} options={SAMPLE_WINDOWS} onChange={setDays} label="涨停样本看多少个交易日" />
      </div>
      {/* 这段警告不能删也不能弱化:样本是「事后知道封住了」的名单,冲板失败的票完全不在统计里 */}
      <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] leading-relaxed text-warning">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{r?.sample_caveat || "样本是收盘仍在涨停池里的事后名单,包含一字板等未必能成交的股票,未排除排队买不到的情况。冲板失败且未回封的股票不在样本内。没有成交模拟,不能推导真实交易收益或打法期望。"}</span>
      </div>
      <ViewSlot st={st} label="涨停样本" slow="第一次取要逐日拉东财数据,可能要几十秒">{(d) => <SamplesView r={d} />}</ViewSlot>
    </div>
  );
}
