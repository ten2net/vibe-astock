"""§12-3 协议无关内核 + waffo 适配层：离线单测。

不打网络、不接 Waffo API、不接真实大模型；DB 注入 tmp_path，JWT 密钥显式注入。
设计文档：docs/superpowers/specs/2026-11-08-v2-paid-edition-design.md
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from billing import auth, entitlement, waffo
from billing.db import connect, init_schema
from billing.router import AI_CALL_COST, create_router

pytestmark = pytest.mark.unit

SECRET = "unit-test-secret"


@pytest.fixture()
def conn(tmp_path):
    c = connect(tmp_path / "billing.db")
    init_schema(c)
    yield c
    c.close()


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("ASTOCK_BILLING_JWT_SECRET", SECRET)
    app = FastAPI()
    app.include_router(create_router(tmp_path / "billing.db"))
    return TestClient(app)


def _token(user_id="u1", **kw):
    return auth.sign(user_id, secret=SECRET, **kw)


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------- auth.py (JWT)

def test_jwt_roundtrip():
    p = auth.verify(_token("alice"), secret=SECRET)
    assert p["sub"] == "alice"
    assert p["tier"] == "pro"


def test_jwt_rejects_wrong_secret():
    with pytest.raises(auth.AuthError):
        auth.verify(_token("alice"), secret="other")


def test_jwt_rejects_tampered_payload():
    t = _token("alice")
    head, pay, sig = t.split(".")
    # 改 payload 但不改签名
    forged = f"{head}.{pay[:-2]}AA.{sig}"
    with pytest.raises(auth.AuthError):
        auth.verify(forged, secret=SECRET)


def test_jwt_rejects_expired():
    t = auth.sign("alice", secret=SECRET, ttl_seconds=10, now=1000)
    with pytest.raises(auth.AuthError):
        auth.verify(t, secret=SECRET, now=2000)


def test_jwt_rejects_alg_confusion():
    import base64, json
    head = base64.urlsafe_b64encode(json.dumps({"alg": "none", "typ": "JWT"}).encode()).rstrip(b"=").decode()
    t = f"{head}.e30."
    with pytest.raises(auth.AuthError):
        auth.verify(t, secret=SECRET)


def test_jwt_missing_secret_fails_closed():
    with pytest.raises(RuntimeError):
        auth.sign("alice", secret="")
    with pytest.raises(RuntimeError):
        auth.verify("a.b.c", secret="")


# ---------------------------------------------------------------- entitlement.py

def test_grant_is_idempotent_by_order_id(conn):
    a = entitlement.grant(conn, "u1", 3000, order_id="ord-1")
    assert a["credits"] == 3000
    # 同一订单回调重发 → 只发一次
    b = entitlement.grant(conn, "u1", 3000, order_id="ord-1")
    assert b["credits"] == 3000
    rows = conn.execute("SELECT COUNT(*) c FROM credit_ledger WHERE reason='grant'").fetchone()["c"]
    assert rows == 1


def test_grant_different_orders_accumulate(conn):
    entitlement.grant(conn, "u1", 1000, order_id="ord-1")
    entitlement.grant(conn, "u1", 6000, order_id="ord-2")
    assert entitlement.balance(conn, "u1") == 7000


def test_consume_is_idempotent_by_ref_id(conn):
    entitlement.grant(conn, "u1", 100, order_id="ord-1")
    entitlement.consume(conn, "u1", 10, ref_id="req-1")
    entitlement.consume(conn, "u1", 10, ref_id="req-1")  # 重试
    assert entitlement.balance(conn, "u1") == 90


def test_consume_insufficient_rolls_back_ledger(conn):
    entitlement.grant(conn, "u1", 5, order_id="ord-1")
    with pytest.raises(entitlement.InsufficientCredits):
        entitlement.consume(conn, "u1", 10, ref_id="req-1")
    assert entitlement.balance(conn, "u1") == 5
    # 余额不足时连流水都不该落，idempotency_key 不被烧掉
    assert conn.execute("SELECT COUNT(*) c FROM credit_ledger WHERE reason='consume'").fetchone()["c"] == 0
    # 补足额度后同一个 ref_id 仍可正常扣
    entitlement.grant(conn, "u1", 10, order_id="ord-2")
    entitlement.consume(conn, "u1", 10, ref_id="req-1")
    assert entitlement.balance(conn, "u1") == 5


def test_refund_clawback_is_idempotent(conn):
    entitlement.grant(conn, "u1", 100, order_id="ord-1")
    entitlement.refund_clawback(conn, "u1", 100, order_id="ord-1")
    entitlement.refund_clawback(conn, "u1", 100, order_id="ord-1")
    assert entitlement.balance(conn, "u1") == 0


# ---------------------------------------------------------------- waffo.parse_amount

def test_parse_amount_payment_uses_charged_and_list_total():
    v = waffo.parse_amount({"type": "payment", "chargedAmount": 2850,
                            "listPrice": {"total": 2900}, "amount": 2850})
    assert (v.charged, v.list_total) == (2850, 2900)
    # §5.4：断言绝不依赖 amount == total；按比例退款时二者本就不同
    assert v.charged != v.list_total


def test_parse_amount_refund_and_subscription():
    r = waffo.parse_amount({"type": "refund", "refundedAmount": 500, "originalPayment": 2900})
    assert (r.refunded, r.original) == (500, 2900)
    s = waffo.parse_amount({"type": "subscription", "planPrice": 29900})
    assert s.plan_price == 29900


def test_parse_amount_rejects_unknown_type():
    with pytest.raises(waffo.UnknownEventType):
        waffo.parse_amount({"type": "mystery"})


# ---------------------------------------------------------------- router gate

def test_entitlement_endpoint_requires_jwt(client):
    assert client.get("/api/billing/entitlement").status_code == 401
    assert client.get("/api/billing/entitlement", headers=_auth("garbage")).status_code == 401


def test_entitlement_endpoint_returns_balance(client, tmp_path):
    # 同一 DB：先直接发额度，再用合法 JWT 查
    c = connect(tmp_path / "billing.db")
    init_schema(c)
    entitlement.grant(c, "u1", 3000, order_id="ord-1")
    c.close()
    r = client.get("/api/billing/entitlement", headers=_auth(_token("u1")))
    assert r.status_code == 200
    assert r.json()["credits"] == 3000
    assert r.json()["tier"] == "pro"


def test_ai_echo_requires_jwt(client):
    assert client.post("/api/ai/echo", json={"prompt": "hi"}).status_code == 401


def test_ai_echo_consumes_credits_and_is_idempotent(client, tmp_path):
    c = connect(tmp_path / "billing.db")
    init_schema(c)
    entitlement.grant(c, "u1", 100, order_id="ord-1")
    c.close()
    h = _auth(_token("u1"))
    r1 = client.post("/api/ai/echo", json={"prompt": "hi", "request_id": "req-x"}, headers=h)
    assert r1.status_code == 200
    assert r1.json()["stub"] is True
    assert r1.json()["charged_credits"] == AI_CALL_COST
    assert r1.json()["remaining_credits"] == 100 - AI_CALL_COST
    # 同 request_id 重试不重复扣
    r2 = client.post("/api/ai/echo", json={"prompt": "hi", "request_id": "req-x"}, headers=h)
    assert r2.json()["remaining_credits"] == 100 - AI_CALL_COST


def test_ai_echo_insufficient_returns_402(client):
    # 没有任何额度的新用户
    r = client.post("/api/ai/echo", json={"prompt": "hi"}, headers=_auth(_token("broke")))
    assert r.status_code == 402
    assert "积分包" in r.json()["detail"]


def test_ai_echo_does_not_call_real_model(client, tmp_path):
    c = connect(tmp_path / "billing.db")
    init_schema(c)
    entitlement.grant(c, "u1", 100, order_id="ord-1")
    c.close()
    r = client.post("/api/ai/echo", json={"prompt": "给我买入建议"}, headers=_auth(_token("u1")))
    assert r.status_code == 200
    # 占位端点只回显，不产出任何「分析/建议」内容
    assert r.json()["echo"] == "给我买入建议"
    assert r.json()["stub"] is True


def test_no_checkout_or_webhook_endpoints(client):
    assert client.post("/api/billing/checkout", json={}).status_code == 404
    assert client.post("/api/billing/webhook", json={}).status_code == 404
