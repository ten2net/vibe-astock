# 社媒自动分发设计 — 设计文档

日期：2026-11-09
状态：已定稿（用户确认）

## 1. 背景与目标

博客内容形态全是文字 + 表格，在雪球 / X / Telegram 上不利于传播。上一轮已完成
「情绪档位卡片图」（`review_agent/emotion_card.py`，1200×630 横版）+ RSS/Atom feed +
OG/Twitter Card/JSON-LD + 发布管道自动带上卡片，线上均已验证。

本设计补齐**「把卡片送到平台」**这一段，目标：每日复盘发布后，自动生成平台化图文包，
X/TG 默认自动发帖，雪球半自动（人工粘贴），全程可幂等、可 dry-run、不阻断主发布。

## 2. 关键现状（设计依据）

- 已有三件套：`/rss.xml` `/atom.xml` `index.xml`（线上 200）、`blog/static/cards/<date>.png`
  与 `latest.png`、`og-image.html` 让文章页 og:image 指向当天卡片。
- `emotion_card.py`：`WIDTH/HEIGHT = 1200/630` 是常量、布局坐标写死；`generate()` 对单篇
  失败降级记 log，不阻断发布。字体统一 Noto Sans CJK SC（ttc index=2）。
- `wechat_publish.py` / `scripts/wechat_daily.py`：**默认只进草稿箱、人工群发**；
  `docker-compose.yml` 注释明确「不要设 WECHAT_AUTOPUBLISH=1（账号无群发 API 权限，48001）」，
  且微信要求直连不走代理（IP 白名单）。这是本项目对「外部平台自动发帖」的既有谨慎口径。
- `blog_publish.publish()`：写 md → 生成卡片 → `build()` → `sync_public()`。
  `OWNED_DIRS` 决定哪些产物同步到 Pages；`sync_public` 按字节比对、幂等。
- 编排：宿主 cron 拉起 `docker compose run --rm publish`（`scripts/publish_review.py`），
  或 `review` 服务 `--publish` 跑完复盘立刻发布。**社媒应接在这条现有链路之后，不另起定时器。**
- 合规红线（CODEBUDDY.md）：**不输出投资决策/买卖建议/仓位指令**；
  `review_agent/product_policy.py::has_trade_recommendation` 在保存前拦截，
  `blog_publish.check_public_text` 是公开前闸门。卡片与社媒文案同样受此约束。
- 无短链服务 / 域名，无 `qrcode` / `segno` 库（需加 `qrcode[pil]`）。

## 3. 四项决策（用户确认）

| 决策点 | 结论 |
|---|---|
| 雪球 | **半自动**：生成图文包到目录，人工复制粘贴；不做浏览器自动化（无官方发帖 API，ToS/封号风险） |
| X / Telegram | **默认自动发帖**（凭据从 env 读；未配/失败则跳过记日志，不阻断发布） |
| 短链 | **站内跳转页** `/go/<platform>/<date>/`，302 到带 `utm_source` 的文章 URL；零外部依赖、可离线验证 |
| 卡片形态 | **横版 1200×630 保持不动**（OG 链接预览用）；**新增竖版 1080×1350** 带短链文字 + 二维码 + CTA，供信息流发图 |

补充决策（本次问答）：X/TG 失败策略＝**跳过并记日志，不阻断发布**（与 `emotion_card` 一致）；
本轮范围＝**设计文档 + 全部代码骨架**，不接真实凭据、不真发帖。

## 4. 总体架构

```
复盘生成 → publish_review.py
  ├─ write_sources（md）
  ├─ [新] social_links.go_pages()      → blog/static/go/<plat>/<date>/index.html（UTM 跳页）
  ├─ [新] emotion_card 竖版             → blog/static/cards/<date>-vertical.png（带二维码）
  ├─ emotion_card 横版（不变）          → blog/static/cards/<date>.png + latest.png
  ├─ hugo build → public/
  ├─ [新] social_publish.distribute()  → X / TG 发帖；雪球写图文包
  └─ sync_public → Pages
```

新增文件：

```
review_agent/social_links.py     UTM 跳页生成
review_agent/social_publish.py   三平台分发 + 台账 + 合规 + dry-run
scripts/social_daily.py          独立入口（--dry-run / --date / --platform）
blog/static/go/                  跳页（生成物，OWNED_DIRS 纳入）
blog/static/cards/*-vertical.png 竖版卡片（生成物）
~/.duanxian-agents/social-posts.json  发帖台账（不进版本库）
```

## 5. 短链跳页与 UTM 归因

