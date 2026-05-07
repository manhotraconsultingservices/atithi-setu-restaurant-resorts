#!/usr/bin/env node
/**
 * Atithi-Setu — Tier-2/3 Inventory Demo Seed
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Layers Tier-2 + Tier-3 + QOL demo data onto a tenant that already has
 * `seed-inventory-demo.cjs` run. Adds:
 *
 *   • 6 seasonality factors (weekend boost, monsoon bumps, Diwali date range)
 *   • 4 customised notification templates (STOCK_LOW, STOCK_CRITICAL, …)
 *   • 8 hotel inventory items (linens, mini-bar, amenity restocking)
 *   • 2 extra storage locations (Walk-in cooler, Bar)
 *
 * stock_batches and supplier_prices populate automatically from existing
 * GRN data — no explicit seed needed.
 *
 * Usage:
 *   node scripts/seed-inventory-tier2.cjs \
 *     --server https://<tenant-slug>.atithi-setu.com \
 *     --email <owner-email> --password <pw>
 *
 * Or with admin auth:
 *   node scripts/seed-inventory-tier2.cjs \
 *     --server https://<tenant-slug>.atithi-setu.com \
 *     --admin-login admin@atithi-setu.com --admin-password <pw> \
 *     --restaurant RESTO-1003
 */

'use strict';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

const SERVER = (flag('server') || 'http://localhost:3001').replace(/\/$/, '');
const EMAIL = flag('email');
const PASSWORD = flag('password');
const TOKEN_OPT = flag('token');
const RESTAURANT_OPT = flag('restaurant');
const ADMIN_LOGIN = flag('admin-login');
const ADMIN_PW = flag('admin-password');

