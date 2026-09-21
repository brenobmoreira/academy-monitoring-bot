# Fitness sheet bot — design

Date: 2026-09-21 · Status: approved for implementation · App: `apps/daily-log`

## Goal

Fill a personal fitness spreadsheet from a Telegram chat, with no server. One Apps Script
project **bound to the spreadsheet** is both the Telegram Web App backend and the spreadsheet's
menu automation, so chat and the sheet's "Hoje" screen write through the same code.

## Scope

v1 delivers:

- **Diary** (tab `Diário`, one row per day): weight, sleep, steps, cardio minutes, Muay Thai
  yes/no, diet complete yes/no, waist, hunger 1–5, fatigue 1–5, notes. Any subset per message.
- **Workout log** (tab `Registro de treino`, one row per exercise per session): session, exercise,
  up to 4 sets of kg×reps, final RIR, pain 0–10, technique note. Prescription columns (ficha,
  prescribed sets, reps min/max, phase) are filled from `Ficha de treino`.
- **Sheet menu**: "Salvar dia", "Salvar treino" (from the Hoje screen) and "Atualizar
  progressão" (tab `Progressão`).
- **Reminder**: daily message at a configured hour.
- **Parser**: LLM-first structured extraction through an OpenAI-compatible endpoint (Gemini in
  v1), with a keyword regex fallback when no LLM is configured or the call fails.

Out of scope: meals (`Alimentação`, `Favoritas`, `Alimentos`...), charts, multi-user, editing
plans (`Ficha de treino`) from chat.

## Non-goals and constraints

- No server. Apps Script only, deployed with clasp.
- Nothing account-specific in the repo. Secrets and ids live in Script Properties.
- The spreadsheet is the read interface; the bot never creates tabs or columns.
- Second message in a day updates, never duplicates (diary upsert by date).

## Architecture

```
Telegram ─webhook─▶ doPost ─▶ Parser (LLM | regex) ─┐
                                                     ├─▶ Entry ─▶ DiaryRepo.upsert
Sheet menu ─▶ HojeScreen.read ───────────────────────┘           WorkoutRepo.saveSession
                                                                 Progression.refresh
Trigger (daily) ─▶ Telegram.sendMessage
```

Apps Script has one global scope, so each file exposes one namespace object. Only platform
entry points are bare functions: `doPost`, `onOpen`, menu handlers, trigger handlers.

| File | Namespace | Responsibility |
|------|-----------|----------------|
| `config.js` | `Config` | Script Properties access, defaults |
| `schema.js` | `Schema` | Entry shape, field→header mapping, yes/no vocabulary |
| `diary.js` | `DiaryRepo` | Upsert one row per day, columns resolved by header text |
| `workout.js` | `WorkoutRepo`, `WorkoutPlan` | Append session rows; look up prescription |
| `progression.js` | `Progression` | Rebuild the `Progressão` tab for one exercise |
| `llm.js` | `LlmClient` | OpenAI-compatible chat completion with JSON schema output |
| `parser.js` | `Parser` | Text → Entry (LLM first, regex fallback) |
| `telegram.js` | `Telegram` | sendMessage, confirmation formatting |
| `webhook.js` | `Webhook` + `doPost` | Auth, dispatch |
| `sheet_ui.js` | `HojeScreen` + `onOpen`, menu handlers | Read the Hoje screen into an Entry |
| `triggers.js` | `setupTriggers`, `sendDailyReminder` | Reminder |

## Data model

`Entry` is the single input object both adapters produce:

```js
{
  date: Date,                    // local midnight
  diary?: { weightKg?, sleepH?, steps?, cardioMin?, muayThai?, dietComplete?,
            waistCm?, hunger?, fatigue?, notes? },
  workout?: {
    session: 'Upper' | 'Lower' | 'Full Body' | string,
    phase?: string,              // default from Hoje!E23 or "Regular"
    exercises: [{ name, sets: [{ kg, reps }], rir?, pain?, note?, equipment? }]
  }
}
```

