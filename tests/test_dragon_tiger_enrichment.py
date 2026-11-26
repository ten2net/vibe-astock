"""龙虎榜增强：席位身份归类与聚合输出（纯逻辑，数据源全部 mock）。"""
import pytest

from duanxian import data as ddata
from duanxian import fetchers as dr


class TestClassifySeat:
    """席位身份按名称线索归类，优先级：机构专用 > 北向 > 知名游资 > 一般。"""

    @pytest.mark.parametrize("name,expected", [
        ("机构专用", "机构专用"),
        ("沪股通专用", "北向资金"),
        ("深股通专用", "北向资金"),
        ("香港中央结算有限公司", "北向资金"),
        ("东方财富证券拉萨团结路第一证券营业部", "知名游资席位"),
        ("国泰海通证券南京溧阳路证券营业部", "知名游资席位"),
        ("国泰海通证券北京知春路证券营业部", "一般营业部"),
        ("某随机营业部", "一般营业部"),
        ("", "一般营业部"),
    ])
    def test_classify(self, name, expected):
        assert dr.classify_seat(name) == expected

    def test_priority_institution_over_northbound(self):
        # 同时含两个线索时，机构专用优先
        assert dr.classify_seat("机构专用（沪股通）") == "机构专用"


class TestAggregatedData:
    """get_dragon_tiger_data 整合行业/机构/席位/东财解读。"""

    def _seed(self, monkeypatch):
        """把数据源都替换成离线样本。"""
        monkeypatch.setattr(dr, "fetch_lhb", lambda date, top=15: [
            {"code": "000001", "name": "甲股", "net_buy": 2.5, "reason": "涨幅偏离"},
            {"code": "000002", "name": "乙股", "net_buy": 1.2, "reason": "换手异常"},
        ])
        monkeypatch.setattr(dr, "fetch_industry_map", lambda: {"000001": "银行", "000002": "软件服务"})
        monkeypatch.setattr(dr, "fetch_lhb_inst_summary", lambda date: {
            "000001": {"name": "甲股", "buy_inst": 3, "sell_inst": 1,
                       "inst_net_yi": 0.8, "inst_ratio": 5.1593},
            "000002": {"name": "乙股", "buy_inst": 0, "sell_inst": 0,
                       "inst_net_yi": None, "inst_ratio": None},
        })
        monkeypatch.setattr(dr, "fetch_lhb_seat_identity", lambda date, codes, top_seats=3: {
            "000001": {
                "buy": [{"seat": "沪股通专用", "identity": "北向资金", "net_yi": 1.0},
                        {"seat": "机构专用", "identity": "机构专用", "net_yi": 0.5}],
                "sell": [{"seat": "拉萨某营业部", "identity": "知名游资席位", "net_yi": -0.3}],
                "inst_buy_yi": 0.5, "inst_sell_yi": 0.0,
            },
        })
        monkeypatch.setattr(dr, "fetch_lhb_em_explain", lambda date, top=15: {
            "000001": {"explain": "3家机构买入，成功率40.00%", "turnover": 3.2, "deal_ratio": 30.0},
        })

    def test_enriched_output(self, monkeypatch):
        self._seed(monkeypatch)
        text = ddata.get_dragon_tiger_data("2026-11-24")
        # 行业标签与分布
        assert "行业：银行" in text
        assert "行业分布" in text and "银行×1" in text
        # 机构统计
        assert "机构专用席位参与" in text
        assert "买方机构3家/卖方1家" in text
        assert "机构净买+0.800亿" in text
        assert "5.16%" in text  # 占比已格式化为两位小数
        # 席位身份线索
        assert "席位明细与身份线索" in text
        assert "北向资金·沪股通专用" in text
        assert "机构专用·机构专用" in text
        assert "知名游资席位·拉萨" in text
        # 东财解读
        assert "东财解读：3家机构买入，成功率40.00%" in text

    def test_missing_optional_sources_degrade(self, monkeypatch):
        """可选源全部缺失时仍输出主榜，不崩。"""
        monkeypatch.setattr(dr, "fetch_lhb", lambda date, top=15: [
            {"code": "000001", "name": "甲股", "net_buy": 2.5, "reason": "涨幅偏离"},
        ])
        monkeypatch.setattr(dr, "fetch_industry_map", lambda: {})
        monkeypatch.setattr(dr, "fetch_lhb_inst_summary", lambda date: {})
        monkeypatch.setattr(dr, "fetch_lhb_seat_identity", lambda date, codes, top_seats=3: {})
        monkeypatch.setattr(dr, "fetch_lhb_em_explain", lambda date, top=15: {})
        text = ddata.get_dragon_tiger_data("2026-11-24")
        assert "甲股" in text and "净买+2.50亿" in text
        assert "行业分布" not in text
        assert "机构专用席位参与" not in text
        assert "席位明细与身份线索" not in text
        assert "东财解读" not in text
