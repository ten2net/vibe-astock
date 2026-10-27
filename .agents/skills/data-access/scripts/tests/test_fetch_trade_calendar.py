"""fetch_trade_calendar 的 extra 输出:除窗口边界和数量外,还要给完整逐日交易日列表(供持有天数计算)。"""
import json
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fetch_trade_calendar  # noqa: E402
from common import today_str  # noqa: E402


def test_trading_day_list_in_extra(monkeypatch, tmp_path):
    """extra.trading_day_list 含完整逐日交易日列表(升序、含今天),供持有天数计算"""
    today = date.fromisoformat(today_str())
    future = (today + timedelta(days=5)).isoformat()
    # 真实取数函数都返回升序列表(含未来的预定交易日),脚本过滤 ≤ 今天的
    calendar = sorted((today - timedelta(days=d)).isoformat() for d in (0, 1, 3, 7, 30)) + [future]
    monkeypatch.setattr(fetch_trade_calendar, "trading_days_baostock", lambda days: list(calendar))
    monkeypatch.setattr(fetch_trade_calendar, "trading_days_sina", lambda: pytest.fail("主源成功不应走降级"))
    monkeypatch.setattr(sys, "argv", ["fetch_trade_calendar.py", "--symbol", "300308", "--days", "30",
                                      "--out-dir", str(tmp_path)])
    with pytest.raises(SystemExit) as exc:
        fetch_trade_calendar.main()
    assert exc.value.code == 0
    out = json.loads((tmp_path / "fetch" / "fetch_trade_calendar.json").read_text())
    days = out["extra"]["trading_day_list"]
    assert days == sorted(days)
    assert today_str() in days
    assert future not in days, "未来的预定交易日不应出现在列表里"
