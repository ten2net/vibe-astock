// 自选股快照轮询，不是逐笔实时行情。
//
// 几个刻意的选择：
// - 每次明确要求 fresh，跳过产品的 5 分钟缓存；上游仍可能延迟。
// - 请求完成后等 3 秒再取，不承诺数据每 3 秒更新。
// - **递归 setTimeout 而不是 setInterval**：单次请求实测 ~750ms，网络一慢 setInterval
//   会让请求首尾叠在一起。改成「上一次结束后再等 N 秒」，永远不会堆叠。
// - **非交易时段自动暂停**：收盘后数据不再变化，继续轮询既无意义又给上游添压。
//   手动刷新按钮仍然可用。
// - **页面切走时暂停**：用户看不到的时候不该继续消耗流量（浏览器自身也会节流后台定时器）。
// - **失败退避**：连续失败时间隔翻倍（上限 30 秒），成功后立刻复位，避免断网时疯狂重试。

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Quote } from "@/lib/api";
import { isAnyMarketTrading, tradingMarketSymbols } from "@/lib/marketSymbol";
import { startPollLoop } from "@/lib/pollLoop";
import { mergePolledQuotes, missingQuotes, noQuotesBack, quoteErrorReason, quoteFailure, quoteSnapshotTime } from "@/lib/quoteSnapshot";

export const LIVE_INTERVAL_MS = 3000;
const MAX_BACKOFF_MS = 30_000;
/**
 * 单次取数的上限。🔴 没有它，上游挂起（网络/代理不通、后端 single-flight 卡住）时
 * `fetch()` 永远 pending，`finally` 永不执行 ⇒ `loading` 永远是 true、按钮一直转圈，
 * 点刷新只是再发一个同样会挂起的请求 —— 就是「行情获取失败，刷新后还是一直转圈」。
 * 实测单次取数 ~750ms，15s 足够覆盖慢网络；超时按「这次没取到」走既有失败分支。
 */
const QUOTE_TIMEOUT_MS = 15_000;

/** 自选中任一市场开盘就轮询；空参数保留旧的 A 股语义。 */
export const isTradingHours = (codes: string[] = [], at = new Date()): boolean => isAnyMarketTrading(codes, at);

export interface LiveQuotesState {
  quotes: Record<string, Quote>;
  loading: boolean;
  /** 已显示价格中最早的源取数时刻（ms）；缺失时为 null */
  updatedAt: number | null;
  /** 轮询是否真的在跑（开关开着 ≠ 在跑：非交易时段 / 页面切走都会暂停） */
  polling: boolean;
  error: string | null;
  /**
   * 最近一次完整取数（首次 / 名单变化 / 手动刷新）取的是哪份名单（代码用逗号连起来），成功失败都算取过；
   * 还一次都没取过时是 null。用来分清「还在取」和「取过了没拿到」。
   */
  settled: string | null;
  /** 手动刷新（任何时候都可用，不受交易时段限制） */
  refresh: () => void;
}

