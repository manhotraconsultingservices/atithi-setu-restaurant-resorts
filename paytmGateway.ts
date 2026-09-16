// ─────────────────────────────────────────────────────────────────────────────
// paytmGateway.ts — Paytm Payment Links adapter (implements PaymentGateway).
//
// Contract facts (paytmpayments.com/docs, checked Sep 2026 — do NOT invent beyond them):
//   • Hosts      Staging https://securestage.paytmpayments.com
//                Production https://secure.paytmpayments.com
//   • Envelope   POST JSON { body: {...}, head: { tokenType: "AES", signature } }.
//                signature = PaytmChecksum over the exact JSON string of `body`,
//                keyed by the merchant key. Replies carry body.resultInfo
//                { resultStatus SUCCESS|FAILED, resultCode, resultMessage }, often with
//                HTTP 200 on failure; 5028 = checksum invalid (wrong key/MID).
//   • Create     /link/create { mid, linkType FIXED, linkName (≤64), linkDescription
//                (≤30), amount (rupees), expiryDate "dd/mm/yyyy hh:mm:ss", sendSms,
//                sendEmail, customerContact { customerName, customerEmail,
//                customerMobile }, statusCallbackUrl, singleTransactionOnly }
//                → body.{ linkId, shortUrl, longUrl, expiryDate }
//   • Fetch      /link/fetch { mid, linkId, pageNo, pageSize } → body.links[] { linkId,
//                shortUrl, amount, isActive, status, paymentStatus PENDING|INIT|EXPIRED|PAID }
//   • Txns       /link/fetchTransaction { mid, linkId } → body.orders[] { txnId, orderId,
//                orderStatus, txnAmount (rupees), orderCompletedTime, customer… }
//                resultCode 404 = no transactions yet. No fee is reported.
//   • Expire     /link/expire { mid, linkId } — Paytm's cancel.
//   • Webhook    Sent to the link's statusCallbackUrl, form key-value pairs, ONLY for
//                completed payments: STATUS (TXN_SUCCESS), TXNID, ORDERID, TXNAMOUNT,
//                MID, PAYMENTMODE, MERC_UNQ_REF ("LI_<linkId>"), CHECKSUMHASH …
//                Verify CHECKSUMHASH over all other params (sorted by key, values
//                joined with "|") with the merchant key.
//
// Checksum algorithm, from Paytm's own library (github.com/paytm/Paytm_Node_Checksum):
//   hash = sha256hex(str + "|" + salt) + salt   (salt = 4 base64 chars)
//   checksum = base64(AES-128-CBC(hash, key = merchant key, IV = "@@@@&&&&####$$$$"))
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'crypto';
import {
  GatewayError, rupeesToPaise,
  type CreateLinkInput, type CredentialField, type FetchLike, type GatewayCredentials,
  type GatewayMode, type GatewayPayment, type LinkRef, type LinkSnapshot, type LinkStatus,
  type PaymentGateway, type WebhookEvent,
} from './paymentGateway.ts';

const HOSTS = {
  STAGING: 'https://securestage.paytmpayments.com',
  PRODUCTION: 'https://secure.paytmpayments.com',
} as const;
const TIMEOUT_MS = 15_000;
const IV = '@@@@&&&&####$$$$';

// ── PaytmChecksum (same algorithm as the official library) ───────────────────
function aesKey(merchantKey: string): Buffer {
  const k = Buffer.from(String(merchantKey || ''), 'utf8');
  if (k.length !== 16) throw new GatewayError('The Paytm merchant key must be 16 characters.', 'CONFIG');
  return k;
}

export function paytmParamsString(params: Record<string, any>): string {
  return Object.keys(params).sort().map(k => (params[k] == null ? '' : String(params[k]))).join('|');
}

function paytmHash(str: string, salt: string): string {
  return crypto.createHash('sha256').update(`${str}|${salt}`).digest('hex') + salt;
}

export function paytmSign(str: string, merchantKey: string, salt = crypto.randomBytes(3).toString('base64')): string {
  const cipher = crypto.createCipheriv('aes-128-cbc', aesKey(merchantKey), IV);
  return cipher.update(paytmHash(str, salt), 'binary', 'base64') + cipher.final('base64');
}

