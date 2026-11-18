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
#   scripts/set-webhook.sh set     # register webhook (messages and button taps) and the command menu
#   scripts/set-webhook.sh info    # show current webhook
#   scripts/set-webhook.sh delete  # remove webhook (needed before local polling)
set -euo pipefail

cmd="${1:-info}"
: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}"

# Update kinds the bot handles: messages and inline-button taps. Same list as
# agent.telegram.ALLOWED_UPDATES (polling); services/agent/tests/test_telegram.py checks it.
allowed_updates='["message","callback_query"]'

# Command menu, the same list `uv run agent-commands` sends from agent.commands.COMMANDS;
# services/agent/tests/test_commands.py fails when the two differ.
commands='[
  {"command": "hoje", "description": "O que está registrado no dia: /hoje, /hoje ontem, /hoje 21/09"},
  {"command": "ficha", "description": "Exercícios de uma sessão da ficha vigente; sem nome, a próxima da rotação"},
  {"command": "progressao", "description": "Sugestões de progressão de carga e últimas cargas da ficha vigente"},
  {"command": "exercicios", "description": "Nomes exatos dos exercícios por grupo; /exercicios peito filtra"},
  {"command": "semana", "description": "Análise da semana (seg–dom): situação e recomendação; /semana 1 é a passada"},
  {"command": "fase", "description": "Objetivo em vigor, desde quando, metas e última recomendação; /fase 01/08 numa data"},
  {"command": "app", "description": "Abrir formulários de treino e refeição"},
  {"command": "desfazer", "description": "Desfaz a última gravação na planilha (do bot ou do menu)"},
  {"command": "help", "description": "Exemplos de mensagem e esta lista de comandos"}
]'

case "$cmd" in
  set)
    : "${AGENT_URL:?set AGENT_URL}"
    : "${TELEGRAM_WEBHOOK_SECRET:?set TELEGRAM_WEBHOOK_SECRET}"
    curl -sS --fail-with-body --config - \
      --data-urlencode "url=${AGENT_URL}" \
      --data-urlencode "allowed_updates=${allowed_updates}" \
      --data-urlencode "drop_pending_updates=true" <<EOF
url = "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook"
data-urlencode = "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
EOF
    echo
    curl -sS --fail-with-body --config - --data-urlencode "commands=${commands}" <<EOF
url = "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands"
EOF
    ;;
  info)
    curl -sS --fail-with-body --config - <<EOF
url = "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
EOF
    ;;
  delete)
    curl -sS --fail-with-body --config - <<EOF
url = "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook"
EOF
    ;;
  *) echo "usage: $0 {set|info|delete}" >&2; exit 2 ;;
esac
echo
