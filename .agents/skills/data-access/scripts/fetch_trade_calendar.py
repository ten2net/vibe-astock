#!/usr/bin/env python3
"""A 股交易日历(全市场维度):最近一个交易日、今天是否交易日、近 N 天日历。
源:baostock `query_trade_dates`(零鉴权 TCP,主);akshare 新浪 `tool_trade_date_hist_sina`(备)。
baostock 是 TCP 长连接,收盘后源站繁忙时登录/翻页会间歇失败 —— 主源失败自动退到新浪日历,
证据的 source/endpoint 如实记用的哪一家,extra.degraded 写明降级。

用途:判定 fetch_quote 的报价日期差异是"全市场休市 / 盘前"还是"个股停牌 / 陈旧"(company-research §2 依赖矩阵)。
输出(均为 evidence,symbol=MARKET,market=CN):
  last_trading_day       最近一个交易日(≤ 今天)
  previous_trading_day   上一个交易日(< last_trading_day)
  is_today_trading_day   今天是否交易日
  session_phase          pre_open(交易日 09:30 前)/ trading(09:30–15:00)/ post_close(15:00 后)/ non_trading_day
  reference_quote_day    此刻一条"新鲜"报价应携带的日期:pre_open → previous_trading_day;其余 → last_trading_day
判定规则(SOP 引用):quote_date == reference_quote_day → 正常;quote_date < reference_quote_day → 该股停牌或数据陈旧 → stale;
  pre_open 时 fetch_quote 的 is_stale=true(成交额 0 且现价 == 昨收)是盘前正常现象,不算僵尸。
与个股无关,--symbol 仅用于落盘归档(仍校验格式)。
用法:python fetch_trade_calendar.py --symbol 300308 --days 30 [--out-dir ...]
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta
from datetime import time as dtime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (TZ_SH, base_parser, bs_paging_error, evidence, finish, lib_versions, now_iso, parse_symbol_or_exit, quiet_stdout,
                    record_error, result_skeleton, save_raw, today_str)

SCRIPT = "fetch_trade_calendar"
EP = "query_trade_dates"


def trading_days_baostock(days: int) -> list:
    import baostock as bs
    today = datetime.now(TZ_SH).date()
    start = today - timedelta(days=days)
    with quiet_stdout():
        lg = bs.login()
        if lg.error_code != "0":
            raise RuntimeError(f"baostock 登录失败 {lg.error_code} {lg.error_msg}")
        try:
            rs = bs.query_trade_dates(start_date=start.isoformat(), end_date=today.isoformat())
            if rs.error_code != "0":
                raise RuntimeError(f"baostock 查询失败 {rs.error_code} {rs.error_msg}")
            rows = []
            while rs.next():
                rows.append(dict(zip(rs.fields, rs.get_row_data())))
            why = bs_paging_error(rs)
            if why:   # 翻页失败不抛异常（见 common.bs_paging_error），不查就拿着前 2000 行当完整日历
                raise RuntimeError(f"baostock 翻页失败 {why}（只取到 {len(rows)} 行）")
        finally:
            bs.logout()
    return sorted(r["calendar_date"] for r in rows if r.get("is_trading_day") == "1")


def trading_days_sina() -> list:
    import akshare as ak
    df = ak.tool_trade_date_hist_sina()
    return sorted(str(d)[:10] for d in df["trade_date"].tolist())


def main() -> None:
    p = base_parser("A 股交易日历(baostock 主 + 新浪备)")
    p.add_argument("--days", type=int, default=30, help="回看天数(默认 30)")
    args = p.parse_args()
    parse_symbol_or_exit(args.symbol, SCRIPT, args.out_dir)  # 只校验格式
    res = result_skeleton(SCRIPT, "MARKET", "CN")
    trading: list | None = None
    source = endpoint = raw_ref = None
    for name, fn in (("baostock", lambda: trading_days_baostock(args.days)), ("sina", trading_days_sina)):
        ep = EP if name == "baostock" else "tool_trade_date_hist_sina"
        try:
            got = fn()
            if len(got) < 2:
                raise ValueError(f"{name} 交易日历不足 2 个,无法给出上一交易日")
            payload = json.dumps(got, ensure_ascii=False).encode("utf-8")
            raw = save_raw(args.out_dir, name, ep, payload, "json", kind="extracted")
            trading, source, endpoint, raw_ref = got, name, ep, raw["raw_ref"]
            if name != "baostock":
                res["extra"]["degraded"] = "baostock 取日历失败,改用 akshare 新浪 tool_trade_date_hist_sina(见 errors)"
                res["status"] = "partial"
            break
        except Exception as e:  # noqa: BLE001
            record_error(res, name, ep, e)
    if trading is None:
        res["status"] = "failed"
        finish(res, args.out_dir)
        return
    today = today_str()
    # 新浪日历含**未来**的预定交易日(一直到年末),只认 ≤ 今天的;baostock 窗口本来就止于今天,过滤无害
    trading = [d for d in trading if d <= today]
    if len(trading) < 2:
        record_error(res, source, endpoint, ValueError(f"截至今天 {today} 的交易日不足 2 个"))
        res["status"] = "failed"
        finish(res, args.out_dir)
        return
    last_td, prev_td = trading[-1], trading[-2]
    is_today_td = last_td == today
    now = datetime.now(TZ_SH).time()
    if not is_today_td:
        phase = "non_trading_day"
    elif now < dtime(9, 30):
        phase = "pre_open"
    elif now < dtime(15, 0):
        phase = "trading"
    else:
        phase = "post_close"
    ref_day = prev_td if phase == "pre_open" else last_td
    for f, v, u in (("last_trading_day", last_td, "date"), ("previous_trading_day", prev_td, "date"),
                    ("is_today_trading_day", is_today_td, "bool"), ("session_phase", phase, "text"),
                    ("reference_quote_day", ref_day, "date")):
        res["evidence"].append(evidence(script=SCRIPT, symbol="MARKET", market="CN", field=f, value=v, unit=u,
                                        period=today, source=source, endpoint=endpoint, raw_ref=raw_ref,
                                        currency="n/a", note="extracted:SDK/接口行数据拼装;全市场日历,非个股;"
                                                             f"session_phase 按 Asia/Shanghai 当前时刻推算;来源:{source}"))
    res["extra"].update({"window": [trading[0], trading[-1]], "trading_days": len(trading),
                         "last_trading_day": last_td, "previous_trading_day": prev_td, "is_today_trading_day": is_today_td,
                         "session_phase": phase, "reference_quote_day": ref_day, "checked_at": now_iso(),
                         "provenance": lib_versions("baostock")})
    res["primary_source"] = source
    if res["status"] != "partial":
        res["status"] = "ok"
    res["used_sources"].append(source)
    finish(res, args.out_dir)


if __name__ == "__main__":
    main()
