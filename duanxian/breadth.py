"""全市场涨跌宽度 —— 回答「今天到底好不好做」"""

from __future__ import annotations

from duanxian.paths import data_path
import json
import logging
import math
import os
import time
import urllib.request
from typing import Optional

from . import trade_calendar
from .util import atomic_write_json

logger = logging.getLogger(__name__)

_CACHE_DIR = data_path("cache/breadth")
_SCHEMA = 1

_UA = {"User-Agent": "Mozilla/5.0"}
_HOST = "https://push2delay.eastmoney.com"     # 本机 push2 被封，走延时源（复盘够用）
# 全 A：沪深主板 + 创业板 + 科创板 + 北交所
_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"
_PZ = 100
_SLEEP = 0.35                                  # 二分探测之间的节流，别把源打毛
_PROBE_SPAN = 3                                # 探到空页时向两侧最多找几页
_TIMEOUT = 25

_INDEX_IDS = ("1.000001", "0.399001")


def _get(url: str, retries: int = 2) -> dict:
    """带一次重试"""
    if retries < 1:
        raise ValueError(f"retries 必须 >= 1，得到 {retries}")   # 别伪装成"请求失败"
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=_UA)
            with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except Exception as exc:  # noqa: BLE001
            last = exc
            if i + 1 < retries:
                time.sleep(0.8)
    raise last if last else RuntimeError("请求失败")


def _index_breadth() -> Optional[dict]:
    """沪深两市涨跌平家数 + 成交额。一个请求。"""
    url = (f"{_HOST}/api/qt/ulist.np/get?fltt=2&secids={','.join(_INDEX_IDS)}"
           f"&fields=f1,f2,f3,f6,f104,f105,f106")
    try:
        diff = ((_get(url).get("data") or {}).get("diff")) or []
        if len(diff) < len(_INDEX_IDS):
            return None

        def _num(row, key):
            v = row.get(key)
            # math.isfinite 挡掉 NaN / inf —— 它们都是 float，isinstance 拦不住
            return float(v) if isinstance(v, (int, float)) and math.isfinite(v) else None

        up = down = flat = 0
        amount = 0.0
        for row in diff:
            if not isinstance(row, dict):
                return None
            u, d, f, a = (_num(row, "f104"), _num(row, "f105"),
                          _num(row, "f106"), _num(row, "f6"))
            if None in (u, d, f, a) or min(u, d, f, a) < 0:
                return None
            up, down, flat, amount = up + int(u), down + int(d), flat + int(f), amount + a
        return {"up": up, "down": down, "flat": flat, "amount_yi": round(amount / 1e8, 1)}
    except Exception as exc:  # noqa: BLE001
        logger.warning("取指数宽度失败：%s: %s", type(exc).__name__, exc)
        return None


