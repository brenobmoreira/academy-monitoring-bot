# agent — Telegram fitness-log agent

Python 3.12 + [Google ADK](https://google.github.io/adk-docs/) + [LiteLLM](https://docs.litellm.ai/).
Receives Telegram messages, understands them with any LLM LiteLLM supports, and writes through
the Apps Script sheet API ([`apps/sheet`](../../apps/sheet)). It never touches the spreadsheet
directly.

```
Telegram ─webhook─▶ main.telegram_webhook (Functions Framework)  ┐
                    asgi.app (uvicorn)                            ├─▶ webhook.process ─▶ Handler ─▶ Bot
                                                                  ┘      (secret check)             │
                     ADK LlmAgent ─▶ LiteLlm ─▶ LLM_MODEL (gemini/…, anthropic/…, openai/…, ollama/…)
                        │ get_catalog / save_diary / save_workout / get_exercise_history
                        └──▶ SheetClient ─POST JSON─▶ Apps Script
```

| Module | Role |
|--------|------|
| `settings.py` | `Settings`: every external value (env, `.env`, `settings.yaml`) |
| `llm.py` | `build_model`: the LiteLLM model from `LLM_MODEL`, `LLM_API_KEY`, `LLM_API_BASE` |
| `sheet_client.py` | Calls the sheet API; network failures become `{ok:false, errors:[{code:"unavailable"}]}` |
| `tools.py` | ADK tools; return the API body as-is so the model fixes rejected payloads |
| `summary.py` | Confirmation text built from what the sheet reports it wrote |
| `bot.py` | Instruction, one ADK run per message, `MAX_LLM_CALLS` budget |
| `telegram.py` | `sendMessage`, `getUpdates` |
| `handler.py` | Allowlist, `/start`, `/desfazer`, run the bot, reply; never raises |
| `undo.py` | `/desfazer`: `write.undo` on the latest write, reply built from what the sheet undid |
| `webhook.py` | What every HTTP entry does: `X-Telegram-Bot-Api-Secret-Token` check, hand the update over |
| `main.py` (+ root `main.py` shim) | Functions Framework entry — Cloud Run functions |
| `asgi.py` | ASGI app — uvicorn in any container; `GET /healthz` |
| `poll.py` | Local long polling (`uv run agent-poll`) |

## Configuration

All settings are fields of `Settings` in `src/agent/settings.py`, named after their environment
variables, as in the other Harbor services. Sources, highest precedence first:
**environment variables → `.env` (working directory) → `settings.yaml` → code defaults.**
Everything is read once when the process starts.

`settings.yaml` (committed) holds what is safe to publish and worth tuning:

| Key | Default | |
|-----|---------|-|
| `LLM_MODEL` | `gemini/gemini-3.8-flash` | LiteLLM `<provider>/<model>`; switching provider is only this plus the key |
| `MAX_LLM_CALLS` | `8` | model calls per message, corrections included |
| `TIMEZONE` | `America/Sao_Paulo` | resolves "hoje" and "ontem" |

Environment only (account-specific or secret; a YAML file containing a secret is refused):

| Variable | Required | Notes |
|----------|----------|-------|
| `LLM_API_KEY` | per provider | secret; key of the provider in `LLM_MODEL` (not needed for `vertex_ai/`, `ollama/`) |
| `LLM_API_BASE` | no | LiteLLM proxy or self-hosted endpoint |
| `TELEGRAM_BOT_TOKEN` | yes | secret |
| `ALLOWED_CHAT_IDS` | yes | comma-separated; other chats are ignored |
| `SHEET_API_URL` | yes | Apps Script Web App URL, ends with `/exec` |
| `SHEET_API_KEY` | yes | secret; same value as the Script Property |
| `TELEGRAM_WEBHOOK_SECRET` | webhook only | secret; without it every webhook call gets 403 |
| `SETTINGS_FILE` | no | path of the YAML to load; default `settings.yaml` here |

Model examples (`LLM_MODEL` → what else it needs):

| `LLM_MODEL` | Needs |
|-------------|-------|
| `gemini/gemini-3.8-flash` | `LLM_API_KEY` from [AI Studio](https://aistudio.google.com/apikey) |
| `vertex_ai/gemini-3.8-flash` | no key; `VERTEXAI_PROJECT`, `VERTEXAI_LOCATION` in the env and Google credentials (the Cloud Run service account, or `gcloud auth application-default login`) |
| `anthropic/claude-sonnet-5` | `LLM_API_KEY` from Anthropic |
| `openai/gpt-5.6` | `LLM_API_KEY` from OpenAI |
| `ollama/llama3` | `LLM_API_BASE=http://localhost:11434` |

### Changing settings without rebuilding

The image carries a default `settings.yaml`; a restart with a different file or variable is
enough. Two ways on Cloud Run, neither rebuilds the image:

```bash
# quick: one value as an env var (new revision, same image)
gcloud run services update fitness-agent --region $REGION --update-env-vars LLM_MODEL=gemini/gemini-3.1-flash-lite

# whole file: keep settings.yaml in Secret Manager, mounted as a file
gcloud secrets create agent-settings --data-file=settings.yaml          # first time
gcloud secrets add-iam-policy-binding agent-settings --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
gcloud run services update fitness-agent --region $REGION \
  --set-secrets /config/settings.yaml=agent-settings:latest --update-env-vars SETTINGS_FILE=/config/settings.yaml
# later changes: new version, then restart
gcloud secrets versions add agent-settings --data-file=settings.yaml
gcloud run services update fitness-agent --region $REGION --update-labels restarted=$(date +%s)
```

Any other container runtime works the same way: mount the file and set `SETTINGS_FILE`.

## Serving the webhook: two entry points, same behaviour

Both go through `webhook.process` (secret check → handler), so the choice is only about where
it runs.

| Mode | Entry | Run locally | Where |
|------|-------|-------------|-------|
| Functions Framework | `agent.main:telegram_webhook` (root `main.py` re-exports it) | `uv run functions-framework --source main.py --target telegram_webhook --port 8080` | Cloud Run **functions** (`gcloud run deploy --function telegram_webhook`) |
| ASGI | `agent.asgi:app` | `uv run uvicorn agent.asgi:app --port 8080` | any container: Cloud Run **service**, docker compose, a VM |

Local check of either one (a wrong secret must give 403):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8080/ \
  -H 'X-Telegram-Bot-Api-Secret-Token: wrong' -H 'Content-Type: application/json' -d '{}'
```

## Local development

```bash
cd services/agent
uv sync
cp .env.example .env                    # fill in; .env is gitignored
../../scripts/set-webhook.sh delete     # Telegram refuses polling while a webhook is set
uv run agent-poll
```

Checks:

```bash
uv run ruff check src tests && uv run ruff format --check src tests
uv run ty check src tests
uv run pytest            # unit tests, no network: fake sheet API, scripted model
```

End to end without Telegram or Google: [`e2e/`](../../e2e).

## Deploy (Cloud Run functions)

One-time setup:

```bash
PROJECT=<project-id>; REGION=us-central1
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com

# service account the function runs as, allowed to read the secrets
gcloud iam service-accounts create fitness-agent
SA=fitness-agent@$PROJECT.iam.gserviceaccount.com

for s in TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET SHEET_API_KEY LLM_API_KEY; do
  read -rsp "$s: " v; echo; printf %s "$v" | gcloud secrets create $s --data-file=-
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
done
```

With `vertex_ai/...` instead of an API key: enable `aiplatform.googleapis.com`, grant the
service account `roles/aiplatform.user`, skip the `LLM_API_KEY` secret and set
`VERTEXAI_PROJECT=$PROJECT,VERTEXAI_LOCATION=$REGION` in the env vars below.

First deploy from this folder (`openssl rand -hex 24` makes a good webhook secret):

```bash
gcloud run deploy fitness-agent --source . --function telegram_webhook \
  --base-image python312 --region $REGION --service-account $SA \
  --allow-unauthenticated --timeout 120 --max-instances 2 \
  --set-env-vars ALLOWED_CHAT_IDS=<your chat id>,SHEET_API_URL=<apps script /exec url> \
  --set-secrets TELEGRAM_BOT_TOKEN=TELEGRAM_BOT_TOKEN:latest,TELEGRAM_WEBHOOK_SECRET=TELEGRAM_WEBHOOK_SECRET:latest,SHEET_API_KEY=SHEET_API_KEY:latest,LLM_API_KEY=LLM_API_KEY:latest
```

`--allow-unauthenticated` is required because Telegram cannot send Google credentials; the
webhook secret header is what authenticates Telegram.

Then register the webhook:

```bash
export TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=...
export AGENT_URL=$(gcloud run services describe fitness-agent --region $REGION --format 'value(status.url)')
../../scripts/set-webhook.sh set
../../scripts/set-webhook.sh info
```

### Continuous deployment from GitHub

Cloud Run console → service `fitness-agent` → **Connect repo** (continuous deployment) →
GitHub → this repository → branch `^main$`, build type **Go, Node.js, Python, Java, .NET Core,
Ruby or PHP via Google Cloud's buildpacks**, build context directory `/services/agent`, entry
point `telegram_webhook`. In the created Cloud Build trigger, set **Included files filter** to
`services/agent/**` so only agent changes deploy. Env vars and secrets set above are kept.

Refresh `requirements.txt` whenever dependencies change (the buildpack installs from it):

```bash
uv export --no-dev --no-emit-project --no-hashes --format requirements-txt -o requirements.txt
```

## Smoke test

Send `peso 82,4 dormi 7h30` to the bot → `21/09 · Peso kg 82,4 · Sono h 7,5` and today's row in
`Diário`. Send `upper: supino inclinado 60x8 62x8 rir 2` → a row in `Registro de treino`.
Send `/desfazer` → `↩️ Desfeito: 21/09 · Upper (Supino inclinado)` and the row is empty again.
Nothing back? Cloud Run → Logs for the function, and Apps Script → Executions for `doPost`.
