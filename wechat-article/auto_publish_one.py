#!/usr/bin/env python3
"""按序自动发布一篇头条文章（带强查重 + 发布后验证）。

安全设计（针对之前误发4篇的事故）：
- 发布前读取头条已发布列表，跳过已发标题，只选第一篇未发的。
- 发布按钮用精确文本"预览并发布"，绝不点含"发布"的兜底选择器（会误点"定时发布"）。
- 只点一次；二次确认仅当精确按钮存在时点一次。
- 发布后立即复查已发布列表：恰好新增1篇且标题匹配才算成功，否则报警。
- 全程写状态日志 publish_state.json / publish.log。

用法：
    python auto_publish_one.py            # 真实发布一篇（选第一篇未发的）
    python auto_publish_one.py --dry-run  # 只走查重和填充，不点发布
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

SKILL_DIR = Path("/root/.codebuddy/skills/@clawhub_guanyang/toutiao-publisher")
PROJECT_DIR = Path(__file__).resolve().parent
SERIES = PROJECT_DIR / "output/2026-11-23-series"
STATE_FILE = PROJECT_DIR / "publish_state.json"
LOG_FILE = PROJECT_DIR / "publish.log"
PUBLISH_URL = "https://mp.toutiao.com/profile_v4/graphic/publish"
ARTICLES_URL = "https://mp.toutiao.com/profile_v4/graphic/articles"


def log(msg: str):
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


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


def _ensure_patchright():
    sys.path.insert(0, str(SKILL_DIR / "scripts"))
    try:
        from patchright.sync_api import sync_playwright
    except ModuleNotFoundError:
        import glob

        for s in glob.glob(str(SKILL_DIR / ".venv/lib/python*/site-packages")):
            sys.path.insert(0, s)
        from patchright.sync_api import sync_playwright
    return sync_playwright


def fetch_published(page) -> list[str]:
    """读已发布列表标题（只读）。结合 API 与页面文本，覆盖"审核中"状态。"""
    titles: list[str] = []

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
    page.goto(ARTICLES_URL, timeout=60000)
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(6000)
    page.reload(timeout=60000)
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(6000)

    # API 常漏掉"审核中"的文章，补充读页面文本：本地标题出现在列表里就算已发
    body = page.locator("body").inner_text()
    for it in load_local():
        if it["title"] and it["title"] in body:
            titles.append(it["title"])
    # 去重保序
    seen = set()
    unique = []
    for t in titles:
        if t not in seen:
            seen.add(t)
            unique.append(t)
    return unique


def publish_one(page, item: dict, dry_run: bool) -> bool:
    """填充并发布一篇文章。发布按钮精确匹配，只点一次。"""
    page.goto(PUBLISH_URL, timeout=60000)
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(5000)

    # 登录 guard：必须有编辑器
    try:
        page.wait_for_selector(".ProseMirror", state="attached", timeout=10000)
    except Exception:
        log("❌ 未登录或发布页无编辑器，中止")
        return False

    # 关闭"头条创作助手"抽屉（它会遮挡发布按钮）
    try:
        for sel in (".byte-drawer-mask", ".ai-assistant-drawer"):
            el = page.locator(sel)
            if el.count() > 0 and el.first.is_visible():
                el.first.click(force=True, position={"x": 5, "y": 5}, timeout=3000)
                page.wait_for_timeout(500)
                log(f"  已关闭遮挡: {sel}")
    except Exception:
        pass

    # 标题
    page.locator("textarea").first.fill(item["title"])
    log(f"  标题已填: {item['title']}")

    # 正文（剪贴板粘贴 HTML）
    html = item["html"].read_text(encoding="utf-8")
    page.evaluate(
        """(html) => {
            const ed = document.querySelector('.ProseMirror');
            ed.focus(); ed.innerHTML = '';
            const dt = new DataTransfer();
            dt.setData('text/html', html);
            dt.setData('text/plain', html.replace(/<[^>]+>/g, ''));
            ed.dispatchEvent(new ClipboardEvent('paste', {
                bubbles: true, cancelable: true, clipboardData: dt
            }));
        }""",
        html,
    )
    page.wait_for_timeout(2000)
    chars = len(page.locator(".ProseMirror").first.inner_text())
    log(f"  正文已填: {chars} 字符")

    # 封面
    try:
        add = page.locator("div.article-cover-add").first
        if add.is_visible():
            add.click(timeout=10000)
        up = page.locator("div.btn-upload-handle.upload-handler").first
        if up.is_visible():
            up.click(timeout=10000)
        fi = page.locator("input[type='file']").first
        fi.set_input_files(str(item["cover"]))
        confirm = page.locator("button[data-e2e='imageUploadConfirm-btn']")
        confirm.wait_for(state="visible", timeout=30000)
        page.wait_for_timeout(1500)
        confirm.click(timeout=5000)
        log("  封面已上传")
    except Exception as e:
        log(f"  ⚠️ 封面上传失败: {str(e)[:100]}")

    if chars < 100:
        log("❌ 正文字符过少，疑似填充失败，中止发布")
        return False

    if dry_run:
        log("  [dry-run] 不点击发布")
        return True

    # 关闭可能遮挡发布按钮的引导气泡（"我知道了"等）
    for _ in range(5):
        try:
            tip = page.get_by_text("我知道了", exact=True)
            if tip.count() > 0 and tip.last.is_visible():
                tip.last.click(timeout=3000)
                page.wait_for_timeout(400)
                log("  已关闭引导气泡")
                continue
        except Exception:
            pass
        break

    # === 精确点击发布：只认 primary 的"预览并发布"，不碰"定时发布" ===
    btn = page.locator('button.byte-btn-primary').filter(has_text="预览并发布")
    if btn.count() == 0 or not btn.is_visible():
        log("❌ 找不到精确的'预览并发布'按钮，中止（不尝试模糊匹配）")
        return False
    btn.click(timeout=10000, force=True, no_wait_after=True)
    log("  已点击'预览并发布'（仅一次）")

    # 预览弹窗里的最终确认按钮：明确等它出现再点一次
    final = page.locator(".publish-btn-last").first
    try:
        final.wait_for(state="visible", timeout=15000)
        final.click(timeout=8000)
        log("  已点击最终确认（仅一次）")
    except Exception as e:
        log(f"  ⚠️ 未找到最终确认按钮: {str(e)[:80]}")
        return False
    page.wait_for_timeout(8000)
    return True


def main():
    ap = argparse.ArgumentParser(description="按序自动发布一篇头条")
    ap.add_argument("--dry-run", action="store_true", help="不真发")
    args = ap.parse_args()

    sync_playwright = _ensure_patchright()
    local = load_local()

    with sync_playwright() as p:
        from browser_utils import BrowserFactory

        ctx = BrowserFactory.launch_persistent_context(p, headless=True)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        # 关键：拦截发布请求，把 save=0 改成 save=1，否则后端返回 7050 发不出去
        def rewrite_save(route):
            pd = route.request.post_data or ""
            if "save=0" in pd:
                pd = pd.replace("save=0", "save=1", 1)
                log("  已改写 save=0 -> save=1")
            route.continue_(post_data=pd)

        page.route("**/mp/agw/article/publish**", rewrite_save)

        before = fetch_published(page)
        log(f"发布前已发布 {len(before)} 篇")
        pub_norm = {t.strip() for t in before}

        pending = [it for it in local if it["title"] not in pub_norm]
        if not pending:
            log("✅ 全部文章均已发布，无需操作")
            ctx.close()
            return
        target = pending[0]
        log(f"目标: [{target['folder']}] {target['title']}")

        ok = publish_one(page, target, args.dry_run)
        if not ok:
            log("❌ 发布流程未完成")
            ctx.close()
            sys.exit(1)

        if args.dry_run:
            ctx.close()
            return

        # 发布后验证：列表 API 有延迟，重试几次
        after = fetch_published(page)
        for attempt in range(3):
            if target["title"] in {t.strip() for t in after}:
                break
            page.wait_for_timeout(5000)
            after = fetch_published(page)
        log(f"发布后已发布 {len(after)} 篇")
        added = len(after) - len(before)
        matched = target["title"] in {t.strip() for t in after}
        if added == 1 and matched:
            log("✅ 验证通过：恰好新增1篇且标题匹配")
            state = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}
            state.setdefault("published", []).append(
                {"folder": target["folder"], "title": target["title"], "time": datetime.now().isoformat()}
            )
            STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2))
        else:
            log(f"⚠️ 验证异常：新增 {added} 篇，标题匹配={matched}。请人工核查！")
            sys.exit(2)
        ctx.close()


if __name__ == "__main__":
    main()
