"""In-memory test doubles for the voice service (spec §13 C5c).

`TestProvider`, `TestDirectory` and `TestAuthorizer` live strictly under `tests/` so production
code can never register a test sign-in provider.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from collections import deque
from collections.abc import Callable, Iterable
from datetime import datetime
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo

from pydantic import SecretStr

from agent.auth import (
    VOICE,
    AllowedChats,
    AuthError,
    LinkCodes,
    Principal,
    TelegramDirectory,
    derive_keys,
    subject_ref,
    telegram_principal,
)
from agent.budget import MemoryBudget
from agent.settings import TranscribeSettings
from agent.transcribe import Audio, Transcriber, Transcript, Usage

SYNTHETIC_AUTH_SECRET = "synthetic-voice-auth-secret-32bytes!!"
SYNTHETIC_TRANSCRIBE_KEY = "synthetic-transcribe-key-1234"
SYNTHETIC_BOT_TOKEN = "123:TEST"
SYNTHETIC_ORIGIN = "https://miniapp.example.test"
SYNTHETIC_CHAT_ID = 900_000_101
OTHER_CHAT_ID = 900_000_202
DEFAULT_NOW = datetime(2026, 11, 14, 15, 0, tzinfo=ZoneInfo("America/Sao_Paulo"))

_TEST_REF_KEY = hashlib.sha256(b"voice-fakes:test-directory-key").digest()
_DEFAULT_USAGE = Usage(prompt_tokens=520, completion_tokens=18, audio_tokens=640)


class FakeClock:
    """Controllable aware-datetime clock shared across auth, budget, limiters and idempotency."""

    def __init__(self, initial: datetime = DEFAULT_NOW) -> None:
        self.current = initial

    def __call__(self) -> datetime:
        return self.current

    def advance(self, seconds: float) -> datetime:
        from datetime import timedelta

        self.current = self.current + timedelta(seconds=seconds)
        return self.current


def make_test_principal(
    subject: str = "u1",
    *,
    provider: str = "test",
    chat_id: int | None = None,
    scopes: Iterable[str] = (VOICE,),
) -> Principal:
    return Principal(
        provider=provider,
        subject=subject,
        chat_id=chat_id,
        scopes=frozenset(scopes),
    )


class TestProvider:
    """Non-Telegram `SignInProvider` (`kind = "test"`) for §13 acceptance tests."""

    __test__ = False
    kind = "test"

    def __init__(
        self,
        *,
        valid: dict[str, str] | None = None,
        error: BaseException | None = None,
    ) -> None:
        self._valid = (
            dict(valid) if valid is not None else {"u1": "u1", "ok:u1": "u1", "u2": "u2", "ok:u2": "u2"}
        )
        self._error = error
        self.calls: list[tuple[str, datetime]] = []

    def verify(self, credential: str, now: datetime) -> Principal:
        self.calls.append((credential, now))
        if self._error is not None:
            raise self._error
        if credential == "expired":
            raise AuthError("auth_expired")
        if credential == "used":
            raise AuthError("credential_used")
        if credential == "forbidden":
            raise AuthError("forbidden")
        subject = self._valid.get(credential)
        if subject is None:
            raise AuthError("unauthenticated")
        return make_test_principal(subject)


class TestDirectory:
    """In-memory `Directory` for `provider="test"` principals (`chat_id=None`)."""

    __test__ = False

    def __init__(self, principals: Iterable[Principal] | None = None) -> None:
        seed = (
            list(principals)
            if principals is not None
            else [make_test_principal("u1"), make_test_principal("u2")]
        )
        self._by_ref: dict[tuple[str, str], Principal] = {}
        for principal in seed:
            self._by_ref[(principal.provider, self.ref(principal))] = principal

    def ref(self, principal: Principal) -> str:
        opaque = subject_ref(_TEST_REF_KEY, principal.provider, principal.subject)
        self._by_ref[(principal.provider, opaque)] = principal
        return opaque

    def drop(self, provider: str, subject: str) -> None:
        opaque = subject_ref(_TEST_REF_KEY, provider, subject)
        self._by_ref.pop((provider, opaque), None)

    def resolve(self, provider: str, ref: str) -> Principal | None:
        return self._by_ref.get((provider, ref))


class TestAuthorizer:
    """In-memory `Authorizer` for `provider="test"` principals."""

    __test__ = False

    def __init__(self, allowed_subjects: Iterable[str] = ("u1", "u2")) -> None:
        self._allowed = set(allowed_subjects)

    def revoke(self, subject: str) -> None:
        self._allowed.discard(subject)

    def grant(self, subject: str) -> None:
        self._allowed.add(subject)

    def allows(self, principal: Principal, scope: str) -> bool:
        return (
            principal.provider == "test" and principal.subject in self._allowed and scope in principal.scopes
        )


Step = Transcript | BaseException | Callable[[Audio, str], Any]


class FakeTranscriber(Transcriber):
    """Scriptable `Transcriber` double that never touches the network."""

    def __init__(
        self,
        steps: Iterable[Step] | None = None,
        *,
        default_text: str = "supino 80 por 8, RIR 1",
        default_usage: Usage | None = _DEFAULT_USAGE,
        default_model: str = "gemini/gemini-3.8-flash",
    ) -> None:
        dummy_settings = TranscribeSettings.model_construct(
            TRANSCRIBE_MODEL=default_model,
            TRANSCRIBE_API_KEY=SecretStr(SYNTHETIC_TRANSCRIBE_KEY),
        )
        dummy_budget = MemoryBudget(
            principal_daily=120_000,
            global_daily=500_000,
            timezone="America/Sao_Paulo",
        )
        super().__init__(dummy_settings, dummy_budget)
        self._steps: deque[Step] = deque(steps or ())
        self._default_text = default_text
        self._default_usage = default_usage
        self._default_model = default_model
        self.calls: list[tuple[Audio, str, float | None]] = []

    async def transcribe(
        self, audio: Audio, *, principal_key: str, deadline_s: float | None = None
    ) -> Transcript:
        self.calls.append((audio, principal_key, deadline_s))
        if self._steps:
            step = self._steps.popleft()
            if isinstance(step, BaseException):
                raise step
            if callable(step):
                outcome = step(audio, principal_key)
                if asyncio.iscoroutine(outcome):
                    outcome = await outcome
                if isinstance(outcome, BaseException):
                    raise outcome
                assert isinstance(outcome, Transcript)
                return outcome
            return step
        return Transcript(
            text=self._default_text,
            model=self._default_model,
            usage=self._default_usage,
            fallback=False,
        )


def make_link_code(
    *,
    secret: str = SYNTHETIC_AUTH_SECRET,
    chat_id: int = SYNTHETIC_CHAT_ID,
    allowed_chats: Iterable[int] = (SYNTHETIC_CHAT_ID,),
    now: datetime = DEFAULT_NOW,
    ttl_s: int = 900,
) -> str:
    keys = derive_keys(secret)
    directory = TelegramDirectory(keys, allowed_chats)
    authorizer = AllowedChats(allowed_chats)
    issuer = LinkCodes(keys, directory, authorizer, ttl_s=ttl_s)
    code, _ = issuer.issue(telegram_principal(chat_id), now)
    return code


def make_init_data(
    *,
    bot_token: str = SYNTHETIC_BOT_TOKEN,
    user_id: int = SYNTHETIC_CHAT_ID,
    auth_date: int | None = None,
    now: datetime = DEFAULT_NOW,
    extra_pairs: Iterable[tuple[str, str]] = (),
) -> str:
    issued = int(now.timestamp()) if auth_date is None else auth_date
    user_json = json.dumps({"id": user_id, "first_name": "Test"}, separators=(",", ":"))
    pairs: list[tuple[str, str]] = [
        ("auth_date", str(issued)),
        ("user", user_json),
        *extra_pairs,
    ]
    check_string = "\n".join(f"{k}={v}" for k, v in sorted(pairs, key=lambda item: item[0]))
    secret_key = hmac.new(b"WebAppData", bot_token.strip().encode("utf-8"), hashlib.sha256).digest()
    digest = hmac.new(secret_key, check_string.encode("utf-8"), hashlib.sha256).hexdigest()
    encoded = [f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in pairs]
    encoded.append(f"hash={digest}")
    return "&".join(encoded)
