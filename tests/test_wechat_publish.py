"""微信公众号发布：正文渲染、凭据闸门、草稿/发布接口（网络全部 mock）。"""
import sys
from pathlib import Path

import pytest

from review_agent import blog_publish as bp
from review_agent import wechat_publish as wp
from review_agent import wechat_render as wr

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_blog_publish import payload, lib, DATE  # noqa: E402


class TestRender:
    def test_lead_and_cards(self):
        html = wr.article_html(payload(), DATE, "https://example.com/post/x/")
        assert "2026-09-23 每日复盘 · 情绪档位退潮" in html
        assert "情绪档位判为退潮。" in html
        assert "情绪档位" in html and "涨跌家数" in html and "1757 / 3366" in html

    def test_wechat_safe_html(self):
        """微信会剥 class / 外部样式 / 脚本：正文里一个都不能出现。"""
        html = wr.article_html(payload(), DATE, "")
        assert 'class=' not in html
        assert "<script" not in html and "<style" not in html
        assert "stylesheet" not in html
        assert "<table" not in html          # 简版承诺：表格全部卡片化

    def test_dynamic_text_escaped(self):
        p = payload()
        p["focus"]["market_oneliner"] = "<b> Evil </b> <script>x</script>"
        html = wr.article_html(p, DATE, "")
        assert "<script>x</script>" not in html
        assert "&lt;script&gt;" in html

    def test_citations_stripped(self):
        html = wr.article_html(payload(), DATE, "")
        assert "[ev-ce37954f134961b04ccb]" not in html
        assert "派生情绪指标" not in html        # 依据附录不进公众号版

    def test_disclaimer_and_blog_url_present(self):
        html = wr.article_html(payload(), DATE, "https://ten2net.github.io/post/x/")
        assert "不构成投资建议" in html
        assert "完整图表版复盘：https://ten2net.github.io/post/x/" in html

    def test_card_lists_from_market_facts(self):
        p = payload(market_facts={
            "theme_structure": {"themes": [
                {"sector": "出版", "limit_up": 5, "highest": 3, "broken": 1},
                {"sector": "家居用品", "limit_up": 3, "highest": 2, "broken": 0},
            ]},
            "theme_tree": {"themes": [{"tag": "IP 经济", "members": [
                {"code": "601811", "name": "新华文轩", "boards": 4, "first_seal": "093026", "label": "最高板"},
                {"code": "000910", "name": "大亚圣象", "boards": 3, "first_seal": "094501", "label": ""},
                {"code": "600000", "name": "浦发银行", "boards": 1, "first_seal": "", "label": ""},
            ]}]},
            "event_ledger": {"events": [
                {"name": "新华文轩", "tag": "最高标", "note": "4 连板", "ret": 9.98},
            ]},
        })
        html = wr.article_html(p, DATE, "")
        assert "连板股名单" in html
        assert "新华文轩 601811 · 4 板 · 首封 09:30:26 · IP 经济" in html
        assert "浦发银行" not in html          # 首板不进连板名单
        assert "出版 · 涨停 5 只 · 最高 3 板 · 炸板 1" in html
        assert "[最高标]" in html and "(+9.98%)" in html

    def test_analyst_and_macro_sections(self):
        p = payload(macro_sector="AI 算力无匹配概念板块")
        html = wr.article_html(p, DATE, "")
        assert "情绪面" in html and "接力转弱。" in html
        assert "板块与宏观" in html and "AI 算力无匹配概念板块" in html


class TestDraftPayload:
    def test_multipart_body(self):
        body, boundary = wp._multipart_body("media", "a.png", b"\x89PNGdata")
        assert body.startswith(f"--{boundary}\r\n".encode())
        assert b'filename="a.png"' in body
        assert body.endswith(f"--{boundary}--\r\n".encode())

    def test_title_digest_truncated(self):
        seen = {}

        def fake_post(path, payload_, token, timeout=20.0):
            seen["path"] = path
            seen["article"] = payload_["articles"][0]
            return {"media_id": "draft_x"}

        monkey = pytest.MonkeyPatch()
        monkey.setattr(wp, "_post_json", fake_post)
        try:
            wp.add_draft("tk", title="长" * 100, content="<p>x</p>", digest="摘" * 200,
                         source_url="https://e.com/", thumb_media_id="thumb1")
        finally:
            monkey.undo()
        art = seen["article"]
        assert seen["path"] == "/cgi-bin/draft/add"
        assert len(art["title"]) == 64
        assert len(art["digest"]) == 120
        assert art["thumb_media_id"] == "thumb1"
        assert art["content_source_url"] == "https://e.com/"


class TestGuard:
    def test_missing_credentials(self, tmp_path, monkeypatch):
        monkeypatch.delenv("WECHAT_APPID", raising=False)
        monkeypatch.delenv("WECHAT_SECRET", raising=False)
        (tmp_path / ".env").write_text("# no wechat keys\n", encoding="utf-8")
        with pytest.raises(wp.WechatError):
            wp._credentials(tmp_path / ".env")

    def test_public_gate_blocks(self, tmp_path):
        reviews = lib(tmp_path, (DATE, payload(
            focus_md="# x\n\n明日建议买入中际旭创。")))
        with pytest.raises(bp.PublishError):
            wp.publish_review(reviews, DATE, draft_only=True)

    def test_publish_review_happy_path(self, tmp_path, monkeypatch):
        reviews = lib(tmp_path, (DATE, payload()))
        calls = []

        def fake_post(path, p, t, timeout=20.0):
            calls.append(path)
            if path.endswith("/get"):
                return {"publish_status": 0}
            if path.endswith("/submit"):
                return {"publish_id": "p1"}
            return {"media_id": "m1"}

        monkeypatch.setattr(wp, "get_access_token", lambda *a, **k: "tk")
        monkeypatch.setattr(wp, "upload_cover", lambda *a, **k: "thumb")
        monkeypatch.setattr(wp, "_post_json", fake_post)
        monkeypatch.setattr(wp.time, "sleep", lambda s: None)
        monkeypatch.setattr(wp.time, "time", iter([0, 0]).__next__)
        result = wp.publish_review(reviews, DATE, draft_only=False)
        assert calls[0] == "/cgi-bin/draft/add"
        assert calls[1] == "/cgi-bin/freepublish/submit"
        assert calls[2] == "/cgi-bin/freepublish/get"
        assert result["publish_id"] == "p1"

    def test_freepublish_failure_status(self, monkeypatch):
        responses = iter([{"publish_id": "p1"}, {"publish_status": 3, "fail_msg": "常规失败"}])

        def fake_post(path, p, t, timeout=20.0):
            return next(responses)

        monkeypatch.setattr(wp, "_post_json", fake_post)
        monkeypatch.setattr(wp.time, "sleep", lambda s: None)
        monkeypatch.setattr(wp.time, "time", iter([0, 0, 10]).__next__)
        with pytest.raises(wp.WechatError):
            wp.freepublish("tk", "draft", wait=True)
