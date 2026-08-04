# Validation Report — PMS (Hotel) + Events + Checklist (E2E)

**Prepared as:** Senior Validation Lead engagement
**Scope:** All end-to-end business scenarios of the Hotel/PMS module, the Events & Convention Center module, and the Configurable Checklist engine that wires into both.
**System:** Atithi-Setu ERP · prod `https://erp.atithi-setu.com` · test tenant `RESTO-1003`.
**Method:** As-built code trace (server.ts / eventsService.ts / src) + automated-suite coverage assessment. Runtime execution against prod is performed by the owner via `run-tests.bat` / `run-checklist-e2e.bat` (the sanctioned path — this engagement cannot mint prod credentials).

---

## 1. Verdict summary

| Module | E2E flow integrity | RBAC | Money / GST | Checklist wiring | Overall |
|---|---|---|---|---|---|
| **Hotel / PMS** | ✅ Complete & guarded | ⚠️ Gaps (2 High) | ⚠️ 2 items to verify | ✅ Correct | **PASS with conditions** |
| **Events** | ✅ Complete | ⚠️ Gaps (reads open; override) | ✅ per-line GST | ✅ Correct | **PASS with conditions** |
| **Checklist engine** | ✅ Correct & safe | ✅ Correctly gated | n/a | ✅ Invariants hold | **PASS** |

**Headline:** The three modules are functionally end-to-end complete and the checklist gating invariants (only *active* templates fire; only `blocks_release=1` jobs hold a facility) are upheld in code. The findings below are **not flow-breakers** — they are RBAC-granularity gaps, two revenue-integrity gaps (group checkout, event cancel), and tax/edge items to verify. None should block use; the High items should be triaged for a remediation sprint.

