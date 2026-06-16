// ════════════════════════════════════════════════════════════════════════
//  qa_calendar_v2.mjs — Calendar V2 grid logic (20 Jun 2026)
//  Mirrors AvailabilityCalendarV2's three rules:
//   1. floatingByGroup — pull floating bookings (room_locked=0) out of the grid
//   2. physical-room display hides floating (its tentative room reads VACANT)
//   3. per-type inventory stays NET of floating (raw grid VACANT-cell count)
// ════════════════════════════════════════════════════════════════════════
const C = { g: '\x1b[32m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' };
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log(`  ${C.r}✗${C.x} ${label}`); } };

const dates = ['2026-06-16', '2026-06-17'];
// DLX type: R1 locked booking, R2 FLOATING booking, R3 vacant.
const rooms = [
  { id: 'R1', type_id: 'DLX', status: 'VACANT' },
  { id: 'R2', type_id: 'DLX', status: 'VACANT' },
  { id: 'R3', type_id: 'DLX', status: 'VACANT' },
];
const grid = {
  R1: {
    '2026-06-16': { status: 'BOOKED', booking_id: 'BK-LOCK', guest_name: 'Locked Guest', room_locked: 1, check_in_date: '2026-06-16', check_out_date: '2026-06-18' },
    '2026-06-17': { status: 'BOOKED', booking_id: 'BK-LOCK', guest_name: 'Locked Guest', room_locked: 1, check_in_date: '2026-06-16', check_out_date: '2026-06-18' },
  },
  R2: {
    '2026-06-16': { status: 'BOOKED', booking_id: 'BK-FLOAT', guest_name: 'Floating Guest', room_locked: 0, check_in_date: '2026-06-16', check_out_date: '2026-06-18' },
    '2026-06-17': { status: 'BOOKED', booking_id: 'BK-FLOAT', guest_name: 'Floating Guest', room_locked: 0, check_in_date: '2026-06-16', check_out_date: '2026-06-18' },
  },
  R3: {},
};

// Mirror of floatingByGroup: unique floating bookings whose tentative room is
// in the group.
function floatingForGroup(groupRooms) {
  const m = new Map();
  for (const r of groupRooms) {
    const dayMap = grid[r.id] || {};
    for (const d of Object.keys(dayMap)) {
      const c = dayMap[d];
      if (c?.booking_id && Number(c.room_locked ?? 1) === 0 && !m.has(c.booking_id)) {
        m.set(c.booking_id, { id: c.booking_id, guest_name: c.guest_name, ci: c.check_in_date, co: c.check_out_date });
      }
    }
  }
  return Array.from(m.values());
}
// Mirror of the physical-room cell: floating booking hidden → VACANT.
function physicalStatus(rawCell) {
  if (rawCell?.booking_id && Number(rawCell.room_locked ?? 1) === 0) return 'VACANT';
  return rawCell?.status || 'VACANT';
}
// Mirror of the inventory header: raw grid VACANT-cell count (net of floating).
function inventory(groupRooms, date) {
  let avail = 0;
  for (const r of groupRooms) {
    if (r.status === 'MAINTENANCE' || r.status === 'BLOCKED') continue;
    const st = String(grid[r.id]?.[date]?.status || 'VACANT').toUpperCase();
    if (st === 'VACANT') avail++;
  }
  return avail;
}

console.log(`${C.b}\n═══ Calendar V2 — floating in Unassigned lane ═══${C.x}`);

const dlx = rooms.filter(r => r.type_id === 'DLX');
const floats = floatingForGroup(dlx);

// 1. Exactly the floating booking is pulled into the lane (locked is NOT).
ok(floats.length === 1 && floats[0].id === 'BK-FLOAT', 'floating booking is extracted into the Unassigned lane (locked is not)');

// 2. Physical room display HIDES the floating booking (R2 reads VACANT)…
ok(physicalStatus(grid.R2['2026-06-16']) === 'VACANT', 'floating booking is hidden from its tentative physical room (reads VACANT)');
// …but the LOCKED booking still shows in its room.
ok(physicalStatus(grid.R1['2026-06-16']) === 'BOOKED', 'locked booking still shows in its physical room');

// 3. Inventory stays NET of the floating booking: 3 rooms − 1 locked − 1 floating = 1.
ok(inventory(dlx, '2026-06-16') === 1, 'inventory header = 1 sellable (net of locked + floating), even though 2 rooms display vacant');
ok(inventory(dlx, '2026-06-17') === 1, 'inventory net of floating on the second night too');

// 4. The lane chip covers the right dates (half-open [ci, co)).
const covered = (fb, d) => d >= fb.ci.slice(0,10) && d < fb.co.slice(0,10);
ok(covered(floats[0], '2026-06-16') && covered(floats[0], '2026-06-17') && !covered(floats[0], '2026-06-18'),
  'floating chip spans its nights (half-open) in the lane');

// 5. A type with no floating bookings yields an empty lane.
ok(floatingForGroup([{ id: 'R3', type_id: 'DLX' }]).length === 0, 'a room with no floating booking yields an empty Unassigned lane');

console.log(`${C.b}\n═══════════════════════════════════════════════════════════════${C.x}`);
console.log(`  ${C.g}✓ Passed:${C.x} ${pass}`);
console.log(`  ${fail ? C.r : C.g}✗ Failed:${C.x} ${fail}`);
console.log(`${C.b}═══════════════════════════════════════════════════════════════${C.x}`);
process.exit(fail > 0 ? 1 : 0);
