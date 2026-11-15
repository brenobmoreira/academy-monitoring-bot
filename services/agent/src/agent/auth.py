"""Sign-in providers, sessions and the directory behind them (voice input design, §6).

Two layers. A sign-in provider turns something the client has (a one-time code from the bot,
Telegram `initData`, later a PWA magic link or a native login) into a Principal; it is used only by
the exchange (SignIn). A session is the only credential an API route accepts: the route calls
Sessions.verify and never learns how the person signed in. Telegram is one provider among others:
nothing in Sessions or SignIn knows about it.

Everything here is pure: no HTTP, no I/O, the clock is an argument. It also logs nothing and its
errors carry a code and nothing else (§10): a credential, a hash or a payload never reaches an
exception message, an exception chain or a log line.

Tokens (keys of §6.2, formats of §6.4 and §6.6):

    code    = "c1." + B + "." + b64url(HMAC_SHA256(K_code, "c1." + B))       B = {"r", "j", "e"}
    session = "s1." + B + "." + b64url(HMAC_SHA256(K_session, "s1." + B))    B = {"p","r","s","i","e","c"}

A token never carries a Telegram id or any subject in clear, only the opaque reference of §6.3.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import re
import secrets
import threading
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import datetime
from typing import Literal, Protocol
from urllib.parse import unquote

AuthCode = Literal["unauthenticated", "auth_expired", "credential_used", "forbidden"]

VOICE = "voice"
SCOPES = frozenset({VOICE})
TELEGRAM = "telegram"

MIN_SECRET_BYTES = 32
MAX_TOKEN_LEN = 512
MAX_CREDENTIAL_LEN = 4096
MAX_REQUEST_BYTES = 4096
# How far ahead of this process's clock an issue time (`i`, `auth_date`) may be.
MAX_CLOCK_SKEW_S = 60
MAX_PROVIDER_LEN = 32
_MAX_INT = 2**53  # integers a JSON client can hold exactly; also bounds every time in a token

_B64URL = re.compile(r"[A-Za-z0-9_-]*")
_REF = re.compile(r"[A-Za-z0-9_-]{22}")  # 128 bits of a MAC
_NONCE_16 = re.compile(r"[A-Za-z0-9_-]{22}")  # 16 random bytes
_NONCE_12 = re.compile(r"[A-Za-z0-9_-]{16}")  # 12 random bytes
_HEX_64 = re.compile(r"[0-9a-f]{64}")
_DIGITS = re.compile(r"[0-9]{1,12}")


# --- model (§6.1) ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Principal:
    provider: str  # "telegram" now; later "pwa", "native", "coach"; tests use "test"
    # The subject and the chat id are identifiers that must not be logged: they stay out of repr().
    subject: str = field(repr=False)  # stable id inside the provider
    chat_id: int | None = field(repr=False)  # Telegram reply target; None outside Telegram
    scopes: frozenset[str]


class AuthError(Exception):
    """A refused credential. Its only content is `code`, which logs.describe() prints."""

    def __init__(self, code: AuthCode) -> None:
        super().__init__(code)
        self.code: AuthCode = code


class BadRequest(Exception):
    """An exchange request that is not exactly the contract of §6.7."""

    code = "bad_request"

    def __init__(self) -> None:
        super().__init__(self.code)


class SignInProvider(Protocol):
    @property
    def kind(self) -> str: ...  # "tg_link", "tg_init_data", later "magic_link"...

    def verify(self, credential: str, now: datetime) -> Principal: ...  # raises AuthError


class Directory(Protocol):
    """Opaque reference <-> principal. A lookup table at the database step."""

    def ref(self, principal: Principal) -> str: ...

    def resolve(self, provider: str, ref: str) -> Principal | None: ...


class Authorizer(Protocol):
    def allows(self, principal: Principal, scope: str) -> bool: ...


class Revocations(Protocol):
    def not_before(self, principal: Principal) -> int | None: ...  # unix seconds


# --- strict base64url and JSON ---------------------------------------------------------------------


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    """Alphabet `A-Z a-z 0-9 - _` only, no padding, and canonical: the one spelling of its bytes.

    A lenient decoder accepts several texts for the same bytes (padding, non-zero unused bits);
    accepting them would let one credential be written in ways that compare unequal as text."""
    if not isinstance(text, str) or _B64URL.fullmatch(text) is None or len(text) % 4 == 1:
        raise ValueError("not base64url")
    try:
        data = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except binascii.Error:
        data = None
    if data is None or b64url_encode(data) != text:
        raise ValueError("not canonical base64url")
    return data


def _no_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
    found: dict[str, object] = {}
    for key, value in pairs:
        if key in found:
            raise ValueError("duplicate key")
        found[key] = value
    return found


def _no_constants(_name: str) -> object:
    raise ValueError("NaN and Infinity are not JSON")


def strict_json_object(raw: bytes | str) -> dict[str, object]:
    """A JSON object from UTF-8 bytes (or text), refusing duplicate keys at any depth, NaN and
    Infinity, and anything that is not an object. Raises ValueError, whose message never quotes
    the input."""
    value: object = None
    try:
        text = raw.decode("utf-8", errors="strict") if isinstance(raw, bytes) else raw
        value = json.loads(text, object_pairs_hook=_no_duplicates, parse_constant=_no_constants)
    except (ValueError, RecursionError):
        value = None
    # Raised here, outside the handler: the JSON error keeps the whole document in `doc`, and must
    # not travel as the `__context__` of what callers see.
    if not isinstance(value, dict):
        raise ValueError("not a JSON object")
    return value


def _parsed(raw: bytes | str) -> dict[str, object] | None:
    try:
        return strict_json_object(raw)
    except ValueError:
        return None


def _decoded(text: str) -> bytes | None:
    try:
        return b64url_decode(text)
    except ValueError:
        return None


def _compact(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def _is_int(value: object) -> bool:
    """A non-negative JSON integer: not a boolean (bool is an int in Python), not a float."""
    return type(value) is int and 0 <= value < _MAX_INT


def _matches(pattern: re.Pattern[str], value: object) -> bool:
    return type(value) is str and pattern.fullmatch(value) is not None


def _unix(now: datetime) -> int:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("the clock must give an aware datetime")
    return int(now.timestamp())


# --- keys (§6.2) -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Keys:
    """Independent sub-keys of APP_AUTH_SECRET; none is ever printed."""

    code: bytes = field(repr=False)
    session: bytes = field(repr=False)
    ref: bytes = field(repr=False)
    log: bytes = field(repr=False)


def derive_keys(secret: str | bytes) -> Keys:
    """`K_x = HMAC_SHA256(APP_AUTH_SECRET, "academy-auth:" + x)`. Rotating the secret revokes every
    code and every session at once."""
    raw = secret.encode("utf-8") if isinstance(secret, str) else bytes(secret)
    if len(raw) < MIN_SECRET_BYTES:
        raise ValueError(f"APP_AUTH_SECRET must be at least {MIN_SECRET_BYTES} bytes")

    def sub(name: str) -> bytes:
        return hmac.new(raw, f"academy-auth:{name}".encode(), hashlib.sha256).digest()

    return Keys(code=sub("code"), session=sub("session"), ref=sub("ref"), log=sub("log"))


def _mac(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("ascii"), hashlib.sha256).digest()


def _seal(prefix: str, key: bytes, payload: dict[str, object]) -> str:
    head = f"{prefix}.{b64url_encode(_compact(payload))}"
    return f"{head}.{b64url_encode(_mac(key, head))}"


def _open(prefix: str, key: bytes, token: object) -> dict[str, object] | None:
    """The payload of `<prefix>.<B>.<MAC>`, or None. Order of §6.6: length, prefix, strict
    base64url, MAC in constant time, and only then the JSON, so nothing unsigned is parsed."""
    if not isinstance(token, str) or len(token) > MAX_TOKEN_LEN:
        return None
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != prefix:
        return None
    body, signature = parts[1], parts[2]
    payload, given = _decoded(body), _decoded(signature)
    if payload is None or given is None:
        return None
    if not hmac.compare_digest(_mac(key, f"{prefix}.{body}"), given):
        return None
    return _parsed(payload)


# --- opaque reference and the Telegram directory (§6.3) --------------------------------------------


def subject_ref(key: bytes, provider: str, subject: str) -> str:
    """`b64url(HMAC_SHA256(K_ref, provider + ":" + subject))[:22]`: a stable pseudonym. Two tokens
    of one person can be linked to each other, but not to the person without the secret."""
    digest = hmac.new(key, f"{provider}:{subject}".encode(), hashlib.sha256).digest()
    return b64url_encode(digest)[:22]


def telegram_principal(chat_id: int) -> Principal:
    """The person of a private chat: the chat has the user's id."""
    return Principal(TELEGRAM, str(chat_id), chat_id, frozenset({VOICE}))


