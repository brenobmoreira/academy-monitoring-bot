# e2e — local end-to-end run

Sends a mocked Telegram webhook through the whole stack and writes a formatted JSON trace of
every hop. No Telegram, no Google account, no network (unless `--real`).

```
fake webhook ─▶ main.telegram_webhook | asgi.app ─▶ Handler ─▶ ADK Bot ─▶ LiteLLM ─▶ provider (scripted | real)
                                                              │
                                     tools ─POST─▶ sheet_server.js ─▶ apps/sheet4/src (real JS)
                                                                         └─ in-memory spreadsheet
                          reply ─▶ captured Telegram sendMessage
```

```bash
cd services/agent
uv run python ../../e2e/run.py                                   # scripted provider
uv run python ../../e2e/run.py --server uvicorn                  # through the ASGI app
uv run python ../../e2e/run.py --real --message "dormi 6h, fome 4"  # real LLM_MODEL
```

From the repo root: `make e2e`, with flags passed through `E2E_ARGS`
(`make e2e E2E_ARGS="--server uvicorn"`).

`--real` calls `LLM_MODEL` through LiteLLM with `LLM_API_KEY`, both read like in the real agent
(`services/agent/settings.yaml`, then `services/agent/.env`, gitignored). Telegram and sheet values in that file are ignored here: the run swaps them
for local fakes, so it never touches the real bot or spreadsheet.

The scripted provider (it replaces only the HTTP call LiteLLM would make) replays a fixed conversation for the default message (diary,
an Upper session with a warm-up set and two work sets with RIR, and a lunch with a household
measure) and makes two mistakes on purpose (`sleepH: "7h30"` and the exercise `"puxada"`), so the
trace shows the sheet API rejecting them and the agent correcting.

Output: `e2e/out/run-<timestamp>.json` (gitignored):

| Key | Content |
|-----|---------|
| `scenario` | model, message, date, elapsed time |
| `webhook` | the request Telegram would send (headers + update) and the function's answer |
| `timeline` | every hop in order: `llm` (what the model received and returned), `sheet_api` (request and response of the Apps Script API), `telegram_reply` (each Bot API call: `sendChatAction` while the bot works, then `sendMessage`) |
| `reminder` | then `POST /remind {"kind":"daily"}` on the same entry point: request, answer, and its own timeline (`day.get`, then the `sendMessage` asking for the steps the message did not log) |
| `reply_sent_to_telegram` | the final message as sent (Telegram HTML, every chunk joined), one line per item |
| `sheet_after` | rows of `Diário`, `Registro de treino` and `Alimentação` after the run |

The spreadsheet is the sheet 4.0 product (`apps/sheet4/src`, loaded in the same order as
`apps/sheet4/test/harness.js`): `Setup.apply()` builds the tabs when it exists, otherwise
`Tabs.ensure` for every table tab, then `e2e/sheet_server.js` seeds a synthetic client (generic
names): O001/M001/F001 in force since 28 days ago, rotation Upper/Lower, exercises Supino
inclinado, Puxada aberta, Leg press, Mesa flexora and three foods. `SHEET_SRC=legacy` serves the old
`apps/sheet` code with its fixtures instead.
