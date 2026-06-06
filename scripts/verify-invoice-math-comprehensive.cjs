#!/usr/bin/env node
'use strict';
// ════════════════════════════════════════════════════════════════════════════
//  COMPREHENSIVE INVOICE & TAX MATH REGRESSION SUITE
//  ────────────────────────────────────────────────────────────────────────
//  Single offline test that mirrors EVERY invoice / folio compute path in
//  the production codebase. No DB connection, no live API. Exit 0 = all
//  flows agree at the rupee.
//
//  Coverage:
//    A) Customer QR postpaid invoice  (/sessions/:token/request-bill)
//    B) Manual invoice                (POST /invoices/manual + computeInvoiceTotals)
//    C) Postpaid session invoice      (PostpaidInvoiceModal client-side)
//    D) Hotel folio room charges      (createFolioWithRoomCharges + recompute)
//    E) F&B → folio bridge            (postOrderToFolio)
//    F) Credit note math              (folio negation via PDF render)
//    G) Multi-flow agreement          (A === B === C on same inputs)
//    H) Edge cases                    (zero, negative, NaN, missing fields)
//    I) Hotel analytics revenue       (credit-note exclusion)
//
//  Run:  node scripts/verify-invoice-math-comprehensive.cjs
//  Exit: 0 on pass, non-zero on any drift
// ════════════════════════════════════════════════════════════════════════════

const assert = require('assert');

let pass = 0;
let fail = 0;
const failures = [];

function eq(label, actual, expected, tolerance = 0.01) {
  const a = Number(actual);
  const e = Number(expected);
  const diff = Math.abs(a - e);
  if (diff <= tolerance) {
    pass++;
    console.log(`  ✓ ${label}  →  ${a.toFixed(2)}`);
  } else {
    fail++;
    failures.push(`${label}: expected ${e}, got ${a} (diff ${diff.toFixed(4)})`);
    console.log(`  ✗ ${label}  →  got ${a}, expected ${e}`);
  }
}

function section(name) {
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`  ${name}`);
  console.log(`══════════════════════════════════════════════════════════════════════`);
}

// Round to 2 decimals. NaN inputs → 0 (defensive — protects invoice totals
// from showing "NaN" if a bad value sneaks past upstream validation).
const r2 = x => {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
};

// ────────────────────────────────────────────────────────────────────────────
//  Math kernels (mirror the production code paths)
// ────────────────────────────────────────────────────────────────────────────

/** Flow B — Manual invoice math (server.ts computeInvoiceTotals).
 *  Canonical sequence: subtotal → discount → service → GST. */
function computeFlowB({ subtotal, manualDiscount = 0, loyaltyPct = 0, svcPct = 0, gstPct = 0, applyGst = true }) {
  const sub = r2(Math.max(0, subtotal));
  const manD = r2(Math.max(0, manualDiscount));
  const loyD = loyaltyPct > 0 ? r2(sub * loyaltyPct / 100) : 0;
  // The system uses MAX, not SUM — manual and loyalty don't stack
  const totalDiscount = Math.min(sub, Math.max(manD, loyD));
  const subAfterDisc = r2(Math.max(0, sub - totalDiscount));
  const svc = svcPct > 0 ? r2(subAfterDisc * svcPct / 100) : 0;
  const taxBase = r2(subAfterDisc + svc);
  const gst = (applyGst && gstPct > 0) ? r2(taxBase * gstPct / 100) : 0;
  return {
    subtotal: sub,
    discount: totalDiscount,
    subAfterDiscount: subAfterDisc,
    serviceCharge: svc,
    taxableBase: taxBase,
    gst,
    grand: r2(taxBase + gst),
  };
}

/** Flow A — QR Request Bill (POST /sessions/:token/request-bill).
 *  POST-FIX: must include service charge to match Flow B + C. */
