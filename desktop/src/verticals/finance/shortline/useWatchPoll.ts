/**
 * 盯盘 · 实时动态的轮询。做法照 hooks/useLiveQuotes.ts:
 * - 递归 setTimeout:上一次回来再等,请求永不叠加;等多久听后端回的 `poll_ms`(连续竞价 3 秒,竞价 / 午休 15 秒,其余 60 秒);
 * - 页面切走时停(后台不再取行情,异动也就不判断),切回来立刻问一次;
 * - 失败退避:连续失败间隔翻倍,上限 30 秒;成功复位。上一次的内容留着,但标出「这次没取到」。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { backend } from "@/lib/backend";
import { cleanReason } from "./api";
import type { WatchView } from "./watchTypes";

const BASE_MS = 3000;
const MAX_BACKOFF_MS = 30_000;
const HIDDEN_HEARTBEAT_MS = 10_000;

export interface WatchPoll {
  data: WatchView | null;
  /** 最近一次没取到的原因(取到就清掉) */
  error: string | null;
  /** 页面切走时为 false */
  live: boolean;
  /** 收到最近一次结果的本机时刻(ms) */
  receivedAt: number | null;
  refresh: () => void;
}

/** 下一次隔多久:成功听后端;失败按连续失败次数翻倍 */
export function nextDelay(okMs: number | null, failures: number): number {
  if (failures <= 0) return okMs && okMs > 0 ? okMs : BASE_MS;
  return Math.min(BASE_MS * 2 ** failures, MAX_BACKOFF_MS);
}

export function useWatchPoll(): WatchPoll {
  const [data, setData] = useState<WatchView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const kick = useRef<(() => void) | null>(null);

  useEffect(() => {
    // cancelled / timer / ctl 都是这一次 effect 的局部变量:StrictMode 重挂时旧循环不会复活
    let cancelled = false;
    let timer: number | null = null;
    let ctl: AbortController | null = null;
    let failures = 0;
    let lastMs: number | null = null;
    let inFlight = false;
    const clear = () => { if (timer !== null) { window.clearTimeout(timer); timer = null; } };

    const loop = async () => {
      if (cancelled || inFlight) return;
      clear();
      if (document.hidden) {
        setLive(false);
        timer = window.setTimeout(loop, HIDDEN_HEARTBEAT_MS);
        return;
      }
      setLive(true);
      inFlight = true;
      ctl = new AbortController();
      try {
        const v = await backend.shortlineWatchPoll<WatchView>(ctl.signal);
        if (cancelled) return;
        setData(v);
        setError(null);
        setReceivedAt(Date.now());
        failures = 0;
        lastMs = v.poll_ms;
      } catch (e) {
        if (cancelled) return;
        failures += 1;
        setError(cleanReason(e instanceof Error ? e.message : String(e)) || "原因不明");
      } finally {
        inFlight = false;
      }
      if (cancelled) return;
      timer = window.setTimeout(loop, nextDelay(lastMs, failures));
    };
    kick.current = () => { void loop(); };
    void loop();

    const onVisible = () => { if (!document.hidden && !cancelled) void loop(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clear();
      ctl?.abort();
      kick.current = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const refresh = useCallback(() => kick.current?.(), []);
  return { data, error, live, receivedAt, refresh };
}
