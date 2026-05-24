#!/usr/bin/env node
/**
 * Hotel Module — Comprehensive Calculation Regression
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Locks in the business-rule math that the other suites don't cover:
 *
 *   1.  Cancellation refund policy (full / partial / inside-window-no-policy / none)
 *   2.  Late checkout fee logic
 *   3.  Day-use booking semantics
 *   4.  Group booking validation
 *   5.  Min / max stay length guards
 *   6.  Tariff-slab GST edge cases (boundaries, custom slabs)
 *
 * Run:  node scripts/verify-hotel-module-offline.cjs
 */
'use strict';

let failed = 0;
const T = (label, fn) => {
  console.log(`\n${label}`);
  try { fn(); } catch (e) { console.log(`  ✗ THREW: ${e.message}`); failed++; }
};
const assert = (cond, label, expected, got) => {
  const ok = cond;
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)} = ${JSON.stringify(expected)}`);
  if (!ok) failed++;
};

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  Hotel Module — Comprehensive Calculation Regression');
console.log('═══════════════════════════════════════════════════════════');

// ─── 1. Cancellation refund policy ───────────────────────────────────────
// Mirrors server.ts → computeCancellationRefund().
function computeRefund({ checkInDate, totalAmount, fullDays, partialPct, today }) {
  const t = new Date(today + 'T00:00:00Z');
  const ci = new Date(checkInDate + 'T00:00:00Z');
  const daysUntil = Math.floor((ci.getTime() - t.getTime()) / 86400000);
  const round2 = (n) => Math.round(n * 100) / 100;
  if (fullDays == null && partialPct == null) {
    return { refund_pct: null, refund_amount: 0, days_until_checkin: daysUntil };
  }
  if (fullDays != null && daysUntil >= fullDays) {
    return { refund_pct: 100, refund_amount: round2(totalAmount), days_until_checkin: daysUntil };
  }
  if (partialPct != null) {
    return { refund_pct: partialPct, refund_amount: round2(totalAmount * partialPct / 100), days_until_checkin: daysUntil };
  }
  return { refund_pct: 0, refund_amount: 0, days_until_checkin: daysUntil };
}

T('Case 1A: Cancel 10 days out, policy = 100% if ≥7d, 50% otherwise → full refund', () => {
  const r = computeRefund({ checkInDate: '2026-06-10', totalAmount: 10000, fullDays: 7, partialPct: 50, today: '2026-05-31' });
  assert(r.refund_pct === 100, 'full refund pct', 100, r.refund_pct);
  assert(r.refund_amount === 10000, 'full refund amount', 10000, r.refund_amount);
  assert(r.days_until_checkin === 10, 'days_until_checkin = 10', 10, r.days_until_checkin);
});

T('Case 1B: Cancel 3 days out, policy = 100% if ≥7d, 50% otherwise → partial refund', () => {
  const r = computeRefund({ checkInDate: '2026-06-03', totalAmount: 10000, fullDays: 7, partialPct: 50, today: '2026-05-31' });
  assert(r.refund_pct === 50, 'partial refund pct', 50, r.refund_pct);
  assert(r.refund_amount === 5000, 'partial refund amount', 5000, r.refund_amount);
});

T('Case 1C: Cancel inside window, no partial policy → 0% refund', () => {
  const r = computeRefund({ checkInDate: '2026-06-03', totalAmount: 10000, fullDays: 7, partialPct: null, today: '2026-05-31' });
  assert(r.refund_pct === 0, 'no refund', 0, r.refund_pct);
  assert(r.refund_amount === 0, 'no refund amount', 0, r.refund_amount);
});

T('Case 1D: No policy configured → null refund (manual handling)', () => {
  const r = computeRefund({ checkInDate: '2026-06-10', totalAmount: 10000, fullDays: null, partialPct: null, today: '2026-05-31' });
  assert(r.refund_pct === null, 'null refund pct', null, r.refund_pct);
});

T('Case 1E: Exactly at cutoff (full_days = days_until) → full refund', () => {
  const r = computeRefund({ checkInDate: '2026-06-07', totalAmount: 5000, fullDays: 7, partialPct: 30, today: '2026-05-31' });
  assert(r.refund_pct === 100, '≥ comparison inclusive', 100, r.refund_pct);
});

T('Case 1F: Already past check-in (negative days) → inside window', () => {
  const r = computeRefund({ checkInDate: '2026-05-25', totalAmount: 5000, fullDays: 7, partialPct: 25, today: '2026-05-31' });
  assert(r.refund_pct === 25, 'partial when overdue', 25, r.refund_pct);
  assert(r.days_until_checkin === -6, 'negative days_until_checkin', -6, r.days_until_checkin);
});

// ─── 2. Late checkout fee logic ──────────────────────────────────────────
// Mirrors server.ts → computeLateCheckoutFee() (simplified — no IST clock dep).
function computeLateFee({ checkOutDate, todayDate, currentTime, cutoff, roomRate }) {
  if (!cutoff || roomRate <= 0) return { applies: false, fee_amount: 0, late_by_hours: 0 };
  if (!/^\d{2}:\d{2}$/.test(cutoff)) return { applies: false, fee_amount: 0, late_by_hours: 0 };
  if (todayDate > checkOutDate) {
    const daysOver = Math.max(1, Math.round(
      (new Date(todayDate).getTime() - new Date(checkOutDate).getTime()) / 86400000
    ));
    return { applies: true, fee_amount: Math.round(roomRate * 100) / 100, late_by_hours: daysOver * 24 };
  }
  if (todayDate === checkOutDate) {
    const [ch, cm] = cutoff.split(':').map(Number);
    const [nh, nm] = currentTime.split(':').map(Number);
    const cutoffMin = ch * 60 + cm;
    const nowMin = nh * 60 + nm;
    if (nowMin > cutoffMin) {
      const lateBy = (nowMin - cutoffMin) / 60;
      return { applies: true, fee_amount: Math.round(roomRate * 100) / 100, late_by_hours: Math.round(lateBy * 10) / 10 };
    }
  }
  return { applies: false, fee_amount: 0, late_by_hours: 0 };
}

T('Case 2A: Checkout at 13:00 with cutoff 12:00 → applies, 1h late', () => {
  const r = computeLateFee({ checkOutDate: '2026-05-24', todayDate: '2026-05-24', currentTime: '13:00', cutoff: '12:00', roomRate: 3000 });
  assert(r.applies === true, 'fee applies', true, r.applies);
  assert(r.fee_amount === 3000, 'fee = room rate', 3000, r.fee_amount);
  assert(r.late_by_hours === 1.0, '1.0h late', 1.0, r.late_by_hours);
});

T('Case 2B: Checkout at 11:30 with cutoff 12:00 → no fee (within grace)', () => {
  const r = computeLateFee({ checkOutDate: '2026-05-24', todayDate: '2026-05-24', currentTime: '11:30', cutoff: '12:00', roomRate: 3000 });
  assert(r.applies === false, 'no fee', false, r.applies);
  assert(r.fee_amount === 0, 'no fee amount', 0, r.fee_amount);
});

T('Case 2C: Checkout 2 days after scheduled date → 1 night fee (48h late)', () => {
  const r = computeLateFee({ checkOutDate: '2026-05-22', todayDate: '2026-05-24', currentTime: '08:00', cutoff: '12:00', roomRate: 3000 });
  assert(r.applies === true, 'fee applies', true, r.applies);
  assert(r.fee_amount === 3000, 'one night fee', 3000, r.fee_amount);
  assert(r.late_by_hours === 48, '48h late (2 × 24)', 48, r.late_by_hours);
});

T('Case 2D: No cutoff configured → no fee', () => {
  const r = computeLateFee({ checkOutDate: '2026-05-24', todayDate: '2026-05-24', currentTime: '15:00', cutoff: null, roomRate: 3000 });
  assert(r.applies === false, 'no policy → no fee', false, r.applies);
});

T('Case 2E: Exactly at cutoff (12:00 vs 12:00) → no fee (>, not ≥)', () => {
  const r = computeLateFee({ checkOutDate: '2026-05-24', todayDate: '2026-05-24', currentTime: '12:00', cutoff: '12:00', roomRate: 3000 });
  assert(r.applies === false, 'on the dot is within grace', false, r.applies);
});

// ─── 3. Day-use booking semantics ────────────────────────────────────────
// Mirrors the createFolioWithRoomCharges() + departures filter logic.
function buildDayUseFolio({ rate, cfg = {} }) {
  const slab1Max = cfg.slab1Max ?? 1000;
  const slab2Max = cfg.slab2Max ?? 7500;
  const gst = rate <= slab1Max ? 0 : rate <= slab2Max ? 12 : 18;
  const svcPct = cfg.serviceChargePct ?? 0;
  const svc = Math.round(rate * svcPct / 100 * 100) / 100;
  const roomGst = Math.round(rate * gst / 100 * 100) / 100;
  const svcGst = Math.round(svc * gst / 100 * 100) / 100;
  const entries = [{ type: 'ROOM_CHARGE', amount: rate, gst: roomGst }];
  if (svc > 0) entries.push({ type: 'SERVICE_CHARGE', amount: svc, gst: svcGst });
  const subtotal = entries.reduce((s, e) => s + e.amount, 0);
  const gstTotal = entries.reduce((s, e) => s + e.gst, 0);
  return { entries, subtotal: Math.round(subtotal * 100) / 100, gst: Math.round(gstTotal * 100) / 100, grand: Math.round((subtotal + gstTotal) * 100) / 100, gstPct: gst };
}

T('Case 3A: Day-use ₹2,500 + 5% service → 1 night × rate (no nights × rate)', () => {
  const r = buildDayUseFolio({ rate: 2500, cfg: { serviceChargePct: 5 } });
  assert(r.gstPct === 12, '12% slab', 12, r.gstPct);
  assert(r.subtotal === 2625, 'subtotal 2500+125', 2625, r.subtotal);
  assert(r.gst === 315, 'gst on 2625 @ 12%', 315, r.gst);
  assert(r.grand === 2940, 'grand 2940', 2940, r.grand);
});

T('Case 3B: Day-use ₹1,000 (slab 1 boundary) → 0% GST', () => {
  const r = buildDayUseFolio({ rate: 1000 });
  assert(r.gstPct === 0, 'slab 1 inclusive', 0, r.gstPct);
  assert(r.grand === 1000, 'no GST added', 1000, r.grand);
});

T('Case 3C: Day-use departure shows when status=BOOKED + check_out=today', () => {
  // Mirrors the client-side Today\'s Departures filter for day-use.
  const isDayUseDeparture = (b, today) => {
    if (b.check_out_date !== today) return false;
    if (b.status === 'CHECKED_IN') return true;
    if (b.status === 'BOOKED' && b.booking_type === 'DAY_USE') return true;
    return false;
  };
  assert(isDayUseDeparture({ status: 'BOOKED',     booking_type: 'DAY_USE',   check_out_date: '2026-05-24' }, '2026-05-24') === true, 'BOOKED day-use → in departures', true, true);
  assert(isDayUseDeparture({ status: 'BOOKED',     booking_type: 'OVERNIGHT', check_out_date: '2026-05-24' }, '2026-05-24') === false, 'BOOKED overnight → NOT in departures', false, false);
  assert(isDayUseDeparture({ status: 'CHECKED_IN', booking_type: 'OVERNIGHT', check_out_date: '2026-05-24' }, '2026-05-24') === true, 'CHECKED_IN overnight → in departures', true, true);
  assert(isDayUseDeparture({ status: 'CANCELLED',  booking_type: 'DAY_USE',   check_out_date: '2026-05-24' }, '2026-05-24') === false, 'CANCELLED never in departures', false, false);
});

// ─── 4. Group booking validation ────────────────────────────────────────
function validateGroup({ rooms }) {
  if (!Array.isArray(rooms) || rooms.length === 0) return { ok: false, error: 'empty' };
  const ids = rooms.map(r => r.room_id);
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'duplicate' };
  return { ok: true };
}

T('Case 4A: Group with 3 distinct rooms → valid', () => {
  const r = validateGroup({ rooms: [{ room_id: 'R1' }, { room_id: 'R2' }, { room_id: 'R3' }] });
  assert(r.ok === true, 'valid', true, r.ok);
});

T('Case 4B: Group with duplicate room_id → invalid', () => {
  const r = validateGroup({ rooms: [{ room_id: 'R1' }, { room_id: 'R2' }, { room_id: 'R1' }] });
  assert(r.ok === false, 'rejected', false, r.ok);
  assert(r.error === 'duplicate', 'reason = duplicate', 'duplicate', r.error);
});

T('Case 4C: Empty group → invalid', () => {
  const r = validateGroup({ rooms: [] });
  assert(r.ok === false, 'rejected', false, r.ok);
});

T('Case 4D: Group total calculation — 3 rooms × 4 nights × varying rates', () => {
  const nights = 4;
  const rooms = [
    { room_rate: 2000, num_guests: 1 },
    { room_rate: 2500, num_guests: 2 },
    { room_rate: 3000, num_guests: 2 },
  ];
  const total = rooms.reduce((s, r) => s + r.room_rate * nights, 0);
  assert(total === 30000, '(2000+2500+3000)×4', 30000, total);
});

// ─── 5. Min / max stay length ────────────────────────────────────────────
function validateStayLength({ checkIn, checkOut, bookingType, minNights, maxNights }) {
  if (bookingType === 'DAY_USE') return { ok: true, nights: 1 };
  const nights = Math.max(1, Math.ceil((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000));
  if (minNights > 1 && nights < minNights) return { ok: false, error: `min ${minNights}`, nights };
  if (maxNights != null && nights > maxNights) return { ok: false, error: `max ${maxNights}`, nights };
  return { ok: true, nights };
}

T('Case 5A: 1 night when min = 2 → rejected', () => {
  const r = validateStayLength({ checkIn: '2026-05-24', checkOut: '2026-05-25', bookingType: 'OVERNIGHT', minNights: 2, maxNights: null });
  assert(r.ok === false, 'rejected', false, r.ok);
  assert(r.nights === 1, '1 night requested', 1, r.nights);
});

T('Case 5B: 2 nights when min = 2 → accepted (boundary inclusive)', () => {
  const r = validateStayLength({ checkIn: '2026-05-24', checkOut: '2026-05-26', bookingType: 'OVERNIGHT', minNights: 2, maxNights: null });
  assert(r.ok === true, 'accepted', true, r.ok);
});

T('Case 5C: 15 nights when max = 14 → rejected', () => {
  const r = validateStayLength({ checkIn: '2026-05-01', checkOut: '2026-05-16', bookingType: 'OVERNIGHT', minNights: 1, maxNights: 14 });
  assert(r.ok === false, 'rejected', false, r.ok);
  assert(r.nights === 15, '15 nights', 15, r.nights);
});

T('Case 5D: DAY_USE skips min/max guard', () => {
  const r = validateStayLength({ checkIn: '2026-05-24', checkOut: '2026-05-24', bookingType: 'DAY_USE', minNights: 2, maxNights: 14 });
  assert(r.ok === true, 'day-use bypasses', true, r.ok);
});

T('Case 5E: Max = null → unlimited', () => {
  const r = validateStayLength({ checkIn: '2026-01-01', checkOut: '2026-12-31', bookingType: 'OVERNIGHT', minNights: 1, maxNights: null });
  assert(r.ok === true, 'unlimited accepted', true, r.ok);
});

// ─── 6. Tariff-slab GST boundary cases ──────────────────────────────────
function gstForTariff(rate, cfg = {}) {
  const s1 = cfg.slab1Max ?? 1000;
  const s1r = cfg.slab1Rate ?? 0;
  const s2 = cfg.slab2Max ?? 7500;
  const s2r = cfg.slab2Rate ?? 12;
  const s3r = cfg.slab3Rate ?? 18;
  if (rate <= s1) return s1r;
  if (rate <= s2) return s2r;
  return s3r;
}

T('Case 6A: ₹999 → 0% (under slab 1)', () => assert(gstForTariff(999) === 0, '0%', 0, gstForTariff(999)));
T('Case 6B: ₹1000 → 0% (slab 1 boundary inclusive)', () => assert(gstForTariff(1000) === 0, '0%', 0, gstForTariff(1000)));
T('Case 6C: ₹1001 → 12% (over slab 1)', () => assert(gstForTariff(1001) === 12, '12%', 12, gstForTariff(1001)));
T('Case 6D: ₹7500 → 12% (slab 2 boundary inclusive)', () => assert(gstForTariff(7500) === 12, '12%', 12, gstForTariff(7500)));
T('Case 6E: ₹7501 → 18% (over slab 2)', () => assert(gstForTariff(7501) === 18, '18%', 18, gstForTariff(7501)));
T('Case 6F: Custom slabs (₹5,000 with slabs 0/2,000/10,000 at 5/15/25) → 15%', () => {
  const cfg = { slab1Max: 2000, slab1Rate: 5, slab2Max: 10000, slab2Rate: 15, slab3Rate: 25 };
  assert(gstForTariff(5000, cfg) === 15, 'custom slab 2', 15, gstForTariff(5000, cfg));
});
T('Case 6G: Zero rate → 0%', () => assert(gstForTariff(0) === 0, '0%', 0, gstForTariff(0)));

// ─── 7. Folio recompute math ─────────────────────────────────────────────
function recompute(entries, discount = 0) {
  const subtotal = Math.round(entries.reduce((s, e) => s + e.amount, 0) * 100) / 100;
  const gst = Math.round(entries.reduce((s, e) => s + e.gst, 0) * 100) / 100;
  const grand = Math.max(0, Math.round((subtotal + gst - discount) * 100) / 100);
  return { subtotal, gst, discount, grand };
}

T('Case 7A: 3-night folio with service charge → subtotal + gst sum', () => {
  const entries = [
    { type: 'ROOM_CHARGE', amount: 3000, gst: 360 },
    { type: 'SERVICE_CHARGE', amount: 300, gst: 36 },
    { type: 'ROOM_CHARGE', amount: 3000, gst: 360 },
    { type: 'SERVICE_CHARGE', amount: 300, gst: 36 },
    { type: 'ROOM_CHARGE', amount: 3000, gst: 360 },
    { type: 'SERVICE_CHARGE', amount: 300, gst: 36 },
  ];
  const r = recompute(entries);
  assert(r.subtotal === 9900, 'subtotal', 9900, r.subtotal);
  assert(r.gst === 1188, 'gst', 1188, r.gst);
  assert(r.grand === 11088, 'grand', 11088, r.grand);
});

T('Case 7B: Discount > total → grand floored at 0 (not negative)', () => {
  const r = recompute([{ amount: 100, gst: 12 }], 200);
  assert(r.grand === 0, 'floored', 0, r.grand);
});

T('Case 7C: Folio with one room + late-checkout fee row → both summed', () => {
  const r = recompute([
    { type: 'ROOM_CHARGE', amount: 3000, gst: 360 },
    { type: 'ROOM_CHARGE', amount: 3000, gst: 360 }, // late checkout fee row
  ]);
  assert(r.subtotal === 6000, 'two nights worth', 6000, r.subtotal);
  assert(r.grand === 6720, 'grand 6720', 6720, r.grand);
});

// ─── 8. Date normalisation (the bug we fixed earlier) ────────────────────
function normaliseDateIso(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

T('Case 8A: Date object → YYYY-MM-DD (NOT the broken "Sun May 24")', () => {
  const d = new Date('2026-05-24T00:00:00Z');
  assert(normaliseDateIso(d) === '2026-05-24', 'pg Date object normalised', '2026-05-24', normaliseDateIso(d));
});

T('Case 8B: ISO timestamp string → date portion only', () => {
  assert(normaliseDateIso('2026-05-24T18:30:00.000Z') === '2026-05-24', 'ISO trimmed', '2026-05-24', normaliseDateIso('2026-05-24T18:30:00.000Z'));
});

T('Case 8C: Already YYYY-MM-DD → passes through', () => {
  assert(normaliseDateIso('2026-05-24') === '2026-05-24', 'unchanged', '2026-05-24', normaliseDateIso('2026-05-24'));
});

T('Case 8D: Empty / null → empty string', () => {
  assert(normaliseDateIso(null) === '', 'null', '', normaliseDateIso(null));
  assert(normaliseDateIso('') === '', 'empty', '', normaliseDateIso(''));
});

T('Case 8E: After normalisation, date comparison is sane', () => {
  // The bug — alphabetical compare made "Sun May 24" > "2026-05-20" trip.
  // After normalisation, "2026-05-24" > "2026-05-20" is correctly TRUE.
  const future  = normaliseDateIso(new Date('2026-05-24T00:00:00Z'));
  const today   = '2026-05-20';
  const past    = normaliseDateIso(new Date('2026-05-18T00:00:00Z'));
  assert(future > today, 'future > today', true, future > today);
  assert(past < today, 'past < today', true, past < today);
  assert(today === today, 'today equals itself', true, today === today);
});

// ─── Summary ─────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
if (failed === 0) {
  console.log('  Result: ALL CASES PASSED');
} else {
  console.log(`  Result: FAILED ${failed}`);
}
console.log('═══════════════════════════════════════════════════════════\n');

process.exit(failed === 0 ? 0 : 1);
