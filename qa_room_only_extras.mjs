// ════════════════════════════════════════════════════════════════════════
//  qa_room_only_extras.mjs — extra-person charges on ROOM-ONLY stays
//  (19 Jun 2026). A room-only booking (no meal plan) with extra adults /
//  children must STILL be billed for them. The tariff's extra-person matrix
//  is keyed per meal plan with no "no meal plan" column, so a room-only stay
//  falls back to the LOWEST configured rate for that person-type + season.
//
//  Mirrors server.ts getExtraPersonChargeForDate + computeBookingTotalWithExtras
//  + createFolioWithRoomCharges so the booking total, the folio, and the
//  frontend live preview all agree.
// ════════════════════════════════════════════════════════════════════════
const C = { g: '\x1b[32m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' };
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log(`  ${C.r}✗${C.x} ${label}`); } };
const r2 = (n) => Math.round(n * 100) / 100;

// One season; extra-person rates per meal plan (AP dearest, CP cheapest).
// No room-only / NULL-meal-plan row exists — exactly the gap this fixes.
const SEASON = 'PEAK';
const extraCharges = [
  { person_type: 'ADULT',              season_id: 'PEAK', meal_plan_id: 'AP', charge: 1500 },
  { person_type: 'ADULT',              season_id: 'PEAK', meal_plan_id: 'CP', charge: 1000 },
  { person_type: 'CHILD_WITH_MATTRESS',season_id: 'PEAK', meal_plan_id: 'AP', charge: 900 },
  { person_type: 'CHILD_WITH_MATTRESS',season_id: 'PEAK', meal_plan_id: 'CP', charge: 600 },
  { person_type: 'CHILD_NO_MATTRESS',  season_id: 'PEAK', meal_plan_id: 'AP', charge: 700 },
  { person_type: 'CHILD_NO_MATTRESS',  season_id: 'PEAK', meal_plan_id: 'CP', charge: 400 },
];

// Mirror of getExtraPersonChargeForDate. seasonId null → 0 (legacy / off-season).
function getExtraPersonCharge(seasonId, mealPlanId, personType) {
  if (!seasonId) return 0;
  if (mealPlanId) {
    const row = extraCharges.find(r => r.person_type === personType && r.season_id === seasonId && r.meal_plan_id === mealPlanId);
    return Number(row?.charge || 0);
  }
  // Room-only: lowest configured rate for this person-type + season.
  const rows = extraCharges.filter(r => r.person_type === personType && r.season_id === seasonId && Number(r.charge || 0) > 0);
  return rows.length ? Math.min(...rows.map(r => Number(r.charge))) : 0;
}

// Mirror of the per-night extras computation (matrix mode, any meal plan incl.
// none). Returns extras for ONE night given the booking's extra-person counts.
function extrasForNight(seasonId, mealPlanId, { adults = 0, childMat = 0, childNoMat = 0 }) {
  let e = 0;
  if (adults > 0)    e += getExtraPersonCharge(seasonId, mealPlanId, 'ADULT') * adults;
  if (childMat > 0)  e += getExtraPersonCharge(seasonId, mealPlanId, 'CHILD_WITH_MATTRESS') * childMat;
  if (childNoMat > 0)e += getExtraPersonCharge(seasonId, mealPlanId, 'CHILD_NO_MATTRESS') * childNoMat;
  return r2(e);
}

// Mirror of the stay total: base (room rate × nights) + Σ per-night extras.
function stayTotal({ baseRatePerNight, nights, seasonId, mealPlanId, counts, matrix = true }) {
  let total = 0;
  for (let i = 0; i < nights; i++) {
    const ex = matrix ? extrasForNight(seasonId, mealPlanId, counts) : 0;
    total += baseRatePerNight + ex;
  }
  return r2(total);
}

console.log(`${C.b}\n═══ Room-only extra-person charges ═══${C.x}`);

