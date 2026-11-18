"""No client content in logs: describe(), the guard on library loggers, and the agent paths that log
exceptions (voice input design §10, task C4a), the buttons, the commands, the poller and the reminders.

Sentinels stand for content: a transcript or typed text and audio bytes (raw and base64). Each test
provokes a failure that carries them in every place an exception or a record can hold text (message,
args, chained cause, attributes, traceback) and checks the records and the formatted output.
"""

import asyncio
import base64
import copy
import io
import logging
from collections.abc import AsyncGenerator, Iterator
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx
import litellm
import pytest
from google.adk.models import LlmRequest, LlmResponse
from pydantic import SecretStr

from agent import buttons, logs, miniapp
from agent.bot import (
    MEDIA_UNREADABLE,
    MODEL_FAILED_NOTHING_WRITTEN,
    SHEET_FAILED,
    WRITE_UNCERTAIN,
    Bot,
    Media,
)
from agent.budget import MemoryBudget
from agent.handler import DOWNLOAD_FAILED, FAILURE, Handler
from agent.llm import RetryingClient
from agent.settings import TranscribeSettings
from agent.sheet_client import SheetClient
from agent.telegram import TelegramClient, TelegramError
from agent.transcribe import MIN_BODY_BYTES, Audio, TranscribeError, Transcriber

from .fakes import FakeLiteLLMClient, FakeSheet, ScriptedLlm, call, say, text_response
from .test_handler import FakeBot, FakeTelegram, tap, update, voice_update
from .test_miniapp import FOOD, tap_retry, web_app_update
from .test_miniapp import clock as miniapp_clock

pytestmark = pytest.mark.unit

TEXT_SENTINEL = "SENTINELA-TEXTO-91c2"
AUDIO_SENTINEL = b"SENTINEL-AUDIO-7f3a"
AUDIO_B64 = base64.b64encode(AUDIO_SENTINEL).decode()
SENTINELS = (TEXT_SENTINEL, AUDIO_SENTINEL.decode(), AUDIO_B64)
CHAT = 987650042  # a chat id no other number in a log line can be mistaken for
NOW = datetime(2026, 9, 21, 15, 0, tzinfo=ZoneInfo("America/Sao_Paulo"))
FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"


class EchoResponse:
    """An HTTP response object that repeats the request, as provider SDK errors carry."""

    text = TEXT_SENTINEL
    content = AUDIO_SENTINEL

    def json(self):
        return {"echo": TEXT_SENTINEL, "audio": AUDIO_B64}

    def __repr__(self):
        return f"<EchoResponse {TEXT_SENTINEL}>"


class LeakyError(Exception):
    """Content in the message, the args and every attribute describe() could be tempted to read."""

    def __init__(self) -> None:
        super().__init__(f"request was {TEXT_SENTINEL} {AUDIO_B64}", TEXT_SENTINEL)
        self.code = TEXT_SENTINEL
        self.status_code = TEXT_SENTINEL
        self.body = {"input_audio": AUDIO_B64, "text": TEXT_SENTINEL}
        self.message = TEXT_SENTINEL
        self.llm_provider = TEXT_SENTINEL
        self.response = EchoResponse()


def leaky() -> LeakyError:
    """A LeakyError with a traceback and a chained cause that also carries content."""
    try:
        try:
            raise ValueError(f"inner {TEXT_SENTINEL} {AUDIO_B64}")
        except ValueError as inner:
            raise LeakyError() from inner
    except LeakyError as err:
        return err


def leaky_bad_request() -> litellm.BadRequestError:
    """LiteLLM's own error type (a media rejection), with content in its message and attributes."""
    err = litellm.BadRequestError(f"bad audio {AUDIO_B64} for {TEXT_SENTINEL}", model="m", llm_provider="p")
    err.body = {"echo": TEXT_SENTINEL}  # type: ignore[attr-defined]
    return err


def assert_clean(records: list[logging.LogRecord], output: str) -> None:
    for record in records:
        blobs = (record.getMessage(), repr(record.args), record.exc_text or "", record.stack_info or "")
        for blob in blobs:
            for sentinel in SENTINELS:
                assert sentinel not in blob, f"{record.name}: {blob[:200]}"
    for sentinel in SENTINELS:
        assert sentinel not in output


@pytest.fixture
def captured(caplog) -> Iterator[tuple[pytest.LogCaptureFixture, io.StringIO]]:
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
        yield caplog, stream
    finally:
        root.removeHandler(handler)
        root.setLevel(old_level)


def own_logger(name: str) -> tuple[logging.Logger, io.StringIO]:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter(FORMAT))
    logger = logging.getLogger(name)
    logger.handlers = [handler]
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    return logger, stream


# describe() ------------------------------------------------------------------------------------


