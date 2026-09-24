from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest
from flask import Request
from pydantic import SecretStr
from starlette.testclient import TestClient
from werkzeug.test import EnvironBuilder

from agent import asgi, main, reminder, webhook
from agent.settings import Settings

from .fakes import FakeSheet

pytestmark = pytest.mark.unit

TODAY = date(2026, 9, 24)
DOWN = {"ok": False, "errors": [{"path": "", "code": "unavailable", "message": "planilha fora"}]}
SETTINGS = Settings.model_construct(
    None,
    TELEGRAM_BOT_TOKEN=SecretStr("tok"),
    ALLOWED_CHAT_IDS=frozenset({42, 7}),
    SHEET_API_URL="https://x/exec",
    SHEET_API_KEY=SecretStr("k"),
    TELEGRAM_WEBHOOK_SECRET=SecretStr("sec"),
    REMINDER_TOKEN=SecretStr("rem"),
    TIMEZONE="America/Sao_Paulo",
)


class FakeTelegram:
    def __init__(self, failing: frozenset[int] = frozenset()) -> None:
        self.sent: list[tuple[int, str, bool]] = []
        self.failing = failing

    async def send_message(self, chat_id, text, *, html=False, reply_markup=None, reply_to=None):
        if chat_id in self.failing:
            raise RuntimeError("chat blocked the bot")
        self.sent.append((chat_id, text, html))
        return {"message_id": len(self.sent)}


def day(diary):
    return {"ok": True, "result": {"date": TODAY.isoformat(), "diary": diary, "workout": []}}


async def remind(kind, telegram=None, chats=(42,), **responses):
    sheet = FakeSheet(**responses)
    telegram = telegram or FakeTelegram()
    counts = await reminder.remind(kind, sheet, telegram, chats, TODAY)
    return counts, telegram.sent, sheet.calls


# ---- daily ---------------------------------------------------------------------------------


async def test_daily_lists_only_the_missing_fields_in_order():
    counts, sent, calls = await remind("daily", day_get=[day({"steps": 8000, "hunger": 3})])
    assert calls == [("day.get", {"date": "2026-09-24"})]
    assert counts == (1, 1)
    assert sent == [
        (42, "Faltou registrar hoje: peso, sono.\nÉ só mandar, por exemplo: peso 82,4, dormi 7h30", True)
    ]


async def test_daily_on_an_empty_day_asks_for_all_three():
    _, sent, _ = await remind("daily", day_get=[day({})])
    assert sent[0][1].startswith("Faltou registrar hoje: peso, sono, passos.\n")


async def test_daily_treats_blank_text_as_missing_and_any_value_as_recorded():
    _, sent, _ = await remind("daily", day_get=[day({"weightKg": "  ", "sleepH": "7h", "steps": 0})])
    assert sent[0][1].startswith("Faltou registrar hoje: peso.\n")


async def test_daily_sends_nothing_when_everything_is_there():
    counts, sent, _ = await remind("daily", day_get=[day({"weightKg": 82.4, "sleepH": 7.5, "steps": 8000})])
    assert (counts, sent) == ((0, 0), [])


@pytest.mark.parametrize("kind", ["daily", "weekly"])
async def test_a_sheet_failure_sends_nothing(kind, caplog):
    counts, sent, _ = await remind(kind, day_get=[DOWN], diary_range=[DOWN], workout_range=[DOWN])
    assert (counts, sent) == ((0, 0), [])
    assert "sheet failed" in caplog.text


async def test_one_failing_chat_does_not_stop_the_others(caplog):
    telegram = FakeTelegram(failing=frozenset({7}))
    counts, sent, _ = await remind("daily", telegram, chats=(42, 7, 99), day_get=[day({})])
    assert counts == (2, 3)
    assert [chat for chat, _, _ in sent] == [42, 99]
    assert "chat 7" in caplog.text


# ---- weekly --------------------------------------------------------------------------------


async def test_weekly_sends_the_summary_of_the_seven_days_ending_today():
    days = {"ok": True, "result": {"from": "", "to": "", "days": [{"date": "2026-09-22", "weightKg": 82}]}}
    rows = {"ok": True, "result": {"from": "", "to": "", "rows": []}}
    counts, sent, calls = await remind("weekly", chats=(42, 7), diary_range=[days], workout_range=[rows])
    assert calls == [
        ("diary.range", {"from": "2026-09-18", "to": "2026-09-24"}),
        ("workout.range", {"from": "2026-09-18", "to": "2026-09-24"}),
    ]
    assert counts == (2, 2)
    assert [chat for chat, _, _ in sent] == [7, 42]
    assert all(html for _, _, html in sent)
    assert "18/09" in sent[0][1] and "82" in sent[0][1]


async def test_weekly_splits_a_long_summary(monkeypatch):
    long = "\n".join(f"linha {i} " + "x" * 90 for i in range(100))

    async def fake_week_text(sheet, start, end):
        return reminder.Reply(long, html=True)

    monkeypatch.setattr(reminder, "week_text", fake_week_text)
    counts, sent, _ = await remind("weekly")
    assert counts == (1, 1)
    assert len(sent) == 3
    assert "\n".join(text for _, text, _ in sent) == long


