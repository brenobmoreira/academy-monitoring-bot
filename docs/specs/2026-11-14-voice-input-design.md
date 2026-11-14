# Voice input — design

Date: 2026-11-14 · Status: revision 2, after the Codex review of `041ed06`; owner decisions taken
(§14) · Branch: `claude/voz-spec`

Voice becomes a **primary input** of the product: on the Telegram chat and in the Mini App now,
and later on the client PWA and the native app, through the same HTTP API. This spec decides the
pipeline, the confirmation step and its lifecycle, the voice service and its sessions, pluggable
sign-in, the Mini App record button, privacy and logging, and how the four gaps found by the C1
tests are closed. §13 splits the work into tasks that a cheaper model can implement without
making architecture decisions. §16 maps every review finding to the section that resolves it.

Inputs: C2 research (official Telegram and Gemini documentation, consulted 2026-11-14, summarised
in §2) and the C1 tests (`services/agent/tests/test_voice_path.py`, branch `claude/voz-testes`,
commit `59bf0f5`). It supersedes the first step of "Voice → draft" in
`2026-11-09-miniapp-design.md` §"Next after the MVP" (see §15).

## 1. Principles

1. **Transcribe once, then it is text.** Audio is turned into text by one dedicated call. Every
   model after that (the agent, its fallback of another provider, any future one) receives text.
2. **Nothing is written from voice without the person seeing what was understood**, and a
   confirmation can be used **at most once**, only while it is pending, by an atomic transition.
3. **The voice service never writes.** It returns text. Writes keep going through the existing
   paths (agent tools; Mini App payload), with their gates and confirmations built from the sheet's
   response.
4. **Sign-in is pluggable; the API accepts one credential: a short, revocable session.** Telegram
   is one way to obtain a session among others; the voice endpoint has no Telegram-specific shape
   and runs without the bot, the sheet or the Telegram SDK.
5. **No audio is kept**, and no audio, transcript, caption, typed text or credential reaches a log
   line, a traceback or a library's log record.
6. **Nothing here blocks the product order** (bot + Mini App → real database → coach web panel →
   client PWA → native app): identities are provider-agnostic, the API is versioned (`/v1`),
   nothing is stored in the sheet, and every in-memory store sits behind an interface that a
   database can replace. Where memory is not enough, the spec says so and states the limit.

## 2. Facts this design rests on

| Fact | Source | Consequence |
| --- | --- | --- |
| `sendData` carries at most 4096 bytes and closes the app; it works only for apps opened from a `KeyboardButton`. | C2, Telegram docs | Confirmed text from the page fits (§4.2); audio cannot travel this way. |
| `initData` is **empty** for apps opened from a keyboard button (how `/app` opens the page today, `apps/miniapp/src/app.js:23`) and in inline mode; filled for the menu button, inline buttons and `t.me/<bot>/<app>` links. | C2 | Today the page cannot sign in with `initData` (§6.10). |
| `setChatMenuButton` accepts a `chat_id`: the menu button can differ per chat. | Telegram docs, review finding 11 | §6.10 gives the real reasons for the migration order. |
| `getUserMedia` / `MediaRecorder` inside the Telegram WebView: **not verified** on iOS, Android or Desktop; iOS WebKit has known `NotAllowedError` bugs. | C2 | Detect, degrade, fall back to the chat (§7.6). Device checklist in §11.2. |
| Chrome/Android record WebM/Opus; Safari records `audio/mp4` (AAC), maybe WebM from 18.4. Gemini accepts webm, ogg, opus, m4a, aac, mp3, wav; `audio/mp4` is **not** in its list. | C2 | Format mapping with an `mp4 → m4a` relabel that must be verified (§3.2). |
| Gemini bills audio at 32 tokens/s. | C2 | Cost (§3.6) and budget unit (§5.6). |
| Today audio goes inline to the agent (`bot.py:263-267`), and ADK resends the user message on **every** model call of the agent loop (typically 3, up to `MAX_LLM_CALLS`). | code | Transcribing once is also cheaper (§3.6). |
| The Anthropic fallback drops `input_audio` silently; nobody is told. | C1 gap 2 | Closed by principle 1 (§8). |
| `RetryingClient` with the agent's defaults (30 s per attempt, 2 retries, waits 2 s and 4 s, then the fallback) can take over two minutes (~132 s measured by the review). | `llm.py`, review finding 7 | The transcriber has its own budget of attempts inside a hard 45 s deadline (§3.2). |
| Write request ids include a digest of the tool args (`tools.py:196-206`); the handler deduplicates by `update_id` (`handler.py:199-200`). | code | Neither stops a second agent run on the same confirmed text: §4.1 and §4.2 add their own state. |
| `log.exception` writes the exception message and traceback, which can carry the provider request (`bot.py:302`, `bot.py:305`, `handler.py:293`, `handler.py:316`); the mask in `logs.py:43` removes only registered secrets. `bot.py:288, 296, 302, 305, 310` interpolate the message text. | code, review finding 2 | Safe exception logging (§10). |
| `Settings` requires `SHEET_API_URL` and `SHEET_API_KEY` (`settings.py:83-84`); `build_handler` assembles sheet, agent and Telegram (`handler.py:467-475`). | code | The voice service gets its own settings and assembly (§5.1). |
| The command `Context` holds only sheet, date, chat id and `miniapp_url` (`commands.py:64-70`); `normalizeCatalog` keeps only known keys (`apps/miniapp/src/core.js:425-445`). | code | C7 and C6 change them explicitly (§13). |
| The bot runs by long polling on the owner's PC (`scripts/start-luan-bot.ps1`): no public HTTPS. | code | The voice service runs on Cloud Run, separate from the bot; deploying it is the owner's action (§5.1). |

## 3. Transcription

```
Telegram voice/audio ─▶ bot: limits ─▶ download ─┐
                                                  ├─▶ Transcriber ─▶ text ─▶ "🎙️ Entendi: …"
Mini App MediaRecorder ─▶ voice service ──────────┘                          │
                                                                             ▼
                              ✅ (atomic, once) or ✏️ corrected text ─▶ agent, as typed text ─▶ sheet
```

One module, `services/agent/src/agent/transcribe.py`, serves the bot and the voice service.

### 3.1 Model and credentials

`TRANSCRIBE_MODEL`, default `gemini/gemini-3.8-flash`: audio-native, accepts every format the
clients produce (with the relabel below), cheap per second, reachable through LiteLLM (already a
dependency; nothing new is installed).

Rejected for now: a Whisper-type API (another vendor and key; a candidate fallback later); the
browser's Web Speech API (not available in the WebViews we target, and it sends audio to a vendor
outside our control); local whisper.cpp (CPU on the owner's PC, new binaries).

Settings (shared mixin `TranscribeSettings`, used by the bot's `Settings` and by `VoiceSettings`,
§5.1), checked at load time:

| Setting | Default | Rule |
| --- | --- | --- |
| `TRANSCRIBE_MODEL` | `gemini/gemini-3.8-flash` | Provider prefix must be `gemini` or `vertex_ai`; anything else (e.g. `anthropic/…`) is a `ConfigError` (root of gap 2). |
| `TRANSCRIBE_API_KEY` (secret) | bot: `LLM_API_KEY` when `TRANSCRIBE_MODEL` has the same provider as `LLM_MODEL`; voice service: none | Required for `gemini` when it does not resolve; optional for `vertex_ai` (ADC). Registered for log masking. |
| `TRANSCRIBE_API_BASE` | none | Primary model only. **Never** inherited from `LLM_API_BASE` (a proxy for the agent may not take audio). |
| `TRANSCRIBE_FALLBACK_MODEL` | none | Same provider rule as the primary. |
| `TRANSCRIBE_FALLBACK_API_KEY` (secret) | the primary's resolved key when the fallback has the same provider | Required when the provider differs. The fallback never receives an `api_base`: the transcriber always hands `RetryingClient` an explicit fallback key, so `fallback_kwargs_` drops `api_base`. `TRANSCRIBE_API_BASE` together with a fallback whose key resolves to none (Vertex ADC) is a `ConfigError`, because then `fallback_kwargs_` would pass the base along. |
| `TRANSCRIBE_TIMEOUT_S` | 15 | Per attempt; must be ≤ `TRANSCRIBE_DEADLINE_S`. |
| `TRANSCRIBE_RETRIES` | 1 | Retries per model for transient errors. |
| `TRANSCRIBE_RETRY_WAIT_S` | 1.0 | First wait; doubles. |
| `TRANSCRIBE_DEADLINE_S` | 45 | Hard limit for the whole transcription: every attempt, wait and fallback. |
| `VOICE_MAX_SECONDS` | 90 | §3.5. |

### 3.2 The call

```python
class Transcriber:
    async def transcribe(self, audio: Audio, *, principal_key: str, deadline_s: float | None = None) -> Transcript
```

- `Audio(mime_type: str, data: bytes)`.
- Client stack: `RetryingClient(inner=MeteredClient(LiteLLMClient(), budget, principal_key),
  retries=TRANSCRIBE_RETRIES, wait_s=TRANSCRIBE_RETRY_WAIT_S, fallback_model=…,
  fallback_api_key=<resolved>)`. `MeteredClient` reserves and settles the budget around **each
  attempt** (§5.6); in the bot it is given the bot's own `Budget`.
- The whole call runs inside `asyncio.timeout(min(TRANSCRIBE_DEADLINE_S, deadline_s))`. The chat
  path passes the time left in the message budget (`MESSAGE_DEADLINE_AT`) minus `SEND_RESERVE_S`.
  When the deadline fires, the attempt in flight is cancelled and settled as "paid, unknown".
- Request: one system message (§3.3) and one user message whose only content is
  `{"type": "input_audio", "input_audio": {"data": <base64>, "format": <fmt>}}`; `temperature=0`,
  `max_tokens=600`, `timeout=TRANSCRIBE_TIMEOUT_S`, `api_key`/`api_base` as in §3.1, no tools.

MIME → LiteLLM `format` (parameters such as `;codecs=opus` are stripped; case-insensitive):

| MIME received | `format` | Note |
| --- | --- | --- |
| `audio/ogg`, `audio/opus` | `ogg` | Telegram voice notes |
| `audio/webm` | `webm` | Chrome, Android, maybe Safari ≥ 18.4 |
| `audio/mp4`, `audio/m4a`, `audio/x-m4a` | `m4a` | Safari. Same container as m4a; **acceptance by Gemini unverified** (checklist §11.2) |
| `audio/aac` | `aac` | |
| `audio/mpeg`, `audio/mp3` | `mp3` | `audio` messages without a MIME type default to `audio/mpeg` today |
| `audio/wav`, `audio/x-wav`, `audio/wave` | `wav` | |
| anything else | — | `unsupported_format` |

If the relabel is refused, `audio/mp4` keeps returning `unsupported_format` and the page falls back
to the chat (§7.6); no transcoding is added.

### 3.3 Prompt

System message, in Portuguese like the agent's instruction (`TRANSCRIBE_PROMPT` in
`transcribe.py`):

