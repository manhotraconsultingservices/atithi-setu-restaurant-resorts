import { Pool, PoolClient } from "pg";

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://${process.env.PGUSER || 'postgres'}:${process.env.PGPASSWORD || 'postgres'}@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || '5432'}/${process.env.PGDATABASE || 'restoflow'}`,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

export interface DbInterface {
  query: (sql: string, params?: any[]) => Promise<any[]>;
  get: (sql: string, params?: any[]) => Promise<any>;
  run: (sql: string, params?: any[]) => Promise<{ changes: number }>;
  exec: (sql: string) => Promise<void>;
}

class PostgresDb implements DbInterface {
  private pool: Pool;
  private schema: string;

  constructor(pool: Pool, schema: string = 'public') {
    this.pool = pool;
    this.schema = schema;
  }

  private toPositional(sql: string): string {
    let count = 0;
    return sql.replace(/\?/g, () => `$${++count}`);
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      // Always reset search_path to prevent pool connection pollution
      // (a connection previously used by a tenant schema would otherwise
      // keep that schema in its search_path when reused by centralDb)
      await client.query(`SET search_path TO "${this.schema}"`);
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async query(sql: string, params: any[] = []): Promise<any[]> {
    return this.withClient(async (client) => {
      const res = await client.query(this.toPositional(sql), params);
      return res.rows;
    });
  }

  async get(sql: string, params: any[] = []): Promise<any> {
    const rows = await this.query(sql, params);
    return rows[0];
  }

  async run(sql: string, params: any[] = []): Promise<{ changes: number }> {
    return this.withClient(async (client) => {
      const res = await client.query(this.toPositional(sql), params);
      return { changes: res.rowCount ?? 0 };
    });
  }

  async exec(sql: string): Promise<void> {
    if (this.schema !== 'public') {
      await this.pool.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
    }
    await this.withClient(async (client) => {
      // Strip "--" line comments BEFORE splitting on ";". A semicolon
      // inside a comment would otherwise be treated as a statement
      // terminator and the next "statement" would start mid-comment with
      // invalid SQL. Mirrors PostgreSQL's own parser behaviour.
      // (Block comments /* */ are not stripped — they're rare in DDL and
      // unlikely to contain unescaped semicolons.)
      const sanitised = sql.replace(/--[^\n]*/g, '');
      const statements = sanitised.split(';').map(s => s.trim()).filter(s => s.length > 0);
      for (const stmt of statements) {
        await client.query(stmt);
      }
    });
  }
}

export const centralDb: DbInterface = new PostgresDb(pgPool, 'public');

export async function initDb() {
  await centralDb.exec(`
    CREATE TABLE IF NOT EXISTS restaurants (
      id TEXT PRIMARY KEY,
      name TEXT,
      admin_id TEXT,
      state TEXT,
      city TEXT,
      is_active INT DEFAULT 0,
      sales_rep_id TEXT,
      registered_at TIMESTAMP,
      subscription_expires_at TIMESTAMP,
      gst_number TEXT,
      gst_percentage DOUBLE PRECISION DEFAULT 5,
      is_gst_enabled INT DEFAULT 0,
      template_id TEXT DEFAULT 'CLASSIC',
      table_count INT DEFAULT 0,
      upi_id TEXT,
      upi_qr_image TEXT,
      watermark_image TEXT,
      checkout_mode TEXT DEFAULT 'postpaid'
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      login_id TEXT UNIQUE,
      name TEXT,
      email TEXT UNIQUE,
      phone TEXT,
      password TEXT,
      restaurant_id TEXT,
      role TEXT,
      is_active INT DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS image_backups (
      filename TEXT PRIMARY KEY,
      drive_file_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sequences (
      name TEXT PRIMARY KEY,
      current_value INT DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      city TEXT NOT NULL,
      zip_code TEXT,
      is_active INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: add restaurant settings columns to existing deployments
  await centralDb.exec(`
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS gst_number TEXT;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS gst_percentage DOUBLE PRECISION DEFAULT 5;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS is_gst_enabled INT DEFAULT 0;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS template_id TEXT DEFAULT 'CLASSIC';
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS table_count INT DEFAULT 0;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS upi_id TEXT;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS upi_qr_image TEXT;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS watermark_image TEXT;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS checkout_mode TEXT DEFAULT 'postpaid'
  `);

  // Migration: per-tenant subscription billing & access control.
  // - subscription_due_date: when the next payment is due (admin-set)
  // - grace_period_days: buffer after due date before access is revoked
  // - access_revoked / access_revoked_at / access_revoked_by: admin-controlled
  //   hard block on tenant access. Set manually from the admin Billing tab.
  // - last_payment_date / last_payment_amount: most recent recorded payment
  // - billing_notes: free-form admin notes (invoice numbers, payment refs)
  await centralDb.exec(`
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS subscription_due_date DATE;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS grace_period_days INT DEFAULT 7;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS access_revoked INT DEFAULT 0;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS access_revoked_at TIMESTAMP;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS access_revoked_by TEXT;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS access_revoked_reason TEXT;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS last_payment_date DATE;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS last_payment_amount DOUBLE PRECISION;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS last_payment_reference TEXT;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS billing_notes TEXT;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS subscription_plan TEXT;
    -- Phase 2 (Multi-currency + configurable tax). Defaults preserve the
    -- exact India / GST / ₹ behaviour for every pre-existing tenant.
    --   country         ISO-3166 alpha-2, selects the default tax preset.
    --   currency_code   ISO-4217 code, drives invoice & receipt amounts.
    --   currency_symbol Rendered before every formatted amount.
    --   locale          Passed to toLocaleString() for thousands separators.
    --   tax_template_id Picked from TAX_PRESETS in server.ts when the
    --                   tenant's tax_config table is empty (first-time seed).
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'IN';
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS currency_code TEXT DEFAULT 'INR';
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS currency_symbol TEXT DEFAULT '₹';
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS locale TEXT DEFAULT 'en-IN';
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS tax_template_id TEXT DEFAULT 'IN_GST';

    -- M-6 — Optional round-off line on invoices (BCG follow-up). When
    -- enabled, the invoice PDF emits an explicit "Round-off (±0.XX)"
    -- row so the grand total ends in .00 — Indian accountants expect
    -- this convention and reconcile their ledgers against it. Off by
    -- default; tenant opts in via Settings → Tax & Currency.
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS round_invoice_to_rupee INT DEFAULT 0;

    -- BCG Phase 1 (7 Jun 2026) — Invoice template selector. 'CLASSIC' is the
    -- historical layout (every existing tenant); 'BOUTIQUE' is the new
    -- opt-in design with logo lock-up, paid/unpaid stamp, summary band
    -- with category totals, and a boxed grand total. Owner toggles via
    -- Settings → Invoice Style. Server dispatches in invoiceService.ts:
    --   generateInvoicePdf() → reads this column → routes to either
    --   the Classic or the Boutique renderer.
    -- Default 'CLASSIC' so every tenant currently in production keeps
    -- byte-identical PDF output unless they deliberately switch.
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS invoice_template TEXT DEFAULT 'CLASSIC';

    -- BCG Tariff Phase 1 (7 Jun 2026) — Tariff-model selector. 'LEGACY'
    -- = the existing rate_overrides + base_rate resolution path (every
    -- tenant currently in production). 'MATRIX' = the new Room ×
    -- Season × Meal Plan tables (seasons, season_periods, meal_plans,
    -- room_tariffs, extra_person_charges). The rate resolver branches
    -- per-tenant on this flag. See docs/HOTEL_TARIFF_MODEL_GAPS.md.
    --
    -- Default 'LEGACY' so existing tenants are byte-identical until
    -- they deliberately switch via Settings → Tariff Configuration
    -- (Phase 2). The new client (27-room boutique resort) flips to
    -- MATRIX at onboarding.
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS tariff_model TEXT DEFAULT 'LEGACY';

    -- L-2 (BCG follow-up) — Min-margin guard. When > 0, the order POST
    -- and /invoices/manual POST handlers compute the line-level COGS via
    -- the existing recipes + ingredients.unit_cost data and reject the
    -- sale if the resulting margin falls below this threshold. The
    -- expected use-case: catch a cashier who applies a 90% discount on
    -- an item that only carries a 30% gross margin. Set to 0 (default)
    -- to disable. Caller can override per-order by passing
    -- override_min_margin=true in the body — the override is logged.
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS min_margin_percent DOUBLE PRECISION DEFAULT 0;

    -- R-2 (BCG follow-up) — FSSAI license. Mandatory for every food
    -- business in India per Sec 31 of the FSS Act, 2006. Restaurants
    -- must display the 14-digit licence number on every invoice/bill.
    -- Without it, an FSSAI inspector can suspend operations on the
    -- spot. Allowing tenant to skip is policy-violating, but we keep
    -- it nullable for pre-launch onboarding and non-India tenants who
    -- aren't subject to FSSAI.
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS fssai_license_number TEXT;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS fssai_license_valid_until DATE;

    -- R-3 (BCG follow-up) — GST E-Invoice (IRN). Mandatory for tenants
    -- with annual turnover ≥ ₹5 crore (current threshold as of 2026;
    -- it has dropped from ₹500cr → ₹100cr → ₹20cr → ₹10cr → ₹5cr in
    -- successive notifications). The flow is: invoice generated →
    -- payload POSTed to NIC Invoice Registration Portal (IRP) via a
    -- GSP (Master India / ClearTax / IRIS) → IRP returns IRN +
    -- signed QR + ACK number. Until the IRN is stored against the
    -- invoice it is NOT a valid GST invoice (per Notification 13/2020).
    --
    --   e_invoicing_enabled         tenant toggle (Settings → Compliance)
    --   e_invoicing_provider        free-text — which GSP they use, for support
    --   e_invoicing_turnover_aboveΘ informational; threshold derived from CA filing
    --   e_invoice_seller_legal_name needed in the payload (different from brand name)
    --   e_invoice_seller_trade_name optional alt-name on invoice
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS e_invoicing_enabled INT DEFAULT 0;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS e_invoicing_provider TEXT;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS e_invoicing_turnover_threshold_met INT DEFAULT 0;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS e_invoice_seller_legal_name TEXT;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS e_invoice_seller_trade_name TEXT;

    -- R-1 (BCG follow-up) — DPDP Act 2023 compliance.
    -- The Digital Personal Data Protection Act, 2023 (effective Aug 2023)
    -- mandates: explicit consent before processing personal data, the
    -- right to access / correction / erasure, breach notification, and
    -- designation of a Data Protection Officer / Grievance Officer.
    -- These columns store the per-tenant DPO contact + the URL to
    -- the tenant's privacy notice (rendered publicly via /privacy/:slug).
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS privacy_policy_url TEXT;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS privacy_policy_version TEXT DEFAULT 'v1';
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS dpo_name TEXT;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS dpo_email TEXT;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS dpo_phone TEXT;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS data_retention_days INT DEFAULT 2555;
    -- 2555 days ≈ 7 years — matches GST record-retention requirement
    -- (Rule 56 CGST Rules) and Companies Act bookkeeping windows.
    -- Phase F2 (Customer Experience v2) — feedback settings.
    --   auto_feedback_request_enabled    0 (default) = no auto-send. Owner
    --                                    must opt in via Settings.
    --   feedback_request_delay_minutes   how long after the bill is settled
    --                                    before the SMS / WhatsApp goes out.
    --                                    30 minutes default — long enough to
    --                                    finish the meal, short enough to be
    --                                    top-of-mind.
    --   feedback_request_channels        comma-separated: SMS,WHATSAPP,EMAIL
    --   feedback_public_reviews_enabled  expose /reviews page publicly.
    --   feedback_minimum_rating_public   stars >= this go to /reviews;
    --                                    below stays internal-only.
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS auto_feedback_request_enabled INT DEFAULT 0;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS feedback_request_delay_minutes INT DEFAULT 30;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS feedback_request_channels TEXT DEFAULT 'WHATSAPP,SMS';
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS feedback_public_reviews_enabled INT DEFAULT 1;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS feedback_minimum_rating_public INT DEFAULT 4;
    -- Phase S2 (Staff v2 — payroll & approvals) tenant-level thresholds.
    -- Defaults match the constants previously hard-coded in _recomputeTimesheet.
    --   overtime_threshold_multiplier  actual_hours > planned * this  -> is_overtime
    --   no_show_grace_minutes          no check-in within first N minutes -> is_no_show
    --   variance_approval_threshold_pct  |variance| / planned > this -> needs approval
    --   payroll_currency_code          override per tenant (default INR / restaurant.currency_code)
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS overtime_threshold_multiplier DOUBLE PRECISION DEFAULT 1.25;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS no_show_grace_minutes INT DEFAULT 30;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS variance_approval_threshold_pct DOUBLE PRECISION DEFAULT 25.0;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS shift_reminder_enabled INT DEFAULT 0;
    -- Phase B1 — Multi-location / Brand Mode.
    -- A "brand" is an owner-defined grouping of restaurants under the same
    -- ownership (e.g. "Vivek's Cafe" with three city locations). It's
    -- entirely optional — a tenant with brand_id IS NULL just behaves like
    -- it always did. Multi-location aggregation kicks in when 2+ restaurants
    -- share the same brand_id AND the same user can access both.
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS brand_id TEXT;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS location_label TEXT;
    -- Phase H1 — Hotel business rules (per-tenant overrides).
    -- All five columns are nullable / sane-default so existing tenants see
    -- zero behavioural change until an owner opts in via Settings.
    --
    --   hotel_min_stay_nights   Minimum nights for an overnight booking.
    --                           Default 1 (no constraint). Skipped for DAY_USE.
    --   hotel_max_stay_nights   Maximum nights. NULL = unlimited.
    --   hotel_refund_full_days  Refund 100% if cancelled this many days
    --                           or more before check-in. NULL = no policy
    --                           (current behaviour: cashier decides manually).
    --   hotel_refund_partial_pct  Partial refund % when inside the window.
    --                             Beyond grace, refund is 0%.
    --   hotel_late_checkout_time  HH:MM grace cutoff (e.g. '12:00'). After
    --                             this clock time on the check-out date,
    --                             an extra-night charge is auto-added at
    --                             check-out. NULL = no auto-fee.
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS hotel_min_stay_nights INT DEFAULT 1;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS hotel_max_stay_nights INT;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS hotel_refund_full_days INT;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS hotel_refund_partial_pct DOUBLE PRECISION;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS hotel_late_checkout_time TEXT;
    -- Req 1b — Pre-check-in ID gate. When 1 (default), the check-in
    -- endpoint refuses to flip a booking to CHECKED_IN unless at least
    -- one row exists in guest_documents for that booking. Statutory
    -- baseline for India: Form-C / FRRO for foreign guests requires
    -- ID, DPDP best-practice for Indian guests. Owners running transit
    -- / day-use only properties (truck-stops, business meeting rooms)
    -- can set this to 0 to opt out.
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS hotel_require_id_at_checkin INT DEFAULT 1;
    -- Phase H2 — Hotel-specific GST + service charge.
    -- Indian hotels follow a tariff-slab GST regime (post-2022 GST Council):
    --   ≤ ₹1,000/night  → 0%   (exempt)
    --   ₹1,001-₹7,500   → 12%
    --   > ₹7,500        → 18%
    -- Stored per-tenant so a property can override (some properties operate
    -- under different state policies or claim ITC variants). The thresholds
    -- and rates themselves are configurable.
    --   hotel_service_charge_percent applies to ROOM CHARGES ONLY (not to
    --   F&B or chargeable services like laundry). 0 = no service charge
    --   (default — preserves existing behaviour).
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS hotel_gst_slab1_max  DOUBLE PRECISION DEFAULT 1000;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS hotel_gst_slab1_rate DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS hotel_gst_slab2_max  DOUBLE PRECISION DEFAULT 7500;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS hotel_gst_slab2_rate DOUBLE PRECISION DEFAULT 12;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS hotel_gst_slab3_rate DOUBLE PRECISION DEFAULT 18;
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS hotel_service_charge_percent DOUBLE PRECISION DEFAULT 0;
    -- Phase H3 — Restaurant default service charge.
    -- A negotiable restaurant fee (separate from statutory GST). Sourced
    -- as the pre-populated default for the editable "Service Charge %"
    -- field on every invoice / postpaid session. Staff can override per
    -- invoice when the customer pushes back. 0 = no default.
    ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS service_charge_percent DOUBLE PRECISION DEFAULT 0
  `);
  await centralDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_restaurants_brand ON restaurants (brand_id)`
  ).catch(() => {});

  // Phase B1 — owner-defined brand groupings.
  await centralDb.exec(`
    CREATE TABLE IF NOT EXISTS brands (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_phone TEXT,
      owner_email TEXT,
      logo_url TEXT,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(() => {});

  // Phase B2 — brand-level announcements (banner pushed to every location's
  // dashboard) and menu templates (centralised recipes/items each location
  // can selectively sync into its own menu).
  await centralDb.exec(`
    CREATE TABLE IF NOT EXISTS brand_announcements (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      level TEXT DEFAULT 'INFO',
      expires_at TIMESTAMP,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_dismissed_globally INT DEFAULT 0
    )
  `).catch(() => {});
  await centralDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_brand_announcements_brand ON brand_announcements (brand_id, created_at DESC)`
  ).catch(() => {});

  await centralDb.exec(`
    CREATE TABLE IF NOT EXISTS brand_menu_templates (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      description TEXT,
      dietary_type TEXT,
      price_full DOUBLE PRECISION,
      price_half DOUBLE PRECISION,
      image_url TEXT,
      gst_percent DOUBLE PRECISION,
      is_active INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(() => {});
  await centralDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_brand_menu_templates_brand ON brand_menu_templates (brand_id, name)`
  ).catch(() => {});

  // Per-(brand_template, restaurant) sync history so the owner can see
  // "what's pushed to where" and re-push only changed items.
  await centralDb.exec(`
    CREATE TABLE IF NOT EXISTS brand_menu_sync_log (
      id SERIAL PRIMARY KEY,
      template_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      menu_item_id TEXT,
      action TEXT NOT NULL,
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      synced_by TEXT
    )
  `).catch(() => {});
  await centralDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_brand_menu_sync_template ON brand_menu_sync_log (template_id, restaurant_id)`
  ).catch(() => {});

  // Phase B3 — brand-level shared supplier directory.
  // Multi-location brands typically order from the same vendors (e.g.
  // "Hari Dairy" delivers to every branch). Registering them once at the
  // brand level, then syncing to each location's `suppliers` table,
  // saves duplicate data-entry and keeps lead-times / payment terms /
  // GST numbers consistent across branches.
  await centralDb.exec(`
    CREATE TABLE IF NOT EXISTS brand_suppliers (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL,
      name TEXT NOT NULL,
      contact_name TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      gst_number TEXT,
      lead_time_days INTEGER DEFAULT 1,
      payment_terms TEXT,
      notes TEXT,
      is_active INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(() => {});
  await centralDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_brand_suppliers_brand ON brand_suppliers (brand_id, name)`
  ).catch(() => {});

  await centralDb.exec(`
    CREATE TABLE IF NOT EXISTS brand_supplier_sync_log (
      id SERIAL PRIMARY KEY,
      brand_supplier_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      tenant_supplier_id TEXT,
      action TEXT NOT NULL,
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      synced_by TEXT
    )
  `).catch(() => {});
  await centralDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_brand_supplier_sync_sup ON brand_supplier_sync_log (brand_supplier_id, restaurant_id)`
  ).catch(() => {});

  // Audit log for cross-location staff transfers. One row per move/copy
  // so the owner can trace which staff member went where and roll back
  // by re-transferring if needed.
  await centralDb.exec(`
    CREATE TABLE IF NOT EXISTS brand_staff_transfer_log (
      id SERIAL PRIMARY KEY,
      brand_id TEXT,
      from_restaurant_id TEXT NOT NULL,
      to_restaurant_id TEXT NOT NULL,
      source_staff_id TEXT NOT NULL,
      target_staff_id TEXT NOT NULL,
      staff_name TEXT,
      staff_role TEXT,
      mode TEXT NOT NULL,
      source_deactivated INT DEFAULT 0,
      transferred_by TEXT,
      transferred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      notes TEXT
    )
  `).catch(() => {});
  await centralDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_brand_staff_xfer_route ON brand_staff_transfer_log (from_restaurant_id, to_restaurant_id, transferred_at DESC)`
  ).catch(() => {});

  // Migration: unique index on locations (safe to run multiple times)
  await centralDb.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_state_city ON locations (state, city)`
  ).catch(() => {});

