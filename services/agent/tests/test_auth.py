"""Sign-in providers, sessions and directory (voice input design, §6.1-6.7), without HTTP.

Every secret, token and id here is synthetic and made in the test: the repository is public.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote

import pytest
from pydantic import ValidationError

from agent import auth, logs
from agent.voice_settings import AuthSettings

pytestmark = pytest.mark.unit

SECRET = secrets.token_urlsafe(48)
OTHER_SECRET = secrets.token_urlsafe(48)
BOT_TOKEN = "123:TEST"
ALICE, BOB, STRANGER = 1001, 1002, 1003  # made-up chat ids
NOW = datetime(2026, 11, 14, 12, 0, tzinfo=UTC)
T0 = int(NOW.timestamp())


def at(seconds: int) -> datetime:
    return NOW + timedelta(seconds=seconds)


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def compact(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode()


def sign(prefix: str, key: bytes, payload: bytes) -> str:
    """A token made outside the module: `<prefix>.<B>.<MAC>` over arbitrary payload bytes."""
    head = f"{prefix}.{b64(payload)}"
    return f"{head}.{b64(hmac.new(key, head.encode(), hashlib.sha256).digest())}"


def payload_of(token: str) -> dict:
    return json.loads(unb64(token.split(".")[1]))


class World:
    """One process's wiring: what the bot and the voice service build from their settings."""

    def __init__(
        self,
        allowed: frozenset[int] = frozenset({ALICE, BOB}),
        not_before: dict[int, int] | None = None,
        secret: str = SECRET,
    ) -> None:
        self.keys = auth.derive_keys(secret)
        self.directory = auth.TelegramDirectory(self.keys, allowed)
        self.authorizer = auth.AllowedChats(allowed)
        self.revocations = auth.ConfigRevocations(not_before or {})
        self.codes = auth.LinkCodes(self.keys, self.directory, self.authorizer, ttl_s=900)
        self.init_data = auth.TelegramInitData(BOT_TOKEN, self.authorizer, max_age_s=300)
        self.sessions = auth.Sessions(
            self.keys, self.directory, self.authorizer, self.revocations, ttl_s=43_200
        )
        self.sign_in = auth.SignIn([self.codes, self.init_data], self.sessions)

    def code(self, chat_id: int = ALICE, now: datetime = NOW) -> str:
        return self.codes.issue(auth.telegram_principal(chat_id), now)[0]

    def session(self, chat_id: int = ALICE, now: datetime = NOW) -> str:
        return self.sessions.issue(auth.telegram_principal(chat_id), now)[0]


@pytest.fixture
def world() -> World:
    return World()


# --- strict base64url and JSON ---------------------------------------------------------------------


def test_b64url_round_trips_without_padding():
    for size in range(0, 40):
        data = secrets.token_bytes(size)
        text = auth.b64url_encode(data)
        assert "=" not in text
        assert auth.b64url_decode(text) == data


@pytest.mark.parametrize(
    "text",
    [
        "QQ==",  # padding
        "QQ=",
        "QR",  # non-canonical: the unused trailing bits are not zero ("QQ" is the canonical form)
        "QUJ",  # same, for a two-byte value ("QUI" is canonical)
        "Q",  # impossible length
        "QU+/",  # standard alphabet
        "QU JD",
        "QUJD\n",
        "QUJDé",
    ],
)
def test_b64url_decode_rejects_anything_not_canonical(text):
    with pytest.raises(ValueError):
        auth.b64url_decode(text)


def test_strict_json_accepts_an_object():
    assert auth.strict_json_object(b'{"a":1,"b":"x"}') == {"a": 1, "b": "x"}
    assert auth.strict_json_object('{"a":[1,{"b":2}]}') == {"a": [1, {"b": 2}]}


@pytest.mark.parametrize(
    "raw",
    [
        b'{"a":1,"a":2}',  # duplicate key
        b'{"a":{"b":1,"b":2}}',  # duplicate key, nested
        b"[1]",
        b'"x"',
        b"1",
        b"null",
        b'{"a":NaN}',
        b'{"a":Infinity}',
        b'{"a":1',
        b"",
        b'{"a":"\xff"}',  # not UTF-8
        pytest.param(b"[" * 100_000, id="nesting deep enough to exhaust the parser"),
    ],
)
def test_strict_json_rejects(raw):
    with pytest.raises(ValueError) as err:
        auth.strict_json_object(raw)
    assert err.value.__context__ is None  # the JSON error keeps the whole document


# --- keys ------------------------------------------------------------------------------------------


def test_sub_keys_follow_the_spec_and_are_independent():
    keys = auth.derive_keys(SECRET)
    for name in ("code", "session", "ref", "log"):
        expected = hmac.new(SECRET.encode(), f"academy-auth:{name}".encode(), hashlib.sha256).digest()
        assert getattr(keys, name) == expected
    assert len({keys.code, keys.session, keys.ref, keys.log}) == 4
    assert auth.derive_keys(OTHER_SECRET).session != keys.session


def test_a_short_secret_is_refused():
    with pytest.raises(ValueError):
        auth.derive_keys("x" * 31)
    auth.derive_keys("x" * 32)


def test_keys_and_principals_do_not_print_what_must_not_be_logged():
    keys = auth.derive_keys(SECRET)
    shown = repr(keys) + str(keys)
    for name in ("code", "session", "ref", "log"):
        assert repr(getattr(keys, name)) not in shown
        assert getattr(keys, name).hex() not in shown
    assert str(ALICE) not in repr(auth.telegram_principal(ALICE))


# --- opaque reference and directory ----------------------------------------------------------------


def test_ref_is_the_truncated_mac_of_provider_and_subject(world):
    ref = world.directory.ref(auth.telegram_principal(ALICE))
    mac = hmac.new(world.keys.ref, f"telegram:{ALICE}".encode(), hashlib.sha256).digest()
    assert ref == b64(mac)[:22]
    assert len(ref) == 22


def test_ref_never_contains_the_id_and_differs_per_person_and_secret(world):
    ref_a = world.directory.ref(auth.telegram_principal(ALICE))
    ref_b = world.directory.ref(auth.telegram_principal(BOB))
    assert ref_a != ref_b
    assert str(ALICE) not in ref_a
    assert World(secret=OTHER_SECRET).directory.ref(auth.telegram_principal(ALICE)) != ref_a


