"""Hugo 博客 SEO 元数据回归：title / Open Graph / Twitter Card / JSON-LD。

用真实 hugo 构建到临时目录、解析生成的 HTML 断言，不碰远程、不改站点源。
背景见 blog/README.md「订阅源」与「本地定制点」两节。
"""
import json
import re
import shutil
from pathlib import Path

import pytest

from review_agent import blog_publish as bp

ROOT = Path(__file__).resolve().parents[1]


def _hugo() -> str | None:
    local = ROOT / ".local" / "bin" / "hugo"
    if local.exists():
        return str(local)
    return shutil.which("hugo")


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    hugo = _hugo()
    if not hugo:
        pytest.skip("没有 hugo")
    out = tmp_path_factory.mktemp("seo") / "out"
    bp.build(ROOT / "blog", hugo=hugo, dest_dir=out)
    home = (out / "index.html").read_text(encoding="utf-8")
    post_html = next((out / "post").glob("*/index.html")).read_text(encoding="utf-8")
    return home, post_html


def _meta(html: str) -> dict[str, list[str]]:
    """抽出 name=/property= 的 meta content，按 key 收集（可能有多个）。"""
    out: dict[str, list[str]] = {}
    for key, val in re.findall(r'<meta\s+(?:name|property)="([^"]+)"\s+content="([^"]*)"', html):
        out.setdefault(key, []).append(val)
    return out


def _jsonld(html: str) -> list[dict]:
    blocks = re.findall(r'<script type="application/ld\+json">(.*?)</script>', html, re.S)
    return [json.loads(b) for b in blocks]


def test_home_title_has_no_duplicate_site_name(built):
    home, _ = built
    title = re.search(r"<title>([^<]*)</title>", home).group(1)
    assert title == "揽宝.复盘 | 揽宝投研", title
    # 站点名只能出现一次（旧版是「揽宝.复盘 | 揽宝.复盘 | 揽宝投研」）
    assert title.count("揽宝.复盘") == 1


def test_post_title_is_page_title_plus_site_name(built):
    _, post = built
    title = re.search(r"<title>([^<]*)</title>", post).group(1)
    assert "每日复盘" in title
    assert title.endswith(" | 揽宝.复盘"), title
    assert title.count("揽宝.复盘") == 1


def test_home_og_meta_is_complete(built):
    home, _ = built
    m = _meta(home)
    assert m["og:title"] == ["揽宝.复盘 | 揽宝投研"]     # 旧版是空
    assert m["twitter:title"] == ["揽宝.复盘 | 揽宝投研"]
    assert m["og:type"] == ["website"]                  # 旧版误写 article
    assert m["twitter:card"] == ["summary_large_image"]  # 旧版被塞成摘要文本
    img = m["og:image"][0]
    # 有情绪卡片图时指向 /cards/latest.png，缺图回退 /img/home-bg.jpg；
    # 两种都合法，关键是绝对 URL、无双斜杠（旧版 //img/ 的 bug）。
    assert img.startswith("https://ten2net.github.io/")
    assert img.endswith(("/cards/latest.png", "/img/home-bg.jpg"))
    assert "//img/" not in img


def test_post_og_meta_is_complete(built):
    _, post = built
    m = _meta(post)
    assert m["og:title"][0] and "每日复盘" in m["og:title"][0]
    assert m["og:type"] == ["article"]
    assert m["twitter:card"] == ["summary_large_image"]
    img = m["og:image"][0]
    assert img.startswith("https://ten2net.github.io/")
    assert "//img/" not in img
    # 文章页应指向当天卡片 /cards/<date>.png（有图时）或回退默认头图
    assert "/cards/" in img or img.endswith("/img/home-bg.jpg")
    assert m["article:published_time"][0].endswith("+08:00")
    assert "&#43;" not in m["article:published_time"][0]  # ISO 8601 的 + 必须原样
    assert m["article:tag"] == ["每日复盘"]


