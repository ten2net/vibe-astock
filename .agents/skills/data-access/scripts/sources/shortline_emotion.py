"""短线情绪指标:赚钱效应、晋级率、连板溢价、梯队断层、情绪周期。

移植自 Vibe AStock v2.0.0 的 duanxian/emotion_metrics.py,算法与口径不变;池子和交易日历改用 `sources.shortline`。
两个端点:`cn_shortline_emotion`(当天四项)和 `cn_shortline_cycle`(要拉十天涨停 / 炸板池,最慢,单独一个端点,
让页面先出当天四项)。
"""
from __future__ import annotations

import os
import sys
from statistics import mean, median
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources import shortline as S  # noqa: E402

# 行情覆盖率闸门。批量行情半死不活时只回来几只票,若照样出结论,就是拿 3 只票的表现冒充全体赚钱效应 ——
# 数字看着完全正常,是最难发现的一类错。只在定稿记录取不到、退回实时行情时用得上。
COVERAGE_MIN = 0.5      # 低于此:判定不可用,如实说取不到
COVERAGE_PARTIAL = 0.9  # 低于此:可用但标 partial,提示样本不全


def _codes(rows: Optional[list[dict]]) -> Optional[set[str]]:
    return None if rows is None else {r["code"] for r in rows}


def _ladder(rows: list[dict]) -> list[dict]:
    """涨停池的连板梯队,每项 {code, name, boards}(按东财连板数;反包票是 1)。"""
    return [{"code": r["code"], "name": r["name"], "boards": int(r.get("boards") or 1)} for r in rows if r.get("code")]


def coverage(vals: list[float], expected: int) -> dict:
    """样本覆盖情况。expected = 本该拿到的只数。"""
    rate = round(len(vals) / expected, 3) if expected else None
    return {"sample": len(vals), "expected_sample": expected, "coverage_rate": rate,
            "partial": bool(rate is not None and rate < COVERAGE_PARTIAL)}


def promotion_rates(date: str, prev: Optional[str] = None) -> dict:
    """晋级率:昨日各档连板中,今日仍涨停的比例。任意历史日可算。"""
    prev = prev or S.prev_trade_date(date)
    if not prev:
        return {"available": False, "reason": "取不到前一交易日"}
    prev_zt, today_zt = S.zt_pool(prev), S.zt_pool(date)
    if prev_zt is None or today_zt is None:
        return {"available": False, "reason": f"涨停池取数失败（{prev} 或 {date}）"}

    today_codes = _codes(today_zt) or set()
    buckets: dict[str, list[bool]] = {"1进2": [], "2进3": [], "3板以上晋级": []}
    for s in _ladder(prev_zt):
        key = "1进2" if s["boards"] == 1 else ("2进3" if s["boards"] == 2 else "3板以上晋级")
        buckets[key].append(s["code"] in today_codes)
    tiers = {k: {"base": len(v), "promoted": sum(v), "rate": round(sum(v) / len(v), 3) if v else None} for k, v in buckets.items()}
    total_base = sum(len(v) for v in buckets.values())
    total_promoted = sum(sum(v) for v in buckets.values())
    return {
        "available": True, "prev_date": prev, "tiers": tiers,
        "overall": {"base": total_base, "promoted": total_promoted, "rate": round(total_promoted / total_base, 3) if total_base else None},
        # 两天的涨停家数:池子已经取了,顺手带出来
        "limit_up_count": len(today_codes), "prev_limit_up_count": len(prev_zt),
    }


def _stats_from_settled(rows: list[dict], today_codes: Optional[set[str]], date: str) -> dict:
    """从定稿记录算赚钱效应。缺当天涨跌幅的行算进名单、不算进样本(覆盖率按此算)。"""
    vals = [r["ret"] for r in rows if r.get("ret") is not None]
    if not vals:
        return {}
    again = [r for r in rows if r.get("ret") is not None and (r["code"] in today_codes if today_codes is not None else S.is_limit_up_row(r, date))]
    return {
        "available": True, **S.settled_cov(date, len(vals)),
        "avg": round(mean(vals), 2), "median": round(median(vals), 2),
        "positive_rate": round(sum(1 for v in vals if v > 0) / len(vals), 3),
        # 优先和晋级率共用东财池成员;今天的池取不到时才按「收在涨停价」推定
        "limit_up_again_rate": round(len(again) / len(vals), 3),
        "source": "settled",
    }


