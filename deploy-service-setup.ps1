# =============================================================================
# deploy-service-setup.ps1 — One-time setup: register webhook listener as
# a Windows Scheduled Task that starts at boot and auto-restarts on failure.
#
# Run ONCE as Administrator:
#   powershell -ExecutionPolicy Bypass -File deploy-service-setup.ps1
# =============================================================================

$TaskName   = "AtithiSetuWebhookListener"
$DeployDir  = "C:\Users\Admin\Documents\Workspace_MCS\dev-erp.athiti-setu\dev-erp"
$NodeExe    = (Get-Command node.exe -ErrorAction SilentlyContinue)?.Source
$ScriptFile = Join-Path $DeployDir "deploy-webhook-listener.mjs"
$LogDir     = "C:\atithi-setu\deploy-logs"

# Validate
if (-not $NodeExe) { Write-Error "node.exe not found in PATH. Install Node.js first."; exit 1 }
if (-not (Test-Path $ScriptFile)) { Write-Error "Script not found: $ScriptFile"; exit 1 }

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Host "Node.js: $NodeExe"
Write-Host "Script:  $ScriptFile"
Write-Host "LogDir:  $LogDir"

# Remove existing task if present
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Removing existing task '$TaskName'..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Build the action
$Action = New-ScheduledTaskAction `
    -Execute $NodeExe `
    -Argument $ScriptFile `
    -WorkingDirectory $DeployDir

# Trigger: at system startup
$Trigger = New-ScheduledTaskTrigger -AtStartup

# Settings: auto-restart up to 3 times, 1 minute apart; run even if on battery
$Settings = New-ScheduledTaskSettingsSet `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RunOnlyIfNetworkAvailable $false

# Principal: run as SYSTEM so it has full access (no interactive logon needed)
$Principal = New-ScheduledTaskPrincipal `
    -UserId "SYSTEM" `
    -LogonType ServiceAccount `
    -RunLevel Highest

# Register
Register-ScheduledTask `
    -TaskName   $TaskName `
    -Action     $Action `
    -Trigger    $Trigger `
    -Settings   $Settings `
    -Principal  $Principal `
    -Description "Atithi Setu GitHub webhook listener — auto-deploy on master push" `
    -Force

Write-Host "`nTask '$TaskName' registered successfully."
Write-Host "Starting it now..."

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2

$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-Host "Task state: $state"

if ($state -eq "Running") {
    Write-Host "`nWebhook listener is RUNNING on port 5002." -ForegroundColor Green
    Write-Host "Test it: curl http://127.0.0.1:5002/health"
} else {
    Write-Warning "Task did not start. Check Event Viewer > Task Scheduler logs."
    Write-Host "Manual start: Start-ScheduledTask -TaskName $TaskName"
}

Write-Host "`nNext steps:"
Write-Host "  1. Update nginx config to proxy /webhook/github -> 127.0.0.1:5002"
Write-Host "  2. Configure GitHub webhook: https://dev-erp.atithi-setu.com/webhook/github"
Write-Host "  3. Set GITHUB_WEBHOOK_SECRET in .env to match the GitHub secret"
