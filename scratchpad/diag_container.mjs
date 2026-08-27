// READ-ONLY diagnostic, runs INSIDE the atithi-setu container. Reads /app/.env
// for DB creds and checks whether CHARGE_TO_ROOM F&B actually landed on the
// booking's open folio. No writes.
import fs from 'node:fs';
import pg from 'pg';

const env = {};
try {
  for (const line of fs.readFileSync('/app/.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { console.log('no /app/.env:', e.message); }

const conn = env.DATABASE_URL ||
  `postgresql://${env.PGUSER||'postgres'}:${env.PGPASSWORD||'postgres'}@${env.PGHOST||'localhost'}:${env.PGPORT||'5432'}/${env.PGDATABASE||'restoflow'}`;
const pool = new pg.Pool({ connectionString: conn, ssl: env.PGSSL === 'true' ? { rejectUnauthorized: false } : false });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

try {
  const schemas = (await q(
    `SELECT schema_name FROM information_schema.schemata
      WHERE schema_name NOT IN ('public','pg_catalog','information_schema','pg_toast')
        AND schema_name NOT LIKE 'pg_%' ORDER BY schema_name`
  )).map(r => r.schema_name);
  console.log(`Tenant schemas (${schemas.length}): ${schemas.join(', ') || '(none)'}`);

  let anyCtr = false;
  for (const s of schemas) {
    const has = (t) => q(`SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2`, [s, t]).then(r => r.length > 0);
    if (!(await has('orders')) || !(await has('folios'))) continue;
    await pool.query(`SET search_path TO "${s}"`);
    let ctr;
    try {
      ctr = await q(
        `SELECT id, booking_id, room_id, folio_id, posted_to_folio_at, folio_post_status,
                total_amount, session_id, status, items
           FROM orders
          WHERE UPPER(COALESCE(payment_method,'')) = 'CHARGE_TO_ROOM'
          ORDER BY posted_to_folio_at DESC NULLS LAST LIMIT 25`);
    } catch (e) { console.log(`  [${s}] err:`, e.message); continue; }
    if (!ctr.length) continue;
    anyCtr = true;
    console.log(`\n=== schema ${s}: ${ctr.length} CHARGE_TO_ROOM order(s) ===`);
    for (const o of ctr) {
      const openFolio = o.booking_id
        ? (await q(`SELECT id FROM folios WHERE booking_id=$1 AND status='open' LIMIT 1`, [o.booking_id]))[0]?.id || null
        : null;
      const allBookingFolios = o.booking_id
        ? (await q(`SELECT id, status FROM folios WHERE booking_id=$1`, [o.booking_id]))
        : [];
      const fe = await q(`SELECT folio_id, COUNT(*) c, COALESCE(SUM(amount),0)+COALESCE(SUM(gst_amount),0) t FROM folio_entries WHERE reference_number=$1 GROUP BY folio_id`, [o.id]);
      const feFolios = fe.map(r => r.folio_id);
      let itemsLen = 0;
      try { const it = typeof o.items === 'string' ? JSON.parse(o.items) : o.items; itemsLen = Array.isArray(it) ? it.length : -1; } catch { itemsLen = -2; }
      const mismatch = openFolio && feFolios.length && !feFolios.includes(openFolio);
      const flag = fe.length === 0 ? '*** NO FOLIO ENTRIES (F&B DROPPED) ***'
                 : mismatch ? '*** MISMATCH: F&B on non-open / wrong folio ***'
                 : 'ok';
      console.log(
        `  order=${o.id} total=${o.total_amount} status=${o.status} items_len=${itemsLen} session=${o.session_id||'-'}\n` +
        `    order.folio_id=${o.folio_id||'-'} posted_at=${o.posted_to_folio_at?'yes':'NO'} post_status=${o.folio_post_status||'-'}\n` +
        `    fe: ${fe.map(r=>`folio=${r.folio_id} n=${r.c} tot=${r.t}`).join(' | ')||'none'}\n` +
        `    booking.open_folio=${openFolio||'-'} allBookingFolios=[${allBookingFolios.map(f=>f.id+':'+f.status).join(', ')}]  ${flag}`
      );
    }
  }
  if (!anyCtr) console.log('\nNo CHARGE_TO_ROOM orders found in any tenant schema.');
} catch (e) {
  console.error('DIAG ERROR:', e.message);
} finally {
  await pool.end();
}
