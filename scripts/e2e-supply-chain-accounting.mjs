/**
 * Atithi-Setu — Supply Chain Accounting E2E Test
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Usage:
 *   node scripts/e2e-supply-chain-accounting.mjs \
 *     --server https://erp.atithi-setu.com \
 *     --restaurant RESTO-1003 \
 *     --admin-login ADMIN-ANKUSH \
 *     --admin-password admin123
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

const SERVER    = get('--server')        || 'https://erp.atithi-setu.com';
const REST_ID   = get('--restaurant')    || 'RESTO-1003';
const LOGIN     = get('--login');
const PASSWORD  = get('--password');
const ADM_LOGIN = get('--admin-login');
const ADM_PWD   = get('--admin-password');
const TOKEN     = get('--token');

if (!TOKEN && !ADM_LOGIN && !LOGIN) {
  console.error('ERROR: provide --token, --admin-login + --admin-password, or --login + --password');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────
let PASS = 0, FAIL = 0;
const results = [];

function assert(label, condition, got, expected) {
  const ok = !!condition;
  console.log(ok ? `  ✓ ${label}` : `  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      got:      ${JSON.stringify(got)}`);
  results.push({ label, ok, got, expected });
  if (ok) PASS++; else FAIL++;
}

function assertClose(label, got, expected, tol = 0.01) {
  assert(label, typeof got === 'number' && Math.abs(got - expected) <= tol, got, expected);
}

async function req(method, path, body, tok) {
  const url = new URL(path, SERVER);
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;
  const payload = body ? JSON.stringify(body) : null;
  const headers = {
    'Content-Type': 'application/json',
    ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
  };
  return new Promise((resolve, reject) => {
    const r = mod.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
      rejectUnauthorized: false,
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        let json; try { json = JSON.parse(raw); } catch { json = raw; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Auth ──────────────────────────────────────────────────────────────────
async function getToken() {
  if (TOKEN) return TOKEN;
  const loginId  = ADM_LOGIN || LOGIN;
  const password = ADM_PWD   || PASSWORD;
  console.log(`\n[Auth] Logging in as "${loginId}"...`);
  const r = await req('POST', '/api/auth/login', { loginId, password, restaurantId: REST_ID });
  if (r.status !== 200) throw new Error(`Login failed (${r.status}): ${JSON.stringify(r.body)}`);
  console.log(`[Auth] Logged in — role: ${r.body.role}`);
  return r.body.token;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function run() {
  const BASE = `/api/restaurant/${REST_ID}`;

  let token;
  try { token = await getToken(); console.log('[Auth] Token obtained ✓\n'); }
  catch (e) { console.error('[Auth] FAILED:', e.message); process.exit(1); }

  // Helper: tenant-scoped call
  const call = (m, p, b) => req(m, `${BASE}${p}`, b, token);
  // Helper: global call (for routes without restaurantId in path)
  const gall = (m, p, b) => req(m, p, b, token);

  const ts = Date.now();
  const today    = new Date().toISOString().slice(0, 10);
  const delivery = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const due30    = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 1: Supplier creation + GET by ID
  // ══════════════════════════════════════════════════════════════════════
  console.log('══════════════════════════════════════════');
  console.log('PHASE 1 — Supplier');
  console.log('══════════════════════════════════════════');

  const supR = await call('POST', '/procurement/suppliers', {
    name: `E2E Supplier ${ts}`,
    contact_name: 'Ramesh Kumar',
    phone: '9999000001',
    email: `e2e.sup.${ts}@test.local`,
    address: '12 Test Market, Mumbai',
    gst_number: `27AABCE${ts % 10000}F1Z5`,
    payment_terms: 'NET_30',
    credit_days: 30,
    supplier_type: 'FOOD',
    pan_number: 'AABCE0001F',
    msme_registered: 1,
    vendor_category: 'Vegetables',
    credit_limit: 50000,
    tds_category: '1%',
    contract_start_date: '2026-01-01',
    contract_end_date: '2026-12-31',
    preferred_status: 'PREFERRED',
  });
  assert('POST supplier → 201', supR.status === 201, supR.status, 201);
  const supplierId = supR.body?.id;
  assert('supplier.id present', !!supplierId, supplierId, '<id>');

  const supGet = await call('GET', `/procurement/suppliers/${supplierId}`, null);
  assert('GET supplier → 200', supGet.status === 200, supGet.status, 200);
  assert('supplier.pan_number', supGet.body?.pan_number === 'AABCE0001F', supGet.body?.pan_number, 'AABCE0001F');
  assert('supplier.msme_registered = 1', Number(supGet.body?.msme_registered) === 1, supGet.body?.msme_registered, 1);
  assert('supplier.preferred_status = PREFERRED', supGet.body?.preferred_status === 'PREFERRED', supGet.body?.preferred_status, 'PREFERRED');
  assertClose('supplier.credit_limit = 50000', Number(supGet.body?.credit_limit), 50000);

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 2: Purchase Order (100 kg × ₹50 = ₹5,000)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════');
  console.log('PHASE 2 — Purchase Order ₹5,000');
  console.log('══════════════════════════════════════════');

  const poR = await call('POST', '/inventory/purchase-orders', {
    supplier_id: supplierId,
    order_date: today,
    expected_delivery_date: delivery,
    notes: 'E2E accounting test',
    items: [{ item_name: 'Tomatoes', unit: 'kg', quantity: 100, unit_price: 50 }],
  });
  assert('POST purchase-order → 201', poR.status === 201, poR.status, 201);
  const poId = poR.body?.id;
  assert('PO.id present', !!poId, poId, '<id>');

  // GET PO — global route (no restaurantId prefix)
  const poGet = await gall('GET', `/api/inventory/purchase-orders/${poId}`, null);
  assert('GET PO → 200', poGet.status === 200, poGet.status, 200);
  assertClose('PO.total_amount = 5000', Number(poGet.body?.total_amount), 5000);
  assert('PO.status = PENDING', poGet.body?.status === 'PENDING', poGet.body?.status, 'PENDING');

  const poItems = poGet.body?.items || [];
  assert('PO has 1 item', poItems.length === 1, poItems.length, 1);
  const poItem = poItems[0];

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 3: GRN partial (60 kg)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════');
  console.log('PHASE 3 — GRN #1: 60 kg received');
  console.log('══════════════════════════════════════════');

  const grn1R = await call('POST', '/inventory/grn', {
    po_id: poId,
    received_at: today,
    notes: 'First partial delivery',
    items: [{ po_item_id: poItem?.id, ingredient_id: poItem?.ingredient_id, qty_received: 60, unit_price: 50 }],
  });
  assert('POST GRN#1 → 201', grn1R.status === 201, grn1R.status, 201);

  const po2 = await gall('GET', `/api/inventory/purchase-orders/${poId}`, null);
  assert('PO.status after 60 kg = PARTIAL', po2.body?.status === 'PARTIAL', po2.body?.status, 'PARTIAL');

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 4: GRN final (40 kg)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════');
  console.log('PHASE 4 — GRN #2: 40 kg received');
  console.log('══════════════════════════════════════════');

  const grn2R = await call('POST', '/inventory/grn', {
    po_id: poId,
    received_at: today,
    notes: 'Final delivery',
    items: [{ po_item_id: poItem?.id, ingredient_id: poItem?.ingredient_id, qty_received: 40, unit_price: 50 }],
  });
  assert('POST GRN#2 → 201', grn2R.status === 201, grn2R.status, 201);

  const po3 = await gall('GET', `/api/inventory/purchase-orders/${poId}`, null);
  assert('PO.status after 100 kg = RECEIVED', po3.body?.status === 'RECEIVED', po3.body?.status, 'RECEIVED');

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 5: Invoice ₹5,000
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════');
  console.log('PHASE 5 — Invoice ₹5,000');
  console.log('══════════════════════════════════════════');

  const invR = await call('POST', '/procurement/supplier-invoices', {
    supplier_id: supplierId,
    po_id: poId,
    invoice_number: `INV-E2E-${ts}`,
    invoice_date: today,
    due_date: due30,
    total_amount: 5000,
    notes: 'E2E: 100 kg tomatoes @ ₹50',
  });
  assert('POST invoice → 201', invR.status === 201, invR.status, 201);
  const invId = invR.body?.id;
  assert('invoice.id present', !!invId, invId, '<id>');

  const invGet = await call('GET', `/procurement/supplier-invoices/${invId}`, null);
  assert('GET invoice → 200', invGet.status === 200, invGet.status, 200);
  assertClose('invoice.total_amount = 5000', Number(invGet.body?.total_amount), 5000);
  assertClose('invoice.outstanding_amount = 5000', Number(invGet.body?.outstanding_amount), 5000);
  assertClose('invoice.paid_amount = 0', Number(invGet.body?.paid_amount), 0);
  assert('invoice.status = UNPAID', invGet.body?.status === 'UNPAID', invGet.body?.status, 'UNPAID');

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 6: Pay ₹2,000 (partial)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════');
  console.log('PHASE 6 — Payment #1: ₹2,000');
  console.log('══════════════════════════════════════════');

  const pay1R = await call('POST', `/procurement/supplier-invoices/${invId}/payments`, {
    amount: 2000, payment_date: today, payment_method: 'BANK_TRANSFER', reference: 'NEFT-E2E-001',
  });
  assert('POST payment₁ → 201', pay1R.status === 201, pay1R.status, 201);
  const pay1Id = pay1R.body?.id;

  const inv2 = await call('GET', `/procurement/supplier-invoices/${invId}`, null);
  assertClose('invoice.paid_amount = 2000', Number(inv2.body?.paid_amount), 2000);
  assertClose('invoice.outstanding_amount = 3000', Number(inv2.body?.outstanding_amount), 3000);
  assert('invoice.status = PARTIAL', inv2.body?.status === 'PARTIAL', inv2.body?.status, 'PARTIAL');
  assertClose('paid + outstanding = total (pay1)', Number(inv2.body?.paid_amount) + Number(inv2.body?.outstanding_amount), Number(inv2.body?.total_amount));

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 7: Pay ₹3,000 (full settlement)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════');
  console.log('PHASE 7 — Payment #2: ₹3,000 (full)');
  console.log('══════════════════════════════════════════');

  const pay2R = await call('POST', `/procurement/supplier-invoices/${invId}/payments`, {
    amount: 3000, payment_date: today, payment_method: 'CHEQUE', reference: 'CHQ-E2E-002',
  });
  assert('POST payment₂ → 201', pay2R.status === 201, pay2R.status, 201);
  const pay2Id = pay2R.body?.id;

  const inv3 = await call('GET', `/procurement/supplier-invoices/${invId}`, null);
  assertClose('invoice.paid_amount = 5000', Number(inv3.body?.paid_amount), 5000);
  assertClose('invoice.outstanding_amount = 0', Number(inv3.body?.outstanding_amount), 0);
  assert('invoice.status = PAID', inv3.body?.status === 'PAID', inv3.body?.status, 'PAID');
  assertClose('paid + outstanding = total (pay2)', Number(inv3.body?.paid_amount) + Number(inv3.body?.outstanding_amount), Number(inv3.body?.total_amount));

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 8: Over-payment guard
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════');
  console.log('PHASE 8 — Over-payment guard');
  console.log('══════════════════════════════════════════');

  const overR = await call('POST', `/procurement/supplier-invoices/${invId}/payments`, {
    amount: 1, payment_date: today, payment_method: 'CASH',
  });
  assert('Over-payment → 400', overR.status === 400, overR.status, 400);
  assert('Over-payment error message present', !!(overR.body?.error), overR.body?.error, '<string>');

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 9: Ledger
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════');
  console.log('PHASE 9 — Supplier Ledger');
  console.log('══════════════════════════════════════════');

  const ledR = await call('GET', `/procurement/suppliers/${supplierId}/ledger`, null);
  assert('GET ledger → 200', ledR.status === 200, ledR.status, 200);
  assertClose('ledger.total_billed = 5000',   Number(ledR.body?.summary?.total_billed), 5000);
  assertClose('ledger.total_paid = 5000',     Number(ledR.body?.summary?.total_paid), 5000);
  assertClose('ledger.total_outstanding = 0', Number(ledR.body?.summary?.total_outstanding), 0);
  const agSum = Number(ledR.body?.summary?.aging_current || 0)
              + Number(ledR.body?.summary?.aging_0_30   || 0)
              + Number(ledR.body?.summary?.aging_31_60  || 0)
              + Number(ledR.body?.summary?.aging_60plus || 0);
  assertClose('All aging buckets = 0 (fully paid)', agSum, 0);

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 10: Scorecard
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════');
  console.log('PHASE 10 — Supplier Scorecard');
  console.log('══════════════════════════════════════════');

  const scR = await call('GET', `/procurement/suppliers/${supplierId}/scorecard`, null);
  assert('GET scorecard → 200', scR.status === 200, scR.status, 200);
  assert('scorecard.on_time_pct field exists', 'on_time_pct' in (scR.body || {}), scR.body, '{ on_time_pct }');
  assert('scorecard.fill_rate_pct field exists', 'fill_rate_pct' in (scR.body || {}), scR.body, '{ fill_rate_pct }');
  if (scR.body?.fill_rate_pct !== null && scR.body?.fill_rate_pct !== undefined) {
    assertClose('fill_rate_pct = 100', Number(scR.body.fill_rate_pct), 100);
  }

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 11: Payment reversal
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════');
  console.log('PHASE 11 — Payment Reversal');
  console.log('══════════════════════════════════════════');

  // Correct route: /procurement/payments/:paymentId
  const delR = await call('DELETE', `/procurement/payments/${pay2Id}`, null);
  assert('DELETE payment₂ → 200', delR.status === 200, delR.status, 200);

  const inv4 = await call('GET', `/procurement/supplier-invoices/${invId}`, null);
  assertClose('invoice.paid_amount = 2000 (after reversal)', Number(inv4.body?.paid_amount), 2000);
  assertClose('invoice.outstanding_amount = 3000 (after reversal)', Number(inv4.body?.outstanding_amount), 3000);
  assert('invoice.status = PARTIAL (after reversal)', inv4.body?.status === 'PARTIAL', inv4.body?.status, 'PARTIAL');
  assertClose('paid + outstanding = total (after reversal)', Number(inv4.body?.paid_amount) + Number(inv4.body?.outstanding_amount), Number(inv4.body?.total_amount));

  const led2R = await call('GET', `/procurement/suppliers/${supplierId}/ledger`, null);
  assertClose('ledger.total_paid = 2000 (after reversal)', Number(led2R.body?.summary?.total_paid), 2000);
  assertClose('ledger.total_outstanding = 3000 (after reversal)', Number(led2R.body?.summary?.total_outstanding), 3000);
  const agSum2 = Number(led2R.body?.summary?.aging_current || 0)
               + Number(led2R.body?.summary?.aging_0_30   || 0)
               + Number(led2R.body?.summary?.aging_31_60  || 0)
               + Number(led2R.body?.summary?.aging_60plus || 0);
  assertClose('Aging buckets sum to 3000 (after reversal)', agSum2, 3000);

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 12: Invoice total reduction guard
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════');
  console.log('PHASE 12 — Invoice Total Guard');
  console.log('══════════════════════════════════════════');

  // Reduce below paid_amount (2000) → must reject
  const badPatch = await call('PATCH', `/procurement/supplier-invoices/${invId}`, { total_amount: 1500 });
  assert('PATCH total below paid_amount → 400', badPatch.status === 400, badPatch.status, 400);

  // Reduce to exactly paid_amount → marks PAID
  const goodPatch = await call('PATCH', `/procurement/supplier-invoices/${invId}`, { total_amount: 2000 });
  assert('PATCH total = paid_amount → 200', goodPatch.status === 200, goodPatch.status, 200);
  const inv5 = await call('GET', `/procurement/supplier-invoices/${invId}`, null);
  assert('invoice.status = PAID (total=paid patch)', inv5.body?.status === 'PAID', inv5.body?.status, 'PAID');
  assertClose('invoice.outstanding_amount = 0 (total=paid patch)', Number(inv5.body?.outstanding_amount), 0);

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 13: Analytics endpoints
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════');
  console.log('PHASE 13 — Analytics');
  console.log('══════════════════════════════════════════');

  const abcR  = await call('GET', '/inventory/abc-analysis', null);
  assert('GET abc-analysis → 200', abcR.status === 200, abcR.status, 200);
  assert('abc-analysis is array', Array.isArray(abcR.body), typeof abcR.body, 'array');

  const agR   = await call('GET', '/procurement/reports/payables', null);
  assert('GET payables report → 200', agR.status === 200, agR.status, 200);

  const spR   = await call('GET', '/procurement/reports/spending', null);
  assert('GET spending report → 200', spR.status === 200, spR.status, 200);

  const posR  = await call('GET', '/procurement/reports/po-stats', null);
  assert('GET po-stats report → 200', posR.status === 200, posR.status, 200);

  // ══════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('══════════════════════════════════════════');
  console.log(`  PASS:  ${PASS}`);
  console.log(`  FAIL:  ${FAIL}`);
  console.log(`  TOTAL: ${PASS + FAIL}`);

  if (FAIL > 0) {
    console.log('\nFAILED:');
    results.filter(r => !r.ok).forEach(r => {
      console.log(`  ✗ ${r.label}`);
      console.log(`      expected: ${JSON.stringify(r.expected)}`);
      console.log(`      got:      ${JSON.stringify(r.got)}`);
    });
    process.exit(1);
  } else {
    console.log('\nALL ASSERTIONS PASSED ✓');
    console.log('Supply Chain accounting is correct end-to-end.');
  }
}

run().catch(e => { console.error('Uncaught:', e.message); process.exit(1); });
