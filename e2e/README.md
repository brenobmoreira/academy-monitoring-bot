# e2e — local end-to-end run

Sends mocked Telegram webhook requests through the whole stack, enforces end-to-end contract
assertions in scripted mode (run on every PR in CI across both HTTP entry points), and writes a
formatted JSON trace of every hop. No Telegram, no Google account, no network (unless `--real`).

```
fake webhook ─▶ main.telegram_webhook | asgi.app ─▶ webhook.process / handle_update
                                                         │  (shared Dedup, VoiceConfirmations, TextSubmissions, Budget)
                                                         ▼
                                                      Handler ─┬─▶ /app (VoiceLink + LinkCodes) ─┐
                                                               ├─▶ Transcriber ─▶ LiteLLM        │ shared synthetic
                                                               └─▶ ADK Bot ─▶ LiteLLM            │ APP_AUTH_SECRET
                                                                      │                          ▼
                                             tools ─POST─▶ sheet_server.js        voice_asgi (build_voice_service)
                                                                 │                  ├─ GET /healthz & OPTIONS CORS
                                                                 ▼                  ├─ POST /v1/auth/sessions (+ replay 401)
                                                          apps/sheet4/src           └─ POST /v1/voice/transcriptions (+ idempotent replay)
                                                          └─ in-memory sheet
                                  replies / callbacks ─▶ captured Telegram Bot API + file download
```

```bash
cd services/agent
uv run python ../../e2e/run.py                                   # scripted multi-stage suite + asserts
uv run python ../../e2e/run.py --server uvicorn                  # same, through the ASGI app
uv run python ../../e2e/run.py --real --message "dormi 6h, fome 4"  # manual single message on real LLM_MODEL
```

From the repo root: `make e2e`, with flags passed through `E2E_ARGS`
(`make e2e E2E_ARGS="--server uvicorn"`).

`--real` calls `LLM_MODEL` through LiteLLM with `LLM_API_KEY`, both read like in the real agent
(`services/agent/settings.yaml`, then `services/agent/.env`, gitignored). Telegram and sheet values
in that file are ignored here: the run swaps them for local fakes, so it never touches the real bot
or spreadsheet.

## Scripted coverage and explicit assertions (default mode, CI gate)

Without `--real`, the script pins explicit environment defaults independent of any local `.env`,
shares a consistent clock across `Handler`, `Transcriber`, `build_voice_service` and `/remind`,
replaces only the provider HTTP calls behind LiteLLM (`ScriptedProvider` for the ADK agent and
`ScriptedTranscribeClient` for `Transcriber`), and runs both the real `webhook.process` /
`webhook.handle_update` process-state path and the real `build_voice_service` ASGI app
(`agent.voice_asgi`), raising `AssertionError` if any contract regresses:

1. **Typed message + `writeState` (`S1`) + self-correction (`update_id` 1001):** sends
   `DEFAULT_MESSAGE` (diary weight + sleep, Upper workout with warm-up and two work sets with RIR,
   and a lunch with a household measure) with two intentional errors (`sleepH: "7h30"` and exercise
   `"puxada"`). Asserts that `e2e/sheet_server.js` (`apps/sheet4/src`) rejects both with
   `ok: false` and `writeState: "none"`, and that the corrected retries commit with `ok: true`.
2. **Chat voice confirmation flow (`C4b` + `C4c2` + `C4d`, `update_id` 1002–1004):** with
   `MEDIA_ENABLED=true`, sends a `voice` update (`duration: 5`, synthetic Ogg downloaded through
   mocked `getFile` + `/file/bot…`), asserts token settlement on the shared `MemoryBudget`, and
   asserts the plain-text `🎙️ Entendi:\n\n<transcrição>` reply with `vok:<vid>`, `vfix:<vid>` and
   `vno:<vid>`. Then sends `callback_query` `vok:<vid>` carrying the captured `Entendi` message to
   save `waterL: 2.5` in `Diário` (leaving `steps` empty), followed by a second `vok:<vid>` tap on
   a new `update_id` — asserting the `"Já enviado. Confira com /hoje."` toast with zero new LLM or
   `sheet_api` calls.
