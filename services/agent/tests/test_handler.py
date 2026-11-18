import asyncio
from datetime import datetime

import pytest

from agent import handler as handler_module
from agent.bot import (
    MEDIA_DISABLED,
    MEDIA_UNREADABLE,  # noqa: F401
    MODEL_FAILED,
    MODEL_FAILED_NOTHING_WRITTEN,
    SHEET_FAILED,
    VOICE_BUDGET,
    VOICE_EMPTY,
    VOICE_FAILED,
    VOICE_FORMAT,
    VOICE_TOO_LONG,
    Answer,
    Media,
)
from agent.buttons import FIX_PLACEHOLDER, FIX_PROMPT, entendi_text, keyboard, voice_keyboard
from agent.commands import Reply, help_text
from agent.handler import CUT, DOWNLOAD_FAILED, FAILURE, Handler, UpdateDeduplicator, media_ref, too_large
from agent.transcribe import Audio, TranscribeError, Transcript
from agent.undo import ALREADY, SHEET_DOWN
from agent.voice_confirm import VoiceConfirmations, sha256_hex

from .fakes import FakeSheet, FakeTelegram, file, media_update

pytestmark = pytest.mark.unit


class FakeTranscriber:
    def __init__(self, text="peso 82,4", error=None):
        self.calls: list[tuple[Audio, str, float | None]] = []
        self._text = text
        self._error = error

    async def transcribe(self, audio: Audio, *, principal_key: str, deadline_s: float | None = None):
        self.calls.append((audio, principal_key, deadline_s))
        if self._error is not None:
            raise self._error
        return Transcript(self._text, "gemini/gemini-3.8-flash", None, False)


class FakeBot:
    def __init__(self, reply="ok", error=None, seconds=0.0, events=None):
        self.texts = []
        self.media = []
        self.contexts = []
        self._reply = reply if isinstance(reply, Answer) else Answer(reply)
        self._error = error
        self._seconds = seconds
        self._events = events if events is not None else []

    async def reply(self, text, user_id="telegram", *, context=None, media=None):
        self.texts.append((text, user_id))
        self.contexts.append(context)
        self.media.append(media)
        self._events.append("bot")
        if self._seconds:
            await asyncio.sleep(self._seconds)
        if self._error:
            raise self._error
        return self._reply


def update(text="peso 82", chat_id=42, update_id=1):
    return {"update_id": update_id, "message": {"chat": {"id": chat_id}, "text": text}}


CONFIRMATION = "21/09 · Peso kg 82,4"


def tap(data, chat_id=42, message_id=9, text=CONFIRMATION):
    message = {"message_id": message_id, "chat": {"id": chat_id}, "text": text}
    return {"update_id": 2, "callback_query": {"id": "cb1", "data": data, "message": message}}


def undone(date="2026-09-21", **fields):
    return {"ok": True, "result": {"writeId": "w", "undone": {"op": "diary.upsert", "date": date, **fields}}}


def refused(code, message="m"):
    return {"ok": False, "errors": [{"path": "args.writeId", "code": code, "message": message}]}


class DeadlineBot(FakeBot):
    """Records how much of the message deadline is left when the bot starts."""

    async def reply(self, text, user_id="telegram", *, context=None, media=None):
        from agent.bot import MESSAGE_DEADLINE_AT

        at = MESSAGE_DEADLINE_AT.get()
        self.left = None if at is None else at - asyncio.get_running_loop().time()
        return await super().reply(text, user_id, context=context, media=media)


class SlowDownloadTelegram(FakeTelegram):
    def __init__(self, seconds, **kwargs):
        super().__init__(**kwargs)
        self._seconds = seconds

    async def download_file(self, file_path):
        await asyncio.sleep(self._seconds)
        return await super().download_file(file_path)


VOICE = {"file_id": "v1", "file_unique_id": "u1", "duration": 3, "mime_type": "audio/ogg", "file_size": 10}


def voice_update():
    return {"update_id": 7, "message": {"chat": {"id": 42}, "voice": VOICE}}


async def test_the_message_deadline_counts_from_receipt_and_the_download_uses_part_of_it():
    tg = SlowDownloadTelegram(0.2, files={"v1": ({"file_path": "voice/1.oga", "file_size": 10}, b"ogg")})
    transcriber = FakeTranscriber("peso 82")
    bot = DeadlineBot()
    await Handler({42}, bot, tg, transcriber=transcriber, message_deadline_s=1.0).handle_update(
        voice_update()
    )
    assert bot.texts == []
    [(_, principal_key, left)] = transcriber.calls
    assert principal_key == "telegram:42"
    assert left is not None and 0 < left < 0.85
    assert tg.sent

    # Photos still share the same message deadline directly with Bot.reply.
    photo_tg = SlowDownloadTelegram(
        0.2, files={"p1": ({"file_path": "photos/1.jpg", "file_size": 10}, b"jpg")}
    )
    photo_bot = DeadlineBot()
    await Handler({42}, photo_bot, photo_tg, message_deadline_s=1.0).handle_update(
        media_update(photo=[{"file_id": "p1", "width": 90, "height": 90, "file_size": 10}])
    )
    assert photo_bot.left is not None and 0 < photo_bot.left < 0.85


async def test_a_download_that_outlives_the_deadline_gets_the_download_failure_reply():
    tg = SlowDownloadTelegram(5, files={"v1": ({"file_path": "voice/1.oga", "file_size": 10}, b"ogg")})
    started = asyncio.get_running_loop().time()
    await Handler({42}, FakeBot(), tg, message_deadline_s=0.2).handle_update(voice_update())
    assert tg.sent == [(42, DOWNLOAD_FAILED)]
    assert asyncio.get_running_loop().time() - started < 3


class SlowSheet(FakeSheet):
    """/hoje's sheet call takes 5 s."""

    async def day(self, date):
        await asyncio.sleep(5)
        return await super().day(date)


class SlowSendTelegram(FakeTelegram):
    async def send_message(self, chat_id, text, *, html=False, reply_markup=None, reply_to=None):
        await asyncio.sleep(5)
        return await super().send_message(
            chat_id, text, html=html, reply_markup=reply_markup, reply_to=reply_to
        )


class SlowUndoSheet(FakeSheet):
    """Each undo is applied, then the answer takes 5 s."""

    async def undo(self, write_id=None):
        response = await super().undo(write_id)
        await asyncio.sleep(5)
        return response


async def test_a_slow_command_is_cut_and_the_person_is_told():
    tg = FakeTelegram()
    handler = Handler({42}, FakeBot(), tg, sheet=SlowSheet(), message_deadline_s=0.05, send_reserve_s=0.1)
    started = asyncio.get_running_loop().time()
    await handler.handle_update(update("/hoje"))
    assert asyncio.get_running_loop().time() - started < 2
    assert tg.sent == [(42, CUT)]


