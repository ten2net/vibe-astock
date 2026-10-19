"""连板天梯与题材轮动:把已有的涨停池、昨日涨停池和涨停原因串换个摆法。

- 连板天梯(cn_shortline_board_ladder):某一天收盘时每个高度有哪些涨停股(首封时间、开板次数、题材),
  旁边摆上前一交易日低一档、今天没接上的票去了哪(炸板 / 跌停 / 没涨停,带当天涨跌幅)和这一档的晋级数。
  高标断板那一档今天没人,也留一行,免得最高标断了在图上看不出来。
- 题材轮动(cn_shortline_theme_rotation):近 N 个交易日每个事件题材每天几只涨停、当天排第几,
  连续几天有涨停、几天进了前三、是不是隔了几天又回来。

借鉴的是 GitHub 上几个 A 股短线看板(连板天梯、板块轮动 / 题材持续性页)的**展示思路**,代码没有照搬,
口径全部沿用本仓库:板位按东财连板数(反包票连板数是 1,标出「N天M板」),晋级按「昨天这一档的票今天还在涨停池里」,
题材按涨停原因串里的标签(滤掉国企改革、破净这类属性词),和情绪四项、题材事件树同一套数。

只摆已经发生的事实,不排名打分、不说哪个题材该不该做;状态词只由读数推出。
"""
from __future__ import annotations

import os
import sys
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources import shortline as S  # noqa: E402
from sources import shortline_themes as T  # noqa: E402

ROTATION_DAYS = (3, 10)
_ROTATION_TOP = 12
_ROTATION_FADED = 6
_FADED_MIN = 2


def _no_reason(zt: list[dict], reasons: dict) -> list[str]:
    """原因串取到了、但没有这只票的沪深涨停股。北交所同花顺不收录,不算缺(否则天天都是「部分」)。"""
    return [r["code"] for r in zt if r["code"] not in reasons and S.board_of(r["code"]) != "北交所"]


# ---------------------------------------------------------------- 连板天梯
def _stock(r: dict, reason: str) -> dict:
    stat, b = r.get("zt_stat"), int(r.get("boards") or 1)
    label = S.board_label(b, stat)
    return {
        "code": r["code"], "name": r["name"], "board": r["board"], "boards": b,
        # 「N天M板」= 中间断过(反包 / 回流),和一路连上来的分开标
        "label": label, "rebound": label != f"{b}板",
        "first_seal": r.get("first_seal") or None, "last_seal": r.get("last_seal") or None,
        "broken_times": int(r.get("broken_times") or 0), "seal_fund": r.get("seal_fund"), "amount": r.get("amount"),
        "float_cap": r.get("float_cap"), "turnover": r.get("turnover"), "reason": reason, "tags": T.tags_of(reason),
    }


