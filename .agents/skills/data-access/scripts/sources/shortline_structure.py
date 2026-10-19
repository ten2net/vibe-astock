"""涨停结构:当天涨停池的制度构成、最高标,以及四张池子的上游原始字段清单。

移植自 Vibe AStock v2.0.0 duanxian/drift.py 的 `_day_structure`、archive.py 的字段清单和 weekly.py 的「每日最高标」,改了三处:
- 制度构成按**那一天**的涨跌幅规则归类(创业板 2020-08-24 前算 10%、主板 ST 按当天 5% / 10%)。VA 用归档时写下的
  board 字段,老归档缺字段时回退现行规则 —— 正是它自己要检测的「拿新规则解释旧数据」。
- 字段清单直接记上游原始行的键(含 zttj 的子键),不靠归档;池子为空时记「不知道」,不当成字段变了。
- 归档换成端点快照:已收盘的日子长期缓存,东财只留一个月左右,历史靠缓存越积越长。

端点 `cn_shortline_structure`,约 4 次东财请求(涨停 / 炸板 / 跌停 / 昨日涨停池)。界面视图「结构变化」和「近 5 天热度」
按日扇出调用它。
"""
from __future__ import annotations

import os
import sys
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources import shortline as S  # noqa: E402

# 四张池子:端点里的键 → 显示名
POOLS = {"zt": "涨停池", "zb": "炸板池", "dt": "跌停池", "yzt": "昨日涨停池"}
# 最高标最多列几只(最高只有 1 板的日子,整个涨停池都是「最高标」)
LEADERS_MAX = 5
# 制度构成的三类:按当天涨跌幅上限归
MIX = ("20%", "10%", "北交所")


def mix_of(code: Any, name: Any, day: str) -> str:
    """这只票在 `day` 属于哪一类:北交所 / 20% / 10%(含主板 ST 的 5%)。"""
    if S.board_of(code, name) == "北交所":
        return "北交所"
    return "20%" if S.limit_pct(code, name, day) >= 20 else "10%"


def _fields(kind: str, d: str) -> tuple[Optional[list[str]], str]:
    """一张池子的原始字段清单;(None, 原因) = 这天看不出来。"""
    try:
        if kind == "yzt":
            if not S.settled_pool(d):
                return None, "没取到(或为空)"
        else:
            S.pool(kind, d)
    except Exception as exc:  # noqa: BLE001  取不到就是取不到
        return None, f"没取到({type(exc).__name__})"
    f = S.raw_fields(kind, d)
    return (f, "") if f else (None, "池子为空,看不出字段")


def build_structure(date: Optional[str] = None) -> dict:
    """端点 `cn_shortline_structure` 的入口。

    ⚠️ 最高标按东财连板数(lbc);同高的多只按首封时间排、最多列 5 只,总数另给。
    ⚠️ 字段清单只说明上游这天回了哪些键,不说明值的口径有没有变。
    """
    d = S.review_day(date)
    base: dict = {"date": d, "settled": S.is_settled(d)}
    try:
        zt = S.pool("zt", d)
    except Exception as exc:  # noqa: BLE001
        return {**base, "available": False, "reason": f"东财涨停池没取到({type(exc).__name__})"}
    if not zt:
        return {**base, "available": False, "reason": "东财涨停池为空(数据还没出,或超过东财保留期)"}

    n = len(zt)
    mix = {k: 0 for k in MIX}
    for r in zt:
        mix[mix_of(r["code"], r.get("name"), d)] += 1
    highest = max(int(r.get("boards") or 1) for r in zt)
    tops = sorted((r for r in zt if int(r.get("boards") or 1) == highest), key=lambda r: (r.get("first_seal") or "999999", r["code"]))
    leaders = [{"code": r["code"], "name": r.get("name") or "", "boards": highest, "sector": r.get("sector") or "",
                "first_seal": r.get("first_seal") or "", "zt_stat": r.get("zt_stat") or ""} for r in tops[:LEADERS_MAX]]

    fields: dict[str, Optional[list[str]]] = {}
    unknown: dict[str, str] = {}
    for kind in POOLS:
        f, why = _fields(kind, d)
        fields[kind] = f
        if f is None:
            unknown[kind] = why
    return {**base, "available": True, "limit_up": n, "mix": mix,
            "share_20cm": round(mix["20%"] / n, 4), "share_10cm": round(mix["10%"] / n, 4), "share_bj": round(mix["北交所"] / n, 4),
            "highest_board": highest, "leader_total": len(tops), "leaders": leaders, "fields": fields, "fields_unknown": unknown}


def render_structure(d: dict) -> str:
    """一行概览。"""
    day = d.get("date", "")
    if not d.get("available"):
        return f"[涨停结构 {day}] 不可用（{d.get('reason', '未知')}）"
    mix = d.get("mix") or {}
    names = "、".join(x["name"] or x["code"] for x in d.get("leaders") or [])
    more = d.get("leader_total", 0) - len(d.get("leaders") or [])
    lead = f"最高 {d.get('highest_board')} 板：{names}" + (f" 等 {d.get('leader_total')} 只" if more > 0 else "")
    seen = [f"{POOLS[k]} {len(v)} 个" for k, v in (d.get("fields") or {}).items() if v]
    return (f"[涨停结构 {day}｜涨停 {d.get('limit_up')} 只] 20% 制度 {mix.get('20%', 0)} 只、10% 制度 {mix.get('10%', 0)} 只、"
            f"北交所 {mix.get('北交所', 0)} 只；{lead}；上游字段 {'、'.join(seen) or '都没看到'}（按当天涨跌幅规则归类）")