class TelegramDirectory:
    """Resolves a ref by computing it for each allowed chat (the set is small)."""

    def __init__(self, keys: Keys, chat_ids: Iterable[int]) -> None:
        self._key = keys.ref
        self._known = tuple(
            (subject_ref(keys.ref, TELEGRAM, str(chat_id)).encode("ascii"), chat_id)
            for chat_id in sorted(set(chat_ids))
        )

    def ref(self, principal: Principal) -> str:
        return subject_ref(self._key, principal.provider, principal.subject)

    def resolve(self, provider: str, ref: str) -> Principal | None:
        if provider != TELEGRAM or not isinstance(ref, str):
            return None
        given = ref.encode("utf-8", errors="replace")
        found: int | None = None
        for known, chat_id in self._known:  # every id is compared: no early exit to time
            if hmac.compare_digest(known, given):
                found = chat_id
        return None if found is None else telegram_principal(found)


# --- authorization and revocation (§6.5) -----------------------------------------------------------


class AllowedChats:
    """Today's rule for chat messages: a Telegram principal whose chat is in ALLOWED_CHAT_IDS."""

    def __init__(self, chat_ids: Iterable[int]) -> None:
        self._chat_ids = frozenset(chat_ids)

    def allows(self, principal: Principal, scope: str) -> bool:
        return (
            principal.provider == TELEGRAM
            and type(principal.chat_id) is int  # True == 1 in Python
            and principal.chat_id in self._chat_ids
            and scope in principal.scopes
        )


