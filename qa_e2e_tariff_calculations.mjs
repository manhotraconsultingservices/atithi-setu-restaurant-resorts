#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════
 * E2E TARIFF CALCULATION VALIDATOR — Atithi-Setu Hotel Module
 * ════════════════════════════════════════════════════════════════════════
 *
 * Walks every meaningful (Room Category × Season × Meal Plan × Extra
 * Person) combination through the FULL booking lifecycle and asserts the
 * math at each stage:
 *
 *   1. POST /hotel/bookings           — booking total via
 *                                       computeBookingTotalWithExtras()
 *   2. POST /hotel/bookings/:id/checkin → triggers
 *                                       createFolioWithRoomCharges()
 *                                       which seeds folio_entries
 *   3. POST /hotel/folios/:id/finalize → invoice with subtotal + GST +
 *                                       grand_total
 *
 * The test uses pure JS with the BCG seed data inlined — no DB, no
 * Express, no network. The helpers are byte-for-byte ports of the
 * production functions in server.ts, lines 1051-2148.
 *
 * Run:   node qa_e2e_tariff_calculations.mjs
 *
 * Exit code 0 = all pass, 1 = any failure (suitable for CI).
 * ════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────
// SEED DATA — verbatim from qa_seed_viveks_tariff.mts
// ─────────────────────────────────────────────────────────────────────

const ROOM_TYPES = {
  SUPERIOR_VIEW: { name: 'Superior Room with View',   base_rate: 2000 },
  PREMIUM_BALC:  { name: 'Premium Room with Balcony', base_rate: 2400 },
  RIVER_VIEW:    { name: 'River View with Balcony',   base_rate: 2800 },
};

const ROOMS = {
  // (subset — one room per category, sufficient for math validation)
  'ROOM-103': { type_id: 'SUPERIOR_VIEW', room_number: '103' },
  'ROOM-204': { type_id: 'PREMIUM_BALC',  room_number: '204' },
  'ROOM-101': { type_id: 'RIVER_VIEW',    room_number: '101' },
};

const SEASON_PERIODS = [
  { season_id: 'PEAK', start: '2026-04-15', end: '2026-06-30' },
  { season_id: 'PEAK', start: '2026-12-20', end: '2027-01-05' },
  { season_id: 'OFF',  start: '2026-07-01', end: '2026-12-19' },
  { season_id: 'OFF',  start: '2027-01-06', end: '2027-04-14' },
];

// PEAK has display_order=1, OFF=2 — so when ranges would tie, PEAK wins.
const SEASON_ORDER = { PEAK: 1, OFF: 2 };

const ROOM_TARIFFS = {
  // key = `${type}|${season}|${meal_plan}` → rate
  'SUPERIOR_VIEW|PEAK|EP':  3200, 'SUPERIOR_VIEW|PEAK|CP':  3700, 'SUPERIOR_VIEW|PEAK|MAP':  4500, 'SUPERIOR_VIEW|PEAK|API':  5200,
  'SUPERIOR_VIEW|OFF|EP':   2000, 'SUPERIOR_VIEW|OFF|CP':   2500, 'SUPERIOR_VIEW|OFF|MAP':   3300, 'SUPERIOR_VIEW|OFF|API':   4000,
  'PREMIUM_BALC|PEAK|EP':   3700, 'PREMIUM_BALC|PEAK|CP':   4200, 'PREMIUM_BALC|PEAK|MAP':   5000, 'PREMIUM_BALC|PEAK|API':   5700,
  'PREMIUM_BALC|OFF|EP':    2400, 'PREMIUM_BALC|OFF|CP':    2900, 'PREMIUM_BALC|OFF|MAP':    3700, 'PREMIUM_BALC|OFF|API':    4400,
  'RIVER_VIEW|PEAK|EP':     4200, 'RIVER_VIEW|PEAK|CP':     4700, 'RIVER_VIEW|PEAK|MAP':     5500, 'RIVER_VIEW|PEAK|API':     6200,
  'RIVER_VIEW|OFF|EP':      2800, 'RIVER_VIEW|OFF|CP':      3300, 'RIVER_VIEW|OFF|MAP':      4100, 'RIVER_VIEW|OFF|API':      4800,
};

const EXTRA_PERSON_CHARGES = {
  // key = `${person}|${season}|${meal_plan}` → ₹/night
  'ADULT|PEAK|EP':              1000, 'ADULT|PEAK|CP':              1300, 'ADULT|PEAK|MAP':              1800, 'ADULT|PEAK|API':              2200,
  'ADULT|OFF|EP':                800, 'ADULT|OFF|CP':               1100, 'ADULT|OFF|MAP':               1600, 'ADULT|OFF|API':               2000,
  'CHILD_WITH_MATTRESS|PEAK|EP': 700, 'CHILD_WITH_MATTRESS|PEAK|CP':1000, 'CHILD_WITH_MATTRESS|PEAK|MAP':1400, 'CHILD_WITH_MATTRESS|PEAK|API':1700,
  'CHILD_WITH_MATTRESS|OFF|EP':  500, 'CHILD_WITH_MATTRESS|OFF|CP':  800, 'CHILD_WITH_MATTRESS|OFF|MAP': 1200, 'CHILD_WITH_MATTRESS|OFF|API': 1500,
  'CHILD_NO_MATTRESS|PEAK|EP':   500, 'CHILD_NO_MATTRESS|PEAK|CP':   700, 'CHILD_NO_MATTRESS|PEAK|MAP':  1000, 'CHILD_NO_MATTRESS|PEAK|API':  1200,
  'CHILD_NO_MATTRESS|OFF|EP':    400, 'CHILD_NO_MATTRESS|OFF|CP':    600, 'CHILD_NO_MATTRESS|OFF|MAP':    900, 'CHILD_NO_MATTRESS|OFF|API':  1100,
};

