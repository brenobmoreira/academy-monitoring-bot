import json
import traceback

import httpx
import pytest

from agent.telegram import TelegramClient, TelegramError

pytestmark = pytest.mark.unit


def client(handler):
    return TelegramClient("tok", httpx.AsyncClient(transport=httpx.MockTransport(handler)))


async def test_send_message_posts_plain_text_and_returns_the_sent_message():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 7, "text": "oi"}})

    assert await client(handler).send_message(42, "oi") == {"message_id": 7, "text": "oi"}
    assert seen["url"] == "https://api.telegram.org/bottok/sendMessage"
    assert seen["body"] == {"chat_id": 42, "text": "oi"}


async def test_send_message_options_map_to_the_bot_api_fields():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 8}})

    markup = {"inline_keyboard": [[{"text": "Ok", "callback_data": "ok"}]]}
    await client(handler).send_message(42, "<b>21/09</b>", html=True, reply_markup=markup, reply_to=5)
    assert seen["body"] == {
        "chat_id": 42,
        "text": "<b>21/09</b>",
        "parse_mode": "HTML",
        "reply_markup": markup,
        "reply_parameters": {"message_id": 5, "allow_sending_without_reply": True},
    }


async def test_send_chat_action_posts_typing_by_default():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True, "result": True})

    await client(handler).send_chat_action(42)
    assert seen["url"] == "https://api.telegram.org/bottok/sendChatAction"
    assert seen["body"] == {"chat_id": 42, "action": "typing"}


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


async def test_set_my_commands_sends_the_menu():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True, "result": True})

    await client(handler).set_my_commands([("hoje", "o dia"), ("help", "ajuda")])
    assert seen["url"] == "https://api.telegram.org/bottok/setMyCommands"
    assert seen["body"] == {
        "commands": [{"command": "hoje", "description": "o dia"}, {"command": "help", "description": "ajuda"}]
    }


async def test_get_file_asks_for_the_file_path():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        result = {"file_id": "v1", "file_size": 9000, "file_path": "voice/file_3.oga"}
        return httpx.Response(200, json={"ok": True, "result": result})

    assert (await client(handler).get_file("v1"))["file_path"] == "voice/file_3.oga"
    assert seen["url"] == "https://api.telegram.org/bottok/getFile"
    assert seen["body"] == {"file_id": "v1"}


async def test_download_file_gets_the_bytes_from_the_file_endpoint():
    seen = {}

    def handler(request):
        seen["method"] = request.method
        seen["url"] = str(request.url)
        return httpx.Response(200, content=b"OggS\x00")

    assert await client(handler).download_file("voice/file_3.oga") == b"OggS\x00"
    assert seen == {"method": "GET", "url": "https://api.telegram.org/file/bottok/voice/file_3.oga"}


def not_found(request):
    return httpx.Response(404, text="Not Found: https://api.telegram.org/file/bottok/x")


def unreachable(request):
    raise httpx.ConnectError("cannot reach https://api.telegram.org/file/bottok/x", request=request)


@pytest.mark.parametrize("handler", [not_found, unreachable])
async def test_download_errors_never_carry_the_token(handler):
    with pytest.raises(TelegramError) as caught:
        await client(handler).download_file("voice/x.oga")
    logged = "".join(traceback.format_exception(caught.value))  # what log.exception would print
    assert "bottok" not in logged
