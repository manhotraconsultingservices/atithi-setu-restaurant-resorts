# Atithi Setu — Deployment Guide (Second Windows Server)

> **Prepared:** 2026-04-07
> **Scope:** Deploy all Apr 6–7 fixes to a second Windows server running Docker
> **Estimated Time:** ~20 minutes
> **Downtime:** ~15 seconds (only `node_app` container restarts; database untouched)

---

## What's Being Deployed

| Commit | Fix |
|--------|-----|
| `1debd0b` | Manual invoices clear from KDS after payment; label shows "Manual" |
| `cfb6c47` | Command Center refreshes instantly after invoice is closed |
| `b6bb934` | Removed `$` dollar icons; GST defaults to OFF (0%) |
| `27fe4fa` | "Add to Bill" button shows ₹ icon; GST defaults to 0% |
| `c30be82` | Super Admin reset-owner-password updates both account tables |
| `c288e5f` | Registration info no longer blank in Super Admin dashboard |
| `9fe087a` | Settings blank fixed + admin approval gate on registration |

---

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `dev` | Active development — all new work goes here |
| `master` | Production-stable — receives merges from `dev` after testing |

> The other server always pulls from **`master`**.
> ✅ `master` was already merged and pushed on 2026-04-07 (commit `f7eb7ca`).

---

## STEP 0 — On the DEV Machine (Already Done ✅)

The `dev` branch has been merged into `master` and pushed to GitHub.
No action needed here — proceed directly to the other server.

To verify:
```powershell
# Run on dev machine
cd "C:\Users\Admin\Documents\Workspace_MCS\dev-erp.athiti-setu\dev-erp"
git log atithi-setu/master --oneline -3
```
Expected output:
```
f7eb7ca release: merge dev → master — all Apr 6-7 fixes
1debd0b fix: manual invoices clear from KDS on payment; label shows 'Manual'
cfb6c47 fix: Command Center clears table immediately after invoice is closed
```

---

## STEPS 1–7 — On the OTHER Server (via RDP)

Open **PowerShell as Administrator** for all commands below.

---

### STEP 1 — Find the Current Deployment Folder

```powershell
# See all running containers
docker ps

# Find where the app was launched from
docker inspect node_app --format "{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}"
```

> Look for the label `com.docker.compose.project.working_dir`.
> This is your `$DeployDir` — note it down and use it in all steps below.
> **Example:** `C:\atithi-setu\dev-erp`

---

### STEP 2 — Backup the Database ⚠️ MANDATORY

> **Do NOT skip this step. Do NOT proceed if the backup fails.**

```powershell
# ─── SET THIS TO YOUR ACTUAL PATH FROM STEP 1 ───
$DeployDir  = "C:\REPLACE_WITH_ACTUAL_PATH"
# ────────────────────────────────────────────────

$BackupDir  = "C:\atithi-setu\backups"
$timestamp  = Get-Date -Format "yyyyMMdd_HHmm"
$backupFile = "$BackupDir\pre_deploy_$timestamp.sql"

New-Item -ItemType Directory -Force -Path $BackupDir

docker exec postgres_db pg_dumpall -U as_db_user | Out-File $backupFile -Encoding utf8

# Verify backup size (must be > 5000 bytes)
$size = (Get-Item $backupFile).Length
Write-Host "Backup size: $size bytes"

if ($size -lt 5000) {
    Write-Error "❌ BACKUP TOO SMALL — STOP HERE AND INVESTIGATE"
    exit 1
}

Write-Host "✅ Backup saved: $backupFile ($size bytes)"
```

---

### STEP 3 — Tag Current Docker Image for Rollback

```powershell
$rollbackTag = "pre-deploy-$timestamp"

# Get the image name currently used by node_app
$imageName = docker inspect node_app --format "{{.Config.Image}}"
Write-Host "Current image: $imageName"

# Tag it so we can restore it if deployment fails
docker tag $imageName "atithi-setu-app:$rollbackTag"
Write-Host "✅ Rollback tag saved: atithi-setu-app:$rollbackTag"
```

---

### STEP 4 — Set Up Git Repository (First Time Only)

> The app is running but the GitHub repo was never cloned here.
> We initialise git **inside the existing folder** to preserve Docker volumes and the live database.

```powershell
cd $DeployDir

if (Test-Path ".git") {
    Write-Host "Git already initialised — skipping"
} else {
    # Backup .env before git checkout can overwrite it
    Copy-Item ".env" ".env.backup_$timestamp" -ErrorAction SilentlyContinue
    Write-Host "Backed up .env to .env.backup_$timestamp"

    git init
    git remote add origin https://github.com/manhotraconsultingservices/atithi-setu.git
    git fetch origin master
    git checkout -b master --track origin/master

    # Restore .env (git checkout may have replaced it)
    if (Test-Path ".env.backup_$timestamp") {
        Copy-Item ".env.backup_$timestamp" ".env" -Force
        Write-Host "✅ .env restored"
    }
}
```

> **⚠️ Why `git init` instead of `git clone`?**
> `git clone` creates a NEW folder → Docker creates NEW empty volumes → live database is lost.
> `git init` in the EXISTING folder keeps Docker pointing to the same `pg_data` volume.

---

### STEP 5 — Verify and Configure `.env`

