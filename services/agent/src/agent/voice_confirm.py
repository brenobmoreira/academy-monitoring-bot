"""In-memory confirmation lifecycle for chat voice notes (§4.1).

Nothing sensitive lives here: the transcript stays in Telegram's own `🎙️ Entendi:` message and
only its SHA-256 hex digest is kept alongside `(chat_id, message_id, created_at, state)` so a tap
can prove the text was not altered and cannot run twice. Restart or eviction loses the entry and
therefore fails closed (`Expirou…`).
"""

from __future__ import annotations

import hashlib
import re
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

VOICE_CONFIRM_TTL_S = 30 * 60.0
VOICE_TERMINAL_TTL_S = 24 * 3600.0
VOICE_CONFIRM_MAX = 512

VoiceState = Literal[
    "pending",
    "confirmed",
    "done",
    "uncertain",
    "cancelled",
    "superseded",
    "expired",
]
VoiceAction = Literal["vok", "vfix", "vno"]
TerminalOutcome = Literal["done", "uncertain"]
ClaimRefusal = Literal["unknown", "wrong_chat", "expired"]

TERMINAL_STATES: frozenset[VoiceState] = frozenset(
    {"done", "uncertain", "cancelled", "superseded", "expired"}
)
_ACTION_STATE: dict[VoiceAction, VoiceState] = {
    "vok": "confirmed",
    "vfix": "superseded",
    "vno": "cancelled",
}

VOICE_REGISTERING = "Registrando…"
VOICE_ALREADY_REGISTERING = "Já estou registrando."
VOICE_ALREADY_SENT = "Já enviado. Confira com /hoje."
VOICE_CANCELLED = "Você cancelou este áudio."
VOICE_SUPERSEDED = "Substituído pela correção."
VOICE_EXPIRED = "Expirou. Envie o áudio de novo ou digite."
VOICE_FIX_ALREADY = "Já pedi a correção."
VOICE_CANCEL_OK = "Ok, não registrei nada."
VOICE_CANCEL_REGISTERING = "Já estou registrando; para desfazer use ↩️ na confirmação."
VOICE_CANCEL_SENT = "Já enviado; para desfazer use ↩️ na confirmação."
VOICE_ALREADY_CANCELLED = "Já cancelado."

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

Clock = Callable[[], float | datetime]


