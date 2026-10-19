"""题材事件树与首板名单(cn_shortline_themes / cn_shortline_firstboard)。全程不联网。

行为沿用 Vibe AStock v2.0.0 的测试(test_gap_closure.py 题材树几条、test_core_logic.py 问财按场次取原因那组、首板查询带日期),
改成本仓库的行形状;另测本仓库的改动:问财出错改走同花顺、翻页翻满不交半份、题材串不截半个词、首板标出反包。
"""
from __future__ import annotations

from datetime import datetime

import pytest

from common import TZ_SH
from test_registry_sources import _ctx
from sources import iwencai
from sources import mappers_shortline as M
from sources import shortline as S
from sources import shortline_themes as T


@pytest.fixture(autouse=True)
def _fresh_cache():
    T._REASONS.clear()
    yield
    T._REASONS.clear()


def _mctx(ep_id: str):
    return _ctx(symbol="MARKET", market="CN", source="eastmoney+ths+calc", ep={"id": ep_id})


def _zt(code: str, boards: int = 1, *, stat: str | None = None, first: str = "093000", broken: int = 0) -> dict:
    return {"code": code, "name": f"股{code}", "board": S.board_of(code), "ret": 10.0, "close": 11.0, "amount": 1e8,
            "float_cap": 5e9, "sector": "甲", "boards": boards, "zt_stat": stat, "first_seal": first, "broken_times": broken}


def _row(code: str) -> dict:
    return {"code": code, "name": f"股{code}"}


# ================================================================ 涨停原因
def _iwc(pages: dict[int, list[dict]], seen: list):
    def q(query, page=1, limit=50):
        seen.append((query, page))
        return pages.get(page, [])
    return q


