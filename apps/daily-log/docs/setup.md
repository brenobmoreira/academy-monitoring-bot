# daily-log — setup from zero

Everything below creates resources in **your** Google and Telegram accounts. The repo holds no
ids or secrets; you will store yours in Script Properties.

## 1. Telegram bot

1. Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → note the **token**.
2. Send any message to your new bot, then find your **chat id**: open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `message.chat.id`.

## 2. Google Sheet

1. Create a spreadsheet. Note its **id** from the URL (`/spreadsheets/d/<ID>/edit`).
2. The `log` sheet and its header row are created automatically on first write.

Columns: `date` (key, `yyyy-MM-dd`), `weight_kg`, `sleep_h`, `load`, `trained`, `raw`, `updated_at`.

## 3. Apps Script project

```bash
npm i -g @google/clasp
clasp login
cd apps/daily-log
clasp create --type webapp --title "daily-log" --rootDir src   # writes .clasp.json (gitignored)
clasp push
```

If you prefer, create the project in the browser and `cp .clasp.json.example .clasp.json` with its
`scriptId`.

### Script Properties

In the editor: Project Settings → Script Properties. Add:

| Key | Value |
|-----|-------|
| `TELEGRAM_BOT_TOKEN` | token from BotFather |
| `WEBHOOK_SECRET` | any long random string (`openssl rand -hex 24`) |
| `ALLOWED_CHAT_IDS` | your chat id (comma-separated if more than one) |
| `SPREADSHEET_ID` | spreadsheet id |
| `SHEET_NAME` | optional, default `log` |
| `REMINDER_HOUR` | optional, default `21` |

## 4. Deploy the Web App

First time:

```bash
clasp deploy -d "v0"          # prints a deploymentId; keep it
clasp deployments
```

Deploy → Web App must run as **Me** with access **Anyone** (that is what `appsscript.json`
declares). The first deploy asks you to authorize the scopes in the browser.

Every later change:

```bash
clasp push
clasp deploy -i <deploymentId> -d "note"   # same URL, new code
```

A plain `clasp push` does not change what the URL serves. If "I edited and nothing changed", you
skipped the redeploy.

## 5. Register the webhook

```bash
export TELEGRAM_BOT_TOKEN=...
export WEBAPP_URL=https://script.google.com/macros/s/<deploymentId>/exec
export WEBHOOK_SECRET=...        # same value as the Script Property
../../scripts/set-webhook.sh set
../../scripts/set-webhook.sh info
```

## 6. Smoke test (F0)

Send any text to the bot. Expect a reply `Logged for <date>: <your text>` and a new row in the
sheet. If nothing comes back, check Executions in the Apps Script editor for `doPost` errors.

## 7. Reminder trigger (F2)

In the editor, run `setupTriggers` once. It schedules `sendDailyReminder` daily at
`REMINDER_HOUR` in the project time zone (`America/Sao_Paulo`).

## Roadmap

- **F0** webhook round trip + fixed row (this guide)
- **F1** regex parser + upsert + confirmation of parsed fields
- **F2** daily reminder trigger
- **F3** LLM fallback when the regex extracts nothing

Open decisions: what `load` means (tonnage, RPE 1-10 or minutes) and which LLM provider F3 uses.
