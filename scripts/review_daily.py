"""自动生成当日复盘：向本机后端提交一份「每日复盘」任务，等它跑完。

定时任务用（宿主 cron 或容器内均可）：

    python scripts/review_daily.py                 # 生成最近已收盘交易日的复盘
    python scripts/review_daily.py --wait 3600     # 最长等 60 分钟（默认 3000 秒）
    python scripts/review_daily.py --force         # 那天已复盘也重跑

日期默认取「最近已收盘交易日」（trade_calendar.latest_session），所以周末、节假日、
还没收盘时跑都只会落到上一个真正收盘的交易日，不会为没收盘的今天开跑。

模型来源：默认 codebuddy 订阅（取容器里已登录的 CodeBuddy CLI），可用
--provider / --model 换。后端地址：--base（默认 http://127.0.0.1:8910）；
容器里访问自己的服务，用 http://127.0.0.1:8910 即可。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _api(base: str, path: str, body: dict | None = None, timeout: float = 30) -> dict:
    url = base.rstrip("/") + path
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="提交并等待当日复盘")
    ap.add_argument("--base", default=os.environ.get("REVIEW_BASE", "http://127.0.0.1:8910"),
                    help="后端地址（默认取 REVIEW_BASE 环境变量，否则 127.0.0.1:8910）")
    ap.add_argument("--date", default="", help="指定日期（YYYY-MM-DD）；默认最近已收盘交易日")
    ap.add_argument("--provider", default="codebuddy", help="模型来源：codebuddy / claude / codex-private 等")
    ap.add_argument("--model", default="default", help="模型名，订阅类来源填 default")
    ap.add_argument("--force", action="store_true", help="已复盘过也重跑")
    ap.add_argument("--wait", type=int, default=3000, help="最长等待秒数")
    ap.add_argument("--poll", type=float, default=15.0, help="轮询间隔秒数")
    ap.add_argument("--dry-run", action="store_true", help="只打印将要提交的内容")
    args = ap.parse_args(argv)

    date = args.date.strip()
    if not date:
        from duanxian import trade_calendar
        date = trade_calendar.latest_session() or ""
    if not date:
        print("判不出最近已收盘交易日，放弃", file=sys.stderr)
        return 2

    body = {"date": date, "request_id": uuid.uuid4().hex, "force": args.force,
            "llm": {"provider": args.provider, "model": args.model, "baseURL": "", "apiKey": ""}}
    log = lambda m: print(m, file=sys.stderr, flush=True)  # noqa: E731
    log(f"提交复盘：{date}（{args.provider}/{args.model}）")
    if args.dry_run:
        print(json.dumps(body, ensure_ascii=False))
        return 0
    try:
        started = _api(args.base, "/api/review-agent/daily", body)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:200]
        log(f"提交失败：HTTP {exc.code} {detail}")
        return 1
    except (urllib.error.URLError, OSError) as exc:
        log(f"连不上后端 {args.base}：{exc}")
        return 1
    log(f"已受理：{json.dumps(started, ensure_ascii=False)[:200]}")
    if started.get("already_done") or started.get("status") == "complete":
        return 0

    deadline = time.time() + args.wait
    while time.time() < deadline:
        time.sleep(args.poll)
        try:
            snap = _api(args.base, "/api/review-agent/daily")
        except (urllib.error.URLError, OSError, ValueError) as exc:
            log(f"查询状态失败（继续等）：{exc}")
            continue
        status = str(snap.get("status") or "")
        log(f"状态：{status} · {snap.get('stage') or ''} · 已用 {snap.get('elapsed') or 0}s")
        if status == "complete":
            log("复盘完成")
            return 0
        if status in ("failed", "cancelled", "interrupted"):
            log(f"复盘未完成：{status} {snap.get('error') or ''}")
            return 1
    log(f"等待超时（{args.wait}s），任务可能仍在后台跑")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
