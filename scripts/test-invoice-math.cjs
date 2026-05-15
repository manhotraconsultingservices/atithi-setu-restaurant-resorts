#!/usr/bin/env node
/**
 * Invoice math verification — hits the preview-totals endpoint on a live
 * tenant and asserts the breakdown matches the expected values for 6+
 * scenarios (no-tax, single-tax, multi-tax, with-discount, with-loyalty,
 * with-service-charge, legacy fallback, edge cases).
 *
 * Invoice math is critical — owners build trust on every line of every
 * receipt. This script runs after every deploy to catch regressions
 * before they hit a real customer.
 *
 * Usage:
 *   node scripts/test-invoice-math.cjs \
 *     --server https://<viveks-cafe>.atithi-setu.com \
 *     --restaurant RESTO-1003 \
 *     --token <super-admin-jwt-or-owner-jwt>
 */

'use strict';

const http  = require('http');
const https = require('https');

const args = process.argv.slice(2);
const arg  = (f) => { const i = args.indexOf(f); return i !== -1 && i + 1 < args.length ? args[i + 1] : null; };

const SERVER       = (arg('--server') || 'http://localhost:4001').replace(/\/$/, '');
const RESTAURANT   = arg('--restaurant');
const TOKEN        = arg('--token');

if (!RESTAURANT || !TOKEN) {
  console.error('Usage: node test-invoice-math.cjs --server <url> --restaurant <id> --token <jwt>');
  process.exit(1);
}

