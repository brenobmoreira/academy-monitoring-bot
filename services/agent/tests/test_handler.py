import asyncio
from datetime import datetime

import pytest

from agent.bot import MEDIA_UNREADABLE, Media
from agent.commands import Reply, help_text
from agent.handler import DOWNLOAD_FAILED, FAILURE, Handler, media_ref, too_large

from .fakes import FakeSheet

pytestmark = pytest.mark.unit


class FakeBot:
    def __init__(self, reply="ok", error=None, seconds=0.0, events=None):
        self.texts = []
        self.media = []
        self._reply = reply
        self._error = error
        self._seconds = seconds
        self._events = events if events is not None else []

    async def reply(self, text, user_id="telegram", *, media=None):
        self.texts.append((text, user_id))
        self.media.append(media)
        self._events.append("bot")
        if self._seconds:
            await asyncio.sleep(self._seconds)
        if self._error:
            raise self._error
        return self._reply


class FakeTelegram:
    def __init__(self, error=None, action_error=None, events=None, files=None, download_error=None):
        self.sent = []
        self.actions = []
        self.options = []
        self.fetched = []
        self._files = files or {}  # file_id -> (File object, bytes)
        self._download_error = download_error
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

    async def get_file(self, file_id):
        self.fetched.append(("getFile", file_id))
        return self._files[file_id][0]

    async def download_file(self, file_path):
        self.fetched.append(("download", file_path))
        if self._download_error:
            raise self._download_error
        return next(data for info, data in self._files.values() if info["file_path"] == file_path)


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


VOICE = {"file_id": "v1", "file_unique_id": "u1", "duration": 3, "mime_type": "audio/ogg", "file_size": 9000}
PHOTO_SIZES = [
    {"file_id": "p-small", "width": 90, "height": 120, "file_size": 2_000},
    {"file_id": "p-medium", "width": 600, "height": 800, "file_size": 60_000},
    {"file_id": "p-large", "width": 1200, "height": 1600, "file_size": 300_000},
]


def media_update(chat_id=42, **fields):
    return {"update_id": 2, "message": {"chat": {"id": chat_id}, **fields}}


def file(file_id, data, path=None):
    info = {"file_id": file_id, "file_size": len(data), "file_path": path or f"files/{file_id}"}
    return {file_id: (info, data)}


async def test_a_voice_message_is_downloaded_and_goes_to_the_bot_as_ogg_audio():
    bot, tg = FakeBot("<b>24/09</b> · Peso kg 82"), FakeTelegram(files=file("v1", b"OggS...", "voice/f.oga"))
    await Handler({42}, bot, tg).handle_update(media_update(voice=VOICE))
    assert tg.fetched == [("getFile", "v1"), ("download", "voice/f.oga")]
    assert bot.texts == [("", "42")]
    assert bot.media == [[Media("audio/ogg", b"OggS...")]]
    assert tg.sent == [(42, "<b>24/09</b> · Peso kg 82")]
    assert tg.actions[0] == (42, "typing")


async def test_an_audio_file_keeps_its_mime_type_and_the_caption_goes_along():
    audio = {"file_id": "a1", "mime_type": "audio/mp4", "file_size": 100}
    bot, tg = FakeBot(), FakeTelegram(files=file("a1", b"m4a"))
    await Handler({42}, bot, tg).handle_update(media_update(audio=audio, caption="treino de hoje"))
    assert bot.texts == [("treino de hoje", "42")]
    assert bot.media == [[Media("audio/mp4", b"m4a")]]


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
    await Handler({42}, bot, tg, media_enabled=False).handle_update(media_update(voice=VOICE))
    assert tg.fetched == []
    assert bot.texts == []
    assert tg.sent == [(42, MEDIA_UNREADABLE)]


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
