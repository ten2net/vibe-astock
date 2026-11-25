#!/usr/bin/env python3
"""把某日复盘渲染成可本地预览的公众号文章 HTML（手机宽度）。

借鉴 Seaway《高开低走之后：等坑分批，别接飞刀》的标题/结构/插图后，
揽宝投研的生成器产出的正文包含：
  - 「态度 + 动作」式标题（stance_title）
  - 「先说结论」表（问题/答案/依据）
  - 由数据底座真实读数驱动的内联条形图（涨跌家数、昨日涨停表现、晋级率）
  - 「观察清单」表（可逐日对照的验证条件）

本脚本只做本地预览包装，不调用微信接口、不发布。

用法（仓库根目录）：
    .venv/bin/python wechat-article/gen_preview.py --date 2026-11-24
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from duanxian.paths import data_path  # noqa: E402
from review_agent import blog_publish as bp  # noqa: E402
from review_agent import wechat_render as wr  # noqa: E402


PREVIEW_TPL = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>{title}</title>
<style>
body {{ margin:0; background:#ededed; }}
.phone {{ max-width:420px; margin:24px auto; padding:20px 16px 40px; background:#fff;
         font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif; }}
.hint {{ max-width:420px; margin:12px auto 0; padding:10px 14px; background:#fffbe6;
         border:1px solid #ffe58f; border-radius:6px; font-size:12px; color:#8c6d1f; line-height:1.6; }}
</style>
</head>
<body>
<div class="phone">
<h1 style="font-size:22px;line-height:1.4;margin:0 0 16px;">{title}</h1>
{body}
</div>
<div class="hint">本地预览：本文由揽宝投研生成器产出，数字来自当日复盘数据底座。
仅作写作/排版预览，未发布、不构成投资建议。</div>
</body>
</html>
"""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="生成公众号文章本地预览 HTML")
    ap.add_argument("--date", required=True, help="复盘日期，如 2026-11-24")
    ap.add_argument("--reviews", default=str(data_path("reviews")), help="复盘目录")
    ap.add_argument("--out", default=None, help="输出目录，默认 wechat-article/output/<date>-preview")
    args = ap.parse_args(argv)

    reviews = Path(args.reviews)
    payload = bp.load_review(reviews, args.date)
    title = wr.seo_title(payload, args.date)
    body = wr.article_html(payload, args.date, bp.BRAND_SITE)

    out_dir = Path(args.out) if args.out else Path(__file__).resolve().parent / "output" / f"{args.date}-preview"
    out_dir.mkdir(parents=True, exist_ok=True)
    preview = out_dir / "preview.html"
    preview.write_text(PREVIEW_TPL.format(title=title, body=body), encoding="utf-8")
    # 同时落一份纯 markdown 标题，方便对照
    (out_dir / "title.txt").write_text(title + "\n", encoding="utf-8")
    print(f"标题：{title}")
    print(f"预览：{preview}")
    print(f"正文 {len(body)} 字符")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
