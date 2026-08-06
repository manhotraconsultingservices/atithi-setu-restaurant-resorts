#!/usr/bin/env node
// Offline math mirror for the event billing engine (server.ts computeEventBill +
// assembleEventQuoteLines). Verifies the three production fixes:
//   1. GST is charged AFTER discount (on the net, discounted base).
//   2. GST allocation is correct (proportional per line, per rate).
//   3. Multi-day / multi-hour: rental + service lines multiply by the event span
//      (days for DAILY, hours for HOURLY), venue already carries its per-day sum.
// The formulas below are copied verbatim from server.ts so a divergence here
// signals a divergence there. Zero deps, self-contained, exits non-zero on fail.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ── mirror: eventUnits(bk) ──────────────────────────────────────────────────
function eventUnits(bk) {
  const basis = String(bk?.venue_rate_basis || 'DAILY').toUpperCase();
  if (basis === 'HALF_DAY') return 1;
  if (basis === 'HOURLY') {
    const toMin = (t) => { const [h, m] = String(t ?? '').split(':'); const H = Number(h), M = Number(m); return (Number.isFinite(H) ? H : 0) * 60 + (Number.isFinite(M) ? M : 0); };
    const mins = toMin(bk?.end_time) - toMin(bk?.start_time);
    return mins > 0 ? Math.max(1, Math.round(mins / 60)) : 1;
  }
  const ymd = (v) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);
  const s = ymd(bk?.event_date);
  const e = bk?.end_date ? ymd(bk.end_date) : s;
  if (!s || !e || e <= s) return 1;
  const days = Math.round((Date.parse(e + 'T00:00:00Z') - Date.parse(s + 'T00:00:00Z')) / 86400000) + 1;
  return Math.max(1, days);
}
function rentalUnits(line, units) {
  const dur = Number(line?.duration_units || 1);
  return dur > 1 ? dur : Math.max(1, units);
}

// ── mirror: computeEventBill(db, bookingId) — pure over a booking object ──────
function computeEventBill(bk, evGst) {
  const units = eventUnits(bk);
  const taxable = [];
  const venueRate = Number(bk.venue_rate || 0);
  if (venueRate > 0) taxable.push({ amt: round2(venueRate), rate: evGst });
  for (const it of bk.items || [])
    taxable.push({ amt: round2(Number(it.unit_rate || 0) * Number(it.quantity || 1) * rentalUnits(it, units)), rate: evGst });
  for (const s of bk.services || [])
    taxable.push({ amt: round2(Number(s.unit_rate || 0) * Number(s.quantity || 1) * Math.max(1, units)), rate: evGst });
  for (const c of bk.catering || [])
    taxable.push({ amt: round2(Number(c.line_total || 0)), rate: evGst });
  for (const rm of bk.rooms || [])
    taxable.push({ amt: round2(Number(rm.line_total || 0)), rate: Number(rm.gst_percent ?? 12) });
  const subtotal = round2(taxable.reduce((sum, t) => sum + t.amt, 0));
  const discount = round2(Math.min(Math.max(0, Number(bk.discount || 0)), subtotal));
  const netFactor = subtotal > 0 ? (subtotal - discount) / subtotal : 1;
  const tax = round2(taxable.reduce((sum, t) => sum + round2(t.amt * netFactor * t.rate / 100), 0));
  const grand = round2((subtotal - discount) + tax);
  return { subtotal, tax, discount, grand };
}

