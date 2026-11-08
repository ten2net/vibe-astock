/** v2 Pro 付费版 API 客户端（网络层，设计文档 §4 / §12-3）。
 *
 * 与 `api.ts` 的关键区别：账号 JWT 走 **`X-Account-Token`** 头，不占 `Authorization`
 * （那个头归 `VR_API_KEY`，由 `authHeaders()` 提供）。JWT **只存内存、不落 localStorage**
 * （§11 禁止项）；付费状态一律以服务端 `/entitlement` 为准，前端不缓存、不判定。
 *
 * 纯函数/内存态在 `billing-core.ts`（无外部 import，便于 node --test）。
 * 所有 /api 路径过 `apiUrl()`（子路径部署）与后端 `_vr_guard`（Host 白名单）。
 */
import { apiUrl } from './base';
import { authHeaders } from './api';
import {
  BillingError, billingRequestId, buildBillingHeaders, getAccountToken,
  type CheckoutResult, type Entitlement, type ExplainResult, type Product, type TurnStatus,
} from './billing-core';

// 供页面直接使用（统一从本模块导入，不必关心 core 拆分）。
export {
  BillingError, billingRequestId, buildBillingHeaders, formatPrice,
  clearAccountToken, getAccountToken, setAccountToken,
} from './billing-core';
export type {
  Product, Entitlement, CheckoutResult, ExplainResult, TurnStatus,
} from './billing-core';

async function billingRequest<T>(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
  opts: { account?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = buildBillingHeaders(
    opts.account === false ? null : getAccountToken(),
    authHeaders(),
  );
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let resp: Response;
  try {
    resp = await fetch(apiUrl(`/api${path}`), init);
  } catch {
    throw new BillingError('连接不到后端，请先在根目录启动服务', 0);
  }
  let payload: any = null;
  try {
    payload = await resp.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!resp.ok) {
    if (resp.status === 401) throw new BillingError('账号令牌无效或已过期，请在下方重新填写', 401);
    if (resp.status === 402) throw new BillingError('托管额度不足，请先购买积分包', 402);
    throw new BillingError(payload?.detail || payload?.error || `HTTP ${resp.status}`, resp.status);
  }
  return (payload?.data ?? payload) as T;
}

export const billingApi = {
  /** 商品列表只读，不需要账号 token。 */
  products: () => billingRequest<{ products: Product[] }>('/billing/products', 'GET', undefined, { account: false }),
  entitlement: () => billingRequest<Entitlement>('/billing/entitlement'),
  /** 只传 product_id，价格/币种/额度由服务端定（§5.1）。 */
  checkout: (productId: string) =>
    billingRequest<CheckoutResult>('/billing/checkout', 'POST', { product_id: productId }),
  /** Pro 托管 AI 解读：llm 由服务端注入，请求体不含任何凭据。 */
  explain: (question: string, requestId = billingRequestId()) =>
    billingRequest<ExplainResult>('/ai/explain', 'POST', { question, request_id: requestId }),
  turn: (turnId: string) => billingRequest<TurnStatus>(`/ai/turn/${encodeURIComponent(turnId)}`),
  /** gate 冒烟（不调用大模型），用于自检。 */
  echo: (prompt: string, requestId = billingRequestId()) =>
    billingRequest<{ stub: boolean; charged_credits: number; remaining_credits: number }>(
      '/ai/echo', 'POST', { prompt, request_id: requestId },
    ),
};
