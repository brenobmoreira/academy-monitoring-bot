from datetime import datetime

import pytest

from agent.commands import help_text
from agent.handler import FAILURE, Handler

from .fakes import FakeSheet

pytestmark = pytest.mark.unit


class FakeBot:
    def __init__(self, reply="ok", error=None):
        self.texts = []
        self._reply = reply
        self._error = error

    async def reply(self, text, user_id="telegram"):
        self.texts.append((text, user_id))
        if self._error:
            raise self._error
        return self._reply


class FakeTelegram:
    def __init__(self, error=None):
        self.sent = []
        self._error = error

    async def send_message(self, chat_id, text):
        if self._error:
            raise self._error
        self.sent.append((chat_id, text))


def update(text="peso 82", chat_id=42):
    return {"update_id": 1, "message": {"chat": {"id": chat_id}, "text": text}}


async def test_runs_the_bot_and_replies_in_the_same_chat():
    bot, tg = FakeBot("21/09 · Peso kg 82"), FakeTelegram()
    await Handler({42}, bot, tg).handle_update(update())
    assert bot.texts == [("peso 82", "42")]
    assert tg.sent == [(42, "21/09 · Peso kg 82")]


@pytest.mark.parametrize(
    "u",
    [
        update(chat_id=7),
        update(text="   "),
        {"update_id": 1, "message": {"chat": {"id": 42}}},
        {"update_id": 1},
        {},
    ],
)
async def test_ignores_other_chats_and_non_text_updates(u):
    bot, tg = FakeBot(), FakeTelegram()
    await Handler({42}, bot, tg).handle_update(u)
    assert bot.texts == []
    assert tg.sent == []


async def test_start_and_help_answer_without_the_model():
    bot, tg = FakeBot(), FakeTelegram()
    await Handler({42}, bot, tg).handle_update(update("/start"))
    await Handler({42}, bot, tg).handle_update(update("/help@fitness_bot"))
    assert bot.texts == []
    assert tg.sent == [(42, help_text()), (42, help_text())]


async def test_commands_read_the_sheet_for_the_configured_day_and_skip_the_model():
    bot, tg = FakeBot(), FakeTelegram()
    empty = {"ok": True, "result": {"date": "2026-09-20", "diary": {}, "workout": []}}
    sheet = FakeSheet(day_get=[empty])
    handler = Handler({42}, bot, tg, sheet=sheet, clock=lambda: datetime(2026, 9, 21, 0, 30))
    await handler.handle_update(update("/hoje@fitness_bot ontem"))
    assert bot.texts == []
    assert sheet.calls == [("day.get", {"date": "2026-09-20"})]
    assert tg.sent == [(42, "Nada registrado em 20/09.")]


async def test_unregistered_slash_words_still_go_to_the_model():
    bot, tg = FakeBot(), FakeTelegram()
    await Handler({42}, bot, tg).handle_update(update("/peso 82"))
    assert bot.texts == [("/peso 82", "42")]


async def test_a_failing_command_becomes_the_short_warning():
    bot, tg = FakeBot(), FakeTelegram()
    await Handler({42}, bot, tg).handle_update(update("/ficha"))  # no sheet API configured
    assert tg.sent == [(42, FAILURE)]


async def test_bot_failures_become_a_short_warning():
    bot, tg = FakeBot(error=RuntimeError("vertex down")), FakeTelegram()
    await Handler({42}, bot, tg).handle_update(update())
    assert tg.sent[0][1].startswith("⚠")


async def test_never_raises_even_when_telegram_fails():
    await Handler({42}, FakeBot(), FakeTelegram(error=RuntimeError("net"))).handle_update(update())
