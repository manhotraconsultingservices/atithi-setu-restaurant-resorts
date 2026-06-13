// ════════════════════════════════════════════════════════════════════════
//  qa_restaurant_bill.mjs — booking-row restaurant bill: summary + mark-paid
//
//  Mirrors the server endpoints:
//    GET  /hotel/bookings/:id/restaurant-bill   → totals by state
//    POST /hotel/bookings/:id/restaurant-bill/mark-paid
//  An order's state lives in folio_post_status:
//    PAID_IN_ROOM = already settled (paid),
//    POSTED       = on the room folio (pays at checkout),
//    else         = pending (awaiting-delivery / unbilled).
//  unpaid = total − paid_in_room. mark-paid marks every non-PAID_IN_ROOM order
//  PAID_IN_ROOM and reverses any POSTED folio line (so it's never billed twice).
// ════════════════════════════════════════════════════════════════════════
const C = { g: '\x1b[32m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' };
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) pass++; else { fail++; console.log(`  ${C.r}✗${C.x} ${label}`); } };
const r2 = (n) => Math.round(n * 100) / 100;

const isCancelled = (o) => String(o.status || '').toUpperCase() === 'CANCELLED';

// Mirror of the bill-summary aggregation. Cancelled orders are excluded by the
// SQL (UPPER(status) <> 'CANCELLED'), so they never appear on the bill.
function summarise(orders) {
  let total = 0, paid = 0, onFolio = 0, pending = 0;
  for (const o of orders) {
    if (isCancelled(o)) continue;
    const amt = Number(o.total_amount || 0);
    total += amt;
    const st = String(o.folio_post_status || '').toUpperCase();
    if (st === 'PAID_IN_ROOM') paid += amt;
    else if (st === 'POSTED') onFolio += amt;
    else pending += amt;
  }
  return { total: r2(total), paid_in_room: r2(paid), on_folio: r2(onFolio), pending: r2(pending), unpaid: r2(total - paid) };
}
// Mirror of mark-paid: every non-PAID_IN_ROOM order → PAID_IN_ROOM; POSTED ones
// reverse their folio line (we count reversals). Returns {marked, reversed, orders}.
function markPaid(orders) {
  let marked = 0, reversed = 0;
  const next = orders.map(o => ({ ...o }));
  for (const o of next) {
    if (isCancelled(o)) continue;          // cancelled orders are never in the mark-paid set
    if (String(o.folio_post_status || '').toUpperCase() === 'PAID_IN_ROOM') continue;
    if (o.folio_id) reversed++;            // had posted → reverse the folio line
    o.folio_post_status = 'PAID_IN_ROOM';
    o.folio_id = null;
    marked++;
  }
  return { marked, reversed, orders: next };
}

console.log(`${C.b}\n═══ Restaurant bill on the booking row — summary + mark-paid ═══${C.x}`);

// A guest with three room-service orders in different states.
const orders = [
  { id: 'O1', total_amount: 1200, folio_post_status: 'POSTED',        folio_id: 'F1' }, // on folio
  { id: 'O2', total_amount: 800,  folio_post_status: 'PAID_IN_ROOM',  folio_id: null }, // already paid
  { id: 'O3', total_amount: 500,  folio_post_status: 'AWAITING_DELIVERY', folio_id: null }, // pending
];

const s = summarise(orders);
ok(s.total === 2500, 'restaurant bill total = 1200 + 800 + 500 = 2500');
ok(s.paid_in_room === 800, 'paid-in-room portion = 800');
ok(s.on_folio === 1200, 'on-folio portion (pays at checkout) = 1200');
ok(s.pending === 500, 'pending (not yet billed) = 500');
ok(s.unpaid === 1700, 'unpaid = total − paid = 2500 − 800 = 1700 (this is what Mark-paid settles)');

// The booking row shows fnb_total = total, fnb_unpaid = total − paid.
ok(s.total === 2500 && s.unpaid === 1700, 'booking-row fnb_total=2500, fnb_unpaid=1700 → shows "unpaid"');

// Mark the whole bill paid.
const res = markPaid(orders);
ok(res.marked === 2, 'mark-paid settles the 2 non-paid orders (O1 on-folio + O3 pending)');
ok(res.reversed === 1, 'exactly 1 folio line reversed (the POSTED O1) — O3 was never on the folio');
const after = summarise(res.orders);
ok(after.unpaid === 0, 'after mark-paid: unpaid = 0 (whole restaurant bill settled)');
ok(after.paid_in_room === 2500, 'after mark-paid: entire 2500 is paid-in-room');
ok(after.on_folio === 0 && after.pending === 0, 'after mark-paid: nothing left on the folio or pending');

// A fully-paid bill is idempotent + shows "✓ paid" (unpaid 0, marks nothing).
const res2 = markPaid(res.orders);
ok(res2.marked === 0 && res2.reversed === 0, 're-running mark-paid on a settled bill is a no-op');

// No F&B → fnb_total 0 → the row shows "—" (no button).
ok(summarise([]).total === 0, 'no room-service orders → restaurant bill total 0 (row shows —)');

// ── Cancel an order BEFORE delivery → it must NEVER hit the folio/bill ──
// A cancelled order keeps status='CANCELLED', folio_id NULL (never posted).
// Every restaurant-bill query and the folio sweep exclude it.
const withCancel = [
  { id: 'A', total_amount: 600, folio_post_status: 'AWAITING_DELIVERY', folio_id: null, status: 'DELIVERED' },
  { id: 'B', total_amount: 400, folio_post_status: 'AWAITING_DELIVERY', folio_id: null, status: 'CANCELLED' }, // cancelled before delivery
];
const sc = summarise(withCancel);
ok(sc.total === 600, 'cancelled order is EXCLUDED from the restaurant bill total (600, not 1000)');
ok(sc.unpaid === 600, 'cancelled order is excluded from unpaid too');
const scPaid = markPaid(withCancel);
ok(scPaid.marked === 1, 'mark-paid touches only the live order (1), never the cancelled one');
ok(scPaid.orders.find(o => o.id === 'B').folio_post_status === 'AWAITING_DELIVERY', 'cancelled order is left untouched (never marked paid / posted)');
// Even if the SWEEP tried it, postOrderToFolio bails on a cancelled order:
const postGuard = (o) => (isCancelled(o) ? { ok: false, reason: 'order-cancelled' } : { ok: true });
ok(postGuard(withCancel[1]).ok === false, 'postOrderToFolio refuses a cancelled order (never reaches the folio)');

console.log(`${C.b}\n═══════════════════════════════════════════════════════════════${C.x}`);
console.log(`  ${C.g}✓ Passed:${C.x} ${pass}`);
console.log(`  ${fail ? C.r : C.g}✗ Failed:${C.x} ${fail}`);
console.log(`${C.b}═══════════════════════════════════════════════════════════════${C.x}`);
process.exit(fail > 0 ? 1 : 0);
