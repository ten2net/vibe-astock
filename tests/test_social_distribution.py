"""社媒自动分发（§7/§10）离线单测：跳页/UTM、竖图二维码、caption 合规、
台账幂等、dry-run 零 API、失败不阻断、发布钩子。全离线、不打真实平台 API。
"""
import json
from pathlib import Path

import pytest

from review_agent import blog_publish as bp, emotion_card as ec
from review_agent import social_links as sl, social_publish as sp

pytestmark = pytest.mark.unit

DATE = "2026-11-06"


def payload(**over):
    base = {
        "focus": {"emotion_phase": "退潮",
                  "market_oneliner": "情绪档位判为退潮。"},
        "focus_md": "情绪档位退潮，涨停池收缩，宽度偏弱。",
        "macro_sector": "", "analysts": [], "reflection": None,
        "emotion_metrics": {
            "promotion": {"available": True, "limit_up_count": 32,
                          "overall": {"base": 84, "promoted": 11, "rate": 0.131}},
        },
        "market_facts": {"seal_quality": {"available": True, "total": 32,
                                          "broken_rate": 0.304}},
    }
    base.update(over)
    return base


# ---------------------------------------------------------------- 跳页 / UTM

def test_post_and_go_urls():
    assert sl.post_url(DATE) == (
        "https://ten2net.github.io/post/2026-11-06-%E6%AF%8F%E6%97%A5%E5%A4%8D%E7%9B%98/")
    assert sl.go_url("x", DATE) == f"https://ten2net.github.io/go/x/{DATE}/"
    t = sl.target_url("x", DATE)
    assert "utm_source=x" in t and "utm_medium=social" in t and f"utm_campaign={DATE}" in t


def test_target_url_platforms_are_distinct():
    assert "utm_source=x" in sl.target_url("x", DATE)
    assert "utm_source=tg" in sl.target_url("tg", DATE)
    assert "utm_source=xueqiu" in sl.target_url("xueqiu", DATE)


def test_go_url_rejects_unknown_platform():
    with pytest.raises(ValueError):
        sl.go_url("weibo", DATE)


def test_go_pages_writes_all_platforms_and_is_idempotent(tmp_path):
    out = tmp_path / "go"
    dates = ["2026-11-06", "2026-11-05"]
    w = sl.go_pages(out, dates, log=lambda _m: None)
    assert len(w) == 6
    for plat in sl.PLATFORMS:
        for d in dates:
            html = (out / plat / d / "index.html").read_text(encoding="utf-8")
            assert f"utm_source={plat}" in html and "http-equiv=\"refresh\"" in html
    assert sl.go_pages(out, dates, log=lambda _m: None) == []  # 幂等


# ---------------------------------------------------------------- 竖版卡片 / 二维码

def test_vertical_card_size_and_png(tmp_path):
    from PIL import Image
    out = tmp_path / "v.png"
    ec.render_card_vertical(ec.extract_metrics(payload(), DATE), out,
                            go_url=sl.go_url("tg", DATE))
    with Image.open(out) as im:
        assert im.size == (1080, 1350) and im.format == "PNG"


def test_qr_image_size():
    img = ec._qr_image(sl.go_url("tg", DATE), 180)
    if img is not None:  # 装了 qrcode 才断言
        assert img.size == (180, 180)


def test_generate_produces_both_variants(tmp_path):
    reviews, out = tmp_path / "reviews", tmp_path / "cards"
    reviews.mkdir()
    (reviews / f"{DATE}.json").write_text(json.dumps(payload()), encoding="utf-8")
    w = ec.generate(reviews, out, dates=[DATE], log=lambda _m: None)
    names = {p.name for p in w}
    assert names == {f"{DATE}.png", "latest.png",
                     f"{DATE}-vertical.png", "latest-vertical.png"}


# ---------------------------------------------------------------- caption / 合规

def test_captions_contain_link_and_disclaimer():
    m = ec.extract_metrics(payload(), DATE)
    for plat in sp.PLATFORMS:
        cap = sp.build_caption(plat, m, sl.go_url(plat, DATE))
        assert cap.go_url in cap.text
        assert "不构成投资建议" in cap.text or "不推荐个股" in cap.text
        assert m.phase in cap.text and "32" in cap.text


def test_x_caption_within_280_chars():
    m = ec.extract_metrics(payload(), DATE)
    assert len(sp.build_caption("x", m, sl.go_url("x", DATE)).text) <= 280


def test_compliance_passes_normal_payload():
    m = ec.extract_metrics(payload(), DATE)
    for plat in sp.PLATFORMS:
        assert sp.compliance_ok(sp.build_caption(plat, m, sl.go_url(plat, DATE)), payload())


