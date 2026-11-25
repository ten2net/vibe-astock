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
    stance_title,
    _PHASE_STANCE,
    _DEFAULT_STANCE,
    _split_sentences,
    RISK_TAG_HTML,
    _is_risk_sentence,
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
S_P = "margin:0 0 12px;font-size:15px;color:#1d2129;line-height:1.75;text-align:left;"
S_MUTED = "margin:0 0 12px;font-size:13px;color:#86909c;line-height:1.7;"
S_CARD = "margin:0 0 8px;padding:10px 14px;background:#f7f8fa;border-radius:8px;"
S_CARD_K = "margin:0;font-size:12px;color:#86909c;"
S_CARD_V = "margin:4px 0;font-size:19px;font-weight:bold;color:#1d2129;"
S_CARD_S = "margin:0;font-size:12px;color:#86909c;"
S_LINE = "margin:0 0 6px;font-size:14px;color:#1d2129;line-height:1.7;text-align:left;"
S_GAP = "margin:0 0 12px;font-size:13px;color:#b0b8c4;"
S_RULE = ("margin:26px 0 10px;border:none;border-top:1px dashed #e5e6eb;")
# 结尾「阅读原文」醒目引导块：浅橙底 + 左侧橙色粗边，微信白名单内的内联样式
S_CTA = ("margin:18px 0 14px;padding:16px 16px 14px;background:#fff8e6;"
         "border-left:5px solid #f08c00;border-radius:6px;")
S_CTA_TITLE = ("margin:0 0 10px;font-size:16px;font-weight:bold;color:#c96a00;line-height:1.5;")
S_CTA_P = ("margin:0 0 8px;font-size:14px;color:#5c4300;line-height:1.75;")
S_CTA_URL = ("margin:8px 0 0;font-size:12px;color:#a07a2c;line-height:1.6;word-break:break-all;")
# SEO 导语段：核心词 + 结论 + 通俗读数，首段前 300 字回应搜索意图、降低跳出率
S_SEO_LEAD = ("margin:0 0 14px;font-size:15px;color:#1d2129;line-height:1.8;")
S_TAGS = ("margin:14px 0 4px;font-size:13px;color:#1a73e8;line-height:1.7;")
S_ASK = ("margin:16px 0 8px;padding:12px 14px;background:#f1f6ff;"
         "border-left:4px solid #1a73e8;border-radius:6px;"
         "font-size:14px;color:#1d2129;line-height:1.75;font-weight:bold;")
# Seaway 式「先说结论 / 观察清单」表格样式（微信白名单内联）
S_TABLE = ("margin:12px 0 16px;width:100%;border-collapse:collapse;font-size:13px;"
           "color:#1d2129;line-height:1.6;")
S_TH = ("padding:8px 6px;text-align:left;font-weight:bold;color:#c96a00;"
        "background:#fff8e6;border-bottom:2px solid #f08c00;")
S_TD = "padding:8px 6px;border-bottom:1px solid #eef0f3;vertical-align:top;"
S_TD_B = "padding:8px 6px;border-bottom:1px solid #eef0f3;font-weight:bold;vertical-align:top;"
S_CHART_CARD = ("margin:12px 0;padding:12px 14px;background:#f7f8fa;border-radius:8px;")
S_CHART_T = "margin:0 0 4px;font-size:14px;font-weight:bold;color:#1d2129;"
S_CHART_N = "margin:0 0 10px;font-size:12px;color:#86909c;"
S_BAR_ROW = "display:flex;align-items:center;margin:0 0 5px;font-size:12px;color:#4e5969;"
S_BAR_LB = "display:inline-block;width:72px;flex-shrink:0;color:#4e5969;"
S_BAR_TR = ("display:inline-block;flex:1;height:10px;background:#eef0f3;"
            "border-radius:5px;overflow:hidden;margin:0 8px;")
S_BAR_FL = "display:block;height:100%;border-radius:5px;"


