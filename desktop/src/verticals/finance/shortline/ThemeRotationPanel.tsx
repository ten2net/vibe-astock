/**
 * 题材轮动:近 5 个交易日,每个涨停题材每天有几只涨停、排第几,连续了几天、是新出现还是回流、还是退下去了。
 * 版式借鉴 GitHub 上几个短线看板的「题材热度矩阵」(只借展示思路,没有搬代码);题材口径和题材事件树同一套(同花顺涨停原因拆标签)。
 * 🔴 某天没取到画成「—」,不画成 0:那天可能这个题材照样有涨停。
 */
import { Grid3x3 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Panel } from "./api";
import { Section } from "./FactsPanels";
import { finite, safeArray } from "./format";
import type { RotationDay, RotationTheme, ThemeRotationResult } from "./types";

export const ROTATION_CALIBER =
  "题材 = 同花顺涨停揭秘的涨停原因按「+」拆出的标签(去掉国企改革、破净这类属性词),和题材事件树同一套;一只票可以同时算进几个题材。\n" +
  "格子里的数 = 那天这个题材的涨停只数(东财涨停池里、有涨停原因的),颜色越深越多;小角标 = 当天按只数排第几(并列同名次),前三加粗。\n" +
  "「连续 N 天」数到今天为止每天都有涨停;「隔 k 天回流」= 中间断了 k 天今天又有;「窗口内首次出现」= 这几天里今天才第一次有。\n" +
  "某天东财涨停池或涨停原因没取到,那一列画「—」,按缺数处理(不是 0),跨过它的「连续」「回流」「首次出现」都会注明说不准。\n" +
  "某天有沪深涨停股没有涨停原因:那天没出现的题材也画「—」(可能有),出现的只数是下限。北交所的涨停股同花顺不收录,不算进任何题材。\n" +
  "表里先列今天有涨停的前 12 个题材,再补最多 6 个昨天至少 2 只、今天一只都没有的(退下去的)。\n" +
  "涨停原因是源站编辑归因,不是公司确认。";

const mmdd = (d: string) => d.slice(5);

