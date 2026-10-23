import { useEffect, useState } from "react";

import { AI_RUNTIME_CHANGED, LLM_KEY, readAiRuntime } from "@/lib/llmStore";
import { hydrateAiConnectionOnce } from "@/lib/aiConnectionMirror";

export function useAiRuntime() {
  const [runtime, setRuntime] = useState(() => readAiRuntime());
  useEffect(() => {
    const refresh = () => setRuntime(readAiRuntime());
    const storage = (event: StorageEvent) => { if (event.key === LLM_KEY) refresh(); };
    globalThis.addEventListener(AI_RUNTIME_CHANGED, refresh);
    globalThis.addEventListener("storage", storage);
    // 自愈:main.tsx 启动那轮恢复若失败(后端没起好/网络抖),组件挂上来时仍无配置就再试一轮。
    // 恢复成功后 saveUserLlm 触发 AI_RUNTIME_CHANGED,这里自然刷新成「已接入」。
    if (readAiRuntime().status === "none") void hydrateAiConnectionOnce();
    return () => {
      globalThis.removeEventListener(AI_RUNTIME_CHANGED, refresh);
      globalThis.removeEventListener("storage", storage);
    };
  }, []);
  return runtime;
}
