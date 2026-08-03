# Checklist Trigger Map — End-to-End (Rooms & Event Halls)

_Atithi-Setu · exactly which checklist fires at every step of a booking, from creation to
checkout — traced from `server.ts` and proven by `test-scripts/e2e_checklists.mjs`._

This is the companion "what fires when" reference to the [Checklist User Manual](CHECKLIST_USER_MANUAL.md).
Every row below is a real trigger point in the code; the **Test** column names the automated
e2e case that proves it.

**Legend** — **Blocking?** = does this checklist ever stop the business operation?
Only **check-in** and **check-out** (rooms) and **event-complete** (halls) can block, and only
when the owner's enforcement setting is on. Everything else is raised for visibility only.
A trigger raises a checklist **only if an _active_ template is configured for it** — no template,
no checklist, and nothing is ever blocked.

---

## A. Hotel room — booking → checkout

```
CREATE ─► BOOKING_NEW                                  (+ CHECK_IN attached early, if enforced)
ASSIGN ─► BOOKING_ASSIGNED
CHECK-IN ─► [gate: CHECK_IN mandatory tasks] ─► room OCCUPIED
            └─► ROOM_OCCUPIED · CHECK_OUT (planned) · MID_STAY (scheduled, if >1 night)
NIGHTLY (05:00 IST cron) ─► DAILY · MID_STAY (overstay) · CLEANING (guest cadence) · overdue reminders
CHECK-OUT ─► room CLEANING ─► CHECK_OUT (blocking, holds room) · ROOM_CLEANING
COMPLETE CHECK_OUT checklist ─► room VACANT (once no other blocking job remains)
```

