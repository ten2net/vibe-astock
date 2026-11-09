# 复盘博客 · Hugo 源（主题 Clean White）

由 Vibe AStock 的 `scripts/publish_review.py` 写入与构建，**不要手改**这里生成出来的页面：

- `content/post/YYYY-MM-DD-每日复盘.md`：每天一篇文章，从本机已核对的复盘产物转写
- `public/`：`hugo` 的构建产物（会被同步到 Pages 仓库），已在 .gitignore 里

手动预览：

```bash
hugo server -D          # 打开 http://127.0.0.1:1313/
```

发布：

```bash
cd <仓库根>
.venv/bin/python scripts/publish_review.py            # 写 md → hugo 构建 → 推 Pages
.venv/bin/python scripts/publish_review.py --dry-run  # 只写 md 与构建，不推
```
## 订阅源（发布后自动分发的入口）

构建会同时产出三个 feed，都由 `hugo.toml` 的 `[outputs] home` + `layouts/index.*.xml` 生成：

| 路径 | 格式 | 说明 |
|---|---|---|
| `/rss.xml` | RSS 2.0 | 分发管道主用的固定入口 |
| `/atom.xml` | Atom 1.0 | 分发管道 / 阅读器备用 |
| `/index.xml` | RSS 2.0 | Hugo 内置默认，兼容老订阅地址 |

- 自定义 outputFormat（`RSSXML` / `ATOMXML`）用**独立 mediaType**，避免和内置 `RSS` 的模板查找串味（串了会把 `index.xml` 也渲染成自定义模板）。
- 三个文件都在 `review_agent/blog_publish.py` 的 `OWNED_FILES` 里，发布时会同步到 Pages；少列一个线上就是 404。
- `<head>` 里的 `rel="alternate"` 自动发现链接写在主题 `themes/cleanwhite/layouts/_partials/head.html`（本地定制点，换主题要带上）。
- 日期字符串的 `+0800` / `+08:00` 用 `safeHTML` 输出，不能被转义成 `&#43;`。

## SEO / 社交分享元数据

- **title**：首页用 `hugo.toml` 的 `SEOTitle`（`揽宝.复盘 | 揽宝投研`），文章页用「文章标题 | 站点名」。不要把 `.Title` 与 `SEOTitle` 叠加，否则出现「揽宝.复盘 | 揽宝.复盘 | 揽宝投研」。
- **Open Graph / Twitter Card**：`og:title` / `og:description` / `og:image` / `twitter:card=summary_large_image` / `og:type`（首页 `website`、文章 `article`）/ `article:published_time` 等。旧主题用 `.Params.title`（不存在）和 `.Params.summary`（是摘要文本）导致首页 `og:title` 为空、`twitter:card` 被塞成整段摘要、`og:image` 出现 `//img/` 双斜杠，已修正。
- **JSON-LD**：`layouts/_partials/jsonld.html` 输出 `WebSite`（首页）/ `BlogPosting`（文章页，含 headline/datePublished/dateModified/author/publisher/image/mainEntityOfPage/keywords）。用 `dict + jsonify + safeJS`——**必须用 `safeJS`**，用 `safeHTML` 会让 `<script>` 上下文把整个对象二次编码成 JSON 字符串。
- **SearchAction 钩子**：站点目前没有可用搜索页，故首页 JSON-LD 不输出 `potentialAction`，免得指向 404；将来做了搜索页，在 `hugo.toml` 加 `search_url = "https://…/?q={search_term_string}"` 即会自动带上。
- **时间戳**：HTML 属性上下文里 `+08:00` 会被 Hugo 转成 `&#43;08:00`（`safeHTML`/`safeHTMLAttr` 都挡不住），`article:*_time` 用整行 `printf + safeHTML` 原样输出保证 ISO 8601。
- 回归：`tests/test_blog_seo.py` 用真实 hugo 构建后解析 HTML 断言 title / OGP / JSON-LD / feed 自动发现。

## 主题

- 站点主题是 [Clean White](https://themes.gohugo.io/themes/hugo-theme-cleanwhite/)：白底、顶部大图、右侧作者卡与标签云，带站内搜索位
- 主题放在 `themes/cleanwhite/`；配置在 `hugo.toml` 的 `[params]`（头图、slogan、侧栏简介、菜单）
- 复盘卡片与表格样式在 `static/css/astock.css`，通过 `custom_css` 挂载；换主题只需改 `theme` 与这个样式文件，文章内容不用动
- 头图 `static/img/home-bg.jpg` 取自主题示例，可自行替换成自家图
- **本地定制点**（同步上游主题时逐文件合并，别整目录覆盖）：
  - `themes/cleanwhite/layouts/_partials/head.html`：三行 feed 自动发现 link + 整块 SEO 元数据重写 + `partial "jsonld.html"` 引入
  - `layouts/index.rssxml.xml` / `layouts/index.atomxml.xml`：站点级自定义 feed 模板
  - `layouts/_partials/jsonld.html`：站点级 JSON-LD partial
