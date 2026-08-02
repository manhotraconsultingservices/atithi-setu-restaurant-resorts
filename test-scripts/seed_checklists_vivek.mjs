/**
 * seed_checklists_vivek.mjs — seed PRODUCTION-GRADE checklist templates into a
 * tenant (default RESTO-1003 / Vivek's Cafe). Additive + idempotent: a template
 * whose name already exists is skipped, so it is safe to re-run.
 *
 * Creates the operational checklists a hotel + events property actually uses:
 * PMS check-in, extended-stay (mid-stay), event-hall daily, an electrical
 * inspection, and a pre-event setup. (The check-out checklists — "PMS - Check-Out"
 * and "Event Hall - Check-Out" — already exist as seeded system templates.)
 *
 * Run (owner credentials):
 *   OWNER_EMAIL=you@x.com OWNER_PASSWORD=secret RESTAURANT_ID=RESTO-1003 \
 *     node test-scripts/seed_checklists_vivek.mjs
 */

const BASE = process.env.BASE_URL || 'https://erp.atithi-setu.com';
const EMAIL = process.env.OWNER_EMAIL || process.env.LIVE_LOGIN_ID || '';
const PASSWORD = process.env.OWNER_PASSWORD || process.env.LIVE_PASSWORD || '';
const RID = process.env.RESTAURANT_ID || process.env.LIVE_RESTAURANT_ID || '';
if (!EMAIL || !PASSWORD || !RID) { console.error('\nSet OWNER_EMAIL, OWNER_PASSWORD, RESTAURANT_ID.\n'); process.exit(1); }

let token = '';
const api = async (m, p, b) => {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${p}`, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json().catch(() => ({})) : await r.text() };
};
const P = `/api/restaurant/${RID}`;
const M = (label) => ({ label, is_mandatory: true });
const O = (label) => ({ label, is_mandatory: false });

// Production-grade template set (category is matched by name to the seeded categories).
const TEMPLATES = [
  { name: 'PMS - Check-In', category: 'PMS', facility_type: 'ROOM', trigger_event: 'CHECK_IN', blocks_release: false, steps: [
    M('Verify guest photo ID matches the booking'), M('Hand over room keys / access card'),
    M('Switch on AC & lights, set to comfort level'), O('Check minibar is stocked & sealed'),
    M('Place welcome amenities & drinking water'), O('Share WiFi password & breakfast timing'),
    O('Note guest preferences / wake-up call'),
  ] },
  { name: 'PMS - Extended Stay', category: 'PMS', facility_type: 'ROOM', trigger_event: 'MID_STAY', recurrence_nights: 3, blocks_release: false, steps: [
    M('Replace bed linen & pillow covers'), M('Provide fresh towels & bathmat'),
    M('Replenish toiletries & amenities'), M('Empty & reline dustbins'),
    M('Restock drinking water'), O('Vacuum / mop the floor'), O('Restock tea / coffee sachets'),
  ] },
  { name: 'Event Hall - Daily', category: 'Event Hall', facility_type: 'EVENT', trigger_event: 'DAILY', blocks_release: false, steps: [
    M('Sweep & mop the floor'), M('Arrange chairs & tables to the default layout'),
    M('Test AV — microphone, speakers, projector'), M('Confirm AC & lighting are working'),
    M('Clean & stock the washrooms'), O('Wipe down surfaces & stage'), O('Stock drinking water & glasses'),
  ] },
  { name: 'Inspection - Electrical', category: 'Inspection', facility_type: 'GENERIC', trigger_event: 'MANUAL', blocks_release: false, steps: [
    M('Inspect main DB & MCBs for tripping / heating'), M('Test all power sockets & switches'),
    M('Check visible wiring for damage or exposure'), M('Verify emergency & exit lights'),
    M('Test smoke detectors'), M('RCCB / earth-leakage trip test'), O('Record meter reading & log observations'),
  ] },
  { name: 'Event - Pre-Event Setup', category: 'Event', facility_type: 'EVENT', trigger_event: 'MANUAL', blocks_release: false, steps: [
    M('Confirm layout against the event order'), M('Stage, backdrop & décor in place'),
    M('Test AV & lighting cues'), M('Catering / buffet stations ready'),
    M('Chairs match the guest count'), M('Emergency exits clear & marked'), O('Signage & directions placed'),
  ] },
];

(async () => {
  let r = await api('POST', '/api/auth/owner/login', { identifier: EMAIL, password: PASSWORD });
  if (r.status !== 200) r = await api('POST', '/api/auth/login', { loginId: EMAIL, password: PASSWORD, restaurantId: RID });
  token = r.data?.jwt_token || r.data?.token || '';
  if (!token) { console.error('❌ LOGIN FAILED —', r.status, JSON.stringify(r.data)); process.exit(1); }
  console.log(`\n═══ Seeding production checklists — ${RID} @ ${BASE} ═══\n`);

  const cats = (await api('GET', `${P}/checklists/categories`)).data;
  const catId = (name) => (Array.isArray(cats) ? cats.find(c => String(c.name).toLowerCase() === name.toLowerCase()) : null)?.id || null;
  const existing = (await api('GET', `${P}/checklists/templates`)).data;
  const have = new Set((Array.isArray(existing) ? existing : []).map(t => String(t.name).toLowerCase()));

  let created = 0, skipped = 0, failed = 0;
  for (const t of TEMPLATES) {
    if (have.has(t.name.toLowerCase())) { console.log(`⏭  skip   ${t.name} — already exists`); skipped++; continue; }
    const body = { name: t.name, category_id: catId(t.category), facility_type: t.facility_type, trigger_event: t.trigger_event, blocks_release: t.blocks_release, recurrence_nights: t.recurrence_nights || 0, steps: t.steps };
    const res = await api('POST', `${P}/checklists/templates`, body);
    if (res.status === 201 && res.data?.id) { console.log(`✅ create ${t.name}  (${t.facility_type}/${t.trigger_event}, ${t.steps.length} steps)`); created++; }
    else if (res.status === 403) { console.error(`❌ ${t.name} — need OWNER role (403)`); failed++; }
    else { console.error(`❌ ${t.name} — HTTP ${res.status}: ${JSON.stringify(res.data)}`); failed++; }
  }

  console.log(`\n═══ ${created} created, ${skipped} skipped, ${failed} failed ═══`);
  console.log('Check-out checklists (PMS - Check-Out / Event Hall - Check-Out) already exist as system templates.');
  console.log('All new templates apply to ALL rooms/halls of their type by default — target specific rooms/halls from the template’s “Applies to” panel if needed.\n');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
