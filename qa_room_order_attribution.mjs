// ════════════════════════════════════════════════════════════════════════
//  qa_room_order_attribution.mjs — a CHARGE_TO_ROOM order is billed to a guest
//  ONLY if it belongs to their stay (20 Jun 2026 critical fix). Mirrors the
//  server's orderBelongsToStay(): a previous occupant's / pre-arrival order on
//  the same physical room must NEVER appear on the new guest's folio.
// ════════════════════════════════════════════════════════════════════════
const C = { g: '\x1b[32m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' };
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log(`  ${C.r}✗${C.x} ${label}`); } };

// Mirror of server.ts orderBelongsToStay.
function orderBelongsToStay(o, b) {
  const bid = String(b?.id ?? '');
  if (o?.booking_id && String(o.booking_id) === bid) return true;
  if (o?.booking_id) return false;                 // tagged to a different booking
  const ciRaw = b?.actual_checkin_at || b?.check_in_date;
  if (!ciRaw) return false;
  const t  = new Date(o?.created_at).getTime();
  const lo = new Date(ciRaw).getTime();
  if (!Number.isFinite(t) || !Number.isFinite(lo)) return false;
  const hi = b?.check_out_date ? new Date(b.check_out_date).getTime() + 86400000 : Infinity;
  return t >= lo && t < hi;
}

// The reported booking: Popoat Singh, Room 302, checked in 16 Jun 10:54pm,
// dates 16→17 Jun.
const booking = {
  id: 'BK-CURRENT', room_id: 'R-302',
  actual_checkin_at: '2026-06-16T22:54:00Z',
  check_in_date: '2026-06-16', check_out_date: '2026-06-17',
};

console.log(`${C.b}\n═══ Room-order attribution (stay-window guard) ═══${C.x}`);

// 1. The reported bug: a stray order on Room 302 from 13 Jun (no booking_id) is
//    NOT this guest's — 3 days before check-in.
ok(orderBelongsToStay({ booking_id: null, room_id: 'R-302', created_at: '2026-06-13T17:25:00Z' }, booking) === false,
  'pre-arrival untagged room order (13 Jun) is NOT billed to a 16 Jun check-in (the reported bug)');

// 2. An untagged room-service order placed DURING the stay IS this guest's.
ok(orderBelongsToStay({ booking_id: null, room_id: 'R-302', created_at: '2026-06-16T23:30:00Z' }, booking) === true,
  'untagged room order during the stay is billed to this guest');

// 3. An order explicitly tagged to THIS booking always belongs to it.
ok(orderBelongsToStay({ booking_id: 'BK-CURRENT', room_id: 'R-302', created_at: '2026-06-16T23:30:00Z' }, booking) === true,
  'order tagged to this booking is billed to this guest');

// 4. An order tagged to ANOTHER booking is never billed here (even same room).
ok(orderBelongsToStay({ booking_id: 'BK-OTHER', room_id: 'R-302', created_at: '2026-06-16T23:30:00Z' }, booking) === false,
  'order tagged to a different booking is never billed to this guest');

// 5. An untagged order before the check-IN TIME on the arrival day (room set up
//    earlier that evening) is excluded — guest was not yet checked in.
ok(orderBelongsToStay({ booking_id: null, room_id: 'R-302', created_at: '2026-06-16T18:00:00Z' }, booking) === false,
  'untagged order before the actual check-in time is excluded');

// 6. An untagged order after the checkout day is excluded.
ok(orderBelongsToStay({ booking_id: null, room_id: 'R-302', created_at: '2026-06-19T09:00:00Z' }, booking) === false,
  'untagged order after the stay window is excluded');

// 7. Falls back to check_in_date when actual_checkin_at is absent (legacy rows).
const legacy = { id: 'BK-L', room_id: 'R-302', check_in_date: '2026-06-16', check_out_date: '2026-06-17' };
ok(orderBelongsToStay({ booking_id: null, room_id: 'R-302', created_at: '2026-06-13T10:00:00Z' }, legacy) === false,
  'legacy booking (no actual_checkin_at) still excludes a pre-stay order via check_in_date');
ok(orderBelongsToStay({ booking_id: null, room_id: 'R-302', created_at: '2026-06-16T12:00:00Z' }, legacy) === true,
  'legacy booking includes an in-stay order');

console.log(`${C.b}\n═══════════════════════════════════════════════════════════════${C.x}`);
console.log(`  ${C.g}✓ Passed:${C.x} ${pass}`);
console.log(`  ${fail ? C.r : C.g}✗ Failed:${C.x} ${fail}`);
console.log(`${C.b}═══════════════════════════════════════════════════════════════${C.x}`);
process.exit(fail > 0 ? 1 : 0);