def money_effect(date: str, prev: Optional[str] = None) -> dict:
    """赚钱效应:昨日涨停股在目标日的表现。先用定稿记录(任何历史日都算得出),拿不到才退回实时行情。"""
    prev = prev or S.prev_trade_date(date)
    rows = S.settled_pool(date)
    if rows:
        stats = _stats_from_settled(rows, _codes(S.zt_pool(date)), date)
        if stats:
            return {**stats, "prev_date": prev}

    ok, why = S.live_quotes_are_close_of(date)
    if not ok:
        return {"available": False, "reason": why}
    if not prev:
        return {"available": False, "reason": "取不到前一交易日"}
    prev_zt = S.zt_pool(prev)
    if prev_zt is None:
        return {"available": False, "reason": f"{prev} 涨停池取数失败"}
    codes = sorted(_codes(prev_zt) or set())
    today_codes = _codes(S.zt_pool(date))
    pct = S.batch_pct(codes, date)
    vals = list(pct.values())
    cov = coverage(vals, len(codes))
    if not vals:
        return {"available": False, "reason": "批量行情全部取数失败", **cov}
    if cov["coverage_rate"] is not None and cov["coverage_rate"] < COVERAGE_MIN:
        return {"available": False, "reason": f"批量行情只取到 {len(vals)}/{len(codes)} 只（{cov['coverage_rate']:.0%}），样本不足以代表全体", **cov}
    return {
        "available": True, "prev_date": prev, **cov, "source": "live",
        "avg": round(mean(vals), 2), "median": round(median(vals), 2),
        "positive_rate": round(sum(1 for v in vals if v > 0) / len(vals), 3),
        # 涨停池取不到时宁可给 None 也不用涨幅阈值糊弄
        "limit_up_again_rate": round(sum(1 for c in pct if c in today_codes) / len(vals), 3) if today_codes is not None else None,
    }


def consec_premium(date: str, prev: Optional[str] = None) -> dict:
    """连板溢价:昨日 2 板以上个股在目标日的平均涨幅;只描述样本表现,不单独判断承接。定稿记录优先,实时行情兜底。"""
    prev = prev or S.prev_trade_date(date)
    rows = S.settled_pool(date)
    if rows:
        hi = [r for r in rows if (r.get("prev_boards") or 0) >= 2 and r.get("ret") is not None]
        if hi:
            vals = [r["ret"] for r in hi]
            return {"available": True, "prev_date": prev, "source": "settled", **S.settled_cov(date, len(vals), lambda r: (r.get("prev_boards") or 0) >= 2),
                    "avg": round(mean(vals), 2), "median": round(median(vals), 2),
                    "positive_rate": round(sum(1 for v in vals if v > 0) / len(vals), 3)}

    ok, why = S.live_quotes_are_close_of(date)
    if not ok:
        return {"available": False, "reason": why}
    if not prev:
        return {"available": False, "reason": "取不到前一交易日"}
    prev_zt = S.zt_pool(prev)
    if prev_zt is None:
        return {"available": False, "reason": f"{prev} 涨停池取数失败"}
    codes = [s["code"] for s in _ladder(prev_zt) if s["boards"] >= 2]
    if not codes:
        return {"available": False, "reason": f"{prev} 无 2 板以上个股"}
    pct = S.batch_pct(codes, date)
    vals = list(pct.values())
    cov = coverage(vals, len(codes))
    if not vals:
        return {"available": False, "reason": "批量行情全部取数失败", **cov}
    if cov["coverage_rate"] is not None and cov["coverage_rate"] < COVERAGE_MIN:
        return {"available": False, "reason": f"批量行情只取到 {len(vals)}/{len(codes)} 只（{cov['coverage_rate']:.0%}），样本不足以代表昨日连板股表现", **cov}
    return {"available": True, "prev_date": prev, **cov, "source": "live", "avg": round(mean(vals), 2), "median": round(median(vals), 2),
            "positive_rate": round(sum(1 for v in vals if v > 0) / len(vals), 3)}


