import io
import logging

import pytest
from uvicorn.logging import AccessFormatter

from agent import logs

pytestmark = pytest.mark.unit


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
    logs.register_secrets(["sk-sentinel-abc", "", None])
    logger.warning("key %s in args", "sk-sentinel-abc")
    try:
        raise RuntimeError("provider said: bad key sk-sentinel-abc")
    except RuntimeError:
        logger.exception("call failed for %r", "peso 82,4")
    out = stream.getvalue()
    assert "sk-sentinel-abc" not in out
    # The argument, the exception message and the traceback's source line.
    assert out.count(logs.MASK) == 3
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


SECRET = "sk-sentinel-deep"


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


def test_the_template_is_not_touched_so_placeholders_keep_working():
    logs.register_secrets(["payload-secret"])
    logger, stream = capture("test.redaction.template")
    logger.info("value %(payload)s and payload-secret", {"payload": "ok"})
    assert stream.getvalue().strip() == f"test.redaction.template value ok and {logs.MASK}"


def test_install_keeps_a_factory_set_before_and_survives_a_reinstall():
    seen = []
    original = logging.getLogRecordFactory()

    def tagging(*args, **kwargs):
        record = original(*args, **kwargs)
        record.tag = "set-by-library"
        seen.append(record)
        return record

    try:
        logging.setLogRecordFactory(tagging)
        logs.install()
        logs.install()
        logs.register_secrets([SECRET])
        logger, stream = capture("test.redaction.chain")
        logger.info("key %s", SECRET)
        assert seen and seen[-1].tag == "set-by-library"
        assert SECRET not in stream.getvalue()
    finally:
        logging.setLogRecordFactory(original)
