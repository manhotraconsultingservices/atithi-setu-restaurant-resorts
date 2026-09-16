// ─────────────────────────────────────────────────────────────────────────────
// phonepeGateway.ts — PhonePe Payment Links adapter (implements PaymentGateway).
//
// Contract facts (developer.phonepe.com/payment-gateway/payment-links, checked
// Sep 2026 — do NOT invent beyond them):
//   • Auth       POST {oauth}/v1/oauth/token, form-encoded client_id, client_version,
//                client_secret, grant_type=client_credentials → access_token,
//                expires_at (epoch). Later calls send "Authorization: O-Bearer <token>".
//                Sandbox  https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token
//                Live     https://api.phonepe.com/apis/identity-manager/v1/oauth/token
//   • Base       Sandbox https://api-preprod.phonepe.com/apis/pg-sandbox/paylinks/v1
//                Live    https://api.phonepe.com/apis/pg/paylinks/v1
//   • Create     POST /pay  { merchantOrderId (≤63, only _ and - special), amount
//                (paise), description (≤150), paymentFlow { type: PAYLINK,
//                customerDetails { name, phoneNumber (MANDATORY), email },
//                notificationChannels { SMS, EMAIL }, expireAt (epoch ms) },
//                metaInfo { udf1.. } } → { orderId, state: ACTIVE, expireAt, paylinkUrl }
//   • Status     GET /{merchantOrderId}/status?details=true → { orderId, state
//                ACTIVE|COMPLETED|FAILED|EXPIRED|CANCELLED, amount, expireAt,
//                paymentDetails[] { transactionId, amount, state PENDING|COMPLETED|
//                FAILED, paymentMode, timestamp, rail { vpa } } }. No fee is reported.
//   • Cancel     POST /{merchantOrderId}/cancel → { orderId, state: CANCELLED };
//                400 when the link is already terminal.
//   • Webhook    Authorization header = SHA256(username:password), the pair the
//                merchant types in Dashboard → Developer Settings → Webhook.
//                { event: paylink.order.completed | paylink.order.failed,
//                  payload { orderId, merchantOrderId, state, amount, paymentDetails[] } }
//   • X-MERCHANT-ID only for partner integrations (sent when configured).
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'crypto';
import {
  GatewayError, headerValue,
  type CreateLinkInput, type CredentialField, type FetchLike, type GatewayCredentials,
  type GatewayMode, type GatewayPayment, type LinkRef, type LinkSnapshot, type LinkStatus,
  type PaymentGateway, type WebhookEvent,
} from './paymentGateway.ts';

const HOSTS = {
  SANDBOX: {
    token: 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token',
    links: 'https://api-preprod.phonepe.com/apis/pg-sandbox/paylinks/v1',
  },
  PRODUCTION: {
    token: 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token',
    links: 'https://api.phonepe.com/apis/pg/paylinks/v1',
  },
} as const;
const TIMEOUT_MS = 15_000;
const TOKEN_REFRESH_LEAD_MS = 2 * 60 * 1000;

const STATUS: Record<string, LinkStatus> = {
  ACTIVE: 'CREATED',
  PENDING: 'CREATED',
  COMPLETED: 'PAID',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
};

