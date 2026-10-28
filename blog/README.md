# 复盘博客 · Hugo 源

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