def sha256_hex(text: str) -> str:
    """Lowercase hex SHA-256 of the UTF-8 text shown after `🎙️ Entendi:\\n\\n`."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def new_vid() -> str:
    """16 lowercase hex characters (64 random bits), fresh per `Entendi` message."""
    return secrets.token_hex(8)


def _timestamp(value: float | datetime) -> float:
    return value.timestamp() if isinstance(value, datetime) else float(value)


@dataclass(slots=True)
class ConfirmationEntry:
    """Metadata kept per `vid` (§4.1): never the transcript or audio."""

    chat_id: int
    message_id: int | None
    created_at: float
    state: VoiceState
    text_sha256: str


def _snapshot(entry: ConfirmationEntry) -> ConfirmationEntry:
    return ConfirmationEntry(
        chat_id=entry.chat_id,
        message_id=entry.message_id,
        created_at=entry.created_at,
        state=entry.state,
        text_sha256=entry.text_sha256,
    )


@dataclass(frozen=True, slots=True)
class ClaimResult:
    """Outcome of an atomic `VoiceConfirmations.claim` attempt."""

    ok: bool
    state: VoiceState | None
    refusal: ClaimRefusal | None = None
    entry: ConfirmationEntry | None = None


def voice_toast(action: VoiceAction, claim: ClaimResult) -> str | None:
    """Callback answer toast from the §4.1 response table (`None` when answered silently)."""
    if claim.ok:
        return VOICE_REGISTERING if action == "vok" else None
    state = claim.state
    if claim.refusal is not None or state is None or state == "expired":
        return VOICE_EXPIRED
    if state == "confirmed":
        return VOICE_CANCEL_REGISTERING if action == "vno" else VOICE_ALREADY_REGISTERING
    if state in ("done", "uncertain"):
        return VOICE_CANCEL_SENT if action == "vno" else VOICE_ALREADY_SENT
    if state == "cancelled":
        return VOICE_ALREADY_CANCELLED if action == "vno" else VOICE_CANCELLED
    if state == "superseded":
        return VOICE_FIX_ALREADY if action == "vfix" else VOICE_SUPERSEDED
    return VOICE_EXPIRED


class VoiceConfirmations:
    """Thread-safe, bounded, in-memory store for `🎙️ Entendi:` confirmations (§4.1)."""

    def __init__(
        self,
        *,
        max_size: int = VOICE_CONFIRM_MAX,
        ttl_s: float = VOICE_CONFIRM_TTL_S,
        terminal_ttl_s: float = VOICE_TERMINAL_TTL_S,
        clock: Clock = time.monotonic,
    ) -> None:
        if max_size < 1:
            raise ValueError("max_size must be at least 1")
        self._max_size = max_size
        self._ttl_s = ttl_s
        self._terminal_ttl_s = terminal_ttl_s
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: OrderedDict[str, ConfirmationEntry] = OrderedDict()
        self._terminal_at: OrderedDict[str, float] = OrderedDict()

    def _now(self, now: float | datetime | None) -> float:
        return _timestamp(self._clock() if now is None else now)

    def _mark_terminal(self, vid: str, entry: ConfirmationEntry, state: VoiceState, ts: float) -> None:
        entry.state = state
        self._terminal_at.pop(vid, None)
        self._terminal_at[vid] = ts

    def _drop(self, vid: str) -> None:
        self._entries.pop(vid, None)
        self._terminal_at.pop(vid, None)

    def _prune(self, ts: float) -> None:
        for vid in [k for k, at in self._terminal_at.items() if ts - at > self._terminal_ttl_s]:
            self._drop(vid)

    def _evict_if_needed(self, ts: float) -> None:
        # Expire stale pending entries before choosing a victim so live pending ones stay longer.
        for vid, entry in self._entries.items():
            if entry.state == "pending" and ts - entry.created_at > self._ttl_s:
                self._mark_terminal(vid, entry, "expired", entry.created_at + self._ttl_s)
        self._prune(ts)
        while len(self._entries) >= self._max_size:
            if self._terminal_at:
                oldest_terminal = next(iter(self._terminal_at))
                self._drop(oldest_terminal)
                continue
            oldest_pending = next(
                (vid for vid, entry in self._entries.items() if entry.state == "pending"),
                None,
            )
            if oldest_pending is not None:
                self._drop(oldest_pending)
                continue
            # Only in-flight `confirmed` entries remain; never evict them.
            break

    def create(
        self,
        chat_id: int,
        text_sha256: str,
        *,
        message_id: int | None = None,
        now: float | datetime | None = None,
    ) -> str:
        """Creates a `pending` entry and returns its fresh 16-hex `vid`."""
        if not isinstance(text_sha256, str) or not _SHA256_RE.match(text_sha256):
            raise ValueError("text_sha256 must be 64 lowercase hex characters")
        with self._lock:
            ts = self._now(now)
            self._prune(ts)
            if len(self._entries) >= self._max_size:
                self._evict_if_needed(ts)
            vid = new_vid()
            while vid in self._entries:
                vid = new_vid()
            self._entries[vid] = ConfirmationEntry(
                chat_id=chat_id,
                message_id=message_id,
                created_at=ts,
                state="pending",
                text_sha256=text_sha256,
            )
            return vid

    def set_message_id(self, vid: str, message_id: int) -> None:
        """Records the Telegram `message_id` once `Entendi` has been sent."""
        with self._lock:
            entry = self._entries.get(vid)
            if entry is not None:
                entry.message_id = message_id

    def discard(self, vid: str) -> None:
        """Removes `vid` completely (e.g. if sending `Entendi` failed)."""
        with self._lock:
            self._drop(vid)

    def claim(
        self,
        vid: str,
        chat_id: int | None,
        action: VoiceAction,
        now: float | datetime | None = None,
    ) -> ClaimResult:
        """Atomically claims a `pending` entry for `action`, or explains why it cannot run."""
        if action not in _ACTION_STATE:
            raise ValueError(f"unknown voice action: {action!r}")
        with self._lock:
            ts = self._now(now)
            self._prune(ts)
            entry = self._entries.get(vid)
            if entry is None:
                return ClaimResult(ok=False, state=None, refusal="unknown")
            if chat_id is None or entry.chat_id != chat_id:
                return ClaimResult(ok=False, state=None, refusal="wrong_chat")
            if entry.state == "pending" and ts - entry.created_at > self._ttl_s:
                self._mark_terminal(vid, entry, "expired", ts)
                return ClaimResult(ok=False, state="expired", refusal="expired", entry=_snapshot(entry))
            if entry.state == "expired":
                return ClaimResult(ok=False, state="expired", refusal="expired", entry=_snapshot(entry))
            if entry.state != "pending":
                return ClaimResult(ok=False, state=entry.state, refusal=None, entry=_snapshot(entry))
            target = _ACTION_STATE[action]
            if target in TERMINAL_STATES:
                self._mark_terminal(vid, entry, target, ts)
            else:
                entry.state = target
            return ClaimResult(ok=True, state=target, refusal=None, entry=_snapshot(entry))

    def expire(self, vid: str, *, now: float | datetime | None = None) -> None:
        """Undoes a claim to `expired` when the `Entendi` message is missing, inaccessible or altered."""
        with self._lock:
            ts = self._now(now)
            entry = self._entries.get(vid)
            if entry is not None and entry.state in ("pending", "confirmed", "superseded"):
                self._mark_terminal(vid, entry, "expired", ts)

    def finish(
        self,
        vid: str,
        outcome: TerminalOutcome,
        *,
        now: float | datetime | None = None,
    ) -> None:
        """Settles a `confirmed` entry to `done` or `uncertain` after the agent run."""
        if outcome not in ("done", "uncertain"):
            raise ValueError(f"invalid terminal outcome: {outcome!r}")
        with self._lock:
            ts = self._now(now)
            entry = self._entries.get(vid)
            if entry is not None and entry.state == "confirmed":
                self._mark_terminal(vid, entry, outcome, ts)

    def get(self, vid: str, *, now: float | datetime | None = None) -> ConfirmationEntry | None:
        """Snapshot of `vid` if still retained, else None."""
        with self._lock:
            self._prune(self._now(now))
            entry = self._entries.get(vid)
            return _snapshot(entry) if entry is not None else None

    def __len__(self) -> int:
        with self._lock:
            self._prune(self._now(None))
            return len(self._entries)
