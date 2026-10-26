import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import { isValidAccessToken } from "../orchestrator/src/access_token.ts";
import { ACCESS_COOKIE } from "../orchestrator/src/brand.ts";

/**
 * 远程访问模式(`scripts/start --remote`)的两道门,只装在对外的页面服务器上;本机模式与 VRA_LAN 不受影响。
 *
 * 1. 访问口令门:**每个请求**(页面、脚本、`/api`)都要带有效的访问 cookie。
 *    分享链接 `/?access=<口令>` 换成 HttpOnly cookie 后 303 跳回去掉口令的同一地址。
 *    SameSite=Lax:从聊天软件点开链接(跨站顶层跳转)能带上,别的网站发起的 POST / fetch 带不上。
 * 2. 来源校验:浏览器给了 Sec-Fetch-Site 就按它判(只认 same-origin / none;
 *    例外:从网页聊天 / 邮件点开链接是跨站的**整页打开**,GET/HEAD 且不是 /api 的放行);
 *    没给(明文 http 的老路径)才比 Origin 与 Host / X-Forwarded-Host 的**主机名**。
 *    🔴 不比 http/https:云平台的 HTTPS 在它自己的代理处就解开了,浏览器带的 Origin 是 https,
 *       这里看到的连接是 http;按协议比会把所有写请求拒成 403。不少代理还会把 Host 改成内部地址,
 *       所以有 Sec-Fetch-Site 时不再比主机名。
 */

type Next = (error?: unknown) => void;
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

export { ACCESS_COOKIE };
export const ACCESS_PARAM = "access";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

function cookieValue(req: IncomingMessage, name: string): string | null {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function firstValue(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] ?? "" : value ?? "";
  return (raw.split(",")[0] ?? "").trim();
}

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };

const DENY_HTML = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>需要访问链接</title>'
  + '<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:560px;margin:15vh auto;padding:0 20px;color:#1f2328;line-height:1.7}</style>'
  + "</head><body><h1>需要访问链接</h1>"
  + "<p>这个 Vibe AStock 页面只对拿到访问链接的人开放。请用部署者发给你的<strong>完整链接</strong>打开(链接里带 <code>access=…</code>)。</p>"
  + "<p>以前能打开、现在打不开:多半是部署者换了新链接,请向对方要新的。</p></body></html>";

function deny(req: IncomingMessage, res: ServerResponse): void {
  if (String(req.url ?? "").startsWith("/api/")) {
    res.writeHead(401, { ...NO_STORE, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "access_required", message: "访问链接无效或已失效:请用部署者发给你的完整链接重新打开页面。" }));
    return;
  }
  res.writeHead(401, { ...NO_STORE, "Content-Type": "text/html; charset=utf-8" });
  res.end(DENY_HTML);
}

/** 邀测版:受邀者令牌的到期拒绝。页面给续费链接,API 给可行动的错误码。 */
function denyTrialExpired(req: IncomingMessage, res: ServerResponse, expiresAt: string | null, renewUrl?: string): void {
  const when = expiresAt ? `(到期日 ${expiresAt.slice(0, 10)})` : "";
  const action = renewUrl ? `续费请打开:${renewUrl}` : "请联系部署者续期。";
  if (String(req.url ?? "").startsWith("/api/")) {
    res.writeHead(403, { ...NO_STORE, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "trial_expired", message: `体验期已到${when}。${action}` }));
    return;
  }
  const safeUrl = renewUrl ? renewUrl.replace(/"/g, "&quot;") : "";
  const link = renewUrl ? `<p><a href="${safeUrl}">前往续费</a></p>` : "";
  res.writeHead(403, { ...NO_STORE, "Content-Type": "text/html; charset=utf-8" });
  res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>体验期已到</title>'
    + '<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:560px;margin:15vh auto;padding:0 20px;line-height:1.7}</style>'
    + `</head><body><h1>体验期已到${when}</h1><p>${action}</p>${link}</body></html>`);
}

/**
 * 邀测版:一条受邀者令牌。token 与主口令同一套强度校验;expires_at 为 ISO 时间,
 * 过期即拒(denyTrialExpired)。令牌表由 scripts/trial.mjs 维护(0600)。
 */
export interface InviteTokenEntry { token: string; label?: string; expires_at?: string | null }

export interface InviteTokenStore { list(): InviteTokenEntry[] }

