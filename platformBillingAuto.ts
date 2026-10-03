// Platform billing — phase 3: automation and self-serve.
//  • The daily auto-invoice run raises each tenant's renewal invoice
//    `auto_invoice_lead_days` (default 7) before its subscription due date, at
//    its negotiated rate card and preferred cycle, and sends it.
//  • The owner's Subscription tab: prices for each cycle, raise an invoice for
//    the cycle they choose, pay it, see their history. Works in read-only
//    (past-grace) mode too — paying is the way out of it.
//  • The existing due-soon / overdue reminders carry the open invoice's link.

import type { Express, Response } from 'express';
import cron from 'node-cron';
import { centralDb } from './db.ts';
import {
  BillingError, getBillingSettings, tenantBillingProfile, effectiveRateCard, activeAddons, issuePlatformInvoice,
  loadInvoice, listInvoices, sendInvoice, cancelInvoice, invoicePageUrl, renderInvoicePdf, razorpayCreds, auditInvoice,
  type PlatformBillingDeps,
} from './platformBillingServer.ts';
import { BILLING_CYCLES, CYCLE_LABEL, computeCycleLines, computeGst, nextPeriod, normaliseCycle, addDaysYmd } from './platformBilling.ts';

const nowIstYmd = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const origin = () => (process.env.FRONTEND_URL ? process.env.FRONTEND_URL.replace(/\/+$/, '') : 'https://erp.atithi-setu.com');
const pdfName = (inv: any) => `${String(inv.invoice_number || inv.id).replace(/[^A-Za-z0-9-]+/g, '_')}.pdf`;

// For the reminder emails: the tenant's latest invoice still awaiting payment.
export async function openInvoiceForReminder(rid: string): Promise<{ amount_due?: number; pay_url?: string; invoice_number?: string }> {
  const r: any = await centralDb.get("SELECT id, invoice_number, total FROM platform_invoices WHERE restaurant_id = ? AND status = 'ISSUED' ORDER BY created_at DESC LIMIT 1", [rid]).catch(() => null);
  return r ? { amount_due: num(r.total), pay_url: invoicePageUrl(origin(), r.id), invoice_number: r.invoice_number } : {};
}

// The tenants due a renewal invoice today. A tenant qualifies when it is active,
// has a saved rate card with auto-invoice on, a due date within the lead time,
// and no open or paid renewal for that period yet.
export async function autoInvoiceCandidates(): Promise<any[]> {
  const s = await getBillingSettings();
  const lead = Math.max(1, Math.min(30, num(s.auto_invoice_lead_days || 7)));
  const horizon = addDaysYmd(nowIstYmd(), lead);
  return centralDb.query(
    `SELECT r.id, r.name, TO_CHAR(r.subscription_due_date, 'YYYY-MM-DD') AS due, c.preferred_cycle
       FROM restaurants r JOIN tenant_rate_cards c ON c.restaurant_id = r.id
      WHERE r.is_active = 1 AND COALESCE(c.auto_invoice, 1) = 1 AND r.subscription_due_date IS NOT NULL
        AND r.subscription_due_date <= CAST(? AS DATE)
        AND NOT EXISTS (SELECT 1 FROM platform_invoices i WHERE i.restaurant_id = r.id AND i.kind = 'RENEWAL'
                        AND i.period_from = r.subscription_due_date AND i.status <> 'CANCELLED')
      ORDER BY r.subscription_due_date`, [horizon]).catch(() => []);
}

