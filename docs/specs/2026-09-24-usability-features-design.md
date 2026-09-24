# Usability features — design

Date: 2026-09-24 · Status: approved for implementation · Branch: `claude/charming-curie-kdu20x`

Thirteen features that make the bot easier to use day to day. Each one is implemented by its own
agent, in waves (below), so this document fixes every contract two features share: API ops and
result shapes, module names, settings, and the Telegram surface. A feature may add to a contract
here; it may not change one another feature relies on.

## Principles kept from the earlier specs

- The spreadsheet stays the only store. The agent keeps **no state between requests** (Cloud Run
  scales to zero; `webhook.process` builds a `Handler` per request). Whatever must survive a
  message lives in the sheet (tabs or Script Properties) or travels inside Telegram itself
  (`callback_data`, `reply_to_message`).
- Every write goes through `SheetApi.run` (validation, script lock). New ops follow the same
  envelope, the same strict validator style and Portuguese messages.
- Confirmations are built from what the API reports it wrote, never from model output.
- Deterministic features (commands, summaries, comparisons) do not call the LLM.
- No new vendor. The only new infrastructure is one optional Cloud Scheduler job (F12).

## Features and waves

| # | Feature | Size | Wave | Depends on |
|---|---------|------|------|------------|
| F1 | HTML formatting and message splitting | quick | 1 | — |
| F2 | "typing…" indicator | quick | 1 | — |
| F3 | Specific error messages | quick | 1 | — |
| F4 | `Makefile` with the common tasks | quick | 1 | — |
| F5 | Commands `/hoje`, `/ficha`, `/exercicios` + `setMyCommands` | quick | 1 | — |
| F6 | Undo (`/desfazer`) | quick | 1 | — |
| F7 | Comparison with the previous session in the confirmation | medium | 1 | — |
| F8 | Diary history (tool + op) | large | 1 | — |
| F9 | Inline buttons under the confirmation | medium | 2 | F1, F5, F6 |
| F10 | Short context between messages | medium | 2 | F6 |
| F11 | Weekly summary `/semana` | large | 2 | F5, F8 |
| F12 | Daily reminder and weekly push | medium | 3 | F5, F11 |
| F13 | Voice and photo messages | large | 2 | F1, F2 |

Wave 1 runs in parallel; each later wave starts from the merge of the earlier ones.

## Shared contracts

### Telegram client (`agent/telegram.py`)

```python
async def send_message(chat_id, text, *, html=False, reply_markup=None, reply_to=None) -> dict  # F1: returns the sent Message
async def send_chat_action(chat_id, action="typing") -> None                                     # F2
async def set_my_commands(commands: list[tuple[str, str]]) -> None                              # F5
async def answer_callback_query(callback_query_id, text=None) -> None                           # F9
async def edit_message_reply_markup(chat_id, message_id, reply_markup=None) -> None             # F9
async def get_file(file_id) -> dict ; async def download_file(file_path) -> bytes               # F13
```

`Handler` depends on a `Sender` protocol; each feature widens it with the method it uses and
updates the fakes in `tests/`.

### Formatting (F1, `agent/format.py`)

- Replies are sent with `parse_mode=HTML`. Every piece of text that did not come from our own
  templates (model text, exercise names, notes) goes through `html.escape`.
- `split(text, limit=4096) -> list[str]` cuts on line boundaries (a single over-long line is
  hard-cut); the handler sends each chunk in order. Only the **last** chunk carries
  `reply_markup`.
- Summary lines keep their current wording; bold is used for the date/session header line and
  exercise names.

### Commands (F5, `agent/commands.py`)

A registry `COMMANDS: dict[str, Command]` where each command has a Telegram description and an
`async run(ctx, args: str) -> Reply`. `Handler` dispatches any message whose first token (without
`@bot`) is a registered command; `/start` and `/help` move into the registry. `Reply` is
`(text: str, html: bool, reply_markup: dict | None)`.

`agent-commands` (script in `pyproject.toml`) calls `setMyCommands` with the registry, and
`scripts/set-webhook.sh set` calls it too (by `curl`, same list, kept in sync by a test that
reads the script). Later features register their commands in the same registry: `/desfazer`
(F6), `/semana` (F11).

