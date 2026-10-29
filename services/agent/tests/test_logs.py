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


def test_short_secrets_are_masked_too():
    logs.register_secrets(["ab12cd"])
    logger, stream = capture("test.redaction.short")
    logger.info("sheet key ab12cd")
    assert "ab12cd" not in stream.getvalue()
