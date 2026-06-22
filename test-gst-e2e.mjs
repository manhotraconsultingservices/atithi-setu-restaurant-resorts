// Sprint 2 E2E: checkout → GST register auto-populated (fire-and-forget path)
import https from 'https';

const BASE = 'https://erp.atithi-setu.com';
const TENANT = 'RESTO-1003';

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
if (login.status !== 200 || !login.body.token) { console.error('LOGIN FAILED:', JSON.stringify(login.body)); process.exit(1); }
const token = login.body.token;
console.log('✓ Logged in');

// ── Find a CHECKED_IN booking to checkout ────────────────────────────
const bookingsRes = await req('GET', `/api/restaurant/${TENANT}/hotel/bookings?status=CHECKED_IN`, null, token);
// endpoint returns plain array
const bookings = Array.isArray(bookingsRes.body) ? bookingsRes.body : [];
const today = new Date().toISOString().slice(0, 10);
const overdue = bookings.filter(b => (b.check_out_date || '').slice(0, 10) <= today);
const b = overdue[0] || bookings[0];
if (!b) {
  console.log('No CHECKED_IN bookings found');
  // Try to create a booking and check in, then check out
  await createAndCheckoutFresh(token);
  process.exit(0);
}
console.log(`\nUsing booking: ${b.id} / ${b.guest_name}`);

// ── GST rows before checkout ─────────────────────────────────────────
const beforeReg = await req('GET', `/api/restaurant/${TENANT}/hotel/gst-register?period=2026-06`, null, token);
const rowsBefore = (beforeReg.body?.rows || []).length;
console.log(`GST rows before checkout: ${rowsBefore}`);

// ── Checkout ─────────────────────────────────────────────────────────
const coRes = await req('POST', `/api/restaurant/${TENANT}/hotel/bookings/${b.id}/checkout`, {
  payment_method: 'CASH',
  waive: true,
}, token);
console.log(`\nCheckout HTTP ${coRes.status}`);
if (coRes.status !== 200) { console.error('Checkout failed:', JSON.stringify(coRes.body)); process.exit(1); }
const settledFolio = coRes.body?.folio;
console.log(`Folio: ${settledFolio?.id} status=${settledFolio?.status}`);

// Wait for fire-and-forget
await new Promise(r => setTimeout(r, 2000));

// ── GST rows after checkout ─────────────────────────────────────────
const afterReg = await req('GET', `/api/restaurant/${TENANT}/hotel/gst-register?period=2026-06`, null, token);
const rowsAfter = (afterReg.body?.rows || []).length;
const newRows = (afterReg.body?.rows || []).filter(r => r.folio_id === settledFolio?.id);
console.log(`\nGST rows after checkout: ${rowsAfter} (${rowsAfter - rowsBefore} new)`);
console.log(`Rows for folio ${settledFolio?.id}: ${newRows.length}`);

if (newRows.length > 0) {
  const row = newRows[0];
  console.log(`  entry_type:    ${row.entry_type}`);
  console.log(`  taxable_value: ${row.taxable_value}`);
  console.log(`  cgst:          ${row.cgst_rate}% = ${row.cgst_amount}`);
  console.log(`  sgst:          ${row.sgst_rate}% = ${row.sgst_amount}`);
  console.log(`  total_gst:     ${row.total_gst}`);
  console.log(`  hsn_sac:       ${row.hsn_sac}`);
  console.log(`  period:        ${row.period}`);
  console.log('\n✓ T3 PASS: GST register auto-populated on checkout (fire-and-forget hook works)');
} else {
  console.log('\n✗ T3 FAIL: GST register NOT auto-populated');
  const bfRes = await req('POST', `/api/restaurant/${TENANT}/hotel/gst-register/backfill`, { folio_id: settledFolio?.id }, token);
  console.log('Backfill diagnostic:', JSON.stringify(bfRes.body, null, 2));
}

// ── T5: Idempotency ─────────────────────────────────────────────────
if (settledFolio?.id) {
  const bf2 = await req('POST', `/api/restaurant/${TENANT}/hotel/gst-register/backfill`, { folio_id: settledFolio.id }, token);
  const before2 = bf2.body?.gst_rows_before;
  const after2  = bf2.body?.gst_rows_after;
  if (before2 === after2 && after2 > 0) {
    console.log(`\n✓ T5 PASS: Idempotent (${before2} rows, backfill is no-op after checkout)`);
  } else {
    console.log(`\n✗ T5 FAIL: before=${before2} after=${after2}`);
  }
}

console.log('\nGST Register Summary (2026-06):', JSON.stringify(afterReg.body?.summary));
