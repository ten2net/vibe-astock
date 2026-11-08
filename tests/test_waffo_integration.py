"""Waffo 官方契约集成（§12-2）离线单测。

用临时生成的 RSA 密钥对做真实签名/验签；用注入的 fake poster 代替网络。
不打网络、不用真实凭据。契约来源见设计文档 §5 / billing/waffo.py 模块注释。
"""
import base64
import json
import time

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient

from billing import auth, entitlement, orders, waffo, webhooks
from billing.db import connect, init_schema
from billing.router import create_router

pytestmark = pytest.mark.unit

SECRET = "waffo-integration-secret"


# ---------------------------------------------------------------- 测试夹具：一对 RSA 密钥

@pytest.fixture(scope="module")
def rsa_keys():
    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    priv_pem = priv.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    pub_pem = priv.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return priv, priv_pem, pub_pem


@pytest.fixture()
def config(rsa_keys):
    _, priv_pem, pub_pem = rsa_keys
    return waffo.WaffoConfig(
        merchant_id="MER_test", private_key_pem=priv_pem,
        public_key_test_pem=pub_pem, public_key_prod_pem=pub_pem,
        api_base="https://api.test",
    )


@pytest.fixture()
def conn(tmp_path):
    c = connect(tmp_path / "billing.db")
    init_schema(c)
    yield c
    c.close()


def _signed_event(rsa_keys, event, *, t_ms=None, mode="test"):
    """用测试私钥按官方算法签一个 webhook 事件，返回 (raw_bytes, header)。"""
    priv = rsa_keys[0]
    event["mode"] = mode  # 显式覆盖，便于测试 prod / 错误环境
    raw = json.dumps(event, separators=(",", ":"))
    t = str(int(t_ms if t_ms is not None else time.time() * 1000))
    sig = base64.b64encode(
        priv.sign((t + "." + raw).encode(), padding.PKCS1v15(), hashes.SHA256())
    ).decode()
    return raw.encode(), f"t={t},v1={sig}"


def _payment_event(order_id, *, event_type="order.completed", event_id="PAY_1"):
    return {
        "id": event_id, "eventId": event_id, "eventType": event_type,
        "mode": "test", "storeId": "STO_1", "timestamp": "2026-11-08T00:00:00.000Z",
        "data": {
            "orderId": "ORD_1", "orderMerchantExternalId": order_id,
            "orderMetadata": {"orderId": order_id},
            "buyerEmail": "buyer@example.com", "currency": "USD",
            "chargedAmount": "9.90", "listPrice": {"total": "9.90"},
            "amount": "9.90", "paymentId": event_id,
        },
    }


class _Resp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def json(self):
        return self._payload


@pytest.fixture()
def fake_poster():
    """假的 Waffo HTTP：校验请求签名头与 body，返回固定会话。"""
    def post(url, **kw):
        assert url.endswith("/v1/actions/checkout/create-session")
        h = kw["headers"]
        assert {"X-Merchant-Id", "X-Timestamp", "X-Signature"} <= set(h)
        body = json.loads(kw["data"])
        assert body["productId"].startswith("PROD_")
        assert body["currency"] == "USD"
        assert body["orderMerchantExternalId"]
        assert body["metadata"]["orderId"] == body["orderMerchantExternalId"]
        return _Resp({"data": {
            "sessionId": "cs_1", "checkoutUrl": "https://checkout.test/cs_1",
            "expiresAt": "2026-11-09T00:00:00.000Z",
        }})
    return post


@pytest.fixture()
def client(tmp_path, config, fake_poster, monkeypatch):
    monkeypatch.setenv("ASTOCK_BILLING_JWT_SECRET", SECRET)
    monkeypatch.setenv("WAFFO_PRODUCT_CREDITS_SMALL", "PROD_credits_small")
    app = FastAPI()
    app.include_router(create_router(
        tmp_path / "billing.db", waffo_config=config, checkout_poster=fake_poster,
    ))
    return TestClient(app)


def _hdr(user_id="u1"):
    return {"X-Account-Token": auth.sign(user_id, secret=SECRET)}


