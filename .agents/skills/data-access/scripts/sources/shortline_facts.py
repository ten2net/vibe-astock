"""短线盘面事实表:封板质量、亏钱效应、昨日强势股反馈、题材结构、关键事件、分制度生态。

复盘要回答的是「今天发生了什么」,不是「明天买什么」。
移植自 Vibe AStock v2.0.0 的 duanxian/market_facts.py,算法与口径不变;池子、交易日历、涨跌幅制度改用 `sources.shortline`
(主板 ST 按 2026-07-06 起的 10% 判跌停)。端点 `cn_shortline_facts` 的入口是 `build_facts`。
"""
from __future__ import annotations

import os
import sys
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources import shortline as S  # noqa: E402
from sources.shortline_emotion import COVERAGE_MIN, coverage  # noqa: E402

RESULT_ORDER = ["晋级涨停", "收红", "小跌", "跌超5%", "跌停"]


def seal_quality(date: str) -> dict:
    """今日涨停股的封板质量:什么时候封的、封稳了没、炸过几次。同样是涨停,开盘秒板没炸过和炸了 6 次尾盘回封是两回事。"""
    p = S.pools(date)
    if p is None:
        return {"available": False, "reason": f"{date} 涨停池取数失败"}
    zt, zb = p["zt"], p["zb"]
    never_broken = [r for r in zt if not (r.get("broken_times") or 0)]
    seconds = [r for r in zt if r.get("first_seal") and r["first_seal"] <= "093500"]
    late = [r for r in zt if r.get("last_seal") and r["last_seal"] >= "143000"]
    reopened = [r for r in zt if (r.get("broken_times") or 0) >= 1]
    return {
        "available": True, "total": len(zt),
        # 一次没炸过 = 板最硬;炸过又回封的越多,说明分歧越大
        "never_broken": len(never_broken), "never_broken_rate": round(len(never_broken) / len(zt), 3),
        "opening_seconds": len(seconds),       # 开盘 5 分钟内首封
        "late_seal": len(late),                # 14:30 后才最终封住(含反复炸板后回封)
        "reopened": len(reopened),             # 炸过至少一次但最终封住
        "avg_broken_times": round(sum((r.get("broken_times") or 0) for r in zt) / len(zt), 2),
        "broken_pool": len(zb),
        "broken_rate": round(len(zb) / (len(zt) + len(zb)), 3),
        # 涨停股里盘中开过板的比例 —— 不是炸板率,别混用
        "ever_opened_rate": round(len(reopened) / len(zt), 3),
    }


