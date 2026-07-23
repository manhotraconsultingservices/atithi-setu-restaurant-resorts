/**
 * Atithi-Setu — Events & Convention Center — production-grade demo seeder
 * ════════════════════════════════════════════════════════════════════════════
 * Enables the Events module for a tenant and seeds realistic venues, rental
 * inventory, add-on services, bookings across the full lifecycle
 * (Inquiry → Quoted → Confirmed → Completed), quotations, and the public page.
 *
 * Safe to point at production. Requires a SUPER_ADMIN / CTO login (needed to
 * enable the module). Idempotency: refuses to run if the tenant already has
 * venues, unless you pass --force (which will create duplicates).
 *
 * Usage:
 *   node scripts/seed-events-demo.mjs \
 *     --server https://viveks-cafe.atithi-setu.com \
 *     --restaurant RESTO-1003 \
 *     --admin-login <SUPER_ADMIN login id> \
 *     --admin-password <password> \
 *     [--force]
 */
import https from 'https';
import http from 'http';
import { URL } from 'url';

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const has = (flag) => args.includes(flag);
const SERVER = get('--server') || 'https://viveks-cafe.atithi-setu.com';
const REST_ID = get('--restaurant') || 'RESTO-1003';
const ADM_LOGIN = get('--admin-login');
const ADM_PWD = get('--admin-password');
const FORCE = has('--force');

if (!ADM_LOGIN || !ADM_PWD) {
  console.error('Missing --admin-login / --admin-password (must be SUPER_ADMIN or CTO).');
  process.exit(2);
}

