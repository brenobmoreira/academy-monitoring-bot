# Agent tracing through OpenTelemetry — design

Date: 2026-09-22 · Status: draft · Refines section 2 of
`2026-09-22-ci-observability-storage-design.md`

## Goal

For any Telegram message, see the whole run as one trace: what the model received and
answered, each tool call with its arguments and the sheet API's answer, the correction rounds,
tokens and latency. The code knows only OpenTelemetry: the backend (Langfuse, Grafana Tempo,
Honeycomb, Jaeger, Arize Phoenix, an OTel Collector...) is chosen by configuration, the same way
LiteLLM makes the model provider a configuration value (ADR 0004).

Success:

- With no tracing settings, the agent behaves exactly as today: no exporter, no network, no
  new dependency loaded at import time beyond the OTel API that ADK already pulls in.
- Pointing `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` at Langfuse Cloud
  shows one trace per message, with the user and the update id on it, and no line of code
  mentions Langfuse.
- Changing to another backend is changing those two values.

## Why OpenTelemetry and not the Langfuse SDK

| | OTel + OTLP | Langfuse SDK |
|---|---|---|
| Backends | any OTLP receiver, Langfuse included | Langfuse only |
| Code in the agent | one setup module + one root span | decorators or callbacks tied to Langfuse |
| What ADK gives for free | ADK already creates spans for agent runs, LLM calls and tool calls through the global OTel tracer | the SDK has to be wired into ADK or LiteLLM separately |
| Cost of leaving Langfuse | change two settings | rewrite the instrumentation |

Langfuse ingests OTLP over HTTP at `/api/public/otel`, so choosing OTel costs nothing when
Langfuse is the backend.

## What already exists

- ADK (`google.adk.telemetry.tracing`) creates spans through `trace.get_tracer(...)`: the
  invocation, each agent run, each LLM call (`gen_ai.request.model`, token usage) and each tool
  call. Without a configured `TracerProvider` those spans go to the no-op provider and cost
  nothing.
- `opentelemetry-api` and `opentelemetry-sdk` are already installed as ADK dependencies. The
  OTLP exporter is not.
- ADK has a helper, `google.adk.telemetry.setup.maybe_set_otel_providers`, that reads the
  standard `OTEL_EXPORTER_OTLP_*` variables from `os.environ`.

## Design

### Settings

The agent's settings are read from env, `.env` and `settings.yaml` (`settings.py`), but only the
environment reaches `os.environ`. Values in `.env` would never reach the OTel SDK. So the
tracing settings are fields of `Settings`, named after the standard OTel variables (the repo
already names fields after their environment variables). The agent then builds the exporter
from those fields itself.

| Setting | Secret | Default | Meaning |
|---------|--------|---------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | empty | OTLP/HTTP base URL; empty disables tracing. Traces go to `<endpoint>/v1/traces` as the OTel spec says |
| `OTEL_EXPORTER_OTLP_HEADERS` | **yes** | empty | `key=value,key2=value2`, the OTel format; usually carries the credentials |
| `OTEL_SERVICE_NAME` | no | `fitness-agent` | `service.name` of the resource |
| `TRACE_CONTENT` | no | `true` | whether spans carry message and tool payloads (see *Privacy*) |

`OTEL_EXPORTER_OTLP_HEADERS` joins `Settings.SECRETS`, so it is rejected from `settings.yaml`
and lives in Secret Manager on Cloud Run.

Examples (documented in `services/agent/README.md`, not in code):

```bash
# Langfuse Cloud (EU); the header is base64("<public key>:<secret key>")
OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64>"

# Local Jaeger or an OTel Collector
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

### Module `agent/tracing.py`

The only module that touches the OTel SDK:

```python
def setup(settings: Settings) -> None
    """Installs a TracerProvider with a BatchSpanProcessor(OTLPSpanExporter) once per process.
    No endpoint → does nothing. A provider set by someone else (tests, a host) is left alone."""

def update_span(update_id: int | None, chat_id: int | None) -> ContextManager[Span]
    """Root span for one Telegram update; ADK's spans nest under it."""

def flush(timeout_ms: int = 5000) -> None
    """force_flush on the provider; no-op when tracing is off. Never raises."""
