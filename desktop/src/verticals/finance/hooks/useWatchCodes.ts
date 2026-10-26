/**
 * 自选股列表的响应式订阅。
 *
 * 自选的真源在台账（`lib/watchlist.ts`），那里只有同步读 / 异步写，没有通知机制：
 * 两个地方同时对同一只票「加入 / 移除」时，各自的 useState 快照会各说各话。
 * 这里按 watchlist 的写路径（`addWatch` / `saveWatch`）挂一个乐观更新，写失败再以
 * 重读结果回滚，界面上看到的「星标亮不亮」因此立即跟上，且不会停在没写成的状态。
 *
 * 只在 `loadWatch()` 的缓存之外加一层版本号：真源仍是台账，这里不做第二份存储。
 */
import { useSyncExternalStore } from "react";
import { addWatch, loadWatch, saveWatch } from "@/lib/watchlist";

const listeners = new Set<() => void>();
/** 本 hook 自己维护的乐观序列；写失败后重读的结果以它为准 */
let optimistic: string[] | null = null;

/**
 * 🔴 快照必须是**同一个引用**直到内容真的变了。
 *    `loadWatch()` 每次返回新数组，直接当快照交给 useSyncExternalStore 会被判成
 *    「每次都变了」⇒ 无限重渲染（Maximum update depth exceeded，整页落到错误页）。
 *    所以这里缓存一份，只在 emit 前重建。
 */
let cached: string[] = loadWatch();

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** 内容变了才换引用并通知；没变就不通知，免得白白触发一轮渲染 */
function emit() {
  const next = optimistic ?? loadWatch();
  if (same(next, cached)) return;
  cached = next;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

function snapshot(): string[] {
  return cached;
}

/** 乐观置为新列表，写台账；失败就用重读结果回滚并重新抛出 */
function commit(next: string[]): Promise<void> {
  optimistic = next;
  emit();
  return saveWatch(next)
    .catch((e) => {
      optimistic = loadWatch();
      emit();
      throw e;
    })
    .finally(() => {
      // 写结束（成功或失败）都回到台账真值；内容与乐观层一致时 emit 不触发渲染
      optimistic = null;
      emit();
    });
}

export function toggleWatchOptimistic(code: string): Promise<void> {
  const cur = snapshot();
  if (cur.includes(code)) return commit(cur.filter((c) => c !== code));
  // 加一只走 addWatch（它自己排队、增量写，避免整表覆盖）；这里只负责乐观显示
  optimistic = [...cur, code];
  emit();
  return addWatch(code)
    .catch((e) => {
      optimistic = loadWatch();
      emit();
      throw e;
    })
    .finally(() => {
      optimistic = null;
      emit();
    });
}

/** 只给单测用：核对快照引用是否稳定 */
export const __watchSnapshotForTest = snapshot;

export function useWatchCodes(): { codes: string[]; toggle: (code: string) => Promise<void> } {
  const codes = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { codes, toggle: toggleWatchOptimistic };
}