async function api(method, path, body, token) {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

async function getAuth() {
  if (TOKEN_OPT && RESTAURANT_OPT) {
    return { token: TOKEN_OPT, restaurantId: RESTAURANT_OPT };
  }
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
  throw new Error('Provide --email + --password, OR --token + --restaurant, OR --admin-login + --admin-password + --restaurant');
}

const SEASONALITY = [
  { type: 'WEEKDAY', key: '6', multiplier: 1.4, label: 'Saturday rush' },
  { type: 'WEEKDAY', key: '0', multiplier: 1.3, label: 'Sunday brunch' },
  { type: 'WEEKDAY', key: '1', multiplier: 0.7, label: 'Monday slow day' },
  { type: 'MONTH', key: '7', multiplier: 1.2, label: 'July monsoon comfort food' },
  { type: 'DATE', key: '11-12', multiplier: 2.0, label: 'Diwali sweets demand (annual)' },
  { type: 'RANGE', key: `${new Date().getFullYear()}-12-20..${new Date().getFullYear()}-12-31`, multiplier: 1.5, label: 'Christmas / New Year week' },
];

const TEMPLATES = [
  {
    event_type: 'STOCK_LOW',
    subject_template: '🟡 {{ingredient}} running low — {{restaurantName}}',
    body_template:
      'Heads-up: {{ingredient}} is below the reorder point.\n\n' +
      'Current balance: {{balance}}\n' +
      'Days of cover: {{daysOfCover}}\n' +
      'Default supplier: {{supplierName}} ({{supplierPhone}})\n\n' +
      'Open the Inventory tab to raise a Purchase Order.',
    enabled: true,
  },
  {
    event_type: 'STOCK_CRITICAL',
    subject_template: '🔴 URGENT: {{ingredient}} will run out — {{restaurantName}}',
    body_template:
      '{{ingredient}} balance ({{balance}}) is below the next-delivery lead time.\n\n' +
      'Lead time: {{leadTimeDays}} day(s)\n' +
      'Daily forecast: {{dailyForecast}}\n' +
      'Supplier: {{supplierName}} ({{supplierPhone}})\n\n' +
      'Place an emergency order or risk stocking out.',
    enabled: true,
  },
  {
    event_type: 'PO_DELIVERY_DUE_TODAY',
    subject_template: '📦 PO {{poId}} arriving today — {{restaurantName}}',
    body_template: 'Purchase Order {{poId}} from {{supplierName}} is expected today.\nMark as received via the Goods Receipts tab when it arrives.',
    enabled: true,
  },
  {
    event_type: 'PHYSICAL_COUNT_DUE',
    subject_template: '🗒️ Weekly stock count due — {{restaurantName}}',
    body_template: "It's been more than 7 days since the last completed count.\nA quick count keeps your forecasts and food-cost numbers accurate.",
    enabled: true,
  },
];

const HOTEL_ITEMS = [
  { name: 'Bath Towel — Large', category: 'Linen', unit: 'unit', current_stock_qty: 80, par_level: 100, reorder_point: 40, default_unit_price: 280 },
  { name: 'Hand Towel', category: 'Linen', unit: 'unit', current_stock_qty: 120, par_level: 150, reorder_point: 60, default_unit_price: 90 },
  { name: 'Bedsheet — Queen', category: 'Linen', unit: 'unit', current_stock_qty: 45, par_level: 60, reorder_point: 25, default_unit_price: 600 },
  { name: 'Pillow Cover', category: 'Linen', unit: 'unit', current_stock_qty: 100, par_level: 120, reorder_point: 50, default_unit_price: 120 },
  { name: 'Mini Water 500ml', category: 'Mini-bar', unit: 'bottle', current_stock_qty: 60, par_level: 100, reorder_point: 40, default_unit_price: 18 },
  { name: 'Mini Soft Drink', category: 'Mini-bar', unit: 'can', current_stock_qty: 40, par_level: 80, reorder_point: 30, default_unit_price: 35 },
  { name: 'Shampoo Sachet', category: 'Amenity', unit: 'sachet', current_stock_qty: 200, par_level: 300, reorder_point: 100, default_unit_price: 4 },
  { name: 'Soap Bar — 35g', category: 'Amenity', unit: 'unit', current_stock_qty: 150, par_level: 250, reorder_point: 80, default_unit_price: 8 },
];

const LOCATIONS = [
  { name: 'Walk-in Cooler', kind: 'WALKIN' },
  { name: 'Bar Storage', kind: 'BAR' },
];

async function run() {
  console.log(`▶ Connecting to ${SERVER}…`);
  const { token, restaurantId } = await getAuth();
  console.log(`✓ Authenticated as restaurant ${restaurantId}`);

  // 1. Seasonality factors
  let added = 0;
  for (const f of SEASONALITY) {
    try {
      await api('POST', `/api/restaurant/${restaurantId}/inventory/seasonality`, f, token);
      added++;
    } catch (e) {
      console.warn(`  · seasonality "${f.label}" skipped: ${e.message.slice(0, 80)}`);
    }
  }
  console.log(`✓ Seeded ${added}/${SEASONALITY.length} seasonality factors`);

  // 2. Notification templates
  let tplOk = 0;
  for (const t of TEMPLATES) {
    try {
      await api('PUT', `/api/restaurant/${restaurantId}/notification-templates/${encodeURIComponent(t.event_type)}`, {
        subject_template: t.subject_template,
        body_template: t.body_template,
        enabled: t.enabled,
      }, token);
      tplOk++;
    } catch (e) {
      console.warn(`  · template ${t.event_type} skipped: ${e.message.slice(0, 80)}`);
    }
  }
  console.log(`✓ Seeded ${tplOk}/${TEMPLATES.length} notification templates`);

  // 3. Hotel inventory
  let hotelOk = 0;
  for (const item of HOTEL_ITEMS) {
    try {
      await api('POST', `/api/restaurant/${restaurantId}/hotel-inventory`, item, token);
      hotelOk++;
    } catch (e) {
      console.warn(`  · hotel item "${item.name}" skipped: ${e.message.slice(0, 80)}`);
    }
  }
  console.log(`✓ Seeded ${hotelOk}/${HOTEL_ITEMS.length} hotel inventory items`);

  // 4. Storage locations
  let locOk = 0;
  for (const l of LOCATIONS) {
    try {
      await api('POST', `/api/restaurant/${restaurantId}/storage-locations`, l, token);
      locOk++;
    } catch (e) {
      console.warn(`  · location "${l.name}" skipped: ${e.message.slice(0, 80)}`);
    }
  }
  console.log(`✓ Seeded ${locOk}/${LOCATIONS.length} extra storage locations`);

  console.log(`\n✅ Tier-2/3 demo seed complete.\n` +
    `   Open the Inventory tab → Insights / Settings to explore.\n`);
}

run().catch(err => {
  console.error('\n❌ Seed failed:', err.message);
  process.exit(1);
});
