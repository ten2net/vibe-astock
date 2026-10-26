/**
 * 盯盘 · 实时动态 —— 分时资金「先横盘、后稳步拉升」榜(当日,前 20)。
 *
 * 口径(全部客观公开数据,非推荐、非预测、不评分):
 *  - 名单 = 全市场资金流榜(主力/大单净额)前 150(新浪榜,东财不通时自动切);
 *  - 资金曲线 = 当日分钟累计主动净买入(DDX 近似:分钟涨记流入、跌记流出;
 *    东财分钟大单口径可用时自动切换);
 *  - 识别:横盘段(带宽 ≤10/25bp、≥15 分钟)接拉升段(≥12/40bp、上涨分钟 ≥60%、
 *    最后一分钟仍向上),按 拉升 − 0.5×横盘带宽 取前 20。
 * 后端见 orchestrator/src/finance/shortline/fflow_pattern.ts(视图 shortline_fflow)。
 *
 * 展示与取数分层:FflowPanelView 纯展示(可单测),FflowSection 自轮询(约 60s,
 * 页面在后台暂停)—— 与 LiveTab 的 watch 轮询相互独立,互不等对方。
 */
import { useEffect, useRef, useState } from "react";
import { TrendingUp } from "lucide-react";
import { backend } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { Section } from "./FactsPanels";
import { useWatchCodes } from "../hooks/useWatchCodes";
import { finite, pctColor, signed } from "./format";
import { StockName, WatchToggle } from "../components/StockLink";
import type { FflowCandidate, FflowView } from "./watchTypes";

const wan = (yuan: number | null) => (yuan === null || !Number.isFinite(yuan) ? "—" : `${(yuan / 1e4).toFixed(0)}万`);