```text
Você transcreve áudios curtos em português do Brasil, gravados por uma pessoa que registra o
próprio treino de musculação, a alimentação e dados do dia (peso, sono, passos, água).

Regras:
1. Escreva exatamente o que foi dito, na ordem em que foi dito. Não resuma, não interprete, não
   corrija o conteúdo, não complete o que faltou e não responda a perguntas feitas no áudio.
2. Números sempre em algarismos, com vírgula decimal: "oitenta e dois e meio" → "82,5";
   "sete e meia" (horas de sono) → "7h30"; "oito mil passos" → "8000 passos".
3. Mantenha a forma falada de séries e cargas: "oitenta por oito" → "80 por 8"; "três de dez"
   → "3 de 10"; "rir dois" → "RIR 2". Não converta unidades.
4. Grafias usuais: supino, crucifixo, remada, puxada, desenvolvimento, elevação lateral,
   agachamento, leg press, stiff, terra, rosca, tríceps, panturrilha, RIR, aquecimento, feeder,
   work set, drop set, quilo (kg), grama (g), ml, colher de sopa, concha, fatia, unidade, whey,
   creatina, arroz, feijão, frango, ovo, batata-doce, aveia, banana, iogurte.
5. Trecho que não deu para entender: escreva [inaudível] no lugar dele. Nunca adivinhe um número.
6. Se não houver fala nenhuma, responda exatamente: <vazio>
7. Responda só com a transcrição, sem aspas, sem comentários e sem formatação.
```

The vocabulary is refined from counts of corrections, never their content (§10). Catalog names as
hints are a later improvement (§15).

### 3.4 Result

```python
class Usage(NamedTuple):
    prompt_tokens: int
    completion_tokens: int
    audio_tokens: int | None      # when the provider reports it; else None

class Transcript(NamedTuple):
    text: str
    model: str                    # the model that answered (primary or fallback)
    usage: Usage                  # of the successful attempt
    fallback: bool

class TranscribeError(Exception):
    code: Literal["unsupported_format", "too_long", "no_speech", "failed", "timeout",
                  "budget_exhausted", "disabled"]
    transient: bool               # True for failed, timeout, budget_exhausted
```

- Strip whitespace and one pair of surrounding quotes. Exactly `<vazio>`, empty, or only
  `[inaudível]` tokens → `no_speech`.
- More than 2000 characters → `failed` (a looping model; 90 s of speech is about 1500 characters).
- A missing `usage` in the provider response counts as the attempt's full reservation (§5.6) and is
  logged as a counter, never guessed downwards.

### 3.5 Duration and size

`VOICE_MAX_SECONDS = 90` (decision D2): a whole workout of six exercises takes about 60–80 s to
dictate; above 90 s the transcript stops fitting a quick read and one note tends to mix entries.

| Surface | What is guaranteed | What is not |
| --- | --- | --- |
| Chat | Telegram's `voice.duration` / `audio.duration` comes from Telegram and is checked **before** the download; over 90 s is refused. Missing duration → only `MEDIA_MAX_BYTES`. | — |
| HTTP | At most `VOICE_MAX_BYTES = 1_500_000` bytes per request (90 s of AAC at 128 kbps; the page asks for 32 kbps, about 360 KB), enforced while reading. The page stops recording at 90 s. `X-Audio-Duration-Ms` over 90 000 is refused. | **Bytes and the declared duration do not guarantee 90 s.** A crafted low-bitrate file of 1.5 MB can hold more than 20 minutes of Opus, and the header is whatever the client says. The server learns the real length only from the provider's usage, **after** the attempt is paid. |

After a successful HTTP transcription, if the audio length implied by usage (`audio_tokens`, or
`prompt_tokens − TRANSCRIBE_PROMPT_TOKENS` when absent; the constant is measured in C4b) exceeds
`32 × VOICE_MAX_SECONDS × 1.15`, the service answers `too_long` and does not return the text. The
attempt stays charged. The money bound for lying clients is therefore the budget (§5.6) and the
provider-side cap (§5.1), not the duration rule.

Bodies under 1 KB are `no_speech` without a model call. The page refuses recordings under 0.7 s.

### 3.6 Cost

Per note: audio `32 × seconds` tokens, prompt about 350 text tokens (C4b measures it), output about
1.4 tokens per spoken word.

| Note | Audio tokens | Prompt | Output | Total |
| --- | --- | --- | --- | --- |
| 20 s (a meal) | 640 | ~350 | ~70 | ~1 060 |
| 90 s (maximum) | 2 880 | ~350 | ~350 | ~3 580 |

Today a 20 s note inline in an agent run of 3 model calls costs 1 920 audio tokens; after C4 it
costs 640 audio tokens once plus the transcript (~70 tokens) per agent call. One extra round trip
adds about 1–3 s.

Monthly estimate per active client (8 notes a day, 25 s average): about 192 k audio, 84 k prompt
and 22 k output tokens. With prices `Pa`, `Pt`, `Po` in US$ per million tokens:

    cost/month ≈ 0.192·Pa + 0.084·Pt + 0.022·Po  (US$)

Example only (not a price list): at US$ 1 per million for all three, about US$ 0.30 a month per
client. C4b's report states the real prices of the configured model on the day.

## 4. Confirmation

### 4.1 Chat: the confirmation lifecycle

A voice or audio message, after the limits and the download, is transcribed and answered with a
plain-text message, sent as a reply to the voice message:

```
🎙️ Entendi:

<caption, if any>
<transcript>
```

with one row of inline buttons: `✅ Confirmar` (`vok:<vid>`), `✏️ Corrigir` (`vfix:<vid>`),
`✖️ Cancelar` (`vno:<vid>`).

**Identity.** `vid` = 16 lowercase hex characters from `secrets.token_hex(8)`, new per `Entendi`
(`vfix:` + 16 = 21 bytes, within the 64-byte `callback_data`).

**State.** A `VoiceConfirmations` store in the bot process (new module `agent/voice_confirm.py`)
keeps, per `vid`, only:

    chat_id, message_id (None until the message is sent), created_at, state, text_sha256

No transcript is stored. `text_sha256` is the SHA-256 of the exact text shown after the header.

**States and transitions**, each under one `threading.Lock` (the same pattern as
`UpdateDeduplicator`), so two taps processed concurrently cannot both win:

```
pending ──vok──▶ confirmed ──agent done──▶ done
   │                  └──────cut / write uncertain──▶ uncertain
   ├──vno──▶ cancelled
   ├──vfix─▶ superseded
   └──age > VOICE_CONFIRM_TTL_S (30 min)──▶ expired
```

`claim(vid, chat_id, action, now)` atomically: looks up the entry; if it is missing, belongs to
another chat, or is `pending` but older than the TTL (it becomes `expired`), returns the refusal;
if it is `pending`, moves it to the action's state and returns success; otherwise returns the
current state. Only `pending` ever moves. A confirmed entry is never re-run, whatever its outcome:
a failed or cut agent run tells the person to check `/hoje` (as today), and the button stays dead.

**Text.** On a successful `vok` or `vfix`, the text is read back from the bot's own message
(`callback_query.message.text`, which Telegram returns without HTML: the part after the header line
and the blank line) and its SHA-256 must equal `text_sha256`. A missing or inaccessible message
(`InaccessibleMessage`, `date` 0) or a mismatch → the claim is undone to `expired` and the toast
says so; nothing runs.

**Restart and cache loss: fail closed.** The store is memory only, by decision (N3): after a bot
restart, or after an entry is evicted (capacity 512; terminal entries go first, then the oldest
`pending`, which thereby becomes unknown), the `vid` is unknown, and an unknown `vid` **never
runs**. The tap answers `Expirou. Envie o áudio de novo ou digite.` and the keyboard is removed.
Terminal entries are kept for 24 h to answer late taps precisely, then dropped (dropped = unknown).
Removing the keyboard is cosmetic only: Telegram delivers taps on buttons that no longer exist,
and authorization comes from the state alone.

A webhook deployment with more than one bot instance would route a tap to an instance without the
entry: it fails closed (`Expirou`). Voice confirmation in webhook mode therefore requires one bot
instance until the database step backs `VoiceConfirmations` with shared storage.

**Responses** (the callback query is always answered first, at once):

| Tap | `pending` | `confirmed` | `done` / `uncertain` | `cancelled` | `superseded` | `expired` / unknown |
| --- | --- | --- | --- | --- | --- | --- |
| ✅ `vok` | toast `Registrando…`; remove keyboard; run the agent | `Já estou registrando.` | `Já enviado. Confira com /hoje.` | `Você cancelou este áudio.` | `Substituído pela correção.` | `Expirou. Envie o áudio de novo ou digite.` |
| ✏️ `vfix` | send the fix prompt (below) | same as above | same | same | `Já pedi a correção.` | same |
| ✖️ `vno` | remove keyboard; reply `Ok, não registrei nada.` | `Já estou registrando; para desfazer use ↩️ na confirmação.` | `Já enviado; para desfazer use ↩️ na confirmação.` | `Já cancelado.` | `Substituído pela correção.` | same |

**Running a confirmed text.** The agent runs on the recovered text exactly as if typed, with
`update_key_scope(f"tg:voice:{vid}")`, and the reply (usual confirmation with ✅/↩️/✏️) quotes the
`Entendi` message. Outcome: `done` when the run ended normally (written or not); `uncertain` when
the message deadline cut it or `Bot.reply` reported `WRITE_UNCERTAIN`.