class Coded(Exception):
    def __init__(self, status_code=None, code=None, status=None):
        super().__init__(TEXT_SENTINEL)
        if status_code is not None:
            self.status_code = status_code
        if code is not None:
            self.code = code
        if status is not None:
            self.status = status


def test_describe_gives_class_status_and_a_known_code():
    assert logs.describe(RuntimeError(TEXT_SENTINEL)) == "RuntimeError"
    described = logs.describe(Coded(status_code=503, code="unavailable"))
    assert described == "tests.test_log_safety.Coded[status=503 code=unavailable]"


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        ({"code": TEXT_SENTINEL}, "code=other"),
        ({"code": "unknown_code_not_listed"}, "code=other"),
        ({"code": 404}, "code=404"),
        ({"code": 99}, "code=other"),
        ({"code": True}, "code=other"),
        ({"status_code": TEXT_SENTINEL}, "status=other"),
        ({"status_code": 600}, "status=other"),
        ({"status_code": True}, "status=other"),
        ({"status": 429}, "status=429"),
    ],
)
def test_describe_prints_only_listed_codes_and_http_statuses(kwargs, expected):
    described = logs.describe(Coded(**kwargs))
    assert expected in described
    assert TEXT_SENTINEL not in described


def test_describe_reads_no_other_attribute_and_never_the_message():
    described = logs.describe(leaky())
    assert described == "tests.test_log_safety.LeakyError[status=other code=other] <- ValueError"
    for sentinel in SENTINELS:
        assert sentinel not in described


class Hostile(Exception):
    def __str__(self):
        raise AssertionError("describe must not call str()")

    def __repr__(self):
        raise AssertionError("describe must not call repr()")

    @property
    def status_code(self):
        raise RuntimeError(TEXT_SENTINEL)


def test_describe_survives_exceptions_whose_str_repr_and_properties_raise():
    assert logs.describe(Hostile()) == "tests.test_log_safety.Hostile"


def test_describe_prints_a_class_defined_in_a_function_as_exception():
    class Local(Exception):
        pass

    assert logs.describe(Local(TEXT_SENTINEL)) == "Exception"  # "<locals>" is not a plain name


def test_describe_hides_a_class_name_built_at_run_time_with_content():
    smuggler = type(f"Leak {TEXT_SENTINEL}", (Exception,), {})
    assert logs.describe(smuggler("x")) == "Exception"


def test_describe_follows_the_context_stops_at_five_links_and_on_a_cycle():
    try:
        try:
            raise KeyError(TEXT_SENTINEL)
        except KeyError:
            raise TimeoutError(TEXT_SENTINEL)  # noqa: B904 - an implicit context on purpose
    except TimeoutError as err:
        assert logs.describe(err) == "TimeoutError <- KeyError"

    chain: BaseException = OSError(TEXT_SENTINEL)
    for _ in range(7):
        outer = RuntimeError(TEXT_SENTINEL)
        outer.__cause__ = chain
        chain = outer
    assert logs.describe(chain).count(" <- ") == 4

    a, b = ValueError("a"), TypeError("b")
    a.__cause__, b.__cause__ = b, a
    assert logs.describe(a) == "ValueError <- TypeError"


def test_safe_code_keeps_only_listed_codes():
    assert logs.safe_code("not_in_catalog") == "not_in_catalog"
    assert logs.safe_code(TEXT_SENTINEL) == "other"
    assert logs.safe_code(None) == "other"


# the guard on library loggers -----------------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "LiteLLM",
        "LiteLLM Router",
        "litellm.utils",
        "google_adk.google.adk.models.lite_llm",
        "google_genai.models",
        "httpcore.http11",
    ],
)
def test_library_records_lose_message_args_and_traceback(name):
    logs.install()
    logger, stream = own_logger(name)
    records: list[logging.LogRecord] = []
    logger.addFilter(lambda r: records.append(r) or True)
    logger.debug("request %s body %r", TEXT_SENTINEL, {"audio": AUDIO_B64})
    try:
        raise leaky()
    except LeakyError:
        logger.exception("call failed for %s", TEXT_SENTINEL, stack_info=True)
    out = stream.getvalue()
    assert_clean(records, out)
    assert f"{name} DEBUG record (content omitted)" in out
    assert f"{name} ERROR record (content omitted): tests.test_log_safety.LeakyError" in out
    assert all(r.args == () and r.exc_info is None and r.stack_info is None for r in records)


def test_records_of_other_loggers_keep_their_message():
    logs.install()
    logger, stream = own_logger("agent.test_guard")
    logger.warning("update %s cut", 7)
    assert "update 7 cut" in stream.getvalue()