def _esc(text) -> str:
    return html.escape(str(text or ""))


# ---- SEO：中文日期 / 核心词标题 / 看点钩子 ----
def cn_date(date: str) -> str:
    """2026-11-18 → 11月18日：符合搜索话术（用户搜「11月18日复盘」而非 ISO 日期）。"""
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", str(date or ""))
    if not m:
        return str(date or "")
    return f"{int(m.group(2))}月{int(m.group(3))}日"


def seo_title(payload: dict, date: str) -> str:
    """微信公众号标题：中文日期 + 市况 + 明确态度 + 观察动作（Seaway 式改写）。

    - 20 字左右、无震惊体，核心词（日期 / 个股普跌 / A股复盘）仍在标题里；
    - 态度与动作由当日档位驱动，读者一眼看到观点和纪律；
    - 措辞为观察纪律而非交易指令，符合产品政策。
    博客标题走 blog_publish.post_title（同样改用 stance_title），两处保持一致。
    """
    return stance_title(payload, date)


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


def _localize_metrics(text: str) -> str:
    """把正文里写死的英文指标 key 换成中文名（渲染层兜底）。

    历史 focus_md 由早期 grounding 生成，里面是 ``money_effect_median``
    这类英文 key；这里统一替换成 METRICS 里的中文 label，避免读者看到英文。
    按 key 长度倒序替换，防止短 key 先命中干扰长 key。
    """
    try:
        from duanxian.verification import METRICS
        mapping = {m.key: m.label for m in METRICS}
    except Exception:  # noqa: BLE001  指标映射是增强项，失败不影响发布
        return text
    for key in sorted(mapping, key=len, reverse=True):
        if key in text:
            text = text.replace(key, mapping[key])
    return text


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
            for s in _split_sentences(text):
                out.append(f'<p style="{S_MUTED}">{_esc(s)}</p>')
            continue
        if block.startswith("```"):
            body = "\n".join(block.splitlines()[1:])
            body = re.sub(r"```\s*$", "", body).strip()
            for ln in body.splitlines():
                if ln.strip():
                    out.append(f'<p style="margin:0;font-size:12px;color:#4e5969;font-family:monospace;">{_esc(ln)}</p>')
            continue
        # 行内 **加粗** 转成 <strong>（微信保留 strong）；按句号拆成短段
        for s in _split_sentences(block):
            text = _esc(s)
            text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
            out.append(f'<p style="{S_P}">{text}</p>')
    return out


