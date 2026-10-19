import { useEffect, useState } from "react";

import { AI_RUNTIME_CHANGED, LLM_KEY, readAiRuntime } from "@/lib/llmStore";

export function useAiRuntime() {
  const [runtime, setRuntime] = useState(() => readAiRuntime());
  useEffect(() => {
    const refresh = () => setRuntime(readAiRuntime());
    const storage = (event: StorageEvent) => { if (event.key === LLM_KEY) refresh(); };
    globalThis.addEventListener(AI_RUNTIME_CHANGED, refresh);
    globalThis.addEventListener("storage", storage);
    return () => {
      globalThis.removeEventListener(AI_RUNTIME_CHANGED, refresh);
      globalThis.removeEventListener("storage", storage);
    };
  }, []);
  return runtime;
}
