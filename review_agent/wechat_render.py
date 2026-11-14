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
    _num,
    _pct,
    _sign,
    split_body,
    strip_citations,
    _float,
    post_title,
)

# 涨红跌绿（A 股习惯）：正/涨=红，负/跌=绿，零或缺失保持深色不着色。
C_UP = "#e03131"
C_DOWN = "#0ca678"

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
# 结尾「阅读原文」醒目引导块：浅橙底 + 左侧橙色粗边，微信白名单内的内联样式
S_CTA = ("margin:18px 0 14px;padding:16px 16px 14px;background:#fff8e6;"
         "border-left:5px solid #f08c00;border-radius:6px;")
S_CTA_TITLE = ("margin:0 0 10px;font-size:16px;font-weight:bold;color:#c96a00;line-height:1.5;")
S_CTA_P = ("margin:0 0 8px;font-size:14px;color:#5c4300;line-height:1.75;")
S_CTA_URL = ("margin:8px 0 0;font-size:12px;color:#a07a2c;line-height:1.6;word-break:break-all;")


def _esc(text) -> str:
    return html.escape(str(text or ""))


def _tone(value) -> str:
    """按数值正负返回涨红/跌绿；零、缺失、非数不着色（空串）。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return ""
    return C_UP if value > 0 else (C_DOWN if value < 0 else "")


def _colored(text: str, value) -> str:
    """给一段已转义的读数按涨跌上色：正红、负绿，否则原样。微信保留 span 的内联 color。"""
    color = _tone(value)
    return f'<span style="color:{color};">{text}</span>' if color else text


def _p(text: str, style: str = S_P) -> str:
    return f'<p style="{style}">{_esc(text)}</p>'


def _heading(title: str) -> str:
    return f'<p style="{S_H}">{_esc(title)}</p>'


def _rule() -> str:
    return f'<hr style="{S_RULE}" />'


def _card(k: str, v_html: str, s: str) -> str:
    """一张读数卡。v_html 已转义（可含着色 span），k/s 走纯文本转义。"""
    return (f'<section style="{S_CARD}">'
            f'<p style="{S_CARD_K}">{_esc(k)}</p>'
            f'<p style="{S_CARD_V}">{v_html}</p>'
            f'<p style="{S_CARD_S}">{_esc(s)}</p>'
            f"</section>")


def _cards(payload: dict) -> list[str]:
    """读数卡：口径与博客 summary_cards 一致，但涨跌类数值按涨红跌绿上色。

    微信剥 class，所以用内联 span color；只给真正表示涨跌/盈亏的数值上色，
    晋级率、上涨占比这类「比率」不是涨跌，保持深色不着色。
    """
    em = payload.get("emotion_metrics") or {}
    breadth = (payload.get("market_facts") or {}).get("breadth") or {}
    money = em.get("money_effect") or {}
    promo = em.get("promotion") or {}
    overall = promo.get("overall") or {}
    ladder = em.get("ladder_gap") or {}
    phase = (payload.get("focus") or {}).get("emotion_phase") or "—"

    up, down = breadth.get("up"), breadth.get("down")
    if isinstance(up, int) and isinstance(down, int) and up + down > 0:
        # 家数是方向计数、不是涨跌幅，保持连续纯文本不着色（涨红跌绿只给幅度类百分数）
        breadth_v = f"{up} / {down}"
        breadth_s = f"上涨占比 {_pct(up / (up + down))} · 全 A {_float(breadth.get('universe'))} 只"
    else:
        breadth_v, breadth_s = "未取得", "该日涨跌分布未取到"

    # 昨日涨停今日表现：avg 是当日涨跌幅（%），正红负绿；其余是口径说明不着色
    if money.get("available"):
        money_v = _colored(_esc(_num(money.get("avg"), 2, "%")), money.get("avg"))
        money_s = (f'中位数 {_sign(money.get("median"), 2, "%")} · 翻红率 {_pct(money.get("positive_rate"))}')
    else:
        money_v, money_s = "—", "该日样本未取到"

    # 晋级率是比率，不是涨跌，不上色
    promo_v = _pct(overall.get("rate"))
    promo_s = (f'昨日 {_float(promo.get("prev_limit_up_count"))} 只 → 今日涨停 {_float(overall.get("promoted"))} 只'
               f' · 最高 {_float(ladder.get("highest"))} 板'
               if promo.get("available") else "该日晋级数据未取到")

    return [
        _card("情绪档位", _esc(phase), "分析框架，不是客观事实"),
        _card("涨跌家数", _esc(breadth_v), breadth_s),
        _card("昨日涨停今日表现", money_v, money_s),
        _card("昨日涨停今日晋级", _esc(promo_v), promo_s),
    ]


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
    """当日事件串 → 每行一条：名称 · 事件 · 说明（当日涨跌按涨红跌绿上色）。

    返回的是已转义、可含着色 span 的 HTML 片段，调用方不要再整体 _esc。
    """
    events = ((payload.get("market_facts") or {}).get("event_ledger") or {}).get("events") or []
    lines = []
    for e in events[:limit]:
        ret = e.get("ret")
        bits = [_esc(e.get("name") or ""),
                _esc(f'[{e.get("tag")}]') if e.get("tag") else "",
                _esc(str(e.get("note") or ""))]
        if isinstance(ret, (int, float)):
            bits.append(_colored(_esc(f'({_sign(ret)}%)'), ret))
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
        out.extend(f'<p style="{S_LINE}">{ln}</p>' for ln in events)  # ln 已转义、可含着色 span
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
    # 尾：免责 + 醒目的「阅读原文」导流（微信正文不放外链，靠底部「阅读原文」跳转）
    out.append(_rule())
    out.append(_p(DISCLAIMER, S_MUTED))
    out.append(_cta(blog_url))
    out.append(_p("本页所有数字由揽宝投研计算，文章由它生成后自动发布。", S_GAP))
    return "\n".join(out)


def _cta(blog_url: str) -> str:
    """引导点击公众号底部「阅读原文」：更详尽的图文版 + 交互式复盘。

    微信正文里不能放可点击外链，唯一入口是文章左下角「阅读原文」（content_source_url
    在 add_draft 里指向博客文章），所以这里用醒目卡片做文字引导，URL 只作兜底纯文本。
    """
    parts = [
        f'<section style="{S_CTA}">',
        f'<p style="{S_CTA_TITLE}">点击左下角「阅读原文」，看更详尽的复盘 →</p>',
        f'<p style="{S_CTA_P}">这里有<b>完整图文版</b>：涨跌分布、市场广度、赚钱/亏钱效应、'
        '晋级率、连板天梯、题材事件树、资金流向与两融走势，逐项展开、数字随图表对照。</p>',
        f'<p style="{S_CTA_P}">还能打开<b>交互式复盘工作台</b>：盘中竞价与情绪路径、'
        '多空辩论、个股深挖、历史回测与交易日志，条件自己点、数据自己核对。</p>',
        f'<p style="{S_CTA_P}">（若看不到入口，向下滑到文章最底部，点「阅读原文」即可。）</p>',
    ]
    if blog_url:
        # 保留纯文本 URL 兜底：部分客户端/分享场景不显示「阅读原文」入口
        parts.append(f'<p style="{S_CTA_URL}">完整图表版复盘：{_esc(blog_url)}</p>')
    parts.append("</section>")
    return "".join(parts)