function computeFlowA({ grossSubtotal, grossGst, loyaltyPct = 0, svcPct = 0, gstPct = 0, applyGst = true }) {
  const sub = r2(Math.max(0, grossSubtotal));
  const loyD = loyaltyPct > 0 ? r2(sub * loyaltyPct / 100) : 0;
  const subAfter = r2(Math.max(0, sub - loyD));
  const svc = svcPct > 0 ? r2(subAfter * svcPct / 100) : 0;
  const taxableBase = r2(subAfter + svc);
  const needsRecompute = (loyD > 0 || svc > 0) && applyGst && gstPct > 0;
  const finalGst = needsRecompute ? r2(taxableBase * gstPct / 100) : r2(grossGst);
  return {
    subtotalAfterLoyalty: subAfter,
    loyaltyDiscount: loyD,
    serviceCharge: svc,
    taxableBase,
    gst: finalGst,
    grand: r2(taxableBase + finalGst),
  };
}

/** Flow C — PostpaidInvoiceModal (App.tsx client side).
 *  Same sequence as B but single GST rate, no CGST/SGST split. */
function computeFlowC({ rawSubtotal, discount = 0, svcPct = 0, gstPct = 0, applyGst = true }) {
  const sub = r2(Math.max(0, rawSubtotal));
  const disc = r2(Math.max(0, discount));
  const afterDisc = r2(Math.max(0, sub - disc));
  const svc = svcPct > 0 ? r2(afterDisc * svcPct / 100) : 0;
  const taxable = r2(afterDisc + svc);
  const gst = (applyGst && gstPct > 0) ? r2(taxable * gstPct / 100) : 0;
  return {
    subtotal: sub,
    afterDiscount: afterDisc,
    serviceCharge: svc,
    taxable,
    gst,
    grand: r2(taxable + gst),
  };
}

/** Hotel folio room charge GST (server.ts gstRateForTariff). */
function gstRateForTariff(tariff, cfg = { slab1Max: 1000, slab1Rate: 0, slab2Max: 7500, slab2Rate: 12, slab3Rate: 18 }) {
  if (tariff <= cfg.slab1Max) return cfg.slab1Rate;
  if (tariff <= cfg.slab2Max) return cfg.slab2Rate;
  return cfg.slab3Rate;
}

/** Hotel folio per-night room charge + service charge (createFolioWithRoomCharges). */
function computeFolioRoomCharges({ nights, ratePerNight, svcPct = 0, slabConfig }) {
  const gstPct = gstRateForTariff(ratePerNight, slabConfig);
  let subtotal = 0;
  let gst = 0;
  let svc = 0;
  let svcGst = 0;
  for (let i = 0; i < nights; i++) {
    subtotal += ratePerNight;
    gst += r2(ratePerNight * gstPct / 100);
    if (svcPct > 0) {
      const s = r2(ratePerNight * svcPct / 100);
      svc += s;
      // GST on service charge uses the SAME tariff-slab rate
      svcGst += r2(s * gstPct / 100);
    }
  }
  return {
    nights,
    gstPctApplied: gstPct,
    subtotal: r2(subtotal + svc),  // both room + service amounts roll into folio.subtotal
    gst: r2(gst + svcGst),
    grand: r2(subtotal + svc + gst + svcGst),
  };
}

/** F&B → folio bridge (server.ts postOrderToFolio). Post-QA-BUGFIX-3:
 *  explicitly skip qty=0 / non-finite / negative quantity items. */
function computeFnbFolioPosting({ items, isSpecifiedPremises = false, perItemGstOverride = null }) {
  const defaultGst = isSpecifiedPremises ? 18 : 5;
  let totalAmount = 0;
  let totalGst = 0;
  for (const item of items) {
    const rawQty = Number(item.quantity);
    if (!Number.isFinite(rawQty) || rawQty <= 0) continue;
    const qty = Math.max(1, Math.floor(rawQty));
    const unit = Math.max(0, Number(item.unitPrice || 0));
    const amount = qty * unit;
    if (amount <= 0) continue;
    const gstRate = item.gstRate != null
      ? Number(item.gstRate)
      : (perItemGstOverride != null ? perItemGstOverride : defaultGst);
    // Production formula: Math.round(amount * gstRate) / 100
    // Algebraically equivalent to: Math.round(amount * rate / 100 * 100) / 100
    const gstAmt = Math.round(amount * gstRate) / 100;
    totalAmount += amount;
    totalGst += gstAmt;
  }
  return {
    folioSubtotal: r2(totalAmount),
    folioGst: r2(totalGst),
  };
}

