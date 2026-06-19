/**
 * Atithi-Setu — Spa & Wellness E2E Full-Loop Test
 * ════════════════════════════════════════════════════════════════════════════
 * Exercises the entire spa module against a live tenant: enable → catalog →
 * resources/therapists → dual-resource availability + conflict guards →
 * lifecycle → consumable deduction → checkout/folio/invoice → payment + void →
 * packages → memberships → retail sale → supply-chain link → reports →
 * zero-impact guard.
 *
 * Usage:
 *   node scripts/e2e-spa-full-loop.mjs \
 *     --server https://erp.atithi-setu.com \
 *     --restaurant RESTO-1003 \
 *     --admin-login ADMIN-ANKUSH \
 *     --admin-password admin123
 */
import https from 'https';
import http from 'http';
import { URL } from 'url';

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const SERVER = get('--server') || 'https://erp.atithi-setu.com';
const REST_ID = get('--restaurant') || 'RESTO-1003';
const ADM_LOGIN = get('--admin-login');
const ADM_PWD = get('--admin-password');

let PASS = 0, FAIL = 0;
const results = [];
function assert(label, cond, got, expected) {
  const ok = !!cond;
  console.log(ok ? `  ✓ ${label}` : `  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      got:      ${JSON.stringify(got)}`);
  results.push({ label, ok, got, expected });
  if (ok) PASS++; else FAIL++;
}
function assertClose(label, got, expected, tol = 0.02) {
  assert(label, typeof got === 'number' && Math.abs(got - expected) <= tol, got, expected);
}

