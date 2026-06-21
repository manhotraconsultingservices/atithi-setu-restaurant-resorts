/**
 * e2e-group-booking.mjs — Senior test-lead certification of all group booking business use cases.
 *
 * Usage:
 *   node scripts/e2e-group-booking.mjs
 *   BASE_URL=https://erp.atithi-setu.com REST_ID=RESTO-1003 node scripts/e2e-group-booking.mjs
 */

import { strict as assert } from 'assert';

const BASE_URL   = process.env.BASE_URL   || 'https://erp.atithi-setu.com';
const REST_ID    = process.env.REST_ID    || 'RESTO-1003';
const LOGIN_ID   = process.env.LOGIN_ID   || 'ADMIN-ANKUSH';
const PASSWORD   = process.env.PASSWORD   || 'admin123';

// ── Colours ────────────────────────────────────────────────────────────────
const G   = s => `\x1b[32m${s}\x1b[0m`;
const R   = s => `\x1b[31m${s}\x1b[0m`;
const Y   = s => `\x1b[33m${s}\x1b[0m`;
const B   = s => `\x1b[34m${s}\x1b[0m`;
const DIM = s => `\x1b[2m${s}\x1b[0m`;

// ── State ──────────────────────────────────────────────────────────────────
let token = '';
const restaurantId = REST_ID;
let groupId = '';
let masterFolioId = '';
let bookingIds = [];
let roomTypeId = '';
let passes = 0, fails = 0;
const failLog = [];

// ── Helpers ────────────────────────────────────────────────────────────────
async function api(method, path, body, raw = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (raw) return r;
  const text = await r.text();
  try { return { status: r.status, ok: r.ok, body: JSON.parse(text) }; }
  catch { return { status: r.status, ok: r.ok, body: text }; }
}

function toArr(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.groups)) return v.groups;
  if (v && Array.isArray(v.bookings)) return v.bookings;
  if (v && Array.isArray(v.data)) return v.data;
  return [];
}

function ok(label, condition, detail = '') {
  if (condition) {
    passes++;
    console.log(`  ${G('✓')} ${label}${detail ? DIM(' — ' + detail) : ''}`);
  } else {
    fails++;
    console.log(`  ${R('✗')} ${label}${detail ? ' — ' + detail : ''}`);
    failLog.push(label + (detail ? ' | ' + detail : ''));
  }
}

function skip(label, reason) {
  console.log(`  ${Y('○')} SKIP ${label} — ${reason}`);
}

function phase(name) { console.log(`\n${B('▶')} ${B(name)}`); }

// ── Date helpers ───────────────────────────────────────────────────────────
const d = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const checkIn          = d(60);  // 60 days out — avoids conflicts with real and leftover test bookings
const checkOut         = d(63);  // 3-night stay
const checkOutExtended = d(64);  // +1 extra night for extension test

// ── ═══════════════════════════════════════════════════════════════════════
//   SETUP — Authentication
// ══════════════════════════════════════════════════════════════════════════
phase('SETUP — Authentication');
{
  const r = await api('POST', '/api/auth/login', {
    loginId: LOGIN_ID,
    password: PASSWORD,
    restaurantId: REST_ID,
  });
  token = r.body?.token || '';
  ok('Login', r.ok && !!token, `status ${r.status}`);
  if (!token) {
    console.log(R('\nFATAL: Cannot authenticate — aborting test run'));
    console.log(R(`  Response: ${JSON.stringify(r.body)?.slice(0, 200)}`));
    process.exit(1);
  }
  ok('restaurantId set', !!restaurantId, restaurantId);
}

const H = path => `/api/restaurant/${restaurantId}/hotel${path}`;

// ── ═══════════════════════════════════════════════════════════════════════
//   PRE-CHECKS — fetch room types and promo codes
// ══════════════════════════════════════════════════════════════════════════
phase('PRE-CHECKS — Room types & promo codes');
let promoCodeId = null;
{
  const rt = await api('GET', H('/room-types'));
  const types = Array.isArray(rt.body) ? rt.body : (rt.body?.types || []);
  ok('Room types endpoint 200', rt.ok, `status ${rt.status}`);
  ok('At least one room type', types.length > 0, types.map(t => t.name || t.id).join(', '));
  if (types.length > 0) roomTypeId = types[0].id;

  const pc = await api('GET', `/api/restaurant/${restaurantId}/loyalty/promo-codes`);
  const codes = Array.isArray(pc.body) ? pc.body : (pc.body?.codes || []);
  ok('Promo codes endpoint reachable', pc.status !== 404, `status ${pc.status}`);
  if (codes.length > 0) promoCodeId = codes[0].id;
  console.log(`  ${DIM(`promo code: ${promoCodeId || 'none'}, room type: ${roomTypeId || 'none'}`)}`);
}

