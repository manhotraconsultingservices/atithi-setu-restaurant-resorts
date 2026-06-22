#!/usr/bin/env node
/**
 * Atithi-Setu — Bulk Menu IMAGE Attachment CLI
 * =============================================
 * Attaches images from a local directory to ALREADY-EXISTING menu items for a
 * single restaurant. Unlike menu_import.cjs (which CREATES items from a CSV),
 * this script only UPDATES image_url on existing rows — safe to run on a
 * populated menu without creating duplicates.
 *
 * Matches images to items via category-scoped normalized filename comparison.
 * The directory layout is expected to be:
 *
 *   <imagesRoot>/
 *     beverages/           <- folder name normalized to CSV "Beverages"
 *       black-coffee.jpg
 *       green_tea.jpg
 *     main_course/
 *       butter_chicken.jpg
 *       dal-makhni.jpg
 *     ...
 *
 * ── Authentication Modes (pick one) ──────────────────────────────────────────
 *
 *  Mode 1 — Owner login
 *    node menu_image_attach.cjs --images ./imgs --email owner@x.com --password secret
 *
 *  Mode 2 — Pre-copied JWT
 *    node menu_image_attach.cjs --images ./imgs --token <jwt> --restaurant <id>
 *
 *  Mode 3 — Super Admin (recommended for platform operator)
 *    node menu_image_attach.cjs --images ./imgs --admin-login ADMIN-ANKUSH \
 *         --admin-password secret --restaurant <id>
 *
 *  Mode 4 — Staff loginId + password
 *    node menu_image_attach.cjs --images ./imgs --login-id OWNER-1001 \
 *         --password secret --restaurant <id>
 *
 * ── All Options ──────────────────────────────────────────────────────────────
 *   --images           Root image directory (required)
 *   --restaurant       Restaurant ID (required for modes 2, 3, 4)
 *   --server           Server base URL (default: https://naini-corbett-restaurant.atithi-setu.com)
 *   --concurrency      Parallel uploads (default: 10)
 *   --dry-run          Preview matches without uploading
 *   --force            Overwrite existing image_url (default: skip items with image)
 *   --help             Show this help
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const arg     = (flag) => { const i = args.indexOf(flag); return i !== -1 && i + 1 < args.length ? args[i + 1] : null; };
const hasFlag = (flag) => args.includes(flag);

if (hasFlag('--help') || args.length === 0) {
  console.log(`
Atithi-Setu Bulk Menu IMAGE Attachment CLI
══════════════════════════════════════════

Attaches local image files to existing menu items by category+name match.
SAFE on populated menus — only PATCHes image_url, never creates duplicates.

REQUIRED:
  --images           Root image directory (one subfolder per category)

AUTH (pick one mode):
  Mode 1 — Owner:
    --email <owner@x.com> --password <pwd>
  Mode 2 — Pre-copied JWT:
    --token <jwt> --restaurant <id>
  Mode 3 — Super Admin (RECOMMENDED):
    --admin-login ADMIN-ANKUSH --admin-password <pwd> --restaurant <id>
  Mode 4 — Staff:
    --login-id <OWNER-XXX> --password <pwd> --restaurant <id>

OPTIONAL:
  --server        Server URL (default: https://naini-corbett-restaurant.atithi-setu.com)
  --concurrency   Parallel uploads (default: 10)
  --dry-run       Preview matches without uploading
  --force         Overwrite images for items that already have one
  --help          Show this help

EXAMPLES:
  # Preview what will happen
  node menu_image_attach.cjs \\
    --images "C:\\workspace-atithi-setu\\naini-corbett" \\
    --admin-login ADMIN-ANKUSH --admin-password <pwd> \\
    --restaurant RESTO-1001 --dry-run

  # Apply for real
  node menu_image_attach.cjs \\
    --images "C:\\workspace-atithi-setu\\naini-corbett" \\
    --admin-login ADMIN-ANKUSH --admin-password <pwd> \\
    --restaurant RESTO-1001
`);
  process.exit(0);
}

const IMAGES_ROOT    = arg('--images');
const SERVER         = arg('--server') || 'https://naini-corbett-restaurant.atithi-setu.com';
const RESTAURANT_ARG = arg('--restaurant');
const CONCURRENCY    = Math.max(1, Math.min(20, parseInt(arg('--concurrency') || '10', 10)));
const DRY_RUN        = hasFlag('--dry-run');
const FORCE          = hasFlag('--force');

const OWNER_EMAIL    = arg('--email');
const PASSWORD       = arg('--password');
const TOKEN_ARG      = arg('--token');
const ADMIN_LOGIN    = arg('--admin-login');
const ADMIN_PASSWORD = arg('--admin-password');
const STAFF_LOGIN_ID = arg('--login-id');

if (!IMAGES_ROOT) {
  console.error('❌  --images is required');
  process.exit(1);
}
if (!fs.existsSync(IMAGES_ROOT) || !fs.statSync(IMAGES_ROOT).isDirectory()) {
  console.error(`❌  --images directory not found: ${IMAGES_ROOT}`);
  process.exit(1);
}

let authMode = null;
if (TOKEN_ARG)                                             authMode = 'token';
else if (ADMIN_LOGIN && ADMIN_PASSWORD && RESTAURANT_ARG)  authMode = 'superadmin';
else if (STAFF_LOGIN_ID && PASSWORD && RESTAURANT_ARG)     authMode = 'stafflogin';
else if (OWNER_EMAIL && PASSWORD)                          authMode = 'ownerlogin';
else {
  console.error('❌  No valid auth flags. Run --help for options.');
  process.exit(1);
}

// ─── HTTP helper (copied from menu_import.cjs) ───────────────────────────────
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

// ─── Multipart form-data builder (copied from menu_import.cjs) ───────────────
function buildFormData(fields, fileField, filePath) {
  const boundary = '----AtithiImage' + Math.random().toString(36).slice(2);
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

// ─── Batch concurrency runner (copied from menu_import.cjs) ──────────────────
async function runBatch(items, fn, concurrency) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const res = await Promise.all(items.slice(i, i + concurrency).map(fn));
    results.push(...res);
  }
  return results;
}

// ─── Progress bar (copied from menu_import.cjs) ──────────────────────────────
function renderProgress(done, total, label) {
  const pct    = Math.round((done / total) * 100);
  const filled = Math.round((done / total) * 30);
  const bar    = '█'.repeat(filled) + '░'.repeat(30 - filled);
  process.stdout.write(`\r  [${bar}] ${pct}%  ${done}/${total}  ${(label || '').slice(0, 30).padEnd(30)}`);
}

// ─── Matching helpers ────────────────────────────────────────────────────────
// Stopwords stripped during normalization so connector words don't break
// matches. "&" in CSV categories normalizes to empty space; spelled-out
// "and" in folder names (continental_and_chinese) must also drop so both
// sides converge on the same token set.
const STOPWORDS = new Set(['and', 'or', 'with', 'the', 'a', 'an', 'of']);

function normalize(s) {
  const rough = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return rough.split(' ').filter(t => t && !STOPWORDS.has(t)).join(' ');
}
function tokens(s) {
  return normalize(s).split(' ').filter(Boolean);
}
// Simple word-Jaccard for last-resort scoring
function jaccard(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
// Levenshtein distance (iterative DP, O(n*m) — fine for menu-sized strings)
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur  = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

// ─── Walk image tree: <root>/<category>/<file>.<ext> ─────────────────────────
function collectImages(root) {
  const out = []; // { categoryFolder, filename, filePath, nameKey, categoryKey }
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const subdir = path.join(root, e.name);
    const files  = fs.readdirSync(subdir, { withFileTypes: true });
    for (const f of files) {
      if (!f.isFile()) continue;
      const ext = path.extname(f.name).toLowerCase();
      if (!IMG_EXTS.has(ext)) continue;
      const nameNoExt = f.name.slice(0, -ext.length);
      out.push({
        categoryFolder: e.name,
        filename      : f.name,
        filePath      : path.join(subdir, f.name),
        nameKey       : normalize(nameNoExt),
        categoryKey   : normalize(e.name),
      });
    }
  }
  return out;
}

// ─── Match one image to one menu item within the same category ──────────────
function matchImageToItem(image, itemsInCategory) {
  // 1. Exact normalized name match
  let hit = itemsInCategory.find(it => it.nameKey === image.nameKey);
  if (hit) return { item: hit, strategy: 'exact' };

  // 2. Substring match — image name is contained in item name
  //    e.g. "boiled egg" ⊂ "boiled egg 4 piece"
  hit = itemsInCategory.find(it => it.nameKey.includes(image.nameKey));
  if (hit) return { item: hit, strategy: 'substring' };

  // 3. Reverse substring — item name is contained in image name
  hit = itemsInCategory.find(it => image.nameKey.includes(it.nameKey));
  if (hit) return { item: hit, strategy: 'reverse-substring' };

  // 4. Token subset — all image tokens appear in item tokens
  const imgToks = new Set(tokens(image.nameKey));
  if (imgToks.size) {
    hit = itemsInCategory.find(it => {
      const iToks = new Set(tokens(it.nameKey));
      for (const t of imgToks) if (!iToks.has(t)) return false;
      return true;
    });
    if (hit) return { item: hit, strategy: 'token-subset' };
  }

  // 5. Jaccard >= 0.5 on tokens (catches same-token-set with extra words)
  let best = null, bestScore = 0;
  for (const it of itemsInCategory) {
    const s = jaccard(image.nameKey, it.nameKey);
    if (s > bestScore) { best = it; bestScore = s; }
  }
  if (best && bestScore >= 0.5) return { item: best, strategy: `jaccard(${bestScore.toFixed(2)})` };

  // 6. Levenshtein edit distance — catches typo variants (Omelette vs Omlette)
  //    Threshold: distance <= 2 OR <= 15% of max length, whichever is more permissive.
  let leBest = null, leDist = Infinity;
  for (const it of itemsInCategory) {
    const d = levenshtein(image.nameKey, it.nameKey);
    if (d < leDist) { leDist = d; leBest = it; }
  }
  if (leBest) {
    const maxLen    = Math.max(image.nameKey.length, leBest.nameKey.length);
    const threshold = Math.max(2, Math.floor(maxLen * 0.15));
    if (leDist <= threshold) return { item: leBest, strategy: `levenshtein(${leDist})` };
  }

  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🖼️   Atithi-Setu Bulk Menu Image Attach');
  console.log('═'.repeat(50));
  console.log(`Server:       ${SERVER}`);
  console.log(`Auth mode:    ${authMode}`);
  console.log(`Images root:  ${IMAGES_ROOT}`);
  console.log(`Dry run:      ${DRY_RUN ? 'YES (no uploads)' : 'NO (live uploads)'}`);
  console.log(`Force:        ${FORCE ? 'YES (overwrite existing)' : 'NO (skip items with image)'}`);

  // ── 1. Collect images ──────────────────────────────────────────────────────
  const images = collectImages(IMAGES_ROOT);
  if (!images.length) {
    console.error(`❌  No images found under ${IMAGES_ROOT}/<category>/*.{jpg,png,webp,gif}`);
    process.exit(1);
  }
  const perCategory = {};
  for (const i of images) perCategory[i.categoryKey] = (perCategory[i.categoryKey] || 0) + 1;
  console.log(`\n📁  Images found: ${images.length} across ${Object.keys(perCategory).length} category folders`);
  Object.entries(perCategory).forEach(([c, n]) => console.log(`    ${c.padEnd(30)} ${n}`));

  // ── 2. Authenticate ────────────────────────────────────────────────────────
  let token, restaurantId;

  console.log(`\n🔐  Authenticating (mode: ${authMode}) …`);

  if (authMode === 'token') {
    token        = TOKEN_ARG;
    restaurantId = RESTAURANT_ARG;
    console.log(`    ✅  Using provided token  |  Restaurant: ${restaurantId}`);

  } else if (authMode === 'superadmin') {
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
    console.log(`    ✅  Admin token issued  |  Restaurant: ${restaurantId} — ${data.restaurantName || ''}`);

  } else if (authMode === 'stafflogin') {
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

  } else {
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
    restaurantId = RESTAURANT_ARG || data.restaurantId || (data.restaurants?.[0]?.id);
    if (!restaurantId) {
      console.error('❌  Could not determine restaurantId; pass --restaurant <id>');
      process.exit(1);
    }
    console.log(`    ✅  Owner login OK  |  Restaurant: ${restaurantId}`);
  }

  // ── 3. Fetch existing menu ─────────────────────────────────────────────────
  const menuRes = await request(`${SERVER}/api/restaurant/${restaurantId}/menu`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (menuRes.status !== 200) {
    console.error(`❌  Failed to fetch menu (${menuRes.status}): ${menuRes.body.slice(0, 200)}`);
    process.exit(1);
  }
  const menu = JSON.parse(menuRes.body);
  if (!Array.isArray(menu) || menu.length === 0) {
    console.error(`❌  Menu is empty for restaurant ${restaurantId} — nothing to attach images to.`);
    process.exit(1);
  }
  console.log(`\n📋  Fetched ${menu.length} existing menu items`);

  // Annotate items with normalized keys
  const itemsByCategory = {}; // categoryKey -> [items]
  for (const it of menu) {
    it.nameKey     = normalize(it.name);
    it.categoryKey = normalize(it.category);
    (itemsByCategory[it.categoryKey] ||= []).push(it);
  }
  Object.entries(itemsByCategory).forEach(([c, arr]) => {
    console.log(`    ${c.padEnd(30)} ${arr.length}`);
  });

  // ── 4. Match ───────────────────────────────────────────────────────────────
  const matches           = [];   // { image, item, strategy }
  const unmatchedImages   = [];   // images with no item
  const unknownCategories = new Set();

  for (const img of images) {
    const candidates = itemsByCategory[img.categoryKey];
    if (!candidates) {
      unknownCategories.add(img.categoryFolder);
      unmatchedImages.push({ img, reason: `category folder "${img.categoryFolder}" has no matching menu category` });
      continue;
    }
    const m = matchImageToItem(img, candidates);
    if (m) matches.push({ image: img, item: m.item, strategy: m.strategy });
    else   unmatchedImages.push({ img, reason: 'no item matched' });
  }

  // Items that received no image
  const matchedItemIds = new Set(matches.map(m => m.item.id));
  const itemsWithoutImage = menu.filter(it => !matchedItemIds.has(it.id));

  // ── 5. Match report ────────────────────────────────────────────────────────
  console.log(`\n📊  Match report`);
  console.log('─'.repeat(50));
  console.log(`  ✅  Matched:             ${matches.length} / ${images.length} images`);
  console.log(`  ⚠️   Unmatched images:    ${unmatchedImages.length}`);
  console.log(`  ⚠️   Items w/o image:     ${itemsWithoutImage.length}`);

  const byStrategy = matches.reduce((a, m) => { a[m.strategy] = (a[m.strategy] || 0) + 1; return a; }, {});
  if (Object.keys(byStrategy).length) {
    console.log('\n  By strategy:');
    Object.entries(byStrategy).forEach(([k, n]) => console.log(`    ${k.padEnd(22)} ${n}`));
  }

  if (unknownCategories.size) {
    console.log(`\n  ⚠️  Unknown category folders (no items have this category — misnamed folder?):`);
    [...unknownCategories].forEach(c => console.log(`    ${c}`));
  }

  if (unmatchedImages.length) {
    console.log(`\n  Unmatched images (first 30):`);
    unmatchedImages.slice(0, 30).forEach(u => console.log(`    [${u.img.categoryFolder}] ${u.img.filename} — ${u.reason}`));
    if (unmatchedImages.length > 30) console.log(`    … and ${unmatchedImages.length - 30} more`);
  }

  if (itemsWithoutImage.length) {
    console.log(`\n  Items without image (first 30):`);
    itemsWithoutImage.slice(0, 30).forEach(it => console.log(`    [${it.category}] ${it.name}`));
    if (itemsWithoutImage.length > 30) console.log(`    … and ${itemsWithoutImage.length - 30} more`);
  }

  console.log(`\n  Preview of first 15 matches:`);
  matches.slice(0, 15).forEach(m => {
    const hasExisting = (m.item.image || m.item.image_url || '').startsWith('http');
    const flag = hasExisting ? (FORCE ? '(will overwrite)' : '(will skip — has image)') : '';
    console.log(`    ${m.image.filename.padEnd(36)} → ${m.item.name.slice(0, 30).padEnd(30)} [${m.strategy}] ${flag}`);
  });
  if (matches.length > 15) console.log(`    … and ${matches.length - 15} more`);

  if (DRY_RUN) {
    console.log(`\n✅  --dry-run complete, no uploads performed.\n`);
    process.exit(0);
  }

  // ── 6. Upload phase ────────────────────────────────────────────────────────
  // Partition: items to upload vs skip (already has image and no --force)
  const toUpload = [];
  const skipped  = [];
  for (const m of matches) {
    const existing = m.item.image || m.item.image_url || '';
    if (existing.startsWith('http') && !FORCE) {
      skipped.push(m);
    } else {
      toUpload.push(m);
    }
  }

  if (!toUpload.length) {
    console.log(`\n⚠️  Nothing to upload (${skipped.length} items already have images; use --force to overwrite).\n`);
    process.exit(0);
  }

  console.log(`\n🚀  Uploading ${toUpload.length} image(s) at concurrency ${CONCURRENCY}…\n`);

  let done = 0, uploaded = 0, failed = 0;
  const failures = [];

  const worker = async (m) => {
    const fields   = {};
    const { boundary, body } = buildFormData(fields, 'image', m.image.filePath);

    try {
      const res = await request(`${SERVER}/api/menu/${m.item.id}`, {
        method : 'PATCH',
        headers: {
          Authorization : `Bearer ${token}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      }, body);

      done++;
      if (res.status >= 200 && res.status < 300) {
        uploaded++;
      } else {
        failed++;
        failures.push({ item: m.item.name, file: m.image.filename, status: res.status, body: res.body.slice(0, 160) });
      }
      renderProgress(done, toUpload.length, m.item.name);
    } catch (err) {
      done++; failed++;
      failures.push({ item: m.item.name, file: m.image.filename, status: 'ERR', body: err.message });
      renderProgress(done, toUpload.length, `ERR: ${m.item.name}`);
    }
  };

  await runBatch(toUpload, worker, CONCURRENCY);
  process.stdout.write('\n');

  // ── 7. Summary ─────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(50));
  console.log('✅  Upload complete');
  console.log(`    Uploaded:                   ${uploaded}`);
  console.log(`    Skipped (already had image): ${skipped.length}`);
  console.log(`    Failed:                     ${failed}`);
  console.log(`    Unmatched images:           ${unmatchedImages.length}`);
  console.log(`    Items still without image:  ${itemsWithoutImage.length + skipped.length - uploaded}`);

  if (failures.length) {
    console.log('\n  Failures:');
    failures.slice(0, 20).forEach(f => console.log(`    [${f.status}] ${f.item} (${f.file}) — ${f.body}`));
    if (failures.length > 20) console.log(`    … and ${failures.length - 20} more`);
    process.exit(1);
  }
  console.log('');
}

main().catch(err => {
  console.error('\n❌  Unexpected error:', err.stack || err.message || err);
  process.exit(1);
});
