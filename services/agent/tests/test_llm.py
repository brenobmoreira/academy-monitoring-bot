import json
from typing import Any

import pytest
from pydantic import SecretStr

from agent.bot import Bot
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
    assert reply == "22/09 · Sono h 7,5"
    tool_message = client.requests[1]["messages"][-1]
    assert tool_message["role"] == "tool"
    assert json.loads(tool_message["content"]) == rejected