async def test_a_cut_undo_is_never_run_again():
    sheet = SlowUndoSheet(**{"write.undo": [undone()]})
    tg = FakeTelegram()
    handler = Handler({42}, FakeBot(), tg, sheet=sheet, message_deadline_s=0.05, send_reserve_s=0.1)
    await handler.handle_update(update("/desfazer", update_id=30))
    await handler.handle_update(update("/desfazer", update_id=30))  # the same update delivered again
    assert [op for op, _ in sheet.calls] == ["write.undo"]
    assert tg.sent == [(42, CUT)]


async def test_a_cut_button_tap_stops_the_spinner_with_the_notice():
    sheet = SlowUndoSheet(**{"write.undo": [undone()]})
    tg = FakeTelegram()
    handler = Handler({42}, FakeBot(), tg, sheet=sheet, message_deadline_s=0.05, send_reserve_s=0.1)
    await handler.handle_update(tap("undo:w1"))
    await handler.handle_update(tap("undo:w1"))
    assert [op for op, _ in sheet.calls] == ["write.undo"]
    assert tg.answered == [("cb1", CUT)]
    assert tg.sent == [(42, CUT)]


class HangingAnswerTelegram(FakeTelegram):
    """answerCallbackQuery never returns."""

    async def answer_callback_query(self, callback_query_id, text=None):
        await asyncio.sleep(60)


async def test_a_hanging_button_answer_does_not_hold_back_the_notice(monkeypatch):
    monkeypatch.setattr(handler_module, "CUT_NOTICE_S", 0.3)
    sheet = SlowUndoSheet(**{"write.undo": [undone()]})
    tg = HangingAnswerTelegram()
    handler = Handler({42}, FakeBot(), tg, sheet=sheet, message_deadline_s=0.05, send_reserve_s=0.1)
    started = asyncio.get_running_loop().time()
    await handler.handle_update(tap("undo:w1"))
    assert asyncio.get_running_loop().time() - started < 2
    assert tg.sent == [(42, CUT)]


class HangingNoticeTelegram(FakeTelegram):
    """Both the button answer and every message hang; records which ones were cancelled."""

    def __init__(self):
        super().__init__()
        self.cancelled = []

    async def _hang(self, name):
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            self.cancelled.append(name)
            raise

    async def answer_callback_query(self, callback_query_id, text=None):
        await self._hang("answer")

    async def send_message(self, chat_id, text, *, html=False, reply_markup=None, reply_to=None):
        await self._hang(f"send:{text}")


async def test_a_notice_that_hangs_is_cancelled_cleanly_at_the_notice_time(monkeypatch):
    monkeypatch.setattr(handler_module, "CUT_NOTICE_S", 0.2)
    sheet = SlowUndoSheet(**{"write.undo": [undone()]})
    tg = HangingNoticeTelegram()
    handler = Handler({42}, FakeBot(), tg, sheet=sheet, message_deadline_s=0.05, send_reserve_s=0.1)
    before = asyncio.all_tasks()
    started = asyncio.get_running_loop().time()
    await handler.handle_update(tap("undo:w1"))
    assert asyncio.get_running_loop().time() - started < 2
    assert sorted(tg.cancelled) == ["answer", f"send:{CUT}"]
    await asyncio.sleep(0)
    assert asyncio.all_tasks() <= before  # nothing left running
    await handler.handle_update(tap("undo:w1"))  # still counted as done: no second undo
    assert [op for op, _ in sheet.calls] == ["write.undo"]


async def test_a_reply_cut_while_sending_ends_within_the_notice_time(monkeypatch):
    monkeypatch.setattr(handler_module, "CUT_NOTICE_S", 0.1)
    handler = Handler({42}, FakeBot(), SlowSendTelegram(), message_deadline_s=0.05, send_reserve_s=0.1)
    started = asyncio.get_running_loop().time()
    await handler.handle_update(update("peso 82"))
    assert asyncio.get_running_loop().time() - started < 1


async def test_runs_the_bot_and_replies_in_the_same_chat():
    bot, tg = FakeBot("21/09 · Peso kg 82"), FakeTelegram()
    await Handler({42}, bot, tg).handle_update(update())
    assert bot.texts == [("peso 82", "42")]
    assert tg.sent == [(42, "21/09 · Peso kg 82")]
    assert tg.options == [{"html": True, "reply_markup": None, "reply_to": None}]
    assert bot.contexts == [None]


def replying(text, replied):
    u = update(text)
    u["message"]["reply_to_message"] = replied
    return u


async def test_a_reply_to_a_bot_message_passes_its_text_as_context():
    confirmation = "21/09 · Upper\nSupino inclinado: 60×8, 60×8"
    replied = {"message_id": 7, "from": {"id": 1, "is_bot": True}, "text": confirmation}
    bot, tg = FakeBot(), FakeTelegram()
    await Handler({42}, bot, tg).handle_update(replying("na verdade foi 62", replied))
    assert bot.texts == [("na verdade foi 62", "42")]
    assert bot.contexts == [confirmation]


@pytest.mark.parametrize(
    "replied",
    [
        {"message_id": 7, "from": {"id": 42, "is_bot": False}, "text": "peso 82"},
        {"message_id": 7, "text": "sem remetente"},
        {"message_id": 7, "from": {"id": 1, "is_bot": True}, "photo": []},
        {"message_id": 7, "from": {"id": 1, "is_bot": True}, "text": "  "},
    ],
)
async def test_other_replies_give_no_context(replied):
    bot = FakeBot()
    await Handler({42}, bot, FakeTelegram()).handle_update(replying("peso 83", replied))
    assert bot.contexts == [None]


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


VOICE = {"file_id": "v1", "file_unique_id": "u1", "duration": 3, "mime_type": "audio/ogg", "file_size": 9000}
PHOTO_SIZES = [
    {"file_id": "p-small", "width": 90, "height": 120, "file_size": 2_000},
    {"file_id": "p-medium", "width": 600, "height": 800, "file_size": 60_000},
    {"file_id": "p-large", "width": 1200, "height": 1600, "file_size": 300_000},
]


async def test_a_voice_message_is_transcribed_and_answered_with_entendi_never_reaching_bot():
    bot = FakeBot("<b>24/09</b> · Peso kg 82")
    tg = FakeTelegram(files=file("v1", b"OggS...", "voice/f.oga"))
    confirmations = VoiceConfirmations()
    transcriber = FakeTranscriber("peso 82,4")
    msg = media_update(message_id=14, voice=VOICE)
    await Handler({42}, bot, tg, confirmations=confirmations, transcriber=transcriber).handle_update(msg)

    assert tg.fetched == [("getFile", "v1"), ("download", "voice/f.oga")]
    assert bot.texts == []
    assert bot.media == []
    [(audio, principal_key, _)] = transcriber.calls
    assert audio == Audio("audio/ogg", b"OggS...", trusted_seconds=3)
    assert principal_key == "telegram:42"
    assert tg.sent == [(42, entendi_text("peso 82,4"))]
    assert tg.actions[0] == (42, "typing")
    markup = tg.options[-1]["reply_markup"]
    vid = markup["inline_keyboard"][0][0]["callback_data"].partition(":")[2]
    assert tg.options[-1] == {"html": False, "reply_markup": voice_keyboard(vid), "reply_to": 14}
    entry = confirmations.get(vid)
    assert entry is not None
    assert (entry.chat_id, entry.message_id, entry.state, entry.text_sha256) == (
        42,
        1,
        "pending",
        sha256_hex("peso 82,4"),
    )


