"""数据日历(第 15 层)离线测试:预约披露行解析 / 上下游状态 / Nasdaq 文案解析 / mapper 口径。不访问网络。"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
sys.path.insert(0, SCRIPTS)
from sources import datacal, mappers_datacal  # noqa: E402

NOW = datetime(2026, 8, 24, tzinfo=timezone.utc)
CTX = {"script": "next_disclosure", "symbol": "300308", "market": "SZ", "source": "eastmoney", "endpoint": "em", "as_of": None, "raw_ref": None, "args": {}}


def em_payload(rows):
    return {"success": True, "result": {"data": rows}}


def row(rd, appoint=None, first=None, actual=None, code="300308"):
    ts = lambda d: f"{d} 00:00:00" if d else None  # noqa: E731
    return {"SECURITY_CODE": code, "REPORT_DATE": ts(rd), "APPOINT_PUBLISH_DATE": ts(appoint), "FIRST_APPOINT_DATE": ts(first), "ACTUAL_PUBLISH_DATE": ts(actual)}


def test_next_disclosure_parsing(monkeypatch):
    payload = em_payload([
        row("2026-09-30", appoint="2026-10-27"),                       # 未披露 → 下一个
        row("2026-06-30", appoint="2026-08-24", actual="2026-08-22"),  # 已披露(提前)
        row("2026-03-31", appoint="2026-04-17", actual="2026-04-17"),
        row("2026-12-31", appoint="2027-03-31", code="999999"),        # 别家代码,丢弃
        {"SECURITY_CODE": "300308", "REPORT_DATE": "垃圾"},              # 解析不出报告期,跳过
    ])
    monkeypatch.setattr(datacal, "em_json", lambda *a, **k: payload)
    monkeypatch.setattr(datacal, "last_raw_ref", lambda: "raw/em.json")
    r = datacal.next_disclosure("300308", now=NOW)
    assert [x["report_date"] for x in r["rows"]] == ["2026-09-30", "2026-06-30", "2026-03-31"]
    assert r["today"] == "2026-08-24" and r["raw_ref"] == "raw/em.json"
    m = mappers_datacal.next_disclosure_map(r, CTX)
    by = {e["field"]: e for e in m["evidence"]}
    nxt = by["next_report_appoint_date"]
    assert nxt["value"] == "2026-10-27" and nxt["period"] == "2026-09-30" and "预约" in nxt["note"] and "延期信号" not in nxt["note"]
    latest = by["latest_report_published_date"]
    assert latest["value"] == "2026-08-22" and latest["period"] == "2026-06-30"
    assert m["status"] == "ok"


def test_next_disclosure_overdue_and_none(monkeypatch):
    # 过了预约日仍未披露 → note 里必须有延期信号
    monkeypatch.setattr(datacal, "em_json", lambda *a, **k: em_payload([row("2026-06-30", appoint="2026-08-20")]))
    monkeypatch.setattr(datacal, "last_raw_ref", lambda: "raw/em.json")
    m = mappers_datacal.next_disclosure_map(datacal.next_disclosure("300308", now=NOW), CTX)
    assert "延期信号" in m["evidence"][0]["note"]
    # 没有未披露行 → "尚未预约"状态证据,不是缺口
    monkeypatch.setattr(datacal, "em_json", lambda *a, **k: em_payload([row("2026-06-30", appoint="2026-08-24", actual="2026-08-22")]))
    m2 = mappers_datacal.next_disclosure_map(datacal.next_disclosure("300308", now=NOW), CTX)
    by = {e["field"]: e for e in m2["evidence"]}
    assert by["next_report_appoint_status"]["value"] == "尚未预约" and "不是数据缺口" in by["next_report_appoint_status"]["note"]
    # result=null = 真实无记录:不抛,degraded 出声
    monkeypatch.setattr(datacal, "em_json", lambda *a, **k: {"success": True, "result": None})
    m3 = mappers_datacal.next_disclosure_map(datacal.next_disclosure("300308", now=NOW), CTX)
    assert m3["status"] == "ok" and m3["degraded"]


def test_next_disclosure_contract_errors(monkeypatch):
    monkeypatch.setattr(datacal, "last_raw_ref", lambda: None)
    monkeypatch.setattr(datacal, "em_json", lambda *a, **k: {"success": False})
    with pytest.raises(datacal.DatacalError):
        datacal.next_disclosure("300308", now=NOW)
    # success=true 但缺 result / result 缺 data = 结构损坏,不当"无记录"(Codex datacal-r1)
    monkeypatch.setattr(datacal, "em_json", lambda *a, **k: {"success": True})
    with pytest.raises(datacal.DatacalError):
        datacal.next_disclosure("300308", now=NOW)
    monkeypatch.setattr(datacal, "em_json", lambda *a, **k: {"success": True, "result": {}})
    with pytest.raises(datacal.DatacalError):
        datacal.next_disclosure("300308", now=NOW)
    # 显式 data=[] = 真实无记录
    monkeypatch.setattr(datacal, "em_json", lambda *a, **k: {"success": True, "result": {"data": []}})
    assert datacal.next_disclosure("300308", now=NOW)["rows"] == []
    monkeypatch.setattr(datacal, "em_json", lambda *a, **k: {"success": True, "result": {"data": {"a": 1}}})
    with pytest.raises(datacal.DatacalError):
        datacal.next_disclosure("300308", now=NOW)
    # 有数据但一行都解析不出 = 结构变了,必须抛(不当"没数据")
    monkeypatch.setattr(datacal, "em_json", lambda *a, **k: em_payload([{"SECURITY_CODE": "300308", "REPORT_DATE": None}]))
    with pytest.raises(datacal.DatacalError):
        datacal.next_disclosure("300308", now=NOW)


def test_parse_earnings_text():
    est = datacal._parse_earnings_text("NVIDIA Corporation Common Stock is expected* to report earnings on  08/26/2026 after market close.  The report will be for the fiscal Quarter ending Jul 2026.")
    assert est == {"date": "2026-08-26", "estimated": True, "timing": "盘后(美股当地交易日;≈北京时间次日凌晨)", "fiscal_period_end": "2026-07"}
    conf = datacal._parse_earnings_text("X will report earnings on 11/19/2026 before market open. fiscal Quarter ending Oct 2026.")
    assert conf["estimated"] is False and conf["timing"].startswith("盘前") and conf["date"] == "2026-11-19"
    # 锚定句式:文案里先出现别的日期(财季止)不会被抓错(Codex datacal-r1)
    other = datacal._parse_earnings_text("Fiscal quarter ended 07/31/2026. X will announce earnings on 08/26/2026 after market close.")
    assert other["date"] == "2026-08-26"
    # 单数字月份 / 全月名财季 / 大小写
    m1 = datacal._parse_earnings_text("will report earnings on 9/3/2026. fiscal year ending December 2026.")
    assert m1["date"] == "2026-09-03" and m1["fiscal_period_end"] == "2026-12"
    # 假日历日 / 多个互斥日期 / 无锚定日期 → 抛
    with pytest.raises(datacal.DatacalError):
        datacal._parse_earnings_text("will report earnings on 13/40/2026")
    with pytest.raises(datacal.DatacalError):
        datacal._parse_earnings_text("will report earnings on 08/26/2026; will announce results on 09/02/2026")
    with pytest.raises(datacal.DatacalError):
        datacal._parse_earnings_text("Fiscal quarter ended 07/31/2026, nothing else")
    with pytest.raises(datacal.DatacalError):
        datacal._parse_earnings_text("no date here")


def test_us_anchor_earnings_isolation(monkeypatch):
    calls = {"n": 0}

    def fake_get(url, **kw):
        calls["n"] += 1
        if "NVDA" in url:
            return {"data": {"reportText": "expected* to report earnings on 08/26/2026 after market close. fiscal Quarter ending Jul 2026."}}
        raise RuntimeError("boom")

    monkeypatch.setattr(datacal, "official_get", fake_get)
    monkeypatch.setattr(datacal, "last_raw_ref", lambda: "raw/nq.json")
    r = datacal.us_anchor_earnings("NVDA,MU", now=NOW)
    assert [a["ticker"] for a in r["anchors"]] == ["NVDA"] and len(r["errors"]) == 1
    m = mappers_datacal.us_anchor_earnings_map(r, {**CTX, "script": "us_anchor_earnings"})
    e = m["evidence"][0]
    assert e["field"] == "us_anchor_earnings_date" and e["value"] == "2026-08-26" and e["market"] == "US" and e["record_key"] == "NVDA"
    assert "预估" in e["note"] and "盘后" in e["note"]
    # 无预估标记 ≠ 公司确认:三态口径(Codex datacal-r1)
    r2 = {"today": "2026-08-24", "anchors": [{"ticker": "NVDA", "date": "2026-08-26", "estimated": False, "timing": "时段未注明", "fiscal_period_end": None, "raw_ref": "raw/nq.json"}], "errors": []}
    m2 = mappers_datacal.us_anchor_earnings_map(r2, {**CTX, "script": "us_anchor_earnings"})
    e2 = m2["evidence"][0]
    assert "未核实" in e2["note"] and "确认口径" not in e2["note"] and e2["period"] == "n/a"
    assert m2["degraded"] and "财季未解析" in m2["degraded"]
    assert m["status"] == "partial" and "MU" in m["degraded"]
    # 全失败 → 抛
    monkeypatch.setattr(datacal, "official_get", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down")))
    with pytest.raises(datacal.DatacalError):
        datacal.us_anchor_earnings("NVDA", now=NOW)
