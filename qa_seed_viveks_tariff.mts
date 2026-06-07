#!/usr/bin/env tsx
/**
 * Mock seed: BCG-spreadsheet tariff data into a target tenant
 * ────────────────────────────────────────────────────────────────────────────
 * Loads the 27-room boutique resort's pricing matrix (the spreadsheet
 * the client shared on 7 Jun 2026) into a tenant's DB so the team can
 * eyeball the Phase 1 schema with realistic data before Phase 2 (UI +
 * rate resolver) ships.
 *
 * Default target: RESTO-1003 (Vivek's Cafe). Pass another tenant id as
 * the first CLI argument to target a different tenant.
 *
 * Usage:
 *   npx tsx qa_seed_viveks_tariff.mts                    # → RESTO-1003
 *   npx tsx qa_seed_viveks_tariff.mts RESTO-1003
 *   npx tsx qa_seed_viveks_tariff.mts SOME-OTHER-TENANT
 *
 * Prerequisites:
 *   1. The target tenant must have property_type IN ('HOTEL', 'BOTH').
 *      The hotel tables (rooms, room_types, room_tariffs, …) only exist
 *      for hotel-enabled tenants. The script errors out with clear
 *      instructions if the tenant is RESTAURANT-only.
 *   2. The server must have been booted at least once after commit
 *      7bd9ebf so the seasons / meal_plans / room_tariffs /
 *      extra_person_charges tables have been created.
 *
 * Idempotency:
 *   Every INSERT uses ON CONFLICT … DO UPDATE so the script is safe to
 *   re-run unlimited times. Re-running refreshes rates if you edit them
 *   in this file, leaves everything else untouched.
 *
 *   season_periods are wiped + re-inserted on each run (DELETE + INSERT)
 *   to avoid date-range duplicates when the dates themselves change.
 */

import { centralDb, getTenantDb } from './db.js';

const tenantId = process.argv[2] || 'RESTO-1003';

// ─────────────────────────────────────────────────────────────────────
// THE DATA (lifted verbatim from the client's spreadsheet)
// ─────────────────────────────────────────────────────────────────────

const ROOM_TYPES = [
  { id: 'SUPERIOR_VIEW',  name: 'Superior Room with View',   base_rate: 2000, description: 'Standard category with city / garden view.' },
  { id: 'PREMIUM_BALC',   name: 'Premium Room with Balcony', base_rate: 2400, description: 'Premium category with private balcony.' },
  { id: 'RIVER_VIEW',     name: 'River View with Balcony',   base_rate: 2800, description: 'Top category — river-facing rooms with private balcony.' },
];

// Room → category mapping from the "Room List Category Wise" table.
// 27 rooms total: 11 + 8 + 8.
const ROOMS_BY_TYPE: Record<string, string[]> = {
  SUPERIOR_VIEW: ['103','203','206','207','209','210','303','306','307','309','310'],
  PREMIUM_BALC:  ['204','205','211','212','304','305','311','312'],
  RIVER_VIEW:    ['101','102','201','202','208','301','302','308'],
};

// Season date ranges — each season has TWO discontinuous periods.
const SEASON_PERIODS = [
  // Peak Season
  { season_id: 'PEAK', start: '2026-04-15', end: '2026-06-30', label: 'Summer leg (Apr-Jun)' },
  { season_id: 'PEAK', start: '2026-12-20', end: '2027-01-05', label: 'Christmas / New Year leg' },
  // Off Season
  { season_id: 'OFF',  start: '2026-07-01', end: '2026-12-19', label: 'Monsoon + post-monsoon' },
  { season_id: 'OFF',  start: '2027-01-06', end: '2027-04-14', label: 'Winter shoulder (Jan-Apr)' },
];

// 24 room tariffs — [room_type, season, meal_plan, ₹]
const ROOM_TARIFFS: Array<[string, string, string, number]> = [
  // Superior Room with View ────────────────────────────────────────
  ['SUPERIOR_VIEW','PEAK','EP', 3200], ['SUPERIOR_VIEW','PEAK','CP', 3700], ['SUPERIOR_VIEW','PEAK','MAP', 4500], ['SUPERIOR_VIEW','PEAK','API', 5200],
  ['SUPERIOR_VIEW','OFF', 'EP', 2000], ['SUPERIOR_VIEW','OFF', 'CP', 2500], ['SUPERIOR_VIEW','OFF', 'MAP', 3300], ['SUPERIOR_VIEW','OFF', 'API', 4000],
  // Premium Room with Balcony ───────────────────────────────────────
  ['PREMIUM_BALC', 'PEAK','EP', 3700], ['PREMIUM_BALC', 'PEAK','CP', 4200], ['PREMIUM_BALC', 'PEAK','MAP', 5000], ['PREMIUM_BALC', 'PEAK','API', 5700],
  ['PREMIUM_BALC', 'OFF', 'EP', 2400], ['PREMIUM_BALC', 'OFF', 'CP', 2900], ['PREMIUM_BALC', 'OFF', 'MAP', 3700], ['PREMIUM_BALC', 'OFF', 'API', 4400],
  // River View with Balcony ─────────────────────────────────────────
  ['RIVER_VIEW',   'PEAK','EP', 4200], ['RIVER_VIEW',   'PEAK','CP', 4700], ['RIVER_VIEW',   'PEAK','MAP', 5500], ['RIVER_VIEW',   'PEAK','API', 6200],
  ['RIVER_VIEW',   'OFF', 'EP', 2800], ['RIVER_VIEW',   'OFF', 'CP', 3300], ['RIVER_VIEW',   'OFF', 'MAP', 4100], ['RIVER_VIEW',   'OFF', 'API', 4800],
];

