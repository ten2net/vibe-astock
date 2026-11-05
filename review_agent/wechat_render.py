"""把复盘渲染成微信公众号兼容的极简 HTML。

与博客版式完全分开：微信文章在手机上读、且会剥掉外部样式表和 class，
所以这里不用博客的 va-* 版式，而是移动优先的内联 style 排版——
每个区块几段 <section>/<p>，样式全部写在 style 属性里（微信白名单内）。

数字全部来自本机已核对的复盘产物（与 blog_publish 同源），这里不新增判断。
"""
from __future__ import annotations

import html
import re

from .blog_publish import (
    DISCLAIMER,
    _hhmmss,
    _sign,
    split_body,
    strip_citations,
    summary_cards,
    post_title,
)

# ---- 内联样式片段（微信白名单：字体/颜色/背景/边框/间距/对齐） ----
S_LEAD = "padding:14px 16px;background:#10151d;border-radius:8px;"
S_LEAD_TITLE = "margin:0 0 8px;font-size:17px;font-weight:bold;color:#f0d78c;"
S_LEAD_SUB = "margin:0;font-size:13px;color:#9aa4b2;line-height:1.6;"
S_H = ("margin:22px 0 10px;padding-left:10px;font-size:16px;font-weight:bold;color:#1d2129;"
       "border-left:4px solid #c9a227;line-height:1.4;")
S_P = "margin:0 0 12px;font-size:15px;color:#1d2129;line-height:1.75;"
S_MUTED = "margin:0 0 12px;font-size:13px;color:#86909c;line-height:1.7;"
S_CARD = "margin:0 0 8px;padding:10px 14px;background:#f7f8fa;border-radius:8px;"
S_CARD_K = "margin:0;font-size:12px;color:#86909c;"
S_CARD_V = "margin:4px 0;font-size:19px;font-weight:bold;color:#1d2129;"
S_CARD_S = "margin:0;font-size:12px;color:#86909c;"
S_LINE = "margin:0 0 6px;font-size:14px;color:#1d2129;line-height:1.7;"
S_GAP = "margin:0 0 12px;font-size:13px;color:#b0b8c4;"
S_RULE = ("margin:26px 0 10px;border:none;border-top:1px dashed #e5e6eb;")


def _esc(text) -> str:
    return html.escape(str(text or ""))


def _p(text: str, style: str = S_P) -> str:
    return f'<p style="{style}">{_esc(text)}</p>'


def _heading(title: str) -> str:
    return f'<p style="{S_H}">{_esc(title)}</p>'


def _rule() -> str:
    return f'<hr style="{S_RULE}" />'


def _cards(payload: dict) -> list[str]:
    """读数卡：博客同款四张，纯内联排版。"""
    return [f'<section style="{S_CARD}">'
            f'<p style="{S_CARD_K}">{_esc(k)}</p>'
            f'<p style="{S_CARD_V}">{_esc(v)}</p>'
            f'<p style="{S_CARD_S}">{_esc(s)}</p>'
            f"</section>"
            for k, v, s in summary_cards(payload)]


def _liaban_lines(payload: dict, limit: int = 15) -> list[str]:
    """连板股 → 每行一只：名称 代码 · N板 · 首封 · 题材。"""
    nodes = ((payload.get("market_facts") or {}).get("theme_tree") or {}).get("themes") or []
    members: dict[str, dict] = {}
    for n in nodes:
        tag = str(n.get("tag") or "")
        for m in n.get("members") or []:
            if isinstance(m, dict) and m.get("code") and m["code"] not in members:
                members[m["code"]] = {**m, "tag": tag}
    picks = [m for m in members.values() if (m.get("boards") or 0) >= 2]
    if not picks:
        picks = list(members.values())[:20]
    picks.sort(key=lambda m: (-(m.get("boards") or 0), str(m.get("first_seal") or "")))
    if not picks:
        return []
    lines = []
    for m in picks[:limit]:
        bits = [f'{m.get("name", "")} {m.get("code", "")}'.strip(),
                f'{m.get("boards", 0)} 板',
                f'首封 {_hhmmss(m.get("first_seal"))}',
                str(m.get("tag") or "")]
        lines.append(" · ".join(b for b in bits if b and b != " · "))
    return lines


def _theme_lines(payload: dict, limit: int = 10) -> list[str]:
    """题材结构 → 每行一个行业：行业 · 涨停 N · 最高 N 板 · 炸板率。"""
    themes = ((payload.get("market_facts") or {}).get("theme_structure") or {}).get("themes") or []
    lines = []
    for t in themes[:limit]:
        bits = [str(t.get("sector") or ""),
                f'涨停 {t.get("limit_up", 0)} 只',
                f'最高 {t.get("highest", 0)} 板']
        if t.get("broken"):
            bits.append(f'炸板 {t.get("broken")}')
        lines.append(" · ".join(bits))
    return lines


