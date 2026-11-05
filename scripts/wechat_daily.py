"""把每日复盘发到微信公众号（草稿箱，可选直接发布）。

用法（仓库根目录，先在本机 .env 填 WECHAT_APPID / WECHAT_SECRET）：

    .venv/bin/python scripts/wechat_daily.py                 # 库里最新一篇 → 草稿箱
    .venv/bin/python scripts/wechat_daily.py --date 2026-11-04
    .venv/bin/python scripts/wechat_daily.py --publish      # 跳过草稿确认直接群发
    .venv/bin/python scripts/wechat_daily.py --dry-run      # 只渲染正文，不碰微信接口

默认只进草稿箱：在 mp.weixin.qq.com 后台看一眼排版，确认后再群发。
订阅号每天只有一次群发机会，--publish 前想清楚。
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
from review_agent import wechat_publish as wp  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="发布每日复盘到微信公众号")
    ap.add_argument("--date", help="复盘日期；默认库里最新一篇")
    ap.add_argument("--reviews", default=data_path("reviews"), help="复盘目录")
    ap.add_argument("--publish", action="store_true",
                    help="直接提交群发（默认只进草稿箱，人工确认后手动发）")
    ap.add_argument("--dry-run", action="store_true", help="只渲染正文，不调微信接口")
    args = ap.parse_args(argv)

    log = lambda m: print(m, file=sys.stderr, flush=True)  # noqa: E731
    reviews = Path(args.reviews)
    date = args.date.strip()
    if not date:
        dates = bp.iter_dates(reviews, limit=1)
        if not dates:
            print(f"{reviews} 里没有可发布的复盘", file=sys.stderr)
            return 1
        date = dates[0]
    try:
        if args.dry_run:
            payload = bp.load_review(reviews, date)
            bp.check_public_text(payload)
            html = wp.article_html(payload, date, wp.blog_post_url(date))
            print(f"# {bp.post_title(payload, date)}\n")
            print(html)
            log(f"dry-run：{date} 正文 {len(html)} 字符，未调微信接口")
            return 0
        result = wp.publish_review(reviews, date, draft_only=not args.publish, log=log)
    except bp.PublishError as exc:
        print(f"未发布：{exc}", file=sys.stderr)
        return 1
    where = "草稿箱" if not args.publish else "已群发"
    print(f"{date} → 微信公众号（{where}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