def test_directory_resolves_a_ref_to_its_own_principal(world):
    for chat_id in (ALICE, BOB):
        ref = world.directory.ref(auth.telegram_principal(chat_id))
        principal = world.directory.resolve("telegram", ref)
        assert principal == auth.Principal("telegram", str(chat_id), chat_id, frozenset({"voice"}))


def test_directory_does_not_resolve_unknown_refs_or_other_providers(world):
    ref_a = world.directory.ref(auth.telegram_principal(ALICE))
    stranger = world.directory.ref(auth.telegram_principal(STRANGER))
    assert world.directory.resolve("telegram", stranger) is None
    assert world.directory.resolve("pwa", ref_a) is None
    assert world.directory.resolve("telegram", ref_a[:-1]) is None
    assert world.directory.resolve("telegram", "") is None
    assert world.directory.resolve("telegram", "é" * 22) is None
    assert world.directory.resolve("telegram", chr(0xD800) * 22) is None
    assert auth.TelegramDirectory(world.keys, frozenset()).resolve("telegram", ref_a) is None


# --- authorization and revocation ------------------------------------------------------------------


def test_allowed_chats_is_the_chat_allowlist(world):
    assert world.authorizer.allows(auth.telegram_principal(ALICE), "voice")
    assert not world.authorizer.allows(auth.telegram_principal(STRANGER), "voice")
    assert not world.authorizer.allows(auth.telegram_principal(ALICE), "write")
    other = auth.Principal("pwa", str(ALICE), ALICE, frozenset({"voice"}))
    assert not world.authorizer.allows(other, "voice")
    no_chat = auth.Principal("telegram", str(ALICE), None, frozenset({"voice"}))
    assert not world.authorizer.allows(no_chat, "voice")


def test_allowed_chats_does_not_take_a_boolean_for_chat_one():
    authorizer = auth.AllowedChats(frozenset({1}))
    forged = auth.Principal("telegram", "1", True, frozenset({"voice"}))
    assert not authorizer.allows(forged, "voice")


def test_config_revocations_is_per_chat():
    revocations = auth.ConfigRevocations({ALICE: T0})
    assert revocations.not_before(auth.telegram_principal(ALICE)) == T0
    assert revocations.not_before(auth.telegram_principal(BOB)) is None
    assert revocations.not_before(auth.Principal("pwa", str(ALICE), ALICE, frozenset())) is None


# --- single-use set --------------------------------------------------------------------------------


def test_used_set_claims_once():
    used = auth.UsedSet()
    assert used.claim("j1", T0 + 10, now=T0) is True
    assert used.claim("j1", T0 + 10, now=T0) is False
    assert used.claim("j2", T0 + 10, now=T0) is True


def test_used_set_keeps_a_key_until_its_expiry_inclusive_then_forgets_it():
    used = auth.UsedSet()
    used.claim("j1", T0 + 10, now=T0)
    assert used.claim("other", T0 + 99, now=T0 + 10) is True  # prunes nothing that can still be valid
    assert used.claim("j1", T0 + 10, now=T0 + 10) is False
    assert len(used) == 2
    used.claim("another", T0 + 99, now=T0 + 11)
    assert len(used) == 2  # j1 is gone: nothing accepts it after its expiry


class _SlowDict(dict):
    """Widens the gap between "is it there?" and "put it there": without one lock around both,
    every thread sees the key missing before any of them inserts it."""

    def __contains__(self, key: object) -> bool:
        found = super().__contains__(key)
        time.sleep(0.02)
        return found


def test_used_set_check_and_insert_are_one_step_under_threads():
    used = auth.UsedSet()
    used._seen = _SlowDict()
    barrier = threading.Barrier(8)
    results: list[bool] = []

    def worker() -> None:
        barrier.wait()
        results.append(used.claim("j1", T0 + 10, now=T0))

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(results) == [False] * 7 + [True]


# --- helpers shared by codes, initData and sessions ------------------------------------------------