// ── mirror: assembleEventQuoteLines(db, bk) — pure ────────────────────────────
function assembleEventQuoteLines(bk, evGst) {
  const lines = [];
  const units = eventUnits(bk);
  if (Number(bk.venue_rate || 0) > 0) {
    const amt = round2(bk.venue_rate);
    lines.push({ amount: amt, gst_rate: evGst, gst_amount: 0 });
  }
  for (const it of bk.items || []) {
    const dur = rentalUnits(it, units);
    lines.push({ amount: round2(Number(it.unit_rate || 0) * Number(it.quantity || 1) * dur), gst_rate: evGst, gst_amount: 0 });
  }
  for (const s of bk.services || []) {
    const su = Math.max(1, units);
    lines.push({ amount: round2(Number(s.unit_rate || 0) * Number(s.quantity || 1) * su), gst_rate: evGst, gst_amount: 0 });
  }
  for (const c of bk.catering || [])
    lines.push({ amount: round2(Number(c.line_total || 0)), gst_rate: evGst, gst_amount: 0 });
  for (const rm of bk.rooms || [])
    lines.push({ amount: round2(Number(rm.line_total || 0)), gst_rate: Number(rm.gst_percent ?? 12), gst_amount: 0 });
  const subtotal = round2(lines.reduce((s, l) => s + Number(l.amount || 0), 0));
  const discount = round2(Math.min(Math.max(0, Number(bk.discount || 0)), subtotal));
  const netFactor = subtotal > 0 ? (subtotal - discount) / subtotal : 1;
  for (const l of lines) l.gst_amount = round2(Number(l.amount) * netFactor * Number(l.gst_rate) / 100);
  const tax = round2(lines.reduce((s, l) => s + Number(l.gst_amount || 0), 0));
  const grand = round2((subtotal - discount) + tax);
  return { lines, subtotal, tax, discount, grand };
}

let pass = 0, fail = 0;
const approx = (a, b) => Math.abs(Number(a) - Number(b)) < 0.02;
function check(name, got, want) {
  if (approx(got, want)) { pass++; console.log(`  ✓ ${name}: ${got}`); }
  else { fail++; console.error(`  ✗ ${name}: got ${got}, want ${want}`); }
}
// The two engines MUST agree exactly on every case (booking screen == invoice).
function agree(name, bk, gst) {
  const a = computeEventBill(bk, gst);
  const b = assembleEventQuoteLines(bk, gst);
  if (approx(a.subtotal, b.subtotal) && approx(a.tax, b.tax) && approx(a.discount, b.discount) && approx(a.grand, b.grand)) {
    pass++; console.log(`  ✓ ${name} — engines agree (sub ${a.subtotal} / tax ${a.tax} / disc ${a.discount} / grand ${a.grand})`);
  } else {
    fail++; console.error(`  ✗ ${name} — MISMATCH bill=${JSON.stringify(a)} quote=${JSON.stringify(b)}`);
  }
  return a;
}

console.log('\n=== Event Billing Math (offline mirror) ===\n');

// 1) GST AFTER discount — single venue line, 18% GST, 10% discount.
console.log('TC-EVT-BILL-GST-AFTER-DISCOUNT');
{
  const bk = { venue_rate_basis: 'DAILY', event_date: '2026-09-01', venue_rate: 100000, discount: 10000, items: [], services: [], catering: [], rooms: [] };
  const r = agree('venue 100000, disc 10000, gst 18%', bk, 18);
  check('subtotal', r.subtotal, 100000);
  check('discount', r.discount, 10000);
  check('tax = (100000-10000)*18%', r.tax, 16200);      // NOT 18000 (old pre-discount bug)
  check('grand = 90000 + 16200', r.grand, 106200);      // NOT 108000
}

// 2) Multi-day DAILY — venue already summed per day; rentals + services ×3 days.
console.log('\nTC-EVT-BILL-MULTIDAY');
{
  const bk = {
    venue_rate_basis: 'DAILY', event_date: '2026-09-10', end_date: '2026-09-12', // 3 inclusive days
    venue_rate: 105000, // 35000/day × 3 (resolveVenueCharge already did this)
    items: [{ unit_rate: 50, quantity: 100, duration_units: 1 }],   // 100 chairs → ×3 days
    services: [{ unit_rate: 10000, quantity: 1 }],                  // DJ → ×3 days
    catering: [{ line_total: 60000 }],                              // per-plate, NOT ×days
    rooms: [], discount: 0,
  };
  const r = agree('3-day: venue 105000 + chairs 15000 + DJ 30000 + catering 60000', bk, 18);
  check('units=3', eventUnits(bk), 3);
  check('subtotal 105000+15000+30000+60000', r.subtotal, 210000);
  check('tax 18%', r.tax, 37800);
  check('grand', r.grand, 247800);
}

