#!/usr/bin/env bash
# ============================================================
#  Atithi-Setu — Docker Deployment Script (Linux / macOS)
#  Usage:  chmod +x deploy.sh && ./deploy.sh
# ============================================================

set -euo pipefail

# Resolve script directory so it works from any location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Colour helpers ───────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ============================================================
# HELPER FUNCTIONS
# ============================================================

check_docker() {
    if ! docker info > /dev/null 2>&1; then
        echo -e "${RED}[ERROR] Docker is not running.${RESET}"
        echo -e "${YELLOW}        Please start Docker (or Docker Desktop) and try again.${RESET}"
        exit 1
    fi
}

check_env() {
    if [ ! -f ".env" ]; then
        echo -e "${RED}[ERROR] .env file not found!${RESET}"
        echo -e "${YELLOW}        Copy .env.example and fill in your values:${RESET}"
        echo "        cp .env.example .env"
        exit 1
    fi
}

show_status() {
    echo ""
    echo -e "${BOLD}Container Status:${RESET}"
    docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || \
    docker compose ps
}

pause_return() {
    echo ""
    read -rp "Press Enter to return to the menu..."
    show_menu
}

# ============================================================
# MENU
# ============================================================

show_menu() {
    clear
    echo -e "${CYAN}"
    echo " ╔══════════════════════════════════════════════════╗"
    echo " ║         Atithi-Setu  |  Docker Manager          ║"
    echo " ║                  Port :  5001                    ║"
    echo " ╚══════════════════════════════════════════════════╝"
    echo -e "${RESET}"
    echo -e " ${BOLD}Select an action:${RESET}"
    echo ""
    echo -e "  ${GREEN}[1]${RESET}  Full Deploy          (build image + start all)"
    echo -e "  ${GREEN}[2]${RESET}  Rebuild & Deploy     (--no-cache, use after dependency changes)"
    echo -e "  ${GREEN}[3]${RESET}  Deploy Code Changes  (rebuild app only, keep DB running)"
    echo -e "  ${GREEN}[4]${RESET}  Restart App          (restart node_app container only)"
    echo -e "  ${GREEN}[5]${RESET}  View Live Logs       (Ctrl+C to exit log view)"
    echo -e "  ${GREEN}[6]${RESET}  Container Status     (show running containers + ports)"
    echo -e "  ${GREEN}[7]${RESET}  Stop All             (stop containers, keep volumes)"
    echo -e "  ${GREEN}[8]${RESET}  Full Teardown        (stop + remove containers & networks)"
    echo -e "  ${GREEN}[9]${RESET}  Backup Database      (dumps SQL to ./backups/)"
    echo -e "  ${GREEN}[0]${RESET}  Exit"
    echo ""
    read -rp " Enter choice [0-9]: " CHOICE

    case "$CHOICE" in
        1) full_deploy ;;
        2) rebuild_deploy ;;
        3) deploy_code ;;
        4) restart_app ;;
        5) view_logs ;;
        6) show_status; pause_return ;;
        7) stop_all ;;
        8) teardown ;;
        9) backup_db ;;
        0) echo "Goodbye!"; exit 0 ;;
        *) echo -e "${RED}Invalid choice.${RESET}"; sleep 1; show_menu ;;
    esac
}

# ============================================================
# ACTION: FULL DEPLOY
# ============================================================

full_deploy() {
    echo ""
    echo -e "${CYAN}[DEPLOY] Starting full deploy on port 5001...${RESET}"
    check_env
    check_docker

    echo -e "${YELLOW}[1/3] Pulling latest base images...${RESET}"
    docker compose pull db 2>/dev/null || true

    echo -e "${YELLOW}[2/3] Building application image...${RESET}"
    docker compose build

    echo -e "${YELLOW}[3/3] Starting all containers...${RESET}"
    docker compose up -d

    show_status
    echo ""
    echo -e "${GREEN}[OK] Deployment complete!${RESET}"
    echo -e "${GREEN}     App is running at: http://localhost:5001${RESET}"
    pause_return
}

# ============================================================
# ACTION: REBUILD & DEPLOY (no-cache)
# ============================================================

rebuild_deploy() {
    echo ""
    echo -e "${CYAN}[REBUILD] Full rebuild (no-cache) on port 5001...${RESET}"
    echo -e "${YELLOW}This discards all cached layers — takes longer but ensures a clean image.${RESET}"
    echo ""
    check_env
    check_docker

    echo -e "${YELLOW}[1/3] Stopping existing containers...${RESET}"
    docker compose down --remove-orphans || true

    echo -e "${YELLOW}[2/3] Building from scratch (--no-cache)...${RESET}"
    docker compose build --no-cache

    echo -e "${YELLOW}[3/3] Starting all containers...${RESET}"
    docker compose up -d

    show_status
    echo ""
    echo -e "${GREEN}[OK] Clean rebuild complete!${RESET}"
    echo -e "${GREEN}     App is running at: http://localhost:5001${RESET}"
    pause_return
}

