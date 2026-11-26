"""股票名 / 行业名 / 概念名高亮（公众号 + 博客共用）。

设计原则：
- 名称只从 payload 的**结构化字段**收集（涨停样本、题材结构、题材树、资金流榜等），
  不靠模型猜，不扫全文，避免把普通词误判成板块。
- 渲染后只处理 HTML 的**文本节点**（标签之间的文字），不碰标签属性、URL、已有
  color span 的样式值；名称按长度降序替换，避免「零售」先替换掉「百货零售」。
- 三类用不同颜色，读者一眼能分清股票 / 行业 / 概念。
"""

from __future__ import annotations

import html as _html
import re

# 高亮色（微信白名单内联 color；博客同样支持）
COLOR_STOCK = "#1a73e8"    # 股票名：蓝
COLOR_INDUSTRY = "#7b3fe4"  # 行业名：紫
COLOR_CONCEPT = "#e8710a"  # 概念名：橙

_MIN_LEN = 2  # 单字名称不highlight，避免误伤


def _add(names: dict[str, str], value, kind: str) -> None:
    """收录一个名称；kind 决定颜色。同名按 股票 > 概念 > 行业 优先。"""
    s = str(value or "").strip()
    if len(s) < _MIN_LEN or "\n" in s or "<" in s or ">" in s:
        return
    priority = {"stock": 3, "concept": 2, "industry": 1}
    if s in names and priority.get(names[s], 0) >= priority[kind]:
        return
    names[s] = kind


def collect_names(payload: dict) -> dict[str, str]:
    """从结构化字段收集 {名称: kind}，kind ∈ stock/industry/concept。"""
    names: dict[str, str] = {}
    mf = (payload or {}).get("market_facts") or {}

    # 行业：题材结构 sector / 行业资金流榜 name / 申万行业
    ts = (mf.get("theme_structure") or {}).get("themes") or []
    for t in ts:
        if isinstance(t, dict):
            _add(names, t.get("sector"), "industry")
            for n in t.get("names") or []:
                _add(names, n, "stock")
    for key in ("industry_flow", "sector_flow_industry"):
        for x in mf.get(key) or []:
            if isinstance(x, dict):
                _add(names, x.get("name") or x.get("sector"), "industry")

    # 概念：题材树 tag / 概念资金流榜 name
    tt = (mf.get("theme_tree") or {}).get("themes") or []
    for t in tt:
        if isinstance(t, dict):
            _add(names, t.get("tag"), "concept")
            for m in t.get("members") or []:
                if isinstance(m, dict):
                    _add(names, m.get("name"), "stock")
    for key in ("concept_flow", "sector_flow_concept"):
        for x in mf.get(key) or []:
            if isinstance(x, dict):
                _add(names, x.get("name") or x.get("tag"), "concept")

    # 股票：事件账本 / 连板梯队 / 龙虎榜 / 成交额榜
    for e in (mf.get("event_ledger") or {}).get("events") or []:
        if isinstance(e, dict):
            _add(names, e.get("name"), "stock")
    for key in ("ladder", "limit_up_pool", "zt_pool", "turnover_top"):
        for x in mf.get(key) or []:
            if isinstance(x, dict):
                _add(names, x.get("name"), "stock")
    em = (payload or {}).get("emotion_metrics") or {}
    for x in (em.get("ladder_gap") or {}).get("tiers") or []:
        if isinstance(x, dict):
            _add(names, x.get("name"), "stock")

    # 名字过滤：太泛的词不highlight（避免满屏高亮、影响阅读）
    stop = {"今日", "昨日", "市场", "行业", "概念", "板块", "个股", "全市场", "涨停", "跌停"}
    return {k: v for k, v in names.items() if k not in stop}


