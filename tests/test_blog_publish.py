"""Hugo 博客发布：文章 md、公开闸门、构建与同步。"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from review_agent import blog_publish as bp

DATE = "2026-09-23"
ROOT = Path(__file__).resolve().parents[1]


def payload(**over):
    base = {
        "target_date": DATE, "data_as_of": DATE + " 收盘", "generated_at": "2026-09-23 20:23 CST",
        "warnings": [],
        "focus": {"emotion_phase": "退潮", "market_oneliner": "情绪档位判为退潮。",
                  "focus_directions": [], "risk_alerts": [], "verification_items": []},
        "focus_md": ("# 盘面研判\n\n情绪档位：退潮 [ev-ce37954f134961b04ccb]\n\n"
                     "风险：样本内有炸板。  ## 华字辈概念\n\n题材串家数领先。\n\n"
                     "## 本次输入依据\n\n输入片段已核对。\n\n"
                     "ev-ce37954f134961b04ccb · 派生情绪指标 · 2026-09-23\n\n<pre>· 情绪周期 10 日</pre>"),
        "emotion_metrics": {
            "money_effect": {"available": True, "avg": -0.37, "median": -1.81, "positive_rate": 0.397},
            "promotion": {"available": True, "prev_limit_up_count": 63, "overall": {"rate": 0.19, "promoted": 12}},
            "ladder_gap": {"highest": 4},
        },
        "market_facts": {"breadth": {"up": 1757, "down": 3366, "universe": 5556}},
        "macro_sector": "", "reflection": None,
        "analysts": [{"key": "sentiment", "title": "情绪面", "html": "<p>接力转弱。</p><p>反证见上。</p>"}],
        "job_id": "d200b54a2f5d425fbf733b054e84ded9", "ai_source": {"provider": "codebuddy"},
    }
    base.update(over)
    return base


def lib(tmp_path: Path, *items):
    d = tmp_path / "reviews"
    d.mkdir(parents=True, exist_ok=True)
    for date, data in items:
        (d / f"{date}.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return d


def site_dir(tmp_path: Path):
    d = tmp_path / "blog"
    (d / "content" / "post").mkdir(parents=True)
    return d


class TestPost:
    def test_front_matter_and_body(self):
        md = bp.post_markdown(payload(), DATE)
        assert md.startswith("---\n")
        assert 'title: "2026-09-23 每日复盘 · 情绪档位退潮"' in md
        assert "date: 2026-09-23T20:23:00+08:00" in md
        assert 'tags: ["每日复盘"]' in md and "draft: false" in md
        assert 'class="va-stat"' in md and "汇总研判" in md and "情绪面" in md
        assert "1757 / 3366" in md and "上涨占比 34.3%" in md

    def test_citations_stripped_and_evidence_folded(self):
        md = bp.post_markdown(payload(), DATE)
        body = md.split("---", 2)[2]
        head = body.split("本次输入依据")[0]
        assert "[ev-ce37954f134961b04ccb]" not in head
        assert "<details" in body and "派生情绪指标" in body

    def test_glued_subheading_split(self):
        md = bp.post_markdown(payload(), DATE)
        # 报告里的小标题常粘在上一段末尾，转换后要单独成块并转成标题
        assert "<h3>华字辈概念</h3>" in md

    def test_headings_are_nested_under_section(self):
        md = bp.post_markdown(payload(), DATE)
        # 正文里的一级标题压到 h2 以下：页面已经有 h1
        assert "<h1>" not in md.split("<section", 1)[-1]
        assert "<h3>盘面研判</h3>" in md

    def test_missing_readings_not_zero(self):
        md = bp.post_markdown(payload(market_facts={}, emotion_metrics={}), DATE)
        assert "未取得" in md and "0 / 0" not in md

    def test_runtime_metadata_absent(self):
        md = bp.post_markdown(payload(), DATE)
        assert "d200b54a2f5d425fbf733b054e84ded9" not in md and "codebuddy" not in md


class TestWriteSources:
    def test_writes_one_file_per_date(self, tmp_path):
        site, reviews = site_dir(tmp_path), lib(tmp_path, (DATE, payload()))
        written, skipped = bp.write_sources(site, reviews, [DATE])
        assert written == ["2026-09-23-每日复盘.md"]
        assert (site / "content" / "post" / written[0]).exists()
        assert bp.write_sources(site, reviews, [DATE])[0] == []      # 幂等

    def test_blocked_report_not_written(self, tmp_path):
        site = site_dir(tmp_path)
        reviews = lib(tmp_path, (DATE, payload(focus_md="# x\n\n明日建议买入中际旭创。\n")))
        written, skipped = bp.write_sources(site, reviews, [DATE])
        assert written == [] and skipped == [DATE]

    def test_dropped_date_removes_its_post(self, tmp_path):
        site, reviews = site_dir(tmp_path), lib(tmp_path, (DATE, payload()))
        bp.write_sources(site, reviews, [DATE])
        (reviews / f"{DATE}.json").write_text("{}", encoding="utf-8")
        written, skipped = bp.write_sources(site, reviews, [])
        assert not (site / "content" / "post" / "2026-09-23-每日复盘.md").exists()


class TestSync:
    def _tree(self, tmp_path):
        pub = tmp_path / "public"
        (pub / "post" / "2026-09-23").mkdir(parents=True)
        (pub / "index.html").write_text("home", encoding="utf-8")
        (pub / "post" / "2026-09-23" / "index.html").write_text("post", encoding="utf-8")
        (pub / "css").mkdir(); (pub / "css" / "x.css").write_text("x", encoding="utf-8")   # 不归我们管
        repo = tmp_path / "repo"
        (repo / "2016").mkdir(parents=True); (repo / "2016" / "old.html").write_text("old", encoding="utf-8")
        (repo / "post" / "stale").mkdir(parents=True); (repo / "post" / "stale" / "index.html").write_text("s", encoding="utf-8")
        (repo / bp.MANIFEST).write_text(json.dumps({"files": ["post/stale/index.html"]}), encoding="utf-8")
        return pub, repo

    def test_copies_owned_and_keeps_site_files(self, tmp_path):
        pub, repo = self._tree(tmp_path)
        changed, removed = bp.sync_public(pub, repo)
        assert "index.html" in changed and "post/2026-09-23/index.html" in changed
        assert "css/x.css" in changed                         # 主题样式要跟着发，否则线上裸 HTML
        assert (repo / "2016" / "old.html").exists()          # 站上原有文件不动
        assert not (repo / "post" / "stale" / "index.html").exists()   # 旧的自有页面清掉
        assert bp.sync_public(pub, repo) == ([], [])          # 幂等

    def test_refuses_unsafe_manifest_paths(self, tmp_path):
        pub, repo = self._tree(tmp_path)
        (repo / bp.MANIFEST).write_text(json.dumps({"files": ["../escape.html"]}), encoding="utf-8")
        changed, removed = bp.sync_public(pub, repo)
        assert removed == []


class TestBuild:
    def test_build_real_theme(self, tmp_path):
        if not (ROOT / ".local" / "bin" / "hugo").exists() and not shutil.which("hugo"):
            pytest.skip("没有 hugo")
        site = tmp_path / "blog"
        shutil.copytree(ROOT / "blog", site, ignore=shutil.ignore_patterns("public", "resources"))
        for f in (site / "content" / "post").glob("*.md"):
            f.unlink()
        bp.write_sources(site, lib(tmp_path, (DATE, payload())), [DATE])
        pages = bp.build(site)
        assert pages > 0
        post = next((site / "public" / "post").glob("*/index.html")).read_text(encoding="utf-8")
        assert "2026-09-23 每日复盘" in post and "<details" in post and "va-stat" in post
        home = (site / "public" / "index.html").read_text(encoding="utf-8")
        # 首页文章列表由主题渲染，类名随主题变化；断言「文章出现在首页」即可
        assert "2026-09-23 每日复盘" in home



class TestLegacyCleanup:
    def test_removes_only_own_legacy_paths(self, tmp_path):
        repo = tmp_path / "repo"
        (repo / "reviews" / "all").mkdir(parents=True); (repo / "reviews" / "all" / "index.html").write_text("x", encoding="utf-8")
        (repo / "year" / "2026").mkdir(parents=True); (repo / "year" / "2026" / "index.html").write_text("x", encoding="utf-8")
        (repo / "astock-feed.xml").write_text("x", encoding="utf-8")
        (repo / "deploy.json").write_text("x", encoding="utf-8")
        (repo / "2016" / "old").mkdir(parents=True); (repo / "2016" / "old" / "index.html").write_text("keep", encoding="utf-8")
        (repo / "post" / "mine").mkdir(parents=True); (repo / "post" / "mine" / "index.html").write_text("keep", encoding="utf-8")
        removed = bp.remove_legacy_dirs(repo)
        assert "reviews/" in removed and "deploy.json" in removed
        assert not (repo / "reviews").exists() and not (repo / "astock-feed.xml").exists()
        assert (repo / "2016" / "old" / "index.html").exists()
        assert (repo / "post" / "mine" / "index.html").exists()



class TestVisualBlocks:
    def test_feedback_matrix_has_cells_and_rate(self):
        p = payload()
        p["market_facts"] = {"feedback_matrix": {"available": True, "sample": 55, "coverage_rate": 1.0,
                                                  "result_order": ["晋级涨停", "收红", "跌停"],
                                                  "matrix": {"首板": {"合计": 10, "晋级涨停": 3, "收红": 2, "跌停": 1, "晋级率": 0.3}},
                                                  "note": "口径"}}
        html_text = bp._block_feedback(p["market_facts"])
        assert "va-table" in html_text and "首板" in html_text and "30.0%" in html_text
        assert html_text.count("<td") >= 6 and "<td><td" not in html_text

    def test_money_blocks_respect_red_up_green_down(self):
        p = payload()
        p["emotion_metrics"] = {"money_effect": {"available": True, "avg": -1.2, "median": -0.8, "positive_rate": 0.4, "sample": 50},
                                 "consec_premium": {"available": True, "avg": 1.0, "median": 0.5, "positive_rate": 0.6, "sample": 20}}
        p["market_facts"] = {"loss_effect": {"available": True, "deep_loss_5_rate": 0.2, "deep_loss_5_count": 10,
                                                "deep_loss_7_count": 4, "limit_down_count": 2, "market_limit_down": 9,
                                                "worst": -10.0, "sample": 50},
                             "seal_quality": {"available": True, "never_broken": 20, "total": 40, "never_broken_rate": 0.5,
                                                "broken_pool": 20, "avg_broken_times": 1.5, "ever_opened_rate": 0.5, "late_seal": 3,
                                                "opening_seconds": 15}}
        html_text = bp._block_money(p)
        assert 'class="down">-1.20%' in html_text          # 跌用绿色类
        assert 'class="up">+0.50%' in html_text            # 涨用红色类
        assert "未取得" not in html_text

    def test_ladder_marks_gap(self):
        p = payload()
        p["emotion_metrics"] = {"ladder_gap": {"tiers": {"2": 8, "3": 0, "4": 3}, "highest": 4,
                                                "continuous": False, "note": "板位缺档 3板"}}
        html_text = bp._block_ladder(p)
        assert "va-ladder" in html_text and "va-col gap" in html_text and "板位缺档" in html_text

    def test_trend_renders_one_chart_per_metric(self):
        p = {"market_facts": {"trend": {
            "days": ["2026-10-26", "2026-10-27"],
            "metrics": [
                {"key": "limit_up", "label": "涨停家数", "kind": "count", "higher_is_hotter": True,
                 "unit": "家", "values": [55, 41]},
                {"key": "broken_rate", "label": "炸板率", "kind": "rate", "higher_is_hotter": False,
                 "values": [0.29, 0.41]},
            ],
        }}}
        html_text = bp._block_trend(p)
        # 每个指标一张卡，日期轴在左、最新日期在上
        assert html_text.count('class="va-hb-card"') == 2
        assert "涨停家数" in html_text and "越低越热" in html_text and "单位 家" in html_text
        assert html_text.index(">10-27<") < html_text.index(">10-26<")
        # 柱长按本指标峰值缩放：55 撑满、41 按比例
        assert "width:100.0%" in html_text and "width:74.5%" in html_text
        # 只有最新一天高亮
        assert html_text.count("va-hb-row last") == 2
    def test_post_contains_all_sections(self):
        md = bp.post_markdown(payload(), DATE)
        for title in ("较前一交易日", "昨日强势股反馈", "赚钱效应与亏钱效应", "晋级率", "梯队结构",
                      "题材结构与题材事件树", "最近几天怎么走的", "汇总研判"):
            assert title in md, title

    def test_margin_renders_20_day_bars(self):
        days = [f"2026-09-{d:02d}" for d in range(1, 21)]
        values = [25000.0 + i * 20 for i in range(20)]
        dist = {"margin": {"date": "2026-09-20", "days": days, "values": values, "balance": values[-1]}}
        html_text = bp._block_margin(dist)
        assert html_text.count("va-hb-row") == 20
        assert "近 20 个交易日两融余额" in html_text and "25,380" in html_text
        # 日期轴在左、最新在上
        assert html_text.index(">09-20<") < html_text.index(">09-01<")
        # 余额升降用颜色标：最高一天在最上面（无上一日）用 flat，往下逐日递减都是 down
        assert "va-hb-flat" in html_text and html_text.count("va-hb-down") >= 18

    def test_margin_net_renders_20_day_bars(self):
        days = [f"2026-09-{d:02d}" for d in range(1, 21)]
        nets = [100.0, -50.0, 0.0] + [10.0] * 17
        html_text = bp._block_margin({"margin": {
            "date": "2026-09-20", "days": days, "values": [25000.0] * 20,
            "net_values": nets, "balance": 25000.0}})
        assert "近 20 个交易日融资净买入" in html_text
        assert html_text.count("va-hb-card") == 2 and html_text.count("va-hb-row") == 40
        # 正数红（up）、负数绿（down），带符号显示
        assert "+100" in html_text and "-50" in html_text
        assert "va-hb-up" in html_text and "va-hb-down" in html_text
        assert "20 日合计" in html_text

    def test_margin_unavailable_says_reason(self):
        assert "未获取" in bp._block_margin({})

    def test_missing_blocks_say_so(self):
        assert "未取到" in bp._block_feedback({})
        assert "未取到" in bp._block_ladder({"emotion_metrics": {}})
        assert "未取到" in bp._block_trend({})



class TestV1Parity:
    """对照 v1 复盘页：v1 有的分析区块，博客文章都要有对应的一块。"""

    V1_SECTIONS = {
        "市场状态": ("市场广度", "较前一交易日"),
        "短线情绪": ("昨日强势股反馈", "赚钱效应与亏钱效应", "晋级率", "梯队结构", "连板股"),
        "封板质量": ("炸板与封板结构",),
        "题材": ("题材结构与题材事件树",),
        "中长线": ("最近几天怎么走的",),
        "事件": ("当日事件串",),
    }

    def test_every_v1_block_has_a_section(self):
        md = bp.post_markdown(payload(), DATE)
        for v1_name, sections in self.V1_SECTIONS.items():
            for title in sections:
                assert title in md, (v1_name, title)

    def test_breadth_and_seal_blocks(self):
        p = payload()
        p["market_facts"]["breadth"] = {"available": True, "up": 3200, "down": 1900, "flat": 60,
                                        "universe": 5200, "amount_yi": 14608.2,
                                        "deep_up_5_incl": 120, "deep_down_5": 890}
        p["market_facts"]["seal_quality"] = {"available": True, "total": 40, "broken_pool": 10,
                                             "broken_rate": 0.25, "never_broken": 25, "reopened": 10,
                                             "avg_broken_times": 1.5, "late_seal": 4}
        html_text = bp._block_breadth(p)
        assert "上涨 / 下跌" in html_text and "两市成交额" in html_text and "3200" in html_text
        seal = bp._block_seal(p)
        assert "封板率" in seal and "75.0%" in seal and "尾盘回封" in seal
    def test_lianban_lists_multi_board_first(self):
        p = {"market_facts": {"theme_tree": {"themes": [{"tag": "T", "members": [
            {"code": "1", "name": "AAA", "boards": 1, "first_seal": "0930"},
            {"code": "2", "name": "BBB", "boards": 3, "first_seal": "0950"},
        ]}]}}}
        html_text = bp._block_lianban(p)
        assert "BBB" in html_text and "3 板" in html_text
        assert "AAA" not in html_text  # 只列连板（2 板及以上）



class TestExternalBlocks:
    def test_distribution_renders_horizontal_bars(self):
        dist = {"available": True, "labels": ["跌停", "平", "涨停"], "counts": [10, 100, 30], "total": 140, "reason": ""}
        html_text = bp._block_distribution(dist)
        assert 'class="va-hist"' in html_text and "140" in html_text
        assert "va-hist-down" in html_text and "va-hist-up" in html_text
        # 档位标签在左当纵轴，柱长按峰值归一：最大值 100 撑满 100%，其余按比例
        assert "<em>跌停</em>" in html_text and "width:100.0%" in html_text
        assert "width:10.0%" in html_text and "width:30.0%" in html_text

    def test_distribution_unavailable_says_reason(self):
        assert "未获取" in bp._block_distribution({"available": False, "reason": "没有 TUSHARE_TOKEN"})

    def test_index_and_overseas_blocks(self):
        idx = {"rows": [{"name": "上证指数", "price": 3669.48, "change_pct": 0.58}], "reason": ""}
        ov = {"indices": [{"name": "纳斯达克", "price": 26477.81, "change_pct": 1.18, "region": "美股", "session": "2026-10-27"}]}
        html_text = bp._block_index(idx, ov)
        assert "上证指数" in html_text and "+0.58%" in html_text
        assert "纳斯达克" in html_text and "交易日 2026-10-27" in html_text
        assert "中长期位置" in html_text      # 指回上面那块历史区间

    def test_capital_parses_archive_text(self):
        capital = "\n".join([
            "行业主力净流入 TOP：",
            "  银行 今75.39亿/5日缺 涨1.34% 领涨沪农商行",
            "行业主力净流出 TOP：",
            "  半导体 今-93.77亿",
            "全市场成交额 TOP：",
            "  中际旭创 140.11亿 涨-2.94%",
            "（口径提示：取数前后参考行情均对应 2026-10-27 收盘）",
        ])
        dragon = "  大洋电机 净买+3.01亿 [日涨幅偏离值达到7%的前5只证券]"
        html_text = bp._block_capital(capital, dragon)
        assert "银行 · 净流入" in html_text and "+75.39 亿" in html_text
        assert "半导体 · 净流出" in html_text and "-93.77 亿" in html_text
        assert "中际旭创" in html_text and "大洋电机" in html_text
        assert "口径提示" not in html_text      # 口径行不该被当成数据

    def test_margin_block(self):
        html_text = bp._block_margin({"margin": {"balance": 16000.5, "date": "2026-10-27"}})
        assert "两融余额" in html_text and "16,000 亿" in html_text
        assert "未获取" in bp._block_margin({})

    def test_tier_tiers_uses_previous_day(self):
        today = {"market_facts": {
            "day_diff": {"prev_date": "2026-10-26"},
            "theme_structure": {"themes": [
                {"sector": "汽车零部", "limit_up": 8, "highest": 4, "first_seal": "093003"},
                {"sector": "新板块", "limit_up": 3, "highest": 2, "first_seal": "100000"},
                {"sector": "零散", "limit_up": 2, "highest": 1, "first_seal": "101500"},
                {"sector": "单只", "limit_up": 1, "highest": 1, "first_seal": "140000"},
            ]},
        }}
        prev = {"2026-10-26": {"market_facts": {"theme_structure": {"themes": [
            {"sector": "汽车零部", "limit_up": 5},
        ]}}}}
        html_text = bp._block_tier_tiers(today, prev)
        assert "连续集中" in html_text and "今天集中" in html_text
        assert "零散" in html_text and "单只" in html_text
        assert "2026-10-26" in html_text

    def test_archive_texts_missing_dir_is_empty(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ASTOCK_ARCHIVE_DIR", str(tmp_path / "nope"))
        assert bp.archive_texts("2026-10-27") == {"capital": "", "dragon": ""}



class TestIndexHistory:
    HIST = {"available": True, "rows": [
        {"name": "上证指数", "close": 3648.3, "chg": -1.33, "r5": -2.33, "r20": -7.64, "r60": -5.44,
         "r250": -6.75, "ytd": -8.08, "off_high": -14.01, "ma20": 3778.0, "ma60": 3800.0, "ma250": 3900.0, "reason": ""},
        {"name": "深证成指", "reason": "取数失败：Timeout"},
    ], "reason": ""}

    def test_table_has_all_columns(self):
        html_text = bp._block_index_hist(self.HIST)
        for col in ("5 日", "20 日", "60 日", "250 日", "年初至今", "离一年高点", "均线"):
            assert col in html_text, col
        assert "3,648.30" in html_text and "-14.01%" in html_text
        assert 'class="down"' in html_text                          # 跌用绿色
        assert "20下" in html_text                                      # 收盘在 20 日线下方

    def test_failed_index_row_shows_reason(self):
        html_text = bp._block_index_hist(self.HIST)
        assert "深证成指" in html_text and "取数失败" in html_text

    def test_unavailable_explains(self):
        assert "未获取" in bp._block_index_hist({"available": False, "reason": "没有 TUSHARE_TOKEN", "rows": []})

    def test_post_includes_hist_section(self):
        p = payload()
        md = bp.post_markdown(p, DATE, ext={"hist": self.HIST})
        assert "主要指数 · 中长期位置" in md



class TestPromotion:
    def test_promo_has_two_versions_and_six_features_each(self):
        html_text = bp.promotion_html()
        assert "va-cta" not in html_text and "va-kicker" not in html_text   # 入口按钮与版本标签已去掉
        assert "揽宝投研 V1" in html_text and "揽宝投研 V2" in html_text
        assert html_text.count("va-promo-card") == 2
        assert html_text.count(chr(99) + "lass=" + chr(34) + "va-feat" + chr(34)) == 12   # 6 + 6 张功能卡

    def test_navigation_links_follow_nav(self):
        html_text = bp.promotion_html()
        # 每张卡的标题与路径都要和对应版本侧栏一致
        v1_paths = [path for _i, _n, _t, path in bp.V1_FEATURES]
        v2_paths = [path for _i, _n, _t, path in bp.V2_FEATURES]
        assert v1_paths == ["/agent/review", "/first-board", "/yesterday-ladder",
                           "/agent/intraday", "/backtest", "/journal"]
        assert v2_paths == ["/watch", "/watch/intraday", "/shortline", "/debate", "/research", "/backtest"]
        for path in v1_paths:
            assert bp.V1_ORIGIN + path in html_text, path
        for path in v2_paths:
            assert bp.V2_ORIGIN + path in html_text, path
        assert "github.com" not in html_text
        assert html_text.count(chr(34) + "noopener" + chr(34)) == 12   # 只有 12 张功能卡

    def test_promo_uses_no_trade_language(self):
        # 固定免责声明里有「不推荐个股」，那是产品口径；这里只查两块卡片正文
        from review_agent.product_policy import has_trade_recommendation
        html_text = bp.promotion_html()
        cards = html_text.split('va-promo">', 1)[1].split('va-promo-foot', 1)[0]
        assert not has_trade_recommendation(cards)

    def test_promo_in_every_post(self):
        md = bp.post_markdown(payload(), DATE)
        assert md.rstrip().endswith("</section>") and "揽宝投研 V1" in md.split("本次输入依据")[-1]



class TestParagraphMarkup:
    def test_section_wraps_paragraphs_and_headings(self):
        html_text = bp._section("测试", ["第一段。", "## 小标题", "第二段。"])
        assert "<p>第一段。</p>" in html_text and "<p>第二段。</p>" in html_text
        assert "<h2>小标题</h2>" in html_text
        assert "## 小标题" not in html_text

    def test_analyst_paragraphs_are_separate(self):
        p = payload()
        md = bp.post_markdown(p, DATE)
        start = md.index(">情绪面<")
        seg = md[start:md.index("</section>", start)]
        assert seg.count("<p>") == 2      # 原 HTML 两段 → 两个 <p>

    def test_report_headings_become_h3(self):
        # 汇总研判里的 # 与 ## 都当正文小标题：统一三级，不和分区 h2 抢
        assert bp._text_to_md("# 盘面研判\n\n正文。").startswith("### 盘面研判")
        assert bp._text_to_md("## 二级\n\n正文。").startswith("### 二级")

    def test_inline_bold_and_code(self):
        html_text = bp._section("x", ["**粗** 和 `码`"])
        assert "<strong>粗</strong>" in html_text and "<code>码</code>" in html_text



class TestRenderedBlocks:
    def test_prebuilt_html_blocks_pass_through(self):
        # 晋级率/题材是程序拼好的整块 HTML：不能再被 _md_blocks 转义成源码
        for part in ('<div class="va-table-wrap">表格</div>', "<p>段落</p>", "<span>x</span>",
                     "<section>y</section>", "<table><tr><td>c</td></tr></table>"):
            html_text = bp._section("t", [part])
            assert "&lt;" not in html_text, part
            assert part in html_text, part

    def test_plain_text_still_wrapped(self):
        html_text = bp._section("t", ["普通一段。"])
        assert "<p>普通一段。</p>" in html_text

    def test_no_escaped_html_in_real_post(self):
        p = payload()
        p["market_facts"] = {
            "theme_structure": {"concentration": 0.2, "theme_count": 2, "timeline": [], "themes": [
                {"sector": "汽车零部", "limit_up": 8, "highest": 4, "broken": 2, "broken_rate": 0.25, "first_seal": "093003"}]},
        }
        md = bp.post_markdown(p, DATE)
        seg = md[md.index("题材结构与题材事件树"):]
        assert "&lt;p class" not in seg and "&lt;table" not in seg
        assert "<table class=\"va-table\">" in seg



class TestLianbanTable:
    def test_first_seal_is_formatted_as_time(self):
        assert bp._hhmmss("093026") == "09:30:26"
        assert bp._hhmmss("0930") == "09:30"
        assert bp._hhmmss("") == "—" and bp._hhmmss(None) == "—"

    def test_lianban_columns_aligned(self):
        p = {"market_facts": {"theme_tree": {"themes": [{"tag": "T", "members": [
            {"code": "1", "name": "AAA", "boards": 3, "first_seal": "093026", "broken_times": 2}]}]}}}
        html_text = bp._block_lianban(p)
        assert "09:30:26" in html_text and "093026" not in html_text
        # 连板 / 首封 / 开板次数 居中，其余（个股、板位标签、题材）左对齐
        assert html_text.count('class="va-al-center"') == 3
        assert "va-al-left" not in html_text

    def test_table_align_param(self):
        html_text = bp._table(["a", "b"], [["x", "y"]], align={1: "right"})
        assert '<th class="va-al-right">b</th>' in html_text
