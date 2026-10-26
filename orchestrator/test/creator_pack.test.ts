import assert from "node:assert/strict";
import test from "node:test";

import { PACK_TERMS, buildPack, fflowSection, structureSection, weeklySection } from "../../scripts/export-pack.mjs";

const FFLOW = {
  day: "2026-10-24", as_of: "2026-10-24 15:00:00", source_label: "新浪资金流榜 + 腾讯分钟线估算",
  total_scanned: 150, with_data: 150, matched: 2, poll_ms: 60_000,
  stocks: [
    { code: "300307", name: "慈星股份", pct: 0.002, main_net: 3.19e8, float_cap: 1e10, points: 50, flat_minutes: 15, rise_minutes: 185, flat_band_bp: 1.98, rise_bp: 4038.93, up_ratio: 0.76, score: 3933.2, series_bp: [1, 2] },
    { code: "002241", name: "歌尔股份", pct: 0.001, main_net: 8.99e8, float_cap: 2e10, points: 50, flat_minutes: 20, rise_minutes: 180, flat_band_bp: 1.35, rise_bp: 3422.64, up_ratio: 0.75, score: 3403.7, series_bp: [1] },
  ],
  notes: ["名单:资金流榜前 150 只"],
};
const WEEKLY = {
  days: [
    { date: "2026-10-24", limit_up: 52, highest_board: 5, broken_rate: 0.21, leaders: [{ code: "600825", name: "新华传媒", boards: 5, sector: "出版", first_seal: "09:31" }], leader_total: 1, settled: true, note: "" },
    { date: "2026-10-23", limit_up: null, highest_board: null, broken_rate: null, leaders: [], leader_total: null, settled: null, note: "非交易日" },
  ],
};
const STRUCTURE = {
  date: "2026-10-24", available: true,
  structure: { available: true, reason: null, metrics: [], shifted: [{ key: "k", label: "首板占比", prev: 0.4, cur: 0.6, note: "首板占比 40% → 60%" }], skipped: [] },
  regime_note: "情绪档位:偏热", summary: "近 5 天涨停结构由连板转向首板。",
};

test("资金榜一节:表头/两行数据/口径注释都在,空榜有兜底", () => {
  const md = fflowSection(FFLOW);
  assert.match(md, /## 分时资金 · 横盘后拉升榜\(2026-10-24\)/);
  assert.match(md, /扫描 150 只,命中 2 只 · 通道:新浪资金流榜 \+ 腾讯分钟线估算 · 数据截至 2026-10-24 15:00:00/);
  assert.match(md, /\| 1 \| 慈星股份 \| 300307 \| \+0\.20% \| 31900万 \| 15分→185分 \| \+4038\.93bp \| 76% \|/);
  assert.match(md, /名单:资金流榜前 150 只/);
  const empty = fflowSection({ ...FFLOW, stocks: [], matched: 0, notes: ["形态未出现"] });
  assert.match(empty, /当日无命中形态/);
});

test("近 5 天/结构两节:领头带板位,缺读数写 —,结构用 summary+shifted", () => {
  const w = weeklySection(WEEKLY);
  assert.match(w, /\| 2026-10-24 \| 52 \| 5 \| 21% \| 新华传媒\(5板\) \|/);
  assert.match(w, /\| 2026-10-23 \| — \| — \| — \| — \|/, "缺读数不得写成 0");
  const s = structureSection(STRUCTURE);
  assert.match(s, /近 5 天涨停结构由连板转向首板。/);
  assert.match(s, /- 首板占比:首板占比 40% → 60%/);
  assert.match(s, /- 情绪档位:偏热/);
});

test("buildPack:三包合一,缺视图记 gaps 仍出包,条款页脚完整,JSON 全量保真", () => {
  const { markdown, json } = buildPack({ fflow: FFLOW, weekly: WEEKLY, structure: STRUCTURE }, { day: "2026-10-24", generatedAt: "2026-10-24T07:30:00.000Z" });
  assert.match(markdown, /# 短线复盘素材包\(2026-10-24\)/);
  assert.match(markdown, /生成时间:2026-10-24T07:30:00\.000Z · 来源:揽宝投研\(vibe-astock\)/);
  assert.match(markdown, /## 分时资金 · 横盘后拉升榜/);
  assert.match(markdown, /## 近 5 天短线热度与龙头/);
  assert.match(markdown, /## 涨停结构变化/);
  assert.match(markdown, /## 使用条款\(二次发布必读\)/);
  for (const t of PACK_TERMS) assert.ok(markdown.includes(t), `条款缺失:${t}`);
  assert.match(markdown, /非推荐、非预测/);
  assert.deepEqual(json.views.fflow, FFLOW, "JSON 原样保真,二次加工不走样");
  assert.deepEqual(json.gaps, []);
  // 缺 weekly:仍出包 + gaps 记录
  const partial = buildPack({ fflow: FFLOW }, { day: "2026-10-24" });
  assert.deepEqual(partial.json.gaps, ["weekly", "structure"]);
  assert.match(partial.markdown, /## weekly\n\n> 当日未取到\(weekly\)。/);
  assert.match(partial.markdown, /## 分时资金/);
});