# ---------------------------------------------------------------- 验签（官方 § Signature Verification）

def test_verify_webhook_accepts_valid_signature(config, rsa_keys):
    raw, header = _signed_event(rsa_keys, _payment_event("ord-1"))
    event = waffo.select_and_verify(raw, header, config)
    assert event["eventType"] == "order.completed"


def test_verify_webhook_rejects_tampered_body(config, rsa_keys):
    raw, header = _signed_event(rsa_keys, _payment_event("ord-1"))
    tampered = raw.replace(b"9.90", b"1.00")
    with pytest.raises(waffo.SignatureError):
        waffo.select_and_verify(tampered, header, config)


def test_verify_webhook_rejects_wrong_key(rsa_keys):
    """生产公钥验不了测试事件：换一把无关公钥应失败。"""
    _, priv_pem, pub_pem = rsa_keys
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    other_pub = other.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()
    cfg = waffo.WaffoConfig("MER_t", priv_pem, pub_pem, other_pub)  # prod 用错公钥
    raw, header = _signed_event(rsa_keys, _payment_event("ord-1"), mode="prod")
    with pytest.raises(waffo.SignatureError):
        waffo.select_and_verify(raw, header, cfg)


def test_verify_webhook_rejects_stale_timestamp_beyond_45min(config, rsa_keys):
    now = int(time.time() * 1000)
    raw, header = _signed_event(rsa_keys, _payment_event("ord-1"), t_ms=now - 46 * 60 * 1000)
    with pytest.raises(waffo.SignatureError):
        waffo.select_and_verify(raw, header, config, now_ms=now)


def test_verify_webhook_accepts_retry_at_31min(config, rsa_keys):
    """官方：最后一次重试在 31+ 分钟后，5 分钟窗口会误杀，45 分钟必须通过。"""
    now = int(time.time() * 1000)
    raw, header = _signed_event(rsa_keys, _payment_event("ord-1"), t_ms=now - 31 * 60 * 1000)
    event = waffo.select_and_verify(raw, header, config, now_ms=now)
    assert event["eventId"] == "PAY_1"


def test_verify_webhook_rejects_reparsed_body(config, rsa_keys):
    """官方常见陷阱：重新序列化 JSON（空白变化）会破坏验签。"""
    raw, header = _signed_event(rsa_keys, _payment_event("ord-1"))
    reparsed = json.dumps(json.loads(raw), indent=2).encode()  # 空白变化
    with pytest.raises(waffo.SignatureError):
        waffo.select_and_verify(reparsed, header, config)


def test_verify_webhook_rejects_malformed_header(config):
    with pytest.raises(waffo.SignatureError):
        waffo.verify_webhook(b"{}", "garbage", config.public_key_test_pem)


def test_check_event_scope_rejects_wrong_mode_and_store(config):
    ev = _payment_event("ord-1")
    with pytest.raises(waffo.SignatureError):
        waffo.check_event_scope(ev, expected_mode="prod")
    with pytest.raises(waffo.SignatureError):
        waffo.check_event_scope(ev, expected_store_id="STO_other")
    waffo.check_event_scope(ev, expected_mode="test", expected_store_id="STO_1")


# ---------------------------------------------------------------- API Key 请求签名（authentication.md）

def test_build_signed_headers_signature_is_verifiable(config, rsa_keys):
    body = json.dumps({"productId": "PROD_x"}, separators=(",", ":"))
    h = waffo.build_signed_headers(config, "POST", waffo._CHECKOUT_PATH, body,
                                   timestamp="1700000000")
    body_hash = base64.b64encode(__import__("hashlib").sha256(body.encode()).digest()).decode()
    canonical = f"POST\n{waffo._CHECKOUT_PATH}\n1700000000\n{body_hash}"
    pub = serialization.load_pem_public_key(config.public_key_test_pem.encode())
    pub.verify(base64.b64decode(h["X-Signature"]), canonical.encode(),
               padding.PKCS1v15(), hashes.SHA256())  # 不抛即通过
    assert h["X-Merchant-Id"] == "MER_test"


