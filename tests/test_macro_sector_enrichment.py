"""大赛道跟踪增强：概念/行业资金流替代源与聚合输出（纯逻辑，数据源 mock）。"""
import pytest

from duanxian import data as ddata
from duanxian import fetchers as dr


class TestDedupAndMatch:
    def test_dedup_by_name_keeps_max(self):
        rows = [
            {"name": "算力", "inflow_today": 1.0},
            {"name": "算力", "inflow_today": 5.0},
            {"name": "机器人", "inflow_today": 2.0},
            {"name": "", "inflow_today": 9.0},
        ]
        out = ddata._dedup_sector(rows)
        by_name = {r["name"]: r["inflow_today"] for r in out}
        assert by_name == {"算力": 5.0, "机器人": 2.0}

    def test_match_groups(self):
        rows = [
            {"name": "东数西算(算力)", "source": "akshare:concept"},
            {"name": "机器人概念", "source": "akshare:concept"},
            {"name": "商业航天", "source": "akshare:concept"},
            {"name": "无关概念", "source": "akshare:concept"},
        ]
        m = ddata._match_groups(rows)
        assert any("算力" in r["name"] for r in m["AI算力"])
        assert any("机器人" in r["name"] for r in m["人形机器人"])
        assert any("航天" in r["name"] for r in m["商业航天"])
        assert not any(r["name"] == "无关概念" for hits in m.values() for r in hits)


class TestMacroAggregation:
    def _seed(self, monkeypatch):
        monkeypatch.setattr(dr, "fetch_concept_flow_ak", lambda: [
            {"name": "共封装光学(CPO)", "change_pct": 1.3, "inflow_today": 63.23,
             "lead_stock": "金百泽", "source": "akshare:concept"},
            {"name": "机器人概念", "change_pct": -0.2, "inflow_today": 3.31,
             "lead_stock": "雪人集团", "source": "akshare:concept"},
            {"name": "共封装光学(CPO)", "change_pct": 1.3, "inflow_today": 63.23,
             "lead_stock": "金百泽", "source": "akshare:concept"},  # 重复行
        ])
        monkeypatch.setattr(dr, "fetch_industry_flow_ak", lambda: [
            {"name": "通信设备", "change_pct": 0.5, "inflow_today": 12.0,
             "lead_stock": "中兴通讯", "source": "akshare:industry"},
        ])
        import duanxian.trade_calendar as tc
        monkeypatch.setattr(tc, "live_quotes_are_close_of", lambda date: (True, ""))

    def test_enriched_no_empty_phrase(self, monkeypatch):
        self._seed(monkeypatch)
        text = ddata.get_macro_sector_data("2026-11-25")
        assert "无匹配概念板块" not in text
        assert "共封装光学(CPO)" in text
        assert "净额+63.23亿" in text
        assert "领涨 金百泽" in text
        assert "机器人概念" in text
        # 商业航天无匹配时给的是说明，不是"无匹配概念板块"
        assert "未进榜" in text

    def test_both_sources_empty_still_has_asof_note(self, monkeypatch):
        """数据空也要保留口径说明与'缺失不等于无'的纪律（产品约束）。"""
        monkeypatch.setattr(dr, "fetch_concept_flow_ak", lambda: [])
        monkeypatch.setattr(dr, "fetch_industry_flow_ak", lambda: [])
        monkeypatch.setattr(dr, "fetch_sector_flow", lambda *a: [])
        import duanxian.trade_calendar as tc
        monkeypatch.setattr(tc, "live_quotes_are_close_of", lambda date: (True, ""))
        text = ddata.get_macro_sector_data("2026-11-25")
        assert "均未取到" in text
        assert "端点本身的时间戳未单独核实" in text
        assert "不代表市场无该现象" in text
