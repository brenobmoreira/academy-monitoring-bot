# e2e — local end-to-end run

Sends a mocked Telegram webhook through the whole stack and writes a formatted JSON trace of
every hop. No Telegram, no Google account, no network (unless `--real`).

```
fake webhook ─▶ main.telegram_webhook | asgi.app ─▶ Handler ─▶ ADK Bot ─▶ LiteLLM ─▶ provider (scripted | real)
                                                              │
                                     tools ─POST─▶ sheet_server.js ─▶ apps/sheet/src (real JS)
                                                                         └─ in-memory spreadsheet
                          reply ─▶ captured Telegram sendMessage
```

```bash
cd services/agent
uv run python ../../e2e/run.py                                   # scripted provider
uv run python ../../e2e/run.py --server uvicorn                  # through the ASGI app
uv run python ../../e2e/run.py --real --message "dormi 6h, fome 4"  # real LLM_MODEL
```

`--real` calls `LLM_MODEL` through LiteLLM with `LLM_API_KEY`, both read like in the real agent
(`services/agent/settings.yaml`, then `services/agent/.env`, gitignored). Telegram and sheet values in that file are ignored here: the run swaps them
for local fakes, so it never touches the real bot or spreadsheet.

The scripted provider (it replaces only the HTTP call LiteLLM would make) replays a fixed conversation for the default message and makes two mistakes
on purpose (`sleepH: "7h30"` and the exercise `"puxada"`), so the trace shows the sheet API
rejecting them and the agent correcting.

Output: `e2e/out/run-<timestamp>.json` (gitignored):

| Key | Content |
|-----|---------|
| `scenario` | model, message, date, elapsed time |
| `webhook` | the request Telegram would send (headers + update) and the function's answer |
| `timeline` | every hop in order: `llm` (what the model received and returned), `sheet_api` (request and response of the Apps Script API), `telegram_reply` (each Bot API call: `sendChatAction` while the bot works, then `sendMessage`) |
| `reply_sent_to_telegram` | the final message, one line per item |
| `sheet_after` | rows of `Diário` and `Registro de treino` after the run |

The spreadsheet starts from `apps/sheet/test/fixtures.js`: sessions Upper/Lower and exercises
Supino inclinado, Puxada aberta, Leg press.
