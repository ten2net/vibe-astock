import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import { ServiceError } from "../src/service.ts";
import { clearAiConnection, readAiConnection, saveAiConnection } from "../src/service.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function fixture() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vra-ai-conn-"));
  return dataRoot;
}

test("订阅档连接可镜像、可读回、可清除", () => {
  const dataRoot = fixture();
  try {
    assert.equal(readAiConnection({ dataRoot }), null, "初始没有镜像");
    const saved = saveAiConnection({ dataRoot }, { provider: "cli-codebuddy", model: "codebuddy" });
    assert.deepEqual(saved, { provider: "cli-codebuddy", model: "codebuddy" });
    assert.deepEqual(readAiConnection({ dataRoot }), { provider: "cli-codebuddy", model: "codebuddy" });
    // 落盘的是纯 provider/model,没有别的字段(尤其不该有 key 形状的东西)
    const raw = JSON.parse(fs.readFileSync(path.join(dataRoot, "ai-connection.json"), "utf8"));
    assert.deepEqual(Object.keys(raw).sort(), ["model", "provider"]);
    clearAiConnection({ dataRoot });
    assert.equal(readAiConnection({ dataRoot }), null, "清除后读不到");
    clearAiConnection({ dataRoot });
  } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
});

test("API key 永不进镜像:带 apiKey 直接拒,API 档 provider 也不收", () => {
  const dataRoot = fixture();
  try {
    assert.throws(
      () => saveAiConnection({ dataRoot }, { provider: "cli-codebuddy", model: "codebuddy", apiKey: "secret" }),
      (e: unknown) => e instanceof ServiceError && e.code === "bad_ai_connection",
    );
    assert.throws(
      () => saveAiConnection({ dataRoot }, { provider: "deepseek", model: "deepseek-v4" }),
      (e: unknown) => e instanceof ServiceError && e.code === "bad_ai_connection",
    );
    assert.throws(
      () => saveAiConnection({ dataRoot }, { provider: "cli-evil", model: "x" }),
      (e: unknown) => e instanceof ServiceError && e.code === "bad_ai_connection",
    );
    assert.throws(
      () => saveAiConnection({ dataRoot }, { provider: "cli-codebuddy", model: "" }),
      (e: unknown) => e instanceof ServiceError && e.code === "bad_ai_connection",
    );
    assert.equal(readAiConnection({ dataRoot }), null, "全部拒绝后依旧没有镜像");
  } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
});

test("镜像文件被写坏时读回 null,不让页面崩", () => {
  const dataRoot = fixture();
  try {
    fs.writeFileSync(path.join(dataRoot, "ai-connection.json"), "not-json{{{");
    assert.equal(readAiConnection({ dataRoot }), null);
    fs.writeFileSync(path.join(dataRoot, "ai-connection.json"), JSON.stringify({ provider: "deepseek", model: "m" }));
    assert.equal(readAiConnection({ dataRoot }), null, "非订阅档内容当作没有镜像");
  } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
});

test("运行时兜底:没传 llm 且后台默认未配 → 回落到镜像的订阅档;显式来源与后台默认优先", async () => {
  const { resolveSelectedRuntime } = await import("../src/runtime_provider.ts");
  const { writeAiConnection } = await import("../src/ai_connection_store.ts");
  const empty = fixture();          // 无 config.json → 后台默认未配
  const mirrored = fixture();
  writeAiConnection(mirrored, { provider: "cli-codebuddy", model: "codebuddy" });
  try {
    // 镜像兜底:解析到本机 codebuddy Agent
    const r = resolveSelectedRuntime(REPO, mirrored, undefined, { PATH: "/usr/bin" });
    assert.equal(r.runtime === "local-agent" && r.agent, "codebuddy");
    // 没有镜像:维持 ai_source_not_configured
    assert.throws(
      () => resolveSelectedRuntime(REPO, empty, undefined, { PATH: "/usr/bin" }),
      (e: unknown) => e instanceof Error && e.message.includes("ai_source_not_configured") || (e as { code?: string }).code === "ai_source_not_configured",
    );
    // 显式请求级来源不受镜像影响;镜像里的 model 也不许混进来(订阅档模型由登录态决定)
    const explicit = resolveSelectedRuntime(REPO, mirrored, { provider: "cli-claude" }, { PATH: "/usr/bin" });
    assert.equal(explicit.runtime === "local-agent" && explicit.agent, "claude");
    // 后台默认配置优先于镜像
    const configured = fixture();
    fs.writeFileSync(path.join(configured, "config.json"), JSON.stringify({ provider: { profile: "cli-claude" } }));
    const def = resolveSelectedRuntime(REPO, configured, undefined, { PATH: "/usr/bin" });
    assert.equal(def.runtime === "local-agent" && def.agent, "claude");
  } finally { fs.rmSync(empty, { recursive: true, force: true }); fs.rmSync(mirrored, { recursive: true, force: true }); }
});