| Command | Behaviour |
|---------|-----------|
| `/hoje [data]` | what the sheet has for the day (`day.get`): diary fields and workout exercises, formatted like a confirmation; "Nada registrado em dd/mm." when empty. `data` accepts `ontem`, `dd/mm`, `yyyy-mm-dd` |
| `/ficha [sessão]` | the plan rows of a session (sets for the current phase, rep range). No argument → the session after the last logged one in plan order (`catalog.lastWorkout`), or the first session |
| `/exercicios [grupo]` | exact catalogue names grouped by muscle group |

### Sheet API — new ops and fields

All ops keep the `{ok, result} | {ok:false, errors}` envelope. `write: true` ops take the script
lock. Dates are `yyyy-MM-dd`.

| Op / field | Feature | Args | Result |
|------------|---------|------|--------|
| `day.get` | F5 | `{date}` | `{date, diary: {<field>: value}, workout: [{session, phase, exercises:[{name, sets, setsDone, volume, rir?, pain?}]}]}` |
| `catalog.lastWorkout` | F5 | — | `{date, session} \| null`, most recent row of `Registro de treino` |
| `writeId` on `diary.upsert` and `workout.upsert` results | F6 | — | opaque string, ≤ 20 chars |
| `write.undo` | F6 | `{writeId?}` | `{writeId, undone: {op, date, session?, fields?: [..], exercises?: [..]}}`; no `writeId` → the most recent write not yet undone |
| `catalog.recent` | F10 | — | writes of the last 30 min, newest first: `[{writeId, at, op, date, session?, exercises?: [names], fields?: [names]}]` |
| `previous` on each exercise of `workout.upsert` | F7 | — | `{date, sets, volume, setsDone} \| null`: the latest session of that exercise **before** the written date |
| `diary.range` | F8 | `{from, to}` (≤ 92 days, `from ≤ to`) | `{from, to, days: [{date, <field>: value}]}` sorted by date, only days with a row |
| `workout.range` | F11 | `{from, to}` (≤ 92 days) | `{from, to, rows: [{date, session, exercise, group, setsDone, volume, prescribedSets, rir?, pain?}]}` |

Undo log (F6): Apps Script keeps the last 30 writes in a Script Property `UNDO_LOG` (JSON array,
pruned by count and to stay under the 9 kB per-property limit). Each entry stores the previous
content of every cell the write touched (`{sheet, row, col, before}`) and whether the row was
new. Undo restores `before` values; a row that the write created is cleared (not deleted, so
row numbers of later writes stay valid). An entry is undone once; undoing it again returns
error `already_undone`; an unknown or pruned id returns `not_found`. `catalog.recent` (F10) reads
the same log, so both features share it.

`SheetClient` gains one method per op, and the `SheetApi` protocol in `tools.py` (the future
`LogStore` port) gains the ones the agent's tools use. `tests/fakes.py::FakeSheet` gains the same
methods. `e2e/sheet_server.js` runs the real Apps Script, so it needs no change unless the fake
spreadsheet lacks a tab.

### Callback data (F9)

Telegram limits `callback_data` to 64 bytes. Format `<verb>:<arg>`:

| Button | `callback_data` | Action |
|--------|-----------------|--------|
| ✅ Ok | `ok` | remove the keyboard |
| ↩️ Desfazer | `undo:<id1>,<id2>,…`: one button undoes **every** write of that message; if the ids do not fit in 64 bytes the button is omitted | `write.undo` for each id, newest first; edit the keyboard away; reply with what was undone |
| ✏️ Corrigir | `fix` | reply with a `force_reply` prompt "Envie a correção para esta mensagem"; the user's answer arrives with `reply_to_message` and goes to the agent with context (F10) |

`scripts/set-webhook.sh` registers `allowed_updates=["message","callback_query"]`, and
`TelegramClient.get_updates` asks for the same.

### Context (F10)

No agent-side storage. Two sources, both put into the agent instruction as a "Contexto recente"
block:

1. `reply_to_message.text` when the user replies to a bot message (swipe-reply or the ✏️
   button): the text of the replied message.
2. `catalog.recent` (writes of the last 30 min), which the model already fetches before any
   workout write. The instruction tells it to use the most recent session and date for messages
   like "e mais 3x10 de rosca" when the message names neither.

A correction ("na verdade foi 62 no supino") rewrites the same date/session/exercise, which the
upsert already replaces.

