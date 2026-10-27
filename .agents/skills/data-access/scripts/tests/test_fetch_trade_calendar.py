"""fetch_trade_calendar 的 extra 输出:除窗口边界和数量外,还要给完整逐日交易日列表(供持有天数计算)。"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fetch_trade_calendar  # noqa: E402

TODAY = "2026-10-27"
# 真实取数函数都返回升序列表,且含未来的预定交易日(脚本要过滤 ≤ 今天的)
CALENDAR = ["2026-09-27", "2026-10-20", "2026-10-26", TODAY, "2026-11-02"]


def test_trading_day_list_in_extra(monkeypatch, tmp_path):
    """extra.trading_day_list 含完整逐日交易日列表(升序、含今天),供持有天数计算"""
    monkeypatch.setattr(fetch_trade_calendar, "today_str", lambda: TODAY)  # 固定时钟,防午夜跨日 flaky
    monkeypatch.setattr(fetch_trade_calendar, "trading_days_baostock", lambda days: list(CALENDAR))
    monkeypatch.setattr(fetch_trade_calendar, "trading_days_sina", lambda: pytest.fail("主源成功不应走降级"))
    monkeypatch.setattr(sys, "argv", ["fetch_trade_calendar.py", "--symbol", "300308", "--days", "30",
                                      "--out-dir", str(tmp_path)])
    with pytest.raises(SystemExit) as exc:
        fetch_trade_calendar.main()
    assert exc.value.code == 0
    out = json.loads((tmp_path / "fetch" / "fetch_trade_calendar.json").read_text())
    days = out["extra"]["trading_day_list"]
    assert days == sorted(d for d in CALENDAR if d <= TODAY), "trading_day_list 必须等于过滤后的完整日历,一条不许多、不许多漏"
    assert TODAY in days
    assert "2026-11-02" not in days, "未来的预定交易日不应出现在列表里"
