"""「长期拉关注」贴图：文案合规、PNG 渲染、正文 HTML、微信上传/草稿（网络全 mock）。"""
import json
from pathlib import Path

import pytest

from review_agent import follow_poster as fp
from review_agent import wechat_publish as wp


class TestCopy:
    def test_copy_passes_trade_policy(self):
        fp.check_copy()  # 不抛即通过

    def test_all_required_messages_present(self):
        t = fp._all_text()
        assert "入口" in t                       # 公众号只是入口
        assert "阅读原文" in t                    # 文末左下角引导
        assert "图文版本" in t or "图文版" in t    # 表现力更友好的图文版
        assert "股" in t and "亲友" in t          # 股民 / 非股民转给亲友
        assert "立马赚钱" in t and "稀里糊涂" in t  # 文眼金句
        assert "抱团" in t and "留言" in t        # 诚恳回关/抱团前行的态度

    def test_not_blatant_promotion(self):
        """含蓄：不喊关注、不提 100/门槛、不写做不到的『回关』功能承诺。"""
        t = fp._all_text()
        for banned in ("求关注", "点个关注", "关注我", "100 个", "100个", "开通受限", "回关"):
            assert banned not in t, banned

    def test_no_trade_recommendation_in_any_single_line(self):
        from review_agent.product_policy import has_trade_recommendation as h
        assert not h(fp._all_text())


class TestRender:
    def test_png_written_with_expected_size(self, tmp_path):
        out = fp.render_poster_png(tmp_path / "p" / "poster.png")
        assert out.is_file() and out.stat().st_size > 10_000
        from PIL import Image
        with Image.open(out) as im:
            assert im.size == (fp.P_WIDTH, fp.P_HEIGHT)

    def test_article_html_is_wechat_safe(self):
        h = fp.article_html(image_url="https://mmbiz.qpic.cn/x.png")
        assert "<img" in h and "https://mmbiz.qpic.cn/x.png" in h
        assert "阅读原文" in h and fp.READ_ORIGINAL_URL  # 阅读原文 URL 由 add_draft 的 source_url 承载
        assert 'class=' not in h
        assert "<script" not in h and "<style" not in h and "<table" not in h

    def test_article_html_without_image_omits_img(self):
        assert "<img" not in fp.article_html(image_url="")


class TestWechatPoster:
    def test_upload_content_image_returns_url(self, monkeypatch, tmp_path):
        img = tmp_path / "a.png"
        img.write_bytes(b"\x89PNGdata")

        class Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return json.dumps({"url": "http://mmbiz.qpic.cn/abc"}).encode()

        monkeypatch.setattr(wp._OPENER, "open", lambda *a, **k: Resp())
        assert wp.upload_content_image("tk", img) == "http://mmbiz.qpic.cn/abc"

    def test_upload_content_image_rejects_error(self, monkeypatch, tmp_path):
        img = tmp_path / "a.png"
        img.write_bytes(b"x")

        class Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return json.dumps({"errcode": 40001, "errmsg": "invalid"}).encode()

        monkeypatch.setattr(wp._OPENER, "open", lambda *a, **k: Resp())
        with pytest.raises(wp.WechatError):
            wp.upload_content_image("tk", img)

    def test_publish_follow_poster_draft_only(self, monkeypatch, tmp_path):
        """全链路 mock：只进草稿箱，阅读原文指向揽宝系统，不群发。"""
        png = tmp_path / "poster.png"
        png.write_bytes(b"\x89PNGdata")
        seen = {}

        monkeypatch.setattr(wp, "get_access_token", lambda *a, **k: "tk")
        monkeypatch.setattr(wp, "upload_content_image", lambda *a, **k: "http://mmbiz.qpic.cn/p.png")
        monkeypatch.setattr(wp, "upload_cover", lambda *a, **k: "thumb1")

        def fake_add_draft(token, *, title, content, digest, source_url, thumb_media_id, author="揽宝投研"):
            seen.update(title=title, content=content, digest=digest,
                        source_url=source_url, thumb_media_id=thumb_media_id)
            return "draft_poster"

        monkeypatch.setattr(wp, "add_draft", fake_add_draft)
        monkeypatch.setattr(wp, "freepublish", lambda *a, **k: pytest.fail("draft_only 不该群发"))

        result = wp.publish_follow_poster(poster=png, draft_only=True)
        assert result["draft_id"] == "draft_poster" and result["publish_id"] == ""
        assert seen["source_url"] == fp.READ_ORIGINAL_URL
        assert seen["title"] == fp.COPY.title
        assert "<img" in seen["content"] and "阅读原文" in seen["content"]
        assert "class=" not in seen["content"]
