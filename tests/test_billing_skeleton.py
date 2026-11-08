"""billing 骨架（§12-1）离线单测：商品表唯一真源、内部订单、事务、最小 router。

不打网络、不接 Waffo API、不用真实用户数据；DB 一律注入 tmp_path。
对应设计文档：docs/superpowers/specs/2026-11-08-v2-paid-edition-design.md
"""
import sqlite3

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from billing import orders, products
from billing.db import connect, init_schema, transaction
from billing.router import create_router


@pytest.fixture()
def conn(tmp_path):
    c = connect(tmp_path / "billing.db")
    init_schema(c)
    yield c
    c.close()


@pytest.fixture()
def client(tmp_path):
    app = FastAPI()
    app.include_router(create_router(tmp_path / "billing.db"))
    return TestClient(app)


pytestmark = pytest.mark.unit


# ---------------------------------------------------------------- 商品表唯一真源

def test_catalog_is_server_side_source_of_truth():
    assert set(products.CATALOG) >= {"pro_month", "pro_year", "credits_small", "credits_large"}
    assert products.CATALOG["pro_month"].kind == "subscription"
    assert products.CATALOG["credits_small"].kind == "credit_pack"
    assert products.CATALOG["credits_small"].period is None
    # 最低客单价要能覆盖 Waffo 固定 $0.50 手续费，不设过小额包
    assert all(p.price_cents >= 500 for p in products.CATALOG.values())


def test_resolve_rejects_unknown_product():
    with pytest.raises(products.UnknownProduct):
        products.resolve("NOT_A_PRODUCT")


def test_resolve_returns_immutable_snapshot():
    p = products.resolve("pro_month")
    # frozen dataclass：商品配置运行期不可被篡改
    with pytest.raises(Exception):
        p.price_cents = 1  # type: ignore[misc]


# ---------------------------------------------------------------- 内部订单

def test_create_pending_snapshots_server_price_and_credits(conn):
    o = orders.create_pending(conn, "u1", "pro_month")
    assert o["status"] == "pending"
    assert o["price_cents"] == 2900
    assert o["currency"] == "USD"
    assert o["credits"] == 3000
    assert o["waffo_session_id"] is None
    assert o["waffo_txn_id"] is None
    assert o["order_id"]


def test_create_pending_rejects_unknown_product(conn):
    with pytest.raises(products.UnknownProduct):
        orders.create_pending(conn, "u1", "NOPE")
    # 失败不落单（事务回滚）
    assert conn.execute("SELECT COUNT(*) FROM orders").fetchone()[0] == 0


def test_status_machine_allows_only_legal_transitions(conn):
    o = orders.create_pending(conn, "u1", "pro_month")
    paid = orders.set_status(conn, o["order_id"], "paid")
    assert paid["status"] == "paid"
    # 乱序回调把 paid 改回 pending：必须拒绝
    with pytest.raises(orders.IllegalTransition):
        orders.set_status(conn, o["order_id"], "pending")
    refunded = orders.set_status(conn, o["order_id"], "refunded")
    assert refunded["status"] == "refunded"
    with pytest.raises(orders.IllegalTransition):
        orders.set_status(conn, o["order_id"], "paid")


def test_unknown_order_raises(conn):
    with pytest.raises(orders.UnknownOrder):
        orders.get(conn, "does-not-exist")


def test_waffo_txn_id_unique_is_idempotency_seed(conn):
    """同一笔 Waffo 交易号不能挂到两笔订单上（§5.3 幂等种子）。"""
    o1 = orders.create_pending(conn, "u1", "pro_month")
    orders.set_status(conn, o1["order_id"], "paid")
    conn.execute("UPDATE orders SET waffo_txn_id = ? WHERE order_id = ?", ("txn_abc", o1["order_id"]))
    conn.commit()
    o2 = orders.create_pending(conn, "u2", "pro_month")
    with pytest.raises(sqlite3.IntegrityError):
        with transaction(conn):
            conn.execute("UPDATE orders SET waffo_txn_id = ? WHERE order_id = ?", ("txn_abc", o2["order_id"]))


def test_transaction_rolls_back_on_error(conn):
    with pytest.raises(RuntimeError):
        with transaction(conn):
            conn.execute(
                "INSERT INTO orders (order_id,user_id,product_id,price_cents,currency,credits,status,created_at,updated_at) "
                "VALUES ('x','u','p',1,'USD',1,'pending','t','t')"
            )
            raise RuntimeError("boom")
    assert conn.execute("SELECT COUNT(*) FROM orders WHERE order_id='x'").fetchone()[0] == 0


# ---------------------------------------------------------------- router（HTTP 层）

def test_router_products_is_read_only(client):
    r = client.get("/api/billing/products")
    assert r.status_code == 200
    assert len(r.json()["products"]) == 4


def test_router_ignores_frontend_tampered_amounts(client):
    """前端硬塞 price_cents / credits 一律忽略，服务端按商品表定（§5.1 核心）。"""
    r = client.post("/api/billing/orders", json={
        "user_id": "u1", "product_id": "pro_month",
        "price_cents": 1, "currency": "JPY", "credits": 999999,
    })
    assert r.status_code == 201
    body = r.json()
    assert body["price_cents"] == 2900
    assert body["currency"] == "USD"
    assert body["credits"] == 3000
    assert body["status"] == "pending"


def test_router_rejects_unknown_product(client):
    r = client.post("/api/billing/orders", json={"user_id": "u1", "product_id": "NOPE"})
    assert r.status_code == 400


def test_router_get_order_and_404(client):
    created = client.post("/api/billing/orders", json={"user_id": "u1", "product_id": "credits_small"})
    oid = created.json()["order_id"]
    assert client.get(f"/api/billing/orders/{oid}").status_code == 200
    assert client.get("/api/billing/orders/nope").status_code == 404


def test_router_has_no_money_endpoints_yet(client):
    """骨架阶段刻意不暴露 checkout / webhook / entitlement（§12 后续步骤）。"""
    assert client.post("/api/billing/checkout", json={}).status_code == 404
    assert client.post("/api/billing/webhook", json={}).status_code == 404
    assert client.get("/api/billing/entitlement").status_code == 404
