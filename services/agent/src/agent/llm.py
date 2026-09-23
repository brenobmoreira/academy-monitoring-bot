"""The model behind the agent, chosen by configuration only.

ADK talks to the model through LiteLLM, so the provider is the prefix of LLM_MODEL
("gemini/...", "anthropic/...", "openai/...", "vertex_ai/...", "ollama/...") and the same code runs
against any of them. LLM_API_BASE points at a LiteLLM proxy or a self-hosted endpoint.
"""

from __future__ import annotations

from typing import Any

from google.adk.models.lite_llm import LiteLlm, LiteLLMClient

from agent.settings import Settings


def build_model(settings: Settings, client: LiteLLMClient | None = None) -> LiteLlm:
    kwargs: dict[str, Any] = {}
    if settings.LLM_API_KEY is not None:
        kwargs["api_key"] = settings.LLM_API_KEY.get_secret_value()
    if settings.LLM_API_BASE:
        kwargs["api_base"] = settings.LLM_API_BASE
    if client is not None:
        kwargs["llm_client"] = client
    return LiteLlm(model=settings.LLM_MODEL, **kwargs)
