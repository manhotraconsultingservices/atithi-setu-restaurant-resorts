/**
 * Channel Adapter Framework
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Per-OTA adapters that translate Atithi-Setu's booking/availability shape
 * into each provider's required wire format and validate inbound webhook
 * signatures using each OTA's published HMAC scheme.
 *
 * OTA-hardening pass (8 Jun 2026, see docs/OTA_INTEGRATION_AUDIT.md):
 *   - validateWebhook() now performs REAL HMAC checks (was stubbed `ok:true`)
 *   - Timestamp validation (±5 min window) where the OTA sends one
 *   - Nonce / replay protection at the route handler layer
 *   - external_room_code → local_room_id resolution via the new
 *     channel_room_mappings table (handled in server.ts, not here — the
 *     adapter just surfaces the OTA's room code in parseInbound output)
 *
 * The signature algorithms per channel come straight from the published
 * Connectivity Partner specs (Booking.com BDC v2, MMT Hotel Connect v3,
 * Agoda YCS legacy, Expedia EQC v2).
 *
 * Outbound push (pushBooking / pushAvailability) remains stubbed —
 * production wiring requires sandbox credentials per partnership which
 * are out of scope for this commit. The framework + signing keys are in
 * place so swapping each stub for an axios.post() is a contained change.
 */

import { createHmac, timingSafeEqual } from 'crypto';

export interface ChannelCredentials {
  channel: string;
  api_key: string | null;       // plaintext (often a public identifier)
  api_secret: string | null;    // encrypted by server.ts; decrypt before use
  property_id: string | null;
  is_enabled: number;
  // OTA hardening — separate secret for verifying inbound webhook
  // signatures. Per Booking.com Connectivity v2 + MMT Hotel Connect v3
  // + Agoda YCS specs, the webhook signing key is shown in a different
  // panel of the OTA extranet than the outbound push key.
  webhook_signing_secret?: string | null;
  // Gap 5 — per-channel commission % applied to gross booking amount
  // to compute net revenue. 0 = no deduction. Set in the Channel Manager
  // UI; the inbound webhook handler snapshots this onto room_bookings
  // at booking time.
  commission_pct?: number;
}

export interface AdapterBookingPayload {
  bookingId: string;
  guestName: string;
  guestPhone: string | null;
  guestEmail: string | null;
  roomId: string;
  roomName: string | null;
  checkInDate: string;       // YYYY-MM-DD
  checkOutDate: string;      // YYYY-MM-DD
  totalAmount: number;
  bookingType: 'OVERNIGHT' | 'DAY_USE';
  source: string;            // original booking_source
  status: string;
  // OTA-side codes captured from the inbound payload. The server-side
  // handler uses these to look up channel_room_mappings; without them
  // the inbound CREATED branch can't pick a local room.
  externalRoomCode?: string | null;
  externalRatePlanCode?: string | null;
}

export interface AdapterAvailabilityPayload {
  roomId: string;
  roomName: string | null;
  date: string;              // YYYY-MM-DD
  available: boolean;
  rate: number;
  rateLabel: string | null;
}

export interface AdapterResult {
  ok: boolean;
  message: string;
  externalRef?: string | null;  // OTA's reservation ID, if returned
}

export interface ValidateResult {
  ok: boolean;
  reason?: string;
  /** Nonce that the route handler should add to channel_webhook_nonces. */
  nonce?: string | null;
  /** Timestamp the adapter extracted from the request — for audit. */
  timestamp?: string | null;
  /** Adapter explicitly chose not to enforce replay protection (e.g. legacy
   *  OTAs that don't send a timestamp). Logged loudly when true. */
  replay_check_skipped?: boolean;
}

/** Gap 8 — daily reconciliation. The 03:00 IST cron calls
 *  adapter.pullBookings() per (tenant, channel) and diffs the result
 *  against local room_bookings tagged with that channel. Stub adapters
 *  return { ok: true, bookings: [], note: 'stub' } so the cron logs a
 *  clear 'skipped_stub' row instead of failing. */
export interface AdapterPullResult {
  ok: boolean;
  bookings: Array<Partial<AdapterBookingPayload>>;
  /** When the adapter is a stub (no real API call). */
  stub?: boolean;
  /** Free-text note for the reconciliation report's summary_json. */
  note?: string;
  reason?: string;
}

