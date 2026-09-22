# 0001 — One Apps Script project bound to the spreadsheet

Date: 2026-09-21 · Status: accepted, amended by 0003 (the bound project is now the sheet API, not the bot)

## Context

The bot writes to a spreadsheet that also needs its own automation (save the Hoje screen,
rebuild progression). Options: (A) one bound project serving both Telegram and the sheet menu;
(B) a standalone bot plus a separate bound project, duplicating the write logic; (C) a standalone
bot calling the bound project through the Apps Script Execution API (GCP project, OAuth).

## Decision

A. One bound project. Domain code (`DiaryRepo`, `WorkoutRepo`, `Progression`) is shared by two
adapters: the Telegram webhook and the sheet menu.

## Consequences

- No `SPREADSHEET_ID`: the script uses the active spreadsheet.
- The README must explain how to create the spreadsheet with the expected tabs, since the code
  assumes their headers.
- Deploying is one `clasp push` + `clasp deploy -i`.