def _event_lines(payload: dict, limit: int = 10) -> list[str]:
    """当日事件串 → 每行一条：名称 · 事件 · 说明。"""
    events = ((payload.get("market_facts") or {}).get("event_ledger") or {}).get("events") or []
    lines = []
    for e in events[:limit]:
        ret = e.get("ret")
        ret_txt = f' ({_sign(ret)}%)' if isinstance(ret, (int, float)) else ""
        bits = [str(e.get("name") or ""),
                f'[{e.get("tag")}]' if e.get("tag") else "",
                (str(e.get("note") or "") + ret_txt).strip()]
        lines.append(" ".join(b for b in bits if b).strip())
    return lines


def _blocks_to_html(md_text: str) -> list[str]:
    """_text_to_md 风格的块 → 微信段落/小标题。与博客 _md_blocks 同规则。"""
    from .blog_publish import _text_to_md  # 复用博客的块切分约定
    md = _text_to_md(md_text)
    out: list[str] = []
    for block in [b.strip() for b in md.split("\n\n") if b.strip()]:
        m = re.match(r"^(#{1,6})\s*(.+)$", block)
        if m:
            out.append(f'<p style="{S_H}">{_esc(m.group(2))}</p>')
            continue
        if block.startswith(">"):
            text = " ".join(ln.lstrip("> ").strip() for ln in block.splitlines())
            out.append(f'<p style="{S_MUTED}">{_esc(text)}</p>')
            continue
        if block.startswith("```"):
            body = "\n".join(block.splitlines()[1:])
            body = re.sub(r"```\s*$", "", body).strip()
            for ln in body.splitlines():
                if ln.strip():
                    out.append(f'<p style="margin:0;font-size:12px;color:#4e5969;font-family:monospace;">{_esc(ln)}</p>')
            continue
        # 行内 **加粗** 转成 <strong>（微信保留 strong）
        text = _esc(block)
        text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
        out.append(f'<p style="{S_P}">{text}</p>')
    return out


def article_html(payload: dict, date: str, blog_url: str) -> str:
    """一篇公众号文章正文（HTML）。标题另由调用方传给草稿接口。"""
    focus = payload.get("focus") or {}
    one = str(focus.get("market_oneliner") or "")
    focus_body, _evidence = split_body(str(payload.get("focus_md") or ""))
    analysts = [a for a in payload.get("analysts") or [] if isinstance(a, dict)]
    macro = strip_citations(str(payload.get("macro_sector") or ""))

    out: list[str] = []
    # 头：日期 + 情绪档位 + 一句话
    out.append(f'<section style="{S_LEAD}">'
               f'<p style="{S_LEAD_TITLE}">{_esc(post_title(payload, date))}</p>'
               + (f'<p style="{S_LEAD_SUB}">{_esc(one)}</p>' if one else "")
               + "</section>")
    # 四张读数卡
    out.extend(_cards(payload))
    # 关键名单（表格的卡片化替代）
    liaban = _liaban_lines(payload)
    if liaban:
        out.append(_heading("连板股名单"))
        out.extend(f'<p style="{S_LINE}">{_esc(ln)}</p>' for ln in liaban)
    themes = _theme_lines(payload)
    if themes:
        out.append(_heading("题材结构"))
        out.extend(f'<p style="{S_LINE}">{_esc(ln)}</p>' for ln in themes)
    events = _event_lines(payload)
    if events:
        out.append(_heading("当日事件串"))
        out.extend(f'<p style="{S_LINE}">{_esc(ln)}</p>' for ln in events)
    # 汇总研判（程序核对过的正文）
    out.append(_rule())
    out.append(_heading("汇总研判"))
    out.extend(_blocks_to_html(strip_citations(focus_body)) or [_p("该日没有汇总研判正文。")])
    # 分项观察
    for a in analysts:
        out.append(_heading(str(a.get("title") or "")))
        text = re.sub(r"</p>\s*<p[^>]*>", "\n\n", str(a.get("html") or ""))
        text = html.unescape(re.sub(r"<[^>]+>", "", text))
        out.extend(_blocks_to_html(text) or [_p("（本段无正文）")])
    # 板块与宏观
    if macro.strip():
        out.append(_heading("板块与宏观"))
        out.extend(_blocks_to_html(macro))
    # 尾：免责 + 导流（微信正文不放外链，写 URL 纯文本）
    out.append(_rule())
    out.append(_p(DISCLAIMER, S_MUTED))
    if blog_url:
        out.append(_p(f"完整图表版复盘：{blog_url}", S_MUTED))
    out.append(_p("本页所有数字由揽宝投研计算，文章由它生成后自动发布。", S_GAP))
    return "\n".join(out)
