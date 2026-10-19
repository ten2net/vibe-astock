"""连板天梯与题材轮动(cn_shortline_board_ladder / cn_shortline_theme_rotation)。全程不联网。

重点:缺数不写成 0(前一天的池子没取到就不出晋级数,某天题材串没取到那一格是 None);
最高标断板那一档今天没人也要留一行;状态词只由读数推出。
"""
from __future__ import annotations

import pytest

from test_registry_sources import _ctx
from sources import mappers_shortline as M
from sources import shortline as S
from sources import shortline_boards as B
from sources import shortline_themes as T

DAY, PREV = "2026-10-09", "2026-10-08"


def _mctx(ep_id: str):
    return _ctx(symbol="MARKET", market="CN", source="eastmoney+ths+calc", ep={"id": ep_id})


def _zt(code: str, boards: int = 1, *, stat: str | None = None, first: str = "093000", broken: int = 0) -> dict:
    return {"code": code, "name": f"股{code}", "board": S.board_of(code), "ret": 10.0, "close": 11.0, "amount": 1e8,
            "float_cap": 5e9, "turnover": 3.0, "seal_fund": 2e7, "sector": "甲", "boards": boards, "zt_stat": stat,
            "first_seal": first, "last_seal": first, "broken_times": broken}


def _row(code: str, ret: float | None = None) -> dict:
    return {"code": code, "name": f"股{code}", "ret": ret}


# ================================================================ 连板天梯
def _ladder(monkeypatch, today, prev_zt, *, reasons=None, settled_rows=None, settled=True) -> dict:
    monkeypatch.setattr(S, "pools", lambda d: today if d == DAY else None)
    monkeypatch.setattr(S, "zt_pool", lambda d: prev_zt if d == PREV else None)
    monkeypatch.setattr(S, "settled_pool", lambda d: settled_rows)
    monkeypatch.setattr(T, "limit_reasons", lambda d: (reasons, "来源：测试") if reasons else ({}, "同花顺涨停揭秘：HTTP 502"))
    monkeypatch.setattr(S, "review_day", lambda d: DAY)
    monkeypatch.setattr(S, "prev_trade_date", lambda d: PREV)
    monkeypatch.setattr(S, "is_settled", lambda d: settled)
    return B.build_board_ladder(DAY)


def _full(monkeypatch, **kw) -> dict:
    today = {"zt": [_zt("600001", 4, first="092500"), _zt("600002", 2, first="093100"), _zt("600003", 1, stat="3天2板", first="094000"),
                    _zt("600004", 1, first="100000")],
             "zb": [_row("600012", 3.5)], "dt": [_row("600013", -10.0)]}
    prev_zt = [_zt("600001", 3), _zt("600011", 5), _zt("600002", 1), _zt("600012", 1), _zt("600013", 1), _zt("600014", 1), _zt("600015", 1)]
    settled_rows = [{"code": "600011", "ret": -6.2}, {"code": "600012", "ret": 2.0}, {"code": "600013", "ret": -9.98}, {"code": "600014", "ret": 4.4}]
    kw.setdefault("reasons", {"600001": "机器人+国企改革", "600002": "机器人", "600004": "创新药"})
    return _ladder(monkeypatch, today, prev_zt, settled_rows=settled_rows, **kw)