export function isInviteExpired(entry: InviteTokenEntry, now = Date.now()): boolean {
  if (!entry.expires_at) return false;
  const t = Date.parse(entry.expires_at);
  return Number.isFinite(t) && now > t;
}

/** 从 JSON 文件读令牌表(形状 {tokens: InviteTokenEntry[]}),按 mtime 缓存:mint/revoke 即改即生效。 */
export function fileInviteTokenStore(file: string): InviteTokenStore {
  let cache: { mtimeMs: number; entries: InviteTokenEntry[] } | null = null;
  return {
    list() {
      try {
        const st = fs.statSync(file);
        if (cache && cache.mtimeMs === st.mtimeMs) return cache.entries;
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { tokens?: unknown };
        const entries = (Array.isArray(raw.tokens) ? raw.tokens : [])
          .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
          .map((t) => ({ token: String(t.token ?? ""), label: typeof t.label === "string" ? t.label : undefined, expires_at: typeof t.expires_at === "string" ? t.expires_at : null }))
          .filter((t) => isValidAccessToken(t.token));
        cache = { mtimeMs: st.mtimeMs, entries };
        return entries;
      } catch {
        return cache?.entries ?? [];
      }
    },
  };
}

export interface AccessGateOptions {
  /** 部署者给的公网根地址(`--public-url`,经 VRA_PUBLIC_URL 传进来):是 https 就一律给 cookie 加 Secure */
  publicUrl?: string | null;
  maxAgeSec?: number;
  /** 邀测版:受邀者令牌表(scripts/trial.mjs 维护);给了才启用,不给行为与原来完全一致 */
  store?: InviteTokenStore;
  /** 邀测版:到期拒绝页/错误里指路的续费地址(面包多/爱发电商品页等) */
  renewUrl?: string | null;
}

