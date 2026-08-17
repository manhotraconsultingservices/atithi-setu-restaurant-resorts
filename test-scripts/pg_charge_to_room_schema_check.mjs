// Real-Postgres schema-conformance regression for the "Charge to Room → folio"
// bug. The offline sims MISSED this because they never touched a real database:
// the room-charge-request/approve + charge-session-to-room code was written in
// SQLite dialect (datetime('now')) against columns that do not exist on the
// current Postgres schema (orders.items_json / session_token / restaurant_id /
// table_id), so every call threw and the F&B never posted to the folio.
//
// This test creates its OWN throwaway schema (_ctr_regression_check), builds the
// REAL orders / room_charge_requests / folios / folio_entries tables, runs the
// CORRECTED queries the fixed code uses (they must succeed), and — as a guard —
// runs the OLD buggy statements (they must FAIL). It then DROP SCHEMA CASCADE.
// It never reads or writes any real tenant data.
//
// Run:  node test-scripts/pg_charge_to_room_schema_check.mjs
//   with DATABASE_URL, or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE set the same
//   way the app is (see db.ts). Point it at any dev/throwaway Postgres.
import pg from 'pg';

const SCHEMA = '_ctr_regression_check';
const conn = process.env.DATABASE_URL ||
  `postgresql://${process.env.PGUSER || 'postgres'}:${process.env.PGPASSWORD || 'postgres'}@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || '5432'}/${process.env.PGDATABASE || 'restoflow'}`;
const pool = new pg.Pool({ connectionString: conn, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false });

let pass = 0, fail = 0;
const ok = (n, m = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${m ? ' — ' + m : ''}`); };
const bad = (n, m = '') => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}${m ? ' — ' + m : ''}`); };
const throws = async (sql) => { try { await pool.query(sql); return false; } catch { return true; } };

