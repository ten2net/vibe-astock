/**
 * 连板天梯:这一天每个连板高度有谁、昨天下面一层的几只接上了、没接上的今天怎么样了。
 * 版式借鉴 GitHub 上几个短线看板的「连板天梯」(只借展示思路,没有搬代码);板数和晋级的口径与情绪四项同一套,
 * 所以「4进5 1/3」和晋级率卡片里的数对得上。
 */
import { useState } from "react";
import { AlertCircle, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { Caliber } from "./Caliber";
import { DOWN_TEXT, finite, hhmm, pctColor, rate, safeArray, signed, yi } from "./format";
import type { BoardLadderResult, LadderFell, LadderLevel, LadderStock } from "./types";

const CALIBER =
  "板数 = 东财涨停池的连板数;断板后又涨停(反包)从 1 重新数,名字旁标「N天M板」。\n" +
  "「4进5 1/3」= 昨天 4 板的 3 只里,今天还在涨停池的有 1 只;和晋级率卡片是同一个算法。\n" +
  "没接上的按今天的去向写:跌停 / 炸板(盘中封过又打开)/ 没涨停;涨跌幅优先用收盘后东财「昨日涨停池」里的当日表现。\n" +
  "同一层按首次封板时间从早到晚排;「炸N」= 当天开板 N 次。首板太多,名单见下方「首板名单」。\n" +
  "题材标签来自同花顺涨停揭秘的涨停原因,是源站编辑归因,不是公司确认;北交所的涨停股同花顺不收录,没有原因和标签。";

/** 没接上的先列几只,多了折起来(1进2 常有二三十只) */
const FELL_SHOWN = 6;

const OUTCOME_TEXT: Record<LadderFell["outcome"], string> = {
  跌停: cn(DOWN_TEXT, "font-semibold"),
  炸板: "text-warning",
  没涨停: "text-muted-foreground",
  没取到: "text-muted-foreground/70",
};

function stockTitle(s: LadderStock): string {
  return [
    `${s.name} ${s.code} · ${s.label}${s.board && s.board !== "10cm" ? ` · ${s.board}` : ""}`,
    `首封 ${hhmm(s.first_seal)} · 最后封板 ${hhmm(s.last_seal)} · 炸板 ${s.broken_times} 次`,
    `封单 ${yi(s.seal_fund)} · 成交额 ${yi(s.amount)} · 流通市值 ${yi(s.float_cap)}`,
    `涨停原因:${s.reason || (s.board === "北交所" ? "同花顺不收录北交所" : "没取到")}`,
  ].join("\n");
}

function StockChip({ s }: { s: LadderStock }) {
  const tags = safeArray<string>(s.tags).slice(0, 2);
  return (
    <li title={stockTitle(s)} className="inline-flex max-w-full flex-wrap items-baseline gap-x-1.5 rounded-lg border border-danger/30 bg-danger/[0.06] px-2 py-1 text-[12px]">
      <b className="font-semibold">{s.name}</b>
      {s.rebound && <span className="rounded bg-warning/15 px-1 text-[10px] font-bold text-warning">{s.label}</span>}
      {s.board && s.board !== "10cm" && <span className="text-[10px] text-muted-foreground">{s.board}</span>}
      <span className="font-mono text-[10px] text-muted-foreground">{hhmm(s.first_seal)}</span>
      {s.broken_times > 0 && <span className="text-[10px] text-warning">炸{s.broken_times}</span>}
      {tags.length > 0 && <span className="text-[10px] text-muted-foreground">{tags.join(" · ")}</span>}
    </li>
  );
}

function FellChip({ f }: { f: LadderFell }) {
  return (
    <li title={`${f.name} ${f.code} · 昨天 ${f.prev_label} · 今天${f.outcome}`} className="inline-flex items-baseline gap-1 rounded-lg border border-dashed border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground">
      <span>{f.name}</span>
      {f.prev_label !== `${f.prev_boards}板` && <span className="text-[10px]">({f.prev_label})</span>}
      <span className={OUTCOME_TEXT[f.outcome] ?? "text-muted-foreground"}>{f.outcome}</span>
      <span className={cn("font-mono", pctColor(f.ret))}>{signed(f.ret)}</span>
    </li>
  );
}

/** 「1进2 8/33 · 24%」;昨天的池子没取到时说清楚,不写 0 */
function promotionText(lv: LadderLevel, prevAvailable: boolean): string | null {
  if (lv.boards <= 1) return null;
  const base = finite(lv.base);
  if (base == null) return prevAvailable ? null : "昨天的池子没取到,晋级算不了";
  return `${lv.boards - 1}进${lv.boards} ${lv.promoted ?? "—"}/${base} · ${rate(lv.rate)}`;
}

function fellSummary(fell: LadderFell[]): string {
  const n = (o: LadderFell["outcome"]) => fell.filter((f) => f.outcome === o).length;
  const parts = (["跌停", "炸板", "没涨停", "没取到"] as const).map((o) => [o, n(o)] as const).filter(([, c]) => c > 0).map(([o, c]) => `${o} ${c}`);
  return `没接上 ${fell.length} 只(${parts.join(" · ")})`;
}

function LevelRow({ lv, prevAvailable }: { lv: LadderLevel; prevAvailable: boolean }) {
  const [open, setOpen] = useState(false);
  const stocks = safeArray<LadderStock>(lv.stocks);
  const fell = safeArray<LadderFell>(lv.fell);
  const promo = promotionText(lv, prevAvailable);
  const shownFell = open ? fell : fell.slice(0, FELL_SHOWN);
  return (
    <div className="grid gap-x-4 gap-y-1.5 border-b border-border/40 py-2.5 last:border-0 sm:grid-cols-[6.5rem_minmax(0,1fr)]">
      <div className="flex items-baseline gap-2 sm:block">
        <p className="text-lg font-extrabold leading-none text-danger">{lv.boards}板</p>
        <p className="text-[11px] text-muted-foreground sm:mt-1">{stocks.length} 只</p>
        {promo && <p className="text-[11px] tabular-nums text-muted-foreground sm:mt-0.5">{promo}</p>}
      </div>
      <div className="min-w-0 space-y-1.5">
        {lv.boards === 1 ? (
          <p className="text-[12px] text-muted-foreground">首板 {stocks.length} 只,名单见下方「首板名单」。</p>
        ) : stocks.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">这一层今天没有涨停的。</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">{stocks.map((s) => <StockChip key={s.code} s={s} />)}</ul>
        )}
        {fell.length > 0 && (
          <div className="flex flex-wrap items-baseline gap-1.5">
            <span className="text-[11px] text-muted-foreground">{fellSummary(fell)}:</span>
            <ul className="contents">{shownFell.map((f) => <FellChip key={f.code} f={f} />)}</ul>
            {fell.length > FELL_SHOWN && (
              <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
                className="text-[11px] text-primary underline-offset-2 hover:underline">
                {open ? "收起" : `展开其余 ${fell.length - FELL_SHOWN} 只`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function BoardLadderPanel({ r }: { r: BoardLadderResult }) {
  const lad = r.ladder ?? { available: false };
  const levels = safeArray<LadderLevel>(lad.levels);
  const prevOk = lad.prev_available !== false;
  return (
    <div className="glass p-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Layers className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">连板天梯</h3>
        <Caliber text={CALIBER} />
        {lad.available && (
          <span className="text-xs text-muted-foreground">
            涨停 {lad.total_limit_up ?? "—"} 家 · 连板 {lad.consec_count ?? "—"} 只 · 最高 {lad.highest ?? "—"} 板{r.prev_date && ` · 晋级对比 ${r.prev_date}`} · 客观公开榜单,非推荐 / 非预测
          </span>
        )}
      </div>
      {!lad.available ? (
        <p className="py-4 text-center text-sm text-muted-foreground">连板天梯没取到:{lad.reason || "原因不明"}</p>
      ) : (
        <>
          {!prevOk && (
            <p role="status" className="mb-1 flex items-start gap-1.5 text-[11px] text-warning">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" /> {lad.prev_note || "前一交易日的涨停池没取到"}:只列今天各层的名单,晋级和没接上的算不了。
            </p>
          )}
          {lad.reason_note && (
            <p className="mb-1 flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" /> 涨停原因:{lad.reason_note}
              {safeArray<string>(lad.reason_missing).length > 0 && `;${safeArray<string>(lad.reason_missing).length} 只沪深涨停股没有原因`}
            </p>
          )}
          {levels.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">这一天没有涨停股</p>
          ) : (
            <div>{levels.map((lv) => <LevelRow key={lv.boards} lv={lv} prevAvailable={prevOk} />)}</div>
          )}
        </>
      )}
    </div>
  );
}

/** 写给 AI 的一段:每层的名单、晋级和没接上的去向;昨天没取到 / 原因没取到都明说 */
export function ladderSummary(r: BoardLadderResult): string {
  const lad = r.ladder;
  if (!lad?.available) return `连板天梯:没取到(${lad?.reason ?? "原因不明"})`;
  const prevOk = lad.prev_available !== false;
  const rows = safeArray<LadderLevel>(lad.levels).map((lv) => {
    const stocks = safeArray<LadderStock>(lv.stocks);
    const promo = promotionText(lv, prevOk);
    if (lv.boards === 1) return `首板 ${stocks.length} 只${promo ? `(${promo})` : ""}`;
    const names = stocks.map((s) => `${s.name}${s.rebound ? `[${s.label}]` : ""}${s.tags?.length ? `(${s.tags.slice(0, 2).join("、")})` : ""}`).join("、") || "无";
    const fell = safeArray<LadderFell>(lv.fell);
    const fellText = fell.length ? `;${fellSummary(fell)}:${fell.slice(0, 5).map((f) => `${f.name}${f.outcome}${signed(f.ret)}`).join("、")}${fell.length > 5 ? " 等" : ""}` : "";
    return `${lv.boards}板 ${stocks.length} 只${promo ? `(${promo})` : ""}:${names}${fellText}`;
  });
  const head = `连板天梯(东财连板数分层,晋级口径同晋级率;题材是源站编辑归因非公司确认):涨停 ${lad.total_limit_up ?? "—"} 家、连板 ${lad.consec_count ?? "—"} 只、最高 ${lad.highest ?? "—"} 板`;
  const noReason = safeArray<string>(lad.reason_missing);
  const notes = [
    prevOk ? "" : `前一交易日涨停池没取到(${lad.prev_note || "原因不明"}),晋级和没接上的算不了`,
    lad.reason_available === false ? `涨停原因没取到(${lad.reason_note || "原因不明"})` : "",
    noReason.length ? `${noReason.length} 只沪深涨停股没有涨停原因(${noReason.slice(0, 5).join("、")}${noReason.length > 5 ? " 等" : ""}),它们没算进题材` : "",
  ].filter(Boolean);
  return [head, ...rows, ...notes].join("\n");
}
