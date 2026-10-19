"""短线复盘的公共底座:涨跌幅制度、三池明细、昨日涨停股的定稿表现、交易日历。

移植自 Vibe AStock v2.0.0 的 duanxian/market_facts.py、data.py、trade_calendar.py,改了三处:
- 取数从 akshare 换成本仓库的东财 push2ex 源(`eastmoney._em_zt_api`,原文照常落盘);字段口径与 akshare 一致(同一个接口),
  涨跌幅保留原始精度,不先四舍五入 —— 赚钱效应的均值是逐只平均出来的,先截两位再平均会和旧版对不上。
- 交易日历用深交所官方日历(`astock_ported.trading_calendar`),不再拿参考股 K 线推。
- 主板 ST 的涨跌幅按 2026 年修订版交易规则:**2026-07-06 起 10%**,之前 5%(VA 原来一律 5%,新规施行后会把
  ST 跌 6% 当成跌停)。创业板 2020-08-24 起 20%,之前 10%。

取数层是一次一用的子进程,没有持久缓存;同一进程里按日期记住取到的池子,省掉重复请求(失败不记)。
"""
from __future__ import annotations

import math
import os
import re
import sys
import unicodedata
from datetime import datetime, timedelta
from typing import Any, Callable, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import TZ_SH  # noqa: E402
from sources import astock_ported as P  # noqa: E402
from sources import eastmoney as em  # noqa: E402
from sources._http import DataNotAvailable  # noqa: E402
from sources.tencent import tencent_quotes  # noqa: E402

ST_10PCT_FROM = "2026-07-06"
CHINEXT_20PCT_FROM = "2020-08-24"
_CLOSE_HM = (15, 5)   # 收盘后 5 分钟才认这一场已结束(收盘集合竞价的成交要回写)


def now_sh() -> datetime:
    return datetime.now(TZ_SH)


def today_sh() -> str:
    return now_sh().strftime("%Y-%m-%d")


_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_COMPACT_RE = re.compile(r"^\d{8}$")


def iso(day: Any) -> str:
    """YYYYMMDD / YYYY-MM-DD → YYYY-MM-DD;别的写法当场报错(写法挑错时上游只会安静地返回空池)。"""
    s = str(day or "").strip()
    if _COMPACT_RE.match(s):
        s = f"{s[:4]}-{s[4:6]}-{s[6:]}"
    if not _ISO_RE.match(s):
        raise ValueError(f"日期要写成 YYYYMMDD 或 YYYY-MM-DD，收到 {day!r}")
    datetime.strptime(s, "%Y-%m-%d")
    return s


def compact(day: Any) -> str:
    return iso(day).replace("-", "")


# ---------------------------------------------------------------- 交易日历
_MONTHS: dict[tuple[int, int], list[str]] = {}


def _open_days_month(year: int, month: int) -> list[str]:
    key = (year, month)
    if key not in _MONTHS:
        frame = P.trading_calendar(year, month)
        _MONTHS[key] = sorted(str(d) for d, is_open in zip(frame["date"], frame["is_open"]) if bool(is_open))
    return _MONTHS[key]


def open_days_between(start: str, end: str) -> list[str]:
    """[start, end] 内的交易日(升序)。深交所还没发布的月份会抛错,不猜。"""
    start, end = iso(start), iso(end)
    y, m = int(start[:4]), int(start[5:7])
    out: list[str] = []
    while (y, m) <= (int(end[:4]), int(end[5:7])):
        out += [d for d in _open_days_month(y, m) if start <= d <= end]
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def is_trade_day(day: str) -> bool:
    d = iso(day)
    return d in open_days_between(d, d)


def is_settled(day: str) -> bool:
    """这一场收完了没有(收盘后 5 分钟)。已收盘不代表上游此后不会修订。"""
    d, today = iso(day), today_sh()
    if d < today:
        return True
    if d > today:
        return False
    n = now_sh()
    return (n.hour, n.minute) >= _CLOSE_HM and is_trade_day(d)


