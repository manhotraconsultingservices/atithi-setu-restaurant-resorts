#!/usr/bin/env node
/**
 * Atithi-Setu — Hotel E2E Demo Seed
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Populates a tenant with production-shaped hotel data for end-to-end QA:
 *   • 8 rooms across 3 room types (Standard / Premium / Suite)
 *   • 10 bookings spanning every status (CHECKED_OUT, CHECKED_IN, BOOKED,
 *     CANCELLED) — including 3 foreign guests to exercise Form-C / FRRO
 *   • Folios with realistic line items (room nights, services, F&B)
 *   • 5 active service requests (PENDING / ACKNOWLEDGED / IN_PROGRESS /
 *     DELIVERED) so the SERVICE_REQUESTS tab has live ops to manage
 *   • Re-uses customers from the loyalty seed so the unified-loyalty
 *     flow (Hotel folio counts toward tier) is testable
 *
 * Pre-req: Hotel module must be enabled on the tenant. Enable via the
 * SuperAdmin tenant card — "Hotel: OFF" → confirm. The seed will refuse
 * if property_type is still RESTAURANT.
 *
 * ── Auth modes (same shape as seed-loyalty-vivek.cjs) ────────────────────────
 *
 *  Super Admin (typical — hotel module activation needs admin anyway):
 *    node scripts/seed-hotel-vivek.cjs \
 *      --admin-login ADMIN-ANKUSH --admin-password <pwd> \
 *      --restaurant RESTO-1003 \
 *      --server https://erp.atithi-setu.com
 *
 *  Token (copy JWT from browser DevTools):
 *    node scripts/seed-hotel-vivek.cjs --token <jwt> \
 *      --restaurant RESTO-1003 \
 *      --server https://erp.atithi-setu.com
 *
 * ── Options ──────────────────────────────────────────────────────────────────
 *   --server          Server base URL (default http://localhost:4001)
 *   --restaurant      Restaurant ID (required)
 *   --dry-run         Show what would happen, don't hit the API
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 * Every seeded row has id prefix SEED-HOTEL-…  Re-running ON CONFLICT
 * DO NOTHING — re-run is safe. To wipe and start fresh:
 *
 *   DELETE FROM service_requests WHERE id LIKE 'SEED-HOTEL-%';
 *   DELETE FROM folio_entries    WHERE folio_id LIKE 'SEED-HOTEL-%';
 *   DELETE FROM folios           WHERE id LIKE 'SEED-HOTEL-%';
 *   DELETE FROM room_bookings    WHERE id LIKE 'SEED-HOTEL-%';
 *   DELETE FROM rooms            WHERE id LIKE 'SEED-HOTEL-%';
 */

'use strict';

const http  = require('http');
const https = require('https');

const args    = process.argv.slice(2);
const arg     = (flag) => { const i = args.indexOf(flag); return i !== -1 && i + 1 < args.length ? args[i + 1] : null; };
const hasFlag = (flag) => args.includes(flag);

if (hasFlag('--help')) {
  console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]);
  process.exit(0);
}

const SERVER         = (arg('--server') || 'http://localhost:4001').replace(/\/$/, '');
const RESTAURANT_ARG = arg('--restaurant');
const DRY_RUN        = hasFlag('--dry-run');
const TOKEN_ARG      = arg('--token');
const ADMIN_LOGIN    = arg('--admin-login');
const ADMIN_PASSWORD = arg('--admin-password');

const authMode =
  TOKEN_ARG                          ? 'token'      :
  ADMIN_LOGIN && ADMIN_PASSWORD      ? 'superadmin' :
  null;

if (!authMode) {
  console.error('No authentication provided. Run with --help for usage.');
  process.exit(1);
}
if (!RESTAURANT_ARG) {
  console.error('--restaurant is required (the tenant id, e.g. RESTO-1003).');
  process.exit(1);
}

function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const lib    = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const req    = lib.request({
      hostname: parsed.hostname,
      port    : parsed.port || (url.startsWith('https') ? 443 : 80),
      path    : parsed.pathname + parsed.search,
      method  : options.method || 'GET',
      headers : options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function jsonReq(method, url, token, body) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
  };
  const res = await request(url, opts, body ? JSON.stringify(body) : null);
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch {}
  return { status: res.status, data: parsed, raw: res.body };
}

async function authenticate() {
  if (authMode === 'token') return { token: TOKEN_ARG };
  const r = await jsonReq('POST', `${SERVER}/api/admin/login`, null, {
    loginId: ADMIN_LOGIN, password: ADMIN_PASSWORD,
  });
  if (r.status !== 200 || !r.data?.token) {
    throw new Error(`Super-admin login failed (${r.status}): ${r.raw}`);
  }
  return { token: r.data.token };
}

(async () => {
  console.log(`\n  Atithi-Setu — Hotel E2E Demo Seed`);
  console.log(`  server     : ${SERVER}`);
  console.log(`  restaurant : ${RESTAURANT_ARG}`);
  console.log(`  auth mode  : ${authMode}\n`);

  if (DRY_RUN) {
    console.log('  DRY-RUN — would POST to:');
    console.log(`     ${SERVER}/api/admin/restaurant/${RESTAURANT_ARG}/hotel/seed-demo`);
    console.log(`     body: { "confirm": "YES" }`);
    process.exit(0);
  }

  try {
    const { token } = await authenticate();
    const r = await jsonReq(
      'POST',
      `${SERVER}/api/admin/restaurant/${RESTAURANT_ARG}/hotel/seed-demo`,
      token,
      { confirm: 'YES' }
    );
    if (r.status !== 200) {
      console.error(`\n  Seed failed (${r.status}):`);
      console.error('  ', r.data?.error || r.raw);
      process.exit(1);
    }
    console.log('  ✓ Seed succeeded:\n');
    console.log(`     Rooms        : ${r.data.rooms_seeded}`);
    console.log(`     Bookings     : ${r.data.bookings_seeded}`);
    console.log(`     Folios       : ${r.data.folios_seeded}`);
    console.log(`     Folio entries: ${r.data.entries_seeded}`);
    console.log(`     Service rqs  : ${r.data.srs_seeded}`);
    console.log('');
    console.log('  Next steps:');
    for (const s of (r.data.next_steps || [])) console.log(`    • ${s}`);
    console.log('');
  } catch (err) {
    console.error('\n  Error:', err.message || err);
    process.exit(1);
  }
})();
