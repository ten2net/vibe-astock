"""盯盘名单(cn_shortline_ladder / cn_shortline_turnover_top / cn_shortline_bigcaps)。全程不联网。

昨日梯队沿用 Vibe AStock v2.0.0 tests/test_previous_ladder.py 的取名单几条(日历取不到不猜工作日、节假日取准确的前一场、
取不到不当 0 只、异常行不交名单、没接上的也留着);封板状态和盯盘轮询在界面里做,那几条测试跟着界面走。
另测本仓库新加的两份名单:成交额前十(通达信盘后包)、大市值(新浪按市值排序)。
"""
from __future__ import annotations

import json
import os
from datetime import datetime

import pandas as pd
import pytest

from common import TZ_SH
from test_registry_sources import _ctx
from sources import astock_ported as P
from sources import mappers_shortline as M
from sources import shortline as S
from sources import shortline_watch as W
from sources import sina
from sources._http import DataNotAvailable

REGISTRY = os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..", "datasources", "registry.json")


def _zt(code: str, boards: int = 1, **kw) -> dict:
    return {"code": code, "name": f"股{code}", "boards": boards, "zt_stat": None, "sector": "甲", "first_seal": "09:31:00", "broken_times": 0, **kw}


def _cal(monkeypatch, *, today="2026-10-09", trade=True, prev="2026-10-08"):
    monkeypatch.setattr(S, "today_sh", lambda: today)
    monkeypatch.setattr(S, "is_trade_day", lambda d: trade if d == today else True)
    monkeypatch.setattr(S, "prev_trade_date", lambda d: prev)


def _mctx(ep_id: str, source: str = "eastmoney+calc"):
    return _ctx(symbol="MARKET", market="CN", source=source, ep={"id": ep_id})


# ================================================================ 昨日梯队
class TestLadder:
    def test_calendar_failure_does_not_guess_weekday(self, monkeypatch):
        _cal(monkeypatch, prev=None)
        with pytest.raises(DataNotAvailable, match="不按工作日猜"):
            W.build_ladder("2026-10-09")

    def test_holiday_uses_exact_previous_session(self, monkeypatch):
        _cal(monkeypatch, today="2026-10-08", prev="2026-09-30")
        seen = []
        monkeypatch.setattr(S, "pool", lambda kind, d: seen.append((kind, d)) or [_zt("000001", 3)])
        r = W.build_ladder("2026-10-08")
        assert seen == [("zt", "2026-09-30")]
        assert (r["sample_date"], r["quote_date"], r["stocks"][0]["boards"]) == ("2026-09-30", "2026-10-08", 3)

    def test_no_date_on_weekend_watches_last_session(self, monkeypatch):
        _cal(monkeypatch, today="2026-10-10", trade=False, prev="2026-10-09")
        monkeypatch.setattr(S, "pool", lambda kind, d: [_zt("000001")])
        r = W.build_ladder()
        assert r["quote_date"] == "2026-10-09", "周六盯的是周五那一场(VA 同:行情停在周五)"

    def test_future_and_non_trading_rejected(self, monkeypatch):
        _cal(monkeypatch)
        with pytest.raises(ValueError, match="还没到"):
            W.build_ladder("2026-10-12")
        monkeypatch.setattr(S, "is_trade_day", lambda d: False)
        with pytest.raises(DataNotAvailable, match="不是交易日"):
            W.build_ladder("2026-10-03")

    def test_unavailable_pool_is_not_zero_samples(self, monkeypatch):
        _cal(monkeypatch)

        def boom(kind, d):
            raise RuntimeError("HTTP 502")
        monkeypatch.setattr(S, "pool", boom)
        with pytest.raises(DataNotAvailable, match="没取到.*HTTP 502.*不改用其他日期"):
            W.build_ladder("2026-10-09")

    def test_empty_pool_is_not_zero_samples(self, monkeypatch):
        _cal(monkeypatch)
        monkeypatch.setattr(S, "pool", lambda kind, d: [])
        with pytest.raises(DataNotAvailable, match="不当成 0 只"):
            W.build_ladder("2026-10-09")

    @pytest.mark.parametrize("bad", [[_zt("00001")], [_zt("000001"), _zt("000001")], [_zt("000001", 0)], [{**_zt("000001"), "boards": None}]])
    def test_bad_pool_rows_are_disclosed(self, monkeypatch, bad):
        _cal(monkeypatch)
        monkeypatch.setattr(S, "pool", lambda kind, d: bad)
        with pytest.raises(DataNotAvailable, match="异常行"):
            W.build_ladder("2026-10-09")

    def test_sorted_by_boards_and_every_member_kept(self, monkeypatch):
        _cal(monkeypatch)
        monkeypatch.setattr(S, "pool", lambda kind, d: [_zt("600003", 1), _zt("600002", 3, zt_stat="5天3板"), _zt("600001", 1), _zt("600004", 2)])
        r = W.build_ladder("2026-10-09")
        assert [s["code"] for s in r["stocks"]] == ["600002", "600004", "600001", "600003"]
        assert r["stocks"][0]["label"] == "5天3板" and (r["total"], r["highest"]) == (4, 3)
        assert r["tiers"] == [{"boards": 3, "count": 1}, {"boards": 2, "count": 1}, {"boards": 1, "count": 2}]
        assert "连板：股600002(600002) 5天3板；股600004(600004) 2板" in W.render_ladder(r)

    def test_mapper(self, monkeypatch):
        _cal(monkeypatch)
        monkeypatch.setattr(S, "pool", lambda kind, d: [_zt("600002", 3), _zt("600001", 1)])
        d = M.shortline_ladder_map(W.build_ladder("2026-10-09"), _mctx("cn_shortline_ladder"))
        assert d.get("status") is None, "样本日已收盘,结果不变"
        got = {(e["field"], e.get("record_key")): (e["value"], e["period"]) for e in d["evidence"]}
        assert got[("ladder_sample_count", None)] == (2, "2026-10-08") and got[("ladder_highest", None)] == (3, "2026-10-08")
        assert got[("ladder_tier_count", "3板")][0] == 1 and got[("ladder_boards", "600001")][0] == 1
        assert len({e["id"] for e in d["evidence"]}) == len(d["evidence"])
        assert d["extra"]["quote_date"] == "2026-10-09"