class TestIwencaiReasons:
    def test_query_carries_the_requested_date_and_checks_the_column(self, monkeypatch):
        monkeypatch.setenv("IWENCAI_API_KEY", "test-key")
        seen: list = []
        monkeypatch.setattr(iwencai, "iwencai_query", _iwc({1: [{"股票代码": "002491.SZ", "涨停原因[20261009]": "酒店+国企改革"}]}, seen))
        reasons, note = T.limit_reasons("2026-10-09")
        assert reasons == {"002491": "酒店+国企改革"} and "问财" in note
        assert "2026-10-09" in seen[0][0] and "今日" not in seen[0][0], "要问被复盘的那一场,不能问「今日」"

    def test_picks_the_column_of_the_session_not_column_zero(self, monkeypatch):
        monkeypatch.setenv("IWENCAI_API_KEY", "test-key")
        rows = [{"股票代码": "002491.SZ", "涨停原因[20261010]": "别的场次", "涨停原因[20261009]": "这一场"}]
        monkeypatch.setattr(iwencai, "iwencai_query", _iwc({1: rows}, []))
        assert T.limit_reasons("20261009")[0] == {"002491": "这一场"}

    @pytest.mark.parametrize("col, why", [("涨停原因", "没带日期"), ("涨停原因[20261010]", "20261010")])
    def test_wrong_or_undated_session_falls_back_to_ths(self, monkeypatch, col, why):
        """问财回的场次对不上(或验不出场次)→ 不用它;改走同花顺,说明里写清为什么换。"""
        monkeypatch.setenv("IWENCAI_API_KEY", "test-key")
        monkeypatch.setattr(iwencai, "iwencai_query", _iwc({1: [{"股票代码": "002491.SZ", col: "错场次的题材"}]}, []))
        monkeypatch.setattr(T, "_ths_reasons", lambda d8: ({"600000": "银行"}, "来源：同花顺涨停揭秘"))
        reasons, note = T.limit_reasons("2026-10-09")
        assert reasons == {"600000": "银行"}
        assert "改用同花顺" in note and why in note

    def test_page_cap_refuses_half_a_list(self, monkeypatch):
        monkeypatch.setenv("IWENCAI_API_KEY", "test-key")
        monkeypatch.setattr(iwencai, "iwencai_query",
                            lambda q, page=1, limit=50: [{"股票代码": f"{600000 + page * 100 + i}.SH", "涨停原因[20261009]": "题材"} for i in range(50)])
        with pytest.raises(ValueError, match="半份"):
            T._iwencai_reasons("20261009")

    @staticmethod
    def _rows(start: int, n: int) -> list[dict]:
        return [{"股票代码": f"{600000 + start + i}.SH", "涨停原因[20261009]": "题材"} for i in range(n)]

    def test_page_size_below_50_still_pages_to_the_end(self, monkeypatch):
        """问财每页实际给几条没核实(审计 2026-10-11 Opus 范围 1 待核实第 4 条):每页只给 20 条时不能翻一页就停。"""
        seen: list = []
        monkeypatch.setattr(iwencai, "iwencai_query", _iwc({1: self._rows(0, 20), 2: self._rows(20, 20), 3: self._rows(40, 9)}, seen))
        reasons, _ = T._iwencai_reasons("20261009")
        assert len(reasons) == 49 and [pg for _, pg in seen] == [1, 2, 3], "比第一页短的那页才是最后一页"

    def test_short_first_page_asks_once_more(self, monkeypatch):
        seen: list = []
        monkeypatch.setattr(iwencai, "iwencai_query", _iwc({1: self._rows(0, 19)}, seen))
        assert len(T._iwencai_reasons("20261009")[0]) == 19 and [pg for _, pg in seen] == [1, 2]

    def test_upstream_ignoring_page_stops_instead_of_looping(self, monkeypatch):
        seen: list = []
        same = self._rows(0, 20)
        monkeypatch.setattr(iwencai, "iwencai_query", lambda q, page=1, limit=50: seen.append(page) or same)
        assert len(T._iwencai_reasons("20261009")[0]) == 20 and seen == [1, 2], "翻页没给新票就停,不翻满 10 页再报错"

    def test_without_key_iwencai_is_never_called(self, monkeypatch):
        monkeypatch.delenv("IWENCAI_API_KEY", raising=False)

        def boom(*a, **k):
            raise AssertionError("没配 key 还去问问财")
        monkeypatch.setattr(iwencai, "iwencai_query", boom)
        monkeypatch.setattr(T, "_ths_reasons", lambda d8: ({"600000": "银行"}, "来源：同花顺涨停揭秘"))
        assert T.limit_reasons("2026-10-09") == ({"600000": "银行"}, "来源：同花顺涨停揭秘")

    def test_both_sources_fail_says_both_and_is_not_cached(self, monkeypatch):
        monkeypatch.setenv("IWENCAI_API_KEY", "test-key")

        def bad_iwc(*a, **k):
            raise RuntimeError("HTTP 401")

        def bad_ths(d8):
            raise ValueError("分页缺失")
        monkeypatch.setattr(iwencai, "iwencai_query", bad_iwc)
        monkeypatch.setattr(T, "_ths_reasons", bad_ths)
        reasons, note = T.limit_reasons("2026-10-09")
        assert reasons == {} and "问财" in note and "同花顺" in note
        monkeypatch.setattr(T, "_ths_reasons", lambda d8: ({"600000": "银行"}, "来源：同花顺"))
        assert T.limit_reasons("2026-10-09")[0] == {"600000": "银行"}, "失败不能被记住"


def _ths_env(rows: list[dict], total: int) -> dict:
    return {"status_code": 0, "data": {"info": rows, "page": {"total": total}}}


def _stamp(day: str = "2026-10-09", hm: str = "10:00") -> float:
    return datetime.strptime(f"{day} {hm}", "%Y-%m-%d %H:%M").replace(tzinfo=TZ_SH).timestamp()


