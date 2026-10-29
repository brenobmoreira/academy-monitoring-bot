import asyncio
import json
from typing import Any

import litellm
import pytest
from pydantic import SecretStr

from agent.bot import MEDIA_UNREADABLE, MODEL_FAILED, MODEL_FAILED_NOTHING_WRITTEN, Bot, Media
from agent.llm import RetryingClient, build_model
from agent.settings import Settings

from .fakes import OK_DIARY, FakeLiteLLMClient, FakeSheet, text_response, tool_call_response

pytestmark = pytest.mark.unit


def settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "TELEGRAM_BOT_TOKEN": SecretStr("tok"),
        "ALLOWED_CHAT_IDS": frozenset({42}),
        "SHEET_API_URL": "https://x/exec",
        "SHEET_API_KEY": SecretStr("k"),
        "LLM_MODEL": "anthropic/claude-sonnet-5",
    }
    return Settings.model_construct(None, **{**base, **overrides})


async def run(model, text="peso 82,4"):
    return (
        await Bot(FakeSheet(diary_upsert=[OK_DIARY]), model, timezone="America/Sao_Paulo").reply(text)
    ).text


async def test_model_key_and_base_reach_litellm():
    client = FakeLiteLLMClient([text_response("ok")])
    model = build_model(
        settings(LLM_API_KEY=SecretStr("sk-test"), LLM_API_BASE="http://proxy:4000"), client=client
    )
    await run(model)
    request = client.requests[0]
    assert request["model"] == "anthropic/claude-sonnet-5"
    assert request["api_key"] == "sk-test"
    assert request["api_base"] == "http://proxy:4000"


async def test_no_key_or_base_is_sent_when_not_configured():
    client = FakeLiteLLMClient([text_response("ok")])
    await run(build_model(settings(LLM_API_KEY=None, LLM_API_BASE=None), client=client))
    assert "api_key" not in client.requests[0]
    assert "api_base" not in client.requests[0]


async def test_tools_are_declared_to_the_provider_in_openai_format():
    client = FakeLiteLLMClient([text_response("ok")])
    await run(build_model(settings(), client=client))
    tools = {t["function"]["name"]: t["function"]["parameters"] for t in client.requests[0]["tools"]}
    assert list(tools) == [
        "get_catalog",
        "save_diary",
        "save_workout",
        "save_food",
        "get_exercise_history",
        "get_diary_history",
        "get_phase",
        "get_week",
    ]
    assert "exercises" in tools["save_workout"]["properties"]
    assert "complete" in tools["save_workout"]["properties"]
    assert "items" in tools["save_food"]["properties"]
    assert tools["get_diary_history"]["required"] == ["date_from", "date_to"]


async def test_a_rejected_payload_goes_back_to_the_model_through_litellm():
    rejected = {
        "ok": False,
        "errors": [{"path": "args.fields.sleepH", "code": "wrong_type", "message": "número"}],
    }
    written = {"ok": True, "result": {"date": "2026-09-22", "row": 6, "fields": {"sleepH": 7.5}}}
    client = FakeLiteLLMClient(
        [
            tool_call_response("save_diary", {"date": "2026-09-22", "fields": {"sleepH": "7h30"}}, "c1"),
            tool_call_response("save_diary", {"date": "2026-09-22", "fields": {"sleepH": 7.5}}, "c2"),
            text_response("ok"),
        ]
    )
    sheet = FakeSheet(diary_upsert=[rejected, written])
    reply = await Bot(sheet, build_model(settings(), client=client), timezone="America/Sao_Paulo").reply(
        "dormi 7h30"
    )
    assert reply.text == "<b>22/09</b> · Sono h 7,5"
    tool_message = client.requests[1]["messages"][-1]
    assert tool_message["role"] == "tool"
    assert json.loads(tool_message["content"]) == rejected


async def test_a_litellm_timeout_is_reported_after_what_was_written():
    client = FakeLiteLLMClient(
        [
            tool_call_response("save_diary", {"date": "2026-09-21", "fields": {"weightKg": 82.4}}),
            litellm.Timeout("timed out", model="claude-sonnet-5", llm_provider="anthropic"),
        ]
    )
    assert (
        await run(build_model(settings(), client=client)) == f"<b>21/09</b> · Peso kg 82,4\n\n{MODEL_FAILED}"
    )


