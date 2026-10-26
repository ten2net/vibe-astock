import assert from "node:assert/strict";
import test from "node:test";

// @ts-ignore 纯 JS 脚本无类型声明,以运行时行为为准(同目录测试覆盖)
import { buildDigest } from "../../scripts/digest-push.mjs";

const VIEW = {
  day: "2026-10-23",
  source_label: "新浪资金流榜 + 腾讯分钟线估算",
  total_scanned: 150,
  with_data: 150,
  matched: 6,
  stocks: [
    { code: "300307", name: "慈星股份", pct: 6.10, main_net: 3.2e8, flat_minutes: 15, rise_minutes: 185, rise_bp: 4038.93 },
    { code: "002241", name: "歌尔股份", pct: 2.10, main_net: 1.9e8, flat_minutes: 20, rise_minutes: 180, rise_bp: 3422.64 },
    { code: "000559", name: "万向钱潮", pct: null, main_net: null, flat_minutes: 105, rise_minutes: 80, rise_bp: 3323.36 },
  ],
  notes: [],
};

test("digest:标题/统计/榜单行/合规口径/链接都在", () => {
  const md = buildDigest(VIEW, { link: "https://a2.luckybrother.cc" });
  assert.match(md, /\*\*分时资金 · 横盘后拉升榜\(2026-10-23\)\*\*/);
  assert.match(md, /扫描 150 只,命中 6 只 · 通道:新浪资金流榜 \+ 腾讯分钟线估算/);
  assert.match(md, /1\. \*\*慈星股份\*\*\(300307\) \+6\.10% 主力32000万 横盘15分→拉升185分 \+4038\.93bp/);
  assert.match(md, /万向钱潮\*\*\(000559\) — 主力— 横盘105分→拉升80分 \+3323\.36bp/, "缺字段显示 — 不崩");
  assert.match(md, /客观资金形态,非推荐、非预测。/);
  assert.match(md, /\[打开榜单\]\(https:\/\/a2\.luckybrother\.cc\)/);
  assert.doesNotMatch(md, /\.\.\.共/, "只有 3 行时不该出现省略行");
});

test("digest:超过 5 只截前 5 并给省略行;无命中/空视图有兜底文案;字节上限兜住", () => {
  const many = { ...VIEW, stocks: Array.from({ length: 30 }, (_, i) => ({ code: `6000${String(i).padStart(2, "0")}`, name: `股${i}`, pct: 0.01, main_net: 1e7, flat_minutes: 15, rise_minutes: 100, rise_bp: 100 })) };
  const md = buildDigest(many);
  assert.match(md, /…共 30 只,其余见产品内榜单/);
  assert.equal([...md.matchAll(/^\d+\. /gm)].length, 5, "榜单最多 5 行");
  const none = buildDigest({ ...VIEW, matched: 0, stocks: [], notes: ["分钟数据不够或形态未出现"] });
  assert.match(none, /今日无命中形态/);
  assert.match(none, /分钟数据不够或形态未出现/);
  const empty = buildDigest(null);
  assert.match(empty, /横盘后拉升榜\(今日\)/);
  const huge = { ...VIEW, stocks: Array.from({ length: 50 }, (_, i) => ({ code: `6000${String(i).padStart(2, "0")}`, name: `某只名字特别特别特别长的股票名称${i}`, pct: 0.01, main_net: 1e8, flat_minutes: 15, rise_minutes: 100, rise_bp: 100 })) };
  assert.ok(Buffer.byteLength(buildDigest(huge), "utf8") <= 3800, "超长 digest 必须压进 3800 字节");
});