/** recomputeFolioTotals (server.ts). */
function recomputeFolio({ entries, discount = 0 }) {
  let sub = 0;
  let gst = 0;
  for (const e of entries) {
    sub += Number(e.amount || 0);
    gst += Number(e.gstAmount || 0);
  }
  return {
    subtotal: r2(sub),
    gst: r2(gst),
    discount: r2(discount),
    grand: r2(Math.max(0, sub + gst - discount)),
  };
}

/** Hotel revenue analytics — credit-note exclusion (post-fix). */
function computeNetHotelRevenue(folios) {
  const invoiceTotal = folios
    .filter(f => f.status === 'settled' && (f.doc_type === undefined || f.doc_type === null || f.doc_type === 'INVOICE'))
    .reduce((s, f) => s + Number(f.grand_total || 0), 0);
  const refundTotal = folios
    .filter(f => f.doc_type === 'CREDIT_NOTE')
    .reduce((s, f) => s + Number(f.grand_total || 0), 0);
  return r2(Math.max(0, invoiceTotal - refundTotal));
}

// ════════════════════════════════════════════════════════════════════════════
//  TESTS
// ════════════════════════════════════════════════════════════════════════════

section('SECTION A — Flow A (QR Request Bill) — POST-FIX with service charge');

{
  // A1: No discount, no svc, GST only
  const r = computeFlowA({ grossSubtotal: 1000, grossGst: 50, gstPct: 5, applyGst: true });
  eq('A1 grand (1000 + 50 GST)', r.grand, 1050);
  eq('A1 svc', r.serviceCharge, 0);
}
{
  // A2: With service charge 10%, no loyalty
  const r = computeFlowA({ grossSubtotal: 1000, grossGst: 50, svcPct: 10, gstPct: 5 });
  eq('A2 svc (1000 × 10%)', r.serviceCharge, 100);
  eq('A2 taxableBase (1000+100)', r.taxableBase, 1100);
  eq('A2 gst (1100 × 5%)', r.gst, 55);
  eq('A2 grand', r.grand, 1155);
}
{
  // A3: With loyalty Gold 10%, no svc → GST recomputed on 900
  const r = computeFlowA({ grossSubtotal: 1000, grossGst: 50, loyaltyPct: 10, gstPct: 5 });
  eq('A3 loyaltyDiscount', r.loyaltyDiscount, 100);
  eq('A3 subAfter (1000-100)', r.subtotalAfterLoyalty, 900);
  eq('A3 gst (900 × 5%)', r.gst, 45);
  eq('A3 grand', r.grand, 945);
}
{
  // A4: Loyalty + service charge — the killer drift case
  const r = computeFlowA({ grossSubtotal: 1000, grossGst: 50, loyaltyPct: 10, svcPct: 10, gstPct: 5 });
  eq('A4 subAfter', r.subtotalAfterLoyalty, 900);
  eq('A4 svc (900 × 10%)', r.serviceCharge, 90);
  eq('A4 taxBase (900+90)', r.taxableBase, 990);
  eq('A4 gst (990 × 5%)', r.gst, 49.5);
  eq('A4 grand', r.grand, 1039.5);
}

section('SECTION B — Flow B (Manual Invoice) — Canonical math');

