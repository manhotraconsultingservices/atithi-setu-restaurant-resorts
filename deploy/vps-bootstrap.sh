#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
# Atithi Setu — Production B VPS Bootstrap
# ══════════════════════════════════════════════════════════════════════
# Run this ONCE on a fresh Hetzner / Digital Ocean / Linode Ubuntu VPS
# after copying the dev-erp source folder to /opt/atithi-setu/.
#
#   cd /opt/atithi-setu
#   sudo bash deploy/vps-bootstrap.sh
#
# What it does:
#   1. Installs Docker + Docker Compose
#   2. Creates the upload volume directory
#   3. Sanity-checks .env exists and has the required keys
#   4. Starts Postgres, Node app and cloudflared via docker-compose.prod.yml
#   5. Waits for health, prints admin credentials and next steps
# ══════════════════════════════════════════════════════════════════════

set -euo pipefail

APP_DIR="/opt/atithi-setu"
DEPLOY_DIR="$APP_DIR/deploy"
COMPOSE_FILE="docker-compose.prod.yml"

cd "$DEPLOY_DIR" 2>/dev/null || {
  echo "❌ $DEPLOY_DIR not found. Copy the source to $APP_DIR first."
  exit 1
}

echo "═══════════════════════════════════════════════════════════════"
echo "  Atithi Setu — Production B bootstrap"
echo "  Working directory: $(pwd)"
echo "═══════════════════════════════════════════════════════════════"

# ── Step 1: Docker install ───────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo ""
  echo "→ Installing Docker (this takes ~2 min)…"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
else
  echo "✓ Docker already installed ($(docker --version))"
fi

# ── Step 2: .env sanity ──────────────────────────────────────────────
if [[ ! -f .env ]]; then
  echo "❌ .env not found in $(pwd). Copy .env.production.template to .env and fill it in."
  exit 1
fi

required=(JWT_SECRET PGPASSWORD CLOUDFLARED_TOKEN)
missing=()
for k in "${required[@]}"; do
  if ! grep -qE "^${k}=.+" .env; then missing+=("$k"); fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "❌ Missing required .env values: ${missing[*]}"
  echo "   Edit .env to fill these in, then rerun."
  exit 1
fi
echo "✓ .env has required keys"

# ── Step 3: Uploads directory ────────────────────────────────────────
mkdir -p "$APP_DIR/public/uploads"
chmod 755 "$APP_DIR/public/uploads"
echo "✓ public/uploads ready"

# ── Step 4: Build and start ──────────────────────────────────────────
echo ""
echo "→ Building and starting containers…"
# Compose is run from $DEPLOY_DIR, so .env lives here too (deploy/.env).
# The compose file references env_file: .env (alongside the compose file).
docker compose -f "$COMPOSE_FILE" up -d --build

# ── Step 5: Wait for health ──────────────────────────────────────────
echo ""
echo "→ Waiting for app to become healthy…"
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5001/api/public/restaurants || echo 000)
  if [[ "$code" == "200" ]]; then
    echo "✓ App is up — HTTP 200 in ${i}s"
    break
  fi
  sleep 1
done

if [[ "$code" != "200" ]]; then
  echo "⚠ App did not start cleanly. Check logs:"
  echo "  docker logs node_app"
  exit 1
fi

# ── Step 6: Cloudflared connector health ─────────────────────────────
echo ""
echo "→ Waiting for Cloudflare tunnel to register…"
sleep 8
if docker logs atithi-setu-tenants-cloudflared 2>&1 | grep -q "Registered tunnel"; then
  echo "✓ Cloudflare tunnel registered"
else
  echo "⚠ Tunnel not registered yet. Check: docker logs atithi-setu-tenants-cloudflared"
fi

# ── Step 7: Final info ───────────────────────────────────────────────
cat <<EOF

═══════════════════════════════════════════════════════════════════════
  ✅ Atithi Setu Production B is running
═══════════════════════════════════════════════════════════════════════

  Locally: http://localhost:5001
  Tunnel:  check Cloudflare dashboard → Zero Trust → Networks → Tunnels

  Default super-admin:
    Login ID: ADMIN-ANKUSH
    Password: admin123
    ⚠  CHANGE THIS PASSWORD before onboarding real customers.

  Next steps:
    1. In Cloudflare dashboard → atithi-setu-tenants tunnel →
       Public Hostnames: add a catch-all public hostname pointing to
       node_app:5001 (or one per tenant slug as they sign up).
    2. Add a DNS CNAME for each tenant:
          <slug>.atithi-setu.com  →  <tunnel-id>.cfargotunnel.com
       (Proxied, orange cloud)
    3. Admins reach the portal at /internal from any tenant subdomain.

  Common ops (run from $DEPLOY_DIR):
    docker compose -f $COMPOSE_FILE logs -f app
    docker compose -f $COMPOSE_FILE restart app
    docker compose -f $COMPOSE_FILE down
    docker compose -f $COMPOSE_FILE up -d --build

═══════════════════════════════════════════════════════════════════════
EOF
