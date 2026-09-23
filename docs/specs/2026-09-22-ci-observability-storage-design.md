# CI, observability and a storage seam — design

Date: 2026-09-22 · Status: draft · Branch: `feat/ci-cd-integration`

Three independent topics. Only the first ships on this branch; the other two record the
decision and the order of work so they can be planned separately.

| # | Topic | State |
|---|-------|-------|
| 1 | CI on GitHub Actions + Dependabot | implemented on this branch |
| 2 | Observability: OpenTelemetry traces (Langfuse as first backend), Cloud Logging for the function | designed; tracing detailed in `2026-09-22-otel-tracing-design.md` |
| 3 | Storage behind a port, so Postgres can replace the spreadsheet | designed, needs one decision (below) |

---

## 1. CI/CD

### Goal

Every PR and every push to `main` runs the same checks a developer runs locally, and a red check
is visible before the Cloud Build trigger deploys.

### What runs

`.github/workflows/ci.yml`, three jobs:

| Job | Runs when | Steps |
|-----|-----------|-------|
| `changes` | always | `dorny/paths-filter` decides which of the two below run |
| `sheet` | `apps/sheet/**`, `package.json` or the workflow changed | `npm run check`, `npm test` (Node 22: `node --test` expands globs only from Node 21) |
| `agent` | `services/agent/**`, `e2e/**`, `apps/sheet/src/**` or the workflow changed | `uv sync --locked`, `ruff check`, `ruff format --check`, `ty check`, `pytest`, scripted e2e run; the e2e trace is uploaded as an artifact |

`apps/sheet/src/**` triggers the agent job because the e2e run executes the real Apps Script
sources through `e2e/sheet_server.js`: a change to the validator can break the agent's
correction loop without breaking any JS unit test.

The scripted e2e run needs no secret: the provider is replayed, Telegram and the sheet are local
fakes. No secret is configured in the repository.

`.github/dependabot.yml`: weekly grouped PR for `services/agent` (uv — `google-adk` and
`litellm` move fast and are the likeliest source of silent breakage), monthly for the actions
themselves. The root `package.json` has no dependencies, so npm is left out.

### Deploy stays on Cloud Build

The agent keeps deploying through the Cloud Run "Connect repo" trigger
(`services/agent/README.md`, *Continuous deployment from GitHub*). Moving deploy into Actions
only pays off to gate deploy on CI; when that is wanted, use `google-github-actions/auth` with
Workload Identity Federation (no JSON key in secrets) and remove the Cloud Build trigger in the
same change, so there is one deploy path.

### Out

- `clasp push/deploy` in Actions: it needs the owner's OAuth refresh token (`.clasprc.json`) as
  a secret, which grants access to the owner's Drive. The Apps Script side changes rarely;
  `clasp` stays manual.
- `e2e/run.py --real` in CI: costs money per run and is not deterministic. Can be added later as
  a `workflow_dispatch` job reading `LLM_API_KEY` from a repository secret.

---

## 2. Observability

### Goal

For any message, answer without reproducing it: what the model received, which tools it
called with what arguments, what the sheet API answered, how many correction rounds it took,
tokens and cost. And get told when the function fails, without watching it.

### Choice

| Need | Tool | Why |
|------|------|-----|
| Agent traces (LLM calls, tool calls, retries, cost) | **Langfuse Cloud, Hobby plan** | Free, no credit card: 50k units/month, 30-day retention, 2 users, hard cap (tracing stops at the limit, nothing is billed). Self-hosting is not required |
| Function errors, latency, cold starts | **Cloud Logging + Cloud Monitoring** | Already there on Cloud Run; no new vendor |

Budget check: a unit is every trace, observation and score. One message is one trace plus one
generation per LLM call and one span per tool call — about 10 units for a typical message,
around 20 with correction rounds. 50k units covers roughly 2,500 messages a month, well above a
personal log's usage. If the cap is ever hit, the bot keeps working; only tracing stops.

### Design

