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
## 主题

- 站点主题是 [Clean White](https://themes.gohugo.io/themes/hugo-theme-cleanwhite/)：白底、顶部大图、右侧作者卡与标签云，带站内搜索位
- 主题放在 `themes/cleanwhite/`；配置在 `hugo.toml` 的 `[params]`（头图、slogan、侧栏简介、菜单）
- 复盘卡片与表格样式在 `static/css/astock.css`，通过 `custom_css` 挂载；换主题只需改 `theme` 与这个样式文件，文章内容不用动
- 头图 `static/img/home-bg.jpg` 取自主题示例，可自行替换成自家图
