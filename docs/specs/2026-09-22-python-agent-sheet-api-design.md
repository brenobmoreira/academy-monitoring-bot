# Python agent + strict sheet API — design

Date: 2026-09-22 · Status: approved for implementation; model and settings amended by ADR 0004 ·
Supersedes the chat half of
`2026-09-21-fitness-sheet-bot-design.md`

## Goal

Move everything conversational (Telegram, free-text understanding, LLM) to a Python service
built with Google ADK, so the bot can grow with agent frameworks. Apps Script shrinks to the
only thing it must do: be the single, strict write path into the spreadsheet, plus the
spreadsheet's own menu.

Success: sending "upper: supino inclinado 60x8 62x8 rir 2, dormi 7h" on Telegram writes the
same rows as the Apps Script-only bot did, and every agent behaviour is testable in Python
without Google.

## Scope

In:

- `services/agent/` — Python 3.12, uv, Google ADK, Gemini through Vertex AI, deployed as a
  Cloud Run function (HTTP, scales to zero), continuously deployed from GitHub by a Cloud Build
  trigger. Local development through Telegram long polling.
- `apps/sheet/` (renamed from `apps/daily-log`) — Apps Script: JSON API (`doPost`) with strict
  validation, the `Registro` sheet menu, the `Progressão` rebuild.

Out: daily reminder (dropped for now), meals, multi-turn conversations, undo.

## Architecture

```
Telegram ──webhook──▶ Cloud Run function (Python, ADK agent + Gemini)
                         │ tools: get_catalog, save_diary, save_workout, get_exercise_history
                         │        │
                         │        └──POST JSON──▶ Apps Script Web App ──▶ Sheets
                         │             ◀── {ok:true, result} | {ok:false, errors[]}
                         └──▶ Telegram sendMessage

Sheet menu "Registro" ──▶ HojeScreen ──▶ same Validator ──▶ same repos ──▶ Sheets
```

| Side | Does | Never does |
|------|------|------------|
| Python agent | Telegram auth and I/O, understanding text, choosing tool calls, fixing a rejected payload from the error list, writing the reply | Touch the spreadsheet directly |
| Apps Script | Validate strictly, write, return what was written or every error; sheet menu; progression | Parse free text, call an LLM, talk to Telegram |

One write path: the agent and the sheet menu both go through `Validator` → repos.

## Sheet API contract (Apps Script)

Transport: `POST <web app url>` with a JSON body. Apps Script cannot set HTTP status codes and
answers POSTs with a 302 to `script.googleusercontent.com`, so clients follow redirects and read
the outcome from the body, always:

```json
{ "ok": true,  "result": { ... } }
{ "ok": false, "errors": [ { "path": "...", "code": "...", "message": "...", "suggestions": [] } ] }
```

Request: `{ "key": "<SHEET_API_KEY>", "op": "<operation>", "args": { ... } }`.

| op | args | result |
|----|------|--------|
| `catalog` | `{}` | `{ today, timezone, phase, sessions[], exercises[{name, group}], plan[{session, exercise, setsAdaptation, setsRegular, repsMin, repsMax}] }` |
| `diary.upsert` | `{ date, fields }` | `{ date, row, fields }` — the fields as written |
| `workout.upsert` | `{ date, session, phase?, exercises[] }` | `{ date, session, phase, sessionId, exercises[{ name, row, sets, setsDone, volume, rir?, pain?, previous }] }`; `previous` is `{ date, sets, volume, setsDone }` of the latest earlier session of that exercise, or `null` (added by F7, [usability spec](2026-09-24-usability-features-design.md)) |
| `exercise.history` | `{ name, limit? }` | `{ name, sessions[{ date, session, sets, volume, rir, pain }] }` newest first |

### Strictness rules

The validator never coerces. `"82,4"` is not a number; `"sim"` is not a boolean. It collects
**every** error in one pass and writes nothing when there is at least one (all or nothing per
request).

- Unknown keys anywhere → `unknown_field`.
- `date`: string `yyyy-MM-dd`, a real calendar day, not after today in the script time zone →
  `invalid_date` / `date_in_future`.
- `diary.upsert.fields`: non-empty object; `weightKg` 20–400, `sleepH` 0–24, `steps` integer
  0–200000, `cardioMin` 0–1440, `waistCm` 30–300 (numbers); `muayThai`, `dietComplete`
  booleans; `hunger`, `fatigue` integers 1–5; `notes` non-empty string ≤ 500 chars.
- `workout.upsert`: `session` exactly one of the sessions in `Ficha de treino`; `phase`, when
  given, exactly `Adaptação` or `Regular` (omitted → Hoje!E23, else `Regular`); `exercises`
  1–20 items, no repeated name; each exercise `name` exactly a name in `Exercícios`, `sets`
  1–4 items of `{ kg: number 0–1000, reps: integer 1–100 }`, optional `rir` integer 0–10,
  `pain` integer 0–10, `note` and `equipment` strings ≤ 200.
- `exercise.history.name`: exact catalogue name; `limit` integer 1–50, default 10.
- Unknown `op` → `unknown_op`; bad key → `unauthorized`; JSON that does not parse →
  `invalid_json`.

