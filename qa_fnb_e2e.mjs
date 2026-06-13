// ════════════════════════════════════════════════════════════════════════
//  qa_fnb_e2e.mjs — F&B charge-to-room → folio → checkout, end to end
//
//  Models the REAL chain (orders + folios + folio_entries) and the server's
//  NEW behaviour so the integration — not just isolated math — is asserted:
//
//   • A CHARGE_TO_ROOM order placed by an in-house guest posts to the OPEN
//     folio AT ORDER TIME (no dependency on anyone marking it delivered).
//   • booking_id is self-healed from the room's checked-in booking.
//   • At checkout the folio carries the F&B → the Room vs Restaurant split is
//     correct and the outstanding includes the F&B (so payment can be taken).
//   • Cancelling reverses the posted F&B (audit-preserving) so the cancelled
//     food leaves the bill.
//   • A guest with no open folio falls back to AWAITING_DELIVERY and posts on
//     check-in / sweep.
// ════════════════════════════════════════════════════════════════════════
const C = { g: '\x1b[32m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' };
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) pass++; else { fail++; console.log(`  ${C.r}✗${C.x} ${label}`); } };
const r2 = (n) => Math.round(n * 100) / 100;

// ── In-memory store ──
let folios = [];           // { id, booking_id, room_id, status }
let folioEntries = [];     // { id, folio_id, entry_type, amount, gst, source_id, reversal_of }
let orders = [];           // { id, room_id, booking_id, payment_method, status, folio_id, folio_post_status, items }
let bookings = [];         // { id, room_id, status }
let seq = 0;
const uid = (p) => `${p}-${++seq}`;

// ── Mirrors of the server helpers ──
function folioGrand(folioId) {
  return r2(folioEntries.filter(e => e.folio_id === folioId).reduce((s, e) => s + e.amount + e.gst, 0));
}
function resolveOpenFolio({ bookingId, roomId }) {
  if (bookingId) { const f = folios.find(f => f.booking_id === bookingId && f.status === 'open'); if (f) return f; }
  if (roomId)    { const f = folios.find(f => f.room_id === roomId && f.status === 'open'); if (f) return f; }
  return null;
}
// postOrderToFolio: idempotent, refuses cancelled, posts F_AND_B entries.
function postOrderToFolio(order) {
  if (order.folio_id && order.posted_at) return { ok: true, folio_id: order.folio_id, reason: 'already-posted' };
  if (String(order.status).toUpperCase() === 'CANCELLED') return { ok: false, reason: 'order-cancelled' };
  const f = resolveOpenFolio({ bookingId: order.booking_id, roomId: order.room_id });
  if (!f) return { ok: false, reason: 'no-open-folio' };
  for (const it of order.items) {
    if (!(it.qty > 0) || !(it.price >= 0)) continue;
    const amount = r2(it.qty * it.price);
    if (amount <= 0) continue;
    folioEntries.push({ id: uid('FE'), folio_id: f.id, entry_type: 'F_AND_B', amount, gst: r2(amount * (it.gst ?? 5) / 100), source_id: order.id, reversal_of: null });
  }
  order.folio_id = f.id; order.posted_at = true;
  return { ok: true, folio_id: f.id };
}
function reverseOrderFolioPosting(orderId) {
  let n = 0;
  for (const e of folioEntries.filter(e => e.source_id === orderId && !e.reversal_of && e.amount > 0)) {
    folioEntries.push({ id: uid('FE'), folio_id: e.folio_id, entry_type: 'F_AND_B', amount: -e.amount, gst: -e.gst, source_id: orderId, reversal_of: e.id });
    n++;
  }
  return { reversed_count: n };
}
// The order POST charge-to-room path (NEW behaviour).
function placeChargeToRoomOrder({ roomId, bookingId, items }) {
  const o = { id: uid('O'), room_id: roomId, booking_id: bookingId || null, payment_method: 'CHARGE_TO_ROOM', status: 'CONFIRMED', folio_id: null, posted_at: false, folio_post_status: null, items };
  orders.push(o);
  // self-heal booking_id from room's checked-in booking
  if (!o.booking_id && o.room_id) {
    const b = bookings.find(b => b.room_id === o.room_id && b.status === 'CHECKED_IN');
    if (b) o.booking_id = b.id;
  }
  const posted = postOrderToFolio(o);
  o.folio_post_status = posted.ok ? 'POSTED' : 'AWAITING_DELIVERY';
  return o;
}
function cancelOrder(o) { o.status = 'CANCELLED'; reverseOrderFolioPosting(o.id); }
// Checkout read: Room vs Restaurant split from folio entries (cancelled orders excluded from totals via reversal nets).
function checkoutView(folioId) {
  const grand = folioGrand(folioId);
  const fnb = r2(folioEntries.filter(e => e.folio_id === folioId && e.entry_type === 'F_AND_B').reduce((s, e) => s + e.amount + e.gst, 0));
  return { grand, restaurant: fnb, room: r2(grand - fnb) };
}

