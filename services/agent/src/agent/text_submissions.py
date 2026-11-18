"""Idempotency and duplicate-delivery store for Mini App voice text submissions (spec §4.2).

A Mini App `t: "text"` payload runs the agent rather than a single sheet action, so the sheet's
`requestId` alone cannot deduplicate the whole turn (an agent turn may make zero, one, or two
tool writes, or be answered without touching the sheet). `TextSubmissions` tracks each
`(principal_key, "text", submission_id)` in memory using only the SHA-256 hex digest of the
submitted text — the raw text is never stored anywhere in memory.
"""

from __future__ import annotations

import asyncio
import hashlib
import math
import threading
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from agent.commands import Reply
from agent.sheet_client import WriteOutcome

TEXT_SUBMISSION_TTL_S: float = 48 * 3600
TEXT_SUBMISSION_CAPACITY: int = 1024

CONFLICT_REPLY = "⚠ Não gravei nada: este envio já foi usado com outro texto. Grave de novo no app."
RUNNING_REPLY = "Já estou registrando este envio."
DONE_REPLY = "Esse envio já foi registrado. Confira com /hoje."
UNCERTAIN_REPLY = "Esse envio pode ter sido gravado. Confira com /hoje antes de repetir."

SubmissionState = Literal["running", "done", "uncertain"]
DecisionReason = Literal["accepted", "conflict", "running", "done", "uncertain"]
Clock = Callable[[], float | datetime]
_StoreKey = tuple[str, Literal["text"], str]


def _to_seconds(value: float | datetime) -> float:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC).timestamp()
        return value.timestamp()
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"clock must return a finite number or datetime, got {type(value).__name__}")
    return float(value)


def principal_key(principal: int | str) -> str:
    """Canonical `<provider>:<subject>` key (`telegram:<chat_id>` when given a Telegram chat id)."""
    if type(principal) is int:
        return f"telegram:{principal}"
    if isinstance(principal, str):
        if not principal.strip():
            raise ValueError("principal_key must not be empty")
        return principal
    raise TypeError("principal must be a chat_id int or principal_key str")


def text_scope_key(chat_id: int, submission_id: str) -> str:
    """Scope root for `tools.update_key_scope` on a Mini App text turn (spec §4.2)."""
    if type(chat_id) is not int:
        raise TypeError("chat_id must be an int")
    if not isinstance(submission_id, str) or not submission_id:
        raise ValueError("submission_id must be a non-empty str")
    return f"tg:{chat_id}:miniapp:text:{submission_id}"


def text_digest(text: str) -> str:
    """Hex SHA-256 of the UTF-8 text; the store keeps this digest and never the text itself."""
    if not isinstance(text, str):
        raise TypeError("text must be a str")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class _Entry:
    __slots__ = ("text_sha256", "state", "at")

    text_sha256: str
    state: SubmissionState
    at: float


@dataclass(frozen=True)
class SubmissionDecision:
    """Outcome of `TextSubmissions.begin`: `bool(decision)` is True only when the caller should run."""

    proceed: bool
    reply: Reply | None
    reason: DecisionReason

    def __bool__(self) -> bool:
        return self.proceed


