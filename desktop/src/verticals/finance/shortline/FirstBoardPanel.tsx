/**
 * 首板名单(东财连板数 = 1 的涨停股,按首封时间排)。移植自 Vibe AStock v2.0.0 的首板分析页。
 * 和 VA 的不同:每只票的「深入分析」不在表格里展开一段 AI 回答,而是把同一段问题放进右侧 AI 入口的输入框,
 * 用户看过再自己发(发出去用的是用户自己的 AI 额度);反包票单独标出来。
 */
import { AlertCircle, Flame, Sparkles } from "lucide-react";
import { useAiDraft } from "../../../core/ai/pageContext";
import { cn } from "@/lib/utils";
import { Caliber } from "./Caliber";
import { finite, hhmm, pctColor, safeArray, signed, yi } from "./format";
import type { FirstBoardResult, FirstBoardStock } from "./types";

/** 问 AI 这只票为什么涨停:只给已发生的客观数据,约束照 VA 原样(不预测个股、不给参与倾向) */
export function firstBoardPrompt(date: string, s: FirstBoardStock): string {
  return `交易日(${date})A 股首板涨停股「${s.name}(${s.code})」的客观数据:\n` +
    `收盘价 ${finite(s.close) ?? "未知"} 元,当日涨幅 ${signed(s.ret)},首次封板时间 ${hhmm(s.first_seal)},` +
    `炸板 ${s.broken_times} 次,成交额 ${yi(s.amount)},流通市值 ${yi(s.float_cap)},` +
    `所属行业 ${s.sector || "未知"},涨停原因题材:${s.reason || "(暂缺,需要自查)"}。\n\n` +
    "请深入分析这只股票在该交易日涨停的原因:\n" +
    "1. 查询该交易日及之前的新闻研报,结合题材串说明可能驱动;源站归因不是公司确认事实,不得用之后的新闻倒推当天原因;没有查到就直接说「新闻研报尚未核实」。\n" +
    "2. 材料只有单股数据,不能据此判定整个题材板块强度、阶段、扩散或持续性。缺少同日板块广度、梯队和历史对照时写「板块证据不足」,不要猜测情绪性一日游或产业趋势。\n" +
    "3. 按「已知事实」「尚未核实」「后续核验条件」三段,每段最多三条,全文约 300 字。首次封板 09:25 属于开盘集合竞价,不能称连续竞价中的早盘承接;炸板 0 次仅说明数据源未记录开板,不证明买盘强弱或持续性。流通市值只报原值,缺少横截面比较不能自定大中小盘。\n" +
    "后续核验条件只写需要补查的公开资料和可观察变化,不写交易动作、个股参与倾向、点位、仓位或价格预测。" +
    "个股层面只陈述已经发生的客观数据与事实;方向与强弱判断做到题材板块层面为止,且必须有这个题材板块整体的证据。不预测个股涨跌,不推荐任何标的,不构成投资建议。这是约束,不必在答案中复述。";
}

export function FirstBoardPanel({ fb }: { fb: FirstBoardResult }) {
  const draft = useAiDraft();
  const stocks = safeArray<FirstBoardStock>(fb.stocks);
  return (
    <div className="glass p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Flame className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">首板名单</h3>
        <Caliber text={
          "「炸板」为数据源记录的当日开板次数;0 表示未记录开板,不证明买盘强弱或持续性。\n" +
          "没收盘时名单是取数时点仍涨停的股票,还会变;收盘后才是最终涨停名单。\n" +
          "名单按首次封板时间从早到晚排。\n" +
          "「反包」= 东财连板数是 1,但近几天涨停过(断板后又涨停)。\n" +
          "「行业」经常只有四个字 —— 是上游把名字截到四字,不是这里显示不全;怕猜错所以不替它补全称。"
        } />
        <span className="text-xs text-muted-foreground">
          涨停 {fb.total_limit_up ?? "—"} 家 · 首板 {fb.first_count ?? "—"} 家{(fb.rebound_count ?? 0) > 0 && `(其中反包 ${fb.rebound_count})`} · 客观公开榜单,非推荐 / 非预测
        </span>
      </div>
      {fb.reason_note && (
        <p className="mb-2 flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" /> 涨停原因:{fb.reason_note}
        </p>
      )}
      {!fb.available ? (
        <p className="py-4 text-center text-sm text-muted-foreground">首板名单没取到:{fb.reason || "原因不明"}</p>
      ) : stocks.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">这一天没有首板涨停股</p>
      ) : (
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
                {["名称", "首封", "炸板", "收盘", "涨幅", "成交额", "流通市值", "涨停原因", "行业", ""].map((h) => (
                  <th key={h} className="whitespace-nowrap px-2 py-1.5 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stocks.map((s) => (
                <tr key={s.code} className="border-b border-border/30">
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <span className="font-medium">{s.name}</span> <span className="text-[10px] text-muted-foreground">{s.code}</span>
                    {s.rebound && <span className="ml-1 rounded bg-warning/15 px-1 text-[10px] font-bold text-warning">反包</span>}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono text-muted-foreground">{hhmm(s.first_seal)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono">{s.broken_times > 0 ? <span className="text-warning">{s.broken_times} 次</span> : <span className="text-muted-foreground">0</span>}</td>
                  <td className="px-2 py-1.5 font-mono">{finite(s.close) ?? "—"}</td>
                  <td className={cn("px-2 py-1.5 font-mono", pctColor(s.ret))}>{signed(s.ret)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono text-muted-foreground">{yi(s.amount)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono text-muted-foreground">{yi(s.float_cap)}</td>
                  <td className="max-w-56 px-2 py-1.5 text-[11px]">{s.reason || <span className="text-muted-foreground">—</span>}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-[11px] text-muted-foreground">{s.sector}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right">
                    {draft && (
                      <button type="button" onClick={() => draft(firstBoardPrompt(fb.date, s))} aria-label={`问 AI:${s.name}为什么涨停`} title="把这只票的问题放进右侧 AI 输入框,看过再发"
                        className="inline-flex items-center gap-1 rounded-md border border-primary/40 px-2 py-0.5 text-[11px] text-primary hover:bg-primary/10">
                        <Sparkles className="h-3 w-3" /> 问 AI
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
