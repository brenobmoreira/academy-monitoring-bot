# Starts Luan's Telegram bot (@Luanzera_shape_bot) using services/agent/.env.luan
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location "$RepoRoot\services\agent"
Write-Host "Publicando menu de comandos no Telegram (@Luanzera_shape_bot)..." -ForegroundColor Cyan
uv run agent-commands --env .env.luan
Write-Host "Iniciando long-polling (@Luanzera_shape_bot)..." -ForegroundColor Green
uv run agent-poll --env .env.luan