function Cell({ v, rank, max }: { v: number | null; rank: number | null; max: number }) {
  if (v == null) return <td className="px-1 py-1 text-center text-muted-foreground/60" title="这天没取到或说不准,按缺数处理(不是 0)">—</td>;
  if (v === 0) return <td className="px-1 py-1 text-center text-muted-foreground/40">·</td>;
  const alpha = 0.18 + 0.62 * Math.min(1, v / Math.max(1, max));
  // 浅格子上白字在浅色主题里看不清:浅的用正文色,深的用白字
  return (
    <td className="px-1 py-1 text-center">
      <span className={cn("relative inline-flex h-6 min-w-[2rem] items-center justify-center rounded px-1.5 text-xs", alpha >= 0.45 ? "text-white" : "text-foreground",
        rank != null && rank <= 3 && "font-extrabold ring-1 ring-warning/70")}
        style={{ backgroundColor: `hsl(var(--danger) / ${alpha.toFixed(2)})` }}>
        {v}
        {rank != null && <sup className="ml-0.5 text-[9px] font-normal opacity-80">#{rank}</sup>}
      </span>
    </td>
  );
}

function statusColor(t: RotationTheme): string {
  if (!t.today) return "text-success";
  if (t.status.startsWith("连续")) return "text-danger font-semibold";
  if (t.status.includes("回流") || t.status.includes("首次")) return "text-warning";
  return "text-muted-foreground";
}

function Row({ t, max }: { t: RotationTheme; max: number }) {
  const series = safeArray<number | null>(t.series), ranks = safeArray<number | null>(t.ranks);
  return (
    <tr className="border-b border-border/30 last:border-0">
      <td className="whitespace-nowrap py-1 pr-3 font-medium">{t.tag}</td>
      {series.map((v, i) => <Cell key={i} v={finite(v)} rank={finite(ranks[i])} max={max} />)}
      <td className={cn("whitespace-nowrap px-2 py-1 text-[12px]", statusColor(t))}>{t.today ? t.status : "今天退下去了"}</td>
      <td className="px-2 py-1 text-center text-[12px] tabular-nums text-muted-foreground">{t.active_days}</td>
      <td className="px-2 py-1 text-center text-[12px] tabular-nums text-muted-foreground">{t.top3_days}</td>
      <td className="max-w-56 truncate px-2 py-1 text-[11px] text-muted-foreground" title={safeArray<string>(t.members).join("、")}>{safeArray<string>(t.members).join("、") || "—"}</td>
    </tr>
  );
}

export function ThemeRotationView({ r }: { r: ThemeRotationResult }) {
  const rot = r.rotation ?? { available: false };
  if (!rot.available) return <p className="text-[13px] text-muted-foreground">题材轮动没算出来:{rot.reason || "原因不明"}</p>;
  const dates = safeArray<string>(rot.dates), days = safeArray<RotationDay>(rot.days);
  const themes = safeArray<RotationTheme>(rot.themes);
  const active = themes.filter((t) => t.today), faded = themes.filter((t) => !t.today);
  const max = Math.max(1, ...themes.flatMap((t) => safeArray<number | null>(t.series).map((v) => finite(v) ?? 0)));
  const missing = safeArray<string>(rot.missing_days), partial = safeArray<string>(rot.partial_days);
  const cols = dates.length + 5;
  return (
    <div className="space-y-2">
      {missing.length > 0 && (
        <p role="status" className="text-[12px] text-warning">
          {missing.join("、")} 没取到:那几列画「—」,按缺数处理(不是 0),跨过它们的「连续」「回流」会注明说不准。
        </p>
      )}
      {partial.length > 0 && (
        <p role="status" className="text-[12px] text-warning">
          {partial.join("、")} 有沪深涨停股没有涨停原因:那几天没出现的题材画「—」(可能有),出现的只数是下限。
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-[13px] tabular-nums">
          <thead>
            <tr className="border-b border-border/60 text-left text-[11px] text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">题材</th>
              {dates.map((d, i) => {
                const day = days[i];
                return (
                  <th key={d} className="px-1 py-1.5 text-center font-medium" title={day && !day.available ? day.reason : undefined}>
                    {mmdd(d)}
                    <span className="block text-[10px] font-normal">{day?.available ? `涨停 ${day.limit_up ?? "—"}` : "没取到"}</span>
                    {day?.available && !!day.unknown && <span className="block text-[10px] font-normal text-warning">缺原因 {day.unknown}</span>}
                  </th>
                );
              })}
              <th className="px-2 py-1.5 font-medium">状态</th>
              <th className="px-2 py-1.5 text-center font-medium">有涨停天数</th>
              <th className="px-2 py-1.5 text-center font-medium">进前三天数</th>
              <th className="px-2 py-1.5 font-medium">今天板数最高的</th>
            </tr>
          </thead>
          <tbody>
            {active.length === 0 && (
              <tr><td colSpan={cols} className="py-3 text-center text-muted-foreground">今天没有能归到题材的涨停股</td></tr>
            )}
            {active.map((t) => <Row key={t.tag} t={t} max={max} />)}
            {faded.length > 0 && (
              <tr><td colSpan={cols} className="pt-3 pb-1 text-[11px] text-muted-foreground">昨天还有 2 只以上、今天一只都没有的:</td></tr>
            )}
            {faded.map((t) => <Row key={t.tag} t={t} max={max} />)}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        这几天一共 {rot.tag_count ?? "—"} 个题材标签,表里只列今天前 {active.length} 个{faded.length > 0 && `和退下去的 ${faded.length} 个`}。客观公开榜单,非推荐 / 非预测。
      </p>
    </div>
  );
}

/** 题材轮动这一块(还在取 / 没取到 / 取到了) */
export function ThemeRotationSection({ p }: { p: Panel<ThemeRotationResult> }) {
  return (
    <Section icon={Grid3x3} title="题材轮动 · 近 5 天哪些题材在前排" caliber={ROTATION_CALIBER}>
      {p.state === "loading" ? <p role="status" className="text-[13px] text-muted-foreground">题材轮动加载中…</p>
        : !p.result ? <p role="status" className="text-[13px] text-muted-foreground">这次没取到:{p.why || "原因不明"}。不代表没有,可点右上角刷新重试。</p>
        : <ThemeRotationView r={p.result} />}
    </Section>
  );
}

/** 写给 AI 的一段:每个题材 5 天的只数(缺数写「缺」)和状态 */
export function rotationSummary(p: Panel<ThemeRotationResult>): string {
  if (p.state === "loading") return "题材轮动:还在取,先别据此下结论";
  if (!p.result) return `题材轮动:这次没取到(${p.why || "原因不明"}),不代表没有`;
  const rot = p.result.rotation;
  if (!rot?.available) return `题材轮动:没算出来(${rot?.reason ?? "原因不明"})`;
  const dates = safeArray<string>(rot.dates).map(mmdd);
  const rows = safeArray<RotationTheme>(rot.themes).map((t) =>
    `${t.tag}:${safeArray<number | null>(t.series).map((v) => (v == null ? "缺" : String(v))).join("/")}(${t.today ? t.status : "今天退下去了"},进前三 ${t.top3_days} 天)`);
  const miss = safeArray<string>(rot.missing_days), part = safeArray<string>(rot.partial_days);
  return [
    `题材轮动(近 ${dates.length} 个交易日 ${dates.join("、")} 每天的涨停只数;题材 = 同花顺涨停原因拆标签,源站编辑归因非公司确认,北交所不收录;「缺」= 那天没取到或说不准,不是 0):`,
    ...rows,
    ...(miss.length ? [`没取到的日子:${miss.join("、")}`] : []),
    ...(part.length ? [`有沪深涨停股缺原因的日子(那天没出现的题材写「缺」,出现的只数是下限):${part.join("、")}`] : []),
  ].join("\n");
}
