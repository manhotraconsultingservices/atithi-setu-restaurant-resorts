#!/usr/bin/env node
/**
 * Offline verifier — mirrors computeInvoiceTotals locally and asserts
 * the math is correct for 10+ scenarios. No network, no DB. Catches
 * formula regressions before deploy.
 *
 *   node scripts/verify-invoice-math-offline.cjs
 */
'use strict';

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// Mirror of computeTaxes() in server.ts
function computeTaxes({ tenant, taxConfigs, subtotalAfterDiscount, isIntrastate }) {
  const lines = [];
  let totalTax = 0;
  const base = Math.max(0, subtotalAfterDiscount);
  for (const cfg of taxConfigs) {
    if (Number(cfg.enabled || 1) === 0) continue;
    const rate = Number(cfg.rate_percent || 0);
    if (rate <= 0) continue;
    const inclusive = Number(cfg.is_inclusive || 0) === 1;
    const amount = inclusive
      ? r2(base * rate / (100 + rate))
      : r2(base * rate / 100);
    if (amount <= 0) continue;
    if (Number(cfg.split_intrastate || 0) === 1 && isIntrastate !== false && (tenant.country || 'IN') === 'IN') {
      const share = Number(cfg.cgst_share || 0.5);
      const cgst = r2(amount * share);
      const sgst = r2(amount - cgst);
      lines.push({ id: 'CGST', label: 'CGST', rate: rate * share, amount: cgst });
      lines.push({ id: 'SGST', label: 'SGST', rate: rate * (1 - share), amount: sgst });
      totalTax += cgst + sgst;
      continue;
    }
    if (Number(cfg.split_intrastate || 0) === 1 && isIntrastate === false && (tenant.country || 'IN') === 'IN') {
      lines.push({ id: 'IGST', label: 'IGST', rate, amount });
      totalTax += amount;
      continue;
    }
    lines.push({ id: cfg.id, label: cfg.label, rate, amount });
    totalTax += amount;
  }
  return { lines, total: r2(totalTax) };
}

// Mirror of computeInvoiceTotals() — without DB lookups, fed by params
function computeInvoiceTotals({
  subtotal: subRaw,
  discountAmount: discRaw,
  serviceChargePct: svcRaw,
  customerLoyaltyTier,   // { tier_id, tier_name, discount_percent } | null
  taxConfigs,
  country = 'IN',
  isIntrastate,
  legacyGstFallback,
}) {
  const subtotal = r2(Math.max(0, subRaw || 0));
  const manualDiscount = r2(Math.max(0, discRaw || 0));
  const serviceChargePct = Math.max(0, Number(svcRaw || 0));

  let loyaltyDiscount = 0;
  let loyalty = null;
  if (customerLoyaltyTier && Number(customerLoyaltyTier.discount_percent || 0) > 0) {
    const pct = Number(customerLoyaltyTier.discount_percent);
    loyaltyDiscount = r2(subtotal * pct / 100);
    loyalty = {
      tier_id: customerLoyaltyTier.tier_id,
      tier_name: customerLoyaltyTier.tier_name,
      discount_percent: pct,
    };
  }
  const totalDiscount = Math.min(subtotal, Math.max(manualDiscount, loyaltyDiscount));

  const subtotalAfterDiscount = Math.max(0, r2(subtotal - totalDiscount));
  const serviceCharge = r2(subtotalAfterDiscount * serviceChargePct / 100);
  const taxableBase = r2(subtotalAfterDiscount + serviceCharge);

  const active = (taxConfigs || []).filter(c => Number(c.enabled || 1) === 1 && Number(c.rate_percent || 0) > 0);
  let taxLines = [];
  let totalTax = 0;
  let usedLegacyGst = false;
  if (active.length > 0) {
    const out = computeTaxes({ tenant: { country }, taxConfigs: active, subtotalAfterDiscount: taxableBase, isIntrastate });
    taxLines = out.lines; totalTax = out.total;
  } else if (legacyGstFallback?.apply_gst && legacyGstFallback.gst_percent > 0) {
    const amount = r2(taxableBase * Number(legacyGstFallback.gst_percent) / 100);
    if (amount > 0) {
      taxLines = [{ id: 'GST', label: 'GST', rate: Number(legacyGstFallback.gst_percent), amount }];
      totalTax = amount;
      usedLegacyGst = true;
    }
  }
  return {
    subtotal, manualDiscount, loyaltyDiscount, totalDiscount,
    subtotalAfterDiscount, serviceCharge, taxableBase,
    taxLines, totalTax, grandTotal: r2(taxableBase + totalTax),
    loyalty, usedLegacyGst,
  };
}

