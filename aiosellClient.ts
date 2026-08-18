// ─────────────────────────────────────────────────────────────────────────────
// aiosellClient.ts — Aiosell Channel-Manager API client (apidocs.aiosell.com, /api/v2/cm)
//
// Aiosell is a channel manager: Atithi-Setu (our PMS) is the source of truth for
// rates/inventory; we PUSH availability/rates/restrictions to Aiosell which fans
// them out to OTAs, and Aiosell PUSHES OTA reservations back to us (webhook).
//
// Contract facts (from the Aiosell API context doc — do NOT invent beyond it):
//   • Base URL:  https://live.aiosell.com/api/v2/cm
//   • Auth:      HTTP Basic — Authorization: Basic base64(username:password).
//                Credentials + partner id ({pms}) are PARTNER-LEVEL, issued at
//                onboarding → they are PLATFORM config (env), NOT per-tenant.
//   • {pms}      partner id, goes in the PUSH/FETCH URL path (/update/{pms} etc.).
//   • hotelCode  per-property id, goes in the request BODY. Sandbox: hotelCode
//                "sandbox-pms", partnerId "sample-pms".
//   • Dates      YYYY-MM-DD, ranges inclusive both ends; pushes are UPSERTS.
//   • JSON keys  camelCase. Response shape { success:boolean, message:string }
//                (channel_multiplier uses { status:boolean, message }).
//   • Restriction fields: unset = null (send the key with null, don't omit).
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'crypto';

export interface AiosellConfig {
  baseUrl: string;   // https://live.aiosell.com/api/v2/cm
  partnerId: string; // {pms} — e.g. "sample-pms" (sandbox) or the id assigned at onboarding
  username: string;  // Basic Auth username (partner-level)
  password: string;  // Basic Auth password (partner-level)
}

export interface AiosellResult {
  ok: boolean;
  status: number;         // HTTP status
  message: string;        // Aiosell `message` (or an HTTP/parse error)
  data?: any;             // parsed response body
}

// ── Config (platform-level; read from env) ───────────────────────────────────
export function aiosellConfigFromEnv(): AiosellConfig {
  return {
    baseUrl: (process.env.AIOSELL_BASE_URL || 'https://live.aiosell.com/api/v2/cm').replace(/\/+$/, ''),
    partnerId: process.env.AIOSELL_PARTNER_ID || '',
    username: process.env.AIOSELL_USERNAME || '',
    password: process.env.AIOSELL_PASSWORD || '',
  };
}

// Whether the platform is configured to talk to Aiosell at all.
export function aiosellConfigured(cfg: AiosellConfig = aiosellConfigFromEnv()): boolean {
  return !!(cfg.baseUrl && cfg.partnerId && cfg.username && cfg.password);
}

// Inbound-webhook credentials (what WE validate on Aiosell's calls to us). Default
// to the same partner Basic Auth unless a dedicated inbound pair is configured.
export function aiosellWebhookCreds(): { username: string; password: string } {
  const cfg = aiosellConfigFromEnv();
  return {
    username: process.env.AIOSELL_WEBHOOK_USERNAME || cfg.username,
    password: process.env.AIOSELL_WEBHOOK_PASSWORD || cfg.password,
  };
}

function authHeader(cfg: AiosellConfig): string {
  return 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
}

