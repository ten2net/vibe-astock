import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { backend } from "../src/verticals/finance/lib/backend.ts";
import { writtenText } from "../src/verticals/finance/lib/vaImport.ts";
import { textOf, withRenderer } from "./helpers/render.ts";

const src = (rel: string) => fs.readFileSync(new URL(`../src/verticals/finance/${rel}`, import.meta.url), "utf8");
const CARD = "/src/verticals/finance/components/VaImportCard.tsx";

test("从旧版导入:读默认目录走 GET,预览 / 导入走 POST {action, dir}", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await backend.vaImportInfo();
    await backend.vaImportPreview("/x/old");
    await backend.vaImportRun("/x/old");
  } finally {
    globalThis.fetch = orig;
  }
  assert.deepEqual(calls.map((c) => c.url), ["/api/view/va_import", "/api/view/va_import", "/api/view/va_import"]);
  assert.equal(calls[0].init?.method, undefined);
  assert.equal(calls[1].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { action: "preview", dir: "/x/old" });
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), { action: "import", dir: "/x/old" });
});

test("写进去的条数:按固定顺序、跳过 0、认不得的种类放最后原样写", () => {
  assert.equal(writtenText({ note: 1, trade: 9, intraday: 2, journal_tag: 0, other: 3, shortline_review: 3 }),
    "交易流水 9 条、AI 复盘 3 条、研究记录 1 条、盘中快照 2 条、other 3 条");
  assert.equal(writtenText({}), "");
  assert.equal(writtenText({ trade: 0 }), "");
});

const group = (key: string, label: string, over: Record<string, unknown> = {}) =>
  ({ key, label, found: 0, add: 0, already: 0, skipped: [], notes: [], ...over });

test("预览:每类找到 / 要导入 / 以前导过 / 跳过(带原因);对不上的和不导的分开列,太长折起来", async () => {
  await withRenderer(async (r) => {
    const { VaImportPreviewView, VaImportResultView } = await r.load(CARD);
    const p = {
      dir: "/x/old", total: 7,
      groups: [
        group("journal", "交易记录", { found: 4, add: 3, already: 1, skipped: [{ what: "600000 2026-09-01", why: "成交明细里卖出超过了持有" }] }),
        group("intraday", "盘中快照", { found: 6, add: 4, notes: ["旧版早期快照没记价格口径"] }),
      ],
      warnings: Array.from({ length: 8 }, (_, i) => `对不上 ${i + 1}`),
      not_imported: [{ label: "复盘反思", count: 8, why: "新版没有对应的地方" }],
    };
    const t = textOf(r.html(VaImportPreviewView, { p }));
    assert.match(t, /内容 找到 要导入 以前导过 跳过/);
    assert.match(t, /交易记录 4 3 1 1 跳过的 1 项和原因 · 600000 2026-09-01:成交明细里卖出超过了持有/);
    assert.match(t, /盘中快照 6 4 0 0 旧版早期快照没记价格口径/);
    assert.match(t, /导入后交易日志里会对不上的\(按新版规则重算\): · 对不上 1/);
    assert.match(t, /对不上 6 还有 2 条 · 对不上 7 · 对不上 8/, "前 6 条直接显示,其余折起来");
    assert.match(t, /旧版里这些不导入: · 复盘反思 8 个:新版没有对应的地方/);
    const quiet = textOf(r.html(VaImportPreviewView, { p: { ...p, warnings: [], not_imported: [] } }));
    assert.doesNotMatch(quiet, /对不上|不导入/, "没有就不显示标题");

    const res = { ...p, backup: "backups/旧版导入备份-2026-10-10-2105", written: { trade: 9, shortline_review: 3 }, failed: [{ what: "盘中快照 2026-10-09 09:25", why: "新版这个时点刚好已经有快照了,没覆盖" }] };
    const rt = textOf(r.html(VaImportResultView, { r: res }));
    assert.match(rt, /导入了:交易流水 9 条、AI 复盘 3 条。/);
    assert.match(rt, /备份在数据目录下的 backups\/旧版导入备份-2026-10-10-2105 ,里面的说明写了怎么恢复/);
    assert.match(rt, /这些没写成\(再导一次会补上,已写的不会重复\): · 盘中快照 2026-10-09 09:25:新版这个时点刚好已经有快照了,没覆盖/);
    const none = textOf(r.html(VaImportResultView, { r: { ...res, backup: null, written: {}, failed: [] } }));
    assert.equal(none, "这次没有写进任何东西。");

    // 🔴 隐私模式:说明里的股数和金额遮掉,代码、日期和原因照常(2026-10-11 审计)
    const why = "卖出 300 股,超过当时持有的 200 股(之前的买入或送转可能没录)";
    const priv = { ...p, groups: [group("journal", "交易记录", { found: 1, skipped: [{ what: "600000 2026-09-01", why }], notes: [`成本 1500 元那笔:${why}`] })],
      warnings: [`导入的 600000 2026-09-01 那笔算不了:${why}`] };
    const shown = textOf(r.html(VaImportPreviewView, { p: priv, hide: false }));
    assert.match(shown, /卖出 300 股/);
    const masked = textOf(r.html(VaImportPreviewView, { p: priv, hide: true }));
    for (const s of ["300", "200", "1500"]) assert.ok(!masked.includes(s), `隐私模式下还露出 ${s}`);
    assert.match(masked, /600000 2026-09-01:卖出 •••• 股/);
    assert.match(masked, /导入的 600000 2026-09-01 那笔算不了/);
    const failed = textOf(r.html(VaImportResultView, { r: { ...res, failed: [{ what: "600000 2026-09-01", why }] }, hide: true }));
    assert.ok(!failed.includes("300 股"), failed);
  });
});

test("卡片:首屏有说明和目录输入框;目录没填不能预览;放在设置页顶层、不接 AI 页面上下文", async () => {
  await withRenderer(async (r) => {
    const { VaImportCard } = await r.load(CARD);
    const html = r.html(VaImportCard, {});
    const t = textOf(html);
    assert.match(t, /^从旧版导入 用过旧版 Vibe AStock（Python 版）的/);
    assert.match(t, /先预览，不会写；确认后才导入，导入前自动备份。旧版的文件只读、不改。可以重复导，以前导过的会跳过。/);
    assert.match(html, /aria-label="旧版数据目录"/);
    assert.match(html, /<button type="submit" disabled=""[^>]*>预览<\/button>/, "目录还没读到时预览按钮不可点");
  });
  const card = src("components/VaImportCard.tsx");
  assert.doesNotMatch(card, /ai\/pageContext["']|\buseAiPage\s*\(/, "个人交易数据不进 AI");
  assert.match(card, /backend\.vaImportRun\(preview\.dir\)/, "导入的就是预览过的那个目录(后端解析后的真实路径)");
  assert.match(card, /onChange=\{\(e\) => \{ setDir\(e\.target\.value\); setPreview\(null\); setResult\(null\); \}\}/, "改了目录就作废旧预览,不会拿旧预览导新目录");
  assert.match(card, /导入这 \{preview\.total\} 项/);
  const settings = src("pages/Settings.tsx");
  assert.ok(settings.indexOf("<VaImportCard />") > settings.indexOf("</details>"), "不藏进「高级运行信息」");
  const records = src("journal/RecordsTab.tsx");
  assert.match(records, /用过旧版 Vibe AStock\?到<Link to="\/settings"[^>]*>「接入 AI」<\/Link>页最下面的「从旧版导入」/, "交易记录空着时告诉老用户去哪导");
});