class TestBoardLadder:
    def test_levels_promotion_and_where_the_rest_went(self, monkeypatch):
        lad = _full(monkeypatch)["ladder"]
        assert lad["available"] and lad["highest"] == 4 and lad["total_limit_up"] == 4 and lad["consec_count"] == 2
        lv = {x["boards"]: x for x in lad["levels"]}
        assert [x["boards"] for x in lad["levels"]] == [6, 4, 2, 1], "从高到低;昨天 5 板断了,今天的 6 板那一行也要有"
        assert lv[6]["stocks"] == [] and (lv[6]["base"], lv[6]["promoted"], lv[6]["rate"]) == (1, 0, 0.0)
        assert lv[6]["fell"] == [{"code": "600011", "name": "股600011", "prev_boards": 5, "prev_label": "5板", "outcome": "没涨停", "ret": -6.2}]
        assert (lv[4]["base"], lv[4]["promoted"]) == (1, 1) and [s["code"] for s in lv[4]["stocks"]] == ["600001"]
        assert (lv[2]["base"], lv[2]["promoted"], lv[2]["rate"]) == (5, 1, 0.2)
        fell = {f["code"]: (f["outcome"], f["ret"]) for f in lv[2]["fell"]}
        # 定稿记录优先(600012 用 2.0 不用炸板池的 3.5,600013 用 -9.98 不用跌停池的 -10.0);都没有 = 没取到,不写 0
        assert fell == {"600012": ("炸板", 2.0), "600013": ("跌停", -9.98), "600014": ("没涨停", 4.4), "600015": ("没取到", None)}
        assert [f["code"] for f in lv[2]["fell"]] == ["600014", "600012", "600013", "600015"], "涨跌幅高的在前,没取到的垫底"
        assert lv[1]["base"] is None and lv[1]["fell"] == [], "首板这一档没有「晋级」可言"

    def test_known_outcome_without_ret_is_a_gap(self, monkeypatch):
        today = {"zt": [_zt("600001", 2)], "zb": [{"code": "600002", "name": "股600002", "ret": None}], "dt": []}
        r = _ladder(monkeypatch, today, [_zt("600001"), _zt("600002")], reasons={"600001": "机器人"}, settled_rows=None)
        d = M.shortline_board_ladder_map(r, _mctx("cn_shortline_board_ladder"))
        assert d["status"] == "partial" and [m["field"] for m in d["missing"]] == ["ladder_fell_ret"], "炸板了但涨跌幅没取到,也是缺数"

    def test_bse_without_reason_is_not_a_gap(self, monkeypatch):
        """同花顺涨停揭秘不收北交所:北交所没原因是常态,不算缺,写明不收录。"""
        today = {"zt": [_zt("600001", 2), _zt("920001", 1)], "zb": [], "dt": []}
        r = _ladder(monkeypatch, today, [_zt("600001")], reasons={"600001": "机器人"})
        assert r["ladder"]["reason_missing"] == []
        d = M.shortline_board_ladder_map(r, _mctx("cn_shortline_board_ladder"))
        assert d.get("status") is None and not d["missing"]
        assert "同花顺不收录北交所" in next(e["value"] for e in d["evidence"] if e["field"] == "ladder_stock" and e["record_key"] == "920001")

    def test_all_outcomes_known_is_complete(self, monkeypatch):
        today = {"zt": [_zt("600001", 2)], "zb": [_row("600002", 3.5)], "dt": []}
        r = _ladder(monkeypatch, today, [_zt("600001"), _zt("600002"), _zt("600003")], reasons={"600001": "机器人"},
                    settled_rows=[{"code": "600003", "ret": 1.2}])
        d = M.shortline_board_ladder_map(r, _mctx("cn_shortline_board_ladder"))
        assert d.get("status") is None and not d["missing"], "去向都有了才算完整"

    def test_settled_gap_falls_back_to_pool_rows(self, monkeypatch):
        today = {"zt": [_zt("600001", 2)], "zb": [_row("600002", 3.5)], "dt": [_row("600003", -10.0)]}
        lad = _ladder(monkeypatch, today, [_zt("600001"), _zt("600002"), _zt("600003")], reasons={"600001": "机器人"}, settled_rows=None)["ladder"]
        fell = {f["code"]: (f["outcome"], f["ret"]) for f in lad["levels"][0]["fell"]}
        assert fell == {"600002": ("炸板", 3.5), "600003": ("跌停", -10.0)}, "定稿记录没取到时,炸板 / 跌停池里的涨跌幅照用"

    def test_stock_fields_reason_tags_and_rebound(self, monkeypatch):
        lad = _full(monkeypatch)["ladder"]
        first = {s["code"]: s for s in next(x for x in lad["levels"] if x["boards"] == 1)["stocks"]}
        assert [c for c in first] == ["600003", "600004"], "同一档按首封时间,池子顺序不打乱"
        assert first["600003"]["label"] == "3天2板" and first["600003"]["rebound"] is True
        assert first["600004"]["label"] == "1板" and first["600004"]["rebound"] is False
        top = next(x for x in lad["levels"] if x["boards"] == 4)["stocks"][0]
        assert top["tags"] == ["机器人"] and top["reason"] == "机器人+国企改革" and top["first_seal"] == "092500"
        assert lad["reason_covered"] == 3, "600003 没有原因,不算覆盖"

    def test_unbroken_label_with_gap_inside_is_marked(self, monkeypatch):
        """连板数 4、涨停统计 5 天 4 板:中间断过,标「5天4板」,不当一路连上来的。"""
        lad = _ladder(monkeypatch, {"zt": [_zt("600001", 4, stat="5天4板")], "zb": [], "dt": []}, [], reasons={"600001": "机器人"})["ladder"]
        s = lad["levels"][0]["stocks"][0]
        assert s["label"] == "5天4板" and s["rebound"] is True

    def test_missing_yesterday_pool_gives_no_promotion_numbers(self, monkeypatch):
        _full(monkeypatch)
        monkeypatch.setattr(S, "zt_pool", lambda d: None)
        r = B.build_board_ladder(DAY)
        lad = r["ladder"]
        assert lad["available"] and lad["prev_available"] is False and "没取到" in lad["prev_note"]
        assert all(x["base"] is None and x["promoted"] is None and not x["fell"] for x in lad["levels"])
        d = M.shortline_board_ladder_map(r, _mctx("cn_shortline_board_ladder"))
        assert d["status"] == "partial" and "ladder_tier_promotion_rate" in {m["field"] for m in d["missing"]}
        assert not [e for e in d["evidence"] if e["field"].startswith(("ladder_tier_base", "ladder_tier_promoted", "ladder_fell"))]
        assert "进" not in d["extra"]["text"], "不知道就不写晋级数,更不写「0/0」"

    def test_reasons_missing_keeps_the_ladder(self, monkeypatch):
        r = _full(monkeypatch, reasons={})
        lad = r["ladder"]
        assert lad["available"] and lad["reason_available"] is False and lad["reason_covered"] == 0
        d = M.shortline_board_ladder_map(r, _mctx("cn_shortline_board_ladder"))
        assert d["status"] == "partial" and "ladder_stock_reason" in {m["field"] for m in d["missing"]}
        assert "涨停原因没取到" in d["extra"]["text"]

    def test_today_pool_missing_fails(self, monkeypatch):
        r = _ladder(monkeypatch, None, [], reasons={"600001": "x"})
        assert r["ladder"]["available"] is False
        d = M.shortline_board_ladder_map(r, _mctx("cn_shortline_board_ladder"))
        assert d["status"] == "failed"

    def test_mapper_evidence_text_and_unsettled(self, monkeypatch):
        d = M.shortline_board_ladder_map(_full(monkeypatch), _mctx("cn_shortline_board_ladder"))
        evs = d["evidence"]
        # 600015 去向没取到、600003 没有涨停原因:缺数,标部分(不能当完整结果长期缓存)
        assert d["status"] == "partial" and d["missing"] == [
            {"field": "ladder_fell_ret", "period": DAY, "reason": "1 只昨天涨停、今天没再涨停的票当天表现没取到（600015）"},
            {"field": "ladder_stock_reason", "period": DAY, "reason": "1 只沪深涨停股没有涨停原因（600003）"}]
        assert len({e["id"] for e in evs}) == len(evs)
        got = {(e["field"], e.get("record_key")): e["value"] for e in evs}
        assert got[("ladder_tier_promotion_rate", "2板")] == 0.2 and got[("ladder_tier_count", "6板")] == 0
        assert got[("ladder_fell_ret", "600011")] == -6.2 and ("ladder_fell_ret", "600015") not in got
        text = d["extra"]["text"]
        assert "6板 0 只（5进6：0/1）" in text and "股600011没涨停-6.2%" in text
        assert "1进2：1/5" in text and "股600003[3天2板]" in text
        d = M.shortline_board_ladder_map(_full(monkeypatch, settled=False), _mctx("cn_shortline_board_ladder"))
        assert d["status"] == "partial" and "不缓存" in d["degraded"]


