import functools
import io
import logging

import pytest
from uvicorn.logging import AccessFormatter

from agent import logs

pytestmark = pytest.mark.unit

SECRET = "sk-sentinel-deep"


def capture(name: str, formatter: logging.Formatter | None = None) -> tuple[logging.Logger, io.StringIO]:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(formatter or logging.Formatter("%(name)s %(message)s"))
    logger = logging.getLogger(name)
    logger.handlers = [handler]
    logger.propagate = False
    logger.setLevel(logging.INFO)
    return logger, stream


@pytest.fixture(autouse=True)
def secrets(monkeypatch):
    monkeypatch.setattr(logs, "_SECRETS", set())
    logs.install()


def test_secrets_are_masked_in_messages_arguments_and_tracebacks():
    logger, stream = capture("test.redaction.a")
    logs.register_secrets([SECRET, "", None])
    logger.warning("key %s in args", SECRET)
    try:
        raise RuntimeError(f"provider said: bad key {SECRET}")
    except RuntimeError:
        logger.exception("call failed for %r", "peso 82,4")
    out = stream.getvalue()
    assert SECRET not in out
    assert out.count(logs.MASK) == 2  # the argument and the exception message in the traceback
    assert "call failed for 'peso 82,4'" in out and "RuntimeError" in out


def test_a_handler_created_after_install_is_covered():
    logs.register_secrets(["AQ.sentinel-key"])
    logger, stream = capture("test.redaction.later")
    logger.info("request with api_key=AQ.sentinel-key")
    assert stream.getvalue().strip() == f"test.redaction.later request with api_key={logs.MASK}"


def test_uvicorn_access_lines_keep_their_arguments_and_lose_the_secret():
    logs.register_secrets(["tok-in-a-url-123"])
    logger, stream = capture("test.redaction.access", AccessFormatter("%(request_line)s %(status_code)s"))
    logger.info('%s - "%s %s HTTP/%s" %d', "127.0.0.1:5000", "POST", "/hook/tok-in-a-url-123", "1.1", 200)
    assert stream.getvalue().strip() == f"POST /hook/{logs.MASK} HTTP/1.1 200 OK"


@pytest.mark.parametrize(
    ("message", "args"),
    [
        ("erro: %s", (RuntimeError(f"bad key {SECRET}"),)),
        ("erro: %r", (RuntimeError(f"bad key {SECRET}"),)),
        ("lista: %s", ([1, {"key": SECRET}],)),
        ("dict: %(payload)s", {"payload": {"nested": [SECRET]}}),
    ],
)
def test_secrets_inside_objects_passed_as_arguments_are_masked(message, args):
    logs.register_secrets([SECRET])
    logger, stream = capture("test.redaction.objects")
    if isinstance(args, tuple):
        logger.info(message, *args)
    else:
        logger.info(message, args)
    assert SECRET not in stream.getvalue()
    assert logs.MASK in stream.getvalue()


def test_a_message_that_is_not_a_string_is_masked():
    logs.register_secrets([SECRET])
    logger, stream = capture("test.redaction.dictmsg")
    logger.info({"api_key": SECRET})
    assert SECRET not in stream.getvalue() and logs.MASK in stream.getvalue()


def test_a_secret_named_like_a_placeholder_does_not_break_the_line():
    logs.register_secrets(["password1"])
    logger, stream = capture("test.redaction.placeholder")
    logger.info("login with %(password1)s", {"password1": "hunter2-not-secret"})
    assert stream.getvalue().strip() == "test.redaction.placeholder login with hunter2-not-secret"


class Amount:
    def __init__(self) -> None:
        self.calls = 0

    def __int__(self) -> int:
        return 42

    def __float__(self) -> float:
        return 4.2

    def __str__(self) -> str:
        return f"amount for {SECRET}"


def test_numeric_formats_of_an_object_holding_a_secret_still_work():
    logs.register_secrets([SECRET])
    logger, stream = capture("test.redaction.numbers")
    logger.info("n=%d f=%.2f s=%s", Amount(), Amount(), Amount())
    assert stream.getvalue().strip() == f"test.redaction.numbers n=42 f=4.20 s=amount for {logs.MASK}"


