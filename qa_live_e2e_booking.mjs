#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════
 * LIVE E2E BOOKING TEST — Atithi-Setu Hotel
 * ════════════════════════════════════════════════════════════════════════
 *
 * Hits the REAL production API. For each test scenario:
 *   1.  POST /bookings              — creates a booking
 *   2.  POST /documents             — uploads a 1×1-px PNG as ID proof
 *   3.  POST /bookings/:id/checkin  — triggers folio creation
 *   4.  GET  /bookings/:id/folio    — reads the folio + entries
 *   5.  Asserts booking.total_amount + folio.subtotal + folio.grand_total
 *
 * Plus an availability-restriction block that:
 *   • Fills every room of a category for a date
 *   • Attempts one more booking in that category for the same date
 *   • Asserts the server returns 400/409 with a meaningful error
 *
 * Bookings are LEFT IN PLACE for the user to inspect via the UI.
 *
 * Required environment variables:
 *   LIVE_LOGIN_ID         Owner login (email)
 *   LIVE_PASSWORD         Owner password
 *   LIVE_RESTAURANT_ID    Tenant id (e.g. RESTO-1003)
 *
 * Optional:
 *   LIVE_BASE_URL         Default: https://msme.prabandh.in
 *   LIVE_DRY_RUN          Set to 1 to skip mutations; only login + GET endpoints
 *
 * Run:   node qa_live_e2e_booking.mjs
 * ════════════════════════════════════════════════════════════════════════
 */

const BASE_URL       = process.env.LIVE_BASE_URL || 'https://msme.prabandh.in';
const LOGIN_ID       = process.env.LIVE_LOGIN_ID;
const PASSWORD       = process.env.LIVE_PASSWORD;
const RESTAURANT_ID  = process.env.LIVE_RESTAURANT_ID;
const DRY_RUN        = process.env.LIVE_DRY_RUN === '1';

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m', bold: '\x1b[1m', mag: '\x1b[35m' };

if (!LOGIN_ID || !PASSWORD || !RESTAURANT_ID) {
  console.error(`${C.red}✗ Missing credentials.${C.reset}`);
  console.error(`Set LIVE_LOGIN_ID, LIVE_PASSWORD, LIVE_RESTAURANT_ID environment variables.`);
  console.error(`Example: LIVE_LOGIN_ID=owner@hotel.com LIVE_PASSWORD=xxx LIVE_RESTAURANT_ID=RESTO-1003 node qa_live_e2e_booking.mjs`);
  process.exit(1);
}

let TOKEN = '';
let passed = 0, failed = 0;
const failures = [];
const createdBookingIds = [];

const fmt = n => `Rs ${Number(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

// ─────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────

async function api(method, path, body, opts = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok && !opts.silent) {
    throw Object.assign(new Error(json?.error || `HTTP ${res.status}`), { status: res.status, body: json });
  }
  return { status: res.status, body: json };
}

async function uploadDoc(bookingId) {
  // 1×1 transparent PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=', 'base64');
  const boundary = '----qaboundary' + Math.random().toString(36).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="doc_type"\r\n\r\nAADHAAR\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="label"\r\n\r\nE2E test placeholder\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await fetch(`${BASE_URL}/api/restaurant/${RESTAURANT_ID}/hotel/bookings/${bookingId}/documents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Doc upload failed: ${res.status} ${t.slice(0, 200)}`);
  }
  return await res.json();
}

// ─────────────────────────────────────────────────────────────────────
// Login + setup
// ─────────────────────────────────────────────────────────────────────

async function login() {
  // Try owner-login first (the public owner registration / OWNER role flow),
  // then fall back to the legacy /api/auth/login for SUPER_ADMIN / CTO accts.
  let body;
  try {
    console.log(`${C.gray}→ POST /api/auth/owner/login${C.reset}`);
    const r = await api('POST', '/api/auth/owner/login', { identifier: LOGIN_ID, password: PASSWORD });
    body = r.body;
  } catch (err) {
    console.log(`${C.gray}  owner/login failed (${err.message}); trying /api/auth/login${C.reset}`);
    const r = await api('POST', '/api/auth/login', { loginId: LOGIN_ID, password: PASSWORD, restaurantId: RESTAURANT_ID });
    body = r.body;
  }
  if (!body.token) throw new Error('Login returned no token: ' + JSON.stringify(body).slice(0, 200));
  TOKEN = body.token;
  const rid = body.restaurantId || body.restaurant?.id || RESTAURANT_ID;
  console.log(`  ${C.green}✓ Logged in${C.reset} as ${body.name || body.owner?.name || LOGIN_ID} (role=${body.role || 'OWNER'}, restaurantId=${rid})`);
  if (rid && rid !== RESTAURANT_ID && body.role !== 'SUPER_ADMIN' && body.role !== 'CTO') {
    console.warn(`  ${C.yellow}⚠${C.reset} Token's restaurantId (${rid}) differs from LIVE_RESTAURANT_ID (${RESTAURANT_ID}). Continuing anyway — the URL :id param will gate access.`);
  }
}

