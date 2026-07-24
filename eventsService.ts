// ════════════════════════════════════════════════════════════════════════
// Events & Convention Center module — per-tenant schema DDL + seed + helpers
// ════════════════════════════════════════════════════════════════════════
//
// A fully-isolated module for tenants running banquet / marriage halls,
// convention centers, and catering. Mirrors the Spa module's isolation
// contract: gated by `restaurants.events_enabled = 1` (default 0 → zero impact
// on every existing tenant). Tables are created on-demand from the
// /events/enable endpoint and re-run at boot for events-enabled tenants.
//
// Cross-module rule (user-mandated): this module NEVER queries hotel/restaurant/
// spa tables directly. Hotel rooms attached to an event are read (availability +
// rate) and later booked through the Hotel HTTP API. The only shared structure
// is the folio ledger (folios / folio_entries / folio_payments), reused for
// billing with folio_kind='EVENT' — createEventTables self-creates those three
// (IF NOT EXISTS → no-op when hotel/spa already made them) so an events-only
// tenant (property_type='RESTAURANT', spa_enabled=0) can still bill.
//
// exec() note: each CREATE TABLE is its own statement. We intentionally keep
// ALTER-after-CREATE ordering correct within this file so a partial exec never
// strands a later table (the class of bug fixed in createHotelTables).

import { DbInterface } from "./db.ts";

// ── Pure helpers ───────────────────────────────────────────────────────────

