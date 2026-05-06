#!/usr/bin/env node
/**
 * Atithi-Setu — Inventory Demo Seed
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Populates a tenant with production-grade inventory data so the Inventory
 * module can be demoed end-to-end:
 *
 *   • ~35 ingredients across 8 categories with realistic Indian-restaurant
 *     pricing, units, reorder + par levels, GST
 *   • 5 suppliers (Hari Dairy, Khan Poultry, Mandi Daily, Aggarwal Wholesale,
 *     Coca-Cola Distributor) with lead times + payment terms
 *   • Recipes mapped onto the tenant's actual menu items by heuristic (Butter
 *     Chicken → chicken+butter+cream+spices, etc.)
 *   • 3 Purchase Orders (DRAFT, SENT, PARTIAL with linked GRN)
 *   • 2 Goods Receipts (one linked to PO, one ad-hoc)
 *   • 5 Wastage logs (mix of SPOILAGE / BURN / EXPIRY across categories)
 *   • 1 Physical Count (started with snapshot, partial actuals filled)
 *
 * After this seeds, owners can place a customer order and watch stock
 * decrement live; cancel and watch it revert; log wastage; reconcile counts.
 *
 * Usage:
 *   node scripts/seed-inventory-demo.cjs \
 *     --email <owner-email> --password <pw> \
 *     --server https://cloud-kitchen.atithi-setu.com
 *
 * For Vivek's Cafe:
 *   node scripts/seed-inventory-demo.cjs \
 *     --email <owner-email> --password <pw> \
 *     --server https://rishu-kitchen.atithi-setu.com \
 *     --restaurant RESTO-1003
 *
 * Auth modes (mirrors menu_import.cjs / seed-cloud-kitchen.cjs):
 *   --email / --password           Owner login
 *   --token / --restaurant         Pre-copied JWT
 *   --admin-login / --admin-password / --restaurant   Super-admin scoped token
 *   --login-id / --password / --restaurant            Staff login
 *
 * Skip flags:
 *   --skip-ingredients     Don't add ingredients
 *   --skip-suppliers       Don't add suppliers
 *   --skip-recipes         Don't build recipes
 *   --skip-procurement     Don't create POs/GRNs
 *   --skip-wastage         Don't log wastage
 *   --skip-count           Don't start a physical count
 *   --dry-run              Log everything but no API writes
 */

'use strict';

const http  = require('http');
const https = require('https');

// ─── CLI parsing ──────────────────────────────────────────────────────────────
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
const SKIP_INGRED    = hasFlag('--skip-ingredients');
const SKIP_SUPP      = hasFlag('--skip-suppliers');
const SKIP_RECIPES   = hasFlag('--skip-recipes');
const SKIP_PROC      = hasFlag('--skip-procurement');
const SKIP_WASTAGE   = hasFlag('--skip-wastage');
const SKIP_COUNT     = hasFlag('--skip-count');

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

if (!authMode) { console.error('❌  No authentication. Run with --help.'); process.exit(1); }
if (['token','superadmin','stafflogin'].includes(authMode) && !RESTAURANT_ARG) {
  console.error(`❌  --restaurant required for ${authMode} mode.`); process.exit(1);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const lib    = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const r = lib.request({
      hostname: parsed.hostname, port: parsed.port || (url.startsWith('https') ? 443 : 80),
      path: parsed.pathname + parsed.search, method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function jget(url, token) {
  const r = await request(url, { method: 'GET', headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
  let parsed = null; try { parsed = JSON.parse(r.body); } catch {}
  return { status: r.status, data: parsed, raw: r.body };
}
async function jpost(url, token, body) {
  const r = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) } }, JSON.stringify(body));
  let parsed = null; try { parsed = JSON.parse(r.body); } catch {}
  return { status: r.status, data: parsed, raw: r.body };
}
async function jpatch(url, token, body) {
  const r = await request(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) } }, JSON.stringify(body));
  let parsed = null; try { parsed = JSON.parse(r.body); } catch {}
  return { status: r.status, data: parsed, raw: r.body };
}

