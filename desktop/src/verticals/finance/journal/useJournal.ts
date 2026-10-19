/**
 * 交易日志页取数:主视图一份(进页面取一次,写完用写动作带回来的新视图换掉),
 * 三个要取行情的慢视图(最大浮盈浮亏 / 判断与执行归因 / 环境分组)由用到的分页各自取。
 * 🔴 这些数据只给界面,不登记 AI 页面上下文。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, backend } from "@/lib/backend";
import type { JournalView } from "@/lib/journal";
import { serialQueue } from "@/lib/serialQueue";

export type Load<T> = { state: "loading" } | { state: "done"; data: T } | { state: "failed"; why: string };
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type JournalAction = Parameters<typeof backend.journalAct>[0];

export function useJournal() {
  const [st, setSt] = useState<Load<JournalView>>({ state: "loading" });
  // 视图换过一次就加一:慢视图跟着重取(记了一笔、改了费率,浮盈浮亏和归因都会变)
  const [revision, setRevision] = useState(0);
  // 已经有内容时重读失败:内容留着,另外说一句这次没读到
  const [staleWhy, setStaleWhy] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  // 写动作排队:先点的先写、先回来,后回来的视图一定更新(见 serialQueue)
  const queue = useRef(serialQueue());

  const reload = useCallback(() => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setBusy(true);
    backend.journal(c.signal)
      .then((data) => { if (!c.signal.aborted) { setSt({ state: "done", data }); setStaleWhy(null); setRevision((n) => n + 1); } })
      .catch((e: unknown) => {
        if (c.signal.aborted) return;
        setStaleWhy(errText(e));
        setSt((prev) => (prev.state === "done" ? prev : { state: "failed", why: errText(e) }));
      })
      .finally(() => { if (!c.signal.aborted) setBusy(false); });
  }, []);

  useEffect(() => { reload(); return () => ctl.current?.abort(); }, [reload]);

  /**
   * 写一次。失败照原样抛给调用方显示;「成交记上了、标注没写」也要重读,页面才看得到那几笔。
   * 写完会掐掉还在路上的重读:它读的可能是这次写之前的台账。
   */
  const act = useCallback((body: JournalAction) => queue.current(async () => {
    try {
      const r = await backend.journalAct(body);
      ctl.current?.abort();
      setBusy(false);
      setSt({ state: "done", data: r.view });
      setStaleWhy(null);
      setRevision((n) => n + 1);
      return r.result;
    } catch (e) {
      if (e instanceof ApiError && e.code === "partial") reload();
      throw e;
    }
  }), [reload]);

  return { st, staleWhy, busy, revision, reload, act };
}

/** 慢视图:revision 变了或点了刷新就重取;取的时候旧结果先留着(不闪成「加载中」) */
export function useJournalExtra<T>(id: "journal_excursion" | "journal_attribution" | "journal_env", revision: number, enabled: boolean) {
  const [st, setSt] = useState<Load<T>>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!enabled || revision === 0) return;
    const c = new AbortController();
    setBusy(true);
    backend.journalExtra<T>(id, c.signal)
      .then((data) => { if (!c.signal.aborted) setSt({ state: "done", data }); })
      .catch((e: unknown) => { if (!c.signal.aborted) setSt({ state: "failed", why: errText(e) }); })
      .finally(() => { if (!c.signal.aborted) setBusy(false); });
    return () => { c.abort(); setBusy(false); };
  }, [id, revision, enabled]);
  return { st, busy };
}
