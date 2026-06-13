// ════════════════════════════════════════════════════════════════════════
//  qa_revenue_dedup.mjs — charge-to-room F&B is recognised ONCE, not twice
//
//  Policy (owner decision 16 Jun 2026): charge-to-room F&B is RESTAURANT/F&B
//  revenue (it stays in the orders-based reports). Hotel/room revenue reports
//  read folio grand_total but must SUBTRACT the F_AND_B folio lines (incl.
//  their GST, net of reversals) so the same sale is not booked as both
//  restaurant AND hotel revenue.
//
//  Mirrors the server SQL:
//    room_revenue = SUM(folio.grand_total - F&B(amount + gst))
//  and asserts consolidated revenue (restaurant + room) has no double count.
// ════════════════════════════════════════════════════════════════════════
const C = { g: '\x1b[32m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' };
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) pass++; else { fail++; console.log(`  ${C.r}✗${C.x} ${label}`); } };
const r2 = (n) => Math.round(n * 100) / 100;

// A folio's grand_total = Σ(entry.amount) + Σ(entry.gst) − discount.
const grandTotal = (entries, discount = 0) =>
  r2(entries.reduce((s, e) => s + Number(e.amount || 0) + Number(e.gst || 0), 0) - discount);

// Mirror of the report dedup: F&B portion of a folio = Σ(F_AND_B amount + gst),
// net of reversals (reversed lines carry negative amount + gst).
const fnbPortion = (entries) =>
  r2(entries.filter(e => e.type === 'F_AND_B').reduce((s, e) => s + Number(e.amount || 0) + Number(e.gst || 0), 0));

// Hotel/room revenue as the patched reports now compute it.
const roomRevenue = (entries, discount = 0) => r2(grandTotal(entries, discount) - fnbPortion(entries));
// Restaurant revenue from the orders side (the F&B sale, gross of GST).
const restaurantRevenue = (order) => r2(Number(order.amount || 0) + Number(order.gst || 0));

console.log(`${C.b}\n═══ Charge-to-room F&B recognised once (no double revenue) ═══${C.x}`);

// Folio: 1 room night ₹5000 (12% = 600) + room-service F&B ₹1000 (5% = 50).
const folio = [
  { type: 'ROOM_CHARGE', amount: 5000, gst: 600 },
  { type: 'F_AND_B',     amount: 1000, gst: 50  },   // posted from a CHARGE_TO_ROOM order
];
const fbOrder = { amount: 1000, gst: 50 };           // same sale, lives in `orders` too

ok(grandTotal(folio) === 6650, 'folio grand total = room 5600 + F&B 1050 = 6650 (guest pays this once)');
ok(fnbPortion(folio) === 1050, 'F&B portion of the folio = 1050 (amount + GST)');
ok(roomRevenue(folio) === 5600, 'hotel/room revenue EXCLUDES F&B → 5600 (5000 + 600 GST)');
ok(restaurantRevenue(fbOrder) === 1050, 'restaurant revenue counts the F&B order once = 1050');

// The whole point: consolidated revenue must NOT double-count the F&B.
const consolidated = r2(roomRevenue(folio) + restaurantRevenue(fbOrder));
ok(consolidated === 6650, 'consolidated (room 5600 + restaurant 1050) = 6650 — equals what the guest paid, no double count');
// What the OLD (buggy) behaviour produced: folio grand_total (incl. F&B) + restaurant order.
const oldDoubleCount = r2(grandTotal(folio) + restaurantRevenue(fbOrder));
ok(oldDoubleCount === 7700, 'pre-fix would have reported 7700 — overstated by the 1050 F&B (the bug)');

// Paid-in-room reversal: the F&B post is mirrored by a negative line → nets to
// zero in BOTH grand_total and fnbPortion, so room revenue == grand and there
// is no phantom F&B left on the hotel side.
const folioReversed = [
  { type: 'ROOM_CHARGE', amount: 5000, gst: 600 },
  { type: 'F_AND_B',     amount: 1000, gst: 50  },
  { type: 'F_AND_B',     amount: -1000, gst: -50 },   // reversal (guest paid in room)
];
ok(fnbPortion(folioReversed) === 0, 'reversed F&B nets to 0 in the F&B portion');
ok(grandTotal(folioReversed) === 5600, 'reversed F&B nets to 0 in grand total (room 5600 only)');
ok(roomRevenue(folioReversed) === 5600, 'room revenue = 5600; no phantom F&B after a paid-in-room reversal');

// Multi-folio aggregation (a night-audit / revenue-by-type sum) stays clean.
const folioB = [
  { type: 'ROOM_CHARGE', amount: 4000, gst: 480 },
  { type: 'F_AND_B',     amount: 500,  gst: 25  },
];
const totalRoom = r2(roomRevenue(folio) + roomRevenue(folioB));
ok(totalRoom === 5600 + 4480, 'two-folio room revenue sums cleanly (5600 + 4480), F&B excluded from both');

console.log(`${C.b}\n═══════════════════════════════════════════════════════════════${C.x}`);
console.log(`  ${C.g}✓ Passed:${C.x} ${pass}`);
console.log(`  ${fail ? C.r : C.g}✗ Failed:${C.x} ${fail}`);
console.log(`${C.b}═══════════════════════════════════════════════════════════════${C.x}`);
process.exit(fail > 0 ? 1 : 0);
