# Setup from zero

Four stages, in order. Each one ends with a check, so you know it works before moving on.

| Stage | Time | Result |
|-------|------|--------|
| [1. Apps Script](#1-apps-script-in-the-spreadsheet) | ~15 min | sheet API answering on a `/exec` URL, **Registro** menu in the sheet |
| [2. Telegram bot](#2-telegram-bot) | ~5 min | bot token and your chat id |
| [3. Agent on your machine](#3-agent-on-your-machine) | ~10 min | bot answering through local polling |
| [4. Cloud Run](#4-cloud-run) | ~30 min | bot answering through the webhook, deployed from GitHub |

Keep these values at hand as you go; none of them belongs in the repo:

| Value | Where it comes from | Used by |
|-------|---------------------|---------|
| `SHEET_API_KEY` | `openssl rand -hex 24` | Script Properties and the agent |
| deployment id / `SHEET_API_URL` | `clasp deploy` | the agent |
| `TELEGRAM_BOT_TOKEN` | BotFather | the agent, `set-webhook.sh` |
| chat id (`ALLOWED_CHAT_IDS`) | `getUpdates` | the agent |
| `TELEGRAM_WEBHOOK_SECRET` | `openssl rand -hex 24` | Cloud Run and `set-webhook.sh` |

## 1. Apps Script in the spreadsheet

1. Open the spreadsheet → **Extensions → Apps Script** → Project Settings → copy the **Script ID**.
2. Push the code:
   ```bash
   npm i -g @google/clasp
   clasp login
   cd apps/sheet
   cp .clasp.json.example .clasp.json     # paste the Script ID; the file is gitignored
   clasp push -f
   ```
3. In the Apps Script editor → Project Settings → **Script Properties** → add `SHEET_API_KEY`
   with the value from `openssl rand -hex 24`.
4. Reload the spreadsheet. The **Registro** menu appears; click any item once and authorize the
   script.
5. Publish the Web App and keep the `deploymentId` it prints:
   ```bash
   clasp deploy -d "v1"
   ```
   The URL is `https://script.google.com/macros/s/<deploymentId>/exec`.

**Check** — must answer `{"ok":true,...}` listing your exercises:

```bash
curl -sL -H 'Content-Type: application/json' \
  -d '{"key":"<SHEET_API_KEY>","op":"catalog","args":{}}' \
  https://script.google.com/macros/s/<deploymentId>/exec
```

Later code changes: `clasp push` (or `make push-sheet` from the repo root) then `clasp deploy -i <deploymentId> -d "note"`. A plain push
does not change what the URL serves.

Details: [`apps/sheet/docs/setup.md`](../../apps/sheet/docs/setup.md).

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

## 4. Cloud Run

1. Install the Google Cloud CLI in WSL (<https://cloud.google.com/sdk/docs/install>), then
   `gcloud auth login`.
2. Follow **Deploy** in [`services/agent/README.md`](../../services/agent/README.md), in order:
   enable the APIs, create the `fitness-agent` service account,
   create the four secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `SHEET_API_KEY`,
   `LLM_API_KEY`),
   run `gcloud run deploy ...`.
3. Point Telegram at the function:
   ```bash
   export TELEGRAM_BOT_TOKEN=<token> TELEGRAM_WEBHOOK_SECRET=<secret>
   export AGENT_URL=$(gcloud run services describe fitness-agent --region us-central1 --format 'value(status.url)')
   scripts/set-webhook.sh set       # webhook and the /command menu; or: make webhook-set
   scripts/set-webhook.sh info      # or: make webhook-info; "url" set, no "last_error_message"
   ```
4. Continuous deployment: Cloud Run console → `fitness-agent` → **Connect repo** → this GitHub
   repository, branch `^main$`, buildpacks, build context `/services/agent`, entry point
   `telegram_webhook`; in the generated Cloud Build trigger set **Included files filter** to
   `services/agent/**`. From then on, every push to `main` that touches the agent redeploys it.

**Check** — repeat the two messages from stage 3 with polling stopped. Nothing back? Cloud Run →
the function's **Logs**, and Apps Script → **Executions** for `doPost`.