export class PhonePeGateway implements PaymentGateway {
  readonly id = 'PHONEPE' as const;
  readonly label = 'PhonePe';
  readonly credentialFields: CredentialField[] = [
    { key: 'environment', label: 'Environment', secret: false, required: true, options: [{ value: 'SANDBOX', label: 'Sandbox (test)' }, { value: 'PRODUCTION', label: 'Production (live)' }], help: 'Sandbox credentials only work with Sandbox.' },
    { key: 'client_id', label: 'Client ID', secret: false, required: true, help: 'PhonePe Business Dashboard → Developer Settings → API Keys.' },
    { key: 'client_version', label: 'Client Version', secret: false, required: true, help: 'Shown next to the Client ID (often 1).' },
    { key: 'client_secret', label: 'Client Secret', secret: true, required: true },
    { key: 'webhook_username', label: 'Webhook Username', secret: false, required: true, help: 'The username you set for the webhook in PhonePe.' },
    { key: 'webhook_password', label: 'Webhook Password', secret: true, required: true, help: 'The password you set for the webhook in PhonePe.' },
    { key: 'merchant_id', label: 'Merchant ID (partners only)', secret: false, required: false, help: 'Leave blank unless PhonePe gave you a partner integration.' },
  ];
  readonly setupSteps = [
    'In the PhonePe Business Dashboard open Developer Settings → Webhook (use Test mode for Sandbox credentials).',
    'Webhook URL: {webhookUrl}',
    'Choose a username and password, and enter the same values as Webhook Username and Webhook Password here.',
    'Select the events paylink.order.completed and paylink.order.failed, then save.',
  ];
  readonly requiresCustomerPhone = true;

  // One token per credential set, reused until shortly before it expires.
  private readonly tokens = new Map<string, { token: string; expiresAtMs: number }>();

  constructor(private readonly fetchImpl: FetchLike = (globalThis.fetch as unknown as FetchLike)) {}

  modeOf(creds: GatewayCredentials): GatewayMode | null {
    const env = String(creds.environment || '').toUpperCase();
    if (env === 'SANDBOX') return 'TEST';
    if (env === 'PRODUCTION') return 'LIVE';
    return null;
  }

  async testConnection(creds: GatewayCredentials) {
    await this.token(creds, true);
    const mode = this.modeOf(creds);
    return { mode, detail: `PhonePe accepted the ${mode === 'LIVE' ? 'production' : 'sandbox'} credentials.` };
  }

  async createLink(creds: GatewayCredentials, input: CreateLinkInput): Promise<LinkSnapshot> {
    if (!Number.isInteger(input.amountPaise) || input.amountPaise < 100) {
      throw new GatewayError('Amount must be at least ₹1.', 'BAD_REQUEST');
    }
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(input.referenceId || '')) {
      throw new GatewayError('Reference id must be 1–63 letters, digits, _ or -.', 'BAD_REQUEST');
    }
    const phone = String(input.customer.phone || '').replace(/[^\d+]/g, '');
    if (!phone) throw new GatewayError("PhonePe needs the customer's phone number to create a link.", 'BAD_REQUEST');

    const customerDetails: Record<string, string> = { phoneNumber: phone };
    if (input.customer.name) customerDetails.name = input.customer.name;
    if (input.customer.email) customerDetails.email = input.customer.email;
    const paymentFlow: Record<string, any> = {
      type: 'PAYLINK',
      customerDetails,
      // The property sends the link itself, so the customer gets one message.
      notificationChannels: { SMS: false, EMAIL: false },
    };
    if (input.expiresAt) paymentFlow.expireAt = input.expiresAt.getTime();
    const body: Record<string, any> = {
      merchantOrderId: input.referenceId,
      amount: input.amountPaise,
      description: String(input.description || '').slice(0, 150),
      paymentFlow,
    };
    const udfs = Object.values(input.notes || {}).slice(0, 10);
    if (udfs.length) body.metaInfo = Object.fromEntries(udfs.map((v, i) => [`udf${i + 1}`, String(v).slice(0, 256)]));