def prev_trade_date(day: str) -> Optional[str]:
    d = iso(day)
    start = (datetime.strptime(d, "%Y-%m-%d") - timedelta(days=20)).strftime("%Y-%m-%d")
    earlier = [x for x in open_days_between(start, d) if x < d]
    return earlier[-1] if earlier else None


def trade_dates_ending_at(end: str, n: int = 10) -> list[str]:
    """以 end 为终点往前 n 个交易日(升序,含 end 本身若是交易日);还没收盘的今天不算。"""
    e = iso(end)
    start = (datetime.strptime(e, "%Y-%m-%d") - timedelta(days=n * 3 + 16)).strftime("%Y-%m-%d")
    dates = [x for x in open_days_between(start, e) if x <= e]
    if dates and dates[-1] == today_sh() and not is_settled(dates[-1]):
        dates = dates[:-1]
    return dates[-n:]


def latest_settled_session() -> Optional[str]:
    today = today_sh()
    if is_settled(today):
        return today
    return prev_trade_date(today)


def review_day(day: Optional[str]) -> str:
    """端点要算哪一天:不给 = 最近一个已收盘交易日(盘中不拿半天的数冒充复盘);给了就校验。
    🔴 未来日期和非交易日直接拒:上游对它们返回空池,下游会如实算出「涨停 0 家」,读起来像真实行情。"""
    if not day:
        d = latest_settled_session()
        if not d:
            raise DataNotAvailable("交易日历里找不到最近的已收盘交易日")
        return d
    d = iso(day)
    if d > today_sh():
        raise ValueError(f"{d} 还没到")
    if not is_trade_day(d):
        raise DataNotAvailable(f"{d} 不是交易日")
    return d


# ---------------------------------------------------------------- 涨跌幅制度
def _is_st(name: Any) -> bool:
    # 东财名称里有全角字符(实测「张  裕Ａ」),先 NFKC 归一,别让全角 ＳＴ 漏掉
    return "ST" in unicodedata.normalize("NFKC", str(name or "")).upper()


def board_of(code: Any, name: Any = "") -> str:
    """这只票属于哪种涨跌幅制度。号段与回测引擎(backtest/engines/china_a.py)一致。"""
    c = str(code).zfill(6)
    st = _is_st(name)
    if c.startswith(("43", "83", "87", "88", "92")):
        return "北交所"
    if c.startswith(("30", "688", "689")):
        return "20cm(ST)" if st else "20cm"     # 创业板 / 科创板:ST 也是 20%
    return "主板ST" if st else "10cm"


_LIMIT_PCT = {"北交所": 30.0, "20cm": 20.0, "20cm(ST)": 20.0, "10cm": 10.0}


def limit_pct(code: Any, name: Any = "", day: Optional[str] = None) -> float:
    """这只票在 `day` 的涨跌幅限制(%)。不给日期按现行规则。"""
    b = board_of(code, name)
    d = iso(day) if day else None
    if b == "主板ST":
        return 5.0 if (d and d < ST_10PCT_FROM) else 10.0
    if b.startswith("20cm") and str(code).zfill(6).startswith("30") and d and d < CHINEXT_20PCT_FROM:
        return 10.0
    return _LIMIT_PCT[b]


def is_limit_up_ret(ret: float, code: Any, name: Any = "", day: Optional[str] = None, tol: float = 0.3) -> bool:
    """按各自的涨停幅度判是否涨停。tol 容忍四舍五入与除权误差。别再用统一的 ret >= 9.8。"""
    return ret >= limit_pct(code, name, day) - tol


def is_limit_up_row(row: dict, day: Optional[str] = None) -> Optional[bool]:
    """这一行当天涨停了吗:优先「现价 == 涨停价」,缺价格时按制度推定;涨跌幅也没有就是不知道。"""
    close, limit = row.get("close"), row.get("limit_price")
    if isinstance(close, (int, float)) and isinstance(limit, (int, float)) and limit > 0:
        # 按分比:差一分钱(10.99 对 11.00)就是没封住。原来 abs(差) < 0.011 会把差一分算成涨停
        return round(close * 100) == round(limit * 100)
    ret = row.get("ret")
    if ret is None:
        return None
    return is_limit_up_ret(ret, row.get("code", ""), row.get("name", ""), day)


