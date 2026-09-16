// ─────────────────────────────────────────────────────────────────────────────
// paymentGateway.ts — the contract every online payment gateway implements.
//
// A tenant brings its OWN gateway account (Razorpay today; PhonePe and Paytm
// next). Money settles into the tenant's bank through that account; the platform
// never holds funds. Staff create a payment link for an amount owed, send it on
// WhatsApp or email, and when the customer pays the payment is recorded against
// the folio / invoice / booking automatically.
//
// Rules every adapter follows, because they are what make the loop safe:
//   • Amounts cross this boundary as INTEGER PAISE. Never floats of rupees.
//   • A webhook is a TRIGGER, never the truth. verifyWebhook() proves the call
//     came from the gateway; the caller then re-reads the link with fetchLink()
//     and records only what the gateway's API reports as captured.
//   • Recording is idempotent on gatewayPaymentId, because every gateway
//     delivers webhooks at least once and sometimes more.
//   • Adapters are pure HTTP + crypto: no database, no tenant lookups, no
//     logging of credentials. Credentials arrive already decrypted.
//
// Adding a gateway = one new file implementing PaymentGateway + one line in
// paymentGatewayRegistry.ts. Nothing else in the product should branch on the
// gateway id. This file imports nothing, so adapters can import it freely.
// ─────────────────────────────────────────────────────────────────────────────

export type GatewayId = 'RAZORPAY' | 'PHONEPE' | 'PAYTM';
export type GatewayMode = 'TEST' | 'LIVE';

// Normalised link lifecycle. Gateways use their own words; adapters map to these.
export type LinkStatus = 'CREATED' | 'PARTIALLY_PAID' | 'PAID' | 'EXPIRED' | 'CANCELLED' | 'FAILED';

export type GatewayCredentials = Record<string, string>;

// Drives the tenant settings form. `secret` fields are write-only in the UI:
// stored encrypted, never sent back to the browser, shown as "saved".
export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  help?: string;
  options?: { value: string; label: string }[];  // renders as a choice, e.g. sandbox / production
}

export interface CreateLinkInput {
  referenceId: string;            // OUR link id — unique per link; ≤ 40 chars fits every gateway
  amountPaise: number;            // integer, ≥ 100 (₹1)
  description: string;
  customer: { name?: string; email?: string; phone?: string };
  expiresAt?: Date;
  callbackUrl?: string;           // where the customer lands after paying
  webhookUrl?: string;            // for gateways that take the status URL per link (Paytm)
  notes?: Record<string, string>; // echoed back by the gateway; never put secrets here
}

// How a gateway addresses an existing link. Some use their own id (Razorpay,
// Paytm), some the merchant's reference (PhonePe); adapters take what they need.
export interface LinkRef {
  gatewayLinkId: string;
  referenceId: string;
}

export interface GatewayPayment {
  gatewayPaymentId: string;
  amountPaise: number;
  status: 'CAPTURED' | 'PENDING' | 'FAILED';
  method: string;                 // gateway's own word, lower-case: upi, card, netbanking, wallet…
  feePaise: number | null;        // gateway charge incl. GST, when the gateway reports it
  taxPaise: number | null;        // GST portion of feePaise
  paidAt: Date;
  payerVpa?: string;
  payerEmail?: string;
  payerPhone?: string;
}

export interface LinkSnapshot {
  gatewayLinkId: string;
  referenceId: string;
  url: string;
  status: LinkStatus;
  amountPaise: number;
  amountPaidPaise: number;
  expiresAt: Date | null;
  payments: GatewayPayment[];
}

export interface WebhookEvent {
  eventId: string | null;         // gateway's delivery id, for de-duplication
  eventType: string;
  gatewayLinkId: string | null;
  referenceId: string | null;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly code: 'AUTH_FAILED' | 'BAD_REQUEST' | 'NOT_FOUND' | 'UNAVAILABLE' | 'TIMEOUT' | 'INVALID_RESPONSE' | 'CONFIG',
    readonly httpStatus: number | null = null,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface PaymentGateway {
  readonly id: GatewayId;
  readonly label: string;
  readonly credentialFields: CredentialField[];
  // What the owner does in the gateway's own dashboard so webhooks reach us.
  // {webhookUrl} is replaced with the property's URL on the settings page.
  readonly setupSteps: string[];
  // Phone number the gateway insists on before it will create a link.
  readonly requiresCustomerPhone: boolean;
  // TEST or LIVE, when the credentials themselves say so; null when they cannot.
  modeOf(creds: GatewayCredentials): GatewayMode | null;
  // Resolves when the gateway accepts the credentials; throws GatewayError otherwise.
  testConnection(creds: GatewayCredentials): Promise<{ mode: GatewayMode | null; detail: string }>;
  createLink(creds: GatewayCredentials, input: CreateLinkInput): Promise<LinkSnapshot>;
  fetchLink(creds: GatewayCredentials, ref: LinkRef): Promise<LinkSnapshot>;
  cancelLink(creds: GatewayCredentials, ref: LinkRef): Promise<LinkSnapshot>;
  // rawBody must be the exact bytes received — a re-serialised JSON body fails.
  verifyWebhook(creds: GatewayCredentials, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent;
}

// ── Money ────────────────────────────────────────────────────────────────────
// Rupees → paise without float drift: 199.99 * 100 is 19998.999… in IEEE-754.
export function rupeesToPaise(rupees: number | string): number {
  const n = typeof rupees === 'string' ? Number(rupees) : rupees;
  if (!Number.isFinite(n)) throw new GatewayError(`Invalid amount: ${rupees}`, 'BAD_REQUEST');
  return Math.round(n * 100);
}

export function paiseToRupees(paise: number): number {
  return Math.round(paise) / 100;
}

// ── Shared HTTP ──────────────────────────────────────────────────────────────
export type FetchLike = (url: string, init?: any) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const v = headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}
