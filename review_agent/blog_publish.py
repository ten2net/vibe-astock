"""把每日复盘写进 Hugo 源（blog/），构建后同步到 GitHub Pages 仓库。

三层，任何一层都不靠模型：

1. render_post —— 纯函数。读 reviews/<日期>.json 的落盘 envelope，写一篇
   content/post/<日期>-每日复盘.md（front matter + 正文）。数字与措辞全部来自
   本机已核对过的产物，这里不新增判断。
2. check_public_text —— 公开前最后一道闸：复用不荐股规则，命中就不写这篇。
3. build_and_publish —— 跑 hugo 生成 public/，再把它同步进 Pages 仓库；
   源站原有文件（2016 年的老文章、css、图片…）一律不动。

发布出去是公开的，所以只收录确认过的字段：分项观察、汇总研判、当日读数、口径提示、
次日回看、依据附录；job_id / ai_source / 输入指纹一类的运行元数据不上网。
"""
from __future__ import annotations

import datetime
import html
import json
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .product_policy import has_trade_recommendation

PRODUCT_NAME = "揽宝投研"
SITE_TITLE = "A 股每日复盘"
BRAND_SITE = "https://phoenixtree.ai/"
# 站点自己的清单：只清理这个文件里记过的、我们自己生成的页面
MANIFEST = "astock-deploy.json"
DISCLAIMER = (
    f"{PRODUCT_NAME} 只客观呈现公开数据与榜单，不推荐个股、不预测涨跌、不构成投资建议。"
    "模型输出可能出错，请沿证据链自行核实并独立决策，风险自担。"
)

DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


class PublishError(RuntimeError):
    """可预期的失败：配置缺失、产物不合规、构建失败、远程拒绝。"""


# ---------------------------------------------------------------- 数据读取

def _has_body(payload: Any) -> bool:
    return isinstance(payload, dict) and bool(
        payload.get("focus") or str(payload.get("focus_md") or "").strip())


def load_review(reviews_dir: Path | str, date: str) -> dict:
    """读一份复盘。缺文件 / 坏 JSON / 没有正文都算不可发布，如实报错。"""
    if not DATE_RE.fullmatch(date):
        raise PublishError(f"日期格式不对：{date}")
    path = Path(reviews_dir) / f"{date}.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise PublishError(f"没有 {date} 的复盘（{path}）") from None
    except (OSError, ValueError):
        raise PublishError(f"{date} 的复盘文件读不出来：{path}") from None
    if not _has_body(payload):
        raise PublishError(f"{date} 的复盘没有正文，不发布")
    return payload


def iter_dates(reviews_dir: Path | str, limit: int = 366) -> list[str]:
    """库里有正文的复盘日期，新→旧。"""
    out = []
    for p in Path(reviews_dir).glob("*.json"):
        if not DATE_RE.fullmatch(p.stem):
            continue
        try:
            payload = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if _has_body(payload):
            out.append(p.stem)
    return sorted(out, reverse=True)[:limit]


# ---------------------------------------------------------------- 公开闸门

_CITATION = re.compile(r"\[ev-[0-9a-f]{8,}\]\s*")


def public_text(payload: dict) -> str:
    """页面会公开出现的全部文字，供政策闸门整页扫描一次。"""
    # 不扫固定免责声明：里面有「不推荐个股」，那是产品口径，不是这份报告的表述
    parts = [str(payload.get("focus_md") or ""), str(payload.get("macro_sector") or "")]
    for a in payload.get("analysts") or []:
        if isinstance(a, dict):
            parts.append(str(a.get("html") or ""))
    parts.append(json.dumps(payload.get("focus") or {}, ensure_ascii=False))
    refl = payload.get("reflection")
    if isinstance(refl, dict):
        parts.append(json.dumps(refl, ensure_ascii=False))
    return "\n".join(parts)


def check_public_text(payload: dict) -> None:
    if has_trade_recommendation(public_text(payload)):
        raise PublishError("这份复盘含交易动作或点位表述，未发布；原报告仍保留在本机")


def strip_citations(text: str) -> str:
    """正文里的 [ev-…] 是给本机核对的引用，公开页去掉（依据留在可展开的附录）。"""
    return _CITATION.sub("", text or "")


# ---------------------------------------------------------------- 读数

def _pct(v: Any, digits: int = 1) -> str:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return "—"
    return f"{v * 100:.{digits}f}%"


def _num(v: Any, digits: int = 2, suffix: str = "") -> str:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return "—"
    return f"{v:.{digits}f}{suffix}"


def _float(v: Any) -> str:
    return "—" if isinstance(v, bool) or not isinstance(v, (int, float)) else f"{v:g}"


def summary_cards(payload: dict) -> list[tuple[str, str, str]]:
    """四张客观读数卡：(标题, 值, 说明)。缺数据写「未取得」，不写 0。"""
    em = payload.get("emotion_metrics") or {}
    breadth = (payload.get("market_facts") or {}).get("breadth") or {}
    money = em.get("money_effect") or {}
    promo = em.get("promotion") or {}
    overall = promo.get("overall") or {}
    ladder = em.get("ladder_gap") or {}
    phase = (payload.get("focus") or {}).get("emotion_phase") or "—"
    up, down = breadth.get("up"), breadth.get("down")
    if isinstance(up, int) and isinstance(down, int) and up + down > 0:
        breadth_v = f"{up} / {down}"
        breadth_s = f"上涨占比 {_pct(up / (up + down))} · 全 A {_float(breadth.get('universe'))} 只"
    else:
        breadth_v, breadth_s = "未取得", "该日涨跌分布未取到"
    return [
        ("情绪档位", str(phase), "分析框架，不是客观事实"),
        ("涨跌家数", breadth_v, breadth_s),
        ("昨日涨停今日表现", _num(money.get("avg"), 2, "%"),
         f"中位数 {_num(money.get('median'), 2, '%')} · 翻红率 {_pct(money.get('positive_rate'))}"
         if money.get("available") else "该日样本未取到"),
        ("昨日涨停今日晋级", _pct(overall.get("rate")),
         f"昨日 {_float(promo.get('prev_limit_up_count'))} 只 → 今日涨停 {_float(overall.get('promoted'))} 只"
         f" · 最高 {_float(ladder.get('highest'))} 板"
         if promo.get("available") else "该日晋级数据未取到"),
    ]


# ---------------------------------------------------------------- 正文

def _text_to_md(text: str) -> str:
    """本机报告的极简 markdown → Hugo 能稳定渲染的 markdown。

    约定：每个非空行自成一段；# / ## 起头是小标题（有时粘在上一段末尾，先拆开）；
    <pre>…</pre> 是扫描到的原始片段，放进代码块。
    标题一律压到 2~3 级：页面已经有 h1，正文里的一级标题不该再抢一级；
    段落之间统一留一个空行。
    """
    blocks: list[str] = []
    for ln in (text or "").split("\n"):
        s = ln.strip()
        if not s:
            continue
        if s.lower().startswith("<pre>"):
            blocks.append(s)
            continue
        head = r"(?=\s#{1,3}\s|^#{1,3}\s)"
        blocks.extend(x.strip() for x in re.split(head, s) if x.strip())

    lines: list[str] = []
    in_pre = False
    for block in blocks:
        low = block.lower()
        if low.startswith("<pre>"):
            if lines and lines[-1] != "":
                lines.append("")
            lines.append("```")
            body = re.sub(r"</pre>\s*$", "", block[5:], flags=re.I)
            if body.strip():
                lines.extend(body.splitlines() or [body])
            if low.endswith("</pre>"):
                lines.extend(["```", ""])
            else:
                in_pre = True
            continue
        if in_pre:
            if "</pre>" in low:
                tail = block[: low.index("</pre>")].strip()
                if tail:
                    lines.append(tail)
                lines.extend(["```", ""])
                in_pre = False
            else:
                lines.append(block)
            continue
        m = re.match(r"^(#{1,6})\s*(.+)$", block)
        if m:
            # 汇总研判里的 # 与 ## 一律当正文小标题：统一成三级（h3），不和分区标题抢
            level = 3
            if lines and lines[-1] != "":
                lines.append("")
            lines.extend(["#" * level + " " + m.group(2).strip(), ""])
        else:
            if lines and lines[-1] != "":
                lines.append("")
            lines.extend([block, ""])
    return "\n".join(lines).strip()


def _analyst_md(analyst: dict) -> str:
    """分项观察的 html → markdown。

    分项正文原本是 <p> 一段一段的；先把段落边界换成空行，再交给 _text_to_md。
    只有一段时也照样返回，交给外层包成 <p>，不会退化成裸文本。
    """
    text = str(analyst.get("html") or "")
    text = re.sub(r"</p>\s*<p[^>]*>", "\n\n", text)
    text = re.sub(r"</h[1-6]>\s*", "\n\n", text)
    text = re.sub(r"^\s*<p[^>]*>", "", text)
    text = re.sub(r"</p>\s*$", "", text)
    text = html.unescape(re.sub(r"<[^>]+>", "", text))
    return _text_to_md(text)


# ---------------------------------------------------------------- 可视化区块