class Exploding:
    def __str__(self) -> str:
        raise ValueError("no text")

    def __repr__(self) -> str:
        return f"Exploding({SECRET})"


def test_a_formatting_error_does_not_print_the_secret_on_stderr(capsys):
    logs.register_secrets([SECRET])
    logger, stream = capture("test.redaction.exploding")
    logger.info("value %s", Exploding())
    err = capsys.readouterr().err
    assert "Logging error" in err
    assert SECRET not in err and SECRET not in stream.getvalue()


def test_the_formatting_error_report_keeps_the_call_stack_and_masks_it(capsys):
    logs.register_secrets([SECRET])
    logger, _ = capture("test.redaction.stack")
    logger.info("value %s", Exploding())
    err = capsys.readouterr().err
    assert "ValueError: no text" in err
    assert "Call stack:" in err and "test_the_formatting_error_report_keeps_the_call_stack" in err
    assert f"Exploding({logs.MASK})" in err and SECRET not in err


def test_the_report_is_silent_when_logging_exceptions_are_off(capsys, monkeypatch):
    monkeypatch.setattr(logging, "raiseExceptions", False)
    logger, _ = capture("test.redaction.silent")
    logger.info("value %s", Exploding())
    assert capsys.readouterr().err == ""


class Shifting:
    """Clean for the first `clean` conversions to text, then carries the secret."""

    def __init__(self, clean: int) -> None:
        self.clean = clean
        self.calls = 0

    def __str__(self) -> str:
        self.calls += 1
        return "clean" if self.calls <= self.clean else f"now {SECRET}"


@pytest.mark.parametrize("clean", [0, 1, 2, 3])
def test_an_argument_whose_text_changes_between_calls_is_masked(clean):
    """Whichever conversion ends up in the line, the line is the masked text of that conversion
    (the per-argument masking leaked when the third conversion was the first with the secret)."""
    logs.register_secrets([SECRET])
    logger, stream = capture("test.redaction.shifting")
    logger.info("value %s", Shifting(clean))
    line = stream.getvalue().strip()
    assert line in {"test.redaction.shifting value clean", f"test.redaction.shifting value now {logs.MASK}"}
    if clean == 0:
        assert line.endswith(logs.MASK)


def test_a_wrapped_record_factory_that_adds_a_secret_is_still_masked():
    original = logging.getLogRecordFactory()

    @functools.wraps(original)
    def adding(*args, **kwargs):
        record = original(*args, **kwargs)
        record.msg = f"{record.msg} {SECRET}"
        return record

    try:
        logging.setLogRecordFactory(adding)
        logs.install()
        logs.register_secrets([SECRET])
        logger, stream = capture("test.redaction.wraps")
        logger.info("hello")
        assert stream.getvalue().strip() == f"test.redaction.wraps hello {logs.MASK}"
    finally:
        logging.setLogRecordFactory(original)


def test_install_twice_masks_once():
    logs.install()
    logs.register_secrets([SECRET])
    logger, stream = capture("test.redaction.twice")
    logger.info("key %s", SECRET)
    assert stream.getvalue().strip() == f"test.redaction.twice key {logs.MASK}"


class BrokenStderr:
    def __init__(self, error):
        self.error = error

    def write(self, text):
        raise self.error


def test_a_report_that_cannot_be_written_is_dropped(monkeypatch):
    monkeypatch.setattr("sys.stderr", BrokenStderr(OSError("closed pipe")))
    logger, _ = capture("test.redaction.broken")
    logger.info("value %s", Exploding())  # must not raise


def test_an_unexpected_error_writing_the_report_is_not_hidden(monkeypatch):
    monkeypatch.setattr("sys.stderr", BrokenStderr(ValueError("bad stream")))
    logger, _ = capture("test.redaction.unexpected")
    with pytest.raises(ValueError, match="bad stream"):
        logger.info("value %s", Exploding())