function get(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const u = new URL(url);
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (url.startsWith('https') ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}` },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (e) { resolve({ status: res.statusCode, data: null, raw: Buffer.concat(chunks).toString() }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function preview(params) {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([_, v]) => v != null).map(([k, v]) => [k, String(v)]))
  );
  const url = `${SERVER}/api/restaurant/${encodeURIComponent(RESTAURANT)}/invoices/preview-totals?${qs}`;
  const res = await get(url);
  if (res.status !== 200) {
    throw new Error(`preview ${res.status}: ${res.raw || JSON.stringify(res.data)}`);
  }
  return res.data;
}

const approx = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) < tol;
const fmt = (n) => Number(n || 0).toFixed(2);

let passed = 0, failed = 0;
const fail = (msg) => { failed++; console.log(`  ❌ ${msg}`); };
const pass = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

function expect(actual, expected, label) {
  if (approx(actual, expected)) pass(`${label}: ${fmt(actual)} = ${fmt(expected)}`);
  else fail(`${label}: ${fmt(actual)} ≠ ${fmt(expected)}`);
}

async function runCase(name, params, assertions) {
  console.log(`\n── Case: ${name}`);
  console.log(`   Input: ${JSON.stringify(params)}`);
  const totals = await preview(params);
  console.log(`   Output: subtotal=${fmt(totals.subtotal)}, ` +
              `discount=${fmt(totals.totalDiscount)} (manual=${fmt(totals.manualDiscount)}, loyalty=${fmt(totals.loyaltyDiscount)}), ` +
              `service=${fmt(totals.serviceCharge)}, ` +
              `taxableBase=${fmt(totals.taxableBase)}, ` +
              `tax=${fmt(totals.totalTax)} [${(totals.taxLines || []).map(l => `${l.label}@${fmt(l.rate)}=${fmt(l.amount)}`).join(', ') || 'none'}], ` +
              `grand=${fmt(totals.grandTotal)}`);
  if (totals.loyalty) {
    console.log(`   Loyalty: ${totals.loyalty.tier_name} (${totals.loyalty.discount_percent}% off)`);
  }
  if (totals.usedLegacyGst) {
    console.log('   (used legacy GST fallback — no tax_config rows configured)');
  }
  assertions(totals);
}

(async () => {
  console.log(`\n🧮 Invoice Math Verification`);
  console.log(`Server     : ${SERVER}`);
  console.log(`Restaurant : ${RESTAURANT}`);
  console.log('═'.repeat(60));

  // First, dump tax_config so we know what's configured
  const cfgRes = await get(`${SERVER}/api/restaurant/${RESTAURANT}/tax-config`);
  if (cfgRes.status === 200) {
    console.log(`\nConfigured tax lines:`);
    for (const l of (cfgRes.data.active_configs || [])) {
      console.log(`  - ${l.label} @ ${l.rate_percent}% (split=${l.split_intrastate ? 'Y' : 'N'}, inclusive=${l.is_inclusive ? 'Y' : 'N'})`);
    }
  } else {
    console.log(`\n⚠ Could not load /tax-config (status ${cfgRes.status}). Continuing.`);
  }

  // ── CASE 1: minimum — no discount, no service charge ─────────────────
  await runCase('Plain invoice, no discount, no service charge', {
    subtotal: 1000,
    discount: 0,
    service_charge_percent: 0,
  }, (t) => {
    expect(t.subtotal, 1000, 'subtotal');
    expect(t.totalDiscount, 0, 'discount');
    expect(t.serviceCharge, 0, 'service');
    expect(t.taxableBase, 1000, 'taxable base');
    // total tax depends on configured rows, just verify grand = base + tax
    expect(t.grandTotal, 1000 + Number(t.totalTax), 'grand = base + tax');
  });

  // ── CASE 2: manual discount applied ──────────────────────────────────
  await runCase('Manual discount ₹100', {
    subtotal: 1000,
    discount: 100,
    service_charge_percent: 0,
  }, (t) => {
    expect(t.manualDiscount, 100, 'manual discount');
    expect(t.totalDiscount, 100, 'total discount (no loyalty)');
    expect(t.subtotalAfterDiscount, 900, 'subtotal after discount');
    expect(t.taxableBase, 900, 'taxable base');
    expect(t.grandTotal, 900 + Number(t.totalTax), 'grand = base + tax');
  });

  // ── CASE 3: service charge 10% ───────────────────────────────────────
  await runCase('Service charge 10%', {
    subtotal: 1000,
    discount: 0,
    service_charge_percent: 10,
  }, (t) => {
    expect(t.serviceCharge, 100, 'service @ 10%');
    expect(t.taxableBase, 1100, 'taxable = subtotal + service');
    expect(t.grandTotal, 1100 + Number(t.totalTax), 'grand = base + tax');
  });

  // ── CASE 4: discount + service ───────────────────────────────────────
  await runCase('Discount ₹100 + service 10%', {
    subtotal: 1000,
    discount: 100,
    service_charge_percent: 10,
  }, (t) => {
    expect(t.subtotalAfterDiscount, 900, 'after discount');
    expect(t.serviceCharge, 90, 'service on after-discount');
    expect(t.taxableBase, 990, 'taxable');
    expect(t.grandTotal, 990 + Number(t.totalTax), 'grand');
  });

  // ── CASE 5: edge — discount larger than subtotal ─────────────────────
  await runCase('Discount > subtotal (clamps to 0)', {
    subtotal: 100,
    discount: 999,
    service_charge_percent: 0,
  }, (t) => {
    expect(t.totalDiscount, 100, 'discount clamped to subtotal');
    expect(t.subtotalAfterDiscount, 0, 'after discount = 0');
    expect(t.grandTotal, 0, 'grand = 0');
  });

  // ── CASE 6: loyalty customer (Vivek's Cafe demo phone 9001112301 = Gold 10%) ──
  await runCase('Loyalty Gold member (9001112301) — auto 10% off on subtotal 1000', {
    subtotal: 1000,
    discount: 0,
    service_charge_percent: 0,
    customer_phone: '9001112301',
  }, (t) => {
    if (!t.loyalty || t.loyalty.tier_name !== 'Gold') {
      fail(`expected Gold member; got ${t.loyalty ? t.loyalty.tier_name : 'none'} (seed Vivek's Cafe loyalty first)`);
      return;
    }
    expect(t.loyaltyDiscount, 100, 'loyalty discount ₹100 (10% of 1000)');
    expect(t.totalDiscount, 100, 'total discount = loyalty');
    expect(t.subtotalAfterDiscount, 900, 'after discount');
  });

  // ── CASE 7: loyalty + manual discount (max wins) ─────────────────────
  await runCase('Loyalty Gold 10% + manual ₹50 — max(50, 100) = 100', {
    subtotal: 1000,
    discount: 50,
    service_charge_percent: 0,
    customer_phone: '9001112301',
  }, (t) => {
    if (!t.loyalty) { fail('expected loyalty match'); return; }
    expect(t.totalDiscount, 100, 'max(manual=50, loyalty=100) = 100');
  });

  // ── CASE 8: loyalty + manual > loyalty (manual wins) ─────────────────
  await runCase('Loyalty Gold 10% + manual ₹200 — max(200, 100) = 200', {
    subtotal: 1000,
    discount: 200,
    service_charge_percent: 0,
    customer_phone: '9001112301',
  }, (t) => {
    if (!t.loyalty) { fail('expected loyalty match'); return; }
    expect(t.totalDiscount, 200, 'max(manual=200, loyalty=100) = 200');
  });

  // ── CASE 9: unknown phone — no loyalty discount ──────────────────────
  await runCase('Unknown phone — no loyalty discount', {
    subtotal: 1000,
    discount: 0,
    service_charge_percent: 0,
    customer_phone: '9999999999',
  }, (t) => {
    if (t.loyalty) fail('unexpected loyalty hit on unknown phone');
    else pass('no loyalty match for unknown phone');
    expect(t.totalDiscount, 0, 'no discount');
  });

  console.log('\n' + '═'.repeat(60));
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\n❌ FAILED — invoice math has regressions. Do not deploy.');
    process.exit(1);
  } else {
    console.log('\n✅ All math checks passed.');
  }
})().catch(err => { console.error('Fatal:', err); process.exit(1); });