class TestThsReasons:
    def test_every_row_must_belong_to_the_day(self, monkeypatch):
        row = {"code": "600000", "first_limit_up_time": _stamp(), "reason_type": "银行+金融"}
        monkeypatch.setattr(T, "http_json", lambda *a, **k: _ths_env([row], 1))
        reasons, note = T._ths_reasons("20261009")
        assert reasons == {"600000": "银行+金融"} and "1/1" in note
        row["first_limit_up_time"] = _stamp("2026-10-10")
        with pytest.raises(ValueError, match="别的交易日"):
            T._ths_reasons("20261009")

    def test_missing_page_and_empty_list_are_refused(self, monkeypatch):
        monkeypatch.setattr(T, "http_json", lambda *a, **k: _ths_env([], 1))
        with pytest.raises(ValueError, match="分页缺失"):
            T._ths_reasons("20261009")
        monkeypatch.setattr(T, "http_json", lambda *a, **k: _ths_env([], 0))
        with pytest.raises(ValueError, match="核对不了"):
            T._ths_reasons("20261009")

    def test_pages_until_total_and_skips_placeholder_reasons(self, monkeypatch):
        rows = [{"code": f"{600000 + i}", "first_limit_up_time": _stamp(), "reason_type": "题材" if i % 3 else "暂无"} for i in range(250)]
        pages = []

        def get(url, params=None, **k):
            pages.append(params["page"])
            p = params["page"]
            return _ths_env(rows[(p - 1) * 200: p * 200], 250)
        monkeypatch.setattr(T, "http_json", get)
        reasons, note = T._ths_reasons("20261009")
        assert pages == [1, 2] and len(reasons) == sum(1 for i in range(250) if i % 3)
        assert f"{len(reasons)}/250" in note

    def test_list_changing_between_pages_is_refused(self, monkeypatch):
        rows = [{"code": f"{600000 + i}", "first_limit_up_time": _stamp(), "reason_type": "题材"} for i in range(200)]
        totals = iter([250, 251])
        monkeypatch.setattr(T, "http_json", lambda *a, **k: _ths_env(rows, next(totals)))
        with pytest.raises(ValueError, match="名单变了"):
            T._ths_reasons("20261009")


class TestCleanReason:
    def test_never_cuts_a_tag_in_half(self):
        """VA 先拼好再截到 30 字,末尾标签会被截成半个词,半个词再被当成一个新题材。"""
        long = "+".join(["间接投资长鑫科技", "百货零售与商业综合体", "合肥国资委控股平台", "控制权变更预期"])
        got = T.clean_reason(long)
        assert all(t in long.split("+") for t in got.split("+")), got
        assert len(got) <= 40

    def test_separators_and_tag_limit(self):
        assert T.clean_reason("甲，乙,丙+丁+戊") == "甲+乙+丙+丁"
        assert T.clean_reason("  +甲++乙+ ") == "甲+乙"

    def test_generic_tags_are_dropped(self):
        assert T.tags_of("酒店+国企改革+合肥国资+破净+稀土板块+光模块") == ["酒店", "光模块"]


# ================================================================ 题材事件树
def _tree(monkeypatch, today: dict, prev: dict | None, reasons: dict, prev_reasons: dict, top: int = 10) -> dict:
    monkeypatch.setattr(S, "pools", lambda d: today if d == "2026-10-09" else prev)
    monkeypatch.setattr(T, "limit_reasons", lambda d: (reasons, "来源：测试") if d == "2026-10-09" else (prev_reasons, "来源：测试"))
    return T.theme_tree("2026-10-09", "2026-10-08", top)