# ================================================================ 成交额前十
def _frame(rows, day="2026-10-09"):
    return pd.DataFrame([{"date": day, "market": m, "code": c, "name": n, "prev_close": pc, "close": cl, "amount": amt, "source_url": "https://tdx/x.zip"}
                         for m, c, n, pc, cl, amt in rows])


_ROWS = [("sh", "000001", "上证指数", 3800.0, 3810.0, 9e11), ("sz", "000001", "平安银行", 10.0, 11.0, 5e9), ("sh", "600519", "贵州茅台", 1500.0, 1470.0, 8e9),
         ("sh", "900901", "B股", 1.0, 1.0, 9e9), ("sz", "200002", "B股深", 1.0, 1.0, 9e9), ("bj", "920001", "北交", 10.0, 13.0, 1e9),
         ("bj", "899050", "北证50", 1000.0, 1000.0, 9e10), ("sh", "510300", "沪深300ETF", 4.0, 4.0, 9e10), ("sz", "300750", "宁德时代", 200.0, 0.0, 0.0),
         ("sz", "300308", "中际旭创", 100.0, 99.0, 2e10)]


class TestTurnoverTop:
    @pytest.mark.parametrize("market,code,ok", [("sh", "000001", False), ("sz", "000001", True), ("sh", "900901", False), ("sz", "200002", False),
                                                 ("bj", "920001", True), ("bj", "899050", False), ("sh", "688256", True), ("sz", "301536", True), ("sh", "510300", False)])
    def test_a_share_segments(self, market, code, ok):
        assert W.is_a_share(market, code) is ok

    def test_top_by_amount_a_shares_only(self, monkeypatch):
        monkeypatch.setattr(P, "tdx_daily_package", lambda d: _frame(_ROWS))
        monkeypatch.setattr(S, "review_day", lambda d: d)
        monkeypatch.setattr(S, "today_sh", lambda: "2026-10-10")
        r = W.build_turnover_top("2026-10-09", top=3)
        assert [(s["rank"], s["code"]) for s in r["stocks"]] == [(1, "300308"), (2, "600519"), (3, "000001")], "指数 / B 股 / ETF / 没成交的不算"
        assert r["stocks"][1]["pct"] == -2.0 and r["stocks"][2]["name"] == "平安银行" and r["total_traded"] == 4

    def test_package_date_must_match(self, monkeypatch):
        monkeypatch.setattr(P, "tdx_daily_package", lambda d: _frame(_ROWS, day="2026-10-08"))
        monkeypatch.setattr(S, "review_day", lambda d: d)
        monkeypatch.setattr(S, "today_sh", lambda: "2026-10-10")
        with pytest.raises(DataNotAvailable, match="不是 2026-10-09"):
            W.build_turnover_top("2026-10-09")

    def test_today_before_publish_hour(self, monkeypatch):
        monkeypatch.setattr(S, "review_day", lambda d: d)
        monkeypatch.setattr(S, "today_sh", lambda: "2026-10-09")
        monkeypatch.setattr(S, "now_sh", lambda: datetime(2026, 10, 9, 16, 30, tzinfo=TZ_SH))
        with pytest.raises(DataNotAvailable, match="17 点后"):
            W.build_turnover_top("2026-10-09")

    def test_top_range(self):
        with pytest.raises(ValueError):
            W.build_turnover_top("2026-10-09", top=0)

    def test_mapper_same_fields_as_em_rank(self, monkeypatch):
        monkeypatch.setattr(P, "tdx_daily_package", lambda d: _frame(_ROWS))
        monkeypatch.setattr(S, "review_day", lambda d: d)
        monkeypatch.setattr(S, "today_sh", lambda: "2026-10-10")
        d = M.shortline_turnover_top_map(W.build_turnover_top("2026-10-09", top=2), _mctx("cn_shortline_turnover_top", "tdx+calc"))
        assert d.get("status") is None
        got = {(e["field"], e.get("record_key")): e for e in d["evidence"]}
        e = got[("turnover_amount", "stock|300308")]
        assert (e["value"], e["unit"], e["currency"], e["period"]) == (2e10, "元", "CNY", "2026-10-09")
        assert got[("turnover_rank", "stock|600519")]["value"] == 2


