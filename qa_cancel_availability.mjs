// ════════════════════════════════════════════════════════════════════════
//  qa_cancel_availability.mjs — cancel-frees-room + no-overbooking audit
//
//  Mirrors the EXACT server.ts logic (no live DB needed):
//    • Overlap guard (validateBookingRequest): a candidate (room, ci, co)
//      conflicts with any booking on the SAME room whose status is NOT IN
//      ('CANCELLED','CHECKED_OUT') and whose [check_in, check_out) interval
//      overlaps — half-open: existing.check_in < candidate.co AND
//      existing.check_out > candidate.ci. DAY_USE adds a same-date clause.
//    • Cancel: sets status='CANCELLED' (single + group paths).
//    • find-available-rooms: a room is bookable when it fits capacity, isn't
//      MAINTENANCE/BLOCKED, and has no active booking/hold conflict.
//
//  Asserts: booking blocks the room; cancel frees it; checkout frees it;
//  overbooking is rejected; a fully-booked category offers 0 rooms and
//  reopens one after a cancel; back-to-back (checkout==checkin) is allowed.
// ════════════════════════════════════════════════════════════════════════

const C = { g: '\x1b[32m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m', gray: '\x1b[90m' };
let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; }
  else { fail++; console.log(`  ${C.r}✗${C.x} ${label}`); }
};

// ── Mirror of the overlap guard (server.ts validateBookingRequest) ──
const ACTIVE = (s) => s !== 'CANCELLED' && s !== 'CHECKED_OUT';
function hasConflict(bookings, cand) {
  const overnight = bookings.some(b =>
    b.room_id === cand.room_id && ACTIVE(b.status) && b.id !== cand.excludeId &&
    b.check_in_date < cand.check_out_date && b.check_out_date > cand.check_in_date
  );
  if (overnight) return true;
  // DAY_USE same-date collision (check_in == check_out won't trip the < / > rule).
  if (cand.booking_type === 'DAY_USE') {
    return bookings.some(b =>
      b.room_id === cand.room_id && ACTIVE(b.status) && b.id !== cand.excludeId &&
      b.booking_type === 'DAY_USE' && b.check_in_date === cand.check_in_date
    );
  }
  return false;
}
// validateBookingRequest → ok:false (409) when a conflict exists.
const canBook = (bookings, cand) => !hasConflict(bookings, cand);

// ── Mirror of find-available-rooms availability ──
function availableRooms(rooms, bookings, start, end, guests = 1) {
  return rooms.filter(r => {
    const fits = Number(r.capacity || 2) >= guests;
    const blocked = r.status === 'MAINTENANCE' || r.status === 'BLOCKED';
    const conflict = hasConflict(bookings, { room_id: r.id, check_in_date: start, check_out_date: end, booking_type: 'OVERNIGHT' });
    return fits && !blocked && !conflict;
  });
}

// ── Fixtures ──
const rooms = [
  { id: 'R1', capacity: 2, status: 'VACANT' },
  { id: 'R2', capacity: 2, status: 'VACANT' },
  { id: 'R3', capacity: 2, status: 'MAINTENANCE' }, // never bookable
];
let seq = 0;
const mk = (room_id, ci, co, status = 'BOOKED', booking_type = 'OVERNIGHT') =>
  ({ id: `BK-${++seq}`, room_id, check_in_date: ci, check_out_date: co, status, booking_type });

console.log(`${C.b}\n═══ Cancel frees room + no-overbooking ═══${C.x}`);

// 1) Book R1 Jun10–12 → R1 no longer available for an overlapping window.
let bookings = [mk('R1', '2026-06-10', '2026-06-12')];
ok(!availableRooms(rooms, bookings, '2026-06-11', '2026-06-13').some(r => r.id === 'R1'),
   'booked room is NOT available for overlapping dates');

