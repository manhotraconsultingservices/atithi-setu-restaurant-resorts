// ═══════════════════════════════════════════════════════════════════════════
// statutoryRules.ts — Indian Statutory Payroll Engine (FY 2025-26)
// ═══════════════════════════════════════════════════════════════════════════
//
// PURE FUNCTIONS ONLY. No DB calls inside this module. The caller
// resolves slabs (from central_pt_slabs / central_tds_slabs) and the
// tenant's statutory_config row, then passes them in. This keeps the
// engine deterministic, testable, and reproducible — golden fixtures
// in `qa_statutory_golden.mjs` MUST pass for every commit that
// touches this file.
//
// Conventions:
//   • All amounts are in INR (the Atithi-Setu HR module is INR-gated
//     until Phase 2 i18n).
//   • All computed amounts are rounded to nearest rupee using
//     `statutoryRound()` UNLESS the rule says otherwise (ESI is
//     always rounded UP per the ESI Act).
//   • PF wage base = basic + DA. Since our salary structure model
//     doesn't carry a separate DA, we treat `basic` AS the wage base.
//     Tenants who want DA can bake it into `basic` or add it as a
//     custom allowance line (excluded from PF base).
//   • Standard deduction, rebate and slabs come per financial year and
//     regime (TaxYear, stored in central_tax_years / central_tax_slabs).
//     Callers that pass no tax_params keep the legacy fixed ₹50,000 path.
//     (HRMS-R0A, Sep 2026)
//
// References:
//   • EPF & MP Act 1952, Sch I; EPFO circulars
//   • ESI Act 1948 §39 + 4% / 0.75% revision (1 July 2019)
//   • Income-tax Act 1961 §192, §16(ia); Finance Act 2025 slabs
//   • MH PT Act 1975; KA PT Act 1976; WB PT Act 1979
// ═══════════════════════════════════════════════════════════════════════════

export type PtSlab = {
  state_code: string;
  min_gross: number;
  max_gross: number | null;
  amount: number;
  extra_month: number | null;
  extra_amount: number;
};

export type TdsSlab = {
  fy: string;
  regime: 'OLD' | 'NEW';
  min_income: number;
  max_income: number | null;
  rate_pct: number;
  base_tax: number;
  surcharge_pct: number;
  cess_pct: number;
};

/** Income-tax figures for one financial year and regime. Everything a budget
 *  changes lives here, so no code names a year. */
export type TaxYearParams = {
  standard_deduction: number;     // annual, from salary
  rebate_income_limit: number;    // total income up to which the rebate applies
  rebate_max: number;             // largest rebate
  marginal_relief: boolean;       // above the limit, tax is capped at the income above it
  cess_pct: number;               // health & education cess
};

export type TaxBand = { min_income: number; max_income: number | null; rate_pct: number };

export type TaxYear = {
  fy: string;
  regime: 'OLD' | 'NEW';
  source: string | null;
  params: TaxYearParams;
  slabs: TdsSlab[];
};

/** Seeded into central_tax_years / central_tax_slabs at start-up. A year missing
 *  from those tables stops the payroll run rather than deducting no tax.
 *  FY 2025-26 follows Finance Act 2025 and awaits the owner's adviser's
 *  confirmation (decision D14). Add a year only once its figures are confirmed.
 *  Age-based old-regime exemption limits (60+, 80+) are not modelled yet. */
export const TAX_YEAR_SEED: Array<{ fy: string; regime: 'OLD' | 'NEW'; source: string; params: TaxYearParams; bands: TaxBand[] }> = [
  {
    fy: '2025-26', regime: 'NEW', source: 'Finance Act 2025 (pending adviser confirmation)',
    params: { standard_deduction: 75000, rebate_income_limit: 1200000, rebate_max: 60000, marginal_relief: true, cess_pct: 4 },
    bands: [
      { min_income: 0,       max_income: 400000,  rate_pct: 0 },
      { min_income: 400000,  max_income: 800000,  rate_pct: 5 },
      { min_income: 800000,  max_income: 1200000, rate_pct: 10 },
      { min_income: 1200000, max_income: 1600000, rate_pct: 15 },
      { min_income: 1600000, max_income: 2000000, rate_pct: 20 },
      { min_income: 2000000, max_income: 2400000, rate_pct: 25 },
      { min_income: 2400000, max_income: null,    rate_pct: 30 },
    ],
  },
  {
    fy: '2025-26', regime: 'OLD', source: 'Finance Act 2025 (pending adviser confirmation)',
    params: { standard_deduction: 50000, rebate_income_limit: 500000, rebate_max: 12500, marginal_relief: false, cess_pct: 4 },
    bands: [
      { min_income: 0,       max_income: 250000,  rate_pct: 0 },
      { min_income: 250000,  max_income: 500000,  rate_pct: 5 },
      { min_income: 500000,  max_income: 1000000, rate_pct: 20 },
      { min_income: 1000000, max_income: null,    rate_pct: 30 },
    ],
  },
];

