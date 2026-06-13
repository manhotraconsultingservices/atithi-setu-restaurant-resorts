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

console.log(`${C.b}\n═══════════════════════════════════════════════════════════════${C.x}`);
console.log(`  ${C.g}✓ Passed:${C.x} ${pass}`);
console.log(`  ${fail ? C.r : C.g}✗ Failed:${C.x} ${fail}`);
console.log(`${C.b}═══════════════════════════════════════════════════════════════${C.x}`);
process.exit(fail > 0 ? 1 : 0);
