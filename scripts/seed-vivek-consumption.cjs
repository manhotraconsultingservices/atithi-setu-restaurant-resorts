#!/usr/bin/env node
/**
 * Atithi-Setu — Production-grade consumption-history seeder for Vivek's Cafe
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Generates ~60 days of realistic, weekday-aware CONSUMPTION movements so the
 * inventory dashboard's Daily / Weekly / Monthly forecasts render with real
 * signal (not flatlined zeros). Per-ingredient daily rates are inferred from
 * category + unit and tuned for an Indian café-style menu.
 *
 * After seeding, calls /forecast/recompute to populate consumption_forecasts.
 *
 * The seeded rows are tagged reference_type='seed' so they can be wiped later
 * by re-running with --purge or via the admin endpoint directly.
 *
 * Usage:
 *
 *   node scripts/seed-vivek-consumption.cjs \
 *     --server https://rishu-kitchen.atithi-setu.com \
 *     --email <owner-email> --password <pw>
 *
 *   # or with admin token:
 *   node scripts/seed-vivek-consumption.cjs \
 *     --server https://rishu-kitchen.atithi-setu.com \
 *     --admin-login <admin-login-id> --admin-password <pw> \
 *     --restaurant RESTO-1003
 *
 *   # add --purge to wipe previous synthetic rows first (idempotent re-run)
 *   # add --days N to seed a different window (default 60)
 *   # add --dry-run to preview the plan without writing
 */

'use strict';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const has = (n) => args.includes(`--${n}`);

const SERVER = (flag('server') || 'http://localhost:3001').replace(/\/$/, '');
const EMAIL = flag('email');
const PASSWORD = flag('password');
const TOKEN_OPT = flag('token');
const RESTAURANT_OPT = flag('restaurant');
const ADMIN_LOGIN = flag('admin-login');
const ADMIN_PW = flag('admin-password');
const DAYS = Math.max(7, Math.min(120, Number(flag('days') || 60)));
const PURGE = has('purge');
const DRY = has('dry-run');

