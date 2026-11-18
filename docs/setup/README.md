# Setup from zero

Four stages, in order. Each one ends with a check, so you know it works before moving on.

| Stage | Time | Result |
|-------|------|--------|
| [1. Apps Script](#1-apps-script-in-the-spreadsheet) | ~15 min | sheet 4.0 API answering on a `/exec` URL, **Acompanhamento** menu in the sheet |
| [2. Telegram bot](#2-telegram-bot) | ~5 min | bot token and your chat id |
| [3. Agent on your machine](#3-agent-on-your-machine) | ~10 min | bot answering through local polling |
| [4. Cloud Run](#4-cloud-run) | ~30 min | bot answering through the webhook, deployed from GitHub |
| [Mini App (GitHub Pages)](#mini-app-github-pages) | ~5 min | formulário estático da Mini App publicado em `https://<owner>.github.io/<repo>/` |
| [Voz Mini App (Opcional)](#serviço-de-voz-da-mini-app-opcional--cloud-run) | ~10 min | gravação de voz ativa na Mini App via Cloud Run (`Dockerfile.voice`) |

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
| `APP_AUTH_SECRET` (optional) | `openssl rand -hex 32` | Cloud Run (bot e serviço de voz da Mini App) |

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

## Mini App (GitHub Pages)

O bundle estático de produção da Mini App (`apps/miniapp/`) é publicado via GitHub Pages usando o workflow [`.github/workflows/pages.yml`](../../.github/workflows/pages.yml):

1. No GitHub do repositório → **Settings → Pages → Build and deployment → Source**, selecione **GitHub Actions**.
2. Rode o workflow **Deploy Mini App (Pages)** manualmente em **Actions → Deploy Mini App (Pages) → Run workflow** para o primeiro deploy (ou aguarde um push na branch `main` alterando `apps/miniapp/**`).
3. Configure `MINIAPP_URL=https://<owner>.github.io/<repo>/` no serviço do agente (localmente no `.env` ou via `--update-env-vars MINIAPP_URL="https://<owner>.github.io/<repo>/"` no Cloud Run). Caso utilize o serviço `fitness-voice`, configure `VOICE_ALLOWED_ORIGINS=https://<owner>.github.io` — **apenas a origem (`scheme://host`), sem path ou barra final**.

## Serviço de Voz da Mini App (Opcional — Cloud Run)

A voz no **chat Telegram funciona sem este serviço** (basta configurar `TRANSCRIBE_API_KEY` ou `GEMINI_API_KEY` no bot). Este deploy isolado (`services/agent/Dockerfile.voice`) só é necessário para habilitar o botão de microfone e gravação de áudio dentro da **Mini App**.

### 1. Requisitos e Alertas de Custo (§5.1)

1. **`--max-instances 1` (ou `2`):** Limites de taxa, orçamentos diários de tokens e cache de idempotência residem na memória do processo por instância. Manter no máximo 1 a 2 instâncias reduz janelas de estouro de orçamento durante picos de tráfego. O Cloud Run trata esse valor como alvo e pode rodar brevemente mais instâncias em picos; cada instância extra inicia com contadores limpos.
2. **Spend Cap no Gemini (AI Studio):** Configure um teto de gastos (*spend cap*) no projeto Google Cloud/Gemini da chave de transcrição. Como o teto pode levar cerca de 10 minutos para cortar chamadas após ser atingido, os gastos continuam durante essa janela.
3. **Billing Budget com alerta por e-mail:** Configure obrigatoriamente um orçamento de faturamento (*Billing Budget*) com alerta por e-mail abaixo do teto de gasto (*spend cap*) antes de habilitar tráfego público, completando todos os 5 itens de §5.1 e prevenindo surpresas na fatura.
4. **Segredos via Secret Manager:** Carregue `APP_AUTH_SECRET`, `TRANSCRIBE_API_KEY` e `TELEGRAM_BOT_TOKEN` exclusivamente a partir do Secret Manager (`--set-secrets`). Nunca versionar nem manter segredos em texto puro.
5. **Scale to zero:** Escala a zero é permitida e esperada; cold starts resetam contadores em memória e conjuntos de uso único conformes §5.6 e §6.8 da especificação.
6. **`--allow-unauthenticated`:** Necessário pois as requisições partem do navegador do usuário (Mini App). A autenticação é feita via `Bearer` session token (emitido com validação de `initData` do Telegram ou link code) e política de `CORS` estrita aos domínios autorizados em `VOICE_ALLOWED_ORIGINS`.

### 2. Deploy do serviço standalone

Crie o segredo `APP_AUTH_SECRET` (mínimo de 32 caracteres gerados via `openssl rand -hex 32`) no Secret Manager e conceda acesso à service account:

```bash
PROJECT=PROJECT_ID; REGION=REGION; REPO=REPO
CLIENT=<client-slug>                      # e.g. breno ou zoio (um serviço por cliente)
SERVICE_VOICE=fitness-voice               # ou fitness-voice-${CLIENT}
SA=fitness-agent@$PROJECT.iam.gserviceaccount.com

# Criação do segredo compartilhado (caso ainda não exista)
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create APP_AUTH_SECRET_${CLIENT} --data-file=-
gcloud secrets add-iam-policy-binding APP_AUTH_SECRET_${CLIENT} --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor

# 1. Build e push da imagem isolada com Cloud Build (a partir da raiz do repositório)
gcloud builds submit services/agent \
  --config services/agent/cloudbuild.voice.yaml \
  --substitutions=_IMAGE=REGION-docker.pkg.dev/PROJECT_ID/REPO/fitness-voice:latest

# 2. Deploy do container no Cloud Run a partir da imagem gerada
gcloud run deploy fitness-voice \
  --image REGION-docker.pkg.dev/PROJECT_ID/REPO/fitness-voice:latest \
  --region $REGION \
  --service-account $SA \
  --allow-unauthenticated \
  --max-instances=2 \
  --set-env-vars ALLOWED_CHAT_IDS="<chat_id>",VOICE_ALLOWED_ORIGINS="https://<seu-usuario>.github.io" \
  --set-secrets APP_AUTH_SECRET=APP_AUTH_SECRET_${CLIENT}:latest,TRANSCRIBE_API_KEY=TRANSCRIBE_API_KEY:latest,TELEGRAM_BOT_TOKEN=TELEGRAM_BOT_TOKEN_${CLIENT}:latest
```

### 3. Conectar ao Bot e Testar

Após o deploy do serviço de voz:

1. Obtenha a URL do serviço gerado:
   ```bash
   VOICE_URL=$(gcloud run services describe fitness-voice --region $REGION --format 'value(status.url)')
   ```
2. Configure o bot do cliente (`SERVICE=fitness-agent-${CLIENT}`) com a URL e o mesmo segredo:
   ```bash
   gcloud run services update "$SERVICE" --region $REGION \
     --update-env-vars VOICE_API_URL="$VOICE_URL" \
     --update-secrets APP_AUTH_SECRET=APP_AUTH_SECRET_${CLIENT}:latest
   ```
3. **Teste com `/app`:**
   - Envie `/app` no chat do Telegram com o bot.
   - Abra o link gerado para a Mini App.
   - Verifique que o botão de microfone aparece no formulário.
   - Grave uma mensagem de voz, confira a transcrição exibida e confirme o envio.

