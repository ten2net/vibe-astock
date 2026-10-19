"""大宗温度计(第 13 层原材料维度)离线测试:序列统计 / 陈旧 / 双日期格式 / 契约错误 / 逐项隔离 / mapper 口径。不访问网络。"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
sys.path.insert(0, SCRIPTS)
from sources import commodity, mappers_commodity  # noqa: E402

NOW = datetime(2026, 8, 24, tzinfo=timezone.utc)
CTX = {"script": "cn_commodity_futures", "symbol": "300308", "market": "SZ", "source": "s", "endpoint": "x", "as_of": None, "raw_ref": None, "args": {}}


def test_series_stats_windows_and_span_honesty():
    """稀疏序列不许把 27 天跨度标成"约 7 日"(Codex commodity-r1):超过窗口 2 倍容差 → 不生成该指标,并记进 skipped_windows。"""
    series = [("2026-07-01", 100.0), ("2026-07-25", 110.0), ("2026-08-20", 120.0), ("2026-08-21", 126.0)]
    st = commodity._stats(series, "2026-08-24", 10)
    assert st["date"] == "2026-08-21" and st["price"] == 126.0 and st["age_days"] == 3 and st["stale"] is False
    assert st["chg1_pct"] == 5.0 and st["chg1_basis"] == "2026-08-20" and st["chg1_gap_days"] == 1
    assert "chg7_pct" not in st, "07-25 距 08-21 有 27 天,不配叫约 7 日"
    assert st["skipped_windows"] == [{"window_days": 7, "basis_date": "2026-07-25", "actual_gap_days": 27}]
    # 30 日窗口在 [25,35] 里选距目标最近的点 → 07-25(27 天),而不是更早的 07-01(51 天)
    assert st["chg30_pct"] == pytest.approx(14.55, 0.01) and st["chg30_basis"] == "2026-07-25" and st["chg30_gap_days"] == 27
    # 周更序列:目标日之后的点也要看(Codex commodity-r3)——08-15 距今 6 天,在 7±3 内,应被选中而不是退到 13 天前
    weekly = commodity._stats([("2026-08-08", 90.0), ("2026-08-15", 100.0), ("2026-08-21", 110.0)], "2026-08-24", 14)
    assert weekly["chg7_pct"] == 10.0 and weekly["chg7_basis"] == "2026-08-15" and weekly["chg7_gap_days"] == 6
    assert weekly["skipped_windows"] == []
    # 加法容差(Codex commodity-r2:2 倍容差下 60 天变化仍会被叫"约 30 日"):30 日窗口最多认到 35 天
    edge = commodity._stats([("2026-06-25", 100.0), ("2026-08-24", 120.0)], "2026-08-24", 10)
    assert "chg30_pct" not in edge and edge["skipped_windows"][-1]["actual_gap_days"] == 60
    ok35 = commodity._stats([("2026-07-20", 100.0), ("2026-08-24", 120.0)], "2026-08-24", 10)
    assert ok35["chg30_pct"] == 20.0 and ok35["chg30_gap_days"] == 35, "恰好 30+5 仍算"
    over36 = commodity._stats([("2026-07-19", 100.0), ("2026-08-24", 120.0)], "2026-08-24", 10)
    assert "chg30_pct" not in over36, "36 天超容差"
    # 日频序列:两个窗口都在容差内,基点与跨度都记下来
    daily = [(f"2026-07-{d:02d}", 100.0 + d) for d in range(1, 32)] + [(f"2026-08-{d:02d}", 140.0 + d) for d in range(1, 22)]
    d2 = commodity._stats(daily, "2026-08-22", 10)
    assert d2["chg7_gap_days"] == 7 and d2["chg30_gap_days"] == 30 and d2["skipped_windows"] == []
    # 陈旧边界:age > 阈值才算 —— 恰好 10 天不算,11 天才算
    assert commodity._stats(series, "2026-08-31", 10)["age_days"] == 10 and commodity._stats(series, "2026-08-31", 10)["stale"] is False
    assert commodity._stats(series, "2026-09-01", 10)["stale"] is True
    # 只有一个点 → 没有任何涨跌指标(不外推)
    one = commodity._stats([("2026-08-21", 5.0)], "2026-08-24", 10)
    assert "chg1_pct" not in one and "chg7_pct" not in one


def test_row_validation_rejects_bad_points():
    """行级校验(Codex commodity-r1):未来日期 / 非有限数 / 非正数 / 无法解析都丢行,不让整品种失败也不进证据。"""
    ok = commodity._valid_point("2026-08-21", 126.0, "2026-08-24")
    assert ok == ("2026-08-21", 126.0)
    assert commodity._valid_point("2026-08-25", 1.0, "2026-08-24") is None   # 未来日期
    assert commodity._valid_point("2026-08-21", None, "2026-08-24") is None  # None
    assert commodity._valid_point("2026-08-21", float("inf"), "2026-08-24") is None
    assert commodity._valid_point("2026-08-21", float("nan"), "2026-08-24") is None
    assert commodity._valid_point("2026-08-21", -1.0, "2026-08-24") is None  # 负价
    assert commodity._valid_point("2026-08-21", 0.0, "2026-08-24") is None   # 0 价
    assert commodity._valid_point("垃圾", 1.0, "2026-08-24") is None


def test_date_and_price_normalization():
    assert commodity._norm_date("2026-08-24") == "2026-08-24"
    assert commodity._norm_date("8/21/2026") == "2026-08-21"
    assert commodity._norm_date("2026-02-30") is None      # 假日历日
    assert commodity._norm_date("13/40/2026") is None
    assert commodity._norm_date("Aug 21, 2026") is None    # 不猜
    assert commodity._norm_price("$54.100") == 54.1
    assert commodity._norm_price(91.073) == 91.073
    assert commodity._norm_price("N/A") is None and commodity._norm_price("") is None


def test_futures_isolation_and_mapper(monkeypatch):
    class FakeAk:
        @staticmethod
        def futures_zh_daily_sina(symbol):
            if symbol == "SN0":
                raise RuntimeError("sina down")
            import types
            rows = [("2026-07-01", 100.0), ("2026-07-25", 110.0), ("2026-08-21", 126.0)]
            return types.SimpleNamespace(__getitem__=lambda self, k: [r[0] for r in rows] if k == "date" else [r[1] for r in rows],
                                         tolist=lambda: None)

    class FakeCol(list):
        def tolist(self):
            return list(self)

    class FakeDF(dict):
        def __getitem__(self, k):
            return FakeCol(super().__getitem__(k))

    def fake_daily(symbol):
        if symbol == "SN0":
            raise RuntimeError("sina down")
        # 混入坏行:None 收盘 / 未来日期 —— 逐行丢弃,不让整品种失败(Codex commodity-r1)
        return FakeDF({"date": ["2026-07-01", "2026-07-22", "2026-08-20", "2026-08-21", "2026-09-01"],
                       "close": [100.0, 110.0, 120.0, 126.0, None]})

    import types
    monkeypatch.setitem(sys.modules, "akshare", types.SimpleNamespace(futures_zh_daily_sina=fake_daily))
    monkeypatch.setattr(commodity, "record_raw", lambda *a, **k: "raw/fut.json")
    r = commodity.cn_commodity_futures("CU0,SN0", now=NOW)
    assert [i["symbol"] for i in r["items"]] == ["CU0"] and len(r["errors"]) == 1
    m = mappers_commodity.cn_commodity_futures_map(r, CTX)
    by = {(e["field"], e["record_key"]): e for e in m["evidence"]}
    close = by[("commodity_futures_close", "CU0")]
    assert close["value"] == 126.0 and close["unit"] == "元/吨" and close["currency"] == "CNY"
    assert close["symbol"] == "MARKET" and close["market"] == "CN"       # 全市场证据契约
    assert "不是本公司采购价" in close["note"] and "PCB 铜箔" in close["note"]
    # 08-21 往前 30 天 = 07-22(110.0)→ +14.55%,基点恰好 30 天;涨跌证据必须写明基点日期与实际跨度
    chg30 = by[("commodity_futures_chg30_pct", "CU0")]
    assert chg30["value"] == pytest.approx(14.55, 0.01)
    assert "对比基点 2026-07-22" in chg30["note"] and "实际间隔 30 自然日" in chg30["note"]
    assert "已丢弃不合法行 1 条" in close["note"]
    assert m["status"] == "partial" and "SN0" in m["degraded"]
    # 全失败 → 抛
    monkeypatch.setitem(sys.modules, "akshare", types.SimpleNamespace(futures_zh_daily_sina=lambda symbol: (_ for _ in ()).throw(RuntimeError("down"))))
    with pytest.raises(commodity.CommodityError):
        commodity.cn_commodity_futures("CU0", now=NOW)


def test_futures_empty_rows_is_contract_error(monkeypatch):
    import types

    class FakeCol(list):
        def tolist(self):
            return list(self)

    class FakeDF(dict):
        def __getitem__(self, k):
            return FakeCol(super().__getitem__(k))

    monkeypatch.setitem(sys.modules, "akshare", types.SimpleNamespace(futures_zh_daily_sina=lambda symbol: FakeDF({"date": [], "close": []})))
    monkeypatch.setattr(commodity, "record_raw", lambda *a, **k: "raw/f.json")
    with pytest.raises(commodity.CommodityError):  # 0 行 = 结构变了,全失败才抛
        commodity.cn_commodity_futures("CU0", now=NOW)


def _dram_payload():
    return {
        "https://raw.githubusercontent.com/nlee756525/dram-prices/main/history.json": {
            "ddr5": [{"date": "7/21/2026", "session_avg": "$50.000"}, {"date": "8/21/2026", "session_avg": "$54.100"}],
            "tlc": [{"date": "8/10/2026", "session_avg": "$21.125"}],
        },
        "https://raw.githubusercontent.com/titled-agent-001/ddr4-pricing-log/main/ddr4-pricing.json": {
            "product": "DDR4 16Gb (2Gx8) 3200", "source": "DRAMeXchange",
            "logs": [{"date": "2026-07-24", "session_average": 80.0}, {"date": "2026-08-24", "session_average": 91.073}],
        },
    }


def test_dram_parsing_and_mapper(monkeypatch):
    payloads = _dram_payload()

    class FakeResp:
        def __init__(self, b): self._b = b
        def read(self): return self._b
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(commodity.urllib.request, "urlopen", lambda req, timeout=30: FakeResp(json.dumps(payloads[req.full_url]).encode()))
    monkeypatch.setattr(commodity, "record_raw", lambda *a, **k: "raw/dram.json")
    r = commodity.dram_spot_thermo(now=NOW)
    keys = {i["key"]: i for i in r["items"]}
    assert set(keys) == {"DDR5", "NAND_TLC", "DDR4"} and not r["errors"]
    assert keys["DDR5"]["price"] == 54.1 and keys["DDR5"]["date"] == "2026-08-21"
    assert keys["DDR4"]["product"].startswith("DDR4 16Gb")
    assert "规格未在数据中标明" in keys["DDR5"]["product"]     # ddr5 仓没有 product 字段 → 如实写
    # 陈旧是**边界外**才算:08-10 距 08-24 恰好 14 天 = 阈值上,不算陈旧;晚一天(08-25 视角)才算
    assert keys["NAND_TLC"]["age_days"] == 14 and keys["NAND_TLC"]["stale"] is False
    from datetime import timedelta
    r2 = commodity.dram_spot_thermo(now=NOW + timedelta(days=1))
    assert {i["key"]: i["stale"] for i in r2["items"]}["NAND_TLC"] is True
    m2 = mappers_commodity.dram_spot_thermo_map(r2, {**CTX, "script": "dram_spot_thermo"})
    assert m2["status"] == "partial" and "NAND_TLC" in m2["degraded"]
    assert "资料已陈旧" in [e for e in m2["evidence"] if e["record_key"] == "NAND_TLC"][0]["note"]
    m = mappers_commodity.dram_spot_thermo_map(r, {**CTX, "script": "dram_spot_thermo"})
    avg = [e for e in m["evidence"] if e["field"] == "dram_spot_avg" and e["record_key"] == "DDR5"][0]
    assert avg["market"] == "US" and avg["symbol"] == "MARKET" and avg["currency"] == "USD"
    assert "社区" in avg["note"] and "影子指标" in avg["note"] and "不是 HBM 价格" in avg["note"]


def test_dram_contract_errors(monkeypatch):
    class FakeResp:
        def __init__(self, b): self._b = b
        def read(self): return self._b

    # 字段名变了(一行都解析不出)→ 该源失败;全失败才抛
    bad = {"ddr5": [{"day": "8/21/2026", "avg": "$54"}], "tlc": [{"day": "x"}]}
    monkeypatch.setattr(commodity.urllib.request, "urlopen", lambda req, timeout=30: FakeResp(json.dumps(bad).encode()))
    monkeypatch.setattr(commodity, "record_raw", lambda *a, **k: "raw/d.json")
    with pytest.raises(commodity.CommodityError):
        commodity.dram_spot_thermo(now=NOW)
    # 返回不是对象
    monkeypatch.setattr(commodity.urllib.request, "urlopen", lambda req, timeout=30: FakeResp(b"[1,2]"))
    with pytest.raises(commodity.CommodityError):
        commodity.dram_spot_thermo(now=NOW)