def _highlight_text(text: str, names: dict[str, str]) -> str:
    """在一段纯文本里替换名称；text 已是 HTML 文本节点（可能含 &amp; 等实体）。"""
    if not names:
        return text
    # 先解码实体再匹配（名称里可能有 & 之类），输出时重新转义整体交由调用方？
    # 这里保持 text 原样，只对可见字面量替换：常见名称不含实体，直接匹配即可。
    out = text
    for idx, name in enumerate(sorted(names, key=len, reverse=True)):
        kind = names[name]
        color = {"stock": COLOR_STOCK, "industry": COLOR_INDUSTRY,
                 "concept": COLOR_CONCEPT}[kind]
        rep = f'<span style="color:{color};font-weight:bold;">{name}</span>'
        # 先占位：避免后续更短的名称（如「零售」）在已插入的「百货零售」span 内重复匹配
        out = out.replace(name, f"\x00HL{idx}\x00")
    for idx, name in enumerate(sorted(names, key=len, reverse=True)):
        kind = names[name]
        color = {"stock": COLOR_STOCK, "industry": COLOR_INDUSTRY,
                 "concept": COLOR_CONCEPT}[kind]
        out = out.replace(f"\x00HL{idx}\x00",
                          f'<span style="color:{color};font-weight:bold;">{name}</span>')
    return out


def highlight_html(html_text: str, names: dict[str, str]) -> str:
    """只处理 HTML 文本节点；标签（含 style/属性）与 URL 原样保留。"""
    if not names or not html_text:
        return html_text
    parts = re.split(r"(<[^>]+>)", html_text)
    for i in range(0, len(parts), 2):  # 偶数下标是文本节点
        seg = parts[i]
        if not seg or "<" in seg:
            continue
        # 保护 URL：链接里的查询参数/路径可能恰好含股票名，不能被高亮破坏
        urls = re.findall(r"https?://[^\s<>\"',，。；;：:]+", seg)
        for j, u in enumerate(urls):
            seg = seg.replace(u, f"\x00URL{j}\x00", 1)
        seg = _highlight_text(seg, names)
        for j, u in enumerate(urls):
            seg = seg.replace(f"\x00URL{j}\x00", u, 1)
        parts[i] = seg
    return "".join(parts)


def highlight_markdown(md_text: str, names: dict[str, str]) -> str:
    """博客 Markdown：在正文文本里包 span（Hugo 允许内联 HTML）。

    跳过 frontmatter（--- 包裹的头部）、代码块、行内代码与已有 HTML 标签。
    """
    if not names or not md_text:
        return md_text
    lines = md_text.split("\n")
    out: list[str] = []
    in_fm = False
    in_code = False
    fm_seen = False
    for line in lines:
        stripped = line.strip()
        if stripped == "---" and not fm_seen:
            in_fm = not in_fm
            if not in_fm:
                fm_seen = True
            out.append(line)
            continue
        if in_fm:
            out.append(line)
            continue
        if stripped.startswith("```"):
            in_code = not in_code
            out.append(line)
            continue
        if in_code:
            out.append(line)
            continue
        # 去掉行内代码 `...` 与 URL 后再高亮：用占位保护
        # URL 字符集排除中文（中文常紧跟在 URL 后作正文，不能被吞进占位）
        code_spans = re.findall(r"`[^`]*`|https?://[^\s<>),，。；;：:]+", line)
        protected = dict(enumerate(code_spans))
        tmp = line
        for i, c in protected.items():
            tmp = tmp.replace(c, f"\x00CODE{i}\x00", 1)
        # 同样跳过已有 HTML 标签内部（标题/表格里的 <span> 等）
        segs = re.split(r"(<[^>]+>)", tmp)
        for i in range(0, len(segs), 2):
            seg = segs[i]
            if not seg or "\x00CODE" not in seg:
                if seg:
                    segs[i] = _highlight_text(seg, names)
                continue
            # 段内既有占位又有正文：逐个占位拆开，只高亮非占位部分
            tokens = re.split(r"(\x00CODE\d+\x00)", seg)
            for j in range(0, len(tokens), 2):
                if tokens[j]:
                    tokens[j] = _highlight_text(tokens[j], names)
            segs[i] = "".join(tokens)
        tmp = "".join(segs)
        for i, c in protected.items():
            tmp = tmp.replace(f"\x00CODE{i}\x00", c, 1)
        out.append(tmp)
    return "\n".join(out)