async def test_an_audio_file_keeps_its_mime_type_and_combines_caption_with_transcript():
    audio = {"file_id": "a1", "mime_type": "audio/mp4", "file_size": 100, "duration": 18}
    bot, tg = FakeBot(), FakeTelegram(files=file("a1", b"m4a"))
    confirmations = VoiceConfirmations()
    transcriber = FakeTranscriber("supino 80 por 8")
    await Handler({42}, bot, tg, confirmations=confirmations, transcriber=transcriber).handle_update(
        media_update(message_id=22, audio=audio, caption="treino de hoje")
    )

    assert bot.texts == []
    assert bot.media == []
    [(sent_audio, _, _)] = transcriber.calls
    assert sent_audio == Audio("audio/mp4", b"m4a", trusted_seconds=18)
    expected_body = "treino de hoje\nsupino 80 por 8"
    assert tg.sent == [(42, entendi_text(expected_body))]
    vid = tg.options[-1]["reply_markup"]["inline_keyboard"][0][0]["callback_data"].partition(":")[2]
    entry = confirmations.get(vid)
    assert entry is not None and entry.text_sha256 == sha256_hex(expected_body)


async def test_an_audio_message_with_non_audio_mime_still_uses_transcriber_never_bot():
    audio = {"file_id": "a1", "mime_type": "image/jpeg", "file_size": 100, "duration": 5}
    bot, tg = FakeBot(), FakeTelegram(files=file("a1", b"not-a-photo"))
    transcriber = FakeTranscriber(error=TranscribeError("unsupported_format"))
    await Handler({42}, bot, tg, transcriber=transcriber).handle_update(media_update(audio=audio))
    assert bot.texts == [] and bot.media == []
    assert len(transcriber.calls) == 1
    assert tg.sent == [(42, VOICE_FORMAT)]


async def test_a_photo_sends_the_largest_size_that_fits_as_jpeg():
    bot = FakeBot()
    tg = FakeTelegram(files={**file("p-medium", b"jpeg-m"), **file("p-large", b"jpeg-l")})
    handler = Handler({42}, bot, tg, media_max_bytes=100_000)
    await handler.handle_update(media_update(photo=PHOTO_SIZES, caption="balança"))
    assert tg.fetched == [("getFile", "p-medium"), ("download", "files/p-medium")]
    assert bot.texts == [("balança", "42")]
    assert bot.media == [[Media("image/jpeg", b"jpeg-m")]]


def test_photo_size_selection():
    def chosen(max_bytes):
        ref = media_ref({"photo": PHOTO_SIZES}, max_bytes)
        return ref and ref.file_id

    assert chosen(5_000_000) == "p-large"
    assert chosen(60_000) == "p-medium"
    too_big = media_ref({"photo": PHOTO_SIZES}, 1_000)
    assert too_big is not None and too_big.file_id == "p-small" and not too_big.fits(1_000)
    assert media_ref({"sticker": {"file_id": "s"}}, 1_000) is None


async def test_voice_and_audio_over_duration_limit_are_refused_before_getfile():
    bot, tg = FakeBot(), FakeTelegram(files=file("v1", b"OggS"))
    transcriber = FakeTranscriber("peso 82")
    handler = Handler({42}, bot, tg, transcriber=transcriber, voice_max_seconds=90)
    await handler.handle_update(
        {"update_id": 10, "message": {"chat": {"id": 42}, "voice": {**VOICE, "duration": 91}}}
    )
    await handler.handle_update(
        {"update_id": 11, "message": {"chat": {"id": 42}, "audio": {"file_id": "v1", "duration": 91}}}
    )
    assert tg.fetched == []
    assert transcriber.calls == []
    assert bot.texts == []
    assert tg.sent == [(42, VOICE_TOO_LONG), (42, VOICE_TOO_LONG)]

    # Exact boundary (90 s) and missing duration are allowed to proceed.
    await handler.handle_update(
        {"update_id": 12, "message": {"chat": {"id": 42}, "voice": {**VOICE, "duration": 90}}}
    )
    await handler.handle_update(
        {"update_id": 13, "message": {"chat": {"id": 42}, "audio": {"file_id": "v1"}}}
    )
    assert len(transcriber.calls) == 2


async def test_a_file_over_the_limit_is_refused_without_downloading():
    bot, tg = FakeBot(), FakeTelegram()
    await Handler({42}, bot, tg, media_max_bytes=5_000).handle_update(media_update(voice=VOICE))
    await Handler({42}, bot, tg, media_max_bytes=1_000).handle_update(media_update(photo=PHOTO_SIZES))
    assert tg.fetched == []
    assert bot.texts == []
    assert [text for _, text in tg.sent] == [too_large(5_000), too_large(1_000)]
    assert too_large(5_000_000) == (
        "O arquivo passa de 5 MB, o máximo que eu leio; envie em texto ou um arquivo menor."
    )
    assert "2,5 MB" in too_large(2_500_000)


async def test_a_download_larger_than_telegram_announced_is_refused():
    bot = FakeBot()
    tg = FakeTelegram(files={"v1": ({"file_id": "v1", "file_path": "voice/f.oga"}, b"x" * 20_000)})
    await Handler({42}, bot, tg, media_max_bytes=10_000).handle_update(
        media_update(voice={**VOICE, "file_size": None})
    )
    assert bot.texts == []
    assert tg.sent == [(42, too_large(10_000))]


async def test_media_disabled_answers_with_the_text_hint_without_downloading():
    bot, tg = FakeBot(), FakeTelegram()
    await Handler({42}, bot, tg, media_enabled=False).handle_update(
        {"update_id": 20, "message": {"chat": {"id": 42}, "voice": VOICE}}
    )
    await Handler({42}, bot, tg, media_enabled=False).handle_update(
        {"update_id": 21, "message": {"chat": {"id": 42}, "audio": {"file_id": "a1"}}}
    )
    await Handler({42}, bot, tg, media_enabled=False).handle_update(
        {"update_id": 22, "message": {"chat": {"id": 42}, "photo": PHOTO_SIZES}}
    )
    assert tg.fetched == []
    assert bot.texts == []
    assert tg.sent == [(42, MEDIA_DISABLED)] * 3


