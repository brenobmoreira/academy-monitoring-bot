#!/usr/bin/env bash
# Registers (or inspects) the Telegram webhook pointing at the agent's Cloud Run function.
# Reads everything from environment variables; nothing is stored on disk.
#
#   TELEGRAM_BOT_TOKEN       token from BotFather
#   AGENT_URL                Cloud Run function URL (https://<name>-<hash>.<region>.run.app)
#   TELEGRAM_WEBHOOK_SECRET  same value the function has in TELEGRAM_WEBHOOK_SECRET;
#                            Telegram sends it back in the X-Telegram-Bot-Api-Secret-Token header
#
# Usage:
#   scripts/set-webhook.sh set     # register webhook
#   scripts/set-webhook.sh info    # show current webhook
#   scripts/set-webhook.sh delete  # remove webhook (needed before local polling)
set -euo pipefail

cmd="${1:-info}"
: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}"
api="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

case "$cmd" in
  set)
    : "${AGENT_URL:?set AGENT_URL}"
    : "${TELEGRAM_WEBHOOK_SECRET:?set TELEGRAM_WEBHOOK_SECRET}"
    curl -sS "${api}/setWebhook" \
      --data-urlencode "url=${AGENT_URL}" \
      --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
      --data-urlencode "allowed_updates=[\"message\"]" \
      --data-urlencode "drop_pending_updates=true"
    ;;
  info)   curl -sS "${api}/getWebhookInfo" ;;
  delete) curl -sS "${api}/deleteWebhook" ;;
  *) echo "usage: $0 {set|info|delete}" >&2; exit 2 ;;
esac
echo