def test_handle_error_reports_a_library_record_without_its_arguments(capsys, monkeypatch):
    logs.install()
    monkeypatch.setattr(logging, "raiseExceptions", True)
    record = logging.LogRecord("LiteLLM", logging.ERROR, __file__, 1, "%d", (TEXT_SENTINEL,), None)
    handler = logging.StreamHandler(io.StringIO())
    try:
        raise ValueError("formatting failed")
    except ValueError:
        handler.handleError(record)
    err = capsys.readouterr().err
    assert "--- Logging error ---" in err
    for sentinel in SENTINELS:
        assert sentinel not in err


def test_a_formatter_failing_on_a_library_record_prints_no_exception_on_stderr(capsys, monkeypatch):
    """The formatting error is raised while the logged exception is being handled, so that
    exception is its `__context__`: a traceback of the formatting error would print it."""
    logs.install()
    monkeypatch.setattr(logging, "raiseExceptions", True)
    logger, stream = own_logger("LiteLLM")
    logger.handlers[0].setFormatter(logging.Formatter("%(levelname)s %(no_such_field)s %(message)s"))
    try:
        raise leaky()
    except LeakyError:
        logger.exception("call failed for %s", TEXT_SENTINEL, stack_info=True)
    finally:
        logger.handlers = []  # the library logs on its own later; not through a broken formatter
    err = capsys.readouterr().err
    assert "--- Logging error ---" in err
    assert "ValueError while writing a log record" in err
    assert "logger LiteLLM, level ERROR" in err
    for leaked in (*SENTINELS, "Traceback", "LeakyError", "Call stack", "no_such_field", "call failed"):
        assert leaked not in err
    assert stream.getvalue() == ""


def test_the_formatting_error_report_hides_a_file_or_logger_name_that_is_not_a_plain_name(
    capsys, monkeypatch
):
    logs.install()
    monkeypatch.setattr(logging, "raiseExceptions", True)
    path = f"/tmp/{TEXT_SENTINEL}/x y?.py"
    record = logging.LogRecord(f"lib:{TEXT_SENTINEL}", logging.ERROR, path, 1, "%d", ("x",), None)
    record.filename = f"<{TEXT_SENTINEL}>"
    try:
        raise ValueError(TEXT_SENTINEL)
    except ValueError:
        logging.StreamHandler(io.StringIO()).handleError(record)
    err = capsys.readouterr().err
    assert "ValueError while writing a log record" in err
    assert "Logged from file ?, line 1, logger ?, level ERROR" in err
    assert TEXT_SENTINEL not in err


# ref() -----------------------------------------------------------------------------------------


def test_ref_is_stable_in_a_process_opaque_and_salted(monkeypatch):
    first = logs.ref(CHAT)
    assert first == logs.ref(CHAT) != logs.ref(CHAT + 1)
    assert len(first) == 8 and int(first, 16) >= 0
    assert str(CHAT) not in first
    monkeypatch.setattr(logs, "_REF_SALT", b"another process")
    assert logs.ref(CHAT) != first


# the agent paths -------------------------------------------------------------------------------


def bot(sheet, script, **kw):
    llm = ScriptedLlm(model="scripted", script=script, requests=[])
    return Bot(sheet, llm, timezone="America/Sao_Paulo", clock=lambda: NOW, **kw)


async def test_a_failing_model_call_logs_no_text_and_no_exception_content(captured):
    caplog, stream = captured
    answer = await bot(FakeSheet(), [leaky()]).reply(TEXT_SENTINEL)
    assert answer.text == MODEL_FAILED_NOTHING_WRITTEN
    assert_clean(caplog.records, stream.getvalue())
    assert (
        "model call failed: tests.test_log_safety.LeakyError[status=other code=other] <- ValueError"
        in caplog.text
    )


async def test_a_transient_model_retry_logs_through_describe_without_sentinel_class_name(captured, capsys):
    caplog, stream = captured
    smuggled = type(f"Leak {TEXT_SENTINEL}", (litellm.ServiceUnavailableError,), {})
    err = smuggled(
        f"overloaded {TEXT_SENTINEL} {AUDIO_B64}",
        llm_provider=TEXT_SENTINEL,
        model="gemini/gemini-3.8-flash",
    )
    err.code = TEXT_SENTINEL
    client = FakeLiteLLMClient([err, text_response("ok")])
    retrying = RetryingClient(client, retries=1, wait_s=0)

    response = await retrying.acompletion(
        "gemini/gemini-3.8-flash",
        [{"role": "user", "content": TEXT_SENTINEL}],
        None,
    )

    assert response.choices[0].message.content == "ok"
    assert len(client.requests) == 2
    std = capsys.readouterr()
    assert_clean(caplog.records, stream.getvalue() + std.out + std.err)
    assert (
        "model gemini/gemini-3.8-flash unavailable (Exception[status=503 code=other]), attempt 1 of 2"
        in caplog.text
    )


