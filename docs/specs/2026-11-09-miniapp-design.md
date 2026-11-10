# Mini App: workout and food logging without the LLM

Status: MVP, single user (client `luan`). Rollout later: Zoio and Breno, after feedback.
Branch: `claude/miniapp-treino-alimentacao`.

## Goal

Remove the two biggest manual frictions (logging a workout, logging a meal) with a form that
opens inside Telegram. The form produces structured data with fixed fields; the bot validates it
strictly and writes through the existing Sheet API. **No LLM in this path.**

Principle (from review feedback on X): *lock the output to JSON with fixed fields and validate
it before it reaches the sheet; a years-long training log does not forgive a crooked row that
went in silently.* This path has two strict gates and one source of truth:

1. Bot gate (Python, new): pydantic models with `extra="forbid"`, strict types, the same limits
   as `apps/sheet4/src/api_validator.js`. Anything invalid is rejected with a readable list of
   errors; nothing is sent to the sheet.
2. Sheet gate (Apps Script, existing): `api_validator.js` rejects unknown fields, unknown names
   (`not_in_catalog` + suggestions), and writes nothing unless the whole request is valid.
3. The confirmation shown to the user is built **only from the sheet's response**
   (`summary.confirmation`), never from what the form sent.

(The LLM path already has gate 2 and rule 3; this spec does not change it.)

## Transport

The bot runs by long polling (`scripts/start-luan-bot.ps1`), with no public HTTPS endpoint.
So the Mini App uses `Telegram.WebApp.sendData(string)`:

- The bot sends a **reply keyboard** (`is_persistent: true`, `resize_keyboard: true`) with two
  `KeyboardButton`s carrying `web_app: {url}`: `🏋️ Treino` and `🍽️ Refeição`.
- `sendData` only works for Mini Apps opened from a KeyboardButton; it closes the app and
  delivers a `message` with `web_app_data: {data, button_text}` from the user's own chat. That
  message already arrives through `getUpdates` (`allowed_updates` includes `message`) and the
  existing `ALLOWED_CHAT_IDS` check applies. No initData validation is needed in this transport.
- `data` is at most 4096 bytes (UTF-8). The page must check the size before sending.

