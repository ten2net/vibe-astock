import path from "node:path";

import { readConfiguredDataRoot, resolveDataRoot } from "../orchestrator/src/data_root.ts";

/**
 * Vite 与编排器必须从同一个数据根找 API token。
 * README 的两个启动命令都从仓库根执行，所以相对的 VRA_DATA_ROOT 也按仓库根解析。
 */
export function apiTokenPath(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = readConfiguredDataRoot(repoRoot);
  return path.join(resolveDataRoot(repoRoot, configured, env), "api.token");
}
