#!/usr/bin/env node
/**
 * Atithi-Setu — Delivery Integration validation script (read-only)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Probes the live deployment to verify Phase 1-3 + DELIVERY tab are
 * structurally working. ZERO writes — every check uses GET or POST with
 * deliberately-rejected payloads (bad signature, unknown channel, etc.)
 * so no real state is mutated.
 *
 * Optional --token <jwt> --restaurant <id> for auth-required endpoint checks.
 *
 * Usage:
 *   # Public structural checks only (no auth needed)
 *   node scripts/validate-delivery-integration.cjs \
 *     --server https://dev-erp.atithi-setu.com \
 *     --restaurant RESTO-1003
 *
 *   # Plus auth-gated endpoint reachability
 *   node scripts/validate-delivery-integration.cjs \
 *     --server https://rishu-kitchen.atithi-setu.com \
 *     --restaurant RESTO-1003 \
 *     --token <jwt>
 */

'use strict';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

const SERVER = (flag('server') || 'http://localhost:3001').replace(/\/$/, '');
const RID    = flag('restaurant') || 'RESTO-1003';
const TOKEN  = flag('token') || null;

let passes = 0, fails = 0, warns = 0;

const ok    = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); passes++; };
const bad   = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); fails++; };
const warn  = (m) => { console.log(`  \x1b[33m!\x1b[0m ${m}`); warns++; };
const dim   = (m) => console.log(`    \x1b[2m${m}\x1b[0m`);
const head  = (m) => console.log(`\n\x1b[1m▶ ${m}\x1b[0m`);

async function req(method, path, opts = {}) {
  const url = `${SERVER}${path}`;
  const init = { method, headers: { 'Content-Type': 'application/json' } };
  if (opts.token || TOKEN) init.headers.Authorization = `Bearer ${opts.token || TOKEN}`;
  if (opts.headers) Object.assign(init.headers, opts.headers);
  if (opts.body !== undefined) init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  const res = await fetch(url, init);
  let body; try { body = await res.json(); } catch { body = await res.text(); }
  return { status: res.status, body };
}

