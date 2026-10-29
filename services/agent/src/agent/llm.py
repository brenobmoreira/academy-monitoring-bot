"""The model behind the agent, chosen by configuration only.

ADK talks to the model through LiteLLM, so the provider is the prefix of LLM_MODEL
("gemini/...", "anthropic/...", "openai/...", "vertex_ai/...", "ollama/...") and the same code runs
against any of them. LLM_API_BASE points at a LiteLLM proxy or a self-hosted endpoint.

A provider that is momentarily overloaded or rate limited is tried again, then LLM_FALLBACK_MODEL
is used; any other error (a rejected request, a timeout) goes straight back to the bot.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import litellm
from google.adk.models.lite_llm import LiteLlm, LiteLLMClient

from agent.settings import Settings

log = logging.getLogger(__name__)

# 503, 429 and 500: the same request can succeed a moment later.
TRANSIENT = (litellm.ServiceUnavailableError, litellm.RateLimitError, litellm.InternalServerError)


class RetryingClient(LiteLLMClient):
    """LiteLLM client that retries transient errors, then moves to the fallback model."""

    def __init__(
        self,
        inner: LiteLLMClient | None = None,
        retries: int = 2,
        wait_s: float = 2.0,
        fallback_model: str | None = None,
    ) -> None:
        self.inner = inner or LiteLLMClient()
        self.retries = retries
        self.wait_s = wait_s
        self.fallback_model = fallback_model

    async def acompletion(self, model: Any, messages: Any, tools: Any, **kwargs: Any) -> Any:
        models = [model]
        if self.fallback_model and self.fallback_model != model:
            models.append(self.fallback_model)
        last: Exception | None = None
        for current in models:
            for attempt in range(self.retries + 1):
                try:
                    return await self.inner.acompletion(
                        model=current, messages=messages, tools=tools, **kwargs
                    )
                except TRANSIENT as err:
                    last = err
                    log.warning(
                        "model %s unavailable (%s), attempt %d of %d",
                        current,
                        type(err).__name__,
                        attempt + 1,
                        self.retries + 1,
                    )
                    if attempt < self.retries and self.wait_s:
                        await asyncio.sleep(self.wait_s * 2**attempt)
        assert last is not None
        raise last


def build_model(settings: Settings, client: LiteLLMClient | None = None) -> LiteLlm:
    kwargs: dict[str, Any] = {}
    if settings.LLM_API_KEY is not None:
        kwargs["api_key"] = settings.LLM_API_KEY.get_secret_value()
    if settings.LLM_API_BASE:
        kwargs["api_base"] = settings.LLM_API_BASE
    kwargs["llm_client"] = RetryingClient(
        client,
        retries=settings.LLM_RETRIES,
        wait_s=settings.LLM_RETRY_WAIT_S,
        fallback_model=settings.LLM_FALLBACK_MODEL,
    )
    return LiteLlm(model=settings.LLM_MODEL, **kwargs)