def ladder_gap(date: str) -> dict:
    """连板梯队断层:高标和低位之间有没有空档。

    例:有 5 板和 2 板、却没有 3-4 板 → 高标「悬空」,一旦断板没有下一梯队承接。梯队连续说明资金在逐级接力。
    ⚠️ 这是全市场板位结构,跨题材;同一题材内部有没有梯队要另查。
    """
    zt = S.zt_pool(date)
    if zt is None:
        return {"available": False, "reason": f"{date} 涨停池取数失败"}
    ladder = _ladder(zt)
    multi = [s for s in ladder if s["boards"] >= 2]
    if not multi:
        return {"available": True, "highest": max((s["boards"] for s in ladder), default=0), "tiers": {}, "gaps": [],
                "continuous": True, "note": "无 2 板以上个股，梯队无从谈起"}
    counts: dict[int, int] = {}
    for s in multi:
        counts[s["boards"]] = counts.get(s["boards"], 0) + 1
    highest = max(counts)
    gaps = [b for b in range(2, highest) if b not in counts]
    return {
        "available": True, "highest": highest, "tiers": {str(b): counts[b] for b in sorted(counts, reverse=True)},
        "gaps": gaps, "continuous": not gaps,
        "note": ("全市场板位结构连续（注：跨题材，不代表同一题材内部有梯队）" if not gaps
                 else f"板位缺档 {'、'.join(f'{g}板' for g in gaps)} → 最高标下方断层，是否有同题材承接需另查，板位缺档本身不能判定"),
    }


# ---------------------------------------------------------------- 情绪周期
def day_summary(date: str) -> Optional[dict]:
    """把一天的涨停 / 炸板池压成三个原始读数(都不依赖行情,任意历史日可算)。

    🔴 炸板池取不到就整天不要:VA 原来炸板池失败时按 0 家算,炸板率会被写成 0%(看着是情绪最好的一天)。
    """
    try:
        zt = S.pool("zt", date)
        if not zt:
            return None
        n_zb = len(S.pool("zb", date))
    except Exception:  # noqa: BLE001
        return None
    n_zt = len(zt)
    return {"limit_up": n_zt, "highest_consec": max(int(r.get("boards") or 1) for r in zt),
            "broken_rate": n_zb / (n_zb + n_zt)}


def _minmax(vals: list[float]) -> list[float]:
    """窗口内归一化到 0~1;全等时一律给 0.5(避免除零,也避免假装有差异)。"""
    lo, hi = min(vals), max(vals)
    return [0.5] * len(vals) if hi == lo else [(v - lo) / (hi - lo) for v in vals]


def _recent_trend(scores: list[float], eps: float = 0.03) -> str:
    """最近的走向 —— 只看尾部斜率,和「相对窗口低点的位置」是两回事(高位连续转弱时两者同时不成立)。"""
    if len(scores) < 3:
        return "样本不足"
    d1, d2 = scores[-1] - scores[-2], scores[-2] - scores[-3]
    if d1 > eps and d2 > eps:
        return "连续两日走强"
    if d1 < -eps and d2 < -eps:
        return "连续两日转弱"
    if d1 > eps:
        return "今日走强"
    if d1 < -eps:
        return "今日转弱"
    return "基本走平"