**✏️ fix prompt.** `✏️ Envie o texto corrigido respondendo a esta mensagem. Toque para copiar:`
followed by the text in `<code>`, with `force_reply` and the placeholder
`Ex.: supino 80 por 8, 80 por 7`. The answer is a normal text message and goes to the agent without
a second confirmation. The handler recognises a reply to this prompt by its first line and passes
**no** reply context to the agent.

The confirmation is mandatory in this version (D4).

Limitation: a voice note sent as a swipe-reply to a bot confirmation loses that context (Telegram
does not nest replies); the person can say the date or session, or use ✏️ on the original
confirmation and type.

### 4.2 Mini App: confirmed text and its idempotency

After transcription the page shows `Entendi:` and the text in an **editable** textarea, with
MainButton `Enviar` and secondary actions `Regravar` and `Cancelar`. `Enviar` sends, through
`sendData`, a new payload type:

```json
{"v": 1, "t": "text", "id": "0123456789abcdef0123456789abcdef", "src": "voice",
 "text": "almoço 150 g de arroz e 120 g de frango"}
```

- `text`: 1..2000 characters after trimming, no control characters other than `\n`; `src`:
  `"voice"` (only value for now); `id`: 32 lowercase hex, a new one per recording; no other keys.
- The page checks the UTF-8 size of the whole payload (2000 characters of ordinary Portuguese are
  about 2.1 KB, but emoji take 4 bytes each); over 4096 bytes it refuses and asks to shorten.
- This is the first Mini App payload that goes through the model. The form payloads stay
  model-free; the type is explicit, never inferred.

**Idempotency before the agent** (C7). A `TextSubmissions` store in the bot process, keyed by
`(principal_key, "text", id)` where `principal_key = "telegram:" + str(chat_id)`, holds
`text_sha256`, `state` and `at`. Atomically, under one lock, before the agent:

| Found | Action and reply |
| --- | --- |
| nothing | insert `running`; run the agent with `update_key_scope(f"tg:{chat_id}:miniapp:text:{id}")` |
| same id, **different** text hash | `⚠ Não gravei nada: este envio já foi usado com outro texto. Grave de novo no app.` (not transient) |
| same hash, `running` | `Já estou registrando este envio.` |
| same hash, `done` | `Esse envio já foi registrado. Confira com /hoje.` |
| same hash, `uncertain` | `Esse envio pode ter sido gravado. Confira com /hoje antes de repetir.` |

After the run: `done` when it ended normally; `uncertain` when it was cut or reported
`WRITE_UNCERTAIN` (C7 adds `Answer.uncertain`); the entry is **removed** when the run failed with
nothing written and no uncertainty (model or sheet down before any write), so the same payload can
be retried. Entries live 48 h, capacity 1024 (oldest terminal first; a `running` entry is never
evicted). This catches the same payload in different updates, which `update_id` deduplication
cannot.

Residual: the store is memory only; after a bot restart an identical payload re-delivered by
Telegram could run again. That is the same exposure as today's `update_id` deduplication (also in
memory), narrowed further by the sheet, which deduplicates identical args under the stable scope
key. The page never re-sends a text payload by itself (it keeps no "last sent" for text).

When the launch mode changes (§6.10, step 2), the page sends the same object to
`POST /v1/messages`, which applies the same rule with the session's principal.

## 5. Voice service

### 5.1 Process, settings and hosting

A separate ASGI app, `agent/voice_asgi.py` (`uvicorn agent.voice_asgi:app`), assembled by
`build_voice_service(settings: VoiceSettings, *, transcriber=None, clock=None)`. It does **not**
import `handler`, `bot`, `sheet_client`, `telegram` or `commands`, and it needs none of their
settings. `agent/asgi.py` (bot webhook) is unchanged.

`VoiceSettings` (new, `agent/voice_settings.py`) uses the same loader as `Settings` (YAML file plus
`.env` plus environment, `check_no_secrets`, secret registration for masking, `logs.install()`),
through a shared base, and contains only: `TIMEZONE`, `ALLOWED_CHAT_IDS`, the `TranscribeSettings`
mixin, the `AuthSettings` mixin (§6.2), `TELEGRAM_BOT_TOKEN` **optional** (needed only by the
`tg_init_data` provider; absent → that provider is disabled), the limits of §5.5–5.6 and
`VOICE_ALLOWED_ORIGINS`. The bot's `Settings` is not relaxed: it still requires the sheet.

Acceptance test (C5c): with an environment that has no `SHEET_API_*`, no `LLM_*` and no
`TELEGRAM_BOT_TOKEN`, `VoiceSettings.load()` succeeds, the app starts (Starlette `TestClient`), a
session is obtained and `POST /v1/voice/transcriptions` answers `200` with a fake LiteLLM client.

Hosting (decision D1): a **Cloud Run service**, separate from the bot on the PC. Deploying it is
the owner's action; nothing in the spec or the tasks assumes it is live. Until it is, the bot's
`VOICE_API_URL` stays empty, `/app` adds no voice keys, and the page hides the record button. The
chat path (C4) works without it. Deployment requirements (documented in C5c's README, applied by
the owner):

- `max-instances=1`, because rate limits, budgets, single-use sets and the idempotency cache live
  in process memory (approximate limits, §5.6);
- a **provider-side spending cap** on the transcription key's project (a quota or budget limit in
  the provider console), the only hard money bound until shared storage exists;
- secrets (`APP_AUTH_SECRET`, `TRANSCRIBE_API_KEY`, `TELEGRAM_BOT_TOKEN`) from Secret Manager;
- scale to zero is allowed; §5.6 and §6.8 state what a cold start resets.

### 5.2 Routes

| Route | Purpose |
| --- | --- |
| `POST /v1/auth/sessions` | exchange a sign-in credential for a session (§6.7) |
| `POST /v1/voice/transcriptions` | audio in, text out |
| `OPTIONS` on both | CORS preflight |
| `GET /healthz` | liveness |

### 5.3 `POST /v1/voice/transcriptions`

```
Authorization: Bearer <session>       (the only accepted credential, §6.6)
Content-Type: audio/webm;codecs=opus  (any MIME in §3.2)
Content-Length: <bytes>               (optional; chunked bodies are accepted)
Idempotency-Key: <32 lowercase hex>   (required, one per recording)
X-Audio-Duration-Ms: <int>            (optional, measured by the client)

<raw audio bytes>
```

The body is the raw audio, not multipart (no form parser; the PWA and native apps send it the same
way). No cookies (`credentials: "omit"`), so there is no CSRF surface.

`200 OK`, `Content-Type: application/json`, `Cache-Control: no-store`:

```json
{"v": 1, "id": "0123456789abcdef0123456789abcdef", "text": "supino 80 por 8, 80 por 7, RIR 1"}
```

Errors, on both routes, use one shape with a message in Portuguese ready to show:

```json
{"v": 1, "error": {"code": "too_long", "message": "O áudio passou de 90 s. Grave um trecho mais curto.", "retry": false}}
```

| HTTP | `code` | When | `retry` |
| --- | --- | --- | --- |
| 400 | `bad_request` | missing/invalid `Idempotency-Key`, malformed header, body length different from `Content-Length` | false |
| 401 | `unauthenticated` | missing or malformed `Authorization`, bad MAC, unknown subject | false |
| 401 | `auth_expired` | valid session past `exp`, or revoked by `not_before` | false (page: renew, §7.2) |
| 403 | `forbidden` | authenticated, no longer allowed (§6.5) | false |
| 409 | `idempotency_conflict` | same key and principal, different body digest | false |
| 413 | `too_large` | over `VOICE_MAX_BYTES` (by `Content-Length`, or while reading) | false |
| 415 | `unsupported_format` | MIME not in §3.2 | false |
| 422 | `too_long` | declared duration over the limit, or usage over it (§3.5) | false |
| 422 | `no_speech` | §3.4, or body under 1 KB | false |
| 429 | `rate_limited` / `budget_exhausted` | §5.6, with `Retry-After` in seconds | true |
| 502 | `transcription_failed` | provider error after retries and fallback | true |
| 503 | `disabled` | `VOICE_API_ENABLED=false` or no transcriber configured | false |
| 504 | `timeout` | `TRANSCRIBE_DEADLINE_S` reached | true |
| 500 | `internal` | any unexpected exception; no detail in the body | true |

Every response, errors and 500 included, goes through the CORS middleware: the route functions
catch every exception themselves and turn it into the JSON shape above, so nothing reaches
Starlette's `ServerErrorMiddleware` (which sits outside CORS and would answer without CORS headers).

### 5.4 Processing order

Cheap checks first; the body is not read before authentication; the digest is compared before any
cached or in-flight result is used:

1. CORS middleware (wraps everything; answers preflights).
2. `VOICE_API_ENABLED` and transcriber present, else `disabled`.
3. Verify the session (§6.6) → principal; authorize scope `voice`.
4. Per-principal request rate limit (§5.6).
5. Headers: `Content-Type` (§3.2), `Idempotency-Key`, `Content-Length` if present (over the cap →
   `413` without reading), `X-Audio-Duration-Ms` if present (over the limit → `too_long`).
6. Take a concurrency slot (`VOICE_MAX_CONCURRENT`).
7. Read the body as a stream, counting bytes; over the cap → `413` and stop reading; with a
   `Content-Length`, a different final length → `400`.
8. `digest = SHA-256(body)`.
9. Idempotency (§5.5) with `(principal_key, Idempotency-Key, digest)`.
10. Under 1 KB → `no_speech` (recorded in the idempotency entry).
11. Transcribe (budget reserved per attempt inside, §5.6).
12. Usage check of §3.5.
13. Record the result in the idempotency entry; drop every reference to the audio; respond.

### 5.5 Idempotency

Key = `(principal_key, Idempotency-Key)`; every entry holds the body `digest`, a state
(`in_flight` with a future, or `finished` with the response) and its time.

- No entry → create `in_flight` with this digest and run.
- Entry with a **different digest** (in flight or finished) → `409 idempotency_conflict`, without
  waiting and without returning anything cached.
- `in_flight`, same digest → wait for the same future (no second model call).
- `finished`, same digest → the same response, no model call and no budget.
- Finished entries are kept **5 minutes** in memory (D6). Only `200` and `no_speech` are kept;
  other errors delete the entry so a retry runs again.

Because the endpoint writes nothing, this only saves cost and gives a stable answer across a dropped
connection. A cold start or another instance forgets entries: a retry then simply runs again.

