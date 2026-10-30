from types import SimpleNamespace

import httpx
import pytest

from agent import poll
from agent.poll import poll_forever, poll_once
from agent.telegram import TelegramClient, TelegramError

pytestmark = pytest.mark.unit


class FakeTelegram:
    def __init__(self, updates):
        self.updates = updates
        self.offsets = []

    async def get_updates(self, offset=None, wait=50):
        self.offsets.append(offset)
        return self.updates


class FakeHandler:
    def __init__(self):
        self.seen = []

    async def handle_update(self, update):
        self.seen.append(update["update_id"])


async def test_handles_each_update_and_advances_the_offset():
    tg, handler = FakeTelegram([{"update_id": 10}, {"update_id": 11}]), FakeHandler()
    assert await poll_once(tg, handler, offset=None) == 12
    assert handler.seen == [10, 11]
    assert tg.offsets == [None]


async def test_keeps_the_offset_when_nothing_arrives():
    assert await poll_once(FakeTelegram([]), FakeHandler(), offset=12) == 12


class FlakyTelegram:
    """Answers each getUpdates from a script: an exception is raised, a list is returned."""

    def __init__(self, script):
        self.script = list(script)
        self.offsets = []

    async def get_updates(self, offset=None, wait=50):
        self.offsets.append(offset)
        step = self.script.pop(0)
        if isinstance(step, BaseException):
            raise step
        return step


async def test_a_network_failure_waits_longer_each_time_and_resets_after_a_success():
    request = httpx.Request("POST", "https://api.telegram.org/bot<token>/getUpdates")
    tg = FlakyTelegram(
        [
            httpx.ConnectError("no route", request=request),
            httpx.ReadTimeout("slow", request=request),
            [{"update_id": 20}],
            TelegramError("Bad Gateway"),
            [],
        ]
    )
    handler, waits = FakeHandler(), []

    async def sleep(seconds):
        waits.append(seconds)

    await poll_forever(tg, handler, sleep=sleep, rounds=5)
    assert handler.seen == [20]
    assert waits == [1, 2, 1]
    assert tg.offsets == [None, None, None, 21, 21]


async def test_the_wait_stops_growing_at_the_cap():
    request = httpx.Request("POST", "https://api.telegram.org/x")
    tg = FlakyTelegram([httpx.ConnectError("down", request=request)] * 7)
    waits = []

    async def sleep(seconds):
        waits.append(seconds)

    await poll_forever(tg, FakeHandler(), sleep=sleep, rounds=7, max_wait_s=8)
    assert waits == [1, 2, 4, 8, 8, 8, 8]


async def test_a_programming_error_still_stops_the_loop():
    tg = FlakyTelegram([KeyError("update_id")])

    async def sleep(seconds):
        raise AssertionError("must not wait")

    with pytest.raises(KeyError):
        await poll_forever(tg, FakeHandler(), sleep=sleep, rounds=1)


@pytest.mark.parametrize(
    ("code", "hint"),
    [(401, "TELEGRAM_BOT_TOKEN"), (404, "TELEGRAM_BOT_TOKEN"), (409, "set-webhook.sh delete")],
)
async def test_an_error_that_needs_action_stops_with_what_to_do(code, hint, caplog):
    error = TelegramError(f"getUpdates: HTTP {code} Conflict or Unauthorized", code)
    tg = FlakyTelegram([error])

    async def sleep(seconds):
        raise AssertionError("must not wait")

    with pytest.raises(TelegramError):
        await poll_forever(tg, FakeHandler(), sleep=sleep, rounds=3)
    assert f"HTTP {code}" in caplog.text
    assert hint in caplog.text


async def test_a_transient_error_is_logged_with_its_reason(caplog):
    tg = FlakyTelegram([TelegramError("getUpdates: HTTP 502 Bad Gateway", 502), []])

    async def sleep(seconds):
        pass

    await poll_forever(tg, FakeHandler(), sleep=sleep, rounds=2)
    assert "HTTP 502 Bad Gateway" in caplog.text


def telegram_answering(*responses):
    """A real TelegramClient over a transport that answers each request from `responses`."""
    queue = list(responses)

    def answer(request):
        return queue.pop(0)

    http = httpx.AsyncClient(transport=httpx.MockTransport(answer))
    return TelegramClient("123:token-for-tests", http)


async def test_a_404_that_is_not_telegrams_answer_is_retried():
    tg = telegram_answering(
        httpx.Response(404, text="<html>Not Found</html>"),
        httpx.Response(200, json={"ok": True, "result": [{"update_id": 5}]}),
    )
    handler, waits = FakeHandler(), []

    async def sleep(seconds):
        waits.append(seconds)

    await poll_forever(tg, handler, sleep=sleep, rounds=2)
    assert waits == [1]
    assert handler.seen == [5]


async def test_telegrams_own_404_stops_with_the_token_hint(caplog):
    tg = telegram_answering(
        httpx.Response(404, json={"ok": False, "error_code": 404, "description": "Not Found"})
    )

    async def sleep(seconds):
        raise AssertionError("must not wait")

    with pytest.raises(TelegramError):
        await poll_forever(tg, FakeHandler(), sleep=sleep, rounds=2)
    assert "TELEGRAM_BOT_TOKEN" in caplog.text


def run_main_raising(monkeypatch, error):
    async def run(settings):
        raise error

    monkeypatch.setattr(poll, "configure_logging", lambda: None)
    monkeypatch.setattr(
        poll.Settings, "load", classmethod(lambda cls: SimpleNamespace(LLM_MODEL="m", MAX_LLM_CALLS=1))
    )
    monkeypatch.setattr(poll, "run", run)
    poll.main()


def test_main_exits_with_1_when_telegram_needs_action(monkeypatch):
    with pytest.raises(SystemExit) as stopped:
        run_main_raising(monkeypatch, TelegramError("getUpdates: HTTP 409 Conflict", 409))
    assert stopped.value.code == 1


def test_main_lets_other_errors_through(monkeypatch):
    with pytest.raises(TelegramError):
        run_main_raising(monkeypatch, TelegramError("getUpdates: HTTP 502 Bad Gateway", 502))
    with pytest.raises(KeyError):
        run_main_raising(monkeypatch, KeyError("bug"))
