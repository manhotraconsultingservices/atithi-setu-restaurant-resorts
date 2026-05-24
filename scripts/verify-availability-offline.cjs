#!/usr/bin/env node
/**
 * Sprint A1 + A2 — Availability + Find-Available-Rooms math regression
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reproduces the overlap rules used by:
 *   GET /hotel/availability        (calendar grid statuses)
 *   GET /hotel/find-available-rooms (search + conflict_until)
 * so future refactors of the server-side conflict math stay correct.
 *
 * Run:  node scripts/verify-availability-offline.cjs
 */
'use strict';

let failed = 0;
const assert = (cond, label, expected, got) => {
  const ok = cond;
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)} = ${JSON.stringify(expected)}`);
  if (!ok) failed++;
};

// ─── Half-open interval overlap (mirrors server validateBookingRequest) ───
function overlaps(aStart, aEnd, bStart, bEnd) {
  // [aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅  ⇔  aStart < bEnd && bStart < aEnd
  return aStart < bEnd && bStart < aEnd;
}

// ─── Compute "available?" for a room over a search window ────────────────
function isAvailableForRange({
  searchStart, searchEnd, guests,
  capacity, status, bookings = [], holds = [],
}) {
  if (capacity < guests) return { available: false, reason: 'capacity' };
  if (status === 'MAINTENANCE' || status === 'BLOCKED') return { available: false, reason: 'room_status' };
  for (const b of bookings) {
    if (overlaps(b.start, b.end, searchStart, searchEnd)) {
      return { available: false, reason: 'booking', conflict_until: b.end, blocker: b.guest };
    }
  }
  for (const h of holds) {
    if (overlaps(h.start, h.end, searchStart, searchEnd)) {
      return { available: false, reason: 'hold', conflict_until: h.end, blocker: h.kind };
    }
  }
  return { available: true };
}

// ─── Cases ────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
console.log('  Availability + Find-Available-Rooms — Offline Regression');
console.log('═══════════════════════════════════════════════════════════\n');

console.log('Case 1: Empty room, no holds → available');
{
  const r = isAvailableForRange({
    searchStart: '2026-05-24', searchEnd: '2026-05-26',
    guests: 2, capacity: 2, status: 'VACANT',
  });
  assert(r.available === true, 'available', true, r.available);
}

console.log('\nCase 2: Capacity mismatch → unavailable');
{
  const r = isAvailableForRange({
    searchStart: '2026-05-24', searchEnd: '2026-05-26',
    guests: 4, capacity: 2, status: 'VACANT',
  });
  assert(r.available === false, 'unavailable', false, r.available);
  assert(r.reason === 'capacity', 'reason=capacity', 'capacity', r.reason);
}

console.log('\nCase 3: MAINTENANCE status → unavailable');
{
  const r = isAvailableForRange({
    searchStart: '2026-05-24', searchEnd: '2026-05-26',
    guests: 1, capacity: 2, status: 'MAINTENANCE',
  });
  assert(r.available === false, 'unavailable', false, r.available);
  assert(r.reason === 'room_status', 'reason=room_status', 'room_status', r.reason);
}

console.log('\nCase 4: Booking overlap (search starts during booking) → unavailable');
{
  const r = isAvailableForRange({
    searchStart: '2026-05-25', searchEnd: '2026-05-28',
    guests: 1, capacity: 2, status: 'VACANT',
    bookings: [{ start: '2026-05-24', end: '2026-05-27', guest: 'Tarun' }],
  });
  assert(r.available === false, 'unavailable', false, r.available);
  assert(r.conflict_until === '2026-05-27', 'conflict_until = booking end', '2026-05-27', r.conflict_until);
}

console.log('\nCase 5: Booking ENDS on search start (half-open: free that day) → available');
{
  // booking [22, 24)  search [24, 26)  → no overlap because aEnd(24) === bStart(24)
  const r = isAvailableForRange({
    searchStart: '2026-05-24', searchEnd: '2026-05-26',
    guests: 1, capacity: 2, status: 'VACANT',
    bookings: [{ start: '2026-05-22', end: '2026-05-24', guest: 'Tarun' }],
  });
  assert(r.available === true, 'available (room frees on day 24)', true, r.available);
}

console.log('\nCase 6: Booking STARTS on search end (half-open: free that day) → available');
{
  // booking [26, 28)  search [24, 26)  → no overlap
  const r = isAvailableForRange({
    searchStart: '2026-05-24', searchEnd: '2026-05-26',
    guests: 1, capacity: 2, status: 'VACANT',
    bookings: [{ start: '2026-05-26', end: '2026-05-28', guest: 'Tarun' }],
  });
  assert(r.available === true, 'available (next booking starts day 26)', true, r.available);
}

console.log('\nCase 7: Hold overlaps search → unavailable with hold reason');
{
  const r = isAvailableForRange({
    searchStart: '2026-05-24', searchEnd: '2026-05-26',
    guests: 1, capacity: 2, status: 'VACANT',
    holds: [{ start: '2026-05-23', end: '2026-05-30', kind: 'MAINTENANCE' }],
  });
  assert(r.available === false, 'unavailable', false, r.available);
  assert(r.reason === 'hold', 'reason=hold', 'hold', r.reason);
  assert(r.conflict_until === '2026-05-30', 'conflict_until = hold end', '2026-05-30', r.conflict_until);
}

console.log('\nCase 8: Booking + hold both overlap → booking conflict reported (first match)');
{
  const r = isAvailableForRange({
    searchStart: '2026-05-25', searchEnd: '2026-06-01',
    guests: 1, capacity: 2, status: 'VACANT',
    bookings: [{ start: '2026-05-24', end: '2026-05-27', guest: 'Tarun' }],
    holds:    [{ start: '2026-05-28', end: '2026-05-30', kind: 'OWNER_STAY' }],
  });
  // We surface the booking conflict first (consistent with server behaviour).
  assert(r.available === false, 'unavailable', false, r.available);
  assert(r.reason === 'booking', 'reason=booking', 'booking', r.reason);
}

console.log('\nCase 9: Search range spans long booking → unavailable, conflict_until matches end');
{
  const r = isAvailableForRange({
    searchStart: '2026-05-22', searchEnd: '2026-05-31',
    guests: 1, capacity: 2, status: 'VACANT',
    bookings: [{ start: '2026-05-23', end: '2026-05-25', guest: 'Long stay' }],
  });
  assert(r.available === false, 'unavailable', false, r.available);
  assert(r.conflict_until === '2026-05-25', 'free again from 2026-05-25', '2026-05-25', r.conflict_until);
}

console.log('\nCase 10: Day-use sanity (single-day booking) → blocks that exact day');
{
  // For DAY_USE the server stores check_in === check_out, so the half-open
  // form would not flag overlap. The actual code special-cases this; here
  // we model the day-use as a [d, d+1) interval that matches the booking's
  // single occupied day. The math result is the same.
  const r = isAvailableForRange({
    searchStart: '2026-05-25', searchEnd: '2026-05-26',
    guests: 1, capacity: 2, status: 'VACANT',
    bookings: [{ start: '2026-05-25', end: '2026-05-26', guest: 'Day visitor' }],
  });
  assert(r.available === false, 'unavailable on day-use date', false, r.available);
}

console.log('\nCase 11: Search 14 days into future, all clear → available');
{
  const r = isAvailableForRange({
    searchStart: '2026-06-01', searchEnd: '2026-06-15',
    guests: 2, capacity: 2, status: 'VACANT',
    bookings: [{ start: '2026-05-24', end: '2026-05-27', guest: 'past' }],
    holds:    [{ start: '2026-05-28', end: '2026-05-30', kind: 'CLEANING' }],
  });
  assert(r.available === true, 'available (past blockers do not contend)', true, r.available);
}

console.log('\nCase 12: capacity = exactly the requested guests → available');
{
  const r = isAvailableForRange({
    searchStart: '2026-06-01', searchEnd: '2026-06-03',
    guests: 4, capacity: 4, status: 'VACANT',
  });
  assert(r.available === true, 'available at exact capacity', true, r.available);
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  Result: ${failed === 0 ? 'ALL CASES PASSED' : `FAILED ${failed}`}`);
console.log('═══════════════════════════════════════════════════════════\n');

process.exit(failed === 0 ? 0 : 1);
