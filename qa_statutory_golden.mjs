#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// qa_statutory_golden.mjs — Indian Statutory Payroll Engine Golden Fixtures
// ═══════════════════════════════════════════════════════════════════════════
//
// Offline math regression suite for statutoryRules.ts. Every assertion below
// is a hand-verified statutory expectation. Run with:
//
//     node qa_statutory_golden.mjs
//
// Must stay 100% green on every push touching HR/Payroll code. Add new
// fixtures, never delete — they're the contract that defends against a
// regression in tax/PF/ESI math.
//
// Boundary fixtures cover the points that historically break engines:
//   • PF ceiling (₹14,999 / ₹15,000 / ₹15,001)
//   • ESI ceiling (₹20,999 / ₹21,000 / ₹21,001)
//   • PT band boundaries (MH ₹7,500 / ₹7,501 / ₹10,000 / ₹10,001)
//   • PT Feb top-up
//   • TDS slab boundaries for both OLD and NEW regimes
//   • LOP proration math
//   • Disabled toggles (pf_enabled=false / esi_enabled=false)
//
// ═══════════════════════════════════════════════════════════════════════════

import {
  computePayslip,
  computeTDS,
  bandsToTdsSlabs,
  payslipToEcrRow,
  TAX_YEAR_SEED,
  computePF,
  computeESI,
  lookupPTSlab,
  applyTDSSlabs,
  statutoryRound,
  esiRoundUp,
} from './statutoryRules.ts';

// Re-implement minimal seed data here so the test is self-contained
// (mirrors what db.ts seeds into central_pt_slabs / central_tds_slabs).
const MH_SLABS = [
  { state_code: 'MH', min_gross: 0, max_gross: 7500, amount: 0, extra_month: null, extra_amount: 0 },
  { state_code: 'MH', min_gross: 7501, max_gross: 10000, amount: 175, extra_month: null, extra_amount: 0 },
  { state_code: 'MH', min_gross: 10001, max_gross: null, amount: 200, extra_month: 2, extra_amount: 300 },
];

const KA_SLABS = [
  { state_code: 'KA', min_gross: 0, max_gross: 24999, amount: 0, extra_month: null, extra_amount: 0 },
  { state_code: 'KA', min_gross: 25000, max_gross: null, amount: 200, extra_month: null, extra_amount: 0 },
];

const WB_SLABS = [
  { state_code: 'WB', min_gross: 0, max_gross: 10000, amount: 0, extra_month: null, extra_amount: 0 },
  { state_code: 'WB', min_gross: 10001, max_gross: 15000, amount: 110, extra_month: null, extra_amount: 0 },
  { state_code: 'WB', min_gross: 15001, max_gross: 25000, amount: 130, extra_month: null, extra_amount: 0 },
  { state_code: 'WB', min_gross: 25001, max_gross: 40000, amount: 150, extra_month: null, extra_amount: 0 },
  { state_code: 'WB', min_gross: 40001, max_gross: null, amount: 200, extra_month: null, extra_amount: 0 },
];

const TDS_OLD = [
  { fy: '2025-26', regime: 'OLD', min_income: 0,       max_income: 250000,  rate_pct: 0,  base_tax: 0,      surcharge_pct: 0, cess_pct: 4 },
  { fy: '2025-26', regime: 'OLD', min_income: 250001,  max_income: 500000,  rate_pct: 5,  base_tax: 0,      surcharge_pct: 0, cess_pct: 4 },
  { fy: '2025-26', regime: 'OLD', min_income: 500001,  max_income: 1000000, rate_pct: 20, base_tax: 12500,  surcharge_pct: 0, cess_pct: 4 },
  { fy: '2025-26', regime: 'OLD', min_income: 1000001, max_income: null,    rate_pct: 30, base_tax: 112500, surcharge_pct: 0, cess_pct: 4 },
];

const TDS_NEW = [
  { fy: '2025-26', regime: 'NEW', min_income: 0,       max_income: 300000,  rate_pct: 0,  base_tax: 0,      surcharge_pct: 0, cess_pct: 4 },
  { fy: '2025-26', regime: 'NEW', min_income: 300001,  max_income: 700000,  rate_pct: 5,  base_tax: 0,      surcharge_pct: 0, cess_pct: 4 },
  { fy: '2025-26', regime: 'NEW', min_income: 700001,  max_income: 1000000, rate_pct: 10, base_tax: 20000,  surcharge_pct: 0, cess_pct: 4 },
  { fy: '2025-26', regime: 'NEW', min_income: 1000001, max_income: 1200000, rate_pct: 15, base_tax: 50000,  surcharge_pct: 0, cess_pct: 4 },
  { fy: '2025-26', regime: 'NEW', min_income: 1200001, max_income: 1500000, rate_pct: 20, base_tax: 80000,  surcharge_pct: 0, cess_pct: 4 },
  { fy: '2025-26', regime: 'NEW', min_income: 1500001, max_income: null,    rate_pct: 30, base_tax: 140000, surcharge_pct: 0, cess_pct: 4 },
];

// ─── Tiny TAP-ish runner ───────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures = [];

function eq(label, actual, expected) {
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    failures.push(`  ✗ ${label}\n      expected: ${expected}\n      actual:   ${actual}`);
  }
}

