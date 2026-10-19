"""宏观概率(第 18 层)的单测。全程不联网(`_get` 一律 monkeypatch)。

覆盖的是 Codex prob-r1 打出来的四条 P1 与几条 P2 —— 每条都写清楚**为什么**,
免得日后有人"顺手简化"又把同一个洞挖回来。
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sources import probability as P  # noqa: E402

NOW = datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc)
TODAY = "2026-08-24"
CTX = {"script": "macro_probability", "symbol": "300308", "market": "SZ", "source": "prediction-markets",
       "endpoint": "kalshi+polymarket", "as_of": None, "raw_ref": None, "args": {}}


# ---------- P1:Polymarket 必须把 outcomes 与 outcomePrices 配对 ----------

def _poly_row(**kw):
    base = {"question": "Will the Fed cut rates in December?", "endDate": "2026-12-15",
            "volume24hr": "5000", "volume": "90000", "slug": "fed-dec"}
    base.update(kw)
    return base


def test_polymarket_structured_sports_metadata_overrides_title_substrings():
    """球队名 Borussia 内含 `russia`，纯子串分类会把德甲比赛误归为地缘政治。
    Polymarket 已给出 sportsMarketType / gameStartTime，这类结构化体育标记必须优先。"""
    out, dropped = [], {}
    row = _poly_row(
        question="Will BV Borussia 09 Dortmund win on 2026-08-29?",
        endDate="2026-08-29",
        outcomes='["Yes","No"]',
        outcomePrices='["0.87","0.13"]',
        sportsMarketType="moneyline",
        gameStartTime="2026-08-29 16:30:00+00",
        events=[{"gameId": 90118301, "seriesSlug": "bundesliga-2025"}],
    )
    P._poly_shape([row], TODAY, dropped, out, "raw/sports.json", "2026-08-24T12:00:00Z")
    assert out == []


def test_polymarket_takes_the_yes_leg_not_the_first_price():
    """🔴 `outcomes` 顺序**不保证**是 ["Yes","No"]。直接拿 `outcomePrices[0]` 当事件概率,
    顺序一反报出去的就是**反向概率** —— 一个静默的错误数字(Codex prob-r1 P1)。"""
    out, dropped = [], {}
    P._poly_shape([_poly_row(outcomes='["No","Yes"]', outcomePrices='["0.73","0.27"]')],
                  TODAY, dropped, out, "raw/p1.json", "2026-08-24T12:00:00Z")
    assert len(out) == 1
    assert out[0]["prob"] == pytest.approx(0.27)      # 取 Yes 腿,不是第一个价格
    assert out[0]["leg"] == "Yes"


def test_polymarket_drops_when_no_yes_leg_or_shape_drifts():
    """认不出 Yes 腿、或两个数组对不上 —— **不许猜**,丢弃并计数(计数让它可见,不是静默)。"""
    out, dropped = [], {}
    P._poly_shape([_poly_row(outcomes='["Above","Below"]', outcomePrices='["0.6","0.4"]')],
                  TODAY, dropped, out, "raw/p.json", "2026-08-24T12:00:00Z")
    assert out == [] and dropped.get("no_yes_leg") == 1
    out2, dropped2 = [], {}
    P._poly_shape([_poly_row(outcomes='["Yes","No"]', outcomePrices='["0.6"]')],
                  TODAY, dropped2, out2, "raw/p.json", "2026-08-24T12:00:00Z")
    assert out2 == [] and dropped2.get("outcome_shape_drift") == 1


# ---------- P1:每条 item 必须带**装着它的那次响应**的 raw_ref ----------



# ---------- P1:价格口径要有标识 ----------

def test_kalshi_price_type_is_recorded_not_silently_mixed():
    """ask 与 last 是两种口径。回退可以(否则久未成交的合约全丢),但**必须标出来** ——
    没有标识就无法跨合约比较,读者也不知道这是报价还是成交(prob-r1 P1)。"""
    leg_ask = P._pick_leg([{"yes_ask_dollars": "0.62", "ticker": "T1"}])
    assert leg_ask["_price_type"] == "ask" and leg_ask["_prob"] == pytest.approx(0.62)
    leg_last = P._pick_leg([{"last_price": "45", "ticker": "T2"}])       # 分 → 元
    assert leg_last["_price_type"] == "last" and leg_last["_prob"] == pytest.approx(0.45)




# ---------- P1:上游 warnings 不能被丢掉 ----------



# ---------- P2:缺字段 ≠ 真实零 ----------



# ---------- P2:截断要出声 ----------

def test_pagination_truncation_is_announced(monkeypatch):
    """静默截断会让"没有符合条件的合约"看起来像事实。翻满上限还有下一页 → 必须出声。"""
    page = json.dumps({"events": [], "cursor": "MORE"}).encode()
    monkeypatch.setattr(P, "_get", lambda *a, **k: page)
    monkeypatch.setattr(P, "record_raw", lambda *a, **k: "raw/k.json")
    monkeypatch.setattr(P, "_kalshi_macro_series", lambda *a, **k: ([], None, False))
    _out, warns, _ref, _complete = P._kalshi(TODAY, {})
    assert any("仍有下一页" in w for w in warns)


# ---------- P2:定向路径的结构漂移不许当空数组 ----------

def test_targeted_path_structure_drift_is_not_treated_as_empty(monkeypatch):
    """"字段没了就当空数组"会把结构漂移伪装成"没数据" —— 异常要**正向识别**。"""

    def fake_get(url, params=None, **k):
        if params and params.get("series_ticker"):
            return json.dumps({"data": []}).encode()          # events 字段没了
        return json.dumps({"events": []}).encode()

    monkeypatch.setattr(P, "_get", fake_get)
    monkeypatch.setattr(P, "record_raw", lambda *a, **k: "raw/k.json")
    monkeypatch.setattr(P, "_kalshi_macro_series", lambda *a, **k: (["FED"], "raw/s.json", False))
    _out, warns, _ref, _complete = P._kalshi(TODAY, {})
    assert any("结构变了" in w for w in warns)


# ---------- P2:as_of 是完整时刻 ----------

def test_as_of_is_a_timestamp_not_just_a_date(monkeypatch):
    """"概率只在 as_of 那一刻成立"这句声称,要有一个真的时刻来兑现。
    ⚠️ 运行级 as_of 是**取数完成时刻**(不是开工时刻),另有 fetch_started 留档。"""
    monkeypatch.setattr(P, "_kalshi", lambda t, d: ([], [], None, True))
    monkeypatch.setattr(P, "_polymarket", lambda t, d: (
        [{"module": "货币政策", "venue": "polymarket", "title": "T", "leg": "Yes", "prob": 0.5,
          "price_type": "outcome_price", "volume": 1.0, "volume_total": 1.0, "open_interest": 0.0,
          "ticker": "t", "close": "2026-12-15", "as_of": TODAY, "raw_ref": "raw/p.json"}], [], "raw/p.json", True))
    got = P.macro_probability(now=NOW)
    assert got["fetch_started"] == "2026-08-24T12:00:00Z" and got["today"] == TODAY
    assert got["as_of"].endswith("Z") and len(got["as_of"]) == 20      # 完成时刻,不是传入的 NOW


# ---------- 筛选边界 ----------

@pytest.mark.parametrize("close,v24,vtot,oi,expect", [
    ("2026-08-23", 100, 100, 0, "expired"),                  # 已过期
    ("2026-08-25", 0, 0, 0, "dead"),                          # 近端但完全没人
    ("2026-08-25", 0, 5, 0, None),                            # 近端允许安静(有历史量)
    ("2029-08-24", 0, 999, 999, "far_dated"),                 # 超出视野
    ("2027-06-01", 0, 999, 999, "far_illiquid"),              # 远期必须有当日成交
    ("2027-06-01", 1, 0, 0, None),                            # 远期有量就收
    ("", 0, 0, 5, None),                                      # 缺日期 ≠ 远期,靠流动性判
])
def test_keep_contract_boundaries(close, v24, vtot, oi, expect):
    """近端允许安静、远期必须有人在交易。纯日期窗口会误杀有意义的远期宏观合约,
    纯流动性又留不住 2099 年的僵尸盘。"""
    assert P.keep_contract(close, TODAY, v24, vtot, oi) == expect


# ---------- prob-r2:两个数组都缺失也不许猜 ----------

def test_polymarket_does_not_guess_from_last_trade_price():
    """🔴 我自己定了"认不出 Yes 就不猜",却在两个数组都缺失时留了 lastTradePrice 回退 ——
    那个价格无法证明属于 Yes 腿,报出去就是一个**方向不明**的概率(Codex prob-r2 P1)。"""
    out, dropped = [], {}
    P._poly_shape([_poly_row(lastTradePrice="0.61")], TODAY, dropped, out, "raw/p.json", "2026-08-24T12:00:00Z")
    assert out == [] and dropped.get("outcome_shape_drift") == 1


# ---------- prob-r2:发现阶段结构漂移不许静默返回空 ----------

def test_series_discovery_drift_is_not_silent(monkeypatch):
    """/series 结构漂移若静默变成"没有匹配项",定向循环一次都不跑、一个 warning 也没有,
    宏观经济模块整块消失而 status 还是 ok(prob-r2 P1)。"""
    monkeypatch.setattr(P, "_get", lambda *a, **k: json.dumps({"data": []}).encode())
    monkeypatch.setattr(P, "record_raw", lambda *a, **k: "raw/s.json")
    with pytest.raises(P.ProbabilityError, match="结构变了"):
        P._kalshi_macro_series([])


def test_tag_discovery_drift_is_not_silent(monkeypatch):
    monkeypatch.setattr(P, "_get", lambda *a, **k: json.dumps({"tags": []}).encode())
    monkeypatch.setattr(P, "record_raw", lambda *a, **k: "raw/t.json")
    with pytest.raises(P.ProbabilityError, match="不是数组"):
        P._poly_macro_tags([])


def test_series_truncation_is_announced(monkeypatch):
    """注释一度写"截断出声由调用方计数",而**调用方根本没数** —— 声称与代码不符。"""
    many = {"series": [{"title": f"CPI report {i}", "ticker": f"T{i}"} for i in range(40)]}
    monkeypatch.setattr(P, "_get", lambda *a, **k: json.dumps(many).encode())
    monkeypatch.setattr(P, "record_raw", lambda *a, **k: "raw/s.json")
    warns = []
    got, _, _trunc = P._kalshi_macro_series(warns)
    assert len(got) == P.KALSHI_MACRO_SERIES_MAX
    assert any("只取前" in w for w in warns)


# ---------- prob-r2:非 UTC 的 now 不能标错 Z ----------

def test_as_of_converts_non_utc_now_to_utc(monkeypatch):
    """🔴 传入带偏移的时间(如 +08:00)时直接追加 Z,会标出一个**错误的时刻**
    —— 08:00+08:00 的 UTC 是 00:00,不是 08:00(Codex prob-r2)。"""
    from datetime import timedelta
    monkeypatch.setattr(P, "_kalshi", lambda t, d: (
        [{"module": "货币政策", "venue": "kalshi", "title": "T", "leg": "", "prob": 0.5,
          "price_type": "ask", "volume": 1.0, "volume_total": 1.0, "open_interest": 0.0,
          "ticker": "t", "close": "2026-12-15", "as_of": TODAY, "raw_ref": "raw/k.json"}], [], "raw/k.json", True))
    monkeypatch.setattr(P, "_polymarket", lambda t, d: ([], [], None, True))
    tz8 = timezone(timedelta(hours=8))
    got = P.macro_probability(now=datetime(2026, 8, 24, 8, 0, 0, tzinfo=tz8))
    assert got["fetch_started"] == "2026-08-24T00:00:00Z" and got["today"] == "2026-08-24"


# ---------- prob-r3:"两个源都失败"必须是真的 ----------

def test_one_source_failing_is_not_reported_as_both_failed(monkeypatch):
    """🔴 判据是**成功的源数**,不是"有没有 item"。一个源报错、另一个成功但当前没有符合条件的
    合约,原先会报"两个预测市场源都失败" —— 那是个假事实(Codex prob-r3 P1)。"""
    def boom(t, d):
        raise RuntimeError("429")
    monkeypatch.setattr(P, "_kalshi", boom)
    monkeypatch.setattr(P, "_polymarket", lambda t, d: ([], ["没有落入核心模块的合约"], "raw/p.json", True))
    got = P.macro_probability(now=NOW)                 # 不该抛
    assert got["items"] == [] and any("429" in e for e in got["errors"])
    monkeypatch.setattr(P, "_polymarket", boom)
    with pytest.raises(P.ProbabilityError, match="两个预测市场源都失败"):
        P.macro_probability(now=NOW)




def test_yes_leg_present_but_unparsable_price_counts_as_no_price():
    """诊断计数要对得上原因:Yes 腿在、只是价格解析不出,不该记成"没有 Yes 腿"。"""
    out, dropped = [], {}
    P._poly_shape([_poly_row(outcomes='["Yes","No"]', outcomePrices='["N/A","0.4"]')],
                  TODAY, dropped, out, "raw/p.json", "2026-08-24T12:00:00Z")
    assert out == [] and dropped.get("no_price") == 1 and "no_yes_leg" not in dropped


# ---------- prob-r4:时间戳跟着请求走,不是跟着行走 ----------

def test_all_items_from_one_response_share_the_request_timestamp(monkeypatch):
    """🔴 逐条 `_stamp()` 会让同一份响应的条目拿到不同时刻,跨午夜时甚至分属两天,
    而注释还写着"它那次请求的时刻" —— 声称与代码不符(Codex prob-r4)。"""
    stamps = iter(["2026-08-24T23:59:59Z", "2026-08-25T00:00:01Z", "2026-08-25T00:00:02Z"])
    monkeypatch.setattr(P, "_stamp", lambda: next(stamps))
    monkeypatch.setattr(P, "_get", lambda *a, **k: b"{}")
    body, fetched = P._get_stamped("u", {})
    out, dropped = [], {}
    P._poly_shape([_poly_row(outcomes='["Yes","No"]', outcomePrices='["0.4","0.6"]', slug="a"),
                   _poly_row(outcomes='["Yes","No"]', outcomePrices='["0.5","0.5"]', slug="b")],
                  TODAY, dropped, out, "raw/p.json", fetched)
    assert len(out) == 2
    assert {i["as_of"] for i in out} == {"2026-08-24T23:59:59Z"}   # 同一次请求 → 同一个时刻


# ---------- prob-r4:一个源失败时不能断言"两个市场都没有" ----------



# ---------- prob-r5:"完整查完" ≠ "没抛异常" ----------

def test_partially_covered_source_is_not_counted_as_complete(monkeypatch):
    """🔴 定向失败只降成 warning,源照常返回 —— 但它**没把该查的查完**,
    不足以支撑"当前没有符合条件的合约"这种断言(Codex prob-r5)。"""
    monkeypatch.setattr(P, "_get", lambda *a, **k: json.dumps({"events": []}).encode())
    monkeypatch.setattr(P, "record_raw", lambda *a, **k: "raw/k.json")

    def boom(_w=None):
        raise RuntimeError("429")

    monkeypatch.setattr(P, "_kalshi_macro_series", boom)
    _out, warns, _ref, complete = P._kalshi(TODAY, {})
    assert complete is False and any("定向取数失败" in w for w in warns)




# ---------- prob-r6:真跑一遍两个源,别全靠 monkeypatch 掉 ----------

def test_polymarket_happy_path_actually_runs(monkeypatch):
    """🔴 `complete` 曾只在"翻满页"分支里赋值,正常路径直接 UnboundLocalError。
    我的测试没抓到,因为它们把 `_polymarket` 整个 patch 掉了 ——
    **至少要有一条测试真的走进这个函数**(Codex prob-r6)。"""
    row = _poly_row(outcomes='["Yes","No"]', outcomePrices='["0.4","0.6"]')
    monkeypatch.setattr(P, "_get", lambda url, params=None, **k:
                        json.dumps([row] if params and "offset" in params and params["offset"] == "0" else []).encode())
    monkeypatch.setattr(P, "record_raw", lambda *a, **k: "raw/p.json")
    monkeypatch.setattr(P, "_poly_macro_tags", lambda *a, **k: ([], False))
    out, _warns, _ref, complete = P._polymarket(TODAY, {})
    assert complete is True and len(out) == 1


def test_kalshi_happy_path_actually_runs(monkeypatch):
    monkeypatch.setattr(P, "_get", lambda *a, **k: json.dumps({"events": []}).encode())
    monkeypatch.setattr(P, "record_raw", lambda *a, **k: "raw/k.json")
    monkeypatch.setattr(P, "_kalshi_macro_series", lambda *a, **k: ([], None, False))
    out, _warns, _ref, complete = P._kalshi(TODAY, {})
    assert complete is True and out == []


def test_discovery_truncation_also_kills_completeness(monkeypatch):
    """少查了一个系列 / 标签,这个源就没资格说"当前没有符合条件的合约"(Codex prob-r6)。"""
    monkeypatch.setattr(P, "_get", lambda *a, **k: json.dumps({"events": []}).encode())
    monkeypatch.setattr(P, "record_raw", lambda *a, **k: "raw/k.json")
    monkeypatch.setattr(P, "_kalshi_macro_series", lambda *a, **k: ([], None, True))   # 发现阶段被截断
    _out, _warns, _ref, complete = P._kalshi(TODAY, {})
    assert complete is False


# ---------- prob-r7:状态文案不能自相矛盾 ----------



def test_page_full_but_few_matches_does_not_claim_a_cap_was_applied(monkeypatch):
    """满 1000 条但只匹配出 5 个时,5 个全取了 —— 写"只取前 12 个"是假描述。"""
    rows = {"series": [{"title": f"CPI report {i}", "ticker": f"T{i}"} for i in range(5)]
                      + [{"title": "irrelevant", "ticker": f"X{i}"} for i in range(995)]}
    monkeypatch.setattr(P, "_get", lambda *a, **k: json.dumps(rows).encode())
    monkeypatch.setattr(P, "record_raw", lambda *a, **k: "raw/s.json")
    warns = []
    got, _ref, truncated = P._kalshi_macro_series(warns)
    assert truncated is True and len(got) == 5                      # 覆盖仍算不完整
    assert any("满 1000 条" in w for w in warns)
    assert not any("只取前" in w for w in warns)


# ---------- prob-r8:缺结算日绝不拿取数日顶替 ----------

def test_missing_close_date_is_dropped_not_backfilled_with_today():
    """🔴 `period` 是结构化字段、裁决点直接当"下一个数据点"用。缺结算日时填成今天
    就是**造了一个日期**,note 里写"结算日不详"救不回来(Codex prob-r8)。"""
    out, dropped = [], {}
    row = _poly_row(outcomes='["Yes","No"]', outcomePrices='["0.4","0.6"]')
    row.pop("endDate")
    P._poly_shape([row], TODAY, dropped, out, "raw/p.json", "2026-08-24T12:00:00Z")
    assert out == [] and dropped.get("missing_close") == 1




# ---------- prob-r9:extra 只能列已生成证据的条目 ----------





@pytest.mark.parametrize("bad", ["2026-13-45", "not-a-date", "2026/12/15"])
def test_unparseable_close_date_is_also_dropped(bad):
    """结构化字段里放一个解析不了的"日期",和造一个日期一样糟。"""
    out, dropped = [], {}
    P._poly_shape([_poly_row(outcomes='["Yes","No"]', outcomePrices='["0.4","0.6"]', endDate=bad)],
                  TODAY, dropped, out, "raw/p.json", "2026-08-24T12:00:00Z")
    assert out == [] and dropped.get("missing_close") == 1