def cycle_position(date: str, lookback: int = 10) -> dict:
    """情绪周期位置:窗口内情绪最低点在哪天、今天离它第几天、最近往哪走。

    分数 = 涨停家数、最高连板、(1 − 炸板率)三项各自在窗口内归一化后取平均 —— 是**相对**读数,没有绝对含义。
    """
    try:
        dates = S.trade_dates_ending_at(date, lookback)
    except Exception:  # noqa: BLE001  交易日历取不到时至少保住目标日,让下面按天数不足如实报
        dates = [S.iso(date)]
    if not dates:
        dates = [S.iso(date)]
    if len(dates) < 3:
        return {"available": False, "reason": "可用交易日不足 3 天，无法定位周期"}

    series = []
    for d in dates:
        s = day_summary(d)
        if s:
            series.append({"date": d, **s})
    if len(series) < 3:
        return {"available": False, "reason": f"涨停池可用天数不足（{len(series)}/3）"}

    # 炸板率是「越高越冷」,取反后再平均 —— 三项才都指向同一个方向
    n_zt = _minmax([float(s["limit_up"]) for s in series])
    n_hc = _minmax([float(s["highest_consec"]) for s in series])
    n_br = _minmax([float(s["broken_rate"]) for s in series])
    for i, s in enumerate(series):
        s["score"] = round((n_zt[i] + n_hc[i] + (1 - n_br[i])) / 3, 3)

    trough = min(series, key=lambda s: s["score"])
    trough_idx = [s["date"] for s in series].index(trough["date"])
    top = max(s["score"] for s in series)
    return {
        "available": True, "window": len(series), "requested_window": lookback,
        "trough_date": trough["date"], "trough_score": trough["score"], "current_score": series[-1]["score"],
        "current_date": series[-1]["date"], "day_n": len(series) - trough_idx,
        "rising": series[-1]["score"] > trough["score"],
        "trend": _recent_trend([s["score"] for s in series]),
        "pctile": round((series[-1]["score"] - trough["score"]) / (top - trough["score"]), 3) if top > trough["score"] else None,
        "series": series,
    }


# ---------------------------------------------------------------- 每日六项读数(历史统计原料)
def daily_readings(date: str) -> dict:
    """一天的六项可比读数:历史分位、跟前一天比、近 N 天走势都在这串数上算(VA stats_context 的 READINGS)。

    只用三张东财池(涨停 / 炸板 / 昨日涨停)加前一天的涨停池,任意历史日都算得出;
    但东财只留最近一个月左右,更早的日子靠取数服务把已收盘那天的结果存下来,历史才越积越长。
    每项单独可缺:取不到的写 None 并在 reasons 里说原因,不补零。
    1进2 与情绪四项同一口径(昨日首板今天在涨停池里),同一页上不会出现两个不同的 1进2。
    """
    out: dict = {"reasons": {}}
    summ = day_summary(date)
    if summ:
        out.update(limit_up=summ["limit_up"], highest_board=summ["highest_consec"], broken_rate=round(summ["broken_rate"], 3))
    else:
        for k in ("limit_up", "highest_board", "broken_rate"):
            out[k] = None
        out["reasons"]["summary"] = "涨停池或炸板池没取到(或当天涨停池为空)"

    rows = S.settled_pool(date)
    vals = [r["ret"] for r in rows or [] if r.get("ret") is not None]
    if vals:
        out.update(money_effect=round(median(vals), 2), deep_loss=sum(1 for v in vals if v <= -5), sample=len(vals))
        cov = S.settled_cov(date, len(vals))
        if cov["partial"]:
            out["reasons"]["settled_partial"] = f"昨日涨停股有 {cov['expected_sample'] - len(vals)} 只缺当天涨跌幅,样本 {len(vals)}/{cov['expected_sample']}"
    else:
        out.update(money_effect=None, deep_loss=None, sample=None)
        out["reasons"]["settled"] = "昨日涨停股的当日表现(东财昨日涨停池)没取到"

    pr = promotion_rates(date)
    first = pr["tiers"]["1进2"] if pr.get("available") else None
    if first and first["base"]:
        out.update(promotion_1to2=first["rate"], promotion_base=first["base"], promotion_promoted=first["promoted"])
    else:
        out.update(promotion_1to2=None, promotion_base=None, promotion_promoted=None)
        out["reasons"]["promotion"] = pr.get("reason") or "前一交易日没有首板"
    return out


def build_daily(date: Optional[str] = None) -> dict:
    """端点 `cn_shortline_daily` 的入口。"""
    d = S.review_day(date)
    return {"date": d, "prev_date": S.prev_trade_date(d), "settled": S.is_settled(d), "readings": daily_readings(d)}