function approx(label, actual, expected, tol = 1) {
  if (Math.abs(actual - expected) <= tol) {
    pass++;
  } else {
    fail++;
    failures.push(`  ✗ ${label}\n      expected ≈ ${expected} (±${tol})\n      actual:   ${actual}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. statutoryRound — basic rounding
// ═══════════════════════════════════════════════════════════════════════════
eq('round 1799.88 → 1800', statutoryRound(1799.88), 1800);
eq('round 1799.49 → 1799', statutoryRound(1799.49), 1799);
eq('round 0.5 → 1 (half-up)', statutoryRound(0.5), 1);
eq('round -0.5 → 0 (toward zero on neg half)', statutoryRound(-0.5), 0);
eq('round 0 → 0', statutoryRound(0), 0);
eq('round NaN → 0', statutoryRound(NaN), 0);

// ═══════════════════════════════════════════════════════════════════════════
// 2. esiRoundUp — ceiling
// ═══════════════════════════════════════════════════════════════════════════
eq('esiRoundUp 157.5 → 158', esiRoundUp(157.5), 158);
eq('esiRoundUp 158.0 → 158', esiRoundUp(158), 158);
eq('esiRoundUp 158.01 → 159', esiRoundUp(158.01), 159);
eq('esiRoundUp 0 → 0', esiRoundUp(0), 0);
eq('esiRoundUp negative → 0', esiRoundUp(-5), 0);

// ═══════════════════════════════════════════════════════════════════════════
// 3. PF — ceiling and boundaries
// ═══════════════════════════════════════════════════════════════════════════
// ₹14,999 base → 14999 × 0.12 = 1799.88 → 1800
{
  const pf = computePF(14999, true, 15000);
  eq('PF emp @ basic ₹14,999', pf.employee, 1800);
  eq('PF eps @ basic ₹14,999', pf.employer_eps, statutoryRound(14999 * 0.0833));
}
// ₹15,000 base → 15000 × 0.12 = 1800 (ceiling)
{
  const pf = computePF(15000, true, 15000);
  eq('PF emp @ basic ₹15,000', pf.employee, 1800);
  eq('PF eps @ basic ₹15,000', pf.employer_eps, statutoryRound(15000 * 0.0833)); // 1250 (1249.5 → 1250)
}
// ₹15,001 base → capped at 15000 → 1800
{
  const pf = computePF(15001, true, 15000);
  eq('PF emp @ basic ₹15,001 (capped)', pf.employee, 1800);
  eq('PF eps @ basic ₹15,001 (capped)', pf.employer_eps, 1250);
}
// ₹30,000 base → still capped at 15000 → 1800
{
  const pf = computePF(30000, true, 15000);
  eq('PF emp @ basic ₹30,000 (capped)', pf.employee, 1800);
}
// PF disabled
{
  const pf = computePF(15000, false, 15000);
  eq('PF emp disabled', pf.employee, 0);
  eq('PF eps disabled', pf.employer_eps, 0);
  eq('PF epf disabled', pf.employer_epf, 0);
}
// Low basic (₹5,000)
{
  const pf = computePF(5000, true, 15000);
  eq('PF emp @ basic ₹5,000', pf.employee, statutoryRound(5000 * 0.12)); // 600
  eq('PF eps @ basic ₹5,000', pf.employer_eps, statutoryRound(5000 * 0.0833)); // 417 (416.5)
  eq('PF epf @ basic ₹5,000', pf.employer_epf, statutoryRound(5000 * 0.12) - statutoryRound(5000 * 0.0833));
}
// Employer total === employee for symmetric 12% (sanity)
{
  const pf = computePF(12000, true, 15000);
  eq('PF employer total matches employee 12%', pf.employer_total, statutoryRound(12000 * 0.12));
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. ESI — ceiling boundaries
// ═══════════════════════════════════════════════════════════════════════════
// ₹20,999 gross → eligible → 0.75% employee, 3.25% employer (round up)
{
  const e = computeESI(20999, true, 21000);
  eq('ESI emp @ gross ₹20,999', e.employee, Math.ceil(20999 * 0.0075)); // 158
  eq('ESI er  @ gross ₹20,999', e.employer, Math.ceil(20999 * 0.0325)); // 683
}
// ₹21,000 gross → still eligible (boundary inclusive)
{
  const e = computeESI(21000, true, 21000);
  eq('ESI emp @ gross ₹21,000', e.employee, Math.ceil(21000 * 0.0075)); // 158
  eq('ESI er  @ gross ₹21,000', e.employer, Math.ceil(21000 * 0.0325)); // 683
}
// ₹21,001 gross → NOT eligible
{
  const e = computeESI(21001, true, 21000);
  eq('ESI emp @ gross ₹21,001 (above ceiling)', e.employee, 0);
  eq('ESI er  @ gross ₹21,001 (above ceiling)', e.employer, 0);
}
// ESI disabled
{
  const e = computeESI(15000, false, 21000);
  eq('ESI emp disabled', e.employee, 0);
  eq('ESI er disabled', e.employer, 0);
}
// Low gross (₹10,000)
{
  const e = computeESI(10000, true, 21000);
  eq('ESI emp @ gross ₹10,000', e.employee, Math.ceil(10000 * 0.0075)); // 75
  eq('ESI er  @ gross ₹10,000', e.employer, Math.ceil(10000 * 0.0325)); // 325
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. PT — Maharashtra slab boundaries + Feb top-up
// ═══════════════════════════════════════════════════════════════════════════
eq('PT MH @ ₹7,500 (Apr)',  lookupPTSlab(7500,  4, MH_SLABS), 0);
eq('PT MH @ ₹7,501 (Apr)',  lookupPTSlab(7501,  4, MH_SLABS), 175);
eq('PT MH @ ₹10,000 (Apr)', lookupPTSlab(10000, 4, MH_SLABS), 175);
eq('PT MH @ ₹10,001 (Apr)', lookupPTSlab(10001, 4, MH_SLABS), 200);
eq('PT MH @ ₹50,000 (Apr)', lookupPTSlab(50000, 4, MH_SLABS), 200);
// February top-up: ₹200 → ₹500
eq('PT MH @ ₹50,000 (Feb)', lookupPTSlab(50000, 2, MH_SLABS), 500);
eq('PT MH @ ₹10,001 (Feb)', lookupPTSlab(10001, 2, MH_SLABS), 500);
// Feb top-up does NOT apply to lower bands
eq('PT MH @ ₹10,000 (Feb)', lookupPTSlab(10000, 2, MH_SLABS), 175);
eq('PT MH @ ₹7,500  (Feb)', lookupPTSlab(7500,  2, MH_SLABS), 0);

// Karnataka
eq('PT KA @ ₹24,999', lookupPTSlab(24999, 6, KA_SLABS), 0);
eq('PT KA @ ₹25,000', lookupPTSlab(25000, 6, KA_SLABS), 200);
eq('PT KA @ ₹50,000', lookupPTSlab(50000, 6, KA_SLABS), 200);

// West Bengal
eq('PT WB @ ₹10,000', lookupPTSlab(10000, 6, WB_SLABS), 0);
eq('PT WB @ ₹10,001', lookupPTSlab(10001, 6, WB_SLABS), 110);
eq('PT WB @ ₹15,001', lookupPTSlab(15001, 6, WB_SLABS), 130);
eq('PT WB @ ₹25,001', lookupPTSlab(25001, 6, WB_SLABS), 150);
eq('PT WB @ ₹40,001', lookupPTSlab(40001, 6, WB_SLABS), 200);
eq('PT WB @ ₹99,999', lookupPTSlab(99999, 6, WB_SLABS), 200);

// Empty slabs
eq('PT (empty slabs)', lookupPTSlab(50000, 6, []), 0);

// ═══════════════════════════════════════════════════════════════════════════
// 6. TDS — OLD regime boundary tests
// ═══════════════════════════════════════════════════════════════════════════
// ₹2,50,000 → exactly ₹0 (top of zero band)
eq('TDS OLD @ ₹2,50,000 → ₹0', applyTDSSlabs(250000, TDS_OLD), 0);
// ₹2,50,001 → into 5% band: tax = 0 + (1)*0.05 = 0.05 → ~0
eq('TDS OLD @ ₹2,50,001 → 0', applyTDSSlabs(250001, TDS_OLD), 0);
// ₹5,00,000 → 12500 - (1)*5% = 12499.95 → 12500 (cess applies)
//   tax = 0 + (500000 - 250001)*0.05 = 12499.95
//   + 4% cess = 12999.948
eq('TDS OLD @ ₹5,00,000', applyTDSSlabs(500000, TDS_OLD), statutoryRound(12499.95 * 1.04));
// ₹6,00,000 OLD regime
//   slab 5L-10L: base=12500, rate=20, min=500001
//   tax = 12500 + (600000-500001)*0.20 = 12500 + 19999.80 = 32499.80
//   + 4% cess = 33799.79 → 33800
eq('TDS OLD @ ₹6,00,000', applyTDSSlabs(600000, TDS_OLD), statutoryRound(32499.80 * 1.04));
// ₹10,00,000
//   slab 5L-10L: base=12500, rate=20
//   tax = 12500 + (1000000-500001)*0.20 = 12500 + 99999.80 = 112499.80
//   + 4% cess
eq('TDS OLD @ ₹10,00,000', applyTDSSlabs(1000000, TDS_OLD), statutoryRound(112499.80 * 1.04));
// ₹10,00,001 → into 30% band, base 112500
//   tax = 112500 + (10000001-1000001)*0.30 = 112500 + 0 = 112500
eq('TDS OLD @ ₹10,00,001', applyTDSSlabs(1000001, TDS_OLD), statutoryRound(112500 * 1.04));
// ₹15,00,000 OLD
//   tax = 112500 + (1500000-1000001)*0.30 = 112500 + 149999.7 = 262499.7
//   + 4% cess
eq('TDS OLD @ ₹15,00,000', applyTDSSlabs(1500000, TDS_OLD), statutoryRound(262499.7 * 1.04));
// Zero / negative income
eq('TDS OLD @ ₹0', applyTDSSlabs(0, TDS_OLD), 0);
eq('TDS OLD @ -1000', applyTDSSlabs(-1000, TDS_OLD), 0);

// ═══════════════════════════════════════════════════════════════════════════
// 7. TDS — NEW regime boundary tests
// ═══════════════════════════════════════════════════════════════════════════
// ₹3,00,000 → 0
eq('TDS NEW @ ₹3,00,000 → 0', applyTDSSlabs(300000, TDS_NEW), 0);
// ₹7,00,000 → tax = 0 + (700000-300001)*0.05 = 19999.95
//   + cess 4% = 20799.948
eq('TDS NEW @ ₹7,00,000', applyTDSSlabs(700000, TDS_NEW), statutoryRound(19999.95 * 1.04));
// ₹10,00,000 NEW
//   slab 7-10L: base=20000, rate=10
//   tax = 20000 + (1000000-700001)*0.10 = 20000 + 29999.90 = 49999.90
//   + cess
eq('TDS NEW @ ₹10,00,000', applyTDSSlabs(1000000, TDS_NEW), statutoryRound(49999.9 * 1.04));
// ₹12,00,000 NEW
//   slab 10-12L: base=50000, rate=15
//   tax = 50000 + (1200000-1000001)*0.15 = 50000 + 29999.85 = 79999.85
eq('TDS NEW @ ₹12,00,000', applyTDSSlabs(1200000, TDS_NEW), statutoryRound(79999.85 * 1.04));
// ₹15,00,000 NEW
//   slab 12-15L: base=80000, rate=20
//   tax = 80000 + (1500000-1200001)*0.20 = 80000 + 59999.80 = 139999.80
eq('TDS NEW @ ₹15,00,000', applyTDSSlabs(1500000, TDS_NEW), statutoryRound(139999.8 * 1.04));
// ₹15,00,001 NEW → into 30% band
//   tax = 140000 + (1500001-1500001)*0.30 = 140000
eq('TDS NEW @ ₹15,00,001', applyTDSSlabs(1500001, TDS_NEW), statutoryRound(140000 * 1.04));
// ₹25,00,000 NEW (high earner)
//   tax = 140000 + (2500000-1500001)*0.30 = 140000 + 299999.70 = 439999.70
eq('TDS NEW @ ₹25,00,000', applyTDSSlabs(2500000, TDS_NEW), statutoryRound(439999.7 * 1.04));

// ═══════════════════════════════════════════════════════════════════════════
// 8. Full computePayslip — end-to-end fixtures
// ═══════════════════════════════════════════════════════════════════════════

// Fixture A — Junior staffer ₹18k gross, full month, MH, NEW regime, PF only
{
  const out = computePayslip({
    basic: 9000, hra: 4500, special: 4500, conveyance: 0, medical: 0, other_allowances: 0,
    pf_enabled: true, esi_enabled: true,
    pf_wage_ceiling: 15000, esi_wage_ceiling: 21000,
    pt_state: 'MH', pt_slabs: MH_SLABS,
    tds_regime: 'NEW', tds_slabs: TDS_NEW,
    section_80c_declared: 0, hra_exemption_declared: 0,
    work_days: 30, paid_days: 30, lop_days: 0,
    month: 6,
    voluntary_deductions: 0,
  });
  eq('A: gross @ ₹18k', out.gross_earnings, 18000);
  eq('A: PF emp @ basic ₹9k', out.pf_employee, statutoryRound(9000 * 0.12)); // 1080
  // ESI: gross 18000 ≤ 21000 → eligible
  eq('A: ESI emp @ gross ₹18k', out.esi_employee, esiRoundUp(18000 * 0.0075)); // 135
  eq('A: ESI er  @ gross ₹18k', out.esi_employer, esiRoundUp(18000 * 0.0325)); // 585
  // PT MH @ 18000 (≥10001) → ₹200
  eq('A: PT MH @ gross ₹18k', out.professional_tax, 200);
  // TDS NEW: annual gross 216000 - 50000 std = 166000 < 300000 → 0
  eq('A: TDS NEW @ annual 216k', out.tds, 0);
}

// Fixture B — Mid-level ₹60k gross, full month, MH, NEW regime
{
  const out = computePayslip({
    basic: 30000, hra: 12000, special: 18000, conveyance: 0, medical: 0, other_allowances: 0,
    pf_enabled: true, esi_enabled: true,
    pf_wage_ceiling: 15000, esi_wage_ceiling: 21000,
    pt_state: 'MH', pt_slabs: MH_SLABS,
    tds_regime: 'NEW', tds_slabs: TDS_NEW,
    section_80c_declared: 0, hra_exemption_declared: 0,
    work_days: 30, paid_days: 30, lop_days: 0,
    month: 6,
    voluntary_deductions: 0,
  });
  eq('B: gross @ ₹60k', out.gross_earnings, 60000);
  // PF basic capped at 15000 → 1800
  eq('B: PF emp (capped)', out.pf_employee, 1800);
  // ESI: 60000 > 21000 → 0
  eq('B: ESI emp (above ceiling)', out.esi_employee, 0);
  eq('B: ESI er (above ceiling)', out.esi_employer, 0);
  // PT MH @ 60000 → 200
  eq('B: PT MH', out.professional_tax, 200);
  // TDS NEW: 720000 - 50000 = 670000
  //   tax slab 300001-700000: 0 + (670000-300001)*0.05 = 18499.95
  //   + cess 4% = 19239.948
  //   /12 ≈ 1603
  const expectedTds = Math.round(statutoryRound(18499.95 * 1.04) / 12);
  approx('B: TDS NEW @ annual 720k', out.tds, expectedTds, 2);
}

// Fixture C — Senior ₹1.5L gross, full month, KA, OLD regime, 80C ₹1.5L
{
  const out = computePayslip({
    basic: 60000, hra: 30000, special: 60000, conveyance: 0, medical: 0, other_allowances: 0,
    pf_enabled: true, esi_enabled: true,
    pf_wage_ceiling: 15000, esi_wage_ceiling: 21000,
    pt_state: 'KA', pt_slabs: KA_SLABS,
    tds_regime: 'OLD', tds_slabs: TDS_OLD,
    section_80c_declared: 150000, hra_exemption_declared: 100000,
    work_days: 30, paid_days: 30, lop_days: 0,
    month: 6,
    voluntary_deductions: 0,
  });
  eq('C: gross @ ₹1.5L', out.gross_earnings, 150000);
  eq('C: PF emp (capped)', out.pf_employee, 1800);
  eq('C: ESI emp (way above)', out.esi_employee, 0);
  eq('C: PT KA @ ₹1.5L', out.professional_tax, 200);
  // OLD regime TDS:
  //   gross_annual = 1,800,000
  //   - 50,000 std - 150,000 80C - 100,000 HRA exempt = 1,500,000
  //   slab: 1,000,001-∞, base=112500, rate=30
  //   tax = 112500 + (1500000-1000001)*0.30 = 112500 + 149999.7 = 262499.7
  //   + cess 4% = 272999.688
  //   /12 ≈ 22750
  const expectedTds = Math.round(statutoryRound(262499.7 * 1.04) / 12);
  approx('C: TDS OLD @ taxable 15L', out.tds, expectedTds, 2);
}

// Fixture D — LOP proration. ₹30k gross, paid 25/30 days
{
  const out = computePayslip({
    basic: 15000, hra: 7500, special: 7500, conveyance: 0, medical: 0, other_allowances: 0,
    pf_enabled: true, esi_enabled: true,
    pf_wage_ceiling: 15000, esi_wage_ceiling: 21000,
    pt_state: 'MH', pt_slabs: MH_SLABS,
    tds_regime: 'NEW', tds_slabs: TDS_NEW,
    section_80c_declared: 0, hra_exemption_declared: 0,
    work_days: 30, paid_days: 25, lop_days: 5,
    month: 6,
    voluntary_deductions: 0,
  });
  // 25/30 = 0.83333
  eq('D: prorated basic',  out.prorated_basic,  statutoryRound(15000 * 25/30)); // 12500
  eq('D: prorated hra',    out.prorated_hra,    statutoryRound(7500  * 25/30)); // 6250
  eq('D: prorated gross',  out.gross_earnings,  statutoryRound(15000 * 25/30) + statutoryRound(7500 * 25/30) + statutoryRound(7500 * 25/30));
  // PF on prorated basic 12500 → 1500
  eq('D: PF emp on prorated', out.pf_employee, statutoryRound(12500 * 0.12));
  // ESI: 25000 (prorated gross approx) > 21000 → 0
  eq('D: ESI emp (above ceiling after proration)', out.esi_employee, 0);
}

// Fixture E — TDS uses FULL monthly gross (not pro-rated) for annual projection
{
  // Same staffer as B but with 5 LOP days. TDS should still match B because we
  // project the FULL gross, not the pro-rated one.
  const outB = computePayslip({
    basic: 30000, hra: 12000, special: 18000, conveyance: 0, medical: 0, other_allowances: 0,
    pf_enabled: true, esi_enabled: true,
    pf_wage_ceiling: 15000, esi_wage_ceiling: 21000,
    pt_state: 'MH', pt_slabs: MH_SLABS,
    tds_regime: 'NEW', tds_slabs: TDS_NEW,
    section_80c_declared: 0, hra_exemption_declared: 0,
    work_days: 30, paid_days: 30, lop_days: 0,
    month: 6,
    voluntary_deductions: 0,
  });
  const outE = computePayslip({
    basic: 30000, hra: 12000, special: 18000, conveyance: 0, medical: 0, other_allowances: 0,
    pf_enabled: true, esi_enabled: true,
    pf_wage_ceiling: 15000, esi_wage_ceiling: 21000,
    pt_state: 'MH', pt_slabs: MH_SLABS,
    tds_regime: 'NEW', tds_slabs: TDS_NEW,
    section_80c_declared: 0, hra_exemption_declared: 0,
    work_days: 30, paid_days: 25, lop_days: 5,
    month: 6,
    voluntary_deductions: 0,
  });
  eq('E: TDS stable across LOP (no March cliff)', outE.tds, outB.tds);
}

// Fixture F — All toggles off
{
  const out = computePayslip({
    basic: 15000, hra: 7500, special: 7500, conveyance: 0, medical: 0, other_allowances: 0,
    pf_enabled: false, esi_enabled: false,
    pf_wage_ceiling: 15000, esi_wage_ceiling: 21000,
    pt_state: null, pt_slabs: [],
    tds_regime: 'NEW', tds_slabs: TDS_NEW,
    section_80c_declared: 0, hra_exemption_declared: 0,
    work_days: 30, paid_days: 30, lop_days: 0,
    month: 6,
    voluntary_deductions: 0,
  });
  eq('F: PF emp (disabled)', out.pf_employee, 0);
  eq('F: ESI emp (disabled)', out.esi_employee, 0);
  eq('F: PT (no state)', out.professional_tax, 0);
  eq('F: gross_deductions = 0 + TDS', out.gross_deductions, out.tds);
  // TDS NEW: 30k × 12 = 360000 - 50000 = 310000
  //   slab 300001-700000: 0 + (310000-300001)*0.05 = 499.95
  //   + cess 4% = 519.948
  //   /12 ≈ 43
  const expectedTds = Math.round(statutoryRound(499.95 * 1.04) / 12);
  approx('F: TDS NEW @ taxable 310k', out.tds, expectedTds, 2);
}

// Fixture G — Voluntary deduction (e.g. insurance opt-in)
{
  const out = computePayslip({
    basic: 10000, hra: 5000, special: 5000, conveyance: 0, medical: 0, other_allowances: 0,
    pf_enabled: true, esi_enabled: true,
    pf_wage_ceiling: 15000, esi_wage_ceiling: 21000,
    pt_state: null, pt_slabs: [],
    tds_regime: 'NEW', tds_slabs: TDS_NEW,
    section_80c_declared: 0, hra_exemption_declared: 0,
    work_days: 30, paid_days: 30, lop_days: 0,
    month: 6,
    voluntary_deductions: 500,
  });
  // Confirm voluntary deduction lands in gross_deductions + line_items
  const voluntaryLine = out.line_items.find((l) => l.label === 'Voluntary Deductions');
  eq('G: voluntary line present', voluntaryLine?.amount, 500);
}

// Fixture H — Feb top-up Maharashtra: PT goes from ₹200 to ₹500
{
  const outJun = computePayslip({
    basic: 15000, hra: 7500, special: 7500, conveyance: 0, medical: 0, other_allowances: 0,
    pf_enabled: false, esi_enabled: false,
    pf_wage_ceiling: 15000, esi_wage_ceiling: 21000,
    pt_state: 'MH', pt_slabs: MH_SLABS,
    tds_regime: 'NEW', tds_slabs: TDS_NEW,
    section_80c_declared: 0, hra_exemption_declared: 0,
    work_days: 30, paid_days: 30, lop_days: 0,
    month: 6, voluntary_deductions: 0,
  });
  const outFeb = computePayslip({
    basic: 15000, hra: 7500, special: 7500, conveyance: 0, medical: 0, other_allowances: 0,
    pf_enabled: false, esi_enabled: false,
    pf_wage_ceiling: 15000, esi_wage_ceiling: 21000,
    pt_state: 'MH', pt_slabs: MH_SLABS,
    tds_regime: 'NEW', tds_slabs: TDS_NEW,
    section_80c_declared: 0, hra_exemption_declared: 0,
    work_days: 30, paid_days: 30, lop_days: 0,
    month: 2, voluntary_deductions: 0,
  });
  eq('H: PT MH Jun = 200', outJun.professional_tax, 200);
  eq('H: PT MH Feb = 500 (with top-up)', outFeb.professional_tax, 500);
}

// Fixture I — Net pay sanity: earnings - deductions = net
{
  const out = computePayslip({
    basic: 20000, hra: 10000, special: 5000, conveyance: 0, medical: 0, other_allowances: 0,
    pf_enabled: true, esi_enabled: true,
    pf_wage_ceiling: 15000, esi_wage_ceiling: 21000,
    pt_state: 'MH', pt_slabs: MH_SLABS,
    tds_regime: 'NEW', tds_slabs: TDS_NEW,
    section_80c_declared: 0, hra_exemption_declared: 0,
    work_days: 30, paid_days: 30, lop_days: 0,
    month: 6, voluntary_deductions: 0,
  });
  eq('I: net = gross - deductions', out.net_pay, out.gross_earnings - out.gross_deductions);
}

// Fixture J — Line items contain all expected labels
{
  const out = computePayslip({
    basic: 10000, hra: 5000, special: 0, conveyance: 1000, medical: 500, other_allowances: 0,
    pf_enabled: true, esi_enabled: true,
    pf_wage_ceiling: 15000, esi_wage_ceiling: 21000,
    pt_state: 'MH', pt_slabs: MH_SLABS,
    tds_regime: 'NEW', tds_slabs: TDS_NEW,
    section_80c_declared: 0, hra_exemption_declared: 0,
    work_days: 30, paid_days: 30, lop_days: 0,
    month: 6, voluntary_deductions: 0,
  });
  const labels = out.line_items.map((l) => l.label);
  eq('J: Basic present', labels.includes('Basic'), true);
  eq('J: HRA present', labels.includes('HRA'), true);
  eq('J: Conveyance present', labels.includes('Conveyance'), true);
  eq('J: Medical present', labels.includes('Medical Allowance'), true);
  eq('J: Special absent (0)', labels.includes('Special Allowance'), false);
  eq('J: PF (Employee) present', labels.includes('PF (Employee)'), true);
}

// ═══════════════════════════════════════════════════════════════════════════
// 11. HRMS-R0A (Sep 2026) — tax years, rebate, half days, zero paid days, ECR row
// ═══════════════════════════════════════════════════════════════════════════
{
  const NEW25 = TAX_YEAR_SEED.find((t) => t.fy === '2025-26' && t.regime === 'NEW');
  const OLD25 = TAX_YEAR_SEED.find((t) => t.fy === '2025-26' && t.regime === 'OLD');
  const sN = bandsToTdsSlabs('2025-26', 'NEW', NEW25.bands, NEW25.params.cess_pct);
  const sO = bandsToTdsSlabs('2025-26', 'OLD', OLD25.bands, OLD25.params.cess_pct);
  eq('bands: NEW cumulative tax at 12L = 60,000', sN.find((x) => x.min_income === 1200000).base_tax, 60000);
  eq('bands: NEW cumulative tax at 24L = 3,00,000', sN.find((x) => x.min_income === 2400000).base_tax, 300000);
  eq('bands: OLD cumulative tax at 10L = 1,12,500', sO.find((x) => x.min_income === 1000000).base_tax, 112500);

  const tN = (grossAnnual) => computeTDS({ grossAnnual, regime: 'NEW', slabs: sN, pfEmployeeAnnual: 0, section80cDeclared: 0, hraExemptionDeclared: 0, params: NEW25.params });
  const tO = (grossAnnual, c80 = 0) => computeTDS({ grossAnnual, regime: 'OLD', slabs: sO, pfEmployeeAnnual: 0, section80cDeclared: c80, hraExemptionDeclared: 0, params: OLD25.params });
  eq('FY25-26 NEW: taxable 12,00,000 → rebate → 0', tN(1275000), 0);
  eq('FY25-26 NEW: taxable 12,50,000 → marginal relief ₹52,000/yr → 4,333/mo', tN(1325000), 4333);
  eq('FY25-26 NEW: taxable 13,65,000 → ₹88,140/yr → 7,345/mo', tN(1440000), 7345);
  eq('FY25-26 NEW: taxable 25,00,000 → ₹3,43,200/yr → 28,600/mo', tN(2575000), 28600);
  eq('FY25-26 OLD: taxable 5,00,000 → rebate → 0', tO(550000), 0);
  eq('FY25-26 OLD: taxable 6,00,000 → ₹33,800/yr → 2,817/mo', tO(650000), 2817);
  eq('FY25-26 OLD: 80C 1.5L, taxable 6,00,000 → 2,817/mo', tO(800000, 150000), 2817);
  eq('legacy computeTDS path unchanged without params',
    computeTDS({ grossAnnual: 600000, regime: 'NEW', slabs: TDS_NEW, pfEmployeeAnnual: 0, section80cDeclared: 0, hraExemptionDeclared: 0 }),
    statutoryRound(applyTDSSlabs(550000, TDS_NEW) / 12));

  const base = {
    basic: 62000, hra: 31000, special: 27000, conveyance: 0, medical: 0, other_allowances: 0,
    pf_enabled: false, esi_enabled: false, pf_wage_ceiling: 15000, esi_wage_ceiling: 21000, pt_state: null, pt_slabs: [],
    tds_regime: 'NEW', tds_slabs: sN, tax_params: NEW25.params, section_80c_declared: 0, hra_exemption_declared: 0,
    work_days: 31, paid_days: 28.5, lop_days: 2.5, month: 3, voluntary_deductions: 0,
  };
  const half = computePayslip(base);
  eq('K: 28.5 of 31 days → gross 1,10,323', half.gross_earnings, 110323);
  eq('K: TDS 7,345 (projected on the full salary)', half.tds, 7345);
  eq('K: net 1,02,978', half.net_pay, 102978);
  const zero = computePayslip({ ...base, paid_days: 0, lop_days: 31 });
  eq('L: zero paid days → gross 0 (was a full month)', zero.gross_earnings, 0);
  eq('L: zero paid days → no TDS withheld', zero.tds, 0);
  eq('L: zero paid days → net 0', zero.net_pay, 0);
  const noDays = computePayslip({ ...base, paid_days: undefined });
  eq('L: paid days not given → full month', noDays.gross_earnings, 120000);

  const ecr = payslipToEcrRow({
    uan: '100000000001', staff_name: 'Test', gross_earnings: 110323,
    line_items: JSON.stringify(half.line_items), structure_snapshot: JSON.stringify({ basic: 62000 }),
    paid_days: 28.5, work_days: 31, pf_employee: 1800, pf_employer_eps: 1250, pf_employer_epf: 550, lop_days: 2.5,
  }, 15000);
  eq('ECR: EPF wages = basic paid, capped at the ceiling', ecr.epf_wages, 15000);
  eq('ECR: EPF contribution = member share', ecr.epf_contrib_remitted, 1800);
  eq('ECR: EPS contribution = employer pension share', ecr.eps_contrib_remitted, 1250);
  eq('ECR: EPF-EPS difference = employer EPF share', ecr.epf_eps_diff_remitted, 550);
  eq('ECR: NCP days rounded', ecr.ncp_days, 3);
  const ecrLow = payslipToEcrRow({
    uan: '1', staff_name: 'T', gross_earnings: 9000, line_items: '[{"label":"Basic","type":"EARNING","amount":9000}]',
    paid_days: 30, work_days: 30, pf_employee: 1080, pf_employer_eps: 750, pf_employer_epf: 330, lop_days: 0,
  }, 15000);
  eq('ECR: basic under the ceiling used as paid', ecrLow.epf_wages, 9000);
  const ecrSnap = payslipToEcrRow({ uan: '1', staff_name: 'T', gross_earnings: 0, line_items: '[]', structure_snapshot: '{"basic":10000}', paid_days: 15, work_days: 30, lop_days: 15 }, 15000);
  eq('ECR: no Basic line → structure basic × paid days', ecrSnap.epf_wages, 5000);
}

// ═══════════════════════════════════════════════════════════════════════════
// 12. HRMS-R1A (Sep 2026) — HR helpers (hrService.ts)
// ═══════════════════════════════════════════════════════════════════════════
{
  const hr = await import('./hrService.ts');
  const chain = new Map([['a', 'b'], ['b', 'c'], ['c', null]]);
  eq('manager loop: c reporting to a closes a loop', hr.wouldCreateManagerCycle('c', 'a', chain), true);
  eq('manager loop: a reporting to c is fine', hr.wouldCreateManagerCycle('x', 'c', chain), false);
  eq('manager loop: self', hr.wouldCreateManagerCycle('a', 'a', chain), true);
  eq('manager loop: no manager', hr.wouldCreateManagerCycle('a', '', chain), false);
  eq('next code after EMP-0009 and EMP-0012', hr.nextEmployeeCodeFrom(['EMP-0009', 'X-1', null, 'EMP-0012']), 'EMP-0013');
  eq('first code', hr.nextEmployeeCodeFrom([]), 'EMP-0001');
  eq('master code from a name', hr.normaliseMasterCode(' Front office & F&B '), 'FRONT-OFFICE-F-B');
  eq('master code length', hr.normaliseMasterCode('A'.repeat(40)).length, 20);
  const d = hr.diffFields({ a: 1, b: '2026-03-01T00:00:00.000Z', c: null, pan: 'ABCDE1234F' }, { a: 1, b: '2026-03-01', c: '', pan: 'ZZZZZ9999Z' }, ['a', 'b', 'c', 'pan'], (k, v) => k === 'pan' && v ? '••••' + String(v).slice(-4) : v);
  eq('diff: only the PAN changed', d.keys.join(','), 'pan');
  eq('diff: masked after value', d.after.pan, '••••999Z');
}

// ═══════════════════════════════════════════════════════════════════════════
// 13. HRMS-R1B (Sep 2026) — sensitive numbers encrypted at rest
// ═══════════════════════════════════════════════════════════════════════════
{
  const hr = await import('./hrService.ts');
  const prevKey = process.env.HR_DATA_KEY;
  delete process.env.HR_DATA_KEY;
  const enc = hr.encryptSensitive('ABCDE1234F');
  eq('encrypted value carries the hr1 prefix', String(enc).startsWith('hr1:'), true);
  eq('encrypted value reads back', hr.decryptSensitive(enc), 'ABCDE1234F');
  eq('two encryptions differ (random IV)', hr.encryptSensitive('ABCDE1234F') !== enc, true);
  eq('a value saved before encryption reads as it is', hr.decryptSensitive('ABCDE1234F'), 'ABCDE1234F');
  eq('an encrypted value is not encrypted twice', hr.encryptSensitive(enc), enc);
  const parts = String(enc).split(':');
  const flipped = parts[3][0] === 'A' ? 'B' + parts[3].slice(1) : 'A' + parts[3].slice(1);
  eq('a tampered value does not read', hr.decryptSensitive([parts[0], parts[1], parts[2], flipped].join(':')), null);
  eq('empty stays empty', hr.encryptSensitive(''), null);
  eq('key source without HR_DATA_KEY', hr.hrDataKeySource(), 'JWT_SECRET');
  process.env.HR_DATA_KEY = Buffer.alloc(32, 7).toString('base64');
  eq('with HR_DATA_KEY set, older values still read', hr.decryptSensitive(enc), 'ABCDE1234F');
  const enc2 = hr.encryptSensitive('999988887777');
  eq('new values use HR_DATA_KEY', hr.hrDataKeySource(), 'HR_DATA_KEY');
  eq('and read back', hr.decryptSensitive(enc2), '999988887777');
  delete process.env.HR_DATA_KEY;
  eq('without that key, a value encrypted with it does not read', hr.decryptSensitive(enc2), null);
  if (prevKey !== undefined) process.env.HR_DATA_KEY = prevKey;
}

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════
const total = pass + fail;
console.log('\n═══════════════════════════════════════════════════');
console.log(`  Statutory Engine Golden Fixtures`);
console.log('═══════════════════════════════════════════════════');
console.log(`  Total assertions: ${total}`);
console.log(`  ✓ Passed: ${pass}`);
console.log(`  ✗ Failed: ${fail}`);
if (fail > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(f));
  process.exit(1);
}
console.log('\n  🎉 All statutory assertions passed.\n');
process.exit(0);