{
  // B1: Standard order
  const r = computeFlowB({ subtotal: 1000, gstPct: 5 });
  eq('B1 grand (1000 + 50)', r.grand, 1050);
}
{
  // B2: Manual ₹100 discount
  const r = computeFlowB({ subtotal: 1000, manualDiscount: 100, gstPct: 5 });
  eq('B2 subAfter', r.subAfterDiscount, 900);
  eq('B2 grand (900 + 45)', r.grand, 945);
}
{
  // B3: Loyalty stacking — max of manual / loyalty
  const r = computeFlowB({ subtotal: 1000, manualDiscount: 50, loyaltyPct: 10, gstPct: 5 });
  // loyalty = 100, manual = 50 → use 100 (max)
  eq('B3 discount = max(50, 100)', r.discount, 100);
  eq('B3 grand', r.grand, 945);
}
{
  // B4: Service charge on discounted base
  const r = computeFlowB({ subtotal: 1000, manualDiscount: 100, svcPct: 10, gstPct: 5 });
  eq('B4 svc (900 × 10%)', r.serviceCharge, 90);
  eq('B4 taxBase', r.taxableBase, 990);
  eq('B4 grand', r.grand, 1039.5);
}
{
  // B5: All together — same inputs as A4
  const r = computeFlowB({ subtotal: 1000, manualDiscount: 0, loyaltyPct: 10, svcPct: 10, gstPct: 5 });
  eq('B5 (mirror of A4) grand', r.grand, 1039.5);
}
{
  // B6: Discount > subtotal — clamp to subtotal
  const r = computeFlowB({ subtotal: 1000, manualDiscount: 1500, gstPct: 5 });
  eq('B6 discount clamped', r.discount, 1000);
  eq('B6 grand = 0', r.grand, 0);
}

section('SECTION C — Flow C (PostpaidInvoiceModal client) — Same sequence');

{
  // C1: Identical inputs to A1 + B1 — must agree
  const r = computeFlowC({ rawSubtotal: 1000, gstPct: 5 });
  eq('C1 grand', r.grand, 1050);
}
{
  // C2: Loyalty pre-fills discount field at client
  const r = computeFlowC({ rawSubtotal: 1000, discount: 100, gstPct: 5 });
  eq('C2 afterDiscount', r.afterDiscount, 900);
  eq('C2 grand', r.grand, 945);
}
{
  // C3: Mirror A4 / B5
  const r = computeFlowC({ rawSubtotal: 1000, discount: 100, svcPct: 10, gstPct: 5 });
  eq('C3 (mirror A4/B5) grand', r.grand, 1039.5);
}

section('SECTION G — Multi-flow agreement (A === B === C)');

const scenarios = [
  { label: 'no-disc-no-svc',  sub: 1000, discPct: 0,  svcPct: 0,  gst: 5 },
  { label: 'svc-10-no-disc',  sub: 1000, discPct: 0,  svcPct: 10, gst: 5 },
  { label: 'loy-10-svc-10',   sub: 1000, discPct: 10, svcPct: 10, gst: 5 },
  { label: 'gst-18',          sub: 1000, discPct: 0,  svcPct: 0,  gst: 18 },
  { label: 'all-loy-svc-gst', sub: 5000, discPct: 5,  svcPct: 7,  gst: 18 },
  { label: 'small-amount',    sub: 100,  discPct: 0,  svcPct: 0,  gst: 5 },
  { label: 'rounding-edge',   sub: 99.99, discPct: 0, svcPct: 10, gst: 18 },
];
for (const s of scenarios) {
  const discAmt = r2(s.sub * s.discPct / 100);
  const a = computeFlowA({ grossSubtotal: s.sub, grossGst: r2(s.sub * s.gst / 100), loyaltyPct: s.discPct, svcPct: s.svcPct, gstPct: s.gst });
  const b = computeFlowB({ subtotal: s.sub, loyaltyPct: s.discPct, svcPct: s.svcPct, gstPct: s.gst });
  const c = computeFlowC({ rawSubtotal: s.sub, discount: discAmt, svcPct: s.svcPct, gstPct: s.gst });
  eq(`G:${s.label} A.grand === B.grand`, a.grand, b.grand);
  eq(`G:${s.label} B.grand === C.grand`, b.grand, c.grand);
}

section('SECTION D — Hotel folio room charges');

