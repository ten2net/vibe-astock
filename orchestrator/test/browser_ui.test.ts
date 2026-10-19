import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { apiTokenPath } from "../../desktop/vite-token.ts";

test("浏览器 UI 与 API 从同一个数据根读取 token", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-browser-ui-"));
  assert.equal(apiTokenPath(repo, {}), path.join(repo, ".local", "api.token"));

  fs.writeFileSync(path.join(repo, "vibe-research.config.json"), JSON.stringify({ paths: { data_root: "state" } }));
  assert.equal(apiTokenPath(repo, {}), path.join(repo, "state", "api.token"), "产品配置里的 data_root 没生效");
  assert.equal(apiTokenPath(repo, { VRA_DATA_ROOT: "/private/vra-data" }), "/private/vra-data/api.token");
  assert.equal(apiTokenPath(repo, { VRA_DATA_ROOT: "user-data" }), path.join(repo, "user-data", "api.token"));
});
