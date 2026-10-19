/** 交易日志 · 交易记录:记一笔、自我体检、分组读数(情绪环境 / 板位 / 打法 / 计划 / 持有)、逐笔列表、费率 */
import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { hideIf } from "@/lib/privacy";
import {
  boardText, money, moneySigned, pctSigned, ratePct, rowState, sharesText, tone,
  type EnvRow, type EnvView, type JournalRow, type JournalView,
} from "@/lib/journal";
import { BTN_GHOST, GroupTable, Notes, Panel, Slot, Tile } from "./bits";
import { AppendFill, FeeSettings, ManualEditor, RecordForm, TagEditor, type Act } from "./forms";
import type { Load } from "./useJournal";

type Ready = Extract<JournalView, { available: true }>;
const PAGE = 100;

function Overview({ v, hide }: { v: Ready; hide: boolean }) {
  const o = v.stats.overall;
  return (
    <Panel title="自我体检" hint="只统计你自己记的交易:胜率不算持平;平均、最好、最差按盈亏百分比算,和仓位无关;净盈亏只加有成交明细、已经卖出的部分,已扣费用。">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Tile k="平均每笔" v={pctSigned(o.avg)} cls={tone(o.avg)} />
        <Tile k="胜率" v={ratePct(o.win_rate)} />
        <Tile k="最好一笔" v={pctSigned(o.best)} cls={tone(o.best)} />
        <Tile k="最差一笔" v={pctSigned(o.worst)} cls={tone(o.worst)} />
        <Tile k="净盈亏(元)" v={hideIf(hide, moneySigned(o.net_pnl))} cls={tone(o.net_pnl)} sub={`${o.money_scored} 笔有成交明细`} />
      </div>
      <p className="mt-3 border-t border-border pt-2 text-[11px] text-muted-foreground">
        共 {o.count} 笔({o.scored} 笔有盈亏)。这是对你自己历史行为的统计,不预测市场,也不给下一笔建议。
      </p>
    </Panel>
  );
}

/** 情绪环境、板位两组(要取当天的盘面,慢,单独加载) */
function EnvGroups({ env, hide }: { env: Load<EnvView>; hide: boolean }) {
  return (
    <Slot st={env} label="按入场日环境分组" slow="第一次要逐日取情绪和涨停池,可能要十几秒;取过的会缓存">
      {(e) => !e.available ? (
        <Panel title="按情绪环境 / 当时板位" hint={e.reason}><Notes items={e.gaps ?? []} kind="warn" /></Panel>
      ) : (
        <>
          <GroupTable title="按情绪环境" hide={hide} groups={e.by_regime}
            hint="同一套打法在情绪强和情绪弱的日子完全是两回事:这是最该看的一组。按入场那天的情绪分数,在你自己交易过的日子里三等分。" />
          <GroupTable title="按当时板位" hide={hide} groups={e.by_board}
            hint="你买的那天它是首板、连板、炸板,还是根本没碰涨停。" />
          <div className="lg:col-span-2">
            <Notes items={[e.note, e.unsettled_trades ? `${e.unsettled_trades} 笔入场日当天还没收盘,收盘后才分组` : null]} />
            <Notes items={e.gaps} kind="warn" />
          </div>
        </>
      )}
    </Slot>
  );
}