/** Day-of-week 0=Sun … 6=Sat for a 'YYYY-MM-DD' date, TZ-safe. */
export function eventDow(date: string): number {
  const [y, m, d] = String(date).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Minutes since midnight for an 'HH:MM' string. */
export function hhmmToMin(hhmm: string): number {
  const [h, m] = String(hhmm || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Resolve the venue charge for a booking window.
 * rate_basis: 'HOURLY' → hourly_rate × hours; 'HALF_DAY' → half_day_rate;
 * 'DAILY' (default) → daily_rate. Falls back gracefully when a rate is 0/NULL.
 */
export function resolveVenueCharge(
  venue: { hourly_rate?: number; half_day_rate?: number; daily_rate?: number },
  rateBasis: string,
  startTime?: string,
  endTime?: string
): number {
  const hourly = Number(venue.hourly_rate || 0);
  const half = Number(venue.half_day_rate || 0);
  const daily = Number(venue.daily_rate || 0);
  if (rateBasis === "HOURLY" && startTime && endTime) {
    const hrs = Math.max(0, (hhmmToMin(endTime) - hhmmToMin(startTime)) / 60);
    return Math.round(hourly * hrs * 100) / 100;
  }
  if (rateBasis === "HALF_DAY") return half || daily;
  return daily;
}

/** Normalize a DATE value (pg returns Date objects) to a YYYY-MM-DD string. */
function ymdStr(v: any): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v || '').slice(0, 10);
}

/**
 * Returns a conflicting event booking on a venue for the given date range +
 * time window, or null. Supports multi-day events (end_date) and overnight
 * events (end_date = next day). Date ranges overlap when
 * `newStart <= existingEnd AND existingStart <= newEnd`. When BOTH bookings are
 * single-day on the same date, time-of-day overlap is additionally required;
 * if either spans multiple days, any date overlap is a conflict.
 * Only CONFIRMED / IN_PROGRESS bookings hold the venue (INQUIRY/QUOTED do not).
 */
export async function venueBookingConflict(
  tenantDb: DbInterface,
  venueId: string,
  eventDate: string,
  endDate: string | null,
  startTime: string,
  endTime: string,
  excludeBookingId?: string
): Promise<any | null> {
  const newStart = ymdStr(eventDate);
  const ed = endDate ? ymdStr(endDate) : '';
  const newEnd = ed && ed > newStart ? ed : newStart;
  const rows = await tenantDb.query(
    `SELECT id, event_date, end_date, start_time, end_time FROM event_bookings
      WHERE venue_id = ?
        AND status IN ('CONFIRMED','IN_PROGRESS')
        AND event_date <= ?
        AND COALESCE(end_date, event_date) >= ?
        ${excludeBookingId ? "AND id <> ?" : ""}`,
    excludeBookingId
      ? [venueId, newEnd, newStart, excludeBookingId]
      : [venueId, newEnd, newStart]
  );
  for (const r of rows) {
    const exStart = ymdStr(r.event_date);
    const exEnd = ymdStr(r.end_date || r.event_date) > exStart ? ymdStr(r.end_date) : exStart;
    // Either side multi-day → date overlap alone is a conflict.
    if (newEnd > newStart || exEnd > exStart) return r;
    // Both single-day on the same date → require time-of-day overlap.
    if (exStart === newStart && String(r.start_time) < endTime && String(r.end_time) > startTime) return r;
  }
  return null;
}

/** Returns a venue block (maintenance/hold) overlapping the date, or null. */
export async function venueBlockConflict(
  tenantDb: DbInterface,
  venueId: string,
  eventDate: string
): Promise<any | null> {
  const rows = await tenantDb.query(
    `SELECT id, reason FROM event_venue_blocks
      WHERE venue_id = ? AND from_date <= ? AND to_date >= ?
      LIMIT 1`,
    [venueId, eventDate, eventDate]
  );
  return rows[0] || null;
}

/**
 * Committed quantity of a rental item across all CONFIRMED/IN_PROGRESS bookings
 * on a given date. Used to warn on over-allocation (owned − committed < needed).
 */
export async function rentalCommittedQty(
  tenantDb: DbInterface,
  rentalItemId: string,
  eventDate: string,
  excludeBookingId?: string
): Promise<number> {
  const rows = await tenantDb.query(
    `SELECT COALESCE(SUM(bi.quantity),0)::int AS qty
       FROM event_booking_items bi
       JOIN event_bookings b ON b.id = bi.booking_id
      WHERE bi.rental_item_id = ?
        AND b.event_date = ?
        AND b.status IN ('CONFIRMED','IN_PROGRESS')
        ${excludeBookingId ? "AND b.id <> ?" : ""}`,
    excludeBookingId ? [rentalItemId, eventDate, excludeBookingId] : [rentalItemId, eventDate]
  );
  return Number(rows[0]?.qty || 0);
}

// ── Schema ─────────────────────────────────────────────────────────────────

export async function createEventTables(tenantDb: DbInterface): Promise<void> {
  // Folio ledger (reused from Hotel/Spa). Self-create for events-only tenants.
  // IF NOT EXISTS → no-op when hotel/spa already created them.
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
  // Folio columns the hotel/spa blocks also add (idempotent for events-only path).
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS currency_snapshot TEXT`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS tax_label_snapshot TEXT`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS gst_exempt INTEGER DEFAULT 0`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS gst_exempt_reason TEXT`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS folio_kind TEXT DEFAULT 'HOTEL'`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS appointment_id TEXT`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS invoice_number TEXT`).catch(() => {});
  // Event folios link back to the originating event booking.
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS event_booking_id TEXT`).catch(() => {});

  // ── Convention halls / venues ──────────────────────────────────────────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS event_venues (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      category       TEXT DEFAULT 'BANQUET',   -- BANQUET | LAWN | CONFERENCE | PARTY_HALL | OPEN_GROUND
      ac_type        TEXT DEFAULT 'AC',        -- AC | NON_AC
      min_occupancy  INT DEFAULT 0,
      max_occupancy  INT DEFAULT 0,
      floor_area     TEXT,                     -- free text e.g. "5000 sq ft"
      hourly_rate    DOUBLE PRECISION DEFAULT 0,
      half_day_rate  DOUBLE PRECISION DEFAULT 0,
      daily_rate     DOUBLE PRECISION DEFAULT 0,
      gst_percent    DOUBLE PRECISION DEFAULT 18,
      amenities      TEXT,
      image_url      TEXT,
      is_active      INT DEFAULT 1,
      display_order  INT DEFAULT 0,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_event_venues_active ON event_venues(is_active, display_order);
  `);

  // ── Rentable inventory master (tables, chairs, sofas, cylinders, plates) ────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS event_rental_items (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      category       TEXT DEFAULT 'FURNITURE', -- FURNITURE | KITCHEN | DECOR | AV | UTILITY | OTHER
      unit           TEXT DEFAULT 'piece',     -- piece | set | pair
      quantity_owned INT DEFAULT 0,            -- total stock available to rent out
      rent_hourly    DOUBLE PRECISION DEFAULT 0,
      rent_daily     DOUBLE PRECISION DEFAULT 0,
      rent_weekly    DOUBLE PRECISION DEFAULT 0,
      deposit        DOUBLE PRECISION DEFAULT 0,
      gst_percent    DOUBLE PRECISION DEFAULT 18,
      is_active      INT DEFAULT 1,
      display_order  INT DEFAULT 0,
      notes          TEXT,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_event_rentals_category ON event_rental_items(category);
  `);

  // ── Add-on services (serving staff, security, parking, decoration, …) ───────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS event_services (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      category     TEXT DEFAULT 'STAFF',       -- STAFF | SECURITY | PARKING | DECORATION | CATERING | AV | OTHER
      pricing_type TEXT DEFAULT 'PER_EVENT',   -- PER_EVENT | PER_HOUR | PER_DAY | PER_PERSON | PER_UNIT
      rate         DOUBLE PRECISION DEFAULT 0,
      gst_percent  DOUBLE PRECISION DEFAULT 18,
      is_active    INT DEFAULT 1,
      display_order INT DEFAULT 0,
      notes        TEXT,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_event_services_category ON event_services(category);
  `);

  // ── Bookings (the event) — mirrors room_bookings lifecycle patterns ─────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS event_bookings (
      id               TEXT PRIMARY KEY,
      venue_id         TEXT,
      customer_name    TEXT NOT NULL,
      customer_phone   TEXT,
      customer_email   TEXT,
      customer_gstin   TEXT,
      event_type       TEXT,                   -- WEDDING | RECEPTION | CONFERENCE | BIRTHDAY | CORPORATE | OTHER
      status           TEXT DEFAULT 'INQUIRY', -- INQUIRY | QUOTED | CONFIRMED | IN_PROGRESS | COMPLETED | CANCELLED
      event_date       DATE,
      end_date         DATE,                   -- multi-day events (NULL = single-day)
      start_time       TEXT DEFAULT '10:00',
      end_time         TEXT DEFAULT '22:00',
      venue_rate_basis TEXT DEFAULT 'DAILY',   -- HOURLY | HALF_DAY | DAILY
      guest_count      INT DEFAULT 0,
      booking_source   TEXT DEFAULT 'DIRECT',
      venue_rate       DOUBLE PRECISION DEFAULT 0,
      total_amount     DOUBLE PRECISION DEFAULT 0,
      advance_amount   DOUBLE PRECISION DEFAULT 0,
      discount         DOUBLE PRECISION DEFAULT 0,
      special_requests TEXT,
      folio_id         TEXT,
      created_by       TEXT,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      cancelled_at     TIMESTAMP,
      cancelled_by     TEXT,
      cancellation_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_event_bookings_date ON event_bookings(event_date);
    CREATE INDEX IF NOT EXISTS idx_event_bookings_status ON event_bookings(status);
    CREATE INDEX IF NOT EXISTS idx_event_bookings_venue ON event_bookings(venue_id, event_date);
  `);

  // ── Booking line items: rentals, services, hotel rooms ──────────────────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS event_booking_items (
      id             TEXT PRIMARY KEY,
      booking_id     TEXT NOT NULL,
      rental_item_id TEXT,
      name_snapshot  TEXT,
      quantity       INT DEFAULT 1,
      rate_basis     TEXT DEFAULT 'DAILY',     -- HOURLY | DAILY | WEEKLY
      unit_rate      DOUBLE PRECISION DEFAULT 0,
      duration_units DOUBLE PRECISION DEFAULT 1, -- number of hours/days/weeks
      gst_percent    DOUBLE PRECISION DEFAULT 18,
      line_total     DOUBLE PRECISION DEFAULT 0,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_event_bkg_items ON event_booking_items(booking_id);

    CREATE TABLE IF NOT EXISTS event_booking_services (
      id               TEXT PRIMARY KEY,
      booking_id       TEXT NOT NULL,
      service_id       TEXT,
      name_snapshot    TEXT,
      pricing_snapshot TEXT,
      quantity         DOUBLE PRECISION DEFAULT 1,
      unit_rate        DOUBLE PRECISION DEFAULT 0,
      gst_percent      DOUBLE PRECISION DEFAULT 18,
      line_total       DOUBLE PRECISION DEFAULT 0,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_event_bkg_services ON event_booking_services(booking_id);

    -- Hotel rooms attached to an event. hotel_booking_id stays NULL until the
    -- event is CONFIRMED, at which point the real hotel booking is created via
    -- the Hotel API and its id is stored here. quoted_rate is a snapshot read
    -- from the Hotel availability API at quote time.
    CREATE TABLE IF NOT EXISTS event_booking_rooms (
      id                 TEXT PRIMARY KEY,
      booking_id         TEXT NOT NULL,
      hotel_booking_id   TEXT,
      room_type_id       TEXT,
      room_type_snapshot TEXT,
      check_in_date      DATE,
      check_out_date     DATE,
      num_rooms          INT DEFAULT 1,
      quoted_rate        DOUBLE PRECISION DEFAULT 0,
      gst_percent        DOUBLE PRECISION DEFAULT 12,
      line_total         DOUBLE PRECISION DEFAULT 0,
      status             TEXT DEFAULT 'QUOTED', -- QUOTED | BOOKED | FAILED | CANCELLED
      created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_event_bkg_rooms ON event_booking_rooms(booking_id);
  `);

  // ── Quotations (BEO) ────────────────────────────────────────────────────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS event_quotations (
      id             TEXT PRIMARY KEY,
      booking_id     TEXT NOT NULL,
      quote_number   TEXT,
      version        INT DEFAULT 1,
      status         TEXT DEFAULT 'DRAFT',   -- DRAFT | SENT | ACCEPTED | REJECTED | EXPIRED
      valid_until    DATE,
      subtotal       DOUBLE PRECISION DEFAULT 0,
      tax_amount     DOUBLE PRECISION DEFAULT 0,
      discount       DOUBLE PRECISION DEFAULT 0,
      grand_total    DOUBLE PRECISION DEFAULT 0,
      notes          TEXT,
      sent_at        TIMESTAMP,
      sent_to_email  TEXT,
      created_by     TEXT,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_event_quotations_booking ON event_quotations(booking_id);

    CREATE TABLE IF NOT EXISTS event_quotation_lines (
      id             TEXT PRIMARY KEY,
      quotation_id   TEXT NOT NULL,
      line_type      TEXT DEFAULT 'CUSTOM',  -- VENUE | RENTAL | SERVICE | HOTEL_ROOM | FNB | CUSTOM
      description    TEXT,
      quantity       DOUBLE PRECISION DEFAULT 1,
      unit_rate      DOUBLE PRECISION DEFAULT 0,
      amount         DOUBLE PRECISION DEFAULT 0,
      gst_rate       DOUBLE PRECISION DEFAULT 0,
      gst_amount     DOUBLE PRECISION DEFAULT 0,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_event_quote_lines ON event_quotation_lines(quotation_id);
  `);

  // ── Venue blocks (maintenance / hold) ───────────────────────────────────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS event_venue_blocks (
      id          TEXT PRIMARY KEY,
      venue_id    TEXT NOT NULL,
      from_date   DATE NOT NULL,
      to_date     DATE NOT NULL,
      reason      TEXT,
      created_by  TEXT,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_event_venue_blocks ON event_venue_blocks(venue_id, from_date, to_date);
  `);

  // ── Public-page profile (single row per tenant) ─────────────────────────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS event_profile (
      id            INT PRIMARY KEY DEFAULT 1,
      hero_title    TEXT,
      tagline       TEXT,
      description   TEXT,
      hero_image_url TEXT,
      gallery       TEXT,                     -- JSON array of image URLs
      contact_phone TEXT,
      contact_email TEXT,
      is_published  INT DEFAULT 1,
      updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Catering / F&B packages (Buffet / Plated) ───────────────────────────────
  // A package has a per-plate price and a configurable menu of sections
  // (Salad / Main Course / Sweet …), each with option items — stored as JSON so
  // owners can add any number of sections. Attached to a booking by pax count.
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS event_catering_packages (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      package_type    TEXT DEFAULT 'BUFFET',   -- BUFFET | PLATED
      price_per_plate DOUBLE PRECISION DEFAULT 0,
      description     TEXT,
      menu_json       TEXT,                    -- [{"section":"Salad","options":["Green Salad","Russian Salad"]}, ...]
      gst_percent     DOUBLE PRECISION DEFAULT 5,
      is_active       INT DEFAULT 1,
      display_order   INT DEFAULT 0,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_event_catering_active ON event_catering_packages(is_active, display_order);

    CREATE TABLE IF NOT EXISTS event_booking_catering (
      id                    TEXT PRIMARY KEY,
      booking_id            TEXT NOT NULL,
      package_id            TEXT,
      name_snapshot         TEXT,
      package_type_snapshot TEXT,
      description_snapshot  TEXT,
      menu_snapshot         TEXT,
      pax                   INT DEFAULT 0,
      price_per_plate       DOUBLE PRECISION DEFAULT 0,
      gst_percent           DOUBLE PRECISION DEFAULT 5,
      line_total            DOUBLE PRECISION DEFAULT 0,
      created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_event_bkg_catering ON event_booking_catering(booking_id);
  `);

  // ── Idempotent column additions for existing tenants ────────────────────────
  // Customer-facing description on masters, snapshotted onto booking lines so it
  // flows into the quotation + invoice. IF NOT EXISTS → safe to re-run at boot.
  await tenantDb.exec(`ALTER TABLE event_rental_items ADD COLUMN IF NOT EXISTS description TEXT`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE event_services ADD COLUMN IF NOT EXISTS description TEXT`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE event_booking_items ADD COLUMN IF NOT EXISTS description_snapshot TEXT`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE event_booking_services ADD COLUMN IF NOT EXISTS description_snapshot TEXT`).catch(() => {});

  // ── Sprint 1: cash & revenue integrity ──────────────────────────────────────
  // Staged deposit / payment schedule (booking deposit → interim → balance).
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS event_payment_schedule (
      id          TEXT PRIMARY KEY,
      booking_id  TEXT NOT NULL,
      label       TEXT,
      due_date    DATE,
      amount      DOUBLE PRECISION DEFAULT 0,   -- resolved amount due for this instalment
      percent     DOUBLE PRECISION,             -- optional: % of grand total (for display/regeneration)
      status      TEXT DEFAULT 'DUE',           -- DUE | PAID | WAIVED
      paid_amount DOUBLE PRECISION DEFAULT 0,
      paid_at     TIMESTAMP,
      sort_order  INTEGER DEFAULT 0,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_event_pay_sched ON event_payment_schedule(booking_id, sort_order);
  `);
  // Payment ledger — receipts recorded against a booking (source of truth for
  // "money received"; booking.advance_amount is kept in sync = SUM(amount)).
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS event_payments (
      id          TEXT PRIMARY KEY,
      booking_id  TEXT NOT NULL,
      schedule_id TEXT,
      amount      DOUBLE PRECISION DEFAULT 0,
      method      TEXT DEFAULT 'CASH',          -- CASH | UPI | CARD | BANK | CHEQUE
      reference   TEXT,
      paid_at     DATE,
      note        TEXT,
      recorded_by TEXT,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_event_payments ON event_payments(booking_id);
  `);
  // Lost-reason capture on cancel (makes win-rate actionable). The structured
  // reason category reuses the existing `cancellation_reason` column; this adds
  // an optional free-text note alongside it.
  await tenantDb.exec(`ALTER TABLE event_bookings ADD COLUMN IF NOT EXISTS cancel_reason_note TEXT`).catch(() => {});
}

/**
 * Recompute a booking's advance_amount as the sum of recorded payments, so the
 * dashboard's receivables (total_amount − advance_amount) stays correct without
 * changing the analytics contract. Returns the new total received.
 */
export async function recomputeEventPaid(tenantDb: DbInterface, bookingId: string): Promise<number> {
  const rows: any[] = await tenantDb.query("SELECT COALESCE(SUM(amount),0) AS t FROM event_payments WHERE booking_id = ?", [bookingId]);
  const paid = Math.round((Number(rows?.[0]?.t || 0)) * 100) / 100;
  await tenantDb.run("UPDATE event_bookings SET advance_amount = ? WHERE id = ?", [paid, bookingId]);
  return paid;
}

// ── Seed a couple of sensible defaults so a fresh tenant sees a populated master.
export async function seedEventDefaults(tenantDb: DbInterface): Promise<number> {
  let seeded = 0;
  const mk = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const existingItems: any[] = await tenantDb.query("SELECT id FROM event_rental_items LIMIT 1");
  if (!existingItems || existingItems.length === 0) {
    const items = [
      { name: "Round Table (10-seater)", category: "FURNITURE", unit: "piece", qty: 50, h: 30, d: 150, w: 800 },
      { name: "Banquet Chair", category: "FURNITURE", unit: "piece", qty: 500, h: 5, d: 20, w: 100 },
      { name: "Sofa (3-seater)", category: "FURNITURE", unit: "piece", qty: 20, h: 50, d: 250, w: 1400 },
      { name: "Gas Cylinder (commercial)", category: "KITCHEN", unit: "piece", qty: 15, h: 0, d: 200, w: 1000 },
      { name: "Dinner Plate Set (12)", category: "KITCHEN", unit: "set", qty: 100, h: 0, d: 40, w: 200 },
    ];
    for (const it of items) {
      await tenantDb.run(
        `INSERT INTO event_rental_items (id, name, category, unit, quantity_owned, rent_hourly, rent_daily, rent_weekly, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [mk("ERI"), it.name, it.category, it.unit, it.qty, it.h, it.d, it.w]
      );
      seeded++;
    }
  }

  const existingSvc: any[] = await tenantDb.query("SELECT id FROM event_services LIMIT 1");
  if (!existingSvc || existingSvc.length === 0) {
    const svcs = [
      { name: "Serving Staff (per person)", category: "STAFF", pricing: "PER_PERSON", rate: 800 },
      { name: "Security Guard", category: "SECURITY", pricing: "PER_PERSON", rate: 1000 },
      { name: "Valet Parking", category: "PARKING", pricing: "PER_EVENT", rate: 5000 },
      { name: "Stage Decoration (basic)", category: "DECORATION", pricing: "PER_EVENT", rate: 15000 },
    ];
    for (const s of svcs) {
      await tenantDb.run(
        `INSERT INTO event_services (id, name, category, pricing_type, rate, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [mk("ESV"), s.name, s.category, s.pricing, s.rate]
      );
      seeded++;
    }
  }

  // Ensure the singleton profile row exists.
  await tenantDb.run(
    `INSERT INTO event_profile (id, hero_title, tagline, is_published)
     VALUES (1, 'Host Your Event With Us', 'Weddings · Conferences · Celebrations', 1)
     ON CONFLICT (id) DO NOTHING`
  );

  return seeded;
}
