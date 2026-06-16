// ════════════════════════════════════════════════════════════════════════
//  qa_reassign_lock.mjs — Phase 2: reassign a floating booking + lock-on-checkin
//  Mirrors the server's POST /hotel/bookings/:id/reassign-room guards and the
//  check-in lock so the rules are asserted directly.
// ════════════════════════════════════════════════════════════════════════
const C = { g: '\x1b[32m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' };
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log(`  ${C.r}✗${C.x} ${label}`); } };

// Mirror of reassign-room: only while BOOKED; target must exist, not be
// maintenance/blocked, and be free for the dates (overlap excludes self);
// floating stays floating unless lock=true.
function reassign(booking, target, { takenByOthers = new Set(), lock = false } = {}) {
  if (String(booking.status).toUpperCase() !== 'BOOKED') return { code: 409, reason: 'not-bookable' };
  if (!target) return { code: 400 };
  if (booking.room_id === target.id) {
    const room_locked = lock ? 1 : booking.room_locked;
    return { ok: true, room_id: target.id, room_locked, unchanged: true };
  }
  const st = String(target.status || '').toUpperCase();
  if (st === 'MAINTENANCE' || st === 'BLOCKED') return { code: 409, reason: 'room-unavailable' };
  if (takenByOthers.has(target.id)) return { code: 409, reason: 'overlap' };
  return { ok: true, room_id: target.id, room_locked: lock ? 1 : booking.room_locked };
}
// Mirror of check-in: flips to CHECKED_IN AND locks the room.
function checkIn(booking) {
  if (String(booking.status).toUpperCase() !== 'BOOKED') return { ...booking };
  return { ...booking, status: 'CHECKED_IN', room_locked: 1 };
}

console.log(`${C.b}\n═══ Phase 2 — reassign + lock-on-check-in ═══${C.x}`);

const floating = { id: 'BK1', status: 'BOOKED', room_id: 'R-1', room_locked: 0 };
const R3 = { id: 'R-3', status: 'VACANT' };
const R4 = { id: 'R-4', status: 'VACANT' };
const Rmaint = { id: 'R-9', status: 'MAINTENANCE' };

// 1. Reassign a floating booking to a free room → moves, stays floating.
const a = reassign(floating, R3);
ok(a.ok && a.room_id === 'R-3' && a.room_locked === 0, 'floating booking reassigns to a free room and stays floating');

// 2. Reassign with lock=true → moves and locks.
const b2 = reassign(floating, R4, { lock: true });
ok(b2.ok && b2.room_id === 'R-4' && b2.room_locked === 1, 'reassign with lock=true pins the room (room_locked=1)');

// 3. Target room occupied for the dates (overlap, excluding self) → 409.
ok(reassign(floating, R3, { takenByOthers: new Set(['R-3']) }).code === 409, 'reassign to a room taken for the dates → 409');

// 4. Maintenance target → 409.
ok(reassign(floating, Rmaint).code === 409, 'reassign to a maintenance room → 409');

// 5. Cannot reassign a checked-in booking.
ok(reassign({ id: 'BK2', status: 'CHECKED_IN', room_id: 'R-1', room_locked: 1 }, R3).code === 409, 'cannot reassign a CHECKED_IN booking (409)');

// 6. Lock-on-check-in: a floating booking becomes locked when checked in.
const ci = checkIn(floating);
ok(ci.status === 'CHECKED_IN' && ci.room_locked === 1, 'check-in flips to CHECKED_IN and locks the room (room_locked=1)');

// 7. Same-room "reassign" with lock just toggles the lock (no move).
const s = reassign(floating, { id: 'R-1', status: 'VACANT' }, { lock: true });
ok(s.ok && s.unchanged && s.room_locked === 1, 'same-room reassign with lock just pins it (no move)');

console.log(`${C.b}\n═══════════════════════════════════════════════════════════════${C.x}`);
console.log(`  ${C.g}✓ Passed:${C.x} ${pass}`);
console.log(`  ${fail ? C.r : C.g}✗ Failed:${C.x} ${fail}`);
console.log(`${C.b}═══════════════════════════════════════════════════════════════${C.x}`);
process.exit(fail > 0 ? 1 : 0);
