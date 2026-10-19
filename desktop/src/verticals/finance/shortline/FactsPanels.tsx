/**
 * 盘面事实面板:昨日强势股反馈、亏钱效应、封板质量、题材事件树、行业结构与发酵节奏、关键事件、分涨跌幅制度。
 * 移植自 Vibe AStock v2.0.0 的 MarketFactsPanel,口径说明原样保留。
 * 和 VA 的不同:外框用工作台的方框面板;题材状态的颜色改成强 = 红、弱 = 绿(和涨跌同一套);
 * 反馈矩阵的样本没取全时说出来。
 */
import { useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Layers3, ListTree, Lock, Network, Rows3, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Caliber } from "./Caliber";
import { countColor, coverageNote, finite, hhmm, pctColor, plain, rate, ratioOf, safeArray, safeRecord, signed, strengthColor, tierOrder } from "./format";
import type { BoardStat, ByBoard, EventLedger, FeedbackCell, FeedbackDetail, FeedbackMatrix, LedgerEvent, LossEffect, SealQuality, ThemeNode, ThemeRow, ThemeStructure, ThemeTree } from "./types";

export function Section({ icon: Icon, title, hint, caliber, available, reason, children }: {
  icon: LucideIcon; title: string; hint?: string; caliber?: string;
  available?: boolean; reason?: string; children: ReactNode;
}) {
  return (
    <div className="glass p-4">
      <div className="mb-1 flex items-center gap-1.5">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">{title}</h3>
        {caliber && <Caliber text={caliber} />}
      </div>
      {hint && <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
      {available === false
        ? <p className="text-[13px] text-muted-foreground">这一项没算出来:{plain(reason) || "原因不明"}</p>
        : children}
    </div>
  );
}

/** 昨日强势股反馈矩阵:按昨日板位分组,看今天各落到什么结果 */
export function Matrix({ fm }: { fm?: FeedbackMatrix }) {
  const matrix = safeRecord<FeedbackCell>(fm?.matrix);
  const tiers = Object.keys(matrix).sort((a, b) => tierOrder(a) - tierOrder(b));
  const cols = ["晋级涨停", "收红", "小跌", "跌超5%", "跌停"] as const;
  const details = [...safeArray<FeedbackDetail>(fm?.details)].sort((a, b) => (finite(a.ret) ?? 0) - (finite(b.ret) ?? 0));
  const partial = coverageNote(fm);
  return (
    <Section
      icon={Rows3}
      title="昨日强势股反馈"
      hint="昨天涨停 / 炸板的票,今天分别落到哪一档。均值只说冷热,这张表告诉你亏钱集中在哪个板位。"
      available={fm?.available}
      reason={fm?.reason}
    >
      {fm?.note && <p role="status" className="mb-2 text-xs text-muted-foreground">{fm.note}</p>}
      {partial && <p role="status" className="mb-2 text-xs text-warning">{partial}</p>}
      {tiers.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">没有可统计的板位</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] tabular-nums">
            <thead>
              <tr className="border-b border-border text-[11px] text-muted-foreground">
                <th className="py-1.5 text-left font-semibold">昨日身份</th>
                {cols.map((c) => <th key={c} className="px-1.5 py-1.5 text-right font-semibold">{c}</th>)}
                <th className="px-1.5 py-1.5 text-right font-semibold">晋级率</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => {
                const c = matrix[t]!;
                return (
                  <tr key={t} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5 font-semibold">{t}<span className="ml-1 text-muted-foreground">({c.合计})</span></td>
                    <td className={cn("px-1.5 py-1.5 text-right", countColor("up"))}>{c.晋级涨停}</td>
                    <td className="px-1.5 py-1.5 text-right">{c.收红}</td>
                    <td className="px-1.5 py-1.5 text-right text-muted-foreground">{c.小跌}</td>
                    <td className={cn("px-1.5 py-1.5 text-right", countColor("down"))}>{c["跌超5%"]}</td>
                    <td className={cn("px-1.5 py-1.5 text-right font-bold", countColor("down"))}>{c.跌停}</td>
                    <td className="px-1.5 py-1.5 text-right font-bold">{rate(c.晋级率)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {/* 明细默认折叠 —— 复盘先看矩阵,要追到具体哪只票再展开。按当天表现从差到好排 */}
      {details.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
            展开明细({details.length} 只,按当天表现从差到好)
          </summary>
          <div className="mt-2 max-h-64 overflow-y-auto">
            <table className="w-full text-[11px] tabular-nums">
              <tbody>
                {details.map((d) => (
                  <tr key={d.code} className="border-b border-border/30 last:border-0">
                    <td className="py-1 pr-2 font-semibold">{d.name}</td>
                    <td className="pr-2 text-muted-foreground">{d.code}</td>
                    <td className="pr-2 text-muted-foreground">{d.prev_tier}</td>
                    <td className={cn("pr-2 font-bold", pctColor(d.ret))}>{signed(d.ret)}</td>
                    <td className="pr-2">{d.result}</td>
                    <td className="truncate text-muted-foreground">{d.sector}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </Section>
  );
}

/**
 * 跌停按哪天的制度判。日期和取数层 shortline.py 的 ST_10PCT_FROM / CHINEXT_20PCT_FROM 是同一组
 * (测试对着那两个常量查),计算按数据那一天的规则,这里把两次改制都写出来。
 */
export const LIMIT_RULES_TEXT =
  "跌停按每只票在那一天的制度判,不是统一 10%:主板 10%;科创板 20%;创业板 2020-08-24 起 20%、之前 10%;" +
  "主板 ST 2026-07-06 起 10%、之前 5%;北交所 30%。";

/** 亏钱效应 —— 昨日涨停股今天有多疼 */
export function LossEffectSection({ le }: { le?: LossEffect }) {
  const partial = coverageNote(le);
  return (
    <Section
      icon={AlertTriangle}
      title="亏钱效应 · 昨日涨停股今天吃了多少面"
      hint="⚠️ 这一栏只统计【昨日涨停的那批票】今天的表现,不是全市场。判退潮先看昨天的强势股今天有多疼 —— 炸板率只说明板没封住,说明不了封不住之后亏多少。"
      caliber={"样本 = 昨日涨停池全部个股,收盘对收盘。\n" +
        "「跌超5%/7%」按当天收盘涨跌幅算,不看盘中最低;**恰好跌 5.00% / 7.00% 都算进去**。\n" +
        LIMIT_RULES_TEXT + "\n" +
        "⚠️ 与全市场「跌超5%」不是同一个分母:这里的分母只有昨日涨停那批(见下方样本数),\n" +
        "全市场的分母是全 A 五千多只。两个数不能直接比大小。"}
      available={le?.available}
      reason={le?.reason}
    >
      {le?.note && <p role="status" className="mb-2 text-xs text-muted-foreground">{le.note}</p>}
      {partial && <p role="status" className="mb-2 text-xs text-warning">{partial}</p>}
      <div className="grid grid-cols-3 gap-3 text-center">
        <div>
          <div className={cn("font-mono text-xl font-bold tabular-nums", countColor("down"))}>{le?.deep_loss_5_count ?? "—"}</div>
          <div className="text-[11px] text-muted-foreground">跌超5%({rate(le?.deep_loss_5_rate)})</div>
        </div>
        <div>
          <div className={cn("font-mono text-xl font-bold tabular-nums", countColor("down"))}>{le?.deep_loss_7_count ?? "—"}</div>
          <div className="text-[11px] text-muted-foreground">跌超7%({rate(ratioOf(le?.deep_loss_7_count, le?.sample))})</div>
        </div>
        <div>
          <div className={cn("font-mono text-xl font-bold tabular-nums", countColor("down"))}>{le?.limit_down_count ?? "—"}</div>
          <div className="text-[11px] text-muted-foreground">跌停({rate(ratioOf(le?.limit_down_count, le?.sample))})</div>
        </div>
      </div>
      <div className="mt-3 space-y-0.5 border-t border-border pt-2.5 text-[11px] text-muted-foreground">
        <div>样本 = 昨日涨停 <b className="text-foreground">{le?.sample ?? "—"}</b> 只 · 其中最差 <b className={countColor("down")}>{signed(le?.worst)}</b></div>
        {le?.market_limit_down != null && (
          <div>作为对照,当天<b className="text-foreground">全市场</b>跌停 <b className={countColor("down")}>{le.market_limit_down}</b> 家</div>
        )}
        {le?.prev_broken_recovery && (
          <div>
            昨日炸板股当天均 <b className={pctColor(le.prev_broken_recovery.avg)}>{signed(le.prev_broken_recovery.avg)}</b>、
            翻红 <b className="text-foreground">{rate(le.prev_broken_recovery.positive_rate)}</b>
          </div>
        )}
      </div>
    </Section>
  );
}

export function SealQualitySection({ sq }: { sq?: SealQuality }) {
  const nb = sq?.never_broken, ro = sq?.reopened, tot = sq?.total;
  return (
    <Section
      icon={Lock}
      title="封板质量"
      hint="同样是涨停,开盘秒板不炸、和炸六次尾盘回封完全是两回事。"
      caliber={"分母 = 当天**最终涨停**的个股。\n" +
        "「没炸过」+「炸后回封」= 最终涨停家数(互补的两半)。\n" +
        "「开盘秒板」是**首封时间**维度(9:35 前首封),和上面两个重叠,所以单列在下面。\n" +
        "🔴 「炸板率」的分母**不是**这里的涨停家数,而是「最终涨停 + 炸板未回封」——\n" +
        "它和「涨停里曾经开过板的比例」是两个概念,后者衡量板的成色、前者才是复盘说的炸板率。"}
      available={sq?.available}
      reason={sq?.reason}
    >
      <div className="grid grid-cols-2 gap-3 text-center">
        <div>
          <div className={cn("font-mono text-xl font-bold tabular-nums", strengthColor(true))}>{nb ?? "—"}</div>
          <div className="text-[11px] text-muted-foreground">没炸过({rate(sq?.never_broken_rate)})</div>
        </div>
        <div>
          <div className="font-mono text-xl font-bold tabular-nums text-warning">{ro ?? "—"}</div>
          <div className="text-[11px] text-muted-foreground">炸后回封</div>
        </div>
      </div>
      {nb != null && ro != null && tot != null && (
        <p className="mt-1.5 text-center text-[11px] text-muted-foreground">{nb} + {ro} = 当天涨停 <b className="text-foreground">{tot}</b> 家(这两半互补)</p>
      )}
      <div className="mt-3 border-t border-border pt-2.5 text-[11px] text-muted-foreground">
        其中<b className="text-foreground"> 开盘秒板 {sq?.opening_seconds ?? "—"} </b>家、
        <b className="text-foreground">14:30 后才封住 {sq?.late_seal ?? "—"}</b> 家
        <span className="ml-1 text-muted-foreground/70">(首封时间口径,与上面两半交叉)</span>
        <div className="mt-0.5">
          <b className="text-foreground">炸板率 {rate(sq?.broken_rate)}</b>
          (炸板未回封 {sq?.broken_pool ?? "—"} 家 ÷(炸板未回封 {sq?.broken_pool ?? "—"} + 涨停 {tot ?? "—"})家)·
          平均炸板 <b className="text-foreground">{sq?.avg_broken_times ?? "—"}</b> 次
        </div>
      </div>
    </Section>
  );
}

/** 题材状态的颜色:强(扩散、延续)红,弱(接力断档、没再涨停)绿,分歧黄,新出现蓝 */
export const STATE_TONE: Record<string, string> = {
  今日新出现: "bg-info/15 text-info",
  扩散中: "bg-danger/15 text-danger",
  延续: "bg-danger/10 text-danger",
  维持: "bg-muted text-muted-foreground",
  分歧加大: "bg-warning/15 text-warning",
  高标独活: "bg-warning/15 text-warning",
  接力断档: "bg-success/15 text-success",
  昨日题材未再涨停: "bg-success/10 text-success",
  昨日覆盖样本未见: "bg-muted text-muted-foreground",
  无昨日题材数据: "bg-muted text-muted-foreground",
};

/** 题材事件树 —— 按涨停原因里的真实事件题材聚合,不是行业分类 */
export function ThemeTreeView({ t }: { t?: ThemeTree }) {
  const themes = safeArray<ThemeNode>(t?.themes);
  return (
    <Section
      icon={Network}
      title="题材事件树"
      hint={"按涨停原因题材聚合(公开涨停揭秘或问财,源站归因非公司确认),不是行业分类 —— 「兵装重组」「间接投资长鑫科技」"
        + "这类事件在行业分类里找不到。每行按复盘顺序摆:昨日反馈 → 几点首封 → 扩散几只 → 梯队多高 → 炸了几个。"}
      available={t?.available}
      reason={t?.reason}
    >
      {themes.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">没有可聚合的题材</p>
      ) : (
        <>
          {t?.source_note && <p className="mb-2 text-xs text-muted-foreground">{t.source_note}</p>}
          <div className="space-y-2">
            {themes.map((n) => (
              <div key={n.tag} className="border-b border-border/40 pb-2 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="font-semibold">{n.tag}</span>
                  <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", STATE_TONE[n.state] || "bg-muted text-muted-foreground")}>{n.state}</span>
                  <span className="tabular-nums text-muted-foreground">
                    涨停 <b className="text-foreground">{n.limit_up}</b>(首板{n.first_boards}/连板{n.consec_boards})· 最高 <b className="text-foreground">{n.highest}</b> 板
                  </span>
                  {n.broken > 0 && <span className="text-[11px] text-warning">炸{n.broken}</span>}
                  {n.limit_down > 0 && <span className={cn("text-[11px]", countColor("down"))}>跌停{n.limit_down}</span>}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] tabular-nums text-muted-foreground">
                  {n.first_seal && <span>首封 {hhmm(n.first_seal)}{n.last_seal && n.last_seal !== n.first_seal && ` → 末封 ${hhmm(n.last_seal)}`}</span>}
                  {n.prev_members > 0 && (
                    <span>
                      昨日 {n.prev_members} 只 → 今仍涨停 <b className={strengthColor((n.continuation_rate ?? 0) >= 0.5)}>{n.prev_still_up}</b>
                      {n.continuation_rate != null && `(延续 ${rate(n.continuation_rate)})`}
                    </span>
                  )}
                  {safeArray<ThemeNode["members"][number]>(n.members).length > 0 && (
                    <span className="truncate opacity-80">
                      {safeArray<ThemeNode["members"][number]>(n.members).slice(0, 4).map((m) => `${m.name}${m.label ?? `${m.boards}板`}`).join("、")}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
            共 {t?.tag_count ?? "—"} 个事件题材 · 题材串覆盖 {t?.covered ?? "—"}/{t?.total_limit_up ?? "—"} 只涨停
            {t?.coverage_rate != null && `(${rate(t.coverage_rate)})`}
            {t?.concentration != null && ` · 头部占全市场涨停 ${rate(t.concentration)}`}
          </p>
        </>
      )}
    </Section>
  );
}

/** 行业结构 + 涨停时间分布(行业分类视角,题材看上面的事件树) */
export function Themes({ ts }: { ts?: ThemeStructure }) {
  const themes = safeArray<ThemeRow>(ts?.themes);
  const timeline = safeArray<{ slot: string; count: number }>(ts?.timeline);
  const maxSlot = Math.max(1, ...timeline.map((x) => finite(x.count) ?? 0));
  return (
    <Section
      icon={Layers3}
      title="行业结构 · 发酵节奏"
      hint="⚠️ 这是「行业分类」视角(兜底)—— 真正的题材看题材事件树。行业≠题材:同一行业可能装着完全不同的炒作原因。这里的价值主要在「涨停时间分布」。"
      available={ts?.available}
      reason={ts?.reason}
    >
      <div className="mb-3 space-y-1">
        {themes.map((t) => (
          <div key={t.sector} className="flex items-center gap-2 text-[12px] tabular-nums">
            <span className="w-20 shrink-0 truncate font-semibold" title={t.sector}>{t.sector}</span>
            <span className="flex gap-0.5">
              {Array.from({ length: Math.min(t.limit_up, 12) }).map((_, i) => <span key={i} className="h-3 w-1.5 rounded-sm bg-primary/70" />)}
            </span>
            <span className="shrink-0 text-muted-foreground">
              {t.limit_up}只 · 最高{t.highest}板
              {t.broken > 0 && <span className="text-warning"> · 炸{t.broken}</span>}
              {t.first_seal && ` · 首封 ${hhmm(t.first_seal)}`}
            </span>
            {safeArray<ThemeRow["names"][number]>(t.names).length > 0 && (
              <span className="truncate text-[10px] text-muted-foreground/80" title={safeArray<ThemeRow["names"][number]>(t.names).map((x) => `${x.name}(${x.boards}板)`).join("、")}>
                {safeArray<ThemeRow["names"][number]>(t.names).slice(0, 3).map((x) => `${x.name}${x.boards}板`).join(" ")}
              </span>
            )}
          </div>
        ))}
      </div>
      {timeline.length > 0 && (
        <div className="border-t border-border pt-2.5">
          <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground">涨停时间分布(按首次封板)</div>
          <div className="flex items-end gap-1.5">
            {timeline.map((x) => (
              <div key={x.slot} className="flex-1 text-center">
                <div className="mx-auto w-full rounded-t bg-primary/60" style={{ height: `${Math.max(3, ((finite(x.count) ?? 0) / maxSlot) * 44)}px` }} />
                <div className="mt-1 text-[10px] tabular-nums text-foreground">{x.count}</div>
                <div className="text-[9px] leading-tight text-muted-foreground">{x.slot}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {ts?.concentration != null && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          共 {ts.theme_count ?? "—"} 个方向,头部占全市场涨停 <b className="text-foreground">{rate(ts.concentration)}</b>
          {ts.concentration >= 0.3 ? "(一枝独秀)" : ts.concentration <= 0.15 ? "(高度分散)" : ""}
        </p>
      )}
    </Section>
  );
}

const TAG_TONE: Record<string, string> = {
  最高标: "bg-primary/15 text-primary",
  反复开板: "bg-warning/15 text-warning",
  题材首封: "bg-info/15 text-info",
  // 「炸板」是由强转弱的**事件警示**,不是涨跌方向,保持 danger;跌停走「跌」色(绿)
  炸板: "bg-danger/15 text-danger",
  跌停: "bg-success/20 text-success",
};

/** 关键事件账本:今天钱亏在哪 / 分歧最大的 / 今天钱赚在哪 */
export function Ledger({ el }: { el?: EventLedger }) {
  const all = safeArray<LedgerEvent>(el?.events);
  const LOSS = ["高位断板", "连板断板", "炸板", "高标跌停", "跌停"];
  const GAIN = ["最高标", "题材首封"];
  const loss = el?.loss_events ?? all.filter((e) => LOSS.includes(e.tag));
  const gain = el?.gain_events ?? all.filter((e) => GAIN.includes(e.tag));
  const split = el?.split_events ?? all.filter((e) => !LOSS.includes(e.tag) && !GAIN.includes(e.tag));

  const Row = ({ e }: { e: LedgerEvent }) => (
    <div className="flex items-center gap-2 border-b border-border/40 py-1 text-[12px] last:border-0">
      <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold", TAG_TONE[e.tag] || "bg-muted text-muted-foreground")}>{e.tag}</span>
      <span className="font-semibold">{e.name}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground">{e.code}</span>
      {e.boards > 0 && <span className="shrink-0 text-[11px] text-primary">{e.boards}板</span>}
      <span className={cn("shrink-0 tabular-nums", pctColor(e.ret))}>{signed(e.ret)}</span>
      <span className="truncate text-[11px] text-muted-foreground">{e.sector} · {e.note}</span>
    </div>
  );
  const Group = ({ title, note, list }: { title: string; note: string; list: LedgerEvent[] }) => (
    <div>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[12px] font-semibold text-foreground">{title}</span>
        <span className="text-[11px] text-muted-foreground">{note}</span>
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{list.length} 起</span>
      </div>
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {list.length ? list.map((e, i) => <Row key={`${e.code}-${e.tag}-${i}`} e={e} />) : <p className="text-[12px] text-muted-foreground">无</p>}
      </div>
    </div>
  );

  return (
    <Section
      icon={ListTree}
      title="关键事件账本"
      hint="按公开盘面规则归集已发生的关键事件。只陈述事实,不排序打分、不给参与倾向。"
      caliber={"事件是按规则自动挑的:当天最高板、炸板≥2次又回封、各题材最早封板的那只、\n" +
        "昨日板位最高的断板股(最多 6 只)、跌得最狠的(最多 5 只)。\n" +
        "「今天钱亏在哪」记的是**打板资金吃面的地方**,不是这些票都收跌 ——\n" +
        "炸板的票当天照样可能收红(冲板又掉下来、收盘还涨 7%),埋的是打板那一下。\n" +
        "「N 起」= 这一堆里有 N 只票。\n" +
        "⚠️ **按方向分三堆,堆内不排序。**\n" +
        "⚠️ 断板按**昨日板位**排,不按炸板次数:一只普通首板炸十次,信息量远不如「昨日 5 板断了」。"}
      available={el?.available}
      reason={el?.reason}
    >
      <div className="space-y-3">
        <Group title="今天钱亏在哪" note="断板 · 炸板 · 跌停" list={loss} />
        {split.length > 0 && <Group title="分歧最大的" note="反复开板后回封" list={split} />}
        <Group title="今天钱赚在哪" note="最高标 · 题材首封" list={gain} />
      </div>
    </Section>
  );
}

/** 分涨跌幅制度:10cm / 20cm / 北交所 / ST 各自的涨停与晋级 */
export function BoardSystemSection({ bb }: { bb?: ByBoard }) {
  const boards = safeRecord<BoardStat>(bb?.boards);
  const keys = Object.keys(boards).filter((k) => boards[k] && (boards[k]!.limit_up > 0 || (boards[k]!.prev_base ?? 0) > 0));
  const extinct = keys.filter((k) => boards[k]!.limit_up === 0 && (boards[k]!.prev_base ?? 0) > 0);
  const [open, setOpen] = useState(extinct.length > 0);
  if (bb?.available === false) {
    return <Section icon={Layers3} title="分涨跌幅制度" available={false} reason={bb.reason}>{null}</Section>;
  }
  if (!keys.length) return null;

  return (
    <div className="glass px-4 py-3">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full flex-wrap items-center gap-1.5 text-left">
        {open ? <ChevronDown className="h-4 w-4 text-primary" /> : <ChevronRight className="h-4 w-4 text-primary" />}
        <span className="text-sm font-semibold">分涨跌幅制度</span>
        <span className="text-[11px] text-muted-foreground">有涨停的 {keys.length} 类 · 10cm / 20cm / 北交所 / ST 的晋级生态不同,混算对不上任何一种打法</span>
        {extinct.length > 0 && (
          <span className="ml-auto rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-bold text-success">{extinct.join("、")} 当天零涨停</span>
        )}
      </button>
      {open && (
        <div className="mt-3 flex flex-wrap gap-3 border-t border-border pt-3">
          {keys.map((k) => {
            const g = boards[k]!;
            return (
              <div key={k} className="min-w-[128px] flex-1 rounded-md border border-border px-3 py-2">
                <div className="text-[12px] font-semibold">{k}</div>
                <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">涨停 <b className="text-foreground">{g.limit_up}</b> · 最高 <b className="text-foreground">{g.highest}</b> 板</div>
                <div className="text-[11px] tabular-nums text-muted-foreground">
                  晋级率 <b className="text-foreground">{bb?.prev_available === false ? "—" : rate(g.promotion_rate)}</b>
                  {(g.broken ?? 0) > 0 && <span className="text-warning"> · 炸{g.broken}</span>}
                  {(g.limit_down ?? 0) > 0 && <span className={countColor("down")}> · 跌停{g.limit_down}</span>}
                </div>
                {g.limit_up === 0 && (g.prev_base ?? 0) > 0 && <div className="mt-0.5 text-[10px] font-bold text-success">当天零涨停(昨日 {g.prev_base} 家)</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
