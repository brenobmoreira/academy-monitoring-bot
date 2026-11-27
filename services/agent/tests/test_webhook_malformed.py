"""A malformed Telegram update, through both HTTP entry points: answered 200 (resending it would
not fix it), nothing written to the sheet, nothing sent to Telegram, and a log line that names the
update id and the bad field, never the body, an exception message or a traceback.

Sentinels stand for content: they sit in the malformed values and in the fields around them.
"""

import io
import logging
from collections.abc import Iterator
from typing import Any

import pytest

from agent import logs, webhook
from agent.handler import Handler, media_ref, strict_int

from .fakes import FakeSheet
from .test_handler import FakeBot, FakeTelegram, tap, update
from .test_webhook import SETTINGS, functions_framework_call, uvicorn_call

pytestmark = pytest.mark.unit

SENTINEL = "SENTINELA-MALFORMADO-4be7"
CHAT = 987650042  # a chat id no other number in a log line can be mistaken for
SENTINELS = (SENTINEL, str(CHAT))
FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"
ALLOWED = {42, CHAT, 1}  # 1: a chat id given as `true` must not pass for it
ENTRY_POINTS = [functions_framework_call, uvicorn_call]


class World:
    """What an update could touch: the sheet, Telegram and the model."""

    def __init__(self) -> None:
        self.sheet = FakeSheet()
        self.telegram = FakeTelegram()
        self.bot = FakeBot()
        self.built = 0

    def untouched(self) -> bool:
        tg = self.telegram
        return not (
            self.sheet.calls
            or self.bot.texts
            or tg.sent
            or tg.actions
            or tg.answered
            or tg.edited
            or tg.fetched
        )


@pytest.fixture
def world(monkeypatch) -> World:
    """The real webhook and the real Handler, over fakes."""
    world = World()

    def build(settings, http, **shared):
        world.built += 1
        return Handler(ALLOWED, world.bot, world.telegram, sheet=world.sheet)

    monkeypatch.setattr(webhook, "get_settings", lambda: SETTINGS)
    monkeypatch.setattr(webhook, "build_handler", build)
    return world


class Output:
    def __init__(self, caplog: pytest.LogCaptureFixture, stream: io.StringIO, capsys) -> None:
        self.caplog = caplog
        self._stream = stream
        self._capsys = capsys

    @property
    def text(self) -> str:
        return self.caplog.text

    def assert_clean(self) -> None:
        """No sentinel, traceback or exc_info in the root logger's records, their formatted
        output, stdout or stderr."""
        std = self._capsys.readouterr()
        blobs = [self._stream.getvalue(), self.caplog.text, std.out, std.err]
        for record in self.caplog.records:
            assert record.exc_info is None, record.getMessage()
            assert record.stack_info is None, record.getMessage()
            blobs += [record.getMessage(), repr(record.args), record.exc_text or ""]
        for blob in blobs:
            assert "Traceback" not in blob, blob[:300]
            for sentinel in SENTINELS:
                assert sentinel not in blob, blob[:300]


@pytest.fixture
def output(caplog, capsys) -> Iterator[Output]:
    """Every record at DEBUG, through caplog and through a stream with a production-like format."""
    logs.install()
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter(FORMAT))
    root = logging.getLogger()
    old_level = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    caplog.set_level(logging.DEBUG)
    try:
        yield Output(caplog, stream, capsys)
    finally:
        root.removeHandler(handler)
        root.setLevel(old_level)


def message_update(message: Any, update_id: Any = 501) -> dict[str, Any]:
    return {"update_id": update_id, "message": message}


def tap_update(query: Any) -> dict[str, Any]:
    return {"update_id": 502, "callback_query": query}


def undo_tap(message: Any) -> dict[str, Any]:
    """A tap that would undo a write on the sheet if its message were accepted."""
    return tap_update({"id": f"cb-{SENTINEL}", "data": "undo:w1", "message": message})


