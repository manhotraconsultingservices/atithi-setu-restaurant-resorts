// ════════════════════════════════════════════════════════════════════════
// Spa & Wellness module — per-tenant schema DDL, seed, and scheduling helpers
// ════════════════════════════════════════════════════════════════════════
//
// Mirrors the Hotel module (createHotelTables / seedDefaultServices in
// server.ts) but lives in its own module to keep server.ts navigable. The
// module is gated by `restaurants.spa_enabled = 1` (default 0 → zero impact
// on every existing tenant). Spa tables are created on-demand from the
// /spa/enable endpoint and re-run at boot for spa-enabled tenants.
//
// Billing reuses the Hotel folio ledger (folios / folio_entries /
// folio_payments). Because a spa-only tenant (property_type='RESTAURANT')
// never had createHotelTables run, createSpaTables ensures those three folio
// tables exist itself (CREATE TABLE IF NOT EXISTS → no-op if hotel already
// made them) plus the spa discriminator columns (folio_kind, appointment_id).
//
// Supply-chain reuse: spa retail / back-bar products are `ingredients` rows
// tagged item_type='SPA_PRODUCT' (consumable) or 'SPA_RETAIL' (take-home),
// so they flow through the validated PO→GRN→supplier-invoice→payment chain
// with zero changes to procurement.

import { DbInterface } from "./db.ts";

// ── Pure time helpers (naive local timestamps, single-region IST app) ──────
// Timestamps are stored as `timestamp without time zone` and passed as
// 'YYYY-MM-DD HH:MM:SS' strings. We do minute arithmetic in JS to avoid any
// timezone drift.

