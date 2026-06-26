<#
.SYNOPSIS
    Starts the Dudu Life Control (TinxyUI) web app and opens it in the browser.

.DESCRIPTION
    A self-contained launcher for the Node.js server in tinxy-ui/serve.js.
    It verifies prerequisites, frees the port if needed, starts the server,
    waits for the /healthz endpoint to report healthy, opens the default
    browser, and prints full diagnostic information.

.PARAMETER Port
    Port to listen on. Default: 3456 (matches serve.js default).

.PARAMETER NoBrowser
    Start the server but do not open the browser.

.PARAMETER Stop
    Stop any server currently running on the port and exit.

.EXAMPLE
    .\start-app.ps1
    .\start-app.ps1 -Port 8080
    .\start-app.ps1 -Stop
#>

[CmdletBinding()]
param(
    [int]$Port = 3456,
    [switch]$NoBrowser,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'

# --- Resolve paths --------------------------------------------------------------
$ScriptRoot   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ServerScript = Join-Path $ScriptRoot 'tinxy-ui\serve.js'
$Url          = "http://localhost:$Port"
$HealthUrl    = "$Url/healthz"

# --- Pretty output helpers ------------------------------------------------------
function Write-Section($text) { Write-Host ""; Write-Host "=== $text " -ForegroundColor Cyan -NoNewline; Write-Host ("=" * [Math]::Max(0, 60 - $text.Length)) -ForegroundColor Cyan }
function Write-Ok($text)      { Write-Host "  [OK]   " -ForegroundColor Green   -NoNewline; Write-Host $text }
function Write-Info($text)    { Write-Host "  [INFO] " -ForegroundColor Blue    -NoNewline; Write-Host $text }
function Write-Warn($text)    { Write-Host "  [WARN] " -ForegroundColor Yellow  -NoNewline; Write-Host $text }
function Write-Err($text)     { Write-Host "  [FAIL] " -ForegroundColor Red     -NoNewline; Write-Host $text }

# --- Find the process listening on a TCP port -----------------------------------
function Get-PortProcess($p) {
    try {
        $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($conn) { return Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue }
    } catch { }
    return $null
}

function Stop-PortProcess($p) {
    $proc = Get-PortProcess $p
    if ($proc) {
        Write-Warn "Port $p is in use by '$($proc.ProcessName)' (PID $($proc.Id)). Stopping it..."
        Stop-Process -Id $proc.Id -Force
        Start-Sleep -Milliseconds 500
        Write-Ok "Freed port $p."
        return $true
    }
    return $false
}

# --- Banner ---------------------------------------------------------------------
Write-Host ""
Write-Host "  +----------------------------------------------------------+" -ForegroundColor Magenta
Write-Host "  |          Dudu Life Control  -  TinxyUI Launcher          |" -ForegroundColor Magenta
Write-Host "  +----------------------------------------------------------+" -ForegroundColor Magenta

# --- Stop mode ------------------------------------------------------------------
if ($Stop) {
    Write-Section "Stop"
    if (Stop-PortProcess $Port) { Write-Ok "Server on port $Port stopped." }
    else { Write-Info "No server was running on port $Port." }
    Write-Host ""
    return
}

# --- 1. Prerequisite checks -----------------------------------------------------
Write-Section "Environment"
Write-Info "Script root : $ScriptRoot"
Write-Info "Server file : $ServerScript"
Write-Info "Target URL  : $Url"

if (-not (Test-Path $ServerScript)) {
    Write-Err "Cannot find server entry point: $ServerScript"
    exit 1
}
Write-Ok "Server entry point found."

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Err "Node.js is not installed or not on PATH. Install from https://nodejs.org/"
    exit 1
}
Write-Ok "Node.js $(node --version)  ($($node.Source))"

$npm = Get-Command npm -ErrorAction SilentlyContinue
if ($npm) { Write-Ok "npm $(npm --version)" }

# --- 2. Free the port if occupied -----------------------------------------------
Write-Section "Port $Port"
$existing = Get-PortProcess $Port
if ($existing) {
    if ($existing.ProcessName -eq 'node') {
        Write-Warn "A Node process (PID $($existing.Id)) is already on port $Port - restarting it for a clean start."
        Stop-PortProcess $Port | Out-Null
    } else {
        Write-Err "Port $Port is occupied by '$($existing.ProcessName)' (PID $($existing.Id)), which is not our server."
        Write-Info "Re-run with a different port, e.g.  .\start-app.ps1 -Port 8080"
        exit 1
    }
} else {
    Write-Ok "Port $Port is free."
}

# --- 3. Start the server --------------------------------------------------------
Write-Section "Start"
$env:PORT = "$Port"
$logFile = Join-Path $ScriptRoot 'tinxy-ui-server.log'
Write-Info "Log file    : $logFile"
Write-Info "Launching   : node `"$ServerScript`"  (PORT=$Port)"

$proc = Start-Process -FilePath $node.Source `
    -ArgumentList "`"$ServerScript`"" `
    -WorkingDirectory $ScriptRoot `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError "$logFile.err" `
    -PassThru -NoNewWindow

Write-Ok "Server process started (PID $($proc.Id))."

# --- 4. Wait for /healthz -------------------------------------------------------
Write-Section "Health check"
$healthy = $false
$maxTries = 30
for ($i = 1; $i -le $maxTries; $i++) {
    if ($proc.HasExited) {
        Write-Err "Server process exited unexpectedly (exit code $($proc.ExitCode))."
        if (Test-Path "$logFile.err") { Write-Host "  --- stderr ---" -ForegroundColor DarkGray; Get-Content "$logFile.err" | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
        exit 1
    }
    try {
        $resp = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2
        if ($resp.StatusCode -eq 200) { $healthy = $true; break }
    } catch {
        Write-Host "  ... waiting for server ($i/$maxTries)`r" -NoNewline -ForegroundColor DarkGray
        Start-Sleep -Milliseconds 500
    }
}
Write-Host ""

if (-not $healthy) {
    Write-Err "Server did not become healthy within $([int]($maxTries * 0.5)) seconds."
    if (Test-Path $logFile) { Write-Host "  --- server log ---" -ForegroundColor DarkGray; Get-Content $logFile | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
    exit 1
}
Write-Ok "Server is healthy ($HealthUrl returned 200)."

# --- 5. Open the browser --------------------------------------------------------
Write-Section "Browser"
if ($NoBrowser) {
    Write-Info "Skipped (-NoBrowser). Open manually: $Url"
} else {
    Start-Process $Url
    Write-Ok "Opened $Url in the default browser."
}

# --- 6. Summary -----------------------------------------------------------------
Write-Section "Running"
Write-Host ""
Write-Host "  App URL     : " -NoNewline; Write-Host $Url -ForegroundColor Green
Write-Host "  Health      : " -NoNewline; Write-Host $HealthUrl -ForegroundColor Green
Write-Host "  Process ID  : " -NoNewline; Write-Host $proc.Id -ForegroundColor Green
Write-Host "  Logs        : " -NoNewline; Write-Host $logFile -ForegroundColor Green
Write-Host ""
Write-Info "To stop the server:  .\start-app.ps1 -Stop    (or: Stop-Process -Id $($proc.Id))"
Write-Host ""