def loss_effect(date: str, prev: Optional[str] = None) -> dict:
    """亏钱效应 —— 昨日强势股今天死在哪(定稿记录优先,实时行情兜底)。"""
    prev = prev or S.prev_trade_date(date)
    rows = S.settled_pool(date)
    if rows:
        got = [r for r in rows if r.get("ret") is not None]
        if got:
            n = len(got)
            deep5 = [r for r in got if r["ret"] <= -5]
            today = S.pools(date)
            return {
                "available": True, "prev_date": prev, "source": "settled", **S.settled_cov(date, n),
                "deep_loss_5_count": len(deep5), "deep_loss_5_rate": round(len(deep5) / n, 3),
                "deep_loss_7_count": sum(1 for r in got if r["ret"] <= -7),
                # 定稿记录没有跌停价,按各自制度的跌幅上限判
                "limit_down_count": sum(1 for r in got if S.is_limit_down_row(r, date)),
                "worst": round(min(r["ret"] for r in got), 2),
                "market_limit_down": len(today["dt"]) if today is not None else None,
                "prev_broken_recovery": None,   # 需要昨日炸板股,定稿记录不含
                "note": "昨日强势股由定稿记录算；全市场跌停另取所选日东财池。昨日炸板股修复未覆盖。" + (" 所选日跌停池未获取。" if today is None else ""),
            }

    ok, why = S.live_quotes_are_close_of(date)
    if not ok:
        return {"available": False, "reason": why}
    if not prev:
        return {"available": False, "reason": "取不到前一交易日"}
    pp, tp = S.pools(prev), S.pools(date)
    if pp is None or tp is None:
        return {"available": False, "reason": f"涨停池取数失败（{prev} 或 {date}）"}
    codes = [r["code"] for r in pp["zt"]]
    pct = S.batch_pct(codes, date)
    pairs = [(r, pct[r["code"]]) for r in pp["zt"] if r["code"] in pct]
    if not pairs:
        return {"available": False, "reason": "批量行情全部取数失败"}
    cov = coverage([v for _, v in pairs], len(codes))
    if cov["coverage_rate"] is not None and cov["coverage_rate"] < COVERAGE_MIN:
        return {"available": False, "reason": f"批量行情只取到 {len(pairs)}/{len(codes)} 只（{cov['coverage_rate']:.0%}），样本不足以代表全体", **cov}
    today_dt = {r["code"] for r in tp["dt"]}
    n = len(pairs)
    deep5 = [r for r, v in pairs if v <= -5]
    # 昨日炸板股今天修复没有 —— 昨日炸板今天能涨,说明试错代价低、容错在恢复
    zb_vals = list(S.batch_pct([r["code"] for r in pp["zb"]], date).values()) if pp["zb"] else []
    return {
        "available": True, "prev_date": prev, **cov, "source": "live", "sample": n,
        "deep_loss_5_count": len(deep5), "deep_loss_5_rate": round(len(deep5) / n, 3),
        "deep_loss_7_count": sum(1 for _, v in pairs if v <= -7),
        "limit_down_count": sum(1 for r, _ in pairs if r["code"] in today_dt),
        "worst": round(min(v for _, v in pairs), 2),
        "market_limit_down": len(tp["dt"]),   # 今日全市场跌停家数(不限于昨日涨停股)
        "prev_broken_recovery": ({"sample": len(zb_vals), "avg": round(sum(zb_vals) / len(zb_vals), 2),
                                  "positive_rate": round(sum(1 for v in zb_vals if v > 0) / len(zb_vals), 3)} if zb_vals else None),
    }


def _result(ret: float, promoted: Optional[bool], limit_down: bool) -> str:
    if promoted:
        return "晋级涨停"
    if limit_down:
        return "跌停"
    if ret <= -5:
        return "跌超5%"
    return "收红" if ret > 0 else "小跌"


def _tier(boards: int) -> str:
    # 板位写具体高度(3板/4板/…),不笼统归成「3板及以上」
    if boards <= 0:
        return "昨日炸板"
    return "首板" if boards == 1 else f"{boards}板"


def _finish_matrix(matrix: dict[str, dict]) -> None:
    for cell in matrix.values():
        base = sum(cell.values())
        cell["合计"] = base
        cell["晋级率"] = round(cell["晋级涨停"] / base, 3) if base else None


