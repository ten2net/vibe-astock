import assert from "node:assert/strict";
import test from "node:test";

import { clearMirroredAiConnection, hydrateAiConnection, mirrorAiConnection } from "../src/verticals/finance/lib/aiConnectionMirror.ts";
import { LLM_KEY, clearUserLlm, readAiRuntime } from "../src/verticals/finance/lib/llmStore.ts";

function storageFixture(initial?: string) {
  const values = new Map<string, string>();
  if (initial) values.set(LLM_KEY, initial);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  return values;
}

/** 按 path + method 录请求、按路由表回响应的假 fetch */
function fetchFixture(routes: Record<string, unknown>) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1:5940");
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push({ path: url.pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init?.body)) : null });
    const hit = Object.hasOwn(routes, key) ? routes[key] : new ServiceErrorStub("not_found");
    const status = hit instanceof ServiceErrorStub ? 400 : 200;
    return new Response(JSON.stringify(hit instanceof ServiceErrorStub ? { error: hit.code } : hit), {
      status, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = oldFetch; } };
}
class ServiceErrorStub {
  readonly code: string;
  constructor(code: string) { this.code = code; }
}

test("本地没有可用配置时,hydrate 从服务端镜像恢复订阅档连接", async () => {
  const values = storageFixture();
  const { calls, restore } = fetchFixture({
    "GET /api/ai-connection": { connection: { provider: "cli-codebuddy", model: "codebuddy" } },
  });
  try {
    await hydrateAiConnection();
    assert.equal(readAiRuntime().status, "ok");
    assert.deepEqual(JSON.parse(values.get(LLM_KEY)!), {
      schemaVersion: 2, source: { provider: "cli-codebuddy", model: "codebuddy", baseURL: "", apiKey: "" },
    });
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /api/ai-connection"]);
  } finally { restore(); }
});

test("本地已有可用配置时不发请求、不动存储", async () => {
  const existing = JSON.stringify({ schemaVersion: 2, source: { provider: "cli-claude", model: "claude", baseURL: "", apiKey: "" } });
  const values = storageFixture(existing);
  const { calls, restore } = fetchFixture({
    "GET /api/ai-connection": { connection: { provider: "cli-codebuddy", model: "codebuddy" } },
  });
  try {
    await hydrateAiConnection();
    assert.equal(calls.length, 0, "本地已配置就不该打镜像接口");
    assert.equal(values.get(LLM_KEY), existing, "存储不被改写");
  } finally { restore(); }
});

test("镜像里没有内容时不写存储", async () => {
  storageFixture();
  const { calls, restore } = fetchFixture({ "GET /api/ai-connection": { connection: null } });
  try {
    await hydrateAiConnection();
    assert.equal(readAiRuntime().status, "none");
    assert.equal(calls.length, 1);
  } finally { restore(); }
});

test("镜像接口失败不影响启动(保持未接入)", async () => {
  storageFixture();
  const { restore } = fetchFixture({ "GET /api/ai-connection": new ServiceErrorStub("boom") });
  try {
    await hydrateAiConnection();
    assert.equal(readAiRuntime().status, "none");
  } finally { restore(); }
});

test("mirrorAiConnection:订阅档落镜像,API 档清镜像;失败不抛出", async () => {
  storageFixture();
  const { calls, restore } = fetchFixture({
    "POST /api/ai-connection": { connection: { provider: "cli-codebuddy", model: "codebuddy" } },
    "DELETE /api/ai-connection": { ok: true },
  });
  try {
    await mirrorAiConnection({ provider: "cli-codebuddy", model: "codebuddy", baseURL: "", apiKey: "" });
    assert.deepEqual(calls.map((c) => c.method), ["POST"]);
    calls.length = 0;
    await mirrorAiConnection({ provider: "deepseek", model: "deepseek-v4", baseURL: "https://api.deepseek.com", apiKey: "k" });
    assert.deepEqual(calls.map((c) => c.method), ["DELETE"], "API 档不落镜像,改为清掉旧订阅档镜像");
    assert.equal(JSON.stringify(calls[0]?.body).includes("k"), false, "API key 不出现在任何镜像请求里");
    calls.length = 0;
    await clearMirroredAiConnection();
    assert.deepEqual(calls.map((c) => c.method), ["DELETE"]);
    // 接口挂了也不抛出(不阻断保存主流程)
    const { restore: restoreDown } = fetchFixture({ "POST /api/ai-connection": new ServiceErrorStub("down") });
    try {
      await mirrorAiConnection({ provider: "cli-codebuddy", model: "codebuddy", baseURL: "", apiKey: "" });
    } finally { restoreDown(); }
  } finally { restore(); }
});

test("恢复进来的订阅档可被正常读取、清除", async () => {
  const values = storageFixture();
  const { restore } = fetchFixture({
    "GET /api/ai-connection": { connection: { provider: "cli-claude", model: "claude" } },
  });
  try {
    await hydrateAiConnection();
    assert.equal(readAiRuntime().config?.source.provider, "cli-claude");
    clearUserLlm();
    assert.equal(readAiRuntime().status, "none");
    assert.equal(values.has(LLM_KEY), false);
  } finally { restore(); }
});
