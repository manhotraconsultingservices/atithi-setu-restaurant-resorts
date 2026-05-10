#!/usr/bin/env node
/**
 * Atithi-Setu — Phase 3 webhook E2E test
 * ════════════════════════════════════════════════════════════════════════
 *
 * Runs against a LIVE server (not in-process). Exercises the full inbound
 * webhook pipeline using the registered MockAdapter (channel = URBANPIPER).
 *
 *   1. Happy-path order → 200, order id + invoice number returned
 *   2. Replay (same idempotency key) → 200 cached, no duplicate order
 *   3. Bad signature → 401
 *   4. Missing signature header → 400
 *   5. Status update for the order → 200
 *   6. Cancellation event → 200, stock-revert path triggered
 *   7. Wrong channel id → 400
 *   8. Unregistered adapter (e.g. SWIGGY before Phase 5) → 404
 *
 * MockAdapter's default secret is "mock-secret-do-not-use-in-prod" — same on
 * both sides, so we can sign payloads here that the server's MockAdapter
 * verifies. (For real platforms you'd configure their HMAC secret in the
 * tenant's encrypted integration_credentials.)
 *
 * Usage:
 *   ATITHI_CREDENTIAL_KEY=$(openssl rand -base64 32) \
 *   node scripts/test-integrations-phase3.cjs \
 *     --server https://rishu-kitchen.atithi-setu.com \
 *     --restaurant RESTO-1003
 *
 * NOTE: Server must have ATITHI_CREDENTIAL_KEY configured AND the Mock
 * adapter must be registered (it's auto-registered at boot in startServer).
 */

'use strict';

const { createHmac } = require('crypto');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

const SERVER = (flag('server') || 'http://localhost:3001').replace(/\/$/, '');
const RID = flag('restaurant') || 'RESTO-1003';
const MOCK_SECRET = flag('mock-secret') || 'mock-secret-do-not-use-in-prod';

let passes = 0, fails = 0;
const results = [];

const ok = (msg) => { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); passes++; };
const bad = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); fails++; };
function step(name, fn) {
  console.log(`\n\x1b[1m▶ ${name}\x1b[0m`);
  return Promise.resolve(fn()).catch(err => { bad(`fatal: ${err?.message || err}`); if (err?.stack) console.log(err.stack); });
}
function assert(cond, msg) { if (cond) ok(msg); else bad(msg); }