// 3) HOURLY — 5-hour event multiplies rentals + services by 5 hours.
console.log('\nTC-EVT-BILL-HOURLY');
{
  const bk = {
    venue_rate_basis: 'HOURLY', event_date: '2026-09-05', start_time: '10:00', end_time: '15:00', // 5h
    venue_rate: 25000, // resolveVenueCharge hourly total
    items: [{ unit_rate: 2000, quantity: 1, duration_units: 1 }], // sound system → ×5h
    services: [], catering: [], rooms: [], discount: 0,
  };
  const r = agree('5h: venue 25000 + sound 2000×5', bk, 18);
  check('units=5', eventUnits(bk), 5);
  check('subtotal 25000 + 10000', r.subtotal, 35000);
  check('grand (×1.18)', r.grand, 41300);
}

// 4) HALF_DAY — span = 1 (no multiplication).
console.log('\nTC-EVT-BILL-HALFDAY');
{
  const bk = {
    venue_rate_basis: 'HALF_DAY', event_date: '2026-09-07', half_day_slot: 'AM',
    venue_rate: 20000,
    items: [{ unit_rate: 50, quantity: 100, duration_units: 1 }], // ×1
    services: [{ unit_rate: 5000, quantity: 1 }],                 // ×1
    catering: [], rooms: [], discount: 0,
  };
  const r = agree('half-day: venue 20000 + chairs 5000 + svc 5000', bk, 18);
  check('units=1', eventUnits(bk), 1);
  check('subtotal', r.subtotal, 30000);
  check('grand', r.grand, 35400);
}

// 5) Explicit rental duration_units>1 wins over event span.
console.log('\nTC-EVT-BILL-EXPLICIT-DURATION');
{
  const bk = {
    venue_rate_basis: 'DAILY', event_date: '2026-09-10', end_date: '2026-09-12', // 3 days
    venue_rate: 0,
    items: [{ unit_rate: 1000, quantity: 1, duration_units: 2 }], // explicit 2 wins, NOT 3
    services: [], catering: [], rooms: [], discount: 0,
  };
  const r = agree('explicit duration 2 beats span 3', bk, 18);
  check('rental amount 1000×2', r.subtotal, 2000);
}

// 6) Mixed GST rates (rooms 12%) with discount — allocation stays per-rate on net.
console.log('\nTC-EVT-BILL-MIXED-RATES-DISCOUNT');
{
  const bk = {
    venue_rate_basis: 'DAILY', event_date: '2026-09-01',
    venue_rate: 100000,                 // 18%
    items: [], services: [], catering: [],
    rooms: [{ line_total: 50000, gst_percent: 12 }], // 12%
    discount: 15000,                    // 10% of 150000 subtotal
  };
  const r = agree('venue 100000@18 + room 50000@12, disc 15000', bk, 18);
  check('subtotal', r.subtotal, 150000);
  check('discount', r.discount, 15000);
  // net factor = 135000/150000 = 0.9 → tax = 100000*0.9*0.18 + 50000*0.9*0.12
  //            = 16200 + 5400 = 21600
  check('tax on net, per rate', r.tax, 21600);
  check('grand', r.grand, 156600);
}

// 7) GST disabled (override 0) — no tax, discount still applies.
console.log('\nTC-EVT-BILL-GST-DISABLED');
{
  const bk = { venue_rate_basis: 'DAILY', event_date: '2026-09-01', venue_rate: 100000, discount: 10000, items: [], services: [], catering: [], rooms: [] };
  const r = agree('gst 0%', bk, 0);
  check('tax 0', r.tax, 0);
  check('grand = subtotal - discount', r.grand, 90000);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
