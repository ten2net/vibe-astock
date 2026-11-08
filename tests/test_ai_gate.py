"""Pro 托管 AI gate（§12-3 / §6）：/api/ai/explain 接隔离引擎，离线单测。

用注入的 fake Manager，不打网络、不启动真实 Codex 引擎、不用真实凭据。
契约见设计文档 §6、billing/hosted_llm.py、billing/router.py。
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from review_agent.evidence import EvidenceError

from billing import auth, entitlement, hosted_llm
from billing.db import connect, init_schema
from billing.router import AI_CALL_COST, create_router

pytestmark = pytest.mark.unit

SECRET = "ai-gate-secret"


class FakeStore:
    def __init__(self, turn=None):
        self._turn = turn or {"id": "t" * 32, "status": "complete", "result": {"summary": "ok"}}

    def turn(self, turn_id):
        return self._turn


class FakeManager:
    def __init__(self, *, submit_error=None):
        self.store = FakeStore()
        self.calls = []
        self.submit_error = submit_error

    def submit(self, body):
        self.calls.append(body)
        if self.submit_error:
            raise self.submit_error
        return {"id": "t" * 32, "conversation_id": "c" * 32, "status": "running"}


@pytest.fixture()
def db(tmp_path):
    c = connect(tmp_path / "billing.db")
    init_schema(c)
    yield c
    c.close()


@pytest.fixture()
def grant(db):
    entitlement.grant(db, "u1", 100, order_id="ord-1")


def make_client(tmp_path, manager, monkeypatch, *, with_llm=True):
    monkeypatch.setenv("ASTOCK_BILLING_JWT_SECRET", SECRET)
    if with_llm:
        monkeypatch.setenv("ASTOCK_HOSTED_LLM_MODEL", "test-model")
        monkeypatch.setenv("ASTOCK_HOSTED_LLM_PROVIDER", "codex-private")
    else:
        monkeypatch.delenv("ASTOCK_HOSTED_LLM_MODEL", raising=False)
    app = FastAPI()
    app.include_router(create_router(
        tmp_path / "billing.db", review_agent_getter=lambda: manager,
    ))
    return TestClient(app)


def hdr(token=None):
    return {"X-Account-Token": token if token is not None else auth.sign("u1", secret=SECRET)}


# ---------------------------------------------------------------- JWT 头（X-Account-Token）

def test_explain_requires_x_account_token(tmp_path, monkeypatch, grant):
    mgr = FakeManager()
    c = make_client(tmp_path, mgr, monkeypatch)
    assert c.post("/api/ai/explain", json={"question": "x"}).status_code == 401
    # Authorization 头不算数（那个归 VR_API_KEY）
    r = c.post("/api/ai/explain", json={"question": "x"},
               headers={"Authorization": "Bearer " + auth.sign("u1", secret=SECRET)})
    assert r.status_code == 401
    assert mgr.calls == []


def test_explain_rejects_invalid_token(tmp_path, monkeypatch, grant):
    c = make_client(tmp_path, FakeManager(), monkeypatch)
    assert c.post("/api/ai/explain", json={"question": "x"}, headers=hdr("garbage")).status_code == 401


# ---------------------------------------------------------------- 托管 LLM 配置

def test_explain_503_when_hosted_llm_missing(tmp_path, monkeypatch, grant):
    """未配托管 LLM → 503，不降级到用户自配 Key 旁路（§6 红线）。"""
    c = make_client(tmp_path, FakeManager(), monkeypatch, with_llm=False)
    r = c.post("/api/ai/explain", json={"question": "x"}, headers=hdr())
    assert r.status_code == 503
    assert "ASTOCK_HOSTED_LLM_MODEL" in r.json()["detail"]


def test_explain_503_when_engine_not_ready(tmp_path, monkeypatch, grant):
    app = FastAPI()
    monkeypatch.setenv("ASTOCK_BILLING_JWT_SECRET", SECRET)
    monkeypatch.setenv("ASTOCK_HOSTED_LLM_MODEL", "test-model")
    app.include_router(create_router(tmp_path / "billing.db", review_agent_getter=lambda: None))
    r = TestClient(app).post("/api/ai/explain", json={"question": "x"}, headers=hdr())
    assert r.status_code == 503 and "尚未启动" in r.json()["detail"]


# ---------------------------------------------------------------- 正常链路

def test_explain_submits_to_isolated_engine_with_server_llm(tmp_path, monkeypatch, grant, db):
    mgr = FakeManager()
    c = make_client(tmp_path, mgr, monkeypatch)
    r = c.post("/api/ai/explain", json={"question": "解释今日盘面", "anchor": "2026-11-07"}, headers=hdr())
    assert r.status_code == 200
    body = r.json()
    assert body["turn_id"] == "t" * 32
    assert body["charged_credits"] == AI_CALL_COST
    assert len(mgr.calls) == 1
    ti = mgr.calls[0]
    assert ti.scope.mode == "direct"           # 设计文档 §6 决策
    assert ti.scope.allow_network is False
    assert ti.question == "解释今日盘面"
    assert ti.anchor == "2026-11-07"
    # llm 由服务端注入，不是前端传的
    assert ti.llm.provider == "codex-private"
    assert ti.llm.model == "test-model"
    assert entitlement.balance(db, "u1") == 100 - AI_CALL_COST


def test_explain_request_body_cannot_override_llm(tmp_path, monkeypatch, grant):
    """前端硬塞 llm/apiKey 应被忽略（pydantic extra=forbid 的 body 不含该字段）。"""
    mgr = FakeManager()
    c = make_client(tmp_path, mgr, monkeypatch)
    r = c.post("/api/ai/explain", json={
        "question": "x", "llm": {"provider": "evil", "apiKey": "ATTACKER"},
    }, headers=hdr())
    assert r.status_code == 200
    assert mgr.calls[0].llm.provider == "codex-private"  # 服务端配置，未采信前端


def test_explain_insufficient_credits_returns_402(tmp_path, monkeypatch):
    """没额度的用户 → 402，且 submit 不被调用。"""
    mgr = FakeManager()
    c = make_client(tmp_path, mgr, monkeypatch)
    r = c.post("/api/ai/explain", json={"question": "x"}, headers=hdr())
    assert r.status_code == 402
    assert "积分包" in r.json()["detail"]
    assert mgr.calls == []


def test_explain_refunds_on_engine_busy(tmp_path, monkeypatch, grant, db):
    """submit 抛 EvidenceError（全局单活跃）→ 409，已扣额度退还（§6）。"""
    mgr = FakeManager(submit_error=EvidenceError("正在生成复盘，请完成或取消后再提问"))
    c = make_client(tmp_path, mgr, monkeypatch)
    r = c.post("/api/ai/explain", json={"question": "x"}, headers=hdr())
    assert r.status_code == 409
    assert entitlement.balance(db, "u1") == 100  # 全额退还


def test_explain_refunds_on_unexpected_error(tmp_path, monkeypatch, grant, db):
    mgr = FakeManager(submit_error=RuntimeError("boom"))
    c = make_client(tmp_path, mgr, monkeypatch)
    r = c.post("/api/ai/explain", json={"question": "x"}, headers=hdr())
    assert r.status_code == 502
    assert entitlement.balance(db, "u1") == 100


# ---------------------------------------------------------------- 轮询端点

def test_turn_polling_uses_same_jwt_gate(tmp_path, monkeypatch, grant):
    mgr = FakeManager()
    c = make_client(tmp_path, mgr, monkeypatch)
    assert c.get("/api/ai/turn/" + "t" * 32).status_code == 401
    r = c.get("/api/ai/turn/" + "t" * 32, headers=hdr())
    assert r.status_code == 200 and r.json()["status"] == "complete"


# ---------------------------------------------------------------- hosted_llm 配置解析

def test_hosted_llm_from_env_defaults_and_key_indirection(monkeypatch):
    monkeypatch.setenv("ASTOCK_HOSTED_LLM_MODEL", "m1")
    monkeypatch.delenv("ASTOCK_HOSTED_LLM_PROVIDER", raising=False)
    monkeypatch.setenv("ASTOCK_HOSTED_LLM_API_KEY_ENV", "MY_SECRET_ENV")
    monkeypatch.setenv("MY_SECRET_ENV", "s3cr3t")
    cfg = hosted_llm.from_env()
    assert cfg.provider == "codex-private"
    assert cfg.model == "m1"
    assert cfg.api_key == "s3cr3t"
    assert cfg.as_model_input() == {
        "provider": "codex-private", "model": "m1", "baseURL": "", "apiKey": "s3cr3t",
    }


def test_hosted_llm_missing_model_fails_closed(monkeypatch):
    monkeypatch.delenv("ASTOCK_HOSTED_LLM_MODEL", raising=False)
    with pytest.raises(hosted_llm.HostedLLMNotConfigured):
        hosted_llm.from_env()
