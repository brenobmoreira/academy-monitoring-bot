"""The model behind the agent, chosen by configuration only.

ADK talks to the model through LiteLLM, so the provider is the prefix of LLM_MODEL
("gemini/...", "anthropic/...", "openai/...", "vertex_ai/...", "ollama/...") and the same code runs
against any of them. LLM_API_BASE points at a LiteLLM proxy or a self-hosted endpoint.

Every call has a deadline (LLM_TIMEOUT_S) and the provider SDK does not retry on its own: the
retries are all here. A provider that is momentarily overloaded or rate limited is tried again,
then LLM_FALLBACK_MODEL is used; a call that times out goes straight to the fallback (a model that
hangs keeps hanging). A rejected request goes back to the bot. A streamed reply is retried only
until its first chunk: after that, repeating it could duplicate text or a tool call.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from typing import Any

import litellm
from google.adk.models.lite_llm import LiteLlm, LiteLLMClient

from agent.settings import Settings

log = logging.getLogger(__name__)

# 503, 429 and 500: the same request can succeed a moment later.
TRANSIENT = (litellm.ServiceUnavailableError, litellm.RateLimitError, litellm.InternalServerError)


def provider(model: str) -> str:
    """LiteLLM's provider prefix ("gemini" in "gemini/gemini-3.8-flash")."""
    return model.split("/", 1)[0] if "/" in model else ""


async def _replay(first: Any, rest: AsyncIterator[Any]) -> AsyncIterator[Any]:
    yield first
    async for chunk in rest:
        yield chunk


async def _empty() -> AsyncIterator[Any]:
    return
    yield


class RetryingClient(LiteLLMClient):
    """LiteLLM client that retries transient errors, then moves to the fallback model."""

    def __init__(
        self,
        inner: LiteLLMClient | None = None,
        retries: int = 2,
        wait_s: float = 2.0,
        fallback_model: str | None = None,
        fallback_api_key: str | None = None,
    ) -> None:
        self.inner = inner or LiteLLMClient()
        self.retries = retries
        self.wait_s = wait_s
        self.fallback_model = fallback_model
        self.fallback_api_key = fallback_api_key

    def fallback_kwargs_(self, kwargs: dict[str, Any]) -> dict[str, Any]:
        """The main model's call arguments for the fallback: with its own key (another provider),
        the main key and the main api_base are not sent along."""
        if not self.fallback_api_key:
            return kwargs
        out = {k: v for k, v in kwargs.items() if k != "api_base"}
        out["api_key"] = self.fallback_api_key
        return out

    async def _call(self, model: Any, messages: Any, tools: Any, kwargs: dict[str, Any]) -> Any:
        """One attempt. A stream is opened up to its first chunk, so that an error before any
        output is handled like a failed call."""
        response: Any = await self.inner.acompletion(model=model, messages=messages, tools=tools, **kwargs)
        if not kwargs.get("stream") or not hasattr(response, "__aiter__"):
            return response
        stream: AsyncIterator[Any] = response.__aiter__()
        try:
            first = await stream.__anext__()
        except StopAsyncIteration:
            return _empty()
        return _replay(first, stream)

    async def acompletion(self, model: Any, messages: Any, tools: Any, **kwargs: Any) -> Any:
        kwargs = {**kwargs, "num_retries": 0, "max_retries": 0}
        calls = [(model, kwargs)]
        if self.fallback_model and self.fallback_model != model:
            calls.append((self.fallback_model, self.fallback_kwargs_(kwargs)))
        last: Exception | None = None
        for current, call_kwargs in calls:
            for attempt in range(self.retries + 1):
                try:
                    return await self._call(current, messages, tools, call_kwargs)
                except litellm.Timeout as err:
                    last = err
                    log.warning("model %s timed out, moving on", current)
                    break
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
    kwargs["timeout"] = settings.LLM_TIMEOUT_S
    kwargs["llm_client"] = RetryingClient(
        client,
        retries=settings.LLM_RETRIES,
        wait_s=settings.LLM_RETRY_WAIT_S,
        fallback_model=settings.LLM_FALLBACK_MODEL,
        fallback_api_key=(
            settings.LLM_FALLBACK_API_KEY.get_secret_value() if settings.LLM_FALLBACK_API_KEY else None
        ),
    )
    return LiteLlm(model=settings.LLM_MODEL, **kwargs)