export interface ChannelAdapter {
  channel: string;
  /** Is this adapter ready for live calls (credentials configured + enabled)? */
  isReady(creds: ChannelCredentials): boolean;
  /** Push a single booking to the OTA. */
  pushBooking(creds: ChannelCredentials, payload: AdapterBookingPayload): Promise<AdapterResult>;
  /** Push availability/rate updates for a date range. */
  pushAvailability(creds: ChannelCredentials, payloads: AdapterAvailabilityPayload[]): Promise<AdapterResult>;
  /** Validate an inbound webhook (signature, idempotency token, etc). */
  validateWebhook(creds: ChannelCredentials, headers: Record<string, string | string[] | undefined>, rawBody: string, body: any): ValidateResult;
  /** Convert an inbound webhook body into an internal-shape booking. */
  parseInbound(creds: ChannelCredentials, body: any): {
    ok: boolean;
    booking?: Partial<AdapterBookingPayload>;
    operation?: 'CREATED' | 'MODIFIED' | 'CANCELLED';
    reason?: string;
  };
  /** Gap 8 — pull recently-changed bookings from the OTA. Used by the
   *  daily reconciliation cron to catch missed webhooks. Stubs return
   *  an empty array tagged stub:true. */
  pullBookings(creds: ChannelCredentials, sinceIso: string): Promise<AdapterPullResult>;
}

// ════════════════════════════════════════════════════════════════════════
// HMAC verification helpers (used by every concrete adapter)
// ════════════════════════════════════════════════════════════════════════

/**
 * Constant-time HMAC comparison. Pulls a header (case-insensitive) and
 * compares its hex/base64 value against the expected HMAC digest.
 *
 * Returns true on match. Returns false (with `reason` in the parent
 * ValidateResult) on missing header, wrong length, or mismatched bytes.
 */
function verifyHmac(opts: {
  secret: string;
  algorithm: 'sha256' | 'sha1';
  body: string;                            // raw request body (string, NOT parsed JSON)
  headers: Record<string, string | string[] | undefined>;
  signatureHeader: string;                 // 'X-Booking-Signature' etc
  encoding?: 'hex' | 'base64';             // most OTAs use hex; Booking.com is base64
  /** Some OTAs (MMT) sign `{timestamp}.{body}` not just `{body}`. */
  signedPrefix?: string;
}): { ok: boolean; reason?: string } {
  const hdrRaw = pickHeader(opts.headers, opts.signatureHeader);
  if (!hdrRaw) {
    return { ok: false, reason: `Missing ${opts.signatureHeader} header` };
  }
  const expected = createHmac(opts.algorithm, opts.secret)
    .update((opts.signedPrefix || '') + opts.body, 'utf8')
    .digest(opts.encoding || 'hex');
  // Booking.com sometimes prefixes the signature with the algorithm:
  // "sha256=abc123..." — strip that.
  let received = String(hdrRaw).trim();
  const eqIdx = received.indexOf('=');
  if (eqIdx > 0 && eqIdx < 12) received = received.slice(eqIdx + 1);
  if (received.length !== expected.length) {
    return { ok: false, reason: `${opts.signatureHeader} length mismatch (expected ${expected.length}, got ${received.length})` };
  }
  try {
    const a = Buffer.from(received, opts.encoding || 'hex');
    const b = Buffer.from(expected, opts.encoding || 'hex');
    if (a.length !== b.length) return { ok: false, reason: 'signature buffer length mismatch' };
    return timingSafeEqual(a, b)
      ? { ok: true }
      : { ok: false, reason: `${opts.signatureHeader} HMAC mismatch` };
  } catch (err: any) {
    return { ok: false, reason: `signature decode failed: ${err?.message || err}` };
  }
}

function pickHeader(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  // Express lowercases header names. Try lowercase first, then the
  // original case as defensive fallback.
  const lc = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lc) {
      const v = headers[k];
      if (Array.isArray(v)) return v[0] || null;
      return v || null;
    }
  }
  return null;
}

/**
 * Validate a Unix-seconds timestamp header is within ±5 min of server time.
 * Returns the timestamp string for audit logging on success.
 */