export function useLiveQuotes(codes: string[], enabled: boolean): LiveQuotesState {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState<string | null>(null);

  // 用 ref 存最新的 codes，让轮询循环不必因为 codes 变化而重建
  const codesRef = useRef(codes);
  codesRef.current = codes;

  const failuresRef = useRef(0);
  const inFlightRef = useRef(false);
  const staleRef = useRef(false);          // 请求飞行途中自选变过 / 有请求被跳过
  /**
   * 每趟取数的序号。🔴 不能用布尔锁单独判「在途」：用户点刷新时若正有一趟在途
   * （最常见是失败后 finally 触发的补拉卡住），布尔锁会把这次手动刷新静默 return 掉，
   * 一个请求都不发、界面毫无反馈 —— 就是「行情获取失败，点刷新再试却没用」。
   * 与 core/data/useArchiveThenRefresh.ts 的 run 号同解：手动刷新另起一趟并接管，
   * 旧请求回来时 run 已过期，结果一律丢弃，不会覆盖新数据。
   */
  const runRef = useRef(0);
  /** 当前在途请求的 AbortController：手动刷新先取消它，超时也靠它把挂起的 fetch 打断 */
  const abortRef = useRef<AbortController | null>(null);
  const fetchRef = useRef<(() => Promise<boolean>) | null>(null);

  const fetchOnce = useCallback(async (onlyCodes?: string[], manual = false): Promise<boolean> => {
    const cs = onlyCodes ?? codesRef.current;
    if (!cs.length) {
      if (!onlyCodes) { setQuotes({}); setSettled(""); }
      return true;
    }
    // 在途只拦自动轮询 / 补拉；手动刷新是用户显式意图，必须穿透另起一趟。
    if (inFlightRef.current && !manual) {
      // 上一次还没回来，跳过这一拍；但要记下来，等它回来后补拉一次。
      // 否则「首次请求在飞 → 用户此时粘贴新代码」会让新代码的行情永远缺失
      // （默认不开轮询时没有下一拍来兜底，只能手动刷新）。
      staleRef.current = true;
      return true;
    }
    const run = ++runRef.current;
    // 手动刷新先掐掉上一趟（它可能正挂在后端 single-flight 上），否则新请求照样被拖住
    if (manual) abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    const timer = setTimeout(() => ctl.abort(), QUOTE_TIMEOUT_MS);
    inFlightRef.current = true;
    const requested = cs.join(",");
    setLoading(true);
    if (manual) setError(null);   // 立刻撤掉旧提示并转圈，让用户看见「收到，正在重试」
    try {
      const data = await api.quote(requested, true, ctl.signal);
      if (run !== runRef.current) return false;   // 已被手动刷新取代，旧结果作废
      // 200 但一只都没回来（上游空表、代码全部对不上）不能当成「成功」：以前这里把空表整体替换上去，
      // 页面每行显示「—」又不报错，点刷新还是空。按失败处理，让提示和撤价逻辑照常生效。
      const asked = onlyCodes ?? cs;
      if (noQuotesBack(asked.map((c) => c.trim()), data)) throw new Error("empty_quotes");
      // 自动轮询只拉开盘市场，必须与休市市场已有快照合并（这一轮问了却没返回的不留旧价）；首次 / 手动刷新才整体替换。
      setQuotes((prev) => mergePolledQuotes(prev, data, onlyCodes));
      // 部分没回来（比如某只被上游拒了）要单独说，别让用户对着「—」猜
      const miss = missingQuotes(asked.map((c) => c.trim()), data);
      setError(miss.length ? `这 ${miss.length} 只没取到行情：${miss.slice(0, 6).join("、")}${miss.length > 6 ? " 等" : ""}` : null);
      failuresRef.current = 0;
      return true;
    } catch (e) {
      if (run !== runRef.current) return false;   // 旧趟失败也别把提示盖到新刷新上
      failuresRef.current += 1;
      const reason = quoteErrorReason(e);
      // 🔴 真取数失败时先回退读一次「上次成功的快照」：站上明明有快照（本机实测
      //    tx_quotes_batch 快照每分钟都在写），以前一律撤价 → 名称/代码外的列全变
      //    「—」，用户以为行情彻底没了。能读到就显示快照并如实说明原因。
      const snapCtl = new AbortController();
      const snapTimer = setTimeout(() => snapCtl.abort(), QUOTE_TIMEOUT_MS);
      try {
        const snap = await api.quote(requested, false, snapCtl.signal);
        if (run !== runRef.current) return false;       // 期间用户又点了刷新，以新的为准
        if (Object.keys(snap).length) {
          setQuotes((prev) => mergePolledQuotes(prev, snap, onlyCodes));
          setError(`行情刷新没成功（${reason}）——当前显示的是上次快照`);
          return false;
        }
      } catch {
        // 连快照也没有（新机器 / 鉴权层就挡了）：走下面的撤价提示
      } finally {
        clearTimeout(snapTimer);
      }
      // 旧价不留着当现价：手动 / 首次取数失败马上撤价提示，自动轮询连续失败才撤（见 quoteFailure）
      const failed = quoteFailure(failuresRef.current, onlyCodes, reason);
      if (failed) { setQuotes(failed.drop); setError(failed.error); }
      return false;
    } finally {
      clearTimeout(timer);
      // 只有仍在生效的那一趟才收尾：旧趟不能提前把 loading 放开、也不能触发补拉
      if (run === runRef.current) {
        abortRef.current = null;
        inFlightRef.current = false;
        setLoading(false);
        if (!onlyCodes) setSettled(requested);
        // 这一趟拉的是不是已经过期的名单？过期就立刻补一次（只补一次，不会滚雪球：
        // 补拉时 staleRef 已复位，只有再次发生变动才会再补）。
        const changed = !onlyCodes && codesRef.current.join(",") !== requested;
        if (staleRef.current || changed) {
          staleRef.current = false;
          void fetchRef.current?.();
        }
      }
    }
  }, []);
  fetchRef.current = fetchOnce;

  const refresh = useCallback(() => {
    void fetchOnce(undefined, true);
  }, [fetchOnce]);

  // 首次进入 / 自选变化：立即拉一次（与开关无关，页面总要有数据）
  useEffect(() => {
    void fetchOnce();
    return () => { abortRef.current?.abort(); };   // 名单变了 / 卸载：掐掉在途请求，别让它挂着
  }, [codes, fetchOnce]);

  // 轮询循环
  useEffect(() => {
    // 循环本身(锁、定时器、停掉后不复活)在 startPollLoop 里;每次 effect 起一条、cleanup 停掉,
    // StrictMode 的 mount→unmount→mount 也不会留下第二条。
    if (!enabled) {
      setPolling(false);
      return;
    }
    const poll = startPollLoop({
      // 没在跑也要保持一个心跳，好在开盘 / 页面切回来时自动恢复
      shouldRun: () => !document.hidden && isTradingHours(codesRef.current) && codesRef.current.length > 0,
      tick: async () => {
        const ok = await fetchOnce(tradingMarketSymbols(codesRef.current));
        return ok ? LIVE_INTERVAL_MS : Math.min(LIVE_INTERVAL_MS * 2 ** failuresRef.current, MAX_BACKOFF_MS);
      },
      idleMs: 10_000,
      onState: setPolling,
    });

    // 页面切回来时立刻重新评估，不用等下一拍（一拍还在取时什么都不做，见 startPollLoop）
    const onVisible = () => {
      if (!document.hidden) poll.kick();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      poll.stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, fetchOnce]);

  return { quotes, loading, updatedAt: quoteSnapshotTime(quotes), polling, error, settled, refresh };
}