@pytest.mark.parametrize(
    ("error", "expected_text", "is_transient"),
    [
        (TranscribeError("disabled"), MEDIA_DISABLED, False),
        (TranscribeError("unsupported_format"), VOICE_FORMAT, False),
        (TranscribeError("too_long"), VOICE_TOO_LONG, False),
        (TranscribeError("no_speech"), VOICE_EMPTY, False),
        (TranscribeError("budget_exhausted"), VOICE_BUDGET, False),
        (TranscribeError("failed"), VOICE_FAILED, True),
        (TranscribeError("timeout"), VOICE_FAILED, True),
        (RuntimeError("unexpected crash"), VOICE_FAILED, True),
    ],
)
async def test_every_transcribe_error_maps_to_its_spec_message_and_transient_semantics(
    error, expected_text, is_transient
):
    dedup = UpdateDeduplicator()
    tg = FakeTelegram(files=file("v1", b"OggS...", "voice/f.oga"))
    failing = FakeTranscriber(error=error)
    u = {"update_id": 44, "message": {"chat": {"id": 42}, "voice": VOICE}}

    # First delivery sends the §8 message; if sending failed on a transient error, update_id is released.
    fail_send_tg = FakeTelegram(files=file("v1", b"OggS...", "voice/f.oga"), error=RuntimeError("send net"))
    await Handler({42}, FakeBot(), fail_send_tg, deduplicator=dedup, transcriber=failing).handle_update(u)
    assert len(failing.calls) == 1

    # Now deliver with working Telegram: every non-committed update whose send failed was released!
    dedup2 = UpdateDeduplicator()
    await Handler({42}, FakeBot(), tg, deduplicator=dedup2, transcriber=failing).handle_update(u)
    assert tg.sent == [(42, expected_text)]

    ok_transcriber = FakeTranscriber("peso 82")
    await Handler({42}, FakeBot(), tg, deduplicator=dedup2, transcriber=ok_transcriber).handle_update(u)
    if is_transient:
        assert len(ok_transcriber.calls) == 1
        assert tg.sent[-1] == (42, entendi_text("peso 82"))
    else:
        assert ok_transcriber.calls == []
        assert len(tg.sent) == 1


async def test_handler_without_transcriber_answers_media_disabled_for_audio():
    tg_client = FakeTelegram(files=file("v1", b"OggS...", "voice/f.oga"))
    fake_bot = FakeBot()
    await Handler({42}, fake_bot, tg_client).handle_update(media_update(voice=VOICE))
    assert fake_bot.texts == []
    assert tg_client.sent == [(42, MEDIA_DISABLED)]


async def test_failed_entendi_send_deletes_confirmation_entry_and_releases_update_for_retry():
    dedup = UpdateDeduplicator()
    confirmations = VoiceConfirmations()
    u = {"update_id": 55, "message": {"message_id": 8, "chat": {"id": 42}, "voice": VOICE}}

    broken_tg = FakeTelegram(files=file("v1", b"OggS...", "voice/f.oga"), error=RuntimeError("network down"))
    await Handler(
        {42},
        FakeBot(),
        broken_tg,
        deduplicator=dedup,
        confirmations=confirmations,
        transcriber=FakeTranscriber("peso 82,4"),
    ).handle_update(u)
    assert len(confirmations) == 0

    working_tg = FakeTelegram(files=file("v1", b"OggS...", "voice/f.oga"))
    await Handler(
        {42},
        FakeBot(),
        working_tg,
        deduplicator=dedup,
        confirmations=confirmations,
        transcriber=FakeTranscriber("peso 82,4"),
    ).handle_update(u)
    assert len(confirmations) == 1
    assert working_tg.sent == [(42, entendi_text("peso 82,4"))]


async def test_a_failed_download_gets_its_own_warning_and_skips_the_bot():
    bot = FakeBot()
    tg = FakeTelegram(files=file("v1", b"x", "voice/f.oga"), download_error=RuntimeError("HTTP 502"))
    await Handler({42}, bot, tg).handle_update(media_update(voice=VOICE))
    assert bot.texts == []
    assert tg.sent == [(42, DOWNLOAD_FAILED)]


async def test_media_from_other_chats_and_other_kinds_of_message_are_ignored():
    bot, tg = FakeBot(), FakeTelegram()
    await Handler({42}, bot, tg).handle_update(media_update(chat_id=7, voice=VOICE))
    await Handler({42}, bot, tg).handle_update(media_update(sticker={"file_id": "s1"}))
    await Handler({42}, bot, tg).handle_update(media_update(document={"file_id": "d1"}, caption="x"))
    assert tg.fetched == [] and tg.sent == [] and bot.texts == []


async def test_a_photo_replying_to_the_bot_carries_the_context_and_gets_the_buttons():
    bot = FakeBot(Answer("<b>24/09</b> · Peso kg 82", ("w1",), wrote=True))
    tg = FakeTelegram(files=file("p-large", b"jpeg"))
    replied = {"message_id": 5, "from": {"is_bot": True}, "text": "24/09 · Peso kg 81"}
    await Handler({42}, bot, tg).handle_update(media_update(photo=PHOTO_SIZES, reply_to_message=replied))
    assert bot.contexts == ["24/09 · Peso kg 81"]
    assert bot.media == [[Media("image/jpeg", b"jpeg")]]
    assert tg.options[-1]["reply_markup"] == keyboard(("w1",))


async def test_duplicate_update_id_is_ignored_while_in_flight_and_after_completion():
    bot, tg = FakeBot("gravado", seconds=0.03), FakeTelegram()
    handler = Handler({42}, bot, tg)
    u = update("peso 82", update_id=77)
    await asyncio.gather(handler.handle_update(u), handler.handle_update(u))
    await handler.handle_update(u)
    assert bot.texts == [("peso 82", "42")]
    assert tg.sent == [(42, "gravado")]


async def test_transient_failures_release_update_id_so_a_retry_can_succeed():
    dedup = UpdateDeduplicator()
    tg = FakeTelegram()
    u = update("peso 82", update_id=88)

    for transient in (
        Answer(SHEET_FAILED, failed=True),
        Answer(MODEL_FAILED_NOTHING_WRITTEN, failed=True),
        Answer(f"<b>21/09</b> · Peso kg 82\n\n{MODEL_FAILED}", ("w1",), wrote=True, failed=True),
    ):
        await Handler({42}, FakeBot(transient), tg, deduplicator=dedup).handle_update(u)

    await Handler({42}, FakeBot(error=RuntimeError("boom")), tg, deduplicator=dedup).handle_update(u)
    await Handler(
        {42}, FakeBot("ok"), FakeTelegram(error=RuntimeError("net")), deduplicator=dedup
    ).handle_update(u)

    ok_bot = FakeBot(Answer("<b>21/09</b> · Peso kg 82", ("w1",), wrote=True))
    await Handler({42}, ok_bot, tg, deduplicator=dedup).handle_update(u)
    await Handler({42}, ok_bot, tg, deduplicator=dedup).handle_update(u)  # now completed -> ignored
    assert ok_bot.texts == [("peso 82", "42")]