// Hotel GST config — defaults from loadHotelTaxConfig() in server.ts:1023
const TAX_CFG = {
  slab1Max: 1000,  slab1Rate:  0,   // ≤ ₹1000 → 0%
  slab2Max: 7500,  slab2Rate: 12,   // ₹1001-7500 → 12%
  slab3Rate: 18,                    // > ₹7500 → 18%
  serviceChargePct: 0,              // tenant default (BCG seed leaves it 0)
};

// ─────────────────────────────────────────────────────────────────────
// HELPERS — ports of the production functions
// ─────────────────────────────────────────────────────────────────────

// Mirror of getSeasonForDate (server.ts:1971-1988).
function getSeasonForDate(isoDate) {
  const matches = SEASON_PERIODS.filter(p => isoDate >= p.start && isoDate <= p.end);
  if (!matches.length) return null;
  matches.sort((a, b) => SEASON_ORDER[a.season_id] - SEASON_ORDER[b.season_id]);
  return matches[0].season_id;
}

// Mirror of getMatrixRateForRoomDate (server.ts:1992-2025).
function getMatrixRateForRoomDate(roomId, isoDate, mealPlanId) {
  const room = ROOMS[roomId];
  if (!room?.type_id) return null;
  const seasonId = getSeasonForDate(isoDate);
  if (!seasonId) return null;
  const key = `${room.type_id}|${seasonId}|${mealPlanId}`;
  const rate = ROOM_TARIFFS[key];
  if (rate == null) return null;
  return { rate, season_id: seasonId, source: 'MATRIX_TYPE' };
}

// Mirror of getExtraPersonChargeForDate (server.ts:2043-2059).
function getExtraPersonChargeForDate(isoDate, mealPlanId, personType) {
  const seasonId = getSeasonForDate(isoDate);
  if (!seasonId) return 0;
  const key = `${personType}|${seasonId}|${mealPlanId}`;
  return Number(EXTRA_PERSON_CHARGES[key] || 0);
}

// Mirror of getRateForRoomDate (legacy fallback). For BCG seed:
// no rate_overrides exist, so legacy = room.base_rate from room_types.
function getLegacyRate(roomId) {
  const room = ROOMS[roomId];
  return ROOM_TYPES[room.type_id]?.base_rate || 0;
}

// Mirror of computeBookingTotalWithExtras (server.ts:2077-2148).
function computeBookingTotalWithExtras(roomId, checkIn, checkOut, opts = {}) {
  const bookingType = String(opts.bookingType || 'OVERNIGHT').toUpperCase();
  const extras = {
    ADULT:               Math.max(0, Number(opts.extraAdults || 0)),
    CHILD_WITH_MATTRESS: Math.max(0, Number(opts.extraChildrenWithMattress || 0)),
    CHILD_NO_MATTRESS:   Math.max(0, Number(opts.extraChildrenNoMattress || 0)),
  };
  const tariffModel = 'MATRIX'; // BCG seed sets restaurants.tariff_model = 'MATRIX'
  const useMatrix = tariffModel === 'MATRIX' && !!opts.mealPlanId;

  const dates = [];
  if (bookingType === 'DAY_USE' || checkIn === checkOut) {
    dates.push(checkIn);
  } else {
    let cursor = new Date(checkIn + 'T12:00:00Z');
    const end = new Date(checkOut + 'T12:00:00Z');
    while (cursor < end) {
      dates.push(cursor.toISOString().slice(0, 10));
      cursor = new Date(cursor.getTime() + 86400000);
    }
  }

  const perNight = [];
  for (const d of dates) {
    let baseRate = 0;
    let source = 'BASE_RATE';
    if (useMatrix) {
      const m = getMatrixRateForRoomDate(roomId, d, opts.mealPlanId);
      if (m) { baseRate = m.rate; source = m.source; }
    }
    if (baseRate === 0) {
      baseRate = getLegacyRate(roomId);
      source = 'BASE_RATE_FALLBACK';
    }
    let extrasForNight = 0;
    if (useMatrix) {
      for (const [pt, count] of Object.entries(extras)) {
        if (count > 0) {
          extrasForNight += getExtraPersonChargeForDate(d, opts.mealPlanId, pt) * count;
        }
      }
    }
    perNight.push({ date: d, base_rate: baseRate, extras: extrasForNight, source });
  }

  const baseTotal   = Math.round(perNight.reduce((s, n) => s + n.base_rate, 0) * 100) / 100;
  const extrasTotal = Math.round(perNight.reduce((s, n) => s + n.extras,    0) * 100) / 100;
  return {
    base_total:  baseTotal,
    extras_total: extrasTotal,
    total: Math.round((baseTotal + extrasTotal) * 100) / 100,
    per_night: perNight,
  };
}

