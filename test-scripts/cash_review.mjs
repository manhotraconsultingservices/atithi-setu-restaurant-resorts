/**
 * Cash Review — READ-ONLY. Shows how cash entries (hotel + restaurant + others)
 * are showing in the accounting module, grouped by source. Writes nothing.
 *
 * Run (PowerShell):
 *   $env:OWNER_EMAIL='you@example.com'; $env:RESTAURANT_ID='RESTO-1003'
 *   $env:OWNER_PASSWORD='***'; $env:FROM='2026-08-01'; $env:TO='2026-08-16'
 *   node test-scripts/cash_review.mjs
 *
 * FROM/TO default to the current month-to-date.
 */
const BASE = process.env.BASE_URL || 'https://erp.atithi-setu.com';
const EMAIL = process.env.OWNER_EMAIL || '';
const PASSWORD = process.env.OWNER_PASSWORD || '';
const RID = process.env.RESTAURANT_ID || '';
const today = new Date().toISOString().slice(0, 10);
const FROM = process.env.FROM || (today.slice(0, 8) + '01');
const TO = process.env.TO || today;
if (!EMAIL || !PASSWORD || !RID) { console.error('Set OWNER_EMAIL, OWNER_PASSWORD, RESTAURANT_ID'); process.exit(1); }

const fmt = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const LABEL = {
  FNB_ORDER: 'Restaurant (F&B)',
  FOLIO_SETTLEMENT: 'Hotel / Spa / Events — folio settlement',
  FOLIO_ADVANCE: 'Hotel — advance at check-in',
  EVENT_ADVANCE: 'Events — advance',
  PETTY_CASH: 'Petty cash',
  CASH_DRAWER_DEPOSIT: 'Cash drawer — deposit to bank (out)',
  CASH_DRAWER_VARIANCE: 'Cash drawer — over/short',
  CASH_COUNT: 'Cash count — variance',
  SADV: 'Staff advance (out)',
  SUPPLIER_PAYMENT: 'Supplier payment (out)',
  MANUAL_JOURNAL: 'Manual journal',
};

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json().catch(() => ({})) : await r.text() };
}

function summarise(rows, acctLabel) {
  const by = {};
  for (const e of rows) {
    const s = e.source_type || 'UNKNOWN';
    by[s] = by[s] || { in: 0, out: 0, n: 0 };
    by[s].in += Number(e.dr_amount || 0);   // debit to a cash/bank asset = money IN
    by[s].out += Number(e.cr_amount || 0);  // credit = money OUT
    by[s].n++;
  }
  const keys = Object.keys(by).sort((a, b) => (by[b].in - by[b].out) - (by[a].in - by[a].out));
  console.log(`\n  ${acctLabel}  (${FROM} → ${TO})`);
  console.log('  ' + '─'.repeat(78));
  console.log('  ' + 'Source'.padEnd(42) + 'In'.padStart(14) + 'Out'.padStart(12) + '  n');
  console.log('  ' + '─'.repeat(78));
  let tin = 0, tout = 0, tn = 0;
  for (const k of keys) {
    const v = by[k]; tin += v.in; tout += v.out; tn += v.n;
    console.log('  ' + (LABEL[k] || k).padEnd(42) + fmt(v.in).padStart(14) + fmt(v.out).padStart(12) + `  ${v.n}`);
  }
  console.log('  ' + '─'.repeat(78));
  console.log('  ' + 'TOTAL'.padEnd(42) + fmt(tin).padStart(14) + fmt(tout).padStart(12) + `  ${tn}`);
  console.log('  ' + `NET movement: ${fmt(tin - tout)}`);
}

(async () => {
  let login = await api('POST', '/api/auth/owner/login', { identifier: EMAIL, password: PASSWORD });
  if (login.status !== 200) login = await api('POST', '/api/auth/login', { loginId: EMAIL, password: PASSWORD, restaurantId: RID });
  const token = login.data?.jwt_token || login.data?.token;
  if (!token) { console.error('Login failed:', login.status, JSON.stringify(login.data).slice(0, 160)); process.exit(1); }
  console.log(`\n════ CASH REVIEW — ${RID} ════`);

  const cash = await api('GET', `/api/restaurant/${RID}/accounting/gl-entries?account=1000&from=${FROM}&to=${TO}`, null, token);
  if (Array.isArray(cash.data)) summarise(cash.data, '💵 CASH IN HAND (account 1000) — how much cash came from where');
  else console.error('cash ledger error', cash.status, cash.data);

  const bank = await api('GET', `/api/restaurant/${RID}/accounting/gl-entries?account=1010&from=${FROM}&to=${TO}`, null, token);
  if (Array.isArray(bank.data)) summarise(bank.data, '🏦 BANK / CARD / UPI (account 1010) — non-cash tenders');

  const cb = await api('GET', `/api/restaurant/${RID}/accounting/cash-book?date=${TO}`, null, token);
  if (cb.status === 200 && cb.data?.cash_in_hand) {
    const c = cb.data.cash_in_hand, b = cb.data.bank;
    console.log(`\n  📒 CASH BOOK position on ${TO} (the combined view the app shows):`);
    console.log(`     Cash in Hand — closing: ${fmt(c.closing)}   (opening ${fmt(c.opening)} + in ${fmt(c.in)} − out ${fmt(c.out)})`);
    console.log(`     Bank         — closing: ${fmt(b?.closing)}`);
    console.log(`     Total cash position:    ${fmt(cb.data.total_cash_position)}`);
  }
  console.log('\n  ↳ In the app: Accounting → Ledger → GL Ledger, Account = 1000, to see each of these lines individually (Source column = hotel vs restaurant).\n');
})();
