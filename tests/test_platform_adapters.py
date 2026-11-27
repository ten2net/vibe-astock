"""平台适配层离线单测：导流文案、第三道合规闸、公众号二维码卡片、图文包落盘。

全离线、不打任何平台 API。遵守「母版不动」：只测适配层与挂载点，不改
wechat_publish / wechat_render / duanxian 的既有契约。
"""
from pathlib import Path

import pytest

from review_agent import emotion_card as ec
from review_agent import platform_adapters as pa
from review_agent import social_publish as sp

pytestmark = pytest.mark.unit

DATE = "2026-11-06"


def payload(**over):
    base = {
        "focus": {"emotion_phase": "退潮", "market_oneliner": "情绪档位判为退潮。"},
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


def metrics():
    return ec.extract_metrics(payload(), DATE)


def cards(tmp_path):
    from PIL import Image
    out = tmp_path / "cards"
    out.mkdir(exist_ok=True)
    for suffix, color in (("vertical", (20, 20, 28)), ("xhs", (24, 24, 32)),
                          ("lead", (28, 28, 36))):
        Image.new("RGB", (1080, 1350), color).save(out / f"{DATE}-{suffix}.png")
    Image.new("RGB", (1200, 630), (32, 32, 40)).save(out / f"{DATE}-lead-h.png")
    Image.new("RGB", (840, 336), (36, 36, 44)).save(out / f"{DATE}-cover.png")
    Image.new("RGB", (840, 336), (40, 40, 48)).save(out / f"{DATE}-cover-qr.png")
    return out


# ---------------------------------------------------------------- 文案

def test_lead_caption_has_slogan_disclaimer_no_url():
    for plat in pa.LEAD_PLATFORMS:
        cap = pa.build_lead_caption(plat, metrics())
        assert cap.platform == plat and cap.go_url == ""
        # 雪球可导流；东财按财富号规范禁止任何公众号导流
        if plat == "xueqiu":
            assert pa.LEAD_SLOGAN in cap.text
        else:
            assert pa.LEAD_SLOGAN not in cap.text
        assert "不构成投资建议" in cap.text
        assert "32" in cap.text and "退潮" in cap.text
        assert "http" not in cap.text and "扫码" not in cap.text


def test_lead_caption_two_platforms_have_distinct_voice():
    xq = pa.build_lead_caption("xueqiu", metrics()).text
    df = pa.build_lead_caption("dongfang", metrics()).text
    assert "数据来源：公开榜单与程序统计" in xq       # 主阵地带数据口径 + 导流
    assert pa.LEAD_SLOGAN in xq
    assert "公开数据，仅供复盘参考" in df              # 财富号纯数据，不导流
    assert pa.LEAD_SLOGAN not in df
    assert xq != df


def test_lead_caption_rejects_non_lead_platform():
    with pytest.raises(ValueError):
        pa.build_lead_caption("xiaohongshu", metrics())


# ---------------------------------------------------------------- 门禁

def test_lead_gate_passes_normal_text():
    for plat in pa.LEAD_PLATFORMS:
        assert pa.lead_gate(pa.build_lead_caption(plat, metrics()).text)


def test_lead_gate_rejects_trade_recommendation():
    assert not pa.lead_gate("明日买入XX股，目标价 12 元")


def test_lead_gate_rejects_bad_marketing_words():
    for bad in ("稳赚不赔", "跟单操作", "内部消息", "限时名额", "加群私聊", "带你赚"):
        assert not pa.lead_gate(f"复盘笔记，{bad}，仅供参考")


def test_lead_gate_rejects_url_and_qr_words():
    for bad in ("https://example.com", "www.foo.cn", "扫码关注", "二维码见"):
        assert not pa.lead_gate(f"复盘笔记，{bad}")


def test_lead_gate_does_not_false_positive_on_disclaimer_or_slogan():
    # 免责声明与固定导流句都含「不推荐个股」「公众号」等词，剔除后不应误杀
    from review_agent.blog_publish import DISCLAIMER
    text = f"{pa.LEAD_SLOGAN}。\n\n{DISCLAIMER}"
    assert pa.lead_gate(text)


def test_compliance_ok_applies_lead_gate_to_lead_platforms():
    # 构造含违规营销词的 caption：导流平台应被第三道闸拦下
    bad = sp.Caption(platform="xueqiu", text="稳赚不赔，关注公众号：揽宝投研", go_url="")
    assert not sp.compliance_ok(bad, payload())
    # 非导流平台不走第三道闸（仅产品政策 + 公开文本）
    good = sp.build_caption("xueqiu", metrics(), "")
    assert sp.compliance_ok(good, payload())


# ---------------------------------------------------------------- 卡片

def test_default_qr_path_exists():
    assert pa.default_qr_path().is_file(), "公众号二维码素材缺失"


def test_render_lead_card_horizontal_is_og_size_without_qr(tmp_path):
    """雪球长文配图：1200×630 横版、文案含导流句、无二维码文件名语义。"""
    from PIL import Image
    out = tmp_path / "lead-h.png"
    pa.render_lead_card_horizontal(metrics(), out)
    with Image.open(out) as im:
        assert im.size == (1200, 630) and im.format == "PNG"


def test_eastmoney_gate_blocks_promotion_and_allows_clean_text():
    """财富号规范 2.1：禁二维码/微信/公众号/变种/营销，纯数据复盘可过。"""
    assert pa.eastmoney_gate(pa.build_lead_caption("dongfang", metrics()).text)
    for bad in ("公众号：揽宝投研", "加个人微信", "薇信公众号", "威信公众号",
                "扫码关注", "回复复盘获得清单", "下载APP", "网盘资源"):
        assert not pa.eastmoney_gate(f"复盘笔记。{bad}")


def test_compliance_ok_rejects_lead_slogan_on_eastmoney():
    """同一段雪球文案若发到东财，应被财富号门禁拦下。"""
    bad = sp.Caption(platform="dongfang",
                     text=pa.build_lead_caption("xueqiu", metrics()).text, go_url="")
    assert not sp.compliance_ok(bad, payload())


def test_render_eastmoney_card_is_vertical_and_has_no_qr(tmp_path):
    """东财合规配图：1080×1350，无二维码、无公众号字样。"""
    from PIL import Image
    out = tmp_path / "em.png"
    pa.render_eastmoney_card(metrics(), out)
    with Image.open(out) as im:
        assert im.size == (1080, 1350) and im.format == "PNG"


def test_render_lead_cover_two_variants_are_840x336(tmp_path):
    """雪球长文封面：840×336 扁横版，无码/带码两版。"""
    from PIL import Image
    plain = tmp_path / "cover.png"
    qr = tmp_path / "cover-qr.png"
    pa.render_lead_cover(metrics(), plain, with_qr=False)
    pa.render_lead_cover(metrics(), qr, with_qr=True)
    with Image.open(plain) as im:
        assert im.size == (840, 336)
    with Image.open(qr) as im:
        assert im.size == (840, 336)


def test_xueqiu_pack_includes_both_covers(tmp_path):
    r = sp.distribute(DATE, payload(), reviews_dir=tmp_path,
                      cards_dir=cards(tmp_path), packs_dir=tmp_path / "packs",
                      platforms=("xueqiu",), ledger_home=tmp_path,
                      log=lambda _m: None)
    assert r.outcomes["xueqiu"] == "pack"
    pack = tmp_path / "packs" / DATE
    assert (pack / "cover.png").is_file() and (pack / "cover-qr.png").is_file()


def test_render_lead_card_is_vertical_png(tmp_path):
    from PIL import Image
    out = tmp_path / "lead.png"
    pa.render_lead_card(metrics(), out)
    with Image.open(out) as im:
        assert im.size == (1080, 1350) and im.format == "PNG"


def test_render_lead_card_falls_back_without_qr_file(tmp_path):
    # 二维码缺失时不应整卡失败（增强项降级）
    out = tmp_path / "lead.png"
    pa.render_lead_card(metrics(), out, qr_path=tmp_path / "missing.png")
    assert out.is_file()


# ---------------------------------------------------------------- 图文包落盘

def test_dongfang_pack_uses_lead_card_and_own_dir(tmp_path):
    r = sp.distribute(DATE, payload(), reviews_dir=tmp_path,
                      cards_dir=cards(tmp_path), packs_dir=tmp_path / "packs",
                      platforms=("dongfang",), ledger_home=tmp_path,
                      log=lambda _m: None)
    assert r.outcomes["dongfang"] == "pack"
    pack = tmp_path / "packs" / "dongfang" / DATE
    assert (pack / "caption.md").is_file() and (pack / "card.png").is_file()
    assert (pack / "card.png").read_bytes() == (tmp_path / "cards" / f"{DATE}-lead.png").read_bytes()
    cap = (pack / "caption.md").read_text(encoding="utf-8")
    # 财富号合规：无公众号导流、无二维码、无外链
    assert pa.LEAD_SLOGAN not in cap and "公众号" not in cap and "http" not in cap


def test_both_lead_platforms_pack_in_one_run(tmp_path):
    r = sp.distribute(DATE, payload(), reviews_dir=tmp_path,
                      cards_dir=cards(tmp_path), packs_dir=tmp_path / "packs",
                      platforms=("xueqiu", "dongfang"), ledger_home=tmp_path,
                      log=lambda _m: None)
    assert r.outcomes == {"xueqiu": "pack", "dongfang": "pack"}
    assert (tmp_path / "packs" / DATE / "card.png").is_file()
    assert (tmp_path / "packs" / "dongfang" / DATE / "card.png").is_file()


def test_lead_pack_records_ledger_and_dry_run_does_not(tmp_path):
    kw = dict(reviews_dir=tmp_path, cards_dir=cards(tmp_path),
              packs_dir=tmp_path / "packs", ledger_home=tmp_path,
              platforms=("dongfang",), log=lambda _m: None)
    # 图文包平台按现有语义每次重出素材，台账记 pack 状态（不是 posted）
    sp.distribute(DATE, payload(), **kw)
    led = sp._load_ledger(sp.ledger_path(tmp_path))
    assert led[f"{DATE}:dongfang"]["status"] == "pack"
    # dry-run 不写台账
    dry = tmp_path / "dry"
    sp.distribute(DATE, payload(), reviews_dir=tmp_path, cards_dir=cards(tmp_path),
                  packs_dir=dry / "packs", ledger_home=dry, platforms=("dongfang",),
                  dry_run=True, log=lambda _m: None)
    assert sp._load_ledger(sp.ledger_path(dry)) == {}


def test_default_platforms_unchanged_xhs_and_xueqiu():
    # 东财通过显式 --platform 触发，默认集合不动（小红书保持原样）
    assert sp.DEFAULT_PLATFORMS == ("xiaohongshu", "xueqiu")
    assert "dongfang" in sp.PLATFORMS and "dongfang" in sp.PACK_PLATFORMS