let autoRunning = false;
export async function runAutoInvoices(opts: { dry?: boolean; actor?: string } = {}) {
  if (autoRunning && !opts.dry) return { skipped: 'already running', issued: [], failed: [], candidates: [] };
  const candidates = await autoInvoiceCandidates();
  const issued: any[] = [], failed: any[] = [];
  if (opts.dry) return { candidates: candidates.map(c => ({ id: c.id, name: c.name, due: c.due, cycle: normaliseCycle(c.preferred_cycle) })), issued, failed };
  autoRunning = true;
  try {
    for (const c of candidates) {
      try {
        const { invoice, existing } = await issuePlatformInvoice({ restaurantId: c.id, kind: 'RENEWAL', cycle: normaliseCycle(c.preferred_cycle), source: 'AUTO', actor: opts.actor || 'system' });
        if (existing) continue;
        const sent = await sendInvoice(invoice, ['EMAIL', 'WHATSAPP'], origin(), 'system');
        issued.push({ id: c.id, name: c.name, invoice: invoice.invoice_number, total: invoice.total, sent: sent.map(x => `${x.channel}:${x.ok ? 'ok' : 'failed'}`) });
      } catch (e: any) {
        failed.push({ id: c.id, name: c.name, error: e?.message || String(e) });
        if (e instanceof BillingError && e.code === 'SETTINGS_INCOMPLETE') break; // nothing else can be issued either
      }
    }
  } finally { autoRunning = false; }
  return { candidates: candidates.map(c => ({ id: c.id, name: c.name, due: c.due })), issued, failed };
}

const fail = (res: Response, e: any) => {
  if (e instanceof BillingError) return res.status(e.status).json({ error: e.message, code: e.code });
  console.error('[platform-billing]', e);
  return res.status(500).json({ error: 'Billing failed' });
};

export interface AutoDeps extends PlatformBillingDeps {
  // OWNER / built-in MANAGER / platform fast-path, else the role's tab level.
  tabAllowed: (req: any, tab: string, minLevel: number) => Promise<boolean>;
}

