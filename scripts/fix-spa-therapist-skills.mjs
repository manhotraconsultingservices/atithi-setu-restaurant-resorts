/**
 * fix-spa-therapist-skills.mjs
 * One-shot fix: assigns correct service skills to RESTO-1003 therapists.
 * Root cause: seed-spa-demo.mjs used PUT /therapists/:id/services but the
 * server only had POST, so the PUT returned 404 silently → no skills stored
 * → findAvailableSlots returned empty (ts.service_id IS NOT NULL always false).
 *
 * Run: node scripts/fix-spa-therapist-skills.mjs --server https://erp.atithi-setu.com
 */
import https from 'https';
import http from 'http';

const SERVER = process.argv.includes('--server')
  ? process.argv[process.argv.indexOf('--server') + 1]
  : 'https://erp.atithi-setu.com';
const REST_ID = 'RESTO-1003';
const ADM_LOGIN = 'ADMIN-ANKUSH';
const ADM_PWD   = 'admin123';

const url = new URL(SERVER);
const isHttps = url.protocol === 'https:';
const mod = isHttps ? https : http;
let token = '';

function req(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = mod.request(
      { hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path, method, headers, rejectUnauthorized: false },
      res => {
        let b = '';
        res.on('data', d => b += d);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(b) }); }
          catch { resolve({ status: res.statusCode, body: b }); }
        });
      }
    );
    r.on('error', e => resolve({ status: 0, body: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

async function api(method, path, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await req(method, `/api/restaurant/${REST_ID}${path}`, body);
    if (r.status === 429) { await sleep(2000 + attempt * 1000); continue; }
    return r;
  }
  return req(method, `/api/restaurant/${REST_ID}${path}`, body);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Same skill mapping as seed-spa-demo.mjs
const THERAPIST_SKILLS = {
  'Priya Sharma':  ['Swedish Massage', 'Deep Tissue Massage', 'Aromatherapy Massage', 'Hot Stone Massage', 'Indian Head Massage', 'Express Back Massage'],
  'Rohan Mehta':   ['Deep Tissue Massage', 'Hot Stone Massage', 'Body Scrub & Wrap', 'Signature Body Wrap', 'Foot Reflexology', 'Sauna Session', 'Express Back Massage'],
  'Anjali Nair':   ['Classic Facial', 'Anti-Ageing Facial', 'Gold Facial', 'Hydrafacial', 'Bridal Glow Package', 'Hair Spa Treatment', 'Manicure & Pedicure'],
  'Vikram Patel':  ['Swedish Massage', "Couple's Massage", 'Aromatherapy Massage', 'Indian Head Massage', 'Foot Reflexology', 'Signature Body Wrap', 'Bridal Glow Package'],
};

async function main() {
  console.log('\n═══ [0] Auth ═══');
  const loginR = await req('POST', '/api/auth/login', { loginId: ADM_LOGIN, password: ADM_PWD, restaurantId: REST_ID });
  token = loginR.body.token;
  if (!token) { console.error('Login failed', loginR.body); process.exit(1); }
  console.log('  ✓ Logged in');

  console.log('\n═══ [1] Load services ═══');
  const svcR = await api('GET', '/spa/services');
  const allSvcs = Array.isArray(svcR.body) ? svcR.body : [];
  const svcMap = Object.fromEntries(allSvcs.map(s => [s.name, s]));
  console.log(`  ✓ ${allSvcs.length} services`);

  console.log('\n═══ [2] Load therapists ═══');
  const thrR = await api('GET', '/spa/therapists');
  const allThr = Array.isArray(thrR.body) ? thrR.body : [];
  console.log(`  ✓ ${allThr.length} therapists`);

  console.log('\n═══ [3] Assign skills via POST (correct method) ═══');
  for (const thr of allThr) {
    const skillNames = THERAPIST_SKILLS[thr.display_name];
    if (!skillNames) { console.log(`  ~ ${thr.display_name}: no skill mapping, skipping`); continue; }
    const svcIds = skillNames.map(n => svcMap[n]?.id).filter(Boolean);
    if (svcIds.length === 0) { console.log(`  ✗ ${thr.display_name}: no matching service IDs found`); continue; }
    const r = await api('POST', `/spa/therapists/${thr.id}/services`, { service_ids: svcIds });
    if (r.status === 200) {
      console.log(`  ✓ ${thr.display_name}: ${svcIds.length} skills assigned`);
    } else {
      console.error(`  ✗ ${thr.display_name}: HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 100));
    }
    await sleep(300);
  }

  console.log('\n═══ [4] Verify availability ═══');
  // Find a massage service and check today
  const testSvc = allSvcs.find(s => s.name === 'Swedish Massage') || allSvcs[0];
  if (!testSvc) { console.log('  ~ No services to test'); return; }
  const today = new Date().toISOString().slice(0, 10);
  const avR = await req('GET', `/api/public/restaurant/${REST_ID}/spa/availability?service_id=${testSvc.id}&date=${today}`);
  const slots = avR.body?.slots || [];
  if (slots.length > 0) {
    console.log(`  ✓ Availability working! ${slots.length} slots for "${testSvc.name}" on ${today}`);
    console.log(`    First slot: ${slots[0].start_at} with ${slots[0].therapist_name}`);
  } else {
    console.log(`  ~ ${slots.length} slots for "${testSvc.name}" on ${today} (${avR.status})`);
    console.log('    Possible causes: no therapists scheduled for this weekday, or all slots blocked by existing appointments');
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
