"""涨停结构端点(cn_shortline_structure):制度构成、最高标、四张池子的上游字段清单。全程不联网。

行为沿用 Vibe AStock v2.0.0 drift.py 的 `_day_structure` 与 archive 字段清单;另测本仓库的三处修正:
制度构成按当天规则、空池不算字段变了也不标 partial、字段清单过长写摘要而不是截断。
"""
from __future__ import annotations

import json
import os

import pytest

from test_shortline import _mctx, _zb, _zt
from sources import mappers_shortline as M
from sources import shortline as S
from sources import shortline_structure as T

REGISTRY = os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..", "datasources", "registry.json")
ZT_KEYS = ["amount", "c", "fbt", "fund", "hs", "hybk", "lbc", "lbt", "ltsz", "n", "p", "zbc", "zdp", "zttj", "zttj.ct", "zttj.days"]


@pytest.fixture
def day(monkeypatch):
    """10-09:涨停 4 只(最高 3 板 2 只)、炸板 1 只、跌停池空、昨日涨停池正常。"""
    zt = [_zt("600001", 3, first="100000"), _zt("300750", 3, first="093100"), _zt("688981", 1), _zt("920627", 2)]
    pools = {"zt": zt, "zb": [_zb("600010")], "dt": []}
    fields = {"zt": ZT_KEYS, "zb": ["c", "n", "ztp"], "yzt": ["c", "n", "ylbc"]}
    monkeypatch.setattr(S, "review_day", lambda d: d or "2026-10-09")
    monkeypatch.setattr(S, "is_settled", lambda d: True)
    monkeypatch.setattr(S, "pool", lambda kind, d: pools[kind])
    monkeypatch.setattr(S, "settled_pool", lambda d: [{"code": "600001"}])
    monkeypatch.setattr(S, "raw_fields", lambda kind, d: fields.get(kind) if (pools.get(kind) if kind != "yzt" else True) else None)
    return pools


class TestRawFields:
    def test_keys_from_upstream_rows_union_and_subkeys(self, monkeypatch):
        raw = {"getTopicZTPool": [{"c": "600825", "n": "甲", "zdp": 10.0, "lbc": 2, "zbc": 0, "zttj": {"days": 2, "ct": 2}}, {"c": "600826", "n": "乙", "hybk": "出版", "lbc": 1, "zbc": 1}],
               "getTopicDTPool": [],
               "getYesterdayZTPool": [{"c": "600001", "n": "丙", "zdp": 3.0, "ylbc": 1, "yfbt": 93000}]}
        for c in (S._POOL, S._FIELDS, S._SETTLED):
            c.clear()
        monkeypatch.setattr(S.em, "_em_zt_api", lambda api, sort, d: raw[api])
        try:
            S.pool("zt", "2026-10-09"), S.pool("dt", "20261009"), S.settled_pool("2026-10-09")
            assert S.raw_fields("zt", "20261009") == ["c", "hybk", "lbc", "n", "zbc", "zdp", "zttj", "zttj.ct", "zttj.days"], "所有行取并集,带一层子键"
            assert S.raw_fields("dt", "2026-10-09") is None, "空池看不出字段"
            assert S.raw_fields("yzt", "2026-10-09") == ["c", "n", "yfbt", "ylbc", "zdp"]
            assert S.raw_fields("zb", "2026-10-09") is None, "没取过就是不知道"
        finally:
            for c in (S._POOL, S._FIELDS, S._SETTLED):
                c.clear()


