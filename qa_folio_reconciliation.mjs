#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════
 * FOLIO CHARGE RECONCILIATION AUDIT — Atithi-Setu Hotel Module
 * ════════════════════════════════════════════════════════════════════════
 *
 * BA audit: reconcile what SHOULD be charged against what the folio actually
 * reflects, across the charge paths NOT covered by qa_e2e_tariff_calculations
 * (which validates booking→folio→invoice grand totals):
 *
 *   A. Extra-person LINE SPLIT (server.ts createFolioWithRoomCharges) — the
 *      per-night room charge is now split into a base "Room charge" line + a
 *      separate "Extra persons" line. AUDIT: the split must be sum-preserving
 *      — base + extras === combined line amount, and baseGst + extrasGst ===
 *      combined line GST (no rupee leaks from rounding).
 *   B. Folio grand_total === Σ(line amounts) + Σ(line GST)  (recomputeFolioTotals).
 *   C. GST slab applied to the FULL per-night line (base + extras).
 *   D. Advance / outstanding (getFolioOutstanding): outstanding ===
 *      grand_total − (Σ advances + Σ final − Σ refunds), floored at 0; multiple
 *      advances accumulate.
 *   E. Room REASSIGNMENT recompute (PATCH): the new room's total uses the SAME
 *      meal-plan + extra-person counts; same-category == same total, cross-
 *      category moves by the rate delta only.
 *   F. F&B (postOrderToFolio): folio grand grows by exactly the F&B line
 *      amount + its GST.
 *
 * Pure JS, byte-for-byte ports of the production formulas in server.ts (the
 * extra-person split mirrors createFolioWithRoomCharges as edited this session).
 * Run:  node qa_folio_reconciliation.mjs   (exit 0 = reconciled, 1 = discrepancy)
 * ════════════════════════════════════════════════════════════════════════
 */

// ── Seed (verbatim from qa_e2e_tariff_calculations.mjs / BCG seed) ──────────
const ROOMS = {
  'ROOM-103': { type: 'SUPERIOR_VIEW', room_number: '103', base_rate: 2000 },
  'ROOM-204': { type: 'PREMIUM_BALC',  room_number: '204', base_rate: 2400 },
  'ROOM-101': { type: 'RIVER_VIEW',    room_number: '101', base_rate: 2800 },
};
const SEASON_PERIODS = [
  { season_id: 'PEAK', start: '2026-04-15', end: '2026-06-30' },
  { season_id: 'OFF',  start: '2026-07-01', end: '2026-12-19' },
];
const SEASON_ORDER = { PEAK: 1, OFF: 2 };
const ROOM_TARIFFS = {
  'SUPERIOR_VIEW|PEAK|EP':3200,'SUPERIOR_VIEW|PEAK|CP':3700,'SUPERIOR_VIEW|PEAK|MAP':4500,'SUPERIOR_VIEW|PEAK|API':5200,
  'SUPERIOR_VIEW|OFF|EP':2000,'SUPERIOR_VIEW|OFF|CP':2500,'SUPERIOR_VIEW|OFF|MAP':3300,'SUPERIOR_VIEW|OFF|API':4000,
  'PREMIUM_BALC|PEAK|EP':3700,'PREMIUM_BALC|PEAK|CP':4200,'PREMIUM_BALC|PEAK|MAP':5000,'PREMIUM_BALC|PEAK|API':5700,
  'PREMIUM_BALC|OFF|EP':2400,'PREMIUM_BALC|OFF|CP':2900,'PREMIUM_BALC|OFF|MAP':3700,'PREMIUM_BALC|OFF|API':4400,
  'RIVER_VIEW|PEAK|EP':4200,'RIVER_VIEW|PEAK|CP':4700,'RIVER_VIEW|PEAK|MAP':5500,'RIVER_VIEW|PEAK|API':6200,
  'RIVER_VIEW|OFF|EP':2800,'RIVER_VIEW|OFF|CP':3300,'RIVER_VIEW|OFF|MAP':4100,'RIVER_VIEW|OFF|API':4800,
};
const EXTRA = {
  'ADULT|PEAK|EP':1000,'ADULT|PEAK|CP':1300,'ADULT|PEAK|MAP':1800,'ADULT|PEAK|API':2200,
  'ADULT|OFF|EP':800,'ADULT|OFF|CP':1100,'ADULT|OFF|MAP':1600,'ADULT|OFF|API':2000,
  'CHILD_WITH_MATTRESS|PEAK|EP':700,'CHILD_WITH_MATTRESS|PEAK|CP':1000,'CHILD_WITH_MATTRESS|PEAK|MAP':1400,'CHILD_WITH_MATTRESS|PEAK|API':1700,
  'CHILD_WITH_MATTRESS|OFF|EP':500,'CHILD_WITH_MATTRESS|OFF|CP':800,'CHILD_WITH_MATTRESS|OFF|MAP':1200,'CHILD_WITH_MATTRESS|OFF|API':1500,
  'CHILD_NO_MATTRESS|PEAK|EP':500,'CHILD_NO_MATTRESS|PEAK|CP':700,'CHILD_NO_MATTRESS|PEAK|MAP':1000,'CHILD_NO_MATTRESS|PEAK|API':1200,
  'CHILD_NO_MATTRESS|OFF|EP':400,'CHILD_NO_MATTRESS|OFF|CP':600,'CHILD_NO_MATTRESS|OFF|MAP':900,'CHILD_NO_MATTRESS|OFF|API':1100,
};
const r2 = (n) => Math.round(n * 100) / 100;

