#!/usr/bin/env python3
"""查重：读取头条已发布文章列表，对照本地10篇，给出发布建议。

不执行任何发布/删除动作，只读。每次手动发布前先跑一遍，确认标题未发布。

用法：
    python check_toutiao_published.py              # 对照全部10篇
    python check_toutiao_published.py --next       # 只输出下一篇建议发布的
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SKILL_DIR = Path("/root/.codebuddy/skills/@clawhub_guanyang/toutiao-publisher")
PROJECT_DIR = Path(__file__).resolve().parent
SERIES = PROJECT_DIR / "output/2026-11-23-series"


def load_local() -> list[dict]:
    items = []
    for sidecar in sorted(SERIES.glob("*/article.toutiao.json")):
        d = json.loads(sidecar.read_text(encoding="utf-8"))
        items.append(
            {
                "folder": sidecar.parent.name,
                "title": d.get("title", "").strip(),
                "html": sidecar.parent / "article.toutiao.html",
                "cover": sidecar.parent / d.get("cover", "./cover.png").strip(),
            }
        )
    return items


def fetch_published_titles() -> list[str]:
    """通过已登录的浏览器上下文读取头条已发布文章标题。只读。"""
    sys.path.insert(0, str(SKILL_DIR / "scripts"))
    # patchright 装在 skill 自己的 venv 里，不在项目 venv
    try:
        from patchright.sync_api import sync_playwright
    except ModuleNotFoundError:
        import glob

        sites = glob.glob(str(SKILL_DIR / ".venv/lib/python*/site-packages"))
        for s in sites:
            sys.path.insert(0, s)
        from patchright.sync_api import sync_playwright
    from browser_utils import BrowserFactory

    titles: list[str] = []
    with sync_playwright() as p:
        ctx = BrowserFactory.launch_persistent_context(p, headless=True)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(
            "https://mp.toutiao.com/profile_v4/graphic/articles", timeout=60000
        )
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(6000)

        # 从 feed API 响应里收集标题（列表页实际数据源）
        def on_resp(resp):
            if "/api/feed/mp_provider/" in resp.url:
                try:
                    data = resp.json()
                except Exception:
                    return
                for item in data.get("data", []) or []:
                    t = (
                        item.get("title")
                        or item.get("article_title")
                        or (item.get("base_info") or {}).get("title")
                    )
                    if t:
                        titles.append(t.strip())

        page.on("response", on_resp)
        # 再刷一次确保捕获到数据请求
        page.reload(timeout=60000)
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(6000)

        # API 常漏掉"审核中"的文章，补充读页面文本
        body = page.locator("body").inner_text()
        for it in load_local():
            if it["title"] and it["title"] in body:
                titles.append(it["title"])
        ctx.close()
    return titles


def main():
    ap = argparse.ArgumentParser(description="头条已发布查重（只读）")
    ap.add_argument("--next", action="store_true", help="只输出下一篇建议发布的")
    args = ap.parse_args()

    print("正在读取头条已发布列表...", flush=True)
    published = fetch_published_titles()
    pub_norm = {t.strip() for t in published}
    print(f"已发布 {len(published)} 篇\n", flush=True)

    local = load_local()
    pending = [it for it in local if it["title"] not in pub_norm]

    if args.next:
        if not pending:
            print("全部10篇均已发布，无待发。")
            return
        nxt = pending[0]
        print(f"下一篇建议发布：\n  [{nxt['folder']}] {nxt['title']}")
        print(f"  正文：{nxt['html']}")
        print(f"  封面：{nxt['cover']}")
        return

    for it in local:
        mark = "已发布" if it["title"] in pub_norm else "待发布"
        print(f"  [{it['folder']}] {mark}  {it['title']}")

    print(f"\n待发布 {len(pending)} 篇：")
    for i, it in enumerate(pending, 1):
        print(f"  {i}. [{it['folder']}] {it['title']}")

    if pending:
        print(f"\n按序下一篇：{pending[0]['title']}")
        print("发布方式：手动在头条网页复制 article.toutiao.html 正文，发布前再跑一次本脚本确认。")


if __name__ == "__main__":
    main()
