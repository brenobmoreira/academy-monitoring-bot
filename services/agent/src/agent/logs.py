"""Secret values never reach a log line.

Settings.load registers every secret it read (bot token, sheet key, model keys) and the provider
keys the SDKs read from the environment by themselves. install() masks them in the text a
handler is about to write, after all formatting: logging.Handler.format (every handler, the
application's and the libraries' own - LiteLLM writes through its own - including handlers created
later and any formatter, uvicorn's included). logging.Handler.handleError (a record whose
formatting fails) reports on stderr the class of the formatting error and where the record was
logged, and nothing else: the stock report prints the record's message and arguments, the
traceback of the formatting error and, through its `__context__`, the exception that was being
logged, message included.

Masking the final text, not the record, leaves the message, its arguments and the LogRecord
factory untouched: placeholders, numeric formats and other libraries' factories keep working,
and an argument whose text changes between calls is masked as written.

Covered: what this service logs through, a StreamHandler to the terminal and Cloud Logging
(stdout/stderr). Not covered, so not to be added without masking of its own: handlers that
serialise the record instead of its formatted text (logging.handlers.SocketHandler, HTTPHandler,
QueueHandler, OpenTelemetry), a handler whose format() skips Handler.format, a formatter that
escapes the text (JSON) before the mask sees it, and writes that bypass logging, such as
LiteLLM's verbose mode (litellm.set_verbose / LITELLM_LOG=DEBUG): leave it off.

Client content (audio, transcripts, captions, typed text, credentials) is kept out by two more rules,
from the voice input design (docs/specs/2026-11-14-voice-input-design.md, §10):

- Code that handles content logs an exception only through describe(): its class, an HTTP status and
  a code from a closed list, never its message, arguments, other attributes or traceback (provider
  and SDK errors can echo the request).
- install() also rewrites the records of libraries that can log requests (GUARDED_LOGGERS) before
  any formatter runs: level and logger stay, message, arguments and traceback go.

Chat ids are not logged either: a line names the Telegram `update_id`, or ref() of the chat when
there is no update (the reminders).
"""

from __future__ import annotations

import contextlib
import hashlib
import logging
import re
import secrets
import sys
from collections.abc import Iterable

MASK = "[segredo]"
# Settings refuses shorter secrets, so masking cannot hit ordinary words.
MIN_SECRET_LEN = 8

_SECRETS: set[str] = set()


def register_secrets(values: Iterable[str | None]) -> None:
    _SECRETS.update(v.strip() for v in values if v and v.strip())


def mask(text: str) -> str:
    for secret in sorted((s for s in _SECRETS if len(s) >= MIN_SECRET_LEN), key=len, reverse=True):
        text = text.replace(secret, MASK)
    return text


# Codes describe() may print: the sheet API's, the bot's and the voice service's. Any other value of
# an exception's `code` is printed as "other". Extend only by editing this set.
DIAGNOSTIC_CODES = frozenset(
    {
        # sheet API and sheet client
        "unavailable",
        "internal",
        "write_uncertain",
        "conflict",
        "date_in_future",
        "duplicate",
        "empty",
        "incomplete_food",
        "invalid",
        "invalid_date",
        "invalid_json",
        "invalid_range",
        "invalid_unit",
        "not_in_catalog",
        "not_found",
        "out_of_range",
        "rejected",
        "required",
        "unauthorized",
        "unknown_field",
        "unknown_op",
        "wrong_type",
        "already_undone",
        "nothing_to_undo",
        "not_latest",
        # model calls and the voice service
        "timeout",
        "failed",
        "rate_limited",
        "budget_exhausted",
        "bad_request",
        "unauthenticated",
        "auth_expired",
        "credential_used",
        "forbidden",
        "unsupported_format",
        "too_long",
        "too_large",
        "no_speech",
        "disabled",
        "transcription_failed",
        "idempotency_conflict",
        "context_window_exceeded",
        "content_filtered",
    }
)
# Loggers of libraries that can write a model or HTTP request into a record (see _guard).
GUARDED_LOGGERS = ("LiteLLM", "litellm", "google_adk", "google.adk", "google_genai", "httpcore")
_CLASS_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]{0,100}$")
# A logger, level or file name in the report of a formatting error: names written in code.
_PLAIN_NAME = re.compile(r"^[A-Za-z0-9_.\- ]{1,100}$")
_REF_SALT = secrets.token_bytes(16)  # per process: a ref cannot be compared across restarts
_MAX_LINKS = 5
_MISSING = object()


def safe_code(value: object) -> str:
    """`value` when it is an HTTP status (int 100-599) or a member of DIAGNOSTIC_CODES, else "other"."""
    if isinstance(value, int) and not isinstance(value, bool) and 100 <= value <= 599:
        return str(value)
    if isinstance(value, str) and value in DIAGNOSTIC_CODES:
        return value
    return "other"