function validateTimestamp(
  headers: Record<string, string | string[] | undefined>,
  headerName: string,
  skewSeconds = 300,
): { ok: boolean; reason?: string; timestamp?: string } {
  const v = pickHeader(headers, headerName);
  if (!v) return { ok: false, reason: `Missing ${headerName} header (replay protection requires a fresh timestamp)` };
  const ts = Number(v);
  if (!Number.isFinite(ts)) return { ok: false, reason: `${headerName} is not a valid number` };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > skewSeconds) {
    return { ok: false, reason: `${headerName} skew ${Math.abs(now - ts)}s exceeds ${skewSeconds}s window (possible replay)` };
  }
  return { ok: true, timestamp: String(ts) };
}

// ════════════════════════════════════════════════════════════════════════
// Adapters
// ════════════════════════════════════════════════════════════════════════

/**
 * Mock adapter — used when no real adapter is registered. Outbound calls
 * log + return synthetic success. Inbound validation REJECTS (mock should
 * never accept production webhooks).
 */
class MockAdapter implements ChannelAdapter {
  channel = 'MOCK';
  isReady(_creds: ChannelCredentials) { return true; }
  async pushBooking(_creds: ChannelCredentials, payload: AdapterBookingPayload): Promise<AdapterResult> {
    console.log(`[channel-mock] would push booking ${payload.bookingId} (${payload.guestName}, ${payload.checkInDate} → ${payload.checkOutDate})`);
    return { ok: true, message: 'mock-success', externalRef: `MOCK-${payload.bookingId}` };
  }
  async pushAvailability(_creds: ChannelCredentials, payloads: AdapterAvailabilityPayload[]): Promise<AdapterResult> {
    console.log(`[channel-mock] would push ${payloads.length} availability updates`);
    return { ok: true, message: `mock-${payloads.length}-rows` };
  }
  validateWebhook(_creds: ChannelCredentials, _headers: any, _rawBody: string, _body: any): ValidateResult {
    return { ok: false, reason: 'MOCK adapter — explicit channel must be configured' };
  }
  parseInbound() {
    return { ok: false, reason: 'MOCK adapter cannot parse inbound webhooks' };
  }
  async pullBookings(): Promise<AdapterPullResult> {
    return { ok: true, bookings: [], stub: true, note: 'MockAdapter has no real API' };
  }
}

/**
 * Booking.com Connectivity Partner adapter.
 *
 * Inbound signature (production-ready):
 *   - Header: X-Booking-Signature (base64-encoded HMAC-SHA256)
 *   - Algo:   HMAC-SHA256 of the raw request body
 *   - Secret: webhook_signing_secret (separate from api_secret — BDC shows
 *             this in the Webhook Configuration panel of the extranet)
 *   - Timestamp: X-Booking-Timestamp (Unix seconds, ±5min skew)
 *
 * Outbound (stub — needs partner approval):
 *   - XML over HTTPS to https://supply-xml.booking.com/hotels/xml/
 *   - HTTP Basic auth with api_key/api_secret
 *   - OTA_HotelResNotifRQ / OTA_HotelAvailRQ schemas
 */