def overloaded() -> Exception:
    return litellm.ServiceUnavailableError(
        "This model is currently experiencing high demand.", llm_provider="gemini", model="gemini-3.8-flash"
    )


async def test_an_overloaded_model_is_tried_again_and_the_reply_arrives():
    client = FakeLiteLLMClient([overloaded(), overloaded(), text_response("ok")])
    model = build_model(settings(LLM_RETRIES=2, LLM_RETRY_WAIT_S=0), client=client)
    assert await run(model) == "ok"
    assert [r["model"] for r in client.requests] == ["anthropic/claude-sonnet-5"] * 3


async def test_after_the_retries_the_fallback_model_answers():
    client = FakeLiteLLMClient([overloaded(), overloaded(), text_response("ok")])
    model = build_model(
        settings(LLM_RETRIES=1, LLM_RETRY_WAIT_S=0, LLM_FALLBACK_MODEL="anthropic/claude-haiku-5-5"),
        client=client,
    )
    assert await run(model) == "ok"
    assert [r["model"] for r in client.requests] == [
        "anthropic/claude-sonnet-5",
        "anthropic/claude-sonnet-5",
        "anthropic/claude-haiku-5-5",
    ]


async def test_a_rate_limit_is_transient_too_but_without_a_fallback_the_failure_is_reported():
    limited = litellm.RateLimitError("quota", llm_provider="gemini", model="gemini-3.8-flash")
    client = FakeLiteLLMClient([limited, overloaded()])
    model = build_model(settings(LLM_RETRIES=1, LLM_RETRY_WAIT_S=0, LLM_FALLBACK_MODEL=None), client=client)
    assert await run(model) == MODEL_FAILED_NOTHING_WRITTEN
    assert len(client.requests) == 2


async def test_a_request_the_provider_rejects_is_not_repeated():
    bad = litellm.BadRequestError("invalid schema", model="gemini-3.8-flash", llm_provider="gemini")
    client = FakeLiteLLMClient([bad])
    model = build_model(
        settings(LLM_RETRIES=2, LLM_RETRY_WAIT_S=0, LLM_FALLBACK_MODEL="anthropic/claude-haiku-5-5"),
        client=client,
    )
    assert await run(model) == MODEL_FAILED_NOTHING_WRITTEN
    assert len(client.requests) == 1


async def test_every_model_call_carries_the_configured_timeout():
    client = FakeLiteLLMClient([text_response("ok")])
    await run(build_model(settings(LLM_TIMEOUT_S=30), client=client))
    assert client.requests[0]["timeout"] == 30


async def test_a_model_that_times_out_is_not_repeated_the_fallback_answers_at_once():
    hung = litellm.Timeout("timed out", model="gemini-3.8-flash", llm_provider="gemini")
    client = FakeLiteLLMClient([hung, text_response("ok")])
    model = build_model(
        settings(LLM_RETRIES=2, LLM_RETRY_WAIT_S=0, LLM_FALLBACK_MODEL="anthropic/claude-haiku-5-5"),
        client=client,
    )
    assert await run(model) == "ok"
    assert [r["model"] for r in client.requests] == [
        "anthropic/claude-sonnet-5",
        "anthropic/claude-haiku-5-5",
    ]


async def test_a_fallback_of_another_provider_uses_its_own_key_and_not_the_primary_base():
    client = FakeLiteLLMClient([overloaded(), text_response("ok")])
    model = build_model(
        settings(
            LLM_MODEL="gemini/gemini-3.8-flash",
            LLM_API_KEY=SecretStr("gemini-key"),
            LLM_API_BASE="http://proxy:4000",
            LLM_RETRIES=0,
            LLM_RETRY_WAIT_S=0,
            LLM_FALLBACK_MODEL="anthropic/claude-haiku-5-5",
            LLM_FALLBACK_API_KEY=SecretStr("anthropic-key"),
        ),
        client=client,
    )
    assert await run(model) == "ok"
    primary, fallback = client.requests
    assert (primary["model"], primary["api_key"], primary["api_base"]) == (
        "gemini/gemini-3.8-flash",
        "gemini-key",
        "http://proxy:4000",
    )
    assert (fallback["model"], fallback["api_key"]) == ("anthropic/claude-haiku-5-5", "anthropic-key")
    assert "api_base" not in fallback


