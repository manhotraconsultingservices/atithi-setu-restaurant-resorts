// Platform billing — phase 2: online payment through PLM Pundits' OWN payment
// gateways (Razorpay, PhonePe, Paytm — several may be on; see
// platformBillingGateways.ts). The gateway's API is the truth: a webhook only
// says "look again", and a 5-minute sweep catches any webhook that never
// arrived. One live link per invoice and gateway; the public invoice page mints
// a fresh one when the last expired. Every payment lands through
// markInvoicePaid (platformBillingServer.ts), the one place an invoice becomes
// paid and the subscription moves forward.

import type { Express, Response } from 'express';
import { createHmac, randomBytes } from 'crypto';
import { centralDb } from './db.ts';
import { rupeesToPaise } from './paymentGateway.ts';
import {
  BillingError, getBillingSettings, loadInvoice, markInvoicePaid, sendInvoice, auditInvoice,
  invoicePageUrl, readInvoiceToken, renderInvoicePdf, setCancelOpenLinksHook, type PlatformBillingDeps,
} from './platformBillingServer.ts';
import { platformGatewayConfig, pickPlatformGateway, enabledPlatformGateways, platformWebhookUrl, registerPlatformGatewayRoutes } from './platformBillingGateways.ts';

const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (n: number) => `Rs. ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const newId = (p: string) => `${p}-${Date.now()}-${randomBytes(3).toString('hex').toUpperCase()}`;
const pdfName = (inv: any) => `${String(inv.invoice_number || inv.id).replace(/[^A-Za-z0-9-]+/g, '_')}.pdf`;
// IST calendar day of a payment instant.
const istDay = (d: Date) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);

let receiptOrigin = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.replace(/\/+$/, '') : 'https://erp.atithi-setu.com';
let notifyAdmin: ((k: string, m: string) => Promise<void>) | null = null;

export async function ensurePaymentLink(inv: any, origin: string, gatewayId?: string | null): Promise<any> {
  if (!inv || inv.status !== 'ISSUED') throw new BillingError('This invoice is not awaiting payment.', 409, 'NOT_PAYABLE');
  const s = await getBillingSettings();
  const cfg = await pickPlatformGateway(gatewayId);
  if (!cfg) throw new BillingError('Online payment is not set up yet. Pay by bank transfer using the details on the invoice.', 409, 'GATEWAY_NOT_CONFIGURED');
  const gw = cfg.gateway;
  if (gw.requiresCustomerPhone && !inv.buyer?.phone) throw new BillingError(`${gw.label} needs a phone number for the payer. Add a billing phone to this tenant, or pay another way.`, 409, 'PHONE_REQUIRED');
  const amountPaise = rupeesToPaise(inv.total);
  const live: any = await centralDb.get(
    `SELECT * FROM platform_payment_links WHERE invoice_id = ? AND gateway = ? AND status IN ('CREATED', 'PARTIALLY_PAID') AND amount_paise = ?
       AND url IS NOT NULL AND (expires_at IS NULL OR expires_at > NOW() + INTERVAL '1 hour') ORDER BY created_at DESC LIMIT 1`,
    [inv.id, gw.id, amountPaise]).catch(() => null);
  if (live) return live;
  // One open link per invoice: an older one (any gateway) is reconciled or cancelled first.
  await cancelOpenLinks(inv.id);
  const linkId = `PL${Date.now().toString(36).toUpperCase()}${randomBytes(3).toString('hex').toUpperCase()}`;
  const expiresAt = new Date(Date.now() + Math.max(1, num(s.link_expiry_days || 15)) * 86400000);
  await centralDb.run('INSERT INTO platform_payment_links (id, invoice_id, gateway, mode, amount_paise, status, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [linkId, inv.id, gw.id, gw.modeOf(cfg.creds), amountPaise, 'CREATING', expiresAt]);
  try {
    const snap = await gw.createLink(cfg.creds, {
      referenceId: linkId, amountPaise,
      description: `${s.brand_name || 'Atithi-Setu'} invoice ${inv.invoice_number}`,
      customer: { name: inv.buyer?.business || inv.buyer?.name, email: inv.buyer?.email || undefined, phone: inv.buyer?.phone || undefined },
      expiresAt, callbackUrl: `${invoicePageUrl(origin, inv.id)}?paid=1`,
      webhookUrl: platformWebhookUrl(origin, gw.id),
      notes: { platform_invoice: inv.id, invoice_number: inv.invoice_number, tenant: inv.restaurant_id },
    });
    await centralDb.run('UPDATE platform_payment_links SET gateway_link_id = ?, url = ?, status = ?, expires_at = COALESCE(?, expires_at), last_error = NULL WHERE id = ?',
      [snap.gatewayLinkId, snap.url, snap.status, snap.expiresAt, linkId]);
    await auditInvoice(inv.id, 'LINK_CREATED', 'system', { link: linkId, gateway: gw.id, mode: gw.modeOf(cfg.creds) });
  } catch (e: any) {
    await centralDb.run("UPDATE platform_payment_links SET status = 'FAILED', last_error = ? WHERE id = ?", [String(e?.message || e).slice(0, 300), linkId]).catch(() => {});
    throw new BillingError(`${gw.label} could not create the payment link: ${e?.message || 'unknown error'}`, 502, 'GATEWAY_ERROR');
  }
  return centralDb.get('SELECT * FROM platform_payment_links WHERE id = ?', [linkId]);
}

export async function cancelOpenLinks(invoiceId: string): Promise<void> {
  const open: any[] = await centralDb.query("SELECT * FROM platform_payment_links WHERE invoice_id = ? AND status IN ('CREATING', 'CREATED', 'PARTIALLY_PAID')", [invoiceId]).catch(() => []);
  for (const l of open) {
    const cfg = await platformGatewayConfig(l.gateway || 'RAZORPAY');
    // A link that took money must be reconciled, never silently cancelled.
    if (cfg?.complete && l.gateway_link_id) {
      try {
        const snap = await cfg.gateway.fetchLink(cfg.creds, { gatewayLinkId: l.gateway_link_id, referenceId: l.id });
        if (snap.payments.some(p => p.status === 'CAPTURED')) { await reconcileLink(l, 'CANCEL_CHECK'); continue; }
        await cfg.gateway.cancelLink(cfg.creds, { gatewayLinkId: l.gateway_link_id, referenceId: l.id }).catch(() => null);
      } catch { /* marked cancelled locally either way */ }
    }
    await centralDb.run("UPDATE platform_payment_links SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('CREATING', 'CREATED', 'PARTIALLY_PAID')", [l.id]).catch(() => {});
  }
}

async function recordExtraPayment(invoiceId: string, link: any, p: any, trigger: string): Promise<number> {
  const gwId = String(link.gateway || 'RAZORPAY');
  const r = await centralDb.run(
    `INSERT INTO platform_payments (id, invoice_id, link_id, gateway, gateway_payment_id, amount_paise, fee_paise, tax_paise, method, source, reference, paid_at, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (gateway, gateway_payment_id) DO NOTHING`,
    [newId('PPAY'), invoiceId, link.id, gwId, p.gatewayPaymentId, p.amountPaise, p.feePaise, p.taxPaise, String(p.method || 'online').toUpperCase(), trigger, p.gatewayPaymentId, p.paidAt, gwId.toLowerCase()]).catch(() => ({ changes: 0 }));
  return r?.changes ? 1 : 0;
}

export async function reconcileLink(link: any, trigger: string): Promise<{ status: string; paid: boolean }> {
  const cfg = await platformGatewayConfig(link?.gateway || 'RAZORPAY');
  if (!cfg?.complete || !link?.gateway_link_id) return { status: link?.status || 'UNKNOWN', paid: false };
  const gw = cfg.gateway;
  const snap = await gw.fetchLink(cfg.creds, { gatewayLinkId: link.gateway_link_id, referenceId: link.id });
  await centralDb.run(
    "UPDATE platform_payment_links SET status = ?, last_checked_at = CURRENT_TIMESTAMP, paid_at = CASE WHEN ? = 'PAID' THEN COALESCE(paid_at, CURRENT_TIMESTAMP) ELSE paid_at END WHERE id = ?",
    [snap.status, snap.status, link.id]).catch(() => {});
  const captured = snap.payments.filter(p => p.status === 'CAPTURED');
  if (!captured.length) return { status: snap.status, paid: false };
  const inv = await loadInvoice(link.invoice_id);
  if (!inv) return { status: snap.status, paid: false };
  const total = captured.reduce((s, p) => s + p.amountPaise, 0);
  if (inv.status === 'ISSUED' && total >= rupeesToPaise(inv.total)) {
    const p0 = captured[0];
    try {
      const paid = await markInvoicePaid(inv.id, {
        method: 'ONLINE', reference: p0.gatewayPaymentId, paidOn: istDay(p0.paidAt), source: trigger, actor: gw.id.toLowerCase(),
        gateway: gw.id, gatewayPaymentId: p0.gatewayPaymentId, amountPaise: p0.amountPaise, feePaise: p0.feePaise, taxPaise: p0.taxPaise, linkId: link.id,
      });
      for (const p of captured.slice(1)) await recordExtraPayment(inv.id, link, p, trigger);
      sendInvoice(paid, ['EMAIL', 'WHATSAPP'], receiptOrigin, 'system', 'RECEIPT').catch(() => {});
      notifyAdmin?.('SUBSCRIPTION_DUE', `💰 ${paid?.buyer?.business || paid?.restaurant_id} paid ${paid?.invoice_number} online via ${gw.label} (${money(paid?.total)}).${paid?.extends_subscription && paid?.period_to ? ` Subscription now runs to ${paid.period_to}.` : ''}`).catch(() => {});
      return { status: snap.status, paid: true };
    } catch (e: any) {
      if (!(e instanceof BillingError) || e.code !== 'ALREADY_PAID') throw e;
    }
  }
  // Money for an invoice already paid or cancelled: keep it on record and tell
  // the admin — a refund or a credit needs a person.
  let fresh = 0;
  for (const p of captured) fresh += await recordExtraPayment(inv.id, link, p, trigger);
  if (fresh && inv.status !== 'ISSUED') {
    await auditInvoice(inv.id, 'PAYMENT_NEEDS_REVIEW', gw.id.toLowerCase(), { status: inv.status, payments: captured.map(p => p.gatewayPaymentId) });
    notifyAdmin?.('SUBSCRIPTION_DUE', `⚠️ ${gw.label} payment received for ${inv.invoice_number}, which is ${String(inv.status).toLowerCase()}. Check whether a refund is due.`).catch(() => {});
  }
  return { status: snap.status, paid: inv.status === 'PAID' };
}

let sweepRunning = false;
export async function platformBillingSweep(): Promise<number> {
  if (sweepRunning) return 0;
  sweepRunning = true;
  let n = 0;
  try {
    const due: any[] = await centralDb.query(
      `SELECT * FROM platform_payment_links WHERE status IN ('CREATED', 'PARTIALLY_PAID') AND gateway_link_id IS NOT NULL
         AND (last_checked_at IS NULL OR last_checked_at < NOW() - INTERVAL '9 minutes') AND created_at > NOW() - INTERVAL '90 days'
       ORDER BY last_checked_at NULLS FIRST LIMIT 40`).catch(() => []);
    for (const l of due) {
      try { await reconcileLink(l, 'SWEEP'); n++; }
      catch (e: any) { await centralDb.run('UPDATE platform_payment_links SET last_checked_at = CURRENT_TIMESTAMP, last_error = ? WHERE id = ?', [String(e?.message || e).slice(0, 300), l.id]).catch(() => {}); }
    }
  } finally { sweepRunning = false; }
  return n;
}

const fail = (res: Response, e: any) => {
  if (e instanceof BillingError) return res.status(e.status).json({ error: e.message, code: e.code });
  console.error('[platform-billing]', e);
  return res.status(500).json({ error: 'Platform billing failed' });
};

export function registerPlatformBillingPayments(app: Express, deps: PlatformBillingDeps) {
  notifyAdmin = deps.notifyPlatformAdmin;
  setCancelOpenLinksHook(cancelOpenLinks);
  registerPlatformGatewayRoutes(app, deps);

  // Gateway → PLM Pundits. Each gateway checks its own signature on the exact
  // raw bytes (webhookRawBody.ts keeps them for /api/public/platform-billing/webhook/*).
  app.post('/api/public/platform-billing/webhook/:gateway', async (req: any, res: Response) => {
    try {
      const cfg = await platformGatewayConfig(req.params.gateway);
      const raw: Buffer = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0);
      if (!cfg || !cfg.complete) return res.status(401).json({ error: 'Bad signature' });
      const gw = cfg.gateway;
      let ok = false;
      try { ok = gw.verifyWebhook(cfg.creds, raw, req.headers); } catch { ok = false; }
      if (!ok) return res.status(401).json({ error: 'Bad signature' });
      const ev = gw.parseWebhook(raw, req.headers);
      const eventId = ev.eventId || createHmac('sha256', 'pb').update(raw).digest('hex').slice(0, 40);
      const ins = await centralDb.run(
        'INSERT INTO platform_webhook_events (id, gateway, event_id, event_type, link_id, outcome) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (gateway, event_id) DO NOTHING',
        [newId('PWE'), gw.id, eventId, ev.eventType, ev.gatewayLinkId || ev.referenceId, 'RECEIVED']);
      if (!ins?.changes) return res.json({ ok: true, duplicate: true });
      res.json({ ok: true });
      setImmediate(async () => {
        let outcome = 'IGNORED', detail: string | null = null;
        try {
          const link: any = await centralDb.get('SELECT * FROM platform_payment_links WHERE gateway = ? AND (gateway_link_id = ? OR id = ?) LIMIT 1', [gw.id, ev.gatewayLinkId || '', ev.referenceId || '']);
          if (!link) outcome = 'UNKNOWN_LINK';
          else { const r = await reconcileLink(link, 'WEBHOOK'); outcome = r.paid ? 'PROCESSED' : 'CHECKED'; }
        } catch (e: any) { outcome = 'FAILED'; detail = String(e?.message || e).slice(0, 300); }
        await centralDb.run('UPDATE platform_webhook_events SET outcome = ?, detail = ? WHERE gateway = ? AND event_id = ?', [outcome, detail, gw.id, eventId]).catch(() => {});
      });
    } catch (e) { fail(res, e); }
  });

  // Public invoice page (signed token, no login): the owner opens it from the
  // email or WhatsApp, downloads the PDF and pays.
  const byToken = async (req: any) => { const id = readInvoiceToken(req.params.token); return id ? loadInvoice(id) : null; };
  app.get('/api/public/platform-billing/invoice/:token', async (req: any, res: Response) => {
    try {
      const inv = await byToken(req);
      if (!inv) return res.status(404).json({ error: 'This invoice link is not valid.' });
      const s = await getBillingSettings();
      res.json({
        invoice_number: inv.invoice_number, status: inv.status, issue_date: inv.issue_date, due_date: inv.due_date,
        kind: inv.kind, cycle_label: inv.cycle_label, period_from: inv.period_from, period_to: inv.period_to,
        seller: { name: inv.seller?.name, gstin: inv.seller?.gstin, brand: s.brand_name || 'Atithi-Setu', email: inv.seller?.email, phone: inv.seller?.phone },
        buyer: { business: inv.buyer?.business, gstin: inv.buyer?.gstin },
        lines: inv.lines, subtotal: inv.subtotal, cgst: inv.cgst, sgst: inv.sgst, igst: inv.igst, gst_rate: inv.gst_rate, total: inv.total,
        paid_at: inv.paid_at, cancelled_at: inv.cancelled_at,
        gateways: (await enabledPlatformGateways()).map(c => ({ id: c.gateway.id, label: c.gateway.label, default: c.isDefault, needs_phone: c.gateway.requiresCustomerPhone })),
        online_available: (await enabledPlatformGateways()).length > 0,
        bank: s.bank_account_number || s.upi_vpa ? { account_name: s.bank_account_name, account_number: s.bank_account_number, ifsc: s.bank_ifsc, bank_name: s.bank_name, upi_vpa: s.upi_vpa } : null,
      });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/public/platform-billing/invoice/:token/pdf', async (req: any, res: Response) => {
    try {
      const inv = await byToken(req);
      if (!inv) return res.status(404).json({ error: 'This invoice link is not valid.' });
      const pdf = await renderInvoicePdf(inv, deps.appOriginFromReq(req));
      await auditInvoice(inv.id, 'PRINTED', 'owner (public link)', null);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${pdfName(inv)}"`);
      res.send(pdf);
    } catch (e) { fail(res, e); }
  });
  app.post('/api/public/platform-billing/invoice/:token/pay', async (req: any, res: Response) => {
    try {
      const inv = await byToken(req);
      if (!inv) return res.status(404).json({ error: 'This invoice link is not valid.' });
      const link = await ensurePaymentLink(inv, deps.appOriginFromReq(req), req.body?.gateway || null);
      res.json({ url: link.url, gateway: link.gateway });
    } catch (e) { fail(res, e); }
  });
  // Re-reads the gateway at most every 10 s per link while the owner waits.
  app.get('/api/public/platform-billing/invoice/:token/status', async (req: any, res: Response) => {
    try {
      const inv = await byToken(req);
      if (!inv) return res.status(404).json({ error: 'This invoice link is not valid.' });
      if (inv.status === 'ISSUED') {
        const link: any = await centralDb.get(
          "SELECT * FROM platform_payment_links WHERE invoice_id = ? AND status IN ('CREATED', 'PARTIALLY_PAID', 'PAID') AND gateway_link_id IS NOT NULL ORDER BY created_at DESC LIMIT 1", [inv.id]).catch(() => null);
        const stale = link && (!link.last_checked_at || Date.now() - new Date(link.last_checked_at).getTime() > 10000);
        if (stale) { try { await reconcileLink(link, 'PAGE'); } catch { /* the sweep retries */ } }
      }
      const now = await loadInvoice(inv.id);
      res.json({ status: now?.status, paid_at: now?.paid_at });
    } catch (e) { fail(res, e); }
  });

  // Admin: create (or reuse) the live link, e.g. to paste into a chat.
  app.post('/api/admin/platform-invoices/:invId/payment-link', deps.authenticate, deps.isAdmin, async (req: any, res: Response) => {
    try {
      const inv = await loadInvoice(req.params.invId);
      if (!inv) return res.status(404).json({ error: 'Invoice not found' });
      const link = await ensurePaymentLink(inv, deps.appOriginFromReq(req), req.body?.gateway || null);
      res.json({ url: link.url, gateway: link.gateway, page_url: invoicePageUrl(deps.appOriginFromReq(req), inv.id) });
    } catch (e) { fail(res, e); }
  });
  // Admin: re-read Razorpay now instead of waiting for the sweep.
  app.post('/api/admin/platform-invoices/:invId/refresh', deps.authenticate, deps.isAdmin, async (req: any, res: Response) => {
    try {
      const links: any[] = await centralDb.query("SELECT * FROM platform_payment_links WHERE invoice_id = ? AND gateway_link_id IS NOT NULL AND status IN ('CREATED', 'PARTIALLY_PAID', 'PAID', 'EXPIRED')", [req.params.invId]).catch(() => []);
      for (const l of links) { try { await reconcileLink(l, 'ADMIN'); } catch { /* sweep retries */ } }
      res.json({ invoice: await loadInvoice(req.params.invId) });
    } catch (e) { fail(res, e); }
  });

  // 5-minute sweep for webhooks that never arrived.
  const t = setInterval(() => { platformBillingSweep().catch(() => {}); }, 5 * 60 * 1000);
  (t as any).unref?.();
}