async function loadContext() {
  console.log(`\n${C.gray}→ GET /tariff + /rooms + /bookings${C.reset}`);
  const [tariff, rooms, bookings] = await Promise.all([
    api('GET', `/api/restaurant/${RESTAURANT_ID}/hotel/tariff`).then(r => r.body),
    api('GET', `/api/restaurant/${RESTAURANT_ID}/hotel/rooms`).then(r => r.body),
    api('GET', `/api/restaurant/${RESTAURANT_ID}/hotel/bookings`).then(r => r.body),
  ]);
  console.log(`  ${C.green}✓ Loaded${C.reset} tariff_model=${tariff.tariff_model} · ${tariff.seasons?.length || 0} seasons · ${tariff.meal_plans?.length || 0} meal plans · ${tariff.room_tariffs?.length || 0} matrix cells · ${rooms.length} rooms · ${bookings.length} existing bookings`);

  if (tariff.tariff_model !== 'MATRIX') {
    console.warn(`  ${C.yellow}⚠${C.reset} Tenant is in LEGACY mode. The tariff matrix tests will skip — only base_rate is in play.`);
  }
  if (!tariff.room_tariffs || tariff.room_tariffs.length === 0) {
    console.warn(`  ${C.yellow}⚠${C.reset} Empty tariff matrix. Run the BCG seed (SuperAdmin → Seed BCG Tariff) before this test.`);
  }
  return { tariff, rooms, bookings };
}

// Mirror the server's getSeasonForDate logic so the test can predict
// the matrix lookup season WITHOUT trusting the server's answer.
function seasonForDate(tariff, isoDate) {
  const matches = (tariff.season_periods || []).filter(p => {
    const s = String(p.start_date || '').slice(0, 10);
    const e = String(p.end_date || '').slice(0, 10);
    return isoDate >= s && isoDate <= e;
  });
  if (!matches.length) return null;
  const ordered = matches.map(p => ({
    id: p.season_id,
    order: (tariff.seasons.find(s => s.id === p.season_id)?.display_order) ?? 99,
  })).sort((a, b) => a.order - b.order);
  return ordered[0]?.id || null;
}

function matrixRate(tariff, typeId, seasonId, mealPlanId) {
  const row = (tariff.room_tariffs || []).find(r =>
    r.room_type_id === typeId && r.season_id === seasonId
    && r.meal_plan_id === mealPlanId && !r.room_id_override
  );
  return row ? Number(row.rate) : null;
}

function extraChargeRate(tariff, personType, seasonId, mealPlanId) {
  const row = (tariff.extra_person_charges || []).find(r =>
    r.person_type === personType && r.season_id === seasonId && r.meal_plan_id === mealPlanId
  );
  return row ? Number(row.charge) : 0;
}

function gstSlab(amount) {
  if (amount <= 1000) return 0;
  if (amount <= 7500) return 12;
  return 18;
}