class TestThemeTree:
    def test_groups_by_event_tag_with_seal_times_and_continuation(self, monkeypatch):
        today = {"zt": [_zt("600001", 3, first="092500"), _zt("600002", 1, first="093700"), _zt("600003", 1, first="140000")],
                 "zb": [_row("600004")], "dt": []}
        prev = {"zt": [_zt("600001", 2), _zt("600005", 1)], "zb": [], "dt": []}
        reasons = {"600001": "固态电池+国企改革", "600002": "固态电池+储能", "600003": "储能", "600009": "不在池子里"}
        prev_reasons = {"600001": "固态电池", "600005": "固态电池"}
        tree = _tree(monkeypatch, today, prev, {**reasons, "600004": "固态电池"}, prev_reasons)
        assert tree["available"] and tree["covered"] == 3 and tree["coverage_rate"] == 1.0, "原因里不在涨停池的不算覆盖"
        g = {t["tag"]: t for t in tree["themes"]}
        assert "国企改革" not in g
        ss = g["固态电池"]
        assert (ss["limit_up"], ss["first_boards"], ss["consec_boards"], ss["highest"], ss["broken"]) == (2, 1, 1, 3, 1)
        assert (ss["first_seal"], ss["last_seal"]) == ("092500", "093700")
        assert (ss["prev_members"], ss["prev_still_up"], ss["continuation_rate"]) == (2, 1, 0.5)
        assert ss["broken_rate"] == round(1 / 3, 3)
        assert g["储能"]["state"] == "今日新出现"
        assert tree["concentration"] == round(2 / 3, 3)

    def test_missing_yesterday_pool_does_not_claim_new_theme(self, monkeypatch):
        tree = _tree(monkeypatch, {"zt": [_zt("600000")], "zb": [], "dt": []}, None, {"600000": "银行"}, {"600000": "银行"})
        assert tree["themes"][0]["state"] == "无昨日题材数据"
        assert "不能判断题材是不是新出现" in tree["source_note"] and tree["has_prev"] is False

    def test_only_generic_reasons_are_not_usable(self, monkeypatch):
        tree = _tree(monkeypatch, {"zt": [_zt("600000")], "zb": [], "dt": []}, None, {"600000": "国企改革"}, {})
        assert tree["available"] is False

    def test_no_reasons_never_falls_back_to_industry(self, monkeypatch):
        tree = _tree(monkeypatch, {"zt": [_zt("600000")], "zb": [], "dt": []}, None, {}, {})
        assert tree["available"] is False and "行业不是题材" in tree["reason"]

    def test_pool_missing_is_unavailable(self, monkeypatch):
        tree = _tree(monkeypatch, None, None, {"600000": "银行"}, {})
        assert tree["available"] is False and "没取到" in tree["reason"]

    def test_yesterday_theme_survives_without_today_limit_up(self, monkeypatch):
        today = {"zt": [_zt("600001")], "zb": [_row("600002")], "dt": []}
        prev = {"zt": [_zt("600002")], "zb": [], "dt": []}
        tree = _tree(monkeypatch, today, prev, {"600001": "光模块"}, {"600002": "机器人"}, top=3)
        old = next(t for t in tree["themes"] if t["tag"] == "机器人")
        assert old["limit_up"] == 0 and old["broken"] == 1 and old["continuation_rate"] == 0
        assert old["state"] == "昨日题材未再涨停"

    def test_partial_yesterday_reasons_cannot_claim_brand_new_theme(self, monkeypatch):
        today = {"zt": [_zt("600001")], "zb": [], "dt": []}
        prev = {"zt": [_zt("600002"), _zt("600003")], "zb": [], "dt": []}
        tree = _tree(monkeypatch, today, prev, {"600001": "光模块"}, {"600002": "机器人"})
        assert (tree["prev_covered"], tree["prev_total"]) == (1, 2)
        assert tree["themes"][0]["state"] == "昨日覆盖样本未见"

    def test_rebound_members_rank_by_effective_height(self, monkeypatch):
        today = {"zt": [_zt("600001", 2), _zt("600002", 1, stat="5天3板"), _zt("600003", 1)], "zb": [], "dt": []}
        prev = {"zt": [_zt("600001", 1)], "zb": [], "dt": []}
        reasons = {c: "机器人" for c in ("600001", "600002", "600003")}
        tree = _tree(monkeypatch, today, prev, reasons, {"600001": "机器人"})
        m = tree["themes"][0]["members"]
        assert [x["code"] for x in m][:2] == ["600002", "600001"] and m[0]["label"] == "5天3板"
        assert tree["themes"][0]["first_boards"] == 2, "反包票按东财连板数仍记在首板里(和 VA 一致)"

    @pytest.mark.parametrize("over, state", [
        (dict(limit_up=1, prev_members=4, continuation_rate=0.1), "接力断档"),
        (dict(limit_up=2, broken=2, broken_rate=0.5, prev_members=2, continuation_rate=0.5), "分歧加大"),
        (dict(limit_up=5, first_boards=3, prev_members=2, continuation_rate=0.3), "扩散中"),
        (dict(limit_up=2, highest=4, prev_members=2, continuation_rate=0.5), "高标独活"),
        (dict(limit_up=3, prev_members=2, continuation_rate=0.5), "延续"),
        (dict(limit_up=3, prev_members=4, continuation_rate=0.25), "维持"),
    ])
    def test_state_only_from_observed_readings(self, over, state):
        grp = dict(limit_up=0, highest=1, first_boards=1, broken=0, broken_rate=None, prev_members=0, continuation_rate=None)
        grp.update(over)
        assert T._state_of(grp) == state

    def test_top_bounds(self, monkeypatch):
        monkeypatch.setattr(S, "review_day", lambda d: "2026-10-09")
        for bad in (2, 31):
            with pytest.raises(ValueError, match="top"):
                T.build_themes("2026-10-09", top=bad)


