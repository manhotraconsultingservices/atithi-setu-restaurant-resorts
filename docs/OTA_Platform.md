# Atithi-Setu — OTA Platform Guide

**Audience:** hotel owners, GMs, front-desk managers, and the Atithi-Setu account team explaining the Channel Manager to clients.
**Goal:** explain every concept and every workflow end-to-end, in plain language, so nobody is surprised by anything the system does.

---

## Table of Contents

1. [What is an OTA?](#1-what-is-an-ota)
2. [Why connect to OTAs at all?](#2-why-connect-to-otas-at-all)
3. [The big picture in 60 seconds](#3-the-big-picture-in-60-seconds)
4. [Key concepts (the vocabulary)](#4-key-concepts-the-vocabulary)
5. [How Atithi-Setu talks to OTAs](#5-how-atithi-setu-talks-to-otas)
6. [Setting up a new OTA — step by step](#6-setting-up-a-new-ota--step-by-step)
7. [End-to-end workflows](#7-end-to-end-workflows)
8. [Commission tracking and net revenue](#8-commission-tracking-and-net-revenue)
9. [Rate plans (BAR / NRF / LSTAY / MEMBER)](#9-rate-plans-bar--nrf--lstay--member)
10. [The Live Rate Card view](#10-the-live-rate-card-view)
11. [What can go wrong, and how we recover](#11-what-can-go-wrong-and-how-we-recover)
12. [Security — how we keep bad actors out](#12-security--how-we-keep-bad-actors-out)
13. [Daily double-check (reconciliation)](#13-daily-double-check-reconciliation)
14. [Channel Manager tab — section by section](#14-channel-manager-tab--section-by-section)
15. [Frequently asked questions](#15-frequently-asked-questions)
16. [Glossary](#16-glossary)

---

## 1. What is an OTA?

**OTA = Online Travel Agency.**

It is a website (or app) where travellers search for and book hotel rooms. The hotel does not own the website — the OTA does. The hotel pays the OTA a percentage of each booking the OTA brings in.

The biggest OTAs in India:

| OTA | Region/strength | Typical commission |
|---|---|---|
| **Booking.com** | Global, biggest in India | 15% (10-22% depending on visibility tier) |
| **MakeMyTrip (MMT)** | Indian leisure & business travel | 18-22% |
| **Goibibo** | Owned by MMT, same backend | 18-22% |
| **Agoda** | Strong in Asia | 15-20% |
| **Expedia** | Global, strong for inbound | 15-20% |
| **Airbnb** | Boutique / homestay-style | 14-16% |
| **Direct** (your own website / walk-in / phone) | Highest margin | 0% |

> **Why a hotel uses multiple OTAs**: each OTA reaches a different audience. Booking.com brings international travellers, MMT brings domestic leisure, Airbnb brings the boutique experience-seekers. Listing on 4-5 OTAs typically fills 60-80% of room nights for an independent property.

---

## 2. Why connect to OTAs at all?

A hotel has two choices:

**Option A — Stay off the OTAs.**
- Pro: 0% commission, every rupee is yours.
- Con: nobody finds you unless they already know your name. Occupancy will be low, especially out of season.

**Option B — List on multiple OTAs.**
- Pro: 70-90% occupancy is realistic. You are discoverable to millions.
- Con: 15-22% commission per booking. Every room you sell to an OTA, you give them a slice.

**Almost every independent hotel chooses Option B** — because a room sitting empty earns 0 rupees, whereas a room sold for Rs 5,000 with 15% commission still nets Rs 4,250.

The catch: once you list on 4-5 OTAs simultaneously, you face a **double-booking nightmare**. If 3 OTAs show your last room and 3 different guests click "Book" at the same time, you have a major problem.

This is what a Channel Manager solves — and Atithi-Setu's Channel Manager is what this document explains.

---

## 3. The big picture in 60 seconds

```
+---------------------------------------------------------------+
|                                                               |
|   Traveller                                                   |
|      |                                                        |
|      |  (1) Searches "hotels in Goa" on Booking.com           |
|      |  (2) Picks your Deluxe Room                            |
|      |  (3) Pays Booking.com                                  |
|      v                                                        |
|   Booking.com  ---- (4) Sends booking to Atithi-Setu -----+   |
|      |                                                    |   |
|      |  (5) Holds onto the money                          |   |
|      |  (6) Pays you (minus commission) at month-end      |   |
|      |                                                    |   |
|                                                           v   |
|                                              +--------------+ |
|                                              | Atithi-Setu  | |
|                                              |              | |
|                                              | (7) Marks    | |
|                                              |     the room | |
|                                              |     booked   | |
|                                              |              | |
|                                              | (8) Tells    | |
|                                              |     ALL      | |
|                                              |     OTHER    | |
|                                              |     OTAs     | |
|                                              |     "GONE"   | |
|                                              +--------------+ |
|                                                               |
+---------------------------------------------------------------+
```

Three things matter:

1. **Inbound** — bookings arrive from OTAs (steps 4, 7).
2. **Outbound** — once we are booked, we have to tell every other OTA so they stop selling the same room (step 8).
3. **Money flow** — guest pays the OTA, OTA pays you minus commission, you track the commission so you know your real revenue (steps 5, 6).

Everything in Atithi-Setu's Channel Manager is one of these three things.

---

## 4. Key concepts (the vocabulary)

These are the terms used everywhere — internally and by the OTAs themselves. Understanding them is the difference between "feeling confused" and "owning the system."

### 4.1 Inventory
The rooms you have for sale on a given date. A 30-room hotel has 30 units of inventory per night. Inventory is the most important number — get this wrong and you sell rooms you do not have.

### 4.2 Availability
Which rooms are bookable on which dates. A room is "available" when nobody has booked it and you have not blocked it (for maintenance, owner stay, group booking, etc.). Availability is what each OTA shows on its search page.

### 4.3 Rate
The price you charge per night. Atithi-Setu supports:
- A **base rate** per room (e.g. Deluxe = Rs 5,000/night)
- A **rate matrix** by date x room category x meal plan (for season pricing)
- A **rate plan** discount on top (e.g. NRF = 10% off the base rate)

### 4.4 Rate Plan
A "way of selling" the same room. The four industry-standard rate plans (every OTA recognises them):

| Code | Name | Meaning |
|---|---|---|
| **BAR** | Best Available Rate | The standard refundable price. Guest can cancel up to 24-48 hours before check-in. |
| **NRF** | Non-Refundable Rate | Discounted (typically 10% off) but no refund on cancellation. |
| **LSTAY** | Long Stay | Discounted (typically 15% off) for stays of 5+ nights. |
| **MEMBER** | Member Rate | Special discount (typically 5-8% off) for loyalty / repeat customers. |

You can add custom plans too (e.g. "WEEKEND" or "MONSOON").

### 4.5 Room Mapping
Each OTA has its own ID for your rooms. Booking.com calls your Deluxe Room "Room ID 12345678", MMT calls it "DLX-001". The room mapping table tells our system "when Booking.com says 12345678, that is our `deluxe_01`."

Without proper mapping, a booking comes in but we do not know *which* of our rooms was sold.

### 4.6 Commission
The slice the OTA keeps from each booking. If a room sells for Rs 5,000 and the OTA's commission is 15%, the OTA keeps Rs 750 and pays you Rs 4,250.

We track commission **per channel**, snapshotted at booking time — if you renegotiate with the OTA later, your historical bookings keep their original commission percentage so past reports stay accurate.

### 4.7 Webhook
The OTA's way of telling you "hey, a new booking just happened." It is a real-time HTTP POST from the OTA's servers to ours. Webhooks are instant (within seconds) but require the OTA to approve our integration first.

### 4.8 iCal Feed
A simpler, universal way an OTA shares its bookings — as a calendar file (`.ics`) that we download every 30 minutes. Works with every OTA without any partner approval, just paste a URL. Slower than webhooks (up to 30 min lag), but no setup hurdles.

> **In practice:** new properties start with iCal because it works immediately. Once volume grows and the OTA approves the partner API, they switch to webhooks for the speed.

### 4.9 HMAC Signature
A cryptographic stamp that proves the message really came from the OTA and was not faked by an attacker. The OTA signs every webhook with a secret key only they and we know. We verify the signature before trusting the booking.

### 4.10 IP Allowlist
An optional extra security layer — "only accept messages from Booking.com if they come from these specific computer addresses (IPs)." So even if someone steals the HMAC secret, they still cannot fake a booking unless they are also on the OTA's network.

### 4.11 Property ID
The OTA's identifier for your hotel. Booking.com may call your property "PRP-9988123", MMT "HOT-77881". You enter these when first connecting an OTA.

### 4.12 Reconciliation
The daily "did everything add up?" check. Every night at 3:15 AM we ask each OTA "list every booking you sent us in the last 24 hours" and compare against what is actually in our system. Any mismatch is surfaced as a report so you can fix it before it causes a double-booking.

### 4.13 Outbound Queue
The list of "I need to tell OTAs that something changed" tasks waiting to be sent. When you change a room price or block a date, we do not send it immediately — we add it to a queue and a background worker sends each one with automatic retries if the OTA is slow.

### 4.14 Exponential Backoff
The "I will try again, but slower each time" pattern. When sending an update to an OTA fails, we wait 30 seconds, then try again. Still fails? Wait 2 minutes. Then 10 minutes, 1 hour, 6 hours. After 5 failed attempts we stop and ask the human for help. This prevents us from hammering an OTA's servers when they are having issues.

---

## 5. How Atithi-Setu talks to OTAs

Two flows: **inbound** (OTA -> us) and **outbound** (us -> OTA).

### 5.1 Inbound (OTA -> Atithi-Setu)

Three methods, in order of preference:

```
+-----------------------------------------------------------------+
| Method 1 - WEBHOOK (best, instant)                              |
|   OTA sends a real-time HTTP POST to our public URL.            |
|   We verify HMAC signature, then write to room_bookings.        |
|   Latency: < 5 seconds.                                         |
|   Requires: OTA partner API approval + extranet credentials.    |
+-----------------------------------------------------------------+

+-----------------------------------------------------------------+
| Method 2 - iCal FEED (universal, slower)                        |
|   We poll the OTA's iCal export URL every 30 minutes.           |
|   Parse VEVENT entries, match to local rooms, write to bookings.|
|   Latency: up to 30 minutes.                                    |
|   Requires: nothing - just paste the URL from the OTA extranet. |
+-----------------------------------------------------------------+

+-----------------------------------------------------------------+
| Method 3 - MANUAL ENTRY                                         |
|   For OTAs we do not yet support (or properties just starting). |
|   Front-desk enters the booking from the OTA's email/dashboard. |
|   Latency: whenever the human enters it.                        |
+-----------------------------------------------------------------+
```

### 5.2 Outbound (Atithi-Setu -> OTAs)

When something on our side changes (price update, manual block, walk-in booking), we tell every connected OTA:

```
Trigger event (price change / block / new booking)
        |
        v
Write task to channel_sync_log queue
        |
        v
Background worker (runs every minute)
        |
        +--> Try sending to OTA
        |    |
        |    +- Success -> mark row 'success'
        |    |
        |    +- Failure -> bump retry_count, schedule next attempt
        |                  30s -> 2min -> 10min -> 1hr -> 6hr
        |                  After 5 fails -> mark 'permanently_failed'
        |                                  operator must manually retry
        |
        v
iCal export URL - every OTA can pull from us too
   (we host an .ics endpoint per room, no setup needed)
```

> **Why we use iCal export for outbound** instead of pushing to each OTA's API:
> - Works with every OTA without partner approval
> - One endpoint serves all of them - no per-OTA push code to maintain
> - The OTA pulls when they want; we do not have to retry on their network issues
> - For real-time blocks (e.g. just-sold last room), the OTA's own webhook + the iCal will both update within 30 minutes maximum
>
> The outbound queue still exists for properties that have full bidirectional API integration with specific OTAs - it is there when you need it.

---

## 6. Setting up a new OTA — step by step

Let's walk through connecting Booking.com end-to-end.

### Step 1 — Get credentials from Booking.com extranet

1. Log into admin.booking.com
2. Go to **Account -> Connectivity provider** -> look for "API credentials"
3. Note down:
   - **Hotel ID** (your property ID — e.g. `12345678`)
   - **API Key** (long alphanumeric string)
   - **API Secret** (treat like a password)
   - **Webhook Signing Secret** (separate, in the "Webhooks" panel)
4. In the same screen, set the **Webhook URL** to:
   `https://yourdomain.atithi-setu.com/api/public/restaurant/<your-id>/channel-webhook/BOOKING`
5. Note Booking.com's **commission percentage** from your contract (usually 15%).

### Step 2 — Add the channel in Atithi-Setu

1. Open **Channel Manager** tab -> scroll to "How bookings reach us" -> "OTA credentials" section
2. Click **Add Channel** (or **Edit** if BOOKING already exists)
3. Fill in:
   - Channel: **Booking.com**
   - API Key: paste from Step 1
   - API Secret: paste from Step 1
   - Property ID: paste your Hotel ID
   - **Commission %**: 15 (or whatever your contract says)
   - **Webhook Signing Secret**: paste from Step 1
   - Tick **"Enable inventory sync to this channel"**
4. Save.

### Step 3 — Map your rooms

Each room you sell on Booking.com needs to be linked to a local room in Atithi-Setu:

1. In Channel Manager -> "Room mappings" section
2. For each Booking.com Room ID (you can find these in the Booking.com extranet -> "Rooms"):
   - Channel: BOOKING
   - External Room Code: e.g. `12345678_DLX`
   - Local Room: pick your Deluxe Room from the dropdown
   - Rate Plan: pick BAR (or whichever plan you are selling under)
3. Save.

### Step 4 — Add an iCal feed as backup

Even with webhooks working, add iCal as redundancy:

1. In Booking.com extranet -> "Rates & Availability" -> "Sync calendars"
2. Copy the iCal export URL for each room
3. In Atithi-Setu -> Channel Manager -> "Inbound iCal feeds" -> **Add iCal Feed**
4. Paste URL, pick the matching local room, set channel = BOOKING
5. Save.

### Step 5 — Verify

1. Open the **Live Rate Card** at the top of Channel Manager
2. You should see a new column "Booking.com (OTA keeps 15%)"
3. Each cell shows what guests will see + what you will net
4. Pipeline Health card should show "OTAs Connected: 1 / N"
5. Wait for the first webhook (test by creating a fake booking from the extranet) -> it appears in the booking list within seconds, and the webhook log shows "verified."

That's it. You can repeat for MMT, Goibibo, Agoda, Expedia, Airbnb.

---

## 7. End-to-end workflows

### 7.1 Workflow: Guest books your room on Booking.com

```
T+0s    Guest clicks "Book" on Booking.com, pays them
T+2s    Booking.com fires webhook -> POST to our endpoint
T+2s    We verify HMAC signature against the webhook signing secret
        IF signature is bad -> reject with 401, log the attempt
T+2s    We check replay protection - same nonce + timestamp seen before?
        IF yes -> reject with 409, ignore the duplicate
T+3s    We look up the OTA Room ID in channel_room_mappings
        -> resolve to local room (e.g. deluxe_01) + rate plan
T+3s    Check overlap - is the room already booked for those dates?
        IF yes -> reject with 409 ("conflict"), log for manual triage
T+3s    Snapshot commission_pct from channel_credentials onto the booking
        Compute commission_amount + net_amount
T+3s    INSERT into room_bookings, status='BOOKED', booking_source='BOOKING'
T+4s    Push outbound sync to ALL OTHER OTAs ("this room is now blocked")
T+4s    Update iCal export URL (auto - no action needed)
T+30s   Other OTAs that use iCal polling pick up the block within 30 min
T+30m   Their search page no longer shows your room for those dates
```

### 7.2 Workflow: Guest cancels their Booking.com reservation

```
T+0s    Guest clicks "Cancel" on Booking.com
T+2s    Booking.com fires webhook with event=cancelled
T+2s    HMAC verification (same as create flow)
T+3s    UPDATE room_bookings SET status='CANCELLED' WHERE id = ?
T+4s    Push outbound sync to ALL OTHER OTAs ("this room is available again")
T+30s   Other OTAs see the room as bookable again
```

### 7.3 Workflow: You change a room's price

```
T+0      You open Rooms tab -> edit Deluxe -> change price from Rs 5,000 to Rs 5,500
T+1s     Server updates rooms table
T+1s     Server inserts row into channel_sync_log for EACH enabled channel
         operation='rate_update', payload={...}, status='queued'
T+60s    Background worker picks up queued rows
         For each: POST to OTA's "set rate" endpoint
T+62s    OTA responds OK -> mark row 'success'
         OTA responds 5xx -> mark 'failed', schedule retry in 30s
         If retry succeeds -> mark 'success'
         If retry fails again -> next attempt in 2 minutes
         After 5 failures -> mark 'permanently_failed'
         Operator can manually retry from the Channel Manager UI
```

### 7.4 Workflow: Walk-in customer at the front desk

```
T+0      Receptionist walks customer through check-in
T+30s    Front desk creates booking in Atithi-Setu (room=deluxe_01)
T+30s    Server INSERT into room_bookings, booking_source='WALK_IN'
T+30s    Server pushes outbound sync - "deluxe_01 is no longer available"
T+30s    Server updates iCal export
T+5min   Booking.com / MMT / Agoda iCal pollers pick up the block
         (or instantly if push-API is active)
```

### 7.5 Workflow: Daily reconciliation (3:15 AM)

```
T+0     Cron fires for every hotel tenant
T+1s    For each enabled OTA channel:
          - Call adapter.pullBookings(since=24hrs ago)
          - Get back a list of bookings the OTA has on their side
T+5s    Compare against local room_bookings WHERE booking_source = channel
        Count:
          - local_count (we have)
          - remote_count (OTA has)
          - missing_in_local (OTA has, we do not)  <- BAD - we will double-book
          - missing_in_remote (we have, OTA does not)  <- BAD - they will resell
T+10s   INSERT into channel_reconciliation_reports
        Status = 'ok' (matched) | 'mismatch' (any difference)
               | 'stub' (adapter not approved yet) | 'error'
T+15s   If status='mismatch' -> flag for operator attention
T+next-day-morning  Operator opens "Daily double-check" panel,
                    sees the mismatch, clicks the report,
                    investigates and resolves before damage
```

---

## 8. Commission tracking and net revenue

### How commission is captured

Every channel's commission % is configured **once** when you add or edit its credentials. When a booking lands:

1. We read the channel's current `commission_pct`
2. Snapshot it onto the booking row (so historical reports never shift if you renegotiate)
3. Auto-compute:
   - `commission_amount = total_amount x commission_pct / 100`
   - `net_amount = total_amount - commission_amount`
4. Store all three on the booking

### Why snapshotting matters

If you renegotiate Booking.com from 15% to 12% in March, then look at January reports in April, you want January to still show 15% — that is what you actually paid. Snapshotting is what makes this work. Without it, every old report would silently shift.

### Where to see it

**Channel Manager -> "What each OTA cost you"** shows the last 30 days per channel:
- Bookings count
- Gross revenue (what guests paid)
- Avg commission %
- Commission amount (what OTAs kept)
- **Net amount** (what you actually received)

### How to use it strategically

Three plays that pay for the system many times over:

1. **Push direct bookings.** Your own website is 0% commission. If you can shift even 10% of OTA bookings to direct (via repeat customers, email marketing, loyalty), you instantly add 1.5-2.2% to your top line.

2. **Re-negotiate annual rates.** Take the Commission Summary screenshot to your Booking.com / MMT account manager when arguing for a commission cut on volume. "I am doing Rs 4.2L/month through you — what is the path to 12%?"

3. **Tilt inventory toward high-margin channels.** When direct demand is high, lower your direct site's BAR rate (or run a promo) and raise it on MMT — you funnel high-intent travellers to the cheaper-for-you channel without losing the OTA-discovery audience.

---

## 9. Rate plans (BAR / NRF / LSTAY / MEMBER)

A single physical room (Deluxe) can be sold to the SAME OTA under MULTIPLE rate plans simultaneously. The OTA shows them as separate "products" on its search page:

```
Booking.com search results:
+------------------------------------------------------------+
| Your Hotel - Deluxe Room                                   |
+------------------------------------------------------------+
|  * BAR    - Rs 5,000/night, free cancellation up to 24h    |
|  * NRF    - Rs 4,500/night, NON-refundable (cheaper!)      |
|  * LSTAY  - Rs 4,250/night for 5+ nights                   |
+------------------------------------------------------------+
```

The traveller picks one based on their preference (flexibility vs. price). All three sell the SAME physical room — once any one is booked, all three become unavailable.

### Default plans (auto-seeded)

When you first open the Rate Plans panel, four industry-standard plans appear automatically:

| Code | Name | Discount | Refundable | Min Nights |
|---|---|---|---|---|
| BAR | Best Available Rate | 0% | Yes | 1 |
| NRF | Non-Refundable | 10% off | No | 1 |
| LSTAY | Long Stay | 15% off | Yes | 5 |
| MEMBER | Member-Only Rate | 8% off | Yes | 1 |

You can edit any of these (change the discount, deactivate, rename) or add custom ones.

### Custom plans

Common additions:
- **WEEKEND** — different discount on Fri/Sat
- **MONSOON** — seasonal heavy discount for low season
- **CORP** — corporate negotiated rate
- **HONEYMOON** — bundle with extras

The Live Rate Card automatically picks them up — you do not need to configure anything else.

---

## 10. The Live Rate Card view

The headline view in the redesigned Channel Manager. For every room category, it shows a complete grid:

```
Deluxe Room - 8 rooms - Base rate: Rs 5,000/night

                    Direct           Booking.com      MMT             Agoda
                    (No commission)  (OTA keeps 15%)  (OTA keeps 20%) (OTA keeps 18%)
                    ---------------  ---------------  --------------- ---------------
BAR                 Guest pays       Guest pays       Guest pays      Guest pays
Best Available      Rs 5,000         Rs 5,000         Rs 5,000        Rs 5,000
Base rate           You keep         You keep         You keep        You keep
Refundable          Rs 5,000  GREEN  Rs 4,250  GREEN  Rs 4,000  AMBER Rs 4,100  AMBER

NRF                 Guest pays       Guest pays       Guest pays      Guest pays
Non-Refundable      Rs 4,500         Rs 4,500         Rs 4,500        Rs 4,500
10% off base        You keep         You keep         You keep        You keep
Non-refundable      Rs 4,500  GREEN  Rs 3,825  AMBER  Rs 3,600  AMBER Rs 3,690  AMBER

LSTAY               Guest pays       Guest pays       Guest pays      Guest pays
Long Stay           Rs 4,250         Rs 4,250         Rs 4,250        Rs 4,250
15% off base        You keep         You keep         You keep        You keep
Refundable          Rs 4,250  GREEN  Rs 3,612  AMBER  Rs 3,400  RED   Rs 3,485  AMBER
```

### How to read each cell

- **Guest pays** = the price the OTA will display on its search page. Same across all OTAs for the same rate plan — that is required by OTA contracts (rate parity).
- **You keep** = what is actually yours after the OTA takes its cut.
- **Colour code**:
  - **Green** >= 95% margin retained — great channel for that plan
  - **Lime** >= 85% — good
  - **Amber** >= 78% — acceptable, watch it
  - **Red** < 78% — thin margin, consider raising the rate

### What it answers

- "If I create a NRF plan at 10% off, what will I actually net on Booking.com?"
- "Is it worth listing on Agoda? They take 18%."
- "Should I push the LSTAY plan to Direct only?"
- "What is my real margin on this MMT booking?"

The card recomputes instantly when you:
- Change a room's base rate
- Edit any rate plan's discount %
- Edit any OTA's commission %
- Enable / disable a channel

No save button — it is always the latest math.

---

## 11. What can go wrong, and how we recover

### 11.1 OTA's server is down when we try to push an update

**What happens:** queue row marked `failed`. Worker schedules retry in 30 seconds. If the OTA is still down, retries continue at 2 min -> 10 min -> 1 hr -> 6 hr intervals. After 5 failures, status becomes `permanently_failed`.

**Operator action:** look at "Updates waiting to reach OTAs" panel. For each stuck row, you can:
- Click **Retry** — resets counter, tries immediately
- Click **Dismiss** — gives up, removes from queue (e.g. if the change has been superseded)

### 11.2 OTA sends us a webhook with a bad signature

**What happens:** we reject with HTTP 401. Booking is NOT stored. The webhook log shows the attempt with status `signature_invalid`.

**Operator action:** check the OTA's extranet — has the webhook signing secret been rotated? If yes, copy the new one into Channel Credentials.

### 11.3 Two OTAs send the same booking at the same time (race)

**What happens:** the second one fails the overlap check and gets rejected with HTTP 409. It is logged for manual triage — you decide which booking wins and contact the losing OTA to cancel.

This is rare with proper outbound sync but can happen if both OTAs are showing your room when the very first guest clicks. The Channel Manager guarantees data integrity (no double-bookings in our DB) but you may need to apologise to one of the two guests.

### 11.4 Same booking sent twice (replay attack or network retry)

**What happens:** replay protection table catches it (timestamp + nonce). HTTP 409 returned, no duplicate booking created.

**Operator action:** none — system handles automatically.

### 11.5 Local booking exists but OTA did not record it (or vice versa)

**What happens:** caught by the 3:15 AM daily reconciliation cron. Report appears in "Daily double-check" panel with status `mismatch` and counts in `missing_in_local` / `missing_in_remote`.

**Operator action:** open the report, see the specific booking IDs, log into the OTA extranet to investigate. Usually it is:
- A test booking the OTA made and did not tell us about -> we add or ignore
- Our webhook receiver was down briefly -> we replay from the OTA's reservation export
- A timing race on the OTA's side -> it will match on the next day's run

### 11.6 Someone tries to send a fake booking from a random IP

**What happens:** if you have configured the IP allowlist for that channel, HTTP 403 returned with no booking processed. The attempt is logged.

**Operator action:** none if allowlist is set. Periodic review of webhook log to catch any blocked legitimate IPs (e.g. OTA changed their network).

---

## 12. Security — how we keep bad actors out

Four layers, in order:

### Layer 1: HTTPS everywhere
All traffic uses TLS. No webhook is accepted over plain HTTP.

### Layer 2: HMAC signature verification
Every incoming webhook must be signed with the OTA-specific signing secret (different from the API secret). Algorithms vary per OTA:
- Booking.com: SHA-256, header `X-Booking-Signature`
- MMT / Goibibo: SHA-256, header `X-MMT-Signature`
- Agoda: SHA-1, header `X-Agoda-Auth`
- Expedia: SHA-256, header `Authorization: Bearer <sig>`
- Airbnb: SHA-256, header `X-Airbnb-Signature`

If signature verification fails -> HTTP 401, no booking stored, attempt logged.

### Layer 3: Replay protection
The signed payload includes a timestamp + a random nonce. We store every (channel, nonce) for 24 hours. Same nonce twice -> HTTP 409, ignored.

This prevents an attacker who intercepted a valid webhook from replaying it later to create duplicate bookings.

### Layer 4: IP Allowlist (optional, recommended for high-volume properties)
Per-channel CIDR ranges. Set environment variables on the server:

```
CHANNEL_IP_ALLOWLIST_BOOKING=141.0.176.0/24,141.0.177.0/24
CHANNEL_IP_ALLOWLIST_MMT=203.92.36.0/24
```

Atithi-Setu reads these on startup; any webhook arriving from a non-matching IP gets HTTP 403 even before HMAC verification.

**Default is permissive** (no env set = accept any IP, just log the source) so it never accidentally blocks an OTA after a network change. Lock down only when your IT team is ready to monitor and update.

### Credentials at rest
Every API key, secret, and webhook signing key is encrypted with **AES-256-GCM** before being stored in the database. The encryption key (`CHANNEL_CRED_KEY`) is itself an environment variable, never committed to code. Even if the database is leaked, the OTA secrets are unreadable.

---

## 13. Daily double-check (reconciliation)

Runs automatically at **3:15 AM IST every night** for every hotel tenant.

### What it does

For each enabled OTA channel:
1. Call the channel's `pullBookings(since=24h ago)` API
2. Receive a list of all reservations that OTA has for the property
3. Compare against `room_bookings WHERE booking_source = channel AND check_in_date >= since`
4. Count:
   - **local_count** = how many we have
   - **remote_count** = how many they have
   - **missing_in_local** = they have, we do not (we will double-book!)
   - **missing_in_remote** = we have, they do not (they will resell the room!)
5. Insert a row into `channel_reconciliation_reports` with `status` = `ok` / `mismatch` / `stub` / `error`

### What "stub" means

Most OTAs require a formal partner-API approval before they will give us their reservation-export endpoint. Until that approval lands, our adapter for that channel returns `stub: true` and the reconciliation report shows `status='stub'` — telling you "we tried but could not pull data; this is not a real mismatch."

Workflow: as each partner approves us, we swap the stub for real `pullBookings` code and the status auto-flips to `ok` / `mismatch`. No code change needed by you.

### What to do when status = mismatch

1. Open the report row in "Daily double-check"
2. See exactly which booking IDs are missing on which side
3. Cross-check in the OTA's extranet
4. Resolve: re-trigger the missing webhook (rare — usually a brief outage), or manually create the missing booking
5. Next night's report should show `ok`

---

## 14. Channel Manager tab — section by section

When the owner opens **Channel Manager** in the top nav, they see (top to bottom):

### Section 1 — Header + 60-second explainer
Plain-English subtitle. Amber card explaining the 3-step booking flow with emojis. Sets context for everyone — first-time owner or returning power-user.

### Section 2 — KPI strip (4 cards)
- **OTAs Connected** — N enabled / total
- **Earned in 30 days** — net Rs after commission
- **OTAs took** — gross commission Rs paid in 30 days
- **Pipeline Health** — green check / "X sending" / "X stuck"

At-a-glance "is everything OK?" answer in under 2 seconds.

### Section 3 — Live Rate Card (headline view)
The big emerald-bordered table. Per room category, a grid of (rate plans x channels) showing guest price + net to hotel + colour-coded margin.

This is the section the owner returns to multiple times a day.

### Section 4 — How bookings reach us
Three sub-sections in one card:
- **Inbound iCal feeds**: add / edit / delete URL per room per channel; manual sync button
- **Webhook activity**: recent inbound webhook log (verified/invalid/replayed)
- **OTA API credentials**: list of channels with their commission %, masked secrets, edit/delete

### Section 5 — What each OTA cost you (last 30 days)
Commission summary table by channel: bookings, gross, avg %, commission paid, net received.

### Section 6 — Pricing options you offer
Rate plans editor. Default 4 plans seeded; add/edit/deactivate. Each plan shows code, name, refundable, discount %, min/max nights, active toggle.

### Section 7 — Updates waiting to reach OTAs
Outbound sync queue inspector. Per-row Retry / Dismiss buttons. Status badges colour-coded:
queued (blue) · failed (amber) · permanently_failed (red) · dismissed (grey) · success (green).

### Section 8 — Daily double-check
Reconciliation reports. Last 60 days. "Run now" button (admin only) for ad-hoc runs.

### Section 9 — OTA gatekeeper
Read-only display of IP allowlist per channel. Shows which channels are "Open" (permissive) vs "Locked". Tells operator the exact env var to set + that a server restart is needed.

---

## 15. Frequently asked questions

**Q: We only use Booking.com. Do we need all this?**
A: No. The Channel Manager scales to whatever you use. Configure just Booking.com and the other channel slots stay empty — the Live Rate Card simply shows fewer columns.

**Q: What if an OTA changes its commission overnight?**
A: Update it in Channel Credentials. All FUTURE bookings will use the new %. Historical bookings keep their snapshot — past reports stay accurate.

**Q: I changed a room price. How long until it shows on Booking.com?**
A: Via webhook push: usually under 1 minute. Via iCal pull: up to 30 minutes (the OTA polls our export endpoint). For the avoidance of double-booking, the AVAILABILITY change (room is gone) is what matters and happens in seconds — the new rate is a "soft" update.

**Q: Do guests see different prices on different OTAs?**
A: NO. Rate parity (same price on every OTA for the same rate plan) is required by most OTA contracts. The Live Rate Card enforces this — guest price is the same column-to-column for any given rate plan row. Only the commission (and therefore your net) differs.

**Q: Can I sell my room cheaper on my own website?**
A: Yes, that is standard practice and legal (Member rates, loyalty discounts). What you generally CANNOT do is sell cheaper on one OTA than another. Use the MEMBER rate plan for direct-only discounts.

**Q: What if Booking.com sends us a booking but does not pay us?**
A: They will. They invoice monthly. The commission summary lets you cross-check: their invoice should match our "Commission" column within a few rupees. Disputes are easy to raise with our data.

**Q: How do I add a new OTA we just signed up with?**
A: Go to Channel Manager -> click **Add Channel** -> fill in their credentials + commission %. Add an iCal feed URL while you wait for their full API to be approved. Done.

**Q: An OTA is showing wrong availability on their side, even though our system is correct. What do we do?**
A: First, check the outbound queue — there may be a stuck `permanently_failed` row. Click Retry. If the queue is clean but the OTA is still wrong, contact them with the reconciliation report from "Daily double-check" — it is evidence of the discrepancy.

**Q: How secure is this? Could someone fake bookings?**
A: Four layers of defense (see Security section). To fake a booking an attacker would need to: (a) bypass HTTPS, (b) know the per-channel HMAC signing secret, (c) provide a unique nonce, and (d) come from an allowed IP if you have enabled the allowlist. All four together is virtually impossible.

**Q: What if our internet goes down?**
A: Webhooks the OTA sends during the outage are lost (most OTAs do not retry). The 3:15 AM reconciliation will catch the missed bookings within 24 hours. For high-volume properties we recommend setting up a backup notification email so OTAs can also notify you out-of-band.

**Q: Can I see what every OTA is showing in real time?**
A: The Live Rate Card shows what they WILL show (computed from your current rates + their commission). For what they ACTUALLY show right now, log into each OTA's extranet — that is a separate question (parity monitoring) we can build if useful.

---

## 16. Glossary

| Term | Meaning |
|---|---|
| **ARI** | Availability, Rates, Inventory — the three things every OTA needs from us |
| **BAR** | Best Available Rate — refundable standard rate |
| **Channel Manager** | Software that distributes ARI to multiple OTAs from one place (this product) |
| **CIDR** | A way to write IP ranges (e.g. `141.0.176.0/24` = all IPs from 141.0.176.0 to 141.0.176.255) |
| **Commission** | The percentage the OTA keeps from each booking |
| **CRS** | Central Reservation System — another name for the booking database |
| **Direct booking** | Booking placed on the hotel's own website / phone — 0% commission |
| **Extranet** | The OTA's admin panel where the hotel manages its listing |
| **HMAC** | Hash-based Message Authentication Code — a cryptographic stamp proving a message was not faked |
| **iCal** | A calendar file format (`.ics`) every OTA can export — works as a universal sync method |
| **Inventory** | The room nights you have available to sell |
| **LSTAY** | Long Stay rate plan — discount for 5+ night stays |
| **MEMBER** | Member rate plan — loyalty discount |
| **Net rate** | What you keep after commission |
| **Nonce** | A one-time random string used to prevent replay attacks |
| **NRF** | Non-Refundable rate plan — discounted but no cancellation refund |
| **OTA** | Online Travel Agency — Booking.com, MMT, Agoda, etc. |
| **PMS** | Property Management System — the hotel's core operations software (Atithi-Setu is one) |
| **Rate Parity** | The contractual requirement that the same room shows the same price on every OTA |
| **Rate Plan** | A "way of selling" the same room — different cancellation terms or discount |
| **Reconciliation** | Daily check that our records match the OTA's records |
| **Replay attack** | Re-sending an old valid message to fake a new event |
| **TLS / HTTPS** | Encrypted internet transport — protects data in flight |
| **Webhook** | Real-time HTTP POST from one system (OTA) to another (us) when an event happens |

---

## Document control

- **Owner:** Atithi-Setu Product
- **Last updated:** 2026-06-08
- **Build marker at time of writing:** `channel-mgr-friendly-redesign-with-live-rate-card`
- **Related docs:** `docs/OTA_INTEGRATION_AUDIT.md` (technical gap audit, internal)
