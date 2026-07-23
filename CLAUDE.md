# Atithi-Setu — Project Specification

> ## ⚠ Engineering discipline — TEST THOROUGHLY before claiming "done"
> Hard-learned rule (16 Jun 2026): the in-room F&B → folio → checkout flow was
> reported "resolved" several times while still broken in production, because it
> was validated only with `tsc`, `vite build`, and offline **logic mirrors** —
> none of which exercise the real end-to-end integration. Going forward:
>
> 1. **Trace the WHOLE chain, not a unit.** A money/billing change isn't done
>    until you've followed it create → store → post → read → display → print.
>    Confirm each link's data actually flows (e.g. `orders.room_id` must equal
>    `folios.room_id`; `entry_type` is `F_AND_B` not `F&B`; the booking_id link
>    exists). Most bugs here were *integration* gaps between correct units.
> 2. **`tsc` + `build` + a passing logic test ≠ verified.** They prove it
>    compiles and the arithmetic is right — NOT that the feature works. Add an
>    end-to-end *simulation* test (see `qa_fnb_e2e.mjs`) that models the real
>    tables and the real call order (order POST → postOrderToFolio → checkout
>    read → cancel reversal), and assert the user-visible outcome.
> 3. **Never report a bug "fixed" you couldn't reproduce + re-verify.** If you
>    can't run the live tenant, say so explicitly and give the exact manual
>    steps + expected results for the user to confirm — don't imply it's proven.
> 4. **Prefer the robust mechanism over the fragile one.** Charge-to-room F&B
>    now posts to the folio AT ORDER TIME (idempotent), not only on a delivery
>    mark or a later sweep that can silently miss — because the fragile path
>    kept stranding charges off the bill. When a workflow depends on a human
>    action (mark delivered) or a fuzzy match (room_id only), add a
>    deterministic fallback.
> 5. **Run the full QA suite** (`qa_folio_reconciliation`, `qa_revenue_dedup`,
>    `qa_gst_exempt`, `qa_restaurant_bill`, `qa_fnb_e2e`, `qa_e2e_tariff_calculations`)
>    on any folio/billing change, and add a new `qa_*.mjs` for each new flow.

## Core Value Proposition
A comprehensive, multi-tenant **restaurant + hospitality (hotel)** management ecosystem focusing on frictionless customer/guest ordering, real-time kitchen coordination, GST-ready billing, and deep owner analytics.

## Target Customers
* **Restaurants:** Quick-Service Kiosks, Casual Dining, Specialty Coffee Shops, Cafés, Food Courts, Multi-Vendor Hubs, Dark / Delivery-Only Kitchens.
* **Hospitality:** Boutique Hotels, Resorts, Service Apartments, F&B-attached lodging properties.

---

## Key Features

### Smart Menu Management
* Dynamic pricing (half/full), dietary markers (veg/non-veg/vegan/egg), real-time availability toggles, daily-special flag.
* Image hosting on Cloudflare R2 (primary) with local-disk fallback. AI menu image generation (Google Gemini) with fallbacks (TheMealDB, LoremFlickr, Foodish).
* Four display modes for the customer-facing menu: PHOTO, CARD, COMPACT, MAGAZINE.
* Type-ahead search in invoice item-name input — both for **New On-Demand Invoice** and **Edit Invoice** modals (matches against `menu` state).

### QR Code Ordering & Postpaid Sessions
* Per-table QR codes; app-less mobile-browser ordering.
* Multi-round postpaid sessions; consolidated bill at end.
* Idempotent `request-bill` endpoint (handles double-taps and retries).
* Customer-facing GST breakdown shown both on the Request Bill button and in the Request Bill modal.

### Live Kitchen Display (KDS)
* Real-time tickets, elapsed-time tracking, chef assignment, ETA, ready-pickup alerts, FIFO queue, server-pickup confirmation.

### Real-Time Table Monitor (Command Center)
* Dark glassmorphism UI with status-color glows.
* 5-metric live stats bar (Available · Occupied · N/A · Bill Requests · Live Revenue).
* Urgent bill-alert banner, waiter assignment, status toggles, per-table elapsed timers.
* 30-second auto-refresh.