def test_compliance_rejects_trade_recommendation_in_payload():
    bad = payload(focus_md="建议明日买入该股，止损位 10.5 元")
    m = ec.extract_metrics(bad, DATE)
    assert not sp.compliance_ok(sp.build_caption("x", m, "u"), bad)


def test_compliance_rejects_trade_recommendation_in_caption():
    """caption 本身含荐股（剔除免责声明后）也要被拦。"""
    m = ec.extract_metrics(payload(), DATE)
    cap = sp.Caption(platform="x", text="明日买入XX股，目标价 12 元", go_url="u")
    assert not sp.compliance_ok(cap, payload())


def test_disclaimer_alone_would_false_positive_but_is_excluded():
    """has_trade_recommendation(DISCLAIMER) 命中产品口径词；扫描 caption 时必须剔除。"""
    from review_agent.product_policy import has_trade_recommendation as h
    assert h(bp.DISCLAIMER)  # 记录这个坑确实存在
    m = ec.extract_metrics(payload(), DATE)
    cap = sp.build_caption("tg", m, "u")
    assert sp.compliance_ok(cap, payload())  # 剔除后不误杀


# ---------------------------------------------------------------- 台账

def test_ledger_record_and_is_posted(tmp_path):
    led = {}
    assert not sp.is_posted(led, DATE, "x")
    sp.record(led, DATE, "x", status="posted", post_id="p1")
    assert sp.is_posted(led, DATE, "x")
    sp.record(led, DATE, "tg", status="failed", reason="boom")
    assert not sp.is_posted(led, DATE, "tg")  # 失败不算已发，下次可重试


def test_ledger_save_load_roundtrip(tmp_path):
    p = sp.ledger_path(tmp_path)
    sp._save_ledger(p, {"a": {"status": "posted"}})
    assert sp._load_ledger(p)["a"]["status"] == "posted"


# ---------------------------------------------------------------- distribute

def _cards(tmp_path):
    from PIL import Image
    cards = tmp_path / "cards"
    cards.mkdir()
    Image.new("RGB", (1080, 1350), (20, 20, 28)).save(cards / f"{DATE}-vertical.png")
    return cards


def test_dry_run_never_calls_sender(tmp_path):
    calls = []
    r = sp.distribute(DATE, payload(), reviews_dir=tmp_path,
                      cards_dir=_cards(tmp_path), packs_dir=tmp_path / "packs",
                      dry_run=True, ledger_home=tmp_path,
                      sender=lambda *a: calls.append(a) or "id",
                      log=lambda _m: None)
    assert calls == []
    assert r.outcomes["x"] == "dry-run" and r.outcomes["tg"] == "dry-run"
    assert r.outcomes["xueqiu"] == "pack"


def test_dry_run_does_not_write_success_ledger(tmp_path):
    sp.distribute(DATE, payload(), reviews_dir=tmp_path,
                  cards_dir=_cards(tmp_path), packs_dir=tmp_path / "packs",
                  dry_run=True, ledger_home=tmp_path, log=lambda _m: None)
    led = sp._load_ledger(sp.ledger_path(tmp_path))
    assert not any(v.get("status") == "posted" for v in led.values())


def test_auto_post_with_credentials_and_idempotency(tmp_path, monkeypatch):
    monkeypatch.setenv("TG_BOT_TOKEN", "t")
    monkeypatch.setenv("TG_CHAT_ID", "c")
    for k, v in {"X_API_KEY": "k", "X_API_SECRET": "s",
                 "X_ACCESS_TOKEN": "at", "X_ACCESS_SECRET": "as"}.items():
        monkeypatch.setenv(k, v)
    calls = []
    kw = dict(reviews_dir=tmp_path, cards_dir=_cards(tmp_path),
              packs_dir=tmp_path / "packs", ledger_home=tmp_path,
              sender=lambda p, *_a: calls.append(p) or "id-" + p,
              log=lambda _m: None)
    r1 = sp.distribute(DATE, payload(), **kw)
    assert r1.outcomes["x"] == "posted" and r1.outcomes["tg"] == "posted"
    assert r1.outcomes["xueqiu"] == "pack"
    assert set(calls) == {"x", "tg"}
    # 二次：台账拦截，不再发帖
    calls.clear()
    r2 = sp.distribute(DATE, payload(), **kw)
    assert calls == [] and r2.outcomes["x"] == "skipped" and r2.outcomes["tg"] == "skipped"


