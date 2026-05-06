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
      const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
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

const tenantDbCache = new Map<string, DbInterface>();

export async function getTenantDb(restaurantId: string): Promise<DbInterface> {
  const schema = tenantSchema(restaurantId);
  if (tenantDbCache.has(schema)) return tenantDbCache.get(schema)!;

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
      is_available INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

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

  // Migrations for existing tenant schemas — table monitoring
  await db.exec("ALTER TABLE tables ADD COLUMN IF NOT EXISTS assigned_waiter_id TEXT");

  // Migrations for existing tenant schemas — orders (prepaid/postpaid/cloud_kitchen)
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS session_id TEXT");
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_mode TEXT DEFAULT 'postpaid'");
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS round_number INTEGER DEFAULT 1");
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS kitchen_status TEXT DEFAULT 'queued'");
  // Cloud-kitchen / online-delivery: structured customer delivery address
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_address_line1 TEXT");
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_address_line2 TEXT");
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_city TEXT");
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_pincode TEXT");
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_landmark TEXT");

  await db.exec("ALTER TABLE attendance_staff ADD COLUMN IF NOT EXISTS default_hours DOUBLE PRECISION DEFAULT 8");
  await db.exec("ALTER TABLE attendance_staff ADD COLUMN IF NOT EXISTS login_id TEXT");
  await db.exec("ALTER TABLE attendance_staff ADD COLUMN IF NOT EXISTS password TEXT");
  // Add unique index on login_id (CREATE UNIQUE INDEX IF NOT EXISTS is safe to run multiple times)
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_staff_login_id ON attendance_staff (login_id) WHERE login_id IS NOT NULL`).catch(() => {});
  // Bookings migrations
  await db.exec("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_email TEXT");
  await db.exec("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booked_by TEXT");
  await db.exec("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notes TEXT");

  // Postpaid invoice adjustments on table_sessions
  await db.exec("ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS discount_amount DOUBLE PRECISION DEFAULT 0");
  await db.exec("ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS service_charge_percent DOUBLE PRECISION DEFAULT 0");
  await db.exec("ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS gst_percent DOUBLE PRECISION DEFAULT 0");
  await db.exec("ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS apply_gst INTEGER DEFAULT 1");
  await db.exec("ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS final_amount DOUBLE PRECISION DEFAULT 0");

  // Invoice status tracking
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_status TEXT DEFAULT 'DRAFT'");
  await db.exec("ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS invoice_status TEXT DEFAULT 'DRAFT'");

  // GST persistence on the ORDER row (separate from table_sessions which has
  // its own gst_percent/apply_gst). Older tenants only got these via the
  // manual-invoice / invoice-edit endpoints; freshly provisioned tenants whose
  // first traffic was a customer order would 500 because /orders POST
  // INSERTs into these columns. Migrating them here means every tenant has
  // them from the first request, regardless of which endpoint hit first.
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS gst_percent FLOAT DEFAULT 0");
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS apply_gst INTEGER DEFAULT 1");

  // Telegram notification support
  await db.exec("ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS telegram_enabled INT DEFAULT 0");
  await db.exec("ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT DEFAULT ''");

  // Scheduler support — HH:MM time for auto-fire (e.g. "22:00" = 10 PM daily)
  await db.exec("ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS schedule_time TEXT DEFAULT ''")

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
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_number TEXT");
  await db.exec("ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS invoice_number TEXT");

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
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS inventory_reverted INT DEFAULT 0");

  tenantDbCache.set(schema, db);
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