async def test_a_transient_transcription_retry_logs_through_describe_without_sentinel_class_name(
    captured, capsys
):
    caplog, stream = captured
    smuggled = type(f"Leak {TEXT_SENTINEL}", (litellm.ServiceUnavailableError,), {})
    err = smuggled(
        f"overloaded {TEXT_SENTINEL} {AUDIO_B64}",
        llm_provider=TEXT_SENTINEL,
        model="gemini/gemini-3.8-flash",
    )
    err.code = TEXT_SENTINEL
    audio_bytes = (AUDIO_SENTINEL * (MIN_BODY_BYTES // len(AUDIO_SENTINEL) + 1))[:MIN_BODY_BYTES]
    transcript_text = f"peso 82,5 {TEXT_SENTINEL}"
    client = FakeLiteLLMClient([err, text_response(transcript_text)])
    settings = TranscribeSettings.model_construct(
        TRANSCRIBE_MODEL="gemini/gemini-3.8-flash",
        TRANSCRIBE_API_KEY=SecretStr("key-for-tests"),
        TRANSCRIBE_RETRIES=1,
        TRANSCRIBE_RETRY_WAIT_S=0.0,
    )
    budget = MemoryBudget(principal_daily=100_000, global_daily=100_000, timezone="America/Sao_Paulo")
    transcriber = Transcriber(settings, budget, client=client, clock=lambda: NOW)

    transcript = await transcriber.transcribe(
        Audio("audio/ogg", audio_bytes),
        principal_key=f"tg:{CHAT}",
    )

    assert transcript.text == transcript_text
    assert len(client.requests) == 2
    std = capsys.readouterr()
    assert_clean(caplog.records, stream.getvalue() + std.out + std.err)
    assert str(CHAT) not in caplog.text + stream.getvalue() + std.out + std.err
    assert (
        "model gemini/gemini-3.8-flash unavailable (Exception[status=503 code=other]), attempt 1 of 2"
        in caplog.text
    )
    assert "transcribed: model=gemini/gemini-3.8-flash" in caplog.text


async def test_a_rejected_audio_logs_no_audio_no_caption_and_no_provider_text(captured):
    caplog, stream = captured
    answer = await bot(FakeSheet(), [leaky_bad_request()]).reply(
        TEXT_SENTINEL, media=[Media("audio/ogg", AUDIO_SENTINEL)]
    )
    assert answer.text == MEDIA_UNREADABLE
    assert_clean(caplog.records, stream.getvalue())
    assert "model rejected the media of a message" in caplog.text


async def test_the_call_budget_logs_the_length_of_the_message_not_its_text(captured):
    caplog, stream = captured
    script = [call("get_catalog"), call("get_catalog"), say("ok")]
    await bot(FakeSheet(), script, max_llm_calls=1).reply(TEXT_SENTINEL)
    assert_clean(caplog.records, stream.getvalue())
    assert f"LLM call budget exhausted for a message of {len(TEXT_SENTINEL)} characters" in caplog.text


class HangingLlm(ScriptedLlm):
    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        self.requests.append(llm_request)
        await asyncio.sleep(5)
        yield LlmResponse(content=say("late"))


async def test_the_message_deadline_logs_the_length_of_the_message_not_its_text(captured):
    caplog, stream = captured
    llm = HangingLlm(model="hanging", script=[], requests=[])
    b = Bot(FakeSheet(), llm, timezone="America/Sao_Paulo", clock=lambda: NOW, deadline_s=0.05)
    await b.reply(TEXT_SENTINEL)
    assert_clean(caplog.records, stream.getvalue())
    assert f"reached for a message of {len(TEXT_SENTINEL)} characters" in caplog.text


async def test_a_sheet_outage_logs_only_listed_error_codes(captured):
    caplog, stream = captured
    down = {
        "ok": False,
        "errors": [{"code": "unavailable", "message": TEXT_SENTINEL}, {"code": TEXT_SENTINEL}],
    }
    sheet = FakeSheet(catalog=[down])
    script = [call("get_catalog"), say("A planilha não respondeu.")]
    answer = await bot(sheet, script).reply(TEXT_SENTINEL)
    assert answer.text == SHEET_FAILED
    assert_clean(caplog.records, stream.getvalue())
    assert "sheet unavailable: unavailable, other" in caplog.text


async def test_an_uncertain_write_logs_only_listed_error_codes(captured):
    caplog, stream = captured
    # A code outside the closed pre-write list, mixed with a listed one: the write may have landed.
    mixed = {
        "ok": False,
        "errors": [{"code": "unavailable", "message": TEXT_SENTINEL}, {"code": TEXT_SENTINEL}],
        "writeState": TEXT_SENTINEL,
    }
    sheet = FakeSheet(diary_upsert=[mixed])
    script = [
        call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}),
        say("Pode ter gravado."),
    ]
    answer = await bot(sheet, script).reply(TEXT_SENTINEL)
    assert WRITE_UNCERTAIN in answer.text and answer.outcome == "uncertain"
    assert_clean(caplog.records, stream.getvalue())
    assert "write outcome uncertain: write_uncertain" in caplog.text


