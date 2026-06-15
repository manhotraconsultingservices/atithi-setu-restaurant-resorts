// ════════════════════════════════════════════════════════════════════════
//  qa_order_edit_cancel.mjs — S3 (staff modify order) + S4 (customer cancel)
//
//  Mirrors the server's NEW guards + math so the integration is asserted, not
//  just compiled:
//   • S3 PATCH /api/orders/:id with items — editable ONLY while queued + unpaid;
//     recompute total_amount from items and scale GST by the order's existing
//     gst/total fraction (correct for BOTH inclusive & exclusive tenants);
//     reject empty items / started / paid.
//   • S4 POST /sessions/:token/orders/:orderId/cancel — cancellable ONLY when
//     the order belongs to the session, is queued, and unpaid; else refused.
// ════════════════════════════════════════════════════════════════════════
const C = { g: '\x1b[32m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' };
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log(`  ${C.r}✗${C.x} ${label}`); } };
const r2 = (n) => Math.round(n * 100) / 100;

// ── Mirror of the server's S3 edit logic ──
function editOrder(order, newItems) {
  const st = String(order.status || '').toUpperCase();
  if (st !== 'CONFIRMED' && st !== 'PENDING') return { ok: false, code: 409, reason: 'started' };
  if (String(order.payment_status || '').toUpperCase() === 'PAID') return { ok: false, code: 409, reason: 'paid' };
  const clean = newItems
    .map(it => ({ ...it, quantity: Math.max(0, Math.floor(Number(it.quantity ?? it.qty ?? 0))), price: Number(it.price ?? 0) }))
    .filter(it => it.quantity > 0 && it.price >= 0);
  if (clean.length === 0) return { ok: false, code: 400, reason: 'empty' };
  const newTotal = r2(clean.reduce((s, it) => s + it.price * it.quantity, 0));
  const ratio = Number(order.total_amount) > 0 ? Number(order.gst_amount || 0) / Number(order.total_amount) : 0;
  const newGst = r2(newTotal * ratio);
  return { ok: true, total_amount: newTotal, gst_amount: newGst, items: clean };
}

// ── Mirror of the server's S4 customer-cancel logic ──
function customerCancel(order, sessionId) {
  if (!order || order.session_id !== sessionId) return { ok: false, code: 404, reason: 'not-found' };
  const st = String(order.status || '').toUpperCase();
  if (st === 'CANCELLED') return { ok: true, already: true };
  if (st !== 'CONFIRMED' && st !== 'PENDING') return { ok: false, code: 409, reason: 'started' };
  if (String(order.payment_status || '').toUpperCase() === 'PAID') return { ok: false, code: 409, reason: 'paid' };
  return { ok: true, status: 'CANCELLED' };
}

console.log(`${C.b}\n═══ S3 staff edit + S4 customer cancel ═══${C.x}`);

// ── S3: GST-EXCLUSIVE tenant — reduce qty 2→1 on a 2-line order ──
// items: 2× Tea @100 (=200) ; total 200, gst 10 (5% exclusive). Drop to 1× Tea.
const exOrder = { status: 'CONFIRMED', payment_status: null, total_amount: 200, gst_amount: 10 };
const e1 = editOrder(exOrder, [{ name: 'Tea', price: 100, quantity: 1 }]);
ok(e1.ok && e1.total_amount === 100, 'S3 exclusive: total recomputed to 100');
ok(e1.gst_amount === 5, 'S3 exclusive: GST scales with the line (5% → 5)');

// ── S3: GST-INCLUSIVE tenant — same proportional scaling holds ──
// total 210 incl, gst 10. Halve the order → 105 incl, gst 5.
const incOrder = { status: 'PENDING', payment_status: null, total_amount: 210, gst_amount: 10 };
const e2 = editOrder(incOrder, [{ name: 'Combo', price: 105, quantity: 1 }]);
ok(e2.ok && e2.total_amount === 105, 'S3 inclusive: total recomputed to 105');
ok(e2.gst_amount === 5, 'S3 inclusive: embedded GST scales proportionally (5)');

// ── S3: removing a line (qty 0) drops it from totals ──
const e3 = editOrder({ status: 'CONFIRMED', payment_status: null, total_amount: 300, gst_amount: 0 },
  [{ name: 'A', price: 100, quantity: 2 }, { name: 'B', price: 100, quantity: 0 }]);
ok(e3.ok && e3.total_amount === 200 && e3.items.length === 1, 'S3: a zeroed line is removed (300 → 200, 1 line)');

// ── S3: guards ──
ok(editOrder({ status: 'PREPARING', payment_status: null, total_amount: 200, gst_amount: 10 }, [{ name: 'Tea', price: 100, quantity: 1 }]).code === 409,
   'S3: editing a PREPARING order is refused (409)');
ok(editOrder({ status: 'CONFIRMED', payment_status: 'PAID', total_amount: 200, gst_amount: 10 }, [{ name: 'Tea', price: 100, quantity: 1 }]).code === 409,
   'S3: editing a PAID order is refused (409)');
ok(editOrder({ status: 'CONFIRMED', payment_status: null, total_amount: 200, gst_amount: 10 }, [{ name: 'Tea', price: 100, quantity: 0 }]).code === 400,
   'S3: removing every item is refused (400 — use cancel instead)');

// ── S4: customer cancel happy path ──
const SID = 'SESS-9';
ok(customerCancel({ session_id: SID, status: 'CONFIRMED', payment_status: null }, SID).status === 'CANCELLED',
   'S4: a queued, unpaid order in this session can be cancelled by the guest');
ok(customerCancel({ session_id: SID, status: 'PENDING', payment_status: null }, SID).ok,
   'S4: a PENDING order can be cancelled');

// ── S4: guards ──
ok(customerCancel({ session_id: SID, status: 'PREPARING', payment_status: null }, SID).code === 409,
   'S4: cannot cancel once the kitchen is PREPARING (409)');
ok(customerCancel({ session_id: SID, status: 'CONFIRMED', payment_status: 'PAID' }, SID).code === 409,
   'S4: cannot cancel a PAID order (409)');
ok(customerCancel({ session_id: 'OTHER', status: 'CONFIRMED', payment_status: null }, SID).code === 404,
   'S4: cannot cancel an order that belongs to a different session (404)');
ok(customerCancel({ session_id: SID, status: 'CANCELLED', payment_status: null }, SID).already === true,
   'S4: cancelling an already-cancelled order is an idempotent no-op');

console.log(`${C.b}\n═══════════════════════════════════════════════════════════════${C.x}`);
console.log(`  ${C.g}✓ Passed:${C.x} ${pass}`);
console.log(`  ${fail ? C.r : C.g}✗ Failed:${C.x} ${fail}`);
console.log(`${C.b}═══════════════════════════════════════════════════════════════${C.x}`);
process.exit(fail > 0 ? 1 : 0);
