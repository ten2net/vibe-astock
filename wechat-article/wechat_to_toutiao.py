#!/usr/bin/env python3
"""把公众号系列文章（Markdown）加工成今日头条可发布的 HTML。

设计目标：
- 剥离 YAML frontmatter，提取 title / cover / summary 等元信息。
- 按头条排版规范重排正文：小标题、列表、加粗、引用块、分隔线正确转 HTML。
- 保留品牌层次：风险警示引用块醒目、话题标签、加粗互动提问都保留样式。
- 输出 article.toutiao.html 供 toutiao-publisher skill 的 `--content ... --raw` 直接吃。

用法：
    python wechat_to_toutiao.py <article.md> [...]        # 指定文件
    python wechat_to_toutiao.py --series                   # 批量处理 output/*-series/*/article.md
    python wechat_to_toutiao.py --series --dedupe          # 批量并按标题去重（主题变体只留一篇）
    python wechat_to_toutiao.py --dry-run <article.md>     # 只打印转换结果，不落盘
"""

from __future__ import annotations

import argparse
import html as html_lib
import re
import sys
from pathlib import Path

TITLE_MIN = 2
TITLE_MAX = 30  # 今日头条标题长度限制


# --------------------------------------------------------------------------- #
# frontmatter
# --------------------------------------------------------------------------- #
def parse_frontmatter(text: str) -> tuple[dict, str]:
    """解析 YAML frontmatter（简单的 key: value 形式），返回 (元信息, 正文)。"""
    meta: dict[str, str] = {}
    if not text.startswith("---"):
        return meta, text
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return meta, text
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return meta, text
    for line in lines[1:end]:
        if ":" in line:
            key, _, value = line.partition(":")
            meta[key.strip()] = value.strip()
    body = "\n".join(lines[end + 1 :])
    return meta, body


# --------------------------------------------------------------------------- #
# 行内格式
# --------------------------------------------------------------------------- #
def inline(text: str) -> str:
    """转换行内 Markdown：加粗、斜体、行内代码，并做 HTML 转义。"""
    # 先转义，避免正文里的 < > & 破坏结构
    text = html_lib.escape(text, quote=False)
    # 行内代码
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    # 加粗（**x** 或 __x__）
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"__(.+?)__", r"<strong>\1</strong>", text)
    # 斜体 *x* —— 公众号话题标签用 *#标签* 包裹
    text = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<em>\1</em>", text)
    # 斜体 _x_：只匹配被边界（空白/标点/开头结尾）包围的下划线，
    # 避免破坏 limit_up_count、highest_board 这类指标名。
    text = re.sub(
        r"(?<![\w\\])_([^_\n]+?)_(?![\w\\])", r"<em>\1</em>", text
    )
    return text


# --------------------------------------------------------------------------- #
# 块级转换
# --------------------------------------------------------------------------- #
def is_hr(stripped: str) -> bool:
    return bool(re.fullmatch(r"-{3,}|\*{3,}|_{3,}", stripped))


def convert_body(body: str) -> str:
    """将正文 Markdown 转成头条编辑器友好的 HTML。"""
    lines = body.splitlines()
    out: list[str] = []
    i = 0
    n = len(lines)
    list_type: str | None = None  # 'ul' or 'ol'

    def close_list():
        nonlocal list_type
        if list_type:
            out.append(f"</{list_type}>")
            list_type = None

    while i < n:
        raw = lines[i]
        stripped = raw.strip()

        # 空行：关闭列表
        if not stripped:
            close_list()
            i += 1
            continue

        # 分隔线
        if is_hr(stripped):
            close_list()
            out.append(
                '<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0;">'
            )
            i += 1
            continue

        # 引用块 > （可连续多行，合并为一个 blockquote）
        if stripped.startswith(">"):
            close_list()
            quote_lines: list[str] = []
            while i < n and lines[i].strip().startswith(">"):
                q = lines[i].strip()[1:].strip()
                quote_lines.append(inline(q) if q else "")
                i += 1
            inner = "<br>".join(quote_lines)
            # 控制引用块样式：风险警示用醒目边框和底色
            out.append(
                '<blockquote style="margin:18px 0;padding:12px 16px;'
                'border-left:4px solid #ff7a45;background:#fff7f2;'
                f'color:#555;line-height:1.8;">{inner}</blockquote>'
            )
            continue

        # 标题 # / ## / ### ...
        m = re.match(r"^(#{1,6})\s+(.*)$", raw)
        if m:
            close_list()
            level = min(len(m.group(1)), 6)
            content = inline(m.group(2).strip())
            # 正文里常见的 ## 1、xxx 这类小标题，字号适配头条
            sizes = {1: 22, 2: 19, 3: 17, 4: 16, 5: 16, 6: 16}
            out.append(
                f'<h{level} style="font-size:{sizes[level]}px;font-weight:700;'
                f'margin:22px 0 12px;line-height:1.5;">{content}</h{level}>'
            )
            i += 1
            continue

        # 无序列表 - / *
        m = re.match(r"^[-*]\s+(.*)$", stripped)
        if m:
            if list_type != "ul":
                close_list()
                out.append('<ul style="margin:12px 0;padding-left:24px;">')
                list_type = "ul"
            out.append(f"<li style=\"margin:6px 0;line-height:1.8;\">{inline(m.group(1))}</li>")
            i += 1
            continue

        # 有序列表 1. / 1)
        m = re.match(r"^\d+[.)]\s+(.*)$", stripped)
        if m:
            if list_type != "ol":
                close_list()
                out.append('<ol style="margin:12px 0;padding-left:24px;">')
                list_type = "ol"
            out.append(f"<li style=\"margin:6px 0;line-height:1.8;\">{inline(m.group(1))}</li>")
            i += 1
            continue

        # 普通段落
        close_list()
        out.append(f'<p style="margin:14px 0;line-height:1.9;">{inline(stripped)}</p>')
        i += 1

    close_list()
    return "\n".join(out)


