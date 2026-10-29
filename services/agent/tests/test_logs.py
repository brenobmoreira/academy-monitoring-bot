import io
import logging

import pytest

from agent import logs

pytestmark = pytest.mark.unit


def capture(name: str) -> tuple[logging.Logger, io.StringIO]:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(name)s %(message)s"))
    logger = logging.getLogger(name)
    logger.handlers = [handler]
    logger.propagate = False
    return logger, stream


def test_secrets_are_masked_in_messages_arguments_and_tracebacks(monkeypatch):
    monkeypatch.setattr(logs, "_SECRETS", set())
    logger, stream = capture("test.redaction.a")
    logs.register_secrets(["sk-sentinel-abc", "", None])
    logs.install()
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


def test_a_library_handler_added_before_the_secrets_is_covered(monkeypatch):
    monkeypatch.setattr(logs, "_SECRETS", set())
    logger, stream = capture("test.redaction.litellm")
    logs.install()
    logs.register_secrets(["AQ.sentinel-key"])
    logger.info("request with api_key=AQ.sentinel-key")
    assert "AQ.sentinel-key" not in stream.getvalue()
