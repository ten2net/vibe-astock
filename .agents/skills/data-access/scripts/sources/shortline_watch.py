"""盯盘用的三份名单:昨日梯队、某日成交额前十、大市值股。

移植自 Vibe AStock v2.0.0 的 vr/previous_ladder.py 与 vr/watchtower.py 里的标的池。行情轮询、封板状态和异动判断在界面里做
(界面每 3 秒取一次批量行情),这里只出名单:名单要么是历史(长期缓存),要么一天变化很小。
相对 VA 的改动:
- 昨日梯队按「行情日」的前一交易日取涨停池,和 VA 相同;不给日期时用今天(非交易日用最近一个交易日)。
- 成交额前十改用通达信盘后包(任意交易日、全市场),VA 用东财列表接口(09-22 起成片失败)当天收盘自己存快照,首日只能拿当日实时榜暂代。
- 大市值股改用新浪按市值排序的列表,VA 用东财列表接口。
"""
from __future__ import annotations

import math
import os
import re
import sys
from datetime import datetime
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources import astock_ported as P  # noqa: E402
from sources import shortline as S  # noqa: E402
from sources import sina  # noqa: E402
from sources._http import DataNotAvailable  # noqa: E402

# ---------------------------------------------------------------- 昨日梯队


def _watch_day(date: Optional[str]) -> str:
    """盯的是哪一场:不给 = 今天(非交易日用最近一个交易日);给了只认交易日、不认未来。"""
    today = S.today_sh()
    if not date:
        if S.is_trade_day(today):
            return today
        prev = S.prev_trade_date(today)
        if not prev:
            raise DataNotAvailable("交易日历里找不到最近的交易日")
        return prev
    d = S.iso(date)
    if d > today:
        raise ValueError(f"{d} 还没到")
    if not S.is_trade_day(d):
        raise DataNotAvailable(f"{d} 不是交易日")
    return d


def build_ladder(date: Optional[str] = None) -> dict:
    """「行情日」前一交易日的全部涨停股,原样固定:今天没接上的、没取到行情的都留着(VA 同)。"""
    day = _watch_day(date)
    prev = S.prev_trade_date(day)
    if not prev:
        raise DataNotAvailable(f"交易日历取不到 {day} 的前一交易日；不按工作日猜")
    try:
        rows = S.pool("zt", prev)
    except Exception as exc:  # noqa: BLE001
        raise DataNotAvailable(f"{prev} 涨停池没取到（{str(exc)[:80]}）；不改用其他日期的名单") from exc
    if not rows:
        # 🔴 VA 把空池当「0 只」。真实交易日几乎不可能没有涨停;东财这几张池只留约一个月,超出就回空 —— 不能读成 0 只
        raise DataNotAvailable(f"{prev} 涨停池是空的（东财这几张池只留约一个月，可能超出了）；不当成 0 只")
    seen: set[str] = set()
    stocks: list[dict[str, Any]] = []
    for r in rows:
        code, boards = r.get("code"), r.get("boards")
        if not isinstance(code, str) or not re.fullmatch(r"\d{6}", code) or code in seen or not isinstance(boards, int) or boards < 1:
            raise DataNotAvailable(f"{prev} 涨停池有异常行（{code!r}）；不交一份不完整的名单")
        seen.add(code)
        stocks.append({"code": code, "name": r.get("name") or code, "boards": boards, "label": S.board_label(boards, r.get("zt_stat")),
                       "sector": r.get("sector") or "", "first_seal": r.get("first_seal"), "broken_times": r.get("broken_times")})
    stocks.sort(key=lambda s: (-s["boards"], s["code"]))
    tiers: dict[int, int] = {}
    for s in stocks:
        tiers[s["boards"]] = tiers.get(s["boards"], 0) + 1
    return {"quote_date": day, "sample_date": prev, "stocks": stocks, "total": len(stocks),
            "highest": stocks[0]["boards"], "tiers": [{"boards": b, "count": tiers[b]} for b in sorted(tiers, reverse=True)]}


def render_ladder(r: dict) -> str:
    head = f"[昨日梯队 {r['sample_date']} 涨停 {r['total']} 只，盯 {r['quote_date']}] "
    tiers = "、".join(f"{t['boards']}板 {t['count']} 只" for t in r["tiers"])
    top = "；".join(f"{s['name']}({s['code']}) {s['label']}" for s in r["stocks"] if s["boards"] >= 2)
    return head + tiers + (f"。连板：{top}" if top else "")


# ---------------------------------------------------------------- 某日成交额前十

# 沪深京 A 股的号段(按交易所区分:sh000001 是上证指数,sz000001 是平安银行;B 股 900 / 200 不算)
_A_SEG = {"sh": ("600", "601", "603", "605", "688", "689"), "sz": ("000", "001", "002", "003", "300", "301", "302"),
          "bj": ("920", "43", "83", "87")}
_TDX_HOUR = 17   # 通达信盘后包当天 17 点后才齐


def is_a_share(market: Any, code: Any) -> bool:
    segs = _A_SEG.get(str(market).lower())
    c = str(code)
    if not segs:
        return False
    return len(c) == 6 and c.isdigit() and c.startswith(segs)


