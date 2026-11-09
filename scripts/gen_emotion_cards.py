"""生成情绪卡片图（社交平台 OG 头图）。

用法（仓库根目录）：

    .venv/bin/python scripts/gen_emotion_cards.py                 # 全部复盘 + latest.png
    .venv/bin/python scripts/gen_emotion_cards.py --date 2026-11-06
    .venv/bin/python scripts/gen_emotion_cards.py --reviews /path/to/reviews --out /path/to/cards

产物落到 ``blog/static/cards/``（Hugo staticDir），构建时原样拷到 public/cards/。
正式发布 ``scripts/publish_review.py`` 会在写 md 之后自动调用同一个生成函数，
一般不需要手动跑；本脚本用于单独预览/补生成。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from duanxian.paths import data_path  # noqa: E402
from review_agent import emotion_card  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="生成每日复盘情绪卡片 PNG")
    ap.add_argument("--date", action="append", dest="dates",
                    help="只生成指定日期（可重复）；默认全部")
    ap.add_argument("--reviews", default=data_path("reviews"), help="复盘 json 目录")
    ap.add_argument("--out", default=str(ROOT / "blog" / "static" / "cards"),
                    help="输出目录，默认 blog/static/cards")
    args = ap.parse_args(argv)

    log = lambda m: print(m, file=sys.stderr)  # noqa: E731
    if args.dates:
        dates = args.dates
    else:
        dates = emotion_card.iter_review_dates(args.reviews)
    if not dates:
        log(f"{args.reviews} 里没有可生成卡片的复盘")
        return 1

    written = emotion_card.generate(args.reviews, args.out, dates=dates, log=log)
    if not written:
        return 1
    for p in written:
        print(p)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