MALFORMED = [
    pytest.param(message_update(SENTINEL), "501", "message", id="message-string"),
    pytest.param(
        message_update([{"chat": {"id": 42}, "text": SENTINEL}]), "501", "message", id="message-list"
    ),
    pytest.param(message_update(7), "501", "message", id="message-number"),
    pytest.param(message_update(SENTINEL, update_id=SENTINEL), "None", "message", id="update-id-string"),
    pytest.param(
        message_update({"chat": SENTINEL, "text": SENTINEL}), "501", "message.chat", id="chat-string"
    ),
    pytest.param(
        message_update({"chat": [{"id": 42}], "text": SENTINEL}), "501", "message.chat", id="chat-list"
    ),
    pytest.param(
        message_update({"chat": {"id": [CHAT]}, "text": SENTINEL}),
        "501",
        "message.chat.id",
        id="chat-id-list",
    ),
    pytest.param(
        message_update({"chat": {"id": {"id": CHAT}}, "text": SENTINEL}),
        "501",
        "message.chat.id",
        id="chat-id-object",
    ),
    pytest.param(
        message_update({"chat": {"id": str(CHAT)}, "text": SENTINEL}),
        "501",
        "message.chat.id",
        id="chat-id-string",
    ),
    pytest.param(
        message_update({"chat": {"id": True}, "text": SENTINEL}), "501", "message.chat.id", id="chat-id-true"
    ),
    pytest.param(tap_update(SENTINEL), "502", "callback_query", id="callback-string"),
    pytest.param(tap_update(None), "502", "callback_query", id="callback-null"),
    pytest.param(tap_update([tap("undo:w1")["callback_query"]]), "502", "callback_query", id="callback-list"),
    pytest.param(undo_tap(SENTINEL), "502", "callback_query.message", id="callback-message-string"),
    pytest.param(
        undo_tap({"message_id": 9, "chat": SENTINEL}),
        "502",
        "callback_query.message.chat",
        id="callback-chat-string",
    ),
    pytest.param(
        undo_tap({"message_id": 9, "chat": {"id": [CHAT]}}),
        "502",
        "callback_query.message.chat.id",
        id="callback-chat-id-list",
    ),
]


@pytest.mark.parametrize("call", ENTRY_POINTS)
@pytest.mark.parametrize(("body", "update_id", "field"), MALFORMED)
def test_a_malformed_update_is_answered_200_and_ignored(world, output, call, body, update_id, field):
    assert call("sec", body) == ("ok", 200)
    assert world.untouched()
    assert f"ignoring malformed Telegram update {update_id}: bad {field}" in output.text
    assert "failed" not in output.text  # stopped at the handler, not by the webhook's net
    output.assert_clean()


@pytest.mark.parametrize("call", ENTRY_POINTS)
def test_a_valid_update_still_gets_its_reply(world, output, call):
    assert call("sec", update(text="peso 82", update_id=503)) == ("ok", 200)
    assert world.bot.texts == [("peso 82", "42")]
    assert world.telegram.sent == [(42, "ok")]
    assert "malformed" not in output.text and "failed" not in output.text


@pytest.mark.parametrize("call", ENTRY_POINTS)
def test_a_valid_tap_is_still_answered(world, call):
    assert call("sec", tap("ok")) == ("ok", 200)
    assert world.telegram.answered == [("cb1", None)]
    assert world.telegram.edited == [(42, 9, None)]


@pytest.mark.parametrize("call", ENTRY_POINTS)
def test_a_tap_without_a_message_is_not_malformed(world, output, call):
    """Telegram omits `message` for a button of an inline message; the tap is answered as before."""
    assert call("sec", tap_update({"id": "cb9", "data": "ok"})) == ("ok", 200)
    assert world.telegram.answered == [("cb9", None)]
    assert "malformed" not in output.text


@pytest.mark.parametrize("call", ENTRY_POINTS)
@pytest.mark.parametrize("replied", [SENTINEL, [SENTINEL], {"from": SENTINEL, "text": SENTINEL}])
def test_a_reply_reference_of_the_wrong_type_gives_no_context_and_the_message_is_processed(
    world, output, call, replied
):
    body = message_update({"chat": {"id": 42}, "text": "peso 82", "reply_to_message": replied})
    assert call("sec", body) == ("ok", 200)
    assert world.bot.contexts == [None]
    assert world.telegram.sent == [(42, "ok")]
    output.assert_clean()


@pytest.mark.parametrize("call", ENTRY_POINTS)
@pytest.mark.parametrize("photo", [7, {"file_id": SENTINEL}, SENTINEL])
def test_a_photo_field_of_the_wrong_type_is_a_message_with_nothing_to_read(world, output, call, photo):
    assert call("sec", message_update({"chat": {"id": 42}, "photo": photo})) == ("ok", 200)
    assert world.untouched()
    output.assert_clean()


# integers: a bool is never one -----------------------------------------------------------------

BUTTONS = ["ok", "undo:w1", "retry:k1", "fix", f"{SENTINEL}:x"]
NOT_A_MESSAGE_ID = [True, False, "9", 9.5, [9], {"id": 9}]