def test_home_jsonld_is_website(built):
    home, _ = built
    blocks = _jsonld(home)
    assert len(blocks) == 1
    d = blocks[0]
    assert isinstance(d, dict)                           # 不能被双重编码成字符串
    assert d["@context"] == "https://schema.org"
    assert d["@type"] == "WebSite"
    assert d["name"] == "揽宝.复盘"
    assert d["url"] == "https://ten2net.github.io/"
    assert d["publisher"]["@type"] == "Organization"
    # 站点没有可用搜索页时不应捏造指向 404 的 SearchAction
    assert "potentialAction" not in d


def test_post_jsonld_is_blogposting(built):
    _, post = built
    blocks = _jsonld(post)
    assert len(blocks) == 1
    d = blocks[0]
    assert isinstance(d, dict)
    assert d["@type"] == "BlogPosting"
    assert d["headline"] and "每日复盘" in d["headline"]
    assert d["datePublished"].endswith("+08:00")
    assert d["dateModified"].endswith("+08:00")
    assert d["author"]["@type"] == "Organization"
    assert d["publisher"]["@type"] == "Organization"
    assert d["mainEntityOfPage"]["@id"] == d["url"]
    assert d["image"].startswith("https://ten2net.github.io/")
    assert "keywords" in d


def test_feed_autodiscovery_still_present(built):
    """SEO 整改不能弄丢上一轮修好的订阅源自动发现链接。"""
    home, _ = built
    links = re.findall(r'<link rel="alternate"[^>]*>', home)
    assert any("rss.xml" in l for l in links)
    assert any("atom.xml" in l for l in links)
    assert any("index.xml" in l for l in links)


def test_card_image_wiring_and_fallback(tmp_path):
    """og-image.html partial：有卡片→指向它（首页 latest / 文章当天），缺图→回退头图。"""
    import re
    import shutil
    from PIL import Image
    from review_agent import blog_publish as bp

    hugo = _hugo()
    if not hugo:
        pytest.skip("没有 hugo")
    site = tmp_path / "blog"
    shutil.copytree(ROOT / "blog", site, ignore=shutil.ignore_patterns("public", "resources"))
    cards = site / "static" / "cards"
    shutil.rmtree(cards, ignore_errors=True)
    cards.mkdir(parents=True)
    # 造一张 latest.png 和一篇对应日期的卡片（内容随意，只要文件存在）
    Image.new("RGB", (1200, 630), (20, 20, 28)).save(cards / "latest.png")

    def build_og():
        out = tmp_path / ("out" + str(len(list(tmp_path.glob("out*")))))
        bp.build(site, hugo=hugo, dest_dir=out)
        home = (out / "index.html").read_text(encoding="utf-8")
        post = next((out / "post").glob("*/index.html")).read_text(encoding="utf-8")
        def og(html):
            return re.search(r'og:image" content="([^"]+)', html).group(1)
        return og(home), og(post)

    home_img, post_img = build_og()
    assert home_img == "https://ten2net.github.io/cards/latest.png"
    # 文章当天没生成卡片 → 回退默认头图（不指向 404）
    assert post_img == "https://ten2net.github.io/img/home-bg.jpg"

    # 补上所有文章日期的卡片后再构建，文章应指向 /cards/<date>.png
    for f in (site / "content" / "post").glob("*-每日复盘.md"):
        m = re.search(r"date: (\d{4}-\d{2}-\d{2})", f.read_text(encoding="utf-8"))
        if m:
            Image.new("RGB", (1200, 630), (20, 20, 28)).save(cards / f"{m.group(1)}.png")
    home_img2, post_img2 = build_og()
    assert home_img2 == "https://ten2net.github.io/cards/latest.png"
    assert re.match(r"https://ten2net\.github\.io/cards/\d{4}-\d{2}-\d{2}\.png$", post_img2)