def board_ladder(date: str, prev: Optional[str]) -> dict:
    """某一天的连板天梯。今天的池子取不到就整块不可用;前一天的池子取不到,只是「没接上的」和晋级数缺。"""
    p = S.pools(date)
    if p is None:
        return {"available": False, "reason": f"{date} 涨停池或炸板 / 跌停池没取到(或当天涨停池为空)"}
    zt, zb, dt = p["zt"], p["zb"], p["dt"]
    reasons, reason_note = T.limit_reasons(date)
    today = {r["code"]: r for r in zt}

    levels: dict[int, dict] = {}

    def level(h: int) -> dict:
        return levels.setdefault(h, {"boards": h, "stocks": [], "fell": [], "base": None, "promoted": None, "rate": None})

    for r in zt:   # 池子按首封时间升序取回:每一档里早封的在前
        level(int(r.get("boards") or 1))["stocks"].append(_stock(r, reasons.get(r["code"], "")))

    prev_zt = S.zt_pool(prev) if prev else None
    prev_note = ""
    if prev_zt is None:
        prev_note = f"前一交易日 {prev or '—'} 的涨停池没取到：没接上的票和晋级数没法算" if prev else "取不到前一交易日"
    else:
        # 没接上的票今天的涨跌幅:先用定稿记录(东财昨日涨停池,任何已收盘的日子都有),缺了再看炸板 / 跌停池里的行
        settled = {r["code"]: r.get("ret") for r in (S.settled_pool(date) or [])}
        zb_by = {r["code"]: r for r in zb}
        dt_by = {r["code"]: r for r in dt}
        for r in prev_zt:
            b = int(r.get("boards") or 1)
            lv = level(b + 1)
            lv["base"] = (lv["base"] or 0) + 1
            if r["code"] in today:
                lv["promoted"] = (lv["promoted"] or 0) + 1
                continue
            lv["promoted"] = lv["promoted"] or 0
            ret = settled.get(r["code"])
            if r["code"] in dt_by:
                outcome, ret = "跌停", ret if ret is not None else dt_by[r["code"]].get("ret")
            elif r["code"] in zb_by:
                outcome, ret = "炸板", ret if ret is not None else zb_by[r["code"]].get("ret")
            else:
                outcome = "没涨停" if ret is not None else "没取到"
            lv["fell"].append({"code": r["code"], "name": r["name"], "prev_boards": b,
                               "prev_label": S.board_label(b, r.get("zt_stat")), "outcome": outcome,
                               "ret": None if ret is None else round(float(ret), 2)})
        for lv in levels.values():
            if lv["base"]:
                lv["rate"] = round(lv["promoted"] / lv["base"], 3)
            lv["fell"].sort(key=lambda f: (f["ret"] is None, -(f["ret"] or 0)))

    rows = sorted(levels.values(), key=lambda lv: -lv["boards"])
    matched = sum(1 for r in zt if T.tags_of(reasons.get(r["code"], "")))
    return {
        "available": True, "levels": rows, "total_limit_up": len(zt),
        "highest": max((lv["boards"] for lv in rows if lv["stocks"]), default=0),
        "consec_count": sum(1 for r in zt if int(r.get("boards") or 1) >= 2),
        "prev_available": prev_zt is not None, "prev_note": prev_note,
        "reason_available": bool(reasons), "reason_covered": matched, "reason_note": reason_note,
        "reason_missing": _no_reason(zt, reasons) if reasons else [],
    }


def build_board_ladder(date: Optional[str] = None) -> dict:
    """端点 `cn_shortline_board_ladder` 的入口。"""
    d = S.review_day(date)
    prev = S.prev_trade_date(d)
    return {"date": d, "prev_date": prev, "settled": S.is_settled(d), "ladder": board_ladder(d, prev)}


def render_board_ladder(r: dict) -> str:
    lad = r.get("ladder") or {}
    if not lad.get("available"):
        return f"[连板天梯 {r.get('date')}：不可用（{lad.get('reason', '未知')}）]"
    head = (f"[连板天梯 {r['date']}｜涨停 {lad['total_limit_up']} 只，连板 {lad['consec_count']} 只，最高 {lad['highest']} 板"
            + (f"；题材串覆盖 {lad['reason_covered']}/{lad['total_limit_up']}" if lad["reason_available"] else "；涨停原因没取到")
            + "]")
    lines = [head]
    if lad.get("prev_note"):
        lines.append(lad["prev_note"])
    for lv in lad["levels"]:
        h = lv["boards"]
        seg = f"· {h}板 {len(lv['stocks'])} 只"
        if lv["base"]:
            seg += f"（{h - 1}进{h}：{lv['promoted']}/{lv['base']}）"
        names = "、".join(s["name"] + (f"[{s['label']}]" if s["rebound"] else "") for s in lv["stocks"][:12 if h > 1 else 8])
        if names:
            seg += "：" + names + (f" 等 {len(lv['stocks'])} 只" if len(lv["stocks"]) > (12 if h > 1 else 8) else "")
        if lv["fell"] and h > 2:   # 首板没接上的太多,只写 2 板以上的
            seg += "；没接上：" + "、".join(
                f"{f['name']}{f['outcome']}" + (f"{f['ret']:+.1f}%" if f["ret"] is not None else "") for f in lv["fell"][:6])
        lines.append(seg)
    return "\n".join(lines)