def test_missing_credentials_skips_without_error(tmp_path, monkeypatch):
    for k in ("TG_BOT_TOKEN", "TG_CHAT_ID", "X_API_KEY", "X_API_SECRET",
              "X_ACCESS_TOKEN", "X_ACCESS_SECRET"):
        monkeypatch.delenv(k, raising=False)
    r = sp.distribute(DATE, payload(), reviews_dir=tmp_path,
                      cards_dir=_cards(tmp_path), packs_dir=tmp_path / "packs",
                      ledger_home=tmp_path, sender=lambda *a: "id",
                      log=lambda _m: None)
    assert r.outcomes["x"] == "skipped" and r.outcomes["tg"] == "skipped"


def test_sender_failure_is_recorded_not_raised(tmp_path, monkeypatch):
    monkeypatch.setenv("TG_BOT_TOKEN", "t")
    monkeypatch.setenv("TG_CHAT_ID", "c")
    def boom(*_a):
        raise RuntimeError("api down")
    r = sp.distribute(DATE, payload(), reviews_dir=tmp_path,
                      cards_dir=_cards(tmp_path), packs_dir=tmp_path / "packs",
                      platforms=("tg",), ledger_home=tmp_path,
                      sender=boom, log=lambda _m: None)
    assert r.outcomes["tg"] == "failed"  # 不抛
    led = sp._load_ledger(sp.ledger_path(tmp_path))
    assert led[f"{DATE}:tg"]["status"] == "failed"


def test_compliance_block_skips_platform(tmp_path):
    bad = payload(focus_md="建议买入，止损 10 元")
    r = sp.distribute(DATE, bad, reviews_dir=tmp_path,
                      cards_dir=_cards(tmp_path), packs_dir=tmp_path / "packs",
                      platforms=("x", "tg"), ledger_home=tmp_path,
                      sender=lambda *a: "id", log=lambda _m: None)
    assert r.outcomes == {"x": "skipped", "tg": "skipped"}


def test_xueqiu_writes_pack_with_caption_and_card(tmp_path):
    r = sp.distribute(DATE, payload(), reviews_dir=tmp_path,
                      cards_dir=_cards(tmp_path), packs_dir=tmp_path / "packs",
                      platforms=("xueqiu",), ledger_home=tmp_path,
                      log=lambda _m: None)
    pack = tmp_path / "packs" / DATE
    assert r.outcomes["xueqiu"] == "pack"
    assert (pack / "caption.md").is_file() and (pack / "card.png").is_file()
    # caption 里是 /go/ 跳页短链（UTM 参数在跳页内部，不在文案里）
    assert "/go/xueqiu/" in (pack / "caption.md").read_text(encoding="utf-8")


# ---------------------------------------------------------------- 发布管道接线

def test_owned_dirs_include_go_and_social():
    assert "go" in bp.OWNED_DIRS and "social" in bp.OWNED_DIRS and "cards" in bp.OWNED_DIRS
    assert bp._owned(Path("go/x/2026-11-06/index.html"))
    assert bp._owned(Path("social/packs/2026-11-06/caption.md"))


def test_sync_public_carries_go_pages(tmp_path):
    pub, repo = tmp_path / "public", tmp_path / "repo"
    (pub / "go" / "x" / DATE).mkdir(parents=True)
    repo.mkdir()
    (pub / "go" / "x" / DATE / "index.html").write_text("go", encoding="utf-8")
    changed, _ = bp.sync_public(pub, repo)
    assert f"go/x/{DATE}/index.html" in changed
    assert (repo / "go" / "x" / DATE / "index.html").exists()


def test_publish_dry_run_generates_go_pages_and_vertical_cards(tmp_path):
    """发布钩子：dry-run 也应生成 UTM 跳页与竖版卡片（不发帖）。"""
    import shutil
    from pathlib import Path as P
    root = P(__file__).resolve().parents[1]
    site = tmp_path / "blog"
    shutil.copytree(root / "blog", site,
                    ignore=shutil.ignore_patterns("public", "resources"))
    for d in ("static/cards", "static/go"):
        shutil.rmtree(site / d, ignore_errors=True)
    reviews = tmp_path / "reviews"
    reviews.mkdir()
    (reviews / f"{DATE}.json").write_text(json.dumps(payload()), encoding="utf-8")
    bp.publish(site, reviews, dry_run=True, log=lambda _m: None)
    assert (site / "static" / "go" / "x" / DATE / "index.html").is_file()
    assert (site / "static" / "cards" / f"{DATE}-vertical.png").is_file()
    assert (site / "static" / "cards" / f"{DATE}.png").is_file()