**Biggest validation concern (verify first):** the **blocking check-in gate (feature #254) is not proven** by the current regression suite — the existing e2e checks a guest in directly and passes, which only holds if `checklist_validate_on_checkin` is OFF on the tenant *or* the gate is not enforcing. A new test (`E2E-CHECKIN-GATE`) has been added that forces the setting on and asserts the 409. **Run it to confirm the gate actually blocks.**

---

## 1a. Remediation applied (this engagement)

All four High findings were remediated in `server.ts`; gated with `tsc --noEmit` + `vite build` (both clean). **Must be verified live** by running the suites (compile alone is not sign-off).

| ID | Fix shipped |
|---|---|
| **F-P02** | Document-upload route now carries `hotelStaff` + `requireTabAction('HOTEL_BOOKINGS','CREATE')` before multer — no more unauthenticated PII upload. |
| **F-P05** | Group checkout now **sweeps unpaid room F&B** onto each child folio before allocation/settle, and **raises the per-child CHECK_OUT cleaning checklist** (mirrors single checkout). *(The single-checkout hard 409 outstanding-gate was intentionally NOT added — group checkout is a settle-all-now batch; the sweep closes the actual revenue leak.)* |
| **F-E04 / F-E03** | Event cancel now **cancels the hotel bookings** made on confirm, **reverses the revenue GL + voids the EVENT folio** when invoiced, and is **idempotent** (already-cancelled → no-op, no double-reversal). Collected advances are intentionally left as a `2100` liability pending a separate refund flow. |
| **F-P01** | Core booking-lifecycle mutations (create→CREATE; checkin/checkout/cancel/patch/doc-delete→UPDATE; doc-upload→CREATE) now enforce action-level tab permissions. Lockout-safe: `FRONT_DESK`/`CONCIERGE` are seeded `HOTEL_BOOKINGS:2` and `perms===null` still fails open; only a role explicitly restricted to view-only is (correctly) blocked. **Follow-up (not done):** the ~30 remaining hotel/folio/group mutation routes still use READ-level `requireTabAccess`; apply the same verb sweep in a dedicated pass (mechanical, but run the suite to confirm no lockouts). ROOMS status PATCH deliberately left at READ (front-desk seeded `ROOMS:1`). |

**Tests added to close coverage gaps:** `e2e_checklists.mjs` → `E2E-INACTIVE`, `E2E-CHECKIN-GATE`/`-PASS`. `run_technical_tests.mjs` → `TC-BIZ-BOOK-PASTDATE`, `TC-CHK-MIDSTAY-REQ`, `TC-EVT-INQUIRY`, `TC-EVT-CANCEL` (also exercises the F-E04/F-E03 idempotency). Still open (specified, not automated): `TC-CHK-PRECEDENCE` (assignment precedence), event checkout→invoice GST math, group-checkout money math.

---

## 2. E2E scenario matrix — Hotel / PMS

Legend: ✅ works & guarded · ⚠️ works, finding attached · 🔎 needs runtime confirmation.

| # | Scenario | Endpoint (server.ts) | Status transition | Guards proven in code | V |
|---|---|---|---|---|---|
| H1 | Create booking (direct / floating / group) | `POST /hotel/bookings` :29392, group :29808 | → `BOOKED`; room→assigned | name required; past-date 400; capacity/occupancy; overlap 409; rate compute | ✅ |
| H2 | Booking edit pre-checkin | `PATCH /hotel/bookings/:id` :35670 | — | re-validates; recomputes total | ✅ |
| H3 | Lock after check-in/out | same :35703–35741 | — | `LOCKED_AFTER_CHECKIN` → 409 on billing/guest fields; only `special_requests` open | ✅ |
| H4 | ID docs + immutability | `POST/DELETE …/documents` :36440/:36521 | — | ≥1 doc gate (owner flag); post-checkin lock; MIME/size | ⚠️ F-P02 |
| H5 | Check-in | `POST …/checkin` :35985 | → `CHECKED_IN`, room→`OCCUPIED` | phone req; ID gate; Form-C; early-checkin; **CHECK_IN checklist 409**; atomic flip | 🔎 F-V01 |
| H6 | In-stay F&B → folio | `postOrderToFolio` :2048 | folio entries | idempotent; cancelled never post; F&B GST slab | ✅ |
| H7 | Mark-paid-in-room | `POST …/restaurant-bill/mark-paid` :38590 | excludes/reverses folio | reverses if already posted | ✅ |
| H8 | Service request → folio + GST | `confirm-bill` :32058; `reapplyHotelGstRates` :4157 | SERVICE entry | GST applied at settlement | ⚠️ F-P03 / F-P04 |
| H9 | Checkout (single) | `POST …/checkout` :36557 | → `CHECKED_OUT`, room→`CLEANING` | F&B sweep; outstanding 409; settle+GL; CHECK_OUT checklist raised | ✅ |
| H10 | Invoice (itemized, per-night GST, round-off) | :36824–36890 | — | per-night ROOM_CHARGE slab; sequence #; round-off at render | 🔎 F-P-GST |
| H11 | Room release gating | `PATCH /hotel/rooms/:id/status` :26298 | `CLEANING`→`VACANT` | only `blocks_release=1` holds; manager closes ALL | ✅ |
| H12 | Post-checkout lock | :35699 / :36540 | — | finalized → 409 everywhere | ✅ |
| H13 | Group checkout / consolidated invoice / cancel | :34537 / :34415 | children settle; group invoice | proportional discount; one invoice # | ⚠️ **F-P05** |

## 3. E2E scenario matrix — Events

| # | Scenario | Endpoint | Status transition | Guards | V |
|---|---|---|---|---|---|
| E1 | Module enable + masters | `POST /events/enable` :22782; venues/rentals/services/catering CRUD | flag `events_enabled` | SUPER_ADMIN/CTO enable; tab gates on mutations | ✅ |
| E2 | Public inquiry | `POST /public/…/events/inquiry` :26067 | → `INQUIRY` | name/phone/date only | ⚠️ F-E07 |
| E3 | Booking + editable lines + venue availability | `POST /events/bookings` :23555; `GET /events/availability` :23194 | `INQUIRY`→… | venue/block conflict (CONFIRMED/IN_PROGRESS only); min-margin on discount | ⚠️ F-E06 |
| E4 | Hotel-rooms bridge (quote-read + book-on-confirm) | :24070 / `confirm` :24213 | rooms `QUOTED`→`BOOKED` | posts real hotel bookings | ⚠️ F-E05 |
| E5 | Catering → lines → quote/invoice | `insertEventLines` :23285 | — | snapshots menu/description; GST 5% | ✅ |
| E6 | Quotation generate/PDF/email | :24324 / :24405 / :24504 | booking→`QUOTED` | versioned; `%PDF` verified in TC-EVT-011 | ✅ |
| E7 | Payment schedule + receipts + GL | schedule :23721; payments :23832 | schedule DUE→PAID | posts advance GL; petty-cash mirror; reverse on delete | ✅ |
| E8 | Completion → EVENT_COMPLETE checklist + confirm gate | `complete` :24029; gate :24229 | → `COMPLETED` | blocking HK job holds venue; override honored | ⚠️ F-E01 |
| E9 | Checkout → EVENT folio → invoice | `checkout` :24529 | → `IN_PROGRESS`; folio `EVENT` | invoice `EVT-YYYY`; revenue GL 4050 | ✅ |
| E10 | Cancellation + reversal | `cancel` :23701 | → `CANCELLED` | reason/note + audit | ⚠️ **F-E04 / F-E03** |

## 4. E2E scenario matrix — Checklist engine

| # | Scenario | Where | Verdict |
|---|---|---|---|
| C1 | Categories → templates → steps → assignments CRUD | `/checklists/*` :22253–22497 | ✅ owner-gated |
| C2 | Trigger resolution (most-specific tier wins) | `resolveTemplatesForTrigger` :21892 | ✅ ROOM > ROOM_TYPE > VENUE > type-default |
| C3 | Triggers fire at the right lifecycle points | CHECK_IN/OUT/MID_STAY/DAILY/EVENT_COMPLETE/MANUAL | ✅ mapped, all funnel through resolve |
| C4 | **Only ACTIVE templates fire** | every tier filters `is_active=1` :21896–21903, :21963, cron precheck :21994 | ✅ **invariant holds** |
| C5 | **Only `blocks_release=1` holds a facility** | `hasOpenHousekeepingJob` :21982; `releaseFacility` :2182; room gate :26312; event gate :24229 | ✅ **invariant holds** |
| C6 | Manager override closes ALL blocking room jobs | :26316 | ✅ |
| C7 | MID_STAY requires recurrence | validation :22359 | ✅ (add test) |
| C8 | Workflow (Draft/Assigned/Complete), My Checklist, Board, audit | :22633 / :22556 / :22689 / `writeObjectAudit` | ✅ |
| C9 | Category module-scoping (PMS→ROOM, Event→EVENT) | :21885; frontend `catInScope` | ✅ |

---

## 5. Findings & risk register

Severity = business impact. Confidence = how certain from static code (High = provable from the cited lines; Med = plausible, needs a runtime or intent check).

### High
| ID | Area | Finding | Evidence | Impact | Confidence |
|---|---|---|---|---|---|
| **F-P01** | PMS RBAC | Hotel **mutations are gated at READ tab-level**, not CREATE/UPDATE/DELETE. `requireTabAccess(tab)` = `requireTabAction(tab,'READ')`. A role with only *View* on `HOTEL_BOOKINGS` can still create bookings, check-in, check-out, delete docs. | `server.ts:5172`, all hotel routes | The per-tab Edit/Delete granularity the Staff-Access UI advertises is **not enforced** server-side; `hotelStaff` role-class is the only real gate. | High |
| **F-P02** | PMS RBAC / PII | **Document upload lacks the hotel RBAC + tab gate** — `POST …/documents` is `authenticate` + multer only (siblings have `hotelStaff, requireTabAccess`). Also no `ensureHotelEnabled`. | `server.ts:36440` | Any authenticated tenant user (CHEF/WAITER) can upload guest **ID documents**. | High |
| **F-P05** | PMS revenue | **Group checkout skips the F&B sweep, the outstanding-balance 409 gate, and the per-child CHECK_OUT checklist** that single checkout enforces. | `server.ts:34537`, cf. single :36643/:36679/:36712 | A group can be checked out with **unposted room F&B** or an **unpaid balance**; group rooms flip to CLEANING possibly **without a release-blocking cleaning job**. Revenue leakage + housekeeping gap. | High |
| **F-E04** | Events integrity | **Cancellation does no financial/hotel unwind.** `cancel` never reverses `EVENT_SETTLEMENT` revenue GL / voids the EVENT folio, never reverses posted advance GL (2100) or petty-cash mirror, and never cancels the real **hotel bookings** created on confirm. | `server.ts:23701` vs :24255/:24572 | Cancelling a confirmed/invoiced event leaves **live hotel room bookings**, orphaned advance/revenue GL, and an open EVENT folio. "Cancellation + GL reversal" is only partially implemented (reversal exists for payment-delete only). | High |

### Medium
| ID | Area | Finding | Evidence | Confidence |
|---|---|---|---|---|
| **F-V01** | PMS / Checklist | **Blocking check-in gate (#254) unproven.** Existing e2e checks in directly and passes → gate is either off on the tenant or not enforcing. | `server.ts:36089`; `e2e_checklists.mjs:193` | Med — new `E2E-CHECKIN-GATE` will confirm |
| **F-P03** | PMS GST | Service-request GST settles on the **room-tariff slab (0/12/18)**, not the F&B 5/18 slab (M-3's stated intent). A ₹500 service → 0% GST. | `server.ts:4157`, :32089 | Med — confirm intended M-3 behavior |
| **F-P04** | PMS data | `confirm-bill` inserts folio_entries with a **different column shape** (`entry_type='SERVICE'`, `total`, `posted_at`) than every other insert; no defensive ALTER. May throw on some schemas or be excluded from GST/report aggregations. | `server.ts:32090` | Med |
| **F-P06** | PMS money | `recordFolioPayment` failures at check-in/checkout are **swallowed** (console.warn, non-fatal). A silently-failed advance/final payment overstates collections. | `server.ts:36228`, :36671 | Med |
| **F-P07** | PMS concurrency | Booking-create overlap check is **not transactional** — two concurrent POSTs for the same room/dates can both pass the overlap SELECT before either INSERT (no unique constraint/row lock shown). | `validateBookingRequest` :2914 | Med |
| **F-E01** | Events RBAC | `override_cleaning` on event confirm is **not role-enforced** — any `eventsStaff` (FRONT_DESK/CASHIER/…) can bypass the housekeeping gate; the `isMgr` check only shapes the *blocked* message. | `server.ts:24232` | High (fact) / Med (intent) |
| **F-E03** | Events integrity | `cancel` and `complete` have **no status guards** — can cancel an already-COMPLETED/invoiced booking, or complete an INQUIRY never confirmed/billed. | `server.ts:23701`, :24029 | High |
| **F-E05** | Events integrity | `confirm` is **not atomic across the hotel bridge** — partial hotel-booking creation is not rolled back if a later room fails; recovery is manual. | `server.ts:24238` | High |
| **F-E06** | Events margin | Min-margin guard covers the **discount field only**, not per-line `unit_rate`/`quoted_rate` overrides → margin can go negative via rate edits. | `server.ts:23621` | High |
| **F-C01** | Checklist ops | If an owner **deactivates all CHECK_OUT templates**, checkout still flips the room to CLEANING but raises no job → no in-workflow release; the room can only be freed by a manual Status-Board flip. | `server.ts:36704` + :36716 | High |

### Low
| ID | Finding | Evidence |
|---|---|---|
| **F-E02** | All events reads (analytics/bookings/PII/financials) require only `authenticate + ensureEventsEnabled` — no tab gate. Any tenant user can read full events revenue/pipeline/customer PII. Consistent with the module's "reads open" pattern — confirm intent. | `server.ts:23345` etc. |
| **F-E07** | Public event inquiry has no rate-limit/captcha (spam/abuse vector). | `server.ts:26067` |
| **F-P08** | `amend-checkout` deletes folio nights by `description LIKE '%· <date>%'` (text match, not entry_type+date) — could sweep an unrelated line whose text contains that date. | `server.ts:35894` |
| **F-C02** | EVENT_COMPLETE has no owner enforcement toggle (asymmetric vs check-in/out); always blocks when template `blocks_release=1`. | `server.ts:24038` |
| **F-C03** | `override_cleaning` on event confirm bypasses but does **not close** the open EVENT_COMPLETE job → the next confirm on that venue is blocked again (vs room path which closes all). | `server.ts:24232` |
| **F-C04** | GENERIC templates can't be targeted by per-entity assignments (tiers join on ROOM/EVENT) — a GENERIC assignment never wins the specific tier though the UI offers it. | `server.ts:21896` |
| **F-C05** | Status triggers (ROOM_/VENUE_`<status>`) fire without dedupe → A→B→A toggling accumulates duplicate (non-blocking) jobs on the worklist. | `server.ts:26326`, :22918 |

### Confirmed-good (validated, no action)
- Checklist **`is_active` filter is enforced at every raise path** — no trigger bypasses it (cron additionally short-circuits on an active count). `server.ts:21896–21903, 21963, 21994`.
- **Release gating is uniformly keyed on `blocks_release=1`** — deactivating or using non-blocking templates can never accidentally hold a room/venue. `server.ts:21982, 2182, 26312, 24229`.
- Booking **lock-after-checkin** (`LOCKED_AFTER_CHECKIN`) is comprehensive across billing + guest fields. `server.ts:35703`.
- Events **booking/quote/invoice totals are computed by the same helper** (`computeEventBill` ≡ `assembleEventQuoteLines`) so they cannot diverge.

---

## 6. Automated coverage & what was added

**Suites:** `test-scripts/run_technical_tests.mjs` (~139 cases; last run 128✅/0❌/11 skip) + `test-scripts/e2e_checklists.mjs` (room + hall lifecycle trigger/gating walk-through). Both self-cleaning, owner-login against `RESTO-1003`.

**Added this engagement (`e2e_checklists.mjs`):**
- `E2E-INACTIVE` — deactivate a DAILY template, run the scheduler, assert **no job raised** (closes the "inactive template must not fire" gap).
- `E2E-CHECKIN-GATE` / `E2E-CHECKIN-GATE-PASS` — force `checklist_validate_on_checkin=ON`, assert check-in is **refused 409 `checklist_incomplete`** while a mandatory task is pending, then **succeeds and auto-completes** once done (closes the feature-#254 gap; directly probes **F-V01**).

**Remaining test gaps to close (specified, not yet automated):**
| Gap | Suggested case | File |
|---|---|---|
| Hotel past-date block | `TC-BIZ-BOOK-PASTDATE` — create with `check_in_date` = yesterday → expect 400 | run_technical_tests |
| MID_STAY requires recurrence | `TC-CHK-MIDSTAY-REQ` — POST MID_STAY template with `recurrence_nights:0` → 400 | run_technical_tests |
| Assignment precedence | `TC-CHK-PRECEDENCE` — per-room assignment beats type-default | run_technical_tests |
| Event public inquiry | `TC-EVT-INQUIRY` — public POST → INQUIRY row created | run_technical_tests |
| Event cancel | `TC-EVT-CANCEL` — cancel → status + (once F-E04 fixed) financial unwind | run_technical_tests |
| Group checkout money math | live assertion of sweep + outstanding gate (ties to F-P05) | scripts/e2e-group-booking |

---

## 7. How to run (owner) + sign-off criteria

```bash
run-tests.bat            :: full API suite (~139 cases) → TEST_EXECUTION_REPORT.md
run-checklist-e2e.bat    :: checklist trigger + gating walk-through (now incl. E2E-INACTIVE + E2E-CHECKIN-GATE)
```
Both prompt for owner email/password (or pre-set `OWNER_EMAIL`/`OWNER_PASSWORD`); default `RESTO-1003` @ `erp.atithi-setu.com`.

**Sign-off criteria for a clean PASS:**
1. `run-checklist-e2e.bat` → **0 failed**, including the new `E2E-CHECKIN-GATE` (proves #254 actually blocks). If it fails, **F-V01 is confirmed** and the check-in gate needs fixing/enabling.
2. `run-tests.bat` → 0 failed.
3. High findings (F-P01, F-P02, F-P05, F-E04) triaged into a remediation sprint (they are not flow-breakers but are RBAC/revenue-integrity risks).

---
*Static validation only — all endpoint behaviors above are read from the cited source lines; live pass/fail is established by running the two suites with owner credentials.*