// ─── Ingredient catalog ───────────────────────────────────────────────────────
const INGREDIENTS = [
  // Dairy (all RAW)
  { name: 'Paneer',           item_type: 'RAW',      category: 'Dairy',         unit: 'kg', current_stock_qty: 5,  reorder_point: 1,   par_level: 5,  default_unit_price: 400, gst_percent: 5  },
  { name: 'Curd',             item_type: 'RAW',      category: 'Dairy',         unit: 'kg', current_stock_qty: 4,  reorder_point: 2,   par_level: 8,  default_unit_price: 80,  gst_percent: 5  },
  { name: 'Milk',             item_type: 'RAW',      category: 'Dairy',         unit: 'l',  current_stock_qty: 15, reorder_point: 5,   par_level: 20, default_unit_price: 65,  gst_percent: 5  },
  { name: 'Cream',            item_type: 'RAW',      category: 'Dairy',         unit: 'l',  current_stock_qty: 3,  reorder_point: 1,   par_level: 5,  default_unit_price: 200, gst_percent: 5  },
  { name: 'Butter',           item_type: 'RAW',      category: 'Dairy',         unit: 'kg', current_stock_qty: 3,  reorder_point: 1,   par_level: 5,  default_unit_price: 500, gst_percent: 12 },
  { name: 'Ghee',             item_type: 'RAW',      category: 'Dairy',         unit: 'l',  current_stock_qty: 4,  reorder_point: 1,   par_level: 5,  default_unit_price: 600, gst_percent: 12 },

  // Meat
  { name: 'Chicken (boneless)', item_type: 'RAW',    category: 'Meat',          unit: 'kg', current_stock_qty: 8,  reorder_point: 2,   par_level: 12, default_unit_price: 280, gst_percent: 0 },
  { name: 'Mutton',           item_type: 'RAW',      category: 'Meat',          unit: 'kg', current_stock_qty: 4,  reorder_point: 1,   par_level: 6,  default_unit_price: 650, gst_percent: 0 },
  { name: 'Eggs',             item_type: 'RAW',      category: 'Meat',          unit: 'unit',current_stock_qty: 60, reorder_point: 24, par_level: 96, default_unit_price: 7,   gst_percent: 0 },

  // Produce
  { name: 'Onion',            item_type: 'RAW',      category: 'Produce',       unit: 'kg', current_stock_qty: 20, reorder_point: 5,   par_level: 25, default_unit_price: 40,  gst_percent: 0 },
  { name: 'Tomato',           item_type: 'RAW',      category: 'Produce',       unit: 'kg', current_stock_qty: 18, reorder_point: 5,   par_level: 20, default_unit_price: 50,  gst_percent: 0 },
  { name: 'Potato',           item_type: 'RAW',      category: 'Produce',       unit: 'kg', current_stock_qty: 15, reorder_point: 5,   par_level: 20, default_unit_price: 35,  gst_percent: 0 },
  { name: 'Capsicum',         item_type: 'RAW',      category: 'Produce',       unit: 'kg', current_stock_qty: 6,  reorder_point: 2,   par_level: 8,  default_unit_price: 80,  gst_percent: 0 },
  { name: 'Spinach',          item_type: 'RAW',      category: 'Produce',       unit: 'kg', current_stock_qty: 4,  reorder_point: 1,   par_level: 5,  default_unit_price: 60,  gst_percent: 0 },
  { name: 'Ginger',           item_type: 'RAW',      category: 'Produce',       unit: 'kg', current_stock_qty: 2,  reorder_point: 1,   par_level: 3,  default_unit_price: 120, gst_percent: 0 },
  { name: 'Garlic',           item_type: 'RAW',      category: 'Produce',       unit: 'kg', current_stock_qty: 2,  reorder_point: 1,   par_level: 3,  default_unit_price: 200, gst_percent: 0 },
  { name: 'Green Chilli',     item_type: 'RAW',      category: 'Produce',       unit: 'kg', current_stock_qty: 2,  reorder_point: 0.5, par_level: 3,  default_unit_price: 80,  gst_percent: 0 },
  { name: 'Coriander',        item_type: 'RAW',      category: 'Produce',       unit: 'kg', current_stock_qty: 2,  reorder_point: 0.5, par_level: 3,  default_unit_price: 40,  gst_percent: 0 },
  { name: 'Lemon',            item_type: 'RAW',      category: 'Produce',       unit: 'kg', current_stock_qty: 3,  reorder_point: 1,   par_level: 5,  default_unit_price: 80,  gst_percent: 0 },

  // Grains
  { name: 'Basmati Rice',     item_type: 'RAW',      category: 'Grains',        unit: 'kg', current_stock_qty: 25, reorder_point: 5,   par_level: 30, default_unit_price: 120, gst_percent: 5 },
  { name: 'Wheat Flour',      item_type: 'RAW',      category: 'Grains',        unit: 'kg', current_stock_qty: 20, reorder_point: 5,   par_level: 25, default_unit_price: 50,  gst_percent: 5 },
  { name: 'Maida (Refined Flour)', item_type: 'RAW', category: 'Grains',       unit: 'kg', current_stock_qty: 10, reorder_point: 2,   par_level: 12, default_unit_price: 55,  gst_percent: 5 },
  { name: 'Toor Dal',         item_type: 'RAW',      category: 'Grains',        unit: 'kg', current_stock_qty: 8,  reorder_point: 2,   par_level: 10, default_unit_price: 150, gst_percent: 5 },
  { name: 'Chana Dal',        item_type: 'RAW',      category: 'Grains',        unit: 'kg', current_stock_qty: 6,  reorder_point: 2,   par_level: 8,  default_unit_price: 100, gst_percent: 5 },
  { name: 'Rajma',            item_type: 'RAW',      category: 'Grains',        unit: 'kg', current_stock_qty: 5,  reorder_point: 1,   par_level: 6,  default_unit_price: 180, gst_percent: 5 },

  // Oils & Fats
  { name: 'Refined Oil',      item_type: 'RAW',      category: 'Oils & Fats',   unit: 'l',  current_stock_qty: 20, reorder_point: 5,   par_level: 25, default_unit_price: 160, gst_percent: 5 },
  { name: 'Mustard Oil',      item_type: 'RAW',      category: 'Oils & Fats',   unit: 'l',  current_stock_qty: 4,  reorder_point: 1,   par_level: 5,  default_unit_price: 180, gst_percent: 5 },

  // Spices
  { name: 'Salt',             item_type: 'RAW',      category: 'Spices',        unit: 'kg', current_stock_qty: 5,  reorder_point: 1,   par_level: 5,  default_unit_price: 25,  gst_percent: 0 },
  { name: 'Sugar',            item_type: 'RAW',      category: 'Spices',        unit: 'kg', current_stock_qty: 8,  reorder_point: 2,   par_level: 10, default_unit_price: 50,  gst_percent: 5 },
  { name: 'Garam Masala',     item_type: 'RAW',      category: 'Spices',        unit: 'kg', current_stock_qty: 1.5,reorder_point: 0.3, par_level: 2,  default_unit_price: 400, gst_percent: 5 },
  { name: 'Red Chilli Powder',item_type: 'RAW',      category: 'Spices',        unit: 'kg', current_stock_qty: 1.2,reorder_point: 0.3, par_level: 2,  default_unit_price: 250, gst_percent: 5 },
  { name: 'Turmeric',         item_type: 'RAW',      category: 'Spices',        unit: 'kg', current_stock_qty: 1,  reorder_point: 0.3, par_level: 2,  default_unit_price: 200, gst_percent: 5 },
  { name: 'Cumin Seeds',      item_type: 'RAW',      category: 'Spices',        unit: 'kg', current_stock_qty: 1,  reorder_point: 0.3, par_level: 2,  default_unit_price: 400, gst_percent: 5 },

  // Packaged (sold direct, no recipe)
  { name: 'Mineral Water 1L',     item_type: 'PACKAGED', category: 'Beverages', unit: 'bottle', current_stock_qty: 36, reorder_point: 12, par_level: 48, default_unit_price: 20, gst_percent: 18 },
  { name: 'Coca-Cola 600ml',      item_type: 'PACKAGED', category: 'Beverages', unit: 'bottle', current_stock_qty: 30, reorder_point: 12, par_level: 48, default_unit_price: 40, gst_percent: 28 },
  { name: 'Sprite 600ml',         item_type: 'PACKAGED', category: 'Beverages', unit: 'bottle', current_stock_qty: 24, reorder_point: 12, par_level: 36, default_unit_price: 40, gst_percent: 28 },
];

