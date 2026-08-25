/**
 * Day Book end-to-end + reconciliation — Hotel · Restaurant · Events.
 * ---------------------------------------------------------------------------
 * Proves that every settled transaction in each module is reflected in the
 * Accounting Day Book (GL) as a BALANCED journal hitting the right revenue and
 * cash accounts. Runs against a LIVE tenant as the OWNER.
 *
 * Two passes:
 *   PART A — ACTIVE E2E (self-cleaning): for each module, create + settle ONE
 *            transaction, assert its journal appears in the Day Book balanced
 *            with the expected revenue/cash accounts, then cancel/void/reverse
 *            it so the tenant is left clean.
 *   PART B — RECONCILIATION (read-only): for a date range, list every existing
 *            transaction per module and confirm each settled one has a balanced
 *            Day Book journal; report any that are NOT reflected.
 *
 * Run (never commit real creds — pass them at the shell):
 *   OWNER_EMAIL=you@example.com OWNER_PASSWORD=secret RESTAURANT_ID=RESTO-1003 \
 *     node test-scripts/e2e_daybook_full_loop.mjs
 *
 * Optional env:
 *   BASE=https://erp.atithi-setu.com   (default)
 *   RECON_FROM=2026-08-01 RECON_TO=2026-08-16   (default: last 30 days)
 *   SKIP_ACTIVE=1   run only the read-only reconciliation (no data created)
 *   SKIP_RECON=1    run only the active E2E
 */

const BASE = (process.env.BASE || 'https://erp.atithi-setu.com').replace(/\/$/, '');
const EMAIL = process.env.OWNER_EMAIL || process.env.LIVE_LOGIN_ID || '';
const PASSWORD = process.env.OWNER_PASSWORD || process.env.LIVE_PASSWORD || '';
const RID = process.env.RESTAURANT_ID || 'RESTO-1003';
const SKIP_ACTIVE = process.env.SKIP_ACTIVE === '1';
const SKIP_RECON = process.env.SKIP_RECON === '1';

const today = new Date().toISOString().slice(0, 10);
const RECON_TO = process.env.RECON_TO || today;
const RECON_FROM = process.env.RECON_FROM || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

let token = '';
let passed = 0, failed = 0, skipped = 0;
const rows = []; // reflection matrix rows: { module, txn, created, journal, balanced, accounts, note }
const cleanups = []; // LIFO stack of { label, fn } run at the end to leave the tenant clean

const c = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const pass = (id, msg) => { passed++; console.log(`  ${c.g}✅ ${id}${c.x} ${msg || ''}`); };
const fail = (id, msg) => { failed++; console.log(`  ${c.r}❌ ${id}${c.x} ${msg || ''}`); };
const skip = (id, msg) => { skipped++; console.log(`  ${c.y}⚠  ${id}${c.x} ${c.d}${msg || ''}${c.x}`); };
const section = (t) => console.log(`\n${c.b}── ${t} ──${c.x}`);
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

async function api(method, path, body, tok = token) {
  const headers = { 'Content-Type': 'application/json' };
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  let res, data;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const txt = await res.text();
    try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  } catch (e) {
    return { status: 0, data: { error: String(e && e.message || e) } };
  }
  return { status: res.status, data };
}