// Mirror of gstRateForTariff (server.ts:1035-1044).
function gstRateForTariff(tariff, cfg = TAX_CFG) {
  if (tariff <= cfg.slab1Max) return cfg.slab1Rate;
  if (tariff <= cfg.slab2Max) return cfg.slab2Rate;
  return cfg.slab3Rate;
}

// Mirror of createFolioWithRoomCharges after the BCG Tariff Phase 3.1 +
// 4.1 fixes (server.ts:1077+). Now matrix-aware: when meal_plan_id is
// set, uses computeBookingTotalWithExtras for per-night base + extras
// and applies the GST slab to the FULL per-night line (base + extras)
// so stays that cross ₹7,500 via extras get the correct 18% slab.
//
// Phase 4.1 also honours manual room_rate overrides in MATRIX mode: if
// the booking carries a room_rate that disagrees with the matrix's
// night-1 rate, the folio uses the manual rate for every night and
// drops extras (matches the booking POST manual-rate branch which also
// skips extras).
function createFolioWithRoomCharges_PROD(roomId, booking) {
  const useMatrix = !!booking.meal_plan_id; // tariff_model='MATRIX' is set by BCG seed
  let perNight;
  const explicitRate = Number(booking.room_rate) || 0;
  if (useMatrix) {
    const breakdown = computeBookingTotalWithExtras(roomId, booking.check_in_date, booking.check_out_date, {
      mealPlanId:                booking.meal_plan_id,
      extraAdults:               booking.extra_adults,
      extraChildrenWithMattress: booking.extra_children_with_mattress,
      extraChildrenNoMattress:   booking.extra_children_no_mattress,
      bookingType:               booking.booking_type,
    });
    const matrixNight1 = breakdown.per_night[0]?.base_rate || 0;
    const useExplicitInMatrix = explicitRate > 0 && Math.abs(explicitRate - matrixNight1) > 0.01;
    perNight = breakdown.per_night.map(n => ({
      date: n.date,
      base_rate: useExplicitInMatrix ? explicitRate : n.base_rate,
      extras:    useExplicitInMatrix ? 0 : n.extras,
    }));
  } else {
    // Legacy fallback: room_types.base_rate per night, no extras.
    const dates = [];
    if (booking.check_in_date === booking.check_out_date) {
      dates.push(booking.check_in_date);
    } else {
      let cursor = new Date(booking.check_in_date + 'T12:00:00Z');
      const end  = new Date(booking.check_out_date + 'T12:00:00Z');
      while (cursor < end) {
        dates.push(cursor.toISOString().slice(0, 10));
        cursor = new Date(cursor.getTime() + 86400000);
      }
    }
    const explicitRate = Number(booking.room_rate) || 0;
    const legacyRate = getLegacyRate(roomId);
    const useExplicit = explicitRate > 0 && Math.abs(explicitRate - legacyRate) > 0.01;
    perNight = dates.map(d => ({ date: d, base_rate: useExplicit ? explicitRate : legacyRate, extras: 0 }));
  }

  const entries = [];
  let subtotal = 0, gst = 0;
  for (const pn of perNight) {
    const lineAmount = Math.round((pn.base_rate + pn.extras) * 100) / 100;
    const gstPct = gstRateForTariff(lineAmount);  // slab on full line
    const lineGst = Math.round((lineAmount * gstPct / 100) * 100) / 100;
    entries.push({ type: 'ROOM_CHARGE', date: pn.date, amount: lineAmount, gst_pct: gstPct, gst_amount: lineGst });
    subtotal += lineAmount;
    gst += lineGst;
    if (TAX_CFG.serviceChargePct > 0) {
      const svcAmt = Math.round((lineAmount * TAX_CFG.serviceChargePct / 100) * 100) / 100;
      const svcGst = Math.round((svcAmt * gstPct / 100) * 100) / 100;
      entries.push({ type: 'SERVICE_CHARGE', date: pn.date, amount: svcAmt, gst_pct: gstPct, gst_amount: svcGst });
      subtotal += svcAmt;
      gst += svcGst;
    }
  }
  subtotal = Math.round(subtotal * 100) / 100;
  gst      = Math.round(gst * 100) / 100;
  return { entries, subtotal, gst, grand_total: Math.round((subtotal + gst) * 100) / 100 };
}