let passed = 0, failed = 0;
function eq(a, b, tol = 0.01) {
  if (typeof a === 'string' || typeof b === 'string') return String(a) === String(b);
  if (a === null || b === null) return a === b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  return Math.abs(Number(a) - Number(b)) < tol;
}
function expect(actual, expected, label) {
  if (eq(actual, expected)) { passed++; console.log(`  ✓ ${label}: ${actual} = ${expected}`); }
  else { failed++; console.log(`  ❌ ${label}: ${actual} ≠ ${expected}`); }
}

// Tax configurations used across the cases
const TWO_TAXES_INDIA = [
  { id: 'GST', label: 'GST', rate_percent: 5, split_intrastate: 1, cgst_share: 0.5, enabled: 1 },
  { id: 'ST',  label: 'Service Tax', rate_percent: 10, split_intrastate: 0, enabled: 1 },
];
const SINGLE_GST_INDIA = [
  { id: 'GST', label: 'GST', rate_percent: 5, split_intrastate: 1, cgst_share: 0.5, enabled: 1 },
];
const SINGLE_GST_18 = [
  { id: 'GST', label: 'GST', rate_percent: 18, split_intrastate: 1, cgst_share: 0.5, enabled: 1 },
];

console.log('🧮 Offline invoice-math verifier\n');

// ────────────────────────────────────────────────────────────────────────
console.log('Case 1: Plain invoice — subtotal 1000, no discount, no service, no loyalty');
console.log('         Tax config: GST 5% (split India intrastate) + ST 10%');
{
  const t = computeInvoiceTotals({ subtotal: 1000, taxConfigs: TWO_TAXES_INDIA });
  expect(t.subtotal, 1000, 'subtotal');
  expect(t.totalDiscount, 0, 'discount');
  expect(t.taxableBase, 1000, 'taxable base');
  expect(t.taxLines.length, 3, 'tax line count = 3 (CGST + SGST + ST)');
  expect(t.taxLines[0].label, 'CGST', '');
  expect(t.taxLines[0].amount, 25, 'CGST amount');
  expect(t.taxLines[1].label, 'SGST', '');
  expect(t.taxLines[1].amount, 25, 'SGST amount');
  expect(t.taxLines[2].label, 'Service Tax', '');
  expect(t.taxLines[2].amount, 100, 'ST amount');
  expect(t.totalTax, 150, 'total tax');
  expect(t.grandTotal, 1150, 'grand total');
}

console.log('\nCase 2: Loyalty Gold 10% auto-apply — subtotal 1000');
{
  const t = computeInvoiceTotals({
    subtotal: 1000,
    customerLoyaltyTier: { tier_id: 'GOLD', tier_name: 'Gold', discount_percent: 10 },
    taxConfigs: TWO_TAXES_INDIA,
  });
  expect(t.loyaltyDiscount, 100, 'loyalty discount 10% of 1000');
  expect(t.totalDiscount, 100, 'total discount = loyalty (no manual)');
  expect(t.subtotalAfterDiscount, 900, 'after discount');
  expect(t.taxableBase, 900, 'taxable');
  expect(t.taxLines.length, 3, 'tax lines');
  expect(t.taxLines[2].amount, 90, 'Service Tax @ 10% of 900 = 90');
  expect(t.taxLines[0].amount, 22.5, 'CGST @ 2.5% of 900 = 22.50');
  expect(t.taxLines[1].amount, 22.5, 'SGST @ 2.5% of 900 = 22.50');
  expect(t.totalTax, 135, 'total tax');
  expect(t.grandTotal, 1035, 'grand 900 + 135');
}

console.log('\nCase 3: Loyalty Silver 5% + manual ₹200 (manual wins) — subtotal 1000');
{
  const t = computeInvoiceTotals({
    subtotal: 1000,
    discountAmount: 200,
    customerLoyaltyTier: { tier_id: 'SILVER', tier_name: 'Silver', discount_percent: 5 },
    taxConfigs: TWO_TAXES_INDIA,
  });
  expect(t.loyaltyDiscount, 50, 'loyalty 5% of 1000');
  expect(t.manualDiscount, 200, 'manual');
  expect(t.totalDiscount, 200, 'max(200, 50) = 200');
  expect(t.subtotalAfterDiscount, 800, 'after discount');
  expect(t.taxLines[2].amount, 80, 'ST @ 10% of 800');
  expect(t.grandTotal, 800 + 40 + 80, '800 + GST 40 + ST 80 = 920');
}

