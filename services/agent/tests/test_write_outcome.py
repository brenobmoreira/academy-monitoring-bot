"""The outcome contract of every mutating sheet call (spec §4.3.1-4.3.3, tests of §4.3.5 for C4c1).

Each scenario runs against a fake Web App behind httpx.MockTransport that **applies** the write to
an in-memory sheet before it fails, and serves a real 302 -> GET, so `follow_redirects=True` and
`response.history` are the ones of httpx.
"""

import json
import logging
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx
import pytest

from agent import miniapp
from agent.bot import SHEET_FAILED, WRITE_UNCERTAIN, Bot
from agent.commands import COMMANDS, Context
from agent.miniapp import Pending, PendingStore, handle, retry
from agent.sheet_client import (
    MUTATING_OPS,
    PRE_WRITE_CODES,
    SheetClient,
    request_id_scope,
    settle_write,
    write_outcome,
)
from agent.undo import UNDO_UNCERTAIN, undo_last, undo_run, undo_writes

from .fakes import ScriptedLlm, call, say
from .test_miniapp import FOOD, TODAY, raw

pytestmark = pytest.mark.unit

URL = "https://script.google.com/macros/s/x/exec"
ECHO = "https://script.googleusercontent.com/macros/echo?id=1"
OTHER = "https://other.example/exec"
TEXT_SENTINEL = "SENTINELA-TEXTO-91c2"
NOW = datetime(2026, 9, 21, 15, 0, tzinfo=ZoneInfo("America/Sao_Paulo"))
OK = {"ok": True, "result": {"date": "2026-09-21", "row": 6, "fields": {"weightKg": 82.4}, "writeId": "w1"}}


def body(payload, status=200):
    return lambda: httpx.Response(status, json=payload)


def status(code):
    return lambda: httpx.Response(code, text="refused")


def html():
    return httpx.Response(200, text="<html>Sign in</html>")


def redirect(code=302, to=ECHO):
    return lambda: httpx.Response(code, headers={"Location": to})


def refusal(*codes, **extra):
    errors = [{"path": "args", "code": c, "message": f"m {TEXT_SENTINEL}"} for c in codes]
    return {"ok": False, "errors": errors, **extra}


class WebApp:
    """The fake Apps Script deployment: a POST to /exec is applied to `rows` and then answered by
    `post` (one answer, or a queue of them); the redirect target is answered by `after`. An answer
    is a response factory or an exception to raise."""

    def __init__(self, post, after=None):
        self.post = post
        self.after = after
        self.rows = []
        self.seen = []

    def __call__(self, request):
        self.seen.append((request.method, request.url.host))
        if str(request.url) == URL:
            self.rows.append(json.loads(request.content))
            answer = self.post.pop(0) if isinstance(self.post, list) else self.post
        else:
            answer = self.after
        if isinstance(answer, Exception):
            raise answer
        assert answer is not None, "no answer scripted for this request"
        return answer()

    @property
    def posts(self):
        return [s for s in self.seen if s == ("POST", "script.google.com")]

    def client(self):
        return SheetClient(URL, "k", httpx.AsyncClient(transport=httpx.MockTransport(self)))


async def diary(app):
    return await app.client().upsert_diary("2026-09-21", {"weightKg": 82.4})


def code_of(response):
    return [e["code"] for e in response["errors"]]


# ---- §4.3.1 transport ------------------------------------------------------------------------

NOT_SENT = [httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout, httpx.UnsupportedProtocol]
MAYBE_SENT = [
    httpx.ReadTimeout,
    httpx.WriteTimeout,
    httpx.ReadError,
    httpx.WriteError,
    httpx.RemoteProtocolError,
    httpx.CloseError,
]


@pytest.mark.parametrize("via_redirect", [False, True])
async def test_a_200_with_the_envelope_is_classified_by_its_body(via_redirect):
    app = WebApp(redirect(), body(OK)) if via_redirect else WebApp(body(OK))
    response = await diary(app)
    assert response == OK and write_outcome(response) == "committed"
    assert len(app.rows) == 1


