/**
 * 源码卫生棘轮 —— 挡住"看着没事、工具却读不了"的文件。
 *
 * 🔴 真踩过两次：heredoc 里写 `\0` 被 shell 解释成**真正的 NUL 字节**写进了源码
 *    （`pageContext.tsx` 与 `snapshot.ts`）。后果不是编译错：
 *    - TypeScript **接受**字符串字面量里的裸 NUL ⇒ `tsc` 0 错
 *    - Core 纯净度棘轮、前端边界棘轮**全绿**
 *    - 但 **git 把文件判成二进制**：diff 是 `Bin 0 -> 3047 bytes`，
 *      代码审查看不到内容、合并无法逐行、Codex 读到那里直接截断
 *
 *    ⇒ 一个**谁都没报错**的失效。这条棘轮就是补这个洞的。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");

/** 扫这些目录下的文本源码。构建产物与依赖不扫。 */
const ROOTS = ["orchestrator/src", "orchestrator/test", "desktop/src",
               "backtest", "calc", "datasources", "scripts", ".agents/skills"];
const SKIP = new Set(["node_modules", "__pycache__", ".pytest_cache", "dist", "build",
                      ".venv", "payload", "release", ".local", "fixtures"]);
const TEXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".json", ".md",
                      ".css", ".html", ".yml", ".yaml", ".toml", ".sh"]);

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (TEXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

const byRoot = new Map(ROOTS.map((r) => [r, walk(path.join(REPO, r))]));
const files = [...byRoot.values()].flat();

test("每个根目录都真的扫到了东西 —— 目录改名后这条棘轮会静默地什么都不查", () => {
  // ⚠️ 前端边界棘轮就这么"全绿地什么都没查过"（目录改名后 walk 返回空数组）。
  // 🔴 判据是**逐个根**，不是一个总数阈值：总数会随仓库增减漂移，
  //    而"某一个根扫出 0"才是真正要抓的那种失效 —— 总数阈值放得宽一点就漏掉了。
  const empty = [...byRoot].filter(([, v]) => v.length === 0).map(([k]) => k);
  assert.deepEqual(empty, [], `这些根一个文件都没扫到,路径是不是改了:${empty.join(", ")}`);
});

test("源码发行只保留浏览器 UI，不带 Electron/DMG 客户端", () => {
  assert.equal(fs.existsSync(path.join(REPO, "shell")), false,
    "shell/ 是已停用的 Electron 客户端；浏览器 UI 只在 desktop/ 维护");
});

test("🔴 源码里不许有裸 NUL 字节 —— git 会把文件判成二进制,而编译器不报错", () => {
  const bad: string[] = [];
  for (const f of files) {
    if (fs.readFileSync(f).includes(0)) bad.push(path.relative(REPO, f));
  }
  assert.deepEqual(bad, [],
    `这些文件含裸 NUL:${bad.join(", ")}\n` +
    `要 NUL 当分隔符是可以的,但必须写成转义序列(源码保持纯文本),不能是原始字节。`);
});

test("源码必须能按 UTF-8 解码 —— 解不开的文件同样会被当二进制", () => {
  const dec = new TextDecoder("utf-8", { fatal: true });
  const bad: string[] = [];
  for (const f of files) {
    try { dec.decode(fs.readFileSync(f)); } catch { bad.push(path.relative(REPO, f)); }
  }
  assert.deepEqual(bad, [], `这些文件不是合法 UTF-8:${bad.join(", ")}`);
});