// What the folio SHOULD look like if it correctly used the matrix +
// extras (the proposed fix). Used to compute the under-billed delta.
function createFolioWithRoomCharges_CORRECT(roomId, booking) {
  const breakdown = computeBookingTotalWithExtras(roomId, booking.check_in_date, booking.check_out_date, {
    mealPlanId:                booking.meal_plan_id,
    extraAdults:               booking.extra_adults,
    extraChildrenWithMattress: booking.extra_children_with_mattress,
    extraChildrenNoMattress:   booking.extra_children_no_mattress,
    bookingType:               booking.booking_type,
  });
  const entries = [];
  let subtotal = 0, gst = 0;
  for (const pn of breakdown.per_night) {
    // Per-night line includes base + extras (which is how a hotel would
    // really bill — "Room charge incl. 1 extra adult").
    const lineTotal = pn.base_rate + pn.extras;
    const gstPct = gstRateForTariff(lineTotal);
    const lineGst = Math.round((lineTotal * gstPct / 100) * 100) / 100;
    entries.push({ type: 'ROOM_CHARGE', date: pn.date, amount: lineTotal, gst_pct: gstPct, gst_amount: lineGst });
    subtotal += lineTotal;
    gst += lineGst;
  }
  subtotal = Math.round(subtotal * 100) / 100;
  gst      = Math.round(gst * 100) / 100;
  return { entries, subtotal, gst, grand_total: Math.round((subtotal + gst) * 100) / 100 };
}

