# Voice input — design

Date: 2026-11-14 · Status: proposed; owner decisions pending in §14 · Branch: `claude/voz-spec`

Voice becomes a **primary input** of the product: on the Telegram chat and in the Mini App now,
and later on the client PWA and the native app, through the same HTTP API. This spec decides the
pipeline, the confirmation step, the voice endpoint, pluggable authentication, the Mini App
record button, privacy, and how the four gaps found by the C1 tests are closed. §13 splits the
work into tasks small enough for a cheaper model.

Inputs: C2 research (official Telegram and Gemini documentation, consulted 2026-11-14, summarised
in §2) and the C1 tests (`services/agent/tests/test_voice_path.py`, branch `claude/voz-testes`,
commit `59bf0f5`). It supersedes the first step of "Voice → draft" in
`2026-11-09-miniapp-design.md` §"Next after the MVP" (see §15).

## 1. Principles

1. **Transcribe once, then it is text.** Audio is turned into text by one dedicated call. Every
   model after that (the agent, its fallback of another provider, any future one) receives text,
   so nothing downstream depends on a model being able to hear.
2. **Nothing is written from voice without the person seeing what was understood.** The bot or
   the page shows `Entendi: …`; the person confirms, corrects or cancels.
3. **The voice endpoint never writes.** It returns text. Writes keep going through the existing
   paths (agent tools; Mini App payload), with their existing gates and confirmations built from
   the sheet's response.
4. **Authentication is pluggable.** Telegram `initData` is one provider among others; the endpoint
   has no Telegram-specific shape and answers a PWA or a native app the same way.
5. **No audio is kept**, and no transcript or other client content reaches a log line.
6. **Nothing here blocks the product order** (bot + Mini App → real database → coach web panel →
   client PWA → native app): identities are provider-agnostic, the API is versioned (`/v1`),
   nothing is stored in the sheet, and every in-memory store sits behind an interface that a
   database can replace.

## 2. Facts this design rests on

| Fact | Source | Consequence |
| --- | --- | --- |
| `sendData` carries at most 4096 bytes and closes the app; it works only for apps opened from a `KeyboardButton`. | C2, Telegram docs | Confirmed text from the page fits (§4.2); audio cannot travel this way. |
| `initData` is **empty** for apps opened from a keyboard button (how `/app` opens the page today, `apps/miniapp/src/app.js:23`) and in inline mode; filled for the menu button, inline buttons and `t.me/<bot>/<app>` links. | C2 | The page cannot authenticate an HTTP call with `initData` today (§6.6). |
| `getUserMedia` / `MediaRecorder` inside the Telegram WebView: **not verified** on iOS, Android or Desktop; iOS WebKit has known `NotAllowedError` bugs. | C2 | The page must detect, degrade, and fall back to the chat (§7.5). Device checklist in §11.2. |
| Chrome/Android record WebM/Opus; Safari records `audio/mp4` (AAC), maybe WebM from 18.4. Gemini accepts webm, ogg, opus, m4a, aac, mp3, wav; `audio/mp4` is **not** in its list. | C2 | Format mapping with an `mp4 → m4a` relabel that must be verified (§3.2). |
| Gemini bills audio at 32 tokens/s. | C2 | Cost estimate (§3.6). |
| Today audio goes inline to the agent model (`bot.py:263-267`), and ADK resends the whole user message on **every** model call of the agent loop (typically 3, up to `MAX_LLM_CALLS`). | code | Transcribing once is also cheaper (§3.6). |
| The Anthropic fallback drops `input_audio` silently (LiteLLM conversion); nobody is told. | C1 gap 2 | Closed by principle 1 (§8). |
| The bot runs by long polling on the owner's PC (`scripts/start-luan-bot.ps1`): no public HTTPS. An ASGI app already exists (`agent/asgi.py`: webhook, `/remind`, `/healthz`). | code | The endpoint lives in the ASGI app and needs a host (decision D1). The chat path works without it. |
| `bot.py` logs the message text in five warnings (`bot.py:288, 296, 302, 305, 310`, `"…message %r", text`). | code | After C4 that text can be a transcript: those lines must stop logging it (§10). |

## 3. Pipeline

```
Telegram voice/audio ─▶ handler: limits ─▶ download ─┐
                                                      ├─▶ Transcriber ─▶ text ─▶ "🎙️ Entendi: …"
Mini App MediaRecorder ─▶ POST /v1/voice/transcriptions ┘                         │
                                                                                  ▼
                                         ✅ confirm (or ✏️ corrected text) ─▶ agent, as typed text
                                                                                  ▼
                                                     sheet ─▶ confirmation from the sheet's response
```

One module, `services/agent/src/agent/transcribe.py`, serves both entries (C4 builds it; C5
reuses it).

### 3.1 Transcription model

`TRANSCRIBE_MODEL`, default `gemini/gemini-3.8-flash` (the same default as `LLM_MODEL`, so one key
and one provider account). Reasons: audio-native, accepts every format the clients produce (with
the relabel below), cheap per second, already configured, and reachable through LiteLLM, which
is already a dependency (no new package).

Rejected for now: a Whisper-type API (another vendor and key; may become the fallback later);
the browser's Web Speech API (not available in the WebViews we target, absent in a PWA on iOS
for practical purposes, and it sends audio to a vendor outside our control); local whisper.cpp
(CPU on the owner's PC, new binaries).

Configuration rules, checked in `Settings` (C4):

- `TRANSCRIBE_MODEL` and the optional `TRANSCRIBE_FALLBACK_MODEL` must have an audio-capable
  provider prefix: `gemini` or `vertex_ai`. Any other prefix (e.g. `anthropic/…`) is a
  `ConfigError` at start-up: that is the root of gap 2.
- `TRANSCRIBE_API_KEY` (secret, optional) defaults to `LLM_API_KEY`. If the transcription
  provider differs from `LLM_MODEL`'s and no `TRANSCRIBE_API_KEY` is set, `ConfigError` (the
  same rule the settings already apply to `LLM_FALLBACK_MODEL`). The new key is registered for
  log masking like the others.

### 3.2 The call

`litellm.acompletion` through the existing `RetryingClient` (same retries, timeout handling and
fallback logic as the agent), with:

- one system message (the prompt in §3.3) and one user message whose only content is
  `{"type": "input_audio", "input_audio": {"data": <base64>, "format": <fmt>}}`;
