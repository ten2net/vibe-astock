/** 交易日志 · 风险与纪律:在险资金、权益曲线、最近状态、纪律值多少钱、自己的规矩。只统计自己的交易,不给操作建议 */
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { hideIf } from "@/lib/privacy";
import { EChart } from "@/components/ui/EChart";
import { usePalette } from "@/components/ui/chartPalette";
import {
  equityChart, maskJournalText, money, moneySigned, pctSigned, priceText, ratePct, ruleValueText, sharesText, tone, violationText,
  type AtRisk, type Discipline, type Equity, type JournalSettings, type JournalView, type RuleKey, type Rolling, type Violations, type WindowStats,
} from "@/lib/journal";
import { BTN_GHOST, Notes, Panel, Tile } from "./bits";
import { EquityBaseEditor, RulesEditor, type Act } from "./forms";

type Ready = Extract<JournalView, { available: true }>;
const pctOf = (v: number | null | undefined) => (typeof v === "number" ? `账户 ${v}%` : undefined);
/** 已经是正数的金额,前面加负号显示(回撤、在险) */
const minus = (v: number | null | undefined, hide: boolean) => (typeof v === "number" && v > 0 ? `−${hideIf(hide, money(v))}` : hideIf(hide, money(v)));

function AtRiskPanel({ a, settings, hide, act }: { a: AtRisk; settings: JournalSettings; hide: boolean; act: Act }) {
  const hint = "按你自己写下的计划止损算:(成本 − 止损价)× 股数。这是按计划价成交的估算;跳空、跌停卖不出时,实际亏损可能更大。";
  if (!a.available) {
    return (
      <Panel title="按计划止损估算的在险资金" hint={hint}>
        <p className="text-[12px] text-muted-foreground">{a.reason}。</p>
        <EquityBaseEditor value={settings.equity_base} hide={hide} hint={null} act={act} />
      </Panel>
    );
  }
  return (
    <Panel title="按计划止损估算的在险资金" hint={hint}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile k="有止损的合计在险(元)" v={minus(a.total_at_risk, hide)} cls={a.total_at_risk > 0 ? "text-success" : undefined} sub={pctOf(a.at_risk_of_equity_pct)} />
        <Tile k="在场" v={`${a.position_count} 笔`} sub={`你的上限 ${a.rules.max_positions} 只${a.rules.is_default ? "(初值)" : ""}`} />
        <Tile k="占用本金(元)" v={hideIf(hide, money(a.total_capital))} sub={pctOf(a.capital_of_equity_pct)} />
        <Tile k="没写止损" v={`${a.unbounded_count} 笔`} cls={a.unbounded_count > 0 ? "text-warning" : undefined} />
      </div>
      {a.unbounded_note && <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-warning">{maskJournalText(a.unbounded_note, hide)}</p>}
      {a.over_position_limit && (
        <p className="mt-2 text-[12px] text-warning">在场 {a.over_position_limit.actual} 只,超过你自己写的上限 {a.over_position_limit.limit} 只。</p>
      )}
      {!!a.over_per_trade_limit?.length && (
        <p className="mt-1 text-[12px] text-warning">
          单笔在险超过你的上限({a.rules.max_loss_per_trade_pct}%):{a.over_per_trade_limit.map((o) => `${o.name || o.code} ${o.pct_of_equity}%`).join("、")}
        </p>
      )}
      <div className="mt-3"><EquityBaseEditor value={a.equity_base} hide={hide} hint={a.equity_base_hint} act={act} /></div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[560px] text-[12px] tabular-nums">
          <thead>
            <tr className="border-b border-border text-[11px] text-muted-foreground">
              {["买入日", "标的", "股数", "成本", "计划止损", "在险(元)"].map((h, i) => (
                <th key={h} className={cn("px-2 py-1.5 font-normal", i < 2 ? "text-left" : "text-right")}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {a.positions.map((p) => (
              <tr key={p.key} className="border-b border-border/40 last:border-0">
                <td className="px-2 py-1.5 text-muted-foreground">{p.date}</td>
                <td className="px-2 py-1.5">{p.name || p.symbol}{p.name && p.name !== p.symbol && <span className="ml-1 text-[10px] text-muted-foreground">{p.symbol}</span>}</td>
                <td className="px-2 py-1.5 text-right">{hideIf(hide, sharesText(p.shares))}</td>
                <td className="px-2 py-1.5 text-right">{hideIf(hide, priceText(p.avg_cost))}</td>
                <td className={cn("px-2 py-1.5 text-right", !p.bounded && "text-warning")}>
                  {p.planned_stop === null ? "没写" : hideIf(hide, priceText(p.planned_stop))}
                  {p.plan_late && <span className="ml-1 text-[10px] text-warning">事后补</span>}
                </td>
                <td className={cn("px-2 py-1.5 text-right font-semibold", p.bounded ? "text-success" : "text-warning")}>
                  {p.at_risk === null ? "不知道" : minus(p.at_risk, hide)}
                  {p.at_risk_pct !== null && <span className="ml-1 text-[10px] font-normal opacity-70">−{p.at_risk_pct}%</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function EquityPanel({ eq, hide }: { eq: Equity; hide: boolean }) {
  const palette = usePalette();
  const option = useMemo(() => (eq.available ? equityChart(eq.points, palette, hide) : null), [eq, palette, hide]);
  if (!eq.available) {
    return <Panel title="权益曲线的形状" hint="累计赚多少没什么信息量;要看回撤多深、多久没创新高、盈利是不是靠少数几笔。"><p className="text-[12px] text-muted-foreground">{eq.reason}。</p></Panel>;
  }
  const onlyBest = eq.net_without_best1 < 0 && eq.net_pnl > 0;
  return (
    <Panel title="权益曲线的形状" hint={<>累计赚多少没什么信息量;要看回撤多深、多久没创新高、盈利是不是靠少数几笔。{eq.date_note && <> {eq.date_note}</>}</>}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile k={`净盈亏(${eq.trades} 笔,元)`} v={hideIf(hide, moneySigned(eq.net_pnl))} cls={tone(eq.net_pnl)} />
        <Tile k="距高点回撤(元)" v={minus(eq.current_drawdown, hide)} cls={eq.current_drawdown > 0 ? "text-success" : undefined} sub={`史上最大 ${minus(eq.max_drawdown, hide)}`} />
        <Tile k="没创新高" v={`${eq.trades_since_peak} 笔`} sub={eq.longest_underwater ? `最长 ${eq.longest_underwater} 笔没创新高` : undefined} />
        <Tile k="Profit Factor" v={eq.profit_factor === null ? "—" : String(eq.profit_factor)} sub={`胜率 ${ratePct(eq.win_rate)} · 盈亏比 ${eq.payoff_ratio ?? "—"}`} />
      </div>
      {hide
        ? <p className="mt-3 text-[12px] text-muted-foreground">隐私模式下不画曲线:曲线的高低就是每笔盈亏的大小。</p>
        : option && <div className="mt-3"><EChart option={option} height={240} /></div>}
      <p className="mt-3 border-t border-border pt-2.5 text-[12px] tabular-nums">
        <span className="text-muted-foreground">去掉最好 1 笔:</span>
        <b className={tone(eq.net_without_best1)}>{hideIf(hide, moneySigned(eq.net_without_best1))}</b>
        <span className="mx-2 text-muted-foreground">·</span>
        <span className="text-muted-foreground">去掉最好 3 笔:</span>
        <b className={tone(eq.net_without_best3)}>{hideIf(hide, moneySigned(eq.net_without_best3))}</b>
        {onlyBest && <span className="ml-2 text-[11px] text-warning">⚠️ 去掉最好那一笔就是亏的</span>}
        <span className="ml-2 text-[11px] text-muted-foreground/80">最长连亏 {eq.worst_losing_streak} 笔 · 最差一笔 {hideIf(hide, moneySigned(eq.worst_trade))}</span>
      </p>
    </Panel>
  );
}

const WINDOWS = ["10", "20", "50"] as const;

function RollingPanel({ r, hide }: { r: Rolling; hide: boolean }) {
  if (!r.available) return <Panel title="最近还在状态上吗" hint="终身统计会把最近的退化藏起来。"><p className="text-[12px] text-muted-foreground">{r.reason}。</p></Panel>;
  const cols = WINDOWS.map((k) => r.windows[k]);
  const ROWS: { label: string; get: (w?: WindowStats) => string; toneBy?: (w?: WindowStats) => number | null | undefined; title?: string }[] = [
    { label: "笔数", get: (w) => (w ? String(w.trades) : "—") },
    { label: "净盈亏(元)", get: (w) => hideIf(hide, moneySigned(w?.net_pnl)), toneBy: (w) => w?.net_pnl },
    { label: "胜率", get: (w) => ratePct(w?.win_rate) },
    { label: "盈亏比", get: (w) => (typeof w?.payoff_ratio === "number" ? String(w.payoff_ratio) : "—") },
    { label: "Profit Factor", get: (w) => (typeof w?.profit_factor === "number" ? String(w.profit_factor) : "—") },
    { label: "执行率", get: (w) => ratePct(w?.execution_rate), title: "按计划的笔数 ÷ 标过按计划 / 计划外的笔数" },
  ];
  const drift = r.win_rate_drift;
  return (
    <Panel title="最近还在状态上吗" hint={r.note}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[440px] text-[12px] tabular-nums">
          <thead>
            <tr className="border-b border-border text-[11px] text-muted-foreground">
              <th className="py-1.5 pr-3 text-left font-normal"><span className="sr-only">指标</span></th>
              <th className="px-2 py-1.5 text-right font-normal">终身</th>
              {cols.map((w, i) => (
                <th key={WINDOWS[i]} className="px-2 py-1.5 text-right font-normal">近 {WINDOWS[i]} 笔{w && !w.enough && <span className="ml-0.5 text-warning">*</span>}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.label} className="border-b border-border/40 last:border-0">
                <td className="py-1.5 pr-3 text-muted-foreground" title={row.title}>{row.label}</td>
                <td className={cn("px-2 py-1.5 text-right font-semibold", row.toneBy && tone(row.toneBy(r.lifetime)))}>{row.get(r.lifetime)}</td>
                {cols.map((w, i) => (
                  <td key={WINDOWS[i]} className={cn("px-2 py-1.5 text-right", w?.enough ? cn("font-semibold", row.toneBy && tone(row.toneBy(w))) : "text-muted-foreground/60")}>{row.get(w)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cols.some((w) => w && !w.enough) && <p className="mt-2 text-[11px] text-warning">* 交易笔数还不够这个窗口,数字只是「目前全部」,别当成这个尺度上验证过。</p>}
      {typeof drift === "number" && (
        <p className="mt-2 text-[12px] text-muted-foreground">
          近 10 笔胜率比终身{drift >= 0 ? "高" : "低"} <b className={tone(drift)}>{Math.round(Math.abs(drift) * 100)} 个百分点</b>
          {typeof r.profit_factor_drift === "number" && `,Profit Factor 差 ${r.profit_factor_drift > 0 ? "+" : ""}${r.profit_factor_drift}`}
          <span className="ml-1 text-[11px] opacity-70">(你自己的历史统计,不是对下一笔的预测)</span>
        </p>
      )}
    </Panel>
  );
}

function DisciplinePanel({ d, hide }: { d: Discipline; hide: boolean }) {
  if (!d.available) return <Panel title="纪律值多少钱" hint="如果删掉所有「计划外」交易,账户会是什么样。"><p className="text-[12px] text-muted-foreground">{d.reason}。</p></Panel>;
  const w = d.what_if_only_planned;
  const rows: [string, typeof d.planned][] = [["按计划", d.planned], ["计划外", d.unplanned], ["没标", d.untagged]];
  return (
    <Panel title="纪律值多少钱" hint={`如果删掉所有「计划外」交易,账户会是什么样。${d.note}`}>
      {w.cost_of_indiscipline !== null && (
        <div className="flex flex-wrap items-center gap-3">
          <Tile k="实际净盈亏(元)" v={hideIf(hide, moneySigned(w.actual_net))} cls={tone(w.actual_net)} />
          <span className="text-lg text-muted-foreground">→</span>
          <Tile k="只做按计划的(元)" v={hideIf(hide, moneySigned(w.planned_only_net))} cls={tone(w.planned_only_net)} />
          <Tile k={w.cost_of_indiscipline < 0 ? "计划外交易的代价" : "计划外反而赚了"} v={hideIf(hide, moneySigned(w.cost_of_indiscipline))} cls={tone(w.cost_of_indiscipline)} />
          <Tile k="执行率" v={ratePct(d.execution_rate)} />
        </div>
      )}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[380px] text-[12px] tabular-nums">
          <thead>
            <tr className="border-b border-border text-[11px] text-muted-foreground">
              {["", "笔数", "胜率", "平均每笔", "净盈亏(元)"].map((h, i) => <th key={i} className={cn("px-2 py-1.5 font-normal", i ? "text-right" : "text-left")}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, b]) => (
              <tr key={k} className="border-b border-border/40 last:border-0">
                <td className="px-2 py-1.5 font-medium">{k}</td>
                <td className="px-2 py-1.5 text-right">{b.count}</td>
                <td className="px-2 py-1.5 text-right">{ratePct(b.win_rate)}</td>
                <td className={cn("px-2 py-1.5 text-right", tone(b.avg_pct))}>{pctSigned(b.avg_pct)}</td>
                <td className={cn("px-2 py-1.5 text-right", tone(b.net_pnl))}>{hideIf(hide, moneySigned(b.net_pnl))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function RulesPanel({ vi, settings, hide, act }: { vi: Violations; settings: JournalSettings; hide: boolean; act: Act }) {
  const [editing, setEditing] = useState(false);
  const statuses = vi.available ? Object.entries(vi.rule_status).filter(([, s]) => s.startsWith("unavailable")) : [];
  const label = (k: string) => settings.labels.rules[k as RuleKey] ?? k;
  return (
    <Panel title="你自己的规矩" hint="系统只检查你有没有违反自己写下的规矩,不替你判断该不该交易。"
      actions={(
        <button type="button" onClick={() => setEditing((x) => !x)}
          className={cn(BTN_GHOST, settings.rules_default && !editing && "border-warning/40 text-warning")}>
          {editing ? "收起" : settings.rules_default ? "还在用初值 · 改成你自己的" : "改我的规矩"}
        </button>
      )}>
      {editing && <div className="mb-3"><RulesEditor settings={settings} act={act} onDone={() => setEditing(false)} /></div>}
      <p className="mb-2 text-[11px] text-muted-foreground">
        现在的规矩:{(Object.keys(settings.rules) as RuleKey[]).map((k) => `${settings.labels.rules[k]} ${ruleValueText(k, settings.rules[k])}`).join(" · ")}
      </p>
      <Notes kind="warn" items={statuses.map(([k, s]) => `${label(k)}没法完整核对:${s.replace(/^unavailable[::]?/, "")}`)} />
      {!vi.available ? <p className="text-[12px] text-muted-foreground">{vi.reason}。</p>
        : vi.violation_count === 0 ? (
          <p className="mt-1 text-[12px] text-muted-foreground">{statuses.length ? "查得到的范围内没有违反;上面没法核对的规矩不能算通过。" : "查过的规矩都没有违反记录。"}</p>
        ) : (
          <div className="mt-1 max-h-60 space-y-1 overflow-y-auto">
            {vi.violations.map((v, i) => (
              <div key={`${v.date}-${v.rule}-${i}`} className="flex flex-wrap items-center gap-2 text-[12px] tabular-nums">
                <span className="w-20 shrink-0 text-muted-foreground">{v.date}</span>
                <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning">{v.label}</span>
                <span className="text-muted-foreground">{violationText(v, hide)}</span>
                <span className="text-[10px] text-muted-foreground/70">(你的上限 {ruleValueText(v.rule, v.limit)})</span>
              </div>
            ))}
          </div>
        )}
      {vi.available && vi.after_loss_streak.trades > 0 && (
        <p className="mt-3 border-t border-border pt-2.5 text-[12px] text-muted-foreground">
          你连亏 {vi.after_loss_streak.threshold} 笔后又做了 <b className="text-foreground">{vi.after_loss_streak.trades}</b> 笔,
          平均 <b className={tone(vi.after_loss_streak.avg_pct)}>{pctSigned(vi.after_loss_streak.avg_pct)}</b>,胜率 <b className="text-foreground">{ratePct(vi.after_loss_streak.win_rate)}</b>
          <span className="ml-1 text-[11px] opacity-70">(你自己的历史,不是建议)</span>
        </p>
      )}
    </Panel>
  );
}

export function RiskTab({ v, hide, act }: { v: Ready; hide: boolean; act: Act }) {
  return (
    <div className="space-y-4">
      <AtRiskPanel a={v.at_risk} settings={v.settings} hide={hide} act={act} />
      <EquityPanel eq={v.risk.equity} hide={hide} />
      <div className="grid gap-4 lg:grid-cols-2">
        <RollingPanel r={v.risk.rolling} hide={hide} />
        <DisciplinePanel d={v.risk.discipline} hide={hide} />
      </div>
      <RulesPanel vi={v.risk.violations} settings={v.settings} hide={hide} act={act} />
    </div>
  );
}