async def test_command_outage_releases_a_read_but_a_permanent_refusal_or_an_undo_completes():
    dedup = UpdateDeduplicator()
    tg = FakeTelegram()
    outage = {"ok": False, "errors": [{"code": "unavailable", "message": "timeout"}]}
    refusal = {"ok": False, "errors": [{"code": "invalid", "message": "data inválida"}]}

    sheet = FakeSheet(day_get=[outage, refusal, refusal])
    u = update("/hoje", update_id=89)
    await Handler({42}, FakeBot(), tg, sheet=sheet, deduplicator=dedup).handle_update(u)  # transient -> retry
    await Handler({42}, FakeBot(), tg, sheet=sheet, deduplicator=dedup).handle_update(u)  # permanent -> done
    await Handler({42}, FakeBot(), tg, sheet=sheet, deduplicator=dedup).handle_update(u)  # ignored
    assert len(sheet.calls) == 2

    # A timed-out undo may have been applied: replaying /desfazer would undo a second action.
    sheet = FakeSheet(write_undo=[outage, outage])
    u = update("/desfazer", update_id=90)
    await Handler({42}, FakeBot(), tg, sheet=sheet, deduplicator=dedup).handle_update(u)
    await Handler({42}, FakeBot(), tg, sheet=sheet, deduplicator=dedup).handle_update(u)  # ignored
    assert len(sheet.calls) == 1


@pytest.mark.parametrize("outcome", ["committed", "uncertain"])
async def test_terminal_write_outcomes_complete_update_even_when_send_fails(outcome):
    dedup = UpdateDeduplicator()
    u = update("peso 82", update_id=91)
    first_bot = FakeBot(Answer("status", failed=(outcome == "uncertain"), outcome=outcome))
    await Handler({42}, first_bot, FakeTelegram(error=RuntimeError("net")), deduplicator=dedup).handle_update(
        u
    )

    second_bot = FakeBot("ok")
    await Handler({42}, second_bot, FakeTelegram(), deduplicator=dedup).handle_update(u)
    assert first_bot.texts == [("peso 82", "42")]
    assert second_bot.texts == []


async def test_a_reply_to_the_voice_fix_prompt_passes_no_reply_context():
    from agent.buttons import VOICE_FIX_PROMPT

    replied = {
        "message_id": 10,
        "from": {"id": 1, "is_bot": True},
        "text": f"{VOICE_FIX_PROMPT}\n\nsupino 80 por 8",
    }
    bot = FakeBot()
    await Handler({42}, bot, FakeTelegram()).handle_update(replying("supino 82 por 8", replied))
    assert bot.texts == [("supino 82 por 8", "42")]
    assert bot.contexts == [None]


# ---- C7b: `/app` voice link & Mini App `t: "text"` glue (§4.2, §4.3.4, §7.1, §13 C7) --------------


def _miniapp_text_update(
    text: str = "almoço 150 g de arroz e 120 g de frango",
    *,
    sid: str = "0123456789abcdef0123456789abcdef",
    chat_id: int = 42,
    update_id: int = 500,
    reply_to_message: dict | None = None,
) -> dict:
    import json

    payload = {"v": 1, "t": "text", "id": sid, "src": "voice", "text": text}
    msg: dict = {
        "chat": {"id": chat_id},
        "web_app_data": {"data": json.dumps(payload), "button_text": "🏋️ Treino"},
    }
    if reply_to_message is not None:
        msg["reply_to_message"] = reply_to_message
    return {"update_id": update_id, "message": msg}


def _decode_button_catalog(url: str) -> dict:
    import base64
    import json
    import zlib

    blob = url.split("&c=", 1)[1]
    packed = base64.urlsafe_b64decode(blob + "=" * (-len(blob) % 4))
    return json.loads(zlib.decompress(packed, -15).decode("utf-8"))


async def test_build_handler_app_command_without_and_with_voice_settings():
    import json
    from datetime import UTC

    import httpx

    from agent.auth import AllowedChats, AuthError, LinkCodes, TelegramDirectory, derive_keys
    from agent.handler import build_handler
    from agent.settings import Settings

    now = datetime(2026, 11, 14, 15, 0, tzinfo=UTC)
    secret = "s" * 40
    catalog_body = {
        "ok": True,
        "result": {
            "today": "2026-11-14",
            "timezone": "America/Sao_Paulo",
            "client": {"name": "Teste"},
            "sessions": ["Upper"],
            "plan": [{"session": "Upper", "exercise": "Supino reto", "group": "Peito"}],
            "exercises": [{"name": "Supino reto", "group": "Peito"}],
            "foods": ["Arroz"],
            "favorites": [],
            "meals": ["Almoço"],
            "units": ["g"],
        },
    }
    sent_payloads: list[dict] = []

    def transport_handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "sheet.example":
            return httpx.Response(200, json=catalog_body)
        if request.url.path.endswith("/sendMessage"):
            sent_payloads.append(json.loads(request.content.decode("utf-8")))
            return httpx.Response(200, json={"ok": True, "result": {"message_id": 1}})
        raise AssertionError(f"unexpected HTTP call: {request.method} {request.url}")

    base_kwargs = {
        "TELEGRAM_BOT_TOKEN": "123:fake-bot-token",
        "ALLOWED_CHAT_IDS": "42,43",
        "SHEET_API_URL": "https://sheet.example/exec",
        "SHEET_API_KEY": "fake-sheet-key",
        "LLM_MODEL": "gemini/gemini-2.5-flash",
        "LLM_API_KEY": "fake-llm-key",
        "MINIAPP_URL": "https://app.example/miniapp/",
    }

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport_handler)) as http:
        # 1. Without voice settings: `/app` emits keyboard URLs with no `vu`, `vc`, or `vx`.
        no_voice = Settings.model_validate(base_kwargs)
        h_plain = build_handler(no_voice, http, clock=lambda: now)
        await h_plain.handle_update(update("/app", chat_id=42, update_id=601))
        assert len(sent_payloads) == 1
        plain_urls = [b["web_app"]["url"] for b in sent_payloads[0]["reply_markup"]["keyboard"][0]]
        for url in plain_urls:
            decoded = _decode_button_catalog(url)
            assert "vu" not in decoded and "vc" not in decoded and "vx" not in decoded

        # 2. With VOICE_API_URL + APP_AUTH_SECRET: `/app` issues one `vc` verifiable only for that chat_id.
        sent_payloads.clear()
        with_voice = Settings.model_validate(
            {
                **base_kwargs,
                "VOICE_API_URL": "https://voice.example",
                "APP_AUTH_SECRET": secret,
                "APP_CODE_TTL_S": 600,
            }
        )
        h_voice = build_handler(with_voice, http, clock=lambda: now)
        await h_voice.handle_update(update("/app", chat_id=42, update_id=602))
        assert len(sent_payloads) == 1
        voice_urls = [b["web_app"]["url"] for b in sent_payloads[0]["reply_markup"]["keyboard"][0]]
        w_cat, f_cat = (_decode_button_catalog(u) for u in voice_urls)
        assert w_cat["vu"] == f_cat["vu"] == "https://voice.example"
        assert w_cat["vx"] == f_cat["vx"] == int(now.timestamp()) + 600
        code = w_cat["vc"]
        assert isinstance(code, str) and code.startswith("c1.") and f_cat["vc"] == code

        keys = derive_keys(secret)
        only_other_chat = LinkCodes(keys, TelegramDirectory(keys, {43}), AllowedChats({43}), ttl_s=600)
        with pytest.raises(AuthError) as forbidden_exc:
            only_other_chat.verify(code, now)
        assert forbidden_exc.value.code == "forbidden"

        both_chats = LinkCodes(keys, TelegramDirectory(keys, {42, 43}), AllowedChats({42, 43}), ttl_s=600)
        principal = both_chats.verify(code, now)
        assert principal.provider == "telegram" and principal.chat_id == 42 and principal.subject == "42"

        # Single-use: a second redemption of the same `vc` is rejected with `credential_used`.
        with pytest.raises(AuthError) as used_exc:
            both_chats.verify(code, now)
        assert used_exc.value.code == "credential_used"