  // NEW PHONE-BASED LOGIN SYSTEM TABLES (Option A)
  // These tables support the new simplified phone/OTP login
  await centralDb.exec(`
    CREATE TABLE IF NOT EXISTS phone_users (
      phone_number VARCHAR(15) PRIMARY KEY,
      phone_verified INT DEFAULT 0,
      owner_name TEXT,
      email TEXT UNIQUE,
      password_hash TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_restaurants (
      id SERIAL PRIMARY KEY,
      phone_number VARCHAR(15) NOT NULL,
      restaurant_id TEXT NOT NULL,
      role TEXT DEFAULT 'OWNER',
      is_primary INT DEFAULT 0,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (phone_number) REFERENCES phone_users(phone_number),
      UNIQUE(phone_number, restaurant_id)
    );

    CREATE TABLE IF NOT EXISTS restaurants_metadata (
      restaurant_id TEXT PRIMARY KEY,
      owner_phone VARCHAR(15),
      restaurant_name TEXT,
      location_city TEXT,
      cuisine_type TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_phone) REFERENCES phone_users(phone_number)
    );

    CREATE TABLE IF NOT EXISTS otp_cache (
      phone_number VARCHAR(15) PRIMARY KEY,
      otp VARCHAR(6) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create indices for performance
  await centralDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_phone_users_email ON phone_users(email);
    CREATE INDEX IF NOT EXISTS idx_phone_users_created ON phone_users(created_at);
    CREATE INDEX IF NOT EXISTS idx_user_restaurants_phone ON user_restaurants(phone_number);
    CREATE INDEX IF NOT EXISTS idx_user_restaurants_restaurant ON user_restaurants(restaurant_id);
    CREATE INDEX IF NOT EXISTS idx_restaurants_metadata_owner ON restaurants_metadata(owner_phone);
  `).catch(() => {});

