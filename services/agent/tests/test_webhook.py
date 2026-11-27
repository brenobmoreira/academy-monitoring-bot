import pytest
from flask import Request
from pydantic import SecretStr
from starlette.testclient import TestClient
from werkzeug.test import EnvironBuilder

from agent import asgi, main, miniapp, webhook
from agent import handler as handler_module
from agent.settings import Settings

from .fakes import FakeSheet, FakeTelegram, ScriptedLlm, call, say

pytestmark = pytest.mark.unit

SETTINGS = Settings.model_construct(
    None,
    TELEGRAM_BOT_TOKEN=SecretStr("tok"),
    ALLOWED_CHAT_IDS=frozenset({42}),
    SHEET_API_URL="https://x/exec",
    SHEET_API_KEY=SecretStr("k"),
    TELEGRAM_WEBHOOK_SECRET=SecretStr("sec"),
)


@pytest.fixture
def handled(monkeypatch):
    seen = []

    async def fake_handle(settings, update):
        seen.append(update)

    monkeypatch.setattr(webhook, "get_settings", lambda: SETTINGS)
    monkeypatch.setattr(webhook, "handle_update", fake_handle)
    return seen


async def test_process_handles_updates_with_the_right_secret(handled):
    assert await webhook.process("sec", {"update_id": 1}) == ("ok", 200)
    assert handled == [{"update_id": 1}]


@pytest.mark.parametrize("secret", ["nope", None, ""])
async def test_process_rejects_a_wrong_or_missing_secret(handled, secret):
    assert await webhook.process(secret, {"update_id": 1}) == ("forbidden", 403)
    assert handled == []


async def test_process_fails_closed_without_a_configured_secret(handled, monkeypatch):
    monkeypatch.setattr(
        webhook, "get_settings", lambda: SETTINGS.model_copy(update={"TELEGRAM_WEBHOOK_SECRET": None})
    )
    assert (await webhook.process("sec", {"update_id": 1}))[1] == 403


async def test_process_acknowledges_and_ignores_non_object_bodies(handled):
    assert await webhook.process("sec", [1, 2]) == ("ok", 200)
    assert handled == []


# ---- both servers give the same answers -----------------------------------------------------


def functions_framework_call(secret, body):
    headers = {webhook.SECRET_HEADER: secret} if secret is not None else {}
    environ = EnvironBuilder(method="POST", headers=list(headers.items()), json=body).get_environ()
    return main.telegram_webhook(Request(environ))


def uvicorn_call(secret, body):
    headers = {webhook.SECRET_HEADER: secret} if secret is not None else {}
    response = TestClient(asgi.app).post("/", headers=headers, json=body)
    return response.text, response.status_code


@pytest.mark.parametrize("call", [functions_framework_call, uvicorn_call])
def test_both_entry_points_behave_the_same(handled, call):
    assert call("sec", {"update_id": 7}) == ("ok", 200)
    assert call("wrong", {"update_id": 8}) == ("forbidden", 403)
    assert handled == [{"update_id": 7}]


def test_asgi_health_check_and_bad_json():
    client = TestClient(asgi.app)
    assert client.get("/healthz").text == "ok"


def test_asgi_ignores_a_body_that_is_not_json(handled):
    response = TestClient(asgi.app).post("/", headers={webhook.SECRET_HEADER: "sec"}, content=b"{nope")
    assert (response.text, response.status_code) == ("ok", 200)
    assert handled == []


@pytest.mark.parametrize("verb", ["dok", "dfix"])
async def test_a_draft_survives_into_the_next_webhook_request(monkeypatch, verb):
    """One handler is built per request: the draft proposed by one must be there for the tap."""
    items = [{"food": "Arroz branco cozido", "qty": 150, "unit": "g"}]
    catalog = {"ok": True, "result": {"foods": ["Arroz branco cozido"], "today": "2026-09-21"}}
    written = {"writeId": "w1", "date": "2026-09-21", "meal": "Almoço", "items": items}
    sheet = FakeSheet(catalog=[catalog], food_add=[{"ok": True, "result": written}])
    tg = FakeTelegram()
    llm = ScriptedLlm(
        model="scripted",
        script=[call("propose_food", date="2026-09-21", meal="Almoço", items=items), say("ok")],
        requests=[],
    )
    monkeypatch.setattr(handler_module, "SheetClient", lambda *args: sheet)
    monkeypatch.setattr(handler_module, "TelegramClient", lambda *args: tg)
    monkeypatch.setattr(handler_module, "build_model", lambda settings: llm)
    monkeypatch.setattr(webhook, "_FOOD_DRAFTS", miniapp.FoodDraftStore())
    monkeypatch.setattr(webhook, "_DEDUPLICATOR", handler_module.UpdateDeduplicator())
    settings = SETTINGS.model_copy(update={"MEDIA_ENABLED": False, "MINIAPP_URL": "https://x.test/app/"})

    await webhook.handle_update(
        settings, {"update_id": 901, "message": {"chat": {"id": 42}, "text": "estima meu almoço"}}
    )
    keyboard = tg.options[-1]["reply_markup"]["inline_keyboard"]
    data = keyboard[0][0 if verb == "dok" else 1]["callback_data"]
    assert data.startswith(f"{verb}:")
    await webhook.handle_update(
        settings,
        {
            "update_id": 902,
            "callback_query": {
                "id": "c",
                "data": data,
                "message": {"message_id": 1, "chat": {"id": 42}},
            },
        },
    )

    assert tg.sent[-1][1] != miniapp.DRAFT_EXPIRED
    if verb == "dok":
        assert [op for op, _ in sheet.calls] == ["food.add"]
    else:
        assert tg.options[-1]["reply_markup"]["keyboard"][0][0]["text"] == miniapp.DRAFT_ADJUST_BUTTON


def test_the_webhook_stores_are_shared_by_the_whole_process():
    assert isinstance(webhook._FOOD_DRAFTS, miniapp.FoodDraftStore)
    assert isinstance(webhook._PENDING, miniapp.PendingStore)