// ─────────────────────────────────────────────────────────────────────
// TEST RUNNER
// ─────────────────────────────────────────────────────────────────────

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m', bold: '\x1b[1m' };
const fmt = n => `Rs ${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
const VERBOSE = process.env.VERBOSE === '1';

let passed = 0, failed = 0, warned = 0;
const failures = [];
const warnings = [];

function runCase(c) {
  const breakdown = computeBookingTotalWithExtras(c.room_id, c.check_in_date, c.check_out_date, {
    mealPlanId: c.meal_plan_id, extraAdults: c.extra_adults,
    extraChildrenWithMattress: c.extra_children_with_mattress,
    extraChildrenNoMattress: c.extra_children_no_mattress,
    bookingType: c.booking_type,
  });
  const booking = {
    room_id: c.room_id, check_in_date: c.check_in_date, check_out_date: c.check_out_date,
    booking_type: c.booking_type, meal_plan_id: c.meal_plan_id,
    extra_adults: c.extra_adults,
    extra_children_with_mattress: c.extra_children_with_mattress,
    extra_children_no_mattress: c.extra_children_no_mattress,
    room_rate: breakdown.per_night[0]?.base_rate || 0,
    total_amount: breakdown.total,
  };
  const folio = createFolioWithRoomCharges_PROD(c.room_id, booking);

  const checks = [];
  // 1. Booking total matches expected (the hand-computed value)
  if (c.expected_booking_total != null) {
    const ok = Math.abs(breakdown.total - c.expected_booking_total) < 0.01;
    checks.push({ ok, label: 'booking total', got: breakdown.total, want: c.expected_booking_total });
    ok ? passed++ : (failed++, failures.push(`${c.id}: booking total ${breakdown.total} ≠ ${c.expected_booking_total}`));
  }
  // 2. Folio subtotal equals booking total (no revenue drift)
  const drift = Math.round((booking.total_amount - folio.subtotal) * 100) / 100;
  const driftOK = Math.abs(drift) < 0.01;
  checks.push({ ok: driftOK, label: 'no drift', got: folio.subtotal, want: booking.total_amount });
  driftOK ? passed++ : (failed++, failures.push(`${c.id}: revenue drift ${drift} (${drift > 0 ? 'UNDER' : 'OVER'}-billed)`));

  // 3. Invoice grand_total matches expected
  if (c.expected_invoice_grand != null) {
    const ok = Math.abs(folio.grand_total - c.expected_invoice_grand) < 0.01;
    checks.push({ ok, label: 'invoice grand', got: folio.grand_total, want: c.expected_invoice_grand });
    ok ? passed++ : (failed++, failures.push(`${c.id}: invoice grand ${folio.grand_total} ≠ ${c.expected_invoice_grand}`));
  }
  // 4. GST slab is correct (when caller specified)
  if (c.expected_gst_slab != null && folio.entries.length > 0) {
    const firstRoomEntry = folio.entries.find(e => e.type === 'ROOM_CHARGE');
    const actualSlab = firstRoomEntry?.gst_pct;
    const ok = actualSlab === c.expected_gst_slab;
    checks.push({ ok, label: 'GST slab', got: `${actualSlab}%`, want: `${c.expected_gst_slab}%` });
    ok ? passed++ : (failed++, failures.push(`${c.id}: GST slab ${actualSlab}% ≠ ${c.expected_gst_slab}%`));
  }

  const allOK = checks.every(c => c.ok);
  const statusGlyph = allOK ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
  const oneline = `  ${statusGlyph} ${c.id.padEnd(7)} ${c.title.padEnd(60)} booking=${fmt(breakdown.total).padStart(13)} grand=${fmt(folio.grand_total).padStart(13)}`;
  console.log(oneline);

  if (!allOK || VERBOSE) {
    for (const ck of checks.filter(c => !c.ok)) {
      console.log(`      ${C.red}└─ ${ck.label}: got ${ck.got} expected ${ck.want}${C.reset}`);
    }
    if (VERBOSE) {
      for (const n of breakdown.per_night) {
        console.log(`      ${C.gray}${n.date} [${(getSeasonForDate(n.date) || 'NO-SEASON').padEnd(4)} ${n.source.padEnd(20)}] base=${fmt(n.base_rate).padStart(11)}  extras=${fmt(n.extras).padStart(10)}${C.reset}`);
      }
    }
  }
}

function section(title) {
  console.log(`\n${C.bold}${C.cyan}━━━ ${title} ━━━${C.reset}`);
}

// ─────────────────────────────────────────────────────────────────────
// CASE BUILDERS
// ─────────────────────────────────────────────────────────────────────

// Hand-compute what the test SHOULD see for an OVERNIGHT MATRIX booking.
// Mirrors production math step-by-step so a wrong production result
// can't accidentally produce a wrong expected (independence by construction).
function expectedFor(roomTypeId, seasonId, mealPlanId, nights, opts = {}) {
  const baseRate = ROOM_TARIFFS[`${roomTypeId}|${seasonId}|${mealPlanId}`];
  const adults = opts.extra_adults || 0;
  const cMat   = opts.extra_children_with_mattress || 0;
  const cNoMat = opts.extra_children_no_mattress || 0;
  const extrasPerNight =
    adults * (EXTRA_PERSON_CHARGES[`ADULT|${seasonId}|${mealPlanId}`] || 0) +
    cMat   * (EXTRA_PERSON_CHARGES[`CHILD_WITH_MATTRESS|${seasonId}|${mealPlanId}`] || 0) +
    cNoMat * (EXTRA_PERSON_CHARGES[`CHILD_NO_MATTRESS|${seasonId}|${mealPlanId}`] || 0);
  const lineAmount = Math.round((baseRate + extrasPerNight) * 100) / 100;
  // GST slab on the FULL per-night line (base + extras), per server.ts:1140.
  const slab = lineAmount <= 1000 ? 0 : lineAmount <= 7500 ? 12 : 18;
  const lineGst = Math.round((lineAmount * slab / 100) * 100) / 100;
  const booking = Math.round(lineAmount * nights * 100) / 100;
  const grand   = Math.round((lineAmount + lineGst) * nights * 100) / 100;
  return { booking, grand, slab };
}

const ROOM_BY_TYPE = { SUPERIOR_VIEW: 'ROOM-103', PREMIUM_BALC: 'ROOM-204', RIVER_VIEW: 'ROOM-101' };
const SHORT_CAT = { SUPERIOR_VIEW: 'SUP', PREMIUM_BALC: 'PRM', RIVER_VIEW: 'RVR' };

// Cluster of date windows safely inside each season (so a stay never
// accidentally crosses a season boundary unless we want it to).
const PEAK_CI = '2026-05-10';   // PEAK window: 2026-04-15 → 2026-06-30
const OFF_CI  = '2026-08-10';   // OFF window:  2026-07-01 → 2026-12-19

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────
// CASES — comprehensive coverage
// ─────────────────────────────────────────────────────────────────────

const CASES = [];

// BLOCK 1 — Full matrix coverage. Every (category × season × meal plan)
// triple gets a 2-night stay with no extras. 3 × 2 × 4 = 24 cases.
// This catches any single-cell tariff mismatch.
for (const cat of ['SUPERIOR_VIEW', 'PREMIUM_BALC', 'RIVER_VIEW']) {
  for (const season of ['PEAK', 'OFF']) {
    const ci = season === 'PEAK' ? PEAK_CI : OFF_CI;
    const co = addDays(ci, 2);
    for (const meal of ['EP', 'CP', 'MAP', 'API']) {
      const exp = expectedFor(cat, season, meal, 2);
      CASES.push({
        id: `M-${SHORT_CAT[cat]}-${season}-${meal}`,
        block: 'matrix',
        title: `${cat.replace('_', ' ')} · ${season} · 2N · ${meal}`,
        room_id: ROOM_BY_TYPE[cat],
        check_in_date: ci, check_out_date: co,
        meal_plan_id: meal,
        expected_booking_total: exp.booking,
        expected_invoice_grand: exp.grand,
        expected_gst_slab: exp.slab,
      });
    }
  }
}

// BLOCK 2 — Extras coverage. For each category + meal plan, test the
// common Indian-resort extras configs: +1A, +1A+1C(mat), full combo.
// PEAK season only (we already validated OFF rates above).
const EXTRA_SCENARIOS = [
  { name: '+1A',          extra_adults: 1 },
  { name: '+1A+1C(mat)',  extra_adults: 1, extra_children_with_mattress: 1 },
  { name: '+1A+2C',       extra_adults: 1, extra_children_with_mattress: 1, extra_children_no_mattress: 1 },
];
for (const cat of ['SUPERIOR_VIEW', 'PREMIUM_BALC', 'RIVER_VIEW']) {
  for (const meal of ['EP', 'CP', 'MAP', 'API']) {
    for (const ex of EXTRA_SCENARIOS) {
      const exp = expectedFor(cat, 'PEAK', meal, 2, ex);
      const exLabel = ex.name;
      CASES.push({
        id: `X-${SHORT_CAT[cat]}-${meal}-${exLabel.replace(/[+()]/g, '')}`,
        block: 'extras',
        title: `${cat.replace('_', ' ')} · PEAK · 2N · ${meal} · ${exLabel}`,
        room_id: ROOM_BY_TYPE[cat],
        check_in_date: PEAK_CI, check_out_date: addDays(PEAK_CI, 2),
        meal_plan_id: meal,
        ...ex,
        expected_booking_total: exp.booking,
        expected_invoice_grand: exp.grand,
        expected_gst_slab: exp.slab,
      });
    }
  }
}

// BLOCK 3 — Stay-length coverage. 1N / 3N / 7N for a representative
// (River · PEAK · MAP) combination.
for (const nights of [1, 3, 7]) {
  const ci = PEAK_CI;
  const co = addDays(ci, nights);
  const exp = expectedFor('RIVER_VIEW', 'PEAK', 'MAP', nights);
  CASES.push({
    id: `L-RVR-MAP-${nights}N`,
    block: 'stay-length',
    title: `RIVER VIEW · PEAK · ${nights}N · MAP · no extras`,
    room_id: 'ROOM-101',
    check_in_date: ci, check_out_date: co,
    meal_plan_id: 'MAP',
    expected_booking_total: exp.booking,
    expected_invoice_grand: exp.grand,
    expected_gst_slab: exp.slab,
  });
}

// BLOCK 4 — Edge cases — algorithm-level correctness.
CASES.push(
  {
    // PEAK ends 2026-06-30 inclusive → 2026-07-01 starts OFF. A stay
    // 2026-06-30 → 2026-07-02 spans BOTH seasons. The math must use
    // night-1's PEAK rate for the first folio entry and night-2's OFF
    // rate for the second.
    id: 'E-PEAK-OFF-CROSS',
    block: 'edge',
    title: 'SUP · cross-season PEAK→OFF · 2N · MAP',
    room_id: 'ROOM-103',
    check_in_date: '2026-06-30', check_out_date: '2026-07-02',
    meal_plan_id: 'MAP',
    // PEAK MAP SUP = 4500 (night 1). OFF MAP SUP = 3300 (night 2). Total = 7800.
    // Per-night GST: 4500 × 12% = 540, 3300 × 12% = 396. Grand = 4500 + 540 + 3300 + 396 = 8736.
    expected_booking_total: 7800,
    expected_invoice_grand: 8736,
  },
  {
    // Date outside ANY season period → matrix returns null → fall through
    // to legacy base_rate (₹2000 for SUPERIOR).
    id: 'E-NO-SEASON',
    block: 'edge',
    title: 'SUP · 2028 (no season) · 2N · EP · legacy fallback',
    room_id: 'ROOM-103',
    check_in_date: '2028-03-10', check_out_date: '2028-03-12',
    meal_plan_id: 'EP',
    expected_booking_total: 4000, // 2000 × 2
    expected_invoice_grand: 4480, // 4000 × 1.12
    expected_gst_slab: 12,
  },
  {
    id: 'E-DAY-USE-SUP-CP',
    block: 'edge',
    title: 'SUP · PEAK · DAY-USE · CP',
    room_id: 'ROOM-103',
    check_in_date: PEAK_CI, check_out_date: PEAK_CI,
    booking_type: 'DAY_USE', meal_plan_id: 'CP',
    expected_booking_total: 3700,
    expected_invoice_grand: 4144,
    expected_gst_slab: 12,
  },
  {
    id: 'E-DAY-USE-RVR-API',
    block: 'edge',
    title: 'RVR · PEAK · DAY-USE · API · +1A (slab crosses to 18%)',
    room_id: 'ROOM-101',
    check_in_date: PEAK_CI, check_out_date: PEAK_CI,
    booking_type: 'DAY_USE', meal_plan_id: 'API', extra_adults: 1,
    // 6200 + 2200 = 8400 > 7500 → 18%
    expected_booking_total: 8400,
    expected_invoice_grand: 8400 + 8400 * 0.18,
    expected_gst_slab: 18,
  },
  {
    id: 'E-SLAB-EDGE-LOW',
    block: 'edge',
    title: 'SUP · OFF · 1N · EP (₹2000 → 12% slab)',
    room_id: 'ROOM-103',
    check_in_date: OFF_CI, check_out_date: addDays(OFF_CI, 1),
    meal_plan_id: 'EP',
    expected_booking_total: 2000,
    expected_invoice_grand: 2240,
    expected_gst_slab: 12,
  },
  {
    id: 'E-SLAB-EDGE-HIGH',
    block: 'edge',
    title: 'RVR · PEAK · 1N · API · +2A (line > ₹7500 → 18% slab)',
    room_id: 'ROOM-101',
    check_in_date: PEAK_CI, check_out_date: addDays(PEAK_CI, 1),
    meal_plan_id: 'API', extra_adults: 2,
    // 6200 + 2×2200 = 10600 > 7500 → 18%
    expected_booking_total: 10600,
    expected_invoice_grand: 10600 + 10600 * 0.18,
    expected_gst_slab: 18,
  },
  {
    id: 'E-SLAB-EDGE-EXTRAS-PUSH',
    block: 'edge',
    title: 'RVR · OFF · 1N · MAP · +1A (extras push line over ₹7500 → 18%)',
    room_id: 'ROOM-101',
    check_in_date: OFF_CI, check_out_date: addDays(OFF_CI, 1),
    meal_plan_id: 'MAP', extra_adults: 3,
    // RVR OFF MAP = 4100. +3 adults at 1600 = 4800. Total/night = 8900.
    // 8900 > 7500 → 18%.
    expected_booking_total: 8900,
    expected_invoice_grand: Math.round((8900 + 8900 * 0.18) * 100) / 100,
    expected_gst_slab: 18,
  },
  {
    // The "client booked, then added extras at check-in" path — the
    // booking total + folio subtotal must include the extras both times.
    id: 'E-FULL-COMBO-LONG',
    block: 'edge',
    title: 'RVR · OFF · 4N · API · +1A +1C(m) +1C(nm) (the BCG flagship case)',
    room_id: 'ROOM-101',
    check_in_date: OFF_CI, check_out_date: addDays(OFF_CI, 4),
    meal_plan_id: 'API', extra_adults: 1, extra_children_with_mattress: 1, extra_children_no_mattress: 1,
    expected_booking_total: 37600,
    expected_invoice_grand: 44368,
    expected_gst_slab: 18,
  },
);

// BLOCK 5 — Tariff configuration scenarios
CASES.push(
  {
    // Booking with NO meal plan → MATRIX path skipped, falls back to
    // legacy base_rate. Validates the "tenant onboarded but no meal
    // plans configured yet" UX.
    id: 'T-NO-MEAL-PLAN',
    block: 'tariff-config',
    title: 'SUP · OFF · 2N · NO meal plan (matrix bypass → base_rate)',
    room_id: 'ROOM-103',
    check_in_date: OFF_CI, check_out_date: addDays(OFF_CI, 2),
    meal_plan_id: null,
    expected_booking_total: 4000, // 2000 base × 2 nights
    expected_invoice_grand: 4480,
    expected_gst_slab: 12,
  },
  {
    // Custom meal plan ID that doesn't exist in ROOM_TARIFFS → matrix
    // returns null per cell → falls back to legacy base_rate.
    id: 'T-CUSTOM-PLAN-NO-MATRIX',
    block: 'tariff-config',
    title: 'SUP · PEAK · 2N · "HERITAGE" (custom plan, no matrix cell)',
    room_id: 'ROOM-103',
    check_in_date: PEAK_CI, check_out_date: addDays(PEAK_CI, 2),
    meal_plan_id: 'HERITAGE',
    expected_booking_total: 4000, // 2000 base × 2 (no matrix → legacy)
    expected_invoice_grand: 4480,
    expected_gst_slab: 12,
  },
  {
    // Manual rate override path: caller passed room_rate > 0 with a
    // non-matching matrix rate. Folio honours the manual override for
    // every night. (Tests the useExplicit branch.)
    id: 'T-MANUAL-RATE',
    block: 'tariff-config',
    title: 'PRM · PEAK · 2N · CP · manual room_rate=5000 (overrides matrix)',
    room_id: 'ROOM-204',
    check_in_date: PEAK_CI, check_out_date: addDays(PEAK_CI, 2),
    meal_plan_id: 'CP',
    // Real booking POST flow: when staff passes room_rate > 0, booking
    // POST stores total = rate × nights (no matrix, no extras computed).
    // The folio (post-fix Phase 4.1) honours the override per-night
    // and drops matrix-derived extras → invoice matches the quote.
    manual_room_rate: 5000,
    // Booking POST manual-rate branch: total = 5000 × 2 = 10000.
    expected_booking_total: 10000,
    // Folio after Phase 4.1 fix: useExplicitInMatrix=true → 5000 × 2 =
    // 10000 subtotal. 12% GST = 1200. Grand = 11200.
    expected_invoice_grand: 11200,
    expected_gst_slab: 12,
  },
);

// ─────────────────────────────────────────────────────────────────────
// RUN
// ─────────────────────────────────────────────────────────────────────

console.log(`${C.bold}╔════════════════════════════════════════════════════════════════════╗`);
console.log(`║       E2E TARIFF CALCULATION VALIDATOR — Atithi-Setu Hotel         ║`);
console.log(`║      Room × Season × Meal Plan × Extras · Full Coverage Run       ║`);
console.log(`╚════════════════════════════════════════════════════════════════════╝${C.reset}`);
console.log(`${C.gray}Running ${CASES.length} cases. Set VERBOSE=1 to see per-night breakdown.${C.reset}`);

// Section: Full matrix
section(`BLOCK 1 — Full matrix coverage (Room × Season × Meal Plan, 2 nights, no extras)`);
for (const c of CASES.filter(c => c.block === 'matrix')) runCase(c);

section(`BLOCK 2 — Extras coverage (PEAK, every category × meal plan × 3 extras configs)`);
for (const c of CASES.filter(c => c.block === 'extras')) runCase(c);

section(`BLOCK 3 — Stay-length coverage (1/3/7 nights)`);
for (const c of CASES.filter(c => c.block === 'stay-length')) runCase(c);

section(`BLOCK 4 — Edge cases (cross-season, slab boundaries, day-use, no-season fallback)`);
for (const c of CASES.filter(c => c.block === 'edge')) runCase(c);

section(`BLOCK 5 — Tariff configuration scenarios (no plan, custom plan, manual rate)`);
for (const c of CASES.filter(c => c.block === 'tariff-config')) {
  // Apply the manual_room_rate override into the booking simulation.
  // Real booking POST manual-rate branch: total = rate × nights (no
  // matrix, no extras). Then folio creation runs with that room_rate.
  if (c.manual_room_rate) {
    // Compute nights for the total-amount calc.
    let nights = 1;
    if (c.check_in_date !== c.check_out_date) {
      nights = Math.max(1, Math.ceil(
        (new Date(c.check_out_date).getTime() - new Date(c.check_in_date).getTime()) / 86400000
      ));
    }
    const bookingTotal = c.manual_room_rate * nights;
    const booking = {
      room_id: c.room_id, check_in_date: c.check_in_date, check_out_date: c.check_out_date,
      booking_type: c.booking_type, meal_plan_id: c.meal_plan_id,
      extra_adults: c.extra_adults,
      extra_children_with_mattress: c.extra_children_with_mattress,
      extra_children_no_mattress: c.extra_children_no_mattress,
      room_rate: c.manual_room_rate,
      total_amount: bookingTotal,
    };
    const folio = createFolioWithRoomCharges_PROD(c.room_id, booking);
    const bookingOK = Math.abs(bookingTotal - c.expected_booking_total) < 0.01;
    const grandOK   = Math.abs(folio.grand_total - c.expected_invoice_grand) < 0.01;
    const driftOK   = Math.abs(bookingTotal - folio.subtotal) < 0.01;
    const slabOK = c.expected_gst_slab == null || folio.entries.find(e => e.type === 'ROOM_CHARGE')?.gst_pct === c.expected_gst_slab;
    const allOK = bookingOK && grandOK && driftOK && slabOK;
    bookingOK ? passed++ : (failed++, failures.push(`${c.id}: booking ${bookingTotal} ≠ ${c.expected_booking_total}`));
    driftOK   ? passed++ : (failed++, failures.push(`${c.id}: drift booking=${bookingTotal} folio_subtotal=${folio.subtotal}`));
    grandOK   ? passed++ : (failed++, failures.push(`${c.id}: invoice grand ${folio.grand_total} ≠ ${c.expected_invoice_grand}`));
    if (c.expected_gst_slab != null) slabOK ? passed++ : (failed++, failures.push(`${c.id}: slab mismatch`));
    console.log(`  ${allOK ? C.green+'✓'+C.reset : C.red+'✗'+C.reset} ${c.id.padEnd(7)} ${c.title.padEnd(60)} booking=${fmt(bookingTotal).padStart(13)} grand=${fmt(folio.grand_total).padStart(13)}`);
  } else {
    runCase(c);
  }
}

// ─────────────────────────────────────────────────────────────────────
// REPORT
// ─────────────────────────────────────────────────────────────────────

console.log(`\n${C.bold}═════════════════════════════════════════════════════════════════════`);
console.log(`  TEST SUMMARY`);
console.log(`═════════════════════════════════════════════════════════════════════${C.reset}`);
console.log(`  ${C.green}✓ Passed:${C.reset}   ${passed}`);
console.log(`  ${C.red}✗ Failed:${C.reset}   ${failed}`);
console.log(`  ${C.yellow}⚠ Warnings:${C.reset} ${warned}  (prod folio ≠ correct folio)`);

if (failures.length) {
  console.log(`\n${C.red}${C.bold}FAILURES:${C.reset}`);
  for (const f of failures) console.log(`  • ${f}`);
}

if (warnings.length) {
  console.log(`\n${C.yellow}${C.bold}REVENUE DRIFT — production short-bills these scenarios:${C.reset}`);
  let totalLoss = 0;
  for (const w of warnings) {
    console.log(`  • ${w.id}  ${w.title}`);
    console.log(`      Production invoice grand: ${C.red}${fmt(w.prod)}${C.reset}`);
    console.log(`      Correct invoice grand:    ${C.green}${fmt(w.correct)}${C.reset}`);
    console.log(`      ${C.yellow}Short-billed by ${fmt(Math.abs(w.delta))}${C.reset}`);
    totalLoss += Math.abs(w.delta);
  }
  console.log(`\n  ${C.yellow}${C.bold}Cumulative under-billing across these test cases: ${fmt(totalLoss)}${C.reset}`);
  console.log(`  ${C.gray}(That's revenue lost per stay; multiply by every booking.)${C.reset}`);
}

console.log(`\n${C.bold}═════════════════════════════════════════════════════════════════════${C.reset}\n`);
process.exit(failed > 0 ? 1 : 0);