console.log(`${C.b}\n═══ F&B charge-to-room → folio → checkout (end to end) ═══${C.x}`);

// Setup: a checked-in guest in room R1 with an open folio carrying a room charge.
bookings.push({ id: 'BK1', room_id: 'R1', status: 'CHECKED_IN' });
folios.push({ id: 'F1', booking_id: 'BK1', room_id: 'R1', status: 'open' });
folioEntries.push({ id: uid('FE'), folio_id: 'F1', entry_type: 'ROOM_CHARGE', amount: 5000, gst: 600, source_id: null, reversal_of: null });

// 1. Guest orders F&B via QR (no booking_id on the order — placed without a session).
const o1 = placeChargeToRoomOrder({ roomId: 'R1', bookingId: null, items: [{ name: 'Club Sandwich', qty: 2, price: 250, gst: 5 }] }); // 500 + 25
ok(o1.booking_id === 'BK1', 'booking_id self-healed from the room’s checked-in booking');
ok(o1.folio_post_status === 'POSTED', 'order posts to the folio at order time (POSTED), not stuck AWAITING_DELIVERY');
ok(o1.folio_id === 'F1', 'order linked to the guest’s open folio');

// 2. At checkout the folio carries the F&B → split + outstanding include it.
const v1 = checkoutView('F1');
ok(v1.restaurant === 525, 'checkout shows Restaurant / F&B = 525 (500 + 25 GST)');
ok(v1.room === 5600, 'checkout shows Room & accommodation = 5600');
ok(v1.grand === 6125, 'folio grand total = 6125 → outstanding includes F&B (payment can be collected)');

// 3. A second order also lands immediately.
placeChargeToRoomOrder({ roomId: 'R1', bookingId: 'BK1', items: [{ name: 'Cola', qty: 1, price: 100, gst: 5 }] }); // 100 + 5
ok(checkoutView('F1').restaurant === 630, 'second F&B order adds to the restaurant bill (525 + 105 = 630)');

// 4. Cancel the first order → its F&B reverses off the folio (net zero).
cancelOrder(o1);
const v2 = checkoutView('F1');
ok(v2.restaurant === 105, 'after cancelling order 1, restaurant bill drops to the remaining 105');
ok(v2.room === 5600, 'room total unaffected by the F&B cancel');
ok(v2.grand === 5705, 'grand total reflects the reversal (5600 + 105)');

// 5. Guest NOT checked in yet → no open folio → AWAITING_DELIVERY (posts later).
bookings.push({ id: 'BK2', room_id: 'R2', status: 'BOOKED' });   // not checked in, no folio
const o3 = placeChargeToRoomOrder({ roomId: 'R2', bookingId: null, items: [{ name: 'Tea', qty: 1, price: 80, gst: 5 }] });
ok(o3.folio_post_status === 'AWAITING_DELIVERY', 'no open folio yet → AWAITING_DELIVERY (will post on check-in / sweep)');
ok(o3.folio_id === null, 'unposted order has no folio link yet');
// Guest checks in (folio created) → the sweep / delivery posts it.
folios.push({ id: 'F2', booking_id: 'BK2', room_id: 'R2', status: 'open' });
bookings.find(b => b.id === 'BK2').status = 'CHECKED_IN';
const swept = postOrderToFolio(o3);   // sweep retries
ok(swept.ok && checkoutView('F2').restaurant === 84, 'after check-in the pending F&B posts (80 + 4 GST = 84)');

