"""名称高亮：结构化字段收集 + HTML/Markdown 文本节点高亮，不误伤标签/URL。"""
import pytest

from review_agent import name_highlight as nh


@pytest.fixture
def payload():
    return {"market_facts": {
        "theme_structure": {"themes": [{"sector": "化学制药", "names": ["双鹭药业"]}]},
        "theme_tree": {"themes": [{"tag": "流感", "members": [{"name": "双鹭药业"}]}]},
        "event_ledger": {"events": [{"name": "中京电子"}]},
        "turnover_top": [{"name": "汇洲智能"}],
    }}


class TestCollectNames:
    def test_collects_three_kinds(self, payload):
        names = nh.collect_names(payload)
        assert names["双鹭药业"] == "stock"
        assert names["化学制药"] == "industry"
        assert names["流感"] == "concept"
        assert names["中京电子"] == "stock"

    def test_skips_generic_words(self):
        p = {"market_facts": {"theme_tree": {"themes": [{"tag": "市场"}]}}}
        assert "市场" not in nh.collect_names(p)

    def test_short_names_skipped(self):
        p = {"market_facts": {"event_ledger": {"events": [{"name": "A"}]}}}
        assert "A" not in nh.collect_names(p)


class TestHighlightHtml:
    def test_text_nodes_only(self, payload):
        names = nh.collect_names(payload)
        out = nh.highlight_html(
            '<p style="color:red;">中京电子涨停，流感与化学制药活跃</p>', names)
        assert 'style="color:red;"' in out          # 标签属性未破坏
        assert '<span style="color:#1a73e8;font-weight:bold;">中京电子</span>' in out
        assert '<span style="color:#e8710a;font-weight:bold;">流感</span>' in out
        assert '<span style="color:#7b3fe4;font-weight:bold;">化学制药</span>' in out

    def test_url_protected(self, payload):
        names = nh.collect_names(payload)
        out = nh.highlight_html('<p>见 https://x.com/a?name=中京电子 </p>', names)
        assert "name=中京电子" in out
        assert "https://x.com/a?name=<span" not in out

    def test_longest_first(self, payload):
        names = {"零售": "concept", "百货零售": "concept"}
        out = nh.highlight_html("<p>百货零售走强</p>", names)
        assert '<span style="color:#e8710a;font-weight:bold;">百货零售</span>' in out
        assert "百货<span" not in out  # 没有被短词先切碎


class TestHighlightMarkdown:
    def test_frontmatter_untouched(self, payload):
        names = nh.collect_names(payload)
        md = "---\ntitle: 中京电子复盘\ndate: x\n---\n\n中京电子涨停，流感活跃"
        out = nh.highlight_markdown(md, names)
        assert "title: 中京电子复盘" in out          # frontmatter 不高亮
        assert '<span style="color:#1a73e8' in out  # 正文高亮

    def test_code_and_url_untouched(self, payload):
        names = nh.collect_names(payload)
        md = "正文 `中京电子` 与 https://x.com/中京电子 ，流感活跃"
        out = nh.highlight_markdown(md, names)
        assert "`中京电子`" in out
        assert "https://x.com/中京电子" in out
        # 正文里的「流感」被正确高亮（代码/URL 里的名称保持原样）
        assert '<span style="color:#e8710a;font-weight:bold;">流感</span>' in out
