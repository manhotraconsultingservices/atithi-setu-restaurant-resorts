# Auto-Deploy Setup — Push to `master` → Production (PULL model)

> **This is the CURRENT model.** An earlier version of this doc described a
> GitHub→VPS **SSH push** model triggered on `main`. That was abandoned:
> Hostinger's panel-level firewall intermittently blocks inbound TCP from
> GitHub Actions runner IPs, so every few days the SSH push failed and
> master/prod drifted. We now **pull from the VPS** (outbound HTTPS is never
> blocked). The `main`-triggered `deploy.yml` is dormant; **deploy from
> `master`.**

## What happens on every push to `master`

```
git push origin master
    │
    ├─────────────────────────────► GitHub Actions: deploy-vps.yml
    │                                (NOTIFIER/VERIFIER ONLY — does not deploy)
    │                                Polls https://app.atithi-setu.com/api/version
    │                                for ≈8 min; passes when it sees a fresh boot.
    │
    ▼
VPS cron (every 60s): /usr/local/sbin/poll-and-deploy.sh
    │  git fetch origin master
    │  new commit?  ──no──► exit 0 (no-op)
    │        │yes
    │        ▼
    │  deploy/deploy-with-rollback.sh:
    │    1. Tag current image as "atithi-setu:rollback"
    │    2. git reset --hard origin/master
    │    3. docker compose -f docker-compose.prod.yml up -d --build app
    │    4. Wait up to 120s for HTTP 200 on http://localhost:5001/api/public/restaurants
    │    5a. healthy   → new version stays live ✓
    │    5b. unhealthy → retag rollback image + restart → old version live ✓
    │    6. append outcome to /opt/atithi-setu/deploy-history.log
    ▼
Production updated (~2–4 min after push; ~10–20s swap downtime)
```

**Key point:** the GitHub Action **does not deploy** — the **VPS cron does**.
If the cron stops, nothing deploys even though pushes and the Action still run.

## Files

| File | Runs where | Role |
|---|---|---|
| `.github/workflows/deploy-vps.yml` | GitHub | Notifier + post-deploy verifier (polls `/api/version`). |
| `deploy/poll-and-deploy.sh` | VPS cron (every 60s) | Detects new `origin/master` commit → invokes the deploy script. |
| `deploy/deploy-with-rollback.sh` | VPS | Build + swap + health-check + auto-rollback. |
| `.github/workflows/deploy.yml` | GitHub | **Dormant** — old SSH push model on `main`. Leave disabled. |

## One-time VPS setup (pull model)

The VPS must have the repo cloned at `/opt/atithi-setu` on `master`, and the
cron poller installed:

```bash
ssh root@<VPS_IP>

# Repo present + on master
cd /opt/atithi-setu && git remote -v && git rev-parse --abbrev-ref HEAD   # → master

# Install the poller + cron (idempotent)
sudo cp /opt/atithi-setu/deploy/poll-and-deploy.sh /usr/local/sbin/
sudo chmod +x /usr/local/sbin/poll-and-deploy.sh /opt/atithi-setu/deploy/deploy-with-rollback.sh
( sudo crontab -l 2>/dev/null | grep -v poll-and-deploy; \
  echo "* * * * * /usr/local/sbin/poll-and-deploy.sh >/dev/null 2>&1" ) | sudo crontab -

# Verify it's installed
sudo crontab -l | grep poll-and-deploy
touch /opt/atithi-setu/poll-deploy.log /opt/atithi-setu/deploy-history.log
```

No GitHub secrets and no inbound SSH are required for the pull model.

## Verify a deploy went live

`/api/version` returns `booted_at` = the server process start time. After a
successful deploy it should be **seconds/minutes old**:

```bash
curl -s https://erp.atithi-setu.com/api/version | grep -o '"booted_at":"[^"]*"'
```

> `commit_marker` in that response is a **hardcoded string** in `server.ts`, not
> a git SHA — do not use it to judge freshness. Use `booted_at`.

## Troubleshooting — "I pushed but production didn't update"

Symptom: `booted_at` is hours/days old, and the `deploy-vps.yml` run shows
**Cancelled** (the verifier polled the full window and never saw a fresh boot).
**The Action is fine — the VPS deploy didn't run.** Diagnose on the VPS:

```bash
ssh root@<VPS_IP>
sudo crontab -l | grep poll-and-deploy               # 1. cron still installed? (often lost on reboot)
tail -60 /opt/atithi-setu/poll-deploy.log            # 2. is the poller running? errors?
tail -80 /opt/atithi-setu/deploy-history.log         # 3. did a deploy fail / roll back?
sudo fuser -v /var/lock/atithi-setu-deploy.lock      # 4. stale lock held by a hung deploy?
ps aux | grep -E 'deploy-with-rollback|docker compose' | grep -v grep
df -h / && docker ps                                 # 5. disk full (build fails) / container state
cd /opt/atithi-setu && git log --oneline -3 && git rev-parse origin/master   # 6. repo/branch state
```

Common causes:
- **Cron missing** (VPS rebooted, crontab not persisted) → reinstall (setup section above).
- **Stale lock** from a hung deploy → `sudo fuser -k /var/lock/atithi-setu-deploy.lock`.
- **Disk full** → `docker system prune -af`, then re-run.

Force a deploy immediately and watch it:

```bash
cd /opt/atithi-setu && sudo BRANCH=master FORCE=1 bash deploy/deploy-with-rollback.sh
curl -s https://erp.atithi-setu.com/api/version | grep -o '"booted_at":"[^"]*"'   # should be ~now
```

## Manual rollback to a specific commit

```bash
ssh root@<VPS_IP>
cd /opt/atithi-setu
git log --oneline | head -10          # pick the target SHA
git reset --hard <sha>
cd deploy && docker compose -f docker-compose.prod.yml up -d --build app
```

## Known limitations

1. **~10–20s swap downtime** during `docker compose up`. Low-concurrency B2B, tolerable. Blue-green + reverse proxy is the upgrade path.
2. **No separate migration step** — relies on the app's `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` forward-compatible pattern. Never drop a column an old version reads.
3. **Deploys lag a push by up to ~60s** (cron interval) + build time. Invisible in practice.
4. **Concurrency**: `flock` on the VPS + the workflow `concurrency` group prevent overlapping deploys.
5. **The verifier can time out** on a genuinely slow build (>~8 min) and warn even though the deploy later succeeds — check `booted_at`, not just the workflow badge.