def test_build_checkout_body_passes_internal_order_id(config):
    b = waffo.build_checkout_body(waffo_product_id="PROD_x", currency="USD", order_id="ord-1")
    assert b["orderMerchantExternalId"] == "ord-1"
    assert b["metadata"]["orderId"] == "ord-1"
    assert "priceSnapshot" not in b  # 用后台商品定价，前端无法改价


def test_create_checkout_session_parses_response(config, fake_poster):
    s = waffo.create_checkout_session(
        config, waffo_product_id="PROD_x", currency="USD", order_id="ord-1",
        poster=fake_poster,
    )
    assert s["checkoutUrl"] == "https://checkout.test/cs_1"
    assert s["sessionId"] == "cs_1"


def test_create_checkout_session_raises_on_waffo_error(config):
    def bad(url, **kw):
        return _Resp({"errors": [{"message": "product not published"}]}, status=400)
    with pytest.raises(waffo.WaffoError) as ei:
        waffo.create_checkout_session(
            config, waffo_product_id="PROD_x", currency="USD", order_id="ord-1", poster=bad,
        )
    assert "not published" in str(ei.value)


# ---------------------------------------------------------------- 配置 fail closed

def test_config_missing_env_fails_closed(monkeypatch):
    for k in ("WAFFO_MERCHANT_ID", "WAFFO_PRIVATE_KEY", "WAFFO_PRIVATE_KEY_BASE64",
              "WAFFO_WEBHOOK_PUBLIC_KEY_TEST", "WAFFO_WEBHOOK_PUBLIC_KEY_PROD"):
        monkeypatch.delenv(k, raising=False)
    with pytest.raises(waffo.ConfigError):
        waffo.WaffoConfig.from_env()


def test_resolve_waffo_product_id_requires_env(monkeypatch):
    monkeypatch.delenv("WAFFO_PRODUCT_CREDITS_SMALL", raising=False)
    with pytest.raises(waffo.ConfigError):
        waffo.resolve_waffo_product_id("credits_small")


# ---------------------------------------------------------------- 事件处理（幂等 / 原子 / 分发）

def test_payment_event_grants_credits_and_marks_paid(conn, rsa_keys):
    o = orders.create_pending(conn, "u1", "credits_small")
    event = _payment_event(o["order_id"])
    result = webhooks.process_event(conn, event, raw_payload=json.dumps(event))
    assert result["outcome"] == "granted"
    assert orders.get(conn, o["order_id"])["status"] == "paid"
    assert entitlement.balance(conn, "u1") == 1000


def test_duplicate_event_is_idempotent(conn, rsa_keys):
    o = orders.create_pending(conn, "u1", "credits_small")
    event = _payment_event(o["order_id"])
    raw = json.dumps(event)
    assert webhooks.process_event(conn, event, raw_payload=raw)["outcome"] == "granted"
    assert webhooks.process_event(conn, event, raw_payload=raw)["outcome"] == "duplicate"
    assert entitlement.balance(conn, "u1") == 1000  # 只发一次


def test_subscription_renewal_grants_each_period_once(conn):
    o = orders.create_pending(conn, "u1", "pro_month")
    # 首期
    webhooks.process_event(conn, _payment_event(o["order_id"],
        event_type="subscription.payment_succeeded", event_id="PAY_1"),
        raw_payload="{}")
    # 续费（不同 eventId）
    webhooks.process_event(conn, _payment_event(o["order_id"],
        event_type="subscription.payment_succeeded", event_id="PAY_2"),
        raw_payload="{}")
    # 首期重试（同 eventId）
    webhooks.process_event(conn, _payment_event(o["order_id"],
        event_type="subscription.payment_succeeded", event_id="PAY_1"),
        raw_payload="{}")
    assert entitlement.balance(conn, "u1") == 3000 * 2


