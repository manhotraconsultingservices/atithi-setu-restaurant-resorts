// Platform billing — server side. PLM Pundits (brand Atithi-Setu) invoices its
// tenants at each tenant's own negotiated rate: GST tax invoices that are never
// deleted (cancel keeps the row and the number), sent by email + WhatsApp,
// paid online through PLM Pundits' OWN Razorpay account or offline (bank/cash),
// and a paid renewal moves the tenant's subscription_due_date forward.
//
// Everything lives in the CENTRAL database (platform_* / tenant_rate_cards /
// tenant_addon_lines, created in db.ts initDb). Pure maths is in
// platformBilling.ts; the PDF in platformInvoicePdf.ts. Registered from
// server.ts via registerPlatformBilling(app, deps) ABOVE the /api/* 404.

import type { Express, Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { centralDb, getNextSequence } from './db.ts';
import { sendEmailAs, sendWhatsAppDetailed } from './notificationService.ts';
import { sealSecret, openSecret } from './paymentSecrets.ts';
import { getGateway } from './paymentGatewayRegistry.ts';
import { rupeesToPaise } from './paymentGateway.ts';
import { generatePlatformInvoicePdf } from './platformInvoicePdf.ts';
import { rupeesInWords } from './invoiceServiceShared.ts';
import {
  BILLING_CYCLES, CYCLE_LABEL, normaliseCycle, isCycle, cyclePrice, computeCycleLines, cleanCustomLines,
  computeGst, nextPeriod, addDaysYmd, fyLabel, formatInvoiceNumber, r2, isYmd, type BillingCycle, type InvoiceLine,
} from './platformBilling.ts';

type Mw = (req: any, res: Response, next: NextFunction) => any;
export interface PlatformBillingDeps {
  authenticate: Mw;
  isAdmin: Mw;
  isAdminOrCto: Mw;
  notifyPlatformAdmin: (eventKey: string, message: string) => Promise<void>;
  appOriginFromReq: (req: Request) => string;
}

const SETTINGS_ID = 'DEFAULT';
const nowIstYmd = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const newId = (p: string) => `${p}-${Date.now()}-${randomBytes(3).toString('hex').toUpperCase()}`;

// Postgres DATE comes back as a JS Date (local midnight) — never .slice() it raw.
export function ymd(v: any): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const s = String(v).slice(0, 10);
  return isYmd(s) ? s : null;
}
const ts = (v: any): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
};
const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clean = (v: any, max = 300) => (v == null ? '' : String(v).trim().slice(0, max));
const GSTIN_RE = /^\d{2}[A-Z0-9]{13}$/;

// ── Settings ───────────────────────────────────────────────────────────────
export async function getBillingSettings(): Promise<any> {
  const row: any = await centralDb.get('SELECT * FROM platform_billing_settings WHERE id = ?', [SETTINGS_ID]).catch(() => null);
  return {
    legal_name: 'PLM Pundits', brand_name: 'Atithi-Setu', sac_code: '998314', gst_rate: 18,
    invoice_prefix: 'PLM', auto_invoice_lead_days: 7, link_expiry_days: 15,
    ...(row || {}),
  };
}
function settingsView(s: any) {
  return {
    legal_name: s.legal_name || '', brand_name: s.brand_name || '', gstin: s.gstin || '', pan: s.pan || '',
    address: s.address || '', city: s.city || '', state: s.state || '', pincode: s.pincode || '',
    email: s.email || '', phone: s.phone || '',
    sac_code: s.sac_code || '998314', gst_rate: num(s.gst_rate ?? 18), invoice_prefix: s.invoice_prefix || 'PLM',
    auto_invoice_lead_days: num(s.auto_invoice_lead_days ?? 7), link_expiry_days: num(s.link_expiry_days ?? 15),
    bank_account_name: s.bank_account_name || '', bank_account_number: s.bank_account_number || '',
    bank_ifsc: s.bank_ifsc || '', bank_name: s.bank_name || '', upi_vpa: s.upi_vpa || '',
    rzp_key_id: s.rzp_key_id || '', rzp_mode: s.rzp_mode || null,
    rzp_key_secret_saved: !!s.rzp_key_secret_sealed, rzp_webhook_secret_saved: !!s.rzp_webhook_secret_sealed,
    verified_at: ts(s.verified_at), last_test_detail: s.last_test_detail || null,
    // What a GST tax invoice cannot be issued without.
    missing: ['legal_name', 'gstin', 'address', 'state'].filter(k => !clean(s[k])),
  };
}
export function razorpayCreds(s: any): Record<string, string> | null {
  if (!s?.rzp_key_id || !s?.rzp_key_secret_sealed) return null;
  try {
    return {
      key_id: String(s.rzp_key_id),
      key_secret: openSecret(s.rzp_key_secret_sealed) || '',
      webhook_secret: s.rzp_webhook_secret_sealed ? (openSecret(s.rzp_webhook_secret_sealed) || '') : '',
    };
  } catch { return null; }
}

// ── Tenant: who is billed ────────────────────────────────────────────────────
export async function tenantBillingProfile(rid: string): Promise<any | null> {
  const r: any = await centralDb.get(
    `SELECT r.id, r.name, r.city, r.state, r.gst_number, r.hotel_full_address, r.signup_details, COALESCE(r.property_type, 'RESTAURANT') AS property_type,
            r.subscription_plan, r.subscription_due_date, r.is_active, COALESCE(r.access_revoked, 0) AS access_revoked,
            COALESCE(oa.owner_name, u.name) AS owner_name, COALESCE(oa.email, u.email, r.admin_id) AS owner_email,
            COALESCE(oa.phone_number, u.phone) AS owner_phone
       FROM restaurants r
       LEFT JOIN LATERAL (SELECT name, email, phone FROM users WHERE restaurant_id = r.id AND role = 'OWNER' ORDER BY id LIMIT 1) u ON TRUE
       LEFT JOIN owner_accounts oa ON LOWER(oa.email) = LOWER(r.admin_id)
      WHERE r.id = ?`, [rid]).catch(() => null);
  if (!r) return null;
  const card: any = await centralDb.get('SELECT * FROM tenant_rate_cards WHERE restaurant_id = ?', [rid]).catch(() => null);
  let signup: any = {};
  try { signup = r.signup_details ? JSON.parse(r.signup_details) : {}; } catch { signup = {}; }
  // Self-signup stores the state as 'N/A'; that is no state at all.
  const realState = (v: any) => { const t = clean(v); return t && !/^n\/?a$/i.test(t) ? t : ''; };
  const defaults = {
    name: clean(r.name) || clean(signup.business_name) || null,
    address: [clean(r.hotel_full_address), clean(r.city) || clean(signup.city)].filter(Boolean).join(', ') || null,
    state: realState(r.state) || realState(signup.state) || null,
    // Only a well-formed GSTIN is printed; junk like a test value means unregistered.
    gstin: GSTIN_RE.test(clean(r.gst_number).toUpperCase()) ? clean(r.gst_number).toUpperCase() : null,
    email: clean(r.owner_email) || clean(signup.email) || null,
    phone: clean(r.owner_phone) || clean(signup.phone) || null,
  };
  return {
    ...r,
    due_date: ymd(r.subscription_due_date),
    card,
    // What the tenant's own profile and registration say. An admin override on
    // the rate card wins field by field; a blank override follows the profile,
    // so later profile changes keep reaching the invoice.
    defaults,
    bill_to: {
      name: clean(card?.bill_to_name) || defaults.name,
      address: clean(card?.bill_to_address) || defaults.address,
      state: clean(card?.bill_to_state) || defaults.state,
      gstin: ((v: string) => GSTIN_RE.test(v) ? v : null)((clean(card?.bill_to_gstin) || defaults.gstin || '').toUpperCase()),
      email: clean(card?.bill_email) || defaults.email,
      phone: clean(card?.bill_phone) || defaults.phone,
      contact: r.owner_name || signup.owner_name || null,
    },
  };
}

