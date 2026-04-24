# Atithi Setu ERP — Production Deployment Guide

> **Audience:** DevOps Engineer (1+ year experience)
> **Criticality:** 24×7 production system — restaurants depend on this for live orders
> **Last Updated:** 2026-04-05
> **Application Version:** As per `package.json`

---

## Table of Contents

0. [Windows Prerequisites — Install Everything From Scratch](#0-windows-prerequisites--install-everything-from-scratch)
1. [Architecture Overview](#1-architecture-overview)
2. [Server Requirements](#2-server-requirements)
3. [Pre-Deployment Checklist](#3-pre-deployment-checklist)
4. [Initial Deployment — Step by Step](#4-initial-deployment--step-by-step)
5. [Nginx Reverse Proxy Setup](#5-nginx-reverse-proxy-setup)
6. [SSL/TLS Certificate Setup](#6-ssltls-certificate-setup)
7. [Post-Deployment Verification](#7-post-deployment-verification)
8. [Monitoring & Health Checks](#8-monitoring--health-checks)
9. [Backup Procedures](#9-backup-procedures)
10. [Semi-Annual Upgrade Procedure](#10-semi-annual-upgrade-procedure)
11. [Rollback Procedure](#11-rollback-procedure)
12. [Troubleshooting Guide](#12-troubleshooting-guide)
13. [Security Hardening](#13-security-hardening)
14. [Emergency Contacts & Escalation](#14-emergency-contacts--escalation)
15. [Appendix A: File Reference for AI-Assisted Troubleshooting](#appendix-a-file-reference-for-ai-assisted-troubleshooting)
16. [Appendix B: Quick Command Sheet](#appendix-b-quick-command-sheet-print-this-page)

---

## 0. Windows Prerequisites — Install Everything From Scratch

> **This section is mandatory** if the production server is a Windows machine with no prior software installed.
> Complete every step in order before proceeding to Section 4.
>
> **Strategy:** All server-side tooling (Docker, Nginx, Certbot, backups) runs inside **WSL2 Ubuntu 22.04** — a full Linux environment built into Windows. This means every command in the rest of this guide works without modification.

---

### 0.1 Check Windows Version Compatibility

Open **PowerShell** (Start → search "PowerShell") and run:

```powershell
winver
```

You need **Windows 10 Build 19041 or later**, Windows 11, or **Windows Server 2022**.

Also verify virtualization is enabled:
```powershell
systeminfo | findstr /C:"Hyper-V Requirements"
```
Expected output: `Hyper-V Requirements: VM Monitor Mode Extensions: Yes`

> If it says "A hypervisor has been detected", virtualization is already running — that's fine.
> If virtualization is disabled, reboot into BIOS and enable **Intel VT-x** or **AMD-V** (also called SVM mode).

---

### 0.2 Enable WSL2 (Windows Subsystem for Linux 2)

Open **PowerShell as Administrator** (right-click PowerShell → "Run as administrator"):

```powershell
# Single command installs WSL2 + Ubuntu 22.04 in one step (Windows 10 Build 19041+ / Windows 11)
wsl --install -d Ubuntu-22.04
```

> **This will require a restart.** Save all work and restart the machine. After restart, Ubuntu 22.04 will finish installing automatically.

**If `wsl --install` is not available** (older Windows 10):
```powershell
# Step 1: Enable WSL feature
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart

# Step 2: Enable Virtual Machine Platform
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart

# Restart the computer, then:

# Step 3: Set WSL2 as default
wsl --set-default-version 2

# Step 4: Install Ubuntu 22.04 from Microsoft Store
# Open Microsoft Store → search "Ubuntu 22.04 LTS" → Install
```

---

### 0.3 Set Up Ubuntu 22.04 in WSL2

After restart, Ubuntu will open automatically and prompt you to create a Linux user:

```
Enter new UNIX username: deploy
Enter new UNIX password: <choose a strong password>
Retype new UNIX password: <same password>
```

> Use `deploy` as the username. This is the account you will use for all deployment operations.

Once inside Ubuntu, update the system:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git htop nano unzip
```

**Enable systemd in WSL2** (required for `systemctl`, Certbot timers, and Nginx service management):

```bash
# Create or edit WSL configuration
sudo nano /etc/wsl.conf
```

Add exactly these lines (create the file if it doesn't exist):

```ini
[boot]
systemd=true
```

Save the file (`Ctrl+O`, `Enter`, `Ctrl+X`), then restart WSL2 from PowerShell:

```powershell
# Run in PowerShell (not inside Ubuntu)
wsl --shutdown
# Wait 5 seconds, then reopen Ubuntu 22.04
```

Reopen the Ubuntu terminal and verify systemd is active:

```bash
systemctl --version
# Should print: systemd 249 or higher — no error
```

Verify WSL2 version (run in PowerShell):
```powershell
wsl -l -v
# Should show: Ubuntu-22.04    Running    2
# The "2" confirms WSL2 (not WSL1)
```

---

### 0.4 Install Docker Desktop for Windows

1. Download Docker Desktop from: **https://www.docker.com/products/docker-desktop/**
   - Choose **"Docker Desktop for Windows"**
   - File name will be: `Docker Desktop Installer.exe` (~600 MB)

2. Run the installer:
   - ✅ Check **"Use WSL 2 instead of Hyper-V"** (should be pre-checked)
   - ✅ Check **"Add shortcut to desktop"**
   - Click **OK** → Let it install → **Restart** when prompted

3. After restart, Docker Desktop launches automatically. Accept the license agreement.

4. **Enable WSL2 Integration:**
   - Click the Docker icon in the system tray (bottom-right)
   - Go to **Settings** → **Resources** → **WSL Integration**
   - Toggle ON **"Ubuntu-22.04"**
   - Click **"Apply & Restart"**

5. Verify Docker works inside WSL2 Ubuntu:
   ```bash
   # Open WSL2 Ubuntu terminal (Start → "Ubuntu 22.04")
   docker --version
   # Expected: Docker version 27.x.x or higher

   docker compose version
   # Expected: Docker Compose version v2.x.x

   docker run hello-world
   # Expected: "Hello from Docker!" message
   ```

> **Troubleshooting:** If `docker: command not found` inside Ubuntu, go to Docker Desktop → Settings → Resources → WSL Integration → ensure Ubuntu-22.04 is toggled on → Apply & Restart.

---

### 0.5 Install Nginx Inside WSL2 Ubuntu

All Nginx configuration runs inside WSL2:

```bash
# Inside WSL2 Ubuntu terminal
sudo apt install -y nginx
sudo service nginx start
nginx -v
# Expected: nginx/1.18.x or higher

# Verify Nginx is running
curl http://localhost
# Expected: Nginx welcome page HTML
```

---

### 0.6 Configure Windows Firewall

Open **PowerShell as Administrator** on the Windows host (not inside WSL2):

```powershell
# Allow HTTP (port 80)
New-NetFirewallRule -DisplayName "Atithi Setu HTTP" `
  -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow

# Allow HTTPS (port 443)
New-NetFirewallRule -DisplayName "Atithi Setu HTTPS" `
  -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow

# Allow SSH to WSL2 (port 22) — needed for remote management
New-NetFirewallRule -DisplayName "WSL2 SSH" `
  -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow

# Verify rules were created
Get-NetFirewallRule | Where-Object {$_.DisplayName -like "Atithi*" -or $_.DisplayName -like "WSL2*"} | Select DisplayName, Enabled, Direction
```

> ⚠️ **Do NOT open port 5001** — the Node.js app port must remain internal, only accessible through Nginx.

---

### 0.7 Configure Port Forwarding (WSL2 to Windows)

WSL2 runs in a virtual network. To make Nginx (inside WSL2) accessible from outside the machine, you must forward ports from Windows to WSL2.

**Run in PowerShell as Administrator:**

```powershell
# Get the WSL2 internal IP address
$wsl_ip = (wsl hostname -I).Trim().Split(" ")[0]
Write-Host "WSL2 IP: $wsl_ip"

# Forward port 80 (HTTP) to WSL2
netsh interface portproxy add v4tov4 listenport=80 listenaddress=0.0.0.0 connectport=80 connectaddress=$wsl_ip

# Forward port 443 (HTTPS) to WSL2
netsh interface portproxy add v4tov4 listenport=443 listenaddress=0.0.0.0 connectport=443 connectaddress=$wsl_ip

# Verify port forwarding rules
netsh interface portproxy show all
```

> **Important:** The WSL2 IP address **changes on every Windows restart**. The auto-start script in Section 0.9 handles this automatically.

---

### 0.8 Install Certbot Inside WSL2 Ubuntu

```bash
# Inside WSL2 Ubuntu terminal
sudo apt install -y certbot python3-certbot-nginx

certbot --version
# Expected: certbot 1.x or 2.x
```

---

### 0.9 Configure Auto-Start on Windows Boot

When Windows restarts, you need:
1. Docker Desktop to start automatically ✅ (already configured by installer)
2. WSL2 Ubuntu to start and run Nginx + Docker containers
3. Port forwarding rules to be refreshed (WSL2 IP changes on restart)

**Create the startup script:**

Open Notepad and save as `C:\atithi-setu\startup.ps1`:

```powershell
# C:\atithi-setu\startup.ps1
# Runs on Windows startup to start WSL2 services and refresh port forwarding

# Wait for WSL2 to be ready
Start-Sleep -Seconds 15

# Start Docker containers inside WSL2
wsl -d Ubuntu-22.04 -u deploy -- bash -c "cd /opt/atithi-setu && docker compose up -d"

# Start Nginx inside WSL2
wsl -d Ubuntu-22.04 -u root -- bash -c "service nginx start"

# Refresh port forwarding (WSL2 IP changes on each boot)
$wsl_ip = (wsl hostname -I).Trim().Split(" ")[0]

# Remove old rules
netsh interface portproxy delete v4tov4 listenport=80 listenaddress=0.0.0.0 2>$null
netsh interface portproxy delete v4tov4 listenport=443 listenaddress=0.0.0.0 2>$null

# Add updated rules with current WSL2 IP
netsh interface portproxy add v4tov4 listenport=80 listenaddress=0.0.0.0 connectport=80 connectaddress=$wsl_ip
netsh interface portproxy add v4tov4 listenport=443 listenaddress=0.0.0.0 connectport=443 connectaddress=$wsl_ip

Write-Host "Atithi Setu started. WSL2 IP: $wsl_ip" | Out-File "C:\atithi-setu\startup.log" -Append
```

**Register as a Windows Scheduled Task (run at system startup):**

```powershell
# Run in PowerShell as Administrator
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\atithi-setu\startup.ps1"

$trigger = New-ScheduledTaskTrigger -AtStartup

$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName "AtithiSetuStartup" `
  -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description "Starts Atithi Setu ERP on Windows boot" -Force

Write-Host "Startup task registered successfully."
```

**Create the folder:**
```powershell
New-Item -ItemType Directory -Force -Path "C:\atithi-setu"
```

---

### 0.10 How to Open WSL2 Ubuntu Terminal

Throughout the rest of this guide, **"run in WSL2 Ubuntu terminal"** means:

**Method 1 (Recommended):** Start → search **"Ubuntu 22.04"** → Open
**Method 2:** Open Windows Terminal → click the dropdown → **Ubuntu 22.04**
**Method 3:** Press `Win + R` → type `wsl` → Enter

> All deployment commands (`docker`, `nginx`, `certbot`, `git`, bash scripts) run inside this WSL2 terminal — **not** in PowerShell or CMD.

---

### 0.11 Prerequisites Verification Checklist

Run these inside WSL2 Ubuntu to confirm everything is installed:

```bash
echo "=== Atithi Setu Prerequisites Check ==="
echo -n "Docker:         "; docker --version 2>/dev/null || echo "NOT INSTALLED"
echo -n "Docker Compose: "; docker compose version 2>/dev/null || echo "NOT INSTALLED"
echo -n "Nginx:          "; nginx -v 2>&1 || echo "NOT INSTALLED"
echo -n "Certbot:        "; certbot --version 2>/dev/null || echo "NOT INSTALLED"
echo -n "Git:            "; git --version 2>/dev/null || echo "NOT INSTALLED"
echo -n "Curl:           "; curl --version | head -1 || echo "NOT INSTALLED"
echo "======================================="
```

All lines should show version numbers, not "NOT INSTALLED". If any fail, revisit the relevant step above.

---

## 1. Architecture Overview

```
Internet
   │
   ▼
Cloudflare (DNS + DDoS protection)
   │
   ▼
Windows Server (production machine)
   │
   ├── Windows Firewall ──── ports 80, 443 open
   ├── Port Forwarding ───── 80/443 → WSL2 internal IP
   │
   └── WSL2 Ubuntu 22.04 (Linux inside Windows)
        │
        ├── Nginx (port 80/443) ── Reverse Proxy ──► Node.js App (port 5001)
        │                                             │
        └── Docker Desktop                            ├── Express API (REST)
             ├── node_app (port 5001)                 ├── WebSocket Server
             └── postgres_db (port 5432, internal)    └── Serves React SPA (dist/)
                   │
                   └── Docker Named Volumes
                        ├── pg_data     ← All restaurant data (PostgreSQL)
                        └── app_uploads ← Uploaded menu images
```

**Key facts:**
- **Multi-tenant**: Each restaurant gets its own PostgreSQL schema (`tenant_<restaurantId>`)
- **Central schema** (`public`): Holds users, restaurants, locations, permissions
- **Single binary**: Node.js server serves BOTH the API and the React frontend
- **Port 5001**: Application internal port (Nginx proxies to it — never expose 5001 publicly)
- **No external database**: PostgreSQL runs in Docker on the same server
- **Auto-migrations**: Database schema migrations run automatically on every app startup — no manual SQL needed

---

## 2. Server Requirements

### Minimum (up to 10 restaurants)
| Resource | Minimum | Recommended |
|---|---|---|
| CPU | 4 cores | 6–8 cores |
| RAM | 8 GB | 16 GB |
| Storage | 50 GB SSD | 100 GB SSD |
| OS | Windows 10 Pro (Build 19041+) | Windows 11 Pro / Windows Server 2022 |
| Network | 100 Mbps | 1 Gbps |

> **Why more RAM than Linux?** Windows itself consumes 2–4 GB. WSL2 uses up to 50% of remaining RAM by default. You need enough left over for Docker (PostgreSQL + Node.js) and Nginx. 8 GB total is the absolute minimum; 16 GB is strongly recommended.

### Recommended Production (10–100 restaurants)
| Resource | Value |
|---|---|
| CPU | 8 cores |
| RAM | 16 GB |
| Storage | 200 GB SSD (with expansion plan) |
| OS | Windows Server 2022 Standard |

### Windows OS Compatibility
| Windows Version | WSL2 Support | Recommended |
|---|---|---|
| Windows 10 Home (Build 19041+) | ✅ | Only for low-traffic single restaurant |
| Windows 10 Pro/Enterprise (Build 19041+) | ✅ | Acceptable |
| Windows 11 Pro/Enterprise | ✅ | Good |
| Windows Server 2019 | ⚠️ Limited | Avoid if possible |
| Windows Server 2022 | ✅ Full | **Best choice for production** |

### Required Software (all installed via Section 0)
| Software | Installed On | Minimum Version |
|---|---|---|
| WSL2 | Windows feature | v2 |
| Ubuntu 22.04 LTS | Inside WSL2 | 22.04 |
| Docker Desktop | Windows | 4.x or higher |
| Nginx | Inside WSL2 Ubuntu | 1.18 or higher |
| Certbot | Inside WSL2 Ubuntu | 2.x |
| Git | Inside WSL2 Ubuntu | 2.x |

---

## 3. Pre-Deployment Checklist

Complete every item before running any deployment command.

### 3.1 Server Setup (Windows)
- [ ] Windows version verified: Windows 10 Build 19041+ / Windows 11 / Windows Server 2022
- [ ] Virtualization enabled in BIOS (Intel VT-x or AMD-V)
- [ ] WSL2 installed and set as default version (`wsl --install -d Ubuntu-22.04`)
- [ ] Ubuntu 22.04 set up inside WSL2 with `deploy` user created
- [ ] Docker Desktop installed and WSL2 integration enabled for Ubuntu-22.04
- [ ] Nginx installed inside WSL2 Ubuntu (`sudo apt install -y nginx`)
- [ ] Certbot installed inside WSL2 Ubuntu
- [ ] Windows Firewall rules created for ports 80 and 443
- [ ] Port forwarding configured (Windows → WSL2) for ports 80 and 443
- [ ] Auto-start scheduled task registered (`AtithiSetuStartup`)
- [ ] Prerequisites verification check passed (Section 0.11 — all tools show version numbers)

### 3.2 DNS
- [ ] Domain pointed to server IP in Cloudflare (A record)
- [ ] SSL certificate ready (or Certbot will create it)
- [ ] Domain propagation verified: `nslookup your-domain.com`

### 3.3 Environment Variables
- [ ] `.env` file created from `.env.example`
- [ ] All required values filled in (see Section 3.4)
- [ ] `.env` file permissions set to `600`: `chmod 600 .env`
- [ ] JWT_SECRET is a strong random string (minimum 32 characters)
- [ ] Database passwords are strong (no `@`, `#`, `$` — these break shell parsing)

### 3.4 Required Environment Variables

Copy `.env.example` to `.env` and fill in ALL of the following:

```bash
# ── Core ──────────────────────────────────────────────────────────
JWT_SECRET=<generate with: openssl rand -hex 32>

# ── Database ──────────────────────────────────────────────────────
PGHOST=db
PGPORT=5432
PGUSER=as_db_user
PGPASSWORD=<strong password — avoid special chars @#$>
PGDATABASE=main_database
PGSSL=false

# ── Email (SMTP) — required for owner registration emails ──────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<your-gmail@gmail.com>
SMTP_PASS=<16-char Gmail App Password>
SMTP_FROM=Atithi Setu <noreply@atithi-setu.com>

# ── Telegram — required for operations notifications ───────────────
TELEGRAM_BOT_TOKEN=<from BotFather>
TELEGRAM_DEFAULT_CHAT_ID=<your chat ID from getUpdates API>

# ── WhatsApp (optional) ────────────────────────────────────────────
META_WA_ACCESS_TOKEN=
META_WA_PHONE_NUMBER_ID=
META_WA_VERIFY_TOKEN=

# ── SMS Twilio (optional) ─────────────────────────────────────────
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=

# ── Gemini AI (optional — for AI menu image generation) ────────────
GEMINI_API_KEY=<from Google AI Studio>
```

**Generate a secure JWT secret:**
```bash
openssl rand -hex 32
```

> ⚠️ Never use the default `JWT_SECRET=fallback-secret-atithi-setu-2024` on production.
> All existing sessions are invalidated if you change this value later.

---

## 4. Initial Deployment — Step by Step

> ⚠️ **Windows users: All commands from this point forward run inside the WSL2 Ubuntu terminal.**
> Open it via: Start → search **"Ubuntu 22.04"** → Open.
> Do NOT run these in PowerShell or CMD.

### Step 1: Prepare WSL2 Ubuntu

```bash
# Inside WSL2 Ubuntu terminal

# Update system packages
sudo apt update && sudo apt upgrade -y

# Install essential tools
sudo apt install -y curl git htop nano

# Verify Docker is accessible (installed via Docker Desktop + WSL2 integration)
docker --version        # Should show Docker version
docker compose version  # Should show Docker Compose version

# If docker command is not found, go back to Section 0.4 and enable WSL2 integration
```

> **Note:** On Windows/WSL2, there is no UFW firewall or swap configuration needed inside WSL2.
> Firewall and port forwarding are managed by Windows (completed in Section 0.6 and 0.7).

### Step 2: Docker is Already Installed

Docker was installed via Docker Desktop in Section 0.4. Verify it works:

```bash
docker ps               # Should return empty list (no error)
docker run hello-world  # Should print "Hello from Docker!"
```

### Step 3: Nginx is Already Installed

Nginx was installed in Section 0.5. Verify it works:

```bash
sudo service nginx status   # Should show "nginx is running"
# Note: On WSL2 use "service" not "systemctl"
```

### Step 4: Deploy the Application

```bash
# Create deployment directory
sudo mkdir -p /opt/atithi-setu
sudo chown $USER:$USER /opt/atithi-setu
cd /opt/atithi-setu

# --- Option A: Copy from local machine via SCP ---
# Run this from your LOCAL machine:
# scp -r /path/to/atithi-setu/* user@server-ip:/opt/atithi-setu/

# --- Option B: Git clone (recommended for repeatability) ---
git clone https://github.com/your-org/atithi-setu.git .

# Create .env from template
cp .env.example .env
nano .env    # Fill in ALL required values (Section 3.4)

# Lock down permissions
chmod 600 .env

# Verify .env looks correct (should NOT show placeholder values)
grep JWT_SECRET .env
grep PGPASSWORD .env
```

### Step 5: Build and Start Containers

```bash
cd /opt/atithi-setu

# Build the application Docker image
# This compiles the React frontend and packages the Node.js server
docker compose build --no-cache app

# Start all containers (app + database)
docker compose up -d

# Check that both containers are running
docker compose ps
```

**Expected output:**
```
NAME            STATUS          PORTS
postgres_db     Up (healthy)    5432/tcp
node_app        Up              0.0.0.0:5001->5001/tcp
```

If `postgres_db` shows `starting` instead of `healthy`, wait 30 seconds and run `docker compose ps` again.

### Step 6: Verify Application is Running

```bash
# Watch startup logs (press Ctrl+C to stop following)
docker compose logs -f app

# You should see:
# "Server running on http://localhost:5001"
# Database migration messages (ALTER TABLE statements) — this is normal

# Test the API directly (bypassing Nginx)
curl http://localhost:5001/api/public/restaurants
# Expected: [] (empty array) or a JSON array of restaurants
```

If you see JSON output, the app is running correctly.

### Step 7: Configure Nginx

```bash
# Copy the nginx config from the project
sudo cp /opt/atithi-setu/nginx-reverse-proxy.conf \
        /etc/nginx/sites-available/atithi-setu

# Edit the config to set your actual domain
sudo nano /etc/nginx/sites-available/atithi-setu

# Find this line (there are two server blocks):
#   server_name demo-erp.atithi-setu.com;
# Change to:
#   server_name your-actual-domain.com;
# (Update BOTH occurrences)

# Enable the site by creating a symlink
sudo ln -s /etc/nginx/sites-available/atithi-setu \
           /etc/nginx/sites-enabled/atithi-setu

# Disable the default Nginx placeholder page
sudo rm -f /etc/nginx/sites-enabled/default

# Test that the Nginx config has no errors
sudo nginx -t
# Must show: "syntax is ok" and "test is successful"

# Apply the config
sudo systemctl reload nginx
```

### Step 8: Set Up SSL Certificate

See [Section 6](#6-ssltls-certificate-setup) for full SSL setup. Do this immediately — HTTP-only is not acceptable for production.

### Step 9: Configure Auto-Start on Windows Reboot

On Windows, auto-start is handled by:
1. **Docker Desktop** — starts automatically on Windows login (configured during installation)
2. **Windows Scheduled Task** (`AtithiSetuStartup`) — starts containers + Nginx + refreshes port forwarding (created in Section 0.9)

Verify the scheduled task exists:
```powershell
# Run in PowerShell (not WSL2)
Get-ScheduledTask -TaskName "AtithiSetuStartup" | Select TaskName, State
# Should show: TaskName=AtithiSetuStartup  State=Ready
```

**Test the full restart cycle:**
```powershell
# From PowerShell — restart Windows
Restart-Computer

# After restart (wait ~60 seconds), open WSL2 Ubuntu and check:
docker compose -f /opt/atithi-setu/docker-compose.yml ps
# Both containers (postgres_db + node_app) should be Running

sudo service nginx status
# Should show: nginx is running
```

> If containers are not running after restart, manually run the startup script once:
> ```powershell
> # PowerShell as Administrator
> Start-ScheduledTask -TaskName "AtithiSetuStartup"
> ```

---

## 5. Nginx Reverse Proxy Setup

The file `nginx-reverse-proxy.conf` in the project root is your Nginx config template. Key settings that must be present:

```nginx
# WebSocket support — CRITICAL for real-time order/kitchen updates
# Without this, the Kitchen Display and Command Center won't update live
location /ws {
    proxy_pass http://localhost:5001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

# Long timeouts — needed for kitchen displays that stay open all day
proxy_connect_timeout 7d;
proxy_send_timeout 7d;
proxy_read_timeout 7d;
```

**Always test before applying:**
```bash
sudo nginx -t
# Must say: "syntax is ok" and "test is successful"
```

**Reload without downtime (use reload, NOT restart):**
```bash
sudo systemctl reload nginx
# reload: gracefully applies config to new connections
# restart: drops ALL active connections — avoid on production
```

---

## 6. SSL/TLS Certificate Setup

### Using Let's Encrypt (Free — Recommended)

```bash
# Install Certbot and the Nginx plugin
sudo apt install -y certbot python3-certbot-nginx

# Obtain and install certificate automatically
# Certbot will modify your Nginx config to add SSL
sudo certbot --nginx -d your-domain.com

# Follow the interactive prompts:
# 1. Enter your email address (for renewal reminders)
# 2. Accept terms of service: A
# 3. Share email with EFF (optional): N or Y
# 4. Redirect HTTP to HTTPS: 2  ← Always choose this for production

# Verify auto-renewal is configured (runs twice daily automatically)
sudo certbot renew --dry-run
# Should say: "Congratulations, all simulated renewals succeeded"
```

**Certificates expire every 90 days but auto-renew.** Check the renewal timer:
```bash
sudo systemctl status certbot.timer
# Should show: active (waiting)
```

**Manual renewal (if auto-renewal fails):**
```bash
sudo certbot renew
sudo systemctl reload nginx
```

### Verify SSL is Working
```bash
# Test HTTPS from outside the server
curl -I https://your-domain.com
# Should show: HTTP/2 200

# Check certificate details
sudo certbot certificates
# Shows: expiry date, domain names, certificate path
```

---

## 7. Post-Deployment Verification

Run all checks after every deployment, upgrade, or server restart.

### 7.1 Container Health

```bash
# Both containers running?
docker compose ps
# postgres_db: Up (healthy)
# node_app: Up

# Recent errors?
docker compose logs --tail=50 app
docker compose logs --tail=20 db
```

### 7.2 Network Checks

```bash
# HTTP redirects to HTTPS?
curl -I http://your-domain.com
# Look for: Location: https://your-domain.com (301 redirect)

# HTTPS works?
curl -I https://your-domain.com
# Look for: HTTP/2 200

# API endpoint responds?
curl https://your-domain.com/api/public/restaurants
# Expected: JSON array (even if empty: [])

# WebSocket endpoint reachable?
curl -I https://your-domain.com/ws
# Expected: 400 or 101 (NOT 502 Bad Gateway)
```

### 7.3 Database Health

```bash
# Quick health check
docker exec postgres_db pg_isready -U as_db_user -d main_database
# Expected: "main_database:5432 - accepting connections"

# Count configured restaurants
docker exec postgres_db psql -U as_db_user -d main_database \
  -c "SELECT COUNT(*) as restaurants FROM restaurants;"

# List all schemas (public + one per restaurant)
docker exec postgres_db psql -U as_db_user -d main_database -c "\dn"
```

### 7.4 End-to-End Functional Test

Perform this after every deployment:

1. Open `https://your-domain.com` in browser — login page loads
2. Log in as **SUPER_ADMIN** — dashboard appears
3. Check **Businesses** tab — existing restaurants listed
4. Open a new browser tab, log in as a restaurant **OWNER**
5. Navigate to **Menu** tab — items load
6. Navigate to **Command & Control** — table monitor loads
7. From a mobile phone, scan a table QR code — customer menu loads
8. Add an item to cart and submit — order appears in kitchen
9. Log in as **CHEF** — order visible in Kitchen Display
10. Mark order as ready — waiter notified

---

## 8. Monitoring & Health Checks

### 8.1 Automated Health Check Script

```bash
# Create scripts directory
mkdir -p /opt/atithi-setu/scripts

# Create the health check script
cat > /opt/atithi-setu/scripts/healthcheck.sh << 'EOF'
#!/bin/bash
DOMAIN="https://your-domain.com"     # ← Change this
LOGFILE="/var/log/atithi-setu-health.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Check HTTP response code
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$DOMAIN" --max-time 10)

if [ "$HTTP_STATUS" != "200" ]; then
    echo "[$TIMESTAMP] ALERT: HTTP $HTTP_STATUS — app may be down" >> "$LOGFILE"
else
    echo "[$TIMESTAMP] OK: HTTP $HTTP_STATUS" >> "$LOGFILE"
fi

# Check Docker container states
APP_RUNNING=$(docker inspect --format='{{.State.Running}}' node_app 2>/dev/null)
DB_RUNNING=$(docker inspect --format='{{.State.Running}}' postgres_db 2>/dev/null)

if [ "$APP_RUNNING" != "true" ] || [ "$DB_RUNNING" != "true" ]; then
    echo "[$TIMESTAMP] ALERT: Container down (app=$APP_RUNNING db=$DB_RUNNING) — auto-restarting" >> "$LOGFILE"
    cd /opt/atithi-setu && docker compose up -d
fi
EOF

chmod +x /opt/atithi-setu/scripts/healthcheck.sh
```

**Schedule with cron inside WSL2 Ubuntu (runs every 5 minutes):**
```bash
# Inside WSL2 Ubuntu terminal
# Cron works because systemd is enabled (Section 0.3)
crontab -e
# Your default editor opens. Add this line at the bottom:
*/5 * * * * /opt/atithi-setu/scripts/healthcheck.sh

# Verify cron service is running
sudo systemctl status cron
# Should show: active (running)
```

### 8.2 Log Rotation

Prevent log files from filling up the disk:

```bash
sudo tee /etc/logrotate.d/atithi-setu << 'EOF'
/var/log/atithi-setu-*.log {
    daily
    rotate 30
    compress
    missingok
    notifempty
    create 644 root root
}
EOF
```

### 8.3 Disk Space Monitoring

Menu images accumulate over time. Check weekly:

```bash
# Overall disk usage
df -h

# Docker's disk usage (images, volumes, containers)
docker system df

# How big is the uploads volume?
docker run --rm -v atithi-setu_app_uploads:/data alpine du -sh /data

# How big is the database volume?
docker run --rm -v atithi-setu_pg_data:/data alpine du -sh /data
```

**Auto-alert when disk > 80% full (runs daily at 8 AM):**
```bash
# Inside WSL2 Ubuntu terminal
# Note: "df /" checks the WSL2 virtual disk (where Docker volumes live)
crontab -e
# Add this line:
0 8 * * * USAGE=$(df / | awk 'NR==2 {print $5}' | tr -d '%'); if [ "$USAGE" -gt 80 ]; then echo "Disk ${USAGE}% full on Atithi Setu server" | mail -s "DISK ALERT" admin@company.com; fi
```

> **Check WSL2 disk from Windows too:** Open PowerShell and run:
> ```powershell
> # Check overall Windows disk space
> Get-PSDrive C | Select-Object Used, Free
> ```

### 8.4 Recommended External Monitoring (Free Tier Available)

Set these up on day 1 — they work even when your server is unreachable:

| Service | What It Does | Free Tier |
|---|---|---|
| **UptimeRobot** (uptimerobot.com) | Checks your URL every 5 minutes, SMS/email alert | ✅ Yes |
| **Better Stack** (betterstack.com) | Incident management, on-call alerts | ✅ Yes |

---

## 9. Backup Procedures

> ⚠️ **Critical:** All restaurant orders, menus, staff, and settings live in these backups. A failure without backup means permanent data loss.

### 9.1 What Must Be Backed Up

| Data | Where It Lives | Backup Method |
|---|---|---|
| All restaurant data | Docker volume `pg_data` | `pg_dumpall` SQL dump |
| Menu images & uploads | Docker volume `app_uploads` | `tar` archive |
| Application config | `/opt/atithi-setu/.env` | Encrypted file copy |
| Nginx SSL config | `/etc/nginx/sites-available/atithi-setu` | File copy |

### 9.2 Manual Backup (Run Before Any Change)

Always run a manual backup before upgrades, config changes, or any risky operation:

```bash
# Set backup destination with timestamp
BACKUP_DIR="/opt/backups/atithi-setu/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

echo "Starting backup to $BACKUP_DIR..."

# 1. Database — dumps ALL schemas (public + all tenant_xxx schemas)
docker exec postgres_db pg_dumpall -U as_db_user \
  > "$BACKUP_DIR/database_full.sql"
echo "✓ Database dump: $(du -sh $BACKUP_DIR/database_full.sql | cut -f1)"

# 2. Menu images volume
docker run --rm \
  -v atithi-setu_app_uploads:/source \
  -v "$BACKUP_DIR":/backup \
  alpine tar czf /backup/uploads.tar.gz -C /source .
echo "✓ Uploads backup: $(du -sh $BACKUP_DIR/uploads.tar.gz | cut -f1)"

# 3. Environment config (contains all secrets)
cp /opt/atithi-setu/.env "$BACKUP_DIR/env.backup"
chmod 600 "$BACKUP_DIR/env.backup"

# 4. Nginx config
cp /etc/nginx/sites-available/atithi-setu "$BACKUP_DIR/nginx.conf" 2>/dev/null || true

# Verify all files are non-empty
ls -lh "$BACKUP_DIR/"
echo "Backup complete: $BACKUP_DIR"
```

### 9.3 Automated Daily Backup

```bash
cat > /opt/atithi-setu/scripts/backup.sh << 'EOF'
#!/bin/bash
# Automated daily backup — keeps 30 days of history

BACKUP_ROOT="/opt/backups/atithi-setu"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="$BACKUP_ROOT/$DATE"
RETAIN_DAYS=30
LOG="/var/log/atithi-setu-backup.log"

mkdir -p "$BACKUP_DIR"

# 1. Database dump (all schemas)
docker exec postgres_db pg_dumpall -U as_db_user \
  > "$BACKUP_DIR/database_full.sql"

if [ $? -ne 0 ] || [ ! -s "$BACKUP_DIR/database_full.sql" ]; then
    echo "[$(date)] ERROR: Database backup failed or is empty" >> "$LOG"
    rm -rf "$BACKUP_DIR"
    exit 1
fi

# 2. Uploads volume
docker run --rm \
  -v atithi-setu_app_uploads:/source \
  -v "$BACKUP_DIR":/backup \
  alpine tar czf /backup/uploads.tar.gz -C /source .

# 3. Config files
cp /opt/atithi-setu/.env "$BACKUP_DIR/env.backup" && chmod 600 "$BACKUP_DIR/env.backup"
cp /etc/nginx/sites-available/atithi-setu "$BACKUP_DIR/nginx.conf" 2>/dev/null || true

# 4. Compress the whole backup into a single file
tar czf "$BACKUP_ROOT/${DATE}.tar.gz" -C "$BACKUP_ROOT" "$DATE"
rm -rf "$BACKUP_DIR"

# 5. Remove backups older than RETAIN_DAYS
find "$BACKUP_ROOT" -maxdepth 1 -name "*.tar.gz" -mtime +$RETAIN_DAYS -delete

echo "[$(date)] Backup OK: ${DATE}.tar.gz ($(du -sh $BACKUP_ROOT/${DATE}.tar.gz | cut -f1))" >> "$LOG"
EOF

chmod +x /opt/atithi-setu/scripts/backup.sh

# Schedule: daily at 3:00 AM inside WSL2 Ubuntu (low-traffic window)
# Cron works because systemd is enabled in WSL2 (Section 0.3)
crontab -e
# Add this line at the bottom and save:
# 0 3 * * * /opt/atithi-setu/scripts/backup.sh

# Verify cron entry was saved
crontab -l | grep backup.sh
# Should print the line you added

# Manually test the backup script works before relying on automation
/opt/atithi-setu/scripts/backup.sh
ls -lh /opt/backups/atithi-setu/
# Should show a .tar.gz file with today's date
```

### 9.4 Verify Backup Integrity (Run Monthly)

```bash
# Find the most recent backup
LATEST=$(ls -t /opt/backups/atithi-setu/*.tar.gz 2>/dev/null | head -1)
if [ -z "$LATEST" ]; then echo "ERROR: No backups found!"; exit 1; fi

echo "Verifying: $LATEST"

# Extract to temp directory
mkdir -p /tmp/backup-verify
tar xzf "$LATEST" -C /tmp/backup-verify

# Check database dump is valid SQL
head -3 /tmp/backup-verify/*/database_full.sql
# Must start with: -- PostgreSQL database cluster dump

# Check file size is reasonable (should be > 10KB for any real data)
du -sh /tmp/backup-verify/*/database_full.sql

# Check uploads archive is valid
tar tzf /tmp/backup-verify/*/uploads.tar.gz | head -5

# Cleanup
rm -rf /tmp/backup-verify
echo "✓ Backup verification passed"
```

### 9.5 Off-Site Backup (Strongly Recommended for Production)

Local backups are lost if the server is destroyed. Add off-site copies:

```bash
# Option A: rclone to any cloud (S3, Google Drive, Backblaze B2)
sudo apt install -y rclone
rclone config    # Follow prompts to set up your cloud storage

# Sync after daily backup at 4:00 AM
crontab -e
# Add (runs at 4 AM, one hour after daily backup):
# 0 4 * * * rclone sync /opt/backups/atithi-setu/ remote:atithi-setu-backups/ >> /var/log/atithi-setu-backup.log 2>&1

# Option B: rsync to a second server
# 0 4 * * * rsync -avz /opt/backups/atithi-setu/ backup@second-server:/backups/atithi-setu/

# Option C (Windows-specific): Copy backups to a Windows network share or external drive
# Add this line to WSL2 crontab:
# 0 4 * * * cp -r /opt/backups/atithi-setu/ /mnt/d/AtithiSetuBackups/
# /mnt/d/ is your D: drive inside WSL2
```

---

## 10. Semi-Annual Upgrade Procedure

> Atithi Setu releases **2 major updates per year**. Database migrations run automatically — no manual SQL needed. Follow this procedure exactly.

### 10.1 Pre-Upgrade Preparation (Do 1–2 days before upgrade date)

```bash
# 1. Run a fresh backup right now
/opt/atithi-setu/scripts/backup.sh

# 2. Confirm backup was created and is non-empty
ls -lth /opt/backups/atithi-setu/*.tar.gz | head -3
# The newest file should have today's date and size > 1MB

# 3. Tag the current Docker image for easy rollback
CURRENT_DATE=$(date +%Y%m%d)
docker tag dev-erp-app:latest dev-erp-app:pre-upgrade-${CURRENT_DATE}

# 4. Verify the tag exists
docker images dev-erp-app
# You should see both 'latest' and 'pre-upgrade-YYYYMMDD'

# 5. Save the current image ID for reference
docker images dev-erp-app:latest --format "ID: {{.ID}} Created: {{.CreatedAt}}"
```

### 10.2 Maintenance Window

**Recommended:** Sunday 2:00 AM – 4:00 AM IST (lowest restaurant activity)

Notify restaurant owners **48 hours in advance** via WhatsApp/email:
> "Atithi Setu will undergo a scheduled upgrade on Sunday [DATE] between 2:00 AM – 3:00 AM IST. The system will be unavailable for approximately 10 minutes."

### 10.3 Upgrade Steps (Follow in Order)

```bash
# ─── Step 1: Final backup (mandatory — never skip) ───────────────
/opt/atithi-setu/scripts/backup.sh
echo "✓ Pre-upgrade backup complete"

# ─── Step 2: Pull new code ────────────────────────────────────────
cd /opt/atithi-setu
git fetch origin
git log HEAD..origin/main --oneline    # Preview what's changing
git pull origin main

# ─── Step 3: Build new image ──────────────────────────────────────
docker compose build --no-cache app
# Takes 3–8 minutes. Watch for any build errors.

# ─── Step 4: Apply the upgrade ────────────────────────────────────
# PostgreSQL stays running. Only the app container restarts (~10 seconds downtime).
docker compose up -d app

# ─── Step 5: Monitor startup ──────────────────────────────────────
docker compose logs -f app
# Wait for: "Server running on http://localhost:5001"
# You will see ALTER TABLE messages — this is normal (auto-migrations)
# Press Ctrl+C when you see the "Server running" line

# ─── Step 6: Verify ───────────────────────────────────────────────
docker compose ps
curl -s https://your-domain.com/api/public/restaurants
# Must return valid JSON

# ─── Step 7: Run functional test (Section 7.4) ────────────────────
# Log in as OWNER and place a test order
```

### 10.4 Downtime During Upgrade

| Phase | Duration | Impact |
|---|---|---|
| `docker compose build` | 3–8 min | Zero — app still running |
| `docker compose up -d app` | ~10 sec | 502 errors; WebSocket reconnects automatically |
| First startup (migrations) | 5–15 sec | App booting |
| Total visible downtime | **~25 seconds** | Minimal |

---

## 11. Rollback Procedure

Use this when a production issue is **caused by the upgrade**. Act within 15 minutes to minimise restaurant impact.

### 11.1 Assess the Situation First

```bash
# What's in the logs?
docker compose logs --tail=100 app

# Is the database OK?
docker exec postgres_db pg_isready -U as_db_user -d main_database

# Is it a code issue or a config issue?
# Config issues (wrong .env values) don't require rollback — just fix .env
```

### 11.2 Quick Rollback — Code Only (< 3 minutes)

Use this for most issues. Restores the previous app version. **Database is NOT touched.**

```bash
# Step 1: Stop and remove the current (broken) app container
docker stop node_app
docker rm node_app

# Step 2: List available pre-upgrade images
docker images dev-erp-app

# Step 3: Start the previous image
# Replace 'pre-upgrade-20260601' with your actual tag from Step 3 above
docker run -d \
  --name node_app \
  --restart always \
  --env-file /opt/atithi-setu/.env \
  -e PORT=5001 \
  -p 5001:5001 \
  -v atithi-setu_app_uploads:/app/public/uploads \
  --network atithi-setu_default \
  dev-erp-app:pre-upgrade-20260601

# Step 4: Verify it's running
docker ps | grep node_app
curl http://localhost:5001/api/public/restaurants

echo "Rollback complete"
```

### 11.3 Full Rollback — Code + Database (Last Resort)

> ⚠️ **Only use this if the database is corrupted.** This will lose ALL data entered AFTER the upgrade (orders, new restaurants, etc.). Notify all restaurant owners immediately before proceeding.

```bash
# Step 1: Stop the application (keep PostgreSQL running)
docker compose stop app

# Step 2: Find the pre-upgrade backup (taken just BEFORE the upgrade)
ls -lth /opt/backups/atithi-setu/*.tar.gz | head -5
# Identify the backup with the timestamp just before your upgrade

# Step 3: Extract the backup
BACKUP_FILE="/opt/backups/atithi-setu/20260601_020000.tar.gz"  # Use actual filename
mkdir -p /tmp/rollback
tar xzf "$BACKUP_FILE" -C /tmp/rollback
ls /tmp/rollback/

# Step 4: Restore the database
# Drop and recreate
docker exec postgres_db psql -U as_db_user -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='main_database' AND pid <> pg_backend_pid();" postgres
docker exec postgres_db psql -U as_db_user -c "DROP DATABASE IF EXISTS main_database;" postgres
docker exec postgres_db psql -U as_db_user -c "CREATE DATABASE main_database;" postgres

# Restore from dump
docker exec -i postgres_db psql -U as_db_user main_database \
  < /tmp/rollback/*/database_full.sql
echo "✓ Database restored"

# Step 5: Restore uploads
docker run --rm \
  -v atithi-setu_app_uploads:/target \
  -v /tmp/rollback:/backup \
  alpine sh -c "rm -rf /target/* && cd /target && tar xzf /backup/*/uploads.tar.gz"
echo "✓ Uploads restored"

# Step 6: Start the previous app image
docker run -d \
  --name node_app \
  --restart always \
  --env-file /opt/atithi-setu/.env \
  -e PORT=5001 \
  -p 5001:5001 \
  -v atithi-setu_app_uploads:/app/public/uploads \
  --network atithi-setu_default \
  dev-erp-app:pre-upgrade-20260601

# Step 7: Verify everything works
docker ps
curl http://localhost:5001/api/public/restaurants

# Cleanup
rm -rf /tmp/rollback
echo "Full rollback complete"
```

### 11.4 Rollback Decision Guide

```
Problem detected after upgrade
         │
         ▼
Is the app container running?  ──NO──► docker compose restart app → wait 30s → check again
         │
        YES
         ▼
Check docker compose logs --tail=50 app
         │
         ├── "ECONNREFUSED 5432" ──────────────► Database container down → docker compose restart db
         │
         ├── Crash/exit loop ─────────────────► Quick Code Rollback (Section 11.2)
         │
         ├── Wrong data returned ─────────────► Check logs for DB migration errors
         │                                      If migration failed → Full Rollback (11.3)
         ├── Login broken ────────────────────► Check JWT_SECRET in .env is unchanged
         │
         └── Notifications not working ───────► Check .env vars — NOT a rollback case
```

---

## 12. Troubleshooting Guide

### 12.1 App Container Won't Start

**Symptom:** `docker compose ps` shows `node_app` as `Exit 1` or `Restarting`.

```bash
# Get the full error message
docker compose logs --tail=100 app
```

| Error Message | Root Cause | Fix |
|---|---|---|
| `ECONNREFUSED ::1:5432` | App started before DB was ready | `docker compose restart app` |
| `password authentication failed for user "as_db_user"` | Wrong PGPASSWORD in .env | Fix `PGPASSWORD` in `.env`, then `docker compose up -d app` |
| `error: role "as_db_user" does not exist` | DB user not created | `docker compose down -v` and start fresh (⚠️ deletes data) |
| `Cannot find module '/app/dist/...'` | Frontend build failed | `docker compose build --no-cache app` |
| `ENOSPC: no space left on device` | Server disk full | `docker system prune -f`, then `df -h` to verify |
| `Error: Port 5001 already in use` | Another process using port | `sudo lsof -i :5001` and kill the process |
| `JWT_SECRET is not defined` or similar | `.env` file missing or empty | Check: `ls -la .env` and `cat .env | grep JWT` |

### 12.2 Database Won't Start

```bash
# Check PostgreSQL logs
docker compose logs --tail=50 db

# Common issue: corrupt data volume after unclean shutdown
# Test if PostgreSQL is accepting connections
docker exec postgres_db pg_isready -U as_db_user

# If PostgreSQL is running but you can't connect:
docker exec -it postgres_db psql -U as_db_user -c "\l"
# If this fails, check PGUSER/PGPASSWORD in .env match POSTGRES_USER/POSTGRES_PASSWORD
```

### 12.3 502 Bad Gateway

```bash
# Step 1: Is node_app actually running?
docker ps | grep node_app

# Step 2: Is port 5001 open on the server?
curl http://localhost:5001
# If this gives "Connection refused", the app isn't running

# Step 3: Check Nginx error log
sudo tail -30 /var/log/nginx/error.log

# Step 4: Verify Nginx config points to correct port
grep proxy_pass /etc/nginx/sites-available/atithi-setu
# Should show: proxy_pass http://localhost:5001;

# Step 5: Fix and reload
sudo nginx -t && sudo systemctl reload nginx
```

### 12.4 Live Orders / Kitchen Display Not Updating

This is a WebSocket issue.

```bash
# Verify Nginx has WebSocket headers
grep -A 6 "location /ws" /etc/nginx/sites-available/atithi-setu

# Must contain ALL of:
# proxy_http_version 1.1;
# proxy_set_header Upgrade $http_upgrade;
# proxy_set_header Connection "upgrade";

# If missing, add them and reload:
sudo nginx -t && sudo systemctl reload nginx
```

Also verify on client: open browser DevTools → Network → WS tab. Should show an active WebSocket connection to `wss://your-domain.com/ws`.

### 12.5 SSL Certificate Problems

```bash
# Check certificate status and expiry
sudo certbot certificates

# Manually renew if expired or near expiry (< 30 days)
sudo certbot renew --force-renewal
sudo systemctl reload nginx

# If certbot fails due to rate limits (too many attempts):
sudo certbot renew --staging    # Test with staging cert first
```

### 12.6 Menu Images Not Showing (404 on /uploads/...)

```bash
# Is the uploads volume mounted?
docker inspect node_app --format '{{range .Mounts}}{{.Source}} → {{.Destination}}{{"\n"}}{{end}}'
# Should show: ...app_uploads → /app/public/uploads

# Are files in the volume?
docker run --rm -v atithi-setu_app_uploads:/data alpine ls /data | wc -l

# Test serving a specific file
docker exec node_app ls /app/public/uploads | head -5
# Pick a filename and test:
curl -I https://your-domain.com/uploads/<filename>
```

### 12.7 Container Running but App Crashes Under Load

```bash
# Check memory — OOM (Out of Memory) kills are silent
docker stats --no-stream
# If node_app mem usage is near server RAM limit, you need more RAM or swap

# Check restart count (high number = frequent crashes)
docker inspect node_app --format '{{.RestartCount}}'

# Check if server is swapping heavily
free -h
vmstat 1 5
```

If restart count is high, increase WSL2 memory limit or upgrade server RAM.

**Increase WSL2 memory limit (run in PowerShell):**
```powershell
# Create or edit WSL2 global config
# This file limits how much RAM WSL2 can use
notepad "$env:USERPROFILE\.wslconfig"
```
Add or update these lines:
```ini
[wsl2]
memory=6GB        # Change to suit your available RAM (leave 2GB for Windows)
processors=4      # Number of CPU cores WSL2 can use
swap=2GB          # WSL2 swap space
```
Then restart WSL2:
```powershell
wsl --shutdown
# Reopen Ubuntu 22.04 terminal — new limits apply
```

### 12.8 Notifications Not Being Sent

```bash
# Test email SMTP connectivity from inside the container
docker exec node_app node -e "
import nodemailer from 'nodemailer';
const t = nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT||'587'),
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});
t.verify().then(() => console.log('SMTP OK')).catch(e => console.error('SMTP FAILED:', e.message));
" 2>&1

# Test Telegram bot
source /opt/atithi-setu/.env
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" | python3 -m json.tool
```

### 12.9 Server Ran Out of Disk Space

```bash
# Identify what's using space
df -h
docker system df

# Clean up unused Docker resources (safe — only removes unused items)
docker system prune -f
docker image prune -f

# Remove old backups (keep last 7 days)
find /opt/backups/atithi-setu -name "*.tar.gz" -mtime +7 -delete

# Check for large log files
sudo du -sh /var/log/* 2>/dev/null | sort -h | tail -10
```

### 12.10 Complete Reset (Nuclear Option)

> ⚠️ This destroys ALL data. Only for non-production or when explicitly directed.

```bash
docker compose down -v           # Stops containers AND deletes volumes
docker compose up -d             # Starts fresh with empty database
```

### 12.11 Windows-Specific Issues

**Site not reachable from outside the Windows machine (port forwarding lost):**

This happens because WSL2's internal IP changes on every Windows restart.

```powershell
# Run in PowerShell as Administrator on the Windows host

# Step 1: Get the current WSL2 IP
$wsl_ip = (wsl hostname -I).Trim().Split(" ")[0]
Write-Host "Current WSL2 IP: $wsl_ip"

# Step 2: Delete old port forwarding rules
netsh interface portproxy delete v4tov4 listenport=80 listenaddress=0.0.0.0
netsh interface portproxy delete v4tov4 listenport=443 listenaddress=0.0.0.0

# Step 3: Add fresh rules with current WSL2 IP
netsh interface portproxy add v4tov4 listenport=80 listenaddress=0.0.0.0 connectport=80 connectaddress=$wsl_ip
netsh interface portproxy add v4tov4 listenport=443 listenaddress=0.0.0.0 connectport=443 connectaddress=$wsl_ip

# Step 4: Verify
netsh interface portproxy show all
```

**Docker Desktop not starting or containers not running after Windows restart:**

```powershell
# Check if Docker Desktop service is running
Get-Service -Name "com.docker.service" | Select Status
# If Stopped: start it
Start-Service -Name "com.docker.service"

# Wait 30 seconds for Docker to initialize, then manually trigger the startup task
Start-ScheduledTask -TaskName "AtithiSetuStartup"
```

**WSL2 Ubuntu not responding:**

```powershell
# Terminate all WSL2 instances and restart
wsl --shutdown
Start-Sleep -Seconds 5
# Reopen Ubuntu 22.04 from Start menu
```

**Check startup task log:**
```powershell
Get-Content "C:\atithi-setu\startup.log" | Select-Object -Last 20
```

---

### 12.12 Quick Reference Commands

```bash
# ── Container Management ───────────────────────────────────────────
docker compose ps                          # Status of all containers
docker compose logs -f app                 # Live app logs
docker compose logs -f db                  # Live database logs
docker compose restart app                 # Restart only app (keeps DB running)
docker compose down && docker compose up -d # Full restart

# ── Access Containers ─────────────────────────────────────────────
docker exec -it node_app sh                # Shell into app container
docker exec -it postgres_db psql -U as_db_user -d main_database  # DB shell

# ── Resource Monitoring ───────────────────────────────────────────
docker stats --no-stream                   # CPU/memory per container
df -h                                      # Disk usage
free -h                                    # RAM + swap usage
htop                                       # Interactive process monitor

# ── Nginx ─────────────────────────────────────────────────────────
sudo nginx -t                              # Test config syntax
sudo systemctl reload nginx                # Apply config (no downtime)
sudo systemctl status nginx                # Nginx status
sudo tail -f /var/log/nginx/error.log      # Nginx errors

# ── SSL ───────────────────────────────────────────────────────────
sudo certbot certificates                  # List certs and expiry dates
sudo certbot renew                         # Renew all certificates
```

---

## 13. Security Hardening

### 13.1 Windows Remote Desktop — Restrict Access

On a Windows production server, Remote Desktop (RDP) is the primary remote access method.

**Run in PowerShell as Administrator:**
```powershell
# Change RDP port from default 3389 to a non-standard port (reduces automated attacks)
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp" `
  -Name "PortNumber" -Value 33890

# Allow new RDP port through Windows Firewall
New-NetFirewallRule -DisplayName "RDP Custom Port" `
  -Direction Inbound -Protocol TCP -LocalPort 33890 -Action Allow

# Disable old RDP port
Remove-NetFirewallRule -DisplayName "Remote Desktop" -ErrorAction SilentlyContinue

# Enable Network Level Authentication (NLA) — requires credentials before desktop loads
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp" `
  -Name "UserAuthentication" -Value 1

# Restart Remote Desktop service
Restart-Service -Name TermService -Force

Write-Host "RDP now on port 33890. Update your firewall rules and RDP client."
```

> ⚠️ **Before disconnecting:** Open a NEW RDP session on port 33890 to confirm it works. If locked out, you'll need physical console access.

### 13.1b Windows Account Security

```powershell
# Disable the built-in Administrator account (use your named account only)
Disable-LocalUser -Name "Administrator"

# Verify only authorized users exist
Get-LocalUser | Select Name, Enabled, LastLogon
```

### 13.2 Ensure PostgreSQL is NOT Exposed to Internet

```bash
# Verify — postgres_db should NOT have 0.0.0.0:5432 in the ports column
docker compose ps

# Safe output (no port mapping shown):
# postgres_db   Up (healthy)   5432/tcp

# Unsafe output (reachable from internet!):
# postgres_db   Up (healthy)   0.0.0.0:5432->5432/tcp

# Fix if unsafe: edit docker-compose.yml and remove ports from db service
```

### 13.3 Rotate the JWT Secret Annually

```bash
# Generate a new secret
NEW_SECRET=$(openssl rand -hex 32)
echo "New JWT secret: $NEW_SECRET"

# Update .env
sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$NEW_SECRET/" /opt/atithi-setu/.env

# Restart app (all users will need to log in again)
docker compose restart app
```

> ⚠️ All active sessions are invalidated immediately. Restaurant staff will need to log in again. Schedule this during off-hours and notify users in advance.

### 13.4 Protect the .env File

```bash
# File must only be readable by the deploy user
chmod 600 /opt/atithi-setu/.env
ls -la /opt/atithi-setu/.env
# Must show: -rw------- 1 deployuser deployuser
```

### 13.5 Automatic Security Updates

**Windows Updates (PowerShell as Administrator):**
```powershell
# Enable automatic Windows security updates
$AUSettings = (New-Object -com "Microsoft.Update.AutoUpdate").Settings
$AUSettings.NotificationLevel = 4   # Auto download and install
$AUSettings.Save()

# Verify Windows Defender is active
Get-MpComputerStatus | Select AntivirusEnabled, RealTimeProtectionEnabled
# Both should be True
```

**WSL2 Ubuntu updates (run monthly inside WSL2 Ubuntu terminal):**
```bash
# Update all packages inside WSL2
sudo apt update && sudo apt upgrade -y

# Install unattended security upgrades for WSL2 Ubuntu
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
# Choose: Yes

sudo systemctl status unattended-upgrades
```

### 13.6 Cloudflare Settings (If Using Cloudflare)

In the Cloudflare dashboard for your domain:

1. **SSL/TLS** → Set to **Full (Strict)**
2. **Security** → **Bot Fight Mode** → Enable
3. **Security** → **DDoS** protection is automatic
4. **Security** → **WAF** → Add rate limiting rule:
   - URI path: `/api/auth/*`
   - Rate: 10 requests per 1 minute per IP
   - Action: Block

---

## 14. Emergency Contacts & Escalation

### 14.1 Response Time Guidelines (24×7 System)

| Severity | Situation | Response Time | Escalate After |
|---|---|---|---|
| **P1 Critical** | All restaurants unable to take orders | Immediate | 10 minutes |
| **P1 Critical** | Database unavailable | Immediate | 10 minutes |
| **P2 High** | Notifications not working | 30 minutes | 1 hour |
| **P2 High** | Specific restaurant broken | 30 minutes | 2 hours |
| **P3 Medium** | Slow performance | 2 hours | 4 hours |
| **P4 Low** | Non-critical feature broken | Next business day | N/A |

### 14.2 Escalation Path

```
Level 1 — DevOps Engineer (You)
    │  Try: Restart containers, check logs, rollback image
    │  Time limit: 10 minutes for P1
    ▼
Level 2 — Development Team Lead
    │  Provide: docker compose logs output, error screenshot
    │  Time limit: 15 minutes for P1
    ▼
Level 3 — Senior Developer / Architect
    Provide: Full system state, backup timestamps, recent changes
```

### 14.3 Before You Call Escalation — Gather This Information

```bash
# Run this block and share the output with the development team:
echo "=== TIMESTAMP ===" && date
echo "=== CONTAINER STATUS ===" && docker compose ps
echo "=== APP LOGS (last 50 lines) ===" && docker compose logs --tail=50 app
echo "=== DB HEALTH ===" && docker exec postgres_db pg_isready -U as_db_user -d main_database 2>&1
echo "=== DISK ===" && df -h /
echo "=== MEMORY ===" && free -h
echo "=== RECENT BACKUPS ===" && ls -lth /opt/backups/atithi-setu/*.tar.gz 2>/dev/null | head -3
```

### 14.4 Communicating With Restaurant Owners During Downtime

Send this message on WhatsApp/Email to affected owners:

> **Atithi Setu — Temporary Maintenance**
> Our team is aware of the issue and actively working to restore service.
> Estimated resolution: [TIME]
> We apologize for the inconvenience.
> For urgent assistance: [SUPPORT_PHONE]

---

## Appendix A: File Reference for AI-Assisted Troubleshooting

When using **Claude Code** for production troubleshooting, share these files to provide context. These files must exist on the production server.

| File | Why It Matters for Troubleshooting |
|---|---|
| `CLAUDE.md` | Full architecture, all user roles, session flow, known bugs |
| `db.ts` | All database tables, auto-migration scripts, tenant schema pattern |
| `server.ts` | All API endpoints, auth middleware, static file serving, startup sequence |
| `notificationService.ts` | Notification channels, event names, env var requirements |
| `docker-compose.yml` | Container names (used in docker exec commands), volumes, restart policy |
| `nginx-reverse-proxy.conf` | Proxy config, WebSocket configuration |
| `.env.example` | Reference for all required env var names |

**Effective Claude Code troubleshooting prompt:**
```
I'm troubleshooting a production issue on Atithi Setu ERP.

Error from docker logs:
[paste output here]

System state:
- Container status: [paste docker compose ps output]
- Server: Windows + WSL2 Ubuntu 22.04, Docker Desktop, Nginx, Cloudflare
- Recent changes: [describe what changed, if anything]

Question: [describe the specific problem]
```

---

## Appendix B: Quick Command Sheet (Print This Page)

```bash
# ════ DAILY OPERATIONS ══════════════════════════════════════════
# Start everything
cd /opt/atithi-setu && docker compose up -d

# Stop everything
docker compose down

# Restart app only (database stays up)
docker compose restart app

# View live app logs
docker compose logs -f app

# ════ BACKUP & RESTORE ══════════════════════════════════════════
# Take backup now
/opt/atithi-setu/scripts/backup.sh

# List available backups
ls -lth /opt/backups/atithi-setu/*.tar.gz | head -10

# ════ UPGRADE ════════════════════════════════════════════════════
# Full upgrade (run in order)
cd /opt/atithi-setu
/opt/atithi-setu/scripts/backup.sh
docker tag dev-erp-app:latest dev-erp-app:pre-upgrade-$(date +%Y%m%d)
git pull origin main
docker compose build --no-cache app
docker compose up -d app
docker compose logs -f app    # Watch for "Server running on..."

# ════ ROLLBACK ════════════════════════════════════════════════════
# Quick rollback (code only, data safe)
docker stop node_app && docker rm node_app
docker run -d --name node_app --restart always \
  --env-file /opt/atithi-setu/.env -e PORT=5001 -p 5001:5001 \
  -v atithi-setu_app_uploads:/app/public/uploads \
  --network atithi-setu_default \
  dev-erp-app:pre-upgrade-YYYYMMDD    # ← Replace with actual tag

# ════ DATABASE ════════════════════════════════════════════════════
# Interactive SQL shell
docker exec -it postgres_db psql -U as_db_user -d main_database

# Useful SQL commands inside psql:
#   \dn          — list all schemas (public + tenant_xxx)
#   \dt          — list tables in current schema
#   SELECT COUNT(*) FROM restaurants;
#   SELECT id, name, is_active FROM restaurants;
#   \q           — quit

# ════ NGINX & SSL ══════════════════════════════════════════════
sudo nginx -t                              # Test config
sudo systemctl reload nginx                # Apply config
sudo certbot certificates                  # Check SSL expiry
sudo certbot renew                         # Renew SSL

# ════ DIAGNOSTICS ══════════════════════════════════════════════
docker stats --no-stream                   # CPU/memory usage
df -h && docker system df                  # Disk usage
free -h                                    # RAM/swap
docker inspect node_app | grep RestartCount  # Crash count
```

```powershell
# ════ WINDOWS-SPECIFIC (run in PowerShell as Administrator) ════

# Fix port forwarding after restart (if site not reachable externally)
$ip = (wsl hostname -I).Trim().Split(" ")[0]
netsh interface portproxy delete v4tov4 listenport=80 listenaddress=0.0.0.0
netsh interface portproxy delete v4tov4 listenport=443 listenaddress=0.0.0.0
netsh interface portproxy add v4tov4 listenport=80 listenaddress=0.0.0.0 connectport=80 connectaddress=$ip
netsh interface portproxy add v4tov4 listenport=443 listenaddress=0.0.0.0 connectport=443 connectaddress=$ip

# Restart WSL2 completely
wsl --shutdown

# Manually run startup tasks
Start-ScheduledTask -TaskName "AtithiSetuStartup"

# Check startup log
Get-Content "C:\atithi-setu\startup.log" | Select-Object -Last 10

# Check Windows disk space
Get-PSDrive C | Select Used, Free
```

---

*This document is maintained alongside the codebase. Update the "Last Updated" date whenever this file is revised.*