try {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await pool.query(`SET search_path TO ${SCHEMA}`);

  // Real orders schema (db.ts base + the RS-bridge migrations). NOTE what is
  // ABSENT: restaurant_id, table_id, items_json, session_token.
  await pool.query(`CREATE TABLE orders (
    id TEXT PRIMARY KEY, table_number TEXT, items TEXT, total_amount DOUBLE PRECISION,
    gst_amount DOUBLE PRECISION DEFAULT 0, status TEXT, payment_status TEXT DEFAULT 'PENDING',
    payment_method TEXT, customer_name TEXT, customer_phone TEXT, customer_email TEXT,
    session_id TEXT, room_id TEXT, booking_id TEXT, folio_id TEXT,
    posted_to_folio_at TIMESTAMP, folio_post_status TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await pool.query(`CREATE TABLE folios (id TEXT PRIMARY KEY, booking_id TEXT, room_id TEXT, status TEXT, subtotal DOUBLE PRECISION DEFAULT 0, gst_amount DOUBLE PRECISION DEFAULT 0, grand_total DOUBLE PRECISION DEFAULT 0)`);
  await pool.query(`CREATE TABLE folio_entries (id TEXT PRIMARY KEY, folio_id TEXT, entry_type TEXT, entry_subtype TEXT, description TEXT, quantity DOUBLE PRECISION, unit_price DOUBLE PRECISION, amount DOUBLE PRECISION, gst_rate DOUBLE PRECISION, gst_amount DOUBLE PRECISION, source_id TEXT, reference_number TEXT, posted_by TEXT, cost_centre TEXT, account_head TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await pool.query(`CREATE TABLE table_sessions (id TEXT PRIMARY KEY, session_token TEXT, status TEXT)`);

  // 1. FIXED room_charge_requests DDL (CURRENT_TIMESTAMP default) must create.
  if (!(await throws(`CREATE TABLE room_charge_requests (
      id TEXT PRIMARY KEY, restaurant_id TEXT, session_token TEXT, session_id TEXT,
      room_id TEXT, booking_id TEXT, cart_json TEXT DEFAULT '[]', amount REAL DEFAULT 0,
      status TEXT DEFAULT 'PENDING', order_id TEXT, folio_id TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`)))
    ok('room_charge_requests create (CURRENT_TIMESTAMP default)');
  else bad('room_charge_requests create (CURRENT_TIMESTAMP default)', 'should succeed');

  // 2. FIXED approve INSERT into orders (real columns + CURRENT_TIMESTAMP).
  if (!(await throws(`INSERT INTO orders
      (id, table_number, customer_name, customer_phone, items, total_amount,
       payment_method, payment_status, status, session_id, room_id, booking_id, created_at)
     VALUES ('O-NEW','Room 101','Guest',NULL,'[{"name":"Tea","price":50,"quantity":2}]',100,
             'CHARGE_TO_ROOM','PENDING','PENDING','S1','RM1','BK1', CURRENT_TIMESTAMP)`)))
    ok('approve INSERT (real columns + CURRENT_TIMESTAMP)');
  else bad('approve INSERT (real columns + CURRENT_TIMESTAMP)', 'should succeed');

  // 3. FIXED charge-session SELECT (items, session_id) must parse.
  if (!(await throws(`SELECT o.id, o.total_amount, o.items FROM orders o
      WHERE o.session_id = 'S1' AND UPPER(COALESCE(o.status,'')) <> 'CANCELLED'
        AND (o.posted_to_folio_at IS NULL OR o.folio_id IS NULL)`)))
    ok('charge-session SELECT (items / session_id)');
  else bad('charge-session SELECT (items / session_id)', 'should succeed');

  // 4. FIXED folio_entries INSERT (the postOrderToFolio line) must succeed.
  await pool.query(`INSERT INTO folios (id, booking_id, room_id, status) VALUES ('F1','BK1','RM1','open')`);
  if (!(await throws(`INSERT INTO folio_entries
      (id, folio_id, entry_type, entry_subtype, description, quantity, unit_price, amount,
       gst_rate, gst_amount, source_id, reference_number, posted_by, cost_centre, account_head)
     VALUES ('FE1','F1','F_AND_B','RESTAURANT','Tea',2,50,100,5,5,'O-NEW','O-NEW','staff','F_AND_B','F_AND_B_REVENUE')`)))
    ok('folio_entries INSERT (F_AND_B line lands on folio)');
  else bad('folio_entries INSERT (F_AND_B line lands on folio)', 'should succeed');

  // 5. REGRESSION GUARDS — the OLD buggy statements MUST fail on Postgres.
  if (await throws(`CREATE TABLE rcr_old (created_at TEXT NOT NULL DEFAULT (datetime('now')))`))
    ok("guard: OLD default datetime('now') rejected");
  else bad("guard: OLD default datetime('now') rejected", 'old bug would still work?!');

  if (await throws(`INSERT INTO orders (id, restaurant_id, items_json, session_token, created_at)
                    VALUES ('O-OLD','R','[]',NULL, datetime('now'))`))
    ok('guard: OLD approve INSERT (restaurant_id/items_json/session_token/datetime) rejected');
  else bad('guard: OLD approve INSERT rejected', 'old bug would still work?!');

  // 6. Prove the F&B is actually visible on the folio after the fixed path.
  const { rows } = await pool.query(`SELECT COALESCE(SUM(amount),0)+COALESCE(SUM(gst_amount),0) AS t,
                                            COUNT(*) AS n FROM folio_entries WHERE folio_id='F1'`);
  if (Number(rows[0].n) === 1 && Math.abs(Number(rows[0].t) - 105) < 0.01)
    ok(`F&B reflected on folio (₹${rows[0].t}, ${rows[0].n} line)`);
  else bad('F&B reflected on folio', `got total=${rows[0].t} n=${rows[0].n}`);

} catch (e) {
  bad('schema-check harness', e.message);
} finally {
  try { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } catch { /* */ }
  await pool.end();
}
console.log(`\n${fail === 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