function req(method, path, body, tok, raw = false) {
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
    const r = mod.request({ hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname + url.search, method, headers, rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (raw) return resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '', length: data.length });
        let json; try { json = JSON.parse(data); } catch { json = data; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function getToken() {
  console.log(`\n[Auth] Logging in as "${ADM_LOGIN}"...`);
  const r = await req('POST', '/api/auth/login', { loginId: ADM_LOGIN, password: ADM_PWD, restaurantId: REST_ID });
  if (r.status !== 200) throw new Error(`Login failed (${r.status}): ${JSON.stringify(r.body)}`);
  console.log(`[Auth] Logged in — role: ${r.body.role}`);
  return r.body.token;
}

// date helpers
const pad = (n) => String(n).padStart(2, '0');
function futureDate(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

async function run() {
  const BASE = `/api/restaurant/${REST_ID}`;
  let token;
  try { token = await getToken(); console.log('[Auth] Token obtained ✓\n'); }
  catch (e) { console.error('[Auth] FAILED:', e.message); process.exit(1); }
  const call = (m, p, b) => req(m, `${BASE}${p}`, b, token);

  const ts = Date.now();
  const date = futureDate(14);
  const wd = weekdayOf(date);
  const at = (hhmm) => `${date} ${hhmm}:00`;

  // ════════════════════════ PHASE 0 — zero-impact guard ════════════════════
  console.log('══════ PHASE 0 — Zero-impact guard ══════');
  const guard = await req('GET', `/api/restaurant/RESTO-NONEXISTENT-${ts}/spa/services`, null, token);
  assert('Non-spa/unknown tenant blocked on /spa (non-200)', guard.status === 403 || guard.status === 404, guard.status, '403/404');

  // ════════════════════════ PHASE 1 — enable ════════════════════════════════
  console.log('\n══════ PHASE 1 — Enable spa module ══════');
  const en1 = await call('POST', '/spa/enable', { enabled: true });
  assert('POST /spa/enable → 200', en1.status === 200, en1.status, 200);
  assert('spa_enabled = 1', en1.body?.spa_enabled === 1, en1.body?.spa_enabled, 1);
  const en2 = await call('POST', '/spa/enable', { enabled: true });
  assert('idempotent re-enable → 200', en2.status === 200, en2.status, 200);

  // ════════════════════════ PHASE 2 — catalog + resources + therapists ══════
  console.log('\n══════ PHASE 2 — Catalog / resources / therapists ══════');
  const svcR = await call('POST', '/spa/services', { name: `E2E Swedish ${ts}`, category: 'MASSAGE', duration_min: 60, buffer_after_min: 10, price: 1000, gst_percent: 18 });
  assert('POST service → 201', svcR.status === 201, svcR.status, 201);
  const serviceId = svcR.body?.id;
  assert('service.id present', !!serviceId, serviceId, '<id>');

  const cabAR = await call('POST', '/spa/resources', { name: `E2E Cabin A ${ts}` });
  const cabBR = await call('POST', '/spa/resources', { name: `E2E Cabin B ${ts}` });
  const cabinA = cabAR.body?.id, cabinB = cabBR.body?.id;
  assert('POST cabin A → 201', cabAR.status === 201, cabAR.status, 201);
  assert('POST cabin B → 201', cabBR.status === 201, cabBR.status, 201);

  const t1R = await call('POST', '/spa/therapists', { display_name: `E2E Therapist 1 ${ts}` });
  const t2R = await call('POST', '/spa/therapists', { display_name: `E2E Therapist 2 ${ts}` });
  const ther1 = t1R.body?.id, ther2 = t2R.body?.id;
  assert('POST therapist 1 → 201', t1R.status === 201, t1R.status, 201);
  assert('POST therapist 2 → 201', t2R.status === 201, t2R.status, 201);

  // skills + schedules for both therapists (covering the test weekday)
  for (const tid of [ther1, ther2]) {
    await call('POST', `/spa/therapists/${tid}/services`, { service_ids: [serviceId] });
    await call('POST', `/spa/therapists/${tid}/schedules`, { weekday: wd, start_time: '09:00', end_time: '18:00' });
  }
  const skillsCheck = await call('GET', `/spa/therapists/${ther1}/services`, null);
  assert('therapist 1 has the service skill', Array.isArray(skillsCheck.body) && skillsCheck.body.some(s => s.service_id === serviceId), skillsCheck.body, '[serviceId]');

  // ════════════════════════ PHASE 3 — availability ══════════════════════════
  console.log('\n══════ PHASE 3 — Dual-resource availability ══════');
  const av = await call('GET', `/spa/availability?service_id=${serviceId}&date=${date}`, null);
  assert('GET availability → 200', av.status === 200, av.status, 200);
  const slots = av.body?.slots || [];
  assert('≥1 slot returned', slots.length > 0, slots.length, '>0');
  assert('slot carries therapist_id + resource_id', !!(slots[0]?.therapist_id && slots[0]?.resource_id), slots[0], '{therapist_id,resource_id}');

  // ════════════════════════ PHASE 4 — booking + conflict guards ═════════════
  console.log('\n══════ PHASE 4 — Booking + dual-resource conflict guards ══════');
  const b1 = await call('POST', '/spa/appointments', { service_id: serviceId, start_at: at('10:00'), therapist_id: ther1, resource_id: cabinA, client_name: `E2E Client ${ts}`, client_phone: `9${String(ts).slice(-9)}` });
  assert('book appt1 (10:00, ther1, cabinA) → 201', b1.status === 201, b1.status, 201);
  const appt1 = b1.body?.id;

  const cfTher = await call('POST', '/spa/appointments', { service_id: serviceId, start_at: at('10:30'), therapist_id: ther1, resource_id: cabinB, client_name: 'Conflict T', client_phone: '900000001' });
  assert('therapist double-book (10:30, ther1) → 409', cfTher.status === 409, cfTher.status, 409);

  const cfCab = await call('POST', '/spa/appointments', { service_id: serviceId, start_at: at('10:30'), therapist_id: ther2, resource_id: cabinA, client_name: 'Conflict C', client_phone: '900000002' });
  assert('cabin double-book (10:30, cabinA) → 409', cfCab.status === 409, cfCab.status, 409);

  const okSlot = await call('POST', '/spa/appointments', { service_id: serviceId, start_at: at('12:00'), therapist_id: ther1, resource_id: cabinA, client_name: 'Non-overlap', client_phone: '900000003' });
  assert('non-overlapping booking (12:00) → 201', okSlot.status === 201, okSlot.status, 201);

  // ════════════════════════ PHASE 5 — consumable + lifecycle ════════════════
  console.log('\n══════ PHASE 5 — Consumable deduction on complete ══════');
  const inv0 = await call('GET', '/spa/inventory', null);
  const oil = (inv0.body || []).find(i => i.item_type === 'SPA_PRODUCT');
  assert('seeded SPA_PRODUCT exists', !!oil, oil, '<oil>');
  const oilQtyBefore = Number(oil?.current_stock_qty || 0);
  await call('POST', `/spa/services/${serviceId}/consumables`, { ingredient_id: oil.id, qty_per_service: 0.05, unit: 'l' });

  await call('POST', `/spa/appointments/${appt1}/confirm`, {});
  await call('POST', `/spa/appointments/${appt1}/check-in`, {});
  const comp = await call('POST', `/spa/appointments/${appt1}/complete`, {});
  assert('complete appt1 → 200', comp.status === 200, comp.status, 200);
  assert('appt1 status COMPLETED', comp.body?.status === 'COMPLETED', comp.body?.status, 'COMPLETED');
  const inv1 = await call('GET', '/spa/inventory', null);
  const oilAfter = (inv1.body || []).find(i => i.id === oil.id);
  assertClose('oil stock decremented by 0.05', oilQtyBefore - Number(oilAfter?.current_stock_qty || 0), 0.05, 0.001);

  // ════════════════════════ PHASE 6 — checkout → folio → invoice ════════════
  console.log('\n══════ PHASE 6 — Checkout / folio / invoice ══════');
  const co = await call('POST', `/spa/appointments/${appt1}/checkout`, { payment_method: 'CASH' });
  assert('checkout → 201', co.status === 201, co.status, 201);
  const folioId = co.body?.folio?.id;
  assert('folio_kind = SPA', co.body?.folio?.folio_kind === 'SPA', co.body?.folio?.folio_kind, 'SPA');
  assertClose('grand_total = 1180 (1000 + 18% GST)', Number(co.body?.folio?.grand_total), 1180);
  assert('invoice_number starts SPA-', String(co.body?.invoice_number || '').startsWith('SPA-'), co.body?.invoice_number, 'SPA-...');
  assert('invoice_number has year', String(co.body?.invoice_number || '').includes(String(new Date().getFullYear())), co.body?.invoice_number, `SPA-${new Date().getFullYear()}-…`);

  const pdf = await req('GET', `${BASE}/spa/folios/${folioId}/invoice.pdf`, null, token, true);
  assert('invoice.pdf → 200', pdf.status === 200, pdf.status, 200);
  assert('invoice.pdf is application/pdf', /application\/pdf/.test(pdf.contentType), pdf.contentType, 'application/pdf');

  // ════════════════════════ PHASE 7 — payment + void ════════════════════════
  console.log('\n══════ PHASE 7 — Payment + void ══════');
  const pay = await call('POST', `/spa/folios/${folioId}/payments`, { amount: 1180, payment_method: 'CASH', payment_type: 'FINAL' });
  assert('payment → 201', pay.status === 201, pay.status, 201);
  assertClose('outstanding after payment = 0', Number(pay.body?.outstanding), 0);
  // find the payment id to void
  const folioFull = await call('GET', `/spa/folios/${folioId}`, null);
  const payId = (folioFull.body?.payments || []).find(p => !p.is_voided)?.id;
  const voidR = await call('POST', `/spa/folios/${folioId}/payments/${payId}/void`, { reason: 'e2e' });
  assert('void payment → 200', voidR.status === 200, voidR.status, 200);
  assertClose('outstanding after void = 1180', Number(voidR.body?.outstanding), 1180);

  // ════════════════════════ PHASE 8 — package purchase + redeem ═════════════
  console.log('\n══════ PHASE 8 — Packages (purchase + redeem at checkout) ══════');
  // resolve the client created during booking
  const clients = await call('GET', `/spa/clients?search=9${String(ts).slice(-9)}`, null);
  const clientId = (clients.body || [])[0]?.id;
  assert('client resolved by phone', !!clientId, clientId, '<id>');
  const pkgR = await call('POST', '/spa/packages', { name: `E2E 3-Pack ${ts}`, service_id: serviceId, total_sessions: 3, price: 2700, gst_percent: 18 });
  const pkgId = pkgR.body?.id;
  const buy = await call('POST', `/spa/clients/${clientId}/packages`, { package_id: pkgId, payment_method: 'CASH' });
  assert('purchase package → 201', buy.status === 201, buy.status, 201);
  assert('sessions_remaining = 3 after purchase', Number(buy.body?.client_package?.sessions_remaining) === 3, buy.body?.client_package?.sessions_remaining, 3);

  // book a 2nd appointment for this client, complete, checkout WITH package
  const b2 = await call('POST', '/spa/appointments', { service_id: serviceId, start_at: at('14:00'), therapist_id: ther1, resource_id: cabinA, client_id: clientId, client_name: `E2E Client ${ts}`, client_phone: `9${String(ts).slice(-9)}` });
  const appt2 = b2.body?.id;
  await call('POST', `/spa/appointments/${appt2}/complete`, {});
  const co2 = await call('POST', `/spa/appointments/${appt2}/checkout`, { use_package: true, payment_method: 'CASH' });
  assert('package checkout → 201', co2.status === 201, co2.status, 201);
  assertClose('package redemption → grand_total 0 (no service charge)', Number(co2.body?.folio?.grand_total), 0);
  const pkgList = await call('GET', `/spa/clients/${clientId}/packages`, null);
  const cp = (pkgList.body || []).find(p => p.package_id === pkgId);
  assert('sessions_remaining = 2 after redeem', Number(cp?.sessions_remaining) === 2, cp?.sessions_remaining, 2);

  // ════════════════════════ PHASE 9 — membership benefit ════════════════════
  console.log('\n══════ PHASE 9 — Membership (subscribe + auto discount) ══════');
  const memR = await call('POST', '/spa/memberships', { name: `E2E Club ${ts}`, monthly_fee: 1999, benefits: { discount_pct: 10 } });
  const planId = memR.body?.id;
  const sub = await call('POST', `/spa/clients/${clientId}/memberships`, { plan_id: planId, payment_method: 'CASH' });
  assert('subscribe membership → 201', sub.status === 201, sub.status, 201);
  const b3 = await call('POST', '/spa/appointments', { service_id: serviceId, start_at: at('16:00'), therapist_id: ther1, resource_id: cabinA, client_id: clientId, client_name: `E2E Client ${ts}`, client_phone: `9${String(ts).slice(-9)}` });
  const appt3 = b3.body?.id;
  await call('POST', `/spa/appointments/${appt3}/complete`, {});
  const co3 = await call('POST', `/spa/appointments/${appt3}/checkout`, { apply_membership: true, payment_method: 'CASH' });
  assert('membership checkout → 201', co3.status === 201, co3.status, 201);
  // subtotal 1000, gst 180, discount 100 → grand 1080
  assertClose('membership 10% discount applied → grand_total 1080', Number(co3.body?.folio?.grand_total), 1080);

  // ════════════════════════ PHASE 10 — retail sale ══════════════════════════
  console.log('\n══════ PHASE 10 — Retail sale (deduct stock + invoice) ══════');
  const inv2 = await call('GET', '/spa/inventory', null);
  const retail = (inv2.body || []).find(i => i.item_type === 'SPA_RETAIL');
  assert('seeded SPA_RETAIL exists', !!retail, retail, '<retail>');
  const retailBefore = Number(retail?.current_stock_qty || 0);
  const sale = await call('POST', '/spa/retail-sale', { ingredient_id: retail.id, qty: 2, payment_method: 'CASH' });
  assert('retail sale → 201', sale.status === 201, sale.status, 201);
  assert('retail invoice number present', String(sale.body?.invoice_number || '').startsWith('SPA-'), sale.body?.invoice_number, 'SPA-...');
  assertClose('retail stock decremented by 2', retailBefore - Number(sale.body?.stock_remaining), 2, 0.001);

  // ════════════════════════ PHASE 11 — supply-chain link ════════════════════
  console.log('\n══════ PHASE 11 — Supply-chain link (PO→GRN→invoice→payment) ══════');
  const supR = await call('POST', '/procurement/suppliers', { name: `E2E Spa Supplier ${ts}`, payment_terms: 'NET_30' });
  const supplierId = supR.body?.id;
  assert('create supplier → 201', supR.status === 201, supR.status, 201);
  const poR = await call('POST', '/inventory/purchase-orders', { supplier_id: supplierId, items: [{ ingredient_id: oil.id, qty_ordered: 10, unit_price: 800 }] });
  assert('PO with spa SPA_PRODUCT → 201', poR.status === 201, poR.status, 201);
  const poId = poR.body?.id;
  const poGet = await call('GET', `/inventory/purchase-orders/${poId}`, null);
  assert('PO status DRAFT', poGet.body?.status === 'DRAFT', poGet.body?.status, 'DRAFT');
  const poItem = (poGet.body?.items || [])[0];
  const grnR = await call('POST', '/inventory/grn', { po_id: poId, items: [{ po_item_id: poItem?.id, ingredient_id: oil.id, qty_received: 10, unit_price: 800 }] });
  assert('GRN → 201', grnR.status === 201, grnR.status, 201);
  const poGet2 = await call('GET', `/inventory/purchase-orders/${poId}`, null);
  assert('PO status RECEIVED', poGet2.body?.status === 'RECEIVED', poGet2.body?.status, 'RECEIVED');
  const invR = await call('POST', '/procurement/supplier-invoices', { supplier_id: supplierId, po_id: poId, invoice_number: `SPA-PO-INV-${ts}`, invoice_date: futureDate(0), due_date: futureDate(30), total_amount: 8000 });
  assert('supplier invoice → 201', invR.status === 201, invR.status, 201);
  const supInvId = invR.body?.id;
  const payR = await call('POST', `/procurement/supplier-invoices/${supInvId}/payments`, { amount: 8000, payment_date: futureDate(0), payment_method: 'BANK_TRANSFER' });
  assert('supplier payment → 201', payR.status === 201, payR.status, 201);

  // ════════════════════════ PHASE 12 — reports ══════════════════════════════
  console.log('\n══════ PHASE 12 — Reports ══════');
  for (const [label, path] of [
    ['utilization', '/spa/reports/utilization'],
    ['revenue-per-treatment', '/spa/reports/revenue-per-treatment'],
    ['therapist-productivity', '/spa/reports/therapist-productivity'],
    ['rebooking-rate', '/spa/reports/rebooking-rate'],
  ]) {
    const r = await call('GET', path, null);
    assert(`GET ${label} → 200`, r.status === 200, r.status, 200);
  }

  // ════════════════════════ SUMMARY ═════════════════════════════════════════
  console.log('\n══════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('══════════════════════════════════════════');
  console.log(`  PASS:  ${PASS}`);
  console.log(`  FAIL:  ${FAIL}`);
  console.log(`  TOTAL: ${PASS + FAIL}`);
  if (FAIL > 0) {
    console.log('\nFAILED:');
    results.filter(r => !r.ok).forEach(r => { console.log(`  ✗ ${r.label}\n      expected: ${JSON.stringify(r.expected)}\n      got:      ${JSON.stringify(r.got)}`); });
    process.exit(1);
  }
  console.log('\nALL ASSERTIONS PASSED ✓');
  console.log('Spa & Wellness module is correct end-to-end.');
}

run().catch(e => { console.error('Uncaught:', e.message); process.exit(1); });
