#!/usr/bin/env node
/**
 * Targeted probe — log in, GET /tariff, dump meal_plans + seasons.
 * Read-only. No bookings created.
 */

const BASE_URL      = process.env.LIVE_BASE_URL    || 'https://viveks-cafe.atithi-setu.com';
const LOGIN_ID      = process.env.LIVE_LOGIN_ID;
const PASSWORD      = process.env.LIVE_PASSWORD;
const RESTAURANT_ID = process.env.LIVE_RESTAURANT_ID;

if (!LOGIN_ID || !PASSWORD || !RESTAURANT_ID) {
  console.error('Set LIVE_LOGIN_ID, LIVE_PASSWORD, LIVE_RESTAURANT_ID');
  process.exit(1);
}

(async () => {
  // 1. Login
  console.log(`→ POST ${BASE_URL}/api/auth/owner/login`);
  const loginRes = await fetch(`${BASE_URL}/api/auth/owner/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: LOGIN_ID, password: PASSWORD }),
  });
  const loginBody = await loginRes.json();
  const token = loginBody.jwt_token || loginBody.token;
  if (!token) {
    console.error('Login failed:', JSON.stringify(loginBody, null, 2));
    process.exit(2);
  }
  console.log(`✓ Logged in as restaurantId=${loginBody.restaurantId || loginBody.restaurant?.id} role=${loginBody.role}`);

  // 2. Fetch tariff
  console.log(`\n→ GET ${BASE_URL}/api/restaurant/${RESTAURANT_ID}/hotel/tariff`);
  const tariffRes = await fetch(`${BASE_URL}/api/restaurant/${RESTAURANT_ID}/hotel/tariff`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!tariffRes.ok) {
    const t = await tariffRes.text();
    console.error(`HTTP ${tariffRes.status}: ${t.slice(0, 300)}`);
    process.exit(3);
  }
  const tariff = await tariffRes.json();

  console.log(`\n──── /tariff response ────`);
  console.log(`tariff_model:           ${tariff.tariff_model}`);
  console.log(`meal_plans count:       ${(tariff.meal_plans || []).length}`);
  console.log(`seasons count:          ${(tariff.seasons || []).length}`);
  console.log(`season_periods count:   ${(tariff.season_periods || []).length}`);
  console.log(`room_tariffs count:     ${(tariff.room_tariffs || []).length}`);
  console.log(`extra_person_charges:   ${(tariff.extra_person_charges || []).length}`);
  console.log(`room_types count:       ${(tariff.room_types || []).length}`);

  console.log(`\n──── meal_plans (raw) ────`);
  for (const m of (tariff.meal_plans || [])) {
    console.log(`  id=${m.id.padEnd(10)} code=${(m.code || '').padEnd(6)} name=${(m.name || '').padEnd(35)} active=${m.is_active} B=${m.includes_breakfast} L=${m.includes_lunch} D=${m.includes_dinner}`);
  }
  if ((tariff.meal_plans || []).length === 0) console.log(`  (empty)`);

  console.log(`\n──── seasons (raw) ────`);
  for (const s of (tariff.seasons || [])) {
    console.log(`  id=${s.id.padEnd(8)} name=${(s.name || '').padEnd(15)} active=${s.is_active}`);
  }
  if ((tariff.seasons || []).length === 0) console.log(`  (empty)`);

  console.log(`\n──── season_periods (raw) ────`);
  for (const p of (tariff.season_periods || [])) {
    console.log(`  season=${p.season_id.padEnd(6)} ${String(p.start_date).slice(0, 10)} → ${String(p.end_date).slice(0, 10)}  label=${p.label || ''}`);
  }
  if ((tariff.season_periods || []).length === 0) console.log(`  (empty)`);

  console.log(`\n──── room_types (raw) ────`);
  for (const t of (tariff.room_types || [])) {
    console.log(`  id=${t.id.padEnd(20)} name=${(t.name || '').padEnd(35)} base_rate=${t.base_rate}`);
  }
  if ((tariff.room_types || []).length === 0) console.log(`  (empty)`);

  console.log(`\n──── room_tariffs matrix (first 8 rows) ────`);
  for (const t of (tariff.room_tariffs || []).slice(0, 8)) {
    console.log(`  ${(t.room_type_id || '').padEnd(20)} × ${(t.season_id || '').padEnd(6)} × ${(t.meal_plan_id || '').padEnd(6)} = ₹${t.rate}`);
  }
  console.log(`  (total ${(tariff.room_tariffs || []).length} rows)`);

  process.exit(0);
})().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(99);
});
