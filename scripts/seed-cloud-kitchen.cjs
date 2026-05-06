#!/usr/bin/env node
/**
 * Atithi-Setu — Cloud Kitchen Demo Seed
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Populates a tenant with realistic cloud-kitchen demo data:
 *   1. PATCH restaurant settings — checkout_mode='cloud_kitchen', GST 5%,
 *      sequential invoice numbering with prefix 'CK-'
 *   2. Bulk-creates ~45 menu items across 8 cloud-kitchen categories
 *   3. (Optional) places ~12 sample online orders with structured Indian
 *      delivery addresses across NCR PIN codes — exercises the new auto-invoice
 *      flow end-to-end so the owner sees a populated invoice list
 *
 * Idempotent within a single run for menu items (de-dupes by name+category)
 * but does NOT clean up old data — you must wipe the tenant manually first if
 * you want a fresh slate.
 *
 * ── Authentication Modes (mirrors menu_import.cjs) ────────────────────────────
 *
 *  Mode 1 — Owner login (you have the owner's password)
 *    node scripts/seed-cloud-kitchen.cjs --email owner@x.com --password secret \
 *      --server https://cloud-kitchen.atithi-setu.com
 *
 *  Mode 2 — Token (copy JWT from browser DevTools; no password needed)
 *    node scripts/seed-cloud-kitchen.cjs --token <jwt> \
 *      --restaurant RESTO_1778047416074_EYP5P \
 *      --server https://cloud-kitchen.atithi-setu.com
 *
 *  Mode 3 — Super Admin (platform admin; --admin-login + --admin-password)
 *    node scripts/seed-cloud-kitchen.cjs --admin-login ADMIN-ANKUSH \
 *      --admin-password adminpass \
 *      --restaurant RESTO_1778047416074_EYP5P \
 *      --server https://cloud-kitchen.atithi-setu.com
 *
 *  Mode 4 — Staff loginId + password (any OWNER/MANAGER staff)
 *    node scripts/seed-cloud-kitchen.cjs --login-id OWNER-001 --password secret \
 *      --restaurant RESTO_1778047416074_EYP5P \
 *      --server https://cloud-kitchen.atithi-setu.com
 *
 * ── Options ────────────────────────────────────────────────────────────────────
 *   --server          Server base URL  (default: http://localhost:4001)
 *   --restaurant      Restaurant ID    (required for modes 2, 3, 4)
 *   --skip-settings   Don't PATCH restaurant settings
 *   --skip-menu       Don't seed menu items
 *   --skip-orders     Don't place sample orders
 *   --orders <n>      How many sample orders to place  (default: 12, max: 50)
 *   --dry-run         Log everything but make no API calls (after auth)
 *   --help            This message
 *
 * ── Auth flags (pick one mode) ─────────────────────────────────────────────────
 *   --email / --password           Mode 1
 *   --token                        Mode 2
 *   --admin-login / --admin-password   Mode 3
 *   --login-id / --password        Mode 4
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
const SKIP_SETTINGS  = hasFlag('--skip-settings');
const SKIP_MENU      = hasFlag('--skip-menu');
const SKIP_ORDERS    = hasFlag('--skip-orders');
const ORDERS_COUNT   = Math.min(parseInt(arg('--orders') || '12', 10), 50);

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

async function jsonPost(url, token, body) {
  const res = await request(url, {
    method : 'POST',
    headers: {
      'Content-Type' : 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
  }, JSON.stringify(body));
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch {}
  return { status: res.status, data: parsed, raw: res.body };
}

async function jsonPatch(url, token, body) {
  const res = await request(url, {
    method : 'PATCH',
    headers: {
      'Content-Type' : 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
  }, JSON.stringify(body));
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch {}
  return { status: res.status, data: parsed, raw: res.body };
}

// ─── Multipart form-data builder (for menu POST) ──────────────────────────────
// The /menu endpoint runs through multer's .single('image') so we send
// multipart/form-data without a file field. Tested in menu_import.cjs.
function buildMultipart(fields) {
  const boundary = '----AtithiSeed' + Math.random().toString(36).slice(2);
  const parts    = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === '') continue;
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`);
  }
  const body = Buffer.from(parts.join('\r\n') + `\r\n--${boundary}--\r\n`);
  return { boundary, body };
}

async function multipartPost(url, token, fields) {
  const { boundary, body } = buildMultipart(fields);
  const res = await request(url, {
    method : 'POST',
    headers: {
      'Content-Type' : `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
  }, body);
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch {}
  return { status: res.status, data: parsed, raw: res.body };
}

// ─── Demo data ────────────────────────────────────────────────────────────────

const MENU = [
  // Biryani & Rice
  { name: 'Hyderabadi Chicken Biryani',   category: 'Biryani & Rice', dietary_type: 'NON_VEG', price: 320, description: 'Long-grain basmati layered with tender chicken, slow-cooked dum-style with saffron and fried onions.' },
  { name: 'Hyderabadi Mutton Biryani',    category: 'Biryani & Rice', dietary_type: 'NON_VEG', price: 420, description: 'Slow-cooked mutton biryani in classic Hyderabadi style; served with raita and salan.' },
  { name: 'Vegetable Biryani',            category: 'Biryani & Rice', dietary_type: 'VEG',     price: 240, description: 'Aromatic basmati rice cooked with seasonal vegetables and traditional spices.' },
  { name: 'Egg Biryani',                  category: 'Biryani & Rice', dietary_type: 'NON_VEG', price: 220, description: 'Fragrant rice with two boiled eggs, fried onions and fresh mint.' },
  { name: 'Awadhi Chicken Biryani',       category: 'Biryani & Rice', dietary_type: 'NON_VEG', price: 340, description: 'Lucknow-style mild biryani with rose water and saffron — flavour without the heat.' },
  { name: 'Jeera Rice',                   category: 'Biryani & Rice', dietary_type: 'VEG',     price:  90, description: 'Steamed basmati tossed with whole cumin and ghee.' },
  { name: 'Steamed Basmati Rice',         category: 'Biryani & Rice', dietary_type: 'VEG',     price:  70, description: 'Plain long-grain basmati, lightly steamed.' },
  { name: 'Curd Rice',                    category: 'Biryani & Rice', dietary_type: 'VEG',     price: 110, description: 'South-Indian style yogurt rice tempered with curry leaves and mustard.' },

  // Curries — Veg
  { name: 'Paneer Butter Masala',         category: 'Curries — Veg',   dietary_type: 'VEG', price: 240, description: 'Cottage cheese cubes simmered in a tomato-cashew gravy with butter and cream.' },
  { name: 'Dal Makhani',                  category: 'Curries — Veg',   dietary_type: 'VEG', price: 180, description: 'Black urad dal slow-cooked overnight, finished with butter and fresh cream.' },
  { name: 'Kadhai Paneer',                category: 'Curries — Veg',   dietary_type: 'VEG', price: 230, description: 'Paneer and bell peppers tossed in a freshly ground kadhai masala.' },
  { name: 'Palak Paneer',                 category: 'Curries — Veg',   dietary_type: 'VEG', price: 220, description: 'Cottage cheese in a smooth spinach gravy, lightly spiced.' },
  { name: 'Chole Masala',                 category: 'Curries — Veg',   dietary_type: 'VEG', price: 160, description: 'Punjabi-style chickpea curry with whole spices and a squeeze of lemon.' },
  { name: 'Mix Veg Curry',                category: 'Curries — Veg',   dietary_type: 'VEG', price: 180, description: 'Seasonal vegetables in an onion-tomato gravy.' },

  // Curries — Non-Veg
  { name: 'Butter Chicken',               category: 'Curries — Non-Veg', dietary_type: 'NON_VEG', price: 320, description: 'Tandoor-cooked chicken in a velvety tomato-butter-cream gravy. Our signature dish.' },
  { name: 'Chicken Tikka Masala',         category: 'Curries — Non-Veg', dietary_type: 'NON_VEG', price: 310, description: 'Char-grilled chicken tikka in a robust onion-tomato masala.' },
  { name: 'Mutton Rogan Josh',            category: 'Curries — Non-Veg', dietary_type: 'NON_VEG', price: 380, description: 'Kashmiri-style mutton in an aromatic red gravy of yogurt and Kashmiri chillies.' },
  { name: 'Chicken Korma',                category: 'Curries — Non-Veg', dietary_type: 'NON_VEG', price: 300, description: 'Mughlai-style mild chicken curry with cashews and yogurt.' },
  { name: 'Andhra Chicken Curry',         category: 'Curries — Non-Veg', dietary_type: 'NON_VEG', price: 290, description: 'Fiery South-Indian chicken curry with crushed black pepper and curry leaves.' },
  { name: 'Egg Curry',                    category: 'Curries — Non-Veg', dietary_type: 'NON_VEG', price: 180, description: 'Boiled eggs in a tangy onion-tomato gravy.' },

  // Tandoor & Kebabs
  { name: 'Tandoori Chicken (Half)',      category: 'Tandoor & Kebabs', dietary_type: 'NON_VEG', price: 270, description: 'Half a chicken marinated in yogurt and tandoori spices, char-grilled in clay oven.' },
  { name: 'Chicken Tikka',                category: 'Tandoor & Kebabs', dietary_type: 'NON_VEG', price: 260, description: 'Boneless chicken cubes marinated in yogurt and spices, grilled to perfection.' },
  { name: 'Paneer Tikka',                 category: 'Tandoor & Kebabs', dietary_type: 'VEG',     price: 240, description: 'Cottage cheese cubes with bell peppers, marinated and char-grilled.' },
  { name: 'Hariyali Kebab',               category: 'Tandoor & Kebabs', dietary_type: 'NON_VEG', price: 270, description: 'Chicken kebab marinated in fresh coriander, mint and green chilli paste.' },
  { name: 'Seekh Kebab',                  category: 'Tandoor & Kebabs', dietary_type: 'NON_VEG', price: 260, description: 'Skewered minced lamb with onions, ginger and garam masala, grilled over coals.' },

  // Indian Breads
  { name: 'Tandoori Roti',                category: 'Indian Breads', dietary_type: 'VEG', price:  30, description: 'Whole-wheat flatbread baked in clay oven.' },
  { name: 'Butter Naan',                  category: 'Indian Breads', dietary_type: 'VEG', price:  60, description: 'Soft leavened bread brushed with melted butter.' },
  { name: 'Garlic Naan',                  category: 'Indian Breads', dietary_type: 'VEG', price:  80, description: 'Naan topped with crushed garlic and fresh coriander.' },
  { name: 'Lachha Paratha',               category: 'Indian Breads', dietary_type: 'VEG', price:  60, description: 'Multi-layered flaky whole-wheat paratha.' },
  { name: 'Stuffed Kulcha',               category: 'Indian Breads', dietary_type: 'VEG', price:  90, description: 'Tandoor-baked kulcha stuffed with spiced potatoes and onions.' },

  // Indo-Chinese
  { name: 'Veg Hakka Noodles',            category: 'Indo-Chinese', dietary_type: 'VEG',     price: 180, description: 'Stir-fried noodles tossed with vegetables, soy and chilli oil.' },
  { name: 'Chicken Hakka Noodles',        category: 'Indo-Chinese', dietary_type: 'NON_VEG', price: 220, description: 'Wok-tossed noodles with chicken, vegetables and Indo-Chinese sauces.' },
  { name: 'Veg Manchurian',               category: 'Indo-Chinese', dietary_type: 'VEG',     price: 200, description: 'Crispy vegetable balls in a spicy soy-ginger-garlic sauce.' },
  { name: 'Chilli Paneer',                category: 'Indo-Chinese', dietary_type: 'VEG',     price: 240, description: 'Crispy paneer cubes tossed with bell peppers in a chilli-soy glaze.' },
  { name: 'Chicken Fried Rice',           category: 'Indo-Chinese', dietary_type: 'NON_VEG', price: 220, description: 'Wok-fried rice with chicken, eggs and Indo-Chinese seasoning.' },

  // Snacks & Starters
  { name: 'Veg Spring Roll',              category: 'Snacks & Starters', dietary_type: 'VEG',     price: 160, description: 'Crispy rolls stuffed with shredded vegetables and Asian seasoning. 4 pieces.' },
  { name: 'Crispy Corn',                  category: 'Snacks & Starters', dietary_type: 'VEG',     price: 180, description: 'Sweet corn kernels deep-fried and tossed with chilli and curry leaves.' },
  { name: 'Chilli Mushroom',              category: 'Snacks & Starters', dietary_type: 'VEG',     price: 220, description: 'Battered mushrooms tossed in a spicy chilli-garlic sauce.' },
  { name: 'French Fries',                 category: 'Snacks & Starters', dietary_type: 'VEG',     price: 120, description: 'Crispy golden potato fries served with ketchup.' },

  // Beverages & Desserts
  { name: 'Mango Lassi',                  category: 'Beverages & Desserts', dietary_type: 'VEG', price:  90, description: 'Thick yogurt drink blended with sweet Alphonso mango pulp.' },
  { name: 'Sweet Lassi',                  category: 'Beverages & Desserts', dietary_type: 'VEG', price:  70, description: 'Classic Punjabi sweet yogurt drink with rose water.' },
  { name: 'Masala Chai',                  category: 'Beverages & Desserts', dietary_type: 'VEG', price:  40, description: 'Brewed black tea with milk, ginger and traditional Indian spices.' },
  { name: 'Cold Coffee',                  category: 'Beverages & Desserts', dietary_type: 'VEG', price: 110, description: 'Iced coffee blended with milk and a scoop of vanilla ice-cream.' },
  { name: 'Gulab Jamun (2 pcs)',          category: 'Beverages & Desserts', dietary_type: 'VEG', price:  80, description: 'Soft milk dumplings soaked in cardamom-rose sugar syrup.' },
  { name: 'Rasmalai (2 pcs)',             category: 'Beverages & Desserts', dietary_type: 'VEG', price: 100, description: 'Spongy paneer discs in saffron-cardamom milk, garnished with pistachios.' },
];

// Sample customer profiles with realistic NCR PIN codes & landmarks
const SAMPLE_CUSTOMERS = [
  { name: 'Aarav Sharma',        phone: '+91 98101 23456', email: 'aarav.sharma@example.com',
    line1: 'Flat 502, Tower B, DLF Park Place', line2: 'Sector 54',                    city: 'Gurgaon',  pincode: '122002', landmark: 'Near Genpact Building' },
  { name: 'Priya Verma',         phone: '+91 99110 45678', email: 'priya.verma@example.com',
    line1: 'House No. 24, Block C',              line2: 'Vasant Kunj',                  city: 'New Delhi', pincode: '110070', landmark: 'Opposite DPS Vasant Kunj' },
  { name: 'Rohan Mehta',         phone: '+91 98765 11122', email: 'rohan.mehta@example.com',
    line1: 'A-301, Supertech Cape Town',         line2: 'Sector 74',                    city: 'Noida',    pincode: '201301', landmark: 'Near Hospital Wing' },
  { name: 'Ananya Iyer',         phone: '+91 95607 88445', email: 'ananya.iyer@example.com',
    line1: 'B-12, Greater Kailash II',           line2: 'M-Block Market',               city: 'New Delhi', pincode: '110048', landmark: 'Near Punjab National Bank' },
  { name: 'Vikram Singh',        phone: '+91 98998 76543', email: 'vikram.singh@example.com',
    line1: '14, Sector 19',                      line2: 'Near Sheetla Mata Road',       city: 'Gurgaon',  pincode: '122008', landmark: 'Beside Reliance Smart' },
  { name: 'Sneha Reddy',         phone: '+91 96544 33212', email: 'sneha.reddy@example.com',
    line1: 'Flat 1204, Tower 5, Lotus Boulevard', line2: 'Sector 100',                  city: 'Noida',    pincode: '201304', landmark: 'Behind Amity University' },
  { name: 'Kabir Khan',          phone: '+91 91234 55678', email: 'kabir.khan@example.com',
    line1: 'C-7, Saket District',                line2: 'Press Enclave Road',           city: 'New Delhi', pincode: '110017', landmark: 'Near Select City Walk Mall' },
  { name: 'Meera Pillai',        phone: '+91 98555 99211', email: 'meera.pillai@example.com',
    line1: 'Plot 88, Sushant Lok Phase 1',       line2: 'Block C',                      city: 'Gurgaon',  pincode: '122009', landmark: 'Near Galleria Market' },
  { name: 'Arjun Kapoor',        phone: '+91 99887 22134', email: 'arjun.kapoor@example.com',
    line1: 'D-204, ATS Greens One',              line2: 'Sector 50',                    city: 'Noida',    pincode: '201301', landmark: 'Opp. Worlds of Wonder' },
  { name: 'Ishita Banerjee',     phone: '+91 90112 67788', email: 'ishita.b@example.com',
    line1: '12-A, Defence Colony',               line2: '',                              city: 'New Delhi', pincode: '110024', landmark: 'Near Defence Colony Flyover' },
  { name: 'Rajat Malhotra',      phone: '+91 98717 88990', email: 'rajat.m@example.com',
    line1: 'Tower 3, Apt 1102, Mahagun Mantra',  line2: 'Sector 10',                    city: 'Greater Noida', pincode: '201310', landmark: 'Behind Pari Chowk' },
  { name: 'Tanvi Joshi',         phone: '+91 90019 23455', email: 'tanvi.joshi@example.com',
    line1: 'B-15, Hauz Khas Village',            line2: '',                              city: 'New Delhi', pincode: '110016', landmark: 'Near Deer Park entrance' },
];

// Cart compositions sampled when placing orders. Each entry is an array of
// menu item names + quantity.
const SAMPLE_CARTS = [
  [['Hyderabadi Chicken Biryani', 1], ['Mango Lassi', 1], ['Gulab Jamun (2 pcs)', 1]],
  [['Butter Chicken', 1], ['Butter Naan', 3], ['Jeera Rice', 1]],
  [['Vegetable Biryani', 1], ['Sweet Lassi', 1]],
  [['Paneer Butter Masala', 1], ['Garlic Naan', 2], ['Dal Makhani', 1], ['Steamed Basmati Rice', 1]],
  [['Mutton Rogan Josh', 1], ['Tandoori Roti', 4], ['Masala Chai', 2]],
  [['Chicken Hakka Noodles', 1], ['Chilli Paneer', 1], ['Cold Coffee', 1]],
  [['Awadhi Chicken Biryani', 1], ['Rasmalai (2 pcs)', 1]],
  [['Egg Biryani', 1], ['Curd Rice', 1]],
  [['Hyderabadi Mutton Biryani', 1], ['Mango Lassi', 1]],
  [['Chicken Tikka', 1], ['Tandoori Chicken (Half)', 1], ['Lachha Paratha', 4], ['Sweet Lassi', 2]],
  [['Veg Hakka Noodles', 1], ['Veg Manchurian', 1], ['French Fries', 1]],
  [['Paneer Tikka', 1], ['Stuffed Kulcha', 2], ['Chole Masala', 1], ['Mango Lassi', 1]],
  [['Chicken Korma', 1], ['Butter Naan', 3]],
  [['Palak Paneer', 1], ['Mix Veg Curry', 1], ['Tandoori Roti', 6], ['Gulab Jamun (2 pcs)', 1]],
  [['Andhra Chicken Curry', 1], ['Steamed Basmati Rice', 2], ['Sweet Lassi', 1]],
];

const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD'];

function pick(arr, i) { return arr[i % arr.length]; }

// ─── Step 1 — Authenticate ────────────────────────────────────────────────────
async function authenticate() {
  console.log(`\n🔐  Authenticating (mode: ${authMode}) …`);

  if (authMode === 'token') {
    return { token: TOKEN_ARG, restaurantId: RESTAURANT_ARG };
  }

  if (authMode === 'superadmin') {
    const r = await jsonPost(`${SERVER}/api/auth/import-token`, null, {
      loginId: ADMIN_LOGIN, password: ADMIN_PASSWORD, restaurantId: RESTAURANT_ARG,
    });
    if (r.status !== 200) {
      console.error(`❌  Admin auth failed (${r.status}): ${(r.data && r.data.error) || r.raw}`);
      process.exit(1);
    }
    return { token: r.data.token, restaurantId: r.data.restaurantId };
  }

  if (authMode === 'stafflogin') {
    const r = await jsonPost(`${SERVER}/api/auth/login`, null, {
      loginId: STAFF_LOGIN_ID, password: PASSWORD, restaurantId: RESTAURANT_ARG,
    });
    if (r.status !== 200) {
      console.error(`❌  Staff login failed (${r.status}): ${(r.data && r.data.error) || r.raw}`);
      process.exit(1);
    }
    return { token: r.data.token, restaurantId: RESTAURANT_ARG || r.data.restaurantId };
  }

  // Owner login
  const r = await jsonPost(`${SERVER}/api/auth/owner/login`, null, {
    identifier: OWNER_EMAIL, password: PASSWORD,
  });
  if (r.status !== 200) {
    console.error(`❌  Owner login failed (${r.status}): ${(r.data && r.data.error) || r.raw}`);
    process.exit(1);
  }
  return { token: r.data.jwt_token, restaurantId: RESTAURANT_ARG || r.data.restaurant_id };
}

// ─── Step 2 — Configure tenant settings ───────────────────────────────────────
async function configureSettings(token, restaurantId) {
  if (SKIP_SETTINGS) { console.log('⏭️   --skip-settings — leaving restaurant settings alone'); return; }

  console.log('\n⚙️   Configuring restaurant settings…');
  const settings = {
    name             : 'Atithi Cloud Kitchen',
    checkout_mode    : 'cloud_kitchen',
    is_gst_enabled   : 1,
    gst_percentage   : 5,
    gst_number       : '07AAACR1234A1Z5',
    upi_id           : 'cloudkitchen@upi',
    table_count      : 0,
    template_id      : 'CLASSIC',
    invoice_numbering_mode : 'SEQUENTIAL',
    invoice_number_prefix  : 'CK-',
    invoice_yearly_reset   : 0,
  };
  console.log('   →', JSON.stringify(settings, null, 2).split('\n').slice(1, -1).join('\n     '));

  if (DRY_RUN) { console.log('   ✓ (dry-run)'); return; }

  const r = await jsonPatch(`${SERVER}/api/restaurant/${restaurantId}`, token, settings);
  if (r.status !== 200) {
    console.error(`   ❌ PATCH failed (${r.status}): ${(r.data && r.data.error) || r.raw}`);
    process.exit(1);
  }
  console.log('   ✅ Settings updated');
}

// ─── Step 3 — Seed menu ───────────────────────────────────────────────────────
async function seedMenu(token, restaurantId) {
  if (SKIP_MENU) { console.log('⏭️   --skip-menu — leaving menu alone'); return new Map(); }

  console.log(`\n🍽️   Seeding ${MENU.length} menu items…`);

  // Fetch existing menu so we can de-dupe by (name, category)
  const existing = await request(`${SERVER}/api/restaurant/${restaurantId}/menu`, { method: 'GET' });
  let existingNames = new Set();
  try {
    const arr = JSON.parse(existing.body);
    if (Array.isArray(arr)) arr.forEach(m => existingNames.add(`${m.name}|${m.category}`));
  } catch {}

  const created = new Map(); // name → id
  let added = 0, skipped = 0, failed = 0;

  for (const item of MENU) {
    const key = `${item.name}|${item.category}`;
    if (existingNames.has(key)) {
      skipped++;
      continue;
    }
    if (DRY_RUN) {
      console.log(`   • ${item.name.padEnd(35)} ${item.category.padEnd(28)} ₹${item.price}`);
      added++;
      continue;
    }

    const r = await multipartPost(`${SERVER}/api/restaurant/${restaurantId}/menu`, token, {
      name            : item.name,
      description     : item.description,
      price           : item.price,
      category        : item.category,
      dietary_type    : item.dietary_type,
      is_daily_special: 'false',
    });
    if (r.status === 200 && r.data && r.data.id) {
      created.set(item.name, r.data.id);
      added++;
      process.stdout.write(`\r   added ${added}/${MENU.length}: ${item.name.slice(0, 40).padEnd(40)}`);
    } else {
      failed++;
      console.error(`\n   ⚠️  Failed: ${item.name} — ${r.status} ${(r.data && r.data.error) || r.raw}`);
    }
  }
  console.log(`\n   ✅ Added: ${added}   ⏭️  Skipped (already present): ${skipped}   ⚠️  Failed: ${failed}`);
  return created;
}

// ─── Step 4 — Place sample orders ─────────────────────────────────────────────
async function placeSampleOrders(restaurantId) {
  if (SKIP_ORDERS) { console.log('⏭️   --skip-orders — not placing sample orders'); return; }

  // Fetch the live menu so we have real item IDs (in case some items are
  // already present from a prior run and weren't returned by --skip-menu).
  const menuRes = await request(`${SERVER}/api/restaurant/${restaurantId}/menu`, { method: 'GET' });
  let menuById;
  try {
    const arr = JSON.parse(menuRes.body);
    if (!Array.isArray(arr) || arr.length === 0) {
      console.warn('\n⚠️   Menu is empty — cannot place sample orders. Run without --skip-menu first.');
      return;
    }
    menuById = new Map(arr.map(m => [m.name, m]));
  } catch (err) {
    console.error(`\n❌  Failed to fetch menu for order seed: ${err.message}`);
    return;
  }

  console.log(`\n📦  Placing ${ORDERS_COUNT} sample online orders…`);

  let placed = 0, failed = 0;
  for (let i = 0; i < ORDERS_COUNT; i++) {
    const customer = pick(SAMPLE_CUSTOMERS, i);
    const cart     = pick(SAMPLE_CARTS, i);
    const payMtd   = pick(PAYMENT_METHODS, i);

    const items = [];
    let subtotal = 0;
    for (const [itemName, qty] of cart) {
      const m = menuById.get(itemName);
      if (!m) continue;
      items.push({
        id: m.id, name: m.name, price: Number(m.price), quantity: qty,
        category: m.category, size: 'FULL',
      });
      subtotal += Number(m.price) * qty;
    }
    if (items.length === 0) { failed++; continue; }

    // GST 5% (matches the settings we just patched)
    const gstAmount = +(subtotal * 0.05).toFixed(2);

    const orderBody = {
      table_number    : 'Online Order',
      customer_name   : customer.name,
      customer_phone  : customer.phone,
      customer_email  : customer.email,
      items,
      total_amount    : subtotal,
      gst_amount      : gstAmount,
      payment_method  : payMtd,
      checkout_mode   : 'cloud_kitchen',
      customer_address_line1 : customer.line1,
      customer_address_line2 : customer.line2 || null,
      customer_city          : customer.city,
      customer_pincode       : customer.pincode,
      customer_landmark      : customer.landmark || null,
    };

    if (DRY_RUN) {
      console.log(`   • ${customer.name.padEnd(20)} ${customer.city.padEnd(14)} ${payMtd.padEnd(5)} ₹${(subtotal+gstAmount).toFixed(0)} (${items.length} items)`);
      placed++;
      continue;
    }

    const r = await jsonPost(`${SERVER}/api/restaurant/${restaurantId}/orders`, null, orderBody);
    if (r.status === 200 && r.data && r.data.id) {
      placed++;
      process.stdout.write(`\r   placed ${placed}/${ORDERS_COUNT}: ${(r.data.invoice_number || r.data.id).padEnd(20)} ${customer.name.slice(0,20).padEnd(20)}`);
    } else {
      failed++;
      console.error(`\n   ⚠️  Order failed for ${customer.name}: ${r.status} ${(r.data && r.data.error) || r.raw}`);
    }
  }
  console.log(`\n   ✅ Placed: ${placed}   ⚠️  Failed: ${failed}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n🍱  Atithi-Setu — Cloud Kitchen Demo Seed');
  console.log('═'.repeat(60));
  console.log(`Server:        ${SERVER}`);
  console.log(`Restaurant:    ${RESTAURANT_ARG || '(resolved at login)'}`);
  console.log(`Dry-run:       ${DRY_RUN ? 'YES — no API writes' : 'no'}`);
  console.log(`Skip-settings: ${SKIP_SETTINGS}`);
  console.log(`Skip-menu:     ${SKIP_MENU}`);
  console.log(`Skip-orders:   ${SKIP_ORDERS}`);
  if (!SKIP_ORDERS) console.log(`Order count:   ${ORDERS_COUNT}`);

  const { token, restaurantId } = await authenticate();
  console.log(`\n   ✅ Authenticated  |  Restaurant: ${restaurantId}`);

  await configureSettings(token, restaurantId);
  await seedMenu(token, restaurantId);
  await placeSampleOrders(restaurantId);

  console.log('\n🎉  Done. Open the owner dashboard to verify:');
  console.log(`   ${SERVER}\n`);
})().catch(err => {
  console.error('\n❌  Fatal:', err);
  process.exit(1);
});
