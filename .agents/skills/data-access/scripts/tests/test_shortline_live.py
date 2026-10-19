"""盘中情绪(cn_shortline_live)。全程不联网。

行为沿用 Vibe AStock v2.0.0 的 live_emotion 测试(时段闸门、晋级率按昨日全部涨停算);
另测本仓库的改动:非交易日说明最近一个已收盘日、炸板率另取炸板池、1进2 与复盘同口径、赚钱效应、取不到的部分逐条说明。
"""
from __future__ import annotations

import json
import os
from datetime import datetime

import pytest

from common import TZ_SH
from test_registry_sources import _ctx
from sources import mappers_shortline as M
from sources import shortline as S
from sources import shortline_live as L
from sources._http import DataNotAvailable

REGISTRY = os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..", "datasources", "registry.json")


def _at(hm: str, day: str = "2026-10-09") -> datetime:
    return datetime.strptime(f"{day} {hm}", "%Y-%m-%d %H:%M").replace(tzinfo=TZ_SH)


def _zt(code: str, boards: int = 1) -> dict:
    return {"code": code, "name": f"股{code}", "boards": boards, "zt_stat": None}


def _setup(monkeypatch, *, now="10:30", trade=True, zt=None, zb=(), dt=(), prev_zt=None, settled=None):
    zt = [_zt("600001"), _zt("600002", 2), _zt("600003", 3)] if zt is None else zt
    monkeypatch.setattr(S, "now_sh", lambda: _at(now))
    monkeypatch.setattr(S, "is_trade_day", lambda d: trade)
    monkeypatch.setattr(S, "latest_settled_session", lambda: "2026-10-09")
    monkeypatch.setattr(S, "is_settled", lambda d: False)
    monkeypatch.setattr(S, "prev_trade_date", lambda d: "2026-10-08")
    side = {"zb": zb, "dt": dt}

    def pool(kind, d):
        rows = side[kind]
        if rows is None:
            raise RuntimeError("HTTP 502")
        return [_zt(c) for c in rows]
    monkeypatch.setattr(S, "pool", pool)
    pools = {"2026-10-09": zt or None, "2026-10-08": prev_zt}
    monkeypatch.setattr(S, "zt_pool", lambda d: pools.get(d))
    monkeypatch.setattr(S, "settled_pool", lambda d: settled)


def _mctx():
    return _ctx(symbol="MARKET", market="CN", source="eastmoney+calc", ep={"id": "cn_shortline_live"})


class TestPhase:
    @pytest.mark.parametrize("hm,label,ok", [
        ("09:14", "开盘前", False), ("09:15", "集合竞价", False), ("09:29", "集合竞价", False), ("09:30", "上午连续竞价", True),
        ("11:29", "上午连续竞价", True), ("11:30", "午间休市", True), ("12:59", "午间休市", True), ("13:00", "下午连续竞价", True),
        ("14:56", "下午连续竞价", True), ("14:57", "收盘集合竞价", False), ("14:59", "收盘集合竞价", False), ("15:00", "已收盘", True),
    ])
    def test_boundaries(self, hm, label, ok):
        assert L.session_phase(_at(hm)) == (label, ok)

    @pytest.mark.parametrize("hm,word", [("09:20", "09:30"), ("08:00", "09:30"), ("14:58", "15:00")])
    def test_gated_phases_say_when(self, monkeypatch, hm, word):
        _setup(monkeypatch, now=hm)
        with pytest.raises(DataNotAvailable, match=word):
            L.build_live()

    def test_non_trading_day_points_to_review(self, monkeypatch):
        _setup(monkeypatch, trade=False)
        with pytest.raises(DataNotAvailable, match="不是交易日.*2026-10-09"):
            L.build_live()

    def test_pool_missing_is_not_zero(self, monkeypatch):
        _setup(monkeypatch, zt=[])
        with pytest.raises(DataNotAvailable, match="涨停池没取到"):
            L.build_live()


