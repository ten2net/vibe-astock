/**
 * 「接入 AI」订阅档连接的**服务端镜像存储**(无密钥)。
 *
 * 为什么单独成模块:`runtime_provider.ts`(运行时解析兜底也要读它)被 `service.ts` 依赖,
 * 镜像逻辑放 service 里会形成 service → runtime_provider → service 的循环引用。
 *
 * 内容只有 cli-* 订阅档的 provider/model —— 凭据在各自 CLI 自己的登录态里,这个文件不含任何秘密;
 * 浏览器 API key 按纪律永不落服务端(AGENTS.md 6.3),所以 API 档连接根本不镜像。
 */
import fs from "node:fs";
import path from "node:path";

export interface MirroredAiConnection { provider: string; model: string }

export class AiConnectionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AiConnectionError";
    this.code = code;
  }
}

const AI_CONNECTION_FILE = "ai-connection.json";
const CLI_PROVIDERS = new Set(["cli-codex", "cli-claude", "cli-codebuddy"]);

export function readAiConnection(dataRoot: string): MirroredAiConnection | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataRoot, AI_CONNECTION_FILE), "utf8")) as Partial<MirroredAiConnection>;
    if (raw && typeof raw.provider === "string" && CLI_PROVIDERS.has(raw.provider) && typeof raw.model === "string" && raw.model.trim()) {
      return { provider: raw.provider, model: raw.model };
    }
    return null;
  } catch {
    return null;
  }
}

/** 镜像写入:只收订阅档 provider/model;请求里若带 apiKey 一律拒绝 —— 密钥永远不进这个文件 */
export function writeAiConnection(dataRoot: string, body: unknown): MirroredAiConnection {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (typeof b.apiKey === "string" && b.apiKey) throw new AiConnectionError("bad_ai_connection", "服务端镜像只存订阅档连接,不接受 API key");
  const provider = typeof b.provider === "string" ? b.provider : "";
  const model = typeof b.model === "string" ? b.model.trim() : "";
  if (!CLI_PROVIDERS.has(provider)) throw new AiConnectionError("bad_ai_connection", "服务端镜像只支持本机订阅 Agent(claude / codex / codebuddy)");
  if (!model || model.length > 100) throw new AiConnectionError("bad_ai_connection", "模型标识不合规");
  const conn: MirroredAiConnection = { provider, model };
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, AI_CONNECTION_FILE), JSON.stringify(conn), { mode: 0o600 });
  return conn;
}

export function removeAiConnection(dataRoot: string): void {
  try { fs.unlinkSync(path.join(dataRoot, AI_CONNECTION_FILE)); } catch { /* 没有就当作已清除 */ }
}