// List prices (the six `sequences` rows the Subscription prices page edits)
// pre-fill a tenant's rate card until an admin negotiates one.
async function listPrices(propertyType: string): Promise<{ monthly: number; quarterly: number; yearly: number }> {
  const t = String(propertyType || 'RESTAURANT').toUpperCase();
  const sfx = t === 'HOTEL' ? '_hotel' : t === 'BOTH' ? '_combined' : '';
  const defaults: Record<string, number> = { '': 999, _hotel: 1999, _combined: 2499 };
  const defaultsY: Record<string, number> = { '': 9999, _hotel: 19999, _combined: 24999 };
  const rows: any[] = await centralDb.query('SELECT name, current_value FROM sequences WHERE name IN (?, ?, ?)',
    [`price_monthly${sfx}`, `price_quarterly${sfx}`, `price_annual${sfx}`]).catch(() => []);
  const m: Record<string, number> = {};
  for (const x of rows) m[x.name] = num(x.current_value);
  const monthly = m[`price_monthly${sfx}`] || defaults[sfx];
  return { monthly, quarterly: m[`price_quarterly${sfx}`] || monthly * 3, yearly: m[`price_annual${sfx}`] || defaultsY[sfx] };
}
export async function effectiveRateCard(profile: any) {
  const lp = await listPrices(profile.property_type);
  const c = profile.card || {};
  const has = (v: any) => v != null && v !== '' && num(v) > 0;
  return {
    preferred_cycle: normaliseCycle(c.preferred_cycle),
    auto_invoice: c.auto_invoice == null ? 1 : Number(c.auto_invoice) ? 1 : 0,
    rate_monthly: has(c.rate_monthly) ? num(c.rate_monthly) : lp.monthly,
    rate_quarterly: has(c.rate_quarterly) ? num(c.rate_quarterly) : (has(c.rate_monthly) ? num(c.rate_monthly) * 3 : lp.quarterly),
    rate_yearly: has(c.rate_yearly) ? num(c.rate_yearly) : (has(c.rate_monthly) ? num(c.rate_monthly) * 12 : lp.yearly),
    negotiated: !!profile.card,
    list: lp,
  };
}
export async function activeAddons(rid: string): Promise<any[]> {
  return centralDb.query('SELECT id, description, monthly_amount, is_active FROM tenant_addon_lines WHERE restaurant_id = ? AND is_active = 1 ORDER BY created_at', [rid]).catch(() => []);
}

// ── Audit ────────────────────────────────────────────────────────────────────
export async function auditInvoice(invoiceId: string, action: string, actor: string | null, detail?: any) {
  await centralDb.run('INSERT INTO platform_invoice_audit (id, invoice_id, action, actor, detail) VALUES (?, ?, ?, ?, ?)',
    [newId('PIA'), invoiceId, action, actor || 'system', detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 2000)]).catch(() => {});
}
const actorOf = (req: any) => String(req?.user?.email || req?.user?.name || req?.user?.id || 'admin');

// ── Issue ────────────────────────────────────────────────────────────────────
export class BillingError extends Error { constructor(message: string, readonly status = 400, readonly code = 'BILLING_ERROR', readonly extra: any = {}) { super(message); } }

