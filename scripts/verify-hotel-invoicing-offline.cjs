#!/usr/bin/env node
/**
 * Hotel Invoicing Verification — Offline + Live API Contract
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reproduces createFolioWithRoomCharges() and recomputeFolioTotals() from
 * server.ts to verify the Phase H2 tax math:
 *   • Tariff-slab GST (configurable per-tenant)
 *   • Service charge applied to room nights only
 *   • GST on (room rate + service charge) when service charge > 0
 *
 * Run:
 *   node scripts/verify-hotel-invoicing-offline.cjs
 *   node scripts/verify-hotel-invoicing-offline.cjs --live  (also pings prod)
 */
'use strict';

const assert = (cond, label, expected, got) => {
  const ok = cond;
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${got} = ${expected}`);
  if (!ok) { process.exitCode = 1; }
};

// ─── Math kernel — mirrors server.ts ────────────────────────────────────────
function gstRateForTariff(tariff, cfg) {
  const slab1Max  = cfg?.slab1Max  ?? 1000;
  const slab1Rate = cfg?.slab1Rate ?? 0;
  const slab2Max  = cfg?.slab2Max  ?? 7500;
  const slab2Rate = cfg?.slab2Rate ?? 12;
  const slab3Rate = cfg?.slab3Rate ?? 18;
  if (tariff <= slab1Max) return slab1Rate;
  if (tariff <= slab2Max) return slab2Rate;
  return slab3Rate;
}

function round2(n) { return Math.round(n * 100) / 100; }

/** Returns the full folio: entries[] + totals — mirroring the server. */
function buildFolio({ nights, roomRate, cfg }) {
  const entries = [];
  const gstPct = gstRateForTariff(roomRate, cfg);
  const svcPct = cfg?.serviceChargePct ?? 0;
  const svcPerNight = round2(roomRate * svcPct / 100);

  for (let i = 0; i < nights; i++) {
    const roomGst = round2(roomRate * gstPct / 100);
    entries.push({ type: 'ROOM_CHARGE', amount: roomRate, gstPct, gstAmt: roomGst });
    if (svcPct > 0 && svcPerNight > 0) {
      const svcGst = round2(svcPerNight * gstPct / 100);
      entries.push({ type: 'SERVICE_CHARGE', amount: svcPerNight, gstPct, gstAmt: svcGst });
    }
  }
  // recomputeFolioTotals: subtotal = SUM(amount); gst = SUM(gst_amount);
  // grand = subtotal + gst - discount.
  const subtotal = round2(entries.reduce((s, e) => s + e.amount, 0));
  const gst      = round2(entries.reduce((s, e) => s + e.gstAmt, 0));
  const grand    = round2(subtotal + gst);
  return { entries, subtotal, gst, grand, gstPct, svcPct, svcPerNight };
}

// ─── Test suite ─────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
console.log('  Hotel Invoicing — Offline Math Verification');
console.log('═══════════════════════════════════════════════════════════\n');

console.log('Case 1: Budget room (₹800/night × 2 nights) — slab 1 exempt');
{
  const r = buildFolio({ nights: 2, roomRate: 800, cfg: undefined /* defaults */ });
  assert(r.gstPct === 0, '0% GST (slab 1 exempt)', 0, r.gstPct);
  assert(r.entries.length === 2, '2 entries (room only)', 2, r.entries.length);
  assert(r.entries.every(e => e.type === 'ROOM_CHARGE'), 'all ROOM_CHARGE', true, r.entries.every(e => e.type === 'ROOM_CHARGE'));
  assert(r.subtotal === 1600, 'subtotal 800×2', 1600, r.subtotal);
  assert(r.gst === 0, 'gst 0', 0, r.gst);
  assert(r.grand === 1600, 'grand 1600', 1600, r.grand);
}

console.log('\nCase 2: Mid-tariff room (₹3,000/night × 3 nights) — slab 2 @ 12%');
{
  const r = buildFolio({ nights: 3, roomRate: 3000, cfg: undefined });
  assert(r.gstPct === 12, '12% GST (slab 2)', 12, r.gstPct);
  assert(r.entries.length === 3, '3 room entries', 3, r.entries.length);
  assert(r.subtotal === 9000, 'subtotal 3000×3', 9000, r.subtotal);
  assert(r.gst === 1080, 'gst 12% of 9000', 1080, r.gst);
  assert(r.grand === 10080, 'grand 10080', 10080, r.grand);
}

console.log('\nCase 3: Luxury suite (₹10,000/night × 2 nights) — slab 3 @ 18%');
{
  const r = buildFolio({ nights: 2, roomRate: 10000, cfg: undefined });
  assert(r.gstPct === 18, '18% GST (slab 3)', 18, r.gstPct);
  assert(r.subtotal === 20000, 'subtotal 10000×2', 20000, r.subtotal);
  assert(r.gst === 3600, 'gst 18% of 20000', 3600, r.gst);
  assert(r.grand === 23600, 'grand 23600', 23600, r.grand);
}

console.log('\nCase 4: Service charge 10% on ₹3,000/night × 2 nights');
{
  const r = buildFolio({ nights: 2, roomRate: 3000, cfg: { serviceChargePct: 10 } });
  assert(r.gstPct === 12, '12% GST', 12, r.gstPct);
  assert(r.svcPct === 10, 'service charge 10%', 10, r.svcPct);
  assert(r.svcPerNight === 300, 'service ₹300/night (10% of 3000)', 300, r.svcPerNight);
  assert(r.entries.length === 4, '2 room + 2 service entries', 4, r.entries.length);
  const roomCount = r.entries.filter(e => e.type === 'ROOM_CHARGE').length;
  const svcCount  = r.entries.filter(e => e.type === 'SERVICE_CHARGE').length;
  assert(roomCount === 2, '2 ROOM_CHARGE rows', 2, roomCount);
  assert(svcCount === 2, '2 SERVICE_CHARGE rows', 2, svcCount);
  // Subtotal: (3000 + 300) × 2 = 6600
  assert(r.subtotal === 6600, 'subtotal 6600', 6600, r.subtotal);
  // GST: (3000 × 12% + 300 × 12%) × 2 = (360 + 36) × 2 = 792
  assert(r.gst === 792, 'gst 12% of 6600', 792, r.gst);
  assert(r.grand === 7392, 'grand 7392', 7392, r.grand);
}

console.log('\nCase 5: Service charge on budget room (₹800/night, 10% svc) — 0% GST');
{
  const r = buildFolio({ nights: 1, roomRate: 800, cfg: { serviceChargePct: 10 } });
  assert(r.gstPct === 0, 'slab 1 → 0% GST', 0, r.gstPct);
  assert(r.svcPerNight === 80, 'service ₹80', 80, r.svcPerNight);
  // Service charge taxable under slab 1, so its GST is also 0
  assert(r.entries.length === 2, '1 room + 1 service', 2, r.entries.length);
  assert(r.subtotal === 880, 'subtotal 880', 880, r.subtotal);
  assert(r.gst === 0, 'gst 0', 0, r.gst);
  assert(r.grand === 880, 'grand 880', 880, r.grand);
}

console.log('\nCase 6: Slab boundary — rate exactly at slab 1 max (₹1,000)');
{
  const r = buildFolio({ nights: 1, roomRate: 1000, cfg: undefined });
  // tariff <= slab1Max → slab1Rate. ₹1,000 sits in slab 1 (0%).
  assert(r.gstPct === 0, '₹1000 → slab 1 boundary inclusive', 0, r.gstPct);
}

console.log('\nCase 7: Slab boundary — ₹1,001 hits slab 2');
{
  const r = buildFolio({ nights: 1, roomRate: 1001, cfg: undefined });
  assert(r.gstPct === 12, '₹1001 → slab 2', 12, r.gstPct);
}

console.log('\nCase 8: Slab boundary — ₹7,500 inclusive in slab 2');
{
  const r = buildFolio({ nights: 1, roomRate: 7500, cfg: undefined });
  assert(r.gstPct === 12, '₹7500 → slab 2 inclusive', 12, r.gstPct);
}

console.log('\nCase 9: Custom slabs (property opts out of standard rates)');
{
  const r = buildFolio({
    nights: 2, roomRate: 5000,
    cfg: { slab1Max: 2000, slab1Rate: 5, slab2Max: 10000, slab2Rate: 15, slab3Rate: 25 },
  });
  assert(r.gstPct === 15, '5000 fits in custom slab 2 → 15%', 15, r.gstPct);
  assert(r.subtotal === 10000, 'subtotal 5000×2', 10000, r.subtotal);
  assert(r.gst === 1500, 'gst 15% of 10000', 1500, r.gst);
}

console.log('\nCase 10: Late checkout fee folio entry — uses same slab as room');
{
  // After the original 2-night stay, late checkout adds 1 extra ROOM_CHARGE
  // line at the room rate, GST per the same slab.
  const baseFolio = buildFolio({ nights: 2, roomRate: 3000, cfg: { serviceChargePct: 10 } });
  // Simulate the late-fee addition (one extra room night at same rate)
  const lateGst = round2(3000 * 12 / 100);
  baseFolio.entries.push({ type: 'ROOM_CHARGE', amount: 3000, gstPct: 12, gstAmt: lateGst });
  const newSubtotal = round2(baseFolio.entries.reduce((s, e) => s + e.amount, 0));
  const newGst      = round2(baseFolio.entries.reduce((s, e) => s + e.gstAmt, 0));
  // Original (3000+300)×2 + 3000 = 6600 + 3000 = 9600
  assert(newSubtotal === 9600, 'subtotal after late fee', 9600, newSubtotal);
  // Original 792 + 360 = 1152
  assert(newGst === 1152, 'gst after late fee', 1152, newGst);
}

console.log('\nCase 11: 0% service charge → no SERVICE_CHARGE rows (legacy behaviour)');
{
  const r = buildFolio({ nights: 3, roomRate: 5000, cfg: { serviceChargePct: 0 } });
  assert(r.entries.every(e => e.type === 'ROOM_CHARGE'), 'no SERVICE_CHARGE entries', true, r.entries.every(e => e.type === 'ROOM_CHARGE'));
  assert(r.entries.length === 3, 'just 3 room nights', 3, r.entries.length);
  assert(r.subtotal === 15000, 'subtotal 5000×3', 15000, r.subtotal);
  assert(r.gst === 1800, 'gst 12% of 15000', 1800, r.gst);
}

console.log('\nCase 12: Day-use booking (1 night × rate) — slab 2');
{
  const r = buildFolio({ nights: 1, roomRate: 2500, cfg: { serviceChargePct: 5 } });
  assert(r.gstPct === 12, '12% GST', 12, r.gstPct);
  assert(r.svcPerNight === 125, 'service ₹125 (5% of 2500)', 125, r.svcPerNight);
  assert(r.subtotal === 2625, 'subtotal 2625', 2625, r.subtotal);
  // GST: (2500 + 125) × 12% = 2625 × 12% = 315
  assert(r.gst === 315, 'gst 315', 315, r.gst);
  assert(r.grand === 2940, 'grand 2940', 2940, r.grand);
}

console.log('\n═══════════════════════════════════════════════════════════');
if (process.exitCode) {
  console.log(`  Result: FAILED — see ✗ above`);
} else {
  console.log(`  Result: ALL CASES PASSED`);
}
console.log('═══════════════════════════════════════════════════════════\n');

// ─── Optional: live API contract check ──────────────────────────────────────
if (process.argv.includes('--live')) {
  const https = require('https');
  console.log('Pinging production /api/version to confirm marker…');
  https.get('https://app.atithi-setu.com/api/version', (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      const m = body.match(/"commit_marker":"([^"]+)"/);
      console.log(`  Prod marker: ${m ? m[1] : 'unknown'}`);
      console.log(`  Expected:    hotel-tax-slabs-and-service-charge`);
      if (m && m[1] === 'hotel-tax-slabs-and-service-charge') {
        console.log('  ✓ Production is on the latest build.\n');
      } else {
        console.log('  ✗ Prod marker mismatch.\n');
        process.exitCode = 1;
      }
    });
  }).on('error', (e) => {
    console.error('  ✗ Could not reach production:', e.message);
    process.exitCode = 1;
  });
}
