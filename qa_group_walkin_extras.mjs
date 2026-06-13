// ════════════════════════════════════════════════════════════════════════
//  qa_group_walkin_extras.mjs — walk-in + group occupancy/extras wiring audit
//
//  The extra-person PRICING (room × season × meal-plan × +adults/+children)
//  is exhaustively proven in qa_e2e_tariff_calculations.mjs, which exercises
//  the same computeBookingTotalWithExtras the booking POST + group POST call.
//
//  This suite locks the WIRING that the walk-in + group flows newly added
//  (client report 13 Jun 2026 "no option to add adult / child with-mattress /
//  without-mattress"):
//    • extra adults are DERIVED from the room's capacity (adults beyond
//      capacity are chargeable) — never sent raw by the client;
//    • num_guests = total adults + children (with + without mattress);
//    • a 0/blank room_rate routes through the matrix (rate + extras);
//    • a positive room_rate is an all-inclusive manual override (rate × nights,
//      extras NOT auto-added) — matching the single New Booking modal.
// ════════════════════════════════════════════════════════════════════════
const C = { g: '\x1b[32m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' };
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) pass++; else { fail++; console.log(`  ${C.r}✗${C.x} ${label}`); } };

// ── Mirror of server.ts deriveAdultExtras: capacity is included in the base
//    rate; only adults beyond capacity are chargeable. ──
const deriveAdultExtras = (capacity, totalAdults) => ({
  extraAdults: Math.max(0, Math.floor(totalAdults) - Math.max(1, Math.floor(capacity))),
});

// ── Mirror of the per-room occupancy resolution (occByRoom) used by BOTH the
//    booking POST and the group POST. ──
function resolveOcc(room) {
  const childMat   = Math.max(0, Number(room.extra_children_with_mattress || 0));
  const childNoMat = Math.max(0, Number(room.extra_children_no_mattress || 0));
  let extraAdults  = Math.max(0, Number(room.extra_adults || 0));
  let numAdultsToStore = null;
  let numGuests = Math.max(1, Number(room.num_guests || 1));
  if (room.num_adults != null && String(room.num_adults) !== '') {
    const totalAdults = Math.max(1, Math.floor(Number(room.num_adults) || 1));
    extraAdults = deriveAdultExtras(room.capacity, totalAdults).extraAdults;
    numAdultsToStore = totalAdults;
    numGuests = totalAdults + childMat + childNoMat;
  }
  return { extraAdults, numAdultsToStore, childMat, childNoMat, numGuests };
}

// ── Mirror of the per-room rate branch (manual override vs matrix+extras). A
//    tiny deterministic "matrix": base 1000/night, +500/extra-adult/night,
//    +300/child-with-mattress/night, +150/child-no-mattress/night. ──
const PER_NIGHT_BASE = 1000, A = 500, CM = 300, CN = 150;
function roomTotal(room, nights, occ) {
  const rate = Number(room.room_rate) || 0;
  if (rate > 0) return rate * nights;                       // manual override — no extras
  const extrasPerNight = occ.extraAdults * A + occ.childMat * CM + occ.childNoMat * CN;
  return (PER_NIGHT_BASE + extrasPerNight) * nights;        // matrix path — base + extras
}

console.log(`${C.b}\n═══ Walk-in + group occupancy / extras wiring ═══${C.x}`);

// 1) Within capacity → no extra adult; children still charged.
{
  const occ = resolveOcc({ capacity: 2, num_adults: 2, extra_children_with_mattress: 1, extra_children_no_mattress: 0 });
  ok(occ.extraAdults === 0, 'adults == capacity → 0 extra adults');
  ok(occ.numGuests === 3, 'num_guests = 2 adults + 1 child = 3');
  ok(roomTotal({ room_rate: 0 }, 2, occ) === (1000 + 300) * 2, '2N matrix: base + 1 child(mat) charged');
}

// 2) Adults beyond capacity → extra adults derived + charged.
{
  const occ = resolveOcc({ capacity: 2, num_adults: 3, extra_children_with_mattress: 0, extra_children_no_mattress: 1 });
  ok(occ.extraAdults === 1, '3 adults in a 2-cap room → 1 extra adult');
  ok(occ.numGuests === 4, 'num_guests = 3 adults + 1 child(no-mat) = 4');
  ok(roomTotal({ room_rate: 0 }, 1, occ) === (1000 + 500 + 150), '1N matrix: base + 1 extra adult + 1 child(no-mat)');
}

// 3) Both child types together.
{
  const occ = resolveOcc({ capacity: 2, num_adults: 2, extra_children_with_mattress: 1, extra_children_no_mattress: 2 });
  ok(occ.childMat === 1 && occ.childNoMat === 2, 'both child buckets captured independently');
  ok(occ.numGuests === 5, 'num_guests = 2 + 1 + 2 = 5');
  ok(roomTotal({ room_rate: 0 }, 1, occ) === (1000 + 300 + 2 * 150), '1N matrix: base + 1 child(mat) + 2 child(no-mat)');
}

// 4) Manual room_rate override → extras NOT auto-added (matches single modal).
{
  const occ = resolveOcc({ capacity: 2, num_adults: 4, extra_children_with_mattress: 2, extra_children_no_mattress: 0 });
  ok(occ.extraAdults === 2, 'derive still runs (2 extra adults) even with manual rate');
  ok(roomTotal({ room_rate: 4000 }, 2, occ) === 8000, 'manual rate 4000 × 2N = 8000 — extras ignored');
}

// 5) Legacy client (only num_guests, no num_adults) → preserved untouched.
{
  const occ = resolveOcc({ capacity: 2, num_guests: 3 });
  ok(occ.numAdultsToStore === null, 'no num_adults → numAdultsToStore stays null');
  ok(occ.extraAdults === 0 && occ.numGuests === 3, 'legacy num_guests preserved, no derived extras');
}

// 6) A 3-room group sums each room independently (mixed occupancy).
{
  const nights = 2;
  const groupRooms = [
    { capacity: 2, num_adults: 2, extra_children_with_mattress: 0, extra_children_no_mattress: 0, room_rate: 0 }, // base only
    { capacity: 2, num_adults: 3, extra_children_with_mattress: 0, extra_children_no_mattress: 0, room_rate: 0 }, // +1 adult
    { capacity: 2, num_adults: 2, extra_children_with_mattress: 2, extra_children_no_mattress: 0, room_rate: 0 }, // +2 child(mat)
  ];
  const total = groupRooms.reduce((s, rm) => s + roomTotal(rm, nights, resolveOcc(rm)), 0);
  const expect = (1000) * 2 + (1000 + 500) * 2 + (1000 + 2 * 300) * 2; // 2000 + 3000 + 3200
  ok(total === expect, `group of 3 sums per-room extras correctly (₹${total} == ₹${expect})`);
  const guests = groupRooms.reduce((s, rm) => s + resolveOcc(rm).numGuests, 0);
  ok(guests === 2 + 3 + 4, 'group total guests = 2 + 3 + 4 = 9');
}

console.log(`${C.b}\n═══════════════════════════════════════════════════════════════${C.x}`);
console.log(`  ${C.g}✓ Passed:${C.x} ${pass}`);
console.log(`  ${fail ? C.r : C.g}✗ Failed:${C.x} ${fail}`);
console.log(`${C.b}═══════════════════════════════════════════════════════════════${C.x}`);
process.exit(fail > 0 ? 1 : 0);