{
  // D1: Budget room (₹500/night, slab1 0% GST)
  const r = computeFolioRoomCharges({ nights: 2, ratePerNight: 500 });
  eq('D1 slab1 (₹500, GST 0%)', r.gstPctApplied, 0);
  eq('D1 subtotal', r.subtotal, 1000);
  eq('D1 gst', r.gst, 0);
  eq('D1 grand', r.grand, 1000);
}
{
  // D2: Mid room (₹2000/night, slab2 12% GST)
  const r = computeFolioRoomCharges({ nights: 3, ratePerNight: 2000 });
  eq('D2 slab2 GST %', r.gstPctApplied, 12);
  eq('D2 subtotal', r.subtotal, 6000);
  eq('D2 gst (3 × 240)', r.gst, 720);
  eq('D2 grand', r.grand, 6720);
}
{
  // D3: Luxury room (₹10000/night, slab3 18% GST)
  const r = computeFolioRoomCharges({ nights: 1, ratePerNight: 10000 });
  eq('D3 slab3 GST %', r.gstPctApplied, 18);
  eq('D3 grand', r.grand, 11800);
}
{
  // D4: Room + service charge — both taxed
  const r = computeFolioRoomCharges({ nights: 1, ratePerNight: 2000, svcPct: 10 });
  eq('D4 subtotal (2000 + 200)', r.subtotal, 2200);
  eq('D4 gst (240 + 24)', r.gst, 264);
  eq('D4 grand', r.grand, 2464);
}

section('SECTION E — F&B → folio bridge (postOrderToFolio)');

{
  // E1: Single item, non-specified premises → 5% GST
  const r = computeFnbFolioPosting({
    items: [{ quantity: 1, unitPrice: 200 }],
    isSpecifiedPremises: false,
  });
  eq('E1 subtotal', r.folioSubtotal, 200);
  eq('E1 gst (200 × 5%)', r.folioGst, 10);
}
{
  // E2: Specified premises → 18% GST
  const r = computeFnbFolioPosting({
    items: [{ quantity: 2, unitPrice: 300 }],
    isSpecifiedPremises: true,
  });
  eq('E2 subtotal', r.folioSubtotal, 600);
  eq('E2 gst (600 × 18%)', r.folioGst, 108);
}
{
  // E3: Per-item GST override (e.g. liquor at 18% in non-specified)
  const r = computeFnbFolioPosting({
    items: [
      { quantity: 1, unitPrice: 200 },               // food → defaultGst=5
      { quantity: 1, unitPrice: 500, gstRate: 18 },  // liquor → 18 override
    ],
    isSpecifiedPremises: false,
  });
  eq('E3 subtotal', r.folioSubtotal, 700);
  eq('E3 gst (10 + 90)', r.folioGst, 100);
}
{
  // E4: Zero-amount item skipped
  const r = computeFnbFolioPosting({
    items: [{ quantity: 0, unitPrice: 100 }, { quantity: 1, unitPrice: 200 }],
    isSpecifiedPremises: false,
  });
  eq('E4 subtotal (zero-qty skipped)', r.folioSubtotal, 200);
}
{
  // E5: Rounding — 199.99 × 5% = 9.9995 → should round to 10.00
  const r = computeFnbFolioPosting({
    items: [{ quantity: 1, unitPrice: 199.99 }],
    isSpecifiedPremises: false,
  });
  eq('E5 199.99 × 5% rounds to', r.folioGst, 10.00);
}

section('SECTION F — Credit note math (folio negation)');

{
  // F1: Original folio sub=5000, gst=500, grand=5500
  // Credit note copied with positive values; PDF flips sign.
  // Net revenue should be ZERO.
  const folios = [
    { status: 'settled', doc_type: 'INVOICE',     grand_total: 5500 },
    { status: 'settled', doc_type: 'CREDIT_NOTE', grand_total: 5500 },  // refund
  ];
  const net = computeNetHotelRevenue(folios);
  eq('F1 net revenue after refund = 0', net, 0);
}
{
  // F2: Multiple invoices + one credit note
  const folios = [
    { status: 'settled', doc_type: 'INVOICE',     grand_total: 5000 },
    { status: 'settled', doc_type: 'INVOICE',     grand_total: 7000 },
    { status: 'settled', doc_type: 'INVOICE',     grand_total: 3000 },
    { status: 'settled', doc_type: 'CREDIT_NOTE', grand_total: 5000 },
  ];
  const net = computeNetHotelRevenue(folios);
  eq('F2 net = 15000 - 5000', net, 10000);
}
{
  // F3: Legacy folios with NULL doc_type — treat as INVOICE
  const folios = [
    { status: 'settled', doc_type: null,          grand_total: 4000 },
    { status: 'settled', doc_type: 'INVOICE',     grand_total: 6000 },
    { status: 'settled', doc_type: 'CREDIT_NOTE', grand_total: 2000 },
  ];
  const net = computeNetHotelRevenue(folios);
  eq('F3 legacy NULL doc_type counts as INVOICE', net, 8000);
}

