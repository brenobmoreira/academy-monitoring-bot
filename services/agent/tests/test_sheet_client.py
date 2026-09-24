import json

import httpx
import pytest

from agent.sheet_client import SheetClient

pytestmark = pytest.mark.unit

URL = "https://script.google.com/macros/s/x/exec"


def client(handler):
    return SheetClient(URL, "k", httpx.AsyncClient(transport=httpx.MockTransport(handler)))


async def test_posts_the_envelope_and_returns_the_body():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True, "result": {"row": 6}})

    res = await client(handler).upsert_diary("2026-09-21", {"weightKg": 82.4})
    assert seen["body"] == {
        "key": "k",
        "op": "diary.upsert",
        "args": {"date": "2026-09-21", "fields": {"weightKg": 82.4}},
    }
    assert res == {"ok": True, "result": {"row": 6}}


async def test_follows_the_apps_script_redirect():
    def handler(request):
        if request.url.host == "script.google.com":
            return httpx.Response(302, headers={"Location": "https://script.googleusercontent.com/echo?x=1"})
        return httpx.Response(200, json={"ok": True, "result": {}})

    assert (await client(handler).catalog())["ok"] is True


async def test_validation_errors_come_back_untouched():
    body = {"ok": False, "errors": [{"path": "args.date", "code": "invalid_date", "message": "m"}]}
    res = await client(lambda r: httpx.Response(200, json=body)).upsert_workout("x", "Upper", [])
    assert res == body


async def test_optional_arguments_are_omitted():
    seen = []

    def handler(request):
        seen.append(json.loads(request.content)["args"])
        return httpx.Response(200, json={"ok": True, "result": {}})

    c = client(handler)
    await c.upsert_workout("2026-09-21", "Upper", [{"name": "Leg press"}])
    await c.upsert_workout("2026-09-21", "Upper", [], phase="Regular")
    await c.exercise_history("Leg press")
    await c.exercise_history("Leg press", limit=3)
    assert seen == [
        {"date": "2026-09-21", "session": "Upper", "exercises": [{"name": "Leg press"}]},
        {"date": "2026-09-21", "session": "Upper", "exercises": [], "phase": "Regular"},
        {"name": "Leg press"},
        {"name": "Leg press", "limit": 3},
    ]


@pytest.mark.parametrize(
    ("response", "hint"),
    [
        (httpx.Response(500, text="boom"), "HTTP 500"),
        (httpx.Response(200, text="<html>Sign in</html>"), "não é JSON"),
    ],
)
async def test_bad_responses_become_unavailable_errors(response, hint):
    res = await client(lambda r: response).catalog()
    assert res["ok"] is False
    assert res["errors"][0]["code"] == "unavailable"
    assert hint in res["errors"][0]["message"]


async def test_transport_failures_become_unavailable_errors():
    def handler(request):
        raise httpx.ConnectError("down")

    res = await client(handler).catalog()
    assert res["errors"][0]["code"] == "unavailable"


async def test_undo_sends_the_write_id_only_when_given():
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"ok": True, "result": {}})

    c = client(handler)
    await c.undo()
    await c.undo("mfu3k2x09ab1")
    assert [(b["op"], b["args"]) for b in seen] == [
        ("write.undo", {}),
        ("write.undo", {"writeId": "mfu3k2x09ab1"}),
    ]
