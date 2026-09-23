# 0004 — LLM through LiteLLM, configured by LLM_* variables

Date: 2026-09-22 · Status: accepted · Amends 0003

## Context

0003 put Gemini behind ADK's native Google client. The settings followed the provider
(`GEMINI_MODEL`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`), so the rest of the design was
provider-neutral but the model was not: switching to another vendor meant code and new variables.
`gemini-2.5-flash` being closed to new users was the reminder that the model will change.

## Decision

The agent builds its model with ADK's `LiteLlm` adapter. Configuration is three
provider-neutral values: `LLM_MODEL` in LiteLLM's `<provider>/<model>` form (default
`gemini/gemini-3.8-flash`), `LLM_API_KEY`, and optional `LLM_API_BASE` for a LiteLLM proxy or a
self-hosted model. Settings are named after their environment variables, as in the other Harbor
services, with non-secret defaults in `settings.yaml`.

The webhook is served by one core (`webhook.process`) with two entry points: the Functions
Framework (Cloud Run functions) and an ASGI app (uvicorn, any container).

## Consequences

- Changing provider or model is a variable and a restart, no rebuild.
- `litellm` joins the dependencies; its version is pinned by `uv.lock` / `requirements.txt`.
- Vertex AI remains possible as `vertex_ai/...`, with LiteLLM's own `VERTEXAI_PROJECT` and
  `VERTEXAI_LOCATION` variables instead of an API key.
- Tests replace only the provider call inside LiteLLM, so the ADK ↔ LiteLLM tool conversion is
  exercised without network.