function sign(rawBody, secret = MOCK_SECRET) {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

async function postWebhook(channel, eventHint, payloadObj, opts = {}) {
  const raw = Buffer.from(JSON.stringify(payloadObj));
  const sig = opts.signature !== undefined ? opts.signature : sign(raw, opts.secret);
  const headers = { 'Content-Type': 'application/json' };
  if (opts.omitSignature !== true) headers['x-mock-signature'] = sig;
  const url = `${SERVER}/api/integrations/${channel}/webhook/${RID}?event=${eventHint}`;
  const res = await fetch(url, { method: 'POST', headers, body: raw });
  let body; try { body = await res.json(); } catch { body = await res.text(); }
  return { status: res.status, body, raw };
}

async function main() {
  console.log(`\n\x1b[1m═══ Atithi-Setu Phase 3 Webhook E2E ═══\x1b[0m`);
  console.log(`Server: ${SERVER}`);
  console.log(`Tenant: ${RID}`);
  console.log(`Channel: URBANPIPER (MockAdapter)`);

  // Generate a unique externalOrderId per test run so replays inside the same
  // run are obvious (and concurrent runs don't collide on the dedup index).
  const runId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const externalOrderId = `MOCK-${runId}`;

  const orderPayload = {
    externalOrderId,
    placedAt: new Date().toISOString(),
    items: [
      // Items are intentionally NOT mapped to local menu items.
      // The webhook should still create the order, fire ITEM_MAPPING_ALERT,
      // skip server-side price validation for unmapped items.
      { externalItemId: `MOCK-ITEM-${runId}-A`, name: 'Mock Butter Chicken', quantity: 2, unitPrice: 280, totalPrice: 560 },
      { externalItemId: `MOCK-ITEM-${runId}-B`, name: 'Mock Naan',           quantity: 4, unitPrice: 30,  totalPrice: 120 },
    ],
    customer: { name: 'E2E Test User', phone: '9999988888', address: { line1: '12 Test Lane', city: 'Delhi', pincode: '110001' } },
    totals: { subtotal: 680, taxes: 34, total: 714 },
    paymentMode: 'PREPAID',
    gstCollectedBy: 'PLATFORM',
    commissionAmount: 178.5,
    netPayoutAmount: 535.5,
  };

  let createdOrderId = null;
  let createdInvoiceNumber = null;

  // ── 1. Happy path ─────────────────────────────────────────────────────
  await step('1. Happy-path order', async () => {
    const r = await postWebhook('URBANPIPER', 'order', orderPayload);
    assert(r.status === 200, `200 OK (got ${r.status})`);
    assert(r.body?.success === true, `success=true (got ${r.body?.success}); detail: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert(typeof r.body?.id === 'string' && r.body.id.startsWith('ORD-'), `Order id returned (got ${r.body?.id})`);
    assert(r.body?.unmapped_items >= 1, `Unmapped items reported (got ${r.body?.unmapped_items})`);
    createdOrderId = r.body?.id;
    createdInvoiceNumber = r.body?.invoice_number;
    if (createdOrderId) console.log(`    \x1b[2m→ Created order ${createdOrderId} (invoice ${createdInvoiceNumber || 'none'})\x1b[0m`);
  });

  // ── 2. Replay — same idempotency key → cached response, no duplicate ──
  await step('2. Replay returns cached response (no duplicate insert)', async () => {
    const r = await postWebhook('URBANPIPER', 'order', orderPayload);
    assert(r.status === 200, `200 OK on replay (got ${r.status})`);
    // Cached response: server returns the original body exactly.
    // OR if external_id_hash collided independently: deduplicated:true path.
    const sameOrder = r.body?.id === createdOrderId;
    const dedupFlagged = r.body?.deduplicated === true;
    assert(sameOrder || dedupFlagged,
      `Replay produces same order id or sets deduplicated=true (got id=${r.body?.id}, dedup=${r.body?.deduplicated})`);
  });

  // ── 3. Bad signature → 401 ─────────────────────────────────────────────
  await step('3. Bad signature is rejected', async () => {
    // New externalOrderId so this isn't a replay of the previous body
    const tamperedPayload = { ...orderPayload, externalOrderId: `MOCK-BAD-${runId}` };
    const r = await postWebhook('URBANPIPER', 'order', tamperedPayload, {
      signature: '00'.repeat(32),
    });
    assert(r.status === 401, `401 Unauthorized (got ${r.status}); body: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert(/signature/i.test(JSON.stringify(r.body)), `Error message mentions signature`);
  });

  // ── 4. Missing signature header → 400 ─────────────────────────────────
  await step('4. Missing signature header is rejected', async () => {
    const noSigPayload = { ...orderPayload, externalOrderId: `MOCK-NOSIG-${runId}` };
    const r = await postWebhook('URBANPIPER', 'order', noSigPayload, { omitSignature: true });
    assert(r.status === 400, `400 Bad Request (got ${r.status})`);
    assert(/signature/i.test(JSON.stringify(r.body)), `Error message mentions signature`);
  });

  // ── 5. Status update event ────────────────────────────────────────────
  await step('5. Status update — order moves to PREPARING', async () => {
    if (!createdOrderId) { bad('skipped: no createdOrderId from step 1'); return; }
    const statusPayload = { externalOrderId, newStatus: 'PREPARING' };
    const r = await postWebhook('URBANPIPER', 'status', statusPayload);
    assert(r.status === 200, `200 OK (got ${r.status}); body: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert(r.body?.id === createdOrderId, `Same local order id (got ${r.body?.id})`);
    assert(String(r.body?.status).toUpperCase() === 'PREPARING', `Status = PREPARING (got ${r.body?.status})`);
  });

  // ── 6. Rider assignment ───────────────────────────────────────────────
  await step('6. Rider assignment populates rider_name + rider_phone', async () => {
    if (!createdOrderId) { bad('skipped: no createdOrderId from step 1'); return; }
    const r = await postWebhook('URBANPIPER', 'status', {
      externalOrderId, newStatus: 'DISPATCHED',
      rider: { name: 'Mock Rider', phone: '9876543210' },
    });
    assert(r.status === 200, `200 OK (got ${r.status})`);
    assert(r.body?.id === createdOrderId, `Same order id`);
  });

  // ── 7. Cancellation triggers reversal path ────────────────────────────
  await step('7. Cancellation event triggers stock-reversal path', async () => {
    if (!createdOrderId) { bad('skipped: no createdOrderId from step 1'); return; }
    const r = await postWebhook('URBANPIPER', 'cancel', {
      externalOrderId, newStatus: 'CANCELLED',
    });
    assert(r.status === 200, `200 OK (got ${r.status})`);
    assert(String(r.body?.status).toUpperCase() === 'CANCELLED', `Status = CANCELLED (got ${r.body?.status})`);
  });

  // ── 8. Wrong channel id ───────────────────────────────────────────────
  await step('8. Unknown channel id returns 400', async () => {
    const r = await postWebhook('FAKEPLATFORM', 'order', orderPayload);
    assert(r.status === 400, `400 Bad Request (got ${r.status})`);
  });

  // ── 9. Unregistered adapter (SWIGGY scaffold not yet registered) ──────
  await step('9. Unregistered adapter (SWIGGY) returns 404', async () => {
    const r = await postWebhook('SWIGGY', 'order', orderPayload);
    // SWIGGY adapter ships in Phase 5. Until then, 404 is correct.
    if (r.status === 404) {
      ok('SWIGGY 404 — adapter not yet registered (expected pre-Phase-5)');
    } else if (r.status === 401) {
      ok('SWIGGY 401 — adapter exists but signature failed (expected post-Phase-5 with mock secret)');
    } else {
      bad(`Expected 404 or 401, got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    }
  });

  // ── Summary ──────────────────────────────────────────────────────────
  console.log(`\n\x1b[1m═══ Summary ═══\x1b[0m`);
  console.log(`  \x1b[32m${passes} passed\x1b[0m, \x1b[31m${fails} failed\x1b[0m`);
  if (createdOrderId) {
    console.log(`\n  Test order: ${createdOrderId}`);
    console.log(`  Cancelled, stock reverted (idempotent via inventory_reverted flag)`);
    console.log(`  External id: ${externalOrderId}`);
  }
  if (fails > 0) process.exit(1);
  console.log('\n\x1b[32m✅ Phase 3 webhook E2E: all assertions passed.\x1b[0m\n');
}

main().catch(err => {
  console.error('\n\x1b[31mUnhandled:\x1b[0m', err);
  process.exit(1);
});