# ================================================================ 题材轮动
DATES = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-08", "2026-10-09"]


def _rotation(monkeypatch, per_day: dict, *, days: int = 5, settled: bool = True) -> dict:
    """per_day: 日期 → ([(代码, 板数, 原因)...] 或 None = 池子没取到 或 "noreason")"""
    def zt_pool(d):
        v = per_day.get(d)
        return None if v is None else [_zt(c, b) for c, b, _ in (v if v != "noreason" else [("600000", 1, "")])]

    def reasons(d):
        v = per_day.get(d)
        if v in (None, "noreason"):
            return {}, "同花顺涨停揭秘：分页缺失"
        return {c: r for c, _, r in v if r}, "来源：测试"
    monkeypatch.setattr(S, "zt_pool", zt_pool)
    monkeypatch.setattr(T, "limit_reasons", reasons)
    monkeypatch.setattr(S, "review_day", lambda d: DAY)
    monkeypatch.setattr(S, "trade_dates_ending_at", lambda end, n: DATES[-n:])
    monkeypatch.setattr(S, "is_settled", lambda d: settled)
    return B.build_theme_rotation(DAY, days)


def _day(**tags) -> list:
    """_day(机器人=(3, 2)) → 3 只机器人,最高 2 板;代码按题材编号避免撞车。"""
    out, n = [], 0
    for tag, (cnt, high) in tags.items():
        for i in range(cnt):
            n += 1
            out.append((f"6000{n:02d}", high if i == 0 else 1, tag))
    return out


