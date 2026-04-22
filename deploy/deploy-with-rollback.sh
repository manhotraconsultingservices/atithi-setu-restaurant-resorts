#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════
# Atithi Setu — Deploy with auto-rollback
# ══════════════════════════════════════════════════════════════════════════
# Runs on the VPS. Invoked by GitHub Actions via SSH after a push to main.
#
# Flow:
#   1. Tag the currently-running image as "atithi-setu:rollback"
#      (so we can revert if the new build fails)
#   2. git pull main
#   3. docker compose build (new image)
#   4. docker compose up -d (swaps containers — brief 10-20s downtime)
#   5. Wait up to 60s for /api/public/restaurants → 200
#   6. If healthy:  keep running ✓
#      If unhealthy: retag rollback image as current and restart ✗
#   7. Log the outcome to deploy-history.log
# ══════════════════════════════════════════════════════════════════════════

set -uo pipefail

APP_DIR="/opt/atithi-setu"
DEPLOY_DIR="$APP_DIR/deploy"
COMPOSE_FILE="docker-compose.prod.yml"
CURRENT_IMAGE="deploy-app"         # docker-compose auto-names the built image <project>-<service>
ROLLBACK_TAG="atithi-setu:rollback"
HEALTH_URL="http://localhost:5001/api/public/restaurants"
HEALTH_MAX_WAIT=60                  # seconds to wait for new version to become healthy
LOG_FILE="$APP_DIR/deploy-history.log"

# ─── Helpers ─────────────────────────────────────────────────────────────
log() {
  local ts=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[$ts] $*"  | tee -a "$LOG_FILE"
}

fail() {
  log "❌ DEPLOY FAILED — $*"
  exit 1
}

# Wait for the app to return HTTP 200 from the health endpoint.
# Returns 0 if healthy, 1 if it never came up.
wait_for_health() {
  local max=$1
  for ((i=1; i<=max; i++)); do
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$HEALTH_URL" || echo 000)
    if [[ "$code" == "200" ]]; then
      log "✓ Health check passed in ${i}s"
      return 0
    fi
    sleep 1
  done
  return 1
}

# Roll back to the previous image if present.
rollback() {
  log "⚠ Health check failed. Rolling back to previous image…"
  if ! docker image inspect "$ROLLBACK_TAG" >/dev/null 2>&1; then
    log "   No rollback image found — this may be the first deploy. Leaving current state."
    return 1
  fi
  # Retag rollback image as the current build and restart
  docker tag "$ROLLBACK_TAG" "$CURRENT_IMAGE:latest"
  docker compose -f "$COMPOSE_FILE" up -d --no-build app
  if wait_for_health 45; then
    log "✓ Rollback succeeded. Previous version is live again."
    return 0
  else
    log "‼ Rollback also failed to become healthy. MANUAL INTERVENTION REQUIRED."
    return 1
  fi
}

# ─── Main flow ───────────────────────────────────────────────────────────
cd "$DEPLOY_DIR" || fail "Deploy directory $DEPLOY_DIR not found"

log "═════════════════════════════════════════════════════════════════"
log "Deploy started by: ${GITHUB_ACTOR:-manual}"
log "Commit: ${GITHUB_SHA:-unknown} (${GITHUB_REF_NAME:-unknown branch})"
log "═════════════════════════════════════════════════════════════════"

# Step 1: Tag the current running image as rollback (preserves last-good)
if docker image inspect "$CURRENT_IMAGE:latest" >/dev/null 2>&1; then
  docker tag "$CURRENT_IMAGE:latest" "$ROLLBACK_TAG" \
    && log "✓ Tagged current image as rollback"
else
  log "⚠ No current image found (first-time deploy). Skipping rollback-tag step."
fi

# Step 2: Pull latest code
cd "$APP_DIR" || fail "App directory missing"
git fetch origin main --depth=1 || fail "git fetch failed"
OLD_SHA=$(git rev-parse HEAD)
git reset --hard origin/main || fail "git reset failed"
NEW_SHA=$(git rev-parse HEAD)
log "✓ Code updated: $OLD_SHA → $NEW_SHA"

if [[ "$OLD_SHA" == "$NEW_SHA" ]]; then
  log "ℹ No new commits. Exiting early."
  exit 0
fi

# Step 3+4: Build + swap containers
cd "$DEPLOY_DIR"
log "→ Building new image and swapping containers…"
if ! docker compose -f "$COMPOSE_FILE" up -d --build app 2>&1 | tee -a "$LOG_FILE"; then
  log "‼ Docker build failed"
  rollback
  fail "build error"
fi

# Step 5: Health check
log "→ Waiting for new version to become healthy (up to ${HEALTH_MAX_WAIT}s)…"
if wait_for_health "$HEALTH_MAX_WAIT"; then
  log "✅ DEPLOY SUCCEEDED — $NEW_SHA is live"
  # Optional: ping a webhook for success notification
  exit 0
else
  log "‼ New version did not become healthy"
  rollback
  fail "new version unhealthy"
fi