def is_limit_down_row(row: dict, day: Optional[str] = None) -> bool:
    """按这只票自己的制度判跌停(留 0.3 个点余量)。统一 -9.8% 会把 20cm 跌 12% 也算成跌停。"""
    ret = row.get("ret")
    if ret is None:
        return False
    return ret <= -(limit_pct(row.get("code", ""), row.get("name", ""), day) - 0.3)


_STAT_RE = re.compile(r"^\s*(\d+)\s*(?:天|/)\s*(\d+)\s*板?\s*$")


def _parse_stat(zt_stat: Any) -> Optional[tuple[int, int]]:
    m = _STAT_RE.match(str(zt_stat or ""))
    return (int(m.group(1)), int(m.group(2))) if m else None


def board_label(boards: Any, zt_stat: Any = None) -> str:
    """连板标注:普通连板写「N板」;断板后反包的(涨停统计 N 天 M 板,N > M)写「N天M板」。

    东财「连板数」对反包票只给 1(今天重新涨停),单看它会写成「1板」,把回流反包结构抹掉 —— 所以优先用涨停统计。
    认两种写法:本仓库东财源的「N天M板」和 akshare 的「N/M」。
    """
    p = _parse_stat(zt_stat)
    if p:
        d, b = p
        if b > 0 and d > b:
            return f"{d}天{b}板"
        if b > 0:
            return f"{b}板"
    try:
        return f"{int(boards or 1)}板"
    except (TypeError, ValueError):
        return "1板"


def stat_boards(zt_stat: Any) -> int:
    """涨停统计里的 M(有效高度)。取不到给 0。"""
    p = _parse_stat(zt_stat)
    return p[1] if p else 0


# ---------------------------------------------------------------- 三池明细
def hhmmss(t: Any) -> str:
    """封板时间统一成 6 位 HHMMSS(东财给整数 92500 / 本仓库别处写 09:25:00);0 和缺失都当没有。"""
    s = str(t if t is not None else "").strip().replace(":", "")
    if not s.isdigit() or int(s) == 0:
        return ""
    return s.zfill(6)


def _num(v: Any) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _price(v: Any) -> Optional[float]:
    f = _num(v)
    return None if f is None else f / 1000


def _int(v: Any) -> Optional[int]:
    f = _num(v)
    return None if f is None else int(f)


def _stat(p: dict) -> Optional[str]:
    z = p.get("zttj") or {}
    days, ct = _int(z.get("days")), _int(z.get("ct"))
    return f"{days}天{ct}板" if days is not None and ct is not None else None


def _base(p: dict) -> Optional[dict]:
    code = str(p.get("c") or "").strip().zfill(6)
    if not code.strip("0"):
        return None
    name = str(p.get("n") or "")
    return {"code": code, "name": name, "board": board_of(code, name), "ret": _num(p.get("zdp")),
            "close": _price(p.get("p")), "turnover": _num(p.get("hs")), "sector": str(p.get("hybk") or "")}


def _zt_row(p: dict) -> Optional[dict]:
    r = _base(p)
    if r is None:
        return None
    r.update({"amount": _num(p.get("amount")), "float_cap": _num(p.get("ltsz")), "seal_fund": _num(p.get("fund")),
              "first_seal": hhmmss(p.get("fbt")), "last_seal": hhmmss(p.get("lbt")), "broken_times": _int(p.get("zbc")) or 0,
              "boards": _int(p.get("lbc")) or 1, "zt_stat": _stat(p)})
    return r


def _zb_row(p: dict) -> Optional[dict]:
    r = _base(p)
    if r is None:
        return None
    r.update({"limit_price": _price(p.get("ztp")), "first_seal": hhmmss(p.get("fbt")), "broken_times": _int(p.get("zbc")) or 0,
              "amplitude": _num(p.get("zf")), "zt_stat": _stat(p)})
    return r