### 5.6 Limits and the approximate budget

| Limit | Default (setting) |
| --- | --- |
| Body | 1 500 000 bytes (`VOICE_MAX_BYTES`) |
| Duration | 90 s (`VOICE_MAX_SECONDS`), §3.5 |
| Requests per principal | 6 per minute, 60 per day (`VOICE_RATE_PER_MIN`, `VOICE_RATE_PER_DAY`) |
| Token budget per principal | 120 000 tokens per day (`VOICE_DAILY_TOKENS`, prompt + completion, day in `TIMEZONE`) |
| Token budget for the whole process | 500 000 tokens per day (`VOICE_GLOBAL_DAILY_TOKENS`) |
| Concurrent transcriptions | 4 per process (`VOICE_MAX_CONCURRENT`); over it → 429 `rate_limited`, `Retry-After: 2` |
| Deadline | `TRANSCRIBE_DEADLINE_S` (45 s) for the whole transcription |

**Budget mechanics** (`agent/budget.py`, used by `MeteredClient` in both processes):

```python
class Budget(Protocol):
    def reserve(self, principal_key: str, tokens: int, now: datetime) -> Reservation | None  # atomic
class Reservation(Protocol):
    def settle(self, tokens: int) -> None    # replaces the reserved amount with the actual one
    def release(self) -> None                # the attempt cost nothing
```

- Before **every attempt** (primary, each retry, the fallback), `MeteredClient` reserves
  `E = 32 × VOICE_MAX_SECONDS + TRANSCRIBE_PROMPT_TOKENS + max_tokens` (3 880 by default) against
  both the principal's and the process's budget, atomically under one lock. Refused before the
  first attempt → `budget_exhausted`; refused before a later attempt → stop there with
  `budget_exhausted` (earlier attempts stay charged).
- After the attempt:
  - response with usage → `settle(prompt_tokens + completion_tokens)` (this can exceed `E` for a
    long file; the excess is charged);
  - response without usage → `settle(E)`;
  - provider error answered **before processing** (HTTP 400, 401, 403, 404, 413, 415, 429) →
    `release()`;
  - anything else (timeout, connection lost after sending, 5xx, cancelled by the deadline) →
    `settle(E)`: paid, unknown, counted in full.
- Fallback attempts follow the same rules; nothing is free because a fallback answered.
- A reservation belongs to the day it was made.

**This is an approximate limit, and the spec calls it that.** It is kept in process memory, so:
each instance has its own (hence `max-instances=1`); a cold start resets it (Cloud Run scales to
zero after idle, so the daily figure is really "per warm period"); and one request can overshoot by
its actual cost minus `E`. It limits bursts and accidents. The money ceiling is the provider-side
cap required in §5.1, until the database step backs `Budget` with shared storage.

The bot process uses the same `Budget` for chat voice notes (principal `telegram:<chat_id>`), with
the same defaults.

### 5.7 CORS and transport

- HTTPS only (Cloud Run terminates TLS).
- Starlette's built-in `CORSMiddleware` (no new dependency), restricted to `VOICE_ALLOWED_ORIGINS`
  (required when the service is enabled; typically the origin of `MINIAPP_URL`), methods
  `POST, OPTIONS`, request headers `Authorization, Content-Type, Idempotency-Key,
  X-Audio-Duration-Ms`, `expose_headers=["Retry-After"]`, no credentials, `max_age=600`.
- CORS is defence in depth, not authentication; a non-browser client is stopped by §6.
- Credentials travel only in the `Authorization` header or the exchange body, never in the URL.

### 5.8 Logged per request

Outcome `code`, HTTP status, byte length, declared duration, normalized format, latency, model,
`fallback`, usage tokens, attempts and how each was settled, and `principal = b64url(HMAC(K_log,
principal_key))[:12]`. Nothing else (§10).

## 6. Pluggable sign-in and sessions

### 6.1 Model

Two layers:

- **Sign-in providers** turn something the client has (a one-time code from the bot, Telegram
  `initData`, later a PWA magic link or a native-app login) into a `Principal`. They are used only
  by `POST /v1/auth/sessions`.
- **Sessions** are the only credential the API accepts. Every API route calls
  `Sessions.verify(bearer, scope, now)` and never sees how the person signed in.

```python
@dataclass(frozen=True)
class Principal:
    provider: str            # "telegram" now; later "pwa", "native", "coach"; tests use "test"
    subject: str             # stable id inside the provider
    chat_id: int | None      # Telegram reply target; None outside Telegram
    scopes: frozenset[str]

class AuthError(Exception):
    code: Literal["unauthenticated", "auth_expired", "credential_used", "forbidden"]

class SignInProvider(Protocol):
    kind: str                                    # "tg_link", "tg_init_data", later "magic_link"…
    def verify(self, credential: str, now: datetime) -> Principal: ...   # raises AuthError

class Directory(Protocol):                       # opaque reference ↔ principal
    def ref(self, principal: Principal) -> str: ...
    def resolve(self, provider: str, ref: str) -> Principal | None: ...

class Authorizer(Protocol):
    def allows(self, principal: Principal, scope: str) -> bool: ...

class Revocations(Protocol):
    def not_before(self, principal: Principal) -> int | None: ...   # unix seconds

class Sessions:
    def issue(self, principal: Principal, now: datetime) -> tuple[str, int]: ...  # token, exp
    def verify(self, token: str, scope: str, now: datetime) -> Principal: ...
        # strict parse, MAC, exp, resolve via Directory, Authorizer, Revocations, scope
```

All of it is pure code with an injected clock (`agent/auth.py`), tested without HTTP. The bot uses
only the code issuer (§6.4); the voice service uses the rest.

### 6.2 Keys

`APP_AUTH_SECRET`: one secret of at least 32 bytes, in the environment of both the bot (to issue
codes) and the voice service, registered for log masking. Independent sub-keys:
`K_x = HMAC_SHA256(APP_AUTH_SECRET, "academy-auth:" + x)` for `x` in `code`, `session`, `ref`,
`log`. Rotating the secret revokes every code and every session at once.

### 6.3 Opaque subject reference

Tokens never carry a Telegram id, chat id or any subject in clear (a MAC is not encryption):
`ref = b64url(HMAC_SHA256(K_ref, provider + ":" + subject))[:22]` (128 bits). The Telegram
`Directory` resolves a ref by computing it for each id in `ALLOWED_CHAT_IDS` and comparing with
`hmac.compare_digest` (the set is small). A ref is a stable pseudonym: two tokens of the same person
can be linked to each other, but not to the person without the secret. At the database step the
directory becomes a lookup table, with no change to the token formats.

### 6.4 One-time link code (`kind = "tg_link"`)

Needed because the keyboard button gives an empty `initData`. `/app` (C7) issues one code per call,
only for an allowed chat, and puts it in the Mini App link fragment (which never reaches the web
server):

    code = "c1." + B + "." + b64url(HMAC_SHA256(K_code, "c1." + B))
    B    = b64url(compact JSON {"r": ref, "j": <16 random bytes, b64url>, "e": <exp, unix s>})

- About 120 characters. `exp = now + APP_CODE_TTL_S` (default 900 s = 15 min).
- **Single use**: the `j` of each redeemed code goes into an in-memory set until its `exp`; a second
  redemption → `credential_used`.
- The code grants nothing by itself; it only buys one session.

### 6.5 Authorization and revocation

- `AllowedChats(ALLOWED_CHAT_IDS)`: a Telegram principal is allowed if its `chat_id` is in the set,
  exactly today's rule for chat messages. Checked at the exchange **and on every request**, so
  removing a chat from the set (configuration change, new revision) revokes its sessions at once.
- Per-person revocation: `APP_SESSION_NOT_BEFORE`, private configuration of the voice service, a
  list `"<chat_id>:<unix seconds>"`; sessions of that person issued before that time get
  `auth_expired`. Changing it is the owner's action (new revision). It survives restarts.
- Global revocation: rotate `APP_AUTH_SECRET`.
- At the database step, `Authorizer` and `Revocations` read tables (roles, per-session revocation,
  logout), behind the same protocols.

### 6.6 Session token

    session = "s1." + B + "." + b64url(HMAC_SHA256(K_session, "s1." + B))
    B       = b64url(compact JSON {"p": provider, "r": ref, "s": <12 random bytes, b64url>,
                                   "i": <iat>, "e": <exp>, "c": ["voice"]})

- `exp = iat + APP_SESSION_TTL_S` (default 43 200 s = 12 h, N1). No refresh: when it expires, the
  page obtains a new one from a still-valid credential, or asks for `/app`.
- Verification order: length ≤ 512, prefix, strict base64url (alphabet `A–Z a–z 0–9 - _`, no
  padding, canonical), MAC with `compare_digest`, JSON object with **exactly** the keys above and
  their types (`p`, `r`, `s` strings of bounded length; `i`, `e` non-negative integers, not
  booleans; `c` a list of known scopes), duplicate JSON keys rejected (`object_pairs_hook`),
  `e > now`, `i ≤ now + 60`, resolve, authorize, `not_before`, scope.
- Sent as `Authorization: Bearer <session>`.

### 6.7 `POST /v1/auth/sessions`

Request (JSON, at most 4 KB): `{"v": 1, "kind": "tg_link", "credential": "c1.…"}` or
`{"v": 1, "kind": "tg_init_data", "credential": "<initData>"}`. Exact keys, strings only.

`200`: `{"v": 1, "session": "s1.…", "expires_at": 1763150400, "scopes": ["voice"]}`.

Errors (shape of §5.3): `400 bad_request`, `401 unauthenticated`, `401 auth_expired`,
`401 credential_used`, `403 forbidden`, `429 rate_limited` (30 exchanges per minute per process,
20 sessions per day per principal), `503 disabled`, `500 internal`.

`tg_init_data` provider, for future launches that carry `initData` (§6.10): exchange only, never
accepted by the voice route directly.

1. Strict parse of the query string: every pair split once on `=`, percent-decoded as UTF-8; a
   **repeated key → `unauthenticated`**; required `hash` (64 lowercase hex), `auth_date` (ASCII
   digits only), `user`; total length ≤ 4096.