def _num(v: Any) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def build_turnover_top(date: Optional[str] = None, top: int = 10) -> dict:
    """某个交易日沪深京 A 股成交额前 N(通达信盘后包,含名称、收盘价、涨跌幅)。不给日期 = 最近一个盘后包已发布的交易日。"""
    top = int(top)
    if not 1 <= top <= 50:
        raise ValueError("top 须在 1~50 之间")
    if date:
        day = S.review_day(date)
        n = S.now_sh()
        if day == S.today_sh() and n.hour < _TDX_HOUR:
            raise DataNotAvailable(f"{day} 的通达信盘后包 {_TDX_HOUR} 点后才发布")
    else:
        from sources.astock_defaults import latest_trading_day
        day = latest_trading_day(_TDX_HOUR)
    frame = P.tdx_daily_package(day)
    dates = {str(x) for x in frame["date"].unique()}
    if dates != {day}:
        raise DataNotAvailable(f"通达信盘后包的日期是 {sorted(dates)}，不是 {day}")
    rows: list[dict[str, Any]] = []
    for rec in frame.to_dict("records"):
        if not is_a_share(rec.get("market"), rec.get("code")):
            continue
        amount = _num(rec.get("amount"))
        if not amount or amount <= 0:
            continue
        close, prev = _num(rec.get("close")), _num(rec.get("prev_close"))
        pct = round((close / prev - 1) * 100, 2) if close and prev else None
        rows.append({"code": str(rec["code"]), "market": str(rec["market"]), "name": str(rec.get("name") or rec["code"]),
                     "amount": amount, "close": close, "pct": pct})
    if not rows:
        raise DataNotAvailable(f"{day} 通达信盘后包里没有 A 股成交记录")
    rows.sort(key=lambda r: -r["amount"])
    picked = [{**r, "rank": i + 1} for i, r in enumerate(rows[:top])]
    return {"date": day, "top": top, "stocks": picked, "total_traded": len(rows), "source_url": str(frame["source_url"].iloc[0])}


def render_turnover_top(r: dict) -> str:
    seg = "；".join(f"{s['rank']}. {s['name']}({s['code']}) {s['amount'] / 1e8:.1f} 亿" + ("" if s["pct"] is None else f" {s['pct']:+.2f}%")
                   for s in r["stocks"])
    return f"[成交额前 {r['top']} {r['date']}｜通达信盘后包，有成交的 A 股 {r['total_traded']} 只] {seg}"


# ---------------------------------------------------------------- 大市值股
_SINA_PAGE = 100     # 新浪每页最多给 100 条(实测 num 传多大都只回 100)
_SINA_PAGES = 10


def build_bigcaps(min_cap_yi: float = 500) -> dict:
    """总市值不低于 min_cap_yi 亿元的沪深京 A 股(新浪按总市值降序翻页)。
    ⚠️ 盘中翻页期间排名在变,页边界附近个别票可能漏掉或重复(重复已去掉);名单只用来圈盯盘范围。"""
    floor = float(min_cap_yi)
    if not 50 <= floor <= 10000:
        raise ValueError("min_cap_yi 须在 50~10000 之间")
    stocks: list[dict] = []
    seen: set[str] = set()
    for page in range(1, _SINA_PAGES + 1):
        arr = sina._sina_list("Market_Center.getHQNodeData", {"page": page, "num": _SINA_PAGE, "sort": "mktcap", "asc": 0, "node": "hs_a", "symbol": "", "_s_r_a": "page"})
        if not arr:
            # 🔴 翻过最后一页新浪回空列表、不报错(10-11 实测第 200 页)。还没翻到门槛就空了 = 名单不全,不能当完整的交出去
            raise DataNotAvailable(f"新浪第 {page} 页是空的，还没翻到 {floor:g} 亿；不交半份名单")
        below = False
        for x in arr:
            code = str((x or {}).get("code") or "")
            cap_wan = _num((x or {}).get("mktcap"))
            if not re.fullmatch(r"\d{6}", code) or cap_wan is None:
                continue
            cap = cap_wan * 1e4   # 新浪市值是万元
            if cap < floor * 1e8:
                below = True
                break
            if code in seen:
                continue
            seen.add(code)
            stocks.append({"code": code, "name": str(x.get("name") or code), "mcap": cap, "price": _num(x.get("trade")), "pct": _num(x.get("changepercent"))})
        if below:
            break
    else:
        raise DataNotAvailable(f"翻了 {_SINA_PAGES} 页还没到 {floor:g} 亿；不交半份名单")
    if not stocks:
        raise DataNotAvailable("新浪市值榜一只都没取到")
    now = S.now_sh()
    return {"date": _quote_day(now), "as_of": now.strftime("%Y-%m-%d %H:%M"), "min_cap_yi": floor, "stocks": stocks, "count": len(stocks)}


def _quote_day(now: datetime) -> str:
    """新浪行情此刻属于哪个交易日:交易日 09:15 竞价开始后算今天,否则是上一个交易日(周六取到的是周五收盘)。"""
    today = now.strftime("%Y-%m-%d")
    if S.is_trade_day(today) and (now.hour, now.minute) >= (9, 15):
        return today
    prev = S.prev_trade_date(today)
    if not prev:
        raise DataNotAvailable("交易日历里找不到上一个交易日")
    return prev


def render_bigcaps(r: dict) -> str:
    head = "、".join(f"{s['name']} {s['mcap'] / 1e8:.0f} 亿" for s in r["stocks"][:5])
    return f"[总市值 ≥ {r['min_cap_yi']:g} 亿｜{r['date']} 行情，{r['as_of']} 取｜新浪] 共 {r['count']} 只，最大：{head}"
