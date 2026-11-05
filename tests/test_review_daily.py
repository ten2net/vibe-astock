"""定时脚本的发布步骤：博客成功后接微信，WECHAT_AUTOPUBLISH 控制草稿/群发。"""
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts import review_daily as rd  # noqa: E402
from review_agent import wechat_publish as wp  # noqa: E402


@pytest.fixture
def fake_publish(monkeypatch):
    calls = {}

    class Proc:
        returncode = 0
        stdout = "提交 abc123，已推送"
        stderr = ""

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: Proc())
    monkeypatch.setattr(wp, "publish_review",
                        lambda reviews, date, draft_only=True, log=lambda m: None:
                        calls.update(date=date, draft_only=draft_only))
    return calls


def test_default_is_draft_only(fake_publish, monkeypatch):
    monkeypatch.delenv("WECHAT_AUTOPUBLISH", raising=False)
    assert rd._publish(lambda m: None, "2026-11-04") == 0
    assert fake_publish["date"] == "2026-11-04"
    assert fake_publish["draft_only"] is True


def test_autopublish_env_sends(fake_publish, monkeypatch):
    for value in ("1", "true"):
        monkeypatch.setenv("WECHAT_AUTOPUBLISH", value)
        rd._publish(lambda m: None, "2026-11-04")
        assert fake_publish["draft_only"] is False, value


def test_zero_env_is_draft_only(fake_publish, monkeypatch):
    monkeypatch.setenv("WECHAT_AUTOPUBLISH", "0")
    rd._publish(lambda m: None, "2026-11-04")
    assert fake_publish["draft_only"] is True


def test_blog_failure_skips_wechat(fake_publish, monkeypatch):
    class Proc:
        returncode = 1
        stdout = ""
        stderr = "git 推送失败"

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: Proc())
    assert rd._publish(lambda m: None, "2026-11-04") == 1
    assert not fake_publish              # 微信步骤没被执行


def test_wechat_failure_keeps_success(fake_publish, monkeypatch):
    def boom(*a, **k):
        raise wp.WechatError("not in whitelist")

    monkeypatch.setattr(wp, "publish_review", boom)
    assert rd._publish(lambda m: None, "2026-11-04") == 0   # 博客成功，整体仍算成功