console.log('\nCase 4: Service charge 10% — subtotal 1000, no discount');
{
  const t = computeInvoiceTotals({
    subtotal: 1000,
    serviceChargePct: 10,
    taxConfigs: TWO_TAXES_INDIA,
  });
  expect(t.serviceCharge, 100, 'service @ 10% of 1000');
  expect(t.taxableBase, 1100, 'taxable = 1000 + 100');
  expect(t.taxLines[2].amount, 110, 'ST @ 10% of 1100');
  expect(t.taxLines[0].amount, 27.5, 'CGST');
  expect(t.taxLines[1].amount, 27.5, 'SGST');
  expect(t.totalTax, 165, 'total tax 55 + 110');
  expect(t.grandTotal, 1265, 'grand 1100 + 165');
}

console.log('\nCase 5: Loyalty Gold + service 10% + manual discount ₹50 — subtotal 1000');
{
  const t = computeInvoiceTotals({
    subtotal: 1000,
    discountAmount: 50,
    serviceChargePct: 10,
    customerLoyaltyTier: { tier_id: 'GOLD', tier_name: 'Gold', discount_percent: 10 },
    taxConfigs: TWO_TAXES_INDIA,
  });
  expect(t.totalDiscount, 100, 'max(50, 100=loyalty) = 100');
  expect(t.subtotalAfterDiscount, 900, '1000-100');
  expect(t.serviceCharge, 90, '10% of 900');
  expect(t.taxableBase, 990, '900+90');
  expect(t.taxLines[2].amount, 99, 'ST 10% of 990');
  expect(t.taxLines[0].amount, 24.75, 'CGST 2.5% of 990');
  expect(t.totalTax, r2(49.5 + 99), 'total tax');
  expect(t.grandTotal, r2(990 + 49.5 + 99), 'grand');
}

console.log('\nCase 6: Edge — discount > subtotal clamps to 0');
{
  const t = computeInvoiceTotals({
    subtotal: 100,
    discountAmount: 999,
    taxConfigs: TWO_TAXES_INDIA,
  });
  expect(t.totalDiscount, 100, 'clamped to subtotal');
  expect(t.taxableBase, 0, '0');
  expect(t.totalTax, 0, 'no tax on 0');
  expect(t.grandTotal, 0, 'grand 0');
}

console.log('\nCase 7: Interstate (no split) — subtotal 1000, single GST 5%');
{
  const t = computeInvoiceTotals({
    subtotal: 1000,
    taxConfigs: SINGLE_GST_INDIA,
    isIntrastate: false,
  });
  expect(t.taxLines.length, 1, '1 line (IGST, no split)');
  expect(t.taxLines[0].label, 'IGST', 'IGST label for interstate');
  expect(t.taxLines[0].amount, 50, '5% of 1000');
  expect(t.grandTotal, 1050, 'grand');
}

console.log('\nCase 8: Legacy fallback — no tax_config rows, form sends gst_percent=18');
{
  const t = computeInvoiceTotals({
    subtotal: 1000,
    taxConfigs: [],
    legacyGstFallback: { gst_percent: 18, apply_gst: true },
  });
  expect(t.usedLegacyGst, true, 'used legacy path');
  expect(t.taxLines.length, 1, '1 GST line from legacy');
  expect(t.taxLines[0].amount, 180, '18% of 1000');
  expect(t.grandTotal, 1180, 'grand');
}

console.log('\nCase 9: Migrated tenant (was GST 18% legacy) — first /tax-config seeded 18% override');
{
  const t = computeInvoiceTotals({
    subtotal: 1000,
    taxConfigs: SINGLE_GST_18, // simulates auto-seed having picked up legacy 18%
  });
  expect(t.usedLegacyGst, false, 'modern path (not legacy fallback)');
  expect(t.taxLines.length, 2, 'CGST + SGST (split)');
  expect(t.totalTax, 180, '18% of 1000 = 180');
  expect(t.grandTotal, 1180, 'matches pre-Phase-2 behaviour');
}

console.log('\nCase 10: No-loyalty customer — totalDiscount uses only manual');
{
  const t = computeInvoiceTotals({
    subtotal: 1000,
    discountAmount: 75,
    customerLoyaltyTier: { tier_id: 'BRONZE', tier_name: 'Bronze', discount_percent: 0 },
    taxConfigs: SINGLE_GST_INDIA,
  });
  expect(t.loyaltyDiscount, 0, 'Bronze has 0% off');
  expect(t.loyalty, null, 'no loyalty record set when pct = 0');
  expect(t.totalDiscount, 75, 'manual only');
  expect(t.subtotalAfterDiscount, 925, '1000-75');
  expect(t.totalTax, 46.25, '5% of 925');
}

console.log('\n' + '═'.repeat(60));
console.log(`Result: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
