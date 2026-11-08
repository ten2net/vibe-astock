"""Vibe AStock v2 付费版 —— 收款与授权后端（骨架阶段）。

设计文档：docs/superpowers/specs/2026-11-08-v2-paid-edition-design.md

骨架阶段（§12 第 1 步）只含：商品表唯一真源、内部订单、SQLite 事务基础、
最小只读 router。**不接 Waffo API、不做验签 / Webhook、不做授权 / 额度发放**，
后续步骤在此基础上叠加，不改动现有 vr/ 与 review_agent 逻辑。
"""
from __future__ import annotations