async def test_deliver_uses_today_in_the_configured_timezone(monkeypatch):
    seen = {}

    async def fake_remind(kind, sheet, telegram, chat_ids, today):
        seen.update(kind=kind, chats=set(chat_ids), today=today)
        return 1, 1

    monkeypatch.setattr(reminder, "remind", fake_remind)

    def clock():
        return datetime(2026, 9, 24, 21, 0, tzinfo=ZoneInfo("America/Sao_Paulo"))

    assert await reminder.deliver(SETTINGS, "daily", clock) == (1, 1)
    assert seen == {"kind": "daily", "chats": {42, 7}, "today": TODAY}


# ---- HTTP ----------------------------------------------------------------------------------


@pytest.fixture
def delivered(monkeypatch):
    kinds: list[str] = []
    outcome = {"counts": (1, 1)}

    async def fake_deliver(settings, kind, clock=None):
        kinds.append(kind)
        return outcome["counts"]

    monkeypatch.setattr(webhook, "get_settings", lambda: SETTINGS)
    monkeypatch.setattr(reminder, "deliver", fake_deliver)
    return kinds, outcome


async def test_process_runs_the_kind_asked(delivered):
    kinds, _ = delivered
    assert await reminder.process("rem", {"kind": "weekly"}) == ("sent 1", 200)
    assert kinds == ["weekly"]


@pytest.mark.parametrize(
    ("counts", "expected"),
    [((0, 0), ("nothing to send", 200)), ((1, 2), ("sent 1 of 2", 200)), ((0, 2), ("sent 0 of 2", 502))],
)
async def test_process_reports_what_was_sent(delivered, counts, expected):
    delivered[1]["counts"] = counts
    assert await reminder.process("rem", {"kind": "daily"}) == expected


@pytest.mark.parametrize("token", ["nope", None, "", "sec"])
async def test_process_rejects_a_wrong_or_missing_token(delivered, token):
    assert await reminder.process(token, {"kind": "daily"}) == ("forbidden", 403)
    assert delivered[0] == []


@pytest.mark.parametrize("body", [None, [], {}, {"kind": "monthly"}, {"kind": ["daily"]}, "daily"])
async def test_process_rejects_a_bad_body(delivered, body):
    assert await reminder.process("rem", body) == (reminder.BAD_BODY, 400)
    assert delivered[0] == []


async def test_process_is_404_without_a_configured_token(delivered, monkeypatch):
    unset = SETTINGS.model_copy(update={"REMINDER_TOKEN": None})
    monkeypatch.setattr(webhook, "get_settings", lambda: unset)
    assert await reminder.process("rem", {"kind": "daily"}) == ("not found", 404)
    assert await reminder.process(None, {"kind": "daily"}) == ("not found", 404)
    assert delivered[0] == []


# ---- both servers give the same answers -----------------------------------------------------


def functions_framework_call(token, body):
    headers = {reminder.TOKEN_HEADER: token} if token is not None else {}
    environ = EnvironBuilder(path="/remind", method="POST", headers=headers, json=body).get_environ()
    return main.telegram_webhook(Request(environ))


def uvicorn_call(token, body):
    headers = {reminder.TOKEN_HEADER: token} if token is not None else {}
    response = TestClient(asgi.app).post("/remind", headers=headers, json=body)
    return response.text, response.status_code


@pytest.mark.parametrize("call", [functions_framework_call, uvicorn_call])
def test_both_entry_points_serve_remind(delivered, call, monkeypatch):
    assert call("rem", {"kind": "daily"}) == ("sent 1", 200)
    assert call("wrong", {"kind": "daily"}) == ("forbidden", 403)
    assert call(None, {"kind": "daily"}) == ("forbidden", 403)
    assert call("rem", {"kind": "hourly"}) == (reminder.BAD_BODY, 400)
    assert delivered[0] == ["daily"]
    unset = SETTINGS.model_copy(update={"REMINDER_TOKEN": None})
    monkeypatch.setattr(webhook, "get_settings", lambda: unset)
    assert call("rem", {"kind": "daily"}) == ("not found", 404)


def test_asgi_remind_with_a_body_that_is_not_json(delivered):
    response = TestClient(asgi.app).post("/remind", headers={reminder.TOKEN_HEADER: "rem"}, content=b"{no")
    assert (response.text, response.status_code) == (reminder.BAD_BODY, 400)


def test_remind_takes_only_post(delivered):
    assert TestClient(asgi.app).get("/remind").status_code == 405
    environ = EnvironBuilder(path="/remind", method="GET").get_environ()
    assert main.telegram_webhook(Request(environ))[1] == 405


def test_the_functions_entry_still_sends_other_paths_to_telegram(delivered, monkeypatch):
    seen = []

    async def fake_handle(settings, update):
        seen.append(update)

    monkeypatch.setattr(webhook, "handle_update", fake_handle)
    headers = [(webhook.SECRET_HEADER, "sec")]
    environ = EnvironBuilder(path="/", method="POST", headers=headers, json={"update_id": 1}).get_environ()
    assert main.telegram_webhook(Request(environ)) == ("ok", 200)
    assert seen == [{"update_id": 1}]
    assert delivered[0] == []
