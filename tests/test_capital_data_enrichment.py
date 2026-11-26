"""资金面增强：融资余额/沪深港通/同口径历史资金/时间戳（数据源 mock）。"""
import pytest

from duanxian import data as ddata
from duanxian import fetchers as dr


class TestFundDataSources:
    """底层数据源的单位换算与降级。"""

    def test_margin_unit_conversion(self, monkeypatch):
        class FakeDF:
            def __init__(self):
                import pandas as pd
                self.df = pd.DataFrame([{
                    "exchange_id": "SSE", "rzye": 1.109014e12, "rzmre": 5.637e10,
                    "rqye": 1.869e10, "rzrqye": 1.127704e12,
                }])
            def __call__(self, **kwargs):
                return self.df
        fake = FakeDF()
        monkeypatch.setattr(dr, "_ts_pro", lambda: type("P", (), {"margin": lambda self, **k: fake()})())
        dr._FUND_CACHE.pop("margin:20261125", None)
        out = dr.fetch_margin_summary("20261125")
        assert out["SSE"]["rzye"] == 11090.14
        assert out["SSE"]["rzmre"] == 563.7

    def test_hsgt_unit_conversion(self, monkeypatch):
        import pandas as pd
        df = pd.DataFrame([{"north_money": "219558.07", "south_money": "55378.89",
                            "hgt": "111269.12", "sgt": "108288.95"}])
        monkeypatch.setattr(dr, "_ts_pro", lambda: type("P", (), {"moneyflow_hsgt": lambda self, **k: df})())
        dr._FUND_CACHE.pop("hsgt:20261125", None)
        out = dr.fetch_hsgt_money("20261125")
        assert out["north_money"] == 21.96
        assert out["south_money"] == 5.54

    def test_asof_mismatch(self, monkeypatch):
        import pandas as pd
        df = pd.DataFrame([{"trade_date": "20261124"}])
        monkeypatch.setattr(dr, "_ts_pro", lambda: type("P", (), {"moneyflow": lambda self, **k: df})())
        out = dr.fetch_moneyflow_asof("20261125")
        assert out["matched"] is False
        assert out["actual"] == "20261124"


class TestCapitalAggregation:
    def test_enriched_sections(self, monkeypatch):
        monkeypatch.setattr(dr, "fetch_sector_flow", lambda *a: [])
        monkeypatch.setattr(dr, "enrich_trend", lambda *a: None)
        monkeypatch.setattr(dr, "fetch_turnover_top20", lambda *a: [])
        monkeypatch.setattr(dr, "fetch_margin_summary", lambda d: {
            "SSE": {"rzye": 11090.14, "rzmre": 563.7, "rqye": 186.9, "rzrqye": 11277.04},
        })
        monkeypatch.setattr(dr, "fetch_hsgt_money", lambda d: {
            "north_money": 21.96, "south_money": 5.54, "hgt": 11.13, "sgt": 10.83,
        })
        monkeypatch.setattr(dr, "fetch_industry_moneyflow_hist", lambda d, days=5: [
            {"date": "20261125", "industry": "半导体", "net_yi": -50.0},
            {"date": "20261125", "industry": "半导体", "net_yi": -40.0},
            {"date": "20261125", "industry": "半导体", "net_yi": -26.62},
        ])
        monkeypatch.setattr(dr, "fetch_moneyflow_asof", lambda d: {
            "target": d, "actual": d, "matched": True, "source": "tushare.moneyflow",
        })
        import duanxian.trade_calendar as tc
        monkeypatch.setattr(tc, "live_quotes_are_close_of", lambda date: (True, ""))
        text = ddata.get_capital_data("2026-11-25")
        assert "融资融券余额" in text
        assert "融资余额11090.14亿" in text
        assert "沪深港通" in text and "北向21.96" in text
        assert "同口径行业资金近3日累计" in text
        assert "半导体：近3日-116.62亿" in text
        assert "接口时间戳核验" in text and "一致" in text

    def test_missing_sources_do_not_break(self, monkeypatch):
        monkeypatch.setattr(dr, "fetch_sector_flow", lambda *a: [])
        monkeypatch.setattr(dr, "enrich_trend", lambda *a: None)
        monkeypatch.setattr(dr, "fetch_turnover_top20", lambda *a: [])
        monkeypatch.setattr(dr, "fetch_margin_summary", lambda d: {})
        monkeypatch.setattr(dr, "fetch_hsgt_money", lambda d: {})
        monkeypatch.setattr(dr, "fetch_industry_moneyflow_hist", lambda d, days=5: [])
        monkeypatch.setattr(dr, "fetch_moneyflow_asof", lambda d: {})
        import duanxian.trade_calendar as tc
        monkeypatch.setattr(tc, "live_quotes_are_close_of", lambda date: (True, ""))
        text = ddata.get_capital_data("2026-11-25")
        assert "融资融券余额" not in text
        assert "接口时间戳核验" not in text
        assert "参考行情均对应" in text  # 口径说明仍在
