import json

import httpx
import pytest

from agent.telegram import TelegramClient, TelegramError

pytestmark = pytest.mark.unit


def client(handler):
    return TelegramClient("tok", httpx.AsyncClient(transport=httpx.MockTransport(handler)))


async def test_send_message_posts_to_the_bot_api_and_truncates():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True, "result": {}})

    await client(handler).send_message(42, "x" * 5000)
    assert seen["url"] == "https://api.telegram.org/bottok/sendMessage"
    assert seen["body"]["chat_id"] == 42
    assert len(seen["body"]["text"]) == 4096


async def test_get_updates_returns_results_and_passes_offset():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True, "result": [{"update_id": 5}]})

    assert await client(handler).get_updates(offset=5, wait=1) == [{"update_id": 5}]
    assert seen["body"] == {"offset": 5, "timeout": 1, "allowed_updates": ["message"]}


async def test_api_errors_raise_with_the_description():
    def handler(request):
        return httpx.Response(
            409, json={"ok": False, "description": "Conflict: can't use getUpdates while webhook is active"}
        )

    with pytest.raises(TelegramError, match="webhook is active"):
        await client(handler).get_updates()