/** Plain bands → slab rows with cumulative base_tax. Bands run from 0 upward and
 *  share boundaries (an income exactly on a boundary takes the lower band). */
export function bandsToTdsSlabs(fy: string, regime: 'OLD' | 'NEW', bands: TaxBand[], cessPct: number): TdsSlab[] {
  const sorted = [...bands].sort((a, b) => a.min_income - b.min_income);
  let base = 0;
  return sorted.map((b) => {
    const row: TdsSlab = {
      fy, regime, min_income: b.min_income, max_income: b.max_income,
      rate_pct: b.rate_pct, base_tax: base, surcharge_pct: 0, cess_pct: cessPct,
    };
    if (b.max_income != null) base += (b.max_income - b.min_income) * (b.rate_pct / 100);
    return row;
  });
}

/** Tax on an annual taxable income before rebate and cess, unrounded. */
export function slabTaxBeforeCess(taxableAnnual: number, slabs: TdsSlab[]): number {
  if (taxableAnnual <= 0 || !slabs || slabs.length === 0) return 0;
  const sorted = [...slabs].sort((a, b) => a.min_income - b.min_income);
  for (const slab of sorted) {
    const max = slab.max_income ?? Number.POSITIVE_INFINITY;
    if (taxableAnnual >= slab.min_income && taxableAnnual <= max) {
      return (slab.base_tax || 0) + (taxableAnnual - slab.min_income) * (slab.rate_pct / 100);
    }
  }
  const top = sorted[sorted.length - 1];
  return (top.base_tax || 0) + (taxableAnnual - top.min_income) * (top.rate_pct / 100);
}

/** One EPF ECR row from a stored payslip (EPFO ECR 2.0 field order). EPF, EPS and
 *  EDLI wages = the basic actually paid this month (the payslip's Basic line),
 *  capped at the PF wage ceiling. EPF contribution = the member's own 12% share;
 *  EPS contribution = the employer's pension share; EPF-EPS difference = the
 *  employer's EPF share. NCP days = unpaid days, rounded. */
export function payslipToEcrRow(p: any, wageCeiling: number) {
  let basicPaid = NaN;
  try {
    const items = Array.isArray(p.line_items) ? p.line_items : JSON.parse(p.line_items || '[]');
    const b = (items || []).find((i: any) => i && i.type === 'EARNING' && i.label === 'Basic');
    if (b) basicPaid = Number(b.amount) || 0;
  } catch { /* fall back to the structure snapshot */ }
  if (!Number.isFinite(basicPaid)) {
    let basic = 0;
    try { basic = Number(JSON.parse(p.structure_snapshot || '{}').basic) || 0; } catch { basic = 0; }
    const factor = (Number(p.paid_days) || 0) / Math.max(1, Number(p.work_days) || 30);
    basicPaid = Math.round(basic * factor);
  }
  const wages = Math.min(Math.round(basicPaid), Number(wageCeiling) || 15000);
  return {
    uan: String(p.uan || ''),
    member_name: String(p.staff_name || ''),
    gross_wages: Math.round(Number(p.gross_earnings) || 0),
    epf_wages: wages,
    eps_wages: wages,
    edli_wages: wages,
    epf_contrib_remitted: Math.round(Number(p.pf_employee) || 0),
    eps_contrib_remitted: Math.round(Number(p.pf_employer_eps) || 0),
    epf_eps_diff_remitted: Math.round(Number(p.pf_employer_epf) || 0),
    ncp_days: Math.round(Number(p.lop_days) || 0),
    refund_of_advances: 0,
  };
}

