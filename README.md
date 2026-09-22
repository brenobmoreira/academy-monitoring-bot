# academy-monitoring-bot

A personal Telegram bot that fills a fitness spreadsheet in Google Sheets. A Python agent
(Google ADK + Gemini) understands the messages; a Google Apps Script project bound to the
spreadsheet is the only thing that writes to it, through a strict JSON API.

Nothing here is tied to a specific account. Secrets and ids live in Script Properties, in the
agent's environment (Secret Manager on Cloud Run) or in gitignored `.env` files, never in this
repo.

**Setting it up from zero:** [`docs/setup/README.md`](docs/setup/README.md).

## Parts

| Part | Language | What it does | Setup |
|------|----------|--------------|-------|
| [`services/agent`](services/agent) | Python 3.12, Google ADK | Telegram webhook (Cloud Run function), Gemini agent with sheet tools, confirmation replies | [README](services/agent/README.md) |
| [`apps/sheet`](apps/sheet) | Apps Script (JS) | Validated JSON API over the spreadsheet, the **Registro** sheet menu, the `Progressão` tab | [setup](apps/sheet/docs/setup.md) |

## Architecture

```
Telegram ──webhook──▶ Cloud Run function (Python, ADK agent + Gemini)
                         │ tools: get_catalog, save_diary, save_workout, get_exercise_history
                         │        └──POST JSON──▶ Apps Script Web App ──▶ Sheets
                         │             ◀── {ok, result} | {ok:false, errors[]}
                         └──▶ Telegram reply

Sheet menu "Registro" ──▶ Hoje screen ──▶ same validator ──▶ same repos ──▶ Sheets
```

- **Agent**: never touches the sheet. When the API rejects a payload, the error list (path,
  message, suggestions) goes back to the model, which fixes it and calls again. The reply echoes
  what the sheet says it wrote.
- **Sheet API**: accepts exact JSON only, checks names against the `Exercícios` and
  `Ficha de treino` tabs, reports every error at once and writes nothing unless the whole
  request is valid.

Design and decisions: [`docs/specs`](docs/specs), [`docs/adr`](docs/adr), [`docs/plans`](docs/plans).

## Security model

- Telegram → agent: the webhook is registered with a `secret_token`; the function rejects
  requests without the matching `X-Telegram-Bot-Api-Secret-Token` header and ignores chats
  outside `ALLOWED_CHAT_IDS`.
- Agent → Apps Script: the Web App is public (Apps Script cannot check Google identities for
  a server caller without OAuth), so every request carries `SHEET_API_KEY` in the JSON body,
  compared with the Script Property of the same name.
- Gemini runs through Vertex AI with the function's service account; no API key.

## Testing

```bash
npm test                                   # Apps Script, Node runner with in-memory fakes
cd services/agent && uv run pytest         # agent, fake sheet API and scripted LLM
```

Neither suite needs network or a Google account.
