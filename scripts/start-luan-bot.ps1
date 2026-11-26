# Starts (or restarts) Luan's Telegram bot (@Luanzera_shape_bot) in the background using WMI (detached from terminal)
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$AgentDir = "$RepoRoot\services\agent"
Set-Location $AgentDir

# Stop any previous instance polling .env.luan
Get-CimInstance Win32_Process -Filter "Name = 'pythonw.exe' OR Name = 'python.exe'" |
    Where-Object { $_.CommandLine -like '*.env.luan*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$env:LITELLM_MODE = "PRODUCTION"
$env:DISABLE_AIOHTTP_TRANSPORT = "True"
Write-Host "Publicando menu de comandos no Telegram (@Luanzera_shape_bot)..." -ForegroundColor Cyan
uv run agent-commands --env .env.luan

$Pyw = "$AgentDir\.venv\Scripts\pythonw.exe"
$PyCode = "import os; os.environ['LITELLM_MODE']='PRODUCTION'; os.environ['DISABLE_AIOHTTP_TRANSPORT']='True'; import agent, httpx, litellm; litellm.disable_aiohttp_transport=True; litellm.force_ipv4=True; _C=httpx.AsyncClient; httpx.AsyncClient=type('_IPv4Client',(_C,),{'__init__':lambda s,*a,**k:_C.__init__(s,*a,**({**k,'transport':httpx.AsyncHTTPTransport(local_address='0.0.0.0')} if not a and not k else k))}); from agent.poll import main; main()"
$Cmd = "`"$Pyw`" -c `"$PyCode`" --env .env.luan"
$Res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $Cmd
    CurrentDirectory = $AgentDir
}
Write-Host "Bot @Luanzera_shape_bot iniciado em segundo plano (PID $($Res.ProcessId))." -ForegroundColor Green
