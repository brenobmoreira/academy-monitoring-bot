"""Secret values never reach a log line.

Settings.load registers every secret it read (bot token, sheet key, model keys); install() puts a
filter on every handler that exists, the application's and the libraries' own (LiteLLM writes
through its own handler). The filter masks those values in the message, its arguments and the
formatted traceback, so an exception that quotes a key (a provider error, a URL) is safe to log.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable

MASK = "[segredo]"
# Shorter values ("k" in a test) would mask ordinary text; real keys and tokens are longer.
MIN_SECRET_LEN = 8

_SECRETS: set[str] = set()


def register_secrets(values: Iterable[str | None]) -> None:
    _SECRETS.update(v for v in values if v)


def mask(text: str) -> str:
    for secret in sorted((s for s in _SECRETS if len(s) >= MIN_SECRET_LEN), key=len, reverse=True):
        text = text.replace(secret, MASK)
    return text


class RedactSecrets(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if not any(len(s) >= MIN_SECRET_LEN for s in _SECRETS):
            return True
        record.msg = mask(record.getMessage())
        record.args = None
        if record.exc_info and not record.exc_text:
            record.exc_text = logging.Formatter().formatException(record.exc_info)
        if record.exc_text:
            record.exc_text = mask(record.exc_text)
        if record.stack_info:
            record.stack_info = mask(record.stack_info)
        return True


_FILTER = RedactSecrets()


def install() -> None:
    """Adds the filter to every handler of the root logger and of every logger created so far."""
    loggers = [logging.getLogger()] + [
        logger for logger in logging.root.manager.loggerDict.values() if isinstance(logger, logging.Logger)
    ]
    for logger in loggers:
        for handler in logger.handlers:
            if _FILTER not in handler.filters:
                handler.addFilter(_FILTER)
