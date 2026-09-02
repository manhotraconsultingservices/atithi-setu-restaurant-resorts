/**
 * RBAC review validation — the coarse-gate + inner-check fixes from the
 * senior-review pass (restaurantStaff/restaurantAdmin/spaStaff/hkStaff → module
 * gates; inline OWNER/MANAGER checks → _roleHasTab). Proves a granted custom role
 * can now run the core operational writes it was 403'd on. Self-cleaning.
 * Run: node test-scripts/rbac_review_validation.mjs
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
const allowed = (s) => s !== 401 && s !== 403;
const TODAY = new Date().toISOString().slice(0, 10);
const GRANT = ['MONITOR', 'ORDERS', 'MENU', 'INVOICES', 'INVENTORY', 'LOYALTY', 'QR', 'BOOKINGS', 'DELIVERY', 'SETTINGS', 'HOUSEKEEPING'];

async function main() {
  console.log('\n' + '='.repeat(64) + '\n  RBAC REVIEW VALIDATION — coarse gates + inner checks\n' + '='.repeat(64) + '\n');
  let r = await api('POST', '/api/auth/owner/login', { identifier: EMAIL, password: PWD });
  if (r.status !== 200) r = await api('POST', '/api/auth/login', { loginId: EMAIL, password: PWD, restaurantId: RID });
  ownerTok = r.data?.jwt_token || r.data?.token || '';
  if (!RID) RID = r.data?.restaurant?.id || r.data?.restaurantId || '';
  if (!ownerTok) { console.error('owner login failed'); process.exit(1); }
  console.log(`  Owner login OK · tenant ${RID}`);

  const cr = await api('POST', `/api/restaurant/${RID}/custom-roles`, { name: 'QA Ops Mgr', emoji: '🛠️', scope: 'RESTAURANT' }, ownerTok);
  const roleId = cr.data?.id; if (!roleId) { console.error('role create failed'); process.exit(1); }
  const cur = await api('GET', `/api/restaurant/${RID}/role-permissions`, null, ownerTok);
  const map = { ...(cur.data || {}) }; const perms = {}; for (const t of GRANT) perms[t] = 3; map[roleId] = perms;
  await api('POST', `/api/restaurant/${RID}/role-permissions`, map, ownerTok);
  const tag = Date.now(); const loginId = `qao_${tag}`, pwd = `Qa!${tag}xZ`;
  const mk = await api('POST', '/api/owner/staff', { name: `QA Ops ${tag}`, role: roleId, loginId, password: pwd, employee_type: 'LOGIN' }, ownerTok);
  const staffId = mk.data?.id;
  const lg = await api('POST', '/api/auth/login', { loginId, password: pwd, restaurantId: RID });
  const M = lg.data?.jwt_token || lg.data?.token || '';
  // ungranted control role (MONITOR only)
  const crD = await api('POST', `/api/restaurant/${RID}/custom-roles`, { name: 'QA Ops Deny', emoji: '🚫', scope: 'RESTAURANT' }, ownerTok);
  const denyId = crD.data?.id;
  if (denyId) { const fresh = await api('GET', `/api/restaurant/${RID}/role-permissions`, null, ownerTok); const m2 = { ...(fresh.data || {}) }; m2[denyId] = { MONITOR: 3 }; await api('POST', `/api/restaurant/${RID}/role-permissions`, m2, ownerTok); }
  const dmk = denyId ? await api('POST', '/api/owner/staff', { name: `QA Deny ${tag}`, role: denyId, loginId: `qad_${tag}`, password: pwd, employee_type: 'LOGIN' }, ownerTok) : { data: {} };
  const denyStaffId = dmk.data?.id;
  const dlg = denyStaffId ? await api('POST', '/api/auth/login', { loginId: `qad_${tag}`, password: pwd, restaurantId: RID }) : { data: {} };
  const D = dlg.data?.jwt_token || dlg.data?.token || '';

  const cleanup = [];
  try {
    if (!M) { skip('REV-ALL', 'ops-manager login failed'); return; }

    // MENU — add a menu item
    const menu = await api('POST', `/api/restaurant/${RID}/menu`, { name: `QA Item ${tag}`, price: 100, price_full: 100, category: 'QA' }, M);
    allowed(menu.status) ? pass('REV-MENU-ADD', 'granted role can add a menu item', `status=${menu.status}`) : fail('REV-MENU-ADD', 'menu add still blocked', `status=${menu.status}`);
    if (menu.data?.id) cleanup.push(() => api('DELETE', `/api/menu/${menu.data.id}`, null, ownerTok));

    // INVENTORY — add an ingredient
    const ing = await api('POST', `/api/restaurant/${RID}/inventory/ingredients`, { name: `QA Ing ${tag}`, unit: 'kg', current_stock: 0 }, M);
    allowed(ing.status) ? pass('REV-INV-ADD', 'granted role can add an ingredient', `status=${ing.status}`) : fail('REV-INV-ADD', 'ingredient add still blocked', `status=${ing.status}`);
    if (ing.data?.id) cleanup.push(() => api('DELETE', `/api/inventory/ingredients/${ing.data.id}`, null, ownerTok));

    // ORDER LIFECYCLE — create a public order, then accept + advance status as the manager
    const ord = await api('POST', `/api/restaurant/${RID}/orders`, { tableNumber: `QA-${tag}`, items: [{ name: 'QA Dish', price: 50, quantity: 1 }], total_amount: 50, checkout_mode: 'postpaid' });
    const oid = ord.data?.id;
    if (!oid) { skip('REV-ORDER-ACCEPT', 'order lifecycle', `could not create order (status=${ord.status})`); }
    else {
      const acc = await api('POST', `/api/orders/${oid}/accept`, {}, M);
      allowed(acc.status) ? pass('REV-ORDER-ACCEPT', 'granted role can ACCEPT a KDS ticket', `status=${acc.status}`) : fail('REV-ORDER-ACCEPT', 'KDS accept still blocked', `status=${acc.status}`);
      const pat = await api('PATCH', `/api/orders/${oid}`, { status: 'PREPARING' }, M);
      allowed(pat.status) ? pass('REV-ORDER-PATCH', 'granted role can advance order status', `status=${pat.status}`) : fail('REV-ORDER-PATCH', 'order status update still blocked', `status=${pat.status}`);
      await api('PATCH', `/api/orders/${oid}`, { status: 'CANCELLED' }, ownerTok).catch(() => {});
    }

    // QR — assign waiter (harmless unassign)
    const tbls = await api('GET', `/api/restaurant/${RID}/tables`, null, ownerTok);
    const t0 = (Array.isArray(tbls.data) ? tbls.data : [])[0];
    if (t0) {
      const aw = await api('PATCH', `/api/restaurant/${RID}/tables/${t0.id}/assign-waiter`, { role: t0.assigned_role || '', waiter_id: t0.assigned_waiter_id || '' }, M);
      allowed(aw.status) ? pass('REV-QR-ASSIGN', 'granted role can assign a waiter', `status=${aw.status}`) : fail('REV-QR-ASSIGN', 'assign-waiter still blocked', `status=${aw.status}`);
    } else skip('REV-QR-ASSIGN', 'assign-waiter', 'no tables');

    // HOUSEKEEPING — read the checklist (hkStaff module gate)
    const hk = await api('GET', `/api/restaurant/${RID}/housekeeping/checklist`, null, M);
    allowed(hk.status) ? pass('REV-HOUSEKEEPING', 'granted HOUSEKEEPING role reaches housekeeping', `status=${hk.status}`) : fail('REV-HOUSEKEEPING', 'housekeeping still blocked', `status=${hk.status}`);

    // SETTINGS — invoice-template preview (restaurantAdmin module gate) + language round-trip
    const prev = await api('POST', `/api/restaurant/${RID}/invoice-preview.pdf?module=restaurant`, {}, M);
    allowed(prev.status) ? pass('REV-SETTINGS-PREVIEW', 'granted SETTINGS role can render invoice preview (restaurantAdmin)', `status=${prev.status}`) : fail('REV-SETTINGS-PREVIEW', 'invoice preview still blocked', `status=${prev.status}`);
    const restRow = await api('GET', `/api/restaurant/${RID}`, null, ownerTok);
    const lang = await api('PUT', `/api/restaurant/${RID}/settings/language`, { secondary_language: restRow.data?.secondary_language || '' }, M);
    allowed(lang.status) ? pass('REV-SETTINGS-LANG', 'granted SETTINGS role can change language', `status=${lang.status}`) : fail('REV-SETTINGS-LANG', 'language change still blocked', `status=${lang.status}`);

    // INVOICE CANCEL — _cancelRestGate now INVOICES-aware (fake id → 404, not 403)
    const canc = await api('POST', `/api/restaurant/${RID}/invoices/order/QA-NOPE-${tag}/cancel`, { reason: 'qa validation cancel' }, M);
    (canc.status !== 403) ? pass('REV-INVOICE-CANCEL', 'granted INVOICES role passes the cancel gate (404/400, not 403)', `status=${canc.status}`) : fail('REV-INVOICE-CANCEL', 'invoice cancel still owner/manager-only', `status=${canc.status}`);

    // NO-LEAK — the ungranted (MONITOR-only) role stays 403 on these writes
    if (D) {
      const checks = [
        ['menu', 'POST', `/api/restaurant/${RID}/menu`, { name: 'x', price: 1, price_full: 1 }],
        ['inventory', 'POST', `/api/restaurant/${RID}/inventory/ingredients`, { name: 'x', unit: 'kg' }],
        ['housekeeping', 'GET', `/api/restaurant/${RID}/housekeeping/checklist`, null],
        ['tax-config', 'PUT', `/api/restaurant/${RID}/tax-config`, { tax_type: 'GST' }],
      ];
      let ok = true, d = [];
      for (const [id, mth, p, b] of checks) { const rr = await api(mth, p, b, D); d.push(`${id}=${rr.status}`); if (rr.status !== 403) ok = false; }
      ok ? pass('REV-NO-LEAK', 'MONITOR-only role STILL 403 on menu/inventory/housekeeping/tax-config', d.join(' ')) : fail('REV-NO-LEAK', 'a converted gate fails open for an ungranted role', d.join(' '));
    }
  } finally {
    for (const fn of cleanup.reverse()) { try { await fn(); } catch {} }
    try { if (staffId) await api('DELETE', `/api/owner/staff/${staffId}`, null, ownerTok); } catch {}
    try { if (denyStaffId) await api('DELETE', `/api/owner/staff/${denyStaffId}`, null, ownerTok); } catch {}
    try { const c = await api('GET', `/api/restaurant/${RID}/role-permissions`, null, ownerTok); const m = { ...(c.data || {}) }; m[roleId] = {}; if (denyId) m[denyId] = {}; await api('POST', `/api/restaurant/${RID}/role-permissions`, m, ownerTok); } catch {}
    try { await api('DELETE', `/api/restaurant/${RID}/custom-roles/${roleId}`, null, ownerTok); } catch {}
    try { if (denyId) await api('DELETE', `/api/restaurant/${RID}/custom-roles/${denyId}`, null, ownerTok); } catch {}
  }
  const p = results.filter(x => x === 'PASS').length, f = results.filter(x => x === 'FAIL').length, s = results.filter(x => x === 'SKIP').length;
  console.log('\n' + '='.repeat(64) + `\n  RESULT — ${p} PASS · ${f} FAIL · ${s} SKIP\n` + '='.repeat(64) + '\n');
  process.exit(f > 0 ? 1 : 0);
}
main().catch(e => { console.error('crashed:', e); process.exit(2); });
