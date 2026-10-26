#!/usr/bin/env node
/**
 * 邀测版令牌管理:给受邀者发 30 天(可自定义)体验链接,到期自动拒并指路续费。
 *
 * 用法:
 *   node scripts/trial.mjs add 张三 [--days 30] [--base https://a2.luckybrother.cc]
 *   node scripts/trial.mjs list
 *   node scripts/trial.mjs extend <口令前6位> [--days 30]
 *   node scripts/trial.mjs revoke <口令前6位>
 *
 * 令牌表:<仓库>/.local/access.tokens.json(0600)。首次 add 会把主口令
 * (scripts/start 生成的 .local/access.token)以 master 身份种进表里 ——
 * 之后页面服务器(VRA_ACCESS_TOKENS_FILE)主口令与受邀者口令都认,主口令永不失效。
 * 不配置 VRA_ACCESS_TOKENS_FILE 时本表不影响任何行为(纯记账)。
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const storeFile = path.join(repoRoot, ".local", "access.tokens.json");
const masterFile = path.join(repoRoot, ".local", "access.token");

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    return { tokens: Array.isArray(raw.tokens) ? raw.tokens : [] };
  } catch {
    return { tokens: [] };
  }
}
function writeStore(store) {
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), { mode: 0o600 });
}
/** 首次使用把主口令种进表里:启用受邀者模式后主口令行为不变 */
function ensureMaster(store) {
  if (store.tokens.some((t) => t.role === "master")) return store;
  const master = fs.readFileSync(masterFile, "utf8").trim();
  if (!master) throw new Error("主口令文件缺失:.local/access.token");
  store.tokens.unshift({ token: master, label: "master", role: "master", created_at: new Date().toISOString(), expires_at: null });
  return store;
}
const fmtDay = (d) => d.toISOString().slice(0, 10);
const findByPrefix = (store, prefix) => {
  const hit = store.tokens.filter((t) => t.token.startsWith(prefix));
  if (hit.length !== 1) throw new Error(`口令前缀 ${prefix} 匹配到 ${hit.length} 条,给更长的前缀`);
  return hit[0];
};

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? (rest[i + 1] ?? true) : fallback;
};

if (cmd === "add") {
  const label = rest[0];
  if (!label) { console.error("用法: trial.mjs add <称呼> [--days 30] [--base <公网根地址>]"); process.exit(1); }
  const days = Number(flag("days", 30));
  const base = String(flag("base", "https://a2.luckybrother.cc")).replace(/\/+$/, "");
  const store = ensureMaster(readStore());
  const token = randomBytes(24).toString("base64url");
  const expires = new Date(Date.now() + days * 24 * 3600 * 1000);
  store.tokens.push({ token, label, role: "trial", created_at: new Date().toISOString(), expires_at: expires.toISOString() });
  writeStore(store);
  console.log(`已发给 ${label}:${days} 天体验(至 ${fmtDay(expires)})`);
  console.log(`邀请链接:${base}/?access=${token}`);
  console.log(`令牌表:${storeFile}(${store.tokens.length} 条;页面服务器需 VRA_ACCESS_TOKENS_FILE 指向它才生效)`);
} else if (cmd === "list") {
  const store = readStore();
  if (!store.tokens.length) { console.log("令牌表为空(尚未启用邀测版)"); process.exit(0); }
  for (const t of store.tokens) {
    const exp = t.expires_at ? fmtDay(new Date(t.expires_at)) : "永不过期";
    const dead = t.expires_at && Date.now() > Date.parse(t.expires_at) ? " [已过期]" : "";
    console.log(`${t.token.slice(0, 6)}… ${t.label ?? "—"} 到期:${exp}${dead}${t.role === "master" ? " [主口令]" : ""}`);
  }
} else if (cmd === "extend" || cmd === "revoke") {
  const prefix = rest[0];
  if (!prefix) { console.error(`用法: trial.mjs ${cmd} <口令前6位>`); process.exit(1); }
  const store = readStore();
  const entry = findByPrefix(store, prefix);
  if (cmd === "revoke") {
    if (entry.role === "master") { console.error("主口令不能 revoke;换主口令用 scripts/start --remote --rotate-access"); process.exit(1); }
    store.tokens = store.tokens.filter((t) => t !== entry);
    writeStore(store);
    console.log(`已作废 ${entry.label ?? entry.token.slice(0, 6)} 的令牌`);
  } else {
    const days = Number(flag("days", 30));
    entry.expires_at = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
    writeStore(store);
    console.log(`已续期 ${entry.label ?? entry.token.slice(0, 6)}:${days} 天,至 ${fmtDay(new Date(entry.expires_at))}`);
  }
} else {
  console.log("用法: trial.mjs add <称呼> [--days 30] [--base <公网根地址>] | list | extend <前缀> [--days 30] | revoke <前缀>");
  process.exit(1);
}