2. `data_check_string` = every pair except `hash`, as `key=value`, sorted by key, joined by `\n`.
3. `secret_key = HMAC_SHA256(key=b"WebAppData", msg=TELEGRAM_BOT_TOKEN)`; `expected =
   hex(HMAC_SHA256(secret_key, data_check_string))`; `compare_digest` with `hash`.
4. `now − auth_date > INITDATA_MAX_AGE_S` (default **300 s**, the shortest that covers opening the
   app and exchanging at start-up) → `auth_expired`; more than 60 s in the future → `unauthenticated`.
5. **Single use**: `hash` goes into an in-memory set for the age window; a second exchange →
   `credential_used`.
6. `user` parsed with duplicate keys rejected; `user.id` must be an integer (not a boolean) > 0.
   `subject = str(id)`, `chat_id = id` (the private chat with the bot has the user's id),
   `scopes = {"voice"}`.

The third-party Ed25519 `signature` validation is not needed (we hold the bot token) and is left
out. Tests build valid `initData` with a fake token such as `123:TEST`; no real token or id appears
in the repository.

### 6.8 Threat model

Assets: (A1) the transcription budget, i.e. money; (A2) a person's transcripts, which the API only
ever returns to the caller who sent the audio (it stores and serves nothing); (A3) future read and
write routes (§6.10 steps 2–4), which will accept the same sessions, so sessions must already be
fit for them; (A4) Telegram ids, which tokens must not expose.

| # | Threat | Controls | Residual |
| --- | --- | --- | --- |
| T1 | Someone obtains the link (code) from the keyboard URL: a shared screen with dev tools, a device left unlocked. Keyboard buttons cannot be forwarded. | Code valid 15 min, single use, opaque (§6.3–6.4); it only buys a 12 h session. | Within 15 min of `/app`, if the owner has not opened the app yet. |
| T2 | Someone obtains a session: device access, a dump of the page's `localStorage`, a malicious script in the page. | 12 h TTL; scope `voice` only (no data can be read, nothing written); per-person and global revocation (§6.5); the page loads no third-party script except Telegram's and renders text with text nodes. | Up to 12 h of budget spend by that person's session, bounded by §5.6 and the provider cap. When sessions gain write scopes (step 2), their TTL and storage are revisited. |
| T3 | Replay of captured `initData`. | Exchange only; 300 s age; single use by `hash`. | — |
| T4 | Replay after an instance restart: the single-use sets are lost. | `max-instances=1`; codes live 15 min, `initData` 300 s. | A code or `initData` already redeemed may be redeemed once more within its window after a cold start. |
| T5 | Forged or tampered tokens. | HMAC-SHA256 with separated sub-keys; constant-time comparison; strict parsing (duplicate keys, types, canonical base64url, bounded lengths). | — |
| T6 | Network attacker. | TLS; credentials in headers or body only, never in URLs sent to a server (the code rides in the fragment, which browsers do not send). | — |
| T7 | Cost abuse with a valid session or a crafted file. | Rate limits, concurrency cap, per-attempt reservations, approximate budgets, provider-side cap (§5.6). | Bursts after a cold start, bounded by the provider cap. |
| T8 | Logs as a leak. | §10. | — |
| T9 | Cross-site requests. | No cookies; CORS allowlist (defence in depth). | — |
| T10 | Telegram itself is compromised. | Out of scope: the platform is trusted, as it already is for every chat message. | — |

### 6.9 Left out now

Accounts, refresh tokens, logout and per-session revocation (database step); PWA magic links and
native logins (new `SignInProvider`s, same sessions); write scopes; Ed25519 `initData` validation;
graceful secret rotation with a previous key.

### 6.10 The keyboard button and the launch-mode migration

`sendData` works **only** from a keyboard button, and a keyboard button gives **no** `initData`.
Launching from the menu button or a `t.me` link gives `initData` but removes `sendData`, the only
way the forms reach the bot today (the bot has no public endpoint). So the launch mode does not
change in this spec. Migration, each step shippable alone:

| Step | Launch | Form and text submission | Sign-in | Ships with |
| --- | --- | --- | --- | --- |
| 0 (today) | keyboard button | `sendData` | — | — |
| 1 (this spec) | keyboard button, unchanged | `sendData` (forms and `t:"text"`) | `tg_link` code in the fragment → session | C5–C7 |
| 2 | keyboard button | `POST /v1/entries`, `POST /v1/messages` when the page has a session; `sendData` as fallback | `tg_link`, or `tg_init_data` when present | database step (D9) |
| 3 | menu button and `t.me/<bot>/<app>`; catalog from `GET /v1/catalog` | HTTP only; `sendData` retired | `tg_init_data` | after step 2 is proven |
| 4 | PWA, then native | same routes | their own providers | product order |

Why this order:

- Step 3 needs step 2 first because a menu-button or link launch has no `sendData`: the forms must
  already submit over HTTP.
- A per-chat menu button is possible (`setChatMenuButton` takes a `chat_id`), so step 3 could keep
  a catalog in the fragment by updating each chat's menu URL on every `/app`. It is not the plan
  because it keeps the 4096-character link budget and the stale snapshot, and adds a Telegram call
  per `/app`; `GET /v1/catalog` removes all three and is what the PWA needs anyway.
- In steps 2–3 an HTTP submission is not a Telegram message, so the server sends the confirmation
  to `principal.chat_id` with `sendMessage` when it is set, and always returns it in the HTTP
  response (what the PWA shows).

The page decides "inside Telegram" from `tg.platform` and the launch parameters, not from `initData`
(`app.js:23`), so step 1 changes nothing there.

## 7. Mini App

### 7.1 Catalog keys

In the catalog JSON next to `v`, `today`, `tz`, `client`: `vu` (voice service origin), `vc` (the
one-time code), `vx` (the code's `exp`). Old pages ignore them. C6 extends `normalizeCatalog`
(`core.js:425-445`) to keep them, validated, and to drop all three if any is invalid:

- `vu`: matches `^https://[a-z0-9.-]+(:[0-9]{1,5})?$` (origin only, no path);
- `vc`: matches `^c1\.[A-Za-z0-9_-]{20,200}\.[A-Za-z0-9_-]{43}$`;
- `vx`: a positive integer.

Link budget: about 300 characters after encoding; the Refeição fixture has 554 to spare. The keys
are never trimmed while other keys can be; if a link still does not fit after every existing trim,
the three are removed and `voz` is reported (`DROPPED_LABELS["voice"] = "voz"`) before
`CatalogTooLarge` is considered.

### 7.2 Session on the page

At start-up, when `vu` is present (or `initData` is non-empty and `vu` present):

1. A stored session for this `vu` (`localStorage` key `shape-miniapp:voice-session:v1`, value
   `{vu, session, expires_at}`) with more than 5 minutes left → use it.
2. Else, `initData` non-empty → exchange `tg_init_data`.
3. Else, `vc` with `vx` in the future → exchange `tg_link`.
4. Success → store the session (memory only if `localStorage` is unavailable). Failure → the
   button is shown disabled with the message of §7.5.

The exchange runs at start-up, not at the first tap, so that the 15-minute code is redeemed while
fresh. Later opens from the same persistent keyboard (whose code is used or expired) reuse the
stored session; when it expires, the button says `Envie /app para renovar a voz`. `auth_expired` or
`unauthenticated` from the voice route deletes the stored session.

### 7.3 When the record button appears

A microphone button in the dock, on both views (D8), shown when the page has `vu` and (a session,
or a credential it can still exchange), and:

1. `navigator.mediaDevices.getUserMedia` and `window.MediaRecorder` exist;
2. one of `audio/webm;codecs=opus`, `audio/ogg;codecs=opus`, `audio/mp4` passes
   `MediaRecorder.isTypeSupported` (tried in this order).

If the voice keys are there but 1–2 fail, the button is still shown and opens plan B (§7.6): voice
is central, so its absence is explained, not hidden. Without voice keys, no button. Outside Telegram
(preview) the button records and shows the text returned by a stub (`dev/`), never a real service.

### 7.4 States and recording

| State | UI | Mascot state | Leaves to |
| --- | --- | --- | --- |
| `idle` | mic button | (current) | `consent` on first use, else `asking_permission` |
| `consent` | one-time notice (§9.2), `Entendi` / `Agora não` | — | `asking_permission` / `idle` |
| `asking_permission` | `Permita o microfone…`, `Cancelar` | `listening` | `listening`, `idle`, `error` |
| `listening` | timer `0:12 / 1:30`, `Parar`, `Cancelar`; auto-stop at 90 s | `listening` | `sending`, `idle`, `error` |
| `sending` | `Entendendo…`, `Cancelar` (aborts the fetch) | `thinking` | `transcribed`, `error`, `idle` |
| `transcribed` | `Entendi:` + editable text; MainButton `Enviar`; `Regravar`, `Cancelar` | (current) | `sendData` (app closes), `asking_permission`, `idle` |
| `error` | message and actions from §7.5 | `alert` (existing) | `idle`, `sending` (retry), `asking_permission`, plan B |

`listening` and `thinking` are new mascot state **names** only; the art is being redrawn elsewhere.
While not `idle`, the form is read-only and its draft is kept (drafts already persist).

Recording rules:

- **Permission and cancellation.** Every attempt gets a new `generation` number. `Cancelar` during
  `asking_permission` bumps it and returns to `idle` at once. When `getUserMedia` resolves, if the
  generation changed, the page **immediately stops every track** of the returned stream and does
  not start a recorder: a cancelled permission prompt never turns the microphone on later.
- `getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true}})`;
  `new MediaRecorder(stream, {mimeType, audioBitsPerSecond: 32000})`; chunks collected until `stop`.
- On stop, cancel, error, `visibilitychange` to hidden, or `viewportChanged` collapsing the app:
  stop the recorder and **every track** at once (the OS microphone indicator must go off). An
  interrupted recording is discarded.
- Under 0.7 s → `Muito curto. Segure e fale.`; never sent.
- **The audio Blob lives only in memory, only while it can still be sent or retried.** It is
  created at `stop` and every reference to it and to its chunks is dropped on: `200`; `Cancelar`;
  `Regravar`; leaving `error` by any path other than retry; the end of the retry window (120 s after
  the failure); page hide. It is never written to `localStorage`, IndexedDB, the Cache API or any
  file. (JavaScript cannot zero memory; "destroyed" means no reference remains.)
- `fetch(vu + "/v1/voice/transcriptions", {method: "POST", credentials: "omit", headers, body})`
  with a 45 s `AbortController` timeout. `Idempotency-Key` from `crypto.getRandomValues`, reused only
  by `Tentar de novo` for the same Blob.
- Pure logic in `core.js` (format choice, reducer with generations, error mapping, Blob-retention
  rule as a pure "keep or drop" function, `t:"text"` builder and size check), tested with
  `node --test`; DOM, `MediaRecorder`, fetch and storage glue in a new classic script
  `src/voice.js`. No build step, no npm dependency.

### 7.5 Errors

| Cause | Message | Actions |
| --- | --- | --- |
| `NotAllowedError` / `SecurityError` | `Sem permissão para o microfone.` | `Tentar de novo`, `Gravar no chat` |
| `NotFoundError` / no supported format / API missing | `Este aparelho não grava aqui.` | `Gravar no chat` |
| network error, `timeout`, `transcription_failed`, `rate_limited` | `Não consegui entender agora.` | `Tentar de novo` (same key, within 120 s), `Gravar no chat` |
| `auth_expired`, `unauthenticated`, `credential_used` | `Envie /app para renovar a voz.` | `Gravar no chat` |
| `no_speech` | `Não ouvi nada. Fale mais perto do microfone.` | `Regravar` |
| `too_long`, `too_large` | `Passou de 1min30. Grave um trecho mais curto.` | `Regravar` |
| `unsupported_format` | `Este formato não funciona aqui.` | `Gravar no chat` |
| `budget_exhausted`, `forbidden`, `disabled`, `internal` | the server's `message` | `Gravar no chat` |

### 7.6 Plan B: the chat's own voice note

`Gravar no chat` shows `Feche e segure o 🎤 na conversa: eu transcrevo e confirmo com você.` and a
button that calls `Telegram.WebApp.close()`. The chat path (§4.1) works on every Telegram client,
needs no service and no WebView microphone.

## 8. The four C1 gaps

| # | Gap today | Fix | Test (C1 `test_gap_*` rewritten to the new behaviour) |
| --- | --- | --- | --- |
| 1 | `MEDIA_ENABLED=false` drops the caption too (`handler.py:329-330`). | With media off, a voice/audio/photo **with** a caption runs the caption as typed text and appends `MEDIA_DISABLED`; without a caption, only `MEDIA_DISABLED`. | `test_with_media_disabled_the_caption_is_still_processed` |
| 2 | The Anthropic fallback drops `input_audio` silently (`llm.py:90-91`, `bot.py:263-267`). | Audio never reaches the agent: an audio-capable model transcribes it (`Settings` refuses others) and the agent, any fallback included, gets text. A failed transcription is an explicit reply. | `test_a_fallback_of_another_provider_gets_the_transcript_as_text`; `test_settings_refuse_a_transcribe_model_without_audio` |
| 3 | `MEDIA_UNREADABLE` blames the model when media is disabled (`bot.py:52`). | `MEDIA_DISABLED = "Este bot está sem leitura de áudio e foto; envie em texto."`; `VOICE_FAILED = "⚠ Não consegui transcrever o áudio agora. Tente de novo ou envie em texto."` (transient); `VOICE_EMPTY = "Não ouvi nada no áudio. Tente de novo, mais perto do microfone."`; `VOICE_FORMAT = "Não leio esse formato de áudio; grave pelo 🎤 do Telegram ou envie em texto."`; `VOICE_BUDGET = "Hoje já transcrevi o máximo de áudios. Envie em texto."`. `MEDIA_UNREADABLE` stays for photos. | one test per message |
| 4 | Only a byte limit (`handler.py:138-141`). | `MediaRef.duration` from Telegram; over `VOICE_MAX_SECONDS` → `VOICE_TOO_LONG = "O áudio passou de 1min30. Envie um mais curto ou em partes."` before `getFile`. | `test_a_voice_note_over_the_duration_limit_is_refused_without_download` |

Prompt rule 16 (`bot.py:133`) drops the audio sentence and keeps the photo rules.

## 9. Privacy

### 9.1 Retention

- **Audio: none.** On the server, bytes live in memory only for the request (download or upload →
  model call), never on disk, in logs, traces, the sheet or any cache, including the idempotency
  cache (which keeps a digest, not the audio). On the client, the Blob lives only as §7.4 says. The
  Telegram voice note itself stays in the chat, as any message does; the person can delete it there.
- **Transcript:** in the `Entendi` message (chat) or the page's memory (Mini App); in the voice
  service's idempotency cache for 5 minutes; and, as structured entries, in what the agent writes
  to the sheet (as today). The confirmation and text-submission stores keep **hashes**, never text.
  Never in logs or traces.
- **Model provider:** the audio is sent to the transcription provider. Gemini API terms treat
  free-tier content differently from paid-tier content (free-tier content may be used to improve the
  provider's products). Voice for anyone other than the owner requires a paid-tier key or Vertex AI
  (D5); C4b's report quotes the terms in force on the day.

### 9.2 Consent

- Mini App, first use (`localStorage` `shape-miniapp:voice-consent:v1`; re-shown if storage is
  unavailable): `Seu áudio vai para transcrição automática (Google Gemini) e é apagado em seguida.
  Você confere o texto antes de eu registrar.` → `Entendi` / `Agora não`.
- Chat: `/start` and `/help` get one line: `🎙️ Pode mandar áudio: eu transcrevo, você confirma, e o
  áudio não é guardado por mim.`
- Rollout to other clients includes this notice in onboarding; voice notes about health-related
  entries are personal data under LGPD, covered by the same consent as the sheet, with the provider
  as a processor.

## 10. Logging

### 10.1 Never logged

At any level, in any process, in messages, arguments, tracebacks or library records: audio bytes or
base64; transcripts; captions; typed text sent to the agent; `Authorization` headers, codes,
sessions, `initData`, `hash`; the `Idempotency-Key`; and **exception messages and tracebacks** from
the provider, ADK, the agent run and the transcription (they can carry the request).

### 10.2 Safe exception logging

New in `agent/logs.py` (C4a):

```python
def describe(err: BaseException) -> str:
    """'ClassName[status=503 code=unavailable] <- CauseClass[...]', at most 5 links, cycle-safe."""
```

- Walks `err`, then `__cause__`, else `__context__`, at most 5 links, stopping on a repeat.
- Each link: the class's qualified name; `status=<n>` when the exception has an integer
  `status_code` or `status`; `code=<v>` when it has a `code` that is an integer or a string matching
  `^[A-Za-z0-9_.-]{1,40}$`. **Never** `str(err)`, `repr(err)`, `err.args`, or a traceback.

Rule for `agent/bot.py`, `agent/handler.py`, `agent/transcribe.py`, `agent/budget.py`,
`agent/voice_*.py`, `agent/auth.py` and anything they call with content: no `log.exception`, no
`exc_info=`, no `stack_info=`, no exception object or message text as a log argument. Instead:

    log.warning("transcription failed on update %s: %s", update_id, describe(err))

Sites changed by C4a: `bot.py:288, 296, 302, 305, 310` (also stop interpolating `text`: log the
update id and `len(text)`), `handler.py:293`, `handler.py:316`, `handler.py:342` (download), and
every new log line in later tasks. Commands and buttons that never carry client content keep their
logging.

**Library records.** `logs.install()` gains a `ContentGuard` step on the same hook that masks
secrets: a record whose logger name starts with `LiteLLM`, `litellm`, `google_adk`, `google.adk`,
`google_genai` or `httpcore` is rewritten (not dropped) to `"<logger> <level> record (content
omitted)"` + `describe(exc)` when it had `exc_info`, with `args`, `exc_info`, `exc_text` and
`stack_info` cleared, before any formatter runs. Levels and counts stay visible. LiteLLM verbose
mode stays off (`logs.py` explains why).

The voice service catches every exception in its routes and logs it with `describe` (§5.3), so
Starlette and uvicorn never log a traceback for it.

### 10.3 Tests (C4a, then every task touching these paths)

Sentinels: `AUDIO_SENTINEL = b"SENTINEL-AUDIO-7f3a"` (and its base64), `TEXT_SENTINEL =
"SENTINELA-TEXTO-91c2"`. Provoke: a provider exception whose message, `args` and **chained cause**
contain both; an agent run raising with both; a timeout in the middle of a transcription; a library
logger (`LiteLLM`, `google_adk`) emitting a record with both, with and without `exc_info`. Assert
neither appears in `record.getMessage()`, `repr(record.args)`, `record.exc_text`,
`record.stack_info`, nor in the **formatted output** of a `StreamHandler` using the service's real
formatter after `logs.install()`, nor in what `Handler.handleError` writes to stderr.

### 10.4 Counters

Without content: notes transcribed per surface, confirm / correct / cancel / expire rates,
`no_speech` rate, mean duration, error codes, budget settlements. They decide D4 and refine §3.3.

## 11. Tests

### 11.1 Automated

Python with the existing fakes (`tests/fakes.py`) and pytest; the page's pure logic with
`node --test` (`npm test`, `npm run check`). No test calls a real model, Telegram or the sheet.
Every task lists its tests in §13; the cross-cutting ones are §10.3 (logs), §5.1 (service starts
without the sheet) and §13 C5c's non-Telegram acceptance test.

### 11.2 Manual checklist for the owner (real devices)

On **iOS Telegram**, **Android Telegram** and **Telegram Desktop**, with a test bot and test sheet.
Note device, OS version, Telegram version and result.

Chat (after C4c):
1. Voice note of ~15 s with a meal → `🎙️ Entendi:` with the right text, as a reply to the note.
2. `✅ Confirmar` → confirmation from the sheet with ✅/↩️/✏️. Tap ✅ twice quickly on another note →
   one entry.
3. With the same account open on two devices, tap `✖️ Cancelar` on one and, before it refreshes,
   `✅ Confirmar` on the other → `Você cancelou este áudio.`, nothing written. (The concurrent and
   late-tap cases are covered by C4c's automated tests; this checks the real client.)
4. `✏️ Corrigir`, reply with a corrected text → one entry with the corrected values; then ✅ on the
   original → `Substituído pela correção.`
5. Restart the bot between `Entendi` and ✅ → `Expirou…`, nothing written.
6. Wait 31 minutes, then ✅ → `Expirou…`.
7. Voice note over 90 s → refused at once, nothing downloaded.
8. Silent note (3 s) → `Não ouvi nada…`.
9. `LLM_MODEL` unreachable, Anthropic `LLM_FALLBACK_MODEL`: a confirmed voice note is recorded
   correctly (the fallback gets text).
10. `MEDIA_ENABLED=false`: voice note with caption `peso 82,4` → weight recorded, media notice shown.

Mini App (after C5–C7 and the owner's deploy):
11. `/app`, open within 15 min → button enabled. Close, open again from the same keyboard an hour
    later → still enabled (stored session). After 12 h → `Envie /app para renovar a voz`.
12. `/app`, wait 16 minutes before the first open → disabled with the renewal message.
13. Record on each device: note the `mimeType`; the transcript arrives (on iOS this verifies the
    `audio/mp4 → m4a` relabel against the real Gemini API).
14. First use shows consent once; the OS prompt appears; refusing → `Sem permissão…`; `Gravar no
    chat` closes the app.
15. Tap the mic, then `Cancelar` **before** answering the OS permission prompt, then allow → the
    microphone indicator never turns on.
16. The microphone indicator turns off after `Parar`, `Cancelar`, and when the app is minimised.
17. Auto-stop at 1:30; a tap under 0.7 s is refused locally.
18. Edit the text, `Enviar` → app closes, confirmation from the sheet.
19. Airplane mode during `Entendendo…` → error with `Tentar de novo`; online again within 2 minutes,
    retry works; after 2 minutes the retry is gone (`Regravar` only).
20. Add the owner's chat to `APP_SESSION_NOT_BEFORE` with the current time (new revision) →
    `Envie /app para renovar a voz`; `/app` works again.
21. Forms still submit by `sendData` exactly as before.
22. Phone call or another app taking the microphone during `listening` → clean error.

Privacy:
23. After 1–22, search the bot's and the voice service's logs for a spoken word and for the code
    and session strings: no match.

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| The WebView refuses the microphone on some platform (unverified; iOS WebKit bugs). | Detection, explicit error, plan B (§7.6); checklist 13–16, 22. |
| Gemini refuses `audio/mp4` relabelled as `m4a`. | WebM/Opus preferred when supported; `unsupported_format`; plan B. No transcoding. |
| Transcription errors on numbers. | Mandatory confirmation with editable text; numbers-as-digits rule; vocabulary refined from correction counts. |
| A model "transcribes" silence or loops. | `<vazio>` sentinel, minimum length, 2000-character cap, confirmation. |
| A confirmation runs twice or after a cancel. | Atomic `pending`-only transitions with identity, TTL and fail-closed restart (§4.1); text verified by hash. |
| The same Mini App text runs twice. | `TextSubmissions` keyed by principal, type and id, with text hash and `running`/`uncertain` states (§4.2). Residual after a restart, equal to today's. |
| Content in logs through exceptions or libraries. | `describe`, no tracebacks on content paths, `ContentGuard` for library records, sentinel tests (§10). |
| Leaked code or session. | §6.8. |
| Cost runaway. | Per-attempt reservations, approximate budgets, rate and concurrency limits, `max-instances=1`, provider-side cap (§5.1, §5.6). |
| In-memory state is per process and reset by restarts. | Fail closed where it authorizes (confirmations); stated as approximate where it limits (budgets); the database step backs the same interfaces. |
| The service is not deployed. | Chat voice works without it; the page hides the button without `vu`. Deploy is the owner's action. |
| `localStorage` unavailable in some WebView. | Session kept in memory for that open; the next open needs a fresh code (`/app`). Checklist 11. |
| Free-tier provider terms. | Paid tier before other clients (D5). |

## 13. Tasks

Each task is one branch and one PR, sized for Sonnet, with no architecture left to decide. Rules
for all: no new dependencies; no secrets, real ids or client data in code, tests, fixtures or docs
(public repository); no push or deploy without the owner; existing suites stay green
(`uv run pytest` in `services/agent`, `npm test` and `npm run check` at the root); every new log
line follows §10.2.

Order: **C4a → C4b → C4c**; **C5a** and **C5b** after C4b; **C5c** after C5a and C5b; **C7** after
C5a and C4c; **C6** after the contracts (can be developed in parallel with C5/C7); **C8** last.

### C4a — Safe exception logging (Python)

- **Goal:** §10.2 and §10.3 in place before any voice code exists.
- **Files:** `agent/logs.py` (`describe`, `ContentGuard` inside `install()`); `agent/bot.py` and
  `agent/handler.py` (the listed sites); tests `tests/test_logs.py` (new cases),
  `tests/test_log_safety.py` (new, sentinels).
- **Depends on:** nothing.
- **Done when:** every assertion of §10.3 passes for the existing agent paths; no `log.exception`
  or `exc_info` remains in `bot.py`/`handler.py` content paths; the existing secret masking tests
  still pass.
- **Do not:** change what is logged for commands and buttons without content; touch behaviour.
- **Model:** Sonnet.

### C4b — Transcription module, budget and settings (Python)

- **Goal:** §3.1–3.6 and the `Budget` of §5.6, usable by both processes, not yet wired to the chat.
- **Files:** new `agent/transcribe.py` (`Audio`, `Usage`, `Transcript`, `TranscribeError`,
  `audio_format`, `TRANSCRIBE_PROMPT`, `TRANSCRIBE_PROMPT_TOKENS`, `MeteredClient`, `Transcriber`,
  `build_transcriber`); new `agent/budget.py` (`Budget`, `Reservation`, `MemoryBudget` with the
  per-principal and process limits); `agent/settings.py` (`TranscribeSettings` mixin and its
  checks, added to `Settings`; `VOICE_DAILY_TOKENS`, `VOICE_GLOBAL_DAILY_TOKENS`); `settings.yaml`
  (defaults, no secrets); tests `tests/test_transcribe.py`, `tests/test_budget.py`,
  `tests/test_settings.py`.
- **Depends on:** C4a.
- **Done when:** the §3.2 table, the §3.4 result rules and the §5.6 settlement rules are tested;
  a provider that never answers ends at `TRANSCRIBE_DEADLINE_S` (fake clock or a short deadline)
  even with retries and a fallback configured; credential and `api_base` resolution follows §3.1,
  including both `ConfigError` cases; `Transcript.usage` is filled from the response.
- **Tests:** every MIME; prompt, `temperature=0`, `max_tokens`, `input_audio`; `<vazio>`,
  `[inaudível]`-only, >2000 characters; transient → retry → fallback with its own key and no
  `api_base`; a 400 releases the reservation, a timeout settles `E`, a success settles actual
  usage; budget refused before the first attempt and before the fallback; day rollover in
  `TIMEZONE`; concurrent reservations never exceed the limit.
- **Do not:** touch the handler or the chat; add audio parsing or transcoding; change
  `RetryingClient` for the agent.
- **Model:** Sonnet.

### C4c — Chat confirmation lifecycle and the C1 gaps (Python)

- **Goal:** §4.1 and §8 in the bot.
- **Files:** new `agent/voice_confirm.py` (`VoiceConfirmations`, states, `claim`); `agent/handler.py`
  (`MediaRef.duration`, audio → `Transcriber` with the message deadline, `Entendi` message, the
  `vok`/`vfix`/`vno` taps with early callback answers, gap 1); `agent/buttons.py` (voice keyboard
  with `vid`, header constant, `transcript_from`, fix prompt); `agent/bot.py` (messages of §8,
  rule 16); `agent/commands.py` (help line); tests `tests/test_voice_confirm.py`, updates to
  `test_handler.py`, `test_buttons.py`, `test_voice_path.py` (cherry-pick `59bf0f5` first).
- **Depends on:** C4b, C1 commit `59bf0f5`.
- **Done when:** every cell of the §4.1 response table has a test; audio never reaches
  `Bot.reply`; photos unchanged; §10.3 sentinel tests extended to the voice path.
- **Tests:** confirm vs cancel and confirm vs fix run **concurrently** (two tasks, one store): one
  wins, the other gets the table's answer, the agent runs at most once; double confirm → one run;
  a new `Handler`/store (restart) → unknown `vid` → expired, no agent call, no download; eviction
  (capacity 2 in the test) → expired; TTL with a fake clock; hash mismatch and inaccessible message
  → expired; tap from another chat → refused; cut run → `uncertain`; the four gap tests; the
  duration check happens before `getFile`.
- **Do not:** store transcripts; persist state to disk; change the photo path or the form payloads.
- **Model:** Sonnet.

### C5a — Sign-in providers, sessions and directory (Python, pure)

- **Goal:** §6.1–6.7 as pure code, no HTTP.
- **Files:** new `agent/auth.py` (`Principal`, `AuthError`, protocols, `derive_keys`,
  `TelegramDirectory`, `AllowedChats`, `ConfigRevocations`, `LinkCodes` with `issue` and the
  `tg_link` provider, `TelegramInitData` provider, `Sessions`, strict base64url/JSON helpers);
  `AuthSettings` mixin (`APP_AUTH_SECRET`, `APP_CODE_TTL_S`, `APP_SESSION_TTL_S`,
  `INITDATA_MAX_AGE_S`, `APP_SESSION_NOT_BEFORE`) in a new `agent/voice_settings.py`; tests
  `tests/test_auth.py`.
- **Depends on:** C4a (logging rule only).
- **Done when:** every verification step of §6.4, §6.6 and §6.7 has a passing and a failing test.
- **Tests:** codes and sessions valid / tampered payload / bad MAC / expired / wrong version /
  non-canonical base64url / padding / duplicate JSON keys / wrong types (boolean for an integer) /
  extra or missing keys / over-long token; code single use; `initData` valid, tampered, wrong token,
  expired at 301 s, future, repeated key, non-digit `auth_date`, `user.id` boolean or string,
  single use; refs never contain the id; revocation by `not_before` and by removal from the
  allowlist; key separation (a code's MAC does not verify as a session).
- **Do not:** add HTTP; put a subject or chat id in clear in any token; accept a code or `initData`
  as an API credential.
- **Model:** Sonnet (Codex review of the HMAC and parsing code is required).

### C5b — Rate limits, concurrency and idempotency (Python, pure)

- **Goal:** §5.5 and the request limits of §5.6, as pure code.
- **Files:** new `agent/voice_limits.py` (`RateLimiter` per principal per minute and day,
  exchange limiter, `ConcurrencyGate`, `IdempotencyCache` with digest-first semantics, the single-use
  `UsedSet` used by C5a if not already there); tests `tests/test_voice_limits.py`.
- **Depends on:** C4b (`Budget` shape, for consistent clocks and day boundaries).
- **Done when:** the §5.5 bullet list is tested exactly, including the order: a different digest
  gets `idempotency_conflict` both while the first request is in flight and after it finished, and
  never receives the cached result.
- **Tests:** in-flight join (two concurrent calls, one underlying run); finished replay without a
  run; only `200`/`no_speech` cached; expiry at 5 min; sliding windows with a fake clock; gate
  release on exceptions.
- **Do not:** add HTTP; store audio (digests only).
- **Model:** Sonnet.

### C5c — Voice service ASGI integration (Python)

- **Goal:** §5.1–5.4, §5.7–5.8 and §6.7 over HTTP.
- **Files:** `agent/voice_settings.py` (`VoiceSettings` with the shared loader); new
  `agent/voice_api.py` (route logic: auth, order of §5.4, error shapes, streaming read);
  new `agent/voice_asgi.py` (`build_voice_service`, Starlette app, `CORSMiddleware`); `pyproject.toml`
  only if a console script is wanted (no dependency); `services/agent/README.md` (how to run, the
  deploy requirements of §5.1 for the owner); tests `tests/test_voice_api.py`,
  `tests/test_voice_service.py`.
- **Depends on:** C4b, C5a, C5b.
- **Done when:**
  - every row of the §5.3 table and of §6.7's errors has a test; §5.4's order holds (an
    unauthenticated or oversized request never calls the transcriber; the body is not read before
    authentication);
  - **service without the sheet:** the §5.1 acceptance test passes;
  - **outside Telegram (mandatory acceptance test):** a test-only `SignInProvider` (`kind="test"`,
    `Principal(provider="test", subject="u1", chat_id=None, scopes={"voice"})`) with its own
    `Directory` and `Authorizer`, no `TELEGRAM_BOT_TOKEN` in the settings, and `agent.telegram`
    patched so that constructing `TelegramClient` or importing the bot fails the test: exchange →
    session → transcription returns `200`;
  - CORS headers are present on `200`, on every error and on `500`; `Retry-After` is exposed;
    preflight answers only allowed origins;
  - a chunked body without `Content-Length` is accepted and still cut at the cap; a
    `Content-Length` mismatch → `400`;
  - §10.3 sentinel tests pass for both routes, including the `Authorization` value.
- **Do not:** import `handler`, `bot`, `sheet_client`, `telegram` or `commands`; write anywhere;
  add multipart; deploy.
- **Model:** Sonnet.

### C7 — Bot glue for Mini App voice (Python)

- **Goal:** `/app` links carry `vu`/`vc`/`vx`; the bot accepts `t:"text"` with §4.2's idempotency.
- **Files:** `agent/commands.py` (`Context` gains `voice: VoiceLink | None`, where
  `VoiceLink(api_url: str, codes: LinkCodes)`; `/app` issues one code for `ctx.chat_id` and passes
  the keys to `keyboard_markup`); `agent/miniapp.py` (`keyboard_markup(…, voice_keys: dict | None)`,
  budget rule of §7.1, `DROPPED_LABELS["voice"]`, pydantic model for `t:"text"`); new
  `agent/text_submissions.py` (`TextSubmissions`); `agent/handler.py` (build `VoiceLink` from
  settings and pass it in `Context`; route `t:"text"` through `TextSubmissions` to `_run_bot`, which
  gains an optional scope key); `agent/bot.py` (`Answer.uncertain`); `agent/settings.py`
  (`VOICE_API_URL`, and `AuthSettings` fields for issuing: both `VOICE_API_URL` and
  `APP_AUTH_SECRET` or neither); tests in `test_miniapp.py`, `test_handler.py`, `test_commands.py`,
  new `test_text_submissions.py`.
- **Depends on:** C5a (`LinkCodes`), C4c (`Answer` and handler structure settled).
- **Done when:** links with and without voice settings; the code in a link verifies with C5a for
  that chat only; voice keys survive trimming until the last resort; every row of §4.2's table has
  a test, including **the same payload in two different updates** (one agent run) and **the same id
  with a different text** (conflict, no run); a failed run with nothing written allows a retry; form
  payloads unchanged.
- **Do not:** change the form payloads or their model-free path; change the launch mode; store the
  text.
- **Model:** Sonnet.

### C6 — Record button in the Mini App (JS)

- **Goal:** §7 in the page.
- **Files:** `apps/miniapp/src/core.js` (`normalizeCatalog` keeps and validates `vu`/`vc`/`vx`;
  pure `pickVoiceMime`, `voiceReducer` with generations, `voiceError`, `keepBlob`, `textPayload`
  with the size check, `voiceAvailable`); new `apps/miniapp/src/voice.js` (session exchange and
  storage, `getUserMedia`/`MediaRecorder`, fetch, Blob lifecycle, consent); `app.js` (dock button,
  MainButton hand-over, mascot state names); `index.html`, `styles.css`; `dev/` stub; tests in
  `apps/miniapp/test/`.
- **Depends on:** the contracts of §4.2, §5.3, §6.7 and §7.1–7.5.
- **Done when:** every state and transition of §7.4 and every row of §7.5 has a pure test; a
  permission resolved after `Cancelar` stops its tracks and starts nothing (test with a fake
  `getUserMedia` promise); `keepBlob` drops the Blob in every case §7.4 lists; invalid catalog voice
  keys disable voice; preview never calls a real service; forms untouched; `npm test` and
  `npm run check` green.
- **Do not:** draw the mascot's new art; add a build step or npm package; persist audio or
  transcripts; send anything but the confirmed text through `sendData`.
- **Model:** Sonnet.

### C8 — Device validation (owner, manual)

§11.2: items 1–10 after C4c; 11–23 after C5–C7 and the owner's deploy. Its results decide whether
the `m4a` relabel stays and close the "not verified" rows of §2.

## 14. Decisions

### 14.1 Taken by the owner

| # | Decision | Outcome |
| --- | --- | --- |
| Credential | How the page authenticates | A one-time short code in the link, exchanged for a short, revocable session (§6.4–6.6), with the threat model of §6.8. Replaces revision 1's 7-day link token (so revision 1's D3 is gone). |
| D1 | Where the voice service runs | Cloud Run, separate from the bot on the PC; deploying is the owner's action, not assumed done (§5.1). |
| D2 | Maximum duration | 90 s. |
| D4 | Confirmation | Always, in this version. |
| D5 | Provider tier | Paid tier (or Vertex) before any client other than the owner uses voice. |
| D6 | Idempotency cache | 5 minutes in memory. |
| D7 | Limits | The defaults of §5.6. |
| D8 | Where the mic lives | Dock button on both views. |
| D9 | When to start step 2 of §6.10 | With the database step. |

### 14.2 Still open (recommendations included)

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| N1 | Session lifetime | 4 h / 12 h / 24 h | **12 h**: one `/app` a day at most, and the catalog snapshot is refreshed by the same `/app`. |
| N2 | Confirmation lifetime | 10 / 30 / 120 min | **30 min**: enough to read and correct; short enough that an old note is not confirmed by accident. |
| N3 | Confirmations across a bot restart | expire (fail closed) / persist the minimal state (hashes) in a local file | **Expire**: no file to manage on the PC, nothing to leak, and a restart costs one re-sent note. |
| N4 | Process-wide daily token budget | 250 k / 500 k / 1 M | **500 k** for up to three clients; together with the provider-side cap, which the owner sets in the provider console. |

## 15. Out of scope / later

- **Voice → pre-filled form draft**: extracting payload v1 from the transcript and opening the form
  filled in. This spec's confirmed-text path ships first and produces the transcripts needed to
  design it.
- Catalog names as spelling hints in the transcription prompt.
- Streaming transcription; transcoding; audio parsing libraries.
- HTTP submission routes (`/v1/entries`, `/v1/messages`, `/v1/catalog`), the menu-button launch,
  PWA and native sign-in (steps 2–4 of §6.10).
- Shared storage for budgets, single-use sets and confirmations (database step).
- Photo path changes; voice replies from the bot.

## 16. Review log (Codex review of `041ed06`)

| # | Finding | Resolved in |
| --- | --- | --- |
| 1 | Confirmation lifecycle (blocking) | §4.1 (identity, atomic `pending`-only transitions, TTL, hash check, fail-closed restart and eviction, response table), §12, C4c tests |
| 2 | Logs leaking through exceptions (blocking) | §10.1–10.3 (`describe`, no tracebacks on content paths, `ContentGuard`, sentinel tests), C4a |
| 3 | Text payload idempotency | §4.2 (`TextSubmissions` by principal, type and id, text hash, `running`/`uncertain`), C7 tests |
| 4 | Budget | §3.5 (what bytes and headers do not guarantee), §5.6 (per-attempt atomic reservation, settlement rules, fallback, "approximate limit"), §5.1 (`max-instances=1`, provider cap) |
| 5 | Credential reuse | §6.4–6.8 (one-time code → 12 h session, `initData` exchange-only with 300 s and single use, strict parsing, opaque refs, threat model) |
| 6 | Service without the sheet | §5.1 (`VoiceSettings`, `build_voice_service`, acceptance test), C5c |
| 7 | Decisions left to implementers | §3.4 (`Transcript.usage`), §3.1–3.2 (real 45 s deadline, fallback key and `api_base`), C7 (`Context.voice`), C6 (`normalizeCatalog`), tasks split into C4a–C4c and C5a–C5c |
| 8 | Idempotency order | §5.4 steps 7–9, §5.5 |
| 9 | Retention and retry on the client | §7.4 (Blob lifecycle, permission generations), §9.1 |
| 10 | HTTP details | §5.3 (CORS on errors and 500), §5.7 (`Retry-After` exposed), §5.3–5.4 (no `Content-Length` required, cap while reading) |
| 11 | `setChatMenuButton` per chat | §2, §6.10 (corrected reasons) |
| 12 | Outside Telegram acceptance | C5c mandatory test (provider `test`, `chat_id=None`, own authorizer, no Telegram SDK) |