# ---------------------------------------------------------------- 昨日涨停股当日表现明细(涨停样本统计原料)
def build_settled(date: Optional[str] = None) -> dict:
    """端点 `cn_shortline_settled` 的入口:前一交易日收盘涨停的每只票在 `date` 当天的表现。

    界面视图「涨停样本统计」按日扇出调用它,分组统计在编排层算(移植自 Vibe AStock v2.0.0 duanxian/backtest.py 的取数部分)。
    ⚠️ `seal_time` 是前一天的**最后**封板时间,不是首封(VA 2026-07-24 实测对照当天涨停池,116 只全部等于最后封板时间)。
    ⚠️ 样本只有前一天收盘留在涨停池里的票:冲板没封住的不在里面。
    是否再涨停按这只票自己在那天的涨跌幅制度判(`is_limit_up_row`);判不了给 None,不猜。
    """
    d = S.review_day(date)
    base = {"date": d, "prev_date": S.prev_trade_date(d), "settled": S.is_settled(d)}
    rows = S.settled_pool(d)
    if not rows:
        return {**base, "available": False, "reason": "东财昨日涨停池没取到(或当天为空)", "rows": []}
    out = [{"code": r["code"], "name": r.get("name") or "", "ret": r["ret"], "prev_boards": r.get("prev_boards") or 1,
            "seal_time": r.get("seal_time") or "", "sector": r.get("sector") or "", "limit_up": S.is_limit_up_row(r, d)}
           for r in rows]
    return {**base, "available": True, **S.settled_cov(d, len(out)), "rows": out}


def build_metrics(date: Optional[str] = None) -> dict:
    """当天四项一起算(共用同一个前一交易日和池子)。端点 `cn_shortline_emotion` 的入口。"""
    d = S.review_day(date)
    prev = S.prev_trade_date(d)
    return {
        "date": d, "prev_date": prev, "settled": S.is_settled(d),
        "money_effect": money_effect(d, prev),
        "promotion": promotion_rates(d, prev),
        "consec_premium": consec_premium(d, prev),
        "ladder_gap": ladder_gap(d),
    }


def build_cycle(date: Optional[str] = None, lookback: int = 10) -> dict:
    """端点 `cn_shortline_cycle` 的入口。"""
    d = S.review_day(date)
    lookback = int(lookback)
    if not 3 <= lookback <= 30:
        raise ValueError("lookback 要在 3–30 个交易日之间")
    return {"date": d, "settled": S.is_settled(d), "cycle": cycle_position(d, lookback)}


# ---------------------------------------------------------------- 给模型看的文字
def _pct(v: Optional[float]) -> str:
    return "—" if v is None else f"{v:.0%}"


def _cov_note(d: dict) -> str:
    """样本不全时的警示后缀。不写进文字的话,模型会把 30% 覆盖的均值当全体读数用。"""
    if not d.get("partial"):
        return ""
    return f"｜⚠️样本不全：仅取到 {d.get('sample')}/{d.get('expected_sample')}，结论按部分样本看"


def render_metrics(m: dict) -> str:
    """渲染成 Agent 复盘能直接读的文字块。不可用的部分如实说明原因。"""
    date, prev = m.get("date", ""), m.get("prev_date") or "—"
    lines = [f"[派生情绪指标 {date}｜对照前一交易日 {prev}]"]

    me = m.get("money_effect", {})
    if me.get("available"):
        lines.append(f"· 赚钱效应：{prev} 涨停 {me['sample']} 家，在 {date} 平均 {me['avg']:+.2f}%、中位 {me['median']:+.2f}%；"
                     f"翻红率 {_pct(me['positive_rate'])}、再度涨停 {_pct(me['limit_up_again_rate'])}" + _cov_note(me))
    else:
        lines.append(f"· 赚钱效应：不可用（{me.get('reason', '未知')}）")

    pr = m.get("promotion", {})
    if pr.get("available"):
        seg = "；".join(f"{k} {v['promoted']}/{v['base']}（{_pct(v['rate'])}）" for k, v in pr["tiers"].items() if v["base"]) or "无可统计档位"
        lines.append(f"· 晋级率：{seg}；整体 {_pct(pr['overall']['rate'])}")
    else:
        lines.append(f"· 晋级率：不可用（{pr.get('reason', '未知')}）")

    cp = m.get("consec_premium", {})
    if cp.get("available"):
        lines.append(f"· 连板溢价（承接度）：{prev} 的 {cp['sample']} 只 2 板以上个股，在 {date} 平均 {cp['avg']:+.2f}%、中位 {cp['median']:+.2f}%，"
                     f"翻红率 {_pct(cp['positive_rate'])}" + _cov_note(cp))
    else:
        lines.append(f"· 连板溢价：不可用（{cp.get('reason', '未知')}）")

    lg = m.get("ladder_gap", {})
    if lg.get("available"):
        tiers = "、".join(f"{b}板×{c}" for b, c in (lg.get("tiers") or {}).items()) or "无 2 板以上"
        lines.append(f"· 梯队结构：最高 {lg.get('highest', 0)} 板；{tiers}。{lg.get('note', '')}")
    elif lg:
        lines.append(f"· 梯队结构：不可用（{lg.get('reason', '未知')}）")

    cy = m.get("cycle", {})
    if cy:
        lines.append(render_cycle(cy))
    return "\n".join(lines)


