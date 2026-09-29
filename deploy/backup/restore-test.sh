#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════
# Restore a pg_dump archive into a throwaway Postgres inside this container
# and compare it with the live database: every table must exist, and row
# counts must match within BACKUP_RESTORE_TOLERANCE_PCT (default 1% overall,
# because live keeps taking orders while the test runs). Exit 1 on mismatch.
#
#   restore-test.sh /path/to/db.dump
# ══════════════════════════════════════════════════════════════════════════
set -Eeuo pipefail
[ -f /etc/backup.env ] && . /etc/backup.env
DUMP="$1"
TOLERANCE="${BACKUP_RESTORE_TOLERANCE_PCT:-1}"
TEST_DIR="$(mktemp -d /var/tmp/restore-test.XXXXXX)"
SOCK="$TEST_DIR/sock"
PORT=5499

log() { echo "[restore-test $(date '+%H:%M:%S')] $*"; }
as_pg() { su postgres -s /bin/bash -c "$*"; }

cleanup() {
  as_pg "pg_ctl -D '$TEST_DIR/data' -m immediate stop" >/dev/null 2>&1 || true
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

# One row per base table: "schema.table|rows". query_to_xml counts every table
# in a single statement instead of thousands of round trips.
COUNT_SQL="select table_schema || '.' || table_name || '|' ||
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
  from information_schema.tables
  where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')
  order by 1"

log "counting live rows"
psql -XAt -v ON_ERROR_STOP=1 -c "$COUNT_SQL" "$PGDATABASE" > "$TEST_DIR/live.txt"

log "starting a throwaway Postgres"
mkdir -p "$SOCK"
chown -R postgres:postgres "$TEST_DIR"
chmod 755 "$TEST_DIR"
as_pg "initdb -D '$TEST_DIR/data' -A trust -U postgres --no-locale -E UTF8 >/dev/null"
as_pg "pg_ctl -D '$TEST_DIR/data' -o \"-p $PORT -k '$SOCK' -c listen_addresses=''\" -w start >/dev/null"
# Only the server runs as postgres; the clients run as root (which can read the
# dump) and connect over the socket with trust auth.
createdb -h "$SOCK" -p $PORT -U postgres restored

log "restoring $(du -h "$DUMP" | cut -f1)"
pg_restore -h "$SOCK" -p $PORT -U postgres -d restored --no-owner --no-privileges --exit-on-error -j 2 "$DUMP"

psql -h "$SOCK" -p $PORT -U postgres -XAt -v ON_ERROR_STOP=1 -c "$COUNT_SQL" restored > "$TEST_DIR/restored.txt"

# Compare (byte-order sort, as join/comm require).
export LC_ALL=C
sort -t'|' -k1,1 -o "$TEST_DIR/live.txt" "$TEST_DIR/live.txt"
sort -t'|' -k1,1 -o "$TEST_DIR/restored.txt" "$TEST_DIR/restored.txt"
missing="$(comm -23 <(cut -d'|' -f1 "$TEST_DIR/live.txt") <(cut -d'|' -f1 "$TEST_DIR/restored.txt") || true)"
live_tables=$(wc -l < "$TEST_DIR/live.txt")
restored_tables=$(wc -l < "$TEST_DIR/restored.txt")
live_rows=$(awk -F'|' '{s+=$2} END {print s+0}' "$TEST_DIR/live.txt")
restored_rows=$(awk -F'|' '{s+=$2} END {print s+0}' "$TEST_DIR/restored.txt")
emptied="$(join -t'|' "$TEST_DIR/live.txt" "$TEST_DIR/restored.txt" | awk -F'|' '$2 > 0 && $3 == 0 {print $1}')"

log "tables: live ${live_tables}, restored ${restored_tables}; rows: live ${live_rows}, restored ${restored_rows}"

fail=0
if [ -n "$missing" ]; then
  log "✗ tables missing from the restore (or created after the dump started):"; echo "$missing" | head -20
  fail=1
fi
if [ -n "$emptied" ]; then
  log "✗ tables with rows live but empty after restore:"; echo "$emptied" | head -20
  fail=1
fi
if [ "$live_rows" -gt 0 ]; then
  drift_pct=$(awk -v a="$live_rows" -v b="$restored_rows" 'BEGIN { d = a - b; if (d < 0) d = -d; printf "%.3f", d * 100 / a }')
  if awk -v d="$drift_pct" -v t="$TOLERANCE" 'BEGIN { exit !(d > t) }'; then
    log "✗ total row count differs by ${drift_pct}% (tolerance ${TOLERANCE}%)"
    fail=1
  fi
fi

if [ "$fail" = 1 ]; then
  log "❌ restore test FAILED"
  exit 1
fi
log "✅ restore test passed"
