/**
 * One-shot migration: uploads existing menu images from the VPS local disk
 * (public/uploads/) to Cloudflare R2 and rewrites menu.image_url in every
 * tenant schema to the full R2 URL.
 *
 * USAGE (from the repo root, on the VPS inside the node_app container):
 *
 *   docker compose exec app sh -lc 'npx tsx scripts/backfill-r2.ts --dry-run'
 *   docker compose exec app sh -lc 'npx tsx scripts/backfill-r2.ts'
 *
 * --dry-run reports what would happen without uploading or changing the DB.
 *
 * Idempotent: rows whose image_url already starts with "http" (already on
 * R2 / remote) are skipped. Disk files are NOT deleted — leave them for 30
 * days as a safety net, then clean up manually.
 *
 * Required env (same vars the server uses at runtime):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *   R2_BUCKET, R2_PUBLIC_BASE_URL
 *   DATABASE_URL (or PG* vars)
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { centralDb, getTenantDb } from "../db.ts";

const DRY_RUN = process.argv.includes("--dry-run");

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_PUBLIC_BASE_URL,
} = process.env;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_PUBLIC_BASE_URL) {
  console.error("[fatal] One or more required R2_* env vars are missing. Check .env.");
  process.exit(1);
}

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

const BASE_URL = R2_PUBLIC_BASE_URL.replace(/\/$/, "");
const UPLOADS_DIR = path.join(process.cwd(), "public", "uploads");

function contentTypeFor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "png":  return "image/png";
    case "webp": return "image/webp";
    case "gif":  return "image/gif";
    case "avif": return "image/avif";
    default:     return "application/octet-stream";
  }
}

async function migrateTenant(restaurantId: string): Promise<{ migrated: number; skipped: number; missing: number; errors: number }> {
  const summary = { migrated: 0, skipped: 0, missing: 0, errors: 0 };
  let db;
  try {
    db = await getTenantDb(restaurantId);
  } catch (err) {
    console.error(`  [error] Could not open tenant DB for ${restaurantId}:`, (err as Error).message);
    summary.errors++;
    return summary;
  }

  let rows: Array<{ id: string; image_url: string }>;
  try {
    rows = await db.query(
      "SELECT id, image_url FROM menu WHERE image_url IS NOT NULL AND image_url NOT ILIKE 'http%' AND image_url != ''"
    );
  } catch (err) {
    console.error(`  [error] Query failed for ${restaurantId}:`, (err as Error).message);
    summary.errors++;
    return summary;
  }

  if (rows.length === 0) {
    console.log(`  [skip] ${restaurantId}: no legacy image_url rows`);
    return summary;
  }

  console.log(`  [start] ${restaurantId}: ${rows.length} legacy image(s)`);

  for (const row of rows) {
    const legacyPath = row.image_url.startsWith("/uploads/")
      ? row.image_url.slice("/uploads/".length)
      : row.image_url;
    const diskPath = path.join(UPLOADS_DIR, legacyPath);

    if (!fs.existsSync(diskPath)) {
      console.log(`    [miss] ${row.id} → ${row.image_url} (not on disk)`);
      summary.missing++;
      continue;
    }

    const buffer = fs.readFileSync(diskPath);
    const ext = (legacyPath.match(/\.[a-zA-Z0-9]+$/)?.[0] || ".jpg").toLowerCase();
    const key = `menu/${restaurantId}/${randomUUID()}${ext}`;
    const publicUrl = `${BASE_URL}/${key}`;

    if (DRY_RUN) {
      console.log(`    [dry]  ${row.id} → would upload ${diskPath} (${buffer.length} bytes) → ${publicUrl}`);
      summary.migrated++;
      continue;
    }

    try {
      await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET!,
        Key: key,
        Body: buffer,
        ContentType: contentTypeFor(legacyPath),
        CacheControl: "public, max-age=31536000, immutable",
      }));
      await db.run("UPDATE menu SET image_url = ? WHERE id = ?", [publicUrl, row.id]);
      console.log(`    [ok]   ${row.id} → ${publicUrl}`);
      summary.migrated++;
    } catch (err) {
      console.error(`    [err]  ${row.id}:`, (err as Error).message);
      summary.errors++;
    }
  }

  return summary;
}

async function main() {
  console.log(`\n=== R2 backfill${DRY_RUN ? " (DRY RUN)" : ""} ===`);
  console.log(`R2 bucket:     ${R2_BUCKET}`);
  console.log(`Public URL:    ${BASE_URL}`);
  console.log(`Uploads dir:   ${UPLOADS_DIR}`);
  console.log();

  const restaurants = await centralDb.query(
    "SELECT id, name FROM restaurants WHERE is_active = 1 ORDER BY id"
  );

  if (restaurants.length === 0) {
    console.log("No active restaurants found. Nothing to migrate.");
    return;
  }

  console.log(`Found ${restaurants.length} active restaurant(s)\n`);

  const totals = { migrated: 0, skipped: 0, missing: 0, errors: 0 };

  for (const r of restaurants as Array<{ id: string; name: string }>) {
    console.log(`→ ${r.name} (${r.id})`);
    const s = await migrateTenant(r.id);
    totals.migrated += s.migrated;
    totals.skipped  += s.skipped;
    totals.missing  += s.missing;
    totals.errors   += s.errors;
  }

  console.log("\n=== Summary ===");
  console.log(`  Migrated:  ${totals.migrated}${DRY_RUN ? " (would be)" : ""}`);
  console.log(`  Missing on disk: ${totals.missing}`);
  console.log(`  Errors:    ${totals.errors}`);
  console.log();
  if (DRY_RUN) {
    console.log("Dry run complete. Re-run without --dry-run to apply.");
  } else if (totals.errors > 0) {
    console.log("Backfill finished with errors. Review the log and re-run — idempotent.");
    process.exit(1);
  } else {
    console.log("Backfill complete. Disk files retained for 30 days as a safety net.");
  }
}

main().catch(err => {
  console.error("\n[fatal]", err);
  process.exit(1);
}).finally(() => {
  // DB pool is long-lived, but we're done. Explicit exit avoids hanging.
  setTimeout(() => process.exit(), 500).unref();
});