Diary columns are located by header text on the configured header row (default 5). Only input
headers are written; formula columns are preserved. Workout rows are appended below the last
date; `Volume` and `Séries feitas` are computed by the script; `ID sessão` is
`yyyy-MM-dd/<session>`; `Ficha` is the latest version in `Histórico de fichas`.

Exercise names from chat are normalized (lowercase, no accents) and matched against
`Exercícios`. Unmatched names are stored as typed and flagged in the confirmation.

## Flows

**Chat**: `doPost` → validate `?secret=` and chat id → `Parser.parse(text)` → for each present
part call the repo → reply with a confirmation that echoes exactly what was written
("21/09 · Peso kg 82.4 · Sono h 7.5 · Upper: Supino inclinado 60×8 62×8 (RIR 2)"). Nothing
recognized → reply "nothing recognized" and write nothing. Errors → reply a short error;
details in Executions log.

**Sheet menu**: `Salvar dia` reads the yellow cells of Hoje into `entry.diary`; `Salvar treino`
reads session, phase and the exercise table into `entry.workout`; both call the same repos, then
clear the input cells. `Atualizar progressão` rebuilds `Progressão` for the exercise selected in
`Progressão!B5` (last 20 sessions).

**Reminder**: time-based trigger sends a fixed prompt to every allowed chat id.

## LLM contract

`LlmClient.extract(text, jsonSchema)` POSTs to `{LLM_BASE_URL}/chat/completions` with
`response_format: { type: 'json_schema' }` and returns the parsed object. Provider is a
configuration triple (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`); v1 points at Gemini's
OpenAI-compatible endpoint. A LiteLLM proxy or any other compatible server is a URL change.
The prompt states today's date, the session names and the exercise catalogue so the model can
resolve "ontem" and canonical names.

Future: Jev (typesafe.ai) answers closed questions (choice / score / yes-no with probability),
so it is a candidate for a classification or confidence gate in front of the extractor, not a
replacement for it.

## Security

Web App is public and anonymous; headers are not readable. Two checks on every request: the
`secret` query parameter equals `WEBHOOK_SECRET`, and `message.chat.id` is in
`ALLOWED_CHAT_IDS`. Failures return 200 with no side effects so Telegram stops retrying.

## Configuration (Script Properties)

| Key | Required | Default |
|-----|----------|---------|
| `TELEGRAM_BOT_TOKEN` | yes | |
| `WEBHOOK_SECRET` | yes | |
| `ALLOWED_CHAT_IDS` | yes | |
| `LLM_BASE_URL` | no | none → regex fallback only |
| `LLM_API_KEY` | with base url | |
| `LLM_MODEL` | no | `gemini-2.5-flash` |
| `DIARY_SHEET` | no | `Diário` |
| `HEADER_ROW` | no | `5` |
| `REMINDER_HOUR` | no | `21` |

## Testing

Business logic is exercised in Node (`npm test`, built-in `node:test`) through a harness that
loads `src/*.js` into a VM with fakes for `SpreadsheetApp`, `PropertiesService`, `UrlFetchApp`,
`Utilities` and `Session`. The in-memory spreadsheet fake is seeded with the real tab headers.
End-to-end (webhook, deployment) is a manual smoke test described in `docs/setup.md`.

## Delivery order

1. Harness + Config + Schema.
2. DiaryRepo upsert.
3. WorkoutPlan lookup + WorkoutRepo.saveSession.
4. LlmClient + Parser (LLM and regex).
5. Telegram confirmation + webhook wiring.
6. Sheet menu (HojeScreen) + Progression.
7. Reminder trigger, docs.

## Open items

- App folder rename (`daily-log` → something that says "whole sheet").
- Meals from the Hoje screen: separate spec.
- `/desfazer` (undo last workout rows): after v1 usage shows whether it is needed.
