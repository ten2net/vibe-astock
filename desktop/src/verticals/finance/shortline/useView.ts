/**
 * 情绪复盘的其余分页(近 5 天 / 情绪历史 / 明日验证 / 涨停样本 / 结构变化)各取一个后端视图。
 * 换日期、换窗口时作废旧请求;页面右上角「刷新」让当前分页带 refresh=1 重取一次。
 */
import { useEffect, useRef, useState } from "react";
import { backend, type ShortlineViewId } from "@/lib/backend";
import { cleanReason } from "./api";

/** `stale`:静默重读没取到,`data` 是上一次取到的内容 */
export type ViewState<T> = { state: "loading" } | { state: "done"; data: T; stale?: string } | { state: "failed"; why: string };

/**
 * 重读失败怎么落。静默重读(保存后重读、AI 复盘写作中每 3 秒一次)已有内容就留着,只另记一句这次没取到:
 * 换成「失败」会让写作中的进度消失、轮询也跟着停(轮询看的是上一次取到的 run 写完没有)。
 */
export function failedView<T>(prev: ViewState<T>, why: string, quiet: boolean): ViewState<T> {
  return quiet && prev.state === "done" ? { state: "done", data: prev.data, stale: why } : { state: "failed", why };
}

export function useShortlineView<T>(id: ShortlineViewId, day: string | null, days: number | undefined, refreshNonce: number, onBusy?: (busy: boolean) => void) {
  const [st, setSt] = useState<ViewState<T>>({ state: "loading" });
  const [reloads, setReloads] = useState(0);
  const seenNonce = useRef(refreshNonce);
  const seenReloads = useRef(reloads);
  useEffect(() => {
    if (!day) return;
    const refresh = seenNonce.current !== refreshNonce;
    seenNonce.current = refreshNonce;
    // 保存后重读:先留着旧内容(编辑框和「已保存」提示不闪掉),新的回来再换
    const quiet = seenReloads.current !== reloads;
    seenReloads.current = reloads;
    const ctl = new AbortController();
    if (!quiet) setSt({ state: "loading" });
    onBusy?.(true);
    backend.shortlineView<T>(id, { date: day, days, refresh }, ctl.signal)
      .then((data) => { if (!ctl.signal.aborted) setSt({ state: "done", data }); })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        const why = cleanReason(e instanceof Error ? e.message : String(e));
        setSt((prev) => failedView(prev, why, quiet));
      })
      .finally(() => { if (!ctl.signal.aborted) onBusy?.(false); });
    return () => { ctl.abort(); onBusy?.(false); };
    // onBusy 是父组件的 setState,不会变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, day, days, refreshNonce, reloads]);
  /** 写完(保存条件、登记事件)后重读一遍,不带 refresh */
  const reload = () => setReloads((n) => n + 1);
  return [st, reload] as const;
}
