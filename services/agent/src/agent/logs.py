"""Secret values never reach a log line.

Settings.load registers every secret it read (bot token, sheet key, model keys) and the provider
keys the SDKs read from the environment by themselves. install() wraps the LogRecord factory in
force (a library's own factory keeps working), so every record is cleaned when it is created,
before any handler sees it: the application's, the libraries' (LiteLLM writes through its own
handler) and handlers created later.

What is cleaned: the message; each argument, keeping the tuple or mapping and the plain values
(uvicorn's access formatter unpacks its argument tuple) - a string loses the secret, any other
object whose text holds one (an exception, a list, a dict) is replaced by a stand-in whose str()
and repr() are masked; the formatted traceback and stack. A last check on the final message
falls back to masking the rendered text. Secrets are at least 8 characters (Settings refuses
shorter ones), so masking does not hit ordinary words or %(name)s placeholders.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from typing import Any

MASK = "[segredo]"
MIN_SECRET_LEN = 8

_SECRETS: set[str] = set()


def register_secrets(values: Iterable[str | None]) -> None:
    _SECRETS.update(v.strip() for v in values if v and v.strip())


def _active() -> list[str]:
    return sorted((s for s in _SECRETS if len(s) >= MIN_SECRET_LEN), key=len, reverse=True)


def mask(text: str) -> str:
    for secret in _active():
        text = text.replace(secret, MASK)
    return text


def _holds(text: str, secrets: list[str]) -> bool:
    return any(s in text for s in secrets)


class _Masked:
    """Stands in for a log argument whose text holds a secret."""

    def __init__(self, value: Any) -> None:
        self._value = value

    def __str__(self) -> str:
        return mask(str(self._value))

    def __repr__(self) -> str:
        return mask(repr(self._value))


def _clean_value(value: Any, secrets: list[str]) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return mask(value) if _holds(value, secrets) else value
    try:
        text = f"{value!s}\n{value!r}"
    except Exception:
        return value
    return _Masked(value) if _holds(text, secrets) else value


def _clean(record: logging.LogRecord) -> logging.LogRecord:
    secrets = _active()
    if not secrets:
        return record
    record.msg = _clean_value(record.msg, secrets)
    if isinstance(record.args, tuple):
        record.args = tuple(_clean_value(a, secrets) for a in record.args)
    elif isinstance(record.args, Mapping):
        record.args = {k: _clean_value(v, secrets) for k, v in record.args.items()}
    if record.exc_info and not record.exc_text:
        record.exc_text = logging.Formatter().formatException(record.exc_info)
    if record.exc_text:
        record.exc_text = mask(record.exc_text)
    if record.stack_info:
        record.stack_info = mask(record.stack_info)
    try:
        rendered = record.getMessage()
    except Exception:
        return record
    if _holds(rendered, secrets):
        record.msg, record.args = mask(rendered), None
    return record


def install() -> None:
    """Wraps the LogRecord factory in force; a second call while it is still in force is a no-op."""
    current = logging.getLogRecordFactory()
    if getattr(current, "_masks_secrets", False):
        return

    def factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
        return _clean(current(*args, **kwargs))

    setattr(factory, "_masks_secrets", True)  # noqa: B010 - a marker on a plain function
    logging.setLogRecordFactory(factory)
