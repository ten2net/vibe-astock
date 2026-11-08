"""短期 JWT（HS256）—— stdlib 实现，不引入新依赖。

设计文档 §6：登录后后端签发短期 JWT（含 user_id、授权等级、到期时间），
付费功能在 FastAPI 依赖层 gate，而非前端隐藏按钮。

- 算法固定 HS256（HMAC-SHA256 + base64url），用 ``hmac.compare_digest``
  常量时间比对签名，避免时序侧信道。
- 密钥来自 ``ASTOCK_BILLING_JWT_SECRET``；**缺失即明确报错**，绝不硬编码默认密钥
  （那等于没有鉴权）。测试通过参数/环境变量显式注入。
- 校验覆盖：结构、签名、``exp`` 过期、``alg`` 必须为 HS256（防算法混淆）。

注意：本模块只负责「签发/校验一个令牌」，不含登录、用户库、口令校验——
账号体系尚未设计（§12-3 之后）。当前由可信服务端在用户完成购买/登录后调用 ``sign``。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

_SECRET_ENV = "ASTOCK_BILLING_JWT_SECRET"
_ALG = "HS256"


class AuthError(ValueError):
    """令牌无效：结构错、签名错、过期、算法不符。一律拒绝，不区分具体原因对外暴露。"""


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(seg: str) -> bytes:
    # 补齐 padding；非法 base64 会抛 binascii.Error，由调用方转成 AuthError
    return base64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4))


def _secret(secret: str | None) -> str:
    value = secret if secret is not None else os.environ.get(_SECRET_ENV, "").strip()
    if not value:
        raise RuntimeError(
            f"未配置 {_SECRET_ENV}；拒绝签发/校验 JWT（不会使用硬编码默认密钥）"
        )
    return value


def sign(user_id: str, *, tier: str = "pro", ttl_seconds: int = 3600,
         secret: str | None = None, now: float | None = None) -> str:
    """签发短期令牌。``secret``/``now`` 显式注入便于离线单测。"""
    key = _secret(secret)
    issued = int(time.time() if now is None else now)
    header = {"alg": _ALG, "typ": "JWT"}
    payload: dict[str, Any] = {
        "sub": user_id,
        "tier": tier,
        "iat": issued,
        "exp": issued + ttl_seconds,
    }
    head_seg = _b64url_encode(json.dumps(header, separators=(",", ":")).encode())
    pay_seg = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{head_seg}.{pay_seg}".encode("ascii")
    sig = hmac.new(key.encode(), signing_input, hashlib.sha256).digest()
    return f"{head_seg}.{pay_seg}.{_b64url_encode(sig)}"


def verify(token: str, *, secret: str | None = None, now: float | None = None) -> dict:
    """校验并返回 payload；任何异常统一抛 ``AuthError``。"""
    key = _secret(secret)
    try:
        parts = token.split(".")
        if len(parts) != 3:
            raise AuthError("令牌结构错误")
        head_seg, pay_seg, sig_seg = parts
        header = json.loads(_b64url_decode(head_seg))
        if header.get("alg") != _ALG:
            raise AuthError("算法不符")
        expected = hmac.new(
            key.encode(), f"{head_seg}.{pay_seg}".encode("ascii"), hashlib.sha256
        ).digest()
        if not hmac.compare_digest(expected, _b64url_decode(sig_seg)):
            raise AuthError("签名错误")
        payload = json.loads(_b64url_decode(pay_seg))
        if not isinstance(payload.get("sub"), str) or not payload["sub"]:
            raise AuthError("缺少 sub")
        exp = payload.get("exp")
        if not isinstance(exp, (int, float)):
            raise AuthError("缺少 exp")
        if (time.time() if now is None else now) >= exp:
            raise AuthError("令牌已过期")
        return payload
    except AuthError:
        raise
    except Exception as exc:  # base64 / json / 类型异常统一收敛
        raise AuthError("令牌无效") from exc