// ─── Supplier directory ──────────────────────────────────────────────────────
const SUPPLIERS = [
  { name: 'Hari Dairy',           contact_name: 'Hari Singh',     phone: '+91 98765 11001', email: 'hari@haridairy.in',          gst_number: '07AAACR1001A1Z1', address: 'Sector 14, Gurgaon',   lead_time_days: 1, payment_terms: 'NET-7'  },
  { name: 'Khan Poultry',         contact_name: 'Salim Khan',     phone: '+91 98765 11002', email: 'salim@khanpoultry.in',       gst_number: '07AAACR1001A1Z2', address: 'Old Delhi Mandi',     lead_time_days: 1, payment_terms: 'COD'    },
  { name: 'Mandi Daily',          contact_name: 'Ram Kumar',      phone: '+91 98765 11003', email: 'ram@mandidaily.in',          gst_number: null,              address: 'Azadpur Mandi',       lead_time_days: 1, payment_terms: 'COD'    },
  { name: 'Aggarwal Wholesale',   contact_name: 'Ankit Aggarwal', phone: '+91 98765 11004', email: 'ankit@aggarwalwholesale.in', gst_number: '07AAACR1001A1Z4', address: 'Khari Baoli, Delhi',  lead_time_days: 3, payment_terms: 'NET-15' },
  { name: 'Coca-Cola Distributor',contact_name: 'Vijay Sharma',   phone: '+91 98765 11005', email: 'vijay@cokedist.in',          gst_number: '07AAACR1001A1Z5', address: 'Industrial Area, Noida', lead_time_days: 7, payment_terms: 'NET-30' },
];

// Map supplier-name → which ingredient categories they typically supply.
// Used when seeding POs / GRNs and as the default_supplier_id on ingredients.
const SUPPLIER_CATEGORY_MAP = {
  'Hari Dairy':            ['Dairy'],
  'Khan Poultry':          ['Meat'],
  'Mandi Daily':           ['Produce'],
  'Aggarwal Wholesale':    ['Grains', 'Oils & Fats', 'Spices'],
  'Coca-Cola Distributor': ['Beverages'],
};

