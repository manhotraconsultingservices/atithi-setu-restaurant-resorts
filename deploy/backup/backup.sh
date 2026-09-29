#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════
# Atithi Setu — nightly off-site backup (runs inside the `backup` service)
# ══════════════════════════════════════════════════════════════════════════
# 1. pg_dump of the whole database (every tenant_<id> schema) in custom format,
#    checked with pg_restore --list; roles via pg_dumpall --globals-only;
#    the app_uploads volume as a tarball.
# 2. On the restore-test day (Sunday by default) the dump is restored into a
#    throwaway Postgres and table/row counts are compared with live.
# 3. Every file is encrypted with age to BACKUP_AGE_RECIPIENT (a PUBLIC key —
#    the private key is kept off this server, so a compromised VPS cannot read
#    the backups), then uploaded to the private off-site bucket and verified.
# 4. Retention: daily/ for BACKUP_RETAIN_DAYS (30), monthly/ (1st of the month)
#    for BACKUP_RETAIN_MONTHS (12).
# 5. Pings BACKUP_HEALTHCHECK_URL (start / success / fail) and emails
#    BACKUP_ALERT_EMAIL on failure.
#
# Run now:   docker compose -f docker-compose.prod.yml exec backup backup.sh
# Force the restore test:  ... exec -e BACKUP_FORCE_RESTORE_TEST=1 backup backup.sh
# ══════════════════════════════════════════════════════════════════════════
set -Eeuo pipefail
[ -f /etc/backup.env ] && . /etc/backup.env

: "${PGHOST:=db}" "${PGPORT:=5432}"
export PGHOST PGPORT
REMOTE="offsite:${BACKUP_S3_BUCKET:-}/${BACKUP_S3_PREFIX:-atithi-setu}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-30}"
RETAIN_MONTHS="${BACKUP_RETAIN_MONTHS:-12}"
TEST_DOW="${BACKUP_RESTORE_TEST_DOW:-7}"          # 1=Mon … 7=Sun
STAMP="$(date +%Y-%m-%d_%H%M)"
WORK=""
STEP="starting"

log() { echo "[backup $(date '+%Y-%m-%d %H:%M:%S')] $*"; }

ping_hc() { # $1 = "" | /start | /fail ; $2 = body
  [ -n "${BACKUP_HEALTHCHECK_URL:-}" ] || return 0
  curl -fsS -m 10 --retry 3 --data-raw "${2:-}" "${BACKUP_HEALTHCHECK_URL}$1" >/dev/null || log "⚠ healthcheck ping failed"
}

email_alert() { # $1 = subject, $2 = body
  [ -n "${BACKUP_ALERT_EMAIL:-}" ] && [ -n "${SMTP_HOST:-}" ] || return 0
  local url
  if [ "${SMTP_SECURE:-false}" = "true" ]; then url="smtps://${SMTP_HOST}:${SMTP_PORT:-465}"; else url="smtp://${SMTP_HOST}:${SMTP_PORT:-587}"; fi
  local from="${SMTP_USER:-backup@localhost}"
  printf 'From: Atithi Setu backups <%s>\r\nTo: %s\r\nSubject: %s\r\n\r\n%s\r\n' "$from" "$BACKUP_ALERT_EMAIL" "$1" "$2" \
    | curl -sS -m 30 --ssl-reqd --url "$url" --user "${SMTP_USER:-}:${SMTP_PASS:-}" \
        --mail-from "$from" --mail-rcpt "$BACKUP_ALERT_EMAIL" --upload-file - >/dev/null \
    || log "⚠ alert email failed"
}

on_error() {
  local rc=$?
  log "❌ BACKUP FAILED during: ${STEP} (exit ${rc})"
  ping_hc /fail "Backup failed during: ${STEP} (exit ${rc}) at ${STAMP}"
  email_alert "❌ Atithi Setu backup FAILED (${STEP})" \
    "The ${STAMP} backup failed during: ${STEP} (exit ${rc}).
Check: docker logs atithi-setu-backup --tail 200
Run again: docker compose -f docker-compose.prod.yml exec backup backup.sh"
  exit "$rc"
}
trap on_error ERR
trap '[ -n "$WORK" ] && rm -rf "$WORK"' EXIT

# One run at a time (cron + a manual run could overlap).
exec 9>/var/lock/atithi-backup.lock
if ! flock -n 9; then log "another backup is running — skipping"; exit 0; fi