def id_tap(data: str, message_id: Any, chat_id: int = 42) -> dict[str, Any]:
    message = {"message_id": message_id, "chat": {"id": chat_id}, "text": SENTINEL}
    return tap_update({"id": f"cb-{SENTINEL}", "data": data, "message": message})


@pytest.mark.parametrize("call", ENTRY_POINTS)
@pytest.mark.parametrize("data", BUTTONS)
@pytest.mark.parametrize("message_id", NOT_A_MESSAGE_ID)
def test_a_tap_whose_message_id_is_not_an_integer_does_nothing_at_all(world, output, call, data, message_id):
    """Not the undo, not the retry, not a message, and not the answer to the tap either."""
    assert call("sec", id_tap(data, message_id)) == ("ok", 200)
    assert world.untouched()
    assert "ignoring malformed Telegram update 502: bad callback_query.message.message_id" in output.text
    output.assert_clean()


@pytest.mark.parametrize("call", ENTRY_POINTS)
def test_the_same_undo_tap_with_an_integer_message_id_reaches_the_sheet(world, call):
    """The control of the test above: only the type of `message_id` differs."""
    assert call("sec", id_tap("undo:w1", 9)) == ("ok", 200)
    assert [op for op, _ in world.sheet.calls] == ["write.undo"]
    assert len(world.telegram.answered) == 1


@pytest.mark.parametrize("call", ENTRY_POINTS)
@pytest.mark.parametrize("message_id", NOT_A_MESSAGE_ID)
def test_a_message_whose_message_id_is_not_an_integer_is_ignored(world, output, call, message_id):
    body = message_update({"message_id": message_id, "chat": {"id": 42}, "text": SENTINEL})
    assert call("sec", body) == ("ok", 200)
    assert world.untouched()
    assert "ignoring malformed Telegram update 501: bad message.message_id" in output.text
    output.assert_clean()


@pytest.mark.parametrize("call", ENTRY_POINTS)
@pytest.mark.parametrize("chat_id", [True, False])
def test_a_boolean_chat_id_is_malformed_in_a_tap_too(world, output, call, chat_id):
    assert call("sec", id_tap("undo:w1", 9, chat_id=chat_id)) == ("ok", 200)
    assert world.untouched()
    assert "bad callback_query.message.chat.id" in output.text


def test_strict_int_takes_integers_only():
    assert [strict_int(v) for v in (0, 7, -3)] == [0, 7, -3]
    assert [strict_int(v) for v in (True, False, 1.0, "1", None, [1])] == [None] * 6


def test_a_boolean_file_size_or_duration_is_treated_as_unknown():
    voice = {"voice": {"file_id": "v1", "file_size": True, "duration": True}}
    photo = {"photo": [{"file_id": "p1", "file_size": True}, {"file_id": "p2", "file_size": 10}]}
    assert media_ref(voice, 100) == ("v1", None, "audio/ogg", None)
    assert media_ref(photo, 100) == ("p2", 10, "image/jpeg", None)
    assert media_ref({"voice": {"file_id": "v1", "duration": -1}}, 100) == ("v1", None, "audio/ogg", None)
    assert media_ref({"audio": {"file_id": "a1", "duration": "9"}}, 100) == ("a1", None, "audio/mpeg", None)
    assert media_ref({"voice": {"file_id": "v1", "duration": 0}}, 100) == ("v1", None, "audio/ogg", 0)
    assert media_ref({"audio": {"file_id": "a1", "duration": 45}}, 100) == ("a1", None, "audio/mpeg", 45)


# optional fields of the wrong type --------------------------------------------------------------


@pytest.mark.parametrize("call", ENTRY_POINTS)
@pytest.mark.parametrize("form", [SENTINEL, [SENTINEL], 7, True, {}, {"data": 7}, {"data": [SENTINEL]}])
def test_an_invalid_web_app_data_does_not_drop_the_text_of_the_message(world, output, call, form):
    body = message_update({"chat": {"id": 42}, "text": "peso 82", "web_app_data": form})
    assert call("sec", body) == ("ok", 200)
    assert world.bot.texts == [("peso 82", "42")]
    assert world.telegram.sent == [(42, "ok")]
    assert world.sheet.calls == []
    output.assert_clean()


