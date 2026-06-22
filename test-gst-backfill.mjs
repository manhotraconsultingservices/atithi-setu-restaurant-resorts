// Sprint 2 GST register diagnostic
// Usage: node test-gst-backfill.mjs
import https from 'https';

const BASE = 'https://erp.atithi-setu.com';
const TENANT = 'RESTO-1003';
const FOLIO_ID = 'F-1781253471032-OKT2';  // last settled folio from previous session

function req(method, path, body, token) {
  const url = new URL(BASE + path);
  const postData = body ? JSON.stringify(body) : null;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
    },
  };
  return new Promise((resolve, reject) => {
    const r = https.request(url, opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (postData) r.write(postData);
    r.end();
  });
}

const login = await req('POST', '/api/auth/login', { loginId: 'ADMIN-ANKUSH', password: 'admin123' });
if (login.status !== 200 || !login.body.token) {
  console.error('LOGIN FAILED:', login.status, JSON.stringify(login.body));
  process.exit(1);
}
const token = login.body.token;
console.log('✓ Logged in as ADMIN-ANKUSH');

// ── T1: Check GST register BEFORE backfill ──────────────────────────
console.log('\n[T1] GST register before backfill (period=2026-06)');
const before = await req('GET', `/api/restaurant/${TENANT}/hotel/gst-register?period=2026-06`, null, token);
console.log('  HTTP', before.status, '/ total rows:', before.body?.rows?.length ?? 'err');
const folioBefore = (before.body?.rows || []).filter(r => r.folio_id === FOLIO_ID);
console.log(`  Rows for ${FOLIO_ID}: ${folioBefore.length}`);

// ── T2: Backfill ──────────────────────────────────────────────────────
console.log('\n[T2] Calling backfill endpoint');
const bf = await req('POST', `/api/restaurant/${TENANT}/hotel/gst-register/backfill`, { folio_id: FOLIO_ID }, token);
console.log('  HTTP', bf.status);
if (bf.status === 404) {
  console.log('  → 404: endpoint not deployed yet, wait ~2 min and retry');
  process.exit(1);
}
console.log(JSON.stringify(bf.body, null, 2));

// ── T3: Check GST register AFTER backfill ────────────────────────────
console.log('\n[T3] GST register after backfill (period=2026-06)');
const after = await req('GET', `/api/restaurant/${TENANT}/hotel/gst-register?period=2026-06`, null, token);
console.log('  HTTP', after.status, '/ total rows:', after.body?.rows?.length ?? 'err');
const folioAfter = (after.body?.rows || []).filter(r => r.folio_id === FOLIO_ID);
console.log(`  Rows for ${FOLIO_ID}: ${folioAfter.length}`);
if (folioAfter.length > 0) {
  console.log('  Sample:', JSON.stringify(folioAfter[0], null, 2));
  console.log('\n✓ PASS: GST register row created');
} else {
  console.log('\n✗ FAIL: GST register still empty after backfill');
}
console.log('\nSummary:', JSON.stringify(after.body?.summary, null, 2));
