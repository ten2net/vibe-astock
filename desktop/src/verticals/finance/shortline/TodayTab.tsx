/**
 * 情绪复盘 · 今日情绪。排法照 Vibe AStock 的看板:先看昨天涨停的今天赚不赚钱(四项读数),
 * 再看各个高度有谁、昨天那层接上了几只(连板天梯),钱亏在哪个板位、板封得结不结实,
 * 再看钱在哪些题材,最后是事件、分制度、周期和首板名单。
 * 只负责摆;取数在页面里(各块各自回来各自显示)。
 */
import type { ReactNode } from "react";
import { useAiPage } from "../../../core/ai/pageContext";
import type { Panel } from "./api";
import { BoardLadderPanel } from "./BoardLadderPanel";
import { ConsecPremiumCard, CycleCard, LadderCard, MoneyEffectCard, PromotionCard } from "./EmotionCards";
import { BoardSystemSection, Ledger, LossEffectSection, Matrix, SealQualitySection, ThemeTreeView, Themes } from "./FactsPanels";
import { FirstBoardPanel } from "./FirstBoardPanel";
import { todaySummary } from "./summary";
import type { BoardLadderResult, ConsecPremium, CycleResult, EmotionResult, FactsResult, FirstBoardResult, LadderGap, MoneyEffect, Promotion, ThemesResult } from "./types";

export interface TodayPanels {
  emotion: Panel<EmotionResult>;
  facts: Panel<FactsResult>;
  themes: Panel<ThemesResult>;
  firstboard: Panel<FirstBoardResult>;
  cycle: Panel<CycleResult>;
  ladder: Panel<BoardLadderResult>;
}

/** 一块还在取 / 没取到时占的位;取到了才把内容画出来 */
export function Slot<T>({ p, title, children, minH = "min-h-[8rem]" }: { p: Panel<T>; title: string; children: (r: T) => ReactNode; minH?: string }) {
  if (p.state === "loading") {
    return <div className={`glass flex items-center justify-center p-4 ${minH}`}><p role="status" className="text-sm text-muted-foreground">{title}加载中…</p></div>;
  }
  if (!p.result) {
    return (
      <div className={`glass p-4 ${minH}`}>
        <h3 className="mb-1 text-sm font-semibold">{title}</h3>
        <p role="status" className="text-sm text-muted-foreground">这次没取到:{p.why || "原因不明"}。不代表没有,可点右上角刷新重试。</p>
      </div>
    );
  }
  return <>{children(p.result)}</>;
}

const OFF = { available: false } as const;

export function TodayTab({ day, panels }: { day: string | null; panels: TodayPanels }) {
  const { emotion, facts, themes, firstboard, cycle, ladder } = panels;
  const e = emotion.state === "done" ? emotion.result : null;

  useAiPage(day ? {
    key: `shortline:today:${day}`,
    title: `情绪复盘 ${day}`,
    context: todaySummary(day, panels),
    suggestions: [
      "这一天短线情绪在什么温度?依据是哪几项读数",
      "亏钱效应集中在哪个板位?和封板质量对得上吗",
      "哪些题材在延续、哪些接力断档?证据够不够",
      "梯队断层说明了什么,还缺什么证据才能下判断",
    ],
  } : null);

  return (
    <div className="space-y-4">
      {e && (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
          <span>复盘日 <b className="text-foreground">{e.date}</b>{e.prev_date && <>,对比前一交易日 {e.prev_date}</>}</span>
          {e.promotion?.limit_up_count != null && (
            <span>涨停 <b className="text-danger">{e.promotion.limit_up_count}</b> 家(前一交易日 {e.promotion.prev_limit_up_count ?? "—"} 家)</span>
          )}
        </div>
      )}
      {e?.settled === false && (
        <p role="status" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          这一天还没收盘(或东财还没定稿):下面的数字收盘前还会变,也不会存成快照。
        </p>
      )}

      {/* 1. 昨天涨停的今天赚不赚钱 */}
      <Slot p={emotion} title="情绪四项" minH="min-h-[10rem]">
        {(r) => (
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
            <MoneyEffectCard me={r.money_effect ?? (OFF as MoneyEffect)} />
            <PromotionCard pr={r.promotion ?? (OFF as Promotion)} />
            <ConsecPremiumCard cp={r.consec_premium ?? (OFF as ConsecPremium)} />
            <LadderCard lg={r.ladder_gap ?? (OFF as LadderGap)} />
          </div>
        )}
      </Slot>

      {/* 2. 各个高度有谁、昨天那层接上了几只 */}
      <Slot p={ladder} title="连板天梯">{(l) => <BoardLadderPanel r={l} />}</Slot>

      {/* 3. 钱亏在哪个板位、板封得结不结实 */}
      <Slot p={facts} title="盘面事实">
        {(f) => (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Matrix fm={f.feedback} />
            <div className="space-y-4">
              <LossEffectSection le={f.loss_effect} />
              <SealQualitySection sq={f.seal_quality} />
            </div>
          </div>
        )}
      </Slot>

      {/* 4. 钱在哪些题材 */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Slot p={themes} title="题材事件树">{(t) => <ThemeTreeView t={t.tree} />}</Slot>
        <div className="space-y-4">
          <Slot p={cycle} title="情绪周期">{(c) => <CycleCard cy={c.cycle ?? OFF} />}</Slot>
          {facts.state === "done" && facts.result && <Themes ts={facts.result.themes} />}
        </div>
      </div>

      {/* 5. 事件与分制度 */}
      {facts.state === "done" && facts.result && (
        <div className="space-y-4">
          <Ledger el={facts.result.events} />
          <BoardSystemSection bb={facts.result.by_board} />
        </div>
      )}

      {/* 6. 首板名单 */}
      <Slot p={firstboard} title="首板名单">{(fb) => <FirstBoardPanel fb={fb} />}</Slot>
    </div>
  );
}