@pytest.mark.parametrize("call", ENTRY_POINTS)
@pytest.mark.parametrize(
    ("is_bot", "context"),
    [
        (True, "21/09 · Peso kg 82,4"),
        ("false", None),
        ("true", None),
        (1, None),
        (False, None),
        ([True], None),
    ],
)
def test_only_is_bot_true_makes_the_replied_text_context_for_the_model(world, call, is_bot, context):
    replied = {"from": {"is_bot": is_bot}, "text": "21/09 · Peso kg 82,4"}
    body = message_update({"chat": {"id": 42}, "text": "peso 82", "reply_to_message": replied})
    assert call("sec", body) == ("ok", 200)
    assert world.bot.contexts == [context]


# the net in webhook.process ---------------------------------------------------------------------


class LeakyError(Exception):
    def __init__(self) -> None:
        super().__init__(f"update was {SENTINEL} from {CHAT}", SENTINEL)
        self.body = {"text": SENTINEL}


def leaky() -> LeakyError:
    try:
        try:
            raise ValueError(f"inner {SENTINEL} {CHAT}")
        except ValueError as inner:
            raise LeakyError() from inner
    except LeakyError as err:
        return err


NET_LINE = "update {} failed: phase={} tests.test_webhook_malformed.LeakyError <- ValueError"


@pytest.mark.parametrize("call", ENTRY_POINTS)
@pytest.mark.parametrize(("update_id", "logged"), [(504, "504"), (SENTINEL, "None"), (True, "None")])
def test_an_exception_of_the_processing_is_answered_200_and_logged_by_its_class(
    world, output, monkeypatch, call, update_id, logged
):
    async def explode(settings, body):
        raise leaky()

    monkeypatch.setattr(webhook, "handle_update", explode)
    body = message_update({"chat": {"id": CHAT}, "text": SENTINEL}, update_id=update_id)
    assert call("sec", body) == ("ok", 200)
    assert NET_LINE.format(logged, "handle") in output.text
    assert world.untouched()
    output.assert_clean()


@pytest.mark.parametrize("call", ENTRY_POINTS)
def test_a_handler_that_cannot_be_built_is_answered_200_and_logged_by_its_class(
    world, output, monkeypatch, call
):
    def build(settings, http, **shared):
        raise leaky()

    monkeypatch.setattr(webhook, "build_handler", build)
    assert call("sec", update(text=SENTINEL, chat_id=CHAT, update_id=505)) == ("ok", 200)
    assert NET_LINE.format(505, "build") in output.text
    assert world.untouched()
    output.assert_clean()


@pytest.mark.parametrize("call", ENTRY_POINTS)
@pytest.mark.parametrize("secret", ["wrong", None, ""])
@pytest.mark.parametrize(
    "body",
    [message_update(SENTINEL), undo_tap(SENTINEL), update(text=SENTINEL, update_id=506), [SENTINEL]],
    ids=["malformed-message", "malformed-tap", "valid", "not-an-object"],
)
def test_a_wrong_secret_is_still_403_whatever_the_body(world, output, monkeypatch, call, secret, body):
    """The net covers the processing only: a request that fails the secret check reaches neither
    the handler nor the 200 of a malformed update."""

    async def explode(settings, update):
        raise leaky()

    assert call(secret, body) == ("forbidden", 403)
    assert world.built == 0 and world.untouched()
    monkeypatch.setattr(webhook, "handle_update", explode)
    assert call(secret, body) == ("forbidden", 403)
    assert "failed" not in output.text and "malformed" not in output.text
    output.assert_clean()


async def test_a_failing_secret_check_is_not_swallowed_by_the_net(world, monkeypatch):
    """An error of the authentication itself is not an update the bot cannot use: it is raised."""

    def broken(settings, given):
        raise RuntimeError("secret check broke")

    monkeypatch.setattr(webhook, "is_authorized", broken)
    with pytest.raises(RuntimeError):
        await webhook.process("sec", update())
    assert world.built == 0


# the handler alone (the poller calls it without the webhook's net) ------------------------------


@pytest.mark.parametrize("body", [SENTINEL, [SENTINEL], None, 7])
async def test_handle_update_ignores_a_body_that_is_not_an_object(world, output, body):
    await Handler(ALLOWED, world.bot, world.telegram, sheet=world.sheet).handle_update(body)
    assert world.untouched()
    assert "ignoring malformed Telegram update None: bad update" in output.text
    output.assert_clean()


@pytest.mark.parametrize(("body", "update_id", "field"), MALFORMED)
async def test_handle_update_never_raises_on_a_malformed_update(world, output, body, update_id, field):
    await Handler(ALLOWED, world.bot, world.telegram, sheet=world.sheet).handle_update(body)
    assert world.untouched()
    assert f"bad {field}" in output.text
    output.assert_clean()