@pytest.mark.parametrize("error", NOT_SENT)
async def test_no_connection_on_the_original_post_is_not_committed(error):
    response = await diary(WebApp(error("down")))
    assert write_outcome(response) == "not_committed"
    assert code_of(response) == ["unavailable"]


@pytest.mark.parametrize("code", [400, 401, 403, 404, 405, 413, 414, 415])
async def test_a_front_end_refusal_of_the_original_post_is_not_committed(code):
    response = await diary(WebApp(status(code)))
    assert write_outcome(response) == "not_committed"
    assert code_of(response) == ["unavailable"]


AFTER_REDIRECT = {
    "get 403": status(403),
    "get 404": status(404),
    "get 500": status(500),
    "get 400": status(400),
    "get 200 html": html,
    "get 200 json without ok": body({"result": {}}),
    "connect error on the get": httpx.ConnectError("down"),
    "connect timeout on the get": httpx.ConnectTimeout("down"),
    "read timeout on the get": httpx.ReadTimeout("slow"),
}


@pytest.mark.parametrize("after", AFTER_REDIRECT.values(), ids=AFTER_REDIRECT.keys())
async def test_any_failure_after_the_redirect_is_uncertain(after):
    app = WebApp(redirect(), after)
    response = await diary(app)
    assert write_outcome(response) == "uncertain"
    assert code_of(response) == ["write_uncertain"]
    assert app.seen == [("POST", "script.google.com"), ("GET", "script.googleusercontent.com")]
    assert len(app.rows) == 1  # the write was applied: "nothing saved" would be false


@pytest.mark.parametrize("after", [status(403), httpx.ConnectError("down")], ids=["403", "connect error"])
async def test_a_redirect_that_keeps_the_post_method_is_still_a_redirect(after):
    # 307 repeats the POST elsewhere: the failing request is a POST, but not the original one.
    app = WebApp(redirect(307, OTHER), after)
    response = await diary(app)
    assert app.seen == [("POST", "script.google.com"), ("POST", "other.example")]
    assert write_outcome(response) == "uncertain"


@pytest.mark.parametrize("error", MAYBE_SENT)
async def test_any_other_exception_on_the_original_post_is_uncertain(error):
    app = WebApp(error("lost"))
    response = await diary(app)
    assert write_outcome(response) == "uncertain"
    assert code_of(response) == ["write_uncertain"]
    assert len(app.posts) == 1


class NoRequestHttp:
    async def post(self, *args, **kwargs):
        raise httpx.ConnectError("down")  # no request attached: which one failed is unknown


async def test_an_exception_that_names_no_request_is_uncertain():
    response = await SheetClient(URL, "k", NoRequestHttp()).upsert_diary("2026-09-21", {})  # ty: ignore[invalid-argument-type]
    assert write_outcome(response) == "uncertain"


@pytest.mark.parametrize("code", [408, 429, 500, 502, 503, 504, 418, 409, 302])
async def test_any_unlisted_status_on_the_original_post_is_uncertain(code):
    response = await diary(WebApp(status(code)))  # 302 here has no Location: not followed
    assert write_outcome(response) == "uncertain"
    assert code_of(response) == ["write_uncertain"]


@pytest.mark.parametrize(
    "answer", [html, body([1, 2]), body({"result": {}}), body("ok")], ids=["html", "list", "no ok", "string"]
)
async def test_a_200_without_redirect_that_is_not_the_envelope_is_uncertain(answer):
    response = await diary(WebApp(answer))
    assert write_outcome(response) == "uncertain"
    assert code_of(response) == ["write_uncertain"]


READ_FAILURES = {
    "connect error": WebApp(httpx.ConnectError("down")),
    "read timeout": WebApp(httpx.ReadTimeout("slow")),
    "post 403": WebApp(status(403)),
    "post 503": WebApp(status(503)),
    "html": WebApp(html),
    "no envelope": WebApp(body({"result": {}})),
    "redirect then 403": WebApp(redirect(), status(403)),
    "redirect then connect error": WebApp(redirect(), httpx.ConnectError("down")),
}


