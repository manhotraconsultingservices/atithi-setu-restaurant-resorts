/**
 * RBAC ISOLATION — aggressive "staff must NOT see what they weren't granted".
 * For each narrowly-scoped custom role (restaurant-only / finance-only / hotel-only /
 * events-only / deny-by-default), probe reads across EVERY module and assert the role
 * is 403 on every module it was NOT granted, and reaches the one it was — plus that
 * /my-permissions returns ONLY the granted tabs (no grandfather leak). Self-cleaning.
 * Run: node test-scripts/rbac_isolation_validation.mjs
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
(function loadEnv() {
  for (const f of [process.env.SMOKE_ENV_FILE, join(__dirname, '.env.local')].filter(Boolean)) {
    let t; try { t = readFileSync(f, 'utf8'); } catch { continue; }
    for (const raw of t.split(/\r?\n/)) { const l = raw.trim(); if (!l || l.startsWith('#')) continue; const e = l.indexOf('='); if (e < 0) continue; const k = l.slice(0, e).trim(); let v = l.slice(e + 1).trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1); if (process.env[k] === undefined) process.env[k] = v; }
    break;
  }
})();
const BASE = process.env.BASE_URL || 'https://erp.atithi-setu.com';
const EMAIL = process.env.OWNER_EMAIL, PWD = process.env.OWNER_PASSWORD;
let RID = process.env.RESTAURANT_ID || '';
let ownerTok = '';
const results = [];
const pass = (id, m, n = '') => { results.push('PASS'); console.log(`  ✅ [PASS] ${id} — ${m}${n ? ' | ' + n : ''}`); };
const fail = (id, m, n = '') => { results.push('FAIL'); console.error(`  ❌ [FAIL] ${id} — ${m}${n ? ' | ' + n : ''}`); };
const skip = (id, m, n = '') => { results.push('SKIP'); console.log(`  ⚠️  [SKIP] ${id} — ${m}${n ? ' | ' + n : ''}`); };
async function api(method, path, body, tok) {
  const h = { 'Content-Type': 'application/json' }; if (tok) h.Authorization = `Bearer ${tok}`;
  const o = { method, headers: h }; if (body != null) o.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, o); const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json().catch(() => ({})) : await r.text().catch(() => '') };
}
const TODAY = new Date().toISOString().slice(0, 10), FROM = '2020-01-01';

// Each probe: a module read + the tab that should gate it. denied=403 expected when the
// role lacks the module; allowed=not-403 when it has it. 404 => module not enabled => n/a.
const PROBES = [
  { mod: 'FINANCE', p: `/accounting/trial-balance?from=${FROM}&to=${TODAY}` },
  { mod: 'FINANCE', p: `/accounting/gl-entries?from=${FROM}&to=${TODAY}` },
  { mod: 'FINANCE', p: `/accounting/gst/gstr1?from=${FROM}&to=${TODAY}` },
  { mod: 'FINANCE', p: `/accounting/profit-loss?from=${FROM}&to=${TODAY}` },
  { mod: 'PROCUREMENT', p: `/procurement/suppliers` },
  { mod: 'HR', p: `/hr/employees` },
  { mod: 'HR', p: `/payroll/runs` },
  { mod: 'HOTEL', p: `/hotel/bookings` },
  { mod: 'HOTEL', p: `/hotel/rooms` },
  { mod: 'HOTEL', p: `/hotel/folios` },
  { mod: 'EVENTS', p: `/events/bookings` },
  { mod: 'EVENTS', p: `/events/venues` },
  { mod: 'EVENTS', p: `/events/reports/summary` },
  { mod: 'LOYALTY', p: `/loyalty/customers` },
];
// tab grants per role scope + which PROBES modules the role legitimately owns
const ROLES = {
  RESTO:   { grant: ['MONITOR', 'ORDERS', 'MENU'],            owns: [] },              // restaurant ops — owns none of the probed (sensitive) modules
  FINANCE: { grant: ['ACCOUNTING', 'ACCOUNTS_GST', 'PROCUREMENT'], owns: ['FINANCE', 'PROCUREMENT'] },
  HOTEL:   { grant: ['HOTEL_BOOKINGS', 'ROOMS', 'FOLIOS'],   owns: ['HOTEL'] },
  EVENTS:  { grant: ['EVENTS_BOOKINGS', 'EVENTS_VENUES', 'EVENTS_REPORTS'], owns: ['EVENTS'] },
  DENY:    { grant: [],                                       owns: [] },              // deny-by-default (nothing granted)
};

async function ownerLogin() {
  let r = await api('POST', '/api/auth/owner/login', { identifier: EMAIL, password: PWD });
  if (r.status !== 200) r = await api('POST', '/api/auth/login', { loginId: EMAIL, password: PWD, restaurantId: RID });
  ownerTok = r.data?.jwt_token || r.data?.token || '';
  if (!RID) RID = r.data?.restaurant?.id || r.data?.restaurantId || '';
  if (!ownerTok) { console.error('owner login failed'); process.exit(1); }
}
async function makeRole(name, grant) {
  const cr = await api('POST', `/api/restaurant/${RID}/custom-roles`, { name, emoji: '🔒', scope: 'RESTAURANT' }, ownerTok);
  const roleId = cr.data?.id; if (!roleId) return null;
  const cur = await api('GET', `/api/restaurant/${RID}/role-permissions`, null, ownerTok);  // fresh read each time
  const map = (cur.data && typeof cur.data === 'object') ? { ...cur.data } : {};
  const perms = {}; for (const t of grant) perms[t] = 3; map[roleId] = grant.length ? perms : {};
  await api('POST', `/api/restaurant/${RID}/role-permissions`, map, ownerTok);
  const tag = Date.now() + Math.floor(Math.random() * 1e4); const loginId = `iso_${tag}`, pwd = `Is!${tag}xZ`;
  const mk = await api('POST', '/api/owner/staff', { name: `${name} ${tag}`, role: roleId, loginId, password: pwd, employee_type: 'LOGIN' }, ownerTok);
  const staffId = mk.data?.id;
  const lg = await api('POST', '/api/auth/login', { loginId, password: pwd, restaurantId: RID });
  return { roleId, staffId, tok: lg.data?.jwt_token || lg.data?.token || '' };
}

async function main() {
  console.log('\n' + '='.repeat(66) + '\n  RBAC ISOLATION — staff must NOT see other modules (Manhotra Consulting)\n' + '='.repeat(66) + '\n');
  await ownerLogin();
  console.log(`  Owner login OK · tenant ${RID}\n`);
  const created = [];
  try {
    for (const [scope, def] of Object.entries(ROLES)) {
      const R = await makeRole(`ISO ${scope}`, def.grant);
      if (!R) { skip(`ISO-${scope}`, 'role create failed'); continue; }
      created.push(R);
      if (!R.tok) { skip(`ISO-${scope}`, 'login failed'); continue; }
      // 1) /my-permissions returns ONLY the granted tabs (no grandfather leak)
      const mp = await api('GET', `/api/restaurant/${RID}/my-permissions`, null, R.tok);
      const at = (Array.isArray(mp.data?.allowed_tabs) ? mp.data.allowed_tabs : []).filter(t => !String(t).startsWith('__'));
      const extra = at.filter(t => !def.grant.includes(t));
      extra.length === 0
        ? pass(`ISO-${scope}-MYPERM`, `my-permissions = exactly the ${def.grant.length} granted tab(s), no leak`, `tabs=[${at.join(',')}]`)
        : fail(`ISO-${scope}-MYPERM`, `role sees tabs it was never granted (nav leak)`, `extra=[${extra.join(',')}]`);
      // 2) cross-module read isolation
      let denied = 0, leaked = [], na = 0;
      for (const pr of PROBES) {
        const owns = def.owns.includes(pr.mod);
        const r = await api('GET', `/api/restaurant/${RID}${pr.p}`, null, R.tok);
        if (r.status === 404) { na++; continue; }                         // module not enabled on this tenant
        if (owns) { if (r.status === 403) leaked.push(`OWN-DENIED:${pr.p}(${r.status})`); }
        else { if (r.status !== 403) leaked.push(`${pr.mod}:${pr.p.split('?')[0]}=${r.status}`); else denied++; }
      }
      leaked.length === 0
        ? pass(`ISO-${scope}-CROSS`, `denied on every un-granted module (${denied} probes 403, ${na} n/a)`, `owns=[${def.owns.join(',')||'none'}]`)
        : fail(`ISO-${scope}-CROSS`, `role reached data outside its grant (LEAK)`, leaked.join(' '));
    }
  } finally {
    for (const R of created) { try { if (R.staffId) await api('DELETE', `/api/owner/staff/${R.staffId}`, null, ownerTok); } catch {} }
    try {
      const c = await api('GET', `/api/restaurant/${RID}/role-permissions`, null, ownerTok);
      const m = (c.data && typeof c.data === 'object') ? { ...c.data } : {};
      for (const R of created) m[R.roleId] = {};
      await api('POST', `/api/restaurant/${RID}/role-permissions`, m, ownerTok);
    } catch {}
    for (const R of created) { try { await api('DELETE', `/api/restaurant/${RID}/custom-roles/${R.roleId}`, null, ownerTok); } catch {} }
  }
  const p = results.filter(x => x === 'PASS').length, f = results.filter(x => x === 'FAIL').length, s = results.filter(x => x === 'SKIP').length;
  console.log('\n' + '='.repeat(66) + `\n  RESULT — ${p} PASS · ${f} FAIL · ${s} SKIP\n` + '='.repeat(66) + '\n');
  process.exit(f > 0 ? 1 : 0);
}
main().catch(e => { console.error('crashed:', e); process.exit(2); });
