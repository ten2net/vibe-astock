"""海外头条(第 16 层)离线测试:river 解析 / 时区换算 / 窗口裁剪 / 关键词标注 / RSS 兜底出声 / mapper 口径。不访问网络。"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
sys.path.insert(0, SCRIPTS)
from sources import headlines, mappers_headlines  # noqa: E402

BJ = ZoneInfo("Asia/Shanghai")
# NOW 取 08-25 早上:夹具里的美东上午条目换算成北京当晚,才是真实时间线(旧夹具 NOW=12:00 却收 20:45 的条 = Codex 指出的未来条目洞)
NOW = datetime(2026, 8, 25, 9, 0, tzinfo=BJ)
CTX = {"script": "techmeme_headlines", "symbol": "300308", "market": "SZ", "source": "techmeme", "endpoint": "river", "as_of": None, "raw_ref": None, "args": {}}


def row(hhmm: str, ap: str, yymmdd: str, cite: str, url: str, title: str) -> str:
    hh, mm = hhmm.split(":")
    return (f'<tr class="ritem"><td> {hh}:{mm} {ap}M</td><td pml="{yymmdd}p1">'
            f'<cite>{cite}:</cite> <a href="{url}">{title}</a></td></tr>')


def test_river_parse_timezone_and_filters():
    html = "".join([
        row("10:05", "P", "260823", "NYT", "https://a.com/1", "Nvidia and OpenAI expand data center buildout across three states"),
        row("8:45", "A", "260824", "Bloomberg", "https://b.com/2", "Shein will debut on the Hong Kong exchange seeking up to $1.8B in its IPO"),
        row("12:30", "A", "260824", "Verge", "https://c.com/3", "短"),                       # 标题太短 → 丢
        row("11:00", "A", "260824", "Dup", "https://a.com/1", "Duplicate url should be dropped from the river listing"),  # 重复 url → 丢
        '<tr class="ritem"><td>no time</td><td><a href="https://d.com/4">no timestamp row</a></td></tr>',                  # 无时间戳 → 丢
    ])
    items, drops = headlines._parse_river(html)
    assert [i["url"] for i in items] == ["https://a.com/1", "https://b.com/2"]
    # 每一类丢弃都要计数(静默丢一半是本层最危险的失败模式 —— Codex headlines-r1)
    assert drops["short_title"] == 1 and drops["duplicate"] == 1 and drops["bad_time"] == 1 and drops["candidate_rows"] == 5
    # 美东 10:05 PM 08-23 → 北京 08-24 10:05(夏令时 +12)
    assert items[0]["published"] == "2026-08-24T10:05:00+08:00"
    assert items[0]["source"] == "NYT"
    # 美东 8:45 AM 08-24 → 北京 08-24 20:45
    assert items[1]["published"] == "2026-08-24T20:45:00+08:00"


def test_window_and_keywords(monkeypatch, tmp_path):
    html = "".join([
        row("10:05", "P", "260823", "NYT", "https://a.com/1", "Nvidia and OpenAI expand data center buildout across three states"),
        row("9:00", "A", "260820", "Old", "https://old.com/9", "An old headline well outside the forty eight hour window"),
        row("7:00", "A", "260824", "WSJ", "https://w.com/5", "Consumer gadget review roundup for late summer shopping season"),
    ])
    monkeypatch.setattr(headlines, "http_text", lambda *a, **k: html)
    monkeypatch.setattr(headlines, "last_raw_ref", lambda: "raw/tm.json")
    (tmp_path / "fetch").mkdir()
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": ["ai_compute"]}), encoding="utf-8")
    r = headlines.techmeme_headlines(window_hours=48, out_dir=str(tmp_path), now=NOW)
    assert r["source_used"] == "river" and r["fetched_total"] == 3 and r["in_window"] == 2, "窗口外的旧头条被裁掉"
    by = {i["url"]: i for i in r["items"]}
    assert by["https://a.com/1"]["relevant"] is True and "Nvidia" in by["https://a.com/1"]["matched"]
    assert by["https://w.com/5"]["relevant"] is False and by["https://w.com/5"]["matched"] == []
    assert r["scored"] and r["tags"] == ["ai_compute"] and r["keywords"]["strong"]
    # mapper:计数 + 逐条证据 + 护栏 + 脱敏标记
    m = mappers_headlines.techmeme_headlines_map(r, CTX)
    fields = [e["field"] for e in m["evidence"]]
    assert fields[0] == "headline_count" and "headline_relevant_count" in fields and fields.count("headline_item") == 2
    cnt = m["evidence"][0]
    assert cnt["value"] == 2 and "线索不是事实" in cnt["note"]
    item = [e for e in m["evidence"] if e["field"] == "headline_item" and "Nvidia" in e["value"]][0]
    assert "relevance=命中:Nvidia" in item["note"] and "untrusted_text=sanitized" in item["note"] and "link=" in item["note"]
    assert item["period"] == "2026-08-24" and "period_basis=published" in item["note"]
    assert m["status"] == "ok"


def test_no_keywords_is_unscored_not_irrelevant(monkeypatch, tmp_path):
    """没有产业关键词时:relevant=None(未标注),不是 False —— 绝不退回"全都相关"也不谎称"都不相关"。"""
    html = row("10:05", "P", "260823", "NYT", "https://a.com/1", "Nvidia and OpenAI expand data center buildout across three states")
    monkeypatch.setattr(headlines, "http_text", lambda *a, **k: html)
    monkeypatch.setattr(headlines, "last_raw_ref", lambda: "raw/tm.json")
    (tmp_path / "fetch").mkdir()
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": []}), encoding="utf-8")
    r = headlines.techmeme_headlines(out_dir=str(tmp_path), now=NOW)
    assert r["scored"] is False and r["items"][0]["relevant"] is None
    m = mappers_headlines.techmeme_headlines_map(r, CTX)
    assert "headline_relevant_count" not in [e["field"] for e in m["evidence"]], "没关键词就不出相关计数"
    assert m["status"] == "partial" and "unscored" in m["degraded"], "未标注要降级出声,不能装作 ok"
    assert "relevance=未标注" in [e for e in m["evidence"] if e["field"] == "headline_item"][0]["note"]
    # 没有 _industry.json → 出声而不是静默
    r2 = headlines.techmeme_headlines(out_dir=str(tmp_path / "nope"), now=NOW)
    assert any("_industry.json" in w for w in r2["warnings"]) and r2["scored"] is False


def test_rss_fallback_is_loud(monkeypatch, tmp_path):
    calls = {"n": 0}
    rss = ('<rss><channel><item><title>Nvidia ships new accelerator racks to cloud customers</title>'
           '<link>https://r.com/1</link><pubDate>Sun, 24 Aug 2026 02:05:00 GMT</pubDate></item></channel></rss>')

    def fake_text(url, **k):
        calls["n"] += 1
        if "river" in url:
            raise RuntimeError("river 502")
        return rss

    monkeypatch.setattr(headlines, "http_text", fake_text)
    monkeypatch.setattr(headlines, "last_raw_ref", lambda: "raw/rss.xml")
    (tmp_path / "fetch").mkdir()
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": ["ai_compute"]}), encoding="utf-8")
    r = headlines.techmeme_headlines(out_dir=str(tmp_path), now=NOW)
    assert r["source_used"] == "rss" and r["degraded"] and "回退 RSS" in r["degraded"]
    assert r["items"][0]["published"] == "2026-08-24T10:05:00+08:00"   # GMT 02:05 → 北京 10:05
    m = mappers_headlines.techmeme_headlines_map(r, CTX)
    assert m["status"] == "partial" and "回退 RSS" in m["degraded"]
    # river 解析 0 条也算失败 → 走回退
    monkeypatch.setattr(headlines, "http_text", lambda url, **k: "<html>no rows</html>" if "river" in url else rss)
    r2 = headlines.techmeme_headlines(out_dir=str(tmp_path), now=NOW)
    assert r2["source_used"] == "rss" and any("解析出 0 条" in w for w in r2["warnings"])


def test_both_entries_broken_raises(monkeypatch, tmp_path):
    monkeypatch.setattr(headlines, "http_text", lambda url, **k: "<html/>" if "river" in url else "<rss><channel></channel></rss>")
    monkeypatch.setattr(headlines, "last_raw_ref", lambda: None)
    with pytest.raises(headlines.HeadlineError):
        headlines.techmeme_headlines(out_dir=str(tmp_path), now=NOW)


def test_empty_window_is_partial_not_failure(monkeypatch, tmp_path):
    html = row("9:00", "A", "260810", "Old", "https://old.com/9", "An old headline far outside the forty eight hour window")
    monkeypatch.setattr(headlines, "http_text", lambda *a, **k: html)
    monkeypatch.setattr(headlines, "last_raw_ref", lambda: "raw/tm.json")
    (tmp_path / "fetch").mkdir()
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": ["ai_compute"]}), encoding="utf-8")
    r = headlines.techmeme_headlines(out_dir=str(tmp_path), now=NOW)
    m = mappers_headlines.techmeme_headlines_map(r, CTX)
    assert r["in_window"] == 0 and m["status"] == "partial" and "零条" in m["degraded"]
    assert m["evidence"][0]["value"] == 0, "零条也要落计数证据(说明确实查过)"


def test_parse_variants_and_acceptance_rate(monkeypatch, tmp_path):
    """DOM 变体(多 class / 属性换序 / cite 带属性 / a 的 href 非首属性)必须照样解析(Codex headlines-r1)。"""
    html = ('<tr data-x="1" class="foo ritem bar"><td class="t"> 9:15 AM</td>'
            '<td pml="260824p7"><cite class="src">Reuters:</cite> '
            '<a class="story" data-k="1" href="https://v.com/1">Nvidia expands its data center accelerator lineup</a></td></tr>')
    items, drops = headlines._parse_river(html)
    assert len(items) == 1 and items[0]["source"] == "Reuters" and items[0]["url"] == "https://v.com/1"
    # 接受率异常 → 出声(标准行仍在也要报,否则结构部分变化会静默丢一半)
    good = row("9:00", "A", "260824", "OK", "https://g.com/1", "A perfectly good headline that parses fine here")
    bad = '<tr class="ritem"><td>garbled</td><td>no anchor</td></tr>' * 4
    monkeypatch.setattr(headlines, "http_text", lambda *a, **k: good + bad)
    monkeypatch.setattr(headlines, "last_raw_ref", lambda: "raw/x.html")
    (tmp_path / "fetch").mkdir()
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": ["ai_compute"]}), encoding="utf-8")
    r = headlines.techmeme_headlines(out_dir=str(tmp_path), now=NOW)
    assert any("接受率" in w for w in r["warnings"]), r["warnings"]


def test_future_items_dropped(monkeypatch, tmp_path):
    """窗口要有上界:超出当前时刻 + 允许偏差的条目是错时 / 伪造,丢弃并出声(Codex headlines-r1)。"""
    html = (row("9:00", "A", "260824", "OK", "https://g.com/1", "A normal headline inside the window right now")
            + row("11:00", "P", "260825", "Future", "https://f.com/2", "A headline dated tomorrow evening which cannot exist yet"))
    monkeypatch.setattr(headlines, "http_text", lambda *a, **k: html)
    monkeypatch.setattr(headlines, "last_raw_ref", lambda: "raw/x.html")
    (tmp_path / "fetch").mkdir()
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": ["ai_compute"]}), encoding="utf-8")
    r = headlines.techmeme_headlines(out_dir=str(tmp_path), now=NOW)
    assert [i["url"] for i in r["items"]] == ["https://g.com/1"]
    assert any("超出当前时刻" in w for w in r["warnings"])


def test_keyword_precision_context_needs_anchor():
    """泛词单独不算(只作候选);跨标签配对也不算(Codex headlines-r1 / r2)。"""
    import json as _j, os as _o
    table = _j.load(open(_o.path.join(headlines._repo_root(), "datasources", "industry_tags.json"), encoding="utf-8"))["tags"]["ai_compute"]
    k = {"groups": [{"tag": "ai_compute", "strong": table["headline_keywords"],
                     "context": table["headline_context_keywords"], "anchor": table["headline_anchor_keywords"]}]}
    hit, cand = headlines._match("Startup accelerator expands its networking program", k)
    assert hit == [] and cand, "泛词无锚词 → 不算命中,但要留成候选(不能无声消失)"
    assert headlines._match("OpenAI changes ChatGPT privacy settings for teens", k)[0] == []
    assert headlines._match("Nvidia expands data center lineup", k)[0], "强词单独即命中"
    assert headlines._match("OpenAI signs a multibillion dollar compute deal for new chips", k)[0], "泛词 + 锚词 → 命中"
    # 跨标签不许配对:A 的泛词 + B 的锚词 ≠ 命中
    cross = {"groups": [{"tag": "A", "strong": [], "context": ["networking"], "anchor": ["GPU"]},
                        {"tag": "B", "strong": [], "context": [], "anchor": ["model"]}]}
    assert headlines._match("Startup accelerator expands its networking model", cross)[0] == [], "跨标签配对必须无效"
    assert headlines._match("Networking gear for a GPU cluster", cross)[0], "同标签内共现才算"


def test_scored_requires_usable_combination(monkeypatch, tmp_path):
    """只配泛词不配锚词 = 永远零命中,那不叫"已标注"(Codex headlines-r2)。"""
    (tmp_path / "fetch").mkdir()
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": ["only_ctx"]}), encoding="utf-8")
    table = {"tags": {"only_ctx": {"headline_context_keywords": ["OpenAI"]}}}
    tf = tmp_path / "datasources"
    tf.mkdir()
    (tf / "industry_tags.json").write_text(json.dumps(table), encoding="utf-8")
    monkeypatch.setattr(headlines, "_repo_root", lambda: str(tmp_path))
    kws, tags, warns, scored = headlines.active_keywords(str(tmp_path))
    assert scored is False and any("没有锚词" in w for w in warns) and any("配置漂移" in w for w in warns)


def test_missing_cite_row_is_dropped_not_guessed():
    """缺 cite 时按长度猜标题会选到"Read discussion…"这类链接 → 直接丢并计数(Codex headlines-r2)。"""
    html = ('<tr class="ritem"><td> 9:15 AM</td><td pml="260824p7">'
            '<a href="https://n.com/1">AMD launches MI500</a> '
            '<a href="https://techmeme.com/x">Read discussion and commentary from Techmeme readers</a></td></tr>')
    items, drops = headlines._parse_river(html)
    assert items == [] and drops["no_cite"] == 1


def test_low_accept_rate_forces_partial(monkeypatch, tmp_path):
    """接受率低 = 结构部分变化,严重缺数不能以 ok 流向下游(Codex headlines-r2)。"""
    good = row("9:00", "A", "260824", "OK", "https://g.com/1", "A perfectly good headline that parses fine here")
    bad = '<tr class="ritem"><td>garbled</td><td>no anchor</td></tr>' * 4
    monkeypatch.setattr(headlines, "http_text", lambda *a, **k: good + bad)
    monkeypatch.setattr(headlines, "last_raw_ref", lambda: "raw/x.html")
    (tmp_path / "fetch").mkdir()
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": ["ai_compute"]}), encoding="utf-8")
    r = headlines.techmeme_headlines(out_dir=str(tmp_path), now=NOW)
    assert r["accept_rate"] == 0.2
    m = mappers_headlines.techmeme_headlines_map(r, CTX)
    assert m["status"] == "partial" and "接受率" in m["degraded"]


def test_rss_without_timezone_is_dropped(monkeypatch, tmp_path):
    """无时区的 pubDate 会被按本机时区静默解释 → 一律当无时间戳(Codex headlines-r1)。"""
    rss = ('<rss><channel><item><title>Nvidia ships new accelerator racks to cloud customers</title>'
           '<link>https://r.com/1</link><pubDate>Sun, 24 Aug 2026 02:05:00</pubDate></item></channel></rss>')
    monkeypatch.setattr(headlines, "http_text", lambda url, **k: (_ for _ in ()).throw(RuntimeError("river down")) if "river" in url else rss)
    monkeypatch.setattr(headlines, "last_raw_ref", lambda: "raw/rss.xml")
    (tmp_path / "fetch").mkdir()
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": ["ai_compute"]}), encoding="utf-8")
    r = headlines.techmeme_headlines(out_dir=str(tmp_path), now=NOW)
    assert r["in_window"] == 0 and any("无时区" in w or "无时间戳" in w for w in r["warnings"])


def test_hits_survive_evidence_cap(monkeypatch, tmp_path):
    """证据上限截断必须**命中优先**,相关计数按完整窗口算(Codex headlines-r1:最旧那条命中被截会错报为 0)。"""
    rows = [row("9:00", "A", "260824", f"S{i}", f"https://x.com/{i}", f"Consumer gadget review number {i} for late summer shopping") for i in range(70)]
    rows.append(row("8:00", "A", "260823", "Late", "https://hit.com/1", "Nvidia expands data center accelerator supply to cloud partners"))
    monkeypatch.setattr(headlines, "http_text", lambda *a, **k: "".join(rows))
    monkeypatch.setattr(headlines, "last_raw_ref", lambda: "raw/x.html")
    (tmp_path / "fetch").mkdir()
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": ["ai_compute"]}), encoding="utf-8")
    r = headlines.techmeme_headlines(out_dir=str(tmp_path), now=NOW)
    m = mappers_headlines.techmeme_headlines_map(r, CTX)
    kept_urls = [e["note"] for e in m["evidence"] if e["field"] == "headline_item"]
    assert any("hit.com" in n for n in kept_urls), "命中条目不能被截断丢掉"
    rel = [e for e in m["evidence"] if e["field"] == "headline_relevant_count"][0]
    assert rel["value"] == 1, "相关计数按完整窗口口径"
    assert "截断" in ";".join(m["extra"]["warnings"])


def test_context_only_candidates_survive_cap(monkeypatch, tmp_path):
    """截断顺序 = 命中 > 候选 > 普通未命中;候选被截也要 partial 出声(Codex headlines-r3)。"""
    rows = [row("9:00", "A", "260824", f"S{i}", f"https://x.com/{i}", f"Consumer gadget review number {i} for late summer shopping") for i in range(61)]
    rows.append(row("8:00", "A", "260823", "Cand", "https://cand.com/1", "OpenAI expands its consumer subscription tiers worldwide"))
    monkeypatch.setattr(headlines, "http_text", lambda *a, **k: "".join(rows))
    monkeypatch.setattr(headlines, "last_raw_ref", lambda: "raw/x.html")
    (tmp_path / "fetch").mkdir()
    (tmp_path / "fetch" / "_industry.json").write_text(json.dumps({"tags": ["ai_compute"]}), encoding="utf-8")
    r = headlines.techmeme_headlines(out_dir=str(tmp_path), now=NOW)
    assert r["context_only_total"] == 1, "OpenAI 无锚词 → 候选"
    m = mappers_headlines.techmeme_headlines_map(r, CTX)
    notes = [e["note"] for e in m["evidence"] if e["field"] == "headline_item"]
    assert any("relevance=候选" in n for n in notes), "候选必须留在证据里,不能被普通未命中挤掉"
    assert m["extra"]["context_only_dropped"] == 0
