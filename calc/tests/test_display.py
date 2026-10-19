"""display.py 测试:有效数字 / 单位映射 / 不可展示域 / 与编排器数字绑定容差的兼容(格式化后仍能绑定回原值)。"""
from __future__ import annotations

import math
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from calc.display import attach_display, format_display, format_number  # noqa: E402


@pytest.mark.parametrize("v,s", [
    (37.397700293773134, "37.40"),
    (0.6328580294544913, "0.6329"),   # |x|<1 留 4 位有效数字:只留 2 位(0.63)虽仍在绑定容差内,但丢信息
    (2.5085831411734563, "2.51"),
    (943, "943.00"),
    (204.53288609, "204.53"),
    (-141.32890358442108, "-141.33"),
    (0.0, "0.00"), (-0.0, "0.00"),
    (0.000123456, "0.0001235"),
    (123456.789, "123456.79"),
])
def test_format_number_sig_digits(v, s):
    assert format_number(v) == s


@pytest.mark.parametrize("out,disp", [
    ({"status": "ok", "value": 2.004222524133979, "unit": "小数"}, "200.42%"),
    ({"status": "ok", "value": 0.28964212772681774, "unit": "小数"}, "28.96%"),
    ({"status": "ok", "value": 0.5909334882897681, "unit": "小数"}, "59.09%"),
    ({"status": "ok", "value": 64.90503715937243, "unit": "%"}, "64.91%"),
    ({"status": "ok", "value": -141.32890358442108, "unit": "百分点"}, "-141.33 百分点"),
    ({"status": "ok", "value": 37.397700293773134, "unit": "倍"}, "37.40 倍"),
    ({"status": "ok", "value": 0.6328580294544913, "unit": "倍"}, "0.6329 倍"),
    ({"status": "ok", "value": 20453288609.02, "unit": "元"}, "204.53 亿元"),
    ({"status": "ok", "value": 7373849136.01, "unit": "元"}, "73.74 亿元"),
    ({"status": "ok", "value": 1103.06, "unit": "亿元"}, "1103.06 亿元"),
    ({"status": "ok", "value": 32500, "unit": "元"}, "3.25 万元"),
    ({"status": "ok", "value": 0.5, "unit": "万元"}, "5000.00 元"),
    ({"status": "ok", "value": 943, "unit": "元"}, "943.00 元"),
    ({"status": "ok", "value": 11, "unit": "期"}, "11 期"),
    ({"status": "ok", "value": 2.3456, "unit": "年"}, "2.35 年"),
    ({"status": "ok", "value": 27.68, "unit": "元/股"}, "27.68 元/股"),
    ({"status": "ok", "value": 5, "unit": ""}, "5.00"),
    ({"status": "ok", "value": 1.5, "unit": "自定义"}, "1.50 自定义"),
])
def test_format_display_units(out, disp):
    assert format_display(out) == disp


@pytest.mark.parametrize("out", [
    {"status": "not_meaningful", "value": None, "unit": "倍"},
    {"status": "error", "value": None, "unit": ""},
    {"status": "ok", "value": None, "unit": "年"},
    {"status": "ok", "value": True, "unit": "倍"},
    {"status": "ok", "value": "12", "unit": "倍"},
    {"status": "ok", "value": float("nan"), "unit": "倍"},
    {"status": "ok", "value": float("inf"), "unit": "元"},
    "not a dict",
])
def test_format_display_none_domains(out):
    assert format_display(out) is None


def test_attach_display_is_pure():
    out = {"status": "ok", "value": 1.0, "unit": "倍", "reason": "", "details": {}}
    got = attach_display(out)
    assert got["display"] == "1.00 倍" and "display" not in out and got is not out


def _number_bound(token: float, pool: list[float]) -> bool:
    """复刻编排器 hardtest.ts numberBound:量纲变体 × 相对 2e-3 / 绝对 5e-3 容差。"""
    scales = [1, 1e4, 1e8, 100, 0.01, 1e-4, 1e-8]
    for v in pool:
        for s in scales:
            w = v * s
            if not math.isfinite(w):
                continue
            tol = max(abs(token) * 2e-3, 5e-3)
            if abs(w - token) <= tol:
                return True
    return False


@pytest.mark.parametrize("value,unit", [
    (2.004222524133979, "小数"), (0.28964212772681774, "小数"), (0.5909334882897681, "小数"),
    (64.90503715937243, "%"), (-141.32890358442108, "百分点"), (37.397700293773134, "倍"),
    (0.6328580294544913, "倍"), (2.5085831411734563, "倍"), (20453288609.02, "元"), (7373849136.01, "元"),
    (11030.6, "亿元"), (32500, "元"), (943, "元"), (11, "期"), (27.68, "元/股"), (0.000123456, "小数"),
])
def test_display_stays_bindable_to_value(value, unit):
    """格式化后的数字必须仍能按编排器规则绑定回原始 value(否则报告数字绑定校验会把它判成编造)。"""
    disp = format_display({"status": "ok", "value": value, "unit": unit})
    assert disp is not None
    token = float(disp.split()[0].rstrip("%"))
    assert _number_bound(token, [value]), (disp, value)


@pytest.mark.parametrize("out", [
    {"status": "ok", "value": 1e308, "unit": "小数"},   # ×100 溢出
    {"status": "ok", "value": 1e308, "unit": "元"},     # 归一到元不溢出但 ≥1e8 分支仍有限 → 走正常;见下一条
    {"status": "ok", "value": 1e308, "unit": "亿元"},   # ×1e8 溢出
])
def test_display_scaled_overflow_returns_none_or_finite(out):
    d = format_display(out)
    assert d is None or ("inf" not in d and "nan" not in d)


def test_attach_display_nests_into_result_shaped_details():
    scen = {"景气延续": {"status": "ok", "value": 0.47469715608844315, "unit": "年", "reason": "", "details": {"anchor": 30}},
            "中性减速": {"status": "not_meaningful", "value": None, "unit": "年", "reason": "x", "details": {}}}
    out = {"status": "ok", "value": None, "unit": "年", "reason": "", "details": {"scenarios": scen, "anchors": {"景气延续": 30}, "series": [{"status": "ok", "value": 1.5, "unit": "倍", "reason": "", "details": {}}]}}
    got = attach_display(out)
    assert got["display"] is None
    assert got["details"]["scenarios"]["景气延续"]["display"] == "0.4747 年"
    assert got["details"]["scenarios"]["中性减速"]["display"] is None
    assert got["details"]["series"][0]["display"] == "1.50 倍"
    assert got["details"]["anchors"] == {"景气延续": 30} and "display" not in got["details"]["anchors"]
    assert "display" not in out["details"]["scenarios"]["景气延续"]  # 不改入参