// 24 extra-person charges — [person_type, season, meal_plan, ₹]
const EXTRA_PERSON_CHARGES: Array<[string, string, string, number]> = [
  // Extra Adult (with mattress assumed) ─────────────────────────────
  ['ADULT',              'PEAK','EP',1000], ['ADULT',              'PEAK','CP',1300], ['ADULT',              'PEAK','MAP',1800], ['ADULT',              'PEAK','API',2200],
  ['ADULT',              'OFF', 'EP', 800], ['ADULT',              'OFF', 'CP',1100], ['ADULT',              'OFF', 'MAP',1600], ['ADULT',              'OFF', 'API',2000],
  // Extra Child 5-12 with mattress ──────────────────────────────────
  ['CHILD_WITH_MATTRESS','PEAK','EP', 700], ['CHILD_WITH_MATTRESS','PEAK','CP',1000], ['CHILD_WITH_MATTRESS','PEAK','MAP',1400], ['CHILD_WITH_MATTRESS','PEAK','API',1700],
  ['CHILD_WITH_MATTRESS','OFF', 'EP', 500], ['CHILD_WITH_MATTRESS','OFF', 'CP', 800], ['CHILD_WITH_MATTRESS','OFF', 'MAP',1200], ['CHILD_WITH_MATTRESS','OFF', 'API',1500],
  // Extra Child 5-12 without mattress ───────────────────────────────
  ['CHILD_NO_MATTRESS', 'PEAK','EP', 500], ['CHILD_NO_MATTRESS', 'PEAK','CP', 700], ['CHILD_NO_MATTRESS', 'PEAK','MAP',1000], ['CHILD_NO_MATTRESS', 'PEAK','API',1200],
  ['CHILD_NO_MATTRESS', 'OFF', 'EP', 400], ['CHILD_NO_MATTRESS', 'OFF', 'CP', 600], ['CHILD_NO_MATTRESS', 'OFF', 'MAP', 900], ['CHILD_NO_MATTRESS', 'OFF', 'API',1100],
];