- 路径：`/go/<platform>/<date>/index.html`，`platform ∈ {x, tg, xueqiu}`。
- 内容：极简 HTML，`<meta http-equiv="refresh" content="0;url=...">` + 兜底 `<a>`，
  目标 `https://ten2net.github.io/post/<date>-每日复盘/?utm_source=<platform>&utm_medium=social&utm_campaign=<date>`。
- 生成器按「已发布文章 × 3 平台」批量写 `blog/static/go/`，内容不变不重写（幂等）。
- 卡片图与 caption 用这个 URL；靠 `utm_source` 区分回流来源。
- `OWNED_DIRS` 必须加 `go`，否则跳页不会同步到 Pages（与上一轮 `cards` 同一个坑）。

## 6. 竖版卡片与二维码

- 参数化 `emotion_card.render_card(..., size=(w,h), variant="horizontal|vertical")`：
  横版保留现有坐标布局；竖版重排（档位大字居上、三读数竖排或 2+1、免责声明、
  底部「扫码看全文」+ 短链文字 + 二维码）。
- 二维码用 `qrcode[pil]` 编码 `/go/<platform>/<date>/` URL，贴到竖版卡片右下。
  竖版是**平台共用一张**（二维码指向 `xueqiu` 通用短链即可，或按平台各出一张，
  v1 先用一张通用 `tg` 短链，避免组合爆炸）。
- 依赖 `qrcode[pil]` 加入 requirements.txt；缺库时竖版降级为「无二维码但不报错」，
  横版完全不受影响。

## 7. 分发模块（social_publish.py）

### 7.1 平台文案（caption）

三个模板，均含：日期 + 情绪档位 + 三读数 + 免责声明 + 短链。
- `X`：≤280 字符，外链会降权但保留；话题 `#A股复盘 #情绪周期`。
- `TG`：可长文本，支持 Markdown，短链直接可点。
- `雪球`：偏长、带「（数据来源：公开榜单与程序统计）」口径，输出为 `xueqiu_pack.md` 图文包。

**所有 caption 生成后必须过 `check_public_text` / `has_trade_recommendation`**，
命中即拒绝该平台本次分发并记日志（合规红线不因社媒放宽）。

### 7.2 平台适配

| 平台 | 方式 | 凭据（env） | 备注 |
|---|---|---|---|
| Telegram | Bot API `sendPhoto`（单 HTTP POST） | `TG_BOT_TOKEN` / `TG_CHAT_ID` | 最简单，先跑通 |
| X | OAuth 1.0a 签名 → `media/upload` → `POST /2/tweets` | `X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_SECRET` | 免费档有发帖限额 |
| 雪球 | **只生成图文包**（`social_packs/<date>/`） | 无 | 人工复制，无 API |

- 凭据只从 env 读、不进日志（沿用 `wechat_publish.py` 口径）；**不配置即跳过**，
  不视为错误。
- 网络：X/TG 请求不复用微信的「禁用代理」opener（微信是 IP 白名单特例），
  按容器现有 `https_proxy` 走；若失败记日志跳过。

### 7.3 发帖台账与幂等

- `~/.duanxian-agents/social-posts.json`，键 `<date>:<platform>`，值含
  `posted_at` / `platform_post_id` / `url` / `status`。
- 发前查台账：已成功则跳过（帖子不能撤回重发）；失败不写成功标记，下次可重试。
- 与 feed 的 `guid`（= 文章 Permalink）同源，避免两套身份。

### 7.4 失败策略

- 凭据缺失 / 接口报错 / 限流 / 合规拦截 → **记结构化日志 + 台账 `status=skipped|failed`，
  不抛异常到 `publish()`**（社媒是增强项）。
- `publish()` 对 `social_publish.distribute()` 再兜一层 `try/except`，任何意外都不阻断
  博客与卡片发布。
- `--dry-run`：完整跑「渲染 caption + 合规检查 + 生成图文包」，**不调用任何平台 API、
  不写成功台账**，用于本地与 CI 验证。

## 8. 合规与产品政策（硬约束）

- 卡片、跳页、caption 全部不得含投资建议/买卖动作/仓位指令；`has_trade_recommendation`
  对 caption 同样生效。
- 免责声明沿用 `blog_publish.DISCLAIMER` 口径，竖版卡片与 caption 都带。
- 凭据不进代码、不进日志、不进版本库。
- 雪球明确不做浏览器自动化（无官方 API，ToS 风险），只做半自动。
- 发文频率：一天一次（跟随现有 cron），台账去重兜底。

## 9. 接入点

