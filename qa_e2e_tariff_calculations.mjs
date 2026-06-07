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

// Mirror of createFolioWithRoomCharges after the BCG Tariff Phase 3.1 fix
// (server.ts:1077+). Now matrix-aware: when meal_plan_id is set, uses
// computeBookingTotalWithExtras for per-night base + extras and applies
// the GST slab to the FULL per-night line (base + extras) so stays that
// cross ₹7,500 via extras get the correct 18% slab.
function createFolioWithRoomCharges_PROD(roomId, booking) {
  const useMatrix = !!booking.meal_plan_id; // tariff_model='MATRIX' is set by BCG seed
  let perNight;
  if (useMatrix) {
    const breakdown = computeBookingTotalWithExtras(roomId, booking.check_in_date, booking.check_out_date, {
      mealPlanId:                booking.meal_plan_id,
      extraAdults:               booking.extra_adults,
      extraChildrenWithMattress: booking.extra_children_with_mattress,
      extraChildrenNoMattress:   booking.extra_children_no_mattress,
      bookingType:               booking.booking_type,
    });
    perNight = breakdown.per_night.map(n => ({ date: n.date, base_rate: n.base_rate, extras: n.extras }));
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

let passed = 0, failed = 0, warned = 0;
const failures = [];
const warnings = [];

function runCase(c) {
  console.log(`\n${C.bold}${C.cyan}━━━ Case ${c.id}: ${c.title} ━━━${C.reset}`);
  console.log(`${C.gray}  Room: ${ROOMS[c.room_id].room_number} (${ROOM_TYPES[ROOMS[c.room_id].type_id].name})`);
  console.log(`  Dates: ${c.check_in_date} → ${c.check_out_date}  (booking_type=${c.booking_type || 'OVERNIGHT'})`);
  console.log(`  Meal plan: ${c.meal_plan_id || '—'}, Extra adults: ${c.extra_adults || 0}, Child(mat): ${c.extra_children_with_mattress || 0}, Child(no-mat): ${c.extra_children_no_mattress || 0}${C.reset}`);

  // ── STAGE 1: Booking total ────────────────────────────────────────
  const breakdown = computeBookingTotalWithExtras(c.room_id, c.check_in_date, c.check_out_date, {
    mealPlanId: c.meal_plan_id, extraAdults: c.extra_adults,
    extraChildrenWithMattress: c.extra_children_with_mattress,
    extraChildrenNoMattress: c.extra_children_no_mattress,
    bookingType: c.booking_type,
  });
  console.log(`${C.gray}  Per-night:${C.reset}`);
  for (const n of breakdown.per_night) {
    const seasonId = getSeasonForDate(n.date);
    console.log(`${C.gray}    ${n.date} [${(seasonId || 'NO-SEASON').padEnd(4)} ${n.source.padEnd(18)}] base=${fmt(n.base_rate).padStart(12)}  extras=${fmt(n.extras).padStart(10)}${C.reset}`);
  }
  const stage1OK = Math.abs(breakdown.total - c.expected_booking_total) < 0.01;
  if (stage1OK) {
    console.log(`  ${C.green}✓${C.reset} Booking total = ${fmt(breakdown.total)}  (matches expected)`);
    passed++;
  } else {
    console.log(`  ${C.red}✗${C.reset} Booking total = ${fmt(breakdown.total)}  ${C.red}EXPECTED ${fmt(c.expected_booking_total)}${C.reset}`);
    failed++;
    failures.push(`Case ${c.id}: booking total mismatch (got ${breakdown.total}, expected ${c.expected_booking_total})`);
  }

  // The booking row simulator — what gets saved to the DB.
  const booking = {
    room_id: c.room_id,
    check_in_date: c.check_in_date,
    check_out_date: c.check_out_date,
    booking_type: c.booking_type,
    meal_plan_id: c.meal_plan_id,
    extra_adults: c.extra_adults,
    extra_children_with_mattress: c.extra_children_with_mattress,
    extra_children_no_mattress: c.extra_children_no_mattress,
    // Per server.ts:17884 — room_rate stores per_night[0].base_rate ONLY
    // (not extras, not avg).
    room_rate: breakdown.per_night[0]?.base_rate || 0,
    total_amount: breakdown.total,
  };

  // ── STAGE 2: Folio creation (current PRODUCTION behaviour) ──────
  const folioProd = createFolioWithRoomCharges_PROD(c.room_id, booking);
  console.log(`  ${C.gray}Folio (PROD path — legacy resolver):${C.reset}`);
  console.log(`    subtotal=${fmt(folioProd.subtotal)}  gst=${fmt(folioProd.gst)}  grand_total=${fmt(folioProd.grand_total)}`);

  // ── STAGE 2b: Folio creation (CORRECT behaviour) ─────────────────
  const folioCorrect = createFolioWithRoomCharges_CORRECT(c.room_id, booking);
  console.log(`  ${C.gray}Folio (CORRECT — matrix-aware):${C.reset}`);
  console.log(`    subtotal=${fmt(folioCorrect.subtotal)}  gst=${fmt(folioCorrect.gst)}  grand_total=${fmt(folioCorrect.grand_total)}`);

  // ── ASSERT: booking total should equal folio subtotal ──────────
  const drift = Math.round((booking.total_amount - folioProd.subtotal) * 100) / 100;
  if (Math.abs(drift) < 0.01) {
    console.log(`  ${C.green}✓${C.reset} Booking total == folio subtotal (no drift)`);
    passed++;
  } else {
    const direction = drift > 0 ? 'UNDER-BILLED' : 'OVER-BILLED';
    console.log(`  ${C.red}✗ ${direction}: booking ${fmt(booking.total_amount)} vs folio subtotal ${fmt(folioProd.subtotal)} (Δ ${fmt(Math.abs(drift))})${C.reset}`);
    failed++;
    failures.push(`Case ${c.id}: revenue drift ${drift} (${direction})`);
  }

  // ── ASSERT: invoice grand_total matches expected ────────────────
  if (c.expected_invoice_grand != null) {
    const grandOK = Math.abs(folioProd.grand_total - c.expected_invoice_grand) < 0.01;
    if (grandOK) {
      console.log(`  ${C.green}✓${C.reset} Invoice grand_total = ${fmt(folioProd.grand_total)} (matches expected)`);
      passed++;
    } else {
      console.log(`  ${C.red}✗${C.reset} Invoice grand_total = ${fmt(folioProd.grand_total)}  ${C.red}EXPECTED ${fmt(c.expected_invoice_grand)}${C.reset}`);
      failed++;
      failures.push(`Case ${c.id}: invoice grand_total mismatch (got ${folioProd.grand_total}, expected ${c.expected_invoice_grand})`);
    }
  }

  // Surface any case where prod path differs from correct path.
  const grandDelta = Math.round((folioCorrect.grand_total - folioProd.grand_total) * 100) / 100;
  if (Math.abs(grandDelta) >= 0.01) {
    warnings.push({ id: c.id, title: c.title, prod: folioProd.grand_total, correct: folioCorrect.grand_total, delta: grandDelta });
    warned++;
    console.log(`  ${C.yellow}⚠${C.reset}  Prod grand ${fmt(folioProd.grand_total)} vs correct grand ${fmt(folioCorrect.grand_total)} → invoice short by ${C.yellow}${fmt(Math.abs(grandDelta))}${C.reset}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// CASES
// ─────────────────────────────────────────────────────────────────────

// expected_invoice_grand reflects the CORRECT (matrix-aware) value —
// the value the customer was quoted at booking time, plus GST. A
// failure here means the production folio path under/over-bills relative
// to the price the guest was promised.
const CASES = [
  {
    id: 'C1',
    title: 'SUPERIOR · PEAK · 2 nights · EP · no extras',
    room_id: 'ROOM-103',
    check_in_date: '2026-05-10', check_out_date: '2026-05-12',
    meal_plan_id: 'EP',
    // 2 nights × ₹3200 = ₹6400. GST per night: 3200 ≤ 7500 → 12%.
    // Per-night GST = 3200 × 0.12 = ₹384. Total GST = ₹768. Grand = ₹7168.
    expected_booking_total: 6400,
    expected_invoice_grand: 7168,
  },
  {
    id: 'C2',
    title: 'SUPERIOR · OFF · 2 nights · EP · no extras',
    room_id: 'ROOM-103',
    check_in_date: '2026-08-10', check_out_date: '2026-08-12',
    meal_plan_id: 'EP',
    // Matrix OFF/EP = ₹2000 — happens to match base_rate (no drift visible).
    expected_booking_total: 4000,
    expected_invoice_grand: 4480,  // 4000 + 12% = 4480
  },
  {
    id: 'C3',
    title: 'PREMIUM · PEAK · 3 nights · CP · no extras',
    room_id: 'ROOM-204',
    check_in_date: '2026-05-15', check_out_date: '2026-05-18',
    meal_plan_id: 'CP',
    // Matrix ₹4200/night × 3 = ₹12,600.
    // booking.room_rate = 4200 (matrix per_night[0]) → folio useExplicit
    // path keeps 4200. Subtotal 12600, 12% = 1512. Grand = ₹14,112.
    expected_booking_total: 12600,
    expected_invoice_grand: 14112,
  },
  {
    id: 'C4',
    title: 'RIVER · PEAK · 2 nights · MAP · +1 ADULT',
    room_id: 'ROOM-101',
    check_in_date: '2026-05-20', check_out_date: '2026-05-22',
    meal_plan_id: 'MAP', extra_adults: 1,
    // Matrix ₹5500/night + ₹1800 extra adult = ₹7300/night × 2 = ₹14,600.
    // Per-night line 7300 ≤ 7500 → 12%. GST = 876/night × 2 = ₹1752.
    // CORRECT grand = 14600 + 1752 = ₹16,352.
    expected_booking_total: 14600,
    expected_invoice_grand: 16352,
  },
  {
    id: 'C5',
    title: 'RIVER · OFF · 4 nights · API · +1 ADULT +1 CHILD(mat) +1 CHILD(no-mat)',
    room_id: 'ROOM-101',
    check_in_date: '2026-09-10', check_out_date: '2026-09-14',
    meal_plan_id: 'API', extra_adults: 1, extra_children_with_mattress: 1, extra_children_no_mattress: 1,
    // Matrix base 4800/night. Extras: ADULT 2000 + CHILD_MAT 1500 + CHILD_NO_MAT 1100 = 4600.
    // Per-night 9400. 4 nights → ₹37,600.
    // Per-night line 9400 > 7500 → 18%. GST = 1692/night × 4 = ₹6768. Grand = ₹44,368.
    expected_booking_total: 37600,
    expected_invoice_grand: 44368,
  },
  {
    id: 'C6',
    title: 'SUPERIOR · PEAK→OFF crossover · 2 nights · MAP',
    room_id: 'ROOM-103',
    // 2026-06-30 = last day of PEAK, 2026-07-01 = first day of OFF.
    check_in_date: '2026-06-30', check_out_date: '2026-07-02',
    meal_plan_id: 'MAP',
    // Night 1 PEAK MAP = 4500. Night 2 OFF MAP = 3300. Total ₹7,800.
    // Per night GST 12% (both ≤ 7500). GST 540 + 396 = 936. Grand = ₹8,736.
    expected_booking_total: 7800,
    expected_invoice_grand: 8736,
  },
  {
    id: 'C7',
    title: 'SUPERIOR · no-season date · EP · matrix fall-through',
    room_id: 'ROOM-103',
    // 2028 has no season period → matrix returns null → legacy fallback.
    check_in_date: '2028-03-10', check_out_date: '2028-03-12',
    meal_plan_id: 'EP',
    expected_booking_total: 4000,
    expected_invoice_grand: 4480,
  },
  {
    id: 'C8',
    title: 'SUPERIOR · PEAK · DAY-USE · CP',
    room_id: 'ROOM-103',
    check_in_date: '2026-05-10', check_out_date: '2026-05-10',
    booking_type: 'DAY_USE', meal_plan_id: 'CP',
    // Single "night" at PEAK SUPERIOR CP = ₹3700. 12% GST = 444. Grand = ₹4,144.
    expected_booking_total: 3700,
    expected_invoice_grand: 4144,
  },
  {
    id: 'C9',
    title: 'RIVER · PEAK · 1 night · API · no extras',
    room_id: 'ROOM-101',
    check_in_date: '2026-05-25', check_out_date: '2026-05-26',
    meal_plan_id: 'API',
    // Matrix ₹6200, 12%. GST 744. Grand ₹6,944.
    expected_booking_total: 6200,
    expected_invoice_grand: 6944,
  },
  {
    id: 'C10',
    title: 'RIVER · PEAK · API · 2 ADULTs (matrix line > ₹7500 → 18% slab)',
    room_id: 'ROOM-101',
    check_in_date: '2026-05-25', check_out_date: '2026-05-26',
    meal_plan_id: 'API', extra_adults: 2,
    // Matrix base 6200 + 2 × extra adult 2200 = 10600. > 7500 → 18%.
    // GST = 1908. Grand = ₹12,508.
    expected_booking_total: 10600,
    expected_invoice_grand: 12508,
  },
];

// ─────────────────────────────────────────────────────────────────────
// RUN
// ─────────────────────────────────────────────────────────────────────

console.log(`${C.bold}╔════════════════════════════════════════════════════════════════════╗`);
console.log(`║       E2E TARIFF CALCULATION VALIDATOR — Atithi-Setu Hotel         ║`);
console.log(`║         Room Category × Season × Meal Plan × Extra Person         ║`);
console.log(`╚════════════════════════════════════════════════════════════════════╝${C.reset}`);

for (const c of CASES) runCase(c);

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
