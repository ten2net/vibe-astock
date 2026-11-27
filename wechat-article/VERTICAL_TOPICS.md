# 揽宝投研 · 发布策略：只发交易日复盘

> 用户决定（2026-11-27）：**以后只发交易日的复盘文章，其它都不发，不再考虑选题问题**。
> 这是最彻底的标签修复方式——内容唯一、关键词固定，系统会稳定把账号识别为「A股短线投研」号。
> 本文件只记录执行规则，不再维护选题清单。

---

## 一、唯一内容来源

- **只发**：交易日当日复盘，由 `scripts/wechat_daily.py` 从 `~/.duanxian-agents/reviews/<date>.md` 自动生成。
- **不发**：任何非复盘文章（AI/科技热点、创业增长、泛社会热搜、方法论科普、个股泛谈、蹭大V等）。
- `output/2026-11-23/article.md`（黎曼猜想/AI）是历史污染物，**不发布、不参考**。

## 二、发布流程

```bash
# 1) 先看当天复盘是否已生成（取库里最新一篇）
.venv/bin/python scripts/wechat_daily.py --dry-run

# 2) 确认正文无误后发草稿（默认，推荐）
.venv/bin/python scripts/wechat_daily.py

# 3) 跳过草稿确认直接群发（仅在确认无误时用）
.venv/bin/python scripts/wechat_daily.py --publish
```

- 指定日期：`--date 2026-11-27`
- 必须带环境变量发布（微信 IP 白名单）：`WECHAT_PROXY=http://127.0.0.1:13128`

## 三、自动生效的护栏（不用手工检查）

1. **发布前标签闸门**：`review_agent/wechat_publish.py` 的 `publish_review()` 已接入 `tag_calibration_check.py`，核心词密度不足/污染词/标题前12字无核心词/缺风险警示 → 直接阻断，发不出去。
2. **合集默认投研**：`.wxpub/collections.json` 已改为四个投研合集、`复盘方法论` 为默认，不会再自动归到 AI 合集。
3. **产品政策**：`review_agent/product_policy.py` 在保存前拦截含买卖/仓位/点位指令的文本。

## 四、发布节奏

- 每个交易日收盘后发一篇（15:30–17:00 或 20:00–21:30 固定时段）。
- 非交易日不发，不补发旧复盘，不用热点凑数。
- 发布 48 小时后按 `TAG_FOLLOWUP_2W.md` 记录完读率、推荐流量占比、搜一搜占比。

## 五、验收

按 `TAG_FOLLOWUP_2W.md`：完读率回升先于推荐流量回升先于粉丝回升。
两周后（2026-12-08）若完读率与推荐占比均无变化，再回来排查内容本身，而不是改策略。

---

## 六、外部平台引流到公众号（雪球主阵地 + 东财流量入口）

> 母版不动：公众号仍只发交易日复盘。外部平台只做「导流图文包」，全部人工发布
> （雪球/东财股吧均无官方发帖 API，不做浏览器自动化）。

### 定位
- **雪球（xueqiu）**：主阵地。文案带数据口径，语气克制专业。
- **东财（dongfang）**：仅做品牌曝光，**不做导流**（财富号规范禁止公众号/二维码/推广；
  原「流量入口」定位因违规已放弃）。
- 落地目标：雪球长文封面/正文引导关注公众号（不做跳页中转）；东财只展示数据与品牌。

### 分发命令（仓库根目录）
```bash
# 1) 先看当天复盘是否已生成（取库里最新一篇）
.venv/bin/python scripts/social_daily.py --platform xueqiu --platform dongfang --dry-run

# 2) 确认文案/卡片无误后生成正式图文包（去掉 --dry-run）
.venv/bin/python scripts/social_daily.py --platform xueqiu --platform dongfang
```
- 默认分发（不带 `--platform`）仍是小红书 + 雪球，**小红书文案保持原样**（不放外链/导流话术）。
- 东财股吧通过显式 `--platform dongfang` 触发，不进默认集合。

### 图文包产物
- 雪球：`blog/static/social/packs/<date>/`（沿用旧契约）
- 东财股吧：`blog/static/social/packs/dongfang/<date>/`
- 每个包含 `caption.md`（导流文案）+ `card.png`（配图）

**配图差异（实测反馈后调整）**：
- 雪球长文用**横版 1200×630 无二维码**正文配图（源图 `<date>-lead-h.png`）；
  竖版 1080×1350 在长文正文中会被截断，带二维码的图可能被拒传。
- 雪球长文**封面另用 840×336 扁横版**（显示区实测尺寸，1200×630 也会被上下裁）：
  图文包里附两版 `cover.png`（无码，安全）与 `cover-qr.png`（带码，转化短），
  上传时按平台实际接受情况选一张。
- 东财（财富号/股吧）用**竖版 1080×1350 纯合规配图**（源图 `<date>-lead.png`）：
  按财富号《发文规范（修订版）》2.1，**禁止二维码、公众号/微信字样、外链、营销信息**，
  故东财图文包**不含任何导流内容**，只做品牌曝光，不做引流。
  规范原文：`https://mp.eastmoney.com/collect/pc_writer/treaty.html#/notice/detail?id=21`

### 人工发布步骤
1. 打开对应 App（雪球 / 东方财富股吧）。
2. 复制 `caption.md` 全文作正文。
3. 上传 `card.png` 作配图。
4. 发布前确认无违规提示；如被限流/判营销，反馈后调整文案。

### 合规红线（已内置门禁，不用手工检查）
1. **产品政策**：`review_agent/product_policy.py` 拦截买卖/仓位/点位指令。
2. **公开文本闸**：`blog_publish.check_public_text()` 与博客同标准。
3. **导流文案闸**：`platform_adapters.lead_gate()` 拦截荐股、违规营销词
   （稳赚/跟单/内部消息/限时名额/加群等）、文案内的 URL 与二维码字样。
4. 文案统一「克制正确版」：雪球用 `完整复盘与数据口径见公众号：揽宝投研`，
   不承诺收益、不催单、不引导私域交易；二维码只在图上，不写进正文。
5. **财富号专项门禁** `eastmoney_gate()`：东财文案禁止公众号/微信/变种文字/
   二维码/外链/营销词；违规直接拦截，发不出去。东财配图也不含二维码与公众号水印。

### 数据口径
- 所有读数来自当日复盘 `~/.duanxian-agents/reviews/<date>.json`，
  由 `emotion_card.extract_metrics()` 抽取；缺失写「—」，不编造。
- 台账 `~/.duanxian-agents/social-posts.json` 按 `date:platform` 记账，
  失败不写成功标记，下次可重试。