def _themes_result(monkeypatch, settled: bool = True, prev_pool: bool = True) -> dict:
    today = {"zt": [_zt("600001", 2), _zt("600002", 1)], "zb": [_row("600003")], "dt": []}
    prev = {"zt": [_zt("600001", 1)], "zb": [], "dt": []} if prev_pool else None
    monkeypatch.setattr(S, "pools", lambda d: today if d == "2026-10-09" else prev)
    monkeypatch.setattr(T, "limit_reasons", lambda d: ({"600001": "机器人+减速器", "600002": "机器人", "600003": "减速器"}, "来源：测试")
                        if d == "2026-10-09" else ({"600001": "机器人"}, "来源：测试"))
    monkeypatch.setattr(S, "review_day", lambda d: "2026-10-09")
    monkeypatch.setattr(S, "prev_trade_date", lambda d: "2026-10-08")
    monkeypatch.setattr(S, "is_settled", lambda d: settled)
    return T.build_themes("2026-10-09")


class TestThemesMapper:
    def test_evidence_per_topic_with_unique_ids(self, monkeypatch):
        r = M.shortline_themes_map(_themes_result(monkeypatch), _mctx("cn_shortline_themes"))
        assert r.get("status") is None and not r["missing"]
        evs = r["evidence"]
        assert len({e["id"] for e in evs}) == len(evs)
        got = {(e["field"], e.get("record_key")): e["value"] for e in evs}
        assert got[("topic_limit_up", "机器人")] == 2 and got[("topic_highest", "机器人")] == 2
        assert got[("topic_continuation_rate", "机器人")] == 1.0 and got[("topic_state", "机器人")] == "延续"
        assert got[("topic_broken", "减速器")] == 1 and got[("reason_coverage_rate", None)] == 1.0
        assert ("topic_prev_members", "减速器") not in got, "昨天没有这个题材,不写「昨日 0 只」"
        assert "机器人［延续］" in r["extra"]["text"]

    def test_unsettled_and_missing_baseline_are_partial(self, monkeypatch):
        r = M.shortline_themes_map(_themes_result(monkeypatch, settled=False), _mctx("cn_shortline_themes"))
        assert r["status"] == "partial" and "不缓存" in r["degraded"]
        r = M.shortline_themes_map(_themes_result(monkeypatch, prev_pool=False), _mctx("cn_shortline_themes"))
        assert r["status"] == "partial" and "没法判断" in r["degraded"]

    def test_unavailable_tree_fails(self, monkeypatch):
        _themes_result(monkeypatch)
        monkeypatch.setattr(T, "limit_reasons", lambda d: ({}, "同花顺涨停揭秘：分页缺失"))
        r = M.shortline_themes_map(T.build_themes("2026-10-09"), _mctx("cn_shortline_themes"))
        assert r["status"] == "failed" and "分页缺失" in r["reason"]


