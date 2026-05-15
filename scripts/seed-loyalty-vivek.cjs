#!/usr/bin/env node
/**
 * Atithi-Setu — Loyalty Demo Seed (Phase 1)
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Populates a tenant's loyalty program with realistic demo customers spread
 * across Bronze / Silver / Gold tiers. Drives the data through the production
 * code path (POST /invoices/manual → _loyaltyHook), so every demo customer
 * gets:
 *   - a real row in loyalty_customers (phone keyed)
 *   - the right total_orders + total_spent
 *   - a tier_history row capturing each upgrade as it crosses a threshold
 *   - matching orders in the orders table that show up in the customer's
 *     "recent orders" drawer in the LOYALTY tab
 *
 * Distribution by default (30 customers):
 *     6 Gold    (₹50,000+ lifetime spend, 10% off)
 *    12 Silver  (₹10,000+,  5% off)
 *    12 Bronze  (₹0+,       0% off)
 *
 * Phone numbers are all in the demo range 9001-XX-XXXX so they will never
 * collide with a real customer's phone. Names are realistic Indian first +
 * last names (Mehta, Reddy, Singh, etc.).
 *
 * ── Authentication Modes (mirrors seed-cloud-kitchen.cjs) ────────────────────
 *
 *  Mode 1 — Owner login
 *    node scripts/seed-loyalty-vivek.cjs --email owner@x.com --password secret \
 *      --server https://viveks-cafe.atithi-setu.com
 *
 *  Mode 2 — Token (copy JWT from browser DevTools → Network → any API call)
 *    node scripts/seed-loyalty-vivek.cjs --token <jwt> \
 *      --restaurant RESTO-1003 \
 *      --server https://viveks-cafe.atithi-setu.com
 *
 *  Mode 3 — Super Admin
 *    node scripts/seed-loyalty-vivek.cjs --admin-login ADMIN-ANKUSH \
 *      --admin-password adminpass \
 *      --restaurant RESTO-1003 \
 *      --server https://viveks-cafe.atithi-setu.com
 *
 *  Mode 4 — Staff loginId + password (any OWNER/MANAGER)
 *    node scripts/seed-loyalty-vivek.cjs --login-id OWNER-001 --password secret \
 *      --restaurant RESTO-1003 \
 *      --server https://viveks-cafe.atithi-setu.com
 *
 * ── Options ────────────────────────────────────────────────────────────────────
 *   --server          Server base URL  (default: http://localhost:4001)
 *   --restaurant      Restaurant ID    (required for modes 2, 3, 4)
 *   --customers <n>   How many demo customers to create (default: 30, max: 100)
 *   --gold <n>        How many should land in Gold tier (default: 6)
 *   --silver <n>      How many should land in Silver tier (default: 12)
 *   --bronze <n>      How many should land in Bronze tier (default: 12)
 *   --dry-run         Log what would happen, don't hit the API
 *   --help            This message
 *
 * ── Idempotency ────────────────────────────────────────────────────────────────
 * Every demo customer has a stable phone (9001-XX-XXXX). Re-running the
 * script ADDS more invoices for each customer — total_spent grows. To start
 * fresh, run TRUNCATE on the loyalty_* tables in the tenant DB first:
 *
 *     DELETE FROM loyalty_redemptions;
 *     DELETE FROM loyalty_tier_history;
 *     DELETE FROM loyalty_customers WHERE phone LIKE '900%';
 *     DELETE FROM orders WHERE customer_phone LIKE '900%';
 */

'use strict';

const http  = require('http');
const https = require('https');

// ─── CLI arg parsing ──────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const arg     = (flag) => { const i = args.indexOf(flag); return i !== -1 && i + 1 < args.length ? args[i + 1] : null; };
const hasFlag = (flag) => args.includes(flag);

if (hasFlag('--help')) {
  console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]);
  process.exit(0);
}

