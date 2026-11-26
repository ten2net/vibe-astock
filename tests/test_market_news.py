"""财经资讯底座：按目标日过滤与格式化（纯逻辑，akshare 数据源 mock）。"""
import pytest

from duanxian import tools


class TestNormalizeDay:
    def test_date_objects_and_strings(self):
        import datetime
        assert tools._normalize_day(datetime.date(2026, 11, 25)) == "2026-11-25"
        assert tools._normalize_day("2026/11/25 10:30:00") == "2026-11-25"
        assert tools._normalize_day(None) == ""


class TestFetchMarketNews:
    def _patch_sources(self, monkeypatch, cls_rows, em_rows):
        monkeypatch.setattr(tools, "_fetch_cls_news", lambda: cls_rows)
        monkeypatch.setattr(tools, "_fetch_em_news", lambda: em_rows)

    def test_filters_to_target_date(self, monkeypatch):
        self._patch_sources(monkeypatch, [
            {"title": "当日涨停分析", "content": "芯片产业链走强", "day": "2026-11-25", "source": "财联社电报"},
            {"title": "昨日旧闻", "content": "旧", "day": "2026-11-24", "source": "财联社电报"},
        ], [])
        text = tools.fetch_market_news("2026-11-25")
        assert "当日涨停分析" in text
        assert "昨日旧闻" not in text
        assert "已公开财经快讯" in text

    def test_no_target_day_reports_window(self, monkeypatch):
        self._patch_sources(monkeypatch, [
            {"title": "今天", "content": "新", "day": "2026-11-26", "source": "财联社电报"},
        ], [])
        text = tools.fetch_market_news("2026-11-25")
        assert "无已公开快讯" in text
        assert "按时间纪律不拿其它日期充数" in text
        assert "今天" not in text  # 不能用其它日期充数

    def test_both_sources_empty(self, monkeypatch):
        self._patch_sources(monkeypatch, [], [])
        text = tools.fetch_market_news("2026-11-25")
        assert "未取到" in text

    def test_dedup_by_title(self, monkeypatch):
        self._patch_sources(monkeypatch, [
            {"title": "同一条", "content": "A", "day": "2026-11-25", "source": "财联社电报"},
        ], [
            {"title": "同一条", "content": "B", "day": "2026-11-25", "source": "东财快讯"},
        ])
        text = tools.fetch_market_news("2026-11-25")
        assert text.count("同一条") == 1
