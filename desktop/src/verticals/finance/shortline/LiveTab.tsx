/**
 * 盯盘 · 实时动态:持仓与自选、昨日梯队、大票、昨日成交额前十的当下读数,和盘中异动流。
 * 移植自 Vibe AStock v2.0.0 的「实时动态」「昨日梯队」两页(合成一页);异动规则同 VA:
 * 3 分钟内涨跌 ≥ 1.5% 记急拉 / 急跌,碰到 / 离开涨停价记封板 / 开板,同一只同一类 5 分钟不重复。
 * 只列客观读数,不排序打分、不给买卖倾向。
 */
import { useState, type ReactNode } from "react";
import { BarChart3, Building2, Layers, Radio, Wallet, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAiPage } from "../../../core/ai/pageContext";
import { Section } from "./FactsPanels";
import { finite, pctColor, signed, yi } from "./format";
import { GapsAndSource } from "./ViewBits";
import { useWatchPoll } from "./useWatchPoll";
import type { AlertKind, LadderWatchRow, WatchAlert, WatchRow, WatchView } from "./watchTypes";

export const THRESHOLDS = [1.5, 3, 5];
export type Scope = "all" | "mine";
export type LadderFilter = 1 | 2 | 3;

/** 急拉急跌按幅度筛;封板开板没有幅度,一直留着。「持仓与自选」只看来源里带这两样的 */
export function filterAlerts(alerts: WatchAlert[], threshold: number, scope: Scope): WatchAlert[] {
  return alerts.filter((a) => {
    const c = finite(a.change_pct);
    if (c !== null && Math.abs(c) < threshold - 1e-9) return false;
    return scope === "all" || a.sources.includes("持仓") || a.sources.includes("自选");
  });
}

/** 昨日涨停的票今天怎么样:只数行情时间是今天的;封住与否后端不说(午休、竞价、休市)时是 null,不当 0 */
export function ladderStats(rows: LadderWatchRow[]) {
  const today = rows.filter((r) => r.today && finite(r.pct) !== null);
  return {
    total: rows.length, sample: today.length,
    up: today.filter((r) => r.pct! > 0).length,
    down: today.filter((r) => r.pct! < 0).length,
    sealed: rows.some((r) => r.at_limit !== null) ? rows.filter((r) => r.at_limit === true).length : null,
  };
}

/** 梯队统计那一行;今天一只都没取到时说清楚下面是哪天的读数,不写「上涨 0 · 下跌 0」 */
function ladderLine(ls: ReturnType<typeof ladderStats>, v: WatchView): string {
  if (ls.sample === 0) {
    const old = v.quote_day && v.quote_day !== v.date ? `,下面是 ${v.quote_day} 的读数(标「非今日」)` : "";
    return `今天还没取到这 ${ls.total} 只的行情${old}`;
  }
  return `取到今天行情 ${ls.sample}/${ls.total} 只 · 上涨 ${ls.up} · 下跌 ${ls.down} · 封住 ${ls.sealed ?? "—"}`;
}

const KIND_STYLE: Record<AlertKind, string> = {
  急拉: "border-danger/50 bg-danger/10 text-danger",
  急跌: "border-success/50 bg-success/10 text-success",
  封板: "border-danger bg-danger/80 text-white",
  开板: "border-warning/60 bg-warning/10 text-warning",
};

function Price({ r }: { r: WatchRow }) {
  if (finite(r.price) === null) return <span className="text-muted-foreground">没取到</span>;
  return (
    <span className="font-mono tabular-nums">
      {r.price}
      {!r.today && <span className="ml-1 text-[10px] text-muted-foreground" title={r.quote_time ? `行情时间 ${r.quote_time}` : undefined}>非今日</span>}
    </span>
  );
}

function Name({ r }: { r: WatchRow }) {
  return <span className="whitespace-nowrap"><span className="font-medium">{r.name}</span> <span className="font-mono text-[11px] text-muted-foreground">{r.code}</span></span>;
}

