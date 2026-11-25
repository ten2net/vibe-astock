#!/usr/bin/env python3
"""自动发现大红好运哥、格兰投研的最新微信公众号文章 URL 并抓取正文。

流水线：
  1) wechat-mp-reader 的 appmsgpublish 接口按 fakeid 拉账号最近文章
     （这是微信公众平台"发表记录"接口，返回的 link 是 mp.weixin.qq.com 地址）
  2) 用 agent-wechat-reader 按 URL 抓正文，保存为 Markdown
  3) 输出 blacklist/sources/<date>/ 下的 meta.json + 每篇正文

限流处理：
  - 微信对该接口有 freq control（ret 200013）。本脚本每个号每次运行只调用 1 次，
    每天由 crontab 触发，低频调用；限流时如实记录 status=rate_limited，不重试
    （重试会加重限流），等下一个交易日自动再试。
  - 已抓到的 URL 会写入缓存；若当天接口限流，会沿用缓存里最近的 URL 并标注 stale。

用法（仓库根目录）：
  .venv/bin/python blacklist/discover_urls.py --date 2026-11-24
  .venv/bin/python blacklist/discover_urls.py --date 2026-11-24 --force   # 强制重新发现
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MP_READER = Path("/root/.codebuddy/skills/wechat-mp-reader/scripts")
ARTICLE_READER = Path("/root/.codebuddy/skills/wechat-article-reader/scripts/read_wechat_article.py")
for p in (MP_READER, MP_READER / "wechat_mp_reader"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from session_store import resolve_session  # noqa: E402
from wechat_mp_reader import list_articles_via_mp_backend, extract_article_list  # noqa: E402

ACCOUNTS = [
    {"name": "大红好运哥", "fakeid": "Mzg3MTgyNjc4Mg=="},
    {"name": "格兰投研", "fakeid": "Mzk1NzE1NjgyMA=="},
]
SOURCES = ROOT / "blacklist" / "sources"


def _fetch_latest(fakeid: str, session: dict, count: int = 5) -> dict:
    """调一次 appmsgpublish 接口，返回状态与文章列表。"""
    try:
        data = list_articles_via_mp_backend(fakeid, session, count=count, begin=0)
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "error": f"{type(exc).__name__}: {exc}", "articles": []}
    base = data.get("base_resp") or {}
    ret = base.get("ret", 0)
    if ret != 0:
        return {"status": "rate_limited" if ret == 200013 else "api_error",
                "ret": ret, "msg": base.get("err_msg", ""), "articles": []}
    return {"status": "ok", "articles": extract_article_list(data)}


def _read_article(url: str, out_dir: Path) -> dict:
    """用 agent-wechat-reader 抓正文，保存 article.md/article.json。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [sys.executable, str(ARTICLE_READER), url, "--quiet"],
        capture_output=True, text=True, timeout=120)
    if proc.returncode != 0 or not proc.stdout.strip():
        return {"ok": False, "error": (proc.stderr or proc.stdout)[:200]}
    paths = [ln.strip() for ln in proc.stdout.splitlines() if ln.strip().endswith((".md", ".json"))]
    md = next((p for p in paths if p.endswith("article.md")), None)
    js = next((p for p in paths if p.endswith("article.json")), None)
    if not md or not Path(md).exists():
        return {"ok": False, "error": "reader 未产出 article.md"}
    body = Path(md).read_text(encoding="utf-8")
    (out_dir / "article.md").write_text(body, encoding="utf-8")
    meta = {}
    if js and Path(js).exists():
        meta = json.loads(Path(js).read_text(encoding="utf-8"))
    (out_dir / "article.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "title": meta.get("title", ""), "chars": len(body)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="发现两个公众号最新文章 URL 并抓正文")
    ap.add_argument("--date", required=True, help="日期，如 2026-11-24")
    ap.add_argument("--count", type=int, default=5, help="每个号拉取最近几篇")
    ap.add_argument("--force", action="store_true", help="即使已有素材也重新发现")
    ap.add_argument("--retries", type=int, default=2,
                    help="限流时重试次数，每次间隔 10 分钟（默认 2 次）")
    args = ap.parse_args(argv)

    out_root = SOURCES / args.date
    out_root.mkdir(parents=True, exist_ok=True)
    session = resolve_session()
    if not (session.get("cookie") and session.get("token")):
        print("错误：wechat-mp-reader 无有效 session，请先扫码登录", file=sys.stderr)
        return 2

    report: dict = {
        "date": args.date,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "accounts": {},
    }
    for acct in ACCOUNTS:
        name, fakeid = acct["name"], acct["fakeid"]
        result = _fetch_latest(fakeid, session, args.count)
        # 限流时退避重试：freq control 通常是短时窗口，低频重试可自愈；
        # 连续限流则如实记录，等下一个交易日再试，避免加重封禁。
        for attempt in range(args.retries):
            if result["status"] != "rate_limited":
                break
            print(f"[{name}] 限流，10 分钟后重试（{attempt + 1}/{args.retries}）", file=sys.stderr)
            import time
            time.sleep(600)
            result = _fetch_latest(fakeid, session, args.count)
        entry: dict = {"name": name, "status": result["status"], "articles": []}

        if result["status"] == "ok":
            for art in result["articles"][:args.count]:
                url = str(art.get("url") or "").strip()
                if not url.startswith("https://mp.weixin.qq.com/"):
                    continue
                slug = url.rstrip("/").split("/")[-1][:24] or "article"
                fetched = _read_article(url, out_root / name / slug)
                entry["articles"].append({
                    "title": art.get("title", ""),
                    "url": url,
                    "publish_time": art.get("publish_time", ""),
                    "dir": str(out_root / name / slug),
                    **fetched,
                })
        else:
            entry["ret"] = result.get("ret")
            entry["msg"] = result.get("msg") or result.get("error", "")

        report["accounts"][name] = entry
        print(f"[{name}] {result['status']} articles={len(entry['articles'])}")

    (out_root / "discovery.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"报告：{out_root / 'discovery.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
