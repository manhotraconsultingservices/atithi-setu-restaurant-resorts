/**
 * seed-spa-demo.mjs
 * Production-grade demo data for Serene Touch Spa @ Vivek's Cafe (RESTO-1003)
 * Run: node scripts/seed-spa-demo.mjs --server https://erp.atithi-setu.com
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
  // Retry once on 429 after a pause
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await req(method, `/api/restaurant/${REST_ID}${path}`, body);
    if (r.status === 429) { await sleep(2000 + attempt * 1000); continue; }
    return r;
  }
  return req(method, `/api/restaurant/${REST_ID}${path}`, body);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function ok(label, r, expectStatus = [200, 201]) {
  const pass = Array.isArray(expectStatus) ? expectStatus.includes(r.status) : r.status === expectStatus;
  if (!pass) {
    console.error(`  ✗ ${label} → HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200));
    return null;
  }
  console.log(`  ✓ ${label}`);
  return r.body;
}

// Returns ISO datetime string offset from now
function daysAgo(d, hourOfDay = 11, minuteOfDay = 0) {
  const dt = new Date();
  dt.setDate(dt.getDate() - d);
  dt.setHours(hourOfDay, minuteOfDay, 0, 0);
  return dt.toISOString();
}
function daysFromNow(d, hourOfDay = 11, minuteOfDay = 0) {
  const dt = new Date();
  dt.setDate(dt.getDate() + d);
  dt.setHours(hourOfDay, minuteOfDay, 0, 0);
  return dt.toISOString();
}
function addMinutes(iso, mins) {
  return new Date(new Date(iso).getTime() + mins * 60000).toISOString();
}

// ──────────────────────────────────────────────────────────────────────────────
async function main() {
  // ── AUTH ──────────────────────────────────────────────────────────────────
  console.log('\n═══ [0] Auth ═══');
  const loginR = await req('POST', '/api/auth/login', { loginId: ADM_LOGIN, password: ADM_PWD, restaurantId: REST_ID });
  token = loginR.body.token;
  if (!token) { console.error('Login failed', loginR.body); process.exit(1); }
  console.log('  ✓ Logged in as', ADM_LOGIN);

  // ── FETCH EXISTING SERVICES ──────────────────────────────────────────────
  console.log('\n═══ [1] Load existing services ═══');
  const svcR = await api('GET', '/spa/services');
  const existingSvcs = Array.isArray(svcR.body) ? svcR.body : [];
  const svcByName = Object.fromEntries(existingSvcs.map(s => [s.name, s]));
  console.log(`  ✓ ${existingSvcs.length} existing services loaded`);

  // ── UPDATE EXISTING SERVICES with better descriptions + add new ones ──────
  console.log('\n═══ [2] Enrich service catalog ═══');

  // Update existing services with richer data
  const serviceUpdates = [
    { name: 'Swedish Massage',    gst_percent: 18, display_order: 1 },
    { name: 'Deep Tissue Massage', gst_percent: 18, display_order: 2 },
    { name: 'Aromatherapy Massage', gst_percent: 18, display_order: 3 },
    { name: 'Classic Facial',     gst_percent: 18, display_order: 5 },
    { name: 'Anti-Ageing Facial', gst_percent: 18, display_order: 6 },
    { name: 'Body Scrub & Wrap',  gst_percent: 18, display_order: 8 },
    { name: 'Sauna Session',      gst_percent: 18, display_order: 10 },
    { name: 'Manicure & Pedicure', gst_percent: 18, display_order: 11 },
  ];
  for (const upd of serviceUpdates) {
    const existing = svcByName[upd.name];
    if (existing) {
      await api('PATCH', `/spa/services/${existing.id}`, upd);
    }
  }

  // New services to add
  const newServices = [
    { name: 'Hot Stone Massage',      category: 'MASSAGE', duration_min: 75, buffer_after_min: 15, price: 3800, gst_percent: 18, requires_room: true, requires_therapist: true, display_order: 4,
      description: 'Heated basalt stones melt away tension in deeper muscle layers' },
    { name: 'Couple\'s Massage',      category: 'MASSAGE', duration_min: 60, buffer_after_min: 15, price: 5500, gst_percent: 18, requires_room: true, requires_therapist: true, display_order: 3,
      description: 'Simultaneous relaxation session for two, side by side in our Couple\'s Suite' },
    { name: 'Gold Facial',            category: 'FACIAL',  duration_min: 60, buffer_after_min: 10, price: 2800, gst_percent: 18, requires_room: true, requires_therapist: true, display_order: 7,
      description: '24K gold-infused treatment for radiance and skin firming' },
    { name: 'Hydrafacial',            category: 'FACIAL',  duration_min: 60, buffer_after_min: 10, price: 4500, gst_percent: 18, requires_room: true, requires_therapist: true, display_order: 8,
      description: 'Vortex-fusion hydra-dermabrasion — cleanse, extract, hydrate' },
    { name: 'Signature Body Wrap',    category: 'BODY',    duration_min: 75, buffer_after_min: 15, price: 4200, gst_percent: 18, requires_room: true, requires_therapist: true, display_order: 9,
      description: 'Nourishing mud or herbal wrap followed by a light moisturising massage' },
    { name: 'Indian Head Massage',    category: 'MASSAGE', duration_min: 45, buffer_after_min: 10, price: 1800, gst_percent: 18, requires_room: true, requires_therapist: true, display_order: 5,
      description: 'Champi — traditional scalp, neck and shoulder stress release' },
    { name: 'Foot Reflexology',       category: 'BODY',    duration_min: 45, buffer_after_min: 10, price: 1500, gst_percent: 18, requires_room: true, requires_therapist: true, display_order: 10,
      description: 'Pressure-point therapy on the feet to restore whole-body balance' },
    { name: 'Hair Spa Treatment',     category: 'SALON',   duration_min: 60, buffer_after_min: 10, price: 1800, gst_percent: 18, requires_room: true, requires_therapist: true, display_order: 12,
      description: 'Deep conditioning, scalp massage, and steam treatment for lustrous hair' },
    { name: 'Bridal Glow Package',   category: 'FACIAL',  duration_min: 120, buffer_after_min: 15, price: 8500, gst_percent: 18, requires_room: true, requires_therapist: true, display_order: 13,
      description: 'Pre-bridal 2-hour ritual: facial + head massage + manicure' },
    { name: 'Express Back Massage',   category: 'MASSAGE', duration_min: 30, buffer_after_min: 10, price: 1200, gst_percent: 18, requires_room: true, requires_therapist: true, display_order: 6,
      description: 'Quick stress-buster targeting the upper back, shoulders and neck' },
  ];

  const addedSvcs = {};
  for (const svc of newServices) {
    if (!svcByName[svc.name]) {
      const r = await api('POST', '/spa/services', svc);
      if (r.status === 201) { addedSvcs[svc.name] = r.body; console.log(`  ✓ + ${svc.name}`); }
      else console.log(`  ~ ${svc.name} skipped (${r.status})`);
    } else {
      addedSvcs[svc.name] = svcByName[svc.name];
      console.log(`  ~ ${svc.name} already exists`);
    }
  }

  // Reload full service list
  const allSvcsR = await api('GET', '/spa/services');
  const allSvcs = Array.isArray(allSvcsR.body) ? allSvcsR.body : [];
  const svcMap = Object.fromEntries(allSvcs.map(s => [s.name, s]));
  console.log(`  ✓ Total services: ${allSvcs.length}`);

  // ── RESOURCES (CABINS + COUPLE'S SUITE) ──────────────────────────────────
  console.log('\n═══ [3] Treatment rooms / resources ═══');
  const existingResR = await api('GET', '/spa/resources');
  const existingRes = Array.isArray(existingResR.body) ? existingResR.body : [];
  const resByName = Object.fromEntries(existingRes.map(r => [r.name, r]));

  const resources = [
    { name: 'Cabin 1 — Bliss Room',   resource_type: 'CABIN', capacity: 1 },
    { name: 'Cabin 2 — Serenity Room', resource_type: 'CABIN', capacity: 1 },
    { name: 'Cabin 3 — Harmony Room', resource_type: 'CABIN', capacity: 1 },
    { name: 'Couple\'s Suite',         resource_type: 'CABIN', capacity: 2 },
    { name: 'Sauna Room',              resource_type: 'SAUNA', capacity: 4 },
  ];

  const resMap = {};
  for (const res of resources) {
    // Update names of existing cabins to richer names
    if (res.name === 'Cabin 1 — Bliss Room' && resByName['Cabin 1']) {
      await api('PATCH', `/spa/resources/${resByName['Cabin 1'].id}`, { name: res.name });
      resMap[res.name] = resByName['Cabin 1'];
      console.log(`  ✓ Renamed: Cabin 1 → ${res.name}`);
    } else if (res.name === 'Cabin 2 — Serenity Room' && resByName['Cabin 2']) {
      await api('PATCH', `/spa/resources/${resByName['Cabin 2'].id}`, { name: res.name });
      resMap[res.name] = resByName['Cabin 2'];
      console.log(`  ✓ Renamed: Cabin 2 → ${res.name}`);
    } else if (res.name === 'Cabin 3 — Harmony Room' && resByName['Cabin 3']) {
      await api('PATCH', `/spa/resources/${resByName['Cabin 3'].id}`, { name: res.name });
      resMap[res.name] = resByName['Cabin 3'];
      console.log(`  ✓ Renamed: Cabin 3 → ${res.name}`);
    } else if (!resByName[res.name] && !Object.values(resByName).find(r => r.name === res.name)) {
      const r = await api('POST', '/spa/resources', { ...res, is_active: true });
      if (r.status === 201) { resMap[res.name] = r.body; console.log(`  ✓ + ${res.name}`); }
    } else {
      const found = resByName[res.name] || Object.values(resByName).find(r => r.name === res.name);
      resMap[res.name] = found;
      console.log(`  ~ ${res.name} exists`);
    }
  }

  // Reload resources after rename
  const resR2 = await api('GET', '/spa/resources');
  const allRes = Array.isArray(resR2.body) ? resR2.body : [];
  const cabin1 = allRes.find(r => r.name.includes('Bliss') || r.name.includes('Cabin 1')) || allRes[0];
  const cabin2 = allRes.find(r => r.name.includes('Serenity') || r.name.includes('Cabin 2')) || allRes[1];
  const cabin3 = allRes.find(r => r.name.includes('Harmony') || r.name.includes('Cabin 3')) || allRes[2];
  const couplesSuite = allRes.find(r => r.name.includes("Couple"));
  const saunaRoom = allRes.find(r => r.name.includes("Sauna"));
  console.log(`  ✓ ${allRes.length} rooms loaded`);

  // ── THERAPISTS ────────────────────────────────────────────────────────────
  console.log('\n═══ [4] Therapists ═══');
  const existingThrR = await api('GET', '/spa/therapists');
  const existingThr = Array.isArray(existingThrR.body) ? existingThrR.body : [];
  const thrByName = Object.fromEntries(existingThr.map(t => [t.display_name, t]));

  const therapistDefs = [
    {
      display_name: 'Priya Sharma',
      bio: 'Certified Ayurvedic therapist with 8 years of experience in Swedish, hot stone and aromatherapy massage. Specialises in deep relaxation and stress relief.',
      commission_pct_override: 30,
      skills: ['Swedish Massage', 'Deep Tissue Massage', 'Aromatherapy Massage', 'Hot Stone Massage', 'Indian Head Massage', 'Express Back Massage'],
      schedule: [1,2,3,4,5,6], // Mon–Sat
      hours: { start: '09:00', end: '18:00' },
    },
    {
      display_name: 'Rohan Mehta',
      bio: 'Sports massage therapist and wellness coach with 6 years of experience. Expert in deep tissue, reflexology and therapeutic body treatments.',
      commission_pct_override: 28,
      skills: ['Deep Tissue Massage', 'Hot Stone Massage', 'Body Scrub & Wrap', 'Signature Body Wrap', 'Foot Reflexology', 'Sauna Session', 'Express Back Massage'],
      schedule: [1,2,3,4,5,6],
      hours: { start: '10:00', end: '19:00' },
    },
    {
      display_name: 'Anjali Nair',
      bio: 'Licensed aesthetician and beauty therapist with 7 years specialising in skin care, facials and salon treatments. Trained in Korean skincare protocols.',
      commission_pct_override: 30,
      skills: ['Classic Facial', 'Anti-Ageing Facial', 'Gold Facial', 'Hydrafacial', 'Bridal Glow Package', 'Hair Spa Treatment', 'Manicure & Pedicure'],
      schedule: [2,3,4,5,6,0], // Tue–Sun (day off Monday)
      hours: { start: '09:30', end: '18:30' },
    },
    {
      display_name: 'Vikram Patel',
      bio: 'Senior therapist with 10 years of experience across massage, body and couples therapies. Known for the signature Couple\'s Massage experience.',
      commission_pct_override: 35,
      skills: ['Swedish Massage', 'Couple\'s Massage', 'Aromatherapy Massage', 'Indian Head Massage', 'Foot Reflexology', 'Signature Body Wrap', 'Bridal Glow Package'],
      schedule: [1,2,4,5,6,0], // Mon, Tue, Thu–Sun (day off Wed)
      hours: { start: '09:00', end: '19:00' },
    },
  ];

  const thrMap = {};
  for (const def of therapistDefs) {
    let thr = thrByName[def.display_name];
    if (!thr) {
      const r = await api('POST', '/spa/therapists', { display_name: def.display_name, bio: def.bio, commission_pct_override: def.commission_pct_override });
      if (r.status === 201) { thr = r.body; console.log(`  ✓ + ${def.display_name}`); }
      else { console.log(`  ✗ ${def.display_name} failed: ${JSON.stringify(r.body)}`); continue; }
    } else {
      console.log(`  ~ ${def.display_name} exists`);
    }
    thrMap[def.display_name] = thr;

    // Assign skills
    const svcIds = def.skills.map(n => svcMap[n]?.id).filter(Boolean);
    await api('PUT', `/spa/therapists/${thr.id}/services`, { service_ids: svcIds });

    // Assign schedules (skip if already has schedules)
    const existSchedR = await api('GET', `/spa/therapists/${thr.id}/schedules`);
    if (!Array.isArray(existSchedR.body) || existSchedR.body.length === 0) {
      for (const weekday of def.schedule) {
        await api('POST', `/spa/therapists/${thr.id}/schedules`, { weekday, start_time: def.hours.start, end_time: def.hours.end });
      }
      console.log(`    → ${def.schedule.length} schedule days set`);
    } else {
      console.log(`    → schedules already exist`);
    }
  }

  // ── PACKAGES ──────────────────────────────────────────────────────────────
  console.log('\n═══ [5] Prepaid packages ═══');
  const existPkgR = await api('GET', '/spa/packages');
  const existPkgs = Array.isArray(existPkgR.body) ? existPkgR.body : [];
  const pkgByName = Object.fromEntries(existPkgs.map(p => [p.name, p]));

  const packageDefs = [
    { name: '5 Massage Series',     service_id: svcMap['Swedish Massage']?.id,   total_sessions: 5,  price: 11000, validity_days: 180, gst_percent: 18 },
    { name: '10 Massage Value Pack', service_id: svcMap['Swedish Massage']?.id,   total_sessions: 10, price: 20000, validity_days: 365, gst_percent: 18 },
    { name: 'Glow Facial Pack',      service_id: svcMap['Classic Facial']?.id,    total_sessions: 5,  price: 7500,  validity_days: 120, gst_percent: 18 },
    { name: 'Anti-Ageing Bundle',    service_id: svcMap['Anti-Ageing Facial']?.id, total_sessions: 4, price: 10000, validity_days: 120, gst_percent: 18 },
    { name: 'Hydrafacial x4',        service_id: svcMap['Hydrafacial']?.id,       total_sessions: 4,  price: 14000, validity_days: 90,  gst_percent: 18 },
    { name: 'Body Detox Pack',       service_id: svcMap['Body Scrub & Wrap']?.id, total_sessions: 4,  price: 12500, validity_days: 90,  gst_percent: 18 },
    { name: 'Deep Tissue Intensive', service_id: svcMap['Deep Tissue Massage']?.id, total_sessions: 6, price: 18000, validity_days: 180, gst_percent: 18 },
    { name: 'Wellness Any-10',       service_id: null, total_sessions: 10, price: 22000, validity_days: 365, gst_percent: 18 }, // redeemable for any service
  ];

  for (const pkg of packageDefs) {
    if (!pkgByName[pkg.name]) {
      const r = await api('POST', '/spa/packages', pkg);
      if (r.status === 201) console.log(`  ✓ + ${pkg.name}`);
      else console.log(`  ✗ ${pkg.name} (${r.status})`);
    } else {
      console.log(`  ~ ${pkg.name} exists`);
    }
  }

  // ── MEMBERSHIP PLANS ─────────────────────────────────────────────────────
  console.log('\n═══ [6] Membership plans ═══');
  const existMemR = await api('GET', '/spa/memberships');
  const existMems = Array.isArray(existMemR.body) ? existMemR.body : [];
  const memByTier = Object.fromEntries(existMems.map(m => [m.tier, m]));

  const membershipDefs = [
    {
      name: 'Silver Wellness',
      tier: 'SILVER',
      monthly_fee: 999,
      gst_percent: 18,
      benefits: { discount_pct: 10, free_services_per_month: 0, description: '10% off all services every visit' },
    },
    {
      name: 'Gold Wellness',
      tier: 'GOLD',
      monthly_fee: 1999,
      gst_percent: 18,
      benefits: { discount_pct: 20, free_services_per_month: 1, included_service_ids: [], description: '20% off + 1 complimentary Swedish Massage per month' },
    },
    {
      name: 'Platinum Wellness',
      tier: 'PLATINUM',
      monthly_fee: 3999,
      gst_percent: 18,
      benefits: { discount_pct: 30, free_services_per_month: 2, included_service_ids: [], description: '30% off + 2 complimentary services/month + priority booking' },
    },
  ];
  // Update included_service_ids for GOLD/PLATINUM
  if (svcMap['Swedish Massage']) {
    membershipDefs[1].benefits.included_service_ids = [svcMap['Swedish Massage'].id];
    membershipDefs[2].benefits.included_service_ids = [svcMap['Swedish Massage'].id, svcMap['Classic Facial']?.id].filter(Boolean);
  }

  for (const mem of membershipDefs) {
    if (!memByTier[mem.tier]) {
      const r = await api('POST', '/spa/memberships', mem);
      if (r.status === 201) console.log(`  ✓ + ${mem.tier} — ₹${mem.monthly_fee}/mo`);
      else console.log(`  ✗ ${mem.tier} (${r.status})`, JSON.stringify(r.body));
    } else {
      console.log(`  ~ ${mem.tier} exists`);
    }
  }

  // ── CLIENTS ───────────────────────────────────────────────────────────────
  console.log('\n═══ [7] Clients / CRM ═══');
  const existClientR = await api('GET', '/spa/clients');
  const existClients = Array.isArray(existClientR.body) ? existClientR.body : [];
  const clientByPhone = Object.fromEntries(existClients.map(c => [c.phone, c]));

  const clientDefs = [
    { name: 'Priya Menon',       phone: '9876543201', email: 'priya.menon@email.com',     gender: 'F', preferences: 'Aromatherapy, soft music. Allergic to lavender.',       tags: 'VIP,Regular' },
    { name: 'Ravi Sharma',       phone: '9876543202', email: 'ravi.sharma@corp.com',       gender: 'M', preferences: 'Deep tissue, firm pressure. Sports recovery.',           tags: 'Corporate,Regular' },
    { name: 'Sunita Kapoor',     phone: '9876543203', email: 'sunita.k@gmail.com',         gender: 'F', preferences: 'Facial specialist — prefers Anjali. Sensitive skin.',    tags: 'VIP' },
    { name: 'Aditya Verma',      phone: '9876543204', email: 'aditya.v@startup.io',        gender: 'M', preferences: 'Quick sessions, back massage. Time-sensitive.',          tags: 'Corporate' },
    { name: 'Neha Joshi',        phone: '9876543205', email: 'neha.j@yahoo.com',           gender: 'F', preferences: 'Hot stone and aromatherapy. Prefers Priya.',             tags: 'Regular' },
    { name: 'Arjun Nair',        phone: '9876543206', email: 'arjun.nair@gmail.com',       gender: 'M', preferences: 'Sauna + deep tissue combo.',                             tags: 'Regular' },
    { name: 'Meera Pillai',      phone: '9876543207', email: 'meera.p@outlook.com',        gender: 'F', preferences: 'Hydrafacial monthly. Prefers morning slots.',            tags: 'VIP,Regular' },
    { name: 'Rahul Gupta',       phone: '9876543208', email: 'rahul.g@businessmail.com',   gender: 'M', preferences: 'Couple\'s massage with spouse on weekends.',             tags: 'Corporate' },
    { name: 'Ankita Singh',      phone: '9876543209', email: 'ankita.s@gmail.com',         gender: 'F', preferences: 'Pre-bridal package. Getting married in Dec.',            tags: 'Bridal' },
    { name: 'Sanjay Khanna',     phone: '9876543210', email: 'sanjay.k@khannacorp.com',    gender: 'M', preferences: 'Monthly membership. Foot reflexology.',                  tags: 'Member,VIP' },
    { name: 'Lakshmi Reddy',     phone: '9876543211', email: 'lakshmi.r@email.com',        gender: 'F', preferences: 'Body wraps, prefer weekday mornings.',                   tags: 'Regular' },
    { name: 'Kiran Malhotra',    phone: '9876543212', email: 'kiran.m@gmail.com',          gender: 'M', preferences: 'Indian head massage. Office stress relief.',              tags: 'Corporate,New' },
    { name: 'Divya Iyer',        phone: '9876543213', email: 'divya.iyer@techfirm.com',    gender: 'F', preferences: 'Anti-ageing facial + hair spa combo.',                   tags: 'Regular' },
    { name: 'Suresh Patel',      phone: '9876543214', email: 'suresh.p@gmail.com',         gender: 'M', preferences: 'Swedish massage every fortnight. Very loyal client.',    tags: 'VIP,Regular' },
    { name: 'Pooja Tiwari',      phone: '9876543215', email: 'pooja.t@outlook.com',        gender: 'F', preferences: 'Manicure + facial combo. Prefers Anjali.',              tags: 'Regular' },
  ];

  const clientMap = {};
  for (const c of clientDefs) {
    if (!clientByPhone[c.phone]) {
      const r = await api('POST', '/spa/clients', c);
      if (r.status === 201) { clientMap[c.phone] = r.body; console.log(`  ✓ + ${c.name}`); }
      else console.log(`  ✗ ${c.name} (${r.status})`);
    } else {
      clientMap[c.phone] = clientByPhone[c.phone];
      console.log(`  ~ ${c.name} exists`);
    }
  }

  // Reload all clients (includes pre-existing ones that may not be in clientMap)
  const allClientsR = await api('GET', '/spa/clients');
  const allClients = Array.isArray(allClientsR.body) ? allClientsR.body : [];
  allClients.forEach(c => { clientMap[c.phone] = c; });
  console.log(`  ✓ Total clients after reload: ${allClients.length}`);

  // Helper to get client by phone
  const cl = (phone) => clientMap[phone];

  // ── PAST COMPLETED APPOINTMENTS (history for reports) ────────────────────
  console.log('\n═══ [8] Historical appointments (last 30 days) ═══');

  const thrPriya  = thrMap['Priya Sharma'];
  const thrRohan  = thrMap['Rohan Mehta'];
  const thrAnjali = thrMap['Anjali Nair'];
  const thrVikram = thrMap['Vikram Patel'];

  // If any therapist failed to create, skip
  if (!thrPriya || !thrRohan || !thrAnjali || !thrVikram) {
    console.log('  ! Some therapists missing — skipping history');
  } else {

    const pastAppts = [
      // 28 days ago
      { client_id: cl('9876543201')?.id, service_id: svcMap['Swedish Massage']?.id, therapist_id: thrPriya.id, resource_id: cabin1?.id, start_at: daysAgo(28, 10, 0),  price: 2500, label: 'Priya M — Swedish Massage' },
      { client_id: cl('9876543202')?.id, service_id: svcMap['Deep Tissue Massage']?.id, therapist_id: thrRohan.id, resource_id: cabin2?.id, start_at: daysAgo(28, 11, 30), price: 3500, label: 'Ravi S — Deep Tissue' },
      // 25 days ago
      { client_id: cl('9876543207')?.id, service_id: svcMap['Hydrafacial']?.id,     therapist_id: thrAnjali.id, resource_id: cabin3?.id, start_at: daysAgo(25, 9, 30),  price: 4500, label: 'Meera P — Hydrafacial' },
      { client_id: cl('9876543214')?.id, service_id: svcMap['Swedish Massage']?.id, therapist_id: thrPriya.id,  resource_id: cabin1?.id, start_at: daysAgo(25, 14, 0),  price: 2500, label: 'Suresh P — Swedish' },
      // 21 days ago
      { client_id: cl('9876543203')?.id, service_id: svcMap['Anti-Ageing Facial']?.id, therapist_id: thrAnjali.id, resource_id: cabin2?.id, start_at: daysAgo(21, 10, 0), price: 3200, label: 'Sunita K — Anti-Ageing Facial' },
      { client_id: cl('9876543205')?.id, service_id: svcMap['Hot Stone Massage']?.id, therapist_id: thrPriya.id,  resource_id: cabin1?.id, start_at: daysAgo(21, 11, 0),  price: 3800, label: 'Neha J — Hot Stone' },
      { client_id: cl('9876543206')?.id, service_id: svcMap['Sauna Session']?.id, therapist_id: thrRohan.id, resource_id: saunaRoom?.id || cabin3?.id, start_at: daysAgo(21, 16, 0), price: 900, label: 'Arjun N — Sauna' },
      // 18 days ago
      { client_id: cl('9876543210')?.id, service_id: svcMap['Foot Reflexology']?.id, therapist_id: thrRohan.id, resource_id: cabin2?.id, start_at: daysAgo(18, 9, 0),   price: 1500, label: 'Sanjay K — Reflexology' },
      { client_id: cl('9876543211')?.id, service_id: svcMap['Signature Body Wrap']?.id, therapist_id: thrRohan.id, resource_id: cabin3?.id, start_at: daysAgo(18, 11, 0), price: 4200, label: 'Lakshmi R — Body Wrap' },
      // 14 days ago
      { client_id: cl('9876543201')?.id, service_id: svcMap['Aromatherapy Massage']?.id, therapist_id: thrPriya.id, resource_id: cabin1?.id, start_at: daysAgo(14, 10, 0), price: 2800, label: 'Priya M — Aromatherapy' },
      { client_id: cl('9876543213')?.id, service_id: svcMap['Hair Spa Treatment']?.id,  therapist_id: thrAnjali.id, resource_id: cabin2?.id, start_at: daysAgo(14, 14, 0), price: 1800, label: 'Divya I — Hair Spa' },
      { client_id: cl('9876543204')?.id, service_id: svcMap['Express Back Massage']?.id, therapist_id: thrVikram.id, resource_id: cabin3?.id, start_at: daysAgo(14, 12, 30), price: 1200, label: 'Aditya V — Express Back' },
      // 10 days ago
      { client_id: cl('9876543208')?.id, service_id: svcMap["Couple's Massage"]?.id, therapist_id: thrVikram.id, resource_id: couplesSuite?.id || cabin1?.id, start_at: daysAgo(10, 11, 0), price: 5500, label: 'Rahul G — Couple Massage' },
      { client_id: cl('9876543215')?.id, service_id: svcMap['Manicure & Pedicure']?.id, therapist_id: thrAnjali.id, resource_id: cabin2?.id, start_at: daysAgo(10, 9, 0),   price: 1500, label: 'Pooja T — Mani-Pedi' },
      { client_id: cl('9876543214')?.id, service_id: svcMap['Deep Tissue Massage']?.id, therapist_id: thrRohan.id, resource_id: cabin3?.id, start_at: daysAgo(10, 15, 0), price: 3500, label: 'Suresh P — Deep Tissue' },
      // 7 days ago
      { client_id: cl('9876543207')?.id, service_id: svcMap['Gold Facial']?.id, therapist_id: thrAnjali.id, resource_id: cabin1?.id, start_at: daysAgo(7, 10, 0),  price: 2800, label: 'Meera P — Gold Facial' },
      { client_id: cl('9876543202')?.id, service_id: svcMap['Body Scrub & Wrap']?.id, therapist_id: thrRohan.id, resource_id: cabin2?.id, start_at: daysAgo(7, 14, 0), price: 3800, label: 'Ravi S — Body Scrub' },
      { client_id: cl('9876543212')?.id, service_id: svcMap['Indian Head Massage']?.id, therapist_id: thrVikram.id, resource_id: cabin3?.id, start_at: daysAgo(7, 11, 30), price: 1800, label: 'Kiran M — Head Massage' },
      // 3 days ago
      { client_id: cl('9876543201')?.id, service_id: svcMap['Swedish Massage']?.id,     therapist_id: thrPriya.id,  resource_id: cabin1?.id, start_at: daysAgo(3, 10, 0),  price: 2500, label: 'Priya M — Swedish #3' },
      { client_id: cl('9876543203')?.id, service_id: svcMap['Classic Facial']?.id,      therapist_id: thrAnjali.id, resource_id: cabin2?.id, start_at: daysAgo(3, 11, 0),  price: 1800, label: 'Sunita K — Classic Facial' },
      { client_id: cl('9876543210')?.id, service_id: svcMap['Swedish Massage']?.id,     therapist_id: thrVikram.id, resource_id: cabin3?.id, start_at: daysAgo(3, 14, 0),  price: 2500, label: 'Sanjay K — Swedish' },
      // Yesterday
      { client_id: cl('9876543205')?.id, service_id: svcMap['Aromatherapy Massage']?.id, therapist_id: thrPriya.id,  resource_id: cabin1?.id, start_at: daysAgo(1, 10, 30), price: 2800, label: 'Neha J — Aromatherapy' },
      { client_id: cl('9876543209')?.id, service_id: svcMap['Bridal Glow Package']?.id, therapist_id: thrAnjali.id, resource_id: cabin2?.id, start_at: daysAgo(1, 13, 0),  price: 8500, label: 'Ankita S — Bridal Glow' },
    ];

    let created = 0, completed = 0;
    for (const appt of pastAppts) {
      if (!appt.client_id || !appt.service_id || !appt.therapist_id || !appt.resource_id) {
        console.log(`  ! Skipping ${appt.label} — missing IDs`);
        continue;
      }
      // Find service duration
      const svc = allSvcs.find(s => s.id === appt.service_id);
      const dur = svc?.duration_min || 60;
      const end_at = addMinutes(appt.start_at, dur + (svc?.buffer_after_min || 0));

      // Create appointment
      const aR = await api('POST', '/spa/appointments', {
        client_id: appt.client_id,
        service_id: appt.service_id,
        therapist_id: appt.therapist_id,
        resource_id: appt.resource_id,
        start_at: appt.start_at,
        end_at,
        booking_source: 'WALK_IN',
      });
      if (aR.status !== 201) {
        console.log(`  ✗ ${appt.label} — create failed (${aR.status})`);
        continue;
      }
      created++;
      const aid = aR.body.id;

      // Run lifecycle: confirm → check-in → complete
      await sleep(300);
      await api('POST', `/spa/appointments/${aid}/confirm`);
      await api('POST', `/spa/appointments/${aid}/check-in`);
      const completeR = await api('POST', `/spa/appointments/${aid}/complete`);
      if (completeR.status === 200) {
        // Checkout + payment
        const coR = await api('POST', `/spa/appointments/${aid}/checkout`, { payment_method: 'UPI', tip: 0 });
        if (coR.status === 200) {
          completed++;
          process.stdout.write(`  ✓ ${appt.label}\n`);
        } else {
          process.stdout.write(`  ~ ${appt.label} — completed (checkout ${coR.status})\n`);
          completed++;
        }
      } else {
        process.stdout.write(`  ~ ${appt.label} — created (complete ${completeR.status})\n`);
      }
      await sleep(400);
    }
    console.log(`  → ${created} created, ${completed} fully checked-out`);
  }

  // ── TODAY'S SCHEDULE (upcoming appointments for demo) ────────────────────
  console.log('\n═══ [9] Today\'s live schedule ═══');

  const todayAppts = [
    { client_id: cl('9876543201')?.id, service_id: svcMap['Hot Stone Massage']?.id,     therapist_id: thrPriya?.id,  resource_id: cabin1?.id, start_hour: 10, start_min: 0,  status_target: 'CONFIRMED', label: 'Priya M — Hot Stone (Confirmed)' },
    { client_id: cl('9876543207')?.id, service_id: svcMap['Hydrafacial']?.id,            therapist_id: thrAnjali?.id, resource_id: cabin2?.id, start_hour: 10, start_min: 0,  status_target: 'CHECKED_IN', label: 'Meera P — Hydrafacial (In Progress)' },
    { client_id: cl('9876543202')?.id, service_id: svcMap['Deep Tissue Massage']?.id,   therapist_id: thrRohan?.id,  resource_id: cabin3?.id, start_hour: 11, start_min: 30, status_target: 'BOOKED', label: 'Ravi S — Deep Tissue (Booked)' },
    { client_id: cl('9876543210')?.id, service_id: svcMap['Foot Reflexology']?.id,       therapist_id: thrVikram?.id, resource_id: cabin1?.id, start_hour: 14, start_min: 0,  status_target: 'BOOKED', label: 'Sanjay K — Foot Reflexology (Booked)' },
    { client_id: cl('9876543213')?.id, service_id: svcMap['Anti-Ageing Facial']?.id,    therapist_id: thrAnjali?.id, resource_id: cabin2?.id, start_hour: 15, start_min: 0,  status_target: 'BOOKED', label: 'Divya I — Anti-Ageing Facial (Booked)' },
    { client_id: cl('9876543214')?.id, service_id: svcMap['Swedish Massage']?.id,        therapist_id: thrPriya?.id,  resource_id: cabin3?.id, start_hour: 16, start_min: 0,  status_target: 'BOOKED', label: 'Suresh P — Swedish (Booked)' },
  ];

  for (const appt of todayAppts) {
    if (!appt.client_id || !appt.service_id || !appt.therapist_id || !appt.resource_id) {
      console.log(`  ! Skipping ${appt.label}`); continue;
    }
    const svc = allSvcs.find(s => s.id === appt.service_id);
    const dur = svc?.duration_min || 60;
    const start_at = daysFromNow(0, appt.start_hour, appt.start_min);
    const end_at = addMinutes(start_at, dur + (svc?.buffer_after_min || 0));

    const aR = await api('POST', '/spa/appointments', {
      client_id: appt.client_id, service_id: appt.service_id,
      therapist_id: appt.therapist_id, resource_id: appt.resource_id,
      start_at, end_at, booking_source: 'WALK_IN',
    });
    if (aR.status !== 201) { console.log(`  ✗ ${appt.label} (${aR.status}) ${JSON.stringify(aR.body).slice(0,100)}`); continue; }
    const aid = aR.body.id;

    if (appt.status_target === 'CONFIRMED' || appt.status_target === 'CHECKED_IN') {
      await api('POST', `/spa/appointments/${aid}/confirm`);
    }
    if (appt.status_target === 'CHECKED_IN') {
      await api('POST', `/spa/appointments/${aid}/check-in`);
    }
    console.log(`  ✓ ${appt.label}`);
  }

  // ── TOMORROW'S ADVANCE BOOKINGS ───────────────────────────────────────────
  console.log('\n═══ [10] Tomorrow\'s bookings (advance) ═══');

  const tomorrowAppts = [
    { client_id: cl('9876543208')?.id, service_id: svcMap["Couple's Massage"]?.id, therapist_id: thrVikram?.id, resource_id: couplesSuite?.id || cabin1?.id, start_hour: 11, start_min: 0, label: "Rahul G — Couple's Massage" },
    { client_id: cl('9876543203')?.id, service_id: svcMap['Bridal Glow Package']?.id, therapist_id: thrAnjali?.id, resource_id: cabin2?.id, start_hour: 10, start_min: 0, label: "Sunita K — Bridal Glow" },
    { client_id: cl('9876543206')?.id, service_id: svcMap['Sauna Session']?.id,      therapist_id: thrRohan?.id,  resource_id: saunaRoom?.id || cabin3?.id, start_hour: 9, start_min: 0, label: "Arjun N — Sauna" },
    { client_id: cl('9876543211')?.id, service_id: svcMap['Signature Body Wrap']?.id, therapist_id: thrRohan?.id, resource_id: cabin3?.id, start_hour: 14, start_min: 0, label: "Lakshmi R — Body Wrap" },
    { client_id: cl('9876543215')?.id, service_id: svcMap['Gold Facial']?.id,         therapist_id: thrAnjali?.id, resource_id: cabin2?.id, start_hour: 16, start_min: 0, label: "Pooja T — Gold Facial" },
  ];

  for (const appt of tomorrowAppts) {
    if (!appt.client_id || !appt.service_id || !appt.therapist_id || !appt.resource_id) {
      console.log(`  ! Skipping ${appt.label}`); continue;
    }
    const svc = allSvcs.find(s => s.id === appt.service_id);
    const dur = svc?.duration_min || 60;
    const start_at = daysFromNow(1, appt.start_hour, appt.start_min);
    const end_at = addMinutes(start_at, dur + (svc?.buffer_after_min || 0));

    const aR = await api('POST', '/spa/appointments', {
      client_id: appt.client_id, service_id: appt.service_id,
      therapist_id: appt.therapist_id, resource_id: appt.resource_id,
      start_at, end_at, booking_source: 'WALK_IN',
    });
    if (aR.status === 201) { await api('POST', `/spa/appointments/${aR.body.id}/confirm`); console.log(`  ✓ ${appt.label}`); }
    else console.log(`  ✗ ${appt.label} (${aR.status}) ${JSON.stringify(aR.body).slice(0,100)}`);
  }

  // ── PACKAGE SUBSCRIPTIONS FOR KEY CLIENTS ────────────────────────────────
  console.log('\n═══ [11] Package subscriptions ═══');
  const allPkgR = await api('GET', '/spa/packages');
  const allPkgs = Array.isArray(allPkgR.body) ? allPkgR.body : [];
  const pkgMap = Object.fromEntries(allPkgs.map(p => [p.name, p]));

  const pkgSubs = [
    { client_id: cl('9876543201')?.id, pkg: '5 Massage Series',  label: 'Priya M' },
    { client_id: cl('9876543214')?.id, pkg: '5 Massage Series',  label: 'Suresh P' },
    { client_id: cl('9876543207')?.id, pkg: 'Hydrafacial x4',    label: 'Meera P' },
    { client_id: cl('9876543202')?.id, pkg: 'Deep Tissue Intensive', label: 'Ravi S' },
    { client_id: cl('9876543211')?.id, pkg: 'Body Detox Pack',   label: 'Lakshmi R' },
  ];
  for (const sub of pkgSubs) {
    const pkg = pkgMap[sub.pkg];
    if (!sub.client_id || !pkg) { console.log(`  ! ${sub.label} — missing refs`); continue; }
    const r = await api('POST', `/spa/clients/${sub.client_id}/packages`, { package_id: pkg.id, payment_method: 'CARD' });
    if (r.status === 201 || r.status === 200) console.log(`  ✓ ${sub.label} → ${sub.pkg}`);
    else console.log(`  ✗ ${sub.label} (${r.status}) ${JSON.stringify(r.body).slice(0,80)}`);
  }

  // ── MEMBERSHIP SUBSCRIPTIONS ──────────────────────────────────────────────
  console.log('\n═══ [12] Membership subscriptions ═══');
  const allMemR2 = await api('GET', '/spa/memberships');
  const allMems = Array.isArray(allMemR2.body) ? allMemR2.body : [];
  const memMap = Object.fromEntries(allMems.map(m => [m.tier, m]));

  const memSubs = [
    { client_id: cl('9876543210')?.id, tier: 'GOLD',     label: 'Sanjay K — GOLD' },
    { client_id: cl('9876543201')?.id, tier: 'SILVER',   label: 'Priya M — SILVER' },
    { client_id: cl('9876543207')?.id, tier: 'PLATINUM', label: 'Meera P — PLATINUM' },
    { client_id: cl('9876543203')?.id, tier: 'SILVER',   label: 'Sunita K — SILVER' },
  ];
  for (const sub of memSubs) {
    const mem = memMap[sub.tier];
    if (!sub.client_id || !mem) { console.log(`  ! ${sub.label} — missing refs`); continue; }
    const r = await api('POST', `/spa/clients/${sub.client_id}/memberships`, { plan_id: mem.id, payment_method: 'UPI' });
    if (r.status === 201 || r.status === 200) console.log(`  ✓ ${sub.label}`);
    else console.log(`  ✗ ${sub.label} (${r.status}) ${JSON.stringify(r.body).slice(0,80)}`);
  }

  // ── SUMMARY ───────────────────────────────────────────────────────────────
  console.log('\n═══ SEED COMPLETE ═══');
  const [sR, rR, tR, cR, pR, mR, aR] = await Promise.all([
    api('GET', '/spa/services'), api('GET', '/spa/resources'), api('GET', '/spa/therapists'),
    api('GET', '/spa/clients'), api('GET', '/spa/packages'), api('GET', '/spa/memberships'),
    api('GET', '/spa/appointments'),
  ]);
  console.log(`  Services: ${sR.body?.length || 0}`);
  console.log(`  Rooms:    ${rR.body?.length || 0}`);
  console.log(`  Therapists: ${tR.body?.length || 0}`);
  console.log(`  Clients:  ${cR.body?.length || 0}`);
  console.log(`  Packages: ${pR.body?.length || 0}`);
  console.log(`  Memberships: ${mR.body?.length || 0}`);
  console.log(`  Appointments: ${aR.body?.appointments?.length || aR.body?.length || 0}`);
  console.log('\n  Public booking URL: https://erp.atithi-setu.com/spa/RESTO-1003');
}

main().catch(e => { console.error(e); process.exit(1); });
