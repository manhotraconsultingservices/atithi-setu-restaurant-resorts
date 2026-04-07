#!/usr/bin/env node
/**
 * Atithi-Setu — Bulk Menu Import CLI
 * ====================================
 * Reads a CSV file (with optional full local image_path) and imports all
 * rows into the running server, uploading image files from disk.
 *
 * ── Authentication Modes (use whichever you have access to) ──────────────────
 *
 *  Mode 1 — Owner login (you have the owner's password)
 *    node menu_import.cjs --csv menu.csv --email owner@x.com --password secret
 *
 *  Mode 2 — Token (copy JWT from browser; no password needed)
 *    node menu_import.cjs --csv menu.csv --token <jwt> --restaurant <id>
 *
 *  Mode 3 — Super Admin (platform admin, no owner password needed)
 *    node menu_import.cjs --csv menu.csv --admin-login ADMIN-ANKUSH --admin-password secret --restaurant <id>
 *
 *  Mode 4 — Staff login  (use loginId + password of any OWNER/MANAGER staff)
 *    node menu_import.cjs --csv menu.csv --login-id OWNER-001 --password secret --restaurant <id>
 *
 * ── CSV columns ──────────────────────────────────────────────────────────────
 *   name, category, description, dietary_type, price_half, price_full,
 *   is_daily_special, image_path
 *
 *   image_path  — full Windows/Linux path to image file on this machine
 *                 e.g.  C:\Photos\food\butter_chicken.jpg
 *                 (leave blank if no image)
 *
 * ── All Options ──────────────────────────────────────────────────────────────
 *   --csv              Path to CSV file  (required)
 *   --restaurant       Restaurant ID  (required for modes 2, 3, 4)
 *   --server           Server base URL  (default: http://localhost:4001)
 *   --concurrency      Parallel uploads  (default: 10)
 *   --dry-run          Preview CSV without uploading
 *   --help             Show this help
 *
 *  Auth (pick one mode):
 *   --email            Owner email or phone  (mode 1)
 *   --password         Password              (modes 1, 4)
 *   --token            Pre-copied JWT token  (mode 2 — no password needed)
 *   --admin-login      SUPER_ADMIN loginId   (mode 3 — no owner password needed)
 *   --admin-password   SUPER_ADMIN password  (mode 3)
 *   --login-id         Staff loginId         (mode 4)
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');

// ─── Parse CLI args ───────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const arg    = (flag) => { const i = args.indexOf(flag); return i !== -1 && i + 1 < args.length ? args[i + 1] : null; };
const hasFlag = (flag) => args.includes(flag);

if (hasFlag('--help') || args.length === 0) {
  console.log(`
Atithi-Setu Bulk Menu Import CLI
═════════════════════════════════

AUTHENTICATION MODES (pick one — use whichever you have access to):

  Mode 1 — Owner login (you have the owner's password):
    node menu_import.cjs --csv menu.csv --email owner@x.com --password secret

  Mode 2 — Token (copy JWT from browser DevTools → no password needed):
    node menu_import.cjs --csv menu.csv --token <jwt> --restaurant <id>
    How to get token: Open app → F12 → Application → Local Storage → look for 'token'

  Mode 3 — Super Admin (platform admin, no owner password needed):
    node menu_import.cjs --csv menu.csv --admin-login ADMIN-ANKUSH --admin-password secret --restaurant <id>

  Mode 4 — Staff login (loginId of any OWNER/MANAGER account):
    node menu_import.cjs --csv menu.csv --login-id OWNER-001 --password secret --restaurant <id>

REQUIRED:
  --csv              Path to CSV file

AUTH (one of the above modes)

OPTIONAL:
  --restaurant       Restaurant ID  (required for modes 2, 3, 4; auto-detected for mode 1)
  --server           Server URL  (default: http://localhost:4001)
  --concurrency      Parallel uploads  (default: 10, max recommended: 20)
  --dry-run          Preview CSV without uploading
  --help             Show this help

CSV COLUMNS:
  name, category, description, dietary_type,
  price_half, price_full, is_daily_special, image_path

  image_path: Full path to local image file
  e.g.  C:\\Photos\\food\\butter_chicken.jpg
        /home/admin/images/butter_chicken.jpg

EXAMPLES:
  node menu_import.cjs --csv menu.csv --email owner@restaurant.com --password mypass123
  node menu_import.cjs --csv menu.csv --admin-login ADMIN-ANKUSH --admin-password adminpass --restaurant abc123
  node menu_import.cjs --csv menu.csv --token eyJhbGc... --restaurant abc123
  node menu_import.cjs --csv menu.csv --email owner@x.com --password pass --dry-run
`);
  process.exit(0);
}

const CSV_FILE       = arg('--csv');
const SERVER         = (arg('--server') || 'http://localhost:4001').replace(/\/$/, '');
const CONCURRENCY    = Math.min(parseInt(arg('--concurrency') || '10', 10), 20);
const DRY_RUN        = hasFlag('--dry-run');
const RESTAURANT_ARG = arg('--restaurant');

// Auth mode args
const OWNER_EMAIL    = arg('--email');
const PASSWORD       = arg('--password');
const TOKEN_ARG      = arg('--token');
const ADMIN_LOGIN    = arg('--admin-login');
const ADMIN_PASSWORD = arg('--admin-password');
const STAFF_LOGIN_ID = arg('--login-id');

if (!CSV_FILE) {
  console.error('❌  --csv is required. Run with --help for usage.');
  process.exit(1);
}

// Determine which auth mode
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

if (authMode === 'token' && !RESTAURANT_ARG) {
  console.error('❌  --restaurant is required when using --token.');
  process.exit(1);
}
if (authMode === 'superadmin' && !RESTAURANT_ARG) {
  console.error('❌  --restaurant is required when using --admin-login.');
  process.exit(1);
}
if (authMode === 'stafflogin' && !RESTAURANT_ARG) {
  console.error('❌  --restaurant is required when using --login-id.');
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

// ─── Multipart form-data builder ─────────────────────────────────────────────
function buildFormData(fields, fileField, filePath) {
  const boundary = '----AtithiImport' + Math.random().toString(36).slice(2);
  const parts    = [];

  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === '') continue;
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`);
  }

  let fileBuffer = null;
  if (fileField && filePath && fs.existsSync(filePath)) {
    fileBuffer = fs.readFileSync(filePath);
    const ext  = path.extname(filePath).toLowerCase();
    const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                   '.gif': 'image/gif',  '.webp': 'image/webp' }[ext] || 'image/jpeg';
    const fname = path.basename(filePath);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fname}"\r\nContent-Type: ${mime}`);
  }

  const preamble = Buffer.from(parts.join('\r\n') + '\r\n\r\n');
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body     = fileBuffer
    ? Buffer.concat([preamble, fileBuffer, epilogue])
    : Buffer.concat([preamble, epilogue]);

  return { boundary, body };
}

// ─── CSV parser ───────────────────────────────────────────────────────────────
function parseCsv(text) {
  let cur = '', inQ = false;
  const lines = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { inQ = !inQ; cur += c; }
    else if (c === '\n' && !inQ) { lines.push(cur); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) lines.push(cur);

  const splitLine = (line) => {
    const vals = []; let cell = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') {
        if (q && line[i+1] === '"') { cell += '"'; i++; }
        else q = !q;
      } else if (line[i] === ',' && !q) { vals.push(cell.trim()); cell = ''; }
      else cell += line[i];
    }
    vals.push(cell.trim());
    return vals;
  };

  const filtered = lines.filter(l => l.trim());
  if (filtered.length < 2) return [];

  const headers = splitLine(filtered[0]).map(h => h.toLowerCase().trim());
  const rows = [];
  for (let i = 1; i < filtered.length; i++) {
    const vals = splitLine(filtered[i]);
    const row  = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] || '').trim(); });
    if (row.name) rows.push(row);
  }
  return rows;
}

// ─── Batch concurrency runner ─────────────────────────────────────────────────
async function runBatch(items, fn, concurrency) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const res = await Promise.all(items.slice(i, i + concurrency).map(fn));
    results.push(...res);
  }
  return results;
}

// ─── Progress bar ─────────────────────────────────────────────────────────────
function renderProgress(done, total, label) {
  const pct    = Math.round((done / total) * 100);
  const filled = Math.round((done / total) * 30);
  const bar    = '█'.repeat(filled) + '░'.repeat(30 - filled);
  process.stdout.write(`\r  [${bar}] ${pct}%  ${done}/${total}  ${label.slice(0, 30).padEnd(30)}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🍽️  Atithi-Setu Bulk Menu Import');
  console.log('═'.repeat(50));

  // ── 1. Read & parse CSV ───────────────────────────────────────────────────
  if (!fs.existsSync(CSV_FILE)) {
    console.error(`❌  CSV file not found: ${CSV_FILE}`); process.exit(1);
  }
  const rows = parseCsv(fs.readFileSync(CSV_FILE, 'utf8'));
  if (rows.length === 0) {
    console.error('❌  CSV is empty or has no valid data rows.'); process.exit(1);
  }
  console.log(`\n📄  CSV: ${rows.length} rows  |  ${path.resolve(CSV_FILE)}`);

  // Image path validation
  const getImgPath = r => (r.image_path || r.image_filename || '').trim();
  let imgFound = 0, imgMissing = 0, missingList = [];
  rows.forEach((r, i) => {
    const p = getImgPath(r);
    if (!p) return;
    if (fs.existsSync(p)) imgFound++;
    else { imgMissing++; missingList.push(`  Row ${i+2}: ${p}`); }
  });

  if (rows.some(r => getImgPath(r))) {
    console.log(`\n🖼️   Images:`);
    if (imgFound)   console.log(`    ✅  ${imgFound} file${imgFound !== 1 ? 's' : ''} found on disk`);
    if (imgMissing) {
      console.log(`    ⚠️   ${imgMissing} file${imgMissing !== 1 ? 's' : ''} not found — will import without image`);
      if (missingList.length <= 10) missingList.forEach(f => console.log(`    ${f}`));
    }
    if (rows.every(r => !getImgPath(r)))
      console.log(`    ─   No image_path values filled in`);
  }

  // Preview table
  console.log(`\n📋  Preview (first 10):`);
  console.log('  ' + '─'.repeat(80));
  console.log(`  ${'Name'.padEnd(25)} ${'Category'.padEnd(15)} ${'Type'.padEnd(10)} ${'Price'.padEnd(8)} Image`);
  console.log('  ' + '─'.repeat(80));
  rows.slice(0, 10).forEach(r => {
    const p = getImgPath(r);
    const imgStatus = !p ? '—' : fs.existsSync(p) ? '✅' : '⚠️  missing';
    console.log(`  ${(r.name||'').slice(0,24).padEnd(25)} ${(r.category||'').slice(0,14).padEnd(15)} ${(r.dietary_type||'VEG').padEnd(10)} ₹${(r.price_full||r.price||'?').padEnd(7)} ${imgStatus}`);
  });
  if (rows.length > 10) console.log(`  … and ${rows.length - 10} more rows`);
  console.log('  ' + '─'.repeat(80));

  if (DRY_RUN) {
    console.log('\n✅  --dry-run: no data uploaded.\n'); process.exit(0);
  }

  // ── 2. Authenticate ───────────────────────────────────────────────────────
  let token, restaurantId;

  console.log(`\n🔐  Authenticating (mode: ${authMode}) …`);

  if (authMode === 'token') {
    // Mode 2: pre-copied JWT — use as-is
    token        = TOKEN_ARG;
    restaurantId = RESTAURANT_ARG;
    console.log(`    ✅  Using provided token  |  Restaurant: ${restaurantId}`);

  } else if (authMode === 'superadmin') {
    // Mode 3: SUPER_ADMIN login → get scoped import token for the target restaurant
    try {
      const res = await request(`${SERVER}/api/auth/import-token`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, JSON.stringify({ loginId: ADMIN_LOGIN, password: ADMIN_PASSWORD, restaurantId: RESTAURANT_ARG }));

      if (res.status !== 200) {
        const b = (() => { try { return JSON.parse(res.body); } catch { return {}; } })();
        console.error(`❌  Admin auth failed (${res.status}): ${b.error || res.body}`);
        process.exit(1);
      }
      const data   = JSON.parse(res.body);
      token        = data.token;
      restaurantId = data.restaurantId;
      console.log(`    ✅  Admin token issued  |  Restaurant: ${restaurantId} — ${data.restaurantName}`);
    } catch (err) {
      console.error(`❌  Network error: ${err.message}`); process.exit(1);
    }

  } else if (authMode === 'stafflogin') {
    // Mode 4: staff loginId + password via /api/auth/login
    try {
      const res = await request(`${SERVER}/api/auth/login`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, JSON.stringify({ loginId: STAFF_LOGIN_ID, password: PASSWORD, restaurantId: RESTAURANT_ARG }));

      if (res.status !== 200) {
        const b = (() => { try { return JSON.parse(res.body); } catch { return {}; } })();
        console.error(`❌  Staff login failed (${res.status}): ${b.error || res.body}`);
        process.exit(1);
      }
      const data   = JSON.parse(res.body);
      token        = data.token;
      restaurantId = RESTAURANT_ARG || data.restaurantId;
      console.log(`    ✅  Staff login OK  |  Restaurant: ${restaurantId}`);
    } catch (err) {
      console.error(`❌  Network error: ${err.message}`); process.exit(1);
    }

  } else {
    // Mode 1: owner email/phone + password via /api/auth/owner/login
    try {
      const res = await request(`${SERVER}/api/auth/owner/login`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, JSON.stringify({ identifier: OWNER_EMAIL, password: PASSWORD }));

      if (res.status !== 200) {
        const b = (() => { try { return JSON.parse(res.body); } catch { return {}; } })();
        console.error(`❌  Owner login failed (${res.status}): ${b.error || res.body}`);
        process.exit(1);
      }
      const data = JSON.parse(res.body);
      token      = data.token || data.jwt_token;

      if (RESTAURANT_ARG) {
        restaurantId = RESTAURANT_ARG;
      } else if (data.restaurantId) {
        restaurantId = data.restaurantId;
      } else if (data.restaurants?.length === 1) {
        restaurantId = data.restaurants[0].id;
        // If owner has one restaurant, select it to get a proper scoped token
        const selRes = await request(`${SERVER}/api/auth/owner/select-restaurant`, {
          method : 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, JSON.stringify({ temp_token: token, restaurant_id: restaurantId }));
        if (selRes.status === 200) {
          const selData = JSON.parse(selRes.body);
          token = selData.jwt_token || token;
        }
      } else if (data.restaurants?.length > 1) {
        console.log('\n🏪  Multiple restaurants on this account. Specify --restaurant <id>:');
        data.restaurants.forEach(r => console.log(`    ${r.id}  →  ${r.name}`));
        process.exit(1);
      } else {
        console.error('❌  Could not determine restaurant ID. Use --restaurant <id>.');
        process.exit(1);
      }

      console.log(`    ✅  Owner login OK  |  Restaurant: ${restaurantId}`);
    } catch (err) {
      console.error(`❌  Network error: ${err.message}`); process.exit(1);
    }
  }

  // ── 3. Upload rows ────────────────────────────────────────────────────────
  console.log(`\n🚀  Uploading ${rows.length} items (concurrency: ${CONCURRENCY}) …\n`);
  let imported = 0, failed = 0, withImage = 0;

  const uploadRow = async (row) => {
    const imgPath = getImgPath(row);
    const hasImg  = imgPath && fs.existsSync(imgPath);

    const fields = {
      name            : row.name,
      description     : row.description     || '',
      price           : row.price_full || row.price || '0',
      price_half      : row.price_half      || '',
      price_full      : row.price_full || row.price || '0',
      category        : row.category        || 'Mains',
      dietary_type    : row.dietary_type    || 'VEG',
      is_daily_special: row.is_daily_special === 'true' ? 'true' : 'false',
    };

    const { boundary, body } = buildFormData(fields, hasImg ? 'image' : null, hasImg ? imgPath : null);

    try {
      const res = await request(
        `${SERVER}/api/restaurant/${restaurantId}/menu`,
        {
          method : 'POST',
          headers: {
            'Authorization' : `Bearer ${token}`,
            'Content-Type'  : `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        },
        body
      );

      if (res.status === 200 || res.status === 201) {
        imported++;
        if (hasImg) withImage++;
        renderProgress(imported + failed, rows.length, row.name);
        return true;
      } else {
        failed++;
        renderProgress(imported + failed, rows.length, `FAILED: ${row.name}`);
        return false;
      }
    } catch {
      failed++;
      renderProgress(imported + failed, rows.length, `ERROR: ${row.name}`);
      return false;
    }
  };

  await runBatch(rows, uploadRow, CONCURRENCY);

  // ── 4. Summary ────────────────────────────────────────────────────────────
  process.stdout.write('\n');
  console.log('\n' + '═'.repeat(50));
  console.log('✅  Import complete');
  console.log(`    Items imported : ${imported}`);
  if (withImage > 0) console.log(`    With images    : ${withImage}`);
  if (failed > 0)    console.log(`    Failed         : ${failed}`);
  console.log('');
}

main().catch(err => {
  console.error('\n❌  Unexpected error:', err.message || err);
  process.exit(1);
});
