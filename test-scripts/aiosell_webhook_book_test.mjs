// Aiosell inbound-webhook booking test — proves an OTA reservation becomes a PMS
// booking (aiosellIngestReservation) end-to-end, WITHOUT anyone pasting secrets.
//
// It reads the Basic-Auth credentials + hotel code from the ENVIRONMENT, so the
// secret never appears on a command line or in this file. Point BASE_URL at your
// local server or the live subdomain.
//
// Run (bash):
//   WEBHOOK_USER='...' WEBHOOK_PASS='...' HOTEL_CODE='...' \
//   BASE_URL='http://localhost:3000' ROOM_CODE='executive' RATEPLAN_CODE='executive-d-cp' \
//   node test-scripts/aiosell_webhook_book_test.mjs
//
// Run (PowerShell):
//   $env:WEBHOOK_USER='...'; $env:WEBHOOK_PASS='...'; $env:HOTEL_CODE='...'
//   $env:BASE_URL='http://localhost:3000'; $env:ROOM_CODE='executive'; $env:RATEPLAN_CODE='executive-d-cp'
//   node test-scripts/aiosell_webhook_book_test.mjs
//
// Flags:  --cancel   send a cancel for BOOKING_ID (defaults to the same id it books)
//
// Required env: WEBHOOK_USER, WEBHOOK_PASS, HOTEL_CODE
// Optional env: BASE_URL (default https://manhotra-consulting.atithi-setu.com),
//               CHANNEL (booking.com), ROOM_CODE (executive), RATEPLAN_CODE (executive-d-cp),
//               CHECKIN / CHECKOUT (YYYY-MM-DD; default ~20 nights out, 2-night stay),
//               BOOKING_ID (default TEST-<timestamp>), AMOUNT (7000), COMMISSION (1050)

const env = process.env;
const BASE_URL = (env.BASE_URL || 'https://manhotra-consulting.atithi-setu.com').replace(/\/+$/, '');
const URL = `${BASE_URL}/api/public/aiosell/reservation`;
const missing = ['WEBHOOK_USER', 'WEBHOOK_PASS', 'HOTEL_CODE'].filter((k) => !env[k]);
if (missing.length) {
  console.error(`\n\x1b[31mMissing env:\x1b[0m ${missing.join(', ')}`);
  console.error('Set them in your shell (do NOT put secrets on the command line if you can avoid it), then re-run.\n');
  process.exit(2);
}

const cancel = process.argv.includes('--cancel');
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const CHECKIN = env.CHECKIN || iso(Date.now() + 20 * 86400000);
const CHECKOUT = env.CHECKOUT || iso(Date.now() + 22 * 86400000);
const BOOKING_ID = env.BOOKING_ID || `TEST-${Date.now()}`;
const CHANNEL = env.CHANNEL || 'booking.com';
const ROOM_CODE = env.ROOM_CODE || 'executive';
const RATEPLAN_CODE = env.RATEPLAN_CODE || 'executive-d-cp';
const AMOUNT = Number(env.AMOUNT || 7000);
const COMMISSION = Number(env.COMMISSION || 1050);

const payload = cancel
  ? { action: 'cancel', hotelCode: env.HOTEL_CODE, bookingId: BOOKING_ID, channel: CHANNEL }
  : {
      action: 'book',
      hotelCode: env.HOTEL_CODE,
      bookingId: BOOKING_ID,
      channel: CHANNEL,
      checkin: CHECKIN,
      checkout: CHECKOUT,
      pah: true,
      guest: { firstName: 'Test', lastName: 'Guest', phone: '9999999999', email: 'test@example.com' },
      rooms: [{
        roomCode: ROOM_CODE,
        rateplanCode: RATEPLAN_CODE,
        occupancy: { adults: 2, children: 0 },
        guestName: 'Test Guest',
        prices: [{ sellRate: AMOUNT / 2 }, { sellRate: AMOUNT / 2 }],
      }],
      amount: { amountAfterTax: AMOUNT, commission: COMMISSION },
    };

const authHeader = 'Basic ' + Buffer.from(`${env.WEBHOOK_USER}:${env.WEBHOOK_PASS}`).toString('base64');

console.log(`\n→ POST ${URL}`);
console.log(`  action=${payload.action}  hotelCode=${payload.hotelCode}  bookingId=${BOOKING_ID}  channel=${CHANNEL}`);
if (!cancel) console.log(`  room=${ROOM_CODE}/${RATEPLAN_CODE}  stay=${CHECKIN}→${CHECKOUT}  amount=${AMOUNT}`);
console.log('  (credentials read from env — not shown)\n');

try {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  console.log(`HTTP ${res.status}`);
  console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2));

  if (res.status === 401) console.log('\n\x1b[33m401\x1b[0m — Basic Auth rejected. WEBHOOK_USER/WEBHOOK_PASS must be your Aiosell Setup username+password (or the platform AIOSELL_WEBHOOK_* creds).');
  else if (res.status === 404) console.log('\n\x1b[33m404\x1b[0m — HOTEL_CODE is not a registered/enabled property. Check the exact code in Aiosell → Setup.');
  else if (res.status === 400 && /mapping/i.test(text)) console.log('\n\x1b[33m400\x1b[0m — ROOM_CODE/RATEPLAN_CODE is not one of your mapped pairs (Aiosell → Room mapping).');
  else if (res.ok && body?.success) console.log(`\n\x1b[32m✓ Booking ${payload.action} processed.\x1b[0m local booking_id=${body.booking_id}. Check Front Desk → Hotel Bookings + Aiosell → Sync Log (↓ inbound).`);

  process.exit(res.ok ? 0 : 1);
} catch (e) {
  console.error('\n\x1b[31mRequest failed:\x1b[0m', e?.message || e);
  console.error('If BASE_URL is a localhost server, make sure it is running.');
  process.exit(1);
}
