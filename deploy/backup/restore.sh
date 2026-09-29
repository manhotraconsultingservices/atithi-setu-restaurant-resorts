#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════
# Fetch and decrypt an off-site backup, ready to restore (see deploy/BACKUPS.md).
# It never touches the live database — it prints the commands for that.
#
#   restore.sh list                         # show available backups
#   restore.sh <daily/STAMP|monthly/YYYY-MM|latest> /keys/backup-identity.txt
#
# The identity file is the age PRIVATE key. It is not kept on the server:
# copy it in for the restore (e.g. docker cp) and delete it afterwards.
# ══════════════════════════════════════════════════════════════════════════
set -Eeuo pipefail
[ -f /etc/backup.env ] && . /etc/backup.env
REMOTE="offsite:${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX:-atithi-setu}"

if [ "${1:-}" = "list" ]; then
  rclone lsf "$REMOTE/daily" --dirs-only | sed 's|^|daily/|'
  rclone lsf "$REMOTE/monthly" --dirs-only 2>/dev/null | sed 's|^|monthly/|'
  exit 0
fi

WHICH="${1:?usage: restore.sh <daily/STAMP|monthly/YYYY-MM|latest> <identity-file>}"
IDENTITY="${2:?usage: restore.sh <which> <identity-file>}"
if [ "$WHICH" = "latest" ]; then
  WHICH="daily/$(rclone lsf "$REMOTE/daily" --dirs-only | sort | tail -1 | tr -d /)"
fi

# /restore is bind-mounted from deploy/restore/ on the host (git-ignored).
NAME="${WHICH//\//_}"
OUT="/restore/$NAME"
mkdir -p "$OUT"
echo "→ downloading $WHICH"
rclone copy "$REMOTE/$WHICH" "$OUT/encrypted"
(cd "$OUT/encrypted" && for f in *.age; do
  expected=$(grep -o "\"$f\": {[^}]*}" manifest.json | grep -o '"sha256": "[0-9a-f]*"' | cut -d'"' -f4)
  actual=$(sha256sum "$f" | cut -d' ' -f1)
  [ "$expected" = "$actual" ] || { echo "✗ checksum mismatch for $f"; exit 1; }
done)
echo "✓ checksums match the manifest"

for f in "$OUT"/encrypted/*.age; do
  age -d -i "$IDENTITY" -o "$OUT/$(basename "${f%.age}")" "$f"
done
pg_restore --list "$OUT/db.dump" >/dev/null
rm -rf "$OUT/encrypted"
echo "✓ decrypted into deploy/restore/$NAME on the host; the database archive is readable"

cat <<EOF

Run these from /opt/atithi-setu/deploy. They REPLACE live data — take a fresh
backup first (docker compose -f docker-compose.prod.yml exec backup backup.sh).

Database:
  docker compose -f docker-compose.prod.yml stop app
  docker compose -f docker-compose.prod.yml exec backup \\
    pg_restore -d "$PGDATABASE" --clean --if-exists --no-owner --exit-on-error /restore/$NAME/db.dump
  docker compose -f docker-compose.prod.yml start app

Uploads (logos, documents):
  docker run --rm -v deploy_app_uploads:/target -v "\$PWD/restore/$NAME":/src:ro alpine \\
    tar xzf /src/uploads.tar.gz -C /target

Then delete deploy/restore/$NAME and the identity file.
EOF