async def test_the_handler_logs_a_failing_bot_without_content(captured):
    caplog, stream = captured
    tg = FakeTelegram()
    await Handler({42}, FakeBot(error=leaky()), tg).handle_update(update(text=TEXT_SENTINEL))
    assert tg.sent == [(42, FAILURE)]
    assert_clean(caplog.records, stream.getvalue())
    assert "bot failed on update 1: tests.test_log_safety.LeakyError" in caplog.text


async def test_the_handler_logs_a_failing_download_without_content(captured):
    caplog, stream = captured
    files = {"v1": ({"file_path": "voice/1.oga", "file_size": 10}, AUDIO_SENTINEL)}
    tg = FakeTelegram(files=files, download_error=leaky())
    await Handler({42}, FakeBot(), tg).handle_update(voice_update())
    assert tg.sent == [(42, DOWNLOAD_FAILED)]
    assert_clean(caplog.records, stream.getvalue())
    assert "could not download the file of update 7" in caplog.text


async def test_the_handler_logs_a_failing_send_without_content(captured):
    caplog, stream = captured
    tg = FakeTelegram(error=leaky())
    await Handler({42}, FakeBot(TEXT_SENTINEL), tg).handle_update(update(text=TEXT_SENTINEL))
    assert_clean(caplog.records, stream.getvalue())
    assert "could not send the reply of update 1: tests.test_log_safety.LeakyError" in caplog.text


# buttons and commands --------------------------------------------------------------------------

DOWN = {"ok": False, "errors": [{"path": "", "code": "unavailable", "message": TEXT_SENTINEL}]}


class EchoingSheet(FakeSheet):
    """Once its queued answers are used up, a call fails with an error that repeats what it was
    asked to write or read, as a sheet or HTTP error can."""

    def _next(self, op, args):
        if not self.responses.get(op.replace(".", "_")):
            self.calls.append((op, args))
            try:
                raise ValueError(f"inner {args!r}")
            except ValueError as inner:
                raise RuntimeError(f"{op} refused {args!r}") from inner
        return super()._next(op, args)


async def test_the_retry_button_logs_a_failing_sheet_without_the_stored_form(captured, monkeypatch):
    """The path of 🔁: the form is stored when the sheet is down, the tap replays it through
    miniapp.retry(), and the sheet fails with an error that echoes the form."""
    monkeypatch.setattr(miniapp, "RETRY_DELAYS", (0, 0))
    caplog, stream = captured
    form = copy.deepcopy(FOOD)
    form["args"]["meal"] = TEXT_SENTINEL
    form["args"]["items"] = [{"description": f"{TEXT_SENTINEL} {AUDIO_B64}", "qty": 1, "unit": "un"}]
    sheet, tg = EchoingSheet(food_add=[DOWN, DOWN, DOWN]), FakeTelegram()
    handler = Handler({42}, FakeBot(), tg, sheet=sheet, clock=miniapp_clock())
    await handler.handle_update(web_app_update(form, update_id=20))
    data = tg.options[0]["reply_markup"]["inline_keyboard"][0][0]["callback_data"]
    assert data.startswith("retry:")

    await handler.handle_update(tap_retry(data))
    assert len(sheet.calls) == 4 and TEXT_SENTINEL in repr(sheet.calls[-1])  # the form was replayed
    assert tg.answered == [("cb", FAILURE)]
    assert_clean(caplog.records, stream.getvalue())
    assert "button retry failed on update 21: RuntimeError <- ValueError" in caplog.text
    assert data not in caplog.text and data.partition(":")[2] not in caplog.text
    assert "Traceback" not in caplog.text and "Traceback" not in stream.getvalue()
    assert all(r.exc_info is None for r in caplog.records)


async def test_a_failing_command_logs_no_typed_argument_and_no_exception_content(captured):
    caplog, stream = captured
    tg = FakeTelegram()
    handler = Handler({42}, FakeBot(), tg, sheet=EchoingSheet(), clock=miniapp_clock())
    await handler.handle_update(update(text="/hoje 21/09"))
    assert tg.sent == [(42, FAILURE)]
    assert_clean(caplog.records, stream.getvalue())
    assert "command /hoje failed on update 1: RuntimeError <- ValueError" in caplog.text
    assert "2026-09-21" not in caplog.text and "Traceback" not in caplog.text
    assert all(r.exc_info is None for r in caplog.records)


