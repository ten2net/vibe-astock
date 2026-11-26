"""资讯工具层 —— 外部资讯获取（题材热点分析师用）。

两路来源：
  1. Agent-Reach 全网检索（需要 mcporter，宿主机可用、容器内通常不可用）
  2. akshare 财经快讯（财联社电报 + 东财快讯，容器内可用，无需 mcporter）
     —— 作为容器内主源，也作为 Agent-Reach 失败时的降级源。
"""

from __future__ import annotations

import json
import subprocess
from datetime import date as _date

_MAX_RESULTS = 10
_MAX_QUERY = 200


def _escape_dsl(q: str) -> str:
    """转义会破坏 exa.web_search_exa(query:"...") 表达式的字符（反斜杠、双引号、换行）。"""
    return q.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ").replace("\r", " ")


def agent_reach_search(query: str, num_results: int = 5, timeout: int = 90) -> str:
    """走 Agent-Reach 的 Exa 全网搜索（零配置命令）。失败优雅降级。"""
    try:
        num_results = max(1, min(int(num_results), _MAX_RESULTS))
    except (TypeError, ValueError):
        num_results = 5
    q = _escape_dsl((query or "")[:_MAX_QUERY])
    cmd = f'exa.web_search_exa(query:"{q}", numResults:{num_results})'
    try:
        out = subprocess.run(
            ["mcporter", "call", cmd],
            capture_output=True, text=True, timeout=timeout,
        )
        if out.returncode != 0:
            return f"[Agent-Reach 调用失败 rc={out.returncode}] {(out.stderr or '')[:150]}"
        text = (out.stdout or "").strip()
        if not text:
            return f"[Agent-Reach 无返回] stderr={(out.stderr or '')[:200]}"
        try:
            data = json.loads(text)
            items = data.get("results") or data.get("data") or []
            lines = []
            for it in items[:num_results]:
                title = str(it.get("title", ""))[:120]
                snippet = str(it.get("text") or it.get("snippet") or "")[:200]
                lines.append(f"- {title}：{snippet}")
            return "\n".join(lines) if lines else text[:2000]
        except Exception:
            return text[:2000]
    except FileNotFoundError:
        return "[Agent-Reach 未打通：mcporter 不在 PATH]"
    except subprocess.TimeoutExpired:
        return "[Agent-Reach 超时]"
    except Exception as e:  # noqa: BLE001
        return f"[Agent-Reach 异常 {type(e).__name__}]"


# ---------------------------------------------------------------------------
# 财经快讯（akshare）：不依赖 mcporter，容器内可用
# ---------------------------------------------------------------------------
def _ak_func(*names):
    """取 akshare 里第一个存在的函数名（不同版本改名兼容）。"""
    try:
        import akshare as ak
    except Exception:  # noqa: BLE001
        return None
    for name in names:
        f = getattr(ak, name, None)
        if callable(f):
            return f
    return None


def _normalize_day(value) -> str:
    """把 datetime/date/字符串统一成 YYYY-MM-DD。"""
    if value is None:
        return ""
    if hasattr(value, "strftime"):
        return value.strftime("%Y-%m-%d")
    s = str(value).strip().replace("/", "-")
    return s[:10]


def _fetch_cls_news() -> list[dict]:
    """财联社电报：兼容新旧接口名，返回 [{title, content, day, source}]。"""
    f = _ak_func("stock_news_global_cls", "stock_info_global_cls")
    if not f:
        return []
    try:
        df = f("全部")  # 新旧版本 symbol 参数都接受；无参版本会 TypeError 后重试
    except TypeError:
        try:
            df = f()
        except Exception:  # noqa: BLE001
            return []
    except Exception:  # noqa: BLE001
        return []
    if df is None or not len(df):
        return []
    cols = {str(c): c for c in df.columns}
    title_col = cols.get("标题")
    content_col = cols.get("内容") or cols.get("摘要")
    day_col = cols.get("发布日期")
    time_col = cols.get("发布时间")
    out = []
    for _, r in df.iterrows():
        day = _normalize_day(r.get(day_col) if day_col else None)
        if not day and time_col:
            day = _normalize_day(r.get(time_col))
        title = str(r.get(title_col) or "")[:100] if title_col else ""
        content = str(r.get(content_col) or "")[:220] if content_col else ""
        if title or content:
            out.append({"title": title, "content": content, "day": day, "source": "财联社电报"})
    return out


def _fetch_em_news() -> list[dict]:
    """东财全球快讯：兼容新旧接口名，返回同样结构。"""
    f = _ak_func("stock_news_global_em", "stock_info_global_em")
    if not f:
        return []
    try:
        df = f()
    except Exception:  # noqa: BLE001
        return []
    if df is None or not len(df):
        return []
    cols = {str(c): c for c in df.columns}
    title_col = cols.get("标题")
    content_col = cols.get("摘要") or cols.get("内容")
    time_col = cols.get("发布时间") or cols.get("发布日期")
    out = []
    for _, r in df.iterrows():
        day = _normalize_day(r.get(time_col)) if time_col else ""
        title = str(r.get(title_col) or "")[:100] if title_col else ""
        content = str(r.get(content_col) or "")[:220] if content_col else ""
        if title or content:
            out.append({"title": title, "content": content, "day": day, "source": "东财快讯"})
    return out


def fetch_market_news(date: str, max_items: int = 12) -> str:
    """目标日已公开的财经快讯（财联社 + 东财），用于题材催化/分歧核验。

    ⚠️ 时间纪律：只保留发布日期 == date 的资讯，避免用复盘日之后才公开的
    新闻去"解释"当日盘面（未来函数）。当日无匹配时如实说明，不拿其它日期充数。
    返回结构化文本；两源都不可用返回降级说明。
    """
    target = str(date or "").strip()
    items = _fetch_cls_news() + _fetch_em_news()
    if not items:
        return "[财经快讯未取到：财联社/东财接口均不可用]"
    hit = [x for x in items if x["day"] == target]
    days = sorted({x["day"] for x in items if x["day"]})
    if not hit:
        window = f"{days[0]}~{days[-1]}" if len(days) >= 2 else (days[0] if days else "未知")
        return (f"[目标日 {target} 无已公开快讯；当前快讯窗口 {window}，"
                "按时间纪律不拿其它日期充数]")
    # 财联社优先，去重（同一标题只留一条）
    seen: set[str] = set()
    lines = []
    for x in hit:
        key = x["title"] or x["content"][:40]
        if key in seen:
            continue
        seen.add(key)
        lines.append(f"- [{x['source']}] {x['title']}：{x['content']}")
        if len(lines) >= max_items:
            break
    return ("目标日已公开财经快讯（只作事实线索，不保证与涨停归因存在因果）：\n"
            + "\n".join(lines))