def _attr(err: BaseException, name: str) -> object:
    """An attribute without running anything that could fail loudly (properties may raise)."""
    try:
        return getattr(err, name, _MISSING)
    except Exception:
        return _MISSING


def _status(value: object) -> str:
    if isinstance(value, int) and not isinstance(value, bool) and 100 <= value <= 599:
        return str(value)
    return "other"


def ref(value: int | str) -> str:
    """An opaque reference to an identifier that must not be logged (a chat id): 8 hex digits of a
    hash keyed with a salt drawn when the process starts. The same value gives the same ref within
    one process, so lines can be correlated; it cannot be reversed or matched to another process."""
    return hashlib.blake2s(str(value).encode(), key=_REF_SALT, digest_size=4).hexdigest()


def _class_name(err: BaseException) -> str:
    cls = type(err)
    module = getattr(cls, "__module__", "") or ""
    qualname = getattr(cls, "__qualname__", "") or ""
    name = qualname if module == "builtins" else f"{module}.{qualname}"
    if not isinstance(name, str) or not _CLASS_NAME.match(name):
        return "Exception"
    return name


def _link(err: BaseException) -> str:
    name = _class_name(err)
    parts = []
    status = _attr(err, "status_code")
    if status is _MISSING or status is None:
        status = _attr(err, "status")
    if status is not _MISSING and status is not None:
        parts.append(f"status={_status(status)}")
    code = _attr(err, "code")
    if code is not _MISSING and code is not None:
        parts.append(f"code={safe_code(code)}")
    return f"{name}[{' '.join(parts)}]" if parts else name


def describe(err: BaseException) -> str:
    """'ClassName[status=503 code=unavailable] <- CauseClass', at most five links of the chain
    (`__cause__`, else `__context__`), stopping on a repeat. Never reads the message, the
    arguments, any other attribute or the traceback: what an exception says can carry the
    request it failed on."""
    links: list[str] = []
    seen: set[int] = set()
    current: BaseException | None = err
    while current is not None and len(links) < _MAX_LINKS and id(current) not in seen:
        seen.add(id(current))
        links.append(_link(current))
        current = current.__cause__ if current.__cause__ is not None else current.__context__
    return " <- ".join(links)


def _guard(record: logging.LogRecord) -> None:
    """Rewrites, in place and once, a record of a GUARDED_LOGGERS library: its message, arguments,
    traceback and stack go, its logger and level stay, its exception is kept as describe()."""
    if getattr(record, "_content_guarded", False) or not record.name.startswith(GUARDED_LOGGERS):
        return
    exc = record.exc_info[1] if isinstance(record.exc_info, tuple) else None
    message = f"{record.name} {record.levelname} record (content omitted)"
    if isinstance(exc, BaseException):
        message += f": {describe(exc)}"
    record.msg = message
    record.args = ()
    record.exc_info = None
    record.exc_text = None
    record.stack_info = None
    record._content_guarded = True  # type: ignore[attr-defined]


_original_format = logging.Handler.format


def _format(self: logging.Handler, record: logging.LogRecord) -> str:
    _guard(record)
    return mask(_original_format(self, record))


def _plain(value: object) -> str:
    return value if isinstance(value, str) and _PLAIN_NAME.match(value) else "?"


def _handle_error(self: logging.Handler, record: logging.LogRecord) -> None:
    """Replaces logging.Handler.handleError (silent when logging.raiseExceptions is off or there is
    no stderr). The report is the class of the formatting error, a fixed sentence and where the
    record was logged. Never the error's message, its traceback or chain (its `__context__` is the
    exception that was being logged), the call stack, or the record's message and arguments."""
    if not (logging.raiseExceptions and sys.stderr):
        return
    error = sys.exc_info()[1]
    kind = _class_name(error) if error is not None else "an unknown error"
    line = record.lineno if isinstance(record.lineno, int) else 0
    report = (
        "--- Logging error ---\n"
        f"{kind} while writing a log record; its message, arguments, traceback and call stack "
        "are omitted (they can carry content).\n"
        f"Logged from file {_plain(record.filename)}, line {line}, "
        f"logger {_plain(record.name)}, level {_plain(record.levelname)}\n"
    )
    with contextlib.suppress(OSError):
        sys.stderr.write(mask(report))


def install() -> None:
    """Idempotent: the handler methods are replaced once, recognised by identity."""
    if logging.Handler.format is not _format:
        logging.Handler.format = _format
    if logging.Handler.handleError is not _handle_error:
        logging.Handler.handleError = _handle_error