  // ============================================================
  // EMAIL-BASED OWNER LOGIN SYSTEM
  // Owner registers with email + password. Phone is optional.
  // Staff (Chef/Waiter) still use Restaurant ID + credentials.
  // ============================================================
  await centralDb.exec(`
    CREATE TABLE IF NOT EXISTS owner_accounts (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      phone_number VARCHAR(20),
      password_hash TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS owner_restaurants (
      id SERIAL PRIMARY KEY,
      owner_email TEXT NOT NULL REFERENCES owner_accounts(email),
      restaurant_id TEXT NOT NULL,
      restaurant_name TEXT NOT NULL,
      location_city TEXT,
      cuisine_type TEXT,
      role TEXT DEFAULT 'OWNER',
      is_primary INT DEFAULT 1,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(owner_email, restaurant_id)
    );
  `);

  await centralDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_owner_accounts_phone ON owner_accounts(phone_number);
    CREATE INDEX IF NOT EXISTS idx_owner_restaurants_email ON owner_restaurants(owner_email);
    CREATE INDEX IF NOT EXISTS idx_owner_restaurants_rid ON owner_restaurants(restaurant_id);
  `).catch(() => {});

  // Password reset tokens for owner "Forgot Password" flow
  await centralDb.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_prt_email ON password_reset_tokens(email);
  `).catch(() => {});

  // Role-Based Access Control: which tabs each role can access per restaurant
  await centralDb.exec(`
    CREATE TABLE IF NOT EXISTS restaurant_role_permissions (
      restaurant_id TEXT NOT NULL,
      role TEXT NOT NULL,
      allowed_tabs TEXT DEFAULT '[]',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (restaurant_id, role)
    )
  `);

  // RBAC-5a — Audit log of every permission change. Captured on each POST
  // to /role-permissions so the owner can answer "who removed CASHIER's
  // access to REPORTS last Tuesday?". Both before/after stored as JSON.
  await centralDb.exec(`
    CREATE TABLE IF NOT EXISTS permission_audit_log (
      id                   SERIAL PRIMARY KEY,
      restaurant_id        TEXT NOT NULL,
      role                 TEXT NOT NULL,
      allowed_tabs_before  TEXT,    -- JSON array (nullable for fresh inserts)
      allowed_tabs_after   TEXT,    -- JSON array
      changed_by_id        TEXT,    -- user id of the actor
      changed_by_email     TEXT,    -- email (for legacy users without ids)
      changed_by_role      TEXT,
      changed_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_perm_audit_restaurant
      ON permission_audit_log (restaurant_id, changed_at DESC);
  `);
}

// ---------------------------------------------------------------------------
// Seed data: mirrors INDIAN_STATES in the frontend so the DB is pre-populated
// on first boot.  Uses ON CONFLICT DO NOTHING so it is fully idempotent.
// ---------------------------------------------------------------------------
const LOCATION_SEED_DATA: Record<string, string[]> = {
  "Andhra Pradesh": ["Visakhapatnam", "Vijayawada", "Guntur", "Nellore", "Kurnool"],
  "Arunachal Pradesh": ["Itanagar", "Naharlagun", "Pasighat"],
  "Assam": ["Guwahati", "Silchar", "Dibrugarh", "Jorhat", "Nagaon"],
  "Bihar": ["Patna", "Gaya", "Bhagalpur", "Muzaffarpur", "Purnia"],
  "Chhattisgarh": ["Raipur", "Bhilai", "Bilaspur", "Korba", "Rajnandgaon"],
  "Goa": ["Panaji", "Margao", "Vasco da Gama", "Mapusa"],
  "Gujarat": ["Ahmedabad", "Surat", "Vadodara", "Rajkot", "Bhavnagar"],
  "Haryana": ["Faridabad", "Gurgaon", "Panipat", "Ambala", "Yamunanagar"],
  "Himachal Pradesh": ["Shimla", "Dharamshala", "Solan", "Mandi"],
  "Jharkhand": ["Jamshedpur", "Dhanbad", "Ranchi", "Bokaro", "Deoghar"],
  "Karnataka": ["Bangalore", "Hubli", "Mysore", "Gulbarga", "Belgaum"],
  "Kerala": ["Thiruvananthapuram", "Kochi", "Kozhikode", "Kollam", "Thrissur"],
  "Madhya Pradesh": ["Indore", "Bhopal", "Jabalpur", "Gwalior", "Ujjain"],
  "Maharashtra": ["Mumbai", "Pune", "Nagpur", "Thane", "Pimpri-Chinchwad"],
  "Manipur": ["Imphal", "Thoubal", "Bishnupur"],
  "Meghalaya": ["Shillong", "Tura", "Jowai"],
  "Mizoram": ["Aizawl", "Lunglei", "Saiha"],
  "Nagaland": ["Dimapur", "Kohima", "Tuensang"],
  "Odisha": ["Bhubaneswar", "Cuttack", "Rourkela", "Berhampur", "Sambalpur"],
  "Punjab": ["Ludhiana", "Amritsar", "Jalandhar", "Patiala", "Bathinda", "Pathankot", "Dinanagar", "Gurdaspur", "Batala"],
  "Rajasthan": ["Jaipur", "Jodhpur", "Kota", "Bikaner", "Ajmer"],
  "Sikkim": ["Gangtok", "Namchi", "Geyzing"],
  "Tamil Nadu": ["Chennai", "Coimbatore", "Madurai", "Tiruchirappalli", "Salem"],
  "Telangana": ["Hyderabad", "Warangal", "Nizamabad", "Karimnagar", "Ramagundam"],
  "Tripura": ["Agartala", "Udaipur", "Dharmanagar"],
  "Uttar Pradesh": ["Lucknow", "Kanpur", "Ghaziabad", "Agra", "Meerut"],
  "Uttarakhand": ["Dehradun", "Haridwar", "Roorkee", "Haldwani"],
  "West Bengal": ["Kolkata", "Howrah", "Asansol", "Siliguri", "Durgapur"],
  "Delhi": ["New Delhi", "North Delhi", "South Delhi", "East Delhi", "West Delhi"],
};

export async function seedLocations(): Promise<void> {
  for (const [state, cities] of Object.entries(LOCATION_SEED_DATA)) {
    const stateSlug = state.replace(/\W/g, '_').toLowerCase();
    for (const city of cities) {
      const citySlug = city.replace(/\W/g, '_').toLowerCase();
      const id = `loc_${stateSlug}_${citySlug}`;
      await centralDb.run(
        `INSERT INTO locations (id, state, city) VALUES (?, ?, ?) ON CONFLICT (state, city) DO NOTHING`,
        [id, state, city]
      );
    }
  }
}