export interface IssueInput {
  restaurantId: string;
  kind: 'RENEWAL' | 'ON_DEMAND';
  cycle?: BillingCycle;
  lines?: any[];
  extendsSubscription?: boolean;
  notes?: string;
  source: 'AUTO' | 'TENANT' | 'ADMIN';
  actor: string;
}
// Returns { invoice, existing } — a RENEWAL for a period that already has an
// open or paid invoice returns that one instead of minting a second.
export async function issuePlatformInvoice(inp: IssueInput): Promise<{ invoice: any; existing: boolean }> {
  const settings = await getBillingSettings();
  const sv = settingsView(settings);
  if (sv.missing.length) throw new BillingError(`Platform billing details are incomplete (${sv.missing.join(', ')}). Fill them in under Platform billing first.`, 409, 'SETTINGS_INCOMPLETE');
  const profile = await tenantBillingProfile(inp.restaurantId);
  if (!profile) throw new BillingError('Tenant not found', 404, 'NOT_FOUND');
  const today = nowIstYmd();

  let lines: InvoiceLine[] = [];
  let cycle: BillingCycle | null = null;
  let period: { from: string; to: string } | null = null;
  let extendsSub = false;

  if (inp.kind === 'RENEWAL') {
    cycle = normaliseCycle(inp.cycle, normaliseCycle(profile.card?.preferred_cycle));
    period = nextPeriod(profile.due_date, cycle, today);
    const dup: any = await centralDb.get(
      "SELECT id FROM platform_invoices WHERE restaurant_id = ? AND kind = 'RENEWAL' AND period_from = ? AND status <> 'CANCELLED' LIMIT 1",
      [inp.restaurantId, period.from]);
    if (dup) return { invoice: await loadInvoice(dup.id), existing: true };
    const card = await effectiveRateCard(profile);
    const r = computeCycleLines(card, await activeAddons(inp.restaurantId), cycle);
    lines = r.lines;
    extendsSub = true;
  } else {
    lines = cleanCustomLines(inp.lines || []);
    if (inp.extendsSubscription && isCycle(inp.cycle)) {
      cycle = normaliseCycle(inp.cycle);
      period = nextPeriod(profile.due_date, cycle, today);
      extendsSub = true;
    }
  }
  const subtotal = r2(lines.reduce((s, l) => s + l.amount, 0));
  if (!lines.length || subtotal <= 0) throw new BillingError('The invoice has no chargeable lines. Set a rate for this cycle, or add a line with a description, quantity and rate.', 400, 'NO_LINES');

  const seller = {
    name: settings.legal_name, address: settings.address, city: settings.city, state: settings.state, pincode: settings.pincode,
    gstin: String(settings.gstin || '').toUpperCase(), pan: settings.pan, phone: settings.phone, email: settings.email,
  };
  const buyer = {
    name: profile.bill_to.contact || profile.bill_to.name, business: profile.bill_to.name, address: profile.bill_to.address,
    state: profile.bill_to.state, gstin: profile.bill_to.gstin, email: profile.bill_to.email, phone: profile.bill_to.phone, tenant_id: inp.restaurantId,
  };
  const rate = num(settings.gst_rate ?? 18);
  const g = computeGst(subtotal, { state: seller.state, gstin: seller.gstin }, { state: buyer.state, gstin: buyer.gstin }, rate);
  const dueDate = period && period.from > today ? period.from : addDaysYmd(today, 7);

  const invoiceId = newId('PINV');
  // Lines first (no FK), then the invoice row with its number, so a failure
  // can only orphan lines — never leave a numbered invoice with no lines.
  let i = 0;
  for (const l of lines) {
    i++;
    await centralDb.run('INSERT INTO platform_invoice_lines (id, invoice_id, line_no, description, sac, qty, rate, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [newId('PIL'), invoiceId, i, l.description, settings.sac_code || '998314', l.qty, l.rate, l.amount]);
  }
  const seq = await getNextSequence(`platform-invoice-FY${fyLabel(today)}`);
  const number = formatInvoiceNumber(settings.invoice_prefix, today, seq);
  try {
    await centralDb.run(
      `INSERT INTO platform_invoices (id, invoice_number, restaurant_id, kind, cycle, period_from, period_to, extends_subscription, status,
         issue_date, due_date, subtotal, cgst, sgst, igst, gst_rate, total, seller_json, buyer_json, place_of_supply, notes, source, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ISSUED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [invoiceId, number, inp.restaurantId, inp.kind, cycle, period?.from || null, period?.to || null, extendsSub ? 1 : 0,
       today, dueDate, subtotal, g.cgst, g.sgst, g.igst, rate, g.total, JSON.stringify(seller), JSON.stringify(buyer),
       buyer.state || null, clean(inp.notes, 500) || null, inp.source, inp.actor]);
  } catch (e: any) {
    await centralDb.run('DELETE FROM platform_invoice_lines WHERE invoice_id = ?', [invoiceId]).catch(() => {});
    // A concurrent renewal for the same period won the race — hand that one back.
    if (inp.kind === 'RENEWAL' && period && /uq_platform_invoice_renewal|duplicate key/i.test(String(e?.message))) {
      const dup: any = await centralDb.get("SELECT id FROM platform_invoices WHERE restaurant_id = ? AND kind = 'RENEWAL' AND period_from = ? AND status <> 'CANCELLED' LIMIT 1", [inp.restaurantId, period.from]);
      if (dup) return { invoice: await loadInvoice(dup.id), existing: true };
    }
    throw e;
  }
  await auditInvoice(invoiceId, 'CREATED', inp.actor, { number, kind: inp.kind, cycle, total: g.total, source: inp.source });
  return { invoice: await loadInvoice(invoiceId), existing: false };
}

// ── Read ─────────────────────────────────────────────────────────────────────
function shapeInvoice(r: any) {
  const p = (j: any) => { try { return j ? JSON.parse(j) : {}; } catch { return {}; } };
  return {
    id: r.id, invoice_number: r.invoice_number, restaurant_id: r.restaurant_id, tenant_name: r.tenant_name ?? undefined,
    kind: r.kind, cycle: r.cycle, cycle_label: r.cycle ? CYCLE_LABEL[r.cycle as BillingCycle] || r.cycle : null,
    period_from: ymd(r.period_from), period_to: ymd(r.period_to), extends_subscription: !!Number(r.extends_subscription),
    status: r.status, issue_date: ymd(r.issue_date), due_date: ymd(r.due_date),
    subtotal: num(r.subtotal), cgst: num(r.cgst), sgst: num(r.sgst), igst: num(r.igst), gst_rate: num(r.gst_rate), total: num(r.total),
    seller: p(r.seller_json), buyer: p(r.buyer_json), place_of_supply: r.place_of_supply, notes: r.notes,
    source: r.source, created_by: r.created_by, created_at: ts(r.created_at),
    paid_at: ts(r.paid_at), paid_amount: r.paid_amount == null ? null : num(r.paid_amount), payment_ref: r.payment_ref,
    cancelled_at: ts(r.cancelled_at), cancelled_by: r.cancelled_by, cancel_reason: r.cancel_reason,
  };
}
export async function loadInvoice(id: string): Promise<any | null> {
  const r: any = await centralDb.get('SELECT * FROM platform_invoices WHERE id = ?', [id]).catch(() => null);
  if (!r) return null;
  const lines: any[] = await centralDb.query('SELECT description, sac, qty, rate, amount FROM platform_invoice_lines WHERE invoice_id = ? ORDER BY line_no', [id]).catch(() => []);
  return { ...shapeInvoice(r), lines: lines.map(l => ({ description: l.description, sac: l.sac, qty: num(l.qty), rate: num(l.rate), amount: num(l.amount) })) };
}
export async function listInvoices(f: { restaurantId?: string; status?: string; from?: string; to?: string; limit?: number }) {
  const where: string[] = ['1=1']; const params: any[] = [];
  if (f.restaurantId) { where.push('i.restaurant_id = ?'); params.push(f.restaurantId); }
  if (f.status && ['ISSUED', 'PAID', 'CANCELLED'].includes(f.status)) { where.push('i.status = ?'); params.push(f.status); }
  if (isYmd(f.from)) { where.push('i.issue_date >= ?'); params.push(f.from); }
  if (isYmd(f.to)) { where.push('i.issue_date <= ?'); params.push(f.to); }
  const rows: any[] = await centralDb.query(
    `SELECT i.*, r.name AS tenant_name,
            (SELECT a.detail FROM platform_invoice_audit a WHERE a.invoice_id = i.id AND a.action IN ('SENT', 'RECEIPT_SENT') ORDER BY a.created_at DESC LIMIT 1) AS last_send_detail,
            (SELECT a.created_at FROM platform_invoice_audit a WHERE a.invoice_id = i.id AND a.action IN ('SENT', 'RECEIPT_SENT') ORDER BY a.created_at DESC LIMIT 1) AS last_send_at
       FROM platform_invoices i LEFT JOIN restaurants r ON r.id = i.restaurant_id
      WHERE ${where.join(' AND ')} ORDER BY i.created_at DESC LIMIT ${Math.min(2000, Math.max(1, f.limit || 500))}`, params).catch(() => []);
  return rows.map(r => {
    let last_send: any[] = [];
    try { last_send = r.last_send_detail ? JSON.parse(r.last_send_detail) : []; } catch { last_send = []; }
    return { ...shapeInvoice(r), last_send, last_send_at: ts(r.last_send_at) };
  });
}

// ── Token for the public invoice page ────────────────────────────────────────
const TOKEN_SECRET = process.env.PLATFORM_BILLING_TOKEN_SECRET || `${process.env.JWT_SECRET || 'atithi-setu'}:platform-billing`;
export function issueInvoiceToken(invoiceId: string): string {
  const b64 = Buffer.from(invoiceId).toString('base64url');
  return `${b64}.${createHmac('sha256', TOKEN_SECRET).update(invoiceId).digest('base64url').slice(0, 32)}`;
}
export function readInvoiceToken(token: string): string | null {
  try {
    const [b64, sig] = String(token || '').split('.');
    if (!b64 || !sig) return null;
    const id = Buffer.from(b64, 'base64url').toString();
    const want = createHmac('sha256', TOKEN_SECRET).update(id).digest('base64url').slice(0, 32);
    const a = Buffer.from(sig), b = Buffer.from(want);
    return a.length === b.length && timingSafeEqual(a, b) ? id : null;
  } catch { return null; }
}
export const invoicePageUrl = (origin: string, invoiceId: string) => `${origin}/?billing_invoice=${issueInvoiceToken(invoiceId)}`;

// ── PDF ──────────────────────────────────────────────────────────────────────
export async function renderInvoicePdf(inv: any, origin?: string): Promise<Buffer> {
  const s = await getBillingSettings();
  return generatePlatformInvoicePdf({
    invoice_number: inv.invoice_number, issue_date: inv.issue_date, due_date: inv.due_date, status: inv.status,
    brand_name: s.brand_name || 'Atithi-Setu', seller: inv.seller, buyer: inv.buyer, lines: inv.lines,
    subtotal: inv.subtotal, gst_rate: inv.gst_rate, cgst: inv.cgst, sgst: inv.sgst, igst: inv.igst, total: inv.total,
    place_of_supply: inv.place_of_supply, period_from: inv.period_from, period_to: inv.period_to,
    paid_at: inv.paid_at ? ymd(new Date(inv.paid_at)) : null, payment_ref: inv.payment_ref,
    cancelled_at: inv.cancelled_at ? ymd(new Date(inv.cancelled_at)) : null, cancel_reason: inv.cancel_reason,
    pay_url: inv.status === 'ISSUED' && origin ? invoicePageUrl(origin, inv.id) : null,
    amount_in_words: rupeesInWords(inv.total),
    bank: { account_name: s.bank_account_name, account_number: s.bank_account_number, ifsc: s.bank_ifsc, bank_name: s.bank_name, upi_vpa: s.upi_vpa },
  });
}
const pdfName = (inv: any) => `${String(inv.invoice_number || inv.id).replace(/[^A-Za-z0-9-]+/g, '_')}.pdf`;

// ── Cancel / mark paid ───────────────────────────────────────────────────────
// Set by registerPlatformBilling once Razorpay link helpers exist (phase 2).
let cancelOpenLinksHook: ((invoiceId: string) => Promise<void>) | null = null;
export function setCancelOpenLinksHook(fn: (invoiceId: string) => Promise<void>) { cancelOpenLinksHook = fn; }

export async function cancelInvoice(id: string, reason: string, actor: string) {
  if (clean(reason).length < 5) throw new BillingError('Give a reason for cancelling (at least 5 characters).', 400, 'REASON_REQUIRED');
  const row: any = await centralDb.get('SELECT id, status FROM platform_invoices WHERE id = ?', [id]);
  if (!row) throw new BillingError('Invoice not found', 404, 'NOT_FOUND');
  if (row.status === 'PAID') throw new BillingError('A paid invoice cannot be cancelled.', 409, 'INVOICE_PAID');
  if (row.status === 'CANCELLED') return loadInvoice(id);
  const r = await centralDb.run(
    "UPDATE platform_invoices SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, cancelled_by = ?, cancel_reason = ? WHERE id = ? AND status = 'ISSUED'",
    [actor, clean(reason, 500), id]);
  if (!r?.changes) throw new BillingError('The invoice changed while you were cancelling it — reload and try again.', 409, 'CONFLICT');
  await auditInvoice(id, 'CANCELLED', actor, { reason: clean(reason, 500) });
  if (cancelOpenLinksHook) await cancelOpenLinksHook(id).catch(() => {});
  return loadInvoice(id);
}

// The ONE way an invoice becomes paid — online (webhook/sweep) and offline
// (admin) both land here. The status flip is a conditional UPDATE, so a
// webhook racing an admin can only pay it once.
export async function markInvoicePaid(id: string, p: { method: string; reference?: string; paidOn?: string; source: string; actor: string; gateway?: string; gatewayPaymentId?: string; amountPaise?: number; feePaise?: number | null; taxPaise?: number | null; linkId?: string | null }) {
  const inv = await loadInvoice(id);
  if (!inv) throw new BillingError('Invoice not found', 404, 'NOT_FOUND');
  if (inv.status !== 'ISSUED') throw new BillingError(inv.status === 'PAID' ? 'This invoice is already paid.' : 'A cancelled invoice cannot be paid.', 409, inv.status === 'PAID' ? 'ALREADY_PAID' : 'INVOICE_CANCELLED');
  const paidOn = isYmd(p.paidOn) ? String(p.paidOn) : nowIstYmd();
  const reference = clean(p.reference, 120) || null;
  const flip = await centralDb.run(
    "UPDATE platform_invoices SET status = 'PAID', paid_at = ?, paid_amount = total, payment_ref = ? WHERE id = ? AND status = 'ISSUED'",
    [`${paidOn} 12:00:00`, reference, id]);
  if (!flip?.changes) throw new BillingError('This invoice is already paid.', 409, 'ALREADY_PAID');
  const gateway = p.gateway || 'OFFLINE';
  await centralDb.run(
    `INSERT INTO platform_payments (id, invoice_id, link_id, gateway, gateway_payment_id, amount_paise, fee_paise, tax_paise, method, source, reference, paid_at, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (gateway, gateway_payment_id) DO NOTHING`,
    [newId('PPAY'), id, p.linkId || null, gateway, p.gatewayPaymentId || `OFF-${id}`, p.amountPaise ?? rupeesToPaise(inv.total),
     p.feePaise ?? null, p.taxPaise ?? null, clean(p.method, 20).toUpperCase() || 'BANK', p.source, reference, `${paidOn} 12:00:00`, p.actor]);
  await centralDb.run(
    `UPDATE restaurants SET last_payment_date = ?, last_payment_amount = ?, last_payment_reference = ?
       ${inv.extends_subscription && inv.period_to ? ", subscription_due_date = GREATEST(subscription_due_date, CAST(? AS DATE))" : ''}
     WHERE id = ?`,
    inv.extends_subscription && inv.period_to
      ? [paidOn, inv.total, `${inv.invoice_number}${reference ? ` · ${reference}` : ''}`, inv.period_to, inv.restaurant_id]
      : [paidOn, inv.total, `${inv.invoice_number}${reference ? ` · ${reference}` : ''}`, inv.restaurant_id]);
  await auditInvoice(id, 'PAID', p.actor, { method: p.method, source: p.source, reference, gateway, extends_to: inv.extends_subscription ? inv.period_to : null });
  return loadInvoice(id);
}

// ── Send ─────────────────────────────────────────────────────────────────────
const money = (n: number) => `Rs. ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
async function logPlatformMessage(rid: string, channel: string, providerId: string | undefined | null, status: string, eventName: string, templateName: string | null) {
  if (!providerId) return;
  await centralDb.run(
    `INSERT INTO messaging_usage (provider_message_id, restaurant_id, channel, category, template_name, event_name, audience, status)
     VALUES (?, ?, ?, 'UTILITY', ?, ?, 'PLATFORM', ?) ON CONFLICT (provider_message_id) DO NOTHING`,
    [providerId, rid, channel, templateName, eventName, status]).catch(() => {});
}
export interface SendOutcome { channel: string; ok: boolean; to?: string | null; error?: string }
export async function sendInvoice(inv: any, channels: string[], origin: string, actor: string, kind: 'INVOICE' | 'RECEIPT' = 'INVOICE', override?: { email?: string | null; phone?: string | null }): Promise<SendOutcome[]> {
  const s = await getBillingSettings();
  const brand = s.brand_name || 'Atithi-Setu';
  // A one-off recipient replaces the tenant's address for this send only (the
  // invoice itself is unchanged): "send me a copy", or a test to your own phone.
  // Where to send is NOT part of the invoice: the buyer snapshot keeps the legal
  // fields frozen, but email and WhatsApp follow the tenant's CURRENT billing
  // contact, so a phone added after the invoice was raised is used.
  const current = await tenantBillingProfile(inv.restaurant_id).catch(() => null);
  const to = {
    ...(inv.buyer || {}),
    email: override?.email || current?.bill_to?.email || inv.buyer?.email || null,
    phone: override?.phone || current?.bill_to?.phone || inv.buyer?.phone || null,
  };
  const pageUrl = invoicePageUrl(origin, inv.id);
  const out: SendOutcome[] = [];
  const isReceipt = kind === 'RECEIPT' || inv.status === 'PAID';
  const period = inv.period_from && inv.period_to ? ` for ${inv.period_from} to ${inv.period_to}` : '';
  if (channels.includes('EMAIL')) {
    if (!to.email) out.push({ channel: 'EMAIL', ok: false, error: 'No billing email on this tenant' });
    else {
      const subject = isReceipt
        ? `Payment received — ${inv.invoice_number} — ${brand}`
        : `${brand} invoice ${inv.invoice_number} — ${money(inv.total)} due ${inv.due_date || ''}`.trim();
      const text = isReceipt
        ? `Dear ${to.name || to.business || 'customer'},\n\nWe have received ${money(inv.total)} against invoice ${inv.invoice_number}${period}. Thank you.\n\nThe paid invoice is attached.\n\n${s.legal_name} (${brand})`
        : `Dear ${to.name || to.business || 'customer'},\n\nPlease find attached tax invoice ${inv.invoice_number} for your ${brand} subscription${period}.\n\nAmount payable: ${money(inv.total)}\nDue date: ${inv.due_date || '-'}\n\nView and pay online: ${pageUrl}\n\n${s.legal_name} (${brand})`;
      const html = isReceipt
        ? `<p>Dear ${to.name || to.business || 'customer'},</p><p>We have received <b>${money(inv.total)}</b> against invoice <b>${inv.invoice_number}</b>${period}. Thank you.</p><p>The paid invoice is attached.</p><p>${s.legal_name} (${brand})</p>`
        : `<p>Dear ${to.name || to.business || 'customer'},</p><p>Please find attached tax invoice <b>${inv.invoice_number}</b> for your ${brand} subscription${period}.</p>
           <p>Amount payable: <b>${money(inv.total)}</b><br/>Due date: ${inv.due_date || '-'}</p>
           <p><a href="${pageUrl}" style="display:inline-block;background:#0E7490;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">View &amp; pay online</a></p>
           <p style="color:#6b5d52;font-size:12px">${s.legal_name} (${brand})</p>`;
      try {
        const pdf = await renderInvoicePdf(inv, origin);
        const r = await sendEmailAs(null, to.email, subject, text, html, [{ filename: pdfName(inv), content: pdf, contentType: 'application/pdf' }]);
        out.push({ channel: 'EMAIL', ok: !!r.ok, to: to.email, error: r.ok ? undefined : (r.error || 'Email was not accepted') });
      } catch (e: any) { out.push({ channel: 'EMAIL', ok: false, to: to.email, error: e?.message || 'Email failed' }); }
    }
  }
  if (channels.includes('WHATSAPP')) {
    if (!to.phone) out.push({ channel: 'WHATSAPP', ok: false, error: 'No billing phone on this tenant' });
    else {
      const eventName = isReceipt ? 'PLATFORM_RECEIPT' : 'PLATFORM_INVOICE';
      // Meta only accepts a business-initiated message as an approved template.
      // Use the platform event's own template when one is mapped; otherwise the
      // approved guest templates whose variables fit: payment_request (sender,
      // name, amount, link) for an invoice, invoice_ready (sender, name, amount,
      // number) for a receipt.
      let map: any = await centralDb.get('SELECT template_name, language FROM wa_template_map WHERE event_name = ?', [eventName]).catch(() => null);
      let fallback = false;
      if (!map?.template_name) {
        map = await centralDb.get('SELECT template_name, language FROM wa_template_map WHERE event_name = ?', [isReceipt ? 'HOTEL_INVOICE_SENT' : 'PAYMENT_LINK_SENT']).catch(() => null);
        fallback = !!map?.template_name;
      }
      const rupee = (n: number) => '\u20b9' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
      const msg = isReceipt
        ? `${brand}: payment of ${money(inv.total)} received for invoice ${inv.invoice_number}. Thank you! Invoice: ${pageUrl}`
        : `${brand}: invoice ${inv.invoice_number} for ${money(inv.total)}${period} is due ${inv.due_date || ''}. View and pay online: ${pageUrl}`;
      const tpl = map?.template_name ? {
        name: map.template_name, languageCode: map.language || 'en',
        variables: fallback
          ? (isReceipt
            ? [brand, to.business || to.name || 'Customer', rupee(inv.total), inv.invoice_number]
            : [brand, to.business || to.name || 'Customer', rupee(inv.total), pageUrl])
          : (isReceipt
            ? [to.business || to.name || 'Customer', inv.invoice_number, money(inv.total), pageUrl]
            : [to.business || to.name || 'Customer', inv.invoice_number, money(inv.total), inv.due_date || '-', pageUrl]),
      } : null;
      try {
        const r = await sendWhatsAppDetailed(to.phone, msg, tpl);
        await logPlatformMessage(inv.restaurant_id, 'WHATSAPP', r.id, r.ok ? 'SENT' : 'FAILED', eventName, tpl?.name || null);
        out.push({ channel: 'WHATSAPP', ok: !!r.ok, to: to.phone, error: r.ok ? undefined : (r.error || 'WhatsApp was not accepted') });
      } catch (e: any) { out.push({ channel: 'WHATSAPP', ok: false, to: to.phone, error: e?.message || 'WhatsApp failed' }); }
    }
  }
  await auditInvoice(inv.id, isReceipt ? 'RECEIPT_SENT' : 'SENT', actor, out.map(o => ({ channel: o.channel, ok: o.ok, error: o.error, ...(override?.email || override?.phone ? { to: o.to, one_off: true } : {}) })));
  return out;
}

// ── Routes ───────────────────────────────────────────────────────────────────
const fail = (res: Response, e: any) => {
  if (e instanceof BillingError) return res.status(e.status).json({ error: e.message, code: e.code, ...e.extra });
  console.error('[platform-billing]', e);
  return res.status(500).json({ error: 'Platform billing failed' });
};

export function registerPlatformBilling(app: Express, deps: PlatformBillingDeps) {
  const { authenticate, isAdmin, isAdminOrCto, appOriginFromReq } = deps;

  // Settings (secrets write-only).
  app.get('/api/admin/platform-billing/settings', authenticate, isAdminOrCto, async (_req, res) => {
    try { res.json(settingsView(await getBillingSettings())); } catch (e) { fail(res, e); }
  });
  app.put('/api/admin/platform-billing/settings', authenticate, isAdmin, async (req: any, res) => {
    try {
      const b = req.body || {};
      const gstin = clean(b.gstin, 15).toUpperCase();
      if (gstin && !GSTIN_RE.test(gstin)) throw new BillingError('GSTIN must be 15 characters: 2-digit state code then 13 letters/digits.', 400, 'BAD_GSTIN');
      const rate = Number(b.gst_rate ?? 18);
      if (!Number.isFinite(rate) || rate < 0 || rate > 28) throw new BillingError('GST rate must be between 0 and 28.', 400, 'BAD_RATE');
      const lead = Math.round(Number(b.auto_invoice_lead_days ?? 7));
      if (!(lead >= 1 && lead <= 30)) throw new BillingError('Auto-invoice lead time must be 1 to 30 days.', 400, 'BAD_LEAD');
      const expiry = Math.round(Number(b.link_expiry_days ?? 15));
      if (!(expiry >= 1 && expiry <= 60)) throw new BillingError('Payment link expiry must be 1 to 60 days.', 400, 'BAD_EXPIRY');
      const prefix = clean(b.invoice_prefix || 'PLM', 10).toUpperCase();
      if (!/^[A-Z0-9-]{1,10}$/.test(prefix)) throw new BillingError('Invoice prefix may use letters, digits and hyphens only (max 10).', 400, 'BAD_PREFIX');
      const keyId = clean(b.rzp_key_id, 60);
      if (keyId && !/^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId)) throw new BillingError('Razorpay Key ID should look like rzp_test_… or rzp_live_….', 400, 'BAD_KEY_ID');
      const cur: any = await centralDb.get('SELECT * FROM platform_billing_settings WHERE id = ?', [SETTINGS_ID]).catch(() => null);
      // A blank secret keeps the saved one; `clear_rzp` wipes the gateway.
      const secretSealed = b.clear_rzp ? null : (clean(b.rzp_key_secret, 200) ? sealSecret(clean(b.rzp_key_secret, 200)) : (cur?.rzp_key_secret_sealed || null));
      const whSealed = b.clear_rzp ? null : (clean(b.rzp_webhook_secret, 200) ? sealSecret(clean(b.rzp_webhook_secret, 200)) : (cur?.rzp_webhook_secret_sealed || null));
      const vals = [
        clean(b.legal_name, 200) || 'PLM Pundits', clean(b.brand_name, 100) || 'Atithi-Setu', gstin || null, clean(b.pan, 10).toUpperCase() || null,
        clean(b.address, 300) || null, clean(b.city, 100) || null, clean(b.state, 100) || null, clean(b.pincode, 10) || null,
        clean(b.email, 200) || null, clean(b.phone, 30) || null, clean(b.sac_code, 10) || '998314', rate, prefix, lead, expiry,
        clean(b.bank_account_name, 120) || null, clean(b.bank_account_number, 40) || null, clean(b.bank_ifsc, 15).toUpperCase() || null,
        clean(b.bank_name, 120) || null, clean(b.upi_vpa, 100) || null,
        b.clear_rzp ? null : (keyId || cur?.rzp_key_id || null), secretSealed, whSealed,
        b.clear_rzp ? null : ((keyId || cur?.rzp_key_id || '').startsWith('rzp_live_') ? 'LIVE' : (keyId || cur?.rzp_key_id) ? 'TEST' : null),
        actorOf(req),
      ];
      await centralDb.run(
        `INSERT INTO platform_billing_settings (id, legal_name, brand_name, gstin, pan, address, city, state, pincode, email, phone, sac_code, gst_rate,
           invoice_prefix, auto_invoice_lead_days, link_expiry_days, bank_account_name, bank_account_number, bank_ifsc, bank_name, upi_vpa,
           rzp_key_id, rzp_key_secret_sealed, rzp_webhook_secret_sealed, rzp_mode, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO UPDATE SET legal_name = EXCLUDED.legal_name, brand_name = EXCLUDED.brand_name, gstin = EXCLUDED.gstin, pan = EXCLUDED.pan,
           address = EXCLUDED.address, city = EXCLUDED.city, state = EXCLUDED.state, pincode = EXCLUDED.pincode, email = EXCLUDED.email, phone = EXCLUDED.phone,
           sac_code = EXCLUDED.sac_code, gst_rate = EXCLUDED.gst_rate, invoice_prefix = EXCLUDED.invoice_prefix,
           auto_invoice_lead_days = EXCLUDED.auto_invoice_lead_days, link_expiry_days = EXCLUDED.link_expiry_days,
           bank_account_name = EXCLUDED.bank_account_name, bank_account_number = EXCLUDED.bank_account_number, bank_ifsc = EXCLUDED.bank_ifsc,
           bank_name = EXCLUDED.bank_name, upi_vpa = EXCLUDED.upi_vpa, rzp_key_id = EXCLUDED.rzp_key_id,
           rzp_key_secret_sealed = EXCLUDED.rzp_key_secret_sealed, rzp_webhook_secret_sealed = EXCLUDED.rzp_webhook_secret_sealed,
           rzp_mode = EXCLUDED.rzp_mode, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
        [SETTINGS_ID, ...vals]);
      res.json(settingsView(await getBillingSettings()));
    } catch (e) { fail(res, e); }
  });
  app.post('/api/admin/platform-billing/settings/test', authenticate, isAdmin, async (req: any, res) => {
    try {
      const s = await getBillingSettings();
      const creds = razorpayCreds(s);
      if (!creds) throw new BillingError('Save the Razorpay Key ID and Key Secret first.', 400, 'NO_KEYS');
      const gw = getGateway('RAZORPAY');
      try {
        const r = await gw.testConnection(creds as any);
        await centralDb.run('UPDATE platform_billing_settings SET verified_at = CURRENT_TIMESTAMP, last_test_detail = ?, rzp_mode = COALESCE(?, rzp_mode) WHERE id = ?', [r.detail || 'OK', r.mode, SETTINGS_ID]);
        res.json({ ok: true, mode: r.mode, detail: r.detail });
      } catch (e: any) {
        await centralDb.run('UPDATE platform_billing_settings SET verified_at = NULL, last_test_detail = ? WHERE id = ?', [String(e?.message || 'Failed').slice(0, 300), SETTINGS_ID]).catch(() => {});
        res.status(400).json({ ok: false, error: e?.message || 'Razorpay rejected the keys' });
      }
    } catch (e) { fail(res, e); }
  });

  // Rate card + add-ons.
  app.get('/api/admin/tenants/:id/rate-card', authenticate, isAdminOrCto, async (req: any, res) => {
    try {
      const profile = await tenantBillingProfile(req.params.id);
      if (!profile) return res.status(404).json({ error: 'Tenant not found' });
      const card = await effectiveRateCard(profile);
      const addons: any[] = await centralDb.query('SELECT id, description, monthly_amount, is_active, created_at FROM tenant_addon_lines WHERE restaurant_id = ? ORDER BY created_at', [req.params.id]).catch(() => []);
      const s = await getBillingSettings();
      const preview = BILLING_CYCLES.map(c => {
        const { subtotal } = computeCycleLines(card, addons.filter(a => Number(a.is_active)), c);
        const g = computeGst(subtotal, { state: s.state, gstin: s.gstin }, { state: profile.bill_to.state, gstin: profile.bill_to.gstin }, num(s.gst_rate ?? 18));
        return { cycle: c, label: CYCLE_LABEL[c], subtotal, gst: g.tax, total: g.total, period: nextPeriod(profile.due_date, c, nowIstYmd()) };
      });
      const lead = Math.max(1, Math.min(30, num(s.auto_invoice_lead_days || 7)));
      const today = nowIstYmd();
      const reasons: string[] = [];
      if (!profile.card) reasons.push('the rate card has not been saved for this tenant (list prices are only a suggestion)');
      else if (!Number(profile.card.auto_invoice ?? 1)) reasons.push('automatic invoicing is switched off on the rate card');
      if (!profile.due_date) reasons.push('no subscription due date is set (Billing tab)');
      if (Number(profile.is_active) !== 1) reasons.push('the tenant is not active');
      if (settingsView(s).missing.length) reasons.push('PLM Pundits company details are incomplete');
      const nextRun = profile.due_date ? (addDaysYmd(profile.due_date, -lead) < today ? today : addDaysYmd(profile.due_date, -lead)) : null;
      const openRenewal: any = profile.due_date ? await centralDb.get("SELECT invoice_number FROM platform_invoices WHERE restaurant_id = ? AND kind = 'RENEWAL' AND period_from = ? AND status <> 'CANCELLED' LIMIT 1", [req.params.id, profile.due_date]).catch(() => null) : null;
      const auto = {
        active: reasons.length === 0, reasons, lead_days: lead, next_run: reasons.length ? null : nextRun,
        already_raised: openRenewal?.invoice_number || null,
        channels: { email: !!profile.bill_to.email, whatsapp: !!profile.bill_to.phone },
      };
      res.json({
        ...card, due_date: profile.due_date, property_type: profile.property_type, auto,
        bill_to: profile.bill_to, defaults: profile.defaults, overrides: {
          bill_to_name: profile.card?.bill_to_name || '', bill_to_address: profile.card?.bill_to_address || '', bill_to_state: profile.card?.bill_to_state || '',
          bill_to_gstin: profile.card?.bill_to_gstin || '', bill_email: profile.card?.bill_email || '', bill_phone: profile.card?.bill_phone || '',
        },
        addons: addons.map(a => ({ id: a.id, description: a.description, monthly_amount: num(a.monthly_amount), is_active: !!Number(a.is_active) })),
        preview,
      });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/admin/tenants/:id/rate-card', authenticate, isAdmin, async (req: any, res) => {
    try {
      const b = req.body || {};
      const t: any = await centralDb.get('SELECT id FROM restaurants WHERE id = ?', [req.params.id]);
      if (!t) return res.status(404).json({ error: 'Tenant not found' });
      const price = (v: any, label: string) => {
        if (v === '' || v == null) return null;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 10000000) throw new BillingError(`${label} must be a positive amount.`, 400, 'BAD_PRICE');
        return r2(n);
      };
      const gst = clean(b.bill_to_gstin, 15).toUpperCase();
      if (gst && !GSTIN_RE.test(gst)) throw new BillingError('Bill-to GSTIN must be 15 characters.', 400, 'BAD_GSTIN');
      await centralDb.run(
        `INSERT INTO tenant_rate_cards (restaurant_id, preferred_cycle, rate_monthly, rate_quarterly, rate_yearly, auto_invoice,
           bill_to_name, bill_to_address, bill_to_state, bill_to_gstin, bill_email, bill_phone, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (restaurant_id) DO UPDATE SET preferred_cycle = EXCLUDED.preferred_cycle, rate_monthly = EXCLUDED.rate_monthly,
           rate_quarterly = EXCLUDED.rate_quarterly, rate_yearly = EXCLUDED.rate_yearly, auto_invoice = EXCLUDED.auto_invoice,
           bill_to_name = EXCLUDED.bill_to_name, bill_to_address = EXCLUDED.bill_to_address, bill_to_state = EXCLUDED.bill_to_state,
           bill_to_gstin = EXCLUDED.bill_to_gstin, bill_email = EXCLUDED.bill_email, bill_phone = EXCLUDED.bill_phone,
           updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
        [req.params.id, normaliseCycle(b.preferred_cycle), price(b.rate_monthly, 'Monthly price'), price(b.rate_quarterly, 'Quarterly price'),
         price(b.rate_yearly, 'Yearly price'), b.auto_invoice === 0 || b.auto_invoice === false ? 0 : 1,
         clean(b.bill_to_name, 200) || null, clean(b.bill_to_address, 300) || null, clean(b.bill_to_state, 100) || null, gst || null,
         clean(b.bill_email, 200) || null, clean(b.bill_phone, 30) || null, actorOf(req)]);
      res.json({ success: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/admin/tenants/:id/addons', authenticate, isAdmin, async (req: any, res) => {
    try {
      const d = clean(req.body?.description, 200); const amt = Number(req.body?.monthly_amount);
      if (!d) throw new BillingError('Describe the add-on.', 400, 'BAD_ADDON');
      if (!Number.isFinite(amt) || amt <= 0) throw new BillingError('Monthly amount must be more than zero.', 400, 'BAD_ADDON');
      const id = newId('ADDON');
      await centralDb.run('INSERT INTO tenant_addon_lines (id, restaurant_id, description, monthly_amount, updated_by) VALUES (?, ?, ?, ?, ?)', [id, req.params.id, d, r2(amt), actorOf(req)]);
      res.json({ id });
    } catch (e) { fail(res, e); }
  });
  app.patch('/api/admin/tenants/:id/addons/:addonId', authenticate, isAdmin, async (req: any, res) => {
    try {
      const cur: any = await centralDb.get('SELECT * FROM tenant_addon_lines WHERE id = ? AND restaurant_id = ?', [req.params.addonId, req.params.id]);
      if (!cur) return res.status(404).json({ error: 'Add-on not found' });
      const d = req.body?.description != null ? clean(req.body.description, 200) : cur.description;
      const amt = req.body?.monthly_amount != null ? Number(req.body.monthly_amount) : num(cur.monthly_amount);
      if (!d || !Number.isFinite(amt) || amt <= 0) throw new BillingError('Add-on needs a description and an amount above zero.', 400, 'BAD_ADDON');
      const active = req.body?.is_active == null ? Number(cur.is_active) : (req.body.is_active ? 1 : 0);
      await centralDb.run('UPDATE tenant_addon_lines SET description = ?, monthly_amount = ?, is_active = ?, updated_by = ? WHERE id = ?', [d, r2(amt), active, actorOf(req), req.params.addonId]);
      res.json({ success: true });
    } catch (e) { fail(res, e); }
  });
  // Soft delete: an add-on billed on past invoices keeps its history.
  app.delete('/api/admin/tenants/:id/addons/:addonId', authenticate, isAdmin, async (req: any, res) => {
    try {
      const r = await centralDb.run('UPDATE tenant_addon_lines SET is_active = 0, updated_by = ? WHERE id = ? AND restaurant_id = ?', [actorOf(req), req.params.addonId, req.params.id]);
      if (!r?.changes) return res.status(404).json({ error: 'Add-on not found' });
      res.json({ success: true });
    } catch (e) { fail(res, e); }
  });

  // Invoices.
  app.get('/api/admin/platform-invoices', authenticate, isAdminOrCto, async (req: any, res) => {
    try {
      const rows = await listInvoices({ restaurantId: clean(req.query.tenant, 80) || undefined, status: clean(req.query.status, 20).toUpperCase() || undefined, from: clean(req.query.from, 10), to: clean(req.query.to, 10) });
      if (String(req.query.format || '') === 'csv') {
        const esc = (v: any) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
        const head = ['Invoice no', 'Invoice date', 'Tenant', 'Tenant ID', 'Buyer GSTIN', 'Place of supply', 'Taxable value', 'CGST', 'SGST', 'IGST', 'Total', 'Status', 'Kind', 'Period from', 'Period to', 'Paid on', 'Payment ref'];
        const body = rows.map(r => [r.invoice_number, r.issue_date, r.buyer?.business || r.tenant_name, r.restaurant_id, r.buyer?.gstin || '', r.place_of_supply || '', r.subtotal, r.cgst, r.sgst, r.igst, r.total, r.status, r.kind, r.period_from || '', r.period_to || '', r.paid_at ? ymd(new Date(r.paid_at)) : '', r.payment_ref || ''].map(esc).join(','));
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="platform-invoices-${nowIstYmd()}.csv"`);
        return res.send([head.join(','), ...body].join('\n'));
      }
      res.json({ invoices: rows });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/admin/platform-invoices/:invId', authenticate, isAdminOrCto, async (req: any, res) => {
    try {
      const inv = await loadInvoice(req.params.invId);
      if (!inv) return res.status(404).json({ error: 'Invoice not found' });
      const audit = await centralDb.query('SELECT action, actor, detail, created_at FROM platform_invoice_audit WHERE invoice_id = ? ORDER BY created_at', [inv.id]).catch(() => []);
      const payments = await centralDb.query('SELECT gateway, gateway_payment_id, amount_paise, fee_paise, method, source, reference, paid_at FROM platform_payments WHERE invoice_id = ? ORDER BY created_at', [inv.id]).catch(() => []);
      const links = await centralDb.query('SELECT id, url, status, amount_paise, expires_at, sent_channels, created_at, paid_at FROM platform_payment_links WHERE invoice_id = ? ORDER BY created_at DESC', [inv.id]).catch(() => []);
      res.json({ ...inv, page_url: invoicePageUrl(appOriginFromReq(req), inv.id), audit, payments, links });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/admin/platform-invoices/:invId/pdf', authenticate, isAdminOrCto, async (req: any, res) => {
    try {
      const inv = await loadInvoice(req.params.invId);
      if (!inv) return res.status(404).json({ error: 'Invoice not found' });
      const pdf = await renderInvoicePdf(inv, appOriginFromReq(req));
      await auditInvoice(inv.id, 'PRINTED', actorOf(req), 'admin');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${pdfName(inv)}"`);
      res.send(pdf);
    } catch (e) { fail(res, e); }
  });
  app.post('/api/admin/tenants/:id/platform-invoices', authenticate, isAdmin, async (req: any, res) => {
    try {
      const b = req.body || {};
      const kind = String(b.kind || 'RENEWAL').toUpperCase() === 'ON_DEMAND' ? 'ON_DEMAND' : 'RENEWAL';
      const { invoice, existing } = await issuePlatformInvoice({
        restaurantId: req.params.id, kind, cycle: b.cycle, lines: b.lines, extendsSubscription: !!b.extends_subscription,
        notes: b.notes, source: 'ADMIN', actor: actorOf(req),
      });
      let sent: SendOutcome[] = [];
      const channels = (Array.isArray(b.send) ? b.send : []).map((c: any) => String(c).toUpperCase()).filter((c: string) => ['EMAIL', 'WHATSAPP'].includes(c));
      if (!existing && channels.length) sent = await sendInvoice(invoice, channels, appOriginFromReq(req), actorOf(req));
      res.status(existing ? 200 : 201).json({ invoice, existing, sent });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/admin/platform-invoices/:invId/send', authenticate, isAdmin, async (req: any, res) => {
    try {
      const inv = await loadInvoice(req.params.invId);
      if (!inv) return res.status(404).json({ error: 'Invoice not found' });
      if (inv.status === 'CANCELLED') throw new BillingError('A cancelled invoice cannot be sent.', 409, 'INVOICE_CANCELLED');
      const channels = (Array.isArray(req.body?.channels) ? req.body.channels : ['EMAIL', 'WHATSAPP']).map((c: any) => String(c).toUpperCase()).filter((c: string) => ['EMAIL', 'WHATSAPP'].includes(c));
      if (!channels.length) throw new BillingError('Choose email, WhatsApp or both.', 400, 'NO_CHANNEL');
      const toEmail = clean(req.body?.to_email, 200), toPhone = clean(req.body?.to_phone, 30);
      if (toEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toEmail)) throw new BillingError('That email address does not look right.', 400, 'BAD_EMAIL');
      if (toPhone && String(toPhone).replace(/[^0-9]/g, '').length < 10) throw new BillingError('Enter the WhatsApp number with at least 10 digits (add +country code outside India).', 400, 'BAD_PHONE');
      res.json({ sent: await sendInvoice(inv, channels, appOriginFromReq(req), actorOf(req), inv.status === 'PAID' ? 'RECEIPT' : 'INVOICE', { email: toEmail || null, phone: toPhone || null }) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/admin/platform-invoices/:invId/cancel', authenticate, isAdmin, async (req: any, res) => {
    try { res.json({ invoice: await cancelInvoice(req.params.invId, req.body?.reason, actorOf(req)) }); } catch (e) { fail(res, e); }
  });
  app.post('/api/admin/platform-invoices/:invId/mark-paid', authenticate, isAdmin, async (req: any, res) => {
    try {
      const method = String(req.body?.method || 'BANK').toUpperCase();
      if (!['BANK', 'CASH', 'CHEQUE', 'UPI', 'OTHER'].includes(method)) throw new BillingError('Method must be BANK, CASH, CHEQUE, UPI or OTHER.', 400, 'BAD_METHOD');
      if (method !== 'CASH' && clean(req.body?.reference).length < 3) throw new BillingError('Give the transfer / cheque / UPI reference.', 400, 'REFERENCE_REQUIRED');
      const paidOn = clean(req.body?.paid_on, 10);
      if (paidOn && (!isYmd(paidOn) || paidOn > nowIstYmd())) throw new BillingError('Paid-on date must be a date, not in the future.', 400, 'BAD_DATE');
      const invoice = await markInvoicePaid(req.params.invId, { method, reference: req.body?.reference, paidOn, source: 'ADMIN', actor: actorOf(req) });
      const origin = appOriginFromReq(req);
      if (req.body?.send_receipt !== false) setImmediate(() => { sendInvoice(invoice, ['EMAIL'], origin, 'system', 'RECEIPT').catch(() => {}); });
      deps.notifyPlatformAdmin('SUBSCRIPTION_DUE', `💰 ${invoice?.buyer?.business || invoice?.restaurant_id} paid ${invoice?.invoice_number} (${money(invoice?.total)}) by ${method}.`).catch(() => {});
      res.json({ invoice });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/admin/tenants/:id/platform-invoices', authenticate, isAdminOrCto, async (req: any, res) => {
    try { res.json({ invoices: await listInvoices({ restaurantId: req.params.id, limit: 200 }) }); } catch (e) { fail(res, e); }
  });
}