const LOOPBACK_HOST = /^(?:(?:[a-z0-9-]+\.)*localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i;

/**
 * 浏览器这次是不是经 https 打开的 —— 任一证据成立就给访问 cookie 加 Secure:
 * - 部署者给的公网地址是 https;
 * - 代理标了 https(X-Forwarded-Proto / Forwarded 的 proto= / X-Forwarded-Ssl: on);
 * - 带了 Fetch Metadata(Sec-Fetch-*)且浏览器看到的主机不是本机:浏览器只对 https 与本机地址发这组头。
 * 都没有(代理把 Host 改成内部地址、也不标协议,又没给 --public-url)就判断不了,按明文处理 ——
 * 启动器因此提示部署者加 --public-url。
 */
export function requestIsHttps(req: IncomingMessage, publicUrl?: string | null): boolean {
  if (publicUrl && /^https:\/\//i.test(publicUrl)) return true;
  if (firstValue(req.headers["x-forwarded-proto"]).toLowerCase() === "https") return true;
  if (/(?:^|[;,\s])proto="?https"?(?:[;,\s]|$)/i.test(String(req.headers.forwarded ?? ""))) return true;
  if (firstValue(req.headers["x-forwarded-ssl"]).toLowerCase() === "on") return true;
  const fetchMetadata = req.headers["sec-fetch-site"] !== undefined || req.headers["sec-fetch-mode"] !== undefined;
  const host = firstValue(req.headers["x-forwarded-host"]) || firstValue(req.headers.host);
  return fetchMetadata && host !== "" && !LOOPBACK_HOST.test(host);
}

export function createAccessGate(token: string, opts: AccessGateOptions = {}): Middleware {
  if (!isValidAccessToken(token)) throw new Error("远程访问口令不合格:至少 32 位,只能用字母、数字、- 和 _");
  const maxAgeSec = opts.maxAgeSec ?? 30 * 24 * 3600;
  const expected = digest(token);
  const matches = (value: string | null) => value !== null && timingSafeEqual(digest(value), expected);
  // 邀测版:在令牌表里按常量时间比对找受邀者记录;主口令优先,表是增量能力
  const findInvite = (value: string | null): InviteTokenEntry | null | undefined => {
    if (!opts.store || value === null) return undefined;
    const hv = digest(value);
    return opts.store.list().find((e) => timingSafeEqual(hv, digest(e.token)));
  };
  return (req, res, next) => {
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://gate.invalid"); }
    catch { deny(req, res); return; }
    if (url.searchParams.has(ACCESS_PARAM)) {
      const given = url.searchParams.get(ACCESS_PARAM);
      if (matches(given)) {
        url.searchParams.delete(ACCESS_PARAM);
        const secure = requestIsHttps(req, opts.publicUrl);
        // 开头多个斜杠会被浏览器当成「换一个网站」(//evil.example):收成一个,只跳本站
        const location = `/${url.pathname.replace(/^\/+/, "")}${url.search}`;
        res.writeHead(303, {
          ...NO_STORE,
          "Set-Cookie": `${ACCESS_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`,
          Location: location,
        });
        res.end();
        return;
      }
      const invite = findInvite(given);
      if (invite === undefined) { deny(req, res); return; }
      if (isInviteExpired(invite)) { denyTrialExpired(req, res, invite.expires_at ?? null, opts.renewUrl ?? undefined); return; }
      // 受邀者:cookie 的有效期截到试用到期日,过期自然失效
      url.searchParams.delete(ACCESS_PARAM);
      const secure = requestIsHttps(req, opts.publicUrl);
      const location = `/${url.pathname.replace(/^\/+/, "")}${url.search}`;
      const expireAt = Date.parse(invite.expires_at ?? "");
      const ttl = Number.isFinite(expireAt)
        ? Math.max(60, Math.min(maxAgeSec, Math.floor((expireAt - Date.now()) / 1000)))
        : maxAgeSec;
      res.writeHead(303, {
        ...NO_STORE,
        "Set-Cookie": `${ACCESS_COOKIE}=${invite.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttl}${secure ? "; Secure" : ""}`,
        Location: location,
      });
      res.end();
      return;
    }
    if (matches(cookieValue(req, ACCESS_COOKIE))) { next(); return; }
    // 邀测版:主口令不匹配再受邀者表;过期给续费指路,没到期放行
    const invite = findInvite(cookieValue(req, ACCESS_COOKIE));
    if (invite === undefined) { deny(req, res); return; }
    if (isInviteExpired(invite)) { denyTrialExpired(req, res, invite.expires_at ?? null, opts.renewUrl ?? undefined); return; }
    next();
  };
}

function originHost(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Origin 只该是「协议 + 主机」,带路径 / 尾斜杠的一律当伪造
    return origin === `${url.protocol}//${url.host}` ? url.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * 从网页聊天、邮件里点开链接 = 跨站的**整页打开**(Sec-Fetch-Mode: navigate + Dest: document)。
 * 它已经过了口令门、只读不写,放行;接口(/api)、写请求、嵌进别人页面的 iframe 仍按来源拒。
 */
function isTopLevelPageOpen(req: IncomingMessage): boolean {
  const method = String(req.method ?? "GET").toUpperCase();
  return (method === "GET" || method === "HEAD")
    && req.headers["sec-fetch-mode"] === "navigate"
    && req.headers["sec-fetch-dest"] === "document"
    && !String(req.url ?? "").startsWith("/api");  // 与代理同口径:/api 开头的都转给后端
}

export function createRemoteOriginGuard(): Middleware {
  return (req, res, next) => {
    const site = req.headers["sec-fetch-site"];
    const origin = req.headers.origin;
    let ok = true;
    if (site !== undefined) ok = site === "same-origin" || site === "none" || isTopLevelPageOpen(req);
    else if (origin !== undefined) {
      const host = originHost(origin);
      const own = [firstValue(req.headers.host), firstValue(req.headers["x-forwarded-host"])].filter(Boolean).map((h) => h.toLowerCase());
      ok = host !== null && own.includes(host);
    }
    if (!ok) {
      res.writeHead(403, { ...NO_STORE, "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "forbidden_origin", message: "请从工作台自身页面发起请求。" }));
      return;
    }
    next();
  };
}

/** 远程模式要装的中间件(按顺序:先口令、再来源);口令不合格当场失败,不留一个没门的公网页面 */
export function remoteAccessMiddlewares(token: string | undefined,
  opts: { publicUrl?: string | null; tokensFile?: string | null; renewUrl?: string | null } = {}): Middleware[] {
  if (!isValidAccessToken(token)) {
    throw new Error("远程访问模式缺少有效的访问口令:请用 scripts/start --remote 启动(或设 VRA_ACCESS_TOKEN,至少 32 位,只能用字母、数字、- 和 _)");
  }
  // 邀测版:给了 tokensFile 才挂受邀者令牌表(主口令永远优先,不受影响)
  const store = opts.tokensFile ? fileInviteTokenStore(opts.tokensFile) : undefined;
  return [createAccessGate(token, { publicUrl: opts.publicUrl, store, renewUrl: opts.renewUrl }), createRemoteOriginGuard()];
}
