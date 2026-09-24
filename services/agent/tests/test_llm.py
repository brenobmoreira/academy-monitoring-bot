import json
from typing import Any

import litellm
import pytest
from pydantic import SecretStr

from agent.bot import MEDIA_UNREADABLE, MODEL_FAILED, Bot, Media
from agent.llm import build_model
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
    return await Bot(FakeSheet(diary_upsert=[OK_DIARY]), model, timezone="America/Sao_Paulo").reply(text)


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
        "get_exercise_history",
        "get_diary_history",
    ]
    assert "exercises" in tools["save_workout"]["properties"]
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
    assert reply == "<b>22/09</b> · Sono h 7,5"
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
    assert await bot.reply("", media=[Media("application/x-unknown", b"??")]) == MEDIA_UNREADABLE
    assert client.requests == []  # refused while converting, before any provider call
