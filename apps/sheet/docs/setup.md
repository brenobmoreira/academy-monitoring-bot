# sheet — setup from zero

The Apps Script project bound to the spreadsheet. It is the only write path into the sheet:
a strict JSON API (`doPost`) used by the agent in [`services/agent`](../../../services/agent),
and the **Registro** menu used inside the spreadsheet. It does not talk to Telegram or to an LLM.

Everything below creates resources in **your** Google account. The repo holds no ids or
secrets; yours go in Script Properties.

## 1. Spreadsheet

The script is **bound** to a spreadsheet and expects these tabs, each with its header row on
row 5 (except `Progressão`, whose header is row 9):

| Tab | Used for | Headers the code relies on |
|-----|----------|----------------------------|
| `Diário` | one row per day | `Data` plus any of: `Peso kg`, `Sono h`, `Passos`, `Cardio min`, `Muay Thai`, `Dieta completa`, `Cintura cm`, `Fome 1–5`, `Cansaço 1–5`, `Observações` |
| `Registro de treino` | one row per exercise per session | `Data`, `Sessão`, `Exercício`, `Equipamento / carga`, `kg série 1..4`, `Reps 1..4`, `Séries feitas`, `Volume kg×reps`, `RIR final`, `Dor 0–10`, `Técnica / adaptação`, `Ficha`, `Séries prescritas`, `Reps mín`, `Reps máx`, `Fase`, `ID sessão` |
| `Ficha de treino` | prescription; its `Sessão` values are the accepted sessions | `Sessão`, `Exercício proposto`, `Séries adaptação`, `Séries após adaptação`, `Reps mín.`, `Reps máx.` |
| `Exercícios` | the accepted exercise names | `Exercício`, `Grupo` |
| `Histórico de fichas` | plan version | `Versão` |
| `Progressão` | per-exercise history | picker in `B5`; headers on row 9: `Data`, `Ficha`, `Exercício`, `kg 1..4`, `reps 1..4`, `Volume`, `Séries válidas`, `RIR final` |
| `Hoje` | manual entry screen | fixed cells, see `src/sheet_ui.js` (`HojeScreen.CELLS` and `TABLE`) |

Only input columns are written; formula columns are preserved. Header text is what matters,
not position. Yes/no cells receive `Sim` / `Não`.

## 2. Apps Script project

In the spreadsheet: Extensions → Apps Script. Project Settings shows the **Script ID**.

```bash
npm i -g @google/clasp
clasp login
cd apps/sheet
cp .clasp.json.example .clasp.json      # paste the scriptId; file is gitignored
clasp push -f                            # replaces the empty Code.gs
```

Script Properties (Project Settings → Script Properties):

| Key | Value |
|-----|-------|
| `SHEET_API_KEY` | long random string (`openssl rand -hex 24`); the agent sends the same value |
| `DIARY_SHEET` | optional, default `Diário` |
| `HEADER_ROW` | optional, default `5` |

Reload the spreadsheet: the **Registro** menu appears (Salvar dia, Salvar treino, Atualizar
progressão). The first use asks you to authorize the script.

## 3. Deploy the Web App

First time:

```bash
clasp deploy -d "v0"          # prints a deploymentId; keep it
```

The manifest declares **Execute as: Me** and **Access: Anyone**; the agent has no Google
credentials, so the API key in the body is what authenticates it. The URL is
`https://script.google.com/macros/s/<deploymentId>/exec` → the agent's `SHEET_API_URL`.

Every later change:

```bash
clasp push                                 # or, from the repo root: make push-sheet
clasp deploy -i <deploymentId> -d "note"   # same URL, new code
```

A plain `clasp push` does not change what the URL serves.

## 4. API

`POST` JSON `{"key": "...", "op": "...", "args": {...}}`. The answer is always HTTP 200 (after a
302 redirect that clients must follow) with `{"ok": true, "result": ...}` or
`{"ok": false, "errors": [{"path", "code", "message", "suggestions?"}]}`.

| op | args |
|----|------|
| `catalog` | `{}` → today, time zone, current phase, sessions, exercises, plan |
| `diary.upsert` | `{"date": "2026-09-21", "fields": {"weightKg": 82.4, "sleepH": 7.5, "muayThai": true}}` |
| `workout.upsert` | `{"date": "2026-09-21", "session": "Upper", "exercises": [{"name": "Supino inclinado", "sets": [{"kg": 60, "reps": 8}], "rir": 2}]}` |
| `exercise.history` | `{"name": "Supino inclinado", "limit": 10}` |

Each exercise in the `workout.upsert` result also carries `previous`: the date, sets, volume and
sets done of its latest session before the written date, or `null`. The bot's confirmation
compares against it.

Nothing is coerced (`"82,4"` and `"sim"` are rejected), every error is reported at once, and a
request with any error writes nothing. The full rules are in
[`docs/specs/2026-09-22-python-agent-sheet-api-design.md`](../../../docs/specs/2026-09-22-python-agent-sheet-api-design.md).

Quick check from a terminal:

```bash
curl -sL -H 'Content-Type: application/json' \
  -d '{"key":"<SHEET_API_KEY>","op":"catalog","args":{}}' \
  https://script.google.com/macros/s/<deploymentId>/exec
```

## Development

```bash
npm test        # Node built-in test runner against Apps Script fakes (no network, no Google)
npm run check   # syntax check of src/
```

`make test-sheet` runs `npm test`; `make lint` includes `npm run check`.