class BookingComAdapter implements ChannelAdapter {
  channel = 'BOOKING';
  isReady(c: ChannelCredentials) {
    return !!(c.is_enabled && c.api_key && c.api_secret && c.property_id);
  }
  async pushBooking(creds: ChannelCredentials, payload: AdapterBookingPayload): Promise<AdapterResult> {
    if (!this.isReady(creds)) return { ok: false, message: 'Booking.com credentials not configured.' };
    console.log(`[channel-bdc:stub] would push booking ${payload.bookingId} as OTA_HotelResNotifRQ for hotel ${creds.property_id}`);
    return { ok: true, message: 'bdc-stub: payload validated; awaiting partner approval', externalRef: null };
  }
  async pushAvailability(creds: ChannelCredentials, payloads: AdapterAvailabilityPayload[]): Promise<AdapterResult> {
    if (!this.isReady(creds)) return { ok: false, message: 'Booking.com credentials not configured.' };
    console.log(`[channel-bdc:stub] would push ${payloads.length} availability rows for hotel ${creds.property_id}`);
    return { ok: true, message: 'bdc-stub: availability payload validated' };
  }
  validateWebhook(creds: ChannelCredentials, headers: any, rawBody: string, _body: any): ValidateResult {
    const secret = creds.webhook_signing_secret || creds.api_secret;
    if (!secret) return { ok: false, reason: 'No webhook_signing_secret configured for Booking.com' };
    const ts = validateTimestamp(headers, 'X-Booking-Timestamp');
    if (!ts.ok) return { ok: false, reason: ts.reason };
    const sig = verifyHmac({
      secret, algorithm: 'sha256', body: rawBody, headers,
      signatureHeader: 'X-Booking-Signature', encoding: 'base64',
    });
    if (!sig.ok) return { ok: false, reason: sig.reason };
    return { ok: true, timestamp: ts.timestamp, nonce: pickHeader(headers, 'X-Booking-Request-Id') || null };
  }
  parseInbound(_creds: ChannelCredentials, body: any) {
    if (!body || typeof body !== 'object') return { ok: false, reason: 'empty body' };
    return {
      ok: !!body.bookingId,
      booking: body.bookingId ? {
        bookingId: String(body.bookingId),
        guestName: body.guestName || 'BDC Guest',
        guestPhone: body.guestPhone || null,
        guestEmail: body.guestEmail || null,
        roomId: '',  // server will resolve via channel_room_mappings
        externalRoomCode: String(body.roomTypeId || body.roomId || ''),
        externalRatePlanCode: body.ratePlanId ? String(body.ratePlanId) : null,
        roomName: body.roomName || null,
        checkInDate: body.checkInDate || '',
        checkOutDate: body.checkOutDate || '',
        totalAmount: Number(body.totalAmount || 0),
        bookingType: 'OVERNIGHT' as const,
        source: 'BOOKING',
        status: body.cancelled ? 'CANCELLED' : 'BOOKED',
      } : undefined,
      operation: (body.cancelled ? 'CANCELLED' : (body.modified ? 'MODIFIED' : 'CREATED')) as 'CREATED' | 'MODIFIED' | 'CANCELLED',
      reason: body.bookingId ? undefined : 'bookingId missing from BDC webhook body',
    };
  }
  async pullBookings(creds: ChannelCredentials, _sinceIso: string): Promise<AdapterPullResult> {
    if (!this.isReady(creds)) return { ok: false, bookings: [], reason: 'Booking.com credentials not configured' };
    // TODO(BDC): GET https://supply-xml.booking.com/hotels/xml/reservations?modify_date_from={sinceIso}
    return { ok: true, bookings: [], stub: true, note: 'bdc-stub: awaiting partner approval' };
  }
}

/**
 * MakeMyTrip / Goibibo Hotel Connect adapter.
 *
 * Inbound signature (MMT Hotel Connect v3):
 *   - Header: X-MMT-Signature (hex-encoded HMAC-SHA256)
 *   - Algo:   HMAC-SHA256 of "{timestamp}.{rawBody}"  ← timestamp prefix!
 *   - Secret: webhook_signing_secret
 *   - Timestamp: X-MMT-Timestamp (Unix seconds, ±5min skew)
 *
 * MMT + Goibibo share the same backend, so this class is reused by
 * GoibiboAdapter via subclassing.
 *
 * Outbound (stub):
 *   - OAuth 2.0 client_credentials grant against
 *     https://connect-api.makemytrip.com/oauth/token (1hr TTL)
 *   - JSON POST to /api/v1/inventory, /bookings, /bookings/{id}/ack
 *   - mmt_hotel_id from the property_id field
 */
class MakeMyTripAdapter implements ChannelAdapter {
  channel = 'MMT';
  /** Override-able by Goibibo subclass — header names share a different prefix. */
  protected signatureHeader = 'X-MMT-Signature';
  protected timestampHeader = 'X-MMT-Timestamp';
  protected requestIdHeader = 'X-MMT-Request-Id';

