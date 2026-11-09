"""情绪卡片图生成器（review_agent/emotion_card.py）离线单测。

用构造的复盘 dict + tmp_path 输出，不碰仓库 static/cards、不联网。
真实 PNG 用 Pillow 打开校验尺寸/格式。
"""
import json
from pathlib import Path

import pytest

from review_agent import emotion_card as ec
from review_agent import blog_publish as bp

pytestmark = pytest.mark.unit

DATE = "2026-11-06"


def payload(**over):
    base = {
        "focus": {"emotion_phase": "退潮"},
        "emotion_metrics": {
            "promotion": {"available": True, "limit_up_count": 32,
                          "overall": {"base": 84, "promoted": 11, "rate": 0.131}},
        },
        "market_facts": {
            "seal_quality": {"available": True, "total": 32, "broken_rate": 0.304},
        },
    }
    base.update(over)
    return base


def test_extract_metrics_formats_rates_and_counts():
    m = ec.extract_metrics(payload(), DATE)
    assert m.date == DATE and m.phase == "退潮"
    assert m.limit_up == "32"
    assert m.promote_rate == "13.1%"
    assert m.broken_rate == "30.4%"


def test_extract_metrics_missing_fields_degrade_to_dash():
    m = ec.extract_metrics({"focus": {}, "emotion_metrics": {}, "market_facts": {}}, DATE)
    assert m.phase == "—" and m.limit_up == "—"
    assert m.promote_rate == "—" and m.broken_rate == "—"


def test_extract_metrics_uses_seal_total_as_limit_up_fallback():
    p = payload()
    p["emotion_metrics"]["promotion"].pop("limit_up_count")
    assert ec.extract_metrics(p, DATE).limit_up == "32"


def test_extract_metrics_rejects_non_string_phase():
    m = ec.extract_metrics({"focus": {"emotion_phase": {"bad": 1}}}, DATE)
    assert m.phase == "—"


def test_pct_ignores_bool_and_none():
    assert ec._pct(True) == "—" and ec._pct(None) == "—"
    assert ec._pct(0.5) == "50.0%"


def test_iter_review_dates_skips_latest_and_bad_files(tmp_path):
    (tmp_path / "2026-11-06.json").write_text(json.dumps(payload()), encoding="utf-8")
    (tmp_path / "2026-11-05.json").write_text(json.dumps(payload()), encoding="utf-8")
    (tmp_path / "latest.json").write_text(json.dumps(payload()), encoding="utf-8")
    (tmp_path / "broken.json").write_text("{not json", encoding="utf-8")
    assert ec.iter_review_dates(tmp_path) == ["2026-11-06", "2026-11-05"]


def test_render_card_produces_valid_1200x630_png(tmp_path):
    from PIL import Image

    out = tmp_path / "cards" / f"{DATE}.png"
    ec.render_card(ec.extract_metrics(payload(), DATE), out)
    assert out.is_file()
    with Image.open(out) as im:
        im.verify()
    with Image.open(out) as im:
        assert im.size == (ec.WIDTH, ec.HEIGHT) == (1200, 630)
        assert im.format == "PNG"


def test_render_card_survives_all_missing_data(tmp_path):
    from PIL import Image

    out = tmp_path / "empty.png"
    ec.render_card(ec.extract_metrics({}, DATE), out)
    with Image.open(out) as im:
        assert im.size == (1200, 630)


def test_generate_writes_per_date_and_latest(tmp_path):
    reviews, out = tmp_path / "reviews", tmp_path / "cards"
    reviews.mkdir()
    for d in ("2026-11-05", "2026-11-06"):
        (reviews / f"{d}.json").write_text(json.dumps(payload()), encoding="utf-8")
    logs = []
    written = ec.generate(reviews, out, log=lambda m: logs.append(m))
    names = {p.name for p in written}
    # 横版（OG 契约）+ 竖版（社媒发图），横竖各出 latest
    assert names == {
        "2026-11-05.png", "2026-11-06.png", "latest.png",
        "2026-11-05-vertical.png", "2026-11-06-vertical.png", "latest-vertical.png",
    }
    assert (out / "latest.png").read_bytes() == (out / "2026-11-06.png").read_bytes()
    assert (out / "latest-vertical.png").read_bytes() == (out / "2026-11-06-vertical.png").read_bytes()
    assert any("情绪卡片" in m for m in logs)