# ================================================================ 首板名单
def _fb(monkeypatch, pool, reasons, settled: bool = True) -> dict:
    monkeypatch.setattr(S, "zt_pool", lambda d: pool)
    monkeypatch.setattr(T, "limit_reasons", lambda d: (reasons, "来源：测试" if reasons else "同花顺涨停揭秘：HTTP 502"))
    monkeypatch.setattr(S, "review_day", lambda d: "2026-10-09")
    monkeypatch.setattr(S, "is_settled", lambda d: settled)
    return T.build_firstboard()


class TestFirstBoard:
    def test_only_first_boards_in_seal_order_with_rebounds_marked(self, monkeypatch):
        pool = [_zt("600001", 1, first="092500"), _zt("600002", 2, first="093000"), _zt("600003", 1, stat="10天7板", first="093100", broken=3),
                _zt("600004", 1, first="")]
        r = _fb(monkeypatch, pool, {"600001": "机器人", "600003": "教育"})
        assert r["date"] == "2026-10-09", "日期来自交易日历,不是今天(VA 周末会把周六写成日期)"
        assert [s["code"] for s in r["stocks"]] == ["600001", "600003", "600004"]
        assert (r["total_limit_up"], r["first_count"], r["rebound_count"], r["reason_covered"]) == (4, 3, 1, 2)
        reb = r["stocks"][1]
        assert reb["rebound"] and reb["label"] == "10天7板" and reb["broken_times"] == 3 and reb["reason"] == "教育"
        assert r["stocks"][2]["first_seal"] is None

    def test_reasons_missing_still_lists_and_is_partial(self, monkeypatch):
        r = _fb(monkeypatch, [_zt("600001")], {})
        assert r["available"] and r["first_count"] == 1 and r["reason_available"] is False
        d = M.shortline_firstboard_map(r, _mctx("cn_shortline_firstboard"))
        assert d["status"] == "partial" and [m["field"] for m in d["missing"]] == ["first_board_reason"]
        assert "HTTP 502" in d["missing"][0]["reason"] and "涨停原因没取到" in d["extra"]["text"]

    def test_mapper_evidence_and_unsettled(self, monkeypatch):
        d = M.shortline_firstboard_map(_fb(monkeypatch, [_zt("600001"), _zt("600002", 2)], {"600001": "机器人"}), _mctx("cn_shortline_firstboard"))
        assert d.get("status") is None
        got = {(e["field"], e.get("record_key")): e["value"] for e in d["evidence"]}
        assert got[("first_board_count", None)] == 1 and got[("limit_up_count", None)] == 2
        assert got[("first_board_reason", "600001")] == "机器人" and got[("first_board_amount", "600001")] == 1e8
        assert next(e for e in d["evidence"] if e["field"] == "first_board_amount")["currency"] == "CNY"
        assert len({e["id"] for e in d["evidence"]}) == len(d["evidence"])
        d = M.shortline_firstboard_map(_fb(monkeypatch, [_zt("600001")], {"600001": "机器人"}, settled=False), _mctx("cn_shortline_firstboard"))
        assert d["status"] == "partial"

    def test_pool_missing_fails(self, monkeypatch):
        d = M.shortline_firstboard_map(_fb(monkeypatch, None, {}), _mctx("cn_shortline_firstboard"))
        assert d["status"] == "failed" and "涨停池没取到" in d["reason"]