def _dt_row(p: dict) -> Optional[dict]:
    r = _base(p)
    if r is None:
        return None
    r.update({"seal_fund": _num(p.get("fund")), "last_seal": hhmmss(p.get("lbt")), "consec_dt": _int(p.get("days")) or 1,
              "open_times": _int(p.get("oc")) or 0})
    return r


_API = {"zt": ("getTopicZTPool", "fbt:asc", _zt_row), "zb": ("getTopicZBPool", "fbt:asc", _zb_row), "dt": ("getTopicDTPool", "fund:asc", _dt_row)}
# 这些列缺了就整池不用(当取数失败):缺开板次数会被算成「一次没炸过」,缺连板数会被算成首板(10-11 实测这几列都在)
_REQUIRED = {"zt": ("zbc", "lbc"), "zb": ("zbc",), "dt": (), "yzt": ("ylbc",)}


def _check_required(kind: str, raw: list[dict]) -> None:
    for f in _REQUIRED[kind]:
        bad = sum(1 for p in raw if p.get(f) in (None, "", "-") and _base(p) is not None)   # 代码无效的行本来就丢
        if bad:
            raise RuntimeError(f"东财{kind}池有 {bad} 行缺「{f}」,上游格式可能变了;不按默认值补")
_POOL: dict[tuple[str, str], list[dict]] = {}
_FIELDS: dict[tuple[str, str], list[str]] = {}


def _keys(raw: list) -> list[str]:
    """上游原始行的键(带一层子键,如 zttj.days),所有行取并集、排序。用来看数据源改没改字段。"""
    ks: set[str] = set()
    for p in raw:
        if isinstance(p, dict):
            for k, v in p.items():
                ks.add(str(k))
                if isinstance(v, dict):
                    ks.update(f"{k}.{s}" for s in v)
    return sorted(ks)


def raw_fields(kind: str, day: str) -> Optional[list[str]]:
    """本进程里取过的某张池子的上游原始字段清单(zt / zb / dt / yzt 昨日涨停);没取过或池子为空 = None(不知道)。"""
    return _FIELDS.get((kind, compact(day)))


def pool(kind: str, day: str) -> list[dict]:
    """某日某一池的明细(zt 涨停 / zb 炸板 / dt 跌停)。取数失败照样抛出,空池返回 [](由调用方决定空意味着什么)。"""
    d = compact(day)
    key = (kind, d)
    if key not in _POOL:
        api, sort, row = _API[kind]
        raw = em._em_zt_api(api, sort, d)
        if raw:
            _FIELDS[key] = _keys(raw)
        _check_required(kind, raw)
        rows = [r for r in (row(p) for p in raw) if r is not None]
        _POOL[key] = rows
    return _POOL[key]


def pools(day: str) -> Optional[dict]:
    """某日三池的明细。任一池取数失败,或涨停池为空(非交易日 / 数据还没出),返回 None —— 不把失败伪装成空表。"""
    try:
        zt = pool("zt", day)
        if not zt:
            return None
        return {"zt": zt, "zb": pool("zb", day), "dt": pool("dt", day)}
    except Exception:  # noqa: BLE001  取不到就是取不到,由调用方如实报原因
        return None


def zt_pool(day: str) -> Optional[list[dict]]:
    """只要涨停池(晋级率 / 梯队 / 周期只用它);失败或为空返回 None。"""
    try:
        return pool("zt", day) or None
    except Exception:  # noqa: BLE001
        return None


_SETTLED: dict[str, list[dict]] = {}
_SETTLED_NORET: dict[str, list[dict]] = {}   # 代码有效、但当天涨跌幅缺的行(只用来算覆盖率)