// 1. Room-only (no meal plan), 2 children no-mattress → MIN child-no-mat rate.
ok(getExtraPersonCharge(SEASON, null, 'CHILD_NO_MATTRESS') === 400,
  'room-only child (no-mat) → lowest configured rate (₹400, the CP rate)');

// 2. Room-only extra adult → lowest adult rate.
ok(getExtraPersonCharge(SEASON, null, 'ADULT') === 1000,
  'room-only extra adult → lowest configured adult rate (₹1000)');

// 3. With an explicit meal plan → that plan's exact rate (unchanged behaviour).
ok(getExtraPersonCharge(SEASON, 'AP', 'CHILD_NO_MATTRESS') === 700,
  'meal-plan booking → exact plan rate (AP child no-mat = ₹700)');

// 4. The reported scenario: 1 adult + 2 children (no-mat), ROOM ONLY, 1 night,
//    base ₹4,800/night. Old behaviour billed ₹4,800 (extras dropped); now the
//    2 children are billed at the room-only rate.
const reported = stayTotal({ baseRatePerNight: 4800, nights: 1, seasonId: SEASON, mealPlanId: null, counts: { childNoMat: 2 } });
ok(reported === 4800 + 2 * 400, `room-only 1 night + 2 children → ₹${reported} (base 4800 + 2×400)`);

// 5. Multi-night room-only extras scale per night.
const twoNight = stayTotal({ baseRatePerNight: 4800, nights: 2, seasonId: SEASON, mealPlanId: null, counts: { adults: 1, childNoMat: 1 } });
ok(twoNight === 2 * (4800 + 1000 + 400), `room-only 2 nights + 1 adult + 1 child → ₹${twoNight}`);

// 6. Meal-plan booking unchanged: 2 nights AP + 1 child no-mat.
const ap = stayTotal({ baseRatePerNight: 5200, nights: 2, seasonId: SEASON, mealPlanId: 'AP', counts: { childNoMat: 1 } });
ok(ap === 2 * (5200 + 700), `meal-plan (AP) booking still bills the AP extra rate → ₹${ap}`);

// 7. No extras → just the room rate (no phantom charge).
const noExtras = stayTotal({ baseRatePerNight: 4800, nights: 1, seasonId: SEASON, mealPlanId: null, counts: {} });
ok(noExtras === 4800, 'room-only with no extra persons → base only (no phantom extra charge)');

// 8. Legacy / no season configured → no extras (unchanged for non-matrix tenants).
ok(getExtraPersonCharge(null, null, 'CHILD_NO_MATTRESS') === 0, 'no season (legacy) → 0 extra-person charge');

// 9. Folio split is sum-preserving: lineAmount = base + extras, and the itemised
//    per-type extra lines sum back to the night's extras (room-only path).
const night = { base: 4800, extras: extrasForNight(SEASON, null, { childNoMat: 2, childMat: 1 }) };
const lineAmount = r2(night.base + night.extras);
const perType = [
  r2(getExtraPersonCharge(SEASON, null, 'CHILD_WITH_MATTRESS') * 1),
  r2(getExtraPersonCharge(SEASON, null, 'CHILD_NO_MATTRESS') * 2),
];
ok(r2(perType.reduce((s, x) => s + x, 0)) === night.extras, 'itemised per-type extras sum back to the night extras (sum-preserving)');
ok(lineAmount === r2(night.base + perType.reduce((s, x) => s + x, 0)), 'base + itemised extras === room-charge line amount');

console.log(`${C.b}\n═══════════════════════════════════════════════════════════════${C.x}`);
console.log(`  ${C.g}✓ Passed:${C.x} ${pass}`);
console.log(`  ${fail ? C.r : C.g}✗ Failed:${C.x} ${fail}`);
console.log(`${C.b}═══════════════════════════════════════════════════════════════${C.x}`);
process.exit(fail > 0 ? 1 : 0);
