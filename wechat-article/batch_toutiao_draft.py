#!/usr/bin/env python3
"""批量把公众号文章的头条版存进头条号草稿箱。

数据来源：output/*-series/*/article.toutiao.json（由 wechat_to_toutiao.py 生成）
每篇读取 title / cover / html，调用 toutiao-publisher skill 的 publisher.py --save-draft。

用法：
    python batch_toutiao_draft.py                 # dry-run：只打印将执行的命令
    python batch_toutiao_draft.py --execute       # 真实存草稿（需先扫码登录）
    python batch_toutiao_draft.py --execute --only 01 03   # 只处理指定编号
    python batch_toutiao_draft.py --execute --interval 8   # 自定义每篇间隔秒数

前置：
    1. 已运行 wechat_to_toutiao.py --series --dedupe 生成 sidecar
    2. 已扫码登录：cd <skill> && python scripts/run.py auth_manager.py setup
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

SKILL_DIR = Path(
    "/root/.codebuddy/skills/@clawhub_guanyang/toutiao-publisher"
)
PROJECT_DIR = Path(__file__).resolve().parent
SERIES_GLOB = "output/2026-11-23-series/*/article.toutiao.json"


def collect(only: set[str] | None) -> list[dict]:
    """收集所有文章，按标题去重，返回待处理列表。"""
    seen_titles: set[str] = set()
    items: list[dict] = []
    for sidecar in sorted(PROJECT_DIR.glob(SERIES_GLOB)):
        data = json.loads(sidecar.read_text(encoding="utf-8"))
        title = data.get("title", "").strip()
        folder = sidecar.parent.name
        if not title:
            print(f"  [跳过] 无标题：{sidecar}", file=sys.stderr)
            continue
        if title in seen_titles:
            print(f"  [去重] {folder}: {title}")
            continue
        if only and folder not in only:
            continue
        seen_titles.add(title)

        cover_rel = data.get("cover", "").strip()  # 形如 ./cover.png
        cover = (sidecar.parent / cover_rel).resolve()
        html = sidecar.parent / "article.toutiao.html"

        items.append(
            {
                "folder": folder,
                "title": title,
                "html": html,
                "cover": cover,
                "sidecar": sidecar,
            }
        )
    return items


def build_cmd(item: dict, headless: bool) -> list[str]:
    """组装调用 skill 的命令（通过 run.py 以自动管理 venv/依赖）。"""
    return [
        sys.executable,
        str(SKILL_DIR / "scripts" / "run.py"),
        "publisher.py",
        "--title",
        item["title"],
        "--content",
        str(item["html"]),
        "--cover",
        str(item["cover"]),
        "--raw",
        "--save-draft",
    ] + (["--headless"] if headless else [])


def preflight(items: list[dict]) -> bool:
    """校验依赖文件是否齐全。"""
    ok = True
    for it in items:
        if not it["html"].exists():
            print(f"  ❌ 缺 HTML: {it['html']}", file=sys.stderr)
            ok = False
        if not it["cover"].exists():
            print(f"  ❌ 缺封面: {it['cover']}", file=sys.stderr)
            ok = False
    run_py = SKILL_DIR / "scripts" / "run.py"
    if not run_py.exists():
        print(f"  ❌ 缺 skill 入口: {run_py}", file=sys.stderr)
        ok = False
    return ok


def main():
    ap = argparse.ArgumentParser(description="批量存头条草稿箱")
    ap.add_argument("--execute", action="store_true", help="真实执行（默认仅 dry-run）")
    ap.add_argument("--only", nargs="*", help="只处理指定编号文件夹，如 01 03")
    ap.add_argument("--interval", type=int, default=6, help="每篇之间间隔秒数（默认6）")
    ap.add_argument("--headless", action="store_true", help="无头模式（需已有登录态）")
    args = ap.parse_args()

    only = set(args.only) if args.only else None
    items = collect(only)
    if not items:
        print("没有待处理的文章。请先运行 wechat_to_toutiao.py --series --dedupe")
        return

    print(f"共 {len(items)} 篇待处理：")
    for i, it in enumerate(items, 1):
        print(f"  {i:2d}. [{it['folder']}] {it['title']}")
    print()

    if not preflight(items):
        print("\n前置检查失败，请修复后重试。", file=sys.stderr)
        sys.exit(1)

    if not args.execute:
        print("=== DRY RUN：以下为将执行的命令（未真正发布）===\n")
        for it in items:
            cmd = build_cmd(it, args.headless)
            print(f"[{it['folder']}] " + " ".join(cmd))
        print("\n确认无误后加 --execute 真实存草稿。")
        return

    # 真实执行
    import subprocess

    results: list[tuple[str, bool, str]] = []
    for i, it in enumerate(items, 1):
        cmd = build_cmd(it, args.headless)
        print(f"\n=== [{i}/{len(items)}] {it['folder']} {it['title']} ===")
        try:
            proc = subprocess.run(
                cmd,
                cwd=str(SKILL_DIR),
                capture_output=True,
                text=True,
                timeout=300,
            )
            out = proc.stdout + proc.stderr
            # 终端只打印尾部关键行，完整输出写日志
            tail = "\n".join(out.strip().splitlines()[-12:])
            print(tail)
            success = proc.returncode == 0 and (
                "Draft saved" in out or "draft save clicked" in out.lower()
            )
            results.append((it["folder"], success, out))
            log = it["sidecar"].parent / "toutiao_draft.log"
            log.write_text(out, encoding="utf-8")
        except subprocess.TimeoutExpired:
            print("  ❌ 超时（300s）")
            results.append((it["folder"], False, "TIMEOUT"))
        except Exception as e:
            print(f"  ❌ 异常：{e}")
            results.append((it["folder"], False, str(e)))

        if i < len(items):
            print(f"  ⏳ 间隔 {args.interval}s 防风控...")
            time.sleep(args.interval)

    print("\n=== 汇总 ===")
    for folder, success, _ in results:
        print(f"  {'✅' if success else '❌'} {folder}")
    failed = [f for f, s, _ in results if not s]
    if failed:
        print(f"\n失败 {len(failed)} 篇：{', '.join(failed)}")
        print("可用 --only 单独重试，并检查各目录 toutiao_draft.log 与 debug_*.png")


if __name__ == "__main__":
    main()