@pytest.mark.parametrize("app", READ_FAILURES.values(), ids=READ_FAILURES.keys())
async def test_reads_keep_unavailable_exactly_as_before(app):
    response = await app.client().catalog()
    assert code_of(response) == ["unavailable"]


async def test_reads_keep_the_sheets_own_errors():
    internal = refusal("internal")
    assert await WebApp(body(internal)).client().day("2026-09-21") == internal


# ---- §4.3.2 the sheet's ok: false answers ----------------------------------------------------

# Named one by one on purpose: adding a code to PRE_WRITE_CODES needs the proof of §4.3.2 (the line
# of apps/sheet4 that produces it only before a write) and its name here.
PROVEN_PRE_WRITE = [
    "invalid_json",
    "unauthorized",
    "unknown_op",
    "wrong_type",
    "unknown_field",
    "empty",
    "too_long",
    "required",
    "out_of_range",
    "invalid_date",
    "date_in_future",
    "invalid_range",
    "not_in_catalog",
    "incomplete_food",
    "duplicate",
    "invalid_unit",
    "conflict",
    "nothing_to_undo",
    "not_found",
    "already_undone",
    "not_latest",
    "unavailable",
]


def test_the_pre_write_list_is_closed():
    assert sorted(PROVEN_PRE_WRITE) == sorted(PRE_WRITE_CODES)
    assert len(PROVEN_PRE_WRITE) == len(set(PROVEN_PRE_WRITE))


def test_the_mutating_ops_are_the_six_of_the_spec():
    assert {
        "diary.upsert",
        "workout.upsert",
        "food.add",
        "food.copy",
        "measures.upsert",
        "write.undo",
    } == MUTATING_OPS


@pytest.mark.parametrize("code", PROVEN_PRE_WRITE)
async def test_every_pre_write_code_alone_is_not_committed_and_comes_back_untouched(code):
    answer = refusal(code)
    response = await diary(WebApp(body(answer)))
    assert response == answer  # the model reads the sheet's own error and fixes the payload
    assert write_outcome(response) == "not_committed"


POST_WRITE = {
    "rejected": ["rejected"],
    "internal": ["internal"],
    "invalid": ["invalid"],
    "unknown code": ["something_new"],
    "mix": ["not_in_catalog", "rejected"],
    "no errors": [],
}


@pytest.mark.parametrize("codes", POST_WRITE.values(), ids=POST_WRITE.keys())
@pytest.mark.parametrize("via_redirect", [False, True])
async def test_a_refusal_that_may_follow_a_write_is_uncertain(codes, via_redirect):
    answer = body(refusal(*codes))
    app = WebApp(redirect(), answer) if via_redirect else WebApp(answer)
    response = await diary(app)
    assert write_outcome(response) == "uncertain"
    # The sheet's own errors are not shown to the model as a refusal to fix.
    assert code_of(response) == ["write_uncertain"]
    assert TEXT_SENTINEL not in json.dumps(response)
    assert len(app.rows) == 1


@pytest.mark.parametrize(
    "errors",
    [None, "boom", [None], ["rejected"], [{"message": "no code"}], [{"code": 7}], [{"code": None}]],
)
def test_malformed_errors_are_uncertain(errors):
    assert write_outcome({"ok": False, "errors": errors}) == "uncertain"


@pytest.mark.parametrize("ok", [None, 1, "true", "false", 0])
def test_an_ok_that_is_not_a_boolean_is_uncertain(ok):
    assert write_outcome({"ok": ok, "result": {}}) == "uncertain"


def test_ok_true_is_committed_also_when_deduplicated():
    assert write_outcome({"ok": True, "result": {"deduplicated": True}}) == "committed"


async def test_write_state_none_proves_nothing_was_written_whatever_the_code():
    answer = refusal("rejected", writeState="none")
    response = await diary(WebApp(body(answer)))
    assert response == answer and write_outcome(response) == "not_committed"


