#!/usr/bin/env node
/**
 * One-time recovery — flip every meal_plan row's is_active to 1 so the
 * user's previously-archived custom plans (EP1/CP1/MAP1/API1) reappear
 * in the Settings UI.
 *
 * Credentials come from env vars; nothing is written to disk:
 *   LIVE_LOGIN_ID, LIVE_PASSWORD, LIVE_RESTAURANT_ID, LIVE_BASE_URL
 */

const BASE_URL = process.env.LIVE_BASE_URL || 'https://viveks-cafe.atithi-setu.com';
const LOGIN_ID = process.env.LIVE_LOGIN_ID;
const PASSWORD = process.env.LIVE_PASSWORD;
const RESTAURANT_ID = process.env.LIVE_RESTAURANT_ID;
if (!LOGIN_ID || !PASSWORD || !RESTAURANT_ID) {
  console.error('Set LIVE_LOGIN_ID / LIVE_PASSWORD / LIVE_RESTAURANT_ID env vars.');
  process.exit(1);
}

(async () => {
  console.log(`→ Login as ${LOGIN_ID}`);
  const lr = await fetch(`${BASE_URL}/api/auth/owner/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: LOGIN_ID, password: PASSWORD }),
  });
  const lb = await lr.json();
  const token = lb.jwt_token || lb.token;
  if (!token) { console.error('Login failed:', lb); process.exit(2); }
  console.log(`  ✓ tenant=${lb.restaurantId || lb.restaurant?.id} role=${lb.role}`);

  console.log(`→ Fetch current meal plans`);
  const tr = await fetch(`${BASE_URL}/api/restaurant/${RESTAURANT_ID}/hotel/tariff`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const tariff = await tr.json();
  const before = tariff.meal_plans || [];
  console.log(`  ${before.length} total; ${before.filter(p => p.is_active === 1).length} active; ${before.filter(p => p.is_active !== 1).length} inactive`);

  const flipped = before.map(p => ({ ...p, is_active: 1 }));
  console.log(`→ PUT all ${flipped.length} rows with is_active=1`);
  const pr = await fetch(`${BASE_URL}/api/restaurant/${RESTAURANT_ID}/hotel/tariff/meal-plans`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ meal_plans: flipped }),
  });
  const resp = await pr.json();
  console.log(`  Server response: ok=${resp.ok} count=${resp.count} skipped=${(resp.skipped || []).length} errors=${(resp.errors || []).length}`);

  console.log(`\n→ Verify`);
  const vr = await fetch(`${BASE_URL}/api/restaurant/${RESTAURANT_ID}/hotel/tariff`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const vt = await vr.json();
  const after = vt.meal_plans || [];
  const active = after.filter(p => p.is_active === 1);
  console.log(`  ${active.length} active plans now:`);
  for (const p of active) {
    console.log(`    ${(p.code || '').padEnd(6)} ${(p.name || '').padEnd(55)} id=${p.id}`);
  }
})().catch(err => { console.error('FATAL:', err); process.exit(99); });