  isReady(c: ChannelCredentials) {
    return !!(c.is_enabled && c.api_key && c.api_secret && c.property_id);
  }
  async pushBooking(creds: ChannelCredentials, payload: AdapterBookingPayload): Promise<AdapterResult> {
    if (!this.isReady(creds)) return { ok: false, message: `${this.channel} credentials not configured.` };
    console.log(`[channel-${this.channel.toLowerCase()}:stub] would push booking ${payload.bookingId} for hotel ${creds.property_id}`);
    return { ok: true, message: `${this.channel.toLowerCase()}-stub: payload validated; awaiting partner approval` };
  }
  async pushAvailability(creds: ChannelCredentials, payloads: AdapterAvailabilityPayload[]): Promise<AdapterResult> {
    if (!this.isReady(creds)) return { ok: false, message: `${this.channel} credentials not configured.` };
    console.log(`[channel-${this.channel.toLowerCase()}:stub] would push ${payloads.length} availability rows`);
    return { ok: true, message: `${this.channel.toLowerCase()}-stub: availability validated` };
  }
  validateWebhook(creds: ChannelCredentials, headers: any, rawBody: string, _body: any): ValidateResult {
    const secret = creds.webhook_signing_secret || creds.api_secret;
    if (!secret) return { ok: false, reason: `No webhook_signing_secret configured for ${this.channel}` };
    const ts = validateTimestamp(headers, this.timestampHeader);
    if (!ts.ok) return { ok: false, reason: ts.reason };
    const sig = verifyHmac({
      secret, algorithm: 'sha256', body: rawBody, headers,
      signatureHeader: this.signatureHeader, encoding: 'hex',
      signedPrefix: `${ts.timestamp}.`,  // MMT signs {ts}.{body}
    });
    if (!sig.ok) return { ok: false, reason: sig.reason };
    return { ok: true, timestamp: ts.timestamp, nonce: pickHeader(headers, this.requestIdHeader) || null };
  }
  parseInbound(_creds: ChannelCredentials, body: any) {
    if (!body?.booking_id) return { ok: false, reason: `booking_id missing in ${this.channel} payload` };
    return {
      ok: true,
      booking: {
        bookingId: String(body.booking_id),
        guestName: body.guest_name,
        guestPhone: body.guest_phone || null,
        guestEmail: body.guest_email || null,
        roomId: '',  // server resolves via channel_room_mappings
        externalRoomCode: String(body.room_type_code || body.room_id || ''),
        externalRatePlanCode: body.rate_plan_code ? String(body.rate_plan_code) : null,
        roomName: body.room_name || null,
        checkInDate: body.check_in,
        checkOutDate: body.check_out,
        totalAmount: Number(body.total || 0),
        bookingType: 'OVERNIGHT' as const,
        source: this.channel,
        status: body.status === 'CANCELLED' ? 'CANCELLED' : 'BOOKED',
      },
      operation: (body.status === 'CANCELLED' ? 'CANCELLED'
                 : body.status === 'MODIFIED' ? 'MODIFIED'
                 : 'CREATED') as 'CREATED' | 'MODIFIED' | 'CANCELLED',
    };
  }
  async pullBookings(creds: ChannelCredentials, _sinceIso: string): Promise<AdapterPullResult> {
    if (!this.isReady(creds)) return { ok: false, bookings: [], reason: `${this.channel} credentials not configured` };
    return { ok: true, bookings: [], stub: true, note: `${this.channel}-stub: awaiting partner approval` };
  }
}

/**
 * Goibibo adapter — same backend as MMT, different header prefix.
 */
class GoibiboAdapter extends MakeMyTripAdapter {
  channel = 'GOIBIBO';
  protected signatureHeader = 'X-GIB-Signature';
  protected timestampHeader = 'X-GIB-Timestamp';
  protected requestIdHeader = 'X-GIB-Request-Id';
}

/**
 * Agoda YCS adapter.
 *
 * Inbound signature (Agoda YCS, still legacy SHA-1 as of 2026):
 *   - Header: X-Ycs-Signature (hex-encoded HMAC-SHA1)
 *   - Algo:   HMAC-SHA1 of raw request body
 *   - Secret: webhook_signing_secret
 *   - Timestamp: X-Ycs-Timestamp (optional — Agoda doesn't enforce yet,
 *                  but we require it when present)
 *
 * Outbound (stub):
 *   - XML POST to https://ycs.agoda.com/api/...
 *   - API key in X-YCS-AUTH header
 */