def feedback_matrix(date: str, prev: Optional[str] = None) -> dict:
    """昨日强势股反馈矩阵:按昨日板位分组,看今天各落到什么结果。定稿记录优先(⚠️ 不含昨日炸板股,那一档会缺,如实写进 note)。"""
    prev = prev or S.prev_trade_date(date)
    srows = S.settled_pool(date)
    if srows:
        got = [r for r in srows if r.get("ret") is not None]
        if got:
            zt_rows = S.zt_pool(date)
            today_codes = {r["code"] for r in zt_rows} if zt_rows is not None else None
            matrix: dict[str, dict] = {}
            details: list[dict] = []
            for r in got:
                b = int(r.get("prev_boards") or 1)
                t = _tier(b)
                promoted = r["code"] in today_codes if today_codes is not None else S.is_limit_up_row(r, date)
                res = _result(r["ret"], promoted, S.is_limit_down_row(r, date))
                matrix.setdefault(t, {k: 0 for k in RESULT_ORDER})[res] += 1
                details.append({"code": r["code"], "name": r["name"], "board": b, "prev_tier": t, "ret": round(r["ret"], 2),
                                "result": res, "sector": r.get("sector") or ""})
            _finish_matrix(matrix)
            details.sort(key=lambda d: d["ret"])
            return {
                "available": True, "prev_date": prev, "source": "settled", **S.settled_cov(date, len(details)), "result_order": RESULT_ORDER, "matrix": matrix, "details": details,
                "note": ("涨跌幅取昨日强势股当日记录；晋级以本次东财涨停池成员为准。记录不含昨日炸板股，故缺「昨日炸板」这一档。" if today_codes is not None
                         else "本次涨停池未取得，晋级仅按收盘价推定，不能与池成员晋级率直接比较；昨日炸板股未覆盖。"),
            }

    ok, why = S.live_quotes_are_close_of(date)
    if not ok:
        return {"available": False, "reason": why}
    if not prev:
        return {"available": False, "reason": "取不到前一交易日"}
    pp, tp = S.pools(prev), S.pools(date)
    if pp is None or tp is None:
        return {"available": False, "reason": f"涨停池取数失败（{prev} 或 {date}）"}
    today_zt = {r["code"] for r in tp["zt"]}
    today_dt = {r["code"] for r in tp["dt"]}
    rows = pp["zt"] + [dict(r, boards=0) for r in pp["zb"]]   # 昨日炸板股单列一档
    pct = S.batch_pct([r["code"] for r in rows], date)
    cov = coverage(list(pct.values()), len(rows))
    if cov["coverage_rate"] is not None and cov["coverage_rate"] < COVERAGE_MIN:
        return {"available": False, "reason": f"批量行情只取到 {cov['sample']}/{len(rows)} 只（{cov['coverage_rate']:.0%}），矩阵会失真", **cov}
    matrix = {}
    details = []
    for r in rows:
        v = pct.get(r["code"])
        if v is None:
            continue
        t = _tier(int(r.get("boards") or 0))
        res = _result(v, r["code"] in today_zt, r["code"] in today_dt)
        matrix.setdefault(t, {k: 0 for k in RESULT_ORDER})[res] += 1
        details.append({"code": r["code"], "name": r["name"], "board": r["board"], "prev_tier": t, "ret": round(v, 2),
                        "result": res, "sector": r.get("sector") or ""})
    if not details:
        return {"available": False, "reason": "批量行情全部取数失败"}
    _finish_matrix(matrix)
    # 明细按今日结果从差到好排:复盘先看死在哪,不是先看谁涨得好
    return {"available": True, "prev_date": prev, **cov, "source": "live", "result_order": RESULT_ORDER, "matrix": matrix,
            "details": sorted(details, key=lambda d: d["ret"])}


_SLOTS = [("09:25-09:35", "093500"), ("09:35-10:00", "100000"), ("10:00-11:30", "113000"), ("11:30-14:00", "140000"), ("14:00-15:00", "150500")]


def theme_structure(date: str, top: int = 8) -> dict:
    """今日题材结构:每个题材几个板、最高几板、炸了几个、几点开始发酵。题材按东财所属行业归。"""
    p = S.pools(date)
    if p is None:
        return {"available": False, "reason": f"{date} 涨停池取数失败"}
    zt, zb = p["zt"], p["zb"]
    groups: dict[str, dict] = {}
    for r in zt:
        s = (r.get("sector") or "").strip() or "未分类"
        g = groups.setdefault(s, {"sector": s, "limit_up": 0, "first_boards": 0, "consec_boards": 0, "highest": 0, "broken": 0,
                                  "seal_times": [], "names": []})
        g["limit_up"] += 1
        b = int(r.get("boards") or 1)
        g["highest"] = max(g["highest"], b)
        g["first_boards" if b <= 1 else "consec_boards"] += 1
        if r.get("first_seal"):
            g["seal_times"].append(r["first_seal"])
        g["names"].append({"code": r["code"], "name": r["name"], "boards": b, "first_seal": r.get("first_seal") or "",
                           "broken_times": r.get("broken_times") or 0})
    for r in zb:   # 炸板股算进所属题材的炸板数
        s = (r.get("sector") or "").strip() or "未分类"
        if s in groups:
            groups[s]["broken"] += 1
    themes = []
    for g in groups.values():
        ts = sorted(g.pop("seal_times"))
        attempts = g["limit_up"] + g["broken"]
        g["first_seal"] = ts[0] if ts else None    # 该题材第一只涨停的时间
        g["last_seal"] = ts[-1] if ts else None    # 最后一只 —— 两者拉开 = 持续发酵
        g["broken_rate"] = round(g["broken"] / attempts, 3) if attempts else None
        g["names"] = sorted(g["names"], key=lambda x: -x["boards"])[:6]
        themes.append(g)
    themes.sort(key=lambda g: (-g["limit_up"], -g["highest"]))

    # 全市场涨停的时间分布 —— 早盘集中 vs 尾盘补涨,含义完全不同
    times = sorted(r["first_seal"] for r in zt if r.get("first_seal"))
    timeline, lo = [], "000000"
    for label, hi in _SLOTS:
        timeline.append({"slot": label, "count": sum(1 for t in times if lo < t <= hi)})
        lo = hi
    return {
        "available": True, "themes": themes[:top], "theme_count": len(themes),
        # 头部集中度:第一题材占全市场涨停的比例,越高越是一枝独秀
        "concentration": round(themes[0]["limit_up"] / len(zt), 3) if themes else None,
        "timeline": timeline,
    }


