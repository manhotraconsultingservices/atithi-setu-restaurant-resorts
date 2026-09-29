# Off-site backups

The `backup` service in `docker-compose.prod.yml` backs up production every night
and keeps the copies **off the VPS**, **encrypted**, and **tested**.

| What | Detail |
|---|---|
| Schedule | Daily at 03:00 IST (`BACKUP_SCHEDULE`) |
| Contents | `pg_dump` of the whole database (every `tenant_<id>` schema), roles (`pg_dumpall --globals-only`, without passwords), and the `app_uploads` volume |
| Encryption | [age](https://age-encryption.org), to a **public** key. The private key is never on the server, so a compromised VPS cannot read the backups |
| Destination | A private S3-compatible bucket: `daily/<stamp>/` and, on the 1st, `monthly/<YYYY-MM>/` |
| Retention | 30 daily (`BACKUP_RETAIN_DAYS`), 12 monthly (`BACKUP_RETAIN_MONTHS`) |
| Checks | Every run: `pg_restore --list` on the dump, a SHA-256 manifest, and `rclone check` after upload. Every Sunday: a full restore into a throwaway Postgres, comparing every table and the row counts with live |
| Alerts | `BACKUP_HEALTHCHECK_URL` (start / success / fail pings; alerts even if a backup never runs) and failure email to `BACKUP_ALERT_EMAIL` through the app's `SMTP_*` settings |

Deploys keep it running: `deploy-with-rollback.sh` rebuilds and starts `backup`
after every healthy deploy. If it cannot start, the deploy still succeeds, and a
line is written to `deploy-history.log`.

## One-time setup

### 1. Create the bucket

Choose where the backups live. **Data hosted in India** is a public claim on
atithi-setu.com, so pick an Indian region:

- **AWS S3, Mumbai** (recommended): create a private bucket in `ap-south-1`, with
  Block Public Access on and versioning on. Create an IAM user whose policy
  allows only `s3:PutObject`, `s3:GetObject`, `s3:ListBucket` and
  `s3:DeleteObject` on that bucket.
- **Cloudflare R2**: the location hint is APAC, which is not guaranteed to be in
  India. Create a *separate* private bucket (never the public
  `atithi-setu-menu-images` one) and an API token with Object Read & Write on
  that bucket only.

### 2. Make the encryption key, OFF the server

On your own computer:

```bash
age-keygen -o atithi-setu-backup-identity.txt
```

It prints `Public key: age1...`. Store the identity file somewhere safe, in two
places (for example, a password manager and an offline USB drive). **Without it
the backups cannot be decrypted.** Only the `age1...` public key goes on the server.

To let a second person restore, give them their own key and list both public
keys, separated by a space, in `BACKUP_AGE_RECIPIENT`.

### 3. Monitoring

Create a check at healthchecks.io (free) or any compatible service. Set the
period to 1 day and the grace time to 2 hours, then copy the ping URL.

### 4. Fill in `deploy/.env`

```ini
BACKUP_S3_BUCKET=atithi-setu-backups
BACKUP_S3_PROVIDER=AWS
BACKUP_S3_REGION=ap-south-1
BACKUP_S3_ACCESS_KEY_ID=...
BACKUP_S3_SECRET_ACCESS_KEY=...
BACKUP_AGE_RECIPIENT=age1...
BACKUP_HEALTHCHECK_URL=https://hc-ping.com/<uuid>
BACKUP_ALERT_EMAIL=you@example.com
```

For R2, use `BACKUP_S3_PROVIDER=Cloudflare`,
`BACKUP_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com` and
`BACKUP_S3_REGION=auto`. See `.env.example` for every option.

### 5. Start it and take the first backup

```bash
cd /opt/atithi-setu/deploy
docker compose -f docker-compose.prod.yml up -d --build backup
docker compose -f docker-compose.prod.yml exec -e BACKUP_FORCE_RESTORE_TEST=1 backup backup.sh
```

The last line must read `✅ Backup … OK … restore test: passed`.

## Day to day

```bash
docker compose -f docker-compose.prod.yml logs --tail 100 backup   # recent runs
docker compose -f docker-compose.prod.yml exec backup backup.sh     # back up now (e.g. before a risky change)
docker compose -f docker-compose.prod.yml exec backup restore.sh list
```

## Restoring

1. Copy the identity file into the container:
   `docker cp atithi-setu-backup-identity.txt atithi-setu-backup:/tmp/id.txt`
2. Fetch and decrypt (`latest`, `daily/<stamp>` or `monthly/<YYYY-MM>`):
   `docker compose -f docker-compose.prod.yml exec backup restore.sh latest /tmp/id.txt`
   This checks the files against the manifest, decrypts them into
   `deploy/restore/<name>/`, confirms the dump is readable, and prints the exact
   commands to restore the database and the uploads. It never changes live data
   by itself.
3. Run the printed commands. Take a fresh backup first if the live database is
   still reachable.
4. Delete `deploy/restore/<name>/` and remove `/tmp/id.txt` from the container.

**Rebuilding on a new server:** bootstrap the VPS as usual (`vps-bootstrap.sh`),
fill in `deploy/.env` (including the `BACKUP_*` values), then follow the steps above.

**Once a quarter,** run the restore on a spare machine with the real identity
file. The weekly test proves the dump restores, but only this proves that the
key you have stored can decrypt it.

## Not yet covered

- **`deploy/.env`** (secrets: JWT, database and gateway keys) is deliberately not
  in the backup. Keep a copy in your password manager next to the age identity.
  Without it, a rebuilt server cannot decrypt the AES-encrypted HR fields
  (`HR_DATA_KEY` / `JWT_SECRET`) or the stored gateway credentials.
- **Point-in-time recovery.** Backups are nightly, so a failure can lose up to a
  day of changes. The next step is WAL archiving (for example, pgBackRest or
  wal-g to the same bucket), which cuts that to minutes.
- **Files on Cloudflare R2** (menu images, and guest and HR documents when
  `UPLOAD_BACKEND=r2`) are outside this backup. Turn on R2's own object
  versioning or add an rclone sync of that bucket.
