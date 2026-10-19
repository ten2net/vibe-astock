"""technical_indicators / chip_distribution 纯函数测试(手算期望)+ CLI history_json 加载(数组行 / 对象行 / where / JSONP / 路径安全 / 身份)。"""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys
from datetime import date, timedelta

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from calc import indicators  # noqa: E402
from calc.tests.test_formulas import assert_contract  # noqa: E402

CLI = os.path.join(ROOT, "calc", "cli.py")
D0 = date(2026, 1, 5)


def day(i: int) -> str:
    return (D0 + timedelta(days=i)).isoformat()


def linear(n: int, start: float = 1.0):
    """收盘价 start..start+n−1 的等差序列(高 = 收 + 0.5,低 = 收 − 0.5,开 = 收),真实日历日"""
    return [{"date": day(i), "open": start + i, "high": start + i + 0.5, "low": start + i - 0.5, "close": start + i} for i in range(n)]


def test_indicators_linear_series_exact_values():
    out = indicators.technical_indicators(linear(60))
    assert_contract(out)
    assert out["status"] == "ok" and out["value"] == 60.0 and out["unit"] == "元"
    d = out["details"]
    assert d["ma"]["ma5"] == pytest.approx(58.0) and d["ma"]["ma10"] == pytest.approx(55.5) and d["ma"]["ma20"] == pytest.approx(50.5) and d["ma"]["ma60"] == pytest.approx(30.5)
    assert d["rsi"] == {"rsi6": 100.0, "rsi12": 100.0, "rsi24": 100.0}
    std = math.sqrt((20 ** 2 - 1) / 12)
    assert d["boll"]["middle"] == pytest.approx(50.5) and d["boll"]["upper"] == pytest.approx(50.5 + 2 * std) and d["boll"]["lower"] == pytest.approx(50.5 - 2 * std)
    assert d["boll"]["bandwidth_pct"] == pytest.approx((4 * std) / 50.5 * 100)
    assert d["ema"]["ema12"] > d["ema"]["ema26"] and d["ema"]["ema12"] < 60.0 and d["macd"]["dif"] > 0
    assert d["points"] == 60 and d["date"] == day(59) and d["window"] == [day(0), day(59)]


def test_indicators_hand_constants_small_series():
    """closes 1..6,高 = 收 + 0.5,低 = 收 − 0.5;参数缩小到 ema=[3], macd=[2,3,2], kdj=[3,3,3], boll=[3,1]:
    EMA3(k=.5)=5.03125;EMA2(k=2/3)=5.502057613;dif=0.470807613,dea=EMA2(dif)=0.450531550,hist=0.040552126;
    KDJ:RSV 恒 = (c − (c−2−.5))/((c+.5) − (c−2.5))×100 = 83.333…,K/D 自 50 递推三步 → K=76.74897119,D=67.96982167,J=94.30727023;
    BOLL3(1):中轨 5,总体标准差 sqrt(2/3)=0.8164965809。"""
    rows = linear(6)
    out = indicators.technical_indicators(rows, ma=[2], ema=[2, 3], macd=[2, 3, 2], rsi=[2], kdj=[3, 3, 3], boll=[3, 1.0], min_points=5)
    assert_contract(out)
    d = out["details"]
    assert d["ma"]["ma2"] == pytest.approx(5.5)
    assert d["ema"]["ema2"] == pytest.approx(5.502057613168724, abs=1e-9)  # 分数精确:EMA2 k=2/3
    assert d["ema"]["ema3"] == pytest.approx(5.03125, abs=1e-9)
    assert d["macd"]["dif"] == pytest.approx(0.47080761316872427, abs=1e-9)
    assert d["macd"]["dea"] == pytest.approx(0.4505315500685871, abs=1e-9)
    assert d["macd"]["hist"] == pytest.approx(0.04055212620027435, abs=1e-9)
    assert d["rsi"]["rsi2"] == 100.0
    assert d["kdj"]["k"] == pytest.approx(76.74897119341564, abs=1e-9)
    assert d["kdj"]["d"] == pytest.approx(67.96982167352537, abs=1e-9)
    assert d["kdj"]["j"] == pytest.approx(94.30727023319616, abs=1e-9)
    assert d["boll"]["middle"] == pytest.approx(5.0) and d["boll"]["upper"] == pytest.approx(5 + math.sqrt(2 / 3)) and d["boll"]["lower"] == pytest.approx(5 - math.sqrt(2 / 3))


