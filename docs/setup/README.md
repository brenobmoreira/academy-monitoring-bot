# Setup from zero

Four stages, in order. Each one ends with a check, so you know it works before moving on.

| Stage | Time | Result |
|-------|------|--------|
| [1. Apps Script](#1-apps-script-in-the-spreadsheet) | ~15 min | sheet 4.0 API answering on a `/exec` URL, **Acompanhamento** menu in the sheet |
| [2. Telegram bot](#2-telegram-bot) | ~5 min | bot token and your chat id |
| [3. Agent on your machine](#3-agent-on-your-machine) | ~10 min | bot answering through local polling |
| [4. Cloud Run](#4-cloud-run) | ~30 min | bot answering through the webhook, deployed from GitHub |

> **Deployment model (one deploy per client):** Each client spreadsheet has its own bound Apps Script deployment (`apps/sheet4`) and its own agent instance (e.g. `fitness-agent-breno`, `fitness-agent-zoio`), each configured with that client's `SHEET_API_URL`, `SHEET_API_KEY`, `ALLOWED_CHAT_IDS`, and `TELEGRAM_BOT_TOKEN`.

Keep these values at hand as you go; none of them belongs in the repo:

| Value | Where it comes from | Used by |
|-------|---------------------|---------|
| `SHEET_API_KEY` | `openssl rand -hex 24` | Script Properties and the agent |
| deployment id / `SHEET_API_URL` | `clasp deploy` | the agent |
| `TELEGRAM_BOT_TOKEN` | BotFather | the agent, `set-webhook.sh` |
| chat id (`ALLOWED_CHAT_IDS`) | `getUpdates` | the agent |
| `TELEGRAM_WEBHOOK_SECRET` | `openssl rand -hex 24` | Cloud Run and `set-webhook.sh` |
| `REMINDER_TOKEN` (optional) | `openssl rand -hex 24` | Cloud Run and the Cloud Scheduler jobs |

## 1. Apps Script in the spreadsheet

1. Open the spreadsheet → **Extensions → Apps Script** → Project Settings → copy the **Script ID**.
2. Push the 4.0 code:
   ```bash
   npm i -g @google/clasp
   clasp login
   cd apps/sheet4
   cp .clasp.json.example .clasp.json     # paste the Script ID; the file is gitignored
   clasp push -f
   ```
3. In the Apps Script editor → Project Settings → **Script Properties** → add `SHEET_API_KEY`
   with the value from `openssl rand -hex 24`.
4. Reload the spreadsheet. The **Acompanhamento** menu appears; click any item once and authorize
   the script:
   - **Migrating a 3.0 spreadsheet:** open **Acompanhamento → Sistema → Migrar 3.0 → 4.0**, paste
     the client JSON (`clients/<name>.json`) and run. The migration is logged as a single undoable
     action (`Desfazer última alteração` reverts to 3.0) and records every change in `Auditoria`.
   - **New empty spreadsheet:** open **Acompanhamento → Sistema → Configuração inicial**.
5. Publish the Web App and keep the `deploymentId` it prints:
   ```bash
   clasp deploy -d "v1"
   ```
   The URL is `https://script.google.com/macros/s/<deploymentId>/exec`.

**Check** — must answer `{"ok":true,...}` listing your exercises, foods and current phase:

```bash
curl -sL -H 'Content-Type: application/json' \
  -d '{"key":"<SHEET_API_KEY>","op":"catalog","args":{}}' \
  https://script.google.com/macros/s/<deploymentId>/exec
```

Later code changes: `clasp push` (or `make push-sheet` from the repo root) then `clasp deploy -i <deploymentId> -d "note"`. A plain push
does not change what the URL serves. When a change touches the Sheet API contract, deploy the updated Apps Script (`clasp push` + `clasp deploy -i`) on each client spreadsheet before merging agent changes to `main`.

When a change adds a column or a Hoje field (for example `waterL`, **Água L** in `Diário`), also run
**Acompanhamento → Sistema → Reaplicar layout** on each client spreadsheet after the deploy: it appends the
missing column and redraws Hoje. Running the migration again does not do it (the sheet is already 4.0).
Until then the API refuses the whole request that carries the new field, other fields included, with
"Rode Projeto → Sistema → Reaplicar layout". Check the new column and the Hoje row before releasing the agent.

Legacy 3.0 reference: [`apps/sheet/docs/setup.md`](../../apps/sheet/docs/setup.md).

## 2. Telegram bot

1. Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → note the **token** (or reuse an
   existing bot's token).
2. Send any message to the bot, open `https://api.telegram.org/bot<TOKEN>/getUpdates` and note
   `message.chat.id`.

## 3. Agent on your machine

The model is any LiteLLM provider (`LLM_MODEL` in `services/agent/settings.yaml`). The default is
Gemini, and the quickest access is an AI Studio key (no `gcloud` needed): create one at
<https://aistudio.google.com/apikey>.

```bash
cd services/agent
cp .env.example .env
```

Fill `.env`:

```
TELEGRAM_BOT_TOKEN=<token>
ALLOWED_CHAT_IDS=<chat id>
SHEET_API_URL=https://script.google.com/macros/s/<deploymentId>/exec
SHEET_API_KEY=<same value as the Script Property>
LLM_MODEL=gemini/gemini-3.8-flash      # optional; settings.yaml has the same default
LLM_API_KEY=<AI Studio key>
```

Telegram refuses polling while a webhook is set, so remove it first, then start polling:

```bash
TELEGRAM_BOT_TOKEN=<token> ../../scripts/set-webhook.sh delete
uv sync
uv run agent-poll
```

The repo-root `Makefile` has the same steps: `make webhook-delete`, `make install`, `make poll`
(`make` lists every target).

**Check** — send to the bot:

- `peso 82,4 dormi 7h30` → reply `DD/MM · Peso kg 82,4 · Sono h 7,5`, today's row in `Diário`.
- `upper: supino inclinado 60x8 62x8 rir 2` → a row in `Registro de treino`.

If the model call fails (for example, Gemini rejecting a tool schema), the terminal shows the
error; nothing is written in that case.

## 4. Cloud Run (one service per client)

Each client spreadsheet has its own Cloud Run service (`SERVICE=fitness-agent-<client>`, e.g.
`fitness-agent-breno`, `fitness-agent-zoio`) and per-client secrets (`TELEGRAM_BOT_TOKEN_<CLIENT>`,
`TELEGRAM_WEBHOOK_SECRET_<CLIENT>`, `SHEET_API_KEY_<CLIENT>`; `LLM_API_KEY` can be shared).

1. Install the Google Cloud CLI in WSL (<https://cloud.google.com/sdk/docs/install>), then
   `gcloud auth login`.
2. Follow **Deploy** in [`services/agent/README.md`](../../services/agent/README.md), in order:
   enable the APIs, create the `fitness-agent` service account,
   create the secrets for the client, and
   run `gcloud run deploy $SERVICE ...`.
3. Point Telegram at the client's function:
   ```bash
   export SERVICE=fitness-agent-<client>
   export TELEGRAM_BOT_TOKEN=<token> TELEGRAM_WEBHOOK_SECRET=<secret>
   export AGENT_URL=$(gcloud run services describe "$SERVICE" --region us-central1 --format 'value(status.url)')
   scripts/set-webhook.sh set       # webhook and the /command menu; or: make webhook-set
   scripts/set-webhook.sh info      # or: make webhook-info; "url" set, no "last_error_message"
   ```
4. Continuous deployment: Cloud Run console → `$SERVICE` → **Connect repo** → this GitHub
   repository, branch `^main$`, buildpacks, build context `/services/agent`, entry point
   `telegram_webhook`; in each client service's generated Cloud Build trigger set **Included files
   filter** to `services/agent/**`. Every push to `main` that touches the agent redeploys the
   connected client services (keeping each service's own env vars and secret bindings).

5. Optional reminders: a nightly "Faltou registrar hoje: …" when weight, sleep or steps are
   missing, and the weekly summary on Sunday evening. Follow **Reminder jobs** in
   [`services/agent/README.md`](../../services/agent/README.md): the `REMINDER_TOKEN` secret and
   two Cloud Scheduler jobs per client (`${SERVICE}-remind-daily`, `${SERVICE}-remind-weekly`)
   calling `POST /remind`. Skip it and the bot only answers messages.

**Check** — repeat the two messages from stage 3 with polling stopped. Nothing back? Cloud Run →
the function's **Logs**, and Apps Script → **Executions** for `doPost`. With the reminders:
`gcloud scheduler jobs run ${SERVICE}-remind-weekly --location us-central1` → the week's summary in
the chat.