def _seo_lead(payload: dict, date: str) -> str:
    """SEO 导语段：核心词 + 一句话结论 + 大白话读数 + 证据链信任提示。

    范文要求核心词在「标题 + 首段」各出现一次，前 300 字回应搜索意图、
    直接给结论并把术语翻成大白话，降低跳出率、提升完读率。
    """
    focus = payload.get("focus") or {}
    phase = str(focus.get("emotion_phase") or "").strip()
    one = str(focus.get("market_oneliner") or "").strip()
    breadth = (payload.get("market_facts") or {}).get("breadth") or {}
    em = payload.get("emotion_metrics") or {}
    money = em.get("money_effect") or {}

    day = cn_date(date)
    bits = [f"{day}A股复盘，"]
    # 结论：优先用一句话；没有就按档位给一个中性结论
    if one:
        conclusion = one.rstrip("。；; ")
        bits.append(f"一句话结论：**{conclusion}**。")
    elif phase:
        bits.append(f"一句话结论：**市场情绪档位为{phase}**。")
    else:
        bits.append("一句话结论：**当日情绪以分化为主**。")

    # 大白话读数（关键数字加粗）：点出上涨占比、昨日涨停今日表现、翻红率
    plain: list[str] = []
    up, down = breadth.get("up"), breadth.get("down")
    if isinstance(up, int) and isinstance(down, int) and up + down > 0:
        ratio = _pct(up / (up + down))
        plain.append(f"全市场上涨 **{up}** 只、下跌 **{down}** 只，上涨占比 **{ratio}**")
    if money.get("available"):
        avg = money.get("avg")
        plain.append(f"昨日涨停股今日平均 **{_num(avg, 2, '%')}**、中位数 **{_sign(money.get('median'), 2, '%')}**")
        plain.append(f"翻红率 **{_pct(money.get('positive_rate'))}**")
    if plain:
        bits.append("，".join(plain) + "。")
    bits.append(DISCLAIMER)

    text = "".join(bits)
    text = _esc(text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    # 按中文句号拆成短段（与正文同规则），风险提示句加醒目前缀
    return "\n".join(
        f'<p style="{S_SEO_LEAD}">{RISK_TAG_HTML if _is_risk_sentence(s) else ""}{s}</p>'
        for s in _split_sentences(text))


def _conclusion_table(payload: dict, date: str) -> str:
    """Seaway 式「先说结论」表：问题 / 答案 / 依据，全部由当日读数驱动。

    参考 Seaway《高开低走之后：等坑分批，别接飞刀》第一节：把全文判断压成一张
    可扫读的表格，读者一眼知道\"现在怎么看、该盯什么\"。答案为观察判断，不是
    买卖建议；依据列引用数据底座的真实读数。
    """
    focus = payload.get("focus") or {}
    phase = str(focus.get("emotion_phase") or "").strip()
    stance, action = _PHASE_STANCE.get(phase, _DEFAULT_STANCE)
    breadth = (payload.get("market_facts") or {}).get("breadth") or {}
    up, down = breadth.get("up"), breadth.get("down")
    ratio = _pct(up / (up + down)) if isinstance(up, int) and isinstance(down, int) and up + down > 0 else "—"
    em = payload.get("emotion_metrics") or {}
    money = em.get("money_effect") or {}
    promo = (em.get("promotion") or {}).get("overall") or {}

    rows: list[tuple[str, str, str]] = []
    rows.append(("今天怎么看", stance, f"情绪档位「{phase or '—'}」，上涨占比 {ratio}"))
    if money.get("available"):
        rows.append(("昨日强势股反馈",
                     "正反馈" if (money.get("median") or 0) >= 0 else "转弱",
                     f"昨日涨停样本今日中位 {_sign(money.get('median'), 2, '%')}，翻红率 {_pct(money.get('positive_rate'))}"))
    rows.append(("接力强不强",
                 "偏弱" if (promo.get("rate") or 0) < 0.3 else "尚可",
                 f"整体晋级率 {_pct(promo.get('rate'))}（{promo.get('promoted', '—')}/{promo.get('base', '—')}）"))
    rows.append(("接下来怎么办", action, "下面是可对照的验证条件，出现才谈延续，未出现就是反证"))
    body = "".join(
        "<tr>" + f'<td style="{S_TD_B}">{_esc(q)}</td>'
        + f'<td style="{S_TD}">{_esc(a)}</td>'
        + f'<td style="{S_TD}">{_esc(b)}</td></tr>'
        for q, a, b in rows)
    return (f'<p style="{S_H}">先说结论：今天怎么看、该盯什么</p>'
            + f'<table style="{S_TABLE}"><thead><tr>'
            + f'<th style="{S_TH}">问题</th><th style="{S_TH}">答案</th><th style="{S_TH}">依据</th>'
            + "</tr></thead><tbody>" + body + "</tbody></table>")


def _stance_checklist(payload: dict) -> str:
    """Seaway 式「操作清单」表：把验证条件做成可逐日对照的条件/动作表。

    动作用「看… / 等… / 若…则反证」的观察纪律措辞，不构成买卖建议。
    """
    items = (payload.get("focus") or {}).get("verification_items") or []
    valid = [it for it in items if isinstance(it, dict) and it.get("metric")]
    if not valid:
        return ""
    from duanxian.verification import METRICS
    name_map = {m.key: m.label for m in METRICS}
    rows = []
    for it in valid:
        label = name_map.get(str(it.get("metric")), str(it.get("metric")))
        direction = str(it.get("direction") or "").strip()
        reason = str(it.get("reason") or "").strip()
        rows.append((label, direction, reason))
    body = "".join(
        "<tr>" + f'<td style="{S_TD_B}">{_esc(a)}</td>'
        + f'<td style="{S_TD}">{_esc(b)}</td>'
        + f'<td style="{S_TD}">{_esc(c)}</td></tr>'
        for a, b, c in rows)
    return (f'<p style="{S_H}">观察清单：四个条件，逐日对照</p>'
            + f'<table style="{S_TABLE}"><thead><tr>'
            + f'<th style="{S_TH}">盯什么</th><th style="{S_TH}">看什么变化</th><th style="{S_TH}">说明</th>'
            + "</tr></thead><tbody>" + body + "</tbody></table>"
            + f'<p style="{S_MUTED}">这是验证条件，不是涨跌预测，也不构成操作建议。</p>')


def _seaway_chart(payload: dict) -> str:
    """用数据底座的真实读数画微信兼容的内联条形图（插图）。

    Seaway 文章配了大量数据图；这里以纯内联 HTML/CSS 的条形图替代外部图片，
    微信不会剥掉 style，本地预览与公众号里都能显示。三组图：
    1) 涨跌家数对比；2) 昨日涨停样本今日表现；3) 晋级率。
    数字全部来自复盘产物，不新增判断。
    """
    em = payload.get("emotion_metrics") or {}
    breadth = (payload.get("market_facts") or {}).get("breadth") or {}
    money = em.get("money_effect") or {}
    promo = (em.get("promotion") or {}).get("overall") or {}

    def bar(label: str, value: float, text: str, scale: float, positive: bool) -> str:
        try:
            pct = max(0.0, min(100.0, abs(float(value)) / scale * 100))
        except (TypeError, ValueError):
            pct = 0.0
        color = C_UP if positive else C_DOWN
        return (f'<span style="{S_BAR_ROW}"><span style="{S_BAR_LB}">{_esc(label)}</span>'
                f'<span style="{S_BAR_TR}"><i style="{S_BAR_FL}background:{color};width:{pct:.0f}%"></i></span>'
                f'<b style="min-width:64px;text-align:right;">{_esc(text)}</b></span>')

    charts: list[str] = []
    up, down = breadth.get("up"), breadth.get("down")
    if isinstance(up, int) and isinstance(down, int) and up + down > 0:
        scale = max(up, down) or 1
        charts.append(f'<section style="{S_CHART_CARD}"><p style="{S_CHART_T}">涨跌家数（沪深两市）</p>'
                      f'<p style="{S_CHART_N}">红=上涨、绿=下跌，柱长为家数</p>'
                      + bar("上涨", up, f"{up} 只", scale, True)
                      + bar("下跌", down, f"{down} 只", scale, False)
                      + "</section>")
    if money.get("available"):
        med = money.get("median") or 0
        pos = money.get("positive_rate") or 0
        charts.append(f'<section style="{S_CHART_CARD}"><p style="{S_CHART_T}">昨日涨停股今天怎么样</p>'
                      f'<p style="{S_CHART_N}">中位数与翻红率，来自揽宝投研当日复盘</p>'
                      + bar("中位表现", abs(med), _sign(med, 2, "%"), 10.0, med >= 0)
                      + bar("翻红率", pos, _pct(pos), 1.0, True)
                      + "</section>")
    rate = promo.get("rate")
    if isinstance(rate, (int, float)):
        charts.append(f'<section style="{S_CHART_CARD}"><p style="{S_CHART_T}">晋级率：接力强不强</p>'
                      f'<p style="{S_CHART_N}">昨日涨停 {promo.get("base", "—")} 只 → 今日再涨停 {promo.get("promoted", "—")} 只</p>'
                      + bar("整体晋级", rate, _pct(rate), 1.0, rate >= 0.3)
                      + "</section>")
    if not charts:
        return ""
    return "".join(charts)


def _verification(payload: dict) -> str:
    """「明日验证条件」清单：范文要求的可收藏、可证伪信号列表。"""
    items = (payload.get("focus") or {}).get("verification_items") or []
    valid = [it for it in items if isinstance(it, dict) and it.get("metric")]
    if not valid:
        return ""
    from duanxian.verification import METRICS
    name_map = {m.key: m.label for m in METRICS}
    out = [f'<p style="{S_H}">明日验证条件：三个信号看情绪能否修复</p>']
    for it in valid:
        metric = str(it.get("metric"))
        label = name_map.get(metric, metric)
        direction = str(it.get("direction") or "").strip()
        reason = str(it.get("reason") or "").strip()
        line = f"<strong>{_esc(label)}</strong>"  # 只显示中文名，不暴露英文 key
        if direction:
            line += f"：看{_esc(direction)}"
        if reason:
            line += f" —— {_esc(reason)}"
        out.append(f'<p style="{S_LINE}">· {line}</p>')
    out.append(f'<p style="{S_MUTED}">以上为验证条件，不是涨跌预测。</p>')
    return "\n".join(out)


def _seo_analyst_title(title: str) -> str:
    """分析师栏目标题补长尾词语义，保留原名不丢信息。"""
    mapping = {
        "情绪面": "情绪面：市场情绪与赚钱效应",
        "资金面": "资金面：资金流向与净额",
        "题材热点": "题材热点：连板梯队与题材结构",
        "龙虎榜游资": "龙虎榜游资：席位净买额样本",
        "龙头跟踪": "龙头跟踪：高标与晋级表现",
    }
    return mapping.get(title, title)


def _dynamic_tags(payload: dict) -> list[str]:
    """按当日盘面生成 2 个动态话题，与固定基础标签组合成 5 个精准话题。

    固定 3 个锚定账号领域（A股复盘/每日复盘/情绪档位），动态 2 个让系统
    拿到更细的当日内容信号：一个来自情绪档位，一个来自盘面特征
    （晋级率 / 连板高度 / 主线题材），便于推荐给对应细分兴趣的读者。
    """
    focus = payload.get("focus") or {}
    em = payload.get("emotion_metrics") or {}
    phase = str(focus.get("emotion_phase") or "").strip()

    phase_tag = f"情绪{phase}" if phase else "市场分化"

    # 盘面特征优先级：晋级率高 > 连板高度高 > 主线题材 > 资金流向
    feature_tag = "资金流向"  # 兜底
    promo = (em.get("promotion") or {}).get("overall") or {}
    rate = promo.get("rate")
    highest = (em.get("ladder_gap") or {}).get("highest")
    if isinstance(rate, (int, float)) and rate >= 0.30:
        feature_tag = "晋级率"
    elif isinstance(highest, (int, float)) and highest >= 5:
        feature_tag = "连板梯队"
    else:
        themes = (((payload.get("market_facts") or {}).get("theme_structure") or {}).get("themes") or [])
        sector = str(themes[0].get("sector") or "").strip() if themes and isinstance(themes[0], dict) else ""
        if sector:
            feature_tag = sector

    base = ["A股复盘", "每日复盘", "情绪档位"]
    # 去重且保序，最多 5 个
    picked: list[str] = []
    for t in base + [phase_tag, feature_tag]:
        if t and t not in picked:
            picked.append(t)
        if len(picked) == 5:
            break
    return picked


def _interaction_and_tags(payload: dict) -> str:
    """互动提问 + 话题标签：评论钩子 + 固定领域标签 + 当日动态标签。"""
    ask = ('<p style="' + S_ASK + '">你复盘时最关注哪个信号——是涨停家数、晋级率，'
           '还是资金净额？评论区聊聊你的判断依据。</p>')
    tags = " ".join(f"#{t}" for t in _dynamic_tags(payload))
    return ask + "\n" + ('<p style="' + S_TAGS + '">' + tags + '</p>')


def article_html(payload: dict, date: str, blog_url: str) -> str:
    """一篇公众号文章正文（HTML）。标题另由调用方传给草稿接口。"""
    focus = payload.get("focus") or {}
    one = str(focus.get("market_oneliner") or "")
    focus_body, _evidence = split_body(str(payload.get("focus_md") or ""))
    analysts = [a for a in payload.get("analysts") or [] if isinstance(a, dict)]
    macro = strip_citations(str(payload.get("macro_sector") or ""))

    out: list[str] = []
    # 头：SEO 标题（日期中文 + A股复盘核心词 + 问句钩子）+ 一句话副标
    out.append(f'<section style="{S_LEAD}">'
               f'<p style="{S_LEAD_TITLE}">{_esc(seo_title(payload, date))}</p>'
               + (f'<p style="{S_LEAD_SUB}">{_esc(one)}</p>' if one else "")
               + "</section>")
    # SEO 导语段：核心词 + 结论 + 大白话读数 + 证据链提示（前 300 字回应搜索意图）
    out.append(_seo_lead(payload, date))
    # Seaway 式「先说结论」表：把当天判断压成可扫读的一张表
    out.append(_conclusion_table(payload, date))
    # 四张读数卡（情绪档位 / 涨跌家数 / 赚钱效应 / 晋级率）
    out.extend(_cards(payload))
    # 插图：由数据底座真实读数驱动的内联条形图（微信兼容）
    out.append(_seaway_chart(payload))
    # 关键名单（表格的卡片化替代）——小标题带长尾搜索词
    liaban = _liaban_lines(payload)
    if liaban:
        out.append(_heading("连板梯队与晋级率：最高板位怎么看？"))
        out.extend(f'<p style="{S_LINE}">{_esc(ln)}</p>' for ln in liaban)
    themes = _theme_lines(payload)
    if themes:
        out.append(_heading("题材结构：哪些方向在异动？"))
        out.extend(f'<p style="{S_LINE}">{_esc(ln)}</p>' for ln in themes)
    events = _event_lines(payload)
    if events:
        out.append(_heading("当日事件串：涨停与断板读数"))
        out.extend(f'<p style="{S_LINE}">{ln}</p>' for ln in events)  # ln 已转义、可含着色 span
    # 汇总研判（程序核对过的正文）——小标题带长尾词
    out.append(_rule())
    out.append(_heading("情绪档位：为什么这样定档？"))
    out.extend(_blocks_to_html(_localize_metrics(strip_citations(focus_body))) or [_p("该日没有汇总研判正文。")])
    # 观察清单（Seaway 式条件/动作表）+ 原有逐条验证条件说明
    checklist = _stance_checklist(payload)
    if checklist:
        out.append(_rule())
        out.append(checklist)
    verification = _verification(payload)
    if verification:
        out.append(verification)
    # 分项观察：把分析师标题也补上长尾词语义（保留原标题，避免丢失信息）
    for a in analysts:
        title = str(a.get("title") or "")
        out.append(_heading(_seo_analyst_title(title)))
        text = re.sub(r"</p>\s*<p[^>]*>", "\n\n", str(a.get("html") or ""))
        text = html.unescape(re.sub(r"<[^>]+>", "", text))
        out.extend(_blocks_to_html(text) or [_p("（本段无正文）")])
    # 板块与宏观（资金流向语义）
    if macro.strip():
        out.append(_heading("板块与宏观：资金流向与大赛道跟踪"))
        out.extend(_blocks_to_html(macro))
    # 尾：互动提问 + 话题标签 → 免责 + 醒目「阅读原文」导流
    out.append(_rule())
    out.append(_interaction_and_tags(payload))
    for s in _split_sentences(DISCLAIMER):
        out.append(f'<p style="{S_MUTED}">'
                   f'{RISK_TAG_HTML if _is_risk_sentence(s) else ""}{_esc(s)}</p>')
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