class TestStructure:
    def test_mix_shares_and_leaders(self, day):
        r = T.build_structure("2026-10-09")
        assert r["available"] and r["limit_up"] == 4 and r["mix"] == {"20%": 2, "10%": 1, "北交所": 1}
        assert (r["share_20cm"], r["share_10cm"], r["share_bj"]) == (0.5, 0.25, 0.25)
        assert r["highest_board"] == 3 and r["leader_total"] == 2
        assert [x["code"] for x in r["leaders"]] == ["300750", "600001"], "同高按首封时间排"
        assert r["fields"]["zt"] == ZT_KEYS and r["fields"]["dt"] is None
        assert r["fields_unknown"] == {"dt": "池子为空,看不出字段"}

    def test_mix_uses_that_days_rule(self, day, monkeypatch):
        """创业板 2020-08-24 前是 10%;主板 ST 2026-07-06 前是 5%(归 10% 制度)。VA 老归档回退现行规则,会把这两类都归错。"""
        day["zt"][:] = [_zt("300750", 1), _zt("600001", 1, name="ST甲")]
        assert T.build_structure("2020-08-21")["mix"] == {"20%": 0, "10%": 2, "北交所": 0}
        assert T.build_structure("2026-10-09")["mix"] == {"20%": 1, "10%": 1, "北交所": 0}
        assert T.mix_of("688001", "*ST乙", "2019-08-01") == "20%", "科创板一开板就是 20%,ST 也是"

    def test_leaders_capped_and_missing_seal_sorts_last(self, day):
        day["zt"][:] = [_zt(f"60000{i}", 1, first=("" if i == 0 else f"09{30 + i}00")) for i in range(7)]
        r = T.build_structure("2026-10-09")
        assert r["leader_total"] == 7 and len(r["leaders"]) == T.LEADERS_MAX
        assert r["leaders"][0]["code"] == "600001" and "600000" not in [x["code"] for x in r["leaders"]]
        assert "等 7 只" in T.render_structure(r)

    def test_unavailable_when_limit_up_pool_fails_or_is_empty(self, day, monkeypatch):
        day["zt"][:] = []
        assert T.build_structure("2026-10-09")["available"] is False
        def boom(kind, d):
            raise ConnectionError("断了")
        monkeypatch.setattr(S, "pool", boom)
        r = T.build_structure("2026-10-09")
        assert r["available"] is False and "ConnectionError" in r["reason"]
        m = M.shortline_structure_map(r, _mctx("cn_shortline_structure"))
        assert m["status"] == "failed" and m["missing"][0]["field"] == "structure"


class TestMapper:
    def test_evidence_and_empty_pool_is_not_partial(self, day):
        """跌停池为空是正常的一天:不能标 partial —— partial 不进缓存,东财过了保留期这天就永远没了。"""
        m = M.shortline_structure_map(T.build_structure("2026-10-09"), _mctx("cn_shortline_structure"))
        assert m.get("status") is None and not m["missing"]
        got = {(e["field"], e.get("record_key")): e["value"] for e in m["evidence"]}
        assert got[("limit_up_count", None)] == 4 and got[("structure_mix_count", "北交所")] == 1
        assert got[("structure_share_20cm", None)] == 0.5 and got[("ladder_highest", None)] == 3
        assert got[("leader_name", "300750")] == "股300750" and got[("leader_first_seal", "300750")] == "093100"
        assert got[("raw_fields", "zt")] == ",".join(ZT_KEYS) and got[("raw_field_count", "zt")] == len(ZT_KEYS)
        assert ("raw_fields", "dt") not in got
        assert m["extra"]["fields_unknown"] == {"dt": "池子为空,看不出字段"}

    def test_failed_pool_is_missing_and_partial(self, day, monkeypatch):
        pools = dict(day)
        def pool(kind, d):
            if kind == "zb":
                raise ConnectionError("炸板池断了")
            return pools[kind]
        monkeypatch.setattr(S, "pool", pool)
        m = M.shortline_structure_map(T.build_structure("2026-10-09"), _mctx("cn_shortline_structure"))
        assert m["status"] == "partial" and m["missing"][0]["field"] == "raw_fields" and "炸板池没取到" in m["missing"][0]["reason"]

    def test_long_field_list_is_digested_not_truncated(self):
        many = [f"field_{i:03d}" for i in range(40)]
        a, b = M.fields_text(many), M.fields_text(many[:-1] + ["field_999"])
        assert len(a) < 300 and a.startswith("40 个字段") and a != b, "截断会把后面变了的字段藏起来"
        assert M.fields_text(["c", "n"]) == "c,n"

    def test_unsettled_is_partial(self, day, monkeypatch):
        monkeypatch.setattr(S, "is_settled", lambda d: False)
        m = M.shortline_structure_map(T.build_structure("2026-10-09"), _mctx("cn_shortline_structure"))
        assert m["status"] == "partial" and "不缓存" in m["degraded"]


def test_registry_entry():
    reg = json.load(open(REGISTRY, encoding="utf-8"))
    e = {x["id"]: x for x in reg["endpoints"]}["cn_shortline_structure"]
    assert e["symbol_kind"] == "none" and e["computed"] is True and set(e["args"]) == {"date"}
    assert "cache_max_age_sec" not in e
    assert (e["module"], e["function"], e["mapper_module"], e["mapper"]) == ("shortline_structure", "build_structure", "mappers_shortline", "shortline_structure_map")
