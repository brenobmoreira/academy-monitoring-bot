# Plan — Python agent + strict sheet API

Spec: `docs/specs/2026-09-22-python-agent-sheet-api-design.md` · ADR: `docs/adr/0003`

Test-first per task: failing test → minimal code → green → commit. JS: `npm test`. Python:
the pytest suite inside `services/agent` (runs on explicit request on this machine; lint and
type checks run on every task).

## Apps Script (`apps/sheet`)

1. **Remove the chat half.** Delete `parser.js`, `llm.js`, `telegram.js`, `triggers.js`,
   `webhook.js`, `entry.js` and their tests; drop Telegram/LLM/reminder keys from `Config`, add
   `SHEET_API_KEY`; drop the `script.external_request` and `script.scriptapp` scopes.
2. **Validator.** `validator.js`: pure checks returning `{value, errors[]}` for
   `diary.upsert`, `workout.upsert`, `exercise.history` args, given the catalogue (sessions,
   exercise names) and today. Suggestions for catalogue misses. Tests: every rule in the spec's
   "Strictness rules", multiple errors in one pass, unknown fields at every level.
3. **Operations.** `api.js`: `SheetApi.handle(request)` → auth, op dispatch, validation, repo
   call, `{ok,result}` / `{ok:false,errors}`; internal exceptions → `internal`. `catalog` and
   `exercise.history` read ops. `doPost` wraps it in a `ContentService` JSON output. Tests
   through `doPost` with the fixtures.
4. **Menu.** `sheet_ui.js`: Hoje → args → the same operations in-process; alert errors one per
   line; clear inputs on success. Tests with Hoje fixtures.
5. **Docs.** `apps/sheet/docs/setup.md`, README, `package.json` paths.

## Agent (`services/agent`)

6. **Scaffold.** uv package, deps (`google-adk`, `httpx`, `functions-framework`), dev deps
   (`pytest`, `pytest-asyncio`, `ruff`), `config.py` with tests.
7. **SheetClient.** httpx client, follows redirects, returns bodies as dicts; transport and
   non-JSON failures → `unavailable`. Tests with `MockTransport`.
8. **Tools.** Four async functions closed over a client, documented for the model. Tests with
   a fake client.
9. **Bot.** `LlmAgent` + `Runner` + in-memory session, `max_llm_calls=8`, instruction with the
   date. Tests: tool names, instruction contains today, final text extraction.
10. **Telegram + handler + entries.** `TelegramClient`, `handle_update`,
    `main.telegram_webhook` (secret header), `poll.main`. Tests with fakes.
11. **Deploy files + docs.** `requirements.txt` from `uv export`, `.gcloudignore`,
    `services/agent/README.md` (Vertex, Secret Manager, Cloud Build trigger, webhook).