```

- **Exporter**: `opentelemetry-exporter-otlp-proto-http`, a new dependency. HTTP rather than
  gRPC because Langfuse accepts only HTTP, and HTTP needs no gRPC wheels in the Cloud Run image.
- **Why not `maybe_set_otel_providers`**: it reads only `os.environ`, so `.env` and
  `settings.yaml` would not work; and it also installs metric and log exporters on the same
  endpoint, which Langfuse rejects. The agent builds the tracer provider itself. The helper
  stays useful as a reference for resource detection.
- **Idempotent**: the webhook builds a `Handler` per request (`webhook.process`), but `setup`
  installs the provider once per process (module-level guard).

### Root span and attributes

`Handler.handle_update` opens `update_span` around the whole update, including the Telegram
reply, so one message is one trace:

| Attribute | Value | Read by |
|-----------|-------|---------|
| `session.id` | Telegram `update_id` | OTel semconv; Langfuse maps it to the trace's session |
| `user.id` | chat id | OTel semconv; Langfuse maps it to the trace's user |
| `input.value` / `output.value` | message text / reply sent (only if `TRACE_CONTENT`) | Langfuse and Phoenix show them as the trace's input and output |
| `agent.llm_calls`, `agent.sheet_writes`, `agent.budget_exhausted` | counts from the run | any backend, for filters and alerts |

Only vendor-neutral names. The plan checks how Langfuse maps each one. If a Langfuse-only
attribute (`langfuse.*`) ever turns out to be necessary, it goes in one optional
`attribute_aliases` table in `tracing.py`, never at call sites.

Status: the span gets `ERROR` status and the exception recorded when the bot raises (today that
path answers `FAILURE`). This is the trace the e2e run of 2026-09-22 would have needed: a 503
from the provider after all writes succeeded.

### Flush

Cloud Run throttles CPU after the response is sent and scales to zero, so a
`BatchSpanProcessor` left alone loses spans silently. `handle_update` calls `tracing.flush()` in
a `finally` after the reply, bounded by a timeout so a slow backend cannot hold the webhook past
Telegram's retry window. A tracing failure never changes the reply.

### Privacy

With `TRACE_CONTENT=true` (default) spans carry the message text and tool payloads (weight,
sleep, diet). That is the point of tracing an LLM agent, and it is accepted for a personal bot.
With `false`:

- the root span omits `input.value` / `output.value`;
- ADK is told not to capture content through its own switch (`ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS`
  / `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`, set by `setup` before the first run).
  The plan confirms ADK's default and which variable wins.

Model names, token counts, timings and error codes are always kept.

### Richer LLM spans (optional, not in the first cut)

ADK's spans report the model and tokens but not the cost. If the backend needs more,
`openinference-instrumentation-google-adk` adds OpenInference attributes. It is still
vendor-neutral OTel and Langfuse and Phoenix read it. It is added only if the first cut shows a
gap, as one more instrumentor in `tracing.setup`.

## Tests

Tests install an `InMemorySpanExporter` through a fixture and never reach the network.

- `setup` with no endpoint installs nothing; `flush` is then a no-op.
- `setup` twice installs one provider.
- `OTEL_EXPORTER_OTLP_HEADERS` in `settings.yaml` is rejected like the other secrets.
- One update → one root span with `session.id` and `user.id`, and ADK's LLM and tool spans as
  its descendants (with the scripted LLM from `tests/fakes.py`).
- Bot raises → span status `ERROR`, reply is still `FAILURE`, flush still called.
- `TRACE_CONTENT=false` → no span attribute contains the message text.
- Flush raising or timing out → reply unchanged.

e2e: `e2e/run.py` gains `--otlp <endpoint>` so a local run can be looked at in Jaeger or
Langfuse. It stays off by default and in CI.

## Out

- Metrics and logs over OTLP: Cloud Run already collects both. JSON logs stay a separate item
  of the parent spec.
- Scores and evaluations in Langfuse: they need the Langfuse API, so not vendor-neutral. Revisit
  after traces are in.
- Tracing the Apps Script side: it cannot export OTLP. The sheet API calls are visible as the
  tool spans on the agent side, with request and response.

## Rollout

1. Implement behind the empty default; deploy; nothing changes.
2. Create a Langfuse Cloud project (Hobby plan, EU region), put `OTEL_EXPORTER_OTLP_HEADERS` in
   Secret Manager and set the endpoint on the Cloud Run service.
3. Send a message; check the trace tree, the session and user fields, and that a cold start
   still flushes.