@pytest.mark.parametrize("state", ["unknown", "partial", "", None, 0, "NONE"])
async def test_any_other_write_state_is_uncertain_even_with_a_pre_write_code(state):
    response = await diary(WebApp(body(refusal("not_in_catalog", writeState=state))))
    assert write_outcome(response) == "uncertain"
    assert code_of(response) == ["write_uncertain"]


def test_settling_twice_changes_nothing():
    uncertain = settle_write(refusal("rejected"))
    assert settle_write(uncertain) == uncertain
    assert settle_write(OK) is OK


WRITES = {
    "diary.upsert": lambda c: c.upsert_diary("2026-09-21", {"weightKg": 82.4}),
    "workout.upsert": lambda c: c.upsert_workout("2026-09-21", "Upper", []),
    "food.add": lambda c: c.add_food("2026-09-21", "Almoço", []),
    "food.copy": lambda c: c.copy_food("2026-09-20", "2026-09-21"),
    "measures.upsert": lambda c: c.upsert_measures("2026-09-21", {"hipCm": 98}),
    "write.undo": lambda c: c.undo("w1"),
}


@pytest.mark.parametrize("op", sorted(MUTATING_OPS))
async def test_every_mutating_op_is_classified(op):
    app = WebApp(httpx.ReadTimeout("slow"))
    response = await WRITES[op](app.client())
    assert app.rows[0]["op"] == op
    assert code_of(response) == ["write_uncertain"]


# ---- no automatic retry ----------------------------------------------------------------------

NO_REQUEST_ID = {"ok": False, "errors": [{"path": "requestId", "code": "unknown_field", "message": "m"}]}


async def call_with_id(app):
    with request_id_scope("tg:1:diary.upsert:abc"):
        return await diary(app)


async def test_the_retry_without_request_id_is_a_second_request_classified_by_the_same_table():
    app = WebApp([body(NO_REQUEST_ID), httpx.ReadTimeout("slow")])
    response = await call_with_id(app)
    assert ["requestId" in row for row in app.rows] == [True, False]
    assert write_outcome(response) == "uncertain"

    app = WebApp([body(NO_REQUEST_ID), httpx.ConnectError("down")])
    assert write_outcome(await call_with_id(app)) == "not_committed"

    app = WebApp([body(NO_REQUEST_ID), body(OK)])
    assert write_outcome(await call_with_id(app)) == "committed"


@pytest.mark.parametrize(
    "answer",
    [
        {**NO_REQUEST_ID, "writeState": "unknown"},
        {"ok": False, "errors": [*NO_REQUEST_ID["errors"], {"path": "", "code": "rejected"}]},
    ],
    ids=["writeState unknown", "mixed with rejected"],
)
async def test_an_uncertain_request_id_rejection_is_never_retried(answer):
    app = WebApp([body(answer), body(OK)])
    response = await call_with_id(app)
    assert write_outcome(response) == "uncertain"
    assert len(app.posts) == 1


# ---- §10.2 logs ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "app",
    [
        lambda: WebApp(httpx.ReadTimeout(TEXT_SENTINEL)),
        lambda: WebApp(redirect(), httpx.ConnectError(TEXT_SENTINEL)),
        lambda: WebApp(body(refusal("rejected", TEXT_SENTINEL, writeState=TEXT_SENTINEL))),
        lambda: WebApp(lambda: httpx.Response(503, text=TEXT_SENTINEL)),
    ],
)
async def test_the_log_of_an_uncertain_write_carries_no_content(app, caplog):
    with caplog.at_level(logging.DEBUG):
        response = await diary(app())
    assert write_outcome(response) == "uncertain"
    assert caplog.records, "an uncertain write is logged"
    for record in caplog.records:
        assert TEXT_SENTINEL not in record.getMessage()
        assert TEXT_SENTINEL not in repr(record.args)
        assert record.exc_info is None and record.exc_text is None and record.stack_info is None
    assert TEXT_SENTINEL not in caplog.text


# ---- §4.3.3 propagation: the agent -----------------------------------------------------------

