# =============================================================================
# deploy-pipeline.ps1 — Atithi Setu Automated Deployment Pipeline
# Triggered by: deploy-webhook-listener.mjs (via GitHub push webhook)
# Run manually: powershell -ExecutionPolicy Bypass -File deploy-pipeline.ps1
# =============================================================================

$ErrorActionPreference = "Stop"
$StartTime = Get-Date

# --- Config -------------------------------------------------------------------
$DeployDir    = "C:\Users\Admin\Documents\Workspace_MCS\dev-erp.athiti-setu\dev-erp"
$BackupDir    = "C:\atithi-setu\backups"
$LogDir       = "C:\atithi-setu\deploy-logs"
$AppImage     = "dev-erp-app"
$AppContainer = "node_app"
$DbContainer  = "postgres_db"
$DbUser       = "as_db_user"
$HealthUrl    = "http://localhost:5001/api/public/restaurants"
$MaxBackups   = 10
$MaxRollbackImages = 5

# --- Load .env ----------------------------------------------------------------
$EnvFile = Join-Path $DeployDir ".env"
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
            $key = $Matches[1].Trim()
            $val = $Matches[2].Trim().Trim('"').Trim("'")
            [System.Environment]::SetEnvironmentVariable($key, $val, "Process")
        }
    }
}

$TelegramToken  = $env:TELEGRAM_BOT_TOKEN
$TelegramChatId = $env:TELEGRAM_DEFAULT_CHAT_ID
$SmtpHost       = $env:SMTP_HOST
$SmtpPort       = [int]($env:SMTP_PORT ?? "587")
$SmtpUser       = $env:SMTP_USER
$SmtpPass       = $env:SMTP_PASS
$NotifyEmail    = $env:DEPLOY_NOTIFY_EMAIL

# --- Helpers ------------------------------------------------------------------
$Timestamp  = (Get-Date -Format "yyyyMMdd_HHmm")
$LogFile    = Join-Path $LogDir "deploy_$Timestamp.log"

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir    | Out-Null