class TestReadings:
    def test_counts_and_rates(self, monkeypatch):
        prev = [_zt("600001"), _zt("600002"), _zt("600003", 2), _zt("600009")]
        settled = [{"code": c, "ret": r} for c, r in (("600001", 10.0), ("600002", 10.0), ("600003", 10.0), ("600009", -6.0), ("600008", -5.0))]
        _setup(monkeypatch, zb=("600010",), dt=("600011", "600012"), prev_zt=prev, settled=settled)
        r = L.build_live()
        v = r["live"]
        assert (r["date"], r["as_of"], r["phase"], r["prev_date"]) == ("2026-10-09", "10:30:00", "上午连续竞价", "2026-10-08")
        assert (v["limit_up"], v["broken"], v["limit_down"], v["highest_board"], v["consec_count"]) == (3, 1, 2, 3, 2)
        assert (v["seal_rate"], v["broken_rate"]) == (0.75, 0.25), "分母 = 涨停 + 炸板未回封"
        assert (v["promotion_all"], v["promotion_all_base"], v["promotion_all_promoted"]) == (0.75, 4, 3), "昨日全部涨停 4 只今天又封住 3 只"
        assert (v["promotion_1to2"], v["promotion_base"], v["promotion_promoted"]) == (0.667, 3, 2), "1进2 只看昨日首板"
        assert (v["money_effect"], v["deep_loss"], v["sample"]) == (10.0, 2, 5), "恰好跌 5% 也算深亏"
        assert r["reasons"] == {}

    def test_lunch_break_and_after_close_still_read(self, monkeypatch):
        for hm, phase in (("12:00", "午间休市"), ("15:30", "已收盘")):
            _setup(monkeypatch, now=hm, prev_zt=[_zt("600001")])
            assert L.build_live()["phase"] == phase

    def test_prev_and_settled_missing_are_reasons_not_zero(self, monkeypatch):
        _setup(monkeypatch, prev_zt=None, settled=None)
        r = L.build_live()
        v = r["live"]
        assert v["promotion_all"] is None and v["promotion_1to2"] is None and v["money_effect"] is None
        assert set(r["reasons"]) == {"promotion", "settled"} and "2026-10-08" in r["reasons"]["promotion"]
        assert "未取到" in L.render_live(r)


    def test_side_pools_missing_keep_limit_up(self, monkeypatch):
        _setup(monkeypatch, zb=None, dt=None, prev_zt=[_zt("600001")], settled=[{"code": "600001", "ret": 1.0}])
        r = L.build_live()
        v = r["live"]
        assert v["limit_up"] == 3 and v["highest_board"] == 3, "炸板 / 跌停池没取到,涨停那几项照出(VA 同)"
        assert v["broken"] is None and v["limit_down"] is None and v["seal_rate"] is None and v["broken_rate"] is None
        assert set(r["reasons"]) == {"zb", "dt"} and "HTTP 502" in r["reasons"]["zb"]
        assert "炸板 —、跌停 —" in L.render_live(r)
        d = M.shortline_live_map(r, _mctx())
        assert d["status"] == "partial" and {m["field"] for m in d["missing"]} >= {"break_board_count", "limit_down_count", "seal_rate"}


class TestMapper:
    def test_evidence(self, monkeypatch):
        _setup(monkeypatch, zb=("600010",), prev_zt=[_zt("600001"), _zt("600009")], settled=[{"code": "600001", "ret": 3.0}])
        d = M.shortline_live_map(L.build_live(), _mctx())
        assert d.get("status") is None, "盘中快照不按 partial 处理,新鲜度靠 15 秒缓存上限"
        got = {(e["field"], e.get("record_key")): e["value"] for e in d["evidence"]}
        assert got[("limit_up_count", None)] == 3 and got[("break_board_count", None)] == 1
        assert got[("promotion_rate", "昨日全部涨停")] == 0.5 and got[("promotion_rate", "1进2")] == 0.5
        assert got[("money_effect_median_ret", None)] == 3.0
        assert len({e["id"] for e in d["evidence"]}) == len(d["evidence"])
        assert d["extra"]["phase"] == "上午连续竞价" and d["extra"]["text"].startswith("[盘中情绪 2026-10-09 10:30")

    def test_missing_parts_listed(self, monkeypatch):
        _setup(monkeypatch, prev_zt=None, settled=None)
        d = M.shortline_live_map(L.build_live(), _mctx())
        assert d["status"] == "partial"
        assert {m["field"] for m in d["missing"]} >= {"promotion_rate", "money_effect_median_ret"}


def test_registry_entry():
    reg = json.load(open(REGISTRY, encoding="utf-8"))
    e = next(x for x in reg["endpoints"] if x["id"] == "cn_shortline_live")
    assert e["cache_max_age_sec"] == 15, "盘中数随盘变化:快照最多用 15 秒"
    assert e["symbol_kind"] == "none" and e["computed"] is True and e["args"] is None
    assert e["module"] == "shortline_live" and callable(getattr(L, e["function"])) and callable(getattr(M, e["mapper"]))