class TextSubmissions:
    """Bounded, thread-safe in-memory store of Mini App `t: "text"` submissions (spec §4.2)."""

    def __init__(
        self,
        max_size: int = TEXT_SUBMISSION_CAPACITY,
        ttl_s: float = TEXT_SUBMISSION_TTL_S,
        clock: Clock = time.monotonic,
    ) -> None:
        if type(max_size) is not int or max_size < 1:
            raise ValueError(f"max_size must be an int >= 1, got {max_size!r}")
        if isinstance(ttl_s, bool) or not isinstance(ttl_s, (int, float)) or ttl_s <= 0:
            raise ValueError(f"ttl_s must be > 0, got {ttl_s!r}")
        self._max = max_size
        self._ttl = float(ttl_s)
        self._clock = clock
        self._last_now: float | None = None
        self._items: OrderedDict[_StoreKey, _Entry] = OrderedDict()
        self._lock = threading.Lock()

    def begin(self, principal: int | str, submission_id: str, text: str) -> SubmissionDecision:
        """Claims `(principal, "text", submission_id)` for an agent run, or returns the fixed reply."""
        if not isinstance(submission_id, str) or not submission_id:
            raise ValueError("submission_id must be a non-empty str")
        key: _StoreKey = (principal_key(principal), "text", submission_id)
        digest = text_digest(text)
        with self._lock:
            now = self._now()
            self._purge(now)
            existing = self._items.get(key)
            if existing is not None:
                if existing.text_sha256 != digest:
                    return SubmissionDecision(False, Reply(CONFLICT_REPLY, failed=True), "conflict")
                if existing.state == "running":
                    return SubmissionDecision(False, Reply(RUNNING_REPLY), "running")
                if existing.state == "done":
                    return SubmissionDecision(False, Reply(DONE_REPLY), "done")
                return SubmissionDecision(False, Reply(UNCERTAIN_REPLY), "uncertain")
            self._items[key] = _Entry(text_sha256=digest, state="running", at=now)
            self._evict(protect=key)
            return SubmissionDecision(True, None, "accepted")

    def finish(
        self,
        principal: int | str,
        submission_id: str,
        *,
        outcome: WriteOutcome | None = None,
        failed: bool = False,
        transient: bool = False,
        cut: bool = False,
    ) -> None:
        """Records the terminal outcome of an in-flight submission (or drops it on `not_committed`)."""
        key: _StoreKey = (principal_key(principal), "text", submission_id)
        with self._lock:
            now = self._now()
            self._purge(now)
            existing = self._items.get(key)
            if existing is None:
                return
            next_state: SubmissionState | None
            if cut or outcome == "uncertain":
                next_state = "uncertain"
            elif outcome == "committed":
                next_state = "done"
            elif outcome == "not_committed" or failed or transient:
                next_state = None
            else:
                next_state = "done"
            if next_state is None:
                del self._items[key]
                return
            self._items[key] = _Entry(text_sha256=existing.text_sha256, state=next_state, at=now)
            self._items.move_to_end(key)
            self._evict(protect=key)

    async def run(
        self,
        principal: int | str,
        submission_id: str,
        text: str,
        work: Callable[[], Awaitable[Reply]],
    ) -> Reply:
        """Runs `work` at most once per `(principal, submission_id)`, updating the store afterwards."""
        decision = self.begin(principal, submission_id, text)
        if not decision.proceed:
            assert decision.reply is not None
            return decision.reply
        try:
            reply = await work()
        except (TimeoutError, asyncio.CancelledError):
            self.finish(principal, submission_id, cut=True)
            raise
        except BaseException:
            self.finish(principal, submission_id, outcome="not_committed")
            raise
        self.finish(
            principal,
            submission_id,
            outcome=reply.write_outcome,
            failed=reply.failed,
            transient=reply.transient,
        )
        return reply

    def __len__(self) -> int:
        with self._lock:
            self._purge(self._now())
            return len(self._items)

    def _now(self) -> float:
        raw = _to_seconds(self._clock())
        now = raw if self._last_now is None else max(raw, self._last_now)
        self._last_now = now
        return now

    def _purge(self, now: float) -> None:
        expired = [
            key
            for key, entry in self._items.items()
            if entry.state != "running" and now - entry.at >= self._ttl
        ]
        for key in expired:
            del self._items[key]

    def _evict(self, *, protect: _StoreKey | None = None) -> None:
        if len(self._items) <= self._max:
            return
        victims: list[_StoreKey] = []
        needed = len(self._items) - self._max
        for key, entry in self._items.items():
            if key == protect or entry.state == "running":
                continue
            victims.append(key)
            if len(victims) >= needed:
                break
        for key in victims:
            del self._items[key]
