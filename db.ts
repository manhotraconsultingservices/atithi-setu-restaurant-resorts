import Database from "better-sqlite3";
import { Pool } from "pg";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_TYPE = process.env.DB_TYPE || 'sqlite';

// SQLite setup
const dbsDir = path.join(process.cwd(), "dbs");
if (!fs.existsSync(dbsDir)) {
  fs.mkdirSync(dbsDir, { recursive: true });
}

// Postgres setup
const pgConfig = {
  host: process.env.PGHOST,
  port: parseInt(process.env.PGPORT || '5432'),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
};

let pgPool: Pool | null = null;
if (DB_TYPE === 'postgres') {
  pgPool = new Pool(pgConfig);
}

export interface DbInterface {
  query: (sql: string, params?: any[]) => Promise<any[]>;
  get: (sql: string, params?: any[]) => Promise<any>;
  run: (sql: string, params?: any[]) => Promise<any>;
  exec: (sql: string) => Promise<void>;
}

class SqliteDb implements DbInterface {
  private db: Database.Database;
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }
  async query(sql: string, params: any[] = []) {
    return this.db.prepare(sql).all(...params);
  }
  async get(sql: string, params: any[] = []) {
    return this.db.prepare(sql).get(...params);
  }
  async run(sql: string, params: any[] = []) {
    return this.db.prepare(sql).run(...params);
  }
  async exec(sql: string) {
    this.db.exec(sql);
  }
}

class PostgresDb implements DbInterface {
  private pool: Pool;
  private schema: string;
  constructor(pool: Pool, schema: string = 'public') {
    this.pool = pool;
    this.schema = schema;
  }
  async query(sql: string, params: any[] = []) {
    let count = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++count}`);
    const res = await this.pool.query(pgSql, params);
    return res.rows;
  }
  async get(sql: string, params: any[] = []) {
    const rows = await this.query(sql, params);
    return rows[0];
  }
  async run(sql: string, params: any[] = []) {
    const rows = await this.query(sql, params);
    return { changes: rows.length }; // Mocking better-sqlite3 run result
  }
  async exec(sql: string) {
    await this.pool.query(sql);
  }
}

export const centralDb: DbInterface = DB_TYPE === 'postgres' 
  ? new PostgresDb(pgPool!) 
  : new SqliteDb(path.join(__dirname, "central.db"));

export async function initDb() {
  await centralDb.exec(`
    CREATE TABLE IF NOT EXISTS restaurants (
      id TEXT PRIMARY KEY,
      name TEXT,
      admin_id TEXT,
      state TEXT,
      city TEXT,
      is_active INTEGER DEFAULT 0,
      sales_rep_id TEXT,
      registered_at DATETIME,
      subscription_expires_at DATETIME
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
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS sequences (
      name TEXT PRIMARY KEY,
      current_value INTEGER DEFAULT 0
    );
  `);
}

const tenantDbCache = new Map<string, DbInterface>();

export async function getTenantDb(restaurantId: string): Promise<DbInterface> {
  if (tenantDbCache.has(restaurantId)) return tenantDbCache.get(restaurantId)!;

  let db: DbInterface;
  if (DB_TYPE === 'postgres') {
    db = new PostgresDb(pgPool!); 
  } else {
    const dbPath = path.join(dbsDir, `${restaurantId}.db`);
    db = new SqliteDb(dbPath);
  }

  // Initialize tenant schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      table_number TEXT,
      items TEXT,
      total_amount REAL,
      status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  tenantDbCache.set(restaurantId, db);
  return db;
}

export async function getNextSequence(name: string): Promise<number> {
  const row = await centralDb.get("SELECT current_value FROM sequences WHERE name = ?", [name]);
  if (!row) {
    await centralDb.run("INSERT INTO sequences (name, current_value) VALUES (?, 1)", [name]);
    return 1;
  }
  const nextValue = row.current_value + 1;
  await centralDb.run("UPDATE sequences SET current_value = ? WHERE name = ?", [nextValue, name]);
  return nextValue;
}
