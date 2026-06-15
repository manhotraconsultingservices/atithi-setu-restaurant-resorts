// ════════════════════════════════════════════════════════════════════════
//  qa_session_cancelled.mjs — dine-in (QR / E-Menu) cancelled-round billing
//
//  Models the REAL order rows + the server's query/update logic for the three
//  bugs from the 15-Jun testing sheet, and asserts the fixes:
//   • S1/S5 — the CUSTOMER running total + order list must EXCLUDE cancelled
//     rounds (was ₹490 incl. a cancelled Round 1; correct = active only), and
//     must MATCH the invoice (request-bill already excludes cancelled).
//   • S2 — closing/paying a session must mark ONLY non-cancelled orders PAID,
//     and must NOT overwrite a cancelled order's status back to DELIVERED.
// ════════════════════════════════════════════════════════════════════════
const C = { g: '\x1b[32m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' };
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) pass++; else { fail++; console.log(`  ${C.r}✗${C.x} ${label}`); } };

// ── In-memory orders table for one session ──
const SID = 'SESS-1';
let orders = [
  { id: 'O1', session_id: SID, round_number: 1, total_amount: 250, status: 'CANCELLED', payment_status: null },
  { id: 'O2', session_id: SID, round_number: 2, total_amount: 240, status: 'CONFIRMED', payment_status: null },
];

// Canonical cancelled filter used across the server (case-insensitive, null-safe).
const notCancelled = (o) => String(o.status || '').toUpperCase() !== 'CANCELLED';

// Mirror of GET /sessions/:token + POST /sessions (customer view) AFTER the fix:
//   SELECT * FROM orders WHERE session_id=? AND UPPER(COALESCE(status,'')) <> 'CANCELLED'
function customerSessionOrders(sid) {
  return orders.filter(o => o.session_id === sid && notCancelled(o));
}
// Customer running total (App.tsx sessionRunningTotal sums session.orders).
const runningTotal = (sid) => customerSessionOrders(sid).reduce((s, o) => s + Number(o.total_amount || 0), 0);

// Mirror of POST /sessions/:token/request-bill (invoice) — already excludes cancelled.
const invoiceTotal = (sid) =>
  orders.filter(o => o.session_id === sid && notCancelled(o)).reduce((s, o) => s + Number(o.total_amount || 0), 0);

// Mirror of PATCH /sessions/:token/close AFTER the fix:
//   UPDATE orders SET payment_status='PAID', status='DELIVERED'
//   WHERE session_id=? AND UPPER(COALESCE(status,'')) <> 'CANCELLED'
function closeSession(sid) {
  for (const o of orders) {
    if (o.session_id === sid && notCancelled(o)) { o.payment_status = 'PAID'; o.status = 'DELIVERED'; }
  }
}

console.log(`${C.b}\n═══ Dine-in cancelled-round billing (S1/S2/S5) ═══${C.x}`);

// ── S1/S5: customer running total + list exclude the cancelled Round 1 ──
ok(runningTotal(SID) === 240, 'customer running total excludes cancelled Round 1 (₹240, not ₹490)');
ok(customerSessionOrders(SID).length === 1, 'customer order list shows only the active round');
ok(customerSessionOrders(SID).every(o => o.id !== 'O1'), 'cancelled Round 1 never appears in the customer view');

// ── S5: customer view == invoice view (consistency) ──
ok(runningTotal(SID) === invoiceTotal(SID), 'customer total matches the invoice total (₹240 == ₹240)');

// ── S2: closing the session pays only the active order ──
closeSession(SID);
const o1 = orders.find(o => o.id === 'O1');
const o2 = orders.find(o => o.id === 'O2');
ok(o2.payment_status === 'PAID' && o2.status === 'DELIVERED', 'active Round 2 is marked PAID + DELIVERED on close');
ok(o1.payment_status !== 'PAID', 'cancelled Round 1 is NOT marked PAID');
ok(o1.status === 'CANCELLED', 'cancelled Round 1 keeps its CANCELLED status (not un-cancelled to DELIVERED)');

// ── Guard: all-cancelled session → nothing to pay, zero total ──
orders = [
  { id: 'X1', session_id: 'SESS-2', round_number: 1, total_amount: 100, status: 'CANCELLED', payment_status: null },
];
ok(runningTotal('SESS-2') === 0, 'a fully-cancelled session shows ₹0 to the customer');
closeSession('SESS-2');
ok(orders[0].payment_status !== 'PAID', 'closing an all-cancelled session marks nothing PAID');

console.log(`${C.b}\n═══════════════════════════════════════════════════════════════${C.x}`);
console.log(`  ${C.g}✓ Passed:${C.x} ${pass}`);
console.log(`  ${fail ? C.r : C.g}✗ Failed:${C.x} ${fail}`);
console.log(`${C.b}═══════════════════════════════════════════════════════════════${C.x}`);
process.exit(fail > 0 ? 1 : 0);