// 2) Overbooking blocked — a 2nd overlapping booking on R1 is rejected (409).
ok(canBook(bookings, { room_id: 'R1', check_in_date: '2026-06-11', check_out_date: '2026-06-13', booking_type: 'OVERNIGHT' }) === false,
   'overlapping 2nd booking on the same room is rejected');

// 3) Cancel the booking → R1 is available again (added back to inventory).
bookings[0].status = 'CANCELLED';
ok(availableRooms(rooms, bookings, '2026-06-11', '2026-06-13').some(r => r.id === 'R1'),
   'CANCELLED booking frees the room (available again)');
ok(canBook(bookings, { room_id: 'R1', check_in_date: '2026-06-11', check_out_date: '2026-06-13', booking_type: 'OVERNIGHT' }) === true,
   'after cancel, a new overlapping booking is allowed');

// 4) CHECKED_OUT also frees the room.
bookings = [mk('R1', '2026-06-10', '2026-06-12', 'CHECKED_OUT')];
ok(canBook(bookings, { room_id: 'R1', check_in_date: '2026-06-10', check_out_date: '2026-06-12', booking_type: 'OVERNIGHT' }) === true,
   'CHECKED_OUT booking does not block the room');

// 5) Back-to-back (checkout day == next check-in day) is allowed.
bookings = [mk('R1', '2026-06-10', '2026-06-12')];
ok(canBook(bookings, { room_id: 'R1', check_in_date: '2026-06-12', check_out_date: '2026-06-14', booking_type: 'OVERNIGHT' }) === true,
   'back-to-back booking (checkout==checkin) is allowed');

// 6) Fully-booked category → 0 rooms; cancel one → 1 reopens.
//    R1 + R2 are the bookable 2-cap rooms (R3 is MAINTENANCE).
bookings = [mk('R1', '2026-06-20', '2026-06-22'), mk('R2', '2026-06-20', '2026-06-22')];
ok(availableRooms(rooms, bookings, '2026-06-20', '2026-06-22').length === 0,
   'fully-booked window offers 0 available rooms');
ok(canBook(bookings, { room_id: 'R1', check_in_date: '2026-06-20', check_out_date: '2026-06-22', booking_type: 'OVERNIGHT' }) === false &&
   canBook(bookings, { room_id: 'R2', check_in_date: '2026-06-20', check_out_date: '2026-06-22', booking_type: 'OVERNIGHT' }) === false,
   'fully booked → neither room can be booked again');
bookings.find(b => b.room_id === 'R2').status = 'CANCELLED';
const reopened = availableRooms(rooms, bookings, '2026-06-20', '2026-06-22');
ok(reopened.length === 1 && reopened[0].id === 'R2',
   'cancelling one of a fully-booked set reopens exactly that room');

// 7) DAY_USE same-date collision rejected; different date allowed.
bookings = [mk('R1', '2026-07-01', '2026-07-01', 'BOOKED', 'DAY_USE')];
ok(canBook(bookings, { room_id: 'R1', check_in_date: '2026-07-01', check_out_date: '2026-07-01', booking_type: 'DAY_USE' }) === false,
   'DAY_USE same-date double-booking rejected');
ok(canBook(bookings, { room_id: 'R1', check_in_date: '2026-07-02', check_out_date: '2026-07-02', booking_type: 'DAY_USE' }) === true,
   'DAY_USE on a different date allowed');
bookings[0].status = 'CANCELLED';
ok(canBook(bookings, { room_id: 'R1', check_in_date: '2026-07-01', check_out_date: '2026-07-01', booking_type: 'DAY_USE' }) === true,
   'cancelled DAY_USE frees that date');

console.log(`${C.b}\n═══════════════════════════════════════════════════════════════${C.x}`);
console.log(`  ${C.g}✓ Passed:${C.x} ${pass}`);
console.log(`  ${fail ? C.r : C.g}✗ Failed:${C.x} ${fail}`);
console.log(`${C.b}═══════════════════════════════════════════════════════════════${C.x}`);
process.exit(fail > 0 ? 1 : 0);