class FailingAnswerTelegram(FakeTelegram):
    async def answer_callback_query(self, callback_query_id, text=None):
        raise leaky()


async def test_a_failing_button_answer_logs_no_exception_content_and_no_query_id(captured):
    caplog, stream = captured
    query = tap("ok")
    query["callback_query"]["id"] = f"cb-{TEXT_SENTINEL}"
    await Handler({42}, FakeBot(), FailingAnswerTelegram()).handle_update(query)
    assert_clean(caplog.records, stream.getvalue())
    assert "could not answer the tap of update 2: tests.test_log_safety.LeakyError" in caplog.text
    assert "Traceback" not in caplog.text
    assert all(r.exc_info is None for r in caplog.records)


async def test_unknown_callback_data_is_logged_by_its_length_only(captured):
    caplog, stream = captured
    data = f"{TEXT_SENTINEL}:{AUDIO_B64}"
    tg = FakeTelegram()
    await Handler({42}, FakeBot(), tg).handle_update(tap(data))
    assert tg.answered == [("cb1", None)]
    assert_clean(caplog.records, stream.getvalue())
    assert f"unknown button data of {len(data)} characters on update 2" in caplog.text


async def test_a_failing_button_is_logged_by_its_action_not_its_callback_data(captured):
    caplog, stream = captured
    tg = FakeTelegram()
    handler = Handler({42}, FakeBot(), tg, sheet=EchoingSheet())
    await handler.handle_update(tap(f"undo:{TEXT_SENTINEL}"))
    assert tg.answered == [("cb1", FAILURE)]
    assert_clean(caplog.records, stream.getvalue())
    assert "button undo failed on update 2: RuntimeError <- ValueError" in caplog.text


def test_the_action_of_a_button_is_a_listed_verb_or_other():
    assert [
        buttons.action(d) for d in ("ok", "undo:w1,w2", "retry:k", "fix", "vok:abc", "vfix:abc", "vno:abc")
    ] == [
        "ok",
        "undo",
        "retry",
        "fix",
        "vok",
        "vfix",
        "vno",
    ]
    assert buttons.action(f"{TEXT_SENTINEL}:x") == "other"
    assert buttons.action(TEXT_SENTINEL) == "other"
    assert buttons.action("") == "other"


class AllFailingTelegram(FakeTelegram):
    async def send_message(self, chat_id, text, *, html=False, reply_markup=None, reply_to=None):
        raise leaky()

    async def answer_callback_query(self, callback_query_id, text=None):
        raise leaky()

    async def edit_message_reply_markup(self, chat_id, message_id, reply_markup=None):
        raise leaky()


async def test_voice_and_undo_callbacks_log_failing_telegram_calls_without_leaks(captured):
    from agent.voice_confirm import VoiceConfirmations, sha256_hex

    caplog, stream = captured
    store = VoiceConfirmations()
    vid_ok = store.create(CHAT, sha256_hex(TEXT_SENTINEL), message_id=9)
    vid_fix = store.create(CHAT, sha256_hex(TEXT_SENTINEL), message_id=10)
    vid_no = store.create(CHAT, sha256_hex(TEXT_SENTINEL), message_id=11)

    sheet = FakeSheet(write_undo=[{"ok": False, "errors": [{"code": "internal", "message": TEXT_SENTINEL}]}])
    tg = AllFailingTelegram()
    handler = Handler({CHAT}, FakeBot(TEXT_SENTINEL), tg, sheet=sheet, confirmations=store)

    for idx, (verb, vid, mid) in enumerate(
        (("vok", vid_ok, 9), ("vfix", vid_fix, 10), ("vno", vid_no, 11)), start=40
    ):
        cb = {
            "update_id": idx,
            "callback_query": {
                "id": f"cb-{TEXT_SENTINEL}",
                "from": {"id": CHAT, "is_bot": False},
                "data": f"{verb}:{vid}",
                "message": {
                    "message_id": mid,
                    "chat": {"id": CHAT},
                    "date": 1_700_000_000,
                    "text": buttons.entendi_text(TEXT_SENTINEL),
                },
            },
        }
        await handler.handle_update(cb)

    undo_cb = {
        "update_id": 43,
        "callback_query": {
            "id": f"cb-{TEXT_SENTINEL}",
            "data": "undo:w1",
            "message": {"message_id": 12, "chat": {"id": CHAT}, "text": TEXT_SENTINEL},
        },
    }
    await handler.handle_update(undo_cb)

    assert_clean(caplog.records, stream.getvalue())
    assert_no_chat_id(caplog, stream)
    for vid in (vid_ok, vid_fix, vid_no):
        assert vid not in caplog.text and vid not in stream.getvalue()
    assert "could not answer the tap of update 40: tests.test_log_safety.LeakyError" in caplog.text
    assert "could not remove the buttons of message 9: tests.test_log_safety.LeakyError" in caplog.text
    assert "could not send the reply of update 40: tests.test_log_safety.LeakyError" in caplog.text
    assert "could not send the reply of update 43: tests.test_log_safety.LeakyError" in caplog.text
    assert "Traceback" not in caplog.text and "Traceback" not in stream.getvalue()
    assert all(r.exc_info is None for r in caplog.records)