# ============================================================
# ACTION: DEPLOY CODE CHANGES (app only, DB stays up)
# ============================================================

deploy_code() {
    echo ""
    echo -e "${CYAN}[CODE DEPLOY] Rebuilding app only (DB stays running)...${RESET}"
    echo -e "${YELLOW}Use this after changing src/, server.ts, or other app files.${RESET}"
    echo ""
    check_docker

    echo -e "${YELLOW}[1/3] Stopping app container only...${RESET}"
    docker compose stop app

    echo -e "${YELLOW}[2/3] Rebuilding app image (with cache)...${RESET}"
    docker compose build app

    echo -e "${YELLOW}[3/3] Starting updated app container...${RESET}"
    docker compose up -d app

    echo -e "${YELLOW}Waiting for app to start...${RESET}"
    sleep 5

    show_status
    echo ""
    echo -e "${GREEN}[OK] Code deploy complete!${RESET}"
    echo -e "${GREEN}     App is running at: http://localhost:5001${RESET}"
    pause_return
}

# ============================================================
# ACTION: RESTART APP
# ============================================================

restart_app() {
    echo ""
    echo -e "${CYAN}[RESTART] Restarting node_app container...${RESET}"
    check_docker
    docker compose restart app
    sleep 4
    show_status
    echo ""
    echo -e "${GREEN}[OK] App restarted at: http://localhost:5001${RESET}"
    pause_return
}

# ============================================================
# ACTION: VIEW LOGS
# ============================================================

view_logs() {
    echo ""
    echo -e "${CYAN}[LOGS] Streaming logs (press Ctrl+C to stop)...${RESET}"
    echo ""
    docker compose logs -f --tail=50 || true
    pause_return
}

# ============================================================
# ACTION: STOP ALL
# ============================================================

stop_all() {
    echo ""
    echo -e "${CYAN}[STOP] Stopping containers (volumes are preserved)...${RESET}"
    docker compose stop
    echo -e "${GREEN}[OK] Containers stopped. Your database data is safe.${RESET}"
    pause_return
}

# ============================================================
# ACTION: TEARDOWN
# ============================================================

teardown() {
    echo ""
    echo -e "${YELLOW}[WARNING] This will stop and REMOVE all containers and networks.${RESET}"
    echo -e "${YELLOW}          Your database VOLUME (pg_data) will be preserved.${RESET}"
    echo ""
    read -rp " Type YES to confirm teardown: " CONFIRM
    if [ "$CONFIRM" != "YES" ]; then
        echo -e "${YELLOW}Cancelled.${RESET}"
        pause_return
        return
    fi
    docker compose down --remove-orphans
    echo -e "${GREEN}[OK] Teardown complete. Run option [1] to redeploy.${RESET}"
    pause_return
}

# ============================================================
# ACTION: BACKUP DATABASE
# ============================================================

backup_db() {
    echo ""
    echo -e "${CYAN}[BACKUP] Creating PostgreSQL dump...${RESET}"
    check_docker

    mkdir -p backups

    TIMESTAMP=$(date +"%Y-%m-%d__%H-%M-%S")
    BACKUP_FILE="backups/atithi_setu_${TIMESTAMP}.sql"

    # Read credentials from .env
    PGUSER_VAL=$(grep  '^PGUSER='     .env | cut -d= -f2)
    PGDB_VAL=$(grep    '^PGDATABASE=' .env | cut -d= -f2)

    echo -e "${YELLOW}Dumping database to: ${BACKUP_FILE}${RESET}"

    if docker compose exec -T db pg_dump -U "$PGUSER_VAL" "$PGDB_VAL" > "$BACKUP_FILE"; then
        echo -e "${GREEN}[OK] Backup saved to: ${BACKUP_FILE}${RESET}"
        echo ""
        echo -e "${YELLOW}Recent backups:${RESET}"
        ls -t backups/*.sql 2>/dev/null | head -5
    else
        echo -e "${RED}[ERROR] Backup failed. Is the db container running?${RESET}"
        rm -f "$BACKUP_FILE"
    fi
    pause_return
}

# ============================================================
# ENTRYPOINT
# ============================================================

show_menu