// ─────────────────────────────────────────────────────────────────────
// Seed
// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Seeding BCG-spreadsheet tariff matrix into tenant ${tenantId}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // Step 1 — confirm tenant exists + has hotel module enabled.
  const tenant: any = await centralDb.get(
    "SELECT id, name, property_type, tariff_model FROM restaurants WHERE id = ?",
    [tenantId]
  );
  if (!tenant) {
    console.error(`✗ Tenant "${tenantId}" not found in restaurants table.`);
    console.error(`  Hint: pass the correct tenant id as the first CLI argument.`);
    process.exit(1);
  }
  console.log(`✓ Found tenant: ${tenant.name} (property_type=${tenant.property_type}, tariff_model=${tenant.tariff_model})`);

  if (tenant.property_type !== 'HOTEL' && tenant.property_type !== 'BOTH') {
    console.error(`✗ Tenant property_type is "${tenant.property_type}" — needs HOTEL or BOTH.`);
    console.error(`  Enable the hotel module first via the SuperAdmin console OR via:`);
    console.error(`    UPDATE restaurants SET property_type = 'BOTH' WHERE id = '${tenantId}';`);
    console.error(`  Then re-run this script — the createHotelTables() routine will`);
    console.error(`  provision the tariff tables on the tenant's next API call.`);
    process.exit(1);
  }

  // Step 2 — flip the tariff_model flag to MATRIX so the resolver
  // (Phase 3) routes through the new tables instead of rate_overrides.
  await centralDb.run(
    `UPDATE restaurants SET tariff_model = 'MATRIX' WHERE id = ?`,
    [tenantId]
  );
  console.log(`✓ restaurants.tariff_model = 'MATRIX'`);

  const db = await getTenantDb(tenantId);

  // Step 3 — Room types (3 rows). Idempotent.
  for (let i = 0; i < ROOM_TYPES.length; i++) {
    const rt = ROOM_TYPES[i];
    await db.run(
      `INSERT INTO room_types (id, name, description, base_rate, capacity, display_order, is_active)
       VALUES (?, ?, ?, ?, 2, ?, 1)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         base_rate = EXCLUDED.base_rate`,
      [rt.id, rt.name, rt.description, rt.base_rate, i + 1]
    );
  }
  console.log(`✓ ${ROOM_TYPES.length} room types seeded`);

  // Step 4 — 27 rooms with type assignment. Idempotent.
  let roomCount = 0;
  for (const [typeId, numbers] of Object.entries(ROOMS_BY_TYPE)) {
    const baseRate = ROOM_TYPES.find(t => t.id === typeId)!.base_rate;
    for (const num of numbers) {
      const id = `ROOM-${num}`;
      const floor = parseInt(num.charAt(0), 10);
      await db.run(
        `INSERT INTO rooms (id, name, room_number, floor, type_id, capacity, base_rate, status, smoking_preference)
         VALUES (?, ?, ?, ?, ?, 2, ?, 'VACANT', 'NON_SMOKING')
         ON CONFLICT (id) DO UPDATE SET
           type_id = EXCLUDED.type_id,
           base_rate = EXCLUDED.base_rate,
           room_number = EXCLUDED.room_number,
           floor = EXCLUDED.floor`,
        [id, `Room ${num}`, num, floor, typeId, baseRate]
      );
      roomCount++;
    }
  }
  console.log(`✓ ${roomCount} rooms seeded (expected 27)`);

  // Step 5 — Seasons should already exist (auto-seeded by
  // createHotelTables). Defensive upsert anyway.
  for (const s of [
    { id: 'PEAK', name: 'Peak', description: 'High-demand months — summer + Christmas / New Year', color: '#c13b3b', order: 1 },
    { id: 'OFF',  name: 'Off',  description: 'Monsoon + winter shoulder',                          color: '#6b5d52', order: 2 },
  ]) {
    await db.run(
      `INSERT INTO seasons (id, name, description, color, display_order, is_active)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         color = EXCLUDED.color,
         display_order = EXCLUDED.display_order`,
      [s.id, s.name, s.description, s.color, s.order]
    );
  }

  // Step 6 — Season periods. Wipe & reinsert (avoid range duplicates on rerun).
  await db.run(`DELETE FROM season_periods WHERE season_id IN ('PEAK', 'OFF')`);
  for (const p of SEASON_PERIODS) {
    await db.run(
      `INSERT INTO season_periods (id, season_id, start_date, end_date, label)
       VALUES (?, ?, ?, ?, ?)`,
      [`${p.season_id}-${p.start}`, p.season_id, p.start, p.end, p.label]
    );
  }
  console.log(`✓ 2 seasons + ${SEASON_PERIODS.length} periods seeded`);

  // Step 7 — 24 room_tariffs. Idempotent via the UNIQUE index.
  for (const [typeId, seasonId, mealId, rate] of ROOM_TARIFFS) {
    await db.run(
      `INSERT INTO room_tariffs (id, room_type_id, season_id, meal_plan_id, rate, room_id_override)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT (room_type_id, season_id, meal_plan_id, COALESCE(room_id_override, ''))
       DO UPDATE SET rate = EXCLUDED.rate, updated_at = CURRENT_TIMESTAMP`,
      [`TARIFF-${typeId}-${seasonId}-${mealId}`, typeId, seasonId, mealId, rate]
    );
  }
  console.log(`✓ ${ROOM_TARIFFS.length} room tariffs seeded`);

  // Step 8 — 24 extra_person_charges. Idempotent via the UNIQUE index.
  for (const [personType, seasonId, mealId, charge] of EXTRA_PERSON_CHARGES) {
    const isChild = personType.startsWith('CHILD');
    const ageMin = isChild ? 5 : null;
    const ageMax = isChild ? 12 : null;
    await db.run(
      `INSERT INTO extra_person_charges (id, person_type, season_id, meal_plan_id, age_min, age_max, charge)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (person_type, season_id, meal_plan_id)
       DO UPDATE SET charge = EXCLUDED.charge, age_min = EXCLUDED.age_min, age_max = EXCLUDED.age_max`,
      [`XP-${personType}-${seasonId}-${mealId}`, personType, seasonId, mealId, ageMin, ageMax, charge]
    );
  }
  console.log(`✓ ${EXTRA_PERSON_CHARGES.length} extra-person charges seeded`);

  // ─── Verification report ───────────────────────────────────────
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Verification`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  const mealPlans = await db.query(`SELECT id, code, name, includes_breakfast, includes_lunch, includes_dinner FROM meal_plans ORDER BY display_order`);
  console.log(`Meal plans:`);
  for (const mp of mealPlans) {
    const incl = [mp.includes_breakfast && 'B', mp.includes_lunch && 'L', mp.includes_dinner && 'D'].filter(Boolean).join('+') || 'room only';
    console.log(`  ${mp.id.padEnd(5)} ${mp.name.padEnd(28)} (${incl})`);
  }

  const sampleQuery = `
    SELECT rt.room_type_id, rt.season_id, rt.meal_plan_id, rt.rate
    FROM room_tariffs rt
    ORDER BY
      CASE rt.room_type_id WHEN 'SUPERIOR_VIEW' THEN 1 WHEN 'PREMIUM_BALC' THEN 2 WHEN 'RIVER_VIEW' THEN 3 ELSE 99 END,
      CASE rt.season_id WHEN 'PEAK' THEN 1 ELSE 2 END,
      CASE rt.meal_plan_id WHEN 'EP' THEN 1 WHEN 'CP' THEN 2 WHEN 'MAP' THEN 3 WHEN 'API' THEN 4 ELSE 99 END
  `;
  const tariffs = await db.query(sampleQuery);
  console.log(`\nRoom tariff matrix (${tariffs.length} rows):`);
  console.log(`                                Peak                       Off`);
  console.log(`                          EP    CP    MAP   API     EP    CP    MAP   API`);
  let buf: Record<string, number[]> = {};
  for (const t of tariffs) {
    const key = `${t.room_type_id}-${t.season_id}`;
    buf[key] = buf[key] || [];
    buf[key].push(t.rate);
  }
  for (const typeId of ['SUPERIOR_VIEW', 'PREMIUM_BALC', 'RIVER_VIEW']) {
    const name = ROOM_TYPES.find(r => r.id === typeId)!.name;
    const peak = buf[`${typeId}-PEAK`] || [];
    const off  = buf[`${typeId}-OFF`]  || [];
    const cells = [...peak, ...off].map(v => String(v).padStart(5, ' ')).join(' ');
    console.log(`  ${name.padEnd(28)}${cells}`);
  }

  const xpQuery = `
    SELECT person_type, season_id, meal_plan_id, charge
    FROM extra_person_charges
    ORDER BY
      CASE person_type WHEN 'ADULT' THEN 1 WHEN 'CHILD_WITH_MATTRESS' THEN 2 ELSE 3 END,
      CASE season_id WHEN 'PEAK' THEN 1 ELSE 2 END,
      CASE meal_plan_id WHEN 'EP' THEN 1 WHEN 'CP' THEN 2 WHEN 'MAP' THEN 3 WHEN 'API' THEN 4 ELSE 99 END
  `;
  const xps = await db.query(xpQuery);
  console.log(`\nExtra-person charges (${xps.length} rows):`);
  console.log(`                                Peak                       Off`);
  console.log(`                          EP    CP    MAP   API     EP    CP    MAP   API`);
  buf = {};
  for (const x of xps) {
    const key = `${x.person_type}-${x.season_id}`;
    buf[key] = buf[key] || [];
    buf[key].push(x.charge);
  }
  const xpLabels: Record<string, string> = {
    ADULT: 'Extra Adult (w/ mattress)',
    CHILD_WITH_MATTRESS: 'Extra Child 5-12 w/ mat',
    CHILD_NO_MATTRESS: 'Extra Child 5-12 no mat',
  };
  for (const pt of ['ADULT', 'CHILD_WITH_MATTRESS', 'CHILD_NO_MATTRESS']) {
    const peak = buf[`${pt}-PEAK`] || [];
    const off  = buf[`${pt}-OFF`]  || [];
    const cells = [...peak, ...off].map(v => String(v).padStart(5, ' ')).join(' ');
    console.log(`  ${xpLabels[pt].padEnd(28)}${cells}`);
  }

  console.log(`\nSeason periods:`);
  const periods = await db.query(`SELECT season_id, start_date, end_date, label FROM season_periods ORDER BY start_date`);
  for (const p of periods) {
    console.log(`  ${p.season_id.padEnd(6)} ${p.start_date} → ${p.end_date}   ${p.label || ''}`);
  }

  console.log(`\n✓ Mock seed complete for tenant ${tenantId}.`);
  console.log(`  Next step: ship Phase 2 (Settings → Tariff Configuration UI) so the`);
  console.log(`  matrix is editable from the app. Phase 3 wires the rate resolver.`);
  process.exit(0);
}

main().catch(err => { console.error('SEED FAILED:', err); process.exit(1); });