def _cls(value) -> str:
    """涨红跌绿：正数红、负数绿、零或缺失中性。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return "flat"
    return "up" if value > 0 else ("down" if value < 0 else "flat")


def _sign(value, digits: int = 2, suffix: str = "") -> str:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return "—"
    return f"{value:+.{digits}f}{suffix}"


def _bar(value, scale, tone: str) -> str:
    """横向条形：宽度按量级缩放，颜色跟涨跌。"""
    try:
        pct = max(0.0, min(100.0, abs(float(value)) / scale * 100)) if scale else 0.0
    except (TypeError, ValueError):
        pct = 0.0
    return f'<span class="va-bar va-bar-{tone}"><i style="width:{pct:.0f}%"></i></span>'


def _stat_md(label: str, value: str, sub: str = "", tone: str = "flat") -> str:
    return (f'<div class="va-stat"><p class="va-stat-k">{html.escape(label)}</p>'
            f'<p class="va-stat-v {tone}">{value}</p>'
            f'<p class="va-stat-s">{sub}</p></div>')


def _table(head, rows, note: str = "", align: dict | None = None) -> str:
    """表格。`align` 按列下标给 left / right / center，没给就左对齐。"""
    align = align or {}

    def cls(i: int) -> str:
        kind = align.get(i)
        return f' class="va-al-{kind}"' if kind else ""

    head_html = "".join(f"<th{cls(i)}>{html.escape(h)}</th>" for i, h in enumerate(head))
    cell = lambda c: c if c.lstrip().startswith("<td") else "<td>" + c + "</td>"
    body = "".join("<tr>" + "".join(cell(c) for c in r) + "</tr>" for r in rows)
    tip = f'<p class="va-table-note">{note}</p>' if note else ""
    return (f'<div class="va-table-wrap"><table class="va-table"><thead><tr>{head_html}</tr></thead>'
            f"<tbody>{body}</tbody></table></div>{tip}")


def _block_feedback(mf: dict) -> str:
    """昨日强势股反馈：按昨日板位 × 今日结果的人数矩阵 + 晋级率。"""
    fm = mf.get("feedback_matrix") or {}
    if not fm.get("available"):
        return '<p class="va-gap">昨日强势股反馈未取到，不代表昨日涨停今天没有表现。</p>'
    order = fm.get("result_order") or []
    matrix = fm.get("matrix") or {}
    tiers = [t for t in ("5板", "4板", "3板", "2板", "首板") if t in matrix] + [t for t in matrix if t not in
              ("5板", "4板", "3板", "2板", "首板")]
    rows = []
    for t in tiers:
        cell = matrix[t]
        total = cell.get("合计") or 0
        cols = []
        for r in order:
            n = cell.get(r) or 0
            share = n / total if total else 0
            tone = "up" if r == "晋级涨停" or r == "收红" else ("down" if r in ("跌超5%", "跌停") else "")
            tip = html.escape(t) + " · " + html.escape(r) + "：" + str(n) + " 只"
            cols.append('<td class="va-cell ' + tone + '" title="' + tip + '">'
                        + str(n) + '<span class="va-cell-bar" style="width:'
                        + f"{share * 100:.0f}" + '%"></span></td>')
        rate = cell.get("晋级率")
        cols.append(f'<td class="va-num mono">{_pct(rate)}</td>')
        rows.append([f'<td class="va-tier">{html.escape(t)}</td>', f'<td class="va-num">{total}</td>'] + cols)
    head = ["昨日板位", "样本"] + order + ["晋级率"]
    note = (f'样本 {fm.get("sample")} 只，覆盖 {_pct(fm.get("coverage_rate"))}；'
            f'{fm.get("note") or ""}')
    return _table(head, rows, note)


def _block_money(payload: dict) -> str:
    """赚钱效应 / 亏钱效应 / 连板溢价 / 封板质量：四组读数卡。"""
    em = payload.get("emotion_metrics") or {}
    mf = payload.get("market_facts") or {}
    money = em.get("money_effect") or {}
    premium = em.get("consec_premium") or {}
    loss = mf.get("loss_effect") or {}
    seal = mf.get("seal_quality") or {}
    cards = []
    if money.get("available"):
        cards.append(_stat_md("赚钱效应 · 平均", f'<span class="{"up" if money.get("avg", 0) > 0 else "down"}">{_sign(money.get("avg"), 2, "%")}</span>',
                               f'中位数 {_sign(money.get("median"), 2, "%")} · 翻红率 {_pct(money.get("positive_rate"))} · 样本 {money.get("sample")} 只'))
    else:
        cards.append(_stat_md("赚钱效应", "未取得", "昨日涨停样本未取到"))
    if loss.get("available"):
        cards.append(_stat_md("亏钱效应 · 昨日强势股", f'<span class="down">{_pct(loss.get("deep_loss_5_rate"))}</span>',
                               f'跌超 5% {loss.get("deep_loss_5_count")} 只 · 跌超 7% {loss.get("deep_loss_7_count")} 只 · 跌停 {loss.get("limit_down_count")} 只'))
        cards.append(_stat_md("全市场跌停", f'<span class="down">{loss.get("market_limit_down")}</span>',
                               "最差 " + _sign(loss.get("worst"), 2, "%") + " · 样本 "
                               + str(loss.get("sample")) + " 只"))
    else:
        cards.append(_stat_md("亏钱效应", "未取得", "昨日强势股表现未取到"))
    if premium.get("available"):
        cards.append(_stat_md("连板溢价", f'<span class="{"up" if premium.get("median", 0) > 0 else "down"}">{_sign(premium.get("median"), 2, "%")}</span>',
                               f'中位 · 均值 {_sign(premium.get("avg"), 2, "%")} · 翻红 {_pct(premium.get("positive_rate"))} · 样本 {premium.get("sample")} 只'))
    if seal.get("available"):
        cards.append(_stat_md("封板质量 · 未炸占比", f'<span class="up">{_pct(seal.get("never_broken_rate"))}</span>',
                               f'全天未炸 {seal.get("never_broken")} / {seal.get("total")} 只 · 炸板 {seal.get("broken_pool")} 只 · 平均开板 {_num(seal.get("avg_broken_times"), 2)} 次'))
        cards.append(_stat_md("封板质量 · 曾开板", f'<span class="down">{_pct(seal.get("ever_opened_rate"))}</span>',
                               f'尾盘回封 {seal.get("late_seal")} 只 · 首封到收盘 {seal.get("opening_seconds")} 秒口径'))
    if not cards:
        return ""
    return '<div class="va-grid va-grid-wide">' + "".join(cards) + "</div>"


def _block_promotion(payload: dict) -> str:
    """晋级率：整体与各板位，一条横条看强弱。"""
    em = payload.get("emotion_metrics") or {}
    mf = payload.get("market_facts") or {}
    promo = em.get("promotion") or {}
    by_board = mf.get("by_board") or {}
    ladder = em.get("ladder_gap") or {}
    if not promo.get("available"):
        return '<p class="va-gap">该日晋级数据未取到。</p>'
    overall = promo.get("overall") or {}
    rows = [];
    entries = [("整体", overall.get("base"), overall.get("promoted"), overall.get("rate"))]
    for name, cell in (promo.get("tiers") or {}).items():
        entries.append((name, cell.get("base"), cell.get("promoted"), cell.get("rate")))
    for name, base, promoted, rate in entries:
        tone = "up" if (rate or 0) >= 0.3 else "down"
        rows.append(["<td class=\"va-tier\">" + html.escape(str(name)) + "</td>",
                     "<td class=\"va-num\">" + str(base if base is not None else "—") + "</td>",
                     "<td class=\"va-num\">" + str(promoted if promoted is not None else "—") + "</td>",
                     "<td class=\"va-num mono\">" + _pct(rate) + "</td>",
                     "<td class=\"va-num\">" + _bar(rate or 0, 1.0, tone) + "</td>"])
    for key, label in (("10cm", "10cm 板"), ("20cm", "20cm 板")):
        cell = by_board.get("boards", {}).get(key) or {}
        if not cell:
            continue
        rate = cell.get("promotion_rate")
        tone = "up" if (rate or 0) >= 0.3 else "down"
        rows.append(["<td class=\"va-tier\">" + html.escape(label) + "</td>",
                     "<td class=\"va-num\">" + str(cell.get("prev_base", "—")) + "</td>",
                     "<td class=\"va-num\">" + str(cell.get("promoted", "—")) + "</td>",
                     "<td class=\"va-num mono\">" + _pct(rate) + "</td>",
                     "<td class=\"va-num\">" + _bar(rate or 0, 1.0, tone) + "</td>"])
    head = ["统计口径", "昨日基数", "今日再涨停", "晋级率", "强弱"]
    mini = (f'<p class="va-mini">昨日涨停 {promo.get("prev_limit_up_count")} 只 → 今日涨停 '
            f'{promo.get("limit_up_count")} 只 · 最高 {ladder.get("highest", "—")} 板</p>')
    note = fm_note = "晋级以本次涨停池成员为准；按板位分开读，不同板位的晋级不能相加。"
    return mini + _table(head, rows, note)


def _block_ladder(payload: dict) -> str:
    """梯队结构：各板位家数的柱形 + 断层提示。"""
    em = payload.get("emotion_metrics") or {}
    ladder = em.get("ladder_gap") or {}
    tiers = ladder.get("tiers") or {}
    if not tiers:
        return '<p class="va-gap">该日梯队数据未取到。</p>'
    numeric = {int(k): v for k, v in tiers.items() if str(k).isdigit() and isinstance(v, int)}
    if not numeric:
        return '<p class="va-gap">该日梯队数据未取到。</p>'
    top = max(numeric.values()) or 1
    cols = []
    for n in range(2, max(numeric) + 1):
        count = numeric.get(n) or 0
        gap = count == 0
        height = max(6.0, count / top * 100) if not gap else 6.0
        cls = "va-col gap" if gap else "va-col"
        cols.append("<div class=\"" + cls + "\"><span class=\"va-col-n\">" + str(count) + "</span>");
        cols.append("<span class=\"va-col-bar\" style=\"height:" + f"{height:.0f}" + "%\"></span>");
        cols.append("<span class=\"va-col-x\">" + str(n) + " 板</span></div>")
    hint = ""
    if not ladder.get("continuous", True) and ladder.get("note"):
        hint = '<p class="va-mini warn">' + html.escape(str(ladder.get("note"))) + "</p>"
    tail = ('<p class="va-mini">最高 ' + str(ladder.get("highest", "—")) + ' 板 · 板位结构是跨题材拼接，'
            "不代表同一题材内部有梯队</p>")
    return '<div class="va-ladder">' + "".join(cols) + "</div>" + hint + tail


def _block_themes(payload: dict) -> str:
    """题材结构（行业视角）+ 题材事件树（同花顺题材视角）。"""
    mf = payload.get("market_facts") or {}
    out = []
    ts = mf.get("theme_structure") or {}
    themes = ts.get("themes") or []
    if themes:
        rows = []
        top = max([t.get("limit_up") or 0 for t in themes] or [1]) or 1
        for t in themes[:10]:
            broken = t.get("broken") or 0
            up = t.get("limit_up") or 0
            tone = "down" if broken > up / 2 else "up"
            rows.append(["<td class=\"va-tier\">" + html.escape(str(t.get("sector") or "")) + "</td>",
                         "<td class=\"va-num mono\">" + str(up) + "</td>",
                         "<td class=\"va-num\">" + _bar(up, top, "up") + "</td>",
                         "<td class=\"va-num\">" + str(t.get("highest") or 0) + " 板</td>",
                         "<td class=\"va-num " + tone + "\">" + str(broken) + "</td>",
                         "<td class=\"va-num mono\">" + _pct(t.get("broken_rate")) + "</td>",
                         "<td class=\"va-num mono\">" + html.escape(str(t.get("first_seal") or "—")) + "</td>"])
        tl = ts.get("timeline") or []
        tl_txt = " · ".join(f'{x.get("slot")} {x.get("count")}' for x in tl)
        out.append('<p class="va-mini">行业集中度 ' + _pct(ts.get("concentration")) + " · " + str(ts.get("theme_count", len(themes))) + " 个行业有涨停</p>")
        out.append(_table(["行业", "涨停", "相对量", "最高板", "炸板", "炸板率", "首封"], rows,
                          "涨停股按东财行业归类；炸板多说明封板不稳，不等于次日会跌。首封时间 HHMMSS。"));
        if tl_txt:
            out.append('<p class="va-mini">封板时间分布：' + html.escape(tl_txt) + "（不含北交所）</p>")
    tree = mf.get("theme_tree") or {}
    nodes = tree.get("themes") or []
    if nodes:
        top = max([n.get("limit_up") or 0 for n in nodes] or [1]) or 1
        rows = []
        for n in nodes[:12]:
            state = str(n.get("state") or "")
            cls = "up" if state in ("扩散中", "今日新出现", "维持") else "down"
            cont = n.get("continuation_rate")
            rows.append(["<td class=\"va-tier\">" + html.escape(str(n.get("tag") or "")) + "</td>",
                         '<td><span class="va-pill ' + cls + '">' + html.escape(state) + "</span></td>",
                         "<td class=\"va-num mono\">" + str(n.get("limit_up") or 0) + "</td>",
                         "<td class=\"va-num\">" + _bar(n.get("limit_up") or 0, top, "up") + "</td>",
                         "<td class=\"va-num\">" + str(n.get("broken") or 0) + "</td>",
                         "<td class=\"va-num mono\">" + _pct(cont) + "</td>"])
        out.append('<p class="va-mini">题材树共 ' + str(tree.get("tag_count", 0)) + " 个题材标签，今日涨停覆盖 "
                   + str(tree.get("covered", "—")) + "/" + str(tree.get("limit_up", tree.get("covered", "—"))) + " 只</p>")
        out.append(_table(["题材", "跨日状态", "涨停", "相对量", "炸板", "延续率"], rows,
                          "状态由昨日同题材成员今日是否继续涨停判定；来源站编辑归因，非公司确认。"))
    return "".join(out) if out else '<p class="va-gap">该日题材结构未取到。</p>'


def _trend_text(kind: str, v) -> str:
    if kind == "rate":
        return _pct(v)
    if kind == "pct":
        return _sign(v)
    return f"{v:g}" if isinstance(v, (int, float)) else "—"


def _trend_bars(days: list, values: list, metric: dict) -> str:
    """单指标横向柱状：日期标签在左当纵轴（最新在上），柱长按本指标自身峰值缩放。"""
    nums = [v for v in values if isinstance(v, (int, float))]
    scale = max([abs(v) for v in nums] or [1]) or 1
    kind = str(metric.get("kind") or "count")
    # 颜色按「越热越红」定：higher_is_hotter 为假时，数值低才是红
    hot = "up" if metric.get("higher_is_hotter") is not False else "down"
    last_idx = len(values) - 1
    rows = []
    for i, v in enumerate(values):
        try:
            pct = max(0.0, min(100.0, abs(float(v)) / scale * 100))
        except (TypeError, ValueError):
            pct = 0.0
        rows.append('<span class="va-hb-row' + (" last" if i == last_idx else "") + '">'
                    + "<em>" + html.escape(days[i][5:] if i < len(days) and days[i] else "") + "</em>"
                    + '<i class="va-hb-track"><i class="va-hb-fill va-hb-' + hot
                    + '" style="width:' + f"{pct:.1f}" + '%"></i></i>'
                    + '<b class="va-hb-n">' + html.escape(_trend_text(kind, v)) + "</b></span>")
    return "".join(rows)


def _block_trend(payload: dict) -> str:
    """最近几天怎么走的：六个指标各自一张横向柱状图，日期轴在左、最新日期在上。"""
    mf = payload.get("market_facts") or {}
    trend = mf.get("trend") or {}
    days = list(trend.get("days") or [])
    metrics = trend.get("metrics") or []
    if not days or not metrics:
        return '<p class="va-gap">该日趋势数据未取到。</p>'
    days.reverse()          # 最新在上、最早在下
    charts = []
    for m in metrics:
        vals = list(m.get("values") or [])[::-1]
        label = str(m.get("label") or m.get("key"))
        if m.get("kind") == "rate" and m.get("higher_is_hotter") is False:
            label += "（越低越热）"
        unit = str(m.get("unit") or "")
        hint = ("单位 " + unit) if unit else ("比例" if m.get("kind") == "rate" else "")
        charts.append('<div class="va-hb-card"><p class="va-hb-h"><b>' + html.escape(label) + "</b>"
                      + ("<span>" + html.escape(hint) + "</span>" if hint else "")
                      + '</p><div class="va-hb">' + _trend_bars(days, vals, m) + "</div></div>")
    note = (f"最近 {len(days)} 个交易日，最上面一行是复盘日；每张图的柱长只在同一指标内缩放，"
            + "看的是这项指标自己这几天处在高位还是低位。")
    return ('<div class="va-hb-grid">' + "".join(charts) + "</div>"
            + '<p class="va-mini">' + note + "</p>")


def _block_diff(payload: dict) -> str:
    """较前一交易日的几个关键读数变化，带涨跌色、箭头和历史分位。"""
    mf = payload.get("market_facts") or {}
    changes = (mf.get("day_diff") or {}).get("changes") or []
    stats = {i.get("key"): i for i in ((mf.get("stats_context") or {}).get("items") or [])}
    if not changes:
        return '<p class="va-gap">该日与前一日对比数据未取到。</p>'
    cards = []
    for c in changes[:6]:
        warm = "up" if c.get("hotter") else "down"
        arrow = "▲" if c.get("hotter") else "▼"
        st = stats.get(c.get("key")) or {}
        pct = st.get("percentile")
        sub = "前日 " + html.escape(str(c.get("prev_text") or "—")) + " → " + html.escape(str(c.get("cur_text") or "—"))
        if isinstance(pct, (int, float)):
            sub += f" · 近 60 日 {pct * 100:.0f}% 分位"
        val = "<span class=\"" + warm + "\">" + html.escape(str(c.get("cur_text") or "—")) + "</span> " \
              "<span class=\"va-arrow " + warm + "\">" + arrow + "</span>"
        cards.append(_stat_md(str(c.get("label") or ""), val, sub))
    return '<div class="va-grid va-grid-wide">' + "".join(cards) + "</div>"


def _block_events(payload: dict) -> str:
    """题材事件串：最高标、反复开板、断板、高标跌停这些已发生的事实。"""
    mf = payload.get("market_facts") or {}
    ledger = mf.get("event_ledger") or {}
    events = ledger.get("events") or []
    if not events:
        return '<p class="va-gap">该日事件串未取到。</p>'
    rows = []
    for e in events[:12]:
        tag = str(e.get("tag") or "")
        cls = "down" if tag in ("炸板", "跌停", "高标跌停", "连板断板") else "up"
        name = html.escape(str(e.get("name") or ""))
        code = html.escape(str(e.get("code") or ""))
        cells = ["<td class=\"va-tier\">" + name + ' <span class="va-mono dim">' + code + "</span></td>",
                 '<td><span class="va-pill ' + cls + '">' + html.escape(tag) + "</span></td>",
                 "<td class=\"va-num\">" + html.escape(str(e.get("sector") or "—")) + "</td>",
                 "<td class=\"va-num mono\">" + html.escape(str(e.get("note") or "—")) + "</td>",
                 "<td class=\"va-num mono " + _cls(e.get("ret")) + "\">" + _sign(e.get("ret")) + "%</td>"]
        rows.append(cells)
    note = "共 " + str(ledger.get("count", len(events))) + " 条；只记录当日已发生的事实，不含预测。"
    return _table(["个股", "事件", "行业", "说明", "当日涨跌"], rows, note)

def _block_breadth(payload: dict) -> str:
    """市场广度：涨跌家数、大涨大跌、成交额，按 v1「市场状态」八格补齐。"""
    mf = payload.get("market_facts") or {}
    em = payload.get("emotion_metrics") or {}
    b = mf.get("breadth") or {}
    if not b.get("available") and not b.get("dist_available"):
        return '<p class="va-gap">该日涨跌分布未取到。</p>'
    up, down, flat = b.get("up"), b.get("down"), b.get("flat")
    cards = []
    if isinstance(up, int) and isinstance(down, int):
        ratio = up / (up + down) if (up + down) else None
        cards.append(_stat_md("上涨 / 下跌",
                               '<span class="up">' + str(up) + '</span> / <span class="down">' + str(down) + "</span>",
                               "平盘 " + str(flat if flat is not None else "—") + " · 上涨占比 " + _pct(ratio)
                               + " · 全 A " + str(b.get("universe") or "—") + " 只"))
    deep_up, deep_down = b.get("deep_up_5_incl"), b.get("deep_down_5")
    if isinstance(deep_up, int) and isinstance(deep_down, int):
        cards.append(_stat_md("涨超 5% / 跌超 5%",
                               '<span class="up">' + str(deep_up) + '</span> / <span class="down">' + str(deep_down) + "</span>",
                               "大涨大跌家数；跌超 5% 多说明亏钱面广"))
    amount = b.get("amount_yi")
    if isinstance(amount, (int, float)):
        cards.append(_stat_md("两市成交额", f"{amount:,.0f} 亿", "当日两市合计成交额"))
    by_board = (mf.get("by_board") or {}).get("boards") or {}
    for key, label in (("10cm", "10cm 涨停 / 跌停"), ("20cm", "20cm 涨停 / 跌停")):
        cell = by_board.get(key) or {}
        if not cell:
            continue
        cards.append(_stat_md(label,
                               '<span class="up">' + str(cell.get("limit_up", "—")) + '</span> / <span class="down">'
                               + str(cell.get("limit_down", "—")) + "</span>",
                               "炸板 " + str(cell.get("broken", "—")) + " 只"))
    cyc = em.get("cycle") or {}
    if cyc.get("available"):
        word = "转强" if cyc.get("rising") else "转弱"
        cards.append(_stat_md("情绪周期", _pct(cyc.get("pctile")),
                               "窗口内相对分 · " + word + " · " + str(cyc.get("day_n"))
                               + " 日窗口；是相对读数，不是绝对高低"))
    note = '<p class="va-mini">涨跌家数是沪深 A 股口径（可能剔除北交所），分布口径见报告来源说明；两种范围不要混用分母。</p>'
    return ('<div class="va-grid va-grid-wide">' + "".join(cards) + "</div>" + note) if cards else '<p class="va-gap">该日涨跌分布未取到。</p>'


def _block_seal(payload: dict) -> str:
    """炸板与封板结构：v1「封板质量」的细项，原来只给了两个比例。"""
    seal = ((payload.get("market_facts") or {}).get("seal_quality")) or {}
    if not seal.get("available"):
        return '<p class="va-gap">该日封板结构未取到。</p>'
    total, broken = seal.get("total") or 0, seal.get("broken_pool") or 0
    seal_rate = (total - broken) / total if total else None
    cards = [
        _stat_md("封板率", '<span class="up">' + _pct(seal_rate) + "</span>",
                 str(seal.get("never_broken")) + " 只全天未炸 / 共 " + str(total) + " 只"),
        _stat_md("炸板率", '<span class="down">' + _pct(seal.get("broken_rate")) + "</span>",
                 "炸板 " + str(broken) + " 只 · 收盘回封 " + str(seal.get("reopened")) + " 只"),
        _stat_md("平均开板次数", _num(seal.get("avg_broken_times"), 2), "只统计摸到涨停又打开过的样本"),
        _stat_md("尾盘回封", str(seal.get("late_seal")) + " 只", "收盘前重新封住的只数"),
    ]
    return '<div class="va-grid va-grid-wide">' + "".join(cards) + "</div>"


def _hhmmss(value) -> str:
    """涨停池的封板时间是 HHMMSS 六位数字，公开页统一成 09:30:26。"""
    text = str(value or "").strip()
    if len(text) == 6 and text.isdigit():
        return f"{text[:2]}:{text[2:4]}:{text[4:]}"
    if len(text) == 4 and text.isdigit():
        return f"{text[:2]}:{text[2:]}"
    return text or "—"


def _block_lianban(payload: dict) -> str:
    """连板股名单：v1「连板股」表（板位、首封、成交额、行业、题材）。"""
    mf = payload.get("market_facts") or {}
    tree = mf.get("theme_tree") or {}
    nodes = tree.get("themes") or []
    members = {}
    for n in nodes:
        tag = str(n.get("tag") or "")
        for mem in n.get("members") or []:
            if not isinstance(mem, dict):
                continue
            code = str(mem.get("code") or "")
            if not code or code in members:
                continue
            members[code] = {**mem, "tag": tag}
    rows = []
        
    picks = [m for m in members.values() if (m.get("boards") or 0) >= 2]
    if not picks:
        picks = list(members.values())[:20]
    picks.sort(key=lambda m: (-(m.get("boards") or 0), str(m.get("first_seal") or "")))
    for m in picks[:25]:
        boards = m.get("boards") or 0
        rows.append(['<span class="va-tier">' + html.escape(str(m.get("name") or "")) +
                     ' <span class="va-mono dim">' + html.escape(str(m.get("code") or "")) + "</span></span>",
                     '<span class="up">' + str(boards) + " 板</span>",
                     _hhmmss(m.get("first_seal")),
                     html.escape(str(m.get("label") or "")),
                     html.escape(str(m.get("tag") or "")),
                     str(m.get("broken_times") or 0)])
    if not rows:
        return '<p class="va-gap">该日连板样本未取到。</p>'
    note = (f"共 {len(members)} 只涨停样本里有 {len(picks)} 只连板；板与首封按当日涨停池，题材是同花顺市场叙事，不是核验过的因果。")
    # 个股 / 板位 / 题材是文字列，左对齐；首封时间与开板次数居中
    return _table(["个股", "连板", "首封", "板位标签", "所属题材", "开板次数"], rows, note,
                  align={1: "center", 2: "center", 5: "center"})

# ---------------------------------------------------------------- 补齐 v1 剩余区块

# ---------------------------------------------------------------- 外部数据（发布时现取）

INDEX_URL = "http://127.0.0.1:8910/api/indices"
OVERSEAS_URL = "http://127.0.0.1:8910/api/market/overseas"


def _get_json(url: str, timeout: float = 8.0):
    """本机服务的只读接口；取不到就返回 None，由调用方写成「未获取」。"""
    try:
        import urllib.request
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:  # noqa: BLE001  本机服务没起或源站抖动都算没取到
        return None


def index_snapshot(date: str) -> dict:
    """A 股四只主要指数快照。只有当日涨跌，没有历史区间（本机接口不回时间）。"""
    data = _get_json(INDEX_URL)
    rows = (data or {}).get("data") if isinstance(data, dict) else None
    if not rows:
        return {"date": date, "rows": [], "reason": "本机指数接口没取到"}
    return {"date": date, "rows": [r for r in rows if isinstance(r, dict)], "reason": ""}


def overseas_snapshot() -> dict:
    data = _get_json(OVERSEAS_URL)
    if not isinstance(data, dict) or not data.get("available"):
        return {"indices": [], "reason": "隔夜外围没取到"}
    return {"indices": [i for i in data.get("indices") or [] if isinstance(i, dict)],
            "mag7": [i for i in data.get("mag7") or [] if isinstance(i, dict)], "reason": ""}


def tushare_distribution(date: str) -> dict:
    """涨跌分布 23 档 + 两融 + 指数次日/近 5 日表现，全部由 Tushare 当日全市场日线现算。

    只做聚合，不落个股：分布是 5570 只的涨跌幅直方图，两融取市场汇总。
    """
    token = os.environ.get("TUSHARE_TOKEN", "").strip()
    if not token:
        env = Path(__file__).resolve().parents[1] / ".env"
        for line in env.read_text(encoding="utf-8").splitlines() if env.exists() else []:
            if line.startswith("TUSHARE_TOKEN="):
                token = line.split("=", 1)[1].strip()
                break
    if not token:
        return {"available": False, "reason": "没有 TUSHARE_TOKEN"}
    try:
        import tushare as ts
        pro = ts.pro_api(token)
        df = pro.daily(trade_date=date.replace("-", ""), fields="ts_code,pct_chg,amount")
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "reason": f"Tushare 取数失败：{type(exc).__name__}"}
    if df is None or len(df) == 0:
        return {"available": False, "reason": "Tushare 该日无日线"}
    pct = df["pct_chg"].dropna()
    edges = [-100, -9.5, -9, -8, -7, -6, -5, -4, -3, -2, -1, -0.5, 0,
             0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9.5, 100]
    labels = ["跌停", "<-9%", "-9~-8", "-8~-7", "-7~-6", "-6~-5", "-5~-4", "-4~-3", "-3~-2",
              "-2~-1", "-1~-0.5", "-0.5~0", "平", "0~0.5", "0.5~1", "1~2", "2~3", "3~4",
              "4~5", "5~6", "6~7", "7~8", "8~9", ">9%", "涨停"]
    counts = [0] * (len(edges) - 1)
    for v in pct.tolist():
        for i in range(len(edges) - 1):
            if edges[i] <= v < edges[i + 1]:
                counts[i] += 1
                break
    margin = margin_history(pro, date)
    return {"available": True, "date": date, "labels": labels, "counts": counts,
            "total": int(len(pct)), "margin": margin, "reason": ""}


MARGIN_DAYS = 20


def margin_history(pro, date: str, days: int = MARGIN_DAYS) -> dict | None:
    """近 N 个交易日两市融资融券余额（沪深京合计，单位亿），最近一天是复盘日。

    Tushare 的 margin 按交易所分列，同一交易日多行，必须先按日期求和再看趋势。
    """
    day = date.replace("-", "")
    start = (datetime.date.fromisoformat(date) - datetime.timedelta(days=days * 3 + 10))
    try:
        df = pro.margin(start_date=start.strftime("%Y%m%d"), end_date=day)
        if df is None or len(df) == 0:
            return None
        grouped = df.groupby("trade_date")[["rzrqye", "rzmre", "rzche"]].sum().sort_index()
        grouped = grouped[grouped.index <= day].tail(days)
        if grouped.empty:
            return None
        # 融资净买入 = 当日融资买入额 − 融资偿还额，正数说明当天融资加仓
        net = (grouped["rzmre"] - grouped["rzche"]) / 1e8
        return {"date": date, "days": [str(i) for i in grouped.index],
                "values": [round(float(v), 1) for v in grouped["rzrqye"].div(1e8).tolist()],
                "net_values": [round(float(v), 1) for v in net.tolist()],
                "balance": round(float(grouped["rzrqye"].iloc[-1]) / 1e8, 1), "window": days}
    except Exception:  # noqa: BLE001
        return None


POS_LABELS = ("平", "0~0.5", "0.5~1", "1~2", "2~3", "3~4", "4~5", "5~6", "6~7", "7~8", "8~9", ">9%", "涨停")


def _block_distribution(dist: dict) -> str:
    """涨跌分布 25 档：横向柱状图，档位标签在左做纵轴，跌绿在上、涨红在下；柱长按峰值归一到同一标尺。"""
    if not dist.get("available"):
        return '<p class="va-gap">涨跌分布未获取（' + html.escape(str(dist.get("reason") or "无数据")) + "）。</p>"
    peak = max(dist.get("counts") or [1]) or 1
    rows = []
    for label, count in zip(dist["labels"], dist["counts"]):
        tone = "up" if label in POS_LABELS else "down"
        ratio = max(0.0, min(1.0, count / peak))
        rows.append('<span class="va-hist-row va-hist-' + tone + '" title="' + html.escape(label) + "：" + str(count) + ' 只">'
                    + "<em>" + html.escape(label) + "</em>"
                    + '<i class="va-hist-track"><i class="va-hist-fill" style="width:'
                    + (f"{ratio * 100:.1f}") + '%"></i></i>'
                    + "<b>" + str(count) + "</b></span>")
    note = ("全市场 " + str(dist.get("total")) + " 只（含北交所）按涨跌幅自上而下分档，越往下涨幅越大；"
            + "柱长为该档家数，同一标尺可直接比对。来源 Tushare 当日日线，与盘面上东财口径可能差几只。")
    return '<div class="va-hist">' + "".join(rows) + "</div>" + '<p class="va-mini">' + note + "</p>"


def _index_cards(rows: list, *, with_session: bool) -> str:
    cards = []
    for r in rows:
        chg = r.get("change_pct")
        price = r.get("price")
        price_txt = f"{price:,.2f}" if isinstance(price, (int, float)) else "—"
        sub = price_txt
        if with_session:
            sub += " · " + str(r.get("region") or "") + " · 交易日 " + str(r.get("session") or "—")
        cards.append(_stat_md(str(r.get("name") or ""),
                              '<span class="' + _cls(chg) + '">' + _sign(chg, 2, "%") + "</span>",
                              html.escape(sub)))
    return '<div class="va-grid va-grid-wide">' + "".join(cards) + "</div>"


def _block_index(idx: dict, overseas: dict) -> str:
    """主要指数：当日快照 + 隔夜外围；历史区间这一路不给，如实标注。"""
    out = []
    rows = idx.get("rows") or []
    if rows:
        out.append(_index_cards(rows, with_session=False))
        out.append('<p class="va-mini">这是取数此刻的指数快照，不是复盘日收盘价；复盘日的收盘与 5/20/60/250 日等区间读数见上面的「主要指数 · 中长期位置」。</p>')
    elif idx.get("reason"):
        out.append('<p class="va-gap">主要指数：' + html.escape(str(idx.get("reason"))) + "。</p>")
    ov = overseas.get("indices") or []
    if ov:
        out.append('<p class="va-mini" style="margin-top:14px">隔夜外围（美股 / 港股各自交易日，不等于 A 股复盘日）</p>')
        out.append(_index_cards(ov, with_session=True))
    return "".join(out) or '<p class="va-gap">指数与外围均未获取。</p>'


def _md_day(day: str) -> str:
    """日期显示成 MM-DD：Tushare 给 20261028，复盘里也可能是 2026-10-28。"""
    digits = re.sub(r"\D", "", str(day))
    return digits[4:6] + "-" + digits[6:8] if len(digits) == 8 else str(day)


def _block_margin(dist: dict) -> str:
    """两融余额：当日读数 + 近 20 个交易日的横向柱状图（日期在左，最新在上）。"""
    m = (dist or {}).get("margin")
    if not m:
        return '<p class="va-gap">两融余额未获取（Tushare 该日无汇总或无权限）。</p>'
    bal = m.get("balance")
    val = f"{bal:,.0f} 亿" if isinstance(bal, (int, float)) else "—"
    cards = _stat_md("两融余额", val, "融资融券余额合计 · " + html.escape(str(m.get("date") or "")))
    days = list(m.get("days") or [])
    values = list(m.get("values") or [])
    if len(days) < 2 or len(days) != len(values):
        return '<div class="va-grid va-grid-wide">' + cards + "</div>"
    days.reverse()
    values.reverse()
    lo, hi = min(values), max(values)
    span = (hi - lo) or 1.0
    prev = None
    rows = []
    for i, (d, v) in enumerate(zip(days, values)):
        # 余额变化只有几个百分点，按区间铺满柱长才能看出拐点；同比上一日的升降用颜色标
        pct = max(4.0, min(100.0, (v - lo) / span * 100))
        tone = "flat" if prev is None else ("up" if v > prev else ("down" if v < prev else "flat"))
        prev = v
        rows.append('<span class="va-hb-row' + (" last" if i == 0 else "") + '">'
                    + "<em>" + html.escape(_md_day(d)) + "</em>"
                    + '<i class="va-hb-track"><i class="va-hb-fill va-hb-' + tone
                    + '" style="width:' + f"{pct:.1f}" + '%"></i></i>'
                    + '<b class="va-hb-n">' + f"{v:,.0f}" + "</b></span>")
    chart = ('<div class="va-hb-card"><p class="va-hb-h"><b>近 ' + str(len(days))
             + ' 个交易日两融余额</b><span>单位 亿元</span></p><div class="va-hb">'
             + "".join(rows) + "</div></div>")
    note = ("余额按沪深京合计，最上面一行是复盘日；柱长按这 " + str(len(days))
            + f" 天的区间（{lo:,.0f} ~ {hi:,.0f} 亿）铺满，柱子颜色是较上一交易日的升降。"
            + "来源 Tushare 融资融券汇总。")
    out = ('<div class="va-grid va-grid-wide">' + cards + "</div>"
           + '<div class="va-hb-grid va-hb-grid-1" style="margin-top:12px">' + chart + "</div>"
           + '<p class="va-mini">' + note + "</p>")
    out += _block_margin_net(m)
    return out


def _block_margin_net(m: dict) -> str:
    """近 20 日融资净买入：正数（融资加仓）红、负数（融资减仓）绿，柱长按最大绝对值缩放。"""
    days = list(m.get("days") or [])
    nets = list(m.get("net_values") or [])
    if len(days) < 2 or len(days) != len(nets):
        return ""
    days.reverse()
    nets.reverse()
    scale = max([abs(v) for v in nets] or [0]) or 1.0
    rows = []
    for i, (d, v) in enumerate(zip(days, nets)):
        pct = max(1.5, min(100.0, abs(v) / scale * 100))
        tone = "up" if v > 0 else ("down" if v < 0 else "flat")
        rows.append('<span class="va-hb-row' + (" last" if i == 0 else "") + '">'
                    + "<em>" + html.escape(_md_day(d)) + "</em>"
                    + '<i class="va-hb-track"><i class="va-hb-fill va-hb-' + tone
                    + '" style="width:' + f"{pct:.1f}" + '%"></i></i>'
                    + '<b class="va-hb-n">' + f"{v:+,.0f}" + "</b></span>")
    positives = sum(1 for v in nets if v > 0)
    total = sum(nets)
    hint = f"{len(days)} 日合计 {total:+,.0f} 亿"
    chart = ('<div class="va-hb-card"><p class="va-hb-h"><b>近 ' + str(len(days))
             + ' 个交易日融资净买入</b><span>' + html.escape(hint) + '</span></p>'
             + '<div class="va-hb">' + "".join(rows) + "</div></div>")
    note = (f"融资净买入 = 当日融资买入额 − 融资偿还额，按沪深京合计，单位亿元；"
            + f"这 {len(days)} 天里有 {positives} 天净买入为正。"
            + f"柱长按最大绝对值（{scale:,.0f} 亿）缩放，红为净买入、绿为净卖出。"
            + "来源 Tushare 融资融券汇总。")
    return ('<div class="va-hb-grid va-hb-grid-1" style="margin-top:12px">' + chart + "</div>"
            + '<p class="va-mini">' + note + "</p>")


# 输入归档里的文本行格式：`  名称 今75.39亿/5日缺 涨1.34% 领涨某某`
_CAP_IN = re.compile(r"^\s*(?P<name>[^\s]+)\s+今(?P<net>-?[\d.]+)亿.*?涨(?P<pct>-?[\d.]+)%(?:\s+领涨(?P<leader>\S+))?")
_CAP_OUT = re.compile(r"^\s*(?P<name>[^\s]+)\s+今(?P<net>-?[\d.]+)亿")
_TURNOVER = re.compile(r"^\s*(?P<name>[^\s]+)\s+(?P<amt>[\d.]+)亿\s+涨(?P<pct>-?[\d.]+)%")
_DRAGON = re.compile(r"^\s*(?P<name>[^\s]+)\s+净买(?P<net>[+-]?[\d.]+)亿\s*\[(?P<why>[^\]]*)\]")


def _section_lines(text: str, header: str) -> list[str]:
    """把归档文本按小节切开，取 `header` 之后到下一个空 `TOP：` 小节之间的行。"""
    lines = (text or "").splitlines()
    out: list[str] = []
    inside = False
    for ln in lines:
        s = ln.strip()
        if s.startswith(header):
            inside = True
            continue
        if inside and (s.endswith("TOP：") or s.startswith("（口径提示")):
            break
        if inside and s:
            out.append(s)
    return out


def _block_capital(capital_text: str, dragon_text: str) -> str:
    """资金段落：行业净流入/流出、成交额前 20、龙虎榜净买额榜。"""
    out = []
    inflow = _section_lines(capital_text, "行业主力净流入")
    outflow = _section_lines(capital_text, "行业主力净流出")
    turnover = _section_lines(capital_text, "全市场成交额")
    if inflow or outflow:
        cards = []
        for line in inflow[:6]:
            m = _CAP_IN.match(line)
            if not m:
                continue
            net = float(m.group("net"))
            pct = float(m.group("pct"))
            cards.append(_stat_md(m.group("name") + " · 净流入",
                                  '<span class="up">+' + f"{net:.2f}" + " 亿</span>",
                                  "板块涨 " + _sign(pct, 2, "%") + (" · 领涨 " + m.group("leader") if m.group("leader") else "")))
        for line in outflow[:6]:
            m = _CAP_OUT.match(line)
            if not m:
                continue
            net = float(m.group("net"))
            cards.append(_stat_md(m.group("name") + " · 净流出",
                                  '<span class="down">' + f"{net:.2f}" + " 亿</span>", "行业主力资金"))
        out.append('<div class="va-grid va-grid-wide">' + "".join(cards) + "</div>")
    if turnover:
        rows = []
        for line in turnover[:20]:
            m = _TURNOVER.match(line)
            if not m:
                continue
            pct = float(m.group("pct"))
            rows.append(['<span class="va-tier">' + html.escape(m.group("name")) + "</span>",
                         f"{float(m.group('amt')):.2f} 亿",
                         '<span class="' + _cls(pct) + '">' + _sign(pct, 2, "%") + "</span>"])
        out.append('<p class="va-mini" style="margin-top:14px">全市场成交额居前 20</p>')
        out.append(_table(["个股", "成交额", "当日涨跌"], rows))
    if dragon_text:
        rows = []
        for line in dragon_text.splitlines():
            m = _DRAGON.match(line)
            if not m:
                continue
            net = float(m.group("net"))
            rows.append(['<span class="va-tier">' + html.escape(m.group("name")) + "</span>",
                         '<span class="' + _cls(net) + '">' + _sign(net, 2, " 亿") + "</span>",
                         html.escape(m.group("why") or "—")])
        if rows:
            out.append('<p class="va-mini" style="margin-top:14px">龙虎榜净买额榜（负 = 净卖）</p>')
            out.append(_table(["个股", "净买额", "上榜原因"], rows,
                              "只列净买额与上榜原因，不含席位明细；净买入不等于主力看好。"))
    return "".join(out) or '<p class="va-gap">该日资金与龙虎榜未归档。</p>'


TIER_RULES = (
    ("continuous", "连续集中", "今天 ≥3 只，前一交易日也 ≥2 只"),
    ("today", "今天集中", "今天 ≥3 只，前一交易日没有 ≥2 只"),
    ("scattered", "零散", "今天 2 只"),
    ("single", "单只", "今天 1 只"),
)


def _block_tier_tiers(payload: dict, prev_reviews: dict) -> str:
    """涨停分档：按东财行业、和前一交易日比，按只数分四档。"""
    mf = payload.get("market_facts") or {}
    themes = ((mf.get("theme_structure") or {}).get("themes")) or []
    if not themes:
        return '<p class="va-gap">该日行业涨停结构未取到，分档没算。</p>'
    prev_date = str((mf.get("day_diff") or {}).get("prev_date") or "")
    prev = prev_reviews.get(prev_date) or {}
    prev_themes = ((prev.get("market_facts") or {}).get("theme_structure") or {}).get("themes") or []
    prev_counts = {str(t.get("sector") or ""): (t.get("limit_up") or 0) for t in prev_themes}
    tiers = {key: [] for key, _l, _h in TIER_RULES}
    for t in themes:
        n = t.get("limit_up") or 0
        was = prev_counts.get(str(t.get("sector") or "")) or 0
        if n >= 3:
            tiers["continuous" if was >= 2 else "today"].append(t)
        elif n == 2:
            tiers["scattered"].append(t)
        else:
            tiers["single"].append(t)
    cards = []
    for key, label, hint in TIER_RULES:
        groups = tiers[key]
        if not groups:
            continue
        head = groups[0]
        tone = "up" if key in ("continuous", "today") else "flat"
        sub = (str(head.get("limit_up") or 0) + " 只 · 最高 " + str(head.get("highest") or 0)
               + " 板 · 首封 " + str(head.get("first_seal") or "—"))
        if len(groups) > 1:
            sub += " · 同档还有 " + "、".join(str(g.get("sector")) for g in groups[1:4])
        cards.append(_stat_md(label + "（" + str(len(groups)) + " 个行业）",
                              '<span class="' + tone + '">' + html.escape(str(head.get("sector") or "")) + "</span>",
                              sub + " · " + hint))
    note = ("和 " + (prev_date or "前一交易日") + " 的东财行业口径对比；档位是按只数的固定规则，不代表能不能持续，也不是推荐。")
    if not prev_themes:
        note += "前一交易日报告不在库里，只按今天只数分档。"
    return '<div class="va-grid va-grid-wide">' + "".join(cards) + '</div><p class="va-mini">' + note + "</p>"

def post_title(payload: dict, date: str) -> str:
    phase = (payload.get("focus") or {}).get("emotion_phase")
    return f"{date} 每日复盘" + (f" · 情绪档位{phase}" if phase else "")


def post_filename(date: str) -> str:
    return f"{date}-每日复盘.md"


def _yaml_str(value: str) -> str:
    """front matter 里的字符串：JSON 的双引号形式也是合法 YAML。"""
    return json.dumps(value, ensure_ascii=False)



def _stat_cards(payload: dict) -> list[str]:
    """当日读数：v1 复盘页那种方框卡（标签 / 等宽大数字 / 一行说明）。"""
    return [f'<div class="va-stat"><p class="va-stat-k">{html.escape(k)}</p>'
            f'<p class="va-stat-v">{html.escape(v)}</p>'
            f'<p class="va-stat-s">{html.escape(s)}</p></div>'
            for k, v, s in summary_cards(payload)]


def _inline_md(text: str) -> str:
    out = html.escape(text)
    out = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)
    return out


def _md_blocks(md: str) -> list[str]:
    """把 _text_to_md 产出的块转成 HTML 片段。

    块之间空行分隔；块只有三种形态：> 引用、### 小标题、普通段落。
    """
    out: list[str] = []
    for block in [b.strip() for b in (md or "").split("\n\n") if b.strip()]:
        m = re.match(r"^(#{1,6})\s*(.+)$", block)
        if m:
            level = min(len(m.group(1)), 3)
            out.append(f"<h{level}>{_inline_md(m.group(2))}</h{level}>")
            continue
        if block.startswith(">"):
            text = " ".join(ln.lstrip("> ").strip() for ln in block.splitlines())
            out.append("<blockquote>" + _inline_md(text) + "</blockquote>")
            continue
        out.append("<p>" + _inline_md(block) + "</p>")
    return out


def _section(title: str, body_md: str, hint: str = "") -> str:
    """一个分区：橙色竖条小标题 + 说明 + 面板正文（与复盘页一致的层级）。

    正文先按块转成 <p> / <h3> / <blockquote>：段落之间才有间距与首行缩进，
    markdown 标题也才会变成真标题，而不是字面的井号。
    """
    sub = f"<span>{html.escape(hint)}</span>" if hint else ""
    body = "".join(
        part if re.match(r"^\s*<(section|div|table|details|ul|ol|p|h[1-6]|blockquote|span|a|strong|em|br)", part)
        else "".join(_md_blocks(part))
        for part in body_md if part.strip())
    return (f'<section class="va-sec"><div class="va-sec-h"><h2>{html.escape(title)}</h2>{sub}</div>'
            f'<div class="va-panel post-content">{body}</div></section>')

def _archive_dir() -> Path:
    """复盘输入的原始归档（资金 / 龙虎榜原文）。默认本机数据区 archive/。"""
    return Path(os.environ.get("ASTOCK_ARCHIVE_DIR") or (Path.home() / ".duanxian-agents" / "archive"))


def archive_texts(date: str) -> dict:
    """读某日输入归档里的资金、龙虎榜原文。没有归档就返回空串。"""
    base = _archive_dir() / date
    if not base.is_dir():
        # 复盘任务目录：本机默认 ~/.vibe-astock-agent/daily，容器版在它的卷里
        roots = [Path.home() / ".vibe-astock-agent" / "daily"]
        if os.environ.get("ASTOCK_AGENT_HOME"):
            roots.insert(0, Path(os.environ["ASTOCK_AGENT_HOME"]) / "daily")
        for job_root in roots:
            found = None
            for meta in sorted(job_root.glob("*.json")) if job_root.is_dir() else []:
                job_dir = meta.with_suffix("")
                if not (job_dir / "get_capital_data.json").exists():
                    continue
                try:
                    row = json.loads(meta.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if row.get("date") == date:
                    found = job_dir
                    break
            if found:
                base = found
                break
    out = {}
    for key, name in (("capital", "get_capital_data"), ("dragon", "get_dragon_tiger_data")):
        try:
            row = json.loads((base / f"{name}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            out[key] = ""
            continue
        value = row.get("value")
        out[key] = value if isinstance(value, str) else ""
    return out


def _external(date: str, log: Callable[[str], None] = lambda _m: None) -> dict:
    """发布时现取的外部数据：指数快照、外围、涨跌分布与两融、资金归档。"""
    dist = tushare_distribution(date)
    if not dist.get("available"):
        log(f"{date}：涨跌分布未取到（{dist.get('reason')}）")
    return {"index": index_snapshot(date), "overseas": overseas_snapshot(), "hist": index_history(date),
            "dist": dist, "archive": archive_texts(date)}

INDEX_CODES = (
    ("000001.SH", "上证指数"), ("399001.SZ", "深证成指"),
    ("399006.SZ", "创业板指"), ("000300.SH", "沪深300"),
)


def _tushare_pro():
    """Tushare 客户端；没有令牌或没装包就返回 None。"""
    token = os.environ.get("TUSHARE_TOKEN", "").strip()
    if not token:
        env = Path(__file__).resolve().parents[1] / ".env"
        for line in env.read_text(encoding="utf-8").splitlines() if env.exists() else []:
            if line.startswith("TUSHARE_TOKEN="):
                token = line.split("=", 1)[1].strip()
                break
    if not token:
        return None
    try:
        import tushare as ts
        return ts.pro_api(token)
    except Exception:  # noqa: BLE001
        return None


def index_history(date: str) -> dict:
    """四只主要指数的历史区间：5/20/60/250 日涨跌、年初至今、离一年高点、均线上下。

    全由 Tushare 指数日线现算，只用复盘日及之前的数据。
    """
    pro = _tushare_pro()
    if pro is None:
        return {"available": False, "reason": "没有 TUSHARE_TOKEN 或未安装 tushare", "rows": []}
    rows = []
    for code, name in INDEX_CODES:
        try:
            df = pro.index_daily(ts_code=code, start_date="20220101", end_date=date.replace("-", ""))
        except Exception as exc:  # noqa: BLE001
            rows.append({"name": name, "reason": f"取数失败：{type(exc).__name__}"})
            continue
        if df is None or len(df) == 0:
            rows.append({"name": name, "reason": "该日无指数日线"})
            continue
        df = df.sort_values("trade_date").reset_index(drop=True)
        close = df["close"].tolist()
        last = close[-1]

        def ret(n: int):
            return (last / close[-1 - n] - 1) * 100 if len(close) > n else None

        year_start = [i for i, d in enumerate(df["trade_date"].tolist()) if d[:4] == date[:4]]
        ytd = (last / close[year_start[0] - 1] - 1) * 100 if year_start and year_start[0] > 0 else None
        window = close[-250:]
        high = max(window) if window else last
        mas = {}
        for n in (20, 60, 250):
            mas[n] = round(sum(close[-n:]) / n, 2) if len(close) >= n else None
        rows.append({"name": name, "date": str(df.iloc[-1]["trade_date"]), "close": round(last, 2),
                     "chg": round(float(df.iloc[-1]["pct_chg"]), 2) if isinstance(df.iloc[-1].get("pct_chg"), (int, float)) else None,
                     "r5": ret(5), "r20": ret(20), "r60": ret(60), "r250": ret(250), "ytd": ytd,
                     "off_high": (last / high - 1) * 100 if high else None, "high250": round(high, 2),
                     "ma20": mas[20], "ma60": mas[60], "ma250": mas[250], "reason": ""})
    return {"available": bool(rows), "rows": rows, "reason": "" if rows else "没取到指数日线"}

def _block_index_hist(hist: dict) -> str:
    """主要指数的中长期位置：5/20/60/250 日、年初至今、离一年高点、均线上下。"""
    if not hist.get("available"):
        return '<p class="va-gap">指数历史区间未获取（' + html.escape(str(hist.get("reason") or "无数据")) + "）。</p>"
    rows = []
    for r in hist.get("rows") or []:
        if r.get("reason"):
            rows.append(['<span class="va-tier">' + html.escape(str(r.get("name"))) + "</span>",
                         '<span class="va-gap">' + html.escape(str(r.get("reason"))) + "</span>",
                         "—", "—", "—", "—", "—", "—", "—"])
            continue
        def cell(v):
            return '<span class="' + _cls(v) + '">' + _sign(v, 2, "%") + "</span>"
        ma_bits = []
        for n in (20, 60, 250):
            ma = r.get(f"ma{n}")
            close = r.get("close")
            if isinstance(ma, (int, float)) and isinstance(close, (int, float)):
                up = close >= ma
                ma_bits.append('<span class="' + ("up" if up else "down") + '" title="' + str(n) + ' 日均线 ' + f"{ma:,.2f}" + '">' + str(n) + ("上" if up else "下") + "</span>")
            else:
                ma_bits.append('<span class="flat">' + str(n) + "—</span>")
        rows.append(['<span class="va-tier">' + html.escape(str(r.get("name"))) + "</span>",
                     f"{r.get('close'):,.2f}" if isinstance(r.get("close"), (int, float)) else "—",
                     cell(r.get("chg")), cell(r.get("r5")), cell(r.get("r20")), cell(r.get("r60")),
                     cell(r.get("r250")), cell(r.get("ytd")), cell(r.get("off_high")),
                     " ".join(ma_bits)])
    head = ["指数", "收盘", "当日", "5 日", "20 日", "60 日", "250 日", "年初至今", "离一年高点", "均线"]
    note = ("N 日涨跌 = 最新收盘 ÷ N 个交易日前收盘 − 1；离一年高点 = 最新收盘 ÷ 250 日最高收盘 − 1；"
            + "均线一列是收盘在 20/60/250 日均线的上方还是下方。数据来自 Tushare 指数日线，截至复盘日。")
    return _table(head, rows, note)

V1_ORIGIN = "https://a.luckybrother.cc"
V2_ORIGIN = "https://a2.luckybrother.cc"

# v1 侧栏（frontend/src/lib/workspace/modules.ts）里挑六项：标题与路径都用侧栏原文
V1_FEATURES = (
    ("∑", "复盘报告", "情绪、资金、题材、龙虎榜、龙头分五段写再汇总；数字与引用逐条核对，可展开查看依据。", "/agent/review"),
    ("▣", "首板分析", "当日首板涨停股 + 涨停原因题材串，客观公开榜单。", "/first-board"),
    ("◎", "昨日梯队", "固定前一交易日涨停样本今天的延续、断板与覆盖缺口。", "/yesterday-ladder"),
    ("⊙", "盘中核验", "把复盘里的观察条件与当天有效快照对照，回答「此前条件是否出现」。", "/agent/intraday"),
    ("◷", "历史统计", "按已有涨停样本看次日表现、封板时间等分组差异，样本偏差如实标注。", "/backtest"),
    ("✎", "交易日志", "记录每笔成交与盈亏，按情绪环境和板位分组自查。", "/journal"),
)

# v2 侧栏（desktop/.../lib/nav.ts）里挑六项：同样是侧栏原文的标题与路由
V2_FEATURES = (
    ("◔", "实时动态", "盘中盯持仓与自选、昨日梯队、异动与封板开板，页面开着就自动刷新。", "/watch"),
    ("◑", "竞价与盘中", "09:25 竞价强弱 + 六个时点的情绪路径，快照到点自动存。", "/watch/intraday"),
    ("◈", "情绪复盘", "赚钱效应、晋级率、连板天梯、封板质量、题材事件树，五段分开写再汇总。", "/shortline"),
    ("⇄", "多空辩论", "对照支持与反对的观点，找遗漏的前提、风险与反证。", "/debate"),
    ("⌕", "个股深挖", "A 股、港股、美股：K 线、财报、事件回看，分阶段整理估值与风险。", "/research"),
    ("↺", "回测", "用对话描述规则，历史数据检验，和指数对照出图。", "/backtest"),
)
def _feature_card(icon: str, name: str, text: str, href: str) -> str:
    """一张功能卡：字形图标 + 侧栏原名 + 一句说明，整卡可点。"""
    return "".join([
        '<a class="va-feat" href="' + href + '" rel="noopener" target="_blank">',
        '<span class="va-feat-icon">' + html.escape(icon) + "</span>",
        '<span class="va-feat-body"><b>' + html.escape(name) + "</b>",
        '<em>' + html.escape(text) + "</em></span>",
        '<span class="va-feat-go">打开 →</span>',
        "</a>",
    ])


def _promo_card(title: str, desc: str, features, origin: str) -> str:
    """一个版本的介绍卡：标题、一句说明、六张功能卡（不放入口按钮）。"""
    cards = "".join(_feature_card(i, n, t, origin.rstrip("/") + path) for i, n, t, path in features)
    return "".join([
        '<div class="va-promo-card">',
        "<h3>" + html.escape(title) + "</h3>",
        '<p class="va-promo-desc">' + html.escape(desc) + "</p>",
        '<div class="va-feat-grid">' + cards + "</div>",
        "</div>",
    ])


def promotion_html() -> str:
    """文章尾部的产品介绍：V1 / V2 各六张功能卡，标题与路径都和程序侧栏一致。"""
    v1 = _promo_card("揽宝投研 V1",
                     "短线复盘工作台：行情、统计与回测由程序算，AI 只解释材料。",
                     V1_FEATURES, V1_ORIGIN)
    v2 = _promo_card("揽宝投研 V2",
                     "加上盘中竞价、多空辩论、个股深挖与产业研究，侧栏 10 个栏目放在同一处。",
                     V2_FEATURES, V2_ORIGIN)
    return "".join([
        '<section class="va-promo">',
        '<div class="va-promo-head"><h2>把这些数字交给程序算</h2>',
        "<p>本页所有数字都由揽宝投研计算，文章由它生成后自动发布。点卡片进对应功能。</p></div>",
        '<div class="va-promo-grid">' + v1 + v2 + "</div>",
        '<p class="va-promo-foot">开源、本机运行：' + html.escape(DISCLAIMER) + "</p>",
        "</section>",
    ])

def post_markdown(payload: dict, date: str, ext: dict | None = None,
                  prev_reviews: dict | None = None) -> str:
    """一篇 Hugo 文章（front matter + 正文）。全部来自本机已核对的产物。"""
    focus = payload.get("focus") or {}
    one = str(focus.get("market_oneliner") or "")
    focus_body, evidence = split_body(str(payload.get("focus_md") or ""))
    warnings = [str(w) for w in payload.get("warnings") or []]
    analysts = [a for a in payload.get("analysts") or [] if isinstance(a, dict)]
    generated = str(payload.get("generated_at") or "")
    hm = re.search(r"(\d{2}:\d{2})", generated)
    stamp = f"{date}T{hm.group(1)}:00+08:00" if hm else f"{date}T15:30:00+08:00"

    fm = [
        "---",
        "title: " + _yaml_str(post_title(payload, date)),
        f"date: {stamp}",
        "description: " + _yaml_str(one[:200]),
        'tags: ["每日复盘"]',
        "summary: " + _yaml_str(one),
        "phase: " + _yaml_str(str(focus.get("emotion_phase") or "")),
        "draft: false",
        "---",
        "",
    ]
    # 版式照本机复盘页：先一块「当日一句话 + 四只读数」方框卡，再逐个分区面板
    md: list[str] = []
    lead = [f'<p class="va-leadline">{html.escape(one)}</p>' if one else "",
            '<div class="va-grid">' + "".join(_stat_cards(payload)) + "</div>"]
    md.append(f'<section class="va-panel va-lead">{"".join(lead)}</section>')
    md.append(f'<p class="va-foot-note">{html.escape(DISCLAIMER)}</p>')
    if warnings:
        md.append('<div class="va-note">口径提示：' + html.escape("；".join(warnings)) + "</div>")
    mf = payload.get("market_facts") or {}
    # 客观读数区：先给「较前一交易日」的变化，再逐块把复盘页有、博客缺的分析铺开
    if _block_diff(payload):
        ext = ext or {}
    if ext.get("dist"):
        md.append(_section("涨跌分布", [_block_distribution(ext["dist"])],
                           "全市场按涨跌幅分档，横轴自跌至涨、涨红跌绿"))
    md.append(_section("市场广度", [_block_breadth(payload)],
                       "涨跌家数、大涨大跌、成交额与两个板位的涨停跌停"))
    md.append(_section("较前一交易日", [_block_diff(payload)],
                           "五个关键读数对比昨日，箭头是情绪变热还是变冷；分位是同口径近 60 日排名"))
    md.append(_section("昨日强势股反馈", [_block_feedback(mf)],
                       "昨日涨停样本按昨日板位 × 今日结果的人数分布，晋级率单独一列"))
    if _block_money(payload):
        md.append(_section("赚钱效应与亏钱效应", [_block_money(payload)],
                           "昨日涨停今天的表现、连板溢价、封板质量；跌超家数只看昨日强势样本"))
    md.append(_section("晋级率", [_block_promotion(payload)],
                       "按板位分开读，不同板位不能相加"))
    md.append(_section("梯队结构", [_block_ladder(payload)],
                       "各板位家数是跨题材拼接，不断言同一题材内部有梯队"))
    md.append(_section("连板股", [_block_lianban(payload)],
                       "板位、首封时间、所属题材、开板次数；非推荐"))
    md.append(_section("炸板与封板结构", [_block_seal(payload)],
                       "封板率、炸板率、开板次数与尾盘回封"))
    md.append(_section("题材结构与题材事件树", [_block_themes(payload)],
                       "行业口径与同花顺题材口径并列；事件树看昨日题材今天是否还在"))
    md.append(_section("最近几天怎么走的", [_block_trend(payload)],
                       "六个指标逐日取值，最后一天是复盘日"))
    if _block_events(payload):
        md.append(_section("当日事件串", [_block_events(payload)],
                           "最高标、反复开板、断板、高标跌停等已发生的事实"))
    md.append(_section("汇总研判", [_text_to_md(strip_citations(focus_body)) or "该日没有汇总研判正文。"],
                       "程序核对过的数字 + 模型写的解释，缺口如实标注"))
    for a in analysts:
        md.append(_section(str(a.get("title") or ""), [_analyst_md(a)]))
    macro = strip_citations(str(payload.get("macro_sector") or ""))
    if macro.strip():
        md.append(_section("板块与宏观", [_text_to_md(macro)]))
    if ext.get("hist"):
        md.append(_section("主要指数 · 中长期位置", [_block_index_hist(ext["hist"])],
                           "5/20/60/250 日涨跌、年初至今、离一年高点与均线位置"))
    if ext.get("index") or ext.get("overseas"):
        md.append(_section("主要指数与隔夜外围", [_block_index(ext.get("index") or {}, ext.get("overseas") or {})],
                           "当日快照 + 外围各自交易日；历史区间这一路没取"))
    if ext.get("dist"):
        md.append(_section("两融余额", [_block_margin(ext["dist"])],
                           "Tushare 日度汇总：当日读数 + 近 20 个交易日走势"))
    arch = ext.get("archive") or {}
    md.append(_section("资金去了哪", [_block_capital(arch.get("capital", ""), arch.get("dragon", "")),],
                       "行业净流入/流出、成交额前 20、龙虎榜净买额榜"))
    md.append(_section("涨停分档", [_block_tier_tiers(payload, prev_reviews or {})],
                       "按东财行业和前一交易日比，只看集中在哪、散在哪"))
    if evidence.strip():
        # 依据附录单独成块：details 里放块级 div，正文段才不会被行内解析挤成一段
        md.append('<details class="post-detail">' + chr(10)
                  + '<summary>本次输入依据（机器扫描的原始片段）</summary>' + chr(10) + chr(10)
                  + '<div class="post-content">' + chr(10) + chr(10)
                  + _text_to_md(strip_citations(evidence))
                  + chr(10) + chr(10) + '</div>' + chr(10) + chr(10)
                  + '</details>' + chr(10) + chr(10))
    md.append(promotion_html())
    return "\n".join(fm + md).strip() + "\n"


def split_body(text: str) -> tuple[str, str]:
    """把汇总研判拆成 (正文, 本次输入依据)。依据是机器扫描到的原始片段，折进附录。"""
    text = text or ""
    head, sep, tail = text.partition("## 本次输入依据")
    return (head if sep else text), (tail if sep else "")


# ---------------------------------------------------------------- 写源 / 构建 / 同步

@dataclass
class PublishResult:
    written: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    built: int = 0
    committed: bool = False
    pushed: bool = False
    commit: str = ""
    url: str = ""


def write_sources(site_dir: Path | str, reviews_dir: Path | str, dates: list[str],
                  log: Callable[[str], None] = lambda _m: None) -> tuple[list[str], list[str]]:
    """把复盘写进 content/post/。返回 (写入的文件, 被跳过/删除的日期)。"""
    post_dir = Path(site_dir) / "content" / "post"
    post_dir.mkdir(parents=True, exist_ok=True)
    written, skipped = [], []
    wanted = set(dates)
    # 库里所有可用的复盘：涨停分档要和前一交易日比
    prev_reviews = {}
    for path in Path(reviews_dir).glob("*.json"):
        if DATE_RE.fullmatch(path.stem):
            try:
                prev_reviews[path.stem] = load_review(reviews_dir, path.stem)
            except PublishError:
                continue
    for d in dates:
        try:
            payload = load_review(reviews_dir, d)
            check_public_text(payload)
        except PublishError as exc:
            log(f"跳过 {d}：{exc}")
            skipped.append(d)
            continue
        path = post_dir / post_filename(d)
        text = post_markdown(payload, d, ext=_external(d, log), prev_reviews=prev_reviews)
        if not path.exists() or path.read_text(encoding="utf-8") != text:
            path.write_text(text, encoding="utf-8")
            written.append(path.name)
    # 本工具写过、但这次不再发布的文章（比如被判不合规）不留在源里
    for path in post_dir.glob("*-每日复盘.md"):
        d = path.name[:10]
        if DATE_RE.fullmatch(d) and d not in wanted:
            path.unlink()
            skipped.append(d)
    return written, skipped


def _run(cmd: list[str], cwd: Path | str | None = None) -> str:
    proc = subprocess.run(cmd, cwd=str(cwd) if cwd else None, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-5:]
        raise PublishError(f"{cmd[0]} 执行失败：{' '.join(tail)}")
    return proc.stdout


def find_hugo(explicit: str | None = None) -> str:
    """hugo 可执行：显式指定 → PATH → 仓库 .local/bin/hugo（免安装包下载的那份）。"""
    if explicit:
        return explicit
    found = shutil.which("hugo")
    if found:
        return found
    local = Path(__file__).resolve().parents[1] / ".local" / "bin" / "hugo"
    if local.exists():
        return str(local)
    raise PublishError("找不到 hugo：装一个（https://gohugo.io/installation/）或放到 .local/bin/hugo")


def build(site_dir: Path | str, hugo: str | None = None, log: Callable[[str], None] = lambda _m: None) -> int:
    """跑 hugo 生成 public/；返回生成的 html 页数。"""
    site = Path(site_dir)
    binary = find_hugo(hugo)
    _run([binary, "--cleanDestinationDir", "--quiet"], cwd=site)
    public = site / "public"
    if not public.is_dir():
        raise PublishError("hugo 没有产出 public/，检查站点配置")
    pages = sum(1 for _ in public.rglob("*.html"))
    log(f"hugo 构建完成：{pages} 个页面")
    return pages


# 站上这些路径归本工具所有：同步时删掉仓库里有、本次构建没有的页面
# 主题自带的样式、脚本、字体与图片一起同步：少了它们，线上页面就是裸 HTML
OWNED_DIRS = ("post", "tags", "page", "css", "js", "webfonts", "img", "fonts", "reward", "search")
OWNED_FILES = ("index.html", "index.xml", "sitemap.xml", "404.html", "robots.txt")
# 上一版「静态页补丁」留下的自有路径：发布时清掉，站上原有文件不在其中
LEGACY_PATHS = ("reviews", "year", "month", "date", "astock", "astock-feed.xml", "deploy.json")


def auth_mode() -> str:
    """gh 优先（本机已登录的账号）；没有 gh 就用 ASTOCK_PAGES_TOKEN。"""
    if shutil.which("gh"):
        try:
            _run(["gh", "auth", "status"])
            return "gh"
        except PublishError:
            pass
    if os.environ.get("ASTOCK_PAGES_TOKEN", "").strip():
        return "token"
    raise PublishError("没有可用的 GitHub 凭据：先 gh auth login，或设置环境变量 ASTOCK_PAGES_TOKEN（需有该仓库写权限）")


# 自有样式：站上没有同名文件，放 /css/ 下也不覆盖任何东西
OWNED_ASSETS = ("css/astock.css", "favicon.ico", "favicon.png", "search.png")


def _owned(path: Path) -> bool:
    rel = path.as_posix()
    return (rel in OWNED_FILES or rel in OWNED_ASSETS
            or rel.split("/", 1)[0] in OWNED_DIRS)


def sync_public(public_dir: Path | str, target_dir: Path | str,
                log: Callable[[str], None] = lambda _m: None) -> tuple[list[str], list[str]]:
    """把 public/ 同步进 Pages 仓库：只碰自己的产物与清单记过的旧页面。

    站上原有文件（2016 年的老文章、css、字体、图片、about…）按字节比较，不同才写，
    所以骨架文件不会被反复重写；不在构建产物里的自有旧页面会删掉。
    """
    src, dst = Path(public_dir), Path(target_dir)
    changed, removed = [], []
    manifest_path = dst / MANIFEST
    known = []
    if manifest_path.exists():
        try:
            known = [p for p in json.loads(manifest_path.read_text(encoding="utf-8")).get("files", [])
                     if isinstance(p, str) and not p.startswith("/") and ".." not in p.split("/")]
        except (OSError, ValueError):
            known = []
    produced = set()
    for path in sorted(src.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(src)
        if not _owned(rel):
            continue
        produced.add(rel.as_posix())
        out = dst / rel
        data = path.read_bytes()
        if out.exists() and out.read_bytes() == data:
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        changed.append(rel.as_posix())
    for rel in known:
        if rel in produced or rel == MANIFEST or not _owned(Path(rel)):
            continue
        old = dst / rel
        if old.is_file():
            old.unlink()
            removed.append(rel)
    manifest = {"generated_by": PRODUCT_NAME, "files": sorted(produced)}
    text = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    if not manifest_path.exists() or manifest_path.read_text(encoding="utf-8") != text:
        manifest_path.write_text(text, encoding="utf-8")
        changed.append(MANIFEST)
    return changed, removed


def remove_legacy_dirs(target_dir: Path | str,
                       log: Callable[[str], None] = lambda _m: None) -> list[str]:
    """清掉上一版「静态页补丁」留下的自有目录。

    只认本工具自己 export 的这些路径（reviews/、year/、month/、date/、astock/、
    astock-feed.xml、deploy.json）；站上原有文章目录（2016/…）绝不涉足。
    """
    dst = Path(target_dir)
    removed = []
    for name in LEGACY_PATHS:
        path = dst / name
        if path.is_dir():
            shutil.rmtree(path)
            removed.append(name + "/")
        elif path.is_file():
            path.unlink()
            removed.append(name)
    if removed:
        log("清理上一版遗留：" + "、".join(removed))
    return removed


def publish(
    site_dir: Path | str,
    reviews_dir: Path | str,
    *,
    date: str | None = None,
    repo: str = "ten2net/ten2net.github.io",
    branch: str = "master",
    max_pages: int = 366,
    hugo: str | None = None,
    dry_run: bool = False,
    push: bool = True,
    workdir: Path | str | None = None,
    log: Callable[[str], None] = lambda _m: None,
) -> PublishResult:
    """写 md → hugo 构建 → 同步到 Pages 仓库。date=None 时刷新全部。

    发布是幂等的：内容没变的文件不重写，所以定时重跑不会制造噪声提交。
    """
    reviews = Path(reviews_dir)
    dates = iter_dates(reviews, limit=max_pages)
    if date:
        load_review(reviews, date)              # 指定日期不可用就直接失败，不静默
        dates = sorted(set(dates) | {date}, reverse=True)
    if not dates:
        raise PublishError(f"{reviews} 里没有可发布的复盘")

    written, skipped = write_sources(site_dir, reviews, dates, log)
    if not list((Path(site_dir) / "content" / "post").glob("*-每日复盘.md")):
        raise PublishError("没有任何一份复盘能发布（都未通过公开检查）")
    result = PublishResult(written=written, removed=skipped,
                           url=f"https://{repo.split('/')[0]}.github.io/post/")
    if dry_run:
        return result

    result.built = build(site_dir, hugo, log)
    tmp = Path(workdir) if workdir else Path(tempfile.mkdtemp(prefix="astock-pages-"))
    owned = workdir is None
    try:
        if auth_mode() == "gh":
            _run(["gh", "repo", "clone", repo, str(tmp), "--", "--branch", branch, "--depth", "1"])
        else:
            token = os.environ["ASTOCK_PAGES_TOKEN"].strip()
            _run(["git", "clone", "--depth", "1", "--branch", branch,
                  f"https://x-access-token:{token}@{repo}.git", str(tmp)])
        changed, removed = sync_public(Path(site_dir) / "public", tmp, log)
        removed += remove_legacy_dirs(tmp, log)      # 上一版静态页补丁的遗留
        result.written, result.removed = changed, removed
        if not changed and not removed:
            log("站点已是最新，没有需要提交的改动")
            return result
        _run(["git", "add", "-A", "--", "."], cwd=tmp)
        _run(["git", "-c", "user.name=vibe-astock",
              "-c", "user.email=vibe-astock@users.noreply.github.com",
              "commit", "-m", f"复盘: 发布 {len(list((Path(site_dir) / 'content' / 'post').glob('*-每日复盘.md')))} 篇每日复盘"], cwd=tmp)
        result.committed = True
        result.commit = _run(["git", "rev-parse", "--short", "HEAD"], cwd=tmp).strip()
        if push:
            _run(["git", "push", "origin", f"HEAD:{branch}"], cwd=tmp)
            result.pushed = True
        return result
    finally:
        if owned:
            shutil.rmtree(tmp, ignore_errors=True)