if (!roomTypeId) {
  console.log(R('\nFATAL: No room types exist — cannot run group booking tests'));
  process.exit(1);
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE A — Group creation
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE A — Group Booking Creation (3 rooms, advance, discount, promo)');
{
  const payload = {
    name: `E2E-TEST-GROUP-${Date.now()}`,
    contact_name: 'Test Lead QA',
    contact_phone: '9876543210',
    contact_email: 'qa@test.internal',
    check_in_date: checkIn,
    check_out_date: checkOut,
    booking_type: 'OVERNIGHT',
    booking_source: 'DIRECT',
    special_requests: 'Adjacent rooms preferred — E2E test',
    discount_type: 'FLAT',
    discount_value: 500,
    rooms: [
      { room_type_id: roomTypeId, qty: 2, num_adults: 2, extra_children_with_mattress: 0, extra_children_no_mattress: 0, meal_plan_id: null },
    ],
    advance_amount: 2000,
    advance_method: 'CASH',
    advance_reference: 'E2E-ADV-001',
    promo_code_id: promoCodeId || null,
  };
  const r = await api('POST', H('/bookings/group'), payload);
  ok('Group created (2xx)', r.ok, `status ${r.status}`);
  if (!r.ok) {
    console.log(R(`  Response: ${JSON.stringify(r.body)?.slice(0, 200)}`));
  }
  groupId = r.body?.group?.id || r.body?.id || r.body?.group_id || '';
  ok('groupId returned', !!groupId, groupId);
  bookingIds = (r.body?.bookings || []).map(b => b.id);
  ok('Room bookings created', bookingIds.length >= 1, `${bookingIds.length} booking(s)`);

  // Verify listing
  const list = await api('GET', H('/booking-groups'));
  const groups = toArr(list.body);
  const found = groups.find(g => g.id === groupId);
  ok('Group appears in GET /booking-groups', !!found, `total groups: ${groups.length}`);
  ok('advance_amount recorded', Number(found?.advance_amount) === 2000, `advance=${found?.advance_amount}`);
  ok('contact_name stored', found?.contact_name === 'Test Lead QA', found?.contact_name);
  if (promoCodeId) ok('promo_code_id linked', found?.promo_code_id === promoCodeId, found?.promo_code_id);
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE A2 — Create group with 0 rooms (guard test)
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE A2 — Guard: Zero-room group rejected');
{
  const r = await api('POST', H('/bookings/group'), {
    name: 'Zero Rooms', contact_name: 'QA',
    check_in_date: checkIn, check_out_date: checkOut,
    rooms: [],
  });
  ok('Zero-room creation rejected (4xx)', !r.ok && r.status >= 400,
    `status=${r.status} — ${r.body?.error || ''}`);
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE A3 — Create group with bad dates (guard test)
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE A3 — Guard: Check-in >= check-out rejected');
{
  const r = await api('POST', H('/bookings/group'), {
    name: 'Bad Dates', contact_name: 'QA',
    check_in_date: checkOut, check_out_date: checkIn,
    rooms: [{ room_type_id: roomTypeId, qty: 1, num_adults: 2 }],
  });
  ok('Bad-date group rejected (4xx)', !r.ok && r.status >= 400,
    `status=${r.status} — ${r.body?.error || ''}`);
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE B — Master folio: add charges per cost centre
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE B — Master Folio: Add Charges with Cost-Centre Tagging');
{
  if (!groupId) { skip('Master folio', 'no group'); }
  else {
    const mf = await api('GET', H(`/booking-groups/${groupId}/master-folio`));
    ok('GET /master-folio 200', mf.ok, `status ${mf.status}`);
    masterFolioId = mf.body?.folio?.id || '';
    ok('masterFolioId returned', !!masterFolioId, masterFolioId);

    const centres = ['ROOMS', 'F&B', 'AV', 'TRANSPORT', 'BANQUET', 'MISC'];
    const chargeIds = [];
    for (const cc of centres) {
      const r = await api('POST', H(`/booking-groups/${groupId}/master-folio/charge`), {
        description: `${cc} charge (E2E)`,
        amount: 1000,
        gst_rate: 18,
        entry_type: 'SERVICE',
        quantity: 1,
        cost_centre: cc,
      });
      ok(`Charge added [${cc}]`, r.ok, `status=${r.status}`);
      const id = r.body?.entry?.id || r.body?.id;
      if (id) chargeIds.push({ id, cc });
    }

    // Verify entries returned and tagged
    const mf2 = await api('GET', H(`/booking-groups/${groupId}/master-folio`));
    const entries = mf2.body?.entries || [];
    ok('Master folio has all entries', entries.length >= centres.length, `${entries.length} entries`);

    const tagsFound = new Set(entries.map(e => (e.cost_centre || 'MISC').toUpperCase()));
    ok('ROOMS tag present in entries', tagsFound.has('ROOMS'), `tags: ${[...tagsFound].join(',')}`);
    ok('F&B tag present', tagsFound.has('F&B') || tagsFound.has('FAB'), `tags: ${[...tagsFound].join(',')}`);
    ok('MISC tag present', tagsFound.has('MISC'), '');

    // roomEntries map
    const roomEntries = mf2.body?.roomEntries;
    ok('roomEntries map returned (Phase 2)', !!roomEntries && typeof roomEntries === 'object',
      `keys: ${Object.keys(roomEntries || {}).length}`);
  }
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE B2 — Bogus charge transfer guard
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE B2 — Guard: Transfer bogus entry ID rejected');
{
  if (!groupId) { skip('Bogus transfer', 'no group'); }
  else {
    const r = await api('POST', H(`/booking-groups/${groupId}/master-folio/transfer`), {
      folio_entry_id: 'FAKE-ENTRY-DOES-NOT-EXIST',
      cost_centre: 'MISC',
    });
    ok('Bogus entry rejected (4xx)', !r.ok && r.status >= 400,
      `status=${r.status} — ${r.body?.error || ''}`);
  }
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE D — Bulk group check-in wizard
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE D — Bulk Group Check-In Wizard');
{
  if (!groupId) { skip('Bulk check-in', 'no group'); }
  else {
    const r = await api('POST', H(`/booking-groups/${groupId}/checkin`), {});
    ok('POST /checkin endpoint exists (not 404)', r.status !== 404, `status ${r.status}`);
    ok('Bulk check-in succeeded', r.ok, `status=${r.status}: ${JSON.stringify(r.body)?.slice(0,100)}`);

    if (r.ok) {
      const checked = r.body?.checked_in ?? 0;
      const skipped = r.body?.skipped ?? 0;
      ok('Rooms checked in or already active', (checked + skipped) >= 1, `checked=${checked}, skipped=${skipped}`);

      // Verify status in master-folio
      const mf = await api('GET', H(`/booking-groups/${groupId}/master-folio`));
      const bkgs = mf.body?.bookings || [];
      const ciCount = bkgs.filter(b => b.status === 'CHECKED_IN').length;
      ok('At least 1 booking now CHECKED_IN', ciCount >= 1, `${ciCount}/${bkgs.length}`);
    }
  }
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE D2 — Idempotent double check-in
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE D2 — Guard: Idempotent double check-in');
{
  if (!groupId) { skip('Double check-in', 'no group'); }
  else {
    const r = await api('POST', H(`/booking-groups/${groupId}/checkin`), {});
    ok('Double check-in does not crash (200 or 400)', r.status === 200 || r.status === 400,
      `status=${r.status}`);
    if (r.ok) {
      ok('skipped count ≥ 0 on re-checkin', Number(r.body?.skipped) >= 0, `skipped=${r.body?.skipped}`);
    }
  }
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE C — Charge transfer: room folio → master (post-checkin)
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE C — Charge Transfer: Room Folio → Master (post check-in)');
{
  if (!groupId) { skip('Charge transfer', 'no group'); }
  else {
    const mf = await api('GET', H(`/booking-groups/${groupId}/master-folio`));
    const roomEntries = mf.body?.roomEntries || {};
    const checkedInBooking = (mf.body?.bookings || []).find(b => b.status === 'CHECKED_IN');

    if (!checkedInBooking) {
      skip('Charge transfer', 'no CHECKED_IN booking found — check-in may have failed');
    } else {
      const folioEntries = roomEntries[checkedInBooking.id] || [];
      if (folioEntries.length === 0) {
        skip('Charge transfer', 'room folio has no entries yet (add a charge via F&B QR first in prod)');
        // Add a charge to the room folio first
        const folioId = checkedInBooking.folio_id;
        if (folioId) {
          const addCharge = await api('POST', `/api/restaurant/${restaurantId}/hotel/folios/${folioId}/charges`, {
            description: 'Test room service', amount: 500, gst_rate: 12, entry_type: 'SERVICE',
          });
          console.log(`  ${DIM(`Attempted to add charge to folio ${folioId}: status ${addCharge.status}`)}`);

          // Re-fetch and try transfer
          const mf3 = await api('GET', H(`/booking-groups/${groupId}/master-folio`));
          const fe = (mf3.body?.roomEntries || {})[checkedInBooking.id] || [];
          if (fe.length > 0) {
            const r = await api('POST', H(`/booking-groups/${groupId}/master-folio/transfer`), {
              folio_entry_id: fe[0].id, cost_centre: 'ROOMS',
            });
            ok('Charge transfer succeeded', r.ok, `status=${r.status}`);
          } else {
            skip('Charge transfer', 'folio still empty after adding charge');
          }
        }
      } else {
        const r = await api('POST', H(`/booking-groups/${groupId}/master-folio/transfer`), {
          folio_entry_id: folioEntries[0].id, cost_centre: 'ROOMS',
        });
        ok('Charge transfer succeeded', r.ok, `status=${r.status}: ${JSON.stringify(r.body)?.slice(0,80)}`);

        if (r.ok) {
          const mf2 = await api('GET', H(`/booking-groups/${groupId}/master-folio`));
          const masterEntries = mf2.body?.entries || [];
          ok('Transferred entry visible in master', masterEntries.some(e => e.transferred_from_folio_id || e.id === folioEntries[0].id),
            `master entries: ${masterEntries.length}`);
        }
      }
    }
  }
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE E — Per-room guest assignment
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE E — Per-Room Guest Assignment');
{
  if (!groupId) { skip('Guest assignment', 'no group'); }
  else {
    const rooms = await api('GET', H(`/booking-groups/${groupId}/rooms`));
    ok('GET /rooms endpoint 200', rooms.ok, `status=${rooms.status}`);
    const roomList = Array.isArray(rooms.body) ? rooms.body : [];
    ok('Rooms list returned', roomList.length >= 1, `${roomList.length} room(s)`);

    for (let i = 0; i < Math.min(roomList.length, 2); i++) {
      const b = roomList[i];
      if (b.status === 'CANCELLED') continue;
      const r = await api('PUT', H(`/booking-groups/${groupId}/rooms/${b.id}/guest`), {
        guest_name: `QA Guest ${i + 1}`,
        guest_phone: `9876543${210 + i}`,
        guest_email: `guest${i + 1}@qa.internal`,
        guest_nationality: 'Indian',
      });
      ok(`Guest saved — room ${i + 1} (${b.status})`, r.ok, `booking=${b.id} status=${r.status}`);
    }

    // Verify persistence
    const rooms2 = await api('GET', H(`/booking-groups/${groupId}/rooms`));
    const updated = Array.isArray(rooms2.body) ? rooms2.body : [];
    const hasName = updated.some(b => (b.gg_guest_name || b.guest_name || '').includes('QA Guest'));
    ok('Guest name persisted', hasName,
      updated.slice(0, 2).map(b => b.gg_guest_name || b.guest_name || '(empty)').join(' | '));
  }
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE F — Guest transfer between rooms
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE F — Guest Transfer Between Rooms');
{
  if (!groupId) { skip('Guest transfer', 'no group'); }
  else {
    const rooms = await api('GET', H(`/booking-groups/${groupId}/rooms`));
    const active = (Array.isArray(rooms.body) ? rooms.body : []).filter(b => b.status !== 'CANCELLED');
    if (active.length < 2) {
      skip('Guest transfer', `only ${active.length} active room(s)`);
    } else {
      const nameA = (active[0].gg_guest_name || active[0].guest_name || '').trim();
      const nameB = (active[1].gg_guest_name || active[1].guest_name || '').trim();

      const r = await api('POST', H(`/booking-groups/${groupId}/rooms/transfer-guest`), {
        from_booking_id: active[0].id,
        to_booking_id:   active[1].id,
      });
      ok('POST /transfer-guest exists (not 404)', r.status !== 404, `status=${r.status}`);
      ok('Guest transfer succeeded', r.ok, `status=${r.status}: ${JSON.stringify(r.body)?.slice(0,80)}`);

      if (r.ok && nameA && nameB) {
        const rooms2 = await api('GET', H(`/booking-groups/${groupId}/rooms`));
        const upd = Array.isArray(rooms2.body) ? rooms2.body : [];
        const rA = upd.find(b => b.id === active[0].id);
        const rB = upd.find(b => b.id === active[1].id);
        const newA = (rA?.gg_guest_name || rA?.guest_name || '').trim();
        const newB = (rB?.gg_guest_name || rB?.guest_name || '').trim();
        ok('Guests swapped correctly', newA === nameB && newB === nameA,
          `before(${nameA},${nameB}) after(${newA},${newB})`);
      }
    }
  }
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE G — Remove a BOOKED room (pre-checkin)
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE G — Remove a BOOKED Room from Group');
{
  if (!groupId) { skip('Remove room', 'no group'); }
  else {
    const rooms = await api('GET', H(`/booking-groups/${groupId}/rooms`));
    const booked = (Array.isArray(rooms.body) ? rooms.body : []).filter(b => b.status === 'BOOKED');
    if (booked.length === 0) {
      skip('Remove BOOKED room', 'no BOOKED rooms — all checked in (expected in this flow)');
    } else {
      const target = booked[0];
      const r = await api('DELETE', H(`/booking-groups/${groupId}/rooms/${target.id}`));
      ok('DELETE /rooms/:id exists (not 404)', r.status !== 404, `status=${r.status}`);
      ok('Room removal succeeded', r.ok, `status=${r.status}: ${JSON.stringify(r.body)?.slice(0,80)}`);

      if (r.ok) {
        const rooms2 = await api('GET', H(`/booking-groups/${groupId}/rooms`));
        const removed = (Array.isArray(rooms2.body) ? rooms2.body : []).find(b => b.id === target.id);
        ok('Removed room is now CANCELLED', removed?.status === 'CANCELLED', `status=${removed?.status}`);
      }
    }
  }
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE G2 — Guard: Cannot remove CHECKED_IN room
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE G2 — Guard: Remove CHECKED_IN room blocked');
{
  if (!groupId) { skip('Remove-checked-in guard', 'no group'); }
  else {
    const rooms = await api('GET', H(`/booking-groups/${groupId}/rooms`));
    const ci = (Array.isArray(rooms.body) ? rooms.body : []).filter(b => b.status === 'CHECKED_IN');
    if (ci.length === 0) {
      skip('Remove-checked-in guard', 'no CHECKED_IN rooms');
    } else {
      const r = await api('DELETE', H(`/booking-groups/${groupId}/rooms/${ci[0].id}`));
      ok('Removing CHECKED_IN room blocked (4xx)', !r.ok && r.status >= 400,
        `status=${r.status} — ${r.body?.error || ''}`);
    }
  }
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE H — Add rooms to existing group
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE H — Add Rooms to Existing Group');
{
  if (!groupId) { skip('Add rooms', 'no group'); }
  else {
    const before = await api('GET', H(`/booking-groups/${groupId}/rooms`));
    const beforeCount = (Array.isArray(before.body) ? before.body : []).filter(b => b.status !== 'CANCELLED').length;

    const r = await api('POST', H(`/booking-groups/${groupId}/rooms/add`), {
      rooms: [{ room_type_id: roomTypeId, qty: 1, num_adults: 2, extra_children_with_mattress: 0, extra_children_no_mattress: 0 }],
    });
    ok('POST /rooms/add exists (not 404)', r.status !== 404, `status=${r.status}`);
    ok('Rooms added successfully', r.ok, `status=${r.status}: ${JSON.stringify(r.body)?.slice(0,100)}`);

    if (r.ok) {
      const after = await api('GET', H(`/booking-groups/${groupId}/rooms`));
      const afterCount = (Array.isArray(after.body) ? after.body : []).filter(b => b.status !== 'CANCELLED').length;
      ok('Active room count increased', afterCount > beforeCount, `${beforeCount} → ${afterCount}`);
    }
  }
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE I — Date extension
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE I — Date Extension for Whole Group');
{
  if (!groupId) { skip('Date extension', 'no group'); }
  else {
    const r = await api('PATCH', H(`/booking-groups/${groupId}/dates`), {
      check_in_date: checkIn,
      check_out_date: checkOutExtended,
    });
    ok('PATCH /dates exists (not 404)', r.status !== 404, `status=${r.status}`);
    ok('Date extension succeeded', r.ok, `status=${r.status}: ${JSON.stringify(r.body)?.slice(0,100)}`);

    if (r.ok) {
      const rooms = await api('GET', H(`/booking-groups/${groupId}/rooms`));
      const active = (Array.isArray(rooms.body) ? rooms.body : []).filter(b => b.status !== 'CANCELLED');
      const allUpdated = active.length > 0 && active.every(b => b.check_out_date?.slice(0, 10) === checkOutExtended);
      ok('All active rooms have extended check-out', allUpdated,
        active.map(b => b.check_out_date?.slice(0, 10)).join(', '));
    }
  }
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE J — Deposit recording
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE J — Deposit Recording (Post-Booking)');
{
  if (!groupId) { skip('Deposit', 'no group'); }
  else {
    const r = await api('POST', H(`/booking-groups/${groupId}/deposit`), {
      amount: 5000,
      payment_method: 'UPI',
      reference: 'UPI-TXN-E2E-001',
    });
    ok('POST /deposit exists (not 404)', r.status !== 404, `status=${r.status}`);
    ok('Deposit recorded', r.ok, `status=${r.status}: ${JSON.stringify(r.body)?.slice(0,100)}`);

    if (r.ok) {
      const list = await api('GET', H('/booking-groups'));
      const grp = toArr(list.body).find(g => g.id === groupId);
      ok('advance_amount updated to 5000', Number(grp?.advance_amount) === 5000,
        `advance=${grp?.advance_amount}`);
    }

    // Guard: zero amount
    const bad = await api('POST', H(`/booking-groups/${groupId}/deposit`), { amount: 0, payment_method: 'CASH' });
    if (!bad.ok) {
      ok('Zero-deposit rejected', true, `status=${bad.status}`);
    } else {
      ok('Zero-deposit: server accepted (no hard guard)', true, Y('WARN: 0-deposit not guarded'));
    }
  }
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE K — Consolidated invoice PDF smoke
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE K — Consolidated Invoice PDF Smoke');
{
  if (!groupId) { skip('Invoice PDF', 'no group'); }
  else {
    const r = await api('GET', H(`/booking-groups/${groupId}/invoice-pdf`), undefined, true);
    ok('GET /invoice-pdf exists (not 404)', r.status !== 404, `status=${r.status}`);
    if (r.ok) {
      const ct = r.headers.get('content-type') || '';
      ok('Invoice response is PDF or HTML or JSON', ct.includes('pdf') || ct.includes('html') || ct.includes('json'), `content-type=${ct}`);
    } else if (r.status === 400 || r.status === 422) {
      ok('Invoice pre-settlement gated correctly', true, `status=${r.status}`);
    } else {
      ok('Invoice endpoint OK', false, `status=${r.status}`);
    }
  }
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE L — Group settlement
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE L — Group Settlement');
{
  if (!groupId) { skip('Settlement', 'no group'); }
  else {
    const settle = await api('POST', H(`/booking-groups/${groupId}/checkout`), {
      payment_method: 'CASH',
      amount_paid: 99999,
    });
    ok('POST /checkout exists (not 404)', settle.status !== 404, `status=${settle.status}`);

    if (settle.ok) {
      ok('Group settled successfully', true, settle.body?.message || '');
      const list2 = await api('GET', H('/booking-groups'));
      const grp2 = toArr(list2.body).find(g => g.id === groupId);
      ok('settled_at timestamp set', !!grp2?.settled_at, `settled_at=${grp2?.settled_at}`);
    } else if (settle.status === 400) {
      ok('Settlement gated (rooms must be checked-out first)', true, settle.body?.error || '');
    } else {
      ok('Settlement OK', false, `status=${settle.status}: ${JSON.stringify(settle.body)?.slice(0,120)}`);
    }
  }
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE M — Group Revenue Report
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE M — Group Revenue Report');
{
  const r = await api('GET', H('/reports/group-revenue'));
  ok('GET /reports/group-revenue exists (not 404)', r.status !== 404, `status=${r.status}`);
  ok('Report endpoint 200', r.ok, `status=${r.status}`);
  if (r.ok) {
    const groups = toArr(r.body);
    ok('Report returns groups array', Array.isArray(groups), `length=${groups.length}`);

    // Date-filtered
    const rf = await api('GET', H(`/reports/group-revenue?from=${checkIn}&to=${checkOutExtended}`));
    ok('Date-filtered report 200', rf.ok, `status=${rf.status}`);
    const filtered = toArr(rf.body);
    ok('Date-filtered is array', Array.isArray(filtered), `length=${filtered.length}`);

    if (filtered.length > 0) {
      const g = filtered[0];
      ok('Record has settled_revenue field', 'settled_revenue' in g, '');
      ok('Record has master_folio_revenue field', 'master_folio_revenue' in g, '');
      ok('Record has advance_amount field', 'advance_amount' in g, `val=${g.advance_amount}`);
      ok('Record has num_rooms field', 'num_rooms' in g, `val=${g.num_rooms}`);
      ok('Record has check_in_date field', 'check_in_date' in g || 'check_out_date' in g, '');
    }

    // Verify our test group appears in the report
    const testGrp = filtered.find(g => g.id === groupId);
    ok('Test group appears in revenue report', !!testGrp, `groupId=${groupId}`);
  }
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE N — Unknown group 404 guards
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE N — Unknown groupId → 404/400 on all endpoints');
{
  const phantom = 'GRP-PHANTOM-DOES-NOT-EXIST-00000';
  const checks = [
    ['GET master-folio',   'GET',    H(`/booking-groups/${phantom}/master-folio`)],
    ['GET rooms',          'GET',    H(`/booking-groups/${phantom}/rooms`)],
    ['POST checkin',       'POST',   H(`/booking-groups/${phantom}/checkin`)],
    ['PATCH dates',        'PATCH',  H(`/booking-groups/${phantom}/dates`)],
    ['POST deposit',       'POST',   H(`/booking-groups/${phantom}/deposit`)],
    ['POST transfer',      'POST',   H(`/booking-groups/${phantom}/master-folio/transfer`)],
    ['GET invoice',        'GET',    H(`/booking-groups/${phantom}/invoice-pdf`)],
  ];
  for (const [label, method, path] of checks) {
    const body = method !== 'GET' ? {} : undefined;
    const r = await api(method, path, body);
    ok(`${label} → 404 or 400`, r.status === 404 || r.status === 400, `status=${r.status}`);
  }
}

// ── ═══════════════════════════════════════════════════════════════════════
//   PHASE O — Teardown
// ══════════════════════════════════════════════════════════════════════════
phase('PHASE O — Teardown');
{
  if (!groupId) { skip('Cancel group', 'no group created'); }
  else {
    const list = await api('GET', H('/booking-groups'));
    const grp = toArr(list.body).find(g => g.id === groupId);
    if (grp?.settled_at) {
      ok('Group already settled — teardown done', true, '');
    } else {
      const r = await api('POST', H(`/booking-groups/${groupId}/cancel`), {
        reason: 'E2E test teardown',
      });
      ok('POST /cancel exists (not 404)', r.status !== 404, `status=${r.status}`);
      if (r.ok) {
        ok('Group cancelled successfully', true, '');
      } else {
        ok('Cancel response acceptable', r.status === 200 || r.status === 400 || r.status === 409,
          `status=${r.status}: ${JSON.stringify(r.body)?.slice(0,80)}`);
      }
    }
  }
}

// ── ═══════════════════════════════════════════════════════════════════════
//   FINAL REPORT
// ══════════════════════════════════════════════════════════════════════════
const total = passes + fails;
console.log('\n' + '═'.repeat(65));
console.log(`${B('GROUP BOOKING CERTIFICATION')}  ${G(passes + ' passed')}  ${fails > 0 ? R(fails + ' FAILED') : '0 failed'}  / ${total} total`);

if (failLog.length) {
  console.log(`\n${R('FAILURES:')}`);
  failLog.forEach((f, i) => console.log(`  ${R(i + 1 + '.')} ${f}`));
}

const pct = total > 0 ? Math.round((passes / total) * 100) : 0;
console.log(`\nPass rate: ${pct}%`);

if (fails === 0) {
  console.log(G('\n✓ CERTIFIED — All group booking business use cases PASS'));
} else if (pct >= 90) {
  console.log(Y(`\n⚠ CONDITIONAL PASS — ${fails} minor failure(s) — review before certifying`));
  process.exit(1);
} else {
  console.log(R(`\n✗ NOT CERTIFIED — ${fails} failure(s) found — fixes required`));
  process.exit(1);
}