async def test_miniapp_text_first_submission_runs_agent_with_scope_and_no_reply_context():
    from agent.bot import Bot
    from agent.tools import Journal

    from .fakes import OK_DIARY, ScriptedLlm, call, say

    sid = "a" * 32
    sheet = FakeSheet(diary_upsert=[OK_DIARY])
    llm = ScriptedLlm(
        model="scripted",
        script=[call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}), say("Ok")],
    )
    bot = Bot(sheet, llm, timezone="America/Sao_Paulo")
    tg = FakeTelegram()
    replied = {"message_id": 7, "from": {"id": 1, "is_bot": True}, "text": "20/09 · Peso kg 99,9"}

    await Handler({42}, bot, tg, sheet=sheet, clock=lambda: datetime(2026, 9, 21, 12, 0)).handle_update(
        _miniapp_text_update("peso 82,4", sid=sid, chat_id=42, update_id=501, reply_to_message=replied)
    )

    assert len(sheet.request_ids) == 1
    assert sheet.request_ids[0] is not None
    assert sheet.request_ids[0].startswith(f"tg:42:miniapp:text:{sid}:diary.upsert:")
    assert tg.sent and "82,4" in tg.sent[0][1]

    # Also verify directly via a spy Replier that `context` is None (`use_reply_context=False`) and
    # `update_key_scope` inside `reply()` sets `tg:{chat_id}:miniapp:text:{id}`.
    seen_prefixes: list[str | None] = []

    class ScopeSpyBot(FakeBot):
        async def reply(self, text, user_id="telegram", *, context=None, media=None):
            seen_prefixes.append(Journal().request_prefix)
            return await super().reply(text, user_id, context=context, media=media)

    spy = ScopeSpyBot(Answer("<b>21/09</b> · Peso kg 82,4", ("w1",), wrote=True, outcome="committed"))
    await Handler({42}, spy, FakeTelegram()).handle_update(
        _miniapp_text_update("peso 82,4", sid="f" * 32, chat_id=42, update_id=502, reply_to_message=replied)
    )
    assert spy.texts == [("peso 82,4", "42")]
    assert spy.contexts == [None]
    assert seen_prefixes == [f"tg:42:miniapp:text:{'f' * 32}"]


async def test_miniapp_text_same_payload_in_two_different_updates_runs_agent_once():
    from agent.text_submissions import DONE_REPLY, TextSubmissions

    sid = "b" * 32
    submissions = TextSubmissions()
    bot = FakeBot(Answer("<b>21/09</b> · Peso kg 82,4", ("w1",), wrote=True, outcome="committed"))
    tg = FakeTelegram()
    handler = Handler({42, 43}, bot, tg, text_submissions=submissions)

    await handler.handle_update(_miniapp_text_update("peso 82,4", sid=sid, chat_id=42, update_id=510))
    await handler.handle_update(_miniapp_text_update("peso 82,4", sid=sid, chat_id=42, update_id=511))

    assert bot.texts == [("peso 82,4", "42")]
    assert tg.sent == [
        (42, "<b>21/09</b> · Peso kg 82,4"),
        (42, DONE_REPLY),
    ]
    assert submissions.begin(42, sid, "peso 82,4").reason == "done"

    # A clean read-only reply (`outcome=None, failed=False`) also settles as `done`.
    read_sid = "c" * 32
    read_bot = FakeBot(Answer("Nada gravado.", outcome=None))
    read_tg = FakeTelegram()
    read_handler = Handler({42}, read_bot, read_tg)
    await read_handler.handle_update(_miniapp_text_update("oi", sid=read_sid, chat_id=42, update_id=512))
    await read_handler.handle_update(_miniapp_text_update("oi", sid=read_sid, chat_id=42, update_id=513))
    assert read_bot.texts == [("oi", "42")]
    assert read_tg.sent == [(42, "Nada gravado."), (42, DONE_REPLY)]

    # Keyed per principal (`telegram:<chat_id>`): another allowed chat with the same `sid` is independent.
    await handler.handle_update(_miniapp_text_update("peso 82,4", sid=sid, chat_id=43, update_id=514))
    assert bot.texts == [("peso 82,4", "42"), ("peso 82,4", "43")]


async def test_miniapp_text_concurrent_duplicate_updates_run_agent_once_and_answer_running():
    from agent.text_submissions import RUNNING_REPLY

    sid = "d" * 32
    started, release = asyncio.Event(), asyncio.Event()

    class GatedTextBot(FakeBot):
        async def reply(self, text, user_id="telegram", *, context=None, media=None):
            self.texts.append((text, user_id))
            started.set()
            await release.wait()
            return Answer("<b>21/09</b> · Peso kg 82,4", ("w1",), wrote=True, outcome="committed")

    bot = GatedTextBot()
    tg = FakeTelegram()
    handler = Handler({42}, bot, tg)

    async def second_arrival():
        await started.wait()
        await handler.handle_update(_miniapp_text_update("peso 82,4", sid=sid, update_id=521))
        assert tg.sent == [(42, RUNNING_REPLY)]
        release.set()

    await asyncio.gather(
        handler.handle_update(_miniapp_text_update("peso 82,4", sid=sid, update_id=520)),
        second_arrival(),
    )

    assert bot.texts == [("peso 82,4", "42")]
    assert tg.sent == [(42, RUNNING_REPLY), (42, "<b>21/09</b> · Peso kg 82,4")]


