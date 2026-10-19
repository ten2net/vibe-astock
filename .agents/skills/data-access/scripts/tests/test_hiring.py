"""招聘信号(第 17 层)离线测试:锚点读取 / 两种 ATS 解析 / 角色桶 / 逐家隔离 / 契约错误 / 未接入≠零岗位。不访问网络。"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
sys.path.insert(0, SCRIPTS)
from sources import hiring, mappers_hiring  # noqa: E402

NOW = datetime(2026, 8, 24, tzinfo=timezone.utc)
CTX = {"script": "hiring_anchor_signal", "symbol": "300308", "market": "SZ", "source": "ats", "endpoint": "x", "as_of": None, "raw_ref": None, "args": {}}


def test_anchors_from_tag_table(tmp_path):
    """锚点来自 industry_tags.json;没有 out_dir / 没有 _industry.json / 标签没配 都要出声,且不是"零岗位"。"""
    _, tags, warns, _sk = hiring.active_anchors(None)
    assert tags == [] and any("out_dir" in w for w in warns)
    (tmp_path / "fetch").mkdir()
    _, _, w2, _sk2 = hiring.active_anchors(str(tmp_path))
    assert any("_industry.json" in w for w in w2)
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": ["ai_compute"]}), encoding="utf-8")
    anchors, tags, warns, _sk3 = hiring.active_anchors(str(tmp_path))
    assert tags == ["ai_compute"] and len(anchors) >= 4
    assert all(a.get("ats") in ("greenhouse", "ashby") and a.get("slug") and a.get("name") for a in anchors)
    # 未配置锚点的标签:出声"未接入",不是零岗位
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": ["storage_memory"]}), encoding="utf-8")
    a2, _, w3, _sk4 = hiring.active_anchors(str(tmp_path))
    assert a2 == [] and any("未接入" in w for w in w3)


def test_title_parsing_and_buckets():
    gh = {"jobs": [{"title": "Senior Optical Engineer"}, {"title": "Manufacturing Process Engineer"}, {"title": "Recruiter"}]}
    ab = {"jobs": [{"title": "Silicon Photonics Lead"}, {"title": "Data Center Infrastructure Engineer"}]}
    assert hiring._titles("greenhouse", gh) == ["Senior Optical Engineer", "Manufacturing Process Engineer", "Recruiter"]
    assert len(hiring._titles("ashby", ab)) == 2
    b = hiring._bucket(hiring._titles("greenhouse", gh))
    # 桶按**岗位**计数:"Manufacturing Process Engineer" 同时命中 manufacturing 与 process engineer,只算 1 个岗位
    # 桶键是 ASCII 短码(record_key 要能过温度计历史序列的形状约束);桶名只说"标题命中了什么词"
    assert b["optical"] == 1 and b["mfg"] == 1 and b["infra"] == 0
    b2 = hiring._bucket(hiring._titles("ashby", ab))
    assert b2["optical"] == 1 and b2["infra"] == 1
    assert all(k.isascii() and len(k) <= 12 for k in hiring.ROLE_BUCKETS), "桶键必须是 ASCII 短码"
    assert "量产" not in " ".join(v["label"] for v in hiring.ROLE_BUCKETS.values()), "桶名不得断言量产(标题词支撑不了)"
    # 结构变了 = 抛,不当"零岗位"
    for bad in ({}, {"jobs": None}, {"data": []}):
        with pytest.raises(hiring.HiringError):
            hiring._titles("greenhouse", bad)
    with pytest.raises(hiring.HiringError):
        hiring._titles("workday", {"jobs": []})


def test_isolation_and_mapper(monkeypatch, tmp_path):
    (tmp_path / "fetch").mkdir()
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": ["ai_compute"]}), encoding="utf-8")

    def fake_get(url, timeout=20):
        if "lightmatter" in url:
            return json.dumps({"jobs": [{"title": "Optical Engineer"}, {"title": "Manufacturing Engineer"}, {"title": "Recruiter"}]}).encode()
        raise RuntimeError("board down")

    monkeypatch.setattr(hiring, "_get", fake_get)
    monkeypatch.setattr(hiring, "record_raw", lambda *a, **k: "raw/gh.json")
    r = hiring.hiring_anchor_signal(out_dir=str(tmp_path), now=NOW)
    assert [i["slug"] for i in r["items"]] == ["lightmatter"] and len(r["errors"]) >= 4
    m = mappers_hiring.hiring_anchor_signal_map(r, CTX)
    tot = [e for e in m["evidence"] if e["field"] == "hiring_open_roles"][0]
    assert tot["value"] == 3 and tot["symbol"] == "MARKET" and tot["record_key"] == "greenhouse:lightmatter"
    assert "招聘意图不是产能" in tot["note"] and "锚点公司" in tot["note"]
    buckets = {e["record_key"]: e["value"] for e in m["evidence"] if e["field"] == "hiring_role_bucket"}
    assert buckets["greenhouse:lightmatter:optical"] == 1 and buckets["greenhouse:lightmatter:mfg"] == 1
    assert "greenhouse:lightmatter:infra" not in buckets, "零桶不落证据"
    import re as _re
    assert all(_re.match(r"^[A-Za-z0-9:._x-]{1,32}$", k) for k in buckets), "桶 record_key 要能过历史序列形状约束"
    assert "锚点覆盖 1/6" in tot["note"] and "缺:" in tot["note"], "覆盖率与缺失锚点要写进证据"
    assert m["extra"]["anchors_expected"] == 6 and m["extra"]["anchors_ok"] == 1 and len(m["extra"]["anchors_failed"]) == 5
    assert m["status"] == "partial" and "锚点覆盖" in m["degraded"]
    # 全失败 → 抛
    monkeypatch.setattr(hiring, "_get", lambda url, timeout=20: (_ for _ in ()).throw(RuntimeError("all down")))
    with pytest.raises(hiring.HiringError):
        hiring.hiring_anchor_signal(out_dir=str(tmp_path), now=NOW)


def test_no_anchors_is_not_zero_jobs(tmp_path):
    """标签未配锚点 → 没有条目,但必须 partial + degraded 写明"未接入 ≠ 零岗位"(不能让 agent 读成"没人在招")。"""
    (tmp_path / "fetch").mkdir()
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": ["storage_memory"]}), encoding="utf-8")
    r = hiring.hiring_anchor_signal(out_dir=str(tmp_path), now=NOW)
    assert r["items"] == [] and r["errors"] == []
    m = mappers_hiring.hiring_anchor_signal_map(r, CTX)
    assert m["evidence"] == [] and m["status"] == "partial"
    assert "未接入" in m["degraded"] and "零岗位" in m["degraded"]


def test_registry_wiring():
    repo = os.path.normpath(os.path.join(SCRIPTS, "..", "..", "..", ".."))
    reg = json.load(open(os.path.join(repo, "datasources", "registry.json"), encoding="utf-8"))
    ep = {e["id"]: e for e in reg["endpoints"]}["hiring_anchor_signal"]
    assert ep["layer"] == "17 招聘信号" and ep["stages"] == {"risk": "optional"} and ep["pass_out_dir"] is True
    assert ep["history_fields"] == ["hiring_open_roles"], "岗位数要进温度计历史序列才能看变化"
    assert set(ep["industry_tags"]) == {"ai_compute", "storage_memory"}


def test_raw_recorded_before_parse(monkeypatch, tmp_path):
    """结构变化时最需要复核的就是那份响应 → 必须**先落盘再解析**(Codex hiring-r2)。"""
    (tmp_path / "fetch").mkdir()
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": ["ai_compute"]}), encoding="utf-8")
    recorded = []
    monkeypatch.setattr(hiring, "record_raw", lambda body, *a, **k: (recorded.append(body), "raw/x.json")[1])
    monkeypatch.setattr(hiring, "_get", lambda url, timeout=20: b'{"positions": []}')
    with pytest.raises(hiring.HiringError):          # 结构变了 → 全失败才抛
        hiring.hiring_anchor_signal(out_dir=str(tmp_path), now=NOW)
    assert recorded, "解析失败也要留下原始响应,否则复核不了结构变更"


def test_zero_jobs_is_unverified(monkeypatch, tmp_path):
    """200 但零岗位:分不清「真没在招」与「slug 废弃」→ 标 unverified 并降 partial,不得读成招聘冻结。"""
    (tmp_path / "fetch").mkdir()
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": ["ai_compute"]}), encoding="utf-8")
    monkeypatch.setattr(hiring, "record_raw", lambda *a, **k: "raw/x.json")
    monkeypatch.setattr(hiring, "_get", lambda url, timeout=20: b'{"jobs": []}')
    r = hiring.hiring_anchor_signal(out_dir=str(tmp_path), now=NOW)
    assert all(i["zero_unverified"] for i in r["items"]) and r["anchors_ok"] == r["anchors_expected"]
    m = mappers_hiring.hiring_anchor_signal_map(r, CTX)
    note = [e for e in m["evidence"] if e["field"] == "hiring_open_roles"][0]["note"]
    assert "未经核实的零值" in note and "招聘冻结" in note
    assert m["status"] == "partial" and "不得读成招聘冻结" in m["degraded"]


def test_anchor_dedup_aggregates_tags(tmp_path, monkeypatch):
    """同一锚点被多个标签引用 → 聚合 tags,不只留第一个(Codex hiring-r2);未知 ATS 直接跳过不猜 URL。"""
    (tmp_path / "fetch").mkdir()
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": ["t1", "t2"]}), encoding="utf-8")
    ds = tmp_path / "datasources"; ds.mkdir()
    (ds / "industry_tags.json").write_text(json.dumps({"tags": {
        "t1": {"hiring_anchors": [{"name": "X", "ats": "greenhouse", "slug": "x"}]},
        "t2": {"hiring_anchors": [{"name": "X", "ats": "greenhouse", "slug": "x"},
                                  {"name": "W", "ats": "workday", "slug": "w"}]}}}), encoding="utf-8")
    monkeypatch.setattr(hiring, "_repo_root", lambda: str(tmp_path))
    anchors, tags, warns, skipped = hiring.active_anchors(str(tmp_path))
    assert len(anchors) == 1 and anchors[0]["tags"] == ["t1", "t2"]
    assert any("白名单" in w for w in warns), "未知 ATS 要出声并跳过,不能拿 Ashby URL 去试"
    assert skipped == ["workday:w"], "跳过的锚点要计入'应有但没拿到',否则覆盖率会显示 1/1 掩盖配置缺失"


def test_raw_saved_even_when_json_is_broken(monkeypatch, tmp_path):
    """JSON 本身坏掉时,那份响应正是最该留证的 —— `_get` 不许在落盘前解析(Codex hiring-r3)。"""
    (tmp_path / "fetch").mkdir()
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": ["ai_compute"]}), encoding="utf-8")
    recorded = []
    monkeypatch.setattr(hiring, "record_raw", lambda body, *a, **k: (recorded.append(body), "raw/x.json")[1])
    monkeypatch.setattr(hiring, "_get", lambda url, timeout=20: b'{"jobs":')   # 截断的 JSON
    with pytest.raises(hiring.HiringError):
        hiring.hiring_anchor_signal(out_dir=str(tmp_path), now=NOW)
    assert recorded and recorded[0] == b'{"jobs":', "坏 JSON 也必须先落盘"


def test_record_key_length_guard():
    assert hiring.record_key_for("greenhouse", "lightmatter") == "greenhouse:lightmatter"
    long_key = hiring.record_key_for("greenhouse", "company-international-careers-board")
    assert len(long_key) <= hiring.RECORD_KEY_MAX and long_key.startswith("greenhouse:")
    import re as _re
    assert _re.match(r"^[A-Za-z0-9:._x-]{1,32}$", long_key), "超长 slug 也要能进历史序列"


def test_record_key_reserves_room_for_bucket():
    """基础键要给桶后缀预留空间:只保基础键不超限,追加 ':optical' 照样越界(Codex hiring-r4)。"""
    import re as _re
    for slug in ("lightmatter", "abcdefghijklmnopqr", "company-international-careers-board"):
        for bucket in ("", "mfg", "optical", "infra"):
            k = hiring.record_key_for("greenhouse", slug, bucket)
            assert len(k) <= hiring.RECORD_KEY_MAX, (slug, bucket, k, len(k))
            assert _re.match(r"^[A-Za-z0-9:._x-]{1,32}$", k), k
    # 同一 slug 稳定可复现(历史序列要按 record_key 跨运行比)
    assert hiring.record_key_for("greenhouse", "abcdefghijklmnopqr", "optical") == hiring.record_key_for("greenhouse", "abcdefghijklmnopqr", "optical")


def test_no_tags_is_partial_not_failed(tmp_path):
    """产业门控没命中任何标签是**真实状态**,不是数据源故障 → partial(Codex hiring-r5)。"""
    (tmp_path / "fetch").mkdir()
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": []}), encoding="utf-8")
    r = hiring.hiring_anchor_signal(out_dir=str(tmp_path), now=NOW)
    assert r["items"] == [] and r["warnings"] == []
    m = mappers_hiring.hiring_anchor_signal_map(r, CTX)
    assert m["status"] == "partial" and "未接入" in m["degraded"]
