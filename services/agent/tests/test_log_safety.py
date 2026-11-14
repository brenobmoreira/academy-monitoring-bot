"""No client content in logs: describe(), the guard on library loggers, and the agent paths that log
exceptions (voice input design §10, task C4a).

Sentinels stand for content: a transcript or typed text and audio bytes (raw and base64). Each test
provokes a failure that carries them in every place an exception or a record can hold text (message,
args, chained cause, attributes, traceback) and checks the records and the formatted output.
"""

import asyncio
import base64
import io
import logging
from collections.abc import AsyncGenerator, Iterator
from datetime import datetime
from zoneinfo import ZoneInfo

import litellm
import pytest
from google.adk.models import LlmRequest, LlmResponse

from agent import logs
from agent.bot import MEDIA_UNREADABLE, MODEL_FAILED_NOTHING_WRITTEN, SHEET_FAILED, Bot, Media
from agent.handler import DOWNLOAD_FAILED, FAILURE, Handler

from .fakes import FakeSheet, ScriptedLlm, call, say
from .test_handler import FakeBot, FakeTelegram, update, voice_update

pytestmark = pytest.mark.unit

TEXT_SENTINEL = "SENTINELA-TEXTO-91c2"
AUDIO_SENTINEL = b"SENTINEL-AUDIO-7f3a"
AUDIO_B64 = base64.b64encode(AUDIO_SENTINEL).decode()
SENTINELS = (TEXT_SENTINEL, AUDIO_SENTINEL.decode(), AUDIO_B64)
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
    sheet = FakeSheet(diary_upsert=[down])
    script = [
        call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}),
        say("A planilha não respondeu."),
    ]
    answer = await bot(sheet, script).reply(TEXT_SENTINEL)
    assert answer.text == SHEET_FAILED
    assert_clean(caplog.records, stream.getvalue())
    assert "sheet unavailable: unavailable, other" in caplog.text


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
    assert "could not send the reply to chat 42" in caplog.text