# chat ids --------------------------------------------------------------------------------------


def assert_no_chat_id(caplog, stream):
    assert str(CHAT) not in caplog.text and str(CHAT) not in stream.getvalue()
    for record in caplog.records:
        assert CHAT not in (record.args or ()), record.getMessage()


async def test_a_failing_send_names_the_update_not_the_chat(captured):
    caplog, stream = captured
    tg = FakeTelegram(error=RuntimeError("blocked"))
    await Handler({CHAT}, FakeBot(), tg).handle_update(update(chat_id=CHAT, update_id=31))
    assert "could not send the reply of update 31: RuntimeError" in caplog.text
    assert_no_chat_id(caplog, stream)


async def test_a_failing_typing_action_names_the_update_not_the_chat(captured):
    caplog, stream = captured
    tg = FakeTelegram(action_error=RuntimeError("blocked"))
    await Handler({CHAT}, FakeBot(), tg).handle_update(update(chat_id=CHAT, update_id=32))
    assert "could not send the typing action for update 32: RuntimeError" in caplog.text
    assert_no_chat_id(caplog, stream)


async def test_a_cut_update_that_cannot_be_announced_names_the_update_not_the_chat(captured):
    caplog, stream = captured
    tg = FakeTelegram(error=RuntimeError("blocked"))
    handler = Handler({CHAT}, FakeBot(seconds=5), tg, message_deadline_s=0.05, send_reserve_s=0.0)
    await handler.handle_update(update(chat_id=CHAT, update_id=33))
    assert "could not tell the chat update 33 was cut: RuntimeError" in caplog.text
    assert_no_chat_id(caplog, stream)


# safe fields our own code records (the guard removes the libraries' request lines) ---------------


def over(*responses) -> httpx.AsyncClient:
    queue = list(responses)

    def answer(request):
        step = queue.pop(0)
        if isinstance(step, Exception):
            raise step
        return step

    return httpx.AsyncClient(transport=httpx.MockTransport(answer))


async def test_a_telegram_error_is_described_by_its_http_status_not_its_description(captured):
    caplog, stream = captured
    body = {"ok": False, "error_code": 400, "description": f"Bad Request: {TEXT_SENTINEL}"}
    client = TelegramClient("123:token-for-tests", over(httpx.Response(400, json=body)))
    with pytest.raises(TelegramError) as raised:
        await client.send_message(42, TEXT_SENTINEL)
    assert (raised.value.status_code, raised.value.error_code) == (400, 400)
    assert logs.describe(raised.value) == "agent.telegram.TelegramError[status=400]"
    tg = FakeTelegram(error=raised.value)
    await Handler({42}, FakeBot(), tg).handle_update(update())
    assert_clean(caplog.records, stream.getvalue())
    assert "could not send the reply of update 1: agent.telegram.TelegramError[status=400]" in caplog.text


async def test_a_failing_sheet_call_logs_the_operation_and_the_http_status_only(captured):
    caplog, stream = captured
    http = over(
        httpx.Response(500, text=f"boom {TEXT_SENTINEL}"),
        httpx.ConnectError(f"no route for {TEXT_SENTINEL}"),
        httpx.Response(200, text=f"<html>{TEXT_SENTINEL}</html>"),
        httpx.Response(200, json=[TEXT_SENTINEL]),
    )
    sheet = SheetClient("https://sheet.invalid/exec", "key-for-tests", http)
    for _ in range(4):
        answer = await sheet.day("2026-09-21")
        assert answer["errors"][0]["code"] == "unavailable"
    lines = [r.getMessage() for r in caplog.records if r.name == "agent.sheet_client"]
    assert lines == [
        "sheet call day.get answered HTTP 500",
        "sheet call day.get got no answer: httpx.ConnectError",
        "sheet call day.get answered HTTP 200 without JSON",
        "sheet call day.get answered HTTP 200 without the API envelope",
    ]
    assert_clean([r for r in caplog.records if r.name.startswith("agent")], "\n".join(lines))


