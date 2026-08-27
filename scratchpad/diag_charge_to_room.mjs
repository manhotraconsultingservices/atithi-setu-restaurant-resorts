// Read-only diagnostic: does charge-to-room F&B actually land on the booking's open folio?
// Connects to the local dev Postgres (localhost:5432) using .env creds.
import fs from 'node:fs';
import pg from 'pg';

// Parse .env for PG creds (don't print the password).
const env = {};
for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const pool = new pg.Pool({
  host: 'localhost',
  port: Number(env.PGPORT || 5432),
  user: env.PGUSER,
  password: env.PGPASSWORD,
  database: env.PGDATABASE,
  ssl: false,
});

const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

try {
  // 1. Tenant schemas (exclude system schemas).
  const schemas = (await q(
    `SELECT schema_name FROM information_schema.schemata
      WHERE schema_name NOT IN ('public','pg_catalog','information_schema','pg_toast')
        AND schema_name NOT LIKE 'pg_%' ORDER BY schema_name`
  )).map(r => r.schema_name);
  console.log(`Tenant schemas (${schemas.length}):`, schemas.join(', ') || '(none)');

  let anyFound = false;
  for (const s of schemas) {
    // Does this schema have the tables we need?
    const hasOrders = (await q(
      `SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='orders'`, [s]
    )).length > 0;
    const hasFolios = (await q(
      `SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='folios'`, [s]
    )).length > 0;
    if (!hasOrders || !hasFolios) continue;

    await pool.query(`SET search_path TO "${s}"`);
    // CHARGE_TO_ROOM orders.
    const ctr = await q(
      `SELECT id, booking_id, room_id, folio_id, posted_to_folio_at, folio_post_status,
              total_amount, session_id, status,
              (SELECT COUNT(*) FROM folio_entries fe WHERE fe.reference_number = o.id) AS fe_count,
              (SELECT COALESCE(SUM(amount),0)+COALESCE(SUM(gst_amount),0) FROM folio_entries fe WHERE fe.reference_number = o.id) AS fe_total
         FROM orders o
        WHERE UPPER(COALESCE(payment_method,'')) = 'CHARGE_TO_ROOM'
        ORDER BY posted_to_folio_at DESC NULLS LAST LIMIT 30`
    ).catch(e => { console.log(`  [${s}] orders query err:`, e.message); return []; });
    if (!ctr.length) continue;
    anyFound = true;
    console.log(`\n=== schema ${s}: ${ctr.length} CHARGE_TO_ROOM order(s) ===`);
    for (const o of ctr) {
      // The booking's open folio (what the front desk shows).
      let openFolio = null;
      if (o.booking_id) {
        openFolio = (await q(`SELECT id FROM folios WHERE booking_id=$1 AND status='open' LIMIT 1`, [o.booking_id]))[0]?.id || null;
      }
      const entriesFolio = (await q(`SELECT DISTINCT folio_id FROM folio_entries WHERE reference_number=$1`, [o.id])).map(r => r.folio_id);
      const mismatch = openFolio && entriesFolio.length && !entriesFolio.includes(openFolio);
      console.log(
        `  order=${o.id} total=${o.total_amount} status=${o.status} session=${o.session_id||'-'}\n` +
        `    order.folio_id=${o.folio_id||'-'} posted_at=${o.posted_to_folio_at? 'yes':'NO'} post_status=${o.folio_post_status||'-'}\n` +
        `    folio_entries for this order: count=${o.fe_count} total=${o.fe_total} folio(s)=[${entriesFolio.join(',')||'none'}]\n` +
        `    booking.open_folio=${openFolio||'-'}  ${mismatch ? '*** MISMATCH: F&B on a different folio than the open one ***' : (Number(o.fe_count)===0 ? '*** NO FOLIO ENTRIES (F&B dropped) ***' : 'ok')}`
      );
    }
  }
  if (!anyFound) console.log('\nNo CHARGE_TO_ROOM orders found in any tenant schema (dev DB may not have exercised this flow).');
} catch (e) {
  console.error('DIAG ERROR:', e.message);
} finally {
  await pool.end();
}