The page itself is static (HTML/CSS/JS, no build step, no npm dependencies) and must be served
over HTTPS (GitHub Pages, pending the user's approval). The only external script is
`https://telegram.org/js/telegram-web-app.js`.

## Bot → page: catalog in the URL fragment

Command `/app` (also offered by `/start`) calls `catalog()` and sends the reply keyboard. Each
button URL is `MINIAPP_URL + "#v=<view>&c=<blob>"` where `view` is `workout` or `food` and

    blob = base64url_nopad( raw_deflate( utf8( json_compact(catalog_v1) ) ) )

(raw deflate = zlib with `wbits=-15` in Python; `DecompressionStream("deflate-raw")` in the
browser). The fragment never reaches the web server.

`catalog_v1` (short keys, built from the Sheet API `catalog` result; omit empty fields):

```json
{
  "v": 1,
  "today": "2026-11-09",
  "tz": "America/Sao_Paulo",
  "client": "Luan",
  "next": "Push A",
  "sessions": ["Push A", "Pull A", "Legs A"],
  "plan": [{"s": "Push A", "e": "Supino reto", "g": "Peito", "p": "2×6–8 RIR 1", "l": "80×8, 80×7"}],
  "ex": [["Supino reto", "Peito"]],
  "foods": ["Arroz branco cozido"],
  "fav": ["Café da manhã padrão"],
  "meals": ["Café da manhã", "Almoço"],
  "units": ["g", "ml", "un"]
}
```

`p` = the plan row's prescription text, `l` = the last work text (`plan[].lastWork.text`). The
bot keeps the full URL under `MINIAPP_URL_MAX` characters (constant, default 4096) by dropping, in
order: all `l`, then all `p`, then `foods` (the page then accepts free food names, which the
sheet still validates). The command's reply says when something was dropped.

The URL goes stale (e.g. last work) until `/app` is sent again; the page always computes
"today" itself in `tz` and lets the user pick yesterday as well. Future dates are not offered.

## Page → bot: payload v1

`sendData(JSON.stringify(payload))`, compact, ≤ 4096 bytes. The `args` objects are **exactly**
the Sheet API args (same names, units and limits), so the bot does no field mapping:

```json
{"v": 1, "t": "workout", "id": "0123456789abcdef0123456789abcdef",
  "args": {"date": "2026-11-09", "session": "Push A", "complete": false,
  "exercises": [{"name": "Supino reto", "work": [{"kg": 80, "reps": 8, "rir": 1}],
                 "warmup": {"kg": 40, "reps": 10}, "pain": 0, "note": "ombro ok"}]}}

{"v": 1, "t": "food", "id": "0123456789abcdef0123456789abcdef",
  "args": {"date": "2026-11-09", "meal": "Almoço", "items": [
  {"food": "Arroz branco cozido", "qty": 150, "unit": "g", "measure": "Pesada"},
  {"favorite": "Café da manhã padrão", "portions": 1},
  {"description": "pastel de feira", "qty": 1, "unit": "un"}]}}
```

`id` (required): the submission id, exactly 32 lowercase hex characters (128 random bits). The
page makes one when a draft is started and keeps it with the draft and with its "last sent"
entry, so "Restaurar último envio" resends under the same id. "Limpar este treino" / "Limpar
refeição" start a new draft with a new id. The id is not part of `args` (never sent to the sheet).

Limits (mirror of `api_validator.js`; the bot model must match it exactly — read it, don't trust
this list blindly):

- `date`: `yyyy-MM-dd`, not in the future in the client's `TIMEZONE`.
- workout: `session` non-empty string; `exercises` 1..15 (0 allowed only with `complete: true`);
  exercise `{name, work: 1..2 × {kg: number 0..1000, reps: int 1..100, rir?: int 0..10},
  warmup?: {kg, reps}, feeder?: {kg, reps}, pain?: int 0..10, note?: ≤200 chars,
  equipment?: ≤100 chars}`.
- food: `meal` ≤60 chars; `items` 1..20; each item has exactly one of `food` / `favorite` /
  `description`; `{food, qty: 0.001..100000, unit?: ≤20, measure?: "Pesada"|"Rótulo"|"Estimada",
  note?}`, `{favorite, portions?: 0.01..50}`, `{description, qty?, unit?, note?}`.
- Numbers are JSON numbers. The page converts Brazilian input ("82,5") to `82.5` before sending
  and shows the parsed value; the bot never coerces strings.

## Bot handling of `web_app_data`

In `Handler._process_update`, a message with `web_app_data` (and an allowed chat) goes to a new
no-LLM path:

1. `json.loads` + pydantic validation (`v == 1`, `t` in {workout, food}, `id` as above). On
   failure: reply `⚠ Não gravei nada: …` with each error (path + message). Not transient.
2. Call `SheetClient.upsert_workout` / `add_food` with
   `request_id = f"tg:{chat_id}:miniapp:{op}:{id}"`. It does not depend on the Telegram update,
   so a restored resend (a new update, possibly after a bot restart that lost the retry button)
   is deduplicated by the sheet when the args are unchanged. The args are deliberately not part
   of it: a restored draft resent with different content after the first one was saved is
   refused by the sheet (`requestId` conflict) and the bot explains it, instead of a second,
   slightly different row going in. A new entry needs a fresh draft (the page's "Limpar").
   The sheet recognises a request id for at least 48 h (`REQUEST_ID_WINDOW_HOURS`), however many
   Log rows came after it.
3. Sheet `ok:false`: reply `⚠ Não gravei nada` + each error with its suggestions
   (`not_in_catalog` → "Você quis dizer: …"). `unavailable` → transient (same as today): the
   write is kept in memory for 24 h behind a "🔁 Tentar de novo" button, bound to the chat that
   sent it; a tap from another chat, or after the entry is gone, answers that the button expired
   and how to resend safely (restore + send unchanged).
4. Sheet `ok:true`: reply = `summary.confirmation(...)` from the response + `buttons.keyboard`
   with the `writeId`, so ✅ / ↩️ Desfazer / ✏️ Corrigir work as they do for the LLM path.

Never echo the incoming payload as if it were saved.

## UX (page)

- Two views: **Treino** and **Refeição**, chosen by `#v=`; switchable inside the page.
- Treino: session picker (default `next`); the session's plan exercises as cards with
  prescription and last work; per card 1–2 work sets (kg / reps / RIR steppers, "repetir última"
  pre-fill from `l` when parseable), optional warm-up/feeder, pain 0–10, note; add any catalog
  exercise; mark session complete. Cards left empty are not sent.
- Refeição: meal chips; accent-insensitive search over `foods`; qty + unit + measure; favourites
  as one-tap chips with portions; free description as a clearly marked fallback ("sem cálculo").
- A **review step** shows exactly what will be sent before `sendData` (via Telegram MainButton).
  Edits and navigation during its short "thinking" pause cancel it. Sending turns the MainButton
  off before `sendData`; it comes back only if `sendData` throws.
- Mascot avatar ("Shape", original SVG, states: idle / focused / happy / alert) gives short
  feedback lines; it never claims something was saved — the bot's reply does that.
- Follows Telegram `themeParams` (light/dark), safe areas, `HapticFeedback`; works at 360 px.
- Outside Telegram (no `initData`), a preview mode with a bundled **generic** sample catalog
  (no personal data) and a "Copiar JSON" button instead of `sendData`.

## Next after the MVP

- **Voice → draft:** a voice note is transcribed and parsed into payload v1, then offered as a
  pre-filled Mini App draft (review before sending), instead of writing directly. The extraction
  prompt and vocabulary (exercise and food names, "por", "RIR", portions) are refined iteratively
  from real notes.

## Out of scope for the MVP

Measures, diary, photo/barcode food lookup, multi-client rollout, public HTTPS endpoint for the
bot, LLM-path changes.
