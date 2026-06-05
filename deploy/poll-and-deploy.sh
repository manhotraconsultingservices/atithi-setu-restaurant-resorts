#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════
# Atithi Setu — VPS-side pull-deploy poller
# ══════════════════════════════════════════════════════════════════════════
# Runs every minute via cron on the VPS. Checks `origin/master` for new
# commits and triggers deploy-with-rollback.sh if anything changed.
#
# WHY THIS EXISTS:
#   Hostinger's panel-level firewall / DDoS shield intermittently blocks
#   inbound TCP from GitHub Actions runner IPs. The GitHub→VPS SSH push
#   model fails every few days. Pulling FROM the VPS (outbound to GitHub
#   over HTTPS via CDN) is never blocked — that's always reachable.
#
# CONTRACT:
#   • Idempotent — safe to run every minute. No-op when no new commits.
#   • Exit 0 unless something catastrophic. Cron should never email.
#   • Logs to /opt/atithi-setu/poll-deploy.log (rotated weekly by logrotate).
#   • A lockfile prevents two pollers from running concurrently (deploy
#     can take 2-3 min; the next cron tick during that window must wait).
#
# INSTALLATION (one-time, on the VPS):
#   sudo cp /opt/atithi-setu/deploy/poll-and-deploy.sh /usr/local/sbin/
#   sudo chmod +x /usr/local/sbin/poll-and-deploy.sh
#   sudo crontab -l 2>/dev/null | grep -v poll-and-deploy > /tmp/cron.tmp
#   echo "* * * * * /usr/local/sbin/poll-and-deploy.sh >/dev/null 2>&1" >> /tmp/cron.tmp
#   sudo crontab /tmp/cron.tmp
#   rm /tmp/cron.tmp
#
#   # Verify it's installed:
#   sudo crontab -l | grep poll-and-deploy
# ══════════════════════════════════════════════════════════════════════════

set -uo pipefail

APP_DIR="/opt/atithi-setu"
BRANCH="master"
LOCK_FILE="/var/lock/atithi-setu-deploy.lock"
LOG_FILE="$APP_DIR/poll-deploy.log"
DEPLOY_SCRIPT="$APP_DIR/deploy/deploy-with-rollback.sh"

log() {
  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[$ts] $*" >> "$LOG_FILE"
}

# ─── Mutex via flock(1) ───────────────────────────────────────────────────
# Acquire an exclusive non-blocking lock. If another invocation is already
# running (mid-deploy), bail silently — we'll catch up next minute.
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  # Don't even log this — adds noise every minute during a deploy.
  exit 0
fi

# ─── Sanity checks ────────────────────────────────────────────────────────
if [ ! -d "$APP_DIR/.git" ]; then
  log "❌ $APP_DIR is not a git repo. Manual setup required."
  exit 0
fi

cd "$APP_DIR" || exit 0

# ─── Probe upstream for new commits ───────────────────────────────────────
# `git fetch --quiet` is the network call. It either succeeds (we know the
# current origin/$BRANCH SHA) or fails (GitHub temporarily unreachable from
# the VPS — extremely rare since this is outbound HTTPS). Either way we
# don't loop or retry; the next cron tick is only 60s away.
LOCAL_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
if ! git fetch origin "$BRANCH" --quiet 2>>"$LOG_FILE"; then
  log "⚠ git fetch failed — will retry next minute"
  exit 0
fi
REMOTE_SHA=$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "")

# Up to date? Done.
if [ -z "$REMOTE_SHA" ] || [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  exit 0
fi

# ─── New commit detected — deploy ────────────────────────────────────────
log "═════════════════════════════════════════════════════════════════"
log "New commit on $BRANCH: $LOCAL_SHA → $REMOTE_SHA"
log "Triggering deploy-with-rollback.sh…"

# Hand off to the existing deploy script. It already does: tag rollback
# image → git reset --hard → docker compose build → healthcheck →
# rollback-on-unhealthy → write to deploy-history.log.
export BRANCH
export GITHUB_SHA="$REMOTE_SHA"
export GITHUB_ACTOR="cron-poll"
export GITHUB_REF_NAME="$BRANCH"

if [ ! -f "$DEPLOY_SCRIPT" ]; then
  log "❌ Deploy script missing: $DEPLOY_SCRIPT"
  exit 1
fi
# Defensive: git checkout doesn't always preserve the executable bit
# (especially on platforms with core.fileMode=false). Re-apply it on
# every run so the cron never breaks just because someone reset --hard.
chmod +x "$DEPLOY_SCRIPT" "$APP_DIR/deploy/poll-and-deploy.sh" 2>/dev/null || true

if "$DEPLOY_SCRIPT" >>"$LOG_FILE" 2>&1; then
  log "✅ Deploy completed for $REMOTE_SHA"
else
  log "❌ Deploy failed for $REMOTE_SHA (exit $?). See deploy-history.log + docker logs."
fi
