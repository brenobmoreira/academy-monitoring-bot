import asyncio
from datetime import datetime

import pytest

from agent.bot import Answer
from agent.buttons import FIX_PLACEHOLDER, FIX_PROMPT, keyboard
from agent.commands import Reply, help_text
from agent.handler import FAILURE, Handler
from agent.undo import ALREADY, SHEET_DOWN

from .fakes import FakeSheet

pytestmark = pytest.mark.unit


class FakeBot:
    def __init__(self, reply="ok", error=None, seconds=0.0, events=None):
        self.texts = []
        self._reply = reply if isinstance(reply, Answer) else Answer(reply)
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
    def __init__(self, error=None, action_error=None, events=None, edit_error=None):
        self.sent = []
        self.actions = []
        self.options = []
        self.answered = []
        self.edited = []
        self._error = error
        self._action_error = action_error
        self._edit_error = edit_error
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

    async def answer_callback_query(self, callback_query_id, text=None):
        self.answered.append((callback_query_id, text))

    async def edit_message_reply_markup(self, chat_id, message_id, reply_markup=None):
        if self._edit_error:
            raise self._edit_error
        self.edited.append((chat_id, message_id, reply_markup))


def update(text="peso 82", chat_id=42):
    return {"update_id": 1, "message": {"chat": {"id": chat_id}, "text": text}}


CONFIRMATION = "21/09 · Peso kg 82,4"


def tap(data, chat_id=42, message_id=9, text=CONFIRMATION):
    message = {"message_id": message_id, "chat": {"id": chat_id}, "text": text}
    return {"update_id": 2, "callback_query": {"id": "cb1", "data": data, "message": message}}


def undone(date="2026-09-21", **fields):
    return {"ok": True, "result": {"writeId": "w", "undone": {"op": "diary.upsert", "date": date, **fields}}}


def refused(code, message="m"):
    return {"ok": False, "errors": [{"path": "args.writeId", "code": code, "message": message}]}


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
    await handler._send(42, Reply("\n".join(lines), html=True, reply_markup={"inline_keyboard": []}))
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
    assert tg.sent == [(42, help_text()), (42, help_text())]
    assert tg.actions == []


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


async def test_desfazer_undoes_through_the_sheet_without_the_model():
    undone = {"op": "diary.upsert", "date": "2026-09-24", "fields": ["weightKg"]}
    sheet = FakeSheet(write_undo=[{"ok": True, "result": {"writeId": "w1", "undone": undone}}])
    bot, tg = FakeBot(), FakeTelegram()
    await Handler({42}, bot, tg, sheet=sheet).handle_update(update("/desfazer@fitness_bot"))
    assert bot.texts == []
    assert sheet.calls == [("write.undo", {})]
    assert tg.sent == [(42, "↩️ Desfeito: 24/09 · Diário (Peso kg)")]


async def test_desfazer_failures_become_the_short_warning():
    class BrokenSheet(FakeSheet):
        async def undo(self, write_id=None):
            raise RuntimeError("boom")

    tg = FakeTelegram()
    await Handler({42}, FakeBot(), tg, sheet=BrokenSheet()).handle_update(update("/desfazer"))
    assert tg.sent[0][1].startswith("⚠")


async def test_a_reply_that_wrote_gets_the_buttons_with_its_write_ids():
    bot, tg = FakeBot(Answer("<b>21/09</b> · Peso kg 82", ("w1", "w2"), wrote=True)), FakeTelegram()
    await Handler({42}, bot, tg).handle_update(update())
    markup = tg.options[0]["reply_markup"]
    assert markup == keyboard(["w1", "w2"])
    assert [b["callback_data"] for b in markup["inline_keyboard"][0]] == ["ok", "undo:w1,w2", "fix"]


async def test_a_reply_that_wrote_nothing_has_no_buttons():
    tg = FakeTelegram()
    await Handler({42}, FakeBot(Answer("Nada gravado.")), tg).handle_update(update("oi"))
    assert tg.options[0]["reply_markup"] is None


async def test_ok_removes_the_buttons():
    tg = FakeTelegram()
    await Handler({42}, FakeBot(), tg).handle_update(tap("ok"))
    assert tg.edited == [(42, 9, None)]
    assert tg.answered == [("cb1", None)]
    assert tg.sent == []