3. **Mini App `/app` → `voice_asgi` → `webhook` cryptographic voice flow (`C5`–`C7`, `update_id`
   1005–1007):** shares a synthetic 36-byte `APP_AUTH_SECRET` between `fitness-agent` (`Settings`)
   and `fitness-voice` (`build_voice_service(VoiceSettings(...))` over `httpx.ASGITransport`). Sends
   `/app` (`update_id` 1005) and decodes the `🏋️ Treino` and `🍽️ Refeição` `web_app.url` `#…`
   fragments, asserting `vu == "https://voice.example.test"`, `vc` (`c1.…`) and `vx > now`.
   Exercises `GET /healthz` (`200 ok`), CORS preflight `OPTIONS /v1/voice/transcriptions` for
   `https://example.github.io`, `POST /v1/auth/sessions` (`kind: "tg_link"`) exchanging `vc` for a
   Bearer `s1.…` session token, a replay `POST /v1/auth/sessions` with the same `vc` asserting `401`
   (`error.code == "credential_used"`), `POST /v1/voice/transcriptions` (`Content-Type: audio/ogg;
   codecs=opus`, `X-Audio-Duration-Ms: 4000`, `Idempotency-Key`, `OggS…` payload) asserting `200` +
   `"lanche 100g peito de frango cozido"` and `MemoryBudget` settlement, plus an `Idempotency-Key`
   replay asserting cached `200` without consuming an extra transcription or token budget. Passes
   that exact transcript into `message.web_app_data` `t: "text"` (`update_id` 1006) to log a
   `Lanche` item in `Alimentação` (`ok: true`), then resends the same `id` and text on `update_id`
   1007 — asserting `TextSubmissions` replies idempotently (`"Esse envio já foi registrado. Confira
   com /hoje."`) with zero LLM calls and no duplicate row.
4. **Daily reminder + final spreadsheet state (`POST /remind {"kind": "daily"}` + `/__sheets`):**
   asserts HTTP `200` on `/remind`, that the reminder still asks for the missing `passos`, and that
   `Diário` (1 row, 501 kcal, weight 82.4 kg, sleep 7.5 h, water 2.5 L), `Registro de treino`
   (2 rows: `Supino inclinado`, `Puxada aberta`) and `Alimentação` (3 rows: 2 lunch + 1 snack, zero
   duplicates) match the expected state.

## Trace output

Output: `e2e/out/run-<timestamp>.json` (gitignored):

| Key | Content |
|-----|---------|
| `scenario` | mode (`scripted` or `real`), models, server (`Functions Framework` or `uvicorn (ASGI)`), message, date, elapsed time |
| `webhook` | Stage 1 request (headers + update) and HTTP answer |
| `timeline` | Stage 1 hops in order: `llm`, `sheet_api`, `telegram_reply` (`sendChatAction`, `sendMessage`) |
| `reply_sent_to_telegram` / `reply_markup` | Stage 1 HTML confirmation lines and inline buttons (`ok`, `undo:…`, `fix`) |
| `voice_chat` | *(scripted mode)* `voice_update` (`getFile`, `downloadFile`, `transcribe_llm`, `🎙️ Entendi:` + `vid`), `confirm_tap` (`vok:<vid>` → `diary.upsert`), and `duplicate_tap` (toast without LLM/sheet calls) |
| `miniapp_voice` | *(scripted mode)* `app_command` (`/app` → `vu`/`vc`/`vx`), `voice_service` (`/healthz`, CORS preflight, `/v1/auth/sessions` + `401 credential_used` replay, `/v1/voice/transcriptions` + idempotent replay), `submission` (`web_app_data` `t: "text"` → `catalog` + `food.add`) and `duplicate_submission` (`TextSubmissions` guard without LLM/sheet calls) |
| `reminder` | `POST /remind {"kind": "daily"}` on the same entry point: request, answer, and its timeline (`day.get`, then `sendMessage` asking for `passos`) |
| `assertions` | *(scripted mode)* summary of the verified end-to-end contracts and row counts |
| `sheet_after` | rows of `Diário`, `Registro de treino` and `Alimentação` after the run |

The spreadsheet is the sheet 4.0 product (`apps/sheet4/src`, loaded in the same order as
`apps/sheet4/test/harness.js`): `Setup.apply()` builds the tabs when it exists, otherwise
`Tabs.ensure` for every table tab, then `e2e/sheet_server.js` seeds a synthetic client (generic
names): O001/M001/F001 in force since 28 days ago, rotation Upper/Lower, exercises Supino
inclinado, Puxada aberta, Leg press, Mesa flexora and three foods. `SHEET_SRC=legacy` serves the old
`apps/sheet` code with its fixtures instead.