def test_indicators_constant_series_and_short_windows():
    rows = [{"date": day(i), "open": 10, "high": 10, "low": 10, "close": 10} for i in range(30)]
    out = indicators.technical_indicators(rows)
    assert_contract(out)
    d = out["details"]
    assert d["ma"]["ma5"] == 10.0 and d["ma"]["ma60"] is None
    assert d["macd"] == {"dif": 0.0, "dea": 0.0, "hist": 0.0}
    assert d["rsi"]["rsi6"] == 100.0
    assert d["boll"]["upper"] == 10.0 and d["boll"]["bandwidth_pct"] == 0.0
    assert d["kdj"]["k"] == pytest.approx(50.0)


def test_indicators_not_meaningful_and_errors():
    nm = indicators.technical_indicators(linear(10))
    assert_contract(nm)
    assert nm["status"] == "not_meaningful" and nm["details"]["points"] == 10
    assert indicators.technical_indicators([])["status"] == "error"
    assert indicators.technical_indicators([{"date": day(0), "open": 1, "high": 1, "low": 1}] * 30)["status"] == "error"  # 缺 close
    bad = linear(40); bad[3]["close"] = "abc"
    assert indicators.technical_indicators(bad)["status"] == "error"
    dup = linear(40); dup[5]["date"] = dup[4]["date"]
    assert "重复日期" in indicators.technical_indicators(dup)["reason"]
    for bad_date in ("2026-2-10", "2026-13-01", "2026-02-29", "", "20260101"):
        rows = linear(40); rows[7]["date"] = bad_date
        r = indicators.technical_indicators(rows)
        assert r["status"] == "error" and ("日期" in r["reason"] or "缺 date" in r["reason"]), (bad_date, r["reason"])
    for suffix in (" 15:00:00", "T15:00:00+08:00", "T15:00:00.123Z", " 09:31"):
        ok_ts = linear(40); ok_ts[7]["date"] = day(7) + suffix  # 合法时间后缀只取日
        assert indicators.technical_indicators(ok_ts)["status"] == "ok", suffix
    for suffix in ("Tgarbage", " x", "T25:00", "T15:00:00+0800x", "T15:00:00+0800", "T15:00:00+08"):
        bad_ts = linear(40); bad_ts[7]["date"] = day(7) + suffix
        assert indicators.technical_indicators(bad_ts)["status"] == "error", suffix
    # OHLC 自洽 / 正价
    for k, v in (("high", 0.1), ("low", 99), ("close", -1), ("open", 0)):
        rows = linear(40); rows[9][k] = v
        r = indicators.technical_indicators(rows)
        assert r["status"] == "error", (k, v, r["reason"])
    assert indicators.technical_indicators(linear(40), ma=[0])["status"] == "error"
    assert indicators.technical_indicators(linear(40), macd=[12, 26])["status"] == "error"
    assert indicators.technical_indicators(linear(40), boll=[20, 0])["status"] == "error"
    assert indicators.technical_indicators(linear(40), min_points=True)["status"] == "error"
    shuffled = list(reversed(linear(60)))
    assert indicators.technical_indicators(shuffled)["details"]["ma"]["ma5"] == pytest.approx(58.0)


def _bar(i: int, high: float, low: float, close: float, turn: float) -> dict:
    return {"date": day(i), "high": high, "low": low, "close": close, "turn": turn}


