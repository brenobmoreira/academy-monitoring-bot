"""Functions Framework entry point — what Cloud Run functions runs.

Deployed with --function telegram_webhook (root main.py re-exports it). Locally:
    uv run functions-framework --source main.py --target telegram_webhook --port 8080
"""

from __future__ import annotations

import asyncio
import logging

import functions_framework
from flask import Request

from agent import reminder, webhook

logging.basicConfig(level=logging.INFO)


@functions_framework.http
def telegram_webhook(request: Request) -> tuple[str, int]:
    """One function, two paths: /remind for the scheduled reminders, anything else is Telegram."""
    if request.path == reminder.PATH:
        if request.method != "POST":
            return "method not allowed", 405
        token = request.headers.get(reminder.TOKEN_HEADER)
        return asyncio.run(reminder.process(token, request.get_json(silent=True)))
    secret = request.headers.get(webhook.SECRET_HEADER)
    return asyncio.run(webhook.process(secret, request.get_json(silent=True)))