async function api(method, p, body, token) {
  const res = await fetch(`${SERVER}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function getAuth() {
  if (TOKEN_OPT && RESTAURANT_OPT) return { token: TOKEN_OPT, restaurantId: RESTAURANT_OPT };
  if (ADMIN_LOGIN && ADMIN_PW && RESTAURANT_OPT) {
    const r = await api('POST', '/api/auth/import-token', {
      loginId: ADMIN_LOGIN, password: ADMIN_PW, restaurantId: RESTAURANT_OPT,
    });
    return { token: r.token, restaurantId: RESTAURANT_OPT };
  }
  if (EMAIL && PASSWORD) {
    const r = await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
    return { token: r.token, restaurantId: r.user?.restaurantId || r.restaurantId };
  }
  throw new Error('Provide --email + --password OR --token + --restaurant OR --admin-login + --admin-password + --restaurant');
}

// ─── Daily-rate heuristics (per ingredient, in stock unit / day) ────────────
//
// Tuned for a 60-80 cover/day Indian café:
//   • Beverages: turn over fast — bottles per day
//   • Dairy: paneer ~3-5kg/day, milk ~2l/day, butter ~0.5kg/day
//   • Meat: chicken ~3kg/day, mutton ~0.8kg/day
//   • Produce: onion/tomato 5-8 kg/day, ginger/garlic 0.3-0.5 kg/day
//   • Grains: rice 6kg/day, dals 2-3kg/day, flour 2kg/day
//   • Oils: 0.6-1 l/day
//   • Spices: 0.05-0.1 kg/day
//
// Rates are then scaled by a weekday factor (Mon slow → Sat busy).

function inferDailyRate(ing) {
  const name = String(ing.name || '').toLowerCase();
  const category = String(ing.category || '').toLowerCase();
  const unit = String(ing.unit || 'unit').toLowerCase();

  // Specific high-confidence overrides by name
  const NAME_RATES = [
    [/paneer/, 3.5],
    [/chicken/, 3.0],
    [/mutton/, 0.8],
    [/^eggs?$/i, 24],            // 2 dozen / day
    [/basmati|rice/, 6.0],
    [/wheat\s*flour|atta/, 2.5],
    [/maida|refined\s*flour/, 1.8],
    [/toor\s*dal|arhar/, 1.2],
    [/moong\s*dal/, 0.8],
    [/chana\s*dal/, 0.7],
    [/onion/, 6.0],
    [/tomato/, 5.0],
    [/potato/, 4.0],
    [/ginger/, 0.4],
    [/garlic/, 0.3],
    [/^chilli|chillies|^hari\s*mirch|green\s*chilli/, 0.25],
    [/coriander|dhania/, 0.3],
    [/lemon|nimbu/, 0.2],
    [/milk/, 2.0],
    [/curd|dahi|yogurt/, 0.7],
    [/butter/, 0.5],
    [/ghee/, 0.25],
    [/cream/, 0.4],
    [/mustard\s*oil/, 0.5],
    [/sunflower\s*oil|refined\s*oil|cooking\s*oil/, 0.8],
    [/olive\s*oil/, 0.1],
    [/salt/, 0.15],
    [/sugar/, 0.6],
    [/turmeric|haldi/, 0.06],
    [/red\s*chilli\s*powder|lal\s*mirch/, 0.05],
    [/garam\s*masala/, 0.03],
    [/cumin|jeera/, 0.04],
    [/cardamom|elaichi/, 0.02],
    // Beverages — bottles per day
    [/coca[\s-]?cola|coke/, 4],
    [/sprite/, 2.5],
    [/pepsi/, 2.5],
    [/thums?\s*up/, 2],
    [/limca/, 1.5],
    [/fanta/, 1.5],
    [/mineral\s*water|water\s*bottle|aqua/, 8],
    [/soda|soda\s*water/, 1.5],
    [/^beer/, 3],
    [/^wine/, 0.5],
    [/^juice|fresh\s*juice/, 2],
    [/^tea\s*leaves|^tea$/, 0.15],
    [/coffee\s*powder|coffee/, 0.1],
  ];
  for (const [re, rate] of NAME_RATES) if (re.test(name)) return rate;

  // Fall back to category-based defaults
  if (category.includes('beverage')) {
    return unit === 'bottle' || unit === 'can' ? 2.5 : 0.5;
  }
  if (category.includes('dairy')) return unit === 'kg' ? 0.4 : 0.5;
  if (category.includes('meat')) return 1.5;
  if (category.includes('produce') || category.includes('vegetable')) return 1.0;
  if (category.includes('grain')) return 1.5;
  if (category.includes('spice') || category.includes('masala')) return 0.04;
  if (category.includes('oil') || category.includes('fat')) return 0.4;
  if (category.includes('snack') || category.includes('packaged')) return 0.5;
  // Generic fallback proportional to current stock so dashboard always has signal
  const stock = Number(ing.current_stock_qty || 0);
  return Math.max(0.05, Math.min(2, stock / 30));
}

// Weekday factors per ingredient class — beverages spike harder on weekends
function inferWeekdayFactors(ing) {
  const name = String(ing.name || '').toLowerCase();
  const cat = String(ing.category || '').toLowerCase();
  // [Sun, Mon, Tue, Wed, Thu, Fri, Sat]
  if (cat.includes('beverage') || /coke|sprite|pepsi|water|beer|wine|juice/.test(name)) {
    return [1.5, 0.6, 0.75, 0.85, 1.0, 1.5, 1.7]; // strong weekend pop
  }
  if (cat.includes('meat') || /chicken|mutton/.test(name)) {
    return [1.6, 0.6, 0.7, 0.85, 1.0, 1.4, 1.6]; // weekend grill spike
  }
  if (/biryani|rice/.test(name)) {
    return [1.5, 0.7, 0.8, 0.9, 1.0, 1.3, 1.6]; // weekend biryani rush
  }
  // Default café pattern
  return [1.3, 0.75, 0.85, 0.9, 1.0, 1.2, 1.45];
}

async function run() {
  console.log(`▶ Connecting to ${SERVER}…`);
  const { token, restaurantId } = await getAuth();
  console.log(`✓ Authenticated as restaurant ${restaurantId}`);

  // 1. Pull ingredient catalog
  const ingredients = await api('GET', `/api/restaurant/${restaurantId}/inventory/ingredients`, undefined, token);
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    throw new Error('No ingredients found — run seed-inventory-demo.cjs first');
  }
  console.log(`✓ Loaded ${ingredients.length} ingredients`);

  // 2. Build per-ingredient seed plan
  const plan = ingredients.map(i => ({
    id: i.id,
    name: i.name,
    daily_rate: inferDailyRate(i),
    weekday_factors: inferWeekdayFactors(i),
    noise: 0.18,
  }));

  // 3. Print preview
  console.log(`\n▶ Plan preview (top 15 by inferred daily rate):`);
  const sorted = [...plan].sort((a, b) => b.daily_rate - a.daily_rate).slice(0, 15);
  for (const p of sorted) {
    const weeklyFcst = p.daily_rate * p.weekday_factors.reduce((a, b) => a + b, 0);
    console.log(`  • ${p.name.padEnd(28)} ${String(p.daily_rate.toFixed(2)).padStart(6)}/day → ~${weeklyFcst.toFixed(1)}/wk`);
  }
  if (plan.length > 15) console.log(`  … and ${plan.length - 15} more`);

  if (DRY) {
    console.log('\n— DRY RUN — no data written. Re-run without --dry-run to seed.');
    return;
  }

  // 4. POST to admin endpoint
  console.log(`\n▶ Seeding ${DAYS} days of consumption history${PURGE ? ' (purging existing synthetic rows first)' : ''}…`);
  const res = await api('POST', `/api/restaurant/${restaurantId}/inventory/admin/seed-consumption-history`, {
    days: DAYS,
    ingredients: plan,
    wastage_rate: 0.025,
    purge_existing: PURGE,
  }, token);
  console.log(`✓ Seeded:`);
  console.log(`    consumption rows:  ${res.consumption_rows_inserted.toLocaleString()}`);
  console.log(`    wastage rows:      ${res.wastage_rows_inserted.toLocaleString()}`);
  if (res.previously_purged) console.log(`    purged previous:   ${res.previously_purged.toLocaleString()}`);

  // 5. Recompute forecasts
  console.log(`\n▶ Recomputing forecasts…`);
  const fc = await api('POST', `/api/restaurant/${restaurantId}/inventory/forecast/recompute`, {}, token);
  console.log(`✓ Forecasts updated for ${fc.updated}/${fc.ingredients} ingredients`);

  // 6. Verification — pull dashboard and report a few interesting numbers
  console.log(`\n▶ Verifying dashboard…`);
  const dash = await api('GET', `/api/restaurant/${restaurantId}/inventory/dashboard?horizon=weekly`, undefined, token);
  const top = (dash.forecast || [])
    .filter(r => r.forecast_qty > 0)
    .sort((a, b) => b.forecast_qty - a.forecast_qty)
    .slice(0, 8);
  console.log(`\n  Top 8 weekly forecasts:`);
  for (const r of top) {
    const dc = r.days_of_cover == null ? '∞' : r.days_of_cover.toFixed(1) + 'd';
    console.log(`    ${r.ingredient_name.padEnd(28)} ${r.forecast_qty.toFixed(2).padStart(8)} ${r.unit} / wk · ${dc} cover · suggest ${Number(r.suggested_order_qty).toFixed(2)}`);
  }

  console.log(`\n✅ Done. Open the Inventory dashboard and toggle Daily / Weekly / Monthly to see populated forecasts.\n` +
    `   The seeded rows are tagged reference_type='seed' — pass --purge on re-run to wipe them.`);
}

run().catch(err => {
  console.error('\n❌ Seed failed:', err.message);
  if (err.stack && process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