type Col = { key: string; head: string; cell: (r: never) => ReactNode; className?: string };
function StockTable<R extends WatchRow>({ rows, cols, empty, label }: { rows: R[]; cols: Col[]; empty: string; label: string }) {
  if (!rows.length) return <p className="text-[13px] text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full text-left text-[12px]">
        <thead className="text-[11px] text-muted-foreground">
          <tr>{cols.map((c) => <th key={c.key} className={cn("whitespace-nowrap px-2 py-1 font-medium", c.className)}>{c.head}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.code} className="border-t border-border/40">
              {cols.map((c) => <td key={c.key} className={cn("whitespace-nowrap px-2 py-1", c.className)}>{(c.cell as (x: R) => ReactNode)(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const NAME: Col = { key: "name", head: "名称", cell: (r: WatchRow) => <Name r={r} /> };
const PRICE: Col = { key: "price", head: "现价", cell: (r: WatchRow) => <Price r={r} />, className: "text-right" };
const PCT: Col = { key: "pct", head: "今日", cell: (r: WatchRow) => <span className={cn("font-mono font-semibold tabular-nums", pctColor(r.pct))}>{signed(r.pct)}</span>, className: "text-right" };
const AMOUNT: Col = { key: "amount", head: "成交额", cell: (r: WatchRow) => <span className="font-mono text-muted-foreground">{yi(r.amount_yuan)}</span>, className: "text-right" };
const PNL: Col = { key: "pnl", head: "浮动盈亏", cell: (r: WatchRow & { pnl_pct: number | null }) => <span className={cn("font-mono tabular-nums", pctColor(r.pnl_pct))}>{signed(r.pnl_pct)}</span>, className: "text-right" };
const BOARDS: Col = { key: "boards", head: "昨日", cell: (r: LadderWatchRow) => <span className="font-mono font-bold text-primary">{r.label}</span> };
const SECTOR: Col = { key: "sector", head: "行业", cell: (r: LadderWatchRow) => <span className="text-muted-foreground">{r.sector || "—"}</span> };
const SEAL: Col = { key: "seal", head: "", cell: (r: LadderWatchRow) => (r.at_limit ? <span className="rounded bg-danger/15 px-1.5 py-0.5 text-[10px] font-bold text-danger">封住</span> : null) };
const RANK: Col = { key: "rank", head: "#", cell: (r: WatchRow & { rank: number }) => <span className="font-mono text-muted-foreground">{r.rank || "—"}</span> };

function AlertFeed({ v, threshold, scope, onThreshold, onScope }: { v: WatchView; threshold: number; scope: Scope; onThreshold: (n: number) => void; onScope: (s: Scope) => void }) {
  const shown = filterAlerts(v.alerts, threshold, scope);
  return (
    <Section icon={Zap} title="盘中异动"
      hint={`急拉 / 急跌(${v.rules.window_min} 分钟内 ±${v.rules.surge_pct}%)· 封板 / 开板 · 同一只同一类 ${v.rules.cooldown_min} 分钟内不重复。客观行情事件,不是推荐也不是预测。`}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px]">
        <div role="group" aria-label="急拉急跌的幅度" className="inline-flex items-center gap-1 rounded-lg border border-border/60 p-0.5">
          {THRESHOLDS.map((t) => (
            <button key={t} type="button" aria-pressed={threshold === t} onClick={() => onThreshold(t)}
              className={cn("rounded-md px-2 py-0.5 tabular-nums", threshold === t ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:text-foreground")}>
              ≥{t}%
            </button>
          ))}
        </div>
        <div role="group" aria-label="异动显示范围" className="inline-flex items-center gap-1 rounded-lg border border-border/60 p-0.5">
          {([["all", "全部盯的票"], ["mine", "只看持仓与自选"]] as const).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={scope === k} onClick={() => onScope(k)}
              className={cn("rounded-md px-2 py-0.5", scope === k ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:text-foreground")}>
              {label}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground">只筛这一页;封板、开板一直显示。低于 {v.rules.surge_pct}% 的变动不记。</span>
      </div>
      {shown.length === 0 ? (
        <p role="status" className="text-[13px] text-muted-foreground">
          {v.alerts.length ? `按当前筛选没有异动(今天共记下 ${v.alerts.length} 条)。`
            : v.detecting ? "还没有异动。急拉、急跌、封板、开板会实时出现在这里。"
            : `${v.phase_label},不判断异动${v.trading_day === false ? "" : ";连续竞价时段(9:30–11:30、13:00–14:57)页面开着就会盯"}。`}
        </p>
      ) : (
        <ul aria-label="异动列表" className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
          {shown.map((a, i) => (
            <li key={`${a.ts}-${a.code}-${a.kind}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
              <span className="font-mono text-muted-foreground">{a.ts}</span>
              <span className={cn("rounded border px-1.5 py-0.5 text-[11px] font-medium", KIND_STYLE[a.kind])}>{a.kind}</span>
              <span className="font-medium">{a.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{a.code}</span>
              <span className="text-muted-foreground">{a.msg}</span>
              {a.sources.map((s) => <span key={s} className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{s}</span>)}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function LiveView({ v, threshold, scope, ladderMin, onThreshold, onScope, onLadderMin, error, paused = false }: {
  v: WatchView; threshold: number; scope: Scope; ladderMin: LadderFilter;
  onThreshold: (n: number) => void; onScope: (s: Scope) => void; onLadderMin: (n: LadderFilter) => void;
  error: string | null;
  /** 页面切到后台:不再取行情,异动也不判断 */
  paused?: boolean;
}) {
  const detecting = v.detecting && !paused;
  const ls = v.ladder ? ladderStats(v.ladder.rows) : null;
  const ladderRows = (v.ladder?.rows ?? []).filter((r) => r.boards >= ladderMin);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5",
          detecting ? "border-danger/50 bg-danger/10 text-danger" : "border-border/60 text-muted-foreground")}>
          <Radio className={cn("h-3.5 w-3.5", detecting && "animate-pulse")} />
          {detecting ? `盯盘中 · ${v.phase_label}` : v.phase_label}
        </span>
        {paused
          ? <span role="status" className="text-warning">页面在后台,已暂停刷新(北京时间 {v.clock} 的读数);切回来就接着取</span>
          : <span className="text-muted-foreground">北京时间 <b className="font-mono text-foreground">{v.clock}</b> · {v.detecting ? "每 3 秒刷新" : `每 ${Math.round(v.poll_ms / 1000)} 秒刷新`};实际时效以行情时间为准</span>}
        {error && <span role="alert" className="text-warning">这次没取到:{error}。先显示上一次的内容,稍后自动重试</span>}
      </div>

      <AlertFeed v={v} threshold={threshold} scope={scope} onThreshold={onThreshold} onScope={onScope} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section icon={Wallet} title="持仓" hint="只列现价、今日涨跌和浮动盈亏 %;股数和成本在「自选与持仓」页。">
          <StockTable label="持仓" rows={v.holdings} cols={[NAME, PRICE, PCT, PNL]} empty="还没有 A 股持仓(B 股、港美股不在这里盯)。" />
        </Section>
        <Section icon={Wallet} title="自选">
          <StockTable label="自选" rows={v.watchlist} cols={[NAME, PRICE, PCT, AMOUNT]} empty="自选里还没有 A 股。在「自选与持仓」页加。" />
        </Section>
      </div>

      <Section icon={Layers} title={v.ladder ? `昨日梯队(${v.ladder.sample_date} 涨停 ${v.ladder.rows.length} 只,最高 ${v.ladder.highest} 板)` : "昨日梯队"}
        hint="上一个交易日收盘仍封在涨停的票,今天走得怎么样。「封住」= 现价在涨停价(只在连续竞价和收盘后说)。">
        {!v.ladder ? <p className="text-[13px] text-muted-foreground">昨日梯队这次没取到,看下面的说明。</p> : (
          <>
            {ls && (
              <p className="mb-2 text-[12px] text-muted-foreground">
                {ls.sample === 0 ? ladderLine(ls, v) : (
                  <>取到今天行情 <b className="text-foreground">{ls.sample}/{ls.total}</b> 只 · 上涨 <b className="text-danger">{ls.up}</b> · 下跌 <b className="text-success">{ls.down}</b> · 封住 <b className={ls.sealed === null ? "" : "text-danger"}>{ls.sealed ?? "—"}</b></>
                )}
              </p>
            )}
            <div role="group" aria-label="梯队按板位筛" className="mb-2 inline-flex items-center gap-1 rounded-lg border border-border/60 p-0.5 text-[12px]">
              {([[1, "全部"], [2, "2板以上"], [3, "3板以上"]] as const).map(([n, label]) => (
                <button key={n} type="button" aria-pressed={ladderMin === n} onClick={() => onLadderMin(n)}
                  className={cn("rounded-md px-2 py-0.5", ladderMin === n ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:text-foreground")}>
                  {label}
                </button>
              ))}
            </div>
            <StockTable label="昨日梯队" rows={ladderRows} cols={[BOARDS, NAME, SECTOR, PRICE, PCT, SEAL]} empty="这个板位以上没有票。" />
          </>
        )}
      </Section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section icon={Building2} title={v.bigcap ? `大票涨幅前十(500 亿以上 ${v.bigcap.total} 只)` : "大票涨幅前十"} hint="市值 500 亿以上的票每 30 秒取一次;下面附跌幅前五。">
          {!v.bigcap ? <p className="text-[13px] text-muted-foreground">大票名单这次没取到。</p> : (
            <>
              <StockTable label="大票涨幅前十" rows={v.bigcap.top} cols={[NAME, PRICE, PCT, AMOUNT]} empty="大票行情还没取到。" />
              {v.bigcap.bottom.length > 0 && (
                <div className="mt-3 border-t border-dashed border-border pt-2">
                  <div className="mb-1 text-[11px] font-semibold text-muted-foreground">跌幅前五</div>
                  <StockTable label="大票跌幅前五" rows={v.bigcap.bottom} cols={[NAME, PRICE, PCT, AMOUNT]} empty="" />
                </div>
              )}
            </>
          )}
        </Section>
        <Section icon={BarChart3} title={v.turnover ? `昨日成交额前十(${v.turnover.date})` : "昨日成交额前十"} hint="上一个交易日成交额最大的十只,看今天的表现;成交额是今天的。">
          {!v.turnover ? <p className="text-[13px] text-muted-foreground">昨日成交额前十这次没取到。</p>
            : <StockTable label="昨日成交额前十" rows={v.turnover.rows} cols={[RANK, NAME, PRICE, PCT, AMOUNT]} empty="没有数据。" />}
        </Section>
      </div>

      <GapsAndSource gaps={v.notes} source={v.source} />
    </div>
  );
}

/** 异动的名单标签里表示「在持仓里」的那个(后端 watch.ts sourcesOf) */
const HOLDING_TAG = "持仓";

/**
 * 给 AI 的页面上下文。🔴 持仓不发给 AI(沿用旧版「个人交易记录不接入任何 AI」):
 * 不列持仓和浮动盈亏;只因为在持仓里才进名单的异动整条不给,其余异动去掉「持仓」标签。
 */
export function liveSummary(v: WatchView): string {
  const row = (r: WatchRow) => `${r.name}(${r.code}) ${finite(r.price) === null ? "没取到" : `${r.price} ${signed(r.pct)}${r.today ? "" : "(非今日行情)"}`}`;
  const alerts = v.alerts.flatMap((a) => {
    if (!a.sources.includes(HOLDING_TAG)) return [a];
    const sources = a.sources.filter((s) => s !== HOLDING_TAG);
    return sources.length ? [{ ...a, sources }] : [];
  });
  const out = [`盯盘 · 实时动态,北京时间 ${v.date} ${v.clock},${v.phase_label}${v.detecting ? ",正在判断异动" : ",不判断异动"}。`];
  out.push(`异动规则:${v.rules.window_min} 分钟内涨跌 ≥${v.rules.surge_pct}% 记急拉 / 急跌,碰到 / 离开涨停价记封板 / 开板,同一只同一类 ${v.rules.cooldown_min} 分钟不重复。`);
  out.push(alerts.length ? `今天记下的异动(新的在前,最多列 30 条):${alerts.slice(0, 30).map((a) => `${a.ts} ${a.kind} ${a.name}(${a.code}) ${a.msg}${a.sources.length ? ` [${a.sources.join("、")}]` : ""}`).join(";")}` : "今天还没记下异动。");
  out.push("用户的持仓按产品规则不发给 AI,这里不列;只因为在持仓里才盯的异动也不列。");
  if (v.watchlist.length) out.push(`自选:${v.watchlist.map(row).join(";")}`);
  if (v.ladder) {
    const s = ladderStats(v.ladder.rows);
    out.push(`昨日梯队(${v.ladder.sample_date} 涨停 ${s.total} 只,最高 ${v.ladder.highest} 板):${ladderLine(s, v)}。2 板以上:${v.ladder.rows.filter((r) => r.boards >= 2).map((r) => `${r.label} ${row(r)}${r.sector ? ` · ${r.sector}` : ""}${r.at_limit ? " 封住" : ""}`).join(";") || "无"}`);
  }
  if (v.bigcap) out.push(`大票(500 亿以上 ${v.bigcap.total} 只)涨幅前十:${v.bigcap.top.map(row).join(";") || "没取到"}`);
  if (v.turnover) out.push(`昨日成交额前十(${v.turnover.date}):${v.turnover.rows.map(row).join(";")}`);
  if (v.notes.length) out.push(`缺口:${v.notes.join(";")}`);
  return out.join("\n");
}

export function LiveTab() {
  const { data, error, live } = useWatchPoll();
  const [threshold, setThreshold] = useState(THRESHOLDS[0]!);
  const [scope, setScope] = useState<Scope>("all");
  const [ladderMin, setLadderMin] = useState<LadderFilter>(1);
  useAiPage(data ? {
    key: "watch:live",
    title: `盯盘 · 实时动态 ${data.date}`,
    context: liveSummary(data),
    suggestions: ["昨日涨停的票今天整体强不强", "这些异动集中在哪些题材", "自选里有没有跟着梯队走弱的"],
  } : null);
  if (!data) {
    if (!live) return <div className="glass p-6"><p role="status" className="text-sm text-muted-foreground">页面在后台,先不取行情;切回来就开始取。</p></div>;
    return error
      ? <div className="glass p-6"><p role="status" className="text-sm text-muted-foreground">实时动态这次没取到:{error}。稍后自动重试。</p></div>
      : <div className="glass flex min-h-[10rem] items-center justify-center p-6"><p role="status" className="text-sm text-muted-foreground">实时动态加载中…第一次要取名单和几百只票的行情,稍等几秒</p></div>;
  }
  return <LiveView v={data} threshold={threshold} scope={scope} ladderMin={ladderMin} onThreshold={setThreshold} onScope={setScope} onLadderMin={setLadderMin} error={error} paused={!live} />;
}