- `temperature=0`, `max_tokens=600` (90 s of speech is about 250 words);
- `timeout=TRANSCRIBE_TIMEOUT_S` (default 20 s), bounded by the message deadline on the chat path.

MIME → LiteLLM `format` (parameters such as `;codecs=opus` are stripped; matching is case-insensitive):

| MIME received | `format` | Note |
| --- | --- | --- |
| `audio/ogg`, `audio/opus` | `ogg` | Telegram voice notes |
| `audio/webm` | `webm` | Chrome, Android, maybe Safari ≥ 18.4 |
| `audio/mp4`, `audio/m4a`, `audio/x-m4a` | `m4a` | Safari. Same container as m4a; **acceptance by Gemini unverified** (checklist §11.2 item 9) |
| `audio/aac` | `aac` | |
| `audio/mpeg`, `audio/mp3` | `mp3` | `audio` messages without a MIME type default to `audio/mpeg` today |
| `audio/wav`, `audio/x-wav`, `audio/wave` | `wav` | |
| anything else | — | `unsupported_format` |

If the relabel turns out to be refused, the server keeps returning `unsupported_format` for
`audio/mp4` and the page falls back to the chat (§7.5); no transcoding is added (it would need
new binaries).

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

The vocabulary list is a starting point; it is refined from real notes (counts of corrections,
never their content, §10). Catalog names as hints are a later improvement (§15).

### 3.4 Result handling

- Strip whitespace and one pair of surrounding quotes. Exactly `<vazio>`, empty, or only
  `[inaudível]` tokens → `no_speech`.
- More than 2000 characters → `failed` (a looping model; 90 s of speech is about 1500 characters).
- Result: `Transcript(text: str, model: str)`. Errors: `TranscribeError(code, transient)` with
  `code` in `unsupported_format`, `too_long`, `no_speech`, `failed` (transient: provider errors,
  timeout), `disabled`.

### 3.5 Duration and size

`VOICE_MAX_SECONDS = 90`, one value for every surface. Justification: dictating a whole workout
of six exercises takes about 60–80 s; a meal 10–30 s. Above 90 s the transcript stops fitting a
quick read in the confirmation, and one note tends to mix several entries. Options in D2.

| Surface | How the limit is enforced |
| --- | --- |
| Chat | Telegram's `voice.duration` / `audio.duration` (trusted, comes from Telegram) is checked **before** the download. Missing duration → the existing byte limit (`MEDIA_MAX_BYTES`) only. |
| HTTP | The page stops recording at 90 s. The optional `X-Audio-Duration-Ms` header above 90 000 → `too_long`. Hard guarantees, since a client can lie: `VOICE_MAX_BYTES = 1_500_000` (90 s of AAC at 128 kbps; the page asks for 32 kbps, about 360 KB) and the daily token budget per principal (§5.5). |

Bodies under 1 KB are `no_speech` without a model call. The page refuses recordings under 0.7 s.

### 3.6 Cost

Per note: audio `32 × seconds` tokens, prompt about 350 text tokens (C4 measures it), output
about 1.4 tokens per spoken word.

| Note | Audio tokens | Prompt | Output | Total |
| --- | --- | --- | --- | --- |
| 20 s (a meal) | 640 | ~350 | ~70 | ~1 060 |
| 90 s (maximum) | 2 880 | ~350 | ~350 | ~3 580 |

Compared with today: a 20 s note inline in an agent run of 3 model calls costs 1 920 audio tokens.
After C4 it costs 640 audio tokens once, plus the transcript (~70 tokens) in each agent call. The
extra round trip adds about 1–3 s of latency.

Monthly estimate per active client, assuming 8 notes a day averaging 25 s: about 192 k audio
tokens, 84 k prompt tokens and 22 k output tokens. With current prices `Pa` (audio input), `Pt`
(text input) and `Po` (output) in US$ per million tokens:

    cost/month ≈ 0.192·Pa + 0.084·Pt + 0.022·Po  (US$)

Example only (not a real price list): if all three cost US$ 1 per million tokens, about US$ 0.30
a month per client. C4's report states the real prices of the configured model, read from the
provider's pricing page on the day of implementation.

## 4. Confirmation

### 4.1 Chat

A voice or audio message, after the limits and the download, is transcribed and answered with
a plain-text message, sent as a reply to the voice message:

```
🎙️ Entendi:

<caption, if any>
<transcript>
```

Inline buttons, one row: `✅ Confirmar` (`callback_data: vok`), `✏️ Corrigir` (`vfix`),
`✖️ Cancelar` (`vno`).

**The pending transcript is not stored anywhere.** On a tap, the handler reads it back from the
bot's own message (`callback_query.message.text`, which Telegram returns without HTML): the text
after the first line `🎙️ Entendi:` and the blank line. Users cannot edit bot messages, so this is
exactly what was shown. This survives a bot restart and needs no TTL. A message that cannot be
parsed, or one Telegram reports as inaccessible (`InaccessibleMessage`, `date` 0), answers the toast
`Expirou. Envie o áudio de novo ou digite.`

- **✅ vok**
  1. Answer the callback query at once with `Registrando…` (the agent takes seconds; the spinner
     must not wait for it).
  2. Guard against a double tap: an in-memory bounded set of `(chat_id, message_id)` already
     confirmed (same shape as `UpdateDeduplicator`); a repeated tap answers `Já enviado.` and
     stops. Then remove the keyboard (cosmetic, failures ignored).
  3. Run the agent on the recovered text exactly as if typed, with
     `update_key_scope(f"tg:voice:{chat_id}:{message_id}")`, and reply to the `Entendi` message
     with the usual confirmation and ✅ / ↩️ / ✏️ buttons.

  Note: the sheet deduplicates by request id, which includes a digest of the args, so a second
  agent run producing different args would not be caught by the sheet. The double-tap guard and
  the removed keyboard are what prevent it; after a restart only the removed keyboard remains
  (residual risk, §12).
- **✏️ vfix** sends `✏️ Envie o texto corrigido respondendo a esta mensagem. Toque para copiar:`
  followed by the text in `<code>` (one tap copies it on Telegram), with `force_reply` and the
  placeholder `Ex.: supino 80 por 8, 80 por 7`. The person's answer is a normal text message and
  goes to the agent without a second confirmation (typed text is what the person meant). The
  handler recognises a reply to this prompt by its first line and passes **no** reply context to
  the agent, so the old transcript is not taken as a write to correct.
- **✖️ vno** removes the keyboard and replies `Ok, não registrei nada.`

