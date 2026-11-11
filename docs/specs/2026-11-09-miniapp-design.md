# Mini App: workout and food logging without the LLM

Status: MVP, single user (client `luan`). Rollout later: Zoio and Breno, after feedback.
Branch for live food totals: `claude/refeicao-macros`.

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
  "wk": [["Peito", 6], ["Tríceps", 4]],
  "foods": ["Arroz branco cozido"],
  "fav": ["Café da manhã padrão"],
  "meals": ["Café da manhã", "Almoço"],
  "units": ["g", "ml", "un"]
}
```

`wk` is the body map's data: work sets per muscle group over the last 7 days (today included), from the sheet's `catalog.recentGroups`. It is optional: a sheet deploy that does not send it leaves the map with the current form only. The page resolves group names to muscles in `src/body.js` (`ShapeBody.keysOf`).

`p` = the plan row's prescription text, `l` = the last work text (`plan[].lastWork.text`).
The combined example above is also the legacy link format. New buttons contain one view:

- Both: `v`, `today`, `tz`, `client`, and `view: "workout" | "food"`.
- Treino: `next`, `sessions`, `plan`, `ex`, `wk`.
- Refeição: `foods`, `fav`, `meals`, `units`, plus optional `ft`, `fv`, `fu`, `fh` below.

The new page hides and guards the view switch when `view` is set, including after leaving
review. A legacy link or the dev sample without `view` keeps the switch. An old page ignores
new keys; each launched view still has its original fields (own foods only on an old page).

The bot keeps each full URL under `MINIAPP_URL_MAX` (4096 characters). Only an oversized view
is trimmed: `fv` first (own names stay), then `wk`, all `l`, all `p`, then `foods`. The command
reports each actual removal with `DROPPED_LABELS`. Removing names also removes their indexed
values. If either URL still cannot fit, `CatalogTooLarge` is raised. Absent `foods` keeps manual
food entry, including after loading TACO; the sheet still validates every name.

### Shared TACO table and live nutrition

`catalog_()` reads Alimentos once (`foodsRead` lap). It derives the unchanged `foods` names
and `foodTable` (a separate timed step), filtering the latter through `Foods.isValid`:

    [name, baseUnit, baseQty, kcal, protein, carbs, fat, householdUnit|null, perHousehold|null]

Numbers are the stored values, without extra rounding. The bot sends own values as `fv` rows:

    [index_in_foods, index_in_fu, baseQty, kcal, protein, carbs, fat, household_index_in_fu|null, perHousehold|null]

`fu` is a unique unit string dictionary, removed together with `fv` when values are trimmed.
No food name or unit string is repeated in `fv`. Missing/invalid/ambiguous rows cannot produce page totals.
Base-unit aliases are canonicalized as the sheet does. Without `ft`, all sheet food names
remain in `foods`, and any available valid values go in `fv`; an older sheet simply has none.

`ft: "taco4"` is present only when **all 575 names** are in `foods`, compared with
`Foods.key_` / `Tabs.normalize_` (NFC, lowercase, collapsed whitespace; accents significant).
In that case `foods`/`fv` contain only own foods. The bot reads a generated names-only resource
with `importlib.resources` inside `agent/data/`, never via a repository-relative package path.
`build_foods.py` generates both files; `--names-only` regenerates the resource offline from
the existing page table. Do not hand-edit either generated JSON.

The page fetches the fixed same-origin `data/foods.taco.json`. During loading, HTTP/network/schema
failure or an eight-second timeout, own foods remain usable and one short status line says the
full list is unavailable. A late response after timeout cannot overwrite the form. On success,
the picker merges the shared names, searches all query words in any order, ignores case and
accents, and renders at most seven results with text nodes. Unknown table IDs cause no fetch.

**Additional correctness guard (`fh`)**: a name match does not prove a nutrition match:
`foods.seed` intentionally skips existing names, which may have different values or household
measures. The bot computes SHA-256 of the shared rows' eight value fields, in generated table
name order, as compact UTF-8 JSON (integral floats serialized as integers). The page hashes
the corresponding rows built from the file, using WebCrypto. It enables shared arithmetic
only if they match. If the digest is missing/different, any shared row is invalid/ambiguous,
or WebCrypto is unavailable, shared names still load but **all shared values stay out of the
sum**, with `Valores da tabela indisponíveis; soma parcial.` Own arithmetic is unaffected.
This conservative guard adds one catalog key and prevents silently using different TACO
values in an existing sheet. It never modifies or estimates a nutritional value.

Pure functions in `core.js` mirror `Units.convert` and `Foods.macros`: mass to mass, volume
to volume, no density conversion; household measure only when it matches that food's own
normalized measure. Converted quantities round to four decimals, each item's nutrients to two
before addition. Display: whole kcal, P/C/G grams to at most one decimal, decimal commas.
Each computable item shows kcal. Descriptions, favourites (ingredients are absent from the
catalog), unknown values and impossible units are excluded and counted explicitly. No known
values means no numeric total, rather than a misleading zero. The existing Pulso meal tips
are unchanged and still produce one line per tap. No payload or bot validation fields change.

Offline budget probe: `PYTHONPATH=services/agent/src python tools/taco/catalog_fixture.py`.
Fixture uses all 110 own rows from `clients/luan_alimentos.tsv`, the dev workout plan (14 rows),
and a 59-character example deployment URL. With 575 shared foods: Treino **1014**, Refeição
**3542** characters; no trims (554 characters spare on Refeição). Without TACO: **1014/3462**.
These are reproducible fixture measurements, not a live owner's `/app` receipt. URL length,
future catalogue growth and stored food values can change; opening a new `/app` refreshes the
snapshot. As before, only the bot's response confirms what was recorded.

`tools/taco/seed_sheet.py --dry-run` validates schema/numbers and prints only counts (575;
batches 250/250/75). Without `--dry-run`, it takes `SHEET_API_URL` and `SHEET_API_KEY` only
from the process environment, calls existing `foods.seed` sequentially and prints
`added/skipped/total` per batch. It never loads credential files or echoes credentials/response
bodies, stops on failure, and installs no dependency. Automated sheet tests run the real
validator over the actual Python-generated seed rows. Running a real seed remains a separate
owner-authorized operation; implementation and tests make no sheet/bot calls.

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

- Two views: **Treino** and **Refeição**, chosen by `#v=`; switchable for combined catalogs.
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