# ================================================================ 大市值
def _sina_pages(pages):
    calls = []

    def fake(path, params):
        calls.append(params["page"])
        return pages[params["page"] - 1] if params["page"] <= len(pages) else []
    return fake, calls


def _x(code, cap_yi):
    return {"code": code, "name": f"股{code}", "mktcap": cap_yi * 1e4, "trade": "10.0", "changepercent": "1.5"}


class TestBigcaps:
    def _now(self, monkeypatch, hm=(10, 0), trade=True):
        monkeypatch.setattr(S, "now_sh", lambda: datetime(2026, 10, 9, *hm, tzinfo=TZ_SH))
        monkeypatch.setattr(S, "is_trade_day", lambda d: trade)
        monkeypatch.setattr(S, "prev_trade_date", lambda d: "2026-10-08")

    def test_pages_until_below_floor_and_dedupes(self, monkeypatch):
        self._now(monkeypatch)
        fake, calls = _sina_pages([[_x("600001", 3000), _x("600002", 900)], [_x("600002", 900), _x("600003", 600), _x("600004", 499.9), _x("600005", 800)]])
        monkeypatch.setattr(sina, "_sina_list", fake)
        r = W.build_bigcaps(500)
        assert [s["code"] for s in r["stocks"]] == ["600001", "600002", "600003"], "翻页重复的去掉;低于门槛就停"
        assert calls == [1, 2] and r["stocks"][0]["mcap"] == 3000 * 1e8, "新浪市值是万元"
        assert r["date"] == "2026-10-09"

    def test_never_reaching_floor_is_not_half_list(self, monkeypatch):
        self._now(monkeypatch)
        monkeypatch.setattr(sina, "_sina_list", lambda path, params: [_x(f"6{params['page']:05d}", 9000)])
        with pytest.raises(DataNotAvailable, match="不交半份"):
            W.build_bigcaps(500)

    def test_empty_page_before_floor_is_not_a_full_list(self, monkeypatch):
        """新浪翻过最后一页回空列表、不报错(10-11 实测);还没到门槛就空了 = 名单不全(审计 2026-10-11 Opus 范围 1 待核实第 5 条)。"""
        self._now(monkeypatch)
        fake, calls = _sina_pages([[_x("600001", 3000), _x("600002", 900)]])
        monkeypatch.setattr(sina, "_sina_list", fake)
        with pytest.raises(DataNotAvailable, match="第 2 页是空的"):
            W.build_bigcaps(500)
        assert calls == [1, 2]

    @pytest.mark.parametrize("hm,trade,day", [((10, 0), True, "2026-10-09"), ((9, 10), True, "2026-10-08"), ((10, 0), False, "2026-10-08")])
    def test_quote_day(self, monkeypatch, hm, trade, day):
        self._now(monkeypatch, hm, trade)
        monkeypatch.setattr(sina, "_sina_list", _sina_pages([[_x("600001", 3000), _x("600004", 1)]])[0])
        assert W.build_bigcaps(500)["date"] == day, "周六 / 开盘前取到的是上一交易日的收盘"

    def test_mapper(self, monkeypatch):
        self._now(monkeypatch, trade=False)
        monkeypatch.setattr(sina, "_sina_list", _sina_pages([[_x("600001", 3000), _x("600004", 1)]])[0])
        d = M.shortline_bigcaps_map(W.build_bigcaps(500), _mctx("cn_shortline_bigcaps", "sina"))
        got = {(e["field"], e.get("record_key")): e for e in d["evidence"]}
        assert got[("bigcap_count", None)]["value"] == 1
        e = got[("market_cap", "stock|600001")]
        assert (e["value"], e["currency"], e["period"]) == (3000 * 1e8, "CNY", "2026-10-08")


def test_registry_entries():
    reg = json.load(open(REGISTRY, encoding="utf-8"))
    by_id = {e["id"]: e for e in reg["endpoints"]}
    for ep_id, args, cache in (("cn_shortline_ladder", {"date"}, None), ("cn_shortline_turnover_top", {"date", "top"}, None), ("cn_shortline_bigcaps", {"min_cap_yi"}, 3600)):
        e = by_id[ep_id]
        assert e["symbol_kind"] == "none" and e["computed"] is True and set(e["args"]) == args and e["module"] == "shortline_watch"
        assert e.get("cache_max_age_sec") == cache, ep_id
        assert callable(getattr(W, e["function"])) and callable(getattr(M, e["mapper"]))