// Constant-time validation of an inbound Basic Auth header against an EXPLICIT
// username/password pair — used by the webhook once the tenant (and hence its
// stored credentials) has been resolved from the request's hotelCode.
export function verifyBasicAuthCredentials(expectedUser: string | null | undefined, expectedPass: string | null | undefined, headerValue: string | undefined | null): boolean {
  try {
    if (!expectedUser || !expectedPass) return false; // not configured → reject
    const m = /^Basic\s+(.+)$/i.exec(String(headerValue || ''));
    if (!m) return false;
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return false;
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    const expected = `${expectedUser}:${expectedPass}`;
    const got = `${user}:${pass}`;
    // Length-safe constant-time compare.
    const a = Buffer.from(expected);
    const b = Buffer.from(got);
    if (a.length !== b.length) { crypto.timingSafeEqual(a, a); return false; }
    return crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// Constant-time validation of an inbound Basic Auth header against the platform
// (env) webhook creds. Kept for env-only deployments; the per-tenant path uses
// verifyBasicAuthCredentials with the tenant's stored creds instead.
export function verifyAiosellBasicAuth(headerValue: string | undefined | null): boolean {
  const creds = aiosellWebhookCreds();
  return verifyBasicAuthCredentials(creds.username, creds.password, headerValue);
}

// ── Low-level call ───────────────────────────────────────────────────────────
async function call(cfg: AiosellConfig, method: string, path: string, body?: any): Promise<AiosellResult> {
  const url = `${cfg.baseUrl}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: authHeader(cfg),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
  } catch (e: any) {
    return { ok: false, status: 0, message: e?.message || 'network error' };
  }
  const text = await res.text().catch(() => '');
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  // Aiosell success flag is `success` (or `status` on channel_multiplier).
  const flagged = data && (data.success === true || data.status === true);
  const failed = (data && (data.success === false || data.status === false)) || !res.ok;
  if (failed && !flagged) {
    const message = (data && (data.message || data.error)) || `HTTP ${res.status}`;
    return { ok: false, status: res.status, message, data };
  }
  return { ok: true, status: res.status, message: (data && data.message) || 'ok', data };
}

// ── Restriction normaliser (unset = null; never omit — per the contract) ──────
export interface AiosellRestrictions {
  stopSell: boolean | null;
  minimumStay: number | null;
  maximumStay: number | null;
  closeOnArrival: boolean | null;
  closeOnDeparture: boolean | null;
  minimumStayArrival: number | null;
  maximumStayArrival: number | null;
  exactStayArrival: number | null;
  minimumAdvanceReservation: number | null;
  maximumAdvanceReservation: number | null;
}
export function aiosellRestrictions(partial: Partial<AiosellRestrictions> = {}): AiosellRestrictions {
  const n = <T,>(v: T | undefined): T | null => (v === undefined ? null : v);
  return {
    stopSell: n(partial.stopSell),
    minimumStay: n(partial.minimumStay),
    maximumStay: n(partial.maximumStay),
    closeOnArrival: n(partial.closeOnArrival),
    closeOnDeparture: n(partial.closeOnDeparture),
    minimumStayArrival: n(partial.minimumStayArrival),
    maximumStayArrival: n(partial.maximumStayArrival),
    exactStayArrival: n(partial.exactStayArrival),
    minimumAdvanceReservation: n(partial.minimumAdvanceReservation),
    maximumAdvanceReservation: n(partial.maximumAdvanceReservation),
  };
}

// ── Payload types ────────────────────────────────────────────────────────────
export interface AiosellInventoryUpdate { startDate: string; endDate: string; rooms: Array<{ roomCode: string; available: number }>; }
export interface AiosellRateUpdate { startDate: string; endDate: string; rates: Array<{ roomCode: string; rateplanCode: string; rate: number }>; }
export interface AiosellInvRestrictionUpdate { startDate: string; endDate: string; rooms: Array<{ roomCode: string; restrictions: AiosellRestrictions }>; }
export interface AiosellRateRestrictionUpdate { startDate: string; endDate: string; rates: Array<{ roomCode: string; rateplanCode: string; restrictions: AiosellRestrictions }>; }

// ── PMS → Aiosell (push) ─────────────────────────────────────────────────────

/** GET /property_details/{hotelCode}?partnerId={pms} — call FIRST to learn the
 *  room_id / rateplan_id codes to use everywhere else. */
export function aiosellGetProperty(cfg: AiosellConfig, hotelCode: string): Promise<AiosellResult> {
  const path = `/property_details/${encodeURIComponent(hotelCode)}?partnerId=${encodeURIComponent(cfg.partnerId)}`;
  return call(cfg, 'GET', path);
}

/** POST /update/{pms} — push room-type availability (upsert over date range). */
export function aiosellPushInventory(cfg: AiosellConfig, hotelCode: string, updates: AiosellInventoryUpdate[]): Promise<AiosellResult> {
  return call(cfg, 'POST', `/update/${encodeURIComponent(cfg.partnerId)}`, { hotelCode, updates });
}

/** POST /update-rates/{pms} — push (room, rateplan, date) rates. */
export function aiosellPushRates(cfg: AiosellConfig, hotelCode: string, updates: AiosellRateUpdate[]): Promise<AiosellResult> {
  return call(cfg, 'POST', `/update-rates/${encodeURIComponent(cfg.partnerId)}`, { hotelCode, updates });
}

/** POST /update/{pms} — room-level restrictions (stop-sell, min-stay, CTA/CTD…). */
export function aiosellPushInventoryRestrictions(cfg: AiosellConfig, hotelCode: string, toChannels: string[], updates: AiosellInvRestrictionUpdate[]): Promise<AiosellResult> {
  return call(cfg, 'POST', `/update/${encodeURIComponent(cfg.partnerId)}`, { hotelCode, toChannels, updates });
}

/** POST /update-rates/{pms} — rate-plan-level restrictions. */
export function aiosellPushRateRestrictions(cfg: AiosellConfig, hotelCode: string, toChannels: string[], updates: AiosellRateRestrictionUpdate[]): Promise<AiosellResult> {
  return call(cfg, 'POST', `/update-rates/${encodeURIComponent(cfg.partnerId)}`, { hotelCode, toChannels, updates });
}

/** POST /marknoshow/{pms} — channel currently only "booking.com" | "gommt". */
export function aiosellMarkNoShow(cfg: AiosellConfig, hotelCode: string, bookingId: string, channel: string): Promise<AiosellResult> {
  return call(cfg, 'POST', `/marknoshow/${encodeURIComponent(cfg.partnerId)}`, { hotelCode, bookingId, channel });
}

/** POST /data/{pms} — one endpoint; `type` = "inventory" | "rates" | "reservation". */
export function aiosellFetchData(cfg: AiosellConfig, hotelCode: string, type: 'inventory' | 'rates' | 'reservation', startDate: string, endDate: string): Promise<AiosellResult> {
  return call(cfg, 'POST', `/data/${encodeURIComponent(cfg.partnerId)}`, { type, hotelCode, startDate, endDate });
}

/** POST /channel_multiplier/{pms} — scale rates by a factor for listed channels. */
export function aiosellChannelMultiplier(cfg: AiosellConfig, hotelCode: string, multiplier: number, channels: string[]): Promise<AiosellResult> {
  return call(cfg, 'POST', `/channel_multiplier/${encodeURIComponent(cfg.partnerId)}`, { hotelCode, multiplier, channels });
}

// ── Inbound reservation payload (Aiosell → PMS webhook / fetch reservations) ──
// Every guest.* field + rooms[].guestName is OPTIONAL (OTA-dependent, may be
// masked/absent). specialRequests is free text. `modify` is a full replacement.
export interface AiosellReservation {
  action: 'book' | 'modify' | 'cancel';
  hotelCode: string;
  channel: string;                 // OTA name, e.g. "Goibibo"
  bookingId: string;               // OTA booking id (idempotency key)
  cmBookingId?: string | null;
  bookedOn?: string;               // "YYYY-MM-DD HH:MM:SS"
  checkin?: string;                // YYYY-MM-DD
  checkout?: string;               // YYYY-MM-DD
  segment?: string;                // e.g. "OTA"
  specialRequests?: string | null;
  pah?: boolean;                   // pay-at-hotel: true = collect at hotel, false = prepaid
  amount?: {
    amountAfterTax?: number; amountBeforeTax?: number; tax?: number;
    currency?: string; commission?: number | null; tcs?: number | null; tds?: number | null;
  };
  guest?: {
    firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null;
    address?: { line1?: string | null; city?: string | null; state?: string | null; country?: string | null; zipCode?: string | null } | null;
  };
  rooms?: Array<{
    roomCode: string; rateplanCode: string; guestName?: string | null;
    occupancy?: { adults?: number; children?: number };
    prices?: Array<{ date: string; sellRate: number }>;
  }>;
}