async def test_miniapp_text_same_id_with_different_text_answers_conflict_without_running_agent():
    from agent.text_submissions import CONFLICT_REPLY

    sid = "e" * 32
    bot = FakeBot(Answer("<b>21/09</b> · Peso kg 82,4", ("w1",), wrote=True, outcome="committed"))
    tg = FakeTelegram()
    handler = Handler({42}, bot, tg)

    await handler.handle_update(_miniapp_text_update("peso 82,4", sid=sid, update_id=530))
    await handler.handle_update(_miniapp_text_update("peso 83,0", sid=sid, update_id=531))

    assert bot.texts == [("peso 82,4", "42")]
    assert tg.sent[-1] == (42, CONFLICT_REPLY)


async def test_miniapp_text_written_answer_lost_keeps_entry_uncertain_and_blocks_resend():
    import json

    import httpx

    from agent.bot import WRITE_UNCERTAIN, Bot
    from agent.sheet_client import SheetClient
    from agent.text_submissions import UNCERTAIN_REPLY, TextSubmissions

    from .fakes import ScriptedLlm, call, say

    sid = "1" * 32
    applied_writes: list[dict] = []

    def lost_answer_transport(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        applied_writes.append(body)
        raise httpx.ReadTimeout("answer lost after write", request=request)

    submissions = TextSubmissions()
    async with httpx.AsyncClient(transport=httpx.MockTransport(lost_answer_transport)) as http:
        sheet = SheetClient("https://sheet.example/exec", "fake-sheet-key", http)
        llm = ScriptedLlm(
            model="scripted",
            script=[
                call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}),
                say("Ok"),
                call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}),
                say("Não deveria rodar."),
            ],
        )
        bot = Bot(sheet, llm, timezone="America/Sao_Paulo")
        tg = FakeTelegram()
        handler = Handler(
            {42},
            bot,
            tg,
            sheet=sheet,
            text_submissions=submissions,
            clock=lambda: datetime(2026, 9, 21, 12, 0),
        )

        await handler.handle_update(_miniapp_text_update("peso 82,4", sid=sid, update_id=540))
        assert len(applied_writes) == 1
        assert len(submissions) == 1
        assert submissions.begin(42, sid, "peso 82,4").reason == "uncertain"
        assert tg.sent == [(42, WRITE_UNCERTAIN)]

        # Resending in a brand-new `update_id` never runs the agent or posts a second time.
        await handler.handle_update(_miniapp_text_update("peso 82,4", sid=sid, update_id=541))
        assert len(applied_writes) == 1
        assert len(llm.requests) == 2
        assert tg.sent == [(42, WRITE_UNCERTAIN), (42, UNCERTAIN_REPLY)]


async def test_miniapp_text_not_committed_removes_entry_so_resend_runs_again():
    from agent.bot import Bot
    from agent.text_submissions import TextSubmissions

    from .fakes import OK_DIARY, ScriptedLlm, call, say

    down = {"ok": False, "errors": [{"path": "", "code": "unavailable", "message": "locked"}]}
    invalid_food = {
        "ok": False,
        "errors": [{"path": "args.items[0].food", "code": "not_in_catalog", "message": "não achei"}],
    }
    ok_food = {"ok": True, "result": {"writeId": "wf1", "date": "2026-09-21", "meal": "Almoço", "added": 1}}

    # 1. Sheet unavailable before write -> `not_committed`, entry removed, resend runs and succeeds.
    sid_down = "2" * 32
    subs1 = TextSubmissions()
    sheet1 = FakeSheet(diary_upsert=[down, OK_DIARY])
    llm1 = ScriptedLlm(
        model="scripted",
        script=[
            call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}),
            say("Planilha indisponível."),
            call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}),
            say("Ok"),
        ],
    )
    tg1 = FakeTelegram()
    h1 = Handler(
        {42},
        Bot(sheet1, llm1, timezone="America/Sao_Paulo"),
        tg1,
        sheet=sheet1,
        text_submissions=subs1,
        clock=lambda: datetime(2026, 9, 21, 12, 0),
    )
    await h1.handle_update(_miniapp_text_update("peso 82,4", sid=sid_down, update_id=550))
    assert len(subs1) == 0
    assert tg1.sent == [(42, SHEET_FAILED)]

    await h1.handle_update(_miniapp_text_update("peso 82,4", sid=sid_down, update_id=551))
    assert subs1.begin(42, sid_down, "peso 82,4").reason == "done"
    assert len(sheet1.calls) == 2
    assert "82,4" in tg1.sent[-1][1]

    # 2. Pre-write validation refusal (`not_in_catalog`) -> `not_committed`, entry removed, resend runs.
    sid_val = "3" * 32
    subs2 = TextSubmissions()
    sheet2 = FakeSheet(food_add=[invalid_food, ok_food])
    llm2 = ScriptedLlm(
        model="scripted",
        script=[
            call(
                "save_food",
                date="2026-09-21",
                meal="Almoço",
                items=[{"food": "Arroz", "qty": 150, "unit": "g"}],
            ),
            say("Não está no catálogo."),
            call(
                "save_food",
                date="2026-09-21",
                meal="Almoço",
                items=[{"food": "Arroz", "qty": 150, "unit": "g"}],
            ),
            say("Ok"),
        ],
    )
    tg2 = FakeTelegram()
    h2 = Handler(
        {42},
        Bot(sheet2, llm2, timezone="America/Sao_Paulo"),
        tg2,
        sheet=sheet2,
        text_submissions=subs2,
        clock=lambda: datetime(2026, 9, 21, 12, 0),
    )
    await h2.handle_update(_miniapp_text_update("almoço 150 g arroz", sid=sid_val, update_id=552))
    assert len(subs2) == 0
    await h2.handle_update(_miniapp_text_update("almoço 150 g arroz", sid=sid_val, update_id=553))
    assert subs2.begin(42, sid_val, "almoço 150 g arroz").reason == "done"
    assert len(sheet2.calls) == 2

    # 3. Model fails before any write (`outcome=None, failed=True` or exception) -> removed, resend runs.
    sid_llm = "4" * 32
    subs3 = TextSubmissions()
    dedup = UpdateDeduplicator()
    tg3 = FakeTelegram()
    await Handler(
        {42},
        FakeBot(Answer(MODEL_FAILED_NOTHING_WRITTEN, failed=True, outcome=None)),
        tg3,
        deduplicator=dedup,
        text_submissions=subs3,
    ).handle_update(_miniapp_text_update("peso 82,4", sid=sid_llm, update_id=554))
    assert len(subs3) == 0

    await Handler(
        {42},
        FakeBot(error=RuntimeError("llm down")),
        tg3,
        deduplicator=dedup,
        text_submissions=subs3,
    ).handle_update(_miniapp_text_update("peso 82,4", sid=sid_llm, update_id=555))
    assert len(subs3) == 0

    ok_bot = FakeBot(Answer("<b>21/09</b> · Peso kg 82,4", ("w1",), wrote=True, outcome="committed"))
    await Handler({42}, ok_bot, tg3, deduplicator=dedup, text_submissions=subs3).handle_update(
        _miniapp_text_update("peso 82,4", sid=sid_llm, update_id=556)
    )
    assert subs3.begin(42, sid_llm, "peso 82,4").reason == "done"
    assert ok_bot.texts == [("peso 82,4", "42")]