| # | Step (endpoint) | Trigger(s) raised | Facility | Blocking? | Test case |
|---|---|---|---|---|---|
| 1 | **Create booking** `POST /hotel/bookings` | `BOOKING_NEW` | ROOM | No | `E2E-BOOKING-NEW` |
| 1b | …same call, if `checklist_validate_on_checkin=1` and status BOOKED/ASSIGNED | `CHECK_IN` **attached early** (so the desk can prep before arrival) | ROOM | Not yet — attached only | `E2E-CHECKIN-EARLY` |
| 2 | **Assign / reassign room** `POST /hotel/bookings/:id/reassign-room` | `BOOKING_ASSIGNED` | ROOM | No | _(code path; not in e2e)_ |
| 3 | **Change room status** on Status Board `PATCH /hotel/rooms/:id/status` | `ROOM_VACANT` / `ROOM_OCCUPIED` / `ROOM_CLEANING` / `ROOM_MAINTENANCE` / `ROOM_BLOCKED` | ROOM | No | _(code path; not in e2e)_ |
| 4 | **Check-in** `POST /hotel/bookings/:id/checkin` — the gate | `CHECK_IN` (raised idempotent; **409 until every mandatory task is done** when enforced; auto-completed on success) | ROOM | **Yes** (when enforced) | `E2E-CHECKIN` |
| 4b | …check-in succeeds → room flips **OCCUPIED** | `ROOM_OCCUPIED` | ROOM | No | `E2E-ROOM-OCCUPIED` |
| 4c | …and the rest of the stay is planned | `CHECK_OUT` (planned ahead), `MID_STAY` (scheduled if stay > 1 night) | ROOM | `CHECK_OUT` blocking when enforced | `E2E-MIDSTAY` |
| 5 | **Nightly cron** (05:00 IST) `runTenantScheduledChecklists` | `DAILY` (per room), `MID_STAY` (overstay, at owner cadence), `CLEANING` (at the guest's per-booking cadence) + overdue reminders | ROOM | No | `E2E-MIDSTAY`, `E2E-CLEANING`, `E2E-OVERDUE-SWEEP` |
| 6 | **Check-out** `POST /hotel/bookings/:id/checkout` → room flips **CLEANING** | `CHECK_OUT` (blocking when enforced — **holds the room**), `ROOM_CLEANING` | ROOM | `CHECK_OUT` **Yes** (when enforced) | `E2E-CHECKOUT`, `E2E-ROOM-CLEANING` |
| 7 | **Complete the check-out checklist** `POST /housekeeping/jobs/:id/complete` | _(no new trigger)_ — room releases to **VACANT** once no other blocking job remains | ROOM | — | `E2E-GATING` |

**Enforcement switches** (Hotel → Settings → Business Rules):
- `checklist_validate_on_checkin` (default **on**) — step 4 gate. Off ⇒ `CHECK_IN` still raised, never blocks.
- `checklist_validate_on_checkout` (default **on**) — step 6 hold. Off ⇒ `CHECK_OUT` still raised but forced **non-blocking**; room releases freely. Proven by `E2E-CO-SETTING` + `E2E-CO-NONBLOCK`.

**Cleaning cadence** — the check-in wizard captures the guest's preference
(`cleaning_frequency_nights`: 1 = daily, 2 = every 2 nights, 0 = none); the nightly cron raises
`CLEANING` accordingly, skipping the departure day.

---

## B. Event hall — booking → completion ("checkout")

An event hall's "checkout" is **marking the event complete**. That raises the blocking
`EVENT_COMPLETE` cleaning checklist, which then **gates the next event's confirmation** on the
same venue until the hall is cleaned — the hall equivalent of a room being held in CLEANING.

```
CREATE event booking ─► (no checklist)
STATUS BOARD flip ─► VENUE_<status>
CONFIRM booking ─► [gate: venue must have no open cleaning checklist from a prior event]
COMPLETE event ("checkout") ─► EVENT_COMPLETE (blocking — holds the venue)
NIGHTLY (05:00 IST cron) ─► DAILY (per venue)
next CONFIRM ─► blocked until the EVENT_COMPLETE checklist is done ─► then venue frees
```

| # | Step (endpoint) | Trigger(s) raised | Facility | Blocking? | Test case |
|---|---|---|---|---|---|
| 1 | **Create event booking** `POST /events/bookings` | _(none — halls have no create-time checklist)_ | EVENT | — | — |
| 2 | **Change hall status** on Status Board `PATCH /events/venues/:id/status` | `VENUE_VACANT` / `VENUE_OCCUPIED` / `VENUE_CLEANING` / `VENUE_MAINTENANCE` / `VENUE_BLOCKED` | EVENT | No | `E2E-VENUE-STATUS` |
| 3 | **Confirm booking** `POST /events/bookings/:id/confirm` — the gate | _(no trigger raised)_ — **refused (409) if the venue still has an open blocking cleaning checklist** from a previous event; a manager can `override_cleaning` | EVENT | **Yes** (reads existing blocking job) | `E2E-EVT-GATE` |
| 4 | **Complete event** `POST /events/bookings/:id/complete` (the "checkout") | `EVENT_COMPLETE` — the "Event Hall · Check-Out" system template (blocks_release = 1) | EVENT | **Yes** — holds the venue | `E2E-EVT-COMPLETE` |
| 5 | **Nightly cron** (05:00 IST) | `DAILY` (per venue) | EVENT | No | `E2E-DAILY-HALL` |
| 6 | **Complete the `EVENT_COMPLETE` checklist** | _(no new trigger)_ — venue frees; the next event confirms | EVENT | — | `E2E-EVT-RELEASE` |

> Confirming a booking does **not** automatically flip the hall to OCCUPIED, and completing it
> does not auto-flip it to CLEANING — the hall status field is driven by the **Status Board**
> (step 2). The *release gate* is driven purely by the open blocking `EVENT_COMPLETE` job, not
> by the status field.

---

## C. The one rule that keeps operations safe

`resolveTemplatesForTrigger` filters on `is_active = 1`, and only `blocks_release = 1` jobs gate.
So:

- **No active template for a trigger ⇒ no checklist ⇒ nothing blocked.**
- **Deactivating a template** (Checklist Templates → Deactivate) instantly stops it firing.
- Only **check-in**, **check-out**, and **event-complete** can ever block — and only while their
  owner enforcement setting is on. Booking-lifecycle and every status trigger are always
  non-blocking.

---

## D. Running it

The e2e is a **live-tenant** walk-through — it needs owner credentials and runs against the
deployed API (default `RESTO-1003` @ `https://erp.atithi-setu.com`). It is self-cleaning.

```bash
run-checklist-e2e.bat
```

or directly:

```bash
OWNER_EMAIL=you@example.com OWNER_PASSWORD=secret RESTAURANT_ID=RESTO-1003 node test-scripts/e2e_checklists.mjs
```

A green run (0 failures) confirms every step above fires the right checklist and that the
blocking gates hold and release correctly. Steps marked _"code path; not in e2e"_ (room reassign,
manual room-status flips) are live in the product but exercised via the UI rather than this script.