The tracing part is superseded by `2026-09-22-otel-tracing-design.md`: the agent speaks
OTLP only and Langfuse is configuration, not a dependency. The bullets below keep the original
reasoning; where they differ, that spec wins.

- **Instrumentation**: ADK emits OpenTelemetry spans; the OpenInference instrumentor for Google
  ADK plus the Langfuse SDK export them to Langfuse. This captures agent, tool and generation
  spans in one tree. LiteLLM's own `langfuse` callback is the fallback: it sees only the LLM
  calls, not the tool spans. The plan confirms which one produces the tree above.
- **Opt-in by configuration**: new settings `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`
  (secret), `LANGFUSE_HOST`. Absent → no exporter, no network, same behaviour as today. Tests
  and the e2e run keep working without them.
- **Flush per request**: Cloud Run throttles CPU once the response is sent and scales to zero,
  and the SDK exports in batches in the background. `Handler.handle_update` flushes after sending
  the reply; without it traces are lost silently.
- **Trace attributes**: `session_id` = Telegram `update_id`, `user_id` = chat id, tags = model
  name, and the final reply as the trace output.
- **Privacy**: traces carry the message text (weight, sleep, diet) to a third party. Accepted
  for a personal bot; pick the EU region at sign-up. If that changes, Langfuse's `mask` hook
  can redact inputs before export, or the same settings point at a self-hosted instance.
- **Logs**: switch to JSON logs (Cloud Logging parses them) with `update_id`, `chat_id`,
  elapsed time, LLM call count and whether the call budget was exhausted. One log-based alert
  on `bot failed on update` (`handler.py`) and one on 5xx from the function.

### Tests

- Settings without `LANGFUSE_*` build no exporter.
- With them, `handle_update` flushes once per update, also when the bot raises.

---

## 3. Storage behind a port

### Where the coupling is

| Layer | Coupled to | Cost to swap |
|-------|-----------|--------------|
| LLM provider | nothing; LiteLLM picks it from `LLM_MODEL` | configuration |
| Agent framework | ADK, only in `bot.py` | rewrite `bot.py` |
| Chat channel | Telegram's update shape in `Handler.handle_update` and `telegram.py` | new adapter + parsing |
| **Storage** | the Python side sees only the `SheetApi` protocol (4 methods, `tools.py`); **the domain rules live in Apps Script** | see below |

The rules that make the bot reliable are in JS: strict validation with
`{path, code, message, suggestions}` errors that the model uses to correct itself
(`validator.js`), the catalog built from the `Exercícios` and `Ficha de treino` tabs and the
current phase, upsert semantics (same exercise + date + session replaces the row), `sessionId`,
history. `summary.py` depends on the shape of each `result`.

A Postgres adapter is therefore cheap to write, but it would need all of that ported first.

### Plan in three steps, each shippable alone

1. **Name the port** (no behaviour change). Rename `SheetApi` to `LogStore`; the name should not
   assume a spreadsheet. Turn the fake in `tests/fakes.py` into a contract suite: the same
   cases (valid write, every error code, upsert replacing a row, history order) run against any
   `LogStore`. The Apps Script adapter runs it through `e2e/sheet_server.js`.
2. **Move the domain rules to Python.** Port the validator to pydantic models in strict mode,
   keeping the error contract and the Portuguese messages (the prompt depends on them). Port
   the catalog and upsert rules. The Apps Script API keeps its own validator while the sheet menu
   uses it.
3. **`PgStore`.** Tables for diary, workout sets, exercises, plan and phase; migrations; the
   contract suite from step 1 passes against it. Selected by a setting (`STORE=sheet|postgres`)
   in `build_handler`.

After step 2, changing storage means writing one adapter.

### Decision needed before step 2

- **Replace**: Postgres becomes the only store. The `Registro` menu, the `Hoje` screen and the
  `Progressão` tab disappear, and exercises and plan need another way to be edited.
- **Mirror**: Postgres is the source of truth and the spreadsheet stays as a read-only view
  (periodic export). Keeps the spreadsheet's visual use, costs a sync job.

Step 1 is worth doing regardless of the answer.
