# 0003 — Python ADK agent in front of a strict Apps Script sheet API

Date: 2026-09-22 · Status: accepted · Amends 0001, supersedes 0002

## Context

The v1 bot did everything inside Apps Script: Telegram webhook, LLM extraction and writes. The
agent side is where the bot will grow (tools, history questions, corrections), and agent
frameworks live in Python. Apps Script only runs JavaScript and is the one place that can own
the spreadsheet menu.

Options: (A) keep Apps Script only; (B) TypeScript compiled for Apps Script, same topology;
(C) Python agent on a serverless runtime, Apps Script reduced to a validated write API plus the
sheet menu.

## Decision

C. A Python service built with Google ADK and Gemini (Vertex AI) runs as a Cloud Run function
behind the Telegram webhook. It reaches the spreadsheet only through the Apps Script Web App,
which accepts exact JSON (no coercion), validates every field against the sheet catalogue and
answers with either what it wrote or the full list of errors, so the agent can correct itself.

## Consequences

- Two deploys: Cloud Build from GitHub for the agent, `clasp` for Apps Script.
- Telegram's `secret_token` header can now be checked (the agent sees headers).
- The regex fallback is gone: without an LLM there is no chat bot; the sheet menu still works.
- The OpenAI-compatible `LlmClient` of 0002 is removed; the model is an ADK setting.
- The daily reminder is dropped until it is needed again.
