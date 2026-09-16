// ─────────────────────────────────────────────────────────────────────────────
// razorpayGateway.ts — Razorpay Payment Links adapter (implements PaymentGateway).
//
// Contract facts (razorpay.com/docs, checked Sep 2026 — do NOT invent beyond them):
//   • Base URL   https://api.razorpay.com/v1 — one host; TEST vs LIVE is decided
//                by the key itself (rzp_test_… / rzp_live_…).
//   • Auth       HTTP Basic, key_id:key_secret.
//   • Create     POST /payment_links. amount in paise; reference_id ≤ 40 chars and
//                unique per account; expire_by is epoch seconds, at most 6 months
//                ahead and (per Razorpay) at least 15 minutes ahead.
//   • Fetch      GET /payment_links/:id — carries payments[] {payment_id, amount,
//                method, status, created_at}; fee/tax need GET /payments/:id.
//   • Cancel     POST /payment_links/:id/cancel.
//   • Webhook    X-Razorpay-Signature = hex HMAC-SHA256(raw body, webhook secret);
//                x-razorpay-event-id is unique per event (use it to de-duplicate).
//                Events: payment_link.paid | partially_paid | cancelled | expired.
//                payload.payment_link.entity.{id, reference_id, status}.
//   • Errors     { error: { code, description, field, reason } }.
//
// Razorpay's own SMS/email notify is switched OFF: the product sends the link on
// WhatsApp/email itself, so the customer gets one message, from the property.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'crypto';
import {
  GatewayError, headerValue,
  type CreateLinkInput, type CredentialField, type FetchLike, type GatewayCredentials,
  type GatewayMode, type GatewayPayment, type LinkSnapshot, type LinkStatus,
  type PaymentGateway, type WebhookEvent,
} from './paymentGateway.ts';

const BASE_URL = 'https://api.razorpay.com/v1';
const TIMEOUT_MS = 15_000;
const MIN_EXPIRY_LEAD_MS = 16 * 60 * 1000; // Razorpay refuses expire_by under 15 minutes out

const STATUS: Record<string, LinkStatus> = {
  created: 'CREATED',
  partially_paid: 'PARTIALLY_PAID',
  paid: 'PAID',
  expired: 'EXPIRED',
  cancelled: 'CANCELLED',
};

export class RazorpayGateway implements PaymentGateway {
  readonly id = 'RAZORPAY' as const;
  readonly label = 'Razorpay';
  readonly credentialFields: CredentialField[] = [
    { key: 'key_id', label: 'Key ID', secret: false, required: true, help: 'Dashboard → Account & Settings → API Keys. Starts with rzp_test_ or rzp_live_.' },
    { key: 'key_secret', label: 'Key Secret', secret: true, required: true, help: 'Shown once when the key is generated.' },
    { key: 'webhook_secret', label: 'Webhook Secret', secret: true, required: true, help: 'The secret you type when adding the webhook URL below in Razorpay → Webhooks.' },
  ];

  constructor(private readonly fetchImpl: FetchLike = (globalThis.fetch as unknown as FetchLike)) {}

  modeOf(creds: GatewayCredentials): GatewayMode | null {
    const k = String(creds.key_id || '');
    if (k.startsWith('rzp_test_')) return 'TEST';
    if (k.startsWith('rzp_live_')) return 'LIVE';
    return null;
  }

  async testConnection(creds: GatewayCredentials) {
    this.requireCreds(creds, ['key_id', 'key_secret']);
    await this.request(creds, 'GET', '/payment_links?count=1');
    const mode = this.modeOf(creds);
    const kind = mode === 'LIVE' ? 'live ' : mode === 'TEST' ? 'test ' : '';
    return { mode, detail: `Razorpay accepted the ${kind}API keys.` };
  }

  async createLink(creds: GatewayCredentials, input: CreateLinkInput): Promise<LinkSnapshot> {
    this.requireCreds(creds, ['key_id', 'key_secret']);
    if (!Number.isInteger(input.amountPaise) || input.amountPaise < 100) {
      throw new GatewayError('Amount must be at least ₹1.', 'BAD_REQUEST');
    }
    if (!input.referenceId || input.referenceId.length > 40) {
      throw new GatewayError('Reference id must be 1–40 characters.', 'BAD_REQUEST');
    }
    const body: Record<string, any> = {
      amount: input.amountPaise,
      currency: 'INR',
      accept_partial: false,
      reference_id: input.referenceId,
      description: String(input.description || '').slice(0, 2048),
      notify: { sms: false, email: false },
      reminder_enable: false,
    };
    const customer: Record<string, string> = {};
    if (input.customer.name) customer.name = input.customer.name;
    if (input.customer.email) customer.email = input.customer.email;
    if (input.customer.phone) customer.contact = input.customer.phone;
    if (Object.keys(customer).length) body.customer = customer;
    if (input.expiresAt) {
      const floor = Date.now() + MIN_EXPIRY_LEAD_MS;
      body.expire_by = Math.floor(Math.max(input.expiresAt.getTime(), floor) / 1000);
    }
    if (input.callbackUrl) { body.callback_url = input.callbackUrl; body.callback_method = 'get'; }
    if (input.notes) body.notes = Object.fromEntries(Object.entries(input.notes).slice(0, 15).map(([k, v]) => [k, String(v).slice(0, 256)]));

    const link = await this.request(creds, 'POST', '/payment_links', body);
    return this.toSnapshot(link, []);
  }

