import dataclasses

import pytest
from flask import Request

from agent import main
from agent.config import Settings

pytestmark = pytest.mark.unit

SETTINGS = Settings(
    telegram_bot_token="tok",
    allowed_chat_ids=frozenset({42}),
    sheet_api_url="https://x/exec",
    sheet_api_key="k",
    telegram_webhook_secret="sec",
)


@pytest.fixture
def handled(monkeypatch):
    seen = []

    async def fake_handle(settings, update):
        seen.append(update)

    monkeypatch.setattr(main, "_settings", lambda: SETTINGS)
    monkeypatch.setattr(main, "_handle", fake_handle)
    return seen


def request(secret="sec", body=None):
    headers = {"X-Telegram-Bot-Api-Secret-Token": secret} if secret is not None else {}
    return Request.from_values(
        method="POST", headers=headers, json=body if body is not None else {"update_id": 1}
    )


def test_handles_updates_with_the_right_secret(handled):
    assert main.telegram_webhook(request()) == ("ok", 200)
    assert handled == [{"update_id": 1}]


@pytest.mark.parametrize("secret", ["nope", None, ""])
def test_rejects_a_wrong_or_missing_secret(handled, secret):
    assert main.telegram_webhook(request(secret=secret))[1] == 403
    assert handled == []


def test_fails_closed_without_a_configured_secret(handled, monkeypatch):
    monkeypatch.setattr(
        main, "_settings", lambda: dataclasses.replace(SETTINGS, telegram_webhook_secret=None)
    )
    assert main.telegram_webhook(request())[1] == 403


def test_non_object_bodies_are_acknowledged_and_ignored(handled):
    assert main.telegram_webhook(request(body=[1, 2])) == ("ok", 200)
    assert handled == []