# 「调用方没传前一交易日涨停池」和「传了、但没取到(None)」要分开
_UNSET: Any = object()


def _prev_pool(prev: Optional[str], prev_zt: Any) -> Optional[list[dict]]:
    """前一交易日涨停池:调用方传了就用传的(build_facts 只取一次、几张表共用),没传自己取。None = 没取到。"""
    if prev_zt is not _UNSET:
        return prev_zt
    return S.zt_pool(prev) if prev else None


_LOSS = {"高位断板", "连板断板", "炸板", "高标跌停", "跌停"}
_GAIN = {"最高标", "题材首封"}


def event_ledger(date: str, prev: Optional[str] = None, prev_zt: Any = _UNSET) -> dict:
    """关键事件账本:今天真正值得看的那十几只票,自动挑出来。"""
    p = S.pools(date)
    if p is None:
        return {"available": False, "reason": f"{date} 涨停池取数失败"}
    zt, zb, dt = p["zt"], p["zb"], p["dt"]
    prev = prev or S.prev_trade_date(date)
    prev_rows = _prev_pool(prev, prev_zt)
    # 🔴 前一交易日涨停池没取到 ≠ 昨天都没涨停:不写「昨日未涨停」,也不出要靠昨日板数的标签(高位断板 / 连板断板 / 高标跌停)
    prev_ok = prev_rows is not None
    prev_boards = {r["code"]: int(r.get("boards") or 1) for r in prev_rows or []}
    unknown = "（昨日板数未取得）"
    events: list[dict] = []

    def add(tag: str, r: dict, note: str = "") -> None:
        events.append({"tag": tag, "code": r["code"], "name": r["name"], "board": r["board"], "boards": int(r.get("boards") or 0),
                       "sector": r.get("sector") or "", "ret": None if r.get("ret") is None else round(float(r["ret"]), 2),   # 缺涨跌幅留空,不写 0.00%
                       "first_seal": r.get("first_seal") or None, "last_seal": r.get("last_seal") or None,
                       "broken_times": int(r.get("broken_times") or 0), "turnover": r.get("turnover"), "note": note,
                       # 昨天几板 —— 断板事件的意义全在这个数上
                       "prev_boards": prev_boards.get(r["code"])})

    if zt:
        top = max(int(r.get("boards") or 1) for r in zt)
        for r in zt:
            if int(r.get("boards") or 1) == top:
                add("最高标", r, f"今日最高 {top} 板")
        for r in sorted(zt, key=lambda x: -(x.get("broken_times") or 0))[:3]:   # 反复炸板又回封 —— 分歧最大
            if (r.get("broken_times") or 0) >= 2:
                add("反复开板", r, f"炸板 {r['broken_times']} 次后回封")
        seen: set[str] = set()
        for r in sorted(zt, key=lambda x: x.get("first_seal") or "999999"):   # 每个题材最早封板的那只 = 该方向的发起者
            s = (r.get("sector") or "").strip()
            if s and s not in seen and r.get("first_seal"):
                seen.add(s)
                add("题材首封", r, f"{s} 当日最早封板")
            if len(seen) >= 4:
                break
    for r in sorted(zb, key=lambda x: (-(prev_boards.get(x["code"]) or 0), -(x.get("broken_times") or 0)))[:6]:
        pb = prev_boards.get(r["code"])
        if pb and pb >= 3:
            add("高位断板", r, f"昨日 {pb} 板，今日炸板未回封（炸 {r.get('broken_times') or 0} 次）")
        elif pb and pb >= 2:
            add("连板断板", r, f"昨日 {pb} 板，今日炸板未回封")
        else:
            add("炸板", r, f"炸板 {r.get('broken_times') or 0} 次未回封" + (f"，昨日 {pb} 板" if pb else "（昨日未涨停）" if prev_ok else unknown))
    # 大面:昨日是高标的今天跌停,比普通跌停更值得记
    for r in sorted(dt, key=lambda x: (-(prev_boards.get(x["code"]) or 0), -(x.get("consec_dt") or 0)))[:5]:
        pb = prev_boards.get(r["code"])
        add("高标跌停" if (pb and pb >= 2) else "跌停", r, f"连续跌停 {int(r.get('consec_dt') or 1)} 天" + (f"｜昨日 {pb} 板" if pb else "" if prev_ok else unknown))
    return {
        "available": True, "events": events, "count": len(events), "prev_date": prev, "prev_available": prev_ok,
        "loss_events": [e for e in events if e["tag"] in _LOSS],
        "gain_events": [e for e in events if e["tag"] in _GAIN],
        # 「反复开板」既不是纯赚也不是纯亏 —— 它是分歧,单独一堆
        "split_events": [e for e in events if e["tag"] not in _LOSS | _GAIN],
    }