// ── Auth ────────────────────────────────────────────────────────────────────
async function login() {
  section('AUTH');
  if (!EMAIL || !PASSWORD) { fail('LOGIN', 'set OWNER_EMAIL and OWNER_PASSWORD env vars'); return false; }
  const r = await api('POST', '/api/auth/owner/login', { identifier: EMAIL, password: PASSWORD });
  if (r.status === 200 && r.data && r.data.jwt_token) {
    if (r.data.restaurant_id && r.data.restaurant_id !== RID) {
      fail('LOGIN', `logged in but owner's restaurant is ${r.data.restaurant_id}, not ${RID}`);
      return false;
    }
    token = r.data.jwt_token;
    pass('LOGIN', `owner @ ${r.data.restaurant_id || RID}`);
    return true;
  }
  // Multi-restaurant owner: pick the target and exchange the temp token.
  if (r.status === 200 && r.data && r.data.temp_token) {
    const sel = await api('POST', '/api/auth/select-restaurant', { temp_token: r.data.temp_token, restaurant_id: RID });
    if (sel.status === 200 && sel.data && sel.data.jwt_token) {
      token = sel.data.jwt_token; pass('LOGIN', `owner @ ${RID} (multi-restaurant select)`); return true;
    }
    fail('LOGIN', `multi-restaurant select failed for ${RID}: HTTP ${sel.status} ${JSON.stringify(sel.data)}`);
    return false;
  }
  // Fallback: the generic login endpoint (returns { token, restaurantId }).
  const alt = await api('POST', '/api/auth/login', { loginId: EMAIL, password: PASSWORD });
  if (alt.status === 200 && alt.data && (alt.data.token || alt.data.jwt_token)) {
    const rid = alt.data.restaurantId || alt.data.restaurant_id;
    if (rid && rid !== RID) { fail('LOGIN', `logged in but restaurant is ${rid}, not ${RID}`); return false; }
    token = alt.data.token || alt.data.jwt_token; pass('LOGIN', `owner @ ${rid || RID} (/api/auth/login)`); return true;
  }
  fail('LOGIN', `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
  return false;
}

// Multipart upload helper (guest ID doc — the api() helper is JSON-only).
async function uploadFile(path, fieldFile, filename, bytes, extra = {}) {
  const fd = new FormData();
  fd.append(fieldFile, new Blob([bytes], { type: 'image/png' }), filename);
  for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
  try {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
    const txt = await res.text(); let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
    return { status: res.status, data };
  } catch (e) { return { status: 0, data: { error: String(e && e.message || e) } }; }
}
// 1×1 transparent PNG (base64) — a valid image to satisfy the ID-doc gate.
const TINY_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'), s => s.charCodeAt(0));

// ── Day Book helpers ──────────────────────────────────────────────────────────
// Pull today's GL. (gl-entries returns is_reversed=0 rows only.)
async function dayBook(from = today, to = today) {
  const r = await api('GET', `/api/restaurant/${RID}/accounting/gl-entries?from=${from}&to=${to}`);
  return Array.isArray(r.data) ? r.data : [];
}
async function cashBook(date = today) {
  const r = await api('GET', `/api/restaurant/${RID}/accounting/cash-book?date=${date}`);
  return r.status === 200 ? r.data : null;
}
// Fetch the lines of a specific journal by exact ref (across a small window).
async function journalLines(ref, from = today, to = today) {
  const all = await dayBook(from, to);
  return all.filter(e => String(e.journal_ref) === String(ref));
}
// Validate a journal: exists, balanced (ΣDr=ΣCr), and touches the expected accounts.
async function assertJournal(id, ref, { revenue, cash, from = today, to = today } = {}) {
  const lines = await journalLines(ref, from, to);
  const row = { module: id.split(':')[0] || id, txn: ref, created: '✓', journal: '—', balanced: '—', accounts: '—', note: '' };
  if (lines.length === 0) {
    fail(id, `journal ${ref} NOT found in Day Book (${from}..${to})`);
    row.journal = '✗ missing'; rows.push(row); return false;
  }
  const dr = r2(lines.reduce((s, l) => s + Number(l.dr_amount || 0), 0));
  const cr = r2(lines.reduce((s, l) => s + Number(l.cr_amount || 0), 0));
  const balanced = Math.abs(dr - cr) < 0.02;
  const codes = new Set(lines.map(l => String(l.account_code)));
  const src = lines[0].source_type;
  row.journal = `✓ ${lines.length} lines (${src})`;
  row.balanced = balanced ? `✓ Dr=Cr=${dr}` : `✗ Dr ${dr} / Cr ${cr}`;
  let acctOk = true;
  const acctNotes = [];
  if (revenue) { const ok = codes.has(revenue); acctOk = acctOk && ok; acctNotes.push(`rev ${revenue}${ok ? '✓' : '✗'}`); }
  if (cash) { const ok = codes.has(cash); acctOk = acctOk && ok; acctNotes.push(`cash ${cash}${ok ? '✓' : '✗'}`); }
  row.accounts = acctNotes.join(' ') || [...codes].join(',');
  rows.push(row);
  if (balanced && acctOk) { pass(id, `${ref}: ${lines.length} lines, ${src}, balanced Dr=Cr=${dr} ${acctNotes.join(' ')}`); return true; }
  fail(id, `${ref}: balanced=${balanced} (Dr ${dr}/Cr ${cr}) ${acctNotes.join(' ')} accts=[${[...codes].join(',')}]`);
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART A — ACTIVE E2E (self-cleaning). Filled in from the module endpoint specs.
// ═══════════════════════════════════════════════════════════════════════════
async function activeRestaurant() {
  section('PART A · RESTAURANT — create → settle → Day Book → clean up');
  // A standalone CASH dine-in order. payment_method MUST be CASH at creation — the
  // settle step only flips payment_status; _postOrderGl derives the cash account
  // (1000 vs 1010) from the order row. total 118 = 100 net + 9 CGST + 9 SGST.
  const cr = await api('POST', `/api/restaurant/${RID}/orders`, {
    table_number: 'E2E-DAYBOOK', items: [{ name: 'E2E Test Item', quantity: 2, price: 50 }],
    total_amount: 118, gst_amount: 18, payment_method: 'CASH', checkout_mode: 'postpaid',
    customer_name: 'E2E DAYBOOK DONOTCALL', customer_phone: '9990000001',
  });
  const oid = cr.data && (cr.data.orderId || cr.data.id);
  if ((cr.status !== 200 && cr.status !== 201) || !oid) { fail('TC-DB-REST', `create order failed HTTP ${cr.status} ${JSON.stringify(cr.data).slice(0, 140)}`); return; }
  pass('TC-DB-REST/create', `order ${oid} created (₹118 incl ₹18 GST)`);
  // FNB_ORDER GL has no auto-reversal path — clean up by cancelling, soft-deleting the
  // invoice (RESTO-1003 has invoice_delete_enabled=1), and posting a compensating journal.
  cleanups.push({ label: `REST ${oid}`, fn: async () => {
    await api('PATCH', `/api/orders/${oid}`, { status: 'CANCELLED' });
    await api('POST', `/api/restaurant/${RID}/accounting/journal-entries`, {
      entry_date: today, narration: `Reverse ${oid} (e2e Day Book test)`,
      lines: [
        { account_code: '4010', account_name: 'F&B Revenue', dr_amount: 100, cr_amount: 0 },
        { account_code: '2200', account_name: 'GST Payable — CGST', dr_amount: 9, cr_amount: 0 },
        { account_code: '2210', account_name: 'GST Payable — SGST', dr_amount: 9, cr_amount: 0 },
        { account_code: '1000', account_name: 'Cash in Hand', dr_amount: 0, cr_amount: 118 },
      ],
    });
    const del = await api('DELETE', `/api/restaurant/${RID}/invoice/order/${oid}`, { reason: 'e2e Day Book test cleanup' });
    return del.status === 200 || del.status === 201 || del.status === 404;
  } });
  const st = await api('PATCH', `/api/orders/${oid}/payment`, { status: 'PAID' });
  if (st.status !== 200) { fail('TC-DB-REST/settle', `settle failed HTTP ${st.status} ${JSON.stringify(st.data).slice(0, 140)}`); return; }
  pass('TC-DB-REST/settle', 'order marked PAID (cash)');
  await assertJournal('Restaurant:FNB', `ORDER-${oid}`, { revenue: '4010', cash: '1000' });
}

async function activeHotel() {
  section('PART A · HOTEL — booking → check-in → checkout+settle → Day Book → clean up');
  const rl = await api('GET', `/api/restaurant/${RID}/hotel/rooms`);
  if (!Array.isArray(rl.data)) { skip('TC-DB-HOTEL', `rooms unavailable (HTTP ${rl.status}) — hotel not configured?`); return; }
  const room = rl.data.find(r => String(r.status).toUpperCase() === 'VACANT') || rl.data[0];
  if (!room || !room.id) { skip('TC-DB-HOTEL', 'no rooms configured'); return; }
  const co = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const bk = await api('POST', `/api/restaurant/${RID}/hotel/bookings`, {
    room_id: room.id, guest_name: 'E2E DAYBOOK DONOTCALL', guest_phone: '+919999000001',
    guest_email: 'e2e-noreply@example.invalid', guest_nationality: 'IN', num_guests: 2,
    check_in_date: today, check_out_date: co, booking_type: 'OVERNIGHT', booking_source: 'DIRECT', room_rate: 3000,
  });
  const bid = bk.data && bk.data.id;
  if ((bk.status !== 200 && bk.status !== 201) || !bid) { fail('TC-DB-HOTEL/create', `booking failed HTTP ${bk.status} ${JSON.stringify(bk.data).slice(0, 160)}`); return; }
  pass('TC-DB-HOTEL/create', `booking ${bid} on room ${room.name || room.room_number || room.id}`);
  let reversed = false;
  // Fallback cleanup: cancel while still BOOKED (works pre-checkout).
  cleanups.push({ label: `HOTEL ${bid}`, fn: async () => {
    if (reversed) return true; // GL already neutralised via credit-note; booking is a historical CHECKED_OUT row
    const cx = await api('POST', `/api/restaurant/${RID}/hotel/bookings/${bid}/cancel`, { reason: 'e2e Day Book cleanup' });
    return cx.status === 200 || cx.status === 201;
  } });
  // Check in — satisfy the ID-doc gate on demand (default hotel_require_id_at_checkin=1).
  let ci = await api('POST', `/api/restaurant/${RID}/hotel/bookings/${bid}/checkin`, { skip_form_c_for_now: true });
  if (ci.status === 400 && JSON.stringify(ci.data || '').includes('guest_documents')) {
    await uploadFile(`/api/restaurant/${RID}/hotel/bookings/${bid}/documents`, 'file', 'id.png', TINY_PNG, { doc_type: 'ID', label: 'E2E' });
    ci = await api('POST', `/api/restaurant/${RID}/hotel/bookings/${bid}/checkin`, { skip_form_c_for_now: true });
  }
  const fid = ci.data && ci.data.folio_id;
  if (ci.status !== 200 || !fid) { fail('TC-DB-HOTEL/checkin', `check-in failed HTTP ${ci.status} ${JSON.stringify(ci.data).slice(0, 160)}`); return; }
  pass('TC-DB-HOTEL/checkin', `checked in, folio ${fid}`);
  const outR = await api('GET', `/api/restaurant/${RID}/hotel/folios/${fid}/outstanding`);
  const owe = outR.data && (outR.data.outstanding != null ? outR.data.outstanding : (outR.data.folio && outR.data.folio.grand_total));
  const amt = r2(owe || 3000);
  const cxo = await api('POST', `/api/restaurant/${RID}/hotel/bookings/${bid}/checkout`, {
    payment_method: 'CASH', additional_payment_amount: amt, additional_payment_method: 'CASH', additional_payment_note: 'E2E settle',
  });
  if (cxo.status !== 200) { fail('TC-DB-HOTEL/checkout', `checkout failed HTTP ${cxo.status} ${JSON.stringify(cxo.data).slice(0, 160)}`); return; }
  pass('TC-DB-HOTEL/checkout', `checked out + settled ₹${amt} cash`);
  await assertJournal('Hotel:FOLIO', `FOLIO-${fid}`, { revenue: '4000', cash: '1000' });
  // Neutralise the settlement GL via a credit note (the booking stays CHECKED_OUT as history).
  cleanups.push({ label: `HOTEL folio ${fid}`, fn: async () => {
    const cn = await api('POST', `/api/restaurant/${RID}/hotel/folios/${fid}/credit-note`, { reason: 'e2e Day Book reversal' });
    reversed = cn.status === 200 || cn.status === 201;
    return reversed;
  } });
}

async function activeEvents() {
  section('PART A · EVENTS — booking → advance → invoice/settle → Day Book → clean up');
  const vl = await api('GET', `/api/restaurant/${RID}/events/venues`);
  if (vl.status === 403) { skip('TC-DB-EVENT', 'Events module not enabled on this tenant (needs platform admin to enable)'); return; }
  let venue = Array.isArray(vl.data) ? vl.data[0] : null;
  if (!venue) {
    const vc = await api('POST', `/api/restaurant/${RID}/events/venues`, { name: 'E2E Test Hall', category: 'BANQUET', ac_type: 'AC', daily_rate: 10000, gst_percent: 18 });
    venue = (vc.status === 200 || vc.status === 201) ? vc.data : null;
    if (venue && venue.id) cleanups.push({ label: `EVENT venue ${venue.id}`, fn: async () => { const d = await api('DELETE', `/api/restaurant/${RID}/events/venues/${venue.id}`); return d.status === 200; } });
  }
  if (!venue || !venue.id) { skip('TC-DB-EVENT', `no venue available (HTTP ${vl.status})`); return; }
  const evd = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const bk = await api('POST', `/api/restaurant/${RID}/events/bookings`, {
    customer_name: 'E2E DAYBOOK Ghost Event', customer_phone: '0000000000', customer_email: 'e2e-noreply@example.invalid',
    event_type: 'CONFERENCE', status: 'CONFIRMED', venue_id: venue.id, event_date: evd, venue_rate_basis: 'DAILY',
    guest_count: 50, booking_source: 'DIRECT', venue_rate: 10000, discount: 0, advance_amount: 0,
    special_requests: 'E2E Day Book test — auto-cleaned',
  });
  const bid = bk.data && bk.data.id;
  if ((bk.status !== 200 && bk.status !== 201) || !bid) { fail('TC-DB-EVENT/create', `booking failed HTTP ${bk.status} ${JSON.stringify(bk.data).slice(0, 160)}`); return; }
  const total = r2(bk.data.total_amount || 0);
  pass('TC-DB-EVENT/create', `booking ${bid} (total ₹${total})`);
  let pid = null;
  cleanups.push({ label: `EVENT ${bid}`, fn: async () => {
    if (pid) await api('DELETE', `/api/restaurant/${RID}/events/payments/${pid}?force=1`); // reverses EVENT_ADVANCE
    const cx = await api('POST', `/api/restaurant/${RID}/events/bookings/${bid}/cancel`, { acknowledge_refund: true, reason: 'e2e Day Book cleanup' }); // reverses EVENT_SETTLEMENT + voids folio
    return cx.status === 200 || cx.status === 201;
  } });
  // Advance (posts EVENT_ADVANCE same-day, Dr Cash 1000 / Cr 2100). Keep ≤ grand total.
  const adv = total > 0 ? Math.min(5000, Math.floor(total / 2)) || 2000 : 2000;
  const pay = await api('POST', `/api/restaurant/${RID}/events/bookings/${bid}/payments`, { amount: adv, method: 'CASH', paid_at: today, reference: 'E2E-ADV', note: 'E2E advance' });
  pid = pay.data && pay.data.payment_id;
  if ((pay.status === 200 || pay.status === 201) && pid) {
    pass('TC-DB-EVENT/advance', `advance ₹${adv} recorded (${pid})`);
    await assertJournal('Events:advance', `EVENT-PAY-${pid}`, { cash: '1000' });
  } else fail('TC-DB-EVENT/advance', `advance failed HTTP ${pay.status} ${JSON.stringify(pay.data).slice(0, 140)}`);
  // Invoice / settle (posts EVENT_SETTLEMENT, revenue 4050).
  const cko = await api('POST', `/api/restaurant/${RID}/events/bookings/${bid}/checkout`, {});
  const fid = cko.data && cko.data.id;
  if ((cko.status === 200 || cko.status === 201) && fid) {
    pass('TC-DB-EVENT/settle', `invoice ${cko.data.invoice_number || fid} raised`);
    await assertJournal('Events:settle', `FOLIO-${fid}`, { revenue: '4050' });
  } else fail('TC-DB-EVENT/settle', `checkout failed HTTP ${cko.status} ${JSON.stringify(cko.data).slice(0, 140)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// PART B — RECONCILIATION (read-only): every settled transaction in the range
// must have a balanced Day Book journal.
// ═══════════════════════════════════════════════════════════════════════════
// Classify a ref that is missing from the window's ACTIVE Day Book, against the
// full ledger (include_reversed=1): 'gap' = no journal anywhere (true posting
// gap); 'reversed' = only reversed rows (credit-noted / revised → net-zero,
// correct); 'active-elsewhere' = an active journal exists, just dated outside
// the recon window.
async function classifyRef(ref) {
  const r = await api('GET', `/api/restaurant/${RID}/accounting/gl-entries?journal_ref=${encodeURIComponent(ref)}&include_reversed=1`);
  const rows = Array.isArray(r.data) ? r.data : [];
  if (rows.length === 0) return 'gap';
  const active = rows.filter(e => Number(e.is_reversed || 0) === 0);
  return active.length === 0 ? 'reversed' : 'active-elsewhere';
}

async function reconReport(id, label, txns, chk) {
  if (txns.length === 0) { skip(id, `${label}: no settled transactions in range`); return; }
  let ok = 0; const reversed = []; const gaps = [];
  for (const t of txns) {
    const s = chk(t.ref);
    if (s === 'ok') { ok++; continue; }
    if (s === 'unbalanced') { gaps.push(`${t.ref} (UNBALANCED, ₹${r2(t.amt || 0)})`); continue; }
    const cls = await classifyRef(t.ref);       // 'missing' from window — check the full ledger
    if (cls === 'reversed') reversed.push(`${t.ref} (₹${r2(t.amt || 0)})`);
    else if (cls === 'active-elsewhere') ok++;   // journal exists, just dated outside the window
    else gaps.push(`${t.ref} (settled ${String(t.date || '?').slice(0, 10)}, ₹${r2(t.amt || 0)})`);
  }
  if (gaps.length === 0) pass(id, `${label}: ${ok} reflected${reversed.length ? ` + ${reversed.length} reversed/credit-noted (net-zero, OK)` : ''}; 0 true gaps`);
  else fail(id, `${label}: ${gaps.length} TRUE gap(s) → ${gaps.slice(0, 8).join('; ')}${reversed.length ? ` · (also ${reversed.length} reversed/credit-noted, OK)` : ''}`);
}

async function reconcile() {
  section(`PART B · RECONCILIATION — settled transactions vs Day Book (${RECON_FROM}..${RECON_TO})`);

  // ── DIAGNOSTICS FIRST — prove the Day Book read itself is healthy, so a 0/N
  //    "not reflected" can't be mis-read as a posting gap when it's really an
  //    empty/failed read (permission gate, wrong date field, etc.). ──
  const glRaw = await api('GET', `/api/restaurant/${RID}/accounting/gl-entries?from=${RECON_FROM}&to=${RECON_TO}`);
  const glCount = Array.isArray(glRaw.data) ? glRaw.data.length : 0;
  const refsSample = Array.isArray(glRaw.data) ? [...new Set(glRaw.data.map(e => String(e.journal_ref)))].slice(0, 6) : [];
  const tb = await api('GET', `/api/restaurant/${RID}/accounting/trial-balance?from=${RECON_FROM}&to=${RECON_TO}`);
  const tbRows = Array.isArray(tb.data) ? tb.data : [];
  const tbDr = tbRows.reduce((s, r) => s + Number(r.dr_total || 0), 0);
  const tbCr = tbRows.reduce((s, r) => s + Number(r.cr_total || 0), 0);
  const glx = await api('GET', `/api/restaurant/${RID}/accounting/gl-exceptions`);
  const glxCount = Array.isArray(glx.data) ? glx.data.length : (glx.data && Array.isArray(glx.data.rows) ? glx.data.rows.length : 0);
  console.log(`  ${c.d}diag · gl-entries: HTTP ${glRaw.status}, ${glCount} rows in window; sample refs=[${refsSample.join(', ')}]${c.x}`);
  console.log(`  ${c.d}diag · trial-balance: HTTP ${tb.status}, ${tbRows.length} accounts, ΣDr=${r2(tbDr)} ΣCr=${r2(tbCr)} diff=${r2(tbDr - tbCr)}${c.x}`);
  console.log(`  ${c.d}diag · gl-exceptions (refused/unbalanced journals): HTTP ${glx.status}, ${glxCount} rows${c.x}`);
  if (glRaw.status !== 200) fail('TC-DB-READ', `Day Book read failed (HTTP ${glRaw.status}) — reflection results below are unreliable until this is fixed: ${JSON.stringify(glRaw.data).slice(0,160)}`);
  else if (glCount === 0) skip('TC-DB-READ', `Day Book returned 0 GL rows for ${RECON_FROM}..${RECON_TO} — either no posted GL in range, or entry_date is outside it`);
  else pass('TC-DB-READ', `Day Book read OK — ${glCount} GL rows in window`);
  if (tb.status === 200 && Math.abs(r2(tbDr - tbCr)) < 0.02) pass('TC-DB-TRIALBAL', `Trial balance balances (ΣDr=ΣCr=${r2(tbDr)})`);
  else if (tb.status === 200) fail('TC-DB-TRIALBAL', `Trial balance OUT by ${r2(tbDr - tbCr)} (Dr ${r2(tbDr)} / Cr ${r2(tbCr)})`);
  if (glxCount === 0) pass('TC-DB-EXCEPTIONS', 'No refused/unbalanced journals (gl_exceptions empty)');
  else fail('TC-DB-EXCEPTIONS', `${glxCount} refused journal(s) in gl_exceptions — investigate`);

  const gl = Array.isArray(glRaw.data) ? glRaw.data : [];
  if (gl.length >= 2000) skip('TC-DB-RECON-CAP', `Day Book hit the 2000-row cap for this range — narrow RECON_FROM/RECON_TO for a complete audit`);
  const byRef = {};
  for (const e of gl) { const k = String(e.journal_ref); (byRef[k] || (byRef[k] = { dr: 0, cr: 0 })); byRef[k].dr += Number(e.dr_amount || 0); byRef[k].cr += Number(e.cr_amount || 0); }
  const chk = (ref) => { const j = byRef[ref]; return !j ? 'missing' : (Math.abs(r2(j.dr) - r2(j.cr)) < 0.02 ? 'ok' : 'unbalanced'); };
  const inRange = (d) => { const s = String(d || '').slice(0, 10); return s >= RECON_FROM && s <= RECON_TO; };

  // Restaurant: PAID standalone orders (exclude charge-to-room / folio-bound — those post via the folio, not ORDER-<id>).
  const ord = await api('GET', `/api/restaurant/${RID}/orders`);
  if (Array.isArray(ord.data)) {
    const settled = ord.data.filter(o => String(o.payment_status).toUpperCase() === 'PAID' && String(o.status).toUpperCase() !== 'CANCELLED'
      && String(o.payment_method).toUpperCase() !== 'CHARGE_TO_ROOM' && !o.folio_id && inRange(o.created_at));
    await reconReport('TC-DB-RECON-REST', 'Restaurant orders', settled.map(o => ({ ref: `ORDER-${o.id}`, date: o.created_at, amt: o.total_amount })), chk);
  } else skip('TC-DB-RECON-REST', `orders list HTTP ${ord.status}`);

  // Hotel: settled folios.
  const fol = await api('GET', `/api/restaurant/${RID}/hotel/folios`);
  if (Array.isArray(fol.data)) {
    const settled = fol.data.filter(f => String(f.status).toLowerCase() === 'settled' && inRange(f.settled_at || f.created_at));
    await reconReport('TC-DB-RECON-HOTEL', 'Hotel folios', settled.map(f => ({ ref: `FOLIO-${f.id}`, date: f.settled_at || f.created_at, amt: f.grand_total })), chk);
  } else skip('TC-DB-RECON-HOTEL', `folios list HTTP ${fol.status}`);

  // Events: revenue is recognized at CHECKOUT as FOLIO-<folio_id>. Advances post
  // SEPARATELY as EVENT-PAY-<pid> (Dr Cash / Cr Advances). So a booking that merely
  // HAS a folio but isn't checked out yet legitimately has NO revenue journal — that
  // is deferred revenue, NOT an error. We only fail on a revenue journal that exists
  // but is unbalanced; advance-stage bookings are reported, not failed.
  const evb = await api('GET', `/api/restaurant/${RID}/events/bookings?from=${RECON_FROM}&to=${RECON_TO}`);
  if (Array.isArray(evb.data)) {
    const withFolio = evb.data.filter(b => b.folio_id);
    if (withFolio.length === 0) { skip('TC-DB-RECON-EVENT', 'no event bookings with a folio in range'); }
    else {
      const recognized = withFolio.filter(b => chk(`FOLIO-${b.folio_id}`) === 'ok');
      const unbalanced = withFolio.filter(b => chk(`FOLIO-${b.folio_id}`) === 'unbalanced');
      const deferred   = withFolio.filter(b => chk(`FOLIO-${b.folio_id}`) === 'missing');
      if (unbalanced.length) fail('TC-DB-RECON-EVENT', `${unbalanced.length} event revenue journal(s) UNBALANCED → ${unbalanced.map(b => `FOLIO-${b.folio_id}`).slice(0, 6).join(', ')}`);
      else pass('TC-DB-RECON-EVENT', `${recognized.length}/${withFolio.length} event revenue journals recognized + balanced; ${deferred.length} advance-stage (revenue posts at checkout — advances tracked as EVENT-PAY-*)`);
    }
  } else if (evb.status === 403) skip('TC-DB-RECON-EVENT', 'Events not enabled');
  else skip('TC-DB-RECON-EVENT', `event bookings HTTP ${evb.status}`);
}

async function runCleanups() {
  if (cleanups.length === 0) return;
  section('CLEANUP — reverse / void the test transactions (LIFO)');
  while (cleanups.length) {
    const { label, fn } = cleanups.pop();
    try { const ok = await fn(); if (ok === false) fail(`CLEAN ${label}`, 'cleanup returned failure — verify manually'); else pass(`CLEAN ${label}`, 'reversed / removed'); }
    catch (e) { fail(`CLEAN ${label}`, String(e && e.message || e)); }
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────
function printMatrix() {
  section('DAY BOOK REFLECTION MATRIX');
  if (rows.length === 0) { console.log('  (no transactions exercised)'); return; }
  const w = (s, n) => String(s == null ? '' : s).padEnd(n).slice(0, n);
  console.log(`  ${c.d}${w('MODULE', 12)} ${w('JOURNAL / TXN', 22)} ${w('CREATED', 8)} ${w('IN DAY BOOK', 26)} ${w('BALANCED', 20)} ACCOUNTS${c.x}`);
  for (const r of rows) console.log(`  ${w(r.module, 12)} ${w(r.txn, 22)} ${w(r.created, 8)} ${w(r.journal, 26)} ${w(r.balanced, 20)} ${r.accounts}`);
}

async function main() {
  console.log(`\n${c.b}Day Book E2E + Reconciliation${c.x}  ${c.d}${BASE} · ${RID} · ${today}${c.x}`);
  if (!await login()) { console.log('\nAborting: login failed.\n'); process.exit(2); }

  if (!SKIP_ACTIVE) { await activeRestaurant(); await activeHotel(); await activeEvents(); }
  else skip('PART-A', 'SKIP_ACTIVE=1');

  if (!SKIP_RECON) { await reconcile(); }
  else skip('PART-B', 'SKIP_RECON=1');

  await runCleanups();
  printMatrix();
  section('RESULT');
  console.log(`  ${passed} passed · ${failed} failed · ${skipped} skipped`);
  console.log('');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e); process.exit(3); });
