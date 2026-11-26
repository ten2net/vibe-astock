"""两融叠加图：绘图、观察指引、产品政策合规（PIL 真实生成，无网络）。"""
import pytest

from review_agent import margin_chart as mc
from review_agent.product_policy import has_trade_recommendation


def _series(n=20, trend_down=True):
    out = []
    for i in range(n):
        bal = 23500 - i * 120 if trend_down else 21200 + i * 120
        net = -300 + (i % 5) * 100
        out.append({"date": f"2026{(10 if i < 10 else 11):02d}{(29 + i) % 28 + 1:02d}",
                    "margin_bal_yi": round(float(bal), 2),
                    "net_buy_yi": round(float(net), 2)})
    return out


class TestRenderMarginChart:
    def test_generates_png(self, tmp_path):
        p = mc.render_margin_chart(_series(), tmp_path / "m.png")
        assert p is not None and p.exists()
        from PIL import Image
        assert Image.open(p).size == (mc.WIDTH, mc.HEIGHT)

    def test_too_few_points_degrades(self, tmp_path):
        assert mc.render_margin_chart(_series(2), tmp_path / "m.png") is None

    def test_invalid_rows_skipped(self, tmp_path):
        s = _series(5) + [{"date": "x", "net_buy_yi": None, "margin_bal_yi": None}]
        assert mc.render_margin_chart(s, tmp_path / "m.png") is not None


class TestMarginGuidance:
    def test_describes_direction_and_verification(self):
        g = mc.margin_guidance(_series(trend_down=True))
        assert "回落" in g and "净偿还" in g
        assert "反证" in g and "验证条件" in g

    def test_does_not_trigger_product_policy(self):
        for down in (True, False):
            g = mc.margin_guidance(_series(trend_down=down))
            assert not has_trade_recommendation(g), g

    def test_too_few_points_empty(self):
        assert mc.margin_guidance(_series(2)) == ""