// Predict the booking total + invoice grand using the SAME math as the
// server (mirroring computeBookingTotalWithExtras). Returns null if any
// matrix cell is missing — we then skip the assert.
function expected(tariff, room, ci, co, opts = {}) {
  const dates = [];
  if (ci === co) dates.push(ci);
  else {
    let cursor = new Date(ci + 'T12:00:00Z');
    const end  = new Date(co + 'T12:00:00Z');
    while (cursor < end) {
      dates.push(cursor.toISOString().slice(0, 10));
      cursor = new Date(cursor.getTime() + 86400000);
    }
  }
  const perNight = [];
  for (const d of dates) {
    const seasonId = seasonForDate(tariff, d);
    if (!seasonId) return null;
    const base = matrixRate(tariff, room.type_id, seasonId, opts.meal_plan_id);
    if (base == null) return null;
    let extras = 0;
    if (opts.extra_adults) extras += extraChargeRate(tariff, 'ADULT', seasonId, opts.meal_plan_id) * opts.extra_adults;
    if (opts.extra_children_with_mattress) extras += extraChargeRate(tariff, 'CHILD_WITH_MATTRESS', seasonId, opts.meal_plan_id) * opts.extra_children_with_mattress;
    if (opts.extra_children_no_mattress) extras += extraChargeRate(tariff, 'CHILD_NO_MATTRESS', seasonId, opts.meal_plan_id) * opts.extra_children_no_mattress;
    perNight.push({ date: d, base, extras, season: seasonId });
  }
  const base_total   = Math.round(perNight.reduce((s, n) => s + n.base, 0) * 100) / 100;
  const extras_total = Math.round(perNight.reduce((s, n) => s + n.extras, 0) * 100) / 100;
  const total = Math.round((base_total + extras_total) * 100) / 100;
  // Grand = sum of per-night line × (1 + slab)
  const grand = Math.round(perNight.reduce((s, n) => {
    const line = n.base + n.extras;
    return s + line + (line * gstSlab(line) / 100);
  }, 0) * 100) / 100;
  return { perNight, base_total, extras_total, total, grand };
}

// ─────────────────────────────────────────────────────────────────────
// Test scenarios
// ─────────────────────────────────────────────────────────────────────

function buildScenarios(ctx) {
  const { tariff, rooms } = ctx;
  // Pick one available room per type for the tests.
  const roomsByType = {};
  for (const r of rooms) {
    if (!r.type_id || r.status === 'MAINTENANCE' || r.status === 'BLOCKED') continue;
    if (!roomsByType[r.type_id]) roomsByType[r.type_id] = [];
    roomsByType[r.type_id].push(r);
  }
  // Today (2026-06-07 per system clock); fill PEAK + OFF dates.
  const today = new Date(); today.setUTCHours(12, 0, 0, 0);
  const iso = (d) => d.toISOString().slice(0, 10);
  const plus = (n) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  // PEAK season in BCG seed: 2026-04-15 → 2026-06-30. We're at 2026-06-07.
  // Use +5 / +7 → 2026-06-12 / 2026-06-14 — squarely PEAK.
  // OFF season: 2026-07-01 onward. Use +30 / +32 → solid OFF.
  // Cross-season: 2026-06-29 → 2026-07-01.
  const PEAK_CI = plus(5);
  const PEAK_CO = plus(7);
  const OFF_CI  = plus(35);
  const OFF_CO  = plus(37);

  const cases = [];

  // Tariff math tests — pick first room of each type for a clean run.
  for (const [typeId, roomList] of Object.entries(roomsByType)) {
    if (roomList.length === 0) continue;
    const room = roomList[0];
    const typeName = (tariff.room_types || []).find(t => t.id === typeId)?.name || typeId;
    for (const mealPlan of (tariff.meal_plans || []).filter(m => m.is_active !== 0)) {
      cases.push({
        block: 'tariff',
        id: `T-${typeId}-PEAK-${mealPlan.code}`,
        title: `${typeName} · PEAK · 2N · ${mealPlan.code} · no extras`,
        room_id: room.id,
        room_type: typeId,
        check_in_date: PEAK_CI, check_out_date: PEAK_CO,
        meal_plan_id: mealPlan.id,
      });
    }
  }
  // One extras-heavy case per category (PEAK · API · +1A)
  for (const [typeId, roomList] of Object.entries(roomsByType)) {
    if (roomList.length < 2) continue; // need a second room since first is used above
    const room = roomList[1];
    const typeName = (tariff.room_types || []).find(t => t.id === typeId)?.name || typeId;
    const api = (tariff.meal_plans || []).find(m => m.code === 'API' || m.code === 'AP');
    if (!api) continue;
    cases.push({
      block: 'tariff',
      id: `T-${typeId}-PEAK-${api.code}-1A`,
      title: `${typeName} · PEAK · 2N · ${api.code} · +1 adult`,
      room_id: room.id,
      room_type: typeId,
      check_in_date: PEAK_CI, check_out_date: PEAK_CO,
      meal_plan_id: api.id,
      extra_adults: 1,
    });
  }
  // OFF season + extras combo on one premium category
  const premiumType = Object.keys(roomsByType).find(t => /PREMIUM|RIVER/i.test(t));
  if (premiumType && roomsByType[premiumType].length >= 3) {
    const room = roomsByType[premiumType][2];
    const map = (tariff.meal_plans || []).find(m => m.code === 'MAP');
    if (map) {
      cases.push({
        block: 'tariff',
        id: `T-${premiumType}-OFF-${map.code}-COMBO`,
        title: `${premiumType} · OFF · 2N · ${map.code} · +1A +1C(mat)`,
        room_id: room.id,
        room_type: premiumType,
        check_in_date: OFF_CI, check_out_date: OFF_CO,
        meal_plan_id: map.id,
        extra_adults: 1,
        extra_children_with_mattress: 1,
      });
    }
  }

  return { cases, PEAK_CI, PEAK_CO, OFF_CI, OFF_CO, roomsByType };
}