def test_describe_prints_the_transcription_error_codes():
    for code in (
        "unsupported_format",
        "too_long",
        "no_speech",
        "failed",
        "timeout",
        "budget_exhausted",
        "disabled",
    ):
        assert logs.describe(TranscribeError(code)).endswith(f"[code={code}]"), code


# chat voice path (§10.3, task C4d) ---------------------------------------------------------------


async def test_chat_voice_path_never_logs_audio_transcript_caption_chat_id_or_leaky_errors(captured, capsys):
    from agent.bot import VOICE_FAILED
    from agent.voice_confirm import VoiceConfirmations

    from .fakes import file

    caplog, stream = captured
    caption_sentinel = "SENTINELA-LEGENDA-5d2e"
    padded_audio = AUDIO_SENTINEL * ((MIN_BODY_BYTES // len(AUDIO_SENTINEL)) + 2)
    padded_b64 = base64.b64encode(padded_audio).decode("ascii")
    voice_item = {
        "file_id": "v-sec",
        "duration": 9,
        "mime_type": "audio/ogg",
        "file_size": len(padded_audio),
    }

    budget = MemoryBudget(principal_daily=200_000, global_daily=500_000, timezone="America/Sao_Paulo")
    tx_settings = TranscribeSettings(
        TRANSCRIBE_MODEL="gemini/gemini-3.8-flash",
        TRANSCRIBE_API_KEY=SecretStr("secret-transcribe-key"),
        TRANSCRIBE_RETRIES=0,
    )

    # 1. Success -> Entendi -> vok -> Bot raises LeakyError: no sentinel or chat_id anywhere.
    tx_ok = Transcriber(
        tx_settings,
        budget,
        client=FakeLiteLLMClient([text_response(TEXT_SENTINEL)]),
        clock=lambda: NOW,
    )
    tg = FakeTelegram(files=file("v-sec", padded_audio, "voice/sec.oga"))
    confirmations = VoiceConfirmations()
    handler = Handler(
        {CHAT},
        FakeBot(error=leaky()),
        tg,
        confirmations=confirmations,
        transcriber=tx_ok,
    )
    await handler.handle_update(
        {
            "update_id": 601,
            "message": {
                "message_id": 7,
                "chat": {"id": CHAT},
                "voice": voice_item,
                "caption": caption_sentinel,
            },
        }
    )
    _, entendi_msg = tg.sent[-1]
    vid = tg.options[-1]["reply_markup"]["inline_keyboard"][0][0]["callback_data"].partition(":")[2]
    await handler.handle_update(
        {
            "update_id": 602,
            "callback_query": {
                "id": "cb-602",
                "data": f"vok:{vid}",
                "message": {
                    "message_id": 1,
                    "date": 1_700_000_000,
                    "chat": {"id": CHAT},
                    "text": entendi_msg,
                },
            },
        }
    )

    # 2. Provider LeakyError inside Transcriber -> VOICE_FAILED, logged safely.
    tx_fail = Transcriber(
        tx_settings,
        budget,
        client=FakeLiteLLMClient([leaky()]),
        clock=lambda: NOW,
    )
    tg_fail = FakeTelegram(files=file("v-sec", padded_audio, "voice/sec.oga"))
    await Handler({CHAT}, FakeBot(), tg_fail, transcriber=tx_fail).handle_update(
        {
            "update_id": 603,
            "message": {"chat": {"id": CHAT}, "voice": voice_item, "caption": caption_sentinel},
        }
    )
    assert tg_fail.sent == [(CHAT, VOICE_FAILED)]

    # 3. Sending Entendi fails with LeakyError -> entry deleted, logged safely.
    tx_send_fail = Transcriber(
        tx_settings,
        budget,
        client=FakeLiteLLMClient([text_response(TEXT_SENTINEL)]),
        clock=lambda: NOW,
    )
    fail_confirmations = VoiceConfirmations()
    tg_send_fail = FakeTelegram(files=file("v-sec", padded_audio, "voice/sec.oga"), error=leaky())
    await Handler(
        {CHAT},
        FakeBot(),
        tg_send_fail,
        confirmations=fail_confirmations,
        transcriber=tx_send_fail,
    ).handle_update(
        {
            "update_id": 604,
            "message": {"chat": {"id": CHAT}, "voice": voice_item, "caption": caption_sentinel},
        }
    )
    assert len(fail_confirmations) == 0

    std = capsys.readouterr()
    combined_out = "\n".join([stream.getvalue(), caplog.text, std.out, std.err])
    assert_clean(caplog.records, combined_out)
    assert_no_chat_id(caplog, stream)
    for extra in (caption_sentinel, padded_b64, "Traceback", str(CHAT)):
        assert extra not in combined_out
        for record in caplog.records:
            assert extra not in record.getMessage()
            assert extra not in repr(record.args)
            assert record.exc_info is None
