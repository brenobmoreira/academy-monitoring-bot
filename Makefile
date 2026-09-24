# Common tasks. Run from the repository root; `make` alone lists the targets.
# CI calls the tools directly (.github/workflows/ci.yml); keep both in sync when a command changes.

AGENT := services/agent
SHEET := apps/sheet

HOST ?= 127.0.0.1
PORT ?= 8080
E2E_ARGS ?=
CLASP ?= clasp

.DEFAULT_GOAL := help

.PHONY: help install test test-sheet test-agent lint fmt e2e poll serve \
	webhook-set webhook-info webhook-delete commands push-sheet

help: ## List the targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-z0-9-]+:.*## / {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install the agent's dependencies from uv.lock (uv sync --locked)
	cd $(AGENT) && uv sync --locked

test: test-sheet test-agent ## Run both test suites (no network)

test-sheet: ## Apps Script tests (npm test)
	npm test

test-agent: ## Agent tests (uv run pytest)
	cd $(AGENT) && uv run pytest

lint: ## ruff check, ruff format --check, ty check and npm run check
	cd $(AGENT) && uv run ruff check .
	cd $(AGENT) && uv run ruff format --check .
	cd $(AGENT) && uv run ty check
	npm run check

fmt: ## Format and autofix the agent (ruff format, ruff check --fix)
	cd $(AGENT) && uv run ruff format .
	cd $(AGENT) && uv run ruff check --fix .

e2e: ## Local end-to-end run, scripted provider (extra flags: E2E_ARGS="--server uvicorn")
	cd $(AGENT) && uv run python ../../e2e/run.py $(E2E_ARGS)

poll: ## Run the bot with local long polling (needs services/agent/.env; delete the webhook first)
	cd $(AGENT) && uv run agent-poll

serve: ## Serve the ASGI webhook app with uvicorn (HOST=127.0.0.1 PORT=8080)
	cd $(AGENT) && uv run uvicorn agent.asgi:app --host $(HOST) --port $(PORT)

webhook-set: ## Register the Telegram webhook (env: TELEGRAM_BOT_TOKEN, AGENT_URL, TELEGRAM_WEBHOOK_SECRET)
	scripts/set-webhook.sh set

webhook-info: ## Show the current Telegram webhook (env: TELEGRAM_BOT_TOKEN)
	scripts/set-webhook.sh info

webhook-delete: ## Remove the Telegram webhook, needed before polling (env: TELEGRAM_BOT_TOKEN)
	scripts/set-webhook.sh delete

commands: ## Set the bot's command menu via setMyCommands (uv run agent-commands)
	cd $(AGENT) && uv run agent-commands

push-sheet: ## Push apps/sheet to Apps Script (clasp push; needs apps/sheet/.clasp.json)
	cd $(SHEET) && $(CLASP) push