```powershell
# Confirm .env exists
if (-not (Test-Path ".env")) {
    Write-Error "❌ .env is missing! Copy it from the dev server before continuing."
    exit 1
}

# Quick check — must contain database credentials
$envContent = Get-Content ".env" -Raw
if ($envContent -notmatch "PGPASSWORD") {
    Write-Error "❌ .env is missing database credentials. Fix before continuing."
    exit 1
}

Write-Host "✅ .env is present and has DB credentials"

# Open .env for review
notepad ".env"
```

**Check these values in Notepad:**

| Variable | Action Required |
|----------|----------------|
| `PGUSER` | Must match what this server's PostgreSQL was initialised with — **do not change** |
| `PGPASSWORD` | Must match exactly — **do not change** |
| `JWT_SECRET` | Must match what was used at registration — **do not change** |
| `FRONTEND_URL` | ✏️ **Change** to this server's domain (e.g. `https://prod-erp.atithi-setu.com/`) |
| `SMTP_USER / SMTP_PASS` | Same Gmail credentials — no change needed |
| `GEMINI_API_KEY` | Same key — no change needed |

> Save and close Notepad when done.

---

### STEP 6 — Pull Latest Code from GitHub

```powershell
cd $DeployDir
git pull origin master

# Confirm the latest commit
git log --oneline -3
```

Expected output:
```
f7eb7ca release: merge dev → master — all Apr 6-7 fixes
1debd0b fix: manual invoices clear from KDS on payment; label shows 'Manual'
cfb6c47 fix: Command Center clears table immediately after invoice is closed
```

> If output does not match, **stop and investigate** before proceeding.

---

### STEP 7 — Build New Docker Image

```powershell
cd $DeployDir
docker compose build --no-cache app
```

> ⏳ This takes **5–8 minutes** (npm install + React/Vite build).
> It is normal to see no output for a while — wait for the prompt to return.

---

### STEP 8 — Deploy

```powershell
cd $DeployDir
docker compose up -d
```

> Docker recreates only `node_app`. The `postgres_db` container and all data are untouched.
> Downtime is approximately **15 seconds**.

---

### STEP 9 — Health Check

```powershell
$healthUrl  = "http://localhost:5001/api/public/restaurants"
$maxRetries = 10
$healthy    = $false

for ($i = 1; $i -le $maxRetries; $i++) {
    Start-Sleep -Seconds 5
    try {
        $resp = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5
        if ($resp.StatusCode -eq 200) {
            $healthy = $true
            Write-Host "✅ Health check PASSED on attempt $i"
            break
        }
    } catch {
        Write-Host "⏳ Attempt $i/$maxRetries — app starting up..."
    }
}

if (-not $healthy) {
    Write-Error "❌ Health check FAILED after $maxRetries attempts — run the ROLLBACK below!"
}
```

---

### STEP 10 — Rollback (Only if Health Check Failed)

```powershell
Write-Host "🔁 Rolling back to pre-deploy image..."

docker tag "atithi-setu-app:$rollbackTag" "atithi-setu-app:latest"
cd $DeployDir
docker compose up -d

Start-Sleep -Seconds 10
$check = Invoke-WebRequest -Uri "http://localhost:5001/api/public/restaurants" -UseBasicParsing
Write-Host "Rollback health: $($check.StatusCode)"
```

---

## Verification After Successful Deploy

Open the app URL in a browser and verify:

- [ ] Login page loads correctly
- [ ] Owner login works → Command Center visible
- [ ] No `$` dollar sign icons anywhere in the customer ordering flow
- [ ] "Add to Bill" button shows ₹ icon (not `$`)
- [ ] "My Orders" tab shows shopping cart icon (not `$`)
- [ ] Create a manual invoice → mark it paid → confirm it **disappears from KDS**
- [ ] Open Command Center invoice → GST toggle starts as **OFF / 0%**
- [ ] Mark an invoice paid in Command Center → table **immediately goes green** (no 30s wait)

---

## Rollback Reference

| Problem | Solution |
|---------|----------|
| App won't start after deploy | Run **STEP 10** (docker image rollback) |
| App starts but has bugs | Run **STEP 10** |
| `.env` was overwritten incorrectly | Restore: `Copy-Item ".env.backup_$timestamp" ".env" -Force` then `docker compose up -d` |
| Database corrupted | `docker exec -i postgres_db psql -U as_db_user < C:\atithi-setu\backups\pre_deploy_TIMESTAMP.sql` |

---

## Key Files Reference

| File | Location | Purpose |
|------|----------|---------|
| `.env` | `$DeployDir\.env` | All secrets and config |
| `.env.backup_*` | `$DeployDir\.env.backup_TIMESTAMP` | Auto-created backup before git checkout |
| DB backup | `C:\atithi-setu\backups\pre_deploy_TIMESTAMP.sql` | Full database dump |
| Rollback image | `atithi-setu-app:pre-deploy-TIMESTAMP` | Previous working Docker image |

---

## For Future Deployments (After This First Setup)

Once git is initialised (Step 4 is done), future deployments are just:

```powershell
$DeployDir = "C:\<your-path>"
$timestamp = Get-Date -Format "yyyyMMdd_HHmm"

# 1. Backup
docker exec postgres_db pg_dumpall -U as_db_user | Out-File "C:\atithi-setu\backups\pre_deploy_$timestamp.sql" -Encoding utf8

# 2. Pull
cd $DeployDir
git pull origin master

# 3. Build & Deploy
docker compose build --no-cache app
docker compose up -d

# 4. Health check
Start-Sleep -Seconds 15
(Invoke-WebRequest "http://localhost:5001/api/public/restaurants" -UseBasicParsing).StatusCode
```