// ─── Recipe templates — heuristic matching by menu-item name ──────────────────
// Each template is { match: regex, items: [{ name, qty, unit }, ...] }
// First match wins. If nothing matches, no recipe is added (silent skip).
const RECIPE_TEMPLATES = [
  // Biryani family
  { match: /(chicken|murgh).*biryani/i, items: [
    { name: 'Chicken (boneless)', qty: 200, unit: 'g' }, { name: 'Basmati Rice', qty: 200, unit: 'g' },
    { name: 'Onion', qty: 80, unit: 'g' }, { name: 'Curd', qty: 50, unit: 'g' },
    { name: 'Ghee', qty: 20, unit: 'ml' }, { name: 'Garam Masala', qty: 5, unit: 'g' },
    { name: 'Salt', qty: 3, unit: 'g' }, { name: 'Ginger', qty: 5, unit: 'g' }, { name: 'Garlic', qty: 5, unit: 'g' },
  ]},
  { match: /(mutton|gosht).*biryani/i, items: [
    { name: 'Mutton', qty: 200, unit: 'g' }, { name: 'Basmati Rice', qty: 200, unit: 'g' },
    { name: 'Onion', qty: 80, unit: 'g' }, { name: 'Curd', qty: 50, unit: 'g' },
    { name: 'Ghee', qty: 25, unit: 'ml' }, { name: 'Garam Masala', qty: 6, unit: 'g' },
    { name: 'Salt', qty: 3, unit: 'g' }, { name: 'Ginger', qty: 5, unit: 'g' }, { name: 'Garlic', qty: 5, unit: 'g' },
  ]},
  { match: /(veg|vegetable).*biryani/i, items: [
    { name: 'Basmati Rice', qty: 200, unit: 'g' }, { name: 'Potato', qty: 60, unit: 'g' },
    { name: 'Onion', qty: 80, unit: 'g' }, { name: 'Capsicum', qty: 40, unit: 'g' }, { name: 'Curd', qty: 50, unit: 'g' },
    { name: 'Ghee', qty: 20, unit: 'ml' }, { name: 'Garam Masala', qty: 5, unit: 'g' }, { name: 'Salt', qty: 3, unit: 'g' },
  ]},
  { match: /egg.*biryani/i, items: [
    { name: 'Eggs', qty: 2, unit: 'unit' }, { name: 'Basmati Rice', qty: 200, unit: 'g' },
    { name: 'Onion', qty: 70, unit: 'g' }, { name: 'Curd', qty: 40, unit: 'g' },
    { name: 'Ghee', qty: 15, unit: 'ml' }, { name: 'Garam Masala', qty: 4, unit: 'g' }, { name: 'Salt', qty: 3, unit: 'g' },
  ]},
  // Plain rice
  { match: /jeera rice/i, items: [
    { name: 'Basmati Rice', qty: 150, unit: 'g' }, { name: 'Cumin Seeds', qty: 3, unit: 'g' },
    { name: 'Ghee', qty: 10, unit: 'ml' }, { name: 'Salt', qty: 2, unit: 'g' },
  ]},
  { match: /steamed.*rice|plain rice/i, items: [
    { name: 'Basmati Rice', qty: 150, unit: 'g' }, { name: 'Salt', qty: 2, unit: 'g' },
  ]},
  { match: /curd rice/i, items: [
    { name: 'Basmati Rice', qty: 120, unit: 'g' }, { name: 'Curd', qty: 100, unit: 'g' }, { name: 'Salt', qty: 2, unit: 'g' },
  ]},

  // Curries — Non-veg
  { match: /butter chicken/i, items: [
    { name: 'Chicken (boneless)', qty: 200, unit: 'g' }, { name: 'Tomato', qty: 100, unit: 'g' },
    { name: 'Butter', qty: 30, unit: 'g' }, { name: 'Cream', qty: 50, unit: 'ml' },
    { name: 'Onion', qty: 50, unit: 'g' }, { name: 'Garam Masala', qty: 4, unit: 'g' }, { name: 'Salt', qty: 3, unit: 'g' },
    { name: 'Ginger', qty: 5, unit: 'g' }, { name: 'Garlic', qty: 5, unit: 'g' }, { name: 'Refined Oil', qty: 10, unit: 'ml' },
  ]},
  { match: /chicken tikka masala/i, items: [
    { name: 'Chicken (boneless)', qty: 220, unit: 'g' }, { name: 'Tomato', qty: 100, unit: 'g' },
    { name: 'Onion', qty: 80, unit: 'g' }, { name: 'Curd', qty: 30, unit: 'g' }, { name: 'Cream', qty: 30, unit: 'ml' },
    { name: 'Garam Masala', qty: 5, unit: 'g' }, { name: 'Salt', qty: 3, unit: 'g' },
    { name: 'Ginger', qty: 5, unit: 'g' }, { name: 'Garlic', qty: 5, unit: 'g' }, { name: 'Refined Oil', qty: 20, unit: 'ml' },
  ]},
  { match: /(chicken|murgh) korma/i, items: [
    { name: 'Chicken (boneless)', qty: 200, unit: 'g' }, { name: 'Onion', qty: 100, unit: 'g' },
    { name: 'Curd', qty: 50, unit: 'g' }, { name: 'Cream', qty: 30, unit: 'ml' },
    { name: 'Garam Masala', qty: 5, unit: 'g' }, { name: 'Salt', qty: 3, unit: 'g' },
    { name: 'Ginger', qty: 5, unit: 'g' }, { name: 'Garlic', qty: 5, unit: 'g' }, { name: 'Refined Oil', qty: 25, unit: 'ml' },
  ]},
  { match: /mutton.*(rogan josh|curry)/i, items: [
    { name: 'Mutton', qty: 220, unit: 'g' }, { name: 'Onion', qty: 80, unit: 'g' }, { name: 'Tomato', qty: 60, unit: 'g' },
    { name: 'Curd', qty: 60, unit: 'g' }, { name: 'Garam Masala', qty: 6, unit: 'g' },
    { name: 'Red Chilli Powder', qty: 4, unit: 'g' }, { name: 'Salt', qty: 4, unit: 'g' },
    { name: 'Ginger', qty: 7, unit: 'g' }, { name: 'Garlic', qty: 7, unit: 'g' }, { name: 'Mustard Oil', qty: 30, unit: 'ml' },
  ]},
  { match: /(andhra|chettinad|spicy) chicken/i, items: [
    { name: 'Chicken (boneless)', qty: 220, unit: 'g' }, { name: 'Onion', qty: 100, unit: 'g' }, { name: 'Tomato', qty: 80, unit: 'g' },
    { name: 'Red Chilli Powder', qty: 6, unit: 'g' }, { name: 'Garam Masala', qty: 4, unit: 'g' }, { name: 'Salt', qty: 3, unit: 'g' },
    { name: 'Refined Oil', qty: 25, unit: 'ml' },
  ]},
  { match: /egg curry/i, items: [
    { name: 'Eggs', qty: 2, unit: 'unit' }, { name: 'Onion', qty: 100, unit: 'g' }, { name: 'Tomato', qty: 100, unit: 'g' },
    { name: 'Garam Masala', qty: 4, unit: 'g' }, { name: 'Salt', qty: 3, unit: 'g' }, { name: 'Refined Oil', qty: 15, unit: 'ml' },
  ]},

  // Curries — Veg
  { match: /paneer butter masala|butter paneer/i, items: [
    { name: 'Paneer', qty: 200, unit: 'g' }, { name: 'Tomato', qty: 100, unit: 'g' },
    { name: 'Butter', qty: 25, unit: 'g' }, { name: 'Cream', qty: 50, unit: 'ml' },
    { name: 'Onion', qty: 50, unit: 'g' }, { name: 'Garam Masala', qty: 4, unit: 'g' }, { name: 'Salt', qty: 3, unit: 'g' },
  ]},
  { match: /kadhai paneer|kadai paneer/i, items: [
    { name: 'Paneer', qty: 200, unit: 'g' }, { name: 'Capsicum', qty: 60, unit: 'g' }, { name: 'Onion', qty: 80, unit: 'g' },
    { name: 'Tomato', qty: 80, unit: 'g' }, { name: 'Garam Masala', qty: 4, unit: 'g' }, { name: 'Salt', qty: 3, unit: 'g' },
    { name: 'Refined Oil', qty: 15, unit: 'ml' },
  ]},
  { match: /palak paneer/i, items: [
    { name: 'Paneer', qty: 180, unit: 'g' }, { name: 'Spinach', qty: 200, unit: 'g' }, { name: 'Cream', qty: 30, unit: 'ml' },
    { name: 'Onion', qty: 40, unit: 'g' }, { name: 'Salt', qty: 3, unit: 'g' }, { name: 'Refined Oil', qty: 10, unit: 'ml' },
  ]},
  { match: /dal makhani/i, items: [
    { name: 'Rajma', qty: 50, unit: 'g' }, { name: 'Toor Dal', qty: 80, unit: 'g' }, { name: 'Butter', qty: 25, unit: 'g' },
    { name: 'Cream', qty: 30, unit: 'ml' }, { name: 'Tomato', qty: 80, unit: 'g' }, { name: 'Salt', qty: 3, unit: 'g' },
  ]},
  { match: /dal\s/i, items: [   // generic dal
    { name: 'Toor Dal', qty: 100, unit: 'g' }, { name: 'Onion', qty: 30, unit: 'g' }, { name: 'Tomato', qty: 50, unit: 'g' },
    { name: 'Salt', qty: 3, unit: 'g' }, { name: 'Refined Oil', qty: 10, unit: 'ml' },
  ]},
  { match: /chole|chana masala/i, items: [
    { name: 'Chana Dal', qty: 150, unit: 'g' }, { name: 'Onion', qty: 80, unit: 'g' }, { name: 'Tomato', qty: 80, unit: 'g' },
    { name: 'Garam Masala', qty: 5, unit: 'g' }, { name: 'Salt', qty: 3, unit: 'g' }, { name: 'Refined Oil', qty: 15, unit: 'ml' },
  ]},
  { match: /mix.*veg|mixed vegetable/i, items: [
    { name: 'Potato', qty: 80, unit: 'g' }, { name: 'Capsicum', qty: 40, unit: 'g' }, { name: 'Onion', qty: 50, unit: 'g' },
    { name: 'Tomato', qty: 50, unit: 'g' }, { name: 'Salt', qty: 3, unit: 'g' }, { name: 'Refined Oil', qty: 15, unit: 'ml' },
  ]},

  // Tandoor
  { match: /tandoori chicken/i, items: [
    { name: 'Chicken (boneless)', qty: 250, unit: 'g' }, { name: 'Curd', qty: 60, unit: 'g' },
    { name: 'Garam Masala', qty: 5, unit: 'g' }, { name: 'Red Chilli Powder', qty: 4, unit: 'g' }, { name: 'Salt', qty: 3, unit: 'g' },
    { name: 'Ginger', qty: 5, unit: 'g' }, { name: 'Garlic', qty: 5, unit: 'g' }, { name: 'Lemon', qty: 10, unit: 'g' },
  ]},
  { match: /chicken tikka(?! masala)/i, items: [
    { name: 'Chicken (boneless)', qty: 200, unit: 'g' }, { name: 'Curd', qty: 50, unit: 'g' },
    { name: 'Garam Masala', qty: 4, unit: 'g' }, { name: 'Red Chilli Powder', qty: 3, unit: 'g' }, { name: 'Salt', qty: 3, unit: 'g' },
  ]},
  { match: /paneer tikka/i, items: [
    { name: 'Paneer', qty: 200, unit: 'g' }, { name: 'Capsicum', qty: 50, unit: 'g' }, { name: 'Curd', qty: 40, unit: 'g' },
    { name: 'Garam Masala', qty: 3, unit: 'g' }, { name: 'Salt', qty: 2, unit: 'g' },
  ]},
  { match: /seekh kebab/i, items: [
    { name: 'Mutton', qty: 200, unit: 'g' }, { name: 'Onion', qty: 30, unit: 'g' },
    { name: 'Garam Masala', qty: 4, unit: 'g' }, { name: 'Ginger', qty: 5, unit: 'g' }, { name: 'Garlic', qty: 5, unit: 'g' }, { name: 'Salt', qty: 3, unit: 'g' },
  ]},
  { match: /hariyali/i, items: [
    { name: 'Chicken (boneless)', qty: 200, unit: 'g' }, { name: 'Spinach', qty: 60, unit: 'g' }, { name: 'Coriander', qty: 20, unit: 'g' },
    { name: 'Curd', qty: 40, unit: 'g' }, { name: 'Green Chilli', qty: 5, unit: 'g' }, { name: 'Salt', qty: 3, unit: 'g' },
  ]},

  // Breads
  { match: /butter naan/i, items: [
    { name: 'Maida (Refined Flour)', qty: 100, unit: 'g' }, { name: 'Curd', qty: 15, unit: 'g' },
    { name: 'Butter', qty: 8, unit: 'g' }, { name: 'Salt', qty: 1, unit: 'g' }, { name: 'Sugar', qty: 2, unit: 'g' },
  ]},
  { match: /garlic naan/i, items: [
    { name: 'Maida (Refined Flour)', qty: 100, unit: 'g' }, { name: 'Curd', qty: 15, unit: 'g' },
    { name: 'Butter', qty: 6, unit: 'g' }, { name: 'Garlic', qty: 5, unit: 'g' }, { name: 'Coriander', qty: 3, unit: 'g' },
    { name: 'Salt', qty: 1, unit: 'g' },
  ]},
  { match: /naan(?! )/i, items: [   // plain naan
    { name: 'Maida (Refined Flour)', qty: 100, unit: 'g' }, { name: 'Curd', qty: 15, unit: 'g' }, { name: 'Salt', qty: 1, unit: 'g' },
  ]},
  { match: /tandoori roti|^roti$/i, items: [
    { name: 'Wheat Flour', qty: 80, unit: 'g' }, { name: 'Salt', qty: 1, unit: 'g' },
  ]},
  { match: /lachha paratha/i, items: [
    { name: 'Wheat Flour', qty: 100, unit: 'g' }, { name: 'Ghee', qty: 15, unit: 'ml' }, { name: 'Salt', qty: 1, unit: 'g' },
  ]},
  { match: /(stuffed )?kulcha/i, items: [
    { name: 'Maida (Refined Flour)', qty: 100, unit: 'g' }, { name: 'Potato', qty: 50, unit: 'g' }, { name: 'Onion', qty: 20, unit: 'g' },
    { name: 'Salt', qty: 2, unit: 'g' }, { name: 'Butter', qty: 8, unit: 'g' },
  ]},

  // Indo-Chinese
  { match: /chicken.*(noodles|hakka|fried rice)/i, items: [
    { name: 'Chicken (boneless)', qty: 100, unit: 'g' }, { name: 'Onion', qty: 50, unit: 'g' }, { name: 'Capsicum', qty: 50, unit: 'g' },
    { name: 'Refined Oil', qty: 20, unit: 'ml' }, { name: 'Salt', qty: 2, unit: 'g' },
  ]},
  { match: /(veg|vegetable).*hakka noodles/i, items: [
    { name: 'Onion', qty: 60, unit: 'g' }, { name: 'Capsicum', qty: 60, unit: 'g' }, { name: 'Refined Oil', qty: 25, unit: 'ml' }, { name: 'Salt', qty: 2, unit: 'g' },
  ]},
  { match: /veg manchurian|manchurian/i, items: [
    { name: 'Maida (Refined Flour)', qty: 30, unit: 'g' }, { name: 'Onion', qty: 50, unit: 'g' }, { name: 'Capsicum', qty: 40, unit: 'g' },
    { name: 'Refined Oil', qty: 30, unit: 'ml' }, { name: 'Salt', qty: 2, unit: 'g' },
  ]},
  { match: /chilli paneer/i, items: [
    { name: 'Paneer', qty: 180, unit: 'g' }, { name: 'Capsicum', qty: 60, unit: 'g' }, { name: 'Onion', qty: 50, unit: 'g' },
    { name: 'Maida (Refined Flour)', qty: 20, unit: 'g' }, { name: 'Refined Oil', qty: 20, unit: 'ml' }, { name: 'Salt', qty: 2, unit: 'g' },
  ]},
  { match: /chilli mushroom/i, items: [
    { name: 'Capsicum', qty: 40, unit: 'g' }, { name: 'Onion', qty: 50, unit: 'g' }, { name: 'Refined Oil', qty: 20, unit: 'ml' }, { name: 'Salt', qty: 2, unit: 'g' },
  ]},

  // Snacks
  { match: /spring roll/i, items: [
    { name: 'Maida (Refined Flour)', qty: 60, unit: 'g' }, { name: 'Capsicum', qty: 30, unit: 'g' }, { name: 'Onion', qty: 30, unit: 'g' },
    { name: 'Refined Oil', qty: 30, unit: 'ml' }, { name: 'Salt', qty: 1, unit: 'g' },
  ]},
  { match: /crispy corn|french fries/i, items: [
    { name: 'Refined Oil', qty: 30, unit: 'ml' }, { name: 'Salt', qty: 2, unit: 'g' },
  ]},

  // Beverages & Desserts
  { match: /mango lassi/i, items: [
    { name: 'Curd', qty: 200, unit: 'g' }, { name: 'Sugar', qty: 20, unit: 'g' },
  ]},
  { match: /sweet lassi/i, items: [
    { name: 'Curd', qty: 200, unit: 'g' }, { name: 'Sugar', qty: 25, unit: 'g' },
  ]},
  { match: /masala chai|chai$/i, items: [
    { name: 'Milk', qty: 100, unit: 'ml' }, { name: 'Sugar', qty: 8, unit: 'g' },
  ]},
  { match: /cold coffee/i, items: [
    { name: 'Milk', qty: 200, unit: 'ml' }, { name: 'Sugar', qty: 15, unit: 'g' },
  ]},
  { match: /gulab jamun/i, items: [
    { name: 'Milk', qty: 100, unit: 'ml' }, { name: 'Maida (Refined Flour)', qty: 30, unit: 'g' }, { name: 'Sugar', qty: 50, unit: 'g' }, { name: 'Ghee', qty: 20, unit: 'ml' },
  ]},
  { match: /rasmalai/i, items: [
    { name: 'Milk', qty: 250, unit: 'ml' }, { name: 'Sugar', qty: 40, unit: 'g' }, { name: 'Cream', qty: 20, unit: 'ml' },
  ]},

  // Generic veg thali / fallback for thali-type combos
  { match: /thali/i, items: [
    { name: 'Wheat Flour', qty: 100, unit: 'g' }, { name: 'Basmati Rice', qty: 100, unit: 'g' },
    { name: 'Toor Dal', qty: 60, unit: 'g' }, { name: 'Potato', qty: 60, unit: 'g' }, { name: 'Onion', qty: 40, unit: 'g' },
    { name: 'Refined Oil', qty: 15, unit: 'ml' }, { name: 'Salt', qty: 3, unit: 'g' },
  ]},
];