The confirmation is mandatory in this version (D4).

Limitation: a voice note sent as a swipe-reply to a bot confirmation loses that context, because
the agent runs later from the `Entendi` message (Telegram does not nest replies). The person can
say the date or session, or use ✏️ on the original confirmation and type.

### 4.2 Mini App

After transcription the page shows `Entendi:` and the text in an **editable** textarea (the
correction happens in place), with MainButton `Enviar` and secondary actions `Regravar` and
`Cancelar`. `Enviar` sends, through `sendData`, a new payload type:

```json
{"v": 1, "t": "text", "id": "0123456789abcdef0123456789abcdef", "src": "voice",
 "text": "almoço 150 g de arroz e 120 g de frango"}
```

- `text`: 1..2000 characters after trimming, no control characters other than `\n`;
  `src`: `"voice"` (only value for now; kept for counting, never logged with content);
  `id`: the same 32-hex rule as the form payloads, a new one per recording.
- The page checks the UTF-8 size of the whole payload before sending (2000 characters of
  ordinary Portuguese are about 2.1 KB, but emoji take 4 bytes each); over 4096 bytes it refuses
  and asks to shorten the text.
- The bot (C7) validates it with a strict pydantic model like the others and runs the agent on
  `text` with `update_key_scope(f"tg:{chat_id}:miniapp:text:{id}")`. No second `Entendi`: the
  person already confirmed in the page. The reply is the usual confirmation with buttons.
- This is the first Mini App payload that goes through the model. The form payloads (`workout`,
  `food`) stay model-free; the type is explicit, never inferred.

When the launch mode changes (§6.6, step 3), the page sends the same object to
`POST /v1/messages` instead of `sendData`.

## 5. Voice endpoint

### 5.1 Where it runs

`POST /v1/voice/transcriptions` and its `OPTIONS` preflight, added to `agent/asgi.py`. It needs
only the transcription settings, the auth secrets and `ALLOWED_CHAT_IDS`: no sheet, no bot loop.
So it can run as its own service while the bot keeps polling on the PC. Where it is hosted is
decision D1; until then `VOICE_API_URL` is empty, the bot puts no voice keys in the Mini App
link, and the page hides the record button. The chat path (C4) works with no endpoint.

### 5.2 Request

```
POST /v1/voice/transcriptions
Authorization: tma <initData>        (Telegram Mini App, §6.2)
             | Bearer <link token>   (signed link, §6.3)
Content-Type: audio/webm;codecs=opus (any MIME in §3.2)
Content-Length: <bytes>              (required, ≤ VOICE_MAX_BYTES)
Idempotency-Key: <32 lowercase hex>  (required, one per recording)
X-Audio-Duration-Ms: <int>           (optional, measured by the client)

<raw audio bytes>
```

The body is the raw audio, not multipart: no form parser is needed (Starlette's multipart support
relies on a package that is only a transitive dependency today), and the PWA and native apps can
send it the same way. No cookies are used (`credentials: "omit"`), so there is no CSRF surface.

### 5.3 Response

`200 OK`, `Content-Type: application/json`, `Cache-Control: no-store`:

```json
{"v": 1, "id": "0123456789abcdef0123456789abcdef", "text": "supino 80 por 8, 80 por 7, RIR 1"}
```

Errors use one shape, with a message in Portuguese ready to show and a retry hint:

```json
{"v": 1, "error": {"code": "too_long", "message": "O áudio passou de 90 s. Grave um trecho mais curto.", "retry": false}}
```

| HTTP | `code` | When | `retry` |
| --- | --- | --- | --- |
| 400 | `bad_request` | missing/invalid `Idempotency-Key`, `Content-Length`, malformed header | false |
| 401 | `unauthenticated` | no or unknown `Authorization` scheme, bad signature | false |
| 401 | `auth_expired` | valid signature, expired (`auth_date` too old, token `exp` passed) | false (page: "Envie /app de novo") |
| 403 | `forbidden` | authenticated, but not allowed to use this bot (§6.4) | false |
| 409 | `idempotency_conflict` | same key and principal, different body | false |
| 413 | `too_large` | over `VOICE_MAX_BYTES` (checked on the header and while reading) | false |
| 415 | `unsupported_format` | MIME not in §3.2 | false |
| 422 | `too_long` | `X-Audio-Duration-Ms` over the limit | false |
| 422 | `no_speech` | §3.4, or body under 1 KB | false |
| 429 | `rate_limited` / `budget_exhausted` | §5.5; with `Retry-After` in seconds | true |
| 502 | `transcription_failed` | provider error after retries and fallback | true |
| 503 | `disabled` | `VOICE_API_ENABLED=false` or no transcriber configured | false |
| 504 | `timeout` | transcription over its deadline | true |

Any unexpected exception → 500 `internal`, `retry: true`, with no detail in the body.

### 5.4 Processing order

Cheap checks first, so that an unauthenticated or oversized request never reaches the model:
CORS preflight → `VOICE_API_ENABLED` → authenticate (§6) → authorize → rate limit →
`Content-Type` → `Content-Length` → `Idempotency-Key` → idempotency lookup → read the body
streaming with the byte cap → duration header → under-1-KB check → transcribe → store the
idempotent result → respond. The audio bytes are dropped as soon as the call returns.

### 5.5 Limits

| Limit | Default (setting) | Notes |
| --- | --- | --- |
| Body | 1 500 000 bytes (`VOICE_MAX_BYTES`) | §3.5 |
| Duration | 90 s (`VOICE_MAX_SECONDS`) | client stop + header check |
| Requests per principal | 6 per minute, 60 per day (`VOICE_RATE_PER_MIN`, `VOICE_RATE_PER_DAY`) | sliding window in memory |
| Token budget per principal | 120 000 prompt tokens per day in `TIMEZONE` (`VOICE_DAILY_TOKENS`) | charged after each call from `usage.prompt_tokens` (about 55 min of audio); exhausted → `budget_exhausted` until midnight. Bounds the cost of a leaked credential or a low-bitrate file that lies about its duration. |
| Concurrent transcriptions | 4 per process (`VOICE_MAX_CONCURRENT`) | over it → 429 `rate_limited`, `Retry-After: 2` |
| Deadline | `TRANSCRIBE_TIMEOUT_S` (20 s) + retries/fallback ≤ 45 s total | |

Counters live in memory, per process, behind a small `RateLimiter` interface; with several
instances each has its own counters (accepted until the database step, which can back the same
interface).

### 5.6 Idempotency