  async fetchLink(creds: GatewayCredentials, gatewayLinkId: string): Promise<LinkSnapshot> {
    this.requireCreds(creds, ['key_id', 'key_secret']);
    const link = await this.request(creds, 'GET', `/payment_links/${encodeURIComponent(gatewayLinkId)}`);
    // The link's payments[] has no fee or payer detail. Read each captured payment
    // in full: the fee is what makes the MDR entry in the books right.
    const payments: GatewayPayment[] = [];
    for (const p of Array.isArray(link.payments) ? link.payments : []) {
      if (!p?.payment_id) continue;
      if (String(p.status) !== 'captured') {
        payments.push({
          gatewayPaymentId: String(p.payment_id), amountPaise: Number(p.amount) || 0,
          status: String(p.status) === 'failed' ? 'FAILED' : 'PENDING', method: String(p.method || ''),
          feePaise: null, taxPaise: null, paidAt: new Date((Number(p.created_at) || 0) * 1000),
        });
        continue;
      }
      const full = await this.request(creds, 'GET', `/payments/${encodeURIComponent(String(p.payment_id))}`);
      payments.push(this.toPayment(full));
    }
    return this.toSnapshot(link, payments);
  }

  async cancelLink(creds: GatewayCredentials, gatewayLinkId: string): Promise<LinkSnapshot> {
    this.requireCreds(creds, ['key_id', 'key_secret']);
    const link = await this.request(creds, 'POST', `/payment_links/${encodeURIComponent(gatewayLinkId)}/cancel`);
    return this.toSnapshot(link, []);
  }

  verifyWebhook(creds: GatewayCredentials, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const secret = String(creds.webhook_secret || '');
    const given = headerValue(headers, 'x-razorpay-signature');
    if (!secret || !given || !Buffer.isBuffer(rawBody)) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(given.trim(), 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent {
    let body: any;
    try { body = JSON.parse(rawBody.toString('utf8')); }
    catch { throw new GatewayError('Webhook body is not JSON.', 'INVALID_RESPONSE'); }
    const link = body?.payload?.payment_link?.entity;
    return {
      eventId: headerValue(headers, 'x-razorpay-event-id'),
      eventType: String(body?.event || ''),
      gatewayLinkId: link?.id ? String(link.id) : null,
      referenceId: link?.reference_id ? String(link.reference_id) : null,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private requireCreds(creds: GatewayCredentials, keys: string[]) {
    const missing = keys.filter(k => !String(creds?.[k] || '').trim());
    if (missing.length) throw new GatewayError(`Razorpay ${missing.join(', ')} not configured.`, 'CONFIG');
  }

  private async request(creds: GatewayCredentials, method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    const auth = Buffer.from(`${creds.key_id}:${creds.key_secret}`).toString('base64');
    let res;
    try {
      res = await this.fetchImpl(`${BASE_URL}${path}`, {
        method,
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e: any) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw new GatewayError('Razorpay did not respond in time.', 'TIMEOUT', null, true);
      }
      throw new GatewayError('Could not reach Razorpay.', 'UNAVAILABLE', null, true);
    }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : {}; } catch { /* handled below */ }

    if (res.ok) {
      if (json === null) throw new GatewayError('Razorpay returned a response that is not JSON.', 'INVALID_RESPONSE', res.status);
      return json;
    }
    const detail = json?.error?.description || `HTTP ${res.status}`;
    if (res.status === 401) throw new GatewayError('Razorpay rejected the API key id or secret.', 'AUTH_FAILED', 401);
    if (res.status === 404) throw new GatewayError(`Razorpay: ${detail}`, 'NOT_FOUND', 404);
    if (res.status >= 500 || res.status === 429) throw new GatewayError(`Razorpay is unavailable: ${detail}`, 'UNAVAILABLE', res.status, true);
    throw new GatewayError(`Razorpay: ${detail}`, 'BAD_REQUEST', res.status);
  }

  private toSnapshot(link: any, payments: GatewayPayment[]): LinkSnapshot {
    const status = STATUS[String(link?.status || '')];
    if (!link?.id || !status) throw new GatewayError('Razorpay returned a payment link without an id or a known status.', 'INVALID_RESPONSE');
    return {
      gatewayLinkId: String(link.id),
      referenceId: String(link.reference_id || ''),
      url: String(link.short_url || ''),
      status,
      amountPaise: Number(link.amount) || 0,
      amountPaidPaise: Number(link.amount_paid) || 0,
      expiresAt: Number(link.expire_by) > 0 ? new Date(Number(link.expire_by) * 1000) : null,
      payments,
    };
  }

  private toPayment(p: any): GatewayPayment {
    if (!p?.id) throw new GatewayError('Razorpay returned a payment without an id.', 'INVALID_RESPONSE');
    const captured = String(p.status) === 'captured' || p.captured === true;
    return {
      gatewayPaymentId: String(p.id),
      amountPaise: Number(p.amount) || 0,
      status: captured ? 'CAPTURED' : String(p.status) === 'failed' ? 'FAILED' : 'PENDING',
      method: String(p.method || '').toLowerCase(),
      // Number(null) is 0: an unreported fee must stay null, not become "free".
      feePaise: p.fee == null || !Number.isFinite(Number(p.fee)) ? null : Number(p.fee),
      taxPaise: p.tax == null || !Number.isFinite(Number(p.tax)) ? null : Number(p.tax),
      paidAt: new Date((Number(p.created_at) || 0) * 1000),
      payerVpa: p.vpa || undefined,
      payerEmail: p.email || undefined,
      payerPhone: p.contact || undefined,
    };
  }
}
