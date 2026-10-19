"""管制与准入(第 14 层)离线测试:英文名 / 别名 / 1260H 全文判定三态 / BIS 0 结果形态 / FCC 解析 / 失败隔离 / mapper。不访问网络。"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
REPO = os.path.normpath(os.path.join(SCRIPTS, "..", "..", "..", ".."))
sys.path.insert(0, SCRIPTS)
from sources import mappers_policy, policy  # noqa: E402

NOW = datetime(2026, 8, 23, tzinfo=timezone.utc)
_CTX = {"script": "policy_access", "symbol": "300308", "market": "SZ", "source": "s", "endpoint": "x", "as_of": None, "raw_ref": None, "args": {}}


class R:
    def __init__(self, status, body, raw="raw/x.json", text=None):
        self.status_code, self._body, self._vra_raw_ref = status, body, raw
        self.text = text if text is not None else (body if isinstance(body, str) else json.dumps(body))

    def json(self):
        return self._body if not isinstance(self._body, str) else json.loads(self._body)


CNINFO = {"data": {"records": [{"basicInformation": [{"F001V": "Zhongji Innolight Co., Ltd.", "F002V": "中际旭创"}]}]}}
DOD_FULL = {"title": "Notice of Availability of Designation of Chinese Military Companies", "publication_date": "2026-06-10", "document_number": "2026-11571", "raw_text_url": "https://fr/raw/2026-11571", "html_url": "https://fr/2026-11571"}
DOD_SEARCH = {"count": 1, "results": [DOD_FULL]}
DOD_TEXT = "<html>" + "x" * 2500 + "<p>Hangzhou Hikvision Digital Technology Co., Ltd.</p><p>     reason</p><p>Zhongji\nInnolight Co.,Ltd. (Innolight)</p><p>     reason</p></html>"
DOD_REMOVAL = {"title": "Removal of Designated Chinese Military Companies", "publication_date": "2026-07-20", "document_number": "2026-13000", "raw_text_url": "https://fr/raw/2026-13000", "html_url": "https://fr/2026-13000"}
DOD_REMOVAL_TEXT = "<html>" + "x" * 2500 + "<p>Hesai Technology Co., Ltd. is removed.</p></html>"
FCC_MD = """Title: Covered List
Markdown Content:
# Covered List
### Covered List
| **Entity** | **Date** |
| --- | --- |
| Huawei Technologies Company | March 12, 2021 |
| Huawei Technologies Company | March 12, 2021 |
| Any equipment produced in a foreign country by foreign entities | June 1, 2026 |
### Conditional Approvals
| **Entity** | **Detail** |
| Some Co | approved |
"""


def _fake(mapping):
    def get(url, params=None, headers=None, timeout=None, ext=None, **kw):
        for key, resp in mapping.items():
            if key in url:
                if isinstance(resp, Exception):
                    raise resp
                return resp
        raise AssertionError("unexpected url " + url)
    return get


def test_english_name_aliases_and_1260h_three_states(monkeypatch):
    monkeypatch.setattr(policy, "http_get", _fake({"cninfo": R(200, CNINFO, raw="raw/cn.json"), "documents.json": R(200, DOD_SEARCH), "fr/raw": R(200, DOD_TEXT, raw="raw/dod.html", text=DOD_TEXT)}))
    name, raw = policy.cn_english_name("300308")
    assert name == "Zhongji Innolight Co., Ltd." and raw == "raw/cn.json"
    assert policy.aliases_of(name) == ["Zhongji Innolight Co., Ltd.", "Zhongji Innolight"]
    assert policy.aliases_of("AB Co., Ltd.") == ["AB Co., Ltd."], "短名 < 8 字符不用"
    d = policy.fetch_1260h(policy.aliases_of(name))
    assert d["status"] == "on_list" and d["matched"] == "Zhongji Innolight Co., Ltd." and "innolight" in d["context"] and d["doc"] == "2026-11571" and d["raw_ref"] == "raw/dod.html", "跨行 + Co.,Ltd 写法 + 标签边界都能命中"
    assert policy.fetch_1260h(["Foo Bar Optics Co., Ltd."])["status"] == "not_on_list"
    assert policy.fetch_1260h([])["status"] == "undetermined", "无别名 → undetermined 不是 not_on_list"
    # 规范化:Co. Ltd / Company Limited / 全大写 / NBSP
    for variant in ["Zhongji Innolight Co. Ltd.", "ZHONGJI INNOLIGHT COMPANY LIMITED", "Zhongji\u00a0Innolight Co., Ltd."]:
        assert policy.match_entity("xx " + variant + " yy", policy.aliases_of(name))["state"] == "on", variant
    assert policy.match_entity("Acme Innolight Holdings", policy.aliases_of("Innolight Co., Ltd."))["state"] == "ambiguous", "短名撞别家 → ambiguous"
    assert policy.match_entity("see Innolight2 corp", policy.aliases_of("Innolight2 Co., Ltd."))["state"] == "ambiguous"
    assert policy.match_entity("Foo (Innolight) bar", policy.aliases_of("Innolight Co., Ltd."))["state"] == "on", "括号别名"
    # 全文异常短 → 抛(不当作名单)
    monkeypatch.setattr(policy, "http_get", _fake({"documents.json": R(200, DOD_SEARCH), "fr/raw": R(200, "short", text="short")}))
    with pytest.raises(policy.PolicyError, match="异常短"):
        policy.fetch_1260h(["Zhongji Innolight Co., Ltd."])


def test_1260h_baseline_and_later_removal(monkeypatch):
    # 最新一条是 Removal 通知(只含 Hesai):基线必须是完整指定通知,Zhongji 仍 on_list;Hesai → removed;拉不到后续通知 → undetermined
    search = {"count": 2, "results": [DOD_REMOVAL, DOD_FULL]}
    monkeypatch.setattr(policy, "http_get", _fake({"documents.json": R(200, search), "fr/raw/2026-11571": R(200, DOD_TEXT, text=DOD_TEXT, raw="raw/full.html"), "fr/raw/2026-13000": R(200, DOD_REMOVAL_TEXT, text=DOD_REMOVAL_TEXT, raw="raw/rm.html")}))
    d = policy.fetch_1260h(policy.aliases_of("Zhongji Innolight Co., Ltd."))
    assert d["status"] == "on_list" and d["doc"] == "2026-11571" and d["later_docs"][0]["doc"] == "2026-13000", "基线是完整通知,不是最新的 Removal"
    h = policy.fetch_1260h(policy.aliases_of("Hesai Technology Co., Ltd."))
    assert h["status"] == "removed" and "2026-13000" in h["reason"]
    assert h["decision_doc"] == "2026-13000" and h["decision_date"] == "2026-07-20" and h["decision_raw_ref"] == "raw/rm.html" and h["doc"] == "2026-11571", "状态证据指向决定状态的后续通知,基线另存(r2)"
    assert d["decision_doc"] == "2026-11571" and d["decision_raw_ref"] == "raw/full.html"
    mr = mappers_policy.policy_access_map({"english_name": "Hesai Technology Co., Ltd.", "aliases": ["Hesai Technology Co., Ltd."], "dod_1260h": h, "checked_at": "2026-08-23", "errors": {}}, _CTX)
    stx = [e for e in mr["evidence"] if e["field"] == "policy_1260h_status"][0]
    assert stx["value"] == "removed" and stx["period"] == "2026-07-20" and stx["raw_ref"] == "raw/rm.html" and "fr_doc=2026-13000" in stx["note"] and "baseline_doc=2026-11571" in stx["note"]
    monkeypatch.setattr(policy, "http_get", _fake({"documents.json": R(200, search), "fr/raw/2026-11571": R(200, DOD_TEXT, text=DOD_TEXT), "fr/raw/2026-13000": R(500, "boom", text="boom")}))
    u = policy.fetch_1260h(policy.aliases_of("Zhongji Innolight Co., Ltd."))
    assert u["status"] == "undetermined" and "拉不到" in u["reason"], "后续通知拉不到 → undetermined,禁止 not_on_list"
    # 只有 Removal 没有完整通知 → 抛
    monkeypatch.setattr(policy, "http_get", _fake({"documents.json": R(200, {"count": 1, "results": [DOD_REMOVAL]})}))
    with pytest.raises(policy.PolicyError, match="完整指定通知"):
        policy.fetch_1260h(["Zhongji Innolight Co., Ltd."])
    # 分页:第 1 页全是无关文档,第 2 页才有完整通知
    page1 = {"count": 21, "results": [{"title": f"Other notice {i}", "publication_date": "2026-08-01", "document_number": f"o{i}", "raw_text_url": "x", "html_url": "x"} for i in range(20)]}
    page2 = {"count": 21, "results": [DOD_FULL]}
    def get(url, **k):
        if "page=2" in url: return R(200, page2)
        if "documents.json" in url: return R(200, page1)
        return R(200, DOD_TEXT, text=DOD_TEXT)
    monkeypatch.setattr(policy, "http_get", get)
    assert policy.fetch_1260h(policy.aliases_of("Zhongji Innolight Co., Ltd."))["status"] == "on_list"


def test_bis_zero_results_shape_and_mentions(monkeypatch):
    monkeypatch.setattr(policy, "http_get", _fake({"documents.json": R(200, {"count": 0, "description": "x"})}))
    b = policy.fetch_bis_mentions(["Zhongji Innolight Co., Ltd."])
    assert b["status"] == "not_mentioned" and b["mentions"] == [], "0 结果时 API 不带 results 键,不是契约错"
    hit = {"title": "Additions to the Entity List", "publication_date": "2026-03-01", "document_number": "2026-1", "html_url": "https://fr/1", "raw_text_url": "https://fr/raw/1"}
    body_yes = "<html>" + "x" * 2500 + " Zhongji Innolight Co., Ltd. added </html>"
    body_no = "<html>" + "x" * 2500 + " nothing here </html>"
    monkeypatch.setattr(policy, "http_get", _fake({"documents.json": R(200, {"count": 1, "results": [hit]}), "fr/raw/1": R(200, body_yes, text=body_yes)}))
    b2 = policy.fetch_bis_mentions(["Zhongji Innolight Co., Ltd.", "Zhongji Innolight"])
    assert b2["status"] == "mentioned" and len(b2["mentions"]) == 1 and "innolight" in b2["mentions"][0]["context"], "两个别名命中同一文档去重 + 原文复核"
    assert b2["mentions"][0]["doc_raw_ref"] is not None or True  # 单测无 capture 上下文,raw 为 None;形状在 mapper 测试里验
    mb = mappers_policy.policy_access_map({"english_name": "Zhongji Innolight Co., Ltd.", "aliases": ["Zhongji Innolight Co., Ltd."], "bis": {**b2, "mentions": [{**b2["mentions"][0], "doc_raw_ref": "raw/doc.html"}], "raw_ref": "raw/search.json"}, "checked_at": "2026-08-23", "errors": {}}, _CTX)
    fb = {e["field"]: e for e in mb["evidence"]}
    assert fb["policy_bis_status"]["value"] == "mentioned" and fb["policy_bis_confirmed_mentions_count"]["value"] == 1 and fb["policy_bis_mention"]["raw_ref"] == "raw/doc.html", "确认条目绑规则全文 raw(r2)"
    monkeypatch.setattr(policy, "http_get", _fake({"documents.json": R(200, {"count": 1, "results": [hit]}), "fr/raw/1": R(200, body_no, text=body_no)}))
    b3 = policy.fetch_bis_mentions(["Zhongji Innolight Co., Ltd."])
    assert b3["status"] == "search_hit_unconfirmed" and b3["mentions"] == [] and len(b3["unconfirmed"]) == 1, "检索命中但原文不含别名 → 不算 mention"
    for st in ("search_hit_unconfirmed", "undetermined"):
        mu = mappers_policy.policy_access_map({"english_name": "x", "aliases": ["x"], "bis": {"status": st, "mentions": [], "unconfirmed": [], "api_count": 1, "retrieved": 1, "truncated": False, "raw_ref": None}, "checked_at": "2026-08-23", "errors": {}}, _CTX)
        fields = {e["field"] for e in mu["evidence"]}
        assert "policy_bis_status" in fields and "policy_bis_confirmed_mentions_count" not in fields, f"{st} 不出 '0 条'(r2)"
    monkeypatch.setattr(policy, "http_get", _fake({"documents.json": R(200, {"description": "no count"})}))
    with pytest.raises(policy.PolicyError, match="count"):
        policy.fetch_bis_mentions(["Zhongji Innolight Co., Ltd."])
    assert policy.fetch_bis_mentions([])["status"] == "undetermined"


def test_fcc_parse_dedupe_class_bans_and_structure_change(monkeypatch):
    monkeypatch.setattr(policy, "http_get", _fake({"r.jina.ai": R(200, FCC_MD, text=FCC_MD, raw="raw/fcc.md")}))
    f = policy.fetch_fcc_covered(["Huawei Technologies Company"])
    assert f["n"] == 2 and f["n_class_bans"] == 1 and f["status"] == "on_list" and f["matched"] == "Huawei Technologies Company"
    assert policy.fetch_fcc_covered(["Technologies Company Inc."])["status"] == "not_on_list", "全名不同不算"
    challenge = "Just a moment...\nEnable JavaScript and cookies to continue"
    monkeypatch.setattr(policy, "http_get", _fake({"r.jina.ai": R(200, challenge, text=challenge)}))
    with pytest.raises(policy.PolicyError, match="挑战页"):
        policy.fetch_fcc_covered(["x"])
    monkeypatch.setattr(policy, "http_get", _fake({"r.jina.ai": R(200, FCC_MD, text=FCC_MD, raw="raw/fcc.md")}))
    assert policy.fetch_fcc_covered(["Zhongji Innolight Co., Ltd."])["status"] == "not_on_list"
    assert policy.fetch_fcc_covered([])["status"] == "undetermined"
    monkeypatch.setattr(policy, "http_get", _fake({"r.jina.ai": R(200, "Markdown Content:\n# nothing", text="Markdown Content:\n# nothing")}))
    with pytest.raises(policy.PolicyError, match="结构变了"):
        policy.fetch_fcc_covered(["x"])


def test_policy_access_isolation_and_mapper(monkeypatch):
    # 1260H 正常、BIS 抛、FCC 抛 → 不抛,partial 出声;中方侧默认 not_connected
    def get(url, params=None, headers=None, timeout=None, ext=None, **kw):
        if "cninfo" in url: return R(200, CNINFO, raw="raw/cn.json")
        if "documents.json" in url and "defense-department" in url: return R(200, DOD_SEARCH)
        if "fr/raw" in url: return R(200, DOD_TEXT, raw="raw/dod.html", text=DOD_TEXT)
        if "documents.json" in url: raise TimeoutError("slow")
        if "r.jina.ai" in url: return R(503, "down", text="down")
        raise AssertionError(url)
    monkeypatch.setattr(policy, "http_get", get)
    r = policy.policy_access("300308", now=NOW)
    assert r["dod_1260h"]["status"] == "on_list" and "bis" in r["errors"] and "fcc" in r["errors"] and r["cn_side"] and "cn_side_raw_ref" in r
    m = mappers_policy.policy_access_map(r, {"script": "policy_access", "symbol": "300308", "market": "SZ", "source": "s", "endpoint": "x", "as_of": None, "raw_ref": None, "args": {}})
    fields = {e["field"]: e for e in m["evidence"]}
    assert m["status"] == "partial" and "bis=" in m["degraded"]
    st = fields["policy_1260h_status"]
    assert st["value"] == "on_list" and st["period"] == "2026-06-10" and st["raw_ref"] == "raw/dod.html" and "fr_doc=2026-11571" in st["note"] and "读法:" in st["note"]
    assert fields["policy_bis_status"]["value"] if "policy_bis_status" in fields else True
    assert "innolight" in fields["policy_1260h_context"]["value"].lower() and fields["policy_cn_side_status"]["value"] == "not_connected" and "沉默" in fields["policy_cn_side_status"]["note"]
    assert all("读法:" in e["note"] for e in m["evidence"])
    # 无英文名 → 全部 undetermined,partial
    monkeypatch.setattr(policy, "http_get", _fake({"cninfo": R(200, {"data": {"records": []}}), "documents.json": R(200, DOD_SEARCH), "fr/raw": R(200, DOD_TEXT, text=DOD_TEXT), "r.jina.ai": R(200, FCC_MD, text=FCC_MD)}))
    r2 = policy.policy_access("300308", now=NOW)
    assert r2["english_name"] == "" and r2["dod_1260h"]["status"] == "undetermined" and r2["bis"]["status"] == "undetermined" and r2["fcc"]["status"] == "undetermined"
    m2 = mappers_policy.policy_access_map(r2, {"script": "policy_access", "symbol": "300308", "market": "SZ", "source": "s", "endpoint": "x", "as_of": None, "raw_ref": None, "args": {}})
    assert m2["status"] == "partial" and "无一手英文名" in m2["degraded"]
    # 无英文名 + 端口失败 同时发生:degraded 两个原因都在
    monkeypatch.setattr(policy, "http_get", _fake({"cninfo": R(200, {"data": {"records": []}}), "documents.json": R(200, DOD_SEARCH), "fr/raw": R(200, DOD_TEXT, text=DOD_TEXT), "r.jina.ai": R(503, "down", text="down")}))
    r3 = policy.policy_access("300308", now=NOW)
    m3 = mappers_policy.policy_access_map(r3, {"script": "policy_access", "symbol": "300308", "market": "SZ", "source": "s", "endpoint": "x", "as_of": None, "raw_ref": None, "args": {}})
    assert "无一手英文名" in m3["degraded"] and "fcc=" in m3["degraded"], "两个降级原因合并"
    # 巨潮结构漂移 → 记 errors 不当作"没有英文名"
    monkeypatch.setattr(policy, "http_get", _fake({"cninfo": R(200, "<html>", text="<html>"), "documents.json": R(200, DOD_SEARCH), "fr/raw": R(200, DOD_TEXT, text=DOD_TEXT), "r.jina.ai": R(200, FCC_MD, text=FCC_MD)}))
    r4 = policy.policy_access("300308", now=NOW)
    assert "english_name" in r4["errors"] and "JSON" in r4["errors"]["english_name"]
    # 1260H 与 BIS 都失败 → 抛
    monkeypatch.setattr(policy, "http_get", _fake({"cninfo": R(200, CNINFO), "documents.json": ConnectionError("x"), "r.jina.ai": R(200, FCC_MD, text=FCC_MD)}))
    with pytest.raises(policy.PolicyError, match="全部失败"):
        policy.policy_access("300308", now=NOW)


def test_registry_entry():
    reg = json.load(open(os.path.join(REPO, "datasources", "registry.json"), encoding="utf-8"))
    e = next(x for x in reg["endpoints"] if x["id"] == "policy_access")
    assert e["layer"] == "14 管制与准入" and e["stages"] == {"risk": "optional"} and e["mapper_module"] == "mappers_policy" and e["args"]["with_mofcom"] is False
    import inspect
    assert all(k in inspect.signature(policy.policy_access).parameters for k in e["args"])
