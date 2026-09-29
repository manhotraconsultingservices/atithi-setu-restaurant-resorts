# Off-site backup runner for the production stack (see deploy/BACKUPS.md).
# postgres:16-alpine gives pg_dump/pg_restore matching the db service, plus the
# server binaries the weekly restore test needs. age encrypts, rclone uploads.
FROM postgres:16-alpine

RUN apk add --no-cache age rclone curl tzdata bash coreutils

ENV TZ=Asia/Kolkata

COPY backup.sh restore-test.sh restore.sh entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore-test.sh /usr/local/bin/restore.sh /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
