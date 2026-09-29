#!/usr/bin/env bash
# Configures rclone from BACKUP_S3_* env vars, then runs crond in the foreground.
# `docker compose exec backup backup.sh` runs a backup immediately.
set -euo pipefail

# rclone reads remotes from RCLONE_CONFIG_<NAME>_* env vars — no config file
# (an empty RCLONE_CONFIG stops it looking for one).
export RCLONE_CONFIG=""
# Tests may pre-set RCLONE_CONFIG_OFFSITE_TYPE (e.g. "local") to skip S3.
if [ -z "${RCLONE_CONFIG_OFFSITE_TYPE:-}" ]; then
  export RCLONE_CONFIG_OFFSITE_TYPE=s3
  export RCLONE_CONFIG_OFFSITE_PROVIDER="${BACKUP_S3_PROVIDER:-Other}"
  export RCLONE_CONFIG_OFFSITE_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
  export RCLONE_CONFIG_OFFSITE_REGION="${BACKUP_S3_REGION:-auto}"
  export RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY_ID:-}"
  export RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY:-}"
  # A token scoped to one bucket cannot list or create buckets.
  export RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET=true
  export RCLONE_CONFIG_OFFSITE_ACL=private
fi

# crond (and `docker compose exec`) start without the variables exported above.
# Save them with bash's own quoting; backup.sh and restore-test.sh source this file.
export -p | grep -E '^declare -x (PG|BACKUP_|RCLONE_|SMTP_|TZ=)' > /etc/backup.env
chmod 600 /etc/backup.env

SCHEDULE="${BACKUP_SCHEDULE:-0 3 * * *}"
echo "${SCHEDULE} /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1" > /etc/crontabs/root

missing=()
for k in BACKUP_S3_BUCKET BACKUP_AGE_RECIPIENT; do
  [ -n "${!k:-}" ] || missing+=("$k")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "[backup] ⚠ NOT CONFIGURED — missing ${missing[*]} in deploy/.env. No backups will run until they are set (see deploy/BACKUPS.md)."
fi

echo "[backup] scheduled '${SCHEDULE}' (${TZ}); off-site target: ${BACKUP_S3_BUCKET:-<unset>}"
exec crond -f -l 8