// ─── Wastage scenarios ───────────────────────────────────────────────────────
const WASTAGE_SCENARIOS = [
  { name: 'Spinach',  qty: 0.5, reason: 'SPOILAGE', notes: 'Wilted in storage overnight' },
  { name: 'Tomato',   qty: 1,   reason: 'SPOILAGE', notes: 'Soft and bruised — discarded' },
  { name: 'Milk',     qty: 1,   reason: 'EXPIRY',   notes: 'Past use-by date' },
  { name: 'Paneer',   qty: 0.3, reason: 'BURN',     notes: 'Tikka batch over-charred' },
  { name: 'Curd',     qty: 0.4, reason: 'DROPPED',  notes: 'Container slipped on prep counter' },
];

// ─── Main flow ───────────────────────────────────────────────────────────────
async function authenticate() {
  console.log(`\n🔐  Authenticating (mode: ${authMode}) …`);
  if (authMode === 'token') return { token: TOKEN_ARG, restaurantId: RESTAURANT_ARG };
  if (authMode === 'superadmin') {
    const r = await jpost(`${SERVER}/api/auth/import-token`, null, {
      loginId: ADMIN_LOGIN, password: ADMIN_PASSWORD, restaurantId: RESTAURANT_ARG,
    });
    if (r.status !== 200) { console.error(`❌  Admin auth failed: ${r.raw}`); process.exit(1); }
    return { token: r.data.token, restaurantId: r.data.restaurantId };
  }
  if (authMode === 'stafflogin') {
    const r = await jpost(`${SERVER}/api/auth/login`, null, { loginId: STAFF_LOGIN_ID, password: PASSWORD, restaurantId: RESTAURANT_ARG });
    if (r.status !== 200) { console.error(`❌  Staff auth failed: ${r.raw}`); process.exit(1); }
    return { token: r.data.token, restaurantId: RESTAURANT_ARG || r.data.restaurantId };
  }
  const r = await jpost(`${SERVER}/api/auth/owner/login`, null, { identifier: OWNER_EMAIL, password: PASSWORD });
  if (r.status !== 200) { console.error(`❌  Owner auth failed: ${r.raw}`); process.exit(1); }
  return { token: r.data.jwt_token, restaurantId: RESTAURANT_ARG || r.data.restaurant_id };
}