export type StatutoryInput = {
  // Earnings (pre-proration, monthly)
  basic: number;
  hra: number;
  special: number;
  conveyance: number;
  medical: number;
  other_allowances: number;

  // Toggles (from tenant statutory_config)
  pf_enabled: boolean;
  esi_enabled: boolean;
  pf_wage_ceiling: number;          // 15000 default
  esi_wage_ceiling: number;         // 21000 default
  pt_state: string | null;          // 'MH' | 'KA' | 'WB' | null = no PT
  pt_slabs: PtSlab[];               // filtered to pt_state

  // TDS context (from salary_structures + central_tds_slabs)
  tds_regime: 'OLD' | 'NEW';
  tds_slabs: TdsSlab[];             // filtered to (fy, regime)
  section_80c_declared: number;     // annual, OLD only
  hra_exemption_declared: number;   // annual, OLD only
  tax_params?: TaxYearParams | null; // the year's figures; absent = legacy fixed ₹50,000, no rebate

  // Attendance
  work_days: number;
  paid_days: number;
  lop_days: number;

  // Period
  month: number;                    // 1-12 (Jan = 1)

  // Voluntary deductions (e.g. employee opted insurance, advance recovery)
  voluntary_deductions: number;
};

export type StatutoryOutput = {
  // Pro-rated earnings
  prorated_basic: number;
  prorated_hra: number;
  prorated_special: number;
  prorated_conveyance: number;
  prorated_medical: number;
  prorated_other: number;
  gross_earnings: number;

  // Statutory deductions
  pf_employee: number;
  pf_employer_eps: number;
  pf_employer_epf: number;
  pf_employer_total: number;
  esi_employee: number;
  esi_employer: number;
  professional_tax: number;
  tds: number;

  // Net
  gross_deductions: number;
  net_pay: number;

  // Audit-ready line items (label/type/amount tuples)
  line_items: Array<{ label: string; type: 'EARNING' | 'DEDUCTION'; amount: number }>;
};

/** Round to nearest rupee. Banker's rounding (round-half-to-even) is
 *  NOT used — Indian statutory convention is half-up. */