function tenantSchema(restaurantId: string): string {
  return `tenant_${restaurantId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

// Cache holds the INIT PROMISE — not the resolved DbInterface — so that
// concurrent callers for the same tenant share the same migration run.
// Without this, two cron tasks calling getTenantDb(X) simultaneously
// each see a cold cache, each instantiate a PostgresDb, each fire
// CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS — and PG's
// IF NOT EXISTS check is NOT atomic against concurrent DDL. One call
// wins, the other hits "duplicate key value violates unique constraint
// pg_class_relname_nsp_index" (or pg_type_typname_nsp_index for the
// table's implicit row type) and the request blows up.
//
// By storing the promise itself, the second caller awaits the first
// caller's migrations to finish and then gets the same DbInterface.
const tenantDbCache = new Map<string, Promise<DbInterface>>();

export async function getTenantDb(restaurantId: string): Promise<DbInterface> {
  const schema = tenantSchema(restaurantId);
  const cached = tenantDbCache.get(schema);
  if (cached) return cached;

  // Build the init promise and put it in the cache IMMEDIATELY (before
  // awaiting any DDL) so a concurrent caller arriving mid-init joins this
  // same promise instead of starting a parallel migration race.
  const initPromise = _initTenantDb(schema);
  tenantDbCache.set(schema, initPromise);

  // If initialisation throws (transient network glitch, etc.), drop the
  // poisoned promise so the next call retries from scratch.
  initPromise.catch(() => {
    if (tenantDbCache.get(schema) === initPromise) {
      tenantDbCache.delete(schema);
    }
  });

  return initPromise;
}

async function _initTenantDb(schema: string): Promise<DbInterface> {
  const db = new PostgresDb(pgPool, schema);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS menu (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price DOUBLE PRECISION NOT NULL,
      price_half DOUBLE PRECISION,
      price_full DOUBLE PRECISION,
      category TEXT,
      image_url TEXT,
      drive_file_id TEXT,
      dietary_type TEXT,
      is_daily_special INT DEFAULT 0,
      -- price_tbd = 1 means the price is decided at billing time
      -- (e.g. market-rate seafood, custom platters). The item
      -- still saves price=0 in the menu row; the cashier MUST
      -- enter a price > 0 in the cart before the invoice can be
      -- generated. Enforced by the /invoices/manual endpoint.
      price_tbd INT DEFAULT 0,
      is_available INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    -- Idempotent migration for existing tenants whose menu table
    -- predates the price_tbd column.
    ALTER TABLE menu ADD COLUMN IF NOT EXISTS price_tbd INT DEFAULT 0;
    UPDATE menu SET price_tbd = 0 WHERE price_tbd IS NULL;

    CREATE TABLE IF NOT EXISTS tables (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      capacity INT,
      status TEXT DEFAULT 'AVAILABLE',
      qr_code_data TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      table_number TEXT,
      items TEXT,
      total_amount DOUBLE PRECISION,
      gst_amount DOUBLE PRECISION DEFAULT 0,
      status TEXT,
      payment_status TEXT DEFAULT 'PENDING',
      payment_method TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      customer_email TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      booking_date DATE NOT NULL,
      booking_time TIME NOT NULL,
      guests INT NOT NULL,
      status TEXT DEFAULT 'PENDING',
      table_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notification_settings (
      event_name TEXT,
      role TEXT,
      email_enabled INT DEFAULT 0,
      sms_enabled INT DEFAULT 0,
      whatsapp_enabled INT DEFAULT 0,
      recipients TEXT,
      PRIMARY KEY (event_name, role)
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      date DATE NOT NULL,
      hours DOUBLE PRECISION,
      type TEXT,
      note TEXT,
      check_in TIMESTAMP,
      check_out TIMESTAMP,
      status TEXT,
      UNIQUE(user_id, date)
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      rating INT,
      comment TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    -- Phase F2 enrichment: sentiment, customer identity, NPS, reply chain.
    -- All nullable / defaulted so legacy rows continue to render.
    ALTER TABLE feedback ADD COLUMN IF NOT EXISTS sentiment TEXT;            -- 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | NULL
    ALTER TABLE feedback ADD COLUMN IF NOT EXISTS customer_name TEXT;
    ALTER TABLE feedback ADD COLUMN IF NOT EXISTS customer_phone TEXT;
    ALTER TABLE feedback ADD COLUMN IF NOT EXISTS customer_email TEXT;
    ALTER TABLE feedback ADD COLUMN IF NOT EXISTS nps_score INT;             -- 0-10 likelihood-to-recommend
    ALTER TABLE feedback ADD COLUMN IF NOT EXISTS owner_reply TEXT;
    ALTER TABLE feedback ADD COLUMN IF NOT EXISTS owner_reply_at TIMESTAMP;
    ALTER TABLE feedback ADD COLUMN IF NOT EXISTS owner_reply_by TEXT;
    ALTER TABLE feedback ADD COLUMN IF NOT EXISTS reply_sent_via TEXT;       -- 'SMS' | 'WHATSAPP' | 'EMAIL' | 'INTERNAL'
    ALTER TABLE feedback ADD COLUMN IF NOT EXISTS is_public INT DEFAULT 1;   -- 0 = hidden from public /reviews page
    ALTER TABLE feedback ADD COLUMN IF NOT EXISTS resolved INT DEFAULT 0;    -- internal status
    ALTER TABLE feedback ADD COLUMN IF NOT EXISTS source_channel TEXT;       -- 'POS' | 'QR' | 'EMAIL_LINK' | 'WHATSAPP_LINK' | 'SMS_LINK'
    ALTER TABLE feedback ADD COLUMN IF NOT EXISTS request_id TEXT;           -- → feedback_requests.id when this row was solicited

    -- Dedup + analytics table for solicited feedback requests. One row per
    -- request sent. Used to compute the response rate KPI and to prevent
    -- the auto-cron from spamming the same order multiple times.
    CREATE TABLE IF NOT EXISTS feedback_requests (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      customer_phone TEXT,
      customer_email TEXT,
      channel TEXT NOT NULL,                  -- 'SMS' | 'WHATSAPP' | 'EMAIL'
      sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      responded_at TIMESTAMP,                 -- populated when the matching feedback row is inserted
      feedback_id TEXT
    );

    CREATE TABLE IF NOT EXISTS attendance_staff (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT,
      phone TEXT,
      email TEXT,
      login_id TEXT UNIQUE,
      password TEXT,
      is_active INT DEFAULT 1,
      default_hours DOUBLE PRECISION DEFAULT 8,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    -- Phase S2 enrichment: hourly rate for payroll math + employment metadata.
    ALTER TABLE attendance_staff ADD COLUMN IF NOT EXISTS hourly_rate DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE attendance_staff ADD COLUMN IF NOT EXISTS payroll_id TEXT;
    ALTER TABLE attendance_staff ADD COLUMN IF NOT EXISTS joined_at DATE;
    ALTER TABLE attendance_staff ADD COLUMN IF NOT EXISTS notes TEXT;

    CREATE TABLE IF NOT EXISTS reservation_day_config (
      config_date DATE PRIMARY KEY,
      max_tables INT NOT NULL DEFAULT 10,
      time_slots TEXT DEFAULT '[]',
      is_open INT DEFAULT 1,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS table_sessions (
      id TEXT PRIMARY KEY,
      session_token TEXT UNIQUE NOT NULL,
      table_id TEXT,
      table_name TEXT,
      status TEXT DEFAULT 'open',
      customer_name TEXT,
      customer_phone TEXT,
      round_count INTEGER DEFAULT 0,
      bill_amount DOUBLE PRECISION DEFAULT 0,
      payment_method TEXT,
      opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      bill_requested_at TIMESTAMP,
      closed_at TIMESTAMP
    )
  `);

  // CMD-CENTER-FIX (2026-06-06): every ALTER below MUST end with
  // `.catch(() => {})`. The init flow is one big chain of awaits — a single
  // throw aborts the rest and the in-memory cache stores a partially-
  // migrated DbInterface that subsequent requests reuse forever. Symptom
  // observed: tables.status never flipped OCCUPIED because the
  // assigned_waiter_id ALTER on line 871 transiently failed on first init
  // after a deploy, aborting every downstream ALTER (table_sessions
  // discount_amount, gst_percent, invoice_number, snapshot cols, …),
  // and the broken DbInterface was cached.
  //
  // Migrations for existing tenant schemas — table monitoring
  await db.exec("ALTER TABLE tables ADD COLUMN IF NOT EXISTS assigned_waiter_id TEXT").catch(() => {});

  // Migrations for existing tenant schemas — orders (prepaid/postpaid/cloud_kitchen)
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS session_id TEXT").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_mode TEXT DEFAULT 'postpaid'").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS round_number INTEGER DEFAULT 1").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS kitchen_status TEXT DEFAULT 'queued'").catch(() => {});
  // Cloud-kitchen / online-delivery: structured customer delivery address
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_address_line1 TEXT").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_address_line2 TEXT").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_city TEXT").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_pincode TEXT").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_landmark TEXT").catch(() => {});

  // T1-L1: Soft-delete columns on orders + table_sessions (BCG audit, Tier 1)
  // Pre-T1, /invoice/order and /invoice/session endpoints physically DELETEd
  // rows after copying a snapshot to invoice_deletion_audit. That broke
  // reconciliation (a row referencing an order id couldn't be JOINed back)
  // and forensics had to fish JSON out of the audit table to answer "what
  // was billed?". Soft-delete keeps the row intact, sets the marker columns,
  // and the list/aggregate queries filter `deleted_at IS NULL`.
  // QR/BILL-FIX (BCG follow-up): wrap every ALTER in .catch(() => {}) so a
  // transient failure on one migration step (e.g. PG concurrency lock, brief
  // search_path glitch) doesn't abort the rest of _initTenantDb. Without
  // these guards, a single throw here aborted the whole function — which
  // meant ALL downstream ALTERs (lines 913+ legacy columns, line 1706 M-1
  // snapshots, line 1717 M-4 ECO, line 1733 R-3 IRN, the entire DPDP table
  // block) never ran. Production symptom: /menu worked because the menu
  // table was created in the upstream CREATE TABLE block, but /orders POST
  // and /request-bill UPDATE failed because their referenced columns were
  // never added.
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_by_user_id TEXT").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_by_role TEXT").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_reason TEXT").catch(() => {});
  await db.exec("CREATE INDEX IF NOT EXISTS idx_orders_active ON orders (created_at DESC) WHERE deleted_at IS NULL").catch(() => {});
  await db.exec("ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP").catch(() => {});
  await db.exec("ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS deleted_by_user_id TEXT").catch(() => {});
  await db.exec("ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS deleted_by_role TEXT").catch(() => {});
  await db.exec("ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS deleted_reason TEXT").catch(() => {});

  await db.exec("ALTER TABLE attendance_staff ADD COLUMN IF NOT EXISTS default_hours DOUBLE PRECISION DEFAULT 8").catch(() => {});
  await db.exec("ALTER TABLE attendance_staff ADD COLUMN IF NOT EXISTS login_id TEXT").catch(() => {});
  await db.exec("ALTER TABLE attendance_staff ADD COLUMN IF NOT EXISTS password TEXT").catch(() => {});
  // Add unique index on login_id (CREATE UNIQUE INDEX IF NOT EXISTS is safe to run multiple times)
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_staff_login_id ON attendance_staff (login_id) WHERE login_id IS NOT NULL`).catch(() => {});
  // Bookings migrations
  await db.exec("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_email TEXT").catch(() => {});
  await db.exec("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booked_by TEXT").catch(() => {});
  await db.exec("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notes TEXT").catch(() => {});

  // Postpaid invoice adjustments on table_sessions
  await db.exec("ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS discount_amount DOUBLE PRECISION DEFAULT 0").catch(() => {});
  await db.exec("ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS service_charge_percent DOUBLE PRECISION DEFAULT 0").catch(() => {});
  await db.exec("ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS gst_percent DOUBLE PRECISION DEFAULT 0").catch(() => {});
  await db.exec("ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS apply_gst INTEGER DEFAULT 1").catch(() => {});
  await db.exec("ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS final_amount DOUBLE PRECISION DEFAULT 0").catch(() => {});

  // Invoice status tracking
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_status TEXT DEFAULT 'DRAFT'").catch(() => {});
  await db.exec("ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS invoice_status TEXT DEFAULT 'DRAFT'").catch(() => {});

  // GST persistence on the ORDER row (separate from table_sessions which has
  // its own gst_percent/apply_gst). Older tenants only got these via the
  // manual-invoice / invoice-edit endpoints; freshly provisioned tenants whose
  // first traffic was a customer order would 500 because /orders POST
  // INSERTs into these columns. Migrating them here means every tenant has
  // them from the first request, regardless of which endpoint hit first.
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS gst_percent FLOAT DEFAULT 0").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS apply_gst INTEGER DEFAULT 1").catch(() => {});

  // Telegram notification support
  await db.exec("ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS telegram_enabled INT DEFAULT 0").catch(() => {});
  await db.exec("ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT DEFAULT ''").catch(() => {});

  // Scheduler support — HH:MM time for auto-fire (e.g. "22:00" = 10 PM daily)
  await db.exec("ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS schedule_time TEXT DEFAULT ''").catch(() => {});

  // ── Invoice numbering (per-tenant counters) ───────────────────────────────
  // Owner-configurable RANDOM/SEQUENTIAL invoice numbers (see plan). Each
  // tenant gets its own atomic counter table; orders + table_sessions get
  // a nullable invoice_number column populated only in SEQUENTIAL mode.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sequences (
      name TEXT PRIMARY KEY,
      current_value INTEGER NOT NULL DEFAULT 0
    )
  `);
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_number TEXT").catch(() => {});
  await db.exec("ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS invoice_number TEXT").catch(() => {});

  // ── Inventory Management (Phase 1 — 2026-05) ──────────────────────────────
  // 11 tables for the holistic inventory module. All inside the tenant schema.
  // Idempotent CREATE TABLE IF NOT EXISTS — safe to run on every getTenantDb().
  // See plan at C:\Users\Admin\.claude\plans\i-need-to-setup-nifty-hammock.md

  // Master catalog of trackable items: raw ingredients (paneer, chicken, dal)
  // and packaged goods (water, soda, ice cream).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ingredients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      item_type TEXT NOT NULL DEFAULT 'RAW',
      category TEXT,
      unit TEXT NOT NULL,
      current_stock_qty DOUBLE PRECISION DEFAULT 0,
      reorder_point DOUBLE PRECISION DEFAULT 0,
      par_level DOUBLE PRECISION DEFAULT 0,
      default_supplier_id TEXT,
      default_unit_price DOUBLE PRECISION,
      gst_percent DOUBLE PRECISION DEFAULT 0,
      sku TEXT,
      image_url TEXT,
      notes TEXT,
      is_active INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_ingredients_active ON ingredients (is_active)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_ingredients_category ON ingredients (category)`);

  // Recipe = which ingredients each menu item consumes per serving.
  // size_variant lets HALF and FULL plates have different ingredient quantities.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS recipes (
      id TEXT PRIMARY KEY,
      menu_item_id TEXT NOT NULL,
      ingredient_id TEXT NOT NULL,
      qty_per_serving DOUBLE PRECISION NOT NULL,
      unit TEXT NOT NULL,
      size_variant TEXT DEFAULT 'BOTH',
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Postgres doesn't have IF NOT EXISTS for UNIQUE constraints — use a unique index instead
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_recipes_unique ON recipes (menu_item_id, ingredient_id, size_variant)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_recipes_menu_item ON recipes (menu_item_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_recipes_ingredient ON recipes (ingredient_id)`);

  // Supplier directory — vendor contacts, lead time, payment terms.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      contact_name TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      gst_number TEXT,
      lead_time_days INTEGER DEFAULT 1,
      payment_terms TEXT,
      notes TEXT,
      is_active INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers (is_active)`);
  // Phase I2 supplier auto-PO controls. Owner opts a supplier into the
  // weekly draft-PO cron and picks which weekday to fire on.
  //   auto_po_enabled         0 (default) = owner raises POs manually
  //   reorder_day_of_week     0-6, 0=Sunday (per PG dow). NULL = any day.
  //   po_ordering_minimum     skip PO generation if total < this (₹)
  await db.exec(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS auto_po_enabled INT DEFAULT 0`).catch(() => {});
  await db.exec(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS reorder_day_of_week INT`).catch(() => {});
  await db.exec(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS po_ordering_minimum DOUBLE PRECISION DEFAULT 0`).catch(() => {});

  // Purchase Orders — owner raises a PO, tracks status through DRAFT → SENT →
  // PARTIAL → RECEIVED → CANCELLED. PO ids use getNextTenantSequence('po').
  await db.exec(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      supplier_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      expected_delivery_date DATE,
      total_amount DOUBLE PRECISION DEFAULT 0,
      gst_amount DOUBLE PRECISION DEFAULT 0,
      grand_total DOUBLE PRECISION DEFAULT 0,
      raised_by_user_id TEXT,
      raised_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      sent_at TIMESTAMP,
      notes TEXT
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders (status)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders (supplier_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_po_expected_delivery ON purchase_orders (expected_delivery_date)`);

  // Line items per PO — qty_received tracks partial fulfilment.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id TEXT PRIMARY KEY,
      po_id TEXT NOT NULL,
      ingredient_id TEXT NOT NULL,
      qty_ordered DOUBLE PRECISION NOT NULL,
      unit TEXT NOT NULL,
      unit_price DOUBLE PRECISION NOT NULL,
      qty_received DOUBLE PRECISION DEFAULT 0,
      is_fully_received INT DEFAULT 0
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_poi_po ON purchase_order_items (po_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_poi_ingredient ON purchase_order_items (ingredient_id)`);

  // Goods Receipt Notes — when stock physically arrives. Increments stock and
  // links optionally to a PO (or ad-hoc receipt). GRN ids use getNextTenantSequence('grn').
  await db.exec(`
    CREATE TABLE IF NOT EXISTS goods_receipts (
      id TEXT PRIMARY KEY,
      po_id TEXT,
      supplier_id TEXT NOT NULL,
      received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      received_by_user_id TEXT,
      total_amount DOUBLE PRECISION DEFAULT 0,
      bill_number TEXT,
      bill_image_url TEXT,
      notes TEXT
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_grn_po ON goods_receipts (po_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_grn_supplier ON goods_receipts (supplier_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_grn_received_at ON goods_receipts (received_at)`);

  // GRN line items — captures batch / expiry / condition for traceability.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS goods_receipt_items (
      id TEXT PRIMARY KEY,
      grn_id TEXT NOT NULL,
      ingredient_id TEXT NOT NULL,
      qty_received DOUBLE PRECISION NOT NULL,
      unit TEXT NOT NULL,
      unit_price DOUBLE PRECISION NOT NULL,
      batch_number TEXT,
      expiry_date DATE,
      condition TEXT DEFAULT 'GOOD'
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_gri_grn ON goods_receipt_items (grn_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_gri_ingredient ON goods_receipt_items (ingredient_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_gri_expiry ON goods_receipt_items (expiry_date)`);

  // Stock Movements — append-only audit log of every stock change.
  // Single source of truth for forecasting + reports + variance analysis.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      ingredient_id TEXT NOT NULL,
      qty_delta DOUBLE PRECISION NOT NULL,
      unit TEXT NOT NULL,
      movement_type TEXT NOT NULL,
      reference_type TEXT,
      reference_id TEXT,
      balance_after DOUBLE PRECISION NOT NULL,
      unit_cost DOUBLE PRECISION,
      recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      recorded_by_user_id TEXT,
      notes TEXT
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_stock_movements_ingredient_date ON stock_movements (ingredient_id, recorded_at)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_stock_movements_type ON stock_movements (movement_type)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_stock_movements_reference ON stock_movements (reference_type, reference_id)`);

  // Wastage logs — explicit ledger entries for spoilage / burn / drop / expiry.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS wastage_logs (
      id TEXT PRIMARY KEY,
      ingredient_id TEXT NOT NULL,
      qty DOUBLE PRECISION NOT NULL,
      unit TEXT NOT NULL,
      reason TEXT NOT NULL,
      notes TEXT,
      logged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      logged_by_user_id TEXT
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_wastage_ingredient ON wastage_logs (ingredient_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_wastage_date ON wastage_logs (logged_at)`);

  // Physical counts — periodic stock audits to reconcile expected vs actual.
  // ID format: COUNT-{seq} via getNextTenantSequence('count').
  await db.exec(`
    CREATE TABLE IF NOT EXISTS physical_counts (
      id TEXT PRIMARY KEY,
      count_date DATE NOT NULL,
      status TEXT DEFAULT 'IN_PROGRESS',
      counted_by_user_id TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_physical_counts_status ON physical_counts (status)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_physical_counts_date ON physical_counts (count_date)`);

  // Per-ingredient line items for a physical count.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS physical_count_items (
      id TEXT PRIMARY KEY,
      count_id TEXT NOT NULL,
      ingredient_id TEXT NOT NULL,
      expected_qty DOUBLE PRECISION NOT NULL,
      actual_qty DOUBLE PRECISION,
      variance DOUBLE PRECISION,
      unit TEXT NOT NULL
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_pci_count ON physical_count_items (count_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_pci_ingredient ON physical_count_items (ingredient_id)`);

  // Pre-computed forecast cache, refreshed by nightly cron.
  // Avoids recomputing on every dashboard load — read straight from this table.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS consumption_forecasts (
      ingredient_id TEXT NOT NULL,
      horizon TEXT NOT NULL,
      forecast_qty DOUBLE PRECISION NOT NULL,
      computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (ingredient_id, horizon)
    )
  `);

  // Idempotency guard for cancellation reversal — prevents double-credit if
  // the same order is cancelled twice (network retry / owner clicks twice).
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS inventory_reverted INT DEFAULT 0").catch(() => {});

  // ───────────────────────────────────────────────────────────────────────
  // Tier-2 / Tier-3 inventory enhancements (2026-05 cycle)
  // ───────────────────────────────────────────────────────────────────────

  // Recipe versioning — each recipe row is valid for a window. Deduction at
  // order-time looks up the row whose [effective_from, effective_to) bracket
  // contains order.created_at. NULL effective_from = "since beginning of time",
  // NULL effective_to = "still active". Owner-edits supersede the prior row.
  await db.exec("ALTER TABLE recipes ADD COLUMN IF NOT EXISTS effective_from TIMESTAMP").catch(() => {});
  await db.exec("ALTER TABLE recipes ADD COLUMN IF NOT EXISTS effective_to TIMESTAMP").catch(() => {});
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_recipes_effective ON recipes (menu_item_id, effective_from, effective_to)`);

  // Migrate the old hard unique index to a partial one that only enforces
  // uniqueness for active rows (effective_to IS NULL). This lets the same
  // (menu_item_id, ingredient_id, size_variant) appear multiple times across
  // historical versions while still preventing duplicate active rows.
  // Drop only if it exists; ignore failures (already migrated, or never present).
  await db.exec(`DROP INDEX IF EXISTS idx_recipes_unique`).catch(() => {});
  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_recipes_unique_active
      ON recipes (menu_item_id, ingredient_id, size_variant)
      WHERE effective_to IS NULL
  `).catch(() => {});

  // Supplier price history — auto-populated on every GRN line so the owner
  // can see how a supplier's price has moved over time (and spot price hikes).
  // One row per (supplier, ingredient, observation_at).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS supplier_prices (
      id TEXT PRIMARY KEY,
      supplier_id TEXT NOT NULL,
      ingredient_id TEXT NOT NULL,
      unit_price DOUBLE PRECISION NOT NULL,
      unit TEXT NOT NULL,
      qty_purchased DOUBLE PRECISION,
      observed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      source_type TEXT NOT NULL DEFAULT 'GRN',
      source_id TEXT,
      notes TEXT
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_supplier_prices_supplier_ingredient ON supplier_prices (supplier_id, ingredient_id, observed_at)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_supplier_prices_ingredient ON supplier_prices (ingredient_id, observed_at)`);

  // Stock batches — for FIFO consumption + expiry-aware deduction. Each GRN
  // line creates a batch; deduction draws from oldest non-expired first.
  // remaining_qty decremented on each draw; batch with remaining_qty <= 0
  // is logically retired (not deleted — kept for audit).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS stock_batches (
      id TEXT PRIMARY KEY,
      ingredient_id TEXT NOT NULL,
      grn_id TEXT,
      grn_item_id TEXT,
      supplier_id TEXT,
      received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expiry_date DATE,
      batch_number TEXT,
      qty_received DOUBLE PRECISION NOT NULL,
      remaining_qty DOUBLE PRECISION NOT NULL,
      unit TEXT NOT NULL,
      unit_cost DOUBLE PRECISION,
      condition TEXT DEFAULT 'GOOD'
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_stock_batches_ingredient_received ON stock_batches (ingredient_id, received_at)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_stock_batches_expiry ON stock_batches (expiry_date)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_stock_batches_remaining ON stock_batches (ingredient_id, remaining_qty)`);

  // Seasonality factors — per-ingredient calendar-aware multipliers applied to
  // the day-of-week rolling-average forecast. Owner can boost paneer for Diwali,
  // chicken for Saturday, biryani-rice for monsoon, etc. Lookup is by
  // (ingredient_id, type, key) where:
  //   type = 'WEEKDAY'   key = '0'..'6'    (Sunday=0)
  //   type = 'MONTH'     key = '1'..'12'
  //   type = 'DATE'      key = 'YYYY-MM-DD' or 'MM-DD' (recurring annual)
  //   type = 'RANGE'     key = 'YYYY-MM-DD..YYYY-MM-DD'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seasonality_factors (
      id TEXT PRIMARY KEY,
      ingredient_id TEXT,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      multiplier DOUBLE PRECISION NOT NULL DEFAULT 1.0,
      label TEXT,
      is_active INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_seasonality_lookup ON seasonality_factors (ingredient_id, type, key, is_active)`);

  // Storage locations — multi-location stock per tenant (kitchen / walk-in /
  // bar / commissary). v1 default = single 'MAIN' location auto-created.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS storage_locations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT DEFAULT 'KITCHEN',
      is_default INT DEFAULT 0,
      is_active INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Auto-seed a default MAIN location for every tenant on first DB open.
  await db.run(
    `INSERT INTO storage_locations (id, name, kind, is_default, is_active)
     SELECT 'LOC-MAIN', 'Main Storage', 'KITCHEN', 1, 1
      WHERE NOT EXISTS (SELECT 1 FROM storage_locations WHERE id = 'LOC-MAIN')`
  ).catch(() => {});

  // Per-location stock — sums to ingredients.current_stock_qty. v1 keeps a
  // single MAIN row per ingredient; v2 splits across locations with transfer
  // movements logged in stock_movements.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ingredient_location_stock (
      ingredient_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      stock_qty DOUBLE PRECISION DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (ingredient_id, location_id)
    )
  `);

  // Hotel-side inventory items (linens, mini-bar, amenity restocking). Tracked
  // per-room or pool, with par-level alerts. Separate from food ingredients so
  // restaurant deduction logic stays clean. Movements go through stock_movements
  // with reference_type='hotel_item'.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hotel_inventory_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      unit TEXT NOT NULL DEFAULT 'unit',
      current_stock_qty DOUBLE PRECISION DEFAULT 0,
      par_level DOUBLE PRECISION DEFAULT 0,
      reorder_point DOUBLE PRECISION DEFAULT 0,
      default_unit_price DOUBLE PRECISION,
      sku TEXT,
      notes TEXT,
      is_active INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_hotel_items_active ON hotel_inventory_items (is_active)`);

  // Owner-customisable notification templates. Falls back to hard-coded
  // defaults in notificationService.ts when row absent.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS notification_templates (
      event_type TEXT PRIMARY KEY,
      subject_template TEXT,
      body_template TEXT,
      enabled INT DEFAULT 1,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Drag-to-reorder support — display_order is honoured by the Ingredients
  // and Suppliers list endpoints when set; ties broken by name.
  await db.exec("ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS display_order INTEGER").catch(() => {});
  await db.exec("ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS display_order INTEGER").catch(() => {});
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_ingredients_display_order ON ingredients (display_order)`).catch(() => {});

  // ───────────────────────────────────────────────────────────────────────
  // Multi-platform delivery integration (Swiggy / Zomato / Dunzo / Magicpin
  // / ONDC / UrbanPiper) — Phase 1 schema.  Net-new infrastructure on top
  // of the existing checkout_mode abstraction.
  // ───────────────────────────────────────────────────────────────────────

  // Per-order channel facet — orders.checkout_mode stays unchanged, but
  // platform orders also carry external_platform + external_order_id so
  // we can dedup, route status updates back, and reconcile settlements.
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_platform TEXT").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_order_id TEXT").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_id_hash TEXT").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_payload JSONB").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS commission_amount DOUBLE PRECISION DEFAULT 0").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS net_payout_amount DOUBLE PRECISION DEFAULT 0").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS gst_collected_by TEXT DEFAULT 'RESTAURANT'").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_name TEXT").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_phone TEXT").catch(() => {});
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_arrived_at TIMESTAMP").catch(() => {});
  // Partial UNIQUE index — only enforces uniqueness when external_id_hash IS NOT NULL,
  // so the existing in-house orders (without an external id) aren't subject to it.
  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_external_id_hash
      ON orders (external_id_hash) WHERE external_id_hash IS NOT NULL
  `);
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_orders_external_platform_status
      ON orders (external_platform, status, created_at)
  `);

  // Per-menu-item channel facet — owner can override visibility & list ids
  // per channel without bloating the menu row beyond JSONB blobs.
  await db.exec("ALTER TABLE menu ADD COLUMN IF NOT EXISTS external_visibility JSONB DEFAULT '{}'::jsonb").catch(() => {});
  await db.exec("ALTER TABLE menu ADD COLUMN IF NOT EXISTS external_ids JSONB DEFAULT '{}'::jsonb").catch(() => {});
  await db.exec("ALTER TABLE menu ADD COLUMN IF NOT EXISTS sync_dirty INT DEFAULT 0").catch(() => {});
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_menu_sync_dirty ON menu (sync_dirty) WHERE sync_dirty = 1`);

  // (a) Per-channel pricing.  exactly one of (price_override, markup_percent)
  // is non-null.  is_listed = 0 hides this item from this channel entirely.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS channel_prices (
      id TEXT PRIMARY KEY,
      menu_item_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      price_override DOUBLE PRECISION,
      markup_percent DOUBLE PRECISION,
      is_listed INT DEFAULT 1,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (menu_item_id, channel)
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_channel_prices_menu ON channel_prices (menu_item_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_channel_prices_channel ON channel_prices (channel)`);

  // (b) Default channel-wide settings.  Owner sets once; new menu items inherit.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS channel_settings (
      channel TEXT PRIMARY KEY,
      is_active INT DEFAULT 0,
      default_markup_percent DOUBLE PRECISION DEFAULT 25,
      commission_percent DOUBLE PRECISION DEFAULT 25,
      packaging_charge DOUBLE PRECISION DEFAULT 0,
      min_order_amount DOUBLE PRECISION DEFAULT 0,
      prep_time_minutes INT DEFAULT 20,
      webhook_url_inbound TEXT,
      brand_display_name TEXT,
      min_margin_floor_percent DOUBLE PRECISION DEFAULT 5,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // (c) Encrypted per-tenant credentials (AES-256-GCM, master key in env).
  // Master key sourced from process.env.ATITHI_CREDENTIAL_KEY (32-byte base64).
  // Boot guard in server.ts refuses to start if the env var is missing/short.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS integration_credentials (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      metadata JSONB DEFAULT '{}'::jsonb,
      is_active INT DEFAULT 1,
      rotated_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (channel, credential_type)
    )
  `);

  // (d) Idempotency / dedup for inbound webhooks.  idempotency_key is
  // sha256(channel + ':' + signatureHeader) — guarantees a replayed webhook
  // collides with the original and we serve the cached response.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_inbox (
      idempotency_key TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      event_type TEXT NOT NULL,
      external_order_id TEXT,
      raw_payload JSONB NOT NULL,
      signature_verified INT NOT NULL,
      processed_at TIMESTAMP,
      result_status INT,
      result_body TEXT,
      received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      error_message TEXT
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_inbox_received ON webhook_inbox (received_at DESC)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_inbox_unprocessed ON webhook_inbox (channel, processed_at) WHERE processed_at IS NULL`);

  // (e) Outbound background-task queue.  Worker cron in server.ts polls
  // this every 30s with FOR UPDATE SKIP LOCKED so multiple instances are
  // forward-safe.  Exponential backoff: 30s → 60s → 120s → ... → 15m.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pending_sync_jobs (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      channel TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INT DEFAULT 0,
      max_attempts INT DEFAULT 5,
      next_attempt_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_error TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP
    )
  `);
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pending_jobs_due ON pending_sync_jobs (status, next_attempt_at)
      WHERE status IN ('PENDING', 'FAILED')
  `);

  // (f) Channel settlements (one row per platform statement, typically weekly).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS channel_settlements (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      period_from DATE NOT NULL,
      period_to DATE NOT NULL,
      gross_sales DOUBLE PRECISION NOT NULL,
      commission_amount DOUBLE PRECISION NOT NULL,
      payment_gateway_fee DOUBLE PRECISION DEFAULT 0,
      taxes_collected_by_platform DOUBLE PRECISION DEFAULT 0,
      promotional_discount DOUBLE PRECISION DEFAULT 0,
      cancellation_recovery DOUBLE PRECISION DEFAULT 0,
      net_payout DOUBLE PRECISION NOT NULL,
      payout_received_at TIMESTAMP,
      raw_statement_url TEXT,
      reconciled INT DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // (g) Order-to-settlement reconciliation links.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS settlement_order_lines (
      id TEXT PRIMARY KEY,
      settlement_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      external_order_id TEXT,
      gross_amount DOUBLE PRECISION,
      commission_amount DOUBLE PRECISION,
      net_amount DOUBLE PRECISION,
      reconciled_match TEXT,
      variance DOUBLE PRECISION DEFAULT 0
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_settlement_lines_settlement ON settlement_order_lines (settlement_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_settlement_lines_order ON settlement_order_lines (order_id)`);

  // ─────────────────────────────────────────────────────────────────────
  // LOYALTY (Phase 1 — tier-based: Bronze / Silver / Gold by lifetime spend)
  // ─────────────────────────────────────────────────────────────────────
  // Per-tenant. Customer identity is the phone number (canonical).
  // - loyalty_tiers       : owner-configurable thresholds + benefits
  // - loyalty_customers   : per-customer aggregate (the "customers" master
  //                         table that did not exist before — phone is PK)
  // - loyalty_tier_history: audit log of every tier transition
  // - loyalty_redemptions : audit log of every loyalty discount applied

  await db.exec(`
    CREATE TABLE IF NOT EXISTS loyalty_tiers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      min_lifetime_spend DOUBLE PRECISION DEFAULT 0,
      discount_percent DOUBLE PRECISION DEFAULT 0,
      perks TEXT,
      is_enabled INT DEFAULT 1,
      sort_order INT DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS loyalty_customers (
      phone TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      total_orders INT DEFAULT 0,
      total_spent DOUBLE PRECISION DEFAULT 0,
      current_tier_id TEXT,
      first_order_at TIMESTAMP,
      last_order_at TIMESTAMP,
      notes TEXT,
      is_blocked INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_loyalty_customers_tier ON loyalty_customers (current_tier_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_loyalty_customers_spent ON loyalty_customers (total_spent DESC)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_loyalty_customers_last_order ON loyalty_customers (last_order_at DESC)`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS loyalty_tier_history (
      id SERIAL PRIMARY KEY,
      customer_phone TEXT NOT NULL,
      from_tier_id TEXT,
      to_tier_id TEXT NOT NULL,
      trigger_order_id TEXT,
      spent_at_upgrade DOUBLE PRECISION,
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_loyalty_tier_history_phone ON loyalty_tier_history (customer_phone, changed_at DESC)`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS loyalty_redemptions (
      id SERIAL PRIMARY KEY,
      customer_phone TEXT NOT NULL,
      order_id TEXT NOT NULL,
      tier_id TEXT,
      discount_percent DOUBLE PRECISION,
      discount_amount DOUBLE PRECISION,
      redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_phone ON loyalty_redemptions (customer_phone, redeemed_at DESC)`);

  // Phase L2 additions to loyalty_customers:
  //   birthday               DOB for the birthday-rewards cron. NULL = unknown.
  //   marketing_opt_out      1 = customer asked not to receive promotional SMS / email.
  //                          Transactional notifications (tier upgrade) still fire.
  //   last_nudge_sent_at     dedup for near-upgrade nudges so we don't spam.
  await db.exec(`ALTER TABLE loyalty_customers ADD COLUMN IF NOT EXISTS birthday DATE`).catch(() => {});
  await db.exec(`ALTER TABLE loyalty_customers ADD COLUMN IF NOT EXISTS marketing_opt_out INT DEFAULT 0`).catch(() => {});
  await db.exec(`ALTER TABLE loyalty_customers ADD COLUMN IF NOT EXISTS last_nudge_sent_at TIMESTAMP`).catch(() => {});
  // Phase H1 — hotel anniversary perk. anniversary stores YYYY-MM-DD but only
  // the month/day are compared at check-in. last_perk_at dedups so a single
  // booking can't trigger the perk multiple times during the same stay.
  await db.exec(`ALTER TABLE loyalty_customers ADD COLUMN IF NOT EXISTS anniversary DATE`).catch(() => {});
  await db.exec(`ALTER TABLE loyalty_customers ADD COLUMN IF NOT EXISTS last_perk_at TIMESTAMP`).catch(() => {});

  // ─────────────────────────────────────────────────────────────────────
  // PROMO CODES (Phase L2 — owner-managed discount codes layered on tiers)
  // ─────────────────────────────────────────────────────────────────────
  // Owner creates codes like SUMMER25, FRIENDSDAY10, etc.
  //   code                   the customer-typed string (uppercased, unique).
  //   discount_percent       % off subtotal (mutually exclusive with discount_amount).
  //   discount_amount        flat off (when set, percent is ignored).
  //   min_order_amount       optional floor; code is rejected below this subtotal.
  //   max_uses               total redemptions across all customers (NULL = unlimited).
  //   max_uses_per_customer  per-customer cap (typical: 1 for one-shot codes).
  //   used_count             running counter, incremented atomically on redeem.
  //   starts_at, expires_at  optional validity window.
  //   restricted_tier_id     if set, only customers in this tier can redeem.
  //   stack_with_tier        1 = adds to tier discount (e.g. Silver 5% + code 10% = 15%);
  //                          0 = takes the larger of the two (default — safer).
  //   is_enabled             owner soft-disable toggle.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      label TEXT,
      discount_percent DOUBLE PRECISION DEFAULT 0,
      discount_amount DOUBLE PRECISION DEFAULT 0,
      min_order_amount DOUBLE PRECISION DEFAULT 0,
      max_uses INT,
      max_uses_per_customer INT DEFAULT 1,
      used_count INT DEFAULT 0,
      starts_at TIMESTAMP,
      expires_at TIMESTAMP,
      restricted_tier_id TEXT,
      stack_with_tier INT DEFAULT 0,
      is_enabled INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_promo_codes_enabled ON promo_codes (is_enabled, expires_at)`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS promo_redemptions (
      id SERIAL PRIMARY KEY,
      promo_code_id TEXT NOT NULL,
      code TEXT NOT NULL,
      customer_phone TEXT,
      order_id TEXT NOT NULL,
      discount_amount DOUBLE PRECISION,
      redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_promo_redemptions_code ON promo_redemptions (promo_code_id, redeemed_at DESC)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_promo_redemptions_phone ON promo_redemptions (customer_phone, redeemed_at DESC)`);

  // First-time seed of default tiers per tenant. Owner can edit / disable
  // any of them via the LOYALTY tab; ON CONFLICT DO NOTHING means edits
  // survive future tenant DB initialisations.
  await db.run(
    `INSERT INTO loyalty_tiers (id, name, min_lifetime_spend, discount_percent, perks, sort_order)
     VALUES ('BRONZE', 'Bronze', 0, 0, 'Welcome tier — every customer starts here.', 1)
     ON CONFLICT (id) DO NOTHING`
  ).catch(() => {});
  await db.run(
    `INSERT INTO loyalty_tiers (id, name, min_lifetime_spend, discount_percent, perks, sort_order)
     VALUES ('SILVER', 'Silver', 10000, 5, 'Loyal customer — 5% off every order.', 2)
     ON CONFLICT (id) DO NOTHING`
  ).catch(() => {});
  await db.run(
    `INSERT INTO loyalty_tiers (id, name, min_lifetime_spend, discount_percent, perks, sort_order)
     VALUES ('GOLD', 'Gold', 50000, 10, 'VIP — 10% off every order, priority service.', 3)
     ON CONFLICT (id) DO NOTHING`
  ).catch(() => {});

  // ─────────────────────────────────────────────────────────────────────
  // TAX CONFIG (Phase 2 — multi-currency + configurable tax)
  // ─────────────────────────────────────────────────────────────────────
  // Per-tenant tax line configuration. Empty for fresh tenants — they get
  // their preset rows seeded from TAX_PRESETS[restaurants.tax_template_id]
  // on first /tax-config GET in server.ts. The schema is a superset so the
  // same row can represent: a flat US Sales Tax, an Australian inclusive
  // GST, a split Indian intrastate GST (CGST + SGST via split_intrastate),
  // or an EU VAT — all without code branches downstream.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tax_config (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      rate_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
      is_inclusive INT DEFAULT 0,
      applies_to TEXT DEFAULT 'TOTAL',
      display_order INT DEFAULT 0,
      enabled INT DEFAULT 1,
      split_intrastate INT DEFAULT 0,
      cgst_share DOUBLE PRECISION DEFAULT 0.5,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Snapshot columns on orders + folios. Captured at INSERT time so a past
  // order reprints with its original currency / tax labels even if the
  // tenant later switches country or tax preset. Backwards-compatible:
  // existing rows have NULL, code falls back to the live tenant settings.
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency_snapshot TEXT`).catch(() => {});
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_label_snapshot TEXT`).catch(() => {});

  // M-4 — Sec 9(5) ECO GST tracking. When an order arrives via an
  // e-commerce operator (Swiggy / Zomato / ONDC / UrbanPiper marketplace
  // mode), GST liability shifts to the ECO per CGST Sec 9(5). The
  // restaurant must EXCLUDE these from output liability — so we mark the
  // row at insert time and surface a separate analytics line. eco_platform
  // duplicates external_platform but lives independently so a future
  // platform that ISN'T sec-9(5) (e.g. direct-rate Swiggy aggregator
  // contract) can be exempted without renaming the channel.
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_eco_paid INT DEFAULT 0`).catch(() => {});
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS eco_platform TEXT`).catch(() => {});
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_eco ON orders (eco_platform, created_at DESC) WHERE is_eco_paid = 1`).catch(() => {});

  // R-3 (BCG follow-up) — GST E-Invoice IRN columns on orders + folios.
  // Storage of the IRP response. Either populated by the tenant's GSP
  // integration via POST /invoices/.../irn, or pasted in manually by the
  // accountant. Without these, the invoice PDF prints "IRN PENDING" and
  // the tenant is at risk of a compliance fine when reconciling.
  //   irn               64-char hex hash returned by IRP
  //   ack_no            IRP acknowledgement number
  //   ack_date          ISO date IRP accepted the invoice
  //   signed_qr_code    base64 of the signed QR payload (embeds GSTIN+IRN+amount)
  //   irn_status        'PENDING' (default) | 'GENERATED' | 'CANCELLED' | 'FAILED'
  //   irn_cancel_reason populated when status=CANCELLED
  //   irn_applied_at    when we POSTed to IRP
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS irn TEXT`).catch(() => {});
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ack_no TEXT`).catch(() => {});
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ack_date TIMESTAMP`).catch(() => {});
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS signed_qr_code TEXT`).catch(() => {});
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS irn_status TEXT DEFAULT 'PENDING'`).catch(() => {});
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS irn_cancel_reason TEXT`).catch(() => {});
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS irn_applied_at TIMESTAMP`).catch(() => {});
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_irn_pending ON orders (created_at) WHERE irn IS NULL`).catch(() => {});

  await db.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS irn TEXT`).catch(() => {});
  await db.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS ack_no TEXT`).catch(() => {});
  await db.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS ack_date TIMESTAMP`).catch(() => {});
  await db.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS signed_qr_code TEXT`).catch(() => {});
  await db.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS irn_status TEXT DEFAULT 'PENDING'`).catch(() => {});
  await db.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS irn_cancel_reason TEXT`).catch(() => {});
  await db.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS irn_applied_at TIMESTAMP`).catch(() => {});

  // R-1 (BCG follow-up) — DPDP 2023 per-tenant tables.
  //
  // dpdp_consent_log — append-only ledger of every consent grant or
  //   withdrawal. The Act requires "verifiable consent" with proof that
  //   the principal was shown the notice; we log the policy version,
  //   IP, user-agent, and scope.
  //
  // dpdp_subject_requests — Data Principal Rights requests (Sec 11-14):
  //   ACCESS    → tenant must return all data for the subject
  //   ERASURE   → subject wants their data deleted/anonymised
  //   CORRECTION→ correct an error
  //   GRIEVANCE → complaint routed to DPO
  //   PORTABILITY → machine-readable export (we treat same as ACCESS)
  //   Status transitions: RECEIVED → IN_PROGRESS → FULFILLED / REJECTED
  await db.exec(`
    CREATE TABLE IF NOT EXISTS dpdp_consent_log (
      id              TEXT PRIMARY KEY,
      subject_phone   TEXT,
      subject_email   TEXT,
      subject_type    TEXT NOT NULL,             -- 'GUEST' | 'CUSTOMER' | 'STAFF' | 'PROSPECT'
      consent_action  TEXT NOT NULL,             -- 'GRANTED' | 'WITHDRAWN'
      consent_scope   TEXT NOT NULL,             -- 'DATA_PROCESSING' | 'MARKETING' | 'ANALYTICS' | 'THIRD_PARTY_SHARE'
      policy_version  TEXT,
      source_channel  TEXT,                      -- 'BOOKING' | 'CHECKOUT' | 'QR' | 'STAFF_ENTRY' | 'OWNER_BACKFILL'
      source_ip       TEXT,
      user_agent      TEXT,
      notes           TEXT,
      recorded_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_dpdp_consent_phone ON dpdp_consent_log (subject_phone)`).catch(() => {});
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_dpdp_consent_recorded ON dpdp_consent_log (recorded_at DESC)`).catch(() => {});

  await db.exec(`
    CREATE TABLE IF NOT EXISTS dpdp_subject_requests (
      id              TEXT PRIMARY KEY,
      subject_phone   TEXT,
      subject_email   TEXT,
      request_type    TEXT NOT NULL,             -- ACCESS | ERASURE | CORRECTION | GRIEVANCE | PORTABILITY
      status          TEXT NOT NULL DEFAULT 'RECEIVED',
      requester_note  TEXT,
      requested_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      assigned_to     TEXT,                      -- user id of staff handling it
      fulfilled_at    TIMESTAMP,
      fulfillment_payload TEXT,                  -- JSON snapshot for ACCESS/PORTABILITY
      response_note   TEXT,
      source_channel  TEXT,
      source_ip       TEXT,
      user_agent      TEXT
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_dpdp_req_status ON dpdp_subject_requests (status, requested_at DESC)`).catch(() => {});
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_dpdp_req_phone ON dpdp_subject_requests (subject_phone)`).catch(() => {});

  // ─────────────────────────────────────────────────────────────────────
  // STAFF ROSTER + TIMESHEET (Phase 3)
  // ─────────────────────────────────────────────────────────────────────
  // Reusable shift templates (owner-editable: e.g. "Morning 9-1", "Evening 6-11").
  await db.exec(`
    CREATE TABLE IF NOT EXISTS shift_templates (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      expected_hours DOUBLE PRECISION,
      role_filter TEXT,
      color TEXT,
      is_archived INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Roster slots: one row per (staff, date, start_time). Either built from
  // a template (template_id) or filled with explicit times. status moves
  // DRAFT → PUBLISHED → CANCELLED. SHIFT_* notifications fire on publish.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS roster_slots (
      id TEXT PRIMARY KEY,
      staff_id TEXT NOT NULL,
      shift_date DATE NOT NULL,
      template_id TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      expected_hours DOUBLE PRECISION,
      status TEXT DEFAULT 'PUBLISHED',
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      notes TEXT
    )
  `);
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_roster_unique ON roster_slots (staff_id, shift_date, start_time)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_roster_date ON roster_slots (shift_date)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_roster_staff_date ON roster_slots (staff_id, shift_date)`);

  // Audit trail for slot changes (drives notifications + post-mortem reports).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS roster_change_log (
      id SERIAL PRIMARY KEY,
      slot_id TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_by TEXT,
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      notified INT DEFAULT 0
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_roster_log_slot ON roster_change_log (slot_id, changed_at DESC)`);

  // Denormalised daily view of planned vs actual hours. Materialised at
  // 23:59 IST by the timesheet cron in server.ts; also recomputable on
  // demand via POST /api/restaurant/:id/timesheet/recompute.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS timesheet_day (
      staff_id TEXT NOT NULL,
      shift_date DATE NOT NULL,
      planned_hours DOUBLE PRECISION DEFAULT 0,
      actual_hours DOUBLE PRECISION DEFAULT 0,
      variance_hours DOUBLE PRECISION DEFAULT 0,
      is_no_show INT DEFAULT 0,
      is_overtime INT DEFAULT 0,
      notes TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (staff_id, shift_date)
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_timesheet_date ON timesheet_day (shift_date)`);

  // Phase S2 — approval workflow on each timesheet row. status starts as
  // 'AUTO' for rows that fall within the variance threshold (auto-approved),
  // 'PENDING' for rows over threshold (owner action required), then moves
  // to 'APPROVED' or 'REJECTED' via PATCH.
  await db.exec(`ALTER TABLE timesheet_day ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'AUTO'`).catch(() => {});
  await db.exec(`ALTER TABLE timesheet_day ADD COLUMN IF NOT EXISTS approved_by TEXT`).catch(() => {});
  await db.exec(`ALTER TABLE timesheet_day ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP`).catch(() => {});
  await db.exec(`ALTER TABLE timesheet_day ADD COLUMN IF NOT EXISTS approval_notes TEXT`).catch(() => {});
  await db.exec(`ALTER TABLE timesheet_day ADD COLUMN IF NOT EXISTS hourly_rate_snapshot DOUBLE PRECISION DEFAULT 0`).catch(() => {});
  await db.exec(`ALTER TABLE timesheet_day ADD COLUMN IF NOT EXISTS pay_amount DOUBLE PRECISION DEFAULT 0`).catch(() => {});
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_timesheet_status ON timesheet_day (status, shift_date)`).catch(() => {});

  // Cache stores the init promise (set by getTenantDb above); we return
  // the resolved DbInterface here. No need to re-cache.
  return db;
}

export async function getNextSequence(name: string): Promise<number> {
  const rows = await centralDb.query(`
    INSERT INTO sequences (name, current_value) VALUES (?, 1)
    ON CONFLICT (name) DO UPDATE SET current_value = sequences.current_value + 1
    RETURNING current_value
  `, [name]);
  return rows[0].current_value;
}

// Per-tenant atomic counter. Each tenant DB has its own `sequences` table
// (created in the tenant schema during getTenantDb()). Used for sequential
// invoice numbering — caller picks the sequence name (e.g. 'invoice' for a
// continuous counter, or 'invoice-2026' for a yearly-reset counter).
export async function getNextTenantSequence(tenantDb: DbInterface, name: string): Promise<number> {
  const rows = await tenantDb.query(`
    INSERT INTO sequences (name, current_value) VALUES (?, 1)
    ON CONFLICT (name) DO UPDATE SET current_value = sequences.current_value + 1
    RETURNING current_value
  `, [name]);
  return rows[0].current_value;
}
