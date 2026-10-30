"""自动生成当日复盘：向本机后端提交一份「每日复盘」任务，等它跑完，成功后按需发布博客。

定时任务用（宿主 cron 或容器内均可）：

    python scripts/review_daily.py                    # 生成最近已收盘交易日的复盘
    python scripts/review_daily.py --publish          # 生成成功后顺手发布博客
    python scripts/review_daily.py --wait 3600        # 单次等待上限（秒），默认 5400
    python scripts/review_daily.py --force            # 那天已复盘也重跑

日期默认取「最近已收盘交易日」（trade_calendar.latest_session），所以周末、节假日、
还没收盘时跑都只会落到上一个真正收盘的交易日，不会为没收盘的今天开跑。

失败重试：订阅侧偶尔会出现「思考了很久但没出正文」被上游中断（CLI 日志里是
Empty stream / finish_reason=error）。这种情况换一个模型重跑通常能过，所以
--fallback-models 里的模型会依次作为重试来源；每个模型只试一次。

后端地址：--base（默认取 REVIEW_BASE，否则 http://127.0.0.1:8910）。
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

DEFAULT_FALLBACK = "gpt-5.6-luna,gpt-5.6-sol"


def _api(base: str, path: str, body: dict | None = None, timeout: float = 30) -> dict:
    url = base.rstrip("/") + path
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _status(base: str) -> dict:
    try:
        return _api(base, "/api/review-agent/daily")
    except (urllib.error.URLError, OSError, ValueError):
        return {}


def _cancel(base: str, job_id: str) -> None:
    if not job_id:
        return
    try:
        _api(base, "/api/review-agent/daily/cancel", {"job_id": job_id})
    except (urllib.error.HTTPError, urllib.error.URLError, OSError):
        pass


def _wait(base: str, wait: float, poll: float, log) -> tuple[str, dict]:
    """等到任务结束；返回 (status, snapshot)。超时返回 ('timeout', snapshot)。"""
    deadline = time.time() + wait
    snap: dict = {}
    while time.time() < deadline:
        time.sleep(poll)
        snap = _status(base)
        status = str(snap.get("status") or "")
        log(f"状态：{status} · {snap.get('stage') or ''} · 已用 {snap.get('elapsed') or 0}s")
        if status in ("complete", "failed", "cancelled", "interrupted"):
            return status, snap
    return "timeout", snap


def _run_once(base: str, date: str, provider: str, model: str, force: bool,
              wait: float, poll: float, log) -> tuple[str, dict]:
    body = {"date": date, "request_id": uuid.uuid4().hex, "force": force,
            "llm": {"provider": provider, "model": model, "baseURL": "", "apiKey": ""}}
    log(f"提交复盘：{date}（{provider}/{model}）")
    try:
        started = _api(base, "/api/review-agent/daily", body)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:200]
        log(f"提交失败：HTTP {exc.code} {detail}")
        return "rejected", {}
    except (urllib.error.URLError, OSError) as exc:
        log(f"连不上后端 {base}：{exc}")
        return "unreachable", {}
    log(f"已受理：{json.dumps(started, ensure_ascii=False)[:200]}")
    if started.get("already_done") or started.get("status") == "complete":
        return "complete", started
    return _wait(base, wait, poll, log)


def _publish(log) -> int:
    """生成成功后立刻发布：只刷最近几篇，历史文章保留。"""
    import subprocess
    env = dict(os.environ)
    # 发布只是读写本地文件 + git，不该被数据源的 no_proxy 口径连带影响
    env.pop("no_proxy", None)
    env.pop("NO_PROXY", None)
    log("发布博客…")
    proc = subprocess.run([sys.executable, str(ROOT / "scripts" / "publish_review.py"), "--recent", "3"],
                          cwd=str(ROOT), capture_output=True, text=True, env=env)
    for line in (proc.stdout or "").strip().splitlines()[-6:]:
        log("  " + line)
    if proc.returncode != 0:
        log(f"发布失败（{proc.returncode}）：{(proc.stderr or '').strip()[:300]}")
    return proc.returncode


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="提交并等待当日复盘")
    ap.add_argument("--base", default=os.environ.get("REVIEW_BASE", "http://127.0.0.1:8910"),
                    help="后端地址（默认取 REVIEW_BASE 环境变量，否则 127.0.0.1:8910）")
    ap.add_argument("--date", default="", help="指定日期（YYYY-MM-DD）；默认最近已收盘交易日")
    ap.add_argument("--provider", default="codebuddy", help="模型来源：codebuddy / claude / codex-private 等")
    ap.add_argument("--model", default="default", help="模型名，订阅类来源填 default")
    ap.add_argument("--fallback-models", default=os.environ.get("REVIEW_FALLBACK_MODELS", DEFAULT_FALLBACK),
                    help="失败后依次换用的模型（逗号分隔，空串=不重试）")
    ap.add_argument("--force", action="store_true", help="已复盘过也重跑")
    ap.add_argument("--wait", type=int, default=5400, help="单次等待上限秒数")
    ap.add_argument("--poll", type=float, default=20.0, help="轮询间隔秒数")
    ap.add_argument("--publish", action="store_true", help="复盘成功后顺带发布博客")
    ap.add_argument("--dry-run", action="store_true", help="只打印将要提交的内容")
    args = ap.parse_args(argv)

    date = args.date.strip()
    if not date:
        from duanxian import trade_calendar
        date = trade_calendar.latest_session() or ""
    if not date:
        print("判不出最近已收盘交易日，放弃", file=sys.stderr)
        return 2

    def log(m: str) -> None:
        print(m, file=sys.stderr, flush=True)

    if args.dry_run:
        print(json.dumps({"date": date, "provider": args.provider, "model": args.model,
                          "fallback": args.fallback_models, "publish": args.publish},
                         ensure_ascii=False))
        return 0

    # 上一轮如果还挂着（卡住/失败未清），先让位，否则新提交会被 400 挡回来
    snap = _status(args.base)
    if snap.get("running"):
        log(f"上一轮仍在跑：{snap.get('date')} · {snap.get('stage')}，先取消")
        _cancel(args.base, str(snap.get("job_id") or ""))
        time.sleep(3)

    models = [args.model] + [m.strip() for m in str(args.fallback_models).split(",") if m.strip()]
    seen: list[str] = []
    for model in models:
        if model in seen:
            continue
        seen.append(model)
        status, snap = _run_once(args.base, date, args.provider, model, args.force, args.wait, args.poll, log)
        if status == "complete":
            log(f"复盘完成（{args.provider}/{model}）")
            if args.publish:
                return _publish(log)
            return 0
        if status == "rejected":
            # 400/409 这类是服务端明确拒绝（比如正在跑别的任务），换模型也没用
            return 1
        if status == "timeout":
            log(f"等待超时（{args.wait}s），任务仍在后台跑，不再换模型")
            return 1
        log(f"{model} 失败：{snap.get('error') or status}")
        _cancel(args.base, str(snap.get("job_id") or ""))
    log("所有模型都失败")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
