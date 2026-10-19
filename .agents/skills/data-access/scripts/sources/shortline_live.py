"""盘中实时打板情绪:回答「此刻打板好不好做」,数字随盘变化。

和复盘口径的分工:cn_shortline_emotion / cn_shortline_daily 算指定交易日(默认最近一个已收盘的),这里只算**今天此刻**。
移植自 Vibe AStock v2.0.0 的 duanxian/live_emotion.py,改了几处:
- 缓存交给取数服务(注册表 cache_max_age_sec = 15,比页面刷新略长,挡住叠加请求);VA 在进程里自己缓存。
- 开盘前、集合竞价、收盘集合竞价、非交易日直接说明为什么没有,不拿上一交易日的池子冒充今天
  (东财对还没数据的日子会回上一交易日的池子,取数层已按 qdate 拦掉)。
- 晋级率照 VA 给「昨日全部涨停股今天又封住」的比例,另给与复盘同口径的 1进2;再加昨日涨停股此刻的中位涨幅(赚钱效应)。
- 炸板率另取炸板池:涨停池里的开板次数只说这一只炸过几次,答不了全市场炸了多少家。分母 = 封住 + 炸板未回封。
"""
from __future__ import annotations

import os
import sys
from datetime import datetime
from statistics import median
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources import shortline as S  # noqa: E402
from sources._http import DataNotAvailable  # noqa: E402
from sources.shortline_emotion import promotion_rates  # noqa: E402

# (结束时刻, 名称, 能不能出盘中读数)
_PHASES = [((9, 15), "开盘前", False), ((9, 30), "集合竞价", False), ((11, 30), "上午连续竞价", True),
           ((13, 0), "午间休市", True), ((14, 57), "下午连续竞价", True), ((15, 0), "收盘集合竞价", False)]


def session_phase(now: datetime) -> tuple[str, bool]:
    hm = (now.hour, now.minute)
    for end, label, ok in _PHASES:
        if hm < end:
            return label, ok
    return "已收盘", True


def _rate(hit: int, total: int) -> Optional[float]:
    return round(hit / total, 3) if total else None


def _side_pool(kind: str, day: str, label: str, reasons: dict[str, str]) -> Optional[list[dict]]:
    try:
        return S.pool(kind, day)
    except Exception as exc:  # noqa: BLE001  如实写进 reasons,不当 0 家
        reasons[kind] = f"东财{label}没取到（{str(exc)[:80]}）"
        return None


def build_live() -> dict:
    now = S.now_sh()
    today = now.strftime("%Y-%m-%d")
    if not S.is_trade_day(today):
        raise DataNotAvailable(f"今天（{today}）不是交易日，没有盘中情绪；最近一个已收盘交易日是 {S.latest_settled_session()}，看复盘")
    phase, ok = session_phase(now)
    if not ok:
        when = "15:00 收盘后更新" if phase == "收盘集合竞价" else "09:30 连续竞价开始后更新"
        raise DataNotAvailable(f"{phase}：盘中情绪{when}")
    zt = S.zt_pool(today)
    if not zt:
        raise DataNotAvailable("今天的涨停池没取到，或此刻还没有涨停股")
    reasons: dict[str, str] = {}
    # 炸板池 / 跌停池取不到时照 VA 只空出相关的数,涨停那几项照出
    zb, dt = _side_pool("zb", today, "炸板池", reasons), _side_pool("dt", today, "跌停池", reasons)
    boards = [int(r.get("boards") or 1) for r in zt]
    n_zt = len(zt)
    n_zb = len(zb) if zb is not None else None
    tried = n_zt + n_zb if n_zb is not None else 0   # 尝试过涨停的家数
    live: dict = {
        "limit_up": n_zt, "broken": n_zb, "limit_down": len(dt) if dt is not None else None,
        "highest_board": max(boards), "consec_count": sum(1 for b in boards if b >= 2),
        "seal_rate": _rate(n_zt, tried), "broken_rate": _rate(n_zb or 0, tried),
    }

    prev = S.prev_trade_date(today)
    prev_zt = S.zt_pool(prev) if prev else None
    if prev_zt:
        codes = {r["code"] for r in zt}
        promoted = sum(1 for r in prev_zt if r["code"] in codes)
        live.update(promotion_all=_rate(promoted, len(prev_zt)), promotion_all_base=len(prev_zt), promotion_all_promoted=promoted)
    else:
        live.update(promotion_all=None, promotion_all_base=None, promotion_all_promoted=None)
        reasons["promotion"] = f"前一交易日（{prev}）涨停池没取到"
    pr = promotion_rates(today, prev)
    first = pr["tiers"]["1进2"] if pr.get("available") else None
    if first and first["base"]:
        live.update(promotion_1to2=first["rate"], promotion_base=first["base"], promotion_promoted=first["promoted"])
    else:
        live.update(promotion_1to2=None, promotion_base=None, promotion_promoted=None)

    rows = S.settled_pool(today)
    vals = [r["ret"] for r in rows or [] if r.get("ret") is not None]
    if vals:
        live.update(money_effect=round(median(vals), 2), deep_loss=sum(1 for v in vals if v <= -5), sample=len(vals))
        cov = S.settled_cov(today, len(vals))
        if cov["partial"]:
            reasons["settled_partial"] = f"昨日涨停股有 {cov['expected_sample'] - len(vals)} 只此刻缺涨跌幅,样本 {len(vals)}/{cov['expected_sample']}"
    else:
        live.update(money_effect=None, deep_loss=None, sample=None)
        reasons["settled"] = "昨日涨停股此刻的表现（东财昨日涨停池）没取到"
    return {"date": today, "as_of": now.strftime("%H:%M:%S"), "phase": phase, "settled": S.is_settled(today),
            "prev_date": prev, "live": live, "reasons": reasons}


def _pct(v: Optional[float]) -> str:
    return "—" if v is None else f"{v:.0%}"


def _n(v: Optional[int]) -> str:
    return "—" if v is None else str(v)


def render_live(r: dict) -> str:
    v = r["live"]
    seg = [f"涨停 {v['limit_up']}、炸板 {_n(v['broken'])}、跌停 {_n(v['limit_down'])}",
           f"最高 {v['highest_board']} 板、连板 {v['consec_count']} 只",
           f"封板率 {_pct(v['seal_rate'])}、炸板率 {_pct(v['broken_rate'])}"]
    if v.get("promotion_all") is not None:
        seg.append(f"昨日涨停 {v['promotion_all_base']} 只今天又封住 {v['promotion_all_promoted']} 只（{_pct(v['promotion_all'])}）")
    if v.get("promotion_1to2") is not None:
        seg.append(f"1进2 {_pct(v['promotion_1to2'])}")
    if v.get("money_effect") is not None:
        seg.append(f"昨日涨停股此刻中位 {v['money_effect']:+.2f}%、跌超 5% {v['deep_loss']} 只")
    text = f"[盘中情绪 {r['date']} {r['as_of'][:5]}｜{r['phase']}] " + "；".join(seg)
    if r.get("reasons"):
        text += "（未取到：" + "；".join(r["reasons"].values()) + "）"
    return text