def _env_value(key: str) -> str:
    """读单个配置键：环境变量优先，回退仓库根 .env（不写回 os.environ）。"""
    v = (os.environ.get(key) or "").strip().strip('"').strip("'")
    if v:
        return v
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        with open(os.path.join(root, ".env"), encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if line.startswith("export "):
                    line = line[len("export "):]
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, val = line.split("=", 1)
                if k.strip() == key:
                    return val.strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def _tushare_breadth(date: str) -> Optional[dict]:
    """东财取不到时的降级源（Tushare 日线）。未配置/报错 → None。

    ⚠️ 口径与东财**不同**，调用方必须如实改掉 scope 文案，不能沿用东财那句：
    涨跌家数与成交额按「沪深 A 股全体」统计（剔除北交所），
    东财原口径是指数成分口径；分布两项仍是全 A 含北交所，与东财一致。
    """
    token = _env_value("TUSHARE_TOKEN")
    if not token:
        return None
    try:
        import tushare as ts
    except Exception:  # noqa: BLE001  没装 tushare 就不降级
        return None
    try:
        pro = ts.pro_api(token)
        df = pro.daily(trade_date=date.replace("-", ""), fields="ts_code,pct_chg,amount")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Tushare 宽度降级失败：%s: %s", type(exc).__name__, exc)
        return None
    if df is None or df.empty:
        return None
    code = df["ts_code"].astype(str)
    hs = df[~code.str.endswith(".BJ")]         # 沪深 A 股（不含北交所）
    pct = hs["pct_chg"].dropna()
    all_pct = df["pct_chg"].dropna()
    amount = float(hs["amount"].dropna().sum()) * 1000   # 千元 → 元
    return {
        "up": int((pct > 0).sum()), "down": int((pct < 0).sum()), "flat": int((pct == 0).sum()),
        "amount_yi": round(amount / 1e8, 1),
        "universe": int(len(df)),
        "deep_up_5_incl": int((all_pct >= 5).sum()),
        "deep_down_5": int((all_pct < -5).sum()),
    }


def _page(pn: int) -> tuple[int, list[float]]:
    """按涨跌幅**升序**的第 pn 页。返回 `(全市场只数, 可用涨跌幅列表, 原始行数)`"""
    url = (f"{_HOST}/api/qt/clist/get?pn={pn}&pz={_PZ}&po=0&np=1&fltt=2&invt=2"
           f"&fid=f3&fs={_FS}&fields=f3")
    d = _get(url).get("data")
    if not isinstance(d, dict):
        raise ValueError(f"第 {pn} 页响应没有 data")
    diff = d.get("diff")
    if not isinstance(diff, list):
        raise ValueError(f"第 {pn} 页响应没有 diff")
    total = d.get("total")
    if not isinstance(total, int) or total <= 0:
        raise ValueError(f"第 {pn} 页 total 不合法：{total!r}")
    vals = [float(x["f3"]) for x in diff
            if isinstance(x, dict) and isinstance(x.get("f3"), (int, float))]
    return total, vals, len(diff)


def _rank_below(total: int, thr: float, calls: list) -> Optional[int]:
    """升序表里涨跌幅 < thr 的只数。二分定位到页，再在页内数"""
    max_pn = max(1, (total + _PZ - 1) // _PZ)
    lo, hi = 1, max_pn

    def probe(pn: int, lo_: int, hi_: int):
        """从 pn 出发就近找一个**有值**的页。返回 (页号, vals) 或 None。"""
        for delta in range(0, _PROBE_SPAN + 1):
            for cand in ((pn,) if delta == 0 else (pn - delta, pn + delta)):
                if not (lo_ <= cand <= hi_):
                    continue
                t, vals, raw = _page(cand)
                calls[0] += 1
                time.sleep(_SLEEP)
                if cand != max_pn and raw != _PZ:
                    raise ValueError(f"第 {cand} 页只有 {raw} 行（非末页应满 {_PZ} 行）")
                if t != total:
                    raise ValueError(f"全市场只数中途变了：{total} → {t}")
                if vals:
                    return cand, vals
        return None

    try:
        guard = 0
        while lo < hi:
            guard += 1
            if guard > max_pn + 8:       # 防"探到的页不是 mid"导致的收敛停滞
                logger.warning("二分定位 %.1f%% 边界未收敛，放弃", thr)
                return None
            got = probe((lo + hi) // 2, lo, hi)
            if got is None:
                logger.warning("二分定位 %.1f%% 边界：附近全是无数据页，判不出方向", thr)
                return None
            pn, vals = got
            if vals[-1] < thr:
                lo = pn + 1
            else:
                hi = pn
        got = probe(lo, lo, max_pn)
        if got is None:
            return None
        pn, vals = got
        if pn != lo:
            logger.warning("二分定位 %.1f%% 边界：目标页无值，放弃", thr)
            return None
        return (lo - 1) * _PZ + sum(1 for v in vals if v < thr)
    except Exception as exc:  # noqa: BLE001
        logger.warning("二分定位 %.1f%% 边界失败：%s: %s", thr, type(exc).__name__, exc)
        return None


def _cache_path(date: str) -> str:
    return os.path.join(_CACHE_DIR, f"{date}.json")


def _num_ok(v: object) -> bool:
    """是不是一个可用的非负有限数"""
    return (isinstance(v, (int, float)) and not isinstance(v, bool)
            and math.isfinite(v) and v >= 0)


def up5_of(d: dict) -> object:
    """读「涨幅≥5% 家数」，**兼容改名前的旧字段**"""
    v = d.get("deep_up_5_incl")
    return v if v is not None else d.get("deep_up_5")


def _payload_ok(d: object) -> bool:
    """缓存里那份 `data` 是不是完整可用"""
    if not isinstance(d, dict) or d.get("available") is not True:
        return False
    for k in ("up_down_scope", "dist_scope"):
        if not isinstance(d.get(k), str) or not d[k]:
            return False
    if not all(_num_ok(d.get(k)) for k in ("up", "down", "flat", "amount_yi")):
        return False
    for k in ("dist_available", "dist_partial"):
        if not isinstance(d.get(k), bool):
            return False
    if d["dist_available"]:
        # 声称有分布 → 必须真的有：只数合法，且至少一项分布值是合法数
        if not _num_ok(d.get("universe")):
            return False
        if not any(_num_ok(v) for v in (up5_of(d), d.get("deep_down_5"))):
            return False
    return True


def market_breadth(date: str) -> dict:
    """`date` 收盘时的全市场宽度。历史日走落盘缓存，零网络。

    返回里 `available=False` 时一定带 `reason` —— **绝不用 0 或空充数**。
    """
    path = _cache_path(date)
    if os.path.isfile(path):
        try:
            with open(path, encoding="utf-8") as fh:
                env = json.load(fh)
            if (isinstance(env, dict) and env.get("schema") == _SCHEMA
                    and env.get("date") == date and _payload_ok(env.get("data"))):
                return env["data"]
        except Exception:  # noqa: BLE001  缓存坏了当没有，重新取
            pass

    ok, why = trade_calendar.live_quotes_are_close_of(date)
    if not ok:
        return {"available": False, "reason": why}

    calls = [0]
    idx = _index_breadth()
    calls[0] += 1
    fb = None
    if idx is None:
        # 东财不可达 → Tushare 日线降级（口径不同，见 _tushare_breadth 注释）
        fb = _tushare_breadth(date)
        calls[0] += 1
        if fb is None:
            return {"available": False, "reason": "取全市场涨跌家数失败（数据源不可用）"}
        idx = fb

    total = 0
    up5 = down5 = None
    dist_scope = "全 A（含北交所）"
    if fb is not None:
        # 降级源一次就拿到全市场，不需要分页二分
        total, up5, down5 = fb["universe"], fb["deep_up_5_incl"], fb["deep_down_5"]
    else:
        try:
            total, _, _ = _page(1)
            calls[0] += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("取全市场只数失败，分布这几项本次不给：%s: %s", type(exc).__name__, exc)
        if total:
            down5 = _rank_below(total, -5.0, calls)
            up5_below = _rank_below(total, 5.0, calls)
            up5 = (total - up5_below) if up5_below is not None else None
        else:
            # 涨跌家数走的是 ulist.np（可能通），分布走 clist（可能不通）——
            # 只补分布这三项，家数仍用已取到的东财口径，两边的 scope 分开写清楚。
            dist = _tushare_breadth(date)
            calls[0] += 1
            if dist is not None:
                total, up5, down5 = dist["universe"], dist["deep_up_5_incl"], dist["deep_down_5"]
                dist_scope = "全 A（含北交所，Tushare 降级源）"

    out = {
        "available": True,
        "date": date,
        # 口径如实写出来，别声称"全市场"；降级源的统计范围不同，也必须换掉这句
        "up": idx["up"], "down": idx["down"], "flat": idx["flat"],
        "up_down_scope": ("沪深 A 股全体（Tushare 降级源，剔除北交所）" if fb is not None
                          else "沪深两市（不含北交所）"),
        "amount_yi": idx["amount_yi"],
        # 下面三项是全 A（含北交所）的排名统计
        "universe": total,
        "deep_up_5_incl": up5, "deep_down_5": down5,
        "dist_scope": dist_scope,
        "dist_available": any(v is not None for v in (up5, down5)),
        "dist_partial": any(v is None for v in (up5, down5)),
        "requests": calls[0],
    }
    if trade_calendar.is_settled(date):
        atomic_write_json(path, {"schema": _SCHEMA, "date": date, "data": out})
    return out


def render(b: dict) -> str:
    """喂 prompt 的文本块。取不到就明说，不编。"""
    if not b.get("available"):
        return f"· 全市场涨跌宽度：不可用（{b.get('reason', '未知')}）"
    up, down, flat = b["up"], b["down"], b["flat"]
    tot = up + down + flat
    ratio = f"{up}涨 / {down}跌 / {flat}平" + (f"（上涨占比 {up / tot:.0%}）" if tot else "")
    line = (f"· 全市场宽度[{b['up_down_scope']}]：{ratio}；"
            f"两市成交额 {b['amount_yi']:.0f} 亿")
    if b.get("dist_available"):
        parts = []
        if up5_of(b) is not None:
            parts.append(f"涨幅≥5% {up5_of(b)} 家")
        if b.get("deep_down_5") is not None:
            parts.append(f"跌超5% {b['deep_down_5']} 家")
        line += f"。涨跌分布[{b['dist_scope']}，共 {b['universe']} 只]：" + "、".join(parts)
        if b.get("dist_partial"):
            line += "（其余几项本次取数失败，未取到 ≠ 为 0）"
    else:
        line += "。涨跌分布取数失败，本次不给（不要据此认为分布正常）"
    return line