def by_board(date: str, prev: Optional[str] = None, prev_zt: Any = _UNSET) -> dict:
    """按涨跌幅制度拆开看:10cm / 20cm / 北交所 / 主板 ST 各自的涨停与晋级生态。"""
    prev = prev or S.prev_trade_date(date)
    tp = S.pools(date)
    if tp is None:
        return {"available": False, "reason": f"{date} 涨停池取数失败"}
    prev_zt = _prev_pool(prev, prev_zt)
    today_codes = {r["code"] for r in tp["zt"]}
    out: dict[str, dict] = {}

    def group(b: str) -> dict:
        return out.setdefault(b, {"limit_up": 0, "highest": 0, "prev_base": 0, "promoted": 0, "broken": 0, "limit_down": 0})

    for r in tp["zt"]:
        g = group(r["board"])
        g["limit_up"] += 1
        g["highest"] = max(g["highest"], int(r.get("boards") or 1))
    # 🔴 炸板 / 跌停按行累加到各自制度,**不能**只给今天有涨停的制度算:
    #    VA 原版先建涨停的分组再数炸板,当天没有涨停的制度(实测 2026-10-09 北交所:0 涨停、1 炸板)炸板数恒为 0
    for r in tp["zb"]:
        group(r["board"])["broken"] += 1
    for r in tp["dt"]:
        group(r["board"])["limit_down"] += 1
    for r in prev_zt or []:
        g = group(r["board"])
        g["prev_base"] += 1
        if r["code"] in today_codes:
            g["promoted"] += 1
    for g in out.values():
        g["promotion_rate"] = round(g["promoted"] / g["prev_base"], 3) if g["prev_base"] else None
    note = "按 2026-07-06 起施行的交易规则：主板 ST 涨跌幅 10%" if S.iso(date) >= S.ST_10PCT_FROM else "主板 ST 当时涨跌幅 5%"
    if prev_zt is None:
        # 前一交易日涨停池没取到 ≠ 前一天没有涨停:晋级这一列整列不可用,说出来
        note += "；前一交易日涨停池未取得，晋级未算"
    return {"available": True, "prev_date": prev, "prev_available": prev_zt is not None, "boards": out, "note": note}


def build_facts(date: Optional[str] = None) -> dict:
    """六张事实表一起算(共用同一个前一交易日和池子)。"""
    d = S.review_day(date)
    prev = S.prev_trade_date(d)
    # 关键事件和分制度都要前一交易日涨停池:只取一次、两张表共用,免得一次没取到、一次取到,两张表说法不一
    prev_zt = S.zt_pool(prev) if prev else None
    return {
        "date": d, "prev_date": prev, "settled": S.is_settled(d),
        "seal_quality": seal_quality(d),
        "loss_effect": loss_effect(d, prev),
        "feedback": feedback_matrix(d, prev),
        "themes": theme_structure(d),
        "events": event_ledger(d, prev, prev_zt),
        "by_board": by_board(d, prev, prev_zt),
    }


