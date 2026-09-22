# 0002 — LLM through an OpenAI-compatible endpoint

Date: 2026-09-21 · Status: superseded by 0003

## Context

Free text like "supino inclinado 60x8 62x8 rir 2, dormi 7h" is beyond regex. LiteLLM was
considered but it is a Python proxy and the project has no server. Gemini exposes an
OpenAI-compatible endpoint; so does a LiteLLM proxy if one is ever available.

## Decision

`LlmClient` speaks the OpenAI chat-completions format with `response_format: json_schema`.
Provider = (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`) in Script Properties. v1 uses Gemini.
A keyword regex fallback keeps the diary usable without any LLM.

## Consequences

- Switching provider is configuration, not code.
- Jev (typesafe.ai) is not a drop-in: it answers closed questions, so it can only sit in front of
  the extractor as a classifier or confidence gate.