    const res = await this.request(creds, 'POST', '/pay', body);
    if (!res?.orderId || !res?.paylinkUrl) throw new GatewayError('PhonePe returned a payment link without an order id or URL.', 'INVALID_RESPONSE');
    return {
      gatewayLinkId: String(res.orderId),
      referenceId: input.referenceId,
      url: String(res.paylinkUrl),
      status: STATUS[String(res.state || 'ACTIVE').toUpperCase()] || 'CREATED',
      amountPaise: input.amountPaise,
      amountPaidPaise: 0,
      expiresAt: this.epoch(res.expireAt),
      payments: [],
    };
  }

  async fetchLink(creds: GatewayCredentials, ref: LinkRef): Promise<LinkSnapshot> {
    const res = await this.request(creds, 'GET', `/${encodeURIComponent(ref.referenceId)}/status?details=true`);
    const status = STATUS[String(res?.state || '').toUpperCase()];
    if (!status) throw new GatewayError(`PhonePe returned an unknown link state: ${res?.state}`, 'INVALID_RESPONSE');
    const payments: GatewayPayment[] = (Array.isArray(res.paymentDetails) ? res.paymentDetails : [])
      .filter((p: any) => p?.transactionId)
      .map((p: any) => {
        const st = String(p.state || '').toUpperCase();
        return {
          gatewayPaymentId: String(p.transactionId),
          amountPaise: Number(p.amount) || 0,
          status: st === 'COMPLETED' ? 'CAPTURED' : st === 'FAILED' ? 'FAILED' : 'PENDING',
          method: String(p.paymentMode || '').toLowerCase(),
          feePaise: null,   // PhonePe does not report its fee per payment
          taxPaise: null,
          paidAt: this.epoch(p.timestamp) || new Date(),
          payerVpa: p.rail?.vpa || undefined,
        } as GatewayPayment;
      });
    const paid = payments.filter(p => p.status === 'CAPTURED').reduce((s, p) => s + p.amountPaise, 0);
    return {
      gatewayLinkId: String(res.orderId || ref.gatewayLinkId),
      referenceId: ref.referenceId,
      url: '',   // the status API does not repeat the URL; the stored one stands
      status,
      amountPaise: Number(res.amount) || 0,
      amountPaidPaise: paid,
      expiresAt: this.epoch(res.expireAt),
      payments,
    };
  }

  async cancelLink(creds: GatewayCredentials, ref: LinkRef): Promise<LinkSnapshot> {
    const res = await this.request(creds, 'POST', `/${encodeURIComponent(ref.referenceId)}/cancel`, {});
    return {
      gatewayLinkId: String(res?.orderId || ref.gatewayLinkId), referenceId: ref.referenceId, url: '',
      status: STATUS[String(res?.state || 'CANCELLED').toUpperCase()] || 'CANCELLED',
      amountPaise: 0, amountPaidPaise: 0, expiresAt: null, payments: [],
    };
  }

  verifyWebhook(creds: GatewayCredentials, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const user = String(creds.webhook_username || '');
    const pass = String(creds.webhook_password || '');
    let given = String(headerValue(headers, 'authorization') || '').trim();
    if (!user || !pass || !given || !Buffer.isBuffer(rawBody)) return false;
    given = given.replace(/^sha256[\s=:]+/i, '').toLowerCase();
    const expected = crypto.createHash('sha256').update(`${user}:${pass}`).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(given, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: Buffer, _headers: Record<string, string | string[] | undefined>): WebhookEvent {
    let body: any;
    try { body = JSON.parse(rawBody.toString('utf8')); }
    catch { throw new GatewayError('Webhook body is not JSON.', 'INVALID_RESPONSE'); }
    const p = body?.payload || {};
    const txns = (Array.isArray(p.paymentDetails) ? p.paymentDetails : []).map((d: any) => d?.transactionId).filter(Boolean).join(',');
    // PhonePe sends no delivery id; the event, order, state and payments together
    // identify a delivery, so a retry of the same notification de-duplicates.
    const eventId = p.orderId ? `${body?.event || ''}:${p.orderId}:${p.state || ''}:${txns}`.slice(0, 250) : null;
    return {
      eventId,
      eventType: String(body?.event || ''),
      gatewayLinkId: p.orderId ? String(p.orderId) : null,
      referenceId: p.merchantOrderId ? String(p.merchantOrderId) : null,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private hosts(creds: GatewayCredentials) {
    const env = String(creds.environment || '').toUpperCase();
    if (env !== 'SANDBOX' && env !== 'PRODUCTION') throw new GatewayError('Choose the PhonePe environment (Sandbox or Production).', 'CONFIG');
    return HOSTS[env];
  }

  private requireCreds(creds: GatewayCredentials) {
    const missing = ['client_id', 'client_version', 'client_secret'].filter(k => !String(creds?.[k] || '').trim());
    if (missing.length) throw new GatewayError(`PhonePe ${missing.join(', ')} not configured.`, 'CONFIG');
  }

  private async token(creds: GatewayCredentials, fresh = false): Promise<string> {
    this.requireCreds(creds);
    const hosts = this.hosts(creds);
    const key = crypto.createHash('sha256')
      .update([creds.environment, creds.client_id, creds.client_version, creds.client_secret].join(' ')).digest('hex');
    const cached = this.tokens.get(key);
    if (!fresh && cached && cached.expiresAtMs - TOKEN_REFRESH_LEAD_MS > Date.now()) return cached.token;

    const form = new URLSearchParams({
      client_id: String(creds.client_id), client_version: String(creds.client_version),
      client_secret: String(creds.client_secret), grant_type: 'client_credentials',
    }).toString();
    const { status, json } = await this.send(hosts.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form });
    if (status === 400 || status === 401 || status === 403) {
      this.tokens.delete(key);
      throw new GatewayError('PhonePe rejected the client id, version or secret.', 'AUTH_FAILED', status);
    }
    this.raise(status, json);
    if (!json?.access_token) throw new GatewayError('PhonePe did not return an access token.', 'INVALID_RESPONSE', status);
    const exp = Number(json.expires_at) || 0;
    const expiresAtMs = exp > 1e12 ? exp : exp > 0 ? exp * 1000 : Date.now() + 10 * 60 * 1000;
    this.tokens.set(key, { token: String(json.access_token), expiresAtMs });
    return String(json.access_token);
  }

  private async request(creds: GatewayCredentials, method: 'GET' | 'POST', path: string, body?: unknown, retried = false): Promise<any> {
    const hosts = this.hosts(creds);
    const token = await this.token(creds);
    const headers: Record<string, string> = { Authorization: `O-Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
    if (creds.merchant_id) headers['X-MERCHANT-ID'] = String(creds.merchant_id);
    const { status, json } = await this.send(`${hosts.links}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (status === 401 && !retried) {
      // A token can be revoked before its stated expiry: fetch a new one once.
      await this.token(creds, true);
      return this.request(creds, method, path, body, true);
    }
    this.raise(status, json);
    return json;
  }

  private async send(url: string, init: any): Promise<{ status: number; json: any }> {
    let res;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e: any) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new GatewayError('PhonePe did not respond in time.', 'TIMEOUT', null, true);
      throw new GatewayError('Could not reach PhonePe.', 'UNAVAILABLE', null, true);
    }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (res.ok && json === null) throw new GatewayError('PhonePe returned a response that is not JSON.', 'INVALID_RESPONSE', res.status);
    return { status: res.status, json };
  }

  private raise(status: number, json: any) {
    if (status >= 200 && status < 300) return;
    const detail = json?.message || json?.code || `HTTP ${status}`;
    if (status === 401 || status === 403) throw new GatewayError('PhonePe rejected the credentials.', 'AUTH_FAILED', status);
    if (status === 404) throw new GatewayError(`PhonePe: ${detail}`, 'NOT_FOUND', 404);
    if (status >= 500 || status === 429) throw new GatewayError(`PhonePe is unavailable: ${detail}`, 'UNAVAILABLE', status, true);
    throw new GatewayError(`PhonePe: ${detail}`, 'BAD_REQUEST', status);
  }

  private epoch(v: any): Date | null {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(n > 1e12 ? n : n * 1000);
  }
}