async function seedSuppliers(token, restaurantId) {
  if (SKIP_SUPP) return new Map();
  console.log('\n🚚  Seeding suppliers…');
  // Skip if already present (de-dupe by name)
  const existing = await jget(`${SERVER}/api/restaurant/${restaurantId}/inventory/suppliers`, token);
  const existingByName = new Map((existing.data || []).map((s) => [s.name, s]));
  const created = new Map();
  let added = 0, skipped = 0, failed = 0;
  for (const s of SUPPLIERS) {
    if (existingByName.has(s.name)) { created.set(s.name, existingByName.get(s.name)); skipped++; continue; }
    if (DRY_RUN) { console.log(`   • ${s.name}`); added++; continue; }
    const r = await jpost(`${SERVER}/api/restaurant/${restaurantId}/inventory/suppliers`, token, s);
    if (r.status === 200 && r.data?.id) {
      created.set(s.name, { id: r.data.id, ...s });
      added++;
      process.stdout.write(`\r   added ${added}/${SUPPLIERS.length}: ${s.name.slice(0, 40).padEnd(40)}`);
    } else {
      failed++;
      console.error(`\n   ⚠️  ${s.name}: ${r.status} ${r.raw}`);
    }
  }
  console.log(`\n   ✅ Added: ${added}   ⏭️  Skipped: ${skipped}   ⚠️  Failed: ${failed}`);
  return created;  // Map<name, {id, ...}>
}