/** 累计曲线尾巴(bp)画成迷你走势图;横盘紧、尾部陡的形态一眼可辨 */
function Sparkline({ series }: { series: number[] }) {
  if (!series.length) return <span className="text-muted-foreground">—</span>;
  const W = 72, H = 20;
  const min = Math.min(...series), max = Math.max(...series);
  const span = max - min || 1;
  const pts = series.map((v, i) => `${((i / (series.length - 1 || 1)) * W).toFixed(1)},${(H - 2 - ((v - min) / span) * (H - 4)).toFixed(1)}`);
  return (
    <svg width={W} height={H} aria-hidden="true" className="inline-block align-middle">
      <polyline points={pts.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-primary" />
    </svg>
  );
}

/** 给 AI 的页面上下文(客观读数,不带买卖倾向) */
export function fflowSummary(v: FflowView): string {
  const row = (s: FflowCandidate) => `${s.name}(${s.code}) ${finite(s.pct) === null ? "涨幅没取到" : signed(s.pct)} 主力净流入${wan(s.main_net)} 横盘${s.flat_minutes}分→拉升${s.rise_minutes}分 拉升${s.rise_bp}bp 稳步度${(s.up_ratio * 100).toFixed(0)}%`;
  const out = [`分时资金横盘→拉升榜(${v.day ?? "日期未知"},数据截至 ${v.as_of ?? "—"}):扫描 ${v.total_scanned} 只,有分钟数据 ${v.with_data} 只,命中 ${v.matched} 只。`];
  out.push(v.stocks.length ? v.stocks.map(row).join(";") : "没有命中形态的股票。");
  if (v.notes.length) out.push(`说明:${v.notes.join(";")}`);
  return out.join("\n");
}

export function FflowPanelView({ v }: { v: FflowView }) {
  // 自选真源在台账：订阅后，本页加入 / 移除与别的页面同时生效，星标不会各说各话
  const { codes: watchCodes, toggle } = useWatchCodes();
  const [busy, setBusy] = useState<string | null>(null);
  const [watchErr, setWatchErr] = useState<string | null>(null);
  const onToggle = (code: string) => {
    setBusy(code);
    setWatchErr(null);
    void toggle(code)
      .catch((e) => setWatchErr(`${code} 没保存上：${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setBusy(null));
  };
  return (
    <Section icon={TrendingUp} title="分时资金 · 横盘后拉升(前 20)"
      hint={`当日分钟级资金(DDX 近似):先横盘(带宽≤阈值、≥15分钟)后稳步拉升(≥阈值、上涨分钟≥60%、尾盘仍向上)。名单:资金流榜前 ${v.total_scanned} 只;通道:${v.source_label};数据截至 ${v.as_of ?? "—"}。客观资金形态,不是推荐也不是预测。`}>
      {!v.stocks.length ? (
        <p role="status" className="text-[13px] text-muted-foreground">
          {v.with_data === 0
            ? "分钟资金数据还没取到(非交易时段 / 上游不通),盘中自动重试。"
            : "暂时没有命中「先横盘后稳步拉升」形态的票。早盘点数不够或形态未出现时常见,盘中每分钟自动刷新。"}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table aria-label="分时资金横盘拉升榜" className="w-full text-left text-[12px]">
            <thead className="text-[11px] text-muted-foreground">
              <tr>
                <th className="px-2 py-1 font-medium">#</th>
                <th className="px-2 py-1 font-medium">名称</th>
                <th className="px-2 py-1 text-right font-medium">现价</th>
                <th className="px-2 py-1 text-right font-medium">今日</th>
                <th className="px-2 py-1 text-right font-medium">主力净流入</th>
                <th className="px-2 py-1 text-right font-medium">横盘→拉升</th>
                <th className="px-2 py-1 text-right font-medium">拉升幅度</th>
                <th className="px-2 py-1 text-right font-medium">稳步度</th>
                <th className="px-2 py-1 font-medium">资金曲线(bp)</th>
              </tr>
            </thead>
            <tbody>
              {v.stocks.map((s, i) => (
                <tr key={s.code} className="border-t border-border/40">
                  <td className="px-2 py-1 font-mono text-muted-foreground">{i + 1}</td>
                  <td className="whitespace-nowrap px-2 py-1">
                    <StockName code={s.code} name={s.name} className="font-medium" />
                    <WatchToggle code={s.code} inWatch={watchCodes.includes(s.code)} onToggle={onToggle} busy={busy === s.code} />{" "}
                    <span className="font-mono text-[11px] text-muted-foreground">{s.code}</span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-right font-mono tabular-nums">{s.price ?? "—"}</td>
                  <td className={cn("whitespace-nowrap px-2 py-1 text-right font-mono font-semibold tabular-nums", pctColor(s.pct))}>{signed(s.pct)}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-danger">{wan(s.main_net)}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">{s.flat_minutes}分→{s.rise_minutes}分</td>
                  <td className="whitespace-nowrap px-2 py-1 text-right font-mono font-semibold tabular-nums text-danger">+{s.rise_bp}bp</td>
                  <td className="whitespace-nowrap px-2 py-1 text-right font-mono tabular-nums">{Math.round(s.up_ratio * 100)}%</td>
                  <td className="px-2 py-1"><Sparkline series={s.series_bp} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {watchErr && <p role="alert" className="mt-2 text-[11px] text-warning">{watchErr}</p>}
      {v.notes.length > 0 && <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{v.notes.join(" · ")}</p>}
    </Section>
  );
}

/** 自轮询容器:约 60s 一次(后端结果缓存 45s);页面在后台暂停,切回立即重取 */
export function FflowSection() {
  const [v, setV] = useState<FflowView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      abort.current?.abort();
      const ctl = new AbortController();
      abort.current = ctl;
      try {
        const r = await backend.shortlineFflow<FflowView>(ctl.signal);
        if (stopped || ctl.signal.aborted) return;
        setV(r); setErr(null);
        timer.current = setTimeout(tick, Math.max(30_000, r.poll_ms || 60_000));
      } catch (e) {
        if (stopped || ctl.signal.aborted) return;
        setErr(e instanceof Error ? e.message : String(e));
        timer.current = setTimeout(tick, 60_000);
      }
    };
    void tick();
    const onVis = () => { if (document.visibilityState === "visible") void tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
      abort.current?.abort();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  if (!v) {
    return (
      <Section icon={TrendingUp} title="分时资金 · 横盘后拉升(前 20)" hint="扫描当日分钟级主力净流入形态,约每分钟刷新。">
        <p role="status" className="text-[13px] text-muted-foreground">
          {err ? `这次没取到:${err}。每分钟自动重试。` : "分时资金形态榜加载中(首次要扫描上百只的分钟数据,约十几秒)…"}
        </p>
      </Section>
    );
  }
  return (
    <div>
      <FflowPanelView v={v} />
      {err && <p role="alert" className="mt-1 text-[11px] text-warning">这次刷新没取到:{err},先显示上一次的内容。</p>}
    </div>
  );
}
