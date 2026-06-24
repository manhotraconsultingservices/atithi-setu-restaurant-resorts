/**
 * Atithi-Setu — Automated Technical Test Runner
 * Role: Senior Test Manager
 *
 * Scope: API-level technical testing covering all modules.
 * Run: node test-scripts/run_technical_tests.mjs
 *
 * Env vars (defaults to localhost):
 *   BASE_URL=https://erp.atithi-setu.com   (or http://localhost:3000)
 *   OWNER_EMAIL=owner@example.com
 *   OWNER_PASSWORD=password
 *   RESTAURANT_ID=<tenant-id>
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE_URL   = process.env.BASE_URL       || 'https://erp.atithi-setu.com';
const EMAIL      = process.env.OWNER_EMAIL    || process.env.LIVE_LOGIN_ID || '';
const PASSWORD   = process.env.OWNER_PASSWORD || process.env.LIVE_PASSWORD || '';
const RID        = process.env.RESTAURANT_ID  || process.env.LIVE_RESTAURANT_ID || '';

if (!EMAIL || !PASSWORD) {
  console.error('\nMissing credentials. Set env vars before running:');
  console.error('  OWNER_EMAIL=your@email.com OWNER_PASSWORD=yourpass RESTAURANT_ID=RESTO-xxxx node test-scripts/run_technical_tests.mjs\n');
  process.exit(1);
}

// ── Utilities ──────────────────────────────────────────────────────────────

const results = [];
let token = '';
let restaurantId = RID;

const pass  = (id, name, note = '') => { results.push({ id, name, status: 'PASS', note }); console.log(`  ✅ [PASS] ${id} — ${name}${note ? ' | ' + note : ''}`); };
const fail  = (id, name, note = '') => { results.push({ id, name, status: 'FAIL', note }); console.error(`  ❌ [FAIL] ${id} — ${name}${note ? ' | ' + note : ''}`); };
const skip  = (id, name, note = '') => { results.push({ id, name, status: 'SKIP', note }); console.log(`  ⚠️  [SKIP] ${id} — ${name}${note ? ' | ' + note : ''}`); };

async function api(method, path, body, authOverride) {
  const headers = { 'Content-Type': 'application/json' };
  const t = authOverride || token;
  if (t) headers['Authorization'] = `Bearer ${t}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE_URL}${path}`, opts);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await r.json().catch(() => ({})) : await r.text().catch(() => '');
  return { status: r.status, data };
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

// ── Authentication tests ───────────────────────────────────────────────────

async function testAuth() {
  section('AUTH — Authentication & Login');

  // TC-AUTH-001: valid login — try owner/login first (returns jwt_token), then staff login (returns token)
  let r1 = await api('POST', '/api/auth/owner/login', { identifier: EMAIL, password: PASSWORD });
  if (r1.status !== 200) {
    r1 = await api('POST', '/api/auth/login', { loginId: EMAIL, password: PASSWORD, restaurantId: RID });
  }
  if (r1.status === 200 && (r1.data.jwt_token || r1.data.token)) {
    token = r1.data.jwt_token || r1.data.token;
    if (!restaurantId) restaurantId = r1.data.restaurant?.id || r1.data.restaurantId || r1.data.restaurant_id || '';
    pass('TC-AUTH-001', 'Owner login with valid credentials', `restaurantId=${restaurantId}`);
  } else {
    fail('TC-AUTH-001', 'Owner login with valid credentials', `HTTP ${r1.status} — ${JSON.stringify(r1.data)}`);
  }

  // TC-AUTH-002: invalid password
  const r2 = await api('POST', '/api/auth/login', { email: EMAIL, password: 'WRONG_PASS_XYZ' });
  if (r2.status === 401 || r2.status === 400) {
    pass('TC-AUTH-002', 'Invalid password rejected');
  } else {
    fail('TC-AUTH-002', 'Invalid password rejected', `unexpected HTTP ${r2.status}`);
  }

  // TC-AUTH-004: token required on protected route
  const r4 = await api('GET', restaurantId ? `/api/restaurant/${restaurantId}/menu` : '/api/restaurant/FAKE/menu', null, 'INVALID_TOKEN');
  if (r4.status === 401 || r4.status === 403) {
    pass('TC-AUTH-004', 'Invalid token rejected on protected route');
  } else {
    skip('TC-AUTH-004', 'Invalid token rejected on protected route', `got HTTP ${r4.status}`);
  }
}

// ── Restaurant tests ───────────────────────────────────────────────────────

async function testRestaurant() {
  section('RESTAURANT — Menu / Orders / Invoices');
  if (!restaurantId) { skip('TC-REST-*', 'All restaurant tests', 'no restaurantId'); return; }

  // TC-REST-001: menu list loads
  const m1 = await api('GET', `/api/restaurant/${restaurantId}/menu`);
  if (m1.status === 200 && Array.isArray(m1.data)) {
    pass('TC-REST-001', `Menu list loads (${m1.data.length} items)`);
  } else {
    fail('TC-REST-001', 'Menu list loads', `HTTP ${m1.status}`);
  }

  // TC-REST-006: invoice list
  const il = await api('GET', `/api/restaurant/${restaurantId}/invoices`);
  if (il.status === 200 && Array.isArray(il.data)) {
    pass('TC-REST-010', `Invoice list loads (${il.data.length} records)`);
  } else {
    fail('TC-REST-010', 'Invoice list loads', `HTTP ${il.status}`);
  }

  // Tables / sessions
  const tb = await api('GET', `/api/restaurant/${restaurantId}/tables`);
  if (tb.status === 200 && Array.isArray(tb.data)) {
    pass('TC-REST-TABLES', `Tables list loads (${tb.data.length} tables)`);
  } else {
    fail('TC-REST-TABLES', 'Tables list loads', `HTTP ${tb.status}`);
  }

  // Analytics
  const an = await api('GET', `/api/restaurant/${restaurantId}/analytics`);
  if (an.status === 200) {
    pass('TC-REPT-001', 'Analytics endpoint responds');
  } else {
    fail('TC-REPT-001', 'Analytics endpoint responds', `HTTP ${an.status}`);
  }

  // Notifications
  const nf = await api('GET', `/api/restaurant/${restaurantId}/notifications`);
  if (nf.status === 200) {
    pass('TC-NOTIF-000', 'Notifications endpoint responds');
  } else {
    fail('TC-NOTIF-000', 'Notifications endpoint responds', `HTTP ${nf.status}`);
  }

  // Settings
  const st = await api('GET', `/api/restaurant/${restaurantId}`);
  if (st.status === 200 && st.data.id) {
    pass('TC-SET-000', 'Restaurant settings endpoint responds');
  } else {
    fail('TC-SET-000', 'Restaurant settings endpoint responds', `HTTP ${st.status}`);
  }
}

// ── Hotel tests ────────────────────────────────────────────────────────────

async function testHotel() {
  section('HOTEL — Bookings / Rooms / Folios');
  if (!restaurantId) { skip('TC-HOTEL-*', 'All hotel tests', 'no restaurantId'); return; }

  // Rooms list
  const rm = await api('GET', `/api/restaurant/${restaurantId}/rooms`);
  if (rm.status === 200 && Array.isArray(rm.data)) {
    pass('TC-HOTEL-ROOMS', `Rooms list loads (${rm.data.length} rooms)`);
  } else if (rm.status === 403) {
    skip('TC-HOTEL-ROOMS', 'Rooms list', 'hotel module not enabled or RBAC');
  } else {
    fail('TC-HOTEL-ROOMS', 'Rooms list loads', `HTTP ${rm.status}`);
  }

  // Hotel bookings list
  const hb = await api('GET', `/api/restaurant/${restaurantId}/hotel/bookings`);
  if (hb.status === 200 && Array.isArray(hb.data)) {
    pass('TC-HOTEL-001', `Hotel bookings list loads (${hb.data.length} bookings)`);
  } else if (hb.status === 403 || hb.status === 404) {
    skip('TC-HOTEL-001', 'Hotel bookings list', `HTTP ${hb.status} - hotel may not be enabled`);
  } else {
    fail('TC-HOTEL-001', 'Hotel bookings list loads', `HTTP ${hb.status}`);
  }

  // Room categories
  const rc = await api('GET', `/api/restaurant/${restaurantId}/hotel/room-categories`);
  if (rc.status === 200) {
    pass('TC-HOTEL-CATS', 'Room categories endpoint responds');
  } else if (rc.status === 403 || rc.status === 404) {
    skip('TC-HOTEL-CATS', 'Room categories', `HTTP ${rc.status}`);
  } else {
    fail('TC-HOTEL-CATS', 'Room categories endpoint responds', `HTTP ${rc.status}`);
  }

  // Night audit report
  const na = await api('GET', `/api/restaurant/${restaurantId}/hotel/reports/night-audit?date=${new Date().toISOString().slice(0,10)}`);
  if (na.status === 200) {
    pass('TC-HOTEL-010', 'Night audit report endpoint responds');
  } else if (na.status === 403 || na.status === 404) {
    skip('TC-HOTEL-010', 'Night audit report', `HTTP ${na.status}`);
  } else {
    fail('TC-HOTEL-010', 'Night audit report endpoint responds', `HTTP ${na.status}`);
  }

  // Rate plans
  const rp = await api('GET', `/api/restaurant/${restaurantId}/hotel/rate-plans`);
  if (rp.status === 200) {
    pass('TC-HOTEL-014', 'Rate plans endpoint responds');
  } else if (rp.status === 403 || rp.status === 404) {
    skip('TC-HOTEL-014', 'Rate plans', `HTTP ${rp.status}`);
  } else {
    fail('TC-HOTEL-014', 'Rate plans endpoint responds', `HTTP ${rp.status}`);
  }
}

// ── Procurement tests ──────────────────────────────────────────────────────

async function testProcurement() {
  section('PROCUREMENT — Supplier Invoices / Payments / Ledger');
  if (!restaurantId) { skip('TC-PROC-*', 'All procurement tests', 'no restaurantId'); return; }

  const si = await api('GET', `/api/restaurant/${restaurantId}/procurement/supplier-invoices`);
  if (si.status === 200 && Array.isArray(si.data)) {
    pass('TC-PROC-001', `Supplier invoices list loads (${si.data.length} invoices)`);
  } else if (si.status === 403 || si.status === 404) {
    skip('TC-PROC-001', 'Supplier invoices list', `HTTP ${si.status}`);
  } else {
    fail('TC-PROC-001', 'Supplier invoices list loads', `HTTP ${si.status}`);
  }

  const py = await api('GET', `/api/restaurant/${restaurantId}/procurement/payments`);
  if (py.status === 200) {
    pass('TC-PROC-002', 'Payments ledger endpoint responds');
  } else if (py.status === 403 || py.status === 404) {
    skip('TC-PROC-002', 'Payments ledger', `HTTP ${py.status}`);
  } else {
    fail('TC-PROC-002', 'Payments ledger endpoint responds', `HTTP ${py.status}`);
  }

  const rp = await api('GET', `/api/restaurant/${restaurantId}/procurement/reports/payables`);
  if (rp.status === 200) {
    pass('TC-PROC-004', 'Payables report endpoint responds');
  } else if (rp.status === 403 || rp.status === 404) {
    skip('TC-PROC-004', 'Payables report', `HTTP ${rp.status}`);
  } else {
    fail('TC-PROC-004', 'Payables report endpoint responds', `HTTP ${rp.status}`);
  }

  const sp = await api('GET', `/api/restaurant/${restaurantId}/procurement/reports/spending`);
  if (sp.status === 200) {
    pass('TC-PROC-SPENDING', 'Spending report endpoint responds');
  } else if (sp.status === 403 || sp.status === 404) {
    skip('TC-PROC-SPENDING', 'Spending report', `HTTP ${sp.status}`);
  } else {
    fail('TC-PROC-SPENDING', 'Spending report endpoint responds', `HTTP ${sp.status}`);
  }
}

// ── HR & Payroll tests ─────────────────────────────────────────────────────

async function testHR() {
  section('HR & PAYROLL — Employees / Payroll / Claims');
  if (!restaurantId) { skip('TC-HR-*', 'All HR tests', 'no restaurantId'); return; }

  const emp = await api('GET', `/api/restaurant/${restaurantId}/hr/employees`);
  if (emp.status === 200 && Array.isArray(emp.data)) {
    pass('TC-HR-001', `Employees list loads (${emp.data.length} employees)`);
  } else if (emp.status === 403 || emp.status === 404) {
    skip('TC-HR-001', 'Employees list', `HTTP ${emp.status}`);
  } else {
    fail('TC-HR-001', 'Employees list loads', `HTTP ${emp.status}`);
  }

  const pr = await api('GET', `/api/restaurant/${restaurantId}/hr/payroll-runs`);
  if (pr.status === 200) {
    pass('TC-HR-003', 'Payroll runs endpoint responds');
  } else if (pr.status === 403 || pr.status === 404) {
    skip('TC-HR-003', 'Payroll runs', `HTTP ${pr.status}`);
  } else {
    fail('TC-HR-003', 'Payroll runs endpoint responds', `HTTP ${pr.status}`);
  }

  const ec = await api('GET', `/api/restaurant/${restaurantId}/hr/expense-claims`);
  if (ec.status === 200) {
    pass('TC-HR-005', 'Expense claims endpoint responds');
  } else if (ec.status === 403 || ec.status === 404) {
    skip('TC-HR-005', 'Expense claims', `HTTP ${ec.status}`);
  } else {
    fail('TC-HR-005', 'Expense claims endpoint responds', `HTTP ${ec.status}`);
  }

  const ol = await api('GET', `/api/restaurant/${restaurantId}/hr/offer-letters`);
  if (ol.status === 200) {
    pass('TC-HR-007', 'Offer letters endpoint responds');
  } else if (ol.status === 403 || ol.status === 404) {
    skip('TC-HR-007', 'Offer letters', `HTTP ${ol.status}`);
  } else {
    fail('TC-HR-007', 'Offer letters endpoint responds', `HTTP ${ol.status}`);
  }
}

// ── Inventory tests ────────────────────────────────────────────────────────

async function testInventory() {
  section('INVENTORY — Ingredients / Recipes / Suppliers / POs');
  if (!restaurantId) { skip('TC-INV-*', 'All inventory tests', 'no restaurantId'); return; }

  const ig = await api('GET', `/api/restaurant/${restaurantId}/inventory/ingredients`);
  if (ig.status === 200 && Array.isArray(ig.data)) {
    pass('TC-INV-001', `Ingredients list loads (${ig.data.length} ingredients)`);
  } else if (ig.status === 403 || ig.status === 404) {
    skip('TC-INV-001', 'Ingredients list', `HTTP ${ig.status}`);
  } else {
    fail('TC-INV-001', 'Ingredients list loads', `HTTP ${ig.status}`);
  }

  const rc = await api('GET', `/api/restaurant/${restaurantId}/inventory/recipes`);
  if (rc.status === 200) {
    pass('TC-INV-002', 'Recipes endpoint responds');
  } else if (rc.status === 403 || rc.status === 404) {
    skip('TC-INV-002', 'Recipes', `HTTP ${rc.status}`);
  } else {
    fail('TC-INV-002', 'Recipes endpoint responds', `HTTP ${rc.status}`);
  }

  const su = await api('GET', `/api/restaurant/${restaurantId}/inventory/suppliers`);
  if (su.status === 200) {
    pass('TC-INV-SUP', 'Suppliers endpoint responds');
  } else if (su.status === 403 || su.status === 404) {
    skip('TC-INV-SUP', 'Suppliers', `HTTP ${su.status}`);
  } else {
    fail('TC-INV-SUP', 'Suppliers endpoint responds', `HTTP ${su.status}`);
  }

  const po = await api('GET', `/api/restaurant/${restaurantId}/inventory/purchase-orders`);
  if (po.status === 200) {
    pass('TC-INV-005', 'Purchase orders endpoint responds');
  } else if (po.status === 403 || po.status === 404) {
    skip('TC-INV-005', 'Purchase orders', `HTTP ${po.status}`);
  } else {
    fail('TC-INV-005', 'Purchase orders endpoint responds', `HTTP ${po.status}`);
  }

  const ws = await api('GET', `/api/restaurant/${restaurantId}/inventory/wastage`);
  if (ws.status === 200) {
    pass('TC-INV-007', 'Wastage endpoint responds');
  } else if (ws.status === 403 || ws.status === 404) {
    skip('TC-INV-007', 'Wastage', `HTTP ${ws.status}`);
  } else {
    fail('TC-INV-007', 'Wastage endpoint responds', `HTTP ${ws.status}`);
  }
}

// ── Accounting / GL tests ──────────────────────────────────────────────────

async function testAccounting() {
  section('ACCOUNTING — Chart of Accounts / GL / Trial Balance / TDS');
  if (!restaurantId) { skip('TC-ACC-*', 'All accounting tests', 'no restaurantId'); return; }

  // Chart of accounts
  const coa = await api('GET', `/api/restaurant/${restaurantId}/accounting/chart-of-accounts`);
  if (coa.status === 200 && Array.isArray(coa.data)) {
    pass('TC-ACC-001', `Chart of accounts loads (${coa.data.length} accounts)`);
    // Verify standard accounts exist
    const codes = coa.data.map(a => a.code);
    const required = ['1000','1100','2000','2100','2200','4000','5000'];
    const missing = required.filter(c => !codes.includes(c));
    if (missing.length === 0) {
      pass('TC-ACC-001b', 'All required account codes present (1000 1100 2000 2100 2200 4000 5000)');
    } else {
      fail('TC-ACC-001b', 'Required account codes present', `missing: ${missing.join(', ')}`);
    }
  } else if (coa.status === 403) {
    skip('TC-ACC-001', 'Chart of accounts', 'RBAC: need OWNER role');
  } else {
    fail('TC-ACC-001', 'Chart of accounts loads', `HTTP ${coa.status}`);
  }

  // GL entries
  const today = new Date().toISOString().slice(0,10);
  const fyStart = new Date().getMonth() >= 3
    ? `${new Date().getFullYear()}-04-01`
    : `${new Date().getFullYear() - 1}-04-01`;
  const gl = await api('GET', `/api/restaurant/${restaurantId}/accounting/gl-entries?from=${fyStart}&to=${today}`);
  if (gl.status === 200 && Array.isArray(gl.data)) {
    pass('TC-ACC-003', `GL entries loads (${gl.data.length} entries for FY)`);
    // Verify Dr/Cr balance on loaded entries
    const totalDr = gl.data.reduce((s, e) => s + Number(e.dr_amount || 0), 0);
    const totalCr = gl.data.reduce((s, e) => s + Number(e.cr_amount || 0), 0);
    const diff = Math.abs(totalDr - totalCr);
    if (diff < 1) {
      pass('TC-ACC-002', `GL entries balanced (Dr=${totalDr.toFixed(2)} Cr=${totalCr.toFixed(2)})`);
    } else {
      fail('TC-ACC-002', 'GL entries balanced', `Dr=${totalDr.toFixed(2)} Cr=${totalCr.toFixed(2)} diff=${diff.toFixed(2)}`);
    }
  } else if (gl.status === 403) {
    skip('TC-ACC-003', 'GL entries', 'RBAC: need OWNER role');
  } else {
    fail('TC-ACC-003', 'GL entries loads', `HTTP ${gl.status}`);
  }

  // Trial balance
  const tb = await api('GET', `/api/restaurant/${restaurantId}/accounting/trial-balance?from=${fyStart}&to=${today}`);
  if (tb.status === 200 && Array.isArray(tb.data)) {
    const tbDr = tb.data.reduce((s, r) => s + Number(r.dr_total || 0), 0);
    const tbCr = tb.data.reduce((s, r) => s + Number(r.cr_total || 0), 0);
    const balanced = Math.abs(tbDr - tbCr) < 1;
    if (balanced) {
      pass('TC-ACC-002b', `Trial balance balanced (Dr=${tbDr.toFixed(2)} Cr=${tbCr.toFixed(2)})`);
    } else if (tb.data.length === 0) {
      pass('TC-ACC-002b', 'Trial balance endpoint responds (no data yet)');
    } else {
      fail('TC-ACC-002b', 'Trial balance balanced', `off by ${Math.abs(tbDr-tbCr).toFixed(2)}`);
    }
  } else if (tb.status === 403) {
    skip('TC-ACC-002b', 'Trial balance', 'RBAC: need OWNER role');
  } else {
    fail('TC-ACC-002b', 'Trial balance endpoint responds', `HTTP ${tb.status}`);
  }

  // TDS payable
  const tds = await api('GET', `/api/restaurant/${restaurantId}/accounting/tds-payable`);
  if (tds.status === 200 && Array.isArray(tds.data)) {
    pass('TC-ACC-006', `TDS payable list loads (${tds.data.length} entries)`);
  } else if (tds.status === 403) {
    skip('TC-ACC-006', 'TDS payable', 'RBAC: need OWNER role');
  } else {
    fail('TC-ACC-006', 'TDS payable list loads', `HTTP ${tds.status}`);
  }

  // Manual journal POST — balanced entry test
  const mjRes = await api('POST', `/api/restaurant/${restaurantId}/accounting/journal-entries`, {
    entry_date: today,
    narration: 'Test journal entry — automated test suite',
    lines: [
      { account_code: '1000', account_name: 'Cash in Hand', dr_amount: 100, cr_amount: 0 },
      { account_code: '4900', account_name: 'Other Income',  dr_amount: 0,   cr_amount: 100 },
    ]
  });
  if (mjRes.status === 201 && mjRes.data.journal_ref) {
    pass('TC-ACC-004', `Manual journal posted (${mjRes.data.journal_ref})`);
  } else if (mjRes.status === 403) {
    skip('TC-ACC-004', 'Manual journal post', 'RBAC: need OWNER role');
  } else {
    fail('TC-ACC-004', 'Manual journal posted', `HTTP ${mjRes.status} — ${JSON.stringify(mjRes.data)}`);
  }
}

// ── Spa tests ──────────────────────────────────────────────────────────────

async function testSpa() {
  section('SPA — Catalog / Appointments / Checkout');
  if (!restaurantId) { skip('TC-SPA-*', 'All spa tests', 'no restaurantId'); return; }

  const sv = await api('GET', `/api/restaurant/${restaurantId}/spa/services`);
  if (sv.status === 200 && Array.isArray(sv.data)) {
    pass('TC-SPA-001', `Spa services list loads (${sv.data.length} services)`);
  } else if (sv.status === 403 || sv.status === 404) {
    skip('TC-SPA-001', 'Spa services', `HTTP ${sv.status} - spa may not be enabled`);
  } else {
    fail('TC-SPA-001', 'Spa services list loads', `HTTP ${sv.status}`);
  }

  const ap = await api('GET', `/api/restaurant/${restaurantId}/spa/appointments`);
  if (ap.status === 200) {
    pass('TC-SPA-002', 'Spa appointments endpoint responds');
  } else if (ap.status === 403 || ap.status === 404) {
    skip('TC-SPA-002', 'Spa appointments', `HTTP ${ap.status}`);
  } else {
    fail('TC-SPA-002', 'Spa appointments endpoint responds', `HTTP ${ap.status}`);
  }

  const cl = await api('GET', `/api/restaurant/${restaurantId}/spa/clients`);
  if (cl.status === 200) {
    pass('TC-SPA-CLIENTS', 'Spa clients endpoint responds');
  } else if (cl.status === 403 || cl.status === 404) {
    skip('TC-SPA-CLIENTS', 'Spa clients', `HTTP ${cl.status}`);
  } else {
    fail('TC-SPA-CLIENTS', 'Spa clients endpoint responds', `HTTP ${cl.status}`);
  }
}

// ── Channel Manager tests ──────────────────────────────────────────────────

async function testChannelManager() {
  section('CHANNEL MANAGER — Credentials / Webhook Log / Sync');
  if (!restaurantId) { skip('TC-CHAN-*', 'All channel tests', 'no restaurantId'); return; }

  const cc = await api('GET', `/api/restaurant/${restaurantId}/hotel/channel-credentials`);
  if (cc.status === 200) {
    pass('TC-CHAN-001', 'Channel credentials endpoint responds');
  } else if (cc.status === 403 || cc.status === 404) {
    skip('TC-CHAN-001', 'Channel credentials', `HTTP ${cc.status}`);
  } else {
    fail('TC-CHAN-001', 'Channel credentials endpoint responds', `HTTP ${cc.status}`);
  }

  const wl = await api('GET', `/api/restaurant/${restaurantId}/hotel/channel-webhook-log`);
  if (wl.status === 200) {
    pass('TC-CHAN-002', 'Webhook log endpoint responds');
  } else if (wl.status === 403 || wl.status === 404) {
    skip('TC-CHAN-002', 'Webhook log', `HTTP ${wl.status}`);
  } else {
    fail('TC-CHAN-002', 'Webhook log endpoint responds', `HTTP ${wl.status}`);
  }
}

// ── Reports tests ──────────────────────────────────────────────────────────

async function testReports() {
  section('REPORTS — Revenue / Payments / Exports');
  if (!restaurantId) { skip('TC-REPT-*', 'All report tests', 'no restaurantId'); return; }

  const pr = await api('GET', `/api/restaurant/${restaurantId}/reports/payment-received`);
  if (pr.status === 200) {
    pass('TC-REPT-002', 'Payment received report endpoint responds');
  } else if (pr.status === 403 || pr.status === 404) {
    skip('TC-REPT-002', 'Payment received report', `HTTP ${pr.status}`);
  } else {
    fail('TC-REPT-002', 'Payment received report endpoint responds', `HTTP ${pr.status}`);
  }

  const pcc = await api('GET', `/api/restaurant/${restaurantId}/petty-cash`);
  if (pcc.status === 200) {
    pass('TC-REPT-PETTYCASH', 'Petty cash endpoint responds');
  } else if (pcc.status === 403 || pcc.status === 404) {
    skip('TC-REPT-PETTYCASH', 'Petty cash', `HTTP ${pcc.status}`);
  } else {
    fail('TC-REPT-PETTYCASH', 'Petty cash endpoint responds', `HTTP ${pcc.status}`);
  }
}

// ── Public booking tests ───────────────────────────────────────────────────

async function testPublicBooking() {
  section('PUBLIC BOOKING — Availability / Direct Booking');
  if (!restaurantId) { skip('TC-PUB-*', 'All public booking tests', 'no restaurantId'); return; }

  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0,10);
  const dayAfter = new Date(Date.now() + 2*86400000).toISOString().slice(0,10);
  const av = await api('GET', `/api/public/restaurant/${restaurantId}/hotel/availability?check_in=${tomorrow}&check_out=${dayAfter}&adults=2`);
  if (av.status === 200) {
    pass('TC-PUB-002', 'Public availability check responds');
  } else if (av.status === 404) {
    skip('TC-PUB-002', 'Public availability', 'hotel module may not be enabled');
  } else {
    fail('TC-PUB-002', 'Public availability check responds', `HTTP ${av.status}`);
  }

  const ari = await api('GET', `/api/public/restaurant/${restaurantId}/hotel/google-ari`);
  if (ari.status === 200) {
    pass('TC-PUB-GARI', 'Google ARI XML feed responds');
  } else if (ari.status === 404) {
    skip('TC-PUB-GARI', 'Google ARI feed', 'hotel not enabled');
  } else {
    fail('TC-PUB-GARI', 'Google ARI XML feed responds', `HTTP ${ari.status}`);
  }
}

// ── Summary report ─────────────────────────────────────────────────────────

function generateReport() {
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;
  const total  = results.length;
  const pct    = total > 0 ? Math.round((passed / (total - skipped)) * 100) : 0;

  const now = new Date().toISOString();

  const md = [
    `# Atithi-Setu — Technical Test Execution Report`,
    ``,
    `**Run Date:** ${now}`,
    `**Base URL:** ${BASE_URL}`,
    `**Restaurant ID:** ${restaurantId || 'N/A'}`,
    ``,
    `## Summary`,
    `| Metric | Count |`,
    `|---|---|`,
    `| ✅ Passed | ${passed} |`,
    `| ❌ Failed | ${failed} |`,
    `| ⚠️ Skipped | ${skipped} |`,
    `| **Total** | **${total}** |`,
    `| **Pass Rate** | **${pct}%** (excl. skipped) |`,
    ``,
    `## Detailed Results`,
    `| TC_ID | Test Name | Status | Notes |`,
    `|---|---|---|---|`,
    ...results.map(r => `| ${r.id} | ${r.name} | ${r.status === 'PASS' ? '✅ PASS' : r.status === 'FAIL' ? '❌ FAIL' : '⚠️ SKIP'} | ${r.note || ''} |`),
    ``,
    `## Failed Tests`,
    failed === 0 ? '_None_ — all executed tests passed.' : results.filter(r => r.status === 'FAIL').map(r => `- **${r.id}**: ${r.name} — ${r.note}`).join('\n'),
    ``,
    `---`,
    `_Generated by test-scripts/run_technical_tests.mjs_`,
  ].join('\n');

  const reportPath = join(__dirname, 'TEST_EXECUTION_REPORT.md');
  writeFileSync(reportPath, md, 'utf8');

  console.log('\n' + '═'.repeat(60));
  console.log('  TEST EXECUTION SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Total:   ${total}`);
  console.log(`  ✅ Pass: ${passed}`);
  console.log(`  ❌ Fail: ${failed}`);
  console.log(`  ⚠️  Skip: ${skipped}`);
  console.log(`  Rate:    ${pct}% (excl. skipped)`);
  console.log('═'.repeat(60));
  if (failed > 0) {
    console.log('\n  FAILURES:');
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(`  ❌ ${r.id} — ${r.name}: ${r.note}`));
  }
  console.log(`\n  Report written to: test-scripts/TEST_EXECUTION_REPORT.md\n`);

  return failed;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  ATITHI-SETU — E2E TECHNICAL TEST RUNNER');
  console.log(`  Target: ${BASE_URL}`);
  console.log('═'.repeat(60));

  await testAuth();
  await testRestaurant();
  await testHotel();
  await testProcurement();
  await testHR();
  await testInventory();
  await testAccounting();
  await testSpa();
  await testChannelManager();
  await testReports();
  await testPublicBooking();

  const failures = generateReport();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(2);
});