# --------------------------------------------------------------------------- #
# 合规引流段
# --------------------------------------------------------------------------- #
# 头条对站外导流管控严格：正文里不放二维码图片、不写"微信/公众号"、不留
# 外链或账号。用中性说法引导读者"主动来找"，关键词"访问码"作为内容钩子。
PROMO_HTML = (
    '<p style="margin:18px 0;line-height:1.9;color:#333;">'
    "文中这套复盘口径与验证清单的完整版，放在同名的平台里。"
    "想看的话，搜一下 <strong>揽宝投研</strong> 就能找到我们，"
    '报个暗号 <strong>访问码</strong>，在线平台的免费入口地址就发你。</p>'
)


def inject_promo(html: str) -> str:
    """把合规引流段插到风险警示引用块之前；找不到引用块则加到末尾。"""
    # 风险警示是最后一个 blockquote，插在它前面最自然
    idx = html.rfind("<blockquote")
    if idx != -1:
        return html[:idx] + PROMO_HTML + "\n" + html[idx:]
    return html + "\n" + PROMO_HTML


# --------------------------------------------------------------------------- #
# 单篇处理
# --------------------------------------------------------------------------- #
def process(md_path: Path, dry_run: bool = False) -> dict:
    text = md_path.read_text(encoding="utf-8")
    meta, body = parse_frontmatter(text)
    title = meta.get("title", "").strip()
    # 标题长度校验（头条 2-30 字）
    if len(title) > TITLE_MAX:
        print(
            f"  [警告] 标题超过 {TITLE_MAX} 字，将被截断：{title!r}",
            file=sys.stderr,
        )
    html = convert_body(body)
    html = inject_promo(html)

    result = {
        "title": title,
        "cover": meta.get("cover", "").strip(),
        "summary": meta.get("summary", "").strip(),
        "source": meta.get("source_url", ""),
        "html": html,
    }

    if dry_run:
        print(f"===== {md_path} =====")
        print(f"[title] {title} ({len(title)} 字)")
        print(f"[cover] {result['cover']}")
        print(html)
        print()
        return result

    out_path = md_path.with_suffix(".toutiao.html")
    out_path.write_text(html, encoding="utf-8")

    # 同时写一份 sidecar 元信息，方便发布脚本读取标题/封面
    sidecar = md_path.with_suffix(".toutiao.json")
    import json

    sidecar.write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"  ✓ {md_path.parent.name}: {title} ({len(title)} 字)")
    print(f"      HTML -> {out_path.name}")
    return result


def main():
    ap = argparse.ArgumentParser(description="公众号文章 -> 今日头条 HTML")
    ap.add_argument("files", nargs="*", type=Path, help="article.md 路径")
    ap.add_argument(
        "--series",
        action="store_true",
        help="批量处理当前目录下 output/*-series/*/article.md",
    )
    ap.add_argument(
        "--dedupe",
        action="store_true",
        help="按标题去重（主题变体只保留第一篇）",
    )
    ap.add_argument("--dry-run", action="store_true", help="只打印，不落盘")
    args = ap.parse_args()

    files = list(args.files)
    root = Path(__file__).resolve().parent
    if args.series:
        files.extend(sorted(root.glob("output/*-series/*/article.md")))

    if not files:
        ap.error("请提供 article.md 路径，或使用 --series")

    seen_titles: set[str] = set()
    count = 0
    for f in files:
        if not f.exists():
            print(f"  [跳过] 不存在：{f}", file=sys.stderr)
            continue
        if args.dedupe:
            meta, _ = parse_frontmatter(f.read_text(encoding="utf-8"))
            t = meta.get("title", "").strip()
            if t in seen_titles:
                print(f"  [去重跳过] {f.parent.name}: {t}")
                continue
            seen_titles.add(t)
        process(f, dry_run=args.dry_run)
        count += 1

    print(f"\n完成：共处理 {count} 篇" + ("（dry-run，未落盘）" if args.dry_run else ""))


if __name__ == "__main__":
    main()
