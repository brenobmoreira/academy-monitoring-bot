"""Secret values never reach a log line.

Settings.load registers every secret it read (bot token, sheet key, model keys) and the provider
keys the SDKs read from the environment by themselves. install() replaces the LogRecord factory,
so every record is cleaned when it is created, before any handler sees it: the application's,
the libraries' own (LiteLLM writes through its own handler) and handlers created later. The
message, each string argument (types and structure are kept: uvicorn's access formatter unpacks
its argument tuple) and the formatted traceback lose every registered value.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from typing import Any

MASK = "[segredo]"
# Shorter values would mask ordinary text (a 1-letter test key); real keys and tokens are longer.
MIN_SECRET_LEN = 4

_SECRETS: set[str] = set()


def register_secrets(values: Iterable[str | None]) -> None:
    _SECRETS.update(v.strip() for v in values if v and v.strip())


def _active() -> list[str]:
    return sorted((s for s in _SECRETS if len(s) >= MIN_SECRET_LEN), key=len, reverse=True)


def mask(text: str) -> str:
    for secret in _active():
        text = text.replace(secret, MASK)
    return text


def _mask_value(value: Any, secrets: list[str]) -> Any:
    if isinstance(value, str) and any(s in value for s in secrets):
        return mask(value)
    return value


def _clean(record: logging.LogRecord) -> logging.LogRecord:
    secrets = _active()
    if not secrets:
        return record
    record.msg = _mask_value(record.msg, secrets)
    if isinstance(record.args, tuple):
        record.args = tuple(_mask_value(a, secrets) for a in record.args)
    elif isinstance(record.args, dict):
        record.args = {k: _mask_value(v, secrets) for k, v in record.args.items()}
    if record.exc_info and not record.exc_text:
        record.exc_text = logging.Formatter().formatException(record.exc_info)
    if record.exc_text:
        record.exc_text = mask(record.exc_text)
    if record.stack_info:
        record.stack_info = mask(record.stack_info)
    return record


_base_factory = logging.getLogRecordFactory()


def _factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
    return _clean(_base_factory(*args, **kwargs))


def install() -> None:
    """Every LogRecord created from now on is cleaned (idempotent)."""
    if logging.getLogRecordFactory() is not _factory:
        logging.setLogRecordFactory(_factory)