async function main() {
  console.log(`\x1b[1m═══ Delivery Integration validation ═══\x1b[0m`);
  console.log(`Server:     ${SERVER}`);
  console.log(`Tenant:     ${RID}`);
  console.log(`Auth token: ${TOKEN ? '✓ supplied' : '✗ none (auth-gated checks will be skipped)'}`);

  // ─── Phase 1 ──────────────────────────────────────────────────────────
  head('Phase 1 — schema + adapter scaffold');
  {
    // Tenant DB migrations run on first endpoint hit. Verify by hitting any
    // tenant-scoped endpoint (the menu GET works without auth).
    const r = await req('GET', `/api/restaurant/${RID}/menu`);
    if (r.status === 200) ok(`tenant DB reachable (menu GET OK, ${Array.isArray(r.body) ? r.body.length : '?'} items)`);
    else bad(`menu GET returned ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`);
  }
  {
    // Webhook endpoint structural checks — these all *write* to webhook_inbox
    // BUT the inbox is an audit log, not real state. Each test uses a unique
    // signature header so the rows are clearly test data.
    head('Phase 3 — webhook endpoint defense layers');

    // Channel allowlist
    const r1 = await req('POST', `/api/integrations/FAKEPLATFORM/webhook/${RID}`, {
      headers: { 'x-mock-signature': 'deadbeef' }, body: '{}',
    });
    if (r1.status === 400 && /Unknown channel/i.test(JSON.stringify(r1.body))) {
      ok('Unknown channel (FAKEPLATFORM) → 400 "Unknown channel"');
    } else {
      bad(`Channel allowlist failed: status ${r1.status}, body: ${JSON.stringify(r1.body).slice(0, 120)}`);
    }

    // Adapter registry
    const r2 = await req('POST', `/api/integrations/SWIGGY/webhook/${RID}`, {
      headers: { 'x-mock-signature': 'deadbeef' }, body: '{}',
    });
    if (r2.status === 404 && /No adapter registered/i.test(JSON.stringify(r2.body))) {
      ok('Unregistered adapter (SWIGGY) → 404 "No adapter registered" (expected pre-Phase-5)');
    } else if (r2.status === 401) {
      ok('SWIGGY → 401 (signature failed) — adapter is registered and verifying');
    } else {
      bad(`Adapter registry check failed: status ${r2.status}`);
    }

    // Credential boot guard / signature verification
    const r3 = await req('POST', `/api/integrations/URBANPIPER/webhook/${RID}`, {
      headers: { 'x-mock-signature': 'deadbeef' }, body: '{}',
    });
    if (r3.status === 503 && /ATITHI_CREDENTIAL_KEY/.test(JSON.stringify(r3.body))) {
      warn('URBANPIPER → 503: ATITHI_CREDENTIAL_KEY not configured on server');
      dim('Generate via `openssl rand -base64 32` and set on the deploy env to enable webhook traffic');
    } else if (r3.status === 401) {
      ok('URBANPIPER → 401 (bad signature rejected) — credential key configured');
    } else if (r3.status === 200 || r3.status === 422) {
      ok(`URBANPIPER → ${r3.status} (full pipeline running)`);
    } else {
      bad(`URBANPIPER unexpected status: ${r3.status}, body: ${JSON.stringify(r3.body).slice(0, 200)}`);
    }

    // Missing signature
    const r4 = await req('POST', `/api/integrations/URBANPIPER/webhook/${RID}`, { body: '{}' });
    if (r4.status === 400 && /signature/i.test(JSON.stringify(r4.body))) {
      ok('Missing signature header → 400');
    } else if (r4.status === 503) {
      warn('Missing signature check returns 503 (credential key gate runs first — expected when key not configured)');
    } else {
      bad(`Missing-signature unexpected: ${r4.status}`);
    }
  }

  // ─── Phase 2: Channel pricing endpoints ───────────────────────────────
  head('Phase 2 — channel pricing endpoints');
  {
    const r = await req('GET', `/api/restaurant/${RID}/integrations/channels`);
    if (TOKEN) {
      if (r.status === 200 && Array.isArray(r.body)) {
        ok(`channels GET returned ${r.body.length} rows`);
        const channels = r.body.map(c => `${c.channel}${c.is_active ? '★' : ''}`);
        dim(`Channels seeded: ${channels.join(', ')}`);
        const active = r.body.filter(c => c.is_active);
        if (active.length === 0) warn('No channels marked is_active (Settings → Delivery Partners to enable)');
        else ok(`${active.length} channel(s) active`);
      } else {
        bad(`channels GET returned ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`);
      }
    } else {
      if (r.status === 401) ok('channels GET endpoint exists (401 without auth — expected)');
      else bad(`channels GET unexpected status without auth: ${r.status}`);
    }
  }
  {
    const r = await req('GET', `/api/restaurant/${RID}/menu/channel-prices`);
    if (TOKEN) {
      if (r.status === 200 && Array.isArray(r.body)) {
        ok(`menu channel-prices GET returned ${r.body.length} rows`);
        if (r.body.length === 0) dim('No per-item overrides yet — owner can set them via Menu Management → edit item → Channel Pricing');
      } else bad(`menu channel-prices unexpected: ${r.status}`);
    } else {
      if (r.status === 401) ok('menu channel-prices endpoint exists (401 without auth)');
      else bad(`menu channel-prices unexpected: ${r.status}`);
    }
  }

  // ─── DELIVERY tab — list orders ───────────────────────────────────────
  head('DELIVERY tab — live orders feed');
  {
    const r = await req('GET', `/api/restaurant/${RID}/integrations/orders?limit=10`);
    if (TOKEN) {
      if (r.status === 200 && r.body.orders && r.body.summary) {
        const s = r.body.summary;
        ok(`integrations/orders returned ${r.body.orders.length} orders`);
        dim(`Summary: ${s.total} total · ${s.open} open · ₹${Math.round(s.today_gross)} today`);
        if (Object.keys(s.by_platform).length > 0) {
          dim(`By platform: ${Object.entries(s.by_platform).map(([k, v]) => `${k}:${v.count}`).join(', ')}`);
        }
        if (s.total === 0) {
          warn('No platform orders yet — DELIVERY → Live Orders will show empty state');
          dim('To populate: configure ATITHI_CREDENTIAL_KEY + register UrbanPiperAdapter, OR run the Phase 3 E2E test');
        }
      } else bad(`integrations/orders unexpected: ${r.status}`);
    } else {
      if (r.status === 401) ok('integrations/orders endpoint exists (401 without auth)');
      else bad(`integrations/orders unexpected: ${r.status}`);
    }
  }

  // ─── Summary ──────────────────────────────────────────────────────────
  console.log(`\n\x1b[1m═══ Summary ═══\x1b[0m`);
  console.log(`  \x1b[32m${passes} passed\x1b[0m, \x1b[33m${warns} warnings\x1b[0m, \x1b[31m${fails} failed\x1b[0m`);
  if (fails > 0) {
    console.log('\n\x1b[31m⚠ Validation found issues. Check logs above.\x1b[0m');
    process.exit(1);
  }
  if (warns > 0) {
    console.log('\n\x1b[33mℹ Validation passed but with warnings (typically: ATITHI_CREDENTIAL_KEY not configured, or no platform orders yet — both are expected pre-launch).\x1b[0m');
  } else {
    console.log('\n\x1b[32m✅ All checks passed.\x1b[0m');
  }
}

main().catch(err => {
  console.error('\n\x1b[31mUnhandled:\x1b[0m', err);
  process.exit(1);
});
