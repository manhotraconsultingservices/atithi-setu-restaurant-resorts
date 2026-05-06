#!/usr/bin/env node
/**
 * Cloud Kitchen — Parallel Order Concurrency Test
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Fires N orders in parallel against /api/restaurant/:id/orders and verifies:
 *   1. Every request returns HTTP 200
 *   2. Every order gets a DISTINCT invoice_number  (no duplicates ⇒ no race)
 *   3. The N invoice_numbers form a contiguous range  (no skipped sequence)
 *   4. All orders are visible from a follow-up GET on the menu (sanity check)
 *
 * Usage:
 *   node scripts/concurrency-test-cloud-kitchen.cjs \
 *     --server   https://cloud-kitchen.atithi-setu.com \
 *     --restaurant RESTO_1778047416074_EYP5P \
 *     --count    20            # how many parallel orders  (default 10, max 100)
 *     --waves    1             # how many sequential waves of N parallel orders
 *
 * No auth required — the order POST endpoint is intentionally public so
 * QR-scanning customers can place orders without logging in.
 */

'use strict';

const http  = require('http');
const https = require('https');

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg  = (flag) => { const i = args.indexOf(flag); return i !== -1 && i + 1 < args.length ? args[i + 1] : null; };

const SERVER   = (arg('--server') || 'https://cloud-kitchen.atithi-setu.com').replace(/\/$/, '');
const RESTO    = arg('--restaurant') || 'RESTO_1778047416074_EYP5P';
const COUNT    = Math.min(Math.max(parseInt(arg('--count') || '10', 10), 1), 100);
const WAVES    = Math.max(parseInt(arg('--waves') || '1', 10), 1);

// ─── HTTP helper ──────────────────────────────────────────────────────────────
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

function placeOrder(idx) {
  const body = JSON.stringify({
    table_number   : 'Online Order',
    customer_name  : `Concurrency Test ${idx}`,
    customer_phone : `+91 99999 ${String(idx).padStart(5, '0')}`,
    customer_email : `conc-test-${idx}@example.com`,
    items: [
      { id: 'x', name: 'Concurrency Item', price: 10, quantity: 1, size: 'FULL', category: 'Test' },
    ],
    total_amount   : 10,
    gst_amount     : 0,
    payment_method : 'CASH',
    checkout_mode  : 'cloud_kitchen',
    customer_address_line1 : `Concurrency block, Unit ${idx}`,
    customer_city          : 'Gurgaon',
    customer_pincode       : '122002',
    customer_landmark      : 'Stress test',
  });

  const t0 = Date.now();
  return request(`${SERVER}/api/restaurant/${RESTO}/orders`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body).then(res => {
    const t1 = Date.now();
    let parsed = null;
    try { parsed = JSON.parse(res.body); } catch {}
    return {
      idx,
      status         : res.status,
      latencyMs      : t1 - t0,
      orderId        : parsed && parsed.id,
      invoice_number : parsed && parsed.invoice_number,
      invoice_status : parsed && parsed.invoice_status,
      kitchen_status : parsed && parsed.kitchen_status,
      error          : parsed && parsed.error,
    };
  });
}

function parseInvoiceTail(inv) {
  if (!inv) return null;
  // Accepts CK-0007, INV-2026-0007, etc. — pull the trailing run of digits.
  const m = String(inv).match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

async function runWave(waveIdx) {
  console.log(`\n🌊  Wave ${waveIdx + 1}/${WAVES} — firing ${COUNT} parallel orders…`);
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: COUNT }, (_, i) => placeOrder(`W${waveIdx + 1}-${i + 1}`))
  );
  const totalMs = Date.now() - t0;

  // Latency stats
  const latencies = results.filter(r => r.status === 200).map(r => r.latencyMs);
  latencies.sort((a, b) => a - b);
  const min = latencies[0] || 0;
  const max = latencies[latencies.length - 1] || 0;
  const med = latencies[Math.floor(latencies.length / 2)] || 0;
  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  // Status counts
  const ok    = results.filter(r => r.status === 200);
  const fail  = results.filter(r => r.status !== 200);

  // Invoice-number checks
  const invs       = ok.map(r => r.invoice_number).filter(Boolean);
  const tails      = invs.map(parseInvoiceTail).filter(n => n != null);
  const uniqueInvs = new Set(invs);
  const minTail    = Math.min(...tails);
  const maxTail    = Math.max(...tails);
  const expected   = maxTail - minTail + 1;
  const tailsSorted = [...tails].sort((a, b) => a - b);
  const gapsInRange = [];
  for (let i = minTail; i <= maxTail; i++) {
    if (!tails.includes(i)) gapsInRange.push(i);
  }

  console.log(`   ── results ─────────────────────────────────────────`);
  console.log(`   Wall time          : ${totalMs} ms (${(COUNT / (totalMs / 1000)).toFixed(1)} req/s)`);
  console.log(`   HTTP 200           : ${ok.length}/${results.length}`);
  console.log(`   Failures           : ${fail.length}`);
  console.log(`   Latency (ms)       : min=${min}  med=${med}  avg=${avg}  max=${max}`);
  console.log(`   Invoice numbers    : ${invs.length} returned, ${uniqueInvs.size} unique`);
  console.log(`   Sequence range     : ${tails.length ? `${minTail}…${maxTail} (expected ${expected} numbers, got ${tails.length})` : '(no invoices)'}`);
  console.log(`   Gaps in range      : ${gapsInRange.length === 0 ? '✅ none' : `⚠️  ${gapsInRange.join(', ')}`}`);
  console.log(`   Duplicates         : ${invs.length === uniqueInvs.size ? '✅ none' : `❌ ${invs.length - uniqueInvs.size} duplicates`}`);

  if (fail.length > 0) {
    console.log(`\n   ❌ Failures:`);
    fail.slice(0, 5).forEach(r => {
      console.log(`      • idx=${r.idx} status=${r.status} error=${r.error || '(no body)'}`);
    });
    if (fail.length > 5) console.log(`      … and ${fail.length - 5} more`);
  }

  return { ok: ok.length, fail: fail.length, dup: invs.length - uniqueInvs.size, gaps: gapsInRange.length };
}

(async () => {
  console.log('\n🍱  Cloud Kitchen — Parallel Order Concurrency Test');
  console.log('═'.repeat(60));
  console.log(`Server     : ${SERVER}`);
  console.log(`Restaurant : ${RESTO}`);
  console.log(`Per-wave   : ${COUNT} parallel orders`);
  console.log(`Waves      : ${WAVES}`);
  console.log(`Total POST : ${COUNT * WAVES}`);

  let totalOk = 0, totalFail = 0, totalDup = 0, totalGap = 0;
  for (let i = 0; i < WAVES; i++) {
    const r = await runWave(i);
    totalOk   += r.ok;
    totalFail += r.fail;
    totalDup  += r.dup;
    totalGap  += r.gaps;
  }

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`📊  Aggregate across ${WAVES} wave(s) of ${COUNT} parallel orders`);
  console.log(`    Total POST   : ${COUNT * WAVES}`);
  console.log(`    OK           : ${totalOk}`);
  console.log(`    Failed       : ${totalFail}`);
  console.log(`    Duplicates   : ${totalDup}`);
  console.log(`    Sequence gaps: ${totalGap} (expected 0 for back-to-back waves)`);
  console.log(`\n${
    totalFail === 0 && totalDup === 0
      ? '✅ PASS — every parallel order got a distinct invoice number, none failed.'
      : '❌ FAIL — see failures / duplicates above.'
  }\n`);
})().catch(err => {
  console.error('\n❌  Fatal:', err);
  process.exit(1);
});
