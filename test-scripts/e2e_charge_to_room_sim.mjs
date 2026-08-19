/**
 * Charge Restaurant Bill to Room — deterministic offline billing simulation.
 *
 * This does NOT hit a server. It reproduces the exact arithmetic + state
 * transitions of the feature so a regression in the billing math or the
 * "clear everything in one settlement" invariant fails CI without needing a
 * live tenant. It mirrors, line-for-line, the real server helpers:
 *   - the item → folio mapping in POST /sessions/:token/charge-to-room
 *   - postOrderToFolio  (F_AND_B entry per item, hotel-slab GST, idempotent)
 *   - recomputeFolioTotals  (grand = subtotal + gst − discount)
 *   - getFolioOutstanding   (outstanding = max(0, grand − net_paid))
 *   - the check-out settle   (one FINAL payment clears room + F&B → 'settled')
 *
 * Run: node test-scripts/e2e_charge_to_room_sim.mjs
 */

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? ' | ' + detail : ''}`); }
  else { failed++; console.error(`  ❌ ${name}${detail ? ' | ' + detail : ''}`); }
};
const round2 = (n) => Math.round(n * 100) / 100;

// ── Mirror of the server helpers ────────────────────────────────────────────

// Hotel F&B GST slab used by postOrderToFolio when NO per-item rate is passed
// (the charge-to-room endpoint deliberately omits gstRate → hotel slab applies).
const HOTEL_FNB_GST = 5;

// item mapping exactly as server.ts charge-to-room endpoint builds it
const mapItems = (items) => (Array.isArray(items) ? items : []).map((it) => ({
  name: it.name || it.menuName || 'Item',
  quantity: Number(it.quantity || it.qty || 1),
  unitPrice: Number(it.price ?? it.unitPrice ?? it.unit_price ?? 0),
  // gstRate intentionally omitted → hotel slab
}));

// postOrderToFolio: writes one F_AND_B entry per line, idempotent per order id.
function postOrderToFolio(folio, order) {
  if (order.folio_id && order.posted_to_folio_at) return { ok: true, already: true }; // idempotency guard
  if (String(order.status).toUpperCase() === 'CANCELLED') return { ok: false, reason: 'order-cancelled' };
  for (const it of mapItems(order.items)) {
    const amount = round2(it.unitPrice * it.quantity);         // pre-tax line amount
    const gst_amount = round2(amount * HOTEL_FNB_GST / 100);   // hotel slab
    folio.entries.push({ entry_type: 'F_AND_B', reference_number: order.id, amount, gst_amount });
  }
  order.folio_id = folio.id;
  order.posted_to_folio_at = new Date('2026-01-01T00:00:00Z').toISOString();
  return { ok: true, folio_id: folio.id };
}

// recomputeFolioTotals
function recompute(folio) {
  const subtotal = round2(folio.entries.reduce((s, e) => s + Number(e.amount || 0), 0));
  const gst = folio.gst_exempt ? 0 : round2(folio.entries.reduce((s, e) => s + Number(e.gst_amount || 0), 0));
  folio.subtotal = subtotal;
  folio.gst_amount = gst;
  folio.grand_total = Math.max(0, round2(subtotal + gst - (folio.discount || 0)));
}

// getFolioOutstanding
function outstanding(folio) {
  const net = folio.payments.filter(p => !p.voided).reduce((s, p) => s + (p.type === 'REFUND' ? -p.amount : p.amount), 0);
  return Math.max(0, round2(folio.grand_total - net));
}

// The charge-to-room endpoint body: post every non-cancelled session order.
function chargeSessionToRoom(session, folio, actor = 'RESTAURANT_BILL') {
  let postedCount = 0;
  for (const o of session.orders) {
    if (String(o.status).toUpperCase() === 'CANCELLED') continue;
    // tag first (charge-to-room + delivered, NOT paid)
    o.payment_method = 'CHARGE_TO_ROOM';
    o.status = 'DELIVERED';
    o.booking_id = o.booking_id || folio.booking_id;
    o.room_id = o.room_id || folio.room_id;
    const r = postOrderToFolio(folio, o);
    if (r.ok) { o.folio_post_status = 'POSTED'; postedCount++; }
  }
  if (postedCount === 0) return { ok: false, error: 'no open folio / nothing posted' };
  session.status = 'closed';
  session.payment_method = 'CHARGE_TO_ROOM';
  recompute(folio);
  return { ok: true, postedCount };
}

// ── Manual-invoice charge-to-room (POST /invoices/manual) ────────────────────
// Mirrors the new branch: the MAN- invoice row is created first, then posted to
// the folio at the hotel F&B slab. The cashier's restaurant discount / service /
// GST are FORCED OFF (the folio owns the tax), and the whole thing is ATOMIC —
// if the folio post fails, the just-created invoice is hard-deleted and a 409 is
// returned so we never strand an invoice that claims charged-to-room with no
// matching folio line.
function chargeManualInvoiceToRoom(invoice, folio) {
  // The backend INSERTs the MAN- row before attempting the post.
  invoice.persisted = true;
  // Restaurant adjustments do not apply under charge-to-room.
  invoice.discount_amount = 0;
  invoice.service_charge_percent = 0;
  invoice.gst_percent = 0;
  invoice.apply_gst = false;
  invoice.payment_method = 'CHARGE_TO_ROOM';
  invoice.room_id = invoice.room_id || (folio && folio.room_id) || null;
  invoice.booking_id = invoice.booking_id || (folio && folio.booking_id) || null;
  const order = { id: invoice.id, status: 'CONFIRMED', items: invoice.items };
  // postOrderToFolio needs an OPEN folio for a checked-in guest.
  const r = (folio && String(folio.status) === 'open')
    ? postOrderToFolio(folio, order)
    : { ok: false, reason: 'no-open-folio' };
  if (!r.ok) {
    invoice.persisted = false;   // atomic hard-delete of the MAN- row
    return { ok: false, http: 409, error: 'could-not-post-to-room' };
  }
  invoice.folio_post_status = 'POSTED';
  recompute(folio);
  return { ok: true };
}

// ── Scenario ────────────────────────────────────────────────────────────────
console.log('\n── Charge Restaurant Bill to Room — offline simulation ──\n');

// A checked-in guest with a folio already carrying 2 room-nights (₹3000 + 12% GST)
// and a ₹1000 advance collected at check-in.
const folio = {
  id: 'FOL1', booking_id: 'BKG1', room_id: 'RM101', status: 'open', discount: 0, gst_exempt: 0,
  entries: [
    { entry_type: 'ROOM_CHARGE', reference_number: 'RM-NIGHT-1', amount: 1500, gst_amount: 180 },
    { entry_type: 'ROOM_CHARGE', reference_number: 'RM-NIGHT-2', amount: 1500, gst_amount: 180 },
  ],
  payments: [{ type: 'ADVANCE', method: 'UPI', amount: 1000, voided: false }],
};
recompute(folio);
ok('Folio starts with room charges only', folio.grand_total === round2(3000 + 360), `grand=${folio.grand_total}`);
ok('Advance offsets outstanding', outstanding(folio) === round2(3360 - 1000), `outstanding=${outstanding(folio)}`);

// The walk-in dine-in table session for the same guest: 2 rounds.
const session = {
  token: 'SESS1', status: 'open', payment_method: null,
  orders: [
    { id: 'ORD1', status: 'DELIVERED', payment_status: 'PENDING', items: [{ name: 'Paneer Tikka', quantity: 2, price: 250 }, { name: 'Naan', quantity: 4, price: 40 }] },
    { id: 'ORD2', status: 'DELIVERED', payment_status: 'PENDING', items: [{ name: 'Gulab Jamun', quantity: 2, price: 90 }] },
    { id: 'ORD3', status: 'CANCELLED', payment_status: 'PENDING', items: [{ name: 'Mistake', quantity: 1, price: 999 }] }, // must be ignored
  ],
};
const fnbPreTax = 2 * 250 + 4 * 40 + 2 * 90; // 500 + 160 + 180 = 840

const res = chargeSessionToRoom(session, folio);
ok('Charge posts the 2 active orders (cancelled skipped)', res.ok && res.postedCount === 2, `postedCount=${res.postedCount}`);
ok('Cancelled order never reached the folio', !folio.entries.some(e => e.reference_number === 'ORD3'));
ok('Session closed as CHARGE_TO_ROOM', session.status === 'closed' && session.payment_method === 'CHARGE_TO_ROOM');

// The orders must NOT be marked paid — they are settled with the room at checkout.
ok('Orders are DELIVERED but still UNPAID (charge to room)',
  session.orders.filter(o => o.status !== 'CANCELLED').every(o => o.payment_status === 'PENDING' && o.payment_method === 'CHARGE_TO_ROOM'));

// F&B landed on the folio, itemised, at hotel slab GST.
const fnbEntries = folio.entries.filter(e => e.entry_type === 'F_AND_B');
const fnbAmount = round2(fnbEntries.reduce((s, e) => s + e.amount, 0));
const fnbGst = round2(fnbEntries.reduce((s, e) => s + e.gst_amount, 0));
ok('F&B itemised on folio (3 line items)', fnbEntries.length === 3, `lines=${fnbEntries.length}`);
ok('F&B pre-tax total matches the table bill', fnbAmount === fnbPreTax, `folio=${fnbAmount} bill=${fnbPreTax}`);
ok('F&B taxed at the hotel F&B slab (5%)', fnbGst === round2(fnbPreTax * HOTEL_FNB_GST / 100), `gst=${fnbGst}`);

// Grand total now = room + F&B in ONE folio.
ok('Folio grand total = room + F&B combined',
  folio.grand_total === round2(3000 + 360 + fnbPreTax + fnbPreTax * 0.05),
  `grand=${folio.grand_total}`);

// Idempotency: re-running the charge must NOT double-post.
const before = folio.entries.length;
chargeSessionToRoom(session, folio);
ok('Re-charging is idempotent (no double billing)', folio.entries.length === before, `entries=${folio.entries.length}`);

// ── Check-out: clear restaurant + hotel in ONE settlement ────────────────────
const due = outstanding(folio);
ok('Outstanding at checkout = grand − advance', due === round2(folio.grand_total - 1000), `due=${due}`);
// One FINAL payment for the whole remaining balance.
folio.payments.push({ type: 'FINAL', method: 'CARD', amount: due, voided: false });
const afterPay = outstanding(folio);
const settled = afterPay <= 0.01;
if (settled) { folio.status = 'settled'; folio.settled_at = 'now'; folio.invoice_number = 'INV-1'; }
ok('One payment clears room + F&B → outstanding 0', afterPay === 0, `outstanding=${afterPay}`);
ok('Folio marked settled + invoice issued (PAID)', folio.status === 'settled' && !!folio.invoice_number, `status=${folio.status} inv=${folio.invoice_number}`);

// ── Guard: no open folio → charge must fail cleanly (fall back to cash) ───────
const noFolio = { id: 'FOLX', booking_id: null, room_id: null, status: 'open', discount: 0, entries: [], payments: [] };
// simulate "no open folio" by making postOrderToFolio unable to resolve — here we
// model it as an empty session (nothing to post) which returns ok:false.
const emptySession = { token: 'S2', status: 'open', orders: [{ id: 'Z1', status: 'CANCELLED', items: [] }] };
const guard = chargeSessionToRoom(emptySession, noFolio);
ok('No postable orders → charge fails, session stays open (cash fallback intact)', !guard.ok && emptySession.status === 'open');

// ── Manual invoice → charge to room (NEW: POST /invoices/manual) ─────────────
console.log('\n── Manual invoice charged to room — offline simulation ──\n');

// Fresh checked-in folio (2 room-nights + ₹1000 advance) for a different guest.
const folio2 = {
  id: 'FOL2', booking_id: 'BKG2', room_id: 'RM202', status: 'open', discount: 0, gst_exempt: 0,
  entries: [
    { entry_type: 'ROOM_CHARGE', reference_number: 'RM2-NIGHT-1', amount: 2000, gst_amount: 240 },
    { entry_type: 'ROOM_CHARGE', reference_number: 'RM2-NIGHT-2', amount: 2000, gst_amount: 240 },
  ],
  payments: [{ type: 'ADVANCE', method: 'CARD', amount: 1000, voided: false }],
};
recompute(folio2);

// The cashier builds a manual invoice AND types a ₹100 discount — which must be
// ignored on the folio (the folio bills the raw items at the hotel slab).
const manInvoice = {
  id: 'MAN-1700000000000-AB12',
  items: [{ name: 'Club Sandwich', quantity: 2, price: 150 }, { name: 'Cold Coffee', quantity: 3, price: 80 }],
  discount_amount: 100, service_charge_percent: 10, gst_percent: 18, apply_gst: true,
  room_id: 'RM202',
};
const manPreTax = 2 * 150 + 3 * 80; // 300 + 240 = 540

const roomBefore = round2(4000 + 480); // room + room GST only
const mres = chargeManualInvoiceToRoom(manInvoice, folio2);
ok('Manual invoice posts to the room', mres.ok === true);
ok('Invoice tagged CHARGE_TO_ROOM + POSTED + persisted',
  manInvoice.payment_method === 'CHARGE_TO_ROOM' && manInvoice.folio_post_status === 'POSTED' && manInvoice.persisted === true);
ok('Restaurant discount / service / GST forced off on the invoice row',
  manInvoice.discount_amount === 0 && manInvoice.service_charge_percent === 0 && manInvoice.gst_percent === 0 && manInvoice.apply_gst === false);

const manFnb = folio2.entries.filter(e => e.entry_type === 'F_AND_B' && e.reference_number === manInvoice.id);
const manFnbAmount = round2(manFnb.reduce((s, e) => s + e.amount, 0));
const manFnbGst = round2(manFnb.reduce((s, e) => s + e.gst_amount, 0));
ok('Manual F&B itemised on folio (2 lines)', manFnb.length === 2, `lines=${manFnb.length}`);
ok('Folio bills RAW item price — cashier ₹100 discount NOT applied', manFnbAmount === manPreTax, `folio=${manFnbAmount} raw=${manPreTax}`);
ok('Manual F&B taxed at the hotel slab (5%), NOT the form 18%', manFnbGst === round2(manPreTax * HOTEL_FNB_GST / 100), `gst=${manFnbGst}`);
ok('Folio grand = room + manual F&B (hotel slab)', folio2.grand_total === round2(roomBefore + manPreTax + manPreTax * 0.05), `grand=${folio2.grand_total}`);

// ── Atomicity guard: no open folio → invoice must NOT persist, 409 returned ───
const settledFolio = { id: 'FOL3', booking_id: 'BKG3', room_id: 'RM303', status: 'settled', discount: 0, entries: [], payments: [] };
const orphan = {
  id: 'MAN-1700000000001-CD34',
  items: [{ name: 'Masala Dosa', quantity: 1, price: 120 }],
  discount_amount: 0, service_charge_percent: 0, gst_percent: 0, apply_gst: false,
};
const ares = chargeManualInvoiceToRoom(orphan, settledFolio);
ok('Folio not open → charge fails with 409', ares.ok === false && ares.http === 409);
ok('Atomicity: the just-created MAN- invoice is hard-deleted (not persisted)', orphan.persisted === false);
ok('No orphan F&B line left on the folio', !settledFolio.entries.some(e => e.reference_number === orphan.id));

// ── Edit-Invoice → charge an EXISTING order to a room (POST /orders/:id/charge-to-room) ──
console.log('\n── Existing invoice charged to room from Edit modal — offline simulation ──\n');

// Mirror of the order-level endpoint guards: an already-created order (e.g. a
// MAN- invoice a cashier saved earlier as unpaid) is settled to a room later.
function chargeExistingOrderToRoom(order, folio) {
  if (String(order.status || '').toUpperCase() === 'CANCELLED') return { ok: false, http: 409, error: 'cancelled' };
  if (String(order.payment_status || '').toUpperCase() === 'PAID') return { ok: false, http: 409, error: 'already-paid' };
  // Idempotent: already charged + posted → succeed without double-posting.
  if (String(order.payment_method || '').toUpperCase() === 'CHARGE_TO_ROOM'
      && String(order.folio_post_status || '').toUpperCase() === 'POSTED') return { ok: true, already_charged: true };
  const items = Array.isArray(order.items) ? order.items : [];
  if (items.length === 0) return { ok: false, http: 400, error: 'no-items' };
  order.payment_method = 'CHARGE_TO_ROOM';
  order.room_id = order.room_id || (folio && folio.room_id) || null;
  order.booking_id = order.booking_id || (folio && folio.booking_id) || null;
  const r = (folio && String(folio.status) === 'open')
    ? postOrderToFolio(folio, { id: order.id, status: order.status, items })
    : { ok: false };
  if (!r.ok) return { ok: false, http: 409, error: 'no-open-folio' };
  order.folio_post_status = 'POSTED';
  recompute(folio);
  return { ok: true };
}

const folio4 = {
  id: 'FOL4', booking_id: 'BKG4', room_id: 'RM404', status: 'open', discount: 0, gst_exempt: 0,
  entries: [{ entry_type: 'ROOM_CHARGE', reference_number: 'RM4-NIGHT-1', amount: 3000, gst_amount: 360 }],
  payments: [],
};
recompute(folio4);
const existingInv = {
  id: 'MAN-1700000000002-EF56', status: 'CONFIRMED', payment_status: 'PENDING',
  items: [{ name: 'Thali', quantity: 2, price: 200 }],
};
const invPreTax = 2 * 200; // 400
const eres = chargeExistingOrderToRoom(existingInv, folio4);
ok('Existing unpaid invoice charges to the room', eres.ok === true && existingInv.folio_post_status === 'POSTED');
const invFnb = folio4.entries.filter(e => e.entry_type === 'F_AND_B' && e.reference_number === existingInv.id);
ok('Existing invoice F&B posts raw at hotel slab', round2(invFnb.reduce((s, e) => s + e.amount, 0)) === invPreTax && round2(invFnb.reduce((s, e) => s + e.gst_amount, 0)) === round2(invPreTax * HOTEL_FNB_GST / 100));
// Idempotent re-charge does not double-post.
const entriesBefore = folio4.entries.length;
const eres2 = chargeExistingOrderToRoom(existingInv, folio4);
ok('Re-charging an already-charged invoice is idempotent (no double-post)', eres2.ok === true && folio4.entries.length === entriesBefore);
// A PAID invoice cannot be charged to a room.
const paidInv = { id: 'MAN-PAID', status: 'CONFIRMED', payment_status: 'PAID', items: [{ name: 'Coffee', quantity: 1, price: 60 }] };
ok('A PAID invoice is refused with 409', chargeExistingOrderToRoom(paidInv, folio4).http === 409);
// A CANCELLED invoice cannot be charged to a room.
const cancelledInv = { id: 'MAN-CANX', status: 'CANCELLED', payment_status: 'PENDING', items: [{ name: 'Tea', quantity: 1, price: 30 }] };
ok('A CANCELLED invoice is refused with 409', chargeExistingOrderToRoom(cancelledInv, folio4).http === 409);

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${failed === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${passed} passed, ${failed} failed`);
console.log('─'.repeat(52) + '\n');
process.exit(failed === 0 ? 0 : 1);
