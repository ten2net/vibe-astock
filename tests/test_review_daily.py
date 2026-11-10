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

    monkeypatch.delenv("BARK_DEVICE_KEY", raising=False)
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


def test_bark_sent_after_blog_and_wechat_succeed(fake_publish, monkeypatch):
    monkeypatch.setenv("BARK_DEVICE_KEY", "test-device-key")
    calls = []

    def fake_api(base, path, body=None, timeout=30, direct=False):
        calls.append((base, path, body, timeout, direct))
        return {"code": 200}

    monkeypatch.setattr(rd, "_api", fake_api)
    assert rd._publish(lambda m: None, "2026-11-04") == 0
    assert len(calls) == 1
    base, path, body, timeout, direct = calls[0]
    assert base == "https://api.day.app"
    assert path == "/push"
    assert body["device_key"] == "test-device-key"
    assert body["title"] == "每日复盘发布成功"
    assert "2026-11-04" in body["body"]
    assert "微信公众号" in body["body"]
    assert body["url"] == "https://ten2net.github.io/post/2026-11-04-每日复盘/"
    assert timeout == 15
    assert direct is True


def test_wechat_failure_does_not_send_bark_success(fake_publish, monkeypatch):
    monkeypatch.setenv("BARK_DEVICE_KEY", "test-device-key")
    calls = []
    monkeypatch.setattr(rd, "_api", lambda *a, **k: calls.append((a, k)))
    monkeypatch.setattr(wp, "publish_review", lambda *a, **k: (_ for _ in ()).throw(wp.WechatError("failed")))
    assert rd._publish(lambda m: None, "2026-11-04") == 0
    assert calls == []


def test_bark_failure_keeps_publish_success(fake_publish, monkeypatch):
    monkeypatch.setenv("BARK_DEVICE_KEY", "test-device-key")
    monkeypatch.setattr(rd, "_api", lambda *a, **k: (_ for _ in ()).throw(OSError("network down")))
    assert rd._publish(lambda m: None, "2026-11-04") == 0