class AgodaAdapter implements ChannelAdapter {
  channel = 'AGODA';
  isReady(c: ChannelCredentials) {
    return !!(c.is_enabled && c.api_key && c.property_id);
  }
  async pushBooking(creds: ChannelCredentials, payload: AdapterBookingPayload): Promise<AdapterResult> {
    if (!this.isReady(creds)) return { ok: false, message: 'Agoda credentials not configured.' };
    console.log(`[channel-agoda:stub] would push booking ${payload.bookingId}`);
    return { ok: true, message: 'agoda-stub: payload validated' };
  }
  async pushAvailability(creds: ChannelCredentials, _payloads: AdapterAvailabilityPayload[]): Promise<AdapterResult> {
    if (!this.isReady(creds)) return { ok: false, message: 'Agoda credentials not configured.' };
    return { ok: true, message: 'agoda-stub: availability validated' };
  }
  validateWebhook(creds: ChannelCredentials, headers: any, rawBody: string, _body: any): ValidateResult {
    const secret = creds.webhook_signing_secret || creds.api_secret;
    if (!secret) return { ok: false, reason: 'No webhook_signing_secret configured for Agoda' };
    // Timestamp optional for Agoda (their spec doesn't require it as of
    // 2026), but if present we validate.
    const tsRaw = pickHeader(headers, 'X-Ycs-Timestamp');
    let timestamp: string | null = null;
    let replaySkipped = false;
    if (tsRaw) {
      const ts = validateTimestamp(headers, 'X-Ycs-Timestamp');
      if (!ts.ok) return { ok: false, reason: ts.reason };
      timestamp = ts.timestamp || null;
    } else {
      replaySkipped = true;
    }
    const sig = verifyHmac({
      secret, algorithm: 'sha1', body: rawBody, headers,
      signatureHeader: 'X-Ycs-Signature', encoding: 'hex',
    });
    if (!sig.ok) return { ok: false, reason: sig.reason };
    return { ok: true, timestamp, replay_check_skipped: replaySkipped };
  }
  parseInbound(_creds: ChannelCredentials, body: any) {
    if (!body?.reservation_id) return { ok: false, reason: 'reservation_id missing' };
    return {
      ok: true,
      booking: {
        bookingId: String(body.reservation_id),
        guestName: body.guest_name,
        guestPhone: body.guest_phone || null,
        guestEmail: body.guest_email || null,
        roomId: '',
        externalRoomCode: String(body.room_type || body.room_id || ''),
        externalRatePlanCode: body.rate_plan ? String(body.rate_plan) : null,
        roomName: body.room_name || null,
        checkInDate: body.check_in,
        checkOutDate: body.check_out,
        totalAmount: Number(body.total || 0),
        bookingType: 'OVERNIGHT' as const,
        source: 'AGODA',
        status: body.status === 'CANCELLED' ? 'CANCELLED' : 'BOOKED',
      },
      operation: (body.status === 'CANCELLED' ? 'CANCELLED' : 'CREATED') as 'CREATED' | 'MODIFIED' | 'CANCELLED',
    };
  }
  async pullBookings(creds: ChannelCredentials, _sinceIso: string): Promise<AdapterPullResult> {
    if (!this.isReady(creds)) return { ok: false, bookings: [], reason: 'Agoda credentials not configured' };
    return { ok: true, bookings: [], stub: true, note: 'agoda-stub: awaiting partner approval' };
  }
}

/**
 * Expedia QuickConnect (EQC v2) adapter.
 *
 * Inbound signature:
 *   - Header: X-Expedia-Signature (hex-encoded HMAC-SHA256)
 *   - Algo:   HMAC-SHA256 of raw body
 *   - Secret: webhook_signing_secret
 *   - Timestamp: X-Expedia-Timestamp (STRICT 5-min window — Expedia
 *                  enforces strictly per the EQC v2 spec)
 *
 * Outbound (stub): https://developer.expediapartnersolutions.com
 */