# ---------------------------------------------------------------- 题材轮动
def _day_tags(day: str) -> dict:
    """一天的 题材 → {只数, 最高板, 代表};池子或原因取不到 = 这天不可用(不是 0)。"""
    zt = S.zt_pool(day)
    if zt is None:
        return {"date": day, "available": False, "reason": f"{day} 东财涨停池没取到（东财这几张池只留约一个月）"}
    reasons, note = T.limit_reasons(day)
    if not reasons:
        return {"date": day, "available": False, "reason": f"{day} 涨停原因没取到（{note[:80]}）"}
    tags: dict[str, dict] = {}
    matched = 0
    for r in zt:
        ts = T.tags_of(reasons.get(r["code"], ""))
        if not ts:
            continue
        matched += 1
        b = int(r.get("boards") or 1)
        for t in ts:
            g = tags.setdefault(t, {"count": 0, "highest": 0, "members": []})
            g["count"] += 1
            g["highest"] = max(g["highest"], b)
            g["members"].append((b, r["name"]))
    ranked = sorted(tags, key=lambda t: (-tags[t]["count"], -tags[t]["highest"], t))
    for t, g in tags.items():
        g["rank"] = 1 + sum(1 for o in tags.values() if o["count"] > g["count"])   # 并列同名次
        g["members"] = [n for _, n in sorted(g["members"], key=lambda m: -m[0])[:3]]
    return {"date": day, "available": True, "limit_up": len(zt), "covered": matched, "tags": tags,
            "top": ranked[:3], "note": note, "unknown": len(_no_reason(zt, reasons))}


def _status(series: list[Optional[int]]) -> tuple[str, Optional[int], bool]:
    """(状态, 连续天数, 连续天数是不是下限)。series 按日期升序,None = 那天不可用。"""
    today = series[-1]
    if today is None:
        return "当天题材串没取到", None, False
    if today == 0:
        return "今天没有涨停", 0, False
    streak, partial = 0, False
    for v in reversed(series):
        if v is None:
            partial = True
            break
        if v == 0:
            break
        streak += 1
    else:   # 整个窗口天天有:窗口之前可能也有,天数是下限
        partial = True
    if streak >= 2:
        return f"连续 {streak} 天" + ("以上" if partial else ""), streak, partial
    earlier = series[:-1]
    if partial:   # 昨天不可用:新出现还是延续说不清
        return "昨天缺数，新旧不确定", 1, True
    last = max((i for i, v in enumerate(earlier) if v), default=None)
    if last is not None:
        between = earlier[last + 1:]
        if any(v is None for v in between):   # 中间有一天缺数:隔了几天说不准
            return "回流（中间有缺数，隔几天说不准）", 1, False
        return f"隔 {len(between)} 天回流", 1, False
    if any(v is None for v in earlier):
        return "窗口内前几天有缺数，不确定是不是新出现", 1, True
    return "窗口内首次出现", 1, False