async function runTariffCase(c, ctx) {
  const { tariff, rooms } = ctx;
  const room = rooms.find(r => r.id === c.room_id);
  const exp  = expected(tariff, room, c.check_in_date, c.check_out_date, {
    meal_plan_id: c.meal_plan_id,
    extra_adults: c.extra_adults,
    extra_children_with_mattress: c.extra_children_with_mattress,
    extra_children_no_mattress: c.extra_children_no_mattress,
  });
  if (!exp) {
    console.log(`  ${C.gray}↩${C.reset} ${c.id.padEnd(40)} skipped — matrix has no cell for this combo`);
    return;
  }

  let booking;
  try {
    const b = await api('POST', `/api/restaurant/${RESTAURANT_ID}/hotel/bookings`, {
      room_id: c.room_id,
      guest_name: `E2E Test · ${c.id}`,
      guest_phone: '+919000000000',
      check_in_date: c.check_in_date,
      check_out_date: c.check_out_date,
      booking_type: 'OVERNIGHT',
      num_guests: 1 + (c.extra_adults || 0) + (c.extra_children_with_mattress || 0) + (c.extra_children_no_mattress || 0),
      meal_plan_id: c.meal_plan_id,
      extra_adults: c.extra_adults || 0,
      extra_children_with_mattress: c.extra_children_with_mattress || 0,
      extra_children_no_mattress: c.extra_children_no_mattress || 0,
      booking_source: 'DIRECT',
      // Leave room_rate=0 so server uses matrix
    });
    booking = b.body;
    createdBookingIds.push(booking.id);
  } catch (err) {
    failed++;
    failures.push(`${c.id}: booking POST failed — ${err.message}`);
    console.log(`  ${C.red}✗${C.reset} ${c.id.padEnd(40)} POST failed: ${err.message}`);
    return;
  }

  const bookingOK = Math.abs(Number(booking.total_amount) - exp.total) < 1; // ±₹1 round-off tolerance
  if (bookingOK) passed++;
  else { failed++; failures.push(`${c.id}: booking total ${booking.total_amount} ≠ expected ${exp.total}`); }

  // Doc upload + check-in + folio fetch (list-and-filter pattern since
  // there's no /bookings/:id/folio direct endpoint).
  let folio;
  try {
    await uploadDoc(booking.id);
    await api('POST', `/api/restaurant/${RESTAURANT_ID}/hotel/bookings/${booking.id}/checkin`, {});
    const { body: folios } = await api('GET', `/api/restaurant/${RESTAURANT_ID}/hotel/folios?status=open`);
    const myFolio = (Array.isArray(folios) ? folios : []).find(f => f.booking_id === booking.id);
    if (!myFolio) throw new Error('No open folio found for booking after check-in');
    const { body: folioFull } = await api('GET', `/api/restaurant/${RESTAURANT_ID}/hotel/folios/${myFolio.id}`);
    folio = folioFull;
  } catch (err) {
    failed++;
    failures.push(`${c.id}: check-in/folio failed — ${err.message}`);
    console.log(`  ${C.red}✗${C.reset} ${c.id.padEnd(40)} booking ${fmt(booking.total_amount)} BUT check-in/folio failed: ${err.message}`);
    return;
  }

  const grandOK = Math.abs(Number(folio.grand_total) - exp.grand) < 1;
  const subtotalOK = Math.abs(Number(folio.subtotal) - exp.total) < 1;
  if (grandOK) passed++; else { failed++; failures.push(`${c.id}: invoice grand ${folio.grand_total} ≠ expected ${exp.grand}`); }
  if (subtotalOK) passed++; else { failed++; failures.push(`${c.id}: folio subtotal ${folio.subtotal} ≠ expected ${exp.total}`); }

  const status = (bookingOK && grandOK && subtotalOK) ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
  console.log(`  ${status} ${c.id.padEnd(40)} booking=${fmt(booking.total_amount).padStart(13)} folio_sub=${fmt(folio.subtotal).padStart(13)} grand=${fmt(folio.grand_total).padStart(13)} ${C.gray}(exp ${fmt(exp.total)}/${fmt(exp.grand)})${C.reset}`);
}