SAVE = call("save_diary", date="2026-09-21", fields={"weightKg": 82.4})


def bot(sheet, script):
    llm = ScriptedLlm(model="scripted", script=script, requests=[])
    return Bot(sheet, llm, timezone="America/Sao_Paulo", clock=lambda: NOW), llm


UNCERTAIN_APPS = {
    "written, answer lost": lambda: WebApp(httpx.ReadTimeout("slow")),
    "redirect, get 403": lambda: WebApp(redirect(), status(403)),
    "redirect, get 404": lambda: WebApp(redirect(), status(404)),
    "redirect, get 500": lambda: WebApp(redirect(), status(500)),
    "redirect, get html": lambda: WebApp(redirect(), html),
    "redirect, connect error on the get": lambda: WebApp(redirect(), httpx.ConnectError("down")),
    "rejected": lambda: WebApp(body(refusal("rejected"))),
    "internal": lambda: WebApp(body(refusal("internal"))),
    "invalid": lambda: WebApp(body(refusal("invalid"))),
    "unknown code": lambda: WebApp(body(refusal("something_new"))),
    "mix": lambda: WebApp(body(refusal("not_in_catalog", "rejected"))),
    "writeState unknown": lambda: WebApp(body(refusal("not_in_catalog", writeState="unknown"))),
    "post 429": lambda: WebApp(status(429)),
    "post 503": lambda: WebApp(status(503)),
}


@pytest.mark.parametrize("make", UNCERTAIN_APPS.values(), ids=UNCERTAIN_APPS.keys())
async def test_the_agent_answers_write_uncertain_not_sheet_failed_after_exactly_one_post(make):
    app = make()
    b, llm = bot(app.client(), [SAVE, say("ok")])
    answer = await b.reply("peso 82,4")
    assert answer.text == WRITE_UNCERTAIN
    assert SHEET_FAILED not in answer.text
    assert answer.outcome == "uncertain"
    assert not answer.wrote and answer.write_ids == ()
    assert len(app.posts) == 1 and len(app.rows) == 1
    # What the model was told: one write_uncertain error, none of the sheet's own.
    told = llm.requests[-1].contents[-1].parts[0].function_response.response
    assert told["ok"] is False and code_of(told) == ["write_uncertain"]


NOT_COMMITTED_APPS = {
    "connect error on the post": lambda: WebApp(httpx.ConnectError("down")),
    "post 403": lambda: WebApp(status(403)),
    "lock not taken": lambda: WebApp(body(refusal("unavailable"))),
}


@pytest.mark.parametrize("make", NOT_COMMITTED_APPS.values(), ids=NOT_COMMITTED_APPS.keys())
async def test_the_agent_answers_sheet_failed_only_when_nothing_was_committed(make):
    b, _ = bot(make().client(), [SAVE, say("A planilha caiu.")])
    answer = await b.reply("peso 82,4")
    assert answer.text == SHEET_FAILED and answer.failed
    assert answer.outcome == "not_committed"


async def test_a_proven_refusal_is_not_committed_and_the_model_may_fix_it():
    app = WebApp([body(refusal("invalid_date")), body(OK)])
    b, llm = bot(app.client(), [SAVE, SAVE, say("ok")])
    answer = await b.reply("peso 82,4")
    assert answer.outcome == "committed" and answer.wrote
    assert WRITE_UNCERTAIN not in answer.text
    told = llm.requests[1].contents[-1].parts[0].function_response.response
    assert code_of(told) == ["invalid_date"]


async def test_write_state_none_lets_the_agent_say_the_sheet_refused():
    app = WebApp(body(refusal("rejected", writeState="none")))
    b, _ = bot(app.client(), [SAVE, say("A planilha recusou.")])
    answer = await b.reply("peso 82,4")
    assert answer.outcome == "not_committed"
    assert answer.text == "A planilha recusou."