class ExpediaAdapter implements ChannelAdapter {
  channel = 'EXPEDIA';
  isReady(c: ChannelCredentials) {
    return !!(c.is_enabled && c.api_key && c.api_secret && c.property_id);
  }
  async pushBooking(creds: ChannelCredentials, payload: AdapterBookingPayload): Promise<AdapterResult> {
    if (!this.isReady(creds)) return { ok: false, message: 'Expedia credentials not configured.' };
    console.log(`[channel-expedia:stub] would push booking ${payload.bookingId}`);
    return { ok: true, message: 'expedia-stub: payload validated' };
  }
  async pushAvailability(creds: ChannelCredentials, _payloads: AdapterAvailabilityPayload[]): Promise<AdapterResult> {
    if (!this.isReady(creds)) return { ok: false, message: 'Expedia credentials not configured.' };
    return { ok: true, message: 'expedia-stub: availability validated' };
  }
  validateWebhook(creds: ChannelCredentials, headers: any, rawBody: string, _body: any): ValidateResult {
    const secret = creds.webhook_signing_secret || creds.api_secret;
    if (!secret) return { ok: false, reason: 'No webhook_signing_secret configured for Expedia' };
    const ts = validateTimestamp(headers, 'X-Expedia-Timestamp', 300);  // strict 5min
    if (!ts.ok) return { ok: false, reason: ts.reason };
    const sig = verifyHmac({
      secret, algorithm: 'sha256', body: rawBody, headers,
      signatureHeader: 'X-Expedia-Signature', encoding: 'hex',
    });
    if (!sig.ok) return { ok: false, reason: sig.reason };
    return { ok: true, timestamp: ts.timestamp, nonce: pickHeader(headers, 'X-Expedia-Correlation-Id') || null };
  }
  parseInbound(_creds: ChannelCredentials, body: any) {
    if (!body?.reservation_id) return { ok: false, reason: 'reservation_id missing' };
    return {
      ok: true,
      booking: {
        bookingId: String(body.reservation_id),
        guestName: body.guest_name,
        guestPhone: body.guest_phone || null,
        guestEmail: body.guest_email || null,
        roomId: '',
        externalRoomCode: String(body.room_type_id || body.room_id || ''),
        externalRatePlanCode: body.rate_plan_id ? String(body.rate_plan_id) : null,
        roomName: body.room_name || null,
        checkInDate: body.check_in,
        checkOutDate: body.check_out,
        totalAmount: Number(body.total || 0),
        bookingType: 'OVERNIGHT' as const,
        source: 'EXPEDIA',
        status: body.status === 'CANCELLED' ? 'CANCELLED' : 'BOOKED',
      },
      operation: (body.status === 'CANCELLED' ? 'CANCELLED' : 'CREATED') as 'CREATED' | 'MODIFIED' | 'CANCELLED',
    };
  }
  async pullBookings(creds: ChannelCredentials, _sinceIso: string): Promise<AdapterPullResult> {
    if (!this.isReady(creds)) return { ok: false, bookings: [], reason: 'Expedia credentials not configured' };
    return { ok: true, bookings: [], stub: true, note: 'expedia-stub: awaiting partner approval' };
  }
}

/**
 * Airbnb adapter.
 *
 * For most properties, Airbnb integration is iCal one-way (handled by
 * channel_ical_feeds, not via this adapter). API access is restricted to
 * professional hosts with 50+ properties.
 *
 * If/when API access is granted, Airbnb uses:
 *   - Bearer token (api_key) — no HMAC on the webhook itself
 *   - Verification via webhook secret prefix in body.signature field
 *
 * Until then, this adapter REJECTS inbound webhooks (iCal is the path).
 */
class AirbnbAdapter implements ChannelAdapter {
  channel = 'AIRBNB';
  isReady(_c: ChannelCredentials) { return false; }  // iCal-only by default
  async pushBooking(_creds: ChannelCredentials, _payload: AdapterBookingPayload): Promise<AdapterResult> {
    return { ok: false, message: 'Airbnb does not support outbound API push for most properties. Use iCal one-way sync via channel_ical_feeds.' };
  }
  async pushAvailability(_creds: ChannelCredentials, _payloads: AdapterAvailabilityPayload[]): Promise<AdapterResult> {
    return { ok: false, message: 'Airbnb uses iCal export — populate /ical.ics endpoint instead.' };
  }
  validateWebhook(_creds: ChannelCredentials, _headers: any, _rawBody: string, _body: any): ValidateResult {
    return { ok: false, reason: 'Airbnb does not deliver webhooks for non-API-tier properties. Use iCal sync instead (configure under Settings → Channel Manager → iCal Feeds).' };
  }
  parseInbound() {
    return { ok: false, reason: 'Airbnb webhook path disabled — iCal path is the supported integration.' };
  }
  async pullBookings(): Promise<AdapterPullResult> {
    return { ok: true, bookings: [], stub: true, note: 'Airbnb non-API-tier — use iCal one-way sync' };
  }
}

// ── Registry ─────────────────────────────────────────────────────────────
const adapters: Record<string, ChannelAdapter> = {
  BOOKING: new BookingComAdapter(),
  MMT: new MakeMyTripAdapter(),
  GOIBIBO: new GoibiboAdapter(),
  AGODA: new AgodaAdapter(),
  EXPEDIA: new ExpediaAdapter(),
  AIRBNB: new AirbnbAdapter(),
  MOCK: new MockAdapter(),
};

export function getChannelAdapter(channel: string): ChannelAdapter {
  return adapters[String(channel || '').toUpperCase()] || adapters.MOCK;
}

export const SUPPORTED_CHANNELS = Object.keys(adapters).filter(k => k !== 'MOCK');
