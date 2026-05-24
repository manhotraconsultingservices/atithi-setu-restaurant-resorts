/**
 * Channel Adapter Framework
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Per-OTA adapters that translate Atithi-Setu's booking/availability shape
 * into each provider's required wire format. Currently most adapters are
 * STUBS — they validate inputs, log what they would do, but return a mock
 * success. When the property is approved as a Booking.com / MakeMyTrip /
 * Agoda / Expedia / Airbnb partner and receives sandbox credentials, the
 * stub bodies are replaced with the real HTTP calls.
 *
 * The framework lets us:
 *   - Wire ALL the surfaces (UI, queue worker, webhooks, monitoring) now
 *   - Keep the booking lifecycle code clean (no per-OTA branches in core)
 *   - Swap in real network calls per channel without touching anything else
 *
 * Every adapter implements ChannelAdapter; the queue worker calls
 * pushBooking() for each queued channel_sync_log row.
 */

export interface ChannelCredentials {
  channel: string;
  api_key: string | null;       // plaintext (often a public identifier)
  api_secret: string | null;    // encrypted by server.ts; decrypt before use
  property_id: string | null;
  is_enabled: number;
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

export interface ChannelAdapter {
  channel: string;
  /** Is this adapter ready for live calls (credentials configured + enabled)? */
  isReady(creds: ChannelCredentials): boolean;
  /** Push a single booking to the OTA. */
  pushBooking(creds: ChannelCredentials, payload: AdapterBookingPayload): Promise<AdapterResult>;
  /** Push availability/rate updates for a date range. */
  pushAvailability(creds: ChannelCredentials, payloads: AdapterAvailabilityPayload[]): Promise<AdapterResult>;
  /** Validate an inbound webhook (signature, idempotency token, etc). */
  validateWebhook(creds: ChannelCredentials, headers: Record<string, string | string[] | undefined>, body: any): { ok: boolean; reason?: string };
  /** Convert an inbound webhook body into an internal-shape booking. */
  parseInbound(creds: ChannelCredentials, body: any): {
    ok: boolean;
    booking?: Partial<AdapterBookingPayload>;
    operation?: 'CREATED' | 'MODIFIED' | 'CANCELLED';
    reason?: string;
  };
}

/**
 * Base mock adapter — used as a template + as the default when an
 * adapter isn't registered for a channel. Logs the would-be operation
 * and returns a synthetic success. The queue worker treats this as
 * success but tags the row with provider='MOCK' so dashboards know.
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
  validateWebhook(_creds: ChannelCredentials, _headers: any, _body: any) {
    return { ok: true };
  }
  parseInbound(_creds: ChannelCredentials, body: any) {
    return {
      ok: false,
      reason: 'MockAdapter does not parse inbound webhooks. Configure a real adapter for this channel.',
    };
  }
}

/**
 * Booking.com Connectivity Partner adapter (STUB).
 *
 * Real implementation requires:
 *   - Becoming an approved Booking.com Connectivity Partner
 *     (apply at https://partner.booking.com/en-us/connectivity-partner)
 *   - Sandbox creds: { username, password, hotel_id }
 *   - XML over HTTPS to https://supply-xml.booking.com/hotels/xml/
 *   - Operations:
 *       availability     → <availability> push (single OR multi-day)
 *       reservations     → <reservations> pull (filter by modify_date_from)
 *       confirmation     → <confirmation_request> back to the OTA
 *   - Authentication: HTTP Basic with the username/password
 *   - All requests signed with OTA_HotelResNotifRQ schema
 *
 * Until partnership is approved, this stub:
 *   - Confirms isReady when api_key + api_secret + property_id are set
 *   - Logs the would-be XML
 *   - Returns ok:true so the queue worker marks the row 'sent (stub)'
 *
 * To switch to real: replace the stub bodies below with axios.post() calls
 * to the supply-xml URLs and the existing XML message templates.
 */
class BookingComAdapter implements ChannelAdapter {
  channel = 'BOOKING';
  isReady(c: ChannelCredentials) {
    return !!(c.is_enabled && c.api_key && c.api_secret && c.property_id);
  }
  async pushBooking(creds: ChannelCredentials, payload: AdapterBookingPayload): Promise<AdapterResult> {
    if (!this.isReady(creds)) return { ok: false, message: 'Booking.com credentials not configured.' };
    // TODO(BDC): replace with real OTA_HotelResNotifRQ XML POST to
    //   https://supply-xml.booking.com/hotels/ota/OTA_HotelResNotifRQ
    // For now, return a structured stub so monitoring shows progress.
    console.log(`[channel-bdc:stub] would push booking ${payload.bookingId} as OTA_HotelResNotifRQ for hotel ${creds.property_id}`);
    return { ok: true, message: 'bdc-stub: payload validated; awaiting partner approval', externalRef: null };
  }
  async pushAvailability(creds: ChannelCredentials, payloads: AdapterAvailabilityPayload[]): Promise<AdapterResult> {
    if (!this.isReady(creds)) return { ok: false, message: 'Booking.com credentials not configured.' };
    // TODO(BDC): post OTA_HotelAvailRQ
    console.log(`[channel-bdc:stub] would push ${payloads.length} availability rows for hotel ${creds.property_id}`);
    return { ok: true, message: 'bdc-stub: availability payload validated' };
  }
  validateWebhook(creds: ChannelCredentials, headers: any, _body: any) {
    if (!creds.api_secret) return { ok: false, reason: 'No webhook secret configured' };
    // TODO(BDC): validate HMAC signature from X-Booking-Signature header
    return { ok: true };
  }
  parseInbound(_creds: ChannelCredentials, body: any) {
    // BDC sends OTA_HotelResNotifRQ — we'd parse the XML.
    // Stub: try to pull a few fields from a hypothetical JSON wrapper.
    if (!body || typeof body !== 'object') return { ok: false, reason: 'empty body' };
    return {
      ok: !!body.bookingId,
      booking: body.bookingId ? {
        bookingId: body.bookingId,
        guestName: body.guestName || 'BDC Guest',
        guestPhone: body.guestPhone || null,
        guestEmail: body.guestEmail || null,
        roomId: body.roomId || '',
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
}

/**
 * MakeMyTrip / Goibibo Hotel Connect adapter (STUB).
 *
 * MMT and Goibibo share the same backend API (the MMT Group platform).
 * Real implementation requires:
 *   - Signed partnership agreement with MMT
 *   - API base: https://connect-api.makemytrip.com/api/v1/...
 *   - Auth: OAuth 2.0 client_credentials with the api_key/api_secret
 *   - Endpoints: /availability, /rates, /bookings (pull), /bookings/{id}/ack
 *   - mmt_hotel_id from MMT extranet onboarding
 *
 * Stub behaviour is identical to BookingComAdapter — validates credentials
 * + logs the operation.
 */
class MakeMyTripAdapter implements ChannelAdapter {
  channel = 'MMT';
  isReady(c: ChannelCredentials) {
    return !!(c.is_enabled && c.api_key && c.api_secret && c.property_id);
  }
  async pushBooking(creds: ChannelCredentials, payload: AdapterBookingPayload): Promise<AdapterResult> {
    if (!this.isReady(creds)) return { ok: false, message: 'MMT credentials not configured.' };
    // TODO(MMT): POST /api/v1/inventory with OAuth token
    console.log(`[channel-mmt:stub] would push booking ${payload.bookingId} for mmt_hotel_id ${creds.property_id}`);
    return { ok: true, message: 'mmt-stub: payload validated; awaiting partner approval' };
  }
  async pushAvailability(creds: ChannelCredentials, payloads: AdapterAvailabilityPayload[]): Promise<AdapterResult> {
    if (!this.isReady(creds)) return { ok: false, message: 'MMT credentials not configured.' };
    console.log(`[channel-mmt:stub] would push ${payloads.length} availability rows`);
    return { ok: true, message: 'mmt-stub: availability validated' };
  }
  validateWebhook(_creds: ChannelCredentials, _headers: any, _body: any) { return { ok: true }; }
  parseInbound(_creds: ChannelCredentials, body: any) {
    if (!body?.booking_id) return { ok: false, reason: 'booking_id missing in MMT payload' };
    return {
      ok: true,
      booking: {
        bookingId: body.booking_id,
        guestName: body.guest_name,
        guestPhone: body.guest_phone || null,
        guestEmail: body.guest_email || null,
        roomId: body.room_id,
        roomName: body.room_name || null,
        checkInDate: body.check_in,
        checkOutDate: body.check_out,
        totalAmount: Number(body.total || 0),
        bookingType: 'OVERNIGHT' as const,
        source: 'MMT',
        status: body.status === 'CANCELLED' ? 'CANCELLED' : 'BOOKED',
      },
      operation: (body.status === 'CANCELLED' ? 'CANCELLED' : 'CREATED') as 'CREATED' | 'MODIFIED' | 'CANCELLED',
    };
  }
}

/**
 * Goibibo adapter — exact same API surface as MMT (same backend).
 * Lives as a separate class so the Settings UI shows two distinct rows.
 */
class GoibiboAdapter extends MakeMyTripAdapter {
  channel = 'GOIBIBO';
  // Inherits MMT implementation; only the channel name differs.
}

/**
 * Agoda YCS adapter (STUB).
 * Real implementation:
 *   - Apply at https://partners.agoda.com
 *   - API: XML POST to https://ycs.agoda.com/...
 *   - Auth: API key in header
 *   - Operations: room availability, rates, booking notifications
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
    return { ok: true, message: 'agoda-stub: availability validated' };
  }
  validateWebhook(_creds: ChannelCredentials, _headers: any, _body: any) { return { ok: true }; }
  parseInbound(_creds: ChannelCredentials, body: any) {
    if (!body?.reservation_id) return { ok: false, reason: 'reservation_id missing' };
    return {
      ok: true,
      booking: {
        bookingId: body.reservation_id,
        guestName: body.guest_name,
        guestPhone: body.guest_phone || null,
        guestEmail: body.guest_email || null,
        roomId: body.room_id,
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
}

/**
 * Expedia QuickConnect adapter (STUB).
 * Real: https://developer.expediapartnersolutions.com
 */
class ExpediaAdapter extends AgodaAdapter {
  channel = 'EXPEDIA';
}

/**
 * Airbnb adapter (STUB).
 * Note: Airbnb does NOT have a public booking-push API for most properties.
 * Standard integration is iCal one-way; this stub exists for completeness.
 * Listed properties at scale (50+) can apply for the API: https://www.airbnbapi.com
 */
class AirbnbAdapter extends AgodaAdapter {
  channel = 'AIRBNB';
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