function Log($msg) {
    $line = "[$(Get-Date -Format 'HH:mm:ss')] $msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

function SendTelegram($text) {
    if (-not $TelegramToken -or -not $TelegramChatId) { return }
    try {
        $body = @{ chat_id = $TelegramChatId; text = $text; parse_mode = "Markdown" } | ConvertTo-Json
        Invoke-RestMethod -Uri "https://api.telegram.org/bot$TelegramToken/sendMessage" `
            -Method Post -ContentType "application/json" -Body $body -TimeoutSec 15 | Out-Null
    } catch { Log "WARNING: Telegram notify failed: $_" }
}

function SendEmail($subject, $body) {
    if (-not $SmtpUser -or -not $NotifyEmail) { return }
    try {
        $pass = ConvertTo-SecureString $SmtpPass -AsPlainText -Force
        $cred = New-Object System.Management.Automation.PSCredential($SmtpUser, $pass)
        Send-MailMessage -To $NotifyEmail -From $SmtpUser -Subject $subject -Body $body `
            -SmtpServer $SmtpHost -Port $SmtpPort -UseSsl -Credential $cred -ErrorAction Stop
    } catch { Log "WARNING: Email notify failed: $_" }
}

function Abort($reason) {
    Log "ABORT: $reason"
    $elapsed = [math]::Round(((Get-Date) - $StartTime).TotalMinutes, 1)
    $msg = "❌ *Deploy FAILED*`nReason: $reason`nDuration: ${elapsed}min`nServer: dev-erp.atithi-setu.com"
    SendTelegram $msg
    SendEmail "❌ Atithi Setu Deploy FAILED" "Deploy failed after ${elapsed} min.`n`nReason: $reason`n`nSee log: $LogFile"
    exit 1
}

# =============================================================================
Log "============================================================"
Log "Atithi Setu Automated Deploy — $Timestamp"
Log "============================================================"

# --- Step 1: Pre-flight checks ------------------------------------------------
Log "STEP 1: Pre-flight checks..."

try { docker info 2>&1 | Out-Null } catch { Abort "Docker is not running or not accessible." }

$containers = docker ps --format "{{.Names}}" 2>&1
if ($containers -notmatch $DbContainer) { Abort "Container '$DbContainer' is not running." }

if (-not (Test-Path (Join-Path $DeployDir "docker-compose.yml"))) {
    Abort "docker-compose.yml not found in $DeployDir"
}

Log "Pre-flight OK."

# --- Step 2: Database backup --------------------------------------------------
Log "STEP 2: Backing up database..."

$BackupFile = Join-Path $BackupDir "db_backup_$Timestamp.sql"
try {
    docker exec $DbContainer pg_dumpall -U $DbUser | Out-File -FilePath $BackupFile -Encoding utf8
} catch { Abort "pg_dumpall failed: $_" }

$backupSize = (Get-Item $BackupFile).Length
if ($backupSize -lt 100) { Abort "Backup file is suspiciously small ($backupSize bytes). Aborting." }
Log "Backup saved: $BackupFile ($([math]::Round($backupSize/1KB,1)) KB)"

# --- Step 3: Tag current image for rollback -----------------------------------
Log "STEP 3: Tagging current image for rollback..."
$RollbackTag = "${AppImage}:pre-deploy-$Timestamp"
try {
    docker tag "${AppImage}:latest" $RollbackTag 2>&1 | Out-Null
    Log "Tagged rollback image: $RollbackTag"
} catch {
    Log "WARNING: Could not tag rollback image (may not exist yet): $_"
    $RollbackTag = $null
}

# --- Step 4: Git pull ---------------------------------------------------------
Log "STEP 4: Pulling latest code from master..."
try {
    Push-Location $DeployDir
    git fetch origin master 2>&1 | ForEach-Object { Log "  git: $_" }
    git checkout master 2>&1    | ForEach-Object { Log "  git: $_" }
    git pull origin master 2>&1 | ForEach-Object { Log "  git: $_" }
    $CommitHash = (git rev-parse --short HEAD).Trim()
    $CommitMsg  = (git log -1 --pretty=format:"%s").Trim()
    Log "Now at: $CommitHash — $CommitMsg"
} catch {
    Pop-Location
    Abort "git pull failed: $_"
}
Pop-Location

# --- Step 5: Docker build -----------------------------------------------------
Log "STEP 5: Building Docker image (no cache)..."
try {
    Push-Location $DeployDir
    docker compose build --no-cache app 2>&1 | ForEach-Object {
        Log "  build: $_"
        Add-Content -Path $LogFile -Value "  build: $_"
    }
} catch {
    Pop-Location
    Abort "docker compose build failed: $_"
}
Pop-Location
Log "Build complete."

# --- Step 6: Deploy -----------------------------------------------------------
Log "STEP 6: Starting containers..."
try {
    Push-Location $DeployDir
    docker compose up -d 2>&1 | ForEach-Object { Log "  compose: $_" }
} catch {
    Pop-Location
    Abort "docker compose up failed: $_"
}
Pop-Location
Log "Containers started."

# --- Step 7: Health check -----------------------------------------------------
Log "STEP 7: Health check ($HealthUrl)..."
$healthy = $false
for ($i = 1; $i -le 10; $i++) {
    Start-Sleep -Seconds 5
    try {
        $resp = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
        if ($resp.StatusCode -eq 200) {
            Log "Health check passed on attempt $i (HTTP $($resp.StatusCode))"
            $healthy = $true
            break
        }
    } catch {
        Log "  Attempt $i/10 failed: $($_.Exception.Message)"
    }
}

# --- Step 8: Rollback on failure ----------------------------------------------
if (-not $healthy) {
    Log "STEP 8: Health check failed — rolling back..."
    if ($RollbackTag) {
        try {
            docker tag $RollbackTag "${AppImage}:latest" 2>&1 | Out-Null
            Push-Location $DeployDir
            docker compose up -d 2>&1 | ForEach-Object { Log "  rollback: $_" }
            Pop-Location
            Log "Rollback applied: $RollbackTag"
        } catch { Log "WARNING: Rollback also failed: $_" }
    } else {
        Log "WARNING: No rollback image available."
    }
    Abort "Health check failed after 10 retries (50s). Rolled back to $RollbackTag."
}

# --- Step 9: Cleanup ----------------------------------------------------------
Log "STEP 9: Cleanup..."

# Keep newest $MaxBackups backups
$allBackups = Get-ChildItem -Path $BackupDir -Filter "db_backup_*.sql" | Sort-Object LastWriteTime -Descending
if ($allBackups.Count -gt $MaxBackups) {
    $toDelete = $allBackups | Select-Object -Skip $MaxBackups
    $toDelete | ForEach-Object { Remove-Item $_.FullName -Force; Log "  Deleted old backup: $($_.Name)" }
}

# Keep newest $MaxRollbackImages rollback tags
$rollbackImages = docker images --format "{{.Repository}}:{{.Tag}}" |
    Where-Object { $_ -match "^${AppImage}:pre-deploy-" } |
    Sort-Object -Descending
if ($rollbackImages.Count -gt $MaxRollbackImages) {
    $rollbackImages | Select-Object -Skip $MaxRollbackImages | ForEach-Object {
        docker rmi $_ 2>&1 | Out-Null
        Log "  Deleted old rollback image: $_"
    }
}

Log "Cleanup done."

# --- Step 10: Success notification --------------------------------------------
$elapsed  = [math]::Round(((Get-Date) - $StartTime).TotalMinutes, 1)
$backupName = Split-Path $BackupFile -Leaf

Log "============================================================"
Log "DEPLOY SUCCESS in ${elapsed} min"
Log "Commit: $CommitHash — $CommitMsg"
Log "============================================================"

$telegramMsg = @"
✅ *Deploy SUCCESS*
Commit: ``$CommitHash`` — $CommitMsg
Duration: ${elapsed} min
Backup: $backupName
Server: dev-erp.atithi-setu.com
"@

SendTelegram $telegramMsg
SendEmail "✅ Atithi Setu Deploy SUCCESS" @"
Deploy completed successfully in ${elapsed} min.

Commit : $CommitHash
Message: $CommitMsg
Backup : $BackupFile
Log    : $LogFile
Server : https://dev-erp.atithi-setu.com
"@

Log "Notifications sent. Done."
exit 0