def test_chip_distribution_hand_cases():
    # 两天一字板:第 1 天 10 播种全部筹码;第 2 天 12 换手 50% → 一半搬到 12:均成本 11,现价 12 全部获利
    rows = [_bar(0, 10, 10, 10, 0), _bar(1, 12, 12, 12, 50)]
    out = indicators.chip_distribution(rows, min_points=2)
    assert_contract(out)
    assert out["status"] == "ok" and out["unit"] == "小数" and out["value"] == pytest.approx(1.0, abs=1e-9)
    d = out["details"]
    assert d["avg_cost"] == pytest.approx(11.0, abs=0.02) and d["days"] == 2 and d["cum_turnover_pct"] == 50 and d["window"] == [day(0), day(1)]
    # 第 2 天跌到 8、换手 50%:一半在 10 一半在 8;现价 8 → 获利比例 0.5(半步容差让 8 处筹码计入),均成本 9
    rows2 = [_bar(0, 10, 10, 10, 0), _bar(1, 8, 8, 8, 50)]
    o2 = indicators.chip_distribution(rows2, min_points=2)
    assert o2["status"] == "ok" and o2["value"] == pytest.approx(0.5, abs=1e-9) and o2["details"]["avg_cost"] == pytest.approx(9.0, abs=0.02)
    # 三天连续衰减:10 → 12(50%)→ 14(50%):0.25@10 / 0.25@12 / 0.5@14 → 均成本 12.5,现价 14 全部获利,峰在 14
    o3 = indicators.chip_distribution([_bar(0, 10, 10, 10, 0), _bar(1, 12, 12, 12, 50), _bar(2, 14, 14, 14, 50)], min_points=2)
    assert o3["details"]["avg_cost"] == pytest.approx(12.5, abs=0.03) and o3["value"] == pytest.approx(1.0, abs=1e-9) and o3["details"]["peak_price"] == pytest.approx(14.0, abs=0.03)
    # turn=100 → 全部搬走;decay=2 让 60% 换手截断为 100%
    o4 = indicators.chip_distribution([_bar(0, 10, 10, 10, 0), _bar(1, 8, 8, 8, 100)], min_points=2)
    assert o4["details"]["avg_cost"] == pytest.approx(8.0, abs=0.02)
    o5 = indicators.chip_distribution([_bar(0, 10, 10, 10, 0), _bar(1, 8, 8, 8, 60)], min_points=2, decay=2)
    assert o5["details"]["avg_cost"] == pytest.approx(8.0, abs=0.02) and o5["value"] == pytest.approx(1.0, abs=1e-9)
    # 三角分布:单日 低 8 高 12 收 10 → 峰在均价 10、对称:均成本 ≈ 10,现价 10 获利 ≈ 0.5(半步容差使略 > 0.5)
    o6 = indicators.chip_distribution([_bar(0, 12, 8, 10, 0), _bar(1, 12, 8, 10, 0)], min_points=2)
    assert o6["details"]["avg_cost"] == pytest.approx(10.0, abs=0.03) and 0.5 <= o6["value"] <= 0.52 and o6["details"]["peak_price"] == pytest.approx(10.0, abs=0.03)
    # 窄振幅(窄于网格步长)回退到最近网格点,不丢换手衰减:第 2 天 10.001~10.002 换手 100% → 均成本 ≈ 10.0015
    o7 = indicators.chip_distribution([_bar(0, 20, 5, 10, 0), _bar(1, 10.002, 10.001, 10.0015, 100)], min_points=2)
    assert o7["status"] == "ok" and o7["details"]["avg_cost"] == pytest.approx(10.0015, abs=0.06)
    # not_meaningful / error 域
    assert indicators.chip_distribution(rows)["status"] == "not_meaningful"
    assert indicators.chip_distribution(rows, min_points=2, grid_size=10)["status"] == "error"
    assert indicators.chip_distribution(rows, min_points=2, decay=0)["status"] == "error"
    assert indicators.chip_distribution([_bar(0, 10, 10, 10, 150), _bar(1, 10, 10, 10, 1)], min_points=2)["status"] == "error"
    assert indicators.chip_distribution([_bar(0, -1, -1, -1, 1), _bar(1, 1, 1, 1, 1)], min_points=2)["status"] == "error"
    assert indicators.chip_distribution([_bar(0, 9, 10, 9.5, 1), _bar(1, 10, 10, 10, 1)], min_points=2)["status"] == "error"  # high < low
    assert indicators.chip_distribution([_bar(0, 10, 9, 11, 1), _bar(1, 10, 10, 10, 1)], min_points=2)["status"] == "error"  # close 出界
    assert indicators.chip_distribution([{**_bar(0, 10, 9, 9.5, 1), "open": 12}, _bar(1, 10, 10, 10, 1)], min_points=2)["status"] == "error"  # open 给了就要在区间内
    assert indicators.chip_distribution([{**_bar(0, 10, 9, 9.5, 1), "open": 9.8}, _bar(1, 10, 10, 10, 1)], min_points=2)["status"] == "ok"


