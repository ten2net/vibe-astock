import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import "../src/finance/register.ts";
import { ServiceError } from "../src/service.ts";
import { clearAiConnection, readAiConnection, saveAiConnection } from "../src/service.ts";

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
