#!/usr/bin/env bash
# Registers (or inspects) the Telegram webhook for one bot.
# Reads everything from environment variables; nothing is stored on disk.
#
#   TELEGRAM_BOT_TOKEN  token from BotFather
#   WEBAPP_URL          Apps Script Web App URL (ends with /exec)
#   WEBHOOK_SECRET      same value stored in Script Properties as WEBHOOK_SECRET
#
# Usage:
#   scripts/set-webhook.sh set     # register webhook
#   scripts/set-webhook.sh info    # show current webhook
#   scripts/set-webhook.sh delete  # remove webhook
set -euo pipefail

cmd="${1:-info}"
: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}"
api="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

case "$cmd" in
  set)
    : "${WEBAPP_URL:?set WEBAPP_URL}"
    : "${WEBHOOK_SECRET:?set WEBHOOK_SECRET}"
    curl -sS "${api}/setWebhook" \
      --data-urlencode "url=${WEBAPP_URL}?secret=${WEBHOOK_SECRET}" \
      --data-urlencode "allowed_updates=[\"message\"]" \
      --data-urlencode "drop_pending_updates=true"
    ;;
  info)   curl -sS "${api}/getWebhookInfo" ;;
  delete) curl -sS "${api}/deleteWebhook" ;;
  *) echo "usage: $0 {set|info|delete}" >&2; exit 2 ;;
esac
echo