def _cli(*args, run_dir=None):
    cmd = [sys.executable, CLI, *args]
    if run_dir:
        cmd += ["--run-dir", str(run_dir)]
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode, json.loads(p.stdout)


def _tx_rows(n: int):
    return [[day(i), str(1 + i), str(1 + i), str(1.5 + i), str(0.5 + i), "100"] for i in range(n)]


def test_cli_history_json_array_rows_and_object_rows(tmp_path):
    run_dir = tmp_path / "run"
    (run_dir / "raw").mkdir(parents=True)
    rows = _tx_rows(60)
    (run_dir / "raw" / "tx.js").write_text("cb(" + json.dumps({"code": 0, "data": {"sz300308": {"qfqday": rows}}}) + ");")
    spec = {"klines": {"history_json": {"raw_ref": "raw/tx.js", "rows_path": "data.sz300308.qfqday", "columns": {"date": 0, "open": 1, "close": 2, "high": 3, "low": 4}}}}
    rc, out = _cli("technical_indicators", "--args", json.dumps(spec), "--evidence", "ev-aaaaaa", run_dir=run_dir)
    assert rc == 0, out
    assert out["output"]["status"] == "ok" and out["output"]["details"]["ma"]["ma5"] == pytest.approx(58.0)
    assert out["inputs_resolved"]["klines"]["rows_used"] == 60 and out["inputs_resolved"]["klines"]["sha256"]
    assert out["calculation_id"].startswith("calc-") and out["inputs_refs"] == [{"ref_type": "evidence", "ref_id": "ev-aaaaaa"}]
    rc2, out2 = _cli("technical_indicators", "--args", json.dumps(spec), "--evidence", "ev-aaaaaa", run_dir=run_dir)
    assert out2["calculation_id"] == out["calculation_id"]
    (run_dir / "raw" / "tx.js").write_text("cb(" + json.dumps({"code": 0, "data": {"sz300308": {"qfqday": rows[:-1]}}}) + ")")
    _, out3 = _cli("technical_indicators", "--args", json.dumps(spec), "--evidence", "ev-aaaaaa", run_dir=run_dir)
    assert out3["calculation_id"] != out["calculation_id"]
    # 纯 JSON 也可;对象行 + where 过滤停牌
    bs = {"query": {}, "rows": [{"date": day(i), "high": 10 + i * 0.1, "low": 9 + i * 0.1, "close": 9.5 + i * 0.1, "turn": 1.0, "tradestatus": "1" if i != 3 else "0"} for i in range(25)]}
    (run_dir / "raw" / "bs.json").write_text(json.dumps(bs))
    spec2 = {"klines": {"history_json": {"raw_ref": "raw/bs.json", "rows_path": "rows", "columns": {"date": "date", "high": "high", "low": "low", "close": "close", "turn": "turn"}, "where": {"tradestatus": "1"}}}}
    rc, out = _cli("chip_distribution", "--args", json.dumps(spec2), "--evidence", "ev-bbbbbb", run_dir=run_dir)
    assert rc == 0, out
    assert out["output"]["status"] == "ok" and out["inputs_resolved"]["klines"]["rows_used"] == 24 and out["inputs_resolved"]["klines"]["rows_total"] == 25
    assert 0 <= out["output"]["value"] <= 1