export function registerPlatformBillingAuto(app: Express, deps: AutoDeps) {
  const { authenticate, isAdmin } = deps;

  // Owner-facing subscription routes. Tenant from the URL must be the caller's own.
  const gate = async (req: any, res: Response, level: number): Promise<boolean> => {
    const role = String(req.user?.role || '').toUpperCase();
    const platform = role === 'SUPER_ADMIN' || role === 'CTO';
    if (!platform && String(req.user?.restaurantId || '') !== String(req.params.id)) { res.status(403).json({ error: 'Not your property.' }); return false; }
    if (await deps.tabAllowed(req, 'SUBSCRIPTION', level)) return true;
    res.status(403).json({ error: level >= 2 ? 'You need Edit access to Subscription to raise an invoice.' : 'You do not have access to Subscription.' });
    return false;
  };

  app.get('/api/restaurant/:id/subscription', authenticate, async (req: any, res: Response) => {
    try {
      if (!(await gate(req, res, 1))) return;
      const profile = await tenantBillingProfile(req.params.id);
      if (!profile) return res.status(404).json({ error: 'Not found' });
      const s = await getBillingSettings();
      const card = await effectiveRateCard(profile);
      const addons = await activeAddons(req.params.id);
      const today = nowIstYmd();
      const cycles = BILLING_CYCLES.map(c => {
        const { subtotal, lines } = computeCycleLines(card, addons, c);
        const g = computeGst(subtotal, { state: s.state, gstin: s.gstin }, { state: profile.bill_to.state, gstin: profile.bill_to.gstin }, num(s.gst_rate ?? 18));
        return { cycle: c, label: CYCLE_LABEL[c], subtotal, gst: g.tax, total: g.total, lines, period: nextPeriod(profile.due_date, c, today) };
      });
      const invoices = await listInvoices({ restaurantId: req.params.id, limit: 36 });
      const o = deps.appOriginFromReq(req);
      const shaped = invoices.map(i => ({
        id: i.id, invoice_number: i.invoice_number, kind: i.kind, cycle_label: i.cycle_label, status: i.status,
        issue_date: i.issue_date, due_date: i.due_date, period_from: i.period_from, period_to: i.period_to, total: i.total,
        paid_at: i.paid_at, page_url: i.status === 'CANCELLED' ? null : invoicePageUrl(o, i.id),
      }));
      res.json({
        plan: profile.subscription_plan, due_date: profile.due_date, preferred_cycle: card.preferred_cycle,
        cycles, addons: addons.map(a => ({ description: a.description, monthly_amount: num(a.monthly_amount) })),
        open_invoice: shaped.find(i => i.status === 'ISSUED') || null, invoices: shaped,
        online_available: !!razorpayCreds(s), billing_ready: !!(s.gstin && s.state && s.address),
        seller: { name: s.legal_name, brand: s.brand_name, email: s.email, phone: s.phone },
      });
    } catch (e) { fail(res, e); }
  });

  // Raise (or reuse) the renewal invoice for the cycle the owner chose. An open
  // renewal for the same cycle comes back as is; for a different cycle the open
  // one is cancelled (it was never paid) and a new one raised for that cycle.
  app.post('/api/restaurant/:id/subscription/invoices', authenticate, async (req: any, res: Response) => {
    try {
      if (!(await gate(req, res, 2))) return;
      const cycle = normaliseCycle(req.body?.cycle);
      const actor = String(req.user?.email || req.user?.name || req.user?.id || 'owner');
      const open: any = await centralDb.get(
        "SELECT id, cycle FROM platform_invoices WHERE restaurant_id = ? AND kind = 'RENEWAL' AND status = 'ISSUED' ORDER BY created_at DESC LIMIT 1", [req.params.id]).catch(() => null);
      if (open && open.cycle === cycle) {
        const inv = await loadInvoice(open.id);
        return res.json({ invoice: inv, existing: true, page_url: invoicePageUrl(deps.appOriginFromReq(req), open.id) });
      }
      if (open) await cancelInvoice(open.id, `Replaced by a ${CYCLE_LABEL[cycle].toLowerCase()} invoice the owner chose`, actor);
      const { invoice, existing } = await issuePlatformInvoice({ restaurantId: req.params.id, kind: 'RENEWAL', cycle, source: 'TENANT', actor });
      if (!existing) sendInvoice(invoice, ['EMAIL'], deps.appOriginFromReq(req), actor).catch(() => {});
      res.status(existing ? 200 : 201).json({ invoice, existing, page_url: invoicePageUrl(deps.appOriginFromReq(req), invoice.id) });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/restaurant/:id/subscription/invoices/:invId/pdf', authenticate, async (req: any, res: Response) => {
    try {
      if (!(await gate(req, res, 1))) return;
      const inv = await loadInvoice(req.params.invId);
      if (!inv || inv.restaurant_id !== req.params.id) return res.status(404).json({ error: 'Invoice not found' });
      const pdf = await renderInvoicePdf(inv, deps.appOriginFromReq(req));
      await auditInvoice(inv.id, 'PRINTED', String(req.user?.email || req.user?.id || 'owner'), 'subscription tab');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${pdfName(inv)}"`);
      res.send(pdf);
    } catch (e) { fail(res, e); }
  });

  // Admin: preview (dry) or run the auto-invoice pass now.
  app.post('/api/admin/platform-billing/run-auto', authenticate, isAdmin, async (req: any, res: Response) => {
    try {
      const dry = req.body?.dry !== false && String(req.query.dry || '') !== '0';
      res.json(await runAutoInvoices({ dry, actor: String(req.user?.email || 'admin') }));
    } catch (e) { fail(res, e); }
  });

  // 09:15 IST daily: raise and send the renewals that are due.
  cron.schedule('15 9 * * *', async () => {
    try {
      const r = await runAutoInvoices({ actor: 'system' });
      if (r.issued.length || r.failed.length) {
        await deps.notifyPlatformAdmin('SUBSCRIPTION_DUE',
          `🧾 Auto-invoicing: ${r.issued.length} renewal invoice(s) raised${r.issued.length ? ` — ${r.issued.map((x: any) => `${x.name} ${x.invoice}`).join(', ')}` : ''}.${r.failed.length ? ` ${r.failed.length} failed: ${r.failed.map((x: any) => `${x.name} (${x.error})`).join('; ')}` : ''}`).catch(() => {});
      }
    } catch (e) { console.error('[platform-billing] auto-invoice run failed', e); }
  }, { timezone: 'Asia/Kolkata' } as any);
}