async function seedIngredients(token, restaurantId, suppliersMap) {
  if (SKIP_INGRED) return new Map();
  console.log('\n📦  Seeding ingredients…');
  const existing = await jget(`${SERVER}/api/restaurant/${restaurantId}/inventory/ingredients`, token);
  const existingByName = new Map((existing.data || []).map((x) => [x.name, x]));
  const created = new Map();
  let added = 0, skipped = 0, failed = 0;

  // Pick a default supplier per category from the map
  const supplierForCategory = (cat) => {
    for (const [name, cats] of Object.entries(SUPPLIER_CATEGORY_MAP)) {
      if (cats.includes(cat)) return suppliersMap.get(name)?.id || null;
    }
    return null;
  };

  for (const ing of INGREDIENTS) {
    if (existingByName.has(ing.name)) { created.set(ing.name, existingByName.get(ing.name)); skipped++; continue; }
    if (DRY_RUN) { console.log(`   • ${ing.name.padEnd(30)} ${ing.category.padEnd(15)} ${ing.unit.padEnd(6)} stock=${ing.current_stock_qty}`); added++; continue; }
    const supplierId = supplierForCategory(ing.category);
    const payload = { ...ing, default_supplier_id: supplierId };
    const r = await jpost(`${SERVER}/api/restaurant/${restaurantId}/inventory/ingredients`, token, payload);
    if (r.status === 200 && r.data?.id) {
      created.set(ing.name, { id: r.data.id, ...ing, default_supplier_id: supplierId });
      added++;
      process.stdout.write(`\r   added ${added}/${INGREDIENTS.length}: ${ing.name.slice(0, 30).padEnd(30)}`);
    } else {
      failed++;
      console.error(`\n   ⚠️  ${ing.name}: ${r.status} ${r.raw}`);
    }
  }
  console.log(`\n   ✅ Added: ${added}   ⏭️  Skipped: ${skipped}   ⚠️  Failed: ${failed}`);
  return created;  // Map<name, {id, ...}>
}

async function seedRecipes(token, restaurantId, ingredientsMap) {
  if (SKIP_RECIPES) return;
  console.log('\n🧾  Building recipes from menu…');
  const menuRes = await jget(`${SERVER}/api/restaurant/${restaurantId}/menu`, token);
  const menu = Array.isArray(menuRes.data) ? menuRes.data : [];
  if (menu.length === 0) { console.log('   ⏭️  Menu is empty — skipping recipes'); return; }

  let mapped = 0, unmatched = 0, saved = 0, failed = 0;
  for (const item of menu) {
    const tpl = RECIPE_TEMPLATES.find((t) => t.match.test(item.name));
    if (!tpl) { unmatched++; continue; }
    // Translate each template entry to ingredient_id
    const validItems = tpl.items.filter((tplItem) => ingredientsMap.has(tplItem.name)).map((tplItem) => ({
      ingredient_id: ingredientsMap.get(tplItem.name).id,
      qty_per_serving: tplItem.qty,
      unit: tplItem.unit,
      size_variant: 'BOTH',
    }));
    if (validItems.length === 0) { unmatched++; continue; }
    mapped++;
    if (DRY_RUN) { console.log(`   • ${item.name} → ${validItems.length} ingredients`); saved++; continue; }
    const r = await fetch_PUT(`${SERVER}/api/restaurant/${restaurantId}/menu/${item.id}/recipe`, token, { items: validItems });
    if (r.status === 200) { saved++; process.stdout.write(`\r   recipe ${saved}/${menu.length}: ${item.name.slice(0, 40).padEnd(40)}`); }
    else { failed++; console.error(`\n   ⚠️  ${item.name}: ${r.status} ${r.raw}`); }
  }
  console.log(`\n   ✅ Recipes saved: ${saved}   📋 Mapped: ${mapped}/${menu.length}   ⏭️  Unmatched: ${unmatched}   ⚠️  Failed: ${failed}`);
  if (unmatched > 0) console.log(`   (Items without recipes won't deduct stock when ordered — that's fine; can be added manually)`);
}

async function fetch_PUT(url, token, body) {
  const r = await request(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  }, JSON.stringify(body));
  let parsed = null; try { parsed = JSON.parse(r.body); } catch {}
  return { status: r.status, data: parsed, raw: r.body };
}

async function seedProcurement(token, restaurantId, suppliersMap, ingredientsMap) {
  if (SKIP_PROC) return;
  console.log('\n📋  Seeding procurement (POs + GRNs)…');

  // PO 1 — DRAFT for Hari Dairy (paneer + cream + butter restock)
  const po1Items = [
    { name: 'Paneer',  qty: 5,   price: 380 },
    { name: 'Cream',   qty: 2,   price: 195 },
    { name: 'Butter',  qty: 3,   price: 480 },
  ].filter(x => ingredientsMap.has(x.name));
  await createPO(token, restaurantId, suppliersMap.get('Hari Dairy'), po1Items, ingredientsMap, {
    expected_delivery_date: dateInDays(2),
    notes: 'Weekend dairy restock',
    leave_as: 'DRAFT',
  });

  // PO 2 — SENT for Khan Poultry (chicken bulk order)
  const po2Items = [
    { name: 'Chicken (boneless)', qty: 10, price: 270 },
    { name: 'Mutton',             qty: 4,  price: 620 },
  ].filter(x => ingredientsMap.has(x.name));
  await createPO(token, restaurantId, suppliersMap.get('Khan Poultry'), po2Items, ingredientsMap, {
    expected_delivery_date: dateInDays(1),
    notes: 'Tomorrow morning delivery',
    leave_as: 'SENT',
  });

  // PO 3 — PARTIAL: SENT then GRN for partial qty (chicken arrived, mutton didn't)
  const po3Items = [
    { name: 'Chicken (boneless)', qty: 8, price: 285 },
    { name: 'Eggs',               qty: 60,price: 7   },
  ].filter(x => ingredientsMap.has(x.name));
  const po3 = await createPO(token, restaurantId, suppliersMap.get('Khan Poultry'), po3Items, ingredientsMap, {
    expected_delivery_date: dateInDays(0),
    notes: 'Today morning delivery',
    leave_as: 'SENT',
  });
  // GRN for partial — receive chicken but not eggs
  if (po3?.id && !DRY_RUN) {
    const grnItems = po3Items.filter(x => x.name === 'Chicken (boneless)').map(x => ({
      ingredient_id: ingredientsMap.get(x.name).id,
      qty_received: x.qty * 0.75,  // 75% delivered
      unit: ingredientsMap.get(x.name).unit,
      unit_price: x.price,
      condition: 'GOOD',
    }));
    const r = await jpost(`${SERVER}/api/restaurant/${restaurantId}/inventory/grn`, token, {
      po_id: po3.id,
      supplier_id: suppliersMap.get('Khan Poultry').id,
      bill_number: `KP-${Date.now().toString().slice(-6)}`,
      notes: 'Eggs short — supplier promised tomorrow',
      items: grnItems,
    });
    if (r.status === 200) console.log(`   ✅ GRN ${r.data.id} recorded against ${po3.id} → PO now PARTIAL`);
    else console.error(`   ⚠️  GRN failed: ${r.raw}`);
  }

  // GRN 2 — Ad-hoc receipt from Mandi Daily (vegetables top-up)
  if (!DRY_RUN) {
    const adhocItems = [
      { name: 'Onion',  qty: 10, price: 35 },
      { name: 'Tomato', qty: 8,  price: 45 },
      { name: 'Potato', qty: 10, price: 30 },
    ].filter(x => ingredientsMap.has(x.name)).map(x => ({
      ingredient_id: ingredientsMap.get(x.name).id,
      qty_received: x.qty,
      unit: ingredientsMap.get(x.name).unit,
      unit_price: x.price,
      condition: 'GOOD',
    }));
    if (adhocItems.length > 0) {
      const r = await jpost(`${SERVER}/api/restaurant/${restaurantId}/inventory/grn`, token, {
        supplier_id: suppliersMap.get('Mandi Daily').id,
        bill_number: `MD-${Date.now().toString().slice(-6)}`,
        notes: 'Daily morning vegetables',
        items: adhocItems,
      });
      if (r.status === 200) console.log(`   ✅ Ad-hoc GRN ${r.data.id} from Mandi Daily`);
      else console.error(`   ⚠️  Ad-hoc GRN failed: ${r.raw}`);
    }
  }
}