async def test_the_sdk_does_not_retry_on_its_own():
    client = FakeLiteLLMClient([text_response("ok")])
    await run(build_model(settings(), client=client))
    assert (client.requests[0]["num_retries"], client.requests[0]["max_retries"]) == (0, 0)


class SlowClient(FakeLiteLLMClient):
    async def acompletion(self, model: Any, messages: Any, tools: Any, **kwargs: Any) -> Any:
        await asyncio.sleep(10)
        return text_response("late")


async def test_a_message_that_outlives_its_deadline_is_answered_with_the_model_failure():
    bot = Bot(
        FakeSheet(), build_model(settings(), client=SlowClient([])), "America/Sao_Paulo", deadline_s=0.2
    )
    started = asyncio.get_running_loop().time()
    reply = await bot.reply("peso 82,4")
    assert reply.text == MODEL_FAILED_NOTHING_WRITTEN
    assert reply.failed
    assert asyncio.get_running_loop().time() - started < 3


class Stream:
    """An async stream that raises `error` after yielding `chunks`."""

    def __init__(self, chunks: list[Any], error: Exception | None = None) -> None:
        self.chunks = list(chunks)
        self.error = error

    def __aiter__(self) -> "Stream":
        return self

    async def __anext__(self) -> Any:
        if self.chunks:
            return self.chunks.pop(0)
        if self.error is not None:
            error, self.error = self.error, None
            raise error
        raise StopAsyncIteration


async def drain(stream: Any) -> list[Any]:
    return [chunk async for chunk in stream]


async def test_a_stream_that_fails_before_its_first_chunk_is_tried_again():
    client = FakeLiteLLMClient([Stream([], overloaded()), Stream(["a", "b"])])
    retrying = RetryingClient(client, retries=1, wait_s=0)
    assert await drain(await retrying.acompletion("m", [], None, stream=True)) == ["a", "b"]
    assert len(client.requests) == 2


async def test_a_stream_that_fails_after_a_chunk_is_not_repeated():
    client = FakeLiteLLMClient([Stream(["a"], overloaded()), Stream(["x"])])
    retrying = RetryingClient(client, retries=2, wait_s=0, fallback_model="f")
    stream = await retrying.acompletion("m", [], None, stream=True)
    with pytest.raises(litellm.ServiceUnavailableError):
        await drain(stream)
    assert len(client.requests) == 1


async def media_request(media: Media, caption: str = "") -> list:
    client = FakeLiteLLMClient([text_response("ok")])
    bot = Bot(FakeSheet(), build_model(settings(LLM_MODEL="gemini/gemini-3.8-flash"), client=client), "UTC")
    await bot.reply(caption, media=[media])
    user = [m for m in client.requests[0]["messages"] if m["role"] == "user"][-1]
    return user["content"]


async def test_a_photo_reaches_litellm_as_an_image_url_data_uri():
    content = await media_request(Media("image/jpeg", b"\xff\xd8"), "balança")
    assert content == [
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9g="}},
        {"type": "text", "text": "[Anexo: foto]\nbalança"},
    ]


async def test_a_voice_message_reaches_litellm_as_input_audio_in_ogg_format():
    content = await media_request(Media("audio/ogg", b"OggS"))
    assert content == [
        {"type": "input_audio", "input_audio": {"data": "T2dnUw==", "format": "ogg"}},
        {"type": "text", "text": "[Anexo: áudio]"},
    ]


async def test_a_media_type_adk_cannot_convert_asks_for_text():
    client = FakeLiteLLMClient([text_response("ok")])
    bot = Bot(FakeSheet(), build_model(settings(), client=client), "UTC")
    assert (await bot.reply("", media=[Media("application/x-unknown", b"??")])).text == MEDIA_UNREADABLE
    assert client.requests == []  # refused while converting, before any provider call
