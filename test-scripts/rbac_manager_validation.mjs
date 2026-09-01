/**
 * RBAC — Custom "Manager" role validation (all 11 reported bugs)
 * Run: node test-scripts/rbac_manager_validation.mjs
 *
 * Reproduces the reported production scenario: a CUSTOM role (like
 * CUSTOM_MANAGER_MTGS99CJ) the owner granted Full access to Finance, Procurement,
 * Workforce, Expense Journal, Cash Drawer and Checklist Templates — and asserts
 * every gated action is now ALLOWED (not 403), while an UNGRANTED role stays denied.
 * Self-cleaning. Uses test-scripts/.env.local (OWNER_EMAIL / OWNER_PASSWORD / RESTAURANT_ID).
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
(function loadLocalEnv() {
  for (const file of [process.env.SMOKE_ENV_FILE, join(__dirname, '.env.local')].filter(Boolean)) {
    let text; try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim(); if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('='); if (eq === -1) continue;
      const k = line.slice(0, eq).trim(); let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
    break;
  }
})();
const BASE_URL = process.env.BASE_URL || 'https://erp.atithi-setu.com';
const EMAIL = process.env.OWNER_EMAIL || '';
const PASSWORD = process.env.OWNER_PASSWORD || '';
let RID = process.env.RESTAURANT_ID || '';
if (!EMAIL || !PASSWORD) { console.error('Missing OWNER_EMAIL / OWNER_PASSWORD'); process.exit(1); }

let ownerTok = '';
const results = [];
const pass = (id, m, n = '') => { results.push({ id, s: 'PASS' }); console.log(`  ✅ [PASS] ${id} — ${m}${n ? ' | ' + n : ''}`); };
const fail = (id, m, n = '') => { results.push({ id, s: 'FAIL' }); console.error(`  ❌ [FAIL] ${id} — ${m}${n ? ' | ' + n : ''}`); };
const skip = (id, m, n = '') => { results.push({ id, s: 'SKIP' }); console.log(`  ⚠️  [SKIP] ${id} — ${m}${n ? ' | ' + n : ''}`); };

async function api(method, path, body, tok) {
  const headers = { 'Content-Type': 'application/json' };
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  const opts = { method, headers };
  if (body !== undefined && body !== null) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE_URL}${path}`, opts);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await r.json().catch(() => ({})) : await r.text().catch(() => '');
  return { status: r.status, data };
}
// "allowed" = the RBAC gate let the request through (not 401/403).
const allowed = (st) => st !== 401 && st !== 403;

const TODAY = new Date().toISOString().slice(0, 10);
const FROM = '2020-01-01';
// Full grant across every module the reports touch (Events deliberately withheld for bug 9).
const GRANT_TABS = ['MONITOR', 'INVOICES', 'ROSTER', 'TIMESHEET', 'ATTENDANCE', 'STAFF', 'HR_PAYROLL', 'STAFF_PAYROLL',
  'ACCOUNTING', 'ACCOUNTS_PNL', 'ACCOUNTS_CASHFLOW', 'ACCOUNTS_GST', 'ACCOUNTS_VENDOR_AGING', 'EXPENSE_JOURNAL',
  'PROCUREMENT', 'RECEIVABLES', 'CASH_DRAWER', 'CHECKLISTS', 'HOUSEKEEPING'];

async function ownerLogin() {
  let r = await api('POST', '/api/auth/owner/login', { identifier: EMAIL, password: PASSWORD });
  if (r.status !== 200) r = await api('POST', '/api/auth/login', { loginId: EMAIL, password: PASSWORD, restaurantId: RID });
  ownerTok = r.data?.jwt_token || r.data?.token || '';
  if (!RID) RID = r.data?.restaurant?.id || r.data?.restaurantId || r.data?.restaurant_id || '';
  if (!ownerTok) { console.error('Owner login failed', r.status, JSON.stringify(r.data).slice(0, 200)); process.exit(1); }
  console.log(`  Owner login OK · tenant ${RID}`);
}

async function grant(roleId, tabs) {
  const cur = await api('GET', `/api/restaurant/${RID}/role-permissions`, null, ownerTok);
  const map = (cur.data && typeof cur.data === 'object' && !Array.isArray(cur.data)) ? { ...cur.data } : {};
  const perms = {}; for (const t of tabs) perms[t] = 3;
  map[roleId] = perms;
  await api('POST', `/api/restaurant/${RID}/role-permissions`, map, ownerTok);
}
async function makeStaff(name, roleId) {
  const tag = Date.now() + Math.floor(Math.random() * 1000);
  const loginId = `qa_${tag}`; const pwd = `Qa!${tag}xZ`;
  const mk = await api('POST', '/api/owner/staff', { name: `${name} ${tag}`, role: roleId, loginId, password: pwd, employee_type: 'LOGIN' }, ownerTok);
  const id = mk.data?.id || mk.data?.staff?.id || null;
  let tok = '';
  if (mk.status === 200 || mk.status === 201) {
    const lg = await api('POST', '/api/auth/login', { loginId, password: pwd, restaurantId: RID });
    tok = lg.data?.jwt_token || lg.data?.token || '';
  }
  return { id, tok, loginId };
}

async function main() {
  console.log('\n' + '='.repeat(64));
  console.log('  RBAC CUSTOM-MANAGER VALIDATION — all 11 reported bugs');
  console.log(`  Target: ${BASE_URL}`);
  console.log('='.repeat(64) + '\n');
  await ownerLogin();

  // ── Create the custom "Manager" role + a staff login with FULL grants ──
  const cr = await api('POST', `/api/restaurant/${RID}/custom-roles`, { name: `QA Manager`, emoji: '🧑‍💼', scope: 'RESTAURANT' }, ownerTok);
  const roleId = cr.data?.id;
  if (!roleId) { console.error('Could not create custom role', cr.status, JSON.stringify(cr.data).slice(0, 200)); process.exit(1); }
  console.log(`  Custom role: ${roleId}`);
  await grant(roleId, GRANT_TABS);
  const mgr = await makeStaff('QA Manager', roleId);
  if (!mgr.tok) { console.error('Could not create/login the custom-Manager staff'); }
  const M = mgr.tok;

  // Ungranted control role (granted only MONITOR) — must stay DENIED (no fail-open).
  const crD = await api('POST', `/api/restaurant/${RID}/custom-roles`, { name: `QA Denied`, emoji: '🚫', scope: 'RESTAURANT' }, ownerTok);
  const denyRoleId = crD.data?.id;
  if (denyRoleId) await grant(denyRoleId, ['MONITOR']);
  const den = denyRoleId ? await makeStaff('QA Denied', denyRoleId) : { id: null, tok: '' };
  const D = den.tok;

  const cleanup = [];
  try {
    if (!M) { skip('BUG-ALL', 'custom-Manager login failed — cannot validate', ''); }
    else {
      // ── BUG 1 — Workforce: create a shift template + a roster slot ──
      const st = await api('POST', `/api/restaurant/${RID}/shift-templates`, { label: `QA ${Date.now()}`, start_time: '09:00', end_time: '17:00' }, M);
      allowed(st.status) ? pass('BUG-01-SHIFT-TEMPLATE', 'Manager can create a shift template (Roster)', `status=${st.status}`)
                         : fail('BUG-01-SHIFT-TEMPLATE', 'shift template create still blocked', `status=${st.status}`);
      if (st.data?.id) cleanup.push(() => api('DELETE', `/api/restaurant/${RID}/shift-templates/${st.data.id}`, null, ownerTok));
      const rs = await api('POST', `/api/restaurant/${RID}/roster`, { slots: [{ staff_id: mgr.id, shift_date: TODAY, start_time: '09:00', end_time: '17:00' }] }, M);
      allowed(rs.status) ? pass('BUG-01-ROSTER-SAVE', 'Manager can save a roster slot', `status=${rs.status}`)
                         : fail('BUG-01-ROSTER-SAVE', 'roster save still blocked', `status=${rs.status}`);

      // ── BUG 2/4/5 — Ledger & Books / GST / Cash Flow reports ──
      const acct = [
        ['BUG-04-TRIAL-BALANCE', `/accounting/trial-balance?from=${FROM}&to=${TODAY}`],
        ['BUG-04-GL-LEDGER', `/accounting/gl-entries?from=${FROM}&to=${TODAY}`],
        ['BUG-04-DAY-BOOK', `/accounting/cash-book?date=${TODAY}`],
        ['BUG-04-PNL', `/accounting/profit-loss?from=${FROM}&to=${TODAY}`],
        ['BUG-04-BALANCE-SHEET', `/accounting/balance-sheet?as_of=${TODAY}`],
        ['BUG-05-CASH-FLOW', `/accounting/cash-flow-gl?from=${FROM}&to=${TODAY}`],
        ['BUG-02-GSTR1', `/accounting/gst/gstr1?from=${FROM}&to=${TODAY}`],
        ['BUG-02-GSTR3B', `/accounting/gst/gstr3b?from=${FROM}&to=${TODAY}`],
        ['BUG-02-GST-OUTSTANDING', `/accounting/gst-outstanding`],
        ['BUG-04-AGING', `/accounting/aging`],
      ];
      for (const [id, path] of acct) {
        const r = await api('GET', `/api/restaurant/${RID}${path}`, null, M);
        allowed(r.status) ? pass(id, `Manager can load ${path.split('?')[0].split('/').pop()}`, `status=${r.status}`)
                          : fail(id, `${path} still 403 for granted Manager`, `status=${r.status}`);
      }
      // Manual journal (Ledger & Books write)
      const mj = await api('POST', `/api/restaurant/${RID}/accounting/journal-entries`, { entry_date: TODAY, narration: 'QA', lines: [] }, M);
      allowed(mj.status) ? pass('BUG-04-MANUAL-ENTRY', 'Manager reaches Manual Entry (not 403; 400 = validation)', `status=${mj.status}`)
                         : fail('BUG-04-MANUAL-ENTRY', 'Manual journal still blocked', `status=${mj.status}`);

      // ── BUG 6/7 — Procurement & AP ──
      const supList = await api('GET', `/api/restaurant/${RID}/procurement/suppliers`, null, M);
      allowed(supList.status) ? pass('BUG-06-SUPPLIER-LIST', 'Manager can load suppliers', `status=${supList.status}`)
                              : fail('BUG-06-SUPPLIER-LIST', 'supplier list 403', `status=${supList.status}`);
      const supAdd = await api('POST', `/api/restaurant/${RID}/procurement/suppliers`, { name: `QA Supplier ${Date.now()}` }, M);
      allowed(supAdd.status) ? pass('BUG-07-ADD-SUPPLIER', 'Manager can add a supplier', `status=${supAdd.status}`)
                             : fail('BUG-07-ADD-SUPPLIER', 'add supplier still Forbidden', `status=${supAdd.status}`);
      const supId = supAdd.data?.id;
      if (supId) cleanup.push(() => api('DELETE', `/api/restaurant/${RID}/procurement/suppliers/${supId}`, null, ownerTok));
      const invAdd = await api('POST', `/api/restaurant/${RID}/procurement/supplier-invoices`, { supplier_id: supId || 'X', invoice_number: `QA-${Date.now()}`, invoice_date: TODAY, amount: 100 }, M);
      allowed(invAdd.status) ? pass('BUG-06-SUPPLIER-INVOICE', 'Manager reaches New Supplier Invoice (not Forbidden)', `status=${invAdd.status}`)
                             : fail('BUG-06-SUPPLIER-INVOICE', 'supplier invoice still Forbidden', `status=${invAdd.status}`);
      if (invAdd.data?.id) cleanup.push(() => api('DELETE', `/api/restaurant/${RID}/procurement/supplier-invoices/${invAdd.data.id}`, null, ownerTok));

      // ── BUG 8 — Expense Journal: add an entry ──
      const pc = await api('POST', `/api/restaurant/${RID}/petty-cash`, { direction: 'OUT', amount: 1, category: 'MISC', entry_date: TODAY, notes: 'QA validation' }, M);
      allowed(pc.status) ? pass('BUG-08-EXPENSE-ENTRY', 'Manager can add an Expense Journal entry', `status=${pc.status}`)
                         : fail('BUG-08-EXPENSE-ENTRY', 'expense entry still owner/manager-only', `status=${pc.status}`);
      if (pc.data?.id) cleanup.push(() => api('DELETE', `/api/restaurant/${RID}/petty-cash/${pc.data.id}`, null, ownerTok));

      // ── BUG 10 — Checklist Templates: create ──
      const ct = await api('POST', `/api/restaurant/${RID}/checklists/templates`, { name: `QA Template ${Date.now()}`, facility_type: 'GENERIC', trigger_event: 'MANUAL' }, M);
      allowed(ct.status) ? pass('BUG-10-CHECKLIST-TEMPLATE', 'Manager (Full) can create a checklist template', `status=${ct.status}`)
                         : fail('BUG-10-CHECKLIST-TEMPLATE', 'checklist template create still owner-only', `status=${ct.status}`);
      if (ct.data?.id) cleanup.push(() => api('DELETE', `/api/restaurant/${RID}/checklists/templates/${ct.data.id}`, null, ownerTok));

      // ── BUG 9 — Events N/A: the role must carry NO Events tabs in /my-permissions ──
      const mp = await api('GET', `/api/restaurant/${RID}/my-permissions`, null, M);
      const at = Array.isArray(mp.data?.allowed_tabs) ? mp.data.allowed_tabs : [];
      const eventsLeak = at.filter(t => String(t).startsWith('EVENTS_'));
      eventsLeak.length === 0
        ? pass('BUG-09-EVENTS-NA', 'Role with Events = N/A carries no EVENTS_* tabs (nav must hide Events)', `hasHousekeeping=${at.includes('HOUSEKEEPING')}`)
        : fail('BUG-09-EVENTS-NA', 'Events tabs leaked into a role with Events set to N/A', `leaked=[${eventsLeak.join(',')}]`);
    }

    // ── BUG 3 — Cash handover routes to the incoming person, not the outgoing ──
    if (M) {
      const inc = await makeStaff('QA Incoming', roleId);
      if (!inc.tok || !inc.id) { skip('BUG-03-HANDOVER', 'handover', 'could not create incoming staff'); }
      else {
        cleanup.push(() => api('DELETE', `/api/owner/staff/${inc.id}`, null, ownerTok));
        const drawer = await api('POST', `/api/restaurant/${RID}/accounting/cash-drawers`, { business_date: TODAY, opening_float: 5000, cashier_name: 'QA Out' }, M);
        const drawerId = drawer.data?.id;
        if (!drawerId) { skip('BUG-03-HANDOVER', 'handover', `could not open drawer (status=${drawer.status})`); }
        else {
          const ho = await api('POST', `/api/restaurant/${RID}/accounting/cash-drawers/${drawerId}/handover`,
            { to_cashier_id: inc.id, to_cashier_name: 'QA Incoming', counted_cash: 5000, deposit_amount: 0, carry_over_float: 5000, deposit_to: 'SAFE' }, M);
          if (!allowed(ho.status)) { fail('BUG-03-HANDOVER-CREATE', 'could not start handover', `status=${ho.status}`); }
          else {
            const hid = ho.data?.id;
            // Incoming sees it with can_accept=true
            const incList = await api('GET', `/api/restaurant/${RID}/accounting/cash-handovers?date=${TODAY}`, null, inc.tok);
            const seenByIncoming = (Array.isArray(incList.data) ? incList.data : []).find(h => h.id === hid);
            (seenByIncoming && seenByIncoming.can_accept)
              ? pass('BUG-03-INCOMING-SEES', 'Pending handover is visible to the INCOMING person with Accept enabled', `can_accept=${seenByIncoming?.can_accept}`)
              : fail('BUG-03-INCOMING-SEES', 'incoming person cannot see / accept the handover', `seen=${!!seenByIncoming} can_accept=${seenByIncoming?.can_accept}`);
            // Outgoing sees it but can_accept=false, and accept is 403 for them
            const outList = await api('GET', `/api/restaurant/${RID}/accounting/cash-handovers?date=${TODAY}`, null, M);
            const seenByOutgoing = (Array.isArray(outList.data) ? outList.data : []).find(h => h.id === hid);
            const outAccept = await api('POST', `/api/restaurant/${RID}/accounting/cash-handovers/${hid}/accept`, {}, M);
            (seenByOutgoing && seenByOutgoing.can_accept === false && outAccept.status === 403)
              ? pass('BUG-03-OUTGOING-BLOCKED', 'Outgoing party cannot Accept & Sign (no self-accept)', `can_accept=${seenByOutgoing?.can_accept} accept=${outAccept.status}`)
              : fail('BUG-03-OUTGOING-BLOCKED', 'outgoing party could still accept', `can_accept=${seenByOutgoing?.can_accept} accept=${outAccept.status}`);
            // Incoming accepts successfully
            const incAccept = await api('POST', `/api/restaurant/${RID}/accounting/cash-handovers/${hid}/accept`, {}, inc.tok);
            allowed(incAccept.status)
              ? pass('BUG-03-INCOMING-ACCEPTS', 'Incoming person can Accept & Sign the handover', `status=${incAccept.status}`)
              : fail('BUG-03-INCOMING-ACCEPTS', 'incoming person could not accept', `status=${incAccept.status}`);
          }
        }
      }
    }

    // ── NO-LEAK — an ungranted custom role must STILL be 403 on these ──
    if (D) {
      const leaks = [
        ['NOLEAK-ACCT', 'GET', `/accounting/trial-balance?from=${FROM}&to=${TODAY}`],
        ['NOLEAK-PROC', 'GET', `/procurement/suppliers`],
        ['NOLEAK-PETTY', 'POST', `/petty-cash`, { direction: 'OUT', amount: 1, category: 'MISC' }],
        ['NOLEAK-CHK', 'POST', `/checklists/templates`, { name: 'x', facility_type: 'GENERIC', trigger_event: 'MANUAL' }],
      ];
      let ok = true, detail = [];
      for (const [id, method, path, body] of leaks) {
        const r = await api(method, `/api/restaurant/${RID}${path}`, body, D);
        detail.push(`${id}=${r.status}`);
        if (r.status !== 403) ok = false;
      }
      ok ? pass('BUG-RBAC-NO-LEAK', 'Ungranted role is STILL 403 on finance/procurement/expense/checklist (no fail-open)', detail.join(' '))
         : fail('BUG-RBAC-NO-LEAK', 'a permission-aware gate fails open for an ungranted role', detail.join(' '));
    }
  } finally {
    for (const fn of cleanup.reverse()) { try { await fn(); } catch {} }
    try { if (mgr.id) await api('DELETE', `/api/owner/staff/${mgr.id}`, null, ownerTok); } catch {}
    try { if (den.id) await api('DELETE', `/api/owner/staff/${den.id}`, null, ownerTok); } catch {}
    // blank the throwaway roles' matrices + delete the roles
    try { const c = await api('GET', `/api/restaurant/${RID}/role-permissions`, null, ownerTok); const m = (c.data && typeof c.data === 'object') ? { ...c.data } : {}; m[roleId] = {}; if (denyRoleId) m[denyRoleId] = {}; await api('POST', `/api/restaurant/${RID}/role-permissions`, m, ownerTok); } catch {}
    try { await api('DELETE', `/api/restaurant/${RID}/custom-roles/${roleId}`, null, ownerTok); } catch {}
    try { if (denyRoleId) await api('DELETE', `/api/restaurant/${RID}/custom-roles/${denyRoleId}`, null, ownerTok); } catch {}
  }

  const p = results.filter(r => r.s === 'PASS').length;
  const f = results.filter(r => r.s === 'FAIL').length;
  const s = results.filter(r => r.s === 'SKIP').length;
  console.log('\n' + '='.repeat(64));
  console.log(`  RESULT — ${p} PASS · ${f} FAIL · ${s} SKIP`);
  console.log('='.repeat(64) + '\n');
  process.exit(f > 0 ? 1 : 0);
}
main().catch(e => { console.error('crashed:', e); process.exit(2); });
