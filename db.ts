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

  // Migrations for existing tenant schemas — orders (prepaid/postpaid)
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS session_id TEXT");
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_mode TEXT DEFAULT 'postpaid'");
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS round_number INTEGER DEFAULT 1");
  await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS kitchen_status TEXT DEFAULT 'queued'");

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

  // Telegram notification support
  await db.exec("ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS telegram_enabled INT DEFAULT 0");
  await db.exec("ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT DEFAULT ''");

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