def test_refund_claws_back_credits(conn):
    o = orders.create_pending(conn, "u1", "credits_small")
    pay = _payment_event(o["order_id"])
    webhooks.process_event(conn, pay, raw_payload="{}")
    refund = {
        "eventType": "refund.succeeded", "eventId": "REF_1", "id": "REF_1",
        "mode": "test", "storeId": "STO_1",
        "data": {"orderId": "ORD_1", "orderMerchantExternalId": o["order_id"],
                 "refundedAmount": "9.90", "originalPayment": {"total": "9.90"}},
    }
    assert webhooks.process_event(conn, refund, raw_payload="{}")["outcome"] == "refunded"
    assert entitlement.balance(conn, "u1") == 0
    assert orders.get(conn, o["order_id"])["status"] == "refunded"
    # 退款重复投递不再扣
    assert webhooks.process_event(conn, refund, raw_payload="{}")["outcome"] == "duplicate"


def test_unresolvable_order_is_recorded_not_faked(conn):
    """回调早于建单 / 关联不上：留记录、不假装成功（§5.5）。"""
    event = _payment_event("does-not-exist")
    result = webhooks.process_event(conn, event, raw_payload=json.dumps(event))
    assert result["outcome"] == "ignored"
    row = conn.execute("SELECT outcome, raw_payload FROM processed_webhooks").fetchone()
    assert row["outcome"] == "ignored" and "does-not-exist" in row["raw_payload"]


def test_non_payment_event_only_recorded(conn):
    event = {"eventType": "subscription.canceled", "eventId": "ORD_1-x", "id": "ORD_1-x",
             "mode": "test", "data": {"orderId": "ORD_1"}}
    assert webhooks.process_event(conn, event, raw_payload="{}")["outcome"] == "ignored"
    assert conn.execute("SELECT COUNT(*) c FROM credit_ledger").fetchone()["c"] == 0


def test_atomicity_failure_rolls_back_everything(conn, monkeypatch):
    """发放中途抛错 → 订单状态、额度、事件标记全部回滚（§5.3）。"""
    o = orders.create_pending(conn, "u1", "credits_small")
    event = _payment_event(o["order_id"])

    def boom(*a, **kw):
        raise RuntimeError("grant failed")
    monkeypatch.setattr(entitlement, "grant_in_tx", boom)
    with pytest.raises(RuntimeError):
        webhooks.process_event(conn, event, raw_payload="{}")
    assert orders.get(conn, o["order_id"])["status"] == "pending"
    assert entitlement.balance(conn, "u1") == 0
    assert conn.execute("SELECT COUNT(*) c FROM processed_webhooks").fetchone()["c"] == 0


# ---------------------------------------------------------------- HTTP 端到端（router）

def test_checkout_requires_jwt(client):
    assert client.post("/api/billing/checkout", json={"product_id": "credits_small"}).status_code == 401


def test_full_checkout_webhook_flow(client, rsa_keys, tmp_path):
    r = client.post("/api/billing/checkout", json={"product_id": "credits_small"}, headers=_hdr("u1"))
    assert r.status_code == 201
    oid = r.json()["order_id"]
    assert r.json()["checkout_url"] == "https://checkout.test/cs_1"

    raw, sig = _signed_event(rsa_keys, _payment_event(oid))
    r2 = client.post("/api/billing/webhook", data=raw,
                     headers={"X-Waffo-Signature": sig, "Content-Type": "application/json"})
    assert r2.status_code == 200 and r2.json()["outcome"] == "granted"
    assert client.get("/api/billing/entitlement", headers=_hdr("u1")).json()["credits"] == 1000
    # 重复投递
    r3 = client.post("/api/billing/webhook", data=raw,
                     headers={"X-Waffo-Signature": sig, "Content-Type": "application/json"})
    assert r3.json()["outcome"] == "duplicate"


def test_webhook_rejects_bad_signature(client, rsa_keys):
    raw, _ = _signed_event(rsa_keys, _payment_event("ord-x"))
    r = client.post("/api/billing/webhook", data=raw,
                    headers={"X-Waffo-Signature": "t=1,v1=AAAA"})
    assert r.status_code == 401


def test_webhook_without_signature_is_rejected(client):
    r = client.post("/api/billing/webhook", data=b"{}")
    assert r.status_code == 401


def test_checkout_unknown_product_is_400(client):
    r = client.post("/api/billing/checkout", json={"product_id": "NOPE"}, headers=_hdr())
    assert r.status_code == 400