class ConfigRevocations:
    """APP_SESSION_NOT_BEFORE: `{chat_id: unix seconds}`; that person's earlier sessions are over."""

    def __init__(self, not_before: Mapping[int, int]) -> None:
        self._not_before = dict(not_before)

    def not_before(self, principal: Principal) -> int | None:
        if principal.provider != TELEGRAM or principal.chat_id is None:
            return None
        return self._not_before.get(principal.chat_id)


# --- single use ------------------------------------------------------------------------------------


class UsedSet:
    """The one-time keys already redeemed in this process, each kept until its expiry (§6.8 T4)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._seen: dict[str, int] = {}

    def claim(self, key: str, exp: int, *, now: int) -> bool:
        """True for the first caller of `key`, False for every other, concurrent or later: the
        check and the insertion happen under one lock. `exp` is the last second at which the
        credential can still be presented; `now` only prunes what can no longer be."""
        with self._lock:
            for old in [k for k, expiry in self._seen.items() if expiry < now]:
                del self._seen[old]
            if key in self._seen:
                return False
            self._seen[key] = exp
            return True

    def __len__(self) -> int:
        with self._lock:
            return len(self._seen)


# --- one-time link code (§6.4) ---------------------------------------------------------------------


class LinkCodes:
    """Issues the code `/app` puts in the Mini App link, and redeems it (`kind = "tg_link"`).

    The code grants nothing by itself; it only buys one session."""

    kind = "tg_link"

    def __init__(
        self,
        keys: Keys,
        directory: Directory,
        authorizer: Authorizer,
        used: UsedSet | None = None,
        *,
        ttl_s: int,
    ) -> None:
        self._key = keys.code
        self._directory = directory
        self._authorizer = authorizer
        self.used = used if used is not None else UsedSet()
        self._ttl_s = ttl_s

    def issue(self, principal: Principal, now: datetime) -> tuple[str, int]:
        """(code, exp) for an allowed principal; AuthError("forbidden") for any other."""
        if not self._authorizer.allows(principal, VOICE):
            raise AuthError("forbidden")
        exp = _unix(now) + self._ttl_s
        payload = {"r": self._directory.ref(principal), "j": b64url_encode(secrets.token_bytes(16)), "e": exp}
        return _seal("c1", self._key, payload), exp

    def verify(self, credential: str, now: datetime) -> Principal:
        at = _unix(now)
        payload = _open("c1", self._key, credential)
        if payload is None or set(payload) != {"r", "j", "e"}:
            raise AuthError("unauthenticated")
        ref, nonce, exp = payload["r"], payload["j"], payload["e"]
        if not (_matches(_REF, ref) and _matches(_NONCE_16, nonce) and _is_int(exp)):
            raise AuthError("unauthenticated")
        assert isinstance(ref, str) and isinstance(nonce, str) and isinstance(exp, int)
        if exp <= at:
            raise AuthError("auth_expired")
        principal = self._directory.resolve(TELEGRAM, ref)
        if principal is None or not self._authorizer.allows(principal, VOICE):
            raise AuthError("forbidden")
        # Last, after every check: a refused attempt must not burn the code, and only the one
        # caller that wins the claim may get a session.
        if not self.used.claim(nonce, exp, now=at):
            raise AuthError("credential_used")
        return principal


# --- Telegram initData (§6.7) ----------------------------------------------------------------------


def _percent_decoded(text: str) -> str | None:
    try:
        return unquote(text, encoding="utf-8", errors="strict")
    except ValueError:
        return None


def _utf8(text: str) -> bytes | None:
    try:
        return text.encode("utf-8", errors="strict")
    except ValueError:  # a lone surrogate
        return None


class TelegramInitData:
    """Validates Mini App `initData` with the bot token (`kind = "tg_init_data"`).

    Exchange only: the voice route never accepts `initData` itself. The Ed25519 `signature` for
    third parties is not needed, since this service holds the bot token."""

    kind = "tg_init_data"

    def __init__(
        self,
        bot_token: str,
        authorizer: Authorizer,
        used: UsedSet | None = None,
        *,
        max_age_s: int,
    ) -> None:
        if not bot_token or not bot_token.strip():
            raise ValueError("TELEGRAM_BOT_TOKEN is required by the tg_init_data provider")
        # Only the derived key is kept; the token itself is not stored here.
        self._key = hmac.new(b"WebAppData", bot_token.strip().encode("utf-8"), hashlib.sha256).digest()
        self._authorizer = authorizer
        self.used = used if used is not None else UsedSet()
        self._max_age_s = max_age_s

    def verify(self, credential: str, now: datetime) -> Principal:
        at = _unix(now)
        fields = self._pairs(credential)
        if fields is None:
            raise AuthError("unauthenticated")
        given = fields.pop("hash", None)
        auth_date = fields.get("auth_date")
        if (
            given is None
            or _HEX_64.fullmatch(given) is None
            or auth_date is None
            or _DIGITS.fullmatch(auth_date) is None
            or "user" not in fields
        ):
            raise AuthError("unauthenticated")
        check = _utf8("\n".join(f"{key}={fields[key]}" for key in sorted(fields)))
        if check is None:
            raise AuthError("unauthenticated")
        expected = hmac.new(self._key, check, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected.encode("ascii"), given.encode("ascii")):
            raise AuthError("unauthenticated")
        # Signed by Telegram from here on.
        issued = int(auth_date)
        if at - issued > self._max_age_s:
            raise AuthError("auth_expired")
        if issued - at > MAX_CLOCK_SKEW_S:
            raise AuthError("unauthenticated")
        user = _parsed(fields["user"])
        user_id = None if user is None else user.get("id")
        if not _is_int(user_id) or user_id == 0:
            raise AuthError("unauthenticated")
        assert isinstance(user_id, int)
        principal = telegram_principal(user_id)
        if not self._authorizer.allows(principal, VOICE):
            raise AuthError("forbidden")
        if not self.used.claim(given, issued + self._max_age_s, now=at):
            raise AuthError("credential_used")
        return principal

    @staticmethod
    def _pairs(credential: object) -> dict[str, str] | None:
        """The query string, strictly: every pair split once on "=", percent-decoded as UTF-8, and
        no key twice (a parser that keeps the first and a signer that keeps the last would
        disagree about what was signed)."""
        if not isinstance(credential, str) or not credential or len(credential) > MAX_CREDENTIAL_LEN:
            return None
        fields: dict[str, str] = {}
        for pair in credential.split("&"):
            name, separator, value = pair.partition("=")
            key, text = _percent_decoded(name), _percent_decoded(value)
            if not separator or key is None or text is None or key in fields:
                return None
            fields[key] = text
        return fields


# --- sessions (§6.6) -------------------------------------------------------------------------------

_SESSION_KEYS = frozenset({"p", "r", "s", "i", "e", "c"})


class Sessions:
    """Issues and verifies the only credential the API accepts. No refresh: an expired session is
    replaced through a new exchange."""

    def __init__(
        self,
        keys: Keys,
        directory: Directory,
        authorizer: Authorizer,
        revocations: Revocations,
        *,
        ttl_s: int,
    ) -> None:
        self._key = keys.session
        self.directory = directory
        self._authorizer = authorizer
        self._revocations = revocations
        self._ttl_s = ttl_s

    def issue(self, principal: Principal, now: datetime) -> tuple[str, int]:
        """(token, exp) for a principal a sign-in provider has just verified."""
        iat = _unix(now)
        ref = self.directory.ref(principal)
        if not principal.scopes or not principal.scopes <= SCOPES:
            raise ValueError("a session carries known scopes only")
        if not _matches(_REF, ref) or not 1 <= len(principal.provider) <= MAX_PROVIDER_LEN:
            raise ValueError("the directory gave a reference that does not fit a session")
        exp = iat + self._ttl_s
        payload = {
            "p": principal.provider,
            "r": ref,
            "s": b64url_encode(secrets.token_bytes(12)),
            "i": iat,
            "e": exp,
            "c": sorted(principal.scopes),
        }
        return _seal("s1", self._key, payload), exp

    def verify(self, token: str, scope: str, now: datetime) -> Principal:
        at = _unix(now)
        payload = _open("s1", self._key, token)
        if payload is None or set(payload) != _SESSION_KEYS:
            raise AuthError("unauthenticated")
        provider, ref, iat, exp, scopes = (payload[k] for k in ("p", "r", "i", "e", "c"))
        if not (
            type(provider) is str
            and 1 <= len(provider) <= MAX_PROVIDER_LEN
            and _matches(_REF, ref)
            and _matches(_NONCE_12, payload["s"])
            and _is_int(iat)
            and _is_int(exp)
            and type(scopes) is list
            and scopes
            and all(type(s) is str and s in SCOPES for s in scopes)
            and len(set(scopes)) == len(scopes)
        ):
            raise AuthError("unauthenticated")
        assert isinstance(provider, str) and isinstance(ref, str)
        assert isinstance(iat, int) and isinstance(exp, int) and isinstance(scopes, list)
        if exp <= at:
            raise AuthError("auth_expired")
        if iat > at + MAX_CLOCK_SKEW_S:
            raise AuthError("unauthenticated")
        principal = self.directory.resolve(provider, ref)
        if principal is None or not self._authorizer.allows(principal, scope):
            raise AuthError("forbidden")
        not_before = self._revocations.not_before(principal)
        if not_before is not None and iat < not_before:
            raise AuthError("auth_expired")
        granted = frozenset(scopes) & principal.scopes
        if scope not in granted:
            raise AuthError("forbidden")
        return replace(principal, scopes=granted)


# --- the exchange (§6.7, without HTTP) -------------------------------------------------------------


@dataclass(frozen=True)
class SessionGrant:
    """The 200 of `POST /v1/auth/sessions`. `ref` binds the stored session to its account (§7.2)."""

    session: str = field(repr=False)
    expires_at: int
    scopes: tuple[str, ...]
    ref: str


class SignIn:
    """Credential in, session out. The providers are whatever the caller passes: no setting or
    environment variable can register one."""

    def __init__(self, providers: Sequence[SignInProvider], sessions: Sessions) -> None:
        self._providers = {provider.kind: provider for provider in providers}
        if len(self._providers) != len(providers):
            raise ValueError("two sign-in providers have the same kind")
        self._sessions = sessions

    @property
    def kinds(self) -> frozenset[str]:
        return frozenset(self._providers)

    def parse(self, body: bytes) -> tuple[str, str]:
        """(kind, credential) of a request body, or BadRequest: exactly the keys `v`, `kind` and
        `credential`, no key twice, `v` the JSON integer 1, the other two strings."""
        if not isinstance(body, bytes | bytearray) or len(body) > MAX_REQUEST_BYTES:
            raise BadRequest
        request = _parsed(bytes(body))
        if request is None or set(request) != {"v", "kind", "credential"}:
            raise BadRequest
        version, kind, credential = request["v"], request["kind"], request["credential"]
        if type(version) is not int or version != 1:  # not True, not "1", not 1.0
            raise BadRequest
        if type(kind) is not str or type(credential) is not str:
            raise BadRequest
        self._check(kind, credential)
        return kind, credential

    def exchange(self, kind: str, credential: str, now: datetime) -> SessionGrant:
        self._check(kind, credential)
        principal = self._providers[kind].verify(credential, now)
        token, exp = self._sessions.issue(principal, now)
        return SessionGrant(
            token, exp, tuple(sorted(principal.scopes)), self._sessions.directory.ref(principal)
        )

    def handle(self, body: bytes, now: datetime) -> SessionGrant:
        kind, credential = self.parse(body)
        return self.exchange(kind, credential, now)

    def _check(self, kind: str, credential: str) -> None:
        if kind not in self._providers or not 1 <= len(credential) <= MAX_CREDENTIAL_LEN:
            raise BadRequest
