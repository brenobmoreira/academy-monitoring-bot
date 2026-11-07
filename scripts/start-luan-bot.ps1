# Starts (or restarts) Luan's Telegram bot (@Luanzera_shape_bot) in the background using WMI (detached from terminal)
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$AgentDir = "$RepoRoot\services\agent"
Set-Location $AgentDir

# Stop any previous instance polling .env.luan
Get-CimInstance Win32_Process -Filter "Name = 'pythonw.exe' OR Name = 'python.exe'" |
    Where-Object { $_.CommandLine -like '*.env.luan*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host "Publicando menu de comandos no Telegram (@Luanzera_shape_bot)..." -ForegroundColor Cyan
uv run agent-commands --env .env.luan

$Pyw = "$AgentDir\.venv\Scripts\pythonw.exe"
$Cmd = "`"$Pyw`" -c `"from agent.poll import main; main()`" --env .env.luan"
$Res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $Cmd
    CurrentDirectory = $AgentDir
}
Write-Host "Bot @Luanzera_shape_bot iniciado em segundo plano (PID $($Res.ProcessId))." -ForegroundColor Green