STEP="checking configuration"
for k in BACKUP_S3_BUCKET BACKUP_AGE_RECIPIENT PGUSER PGPASSWORD PGDATABASE; do
  if [ -z "${!k:-}" ]; then log "missing ${k}"; false; fi
done
recipients=()
for r in $BACKUP_AGE_RECIPIENT; do recipients+=(-r "$r"); done

ping_hc /start
log "═══ backup ${STAMP} → ${REMOTE}"
WORK="$(mktemp -d /var/tmp/backup.XXXXXX)"
mkdir -p "$WORK/plain" "$WORK/out"

STEP="dumping the database"
pg_dump -Fc -Z 6 -f "$WORK/plain/db.dump" "$PGDATABASE"
pg_restore --list "$WORK/plain/db.dump" >/dev/null     # archive is readable end to end
log "✓ database dump $(du -h "$WORK/plain/db.dump" | cut -f1)"

STEP="dumping roles"
# Role passwords are left out on purpose; the app's password lives in deploy/.env.
pg_dumpall --globals-only --no-role-passwords -f "$WORK/plain/globals.sql"

STEP="archiving uploads"
if [ -d /uploads ] && [ -n "$(ls -A /uploads 2>/dev/null)" ]; then
  tar czf "$WORK/plain/uploads.tar.gz" -C /uploads .
  log "✓ uploads $(du -h "$WORK/plain/uploads.tar.gz" | cut -f1)"
else
  log "ℹ uploads volume empty or not mounted — skipped"
fi

restore_result="not run"
if [ "$(date +%u)" = "$TEST_DOW" ] || [ "${BACKUP_FORCE_RESTORE_TEST:-0}" = "1" ]; then
  STEP="restore test"
  log "→ weekly restore test"
  restore-test.sh "$WORK/plain/db.dump"
  restore_result="passed"
fi

STEP="encrypting"
for f in "$WORK"/plain/*; do
  age "${recipients[@]}" -o "$WORK/out/$(basename "$f").age" "$f"
done
rm -rf "$WORK/plain"

STEP="writing the manifest"
server_version="$(psql -XAtc 'show server_version' "$PGDATABASE")"
schemas="$(psql -XAtc "select count(*) from pg_namespace where nspname like 'tenant\_%'" "$PGDATABASE")"
{
  echo "{"
  echo "  \"stamp\": \"${STAMP}\","
  echo "  \"database\": \"${PGDATABASE}\","
  echo "  \"postgres\": \"${server_version}\","
  echo "  \"tenant_schemas\": ${schemas},"
  echo "  \"restore_test\": \"${restore_result}\","
  echo "  \"encrypted_to\": \"age\","
  echo "  \"files\": {"
  first=1
  for f in "$WORK"/out/*.age; do
    [ $first = 1 ] || echo ","
    first=0
    printf '    "%s": {"bytes": %s, "sha256": "%s"}' "$(basename "$f")" "$(stat -c %s "$f")" "$(sha256sum "$f" | cut -d' ' -f1)"
  done
  echo ""
  echo "  }"
  echo "}"
} > "$WORK/out/manifest.json"

STEP="uploading off-site"
rclone copy "$WORK/out" "$REMOTE/daily/${STAMP}" --retries 5 --low-level-retries 10
rclone check "$WORK/out" "$REMOTE/daily/${STAMP}" --one-way
log "✓ uploaded and verified: daily/${STAMP}"

if [ "$(date +%d)" = "01" ]; then
  STEP="copying the monthly backup"
  rclone copy "$REMOTE/daily/${STAMP}" "$REMOTE/monthly/$(date +%Y-%m)"
  log "✓ monthly copy: monthly/$(date +%Y-%m)"
fi

STEP="pruning old backups"
rclone delete "$REMOTE/daily" --min-age "${RETAIN_DAYS}d"
rclone rmdirs "$REMOTE/daily" --leave-root
if rclone lsf "$REMOTE/monthly" --max-depth 1 >/dev/null 2>&1; then
  rclone delete "$REMOTE/monthly" --min-age "$((RETAIN_MONTHS * 31))d"
  rclone rmdirs "$REMOTE/monthly" --leave-root
fi

summary="Backup ${STAMP} OK — $(du -sh "$WORK/out" | cut -f1) encrypted, ${schemas} tenant schemas, restore test: ${restore_result}"
ping_hc "" "$summary"
log "✅ $summary"
