"""Yahoo Finance 源(B 级:非官方接口,个人研究用):chart K 线(美股 / 港股,零 crumb)/ quoteSummary(关键指标 / 分析师预期 / 机构持仓 / 财报)/ 期权链(美股)/ 新闻搜索。移植自 global-stock-data §2 / §4.3-4.6 / §6.2 / §8.2。
crumb 会话与 raw 落盘见 _http.yahoo_*。"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import UA  # noqa: E402
from sources._http import assert_us_ticker, http_json, norm_hk, record_raw, yahoo_get, yahoo_quote_summary, yahoo_session  # noqa: E402


def yahoo_symbol(symbol: str, market: str = "US") -> str:
    if market == "HK":
        return f"{int(norm_hk(symbol)):04d}.HK"
    return assert_us_ticker(symbol).replace(".", "-")


def _raw(d: dict, key: str):
    v = (d or {}).get(key, {})
    return v.get("raw") if isinstance(v, dict) else v


def yahoo_kline(symbol: str, market: str = "US", interval: str = "1d", range_: str = "6mo") -> list[dict]:
    """chart v8(零 crumb):[{date, open, high, low, close, volume}];日期按 UTC 折算(美股 / 港股日线均落在正确交易日)。"""
    sym = yahoo_symbol(symbol, market)
    d = http_json(f"https://query2.finance.yahoo.com/v8/finance/chart/{sym}", params={"interval": interval, "range": range_}, headers={"User-Agent": UA}, timeout=15)
    res = ((d.get("chart") or {}).get("result") or [{}])[0]
    ts = res.get("timestamp") or []
    q = ((res.get("indicators") or {}).get("quote") or [{}])[0]
    intraday = any(ch in interval for ch in ("m", "h"))
    out = []
    for i, t in enumerate(ts):
        dt = datetime.fromtimestamp(t, timezone.utc)
        row = {"date": dt.strftime("%Y-%m-%d %H:%M") if intraday else dt.strftime("%Y-%m-%d")}
        for k in ("open", "high", "low", "close"):
            v = (q.get(k) or [None] * len(ts))[i]
            row[k] = round(v, 4) if v is not None else None
        v = (q.get("volume") or [None] * len(ts))[i]
        row["volume"] = int(v) if v is not None else None
        out.append(row)
    return out


def key_statistics(symbol: str, market: str = "US") -> dict:
    data = yahoo_quote_summary(yahoo_symbol(symbol, market), ["financialData", "defaultKeyStatistics", "summaryDetail"])
    fd, ks, sd = data.get("financialData", {}), data.get("defaultKeyStatistics", {}), data.get("summaryDetail", {})
    return {"current_price": _raw(fd, "currentPrice"), "target_high": _raw(fd, "targetHighPrice"), "target_low": _raw(fd, "targetLowPrice"), "target_mean": _raw(fd, "targetMeanPrice"),
            "recommendation": fd.get("recommendationKey"), "num_analyst_opinions": _raw(fd, "numberOfAnalystOpinions"), "trailing_pe": _raw(sd, "trailingPE"), "forward_pe": _raw(ks, "forwardPE"),
            "peg_ratio": _raw(ks, "pegRatio"), "price_to_book": _raw(ks, "priceToBook"), "enterprise_value": _raw(ks, "enterpriseValue"), "ev_to_ebitda": _raw(ks, "enterpriseToEbitda"),
            "ev_to_revenue": _raw(ks, "enterpriseToRevenue"), "profit_margin": _raw(ks, "profitMargins"), "operating_margin": _raw(fd, "operatingMargins"), "gross_margin": _raw(fd, "grossMargins"),
            "return_on_equity": _raw(fd, "returnOnEquity"), "return_on_assets": _raw(fd, "returnOnAssets"), "earnings_growth": _raw(fd, "earningsGrowth"), "revenue_growth": _raw(fd, "revenueGrowth"),
            "beta": _raw(ks, "beta"), "short_ratio": _raw(ks, "shortRatio"), "dividend_yield": _raw(sd, "dividendYield"), "payout_ratio": _raw(ks, "payoutRatio"), "market_cap": _raw(sd, "marketCap"),
            "total_revenue": _raw(fd, "totalRevenue"), "total_cash": _raw(fd, "totalCash"), "total_debt": _raw(fd, "totalDebt"), "financial_currency": fd.get("financialCurrency"), "symbol": yahoo_symbol(symbol, market)}


def analyst_estimates(symbol: str, market: str = "US") -> dict:
    data = yahoo_quote_summary(yahoo_symbol(symbol, market), ["earningsTrend", "recommendationTrend", "upgradeDowngradeHistory", "earnings", "earningsHistory"])
    eps_trend = [{"period": t.get("period"), "end_date": t.get("endDate"), "eps_estimate": _raw(t.get("earningsEstimate") or {}, "avg"), "eps_high": _raw(t.get("earningsEstimate") or {}, "high"),
                  "eps_low": _raw(t.get("earningsEstimate") or {}, "low"), "revenue_estimate": _raw(t.get("revenueEstimate") or {}, "avg"), "num_analysts": _raw(t.get("earningsEstimate") or {}, "numberOfAnalysts"),
                  "growth": _raw(t, "growth")} for t in (data.get("earningsTrend") or {}).get("trend") or []]
    rating_trend = [{"period": r.get("period"), "strong_buy": r.get("strongBuy"), "buy": r.get("buy"), "hold": r.get("hold"), "sell": r.get("sell"), "strong_sell": r.get("strongSell")}
                    for r in (data.get("recommendationTrend") or {}).get("trend") or []]
    ud = [{"date": datetime.fromtimestamp(u["epochGradeDate"], timezone.utc).strftime("%Y-%m-%d") if u.get("epochGradeDate") else "", "firm": u.get("firm"), "to_grade": u.get("toGrade"), "from_grade": u.get("fromGrade"),
           "action": u.get("action")} for u in ((data.get("upgradeDowngradeHistory") or {}).get("history") or [])[:20]]
    eh = [{"quarter": _raw(h, "quarter") and datetime.fromtimestamp(_raw(h, "quarter"), timezone.utc).strftime("%Y-%m-%d"), "eps_actual": _raw(h, "epsActual"), "eps_estimate": _raw(h, "epsEstimate"), "surprise_pct": _raw(h, "surprisePercent")}
          for h in (data.get("earningsHistory") or {}).get("history") or []]
    return {"eps_trend": eps_trend, "rating_trend": rating_trend, "upgrade_downgrade": ud, "earnings_history": eh}


def institutional_holders(symbol: str, market: str = "US") -> dict:
    data = yahoo_quote_summary(yahoo_symbol(symbol, market), ["institutionOwnership", "majorHoldersBreakdown"])
    mhb = data.get("majorHoldersBreakdown", {})
    overview = {"insiders_pct": _raw(mhb, "insidersPercentHeld"), "institutions_pct": _raw(mhb, "institutionsPercentHeld"), "institutions_float_pct": _raw(mhb, "institutionsFloatPercentHeld"),
                "institutions_count": _raw(mhb, "institutionsCount")}
    top = [{"name": h.get("organization"), "shares": _raw(h, "position"), "value": _raw(h, "value"), "pct_held": _raw(h, "pctHeld"), "report_date": (h.get("reportDate") or {}).get("fmt") if isinstance(h.get("reportDate"), dict) else None}
           for h in ((data.get("institutionOwnership") or {}).get("ownershipList") or [])[:10]]
    return {"overview": overview, "top_holders": top}


def financial_statements_yahoo(symbol: str, market: str = "US", quarterly: bool = False) -> dict:
    suf = "Quarterly" if quarterly else ""
    data = yahoo_quote_summary(yahoo_symbol(symbol, market), [f"incomeStatementHistory{suf}", f"balanceSheetHistory{suf}", f"cashflowStatementHistory{suf}", "financialData"])

    def _ext(stmts):
        rows = []
        for st in stmts or []:
            row = {}
            for k, v in st.items():
                row[k] = v.get("raw") if isinstance(v, dict) and "raw" in v else (v.get("fmt") if isinstance(v, dict) and "fmt" in v else v)
            rows.append(row)
        return rows

    return {"income": _ext((data.get(f"incomeStatementHistory{suf}") or {}).get("incomeStatementHistory")), "balance": _ext((data.get(f"balanceSheetHistory{suf}") or {}).get("balanceSheetStatements")),
            "cashflow": _ext((data.get(f"cashflowStatementHistory{suf}") or {}).get("cashflowStatements")), "quarterly": quarterly,
            "financial_currency": (data.get("financialData") or {}).get("financialCurrency")}


def _exp_date(v) -> str:
    if isinstance(v, dict):
        v = v.get("raw") or v.get("fmt")
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v, timezone.utc).strftime("%Y-%m-%d")
    return str(v or "")


def options_chain_yahoo(symbol: str, expiration: Optional[int] = None) -> dict:
    """美股期权链(后备,无希腊字母):{expiration_dates, calls, puts, underlying_price}"""
    t = yahoo_symbol(symbol)
    params = {"date": expiration} if expiration else {}
    d = yahoo_get(f"https://query2.finance.yahoo.com/v7/finance/options/{t}", params=params)
    oc = ((d.get("optionChain") or {}).get("result") or [{}])[0]
    opts = (oc.get("options") or [{}])[0] if oc.get("options") else {}

    def _parse(lst):
        return [{"strike": _raw(o, "strike"), "last_price": _raw(o, "lastPrice"), "bid": _raw(o, "bid"), "ask": _raw(o, "ask"), "volume": _raw(o, "volume"), "open_interest": _raw(o, "openInterest"),
                 "implied_volatility": _raw(o, "impliedVolatility"), "in_the_money": o.get("inTheMoney"), "expiration": _exp_date(o.get("expiration")),
                 "contract_symbol": o.get("contractSymbol")} for o in lst or []]

    return {"expiration_dates": [_exp_date(x) for x in oc.get("expirationDates") or []], "calls": _parse(opts.get("calls")), "puts": _parse(opts.get("puts")), "underlying_price": _raw(oc.get("quote") or {}, "regularMarketPrice") or (oc.get("quote") or {}).get("regularMarketPrice")}


def yahoo_news(keyword: str, count: int = 10) -> list[dict]:
    """新闻搜索:[{title, publisher, link, publish_time(ISO UTC)}]"""
    s, _ = yahoo_session()
    r = s.get("https://query2.finance.yahoo.com/v1/finance/search", params={"q": keyword, "quotesCount": 0, "newsCount": count}, timeout=10)
    r.raise_for_status()
    record_raw(r.content, "json", r.url)
    out = []
    for n in r.json().get("news") or []:
        ts = n.get("providerPublishTime")
        out.append({"title": n.get("title"), "publisher": n.get("publisher"), "link": n.get("link"), "publish_time": datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d %H:%M") if ts else ""})
    return out
