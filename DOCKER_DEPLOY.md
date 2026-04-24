# Atithi-Setu — Docker Deployment Guide

> **App runs on port `5001`**
> Access at: `http://localhost:5001`

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [First-Time Setup](#first-time-setup)
3. [Deploying with Scripts (Recommended)](#deploying-with-scripts-recommended)
4. [Manual Commands Reference](#manual-commands-reference)
5. [Deployment Scenarios](#deployment-scenarios)
6. [Database Operations](#database-operations)
7. [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | ≥ 24 | `docker --version` |
| [Docker Compose](https://docs.docker.com/compose/) | ≥ 2 (V2) | `docker compose version` |

> **Note:** Docker Compose V2 uses `docker compose` (space), not `docker-compose` (hyphen).
> Both are supported in the scripts, but V2 syntax is used throughout this guide.

---

## First-Time Setup

### 1. Configure environment variables

```bash
# Windows
copy .env.example .env

# Linux / macOS
cp .env.example .env
```

Open `.env` and fill in the required values:

```env
# Minimum required to run locally:
JWT_SECRET=change-me-to-a-long-random-secret-at-least-32-chars

PGHOST=db                   # Must stay as "db" for Docker networking
PGPORT=5432
PGUSER=atithi_user
PGPASSWORD=your_secure_password
PGDATABASE=main_database
PGSSL=false
```

> All third-party keys (Twilio, WhatsApp, SMTP, Gemini) are optional.
> The app starts and runs without them — notifications will be silently skipped.

---

## Deploying with Scripts (Recommended)

The deployment scripts wrap all common Docker operations into a simple numbered menu.
**You never need to memorise any Docker commands.**

### Windows

```cmd
deploy.bat
```

### Linux / macOS

```bash
chmod +x deploy.sh    # Only needed once
./deploy.sh
```

### Menu Options

```
╔══════════════════════════════════════════════════╗
║         Atithi-Setu  |  Docker Manager          ║
║                  Port :  5001                    ║
╚══════════════════════════════════════════════════╝

  [1]  Full Deploy          (build image + start all)
  [2]  Rebuild & Deploy     (--no-cache, use after dependency changes)
  [3]  Deploy Code Changes  (rebuild app only, keep DB running)
  [4]  Restart App          (restart node_app container only)
  [5]  View Live Logs       (Ctrl+C to exit log view)
  [6]  Container Status     (show running containers + ports)
  [7]  Stop All             (stop containers, keep volumes)
  [8]  Full Teardown        (stop + remove containers & networks)
  [9]  Backup Database      (dumps SQL to ./backups/)
  [0]  Exit
```

---

## Manual Commands Reference

If you prefer running commands directly instead of using the scripts:

### Start / Build

```bash
# Build image and start all services
docker compose up -d --build

# Build with no cache (clean image from scratch)
docker compose build --no-cache
docker compose up -d

# Start previously built containers (no rebuild)
docker compose up -d
```

### Stop / Remove

```bash
# Stop containers (data is preserved)
docker compose stop

# Stop and remove containers + network (volumes kept)
docker compose down

# Full wipe including volumes (DELETES ALL DATABASE DATA)
docker compose down -v
```

### Logs

```bash
# Live logs from all services
docker compose logs -f

# Live logs from app only (last 50 lines)
docker compose logs -f --tail=50 app

# Live logs from database only
docker compose logs -f db
```

### Individual Container Control

```bash
# Restart only the app (useful after .env changes)
docker compose restart app

# Rebuild and restart app only (DB stays up)
docker compose stop app
docker compose build app
docker compose up -d app

# Open a shell inside the app container
docker compose exec app sh

# Open a PostgreSQL prompt
docker compose exec db psql -U $PGUSER -d $PGDATABASE
```

### Status

```bash
# Show running containers with ports
docker compose ps

# Show resource usage (CPU / RAM)
docker stats
```

---

## Deployment Scenarios

### Scenario A — First deployment

```
Use script option [1]  or:  docker compose up -d --build
```

### Scenario B — You changed source code (src/, server.ts, etc.)

```
Use script option [3]  — rebuilds app only, DB stays running
```
This is the fastest option for iterative development. The DB container is never touched.

### Scenario C — You added / changed npm dependencies (package.json)

```
Use script option [2]  — full no-cache rebuild
```
Cache layers become stale when `package.json` changes, so a clean rebuild is needed.

### Scenario D — You only changed .env variables

```
Use script option [4]  — restart app container
```
No rebuild needed; environment variables are injected at container start.

### Scenario E — Port 5001 is in use

Edit `docker-compose.yml` and change the host port (left side of `:`):

```yaml
ports:
  - "5002:5001"   # Now accessible at localhost:5002
```

Then run a full deploy (option [1]).

---

## Database Operations

### Backup

```bash
# Using the script (option [9]) — saves to ./backups/
./deploy.sh   →  [9]

# Manual dump
docker compose exec -T db pg_dump -U $PGUSER $PGDATABASE > backups/manual_backup.sql
```

### Restore

```bash
# Restore from a backup file
docker compose exec -T db psql -U $PGUSER $PGDATABASE < backups/atithi_setu_2026-03-15__10-00-00.sql
```

### Persist Data Across Rebuilds

Database data lives in the `pg_data` Docker volume.
`docker compose down` (without `-v`) **always preserves** this volume.

```bash
# List volumes
docker volume ls | grep atithi

# Inspect volume location on disk
docker volume inspect dev-erp_pg_data
```

---

## Troubleshooting

### App container exits immediately

```bash
docker compose logs app
```
Common causes:
- `.env` file is missing or has empty `PGPASSWORD`
- Another process is already using port 5001
- TypeScript compilation error in `server.ts`

### Cannot connect to database

Verify the `db` container is healthy:
```bash
docker compose ps
```
The `db` service must show `(healthy)` before the app starts. If it shows `starting`, wait 10–15 seconds and re-check.

The `PGHOST` in `.env` **must be `db`** (the Docker service name), not `localhost`.

### Port 5001 already in use

```bash
# Find what is using the port
# Windows
netstat -ano | findstr :5001

# Linux / macOS
lsof -i :5001
```

Then either stop that process or change the host port in `docker-compose.yml`.

### Reset everything and start fresh

> ⚠️ **This permanently deletes all database data.**

```bash
docker compose down -v --remove-orphans
docker compose up -d --build
```

### Image is stale after code changes

```bash
docker compose build --no-cache app
docker compose up -d app
```

---

## File Reference

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage build: installs deps → builds React → runs Express |
| `docker-compose.yml` | Defines `app` (port 5001) and `db` (PostgreSQL 16) services |
| `.dockerignore` | Files excluded from the Docker build context |
| `.env` | Your local secrets (never committed to git) |
| `.env.example` | Template with all supported variables and documentation |
| `deploy.bat` | Windows interactive deployment menu |
| `deploy.sh` | Linux / macOS interactive deployment menu |
| `backups/` | SQL dumps created by the backup option (git-ignored) |
