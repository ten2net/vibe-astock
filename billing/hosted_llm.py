"""Pro 托管 LLM 配置 —— 服务端注入 ``ModelInput``，前端免配 Key（设计文档 §6）。

``Manager.submit`` 的 ``llm: ModelInput`` 必填；社区版由浏览器传 ``apiKey``
（localStorage），Pro 必须由服务端从环境变量注入自己的凭据，**绝不取自前端请求**，
也**不降级到用户自配 Key 的旁路**（否则绕过计费）。

环境变量（全部服务端读取，不进前端、不进代码）：
- ``ASTOCK_HOSTED_LLM_PROVIDER`` 默认 ``codex-private``（固定版本隔离引擎，
  ``runtime.connection`` 对该 provider 直接放行，无需 baseURL/apiKey）
- ``ASTOCK_HOSTED_LLM_MODEL`` 模型名（必填，``connection`` 校验格式）
- ``ASTOCK_HOSTED_LLM_BASE_URL`` 可选，``api-compatible`` 时必须为 https 白名单地址
- ``ASTOCK_HOSTED_LLM_API_KEY`` 或 ``ASTOCK_HOSTED_LLM_API_KEY_ENV``：
  后者填**另一个环境变量的名**，运行时从那个变量取值，避免把密钥明文写进
  进程环境清单/配置（凭据只记位置不记值）

未配置齐全 → ``HostedLLMNotConfigured``，由 ``/api/ai/*`` 转成 503，fail closed。
"""
from __future__ import annotations

import os
from dataclasses import dataclass


class HostedLLMNotConfigured(RuntimeError):
    """托管 LLM 未配置齐全。端点应返回 503，不要用任何默认/用户凭据兜底。"""


@dataclass(frozen=True)
class HostedLLM:
    provider: str
    model: str
    base_url: str
    api_key: str

    def as_model_input(self) -> dict:
        """转成 ``review_agent.api.ModelInput`` 可接收的 dict（驼峰字段名）。"""
        return {
            "provider": self.provider,
            "model": self.model,
            "baseURL": self.base_url,
            "apiKey": self.api_key,
        }


def from_env() -> HostedLLM:
    """从环境变量构造。缺 provider/model 一律报错，不使用内置默认值兜底凭据。"""
    provider = os.environ.get("ASTOCK_HOSTED_LLM_PROVIDER", "codex-private").strip()
    model = os.environ.get("ASTOCK_HOSTED_LLM_MODEL", "").strip()
    if not provider or not model:
        raise HostedLLMNotConfigured(
            "未配置 ASTOCK_HOSTED_LLM_MODEL（及 ASTOCK_HOSTED_LLM_PROVIDER）；"
            "Pro 托管 AI 拒绝以无凭据状态运行"
        )
    base_url = os.environ.get("ASTOCK_HOSTED_LLM_BASE_URL", "").strip()
    # 凭据：支持「直接值」与「指向另一个环境变量名」两种，后者更安全
    key = os.environ.get("ASTOCK_HOSTED_LLM_API_KEY", "").strip()
    key_env = os.environ.get("ASTOCK_HOSTED_LLM_API_KEY_ENV", "").strip()
    if not key and key_env:
        key = os.environ.get(key_env, "").strip()
    return HostedLLM(provider=provider, model=model, base_url=base_url, api_key=key)
