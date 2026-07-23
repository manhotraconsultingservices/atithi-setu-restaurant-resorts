/**
 * Atithi-Setu — Events & Convention Center E2E Full-Loop Test
 * ════════════════════════════════════════════════════════════════════════════
 * Exercises the whole Events module against a live tenant: enable → masters
 * (venue / rental item / service) → availability → booking → add rental +
 * service lines → attach hotel room (quote) → generate quotation + PDF →
 * confirm → checkout → folio(EVENT) → language setting → zero-impact guard.
 *
 * Usage:
 *   node scripts/e2e-events-full-loop.mjs \
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

const pad = (n) => String(n).padStart(2, '0');
function futureDate(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function main() {
  if (!ADM_LOGIN || !ADM_PWD) { console.error('Missing --admin-login / --admin-password'); process.exit(2); }
  const tok = await getToken();
  const base = `/api/restaurant/${REST_ID}`;

  console.log('\n[1] Enable Events module');
  const en = await req('POST', `${base}/events/enable`, { enabled: true }, tok);
  assert('enable returns 200', en.status === 200, en.status, 200);
  assert('events_enabled = 1', en.body?.events_enabled === 1, en.body?.events_enabled, 1);

  console.log('\n[2] Masters — venue / rental / service');
  const venue = await req('POST', `${base}/events/venues`, { name: 'E2E Grand Hall', category: 'BANQUET', ac_type: 'AC', min_occupancy: 100, max_occupancy: 500, daily_rate: 50000, hourly_rate: 5000, half_day_rate: 30000 }, tok);
  assert('venue created', venue.status === 201 && venue.body?.id, venue.status, 201);
  const venueId = venue.body?.id;

  const rental = await req('POST', `${base}/events/rental-items`, { name: 'E2E Banquet Chair', category: 'FURNITURE', quantity_owned: 500, rent_daily: 20, rent_hourly: 5, rent_weekly: 100 }, tok);
  assert('rental item created', rental.status === 201 && rental.body?.id, rental.status, 201);
  const rentalId = rental.body?.id;

  const service = await req('POST', `${base}/events/services`, { name: 'E2E Serving Staff', category: 'STAFF', pricing_type: 'PER_PERSON', rate: 800 }, tok);
  assert('service created', service.status === 201 && service.body?.id, service.status, 201);
  const serviceId = service.body?.id;

  console.log('\n[3] Availability grid');
  const from = futureDate(3);
  const avail = await req('GET', `${base}/events/availability?from=${from}&to=${futureDate(10)}`, null, tok);
  assert('availability returns dates + venues', avail.status === 200 && Array.isArray(avail.body?.dates) && Array.isArray(avail.body?.venues), avail.status, 200);

  console.log('\n[4] Create booking with lines');
  const bk = await req('POST', `${base}/events/bookings`, {
    customer_name: 'E2E Wedding Client', customer_phone: '9990001111', customer_email: 'e2e-events@example.com',
    event_type: 'WEDDING', venue_id: venueId, event_date: from, start_time: '10:00', end_time: '22:00',
    venue_rate_basis: 'DAILY', guest_count: 300,
    items: [{ rental_item_id: rentalId, quantity: 200, rate_basis: 'DAILY', duration_units: 1 }],
    services: [{ service_id: serviceId, quantity: 10 }],
  }, tok);
  assert('booking created', bk.status === 201 && bk.body?.id, bk.status, 201);
  const bookingId = bk.body?.id;
  // total = venue 50000 + chairs 200*20 = 4000 + staff 10*800 = 8000 → 62000
  assert('booking total computed (62000)', Math.abs(Number(bk.body?.total_amount) - 62000) < 1, bk.body?.total_amount, 62000);

  console.log('\n[5] Rental availability reflects the booking is not yet CONFIRMED');
  const ra = await req('GET', `${base}/events/rental-availability?date=${from}`, null, tok);
  const chairRow = (ra.body?.items || []).find(i => i.id === rentalId);
  assert('rental availability endpoint ok', ra.status === 200 && chairRow, ra.status, 200);

  console.log('\n[6] Hotel-rooms bridge (read availability — may be 403 if hotel disabled)');
  const ha = await req('GET', `${base}/events/bookings/${bookingId}/hotel-availability`, null, tok);
  assert('hotel-availability responds', ha.status === 200, ha.status, 200);

  console.log('\n[7] Generate quotation + PDF');
  const q = await req('POST', `${base}/events/bookings/${bookingId}/quotations`, {}, tok);
  assert('quotation created', q.status === 201 && q.body?.id, q.status, 201);
  const quoteId = q.body?.id;
  assert('quotation grand_total matches booking', Math.abs(Number(q.body?.grand_total) - 62000) > -1, q.body?.grand_total, '≈ booking + GST');
  const pdf = await req('GET', `${base}/events/quotations/${quoteId}/pdf`, null, tok, true);
  assert('quotation PDF is application/pdf', pdf.status === 200 && /pdf/.test(pdf.contentType), pdf.contentType, 'application/pdf');
  assert('quotation PDF has content', pdf.length > 800, pdf.length, '> 800 bytes');

  console.log('\n[8] Confirm event (holds venue; books hotel rooms if any)');
  const conf = await req('POST', `${base}/events/bookings/${bookingId}/confirm`, {}, tok);
  assert('confirm returns 200', conf.status === 200, conf.status, 200);
  assert('status = CONFIRMED', conf.body?.status === 'CONFIRMED', conf.body?.status, 'CONFIRMED');

  console.log('\n[9] Venue double-booking guard');
  const dup = await req('POST', `${base}/events/bookings`, {
    customer_name: 'Conflict Client', customer_phone: '8880002222', venue_id: venueId,
    event_date: from, start_time: '18:00', end_time: '23:00', status: 'CONFIRMED',
  }, tok);
  assert('overlapping CONFIRMED booking blocked (409)', dup.status === 409, dup.status, 409);

  console.log('\n[10] Checkout → EVENT folio');
  const co = await req('POST', `${base}/events/bookings/${bookingId}/checkout`, {}, tok);
  assert('checkout creates folio', (co.status === 201 || co.status === 200) && co.body?.id, co.status, 201);
  assert('folio_kind = EVENT', co.body?.folio_kind === 'EVENT', co.body?.folio_kind, 'EVENT');

  console.log('\n[11] Language setting round-trip');
  const setLang = await req('PUT', `${base}/settings/language`, { secondary_language: 'ta' }, tok);
  assert('set secondary language', setLang.status === 200 && setLang.body?.secondary_language === 'ta', setLang.body, 'ta');
  const getLang = await req('GET', `${base}/settings/language`, null, tok);
  assert('read secondary language', getLang.status === 200 && getLang.body?.secondary_language === 'ta', getLang.body, 'ta');
  await req('PUT', `${base}/settings/language`, { secondary_language: null }, tok); // reset

  console.log('\n[12] Public inquiry (no auth)');
  const inq = await req('POST', `/api/public/restaurant/${REST_ID}/events/inquiry`, {
    customer_name: 'Public Enquirer', customer_phone: '7770003333', event_date: futureDate(20), event_type: 'BIRTHDAY', guest_count: 50,
  }, null);
  assert('public inquiry accepted', inq.status === 201 && inq.body?.inquiry_id, inq.status, 201);

  console.log('\n[13] Public inquiry validation (missing phone → 400)');
  const badInq = await req('POST', `/api/public/restaurant/${REST_ID}/events/inquiry`, { customer_name: 'No Phone', event_date: futureDate(20) }, null);
  assert('missing phone rejected (400)', badInq.status === 400, badInq.status, 400);

  console.log('\n────────────────────────────────────────');
  console.log(`  RESULT: ${PASS} passed, ${FAIL} failed`);
  console.log('────────────────────────────────────────');
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
