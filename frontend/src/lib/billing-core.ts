/** v2 付费版的纯函数与内存态（无外部 import，便于 node --test 直接跑）。
 *
 * 与网络层 `billing-api.ts` 分开：这个文件不碰 fetch / apiUrl / import.meta.env /
 * api.ts，因此 Node 原生 test runner 能直接加载。设计文档 §4 / §11。
 */

export class BillingError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// 账号 JWT 只存内存，绝不落 localStorage（§11 禁止项）。
let accountToken = '';

export function setAccountToken(token: string): void {
  accountToken = token.trim();
}

export function getAccountToken(): string {
  return accountToken;
}

export function clearAccountToken(): void {
  accountToken = '';
}

/** 组装请求头：VR_API_KEY 的 Authorization + 账号 JWT 的 X-Account-Token。 */
export function buildBillingHeaders(token: string | null, base: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...base };
  if (token) headers['X-Account-Token'] = token;
  return headers;
}

/** 32-hex 请求 id（后端 pydantic 要求 ^[0-9a-f]{32}$）。 */
export function billingRequestId(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** 把最小货币单位格式化成展示价。 */
export function formatPrice(priceCents: number, currency: string): string {
  const amount = (priceCents / 100).toFixed(2);
  return currency === 'CNY' ? `¥${amount}` : `$${amount}`;
}

export interface Product {
  product_id: string;
  kind: 'subscription' | 'credit_pack';
  price_cents: number;
  currency: string;
  credits: number;
  period: string | null;
  label: string;
}

export interface Entitlement {
  user_id: string;
  credits: number;
  tier: string;
  expires_at: string | null;
}

export interface CheckoutResult {
  order_id: string;
  checkout_url: string;
  expires_at: string | null;
}

export interface ExplainResult {
  turn_id: string;
  conversation_id: string | null;
  status: string;
  charged_credits: number;
  remaining_credits: number;
}

export interface TurnStatus {
  id: string;
  status: 'running' | 'complete' | 'incomplete' | 'failed' | 'cancelled';
  result?: unknown;
  error?: string | null;
}