export function statutoryRound(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/** ESI uses round-UP per ESI Act §39. */
export function esiRoundUp(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(n);
}

/** PT slab lookup. Returns the monthly PT amount for the given gross,
 *  with Feb top-up applied when applicable. */
export function lookupPTSlab(
  gross: number,
  month: number,
  slabs: PtSlab[]
): number {
  if (!slabs || slabs.length === 0) return 0;
  for (const slab of slabs) {
    const min = slab.min_gross;
    const max = slab.max_gross ?? Number.POSITIVE_INFINITY;
    if (gross >= min && gross <= max) {
      let amt = Number(slab.amount) || 0;
      if (slab.extra_month && Number(slab.extra_month) === month) {
        amt += Number(slab.extra_amount) || 0;
      }
      return statutoryRound(amt);
    }
  }
  return 0;
}

/** Apply TDS slabs cumulatively. Each slab carries `base_tax` which is
 *  the cumulative tax UP TO `min_income`. Tax at any income X falling in
 *  slab S = S.base_tax + (X − S.min_income) × S.rate_pct/100.
 *  Cess is applied AFTER the slab lookup. Surcharge skipped in Phase 1
 *  (kicks in at taxable > ₹50L which is rare for our SMB tenant base). */
export function applyTDSSlabs(
  taxableAnnual: number,
  slabs: TdsSlab[]
): number {
  if (taxableAnnual <= 0 || !slabs || slabs.length === 0) return 0;
  const X = Math.max(0, taxableAnnual);
  const sorted = [...slabs].sort((a, b) => a.min_income - b.min_income);

  for (const slab of sorted) {
    const min = slab.min_income;
    const max = slab.max_income ?? Number.POSITIVE_INFINITY;
    if (X >= min && X <= max) {
      const taxBeforeCess = (slab.base_tax || 0) + (X - min) * (slab.rate_pct / 100);
      const cess = taxBeforeCess * ((slab.cess_pct || 0) / 100);
      return statutoryRound(taxBeforeCess + cess);
    }
  }
  // Income above the top slab — apply the last slab's rate.
  const top = sorted[sorted.length - 1];
  const taxBeforeCess = (top.base_tax || 0) + (X - top.min_income) * (top.rate_pct / 100);
  const cess = taxBeforeCess * ((top.cess_pct || 0) / 100);
  return statutoryRound(taxBeforeCess + cess);
}

/** Compute PF (employee + employer split).
 *  Returns { employee, employer_eps, employer_epf } — all rounded.
 *  PF base = min(basic, wage_ceiling=15000). Employee = base × 12%.
 *  Employer EPS = base × 8.33% (capped at ceiling × 8.33% = ₹1,250).
 *  Employer EPF = total_employer (12%) − EPS. */
export function computePF(
  basicMonthly: number,
  enabled: boolean,
  wageCeiling: number
): { employee: number; employer_eps: number; employer_epf: number; employer_total: number } {
  if (!enabled || basicMonthly <= 0) {
    return { employee: 0, employer_eps: 0, employer_epf: 0, employer_total: 0 };
  }
  const base = Math.min(basicMonthly, wageCeiling);
  const employee = statutoryRound(base * 0.12);
  const employer_eps = statutoryRound(Math.min(base, wageCeiling) * 0.0833);
  const employer_total = statutoryRound(base * 0.12);
  const employer_epf = Math.max(0, employer_total - employer_eps);
  return { employee, employer_eps, employer_epf, employer_total };
}

/** Compute ESI (employee + employer split). Eligible only if
 *  monthly gross ≤ wage_ceiling (₹21,000 default). Rates fixed by
 *  statute: 0.75% employee, 3.25% employer. Round UP. */
export function computeESI(
  gross: number,
  enabled: boolean,
  wageCeiling: number
): { employee: number; employer: number } {
  if (!enabled || gross <= 0 || gross > wageCeiling) {
    return { employee: 0, employer: 0 };
  }
  return {
    employee: esiRoundUp(gross * 0.0075),
    employer: esiRoundUp(gross * 0.0325),
  };
}

/** Compute monthly TDS withholding.
 *  Algorithm: project annual gross, subtract regime-specific deductions
 *  (standard ₹50k always; 80C+HRA exemption only in OLD), apply slabs,
 *  divide by 12. March true-up isn't done here — the caller can pass
 *  a cumulative-aware structure later when we ship Phase-2 March logic. */
export function computeTDS(args: {
  grossAnnual: number;
  regime: 'OLD' | 'NEW';
  slabs: TdsSlab[];
  pfEmployeeAnnual: number;     // already × 12
  section80cDeclared: number;   // annual
  hraExemptionDeclared: number; // annual
  params?: TaxYearParams | null;  // the year's figures; absent = legacy path below
}): number {
  if (args.params) {
    const p = args.params;
    let taxable = Math.max(0, args.grossAnnual - (p.standard_deduction || 0));
    if (args.regime === 'OLD') {
      const eighty_c_room = Math.max(0, Math.min(150000, args.section80cDeclared || 0));
      taxable = Math.max(0, taxable - eighty_c_room - (args.hraExemptionDeclared || 0));
    }
    let tax = slabTaxBeforeCess(taxable, args.slabs);
    const limit = p.rebate_income_limit || 0;
    if (taxable <= limit) {
      tax = Math.max(0, tax - (p.rebate_max || 0));
    } else if (p.marginal_relief) {
      tax = Math.min(tax, taxable - limit);
    }
    const cessPct = Number.isFinite(p.cess_pct) ? p.cess_pct : 4;
    const annual = statutoryRound(tax * (1 + cessPct / 100));
    return statutoryRound(annual / 12);
  }
  const STANDARD_DEDUCTION = 50000;
  let taxable = Math.max(0, args.grossAnnual - STANDARD_DEDUCTION);
  if (args.regime === 'OLD') {
    // Employee PF auto-deductible under 80C (already inside the declared 80C usually,
    // but we conservatively add only the lesser of the two so we don't double-count).
    const eighty_c_room = Math.max(
      0,
      Math.min(150000, args.section80cDeclared || 0)
    );
    taxable = Math.max(0, taxable - eighty_c_room - (args.hraExemptionDeclared || 0));
  }
  const annualTax = applyTDSSlabs(taxable, args.slabs);
  return statutoryRound(annualTax / 12);
}

/** ────────────────────────────────────────────────────────────────
 *  Master payroll-line computation.
 *  Pure: input → output, no DB, no side effects.
 *  ──────────────────────────────────────────────────────────────── */
export function computePayslip(input: StatutoryInput): StatutoryOutput {
  const workDays = Math.max(1, input.work_days || 30);
  // Zero paid days means zero, not a full month (HRMS-R0A); only a missing value means full.
  const paidDays = Math.max(0, Math.min(workDays, input.paid_days == null ? workDays : input.paid_days));
  const factor = paidDays / workDays;

  // 1. Pro-rate every earning line
  const prorated_basic = statutoryRound((input.basic || 0) * factor);
  const prorated_hra = statutoryRound((input.hra || 0) * factor);
  const prorated_special = statutoryRound((input.special || 0) * factor);
  const prorated_conveyance = statutoryRound((input.conveyance || 0) * factor);
  const prorated_medical = statutoryRound((input.medical || 0) * factor);
  const prorated_other = statutoryRound((input.other_allowances || 0) * factor);
  const gross_earnings =
    prorated_basic +
    prorated_hra +
    prorated_special +
    prorated_conveyance +
    prorated_medical +
    prorated_other;

  // 2. PF on pro-rated basic
  const pf = computePF(
    prorated_basic,
    !!input.pf_enabled,
    input.pf_wage_ceiling || 15000
  );

  // 3. ESI on pro-rated gross
  const esi = computeESI(
    gross_earnings,
    !!input.esi_enabled,
    input.esi_wage_ceiling || 21000
  );

  // 4. PT on pro-rated gross (state slab + month for Feb top-up)
  const professional_tax = input.pt_state
    ? lookupPTSlab(gross_earnings, input.month, input.pt_slabs || [])
    : 0;

  // 5. TDS — projected annual basis (use NON-pro-rated gross × 12 because
  //    proration usually evens out across the year; pro-rating monthly TDS
  //    creates a March cliff. Old practice: project on the full salary.)
  const fullMonthlyGross =
    (input.basic || 0) +
    (input.hra || 0) +
    (input.special || 0) +
    (input.conveyance || 0) +
    (input.medical || 0) +
    (input.other_allowances || 0);
  const fullMonthlyBasic = input.basic || 0;
  const fullPf = computePF(
    fullMonthlyBasic,
    !!input.pf_enabled,
    input.pf_wage_ceiling || 15000
  );
  // Nothing is withheld from a month with no pay.
  const tds = gross_earnings > 0 ? computeTDS({
    grossAnnual: fullMonthlyGross * 12,
    regime: input.tds_regime,
    slabs: input.tds_slabs || [],
    pfEmployeeAnnual: fullPf.employee * 12,
    section80cDeclared: input.section_80c_declared || 0,
    hraExemptionDeclared: input.hra_exemption_declared || 0,
    params: input.tax_params || null,
  }) : 0;

  // 6. Aggregate
  const voluntary = statutoryRound(input.voluntary_deductions || 0);
  const gross_deductions =
    pf.employee + esi.employee + professional_tax + tds + voluntary;
  const net_pay = Math.max(0, gross_earnings - gross_deductions);

  // 7. Line items for the payslip PDF
  const line_items: StatutoryOutput['line_items'] = [];
  if (prorated_basic) line_items.push({ label: 'Basic', type: 'EARNING', amount: prorated_basic });
  if (prorated_hra) line_items.push({ label: 'HRA', type: 'EARNING', amount: prorated_hra });
  if (prorated_special) line_items.push({ label: 'Special Allowance', type: 'EARNING', amount: prorated_special });
  if (prorated_conveyance) line_items.push({ label: 'Conveyance', type: 'EARNING', amount: prorated_conveyance });
  if (prorated_medical) line_items.push({ label: 'Medical Allowance', type: 'EARNING', amount: prorated_medical });
  if (prorated_other) line_items.push({ label: 'Other Allowances', type: 'EARNING', amount: prorated_other });
  if (pf.employee) line_items.push({ label: 'PF (Employee)', type: 'DEDUCTION', amount: pf.employee });
  if (esi.employee) line_items.push({ label: 'ESI (Employee)', type: 'DEDUCTION', amount: esi.employee });
  if (professional_tax) line_items.push({ label: 'Professional Tax', type: 'DEDUCTION', amount: professional_tax });
  if (tds) line_items.push({ label: 'TDS', type: 'DEDUCTION', amount: tds });
  if (voluntary) line_items.push({ label: 'Voluntary Deductions', type: 'DEDUCTION', amount: voluntary });

  return {
    prorated_basic,
    prorated_hra,
    prorated_special,
    prorated_conveyance,
    prorated_medical,
    prorated_other,
    gross_earnings,
    pf_employee: pf.employee,
    pf_employer_eps: pf.employer_eps,
    pf_employer_epf: pf.employer_epf,
    pf_employer_total: pf.employer_total,
    esi_employee: esi.employee,
    esi_employer: esi.employer,
    professional_tax,
    tds,
    gross_deductions,
    net_pay,
    line_items,
  };
}

/** Convenience export — for the payslip PDF that wants every label. */
export function formatStatutoryBreakup(result: StatutoryOutput) {
  return {
    earnings: result.line_items.filter((l) => l.type === 'EARNING'),
    deductions: result.line_items.filter((l) => l.type === 'DEDUCTION'),
    gross_earnings: result.gross_earnings,
    gross_deductions: result.gross_deductions,
    net_pay: result.net_pay,
    employer_contributions: {
      pf_employer_eps: result.pf_employer_eps,
      pf_employer_epf: result.pf_employer_epf,
      esi_employer: result.esi_employer,
    },
  };
}
