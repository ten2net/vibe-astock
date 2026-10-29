"""把每日复盘发到 Hugo 博客：写 md → 构建 → 同步到 GitHub Pages。

用法（仓库根目录）：

    .venv/bin/python scripts/publish_review.py                  # 全部可用复盘 + 构建 + 推送
    .venv/bin/python scripts/publish_review.py --date 2026-09-23
    .venv/bin/python scripts/publish_review.py --dry-run        # 只写 md，不构建不推
    .venv/bin/python scripts/publish_review.py --no-push        # 构建并提交到临时克隆，不推

站点源在本仓库 blog/（Hugo，主题 themes/astock）；构建产物 public/ 同步进
ten2net/ten2net.github.io，站上原有文件不动。
凭据：本机 gh 已登录即可；没有 gh 就设 ASTOCK_PAGES_TOKEN（该仓库写权限）。
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from duanxian.paths import data_path  # noqa: E402
from review_agent import blog_publish  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="发布每日复盘到 Hugo 博客")
    ap.add_argument("--date", help="只发布这一天（仍会重建整站）；默认刷新全部")
    ap.add_argument("--reviews", default=data_path("reviews"), help="复盘目录，默认本机数据区")
    ap.add_argument("--site", default=str(ROOT / "blog"), help="Hugo 源目录，默认仓库内 blog/")
    ap.add_argument("--hugo", default=None, help="hugo 可执行文件；默认 PATH 或 .local/bin/hugo")
    ap.add_argument("--agent-home", default=None,
                    help="复盘任务目录根（资金/龙虎榜原文在这里）；默认 ~/.vibe-astock-agent 或环境变量 ASTOCK_AGENT_HOME")
    ap.add_argument("--repo", default="ten2net/ten2net.github.io")
    ap.add_argument("--branch", default="master")
    ap.add_argument("--limit", type=int, default=366, help="最多发布多少份")
    ap.add_argument("--recent", type=int, default=0,
                    help="只发布库里最新的 N 篇（定时任务用，默认 0 = 全部）")
    ap.add_argument("--dry-run", action="store_true", help="只写 md，不构建、不碰远程")
    ap.add_argument("--no-push", action="store_true", help="构建并提交到临时克隆，但不推送")
    args = ap.parse_args(argv)
    log = lambda m: print(m, file=sys.stderr)  # noqa: E731
    if args.agent_home:
        os.environ["ASTOCK_AGENT_HOME"] = args.agent_home
    try:
        result = blog_publish.publish(
            args.site, Path(args.reviews), date=args.date, repo=args.repo, branch=args.branch,
            max_pages=args.limit, hugo=args.hugo, dry_run=args.dry_run,
            push=not args.no_push, min_days=args.recent, log=log,
        )
    except blog_publish.PublishError as exc:
        print(f"未发布：{exc}", file=sys.stderr)
        return 1
    print(f"站点：{result.url}")
    print(f"写入 {len(result.written)} 个源文件，构建 {result.built} 个页面")
    if result.removed:
        print(f"移除 {len(result.removed)} 项：{', '.join(result.removed[:10])}")
    if args.dry_run:
        print("（dry-run：没有构建，也没有提交）")
    elif result.committed:
        print(f"提交 {result.commit}，{'已推送' if result.pushed else '未推送'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