export function paytmVerify(str: string, merchantKey: string, checksum: string): boolean {
  let decrypted: string;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', aesKey(merchantKey), IV);
    decrypted = decipher.update(String(checksum || ''), 'base64', 'binary') + decipher.final('binary');
  } catch {
    return false;
  }
  if (decrypted.length < 5) return false;
  const expected = paytmHash(str, decrypted.slice(-4));
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(decrypted, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Adapter ──────────────────────────────────────────────────────────────────
export class PaytmGateway implements PaymentGateway {
  readonly id = 'PAYTM' as const;
  readonly label = 'Paytm';
  readonly credentialFields: CredentialField[] = [
    { key: 'environment', label: 'Environment', secret: false, required: true, options: [{ value: 'STAGING', label: 'Staging (test)' }, { value: 'PRODUCTION', label: 'Production (live)' }], help: 'Staging credentials only work with Staging.' },
    { key: 'mid', label: 'Merchant ID (MID)', secret: false, required: true, help: 'Paytm for Business Dashboard → Developer Settings → API Keys.' },
    { key: 'merchant_key', label: 'Merchant Key', secret: true, required: true, help: '16 characters, shown next to the MID. It also checks the payment notifications.' },
  ];
  readonly setupSteps = [
    'Nothing to set up in Paytm for payment notifications: every link we create tells Paytm to report its payment to {webhookUrl}.',
    'Use Staging keys from the test dashboard first, and switch to Production keys when you are ready to take real payments.',
  ];
  readonly requiresCustomerPhone = false;

  constructor(private readonly fetchImpl: FetchLike = (globalThis.fetch as unknown as FetchLike)) {}

  modeOf(creds: GatewayCredentials): GatewayMode | null {
    const env = String(creds.environment || '').toUpperCase();
    if (env === 'STAGING') return 'TEST';
    if (env === 'PRODUCTION') return 'LIVE';
    return null;
  }

  async testConnection(creds: GatewayCredentials) {
    // Listing links proves the MID and key are accepted; "no data" is still a pass.
    await this.call(creds, '/link/fetch', { mid: creds.mid, pageNo: 1, pageSize: 1 }, { allowNotFound: true });
    const mode = this.modeOf(creds);
    return { mode, detail: `Paytm accepted the ${mode === 'LIVE' ? 'production' : 'staging'} MID and merchant key.` };
  }

  async createLink(creds: GatewayCredentials, input: CreateLinkInput): Promise<LinkSnapshot> {
    if (!Number.isInteger(input.amountPaise) || input.amountPaise < 100) {
      throw new GatewayError('Amount must be at least ₹1.', 'BAD_REQUEST');
    }
    if (!input.webhookUrl) throw new GatewayError('Paytm links need the status URL for this property.', 'CONFIG');
    const clean = (s: string, max: number) => String(s || '').replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
    const body: Record<string, any> = {
      mid: creds.mid,
      linkType: 'FIXED',
      linkName: clean(input.description, 64) || 'Payment',
      linkDescription: clean(input.description, 30) || 'Payment',
      amount: Number((input.amountPaise / 100).toFixed(2)),
      sendSms: false,
      sendEmail: false,
      singleTransactionOnly: true,
      statusCallbackUrl: input.webhookUrl,
    };
    if (input.expiresAt) body.expiryDate = this.paytmDate(input.expiresAt);
    const contact: Record<string, string> = {};
    if (input.customer.name) contact.customerName = input.customer.name;
    if (input.customer.email) contact.customerEmail = input.customer.email;
    const mobile = String(input.customer.phone || '').replace(/[^\d]/g, '').slice(-10);
    if (mobile.length === 10) contact.customerMobile = mobile;
    if (Object.keys(contact).length) body.customerContact = contact;

    const res = await this.call(creds, '/link/create', body);
    if (!res?.linkId) throw new GatewayError('Paytm returned a link without an id.', 'INVALID_RESPONSE');
    return {
      gatewayLinkId: String(res.linkId),
      referenceId: input.referenceId,
      url: this.url(res.shortUrl || res.longUrl),
      status: 'CREATED',
      amountPaise: input.amountPaise,
      amountPaidPaise: 0,
      expiresAt: input.expiresAt || null,
      payments: [],
    };
  }

  async fetchLink(creds: GatewayCredentials, ref: LinkRef): Promise<LinkSnapshot> {
    const linkId = this.linkId(ref.gatewayLinkId);
    const found = await this.call(creds, '/link/fetch', { mid: creds.mid, linkId, pageNo: 1, pageSize: 1 }, { allowNotFound: true });
    const link = (Array.isArray(found?.links) ? found.links : []).find((l: any) => String(l?.linkId) === String(ref.gatewayLinkId));
    if (!link) throw new GatewayError(`Paytm has no link ${ref.gatewayLinkId}.`, 'NOT_FOUND', 404);
    const txns = await this.call(creds, '/link/fetchTransaction', { mid: creds.mid, linkId }, { allowNotFound: true });

    const payments: GatewayPayment[] = (Array.isArray(txns?.orders) ? txns.orders : [])
      .filter((o: any) => o?.txnId || o?.orderId)
      .map((o: any) => {
        const st = String(o.orderStatus || '').toUpperCase();
        const contact = o.customerContact || {};
        return {
          gatewayPaymentId: String(o.txnId || o.orderId),
          amountPaise: rupeesToPaise(o.txnAmount ?? o.payableAmount ?? 0),
          status: /SUCCESS/.test(st) ? 'CAPTURED' : /FAIL/.test(st) ? 'FAILED' : 'PENDING',
          method: String(o.paymentMode || '').toLowerCase(),
          feePaise: null,   // Paytm does not report its fee per transaction here
          taxPaise: null,
          paidAt: this.parseDate(o.orderCompletedTime || o.orderCreatedTime) || new Date(),
          payerEmail: contact.customerEmail || o.customerEmail || undefined,
          payerPhone: contact.customerMobile || o.customerPhoneNumber || undefined,
        } as GatewayPayment;
      });

    const amountPaise = rupeesToPaise(link.amount ?? 0);
    const paid = payments.filter(p => p.status === 'CAPTURED').reduce((s, p) => s + p.amountPaise, 0);
    const expiresAt = this.parseDate(link.expiryDate);
    let status: LinkStatus = 'CREATED';
    if (paid > 0 && (paid >= amountPaise || String(link.paymentStatus).toUpperCase() === 'PAID')) status = 'PAID';
    else if (paid > 0) status = 'PARTIALLY_PAID';
    else if (link.isActive === false || String(link.status || '').toUpperCase() === 'EXPIRED' || String(link.paymentStatus).toUpperCase() === 'EXPIRED') {
      // Paytm "expires" a link both when its date passes and when we cancel it.
      status = expiresAt && expiresAt.getTime() <= Date.now() ? 'EXPIRED' : 'CANCELLED';
    }
    return {
      gatewayLinkId: String(link.linkId),
      referenceId: ref.referenceId,
      url: this.url(link.shortUrl || link.longUrl),
      status,
      amountPaise,
      amountPaidPaise: paid,
      expiresAt,
      payments,
    };
  }

  async cancelLink(creds: GatewayCredentials, ref: LinkRef): Promise<LinkSnapshot> {
    await this.call(creds, '/link/expire', { mid: creds.mid, linkId: this.linkId(ref.gatewayLinkId) });
    return { gatewayLinkId: ref.gatewayLinkId, referenceId: ref.referenceId, url: '', status: 'CANCELLED', amountPaise: 0, amountPaidPaise: 0, expiresAt: null, payments: [] };
  }

  verifyWebhook(creds: GatewayCredentials, rawBody: Buffer, _headers: Record<string, string | string[] | undefined>): boolean {
    if (!creds.merchant_key || !Buffer.isBuffer(rawBody)) return false;
    const params = this.webhookParams(rawBody);
    const checksum = params.CHECKSUMHASH;
    if (!checksum) return false;
    // A notification for another merchant is not ours, whatever it says.
    if (creds.mid && params.MID && params.MID !== creds.mid) return false;
    const rest = { ...params };
    delete rest.CHECKSUMHASH;
    try {
      return paytmVerify(paytmParamsString(rest), String(creds.merchant_key), checksum);
    } catch {
      return false;
    }
  }

  parseWebhook(rawBody: Buffer, _headers: Record<string, string | string[] | undefined>): WebhookEvent {
    const p = this.webhookParams(rawBody);
    if (!p.TXNID && !p.ORDERID) throw new GatewayError('Paytm notification has no transaction id.', 'INVALID_RESPONSE');
    const ref = String(p.MERC_UNQ_REF || '');
    return {
      eventId: p.TXNID || p.ORDERID || null,
      eventType: `link.payment.${String(p.STATUS || 'unknown').toLowerCase()}`,
      gatewayLinkId: ref ? ref.replace(/^LI_/i, '') : null,
      referenceId: null,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private host(creds: GatewayCredentials): string {
    const env = String(creds.environment || '').toUpperCase();
    if (env !== 'STAGING' && env !== 'PRODUCTION') throw new GatewayError('Choose the Paytm environment (Staging or Production).', 'CONFIG');
    return HOSTS[env];
  }

  private async call(creds: GatewayCredentials, path: string, body: Record<string, any>, opts: { allowNotFound?: boolean } = {}): Promise<any> {
    const missing = ['mid', 'merchant_key'].filter(k => !String(creds?.[k] || '').trim());
    if (missing.length) throw new GatewayError(`Paytm ${missing.join(', ')} not configured.`, 'CONFIG');
    const host = this.host(creds);
    // Sign the exact string that is sent: the body is serialised once.
    const bodyJson = JSON.stringify(body);
    const signature = paytmSign(bodyJson, String(creds.merchant_key));
    const payload = `{"body":${bodyJson},"head":{"tokenType":"AES","signature":${JSON.stringify(signature)}}}`;

    let res;
    try {
      res = await this.fetchImpl(`${host}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e: any) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new GatewayError('Paytm did not respond in time.', 'TIMEOUT', null, true);
      throw new GatewayError('Could not reach Paytm.', 'UNAVAILABLE', null, true);
    }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* handled below */ }
    if (res.status >= 500 || res.status === 429) throw new GatewayError(`Paytm is unavailable (HTTP ${res.status}).`, 'UNAVAILABLE', res.status, true);
    if (!json?.body) throw new GatewayError(`Paytm returned an unreadable response (HTTP ${res.status}).`, 'INVALID_RESPONSE', res.status);

    const info = json.body.resultInfo || {};
    const code = String(info.resultCode || '');
    const message = String(info.resultMessage || info.resultMsg || '') || `code ${code}`;
    if (String(info.resultStatus || '').toUpperCase() === 'SUCCESS') return json.body;
    if (code === '404' && opts.allowNotFound) return json.body;
    if (code === '5028' || res.status === 401) throw new GatewayError('Paytm rejected the MID or merchant key (checksum invalid).', 'AUTH_FAILED', res.status);
    if (code === '404') throw new GatewayError(`Paytm: ${message}`, 'NOT_FOUND', 404);
    if (code === '501' || code === '502') throw new GatewayError(`Paytm is unavailable: ${message}`, 'UNAVAILABLE', res.status, true);
    throw new GatewayError(`Paytm: ${message}`, 'BAD_REQUEST', res.status);
  }

  private webhookParams(rawBody: Buffer): Record<string, string> {
    const text = rawBody.toString('utf8').trim();
    if (text.startsWith('{')) {
      try {
        const obj = JSON.parse(text);
        return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v == null ? '' : String(v)]));
      } catch { return {}; }
    }
    const out: Record<string, string> = {};
    new URLSearchParams(text).forEach((v, k) => { out[k] = v; });
    return out;
  }

  private linkId(id: string): number | string {
    return /^\d+$/.test(String(id)) ? Number(id) : String(id);
  }

  private url(u: any): string {
    const s = String(u || '').trim();
    if (!s) return '';
    return /^https?:\/\//i.test(s) ? s : `https://${s}`;
  }

  // "dd/mm/yyyy hh:mm:ss" in India time, the format Paytm's create API takes.
  private paytmDate(d: Date): string {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map(p => [p.type, p.value]));
    return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
  }

  // Paytm dates come back as "dd/mm/yyyy[ hh:mm:ss]", "yyyy-mm-dd[ hh:mm:ss]" or
  // epoch; all are India time when no zone is given.
  private parseDate(v: any): Date | null {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    if (/^\d{10,13}$/.test(s)) { const n = Number(s); return new Date(n > 1e12 ? n : n * 1000); }
    let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4] || '23'}:${m[5] || '59'}:${m[6] || '59'}+05:30`);
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/);
    if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4] || '23'}:${m[5] || '59'}:${m[6] || '59'}+05:30`);
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
}
