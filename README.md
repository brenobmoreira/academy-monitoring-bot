# academy-monitoring-bot

A personal Telegram bot that fills a fitness spreadsheet in Google Sheets. A Python agent
(Google ADK + LiteLLM, Gemini by default) understands the messages; a Google Apps Script project bound to the
spreadsheet is the only thing that writes to it, through a strict JSON API.

Nothing here is tied to a specific account. Secrets and ids live in Script Properties, in the
agent's environment (Secret Manager on Cloud Run) or in gitignored `.env` files, never in this
repo.

**Setting it up from zero:** [`docs/setup/README.md`](docs/setup/README.md).

## Parts

| Part | Language | What it does | Setup |
|------|----------|--------------|-------|
| [`services/agent`](services/agent) | Python 3.12, Google ADK, LiteLLM | Telegram webhook (Cloud Run function or uvicorn), text and chat voice processing with confirmation, optional `voice_asgi` service, slash commands (`/hoje`, `/semana`, `/app`, etc.), LLM agent with sheet tools | [README](services/agent/README.md) |
| [`apps/sheet4`](apps/sheet4) | Apps Script (JS) | Sheet 4.0: transactional engine with proven cell rollback (`writeState`), listener fault isolation, validated JSON API, **Acompanhamento** menu (`ui_hoje`, `wizard`, `Painel`, `Semanas`, `Progressão`), 3.0 → 4.0 migration (`apps/sheet` is legacy 3.0) | [setup](docs/setup/README.md) |
| [`apps/miniapp`](apps/miniapp) | HTML5, CSS, vanilla JS | Telegram Mini App zero-build for workout, food logging, and voice input; opens via bot inline button or `/app` | [spec](docs/specs/2026-11-09-miniapp-design.md) |
| [`docs`](docs/README.md) | Markdown | Monorepo documentation: architecture decisions (`docs/adr`), specifications (`docs/specs`), implementation plans (`docs/plans`), research spikes (`docs/research`), and setup guides (`docs/setup`) | [README](docs/README.md) |

## Architecture

```
Telegram ──webhook──▶ Cloud Run function or ASGI (Python, ADK agent + LiteLLM)
                         │ tools: get_catalog, save_diary, save_workout, save_food,
                         │        get_exercise_history, get_diary_history, get_phase, get_week
                         │        └──POST JSON──▶ Apps Script Web App (apps/sheet4) ──▶ Sheets
                         │             ◀── {ok, result} | {ok:false, errors[]}
                         └──▶ Telegram reply (+ buttons ✅ Ok · ↩️ Desfazer · ✏️ Corrigir)
                       /hoje, /ficha, /progressao, /exercicios, /semana, /fase, /desfazer, /app: Sheet API only, no model call

Telegram ──/app or button──▶ Mini App (apps/miniapp: zero-build forms for workout/food + voice)
Sheet menu "Acompanhamento" ──▶ Hoje screen / Wizard ──▶ same validator ──▶ same domain modules ──▶ Sheets
```

- **Topology**: one deploy per client. Each client has their own spreadsheet with a bound `apps/sheet4` Web App deployment and a dedicated agent deployment/configuration (`fitness-agent-<client>`, with its own `SHEET_API_URL`, `SHEET_API_KEY`, `ALLOWED_CHAT_IDS`, `TELEGRAM_BOT_TOKEN`).
- **Agent**: never touches the sheet directly. Handles text messages, chat voice audio (transcription and user confirmation), and slash commands. When the API rejects a payload, the error list (path,
  message, suggestions) goes back to the model, which fixes it and calls again. The reply echoes
  what the sheet says it wrote. Duplicate Telegram deliveries on the same instance are ignored in-memory
  (`UpdateDeduplicator`), and each write carries a deterministic `requestId` so HTTP retries and
  re-executions that emit the same tool arguments are idempotent in the sheet (complementing
  `catalog.recent`; if an older Web App deployment rejects `requestId`, the client falls back to
  sending the request without it).
- **Sheet API**: transactional engine with proven cell rollback (`writeState`) and listener fault
  isolation. Accepts exact JSON only, checks names against the `Exercícios`, `Alimentos`,
  `Refeições favoritas` and `Fichas` tabs, reports every error at once and writes nothing unless the
  whole request is valid.
- **Mini App**: Telegram Mini App (`apps/miniapp`) zero-build client offering interactive workout
  and nutrition logging with voice input, opened directly from Telegram chat via `/app` or inline keyboard.

Design and decisions: [`docs/specs`](docs/specs), [`docs/adr`](docs/adr), [`docs/plans`](docs/plans), [`docs/research`](docs/research). Overview: [`docs/README.md`](docs/README.md).

## Security model

- Telegram → agent: the webhook is registered with a `secret_token`; the function rejects
  requests without the matching `X-Telegram-Bot-Api-Secret-Token` header and ignores chats
  outside `ALLOWED_CHAT_IDS`.
- Agent → Apps Script: the Web App is public (Apps Script cannot check Google identities for
  a server caller without OAuth), so every request carries `SHEET_API_KEY` in the JSON body,
  compared with the Script Property of the same name.
- The model is reached through LiteLLM: provider and key are configuration (`LLM_MODEL`,
  `LLM_API_KEY` in Secret Manager), so switching provider needs no code change.

## Common tasks

A root `Makefile` wraps the everyday commands; run `make` (or `make help`) from the repo root to
list them: `install`, `test`, `lint`, `fmt`, `e2e`, `poll`, `serve`, `webhook-set` /
`webhook-info` / `webhook-delete`, `commands`, `push-sheet`. Each target is a thin wrapper, so the
underlying commands in the READMEs still work as written. CI calls the tools directly.

## Testing

```bash
make install      # once: cd services/agent && uv sync --locked
make test         # both suites: npm test (Apps Script) + uv run pytest (agent)
make lint         # ruff check, ruff format --check, ty check, npm run check
make e2e          # whole stack locally with the scripted provider (e2e/)
```

Or directly:

```bash
npm test                                   # Apps Script test suite (Node runner with in-memory fakes)
npm run check                              # Apps Script syntax check (--check across apps)
cd services/agent && uv run pytest         # Python agent test suite (fake sheet API and scripted LLM)
```

Neither suite needs network or a Google account.