const SERVER         = (arg('--server') || 'http://localhost:4001').replace(/\/$/, '');
const RESTAURANT_ARG = arg('--restaurant');
const DRY_RUN        = hasFlag('--dry-run');
const TOTAL          = Math.min(parseInt(arg('--customers') || '30', 10), 100);
const N_GOLD         = parseInt(arg('--gold')   || '6',  10);
const N_SILVER       = parseInt(arg('--silver') || '12', 10);
const N_BRONZE       = parseInt(arg('--bronze') || '12', 10);

const OWNER_EMAIL    = arg('--email');
const PASSWORD       = arg('--password');
const TOKEN_ARG      = arg('--token');
const ADMIN_LOGIN    = arg('--admin-login');
const ADMIN_PASSWORD = arg('--admin-password');
const STAFF_LOGIN_ID = arg('--login-id');

const authMode =
  TOKEN_ARG                          ? 'token'       :
  ADMIN_LOGIN && ADMIN_PASSWORD      ? 'superadmin'  :
  STAFF_LOGIN_ID && PASSWORD         ? 'stafflogin'  :
  OWNER_EMAIL && PASSWORD            ? 'ownerlogin'  :
  null;

if (!authMode) {
  console.error('❌  No authentication provided. Run with --help for usage.');
  process.exit(1);
}
if (['token', 'superadmin', 'stafflogin'].includes(authMode) && !RESTAURANT_ARG) {
  console.error(`❌  --restaurant is required when using ${authMode} mode.`);
  process.exit(1);
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const lib    = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const req    = lib.request({
      hostname: parsed.hostname,
      port    : parsed.port || (url.startsWith('https') ? 443 : 80),
      path    : parsed.pathname + parsed.search,
      method  : options.method || 'GET',
      headers : options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function jsonReq(method, url, token, body) {
  const opts = {
    method,
    headers: {
      'Content-Type' : 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
  };
  const res = await request(url, opts, body ? JSON.stringify(body) : null);
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch {}
  return { status: res.status, data: parsed, raw: res.body };
}

const jsonGet   = (url, token)       => jsonReq('GET',   url, token);
const jsonPost  = (url, token, body) => jsonReq('POST',  url, token, body);
const jsonPatch = (url, token, body) => jsonReq('PATCH', url, token, body);

// ─── Auth ──────────────────────────────────────────────────────────────────────
async function authenticate() {
  if (authMode === 'token') {
    return { token: TOKEN_ARG, restaurantId: RESTAURANT_ARG };
  }
  if (authMode === 'ownerlogin') {
    const r = await jsonPost(`${SERVER}/api/login`, null,
      { email: OWNER_EMAIL, password: PASSWORD });
    if (r.status !== 200 || !r.data?.token) {
      throw new Error(`Owner login failed (${r.status}): ${r.raw}`);
    }
    return { token: r.data.token, restaurantId: r.data.user?.restaurantId || r.data.restaurantId || RESTAURANT_ARG };
  }
  if (authMode === 'stafflogin') {
    const r = await jsonPost(`${SERVER}/api/staff-login`, null,
      { loginId: STAFF_LOGIN_ID, password: PASSWORD });
    if (r.status !== 200 || !r.data?.token) {
      throw new Error(`Staff login failed (${r.status}): ${r.raw}`);
    }
    return { token: r.data.token, restaurantId: RESTAURANT_ARG };
  }
  if (authMode === 'superadmin') {
    const r = await jsonPost(`${SERVER}/api/superadmin-login`, null,
      { loginId: ADMIN_LOGIN, password: ADMIN_PASSWORD });
    if (r.status !== 200 || !r.data?.token) {
      throw new Error(`Super-admin login failed (${r.status}): ${r.raw}`);
    }
    return { token: r.data.token, restaurantId: RESTAURANT_ARG };
  }
  throw new Error('Unreachable auth mode');
}

// ─── Demo customer pool ───────────────────────────────────────────────────────
// 60 realistic Indian first + last name combinations, phones in the demo
// 9001-XX-XXXX range. The script samples the top N for any given run so
// re-running with a smaller --customers count keeps the same names in the
// same tiers — handy for re-seeding without surprise re-tiering.
const DEMO_CUSTOMERS = [
  // ── Gold-tier candidates (high spend) ────────────────────────────────────
  { name: 'Anjali Mehta',       phone: '9001112301', email: 'anjali.mehta@example.com' },
  { name: 'Vikram Khanna',      phone: '9001112302', email: 'vikram.k@example.com' },
  { name: 'Sunita Reddy',       phone: '9001112303', email: 'sunita.reddy@example.com' },
  { name: 'Arjun Kapoor',       phone: '9001112304', email: 'arjun.kapoor@example.com' },
  { name: 'Kavita Iyer',        phone: '9001112305', email: 'kavita.iyer@example.com' },
  { name: 'Rohit Sharma',       phone: '9001112306', email: 'rohit.s@example.com' },
  { name: 'Meera Bhatia',       phone: '9001112307', email: 'meera.bhatia@example.com' },
  { name: 'Sanjay Verma',       phone: '9001112308', email: 'sanjay.verma@example.com' },
  // ── Silver-tier candidates (mid spend) ───────────────────────────────────
  { name: 'Priya Nair',         phone: '9001112311', email: 'priya.nair@example.com' },
  { name: 'Amit Joshi',         phone: '9001112312', email: 'amit.joshi@example.com' },
  { name: 'Rashmi Pillai',      phone: '9001112313', email: 'rashmi.p@example.com' },
  { name: 'Karan Malhotra',     phone: '9001112314', email: 'karan.m@example.com' },
  { name: 'Divya Krishnan',     phone: '9001112315', email: 'divya.k@example.com' },
  { name: 'Nikhil Bansal',      phone: '9001112316', email: 'nikhil.b@example.com' },
  { name: 'Pooja Saxena',       phone: '9001112317', email: 'pooja.saxena@example.com' },
  { name: 'Harsh Aggarwal',     phone: '9001112318', email: 'harsh.a@example.com' },
  { name: 'Neha Chopra',        phone: '9001112319', email: 'neha.chopra@example.com' },
  { name: 'Aditya Rao',         phone: '9001112320', email: 'aditya.rao@example.com' },
  { name: 'Sneha Kulkarni',     phone: '9001112321', email: 'sneha.k@example.com' },
  { name: 'Manish Goel',        phone: '9001112322', email: 'manish.goel@example.com' },
  // ── Bronze-tier candidates (low spend, including some near-Silver) ───────
  { name: 'Rahul Dewan',        phone: '9001112331', email: null },
  { name: 'Shweta Kohli',       phone: '9001112332', email: null },
  { name: 'Aakash Patil',       phone: '9001112333', email: 'aakash.p@example.com' },
  { name: 'Anita Suresh',       phone: '9001112334', email: 'anita.s@example.com' },
  { name: 'Gaurav Tiwari',      phone: '9001112335', email: null },
  { name: 'Ritu Sengupta',      phone: '9001112336', email: 'ritu.s@example.com' },
  { name: 'Vivek Ranjan',       phone: '9001112337', email: null },
  { name: 'Tanvi Desai',        phone: '9001112338', email: 'tanvi.d@example.com' },
  { name: 'Sandeep Yadav',      phone: '9001112339', email: null },
  { name: 'Kriti Agarwal',      phone: '9001112340', email: 'kriti.a@example.com' },
  { name: 'Mohit Bhardwaj',     phone: '9001112341', email: null },
  { name: 'Sakshi Pandey',      phone: '9001112342', email: 'sakshi.p@example.com' },
  // Extra slots for --customers > 32
  { name: 'Devansh Trivedi',    phone: '9001112343', email: null },
  { name: 'Smita Khurana',      phone: '9001112344', email: 'smita.k@example.com' },
];

// ─── Order-line catalogue (cafe items, no exotic prices) ──────────────────────
const ITEMS = [
  { name: 'Cappuccino',           price: 180 },
  { name: 'Latte',                price: 200 },
  { name: 'Cold Coffee',          price: 220 },
  { name: 'Espresso',             price: 150 },
  { name: 'Masala Chai',          price:  80 },
  { name: 'Croissant — Plain',    price: 140 },
  { name: 'Croissant — Almond',   price: 180 },
  { name: 'Veg Sandwich',         price: 220 },
  { name: 'Grilled Cheese',       price: 240 },
  { name: 'Pasta Arrabbiata',     price: 320 },
  { name: 'Pasta Alfredo',        price: 360 },
  { name: 'Margherita Pizza',     price: 380 },
  { name: 'Farmhouse Pizza',      price: 480 },
  { name: 'Chocolate Brownie',    price: 180 },
  { name: 'Cheesecake Slice',     price: 240 },
  { name: 'Tiramisu',             price: 280 },
  { name: 'Fresh Lime Soda',      price: 120 },
  { name: 'Mango Smoothie',       price: 220 },
];

// Random helpers
const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const pick = (arr) => arr[rand(0, arr.length - 1)];

// Generate a basket of items that totals close to `target`. We pick random
// items, then scale quantities so the basket lands within ±5% of target.
function basketForAmount(target) {
  // Pick 2-4 items at random
  const linesCount = rand(2, 4);
  const lines = [];
  for (let i = 0; i < linesCount; i++) {
    const item = pick(ITEMS);
    lines.push({ name: item.name, price: item.price, quantity: 1 });
  }
  const baseTotal = lines.reduce((s, l) => s + l.price * l.quantity, 0);
  // Scale quantities so total ~ target
  const scale = target / baseTotal;
  for (const l of lines) {
    l.quantity = Math.max(1, Math.round(l.quantity * scale));
  }
  return lines;
}

// Split a target lifetime spend across N invoices. Each invoice ~ target/N
// with ±20% jitter; the last invoice absorbs rounding so the sum is exact.
function splitAcrossInvoices(target, n) {
  const splits = [];
  let remaining = target;
  for (let i = 0; i < n - 1; i++) {
    const ideal = remaining / (n - i);
    const jitter = ideal * (0.8 + Math.random() * 0.4); // 80%-120% of ideal
    const amt = Math.max(200, Math.round(jitter / 50) * 50); // round to ₹50
    splits.push(Math.min(amt, remaining - (n - i - 1) * 200));
    remaining -= splits[splits.length - 1];
  }
  splits.push(Math.max(200, Math.round(remaining)));
  return splits;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Plan: assign every customer a tier + target lifetime spend ──────────────
function buildPlan() {
  const customers = DEMO_CUSTOMERS.slice(0, TOTAL);
  const plan = [];
  let idx = 0;
  // Gold
  for (let i = 0; i < N_GOLD && idx < customers.length; i++, idx++) {
    const target = rand(52000, 90000);
    const invoices = rand(6, 10);
    plan.push({ ...customers[idx], targetTier: 'GOLD', target, invoices });
  }
  // Silver
  for (let i = 0; i < N_SILVER && idx < customers.length; i++, idx++) {
    // Mix: some at low Silver (~12k) and some near-Gold (~45k) for richer chart
    const target = i % 3 === 0 ? rand(40000, 49000) : rand(11000, 28000);
    const invoices = rand(3, 6);
    plan.push({ ...customers[idx], targetTier: 'SILVER', target, invoices });
  }
  // Bronze
  for (let i = 0; i < N_BRONZE && idx < customers.length; i++, idx++) {
    // Mix: some near-Silver (~9k) and some brand new (~500-2k)
    const target = i % 4 === 0 ? rand(7500, 9800) : rand(400, 5000);
    const invoices = i % 4 === 0 ? rand(2, 4) : rand(1, 2);
    plan.push({ ...customers[idx], targetTier: 'BRONZE', target, invoices });
  }
  return plan;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🚀 Atithi-Setu Loyalty Demo Seeder`);
  console.log(`────────────────────────────────────`);
  console.log(`Server      : ${SERVER}`);
  console.log(`Auth mode   : ${authMode}`);
  console.log(`Distribution: ${N_GOLD} Gold · ${N_SILVER} Silver · ${N_BRONZE} Bronze (total ${N_GOLD + N_SILVER + N_BRONZE})`);
  if (DRY_RUN) console.log(`Mode        : DRY-RUN (no API calls)`);
  console.log();

  let token, restaurantId;
  try {
    const auth = await authenticate();
    token = auth.token; restaurantId = auth.restaurantId || RESTAURANT_ARG;
    console.log(`✓ Authenticated. Restaurant ID: ${restaurantId}`);
  } catch (err) {
    console.error(`❌ Auth failed: ${err.message}`);
    process.exit(1);
  }

  if (!restaurantId) {
    console.error('❌ Could not determine restaurant ID. Pass --restaurant.');
    process.exit(1);
  }

  // Sanity: verify the loyalty endpoint is live for this tenant
  if (!DRY_RUN) {
    const ping = await jsonGet(`${SERVER}/api/restaurant/${restaurantId}/loyalty/tiers`, token);
    if (ping.status !== 200) {
      console.error(`❌ /loyalty/tiers returned ${ping.status} — is the deployed build at loyalty-v1-tier-based or later?`);
      console.error(`   Response: ${ping.raw.slice(0, 200)}`);
      process.exit(1);
    }
    console.log(`✓ Loyalty API reachable. Configured tiers: ${(ping.data || []).map(t => `${t.name}(₹${t.min_lifetime_spend}+)`).join(', ') || 'none'}\n`);
  }

  const plan = buildPlan();
  const summary = { gold: 0, silver: 0, bronze: 0, invoices: 0, failures: 0 };

  for (const c of plan) {
    const splits = splitAcrossInvoices(c.target, c.invoices);
    const tag = c.targetTier.padEnd(6);
    console.log(`[${tag}] ${c.name.padEnd(22)} ${c.phone}  target ₹${c.target.toLocaleString('en-IN')} across ${c.invoices} invoice(s)`);
    for (const amt of splits) {
      if (DRY_RUN) {
        summary.invoices++;
        continue;
      }
      const lines = basketForAmount(amt);
      const total = lines.reduce((s, l) => s + l.price * l.quantity, 0);
      const res = await jsonPost(`${SERVER}/api/restaurant/${restaurantId}/invoices/manual`, token, {
        customer_name : c.name,
        customer_phone: c.phone,
        reference     : `LOYALTY-SEED`,
        items         : lines,
        discount_amount: 0,
        service_charge_percent: 0,
        gst_percent   : 5,
        apply_gst     : 1,
      });
      if (res.status === 200) {
        summary.invoices++;
      } else {
        summary.failures++;
        console.log(`   ⚠ invoice failed (${res.status}): ${res.raw.slice(0, 120)}`);
      }
      // Tiny pause so the loyalty hook can flush + avoid hitting any rate limits
      await delay(120);
    }
    summary[c.targetTier.toLowerCase()]++;
  }

  console.log(`\n✅ Done.`);
  console.log(`   Customers seeded  : ${summary.gold + summary.silver + summary.bronze}`);
  console.log(`     Gold            : ${summary.gold}`);
  console.log(`     Silver          : ${summary.silver}`);
  console.log(`     Bronze          : ${summary.bronze}`);
  console.log(`   Invoices created  : ${summary.invoices}`);
  if (summary.failures) console.log(`   ⚠ Failures        : ${summary.failures}`);

  if (!DRY_RUN) {
    // Verify by reading back the analytics
    const an = await jsonGet(`${SERVER}/api/restaurant/${restaurantId}/loyalty/analytics`, token);
    if (an.status === 200) {
      console.log(`\n📊 Loyalty analytics (live readback):`);
      for (const t of (an.data?.tiers || [])) {
        console.log(`   ${String(t.name).padEnd(8)} · ${t.members} members · ₹${Number(t.revenue || 0).toLocaleString('en-IN')} revenue`);
      }
    }
    console.log(`\nNext steps:`);
    console.log(`  1. Log in to ${SERVER} as the owner of ${restaurantId}`);
    console.log(`  2. Open the LOYALTY tab from the dashboard nav bar`);
    console.log(`  3. Click the CUSTOMERS sub-tab → sort by Total Spent → see Gold members at the top`);
    console.log(`  4. Click ANALYTICS → bar chart shows the distribution, KPI cards show totals`);
  }
})().catch(err => { console.error(err); process.exit(1); });
