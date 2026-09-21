# academy-monitoring-bot

Personal Telegram bots that write to Google Sheets, with no server: the whole backend is a
Google Apps Script Web App. Each bot lives in `apps/<name>` and is deployed independently
with [clasp](https://github.com/google/clasp).

Nothing here is tied to a specific account. All secrets and ids (bot token, chat id, spreadsheet
id) live in the Apps Script **Script Properties** of your own project, never in this repo.
Follow the app's setup guide to run your own copy from scratch.

## Apps

| App | What it does | Setup |
|-----|--------------|-------|
| [`apps/daily-log`](apps/daily-log) | Logs daily weight, sleep, training load and trained yes/no from a Telegram chat into a sheet, with a 21h reminder. | [apps/daily-log/docs/setup.md](apps/daily-log/docs/setup.md) |

## Architecture (shared by every app)

```
Telegram ──webhook──▶ Apps Script Web App (doPost) ──▶ Google Sheet
   ▲                          │
   └──── sendMessage ─────────┘   + time-based trigger for reminders
```

- **Telegram bot**: only a token from BotFather. Runs no code.
- **Apps Script Web App**: receives the webhook, parses, writes to the sheet, replies.
- **Google Sheet**: storage and the read interface. No dashboard in scope.
- **Trigger**: `ScriptApp.newTrigger(...).timeBased()` for scheduled messages.

## Security model

Apps Script Web Apps are public and anonymous, and request headers are not exposed to the script,
so Telegram's `secret_token` header cannot be checked. Every app therefore uses two layers:

1. A **secret in the webhook URL query string** (`?secret=...`) compared against Script Properties.
2. An **allowlist of chat ids** compared against Script Properties.

Requests failing either check are ignored with `200 OK` so Telegram does not retry.

## Layout conventions

```
apps/<name>/
├── .clasp.json.example   # copy to .clasp.json and fill in your scriptId (gitignored)
├── appsscript.json       # manifest: timeZone, runtime, webapp access
├── src/                  # .js files pushed by clasp
└── docs/setup.md         # zero-to-running guide for that app
```

Apps Script has no modules: every file shares one global scope. To keep it maintainable each file
exposes exactly one namespace object (`Config`, `Parser`, `SheetRepo`, `Telegram`, ...) and only
platform entry points are bare global functions (`doPost`, trigger handlers, `setupTriggers`).

## Deploying

`clasp push` uploads code but does **not** change what the public URL serves. Always redeploy the
existing deployment so the webhook URL stays the same:

```bash
clasp push
clasp deploy -i <deploymentId> -d "short note"
```

`scripts/set-webhook.sh` registers the Web App URL with Telegram using environment variables only.