def test_cli_history_json_parse_errors_and_path_safety(tmp_path):
    run_dir = tmp_path / "run"
    (run_dir / "raw" / "sub").mkdir(parents=True)
    good = {"rows": [{"date": day(i), "open": 1, "high": 1, "low": 1, "close": 1} for i in range(30)]}
    (run_dir / "raw" / "a.json").write_text(json.dumps(good))
    (run_dir / "raw" / "sub" / "b.json").write_text(json.dumps(good))
    outside = tmp_path / "outside.json"
    outside.write_text(json.dumps(good))
    os.symlink(outside, run_dir / "raw" / "link_out.json")
    os.symlink(run_dir / "raw" / "a.json", run_dir / "raw" / "link_in.json")
    os.symlink(run_dir / "raw" / "link_out.json", run_dir / "raw" / "link_nested.json")
    (run_dir / "raw" / "dir.json").mkdir()
    (run_dir / "raw" / "jsonp_bad.js").write_text("cb({\"rows\": []}) trailing garbage")
    (run_dir / "raw" / "jsonp_ok.js").write_text("/**/jQuery123_cb(" + json.dumps(good) + ");")
    (run_dir / "raw" / "bad_utf8.json").write_bytes(b'{"rows": [\xff]}')
    (run_dir / "raw" / "mixed.json").write_text(json.dumps({"rows": [[day(0), 1, 1, 1, 1], {"date": day(1), "open": 1, "high": 1, "low": 1, "close": 1}]}))
    (run_dir / "raw" / "arr.json").write_text(json.dumps({"rows": [[day(i), 1, 1, 1, 1] for i in range(30)]}))
    cols_obj = {"date": "date", "open": "open", "high": "high", "low": "low", "close": "close"}
    cols_arr = {"date": 0, "open": 1, "close": 2, "high": 3, "low": 4}
    cases = [
        ({"raw_ref": "raw/a.json", "rows_path": "nope", "columns": cols_obj}, "rows_path"),
        ({"raw_ref": "raw/a.json", "rows_path": "rows", "columns": {"close": "close"}}, "columns"),
        ({"raw_ref": "raw/link_out.json", "rows_path": "rows", "columns": cols_obj}, "越出"),
        ({"raw_ref": "raw/link_nested.json", "rows_path": "rows", "columns": cols_obj}, "越出"),
        ({"raw_ref": "../outside.json", "rows_path": "rows", "columns": cols_obj}, "不得含 .."),
        ({"raw_ref": "raw/sub/../a.json", "rows_path": "rows", "columns": cols_obj}, "不得含 .."),
        ({"raw_ref": "a.json", "rows_path": "rows", "columns": cols_obj}, "raw/"),
        ({"raw_ref": str(outside), "rows_path": "rows", "columns": cols_obj}, "绝对路径"),
        ({"raw_ref": "raw/dir.json", "rows_path": "rows", "columns": cols_obj}, "不是文件"),
        ({"raw_ref": "raw/missing.json", "rows_path": "rows", "columns": cols_obj}, ""),
        ({"raw_ref": "raw/jsonp_bad.js", "rows_path": "rows", "columns": cols_obj}, "JSONP"),
        ({"raw_ref": "raw/bad_utf8.json", "rows_path": "rows", "columns": cols_obj}, "UTF-8"),
        ({"raw_ref": "raw/mixed.json", "rows_path": "rows", "columns": cols_obj}, "混合"),
        ({"raw_ref": "raw/arr.json", "rows_path": "rows", "columns": cols_arr, "where": {"x": "1"}}, "where"),
        ({"raw_ref": "raw/arr.json", "rows_path": "rows", "columns": {"date": 0, "open": 9}}, "下标"),
    ]
    for spec, needle in cases:
        rc, out = _cli("technical_indicators", "--args", json.dumps({"klines": {"history_json": spec}}), run_dir=run_dir)
        assert rc == 3 and out["output"]["details"]["kind"] == "bad_input" and needle in out["output"]["reason"], (spec, out["output"])
    # 合法:raw 内符号链接指向 raw 内文件、子目录文件、带 /**/ 前缀的 JSONP
    for spec in ({"raw_ref": "raw/link_in.json", "rows_path": "rows", "columns": cols_obj}, {"raw_ref": "raw/sub/b.json", "rows_path": "rows", "columns": cols_obj}, {"raw_ref": "raw/jsonp_ok.js", "rows_path": "rows", "columns": cols_obj}):
        rc, out = _cli("technical_indicators", "--args", json.dumps({"klines": {"history_json": spec}}), run_dir=run_dir)
        assert rc == 0 and out["output"]["status"] == "ok", (spec, out["output"])
    rc, out = _cli("technical_indicators", "--args", json.dumps({"klines": {"history_json": {"raw_ref": "raw/a.json", "rows_path": "rows", "columns": cols_obj}}}))
    assert rc == 3 and "--run-dir" in out["output"]["reason"]
    # 缺 raw/ 目录
    empty = tmp_path / "empty"; empty.mkdir()
    rc, out = _cli("technical_indicators", "--args", json.dumps({"klines": {"history_json": {"raw_ref": "raw/a.json", "rows_path": "rows", "columns": cols_obj}}}), run_dir=empty)
    assert rc == 3 and out["output"]["details"]["kind"] == "bad_input"