async def test_undo_undoes_every_write_newest_first_and_replies_to_the_confirmation():
    sheet = FakeSheet(
        write_undo=[
            undone(**{"op": "workout.upsert", "session": "Upper", "exercises": ["Supino"]}),
            undone(fields=["weightKg"]),
        ]
    )
    bot, tg = FakeBot(), FakeTelegram()
    await Handler({42}, bot, tg, sheet=sheet).handle_update(tap("undo:w1,w2"))
    assert sheet.calls == [("write.undo", {"writeId": "w2"}), ("write.undo", {"writeId": "w1"})]
    assert tg.edited == [(42, 9, None)]
    assert tg.sent == [(42, "↩️ Desfeito: 21/09 · Upper (Supino)\n↩️ Desfeito: 21/09 · Diário (Peso kg)")]
    assert tg.options[0]["reply_to"] == 9
    assert tg.answered == [("cb1", None)]
    assert bot.texts == []


async def test_undo_reports_each_refusal_in_portuguese():
    sheet = FakeSheet(
        write_undo=[
            refused("already_undone"),
            refused("conflict", "a linha 6 mudou"),
            refused("already_undone"),
        ]
    )
    tg = FakeTelegram()
    await Handler({42}, FakeBot(), tg, sheet=sheet).handle_update(tap("undo:w1,w2,w3"))
    assert tg.sent == [(42, f"{ALREADY}\n⚠ Não desfiz: a linha 6 mudou")]
    assert tg.edited == [(42, 9, None)]


async def test_undo_keeps_the_button_when_the_sheet_is_down():
    sheet = FakeSheet(write_undo=[undone(fields=["sleepH"]), refused("unavailable")])
    tg = FakeTelegram()
    await Handler({42}, FakeBot(), tg, sheet=sheet).handle_update(tap("undo:w1,w2"))
    assert len(sheet.calls) == 2
    assert tg.sent == [(42, f"↩️ Desfeito: 21/09 · Diário (Sono h)\n{SHEET_DOWN}")]
    assert tg.edited == []


async def test_fix_asks_for_the_correction_quoting_the_confirmation():
    tg = FakeTelegram()
    await Handler({42}, FakeBot(), tg).handle_update(tap("fix"))
    assert tg.sent == [(42, f"{FIX_PROMPT}:\n\n{CONFIRMATION}")]
    assert tg.options == [
        {
            "html": True,
            "reply_markup": {"force_reply": True, "input_field_placeholder": FIX_PLACEHOLDER},
            "reply_to": 9,
        }
    ]
    assert tg.edited == []
    assert tg.answered == [("cb1", None)]


async def test_the_quoted_confirmation_is_escaped_for_html():
    tg = FakeTelegram()
    await Handler({42}, FakeBot(), tg).handle_update(tap("fix", text="Upper: Supino <barra> & halter"))
    assert tg.sent == [(42, f"{FIX_PROMPT}:\n\nUpper: Supino &lt;barra&gt; &amp; halter")]


async def test_the_answer_to_the_fix_prompt_goes_to_the_model_like_any_message():
    bot, tg = FakeBot(), FakeTelegram()
    u = update("na verdade 82,6")
    u["message"]["reply_to_message"] = {"message_id": 10, "text": f"{FIX_PROMPT}:\n\n{CONFIRMATION}"}
    await Handler({42}, bot, tg).handle_update(u)
    assert bot.texts == [("na verdade 82,6", "42")]


async def test_taps_from_other_chats_are_answered_and_ignored():
    sheet = FakeSheet()
    tg = FakeTelegram()
    await Handler({42}, FakeBot(), tg, sheet=sheet).handle_update(tap("undo:w1", chat_id=7))
    assert sheet.calls == []
    assert tg.sent == tg.edited == []
    assert tg.answered == [("cb1", None)]


async def test_a_failing_tap_is_still_answered_with_the_warning():
    tg = FakeTelegram()
    await Handler({42}, FakeBot(), tg).handle_update(tap("undo:w1"))  # no sheet API configured
    assert tg.answered == [("cb1", FAILURE)]
    assert tg.sent == []


async def test_a_keyboard_that_cannot_be_edited_does_not_stop_the_undo():
    sheet = FakeSheet(write_undo=[undone(fields=["weightKg"])])
    tg = FakeTelegram(edit_error=RuntimeError("message is not modified"))
    await Handler({42}, FakeBot(), tg, sheet=sheet).handle_update(tap("undo:w1"))
    assert tg.sent == [(42, "↩️ Desfeito: 21/09 · Diário (Peso kg)")]
    assert tg.answered == [("cb1", None)]


async def test_unknown_buttons_are_only_answered():
    tg = FakeTelegram()
    await Handler({42}, FakeBot(), tg).handle_update(tap("weird:1"))
    assert tg.sent == tg.edited == []
    assert tg.answered == [("cb1", None)]