### Summaries (F11, `agent/weekly.py`)

`/semana [n]` — the week (Mon–Sun) containing today, or `n` weeks back. Computed in Python from
`diary.range` + `workout.range`, no LLM: averages of weight, sleep and steps (with the number of
days they cover), weight delta first→last, Muay Thai days, diet-complete days, cardio minutes,
sessions done and volume per muscle group, adherence (`setsDone / prescribedSets` over rows with
a prescription). Missing data is omitted, never shown as zero.

### Reminder (F12)

`POST /remind` on both entry points (ASGI route; the Functions Framework function dispatches on
`request.path`). Authenticated by header `X-Reminder-Token` compared (constant time) with the new
secret setting `REMINDER_TOKEN`; unset → 404. Body `{"kind": "daily" | "weekly"}`:

- `daily`: `day.get` for today; if any of weight, sleep, steps is missing, send each allowed chat
  "Faltou registrar hoje: peso, sono." (only the missing ones). Nothing missing → no message.
- `weekly`: the `/semana` text for the week that ends today.

Scheduling is a Cloud Scheduler job per kind (documented, not automated).

### Media (F13)

- `voice`/`audio` (≤ 5 MB) and `photo` (largest size ≤ 5 MB) are downloaded with `getFile` and
  passed to the agent as `types.Part(inline_data=Blob(mime_type, data))` next to the caption
  text. The model is the LiteLLM model already configured; Gemini accepts both.
- A provider or model that rejects the media makes the reply say "Não consegui ler o
  áudio/foto com o modelo configurado; envie em texto." (detected from the LiteLLM error, not
  guessed from the model name).
- Setting `MEDIA_ENABLED` (default `true`); `false` answers media with that same text-only hint
  without downloading.
- The instruction gains: transcribe what is said / read the scale or app screen, then apply the
  same rules; never guess an unreadable digit.

### Errors (F3)

`Bot.reply` distinguishes and the handler reports:

| Cause | Reply |
|-------|-------|
| LLM call failed (LiteLLM exception, timeout) | "⚠ O modelo não respondeu agora. Nada novo foi gravado além do que aparece acima." (the journal still shows what was written before the failure) |
| Sheet unavailable (`code` `unavailable`/`internal` in any tool response of the run, and nothing written) | "⚠ A planilha não respondeu. Tente de novo em alguns minutos." |
| Anything else | the current `FAILURE` |

Partial success always shows the confirmation of what was written before the error.

### Tooling (F4)

A root `Makefile`: `test` (both suites), `test-sheet`, `test-agent`, `lint` (ruff check +
format check + ty + `npm run check`), `fmt`, `e2e`, `poll`, `serve` (uvicorn), `webhook-set`,
`webhook-info`, `webhook-delete`, `commands` (setMyCommands), `push-sheet` (clasp push). CI keeps
calling the tools directly.

### Diary history (F8)

Tool `get_diary_history(date_from, date_to)` over `diary.range`. The instruction lists it for
questions such as "como está meu peso nas últimas 2 semanas?"; the model answers from the data
and must not invent days that are absent.

## Settings added

| Setting | Secret | Default | Feature |
|---------|--------|---------|---------|
| `REMINDER_TOKEN` | yes | unset (endpoint off) | F12 |
| `MEDIA_ENABLED` | no | `true` | F13 |
| `MEDIA_MAX_BYTES` | no | `5000000` | F13 |

## Testing

Every feature ships with tests in the suite it touches (`npm test`, `uv run pytest`), no
network, and keeps `ruff check`, `ruff format --check`, `ty check`, `npm run check` and the
scripted e2e run green. Features that change a tool or op the e2e path uses update
`e2e/run.py`'s script if it breaks.

## Needs the owner (after the code is merged)

1. Push the Apps Script (`clasp push`) and create a new Web App deployment version, since F5–F8,
   F10 and F11 add ops.
2. Re-register the webhook with `scripts/set-webhook.sh set`: it now asks for `callback_query`
   (F9) and sets the command menu (F5).
3. F12: set `REMINDER_TOKEN` in Secret Manager and create the Cloud Scheduler jobs.
4. F13: confirm the configured model accepts audio and images (Gemini does).
5. Redeploy the agent.

## Out

Meals, editing the plan from chat, multi-user, and per-chat state stored outside the sheet.