class TestThemeRotation:
    def test_series_ranks_streaks_and_returns(self, monkeypatch):
        per = {
            "2026-09-28": _day(机器人=(2, 1), 创新药=(1, 1)),
            "2026-09-29": _day(机器人=(3, 2), 固态电池=(3, 1)),
            "2026-09-30": _day(固态电池=(2, 1)),
            "2026-10-08": _day(固态电池=(4, 3), 算力=(2, 1)),
            "2026-10-09": _day(固态电池=(5, 4), 机器人=(2, 1), 创新药=(1, 1), 新题材=(1, 1)),
        }
        rot = _rotation(monkeypatch, per)["rotation"]
        assert rot["available"] and rot["dates"] == DATES and rot["missing_days"] == []
        th = {t["tag"]: t for t in rot["themes"]}
        ss = th["固态电池"]
        assert ss["series"] == [0, 3, 2, 4, 5] and ss["ranks"] == [None, 1, 1, 1, 1]
        assert (ss["status"], ss["streak"], ss["active_days"], ss["top3_days"], ss["total"]) == ("连续 4 天", 4, 4, 4, 14)
        assert ss["first_day"] == "2026-09-29" and ss["highest"] == [0, 1, 1, 3, 4]
        assert th["机器人"]["status"] == "隔 2 天回流" and th["机器人"]["series"] == [2, 3, 0, 0, 2]
        assert th["创新药"]["status"] == "隔 3 天回流"
        assert th["新题材"]["status"] == "窗口内首次出现"
        assert th["算力"]["status"] == "今天没有涨停" and th["算力"]["today"] == 0, "昨天 2 只、今天没有:退下来的也列出"
        assert [t["tag"] for t in rot["themes"]][:2] == ["固态电池", "机器人"], "按今天只数排"
        assert rot["days"][-1]["top"][0] == "固态电池"

    def test_ties_share_rank(self, monkeypatch):
        per = {d: _day(甲=(2, 1), 乙=(2, 1), 丙=(1, 1)) for d in DATES}
        th = {t["tag"]: t for t in _rotation(monkeypatch, per)["rotation"]["themes"]}
        assert th["甲"]["ranks"][-1] == th["乙"]["ranks"][-1] == 1 and th["丙"]["ranks"][-1] == 3

    def test_faded_needs_two_yesterday(self, monkeypatch):
        per = {d: _day(甲=(1, 1)) for d in DATES}
        per["2026-10-08"] = _day(甲=(1, 1), 单只=(1, 1), 两只=(2, 1))
        tags = [t["tag"] for t in _rotation(monkeypatch, per)["rotation"]["themes"]]
        assert "两只" in tags and "单只" not in tags

    def test_missing_day_is_none_not_zero(self, monkeypatch):
        per = {d: _day(甲=(2, 1)) for d in DATES}
        per["2026-10-08"] = None
        r = _rotation(monkeypatch, per)
        rot = r["rotation"]
        t = next(x for x in rot["themes"] if x["tag"] == "甲")
        assert t["series"] == [2, 2, 2, None, 2] and t["ranks"][3] is None
        assert t["status"] == "昨天缺数，新旧不确定" and t["streak_partial"] is True
        assert rot["missing_days"] == ["2026-10-08"] and rot["prev_available"] is False
        d = M.shortline_theme_rotation_map(r, _mctx("cn_shortline_theme_rotation"))
        assert d["status"] == "partial" and {"field": "rotation_day", "period": "2026-10-08"}.items() <= d["missing"][0].items()
        assert not [e for e in d["evidence"] if e["period"] == "2026-10-08"], "缺的那天一条证据都不写,更不写 0"
        assert "按缺数处理（不是 0）：2026-10-08" in d["extra"]["text"] and "2 2 2 — 2" in d["extra"]["text"]

    def test_some_stocks_without_reason_make_absent_themes_unknown(self, monkeypatch):
        """原因串取到了但漏了几只沪深涨停股:那天没出现的题材可能有,写 None 不写 0;不据此判「退下去」「首次出现」。"""
        per = {d: _day(甲=(1, 1)) for d in DATES}
        per["2026-10-08"] = [("600001", 1, "机器人"), ("600002", 1, "机器人"), ("600003", 1, "甲")]
        per[DAY] = [("600001", 1, ""), ("600002", 2, ""), ("600004", 1, "新能源"), ("920001", 1, "")]
        per["2026-09-29"] = [("600003", 1, ""), ("600005", 1, "乙")]
        r = _rotation(monkeypatch, per)
        rot = r["rotation"]
        th = {t["tag"]: t for t in rot["themes"]}
        assert "机器人" not in th, "昨天 2 只、今天两只没原因:不能说今天退下去了"
        assert th["新能源"]["series"] == [0, None, 0, 0, 1], "缺原因那天没出现 = 说不准;北交所没原因不算缺"
        assert th["新能源"]["status"] == "窗口内前几天有缺数，不确定是不是新出现"
        assert th["新能源"]["ranks"][1] is None
        assert rot["partial_days"] == ["2026-09-29", DAY] and rot["missing_days"] == []
        assert [x.get("unknown") for x in rot["days"]] == [0, 1, 0, 0, 2]
        d = M.shortline_theme_rotation_map(r, _mctx("cn_shortline_theme_rotation"))
        assert d["status"] == "partial"
        assert [m["period"] for m in d["missing"]] == ["2026-09-29", DAY]
        assert [m["reason"].split("：")[0] for m in d["missing"]] == ["1 只沪深涨停股没有涨停原因", "2 只沪深涨停股没有涨停原因"]
        assert "出现的只数是下限：2026-09-29、2026-10-09" in d["extra"]["text"]

    def test_reasons_missing_day_is_missing_too(self, monkeypatch):
        per = {d: _day(甲=(1, 1)) for d in DATES}
        per["2026-09-29"] = "noreason"
        rot = _rotation(monkeypatch, per)["rotation"]
        assert rot["missing_days"] == ["2026-09-29"] and "涨停原因没取到" in rot["days"][1]["reason"]

    def test_today_unavailable_fails(self, monkeypatch):
        per = {d: _day(甲=(1, 1)) for d in DATES}
        per[DAY] = None
        r = _rotation(monkeypatch, per)
        assert r["rotation"]["available"] is False and "没取到" in r["rotation"]["reason"]
        assert M.shortline_theme_rotation_map(r, _mctx("cn_shortline_theme_rotation"))["status"] == "failed"

    def test_days_bounds(self, monkeypatch):
        per = {d: _day(甲=(1, 1)) for d in DATES}
        for bad in (2, 11):
            with pytest.raises(ValueError, match="days"):
                _rotation(monkeypatch, per, days=bad)

    def test_mapper_evidence_unique_and_unsettled(self, monkeypatch):
        per = {d: _day(甲=(2, 2), 乙=(1, 1)) for d in DATES}
        d = M.shortline_theme_rotation_map(_rotation(monkeypatch, per), _mctx("cn_shortline_theme_rotation"))
        evs = d["evidence"]
        assert d.get("status") is None and len({e["id"] for e in evs}) == len(evs)
        got = {(e["field"], e.get("record_key"), e["period"]): e["value"] for e in evs}
        assert got[("rotation_topic_limit_up", "甲", DAY)] == 2 and got[("rotation_topic_rank", "乙", DAY)] == 2
        assert got[("rotation_topic_status", "甲", f"{DATES[0]}..{DAY}")] == "连续 5 天以上"
        # 今天还没收盘:说清楚是没收盘,不说成交易日历排不出
        r = _rotation(monkeypatch, per, settled=False)
        assert r["rotation"]["available"] is False and "还没收盘" in r["rotation"]["reason"]
        d = M.shortline_theme_rotation_map(r, _mctx("cn_shortline_theme_rotation"))
        assert d["status"] == "failed"


@pytest.mark.parametrize("series, want", [
    ([1, 1, 1], ("连续 3 天以上", 3, True)),    # 整个窗口天天有:窗口之前可能也有
    ([0, 1, 1], ("连续 2 天", 2, False)),
    ([None, 1, 1], ("连续 2 天以上", 2, True)),
    ([1, 0, 1], ("隔 1 天回流", 1, False)),
    ([1, None, 0, 1], ("回流（中间有缺数，隔几天说不准）", 1, False)),
    ([None, 0, 1], ("窗口内前几天有缺数，不确定是不是新出现", 1, True)),
    ([0, 0, 1], ("窗口内首次出现", 1, False)),
    ([1, None, 1], ("昨天缺数，新旧不确定", 1, True)),
    ([1, 2, 0], ("今天没有涨停", 0, False)),
    ([1, 2, None], ("当天题材串没取到", None, False)),
])
def test_status_only_from_readings(series, want):
    assert B._status(series) == want