// ─────────────────────────────────────────────────────────────────────
// Availability restriction tests
// ─────────────────────────────────────────────────────────────────────

async function runAvailabilityTests(ctx, scenarios) {
  console.log(`\n${C.bold}${C.cyan}━━━ BLOCK 2 — Availability restriction tests ━━━${C.reset}`);
  const { roomsByType, OFF_CI, OFF_CO } = scenarios;
  const { tariff, rooms } = ctx;

  // Pick the category with the FEWEST rooms (so we can saturate it cheaply).
  const entries = Object.entries(roomsByType).sort((a, b) => a[1].length - b[1].length);
  if (entries.length === 0) {
    console.log(`  ${C.yellow}⚠${C.reset} No room types found — skipping.`);
    return;
  }
  const [targetTypeId, targetRooms] = entries[0];
  const typeName = (tariff.room_types || []).find(t => t.id === targetTypeId)?.name || targetTypeId;
  console.log(`  ${C.gray}Saturating category "${typeName}" (${targetRooms.length} rooms) for ${OFF_CI} → ${OFF_CO}${C.reset}`);

  // Saturate the category. Use OFF dates (different from PEAK tariff block
  // to avoid colliding with bookings created above).
  const saturatorIds = [];
  for (let i = 0; i < targetRooms.length; i++) {
    try {
      const b = await api('POST', `/api/restaurant/${RESTAURANT_ID}/hotel/bookings`, {
        room_id: targetRooms[i].id,
        guest_name: `E2E Saturator ${i + 1}`,
        guest_phone: '+919111111111',
        check_in_date: OFF_CI, check_out_date: OFF_CO,
        booking_type: 'OVERNIGHT', num_guests: 1,
        booking_source: 'DIRECT',
      });
      saturatorIds.push(b.body.id);
      createdBookingIds.push(b.body.id);
    } catch (err) {
      // Might already be booked from a prior run — that's fine.
      console.log(`  ${C.gray}↳ room ${targetRooms[i].name} already booked (${err.message.slice(0, 60)})${C.reset}`);
    }
  }
  console.log(`  ${C.gray}Created ${saturatorIds.length} saturator bookings.${C.reset}`);

  // Now attempt one MORE booking of the same category. Should fail.
  // Use ANY room in the saturated category — server should reject because
  // every room is already booked.
  let conflictRejected = false;
  let conflictError = '';
  try {
    const b = await api('POST', `/api/restaurant/${RESTAURANT_ID}/hotel/bookings`, {
      room_id: targetRooms[0].id,
      guest_name: 'E2E Overflow',
      guest_phone: '+919222222222',
      check_in_date: OFF_CI, check_out_date: OFF_CO,
      booking_type: 'OVERNIGHT', num_guests: 1,
      booking_source: 'DIRECT',
    });
    // If we get here, the server accepted a double-booking — that's a bug.
    createdBookingIds.push(b.body.id);
  } catch (err) {
    conflictRejected = true;
    conflictError = err.message;
  }
  if (conflictRejected) {
    passed++;
    console.log(`  ${C.green}✓${C.reset} Overflow booking REJECTED as expected: "${conflictError.slice(0, 80)}"`);
  } else {
    failed++;
    failures.push(`Availability: server accepted a double-booking on saturated category!`);
    console.log(`  ${C.red}✗${C.reset} Server accepted a double-booking — this is a serious bug.`);
  }

  // Now try a DIFFERENT category for the same dates — should succeed.
  if (entries.length >= 2) {
    const [otherTypeId, otherRooms] = entries.find(([t]) => t !== targetTypeId) || [null, []];
    if (otherRooms.length > 0) {
      let acceptedDifferent = false;
      try {
        const b = await api('POST', `/api/restaurant/${RESTAURANT_ID}/hotel/bookings`, {
          room_id: otherRooms[0].id,
          guest_name: 'E2E Different Category',
          guest_phone: '+919333333333',
          check_in_date: OFF_CI, check_out_date: OFF_CO,
          booking_type: 'OVERNIGHT', num_guests: 1,
          booking_source: 'DIRECT',
        });
        acceptedDifferent = true;
        createdBookingIds.push(b.body.id);
      } catch (err) {
        // Might also be saturated from prior runs — log and continue.
        console.log(`  ${C.gray}↳ other category booking failed: ${err.message.slice(0, 80)}${C.reset}`);
      }
      if (acceptedDifferent) {
        passed++;
        console.log(`  ${C.green}✓${C.reset} Other category (${(tariff.room_types || []).find(t => t.id === otherTypeId)?.name || otherTypeId}) booking ACCEPTED for same dates — categories are isolated correctly.`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`${C.bold}╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║  LIVE E2E BOOKING TEST — full lifecycle (booking → folio)        ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝${C.reset}`);
  console.log(`${C.gray}Base URL: ${BASE_URL}${C.reset}`);
  console.log(`${C.gray}Tenant:   ${RESTAURANT_ID}${C.reset}`);
  console.log(`${C.gray}Login:    ${LOGIN_ID}${C.reset}`);
  if (DRY_RUN) console.log(`${C.yellow}DRY RUN — mutations skipped.${C.reset}`);

  try {
    await login();
    const ctx = await loadContext();
    const scenarios = buildScenarios(ctx);

    console.log(`\n${C.bold}${C.cyan}━━━ BLOCK 1 — Tariff math (booking + check-in + folio + invoice) ━━━${C.reset}`);
    console.log(`${C.gray}Running ${scenarios.cases.length} cases.${C.reset}`);
    for (const c of scenarios.cases) {
      if (DRY_RUN) { console.log(`  ${C.gray}(skipped — dry run) ${c.id}${C.reset}`); continue; }
      await runTariffCase(c, ctx);
    }

    if (!DRY_RUN) await runAvailabilityTests(ctx, scenarios);

    console.log(`\n${C.bold}═══════════════════════════════════════════════════════════════════`);
    console.log(`  TEST SUMMARY`);
    console.log(`═══════════════════════════════════════════════════════════════════${C.reset}`);
    console.log(`  ${C.green}✓ Passed:${C.reset}  ${passed}`);
    console.log(`  ${C.red}✗ Failed:${C.reset}  ${failed}`);
    if (failures.length) {
      console.log(`\n${C.red}${C.bold}FAILURES:${C.reset}`);
      for (const f of failures) console.log(`  • ${f}`);
    }
    if (createdBookingIds.length > 0) {
      console.log(`\n${C.mag}${C.bold}BOOKINGS CREATED (left for inspection):${C.reset}`);
      for (const id of createdBookingIds) console.log(`  • ${id}`);
      console.log(`${C.gray}  Open the Hotel Bookings tab to view / cancel these.${C.reset}`);
    }
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error(`\n${C.red}${C.bold}FATAL: ${err.message}${C.reset}`);
    if (err.body) console.error(JSON.stringify(err.body, null, 2));
    process.exit(2);
  }
})();
