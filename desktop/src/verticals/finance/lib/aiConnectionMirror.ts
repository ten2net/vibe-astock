/**
 * 「接入 AI」订阅档连接的**服务端镜像** —— 治「测试并保存成功、页面一刷新又变未接入」。
 *
 * 根因:连接配置原来只存浏览器 localStorage,而 localStorage 按源(协议+域名+端口)隔离、
 * 还会被隐私模式 / 内嵌 WebView / 「退出清除站点数据」整个清掉。保存链路本身有写后回读校验,
 * 部署版本与源码一致 —— 数据在保存那一刻确实进了浏览器,之后被浏览器环境弄丢了。
 *
 * 这里的镜像**只收 cli-* 订阅档**(claude / codex / codebuddy):那份配置里没有密钥,
 * 凭据在各自 CLI 自己的登录态里,镜像文件(0600,用户数据区)不含任何秘密。
 * 🔴 浏览器 API key 永不落服务端(AGENTS.md 6.3)—— API 档连接不镜像,丢了就要重填 key 实测。
 *
 * 恢复口径:只有本地**完全没有**可用配置(status === "none")时才从镜像恢复;
 * 本地已有配置(含读不懂的"broken")一律不动 —— 不覆盖用户的显式选择。
 */
import { backend } from "./backend.ts";
import { readAiRuntime, saveUserLlm, type LlmConfig } from "./llmStore.ts";

const isCli = (provider: string): boolean => provider.startsWith("cli-");

/** 页面启动时调用(与 hydrateNotes/hydrateWatch 并列):本地空 → 用服务端镜像恢复订阅档连接。 */
export async function hydrateAiConnection(): Promise<void> {
  if (readAiRuntime().status !== "none") return;
  try {
    const { connection } = await backend.aiConnection();
    if (!connection || !isCli(connection.provider)) return;
    saveUserLlm({ provider: connection.provider, model: connection.model, baseURL: "", apiKey: "" });
  } catch {
    /* 镜像读不到(旧版本后端/网络抖)不是致命错误:保持未接入,用户可照常手动接入 */
  }
}

/** 「测试并保存」成功后调用:订阅档落一份服务端镜像;API 档清掉旧镜像(不替用户留过期选择)。 */
export async function mirrorAiConnection(cfg: LlmConfig): Promise<void> {
  try {
    if (isCli(cfg.provider)) await backend.saveAiConnection(cfg.provider, cfg.model);
    else await backend.clearAiConnection();
  } catch {
    /* 镜像失败不阻断本次保存 —— 本地配置已生效;下次保存会再镜像 */
  }
}

/** 「清除」连接时调用:服务端镜像一并清掉,避免换一个浏览器又把旧连接塞回来。 */
export async function clearMirroredAiConnection(): Promise<void> {
  try {
    await backend.clearAiConnection();
  } catch {
    /* 同上:镜像层失败不影响本地已完成的清除 */
  }
}