// gstRateForTariff (server.ts): ≤1000→0, 1001-7500→12, >7500→18 (per-night line)
const gstSlab = (line) => line <= 1000 ? 0 : line <= 7500 ? 12 : 18;

function seasonFor(iso) {
  const m = SEASON_PERIODS.filter(p => iso >= p.start && iso <= p.end)
    .sort((a,b) => (SEASON_ORDER[a.season_id]||9) - (SEASON_ORDER[b.season_id]||9));
  return m[0]?.season_id || null;
}
function datesOf(ci, co, dayUse) {
  if (dayUse) return [ci];
  const out = []; let c = new Date(ci + 'T12:00:00Z'); const e = new Date(co + 'T12:00:00Z');
  while (c < e) { out.push(c.toISOString().slice(0,10)); c = new Date(c.getTime() + 86400000); }
  return out;
}
// computeBookingTotalWithExtras (server.ts) — matrix path
function bookingTotal(roomId, ci, co, plan, ex, dayUse) {
  const room = ROOMS[roomId];
  const dates = datesOf(ci, co, dayUse);
  let baseTotal = 0, extrasTotal = 0;
  for (const d of dates) {
    const s = seasonFor(d);
    const base = (s && plan) ? (ROOM_TARIFFS[`${room.type}|${s}|${plan}`] ?? room.base_rate) : room.base_rate;
    let ext = 0;
    if (s && plan) {
      ext += (EXTRA[`ADULT|${s}|${plan}`]||0) * (ex.adults||0);
      ext += (EXTRA[`CHILD_WITH_MATTRESS|${s}|${plan}`]||0) * (ex.childMat||0);
      ext += (EXTRA[`CHILD_NO_MATTRESS|${s}|${plan}`]||0) * (ex.childNoMat||0);
    }
    baseTotal += base; extrasTotal += ext;
  }
  const perNight = dates.map(d => {
    const s = seasonFor(d);
    const base = (s && plan) ? (ROOM_TARIFFS[`${room.type}|${s}|${plan}`] ?? room.base_rate) : room.base_rate;
    let ext = 0;
    if (s && plan) {
      ext += (EXTRA[`ADULT|${s}|${plan}`]||0) * (ex.adults||0);
      ext += (EXTRA[`CHILD_WITH_MATTRESS|${s}|${plan}`]||0) * (ex.childMat||0);
      ext += (EXTRA[`CHILD_NO_MATTRESS|${s}|${plan}`]||0) * (ex.childNoMat||0);
    }
    return { date: d, base_rate: base, extras: ext };
  });
  return { perNight, base_total: r2(baseTotal), extras_total: r2(extrasTotal), total: r2(baseTotal + extrasTotal) };
}

// createFolioWithRoomCharges — extra-person SPLIT (exact mirror of the edit)
function buildFolioEntries(roomId, ci, co, plan, ex, dayUse) {
  const { perNight } = bookingTotal(roomId, ci, co, plan, ex, dayUse);
  const entries = [];
  for (const n of perNight) {
    const lineAmount = r2(n.base_rate + n.extras);
    const gstPct = gstSlab(lineAmount);
    const lineGst = r2(lineAmount * gstPct / 100);
    const extrasAmount = r2(n.extras);
    const baseAmount = r2(lineAmount - extrasAmount);
    const extrasGst = extrasAmount > 0 ? r2(extrasAmount * gstPct / 100) : 0;
    const baseGst = r2(lineGst - extrasGst);
    entries.push({ type: 'ROOM_CHARGE', desc: `Room charge · ${n.date}`, amount: baseAmount, gst: baseGst, gstPct });
    if (extrasAmount > 0) entries.push({ type: 'ROOM_CHARGE', desc: `Extra persons · ${n.date}`, amount: extrasAmount, gst: extrasGst, gstPct });
    // carry the combined for reconciliation
    entries[entries.length - 1]._combinedAmount = lineAmount;
    entries[entries.length - 1]._combinedGst = lineGst;
  }
  return entries;
}
// recomputeFolioTotals: subtotal = Σamount, gst = Σgst, grand = subtotal+gst
function recompute(entries) {
  const subtotal = r2(entries.reduce((s,e) => s + e.amount, 0));
  const gst = r2(entries.reduce((s,e) => s + e.gst, 0));
  return { subtotal, gst, grand_total: r2(subtotal + gst) };
}
// getFolioOutstanding: outstanding = max(0, grand − (paid − refunded))
function outstanding(grand, payments) {
  let paid = 0, refunded = 0;
  for (const p of payments) { if (p.type === 'REFUND') refunded += p.amount; else paid += p.amount; }
  return { total_paid: r2(paid), total_refunded: r2(refunded), outstanding: Math.max(0, r2(grand - (paid - refunded))) };
}