async function createPO(token, restaurantId, supplier, items, ingredientsMap, opts) {
  if (!supplier || items.length === 0) { console.log('   ⏭️  Skipped PO (missing supplier or items)'); return null; }
  const apiItems = items.map(x => ({
    ingredient_id: ingredientsMap.get(x.name).id,
    qty_ordered: x.qty,
    unit: ingredientsMap.get(x.name).unit,
    unit_price: x.price,
  }));
  if (DRY_RUN) {
    console.log(`   • PO to ${supplier.name}: ${items.length} lines, leave_as=${opts.leave_as}`);
    return { id: '(dry-run)' };
  }
  const r = await jpost(`${SERVER}/api/restaurant/${restaurantId}/inventory/purchase-orders`, token, {
    supplier_id: supplier.id,
    expected_delivery_date: opts.expected_delivery_date,
    notes: opts.notes,
    items: apiItems,
  });
  if (r.status !== 200) { console.error(`   ⚠️  PO create failed: ${r.raw}`); return null; }
  console.log(`   ✅ ${r.data.id} → ${supplier.name} (₹${Math.round(r.data.grand_total)})`);
  if (opts.leave_as === 'SENT' || opts.leave_as === 'PARTIAL') {
    const sendR = await jpost(`${SERVER}/api/inventory/purchase-orders/${r.data.id}/send`, token, {});
    if (sendR.status !== 200) console.error(`   ⚠️  Send failed: ${sendR.raw}`);
  }
  return { id: r.data.id, ...r.data };
}

async function seedWastage(token, restaurantId, ingredientsMap) {
  if (SKIP_WASTAGE) return;
  console.log('\n🗑️   Seeding wastage logs…');
  let added = 0, failed = 0;
  for (const w of WASTAGE_SCENARIOS) {
    if (!ingredientsMap.has(w.name)) continue;
    const ing = ingredientsMap.get(w.name);
    if (DRY_RUN) { console.log(`   • ${w.name} ${w.qty} ${ing.unit} (${w.reason})`); added++; continue; }
    const r = await jpost(`${SERVER}/api/restaurant/${restaurantId}/inventory/wastage`, token, {
      ingredient_id: ing.id,
      qty: w.qty,
      unit: ing.unit,
      reason: w.reason,
      notes: w.notes,
    });
    if (r.status === 200) added++;
    else { failed++; console.error(`   ⚠️  ${w.name}: ${r.raw}`); }
  }
  console.log(`   ✅ Logged: ${added}   ⚠️  Failed: ${failed}`);
}

async function seedPhysicalCount(token, restaurantId) {
  if (SKIP_COUNT) return;
  console.log('\n📋  Starting a sample physical count…');
  if (DRY_RUN) { console.log('   ✓ (dry-run)'); return; }
  const startR = await jpost(`${SERVER}/api/restaurant/${restaurantId}/inventory/counts`, token, {
    count_date: new Date().toISOString().slice(0, 10),
    notes: 'Demo seed — sample weekend audit',
  });
  if (startR.status !== 200) { console.error(`   ⚠️  Start failed: ${startR.raw}`); return; }
  const countId = startR.data.id;
  console.log(`   ✅ ${countId} started — ${startR.data.line_count} lines snapshotted`);

  // Fill in actuals for ~5 random ingredients with small variances
  const detailR = await jget(`${SERVER}/api/inventory/counts/${countId}`, token);
  const items = (detailR.data?.items || []).slice(0, 5);
  const updates = items.map((it, idx) => ({
    id: it.id,
    actual_qty: Number(it.expected_qty) + (idx === 0 ? -0.2 : idx === 1 ? +0.5 : idx === 2 ? -0.1 : 0),
  }));
  await jpatch(`${SERVER}/api/inventory/counts/${countId}/items`, token, { items: updates });
  console.log(`   ✓ Filled actuals for ${updates.length} lines (with variance) — left in IN_PROGRESS for owner to complete`);
}

(async () => {
  console.log('\n📦  Atithi-Setu — Inventory Demo Seed');
  console.log('═'.repeat(70));
  console.log(`Server:        ${SERVER}`);
  console.log(`Restaurant:    ${RESTAURANT_ARG || '(resolved at login)'}`);
  console.log(`Dry-run:       ${DRY_RUN}`);

  const { token, restaurantId } = await authenticate();
  console.log(`\n   ✅ Authenticated  |  Restaurant: ${restaurantId}`);

  const suppliersMap   = await seedSuppliers(token, restaurantId);
  const ingredientsMap = await seedIngredients(token, restaurantId, suppliersMap);
  await seedRecipes(token, restaurantId, ingredientsMap);
  await seedProcurement(token, restaurantId, suppliersMap, ingredientsMap);
  await seedWastage(token, restaurantId, ingredientsMap);
  await seedPhysicalCount(token, restaurantId);

  console.log('\n🎉  Done. Open the owner dashboard → Inventory tab to see the seeded data.');
  console.log(`   ${SERVER}\n`);
})().catch(err => { console.error('\n❌  Fatal:', err); process.exit(1); });

// ─── Helpers ─────────────────────────────────────────────────────────────────
function dateInDays(n) {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
