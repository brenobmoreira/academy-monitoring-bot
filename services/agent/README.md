# agent — Telegram fitness-log agent

Python 3.12 + [Google ADK](https://google.github.io/adk-docs/) + Gemini. Receives Telegram
messages, understands them, and writes through the Apps Script sheet API
([`apps/sheet`](../../apps/sheet)). It never touches the spreadsheet directly.

```
Telegram ─webhook─▶ main.telegram_webhook ─▶ Handler ─▶ Bot (ADK LlmAgent + Gemini)
                                                         │ get_catalog / save_diary /
                                                         │ save_workout / get_exercise_history
                                                         └──▶ SheetClient ─POST JSON─▶ Apps Script
```

| Module | Role |
|--------|------|
| `config.py` | Settings from environment variables |
| `sheet_client.py` | Calls the sheet API; network failures become `{ok:false, errors:[{code:"unavailable"}]}` |
| `tools.py` | ADK tools; return the API body as-is so the model fixes rejected payloads |
| `summary.py` | Confirmation text built from what the sheet reports it wrote |
| `bot.py` | Instruction, one ADK run per message, 8-LLM-call budget |
| `telegram.py` | `sendMessage`, `getUpdates` |
| `handler.py` | Allowlist, `/start`, run the bot, reply; never raises |
| `main.py` (+ root `main.py` shim) | Cloud Run function; checks `X-Telegram-Bot-Api-Secret-Token` |
| `poll.py` | Local long polling (`uv run agent-poll`) |

## Configuration

| Variable | Required | Notes |
|----------|----------|-------|
| `TELEGRAM_BOT_TOKEN` | yes | from BotFather |
| `ALLOWED_CHAT_IDS` | yes | comma-separated chat ids; others are ignored |
| `SHEET_API_URL` | yes | Apps Script Web App URL, ends with `/exec` |
| `SHEET_API_KEY` | yes | same value as Script Property `SHEET_API_KEY` |
| `TELEGRAM_WEBHOOK_SECRET` | webhook only | without it the function answers 403 to everything |
| `GEMINI_MODEL` | no | default `gemini-2.5-flash` |
| `TIMEZONE` | no | default `America/Sao_Paulo`; resolves "hoje" and "ontem" |
| `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` | yes for Vertex | read by the Gemini SDK |
| `GOOGLE_API_KEY` | alternative | AI Studio key instead of Vertex |

## Local development

```bash
cd services/agent
uv sync
cp .env.example .env            # fill in; .env is gitignored
gcloud auth application-default login   # for Vertex; or use GOOGLE_API_KEY
../../scripts/set-webhook.sh delete     # Telegram refuses polling while a webhook is set
uv run agent-poll
```

Checks:

```bash
uv run ruff check src tests && uv run ruff format --check src tests
uv run ty check src tests
uv run pytest            # unit tests, no network: fake sheet API, scripted LLM
```

## Deploy (Cloud Run functions)

One-time setup, in the GCP project that has Gemini/Vertex enabled:

```bash
PROJECT=<project-id>; REGION=us-central1
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  aiplatform.googleapis.com secretmanager.googleapis.com

# service account the function runs as, allowed to call Gemini and read the secrets
gcloud iam service-accounts create fitness-agent
SA=fitness-agent@$PROJECT.iam.gserviceaccount.com
gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SA --role=roles/aiplatform.user

for s in TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET SHEET_API_KEY; do
  read -rsp "$s: " v; echo; printf %s "$v" | gcloud secrets create $s --data-file=-
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
done
```

First deploy from this folder (`openssl rand -hex 24` makes a good webhook secret):

```bash
gcloud run deploy fitness-agent --source . --function telegram_webhook \
  --base-image python312 --region $REGION --service-account $SA \
  --allow-unauthenticated --timeout 120 --max-instances 2 \
  --set-env-vars GOOGLE_GENAI_USE_VERTEXAI=TRUE,GOOGLE_CLOUD_PROJECT=$PROJECT,GOOGLE_CLOUD_LOCATION=$REGION \
  --set-env-vars ALLOWED_CHAT_IDS=<your chat id>,SHEET_API_URL=<apps script /exec url> \
  --set-secrets TELEGRAM_BOT_TOKEN=TELEGRAM_BOT_TOKEN:latest,TELEGRAM_WEBHOOK_SECRET=TELEGRAM_WEBHOOK_SECRET:latest,SHEET_API_KEY=SHEET_API_KEY:latest
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
Nothing back? Cloud Run → Logs for the function, and Apps Script → Executions for `doPost`.
