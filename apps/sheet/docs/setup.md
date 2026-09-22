# daily-log — setup from zero

Everything below creates resources in **your** Google and Telegram accounts. The repo holds no
ids or secrets; you will store yours in Script Properties.

## 1. Spreadsheet

The script is **bound** to a spreadsheet and expects these tabs, each with its header row on
row 5 (except `Progressão`, whose header is row 9):

| Tab | Used for | Headers the code relies on |
|-----|----------|----------------------------|
| `Diário` | one row per day | `Data` plus any of: `Peso kg`, `Sono h`, `Passos`, `Cardio min`, `Muay Thai`, `Dieta completa`, `Cintura cm`, `Fome 1–5`, `Cansaço 1–5`, `Observações` |
| `Registro de treino` | one row per exercise per session | `Data`, `Sessão`, `Exercício`, `Equipamento / carga`, `kg série 1..4`, `Reps 1..4`, `Séries feitas`, `Volume kg×reps`, `RIR final`, `Dor 0–10`, `Técnica / adaptação`, `Ficha`, `Séries prescritas`, `Reps mín`, `Reps máx`, `Fase`, `ID sessão` |
| `Ficha de treino` | prescription | `Sessão`, `Exercício proposto`, `Séries adaptação`, `Séries após adaptação`, `Reps mín.`, `Reps máx.` |
| `Exercícios` | canonical names | `Exercício`, `Grupo` |
| `Histórico de fichas` | plan version | `Versão` |
| `Progressão` | per-exercise history | picker in `B5`; headers on row 9: `Data`, `Ficha`, `Exercício`, `kg 1..4`, `reps 1..4`, `Volume`, `Séries válidas`, `RIR final` |
| `Hoje` | manual entry screen | fixed cells, see `src/sheet_ui.js` (`HojeScreen.CELLS` and `TABLE`) |

Only input columns are written; formula columns are preserved. Header text is what matters,
not position. Yes/no cells receive `Sim` / `Não`.

## 2. Telegram bot

1. Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → note the **token**.
2. Send any message to your new bot, then find your **chat id**: open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `message.chat.id`.

## 3. Apps Script project (bound)

In the spreadsheet: Extensions → Apps Script. Project Settings shows the **Script ID**.

```bash
npm i -g @google/clasp
clasp login
cd apps/daily-log
cp .clasp.json.example .clasp.json      # paste the scriptId; file is gitignored
clasp push -f                            # replaces the empty Code.gs
```

### Script Properties

Project Settings → Script Properties:

| Key | Value |
|-----|-------|
| `TELEGRAM_BOT_TOKEN` | token from BotFather |
| `WEBHOOK_SECRET` | any long random string (`openssl rand -hex 24`) |
| `ALLOWED_CHAT_IDS` | your chat id (comma-separated if more than one) |
| `LLM_BASE_URL` | optional. Gemini: `https://generativelanguage.googleapis.com/v1beta/openai` |
| `LLM_API_KEY` | required when `LLM_BASE_URL` is set |
| `LLM_MODEL` | optional, default `gemini-2.5-flash` |
| `DIARY_SHEET` | optional, default `Diário` |
| `HEADER_ROW` | optional, default `5` |
| `REMINDER_HOUR` | optional, default `21` |

Without `LLM_BASE_URL` the bot still works for the diary with keywords
(`peso 82,4 sono 7h30 passos 8k muay sim`), but workouts need the LLM.

Reload the spreadsheet: a **Registro** menu appears (Salvar dia, Salvar treino, Atualizar
progressão). The first use asks you to authorize the script.

## 4. Deploy the Web App

First time:

```bash
clasp deploy -d "v0"          # prints a deploymentId; keep it
clasp deployments
```

Deploy → Web App must run as **Me** with access **Anyone** (that is what `appsscript.json`
declares).

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

## 6. Smoke test

Send `peso 82,4 sono 7h30` to the bot. Expect `21/09 · Peso kg 82,4 · Sono h 7,5` and today's
row in `Diário`. With the LLM configured, send
`upper: supino inclinado 60x8 62x8 rir 2` and expect a row in `Registro de treino`.
If nothing comes back, check Executions in the Apps Script editor for `doPost` errors.

## 7. Reminder trigger

In the editor, run `setupTriggers` once. It schedules `sendDailyReminder` daily at
`REMINDER_HOUR` in the project time zone (`America/Sao_Paulo`).

## Development

```bash
npm test        # Node built-in test runner against Apps Script fakes (no network, no Google)
npm run check   # syntax check of src/
```