// ── 6. CHECKOUT DISPLAY (17 Jun 2026) — the F&B must be VISIBLE at checkout
//      even when posting never set a folio_post_status (the long-standing
//      "no restaurant order shows at checkout" bug). Models GET
//      /bookings/:id/restaurant-bill (matches CHARGE_TO_ROOM by booking_id OR
//      room_id, ignores folio_post_status) and the CheckoutModal deriving the
//      unbilled-orders reconcile panel + restaurant-bill summary from it.
const orderAmt = (o) => r2(o.items.reduce((s, it) => s + it.qty * it.price, 0));
function restaurantBill(bookingId, roomId) {
  const os = orders.filter(o =>
    o.payment_method === 'CHARGE_TO_ROOM' &&
    String(o.status).toUpperCase() !== 'CANCELLED' &&
    (o.booking_id === bookingId || o.room_id === roomId));
  let total = 0, paid = 0, onFolio = 0, pending = 0;
  for (const o of os) {
    const amt = orderAmt(o); total += amt;
    const st = String(o.folio_post_status || '').toUpperCase();
    if (st === 'PAID_IN_ROOM') paid += amt; else if (st === 'POSTED') onFolio += amt; else pending += amt;
  }
  return { orders: os, total: r2(total), paid_in_room: r2(paid), on_folio: r2(onFolio), pending: r2(pending) };
}
const unbilledAtCheckout = (rb) => rb.orders.filter(o => {
  const st = String(o.folio_post_status || '').toUpperCase();
  return st !== 'POSTED' && st !== 'PAID_IN_ROOM';
});

// Fresh checked-in guest in R3 with an open folio carrying a room charge.
bookings.push({ id: 'BK3', room_id: 'R3', status: 'CHECKED_IN' });
folios.push({ id: 'F3', booking_id: 'BK3', room_id: 'R3', status: 'open' });
folioEntries.push({ id: uid('FE'), folio_id: 'F3', entry_type: 'ROOM_CHARGE', amount: 4000, gst: 480, source_id: null, reversal_of: null });
// An order delivered while the schema column was missing → its post threw and
// folio_post_status was never set (NULL). The OLD checkout paths dropped this:
// /orders/pending-folio required PENDING_MANUAL/AWAITING_DELIVERY, and the
// folio had no F_AND_B entry — so it was invisible. The robust restaurant-bill
// query still finds it.
const oStuck = { id: uid('O'), room_id: 'R3', booking_id: 'BK3', payment_method: 'CHARGE_TO_ROOM', status: 'DELIVERED', folio_id: null, posted_at: false, folio_post_status: null, items: [{ name: 'Pizza', qty: 1, price: 400, gst: 5 }] };
orders.push(oStuck);

const rb3 = restaurantBill('BK3', 'R3');
ok(rb3.total === 400, 'restaurant-bill surfaces the F&B even with NULL folio_post_status (total 400)');
ok(rb3.pending === 400, 'the stuck order is counted as pending (unbilled)');
ok(unbilledAtCheckout(rb3).length === 1, 'checkout reconcile panel now shows the order that was previously invisible');
ok(checkoutView('F3').restaurant === 0, 'folio carries no F&B yet (nothing was posted) — so without the bill view it would be hidden');

// Staff clicks "Charge to room" at checkout → posts it to the folio.
const postedStuck = postOrderToFolio(oStuck);
oStuck.folio_post_status = postedStuck.ok ? 'POSTED' : 'PENDING_MANUAL';
const rb3b = restaurantBill('BK3', 'R3');
ok(postedStuck.ok && rb3b.on_folio === 400 && rb3b.pending === 0, 'after Charge to room: F&B moves on-folio, nothing pending');
ok(unbilledAtCheckout(rb3b).length === 0, 'reconcile panel clears once charged');
ok(checkoutView('F3').restaurant === 420, 'folio split now shows Restaurant 420 (400 + 20 GST) at checkout');

console.log(`${C.b}\n═══════════════════════════════════════════════════════════════${C.x}`);
console.log(`  ${C.g}✓ Passed:${C.x} ${pass}`);
console.log(`  ${fail ? C.r : C.g}✗ Failed:${C.x} ${fail}`);
console.log(`${C.b}═══════════════════════════════════════════════════════════════${C.x}`);
process.exit(fail > 0 ? 1 : 0);
