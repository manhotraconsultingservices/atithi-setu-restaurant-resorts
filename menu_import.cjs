#!/usr/bin/env node
/**
 * Atithi-Setu — Bulk Menu Import CLI
 * ====================================
 * Reads a CSV file (with full local image_path values) and imports all
 * rows into the running server, uploading image files from disk.
 *
 * Usage:
 *   node menu_import.cjs --csv "C:\path\to\menu.csv" --email owner@email.com --password secret --restaurant <restaurantId>
 *
 * CSV columns (first row must be the header):
 *   name, category, description, dietary_type, price_half, price_full,
 *   is_daily_special, image_path
 *
 *   image_path  — FULL path to image file on this machine, e.g.
 *                 C:\Users\Admin\Pictures\food\butter_chicken.jpg
 *                 (leave blank if no image)
 *
 * Options:
 *   --csv          Path to the CSV file  (required)
 *   --email        Owner login email or phone  (required)
 *   --password     Owner password  (required)
 *   --restaurant   Restaurant ID  (optional — auto-detected if owner has one restaurant)
 *   --server       Server base URL  (default: http://localhost:4001)
 *   --concurrency  Number of parallel uploads  (default: 10)
 *   --dry-run      Parse CSV and show preview without uploading
 *   --help         Show this help
 *
 * Examples:
 *   node menu_import.cjs --csv menu.csv --email admin@rest.com --password pass123
 *   node menu_import.cjs --csv menu.csv --email admin@rest.com --password pass123 --restaurant abc123 --concurrency 15
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ─── Parse CLI args ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg  = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
};
const hasFlag = (flag) => args.includes(flag);

if (hasFlag('--help') || args.length === 0) {
  console.log(`
Atithi-Setu Bulk Menu Import
Usage:
  node menu_import.cjs --csv <file> --email <email> --password <pass> [options]

Required:
  --csv          Path to CSV file
  --email        Owner email or phone
  --password     Owner password

Optional:
  --restaurant   Restaurant ID (auto-detected if only one exists)
  --server       Server URL  (default: http://localhost:4001)
  --concurrency  Parallel uploads  (default: 10)
  --dry-run      Preview without uploading
  --help         Show help

CSV columns:
  name, category, description, dietary_type,
  price_half, price_full, is_daily_special, image_path

  image_path: Full path to local image file
  e.g.  C:\\Users\\Admin\\Pictures\\food\\butter_chicken.jpg
`);
  process.exit(0);
}

const CSV_FILE    = arg('--csv');
const EMAIL       = arg('--email');
const PASSWORD    = arg('--password');
const RESTAURANT  = arg('--restaurant');
const SERVER      = (arg('--server') || 'http://localhost:4001').replace(/\/$/, '');
const CONCURRENCY = parseInt(arg('--concurrency') || '10', 10);
const DRY_RUN     = hasFlag('--dry-run');

if (!CSV_FILE || !EMAIL || !PASSWORD) {
  console.error('❌  --csv, --email, and --password are required. Run with --help for usage.');
  process.exit(1);
}

// ─── HTTP helper (supports both http:// and https://) ────────────────────────
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
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`
    );
  }

  let fileBuffer = null;
  let mimeType   = 'application/octet-stream';
  if (fileField && filePath && fs.existsSync(filePath)) {
    fileBuffer = fs.readFileSync(filePath);
    const ext  = path.extname(filePath).toLowerCase();
    mimeType   = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                   '.gif': 'image/gif',  '.webp': 'image/webp' }[ext] || 'image/jpeg';
    const fname = path.basename(filePath);
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fname}"\r\nContent-Type: ${mimeType}`
    );
  }

  const preamble = Buffer.from(parts.join('\r\n') + '\r\n\r\n');
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body     = fileBuffer
    ? Buffer.concat([preamble, fileBuffer, epilogue])
    : Buffer.concat([preamble, epilogue]);

  return { boundary, body };
}

// ─── CSV parser (handles quoted fields, embedded commas & newlines) ───────────
function parseCsv(text) {
  const rows   = [];
  let cur      = '';
  let inQ      = false;
  const lines  = [];
  // Collect full logical lines (respecting quoted newlines)
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"')           { inQ = !inQ; cur += c; }
    else if (c === '\n' && !inQ) { lines.push(cur); cur = ''; }
    else                         { cur += c; }
  }
  if (cur.trim()) lines.push(cur);

  const splitLine = (line) => {
    const vals = []; let cell = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') {
        if (q && line[i+1] === '"') { cell += '"'; i++; }
        else q = !q;
      } else if (line[i] === ',' && !q) {
        vals.push(cell.trim()); cell = '';
      } else {
        cell += line[i];
      }
    }
    vals.push(cell.trim());
    return vals;
  };

  const filteredLines = lines.filter(l => l.trim());
  if (filteredLines.length < 2) return [];

  const headers = splitLine(filteredLines[0]).map(h => h.toLowerCase().trim());
  for (let i = 1; i < filteredLines.length; i++) {
    const vals = splitLine(filteredLines[i]);
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
    const batch = items.slice(i, i + concurrency);
    const res   = await Promise.all(batch.map(fn));
    results.push(...res);
  }
  return results;
}

// ─── Progress bar renderer ────────────────────────────────────────────────────
function renderProgress(done, total, label) {
  const pct   = Math.round((done / total) * 100);
  const width = 30;
  const filled = Math.round((done / total) * width);
  const bar   = '█'.repeat(filled) + '░'.repeat(width - filled);
  process.stdout.write(`\r  [${bar}] ${pct}%  ${done}/${total}  ${label}   `);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🍽️  Atithi-Setu Bulk Menu Import');
  console.log('═'.repeat(50));

  // 1. Read & parse CSV
  if (!fs.existsSync(CSV_FILE)) {
    console.error(`❌  CSV file not found: ${CSV_FILE}`); process.exit(1);
  }
  const csvText = fs.readFileSync(CSV_FILE, 'utf8');
  const rows    = parseCsv(csvText);
  if (rows.length === 0) {
    console.error('❌  CSV is empty or has no valid data rows.'); process.exit(1);
  }

  console.log(`\n📄  CSV loaded: ${rows.length} rows from ${path.resolve(CSV_FILE)}`);

  // Check for image_path column
  const hasImgPath = rows.some(r => r.image_path);

  // Validate image paths
  let imgFound = 0, imgMissing = 0, imgSkipped = 0;
  const missingFiles = [];
  rows.forEach((r, i) => {
    const p = (r.image_path || '').trim();
    if (!p) { imgSkipped++; return; }
    if (fs.existsSync(p)) imgFound++;
    else { imgMissing++; missingFiles.push(`  Row ${i+2}: ${p}`); }
  });

  if (hasImgPath) {
    console.log(`\n🖼️   Image paths:`);
    if (imgFound)    console.log(`    ✅  ${imgFound} file${imgFound !== 1 ? 's' : ''} found on disk`);
    if (imgMissing)  console.log(`    ⚠️   ${imgMissing} file${imgMissing !== 1 ? 's' : ''} NOT found — will import without image`);
    if (imgSkipped)  console.log(`    ─   ${imgSkipped} row${imgSkipped !== 1 ? 's' : ''} have no image_path`);
    if (missingFiles.length > 0 && missingFiles.length <= 20) {
      console.log('    Missing files:');
      missingFiles.forEach(f => console.log(`    ${f}`));
    }
  } else {
    console.log(`\n   ℹ️  No image_path column found — importing text data only.`);
    console.log(`   Tip: Add an image_path column with full paths like:`);
    console.log(`        C:\\Users\\Admin\\Pictures\\food\\butter_chicken.jpg`);
  }

  // Preview table
  console.log(`\n📋  Preview (first 10 rows):`);
  console.log('  ' + '─'.repeat(80));
  console.log(`  ${'Name'.padEnd(25)} ${'Category'.padEnd(15)} ${'Type'.padEnd(10)} ${'Price'.padEnd(8)} ${'Image'.padEnd(10)}`);
  console.log('  ' + '─'.repeat(80));
  rows.slice(0, 10).forEach(r => {
    const imgStatus = !r.image_path ? '—' : fs.existsSync(r.image_path) ? '✅' : '⚠️ missing';
    console.log(`  ${(r.name||'').slice(0,24).padEnd(25)} ${(r.category||'').slice(0,14).padEnd(15)} ${(r.dietary_type||'VEG').padEnd(10)} ₹${(r.price_full||r.price||'?').padEnd(7)} ${imgStatus}`);
  });
  if (rows.length > 10) console.log(`  ... and ${rows.length - 10} more rows`);
  console.log('  ' + '─'.repeat(80));

  if (DRY_RUN) {
    console.log('\n✅  --dry-run: no data uploaded. Remove --dry-run to import.\n');
    process.exit(0);
  }

  // 2. Login
  console.log(`\n🔐  Logging in to ${SERVER} as ${EMAIL} …`);
  let token, restaurantId;
  try {
    const loginRes = await request(`${SERVER}/api/auth/owner/login`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ identifier: EMAIL, password: PASSWORD }));

    if (loginRes.status !== 200) {
      const body = JSON.parse(loginRes.body);
      console.error(`❌  Login failed (${loginRes.status}): ${body.error || loginRes.body}`);
      process.exit(1);
    }

    const data = JSON.parse(loginRes.body);
    token = data.token;

    if (RESTAURANT) {
      restaurantId = RESTAURANT;
    } else if (data.restaurantId) {
      restaurantId = data.restaurantId;
    } else if (data.restaurants && data.restaurants.length === 1) {
      restaurantId = data.restaurants[0].id;
    } else if (data.restaurants && data.restaurants.length > 1) {
      console.log('\n🏪  Multiple restaurants found. Please specify --restaurant <id>:');
      data.restaurants.forEach(r => console.log(`    ${r.id}  →  ${r.name}`));
      process.exit(1);
    } else {
      console.error('❌  Could not determine restaurant ID. Use --restaurant <id>.');
      process.exit(1);
    }

    console.log(`    ✅  Logged in  |  Restaurant: ${restaurantId}`);
  } catch (err) {
    console.error(`❌  Network error during login: ${err.message}`);
    process.exit(1);
  }

  // 3. Upload rows
  console.log(`\n🚀  Importing ${rows.length} items (concurrency: ${CONCURRENCY}) …\n`);
  let imported = 0, failed = 0, withImage = 0;

  const uploadRow = async (row) => {
    const imgPath = (row.image_path || '').trim();
    const hasImg  = imgPath && fs.existsSync(imgPath);

    const fields = {
      name           : row.name,
      description    : row.description    || '',
      price          : row.price_full || row.price || '0',
      price_half     : row.price_half     || '',
      price_full     : row.price_full || row.price || '0',
      category       : row.category       || 'Mains',
      dietary_type   : row.dietary_type   || 'VEG',
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
        renderProgress(imported + failed, rows.length, row.name.slice(0, 30));
        return true;
      } else {
        failed++;
        renderProgress(imported + failed, rows.length, `FAILED: ${row.name.slice(0, 25)}`);
        return false;
      }
    } catch (err) {
      failed++;
      renderProgress(imported + failed, rows.length, `ERROR: ${row.name.slice(0, 25)}`);
      return false;
    }
  };

  await runBatch(rows, uploadRow, CONCURRENCY);

  // 4. Summary
  process.stdout.write('\n');
  console.log('\n' + '═'.repeat(50));
  console.log('✅  Import complete');
  console.log(`    Items imported : ${imported}`);
  if (withImage > 0)
    console.log(`    With images    : ${withImage}`);
  if (failed > 0)
    console.log(`    Failed         : ${failed}`);
  console.log('');
}

main().catch(err => {
  console.error('\n❌  Unexpected error:', err.message || err);
  process.exit(1);
});
