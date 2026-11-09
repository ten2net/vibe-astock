"""社媒分发独立入口（补发 / 调试）。

用法（仓库根目录）：

    .venv/bin/python scripts/social_daily.py --dry-run           # 全流程不调平台 API
    .venv/bin/python scripts/social_daily.py --date 2026-11-06
    .venv/bin/python scripts/social_daily.py --platform x --platform tg

正常发布时 ``scripts/publish_review.py`` 会自动调用分发，一般不用手动跑。
凭据：TG_BOT_TOKEN / TG_CHAT_ID、X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN /
X_ACCESS_SECRET（缺哪个平台就跳过哪个，不影响其他平台）。雪球始终只出图文包。
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
from review_agent import emotion_card as ec  # noqa: E402
from review_agent import social_links, social_publish as sp  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="把每日复盘分发到 X / TG / 雪球图文包")
    ap.add_argument("--date", help="复盘日期；默认库里最新一篇")
    ap.add_argument("--reviews", default=data_path("reviews"), help="复盘 json 目录")
    ap.add_argument("--cards", default=str(ROOT / "blog" / "static" / "cards"))
    ap.add_argument("--packs", default=str(ROOT / "blog" / "static" / "social" / "packs"))
    ap.add_argument("--platform", action="append", dest="platforms",
                    choices=sp.PLATFORMS, help="只分发指定平台（可重复）")
    ap.add_argument("--dry-run", action="store_true", help="不调用任何平台 API")
    ap.add_argument("--no-vertical", action="store_true",
                    help="不重新生成竖版卡片（用已有的）")
    args = ap.parse_args(argv)

    log = lambda m: print(m, file=sys.stderr)  # noqa: E731
    reviews = Path(args.reviews)
    if args.date:
        dates = [args.date]
    else:
        dates = ec.iter_review_dates(reviews)[:1]
    if not dates:
        log(f"{reviews} 里没有可发布的复盘")
        return 1

    platforms = tuple(args.platforms) if args.platforms else sp.PLATFORMS
    # 跳页（UTM）与竖版卡片：保证分发时素材齐全
    social_links.go_pages(ROOT / "blog" / "static" / "go", dates,
                          platforms=tuple(p for p in platforms if p in social_links.PLATFORMS)
                          or social_links.PLATFORMS, log=log)
    if not args.no_vertical:
        ec.generate(reviews, args.cards, dates=dates, vertical=True, log=log)

    for date in dates:
        payload = bp.load_review(reviews, date)
        result = sp.distribute(
            date, payload, reviews_dir=reviews, cards_dir=args.cards,
            packs_dir=args.packs, dry_run=args.dry_run, platforms=platforms, log=log,
        )
        print(f"{date}: {result.outcomes}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
