// Sprint 2 T6: OTA commission posted on checkout for GOIBIBO booking
import https from 'https';

const BASE = 'https://erp.atithi-setu.com';
const TENANT = 'RESTO-1003';
const OTA_BOOKING_ID = 'OTA-SEED-RESTO1-0154'; // GOIBIBO booking

function req(method, path, body, token) {
  const url = new URL(BASE + path);
  const postData = body ? JSON.stringify(body) : null;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
    },
  };
  return new Promise((resolve, reject) => {
    const r = https.request(url, opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (postData) r.write(postData);
    r.end();
  });
}

const login = await req('POST', '/api/auth/login', { loginId: 'ADMIN-ANKUSH', password: 'admin123' });
if (!login.body.token) { console.error('LOGIN FAILED'); process.exit(1); }
const token = login.body.token;
console.log('✓ Logged in');

// Verify GOIBIBO partner account exists with commission_pct
const pa = await req('GET', `/api/restaurant/${TENANT}/hotel/partner-accounts`, null, token);
const goibiboAcct = (Array.isArray(pa.body) ? pa.body : []).find(a => a.partner_ref === 'GOIBIBO');
if (!goibiboAcct) { console.error('No GOIBIBO partner account found — create one first'); process.exit(1); }
console.log(`\n✓ GOIBIBO partner account: commission_pct=${goibiboAcct.commission_pct}%`);

// Check OTA commissions before checkout
const before = await req('GET', `/api/restaurant/${TENANT}/hotel/ota-commissions?period=2026-06`, null, token);
const rowsBefore = (before.body?.rows || []).length;
console.log(`\nOTA commission rows before: ${rowsBefore}`);

// Checkout the GOIBIBO booking (waive=true)
console.log(`\nCheckout ${OTA_BOOKING_ID} (booking_source=GOIBIBO)...`);
const coRes = await req('POST', `/api/restaurant/${TENANT}/hotel/bookings/${OTA_BOOKING_ID}/checkout`, {
  payment_method: 'CASH',
  waive: true,
}, token);
console.log(`Checkout HTTP ${coRes.status}`);
if (coRes.status !== 200) {
  console.error('Checkout failed:', JSON.stringify(coRes.body));
  process.exit(1);
}
const folio = coRes.body?.folio;
console.log(`Folio: ${folio?.id} status=${folio?.status} subtotal=${folio?.subtotal}`);

// Wait for fire-and-forget
await new Promise(r => setTimeout(r, 2000));

// Check OTA commissions after checkout
const after = await req('GET', `/api/restaurant/${TENANT}/hotel/ota-commissions?period=2026-06`, null, token);
const rowsAfter = (after.body?.rows || []).length;
const newRows = (after.body?.rows || []).filter(r => r.booking_id === OTA_BOOKING_ID);
console.log(`\nOTA commission rows after: ${rowsAfter} (${rowsAfter - rowsBefore} new)`);
console.log(`Rows for booking ${OTA_BOOKING_ID}: ${newRows.length}`);

if (newRows.length > 0) {
  const r = newRows[0];
  console.log(`\n  channel:        ${r.channel}`);
  console.log(`  commission_pct: ${r.commission_pct}%`);
  console.log(`  revenue_base:   ${r.revenue_base}`);
  console.log(`  commission_amt: ${r.commission_amt}`);
  console.log(`  period:         ${r.period}`);
  // Verify math
  const expected = Math.round(r.revenue_base * r.commission_pct / 100 * 100) / 100;
  const mathOk = Math.abs(expected - r.commission_amt) < 0.01;
  console.log(`\n  Math check: ${r.revenue_base} × ${r.commission_pct}% = ${expected} → ${mathOk ? 'PASS' : 'FAIL (got ' + r.commission_amt + ')'}`);
  console.log('\n✓ T6 PASS: OTA commission entry created at checkout');
} else {
  console.log('\n✗ T6 FAIL: No OTA commission entry created');
  console.log('All rows:', JSON.stringify(after.body?.rows, null, 2));
}

console.log('\nBy channel:', JSON.stringify(after.body?.by_channel));
console.log('Total commission 2026-06:', after.body?.total_commission);
