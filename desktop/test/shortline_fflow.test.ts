// 实时动态 · 分时资金「横盘→稳步拉升」榜(前 20)。数据形状照后端 fflow_pattern.ts,断言用户看得到什么。
import assert from "node:assert/strict";
import test from "node:test";
import { routed, textOf, withRenderer } from "./helpers/render.ts";
import type { FflowView } from "../src/verticals/finance/shortline/watchTypes.ts";

const DIR = "/src/verticals/finance/shortline";

const candidate = (code: string, name: string, riseBp: number) => ({
  code, name,
  price: 12.34, pct: 3.2,
  main_net: 5.2e7, float_cap: 1e10,
  points: 90, flat_minutes: 30, rise_minutes: 60,
  flat_band_bp: 6, rise_bp: riseBp, up_ratio: 0.78, score: riseBp - 3 + 4.5,
  series_bp: [1, 2, 1.5, 2.5, 3, 5, 8, 12, 18, 25],
});

const VIEW: FflowView = {
  day: "2026-10-23", as_of: "2026-10-23 14:30:00", source_label: "新浪资金流榜 + 腾讯分钟线估算", poll_ms: 60_000,
  total_scanned: 150, with_data: 120, matched: 2,
  stocks: [candidate("600519", "贵州茅台", 30), candidate("300308", "中际旭创", 22)],
  notes: ["名单:资金流榜(主力/大单净额)前 150 只;通道 新浪资金流榜 + 腾讯分钟线估算;有分钟数据 120 只,命中形态 2 只,取前 20"],
};

test("横盘拉升榜:按 score 排序渲染前 20;横盘→拉升时长、拉升幅度、稳步度、主力净流入都可见", async () => {
  await withRenderer(async (r) => {
    const { FflowPanelView, fflowSummary } = await r.load(`${DIR}/FflowPanel.tsx`);
    const t = textOf(await routed(r)(FflowPanelView, { v: VIEW }));
    assert.match(t, /分时资金 · 横盘后拉升\(前 20\)/);
    assert.match(t, /名单:资金流榜前 150 只;通道:新浪资金流榜 \+ 腾讯分钟线估算;数据截至 2026-10-23 14:30:00/);
    // 排序:score 高(拉升 30bp)在前
    const i1 = t.indexOf("贵州茅台 600519");
    const i2 = t.indexOf("中际旭创 300308");
    assert.ok(i1 !== -1 && i2 !== -1 && i1 < i2, "score 高的排前面");
    assert.match(t, /贵州茅台 600519 12\.34 \+3\.20% 5200万 30分→60分 \+30bp 78%/);
    assert.match(t, /资金曲线\(bp\)/, "迷你走势图列在");
    assert.match(t, /名单:资金流榜\(主力\/大单净额\)前 150 只/);
  });
});

test("分时资金列表:名称是雪球超链接,旁边有去研究站内链接和自选开关", async () => {
  await withRenderer(async (r) => {
    const { FflowPanelView } = await r.load(`${DIR}/FflowPanel.tsx`);
    const html = await routed(r)(FflowPanelView, { v: VIEW });
    // 名称 → 雪球个股页(站外,新窗口)
    assert.match(html, /<a[^>]+href="https:\/\/xueqiu\.com\/S\/SH600519"[^>]+target="_blank"[^>]*>贵州茅台<\/a>/);
    assert.match(html, /href="https:\/\/xueqiu\.com\/S\/SZ300308"/, "深市代码用 SZ 前缀");
    // 去研究 → 站内个股页
    assert.match(html, /<a[^>]+aria-label="去研究"[^>]+href="\/research\?symbol=600519"/);
    assert.match(html, /<a[^>]+aria-label="去研究"[^>]+href="\/research\?symbol=300308"/);
    // 自选开关:默认都不在自选 → 文案是「加入自选」
    assert.match(html, /aria-label="加入自选"[^>]*aria-pressed="false"/);
    assert.doesNotMatch(html, /aria-label="移出自选"/);
    // 不能把 <a> 套进 <a>:名称链接必须先闭合再出现图标
    assert.match(html, /贵州茅台<\/a><a[^>]+aria-label="去研究"/, "名称链接闭合后才出现去研究图标");
    assert.match(html, /<\/a><button[^>]+aria-label="加入自选"/, "自选开关在链接之外，点星标不会跳转");
  });
});

test("没有命中时说清楚原因,不显示空表;空数据视图有兜底文案", async () => {
  await withRenderer(async (r) => {
    const { FflowPanelView, fflowSummary } = await r.load(`${DIR}/FflowPanel.tsx`);
    const none: FflowView = { ...VIEW, with_data: 80, matched: 0, stocks: [] };
    const t = textOf(await routed(r)(FflowPanelView, { v: none }));
    assert.match(t, /暂时没有命中「先横盘后稳步拉升」形态的票/, "有数据但没命中要说形态未出现");
    assert.doesNotMatch(t, /贵州茅台/);
    const nodata: FflowView = { ...VIEW, with_data: 0, matched: 0, stocks: [] };
    const t2 = textOf(await routed(r)(FflowPanelView, { v: nodata }));
    assert.match(t2, /分钟资金数据还没取到/, "完全没数据时提示重试,不说形态未出现");
    // AI 上下文
    const s = fflowSummary(VIEW);
    assert.match(s, /横盘→拉升榜\(2026-10-23,数据截至 2026-10-23 14:30:00\):扫描 150 只,有分钟数据 120 只,命中 2 只/);
    assert.match(s, /贵州茅台\(600519\) \+3\.20% 主力净流入5200万 横盘30分→拉升60分 拉升30bp 稳步度78%/);
  });
});