async def test_miniapp_text_cut_by_message_deadline_and_hard_limit_marks_uncertain():
    from agent.bot import WRITE_UNCERTAIN
    from agent.text_submissions import UNCERTAIN_REPLY, TextSubmissions

    # 1. Cut at MESSAGE_DEADLINE_AT (before hard_limit): entry becomes `uncertain`, reply is WRITE_UNCERTAIN,
    # and neither a failed-send redelivery of the same update_id nor a new update_id runs again.
    sid_soft = "5" * 32
    subs_soft = TextSubmissions()
    dedup_soft = UpdateDeduplicator()

    class SoftDeadlineBot:
        calls = 0

        async def reply(self, text, user_id="telegram", *, context=None, media=None):
            self.calls += 1
            await asyncio.sleep(0.08)
            return Answer(MODEL_FAILED_NOTHING_WRITTEN, failed=True, outcome=None)

    soft_bot = SoftDeadlineBot()
    tg_soft = FakeTelegram()
    h_soft = Handler(
        {42},
        soft_bot,
        tg_soft,
        deduplicator=dedup_soft,
        text_submissions=subs_soft,
        message_deadline_s=0.03,
        send_reserve_s=2.0,
    )
    await h_soft.handle_update(_miniapp_text_update("peso 82,4", sid=sid_soft, update_id=560))
    assert subs_soft.begin(42, sid_soft, "peso 82,4").reason == "uncertain"
    assert tg_soft.sent == [(42, WRITE_UNCERTAIN)]

    await h_soft.handle_update(_miniapp_text_update("peso 82,4", sid=sid_soft, update_id=561))
    assert soft_bot.calls == 1
    assert tg_soft.sent == [(42, WRITE_UNCERTAIN), (42, UNCERTAIN_REPLY)]

    # Even if `send_message` fails after a soft cut, `write_outcome="uncertain"` completes `update_id`.
    sid_soft_drop = "a5" * 16
    await Handler(
        {42},
        soft_bot,
        FakeTelegram(error=RuntimeError("net")),
        deduplicator=dedup_soft,
        text_submissions=subs_soft,
        message_deadline_s=0.03,
        send_reserve_s=2.0,
    ).handle_update(_miniapp_text_update("peso 82,4", sid=sid_soft_drop, update_id=564))
    assert soft_bot.calls == 2
    tg_retry = FakeTelegram()
    await Handler(
        {42}, soft_bot, tg_retry, deduplicator=dedup_soft, text_submissions=subs_soft
    ).handle_update(_miniapp_text_update("peso 82,4", sid=sid_soft_drop, update_id=564))
    assert soft_bot.calls == 2
    assert tg_retry.sent == []

    # 2. Cut at hard_limit (`TimeoutError` escapes `_run_bot`): entry becomes `uncertain` and never reruns.
    sid_hard = "6" * 32
    subs_hard = TextSubmissions()
    hard_bot = FakeBot(seconds=5)
    tg_hard = FakeTelegram()
    h_hard = Handler(
        {42},
        hard_bot,
        tg_hard,
        text_submissions=subs_hard,
        message_deadline_s=0.03,
        send_reserve_s=0.03,
    )
    await h_hard.handle_update(_miniapp_text_update("peso 82,4", sid=sid_hard, update_id=562))
    assert subs_hard.begin(42, sid_hard, "peso 82,4").reason == "uncertain"
    assert tg_hard.sent == [(42, CUT)]

    await h_hard.handle_update(_miniapp_text_update("peso 82,4", sid=sid_hard, update_id=563))
    assert len(hard_bot.texts) == 1
    assert tg_hard.sent == [(42, CUT), (42, UNCERTAIN_REPLY)]


async def test_miniapp_workout_and_food_forms_stay_model_free_and_invalid_text_is_rejected():
    import json

    from agent.miniapp import NOTHING_SAVED
    from agent.text_submissions import TextSubmissions

    sid = "7" * 32
    food_form = {
        "v": 1,
        "t": "food",
        "id": sid,
        "args": {
            "date": "2026-09-21",
            "meal": "Almoço",
            "items": [{"food": "Arroz", "qty": 150, "unit": "g"}],
        },
    }
    workout_form = {
        "v": 1,
        "t": "workout",
        "id": "8" * 32,
        "args": {
            "date": "2026-09-21",
            "session": "Upper",
            "complete": True,
            "exercises": [{"name": "Supino reto", "work": [{"kg": 80, "reps": 8}]}],
        },
    }
    sheet = FakeSheet(
        food_add=[
            {"ok": True, "result": {"writeId": "wf1", "date": "2026-09-21", "meal": "Almoço", "added": 1}}
        ],
        workout_upsert=[
            {"ok": True, "result": {"writeId": "ww1", "date": "2026-09-21", "session": "Upper", "saved": 1}}
        ],
    )
    subs = TextSubmissions()
    bot = FakeBot("ok")
    tg = FakeTelegram()
    handler = Handler(
        {42},
        bot,
        tg,
        sheet=sheet,
        text_submissions=subs,
        clock=lambda: datetime(2026, 9, 21, 12, 0),
    )

    await handler.handle_update(
        {"update_id": 570, "message": {"chat": {"id": 42}, "web_app_data": {"data": json.dumps(food_form)}}}
    )
    await handler.handle_update(
        {
            "update_id": 571,
            "message": {"chat": {"id": 42}, "web_app_data": {"data": json.dumps(workout_form)}},
        }
    )
    assert bot.texts == []
    assert [op for op, _ in sheet.calls] == ["food.add", "workout.upsert"]
    assert len(subs) == 0

    # Invalid `t: "text"` (blank text) returns NOTHING_SAVED without calling the model or storing `id`.
    bad_text = {"v": 1, "t": "text", "id": "9" * 32, "src": "voice", "text": "   "}
    await handler.handle_update(
        {"update_id": 572, "message": {"chat": {"id": 42}, "web_app_data": {"data": json.dumps(bad_text)}}}
    )
    assert bot.texts == []
    assert tg.sent[-1][1].startswith(NOTHING_SAVED)
    assert len(subs) == 0