function Problems({ v, act }: { v: Ready; act: Act }) {
  const [msg, setMsg] = useState("");
  const drop = async (id: string, what: string) => {
    if (!window.confirm(`删掉这条${what}?删了不能恢复。`)) return;
    setMsg("");
    try { await act({ action: "delete_tag", id }); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
  };
  const tags = [...v.orphans.map((p) => ({ ...p, what: "对不上交易的标注" })), ...v.conflicts.map((p) => ({ ...p, what: "重复的标注" }))];
  if (!v.issues.length && !tags.length && !v.skipped_non_a.length && !v.orphan_dividends && !v.invalid_cards) return null;
  return (
    <Panel title="有几条记录算不了" hint="这些没进上面的统计。成交流水的问题去「我的股票」的交易流水里改;多出来的标注可以直接删。">
      <div className="space-y-1.5 text-[12px]">
        {v.issues.map((p) => (
          <p key={p.id} className="text-warning">⚠️ {p.date} {p.symbol} 的一笔流水:{p.why}</p>
        ))}
        {tags.map((p) => (
          <p key={p.id} className="flex flex-wrap items-center gap-2 text-warning">
            <span>⚠️ {p.symbol} 有一条{p.what}:{p.why}</span>
            <button type="button" onClick={() => drop(p.id, p.what)} className={BTN_GHOST}>删掉</button>
          </p>
        ))}
        {v.skipped_non_a.length > 0 && <p className="text-muted-foreground">不是 A 股股票(港美股、ETF、基金、债券等)、没算进来的代码:{v.skipped_non_a.join("、")}</p>}
        {v.orphan_dividends > 0 && <p className="text-muted-foreground">{v.orphan_dividends} 笔分红找不到对应的持有期,没算进盈亏。</p>}
        {v.invalid_cards > 0 && <p className="text-warning">⚠️ {v.invalid_cards} 张模式卡不合台账规则,没参与统计(可能在台账里被改过)。</p>}
        {msg && <p role="status" className="text-destructive">{msg}</p>}
      </div>
      <Link to="/my-stocks?tab=hold" className="mt-2 inline-block text-[12px] text-primary hover:underline">去「我的股票」看交易流水</Link>
    </Panel>
  );
}

function EnvCell({ e, env }: { e: EnvRow | undefined; env: Load<EnvView> }) {
  if (env.state === "loading") return <span className="text-muted-foreground/60">…</span>;
  if (!e) return <span className="text-muted-foreground/60">—</span>;
  if (e.regime === null) return <span className="text-muted-foreground/60">当天未收盘</span>;
  // 读数取到了、只是你交易过的日子还太少,不三等分:别写成「环境未覆盖」又跟着一个赚钱效应
  const fewDays = e.regime === "环境未覆盖" && e.score !== null;
  return (
    <span className="text-muted-foreground" title={fewDays ? "取到情绪读数的交易日还太少,暂不分强中弱" : undefined}>
      {fewDays ? "天数少 · 不分强中弱" : e.regime}
      {e.money_effect !== null && <> · 赚钱效应 <span className={tone(e.money_effect)}>{pctSigned(e.money_effect)}</span></>}
    </span>
  );
}

function MoneyCell({ r, hide }: { r: JournalRow; hide: boolean }) {
  const ep = r.episode;
  if (!ep) return <span className="text-muted-foreground/60">补记</span>;
  const est = ep.fees_are_estimated ? " · 费估" : "";
  if (ep.closed) {
    return (
      <span className="text-muted-foreground" title={ep.gross_pnl !== null && ep.fees !== null && !hide ? `毛 ${money(ep.gross_pnl)} − 费用 ${money(ep.fees)}` : undefined}>
        <b className={tone(ep.realized_pnl)}>{hideIf(hide, moneySigned(ep.realized_pnl))}</b>
        <span className="text-[10px]">{est}</span>
        {ep.hold_days !== null && ` · 持 ${ep.hold_days} 天`}
        {ep.settlement_warning && <span className="text-warning" title={ep.settlement_warning}> · 底仓未核</span>}
      </span>
    );
  }
  return (
    <span className="text-muted-foreground">
      <span className="text-warning">没卖完</span> · {hideIf(hide, sharesText(ep.open_shares))} 股
      {ep.realized_pnl !== null
        ? <> · 已卖部分 <b className={tone(ep.realized_pnl)}>{hideIf(hide, moneySigned(ep.realized_pnl))}</b></>
        : <> · 占用 {hideIf(hide, money(ep.amount))}</>}
    </span>
  );
}

type Editing = { key: string; what: "tag" | "manual" | "fill" } | null;

function TradeTable({ v, env, hide, act }: { v: Ready; env: Load<EnvView>; hide: boolean; act: Act }) {
  const [shown, setShown] = useState(PAGE);
  const [editing, setEditing] = useState<Editing>(null);
  const [msg, setMsg] = useState("");
  const envBy = useMemo(() => new Map(env.state === "done" && env.data.available ? env.data.rows.map((e) => [e.key, e]) : []), [env]);
  const rows = v.rows.slice(0, shown);
  const toggle = (key: string, what: "tag" | "manual" | "fill") => setEditing((cur) => (cur?.key === key && cur.what === what ? null : { key, what }));
  const drop = async (r: JournalRow) => {
    if (!r.tag_id) return;
    const ask = r.kind === "manual" ? "删掉这条补记?删了不能恢复。" : "清掉这笔交易的标注(打法、按计划、备注、止损)?成交流水不受影响。";
    if (!window.confirm(ask)) return;
    setMsg("");
    try { await act({ action: "delete_tag", id: r.tag_id }); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
  };
  if (!v.rows.length) {
    return (
      <div className="glass py-12 text-center text-sm text-muted-foreground">
        还没有记录。记第一笔试试:入场那天的情绪和板位会自动对上。
        <p className="mt-2 text-[12px]">用过旧版 Vibe AStock?到<Link to="/settings" className="text-primary hover:underline">「接入 AI」</Link>页最下面的「从旧版导入」把以前的记录搬过来。</p>
      </div>
    );
  }
  return (
    <Panel title={`逐笔(${v.rows.length} 笔)`} hint="入场日新的在前。成交要改要删去「我的股票」的交易流水;这里改的是打法、备注、止损这些标注。"
      actions={<Link to="/my-stocks?tab=hold" className="text-[12px] text-primary hover:underline">去改成交流水</Link>}>
      {msg && <p role="status" className="mb-2 text-[12px] text-destructive">{msg}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] text-[12px] tabular-nums">
          <thead>
            <tr className="border-b border-border text-[11px] text-muted-foreground">
              {["入场日", "标的", "打法", "盈亏", "金额 / 持有", "当时情绪", "当时板位", "备注", ""].map((h, i) => (
                <th key={i} className="px-2 py-2 text-left font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const state = rowState(r);
              const e = envBy.get(r.key);
              const open = editing?.key === r.key ? editing.what : null;
              return (
                <Fragment key={r.key}>
                  <tr className="border-b border-border/40 align-top last:border-0">
                    <td className="whitespace-nowrap px-2 py-2">{r.date}</td>
                    <td className="whitespace-nowrap px-2 py-2">
                      <b>{r.name || r.symbol}</b>{r.name && r.name !== r.symbol && <span className="ml-1 text-[10px] text-muted-foreground">{r.symbol}</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2">
                      {r.playbook ? <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{r.playbook}</span> : <span className="text-muted-foreground/60">—</span>}
                      {r.as_planned === false && <span className="ml-1 text-[10px] text-warning">计划外</span>}
                      {r.as_planned === true && <span className="ml-1 text-[10px] text-muted-foreground">按计划</span>}
                    </td>
                    <td className={cn("whitespace-nowrap px-2 py-2 font-semibold", tone(r.pnl_pct))}>{pctSigned(r.pnl_pct)}</td>
                    <td className="px-2 py-2"><MoneyCell r={r} hide={hide} /></td>
                    <td className="px-2 py-2"><EnvCell e={e} env={env} /></td>
                    <td className="whitespace-nowrap px-2 py-2 text-muted-foreground">{env.state === "loading" ? "…" : boardText(e)}</td>
                    <td className="max-w-[220px] px-2 py-2 text-muted-foreground">
                      <span className="line-clamp-2" title={r.note}>{r.note}</span>
                      {r.planned_stop !== null && (
                        <span className="block text-[10px] text-muted-foreground/80">
                          止损 {hideIf(hide, String(r.planned_stop))}{r.planned_target !== null && ` · 目标 ${hideIf(hide, String(r.planned_target))}`}
                          {r.plan_late && <span className="text-warning"> · 事后补</span>}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        {state === "open" && <button type="button" onClick={() => toggle(r.key, "fill")} className={BTN_GHOST}>补成交</button>}
                        <button type="button" onClick={() => toggle(r.key, r.kind === "manual" ? "manual" : "tag")} className={BTN_GHOST}>
                          {r.kind === "manual" ? "改" : "标注"}
                        </button>
                        {r.tag_id && (
                          <button type="button" onClick={() => drop(r)} title={r.kind === "manual" ? "删掉这条补记" : "清掉标注"} aria-label={r.kind === "manual" ? "删掉这条补记" : "清掉标注"}
                            className="p-1 text-muted-foreground/60 hover:text-destructive">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {open && (
                    <tr className="border-b border-border/40 bg-muted/20">
                      <td colSpan={9} className="px-2 py-3">
                        {open === "tag" ? <TagEditor row={r} playbooks={v.playbooks} hide={hide} act={act} onDone={() => setEditing(null)} />
                          : open === "manual" ? <ManualEditor row={r} playbooks={v.playbooks} act={act} onDone={() => setEditing(null)} />
                          : <AppendFill row={r} today={v.today} hide={hide} act={act} onDone={() => setEditing(null)} />}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {v.rows.length > shown && (
        <button type="button" onClick={() => setShown((n) => n + PAGE)} className={cn(BTN_GHOST, "mt-3")}>
          再显示 {Math.min(PAGE, v.rows.length - shown)} 笔(还有 {v.rows.length - shown} 笔)
        </button>
      )}
    </Panel>
  );
}

export function RecordsTab({ v, env, hide, act }: { v: Ready; env: Load<EnvView>; hide: boolean; act: Act }) {
  const openBy = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of v.episodes) if (!e.closed) m.set(e.symbol, e.open_shares);
    return m;
  }, [v.episodes]);
  return (
    <div className="space-y-4">
      <Panel title="记一笔">
        <RecordForm today={v.today} playbooks={v.playbooks} hide={hide} act={act} openShares={(s) => openBy.get(s)} />
      </Panel>
      <Problems v={v} act={act} />
      <Overview v={v} hide={hide} />
      <div className="grid gap-4 lg:grid-cols-2">
        <EnvGroups env={env} hide={hide} />
        <GroupTable title="按打法" hide={hide} groups={v.stats.by_playbook} hint="打板、低吸、接力……哪种更适合你。没填打法的单独一组。" />
        <GroupTable title="按是否按计划" hide={hide} groups={v.stats.by_planned} hint="「计划外」的单子是不是亏得更多:最容易发现纪律问题的一组。" />
        <GroupTable title="按持有周期" hide={hide} groups={v.stats.by_hold} hint="按自然日分组;同日买卖不等于核实过能做 T。" />
      </div>
      <TradeTable v={v} env={env} hide={hide} act={act} />
      <section className="glass p-4 sm:p-5"><FeeSettings settings={v.settings} act={act} /></section>
    </div>
  );
}
