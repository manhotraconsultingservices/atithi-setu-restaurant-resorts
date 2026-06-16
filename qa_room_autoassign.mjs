// ════════════════════════════════════════════════════════════════════════
//  qa_room_autoassign.mjs — Option A: book a room TYPE → auto-assign a
//  FLOATING room (room_locked=0); explicit room_id stays LOCKED (room_locked=1).
//  Mirrors the server's POST /hotel/bookings room-resolution logic so the
//  inventory-gate + auto-assign + lock-flag behaviour is asserted directly.
// ════════════════════════════════════════════════════════════════════════
const C = { g: '\x1b[32m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' };
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log(`  ${C.r}✗${C.x} ${label}`); } };

// One type 'DLX' with 3 rooms; 'STD' with 1. R-2 is in maintenance.
const rooms = [
  { id: 'R-1', type_id: 'DLX', status: 'VACANT' },
  { id: 'R-2', type_id: 'DLX', status: 'MAINTENANCE' },
  { id: 'R-3', type_id: 'DLX', status: 'VACANT' },
  { id: 'R-4', type_id: 'DLX', status: 'VACANT' },
  { id: 'R-9', type_id: 'STD', status: 'VACANT' },
];

// Mirror of the server resolution: explicit room_id → locked; else auto-pick
// a free room from the type (excluding maintenance/blocked + taken) → floating.
function resolveRoom({ room_id, room_type_id }, taken = new Set()) {
  if (room_id) return { ok: true, room_id, room_locked: 1 };
  if (room_type_id) {
    const candidates = rooms
      .filter(r => r.type_id === room_type_id && r.status !== 'MAINTENANCE' && r.status !== 'BLOCKED')
      .sort((a, b) => a.id.localeCompare(b.id));
    const free = candidates.find(c => !taken.has(c.id));
    if (!free) return { ok: false, code: 409 };
    return { ok: true, room_id: free.id, room_locked: 0 };
  }
  return { ok: false, code: 400 };
}

console.log(`${C.b}\n═══ Option A — book by type → floating auto-assign ═══${C.x}`);

// 1. Book DLX with R-1 already taken → auto-assigns the next free DLX, floating.
const a = resolveRoom({ room_type_id: 'DLX' }, new Set(['R-1']));
ok(a.ok && a.room_id === 'R-3', 'auto-assigns the first FREE room in the type (skips taken R-1 → R-3)');
ok(a.room_locked === 0, 'type-based booking is FLOATING (room_locked=0)');

// 2. Maintenance room is never auto-assigned.
const b2 = resolveRoom({ room_type_id: 'DLX' }, new Set(['R-1', 'R-3']));
ok(b2.ok && b2.room_id === 'R-4', 'skips the MAINTENANCE room (R-2) → assigns R-4');

// 3. Type sold out for the dates → 409 (inventory is the gate, not a named room).
const c = resolveRoom({ room_type_id: 'DLX' }, new Set(['R-1', 'R-3', 'R-4']));
ok(!c.ok && c.code === 409, 'type with no free rooms → 409 (booking blocked by inventory)');

// 4. Explicit room_id → that room, LOCKED.
const d = resolveRoom({ room_id: 'R-3' });
ok(d.ok && d.room_id === 'R-3' && d.room_locked === 1, 'explicit room pick stays LOCKED (room_locked=1)');

// 5. Neither type nor room → 400.
ok(resolveRoom({}).code === 400, 'no type and no room → 400');

// 6. A single-room type still books its one room, floating.
const e = resolveRoom({ room_type_id: 'STD' });
ok(e.ok && e.room_id === 'R-9' && e.room_locked === 0, 'single-room type books its room, floating');

console.log(`${C.b}\n═══════════════════════════════════════════════════════════════${C.x}`);
console.log(`  ${C.g}✓ Passed:${C.x} ${pass}`);
console.log(`  ${fail ? C.r : C.g}✗ Failed:${C.x} ${fail}`);
console.log(`${C.b}═══════════════════════════════════════════════════════════════${C.x}`);
process.exit(fail > 0 ? 1 : 0);