def _race(redeem, n: int = 16) -> list[str]:
    """`redeem` called by n threads released together; "ok" or the AuthError code of each."""
    barrier = threading.Barrier(n)
    outcomes: list[str] = []

    def worker() -> None:
        barrier.wait()
        try:
            redeem()
            outcomes.append("ok")
        except auth.AuthError as err:
            outcomes.append(err.code)

    threads = [threading.Thread(target=worker) for _ in range(n)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return outcomes


async def _gather(redeem, n: int = 16) -> list[str]:
    async def one() -> str:
        await asyncio.sleep(0)
        try:
            redeem()
            return "ok"
        except auth.AuthError as err:
            return err.code

    return list(await asyncio.gather(*(one() for _ in range(n))))


_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"


def _non_canonical(text: str) -> str:
    """The same bytes for a lenient decoder, another spelling: sets an unused trailing bit."""
    assert len(text) % 4 in (2, 3)
    twin = text[:-1] + _ALPHABET[_ALPHABET.index(text[-1]) | 1]
    assert twin != text and unb64(twin) == unb64(text)
    return twin


def _token_mutations(prefix: str, key: bytes, other_key: bytes, good: dict) -> dict[str, str]:
    """Tokens that differ from a valid one in one way; each must be `unauthenticated`."""
    valid = sign(prefix, key, compact(good))
    head, body, mac = valid.split(".")
    loose = compact(good)
    if len(loose) % 3 == 0:  # base64url has unused bits only when the length is not a multiple of 3
        loose = loose[:-1] + b" }"
    loose_head = f"{prefix}.{_non_canonical(b64(loose))}"
    loose_token = f"{loose_head}.{b64(hmac.new(key, loose_head.encode(), hashlib.sha256).digest())}"
    flipped = bytearray(unb64(mac))
    flipped[0] ^= 1
    first = next(iter(good))
    duplicated = compact(good)[:-1] + b"," + compact({first: good[first]})[1:]
    cases = {
        "mac of another payload": f"{head}.{b64(compact({**good, 'e': good['e'] + 1}))}.{mac}",
        "one bit of the mac": f"{head}.{body}.{b64(bytes(flipped))}",
        "truncated mac": f"{head}.{body}.{mac[:-2]}",
        "mac made with the other sub-key": sign(prefix, other_key, compact(good)),
        "mac made with another secret": sign(prefix, auth.derive_keys(OTHER_SECRET).code, compact(good)),
        "next version, correctly signed": sign(prefix[0] + "2", key, compact(good)),
        "no prefix": f"{body}.{mac}",
        "four parts": f"{valid}.x",
        "padded payload": f"{head}.{body}=.{mac}",
        "padded mac": f"{head}.{body}.{mac}=",
        "non-canonical mac": f"{head}.{body}.{_non_canonical(mac)}",
        "non-canonical payload, correctly signed": loose_token,
        "standard alphabet": f"{head}.{body}.{mac[:-1]}+",
        "duplicate json key, correctly signed": sign(prefix, key, duplicated),
        "extra key": sign(prefix, key, compact({**good, "x": 1})),
        "payload is a list": sign(prefix, key, compact(list(good.values()))),
        "payload is not json": sign(prefix, key, b"not json"),
        "payload is not utf-8": sign(prefix, key, b'{"r":"\xff"}'),
        "over-long, correctly signed": sign(prefix, key, compact(good)[:-1] + b" " * 400 + b"}"),
        "empty": "",
        "trailing newline": valid + "\n",
    }
    for name in good:
        cases[f"missing {name}"] = sign(prefix, key, compact({k: v for k, v in good.items() if k != name}))
    return cases


def test_the_mutation_helper_builds_what_it_says():
    good = {"r": "a" * 22, "j": "b" * 22, "e": T0 + 5}
    cases = _token_mutations("c1", b"k" * 32, b"o" * 32, good)
    assert len(cases["over-long, correctly signed"]) > 512
    assert payload_of(cases["over-long, correctly signed"]) == good
    assert unb64(cases["duplicate json key, correctly signed"].split(".")[1]).count(b'"r"') == 2
    loose = cases["non-canonical payload, correctly signed"].split(".")[1]
    assert json.loads(unb64(loose)) == good and b64(unb64(loose)) != loose
    assert len(set(cases.values())) == len(cases)


# --- one-time link code (§6.4) ---------------------------------------------------------------------


def good_code_payload(world: World, chat_id: int = ALICE, exp: int = T0 + 900) -> dict:
    ref = world.directory.ref(auth.telegram_principal(chat_id))
    return {"r": ref, "j": b64(secrets.token_bytes(16)), "e": exp}


def code_error(world: World, token: Any, now: datetime = NOW) -> str:
    with pytest.raises(auth.AuthError) as err:
        world.codes.verify(token, now)
    return err.value.code


def test_a_code_has_the_format_of_the_spec(world):
    code, exp = world.codes.issue(auth.telegram_principal(ALICE), NOW)
    assert exp == T0 + 900
    prefix, body, mac = code.split(".")
    assert prefix == "c1"
    payload = payload_of(code)
    assert list(payload) == ["r", "j", "e"]
    assert payload["r"] == world.directory.ref(auth.telegram_principal(ALICE))
    assert len(unb64(payload["j"])) == 16
    assert payload["e"] == exp
    assert unb64(body) == compact(payload)
    assert unb64(mac) == hmac.new(world.keys.code, f"c1.{body}".encode(), hashlib.sha256).digest()
    assert re.fullmatch(r"c1\.[A-Za-z0-9_-]{20,200}\.[A-Za-z0-9_-]{43}", code)  # the page's `vc` (§7.1)
    assert str(ALICE) not in unb64(body).decode()
    assert world.code() != world.code()


def test_a_code_is_issued_only_for_an_allowed_chat(world):
    with pytest.raises(auth.AuthError) as err:
        world.codes.issue(auth.telegram_principal(STRANGER), NOW)
    assert err.value.code == "forbidden"


def test_a_code_buys_its_principal(world):
    assert world.codes.kind == "tg_link"
    assert world.codes.verify(world.code(BOB), NOW) == auth.telegram_principal(BOB)


def test_a_code_works_once(world):
    code = world.code()
    world.codes.verify(code, NOW)
    assert code_error(world, code, at(1)) == "credential_used"


def test_a_code_expires_at_its_exp_and_an_expired_try_does_not_consume_it(world):
    code = world.code()
    assert code_error(world, code, at(900)) == "auth_expired"
    assert world.codes.verify(code, at(899)) == auth.telegram_principal(ALICE)


def test_every_malformed_or_forged_code_is_unauthenticated(world):
    good = good_code_payload(world)
    assert world.codes.verify(sign("c1", world.keys.code, compact(good)), NOW)  # the baseline is valid
    for name, token in _token_mutations("c1", world.keys.code, world.keys.session, good).items():
        assert code_error(world, token) == "unauthenticated", name
    for token in (None, b"c1.x.y", 7):
        assert code_error(world, token) == "unauthenticated"


@pytest.mark.parametrize(
    "change",
    [
        {"e": True},
        {"e": str(T0 + 900)},
        {"e": float(T0 + 900)},
        {"e": -1},
        {"e": 2**53},
        {"e": None},
        {"r": 1},
        {"r": "a" * 21},
        {"r": "a" * 23},
        {"r": "!" * 22},
        {"j": 1},
        {"j": "a" * 21},
        {"j": "a" * 23},
        {"j": True},
    ],
)
def test_a_code_with_a_wrong_type_is_unauthenticated_even_when_correctly_signed(world, change):
    token = sign("c1", world.keys.code, compact({**good_code_payload(world), **change}))
    assert code_error(world, token) == "unauthenticated"


def test_a_code_for_a_chat_that_left_the_allowlist_is_forbidden(world):
    code = world.code(ALICE)
    assert code_error(World(allowed=frozenset({BOB})), code) == "forbidden"


def test_the_authorizer_is_asked_at_redemption_and_a_refusal_does_not_consume(world):
    used = auth.UsedSet()
    nobody = auth.LinkCodes(world.keys, world.directory, auth.AllowedChats(frozenset()), used, ttl_s=900)
    everybody = auth.LinkCodes(world.keys, world.directory, world.authorizer, used, ttl_s=900)
    code = everybody.issue(auth.telegram_principal(ALICE), NOW)[0]
    with pytest.raises(auth.AuthError) as err:
        nobody.verify(code, NOW)
    assert err.value.code == "forbidden"
    assert len(used) == 0
    assert everybody.verify(code, NOW) == auth.telegram_principal(ALICE)


def test_a_forged_copy_does_not_consume_the_real_code(world):
    code = world.code()
    head, body, mac = code.split(".")
    flipped = bytearray(unb64(mac))
    flipped[-1] ^= 0x80
    assert code_error(world, f"{head}.{body}.{b64(bytes(flipped))}") == "unauthenticated"
    assert world.codes.verify(code, NOW) == auth.telegram_principal(ALICE)


def test_a_code_redeemed_by_many_threads_at_once_is_worth_one_session(world):
    code = world.code()
    world.codes.used._seen = _SlowDict()
    outcomes = _race(lambda: world.codes.verify(code, NOW))
    assert sorted(outcomes) == ["credential_used"] * 15 + ["ok"]


async def test_a_code_redeemed_by_many_tasks_at_once_is_worth_one_session(world):
    code = world.code()
    outcomes = await _gather(lambda: world.codes.verify(code, NOW))
    assert sorted(outcomes) == ["credential_used"] * 15 + ["ok"]


def test_the_mac_is_checked_before_the_payload_is_decoded_or_parsed(world, monkeypatch):
    forged_code = sign("c1", world.keys.session, compact(good_code_payload(world)))
    forged_session = sign("s1", world.keys.code, compact(good_code_payload(world)))

    def must_not_run(*_args: object) -> object:
        raise AssertionError("content parsed before the MAC was verified")

    monkeypatch.setattr(auth, "strict_json_object", must_not_run)
    assert code_error(world, forged_code) == "unauthenticated"
    with pytest.raises(auth.AuthError):
        world.sessions.verify(forged_session, "voice", NOW)


def test_macs_are_compared_in_constant_time(world, monkeypatch):
    calls: list[int] = []
    real = hmac.compare_digest

    def spy(a, b):
        calls.append(1)
        return real(a, b)

    monkeypatch.setattr(auth.hmac, "compare_digest", spy)
    checks = [
        lambda: world.codes.verify(sign("c1", world.keys.session, b"{}"), NOW),
        lambda: world.sessions.verify(sign("s1", world.keys.code, b"{}"), "voice", NOW),
        lambda: world.init_data.verify(init_data(token="456:OTHER"), NOW),
    ]
    for check in checks:
        calls.clear()
        with pytest.raises(auth.AuthError):
            check()
        assert calls, "the MAC was not compared with hmac.compare_digest"
    calls.clear()
    world.directory.resolve("telegram", "a" * 22)
    assert len(calls) == 2  # every allowed id is compared, with no early exit


# --- Telegram initData (§6.7) ----------------------------------------------------------------------


def init_hash(fields: dict[str, str], token: str = BOT_TOKEN) -> str:
    check = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret_key = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    return hmac.new(secret_key, check.encode(), hashlib.sha256).hexdigest()


def encode_pairs(pairs: list[tuple[str, str]]) -> str:
    return "&".join(f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in pairs)


def init_data(
    user: object = None,
    auth_date: object = T0,
    token: str = BOT_TOKEN,
    extra: dict[str, str] | None = None,
    raw_user: str | None = None,
    drop: str | None = None,
) -> str:
    """A correctly signed initData for whatever fields it is given, however wrong they are."""
    user = {"id": ALICE, "first_name": "Ana Müller"} if user is None else user
    fields = {
        "query_id": "AAF" + secrets.token_hex(4),
        "user": raw_user if raw_user is not None else json.dumps(user, separators=(",", ":")),
        "auth_date": str(auth_date),
        **(extra or {}),
    }
    if drop:
        del fields[drop]
    return encode_pairs([*fields.items(), ("hash", init_hash(fields, token))])


def init_error(world: World, credential: Any, now: datetime = NOW) -> str:
    with pytest.raises(auth.AuthError) as err:
        world.init_data.verify(credential, now)
    return err.value.code


def test_valid_init_data_gives_the_user_as_principal(world):
    assert world.init_data.kind == "tg_init_data"
    principal = world.init_data.verify(init_data(), NOW)
    assert principal == auth.Principal("telegram", str(ALICE), ALICE, frozenset({"voice"}))


def test_init_data_is_checked_with_telegrams_own_algorithm(world):
    """A vector written out by hand: fixed fields, the hash computed step by step as the Bot API says."""
    user = '{"id":1002}'
    secret_key = hmac.new(b"WebAppData", b"123:TEST", hashlib.sha256).digest()
    digest = hmac.new(secret_key, f"auth_date={T0}\nuser={user}".encode(), hashlib.sha256).hexdigest()
    credential = f"user=%7B%22id%22%3A1002%7D&auth_date={T0}&hash={digest}"
    assert world.init_data.verify(credential, NOW).chat_id == BOB


def test_tampered_init_data_is_unauthenticated(world):
    good = init_data()
    assert init_error(world, good.replace(str(ALICE), str(BOB))) == "unauthenticated"
    assert init_error(world, good.replace(f"auth_date={T0}", f"auth_date={T0 + 1}")) == "unauthenticated"
    assert init_error(world, good + "&extra=1") == "unauthenticated"


def test_init_data_signed_with_another_bot_token_is_unauthenticated(world):
    assert init_error(world, init_data(token="456:OTHER")) == "unauthenticated"


def test_init_data_expires_after_300_seconds_and_an_expired_try_does_not_consume_it(world):
    credential = init_data()
    assert init_error(world, credential, at(301)) == "auth_expired"
    assert world.init_data.verify(credential, at(300)).chat_id == ALICE


def test_init_data_from_the_future_is_unauthenticated(world):
    assert init_error(world, init_data(auth_date=T0 + 61)) == "unauthenticated"
    assert world.init_data.verify(init_data(auth_date=T0 + 60), NOW).chat_id == ALICE


def test_init_data_with_a_repeated_key_is_unauthenticated_however_it_is_signed(world):
    user = json.dumps({"id": ALICE})
    other = json.dumps({"id": BOB})
    for signed in (user, other):
        fields = {"auth_date": str(T0), "user": signed}
        pairs = [("auth_date", str(T0)), ("user", user), ("user", other), ("hash", init_hash(fields))]
        assert init_error(world, encode_pairs(pairs)) == "unauthenticated"
    once = init_data()
    assert init_error(world, once + "&" + once.rsplit("&", 1)[1]) == "unauthenticated"  # two hashes


@pytest.mark.parametrize("value", ["12a", "-5", " 5", "+5", "", "١٢٣٤٥٦٧٨٩٠", "1.5", "1e9", "9" * 13])
def test_init_data_with_an_auth_date_that_is_not_plain_digits_is_unauthenticated(world, value):
    assert init_error(world, init_data(auth_date=value)) == "unauthenticated"


@pytest.mark.parametrize(
    "user",
    [
        {"id": True},
        {"id": str(ALICE)},
        {"id": float(ALICE)},
        {"id": 0},
        {"id": -ALICE},
        {"id": None},
        {"id": 2**53},
        {"first_name": "x"},
        [ALICE],
        ALICE,
    ],
)
def test_init_data_with_a_user_id_that_is_not_a_positive_integer_is_unauthenticated(world, user):
    assert init_error(world, init_data(user=user)) == "unauthenticated"


def test_init_data_whose_user_has_duplicate_keys_or_is_not_json_is_unauthenticated(world):
    assert init_error(world, init_data(raw_user=f'{{"id":{BOB},"id":{ALICE}}}')) == "unauthenticated"
    assert init_error(world, init_data(raw_user="not json")) == "unauthenticated"


@pytest.mark.parametrize("missing", ["user", "auth_date"])
def test_init_data_without_a_required_field_is_unauthenticated(world, missing):
    assert init_error(world, init_data(drop=missing)) == "unauthenticated"


def test_init_data_with_a_malformed_hash_or_shape_is_unauthenticated(world):
    good = init_data()
    body, digest = good.rsplit("&hash=", 1)
    assert world.init_data.verify(f"hash={digest}&{body}", NOW)  # the order of the pairs is free
    bad = [
        body,  # no hash
        f"{body}&hash={digest.upper()}",
        f"{body}&hash={digest[:-1]}",
        f"{body}&hash={digest}0",
        f"{body}&hash={digest[:-1]}g",
        f"{body}&hash={digest}&",  # empty pair
        f"{body}&novalue&hash={digest}",  # no "="
        f"{body}&hash={digest}\n",
        "",
        "hash=" + "0" * 64,
    ]
    for credential in bad:
        assert init_error(world, credential) == "unauthenticated", credential[-80:]
    for credential in (None, good.encode(), 7):
        assert init_error(world, credential) == "unauthenticated"


def test_init_data_longer_than_4096_or_not_utf8_is_unauthenticated(world):
    assert init_error(world, init_data(extra={"pad": "x" * 4096})) == "unauthenticated"
    fields = {"auth_date": str(T0), "user": json.dumps({"id": ALICE}), "start_param": "�"}
    credential = encode_pairs([*fields.items(), ("hash", init_hash(fields))])
    assert world.init_data.verify(credential, NOW)
    assert init_error(world, credential.replace("%EF%BF%BD", "%FF")) == "unauthenticated"


def test_init_data_is_verified_before_its_user_is_parsed(world, monkeypatch):
    forged = init_data(token="456:OTHER")

    def must_not_run(*_args: object) -> object:
        raise AssertionError("content parsed before the hash was verified")

    monkeypatch.setattr(auth, "strict_json_object", must_not_run)
    assert init_error(world, forged) == "unauthenticated"


def test_init_data_works_once_until_its_last_second(world):
    credential = init_data()
    world.init_data.verify(credential, NOW)
    assert init_error(world, credential, at(1)) == "credential_used"
    world.init_data.verify(init_data(), at(300))  # another exchange, which prunes what has expired
    assert init_error(world, credential, at(300)) == "credential_used"


def test_init_data_of_a_stranger_is_forbidden_and_not_consumed(world):
    used = auth.UsedSet()
    closed = auth.TelegramInitData(BOT_TOKEN, auth.AllowedChats(frozenset()), used, max_age_s=300)
    opened = auth.TelegramInitData(BOT_TOKEN, world.authorizer, used, max_age_s=300)
    credential = init_data()
    with pytest.raises(auth.AuthError) as err:
        closed.verify(credential, NOW)
    assert err.value.code == "forbidden"
    assert len(used) == 0
    assert opened.verify(credential, NOW).chat_id == ALICE


def test_init_data_redeemed_by_many_threads_at_once_is_worth_one_session(world):
    credential = init_data()
    world.init_data.used._seen = _SlowDict()
    outcomes = _race(lambda: world.init_data.verify(credential, NOW))
    assert sorted(outcomes) == ["credential_used"] * 15 + ["ok"]


async def test_init_data_redeemed_by_many_tasks_at_once_is_worth_one_session(world):
    credential = init_data()
    outcomes = await _gather(lambda: world.init_data.verify(credential, NOW))
    assert sorted(outcomes) == ["credential_used"] * 15 + ["ok"]


def test_a_blank_bot_token_cannot_build_the_provider(world):
    with pytest.raises(ValueError):
        auth.TelegramInitData(" ", world.authorizer, max_age_s=300)


# --- session token (§6.6) --------------------------------------------------------------------------


def good_session_payload(world: World, chat_id: int = ALICE, iat: int = T0, **change: object) -> dict:
    ref = world.directory.ref(auth.telegram_principal(chat_id))
    payload = {
        "p": "telegram",
        "r": ref,
        "s": b64(secrets.token_bytes(12)),
        "i": iat,
        "e": iat + 43_200,
        "c": ["voice"],
    }
    return {**payload, **change}


def session_error(world: World, token: Any, now: datetime = NOW, scope: str = "voice") -> str:
    with pytest.raises(auth.AuthError) as err:
        world.sessions.verify(token, scope, now)
    return err.value.code


def test_a_session_has_the_format_of_the_spec(world):
    token, exp = world.sessions.issue(auth.telegram_principal(ALICE), NOW)
    assert exp == T0 + 43_200
    prefix, body, mac = token.split(".")
    payload = payload_of(token)
    assert prefix == "s1"
    assert list(payload) == ["p", "r", "s", "i", "e", "c"]
    assert payload["p"] == "telegram"
    assert payload["r"] == world.directory.ref(auth.telegram_principal(ALICE))
    assert len(unb64(payload["s"])) == 12
    assert (payload["i"], payload["e"], payload["c"]) == (T0, exp, ["voice"])
    assert unb64(body) == compact(payload)
    assert unb64(mac) == hmac.new(world.keys.session, f"s1.{body}".encode(), hashlib.sha256).digest()
    assert len(token) <= 512
    assert str(ALICE) not in unb64(body).decode()
    assert world.session() != world.session()


def test_a_session_verifies_to_its_own_principal(world):
    assert world.sessions.verify(world.session(ALICE), "voice", at(60)) == auth.telegram_principal(ALICE)
    assert world.sessions.verify(world.session(BOB), "voice", at(60)) == auth.telegram_principal(BOB)


def test_a_session_expires_after_twelve_hours(world):
    token = world.session()
    assert world.sessions.verify(token, "voice", at(43_199))
    assert session_error(world, token, at(43_200)) == "auth_expired"


def test_a_session_issued_in_the_future_is_unauthenticated(world):
    assert world.sessions.verify(world.session(now=at(60)), "voice", NOW)
    assert session_error(world, world.session(now=at(61))) == "unauthenticated"


def test_every_malformed_or_forged_session_is_unauthenticated(world):
    good = good_session_payload(world)
    assert world.sessions.verify(sign("s1", world.keys.session, compact(good)), "voice", NOW)
    cases = _token_mutations("s1", world.keys.session, world.keys.code, good)
    cases["mac made with another secret"] = sign("s1", auth.derive_keys(OTHER_SECRET).session, compact(good))
    for name, token in cases.items():
        assert session_error(world, token) == "unauthenticated", name
    for token in (None, b"s1.x.y", 7):
        assert session_error(world, token) == "unauthenticated"


@pytest.mark.parametrize(
    "change",
    [
        {"e": True},
        {"i": True},
        {"i": False},
        {"e": str(T0 + 43_200)},
        {"i": float(T0)},
        {"e": float(T0 + 43_200)},
        {"i": -1},
        {"e": 2**53},
        {"p": 1},
        {"p": ""},
        {"p": "t" * 33},
        {"r": None},
        {"r": "a" * 23},
        {"r": "é" * 22},
        {"s": 1},
        {"s": "a" * 17},
        {"c": "voice"},
        {"c": []},
        {"c": ["admin"]},
        {"c": ["voice", "admin"]},
        {"c": ["voice", "voice"]},
        {"c": [True]},
        {"c": {"voice": 1}},
    ],
)
def test_a_session_with_a_wrong_type_is_unauthenticated_even_when_correctly_signed(world, change):
    token = sign("s1", world.keys.session, compact(good_session_payload(world, **change)))
    assert session_error(world, token) == "unauthenticated"


def test_a_code_or_init_data_is_not_an_api_credential_and_a_session_is_not_a_code(world):
    assert session_error(world, world.code()) == "unauthenticated"
    assert session_error(world, init_data()) == "unauthenticated"
    assert code_error(world, world.session()) == "unauthenticated"
    # the same payload under another sub-key: only the key separation stops it
    payload = compact(good_session_payload(world))
    assert session_error(world, sign("s1", world.keys.code, payload)) == "unauthenticated"
    assert session_error(world, sign("s1", world.keys.ref, payload)) == "unauthenticated"
    assert code_error(world, sign("c1", world.keys.session, compact(good_code_payload(world)))) == (
        "unauthenticated"
    )


def test_a_session_does_not_grant_a_scope_it_was_not_issued_for(world):
    assert session_error(world, world.session(), scope="write") == "forbidden"
    assert session_error(world, world.session(), scope="") == "forbidden"


def test_removing_a_chat_from_the_allowlist_revokes_its_sessions_at_once(world):
    alice, bob = world.session(ALICE), world.session(BOB)
    later = World(allowed=frozenset({BOB}))
    assert session_error(later, alice) == "forbidden"
    assert later.sessions.verify(bob, "voice", NOW) == auth.telegram_principal(BOB)


def test_the_authorizer_is_asked_on_every_request(world):
    token = world.session()
    strict = auth.Sessions(
        world.keys, world.directory, auth.AllowedChats(frozenset({BOB})), world.revocations, ttl_s=43_200
    )
    with pytest.raises(auth.AuthError) as err:
        strict.verify(token, "voice", NOW)
    assert err.value.code == "forbidden"


def test_not_before_revokes_the_sessions_one_person_got_earlier(world):
    old_alice, old_bob = world.session(ALICE), world.session(BOB)
    revoked = World(not_before={ALICE: T0 + 10})
    assert session_error(revoked, old_alice, at(20)) == "auth_expired"
    assert revoked.sessions.verify(old_bob, "voice", at(20)) == auth.telegram_principal(BOB)
    assert revoked.sessions.verify(revoked.session(ALICE, at(10)), "voice", at(20))
    assert session_error(revoked, revoked.session(ALICE, at(9)), at(20)) == "auth_expired"


def test_a_session_is_bound_to_the_account_of_its_ref(world):
    # a correctly signed session for a ref nobody allowed has, or for another provider
    stranger_ref = world.directory.ref(auth.telegram_principal(STRANGER))
    forged = good_session_payload(world, r=stranger_ref)
    assert session_error(world, sign("s1", world.keys.session, compact(forged))) == "forbidden"
    elsewhere = good_session_payload(world, p="pwa")
    assert session_error(world, sign("s1", world.keys.session, compact(elsewhere))) == "forbidden"
    # swapping the ref inside a real token, to act as the other account, breaks its MAC
    token = world.session(ALICE)
    head, _body, mac = token.split(".")
    as_bob = {**payload_of(token), "r": world.directory.ref(auth.telegram_principal(BOB))}
    assert session_error(world, f"{head}.{b64(compact(as_bob))}.{mac}") == "unauthenticated"
    # and each account's session resolves to that account, whatever the order of the allowlist
    for chat_id in (ALICE, BOB):
        assert world.sessions.verify(world.session(chat_id), "voice", NOW).chat_id == chat_id


def test_a_session_cannot_be_issued_with_an_unknown_scope_or_a_naive_clock(world):
    odd = auth.Principal("telegram", str(ALICE), ALICE, frozenset({"voice", "admin"}))
    with pytest.raises(ValueError):
        world.sessions.issue(odd, NOW)
    with pytest.raises(ValueError):
        world.sessions.issue(auth.telegram_principal(ALICE), NOW.replace(tzinfo=None))


# --- the exchange (§6.7, without HTTP) -------------------------------------------------------------


def body(**fields: object) -> bytes:
    return compact(fields)


def test_the_exchange_turns_a_code_into_a_session_bound_to_the_ref(world):
    code = world.code(ALICE)
    grant = world.sign_in.handle(body(v=1, kind="tg_link", credential=code), NOW)
    assert grant.expires_at == T0 + 43_200
    assert grant.scopes == ("voice",)
    assert grant.ref == world.directory.ref(auth.telegram_principal(ALICE))
    assert grant.ref == payload_of(code)["r"]  # what the page compares (§7.2)
    assert world.sessions.verify(grant.session, "voice", at(5)) == auth.telegram_principal(ALICE)
    assert grant.session not in repr(grant)


def test_the_exchange_turns_init_data_into_a_session(world):
    grant = world.sign_in.handle(body(v=1, kind="tg_init_data", credential=init_data()), NOW)
    assert grant.ref == world.directory.ref(auth.telegram_principal(ALICE))
    assert world.sessions.verify(grant.session, "voice", NOW).chat_id == ALICE


def test_the_exchange_gives_one_session_per_code(world):
    request = body(v=1, kind="tg_link", credential=world.code())
    world.sign_in.handle(request, NOW)
    with pytest.raises(auth.AuthError) as err:
        world.sign_in.handle(request, NOW)
    assert err.value.code == "credential_used"


def test_the_exchange_under_many_threads_gives_one_session_per_code(world):
    request = body(v=1, kind="tg_link", credential=world.code())
    world.codes.used._seen = _SlowDict()
    outcomes = _race(lambda: world.sign_in.handle(request, NOW))
    assert sorted(outcomes) == ["credential_used"] * 15 + ["ok"]


def test_a_credential_is_only_read_by_the_provider_of_its_kind(world):
    for kind, credential in (("tg_init_data", world.code()), ("tg_link", init_data())):
        with pytest.raises(auth.AuthError) as err:
            world.sign_in.handle(body(v=1, kind=kind, credential=credential), NOW)
        assert err.value.code == "unauthenticated"


def test_a_credential_with_a_lone_surrogate_is_refused_and_does_not_crash(world):
    escaped = b"\\" + b"ud800"  # the JSON escape of a lone surrogate
    for kind in (b"tg_link", b"tg_init_data"):
        raw = b'{"v":1,"kind":"' + kind + b'","credential":"user=' + escaped + b'&auth_date=1&hash=0"}'
        with pytest.raises(auth.AuthError) as err:
            world.sign_in.handle(raw, NOW)
        assert err.value.code == "unauthenticated"
    lone = "user=" + chr(0xD800) + "&auth_date=1&hash=" + "0" * 64
    assert init_error(world, lone) == "unauthenticated"


CODE = "c1.x.y"


@pytest.mark.parametrize(
    "raw",
    [
        body(v=True, kind="tg_link", credential=CODE),
        body(v="1", kind="tg_link", credential=CODE),
        b'{"v":1.0,"kind":"tg_link","credential":"c1.x.y"}',
        b'{"v":1e0,"kind":"tg_link","credential":"c1.x.y"}',
        body(v=2, kind="tg_link", credential=CODE),
        body(v=0, kind="tg_link", credential=CODE),
        body(v=None, kind="tg_link", credential=CODE),
        body(v=[1], kind="tg_link", credential=CODE),
        body(kind="tg_link", credential=CODE),
        body(v=1, credential=CODE),
        body(v=1, kind="tg_link"),
        body(v=1, kind="tg_link", credential=CODE, extra=1),
        body(v=1, kind=1, credential=CODE),
        body(v=1, kind=True, credential=CODE),
        body(v=1, kind=["tg_link"], credential=CODE),
        body(v=1, kind="magic_link", credential=CODE),
        body(v=1, kind="TG_LINK", credential=CODE),
        body(v=1, kind="tg_link", credential=""),
        body(v=1, kind="tg_link", credential=1),
        body(v=1, kind="tg_link", credential=None),
        body(v=1, kind="tg_link", credential=[CODE]),
        body(v=1, kind="tg_link", credential={"c": CODE}),
        b'{"v":1,"kind":"tg_link","credential":"a","credential":"c1.x.y"}',
        b'{"v":1,"v":1,"kind":"tg_link","credential":"c1.x.y"}',
        b'[1,"tg_link","c1.x.y"]',
        b'"tg_link"',
        b"",
        b"{",
        b'{"v":1,"kind":"tg_link","credential":"\xff"}',
        body(v=1, kind="tg_link", credential="x" * 4096),  # the body is over 4 KB
    ],
)
def test_a_request_that_is_not_exactly_the_contract_is_a_bad_request(world, raw):
    with pytest.raises(auth.BadRequest) as err:
        world.sign_in.handle(raw, NOW)
    assert err.value.code == "bad_request"


def test_a_well_formed_request_reaches_the_provider(world):
    """The baseline of the cases above: the same shape with the right types is not a bad request."""
    with pytest.raises(auth.AuthError) as err:
        world.sign_in.handle(body(v=1, kind="tg_link", credential=CODE), NOW)
    assert err.value.code == "unauthenticated"
    with pytest.raises(auth.BadRequest):
        world.sign_in.handle("not bytes", NOW)


def test_a_request_of_exactly_4_kb_is_read_and_one_byte_more_is_not(world):
    frame = len(body(v=1, kind="tg_link", credential=""))
    with pytest.raises(auth.AuthError):
        world.sign_in.handle(body(v=1, kind="tg_link", credential="x" * (4096 - frame)), NOW)
    with pytest.raises(auth.BadRequest):
        world.sign_in.handle(body(v=1, kind="tg_link", credential="x" * (4097 - frame)), NOW)


def test_exchange_refuses_a_credential_over_4096_characters_and_a_disabled_kind(world):
    with pytest.raises(auth.BadRequest):
        world.sign_in.exchange("tg_link", "x" * 4097, NOW)
    with pytest.raises(auth.AuthError):
        world.sign_in.exchange("tg_link", "x" * 4096, NOW)
    link_only = auth.SignIn([world.codes], world.sessions)  # no TELEGRAM_BOT_TOKEN: no initData
    assert link_only.kinds == frozenset({"tg_link"})
    with pytest.raises(auth.BadRequest):
        link_only.handle(body(v=1, kind="tg_init_data", credential=init_data()), NOW)


def test_two_providers_of_one_kind_cannot_be_registered(world):
    with pytest.raises(ValueError):
        auth.SignIn([world.codes, world.codes], world.sessions)


class _PwaProvider:
    """What a later sign-in (PWA magic link, native login) plugs in: nothing of Telegram."""

    kind = "test"

    def verify(self, credential: str, now: datetime) -> auth.Principal:
        if credential != "let-me-in":
            raise auth.AuthError("unauthenticated")
        return auth.Principal("test", "u1", None, frozenset({"voice"}))


class _PwaDirectory:
    def ref(self, principal: auth.Principal) -> str:
        return ("ref-" + principal.subject).ljust(22, "x")

    def resolve(self, provider: str, ref: str) -> auth.Principal | None:
        if provider == "test" and ref == "ref-u1".ljust(22, "x"):
            return auth.Principal("test", "u1", None, frozenset({"voice"}))
        return None


class _Anyone:
    def allows(self, principal: auth.Principal, scope: str) -> bool:
        return principal.provider == "test"


def test_a_sign_in_outside_telegram_plugs_into_the_same_sessions(world):
    sessions = auth.Sessions(world.keys, _PwaDirectory(), _Anyone(), auth.ConfigRevocations({}), ttl_s=600)
    sign_in = auth.SignIn([_PwaProvider()], sessions)
    grant = sign_in.handle(body(v=1, kind="test", credential="let-me-in"), NOW)
    principal = sessions.verify(grant.session, "voice", NOW)
    assert principal == auth.Principal("test", "u1", None, frozenset({"voice"}))
    assert grant.expires_at == T0 + 600
    assert session_error(world, grant.session) == "forbidden"  # the Telegram directory does not know it
    with pytest.raises(auth.BadRequest):
        sign_in.handle(body(v=1, kind="tg_link", credential=world.code()), NOW)


# --- logs (§10) ------------------------------------------------------------------------------------


def test_nothing_is_logged_and_errors_carry_only_their_code(world, caplog):
    caplog.set_level(logging.DEBUG)
    code, session, credential = world.code(), world.session(), init_data()
    world.sign_in.handle(body(v=1, kind="tg_link", credential=code), NOW)
    world.sessions.verify(session, "voice", NOW)
    world.init_data.verify(credential, NOW)
    errors: list[auth.AuthError | auth.BadRequest] = []
    attempts = [
        lambda: world.codes.verify(code, NOW),
        lambda: world.codes.verify(sign("c1", world.keys.code, b'{"SENTINELA":'), NOW),
        lambda: world.codes.verify("c1.====.====", NOW),
        lambda: world.sessions.verify(session + "x", "voice", NOW),
        lambda: world.sessions.verify(session, "voice", at(50_000)),
        lambda: world.init_data.verify(credential, NOW),
        lambda: world.init_data.verify(init_data(raw_user="SENTINELA"), NOW),
        lambda: world.init_data.verify("user=%FF&auth_date=1&hash=" + "0" * 64, NOW),
        lambda: world.sign_in.handle(b'{"v":1,"kind":"tg_link","credential":"SENTINELA","x":', NOW),
    ]
    for attempt in attempts:
        try:
            attempt()
        except (auth.AuthError, auth.BadRequest) as err:
            errors.append(err)
    assert len(errors) == len(attempts)
    assert caplog.records == []
    allowed = ("unauthenticated", "auth_expired", "credential_used", "bad_request")
    for err in errors:
        assert err.args == (err.code,) and str(err) == err.code
        # nothing chained: a JSON error keeps the whole document in its `doc`
        assert err.__cause__ is None and err.__context__ is None
        assert logs.describe(err) in {f"agent.auth.{type(err).__name__}[code={c}]" for c in allowed}


def test_the_auth_module_does_no_logging_of_its_own():
    source = Path(auth.__file__).read_text(encoding="utf-8")
    assert "import logging" not in source and "print(" not in source


# --- settings --------------------------------------------------------------------------------------

AUTH_KEYS = (
    "APP_AUTH_SECRET",
    "APP_CODE_TTL_S",
    "APP_SESSION_TTL_S",
    "INITDATA_MAX_AGE_S",
    "APP_SESSION_NOT_BEFORE",
)


@pytest.fixture
def auth_env(monkeypatch, tmp_path):
    for key in AUTH_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.chdir(tmp_path)
    return monkeypatch


def load_auth_settings() -> AuthSettings:
    return AuthSettings(_env_file=None)  # type: ignore[call-arg]


def test_auth_settings_defaults_are_those_of_the_spec(auth_env):
    settings = load_auth_settings()
    assert settings.APP_AUTH_SECRET is None
    assert settings.APP_CODE_TTL_S == 900
    assert settings.APP_SESSION_TTL_S == 43_200
    assert settings.INITDATA_MAX_AGE_S == 300
    assert settings.APP_SESSION_NOT_BEFORE == {}
    assert "APP_AUTH_SECRET" in AuthSettings.AUTH_SECRETS


def test_auth_settings_read_the_environment(auth_env):
    auth_env.setenv("APP_AUTH_SECRET", SECRET)
    auth_env.setenv("APP_CODE_TTL_S", "600")
    auth_env.setenv("APP_SESSION_NOT_BEFORE", f" {ALICE}:{T0}, -{BOB}:5 ,")
    settings = load_auth_settings()
    assert settings.APP_AUTH_SECRET is not None
    assert settings.APP_AUTH_SECRET.get_secret_value() == SECRET
    assert SECRET not in repr(settings)
    assert settings.APP_CODE_TTL_S == 600
    assert settings.APP_SESSION_NOT_BEFORE == {ALICE: T0, -BOB: 5}
    auth.derive_keys(settings.APP_AUTH_SECRET.get_secret_value())


def test_a_blank_auth_secret_is_no_secret_and_a_short_one_is_refused(auth_env):
    auth_env.setenv("APP_AUTH_SECRET", "  ")
    assert load_auth_settings().APP_AUTH_SECRET is None
    auth_env.setenv("APP_AUTH_SECRET", "x" * 31)
    with pytest.raises(ValidationError):
        load_auth_settings()
    auth_env.setenv("APP_AUTH_SECRET", "é" * 16)  # 32 bytes
    assert load_auth_settings().APP_AUTH_SECRET is not None


@pytest.mark.parametrize("value", ["1001", "1001:", ":5", "1001:5:6", "abc:5", "1001:-5", "1001:5;1002:6"])
def test_a_malformed_not_before_is_refused_without_echoing_it(auth_env, value):
    auth_env.setenv("APP_SESSION_NOT_BEFORE", value)
    with pytest.raises(ValidationError) as err:
        load_auth_settings()
    assert "<chat_id>:<unix seconds>" in str(err.value)


def test_a_chat_listed_twice_in_not_before_keeps_the_later_time(auth_env):
    auth_env.setenv("APP_SESSION_NOT_BEFORE", f"{ALICE}:50,{ALICE}:90,{ALICE}:70")
    assert load_auth_settings().APP_SESSION_NOT_BEFORE == {ALICE: 90}


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("APP_CODE_TTL_S", "0"),
        ("APP_CODE_TTL_S", "86401"),
        ("APP_SESSION_TTL_S", "0"),
        ("APP_SESSION_TTL_S", "604801"),
        ("INITDATA_MAX_AGE_S", "0"),
        ("INITDATA_MAX_AGE_S", "3601"),
    ],
)
def test_lifetimes_out_of_range_are_refused(auth_env, name, value):
    auth_env.setenv(name, value)
    with pytest.raises(ValidationError):
        load_auth_settings()