Key = `(principal.provider, principal.subject, Idempotency-Key)`. The first request runs; a
concurrent one with the same key waits for the same result (in-flight coalescing). A finished
result is kept **in memory for 5 minutes** (D6) with the SHA-256 of the body; a retry with the
same body gets the same `200` without a new model call, one with another body gets
`idempotency_conflict`. Errors are not cached except `no_speech` (deterministic). Since the
endpoint writes nothing, the cache only saves cost and gives a stable answer across a dropped
connection; without it (another instance, expired), a retry simply transcribes again.

### 5.7 CORS and transport

- HTTPS only (the host terminates TLS). `Strict-Transport-Security` is the host's job.
- Starlette's built-in `CORSMiddleware` (no new dependency), restricted to
  `VOICE_ALLOWED_ORIGINS` (default: the origin of `MINIAPP_URL`), methods `POST, OPTIONS`,
  headers `Authorization, Content-Type, Idempotency-Key, X-Audio-Duration-Ms`, no credentials.
  CORS is not authentication; a non-browser client is stopped by §6.
- The credential travels only in the `Authorization` header, never in the URL.

### 5.8 What is logged

See §10. In short, per request: outcome code, HTTP status, byte length, declared duration,
normalized format, latency, model name, `usage.prompt_tokens`, and a keyed hash of the principal.

## 6. Pluggable authentication

### 6.1 Interface

New module `services/agent/src/agent/auth.py` (C5):

```python
@dataclass(frozen=True)
class Principal:
    provider: str               # "telegram" today; later "pwa", "native", "coach"…
    subject: str                # stable id inside the provider (Telegram user id as text)
    chat_id: int | None         # where a Telegram reply can go; None outside Telegram
    scopes: frozenset[str]      # e.g. {"voice"}; checked per endpoint
    expires_at: datetime | None

class AuthError(Exception):
    code: Literal["unauthenticated", "auth_expired"]

class AuthProvider(Protocol):
    scheme: str                 # the Authorization scheme it handles, lowercase: "tma", "bearer"
    def authenticate(self, credential: str, now: datetime) -> Principal: ...  # raises AuthError

class Authorizer(Protocol):
    def allows(self, principal: Principal, scope: str) -> bool: ...

class Authenticator:
    def __init__(self, providers: Sequence[AuthProvider], authorizer: Authorizer) -> None: ...
    def check(self, header: str | None, scope: str, now: datetime) -> Principal: ...
        # unknown scheme / missing → AuthError("unauthenticated"); not allowed → Forbidden
```

The endpoint knows only `Authenticator.check(header, "voice", now)`. Adding a way in is adding a
provider; changing who may use the product is changing the `Authorizer`. Pure functions with an
injected clock: tested without HTTP.

### 6.2 Telegram `initData` provider (`scheme = "tma"`)

The standard validation from the Telegram Mini Apps documentation:

1. Parse the credential as a URL query string (keep the first value of each key). It must have
   `hash`, `auth_date` and `user`.
2. `data_check_string` = every pair except `hash`, as `key=value`, sorted by key, joined by `\n`.
3. `secret_key = HMAC_SHA256(key=b"WebAppData", msg=TELEGRAM_BOT_TOKEN)`;
   `expected = hex(HMAC_SHA256(key=secret_key, msg=data_check_string))`; compare with `hash` using
   `hmac.compare_digest`. Mismatch → `unauthenticated`.
4. `now - auth_date > INITDATA_MAX_AGE_S` (default 86 400 s) → `auth_expired`; `auth_date` more than
   60 s in the future → `unauthenticated`.
