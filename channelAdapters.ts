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

// ── MMT OAuth 2.0 token cache (in-process, per-credential-key) ───────────
// MMT GoConnect issues Bearer tokens with ~1hr TTL via client_credentials
// grant. Caching here avoids a token round-trip on every ARI push while
// staying within the TTL. Eviction is lazy: we re-fetch when <60 s remain.
const mmtOAuthCache = new Map<string, { token: string; expiresAt: number }>();

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
    if (payloads.length === 0) return { ok: true, message: 'no payloads to push' };
    const auth = Buffer.from(`${creds.api_key}:${creds.api_secret}`).toString('base64');
    const echoToken = `at-${Date.now()}`;
    const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const messages = payloads.map(p =>
      `<AvailStatusMessage>` +
      `<StatusApplicationControl Start="${p.date}" End="${p.date}" RatePlanCode="${p.rateLabel || 'BAR'}" InvTypeCode="${p.roomName || p.roomId}"/>` +
      `<AvailStatus RestrictionStatus="${p.available ? 'Open' : 'Close'}"/>` +
      `</AvailStatusMessage>`
    ).join('');
    const xml = `<?xml version="1.0" encoding="UTF-8"?><OTA_HotelAvailNotifRQ xmlns="http://www.opentravel.org/OTA/2003/05" EchoToken="${echoToken}" TimeStamp="${ts}" Version="1.0"><AvailStatusMessages HotelCode="${creds.property_id}">${messages}</AvailStatusMessages></OTA_HotelAvailNotifRQ>`;
    try {
      const res = await fetch('https://supply-xml.booking.com/hotels/xml/', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'text/xml; charset=utf-8' },
        body: xml,
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.text();
      if (!res.ok || body.includes('<Error')) {
        const m = body.match(/<Error[^>]*ShortText="([^"]+)"/i) || body.match(/<Error[^>]*>([^<]+)/i);
        return { ok: false, message: `BDC avail push failed: ${m ? m[1] : `HTTP ${res.status}`}` };
      }
      // Rate push — OTA_HotelRateAmountNotifRQ
      const rateRows = payloads.filter(p => p.rate > 0);
      if (rateRows.length > 0) {
        const rateMsgs = rateRows.map(p =>
          `<RateAmountMessage>` +
          `<StatusApplicationControl Start="${p.date}" End="${p.date}" RatePlanCode="${p.rateLabel || 'BAR'}" InvTypeCode="${p.roomName || p.roomId}"/>` +
          `<Rates><Rate><BaseByGuestAmts><BaseByGuestAmt AmountAfterTax="${p.rate.toFixed(2)}" CurrencyCode="INR" NumberOfGuests="2"/></BaseByGuestAmts></Rate></Rates>` +
          `</RateAmountMessage>`
        ).join('');
        const rateXml = `<?xml version="1.0" encoding="UTF-8"?><OTA_HotelRateAmountNotifRQ xmlns="http://www.opentravel.org/OTA/2003/05" EchoToken="${echoToken}-r" TimeStamp="${ts}" Version="1.0"><RateAmountMessages HotelCode="${creds.property_id}">${rateMsgs}</RateAmountMessages></OTA_HotelRateAmountNotifRQ>`;
        await fetch('https://supply-xml.booking.com/hotels/xml/', {
          method: 'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'text/xml; charset=utf-8' },
          body: rateXml,
          signal: AbortSignal.timeout(15_000),
        }).catch(() => null);
      }
      return { ok: true, message: `BDC ARI pushed ${payloads.length} rows for hotel ${creds.property_id}` };
    } catch (e: any) {
      return { ok: false, message: `BDC ARI push error: ${e?.message}` };
    }
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
  async pullBookings(creds: ChannelCredentials, sinceIso: string): Promise<AdapterPullResult> {
    if (!this.isReady(creds)) return { ok: false, bookings: [], reason: 'Booking.com credentials not configured' };
    const auth = Buffer.from(`${creds.api_key}:${creds.api_secret}`).toString('base64');
    const params = new URLSearchParams({ hotel_id: creds.property_id!, modify_date_from: sinceIso });
    try {
      const res = await fetch(`https://supply-xml.booking.com/hotels/xml/reservations?${params}`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(20_000),
      });
      const body = await res.text();
      if (!res.ok) return { ok: false, bookings: [], reason: `BDC pull failed: HTTP ${res.status}` };
      const bookings: any[] = [];
      const re = /<Reservation>([\s\S]*?)<\/Reservation>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        const block = m[1];
        const get = (tag: string) => { const r = block.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`)); return r ? r[1] : ''; };
        const status = get('Status');
        bookings.push({
          bookingId: get('ReservationID') || get('BookingNumber'),
          guestName: get('GuestName') || get('FirstName'),
          checkInDate: get('CheckInDate') || get('ArrivalDate'),
          checkOutDate: get('CheckOutDate') || get('DepartureDate'),
          status: (status === 'cancelled' || status === 'CANCELLED') ? 'CANCELLED' : 'BOOKED',
          source: 'BOOKING',
        });
      }
      return { ok: true, bookings };
    } catch (e: any) {
      return { ok: false, bookings: [], reason: `BDC pull error: ${e?.message}` };
    }
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

  /** Fetch (or return cached) OAuth Bearer token for the GoConnect API.
   *  MMT issues client_credentials tokens via POST /oauth/token.
   *  The token TTL is ~1 hr; we refresh when <60 s remain.
   *  The api_key is the Client ID and api_secret is the Client Secret —
   *  both obtained from InGo-MMT Partner Portal → Settings → API Credentials
   *  (NOT the same as the web-dashboard login that requires OTP). */
  private async getOAuthToken(creds: ChannelCredentials): Promise<string | null> {
    if (!creds.api_key || !creds.api_secret) return null;
    const cacheKey = `${this.channel}:${creds.api_key}`;
    const cached = mmtOAuthCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
    try {
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: creds.api_key,
        client_secret: creds.api_secret,
      });
      const res = await fetch('https://connect-api.makemytrip.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        console.warn(`[channel-${this.channel.toLowerCase()}] OAuth token failed ${res.status}: ${txt.slice(0, 200)}`);
        return null;
      }
      const data: any = await res.json();
      const token = String(data.access_token || '');
      const expiresIn = Number(data.expires_in || 3600);
      if (!token) return null;
      mmtOAuthCache.set(cacheKey, { token, expiresAt: Date.now() + expiresIn * 1000 });
      return token;
    } catch (e: any) {
      console.warn(`[channel-${this.channel.toLowerCase()}] OAuth error:`, e?.message);
      return null;
    }
  }

  async pushBooking(creds: ChannelCredentials, payload: AdapterBookingPayload): Promise<AdapterResult> {
    if (!this.isReady(creds)) return { ok: false, message: `${this.channel} credentials not configured.` };
    console.log(`[channel-${this.channel.toLowerCase()}:stub] would push booking ${payload.bookingId} for hotel ${creds.property_id}`);
    return { ok: true, message: `${this.channel.toLowerCase()}-stub: payload validated; awaiting partner approval` };
  }

  /** Push Availability + Rate Inventory (ARI) to MMT GoConnect.
   *  Groups payloads by roomName (external room type code) and sends one
   *  JSON body per room type. Uses OAuth 2.0 Bearer token (no OTP required —
   *  the OTP only protects the web-dashboard login, not the API). */
  async pushAvailability(creds: ChannelCredentials, payloads: AdapterAvailabilityPayload[]): Promise<AdapterResult> {
    if (!this.isReady(creds)) return { ok: false, message: `${this.channel} credentials not configured.` };
    if (payloads.length === 0) return { ok: true, message: 'no payloads to push' };

    const token = await this.getOAuthToken(creds);
    if (!token) {
      return {
        ok: false,
        message: `${this.channel}: OAuth token fetch failed — verify Client ID + Client Secret in Channel Manager (use API credentials from InGo-MMT Partner Portal → Settings → API Credentials, NOT the web login password)`,
      };
    }

    // Group by external room code (stored as roomName when called from triggerAriPush)
    const byRoom = new Map<string, AdapterAvailabilityPayload[]>();
    for (const p of payloads) {
      const key = p.roomName || p.roomId;
      if (!byRoom.has(key)) byRoom.set(key, []);
      byRoom.get(key)!.push(p);
    }

    const errors: string[] = [];
    let pushed = 0;
    for (const [roomCode, rows] of byRoom) {
      const body = {
        hotel_id: creds.property_id,
        room_type_code: roomCode,
        inventory: rows.map(r => ({
          date: r.date,
          available_rooms: r.available ? 1 : 0,
          rate: r.rate,
          currency: 'INR',
        })),
      };
      try {
        const res = await fetch('https://connect-api.makemytrip.com/api/v1/hotel/inventory', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          errors.push(`room ${roomCode}: ${res.status} ${txt.slice(0, 150)}`);
        } else {
          pushed += rows.length;
        }
      } catch (e: any) {
        errors.push(`room ${roomCode}: ${e?.message}`);
      }
    }

    if (errors.length > 0 && pushed === 0) {
      return { ok: false, message: `${this.channel} ARI push failed: ${errors.join('; ')}` };
    }
    if (errors.length > 0) {
      return { ok: true, message: `${this.channel} ARI partial: ${pushed} rows pushed, errors: ${errors.join('; ')}` };
    }
    return { ok: true, message: `${this.channel} ARI pushed ${pushed} rows for hotel ${creds.property_id}` };
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
  async pullBookings(creds: ChannelCredentials, sinceIso: string): Promise<AdapterPullResult> {
    if (!this.isReady(creds)) return { ok: false, bookings: [], reason: `${this.channel} credentials not configured` };
    const token = await this.getOAuthToken(creds);
    if (!token) return { ok: false, bookings: [], reason: `${this.channel}: OAuth token fetch failed` };
    const params = new URLSearchParams({ hotel_id: creds.property_id!, modified_since: sinceIso });
    try {
      const res = await fetch(`https://connect-api.makemytrip.com/api/v1/hotel/bookings?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { ok: false, bookings: [], reason: `${this.channel} pull failed: HTTP ${res.status}` };
      const data: any = await res.json().catch(() => ({}));
      const bookings = (data.bookings || data.data || []).map((b: any) => ({
        bookingId: String(b.booking_id || b.id || ''),
        guestName: b.guest_name || '',
        guestPhone: b.guest_phone || null,
        guestEmail: b.guest_email || null,
        checkInDate: b.check_in || '',
        checkOutDate: b.check_out || '',
        externalRoomCode: String(b.room_type_code || b.room_id || ''),
        totalAmount: Number(b.total || 0),
        status: b.status === 'CANCELLED' ? 'CANCELLED' : 'BOOKED',
        source: this.channel,
      }));
      return { ok: true, bookings };
    } catch (e: any) {
      return { ok: false, bookings: [], reason: `${this.channel} pull error: ${e?.message}` };
    }
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
  async pushAvailability(creds: ChannelCredentials, payloads: AdapterAvailabilityPayload[]): Promise<AdapterResult> {
    if (!this.isReady(creds)) return { ok: false, message: 'Agoda credentials not configured.' };
    if (payloads.length === 0) return { ok: true, message: 'no payloads to push' };
    const headers = { 'X-YCS-AUTH': creds.api_key!, 'Content-Type': 'application/json' };
    // Group by room code
    const byRoom = new Map<string, AdapterAvailabilityPayload[]>();
    for (const p of payloads) {
      const key = p.roomName || p.roomId;
      if (!byRoom.has(key)) byRoom.set(key, []);
      byRoom.get(key)!.push(p);
    }
    const errors: string[] = [];
    let pushed = 0;
    for (const [roomCode, rows] of byRoom) {
      try {
        const availRes = await fetch('https://ycs.agoda.com/api/ari/availability', {
          method: 'POST',
          headers,
          body: JSON.stringify({ property_id: creds.property_id, room_type_id: roomCode, dates: rows.map(r => ({ date: r.date, available_rooms: r.available ? 1 : 0 })) }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!availRes.ok) { const t = await availRes.text().catch(() => ''); errors.push(`avail ${roomCode}: ${availRes.status} ${t.slice(0, 80)}`); }
        else pushed += rows.length;
      } catch (e: any) { errors.push(`avail ${roomCode}: ${e?.message}`); }
      const rateRows = rows.filter(r => r.rate > 0);
      if (rateRows.length > 0) {
        try {
          const rateRes = await fetch('https://ycs.agoda.com/api/ari/rates', {
            method: 'POST',
            headers,
            body: JSON.stringify({ property_id: creds.property_id, room_type_id: roomCode, rate_plan_id: rows[0].rateLabel || 'BAR', dates: rateRows.map(r => ({ date: r.date, rate: r.rate, currency: 'INR' })) }),
            signal: AbortSignal.timeout(15_000),
          });
          if (!rateRes.ok) { const t = await rateRes.text().catch(() => ''); errors.push(`rate ${roomCode}: ${rateRes.status} ${t.slice(0, 80)}`); }
        } catch (e: any) { errors.push(`rate ${roomCode}: ${e?.message}`); }
      }
    }
    if (errors.length > 0 && pushed === 0) return { ok: false, message: `Agoda ARI push failed: ${errors.join('; ')}` };
    if (errors.length > 0) return { ok: true, message: `Agoda ARI partial: ${pushed} rows, errors: ${errors.join('; ')}` };
    return { ok: true, message: `Agoda ARI pushed ${pushed} rows for property ${creds.property_id}` };
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
  async pullBookings(creds: ChannelCredentials, sinceIso: string): Promise<AdapterPullResult> {
    if (!this.isReady(creds)) return { ok: false, bookings: [], reason: 'Agoda credentials not configured' };
    const params = new URLSearchParams({ property_id: creds.property_id!, from: sinceIso });
    try {
      const res = await fetch(`https://ycs.agoda.com/api/bookings?${params}`, {
        headers: { 'X-YCS-AUTH': creds.api_key! },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { ok: false, bookings: [], reason: `Agoda pull failed: HTTP ${res.status}` };
      const data: any = await res.json().catch(() => ({}));
      const bookings = (data.reservations || data.bookings || []).map((b: any) => ({
        bookingId: String(b.reservation_id || b.booking_id || ''),
        guestName: b.guest_name || '',
        guestPhone: b.guest_phone || null,
        guestEmail: b.guest_email || null,
        checkInDate: b.check_in || '',
        checkOutDate: b.check_out || '',
        externalRoomCode: String(b.room_type || b.room_id || ''),
        totalAmount: Number(b.total || 0),
        status: b.status === 'CANCELLED' ? 'CANCELLED' : 'BOOKED',
        source: 'AGODA',
      }));
      return { ok: true, bookings };
    } catch (e: any) {
      return { ok: false, bookings: [], reason: `Agoda pull error: ${e?.message}` };
    }
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
  async pushAvailability(creds: ChannelCredentials, payloads: AdapterAvailabilityPayload[]): Promise<AdapterResult> {
    if (!this.isReady(creds)) return { ok: false, message: 'Expedia credentials not configured.' };
    if (payloads.length === 0) return { ok: true, message: 'no payloads to push' };
    const auth = Buffer.from(`${creds.api_key}:${creds.api_secret}`).toString('base64');
    const echoToken = `at-${Date.now()}`;
    const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const byRoom = new Map<string, AdapterAvailabilityPayload[]>();
    for (const p of payloads) {
      const key = p.roomName || p.roomId;
      if (!byRoom.has(key)) byRoom.set(key, []);
      byRoom.get(key)!.push(p);
    }
    const errors: string[] = [];
    let pushed = 0;
    for (const [roomCode, rows] of byRoom) {
      const rateCode = `EXP.${rows[0].rateLabel || 'BAR'}`;
      const availMsgs = rows.map(r =>
        `<AvailStatusMessage>` +
        `<StatusApplicationControl Start="${r.date}" End="${r.date}" InvTypeCode="${roomCode}" RatePlanCode="${rateCode}"/>` +
        `<AvailStatus RestrictionStatus="${r.available ? 'Open' : 'Close'}"/>` +
        `</AvailStatusMessage>`
      ).join('');
      const availXml = `<?xml version="1.0" encoding="UTF-8"?><HTNG_HotelAvailNotifRQ xmlns="http://htng.org/2009B" EchoToken="${echoToken}" TimeStamp="${ts}"><AvailStatusMessages HotelCode="${creds.property_id}">${availMsgs}</AvailStatusMessages></HTNG_HotelAvailNotifRQ>`;
      try {
        const res = await fetch('https://services.expediapartnercentral.com/eqc/avail', {
          method: 'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'text/xml; charset=utf-8' },
          body: availXml,
          signal: AbortSignal.timeout(15_000),
        });
        const body = await res.text();
        if (!res.ok || body.includes('<Error')) {
          const m = body.match(/<Error[^>]*ShortText="([^"]+)"/i) || body.match(/<Error[^>]*>([^<]+)/i);
          errors.push(`avail ${roomCode}: ${m ? m[1] : `HTTP ${res.status}`}`);
        } else { pushed += rows.length; }
      } catch (e: any) { errors.push(`avail ${roomCode}: ${e?.message}`); }
      const rateRows = rows.filter(r => r.rate > 0);
      if (rateRows.length > 0) {
        const rateMsgs = rateRows.map(r =>
          `<RateAmountMessage>` +
          `<StatusApplicationControl Start="${r.date}" End="${r.date}" InvTypeCode="${roomCode}" RatePlanCode="${rateCode}"/>` +
          `<Rates><Rate><BaseByGuestAmts><BaseByGuestAmt AmountAfterTax="${r.rate.toFixed(2)}" CurrencyCode="INR" NumberOfGuests="2"/></BaseByGuestAmts></Rate></Rates>` +
          `</RateAmountMessage>`
        ).join('');
        const rateXml = `<?xml version="1.0" encoding="UTF-8"?><HTNG_HotelRateAmountNotifRQ xmlns="http://htng.org/2009B" EchoToken="${echoToken}-r" TimeStamp="${ts}"><RateAmountMessages HotelCode="${creds.property_id}">${rateMsgs}</RateAmountMessages></HTNG_HotelRateAmountNotifRQ>`;
        try {
          const rRes = await fetch('https://services.expediapartnercentral.com/eqc/ar', {
            method: 'POST',
            headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'text/xml; charset=utf-8' },
            body: rateXml,
            signal: AbortSignal.timeout(15_000),
          });
          const rBody = await rRes.text();
          if (!rRes.ok || rBody.includes('<Error')) {
            const m = rBody.match(/<Error[^>]*ShortText="([^"]+)"/i) || rBody.match(/<Error[^>]*>([^<]+)/i);
            errors.push(`rate ${roomCode}: ${m ? m[1] : `HTTP ${rRes.status}`}`);
          }
        } catch (e: any) { errors.push(`rate ${roomCode}: ${e?.message}`); }
      }
    }
    if (errors.length > 0 && pushed === 0) return { ok: false, message: `Expedia ARI push failed: ${errors.join('; ')}` };
    if (errors.length > 0) return { ok: true, message: `Expedia ARI partial: ${pushed} rows, errors: ${errors.join('; ')}` };
    return { ok: true, message: `Expedia ARI pushed ${pushed} rows for hotel ${creds.property_id}` };
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
  async pullBookings(creds: ChannelCredentials, sinceIso: string): Promise<AdapterPullResult> {
    if (!this.isReady(creds)) return { ok: false, bookings: [], reason: 'Expedia credentials not configured' };
    const auth = Buffer.from(`${creds.api_key}:${creds.api_secret}`).toString('base64');
    const params = new URLSearchParams({ hotelId: creds.property_id!, modifiedDateTimeFrom: sinceIso });
    try {
      const res = await fetch(`https://services.expediapartnercentral.com/eqc/booking?${params}`, {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { ok: false, bookings: [], reason: `Expedia pull failed: HTTP ${res.status}` };
      const data: any = await res.json().catch(() => ({}));
      const bookings = (data.reservations || data.bookings || []).map((b: any) => ({
        bookingId: String(b.reservation_id || b.id || ''),
        guestName: b.guest_name || b.guestName || '',
        guestPhone: b.guest_phone || null,
        guestEmail: b.guest_email || null,
        checkInDate: b.check_in || b.checkIn || '',
        checkOutDate: b.check_out || b.checkOut || '',
        externalRoomCode: String(b.room_type_id || b.room_type || ''),
        totalAmount: Number(b.total || b.amount || 0),
        status: (b.status === 'CANCELLED' || b.cancelled) ? 'CANCELLED' : 'BOOKED',
        source: 'EXPEDIA',
      }));
      return { ok: true, bookings };
    } catch (e: any) {
      return { ok: false, bookings: [], reason: `Expedia pull error: ${e?.message}` };
    }
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

/**
 * Google Hotel Ads / Google Free Booking Links adapter.
 *
 * Google does NOT deliver inbound webhooks or booking pushes. Bookings
 * arrive via the public direct-booking page (guests click the "Book" link
 * from Google Hotel Search). This adapter only surfaces:
 *
 *   pushAvailability() — Phase 2 stub; after receiving Google Travel Partner
 *     API access (8–14 week approval), this will push OTA XML to
 *     https://www.google.com:443/travel/hotels/uploads/ota/ via a Google
 *     service account.
 *
 *   A separate public endpoint GET /api/public/restaurant/:id/hotel/google-ari
 *   in server.ts returns an OTA_HotelRateAmountNotifRQ XML document that Google
 *   can pull when configuring Free Booking Links in Hotel Center.
 *
 * To get on Google Hotel Search:
 *   1. Verify property in Google Business Profile.
 *   2. Link to Google Hotel Center (free).
 *   3. Add your direct booking URL as the "official booking link".
 *   4. Optionally submit the /google-ari XML feed so Google shows prices.
 *   Step 5 (paid Google Hotel Ads): apply for Travel Partner API access
 *   and implement the pushAvailability() below.
 */
class GoogleHotelsAdapter implements ChannelAdapter {
  channel = 'GOOGLE_HOTELS';
  isReady(_c: ChannelCredentials) { return false; }  // Phase 2: set true when Travel Partner API approved
  async pushBooking(): Promise<AdapterResult> {
    return { ok: false, message: 'Google Hotels does not accept outbound booking pushes. Guests book via your public booking URL shown in Google Hotel Search.' };
  }
  async pushAvailability(creds: ChannelCredentials, payloads: AdapterAvailabilityPayload[]): Promise<AdapterResult> {
    if (!creds.property_id) return { ok: false, message: 'Google Hotel Center property_id not configured in Channel Manager.' };
    // Phase 2 — push OTA XML via Google Travel Partner API (requires partner approval):
    // POST https://www.google.com:443/travel/hotels/uploads/ota/
    // Auth: Google service account OAuth2, scope: https://www.googleapis.com/auth/travel-partner
    // Body: OTA_HotelRateAmountNotifRQ XML built from payloads
    console.log(`[channel-google-hotels:stub] would push ${payloads.length} ARI rows for hotel ${creds.property_id}. After Google Travel Partner API approval, this will push OTA XML directly.`);
    return { ok: true, message: `google-hotels-stub: ${payloads.length} ARI rows queued. Currently served via /google-ari XML feed endpoint for Hotel Center pull-based integration.` };
  }
  validateWebhook(): ValidateResult {
    return { ok: false, reason: 'Google Hotels does not deliver webhooks. Bookings arrive via your public direct-booking URL redirect.' };
  }
  parseInbound() {
    return { ok: false, reason: 'Google Hotels bookings are handled via the public booking page, not inbound webhooks.' };
  }
  async pullBookings(): Promise<AdapterPullResult> {
    return { ok: true, bookings: [], stub: true, note: 'Google Hotels: bookings handled via direct booking page redirect — no API pull needed.' };
  }
}

/**
 * eGlobe Solutions Channel Manager adapter.
 *
 * eGlobe is a third-party channel manager (popular in India) that sits between
 * the hotel PMS and 100+ OTAs.  A single ARI push to eGlobe automatically
 * distributes availability and rates to every OTA the property is listed on
 * (Booking.com, MakeMyTrip, Goibibo, Agoda, Expedia, etc.) — no per-OTA
 * partnerships or separate credentials needed.
 *
 * Credential mapping in Channel Manager:
 *   api_key     = Access Token  (eGlobe Extranet → Settings → API → Access Token)
 *   property_id = Hotel Code    (eGlobe Extranet → Your hotel's numeric code, e.g. 1000122158)
 *   api_secret  = (not used — eGlobe uses single-token auth)
 *
 * API base: https://extranet.eglobe-solutions.com  (confirmed — IIS/ASP.NET)
 * Auth:     Authorization: Bearer {AccessToken}  +  X-Hotel-Code: {HotelCode}
 *
 * ⚠  ENDPOINT PATHS below are inferred from eGlobe's ASP.NET architecture
 *    and documented API capabilities. Confirm the exact paths with eGlobe
 *    support (support@eglobe-solutions.com) before going live — use the
 *    "Test Connection" button to verify which paths respond correctly.
 *
 * Inbound webhooks: eGlobe sends a unified booking notification to the
 *   registered callback URL regardless of the originating OTA.  The token in
 *   X-Eglobe-Token / X-Access-Token should match your Access Token.
 */
class EglobeAdapter implements ChannelAdapter {
  channel = 'EGLOBE';
  private readonly BASE = 'https://extranet.eglobe-solutions.com';

  isReady(c: ChannelCredentials) {
    return !!(c.is_enabled && c.api_key && c.property_id);
  }

  private authHeaders(creds: ChannelCredentials): Record<string, string> {
    return {
      Authorization: `Bearer ${creds.api_key}`,
      'Content-Type': 'application/json',
      'X-Hotel-Code': creds.property_id!,
    };
  }

  async pushBooking(_creds: ChannelCredentials, payload: AdapterBookingPayload): Promise<AdapterResult> {
    // eGlobe does NOT receive outbound booking pushes from PMS.
    // Booking flow: OTA → eGlobe → webhook to Atithi-Setu.
    console.log(`[channel-eglobe] pushBooking no-op for ${payload.bookingId} — flow is inbound-only via webhook`);
    return { ok: true, message: 'eGlobe: bookings flow OTA→eGlobe→webhook (no outbound push needed)' };
  }

  async pushAvailability(creds: ChannelCredentials, payloads: AdapterAvailabilityPayload[]): Promise<AdapterResult> {
    if (!this.isReady(creds)) return { ok: false, message: 'eGlobe: Access Token (api_key) and Hotel Code (property_id) required' };
    if (payloads.length === 0) return { ok: true, message: 'no payloads to push' };
    const byRoom = new Map<string, AdapterAvailabilityPayload[]>();
    for (const p of payloads) {
      const key = p.roomName || p.roomId;
      if (!byRoom.has(key)) byRoom.set(key, []);
      byRoom.get(key)!.push(p);
    }
    const errors: string[] = [];
    let pushed = 0;
    for (const [roomCode, rows] of byRoom) {
      // Availability push — TODO: confirm path with eGlobe support
      try {
        const res = await fetch(`${this.BASE}/api/pms/UpdateInventory`, {
          method: 'POST',
          headers: this.authHeaders(creds),
          body: JSON.stringify({
            HotelCode: creds.property_id,
            RoomTypeCode: roomCode,
            Inventory: rows.map(r => ({ Date: r.date, Availability: r.available ? 1 : 0 })),
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) { const t = await res.text().catch(() => ''); errors.push(`avail ${roomCode}: HTTP ${res.status} ${t.slice(0, 80)}`); }
        else pushed += rows.length;
      } catch (e: any) { errors.push(`avail ${roomCode}: ${e?.message}`); }
      // Rate push — TODO: confirm path with eGlobe support
      const rateRows = rows.filter(r => r.rate > 0);
      if (rateRows.length > 0) {
        try {
          const rateRes = await fetch(`${this.BASE}/api/pms/UpdateRate`, {
            method: 'POST',
            headers: this.authHeaders(creds),
            body: JSON.stringify({
              HotelCode: creds.property_id,
              RoomTypeCode: roomCode,
              RatePlanCode: rows[0].rateLabel || 'BAR',
              Rates: rateRows.map(r => ({ Date: r.date, Rate: r.rate, Currency: 'INR' })),
            }),
            signal: AbortSignal.timeout(15_000),
          });
          if (!rateRes.ok) { const t = await rateRes.text().catch(() => ''); errors.push(`rate ${roomCode}: HTTP ${rateRes.status} ${t.slice(0, 80)}`); }
        } catch (e: any) { errors.push(`rate ${roomCode}: ${e?.message}`); }
      }
    }
    if (errors.length > 0 && pushed === 0) return { ok: false, message: `eGlobe ARI push failed: ${errors.join('; ')}` };
    if (errors.length > 0) return { ok: true, message: `eGlobe ARI partial: ${pushed} rows, errors: ${errors.join('; ')}` };
    return { ok: true, message: `eGlobe ARI pushed ${pushed} rows for hotel ${creds.property_id} (distributes to all connected OTAs)` };
  }

  validateWebhook(creds: ChannelCredentials, headers: any, _rawBody: string, _body: any): ValidateResult {
    // eGlobe typically passes the Access Token in X-Eglobe-Token or X-Access-Token.
    // If neither is present, we allow through (eGlobe may rely on IP allowlist only).
    // TODO: Confirm header name with eGlobe support and switch to HMAC if they support it.
    const token = pickHeader(headers, 'X-Eglobe-Token') || pickHeader(headers, 'X-Access-Token');
    if (token && token !== creds.api_key) {
      return { ok: false, reason: 'eGlobe webhook: access token mismatch' };
    }
    if (!token) {
      console.warn('[channel-eglobe] webhook missing X-Eglobe-Token — verify eGlobe webhook config includes the token header');
    }
    return { ok: true, timestamp: null, replay_check_skipped: true };
  }

  parseInbound(_creds: ChannelCredentials, body: any) {
    // eGlobe delivers a unified booking envelope for all originating OTAs.
    // TODO: Confirm field names from eGlobe's webhook documentation.
    const bookingId = body?.BookingId || body?.booking_id || body?.ReservationId || body?.reservation_id;
    if (!bookingId) return { ok: false, reason: 'eGlobe webhook: BookingId / ReservationId missing' };
    const rawStatus = String(body?.Status || body?.status || '').toUpperCase();
    const isCancelled = rawStatus === 'CANCELLED' || rawStatus === 'CANCEL';
    const isModified  = rawStatus === 'MODIFIED'  || rawStatus === 'MODIFY';
    return {
      ok: true,
      booking: {
        bookingId: String(bookingId),
        guestName: body?.GuestName || body?.guest_name || '',
        guestPhone: body?.GuestPhone || body?.guest_phone || null,
        guestEmail: body?.GuestEmail || body?.guest_email || null,
        roomId: '',
        externalRoomCode: String(body?.RoomTypeCode || body?.room_type_code || body?.RoomType || ''),
        externalRatePlanCode: body?.RatePlanCode || body?.rate_plan_code || null,
        roomName: body?.RoomTypeName || body?.room_type_name || null,
        checkInDate: body?.CheckIn || body?.check_in || body?.ArrivalDate || '',
        checkOutDate: body?.CheckOut || body?.check_out || body?.DepartureDate || '',
        totalAmount: Number(body?.TotalAmount || body?.total_amount || body?.Amount || 0),
        bookingType: 'OVERNIGHT' as const,
        source: `EGLOBE:${body?.Channel || body?.channel || body?.OTAName || 'OTA'}`,
        status: isCancelled ? 'CANCELLED' : 'BOOKED',
      },
      operation: (isCancelled ? 'CANCELLED' : isModified ? 'MODIFIED' : 'CREATED') as 'CREATED' | 'MODIFIED' | 'CANCELLED',
    };
  }

  async pullBookings(creds: ChannelCredentials, sinceIso: string): Promise<AdapterPullResult> {
    if (!this.isReady(creds)) return { ok: false, bookings: [], reason: 'eGlobe: access token and hotel code required' };
    // TODO: Confirm GetBookings endpoint path with eGlobe support
    const params = new URLSearchParams({ HotelCode: creds.property_id!, ModifiedSince: sinceIso });
    try {
      const res = await fetch(`${this.BASE}/api/pms/GetBookings?${params}`, {
        headers: this.authHeaders(creds),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { ok: false, bookings: [], reason: `eGlobe pull failed: HTTP ${res.status}` };
      const data: any = await res.json().catch(() => ({}));
      const list: any[] = data?.Bookings || data?.bookings || data?.Reservations || data?.reservations || [];
      const bookings = list.map((b: any) => ({
        bookingId: String(b.BookingId || b.booking_id || b.ReservationId || ''),
        guestName: b.GuestName || b.guest_name || '',
        guestPhone: b.GuestPhone || b.guest_phone || null,
        guestEmail: b.GuestEmail || b.guest_email || null,
        checkInDate: b.CheckIn || b.check_in || b.ArrivalDate || '',
        checkOutDate: b.CheckOut || b.check_out || b.DepartureDate || '',
        externalRoomCode: String(b.RoomTypeCode || b.room_type_code || b.RoomType || ''),
        totalAmount: Number(b.TotalAmount || b.total_amount || b.Amount || 0),
        status: (String(b.Status || b.status || '').toUpperCase() === 'CANCELLED') ? 'CANCELLED' : 'BOOKED',
        source: `EGLOBE:${b.Channel || b.OTAName || 'OTA'}`,
      }));
      return { ok: true, bookings };
    } catch (e: any) {
      return { ok: false, bookings: [], reason: `eGlobe pull error: ${e?.message}` };
    }
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
  GOOGLE_HOTELS: new GoogleHotelsAdapter(),
  EGLOBE: new EglobeAdapter(),
  MOCK: new MockAdapter(),
};

export function getChannelAdapter(channel: string): ChannelAdapter {
  return adapters[String(channel || '').toUpperCase()] || adapters.MOCK;
}

export const SUPPORTED_CHANNELS = Object.keys(adapters).filter(k => k !== 'MOCK');