- `blog_publish.OWNED_DIRS` 增加 `"go"`（跳页）与 `"social"`（图文包，若需上线）。
- `publish()` 在 `emotion_card.generate()` 之后、`build()` 之前调用
  `social_links.go_pages()` 与竖版卡片生成；在 `build()` 之后、`sync_public()` 之前
  （或之后）调用 `social_publish.distribute()`。dry-run 只做前半段（生成 + 合规），不发帖。
- `scripts/social_daily.py` 提供独立入口，便于手动补发 / 调试。
- compose 的 `review --publish` / `publish` 服务**不改编排**，社媒由 `publish_review.py`
  内部链式触发；新 env 变量由 `.env` 注入（未配即跳过）。

## 10. 测试

- `tests/test_social_distribution.py`（`-m unit`，全离线、不打真实平台 API）：
  - 跳页：路径/UTM 参数正确、内容幂等、平台集合齐全
  - 竖版卡片：尺寸 1080×1350、合法 PNG、二维码可解码（或缺库降级不崩）
  - caption：三个模板都含短链与免责声明、**不含荐股表述**、过合规闸门
  - 台账：成功写、重复跳过、失败不写成功标记
  - dry-run：不调用 API（注入 fake poster 断言零调用）
  - 失败不阻断：注入抛异常的 fake，断言 `distribute()` 正常返回
  - `OWNED_DIRS` 含 `go`/`social`、`sync_public` 能带上跳页
  - 发布钩子：临时 site + dry_run 生成跳页与竖图
- 全量 `pytest tests backtest/tests research_data/tests -q` 回归（5 个预存基线失败除外）。

## 11. 明确不做（YAGNI）

- 雪球浏览器自动化 / RPA（无官方 API，封号风险）。
- 真短链服务（Bitly/dub）与外部域名。
- 多账号矩阵、定时重试队列、评论区互动、数据统计看板。
- 把 UTM 回流做成实时分析；v1 只生成带参链接。
- 改 `wechat_publish.py` 的人工群发口径（本设计不触碰微信）。
- 改 `frontend/`（本轮纯后端 + Hugo 静态产物）。
- 前端 localStorage 存任何社媒凭据。

## 12. 落地顺序

1. `qrcode[pil]` 依赖 + `social_links.py`（跳页/UTM）+ 测试
2. `emotion_card.py` 参数化尺寸 + 竖版布局 + 二维码
3. `social_publish.py` + `scripts/social_daily.py`（TG → X → 雪球包）+ 台账/合规/dry-run
4. `OWNED_DIRS` + `publish()` 钩子接线
5. 全量回归 + 文档（blog/README.md、compose 注释）
6. 真凭据接入与首次实发由运营侧在配好 env 后单独执行（本轮不做）

## 13. 修订记录

### 2026-11-09（骨架落地）

按本设计完成实现，**未接真实凭据、未真发帖**：
- `social_links.py`：`/go/<platform>/<date>/` UTM 跳页（幂等），`qrcode[pil]` 依赖
- `emotion_card.py`：参数化尺寸，新增 `1080×1350` 竖版（二维码 + 短链 + CTA），
  `generate()` 同时出横版/竖版/latest，`vertical=False` 保留旧 OG 契约
- `social_publish.py` + `scripts/social_daily.py`：三平台 caption、双合规闸门、
  `social-posts.json` 台账幂等、TG sendPhoto / X OAuth1.0a（可注入 sender）、
  雪球图文包、`--dry-run` 零 API、失败跳过不阻断
- `blog_publish.py`：`OWNED_DIRS` 加 `go`/`social`；`publish()` 在写 md 后生成跳页+竖图，
  在 **Pages 推送成功之后**才分发（避免短链 404），只发最新一篇
- `blog/README.md` / `docker-compose.yml` 补说明；`tests/test_social_distribution.py` 25 例
- 回归：全量 pytest **1762 passed / 5 预存基线失败**（同 main，与本次无关）
- 实测坑：`has_trade_recommendation(DISCLAIMER)` 返回 True（「不推荐个股」等产品口径词），
  故 caption 合规扫描必须先剔除免责声明；已写进测试与文档。

待运营侧：在 `.env` 配好 X/TG 凭据后首次实发；本轮不执行。

### 2026-11-09（初稿并定稿）

初稿并定稿（用户确认）。四项决策：雪球半自动、X/TG 默认自动发、站内 `/go/` UTM 跳页、
新增竖版卡片带二维码。范围＝设计文档 + 全部代码骨架，不接真实凭据、不真发帖。
