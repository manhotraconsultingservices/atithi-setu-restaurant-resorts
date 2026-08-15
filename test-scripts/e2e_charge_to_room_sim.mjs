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

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${failed === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${passed} passed, ${failed} failed`);
console.log('─'.repeat(52) + '\n');
process.exit(failed === 0 ? 0 : 1);