async def test_an_uncertain_write_keeps_the_confirmation_of_the_committed_ones():
    app = WebApp([body(OK), httpx.ReadTimeout("slow")])
    workout = call("save_workout", date="2026-09-21", session="Upper", exercises=[])
    b, _ = bot(app.client(), [SAVE, workout, say("ok")])
    answer = await b.reply("peso 82,4 e treino")
    assert answer.text == f"<b>21/09</b> · Peso kg 82,4\n\n{WRITE_UNCERTAIN}"
    assert answer.outcome == "uncertain" and answer.wrote and answer.write_ids == ("w1",)


# ---- §4.3.3 propagation: the Mini App form and undo ------------------------------------------

FORM_AND_UNDO = {
    "written, answer lost": lambda: WebApp(httpx.ReadTimeout("slow")),
    "redirect, get 403": lambda: WebApp(redirect(), status(403)),
    "redirect, connect error on the get": lambda: WebApp(redirect(), httpx.ConnectError("down")),
    "rejected": lambda: WebApp(body(refusal("rejected"))),
    "mix": lambda: WebApp(body(refusal("not_in_catalog", "rejected"))),
    "writeState unknown": lambda: WebApp(body(refusal("not_in_catalog", writeState="unknown"))),
    "post 503": lambda: WebApp(status(503)),
}
scenarios = pytest.mark.parametrize("make", FORM_AND_UNDO.values(), ids=FORM_AND_UNDO.keys())


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch):
    monkeypatch.setattr(miniapp, "RETRY_DELAYS", (0, 0))


@scenarios
async def test_an_uncertain_form_says_so_with_no_retry_button_and_nothing_pending(make):
    app, store = make(), PendingStore()
    reply = await handle(app.client(), raw(FOOD), 5, TODAY, store)
    assert reply.text == WRITE_UNCERTAIN
    assert reply.write_outcome == "uncertain"
    assert reply.reply_markup is None and not reply.transient
    assert len(store) == 0
    assert len(app.posts) == 1  # the three attempts are for a sheet that was proven down


@scenarios
async def test_an_uncertain_retry_tap_says_so_and_drops_the_pending_write(make):
    app, store = make(), PendingStore()
    key = store.put(Pending("food.add", FOOD["args"], "tg:5:miniapp:food.add:x", 5))
    reply = await retry(app.client(), key, store, 5)
    assert reply.text == WRITE_UNCERTAIN and reply.write_outcome == "uncertain"
    assert reply.reply_markup is None and not reply.transient
    assert store.get(key, 5) is None
    assert len(app.posts) == 1


async def test_a_form_the_sheet_never_received_is_retried_and_kept_for_the_button():
    app, store = WebApp(httpx.ConnectError("down")), PendingStore()
    reply = await handle(app.client(), raw(FOOD), 5, TODAY, store)
    assert reply.text == miniapp.UNAVAILABLE and reply.transient
    assert reply.write_outcome == "not_committed"
    assert reply.reply_markup is not None and len(store) == 1
    assert len(app.posts) == 3


@scenarios
async def test_an_uncertain_undo_says_so_and_stops_with_no_retry(make):
    app = make()
    result = await undo_run(app.client(), ["w1", "w2"])
    assert result.text == UNDO_UNCERTAIN
    assert result.outcome == "uncertain"
    assert not result.sheet_down  # the caller keeps the button only for a sheet proven down
    assert len(app.posts) == 1

    assert await undo_writes(make().client(), ["w1"]) == (UNDO_UNCERTAIN, False)
    assert await undo_last(make().client()) == (UNDO_UNCERTAIN, "uncertain")


@scenarios
async def test_desfazer_carries_the_uncertain_outcome(make):
    reply = await COMMANDS["desfazer"].run(Context(sheet=make().client(), today=TODAY), "")
    assert reply.text == UNDO_UNCERTAIN and reply.write_outcome == "uncertain"
    assert not reply.transient


async def test_an_undo_the_sheet_never_received_keeps_the_button():
    app = WebApp(httpx.ConnectError("down"))
    result = await undo_run(app.client(), ["w1", "w2"])
    assert result.sheet_down and result.outcome == "not_committed"
    assert len(app.posts) == 1
