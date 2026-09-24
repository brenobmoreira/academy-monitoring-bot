import asyncio

import pytest

from agent.handler import HELP, Handler

pytestmark = pytest.mark.unit


class FakeBot:
    def __init__(self, reply="ok", error=None, seconds=0.0, events=None):
        self.texts = []
        self._reply = reply
        self._error = error
        self._seconds = seconds
        self._events = events if events is not None else []

    async def reply(self, text, user_id="telegram"):
        self.texts.append((text, user_id))
        self._events.append("bot")
        if self._seconds:
            await asyncio.sleep(self._seconds)
        if self._error:
            raise self._error
        return self._reply


class FakeTelegram:
    def __init__(self, error=None, action_error=None, events=None):
        self.sent = []
        self.actions = []
        self.options = []
        self._error = error
        self._action_error = action_error
        self._events = events if events is not None else []

    async def send_message(self, chat_id, text, *, html=False, reply_markup=None, reply_to=None):
        if self._error:
            raise self._error
        self.sent.append((chat_id, text))
        self.options.append({"html": html, "reply_markup": reply_markup, "reply_to": reply_to})
        return {"message_id": len(self.sent), "chat": {"id": chat_id}, "text": text}

    async def send_chat_action(self, chat_id, action="typing"):
        self.actions.append((chat_id, action))
        self._events.append(action)
        if self._action_error:
            raise self._action_error


def update(text="peso 82", chat_id=42):
    return {"update_id": 1, "message": {"chat": {"id": chat_id}, "text": text}}


async def test_runs_the_bot_and_replies_in_the_same_chat():
    bot, tg = FakeBot("21/09 · Peso kg 82"), FakeTelegram()
    await Handler({42}, bot, tg).handle_update(update())
    assert bot.texts == [("peso 82", "42")]
    assert tg.sent == [(42, "21/09 · Peso kg 82")]
    assert tg.options == [{"html": True, "reply_markup": None, "reply_to": None}]


async def test_long_replies_go_out_in_chunks_with_the_markup_on_the_last():
    lines = [f"linha {i:04d} " + "x" * 90 for i in range(100)]
    tg = FakeTelegram()
    handler = Handler({42}, FakeBot(), tg)
    await handler._send(42, "\n".join(lines), reply_markup={"inline_keyboard": []})
    assert len(tg.sent) == 3
    assert all(len(text) <= 4096 for _, text in tg.sent)
    assert "\n".join(text for _, text in tg.sent) == "\n".join(lines)
    assert [o["reply_markup"] for o in tg.options] == [None, None, {"inline_keyboard": []}]
    assert all(o["html"] for o in tg.options)


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
    assert tg.actions == []


async def test_start_and_help_answer_without_the_model():
    bot, tg = FakeBot(), FakeTelegram()
    await Handler({42}, bot, tg).handle_update(update("/start"))
    await Handler({42}, bot, tg).handle_update(update("/help@fitness_bot"))
    assert bot.texts == []
    assert tg.sent == [(42, HELP), (42, HELP)]
    assert tg.actions == []


async def test_bot_failures_become_a_short_warning():
    bot, tg = FakeBot(error=RuntimeError("vertex down")), FakeTelegram()
    await Handler({42}, bot, tg).handle_update(update())
    assert tg.sent[0][1].startswith("⚠")


async def test_never_raises_even_when_telegram_fails():
    await Handler({42}, FakeBot(), FakeTelegram(error=RuntimeError("net"))).handle_update(update())


async def test_shows_typing_before_the_bot_runs():
    events = []
    bot, tg = FakeBot(events=events), FakeTelegram(events=events)
    await Handler({42}, bot, tg).handle_update(update())
    assert events == ["typing", "bot"]
    assert tg.actions == [(42, "typing")]


async def test_keeps_typing_while_the_bot_runs_and_stops_after():
    bot, tg = FakeBot(seconds=0.05), FakeTelegram()
    await Handler({42}, bot, tg, typing_every=0.01).handle_update(update())
    count = len(tg.actions)
    assert count >= 3
    await asyncio.sleep(0.03)
    assert len(tg.actions) == count
    assert tg.sent == [(42, "ok")]


async def test_a_failing_typing_action_does_not_affect_the_reply():
    bot, tg = FakeBot(seconds=0.05), FakeTelegram(action_error=RuntimeError("net"))
    await Handler({42}, bot, tg, typing_every=0.01).handle_update(update())
    assert tg.actions == [(42, "typing")]  # gives up after the first failure
    assert tg.sent == [(42, "ok")]
