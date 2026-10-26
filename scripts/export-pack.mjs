#!/usr/bin/env node
/**
 * 创作者素材包导出(商业化 B:自媒体素材服务的最小管道)。
 *
 * 每个交易日盘后,把产品已生成的**客观读数**打包成一份素材:
 *   .local/creator-pack/<日期>/pack.md   人类可读(直接当选题底稿)
 *   .local/creator-pack/<日期>/pack.json  结构化全量(程序二次加工)
 *
 * 素材内容 = 三个只读视图:分时资金横盘拉升榜 / 近 5 天热度与龙头 / 结构变化。
 * 🔴 纯增量:只读 API,不写任何状态;不跑就什么都不发生。
 * 🔴 口径纪律(与产品一致,也是给创作者的合作条款):素材是**已发生的客观读数**,
 *    创作者二次发布时必须保留署名与「非推荐、非预测」声明,不得改写成买卖建议。
 *
 * 用法:
 *   node scripts/export-pack.mjs [--day 2026-10-24] [--out <目录>]
 *                                 [--views fflow,weekly,structure]
 * 环境变量: VRA_PACK_API(默认 http://127.0.0.1:8770)、VRA_PACK_TOKEN(默认读 .local/api.token)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACK_TERMS = [
  "素材为已发生的客观市场读数,非推荐、非预测;二次发布不得改写成买卖建议、目标价或收益承诺。",
  "发布时须保留署名「数据来源:揽宝投研」及素材生成日期;数据截至时间以各视图 as_of/fetched_at 为准。",
  "pack.json 仅限创作者本人账号加工使用,不得原样再分发。",
];

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const wan = (yuan) => (num(yuan) === null ? "—" : `${(yuan / 1e4).toFixed(0)}万`);
// pct 已是百分数单位(后端视图统一换算过,3.2 = +3.2%)
const pct = (v) => (num(v) === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const cell = (v) => (v === null || v === undefined || v === "" ? "—" : String(v));

/** 资金榜(横盘→拉升)一节。视图形状见 watchTypes.ts FflowView。 */
export function fflowSection(v) {
  const lines = [`## 分时资金 · 横盘后拉升榜(${v?.day ?? "—"})`, ""];
  lines.push(`扫描 ${v?.total_scanned ?? "—"} 只,命中 ${v?.matched ?? 0} 只 · 通道:${v?.source_label ?? "—"} · 数据截至 ${v?.as_of ?? "—"}`, "");
  const stocks = Array.isArray(v?.stocks) ? v.stocks : [];
  if (!stocks.length) {
    lines.push(`> 当日无命中形态。${(v?.notes ?? []).join(" · ")}`, "");
    return lines.join("\n");
  }
  lines.push("| # | 名称 | 代码 | 今日 | 主力净流入 | 横盘→拉升 | 拉升幅度 | 稳步度 |", "|---|---|---|---|---|---|---|---|");
  for (const [i, s] of stocks.entries()) {
    lines.push(`| ${i + 1} | ${cell(s.name)} | ${cell(s.code)} | ${pct(s.pct)} | ${wan(s.main_net)} | ${cell(s.flat_minutes)}分→${cell(s.rise_minutes)}分 | +${cell(s.rise_bp)}bp | ${num(s.up_ratio) === null ? "—" : Math.round(s.up_ratio * 100) + "%"} |`);
  }
  lines.push("");
  for (const n of v?.notes ?? []) lines.push(`> ${n}`);
  lines.push("");
  return lines.join("\n");
}