def theme_rotation(date: str, days: int) -> dict:
    if not S.is_settled(date):
        return {"available": False, "reason": f"{date} 还没收盘：题材轮动按收盘后的涨停池算，收盘后再看"}
    dates = S.trade_dates_ending_at(date, days)
    if not dates or dates[-1] != date:
        return {"available": False, "reason": f"交易日历里排不出截至 {date} 的近 {days} 个交易日"}
    per = [_day_tags(d) for d in dates]
    if not per[-1]["available"]:
        return {"available": False, "reason": per[-1]["reason"], "days": [_day_head(x) for x in per]}
    names = {t for x in per if x["available"] for t in x["tags"]}

    def cell(x: dict, t: str, key: str) -> Optional[int]:
        """这天这个题材的读数;这天不可用,或有沪深涨停股缺原因(没出现不代表没有)= None,不当 0。"""
        if not x["available"]:
            return None
        g = x["tags"].get(t)
        if g:
            return g[key]
        return None if x["unknown"] or key == "rank" else 0

    themes = []
    for t in names:
        series = [cell(x, t, "count") for x in per]
        ranks = [cell(x, t, "rank") for x in per]
        highs = [cell(x, t, "highest") for x in per]
        status, streak, streak_partial = _status(series)
        known = [v for v in series if v is not None]
        today = per[-1]["tags"].get(t) or {}
        themes.append({
            "tag": t, "series": series, "ranks": ranks, "highest": highs, "today": series[-1] or 0,
            "total": sum(known), "active_days": sum(1 for v in known if v), "top3_days": sum(1 for r in ranks if r is not None and r <= 3),
            "streak": streak, "streak_partial": streak_partial, "status": status,
            "first_day": next((d for d, v in zip(dates, series) if v), None), "members": today.get("members", []),
        })
    themes.sort(key=lambda x: (-x["today"], -x["total"], -max((h or 0) for h in x["highest"]), x["tag"]))
    active = [x for x in themes if x["today"]][:_ROTATION_TOP]
    prev_day = per[-2] if len(per) >= 2 else None
    # 昨天至少 2 只、今天一只都没有的,按昨天的只数补几行:退下来的题材也要看得见(昨天只有 1 只的太多,不补)
    # 今天确定是 0 才算退下去(今天有票缺原因的,没出现的题材是 None,不补)
    faded = sorted((x for x in themes if x["series"][-1] == 0 and len(x["series"]) >= 2 and (x["series"][-2] or 0) >= _FADED_MIN),
                   key=lambda x: (-(x["series"][-2] or 0), x["tag"]))[:_ROTATION_FADED]
    missing = [x["date"] for x in per if not x["available"]]
    return {
        "available": True, "dates": dates, "days": [_day_head(x) for x in per], "themes": active + faded,
        "tag_count": len(themes), "missing_days": missing,
        "partial_days": [x["date"] for x in per if x["available"] and x["unknown"]],
        "prev_available": bool(prev_day and prev_day["available"]),
    }


def _day_head(x: dict) -> dict:
    if not x["available"]:
        return {"date": x["date"], "available": False, "reason": x["reason"]}
    return {"date": x["date"], "available": True, "limit_up": x["limit_up"], "covered": x["covered"], "top": x["top"], "unknown": x["unknown"]}


def build_theme_rotation(date: Optional[str] = None, days: int = 5) -> dict:
    """端点 `cn_shortline_theme_rotation` 的入口。"""
    d = S.review_day(date)
    n = int(days)
    if not ROTATION_DAYS[0] <= n <= ROTATION_DAYS[1]:
        raise ValueError(f"days 要在 {ROTATION_DAYS[0]}–{ROTATION_DAYS[1]} 之间")
    return {"date": d, "days": n, "settled": S.is_settled(d), "rotation": theme_rotation(d, n)}


def render_theme_rotation(r: dict) -> str:
    rot = r.get("rotation") or {}
    if not rot.get("available"):
        return f"[题材轮动 {r.get('date')}：不可用（{rot.get('reason', '未知')}）]"
    dates = rot["dates"]
    lines = [f"[题材轮动 {dates[0]}～{dates[-1]}（{len(dates)} 个交易日）｜按涨停原因标签归组，格子里是当天涨停只数]"]
    if rot["missing_days"]:
        lines.append("这几天题材串或涨停池没取到，按缺数处理（不是 0）：" + "、".join(rot["missing_days"]))
    if rot.get("partial_days"):
        lines.append("这几天有沪深涨停股没有涨停原因，那天没出现的题材按缺数处理、出现的只数是下限：" + "、".join(rot["partial_days"]))
    for day in rot["days"]:
        if day["available"]:
            lines.append(f"· {day['date']} 涨停 {day['limit_up']} 只，前三：{'、'.join(day['top']) or '—'}")
    for t in rot["themes"]:
        cells = " ".join("—" if v is None else str(v) for v in t["series"])
        lines.append(f"· {t['tag']}［{t['status']}］{cells}；{t['active_days']} 天有涨停，{t['top3_days']} 天进前三")
    return "\n".join(lines)