# ---------------------------------------------------------------- 给模型看的文字
def _pct(v: Optional[float]) -> str:
    return "—" if v is None else f"{v:.0%}"


def _hm(t: Optional[str]) -> str:
    return f"{t[:2]}:{t[2:4]}" if t and len(t) >= 4 else "—"


def render_facts(f: dict) -> str:
    """六张事实表的文字版(Agent 复盘读)。不可用的如实写原因;明细留在结构化结果里,这里只写结论性的数。"""
    date, prev = f.get("date", ""), f.get("prev_date") or "—"
    lines = [f"[盘面事实 {date}｜对照前一交易日 {prev}]"]

    def na(title: str, d: dict) -> None:
        lines.append(f"· {title}：不可用（{d.get('reason', '未知')}）")

    sq = f.get("seal_quality") or {}
    if sq.get("available"):
        lines.append(f"· 封板质量：涨停 {sq['total']} 家，一次没炸过 {sq['never_broken']} 家（{_pct(sq['never_broken_rate'])}），"
                     f"09:35 前首封（含竞价一字）{sq['opening_seconds']} 家，14:30 后才封住 {sq['late_seal']} 家；"
                     f"炸板池 {sq['broken_pool']} 家，炸板率 {_pct(sq['broken_rate'])}")
    else:
        na("封板质量", sq)

    le = f.get("loss_effect") or {}
    if le.get("available"):
        mkt = le.get("market_limit_down")
        lines.append(f"· 亏钱效应：{prev} 涨停的 {le['sample']} 只里，跌超 5% {le['deep_loss_5_count']} 只、跌停 {le['limit_down_count']} 只，"
                     f"最差 {le['worst']:+.2f}%；全市场跌停 {mkt if mkt is not None else '未取得'} 家")
    else:
        na("亏钱效应", le)

    fb = f.get("feedback") or {}
    if fb.get("available"):
        order = fb.get("result_order") or RESULT_ORDER
        cells = []
        for tier, cell in sorted((fb.get("matrix") or {}).items(), key=lambda kv: _tier_rank(kv[0])):
            parts = "、".join(f"{k}{cell[k]}" for k in order if cell.get(k))
            cells.append(f"{tier} {cell['合计']} 只（{parts}）")
        lines.append("· 昨日强势股今天：" + ("；".join(cells) or "无样本"))
    else:
        na("昨日强势股反馈", fb)

    th = f.get("themes") or {}
    if th.get("available"):
        top = "；".join(f"{t['sector']} {t['limit_up']} 家、最高 {t['highest']} 板、首封 {_hm(t.get('first_seal'))}" for t in (th.get("themes") or [])[:5])
        lines.append(f"· 题材：共 {th['theme_count']} 个方向有涨停，第一方向占全部涨停 {_pct(th.get('concentration'))}。{top}")
    else:
        na("题材结构", th)

    ev = f.get("events") or {}
    if ev.get("available"):
        items = "；".join(f"{e['tag']} {e['name']}：{e['note']}" for e in (ev.get("events") or [])[:12])
        lines.append(f"· 关键事件 {ev['count']} 条：{items or '无'}")
    else:
        na("关键事件", ev)

    bb = f.get("by_board") or {}
    if bb.get("available"):
        # 前一交易日涨停池没取到时晋级写「—」,不写 0/0
        promo = (lambda g: f"晋级 {g['promoted']}/{g['prev_base']}") if bb.get("prev_available", True) else (lambda g: "晋级 —")
        segs = "；".join(f"{b} 涨停 {g['limit_up']}、炸板 {g['broken']}、跌停 {g['limit_down']}、{promo(g)}"
                        for b, g in (bb.get("boards") or {}).items())
        lines.append(f"· 分制度：{segs}。{bb.get('note', '')}")
    else:
        na("分制度生态", bb)
    return "\n".join(lines)


def _tier_rank(tier: str) -> int:
    """反馈矩阵的档位排序:昨日炸板 → 首板 → 2板 → 3板 …"""
    if tier == "昨日炸板":
        return 0
    if tier == "首板":
        return 1
    try:
        return int(tier.rstrip("板"))
    except ValueError:
        return 99