def settled_pool(day: str) -> Optional[list[dict]]:
    """`day` 那一场的定稿记录:昨日涨停股在 `day` 当天的表现(东财「昨日涨停」池)。

    每行自带 ret(该股在 day 的涨跌幅)、prev_boards、close、limit_price —— 「昨天进去的人赚不赚钱」这一整段
    不需要实时行情也算得出,而且任何历史日期都取得到。🔴 复盘类指标必须优先走这条路:实时行情一开盘就变成
    今天的价,算不了昨天那一场。
    ⚠️ 只覆盖昨日**涨停**那批,不含昨日炸板股。
    """
    d = compact(day)
    if d not in _SETTLED:
        try:
            raw = em._em_zt_api("getYesterdayZTPool", "zs:desc", d)
        except Exception:  # noqa: BLE001
            return None
        if raw:
            _FIELDS[("yzt", d)] = _keys(raw)
        try:
            _check_required("yzt", raw)
        except RuntimeError:
            return None
        rows: list[dict] = []
        noret: list[dict] = []
        for p in raw:
            r = _base(p)
            if r is None:
                continue
            r.update({"prev_boards": _int(p.get("ylbc")) or 1, "seal_time": hhmmss(p.get("yfbt")),
                      "limit_price": _price(p.get("ztp")), "zt_stat": _stat(p)})
            (rows if r["ret"] is not None else noret).append(r)
        if not rows:
            return None
        _SETTLED[d], _SETTLED_NORET[d] = rows, noret
    return _SETTLED[d]


def settled_cov(day: str, n: int, scope: Optional[Callable[[dict], bool]] = None) -> dict:
    """定稿记录算出的指标的样本说明:`n` 只有涨跌幅;同一范围里缺涨跌幅的也算进名单。
    🔴 缺的行原来被悄悄丢掉、却报覆盖率 100%(partial=False 会进长期缓存)。"""
    miss = sum(1 for r in _SETTLED_NORET.get(compact(day), []) if scope is None or scope(r))
    total = n + miss
    return {"sample": n, "coverage": n, "expected_sample": total,
            "coverage_rate": round(n / total, 3) if total else None, "partial": miss > 0}


# ---------------------------------------------------------------- 实时行情兜底
_BATCH = 50   # 腾讯批量行情单次上限,取保守值


def live_quotes_are_close_of(day: str) -> tuple[bool, str]:
    """现在去拉实时行情,拿到的值能不能当作 `day` 的收盘涨跌幅?

    ⚠️ 只回答「实时行情这条路通不通」。为 False 不等于那一天算不出来 —— 已收盘的场次走定稿记录照样能算。
    """
    d, today = iso(day), today_sh()
    if d == today and not is_settled(d):
        return False, f"{d} 这一场还没收盘，实时行情不是它的收盘价 —— 要等收盘才有定稿数据"
    if d != latest_settled_session():
        return False, f"{d} 不是最近一个已收盘交易日；实时行情只有当前值，不能冒充历史收盘"
    if d < today and is_trade_day(today) and (now_sh().hour, now_sh().minute) >= (9, 15):
        return False, f"实时行情已经属于 {today} 这一场，不能当作 {d} 的收盘表现（已收盘场次改用定稿记录）"
    return True, ""


def batch_pct(codes: list, day: str, *, opening: bool = False) -> dict[str, float]:
    """批量取 `day` 那一场的涨跌幅 {code: pct};opening=True 取开盘价相对昨收的涨跌(竞价读数)。

    每条行情都核对成交时间属于 `day`(停牌股、节假日停在旧日期的行情直接丢掉);单批失败只丢该批。
    """
    d = compact(day)
    out: dict[str, float] = {}
    uniq = list(dict.fromkeys(str(c).zfill(6) for c in codes if c))
    for i in range(0, len(uniq), _BATCH):
        try:
            quotes = tencent_quotes(uniq[i:i + _BATCH])
        except Exception:  # noqa: BLE001  单批失败不拖累整体
            continue
        for code, q in quotes.items():
            stamp = str(q.get("quote_time") or "")
            if stamp[:8] != d:
                continue
            if opening:
                opened, previous = _num(q.get("open")), _num(q.get("last_close"))
                if stamp[8:12] < "0925" or not opened or not previous or opened <= 0 or previous <= 0:
                    continue
                out[str(code)[-6:]] = (opened / previous - 1) * 100
            else:
                v = _num(q.get("change_pct"))
                if v is not None:
                    out[str(code)[-6:]] = v
    return out