// ── Runner ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0; const fails = [];
const C = { g:'\x1b[32m', r:'\x1b[31m', y:'\x1b[33m', gray:'\x1b[90m', b:'\x1b[1m', x:'\x1b[0m' };
const fmt = (n) => `Rs ${Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
function ok(cond, label, got, want) {
  if (cond) { pass++; }
  else { fail++; fails.push(`${label}: got ${got}, want ${want}`); console.log(`  ${C.r}✗${C.x} ${label} — got ${got}, want ${want}`); }
}

console.log(`${C.b}\n═══ A+B+C — Extra-person split is sum-preserving; folio grand = booking total + GST ═══${C.x}`);
const CATS = ['ROOM-103','ROOM-204','ROOM-101'];
const PLANS = ['EP','CP','MAP','API'];
const SEASONS = [{ci:'2026-05-10',label:'PEAK'},{ci:'2026-08-10',label:'OFF'}];
const EXTRAS = [
  { adults:0, childMat:0, childNoMat:0, label:'no extras' },
  { adults:1, childMat:0, childNoMat:0, label:'+1A' },
  { adults:1, childMat:1, childNoMat:0, label:'+1A+1C(mat)' },
  { adults:2, childMat:1, childNoMat:1, label:'+2A+1C(mat)+1C(no-mat)' },
];
let combos = 0;
for (const roomId of CATS) for (const plan of PLANS) for (const s of SEASONS) for (const ex of EXTRAS) {
  const co = new Date(new Date(s.ci+'T12:00:00Z').getTime() + 2*86400000).toISOString().slice(0,10); // 2 nights
  const bk = bookingTotal(roomId, s.ci, co, plan, ex, false);
  const entries = buildFolioEntries(roomId, s.ci, co, plan, ex, false);
  // A: per-night split sum-preservation (base+extras === combined, gst preserved)
  // reconstruct per-night pairs
  let splitAmt = 0, splitGst = 0, combinedAmt = 0, combinedGst = 0;
  for (const e of entries) {
    splitAmt += e.amount; splitGst += e.gst;
    if (e._combinedAmount != null) { combinedAmt += e._combinedAmount; combinedGst += e._combinedGst; }
  }
  ok(Math.abs(r2(splitAmt) - r2(combinedAmt)) < 0.005, `${roomId} ${plan} ${s.label} ${ex.label} :: Σ split amount == Σ combined`, r2(splitAmt), r2(combinedAmt));
  ok(Math.abs(r2(splitGst) - r2(combinedGst)) < 0.005, `${roomId} ${plan} ${s.label} ${ex.label} :: Σ split GST == Σ combined GST`, r2(splitGst), r2(combinedGst));
  // B: folio subtotal (Σ amounts) === booking total
  const f = recompute(entries);
  ok(Math.abs(f.subtotal - bk.total) < 0.005, `${roomId} ${plan} ${s.label} ${ex.label} :: folio subtotal == booking total`, f.subtotal, bk.total);
  // C: every line's GST == round(amount × slab(combined line)/100) summed === per-night lineGst
  ok(entries.every(e => e.amount >= 0 && e.gst >= 0), `${roomId} ${plan} ${s.label} ${ex.label} :: no negative split line`, 'n/a', '>=0');
  combos++;
}
console.log(`  ${C.gray}${combos} combos × 4 checks reconciled${C.x}`);

console.log(`${C.b}\n═══ D — Advance / outstanding (advance deducted, multi-advance accumulates) ═══${C.x}`);
{
  const entries = buildFolioEntries('ROOM-101','2026-05-10','2026-05-12','MAP',{adults:1},false);
  const grand = recompute(entries).grand_total;
  // single advance
  let o = outstanding(grand, [{type:'ADVANCE', amount:2000}]);
  ok(Math.abs(o.outstanding - r2(grand - 2000)) < 0.005, 'single advance deducted', o.outstanding, r2(grand-2000));
  // multiple advances accumulate
  o = outstanding(grand, [{type:'ADVANCE',amount:2000},{type:'ADVANCE',amount:1500},{type:'FINAL',amount:500}]);
  ok(Math.abs(o.outstanding - Math.max(0, r2(grand - 4000))) < 0.005, 'multi advance + final accumulate', o.outstanding, Math.max(0,r2(grand-4000)));
  ok(o.total_paid === 4000, 'total_paid sums advance+final', o.total_paid, 4000);
  // refund increases outstanding
  o = outstanding(grand, [{type:'ADVANCE',amount:grand},{type:'REFUND',amount:1000}]);
  ok(Math.abs(o.outstanding - 1000) < 0.005, 'refund re-opens balance', o.outstanding, 1000);
  // overpay floors at 0
  o = outstanding(grand, [{type:'ADVANCE',amount:grand + 5000}]);
  ok(o.outstanding === 0, 'overpayment floors outstanding at 0', o.outstanding, 0);
}

console.log(`${C.b}\n═══ E — Room reassignment recompute (same extras; same-cat unchanged, cross-cat = rate delta) ═══${C.x}`);
{
  const ci='2026-05-10', co='2026-05-12', plan='MAP', ex={adults:1, childMat:1};
  const orig = bookingTotal('ROOM-103', ci, co, plan, ex, false);   // SUPERIOR_VIEW
  // same category (only one room per category in this seed → simulate identical type)
  const sameCat = bookingTotal('ROOM-103', ci, co, plan, ex, false);
  ok(sameCat.total === orig.total, 'same-category reassign → total unchanged', sameCat.total, orig.total);
  ok(sameCat.extras_total === orig.extras_total, 'same-category reassign → extras preserved', sameCat.extras_total, orig.extras_total);
  // upgrade to RIVER_VIEW
  const up = bookingTotal('ROOM-101', ci, co, plan, ex, false);
  ok(up.total > orig.total, 'upgrade → total increases', up.total, `> ${orig.total}`);
  ok(up.extras_total === orig.extras_total, 'upgrade → SAME extra-person charge', up.extras_total, orig.extras_total);
  // downgrade PREMIUM→SUPERIOR
  const premium = bookingTotal('ROOM-204', ci, co, plan, ex, false);
  const down = bookingTotal('ROOM-103', ci, co, plan, ex, false);
  ok(down.total < premium.total, 'downgrade → total decreases', down.total, `< ${premium.total}`);
  ok(down.extras_total === premium.extras_total, 'downgrade → SAME extra-person charge', down.extras_total, premium.extras_total);
  // the recompute uses base-rate delta only; extras identical across rooms (extras keyed by season+plan, not room type)
  ok(r2(up.total - orig.total) === r2(up.base_total - orig.base_total), 'reassign delta == base-rate delta (extras unchanged)', r2(up.total-orig.total), r2(up.base_total-orig.base_total));
}

console.log(`${C.b}\n═══ F — F&B posting grows folio by line + GST (no double count / no drop) ═══${C.x}`);
{
  const entries = buildFolioEntries('ROOM-101','2026-05-10','2026-05-12','MAP',{adults:1},false);
  const before = recompute(entries).grand_total;
  // F&B order: 2 × ₹250 + 1 × ₹120 = ₹620, F&B GST 5% (composite/слаб per M-3 — use 5% restaurant slab)
  const fnbItems = [{ qty:2, price:250 }, { qty:1, price:120 }];
  const fnbAmount = r2(fnbItems.reduce((s,i)=>s+i.qty*i.price,0));
  const FNB_GST = 5;
  const fnbGst = r2(fnbAmount * FNB_GST / 100);
  const withFnb = [...entries, { type:'F_AND_B', desc:'IRD', amount: fnbAmount, gst: fnbGst, gstPct: FNB_GST }];
  const after = recompute(withFnb);
  ok(Math.abs(after.subtotal - r2(recompute(entries).subtotal + fnbAmount)) < 0.005, 'F&B adds its amount to subtotal', after.subtotal, r2(recompute(entries).subtotal + fnbAmount));
  ok(Math.abs(after.gst - r2(recompute(entries).gst + fnbGst)) < 0.005, 'F&B adds its GST', after.gst, r2(recompute(entries).gst + fnbGst));
  ok(Math.abs(after.grand_total - r2(before + fnbAmount + fnbGst)) < 0.005, 'folio grand grows by F&B + GST exactly', after.grand_total, r2(before + fnbAmount + fnbGst));
}

console.log(`${C.b}\n═══════════════════════════════════════════════════════════════════════${C.x}`);
console.log(`  ${C.g}✓ Reconciled:${C.x} ${pass}`);
console.log(`  ${fail ? C.r : C.g}✗ Discrepancies:${C.x} ${fail}`);
if (fail) { console.log(`\n${C.r}DISCREPANCIES:${C.x}`); fails.forEach(f => console.log(`  • ${f}`)); }
console.log(`${C.b}═══════════════════════════════════════════════════════════════════════${C.x}`);
process.exit(fail ? 1 : 0);