export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = String(hhmm).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function minutesToHHMM(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Build a 'YYYY-MM-DD HH:MM:SS' timestamp string from a date + minutes-since-midnight. */
export function tsFromDateMinutes(date: string, minutes: number): string {
  return `${date} ${minutesToHHMM(minutes)}:00`;
}

/** Day-of-week 0=Sun … 6=Sat for a 'YYYY-MM-DD' date, computed without TZ ambiguity. */
export function dowOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Total booked window (minutes) for a service incl. buffers + selected add-ons. */
export function serviceWindowMinutes(
  service: { duration_min: number; buffer_before_min?: number; buffer_after_min?: number },
  addons: Array<{ extra_duration_min?: number }> = []
): number {
  const base = Number(service.duration_min || 0);
  const before = Number(service.buffer_before_min || 0);
  const after = Number(service.buffer_after_min || 0);
  const addonMins = addons.reduce((s, a) => s + Number(a.extra_duration_min || 0), 0);
  return before + base + addonMins + after;
}

// ── Conflict detection (application-level check-then-insert, matching the
// hotel booking convention — DbInterface exposes no cross-statement txn) ────
// Half-open interval overlap: (newStart < existingEnd) AND (newEnd > existingStart).

/** Returns a conflicting appointment row for a therapist, or null. */
export async function therapistConflict(
  tenantDb: DbInterface, therapistId: string, startAt: string, endAt: string, excludeApptId?: string
): Promise<any | null> {
  const rows = await tenantDb.query(
    `SELECT id, start_at, end_at FROM spa_appointments
      WHERE therapist_id = ?
        AND status NOT IN ('CANCELLED','NO_SHOW')
        AND start_at < ? AND end_at > ?
        ${excludeApptId ? "AND id <> ?" : ""}
      LIMIT 1`,
    excludeApptId ? [therapistId, endAt, startAt, excludeApptId] : [therapistId, endAt, startAt]
  );
  return rows[0] || null;
}

/** Returns a conflicting appointment row for a resource/cabin, or null. */
export async function resourceConflict(
  tenantDb: DbInterface, resourceId: string, startAt: string, endAt: string, excludeApptId?: string
): Promise<any | null> {
  const rows = await tenantDb.query(
    `SELECT id, start_at, end_at FROM spa_appointments
      WHERE resource_id = ?
        AND status NOT IN ('CANCELLED','NO_SHOW')
        AND start_at < ? AND end_at > ?
        ${excludeApptId ? "AND id <> ?" : ""}
      LIMIT 1`,
    excludeApptId ? [resourceId, endAt, startAt, excludeApptId] : [resourceId, endAt, startAt]
  );
  return rows[0] || null;
}

/** Returns a manual block (THERAPIST or RESOURCE) overlapping the window, or null. */
export async function blockConflict(
  tenantDb: DbInterface, scope: "THERAPIST" | "RESOURCE", scopeId: string, startAt: string, endAt: string
): Promise<any | null> {
  const rows = await tenantDb.query(
    `SELECT id, reason FROM spa_resource_blocks
      WHERE scope = ? AND scope_id = ?
        AND start_at < ? AND end_at > ?
      LIMIT 1`,
    [scope, scopeId, endAt, startAt]
  );
  return rows[0] || null;
}

// ── Dual-resource availability slot engine ─────────────────────────────────
// For a service + date (+ optional therapist filter), returns bookable slots,
// each carrying BOTH a free therapist and a free resource. Granularity = 30m.

export interface SpaSlot {
  start_at: string;
  end_at: string;
  therapist_id: string;
  therapist_name: string;
  resource_id: string | null;
  resource_name: string | null;
}

export async function findAvailableSlots(
  tenantDb: DbInterface,
  opts: { serviceId: string; date: string; therapistId?: string; granularityMin?: number; maxSlots?: number }
): Promise<SpaSlot[]> {
  const granularity = opts.granularityMin || 30;
  const maxSlots = opts.maxSlots || 60;

  const service: any = await tenantDb.get(
    "SELECT * FROM spa_services WHERE id = ? AND is_active = 1", [opts.serviceId]
  );
  if (!service) return [];
  const window = serviceWindowMinutes(service);
  const needRoom = Number(service.requires_room ?? 1) === 1;
  const needTherapist = Number(service.requires_therapist ?? 1) === 1;
  const dow = dowOf(opts.date);

  // Eligible therapists: have the skill + a schedule covering this weekday.
  // (If the service doesn't require a therapist we still return one lane using
  // any scheduled therapist, so the slot always carries an operator.)
  let therapists: any[] = await tenantDb.query(
    `SELECT DISTINCT t.id, t.display_name, s.start_time, s.end_time
       FROM spa_therapists t
       JOIN spa_therapist_schedules s ON s.therapist_id = t.id AND s.weekday = ?
       LEFT JOIN spa_therapist_services ts ON ts.therapist_id = t.id AND ts.service_id = ?
      WHERE t.is_active = 1
        ${needTherapist ? "AND ts.service_id IS NOT NULL" : ""}
        ${opts.therapistId ? "AND t.id = ?" : ""}
      ORDER BY t.display_name`,
    needTherapist
      ? (opts.therapistId ? [dow, opts.serviceId, opts.therapistId] : [dow, opts.serviceId])
      : (opts.therapistId ? [dow, opts.serviceId, opts.therapistId] : [dow, opts.serviceId])
  );

  // Active resources/cabins (only needed when the service requires a room).
  const resources: any[] = needRoom
    ? await tenantDb.query("SELECT id, name FROM spa_resources WHERE is_active = 1 ORDER BY name")
    : [];

  const slots: SpaSlot[] = [];
  for (const t of therapists) {
    const schedStart = hhmmToMinutes(t.start_time);
    const schedEnd = hhmmToMinutes(t.end_time);
    for (let startMin = schedStart; startMin + window <= schedEnd; startMin += granularity) {
      if (slots.length >= maxSlots) return slots;
      const endMin = startMin + window;
      const startAt = tsFromDateMinutes(opts.date, startMin);
      const endAt = tsFromDateMinutes(opts.date, endMin);

      // therapist free?
      if (await therapistConflict(tenantDb, t.id, startAt, endAt)) continue;
      if (await blockConflict(tenantDb, "THERAPIST", t.id, startAt, endAt)) continue;

      // resource free? (pick first available cabin)
      let chosenResource: any = null;
      if (needRoom) {
        for (const r of resources) {
          if (await resourceConflict(tenantDb, r.id, startAt, endAt)) continue;
          if (await blockConflict(tenantDb, "RESOURCE", r.id, startAt, endAt)) continue;
          chosenResource = r;
          break;
        }
        if (!chosenResource) continue; // no free cabin for this slot
      }

      slots.push({
        start_at: startAt,
        end_at: endAt,
        therapist_id: t.id,
        therapist_name: t.display_name,
        resource_id: chosenResource ? chosenResource.id : null,
        resource_name: chosenResource ? chosenResource.name : null,
      });
    }
  }
  return slots;
}

// ════════════════════════════════════════════════════════════════════════
// Schema — idempotent. Safe to call repeatedly. Every ALTER wrapped in
// .catch(() => {}) so one transient failure can't poison the cached DbInterface.
// ════════════════════════════════════════════════════════════════════════

export async function createSpaTables(tenantDb: DbInterface): Promise<void> {
  // ── Folio ledger (reused from Hotel). Self-create for spa-only tenants
  // (property_type='RESTAURANT') that never ran createHotelTables. IF NOT
  // EXISTS → no-op when hotel already created them. Schema matches the hotel
  // definition in server.ts; the two spa columns are added via ALTER below.
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS folios (
      id              TEXT PRIMARY KEY,
      booking_id      TEXT,
      room_id         TEXT,
      status          TEXT DEFAULT 'open',
      subtotal        DOUBLE PRECISION DEFAULT 0,
      gst_amount      DOUBLE PRECISION DEFAULT 0,
      service_charge  DOUBLE PRECISION DEFAULT 0,
      discount        DOUBLE PRECISION DEFAULT 0,
      grand_total     DOUBLE PRECISION DEFAULT 0,
      payment_method  TEXT,
      settled_at      TIMESTAMP,
      doc_type        TEXT DEFAULT 'INVOICE',
      parent_folio_id TEXT,
      reason          TEXT,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS folio_entries (
      id         TEXT PRIMARY KEY,
      folio_id   TEXT,
      entry_type TEXT,
      description TEXT,
      quantity   INT DEFAULT 1,
      unit_price DOUBLE PRECISION,
      amount     DOUBLE PRECISION,
      gst_rate   DOUBLE PRECISION,
      gst_amount DOUBLE PRECISION,
      source_id  TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS folio_payments (
      id               TEXT PRIMARY KEY,
      folio_id         TEXT NOT NULL,
      amount           DOUBLE PRECISION NOT NULL,
      payment_method   TEXT NOT NULL,
      payment_type     TEXT NOT NULL DEFAULT 'INTERIM',
      reference_number TEXT,
      recorded_by      TEXT,
      recorded_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      notes            TEXT,
      is_voided        INT DEFAULT 0,
      voided_at        TIMESTAMP,
      voided_by        TEXT,
      voided_reason    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_folio_entries_folio ON folio_entries(folio_id);
    CREATE INDEX IF NOT EXISTS idx_folio_payments_folio ON folio_payments(folio_id, recorded_at);
  `);
  // Folio columns that the hotel block also adds (idempotent — needed for the
  // spa-only-tenant path where the hotel block never ran).
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS currency_snapshot TEXT`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS tax_label_snapshot TEXT`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS gst_exempt INTEGER DEFAULT 0`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS gst_exempt_reason TEXT`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS folio_kind TEXT DEFAULT 'HOTEL'`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS appointment_id TEXT`).catch(() => {});
  // Spa folios carry their own invoice number (SPA-<year>-NNNNN). Hotel folios
  // derive the number from the folio id at render time and leave this NULL.
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS invoice_number TEXT`).catch(() => {});

  // ── Catalog ──────────────────────────────────────────────────────────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS spa_services (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      category           TEXT DEFAULT 'MASSAGE',
      description        TEXT,
      duration_min       INT NOT NULL DEFAULT 60,
      buffer_before_min  INT DEFAULT 0,
      buffer_after_min   INT DEFAULT 10,
      price              DOUBLE PRECISION NOT NULL DEFAULT 0,
      gst_percent        DOUBLE PRECISION DEFAULT 18,
      requires_room      INT DEFAULT 1,
      requires_therapist INT DEFAULT 1,
      commission_pct     DOUBLE PRECISION DEFAULT 0,
      image_url          TEXT,
      display_order      INT DEFAULT 0,
      is_active          INT DEFAULT 1,
      created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_services_category ON spa_services(category);

    CREATE TABLE IF NOT EXISTS spa_service_addons (
      id                TEXT PRIMARY KEY,
      service_id        TEXT NOT NULL,
      name              TEXT NOT NULL,
      extra_duration_min INT DEFAULT 0,
      extra_price       DOUBLE PRECISION DEFAULT 0,
      gst_percent       DOUBLE PRECISION DEFAULT 18,
      is_active         INT DEFAULT 1,
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_addons_service ON spa_service_addons(service_id);

    -- Supply-chain bridge: which inventory items a service consumes per delivery.
    -- ingredient_id → ingredients (item_type='SPA_PRODUCT'); completing the
    -- appointment writes a negative stock_movement, the same audit log the
    -- restaurant/hotel inventory uses.
    CREATE TABLE IF NOT EXISTS spa_service_consumables (
      id            TEXT PRIMARY KEY,
      service_id    TEXT NOT NULL,
      ingredient_id TEXT NOT NULL,
      qty_per_service DOUBLE PRECISION NOT NULL DEFAULT 0,
      unit          TEXT,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_consumables_service ON spa_service_consumables(service_id);
  `);

  // ── Dual-resource scheduling ───────────────────────────────────────────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS spa_resources (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      resource_type TEXT DEFAULT 'CABIN',
      capacity      INT DEFAULT 1,
      notes         TEXT,
      is_active     INT DEFAULT 1,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Thin therapist profile referencing the shared staff directory so
    -- commissions/payroll stay in attendance_staff. staff_id is optional
    -- (a therapist may exist before being added as a login/offline staff).
    CREATE TABLE IF NOT EXISTS spa_therapists (
      id                   TEXT PRIMARY KEY,
      staff_id             TEXT,
      display_name         TEXT NOT NULL,
      bio                  TEXT,
      commission_pct_override DOUBLE PRECISION,
      is_active            INT DEFAULT 1,
      created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS spa_therapist_services (
      id           TEXT PRIMARY KEY,
      therapist_id TEXT NOT NULL,
      service_id   TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_spa_ther_svc_unique ON spa_therapist_services(therapist_id, service_id);

    CREATE TABLE IF NOT EXISTS spa_therapist_schedules (
      id             TEXT PRIMARY KEY,
      therapist_id   TEXT NOT NULL,
      weekday        INT NOT NULL,            -- 0=Sun … 6=Sat
      start_time     TEXT NOT NULL,           -- 'HH:MM'
      end_time       TEXT NOT NULL,           -- 'HH:MM'
      effective_from TEXT,
      effective_to   TEXT,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_sched_ther ON spa_therapist_schedules(therapist_id, weekday);

    CREATE TABLE IF NOT EXISTS spa_resource_blocks (
      id         TEXT PRIMARY KEY,
      scope      TEXT NOT NULL,               -- THERAPIST | RESOURCE
      scope_id   TEXT NOT NULL,
      start_at   TIMESTAMP NOT NULL,
      end_at     TIMESTAMP NOT NULL,
      reason     TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_blocks_scope ON spa_resource_blocks(scope, scope_id);
  `);

  // ── Client CRM + forms (med-spa-ready) ─────────────────────────────────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS spa_clients (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      phone            TEXT,
      email            TEXT,
      gender           TEXT,
      dob              TEXT,
      preferences      TEXT,
      tags             TEXT,
      marketing_opt_in INT DEFAULT 0,
      linked_guest_phone TEXT,
      notes            TEXT,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_clients_phone ON spa_clients(phone);

    CREATE TABLE IF NOT EXISTS spa_client_intake_forms (
      id            TEXT PRIMARY KEY,
      client_id     TEXT NOT NULL,
      appointment_id TEXT,
      form_type     TEXT DEFAULT 'INTAKE',     -- INTAKE | CONSENT | (med-spa: MEDICAL_HISTORY | MEDICAL_CONSENT)
      responses     TEXT,                      -- JSON
      signature_url TEXT,
      signed_at     TIMESTAMP,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_forms_client ON spa_client_intake_forms(client_id);

    -- Med-spa-ready clinical stubs — created now, NOT written by day-spa flows.
    -- Having the tables means the clinical layer is purely additive later (no
    -- ALTER on a large table, FK targets already exist).
    CREATE TABLE IF NOT EXISTS spa_clinical_notes (
      id               TEXT PRIMARY KEY,
      client_id        TEXT NOT NULL,
      appointment_id   TEXT,
      soap_subjective  TEXT,
      soap_objective   TEXT,
      soap_assessment  TEXT,
      soap_plan        TEXT,
      provider_id      TEXT,
      locked_at        TIMESTAMP,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS spa_client_photos (
      id             TEXT PRIMARY KEY,
      client_id      TEXT NOT NULL,
      appointment_id TEXT,
      photo_url      TEXT,
      photo_kind     TEXT,                     -- BEFORE | AFTER | PROGRESS
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Appointments ───────────────────────────────────────────────────────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS spa_appointments (
      id              TEXT PRIMARY KEY,
      client_id       TEXT,
      client_name     TEXT,
      client_phone    TEXT,
      service_id      TEXT NOT NULL,
      service_name    TEXT,
      addon_ids       TEXT,                    -- JSON array
      therapist_id    TEXT,
      resource_id     TEXT,
      start_at        TIMESTAMP NOT NULL,
      end_at          TIMESTAMP NOT NULL,
      status          TEXT DEFAULT 'BOOKED',   -- BOOKED|CONFIRMED|CHECKED_IN|IN_PROGRESS|COMPLETED|CANCELLED|NO_SHOW
      price_snapshot  DOUBLE PRECISION DEFAULT 0,
      gst_snapshot    DOUBLE PRECISION DEFAULT 0,
      gst_percent_snapshot DOUBLE PRECISION DEFAULT 0,
      deposit_amount  DOUBLE PRECISION DEFAULT 0,
      booking_source  TEXT DEFAULT 'STAFF',    -- STAFF | ONLINE
      intake_form_id  TEXT,
      package_redemption_id TEXT,
      membership_id   TEXT,
      folio_id        TEXT,
      notes           TEXT,
      cancelled_at    TIMESTAMP,
      cancellation_reason TEXT,
      no_show_at      TIMESTAMP,
      completed_at    TIMESTAMP,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_appt_therapist_time ON spa_appointments(therapist_id, start_at, end_at);
    CREATE INDEX IF NOT EXISTS idx_spa_appt_resource_time ON spa_appointments(resource_id, start_at, end_at);
    CREATE INDEX IF NOT EXISTS idx_spa_appt_status ON spa_appointments(status);
    CREATE INDEX IF NOT EXISTS idx_spa_appt_client ON spa_appointments(client_id);
  `);

  // ── Packages (prepaid series, auto-deduct) ─────────────────────────────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS spa_packages (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      service_id     TEXT,                     -- NULL = any service
      total_sessions INT NOT NULL DEFAULT 1,
      price          DOUBLE PRECISION NOT NULL DEFAULT 0,
      gst_percent    DOUBLE PRECISION DEFAULT 18,
      validity_days  INT DEFAULT 365,
      is_active      INT DEFAULT 1,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS spa_client_packages (
      id                TEXT PRIMARY KEY,
      client_id         TEXT NOT NULL,
      package_id        TEXT NOT NULL,
      package_name      TEXT,
      service_id        TEXT,
      sessions_total    INT NOT NULL DEFAULT 0,
      sessions_remaining INT NOT NULL DEFAULT 0,
      price_paid        DOUBLE PRECISION DEFAULT 0,
      expires_at        TIMESTAMP,
      folio_id          TEXT,
      status            TEXT DEFAULT 'ACTIVE', -- ACTIVE | EXPIRED | EXHAUSTED
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_client_pkg_client ON spa_client_packages(client_id, status);

    CREATE TABLE IF NOT EXISTS spa_package_redemptions (
      id                TEXT PRIMARY KEY,
      client_package_id TEXT NOT NULL,
      appointment_id    TEXT,
      sessions_drawn    INT DEFAULT 1,
      redeemed_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Memberships (tiered, auto-applied benefits) ────────────────────────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS spa_membership_plans (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      tier          TEXT,
      monthly_fee   DOUBLE PRECISION NOT NULL DEFAULT 0,
      gst_percent   DOUBLE PRECISION DEFAULT 18,
      benefits      TEXT,                      -- JSON {discount_pct, free_services_per_month, included_service_ids}
      is_active     INT DEFAULT 1,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS spa_client_memberships (
      id                       TEXT PRIMARY KEY,
      client_id                TEXT NOT NULL,
      plan_id                  TEXT NOT NULL,
      plan_name                TEXT,
      benefits_snapshot        TEXT,
      current_period_start     TEXT,
      current_period_end       TEXT,
      benefits_used_this_period TEXT,          -- JSON
      status                   TEXT DEFAULT 'ACTIVE', -- ACTIVE | CANCELLED | EXPIRED
      folio_id                 TEXT,
      created_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_client_mem_client ON spa_client_memberships(client_id, status);
  `);

  // ── Gift cards (parity) ────────────────────────────────────────────────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS spa_gift_cards (
      id            TEXT PRIMARY KEY,
      code          TEXT NOT NULL,
      initial_value DOUBLE PRECISION NOT NULL DEFAULT 0,
      balance       DOUBLE PRECISION NOT NULL DEFAULT 0,
      purchaser_name TEXT,
      recipient_name TEXT,
      expires_at    TIMESTAMP,
      status        TEXT DEFAULT 'ACTIVE',
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_spa_gift_code ON spa_gift_cards(code);
    CREATE TABLE IF NOT EXISTS spa_gift_card_txns (
      id           TEXT PRIMARY KEY,
      gift_card_id TEXT NOT NULL,
      delta        DOUBLE PRECISION NOT NULL,
      reason       TEXT,
      folio_id     TEXT,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Public-facing spa profile (hero image, tagline, offers bulletin) ─────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS spa_profile (
      restaurant_id  TEXT PRIMARY KEY,
      hero_image_url TEXT,
      tagline        TEXT,
      offers         TEXT,
      updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// ════════════════════════════════════════════════════════════════════════
// Seed — idempotent. Guarded by an existence check so re-enabling never
// duplicates. Seeds enough to demo the full loop (incl. a SPA_PRODUCT
// consumable + a SPA_RETAIL item so the supply-chain link is exercisable).
// Returns the number of services seeded (0 if already populated).
// ════════════════════════════════════════════════════════════════════════

function genId(prefix: string): string {
  // Time-ordered-ish id without relying on Date in workflow contexts; here in
  // the server runtime Date is available.
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function seedSpaDefaults(tenantDb: DbInterface): Promise<number> {
  const existing: any = await tenantDb.get("SELECT COUNT(*)::int AS c FROM spa_services");
  if (Number(existing?.c || 0) > 0) return 0;

  const services = [
    { name: "Swedish Massage", category: "MASSAGE", duration: 60, price: 2500 },
    { name: "Deep Tissue Massage", category: "MASSAGE", duration: 90, price: 3500 },
    { name: "Aromatherapy Massage", category: "MASSAGE", duration: 60, price: 2800 },
    { name: "Classic Facial", category: "FACIAL", duration: 45, price: 1800 },
    { name: "Anti-Ageing Facial", category: "FACIAL", duration: 75, price: 3200 },
    { name: "Body Scrub & Wrap", category: "BODY", duration: 90, price: 3800 },
    { name: "Sauna Session", category: "SAUNA", duration: 30, price: 900, requires_therapist: 0 },
    { name: "Manicure & Pedicure", category: "SALON", duration: 60, price: 1500 },
  ];
  const serviceIds: string[] = [];
  let order = 0;
  for (const s of services) {
    const id = genId("SPASVC");
    serviceIds.push(id);
    await tenantDb.run(
      `INSERT INTO spa_services (id, name, category, duration_min, buffer_after_min, price, gst_percent, requires_room, requires_therapist, display_order, is_active)
       VALUES (?, ?, ?, ?, 10, ?, 18, 1, ?, ?, 1)`,
      [id, s.name, s.category, s.duration, s.price, (s as any).requires_therapist ?? 1, order++]
    );
  }

  // Add-on for the first service
  await tenantDb.run(
    `INSERT INTO spa_service_addons (id, service_id, name, extra_duration_min, extra_price, gst_percent, is_active)
     VALUES (?, ?, 'Hot Stone Add-on', 15, 600, 18, 1)`,
    [genId("SPAADD"), serviceIds[0]]
  );

  // Treatment cabins
  for (const name of ["Cabin 1", "Cabin 2", "Cabin 3"]) {
    await tenantDb.run(
      `INSERT INTO spa_resources (id, name, resource_type, capacity, is_active) VALUES (?, ?, 'CABIN', 1, 1)`,
      [genId("SPARES"), name]
    );
  }

  // Supply-chain demo items as ingredients (item_type discriminator) — these
  // flow through the validated PO→GRN→supplier-invoice→payment chain. Only
  // seeded if not already present (name match) to stay idempotent.
  const oil: any = await tenantDb.get("SELECT id FROM ingredients WHERE name = 'Spa Massage Oil' LIMIT 1");
  let oilId = oil?.id;
  if (!oilId) {
    oilId = genId("ING");
    await tenantDb.run(
      `INSERT INTO ingredients (id, name, item_type, category, unit, current_stock_qty, reorder_point, par_level, default_unit_price, gst_percent, is_active)
       VALUES (?, 'Spa Massage Oil', 'SPA_PRODUCT', 'Spa Supplies', 'l', 10, 2, 20, 800, 18, 1)`,
      [oilId]
    );
  }
  const candle: any = await tenantDb.get("SELECT id FROM ingredients WHERE name = 'Aroma Candle (Retail)' LIMIT 1");
  if (!candle?.id) {
    await tenantDb.run(
      `INSERT INTO ingredients (id, name, item_type, category, unit, current_stock_qty, reorder_point, par_level, default_unit_price, gst_percent, is_active)
       VALUES (?, 'Aroma Candle (Retail)', 'SPA_RETAIL', 'Spa Retail', 'pcs', 25, 5, 50, 450, 18, 1)`,
      [genId("ING")]
    );
  }
  // Link the first massage service to consume oil
  await tenantDb.run(
    `INSERT INTO spa_service_consumables (id, service_id, ingredient_id, qty_per_service, unit)
     VALUES (?, ?, ?, 0.05, 'l')`,
    [genId("SPACON"), serviceIds[0], oilId]
  );

  // Sample prepaid package + membership
  await tenantDb.run(
    `INSERT INTO spa_packages (id, name, service_id, total_sessions, price, gst_percent, validity_days, is_active)
     VALUES (?, '5 Massage Series', ?, 5, 11000, 18, 180, 1)`,
    [genId("SPAPKG"), serviceIds[0]]
  );
  await tenantDb.run(
    `INSERT INTO spa_membership_plans (id, name, tier, monthly_fee, gst_percent, benefits, is_active)
     VALUES (?, 'Wellness Club', 'GOLD', 1999, 18, ?, 1)`,
    [genId("SPAMEM"), JSON.stringify({ discount_pct: 10, free_services_per_month: 0, included_service_ids: [] })]
  );

  return serviceIds.length;
}
