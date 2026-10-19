"""Macro request budgets and partial-page preservation; no live network."""
import io
import json
import os
import sys
from datetime import datetime, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources import probability as p


@pytest.mark.parametrize("venue", ["kalshi", "polymarket"])
@pytest.mark.parametrize("failure", ["timeout", "json", "shape"])
def test_later_page_failure_keeps_valid_first_page(monkeypatch, venue, failure):
    calls = []

    def get(*args, **kwargs):
        calls.append(args)
        if len(calls) > 1:
            if failure == "json":
                return b"not json"
            if failure == "shape":
                return b'{"unexpected": true}'
            raise TimeoutError("synthetic slow page")
        return json.dumps({"events": [{}], "cursor": "next"} if venue == "kalshi" else [{}]).encode()

    def shape(rows, today, dropped, out, ref, stamp):
        out.append({"raw_ref": ref, "as_of": stamp})

    monkeypatch.setattr(p, "_get", get)
    monkeypatch.setattr(p, "record_raw", lambda *a: "raw/first.json")
    monkeypatch.setattr(p, "_kalshi_shape" if venue == "kalshi" else "_poly_shape", shape)
    monkeypatch.setattr(p, "_kalshi_macro_series", lambda *a: ([], None, False))
    monkeypatch.setattr(p, "_poly_macro_tags", lambda *a: ([], False))
    rows, warnings, _, complete = getattr(p, "_" + venue)("2026-09-06", {})
    assert len(rows) == 1
    assert rows[0]["raw_ref"] == "raw/first.json"
    assert rows[0]["as_of"].endswith("Z")
    assert complete is False
    assert any("广度" in w and "失败" in w for w in warnings)


@pytest.mark.parametrize("venue", ["kalshi", "polymarket"])
def test_failed_first_page_is_not_a_successful_empty_source(monkeypatch, venue):
    def fail(*args, **kwargs):
        raise TimeoutError("synthetic unavailable source")
    monkeypatch.setattr(p, "_get", fail)
    with pytest.raises(TimeoutError):
        getattr(p, "_" + venue)("2026-09-06", {})


def test_budget_closes_response_and_refuses_later_requests(monkeypatch):
    clock = [100.0]
    requests = []

    class Response(io.BytesIO):
        def read1(self, size=-1):
            clock[0] += 6
            return super().read1(size)

    response = Response(b"{}")
    def open_url(request, timeout):
        requests.append(timeout)
        return response

    monkeypatch.setattr(p.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(p.urllib.request, "urlopen", open_url)
    token = p._source_deadline.set(105.0)
    try:
        with pytest.raises(TimeoutError, match="预算"):
            p._get(p.POLY_MARKETS, {})
        assert response.closed
        with pytest.raises(TimeoutError, match="预算"):
            p._get(p.POLY_MARKETS, {})
        assert requests == [5.0]
    finally:
        p._source_deadline.reset(token)




def test_every_series_discovery_response_is_recorded(monkeypatch):
    recorded = []
    monkeypatch.setattr(p, "_get", lambda *a: b'{"series": []}')
    monkeypatch.setattr(p, "record_raw", lambda *a: recorded.append(a) or f"raw/{len(recorded)}.json")
    p._kalshi_macro_series([])
    assert len(recorded) == len(p.KALSHI_MACRO_CATEGORIES)
