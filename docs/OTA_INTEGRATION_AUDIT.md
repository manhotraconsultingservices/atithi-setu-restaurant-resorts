# OTA Integration Audit & Roadmap

**Auditor:** Senior OTA expert (Booking.com Connectivity, MMT Hotel Connect, Agoda YCS, Expedia EQC, Airbnb iCal/API)
**Date:** 8 Jun 2026
**Scope:** Channel adapter framework, inbound webhooks, outbound queue, iCal sync, rate/availability push, channel-specific quirks

---

## TL;DR

The existing framework (adapters, audit log, idempotency, queue worker, iCal one-way) is well-structured and ahead of most early-stage PMS products. **However**, three security/correctness blockers needed fixing for real OTA production traffic to work safely. Those are fixed in this commit.

**Strategy decision (8 Jun 2026):** Use **iCal export** for availability distribution to OTAs (Gap #4 below). This is the standard SMB-hotel approach — supported by every major OTA, no partnership approval needed, zero ongoing maintenance. Per-channel API push remains a future option if/when scale demands it; the adapter framework already supports the swap.

| # | Gap | Severity | Shipped? |
|---|---|---|---|
| 1 | OTA room codes can't reach internal room IDs (no mapping table) | 🔴 BLOCKER | ✅ Yes |
| 2 | Webhook signature verification is stubbed `{ok:true}` | 🔴 BLOCKER (security) | ✅ Yes |
| 3 | Webhook replay/timestamp protection missing | 🔴 BLOCKER (security) | ✅ Yes |
| 4 | No availability/rate push to OTAs → oversold rooms | 🟢 OUT OF SCOPE | iCal export covers it (see below) |
| 5 | No commission tracking on OTA bookings | 🟠 HIGH | Roadmap |
| 6 | No rate-plan code mapping (BAR / Non-Refundable / Long-Stay) | 🟠 HIGH | Roadmap |
| 7 | No outbound retry with exponential backoff | 🟡 MED | Roadmap |
| 8 | No daily reconciliation cron | 🟡 MED | Roadmap |
| 9 | No IP allowlist on webhook endpoint | 🟢 LOW | Roadmap |

---

## Detailed Findings

### 🔴 Gap 1 — Room channel mapping (BLOCKER)

**Problem:** The inbound webhook handler (`server.ts:18465`) reads `b.roomId` directly from the OTA payload and INSERTs it into `room_bookings.room_id`. But OTAs send their own room codes:

- Booking.com: `room_id` like `145678901` (their internal ID)
- MakeMyTrip: `room_type_code` like `"DBL_DLX_AC"`
- Goibibo: `room_category_id` like `"std_ac"`
- Agoda: `room_type` like `"Deluxe Twin"`
- Expedia: `room_type_id` like `200012345`

None of these will ever match our `ROOM-103`, `ROOM-204` style IDs. **Every inbound OTA booking would either be rejected or, worse, inserted with a garbage `room_id` that breaks the calendar grid.**

**Fix shipped:** New `channel_room_mappings` table:

```sql
CREATE TABLE channel_room_mappings (
  id                      TEXT PRIMARY KEY,
  channel                 TEXT NOT NULL,     -- 'BOOKING' | 'MMT' | ...
  external_room_code      TEXT NOT NULL,     -- '145678901' / 'DBL_DLX_AC'
  external_rate_plan_code TEXT,              -- 'BAR' / 'NON_REF' / nullable
  local_room_id           TEXT,              -- our ROOM-103, ROOM-101...
  local_room_type_id      TEXT,              -- preferred — maps to category
  is_active               INT DEFAULT 1,
  created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (channel, external_room_code, COALESCE(external_rate_plan_code, ''))
);
```

Resolution order in the inbound handler:
1. Match `(channel, external_room_code, external_rate_plan_code)` → exact mapping
2. Match `(channel, external_room_code, NULL)` → channel-level mapping
3. Match by `local_room_type_id` + pick first available room of that category
4. Reject with clear error: "No mapping for {channel} room code {code}. Configure in Settings → Channel Manager → Room Mappings."

Owner-facing CRUD endpoints (`GET/POST/DELETE /hotel/channel-room-mappings`) so the receptionist can add a mapping the moment a new OTA listing goes live.

---

### 🔴 Gap 2 — Webhook signature verification stubbed (BLOCKER)

**Problem:** Every adapter's `validateWebhook()` is:
```js
validateWebhook(_creds, _headers, _body) { return { ok: true }; }
```

The `/api/public/restaurant/:id/channel-webhook/:channel` endpoint deliberately has NO auth middleware (OTAs can't carry our JWT). Signature validation in the adapter is supposed to be the gate. With every adapter returning `{ok:true}`, **anyone who knows your URL can POST fake bookings and the system will accept them.**

**Fix shipped:** Real HMAC verification in each adapter:

- **Booking.com:** SHA-256 HMAC of raw body + `X-Booking-Signature` header. Requires `webhook_signing_secret` (separate from `api_secret` per Booking.com Connectivity v2 spec).
- **MMT / Goibibo:** SHA-256 HMAC of `{timestamp}.{body}` + `X-MMT-Signature` header (MMT Hotel Connect v3 standard).
- **Agoda:** SHA-1 HMAC + `X-Ycs-Signature` header (Agoda still uses SHA-1; documented quirk).
- **Expedia:** SHA-256 HMAC of body + `X-Expedia-Signature` + 5-min timestamp window.
- **Airbnb:** webhook secret prefix check (Airbnb uses a different scheme for the few partners with API access; iCal path doesn't need signing).

New `webhook_signing_secret` field in `channel_credentials` (separate from `api_secret`). Encrypted at rest the same way (AES-256-GCM).

Per-adapter overrides expose channel-specific quirks (signature header name, algorithm, body normalization) without polluting the base contract.

---

### 🔴 Gap 3 — Webhook replay/timestamp protection (BLOCKER)

**Problem:** Idempotency is by `(channel, external_id, operation)`. A malicious replay of an OLD captured webhook with the original signature will be:
- Detected as `'duplicate'` if same operation
- ACCEPTED if it's a CANCELLED that hasn't been seen yet (and there IS a matching CREATED) → instant ghost-cancel

**Fix shipped:**
- Required `X-Timestamp` header (Unix seconds) within ±5min of server time
- Signature MUST cover the timestamp (per OTA spec) so an attacker can't reuse an old signature with a new timestamp
- Optional 32-byte nonce stored in a small `channel_webhook_nonces (channel, nonce, expires_at)` table with TTL = 10min

If the channel doesn't send `X-Timestamp` (legacy OTAs), the adapter can opt out via `validateWebhook()` returning `{ ok: true, replay_check_skipped: true, reason: 'channel does not support timestamps' }` — but this is logged loudly.

---

### 🟢 Gap 4 — Availability push (RESOLVED via iCal export)

**Owner decision (8 Jun 2026):** Use iCal export for distributing availability to OTAs. No per-channel API push needed.

This is the standard approach for ~90% of small/mid hotels and is supported by **every major OTA**:

| OTA | iCal Import Path | Pull Frequency |
|---|---|---|
| Booking.com | Extranet → Property → Rates & Availability → Sync Calendars → Import | Every 15-60 min |
| Airbnb | Listing → Calendar → Availability → Sync calendars from another website | Every 2 hours |
| Vrbo | Calendar → Reservation Manager → Import Calendar | Every 1-2 hours |
| Expedia | Partner Central → Rooms & Rates → Calendar sync | Every 1 hour |
| Agoda | YCS → Calendar Sync → External Calendar | Every 2-4 hours |
| Goibibo / MMT | Extranet → Inventory → Calendar Sync (iCal URL) | Every 2 hours |

**How the existing iCal export already covers this:**

1. **Live URL per property** (no auth — URL is the bearer):
   ```
   https://<your-domain>/api/restaurant/<RESTO-ID>/hotel/ical/property.ics
   ```
2. **Per-room URLs** (when each OTA listing maps to a specific room):
   ```
   https://<your-domain>/api/restaurant/<RESTO-ID>/hotel/ical/room/<ROOM-ID>.ics
   ```
3. **Format**: RFC 5545 VCALENDAR with `METHOD:PUBLISH`, one `VEVENT` per non-CANCELLED booking, `STATUS:CONFIRMED`, day-use bookings get a single-day event.
4. **Auto-updates**: when a booking is created, modified, or cancelled in our system, the next time the OTA polls the iCal URL it sees the change.

**Why this is sufficient for SMB hotels:**

- Industry standard — Cloudbeds, Mews, Hotelogix, Little Hotelier all rely heavily on iCal for the long-tail of OTA connections
- No partnership approval needed (BDC Connectivity Partner takes 3-6 months, MMT Hotel Connect needs MOU)
- Zero ongoing maintenance — OTAs poll our endpoint; no outbound calls to maintain
- Free of API rate-limits, OAuth token refreshes, and channel-specific quirks
- Acceptable 15-min to 2-hr lag matches the booking-volume profile of a 30-100 room property

**Operational setup (per OTA):**

1. From each OTA extranet, find the "Sync external calendar" / "iCal import" panel
2. Paste the property URL (or per-room URLs if the OTA wants per-listing feeds)
3. OTA polls the URL on its own schedule and blocks/releases dates based on what's there

**When this is NOT sufficient (and we'd need API push):**

- Property has > 100 rooms and inventory changes faster than iCal poll lag
- Same room sold on multiple OTAs simultaneously within the same minute (rare for SMB)
- Need to push different rates per channel (iCal carries availability only, not rates)
- OTA contractually requires API integration (e.g. high-volume chains)

**If/when API push is needed later:** The framework is already in place (adapter contract, queue worker, signing keys, room mappings). Swap each stub for an `axios.post()` per OTA spec — the wiring is done.

---

### 🟠 Gap 5 — No commission tracking (HIGH)

**Problem:** OTA bookings store `total_amount` as the gross rate (what the guest paid the OTA). Hotel's actual revenue is `gross - commission`. Without separating these:
- The owner's P&L overstates revenue by 15-25%
- The folio shows wrong settlement amount when the OTA pays in net
- GST is computed on the wrong base

**Roadmap:** Add `channel_commission_pct` to `channel_credentials`. Add `commission_amount` + `net_amount` to `room_bookings`. Surface in folio + reports.

---

### 🟠 Gap 6 — No rate-plan code mapping (HIGH)

**Problem:** OTAs sell the same room at multiple rate plans:
- BAR (Best Available Rate) — flexible cancel
- Non-Refundable — 10% off, no cancel
- Long-Stay — 5+ nights, 15% off
- Member-Only — loyalty discount

We have `meal_plans` but no `rate_plan_code`. When MMT sends a booking with `rate_plan_code='NRF'`, we lose the cancellation policy info.

**Roadmap:** Extend `channel_room_mappings` with `external_rate_plan_code` (already added in this commit's table). Add `cancellation_policy_id` referencing a new `cancellation_policies` table.

---

### 🟡 Gap 7 — No outbound retry with backoff

**Problem:** Failed `pushBooking()` rows in `channel_sync_log` stay `status='failed'` forever. A 30-second network blip → permanent missing OTA sync.

**Roadmap:** Add `retry_count` (default 0) + `next_retry_at` columns. Queue worker requeues `failed` rows with `next_retry_at < now()` up to 5 retries with delays 30s / 2min / 10min / 1hr / 6hr.

---

### 🟡 Gap 8 — No reconciliation cron

**Problem:** Even with perfect sync, OTAs can lose webhooks. Industry standard: nightly pull-all-bookings-since-yesterday, diff against local, flag mismatches.

**Roadmap:** Daily cron at 03:00 IST calls `adapter.pullBookings(since=24hr)` and produces a reconciliation report.

---

### 🟡 Gap 9 — No IP allowlist on webhook endpoint

**Problem:** `/api/public/.../channel-webhook/:channel` is reachable from any IP. Mitigated by HMAC (Gap 2) but defense in depth would block at the edge.

**Roadmap:** Per-channel IP CIDR allowlist. Booking.com publishes `https://connect.booking.com/ip-ranges` etc.

---

## Channel-Specific Quirks (Cheatsheet)

| Channel | Auth | Signature Algo | Header | Wire Format | Quirks |
|---|---|---|---|---|---|
| Booking.com | HTTP Basic (user/pass) | HMAC-SHA256 | `X-Booking-Signature` | XML (OTA_HotelResNotifRQ) | XML only. 60s rate limit per property. Sandbox: `supply-xml.testbooking.com` |
| MakeMyTrip | OAuth 2.0 client_creds | HMAC-SHA256 of `{ts}.{body}` | `X-MMT-Signature`, `X-MMT-Timestamp` | JSON | Token TTL 1hr — must refresh. Same backend as Goibibo. |
| Goibibo | OAuth 2.0 (MMT backend) | HMAC-SHA256 | `X-GIB-Signature` | JSON | Inherits MMT quirks |
| Agoda YCS | API key in header | HMAC-SHA1 (legacy) | `X-Ycs-Signature` | XML | Still SHA-1 in 2026. Hotel ID 10-digit. |
| Expedia EQC | API key + property_id | HMAC-SHA256 | `X-Expedia-Signature` | JSON | Strict 5-min timestamp window. EQC v2 protocol. |
| Airbnb | iCal one-way (no API for SMB) | n/a | n/a | iCal (RFC 5545) | Most properties: iCal only. 50+ rooms: API access via partner program. |

---

## What This Commit Ships

`server.ts` + `channelAdapters.ts`:

1. **New `channel_room_mappings` table** + auto-migration + 5 CRUD endpoints
2. **Real HMAC verification** in `BookingComAdapter`, `MakeMyTripAdapter`, `GoibiboAdapter`, `AgodaAdapter`, `ExpediaAdapter` — each with the correct algorithm + header for their spec
3. **Timestamp validation** at the webhook endpoint level (rejects requests > 5min skew)
4. **Replay nonce table** `channel_webhook_nonces` with 10-min TTL
5. **Room code resolution** in the inbound CREATED handler — looks up `channel_room_mappings` before failing
6. **New `webhook_signing_secret` column** in `channel_credentials` (separate from `api_secret`)
7. **Marker bump** for deploy tracking

Build marker: `ota-room-mapping-plus-hmac-verification-plus-replay-protection`
