import pytest
from flask import Request
from pydantic import SecretStr
from starlette.testclient import TestClient
from werkzeug.test import EnvironBuilder

from agent import asgi, main, webhook
from agent.settings import Settings

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
    environ = EnvironBuilder(method="POST", headers=headers, json=body).get_environ()
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