def test_generate_vertical_false_keeps_og_contract(tmp_path):
    """vertical=False 时只出横版，供只想刷 OG 图的场景（向后兼容）。"""
    reviews, out = tmp_path / "reviews", tmp_path / "cards"
    reviews.mkdir()
    (reviews / "2026-11-06.json").write_text(json.dumps(payload()), encoding="utf-8")
    written = ec.generate(reviews, out, dates=["2026-11-06"], vertical=False,
                          log=lambda _m: None)
    assert {p.name for p in written} == {"2026-11-06.png", "latest.png"}


def test_render_card_vertical_is_1080x1350_with_qr(tmp_path):
    from PIL import Image

    out = tmp_path / "v.png"
    ec.render_card_vertical(ec.extract_metrics(payload(), DATE), out,
                            go_url="https://ten2net.github.io/go/tg/2026-11-06/")
    with Image.open(out) as im:
        assert im.size == (ec.V_WIDTH, ec.V_HEIGHT) == (1080, 1350)
        assert im.format == "PNG"


def test_qr_image_encodes_url_and_degrades_without_lib(tmp_path):
    """有 qrcode 库时产出可解码尺寸的图；缺库返回 None 不抛。"""
    img = ec._qr_image("https://ten2net.github.io/go/tg/2026-11-06/", 180)
    if img is not None:  # 装了 qrcode 才有
        assert img.size == (180, 180)


def test_generate_skips_bad_json_without_crashing(tmp_path):
    reviews, out = tmp_path / "reviews", tmp_path / "cards"
    reviews.mkdir()
    (reviews / "2026-11-06.json").write_text("{bad", encoding="utf-8")
    written = ec.generate(reviews, out, log=lambda _m: None)
    assert written == []  # 坏 json 跳过，latest 也不该凭空出现


def test_generate_missing_review_file_is_skipped(tmp_path):
    out = tmp_path / "cards"
    written = ec.generate(tmp_path / "none", out,
                          dates=["2099-01-01"], log=lambda _m: None)
    assert written == []


def test_owned_dirs_includes_cards():
    """否则 sync_public 跳过 PNG，线上 og:image 全指向 404。"""
    assert "cards" in bp.OWNED_DIRS
    assert bp._owned(Path("cards/2026-11-06.png"))
    assert bp._owned(Path("cards/latest.png"))


def test_sync_public_copies_cards(tmp_path):
    pub, repo = tmp_path / "public", tmp_path / "repo"
    (pub / "cards").mkdir(parents=True)
    repo.mkdir()
    (pub / "cards" / "latest.png").write_bytes(b"PNG")
    changed, _ = bp.sync_public(pub, repo)
    assert "cards/latest.png" in changed
    assert (repo / "cards" / "latest.png").read_bytes() == b"PNG"
    assert bp.sync_public(pub, repo) == ([], [])  # 幂等


def test_publish_dry_run_generates_cards(tmp_path):
    """发布钩子：dry_run 也应在临时 site 里生成卡片，且不改仓库源。"""
    site = tmp_path / "blog"
    # 最小站点：只要有 hugo.toml + content/post + static，write_sources 能跑
    import shutil
    from pathlib import Path as P
    root = P(__file__).resolve().parents[1]
    shutil.copytree(root / "blog", site, ignore=shutil.ignore_patterns("public", "resources"))
    (site / "static" / "cards").mkdir(parents=True, exist_ok=True)
    # 清掉已有卡片，验证钩子真的重新生成
    for f in (site / "static" / "cards").glob("*.png"):
        f.unlink()
    reviews = tmp_path / "reviews"
    reviews.mkdir()
    (reviews / f"{DATE}.json").write_text(json.dumps(payload()), encoding="utf-8")
    logs = []
    bp.publish(site, reviews, dry_run=True, log=lambda m: logs.append(m))
    assert (site / "static" / "cards" / f"{DATE}.png").is_file()
    assert (site / "static" / "cards" / "latest.png").is_file()
    assert any("情绪卡片" in m for m in logs)
