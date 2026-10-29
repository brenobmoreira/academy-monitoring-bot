"""Secret values never reach a log line.

Settings.load registers every secret it read (bot token, sheet key, model keys) and the provider
keys the SDKs read from the environment by themselves. install() masks them in the text a
handler is about to write, after all formatting: logging.Handler.format (every handler, the
application's and the libraries' own - LiteLLM writes through its own - including handlers created
later and any formatter, uvicorn's included) and logging.Handler.handleError (a record whose
formatting fails is reported on stderr with its message and arguments).

Masking the final text, not the record, leaves the message, its arguments and the LogRecord
factory untouched: placeholders, numeric formats and other libraries' factories keep working,
and an argument whose text changes between calls is masked as written.
"""

from __future__ import annotations

import io
import logging
import sys
import traceback
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


_original_format = logging.Handler.format


def _format(self: logging.Handler, record: logging.LogRecord) -> str:
    return mask(_original_format(self, record))


def _handle_error(self: logging.Handler, record: logging.LogRecord) -> None:
    """logging.Handler.handleError, with the report masked: the stock one prints the record's
    message and arguments as they are."""
    if not (logging.raiseExceptions and sys.stderr):
        return
    report = io.StringIO()
    try:
        report.write("--- Logging error ---\n")
        traceback.print_exc(file=report)
        try:
            report.write(f"Message: {record.msg!r}\nArguments: {record.args!r}\n")
        except Exception:
            report.write("Unable to print the message and arguments - possible formatting error.\n")
        sys.stderr.write(mask(report.getvalue()))
    except Exception:
        pass


def install() -> None:
    """Idempotent: the handler methods are replaced once, recognised by identity."""
    if logging.Handler.format is not _format:
        logging.Handler.format = _format
    if logging.Handler.handleError is not _handle_error:
        logging.Handler.handleError = _handle_error