### 360° Owner Analytics
* KPI cards (Total Revenue, Today's Revenue, Total Orders, Avg Order, Paid Revenue, Avg Rating).
* Hotel KPIs (when hotel module enabled): Occupancy %, ADR, RevPAR, Ancillary, Guest Rating, Bookings.
* Daily / weekly / monthly trends, top items, peak hours, payment-method split, GST breakdown.
* CSV / Excel / PDF export.
* KPI cards use compact font (`text-2xl` / `xl:text-xl`, `whitespace-nowrap`) so amounts like `₹5,500` render in full without truncation.

### GST-Ready Billing
* Configurable per-restaurant GST percentage + enable flag.
* GST applied through every flow: customer-side QR ordering, postpaid sessions (auto-populated from restaurant settings on Request Bill), and manual / On-Demand Invoices (saved with all four fields: `discount_amount`, `service_charge_percent`, `gst_percent`, `apply_gst`).
* Multi-payment: CASH / CARD / UPI (dynamic QR + static).

### **Owner-Configurable Invoice Numbering** (per-tenant)
Three columns on `restaurants` (central DB):

| Column | Default | Purpose |
|---|---|---|
| `invoice_numbering_mode` | `'RANDOM'` | `'RANDOM'` shows `#XXXXXXXX` (last 8 chars of session_token / order id). `'SEQUENTIAL'` shows `INV-NNNN`. |
| `invoice_number_prefix` | `'INV-'` | Prefix when SEQUENTIAL. Validated against `/^[A-Za-z0-9_\-./]{1,12}$/`. |
| `invoice_yearly_reset` | `0` | When `1`, counter resets each calendar year (Asia/Kolkata). Format becomes `PREFIX-YYYY-NNNN`. |

Per-tenant `sequences` table (inside each tenant schema) stores atomic counters via PostgreSQL `INSERT … ON CONFLICT DO UPDATE … RETURNING current_value`. Sequence name `'invoice'` (continuous) or `'invoice-{year}'` (yearly reset).

Counter is shared across all invoice types — manual on-demand, prepaid orders, and postpaid sessions all draw from the same sequence so the owner sees one continuous numbering.

`display_number` is computed server-side as `invoice_number || #${id.slice(-8)}` and emitted on every invoice response — frontend uses it directly for list rows, edit modal title, and thermal print Bill ID.

Settings UI (Owner Dashboard → Brand & Settings → Invoice Numbering): segmented Random / Sequential choice + prefix text input + yearly-reset toggle, with live "Sample next invoice" preview. Save Settings shows a green "✓ Saved" banner + button state for 3 seconds so the owner has clear feedback.

### **Admin-gated Invoice Deletion** (per-tenant feature flag)
Default OFF. Only `SUPER_ADMIN` can flip the flag from the `/internal` portal. When ON, the tenant's OWNER can permanently delete invoices (incl. PRINTED) with a typing-confirmation modal (last-6 chars of invoice id + 10-char reason).

Endpoints:
* `PATCH /api/admin/restaurants/:id/invoice-delete-flag` (SUPER_ADMIN/CTO only)
* `DELETE /api/restaurant/:id/invoice/order/:orderId`
* `DELETE /api/restaurant/:id/invoice/session/:sessionId` (cascades feedback + child orders + session row)

Every deletion writes a JSON snapshot to **`central.invoice_deletion_audit`** before the row is removed, preserving a forensic record for compliance.

### Hospitality (Hotel) Module
Optional `property_type ∈ {RESTAURANT, HOTEL, BOTH}` on `restaurants`. When HOTEL or BOTH:
* Room management (status: VACANT / OCCUPIED / CLEANING / MAINTENANCE / BLOCKED), per-room QR.
* Service catalog (housekeeping, maintenance, front desk, concierge, laundry) with SLA tracking.
* Bookings, check-in/check-out, guest profile (incl. nationality + ID for foreign nationals).
* **Folios** with state-aware GST (CGST+SGST intra-state, IGST inter-state).
* **Form-C compliance** auto-PDF for foreign guests + audit log.
* **AI Concierge** (Groq-based, FAQ-grounded chatbot) with sentiment analysis on feedback.
* Hotel KPIs: ADR, RevPAR, Occupancy, Ancillary revenue %.

### Inventory Management Module (Restaurant + Cloud Kitchen)
End-to-end stock control: **catalog → recipes → auto-deduction → procurement → reconciliation → forecasting**. Module is opt-in — tenants without recipes are unaffected (orders place fine, no deduction happens, no errors logged).

**11 tenant-DB tables** (inside each `tenant_{id}` schema, idempotent `CREATE TABLE IF NOT EXISTS`):
`ingredients`, `recipes`, `suppliers`, `purchase_orders`, `purchase_order_items`, `goods_receipts`, `goods_receipt_items`, `stock_movements` (audit log of every stock change), `wastage_logs`, `physical_counts`, `physical_count_items`, `consumption_forecasts` (cache).

**Auto-deduction hook** (just after order INSERT in `server.ts`):
* For each line item → look up `recipes` by (menu_item_id, size_variant) → atomic `UPDATE … RETURNING current_stock_qty - ?` → insert `stock_movements` (CONSUMPTION) row.
* Unit conversion built-in: `g↔kg`, `ml↔l` so a 200g recipe step deducts correctly from a 5kg paneer stock.
* Fire-and-forget: deduction failure is logged but **never** rolls back the order INSERT.
* Below-`reorder_point` crossing → fires `STOCK_LOW` notification.

**Cancellation reversal** (`PATCH /api/orders/:id` flips status to `CANCELLED`):
* Re-adds quantities to `current_stock_qty`, logs `MANUAL_REVERSAL` movement.
* Idempotent via `orders.inventory_reverted` guard column — same order cancelled twice doesn't double-credit.

**Day-of-week-aware forecasting**:
* `daily_forecast(D) = avg(consumption on same weekday for previous 4 weeks)`.
* `weekly_forecast = Σ daily_forecast(D+0..6)`; `monthly = Σ daily_forecast(D+0..29)`.
* Falls back to last-7-days average when <28 days of history exists.
* `days_of_cover = current_stock_qty / daily_forecast(today)`; `suggested_order_qty = max(0, par_level - current_stock_qty - on_order_qty)`.

**Cron jobs** (extend `server.ts:cron.schedule` infra; UTC-offset math, not host TZ):
| Schedule | Job | Action |
|---|---|---|
| `0 3 * * *` (03:00 IST) | Recompute forecasts | Refresh `consumption_forecasts` cache for every active tenant |
| `0 9 * * *` (09:00 IST) | Stock-low scan + **auto-PO** | Fires `STOCK_LOW` / `STOCK_CRITICAL`, **groups low-stock ingredients by `default_supplier_id` and creates DRAFT POs**, attaches `autoPOId` to the notification ("📋 DRAFT PO PO-NN ready — review and Send to supplier"). Skips ingredients already on an open PO. |
| `0 8 * * *` (08:00 IST) | PO delivery reminder | `PO_DELIVERY_DUE_TODAY` notification when `expected_delivery_date = today` |
| `0 10 * * 1` (Monday 10:00 IST) | Physical count nudge | `PHYSICAL_COUNT_DUE` if no completed count in last 7 days |

**Onboarding wizard** (`InventoryOnboardingWizard` in `src/App.tsx`): 3-step flow shown on first INVENTORY tab entry. Pre-loads **23 common ingredients preset** (Dairy / Meat / Produce / Dry / Beverage) + **5 supplier presets**. Pre-fetches existing names case-insensitively to skip duplicates idempotently — same wizard run twice doesn't double-create.

**CSV import / export** on Ingredients, Recipes, Suppliers (import + export); POs, GRNs (export). Recipe CSV groups multi-line rows by `menu_item_name` and atomically `PUT`s each menu's recipe.

**PO PDF + email** (`poService.ts`):
* `generatePOPdf(data: POPdfData): Promise<Buffer>` — single-page A4 with header strip, buyer/supplier blocks, GST-aware items table, totals box, authorised-signatory footer.
* `buildPOEmailBody(data)` returns `{ subject, text, html }` — the HTML mirrors the PDF summary.
* Endpoints: `GET /api/inventory/purchase-orders/:id/pdf`, `POST /api/inventory/purchase-orders/:id/email`.

**Notifications** (templates in `notificationService.ts`):
`STOCK_LOW`, `STOCK_CRITICAL` (days_of_cover < supplier.lead_time_days), `PO_DELIVERY_DUE_TODAY`, `PHYSICAL_COUNT_DUE`. STOCK_LOW/CRITICAL include the auto-generated `autoPOId` when the cron created a DRAFT PO.

**Inventory Dashboard** (frontend, default INVENTORY landing): KPI strip (Stock Value · Below Reorder · Expiring · Wastage ₹ · Food-Cost % · Pending PO ₹), Daily/Weekly/Monthly forecast toggle with bar chart + table (Ingredient · Stock · Forecast · Days Cover · Order Qty · "Raise PO" button), 30-day Consumption Trend chart (padded to all 30 days so sparse data doesn't render as a single bar), Top Consumers pie, Wastage-by-reason bar.

**Filter / sort / search on every inventory table**:
* Ingredients: name search + category filter + sort by name / stock / reorder.
* Recipes: menu-item search.
* Suppliers: search box (name / contact / phone / email / GST) on the card grid.
* Purchase Orders: search + date-range (from/to) + status filter + sort by date / amount / status.
* Goods Receipts: search + date-range + sort.
* Wastage: search + reason filter + date-range + sort.
* Physical Counts: search + status filter + sort.

**Dedup safeguards** (3 layers):
1. Backend: `POST .../ingredients` and `POST .../suppliers` return **409 Conflict** with `existing_id` on case-insensitive name match (active rows only).
2. Wizard: pre-fetches active names before bulk insert and skips matches.
3. Cleanup script (`scripts/cleanup-inventory-duplicates.cjs`) — keeps higher-stock copy, deletes the other; run once on migrating tenants.

### Table Reservations (Restaurant)
Customer portal for advance bookings; staff dashboard for confirmation, edit, cancel, no-show tracking.

### Staff & Attendance
Directory (Chef / Waiter / Manager / Front Desk / Housekeeping / Maintenance / Concierge), shift management, clock-in/out attendance, per-staff monthly reports.

### Multi-Channel Notifications
Email (SendGrid), SMS (Twilio), WhatsApp (Meta Cloud API), Telegram. Granular per-event triggers for guests vs staff.

### Multi-Tenant Security
PostgreSQL **schema-based isolation** — every restaurant lives in its own `tenant_{restaurantId}` schema. JWT-based authentication. RBAC across 11 roles.

---

## User Roles
| Role | Description |
|---|---|
| `OWNER` | Full dashboard access for their restaurant. |
| `MANAGER` | Same dashboard access as OWNER. |
| `CHEF` | KDS view + status updates. |
| `WAITER` | Live tables filtered to their assignments. |
| `CUSTOMER` | App-less QR ordering interface. |
| `SUPER_ADMIN` | Platform-level admin (the `/internal` portal). |
| `CTO` | Technical overview dashboard. |
| `SALES_REP` | Per-rep restaurants list + onboarding-rate metrics. |
| `FRONT_DESK` / `HOUSEKEEPING` / `MAINTENANCE` / `CONCIERGE` | Hotel-side operational roles. |

---

## URL Conventions
| Path | Audience | Purpose |
|---|---|---|
| `https://atithi-setu.com/` | Apex | Marketing landing + new-restaurant signup |
| `https://erp.atithi-setu.com/` | Main app | Owner / staff login (apex-equivalent) |
| `https://erp.atithi-setu.com/internal` | Staff | SUPER_ADMIN / CTO / SALES_REP portal |
| `https://<slug>.atithi-setu.com/` | Per-tenant | Owner login + customer QR landing |
| `https://<slug>.atithi-setu.com/?table={id}` | Customer | QR-scan flow (postpaid) |

---

## Postpaid Session Flow (QR Table Ordering)
1. Customer scans table QR → `?table={tableId}` URL loads on the tenant subdomain.
2. `POST /api/restaurant/:id/sessions` — creates a new session OR **resumes** the most-recent OPEN session for that table.
3. Customer browses menu, adds items, places order via `POST /api/restaurant/:id/orders` with `session_token` + `session_id`.
4. Customer places multiple rounds within the same session — round_count auto-increments.
5. **Sequential mode:** the very first order in a session writes `table_sessions.invoice_number = INV-NNNN` (atomic counter).
6. "Request Bill" → `POST /api/restaurant/:id/sessions/:token/request-bill` → status `'open'` → `'bill_requested'`. Idempotent: also accepts sessions already in `'bill_requested'` (handles retries).
7. Request-bill handler also populates `gst_percent` + `apply_gst` from restaurant settings if they're still at column defaults — guarantees the printed invoice always shows the GST line.
8. **Three independent invoice-number assignment points** ensure SEQUENTIAL never silently fails: (a) order-POST first round, (b) request-bill safety net, (c) close-session final safety net. All use COALESCE so the first one to land sticks.
9. Owner/Manager marks PAID → `PATCH /api/restaurant/:id/sessions/:token/close` → status `'closed'` → orders → `DELIVERED + PAID` → table → `AVAILABLE`.

---

## Invoice List — Data Model & Visibility Rules

### Two-pass query (in `GET /api/restaurant/:id/invoices`)
**Pass 1 — SESSION invoices** (postpaid, one row per consolidated session):
```sql
WHERE ts.status IN ('open', 'bill_requested', 'closed')
  AND EXISTS (SELECT 1 FROM orders o WHERE o.session_id = ts.id AND o.status != 'CANCELLED')
```
Critically includes `'open'` sessions if they have at least one order — surfaces ACTIVE bills before the customer formally requests them.

**Pass 2 — ORDER invoices** (prepaid + manual, plus orphans):
```sql
WHERE o.status != 'CANCELLED'
  AND NOT EXISTS (
    SELECT 1 FROM table_sessions ts
    WHERE ts.id = o.session_id
      AND ts.status IN ('open', 'bill_requested', 'closed')
  )
```
This catches every order whose session is NOT in the SESSION list — orphaned orders (session deleted but order remained), unusual session statuses, etc. **Combined, these two queries guarantee every non-cancelled order appears somewhere.**

### Status badges
| Badge | Color | Condition |
|---|---|---|
| **ACTIVE** | amber | session.status = `'open'` (customer ordering, hasn't requested bill) |
| **UNPAID** | red | session.status = `'bill_requested'` OR order.payment_status = `'PENDING'` |
| **PRINTED** | blue | invoice_status = `'PRINTED'` |
| **PAID** | green | session.status = `'closed'` OR order.payment_status = `'PAID'` |

### `total_amount` calculation
* Closed / bill-requested sessions → `bill_amount` (already GST-inclusive, populated at request-bill).
* ACTIVE (open) sessions → recomputed GST-inclusive total (subtotal − discount + service-charge% + GST%) using the same formula the print template uses, so the list and print never disagree.
* Order rows → `total_amount` (already GST-inclusive in the orders table).

### Search
The search box matches against: invoice id, customer name, customer phone, table number, **`order_ids[]`** (so an `ORD-…` id finds the parent SESSION invoice), `invoice_number`, `display_number`, and `session_token`.

---

## Order Management Tab
Read-only listing — **no Action column.** Per-order Print / Edit / Mark-Paid actions were intentionally removed because a single SESSION invoice spans multiple orders; doing those actions per-order created confusion. All invoice operations live on the **Invoices tab** where each row is a complete invoice.

---

## Technical Stack
* **Frontend:** React 19 + Vite + Tailwind CSS + Framer Motion + Lucide Icons + Recharts.
* **Backend:** Node.js (Express) + TypeScript.
* **Database:** PostgreSQL (multi-tenant via `tenant_{restaurantId}` schemas; central DB for cross-tenant data — restaurants, users, audit logs, locations, internal users, sequences).
* **Real-Time:** WebSocket (`useSocket` hook) for live order/payment updates.
* **Image storage:** Cloudflare R2 (primary), local disk fallback.
* **AI:** Google Gemini (menu image generation), Groq (hotel concierge).
* **Notifications:** SendGrid (email), Twilio (SMS), Meta Cloud (WhatsApp), Telegram Bot API.
* **DNS:** Cloudflare API for auto-provisioning per-tenant subdomains.
* **Deployment:** Docker Compose (postgres_db + node_app), GitHub Actions auto-deploy on push to `dev`.

---

## Project Structure
```
src/
  App.tsx               — Single-file SPA: all components, hooks, state
  types.ts              — Shared TypeScript types (MenuItem, Order, TableSession, …)
  lib/
    socket.ts           — useSocket hook for WebSocket real-time updates
    utils.ts            — cn() utility (clsx + tailwind-merge)
server.ts               — Express API (every endpoint, every migration)
db.ts                   — Tenant DB pool, getTenantDb, getNextSequence, getNextTenantSequence,
                          per-tenant schema migrations (orders, table_sessions, sequences, etc.)
channelAdapters.ts      — OTA channel adapter framework: ChannelAdapter interface, adapters for
                          Booking.com / MMT (GoConnect OAuth push) / Goibibo / Agoda / Expedia /
                          Airbnb / Google Hotels (Phase 1 stub); getChannelAdapter() registry;
                          mmtOAuthCache for token reuse; AdapterAvailabilityPayload / AdapterResult types
notificationService.ts  — Email / SMS / WhatsApp / Telegram dispatch
formCService.ts         — Form-C PDF generation for foreign-national hotel guests
invoiceService.ts       — PDF invoice generation
googleDriveService.ts   — Optional Drive backup of uploaded menu images
cloudflareService.ts    — Cloudflare DNS auto-provisioning for new tenants
docker-compose.yml      — Container orchestration
docker-compose.prod.yml — Production override (VPS deploy)
Dockerfile              — Multi-stage build (Vite build → Node serve)
deploy/
  deploy-with-rollback.sh — VPS deploy script with auto-rollback on health-check failure
.github/workflows/
  deploy-vps.yml        — Auto-deploy on push to dev
Sales and Marketing/    — HTML pitch decks (restaurant + hotel), brochure DOCXs
client_side/            — Client-distributable utilities (POS shortcut .bat installers)
```

---

## Key Architecture Notes

### Tenant DB connection caching
`getTenantDb(restaurantId)` opens a per-schema PostgreSQL connection once and caches it (`tenantDbCache`). Migrations in db.ts run **inside** that initialization — first call triggers them, subsequent calls are cache hits. After server restart (deploy), cache is empty and migrations re-run on first access.

### Sequential invoice number atomicity
Same `INSERT … ON CONFLICT DO UPDATE … RETURNING current_value` pattern as the central `getNextSequence('restaurant')`. Two helpers:
* `getNextSequence(name)` — central DB sequence (currently used for `'restaurant'`).
* `getNextTenantSequence(tenantDb, name)` — per-tenant sequence (used for `'invoice'` or `'invoice-{year}'`).

### Defensive multi-point persistence
For sequential invoice numbers — assigned at **three** independent points (orders POST, request-bill, close-session). Every UPDATE uses `invoice_number = COALESCE(invoice_number, ?)` so the first non-null value sticks; later attempts no-op cleanly.

### GST persistence on session
The session row's `gst_percent` + `apply_gst` columns default to 0 / 1. Customer QR flow doesn't set them at order time. The `request-bill` endpoint reads restaurant settings and populates them on the session — without this fix, the print template recomputed bill totals as `subtotal × 0%` and dropped the GST line.

### Invoice list — total_amount fallback
For ACTIVE sessions (no bill_amount yet), the list computes GST-inclusive total inline with the same formula the print template uses. Avoids the "list shows ₹50, print shows ₹52.50" discrepancy.

### Universal display_number
Server emits `display_number = invoice_number || #${id.slice(-8)}` on every invoice response. Frontend uses `inv.display_number || `#…`` (with a `||` fallback) so partial deploys never break rendering.

### Settings save UX
`updateRestaurant()` flips a `settingsSaveStatus` state through `idle → saving → saved → (auto-reset to idle after 3s)`. The Save Settings button shows a spinner + "Saving…" while in flight, then turns green with "✓ Saved", and a green banner appears above it for 3 seconds — eliminates "did it save?" ambiguity.

### Role / view switching
* `role` initialized from `localStorage.getItem('role')`.
* `?r={restaurantId}` URL param overrides role to `CUSTOMER` (QR scan flow).
* Tenant subdomain (`<slug>.atithi-setu.com`) — `getTenantSlug()` resolves to `tenant.id` via `GET /api/tenant/by-slug/:slug`. Reserved subdomains (`erp`, `demo`, `internal`, etc.) skip tenant resolution.
* `/internal` path on apex/main — auto-routes to staff login (SUPER_ADMIN / CTO / SALES_REP).

### Session token storage
Stored in `localStorage` under `session_{restaurantId}_{tableId}`. On re-scan, the stored token is sent to the server to **resume** the existing session via the `POST /sessions` endpoint's lookup-by-token branch.

### Table monitor polling
`fetchLiveTables()` every 30 seconds when MONITOR tab active. A separate 1-second `setInterval` ticks `liveNow` to drive elapsed-time counters. Both intervals cleared in useEffect cleanup.

### JWT decoding (Waiter)
Waiter ID extracted client-side: `JSON.parse(atob(token.split('.')[1])).id`. Used to filter "My Tables" without an extra API call.

### Inventory deduction — atomic stock UPDATE
`UPDATE ingredients SET current_stock_qty = current_stock_qty - ? WHERE id = ? RETURNING current_stock_qty` — Postgres serializes the row-level update so concurrent orders never race. Wrapped in `try/catch` with `.catch()` so the order INSERT response is sent **before** deduction even runs; failure is logged but never propagates.

### Inventory unit conversion
Recipe units (`g`, `ml`) auto-convert to ingredient stock units (`kg`, `l`) at deduction time. Mixed units within a single recipe row are rejected at form-validation time.

### Auto-PO grouping in stock-low cron
The 09:00 IST scan groups all below-`reorder_point` ingredients by `default_supplier_id` and creates a **single DRAFT PO per supplier** with all their items. Skips ingredients already on an open PO (status SENT or PARTIAL) to avoid double-ordering. The created PO id is attached to the `STOCK_LOW` notification so the owner sees "📋 DRAFT PO PO-NN ready" and can one-click review/send.

---

## Object Detail View — MANDATORY convention (Overview / Audit History / Where Used)

Every **business document object** must open into a **detail view with a left tree menu** exposing three standard nodes. This is a **must-have** — no such object ships (new or refactored) without all three.

**Objects this is mandatory for (across ALL modules):**
* **Sales Invoice / Folio Invoice** — restaurant invoices, hotel folios (`folio_kind` HOTEL/SPA/EVENT), group invoices, receivables invoices.
* **Quotation** — event quotations (`event_quotations`), and any future sales/purchase quotation.
* **Booking** — hotel `room_bookings`, hotel `room_booking_groups`, spa `spa_appointments`, event `event_bookings`.

Apply the same pattern to any new document-like object (Purchase Order, Sales Order, Membership, …) unless there is a documented reason not to.

### The tree menu (left rail, sticky)
```
▸ <Object> #<display_number>
   ├─ Overview        ← default node
   ├─ Audit History
   └─ Where Used
```

**1. Overview** (default) — the object's own fields + line items + current status/lifecycle badge + primary actions (edit/PDF/send/confirm/cancel per that object's rules). This is the existing detail content; it becomes the first tree node.

**2. Audit History** — an immutable, reverse-chronological event log for THIS object: who did what, when, and (where feasible) old → new values. Sources, in priority order:
   * Reuse existing audit trails where they already exist — e.g. `permission_audit`, `property_type_audit`, folio `revision_number` / `revised_by` / `revised_at`, booking `cancelled_by` / `cancelled_at` / `cancellation_reason`, quotation `sent_at` / `sent_to_email` / status transitions.
   * When an object has no dedicated trail yet, add a generic per-tenant `object_audit_log` row (`object_type`, `object_id`, `action`, `actor_email`, `actor_role`, `before_json`, `after_json`, `created_at`) written at every create / status-change / edit / send / cancel. Never mutate or delete audit rows (append-only, mirrors the invoice soft-delete / folio-reversal philosophy).

**3. Where Used** — every other record that references THIS object, grouped by relationship, each row deep-linking to that record's own detail view. Examples:
   * **Invoice/Folio →** originating Booking, Quotation it was raised from, folio payments, credit notes / revisions (`parent_folio_id`), the guest/customer, GST output-register rows, receivables entry.
   * **Quotation →** the Booking it belongs to, the Invoice/Folio it converted into, later quotation versions of the same booking.
   * **Booking →** its Folio/Invoice, its Quotations, linked hotel bookings (for an event: `event_booking_rooms.hotel_booking_id`), folio payments, group parent (`group_id`), channel-sync rows.

### Build rules
* **Backend:** one endpoint per object returns the three payloads (or three sub-endpoints): `GET …/:id` (overview), `GET …/:id/audit`, `GET …/:id/where-used`. Where-Used runs the reverse-reference queries server-side (never leak cross-tenant rows — always scoped to the tenant DB).
* **Frontend:** a single reusable `ObjectDetail` shell (tree rail + node router) that each module drops its object into — do NOT reimplement the tree per module. Deep-links between objects reuse this shell.
* **Isolation still holds:** cross-module "Where Used" links (e.g. an event's hotel booking) resolve through the owning module's API, never by cross-querying another module's tables directly.
* **Definition of done:** any PR that adds or materially changes a Sales Invoice, Quotation, or Booking object must include all three tree nodes + the audit write-points, and extend `test-scripts/run_technical_tests.mjs` accordingly.

> Status: **convention adopted (2026-07-23) — not yet implemented.** Roll out object-by-object; Event/Folio/Booking are the first targets. Existing detail screens become the "Overview" node when retrofitted.

---

## Localization (i18n) — MANDATORY for every new user-facing string

There is a runtime i18n layer: `src/i18n.ts` (the `t()` resolver + `LanguageProvider`)
and `src/locales/*.ts`. **English (`en.ts`) is the source of truth**; regional
dictionaries (`hi`, `ta`, `kn`, `te`, `pa`, …) override per key and fall back to
English for anything they omit. Each tenant sets a `secondary_language` and a
toggle flips English ↔ that language. Currently seeded with full translations:
**Hindi, Tamil, Kannada, Telugu** (Events module + public pages).

**Definition of done — any new attribute label, feature, module, dropdown value,
toast, or other visible string MUST be localized. This is not optional and is not
limited to the Events module:**
1. Add the English key to `src/locales/en.ts` and render it via `t('namespace.key')` —
   **never hardcode a visible string** in a component.
2. Add the translation to **every shipped regional dictionary** (`hi`, `ta`, `kn`,
   `te`). Omitting a key is allowed only as a deliberate stopgap — it silently
   falls back to English, which is acceptable temporarily but not for a shipped
   feature.
3. User-facing **enum/dropdown values** (event types, categories, statuses, pricing
   bases, …) get localized display labels too — don't show raw codes like
   `PER_EVENT` to end users once a feature is finalized.
4. Keys use dot-notation namespaces (`events.bookings.discount`,
   `common.save`). Reuse `common.*` for shared verbs/nouns.

Treat this like the test-script rule: updating locales is part of the same
definition-of-done as updating `test-scripts/run_technical_tests.mjs`.

---

## Recent Feature Additions (2026-05 cycle — Hotel PMS expansion + OTA Channel Manager)

A major two-wave sprint. Wave 1 (Sprints A–D + P2) closed the long
tail of hotel PMS gaps the fit/gap audit surfaced — bringing the
hotel module roughly to parity with Cloudbeds / Hotelogix for
small-to-mid Indian properties. Wave 2 (CH-1…CH-5) added the OTA
channel manager — the practical real-world integration pattern
that works without partnership approvals from Booking.com / MMT /
Agoda (iCal pull every 30 min + inbound webhook receiver with
audit log; outbound push is a documented stub framework ready
to be swapped to real HTTP calls when partner sandbox creds arrive).

### Sprint A — Calendar & Search (hotel PMS UX foundations)

| Date | Feature | Commit |
|---|---|---|
| 2026-05 | A1: Availability Calendar (rooms × dates grid, auto-refresh) | (A1 commit) |
| 2026-05 | A2: "Find Available Rooms" search modal | `4e8191f` |
| 2026-05 | Clickable guest names on calendar with quick-action popover | `0c0ee71` |
| 2026-05 | Availability Dashboard for receptionists / GMs | `cdf2546` |

### Sprint B — Foundations (holds, types, walk-ins, rate plans)

| Date | Feature | Commit |
|---|---|---|
| 2026-05 | B1: Room holds (block/unblock for maintenance/owner stays/OTA holds) | (B1 commit) |
| 2026-05 | B2: Room types (metadata layer, foundation for inventory pooling) | (B2 commit) |
| 2026-05 | Walk-in fast-path — single-screen book + check-in | `73ee711` |
| 2026-05 | Rate Plans — weekend / season rates with auto-apply | `58f6bd4` |

### Sprint C — Inventory pooling + Group bookings

| Date | Feature | Commit |
|---|---|---|
| 2026-05 | C1: Category-level availability rollup in Find Available Rooms | `4e8191f` |
| 2026-05 | C2: Group bookings — multi-room single atomic transaction | `e2d1a17` |
| 2026-05 | Comprehensive hotel regression suite (refund / late-fee / day-use / group) | `8187771` |

### Sprint D + P2 — Direct booking, OTA-light, yield, online check-in

| Date | Feature | Commit |
|---|---|---|
| 2026-05 | D1 backend: public booking endpoints — direct-booking channel | `b4a03c0` |
| 2026-05 | D1 frontend: public booking page UI | `2db0b04` |
| 2026-05 | D2: channel credentials stub + `channel_sync_log` audit | `f535b75` |
| 2026-05 | P2-A: group one-click cancel — refund-policy-aware mass cancel | `91fa42d` |
| 2026-05 | P2-B: group consolidated invoice PDF | `bc12dcd` |
| 2026-05 | P2-C: iCal export per property + per room | `f394b2d` |
| 2026-05 | P2-D: promo codes on folios — re-use restaurant `promo_codes` table | `ece7f68` |
| 2026-05 | P2-E: pickup pace report (current vs prior-year window) | `9054db7` |
| 2026-05 | P2-F: online check-in form — public endpoints + UI | `d5c4b26`, `80eeaa0` |
| 2026-05 | P2-G: pre-arrival emails (T-3 days cron) + GUEST_PRE_ARRIVAL template | `de7c3ad`, `b9831c1` |
| 2026-05 | P2-H: yield management — occupancy-triggered rate rules | `fc180b6` |
| 2026-05 | Sprint C + D + P2 endpoint smoke test (`scripts/smoke-test-sprint-c-d.cjs`) | `bea8fd1` |
| 2026-05 | Settings UI: yield rules editor + channel credentials form + pickup pace chart | `5c5d805`, `fbb6cb3` |
| 2026-05 | AES-256-GCM at-rest encryption of `channel_credentials.api_secret` | `b9831c1` |

### CH-1…CH-5 — OTA Channel Manager (the integration sprint)

| Date | Feature | Commit |
|---|---|---|
| 2026-05 | CH-1: Channel adapter framework (`channelAdapters.ts`) + outbound queue worker | `dc1e011` |
| 2026-05 | CH-1 follow-up: TS literal-union cast on `parseInbound` operation | `0fd479e` |
| 2026-05 | CH-2: iCal import — every-30-min cron worker draining all tenants' feeds | `bc86395` |
| 2026-05 | CH-3: Inbound channel webhook receiver + `channel_webhook_log` audit table | `8ead9a9` |
| 2026-05 | CH-4: Channel manager dashboard UI (iCal feeds + webhook log + credentials) | `609cc3b` |
| 2026-05 | CH-5: Adapter contract test (`verify-channel-adapters-offline.cjs`, 64 assertions) + production smoke test (`smoke-test-channel-manager.cjs`) | `4e083ae` |

### Cross-domain — Marketing site routing fix

| Date | Feature | Commit |
|---|---|---|
| 2026-05 | Host-header middleware in `server.ts`: 301-redirect `www.atithi-setu.com` + bare apex to marketing site (band-aid until Cloudflare adds www as a custom domain on the marketingatithisetu Pages project) | `3a3bfe6` |

### What this sprint actually means for owners

Hotels: every must-have feature on a 2026 PMS feature-checklist now
exists. Boutique properties (5–30 rooms) can run the entire front
office on AtithiSetu — bookings, rate plans, yield, online check-in,
direct bookings via a public page, OTA channel manager (iCal +
webhook + real outbound ARI push), Form-C / FRRO, folios with
split-billing and refund automation, housekeeping board, and pre-
arrival communications. The one material gap remaining is revenue-
management forecasting beyond the yield-rules layer.

Restaurants: untouched in this sprint. The POS / KDS / loyalty /
aggregator-sync stack from the 2026-04 cycle is the current state
of art there.

### Build markers (`commit_marker` progression in `server.ts`)

For verifying which sprint is actually live via `curl /api/version`:

```
billing-v13-role-access-marker-fix                  (pre-sprint)
hotel-channel-adapter-framework                     (after CH-1)
hotel-ical-import                                   (after CH-2)
hotel-webhook-receiver                              (after CH-3)
hotel-channel-sprint-complete                       (after CH-5)
hotel-channel-sprint-complete-plus-www-redirect     (after www-redirect)
```

### Marketing site (sibling repo — `atithi-setu_website/atithi-setu`)

The marketing site at https://atithi-setu.com lives in a separate
repo (Cloudflare Pages, Vite + React Router SPA, see its own
`CLAUDE.md`). It was revamped in parallel:

- Dual-vertical positioning — homepage now leads with "Hotel PMS +
  Restaurant POS, One Platform" and routes visitors to dedicated
  `/hotels` and `/restaurants` landings with vertical-specific FAQ
  schema and pre-filtered feature lists.
- SEO audit + per-route `<SEO>` component patches `<title>`, meta
  description, canonical, OG, Twitter, and route-specific JSON-LD
  on every navigation (since the SPA can't use real SSR yet).
- Service Worker kill-switch (`public/sw.js`) + nuclear
  `Clear-Site-Data` header + user-visitable `/reset` recovery URL —
  deployed to evict a stale legacy SW that's still active in some
  returning visitors' browsers from a previous deployment.

If you change anything on the ERP that the website advertises (new
modules, pricing, feature names), bump the parallel description in
the marketing repo's `src/App.tsx` `ALL_FEATURES` array AND its
`index.html` structured-data so SERP rich results stay in sync.

---

## Recent Feature Additions (2026-06 cycle — Hotel Public Booking + OTA)

The June cycle hardened the **Hotel Public Booking Page** (the
0%-commission direct channel) and wired OTA propagation end-to-end.
Tenant subdomain pattern stabilised at `<slug>.atithi-setu.com` with
a friendly `/book/<slug>` route on the apex.

### Tenant-configurable display + pricing settings
Two new columns on `restaurants` (defaults preserve old behaviour):

| Column | Default | Purpose |
|---|---|---|
| `date_format` | `'DD-MMM-YYYY'` | One of `DD-MM-YYYY`, `DD-MM-YY`, `DD-MMM-YYYY`, `YYYY-MM-DD`, `DD/MM/YYYY`, `MM/DD/YYYY`. Applied via `formatDateForTenant(value, format)` helper in `src/App.tsx`. Live preview in Settings shows today's date in the chosen format. |
| `rates_include_gst` | `1` (inclusive) | When 1, matrix rate IS gross customer-paid (current default — GST extracted from total at folio). When 0 (Marriott / global), matrix rate is pre-tax; public availability + booking endpoints gross it up so customers see the right number. Centralised helper `rateBreakdown(rate, gstPct, mode) → {net, gst, gross}`. |

UI lives in Settings → Public Booking Page (next to brand colours).

### Marriott-style Rooms + Adults + Children + meal-plan picker
Replaced the single `guests` field on `PublicBookingPage` with the
shape every major chain uses. Three steppers in a popover (Rooms /
Adults / Children) plus per-child age dropdowns appear when
Children > 0. Each category card now shows a rate-plan radio strip
(EP / CP / MAP / AP) with per-night price + meals-included icons.

Backend changes:
- `GET /api/public/.../hotel/availability` returns `meal_plans[]`
  per category (`meal_plan_id`, `code`, `name`, `per_night_rate`,
  `meals_included[]`) — JOINs `room_tariffs × meal_plans` filtered
  by overlapping seasons. Empty array when matrix isn't populated
  for that room_type.
- `POST /api/public/.../hotel/booking` accepts:
  `num_rooms` (1-9), `adults` (1-16), `children` (0-8),
  `child_ages[]` (0-12), `meal_plan_id` (optional → defaults to
  cheapest). Multi-room creates N bookings sharing a `group_id`
  (reuses task #19 group-bookings infrastructure). Per-room price
  via `computeBookingTotalWithExtras()` honouring meal plan + extras.
  Children ≤ 5 → no-mattress (often free), > 5 → with-mattress.
- Capacity guard rejects when `adults + children > room.capacity`
  per room.

### OTA propagation with meal-plan + multi-channel fan-out
Every booking row now carries `meal_plan_id` + `meal_plan_snapshot`
+ `extra_adults` + `extra_children_with_mattress` +
`extra_children_no_mattress`. Downstream:
- iCal export (`/hotel/ical/property.ics`) — `SUMMARY` includes the
  meal-plan code: "Guest · Room 101 · CP". `DESCRIPTION` carries
  the full plan label + extra-person counts. New X-properties
  `X-ATITHI-MEAL-PLAN` + `X-ATITHI-SOURCE` (RFC 5545) give OTA
  parsers structured access without regex-scraping.
- `channel_sync_log` fan-out — `logChannelSync()` writes ONE audit
  row for the source channel + N `queued` rows for every OTHER
  enabled channel in `channel_credentials`. The worker pushes via
  adapter with exponential-backoff retry chain (30s → 6h →
  permanent_fail). Closes the "direct booking didn't propagate"
  gap.

### Other June work

| Date | Feature | Commit |
|---|---|---|
| 2026-06 | Marriott rooms+adults+children + meal-plan picker + multi-room | `9caaeb0` |
| 2026-06 | Tenant-configurable date format + GST inclusive/exclusive toggle | `c77ad4c` |
| 2026-06 | Public-booking integration gaps — fanout to OTAs, net revenue=total for direct, DIRECT_WEB label | `c2ad988` |
| 2026-06 | White-screen fix — Rules of Hooks violation in PublicBookingPage (3 hooks below early returns) | `d660861` |
| 2026-06 | Phase 3 visual polish — Playfair Display, Ken Burns hero, multi-image carousel, scroll fade-in, ICS calendar + share button on confirmation | `0fe81f1` |
| 2026-06 | Taj/Marriott-grade brand theming (per-tenant `brand_primary_color` / `brand_secondary_color`) + categorized search ("3 rooms left", no room numbers leaked to guest) | `b28dd55` |
| 2026-06 | Promote Public Booking Page to top-level Settings tab | `97afb6d` |
| 2026-06 | Rate-preview query — go directly to matrix to skip orphan meal_plans (drove "starts from ₹X" too low when LEGACY meal_plans existed without matrix rows) | `d224d10` |
| 2026-06 | Premium guest-facing direct booking page foundation (hero, sticky nav, category grid, amenities, gallery, location, cancellation, footer) | `ce805f6` |
| 2026-06 | Channel Manager redesign + Live Rate Card (the headline view) | `ed68fda` |
| 2026-06 | OTA gaps 5-9 — commission, rate plans, retry, reconciliation, IP allowlist | `cab1e0c`, `2a0b581` |
| 2026-06 | OTA 360° Dashboard — per-channel KPI scorecard | `269fc71` |
| 2026-06 | Receivables platform — agents + invoices + payments + aging (parts 1-2) | `bcdc59c`, `42772d6`, `f7fed43` |

### Public booking key conventions
- **Room numbers NEVER leak to the guest.** Server picks any
  vacant room in the chosen category at booking time. Frontend
  always sends `room_type_id`, never `room_id`.
- **Direct bookings have 0% commission.** Public booking POST
  inserts `commission_pct=0, commission_amount=0,
  net_amount=total_amount` so the OTA 360 dashboard rolls direct
  revenue up with the same shape as commissioned bookings.
- **`booking_source = 'DIRECT_WEB'`** on every public booking;
  `otaDisplayName` map renders it as "🌐 Direct (Website)".
  `logChannelSync` recognises DIRECT_WEB as a direct source
  (alongside DIRECT, WALK_IN) and writes the source row as
  `status='skipped_direct'` rather than queueing a no-op push.
- **Validation: `qa_e2e_tariff_calculations.mjs`** — 295 offline
  math assertions. Must stay 295/295 on every push that touches
  pricing / matrix / GST / extras / folio / invoice.

### Mid-cycle additions (later in 2026-06)
After the public booking page hardening, the cycle also delivered:

| Date | Feature | Commit |
|---|---|---|
| 2026-06 | **Outstanding Payments Report** — per-booking grid with sortable/filterable columns under Channel Manager. New endpoint `GET /hotel/reports/outstanding-payments` returns one row per commissioned booking + summary KPIs. Status: UNBILLED/OPEN/PARTIAL/PAID/OVERDUE. Hides PAID by default; click any row to open the partner-statement modal. | `fdc2cdf` |
| 2026-06 | **Payment-link send (email + WhatsApp)** with folio breakup. New `POST /hotel/bookings/:id/send-payment-link` endpoint accepts `{channel: EMAIL/WHATSAPP/BOTH, override_amount?}`. Auto-triggers on check-in (opening folio) AND check-out (residual due). New "Pay link" column on Hotel Bookings list with 📧 + 💬 buttons. Uses `buildHotelPaymentLinkPayload()` + `renderPaymentLinkMessage()` helpers — one source of truth for both email and WhatsApp formatting. | `a5d12f9` |
| 2026-06 | **Confirmation step scroll-to-top + CTA buttons** — fixes "page does nothing after Confirm" bug. useEffect scrolls viewport on GUEST/DONE step transition; resetToLanding() helper clears all state; two new CTAs (📋 Copy booking reference + ✓ Done) on confirmation card. | `c10f80e` |
| 2026-06 | **GoConnect MMT OAuth + Google Hotels Free Booking Links** — real ARI push to MMT via OAuth 2.0 client_credentials; in-memory token cache; GoogleHotelsAdapter stub; Google ARI XML pull-feed endpoint; triggerAriPush() fire-and-forget helper; JSON-LD LodgingBusiness on PublicBookingPage. | `c4f92ce` |

### GoConnect MMT + Google Hotels — SHIPPED (19 Jun 2026, commit `c4f92ce`)

#### GoConnect MMT — real outbound ARI push (no OTP)

**Key clarification:** The OTP the owner sees is the InGo-MMT extranet **web dashboard** 2FA — it
protects the website login only. Server-to-server API integration uses a completely separate
OAuth 2.0 credential pair (Client ID + Client Secret) obtained **once** from InGo-MMT Partner
Portal → Settings → API Credentials. Those credentials have no OTP requirement. The owner pastes
them into Channel Manager → MMT channel and the server handles everything from there.

**What was built:**
- `MakeMyTripAdapter.getOAuthToken(creds)` — POSTs `client_id + client_secret` to
  `https://connect-api.makemytrip.com/oauth/token` (client_credentials grant); caches the
  Bearer token in-memory (`mmtOAuthCache`) until 60s before expiry; never shows the owner
  a token; fully transparent.
- `MakeMyTripAdapter.pushAvailability(creds, payloads)` — groups payloads by
  `roomName` (external room code), POSTs to
  `https://connect-api.makemytrip.com/api/v1/hotel/inventory` with the cached token.
  Body: `{hotel_id, room_type_code, inventory:[{date, available_rooms, rate, currency}]}`.
- `triggerAriPush(restaurantId, booking)` in `server.ts` — fire-and-forget helper called
  after every booking CREATE or CANCEL. Fans out to all enabled OTAs (except the source
  channel), computes per-date availability from `room_bookings`, resolves the external room
  code from `channel_room_mappings`, calls `adapter.pushAvailability()`, and logs the result
  to `channel_sync_log` with `event_type='AVAILABILITY_PUSH'`. Never throws into the booking
  request path.

**Owner activation steps (one-time manual):**
1. Log into InGo-MMT extranet (OTP only here — this is a one-time setup step).
2. Go to **Settings → API Credentials** → copy Client ID, Client Secret, Property ID.
3. Paste into AtithiSetu **Channel Manager → MMT channel** (api_key = Client ID,
   api_secret = Client Secret, property_id = Property ID).
4. Done — all future booking creates/cancels auto-push ARI to MMT.

#### Google Hotels — Phase 1 (Free Booking Links, no approval needed)

Google Hotel Ads requires 8–14 weeks partner approval. Phase 1 uses **Google Free Booking
Links** (organic, free, live within days) and does not require any API approval.

**What was built:**
- `GET /api/public/restaurant/:id/hotel/google-ari` (no auth) — returns
  `OTA_HotelRateAmountNotifRQ` XML for the next 90 days, one
  `<RateAmountMessage>` per rate plan × room type. Content-Type: `application/xml`.
  Google Hotel Center can poll this URL as a price feed.
- `GoogleHotelsAdapter` class + `GOOGLE_HOTELS` registry entry in `channelAdapters.ts` —
  Phase 1 stub that logs but doesn't push (push requires Google Travel Partner API access).
  Phase 2 implementation target: `POST https://www.google.com:443/travel/hotels/uploads/ota/`
  with a Google service account OAuth 2.0 Bearer token (scope `travel-partner`).
- `GOOGLE_HOTELS` option in Channel Manager dropdown with helper text and ARI feed URL.
- JSON-LD `LodgingBusiness` schema injected into `document.head` on `PublicBookingPage` load
  (via a `useEffect` watching `hotelInfo`) — enables Google Rich Results for the property.

**Owner activation steps (one-time manual):**
1. Verify property in **Google My Business**.
2. Link to **Google Hotel Center** (free) → add the booking page URL
   (`https://<tenant>.atithi-setu.com/book/<slug>`) as the booking link.
3. In Hotel Center, submit the ARI feed URL:
   `https://erp.atithi-setu.com/api/public/restaurant/<id>/hotel/google-ari`
4. Verify the public booking page's structured data at
   `https://search.google.com/test/rich-results`.

**Phase 2 triggers (after Google Travel Partner API approval):**
- Implement `GoogleHotelsAdapter.pushAvailability()` with real Google ARI push.
- Add `triggerAriPush` call for rate-plan edits (PUT `/hotel/rate-plans/:id`).
- Wire `GOOGLE_HOTELS` to the same `channel_sync_log` retry chain as MMT.

### HR & Payroll Phase 1 — COMPLETE (2026-06 cycle's tail)
A standalone build, **plan locked at** `.claude/plans/i-need-to-setup-nifty-hammock.md`.
Scope: full Indian statutory automation (PF/ESI/PT/TDS, Form 16, EPF ECR), employee self-service portal, India-only / INR-only gate. 12 workstreams, all SHIPPED to production.

| Date | Workstream | Commit |
|---|---|---|
| 2026-06 | **#1 Schema + central PT/TDS slab seed** — 18 HR fields on `attendance_staff`, 8 new tenant tables (`salary_structures`, `salary_components`, `payroll_runs`, `payslips`, `expense_claims`/`_items`, `offer_letters`/`_templates`, `statutory_config`), 2 central tables (`central_pt_slabs` MH/KA/WB seed + `central_tds_slabs` FY 2025-26 OLD+NEW). | `3036514` |
| 2026-06 | **#2 Employee Directory CRUD + HR_PAYROLL tab** — 5 endpoints. `EmployeeDetailModal` with full HR profile. Server-side PAN/Aadhaar/IFSC validation. | `6a64195` |
| 2026-06 | **#3 Statutory rules engine + 108-fixture golden suite** — pure module `statutoryRules.ts`. PF/ESI/PT/TDS math with boundary fixtures (ceilings, Feb top-up, slab boundaries, March-cliff stability). Run via `node qa_statutory_golden.mjs`. | `23e1371` |
| 2026-06 | **#4-#6 Salary structures + Payroll engine + Payslip PDF** — versioned per-employee structure with `effective_from`/`effective_to`. Payroll run state machine: DRAFT → PROCESSING → APPROVED → LOCKED → PAID with conditional UPDATE guards. `payslipService.ts` Boutique-style PDF with bilingual support, attendance band, earnings × deductions tables, employer contributions footer. | `e6560e9` |
| 2026-06 | **#7-#12 Statutory exports + Expenses + Offers + Self-service + Cron + Settings** — Form 16, 24Q, EPF ECR generators. Expense claim approval chain (DRAFT→SUBMITTED→MANAGER_APPROVED→HR_APPROVED→REIMBURSED). Offer letters + template editor with handlebars-style `{{placeholders}}`. `/me/*` self-service endpoints with tenant-isolation. Monthly auto-create + offer-expiry crons. Statutory config Settings UI. | `48caa2b` |
| 2026-06 | **HR frontend — 5 new sub-tabs** — SalaryStructureEditor / PayrollRunsView / ExpenseClaimsInbox / OfferLettersView / StatutoryConfigEditor. Currency-safety banner on non-INR tenants. | `fd5f888` |

**Phase 1 conventions to enforce:**
- `attendance_staff.hr_status` is INTENTIONALLY separate from `is_active`
  — a resigned employee may still need login for Form 16 download
- `payroll_runs` is UNIQUE(year, month) — idempotency anchor
- `payslips` carries `staff_snapshot` + `structure_snapshot` JSON
  for audit immutability — never recompute after APPROVED
- Statutory rule data lives in CENTRAL tables (`central_pt_slabs`,
  `central_tds_slabs`) — per-FY rows mean historical payroll runs stay
  reproducible after budget changes
- All HR endpoints gated by `requireTabAccess('HR_PAYROLL')` — owners
  bypass; staff need explicit grant via Settings → Staff Access
- `/me/*` self-service endpoints (Phase 1 #10) read `req.user.id`
  and never accept an external `staff_id` param
- TDS projected on FULL gross (not pro-rated) to avoid the March cliff
- ESI uses round-UP (Math.ceil) per ESI Act §39; everything else round half-up

**Phase 2 deferrals** (out of scope): Resignation + FNF (gratuity, leave
encashment, notice recovery); salary advances / staff loans; leave
management; holidays calendar per-location; comp-off accrual; multi-
state PT scheduler; Form 12BA; Form 16A; ESIC Form 6; LWF; gratuity
actuarial; income-tax declaration portal; performance reviews.

**Phase 1 conventions to enforce:**
- `attendance_staff.hr_status` is INTENTIONALLY separate from `is_active`
  — a resigned employee may still need login for Form 16 download
- `payroll_runs` is UNIQUE(year, month) — idempotency anchor
- `payslips` carries `staff_snapshot` + `structure_snapshot` JSON
  for audit immutability — never recompute after APPROVED
- Statutory rule data lives in CENTRAL tables (`central_pt_slabs`,
  `central_tds_slabs`) — per-FY rows mean historical payroll runs stay
  reproducible after budget changes
- All HR endpoints gated by `requireTabAccess('HR_PAYROLL')` — owners
  bypass; staff need explicit grant via Settings → Staff Access
- `/me/*` self-service endpoints (Phase 1 #10) must read `req.user.id`
  and never accept an external `staff_id` param

### Hotel checkout flow — SHIPPED (10-11 Jun 2026)
Critical 4-part gap (discovered 10 Jun) closed end-to-end:

| Date | Fix | Commit |
|---|---|---|
| 2026-06 | **Folio payments ledger** + advance at check-in + outstanding gate at checkout + auto-invoice email/WhatsApp send + F&B `ensureFolioForRoom()` auto-creation. CheckInWizard advance-payment section, CheckoutModal complete rewrite with outstanding hero card / payment ledger / "Receive payment" form / comp-waive checkbox. | `040cf52` |
| 2026-06 | **Hotel-bookings search rewrite** — replaced fragile 22-placeholder CASE-based ranking with flat 6-placeholder WHERE + JS-side ranking + `COALESCE` (fixes "Search by Guest name not working"). Also fixed `\D` → `[^0-9]` for phone-number normalisation. | `e1b8271` |
| 2026-06 | **BA fit-gap quick wins** — (1) F&B `postOrderToFolio()` now resolves folio via `booking_id` when `room_id` is NULL (closes silent-revenue-loss gap); (2) row-level lock on check-in via conditional `UPDATE … WHERE status='BOOKED'` (kills concurrent double-flip race); (3) invoice numbers atomic via `getNextTenantSequence('hotel-invoice-<YYYY>')` persisted to `folios.invoice_number` so reprints are stable + audit-grade. | `aad178e` |

### Critical helpers introduced in 2026-06 checkout work
- `getFolioOutstanding(tenantDb, folioId) → {folio, payments[], total_paid, total_refunded, outstanding, is_fully_paid}`
- `recordFolioPayment({folioId, amount, method, type:'ADVANCE'|'INTERIM'|'FINAL'|'REFUND', reference, recordedBy, notes})`
- `ensureFolioForRoom(restaurantId, roomId)` — defensive folio creation for F&B charges
- `resolveOccupancyPolicy(tenantDb)` returns `{free_adults_per_room, max_extra_adults_per_room, free_child_age_max, max_children_per_room}`
- `getNextTenantSequence(tenantDb, 'hotel-invoice-<YYYY>')` — atomic invoice numbering shared with restaurant invoice path
- `triggerAriPush(restaurantId, {id, room_id, check_in_date, check_out_date, booking_source})` — fire-and-forget ARI fan-out called after booking create/cancel; fans out to all enabled OTAs except the source; logs to `channel_sync_log` with `event_type='AVAILABILITY_PUSH'`; never throws

### BA Fit-Gap Phase 2 punch list — SHIPPED (11 Jun 2026)
All 6 items from the BA fit-gap assessment shipped in commit `971e4dd`:
- **#4** OTA commission auto-lookup — `booking_source` lookup against `channel_credentials.commission_pct` on staff-side bookings INSERT
- **#5** Night audit report — `GET /hotel/reports/night-audit?date=&range=` returning occupancy / ADR / RevPAR + ancillary breakdown
- **#7** Multi-currency safety — `GET /hr/currency-safety` for non-INR tenants → frontend shows soft amber banner
- **#8** Form-C HARD GATE — check-in handler returns 409 `FORM_C_REQUIRED` for foreign nationals without form_c_audit row. Override: `skip_form_c_for_now=true`
- **#9** No-show auto-cancel cron — daily 02:30 IST sweeps `BOOKED + check_in_date < today−1 + actual_checkin_at IS NULL`, flips to NO_SHOW + voids open folio + fires BOOKING_NO_SHOW notification
- **#10** Service-request auto-bill confirm — `POST /hotel/service-requests/:requestId/confirm-bill` posts to folio via `ensureFolioForRoom + folio_entries`; `/waive-bill` flips to `charge_status='WAIVED'`. New `charge_status` enum (PENDING/POSTED/WAIVED)

---

## Supply Chain & Procurement Module (2026-06 cycle)

### Overview
The Supply Chain module extends the legacy restaurant-only inventory with a full **Accounts Payable + Procurement** workflow that covers both hotel and restaurant operations. It is property-type-agnostic — visible to ALL tenants (hotel-only, restaurant-only, both).

### Design decisions
- **`ALWAYS_VISIBLE_TABS`** — `PROCUREMENT` added alongside `INVENTORY`, `DELIVERY`, etc. so it is never gated by `restaurantOnly`.
- **`module` column** on `supplier_invoices` and `purchase_orders` takes values `RESTAURANT | HOTEL | SHARED`, enabling per-property spend analytics.
- **3-way match procurement** (PO → GRN → Supplier Invoice → Payment) is the logical model, but invoices can be created standalone (no mandatory PO/GRN link) for ad-hoc supplier bills.
- **Idempotent payment accounting**: each payment immediately updates `paid_amount`, `outstanding_amount`, and `status` on the parent invoice (UNPAID / PARTIAL / PAID). Reversing a payment (`DELETE /procurement/payments/:id`) reopens the invoice atomically.

### New database tables (tenant schema)
| Table | Purpose |
|---|---|
| `supplier_invoices` | AP ledger — one row per supplier bill; tracks subtotal/GST/total/paid/outstanding/status |
| `supplier_payments` | Payment register — one row per payment event; references invoice; used for audit + reversal |

### Extended columns
| Table | New column(s) |
|---|---|
| `suppliers` | `bank_account_number`, `bank_name`, `ifsc_code`, `credit_days`, `supplier_type` |
| `purchase_orders` | `module TEXT DEFAULT 'RESTAURANT'` |

### Backend endpoints (`server.ts`)
All under `/api/restaurant/:id/procurement/`:
- `GET /supplier-invoices` — list with filters (module, status, supplier, date range)
- `POST /supplier-invoices` — create invoice; auto-sets `outstanding_amount = total_amount`
- `PATCH /supplier-invoices/:id` — edit invoice; recalculates outstanding
- `DELETE /supplier-invoices/:id` — delete only if `paid_amount = 0`
- `POST /supplier-invoices/:id/payments` — record payment; mutates invoice paid/outstanding/status
- `GET /payments` — all-payments ledger (across suppliers)
- `DELETE /payments/:id` — reversal; reopens the invoice to its pre-payment state
- `GET /suppliers/:id/ledger` — supplier detail + all invoices + all payments + aging buckets (0-30, 31-60, 60+)
- `GET /reports/payables` — outstanding AP summary grouped by supplier + totals
- `GET /reports/spending` — monthly spend by module (N months) + top suppliers

### Frontend (`src/App.tsx`)
**`ProcurementView`** component (~1 000 lines, 4 sub-tabs):
1. **Supplier Invoices** — filter pills (module + status + date range + text search), create/edit invoice modal, record-payment modal (CASH/UPI/NEFT/RTGS/CHEQUE/IMPS), inline Delete/Edit/Pay actions.
2. **Payments** — all-payments ledger with Reverse action.
3. **Supplier Ledger** — per-supplier deep-dive: 4 KPI cards, aging strip, invoice table, payments table.
4. **Reports** — outstanding payables table, monthly spend by module, top suppliers.

Navigation: `PROCUREMENT` group added to `navGroups` between WORKFORCE and ADMIN, icon `<Package>`.

## Recent Feature Additions (2026-05 cycle — Inventory Module)

| Date | Feature | Commit |
|---|---|---|
| 2026-05 | **Phase 1**: Ingredients + Recipes CRUD, 11-table tenant migrations | (Phase-1 commit) |
| 2026-05 | **Phase 2**: Suppliers + PO + GRN procurement workflow | (Phase-2 commit) |
| 2026-05 | **Phase 3**: Auto-deduction hook + cancellation reversal + Wastage + Physical Counts | (Phase-3 commit) |
| 2026-05 | **Phase 4**: Day-of-week forecasting + Inventory Dashboard + nightly cron | (Phase-4 commit) |
| 2026-05 | Tier-1: Onboarding wizard (23 ingredients + 5 supplier presets) | `f7fed43` |
| 2026-05 | Tier-1: Auto-PO generation in 09:00 IST stock-low cron | `f7fed43` |
| 2026-05 | Tier-1: Recipe CSV import / export | `f7fed43` |
| 2026-05 | Tier-1: PO PDF (`poService.ts`) + Email Supplier endpoint | `f7fed43` |
| 2026-05 | Backend dedup (409 Conflict) on Ingredient/Supplier name | `a322f22` |
| 2026-05 | Filter / sort / search on all 5 inventory tables + Suppliers grid | `a322f22` |
| 2026-05 | Consumption Trend chart padded to 30 calendar days | `a322f22` |
| 2026-05 | Cleanup script removed 23 duplicate ingredients on Cloud Kitchen | `a322f22` |
| 2026-05 | CI YAML fix: `pr-notify.yml` line 53 multi-line literal-block escape | (CI fix commit) |

## Recent Feature Additions (2026-04 cycle)

| Date | Feature | Commit |
|---|---|---|
| 2026-04 | Menu type-ahead in On-Demand Invoice + Edit Invoice modals | `2cbe5be`, `3ee2a22` |
| 2026-04 | Auto-apply GST settings to new invoices | `2d676a2` |
| 2026-04 | GST persistence on session at request-bill | `f15b4e9` |
| 2026-04 | Customer-facing GST breakdown (button + modal) | `ccef038`, `92fae14` |
| 2026-04 | Manual invoice persists discount/service/GST fields | `8c5f4a0` |
| 2026-04 | Admin-gated invoice deletion (per-tenant flag + audit) | `f15b4e9`, `35e6fda` |
| 2026-04 | KPI cards no longer truncate amounts | `0dbb7ee` |
| 2026-04 | Bulletproof invoice list (orphan-orders fallback, ACTIVE sessions, search by order id) | `62a642b`, `689560e`, `ed6d368` |
| 2026-04 | Owner-configurable invoice numbering (RANDOM/SEQUENTIAL + prefix + yearly reset) | `39019b9` |
| 2026-04 | Three-point invoice number assignment (orders POST + request-bill + close-session) | `698e5c0` |
| 2026-04 | Settings save UX (Saving… → Saved ✓ banner) | `c1dd018` |
| 2026-04 | Order Management tab read-only (no per-order Print/Edit/Paid) | `f9ff5c3`, `379c57e` |
| 2026-04 | Sales pitch decks (restaurant + hotel) — `Sales and Marketing/` | `bed89ee`, `d794e12`, `1ff211c` |
| 2026-04 | Client-side POS shortcut .bat installers — `client_side/` | `2dbc7cf` |

---

## Common Bug-Fix Patterns

> ⚠ **Before merging any fix in this section: re-verify the three invoice flows.** See [Mandatory Invoice Test Matrix](#mandatory-invoice-test-matrix). Most "billing inconsistency" bugs are caused by ONE flow being updated and another being missed.

When the user reports an invoice / billing inconsistency, check in this order:

1. **Is the session still 'open' and not yet 'bill_requested'?** → ACTIVE state. Should still appear in invoice list (commit `62a642b`). Total in list should be GST-inclusive computed value (commit `0cac7e7`).
2. **Does the order have a session_id pointing to a session that doesn't exist or is in an unusual status?** → orphan-fallback should catch it (commit `689560e`, `ed6d368`).
3. **Is `invoice_numbering_mode` actually SEQUENTIAL?** Check `centralDb.get(restaurants WHERE id=?)`. The owner may have toggled it back to RANDOM unintentionally — if `display_number = #XXXXXXXX`, that's expected for RANDOM mode.
4. **Is `gst_percent` populated on the session row?** Defaults to 0; should be 5 (or whatever) after request-bill runs (commit `f15b4e9`). If still 0, the request-bill safety net at `0cac7e7` recomputes via restaurant settings on read.
5. **Search by order id not finding session-based invoice?** SESSION invoices are keyed by session_token; search now also matches `order_ids[]` (commit `ed6d368`).
6. **Diagnostic logs:** Server emits `[invoices-list] tenant → N session + M order = T total` and `[orders-post] session=… invoice_number_generated=…` and `[request-bill] OK …, gst=…%, invoice_number=…`. Grep VPS logs (`docker compose logs node_app`) when investigating.

## Mandatory Invoice Test Matrix

**Whenever any change touches pricing, discount, loyalty, GST, service charge, tax, totals, currency, or any field that lands on an invoice — the change MUST be verified against ALL THREE invoice flows before pushing to `dev`. These three paths use overlapping but distinct code paths and have repeatedly drifted apart in production.**

| # | Flow | How to trigger | What to verify |
|---|---|---|---|
| **1** | **Customer-side QR ordering (postpaid)** | Open the customer URL (e.g. `https://erp.atithi-setu.com/r/<slug>?table=1`) → scan QR → place an order with a phone number → tap **My Orders** tab → tap **Request Bill** | Running Total card, loyalty banner (Bronze / Silver / Gold), Request Bill CTA total, BillRequestModal "Session Total", and the post-request "Your Bill is Ready" invoice view all show the **same** number. UPI deep-link charges that exact amount. |
| **2** | **Manual invoice** (staff-side) | Owner login → **Invoices** tab → **New Manual Invoice** → enter customer + items + discount + GST | The preview total, the saved invoice row in the Invoices list, the downloaded PDF, and any aggregator-channel commission math all reconcile. Tax line 2 / Sec 9(5) GST / loyalty discount must each appear correctly. |
| **3** | **QR-based / postpaid session invoice** (staff-side) | Owner login → **Tables** / **Sessions** → open a session row that's `bill_requested` → **PostpaidInvoiceModal** | Banner shows recognised loyalty tier (even at 0%). Discount field auto-fills only when `session.discount_amount = 0` (no double-apply). Subtotal → discount → service → GST → grand total math agrees with what the customer saw. PDF / thermal print matches the on-screen breakdown. |

Why all three: each path computes totals slightly differently (the customer view uses local state + a public preview-discount lookup; the manual invoice uses `computeInvoiceTotals()`; the postpaid modal reads persisted `session.discount_amount` + applies loyalty if absent). A change that fixes one path can silently break another. **Asking "did you verify all three?" before merging is the rule.**

Common mismatch traps:
- Loyalty discount applied client-side but not persisted server-side → UPI charges the wrong amount.
- GST recomputed on after-discount subtotal in one view but on gross in another → ₹3-5 difference at typical bills.
- `session.discount_amount` written by `/request-bill` AND auto-applied again by the modal → double-discount.
- Manual invoice respects new tax_config rows; postpaid modal still reads single `gst_percent` field.
- Customer side displays 0% Bronze tier with no banner; staff side displays the banner → owner thinks loyalty is broken for Bronze members.

Offline verification scripts (run BEFORE pushing if math is touched):
```
node scripts/verify-invoice-math-offline.cjs   # 64 math assertions for computeInvoiceTotals
node scripts/test-invoice-math.cjs             # end-to-end math regression
```

---

## Test Manager Role & Testing Protocol

> **Role:** Senior Test Manager. Every significant feature addition or fix must pass
> both a **Technical Test** and a **Business Test** before being reported complete.
> Test scripts live in `test-scripts/E2E_Test_Scripts.csv` (Excel-compatible).
> Results are captured in the same file under Actual_Result / Status columns.

### Testing Scope

#### Technical Testing (every change)
1. **Object creation** — every entity the change touches must be creatable via the UI or API without error.
2. **Object editing** — edit forms must open, fields must be editable, save must persist.
3. **Object visibility** — no action button, modal, or form field may be hidden behind another element (z-index / overflow issues).
4. **Page navigation** — every tab/sub-tab in the affected module must load without a blank white screen or unhandled JS error.
5. **API contract** — new/changed endpoints return 2xx on happy path; 4xx on known bad inputs; never 500 on valid input.
6. **TypeScript compile** — `npx tsc --noEmit` must exit 0 after every change.
7. **Cross-module regression** — Restaurant billing, Hotel folio, and HR payroll smoke paths must still pass after any structural change.

#### Business Testing (new features + billing changes)
1. Trace the **complete business cycle** end-to-end (e.g. booking → check-in → F&B → checkout → invoice → GL entry).
2. Verify **money math**: subtotal + GST + extras − discount = grand total at every step; the folio, the invoice PDF, and the GL posting must all agree.
3. Verify **status transitions** are correct and irreversible states are blocked.
4. Verify **compliance outputs**: GST invoice has GSTIN/HSN; hotel invoice has FSSAI; TDS entry appears in GL and TDS ledger; Form-C gate fires for foreign nationals.
5. Verify **notifications** fire at the right events (check-in, check-out, payment link, pre-arrival).

### Mandatory Pre-Deploy Checklist
- [ ] `npx tsc --noEmit` — 0 errors
- [ ] `npx vite build` — succeeds
- [ ] All relevant `qa_*.mjs` scripts pass (run the ones touching changed modules)
- [ ] Technical test round executed (see `test-scripts/`)
- [ ] Business test round executed (see `test-scripts/`)
- [ ] Three-invoice-flow matrix verified (if billing code changed) — see [Mandatory Invoice Test Matrix](#mandatory-invoice-test-matrix)

### Test Artefacts
| File | Purpose |
|---|---|
| `test-scripts/E2E_Test_Scripts.csv` | Master test script — all 110 test cases, Technical + Business |
| `test-scripts/run_technical_tests.mjs` | Automated technical test runner (API-level) |
| `test-scripts/TEST_EXECUTION_REPORT.md` | Latest round results populated by the runner |

---

## Development Workflow

* **Branch:** `dev` is the canonical branch. Push to `dev` triggers GitHub Actions auto-deploy to the VPS via `.github/workflows/deploy-vps.yml`.
* **Local TypeScript noise:** `npx tsc --noEmit -p .` produces some pre-existing errors in unrelated files. Filter with `grep -E "src/App\.tsx" | grep -v <known-line>` when verifying that new edits don't introduce new errors.
* **Vite production build** (`npx vite build`) must succeed cleanly before pushing.
* **Don't `--no-verify` git pushes** — pre-commit hooks should always run.
* **Invoice changes ⇒ test all 3 flows** — see the [Mandatory Invoice Test Matrix](#mandatory-invoice-test-matrix) above. No exceptions, no matter how surgical the change appears.