5. `user` is JSON; `subject = str(user["id"])`, `chat_id = user["id"]` (the private chat with the
   bot has the user's id), `scopes = {"voice"}`, `expires_at = auth_date + max age`.

The third-party Ed25519 `signature` validation is not needed (we hold the bot token) and is left
out. Tests build valid `initData` with a fake token such as `123:TEST`; no real token or user id
appears in the repository.

### 6.3 Signed link token provider (`scheme = "bearer"`)

Needed because the keyboard button gives an empty `initData`. The bot signs a short token and
puts it in the Mini App link fragment, which never reaches the web server.

    token = "v1." + b64url(payload_json) + "." + b64url(HMAC_SHA256(APP_LINK_SECRET, "v1." + b64url(payload_json)))
    payload_json = {"sub": "<telegram user id>", "cid": <chat id>, "scp": ["voice"], "exp": <unix s>}

- Compact JSON, base64url without padding; full 32-byte MAC; about 140 characters in total.
- `APP_LINK_SECRET`: a new secret of at least 32 bytes, only in the environment, registered for
  log masking. Rotating it revokes every link at once.
- `exp = now + APP_LINK_TTL_S` (default 7 days, D3). Verification: version, MAC
  (`compare_digest`), `exp` (`auth_expired`), `scp` contains the scope.
- Issued only by `/app` (C7), only for an allowed chat. Scope `voice` only: the token cannot write
  anything, so a leaked token costs at most the daily budget (§5.5) and reveals nothing.
- The same provider later serves a PWA "magic link" sent by the bot (§6.5).

### 6.4 Authorization

`AllowedChats(ALLOWED_CHAT_IDS)`: a Telegram principal is allowed if its `chat_id` is in the set.
This is exactly today's rule for chat messages. At the database step it is replaced by a
directory lookup `(provider, subject) → user → client/coach roles`, behind the same `Authorizer`.

### 6.5 Left out now (and why it still fits later)

- Accounts, sessions, refresh tokens, logout: arrive with the database. The PWA can then add a
  provider (e.g. a session token issued after a magic link from the bot, reusing §6.3's format
  with another `scp`) without touching the endpoint.
- Native app login (OAuth/PKCE, device keys): a provider, later.
- Per-token revocation lists: secret rotation is the only revocation now.
- Coach accounts acting on several clients: the `Principal` → client mapping is the directory's
  job, not the endpoint's.
- Ed25519 third-party `initData` validation.

### 6.6 The keyboard button and the launch-mode migration

`sendData` works **only** from a keyboard button, and a keyboard button gives **no** `initData`.
Moving to the menu button or a `t.me` link would give `initData` but break `sendData`, the only
way the forms reach the bot today (the bot has no public endpoint). So the launch mode does not
change in this spec. Migration in steps, each shippable alone:

| Step | Launch | Form submission | Voice auth | Ships with |
| --- | --- | --- | --- | --- |
| 0 (today) | keyboard button | `sendData` | — | — |
| 1 (this spec) | keyboard button, unchanged | `sendData` (forms and the new `t:"text"`) | link token in the fragment (`bearer`) | C5, C6, C7 |
| 2 | keyboard button | `POST /v1/entries` and `POST /v1/messages` when the page has a credential and the API URL; `sendData` stays as fallback | `bearer`, or `tma` when present | database step |
| 3 | menu button (`setChatMenuButton`) and `t.me/<bot>/<app>`; catalog from `GET /v1/catalog` instead of the fragment | HTTP only; `sendData` retired | `tma` (the link token is no longer needed in Telegram) | after step 2 is proven |
| 4 | PWA, then native | same endpoints | their own providers | product order |

Why this order: in step 3 the menu button URL is fixed per bot, so it cannot carry a per-person
catalog in the fragment; the catalog must come over HTTP first (step 2). Step 3 also removes the
4096-character link budget. In steps 2–3 an HTTP submission is not a Telegram message, so the bot
sends the confirmation to `principal.chat_id` with `sendMessage` and also returns it in the HTTP
response (what the PWA will show).

The page already decides "inside Telegram" from `tg.platform` and the launch parameters, not
from `initData` (`app.js:23`), so step 1 changes nothing there. The page must send `tma <initData>`
whenever `initData` is non-empty (future launches) and `Bearer <vt>` otherwise.

## 7. Mini App

### 7.1 When the record button appears

A microphone button in the dock, on both views. It is shown only when **all** hold:

1. The catalog has `vu` (voice API URL) and `vt` (token), or the page has a non-empty `initData`
   and `vu`.
2. `vx` (token expiry, unix seconds) is in the future, or there is `initData`. An expired token
   shows the button disabled with `Envie /app para renovar a voz`.
3. `navigator.mediaDevices.getUserMedia` and `window.MediaRecorder` exist.
4. One of `audio/webm;codecs=opus`, `audio/ogg;codecs=opus`, `audio/mp4` passes
   `MediaRecorder.isTypeSupported` (tried in this order).

If 1–2 hold but 3–4 do not, the button is still shown and opens plan B directly (§7.5): voice is
a central feature, so its absence must be explained, not hidden. Outside Telegram (preview) the
button records and shows the transcript returned by a stub (`dev/`), never a real endpoint.

Fragment keys, in the catalog JSON next to `v`, `today`, `tz`, `client` (old pages ignore them):
`vu` (string), `vt` (string), `vx` (int). They are never trimmed while other keys can be; if a
link still does not fit after all existing trims, the three are removed and `voz` is reported in
`DROPPED_LABELS` (key `voice`) before `CatalogTooLarge` is considered. Size: about 230 characters with a
60-character URL; the Refeição fixture has 554 to spare.

### 7.2 States

| State | UI | Mascot state | Leaves to |
| --- | --- | --- | --- |
| `idle` | mic button | (current) | `consent` on first use, else `asking_permission` |
| `consent` | one-time notice (§9.2), `Entendi` / `Agora não` | — | `asking_permission` / `idle` |
| `asking_permission` | `Permita o microfone…` | `listening` | `listening`, `error` |
| `listening` | timer `0:12 / 1:30`, `Parar`, `Cancelar`; auto-stop at 90 s | `listening` | `sending` (stop), `idle` (cancel), `error` |
| `sending` | `Entendendo…`, `Cancelar` (aborts the fetch) | `thinking` | `transcribed`, `error`, `idle` |
| `transcribed` | `Entendi:` + editable text; MainButton `Enviar`; `Regravar`, `Cancelar` | (current) | `sendData` (app closes), `asking_permission`, `idle` |
| `error` | message and actions from §7.4 | `alert` (existing state) | `idle`, `asking_permission`, plan B |

`listening` and `thinking` are new mascot state **names** only; their art is being redrawn and is
not part of this spec. While not `idle`, the form is read-only and its draft is kept (drafts
already persist in `localStorage`); after `Enviar` the app closes and the draft stays for later.

### 7.3 Recording

- `getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true}})`.
- `new MediaRecorder(stream, {mimeType, audioBitsPerSecond: 32000})`; chunks collected until
  `stop`; one `Blob` sent with `Content-Type` = the recorder's actual `mimeType`.
- On stop, cancel, error, `visibilitychange` to hidden, or Telegram's `viewportChanged` to
  collapsed: stop the recorder and **every track** at once (the OS microphone indicator must go
  off). A recording interrupted this way is discarded, not sent.
- Under 0.7 s → `Muito curto. Segure e fale.`; the page never sends it.
- `fetch(vu + "/v1/voice/transcriptions", {method: "POST", credentials: "omit", headers, body})`
  with a 45 s `AbortController` timeout; `Idempotency-Key` generated with
  `crypto.getRandomValues`, reused on `Tentar de novo` for the same recording.
- Pure logic goes to `core.js` (format choice, state transitions, error mapping, `t:"text"`
  payload builder and size check), tested with `node --test`; DOM and `MediaRecorder` glue in a
  new classic script `src/voice.js`. No build step, no npm dependency.

### 7.4 Errors

| Cause | Message | Actions |
| --- | --- | --- |
| `NotAllowedError` / `SecurityError` | `Sem permissão para o microfone.` | `Tentar de novo`, `Gravar no chat` |
| `NotFoundError` / no supported format / API missing | `Este aparelho não grava aqui.` | `Gravar no chat` |
| network error, `timeout`, `transcription_failed`, `rate_limited` | `Não consegui entender agora.` | `Tentar de novo` (same key), `Gravar no chat` |
| `auth_expired`, `unauthenticated` | `Seu link expirou. Envie /app para renovar.` | `Gravar no chat` |
| `no_speech` | `Não ouvi nada. Fale mais perto do microfone.` | `Regravar` |
| `too_long`, `too_large` | `Passou de 1min30. Grave um trecho mais curto.` | `Regravar` |
| `unsupported_format` | `Este formato não funciona aqui.` | `Gravar no chat` |
| `budget_exhausted`, `forbidden`, `disabled` | the server's `message` | `Gravar no chat` |

### 7.5 Plan B: the chat's own voice note

`Gravar no chat` shows `Feche e segure o 🎤 na conversa: eu transcrevo e confirmo com você.` and a
button that calls `Telegram.WebApp.close()`. The chat path (§4.1) works on every Telegram client,
needs no endpoint and no WebView microphone, so it is the reliable fallback.

## 8. The four C1 gaps

| # | Gap today | Fix | Test (C1 `test_gap_*` flipped to the new behaviour) |
| --- | --- | --- | --- |
| 1 | `MEDIA_ENABLED=false` drops the caption too (`handler.py:329-330`). | With media off, a voice/audio/photo **with** a caption runs the caption as typed text and appends `MEDIA_DISABLED`; without a caption, only `MEDIA_DISABLED`. | `test_with_media_disabled_the_caption_is_still_processed` |
| 2 | The Anthropic fallback drops `input_audio` silently and the reply looks normal (`llm.py:90-91`, `bot.py:263-267`). | Audio never reaches the agent: it is transcribed by an audio-capable model (`Settings` refuses others) and the agent, any fallback included, gets text. A failed transcription is an explicit reply, never a silent run. | `test_a_fallback_of_another_provider_gets_the_transcript_as_text`; `test_settings_refuse_a_transcribe_model_without_audio` |
| 3 | `MEDIA_UNREADABLE` blames the model when media is disabled (`bot.py:52`). | Separate texts: `MEDIA_DISABLED = "Este bot está sem leitura de áudio e foto; envie em texto."`; `VOICE_FAILED = "⚠ Não consegui transcrever o áudio agora. Tente de novo ou envie em texto."` (transient); `VOICE_EMPTY = "Não ouvi nada no áudio. Tente de novo, mais perto do microfone."`; `VOICE_FORMAT = "Não leio esse formato de áudio; grave pelo 🎤 do Telegram ou envie em texto."`. `MEDIA_UNREADABLE` stays for photos only. | one test per message |
| 4 | Only a byte limit, no duration limit (`handler.py:138-141`). | `MediaRef` gains `duration: int \| None` from Telegram's `duration`; over `VOICE_MAX_SECONDS` → `VOICE_TOO_LONG = "O áudio passou de 1min30. Envie um mais curto ou em partes."` before any download. | `test_a_voice_note_over_the_duration_limit_is_refused_without_download` |

Prompt rule 16 (`bot.py:133`) drops the audio sentence and keeps the photo rules, since the agent
no longer receives audio.

## 9. Privacy

### 9.1 Retention

- **Audio: none.** Bytes live in process memory only for the request (download or upload →
  model call) and are never written to disk, logs, traces, the sheet or any cache. The Telegram
  voice note itself stays in the chat, as any message does; the person can delete it there.
- **Transcript:** exists in the `Entendi` message (chat) or the page's memory (Mini App), in the
  5-minute in-memory idempotency cache (§5.6), and in what the agent writes to the sheet (the
  structured entries, as today). Never in logs or traces.
- **Model provider:** the audio is sent to the transcription provider. The Gemini API terms treat
  free-tier content differently from paid-tier content (free-tier content may be used to improve
  the provider's products). Voice for anyone other than the owner requires a paid-tier key or
  Vertex AI (D5); C4's report quotes the terms in force on the day.

### 9.2 Consent

- Mini App, first use (stored in `localStorage` as `shape-miniapp:voice-consent:v1`; re-shown if
  storage is unavailable): `Seu áudio vai para transcrição automática (Google Gemini) e é apagado
  em seguida. Você confere o texto antes de eu registrar.` → `Entendi` / `Agora não`.
- Chat: `/start` and `/help` get one line: `🎙️ Pode mandar áudio: eu transcrevo, você confirma,
  e o áudio não é guardado.`
- Rollout to other clients (Zoio, Breno) includes this notice in their onboarding; voice data of
  health-related entries is personal data under LGPD, and the same consent that covers the
  sheet covers this processor.

## 10. Logging and observability

**Never logged**, at any level, in any process: audio bytes or base64; transcripts; captions;
typed text sent to the agent; `Authorization` headers, `initData`, link tokens, `hash`; the
`Idempotency-Key`; provider error messages (`str(err)` of a LiteLLM error can echo the request).

**Allowed:** outcome `code`, HTTP status, body length, declared and Telegram durations, normalized
format, latency, model name, `usage.prompt_tokens`/`completion_tokens`, provider error **class**
and status code, update id, and `principal = HMAC_SHA256(APP_LINK_SECRET, provider:subject)[:12]`
on the endpoint (correlates requests without exposing the id).

Changes required (C4): the five `bot.py` warnings that interpolate `text` log the update id and
`len(text)` instead; `transcribe.py` logs only the allowed fields; tests assert, with
`caplog`, that a known transcript and caption never appear in any record. LiteLLM verbose mode
stays off (`logs.py` already documents why). Any future OpenTelemetry span (see the tracing spec)
follows the same list for attributes.

Counters worth keeping (no content): notes transcribed per surface, confirm / correct / cancel
rates, `no_speech` rate, mean duration, error codes. They decide D4 and refine §3.3.

## 11. Tests

### 11.1 Automated (per task, §13)

Python with the existing fakes (`tests/fakes.py`) and pytest; the page's pure logic with
`node --test` (`npm test`, `npm run check`). No test calls a real model, Telegram or the sheet.
The C1 file stays and its `test_gap_*` tests are rewritten to pin the fixed behaviour.

### 11.2 Manual checklist for the owner (real devices)

Run on **iOS Telegram**, **Android Telegram** and **Telegram Desktop** (Windows or macOS), with a
test bot and test sheet. Note for each: device, OS version, Telegram version, result.

Chat (after C4):
1. Voice note of ~15 s with a meal → `🎙️ Entendi:` with the right text, as a reply to the note.
2. `✅ Confirmar` → confirmation from the sheet with ✅/↩️/✏️; tap `✅ Confirmar` again fast
   twice on another note → only one entry in the sheet.
3. `✏️ Corrigir` → prompt with the text in a copyable block; reply with a corrected text → one
   entry with the corrected values.
4. `✖️ Cancelar` → `Ok, não registrei nada.`, nothing in the sheet.
5. Voice note over 90 s → refused immediately, nothing downloaded (no typing indicator delay).
6. Silent note (3 s of silence) → `Não ouvi nada…`.
7. With `LLM_MODEL` pointed at an unreachable model and an Anthropic `LLM_FALLBACK_MODEL`: a
   confirmed voice note is still recorded correctly (the fallback gets text).
8. With `MEDIA_ENABLED=false`: voice note with caption `peso 82,4` → weight recorded and the
   media notice shown.

Mini App (after C5–C7, endpoint deployed):
9. Record on each device: note which `mimeType` the recorder picked; the transcript arrives. On
   iOS this verifies the `audio/mp4 → m4a` relabel with the real Gemini API.
10. First use shows the consent notice once; the OS permission prompt appears; refusing it shows
    `Sem permissão…` and `Gravar no chat` closes the app.
11. The OS microphone indicator turns off right after `Parar`, after `Cancelar`, and when the app
    is minimised mid-recording.
12. Auto-stop at 1:30. Very short tap (<0.7 s) is refused locally.
13. Edit the transcript, `Enviar` → app closes, bot replies with the confirmation from the sheet.
14. Airplane mode during `Entendendo…` → error with `Tentar de novo`; back online, retry works.
15. A link older than the token TTL (or a rotated `APP_LINK_SECRET`) → `Seu link expirou…`;
    `/app` renews it.
16. The workout and food forms still submit by `sendData` exactly as before (regression).
17. Phone call or another app taking the microphone during `listening` → clean error, no stuck
    state.

Privacy:
18. After items 1–17, search the bot and endpoint logs for a word that was spoken: no match.

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| The Telegram WebView refuses the microphone on some platform (unverified; iOS WebKit bugs). | Feature detection, explicit error, plan B to the chat voice note (§7.5); checklist items 9–12, 17. |
| Gemini refuses `audio/mp4` even relabelled as `m4a`. | Page prefers WebM/Opus when supported; server answers `unsupported_format`; plan B. No transcoding. |
| Transcription errors on numbers ("80 por 8" heard as "88"). | Mandatory confirmation with editable text; numbers-as-digits rule; vocabulary refined from correction counts. |
| A model "transcribes" silence or hallucinates text. | `<vazio>` sentinel, minimum duration, 2000-character cap, confirmation. |
| Double confirmation writes twice (sheet dedup includes args). | Double-tap guard + keyboard removed before the run; residual after a restart (keyboard already gone in the normal case). |
| Leaked link token. | Scope `voice` only (no writes), 7-day TTL, rate limit and daily token budget, rotation of `APP_LINK_SECRET`. The token lives only in the person's own keyboard. |
| Public endpoint attack surface and cost runaway. | Auth before any work, byte cap while reading, rate limits, concurrency cap, daily budget, CORS allowlist, no cookies. |
| In-memory limits and caches are per process. | Documented; budgets per instance are conservative enough for one or two clients; the database step backs the same interfaces. |
| Endpoint host not decided (polling has no HTTPS). | The chat path needs no endpoint; the page hides the button without `vu` (D1). |
| Transcript or audio in logs. | §10 list, removal of the existing `%r text` warnings, `caplog` tests, checklist item 18. |
| One extra model call adds latency. | ~1–3 s, offset by a shorter agent prompt (text instead of audio on every call). |
| Free-tier provider terms. | Paid tier before other clients (D5). |

## 13. Tasks

Each task is one branch, one PR, small enough for Sonnet. Shared rules for all: no new
dependencies, no secrets or real ids in code, tests, fixtures or docs (the repository is public),
no push/deploy without the owner, existing tests stay green (`uv run pytest` in
`services/agent`, `npm test` and `npm run check` at the root).

### C4 — Transcription layer and chat confirmation (Python)

- **Goal:** a voice/audio message is transcribed once and confirmed in the chat before the agent
  runs; the four C1 gaps closed.
- **Files:** new `agent/transcribe.py` (`audio_format`, `Transcriber`, `TranscribeError`,
  `build_transcriber`, `TRANSCRIBE_PROMPT`); `settings.py` (`TRANSCRIBE_MODEL`,
  `TRANSCRIBE_FALLBACK_MODEL`, `TRANSCRIBE_API_KEY`, `TRANSCRIBE_TIMEOUT_S`, `VOICE_MAX_SECONDS`
  and the §3.1 checks); `handler.py` (`MediaRef.duration`, audio → transcriber, `Entendi`
  message, `vok`/`vfix`/`vno`, early callback answer, double-tap guard, gap 1); `buttons.py`
  (voice keyboard, prefix, `transcript_from`, voice fix prompt); `bot.py` (new messages, rule 16,
  the five log lines); `commands.py` (one help line); `settings.yaml` (defaults, no secrets);
  tests: new `tests/test_transcribe.py`, updates to `test_handler.py`, `test_buttons.py`,
  `test_settings.py`, `test_voice_path.py` (cherry-pick `59bf0f5` first).
- **Depends on:** C1 commit `59bf0f5`.
- **Done when:** §4.1 and §8 behave as written; photos unchanged (still inline to the agent);
  audio never reaches `Bot.reply`; settings refuse a non-audio transcription model; caplog test
  proves no transcript/caption in logs; all suites green.
- **Tests:** format mapping table; prompt sent with `temperature=0` and `input_audio`; `<vazio>`,
  `[inaudível]`-only and >2000 characters; retry then fallback; timeout → transient
  `VOICE_FAILED`; duration over the limit refused before `getFile`; caption + transcript shown
  together; `vok` runs the agent with the recovered text and scope `tg:voice:…`; double `vok`
  runs once; unparseable or inaccessible message → expired toast; `vfix` reply gets no context;
  `vno` writes nothing; the four gap tests.
- **Do not:** add the HTTP endpoint or auth; store transcripts; change the photo path; change
  `RetryingClient` behaviour for the agent; add a dependency (no ffmpeg, no audio parsing lib).
- **Model:** Sonnet.

### C5 — Pluggable auth and the voice endpoint (Python)

- **Goal:** `POST /v1/voice/transcriptions` as in §5, authenticated as in §6.
- **Files:** new `agent/auth.py` (§6.1–6.4, plus `issue_link_token` used by C7); new
  `agent/voice_api.py` (handler logic independent of Starlette: limits, rate limiter, budget,
  idempotency cache, error shapes); `asgi.py` (route, `OPTIONS`, `CORSMiddleware`); `settings.py`
  (`VOICE_API_ENABLED`, `VOICE_MAX_BYTES`, `VOICE_ALLOWED_ORIGINS`, `APP_LINK_SECRET`,
  `APP_LINK_TTL_S`, `INITDATA_MAX_AGE_S`, `VOICE_RATE_PER_MIN`, `VOICE_RATE_PER_DAY`,
  `VOICE_DAILY_TOKENS`, `VOICE_MAX_CONCURRENT`); `services/agent/README.md` (how to run it);
  tests `test_auth.py`, `test_voice_api.py`.
- **Depends on:** C4 (`transcribe.py`).
- **Done when:** every row of the §5.3 table has a test; §5.4 order holds (an unauthenticated
  or oversized request never calls the transcriber; the body is not read before auth); CORS
  preflight answers only the allowed origin; caplog proves no body, transcript, header or token
  in logs.
- **Tests:** `initData` valid / tampered field / wrong token / expired / future `auth_date`
  (vectors built in the test with a fake bot token); link token valid / bad MAC / expired / wrong
  scope / wrong version; unknown scheme; allowlist; rate limit per minute and per day with an
  injected clock; budget charged from `usage.prompt_tokens` and reset at midnight in `TIMEZONE`;
  idempotent replay, conflict, in-flight coalescing; byte cap via header and via a body longer
  than its header; duration header; every MIME in §3.2.
- **Do not:** write to the sheet or call the agent; add multipart parsing; accept credentials in
  the query string; log principals in clear; deploy or choose a host (D1). If the task is too
  large, split at the seam: `auth.py` first (pure, no HTTP), then the endpoint.
- **Model:** Sonnet (Codex review of the HMAC code is required).

### C7 — Bot glue for Mini App voice (Python, small)

- **Goal:** `/app` links carry `vu`/`vt`/`vx`; the bot accepts the `t:"text"` payload.
- **Files:** `miniapp.py` (`keyboard_markup` adds the keys when `VOICE_API_URL` and
  `APP_LINK_SECRET` are set, budget rule of §7.1, `DROPPED_LABELS["voice"] = "voz"`; pydantic
  model for `t:"text"`); `handler.py` (`_miniapp` routes `t:"text"` to the agent with scope
  `tg:{chat_id}:miniapp:text:{id}`; `_run_bot` gains an optional scope key); `settings.py`
  (`VOICE_API_URL`); tests in `test_miniapp.py`, `test_handler.py`.
- **Depends on:** C5 (`issue_link_token`). Independent of C6 except for the contract in §4.2/§7.1.
- **Done when:** links with and without voice settings; trimming keeps voice keys until the last
  resort; a valid `t:"text"` payload runs the agent once with the right scope; invalid ones
  (empty, >2000 characters, control characters, extra fields, bad id) get `⚠ Não gravei nada: …`
  and never reach the model; form payloads unchanged.
- **Do not:** change the form payloads or their model-free path; change the launch mode.
- **Model:** Sonnet (Haiku is acceptable if the reviewer checks the validation).

### C6 — Record button in the Mini App (JS)

- **Goal:** §7 in the page.
- **Files:** new `apps/miniapp/src/voice.js` (DOM, `MediaRecorder`, fetch); `core.js` (pure:
  `pickVoiceMime`, `voiceReducer` for §7.2, `voiceError` for §7.4, `textPayload` + size check,
  `voiceAvailable(catalog, env)` for §7.1); `app.js` (dock button, MainButton hand-over, mascot
  state names); `index.html`, `styles.css`; `dev/` stub transcript for preview; tests in
  `apps/miniapp/test/`.
- **Depends on:** the contracts in §4.2, §5.2–5.3 and §7.1 (can start before C5/C7 ship; end to
  end needs both).
- **Done when:** every state and transition of §7.2 and every row of §7.4 is covered by pure
  tests; the button follows §7.1 exactly; tracks are stopped on every exit path; consent shown
  once; plan B closes the app; preview mode never calls a real endpoint; forms untouched;
  `npm test` and `npm run check` green.
- **Do not:** draw the mascot's new art (state names only); add a build step or npm package;
  store audio or transcripts in `localStorage`; send anything but the confirmed text through
  `sendData`.
- **Model:** Sonnet.

### C8 — Device validation (owner, manual)

The checklist in §11.2, after C4 for items 1–8 and after C5–C7 plus a deployed endpoint for 9–18.
Its results decide whether the `m4a` relabel stays and close the "not verified" rows of §2.

Order: C4 → C5 → C7 → C6 (C6 can be developed in parallel with C5/C7 against the contracts) → C8.

## 14. Open decisions (owner)

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | Where the voice endpoint runs | (a) Cloud Run service from `agent.asgi`, separate from the polling bot; (b) a tunnel to the owner's PC; (c) no endpoint until the database step (chat voice only) | **(a)**: already designed for it, HTTPS and scale to zero, independent of the PC being on. Needs approval (deploy, possibly paid). Until then, (c) happens by default. |
| D2 | Maximum duration | 60 s / 90 s / 120 s | **90 s**: a full workout fits; the confirmation stays readable. |
| D3 | Link token lifetime | 24 h / 7 days / 30 days | **7 days**: the keyboard is persistent and the catalog in it already goes stale; renewing is one `/app`. |
| D4 | Confirmation always, or auto-write | always / auto after N days with low correction rate / per-person setting | **Always** in this version; revisit with the confirm/correct counters of §10. |
| D5 | Provider tier for audio | free-tier key / paid-tier key / Vertex AI | **Paid tier (or Vertex) before any client other than the owner** uses voice. |
| D6 | Transcript in the idempotency cache | none / 5 min in memory | **5 min in memory**: saves a second paid call on a dropped connection; never on disk. |
| D7 | Rate limits and budget | the defaults in §5.5 or other values | **§5.5 defaults** for one to three clients; revisit at the database step. |
| D8 | Where the Mini App mic lives | dock button on both views / a third keyboard button `🎙️ Falar` opening a voice view | **Dock button**: no change to the keyboard or link budget; one tap from any form. |
| D9 | When to start step 2 of §6.6 | with the database step / earlier, on its own | **With the database step**: it needs a hosted API anyway and is the first thing a PWA reuses. |

## 15. Out of scope / later

- **Voice → pre-filled form draft** (the original "Next after the MVP" idea): extracting payload
  v1 from the transcript and opening the form filled in. It needs structured extraction and
  catalog matching; this spec's confirmed text → agent path ships first and produces the
  transcripts needed to design it.
- Catalog names (exercises, foods, sessions) as spelling hints in the transcription prompt, from
  a server-side cached catalog.
- Streaming / live transcription while speaking.
- Transcoding (`ffmpeg`) or audio parsing libraries.
- HTTP submission endpoints (`/v1/entries`, `/v1/messages`, `/v1/catalog`), the menu-button
  launch, PWA and native authentication (steps 2–4 of §6.6).
- Photo path changes (photos keep going inline to the agent).
- Voice replies from the bot (text-to-speech).