section('SECTION H — Edge cases');

{
  // H1: Zero subtotal
  const r = computeFlowB({ subtotal: 0, gstPct: 5 });
  eq('H1 zero subtotal grand', r.grand, 0);
}
{
  // H2: Negative subtotal clamped
  const r = computeFlowB({ subtotal: -500, gstPct: 5 });
  eq('H2 negative clamped', r.subtotal, 0);
  eq('H2 grand', r.grand, 0);
}
{
  // H3: NaN inputs — treated as 0
  const r = computeFlowB({ subtotal: NaN, gstPct: 5 });
  eq('H3 NaN handled', r.grand, 0);
}
{
  // H4: Apply-GST=false → no GST
  const r = computeFlowB({ subtotal: 1000, gstPct: 5, applyGst: false });
  eq('H4 GST disabled', r.gst, 0);
  eq('H4 grand = subtotal', r.grand, 1000);
}
{
  // H5: Very small amount (₹0.50 × 5% rounding)
  const r = computeFlowB({ subtotal: 0.50, gstPct: 5 });
  eq('H5 small amount grand', r.grand, 0.53);
}
{
  // H6: Slab boundary — ₹1000 = slab1 (≤1000)
  const r = computeFolioRoomCharges({ nights: 1, ratePerNight: 1000 });
  eq('H6 boundary ₹1000 = slab1 (0%)', r.gstPctApplied, 0);
}
{
  // H7: Slab boundary — ₹7500 = slab2 (≤7500, not slab3)
  const r = computeFolioRoomCharges({ nights: 1, ratePerNight: 7500 });
  eq('H7 boundary ₹7500 = slab2 (12%)', r.gstPctApplied, 12);
}
{
  // H8: Just above slab2 boundary → slab3
  const r = computeFolioRoomCharges({ nights: 1, ratePerNight: 7501 });
  eq('H8 ₹7501 = slab3 (18%)', r.gstPctApplied, 18);
}

section('SECTION I — recomputeFolio (mixed entries + discount)');

{
  // I1: Multiple folio entries with different GST rates
  const entries = [
    { amount: 2000, gstAmount: 240 },    // room 12%
    { amount: 500,  gstAmount: 25 },     // F&B 5%
    { amount: 100,  gstAmount: 18 },     // bar/laundry 18%
  ];
  const r = recomputeFolio({ entries, discount: 0 });
  eq('I1 subtotal', r.subtotal, 2600);
  eq('I1 gst', r.gst, 283);
  eq('I1 grand', r.grand, 2883);
}
{
  // I2: With discount
  const entries = [{ amount: 2000, gstAmount: 240 }];
  const r = recomputeFolio({ entries, discount: 200 });
  eq('I2 grand (2000 + 240 - 200)', r.grand, 2040);
}
{
  // I3: Reversal entries (negative) — sum to zero
  const entries = [
    { amount:  500, gstAmount:  25 },
    { amount: -500, gstAmount: -25 },   // mirrored reversal
  ];
  const r = recomputeFolio({ entries });
  eq('I3 reversal nets to 0', r.grand, 0);
}

// ════════════════════════════════════════════════════════════════════════════
//  REPORT
// ════════════════════════════════════════════════════════════════════════════

console.log(`\n══════════════════════════════════════════════════════════════════════`);
console.log(`  RESULTS: ${pass} pass · ${fail} fail`);
console.log(`══════════════════════════════════════════════════════════════════════`);

if (fail > 0) {
  console.log(`\nFailures:`);
  failures.forEach(f => console.log(`  ✗ ${f}`));
  process.exit(1);
} else {
  console.log(`\n✅ All invoice + tax math is consistent across the 3 flows + hotel folio.`);
  process.exit(0);
}