def render_daily(d: dict) -> str:
    """每日六项一行。历史分位和跟前一天比在界面视图里算,这里只报当天的数。"""
    r = d.get("readings") or {}

    def f(v: Optional[float], kind: str) -> str:
        if v is None:
            return "—"
        return f"{v:.0%}" if kind == "rate" else f"{v:+.2f}%" if kind == "pct" else f"{v:g}"

    seg = (f"涨停 {f(r.get('limit_up'), 'n')} 只、最高 {f(r.get('highest_board'), 'n')} 板、炸板率 {f(r.get('broken_rate'), 'rate')}；"
           f"昨日涨停股今日中位 {f(r.get('money_effect'), 'pct')}、跌超 5% {f(r.get('deep_loss'), 'n')} 只；"
           f"1进2 {f(r.get('promotion_1to2'), 'rate')}")
    miss = "；".join((r.get("reasons") or {}).values())
    return f"[每日情绪读数 {d.get('date', '')}] {seg}" + (f"（未取到：{miss}）" if miss else "")


def render_settled(d: dict) -> str:
    """一行概览:首板 / 连板各多少只、中位涨跌幅、再涨停几只。逐只明细在证据里。"""
    day, prev = d.get("date", ""), d.get("prev_date") or "前一交易日"
    if not d.get("available"):
        return f"[昨日涨停股当日表现 {day}] 不可用（{d.get('reason', '未知')}）"

    def seg(label: str, rs: list[dict]) -> str:
        if not rs:
            return f"{label} 0 只"
        again = sum(1 for r in rs if r.get("limit_up") is True)
        return f"{label} {len(rs)} 只、中位 {median(r['ret'] for r in rs):+.2f}%、再涨停 {again} 只"

    rows = d.get("rows") or []
    first = [r for r in rows if r.get("prev_boards") == 1]
    consec = [r for r in rows if (r.get("prev_boards") or 0) >= 2]
    return (f"[昨日涨停股当日表现 {day}｜{prev} 收盘涨停 {len(rows)} 只] {seg('首板', first)}；{seg('连板', consec)}"
            "（样本只含前一天收盘封住的票，冲板没封住的不在内；封板时间是最后封板时间）")


def render_cycle(cy: dict) -> str:
    """情绪周期一行(端点 `cn_shortline_cycle` 单独出,也拼进 render_metrics)。"""
    if not cy.get("available"):
        return f"· 情绪周期：不可用（{cy.get('reason', '未知')}）"
    pctile = cy.get("pctile")
    pos = f"位于窗口区间 {pctile:.0%} 分位" if isinstance(pctile, (int, float)) else "分位未知"
    return (f"· 情绪周期（⚠️ 这是 {cy.get('window')} 个交易日窗口内的**相对**读数，没有绝对含义）："
            f"窗口最低点在 {cy['trough_date']}（{cy['trough_score']}），到 {cy.get('current_date') or '窗口末日'} 是第 {cy['day_n']} 天；"
            f"当前相对分 {cy['current_score']}，{pos}，最近走向：**{cy.get('trend', '未知')}**。"
            f"⚠️「距低点第 N 天」和「正在往上走」是两件事，别混为一谈")
