// Real-Postgres schema-conformance regression for the channel_room_mappings
// upsert bug: "could not determine data type of parameter $4".
//
// The unique index is on an EXPRESSION — COALESCE(external_rate_plan_code, '') —
// and external_rate_plan_code is the 4th INSERT parameter ($4). During ON CONFLICT
// arbiter inference Postgres must resolve $4's type inside that COALESCE; a bare
// parameter (especially NULL) has no type context, so the whole statement fails
// at PLAN time — the mapping never saves. The fix casts the nullable text params
// (…$4::text…) so Postgres can determine the type.
//
// This test builds a throwaway schema with the REAL table + expression index,
// runs the OLD (uncast) upsert with a NULL rate plan (must FAIL) and the NEW
// (::text) upsert (must SUCCEED, both insert and conflict-update paths), then
// DROP SCHEMA CASCADE. It never touches tenant data.
//
// Run:  node test-scripts/pg_channel_mapping_upsert_check.mjs
//   with DATABASE_URL, or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE set as the
//   app is (see db.ts). Point it at any dev/throwaway Postgres.
import pg from 'pg';

const SCHEMA = '_crm_upsert_regression_check';
const conn = process.env.DATABASE_URL ||
  `postgresql://${process.env.PGUSER || 'postgres'}:${process.env.PGPASSWORD || 'postgres'}@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || '5432'}/${process.env.PGDATABASE || 'restoflow'}`;
const pool = new pg.Pool({ connectionString: conn, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false });

let pass = 0, fail = 0;
const ok  = (n, m = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${m ? ' — ' + m : ''}`); };
const bad = (n, m = '') => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}${m ? ' — ' + m : ''}`); };

const OLD_SQL = `INSERT INTO channel_room_mappings
   (id, channel, external_room_code, external_rate_plan_code, local_room_id, local_room_type_id, rate_plan_id, label, is_active, notes)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
 ON CONFLICT (channel, external_room_code, COALESCE(external_rate_plan_code, ''))
 DO UPDATE SET local_room_type_id = EXCLUDED.local_room_type_id, rate_plan_id = EXCLUDED.rate_plan_id,
   label = EXCLUDED.label, is_active = EXCLUDED.is_active, updated_at = CURRENT_TIMESTAMP`;
const NEW_SQL = `INSERT INTO channel_room_mappings
   (id, channel, external_room_code, external_rate_plan_code, local_room_id, local_room_type_id, rate_plan_id, label, is_active, notes)
 VALUES ($1, $2, $3, $4::text, $5::text, $6::text, $7::text, $8::text, $9, $10::text)
 ON CONFLICT (channel, external_room_code, COALESCE(external_rate_plan_code, ''))
 DO UPDATE SET local_room_type_id = EXCLUDED.local_room_type_id, rate_plan_id = EXCLUDED.rate_plan_id,
   label = EXCLUDED.label, is_active = EXCLUDED.is_active, updated_at = CURRENT_TIMESTAMP`;

// params with external_rate_plan_code (=$4) NULL — the failing case.
const p = (id, rt, rp) => [id, 'AIOSELL', 'AIO-ROOM-1', null, null, rt, rp, 'Deluxe (Aiosell)', 1, null];

try {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await pool.query(`SET search_path TO ${SCHEMA}`);

  // Real channel_room_mappings table + the expression unique index (db.ts 773-905).
  await pool.query(`CREATE TABLE channel_room_mappings (
    id TEXT PRIMARY KEY, channel TEXT NOT NULL, external_room_code TEXT NOT NULL,
    external_rate_plan_code TEXT, local_room_id TEXT, local_room_type_id TEXT,
    rate_plan_id TEXT, label TEXT, is_active INTEGER DEFAULT 1, notes TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await pool.query(`CREATE UNIQUE INDEX idx_crm_unique
    ON channel_room_mappings (channel, external_room_code, COALESCE(external_rate_plan_code, ''))`);

  // 1. OLD (uncast) upsert with a NULL rate-plan code must FAIL to type $4.
  let oldThrew = false, oldErr = '';
  try { await pool.query(OLD_SQL, p('CRM-OLD', 'RT_DELUXE', null)); }
  catch (e) { oldThrew = true; oldErr = String(e.message || e); }
  if (oldThrew && /determine data type|parameter \$4/i.test(oldErr)) ok('OLD uncast upsert fails to type $4 (reproduces the bug)', oldErr.split('\n')[0]);
  else if (oldThrew) ok('OLD uncast upsert fails (some Postgres versions)', oldErr.split('\n')[0]);
  else bad('OLD uncast upsert unexpectedly succeeded', 'expected a type-inference failure');

  // 2. NEW (::text) upsert — INSERT path must succeed.
  try { await pool.query(NEW_SQL, p('CRM-NEW', 'RT_DELUXE', null)); ok('NEW ::text upsert inserts cleanly (null rate plan)'); }
  catch (e) { bad('NEW ::text upsert insert', String(e.message || e).split('\n')[0]); }

  // 3. NEW upsert — CONFLICT/UPDATE path (Update button): same external key, changed room type + rate plan.
  try {
    await pool.query(NEW_SQL, p('CRM-NEW-2', 'RT_SUPERIOR', 'LOCAL_RP_BAR'));
    const r = await pool.query(`SELECT local_room_type_id, rate_plan_id FROM channel_room_mappings
      WHERE channel = 'AIOSELL' AND external_room_code = 'AIO-ROOM-1' AND external_rate_plan_code IS NULL`);
    const row = r.rows[0] || {};
    if (row.local_room_type_id === 'RT_SUPERIOR' && row.rate_plan_id === 'LOCAL_RP_BAR')
      ok('NEW ::text upsert updates room type + rate plan on conflict (Update button works)');
    else bad('NEW upsert conflict-update did not apply', JSON.stringify(row));
  } catch (e) { bad('NEW ::text upsert conflict-update', String(e.message || e).split('\n')[0]); }

  // 4. Readback SELECT with ?::text IS NULL branch must not throw on a null code.
  try {
    await pool.query(`SELECT * FROM channel_room_mappings WHERE channel = $1 AND external_room_code = $2
      AND (external_rate_plan_code = $3::text OR (external_rate_plan_code IS NULL AND $4::text IS NULL))`,
      ['AIOSELL', 'AIO-ROOM-1', null, null]);
    ok('readback SELECT with ::text-cast null branch runs');
  } catch (e) { bad('readback SELECT null branch', String(e.message || e).split('\n')[0]); }

} catch (e) {
  console.error('\x1b[31mFATAL\x1b[0m', e.message || e);
  fail++;
} finally {
  try { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } catch { /* best-effort */ }
  await pool.end();
}

console.log(`\n${'─'.repeat(56)}\n  ${fail === 0 ? '\x1b[32m✅ ALL PASS\x1b[0m' : '\x1b[31m❌ FAILURES\x1b[0m'} — ${pass} passed, ${fail} failed\n${'─'.repeat(56)}\n`);
process.exit(fail === 0 ? 0 : 1);
