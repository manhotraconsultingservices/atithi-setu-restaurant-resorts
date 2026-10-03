// Platform billing — pure maths for PLM Pundits (brand Atithi-Setu) invoicing
// its tenants. No database, no I/O: the server gathers the rate card, add-ons
// and states, and this decides the lines, the GST split and the service period.
// Unit-tested on its own (test-scripts/platform_billing_check.ts).

export type BillingCycle = 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
export const BILLING_CYCLES: BillingCycle[] = ['MONTHLY', 'QUARTERLY', 'YEARLY'];
export const CYCLE_MONTHS: Record<BillingCycle, number> = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 };
export const CYCLE_LABEL: Record<BillingCycle, string> = { MONTHLY: 'Monthly', QUARTERLY: 'Quarterly', YEARLY: 'Yearly' };

export interface RateCard {
  rate_monthly?: number | string | null;
  rate_quarterly?: number | string | null;
  rate_yearly?: number | string | null;
}
export interface AddonLine { description: string; monthly_amount: number | string; is_active?: number | boolean }
export interface InvoiceLine { description: string; qty: number; rate: number; amount: number }

export const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v: any) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

export const isCycle = (v: any): v is BillingCycle => BILLING_CYCLES.includes(String(v || '').toUpperCase() as BillingCycle);
export const normaliseCycle = (v: any, fallback: BillingCycle = 'MONTHLY'): BillingCycle =>
  isCycle(v) ? String(v).toUpperCase() as BillingCycle : fallback;

// The base price for a cycle. A quarterly price that was never set falls back
// to three months; a yearly one to twelve. A negotiated price always wins.
export function cyclePrice(card: RateCard, cycle: BillingCycle): number {
  const m = num(card.rate_monthly);
  if (cycle === 'MONTHLY') return r2(m);
  if (cycle === 'QUARTERLY') return r2(num(card.rate_quarterly) || m * 3);
  return r2(num(card.rate_yearly) || m * 12);
}

// The lines of a renewal invoice: the plan for the cycle, then each active
// add-on charged as its monthly price times the months in the cycle.
export function computeCycleLines(card: RateCard, addons: AddonLine[], cycle: BillingCycle, planLabel = 'Atithi-Setu subscription'): { lines: InvoiceLine[]; subtotal: number } {
  const months = CYCLE_MONTHS[cycle];
  const lines: InvoiceLine[] = [];
  const base = cyclePrice(card, cycle);
  if (base > 0) lines.push({ description: `${planLabel} (${CYCLE_LABEL[cycle]})`, qty: 1, rate: base, amount: base });
  for (const a of addons || []) {
    if (a.is_active === 0 || a.is_active === false) continue;
    const monthly = num(a.monthly_amount);
    if (!monthly || !String(a.description || '').trim()) continue;
    const amt = r2(monthly * months);
    lines.push({ description: `${String(a.description).trim()} (${months} month${months === 1 ? '' : 's'})`, qty: months, rate: r2(monthly), amount: amt });
  }
  return { lines, subtotal: r2(lines.reduce((s, l) => s + l.amount, 0)) };
}

// Free-form lines for an on-demand invoice: drops blank and non-positive lines,
// recomputes each amount from qty x rate so a client total is never trusted.
export function cleanCustomLines(raw: any[]): InvoiceLine[] {
  const out: InvoiceLine[] = [];
  for (const l of Array.isArray(raw) ? raw : []) {
    const description = String(l?.description || '').trim().slice(0, 200);
    const qty = Number(l?.qty ?? 1);
    const rate = Number(l?.rate ?? l?.amount ?? 0);
    if (!description || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(rate) || rate <= 0) continue;
    out.push({ description, qty: Math.round(qty * 1000) / 1000, rate: r2(rate), amount: r2(qty * rate) });
  }
  return out;
}

// Same-state test for the GST split. When both parties have a GSTIN, its first
// two digits ARE the state code and decide it. Otherwise the state names are
// compared with spaces, hyphens and case ignored ("Andhra Pradesh" = "andhra-pradesh").
const normState = (s: any) => String(s || '').toLowerCase().trim().replace(/[\s\-_]+/g, '');
const gstinState = (g: any) => { const m = String(g || '').trim().toUpperCase().match(/^(\d{2})[A-Z0-9]{13}$/); return m ? m[1] : ''; };
export interface GstParty { state?: string | null; gstin?: string | null }
export function sameState(seller: GstParty, buyer: GstParty): boolean {
  const a = gstinState(seller?.gstin), b = gstinState(buyer?.gstin);
  if (a && b) return a === b;
  const sa = normState(seller?.state), sb = normState(buyer?.state);
  return !!sa && sa === sb;
}

// GST on a pre-tax subtotal. Same state as the seller → CGST + SGST (half each);
// a different or unknown buyer state → IGST. An unknown SELLER state cannot
// decide the split, so it is treated as inter-state (IGST) — the conservative
// reading, flagged to the admin by the settings screen.
export function computeGst(subtotal: number, seller: GstParty, buyer: GstParty, ratePct: number) {
  const rate = Math.max(0, Number(ratePct) || 0);
  const tax = r2(subtotal * rate / 100);
  if (sameState(seller, buyer)) {
    const cgst = r2(tax / 2);
    const sgst = r2(tax - cgst);
    return { intra: true, cgst, sgst, igst: 0, tax: r2(cgst + sgst), total: r2(subtotal + cgst + sgst) };
  }
  return { intra: false, cgst: 0, sgst: 0, igst: tax, tax, total: r2(subtotal + tax) };
}

// YYYY-MM-DD helpers that never touch the host time zone.
export const isYmd = (s: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
export function addMonthsYmd(ymd: string, months: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const targetMonthIndex = (m - 1) + months;
  const ty = y + Math.floor(targetMonthIndex / 12);
  const tm = ((targetMonthIndex % 12) + 12) % 12;
  // Clamp to the last day of the target month: 31 Jan + 1 month = 28/29 Feb.
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const td = Math.min(d, lastDay);
  return `${ty}-${String(tm + 1).padStart(2, '0')}-${String(td).padStart(2, '0')}`;
}
export function addDaysYmd(ymd: string, days: number): string {
  const t = Date.parse(ymd + 'T00:00:00Z') + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

// The service period a renewal pays for. It starts at the current due date so a
// late payer gets no free days; with no due date it starts today. It ends one
// cycle later — that date becomes the new subscription due date once paid.
export function nextPeriod(currentDue: string | null | undefined, cycle: BillingCycle, todayYmd: string): { from: string; to: string } {
  const from = isYmd(currentDue) ? String(currentDue) : todayYmd;
  return { from, to: addMonthsYmd(from, CYCLE_MONTHS[cycle]) };
}

// Indian financial year label for a date: 2026-10-03 → "2026-27".
export function fyLabel(ymd: string): string {
  const [y, m] = ymd.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

// Invoice number: PREFIX/FY/NNNN, e.g. PLM/2026-27/0007.
export function formatInvoiceNumber(prefix: string, ymd: string, seq: number): string {
  const p = String(prefix || 'PLM').replace(/[^A-Za-z0-9-]/g, '').slice(0, 10) || 'PLM';
  return `${p}/${fyLabel(ymd)}/${String(seq).padStart(4, '0')}`;
}
