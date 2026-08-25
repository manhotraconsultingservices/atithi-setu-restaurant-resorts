/**
 * GL backfill runner — reflect settled transactions that never posted a Day Book
 * journal (hotel folios / paid standalone orders). Idempotent + balanced-or-exception
 * on the server, so re-running is safe and it can never double-post or unbalance.
 *
 * DRY RUN by default (writes nothing) — shows candidates. Set CONFIRM=1 to post.
 *
 * Run (creds passed at the shell, never committed):
 *   OWNER_EMAIL=you@x.com OWNER_PASSWORD=secret RESTAURANT_ID=RESTO-1003 \
 *     node test-scripts/gl_backfill.mjs                # dry run
 *   ... CONFIRM=1 node test-scripts/gl_backfill.mjs    # actually post
 *
 * Optional: BASE (default https://erp.atithi-setu.com), FROM, TO.
 */
const BASE = (process.env.BASE || 'https://erp.atithi-setu.com').replace(/\/$/, '');
const EMAIL = process.env.OWNER_EMAIL || process.env.LIVE_LOGIN_ID || '';
const PASSWORD = process.env.OWNER_PASSWORD || process.env.LIVE_PASSWORD || '';
const RID = process.env.RESTAURANT_ID || 'RESTO-1003';
const CONFIRM = process.env.CONFIRM === '1';
const FROM = process.env.FROM || '2000-01-01';
const TO = process.env.TO || new Date().toISOString().slice(0, 10);

async function api(method, path, body, tok) {
  const headers = { 'Content-Type': 'application/json' };
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const txt = await res.text();
  let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  return { status: res.status, data };
}

(async () => {
  if (!EMAIL || !PASSWORD) { console.error('Set OWNER_EMAIL and OWNER_PASSWORD env vars.'); process.exit(1); }
  const login = await api('POST', '/api/auth/owner/login', { identifier: EMAIL, password: PASSWORD });
  const token = login.data && login.data.jwt_token;
  if (login.status !== 200 || !token) { console.error(`Login failed (HTTP ${login.status}):`, JSON.stringify(login.data).slice(0, 200)); process.exit(1); }
  console.log(`Logged in · ${RID} · ${BASE} · range ${FROM}..${TO}`);

  const q = `from=${FROM}&to=${TO}${CONFIRM ? '' : '&dry_run=1'}`;
  const r = await api('POST', `/api/restaurant/${RID}/accounting/backfill-gl?${q}`, {}, token);
  if (r.status !== 200) { console.error(`Backfill failed (HTTP ${r.status}):`, JSON.stringify(r.data).slice(0, 300)); process.exit(1); }
  const d = r.data;
  if (d.dry_run) {
    console.log(`\nDRY RUN — nothing written.`);
    console.log(`  already posted: ${d.already_posted}`);
    console.log(`  candidates to backfill: ${d.candidates}`);
    if (d.posted && d.posted.length) console.log(`  refs: ${d.posted.slice(0, 20).join(', ')}${d.posted.length > 20 ? ' …' : ''}`);
    console.log(`\nTo actually post them, re-run with CONFIRM=1.`);
  } else {
    console.log(`\nBACKFILL COMPLETE.`);
    console.log(`  already posted (skipped): ${d.already_posted}`);
    console.log(`  newly posted: ${d.posted_count}`);
    console.log(`  still missing (could not post): ${d.still_missing_count}`);
    if (d.posted && d.posted.length) console.log(`  posted: ${d.posted.slice(0, 20).join(', ')}${d.posted.length > 20 ? ' …' : ''}`);
    if (d.still_missing && d.still_missing.length) console.log(`  still missing: ${d.still_missing.join(', ')}`);
    if (d.note) console.log(`  note: ${d.note}`);
    console.log(`\nNow re-run the reconciliation (SKIP_ACTIVE=1 e2e_daybook_full_loop.mjs) to confirm 0 unreflected.`);
  }
})();
