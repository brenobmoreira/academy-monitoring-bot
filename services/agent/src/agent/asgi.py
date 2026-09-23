"""ASGI entry point — for uvicorn in any container (Cloud Run service, docker compose, a VM).

    uv run uvicorn agent.asgi:app --host 0.0.0.0 --port 8080

Routes: POST / receives the Telegram webhook, GET /healthz answers liveness checks.
"""

from __future__ import annotations

import logging

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse
from starlette.routing import Route

from agent import webhook

logging.basicConfig(level=logging.INFO)


async def telegram(request: Request) -> PlainTextResponse:
    try:
        body = await request.json()
    except ValueError:
        body = None
    text, status = await webhook.process(request.headers.get(webhook.SECRET_HEADER), body)
    return PlainTextResponse(text, status_code=status)


async def healthz(_request: Request) -> PlainTextResponse:
    return PlainTextResponse("ok")


app = Starlette(routes=[Route("/", telegram, methods=["POST"]), Route("/healthz", healthz, methods=["GET"])])