function req(method, path, body, tok) {
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
      res.on('end', () => { let j; try { j = JSON.parse(data); } catch { j = data; } resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const pad = (n) => String(n).padStart(2, '0');
function dayOffset(days) { const d = new Date(Date.now() + days * 86400000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

let created = { venues: 0, rentals: 0, services: 0, bookings: 0, quotations: 0 };
async function must(label, r, okCodes = [200, 201]) {
  if (!okCodes.includes(r.status)) { console.error(`  ✗ ${label} — HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`); throw new Error(label); }
  console.log(`  ✓ ${label}`);
  return r.body;
}

// ── Data ─────────────────────────────────────────────────────────────────────
const VENUES = [
  { name: 'Grand Ballroom', category: 'BANQUET', ac_type: 'AC', min_occupancy: 200, max_occupancy: 500, floor_area: '8000 sq ft', hourly_rate: 8000, half_day_rate: 45000, daily_rate: 75000, amenities: 'Stage, LED wall, green rooms, valet, central AC, backup power' },
  { name: 'Emerald Garden Lawn', category: 'LAWN', ac_type: 'NON_AC', min_occupancy: 300, max_occupancy: 800, floor_area: '15000 sq ft', hourly_rate: 6000, half_day_rate: 35000, daily_rate: 60000, amenities: 'Open-air, mandap area, water feature, parking for 150 cars' },
  { name: 'Emerald Hall', category: 'PARTY_HALL', ac_type: 'AC', min_occupancy: 80, max_occupancy: 200, floor_area: '3200 sq ft', hourly_rate: 5000, half_day_rate: 25000, daily_rate: 40000, amenities: 'Dance floor, DJ console, bar counter, AC' },
  { name: 'Sahyadri Boardroom', category: 'CONFERENCE', ac_type: 'AC', min_occupancy: 20, max_occupancy: 60, floor_area: '1200 sq ft', hourly_rate: 2000, half_day_rate: 9000, daily_rate: 15000, amenities: 'Projector, video-conf, whiteboard, high-speed Wi-Fi' },
];

const RENTALS = [
  { name: 'Round Table (10-seater)', category: 'FURNITURE', unit: 'piece', quantity_owned: 60, rent_hourly: 40, rent_daily: 200, rent_weekly: 1000, deposit: 500 },
  { name: 'Banquet Chair', category: 'FURNITURE', unit: 'piece', quantity_owned: 600, rent_hourly: 8, rent_daily: 25, rent_weekly: 120, deposit: 0 },
  { name: 'Chair Cover with Sash', category: 'DECOR', unit: 'piece', quantity_owned: 600, rent_hourly: 0, rent_daily: 15, rent_weekly: 70, deposit: 0 },
  { name: 'Sofa (3-seater)', category: 'FURNITURE', unit: 'piece', quantity_owned: 24, rent_hourly: 60, rent_daily: 300, rent_weekly: 1600, deposit: 1000 },
  { name: 'Commercial Gas Cylinder', category: 'KITCHEN', unit: 'piece', quantity_owned: 20, rent_hourly: 0, rent_daily: 250, rent_weekly: 1200, deposit: 2000 },
  { name: 'Dinner Plate Set (12 pcs)', category: 'KITCHEN', unit: 'set', quantity_owned: 120, rent_hourly: 0, rent_daily: 50, rent_weekly: 250, deposit: 200 },
  { name: 'Shamiana / Tent (per unit)', category: 'DECOR', unit: 'piece', quantity_owned: 8, rent_hourly: 0, rent_daily: 4000, rent_weekly: 20000, deposit: 3000 },
  { name: 'Air Cooler', category: 'UTILITY', unit: 'piece', quantity_owned: 15, rent_hourly: 60, rent_daily: 400, rent_weekly: 2000, deposit: 500 },
  { name: 'DJ Sound System', category: 'AV', unit: 'set', quantity_owned: 3, rent_hourly: 0, rent_daily: 8000, rent_weekly: 40000, deposit: 5000 },
  { name: 'Diesel Generator (25 kVA)', category: 'UTILITY', unit: 'piece', quantity_owned: 4, rent_hourly: 0, rent_daily: 3500, rent_weekly: 18000, deposit: 4000 },
];

const SERVICES = [
  { name: 'Serving Staff', category: 'STAFF', pricing_type: 'PER_PERSON', rate: 900 },
  { name: 'Security Guard', category: 'SECURITY', pricing_type: 'PER_PERSON', rate: 1200 },
  { name: 'Valet Parking', category: 'PARKING', pricing_type: 'PER_EVENT', rate: 6000 },
  { name: 'Stage & Mandap Decoration', category: 'DECORATION', pricing_type: 'PER_EVENT', rate: 45000 },
  { name: 'Floral Decoration', category: 'DECORATION', pricing_type: 'PER_EVENT', rate: 25000 },
  { name: 'DJ & Music', category: 'OTHER', pricing_type: 'PER_EVENT', rate: 20000 },
  { name: 'Photography & Videography', category: 'OTHER', pricing_type: 'PER_EVENT', rate: 35000 },
  { name: 'Catering Supervisor', category: 'STAFF', pricing_type: 'PER_DAY', rate: 3500 },
];

async function main() {
  console.log(`\n[Auth] Logging in as "${ADM_LOGIN}" @ ${SERVER}…`);
  const login = await req('POST', '/api/auth/login', { loginId: ADM_LOGIN, password: ADM_PWD, restaurantId: REST_ID });
  if (login.status !== 200 || !login.body?.token) { console.error(`Login failed (${login.status}): ${JSON.stringify(login.body)}`); process.exit(1); }
  const tok = login.body.token;
  console.log(`[Auth] OK — role: ${login.body.role}`);
  if (!['SUPER_ADMIN', 'CTO'].includes(login.body.role)) {
    console.error(`This account is ${login.body.role}. Enabling the module needs SUPER_ADMIN or CTO. Aborting.`);
    process.exit(1);
  }
  const base = `/api/restaurant/${REST_ID}`;

  console.log('\n[1] Enable Events module');
  await must('events/enable', await req('POST', `${base}/events/enable`, { enabled: true }, tok));

  // Idempotency guard.
  const existing = await req('GET', `${base}/events/venues`, null, tok);
  const preexisting = Array.isArray(existing.body) ? existing.body.filter(v => v.name && !String(v.name).startsWith('E2E')).length : 0;
  if (preexisting > 0 && !FORCE) {
    console.log(`\n⚠ Tenant already has ${preexisting} venue(s). Refusing to seed duplicates.`);
    console.log('  The module is now ENABLED. Re-run with --force to seed demo data anyway.');
    process.exit(0);
  }

  console.log('\n[2] Venues');
  const venueIds = {};
  for (const v of VENUES) { const row = await must(`venue: ${v.name}`, await req('POST', `${base}/events/venues`, v, tok)); venueIds[v.name] = row.id; created.venues++; }

  console.log('\n[3] Rental inventory');
  const rentalIds = {};
  for (const it of RENTALS) { const row = await must(`rental: ${it.name}`, await req('POST', `${base}/events/rental-items`, it, tok)); rentalIds[it.name] = row.id; created.rentals++; }

  console.log('\n[4] Add-on services');
  const svcIds = {};
  for (const s of SERVICES) { const row = await must(`service: ${s.name}`, await req('POST', `${base}/events/services`, s, tok)); svcIds[s.name] = row.id; created.services++; }

  console.log('\n[5] Bookings across the lifecycle');

  // 5a — INQUIRY (fresh enquiry, no lines yet)
  await must('booking: Rohan & Simran Wedding (INQUIRY)', await req('POST', `${base}/events/bookings`, {
    customer_name: 'Rohan & Simran Wedding', customer_phone: '9822011001', customer_email: 'rohan.simran@example.com',
    event_type: 'WEDDING', venue_id: venueIds['Emerald Garden Lawn'], event_date: dayOffset(52), start_time: '18:00', end_time: '23:30',
    venue_rate_basis: 'DAILY', guest_count: 600, special_requests: 'North-Indian + Maharashtrian menu, live counters, valet.',
  }, tok));
  created.bookings++;

  // 5b — QUOTED (with rentals + services, then generate a quotation)
  const anniv = await must('booking: Deshpande 25th Anniversary (→QUOTED)', await req('POST', `${base}/events/bookings`, {
    customer_name: 'Deshpande 25th Anniversary', customer_phone: '9822011002', customer_email: 'deshpande@example.com',
    event_type: 'RECEPTION', venue_id: venueIds['Grand Ballroom'], event_date: dayOffset(31), start_time: '19:00', end_time: '23:00',
    venue_rate_basis: 'DAILY', guest_count: 300, advance_amount: 50000,
    items: [
      { rental_item_id: rentalIds['Round Table (10-seater)'], quantity: 30, rate_basis: 'DAILY', duration_units: 1 },
      { rental_item_id: rentalIds['Banquet Chair'], quantity: 300, rate_basis: 'DAILY', duration_units: 1 },
      { rental_item_id: rentalIds['DJ Sound System'], quantity: 1, rate_basis: 'DAILY', duration_units: 1 },
    ],
    services: [
      { service_id: svcIds['Serving Staff'], quantity: 15 },
      { service_id: svcIds['Stage & Mandap Decoration'], quantity: 1 },
      { service_id: svcIds['Photography & Videography'], quantity: 1 },
    ],
  }, tok));
  created.bookings++;
  await must('quotation for Deshpande', await req('POST', `${base}/events/bookings/${anniv.id}/quotations`, {}, tok));
  created.quotations++;

  // 5c — CONFIRMED corporate conference
  const conf = await must('booking: Infinite Systems Townhall (→CONFIRMED)', await req('POST', `${base}/events/bookings`, {
    customer_name: 'Infinite Systems Townhall', customer_phone: '9822011003', customer_email: 'events@infinitesys.example.com',
    customer_gstin: '27ABCDE1234F1Z5', event_type: 'CORPORATE', venue_id: venueIds['Emerald Hall'], event_date: dayOffset(18),
    start_time: '09:30', end_time: '17:30', venue_rate_basis: 'DAILY', guest_count: 150, advance_amount: 20000,
    items: [
      { rental_item_id: rentalIds['Banquet Chair'], quantity: 160, rate_basis: 'DAILY', duration_units: 1 },
      { rental_item_id: rentalIds['DJ Sound System'], quantity: 1, rate_basis: 'DAILY', duration_units: 1 },
    ],
    services: [
      { service_id: svcIds['Catering Supervisor'], quantity: 1 },
      { service_id: svcIds['Security Guard'], quantity: 4 },
      { service_id: svcIds['Valet Parking'], quantity: 1 },
    ],
  }, tok));
  created.bookings++;
  await must('confirm Infinite Systems', await req('POST', `${base}/events/bookings/${conf.id}/confirm`, {}, tok));

  // 5d — COMPLETED birthday (past date): create → confirm → checkout → complete
  const bday = await must('booking: Sharma 50th Birthday (→COMPLETED)', await req('POST', `${base}/events/bookings`, {
    customer_name: 'Sharma 50th Birthday', customer_phone: '9822011004', event_type: 'BIRTHDAY',
    venue_id: venueIds['Emerald Hall'], event_date: dayOffset(-9), start_time: '19:00', end_time: '23:00',
    venue_rate_basis: 'DAILY', guest_count: 120, advance_amount: 15000,
    items: [{ rental_item_id: rentalIds['Round Table (10-seater)'], quantity: 12, rate_basis: 'DAILY', duration_units: 1 }],
    services: [{ service_id: svcIds['Floral Decoration'], quantity: 1 }, { service_id: svcIds['DJ & Music'], quantity: 1 }],
  }, tok));
  created.bookings++;
  await must('confirm Sharma', await req('POST', `${base}/events/bookings/${bday.id}/confirm`, {}, tok));
  await must('checkout (invoice) Sharma', await req('POST', `${base}/events/bookings/${bday.id}/checkout`, {}, tok), [200, 201]);
  await must('complete Sharma', await req('POST', `${base}/events/bookings/${bday.id}/complete`, {}, tok));

  console.log('\n[6] Public page profile');
  await must('event profile', await req('PUT', `${base}/events/profile`, {
    hero_title: "Celebrate at Vivek's Cafe",
    tagline: 'Weddings · Receptions · Corporate Events · Private Parties',
    description: 'From intimate boardroom sessions to 800-guest garden weddings — four versatile venues, full rental inventory, catering and décor, all under one roof in the heart of Pune.',
    contact_phone: '020-4000-1003', contact_email: 'events@viveks-cafe.example.com', is_published: true,
  }, tok), [200, 201]);

  console.log('\n════════════════════════════════════════════');
  console.log(`  ✅ Seeded: ${created.venues} venues · ${created.rentals} rentals · ${created.services} services · ${created.bookings} bookings · ${created.quotations} quotation(s)`);
  console.log(`  Public page:  ${SERVER.replace(/\/$/, '')}/events/${REST_ID}`);
  console.log('  Admin: hard-refresh (Ctrl+Shift+R) → the "Events & Convention" module now appears in the sidebar.');
  console.log('════════════════════════════════════════════');
}

main().catch(e => { console.error('FATAL:', e.message || e); process.exit(1); });