/** 近 5 天热度与龙头(视图形状见 viewTypes.ts WeeklyResult 系列)。 */
export function weeklySection(v) {
  const days = Array.isArray(v?.days) ? v.days : [];
  const lines = ["## 近 5 天短线热度与龙头", ""];
  if (!days.length) { lines.push("> 当日未取到。", ""); return lines.join("\n"); }
  lines.push("| 日期 | 涨停家数 | 最高板 | 炸板率 | 领头 |", "|---|---|---|---|---|");
  for (const d of days) {
    const leaders = Array.isArray(d.leaders) ? d.leaders : [];
    const lead = leaders.slice(0, 3).map((l) => `${l.name}${l.boards ? `(${l.boards}板)` : ""}`).join("、") || "—";
    lines.push(`| ${cell(d.date)} | ${cell(d.limit_up)} | ${cell(d.highest_board)} | ${num(d.broken_rate) === null ? "—" : Math.round(d.broken_rate * 100) + "%"} | ${lead} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** 结构变化(视图形状见 viewTypes.ts StructureResult):直接用服务端写好的 summary。 */
export function structureSection(v) {
  const lines = ["## 涨停结构变化", ""];
  if (!v) { lines.push("> 当日未取到。", ""); return lines.join("\n"); }
  if (v.summary) lines.push(v.summary, "");
  const shifted = Array.isArray(v?.structure?.shifted) ? v.structure.shifted : [];
  for (const m of shifted.slice(0, 8)) {
    lines.push(`- ${cell(m.label ?? m.key)}:${cell(m.note ?? `${m.prev} → ${m.cur}`)}`);
  }
  if (v.regime_note) lines.push(`- ${v.regime_note}`);
  lines.push("");
  return lines.join("\n");
}

/** 纯函数:各视图 → { markdown, json }。缺某个视图也出包(记 gaps)。 */
export function buildPack(views, opts = {}) {
  const day = opts.day ?? new Date().toISOString().slice(0, 10);
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const gaps = [];
  const render = (key, fn) => {
    if (!views[key]) { gaps.push(key); return `## ${key}\n\n> 当日未取到(${key})。\n`; }
    return fn(views[key]);
  };
  const markdown = [
    `# 短线复盘素材包(${day})`,
    "",
    `生成时间:${generatedAt} · 来源:揽宝投研(vibe-astock)`,
    "",
    "本包为程序计算的客观市场读数整理,不构成投资建议。",
    "",
    render("fflow", fflowSection),
    render("weekly", weeklySection),
    render("structure", structureSection),
    "## 使用条款(二次发布必读)", "",
    ...PACK_TERMS.map((t) => `- ${t}`),
    "",
  ].join("\n");
  const json = { day, generated_at: generatedAt, gaps, views };
  return { markdown, json };
}

// ---------------------------------------------------------------- CLI

const VIEW_ROUTES = {
  fflow: (day) => `/view/shortline_fflow`,
  weekly: (day) => `/view/shortline_weekly?date=${encodeURIComponent(day)}`,
  structure: (day) => `/view/shortline_structure?date=${encodeURIComponent(day)}`,
};

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
  };
  const day = String(arg("day", new Date().toISOString().slice(0, 10)));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { console.error("--day 须为 YYYY-MM-DD"); process.exit(1); }
  const viewsWanted = String(arg("views", "fflow,weekly,structure")).split(",").map((s) => s.trim()).filter(Boolean);
  const outDir = String(arg("out", path.join(repoRoot, ".local", "creator-pack", day)));
  const api = process.env.VRA_PACK_API ?? "http://127.0.0.1:8770";
  const token = process.env.VRA_PACK_TOKEN
    ?? fs.readFileSync(path.join(repoRoot, ".local", "api.token"), "utf8").trim();

  const views = {};
  let failed = 0;
  for (const key of viewsWanted) {
    const route = VIEW_ROUTES[key]?.(day);
    if (!route) { console.error(`未知视图:${key}(可选 ${Object.keys(VIEW_ROUTES).join("/")})`); process.exit(1); }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 120_000);
    try {
      const res = await fetch(`${api}${route}`, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      views[key] = await res.json();
    } catch (e) {
      failed++;
      console.error(`[${key}] 取数失败:${e instanceof Error ? e.message : String(e)}`);
    } finally { clearTimeout(timer); }
  }
  if (!Object.keys(views).length) { console.error("所有视图都取不到,未出包"); process.exit(1); }

  const pack = buildPack(views, { day });
  fs.mkdirSync(outDir, { recursive: true });
  const mdPath = path.join(outDir, "pack.md");
  const jsonPath = path.join(outDir, "pack.json");
  fs.writeFileSync(mdPath, pack.markdown);
  fs.writeFileSync(jsonPath, JSON.stringify(pack.json, null, 2));
  console.log(`素材包已生成(${day}):`);
  console.log(`  ${mdPath} (${Buffer.byteLength(pack.markdown, "utf8")} B)`);
  console.log(`  ${jsonPath} (${Buffer.byteLength(JSON.stringify(pack.json), "utf8")} B)`);
  if (pack.json.gaps.length) console.log(`  缺口视图:${pack.json.gaps.join(", ")}`);
  if (failed) process.exitCode = 2;   // 出了包但有视图缺失:留给 cron 日志看
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((e) => { console.error(`导出失败:${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
