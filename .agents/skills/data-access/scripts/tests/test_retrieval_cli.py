import sys
import json
import os
import subprocess
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import retrieval_cli as cli


def test_search_uses_existing_zero_key_backend(monkeypatch):
    calls = []
    monkeypatch.setattr(cli, "search", lambda *a, **kw: calls.append((a, kw)) or [{"url": "https://example.com"}])
    result = cli.retrieve({"action": "search", "query": "test", "limit": 3})
    assert result["untrusted"] is True
    assert calls == [(("test", 3), {"provider": "exa_free"})]


@pytest.mark.parametrize("url", ["http://127.0.0.1:8765", "http://[::1]/", "file:///etc/passwd", "https://user:pass@example.com/", "https://example.com/?api_key=secret"])
def test_private_or_credential_url_rejected_before_fetch(monkeypatch, url):
    monkeypatch.setattr(cli, "fetch_page", lambda *a, **kw: pytest.fail("must not fetch"))
    with pytest.raises(Exception):
        cli.retrieve({"action": "read", "url": url})


def test_read_preserves_raw_provenance_and_truncation(monkeypatch):
    monkeypatch.setattr(cli, "assert_fetchable_url", lambda _: None)
    response = {"url": "https://example.com/", "text": "excerpt", "raw": "full content", "raw_sha256": "hash", "truncated": True, "final_url_known": False}
    monkeypatch.setattr(cli, "fetch_page", lambda *a, **kw: response)
    result = cli.retrieve({"action": "read", "url": "https://example.com/"})
    assert result == {**response, "untrusted": True}


@pytest.mark.parametrize("payload", [{"action": "search", "query": "", "limit": 3}, {"action": "search", "query": "ok", "limit": True}, {"action": "read", "url": "https://example.com", "provider": "cdp"}, {"action": "shell"}])
def test_invalid_shape_rejected(payload):
    with pytest.raises(ValueError):
        cli.retrieve(payload)


def test_cli_emits_utf8_even_when_parent_stdio_is_ascii():
    result = subprocess.run([sys.executable, "-m", "core.retrieval_cli"],
                            input=b'{"action":"invalid"}', capture_output=True,
                            cwd=Path(cli.__file__).resolve().parents[1],
                            env={**os.environ, "PYTHONIOENCODING": "ascii"}, timeout=10)
    assert result.returncode == 1
    assert "这不代表没有结果" in json.loads(result.stdout.decode("utf-8"))["message"]
    assert not result.stderr
