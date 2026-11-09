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

## 主题

- 站点主题是 [Clean White](https://themes.gohugo.io/themes/hugo-theme-cleanwhite/)：白底、顶部大图、右侧作者卡与标签云，带站内搜索位
- 主题放在 `themes/cleanwhite/`；配置在 `hugo.toml` 的 `[params]`（头图、slogan、侧栏简介、菜单）
- 复盘卡片与表格样式在 `static/css/astock.css`，通过 `custom_css` 挂载；换主题只需改 `theme` 与这个样式文件，文章内容不用动
- 头图 `static/img/home-bg.jpg` 取自主题示例，可自行替换成自家图
- **本地定制点**：`themes/cleanwhite/layouts/_partials/head.html` 加了三行 feed 自动发现 link；`layouts/index.rssxml.xml` / `layouts/index.atomxml.xml` 是站点级自定义 feed 模板。同步上游主题时逐文件合并，别整目录覆盖