Error shape: `path` in dotted/indexed form (`args.exercises[1].sets[0].reps`), a stable `code`
(`required`, `unknown_field`, `wrong_type`, `out_of_range`, `invalid_date`, `date_in_future`,
`not_in_catalog`, `duplicate`, `too_long`, `empty`), a Portuguese `message` meant for the model,
and `suggestions` for catalogue misses (up to 3 names by accent/case-insensitive containment
and shared words). Internal failures (missing tab, missing header) → `ok:false` with code
`internal` and the message, so the agent can report it instead of retrying.

### Write semantics (unchanged from v1)

- Diary: upsert by date; only the given fields are written; formula columns untouched.
- Workout: upsert by (date, session, exercise). A retried Telegram update rewrites the same rows;
  a later message with another exercise of the same session adds a row. Prescription columns,
  `Ficha`, `Séries feitas`, `Volume` and `ID sessão` are filled by the script as before.

### Sheet menu

`Registro` → `Salvar dia`, `Salvar treino`, `Atualizar progressão`. The Hoje reader turns the
yellow cells into the same `args` objects (dates to `yyyy-MM-dd`, `Sim`/`Não` to booleans,
empty cells dropped) and calls the same operation functions. Errors are shown in an alert, one
per line; on success the input cells are cleared and a short summary is shown.

## Agent (Python)

Package layout (`services/agent/src/agent/`):

| Module | Responsibility |
|--------|----------------|
| `config.py` | Settings from environment variables |
| `sheet_client.py` | `SheetClient`: typed calls to the four ops; returns the `ok/errors` body as-is; transport errors become `{ok:false, errors:[{code:'unavailable'}]}` |
| `tools.py` | ADK function tools bound to a `SheetClient`; return the API body unchanged so the model sees `errors` and retries |
| `bot.py` | Builds the `LlmAgent` (instruction with today's date, tools) and runs one message through an ADK `Runner` with a call budget |
| `telegram.py` | `TelegramClient.send_message`, `get_updates`, `delete_webhook` over httpx |
| `handler.py` | `handle_update(update)`: allowlist, text only, run the bot, reply; never raises |
| `main.py` | Cloud Run function entry (`functions_framework`): checks `X-Telegram-Bot-Api-Secret-Token`, answers 200 |
| `poll.py` | Local loop: `getUpdates` long polling → `handle_update` |

Behaviour:

- Single turn per message, no conversation memory. The agent never asks a question back: it
  saves what is unambiguous and tells what it could not save.
- The instruction tells the model to call `get_catalog` before writing a workout (exact session
  and exercise names), to send dates as `yyyy-MM-dd` resolving "ontem" from today in
  `America/Sao_Paulo`, and, on `ok:false`, to fix exactly the listed paths and call again.
- Budget: at most 8 LLM calls per message (`RunConfig.max_llm_calls`); exceeding it replies
  with what was saved so far.
- Reply echoes what the API says it wrote ("21/09 · Peso 82,4 kg · Sono 7 h"), never what the
  model intended.
- No LLM configured or the model fails → the user gets "não consegui processar agora".

## Security

- Telegram → agent: `setWebhook` with `secret_token`; the function rejects requests whose
  `X-Telegram-Bot-Api-Secret-Token` differs (403) and ignores chats outside
  `ALLOWED_CHAT_IDS` (200, no side effects).
- Agent → Apps Script: shared `SHEET_API_KEY` in the JSON body (never in the URL, so it stays
  out of access logs). Apps Script compares it with Script Property `SHEET_API_KEY`.
- Secrets on Cloud Run come from Secret Manager as environment variables. Gemini through Vertex
  AI uses the function's service account, no API key.

## Configuration

Apps Script (Script Properties): `SHEET_API_KEY` (required), `DIARY_SHEET` (default `Diário`),
`HEADER_ROW` (default `5`). Everything Telegram/LLM related is removed from it.

Agent (environment): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ALLOWED_CHAT_IDS`,
`SHEET_API_URL`, `SHEET_API_KEY`, `GEMINI_MODEL` (default `gemini-2.5-flash`),
`GOOGLE_GENAI_USE_VERTEXAI=TRUE`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`. Locally the
same variables come from `services/agent/.env` (gitignored), where an AI Studio
`GOOGLE_API_KEY` may replace Vertex.

## Testing

- Apps Script: the existing Node harness with Apps Script fakes. Validator, every op through
  `doPost`, the menu through the Hoje fixtures.
- Agent: pytest. `SheetClient` against `httpx.MockTransport`; tools against a fake client;
  handler and `main` with a fake bot; the bot wiring (tool list, instruction contents, budget)
  without calling a model. No test touches the network.
- End to end (real Telegram, Gemini, sheet) is a manual smoke test in the setup guide.

## Deploy

- Agent: Cloud Run function from `services/agent` (Python buildpack, `requirements.txt`
  exported from `uv.lock`), continuous deployment by a Cloud Build trigger on `main` filtered
  to `services/agent/**`. First deploy by `gcloud run deploy --source`.
- Apps Script: `clasp push` + `clasp deploy -i <deploymentId>` as before.

## Delivery order

1. Apps Script: `Validator` + `SheetApi` ops + `doPost`; remove Telegram/LLM/parser/reminder.
2. Apps Script: menu on top of the ops; docs.
3. Python: project scaffold, config, `SheetClient`.
4. Python: tools and bot (ADK).
5. Python: Telegram client, handler, Cloud Run entry, polling.
6. Docs: README, setup guides, ADR.
