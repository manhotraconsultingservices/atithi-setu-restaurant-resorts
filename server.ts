import express from "express";
import type { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { centralDb, getTenantDb, initDb, seedLocations, getNextSequence, getNextTenantSequence, DbInterface } from "./db.ts";
import { sendEmail, sendSMS, sendWhatsApp, sendTelegram, buildNotificationContent } from "./notificationService.ts";
import { generateFormCPdf } from "./formCService.ts";
import { generateInvoicePdf } from "./invoiceService.ts";
import { generatePOPdf, buildPOEmailBody, type POPdfData } from "./poService.ts";
import { chatWithConcierge, analyzeSentiment } from "./aiService.ts";
import { provisionTenantSubdomain, deprovisionTenantSubdomain, cloudflareIsConfigured } from "./cloudflareService.ts";
import { downloadFromDrive } from "./googleDriveService.ts";
import multer from "multer";
import cron from "node-cron";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

// ── Multi-platform delivery integration ──────────────────────────────────
import {
  isCredentialKeyConfigured,
  decryptCredential,
  computeWebhookIdempotencyKey,
} from "./integrations/security.ts";
import {
  registerAdapter,
  listRegisteredChannels,
  tryGetAdapter,
} from "./integrations/registry.ts";
import { MockAdapter } from "./integrations/adapters/MockAdapter.ts";
import { UrbanPiperAdapter } from "./integrations/adapters/UrbanPiperAdapter.ts";
import { ONDCAdapter } from "./integrations/adapters/ONDCAdapter.ts";
import { SwiggyDirectAdapter } from "./integrations/adapters/SwiggyDirectAdapter.ts";
import { ZomatoDirectAdapter } from "./integrations/adapters/ZomatoDirectAdapter.ts";
import type { ChannelId, AdapterContext, NormalizedOrder } from "./integrations/types.ts";
import { ALL_CHANNEL_IDS } from "./integrations/types.ts";
import { enqueueSyncJob, processSyncJob, backoffSeconds, type PendingJobRow } from "./integrations/syncWorker.ts";
import { encryptCredential } from "./integrations/security.ts";

/** Returns a map of { "HH:MI" → bookedCount } for a given date, excluding cancelled bookings. */
async function getSlotCountMap(db: DbInterface, dateStr: string): Promise<Record<string, number>> {
  const rows = await db.query(
    "SELECT TO_CHAR(booking_time, 'HH24:MI') as t, COUNT(*) as count FROM bookings WHERE TO_CHAR(booking_date, 'YYYY-MM-DD') = ? AND status != 'CANCELLED' GROUP BY t",
    [dateStr]
  );
  const map: Record<string, number> = {};
  for (const r of rows) map[r.t] = Number(r.count);
  return map;
}

function extractDriveId(url: string) {
  if (!url) return null;
  const match = url.match(/[-\w]{25,}/);
  return match ? match[0] : null;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(process.cwd(), "public", "uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

// Menu image uploads use in-memory multer so the buffer can go either to
// Cloudflare R2 (when UPLOAD_BACKEND=r2) or fall back to local disk. The
// other upload endpoints (logos, watermarks, UPI QRs) keep using `upload`
// above — they're low-volume and stay on the VPS filesystem.
const menuImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB cap (modern phone photos often exceed 5 MB)
});

// ── Cloudflare R2 client (lazy-initialised on first use) ─────────────────────
// Keeping this lazy means UPLOAD_BACKEND=disk deployments don't need R2
// credentials configured, and a misconfigured R2 fails loudly at upload time
// rather than blocking server startup.
let _r2Client: S3Client | null = null;
function getR2Client(): S3Client {
  if (_r2Client) return _r2Client;
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error("R2 is enabled but R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY are not set");
  }
  _r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return _r2Client;
}

const useR2ForMenuImages = () => process.env.UPLOAD_BACKEND === "r2";

/**
 * Persists an uploaded menu image either to Cloudflare R2 or to the local
 * filesystem, depending on UPLOAD_BACKEND. Returns the URL that should be
 * stored in menu.image_url — a full https:// URL when R2 is active, or the
 * legacy "/uploads/<filename>" path otherwise.
 */
async function persistMenuImage(
  restaurantId: string,
  file: Express.Multer.File
): Promise<string> {
  if (useR2ForMenuImages()) {
    const bucket = process.env.R2_BUCKET;
    const baseUrl = process.env.R2_PUBLIC_BASE_URL;
    if (!bucket || !baseUrl) {
      throw new Error("R2 is enabled but R2_BUCKET / R2_PUBLIC_BASE_URL are not set");
    }
    const ext = (file.originalname.match(/\.[a-zA-Z0-9]+$/)?.[0] || ".jpg").toLowerCase();
    const key = `menu/${restaurantId}/${randomUUID()}${ext}`;
    await getR2Client().send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype || "application/octet-stream",
      CacheControl: "public, max-age=31536000, immutable",
    }));
    return `${baseUrl.replace(/\/$/, "")}/${key}`;
  }

  // Disk fallback — mirrors the legacy multer.diskStorage filename scheme so
  // the existing /uploads/:filename handler keeps working unchanged.
  const uploadDir = path.join(process.cwd(), "public", "uploads");
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  const safeName = file.originalname.replace(/[^\w.\-]+/g, "_");
  const filename = `${Date.now()}-${safeName}`;
  fs.writeFileSync(path.join(uploadDir, filename), file.buffer);
  return `/uploads/${filename}`;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), "public", "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const JWT_SECRET = process.env.JWT_SECRET || "fallback-secret-atithi-setu-2024";

// ====== Tenant slug helpers (per-tenant subdomain login) ======
const RESERVED_SLUGS = new Set([
  'www', 'api', 'admin', 'app', 'demo', 'internal', 'support',
  'mail', 'ftp', 'blog', 'cdn', 'static', 'help', 'docs', 'auth',
  'login', 'signup', 'register', 'test', 'staging', 'dev', 'erp'
]);

function slugify(name: string): string {
  return (name || '').toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

async function generateUniqueSlug(restaurantName: string, excludeId?: string): Promise<string> {
  let base = slugify(restaurantName) || 'restaurant';
  if (RESERVED_SLUGS.has(base)) base = `${base}-app`;
  let candidate = base;
  let n = 2;
  while (true) {
    const existing: any = await centralDb.get(
      'SELECT id FROM restaurants WHERE slug = ?',
      [candidate]
    );
    if (!existing || (excludeId && existing.id === excludeId)) return candidate;
    candidate = `${base}-${n}`;
    n++;
    if (n > 999) { candidate = `${base}-${Date.now().toString(36)}`; break; }
  }
  return candidate;
}

// ====== Hospitality module: per-tenant schema DDL ======
// Idempotent — safe to call multiple times. Creates 8 tables in the tenant
// schema used only when property_type IN ('HOTEL', 'BOTH'). Restaurant-only
// tenants never have these tables, so there is zero risk to their data.
async function createHotelTables(tenantDb: DbInterface): Promise<void> {
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      room_number         TEXT,
      floor               INT,
      type                TEXT,
      capacity            INT DEFAULT 2,
      base_rate           DOUBLE PRECISION DEFAULT 0,
      status              TEXT DEFAULT 'VACANT',
      amenities           TEXT,
      qr_code_data        TEXT,
      notes               TEXT,
      smoking_preference  TEXT DEFAULT 'NON_SMOKING',
      created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    -- Idempotent migration for existing tenants whose rooms table predates smoking_preference
    ALTER TABLE rooms ADD COLUMN IF NOT EXISTS smoking_preference TEXT DEFAULT 'NON_SMOKING';
    UPDATE rooms SET smoking_preference = 'NON_SMOKING' WHERE smoking_preference IS NULL;

    CREATE TABLE IF NOT EXISTS room_bookings (
      id                 TEXT PRIMARY KEY,
      room_id            TEXT,
      guest_name         TEXT NOT NULL,
      guest_phone        TEXT,
      guest_email        TEXT,
      guest_id_proof     TEXT,
      guest_nationality  TEXT,
      guest_state        TEXT,
      num_guests         INT DEFAULT 1,
      check_in_date      DATE NOT NULL,
      check_out_date     DATE NOT NULL,
      actual_checkin_at  TIMESTAMP,
      actual_checkout_at TIMESTAMP,
      status             TEXT DEFAULT 'BOOKED',
      booking_source     TEXT,
      room_rate          DOUBLE PRECISION,
      total_amount       DOUBLE PRECISION DEFAULT 0,
      special_requests   TEXT,
      created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    -- Phase 5 migration for existing tenants
    ALTER TABLE room_bookings ADD COLUMN IF NOT EXISTS guest_state TEXT;

    CREATE TABLE IF NOT EXISTS services (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      description      TEXT,
      category         TEXT NOT NULL,
      is_complimentary INT DEFAULT 1,
      price            DOUBLE PRECISION DEFAULT 0,
      price_type       TEXT DEFAULT 'FIXED',
      sla_minutes      INT,
      assigned_role    TEXT,
      icon             TEXT,
      image_url        TEXT,
      is_active        INT DEFAULT 1,
      display_order    INT DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS service_requests (
      id               TEXT PRIMARY KEY,
      room_id          TEXT,
      booking_id       TEXT,
      guest_session_id TEXT,
      service_id       TEXT,
      service_name     TEXT,
      category         TEXT,
      quantity         INT DEFAULT 1,
      notes            TEXT,
      priority         TEXT DEFAULT 'NORMAL',
      status           TEXT DEFAULT 'PENDING',
      assigned_to      TEXT,
      assigned_role    TEXT,
      is_complimentary INT DEFAULT 1,
      charge_amount    DOUBLE PRECISION DEFAULT 0,
      folio_entry_id   TEXT,
      requested_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      acknowledged_at  TIMESTAMP,
      completed_at     TIMESTAMP,
      guest_rating     INT,
      guest_feedback   TEXT
    );

    CREATE TABLE IF NOT EXISTS room_sessions (
      id               TEXT PRIMARY KEY,
      room_id          TEXT,
      booking_id       TEXT,
      session_token    TEXT UNIQUE NOT NULL,
      status           TEXT DEFAULT 'active',
      guest_name       TEXT,
      guest_phone      TEXT,
      opened_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      closed_at        TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS folios (
      id              TEXT PRIMARY KEY,
      booking_id      TEXT,
      room_id         TEXT,
      status          TEXT DEFAULT 'open',
      subtotal        DOUBLE PRECISION DEFAULT 0,
      gst_amount      DOUBLE PRECISION DEFAULT 0,
      service_charge  DOUBLE PRECISION DEFAULT 0,
      discount        DOUBLE PRECISION DEFAULT 0,
      grand_total     DOUBLE PRECISION DEFAULT 0,
      payment_method  TEXT,
      settled_at      TIMESTAMP,
      doc_type        TEXT DEFAULT 'INVOICE',
      parent_folio_id TEXT,
      reason          TEXT,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    -- Phase 5 migration for existing tenants
    ALTER TABLE folios ADD COLUMN IF NOT EXISTS doc_type TEXT DEFAULT 'INVOICE';
    ALTER TABLE folios ADD COLUMN IF NOT EXISTS parent_folio_id TEXT;
    ALTER TABLE folios ADD COLUMN IF NOT EXISTS reason TEXT;
    UPDATE folios SET doc_type = 'INVOICE' WHERE doc_type IS NULL;

    CREATE TABLE IF NOT EXISTS folio_entries (
      id         TEXT PRIMARY KEY,
      folio_id   TEXT,
      entry_type TEXT,
      description TEXT,
      quantity   INT DEFAULT 1,
      unit_price DOUBLE PRECISION,
      amount     DOUBLE PRECISION,
      gst_rate   DOUBLE PRECISION,
      gst_amount DOUBLE PRECISION,
      source_id  TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS guest_compliance_log (
      id                   TEXT PRIMARY KEY,
      booking_id           TEXT,
      form_type            TEXT,
      submitted_at         TIMESTAMP,
      submitted_by         TEXT,
      submission_reference TEXT,
      document_url         TEXT,
      status               TEXT DEFAULT 'pending'
    );

    CREATE INDEX IF NOT EXISTS idx_rooms_status          ON rooms(status);
    CREATE INDEX IF NOT EXISTS idx_bookings_room         ON room_bookings(room_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_status       ON room_bookings(status);
    CREATE INDEX IF NOT EXISTS idx_services_category     ON services(category);
    CREATE INDEX IF NOT EXISTS idx_requests_status       ON service_requests(status);
    CREATE INDEX IF NOT EXISTS idx_requests_role         ON service_requests(assigned_role);
    CREATE INDEX IF NOT EXISTS idx_requests_room         ON service_requests(room_id);
    CREATE INDEX IF NOT EXISTS idx_room_sessions_token   ON room_sessions(session_token);
    CREATE INDEX IF NOT EXISTS idx_folio_entries_folio   ON folio_entries(folio_id);
  `);
}

// Default service catalogue seeded when a tenant enables the hotel module
// for the first time. Tenants can edit/delete/add from the SERVICES tab.
const DEFAULT_HOTEL_SERVICES: Array<{
  name: string; category: string; description: string;
  sla: number; role: string; icon: string; comp: boolean; price: number;
}> = [
  // Housekeeping (complimentary)
  { name: 'Extra Towels',     category: 'HOUSEKEEPING', description: 'Request additional bath towels for your room.',           sla: 15, role: 'HOUSEKEEPING', icon: 'Droplet',     comp: true,  price: 0 },
  { name: 'Extra Pillows',    category: 'HOUSEKEEPING', description: 'Get more pillows delivered to your room.',                sla: 15, role: 'HOUSEKEEPING', icon: 'Bed',         comp: true,  price: 0 },
  { name: 'Room Cleaning',    category: 'HOUSEKEEPING', description: 'Request a housekeeping cleaning visit.',                  sla: 30, role: 'HOUSEKEEPING', icon: 'Sparkles',    comp: true,  price: 0 },
  { name: 'Toiletries',       category: 'HOUSEKEEPING', description: 'Soap, shampoo, conditioner, toothbrush, etc.',            sla: 20, role: 'HOUSEKEEPING', icon: 'Package',     comp: true,  price: 0 },
  { name: 'Do Not Disturb',   category: 'HOUSEKEEPING', description: 'Mark your room as Do Not Disturb.',                       sla: 5,  role: 'HOUSEKEEPING', icon: 'BellOff',     comp: true,  price: 0 },
  // Maintenance (complimentary)
  { name: 'AC Not Working',        category: 'MAINTENANCE', description: 'Air conditioning is not cooling properly.',           sla: 20, role: 'MAINTENANCE', icon: 'Wind',         comp: true,  price: 0 },
  { name: 'Plumbing Issue',        category: 'MAINTENANCE', description: 'Report a leak, clogged drain, or water issue.',       sla: 30, role: 'MAINTENANCE', icon: 'Wrench',       comp: true,  price: 0 },
  { name: 'Wi-Fi / TV Issue',      category: 'MAINTENANCE', description: 'Internet or television not working.',                 sla: 20, role: 'MAINTENANCE', icon: 'Wifi',         comp: true,  price: 0 },
  // Room Service / Concierge
  { name: 'Wake-up Call',     category: 'CONCIERGE', description: 'Schedule a wake-up call at your preferred time.',           sla: 5,  role: 'FRONT_DESK',  icon: 'Clock',        comp: true,  price: 0 },
  { name: 'Local Recommendations', category: 'CONCIERGE', description: 'Ask our concierge for restaurants, attractions, tours.', sla: 10, role: 'CONCIERGE', icon: 'MapPin',       comp: true,  price: 0 },
  // Chargeable upsells
  { name: 'Late Checkout (2 hrs)', category: 'UPGRADE', description: 'Extend checkout by 2 hours.',                             sla: 10, role: 'FRONT_DESK', icon: 'Clock',        comp: false, price: 500 },
  { name: 'Laundry Service',       category: 'LAUNDRY', description: 'Same-day wash & fold.',                                   sla: 240, role: 'HOUSEKEEPING', icon: 'Shirt',      comp: false, price: 300 },
];

// ====== Folio engine helpers (Phase 3) ======

// GST rate for Indian hotels based on room tariff (post-2022 tariff bands).
function gstRateForTariff(tariff: number): number {
  if (tariff < 1000) return 0;
  if (tariff <= 7500) return 12;
  return 18;
}

// Create a folio for a booking and seed ROOM_CHARGE entries for each night.
async function createFolioWithRoomCharges(restaurantId: string, booking: any): Promise<any> {
  try {
    const tenantDb = await getTenantDb(restaurantId);
    const existing: any = await tenantDb.get(
      "SELECT * FROM folios WHERE booking_id = ? AND status = 'open'", [booking.id]
    );
    if (existing) return existing;

    const folioId = `F-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    await tenantDb.run(
      `INSERT INTO folios (id, booking_id, room_id, status, subtotal, gst_amount, grand_total)
       VALUES (?, ?, ?, 'open', 0, 0, 0)`,
      [folioId, booking.id, booking.room_id]
    );
    const nights = Math.max(1, Math.ceil((new Date(booking.check_out_date).getTime() - new Date(booking.check_in_date).getTime()) / 86400000));
    const rate = Number(booking.room_rate) || 0;
    const gstPct = gstRateForTariff(rate);
    for (let i = 0; i < nights; i++) {
      const date = new Date(booking.check_in_date);
      date.setDate(date.getDate() + i);
      const gstAmt = rate * gstPct / 100;
      const entryId = `FE-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
      await tenantDb.run(
        `INSERT INTO folio_entries (id, folio_id, entry_type, description, quantity, unit_price, amount, gst_rate, gst_amount)
         VALUES (?, ?, 'ROOM_CHARGE', ?, 1, ?, ?, ?, ?)`,
        [entryId, folioId, `Room charge · ${date.toISOString().slice(0,10)}`, rate, rate, gstPct, gstAmt]
      );
    }
    await recomputeFolioTotals(tenantDb, folioId);
    return await tenantDb.get("SELECT * FROM folios WHERE id = ?", [folioId]);
  } catch (err) {
    console.error("createFolioWithRoomCharges error:", err);
    return null;
  }
}

// Post a completed chargeable service request as a folio entry.
async function postServiceChargeToFolio(restaurantId: string, sr: any): Promise<void> {
  const tenantDb = await getTenantDb(restaurantId);
  // Find the active folio for the room (via booking)
  let folioId: string | null = null;
  if (sr.booking_id) {
    const f: any = await tenantDb.get("SELECT id FROM folios WHERE booking_id = ? AND status = 'open'", [sr.booking_id]);
    if (f) folioId = f.id;
  }
  if (!folioId) {
    // Fall back: find most recent open folio for this room
    const f: any = await tenantDb.get("SELECT id FROM folios WHERE room_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1", [sr.room_id]);
    if (f) folioId = f.id;
  }
  if (!folioId) return; // no active folio — skip

  const entryId = `FE-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const qty = Number(sr.quantity) || 1;
  const amount = Number(sr.charge_amount) || 0;
  const unitPrice = qty > 0 ? amount / qty : amount;
  // Services typically 18% GST in India
  const gstPct = 18;
  const gstAmt = amount * gstPct / 100;
  await tenantDb.run(
    `INSERT INTO folio_entries (id, folio_id, entry_type, description, quantity, unit_price, amount, gst_rate, gst_amount, source_id)
     VALUES (?, ?, 'SERVICE', ?, ?, ?, ?, ?, ?, ?)`,
    [entryId, folioId, sr.service_name, qty, unitPrice, amount, gstPct, gstAmt, sr.id]
  );
  await tenantDb.run("UPDATE service_requests SET folio_entry_id = ? WHERE id = ?", [entryId, sr.id]);
  await recomputeFolioTotals(tenantDb, folioId);
}

async function recomputeFolioTotals(tenantDb: DbInterface, folioId: string): Promise<void> {
  const sums: any = await tenantDb.get(
    `SELECT COALESCE(SUM(amount), 0) AS subtotal, COALESCE(SUM(gst_amount), 0) AS gst
     FROM folio_entries WHERE folio_id = ?`, [folioId]
  );
  const subtotal = Number(sums?.subtotal || 0);
  const gst = Number(sums?.gst || 0);
  const f: any = await tenantDb.get("SELECT discount FROM folios WHERE id = ?", [folioId]);
  const discount = Number(f?.discount || 0);
  const grand = Math.max(0, subtotal + gst - discount);
  await tenantDb.run("UPDATE folios SET subtotal = ?, gst_amount = ?, grand_total = ? WHERE id = ?", [subtotal, gst, grand, folioId]);
}

async function settleFolioForBooking(restaurantId: string, bookingId: string, paymentMethod: string, discount: number, waive: boolean): Promise<any> {
  const tenantDb = await getTenantDb(restaurantId);
  const folio: any = await tenantDb.get("SELECT * FROM folios WHERE booking_id = ? AND status = 'open'", [bookingId]);
  if (!folio) return null;
  if (waive) {
    // Zero out charges — just close as voided
    await tenantDb.run("UPDATE folios SET status = 'voided', settled_at = ?, payment_method = ? WHERE id = ?",
      [new Date().toISOString(), paymentMethod, folio.id]);
  } else {
    if (discount > 0) await tenantDb.run("UPDATE folios SET discount = ? WHERE id = ?", [discount, folio.id]);
    await recomputeFolioTotals(tenantDb, folio.id);
    await tenantDb.run("UPDATE folios SET status = 'settled', settled_at = ?, payment_method = ? WHERE id = ?",
      [new Date().toISOString(), paymentMethod, folio.id]);
  }
  return await tenantDb.get("SELECT * FROM folios WHERE id = ?", [folio.id]);
}

// Seed defaults into the tenant's services table if it's empty.
async function seedDefaultServices(tenantDb: DbInterface): Promise<number> {
  const existing: any = await tenantDb.get("SELECT COUNT(*) AS n FROM services");
  if (existing && Number(existing.n) > 0) return 0;
  let seeded = 0;
  for (let i = 0; i < DEFAULT_HOTEL_SERVICES.length; i++) {
    const s = DEFAULT_HOTEL_SERVICES[i];
    await tenantDb.run(
      `INSERT INTO services (id, name, description, category, is_complimentary, price, price_type, sla_minutes, assigned_role, icon, is_active, display_order)
       VALUES (?, ?, ?, ?, ?, ?, 'FIXED', ?, ?, ?, 1, ?)`,
      [`SVC-${Date.now()}-${i}`, s.name, s.description, s.category, s.comp ? 1 : 0, s.price, s.sla, s.role, s.icon, i]
    );
    seeded++;
  }
  return seeded;
}

// Extended Request Interface for TypeScript.
// Reflects every field that any jwt.sign() site puts into the token, all
// optional because different code paths sign different shapes:
//   • new owner-account login → { email, restaurantId, role, userName }
//   • temp token before restaurant select → { email, userName } (no restaurantId)
//   • legacy users login → { id, restaurantId, role, userName }
//   • password-reset / migration → { email } only
// Code at the call sites already narrows correctly (e.g. `if (req.user!.email)`
// routes to email-based queries; otherwise falls back to `req.user!.id`).
interface AuthRequest extends Request {
  user?: {
    id?: string;
    restaurantId?: string;
    role?: string;
    email?: string;
    userName?: string;
  };
}

// When a tenant's access is revoked, they enter READ-ONLY mode:
//  - GET / HEAD / OPTIONS requests continue to work (owner can read &
//    download their data, run reports, view history)
//  - POST / PUT / PATCH / DELETE are blocked with a 402 explaining
//    payment is needed
// Auth and billing-status endpoints stay callable regardless of method so
// the owner can log in, see status, and (after admin restores access)
// resume normal operation without re-authenticating.
const ALWAYS_ALLOWED_WHEN_REVOKED: RegExp[] = [
  /^\/api\/auth\//,
  /^\/api\/login/,
  /^\/api\/logout/,
  /^\/api\/admin\//,
  /\/billing-status$/,
  /^\/api\/restaurant\/[^/]+\/billing-status$/,
  /\/uploads\//,
];
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Middleware
const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token provided" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    req.user = decoded;

    // Access-revocation check. Skip for admins (they need to manage tenants),
    // skip for whitelisted paths (login/billing-status), skip for SYSTEM tenant,
    // skip for read-only HTTP methods (GET/HEAD/OPTIONS) — owners keep read
    // access even after revocation; only mutations are blocked.
    const role = decoded?.role;
    const isAdminUser = role === 'SUPER_ADMIN' || role === 'CTO';
    const tenantId = decoded?.restaurantId;
    const path = req.originalUrl || req.url || '';
    const method = (req.method || 'GET').toUpperCase();
    const isWhitelisted = ALWAYS_ALLOWED_WHEN_REVOKED.some(rx => rx.test(path));
    const isReadOnly = READ_ONLY_METHODS.has(method);

    if (!isAdminUser && tenantId && tenantId !== 'SYSTEM' && !isWhitelisted && !isReadOnly) {
      try {
        const row: any = await centralDb.get(
          "SELECT access_revoked, access_revoked_reason FROM restaurants WHERE id = ?",
          [tenantId]
        );
        if (row && Number(row.access_revoked) === 1) {
          return res.status(402).json({
            error: "Read-only mode",
            code: "ACCESS_REVOKED_READ_ONLY",
            reason: row.access_revoked_reason || "Subscription payment overdue",
            message:
              "Your account is currently in read-only mode while we process your subscription payment. " +
              "You can continue to view, export, and download your data. Creating, editing, and deleting " +
              "are paused until the account is restored. Please contact our billing team to resolve.",
            contact: {
              email: "billing@atithi-setu.com",
              whatsapp: "+91 70111 89371",
            },
          });
        }
      } catch (err) {
        // Don't fail open on DB errors — log and continue (we don't want
        // a DB hiccup to lock out every tenant). The hourly banner will
        // surface real revocations on the next poll.
        console.error("Access-revoked check failed:", err);
      }
    }
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
};

const isAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'SUPER_ADMIN' && req.user?.role !== 'CTO') {
    return res.status(403).json({ error: "Access denied" });
  }
  next();
};

// Resolve the target tenant for a request:
//  • SUPER_ADMIN / CTO may target any tenant via ?restaurantId= (acting-as flow).
//    This lets the Internal Admin console drive HR ops on every tenant.
//  • Everyone else operates on their own restaurantId (unchanged).
function resolveTargetRestaurantId(req: AuthRequest): string | null {
  const role = req.user?.role;
  const override = (req.query?.restaurantId as string)
                || (req.body && (req.body as any).restaurantId);
  if (override && (role === 'SUPER_ADMIN' || role === 'CTO')) {
    return String(override);
  }
  return req.user?.restaurantId ?? null;
}

const MAX_TENANTS_IN_MEMORY = 100;

async function triggerNotification(restaurantId: string, eventName: string, data: any) {
  try {
    // Inject restaurant name so all notifications display the correct restaurant
    if (!data.restaurantName) {
      const rRow = await centralDb.get("SELECT name FROM restaurants WHERE id = ?", [restaurantId]);
      data = { ...data, restaurantName: rRow?.name || 'Atithi-Setu' };
    }

    const db = await getTenantDb(restaurantId);
    const settings = await db.query("SELECT * FROM notification_settings WHERE event_name = ?", [eventName]);
    if (!settings || settings.length === 0) return;

    for (const setting of settings) {
      // Determine recipients based on role
      let recipients: string[] = [];
      if (setting.role === 'CUSTOMER' && data.customerEmail) {
        recipients.push(data.customerEmail);
        if (data.customerPhone) recipients.push(data.customerPhone);
      } else {
        // Fetch users with this role for this restaurant
        const users = await centralDb.query("SELECT email, phone FROM users WHERE restaurant_id = ? AND role = ? AND is_active = 1", [restaurantId, setting.role]);
        users.forEach(u => {
          if (u.email) recipients.push(u.email);
          if (u.phone) recipients.push(u.phone);
        });
      }

      // Add manual recipients if any
      if (setting.recipients) {
        setting.recipients.split(',').forEach((r: string) => recipients.push(r.trim()));
      }

      let content = buildNotificationContent(eventName, data);
      // Owner-customisable template override (Tier-2 / QOL).
      // If the tenant has a row in notification_templates for this event_type
      // and it's enabled, substitute its subject/body templates with simple
      // {{variable}} interpolation against the data object.
      try {
        const tmpl: any = await db.get(
          "SELECT subject_template, body_template, enabled FROM notification_templates WHERE event_type = ?",
          [eventName]
        ).catch(() => null);
        if (tmpl && Number(tmpl.enabled) !== 0) {
          const interpolate = (s: string) =>
            String(s).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
              const v = k.split('.').reduce((acc: any, p: string) => acc == null ? acc : acc[p], data);
              return v == null ? '' : String(v);
            });
          if (tmpl.subject_template) content = { ...content, subject: interpolate(tmpl.subject_template) };
          if (tmpl.body_template) {
            const txt = interpolate(tmpl.body_template);
            content = { ...content, text: txt, html: txt.replace(/\n/g, '<br/>') };
          }
        }
      } catch { /* fall back to default content */ }
      // Deduplicate recipients (same email/phone might appear via role lookup + manual list)
      const uniqueRecipients = [...new Set(recipients.filter(Boolean))];

      for (const recipient of uniqueRecipients) {
        const isEmail = recipient.includes('@');
        if (setting.email_enabled && isEmail) {
          await sendEmail(recipient, content.subject, content.text, content.html);
        }
        if (setting.sms_enabled && !isEmail) {
          await sendSMS(recipient, content.text);
        }
        if (setting.whatsapp_enabled && !isEmail) {
          await sendWhatsApp(recipient, content.text);
        }
      }
      // Telegram: channel-level (not per-recipient), uses stored chat_id override or env default
      if (setting.telegram_enabled) {
        await sendTelegram(setting.telegram_chat_id || null, content.text);
      }
    }
  } catch (err) {
    console.error(`Failed to trigger notification for ${eventName}:`, err);
  }
}

async function startServer() {
  try {
    await initDb();
    await seedLocations();
  } catch (err) {
    console.error("Failed to initialize database:", err);
    console.log("Retrying in 5 seconds...");
    setTimeout(startServer, 5000);
    return;
  }

  // ── Bootstrap delivery-platform integration adapters ───────────────────
  // Phase 5: register all real adapters at boot. Switching platforms is
  // purely a question of channel_settings.is_active + credentials, never
  // code. Adapters are pluggable and resolved by channel id at request time.
  //
  // MOCK_INTEGRATIONS=1 env flag (dev / CI only) overrides URBANPIPER with
  // MockAdapter so the test suite can exercise the full pipeline without
  // hitting UrbanPiper's sandbox. In production this stays unset → real
  // UrbanPiperAdapter handles URBANPIPER traffic.
  //
  // The webhook endpoints additionally check `isCredentialKeyConfigured()`
  // before accepting traffic — if the master key isn't configured, the
  // routes 503 with a clear "Integration not configured" response rather
  // than silently writing plaintext credentials.
  try {
    if (process.env.MOCK_INTEGRATIONS === '1') {
      registerAdapter(new MockAdapter());
      console.log('[integrations] MOCK_INTEGRATIONS=1 → MockAdapter mounted as URBANPIPER (dev mode)');
    } else {
      registerAdapter(new UrbanPiperAdapter());
    }
    registerAdapter(new ONDCAdapter());
    registerAdapter(new SwiggyDirectAdapter());
    registerAdapter(new ZomatoDirectAdapter());
    if (!isCredentialKeyConfigured()) {
      console.warn(
        '[integrations] ATITHI_CREDENTIAL_KEY env var is not configured. ' +
        'Delivery-platform credential storage will be disabled. ' +
        'Generate one via `openssl rand -base64 32` to enable.'
      );
    }
    console.log(`[integrations] ${listRegisteredChannels().length} adapter(s) registered: ${listRegisteredChannels().join(', ')}`);
  } catch (err) {
    console.error('[integrations] Bootstrap failed:', err);
    // Non-fatal — the rest of the server boots fine without the integration module.
  }

  // Ensure SYSTEM restaurant exists
  await centralDb.run(`
    INSERT INTO restaurants (id, name, admin_id, state, city, is_active, registered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `, ["SYSTEM", "RestoFlow System", "SYSTEM-ADMIN", "N/A", "N/A", 1, new Date().toISOString()]);

  // ====== Per-tenant subdomain: slug column migration + backfill ======
  try {
    // Add slug column if missing (idempotent)
    await centralDb.run(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS slug TEXT`);
    await centralDb.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_slug ON restaurants(slug) WHERE slug IS NOT NULL AND slug <> ''`);

    // Backfill slugs for any restaurant missing one
    const needsSlug: any[] = await centralDb.query(
      "SELECT id, name FROM restaurants WHERE (slug IS NULL OR slug = '') AND id <> 'SYSTEM'"
    );
    if (needsSlug.length > 0) {
      console.log(`[slug-migration] Generating slugs for ${needsSlug.length} restaurant(s)...`);
      for (const r of needsSlug) {
        const slug = await generateUniqueSlug(r.name || r.id, r.id);
        await centralDb.run("UPDATE restaurants SET slug = ? WHERE id = ?", [slug, r.id]);
        console.log(`[slug-migration]   ${r.id}: "${r.name}" → ${slug}`);
      }
    }
  } catch (err) {
    console.error("[slug-migration] Warning:", err);
  }

  // ====== Hospitality module: property_type column migration ======
  // Single feature-gate column. Values: 'RESTAURANT' | 'HOTEL' | 'BOTH'.
  // Default preserves legacy tenants (they all remain pure restaurant).
  try {
    await centralDb.run(
      `ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS property_type TEXT DEFAULT 'RESTAURANT'`
    );
    await centralDb.run(
      `UPDATE restaurants SET property_type = 'RESTAURANT' WHERE property_type IS NULL`
    );
    // Phase 5: logo for invoice branding
    await centralDb.run(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS logo_url TEXT`);
    // Menu display mode — how the customer QR menu renders (PHOTO|CARD|COMPACT|MAGAZINE)
    await centralDb.run(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS menu_display_mode TEXT DEFAULT 'PHOTO'`);
    await centralDb.run(`UPDATE restaurants SET menu_display_mode = 'PHOTO' WHERE menu_display_mode IS NULL`);
    // Audible + visual alert toggle for unacknowledged waiter-calls / service-requests
    await centralDb.run(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS alerts_enabled INT DEFAULT 1`);
    await centralDb.run(`UPDATE restaurants SET alerts_enabled = 1 WHERE alerts_enabled IS NULL`);
    console.log("[hospitality-migration] property_type + logo_url + menu_display_mode + alerts_enabled ensured");
  } catch (err) {
    console.error("[hospitality-migration] Warning:", err);
  }

  // ====== Invoice deletion feature flag + audit tables ======
  // Per-tenant feature gate. When invoice_delete_enabled = 1, the tenant's
  // OWNER can permanently delete invoices (incl. PRINTED). OFF by default;
  // only SUPER_ADMIN can flip it. Every deletion writes a JSON snapshot to
  // invoice_deletion_audit so a forensic record exists post-delete.
  try {
    await centralDb.run(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS invoice_delete_enabled INT DEFAULT 0`);
    await centralDb.run(`UPDATE restaurants SET invoice_delete_enabled = 0 WHERE invoice_delete_enabled IS NULL`);

    await centralDb.run(`
      CREATE TABLE IF NOT EXISTS invoice_deletion_audit (
        id              TEXT PRIMARY KEY,
        restaurant_id   TEXT NOT NULL,
        invoice_type    TEXT NOT NULL,
        invoice_id      TEXT NOT NULL,
        customer_name   TEXT,
        total_amount    NUMERIC,
        gst_amount      NUMERIC,
        reason          TEXT NOT NULL,
        deleted_by_user_id TEXT NOT NULL,
        deleted_by_role TEXT NOT NULL,
        deleted_at      TIMESTAMPTZ DEFAULT NOW(),
        snapshot_json   TEXT NOT NULL
      )
    `);
    await centralDb.run(`CREATE INDEX IF NOT EXISTS ix_inv_del_audit_restaurant ON invoice_deletion_audit (restaurant_id, deleted_at DESC)`);

    await centralDb.run(`
      CREATE TABLE IF NOT EXISTS invoice_delete_flag_audit (
        id              TEXT PRIMARY KEY,
        restaurant_id   TEXT NOT NULL,
        enabled         INT NOT NULL,
        changed_by      TEXT NOT NULL,
        changed_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log("[invoice-delete-migration] flag column + audit tables ensured");
  } catch (err) {
    console.error("[invoice-delete-migration] Warning:", err);
  }

  // ====== Owner-configurable invoice numbering (RANDOM / SEQUENTIAL) ======
  // Three new per-tenant settings on `restaurants`. Defaults preserve existing
  // behaviour for every tenant — RANDOM mode means we don't populate the new
  // invoice_number column, and the frontend continues to display the legacy
  // "#last-8-chars" form.
  try {
    await centralDb.run(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS invoice_numbering_mode TEXT DEFAULT 'RANDOM'`);
    await centralDb.run(`UPDATE restaurants SET invoice_numbering_mode = 'RANDOM' WHERE invoice_numbering_mode IS NULL`);
    await centralDb.run(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS invoice_number_prefix TEXT DEFAULT 'INV-'`);
    await centralDb.run(`UPDATE restaurants SET invoice_number_prefix = 'INV-' WHERE invoice_number_prefix IS NULL`);
    await centralDb.run(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS invoice_yearly_reset INTEGER DEFAULT 0`);
    await centralDb.run(`UPDATE restaurants SET invoice_yearly_reset = 0 WHERE invoice_yearly_reset IS NULL`);
    console.log("[invoice-numbering-migration] mode + prefix + yearly_reset columns ensured");
  } catch (err) {
    console.error("[invoice-numbering-migration] Warning:", err);
  }

  // ====== Per-tenant hotel schema migrations ======
  // On every startup, re-run createHotelTables() for tenants that have the
  // hotel module enabled. This makes ALTER TABLE ... ADD COLUMN IF NOT EXISTS
  // changes land on existing tenants without requiring them to toggle the
  // module off/on.
  try {
    const hotelTenants: any[] = await centralDb.query(
      "SELECT id FROM restaurants WHERE property_type IN ('HOTEL', 'BOTH')"
    );
    for (const t of hotelTenants) {
      try {
        const tenantDb = await getTenantDb(t.id);
        await createHotelTables(tenantDb);
      } catch (err) {
        console.error(`[hotel-tenant-migration] tenant ${t.id}:`, err);
      }
    }
    if (hotelTenants.length > 0) console.log(`[hotel-tenant-migration] Ran for ${hotelTenants.length} hotel tenant(s)`);
  } catch (err) {
    console.error("[hotel-tenant-migration] error:", err);
  }

  // Create or Update default super admin (robust upsert avoiding email uniqueness crash)
  try {
    const hashedPassword = await bcrypt.hash("admin123", 12);
    const existingAdmin = await centralDb.get("SELECT id FROM users WHERE login_id = ?", ["ADMIN-ANKUSH"]);
    if (!existingAdmin) {
      await centralDb.run(`
        INSERT INTO users (id, login_id, name, email, phone, password, restaurant_id, role, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [randomUUID(), "ADMIN-ANKUSH", "Ankush Admin", "ankushmanhotra@gmail.com", "0000000000", hashedPassword, "SYSTEM", "SUPER_ADMIN", 1]);
    }
    await centralDb.run("UPDATE users SET password = ?, role = 'SUPER_ADMIN', is_active = 1 WHERE login_id = ?", [hashedPassword, "ADMIN-ANKUSH"]);
    console.log("Default SUPER_ADMIN verified: ADMIN-ANKUSH / admin123");
  } catch (err) {
    console.error("Warning: Could not seed SUPER_ADMIN user:", err);
  }

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Admin: Get Users
  app.get("/api/admin/users", authenticate, isAdmin, async (req: AuthRequest, res: Response) => {
    try {
      const users = await centralDb.query("SELECT id, login_id, name, email, phone, role, is_active FROM users WHERE role IN ('SUPER_ADMIN', 'SALES_REP', 'CTO')");
      res.json(users);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  // Admin: Create Internal User
  app.post("/api/admin/users", authenticate, isAdmin, async (req: AuthRequest, res: Response) => {
    const { loginId, name, email, phone, password, role } = req.body;
    try {
      const hashedPassword = await bcrypt.hash(password, 12);
      await centralDb.run(`
        INSERT INTO users (id, login_id, name, email, phone, password, restaurant_id, role, is_active) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [randomUUID(), loginId, name, email, phone, hashedPassword, "SYSTEM", role, 1]);
      res.json({ success: true });
    } catch (err) {
      console.error("Create internal user error:", err);
      res.status(500).json({ error: "Failed to create user. Login ID or Email might already exist." });
    }
  });

  // Admin: Toggle User Status
  app.post("/api/admin/users/:id/toggle-status", authenticate, isAdmin, async (req: AuthRequest, res: Response) => {
    const { is_active } = req.body;
    try {
      await centralDb.run("UPDATE users SET is_active = ? WHERE id = ?", [is_active === 1 ? 0 : 1, req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to update user status" });
    }
  });

  // Admin: Get Restaurants
  app.get("/api/admin/restaurants", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      let query = `
        SELECT r.*,
          COALESCE(u.name,  oa.owner_name)   AS owner_name,
          COALESCE(u.email, oa.email)         AS owner_email,
          COALESCE(u.login_id, oa.email)      AS owner_login_id,
          COALESCE(u.phone, oa.phone_number)  AS owner_phone,
          u.id AS owner_user_id
        FROM restaurants r
        LEFT JOIN users u        ON u.restaurant_id = r.id AND u.role = 'OWNER'
        LEFT JOIN owner_accounts oa ON LOWER(oa.email) = LOWER(r.admin_id)
      `;
      let params: any[] = [];
      if (req.user?.role === 'SALES_REP') {
        query += " WHERE r.sales_rep_id = ?";
        params.push(req.user.id);
      }
      query += " ORDER BY r.registered_at DESC";
      const restaurants = await centralDb.query(query, params);
      res.json(restaurants);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch restaurants" });
    }
  });

  // ── Locations ──────────────────────────────────────────────────────────────

  // Public: get all active locations as { [state]: city[] } for registration form
  app.get("/api/locations", async (_req: Request, res: Response) => {
    try {
      const rows = await centralDb.query(
        "SELECT state, city FROM locations WHERE is_active = 1 ORDER BY state, city"
      );
      const result: Record<string, string[]> = {};
      for (const row of rows) {
        if (!result[row.state]) result[row.state] = [];
        result[row.state].push(row.city);
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch locations" });
    }
  });

  // Admin: get full locations list (with zip, status, id)
  app.get("/api/admin/locations", authenticate, async (req: AuthRequest, res: Response) => {
    if (!['SUPER_ADMIN', 'CTO'].includes(req.user?.role ?? '')) {
      return res.status(403).json({ error: "Forbidden" });
    }
    try {
      const rows = await centralDb.query(
        "SELECT * FROM locations ORDER BY state, city"
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch locations" });
    }
  });

  // Admin: add a new location
  app.post("/api/admin/locations", authenticate, async (req: AuthRequest, res: Response) => {
    if (!['SUPER_ADMIN', 'CTO'].includes(req.user?.role ?? '')) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { state, city, zip_code } = req.body;
    if (!state?.trim() || !city?.trim()) {
      return res.status(400).json({ error: "State and city are required" });
    }
    try {
      const id = randomUUID();
      await centralDb.run(
        "INSERT INTO locations (id, state, city, zip_code) VALUES (?, ?, ?, ?)",
        [id, state.trim(), city.trim(), zip_code?.trim() || null]
      );
      res.json({ success: true, id });
    } catch (err: any) {
      if (err?.message?.includes('unique') || err?.message?.includes('duplicate')) {
        return res.status(409).json({ error: "This city already exists in that state" });
      }
      res.status(500).json({ error: "Failed to add location" });
    }
  });

  // Admin: update zip_code or is_active for a location
  app.patch("/api/admin/locations/:id", authenticate, async (req: AuthRequest, res: Response) => {
    if (!['SUPER_ADMIN', 'CTO'].includes(req.user?.role ?? '')) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { zip_code, is_active } = req.body;
    try {
      const updates: string[] = [];
      const params: any[] = [];
      if (zip_code !== undefined) { updates.push("zip_code = ?"); params.push(zip_code?.trim() || null); }
      if (is_active !== undefined) { updates.push("is_active = ?"); params.push(is_active); }
      if (updates.length === 0) return res.status(400).json({ error: "Nothing to update" });
      params.push(req.params.id);
      await centralDb.run(`UPDATE locations SET ${updates.join(', ')} WHERE id = ?`, params);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to update location" });
    }
  });

  // Admin: delete a location
  app.delete("/api/admin/locations/:id", authenticate, async (req: AuthRequest, res: Response) => {
    if (!['SUPER_ADMIN', 'CTO'].includes(req.user?.role ?? '')) {
      return res.status(403).json({ error: "Forbidden" });
    }
    try {
      await centralDb.run("DELETE FROM locations WHERE id = ?", [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete location" });
    }
  });

  // Admin: Assign Sales Rep
  app.patch("/api/admin/restaurants/:id/sales-rep", authenticate, isAdmin, async (req: AuthRequest, res: Response) => {
    const { salesRepId, sales_rep_id } = req.body;
    const repId = salesRepId || sales_rep_id;
    try {
      await centralDb.run("UPDATE restaurants SET sales_rep_id = ? WHERE id = ?", [repId, req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to assign sales rep" });
    }
  });

  // Admin: Toggle Restaurant Status
  app.post("/api/admin/restaurants/:id/toggle-status", authenticate, async (req: AuthRequest, res: Response) => {
    const { is_active } = req.body;
    try {
      // Sales rep can only activate their own restaurants
      if (req.user?.role === 'SALES_REP') {
        const restaurant = await centralDb.get("SELECT * FROM restaurants WHERE id = ? AND sales_rep_id = ?", [req.params.id, req.user.id]);
        if (!restaurant) return res.status(403).json({ error: "Access denied" });
      } else if (req.user?.role !== 'SUPER_ADMIN' && req.user?.role !== 'CTO') {
        return res.status(403).json({ error: "Access denied" });
      }

      // Check previous status before updating (to detect pending→active transition)
      const prev = await centralDb.get("SELECT is_active, name, admin_id FROM restaurants WHERE id = ?", [req.params.id]);
      await centralDb.run("UPDATE restaurants SET is_active = ? WHERE id = ?", [is_active, req.params.id]);

      // If activating a previously pending (is_active=0) restaurant, send approval email
      if (is_active === 1 && prev && prev.is_active === 0) {
        try {
          const { sendEmail } = await import('./notificationService.js');
          const { buildNotificationContent } = await import('./notificationService.js');
          // Look up owner email from owner_accounts (new flow) or users (legacy)
          const ownerAccount = await centralDb.get(
            "SELECT email FROM owner_accounts WHERE LOWER(email) = ?",
            [prev.admin_id?.toLowerCase()]
          );
          const ownerEmail = ownerAccount?.email || prev.admin_id;
          const ownerInfo = ownerAccount
            ? await centralDb.get("SELECT owner_name FROM owner_accounts WHERE LOWER(email) = ?", [prev.admin_id?.toLowerCase()])
            : await centralDb.get("SELECT name AS owner_name FROM users WHERE LOWER(email) = ? OR restaurant_id = ?", [prev.admin_id?.toLowerCase(), req.params.id]);

          if (ownerEmail) {
            const emailContent = buildNotificationContent('ACCOUNT_APPROVED', {
              restaurantName: prev.name,
              ownerName: ownerInfo?.owner_name || '',
              restaurantId: req.params.id,
              email: ownerEmail,
            });
            await sendEmail(ownerEmail, emailContent.subject, emailContent.text, emailContent.html);
            console.log(`[Approval] Account activated & email sent to ${ownerEmail} for restaurant ${req.params.id}`);
          }
        } catch (emailErr) {
          console.warn('[Approval] Could not send approval email:', emailErr);
        }
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to update restaurant status" });
    }
  });

  // Admin: Toggle per-tenant Invoice Deletion feature flag
  // Only SUPER_ADMIN/CTO can flip. Records a row in invoice_delete_flag_audit
  // for accountability — easy to see who enabled what and when.
  app.patch("/api/admin/restaurants/:id/invoice-delete-flag", authenticate, isAdmin, async (req: AuthRequest, res: Response) => {
    try {
      const { enabled } = req.body;
      const flag = enabled === 1 || enabled === true ? 1 : 0;

      const restaurant = await centralDb.get(
        "SELECT id FROM restaurants WHERE id = ?",
        [req.params.id]
      );
      if (!restaurant) {
        return res.status(404).json({ error: "Restaurant not found" });
      }

      await centralDb.run(
        "UPDATE restaurants SET invoice_delete_enabled = ? WHERE id = ?",
        [flag, req.params.id]
      );

      const auditId = `IDFA-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      await centralDb.run(
        `INSERT INTO invoice_delete_flag_audit (id, restaurant_id, enabled, changed_by)
         VALUES (?, ?, ?, ?)`,
        [auditId, req.params.id, flag, req.user?.id || 'unknown']
      );

      console.log(`[invoice-delete-flag] ${flag ? 'ENABLED' : 'DISABLED'} for ${req.params.id} by ${req.user?.id} (${req.user?.role})`);
      res.json({ success: true, enabled: flag });
    } catch (err) {
      console.error("[invoice-delete-flag] Error:", err);
      res.status(500).json({ error: "Failed to update invoice deletion flag" });
    }
  });

  // Admin: Reset Internal User Password
  app.post("/api/admin/reset-internal-user-password", authenticate, isAdmin, async (req: AuthRequest, res: Response) => {
    const { userId, newPassword } = req.body;
    try {
      const hashedPassword = await bcrypt.hash(newPassword, 12);
      await centralDb.run("UPDATE users SET password = ? WHERE id = ?", [hashedPassword, userId]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to reset password" });
    }
  });

  // Admin: Update Owner Info (name + email + phone)
  app.patch("/api/admin/owner/:restaurantId", authenticate, isAdmin, async (req: AuthRequest, res: Response) => {
    const { name, email, phone } = req.body;
    if (!name?.trim() || !email?.trim()) {
      return res.status(400).json({ error: "Owner name and email are required." });
    }
    try {
      // Check if an owner user already exists in the users table
      const existingUser = await centralDb.get(
        "SELECT id, login_id FROM users WHERE restaurant_id = ? AND role = 'OWNER'",
        [req.params.restaurantId]
      );

      if (existingUser) {
        // UPDATE the existing owner record
        await centralDb.run(
          "UPDATE users SET name = ?, email = ?, phone = ? WHERE id = ?",
          [name.trim(), email.trim(), phone?.trim() || null, existingUser.id]
        );
        return res.json({ success: true, isNew: false });
      }

      // No owner record found — CREATE one so the restaurant has a proper login
      const seq = await getNextSequence('restaurant');
      const userId = "user-" + randomUUID();
      const loginId = `OWNER-${1000 + seq}`;
      const tempPassword = 'Welcome@123';
      const hashedPassword = await bcrypt.hash(tempPassword, 12);

      await centralDb.run(
        "INSERT INTO users (id, login_id, name, email, phone, password, restaurant_id, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [userId, loginId, name.trim(), email.trim(), phone?.trim() || null, hashedPassword, req.params.restaurantId, 'OWNER']
      );

      return res.json({
        success: true,
        isNew: true,
        loginId,
        tempPassword,
        message: `Owner account created. Login ID: ${loginId} | Temp Password: ${tempPassword}`
      });

    } catch (err: any) {
      if (err.code === '23505' && err.constraint?.includes('email')) {
        return res.status(400).json({ error: "This email is already in use by another account." });
      }
      if (err.code === '23505' && err.constraint?.includes('login_id')) {
        return res.status(400).json({ error: "Could not generate a unique login ID. Please try again." });
      }
      console.error("Update owner info error:", err);
      res.status(500).json({ error: "Failed to update owner info." });
    }
  });

  // Admin: check Cloudflare auto-provisioning status
  app.get("/api/admin/cloudflare-status", authenticate, isAdmin, async (_req: AuthRequest, res: Response) => {
    res.json({
      configured: cloudflareIsConfigured(),
      apex_domain: process.env.CF_APEX_DOMAIN || null,
      tunnel_id:   process.env.CF_TUNNEL_ID   || null,
      service_url: process.env.CF_SERVICE_URL || null,
    });
  });

  // Admin: provision (or re-provision) DNS + tunnel hostname for one tenant
  // Useful to retroactively fix a tenant that registered before CF was configured,
  // or to repair a broken record.
  app.post("/api/admin/restaurants/:id/provision-dns", authenticate, isAdmin, async (req: AuthRequest, res: Response) => {
    try {
      const r: any = await centralDb.get("SELECT id, name, slug FROM restaurants WHERE id = ?", [req.params.id]);
      if (!r) return res.status(404).json({ error: "Restaurant not found" });
      if (!r.slug) return res.status(400).json({ error: "Restaurant has no slug set" });
      const result = await provisionTenantSubdomain(r.slug);
      res.json({ slug: r.slug, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "provision failed" });
    }
  });

  // Admin: bulk provision — loops every active restaurant and ensures CF records exist.
  // Idempotent: re-running is safe.
  app.post("/api/admin/tenants/bulk-provision-dns", authenticate, isAdmin, async (_req: AuthRequest, res: Response) => {
    if (!cloudflareIsConfigured()) {
      return res.status(400).json({ error: "Cloudflare not configured — set CF_API_TOKEN, CF_ZONE_ID, CF_ACCOUNT_ID, CF_TUNNEL_ID, CF_APEX_DOMAIN in .env" });
    }
    try {
      const rows: any[] = await centralDb.query(
        "SELECT id, name, slug FROM restaurants WHERE is_active = 1 AND slug IS NOT NULL AND slug <> '' AND id <> 'SYSTEM'"
      );
      const results: any[] = [];
      for (const r of rows) {
        const out = await provisionTenantSubdomain(r.slug);
        results.push({ slug: r.slug, name: r.name, ...out });
      }
      const summary = {
        total: results.length,
        created: results.filter(r => !r.error && !r.already_exists).length,
        already_existed: results.filter(r => r.already_exists).length,
        failed: results.filter(r => r.error).length,
      };
      res.json({ summary, results });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "bulk provision failed" });
    }
  });

  // Admin: Resend Welcome Email to Owner
  app.post("/api/admin/restaurants/:id/resend-welcome-email", authenticate, isAdmin, async (req: AuthRequest, res: Response) => {
    // Guard: SMTP must be configured
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return res.status(400).json({
        error: "Email is not configured on this server. Please set SMTP_HOST, SMTP_USER, and SMTP_PASS in the .env file and restart the application."
      });
    }
    try {
      const restaurant = await centralDb.get("SELECT name FROM restaurants WHERE id = ?", [req.params.id]);
      const owner = await centralDb.get(
        "SELECT name, email, login_id FROM users WHERE restaurant_id = ? AND role = 'OWNER'",
        [req.params.id]
      );
      if (!owner) {
        return res.status(404).json({
          error: "No owner account found for this restaurant. Please use 'Edit Owner Info' to create one first."
        });
      }
      if (!owner.email) {
        return res.status(400).json({
          error: "Owner has no email address on record. Please use 'Edit Owner Info' to add one first."
        });
      }
      const { subject, text: textBody, html } = buildNotificationContent('BUSINESS_REGISTRATION', {
        restaurantName: restaurant?.name || 'Your Restaurant',
        restaurantId: req.params.id,
        loginId: owner.login_id,
        password: '[Contact your administrator — password is unchanged]',
      });
      await sendEmail(owner.email, subject, textBody, html);
      res.json({ success: true, message: `Welcome email resent to ${owner.email}` });
    } catch (err: any) {
      console.error('[Resend email] Failed:', err);
      res.status(500).json({ error: `Failed to send email: ${err.message || 'SMTP error. Check server logs.'}` });
    }
  });

  // Owner: Get own profile (name, email, phone)
  // Supports both new email-based accounts (owner_accounts) and legacy id-based accounts (users)
  app.get("/api/owner/profile", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      // New owner accounts use email in JWT; legacy accounts use id
      if (req.user!.email) {
        const profile = await centralDb.get(
          "SELECT owner_name AS name, email, phone_number AS phone FROM owner_accounts WHERE LOWER(email) = ?",
          [req.user!.email.toLowerCase()]
        );
        if (!profile) return res.status(404).json({ error: "Profile not found" });
        return res.json(profile);
      }
      // Legacy path
      const profile = await centralDb.get(
        "SELECT id, name, email, phone, login_id FROM users WHERE id = ?",
        [req.user!.id]
      );
      if (!profile) return res.status(404).json({ error: "Profile not found" });
      res.json(profile);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch profile" });
    }
  });

  // Owner: Update own profile (name, email, phone)
  app.patch("/api/owner/profile", authenticate, async (req: AuthRequest, res: Response) => {
    const { name, email, phone } = req.body;
    if (!name?.trim() || !email?.trim()) {
      return res.status(400).json({ error: "Name and email are required" });
    }
    try {
      if (req.user!.email) {
        // New email-based owner account
        await centralDb.run(
          "UPDATE owner_accounts SET owner_name = ?, phone_number = ? WHERE LOWER(email) = ?",
          [name.trim(), phone?.trim() || null, req.user!.email.toLowerCase()]
        );
      } else {
        // Legacy id-based owner account
        await centralDb.run(
          "UPDATE users SET name = ?, email = ?, phone = ? WHERE id = ?",
          [name.trim(), email.trim().toLowerCase(), phone?.trim() || null, req.user!.id]
        );
      }
      res.json({ success: true });
    } catch (err: any) {
      if (err.code === '23505' && err.constraint?.includes('email')) {
        return res.status(400).json({ error: "This email is already in use by another account." });
      }
      res.status(500).json({ error: "Failed to update profile" });
    }
  });

  // Admin: Reset Owner Password
  // Updates both legacy users table AND new owner_accounts table
  app.post("/api/admin/reset-owner-password", authenticate, isAdmin, async (req: AuthRequest, res: Response) => {
    const { restaurantId, newPassword } = req.body;
    try {
      const hashedPassword = await bcrypt.hash(newPassword, 12);

      // Legacy path: update users table (older admin-created accounts)
      await centralDb.run(
        "UPDATE users SET password = ? WHERE restaurant_id = ? AND role = 'OWNER'",
        [hashedPassword, restaurantId]
      );

      // New path: update owner_accounts table (self-registered owners).
      // Resolve owner email via owner_restaurants (authoritative FK), with a
      // fallback to restaurants.admin_id for very old rows where admin_id did
      // hold the email directly. Using admin_id alone breaks when it's a user
      // UUID instead of an email (legacy data), which silently leaves the
      // owner_accounts password out of sync with users.password.
      const ownerMap = await centralDb.get(
        "SELECT owner_email FROM owner_restaurants WHERE restaurant_id = ? LIMIT 1",
        [restaurantId]
      );
      let ownerEmail: string | null = ownerMap?.owner_email ?? null;
      if (!ownerEmail) {
        const restaurant = await centralDb.get(
          "SELECT admin_id FROM restaurants WHERE id = ?",
          [restaurantId]
        );
        if (restaurant?.admin_id && String(restaurant.admin_id).includes('@')) {
          ownerEmail = restaurant.admin_id;
        }
      }
      if (ownerEmail) {
        await centralDb.run(
          "UPDATE owner_accounts SET password_hash = ? WHERE LOWER(email) = LOWER(?)",
          [hashedPassword, ownerEmail]
        );
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to reset owner password" });
    }
  });

  // Admin: Get Role Permissions for a Restaurant
  app.get("/api/admin/restaurant/:id/role-permissions", authenticate, isAdmin, async (req: AuthRequest, res: Response) => {
    try {
      const rows = await centralDb.query(
        "SELECT role, allowed_tabs FROM restaurant_role_permissions WHERE restaurant_id = ?",
        [req.params.id]
      );
      const result: Record<string, string[]> = {};
      for (const row of rows) {
        try { result[row.role] = JSON.parse(row.allowed_tabs || '[]'); }
        catch { result[row.role] = []; }
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch permissions" });
    }
  });

  // Admin: Save Role Permissions for a Restaurant
  app.post("/api/admin/restaurant/:id/role-permissions", authenticate, isAdmin, async (req: AuthRequest, res: Response) => {
    try {
      const permissions: Record<string, string[]> = req.body;
      for (const [role, tabs] of Object.entries(permissions)) {
        await centralDb.run(
          `INSERT INTO restaurant_role_permissions (restaurant_id, role, allowed_tabs, updated_at)
           VALUES (?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT (restaurant_id, role) DO UPDATE SET allowed_tabs = EXCLUDED.allowed_tabs, updated_at = CURRENT_TIMESTAMP`,
          [req.params.id, role, JSON.stringify(tabs)]
        );
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to save permissions" });
    }
  });

  // Owner/Manager: Get my tab permissions (null allowed_tabs = no restriction = all tabs)
  app.get("/api/restaurant/:id/my-permissions", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const userRole = req.user?.role;
      const row = await centralDb.get(
        "SELECT allowed_tabs FROM restaurant_role_permissions WHERE restaurant_id = ? AND role = ?",
        [req.params.id, userRole]
      );
      if (!row) return res.json({ allowed_tabs: null });
      try {
        const parsed = JSON.parse(row.allowed_tabs || '[]');
        res.json({ allowed_tabs: parsed.length > 0 ? parsed : null });
      } catch {
        res.json({ allowed_tabs: null });
      }
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch permissions" });
    }
  });

  // Public: Get Sales Reps
  app.get("/api/public/sales-reps", async (req: Request, res: Response) => {
    try {
      const reps = await centralDb.query("SELECT id, name FROM users WHERE role = 'SALES_REP' AND is_active = 1");
      res.json(reps);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch sales reps" });
    }
  });

  // Public: Get Restaurants
  app.get("/api/public/restaurants", async (req: Request, res: Response) => {
    try {
      const restaurants = await centralDb.query("SELECT id, name FROM restaurants WHERE is_active = 1");
      res.json(restaurants);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch public restaurants" });
    }
  });

  // Auth: Get Me
  // For OWNER/SUPER_ADMIN/etc → centralDb.users; for CHEF/WAITER → tenant attendance_staff
  app.get("/api/me", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      // Try centralDb first (OWNER, SUPER_ADMIN, CTO, SALES_REP)
      const centralUser = await centralDb.get(
        "SELECT id, login_id, name, email, phone, role, restaurant_id FROM users WHERE id = ?",
        [req.user?.id]
      );
      if (centralUser) return res.json(centralUser);

      // Fall back to tenant attendance_staff (CHEF, WAITER)
      if (req.user?.restaurantId && req.user.restaurantId !== 'SYSTEM') {
        const tenantDb = await getTenantDb(req.user.restaurantId);
        const staffUser = await tenantDb.get(
          "SELECT id, login_id, name, phone, email, role, default_hours FROM attendance_staff WHERE id = ?",
          [req.user.id]
        );
        if (staffUser) return res.json({ ...staffUser, restaurant_id: req.user.restaurantId });
      }

      return res.status(404).json({ error: "User not found" });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch user info" });
    }
  });

  // Owner: Notification Settings
  app.get("/api/owner/notification-settings", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const settings = await db.query("SELECT * FROM notification_settings");
      res.json(settings);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch notification settings" });
    }
  });

  app.post("/api/owner/notification-settings", authenticate, async (req: AuthRequest, res: Response) => {
    const { settings } = req.body;
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      for (const s of settings) {
        await db.run(`
          INSERT INTO notification_settings (event_name, role, email_enabled, sms_enabled, whatsapp_enabled, telegram_enabled, telegram_chat_id, recipients, schedule_time)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(event_name, role) DO UPDATE SET
            email_enabled    = excluded.email_enabled,
            sms_enabled      = excluded.sms_enabled,
            whatsapp_enabled = excluded.whatsapp_enabled,
            telegram_enabled = excluded.telegram_enabled,
            telegram_chat_id = excluded.telegram_chat_id,
            recipients       = excluded.recipients,
            schedule_time    = excluded.schedule_time
        `, [s.event_name, s.role, s.email_enabled ? 1 : 0, s.sms_enabled ? 1 : 0, s.whatsapp_enabled ? 1 : 0, s.telegram_enabled ? 1 : 0, s.telegram_chat_id || '', s.recipients || '', s.schedule_time || '']);
      }
      res.json({ success: true });
    } catch (err) {
      console.error("Update notification settings error:", err);
      res.status(500).json({ error: "Failed to update notification settings" });
    }
  });

  app.post("/api/owner/test-notification", authenticate, async (req: AuthRequest, res: Response) => {
    const { eventName, data } = req.body;
    try {
      await triggerNotification(req.user!.restaurantId, eventName, data || { test: "This is a test notification" });
      res.json({ success: true, message: "Notification triggered" });
    } catch (err) {
      res.status(500).json({ error: "Failed to trigger test notification" });
    }
  });

  // POST /api/owner/test-telegram — send a test message to a specific Telegram chat ID
  app.post("/api/owner/test-telegram", authenticate, async (req: AuthRequest, res: Response) => {
    const { chat_id } = req.body;
    try {
      await sendTelegram(chat_id || null, `✅ *Atithi Setu — Telegram Connected!*\n\nYour restaurant notifications are now active on Telegram.\n\n_Powered by Manhotra Consulting_`);
      res.json({ success: true, message: "Test message sent to Telegram" });
    } catch (err) {
      res.status(500).json({ error: "Failed to send Telegram test message" });
    }
  });

  // ── Meta Cloud API: WhatsApp webhook verification (GET) ────────────────────
  // Meta sends a GET request with hub.challenge when you register the webhook URL.
  // Set Callback URL in Meta Business Manager to: https://your-domain/api/webhooks/whatsapp
  app.get("/api/webhooks/whatsapp", (req: Request, res: Response) => {
    const mode      = req.query["hub.mode"];
    const token     = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.META_WA_VERIFY_TOKEN) {
      console.log("[Meta Webhook] Verification successful.");
      res.status(200).send(challenge);
    } else {
      console.warn("[Meta Webhook] Verification failed — token mismatch.");
      res.status(403).send("Forbidden");
    }
  });

  // ── Meta Cloud API: WhatsApp webhook events (POST) ─────────────────────────
  // Receives delivery receipts, read receipts, and incoming customer messages.
  app.post("/api/webhooks/whatsapp", (req: Request, res: Response) => {
    // Acknowledge immediately (Meta requires 200 within 20 s)
    res.status(200).json({ status: "ok" });

    try {
      const body = req.body as any;
      const entry = body?.entry?.[0]?.changes?.[0]?.value;
      if (!entry) return;

      // Incoming message from a customer
      const messages = entry.messages;
      if (messages?.length) {
        const msg = messages[0];
        console.log(`[Meta Webhook] Incoming WhatsApp from ${msg.from}: ${msg.text?.body || '(non-text)'}`);
      }

      // Delivery / read status update
      const statuses = entry.statuses;
      if (statuses?.length) {
        const st = statuses[0];
        console.log(`[Meta Webhook] Message ${st.id} status: ${st.status} → ${st.recipient_id}`);
      }
    } catch (err) {
      console.error("[Meta Webhook] Processing error:", err);
    }
  });

  // Login Logic
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const { loginId, password, restaurantId } = req.body;
    try {
      // 1. Check centralDb first (OWNER / SUPER_ADMIN / CTO / SALES_REP)
      const centralUser = await centralDb.get("SELECT * FROM users WHERE login_id = ?", [loginId]);
      if (centralUser) {
        if (centralUser.is_active === 0) return res.status(403).json({ error: "Account is deactivated" });
        const isMatch = await bcrypt.compare(password, centralUser.password);
        if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });

        const token = jwt.sign(
          { id: centralUser.id, restaurantId: centralUser.restaurant_id, role: centralUser.role },
          JWT_SECRET,
          { expiresIn: "24h" }
        );
        return res.json({ token, restaurantId: centralUser.restaurant_id, role: centralUser.role, name: centralUser.name });
      }

      // 2. If not found in centralDb, check tenant attendance_staff (CHEF / WAITER)
      if (restaurantId && restaurantId !== 'SYSTEM') {
        const tenantDb = await getTenantDb(restaurantId);
        const staffUser = await tenantDb.get(
          "SELECT * FROM attendance_staff WHERE login_id = ?",
          [loginId]
        );
        if (staffUser) {
          if (staffUser.is_active === 0) return res.status(403).json({ error: "Account is deactivated" });
          if (!staffUser.password) return res.status(401).json({ error: "No password set for this account. Ask your manager to set one." });

          const isMatch = await bcrypt.compare(password, staffUser.password);
          if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });

          const token = jwt.sign(
            { id: staffUser.id, restaurantId, role: staffUser.role },
            JWT_SECRET,
            { expiresIn: "24h" }
          );
          return res.json({ token, restaurantId, role: staffUser.role, name: staffUser.name });
        }
      }

      // 3. Not found anywhere
      return res.status(401).json({ error: "Invalid credentials" });
    } catch (err) {
      console.error("Login error:", err);
      res.status(500).json({ error: "Login failed" });
    }
  });

  // ============================================
  // NEW PHONE-BASED LOGIN SYSTEM (Option A)
  // ============================================

  // POST /api/auth/send-otp - Request OTP via WhatsApp
  app.post("/api/auth/send-otp", async (req: Request, res: Response) => {
    const { phone } = req.body;
    try {
      if (!phone || !/^\d{10}$/.test(phone.replace(/\D/g, ''))) {
        return res.status(400).json({ error: "Invalid phone number format. Use 10-digit Indian number." });
      }

      const formattedPhone = `+91${phone.replace(/\D/g, '')}`;
      const otp = Math.floor(100000 + Math.random() * 900000).toString();

      // Store OTP in cache (5-minute TTL)
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await centralDb.run(
        `INSERT INTO otp_cache (phone_number, otp, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT (phone_number) DO UPDATE SET otp = excluded.otp, expires_at = excluded.expires_at`,
        [formattedPhone, otp, expiresAt]
      );

      // Send OTP via WhatsApp (reuse existing sendWhatsApp function)
      const message = `🔐 Your Atithi-Setu login OTP is: ${otp}\n\nValid for 5 minutes. Never share this code.`;
      await sendWhatsApp(formattedPhone, message);

      console.log(`✅ OTP sent to ${formattedPhone}`);
      res.json({ success: true, message: "OTP sent via WhatsApp", otp_expires_in: 300 });
    } catch (err: any) {
      console.error("Error in /api/auth/send-otp:", err);
      res.status(500).json({ error: "Failed to send OTP" });
    }
  });

  // POST /api/auth/verify-otp - Verify OTP and return JWT or restaurant list
  app.post("/api/auth/verify-otp", async (req: Request, res: Response) => {
    const { phone, otp } = req.body;
    try {
      const formattedPhone = `+91${phone.replace(/\D/g, '')}`;

      // Check OTP validity
      const otpRecord = await centralDb.get(
        `SELECT otp FROM otp_cache WHERE phone_number = ? AND expires_at > NOW()`,
        [formattedPhone]
      );

      if (!otpRecord || otpRecord.otp !== otp) {
        return res.status(401).json({ error: "Invalid or expired OTP" });
      }

      // Delete OTP after use
      await centralDb.run(`DELETE FROM otp_cache WHERE phone_number = ?`, [formattedPhone]);

      // Check if user exists
      const user = await centralDb.get(
        `SELECT * FROM phone_users WHERE phone_number = ?`,
        [formattedPhone]
      );

      if (!user) {
        // New user — requires setup
        const tempToken = jwt.sign(
          { phone: formattedPhone, status: 'pending_setup' },
          JWT_SECRET,
          { expiresIn: '1h' }
        );
        return res.json({
          success: true,
          requires_setup: true,
          temp_token: tempToken,
          message: 'New user detected. Please complete setup.'
        });
      }

      // Existing user — fetch their restaurants
      const restaurants = await centralDb.query(
        `SELECT ur.restaurant_id, ur.role, rm.restaurant_name, rm.location_city
         FROM user_restaurants ur
         LEFT JOIN restaurants_metadata rm ON ur.restaurant_id = rm.restaurant_id
         WHERE ur.phone_number = ?
         ORDER BY ur.is_primary DESC`,
        [formattedPhone]
      );

      if (restaurants.length === 1) {
        // Single restaurant — auto-select
        const primaryRestaurant = restaurants[0];
        const token = jwt.sign(
          {
            phone: formattedPhone,
            restaurantId: primaryRestaurant.restaurant_id,
            role: primaryRestaurant.role,
            userName: user.owner_name
          },
          JWT_SECRET,
          { expiresIn: '7d' }
        );
        return res.json({
          success: true,
          requires_setup: false,
          jwt_token: token,
          restaurant_id: primaryRestaurant.restaurant_id,
          restaurant_name: primaryRestaurant.restaurant_name,
          role: primaryRestaurant.role,
          message: 'Login successful'
        });
      } else if (restaurants.length > 1) {
        // Multiple restaurants — show selector
        const tempToken = jwt.sign(
          { phone: formattedPhone, userName: user.owner_name },
          JWT_SECRET,
          { expiresIn: '1h' }
        );
        return res.json({
          success: true,
          requires_setup: false,
          temp_token: tempToken,
          restaurants: restaurants,
          message: 'Select a restaurant to continue'
        });
      } else {
        // User exists but has no restaurants (edge case)
        return res.status(400).json({ error: "No restaurants associated with this account" });
      }
    } catch (err: any) {
      console.error("Error in /api/auth/verify-otp:", err);
      res.status(500).json({ error: "Verification failed" });
    }
  });

  // POST /api/auth/create-user - New user completes setup
  app.post("/api/auth/create-user", async (req: Request, res: Response) => {
    const { temp_token, owner_name, restaurant_name, location_city, cuisine_type, email } = req.body;
    try {
      // Verify temp token
      let decoded: any;
      try {
        decoded = jwt.verify(temp_token, JWT_SECRET) as any;
      } catch {
        return res.status(401).json({ error: "Invalid or expired setup token" });
      }

      if (decoded.status !== 'pending_setup') {
        return res.status(401).json({ error: "Invalid token for setup" });
      }

      const phone = decoded.phone;

      // Validate inputs
      if (!owner_name || !restaurant_name || !location_city) {
        return res.status(400).json({ error: "Missing required fields: owner_name, restaurant_name, location_city" });
      }

      // Generate new restaurant ID
      const restaurantId = `RESTO_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      // Create or update user
      await centralDb.run(
        `INSERT INTO phone_users (phone_number, phone_verified, owner_name, email, created_at, updated_at)
         VALUES (?, ?, ?, ?, NOW(), NOW())
         ON CONFLICT (phone_number) DO UPDATE SET owner_name = EXCLUDED.owner_name, email = EXCLUDED.email, updated_at = NOW()`,
        [phone, 1, owner_name, email || null]
      );

      // Create restaurant metadata
      await centralDb.run(
        `INSERT INTO restaurants_metadata (restaurant_id, owner_phone, restaurant_name, location_city, cuisine_type, created_at)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [restaurantId, phone, restaurant_name, location_city, cuisine_type || null]
      );

      // Create user_restaurant mapping
      await centralDb.run(
        `INSERT INTO user_restaurants (phone_number, restaurant_id, role, is_primary, added_at)
         VALUES (?, ?, ?, ?, NOW())`,
        [phone, restaurantId, 'OWNER', 1]
      );

      // Create tenant schema and tables
      const tenantDb = await getTenantDb(restaurantId);
      await tenantDb.exec(`
        CREATE TABLE IF NOT EXISTS menu (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          price DOUBLE PRECISION NOT NULL,
          price_half DOUBLE PRECISION,
          price_full DOUBLE PRECISION,
          category TEXT,
          image_url TEXT,
          drive_file_id TEXT,
          dietary_type TEXT,
          is_daily_special INT DEFAULT 0,
          is_available INT DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS tables (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          capacity INT,
          status TEXT DEFAULT 'AVAILABLE',
          qr_code_data TEXT
        );
        CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY,
          table_number TEXT,
          items TEXT,
          total_amount DOUBLE PRECISION,
          gst_amount DOUBLE PRECISION DEFAULT 0,
          status TEXT,
          payment_status TEXT DEFAULT 'PENDING',
          payment_method TEXT,
          customer_name TEXT,
          customer_phone TEXT,
          customer_email TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS table_sessions (
          session_token TEXT PRIMARY KEY,
          table_id TEXT,
          customer_name TEXT,
          customer_phone TEXT,
          status TEXT DEFAULT 'open',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS attendance_staff (
          id TEXT PRIMARY KEY,
          name TEXT,
          role TEXT,
          phone TEXT,
          email TEXT,
          login_id TEXT UNIQUE,
          password TEXT,
          is_active INT DEFAULT 1
        );
      `);

      // Return JWT
      const token = jwt.sign(
        {
          phone: phone,
          restaurantId: restaurantId,
          role: 'OWNER',
          userName: owner_name
        },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      console.log(`✅ New user created: ${phone} with restaurant ${restaurantId}`);
      res.json({
        success: true,
        jwt_token: token,
        restaurant_id: restaurantId,
        restaurant_name: restaurant_name,
        role: 'OWNER',
        message: 'Account created successfully'
      });
    } catch (err: any) {
      console.error("Error in /api/auth/create-user:", err);
      res.status(500).json({ error: "Failed to create account" });
    }
  });

  // POST /api/auth/select-restaurant - Multi-restaurant user selects restaurant
  app.post("/api/auth/select-restaurant", async (req: Request, res: Response) => {
    const { temp_token, restaurant_id } = req.body;
    try {
      // Verify temp token
      let decoded: any;
      try {
        decoded = jwt.verify(temp_token, JWT_SECRET) as any;
      } catch {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      const phone = decoded.phone;

      // Verify user has access to this restaurant
      const access = await centralDb.get(
        `SELECT role FROM user_restaurants WHERE phone_number = ? AND restaurant_id = ?`,
        [phone, restaurant_id]
      );

      if (!access) {
        return res.status(403).json({ error: "No access to this restaurant" });
      }

      // Get restaurant info
      const restaurant = await centralDb.get(
        `SELECT restaurant_name FROM restaurants_metadata WHERE restaurant_id = ?`,
        [restaurant_id]
      );

      if (!restaurant) {
        return res.status(404).json({ error: "Restaurant not found" });
      }

      // Return full JWT
      const token = jwt.sign(
        {
          phone: phone,
          restaurantId: restaurant_id,
          role: access.role,
          userName: decoded.userName
        },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.json({
        success: true,
        jwt_token: token,
        restaurant_id: restaurant_id,
        restaurant_name: restaurant.restaurant_name,
        role: access.role,
        message: 'Restaurant selected'
      });
    } catch (err: any) {
      console.error("Error in /api/auth/select-restaurant:", err);
      res.status(500).json({ error: "Failed to select restaurant" });
    }
  });

  // ============================================================
  // EMAIL-BASED OWNER AUTH ENDPOINTS
  // ============================================================

  // POST /api/auth/owner/register - New owner registers with email + password
  app.post("/api/auth/owner/register", async (req: Request, res: Response) => {
    const { email, phone, password, owner_name, restaurant_name, location_city, cuisine_type } = req.body;
    try {
      if (!email || !password || !owner_name || !restaurant_name || !location_city) {
        return res.status(400).json({ error: "Required: email, password, owner name, restaurant name, city" });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: "Invalid email format" });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters" });
      }

      const existing = await centralDb.get(
        `SELECT id FROM owner_accounts WHERE email = ?`, [email.toLowerCase()]
      );
      if (existing) {
        return res.status(409).json({ error: "An account with this email already exists. Please log in." });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const restaurantId = `RESTO_${Date.now()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

      await centralDb.run(
        `INSERT INTO owner_accounts (email, phone_number, password_hash, owner_name)
         VALUES (?, ?, ?, ?)`,
        [email.toLowerCase(), phone?.trim() || null, passwordHash, owner_name.trim()]
      );

      await centralDb.run(
        `INSERT INTO owner_restaurants (owner_email, restaurant_id, restaurant_name, location_city, cuisine_type, role, is_primary)
         VALUES (?, ?, ?, ?, ?, 'OWNER', 1)`,
        [email.toLowerCase(), restaurantId, restaurant_name.trim(), location_city.trim(), cuisine_type?.trim() || null]
      );

      // Generate a unique URL slug for this restaurant (per-tenant subdomain)
      const newSlug = await generateUniqueSlug(restaurant_name.trim());

      // Insert into legacy restaurants table — is_active=0 (pending admin approval)
      await centralDb.run(
        `INSERT INTO restaurants (id, name, admin_id, state, city, is_active, registered_at, slug)
         VALUES (?, ?, ?, ?, ?, 0, NOW(), ?)
         ON CONFLICT (id) DO NOTHING`,
        [restaurantId, restaurant_name.trim(), email.toLowerCase(), 'N/A', location_city.trim(), newSlug]
      );

      // Phase 7: Auto-provision Cloudflare DNS + Tunnel Public Hostname
      // Completely best-effort — if CF env vars aren't set or the API fails,
      // registration still succeeds; operator can backfill via /internal admin.
      try {
        const cf = await provisionTenantSubdomain(newSlug);
        if (cf.skipped) {
          console.log(`[register] Cloudflare auto-provision skipped for ${newSlug} (CF not configured)`);
        } else if (cf.error) {
          console.error(`[register] CF provision failed for ${newSlug}:`, cf.error);
        } else {
          console.log(`[register] Cloudflare provisioned ${cf.hostname} (dns=${cf.dns_record_id}, tunnel=${cf.tunnel_config_updated})`);
        }
      } catch (cfErr) {
        console.error(`[register] CF provision threw for ${newSlug}:`, cfErr);
      }

      // Create tenant schema
      const tenantDb = await getTenantDb(restaurantId);
      await tenantDb.exec(`
        CREATE TABLE IF NOT EXISTS menu (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
          price DOUBLE PRECISION NOT NULL, price_half DOUBLE PRECISION, price_full DOUBLE PRECISION,
          category TEXT, image_url TEXT, drive_file_id TEXT, dietary_type TEXT,
          is_daily_special INT DEFAULT 0, is_available INT DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS tables (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, capacity INT,
          status TEXT DEFAULT 'AVAILABLE', qr_code_data TEXT
        );
        CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY, table_number TEXT, items TEXT,
          total_amount DOUBLE PRECISION, gst_amount DOUBLE PRECISION DEFAULT 0,
          status TEXT, payment_status TEXT DEFAULT 'PENDING', payment_method TEXT,
          customer_name TEXT, customer_phone TEXT, customer_email TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS table_sessions (
          session_token TEXT PRIMARY KEY, table_id TEXT, customer_name TEXT,
          customer_phone TEXT, status TEXT DEFAULT 'open',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS attendance_staff (
          id TEXT PRIMARY KEY, name TEXT, role TEXT, phone TEXT, email TEXT,
          login_id TEXT UNIQUE, password TEXT, is_active INT DEFAULT 1
        );
      `);

      // Send registration confirmation email to owner (async — don't block response)
      try {
        const { sendEmail } = await import('./notificationService.js');
        const { buildNotificationContent } = await import('./notificationService.js');
        const emailContent = buildNotificationContent('REGISTRATION_RECEIVED', {
          restaurantName: restaurant_name.trim(),
          ownerName: owner_name.trim(),
          email: email.toLowerCase(),
          restaurantId,
        });
        await sendEmail(email.toLowerCase(), emailContent.subject, emailContent.text, emailContent.html);
        console.log(`[Registration] Confirmation email sent to ${email}`);
      } catch (emailErr) {
        console.warn('[Registration] Could not send confirmation email:', emailErr);
      }

      console.log(`✅ Owner registered (PENDING): ${email} → ${restaurantId}`);
      res.json({
        success: true,
        pending: true,
        restaurant_id: restaurantId,
        restaurant_name: restaurant_name.trim(),
        email: email.toLowerCase(),
        message: 'Registration submitted! Your account is pending admin approval. You will be notified by email once activated.'
      });
    } catch (err: any) {
      console.error("Error in /api/auth/owner/register:", err);
      res.status(500).json({ error: "Registration failed. Please try again." });
    }
  });

  // POST /api/auth/owner/login - Owner logs in with email OR phone + password
  app.post("/api/auth/owner/login", async (req: Request, res: Response) => {
    const { identifier, password } = req.body;
    try {
      if (!identifier || !password) {
        return res.status(400).json({ error: "Email/phone and password are required" });
      }

      const cleanIdentifier = identifier.trim().toLowerCase();
      const account = await centralDb.get(
        `SELECT * FROM owner_accounts WHERE LOWER(email) = ? OR phone_number = ?`,
        [cleanIdentifier, identifier.trim()]
      );

      if (!account) {
        // Fallback: check legacy users table (older OWNER accounts created by Super Admin)
        const legacyUser = await centralDb.get(
          `SELECT * FROM users WHERE (LOWER(email) = ? OR login_id = ?) AND role = 'OWNER' AND is_active = 1`,
          [cleanIdentifier, identifier.trim()]
        );
        if (!legacyUser) {
          return res.status(401).json({ error: "No account found. Check your email/phone or register." });
        }
        const legacyMatch = await bcrypt.compare(password, legacyUser.password);
        if (!legacyMatch) {
          return res.status(401).json({ error: "Incorrect password" });
        }
        const restaurant = await centralDb.get(
          `SELECT id, name, city, slug FROM restaurants WHERE id = ?`,
          [legacyUser.restaurant_id]
        );
        const jwtToken = jwt.sign(
          { id: legacyUser.id, restaurantId: legacyUser.restaurant_id, role: legacyUser.role, userName: legacyUser.name },
          JWT_SECRET,
          { expiresIn: '7d' }
        );
        return res.json({
          success: true,
          jwt_token: jwtToken,
          restaurant_id: legacyUser.restaurant_id,
          restaurant_name: restaurant?.name || legacyUser.restaurant_id,
          slug: restaurant?.slug || null,
          role: legacyUser.role,
          message: 'Login successful'
        });
      }

      const isMatch = await bcrypt.compare(password, account.password_hash);
      if (!isMatch) {
        return res.status(401).json({ error: "Incorrect password" });
      }

      const restaurants = await centralDb.query(
        `SELECT or2.restaurant_id, or2.restaurant_name, or2.location_city, or2.cuisine_type, or2.role, or2.is_primary,
                COALESCE(r.is_active, 0) AS is_active,
                r.slug AS slug
         FROM owner_restaurants or2
         LEFT JOIN restaurants r ON r.id = or2.restaurant_id
         WHERE or2.owner_email = ?
         ORDER BY or2.is_primary DESC, or2.added_at ASC`,
        [account.email]
      );

      if (restaurants.length === 0) {
        return res.status(400).json({ error: "No restaurants linked to this account" });
      }

      if (restaurants.length === 1) {
        const r = restaurants[0];
        // Block access if restaurant is pending admin approval
        if (r.is_active === 0) {
          return res.status(403).json({
            error: "Your account is pending admin approval. You will receive an email once your account is activated.",
            pending: true
          });
        }
        const jwtToken = jwt.sign(
          { email: account.email, restaurantId: r.restaurant_id, role: r.role, userName: account.owner_name },
          JWT_SECRET,
          { expiresIn: '7d' }
        );
        return res.json({
          success: true,
          jwt_token: jwtToken,
          restaurant_id: r.restaurant_id,
          restaurant_name: r.restaurant_name,
          slug: r.slug || null,
          role: r.role,
          message: 'Login successful'
        });
      } else {
        const tempToken = jwt.sign(
          { email: account.email, userName: account.owner_name },
          JWT_SECRET,
          { expiresIn: '1h' }
        );
        return res.json({
          success: true,
          temp_token: tempToken,
          restaurants,
          message: 'Select a restaurant to continue'
        });
      }
    } catch (err: any) {
      console.error("Error in /api/auth/owner/login:", err);
      res.status(500).json({ error: "Login failed. Please try again." });
    }
  });

  // ─── PER-TENANT SUBDOMAIN: PUBLIC TENANT INFO ─────────────────────────────
  // GET /api/tenant/by-slug/:slug — returns branding info for the login page.
  // Called on page load when the subdomain is detected so we can show the
  // restaurant name before the user has authenticated.
  app.get("/api/tenant/by-slug/:slug", async (req: Request, res: Response) => {
    try {
      const slug = (req.params.slug || '').toLowerCase().trim();
      if (!slug || RESERVED_SLUGS.has(slug)) {
        return res.status(404).json({ error: "Restaurant not found" });
      }
      const r: any = await centralDb.get(
        `SELECT id, name, city, state, is_active, template_id, watermark_image, upi_id, slug,
                COALESCE(invoice_delete_enabled, 0) AS invoice_delete_enabled
         FROM restaurants WHERE slug = ?`,
        [slug]
      );
      if (!r) return res.status(404).json({ error: "Restaurant not found" });
      if (!r.is_active) {
        return res.status(403).json({ error: "This restaurant is pending activation", pending: true });
      }
      res.json({
        slug: r.slug,
        id: r.id,
        name: r.name,
        city: r.city,
        state: r.state,
        templateId: r.template_id || null,
        logo: r.watermark_image || null,
        invoice_delete_enabled: Number(r.invoice_delete_enabled || 0)
      });
    } catch (err: any) {
      console.error("/api/tenant/by-slug error:", err);
      res.status(500).json({ error: "Failed to load tenant info" });
    }
  });

  // ─── PER-TENANT SUBDOMAIN: UNIFIED LOGIN ───────────────────────────────────
  // POST /api/auth/tenant-login — single endpoint for ALL roles (Owner,
  // Manager, Chef, Waiter) at a given tenant. The client reads the slug from
  // the subdomain (manhotra-kitchen.atithi-setu.com → slug=manhotra-kitchen).
  // Tries identity sources in order:
  //   1. owner_accounts (email or phone) + ownership check via owner_restaurants
  //   2. centralDb.users (legacy login_id scoped to this restaurant)
  //   3. tenant.attendance_staff (CHEF / WAITER / MANAGER)
  app.post("/api/auth/tenant-login", async (req: Request, res: Response) => {
    try {
      const { slug, identifier, password } = req.body || {};
      if (!slug || !identifier || !password) {
        return res.status(400).json({ error: "slug, identifier, and password are required" });
      }
      const cleanSlug = String(slug).toLowerCase().trim();
      const cleanIdentifier = String(identifier).trim();

      const rest: any = await centralDb.get(
        `SELECT id, name, city, is_active, slug FROM restaurants WHERE slug = ?`,
        [cleanSlug]
      );
      if (!rest) return res.status(404).json({ error: "Restaurant not found" });
      if (!rest.is_active) {
        return res.status(403).json({ error: "Restaurant is pending activation", pending: true });
      }

      const restaurantId: string = rest.id;
      const isEmail = /@/.test(cleanIdentifier);
      const isPhone = /^[+]?[0-9\s-]{8,15}$/.test(cleanIdentifier);

      // ── Source 1: owner_accounts (email or phone) ──
      if (isEmail || isPhone) {
        const owner: any = await centralDb.get(
          `SELECT * FROM owner_accounts WHERE LOWER(email) = ? OR phone_number = ?`,
          [cleanIdentifier.toLowerCase(), cleanIdentifier]
        );
        if (owner) {
          const okOwner = await bcrypt.compare(password, owner.password_hash);
          if (okOwner) {
            const link: any = await centralDb.get(
              `SELECT role FROM owner_restaurants WHERE LOWER(owner_email) = ? AND restaurant_id = ?`,
              [owner.email.toLowerCase(), restaurantId]
            );
            if (link) {
              const role = link.role || 'OWNER';
              const token = jwt.sign(
                { id: owner.id, email: owner.email, restaurantId, role, userName: owner.owner_name },
                JWT_SECRET,
                { expiresIn: '7d' }
              );
              return res.json({
                success: true, token, restaurantId,
                restaurantName: rest.name, slug: rest.slug,
                role, name: owner.owner_name
              });
            }
            // Password matches but this owner doesn't own this restaurant
            return res.status(403).json({ error: "This account does not have access to this restaurant" });
          }
          return res.status(401).json({ error: "Invalid credentials" });
        }
      }

      // ── Source 2: legacy users table (login_id OR email scoped to this restaurant) ──
      // Owners registered via the legacy /api/auth/register path only exist in
      // this table (no owner_accounts row) — and they expect to log in with
      // their email, not the generated OWNER-XXXX login_id. Accepting either
      // is what matches their expectation and the email they receive at signup.
      const legacyUser: any = await centralDb.get(
        `SELECT * FROM users WHERE (login_id = ? OR LOWER(email) = ?) AND restaurant_id = ? AND is_active = 1`,
        [cleanIdentifier, cleanIdentifier.toLowerCase(), restaurantId]
      );
      if (legacyUser) {
        const okLegacy = await bcrypt.compare(password, legacyUser.password);
        if (okLegacy) {
          const token = jwt.sign(
            { id: legacyUser.id, restaurantId, role: legacyUser.role },
            JWT_SECRET,
            { expiresIn: '24h' }
          );
          return res.json({
            success: true, token, restaurantId,
            restaurantName: rest.name, slug: rest.slug,
            role: legacyUser.role, name: legacyUser.name
          });
        }
        return res.status(401).json({ error: "Invalid credentials" });
      }

      // ── Source 3: tenant attendance_staff (CHEF / WAITER / MANAGER) ──
      try {
        const tdb = await getTenantDb(restaurantId);
        const staff: any = await tdb.get(
          `SELECT * FROM attendance_staff WHERE login_id = ? AND is_active = 1`,
          [cleanIdentifier]
        );
        if (staff) {
          const okStaff = await bcrypt.compare(password, staff.password);
          if (okStaff) {
            const token = jwt.sign(
              { id: staff.id, restaurantId, role: staff.role },
              JWT_SECRET,
              { expiresIn: '24h' }
            );
            return res.json({
              success: true, token, restaurantId,
              restaurantName: rest.name, slug: rest.slug,
              role: staff.role, name: staff.name
            });
          }
          return res.status(401).json({ error: "Invalid credentials" });
        }
      } catch (tenantErr) {
        // Tenant schema might not have attendance_staff yet — fall through to 401
        console.error("tenant-login: tenant lookup failed:", tenantErr);
      }

      return res.status(401).json({ error: "Invalid credentials" });
    } catch (err: any) {
      console.error("/api/auth/tenant-login error:", err);
      res.status(500).json({ error: "Login failed. Please try again." });
    }
  });

  // ─── FORGOT PASSWORD ──────────────────────────────────────────────────────
  // POST /api/auth/forgot-password — generate secure token, email reset link
  // Covers both the new owner_accounts system AND the legacy users table
  app.post("/api/auth/forgot-password", async (req: Request, res: Response) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });
    try {
      const cleanEmail = email.trim().toLowerCase();

      // 1. Check new owner_accounts table first
      let ownerName: string | null = null;
      let resolvedEmail: string | null = null;

      const newAccount = await centralDb.get(
        "SELECT email, owner_name FROM owner_accounts WHERE LOWER(email) = ?",
        [cleanEmail]
      );
      if (newAccount) {
        ownerName    = newAccount.owner_name;
        resolvedEmail = newAccount.email;
      } else {
        // 2. Fall back to legacy users table (OWNER / MANAGER roles with email set)
        const legacyUser = await centralDb.get(
          "SELECT email, name FROM users WHERE LOWER(email) = ? AND role IN ('OWNER','MANAGER') AND is_active = 1",
          [cleanEmail]
        );
        if (legacyUser) {
          ownerName    = legacyUser.name;
          resolvedEmail = legacyUser.email;
        }
      }

      // Always return success — do not reveal whether email exists (anti-enumeration)
      if (!resolvedEmail) {
        console.log(`[Auth] Forgot-password: no account found for ${cleanEmail}`);
        return res.json({ success: true });
      }

      // Generate a secure random token (hex string)
      const { randomBytes } = await import("crypto");
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // Invalidate any previous unused tokens for this email
      await centralDb.run(
        "UPDATE password_reset_tokens SET used = 1 WHERE email = ? AND used = 0",
        [resolvedEmail]
      );

      // Store new token
      await centralDb.run(
        "INSERT INTO password_reset_tokens (token, email, expires_at) VALUES (?, ?, ?)",
        [token, resolvedEmail, expiresAt.toISOString()]
      );

      // Build reset URL — prefer explicit FRONTEND_URL env var, then derive from request
      let appOrigin: string;
      if (process.env.FRONTEND_URL) {
        appOrigin = process.env.FRONTEND_URL.replace(/\/$/, '');
      } else {
        const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
        const host  = (req.headers['x-forwarded-host'] as string) || (req.headers.host as string) || `localhost:${process.env.PORT || 5001}`;
        appOrigin = `${proto}://${host}`;
      }
      const resetUrl = `${appOrigin}?reset=${token}`;
      console.log(`[Auth] Password reset link for ${resolvedEmail}: ${resetUrl}`);

      const displayName = ownerName || 'there';
      const html = `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#faf5ee;padding:32px;border-radius:16px;">
          <h2 style="color:#e8721c;margin:0 0 8px;">Reset Your Password</h2>
          <p style="color:#444;margin:0 0 24px;">Hi ${displayName},</p>
          <p style="color:#444;">You requested a password reset for your Atithi Setu account. Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>
          <a href="${resetUrl}" style="display:inline-block;margin:24px 0;padding:14px 32px;background:#e8721c;color:#fff;text-decoration:none;border-radius:12px;font-weight:bold;font-size:16px;">Reset Password</a>
          <p style="color:#888;font-size:13px;">If you did not request this, please ignore this email — your password will remain unchanged.</p>
          <hr style="border:none;border-top:1px solid #e8721c22;margin:24px 0;"/>
          <p style="color:#aaa;font-size:11px;">Atithi Setu · Restaurant Management Platform</p>
        </div>`;

      await sendEmail(
        resolvedEmail,
        "Reset your Atithi Setu password",
        `Hi ${displayName},\n\nClick the link below to reset your password (expires in 1 hour):\n${resetUrl}\n\nIf you did not request this, ignore this email.`,
        html
      );

      res.json({ success: true });
    } catch (err) {
      console.error("Forgot password error:", err);
      res.status(500).json({ error: "Failed to send reset email. Please try again." });
    }
  });

  // POST /api/auth/reset-password — validate token, set new password
  // Updates whichever table (owner_accounts OR legacy users) holds this email
  app.post("/api/auth/reset-password", async (req: Request, res: Response) => {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: "Token and new password are required" });
    if (newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    try {
      const record = await centralDb.get(
        "SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0",
        [token]
      );
      if (!record) return res.status(400).json({ error: "Invalid or expired reset link. Please request a new one." });
      if (new Date(record.expires_at) < new Date()) {
        return res.status(400).json({ error: "This reset link has expired. Please request a new one." });
      }

      const hashedPassword = await bcrypt.hash(newPassword, 12);

      // Update new owner_accounts if email found there
      const newAcct = await centralDb.get(
        "SELECT email FROM owner_accounts WHERE LOWER(email) = ?",
        [record.email.toLowerCase()]
      );
      if (newAcct) {
        await centralDb.run(
          "UPDATE owner_accounts SET password_hash = ? WHERE email = ?",
          [hashedPassword, record.email]
        );
      }

      // Also update legacy users table if email found there (covers OWNER-XXXX login IDs)
      const legacyUser = await centralDb.get(
        "SELECT id FROM users WHERE LOWER(email) = ?",
        [record.email.toLowerCase()]
      );
      if (legacyUser) {
        await centralDb.run(
          "UPDATE users SET password = ? WHERE LOWER(email) = ?",
          [hashedPassword, record.email.toLowerCase()]
        );
      }

      if (!newAcct && !legacyUser) {
        return res.status(400).json({ error: "Account not found. Please contact support." });
      }

      // Mark token as used
      await centralDb.run("UPDATE password_reset_tokens SET used = 1 WHERE token = ?", [token]);
      console.log(`[Auth] Password reset completed for ${record.email}`);

      res.json({ success: true });
    } catch (err) {
      console.error("Reset password error:", err);
      res.status(500).json({ error: "Failed to reset password. Please try again." });
    }
  });
  // ─────────────────────────────────────────────────────────────────────────

  // POST /api/auth/owner/select-restaurant - Multi-restaurant owner picks a restaurant
  app.post("/api/auth/owner/select-restaurant", async (req: Request, res: Response) => {
    const { temp_token, restaurant_id } = req.body;
    try {
      let decoded: any;
      try {
        decoded = jwt.verify(temp_token, JWT_SECRET) as any;
      } catch {
        return res.status(401).json({ error: "Session expired. Please log in again." });
      }

      const access = await centralDb.get(
        `SELECT restaurant_id, restaurant_name, role FROM owner_restaurants
         WHERE owner_email = ? AND restaurant_id = ?`,
        [decoded.email, restaurant_id]
      );

      if (!access) {
        return res.status(403).json({ error: "You don't have access to this restaurant" });
      }

      const jwtToken = jwt.sign(
        { email: decoded.email, restaurantId: restaurant_id, role: access.role, userName: decoded.userName },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.json({
        success: true,
        jwt_token: jwtToken,
        restaurant_id,
        restaurant_name: access.restaurant_name,
        role: access.role,
        message: 'Restaurant selected'
      });
    } catch (err: any) {
      console.error("Error in /api/auth/owner/select-restaurant:", err);
      res.status(500).json({ error: "Failed to select restaurant" });
    }
  });

  // POST /api/auth/send-migration-email - Send migration link to existing users
  app.post("/api/auth/send-migration-email", async (req: Request, res: Response) => {
    const { email } = req.body;
    try {
      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      // Find user by email in old users table
      const existingUser = await centralDb.get(
        `SELECT * FROM users WHERE email = ?`,
        [email]
      );

      if (!existingUser) {
        // For security, don't reveal if email exists
        return res.json({ success: true, message: "If email exists in our system, a migration link has been sent" });
      }

      // Generate migration token (24h expiry)
      const migrationToken = jwt.sign(
        { email: email, purpose: 'migration', oldUserId: existingUser.id },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      const migrationLink = `http://localhost:5001/?auth=migrate&token=${migrationToken}`;

      // Send email (using existing sendEmail function)
      const emailContent = `
        <h2>🎉 Atithi-Setu Login Simplified!</h2>
        <p>We've redesigned your login experience to be much easier!</p>
        <h3>❌ OLD: Remember Business ID + Owner ID + Chef ID</h3>
        <h3>✅ NEW: Login with your phone number + WhatsApp OTP</h3>
        <p><strong><a href="${migrationLink}">Click here to complete your migration</a></strong></p>
        <p>Or paste this link: ${migrationLink}</p>
        <p><em>This link expires in 24 hours.</em></p>
        <hr/>
        <h3>Why phone-based login?</h3>
        <ul>
          <li>✓ One thing to remember (your phone!)</li>
          <li>✓ Works for all your restaurants</li>
          <li>✓ Instant OTP via WhatsApp</li>
          <li>✓ No lost ID cards</li>
        </ul>
        <p>Questions? Contact support at help@atithi-setu.com</p>
      `;

      await sendEmail(email, "Atithi-Setu Login Simplified! 🎉", emailContent);

      console.log(`📧 Migration email sent to ${email}`);
      res.json({ success: true, message: "Migration email sent successfully" });
    } catch (err: any) {
      console.error("Error in /api/auth/send-migration-email:", err);
      res.status(500).json({ error: "Failed to send migration email" });
    }
  });

  // Menu: Get Restaurant Menu
  app.get("/api/restaurant/:id/menu", async (req: Request, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      
      // Migration: Ensure all required columns exist
      await db.exec("ALTER TABLE menu ADD COLUMN IF NOT EXISTS drive_file_id TEXT");
      await db.exec("ALTER TABLE menu ADD COLUMN IF NOT EXISTS is_available INT DEFAULT 1");
      await db.exec("ALTER TABLE menu ADD COLUMN IF NOT EXISTS is_daily_special INT DEFAULT 0");
      await db.exec("ALTER TABLE menu ADD COLUMN IF NOT EXISTS price_half DOUBLE PRECISION");
      await db.exec("ALTER TABLE menu ADD COLUMN IF NOT EXISTS price_full DOUBLE PRECISION");
      
      const rows = await db.query("SELECT * FROM menu ORDER BY category, name");
      const menu = rows.map(row => ({
        ...row,
        image: row.image_url,
        available: row.is_available === 1,
        is_daily_special: row.is_daily_special === 1
      }));
      res.json(menu);
    } catch (err) {
      console.error("Failed to fetch menu for restaurant:", req.params.id, err);
      res.status(500).json({ error: "Failed to fetch menu" });
    }
  });

  // Menu: Add Item
  app.post("/api/restaurant/:id/menu", authenticate, menuImageUpload.single('image'), async (req: AuthRequest, res: Response) => {
    try {
      const { name, description, price, price_half, price_full, category, dietary_type, is_daily_special, drive_url } = req.body;
      const db = await getTenantDb(req.params.id);
      const id = randomUUID();
      let imageUrl: string | null = req.file ? await persistMenuImage(req.params.id, req.file) : null;
      let driveFileId = null;

      if (drive_url) {
        const extractedId = extractDriveId(drive_url);
        if (extractedId) {
          driveFileId = extractedId;
          const filename = `drive_${extractedId}.jpg`;
          const localPath = path.join(process.cwd(), "public", "uploads", filename);
          
          // Register in backup table so fallback works
          await centralDb.run("INSERT INTO image_backups (filename, drive_file_id) VALUES (?, ?) ON CONFLICT (filename) DO NOTHING", [filename, driveFileId]);
          
          // Download locally for immediate use
          const success = await downloadFromDrive(filename, localPath);
          if (success) {
            imageUrl = `/uploads/${filename}`;
          }
        }
      }

      await db.run(`
        INSERT INTO menu (id, name, description, price, price_half, price_full, category, dietary_type, is_daily_special, image_url, drive_file_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, name, description, price, price_half || null, price_full || null, category, dietary_type, is_daily_special === 'true' ? 1 : 0, imageUrl, driveFileId]);

      res.json({ success: true, id });
    } catch (err) {
      console.error("Add menu item error:", err);
      res.status(500).json({ error: "Failed to add menu item" });
    }
  });

  // Menu: Update Item
  app.patch("/api/menu/:id", authenticate, menuImageUpload.single('image'), async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const updates: Record<string, any> = { ...req.body };

      // If a new image file was uploaded, replace image_url
      if (req.file) {
        updates['image_url'] = await persistMenuImage(req.user!.restaurantId, req.file);
      }

      // Remove any empty price_half so we don't write empty string
      if (updates['price_half'] === '' || updates['price_half'] === 'undefined') {
        delete updates['price_half'];
      }

      // Phase 2 — flag the row as dirty so the menu-push cron re-publishes it
      // to delivery platforms next window. Triggered only on changes that
      // affect platform-visible state.
      const platformDirtyFields = new Set([
        'name', 'description', 'price', 'price_full', 'price_half',
        'category', 'image_url', 'is_available', 'dietary_type',
      ]);
      const hasPlatformDirty = Object.keys(updates).some(k => platformDirtyFields.has(k));
      if (hasPlatformDirty) {
        updates['sync_dirty'] = 1;
      }

      const keys = Object.keys(updates);
      if (keys.length === 0) return res.status(400).json({ error: "No updates provided" });

      const setClause = keys.map(k => `${k} = ?`).join(", ");
      const params = [...Object.values(updates), req.params.id];

      await db.run(`UPDATE menu SET ${setClause} WHERE id = ?`, params);
      res.json({ success: true, sync_dirty: hasPlatformDirty });
    } catch (err) {
      res.status(500).json({ error: "Failed to update menu item" });
    }
  });

  // Menu: Delete Item
  app.delete("/api/menu/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      await db.run("DELETE FROM menu WHERE id = ?", [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete menu item" });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ── Multi-platform Delivery: Phase 2 — Channel pricing + settings ───────
  // ═════════════════════════════════════════════════════════════════════════
  // Owner-controlled per-channel pricing on top of menu.price_full / price_half.
  // Two layers:
  //   1. channel_settings.default_markup_percent — applies to every menu item
  //      on this channel by default (owner sets once per channel).
  //   2. channel_prices — per-(menu_item, channel) overrides:
  //        - price_override = absolute INR (NULL when relying on markup)
  //        - markup_percent = +pct on top of menu.price (NULL when relying on default)
  //        - is_listed = 0 hides this item from this channel entirely.
  //
  // Effective channel price (single helper used by all readers):
  //   IF cp.is_listed = 0 → not visible
  //   ELSE IF cp.price_override IS NOT NULL → cp.price_override
  //   ELSE IF cp.markup_percent IS NOT NULL → menu.price * (1 + cp.markup_percent/100)
  //   ELSE → menu.price * (1 + cs.default_markup_percent/100)

  // Allowlist of valid channel ids — mirror of ALL_CHANNEL_IDS in integrations/types.ts.
  const VALID_CHANNELS = new Set(['SWIGGY', 'ZOMATO', 'DUNZO', 'MAGICPIN', 'ONDC', 'URBANPIPER']);

  // ── Channel settings ──

  // List per-channel settings (auto-creates default rows for any channels
  // missing in the table). Owner sees one card per platform.
  app.get("/api/restaurant/:id/integrations/channels", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const existing: any[] = await db.query("SELECT * FROM channel_settings");
      const have = new Set(existing.map((r: any) => r.channel));
      // Auto-seed any missing channels with defaults so the UI can render every card.
      for (const ch of VALID_CHANNELS) {
        if (!have.has(ch)) {
          await db.run(
            `INSERT INTO channel_settings (channel, is_active, default_markup_percent, commission_percent, prep_time_minutes, min_margin_floor_percent)
             VALUES (?, 0, 25, 25, 20, 5)
             ON CONFLICT (channel) DO NOTHING`,
            [ch]
          );
        }
      }
      const rows: any[] = await db.query("SELECT * FROM channel_settings ORDER BY channel");
      res.json(rows.map(r => ({
        ...r,
        is_active: Number(r.is_active) === 1,
        default_markup_percent: Number(r.default_markup_percent),
        commission_percent: Number(r.commission_percent),
        packaging_charge: Number(r.packaging_charge),
        min_order_amount: Number(r.min_order_amount),
        min_margin_floor_percent: Number(r.min_margin_floor_percent),
      })));
    } catch (err) {
      console.error("List channels error:", err);
      res.status(500).json({ error: "Failed to fetch channels" });
    }
  });

  // Update channel settings (markup %, commission %, prep time, min-margin floor, etc.)
  app.put("/api/restaurant/:id/integrations/:channel/settings", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const channel = String(req.params.channel).toUpperCase();
      if (!VALID_CHANNELS.has(channel)) return res.status(400).json({ error: `Unknown channel: ${channel}` });

      const allowed = [
        'is_active', 'default_markup_percent', 'commission_percent',
        'packaging_charge', 'min_order_amount', 'prep_time_minutes',
        'webhook_url_inbound', 'brand_display_name', 'min_margin_floor_percent',
      ];
      const updates: Record<string, any> = {};
      for (const k of allowed) {
        if (k in req.body) updates[k] = req.body[k];
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No updates provided" });
      }

      // Validate numeric guards
      if (updates.default_markup_percent != null && (updates.default_markup_percent < 0 || updates.default_markup_percent > 500)) {
        return res.status(400).json({ error: "default_markup_percent must be in [0, 500]" });
      }
      if (updates.commission_percent != null && (updates.commission_percent < 0 || updates.commission_percent > 90)) {
        return res.status(400).json({ error: "commission_percent must be in [0, 90]" });
      }
      if (updates.min_margin_floor_percent != null && (updates.min_margin_floor_percent < 0 || updates.min_margin_floor_percent > 90)) {
        return res.status(400).json({ error: "min_margin_floor_percent must be in [0, 90]" });
      }

      // Coerce booleans
      if ('is_active' in updates) updates.is_active = updates.is_active ? 1 : 0;

      const db = await getTenantDb(req.params.id);
      // Upsert — first ensure a row exists, then update. Simpler than a complex ON CONFLICT for variable column sets.
      await db.run(
        `INSERT INTO channel_settings (channel) VALUES (?) ON CONFLICT (channel) DO NOTHING`,
        [channel]
      );
      const setClause = Object.keys(updates).map(k => `${k} = ?`).join(", ");
      const params = [...Object.values(updates), channel];
      await db.run(
        `UPDATE channel_settings SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE channel = ?`,
        params
      );

      // Mark every menu item dirty so the menu-push cron republishes with the new
      // markup. Cheap — sync_dirty=1 just causes the next 15-min cron to re-push.
      if ('default_markup_percent' in updates || 'is_active' in updates) {
        await db.run("UPDATE menu SET sync_dirty = 1");
      }

      res.json({ success: true });
    } catch (err) {
      console.error("Update channel settings error:", err);
      res.status(500).json({ error: "Failed to update channel settings" });
    }
  });

  // ── Channel prices ──

  // Bulk fetch all channel_prices rows for the tenant (used by Menu UI to
  // render per-channel pills and by the menu-push cron to compute payloads).
  app.get("/api/restaurant/:id/menu/channel-prices", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const rows = await db.query("SELECT * FROM channel_prices ORDER BY menu_item_id, channel");
      res.json(rows.map((r: any) => ({
        ...r,
        price_override: r.price_override == null ? null : Number(r.price_override),
        markup_percent: r.markup_percent == null ? null : Number(r.markup_percent),
        is_listed: Number(r.is_listed) === 1,
      })));
    } catch (err) {
      console.error("Fetch channel prices error:", err);
      res.status(500).json({ error: "Failed to fetch channel prices" });
    }
  });

  // Get one menu item's channel-prices (driver for the Menu modal section).
  // Returns a row per channel — synthesises an "inherits from default markup"
  // entry if no channel_prices row exists yet.
  app.get("/api/restaurant/:id/menu/:itemId/channel-prices", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const item: any = await db.get(
        "SELECT id, name, price, price_full, price_half FROM menu WHERE id = ?",
        [req.params.itemId]
      );
      if (!item) return res.status(404).json({ error: "Menu item not found" });
      const basePrice = Number(item.price_full ?? item.price ?? 0);

      const settings: any[] = await db.query("SELECT * FROM channel_settings");
      const settingsByChannel: Record<string, any> = {};
      settings.forEach((s: any) => { settingsByChannel[s.channel] = s; });

      const overrides: any[] = await db.query(
        "SELECT * FROM channel_prices WHERE menu_item_id = ?",
        [req.params.itemId]
      );
      const overrideByChannel: Record<string, any> = {};
      overrides.forEach((o: any) => { overrideByChannel[o.channel] = o; });

      const result = Array.from(VALID_CHANNELS).map(ch => {
        const cp = overrideByChannel[ch];
        const cs = settingsByChannel[ch];
        const defaultMarkup = Number(cs?.default_markup_percent ?? 25);
        const isActive = Number(cs?.is_active ?? 0) === 1;
        const isListed = !cp || Number(cp.is_listed) === 1;
        const priceOverride = cp?.price_override == null ? null : Number(cp.price_override);
        const markupPercent = cp?.markup_percent == null ? null : Number(cp.markup_percent);
        const effectivePrice = priceOverride != null
          ? priceOverride
          : markupPercent != null
            ? Math.round(basePrice * (1 + markupPercent / 100) * 100) / 100
            : Math.round(basePrice * (1 + defaultMarkup / 100) * 100) / 100;
        return {
          channel: ch,
          channel_active: isActive,
          base_price: basePrice,
          default_markup_percent: defaultMarkup,
          is_listed: isListed,
          price_override: priceOverride,
          markup_percent: markupPercent,
          effective_price: effectivePrice,
          source: priceOverride != null ? 'OVERRIDE'
                : markupPercent != null  ? 'PER_ITEM_MARKUP'
                : 'CHANNEL_DEFAULT_MARKUP',
        };
      });

      res.json({ menu_item: item, channels: result });
    } catch (err) {
      console.error("Fetch item channel prices error:", err);
      res.status(500).json({ error: "Failed to fetch channel prices" });
    }
  });

  // Upsert one channel-price row for a menu item.
  // Body: { channel, price_override?, markup_percent?, is_listed? }
  // Exactly one of (price_override, markup_percent) should be set; passing
  // both clears markup_percent (override wins). Passing neither falls back
  // to the channel's default markup.
  app.put("/api/restaurant/:id/menu/:itemId/channel-prices", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { channel, price_override, markup_percent, is_listed } = req.body;
      if (!channel || !VALID_CHANNELS.has(String(channel).toUpperCase())) {
        return res.status(400).json({ error: `channel must be one of ${[...VALID_CHANNELS].join(', ')}` });
      }
      const ch = String(channel).toUpperCase();

      const db = await getTenantDb(req.params.id);
      const item: any = await db.get(
        "SELECT id, price, price_full FROM menu WHERE id = ?",
        [req.params.itemId]
      );
      if (!item) return res.status(404).json({ error: "Menu item not found" });
      const basePrice = Number(item.price_full ?? item.price ?? 0);

      // Min-margin floor guard: if the resulting effective_price is below the
      // configured floor multiplier, refuse to save.
      const cs: any = await db.get("SELECT * FROM channel_settings WHERE channel = ?", [ch]);
      const floorPct = Number(cs?.min_margin_floor_percent ?? 0);
      const effective = price_override != null && price_override !== ''
        ? Number(price_override)
        : markup_percent != null && markup_percent !== ''
          ? basePrice * (1 + Number(markup_percent) / 100)
          : basePrice * (1 + Number(cs?.default_markup_percent ?? 25) / 100);
      if (floorPct > 0) {
        if (basePrice <= 0) {
          // Without a base price we can't compute the floor — surface this so
          // owners notice menu items missing prices rather than silently
          // letting them bypass the floor.
          return res.status(422).json({
            error: `Cannot enforce min-margin floor: menu item has no in-house price. Set the menu item's price first, then configure the channel override.`,
            base_price: 0,
            floor_percent: floorPct,
          });
        }
        const floorPrice = basePrice * (1 + floorPct / 100);
        if (effective < floorPrice) {
          return res.status(422).json({
            error: `Effective price ₹${effective.toFixed(2)} is below the min-margin floor of ${floorPct}% (₹${floorPrice.toFixed(2)}). Raise the price or lower the floor in channel settings.`,
            base_price: basePrice,
            effective_price: effective,
            floor_percent: floorPct,
            floor_price: floorPrice,
          });
        }
      }

      // Normalise — exactly one of (override, markup) is non-null at a time.
      const normOverride = price_override == null || price_override === '' ? null : Number(price_override);
      const normMarkup   = price_override != null && price_override !== ''
        ? null
        : markup_percent == null || markup_percent === ''
          ? null
          : Number(markup_percent);
      const listedFlag   = is_listed === false ? 0 : 1;

      const id = `CP-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await db.run(
        `INSERT INTO channel_prices (id, menu_item_id, channel, price_override, markup_percent, is_listed, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (menu_item_id, channel) DO UPDATE SET
           price_override = EXCLUDED.price_override,
           markup_percent = EXCLUDED.markup_percent,
           is_listed = EXCLUDED.is_listed,
           updated_at = CURRENT_TIMESTAMP`,
        [id, req.params.itemId, ch, normOverride, normMarkup, listedFlag]
      );
      // Mark the menu row dirty so the next cron pushes it to the platform.
      await db.run("UPDATE menu SET sync_dirty = 1 WHERE id = ?", [req.params.itemId]);

      res.json({
        success: true,
        effective_price: Math.round(effective * 100) / 100,
        source: normOverride != null ? 'OVERRIDE' : normMarkup != null ? 'PER_ITEM_MARKUP' : 'CHANNEL_DEFAULT_MARKUP',
      });
    } catch (err) {
      console.error("Upsert channel price error:", err);
      res.status(500).json({ error: "Failed to update channel price" });
    }
  });

  // Bulk apply markup to many items at once. Two modes:
  //   { channel, markup_percent, item_ids?: string[] }    — every item or only a list
  //   { channel, price_override, item_ids: string[] }     — same absolute price across multiple items (rare; mostly used to zero out / hide a category)
  // Items already with explicit overrides keep them; this only touches the
  // markup_percent column (override wins). is_listed is preserved.
  app.post("/api/restaurant/:id/menu/channel-prices/bulk", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { channel, markup_percent, price_override, item_ids, hide } = req.body;
      if (!channel || !VALID_CHANNELS.has(String(channel).toUpperCase())) {
        return res.status(400).json({ error: `channel must be one of ${[...VALID_CHANNELS].join(', ')}` });
      }
      const ch = String(channel).toUpperCase();
      const db = await getTenantDb(req.params.id);

      // Resolve target item ids
      let targetIds: string[];
      if (Array.isArray(item_ids) && item_ids.length > 0) {
        targetIds = item_ids.map(String);
      } else {
        const all: any[] = await db.query("SELECT id FROM menu");
        targetIds = all.map((r: any) => r.id);
      }
      if (targetIds.length === 0) return res.json({ success: true, updated: 0 });

      // Min-margin floor guard for bulk apply. Same semantics as the single-item
      // endpoint at the top of the file — reject the whole bulk if any item
      // would end up below cost+floor. The "hide" mode and explicit
      // is_listed=0 case skip the check (we're not setting a price).
      if (hide !== true) {
        const cs: any = await db.get("SELECT * FROM channel_settings WHERE channel = ?", [ch]);
        const floorPct = Number(cs?.min_margin_floor_percent ?? 0);
        if (floorPct > 0) {
          const placeholdersForItems = targetIds.map(() => '?').join(',');
          const items: any[] = await db.query(
            `SELECT id, name, price, price_full FROM menu WHERE id IN (${placeholdersForItems})`,
            targetIds
          );
          const violations: Array<{ id: string; name: string; base_price: number; effective_price: number; floor_price: number }> = [];
          for (const it of items) {
            const basePrice = Number(it.price_full ?? it.price ?? 0);
            if (basePrice <= 0) continue;
            const effective = price_override != null && price_override !== ''
              ? Number(price_override)
              : markup_percent != null && markup_percent !== ''
                ? basePrice * (1 + Number(markup_percent) / 100)
                : basePrice * (1 + Number(cs?.default_markup_percent ?? 25) / 100);
            const floorPrice = basePrice * (1 + floorPct / 100);
            if (effective < floorPrice) {
              violations.push({
                id: it.id,
                name: it.name,
                base_price: basePrice,
                effective_price: Math.round(effective * 100) / 100,
                floor_price: Math.round(floorPrice * 100) / 100,
              });
            }
          }
          if (violations.length > 0) {
            return res.status(422).json({
              error: `${violations.length} item(s) would breach the min-margin floor of ${floorPct}%. Raise the markup/override or lower the floor in channel settings.`,
              floor_percent: floorPct,
              violations,
            });
          }
        }
      }

      let updated = 0;
      for (const itemId of targetIds) {
        const id = `CP-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        // For bulk: applying markup_percent CLEARS price_override (markup is the explicit choice).
        // For "hide" bulk: only flip is_listed = 0; preserve other fields.
        if (hide === true) {
          await db.run(
            `INSERT INTO channel_prices (id, menu_item_id, channel, is_listed, updated_at)
             VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)
             ON CONFLICT (menu_item_id, channel) DO UPDATE SET is_listed = 0, updated_at = CURRENT_TIMESTAMP`,
            [id, itemId, ch]
          );
        } else if (price_override != null && price_override !== '') {
          await db.run(
            `INSERT INTO channel_prices (id, menu_item_id, channel, price_override, markup_percent, is_listed, updated_at)
             VALUES (?, ?, ?, ?, NULL, 1, CURRENT_TIMESTAMP)
             ON CONFLICT (menu_item_id, channel) DO UPDATE SET
               price_override = EXCLUDED.price_override,
               markup_percent = NULL, is_listed = 1, updated_at = CURRENT_TIMESTAMP`,
            [id, itemId, ch, Number(price_override)]
          );
        } else if (markup_percent != null && markup_percent !== '') {
          await db.run(
            `INSERT INTO channel_prices (id, menu_item_id, channel, markup_percent, price_override, is_listed, updated_at)
             VALUES (?, ?, ?, ?, NULL, 1, CURRENT_TIMESTAMP)
             ON CONFLICT (menu_item_id, channel) DO UPDATE SET
               markup_percent = EXCLUDED.markup_percent,
               price_override = NULL, is_listed = 1, updated_at = CURRENT_TIMESTAMP`,
            [id, itemId, ch, Number(markup_percent)]
          );
        } else {
          // No-op for this item; nothing to apply.
          continue;
        }
        updated++;
      }
      // Mark all touched menu rows dirty for the next sync window.
      if (targetIds.length > 0) {
        const placeholders = targetIds.map(() => '?').join(',');
        await db.run(`UPDATE menu SET sync_dirty = 1 WHERE id IN (${placeholders})`, targetIds);
      }

      res.json({ success: true, updated });
    } catch (err) {
      console.error("Bulk channel price error:", err);
      res.status(500).json({ error: "Failed to bulk update channel prices" });
    }
  });

  // Delete a channel-price override (revert the item to the channel default markup).
  // ── Phase 5: Credentials encrypted CRUD ────────────────────────────────
  // Per-tenant + per-channel credentials. AES-256-GCM at rest, master key
  // from ATITHI_CREDENTIAL_KEY env var. The owner-facing UI never displays
  // secret material — only metadata (configured / not configured / rotated_at).
  // PUT replaces the credential bundle for a channel atomically.
  // POST .../rotate generates a fresh ciphertext for an existing row.

  // GET — list credential metadata for a channel (NEVER returns plaintext)
  app.get("/api/restaurant/:id/integrations/:channel/credentials", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const channel = String(req.params.channel).toUpperCase();
      if (!VALID_CHANNELS.has(channel)) return res.status(400).json({ error: `Unknown channel: ${channel}` });
      const db = await getTenantDb(req.params.id);
      const rows: any[] = await db.query(
        `SELECT credential_type, metadata, is_active, rotated_at, created_at
           FROM integration_credentials WHERE channel = ?`,
        [channel]
      );
      res.json({
        channel,
        configured: rows.length > 0,
        credential_types: rows.map(r => ({
          type: r.credential_type,
          is_active: Number(r.is_active) === 1,
          rotated_at: r.rotated_at,
          created_at: r.created_at,
          metadata: r.metadata || {},
        })),
        key_master_configured: isCredentialKeyConfigured(),
      });
    } catch (err) {
      console.error("Get credentials error:", err);
      res.status(500).json({ error: "Failed to fetch credentials" });
    }
  });

  // PUT — set/replace credentials for a channel
  // Body: { API_KEY?: string, HMAC_SECRET?: string, STORE_ID?: string, OAUTH_TOKEN?: string, metadata?: object }
  // Empty string for a key means "delete that credential type".
  app.put("/api/restaurant/:id/integrations/:channel/credentials", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const channel = String(req.params.channel).toUpperCase();
      if (!VALID_CHANNELS.has(channel)) return res.status(400).json({ error: `Unknown channel: ${channel}` });
      if (!isCredentialKeyConfigured()) {
        return res.status(503).json({ error: 'ATITHI_CREDENTIAL_KEY not configured on the server. Generate via `openssl rand -base64 32` and set the env var before storing credentials.' });
      }
      const db = await getTenantDb(req.params.id);
      const allowedTypes = ['API_KEY', 'OAUTH_TOKEN', 'HMAC_SECRET', 'STORE_ID'];
      const upserted: string[] = [];
      const deleted: string[] = [];
      for (const t of allowedTypes) {
        const v = req.body?.[t];
        if (v === undefined) continue;            // not touching this type
        if (v === '' || v === null) {             // explicit clear
          await db.run(
            "DELETE FROM integration_credentials WHERE channel = ? AND credential_type = ?",
            [channel, t]
          );
          deleted.push(t);
          continue;
        }
        const enc = encryptCredential(String(v));
        const id = `IC-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        await db.run(
          `INSERT INTO integration_credentials (id, channel, credential_type, ciphertext, iv, auth_tag, metadata, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT (channel, credential_type) DO UPDATE SET
             ciphertext = EXCLUDED.ciphertext,
             iv = EXCLUDED.iv,
             auth_tag = EXCLUDED.auth_tag,
             metadata = EXCLUDED.metadata,
             rotated_at = CURRENT_TIMESTAMP,
             is_active = 1`,
          [id, channel, t, enc.ciphertext, enc.iv, enc.authTag, JSON.stringify(req.body?.metadata || {})]
        );
        upserted.push(t);
      }
      res.json({ success: true, upserted, deleted });
    } catch (err) {
      console.error("PUT credentials error:", err);
      res.status(500).json({ error: "Failed to save credentials" });
    }
  });

  // DELETE — soft-delete (set is_active=0) for a channel's credentials.
  // Hard-delete still possible via PUT with empty strings.
  app.delete("/api/restaurant/:id/integrations/:channel/credentials", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const channel = String(req.params.channel).toUpperCase();
      if (!VALID_CHANNELS.has(channel)) return res.status(400).json({ error: `Unknown channel: ${channel}` });
      const db = await getTenantDb(req.params.id);
      await db.run(
        "UPDATE integration_credentials SET is_active = 0 WHERE channel = ?",
        [channel]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("DELETE credentials error:", err);
      res.status(500).json({ error: "Failed to disable credentials" });
    }
  });

  // POST .../test — smoke-test the credentials by calling pushStoreOpenClose(true) then (false).
  // If the adapter returns OK, the credentials work. If it throws, surface the error to the owner.
  app.post("/api/restaurant/:id/integrations/:channel/test", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const channel = String(req.params.channel).toUpperCase() as ChannelId;
      if (!VALID_CHANNELS.has(channel)) return res.status(400).json({ error: `Unknown channel: ${channel}` });
      const adapter = tryGetAdapter(channel);
      if (!adapter) return res.status(404).json({ error: `No adapter registered for ${channel}` });
      const db = await getTenantDb(req.params.id);
      const ctx = await loadAdapterContext(db, req.params.id, channel);
      // Open-then-close cycle. If credentials are wrong, the first call throws.
      try {
        await adapter.pushStoreOpenClose(true, ctx);
        // We don't actually want to leave the store open as a side-effect of a smoke test,
        // so close again immediately. The owner toggles the real state via the UI.
        await adapter.pushStoreOpenClose(false, ctx);
        res.json({ success: true, message: `Credentials verified for ${channel} — adapter responded OK to a test cycle.` });
      } catch (adapterErr: any) {
        return res.status(502).json({
          success: false,
          message: 'Adapter rejected the test call.',
          detail: String(adapterErr?.message || adapterErr).slice(0, 400),
        });
      }
    } catch (err: any) {
      console.error("Smoke-test error:", err);
      res.status(500).json({ error: "Smoke-test failed", detail: err?.message });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ── Phase 6 — Settlements (CSV upload) + reconciliation + analytics ────
  // ═════════════════════════════════════════════════════════════════════════
  // Each platform sends weekly settlement statements detailing the gross
  // revenue, commission deducted, taxes/fees, and the net payout to the
  // restaurant. Owners upload these CSVs (most platforms only expose them
  // via dashboard download — partner-API push comes in v2). We parse,
  // persist into channel_settlements + settlement_order_lines, then auto-
  // match each line to a local order via external_order_id.
  //
  // Variances flag for owner review. The Channel P&L analytics endpoint
  // joins settlements with stock_movements to compute true-margin per
  // channel: (net_payout − food_cost = profit). Answers "is Zomato actually
  // profitable?" with a real number.

  // Naive CSV parser — handles double-quoted fields with embedded commas
  // and escaped quotes (RFC 4180 minimal). Sufficient for Swiggy / Zomato /
  // Dunzo / UrbanPiper settlement CSVs which all use this dialect.
  function parseCsvSettlement(text: string): { headers: string[]; rows: Record<string, string>[] } {
    const lines = text.split(/\r?\n/).filter(l => l.length > 0);
    if (lines.length === 0) return { headers: [], rows: [] };
    const splitLine = (line: string): string[] => {
      const out: string[] = [];
      let cur = '';
      let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') { inQ = !inQ; }
        else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
        else { cur += c; }
      }
      out.push(cur);
      return out.map(s => s.trim());
    };
    const headers = splitLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, ''));
    const rows = lines.slice(1).map(l => {
      const vals = splitLine(l);
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
      return obj;
    });
    return { headers, rows };
  }

  // POST .../settlements — multipart CSV upload
  // Body: multipart with field "file" containing the settlement CSV
  // Optional fields:
  //   period_from (YYYY-MM-DD) · period_to (YYYY-MM-DD) — defaults to min/max of data
  app.post(
    "/api/restaurant/:id/integrations/:channel/settlements",
    authenticate,
    upload.single('file'),
    async (req: AuthRequest, res: Response) => {
      try {
        const channel = String(req.params.channel).toUpperCase();
        if (!VALID_CHANNELS.has(channel)) return res.status(400).json({ error: `Unknown channel: ${channel}` });
        if (!req.file) return res.status(400).json({ error: "No file uploaded (field name: 'file')" });

        const csvText = fs.readFileSync(req.file.path, 'utf8');
        const { headers, rows } = parseCsvSettlement(csvText);
        if (rows.length === 0) return res.status(400).json({ error: 'CSV is empty or unparseable' });

        // Heuristic header detection — match platform CSV variants
        const findHeader = (...candidates: string[]) =>
          candidates.find(c => headers.includes(c)) || null;
        const orderIdCol  = findHeader('order_id', 'external_order_id', 'platform_order_id', 'orderid', 'id');
        const grossCol    = findHeader('gross_amount', 'gross', 'order_total', 'subtotal', 'order_value');
        const commissionCol = findHeader('commission', 'commission_amount', 'platform_fee', 'aggregator_fee');
        const netCol      = findHeader('net_payout', 'net_amount', 'net', 'payout');
        const dateCol     = findHeader('order_date', 'date', 'placed_on', 'placed_at', 'timestamp');

        if (!orderIdCol || !grossCol || !netCol) {
          return res.status(400).json({
            error: 'Could not detect required columns',
            detail: `CSV needs at minimum: order_id, gross_amount, net_payout. Found columns: ${headers.join(', ')}`,
          });
        }

        const db = await getTenantDb(req.params.id);

        // Aggregate totals
        let totalGross = 0;
        let totalCommission = 0;
        let totalNet = 0;
        let minDate: string | null = null;
        let maxDate: string | null = null;
        for (const row of rows) {
          totalGross     += Number(row[grossCol] || 0);
          if (commissionCol) totalCommission += Number(row[commissionCol] || 0);
          totalNet       += Number(row[netCol] || 0);
          if (dateCol && row[dateCol]) {
            const d = String(row[dateCol]).slice(0, 10);
            if (!minDate || d < minDate) minDate = d;
            if (!maxDate || d > maxDate) maxDate = d;
          }
        }
        const periodFrom = req.body?.period_from || minDate || new Date().toISOString().slice(0, 10);
        const periodTo   = req.body?.period_to   || maxDate || new Date().toISOString().slice(0, 10);

        const settlementId = `STL-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        await db.run(
          `INSERT INTO channel_settlements
            (id, channel, period_from, period_to, gross_sales, commission_amount, net_payout, raw_statement_url, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            settlementId, channel, periodFrom, periodTo,
            totalGross, totalCommission, totalNet,
            `/uploads/${req.file.filename}`,
            `${rows.length} rows, columns: ${headers.join('|')}`,
          ]
        );

        // Auto-match each row to a local order by external_order_id
        let matched = 0;
        let missingLocal = 0;
        let varianceCount = 0;
        for (const row of rows) {
          const externalOrderId = String(row[orderIdCol] || '').trim();
          if (!externalOrderId) continue;
          const externalIdHash = require('crypto')
            .createHash('sha256')
            .update(`${channel}:${externalOrderId}`)
            .digest('hex');
          const localOrder: any = await db.get(
            "SELECT id, total_amount, net_payout_amount FROM orders WHERE external_id_hash = ?",
            [externalIdHash]
          );
          const lineId = `STLN-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
          const grossAmt = Number(row[grossCol] || 0);
          const commAmt  = commissionCol ? Number(row[commissionCol] || 0) : 0;
          const netAmt   = Number(row[netCol] || 0);
          let matchTag: string;
          let variance = 0;
          if (!localOrder) {
            matchTag = 'MISSING_LOCAL';
            missingLocal++;
          } else {
            const localNet = Number(localOrder.net_payout_amount || 0);
            variance = Math.abs(localNet - netAmt);
            matchTag = variance <= 1 ? 'EXACT' : 'PARTIAL';
            if (variance > 5) varianceCount++;
            matched++;
          }
          await db.run(
            `INSERT INTO settlement_order_lines
              (id, settlement_id, order_id, external_order_id, gross_amount, commission_amount, net_amount, reconciled_match, variance)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [lineId, settlementId, localOrder?.id || null, externalOrderId, grossAmt, commAmt, netAmt, matchTag, variance]
          );
        }

        // Mark reconciled if everything balances
        const reconciled = missingLocal === 0 && varianceCount === 0 ? 1 : 0;
        await db.run(
          "UPDATE channel_settlements SET reconciled = ? WHERE id = ?",
          [reconciled, settlementId]
        );

        // Owner notification on variance
        if (varianceCount > 0 || missingLocal > 0) {
          triggerNotification(req.params.id, 'SETTLEMENT_VARIANCE', {
            channel, settlementId, missingLocal, varianceCount, totalGross, totalNet,
          }).catch(() => {});
        } else {
          triggerNotification(req.params.id, 'SETTLEMENT_RECEIVED', {
            channel, settlementId, totalGross, totalNet, periodFrom, periodTo,
          }).catch(() => {});
        }

        res.json({
          success: true,
          settlement_id: settlementId,
          rows: rows.length,
          matched,
          missing_local: missingLocal,
          variance_count: varianceCount,
          totals: { gross: totalGross, commission: totalCommission, net: totalNet },
          reconciled: !!reconciled,
        });
      } catch (err) {
        console.error("Settlement upload error:", err);
        res.status(500).json({ error: "Failed to ingest settlement CSV" });
      }
    }
  );

  // GET .../settlements — list settlements (ordered DESC by period_to)
  app.get("/api/restaurant/:id/integrations/settlements", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const { channel } = req.query as any;
      const conds: string[] = [];
      const params: any[] = [];
      if (channel) { conds.push("channel = ?"); params.push(String(channel).toUpperCase()); }
      const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const rows: any[] = await db.query(
        `SELECT * FROM channel_settlements ${whereSql} ORDER BY period_to DESC LIMIT 100`,
        params
      );
      res.json(rows.map(r => ({
        ...r,
        gross_sales: Number(r.gross_sales || 0),
        commission_amount: Number(r.commission_amount || 0),
        net_payout: Number(r.net_payout || 0),
        reconciled: Number(r.reconciled || 0) === 1,
      })));
    } catch (err) {
      console.error("List settlements error:", err);
      res.status(500).json({ error: "Failed to list settlements" });
    }
  });

  // GET .../settlements/:id — detail with reconciliation lines
  app.get("/api/restaurant/:id/integrations/settlements/:settlementId", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const settlement: any = await db.get(
        "SELECT * FROM channel_settlements WHERE id = ?",
        [req.params.settlementId]
      );
      if (!settlement) return res.status(404).json({ error: "Settlement not found" });
      const lines: any[] = await db.query(
        "SELECT * FROM settlement_order_lines WHERE settlement_id = ? ORDER BY ABS(variance) DESC LIMIT 1000",
        [req.params.settlementId]
      );
      res.json({
        settlement: {
          ...settlement,
          gross_sales: Number(settlement.gross_sales || 0),
          commission_amount: Number(settlement.commission_amount || 0),
          net_payout: Number(settlement.net_payout || 0),
          reconciled: Number(settlement.reconciled || 0) === 1,
        },
        lines: lines.map(l => ({
          ...l,
          gross_amount: Number(l.gross_amount || 0),
          commission_amount: Number(l.commission_amount || 0),
          net_amount: Number(l.net_amount || 0),
          variance: Number(l.variance || 0),
        })),
        summary: {
          total_lines: lines.length,
          exact: lines.filter(l => l.reconciled_match === 'EXACT').length,
          partial: lines.filter(l => l.reconciled_match === 'PARTIAL').length,
          missing_local: lines.filter(l => l.reconciled_match === 'MISSING_LOCAL').length,
        },
      });
    } catch (err) {
      console.error("Settlement detail error:", err);
      res.status(500).json({ error: "Failed to load settlement detail" });
    }
  });

  // GET /integrations/analytics/channel-pnl
  // True-margin analytics per channel over a date range. Joins orders →
  // stock_movements (CONSUMPTION) → ingredients to compute food cost, then
  // subtracts from net_payout (or commission-adjusted total) to get profit.
  app.get("/api/restaurant/:id/integrations/analytics/channel-pnl", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const { from, to } = req.query as any;
      const fromDate = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const toDate   = to || new Date().toISOString().slice(0, 10);

      // 1. Per-channel order aggregates
      const orderRows: any[] = await db.query(
        `SELECT external_platform AS channel,
                COUNT(*) AS order_count,
                COALESCE(SUM(total_amount), 0) AS gross,
                COALESCE(SUM(commission_amount), 0) AS commission,
                COALESCE(SUM(net_payout_amount), 0) AS net_payout
           FROM orders
          WHERE external_platform IS NOT NULL
            AND status != 'CANCELLED'
            AND created_at >= ?::date
            AND created_at < ?::date + INTERVAL '1 day'
          GROUP BY external_platform`,
        [fromDate, toDate]
      );

      // 2. Per-channel food cost (sum of stock_movements.qty_delta × ingredient.default_unit_price
      //    for CONSUMPTION movements tied to orders in this window)
      const foodCostRows: any[] = await db.query(
        `SELECT o.external_platform AS channel,
                COALESCE(SUM(ABS(sm.qty_delta) * COALESCE(i.default_unit_price, 0)), 0) AS food_cost
           FROM stock_movements sm
           JOIN orders o ON o.id = sm.reference_id AND sm.reference_type = 'order'
           LEFT JOIN ingredients i ON i.id = sm.ingredient_id
          WHERE o.external_platform IS NOT NULL
            AND o.status != 'CANCELLED'
            AND o.created_at >= ?::date
            AND o.created_at < ?::date + INTERVAL '1 day'
            AND sm.movement_type = 'CONSUMPTION'
          GROUP BY o.external_platform`,
        [fromDate, toDate]
      );
      const foodCostByChannel: Record<string, number> = {};
      foodCostRows.forEach(r => { foodCostByChannel[r.channel] = Number(r.food_cost || 0); });

      // 3. Combine into per-channel P&L
      const byChannel = orderRows.map(r => {
        const channel = String(r.channel);
        const gross      = Number(r.gross || 0);
        const commission = Number(r.commission || 0);
        const netPayout  = Number(r.net_payout || 0);
        const foodCost   = foodCostByChannel[channel] || 0;
        // If net_payout is missing (e.g. webhook didn't include it), fall back to gross − commission
        const effectiveNet = netPayout > 0 ? netPayout : Math.max(0, gross - commission);
        const profit       = effectiveNet - foodCost;
        const profitPct    = gross > 0 ? Math.round((profit / gross) * 1000) / 10 : 0;
        return {
          channel,
          order_count: Number(r.order_count || 0),
          gross,
          commission,
          net_payout: effectiveNet,
          food_cost: foodCost,
          profit,
          profit_pct: profitPct,
          per_order_profit: Number(r.order_count) > 0 ? Math.round((profit / Number(r.order_count)) * 100) / 100 : 0,
        };
      }).sort((a, b) => b.profit - a.profit);

      const totals = byChannel.reduce((s, r) => ({
        order_count: s.order_count + r.order_count,
        gross: s.gross + r.gross,
        commission: s.commission + r.commission,
        net_payout: s.net_payout + r.net_payout,
        food_cost: s.food_cost + r.food_cost,
        profit: s.profit + r.profit,
      }), { order_count: 0, gross: 0, commission: 0, net_payout: 0, food_cost: 0, profit: 0 });

      res.json({
        from: fromDate, to: toDate,
        by_channel: byChannel,
        totals: { ...totals, profit_pct: totals.gross > 0 ? Math.round((totals.profit / totals.gross) * 1000) / 10 : 0 },
      });
    } catch (err) {
      console.error("Channel P&L error:", err);
      res.status(500).json({ error: "Failed to compute channel P&L" });
    }
  });

  // Reconciliation auto-match cron — runs hourly. For settlements still
  // marked reconciled=0, attempts to match any newly-placed local orders
  // (e.g. a webhook that arrived after the settlement was uploaded).
  cron.schedule('0 * * * *', async () => {
    try {
      const restaurants = await centralDb.query(
        "SELECT id FROM restaurants WHERE is_active = 1 AND id <> 'SYSTEM'"
      );
      for (const r of restaurants) {
        try {
          const db = await getTenantDb(r.id);
          const unreconciled: any[] = await db.query(
            "SELECT id, channel FROM channel_settlements WHERE reconciled = 0 LIMIT 50"
          ).catch(() => [] as any[]);
          for (const s of unreconciled) {
            const missingLines: any[] = await db.query(
              "SELECT * FROM settlement_order_lines WHERE settlement_id = ? AND reconciled_match = 'MISSING_LOCAL'",
              [s.id]
            ).catch(() => [] as any[]);
            let nowMatched = 0;
            for (const line of missingLines) {
              const externalIdHash = require('crypto')
                .createHash('sha256')
                .update(`${s.channel}:${line.external_order_id}`)
                .digest('hex');
              const localOrder: any = await db.get(
                "SELECT id, net_payout_amount FROM orders WHERE external_id_hash = ?",
                [externalIdHash]
              );
              if (localOrder) {
                const localNet = Number(localOrder.net_payout_amount || 0);
                const remoteNet = Number(line.net_amount || 0);
                const variance = Math.abs(localNet - remoteNet);
                const matchTag = variance <= 1 ? 'EXACT' : 'PARTIAL';
                await db.run(
                  "UPDATE settlement_order_lines SET order_id = ?, reconciled_match = ?, variance = ? WHERE id = ?",
                  [localOrder.id, matchTag, variance, line.id]
                );
                nowMatched++;
              }
            }
            if (nowMatched > 0) {
              // Re-check if all lines now matched
              const stillMissing: any = await db.get(
                "SELECT COUNT(*) AS c FROM settlement_order_lines WHERE settlement_id = ? AND reconciled_match = 'MISSING_LOCAL'",
                [s.id]
              );
              if (Number(stillMissing?.c || 0) === 0) {
                await db.run("UPDATE channel_settlements SET reconciled = 1 WHERE id = ?", [s.id]);
                console.log(`[reconcile] tenant ${r.id} settlement ${s.id} fully reconciled (matched ${nowMatched} previously-missing)`);
              } else {
                console.log(`[reconcile] tenant ${r.id} settlement ${s.id}: matched ${nowMatched} more, ${stillMissing.c} still missing`);
              }
            }
          }
        } catch (tenantErr) {
          console.warn(`[reconcile] tenant ${r.id} error:`, (tenantErr as any)?.message);
        }
      }
    } catch (err) {
      console.error('[reconcile] cron error:', err);
    }
  }, { timezone: 'Asia/Kolkata' });

  app.delete("/api/restaurant/:id/menu/:itemId/channel-prices/:channel", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const ch = String(req.params.channel).toUpperCase();
      if (!VALID_CHANNELS.has(ch)) return res.status(400).json({ error: `Unknown channel: ${ch}` });
      const db = await getTenantDb(req.params.id);
      await db.run(
        "DELETE FROM channel_prices WHERE menu_item_id = ? AND channel = ?",
        [req.params.itemId, ch]
      );
      await db.run("UPDATE menu SET sync_dirty = 1 WHERE id = ?", [req.params.itemId]);
      res.json({ success: true });
    } catch (err) {
      console.error("Delete channel price error:", err);
      res.status(500).json({ error: "Failed to delete channel price" });
    }
  });

  // ── Live platform orders feed — drives DELIVERY tab → Live Orders panel ──
  //
  // Returns orders where external_platform IS NOT NULL — i.e. orders that
  // came in from Swiggy / Zomato / Dunzo / etc. via the Phase 3 webhook.
  // Filters: ?platform= (case-insensitive) · ?status= · ?from= · ?to= · ?limit=
  // Default limit 100, max 500. Sorted by created_at DESC for live monitoring.
  app.get("/api/restaurant/:id/integrations/orders", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const { platform, status, from, to } = req.query as any;
      const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));

      const conds: string[] = ["external_platform IS NOT NULL"];
      const params: any[] = [];
      if (platform) {
        conds.push("UPPER(external_platform) = ?");
        params.push(String(platform).toUpperCase());
      }
      if (status) {
        conds.push("UPPER(status) = ?");
        params.push(String(status).toUpperCase());
      }
      if (from) {
        conds.push("created_at >= ?");
        params.push(String(from));
      }
      if (to) {
        conds.push("created_at < ?::date + INTERVAL '1 day'");
        params.push(String(to));
      }

      const rows: any[] = await db.query(
        `SELECT id, external_platform, external_order_id, invoice_number, status, kitchen_status,
                customer_name, customer_phone,
                customer_address_line1, customer_city, customer_pincode,
                items, total_amount, gst_amount, payment_method, payment_status,
                commission_amount, net_payout_amount, gst_collected_by,
                rider_name, rider_phone, rider_arrived_at,
                created_at
           FROM orders
          WHERE ${conds.join(' AND ')}
          ORDER BY created_at DESC
          LIMIT ${limit}`,
        params
      );

      // Aggregate live counters for the dashboard banner
      const byPlatform: Record<string, { count: number; gross: number }> = {};
      const byStatus: Record<string, number> = {};
      let openCount = 0; // Not DELIVERED / CANCELLED
      let todayGross = 0;
      const todayStr = new Date().toISOString().slice(0, 10);
      rows.forEach(r => {
        const ch = String(r.external_platform);
        if (!byPlatform[ch]) byPlatform[ch] = { count: 0, gross: 0 };
        byPlatform[ch].count++;
        byPlatform[ch].gross += Number(r.total_amount || 0);
        const st = String(r.status || '').toUpperCase();
        byStatus[st] = (byStatus[st] || 0) + 1;
        if (st !== 'DELIVERED' && st !== 'CANCELLED') openCount++;
        if (String(r.created_at).slice(0, 10) === todayStr) todayGross += Number(r.total_amount || 0);
      });

      res.json({
        orders: rows.map(r => {
          // items is stored as JSON text; parse defensively
          let items = r.items;
          if (typeof items === 'string') {
            try { items = JSON.parse(items); } catch { /* keep as string */ }
          }
          return {
            ...r,
            items,
            total_amount: Number(r.total_amount || 0),
            gst_amount: Number(r.gst_amount || 0),
            commission_amount: Number(r.commission_amount || 0),
            net_payout_amount: Number(r.net_payout_amount || 0),
          };
        }),
        summary: {
          total: rows.length,
          open: openCount,
          today_gross: todayGross,
          by_platform: byPlatform,
          by_status: byStatus,
        },
      });
    } catch (err) {
      console.error("List platform orders error:", err);
      res.status(500).json({ error: "Failed to list platform orders" });
    }
  });

  // ── ADMIN-ONLY: seed mock platform orders for demo / testing ───────────
  //
  // POST /api/restaurant/:id/integrations/dev/seed-mock-orders
  //   Auth: must be OWNER (with matching restaurantId) or SUPER_ADMIN/CTO
  //   Body: {
  //     count?: number,             default 30, max 200
  //     channels?: ChannelId[],     default ['SWIGGY','ZOMATO','DUNZO']
  //     days?: number,              spread orders over last N days (default 14)
  //     dry_run?: boolean,
  //     fire_notifications?: boolean,  default false
  //     deduct_inventory?: boolean,    default false (mock orders never touch real stock)
  //   }
  //
  // SAFETY:
  //   • Every order's external_order_id starts with "MOCK-" so the data is
  //     trivially identifiable and can be cleaned up later via the same prefix.
  //   • Inventory deduction is OFF by default (mock orders don't drain real stock).
  //   • Notifications are OFF by default (avoids spamming owner with 30 emails).
  //   • Production-grade — inserts via the same INSERT path real platform
  //     orders use, so the DELIVERY tab renders them identically.
  app.post(
    "/api/restaurant/:id/integrations/dev/seed-mock-orders",
    authenticate,
    async (req: AuthRequest, res: Response) => {
      try {
        // Auth gate
        const role = String(req.user?.role || '');
        const isAdmin = role === 'SUPER_ADMIN' || role === 'CTO';
        const isOwnerOfThisTenant = role === 'OWNER' && req.user?.restaurantId === req.params.id;
        if (!isAdmin && !isOwnerOfThisTenant) {
          return res.status(403).json({ error: 'Forbidden — OWNER (this tenant) or SUPER_ADMIN/CTO only' });
        }

        const count = Math.max(1, Math.min(200, Number(req.body?.count ?? 30)));
        const days = Math.max(1, Math.min(90, Number(req.body?.days ?? 14)));
        const dryRun = !!req.body?.dry_run;
        const fireNotifications = !!req.body?.fire_notifications;
        const deductInventory = !!req.body?.deduct_inventory;

        const requestedChannels: ChannelId[] = Array.isArray(req.body?.channels) && req.body.channels.length > 0
          ? req.body.channels.map((c: any) => String(c).toUpperCase()).filter((c: string) => ALL_CHANNEL_IDS.includes(c as ChannelId))
          : (['SWIGGY', 'ZOMATO', 'DUNZO'] as ChannelId[]);
        if (requestedChannels.length === 0) {
          return res.status(400).json({ error: 'No valid channels supplied' });
        }

        const db = await getTenantDb(req.params.id);

        // Need at least one menu item with a price
        const menuItems: any[] = await db.query(
          `SELECT id, name, COALESCE(price_full, price) AS price, dietary_type
             FROM menu
            WHERE COALESCE(price_full, price, 0) > 0
              AND is_available = 1
            LIMIT 200`
        );
        if (menuItems.length === 0) {
          return res.status(400).json({
            error: 'Tenant has no priced menu items — cannot generate mock orders',
          });
        }

        // Lightweight RNG so the seed is reproducible if caller wants it
        // (not required for current callers; deterministic-style for now)
        const rand = (a: number, b: number) => Math.floor(Math.random() * (b - a + 1)) + a;
        const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

        const STATUS_DISTRIBUTION = ['DELIVERED', 'DELIVERED', 'DELIVERED', 'DELIVERED', 'DELIVERED', 'DELIVERED', 'READY', 'READY', 'PREPARING', 'CANCELLED'];
        const PAYMENT_DISTRIBUTION = ['PREPAID', 'PREPAID', 'PREPAID', 'PREPAID', 'PREPAID', 'PREPAID', 'PREPAID', 'COD', 'COD', 'COD'];
        const FIRST_NAMES = ['Ananya', 'Rohan', 'Priya', 'Vivek', 'Neha', 'Karthik', 'Sneha', 'Arjun', 'Meera', 'Sanjay', 'Pooja', 'Rajesh', 'Divya', 'Aditya', 'Kavita', 'Manish', 'Riya', 'Suresh', 'Anjali', 'Vikram'];
        const LAST_NAMES = ['Sharma', 'Verma', 'Gupta', 'Iyer', 'Mehta', 'Nair', 'Reddy', 'Kapoor', 'Joshi', 'Patel', 'Singh', 'Desai', 'Khanna', 'Rao'];
        const STREETS = ['Connaught Place', 'Greater Kailash', 'Hauz Khas', 'Saket', 'Rajouri Garden', 'Vasant Kunj', 'Karol Bagh', 'Lajpat Nagar', 'Janakpuri', 'Dwarka'];
        const SAMPLE_PINCODES = ['110001', '110017', '110057', '110024', '110045', '110092', '110005', '110092'];

        // Plan
        const plan = {
          tenant: req.params.id,
          count,
          days,
          channels: requestedChannels,
          fire_notifications: fireNotifications,
          deduct_inventory: deductInventory,
        };
        if (dryRun) {
          return res.json({ dry_run: true, plan, would_insert: count });
        }

        const inserted: { id: string; external_order_id: string; channel: ChannelId; status: string; total: number }[] = [];
        let skippedDup = 0;

        for (let i = 0; i < count; i++) {
          const channel = pick(requestedChannels);
          // External id format: MOCK-{channel}-{ts}-{rand}
          const placedTs = Date.now() - rand(0, days * 86400000);
          const placedAt = new Date(placedTs);
          const dateStr = placedAt.toISOString().slice(0, 10).replace(/-/g, '');
          const externalOrderId = `MOCK-${channel}-${dateStr}-${String(i).padStart(3, '0')}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
          const externalIdHash = require('crypto')
            .createHash('sha256')
            .update(`${channel}:${externalOrderId}`)
            .digest('hex');

          // 2-4 random items
          const itemCount = rand(2, 4);
          const orderItems: any[] = [];
          let subtotal = 0;
          for (let j = 0; j < itemCount; j++) {
            const m = pick(menuItems);
            const qty = rand(1, 3);
            const unitPrice = Math.round(Number(m.price) * 1.25 * 100) / 100;  // ~25% platform markup
            const lineTotal = unitPrice * qty;
            subtotal += lineTotal;
            orderItems.push({
              id: m.id,
              external_item_id: `${channel.toLowerCase()}-${m.id.slice(-6)}`,
              name: m.name,
              quantity: qty,
              size: 'FULL',
              price: unitPrice,
            });
          }
          const taxes = Math.round(subtotal * 0.05 * 100) / 100;
          const packaging = rand(0, 30);
          const delivery = rand(0, 50);
          const total = subtotal + taxes + packaging + delivery;
          const commission = Math.round(subtotal * 0.25 * 100) / 100;
          const netPayout = Math.round((total - commission) * 100) / 100;

          const status = pick(STATUS_DISTRIBUTION);
          const paymentMode = pick(PAYMENT_DISTRIBUTION);
          const customerName = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
          const customerPhone = '9' + String(rand(100000000, 999999999));

          // Generate a clearly-mock order id
          const orderId = `ORD-${placedTs}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

          // Sequential invoice (cloud-kitchen-style) — atomic counter
          const invoiceNumber = await generateInvoiceNumberIfSequential(db, req.params.id, /* forceSequential */ true);

          // Read GST settings
          let orderGstPercent = 0;
          let orderApplyGst = 0;
          try {
            const restGst: any = await centralDb.get(
              "SELECT is_gst_enabled, gst_percentage FROM restaurants WHERE id = ?",
              [req.params.id]
            );
            if (restGst?.is_gst_enabled) {
              orderGstPercent = Number(restGst.gst_percentage || 0);
              orderApplyGst = 1;
            }
          } catch {}

          try {
            await db.run(`
              INSERT INTO orders
                (id, table_number, items, total_amount, gst_amount, status, customer_name, customer_phone,
                 customer_email, payment_method, session_id, checkout_mode, round_number, kitchen_status, invoice_number,
                 gst_percent, apply_gst, invoice_status,
                 customer_address_line1, customer_address_line2, customer_city, customer_pincode, customer_landmark,
                 external_platform, external_order_id, external_id_hash, external_payload,
                 commission_amount, net_payout_amount, gst_collected_by,
                 created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'cloud_kitchen', 1, ?, ?,
                      ?, ?, 'PRINTED',
                      ?, ?, ?, ?, ?,
                      ?, ?, ?, ?,
                      ?, ?, ?,
                      ?)
            `, [
              orderId,
              `Online (${channel})`,
              JSON.stringify(orderItems),
              total,
              taxes,
              status,
              customerName,
              customerPhone,
              null,
              paymentMode,
              status === 'DELIVERED' ? 'delivered' : status === 'READY' ? 'ready' : status === 'PREPARING' ? 'preparing' : 'queued',
              invoiceNumber,
              orderGstPercent,
              orderApplyGst,
              `${rand(1, 999)}, ${pick(STREETS)}`,
              null,
              'New Delhi',
              pick(SAMPLE_PINCODES),
              null,
              channel,
              externalOrderId,
              externalIdHash,
              JSON.stringify({ mock: true, generated_by: 'seed-mock-orders', generated_at: new Date().toISOString() }),
              commission,
              netPayout,
              'PLATFORM',
              placedAt.toISOString(),
            ]);
            inserted.push({ id: orderId, external_order_id: externalOrderId, channel, status, total });

            // Fire-and-forget inventory deduction (only if explicitly opted in)
            if (deductInventory) {
              deductIngredientsForOrder(db, orderId, orderItems, req.params.id).catch(() => {});
            }
          } catch (err: any) {
            // Most likely cause: unique-index collision on external_id_hash. Skip and continue.
            if (String(err?.message || '').match(/duplicate|unique/i)) skippedDup++;
            else console.warn(`[seed-mock] insert ${i} failed:`, err?.message);
          }
        }

        // Optional notification fire (just one summary, not 30 individual ones)
        if (fireNotifications && inserted.length > 0) {
          triggerNotification(req.params.id, 'NEW_PLATFORM_ORDER', {
            channel: 'MOCK',
            externalOrderId: 'BULK-SEED',
            orderId: 'BULK-SEED',
            customerName: `${inserted.length} mock orders seeded across ${requestedChannels.join('/')}`,
            address: 'Mock data',
            items: [`${inserted.length} synthetic orders`],
            total: inserted.reduce((s, o) => s + o.total, 0),
          }).catch(() => {});
        }

        res.json({
          success: true,
          inserted: inserted.length,
          skipped_duplicates: skippedDup,
          channels: requestedChannels,
          sample: inserted.slice(0, 5),
          message: `Inserted ${inserted.length} mock orders. Visit Delivery Partners → Live Orders to see them.`,
        });
      } catch (err: any) {
        console.error("Seed mock orders error:", err);
        res.status(500).json({ error: "Failed to seed mock orders", detail: err?.message });
      }
    }
  );

  // ═════════════════════════════════════════════════════════════════════════
  // ── Inventory Management — Phase 1: Ingredients & Recipes ───────────────
  // ═════════════════════════════════════════════════════════════════════════
  // 11 tenant-DB tables created in db.ts. This phase exposes the catalog
  // (ingredients) and recipe (menu→ingredient mapping) endpoints. Procurement,
  // consumption, and dashboard come in subsequent phases.

  // Ingredients: list all (active by default; ?include_inactive=1 for full)
  app.get("/api/restaurant/:id/inventory/ingredients", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const includeInactive = String(req.query.include_inactive || '') === '1';
      const where = includeInactive ? '' : 'WHERE is_active = 1';
      const rows = await db.query(
        `SELECT * FROM ingredients ${where} ORDER BY category, name`
      );
      res.json(rows);
    } catch (err) {
      console.error("List ingredients error:", err);
      res.status(500).json({ error: "Failed to fetch ingredients" });
    }
  });

  // Ingredients: get one
  app.get("/api/inventory/ingredients/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const row = await db.get("SELECT * FROM ingredients WHERE id = ?", [req.params.id]);
      if (!row) return res.status(404).json({ error: "Ingredient not found" });
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch ingredient" });
    }
  });

  // Ingredients: create
  app.post("/api/restaurant/:id/inventory/ingredients", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const {
        name, item_type, category, unit,
        current_stock_qty, reorder_point, par_level,
        default_supplier_id, default_unit_price, gst_percent,
        sku, image_url, notes, is_active,
      } = req.body;

      if (!name || !unit) {
        return res.status(400).json({ error: "name and unit are required" });
      }
      const allowedTypes = new Set(['RAW', 'PACKAGED']);
      const allowedUnits = new Set(['kg', 'g', 'l', 'ml', 'unit', 'bottle', 'piece', 'pack', 'dozen']);
      const safeType = allowedTypes.has(String(item_type || '').toUpperCase()) ? String(item_type).toUpperCase() : 'RAW';
      const safeUnit = allowedUnits.has(String(unit || '').toLowerCase()) ? String(unit).toLowerCase() : 'unit';

      const db = await getTenantDb(req.params.id);

      // Reject duplicates by case-insensitive name match. Important to prevent
      // the Setup Wizard / repeated CSV imports from creating "Butter" twice.
      // Soft-deleted (is_active=0) entries don't count — owner can re-add.
      const trimmedName = String(name).trim();
      const existing: any = await db.get(
        `SELECT id, is_active FROM ingredients WHERE LOWER(name) = LOWER(?) AND is_active = 1`,
        [trimmedName]
      );
      if (existing) {
        return res.status(409).json({
          error: `An ingredient named "${trimmedName}" already exists. Edit that one instead, or rename this.`,
          existing_id: existing.id,
        });
      }

      const id = `ING-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

      await db.run(
        `INSERT INTO ingredients
          (id, name, item_type, category, unit, current_stock_qty, reorder_point, par_level,
           default_supplier_id, default_unit_price, gst_percent, sku, image_url, notes, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, String(name).trim(), safeType, category || null, safeUnit,
          Number(current_stock_qty || 0),
          Number(reorder_point || 0),
          Number(par_level || 0),
          default_supplier_id || null,
          default_unit_price != null ? Number(default_unit_price) : null,
          Number(gst_percent || 0),
          sku || null, image_url || null, notes || null,
          is_active === 0 ? 0 : 1,
        ]
      );

      // If the user passed an opening stock, log it as a MANUAL movement so
      // the audit trail starts on the first day, not after the first GRN.
      const openingStock = Number(current_stock_qty || 0);
      if (openingStock > 0) {
        await db.run(
          `INSERT INTO stock_movements
            (id, ingredient_id, qty_delta, unit, movement_type, balance_after, recorded_by_user_id, notes)
           VALUES (?, ?, ?, ?, 'MANUAL', ?, ?, 'Opening stock')`,
          [
            `MOV-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            id, openingStock, safeUnit, openingStock, req.user!.id,
          ]
        ).catch(() => {});
      }

      res.json({ success: true, id });
    } catch (err) {
      console.error("Create ingredient error:", err);
      res.status(500).json({ error: "Failed to create ingredient" });
    }
  });

  // Ingredients: update
  app.patch("/api/inventory/ingredients/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const allowed = [
        'name', 'item_type', 'category', 'unit',
        'reorder_point', 'par_level',
        'default_supplier_id', 'default_unit_price', 'gst_percent',
        'sku', 'image_url', 'notes', 'is_active',
      ];
      const updates: string[] = [];
      const params: any[] = [];
      for (const k of allowed) {
        if (req.body[k] !== undefined) {
          updates.push(`${k} = ?`);
          params.push(req.body[k]);
        }
      }
      if (updates.length === 0) return res.status(400).json({ error: "Nothing to update" });
      updates.push("updated_at = CURRENT_TIMESTAMP");
      params.push(req.params.id);
      await db.run(`UPDATE ingredients SET ${updates.join(", ")} WHERE id = ?`, params);
      res.json({ success: true });
    } catch (err) {
      console.error("Update ingredient error:", err);
      res.status(500).json({ error: "Failed to update ingredient" });
    }
  });

  // Ingredients: soft-delete (sets is_active=0). Hard delete blocked because
  // recipes / movements / GRN line items reference this row.
  app.delete("/api/inventory/ingredients/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      await db.run("UPDATE ingredients SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to deactivate ingredient" });
    }
  });

  // Ingredients: bulk stock adjustment (manual override)
  // Used for ad-hoc corrections. Logs MANUAL movement with a "before/after" note.
  app.post("/api/inventory/ingredients/:id/adjust-stock", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { new_qty, reason } = req.body;
      if (new_qty == null || isNaN(Number(new_qty))) {
        return res.status(400).json({ error: "new_qty (number) is required" });
      }
      const db = await getTenantDb(req.user!.restaurantId);
      const ing: any = await db.get("SELECT * FROM ingredients WHERE id = ?", [req.params.id]);
      if (!ing) return res.status(404).json({ error: "Ingredient not found" });

      const currentQty = Number(ing.current_stock_qty || 0);
      const targetQty  = Number(new_qty);
      const delta      = targetQty - currentQty;

      await db.run(
        `UPDATE ingredients SET current_stock_qty = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [targetQty, req.params.id]
      );
      await db.run(
        `INSERT INTO stock_movements
          (id, ingredient_id, qty_delta, unit, movement_type, balance_after, recorded_by_user_id, notes)
         VALUES (?, ?, ?, ?, 'MANUAL', ?, ?, ?)`,
        [
          `MOV-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          req.params.id, delta, ing.unit, targetQty, req.user!.id,
          reason || `Manual adjustment ${currentQty} → ${targetQty}`,
        ]
      );
      res.json({ success: true, balance: targetQty, delta });
    } catch (err) {
      console.error("Adjust stock error:", err);
      res.status(500).json({ error: "Failed to adjust stock" });
    }
  });

  // ─── Recipes — menu_item ↔ ingredient mapping ────────────────────────────

  // Get recipe rows for a menu item. Returns array (may be empty if no recipe yet).
  app.get("/api/restaurant/:id/menu/:menuItemId/recipe", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const rows = await db.query(
        `SELECT r.*, i.name AS ingredient_name, i.unit AS ingredient_unit, i.current_stock_qty
           FROM recipes r
           LEFT JOIN ingredients i ON i.id = r.ingredient_id
          WHERE r.menu_item_id = ?
          ORDER BY i.name`,
        [req.params.menuItemId]
      );
      res.json(rows);
    } catch (err) {
      console.error("Get recipe error:", err);
      res.status(500).json({ error: "Failed to fetch recipe" });
    }
  });

  // Replace ALL recipe rows for a menu item in a single PUT.
  // Body: { items: [{ ingredient_id, qty_per_serving, unit, size_variant?, notes? }, ...] }
  // Atomic: existing rows for this menu_item_id are deleted, new rows inserted.
  // Empty items array clears the recipe.
  app.put("/api/restaurant/:id/menu/:menuItemId/recipe", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { items } = req.body;
      if (!Array.isArray(items)) {
        return res.status(400).json({ error: "items array is required" });
      }
      const db = await getTenantDb(req.params.id);
      const menuItemId = req.params.menuItemId;

      // Verify menu item exists in this tenant before writing recipes
      const menuItem = await db.get("SELECT id FROM menu WHERE id = ?", [menuItemId]);
      if (!menuItem) return res.status(404).json({ error: "Menu item not found" });

      // Tier-2 recipe versioning: instead of wiping old rows, mark them
      // superseded by setting effective_to = NOW(). New rows then get
      // effective_from = NOW(). This way historical orders keep deducting
      // against the recipe that was active at order time.
      // ?versioned=1 query param opts in (default for fresh edits); legacy
      // bulk-import flows can pass ?versioned=0 to keep the old wipe-and-replace.
      const versioned = String((req.query.versioned ?? '1')) !== '0';
      if (versioned) {
        await db.run(
          `UPDATE recipes
              SET effective_to = NOW()
            WHERE menu_item_id = ? AND effective_to IS NULL`,
          [menuItemId]
        );
      } else {
        await db.run("DELETE FROM recipes WHERE menu_item_id = ?", [menuItemId]);
      }

      const allowedSizes = new Set(['FULL', 'HALF', 'BOTH']);
      let inserted = 0;
      for (const it of items) {
        if (!it.ingredient_id || it.qty_per_serving == null) continue;
        const sizeVariant = allowedSizes.has(String(it.size_variant || 'BOTH').toUpperCase())
          ? String(it.size_variant || 'BOTH').toUpperCase()
          : 'BOTH';
        await db.run(
          `INSERT INTO recipes (id, menu_item_id, ingredient_id, qty_per_serving, unit, size_variant, notes, effective_from)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `REC-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            menuItemId,
            it.ingredient_id,
            Number(it.qty_per_serving),
            String(it.unit || 'g').toLowerCase(),
            sizeVariant,
            it.notes || null,
            versioned ? new Date() : null,
          ]
        );
        inserted++;
      }
      res.json({ success: true, inserted, versioned });
    } catch (err) {
      console.error("Save recipe error:", err);
      res.status(500).json({ error: "Failed to save recipe" });
    }
  });

  // Copy recipe from one menu item to another (helper for dishes that share ingredients)
  app.post("/api/restaurant/:id/menu/:menuItemId/recipe/copy-from/:sourceId", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const sourceRows: any[] = await db.query(
        "SELECT * FROM recipes WHERE menu_item_id = ?",
        [req.params.sourceId]
      );
      if (sourceRows.length === 0) {
        return res.status(404).json({ error: "Source recipe is empty or doesn't exist" });
      }
      // Wipe target then copy
      await db.run("DELETE FROM recipes WHERE menu_item_id = ?", [req.params.menuItemId]);
      let copied = 0;
      for (const r of sourceRows) {
        await db.run(
          `INSERT INTO recipes (id, menu_item_id, ingredient_id, qty_per_serving, unit, size_variant, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            `REC-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            req.params.menuItemId, r.ingredient_id, r.qty_per_serving, r.unit, r.size_variant, r.notes,
          ]
        );
        copied++;
      }
      res.json({ success: true, copied });
    } catch (err) {
      console.error("Copy recipe error:", err);
      res.status(500).json({ error: "Failed to copy recipe" });
    }
  });

  // Bulk recipe export — every recipe row joined with menu_item + ingredient names.
  // One call instead of 200+ for tenants with large menus.
  app.get("/api/restaurant/:id/recipes", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const rows = await db.query(
        `SELECT r.menu_item_id, m.name AS menu_item_name, m.category AS menu_item_category,
                r.ingredient_id, i.name AS ingredient_name, i.category AS ingredient_category, i.unit AS ingredient_unit,
                r.qty_per_serving, r.unit AS recipe_unit, r.size_variant, r.notes
           FROM recipes r
           LEFT JOIN menu m ON m.id = r.menu_item_id
           LEFT JOIN ingredients i ON i.id = r.ingredient_id
          ORDER BY m.category, m.name, i.name`
      );
      res.json(rows);
    } catch (err) {
      console.error("Bulk recipes export error:", err);
      res.status(500).json({ error: "Failed to fetch recipes" });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ── Inventory Management — Phase 2: Suppliers + PO + GRN ─────────────────
  // ═════════════════════════════════════════════════════════════════════════
  // Procurement workflow: maintain supplier directory, raise Purchase Orders,
  // record Goods Receipts that increment stock + log to stock_movements.

  // ─── Suppliers — vendor directory ────────────────────────────────────────

  app.get("/api/restaurant/:id/inventory/suppliers", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const includeInactive = String(req.query.include_inactive || '') === '1';
      const where = includeInactive ? '' : 'WHERE is_active = 1';
      const rows = await db.query(
        `SELECT * FROM suppliers ${where} ORDER BY name`
      );
      res.json(rows);
    } catch (err) {
      console.error("List suppliers error:", err);
      res.status(500).json({ error: "Failed to fetch suppliers" });
    }
  });

  app.get("/api/inventory/suppliers/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const row = await db.get("SELECT * FROM suppliers WHERE id = ?", [req.params.id]);
      if (!row) return res.status(404).json({ error: "Supplier not found" });
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch supplier" });
    }
  });

  app.post("/api/restaurant/:id/inventory/suppliers", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const {
        name, contact_name, phone, email, address, gst_number,
        lead_time_days, payment_terms, notes,
      } = req.body;
      if (!name) return res.status(400).json({ error: "name is required" });

      const db = await getTenantDb(req.params.id);

      // Dedup by case-insensitive name (active suppliers only)
      const trimmedName = String(name).trim();
      const existing: any = await db.get(
        `SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?) AND is_active = 1`,
        [trimmedName]
      );
      if (existing) {
        return res.status(409).json({
          error: `A supplier named "${trimmedName}" already exists. Edit that one instead.`,
          existing_id: existing.id,
        });
      }

      const id = `SUP-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await db.run(
        `INSERT INTO suppliers
          (id, name, contact_name, phone, email, address, gst_number,
           lead_time_days, payment_terms, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, String(name).trim(),
          contact_name || null, phone || null, email || null, address || null,
          gst_number || null,
          Math.max(0, parseInt(String(lead_time_days || 1), 10)),
          payment_terms || null, notes || null,
        ]
      );
      res.json({ success: true, id });
    } catch (err) {
      console.error("Create supplier error:", err);
      res.status(500).json({ error: "Failed to create supplier" });
    }
  });

  app.patch("/api/inventory/suppliers/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const allowed = [
        'name', 'contact_name', 'phone', 'email', 'address', 'gst_number',
        'lead_time_days', 'payment_terms', 'notes', 'is_active',
      ];
      const updates: string[] = [];
      const params: any[] = [];
      for (const k of allowed) {
        if (req.body[k] !== undefined) {
          updates.push(`${k} = ?`);
          params.push(req.body[k]);
        }
      }
      if (updates.length === 0) return res.status(400).json({ error: "Nothing to update" });
      params.push(req.params.id);
      await db.run(`UPDATE suppliers SET ${updates.join(", ")} WHERE id = ?`, params);
      res.json({ success: true });
    } catch (err) {
      console.error("Update supplier error:", err);
      res.status(500).json({ error: "Failed to update supplier" });
    }
  });

  // Soft-delete (PO/GRN history references this row)
  app.delete("/api/inventory/suppliers/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      await db.run("UPDATE suppliers SET is_active = 0 WHERE id = ?", [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to deactivate supplier" });
    }
  });

  // ─── Purchase Orders — DRAFT → SENT → PARTIAL → RECEIVED → CANCELLED ─────

  // List POs with optional status filter and supplier-name join
  app.get("/api/restaurant/:id/inventory/purchase-orders", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const status = String(req.query.status || '').toUpperCase();
      const allowedStatuses = new Set(['DRAFT', 'SENT', 'PARTIAL', 'RECEIVED', 'CANCELLED']);
      const filterSql = allowedStatuses.has(status) ? `WHERE po.status = '${status}'` : '';

      const rows = await db.query(
        `SELECT po.*, s.name AS supplier_name, s.phone AS supplier_phone,
                COALESCE(SUM(poi.qty_ordered), 0) AS total_qty_ordered,
                COALESCE(SUM(poi.qty_received), 0) AS total_qty_received,
                COUNT(poi.id) AS line_count
           FROM purchase_orders po
           LEFT JOIN suppliers s ON s.id = po.supplier_id
           LEFT JOIN purchase_order_items poi ON poi.po_id = po.id
           ${filterSql}
          GROUP BY po.id, s.name, s.phone
          ORDER BY po.raised_at DESC`
      );
      res.json(rows);
    } catch (err) {
      console.error("List POs error:", err);
      res.status(500).json({ error: "Failed to fetch purchase orders" });
    }
  });

  // Get one PO with its line items + ingredient names
  app.get("/api/inventory/purchase-orders/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const po: any = await db.get(
        `SELECT po.*, s.name AS supplier_name, s.phone AS supplier_phone,
                s.email AS supplier_email, s.lead_time_days
           FROM purchase_orders po
           LEFT JOIN suppliers s ON s.id = po.supplier_id
          WHERE po.id = ?`,
        [req.params.id]
      );
      if (!po) return res.status(404).json({ error: "PO not found" });

      const items = await db.query(
        `SELECT poi.*, i.name AS ingredient_name, i.category AS ingredient_category
           FROM purchase_order_items poi
           LEFT JOIN ingredients i ON i.id = poi.ingredient_id
          WHERE poi.po_id = ?
          ORDER BY i.name`,
        [req.params.id]
      );
      res.json({ ...po, items });
    } catch (err) {
      console.error("Get PO error:", err);
      res.status(500).json({ error: "Failed to fetch PO" });
    }
  });

  // Create a PO (status starts as DRAFT). Body:
  //   { supplier_id, expected_delivery_date?, notes?,
  //     items: [{ ingredient_id, qty_ordered, unit, unit_price }, ...] }
  app.post("/api/restaurant/:id/inventory/purchase-orders", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { supplier_id, expected_delivery_date, notes, items } = req.body;
      if (!supplier_id) return res.status(400).json({ error: "supplier_id is required" });
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "items array (with at least 1 line) is required" });
      }

      const db = await getTenantDb(req.params.id);
      const supplier: any = await db.get("SELECT id FROM suppliers WHERE id = ?", [supplier_id]);
      if (!supplier) return res.status(400).json({ error: "Supplier not found" });

      // Compute totals from line items
      let totalAmount = 0;
      let gstAmount = 0;
      const validItems: any[] = [];
      for (const it of items) {
        if (!it.ingredient_id || it.qty_ordered == null || it.unit_price == null) continue;
        const ing: any = await db.get("SELECT id, gst_percent, unit FROM ingredients WHERE id = ?", [it.ingredient_id]);
        if (!ing) continue;
        const qty = Math.max(0, Number(it.qty_ordered));
        const price = Math.max(0, Number(it.unit_price));
        const gstPct = Number(ing.gst_percent || 0);
        const lineSubtotal = qty * price;
        const lineGst = lineSubtotal * (gstPct / 100);
        totalAmount += lineSubtotal;
        gstAmount += lineGst;
        validItems.push({
          ingredient_id: it.ingredient_id,
          qty_ordered: qty,
          unit: String(it.unit || ing.unit || 'unit').toLowerCase(),
          unit_price: price,
        });
      }
      if (validItems.length === 0) {
        return res.status(400).json({ error: "No valid line items (need ingredient_id, qty_ordered, unit_price)" });
      }
      const grandTotal = totalAmount + gstAmount;

      // Sequential PO ID — atomic counter per tenant (PO-0001, PO-0002, …)
      const seq = await getNextTenantSequence(db, 'po');
      const poId = `PO-${String(seq).padStart(4, '0')}`;

      await db.run(
        `INSERT INTO purchase_orders
          (id, supplier_id, status, expected_delivery_date,
           total_amount, gst_amount, grand_total,
           raised_by_user_id, notes)
         VALUES (?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)`,
        [
          poId, supplier_id, expected_delivery_date || null,
          totalAmount, gstAmount, grandTotal,
          req.user!.id, notes || null,
        ]
      );

      for (const it of validItems) {
        await db.run(
          `INSERT INTO purchase_order_items
            (id, po_id, ingredient_id, qty_ordered, unit, unit_price)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            `POI-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            poId, it.ingredient_id, it.qty_ordered, it.unit, it.unit_price,
          ]
        );
      }

      res.json({ success: true, id: poId, total_amount: totalAmount, gst_amount: gstAmount, grand_total: grandTotal });
    } catch (err) {
      console.error("Create PO error:", err);
      res.status(500).json({ error: "Failed to create PO" });
    }
  });

  // Update PO header (only DRAFT POs editable for header fields)
  app.patch("/api/inventory/purchase-orders/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const po: any = await db.get("SELECT status FROM purchase_orders WHERE id = ?", [req.params.id]);
      if (!po) return res.status(404).json({ error: "PO not found" });
      if (po.status !== 'DRAFT') {
        return res.status(409).json({ error: `PO is in status ${po.status}, only DRAFT POs are editable` });
      }
      const allowed = ['supplier_id', 'expected_delivery_date', 'notes'];
      const updates: string[] = [];
      const params: any[] = [];
      for (const k of allowed) {
        if (req.body[k] !== undefined) {
          updates.push(`${k} = ?`);
          params.push(req.body[k]);
        }
      }
      if (updates.length === 0) return res.status(400).json({ error: "Nothing to update" });
      params.push(req.params.id);
      await db.run(`UPDATE purchase_orders SET ${updates.join(", ")} WHERE id = ?`, params);
      res.json({ success: true });
    } catch (err) {
      console.error("Update PO error:", err);
      res.status(500).json({ error: "Failed to update PO" });
    }
  });

  // Replace line items on a DRAFT PO. Recomputes totals.
  app.put("/api/inventory/purchase-orders/:id/items", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { items } = req.body;
      if (!Array.isArray(items)) return res.status(400).json({ error: "items array is required" });
      const db = await getTenantDb(req.user!.restaurantId);
      const po: any = await db.get("SELECT status FROM purchase_orders WHERE id = ?", [req.params.id]);
      if (!po) return res.status(404).json({ error: "PO not found" });
      if (po.status !== 'DRAFT') {
        return res.status(409).json({ error: `Can't edit line items on a ${po.status} PO` });
      }

      await db.run("DELETE FROM purchase_order_items WHERE po_id = ?", [req.params.id]);

      let totalAmount = 0, gstAmount = 0;
      for (const it of items) {
        if (!it.ingredient_id || it.qty_ordered == null || it.unit_price == null) continue;
        const ing: any = await db.get("SELECT gst_percent, unit FROM ingredients WHERE id = ?", [it.ingredient_id]);
        if (!ing) continue;
        const qty = Math.max(0, Number(it.qty_ordered));
        const price = Math.max(0, Number(it.unit_price));
        totalAmount += qty * price;
        gstAmount += qty * price * (Number(ing.gst_percent || 0) / 100);
        await db.run(
          `INSERT INTO purchase_order_items (id, po_id, ingredient_id, qty_ordered, unit, unit_price)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            `POI-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            req.params.id, it.ingredient_id, qty,
            String(it.unit || ing.unit || 'unit').toLowerCase(), price,
          ]
        );
      }
      const grandTotal = totalAmount + gstAmount;
      await db.run(
        "UPDATE purchase_orders SET total_amount = ?, gst_amount = ?, grand_total = ? WHERE id = ?",
        [totalAmount, gstAmount, grandTotal, req.params.id]
      );
      res.json({ success: true, total_amount: totalAmount, gst_amount: gstAmount, grand_total: grandTotal });
    } catch (err) {
      console.error("Update PO items error:", err);
      res.status(500).json({ error: "Failed to update PO items" });
    }
  });

  // Mark a PO as SENT (DRAFT → SENT). Optionally fires an email to the supplier later.
  app.post("/api/inventory/purchase-orders/:id/send", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const po: any = await db.get("SELECT status FROM purchase_orders WHERE id = ?", [req.params.id]);
      if (!po) return res.status(404).json({ error: "PO not found" });
      if (po.status !== 'DRAFT') {
        return res.status(409).json({ error: `Cannot send a ${po.status} PO` });
      }
      await db.run(
        "UPDATE purchase_orders SET status = 'SENT', sent_at = CURRENT_TIMESTAMP WHERE id = ?",
        [req.params.id]
      );
      res.json({ success: true, status: 'SENT' });
    } catch (err) {
      res.status(500).json({ error: "Failed to send PO" });
    }
  });

  // ─── PO PDF + Email ──────────────────────────────────────────────────────
  // Helper: hydrate full PO data (header + items + supplier + restaurant) for
  // PDF generation. Used by both the download and email endpoints.
  const hydratePOForPdf = async (db: DbInterface, poId: string, restaurantId: string): Promise<POPdfData | null> => {
    const po: any = await db.get(
      `SELECT po.*, s.name AS supplier_name, s.contact_name AS supplier_contact_name,
              s.phone AS supplier_phone, s.email AS supplier_email,
              s.address AS supplier_address, s.gst_number AS supplier_gstin,
              s.lead_time_days AS supplier_lead_time_days,
              s.payment_terms AS supplier_payment_terms
         FROM purchase_orders po
         LEFT JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.id = ?`,
      [poId]
    );
    if (!po) return null;
    const items: any[] = await db.query(
      `SELECT poi.qty_ordered, poi.unit, poi.unit_price,
              i.name AS ingredient_name, i.gst_percent
         FROM purchase_order_items poi
         LEFT JOIN ingredients i ON i.id = poi.ingredient_id
        WHERE poi.po_id = ?
        ORDER BY i.name`,
      [poId]
    );
    const restaurant: any = await centralDb.get(
      `SELECT name, gst_number, upi_id FROM restaurants WHERE id = ?`,
      [restaurantId]
    );
    return {
      po_id: po.id,
      status: po.status,
      raised_at: po.raised_at,
      expected_delivery_date: po.expected_delivery_date,
      notes: po.notes,
      restaurant_name: restaurant?.name || 'Atithi-Setu',
      restaurant_address: null,
      restaurant_phone: null,
      restaurant_email: null,
      restaurant_gstin: restaurant?.gst_number || null,
      supplier_name: po.supplier_name || '',
      supplier_contact_name: po.supplier_contact_name,
      supplier_phone: po.supplier_phone,
      supplier_email: po.supplier_email,
      supplier_address: po.supplier_address,
      supplier_gstin: po.supplier_gstin,
      supplier_lead_time_days: po.supplier_lead_time_days,
      supplier_payment_terms: po.supplier_payment_terms,
      items: items.map((it: any) => {
        const qty = Number(it.qty_ordered);
        const price = Number(it.unit_price);
        const lineTotal = qty * price;
        return {
          ingredient_name: it.ingredient_name || '—',
          qty_ordered: qty,
          unit: it.unit,
          unit_price: price,
          line_total: lineTotal,
          gst_percent: Number(it.gst_percent || 0),
        };
      }),
      total_amount: Number(po.total_amount || 0),
      gst_amount: Number(po.gst_amount || 0),
      grand_total: Number(po.grand_total || 0),
    };
  };

  // Download PO as PDF
  app.get("/api/inventory/purchase-orders/:id/pdf", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId!);
      const data = await hydratePOForPdf(db, req.params.id, req.user!.restaurantId!);
      if (!data) return res.status(404).json({ error: "PO not found" });
      const pdf = await generatePOPdf(data);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${data.po_id}.pdf"`);
      res.send(pdf);
    } catch (err) {
      console.error("PO PDF error:", err);
      res.status(500).json({ error: "Failed to generate PDF" });
    }
  });

  // Email PO to supplier with PDF attachment
  // Body: { to?: string, cc?: string, message?: string }   // overrides supplier.email if 'to' is provided
  app.post("/api/inventory/purchase-orders/:id/email", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId!);
      const data = await hydratePOForPdf(db, req.params.id, req.user!.restaurantId!);
      if (!data) return res.status(404).json({ error: "PO not found" });

      const recipient = String(req.body?.to || data.supplier_email || '').trim();
      if (!recipient) {
        return res.status(400).json({ error: "No recipient — supplier has no email on file. Provide 'to' in the request body." });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
        return res.status(400).json({ error: "Invalid email address" });
      }

      const pdf = await generatePOPdf(data);
      const { subject, text, html } = buildPOEmailBody(data);
      const customMsg = String(req.body?.message || '').trim();
      const finalText = customMsg ? `${customMsg}\n\n${text}` : text;
      const finalHtml = customMsg
        ? `<p style="white-space:pre-line;color:#1a1208">${customMsg}</p><hr style="border:none;border-top:1px solid #e5d3c3"/>${html}`
        : html;

      // Reuse existing sendEmail with attachment via dynamic import (matches
      // existing notification-service usage pattern)
      const { sendEmail } = await import('./notificationService.ts');
      await sendEmail(recipient, subject, finalText, finalHtml, [{
        filename: `${data.po_id}.pdf`,
        content: pdf,
        contentType: 'application/pdf',
      }]);

      res.json({ success: true, sent_to: recipient });
    } catch (err: any) {
      console.error("PO email error:", err);
      res.status(500).json({ error: "Failed to send PO email", detail: err?.message });
    }
  });

  // Cancel a PO (any non-terminal status → CANCELLED)
  app.post("/api/inventory/purchase-orders/:id/cancel", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const po: any = await db.get("SELECT status FROM purchase_orders WHERE id = ?", [req.params.id]);
      if (!po) return res.status(404).json({ error: "PO not found" });
      if (['RECEIVED', 'CANCELLED'].includes(po.status)) {
        return res.status(409).json({ error: `Cannot cancel a ${po.status} PO` });
      }
      await db.run("UPDATE purchase_orders SET status = 'CANCELLED' WHERE id = ?", [req.params.id]);
      res.json({ success: true, status: 'CANCELLED' });
    } catch (err) {
      res.status(500).json({ error: "Failed to cancel PO" });
    }
  });

  // Hard delete only allowed for DRAFT POs (no GRN linkage yet)
  app.delete("/api/inventory/purchase-orders/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const po: any = await db.get("SELECT status FROM purchase_orders WHERE id = ?", [req.params.id]);
      if (!po) return res.status(404).json({ error: "PO not found" });
      if (po.status !== 'DRAFT') {
        return res.status(409).json({ error: `Cannot delete a ${po.status} PO. Cancel it instead.` });
      }
      await db.run("DELETE FROM purchase_order_items WHERE po_id = ?", [req.params.id]);
      await db.run("DELETE FROM purchase_orders WHERE id = ?", [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete PO" });
    }
  });

  // ─── Goods Receipts (GRN) — physical arrival, increments stock ───────────

  app.get("/api/restaurant/:id/inventory/grn", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const rows = await db.query(
        `SELECT g.*, s.name AS supplier_name,
                COALESCE(SUM(gi.qty_received), 0) AS total_qty,
                COUNT(gi.id) AS line_count
           FROM goods_receipts g
           LEFT JOIN suppliers s ON s.id = g.supplier_id
           LEFT JOIN goods_receipt_items gi ON gi.grn_id = g.id
          GROUP BY g.id, s.name
          ORDER BY g.received_at DESC`
      );
      res.json(rows);
    } catch (err) {
      console.error("List GRN error:", err);
      res.status(500).json({ error: "Failed to fetch goods receipts" });
    }
  });

  app.get("/api/inventory/grn/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const grn: any = await db.get(
        `SELECT g.*, s.name AS supplier_name, s.phone AS supplier_phone
           FROM goods_receipts g
           LEFT JOIN suppliers s ON s.id = g.supplier_id
          WHERE g.id = ?`,
        [req.params.id]
      );
      if (!grn) return res.status(404).json({ error: "GRN not found" });
      const items = await db.query(
        `SELECT gi.*, i.name AS ingredient_name, i.category AS ingredient_category
           FROM goods_receipt_items gi
           LEFT JOIN ingredients i ON i.id = gi.ingredient_id
          WHERE gi.grn_id = ?
          ORDER BY i.name`,
        [req.params.id]
      );
      res.json({ ...grn, items });
    } catch (err) {
      console.error("Get GRN error:", err);
      res.status(500).json({ error: "Failed to fetch GRN" });
    }
  });

  // Create a GRN — the heart of the procurement flow.
  // Body:
  //   { po_id?,                              // optional link to a PO
  //     supplier_id,                         // required (auto-filled from PO)
  //     bill_number?, notes?,
  //     items: [{ ingredient_id, qty_received, unit, unit_price,
  //               batch_number?, expiry_date?, condition? }, …] }
  //
  // For each line item this:
  //   1. Inserts goods_receipt_items
  //   2. UPDATEs ingredients.current_stock_qty (atomic)
  //   3. UPDATEs ingredients.default_unit_price (last-known price)
  //   4. Logs a stock_movements row (movement_type='GRN')
  //   5. If po_id: UPDATEs purchase_order_items.qty_received and is_fully_received
  //
  // After all line items: if linked to a PO, recompute PO status:
  //   • all items fully_received → 'RECEIVED'
  //   • any item received → 'PARTIAL'
  app.post("/api/restaurant/:id/inventory/grn", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { po_id, supplier_id, bill_number, notes, items } = req.body;
      if (!supplier_id && !po_id) {
        return res.status(400).json({ error: "supplier_id or po_id is required" });
      }
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "items array (with at least 1 line) is required" });
      }

      const db = await getTenantDb(req.params.id);

      // If po_id is given, derive supplier_id from PO and validate
      let resolvedSupplierId = supplier_id;
      let po: any = null;
      if (po_id) {
        po = await db.get("SELECT * FROM purchase_orders WHERE id = ?", [po_id]);
        if (!po) return res.status(404).json({ error: "Linked PO not found" });
        if (['CANCELLED'].includes(po.status)) {
          return res.status(409).json({ error: `Cannot receive against a ${po.status} PO` });
        }
        resolvedSupplierId = po.supplier_id;
      }

      // Sequential GRN ID — atomic counter per tenant (GRN-0001, GRN-0002, …)
      const seq = await getNextTenantSequence(db, 'grn');
      const grnId = `GRN-${String(seq).padStart(4, '0')}`;

      let totalAmount = 0;
      const allowedConditions = new Set(['GOOD', 'DAMAGED', 'PARTIAL']);

      // Insert header (totals updated after lines processed)
      await db.run(
        `INSERT INTO goods_receipts
          (id, po_id, supplier_id, received_by_user_id, bill_number, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [grnId, po_id || null, resolvedSupplierId, req.user!.id, bill_number || null, notes || null]
      );

      // Process each line
      for (const it of items) {
        if (!it.ingredient_id || it.qty_received == null) continue;
        const qty = Math.max(0, Number(it.qty_received));
        if (qty <= 0) continue;
        const unitPrice = Math.max(0, Number(it.unit_price || 0));

        const ing: any = await db.get(
          "SELECT id, unit, current_stock_qty FROM ingredients WHERE id = ?",
          [it.ingredient_id]
        );
        if (!ing) continue;

        const condition = allowedConditions.has(String(it.condition || 'GOOD').toUpperCase())
          ? String(it.condition).toUpperCase()
          : 'GOOD';
        const unit = String(it.unit || ing.unit || 'unit').toLowerCase();
        // Convert receipt qty to ingredient stock unit (e.g. supplier ships in g, we stock in kg)
        const stockQty = convertQty(qty, unit, ing.unit);
        if (stockQty == null) {
          console.warn(`[grn] Unit mismatch on ${it.ingredient_id}: receipt=${unit} vs stock=${ing.unit}; skipping line`);
          continue;
        }
        const lineTotal = qty * unitPrice;
        totalAmount += lineTotal;

        // Insert GRN line — keep receipt qty + unit as user entered (for the receipt record)
        await db.run(
          `INSERT INTO goods_receipt_items
            (id, grn_id, ingredient_id, qty_received, unit, unit_price,
             batch_number, expiry_date, condition)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `GRI-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            grnId, it.ingredient_id, qty, unit, unitPrice,
            it.batch_number || null, it.expiry_date || null, condition,
          ]
        );

        // Atomic stock increment using converted qty (in stock unit)
        const updated: any[] = await db.query(
          `UPDATE ingredients
              SET current_stock_qty = current_stock_qty + ?,
                  default_unit_price = COALESCE(?, default_unit_price),
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          RETURNING current_stock_qty`,
          [stockQty, unitPrice > 0 ? unitPrice : null, it.ingredient_id]
        );
        const newBalance = Number(updated[0]?.current_stock_qty ?? ing.current_stock_qty + stockQty);

        // Audit log — store the converted qty in the ingredient's natural unit
        await db.run(
          `INSERT INTO stock_movements
            (id, ingredient_id, qty_delta, unit, movement_type, reference_type, reference_id,
             balance_after, unit_cost, recorded_by_user_id, notes)
           VALUES (?, ?, ?, ?, 'GRN', 'grn', ?, ?, ?, ?, ?)`,
          [
            `MOV-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            it.ingredient_id, stockQty, ing.unit, grnId,
            newBalance, unitPrice || null, req.user!.id,
            condition !== 'GOOD' ? `Received condition: ${condition}` : null,
          ]
        );

        // Tier-3: supplier price observation — gives the owner a price
        // history per (supplier, ingredient) for trend reporting.
        if (unitPrice > 0 && resolvedSupplierId) {
          await db.run(
            `INSERT INTO supplier_prices
              (id, supplier_id, ingredient_id, unit_price, unit, qty_purchased, source_type, source_id)
             VALUES (?, ?, ?, ?, ?, ?, 'GRN', ?)`,
            [
              `SP-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
              resolvedSupplierId, it.ingredient_id, unitPrice, unit, qty, grnId,
            ]
          ).catch(() => {});
        }

        // Tier-2: stock batch — tracked in stock unit so FIFO consumption draws
        // correctly. Each GRN line creates a batch; deduction picks oldest first.
        await db.run(
          `INSERT INTO stock_batches
            (id, ingredient_id, grn_id, supplier_id, expiry_date, batch_number,
             qty_received, remaining_qty, unit, unit_cost, condition)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `BATCH-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            it.ingredient_id, grnId, resolvedSupplierId,
            it.expiry_date || null, it.batch_number || null,
            stockQty, stockQty, ing.unit, unitPrice || null, condition,
          ]
        ).catch(() => {});

        // If linked to PO, update qty_received on the matching line
        if (po_id) {
          await db.run(
            `UPDATE purchase_order_items
                SET qty_received = qty_received + ?,
                    is_fully_received = CASE
                      WHEN qty_received + ? >= qty_ordered THEN 1 ELSE 0
                    END
              WHERE po_id = ? AND ingredient_id = ?`,
            [qty, qty, po_id, it.ingredient_id]
          );
        }
      }

      // Update GRN total
      await db.run("UPDATE goods_receipts SET total_amount = ? WHERE id = ?", [totalAmount, grnId]);

      // If linked to PO, recompute PO status
      if (po_id) {
        const poItems: any[] = await db.query(
          "SELECT is_fully_received FROM purchase_order_items WHERE po_id = ?",
          [po_id]
        );
        const allReceived = poItems.length > 0 && poItems.every((r: any) => r.is_fully_received === 1);
        const anyReceived = poItems.some((r: any) => r.is_fully_received === 1);
        const newStatus = allReceived ? 'RECEIVED' : (anyReceived ? 'PARTIAL' : po.status);
        if (newStatus !== po.status) {
          await db.run("UPDATE purchase_orders SET status = ? WHERE id = ?", [newStatus, po_id]);
        }
      }

      res.json({ success: true, id: grnId, total_amount: totalAmount });

      // ── Phase 5: re-enable items on platforms when stock crosses back above 0 ──
      // Fire-and-forget: identify ingredients whose stock just crossed from
      // ≤0 to >0 in this GRN, find their menu items, and enqueue
      // AVAILABILITY_PUSH(true) per active channel. Only checks ingredients
      // mentioned in this GRN, so cost is bounded.
      (async () => {
        try {
          const ingIds = (items || []).map((it: any) => it?.ingredient_id).filter(Boolean);
          if (ingIds.length === 0) return;
          const placeholders = ingIds.map(() => '?').join(',');
          // After this GRN, ingredients are >0 (we just incremented). The
          // question is whether they were ≤0 before. We can detect by checking
          // stock_movements for the most recent prior CONSUMPTION/WASTAGE
          // balance — but a simpler proxy: just always enqueue re-enable;
          // it's idempotent on the platform side.
          const affected: any[] = await db.query(
            `SELECT DISTINCT m.id, m.name, m.external_ids
               FROM menu m
               JOIN recipes rcp ON rcp.menu_item_id = m.id
              WHERE rcp.ingredient_id IN (${placeholders})
                AND (rcp.effective_to IS NULL OR rcp.effective_to > NOW())
                AND m.is_available = 1`,
            ingIds
          ).catch(() => [] as any[]);
          if (affected.length === 0) return;
          const activeChannels: any[] = await db.query(
            "SELECT channel FROM channel_settings WHERE is_active = 1"
          ).catch(() => [] as any[]);
          for (const cr of activeChannels) {
            const ch = String(cr.channel) as ChannelId;
            const pushItems = affected.map((m: any) => {
              let extIds = m.external_ids;
              if (typeof extIds === 'string') { try { extIds = JSON.parse(extIds); } catch { extIds = {}; } }
              return {
                externalItemId: extIds?.[ch],
                isAvailable: true,
              };
            }).filter((it: any) => it.externalItemId);
            if (pushItems.length > 0) {
              await enqueueSyncJob(db, 'AVAILABILITY_PUSH', ch, { items: pushItems });
            }
          }
        } catch (renableErr) {
          console.warn(`[grn] re-enable hook failed for ${grnId}:`, (renableErr as any)?.message);
        }
      })();
    } catch (err) {
      console.error("Create GRN error:", err);
      res.status(500).json({ error: "Failed to create GRN" });
    }
  });

  // Upload bill image for an existing GRN
  app.post("/api/inventory/grn/:id/upload-bill", authenticate, upload.single('bill'), async (req: AuthRequest, res: Response) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded (field name: 'bill')" });
      const db = await getTenantDb(req.user!.restaurantId);
      const billUrl = `/uploads/${req.file.filename}`;
      await db.run("UPDATE goods_receipts SET bill_image_url = ? WHERE id = ?", [billUrl, req.params.id]);
      res.json({ success: true, bill_image_url: billUrl });
    } catch (err) {
      console.error("Upload bill error:", err);
      res.status(500).json({ error: "Failed to upload bill" });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ── Inventory Management — Phase 3: Consumption + Reconciliation ────────
  // ═════════════════════════════════════════════════════════════════════════
  // The consumption side. Auto-deduction on order placement, idempotent
  // reversal on cancellation, explicit wastage logging, and periodic
  // physical-count reconciliation.

  // Helper: short id for stock_movements / wastage / count rows
  const movId = () => `MOV-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  // Convert a quantity from one unit to another for the same dimension
  // (mass: g↔kg, volume: ml↔l, count: unit/bottle/piece/pack/dozen — same).
  // Returns null when units belong to different dimensions (caller should
  // skip / log) so we never produce a silently wrong stock movement.
  // Recipes commonly use grams/millilitres while ingredients are stocked in
  // kg/l — this fixes the otherwise-catastrophic 1000× over-deduction.
  function convertQty(qty: number, fromUnit: string, toUnit: string): number | null {
    const f = String(fromUnit || '').toLowerCase().trim();
    const t = String(toUnit   || '').toLowerCase().trim();
    if (!f || !t || f === t) return qty;
    // Mass
    if (f === 'g' && t === 'kg') return qty / 1000;
    if (f === 'kg' && t === 'g') return qty * 1000;
    // Volume
    if (f === 'ml' && t === 'l') return qty / 1000;
    if (f === 'l' && t === 'ml') return qty * 1000;
    // Count synonyms — treat as same dimension, no conversion
    const COUNT = new Set(['unit', 'bottle', 'piece', 'pack', 'dozen']);
    if (COUNT.has(f) && COUNT.has(t)) return qty;
    // Mismatched dimensions (e.g. g → l) — refuse, return null
    return null;
  }

  // Auto-deduct ingredients for an order based on its items + recipes.
  // Fire-and-forget from the order POST handler — must NEVER throw to caller.
  // Idempotent: each call performs the deduction once. The caller passes the
  // raw items array (already JSON-stringified into the order row).
  // Items shape: [{ id?: string, name?: string, quantity: number, size?: 'HALF'|'FULL', ... }]
  async function deductIngredientsForOrder(
    db: DbInterface, orderId: string, items: any[], _restaurantId: string
  ): Promise<void> {
    if (!Array.isArray(items) || items.length === 0) return;
    for (const it of items) {
      const menuItemId = it?.id || it?.menu_item_id;
      if (!menuItemId) continue;
      const sizeKey = String(it?.size || 'FULL').toUpperCase();
      const qty = Number(it?.quantity || 1);
      if (!Number.isFinite(qty) || qty <= 0) continue;

      // Fetch recipe rows applying to this item — both BOTH and the specific size
      // JOIN with ingredients to get the canonical stock unit so we can convert
      // recipe units (often g/ml) to stock units (often kg/l) before deducting.
      // Tier-2: respect recipe versioning. We pick the row whose effective
      // window covers NOW(). NULL effective_from = "valid since beginning",
      // NULL effective_to = "still valid". DISTINCT ON (ingredient_id, size_variant)
      // returns the most recent row per ingredient that's currently valid.
      const recipeRows: any[] = await db.query(
        `SELECT DISTINCT ON (r.ingredient_id, r.size_variant)
                r.ingredient_id, r.qty_per_serving, r.unit AS recipe_unit,
                i.unit AS ingredient_unit, i.name AS ingredient_name
           FROM recipes r
           JOIN ingredients i ON i.id = r.ingredient_id
          WHERE r.menu_item_id = ?
            AND (r.size_variant = 'BOTH' OR r.size_variant = ?)
            AND (r.effective_from IS NULL OR r.effective_from <= NOW())
            AND (r.effective_to   IS NULL OR r.effective_to   >  NOW())
          ORDER BY r.ingredient_id, r.size_variant,
                   COALESCE(r.effective_from, r.created_at) DESC`,
        [menuItemId, sizeKey === 'HALF' ? 'HALF' : 'FULL']
      ).catch(() => [] as any[]);

      for (const r of recipeRows) {
        const rawConsumed = Number(r.qty_per_serving) * qty;
        if (!Number.isFinite(rawConsumed) || rawConsumed <= 0) continue;
        // Convert from recipe unit (e.g. 'g') to ingredient stock unit (e.g. 'kg')
        const consumed = convertQty(rawConsumed, r.recipe_unit, r.ingredient_unit);
        if (consumed == null) {
          console.warn(`[inventory] Unit mismatch deducting ${r.ingredient_name}: recipe=${r.recipe_unit} vs ingredient=${r.ingredient_unit}; skipping`);
          continue;
        }
        // Atomic decrement; RETURNING gives the new balance for the audit row
        const updated: any[] = await db.query(
          `UPDATE ingredients
              SET current_stock_qty = current_stock_qty - ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          RETURNING current_stock_qty, unit`,
          [consumed, r.ingredient_id]
        ).catch(() => [] as any[]);
        if (!updated[0]) continue;
        const balanceAfter = Number(updated[0].current_stock_qty);
        const unit = String(updated[0].unit || r.ingredient_unit || 'unit');
        // Append to audit log — store the converted (stock-unit) qty so the audit
        // matches the ingredient's natural unit and reversal works correctly.
        await db.run(
          `INSERT INTO stock_movements
            (id, ingredient_id, qty_delta, unit, movement_type, reference_type, reference_id, balance_after)
           VALUES (?, ?, ?, ?, 'CONSUMPTION', 'order', ?, ?)`,
          [movId(), r.ingredient_id, -consumed, unit, orderId, balanceAfter]
        ).catch(() => {});

        // Tier-2: FIFO batch decrement — draw `consumed` qty from oldest
        // non-empty batches first. Expiring batches (≤7 days) jump the queue
        // so we burn through them before they spoil. Best-effort: failures
        // here don't block the order or invalidate the audit row above.
        try {
          let toDraw = consumed;
          const batches: any[] = await db.query(
            `SELECT id, remaining_qty FROM stock_batches
              WHERE ingredient_id = ? AND remaining_qty > 0
              ORDER BY
                CASE WHEN expiry_date IS NOT NULL AND expiry_date <= CURRENT_DATE + INTERVAL '7 days' THEN 0 ELSE 1 END,
                COALESCE(expiry_date, '2099-12-31'::date) ASC,
                received_at ASC`,
            [r.ingredient_id]
          ).catch(() => [] as any[]);
          for (const b of batches) {
            if (toDraw <= 0) break;
            const drawn = Math.min(Number(b.remaining_qty), toDraw);
            await db.run(
              `UPDATE stock_batches SET remaining_qty = remaining_qty - ? WHERE id = ?`,
              [drawn, b.id]
            ).catch(() => {});
            toDraw -= drawn;
          }
        } catch { /* swallow — non-fatal */ }
      }
    }
  }

  // Reverse a previously-deducted order. Idempotent via orders.inventory_reverted
  // flag — re-cancelling does nothing. Walks stock_movements (the source of
  // truth) rather than re-deriving from recipes, because recipes may have
  // changed since the order was placed.
  async function revertIngredientsForOrder(
    db: DbInterface, orderId: string
  ): Promise<{ reverted: boolean; lines: number }> {
    // Guard: only revert once per order
    const order: any = await db.get(
      `SELECT inventory_reverted FROM orders WHERE id = ?`,
      [orderId]
    ).catch(() => null);
    if (!order) return { reverted: false, lines: 0 };
    if (Number(order.inventory_reverted || 0) === 1) return { reverted: false, lines: 0 };

    const consumed: any[] = await db.query(
      `SELECT ingredient_id, qty_delta, unit
         FROM stock_movements
        WHERE reference_type = 'order'
          AND reference_id = ?
          AND movement_type = 'CONSUMPTION'`,
      [orderId]
    ).catch(() => [] as any[]);

    let lines = 0;
    for (const c of consumed) {
      const qtyToReturn = -Number(c.qty_delta);  // qty_delta was negative; flip sign
      if (!Number.isFinite(qtyToReturn) || qtyToReturn <= 0) continue;
      const updated: any[] = await db.query(
        `UPDATE ingredients
            SET current_stock_qty = current_stock_qty + ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        RETURNING current_stock_qty`,
        [qtyToReturn, c.ingredient_id]
      ).catch(() => [] as any[]);
      if (!updated[0]) continue;
      const balanceAfter = Number(updated[0].current_stock_qty);
      await db.run(
        `INSERT INTO stock_movements
          (id, ingredient_id, qty_delta, unit, movement_type, reference_type, reference_id, balance_after, notes)
         VALUES (?, ?, ?, ?, 'REVERSAL', 'order', ?, ?, 'Order cancellation reversal')`,
        [movId(), c.ingredient_id, qtyToReturn, c.unit, orderId, balanceAfter]
      ).catch(() => {});
      lines++;
    }

    // Mark reverted so a second cancel doesn't double-credit
    await db.run("UPDATE orders SET inventory_reverted = 1 WHERE id = ?", [orderId]).catch(() => {});
    return { reverted: true, lines };
  }

  // ─── Wastage logs ────────────────────────────────────────────────────────

  app.get("/api/restaurant/:id/inventory/wastage", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const rows = await db.query(
        `SELECT w.*, i.name AS ingredient_name, i.category AS ingredient_category
           FROM wastage_logs w
           LEFT JOIN ingredients i ON i.id = w.ingredient_id
          ORDER BY w.logged_at DESC`
      );
      res.json(rows);
    } catch (err) {
      console.error("List wastage error:", err);
      res.status(500).json({ error: "Failed to fetch wastage" });
    }
  });

  // Log wastage. Atomically: insert the log row, decrement stock, append audit.
  app.post("/api/restaurant/:id/inventory/wastage", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { ingredient_id, qty, unit, reason, notes } = req.body;
      if (!ingredient_id || qty == null) {
        return res.status(400).json({ error: "ingredient_id and qty are required" });
      }
      const allowedReasons = new Set(['SPOILAGE', 'BURN', 'DROPPED', 'EXPIRY', 'OTHER']);
      const safeReason = allowedReasons.has(String(reason || '').toUpperCase())
        ? String(reason).toUpperCase()
        : 'OTHER';
      const wQty = Math.max(0, Number(qty));
      if (wQty <= 0) return res.status(400).json({ error: "qty must be > 0" });

      const db = await getTenantDb(req.params.id);
      const ing: any = await db.get("SELECT id, unit FROM ingredients WHERE id = ?", [ingredient_id]);
      if (!ing) return res.status(404).json({ error: "Ingredient not found" });
      const wUnit = String(unit || ing.unit || 'unit').toLowerCase();
      // Convert wastage qty (in user's unit) to ingredient stock unit
      const stockQty = convertQty(wQty, wUnit, ing.unit);
      if (stockQty == null) {
        return res.status(400).json({ error: `Unit ${wUnit} can't be converted to ingredient unit ${ing.unit}` });
      }

      const wid = `WAS-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await db.run(
        `INSERT INTO wastage_logs (id, ingredient_id, qty, unit, reason, notes, logged_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [wid, ingredient_id, wQty, wUnit, safeReason, notes || null, req.user!.id || null]
      );

      // Atomic stock decrement + audit (using converted qty in stock unit)
      const updated: any[] = await db.query(
        `UPDATE ingredients SET current_stock_qty = current_stock_qty - ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? RETURNING current_stock_qty`,
        [stockQty, ingredient_id]
      );
      const balanceAfter = Number(updated[0]?.current_stock_qty || 0);
      await db.run(
        `INSERT INTO stock_movements
          (id, ingredient_id, qty_delta, unit, movement_type, reference_type, reference_id, balance_after, recorded_by_user_id, notes)
         VALUES (?, ?, ?, ?, 'WASTAGE', 'wastage', ?, ?, ?, ?)`,
        [movId(), ingredient_id, -stockQty, ing.unit, wid, balanceAfter, req.user!.id || null, `${safeReason}${notes ? ': ' + notes : ''}`]
      );

      res.json({ success: true, id: wid, balance: balanceAfter });
    } catch (err) {
      console.error("Create wastage error:", err);
      res.status(500).json({ error: "Failed to log wastage" });
    }
  });

  // ─── Physical Counts — periodic stock-audit reconciliation ───────────────

  app.get("/api/restaurant/:id/inventory/counts", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const rows = await db.query(
        `SELECT pc.*,
                COUNT(pci.id) AS line_count,
                COALESCE(SUM(CASE WHEN pci.actual_qty IS NOT NULL THEN 1 ELSE 0 END), 0) AS counted_lines,
                COALESCE(SUM(ABS(COALESCE(pci.variance, 0))), 0) AS total_abs_variance
           FROM physical_counts pc
           LEFT JOIN physical_count_items pci ON pci.count_id = pc.id
          GROUP BY pc.id
          ORDER BY pc.created_at DESC`
      );
      res.json(rows);
    } catch (err) {
      console.error("List counts error:", err);
      res.status(500).json({ error: "Failed to fetch counts" });
    }
  });

  app.get("/api/inventory/counts/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId!);
      const count: any = await db.get("SELECT * FROM physical_counts WHERE id = ?", [req.params.id]);
      if (!count) return res.status(404).json({ error: "Count not found" });
      const items = await db.query(
        `SELECT pci.*, i.name AS ingredient_name, i.category AS ingredient_category
           FROM physical_count_items pci
           LEFT JOIN ingredients i ON i.id = pci.ingredient_id
          WHERE pci.count_id = ?
          ORDER BY i.category, i.name`,
        [req.params.id]
      );
      res.json({ ...count, items });
    } catch (err) {
      console.error("Get count error:", err);
      res.status(500).json({ error: "Failed to fetch count" });
    }
  });

  // Start a new count. Snapshots current ingredient stock as expected_qty per
  // line — owner then walks the kitchen and fills in actual_qty as they count.
  app.post("/api/restaurant/:id/inventory/counts", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { count_date, notes } = req.body;
      const db = await getTenantDb(req.params.id);
      const seq = await getNextTenantSequence(db, 'count');
      const countId = `COUNT-${String(seq).padStart(4, '0')}`;
      const today = (count_date && /^\d{4}-\d{2}-\d{2}$/.test(count_date)) ? count_date : new Date().toISOString().slice(0, 10);

      await db.run(
        `INSERT INTO physical_counts (id, count_date, status, counted_by_user_id, notes)
         VALUES (?, ?, 'IN_PROGRESS', ?, ?)`,
        [countId, today, req.user!.id || null, notes || null]
      );

      // Snapshot every active ingredient
      const ingredients: any[] = await db.query(
        "SELECT id, current_stock_qty, unit FROM ingredients WHERE is_active = 1 ORDER BY name"
      );
      for (const ing of ingredients) {
        await db.run(
          `INSERT INTO physical_count_items (id, count_id, ingredient_id, expected_qty, actual_qty, unit)
           VALUES (?, ?, ?, ?, NULL, ?)`,
          [
            `PCI-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            countId, ing.id, Number(ing.current_stock_qty || 0), ing.unit,
          ]
        );
      }
      res.json({ success: true, id: countId, line_count: ingredients.length });
    } catch (err) {
      console.error("Start count error:", err);
      res.status(500).json({ error: "Failed to start count" });
    }
  });

  // Update one or more line items during the count.
  // Body: { items: [{ id, actual_qty }, ...] }
  app.patch("/api/inventory/counts/:id/items", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { items } = req.body;
      if (!Array.isArray(items)) return res.status(400).json({ error: "items array required" });
      const db = await getTenantDb(req.user!.restaurantId!);
      const count: any = await db.get("SELECT status FROM physical_counts WHERE id = ?", [req.params.id]);
      if (!count) return res.status(404).json({ error: "Count not found" });
      if (count.status !== 'IN_PROGRESS') {
        return res.status(409).json({ error: `Count is ${count.status} — can't edit line items` });
      }
      let updated = 0;
      for (const it of items) {
        if (!it.id) continue;
        const actual = it.actual_qty == null ? null : Number(it.actual_qty);
        // Recompute variance = actual - expected
        const row: any = await db.get("SELECT expected_qty FROM physical_count_items WHERE id = ?", [it.id]);
        if (!row) continue;
        const variance = actual == null ? null : actual - Number(row.expected_qty || 0);
        await db.run(
          "UPDATE physical_count_items SET actual_qty = ?, variance = ? WHERE id = ?",
          [actual, variance, it.id]
        );
        updated++;
      }
      res.json({ success: true, updated });
    } catch (err) {
      console.error("Update count items error:", err);
      res.status(500).json({ error: "Failed to update count items" });
    }
  });

  // Complete the count. Reconciles every line where actual_qty was filled —
  // for each non-zero variance, posts a COUNT_ADJUSTMENT movement and brings
  // ingredients.current_stock_qty in line with reality.
  app.post("/api/inventory/counts/:id/complete", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId!);
      const count: any = await db.get("SELECT * FROM physical_counts WHERE id = ?", [req.params.id]);
      if (!count) return res.status(404).json({ error: "Count not found" });
      if (count.status !== 'IN_PROGRESS') {
        return res.status(409).json({ error: `Count already ${count.status}` });
      }
      const items: any[] = await db.query(
        `SELECT * FROM physical_count_items WHERE count_id = ? AND actual_qty IS NOT NULL`,
        [req.params.id]
      );
      let reconciled = 0;
      for (const it of items) {
        const variance = Number(it.variance || 0);
        if (variance === 0) continue;  // no adjustment needed
        // Bring ingredient stock to actual_qty
        const updated: any[] = await db.query(
          `UPDATE ingredients SET current_stock_qty = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? RETURNING current_stock_qty`,
          [Number(it.actual_qty), it.ingredient_id]
        );
        const balanceAfter = Number(updated[0]?.current_stock_qty || it.actual_qty);
        await db.run(
          `INSERT INTO stock_movements
            (id, ingredient_id, qty_delta, unit, movement_type, reference_type, reference_id, balance_after, recorded_by_user_id, notes)
           VALUES (?, ?, ?, ?, 'COUNT_ADJUSTMENT', 'count', ?, ?, ?, ?)`,
          [
            movId(), it.ingredient_id, variance, it.unit,
            req.params.id, balanceAfter, req.user!.id || null,
            `Reconciled from count ${req.params.id}: expected ${it.expected_qty} → actual ${it.actual_qty}`,
          ]
        );
        reconciled++;
      }
      await db.run(
        "UPDATE physical_counts SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
        [req.params.id]
      );
      res.json({ success: true, reconciled });
    } catch (err) {
      console.error("Complete count error:", err);
      res.status(500).json({ error: "Failed to complete count" });
    }
  });

  // Admin cleanup: delete obviously-corrupted CONSUMPTION audit rows. Used
  // after the unit-conversion bug was discovered — old rows logged qty_delta
  // in raw recipe units (g/ml) instead of stock units (kg/l), producing
  // dashboard food-cost-% > 2000 %. Requires owner auth + an explicit
  // threshold so this can't be misused to silently rewrite history.
  // Body: { ingredient_ids?: string[], before_date?: ISO, threshold?: number }
  // ─── Admin: seed synthetic consumption history ──────────────────────────
  // For demos / new tenants — generates backdated CONSUMPTION movements over
  // the last N days with weekday-aware variance and per-ingredient daily rates.
  // Does NOT touch ingredients.current_stock_qty (current stock stays as-is);
  // only writes to stock_movements so the forecast cron has signal to chew on.
  //
  // Body: {
  //   days?: 60,                      // window length (default 60)
  //   ingredients: [{
  //     id: string,
  //     daily_rate: number,           // baseline qty consumed per day (in stock unit)
  //     weekday_factors?: number[],   // length-7 multipliers, [Sun..Sat]
  //     noise?: number                // ±fraction of daily_rate to add as randomness (default 0.15)
  //   }],
  //   wastage_rate?: 0.02,            // fraction of consumption that becomes wastage events
  //   purge_existing?: false,         // if true, deletes synthetic rows tagged with 'seed' first
  // }
  //
  // Idempotent if purge_existing=true: re-running with the same config replaces.
  app.post("/api/restaurant/:id/inventory/admin/seed-consumption-history", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const days = Math.max(7, Math.min(120, Number(req.body?.days || 60)));
      const wastageRate = Math.max(0, Math.min(0.15, Number(req.body?.wastage_rate ?? 0.02)));
      const ingredients: any[] = Array.isArray(req.body?.ingredients) ? req.body.ingredients : [];
      if (ingredients.length === 0) return res.status(400).json({ error: "ingredients[] required" });

      // Optional purge of previously-seeded synthetic rows (tagged via reference_type='seed')
      let purged = 0;
      if (req.body?.purge_existing) {
        const del: any[] = await db.query(
          "DELETE FROM stock_movements WHERE reference_type = 'seed' RETURNING id"
        );
        purged = del.length;
      }

      const reasons = ['SPOILAGE', 'BURN', 'DROPPED', 'EXPIRY'];
      let consumptionRows = 0, wastageRows = 0;

      for (const ingDef of ingredients) {
        if (!ingDef.id || !ingDef.daily_rate) continue;
        const dailyRate = Math.max(0, Number(ingDef.daily_rate));
        if (dailyRate <= 0) continue;
        const noise = Math.max(0, Math.min(0.5, Number(ingDef.noise ?? 0.15)));
        // Default weekday factors: Mon slow, Fri-Sun busy. [Sun, Mon, Tue, Wed, Thu, Fri, Sat]
        const wkFactors: number[] = Array.isArray(ingDef.weekday_factors) && ingDef.weekday_factors.length === 7
          ? ingDef.weekday_factors.map((n: any) => Math.max(0, Number(n) || 0))
          : [1.4, 0.7, 0.85, 0.9, 1.0, 1.3, 1.5];

        // Look up the canonical unit for the audit log
        const ing: any = await db.get("SELECT unit, current_stock_qty FROM ingredients WHERE id = ?", [ingDef.id]);
        if (!ing) continue;
        const unit = String(ing.unit || 'unit');

        // Walk back `days` days from yesterday (skip today — could collide with real activity)
        for (let dayOffset = days; dayOffset >= 1; dayOffset--) {
          const dayDate = new Date(Date.now() - dayOffset * 86400000);
          // Spread 2-4 consumption events across business hours (10:00 → 22:30 IST)
          const eventsToday = 2 + Math.floor(Math.random() * 3);
          const wd = dayDate.getUTCDay();
          const factor = wkFactors[wd] ?? 1;
          const dayTotal = dailyRate * factor * (1 + (Math.random() * 2 - 1) * noise);
          if (dayTotal <= 0) continue;

          // Distribute the day's consumption across the events with random weights
          const weights = Array.from({ length: eventsToday }, () => 0.5 + Math.random());
          const wsum = weights.reduce((a, b) => a + b, 0);
          for (let e = 0; e < eventsToday; e++) {
            const qty = (dayTotal * weights[e]) / wsum;
            if (qty <= 0) continue;
            // Random business-hour timestamp (10:00–22:30 IST = 04:30–17:00 UTC)
            const minutesIntoDay = 270 + Math.floor(Math.random() * (1020 - 270));
            const ts = new Date(dayDate);
            ts.setUTCHours(0, minutesIntoDay, Math.floor(Math.random() * 60), 0);

            // We don't recompute true balance_after for synthetic rows — leave 0 to
            // make it visually obvious in the audit log that these are synthetic.
            // Forecast logic ignores balance_after; only uses qty_delta + recorded_at.
            await db.run(
              `INSERT INTO stock_movements
                 (id, ingredient_id, qty_delta, unit, movement_type,
                  reference_type, reference_id, balance_after, recorded_at, notes)
               VALUES (?, ?, ?, ?, 'CONSUMPTION', 'seed', ?, 0, ?, 'Synthetic consumption (admin seed)')`,
              [
                `MOV-SEED-${ts.getTime()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
                ingDef.id, -qty, unit, `seed-${dayOffset}d-e${e}`, ts.toISOString(),
              ]
            ).catch(() => {});
            consumptionRows++;

            // Sprinkle wastage at the configured rate
            if (Math.random() < wastageRate) {
              const wQty = qty * (0.05 + Math.random() * 0.20);
              const wId = `WAST-SEED-${ts.getTime()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
              const reason = reasons[Math.floor(Math.random() * reasons.length)];
              await db.run(
                `INSERT INTO wastage_logs (id, ingredient_id, qty, unit, reason, notes, logged_at)
                 VALUES (?, ?, ?, ?, ?, 'Synthetic wastage (admin seed)', ?)`,
                [wId, ingDef.id, wQty, unit, reason, ts.toISOString()]
              ).catch(() => {});
              await db.run(
                `INSERT INTO stock_movements
                   (id, ingredient_id, qty_delta, unit, movement_type,
                    reference_type, reference_id, balance_after, recorded_at, notes)
                 VALUES (?, ?, ?, ?, 'WASTAGE', 'seed', ?, 0, ?, ?)`,
                [
                  `MOV-SEED-W-${ts.getTime()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
                  ingDef.id, -wQty, unit, wId, ts.toISOString(), `Synthetic wastage: ${reason}`,
                ]
              ).catch(() => {});
              wastageRows++;
            }
          }
        }
      }

      res.json({
        success: true,
        days_seeded: days,
        ingredients_processed: ingredients.length,
        consumption_rows_inserted: consumptionRows,
        wastage_rows_inserted: wastageRows,
        previously_purged: purged,
        next_step: `POST /api/restaurant/${req.params.id}/inventory/forecast/recompute to populate consumption_forecasts`,
      });
    } catch (err) {
      console.error("Seed consumption history error:", err);
      res.status(500).json({ error: "Failed to seed consumption history" });
    }
  });

  app.post("/api/restaurant/:id/inventory/admin/purge-corrupt-movements", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const threshold = Math.max(1, Number(req.body?.threshold || 100));  // |qty_delta| > 100 = absurd for any kg/l ingredient
      const beforeDate: string | null = req.body?.before_date || null;
      const ingredientIds: string[] = Array.isArray(req.body?.ingredient_ids) ? req.body.ingredient_ids : [];

      const conditions: string[] = ["movement_type = 'CONSUMPTION'", "ABS(qty_delta) > ?"];
      const params: any[] = [threshold];
      if (beforeDate) {
        conditions.push("recorded_at < ?");
        params.push(beforeDate);
      }
      if (ingredientIds.length > 0) {
        conditions.push(`ingredient_id = ANY(ARRAY[${ingredientIds.map(() => '?').join(',')}]::text[])`);
        params.push(...ingredientIds);
      }

      // Preview first
      const matched: any[] = await db.query(
        `SELECT id, ingredient_id, qty_delta, unit, recorded_at
           FROM stock_movements
          WHERE ${conditions.join(' AND ')}
          ORDER BY recorded_at DESC
          LIMIT 50`,
        params
      );

      if (req.body?.dry_run) {
        return res.json({ would_delete: matched.length, sample: matched.slice(0, 10) });
      }

      const deleted: any[] = await db.query(
        `DELETE FROM stock_movements
          WHERE ${conditions.join(' AND ')}
          RETURNING id`,
        params
      );
      console.log(`[admin-purge] ${req.params.id} purged ${deleted.length} corrupt CONSUMPTION movements (threshold=${threshold}${beforeDate ? `, before=${beforeDate}` : ''})`);
      res.json({ success: true, deleted: deleted.length });
    } catch (err) {
      console.error("Admin purge error:", err);
      res.status(500).json({ error: "Failed to purge corrupt movements" });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ── Inventory Management — Phase 4: Forecasting + Dashboard ─────────────
  // ═════════════════════════════════════════════════════════════════════════
  // Day-of-week-aware rolling-average forecasts (last 28 days), refreshed
  // nightly. Owner asks "how much paneer will I burn through next Saturday?"
  // and we answer using the real last-4-Saturdays consumption, not a flat
  // 7-day average that under-counts weekends.

  // Compute and persist consumption forecasts for every active ingredient in
  // a tenant. Idempotent — UPSERTs into consumption_forecasts (PK on
  // ingredient_id + horizon). Safe to call mid-day for ad-hoc refresh.
  async function recomputeForecastsForTenant(db: DbInterface): Promise<{ ingredients: number; updated: number }> {
    const ings: any[] = await db.query(
      "SELECT id, current_stock_qty, unit FROM ingredients WHERE is_active = 1"
    );

    let updated = 0;
    for (const ing of ings) {
      // Last 28 days of consumption + wastage (all negative deltas count as
      // "use" toward forecast — we don't distinguish between sold and spoiled
      // when predicting how fast the pantry empties).
      const movements: any[] = await db.query(
        `SELECT qty_delta, recorded_at
           FROM stock_movements
          WHERE ingredient_id = ?
            AND movement_type IN ('CONSUMPTION', 'WASTAGE')
            AND recorded_at >= NOW() - INTERVAL '28 days'`,
        [ing.id]
      ).catch(() => [] as any[]);

      // Sum per calendar date so we have a clean per-day series
      const byDate: Record<string, number> = {};
      for (const m of movements) {
        const date = new Date(m.recorded_at).toISOString().slice(0, 10);
        byDate[date] = (byDate[date] || 0) + Math.abs(Number(m.qty_delta || 0));
      }

      // Group days by weekday (0=Sun … 6=Sat)
      const byWeekday: number[][] = [[], [], [], [], [], [], []];
      for (const [date, qty] of Object.entries(byDate)) {
        const wd = new Date(date).getUTCDay();
        byWeekday[wd].push(qty);
      }
      // Average per weekday — weekday with no data → 0 (will pull down forecast)
      const weekdayAvg = byWeekday.map(arr =>
        arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
      );

      // Tier-2 seasonality factors — multiplicative bumps applied after the
      // raw weekday average. Loaded once per ingredient; lookup is in-memory.
      // Factors with NULL ingredient_id apply to all ingredients (e.g. a
      // restaurant-wide Diwali bump).
      const factors: any[] = await db.query(
        `SELECT type, key, multiplier FROM seasonality_factors
          WHERE is_active = 1
            AND (ingredient_id = ? OR ingredient_id IS NULL)`,
        [ing.id]
      ).catch(() => [] as any[]);
      const seasonalityFor = (d: Date): number => {
        const iso = d.toISOString().slice(0, 10);
        const mmdd = iso.slice(5);
        const wd = String(d.getUTCDay());
        const m = String(d.getUTCMonth() + 1);
        let mult = 1;
        for (const f of factors) {
          const t = String(f.type).toUpperCase();
          const k = String(f.key);
          let hit = false;
          if (t === 'WEEKDAY' && k === wd) hit = true;
          else if (t === 'MONTH' && k === m) hit = true;
          else if (t === 'DATE' && (k === iso || k === mmdd)) hit = true;
          else if (t === 'RANGE' && k.includes('..')) {
            const [lo, hi] = k.split('..');
            if (iso >= lo && iso <= hi) hit = true;
          }
          if (hit) mult *= Number(f.multiplier || 1);
        }
        return mult;
      };

      // Forecasts (in IST — avoid host TZ skew)
      const istNow = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
      const tomorrowIst = new Date(istNow.getTime() + 24 * 60 * 60 * 1000);
      const dailyForecast = weekdayAvg[tomorrowIst.getUTCDay()] * seasonalityFor(tomorrowIst);

      // Weekly = sum of next 7 days' weekday averages × seasonality factor
      let weeklyForecast = 0;
      for (let i = 1; i <= 7; i++) {
        const d = new Date(istNow.getTime() + i * 24 * 60 * 60 * 1000);
        weeklyForecast += weekdayAvg[d.getUTCDay()] * seasonalityFor(d);
      }
      // Monthly = sum of next 30 days
      let monthlyForecast = 0;
      for (let i = 1; i <= 30; i++) {
        const d = new Date(istNow.getTime() + i * 24 * 60 * 60 * 1000);
        monthlyForecast += weekdayAvg[d.getUTCDay()] * seasonalityFor(d);
      }

      // Upsert all three horizons
      for (const [horizon, qty] of [['daily', dailyForecast], ['weekly', weeklyForecast], ['monthly', monthlyForecast]] as const) {
        await db.run(
          `INSERT INTO consumption_forecasts (ingredient_id, horizon, forecast_qty, computed_at)
           VALUES (?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT (ingredient_id, horizon) DO UPDATE
             SET forecast_qty = EXCLUDED.forecast_qty,
                 computed_at = CURRENT_TIMESTAMP`,
          [ing.id, horizon, qty]
        ).catch(() => {});
      }
      updated++;
    }
    return { ingredients: ings.length, updated };
  }

  // Manual recompute trigger — for QA, demos, and after a big bulk-import
  app.post("/api/restaurant/:id/inventory/forecast/recompute", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const r = await recomputeForecastsForTenant(db);
      res.json({ success: true, ...r });
    } catch (err) {
      console.error("Recompute forecast error:", err);
      res.status(500).json({ error: "Failed to recompute forecasts" });
    }
  });

  // ─── Dashboard data endpoint — KPIs + charts + forecast table ────────────
  // Single endpoint to keep the UI fast. Computes:
  //  • KPIs: stock value · below-reorder count · expiring this week · wastage
  //          this month · food-cost % · pending PO value
  //  • Forecast rows: per-ingredient stock + forecast + days-of-cover +
  //    suggested order qty (par_level − stock − on_order_qty)
  //  • Consumption trend: daily aggregates for last 30 days (qty + ₹ value)
  //  • Top consumers: top 10 by 30-day consumption value
  //  • Wastage breakdown: by reason, last 30 days
  //  • Stock status: rows below reorder OR within 3 days of cover
  app.get("/api/restaurant/:id/inventory/dashboard", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const horizon = String(req.query.horizon || 'daily').toLowerCase();
      const validHorizon: 'daily' | 'weekly' | 'monthly' =
        horizon === 'weekly' ? 'weekly' : horizon === 'monthly' ? 'monthly' : 'daily';

      // 1. KPIs
      // Stock value = sum(current_stock_qty × default_unit_price)
      const stockValueRow: any = await db.get(
        `SELECT COALESCE(SUM(current_stock_qty * COALESCE(default_unit_price, 0)), 0) AS v
           FROM ingredients WHERE is_active = 1`
      );
      const belowReorderRow: any = await db.get(
        `SELECT COUNT(*) AS c FROM ingredients
          WHERE is_active = 1 AND reorder_point > 0 AND current_stock_qty <= reorder_point`
      );
      const expiringRow: any = await db.get(
        `SELECT COUNT(DISTINCT ingredient_id) AS c FROM goods_receipt_items
          WHERE expiry_date IS NOT NULL
            AND expiry_date <= CURRENT_DATE + INTERVAL '7 days'
            AND expiry_date >= CURRENT_DATE`
      );
      // Use stock_movements (always in stock unit) instead of wastage_logs
      // (which stores qty in the user-entered unit — would cause 1000× over-
      // count when user logs grams of a kg-stocked ingredient).
      const wastageRow: any = await db.get(
        `SELECT COALESCE(SUM(ABS(sm.qty_delta) * COALESCE(i.default_unit_price, 0)), 0) AS v
           FROM stock_movements sm
           LEFT JOIN ingredients i ON i.id = sm.ingredient_id
          WHERE sm.movement_type = 'WASTAGE'
            AND sm.recorded_at >= NOW() - INTERVAL '30 days'`
      );
      const consumedValueRow: any = await db.get(
        `SELECT COALESCE(SUM(ABS(sm.qty_delta) * COALESCE(i.default_unit_price, 0)), 0) AS v
           FROM stock_movements sm
           LEFT JOIN ingredients i ON i.id = sm.ingredient_id
          WHERE sm.movement_type = 'CONSUMPTION'
            AND sm.recorded_at >= DATE_TRUNC('month', CURRENT_DATE)`
      );
      const revenueRow: any = await db.get(
        `SELECT COALESCE(SUM(total_amount), 0) AS v FROM orders
          WHERE status != 'CANCELLED'
            AND created_at >= DATE_TRUNC('month', CURRENT_DATE)`
      );
      const pendingPORow: any = await db.get(
        `SELECT COALESCE(SUM(grand_total), 0) AS v FROM purchase_orders
          WHERE status IN ('SENT', 'PARTIAL')`
      );

      const foodCostPct = Number(revenueRow.v) > 0
        ? Math.round((Number(consumedValueRow.v) / Number(revenueRow.v)) * 1000) / 10
        : 0;

      // 2. Forecast rows for the table
      // on_order_qty: outstanding qty per ingredient from open POs (must be in
      // ingredient unit — the qty_ordered is in the user-entered PO unit which
      // may differ; we'll best-effort by trusting the unit field is the same
      // as the ingredient's stock unit, which is the common case)
      const forecastRows: any[] = await db.query(
        `SELECT i.id, i.name, i.unit, i.current_stock_qty, i.reorder_point, i.par_level,
                i.default_unit_price, i.default_supplier_id, i.category,
                COALESCE(f.forecast_qty, 0) AS forecast_qty,
                COALESCE((
                  SELECT SUM(poi.qty_ordered - poi.qty_received)
                    FROM purchase_order_items poi
                    JOIN purchase_orders po ON po.id = poi.po_id
                   WHERE poi.ingredient_id = i.id
                     AND po.status IN ('SENT', 'PARTIAL')
                     AND poi.is_fully_received = 0
                ), 0) AS on_order_qty,
                s.name AS supplier_name, s.lead_time_days
           FROM ingredients i
           LEFT JOIN consumption_forecasts f
             ON f.ingredient_id = i.id AND f.horizon = ?
           LEFT JOIN suppliers s ON s.id = i.default_supplier_id
          WHERE i.is_active = 1
          ORDER BY i.category, i.name`,
        [validHorizon]
      );

      // Use daily forecast for days-of-cover (always — even when toggle is W/M)
      const dailyMap: Record<string, number> = {};
      const dailyRows: any[] = await db.query(
        "SELECT ingredient_id, forecast_qty FROM consumption_forecasts WHERE horizon = 'daily'"
      );
      dailyRows.forEach((r: any) => { dailyMap[r.ingredient_id] = Number(r.forecast_qty || 0); });

      const forecast = forecastRows.map((r: any) => {
        const stock = Number(r.current_stock_qty || 0);
        const dailyF = dailyMap[r.id] || 0;
        const daysOfCover = dailyF > 0 ? stock / dailyF : null;  // null = ∞ display
        const par = Number(r.par_level || 0);
        const onOrder = Number(r.on_order_qty || 0);
        const suggested = Math.max(0, par - stock - onOrder);
        return {
          ingredient_id: r.id,
          ingredient_name: r.name,
          category: r.category,
          unit: r.unit,
          current_stock_qty: stock,
          reorder_point: Number(r.reorder_point || 0),
          par_level: par,
          forecast_qty: Number(r.forecast_qty || 0),
          on_order_qty: onOrder,
          days_of_cover: daysOfCover,
          suggested_order_qty: suggested,
          default_supplier_id: r.default_supplier_id,
          default_supplier_name: r.supplier_name,
          lead_time_days: r.lead_time_days,
          last_unit_price: Number(r.default_unit_price || 0),
        };
      });

      // 3. Consumption trend — last 30 days, aggregated daily
      const trendRows: any[] = await db.query(
        `SELECT DATE_TRUNC('day', sm.recorded_at)::date AS d,
                SUM(ABS(sm.qty_delta)) AS qty,
                SUM(ABS(sm.qty_delta) * COALESCE(i.default_unit_price, 0)) AS cost
           FROM stock_movements sm
           LEFT JOIN ingredients i ON i.id = sm.ingredient_id
          WHERE sm.movement_type IN ('CONSUMPTION', 'WASTAGE')
            AND sm.recorded_at >= NOW() - INTERVAL '30 days'
          GROUP BY DATE_TRUNC('day', sm.recorded_at)
          ORDER BY d ASC`
      );

      // 4. Top consumers (last 30 days by cost)
      const topConsumers: any[] = await db.query(
        `SELECT i.id, i.name, i.unit, i.category,
                SUM(ABS(sm.qty_delta)) AS total_qty,
                SUM(ABS(sm.qty_delta) * COALESCE(i.default_unit_price, 0)) AS total_cost
           FROM stock_movements sm
           JOIN ingredients i ON i.id = sm.ingredient_id
          WHERE sm.movement_type = 'CONSUMPTION'
            AND sm.recorded_at >= NOW() - INTERVAL '30 days'
          GROUP BY i.id, i.name, i.unit, i.category
          ORDER BY total_cost DESC
          LIMIT 10`
      );

      // 5. Wastage breakdown by reason (last 30 days) — JOIN stock_movements
      // (always in stock unit) for accurate qty × price computation. The
      // reason lives on wastage_logs, linked via reference_id on the audit row.
      const wastageBreakdown: any[] = await db.query(
        `SELECT w.reason,
                COUNT(*) AS count,
                COALESCE(SUM(ABS(sm.qty_delta) * COALESCE(i.default_unit_price, 0)), 0) AS total_value
           FROM wastage_logs w
           LEFT JOIN stock_movements sm
             ON sm.reference_type = 'wastage' AND sm.reference_id = w.id
           LEFT JOIN ingredients i ON i.id = w.ingredient_id
          WHERE w.logged_at >= NOW() - INTERVAL '30 days'
          GROUP BY w.reason
          ORDER BY total_value DESC`
      );

      // 6. Stock status — items in trouble (below reorder OR <3 days cover)
      const stockStatus = forecast
        .filter(r => r.days_of_cover !== null && (r.days_of_cover < 3 || r.current_stock_qty <= r.reorder_point))
        .sort((a, b) => (a.days_of_cover || 999) - (b.days_of_cover || 999));

      res.json({
        kpis: {
          total_stock_value: Number(stockValueRow.v) || 0,
          items_below_reorder: Number(belowReorderRow.c) || 0,
          items_expiring_this_week: Number(expiringRow.c) || 0,
          wastage_value_30d: Number(wastageRow.v) || 0,
          food_cost_pct: foodCostPct,
          pending_po_value: Number(pendingPORow.v) || 0,
          revenue_this_month: Number(revenueRow.v) || 0,
          consumed_value_this_month: Number(consumedValueRow.v) || 0,
        },
        forecast,
        consumption_trend: trendRows.map((r: any) => ({
          date: typeof r.d === 'string' ? r.d : new Date(r.d).toISOString().slice(0, 10),
          qty: Number(r.qty),
          cost: Number(r.cost),
        })),
        top_consumers: topConsumers.map((r: any) => ({
          ingredient_id: r.id, ingredient_name: r.name, category: r.category, unit: r.unit,
          total_qty: Number(r.total_qty), total_cost: Number(r.total_cost),
        })),
        wastage_breakdown: wastageBreakdown.map((r: any) => ({
          reason: r.reason, count: Number(r.count), total_value: Number(r.total_value || 0),
        })),
        stock_status: stockStatus,
        horizon: validHorizon,
      });
    } catch (err) {
      console.error("Inventory dashboard error:", err);
      res.status(500).json({ error: "Failed to fetch inventory dashboard" });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ── Inventory Tier-2 / Tier-3 endpoints (2026-05 cycle) ─────────────────
  // ═════════════════════════════════════════════════════════════════════════

  // ─── Stock Movement Audit Log feed ──────────────────────────────────────
  // Append-only stream of every stock change. Filterable by ingredient, type,
  // date range. Joins ingredient name + recorded-by user for display.
  app.get("/api/restaurant/:id/inventory/audit-log", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const { ingredient_id, type, from, to, limit } = req.query as any;
      const lim = Math.max(1, Math.min(1000, Number(limit) || 200));

      const conds: string[] = [];
      const params: any[] = [];
      if (ingredient_id) { conds.push("sm.ingredient_id = ?"); params.push(String(ingredient_id)); }
      if (type) { conds.push("sm.movement_type = ?"); params.push(String(type).toUpperCase()); }
      if (from) { conds.push("sm.recorded_at >= ?"); params.push(String(from)); }
      if (to) { conds.push("sm.recorded_at < ?::timestamp + INTERVAL '1 day'"); params.push(String(to)); }
      const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      const rows: any[] = await db.query(
        `SELECT sm.id, sm.ingredient_id, sm.qty_delta, sm.unit, sm.movement_type,
                sm.reference_type, sm.reference_id, sm.balance_after, sm.unit_cost,
                sm.recorded_at, sm.recorded_by_user_id, sm.notes,
                i.name AS ingredient_name, i.category AS ingredient_category
           FROM stock_movements sm
           LEFT JOIN ingredients i ON i.id = sm.ingredient_id
           ${whereSql}
          ORDER BY sm.recorded_at DESC, sm.id DESC
          LIMIT ${lim}`,
        params
      );
      res.json(rows.map(r => ({
        ...r,
        qty_delta: Number(r.qty_delta),
        balance_after: Number(r.balance_after),
        unit_cost: r.unit_cost == null ? null : Number(r.unit_cost),
      })));
    } catch (err) {
      console.error("Audit log error:", err);
      res.status(500).json({ error: "Failed to fetch audit log" });
    }
  });

  // ─── Variance Report ────────────────────────────────────────────────────
  // Aggregates physical-count variances over a date range. Each completed
  // count contributes per-ingredient (expected − actual) deltas. We monetise
  // them at the ingredient's last-known unit price for a shrinkage estimate.
  app.get("/api/restaurant/:id/inventory/variance-report", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const { from, to } = req.query as any;
      const fromDate = from || '1970-01-01';
      const toDate = to || '2099-12-31';

      const rows: any[] = await db.query(
        `SELECT pci.ingredient_id, i.name AS ingredient_name, i.category, i.unit,
                COALESCE(SUM(pci.variance), 0) AS total_variance,
                COUNT(*) AS counts,
                MAX(pc.count_date) AS last_count_date,
                COALESCE(i.default_unit_price, 0) AS unit_price,
                COALESCE(SUM(pci.variance) * COALESCE(i.default_unit_price, 0), 0) AS variance_value
           FROM physical_count_items pci
           JOIN physical_counts pc ON pc.id = pci.count_id
           LEFT JOIN ingredients i ON i.id = pci.ingredient_id
          WHERE pc.status = 'COMPLETED'
            AND pc.count_date BETWEEN ?::date AND ?::date
            AND pci.actual_qty IS NOT NULL
          GROUP BY pci.ingredient_id, i.name, i.category, i.unit, i.default_unit_price
          ORDER BY ABS(SUM(pci.variance) * COALESCE(i.default_unit_price, 0)) DESC`,
        [fromDate, toDate]
      );

      const totalShrinkageValue = rows.reduce((s, r) => s + (Number(r.variance_value) < 0 ? Number(r.variance_value) : 0), 0);
      const totalSurplusValue = rows.reduce((s, r) => s + (Number(r.variance_value) > 0 ? Number(r.variance_value) : 0), 0);

      res.json({
        from: fromDate,
        to: toDate,
        rows: rows.map(r => ({
          ingredient_id: r.ingredient_id,
          ingredient_name: r.ingredient_name,
          category: r.category,
          unit: r.unit,
          total_variance: Number(r.total_variance),
          counts: Number(r.counts),
          last_count_date: r.last_count_date,
          unit_price: Number(r.unit_price),
          variance_value: Number(r.variance_value),
        })),
        totals: {
          shrinkage_value: Math.abs(totalShrinkageValue),
          surplus_value: totalSurplusValue,
          net_value: Number(totalShrinkageValue) + Number(totalSurplusValue),
          ingredients: rows.length,
        },
      });
    } catch (err) {
      console.error("Variance report error:", err);
      res.status(500).json({ error: "Failed to fetch variance report" });
    }
  });

  // ─── COGS Report ────────────────────────────────────────────────────────
  // Cost-of-Goods-Sold over a date range, broken down by ingredient + category.
  // CONSUMPTION movements monetised at default_unit_price; revenue from orders.
  app.get("/api/restaurant/:id/inventory/cogs-report", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const { from, to } = req.query as any;
      const fromDate = from || '1970-01-01';
      const toDate = to || '2099-12-31';

      const ingredientRows: any[] = await db.query(
        `SELECT i.id, i.name, i.category, i.unit,
                COALESCE(SUM(ABS(sm.qty_delta)), 0) AS qty,
                COALESCE(SUM(ABS(sm.qty_delta) * COALESCE(i.default_unit_price, 0)), 0) AS cogs
           FROM stock_movements sm
           JOIN ingredients i ON i.id = sm.ingredient_id
          WHERE sm.movement_type = 'CONSUMPTION'
            AND sm.recorded_at >= ?::date
            AND sm.recorded_at < ?::date + INTERVAL '1 day'
          GROUP BY i.id, i.name, i.category, i.unit
          ORDER BY cogs DESC`,
        [fromDate, toDate]
      );
      const wastageRows: any[] = await db.query(
        `SELECT COALESCE(SUM(ABS(sm.qty_delta) * COALESCE(i.default_unit_price, 0)), 0) AS v
           FROM stock_movements sm
           LEFT JOIN ingredients i ON i.id = sm.ingredient_id
          WHERE sm.movement_type = 'WASTAGE'
            AND sm.recorded_at >= ?::date
            AND sm.recorded_at < ?::date + INTERVAL '1 day'`,
        [fromDate, toDate]
      );
      const revenueRow: any = await db.get(
        `SELECT COALESCE(SUM(total_amount), 0) AS v FROM orders
          WHERE status != 'CANCELLED'
            AND created_at >= ?::date
            AND created_at < ?::date + INTERVAL '1 day'`,
        [fromDate, toDate]
      );

      const totalCOGS = ingredientRows.reduce((s, r) => s + Number(r.cogs || 0), 0);
      const totalWastage = Number(wastageRows[0]?.v || 0);
      const revenue = Number(revenueRow?.v || 0);

      // Group by category
      const byCategory: Record<string, { category: string; qty: number; cogs: number; pct: number }> = {};
      ingredientRows.forEach(r => {
        const cat = r.category || 'Uncategorised';
        if (!byCategory[cat]) byCategory[cat] = { category: cat, qty: 0, cogs: 0, pct: 0 };
        byCategory[cat].cogs += Number(r.cogs);
        byCategory[cat].qty += Number(r.qty);
      });
      Object.values(byCategory).forEach(c => {
        c.pct = totalCOGS > 0 ? Math.round((c.cogs / totalCOGS) * 1000) / 10 : 0;
      });

      res.json({
        from: fromDate, to: toDate,
        revenue,
        cogs: totalCOGS,
        wastage_value: totalWastage,
        gross_margin: revenue - totalCOGS,
        gross_margin_pct: revenue > 0 ? Math.round(((revenue - totalCOGS) / revenue) * 1000) / 10 : 0,
        food_cost_pct: revenue > 0 ? Math.round((totalCOGS / revenue) * 1000) / 10 : 0,
        wastage_pct_of_cogs: totalCOGS > 0 ? Math.round((totalWastage / totalCOGS) * 1000) / 10 : 0,
        by_ingredient: ingredientRows.map(r => ({
          ingredient_id: r.id,
          ingredient_name: r.name,
          category: r.category,
          unit: r.unit,
          qty: Number(r.qty),
          cogs: Number(r.cogs),
          pct: totalCOGS > 0 ? Math.round((Number(r.cogs) / totalCOGS) * 1000) / 10 : 0,
        })),
        by_category: Object.values(byCategory).sort((a, b) => b.cogs - a.cogs),
      });
    } catch (err) {
      console.error("COGS report error:", err);
      res.status(500).json({ error: "Failed to fetch COGS report" });
    }
  });

  // ─── Supplier Price History ─────────────────────────────────────────────
  // Returns price observations per (supplier, ingredient) over time.
  // Supports filtering by supplier_id and/or ingredient_id.
  app.get("/api/restaurant/:id/inventory/supplier-prices", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const { supplier_id, ingredient_id, from, to } = req.query as any;
      const conds: string[] = [];
      const params: any[] = [];
      if (supplier_id) { conds.push("sp.supplier_id = ?"); params.push(String(supplier_id)); }
      if (ingredient_id) { conds.push("sp.ingredient_id = ?"); params.push(String(ingredient_id)); }
      if (from) { conds.push("sp.observed_at >= ?"); params.push(String(from)); }
      if (to) { conds.push("sp.observed_at < ?::date + INTERVAL '1 day'"); params.push(String(to)); }
      const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const rows: any[] = await db.query(
        `SELECT sp.*, s.name AS supplier_name, i.name AS ingredient_name, i.unit AS ingredient_unit
           FROM supplier_prices sp
           LEFT JOIN suppliers s ON s.id = sp.supplier_id
           LEFT JOIN ingredients i ON i.id = sp.ingredient_id
           ${whereSql}
          ORDER BY sp.observed_at DESC
          LIMIT 500`,
        params
      );
      res.json(rows.map(r => ({
        ...r,
        unit_price: Number(r.unit_price),
        qty_purchased: r.qty_purchased == null ? null : Number(r.qty_purchased),
      })));
    } catch (err) {
      console.error("Supplier prices error:", err);
      res.status(500).json({ error: "Failed to fetch supplier prices" });
    }
  });

  // Compare current/avg supplier prices for a single ingredient — to spot
  // who's cheapest right now and which supplier hiked recently.
  app.get("/api/restaurant/:id/inventory/supplier-prices/compare/:ingredient_id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const rows: any[] = await db.query(
        `SELECT sp.supplier_id, s.name AS supplier_name,
                MAX(sp.observed_at) AS last_observed_at,
                AVG(sp.unit_price) AS avg_price,
                MIN(sp.unit_price) AS min_price,
                MAX(sp.unit_price) AS max_price,
                COUNT(*) AS observations,
                (SELECT unit_price FROM supplier_prices sp2
                  WHERE sp2.supplier_id = sp.supplier_id
                    AND sp2.ingredient_id = sp.ingredient_id
                  ORDER BY sp2.observed_at DESC LIMIT 1) AS latest_price
           FROM supplier_prices sp
           LEFT JOIN suppliers s ON s.id = sp.supplier_id
          WHERE sp.ingredient_id = ?
          GROUP BY sp.supplier_id, sp.ingredient_id, s.name
          ORDER BY latest_price ASC NULLS LAST`,
        [req.params.ingredient_id]
      );
      res.json(rows.map(r => ({
        ...r,
        avg_price: Number(r.avg_price),
        min_price: Number(r.min_price),
        max_price: Number(r.max_price),
        latest_price: r.latest_price == null ? null : Number(r.latest_price),
        observations: Number(r.observations),
      })));
    } catch (err) {
      console.error("Supplier compare error:", err);
      res.status(500).json({ error: "Failed to compare supplier prices" });
    }
  });

  // ─── Recipe Versioning — history viewer ─────────────────────────────────
  // Returns all recipe rows for a menu item across time (current + retired).
  app.get("/api/restaurant/:id/menu/:menuItemId/recipe-history", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const rows: any[] = await db.query(
        `SELECT r.*, i.name AS ingredient_name, i.unit AS ingredient_unit
           FROM recipes r
           LEFT JOIN ingredients i ON i.id = r.ingredient_id
          WHERE r.menu_item_id = ?
          ORDER BY r.ingredient_id, COALESCE(r.effective_from, r.created_at) ASC`,
        [req.params.menuItemId]
      );
      res.json(rows);
    } catch (err) {
      console.error("Recipe history error:", err);
      res.status(500).json({ error: "Failed to fetch recipe history" });
    }
  });

  // ─── Seasonality Factors CRUD ───────────────────────────────────────────
  app.get("/api/restaurant/:id/inventory/seasonality", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const rows: any[] = await db.query(
        `SELECT sf.*, i.name AS ingredient_name FROM seasonality_factors sf
           LEFT JOIN ingredients i ON i.id = sf.ingredient_id
          WHERE sf.is_active = 1
          ORDER BY sf.type, sf.key, sf.created_at DESC`
      );
      res.json(rows.map(r => ({ ...r, multiplier: Number(r.multiplier) })));
    } catch (err) {
      console.error("Seasonality fetch error:", err);
      res.status(500).json({ error: "Failed to fetch seasonality factors" });
    }
  });

  app.post("/api/restaurant/:id/inventory/seasonality", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { ingredient_id, type, key, multiplier, label } = req.body;
      if (!type || !key || multiplier == null) {
        return res.status(400).json({ error: "type, key, and multiplier are required" });
      }
      const allowed = new Set(['WEEKDAY', 'MONTH', 'DATE', 'RANGE']);
      const t = String(type).toUpperCase();
      if (!allowed.has(t)) return res.status(400).json({ error: "type must be WEEKDAY | MONTH | DATE | RANGE" });
      const m = Math.max(0, Math.min(10, Number(multiplier)));
      const db = await getTenantDb(req.params.id);
      const id = `SF-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await db.run(
        `INSERT INTO seasonality_factors (id, ingredient_id, type, key, multiplier, label)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, ingredient_id || null, t, String(key), m, label || null]
      );
      res.json({ success: true, id });
    } catch (err) {
      console.error("Seasonality create error:", err);
      res.status(500).json({ error: "Failed to create seasonality factor" });
    }
  });

  app.delete("/api/inventory/seasonality/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      await db.run("UPDATE seasonality_factors SET is_active = 0 WHERE id = ?", [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      console.error("Seasonality delete error:", err);
      res.status(500).json({ error: "Failed to delete seasonality factor" });
    }
  });

  // ─── Notification Templates CRUD ────────────────────────────────────────
  app.get("/api/restaurant/:id/notification-templates", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const rows: any[] = await db.query("SELECT * FROM notification_templates ORDER BY event_type");
      res.json(rows);
    } catch (err) {
      console.error("Templates fetch error:", err);
      res.status(500).json({ error: "Failed to fetch notification templates" });
    }
  });

  app.put("/api/restaurant/:id/notification-templates/:event", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { subject_template, body_template, enabled } = req.body;
      const db = await getTenantDb(req.params.id);
      await db.run(
        `INSERT INTO notification_templates (event_type, subject_template, body_template, enabled, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (event_type) DO UPDATE SET
           subject_template = EXCLUDED.subject_template,
           body_template    = EXCLUDED.body_template,
           enabled          = EXCLUDED.enabled,
           updated_at       = CURRENT_TIMESTAMP`,
        [req.params.event, subject_template || null, body_template || null, enabled === false ? 0 : 1]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("Template upsert error:", err);
      res.status(500).json({ error: "Failed to save notification template" });
    }
  });

  // ─── Stock Batches (FIFO traceability) ──────────────────────────────────
  // Returns active batches for an ingredient ordered by FIFO consumption order
  // (oldest received first, but expiring batches jump the queue).
  app.get("/api/restaurant/:id/inventory/batches", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const { ingredient_id, include_empty } = req.query as any;
      const conds: string[] = [];
      const params: any[] = [];
      if (ingredient_id) { conds.push("sb.ingredient_id = ?"); params.push(String(ingredient_id)); }
      if (!include_empty) conds.push("sb.remaining_qty > 0");
      const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const rows: any[] = await db.query(
        `SELECT sb.*, i.name AS ingredient_name, s.name AS supplier_name
           FROM stock_batches sb
           LEFT JOIN ingredients i ON i.id = sb.ingredient_id
           LEFT JOIN suppliers s ON s.id = sb.supplier_id
           ${whereSql}
          ORDER BY
            CASE WHEN sb.expiry_date IS NOT NULL AND sb.expiry_date <= CURRENT_DATE + INTERVAL '7 days' THEN 0 ELSE 1 END,
            COALESCE(sb.expiry_date, '2099-12-31'::date) ASC,
            sb.received_at ASC`,
        params
      );
      res.json(rows.map(r => ({
        ...r,
        qty_received: Number(r.qty_received),
        remaining_qty: Number(r.remaining_qty),
        unit_cost: r.unit_cost == null ? null : Number(r.unit_cost),
      })));
    } catch (err) {
      console.error("Batches error:", err);
      res.status(500).json({ error: "Failed to fetch batches" });
    }
  });

  // ─── Smart PO Batching — multi-supplier preview ─────────────────────────
  // Given a list of ingredient_ids with qty needed (or "below par" as default),
  // groups by default_supplier_id and returns a preview of one PO per supplier.
  app.post("/api/restaurant/:id/inventory/smart-po-preview", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const { ingredient_ids } = req.body as { ingredient_ids?: string[] };
      let rows: any[];
      if (Array.isArray(ingredient_ids) && ingredient_ids.length > 0) {
        const placeholders = ingredient_ids.map(() => '?').join(',');
        rows = await db.query(
          `SELECT i.id, i.name, i.unit, i.current_stock_qty, i.par_level, i.reorder_point,
                  i.default_unit_price, i.default_supplier_id, i.gst_percent,
                  s.name AS supplier_name, s.lead_time_days
             FROM ingredients i
             LEFT JOIN suppliers s ON s.id = i.default_supplier_id
            WHERE i.is_active = 1 AND i.id IN (${placeholders})`,
          ingredient_ids
        );
      } else {
        rows = await db.query(
          `SELECT i.id, i.name, i.unit, i.current_stock_qty, i.par_level, i.reorder_point,
                  i.default_unit_price, i.default_supplier_id, i.gst_percent,
                  s.name AS supplier_name, s.lead_time_days
             FROM ingredients i
             LEFT JOIN suppliers s ON s.id = i.default_supplier_id
            WHERE i.is_active = 1
              AND i.reorder_point > 0
              AND i.current_stock_qty <= i.reorder_point`
        );
      }

      // Group by supplier
      const groups: Record<string, any> = {};
      for (const r of rows) {
        const sid = r.default_supplier_id || '__NO_SUPPLIER__';
        if (!groups[sid]) {
          groups[sid] = {
            supplier_id: sid === '__NO_SUPPLIER__' ? null : sid,
            supplier_name: r.supplier_name || null,
            lead_time_days: r.lead_time_days || null,
            items: [],
            total_amount: 0,
            gst_amount: 0,
            grand_total: 0,
          };
        }
        const par = Number(r.par_level || 0);
        const stock = Number(r.current_stock_qty || 0);
        const reorderQty = Math.max(par - stock, Number(r.reorder_point || 0) * 2 - stock);
        const qty = Math.max(1, Math.round(reorderQty * 100) / 100);
        const price = Number(r.default_unit_price || 0);
        const lineTotal = qty * price;
        const gst = lineTotal * (Number(r.gst_percent || 0) / 100);
        groups[sid].items.push({
          ingredient_id: r.id,
          ingredient_name: r.name,
          unit: r.unit,
          qty_ordered: qty,
          unit_price: price,
          line_total: lineTotal,
          gst_percent: Number(r.gst_percent || 0),
        });
        groups[sid].total_amount += lineTotal;
        groups[sid].gst_amount += gst;
        groups[sid].grand_total += lineTotal + gst;
      }
      res.json({ groups: Object.values(groups) });
    } catch (err) {
      console.error("Smart PO preview error:", err);
      res.status(500).json({ error: "Failed to generate smart PO preview" });
    }
  });

  // ─── Drag-to-reorder ingredients ────────────────────────────────────────
  app.post("/api/restaurant/:id/inventory/ingredients/reorder", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { ordered_ids } = req.body as { ordered_ids: string[] };
      if (!Array.isArray(ordered_ids)) return res.status(400).json({ error: "ordered_ids must be an array" });
      const db = await getTenantDb(req.params.id);
      for (let i = 0; i < ordered_ids.length; i++) {
        await db.run(
          "UPDATE ingredients SET display_order = ? WHERE id = ?",
          [i + 1, ordered_ids[i]]
        );
      }
      res.json({ success: true, count: ordered_ids.length });
    } catch (err) {
      console.error("Reorder error:", err);
      res.status(500).json({ error: "Failed to reorder ingredients" });
    }
  });

  // ─── Hotel Inventory CRUD (linens, mini-bar, amenity restocking) ────────
  app.get("/api/restaurant/:id/hotel-inventory", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const rows: any[] = await db.query(
        "SELECT * FROM hotel_inventory_items WHERE is_active = 1 ORDER BY category NULLS LAST, name"
      );
      res.json(rows);
    } catch (err) {
      console.error("Hotel inventory fetch error:", err);
      res.status(500).json({ error: "Failed to fetch hotel inventory" });
    }
  });

  app.post("/api/restaurant/:id/hotel-inventory", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { name, category, unit, current_stock_qty, par_level, reorder_point, default_unit_price, sku, notes } = req.body;
      if (!name) return res.status(400).json({ error: "name is required" });
      const db = await getTenantDb(req.params.id);
      const id = `HI-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await db.run(
        `INSERT INTO hotel_inventory_items
          (id, name, category, unit, current_stock_qty, par_level, reorder_point, default_unit_price, sku, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, name, category || null, unit || 'unit',
          Number(current_stock_qty || 0), Number(par_level || 0), Number(reorder_point || 0),
          default_unit_price != null ? Number(default_unit_price) : null,
          sku || null, notes || null,
        ]
      );
      res.json({ success: true, id });
    } catch (err) {
      console.error("Hotel inventory create error:", err);
      res.status(500).json({ error: "Failed to create hotel inventory item" });
    }
  });

  app.patch("/api/hotel-inventory/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const allowed = ['name', 'category', 'unit', 'current_stock_qty', 'par_level', 'reorder_point', 'default_unit_price', 'sku', 'notes'];
      const updates: string[] = [];
      const params: any[] = [];
      for (const k of allowed) {
        if (k in req.body) { updates.push(`${k} = ?`); params.push(req.body[k]); }
      }
      if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });
      updates.push("updated_at = CURRENT_TIMESTAMP");
      params.push(req.params.id);
      await db.run(`UPDATE hotel_inventory_items SET ${updates.join(', ')} WHERE id = ?`, params);
      res.json({ success: true });
    } catch (err) {
      console.error("Hotel inventory update error:", err);
      res.status(500).json({ error: "Failed to update hotel inventory item" });
    }
  });

  app.delete("/api/hotel-inventory/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      await db.run("UPDATE hotel_inventory_items SET is_active = 0 WHERE id = ?", [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      console.error("Hotel inventory delete error:", err);
      res.status(500).json({ error: "Failed to delete hotel inventory item" });
    }
  });

  // ─── Storage Locations CRUD (multi-location stock) ──────────────────────
  app.get("/api/restaurant/:id/storage-locations", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const rows: any[] = await db.query(
        "SELECT * FROM storage_locations WHERE is_active = 1 ORDER BY is_default DESC, name"
      );
      res.json(rows);
    } catch (err) {
      console.error("Locations fetch error:", err);
      res.status(500).json({ error: "Failed to fetch storage locations" });
    }
  });

  app.post("/api/restaurant/:id/storage-locations", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { name, kind } = req.body;
      if (!name) return res.status(400).json({ error: "name is required" });
      const db = await getTenantDb(req.params.id);
      const id = `LOC-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await db.run(
        `INSERT INTO storage_locations (id, name, kind, is_default, is_active)
         VALUES (?, ?, ?, 0, 1)`,
        [id, name, kind || 'KITCHEN']
      );
      res.json({ success: true, id });
    } catch (err) {
      console.error("Location create error:", err);
      res.status(500).json({ error: "Failed to create storage location" });
    }
  });

  app.delete("/api/storage-locations/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      if (req.params.id === 'LOC-MAIN') return res.status(400).json({ error: "Cannot delete the default Main location" });
      const db = await getTenantDb(req.user!.restaurantId);
      await db.run("UPDATE storage_locations SET is_active = 0 WHERE id = ?", [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      console.error("Location delete error:", err);
      res.status(500).json({ error: "Failed to delete storage location" });
    }
  });

  // ─── Receipt OCR via Gemini Vision (Tier-3) ─────────────────────────────
  // Accepts a bill image, asks Gemini to extract structured line items, then
  // matches each against the tenant's ingredient catalog by fuzzy name match.
  // Returns suggestions the frontend can drop into the GRN line-items form.
  // Falls back gracefully (returns the saved image + manual-entry hint) when
  // GEMINI_API_KEY isn't configured or the model fails.
  app.post("/api/restaurant/:id/inventory/receipt-ocr", authenticate, upload.single('bill'), async (req: AuthRequest, res: Response) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No bill file uploaded (field: 'bill')" });
      const billUrl = `/uploads/${req.file.filename}`;
      const filePath = path.join(process.cwd(), 'public', 'uploads', req.file.filename);

      const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      if (!GEMINI_API_KEY || GEMINI_API_KEY === 'MY_GEMINI_API_KEY') {
        return res.json({
          success: false,
          bill_image_url: billUrl,
          hint: "GEMINI_API_KEY not configured — manual entry required.",
          suggestions: [],
        });
      }

      // Load the image
      let imageBytes: Buffer;
      try {
        imageBytes = fs.readFileSync(filePath);
      } catch {
        return res.status(500).json({ error: "Saved bill image could not be read" });
      }
      const mimeType = req.file.mimetype || 'image/jpeg';

      // Ask Gemini Vision to extract line items
      const prompt =
        "Extract all line items from this supplier bill / invoice / receipt. " +
        "Return a strict JSON array of objects with these keys: " +
        "name (string), qty (number), unit (string like kg/g/l/ml/unit/bottle), unit_price (number, ₹), line_total (number). " +
        "If the bill has a header total, also include a meta key: " +
        "{ supplier_name, bill_number, bill_date, total_amount }. " +
        "Wrap the entire response in: ```json\n[ ... ]\n```. No preamble, no commentary.";

      let extracted: any[] = [];
      let meta: any = null;
      try {
        const { GoogleGenAI } = await import('@google/genai');
        const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        const visionModels = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
        let raw: string | null = null;
        for (const modelName of visionModels) {
          if (raw) break;
          try {
            const response = await ai.models.generateContent({
              model: modelName,
              contents: [{
                role: 'user',
                parts: [
                  { text: prompt },
                  { inlineData: { mimeType, data: imageBytes.toString('base64') } } as any,
                ],
              }] as any,
            });
            const parts = (response as any).candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              if (part.text) { raw = part.text; break; }
            }
          } catch (modelErr: any) {
            console.warn(`[ocr] ${modelName} failed: ${(modelErr?.message || '').slice(0, 120)}`);
          }
        }
        if (raw) {
          // Strip ```json fences if present
          const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
          const jsonText = jsonMatch ? jsonMatch[1].trim() : raw.trim();
          const parsed = JSON.parse(jsonText);
          if (Array.isArray(parsed)) {
            extracted = parsed;
          } else if (parsed && Array.isArray(parsed.items)) {
            extracted = parsed.items;
            meta = parsed.meta || null;
          }
        }
      } catch (err: any) {
        console.warn(`[ocr] Vision call failed: ${(err?.message || '').slice(0, 150)}`);
      }

      // Match each extracted item against the catalog by fuzzy name
      const db = await getTenantDb(req.params.id);
      const catalog: any[] = await db.query(
        "SELECT id, name, unit, default_unit_price FROM ingredients WHERE is_active = 1"
      );
      const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const suggestions = extracted.map((line: any) => {
        const lineNorm = norm(line.name);
        // Score by token overlap
        let best: any = null, bestScore = 0;
        for (const ing of catalog) {
          const ingNorm = norm(ing.name);
          if (!lineNorm || !ingNorm) continue;
          const lineTokens = new Set(lineNorm.split(' '));
          const ingTokens = ingNorm.split(' ');
          let hits = 0;
          for (const t of ingTokens) if (lineTokens.has(t)) hits++;
          const score = hits / Math.max(1, ingTokens.length);
          if (score > bestScore) { bestScore = score; best = ing; }
        }
        return {
          extracted: {
            name: line.name,
            qty: Number(line.qty) || 0,
            unit: String(line.unit || 'unit').toLowerCase(),
            unit_price: Number(line.unit_price) || 0,
            line_total: Number(line.line_total) || 0,
          },
          match: best && bestScore >= 0.4 ? {
            ingredient_id: best.id,
            ingredient_name: best.name,
            stock_unit: best.unit,
            confidence: Math.round(bestScore * 100),
          } : null,
        };
      });

      res.json({
        success: extracted.length > 0,
        bill_image_url: billUrl,
        meta,
        suggestions,
        line_count: extracted.length,
        matched_count: suggestions.filter((s: any) => s.match).length,
      });
    } catch (err) {
      console.error("Receipt OCR error:", err);
      res.status(500).json({ error: "Failed to process receipt" });
    }
  });

  // ─── Rider-side stock placeholder (Tier-3) ──────────────────────────────
  // Returns the rider's current pouch contents (e.g. spare bottles, packaging
  // they carry). v1 = read-only stub backed by the same ingredient table with
  // a "pouch" location filter; full implementation comes when rider app launches.
  app.get("/api/restaurant/:id/rider-stock/:riderId", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const rows: any[] = await db.query(
        `SELECT ils.*, i.name AS ingredient_name, i.unit
           FROM ingredient_location_stock ils
           LEFT JOIN ingredients i ON i.id = ils.ingredient_id
          WHERE ils.location_id = ?`,
        [`RIDER-${req.params.riderId}`]
      ).catch(() => [] as any[]);
      res.json({ rider_id: req.params.riderId, items: rows });
    } catch (err) {
      console.error("Rider stock error:", err);
      res.status(500).json({ error: "Failed to fetch rider stock" });
    }
  });


  // ── Import Token: SUPER_ADMIN generates a scoped token for any restaurant ──
  // Allows admins to run menu imports without knowing the owner's password.
  // POST /api/auth/import-token  { loginId, password, restaurantId }
  // Returns { token } valid for 24 hours, scoped to the given restaurantId.
  app.post("/api/auth/import-token", async (req: Request, res: Response) => {
    const { loginId, password, restaurantId } = req.body;
    try {
      if (!loginId || !password || !restaurantId) {
        return res.status(400).json({ error: "loginId, password, and restaurantId are required" });
      }
      // Only SUPER_ADMIN or CTO may generate import tokens
      const user = await centralDb.get("SELECT * FROM users WHERE login_id = ?", [loginId]);
      if (!user) return res.status(401).json({ error: "User not found" });
      if (!['SUPER_ADMIN', 'CTO'].includes(user.role)) {
        return res.status(403).json({ error: "Only SUPER_ADMIN or CTO accounts can generate import tokens" });
      }
      if (user.is_active === 0) return res.status(403).json({ error: "Account is deactivated" });
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });

      // Verify the target restaurant exists
      const restaurant = await centralDb.get("SELECT id, name FROM restaurants WHERE id = ?", [restaurantId]);
      if (!restaurant) return res.status(404).json({ error: "Restaurant not found" });

      // Sign a token scoped to that restaurant as OWNER role (enough for menu writes)
      const token = jwt.sign(
        { id: user.id, restaurantId, role: 'OWNER', generatedBy: loginId },
        JWT_SECRET,
        { expiresIn: "24h" }
      );
      res.json({ success: true, token, restaurantId, restaurantName: restaurant.name });
    } catch (err) {
      console.error("Import token error:", err);
      res.status(500).json({ error: "Failed to generate import token" });
    }
  });

  // AI: Generate food image for menu item using Gemini (with fallbacks) — one-time only
  app.post("/api/restaurant/:id/menu/:itemId/generate-image", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { name, category, dietary_type } = req.body;

      // One-time guard: if this item already has an image, return it as-is — never overwrite
      const db = await getTenantDb(req.params.id);
      const existing = await db.get('SELECT image_url FROM menu WHERE id = ?', [req.params.itemId]);
      if (existing?.image_url) {
        console.log(`[AI Image] Skipping — item "${name}" already has image: ${existing.image_url}`);
        return res.json({ success: true, image_url: existing.image_url, cached: true });
      }

      const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

      let imageUrl: string | null = null;
      let quotaExhausted = false;

      // Helper: download an image from a URL (follows redirects, handles relative URLs) and save locally
      const downloadAndSave = async (url: string, prefix: string): Promise<string | null> => {
        const https = await import('https');
        const http = await import('http');
        return new Promise((resolve) => {
          let resolved = false;
          const done = (v: string | null) => { if (!resolved) { resolved = true; resolve(v); } };
          const doGet = (targetUrl: string, baseUrl: string, depth: number) => {
            if (depth > 5) return done(null);
            try {
              // Handle relative redirect URLs by resolving against base
              const fullUrl = targetUrl.startsWith('http') ? targetUrl : new URL(targetUrl, baseUrl).href;
              const mod = fullUrl.startsWith('https') ? https : http;
              mod.get(fullUrl, (imgRes: any) => {
                if (imgRes.statusCode >= 300 && imgRes.statusCode < 400 && imgRes.headers.location) {
                  return doGet(imgRes.headers.location, fullUrl, depth + 1);
                }
                if (imgRes.statusCode !== 200) return done(null);
                const chunks: Buffer[] = [];
                imgRes.on('data', (c: Buffer) => chunks.push(c));
                imgRes.on('end', () => {
                  const data = Buffer.concat(chunks);
                  if (data.length < 2000) return done(null);
                  const ext = (imgRes.headers['content-type'] || '').includes('png') ? 'png' : 'jpg';
                  const filename = `${prefix}_${req.params.itemId}_${Date.now()}.${ext}`;
                  const localPath = path.join(process.cwd(), 'public', 'uploads', filename);
                  fs.writeFileSync(localPath, data);
                  done(`/uploads/${filename}`);
                });
              }).on('error', () => done(null));
            } catch (e) {
              console.warn(`[AI Image] downloadAndSave URL error: ${e}`);
              done(null);
            }
          };
          doGet(url, url, 0);
          setTimeout(() => done(null), 20000);
        });
      };

      // ---------- Strategy 1: Gemini AI Image Generation ----------
      if (GEMINI_API_KEY && GEMINI_API_KEY !== 'MY_GEMINI_API_KEY') {
        const dietLabel = dietary_type === 'NON_VEG' ? 'non-vegetarian' : dietary_type === 'VEGAN' ? 'vegan' : 'vegetarian';
        const catLabel = (category || 'main course').toLowerCase();
        const prompt = [
          `Generate a photorealistic, mouth-watering food photograph of "${name}".`,
          `This is an authentic Indian ${catLabel} dish (${dietLabel}).`,
          `The dish is beautifully plated on traditional Indian restaurant crockery.`,
          `Shot from a 45-degree angle with warm, golden lighting.`,
          `Rich colors, garnished with fresh herbs and spices typical of Indian cuisine.`,
          `Professional food photography, shallow depth of field, no text or watermarks.`,
        ].join(' ');

        // Models verified via ListModels API — try in order of preference
        const imageModels = [
          'gemini-2.5-flash-image',
          'gemini-3.1-flash-image-preview',
          'gemini-3-pro-image-preview',
        ];

        for (const modelName of imageModels) {
          if (imageUrl) break;
          try {
            const { GoogleGenAI } = await import('@google/genai');
            const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
            console.log(`[AI Image] Trying model: ${modelName} for "${name}"`);
            const response = await ai.models.generateContent({
              model: modelName,
              contents: prompt,
              config: { responseModalities: ['TEXT', 'IMAGE'] } as any,
            });
            const parts = (response as any).candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              if (part.inlineData?.data) {
                const buffer = Buffer.from(part.inlineData.data, 'base64');
                const filename = `ai_${req.params.itemId}_${Date.now()}.jpg`;
                const localPath = path.join(process.cwd(), 'public', 'uploads', filename);
                fs.writeFileSync(localPath, buffer);
                imageUrl = `/uploads/${filename}`;
                console.log(`[AI Image] Success with ${modelName} → ${filename}`);
                break;
              }
            }
          } catch (modelErr: any) {
            const errMsg = modelErr?.message || String(modelErr);
            console.warn(`[AI Image] ${modelName} failed: ${errMsg.substring(0, 200)}`);
            if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('quota')) {
              quotaExhausted = true;
            }
          }
        }
      } else {
        console.warn('[AI Image] GEMINI_API_KEY not configured');
      }

      // ---------- Strategy 2: TheMealDB (free, no auth, searches by dish name) ----------
      if (!imageUrl) {
        try {
          console.log(`[AI Image] Trying TheMealDB for: "${name}"`);
          const https = await import('https');
          const mealDbUrl = `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(name)}`;

          const mealData: any = await new Promise((resolve, reject) => {
            https.get(mealDbUrl, { headers: { 'User-Agent': 'AtithiSetu/1.0' } }, (pRes: any) => {
              let body = '';
              pRes.on('data', (c: string) => body += c);
              pRes.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('MealDB parse error')); } });
            }).on('error', reject);
            setTimeout(() => reject(new Error('MealDB timeout')), 10000);
          });

          // Try exact match first, then first result
          const meals: any[] = mealData?.meals || [];
          const exactMatch = meals.find((m: any) => m.strMeal?.toLowerCase() === name.toLowerCase());
          const chosen = exactMatch || meals[0];
          if (chosen?.strMealThumb) {
            const saved = await downloadAndSave(chosen.strMealThumb, 'meal');
            if (saved) {
              imageUrl = saved;
              console.log(`[AI Image] TheMealDB success: "${chosen.strMeal}" → ${saved}`);
            }
          }

          // If no match in MealDB, try a keyword-only search (first word of dish name)
          if (!imageUrl && name.split(' ').length > 1) {
            const keyword = name.split(' ').slice(-1)[0]; // e.g. "Tikka" from "Paneer Tikka"
            const kwUrl = `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(keyword)}`;
            const kwData: any = await new Promise((resolve, reject) => {
              https.get(kwUrl, { headers: { 'User-Agent': 'AtithiSetu/1.0' } }, (r: any) => {
                let b = '';
                r.on('data', (c: string) => b += c);
                r.on('end', () => { try { resolve(JSON.parse(b)); } catch { reject(new Error('parse')); } });
              }).on('error', reject);
              setTimeout(() => reject(new Error('timeout')), 8000);
            });
            const kwMeals: any[] = kwData?.meals || [];
            if (kwMeals[0]?.strMealThumb) {
              const saved = await downloadAndSave(kwMeals[0].strMealThumb, 'meal');
              if (saved) {
                imageUrl = saved;
                console.log(`[AI Image] TheMealDB keyword "${keyword}" → ${saved}`);
              }
            }
          }
        } catch (mealErr: any) {
          console.warn(`[AI Image] TheMealDB fallback failed: ${mealErr?.message || mealErr}`);
        }
      }

      // ---------- Strategy 3: LoremFlickr (CC-licensed, keyword-search, no auth) ----------
      if (!imageUrl) {
        try {
          // Use dish name + indian food as keywords for relevance
          const cleanName = name.replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, ',');
          const keywords = `indian,${cleanName},food`.toLowerCase();
          const flickrUrl = `https://loremflickr.com/480/480/${encodeURIComponent(keywords)}`;
          console.log(`[AI Image] Trying LoremFlickr for keywords: "${keywords}"`);
          const saved = await downloadAndSave(flickrUrl, 'flickr');
          if (saved) {
            imageUrl = saved;
            console.log(`[AI Image] LoremFlickr success → ${saved}`);
          }
        } catch (flickrErr: any) {
          console.warn(`[AI Image] LoremFlickr fallback failed: ${flickrErr?.message || flickrErr}`);
        }
      }

      // ---------- Strategy 4: Foodish (last resort — random food image) ----------
      if (!imageUrl) {
        try {
          const foodishCategories: Record<string, string> = {
            'biryani': 'biryani', 'rice': 'rice', 'dosa': 'dosa',
            'idly': 'idly', 'samosa': 'samosa', 'burger': 'burger',
            'pizza': 'pizza', 'pasta': 'pasta', 'dessert': 'dessert',
          };
          const nameLower = name.toLowerCase();
          let cat = '';
          for (const [key, val] of Object.entries(foodishCategories)) {
            if (nameLower.includes(key)) { cat = val; break; }
          }
          const foodishUrl = cat ? `https://foodish-api.com/api/images/${cat}` : 'https://foodish-api.com/api/';
          console.log(`[AI Image] Trying Foodish last-resort (category: ${cat || 'random'})`);
          const https = await import('https');

          const foodishData: any = await new Promise((resolve, reject) => {
            https.get(foodishUrl, (pRes: any) => {
              let body = '';
              pRes.on('data', (c: string) => body += c);
              pRes.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Foodish parse error')); } });
            }).on('error', reject);
            setTimeout(() => reject(new Error('Foodish timeout')), 10000);
          });

          if (foodishData?.image) {
            const saved = await downloadAndSave(foodishData.image, 'foodish');
            if (saved) {
              imageUrl = saved;
              console.log(`[AI Image] Foodish last-resort success → ${saved}`);
            }
          }
        } catch (foodishErr: any) {
          console.warn(`[AI Image] Foodish last-resort failed: ${foodishErr?.message || foodishErr}`);
        }
      }

      // ---------- No image obtained ----------
      if (!imageUrl) {
        const msg = quotaExhausted
          ? 'Gemini API quota exhausted (free tier limit reached). Please enable billing at https://ai.google.dev or try again later.'
          : 'Image generation failed. All image sources unavailable. Please try again.';
        return res.status(500).json({ error: msg });
      }

      // Save to DB (db was already obtained at the top of this handler)
      await db.run('UPDATE menu SET image_url = ? WHERE id = ?', [imageUrl, req.params.itemId]);

      res.json({ success: true, image_url: imageUrl });
    } catch (err) {
      console.error('Generate image error:', err);
      res.status(500).json({ error: 'Failed to generate image' });
    }
  });

  // Tables: Get Tables
  app.get("/api/restaurant/:id/tables", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const tables = await db.query("SELECT * FROM tables ORDER BY name");
      res.json(tables);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch tables" });
    }
  });

  // Tables: Sync Tables
  app.post("/api/restaurant/:id/tables/sync", authenticate, async (req: AuthRequest, res: Response) => {
    const { count } = req.body;
    try {
      const db = await getTenantDb(req.params.id);
      const existing = await db.query("SELECT id, name FROM tables");

      if (existing.length < count) {
        // ADD missing tables
        for (let i = existing.length + 1; i <= count; i++) {
          const newTableId = randomUUID();
          const qrUrl = `?r=${req.params.id}&table=${newTableId}`;
          await db.run(
            "INSERT INTO tables (id, name, capacity, qr_code_data) VALUES (?, ?, ?, ?)",
            [newTableId, `Table ${i}`, 4, qrUrl]
          );
        }
        // Backfill existing tables that still have NULL qr_code_data
        await db.run(
          `UPDATE tables SET qr_code_data = '?r=' || ? || '&table=' || id WHERE qr_code_data IS NULL`,
          [req.params.id]
        );
      } else if (existing.length > count) {
        // REMOVE extra tables — sort numerically by table name, delete the highest-numbered ones
        const sorted = [...existing].sort((a, b) => {
          const na = parseInt(String(a.name).replace(/\D/g, ''), 10) || 0;
          const nb = parseInt(String(b.name).replace(/\D/g, ''), 10) || 0;
          return nb - na; // descending: highest table numbers first
        });
        const toDelete = sorted.slice(0, existing.length - count);
        for (const table of toDelete) {
          await db.run("DELETE FROM tables WHERE id = ?", [table.id]);
        }
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to sync tables" });
    }
  });

  // Get Restaurant Info
  app.get("/api/restaurant/:id", async (req: Request, res: Response) => {
    try {
      const restaurant = await centralDb.get("SELECT * FROM restaurants WHERE id = ?", [req.params.id]);
      if (!restaurant) return res.status(404).json({ error: "Restaurant not found" });
      res.json(restaurant);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch restaurant" });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // HOSPITALITY MODULE — Hotel & Resort endpoints
  // All endpoints under /api/restaurant/:id/hotel/* are gated by property_type.
  // Tenants with property_type='RESTAURANT' (default) get 404 on every route.
  // ═══════════════════════════════════════════════════════════════════════════

  // Helper: enforce that the tenant has hotel enabled before handling request.
  // Flat shape (not a discriminated union) so call sites can access status/error
  // without narrowing — the tsconfig in this project does not enable strict
  // discriminated-union narrowing across `if (!result.ok)` checks. All fields
  // are populated on every return; success returns 200/'' for status/error.
  const ensureHotelEnabled = async (restaurantId: string): Promise<{ ok: boolean; restaurant: any; status: number; error: string }> => {
    const r: any = await centralDb.get("SELECT * FROM restaurants WHERE id = ?", [restaurantId]);
    if (!r) return { ok: false, restaurant: null, status: 404, error: "Restaurant not found" };
    const pt = r.property_type || 'RESTAURANT';
    if (pt !== 'HOTEL' && pt !== 'BOTH') {
      return { ok: false, restaurant: null, status: 403, error: "Hotel module not enabled for this property" };
    }
    return { ok: true, restaurant: r, status: 200, error: '' };
  };

  // ─── Enable / toggle the hotel module for a tenant ────────────────────────
  // POST /api/restaurant/:id/hotel/enable    body: { enabled: boolean }
  // Idempotent: creating tables multiple times is safe.
  app.post("/api/restaurant/:id/hotel/enable", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const restaurantId = req.params.id;
      if (req.user?.restaurantId !== restaurantId && req.user?.role !== 'SUPER_ADMIN' && req.user?.role !== 'CTO') {
        return res.status(403).json({ error: "Forbidden" });
      }
      const enabled: boolean = req.body?.enabled !== false;  // default true

      const current: any = await centralDb.get("SELECT property_type FROM restaurants WHERE id = ?", [restaurantId]);
      if (!current) return res.status(404).json({ error: "Restaurant not found" });
      const currentType = current.property_type || 'RESTAURANT';

      let newType: 'RESTAURANT' | 'HOTEL' | 'BOTH';
      if (enabled) {
        // Turning ON hotel: RESTAURANT → BOTH, anything else → keep hotel-capable
        newType = currentType === 'RESTAURANT' ? 'BOTH' : (currentType === 'HOTEL' ? 'HOTEL' : 'BOTH');
      } else {
        // Turning OFF hotel: BOTH → RESTAURANT, HOTEL → RESTAURANT
        newType = 'RESTAURANT';
      }

      await centralDb.run("UPDATE restaurants SET property_type = ? WHERE id = ?", [newType, restaurantId]);

      let seeded = 0;
      if (enabled) {
        const tenantDb = await getTenantDb(restaurantId);
        await createHotelTables(tenantDb);
        seeded = await seedDefaultServices(tenantDb);
      }

      res.json({
        success: true,
        property_type: newType,
        services_seeded: seeded,
        message: enabled
          ? `Hotel module enabled${seeded > 0 ? ` · ${seeded} default services added` : ''}`
          : "Hotel module disabled (data preserved)"
      });
    } catch (err: any) {
      console.error("/hotel/enable error:", err);
      res.status(500).json({ error: "Failed to toggle hotel module" });
    }
  });

  // ─── ROOMS CRUD ───────────────────────────────────────────────────────────
  app.get("/api/restaurant/:id/hotel/rooms", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      const rooms = await tenantDb.query("SELECT * FROM rooms ORDER BY floor, room_number, name");
      res.json(rooms);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch rooms" });
    }
  });

  app.post("/api/restaurant/:id/hotel/rooms", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const { id, name, room_number, floor, type, capacity, base_rate, amenities, notes, smoking_preference } = req.body || {};
      if (!name) return res.status(400).json({ error: "Name is required" });
      const roomId = id || `ROOM-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const qrData = `?r=${req.params.id}&room=${roomId}`;
      const sp = ['SMOKING', 'NON_SMOKING', 'ANY'].includes(smoking_preference) ? smoking_preference : 'NON_SMOKING';
      const tenantDb = await getTenantDb(req.params.id);
      await tenantDb.run(
        `INSERT INTO rooms (id, name, room_number, floor, type, capacity, base_rate, status, amenities, qr_code_data, notes, smoking_preference)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'VACANT', ?, ?, ?, ?)`,
        [roomId, name, room_number || null, floor || null, type || 'STANDARD',
         capacity || 2, base_rate || 0,
         amenities ? JSON.stringify(amenities) : null, qrData, notes || null, sp]
      );
      const row = await tenantDb.get("SELECT * FROM rooms WHERE id = ?", [roomId]);
      res.status(201).json(row);
    } catch (err: any) {
      console.error("Create room error:", err);
      res.status(500).json({ error: "Failed to create room" });
    }
  });

  app.patch("/api/restaurant/:id/hotel/rooms/:roomId", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const { name, room_number, floor, type, capacity, base_rate, amenities, notes, status, smoking_preference } = req.body || {};
      const tenantDb = await getTenantDb(req.params.id);
      const existing: any = await tenantDb.get("SELECT * FROM rooms WHERE id = ?", [req.params.roomId]);
      if (!existing) return res.status(404).json({ error: "Room not found" });
      const sp = smoking_preference === undefined ? null
        : (['SMOKING', 'NON_SMOKING', 'ANY'].includes(smoking_preference) ? smoking_preference : null);
      await tenantDb.run(
        `UPDATE rooms SET
           name = COALESCE(?, name),
           room_number = COALESCE(?, room_number),
           floor = COALESCE(?, floor),
           type = COALESCE(?, type),
           capacity = COALESCE(?, capacity),
           base_rate = COALESCE(?, base_rate),
           amenities = COALESCE(?, amenities),
           notes = COALESCE(?, notes),
           status = COALESCE(?, status),
           smoking_preference = COALESCE(?, smoking_preference)
         WHERE id = ?`,
        [name ?? null, room_number ?? null, floor ?? null, type ?? null,
         capacity ?? null, base_rate ?? null,
         amenities ? JSON.stringify(amenities) : null,
         notes ?? null, status ?? null, sp, req.params.roomId]
      );
      const updated = await tenantDb.get("SELECT * FROM rooms WHERE id = ?", [req.params.roomId]);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: "Failed to update room" });
    }
  });

  app.delete("/api/restaurant/:id/hotel/rooms/:roomId", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      await tenantDb.run("DELETE FROM rooms WHERE id = ?", [req.params.roomId]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete room" });
    }
  });

  app.patch("/api/restaurant/:id/hotel/rooms/:roomId/status", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const { status } = req.body || {};
      const allowed = ['VACANT', 'OCCUPIED', 'CLEANING', 'MAINTENANCE', 'BLOCKED'];
      if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid room status" });
      const tenantDb = await getTenantDb(req.params.id);
      await tenantDb.run("UPDATE rooms SET status = ? WHERE id = ?", [status, req.params.roomId]);
      const updated = await tenantDb.get("SELECT * FROM rooms WHERE id = ?", [req.params.roomId]);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: "Failed to update room status" });
    }
  });

  // ─── SERVICES (catalogue) CRUD ────────────────────────────────────────────
  app.get("/api/restaurant/:id/hotel/services", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      const services = await tenantDb.query("SELECT * FROM services ORDER BY display_order, category, name");
      res.json(services);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch services" });
    }
  });

  app.post("/api/restaurant/:id/hotel/services", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const { name, description, category, is_complimentary, price, price_type, sla_minutes, assigned_role, icon, image_url, display_order } = req.body || {};
      if (!name || !category) return res.status(400).json({ error: "Name and category required" });
      const svcId = `SVC-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const tenantDb = await getTenantDb(req.params.id);
      await tenantDb.run(
        `INSERT INTO services (id, name, description, category, is_complimentary, price, price_type, sla_minutes, assigned_role, icon, image_url, is_active, display_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [svcId, name, description || null, category,
         is_complimentary === false ? 0 : 1, price || 0, price_type || 'FIXED',
         sla_minutes || 30, assigned_role || null, icon || null, image_url || null,
         display_order || 99]
      );
      const row = await tenantDb.get("SELECT * FROM services WHERE id = ?", [svcId]);
      res.status(201).json(row);
    } catch (err) {
      res.status(500).json({ error: "Failed to create service" });
    }
  });

  app.patch("/api/restaurant/:id/hotel/services/:serviceId", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const { name, description, category, is_complimentary, price, price_type, sla_minutes, assigned_role, icon, image_url, is_active, display_order } = req.body || {};
      const tenantDb = await getTenantDb(req.params.id);
      await tenantDb.run(
        `UPDATE services SET
           name = COALESCE(?, name),
           description = COALESCE(?, description),
           category = COALESCE(?, category),
           is_complimentary = COALESCE(?, is_complimentary),
           price = COALESCE(?, price),
           price_type = COALESCE(?, price_type),
           sla_minutes = COALESCE(?, sla_minutes),
           assigned_role = COALESCE(?, assigned_role),
           icon = COALESCE(?, icon),
           image_url = COALESCE(?, image_url),
           is_active = COALESCE(?, is_active),
           display_order = COALESCE(?, display_order)
         WHERE id = ?`,
        [name ?? null, description ?? null, category ?? null,
         is_complimentary === undefined ? null : (is_complimentary ? 1 : 0),
         price ?? null, price_type ?? null, sla_minutes ?? null,
         assigned_role ?? null, icon ?? null, image_url ?? null,
         is_active === undefined ? null : (is_active ? 1 : 0),
         display_order ?? null, req.params.serviceId]
      );
      const updated = await tenantDb.get("SELECT * FROM services WHERE id = ?", [req.params.serviceId]);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: "Failed to update service" });
    }
  });

  app.delete("/api/restaurant/:id/hotel/services/:serviceId", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      await tenantDb.run("DELETE FROM services WHERE id = ?", [req.params.serviceId]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete service" });
    }
  });

  // ─── PUBLIC GUEST ENDPOINTS (session-token auth, no JWT) ─────────────────
  // GET /hotel/guest-services?token=<session_token>
  app.get("/api/restaurant/:id/hotel/guest-services", async (req: Request, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const token = String(req.query.token || '').trim();
      if (!token) return res.status(400).json({ error: "Session token required" });
      const tenantDb = await getTenantDb(req.params.id);
      const session = await tenantDb.get(
        "SELECT * FROM room_sessions WHERE session_token = ? AND status = 'active'",
        [token]
      );
      if (!session) return res.status(401).json({ error: "Invalid or expired session" });
      const services = await tenantDb.query(
        "SELECT id, name, description, category, is_complimentary, price, price_type, sla_minutes, icon FROM services WHERE is_active = 1 ORDER BY display_order, category, name"
      );
      res.json(services);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch services" });
    }
  });

  // GET /hotel/guest-requests?token=<session_token>
  app.get("/api/restaurant/:id/hotel/guest-requests", async (req: Request, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const token = String(req.query.token || '').trim();
      if (!token) return res.status(400).json({ error: "Session token required" });
      const tenantDb = await getTenantDb(req.params.id);
      const session: any = await tenantDb.get(
        "SELECT * FROM room_sessions WHERE session_token = ?",
        [token]
      );
      if (!session) return res.status(401).json({ error: "Invalid session" });
      const requests = await tenantDb.query(
        `SELECT * FROM service_requests
         WHERE guest_session_id = ? OR (room_id = ? AND requested_at >= ?)
         ORDER BY requested_at DESC LIMIT 20`,
        [session.id, session.room_id, session.opened_at]
      );
      res.json(requests);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch requests" });
    }
  });

  // ─── ROOM SESSIONS (guest-facing, public) ─────────────────────────────────
  app.post("/api/restaurant/:id/hotel/room-sessions", async (req: Request, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const { room_id, session_token, guest_name, guest_phone } = req.body || {};
      if (!room_id) return res.status(400).json({ error: "room_id is required" });
      const tenantDb = await getTenantDb(req.params.id);

      // Try to resume by token
      if (session_token) {
        const existing: any = await tenantDb.get(
          "SELECT * FROM room_sessions WHERE session_token = ? AND status = 'active'",
          [session_token]
        );
        if (existing) {
          await tenantDb.run(
            "UPDATE room_sessions SET last_activity_at = CURRENT_TIMESTAMP, guest_name = COALESCE(?, guest_name), guest_phone = COALESCE(?, guest_phone) WHERE id = ?",
            [guest_name || null, guest_phone || null, existing.id]
          );
          return res.json({ ...existing, guest_name: guest_name || existing.guest_name, guest_phone: guest_phone || existing.guest_phone });
        }
      }

      // Create new session
      const sessionId = `RSES-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const newToken = `rt_${Math.random().toString(36).slice(2, 15)}${Date.now().toString(36)}`;

      // Try to link to active booking if any
      const activeBooking: any = await tenantDb.get(
        "SELECT id FROM room_bookings WHERE room_id = ? AND status = 'CHECKED_IN' ORDER BY actual_checkin_at DESC LIMIT 1",
        [room_id]
      );

      await tenantDb.run(
        `INSERT INTO room_sessions (id, room_id, booking_id, session_token, status, guest_name, guest_phone)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        [sessionId, room_id, activeBooking?.id || null, newToken, guest_name || null, guest_phone || null]
      );
      const row = await tenantDb.get("SELECT * FROM room_sessions WHERE id = ?", [sessionId]);
      res.status(201).json(row);
    } catch (err: any) {
      console.error("room-sessions create error:", err);
      res.status(500).json({ error: "Failed to create room session" });
    }
  });

  // ─── SERVICE REQUESTS (guest creates, staff manages) ──────────────────────
  app.post("/api/restaurant/:id/hotel/service-requests", async (req: Request, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const { room_id, service_id, quantity, notes, priority, guest_session_token } = req.body || {};
      if (!room_id) return res.status(400).json({ error: "room_id is required" });
      const tenantDb = await getTenantDb(req.params.id);

      // Resolve service (optional — free-text complaints can have no service_id)
      let service: any = null;
      if (service_id) {
        service = await tenantDb.get("SELECT * FROM services WHERE id = ?", [service_id]);
        if (!service) return res.status(404).json({ error: "Service not found" });
      }

      // Resolve session (optional)
      let session: any = null;
      if (guest_session_token) {
        session = await tenantDb.get("SELECT * FROM room_sessions WHERE session_token = ?", [guest_session_token]);
      }

      const reqId = `SR-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const category = service?.category || 'MAINTENANCE';
      const serviceName = service?.name || (notes ? 'Guest reported issue' : 'Request');
      const role = service?.assigned_role || (category === 'MAINTENANCE' ? 'MAINTENANCE' : 'HOUSEKEEPING');
      const charge = service ? Number(service.price || 0) * Number(quantity || 1) : 0;
      const isComp = service ? !!service.is_complimentary : true;

      await tenantDb.run(
        `INSERT INTO service_requests
         (id, room_id, booking_id, guest_session_id, service_id, service_name, category, quantity, notes, priority, status, assigned_role, is_complimentary, charge_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
        [reqId, room_id, session?.booking_id || null, session?.id || null,
         service_id || null, serviceName, category, quantity || 1, notes || null,
         priority || 'NORMAL', role, isComp ? 1 : 0, charge]
      );
      const row = await tenantDb.get("SELECT * FROM service_requests WHERE id = ?", [reqId]);

      // Notify staff role via existing trigger
      try {
        await triggerNotification(req.params.id, 'HOUSEKEEPING_REQUESTED', {
          roomId: room_id,
          serviceName,
          category,
          priority: priority || 'NORMAL',
          requestId: reqId,
        });
      } catch {}

      res.status(201).json(row);
    } catch (err: any) {
      console.error("service-requests create error:", err);
      res.status(500).json({ error: "Failed to create service request" });
    }
  });

  app.get("/api/restaurant/:id/hotel/service-requests", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      const status = (req.query.status as string) || null;
      const role = (req.query.role as string) || null;
      let sql = `SELECT sr.*, r.name AS room_name
                 FROM service_requests sr
                 LEFT JOIN rooms r ON r.id = sr.room_id
                 WHERE 1 = 1`;
      const params: any[] = [];
      if (status) {
        const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
        if (statuses.length > 0) {
          sql += ` AND sr.status IN (${statuses.map(() => '?').join(',')})`;
          params.push(...statuses);
        }
      }
      if (role) {
        sql += ` AND sr.assigned_role = ?`;
        params.push(role);
      }
      sql += ` ORDER BY sr.priority = 'URGENT' DESC, sr.requested_at DESC`;
      const rows = await tenantDb.query(sql, params);
      res.json(rows);
    } catch (err: any) {
      console.error("service-requests list error:", err);
      res.status(500).json({ error: "Failed to fetch service requests" });
    }
  });

  app.patch("/api/restaurant/:id/hotel/service-requests/:requestId/status", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const { status, assigned_to } = req.body || {};
      const allowed = ['PENDING', 'ACKNOWLEDGED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
      if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status" });
      const tenantDb = await getTenantDb(req.params.id);
      const nowStamp = new Date().toISOString();
      const stampColumn = status === 'ACKNOWLEDGED' ? 'acknowledged_at'
                        : status === 'COMPLETED'    ? 'completed_at'
                        : null;
      if (stampColumn) {
        await tenantDb.run(
          `UPDATE service_requests SET status = ?, assigned_to = COALESCE(?, assigned_to), ${stampColumn} = ? WHERE id = ?`,
          [status, assigned_to || null, nowStamp, req.params.requestId]
        );
      } else {
        await tenantDb.run(
          "UPDATE service_requests SET status = ?, assigned_to = COALESCE(?, assigned_to) WHERE id = ?",
          [status, assigned_to || null, req.params.requestId]
        );
      }
      const updated: any = await tenantDb.get("SELECT * FROM service_requests WHERE id = ?", [req.params.requestId]);

      // On completion: if chargeable + active folio exists, post charge to folio (Phase 3)
      if (status === 'COMPLETED' && updated && !updated.is_complimentary && updated.charge_amount > 0) {
        try { await postServiceChargeToFolio(req.params.id, updated); } catch (e) { console.error("folio post failed:", e); }
      }

      // Notify guest on completion
      if (status === 'COMPLETED') {
        try {
          await triggerNotification(req.params.id, 'SERVICE_REQUEST_COMPLETED', {
            serviceName: updated.service_name,
            roomId: updated.room_id,
          });
        } catch {}
      }
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: "Failed to update service request" });
    }
  });

  // ─── BOOKINGS — list / create / cancel / check-in / check-out ────────────
  app.get("/api/restaurant/:id/hotel/bookings", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      const status = (req.query.status as string) || null;
      let sql = `SELECT b.*, r.name AS room_name
                 FROM room_bookings b
                 LEFT JOIN rooms r ON r.id = b.room_id
                 WHERE 1 = 1`;
      const params: any[] = [];
      if (status) {
        const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
        if (statuses.length > 0) {
          sql += ` AND b.status IN (${statuses.map(() => '?').join(',')})`;
          params.push(...statuses);
        }
      }
      sql += ` ORDER BY b.check_in_date DESC, b.created_at DESC`;
      res.json(await tenantDb.query(sql, params));
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch bookings" });
    }
  });

  app.post("/api/restaurant/:id/hotel/bookings", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const {
        room_id, guest_name, guest_phone, guest_email, guest_id_proof,
        guest_nationality, guest_state, num_guests, check_in_date, check_out_date,
        booking_source, room_rate, special_requests
      } = req.body || {};
      if (!room_id || !guest_name || !check_in_date || !check_out_date) {
        return res.status(400).json({ error: "room_id, guest_name, check_in_date, check_out_date required" });
      }
      const bid = `BK-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const tenantDb = await getTenantDb(req.params.id);
      // compute total
      const nights = Math.max(1, Math.ceil((new Date(check_out_date).getTime() - new Date(check_in_date).getTime()) / 86400000));
      const rate = Number(room_rate) || 0;
      const total = rate * nights;
      await tenantDb.run(
        `INSERT INTO room_bookings
         (id, room_id, guest_name, guest_phone, guest_email, guest_id_proof, guest_nationality, guest_state,
          num_guests, check_in_date, check_out_date, status, booking_source, room_rate, total_amount, special_requests)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BOOKED', ?, ?, ?, ?)`,
        [bid, room_id, guest_name, guest_phone || null, guest_email || null,
         guest_id_proof || null, guest_nationality || null, guest_state || null,
         num_guests || 1, check_in_date, check_out_date, booking_source || 'DIRECT', rate, total,
         special_requests || null]
      );
      const row = await tenantDb.get("SELECT * FROM room_bookings WHERE id = ?", [bid]);
      try { await triggerNotification(req.params.id, 'BOOKING_CREATED', { bookingId: bid, guestName: guest_name, checkIn: check_in_date, checkOut: check_out_date }); } catch {}
      res.status(201).json(row);
    } catch (err: any) {
      console.error("Create booking error:", err);
      res.status(500).json({ error: "Failed to create booking" });
    }
  });

  app.patch("/api/restaurant/:id/hotel/bookings/:bookingId", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      const b: any = await tenantDb.get("SELECT * FROM room_bookings WHERE id = ?", [req.params.bookingId]);
      if (!b) return res.status(404).json({ error: "Booking not found" });
      const allow = ['guest_name','guest_phone','guest_email','guest_id_proof','guest_nationality','guest_state','num_guests','check_in_date','check_out_date','room_rate','special_requests','status'];
      const patch: any = {};
      for (const k of allow) if (k in (req.body || {})) patch[k] = req.body[k];
      if (Object.keys(patch).length === 0) return res.json(b);
      const setStr = Object.keys(patch).map(k => `${k} = ?`).join(', ');
      await tenantDb.run(`UPDATE room_bookings SET ${setStr} WHERE id = ?`, [...Object.values(patch), req.params.bookingId]);
      res.json(await tenantDb.get("SELECT * FROM room_bookings WHERE id = ?", [req.params.bookingId]));
    } catch (err) {
      res.status(500).json({ error: "Failed to update booking" });
    }
  });

  // Check-in: mark booking CHECKED_IN, set room OCCUPIED, open a folio with initial nightly charges
  app.post("/api/restaurant/:id/hotel/bookings/:bookingId/checkin", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      const b: any = await tenantDb.get("SELECT * FROM room_bookings WHERE id = ?", [req.params.bookingId]);
      if (!b) return res.status(404).json({ error: "Booking not found" });
      if (b.status === 'CHECKED_IN') return res.status(400).json({ error: "Already checked in" });
      if (b.status === 'CHECKED_OUT' || b.status === 'CANCELLED') return res.status(400).json({ error: "Booking is finalized" });

      const now = new Date().toISOString();
      await tenantDb.run(
        "UPDATE room_bookings SET status = 'CHECKED_IN', actual_checkin_at = ? WHERE id = ?",
        [now, req.params.bookingId]
      );
      await tenantDb.run("UPDATE rooms SET status = 'OCCUPIED' WHERE id = ?", [b.room_id]);

      // Open a folio with ROOM_CHARGE entries (Phase 3 — folio engine)
      const folio = await createFolioWithRoomCharges(req.params.id, b);

      try { await triggerNotification(req.params.id, 'GUEST_CHECKED_IN', { bookingId: b.id, guestName: b.guest_name, roomId: b.room_id }); } catch {}
      res.json({
        booking: await tenantDb.get("SELECT * FROM room_bookings WHERE id = ?", [req.params.bookingId]),
        folio_id: folio?.id || null,
      });
    } catch (err: any) {
      console.error("checkin error:", err);
      res.status(500).json({ error: "Failed to check in" });
    }
  });

  // Check-out: close folio if not already, set room CLEANING, mark booking CHECKED_OUT
  app.post("/api/restaurant/:id/hotel/bookings/:bookingId/checkout", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const { payment_method, discount, waive } = req.body || {};
      const tenantDb = await getTenantDb(req.params.id);
      const b: any = await tenantDb.get("SELECT * FROM room_bookings WHERE id = ?", [req.params.bookingId]);
      if (!b) return res.status(404).json({ error: "Booking not found" });
      if (b.status !== 'CHECKED_IN') return res.status(400).json({ error: "Guest not checked in" });

      // Settle folio
      const settled = await settleFolioForBooking(req.params.id, b.id, payment_method || 'CASH', discount || 0, !!waive);

      const now = new Date().toISOString();
      await tenantDb.run("UPDATE room_bookings SET status = 'CHECKED_OUT', actual_checkout_at = ? WHERE id = ?", [now, req.params.bookingId]);
      await tenantDb.run("UPDATE rooms SET status = 'CLEANING' WHERE id = ?", [b.room_id]);
      await tenantDb.run("UPDATE room_sessions SET status = 'checked_out', closed_at = ? WHERE room_id = ? AND status = 'active'", [now, b.room_id]);

      try { await triggerNotification(req.params.id, 'GUEST_CHECKED_OUT', { bookingId: b.id, guestName: b.guest_name, roomId: b.room_id }); } catch {}
      res.json({
        booking: await tenantDb.get("SELECT * FROM room_bookings WHERE id = ?", [req.params.bookingId]),
        folio: settled,
      });
    } catch (err: any) {
      console.error("checkout error:", err);
      res.status(500).json({ error: "Failed to check out" });
    }
  });

  app.post("/api/restaurant/:id/hotel/bookings/:bookingId/cancel", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      await tenantDb.run("UPDATE room_bookings SET status = 'CANCELLED' WHERE id = ?", [req.params.bookingId]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to cancel booking" });
    }
  });

  // ─── FOLIOS — list + view + settle (Phase 3) ─────────────────────────────
  app.get("/api/restaurant/:id/hotel/folios", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      const status = (req.query.status as string) || null;
      let sql = `SELECT f.*, b.guest_name, b.check_in_date, b.check_out_date, r.name AS room_name
                 FROM folios f
                 LEFT JOIN room_bookings b ON b.id = f.booking_id
                 LEFT JOIN rooms r ON r.id = f.room_id
                 WHERE 1 = 1`;
      const params: any[] = [];
      if (status) { sql += ` AND f.status = ?`; params.push(status); }
      sql += ` ORDER BY f.created_at DESC`;
      res.json(await tenantDb.query(sql, params));
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch folios" });
    }
  });

  app.get("/api/restaurant/:id/hotel/folios/:folioId", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      const folio: any = await tenantDb.get(
        `SELECT f.*, b.guest_name, b.guest_phone, b.guest_email, b.check_in_date, b.check_out_date, b.guest_nationality, r.name AS room_name
         FROM folios f
         LEFT JOIN room_bookings b ON b.id = f.booking_id
         LEFT JOIN rooms r ON r.id = f.room_id
         WHERE f.id = ?`, [req.params.folioId]);
      if (!folio) return res.status(404).json({ error: "Folio not found" });
      const entries = await tenantDb.query(
        "SELECT * FROM folio_entries WHERE folio_id = ? ORDER BY created_at ASC", [req.params.folioId]
      );
      res.json({ ...folio, entries });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch folio" });
    }
  });

  // ─── FOLIO INVOICE PDF (Phase 4) ─────────────────────────────────────────
  // Industry-standard Tax Invoice PDF with Indian GST compliance.
  app.get("/api/restaurant/:id/hotel/folios/:folioId/invoice-pdf", authenticate, async (req: AuthRequest, res: Response) => {
    const checkRes = await ensureHotelEnabled(req.params.id);
    if (!checkRes.ok) return res.status(checkRes.status).json({ error: checkRes.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      const folio: any = await tenantDb.get(
        `SELECT f.*, b.id AS booking_id, b.guest_name, b.guest_phone, b.guest_email,
                b.guest_nationality, b.guest_state, b.check_in_date, b.check_out_date,
                b.actual_checkin_at, b.actual_checkout_at, b.num_guests, r.name AS room_name
         FROM folios f
         LEFT JOIN room_bookings b ON b.id = f.booking_id
         LEFT JOIN rooms r ON r.id = f.room_id
         WHERE f.id = ?`, [req.params.folioId]
      );
      if (!folio) return res.status(404).json({ error: "Folio not found" });
      const entries: any[] = await tenantDb.query(
        "SELECT * FROM folio_entries WHERE folio_id = ? ORDER BY created_at ASC",
        [req.params.folioId]
      );

      // Invoice number
      const invoiceDate = folio.settled_at || folio.created_at || new Date().toISOString();
      const settledDate = new Date(invoiceDate);
      const isCredit = folio.doc_type === 'CREDIT_NOTE';
      const prefix = isCredit ? 'CN' : 'INV';
      const invNum = `${prefix}-${settledDate.getFullYear()}-${String(folio.id).slice(-6).toUpperCase()}`;

      // Parent invoice (if credit note)
      let parentInvoiceNumber: string | undefined;
      if (isCredit && folio.parent_folio_id) {
        const parent: any = await tenantDb.get("SELECT id, created_at, settled_at FROM folios WHERE id = ?", [folio.parent_folio_id]);
        if (parent) {
          const pd = new Date(parent.settled_at || parent.created_at);
          parentInvoiceNumber = `INV-${pd.getFullYear()}-${String(parent.id).slice(-6).toUpperCase()}`;
        }
      }

      const hotel = checkRes.restaurant;
      const pdf = await generateInvoicePdf({
        hotel: {
          name:     hotel.name,
          city:     hotel.city,
          state:    hotel.state,
          gstin:    hotel.gst_number,
          phone:    hotel.phone,
          email:    hotel.admin_id,
          logoPath: hotel.logo_url || undefined,
        },
        guest: {
          name:         folio.guest_name || 'Guest',
          phone:        folio.guest_phone,
          email:        folio.guest_email,
          nationality:  folio.guest_nationality,
          state:        folio.guest_state,
        },
        stay: {
          roomName:          folio.room_name || folio.room_id,
          bookingId:         folio.booking_id,
          checkInDate:       folio.check_in_date,
          checkOutDate:      folio.check_out_date,
          actualCheckInAt:   folio.actual_checkin_at,
          actualCheckOutAt:  folio.actual_checkout_at,
          numGuests:         folio.num_guests,
        },
        folio: {
          id:             folio.id,
          invoiceNumber:  invNum,
          invoiceDate:    invoiceDate,
          subtotal:       Number(folio.subtotal || 0),
          discount:       Number(folio.discount || 0),
          gstAmount:      Number(folio.gst_amount || 0),
          grandTotal:     Number(folio.grand_total || 0),
          paymentMethod:  folio.payment_method,
          settledAt:      folio.settled_at,
          status:         folio.status,
        },
        entries: entries.map(e => ({
          description: e.description,
          entryType:   e.entry_type,
          quantity:    Number(e.quantity || 1),
          unitPrice:   Number(e.unit_price || 0),
          amount:      Number(e.amount || 0),
          gstRate:     Number(e.gst_rate || 0),
          gstAmount:   Number(e.gst_amount || 0),
        })),
        placeOfSupply: hotel.state,
        // sameStateGst is now auto-derived from guest.state vs hotel.state
        isCreditNote:  isCredit,
        parentInvoiceNumber,
        creditNoteReason: folio.reason,
        bilingual:        true,
      });

      const safeName = String(folio.guest_name || 'guest').replace(/[^a-z0-9_-]+/gi, '-');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${invNum}-${safeName}.pdf"`);
      res.send(pdf);
    } catch (err: any) {
      console.error("Invoice PDF error:", err);
      res.status(500).json({ error: "Failed to generate invoice PDF" });
    }
  });

  // ─── EMAIL INVOICE TO GUEST (Phase 5) ─────────────────────────────────────
  // POST /hotel/folios/:folioId/email-invoice
  // body: { to?: string (override) }
  app.post("/api/restaurant/:id/hotel/folios/:folioId/email-invoice", authenticate, async (req: AuthRequest, res: Response) => {
    const checkRes = await ensureHotelEnabled(req.params.id);
    if (!checkRes.ok) return res.status(checkRes.status).json({ error: checkRes.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      const folio: any = await tenantDb.get(
        `SELECT f.*, b.id AS booking_id, b.guest_name, b.guest_phone, b.guest_email,
                b.guest_nationality, b.guest_state, b.check_in_date, b.check_out_date,
                b.actual_checkin_at, b.actual_checkout_at, b.num_guests, r.name AS room_name
         FROM folios f
         LEFT JOIN room_bookings b ON b.id = f.booking_id
         LEFT JOIN rooms r ON r.id = f.room_id
         WHERE f.id = ?`, [req.params.folioId]
      );
      if (!folio) return res.status(404).json({ error: "Folio not found" });
      const toEmail = (req.body?.to as string)?.trim() || folio.guest_email;
      if (!toEmail) return res.status(400).json({ error: "Guest has no email address. Provide 'to' in the request body." });

      const entries: any[] = await tenantDb.query(
        "SELECT * FROM folio_entries WHERE folio_id = ? ORDER BY created_at ASC",
        [req.params.folioId]
      );

      const invoiceDate = folio.settled_at || folio.created_at || new Date().toISOString();
      const settledDate = new Date(invoiceDate);
      const isCredit = folio.doc_type === 'CREDIT_NOTE';
      const prefix = isCredit ? 'CN' : 'INV';
      const invNum = `${prefix}-${settledDate.getFullYear()}-${String(folio.id).slice(-6).toUpperCase()}`;

      let parentInvoiceNumber: string | undefined;
      if (isCredit && folio.parent_folio_id) {
        const parent: any = await tenantDb.get("SELECT id, created_at, settled_at FROM folios WHERE id = ?", [folio.parent_folio_id]);
        if (parent) {
          const pd = new Date(parent.settled_at || parent.created_at);
          parentInvoiceNumber = `INV-${pd.getFullYear()}-${String(parent.id).slice(-6).toUpperCase()}`;
        }
      }

      const hotel = checkRes.restaurant;
      const pdf = await generateInvoicePdf({
        hotel: { name: hotel.name, city: hotel.city, state: hotel.state, gstin: hotel.gst_number, phone: hotel.phone, email: hotel.admin_id, logoPath: hotel.logo_url || undefined },
        guest: { name: folio.guest_name || 'Guest', phone: folio.guest_phone, email: folio.guest_email, nationality: folio.guest_nationality, state: folio.guest_state },
        stay:  {
          roomName: folio.room_name || folio.room_id,
          bookingId: folio.booking_id,
          checkInDate: folio.check_in_date,
          checkOutDate: folio.check_out_date,
          actualCheckInAt: folio.actual_checkin_at,
          actualCheckOutAt: folio.actual_checkout_at,
          numGuests: folio.num_guests,
        },
        folio: {
          id: folio.id, invoiceNumber: invNum, invoiceDate,
          subtotal: Number(folio.subtotal || 0), discount: Number(folio.discount || 0),
          gstAmount: Number(folio.gst_amount || 0), grandTotal: Number(folio.grand_total || 0),
          paymentMethod: folio.payment_method, settledAt: folio.settled_at, status: folio.status,
        },
        entries: entries.map(e => ({
          description: e.description, entryType: e.entry_type,
          quantity: Number(e.quantity || 1), unitPrice: Number(e.unit_price || 0),
          amount: Number(e.amount || 0), gstRate: Number(e.gst_rate || 0), gstAmount: Number(e.gst_amount || 0),
        })),
        placeOfSupply: hotel.state,
        isCreditNote: isCredit,
        parentInvoiceNumber,
        creditNoteReason: folio.reason,
        bilingual: true,
      });

      const safeName = String(folio.guest_name || 'guest').replace(/[^a-z0-9_-]+/gi, '-');
      const subject = isCredit
        ? `Credit Note ${invNum} — ${hotel.name}`
        : `Tax Invoice ${invNum} — ${hotel.name}`;
      const textBody =
        `Dear ${folio.guest_name || 'Guest'},\n\n` +
        (isCredit
          ? `Please find attached your credit note ${invNum} for your recent stay at ${hotel.name}.\n\nAny refund will be processed via the original payment method.`
          : `Thank you for your stay at ${hotel.name}.\n\nPlease find attached your tax invoice ${invNum} for your records.`) +
        `\n\nFor any queries, reply to this email.\n\n${hotel.name} Team`;
      const htmlBody =
        `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:auto;padding:24px;background:#faf7f2">
           <div style="background:${isCredit ? '#c13b3b' : '#cc5a16'};color:#fff;padding:24px;border-radius:24px 24px 0 0">
             <h1 style="font-family:Georgia,serif;margin:0;font-size:22px">${isCredit ? 'Credit Note' : 'Tax Invoice'}</h1>
             <p style="margin:6px 0 0;opacity:0.85">${hotel.name}</p>
           </div>
           <div style="background:#fff;padding:24px;border-radius:0 0 24px 24px">
             <p>Dear ${folio.guest_name || 'Guest'},</p>
             <p>${isCredit
                 ? `Please find attached your credit note <strong>${invNum}</strong>.` + (parentInvoiceNumber ? ` This reverses invoice <strong>${parentInvoiceNumber}</strong>.` : '')
                 : `Thank you for your stay at <strong>${hotel.name}</strong>. Please find your tax invoice <strong>${invNum}</strong> attached.`}</p>
             <p style="color:#6b5d52;font-size:13px">Amount: <strong>INR ${Number(folio.grand_total || 0).toLocaleString('en-IN')}</strong></p>
             <p style="margin-top:24px">For any queries, reply to this email.<br/><strong>${hotel.name} Team</strong></p>
           </div>
         </div>`;

      const { sendEmail: _send } = await import('./notificationService.ts');
      const sent = await _send(toEmail, subject, textBody, htmlBody, [
        { filename: `${invNum}-${safeName}.pdf`, content: pdf, contentType: 'application/pdf' },
      ] as any);
      if (!sent) return res.status(500).json({ error: "Email delivery failed — check SMTP configuration" });
      res.json({ success: true, sent_to: toEmail, invoice_number: invNum });
    } catch (err: any) {
      console.error("Email invoice error:", err);
      res.status(500).json({ error: err?.message || "Failed to email invoice" });
    }
  });

  // ─── CREDIT NOTE (Phase 5) ────────────────────────────────────────────────
  // POST /hotel/folios/:folioId/credit-note
  // body: { reason?: string, partial?: { [entryId]: amount } }
  // For simplicity, v1 creates a full-refund credit note that mirrors the parent folio entries.
  app.post("/api/restaurant/:id/hotel/folios/:folioId/credit-note", authenticate, async (req: AuthRequest, res: Response) => {
    const checkRes = await ensureHotelEnabled(req.params.id);
    if (!checkRes.ok) return res.status(checkRes.status).json({ error: checkRes.error });
    try {
      const { reason } = req.body || {};
      const tenantDb = await getTenantDb(req.params.id);
      const parent: any = await tenantDb.get("SELECT * FROM folios WHERE id = ?", [req.params.folioId]);
      if (!parent) return res.status(404).json({ error: "Folio not found" });
      if (parent.doc_type === 'CREDIT_NOTE') {
        return res.status(400).json({ error: "Cannot generate a credit note against another credit note" });
      }
      // Prevent duplicate credit notes
      const existing: any = await tenantDb.get(
        "SELECT id FROM folios WHERE parent_folio_id = ? AND doc_type = 'CREDIT_NOTE'",
        [parent.id]
      );
      if (existing) {
        return res.status(400).json({ error: "A credit note already exists for this folio", credit_note_id: existing.id });
      }

      const cnId = `CN-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await tenantDb.run(
        `INSERT INTO folios
         (id, booking_id, room_id, status, subtotal, gst_amount, service_charge, discount, grand_total, payment_method, settled_at, doc_type, parent_folio_id, reason)
         VALUES (?, ?, ?, 'settled', ?, ?, ?, ?, ?, ?, NOW(), 'CREDIT_NOTE', ?, ?)`,
        [cnId, parent.booking_id, parent.room_id,
         parent.subtotal, parent.gst_amount, parent.service_charge || 0, parent.discount || 0, parent.grand_total,
         parent.payment_method || null, parent.id, reason || 'Refund / cancellation']
      );
      // Copy entries (they'll be rendered with a minus sign on the PDF via isCreditNote)
      const parentEntries: any[] = await tenantDb.query("SELECT * FROM folio_entries WHERE folio_id = ?", [parent.id]);
      for (const e of parentEntries) {
        const eid = `FE-${Date.now()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
        await tenantDb.run(
          `INSERT INTO folio_entries (id, folio_id, entry_type, description, quantity, unit_price, amount, gst_rate, gst_amount, source_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [eid, cnId, e.entry_type, e.description, e.quantity, e.unit_price, e.amount, e.gst_rate, e.gst_amount, e.id]
        );
      }
      const cn = await tenantDb.get("SELECT * FROM folios WHERE id = ?", [cnId]);
      res.status(201).json(cn);
    } catch (err: any) {
      console.error("Credit note error:", err);
      res.status(500).json({ error: err?.message || "Failed to generate credit note" });
    }
  });

  // ─── HOTEL ANALYTICS (Phase 3) ────────────────────────────────────────────
  app.get("/api/restaurant/:id/hotel/analytics", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      const totalRooms: any = await tenantDb.get("SELECT COUNT(*) AS n FROM rooms");
      const occupied: any = await tenantDb.get("SELECT COUNT(*) AS n FROM rooms WHERE status = 'OCCUPIED'");
      const totalRoomsN = Number(totalRooms?.n || 0);
      const occupiedN = Number(occupied?.n || 0);
      const occupancy_pct = totalRoomsN > 0 ? (occupiedN / totalRoomsN) * 100 : 0;

      // Revenue and ADR from settled folios (last 30 days)
      const revenueRow: any = await tenantDb.get(
        `SELECT COALESCE(SUM(grand_total), 0) AS rev, COUNT(*) AS n
         FROM folios WHERE status = 'settled' AND settled_at >= NOW() - INTERVAL '30 days'`
      );
      const revenue_30d = Number(revenueRow?.rev || 0);
      const folio_count_30d = Number(revenueRow?.n || 0);
      const adr = folio_count_30d > 0 ? revenue_30d / folio_count_30d : 0;
      const revpar = totalRoomsN > 0 ? revenue_30d / (totalRoomsN * 30) : 0;

      // Service requests analysis
      const reqBreakdown = await tenantDb.query(
        `SELECT category, COUNT(*) AS n,
         AVG(EXTRACT(EPOCH FROM (completed_at - requested_at))/60) AS avg_mins
         FROM service_requests WHERE status = 'COMPLETED' AND requested_at >= NOW() - INTERVAL '30 days'
         GROUP BY category ORDER BY n DESC`
      );
      const topServices = await tenantDb.query(
        `SELECT service_name, COUNT(*) AS n FROM service_requests WHERE requested_at >= NOW() - INTERVAL '30 days'
         GROUP BY service_name ORDER BY n DESC LIMIT 5`
      );
      const avgRating: any = await tenantDb.get("SELECT AVG(guest_rating) AS r FROM service_requests WHERE guest_rating IS NOT NULL AND requested_at >= NOW() - INTERVAL '30 days'");

      // Ancillary revenue
      const ancillary: any = await tenantDb.get(
        `SELECT COALESCE(SUM(amount),0) AS n FROM folio_entries
         WHERE entry_type = 'SERVICE' AND created_at >= NOW() - INTERVAL '30 days'`
      );
      const ancillaryN = Number(ancillary?.n || 0);
      const ancillary_pct = revenue_30d > 0 ? (ancillaryN / revenue_30d) * 100 : 0;

      res.json({
        totalRooms: totalRoomsN,
        occupied: occupiedN,
        occupancy_pct: Math.round(occupancy_pct * 10) / 10,
        revenue_30d,
        adr: Math.round(adr),
        revpar: Math.round(revpar),
        folio_count_30d,
        requests_by_category: reqBreakdown,
        top_services: topServices,
        avg_rating: Number(avgRating?.r || 0),
        ancillary_revenue_30d: ancillaryN,
        ancillary_pct: Math.round(ancillary_pct * 10) / 10,
      });
    } catch (err: any) {
      console.error("Hotel analytics error:", err);
      res.status(500).json({ error: "Failed to fetch analytics" });
    }
  });

  // ─── COMPLIANCE (Phase 3) ────────────────────────────────────────────────
  // GET /hotel/compliance/foreign-guests — list bookings with foreign nationals
  app.get("/api/restaurant/:id/hotel/compliance/foreign-guests", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      const rows = await tenantDb.query(
        `SELECT b.*, r.name AS room_name,
                (SELECT COUNT(*) FROM guest_compliance_log c WHERE c.booking_id = b.id AND c.form_type = 'FORM_C') AS form_c_submissions
         FROM room_bookings b
         LEFT JOIN rooms r ON r.id = b.room_id
         WHERE b.guest_nationality IS NOT NULL
           AND UPPER(TRIM(b.guest_nationality)) NOT IN ('INDIA','INDIAN','IN')
         ORDER BY b.check_in_date DESC LIMIT 100`
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch compliance list" });
    }
  });

  // POST /hotel/compliance/form-c/:bookingId — record a Form-C draft
  app.post("/api/restaurant/:id/hotel/compliance/form-c/:bookingId", authenticate, async (req: AuthRequest, res: Response) => {
    const check = await ensureHotelEnabled(req.params.id);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      const cid = `CMP-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const now = new Date().toISOString();
      await tenantDb.run(
        `INSERT INTO guest_compliance_log (id, booking_id, form_type, submitted_at, submitted_by, status)
         VALUES (?, ?, 'FORM_C', ?, ?, 'drafted')`,
        [cid, req.params.bookingId, now, req.user?.email || req.user?.id || 'unknown']
      );
      const row = await tenantDb.get("SELECT * FROM guest_compliance_log WHERE id = ?", [cid]);
      res.status(201).json(row);
    } catch (err) {
      res.status(500).json({ error: "Failed to record Form-C" });
    }
  });

  // GET /hotel/compliance/form-c/:bookingId/pdf — generate & download Form-C PDF (Phase 4)
  app.get("/api/restaurant/:id/hotel/compliance/form-c/:bookingId/pdf", authenticate, async (req: AuthRequest, res: Response) => {
    const checkRes = await ensureHotelEnabled(req.params.id);
    if (!checkRes.ok) return res.status(checkRes.status).json({ error: checkRes.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      const booking: any = await tenantDb.get(
        `SELECT b.*, r.name AS room_name FROM room_bookings b
         LEFT JOIN rooms r ON r.id = b.room_id WHERE b.id = ?`,
        [req.params.bookingId]
      );
      if (!booking) return res.status(404).json({ error: "Booking not found" });
      if (!booking.guest_nationality || /^(india|indian|in)$/i.test(String(booking.guest_nationality).trim())) {
        return res.status(400).json({ error: "Form C is only applicable to foreign nationals" });
      }
      const latest: any = await tenantDb.get(
        "SELECT id FROM guest_compliance_log WHERE booking_id = ? AND form_type = 'FORM_C' ORDER BY submitted_at DESC LIMIT 1",
        [req.params.bookingId]
      );
      const pdfBuf = await generateFormCPdf({
        hotel: {
          name: checkRes.restaurant.name,
          city: checkRes.restaurant.city,
          state: checkRes.restaurant.state,
          gstNumber: checkRes.restaurant.gst_number,
        },
        booking: {
          guest_name: booking.guest_name,
          guest_phone: booking.guest_phone,
          guest_email: booking.guest_email,
          guest_nationality: booking.guest_nationality,
          guest_id_proof: booking.guest_id_proof,
          num_guests: booking.num_guests,
          check_in_date: booking.check_in_date,
          check_out_date: booking.check_out_date,
          actual_checkin_at: booking.actual_checkin_at,
          room_name: booking.room_name,
          arrival_date: booking.actual_checkin_at || booking.check_in_date,
          purpose: 'Tourism',
        },
        referenceNumber: latest?.id,
      });
      const safeName = String(booking.guest_name || 'guest').replace(/[^a-z0-9_-]+/gi, '-');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="FormC-${safeName}-${booking.id}.pdf"`);
      res.send(pdfBuf);
    } catch (err: any) {
      console.error("Form-C PDF error:", err);
      res.status(500).json({ error: "Failed to generate Form-C PDF" });
    }
  });

  // ─── AI CONCIERGE CHAT (Phase 4 — Groq) ──────────────────────────────────
  // Public (session-token auth) chat endpoint called from the RoomGuestInterface.
  app.post("/api/restaurant/:id/hotel/concierge/chat", async (req: Request, res: Response) => {
    const checkRes = await ensureHotelEnabled(req.params.id);
    if (!checkRes.ok) return res.status(checkRes.status).json({ error: checkRes.error });
    try {
      const { session_token, message, history } = req.body || {};
      if (!message) return res.status(400).json({ error: "message required" });
      const tenantDb = await getTenantDb(req.params.id);
      // Session auth (if provided) — optional but gives us context
      let session: any = null;
      if (session_token) {
        session = await tenantDb.get("SELECT * FROM room_sessions WHERE session_token = ?", [session_token]);
      }
      // Load hotel FAQ (from the new concierge_knowledge table, if exists)
      let faqs: Array<{ question: string; answer: string }> = [];
      try {
        const rows: any[] = await tenantDb.query("SELECT question, answer FROM concierge_knowledge WHERE is_active = 1 ORDER BY display_order LIMIT 50");
        faqs = rows;
      } catch { /* table may not exist yet */ }

      const reply = await chatWithConcierge({
        hotelName: checkRes.restaurant.name,
        city: checkRes.restaurant.city,
        faqs,
        history: Array.isArray(history) ? history.slice(-8) : [],
        message,
        guestName: session?.guest_name,
      });
      res.json({ reply });
    } catch (err: any) {
      console.error("Concierge chat error:", err);
      res.status(500).json({ error: err?.message || "Failed to get chatbot reply" });
    }
  });

  // ─── FAQ / KNOWLEDGE-BASE CRUD (Phase 4) ────────────────────────────────
  app.get("/api/restaurant/:id/hotel/concierge/faqs", authenticate, async (req: AuthRequest, res: Response) => {
    const checkRes = await ensureHotelEnabled(req.params.id);
    if (!checkRes.ok) return res.status(checkRes.status).json({ error: checkRes.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      await tenantDb.exec(`
        CREATE TABLE IF NOT EXISTS concierge_knowledge (
          id TEXT PRIMARY KEY,
          question TEXT NOT NULL,
          answer TEXT NOT NULL,
          category TEXT,
          is_active INT DEFAULT 1,
          display_order INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      const rows = await tenantDb.query("SELECT * FROM concierge_knowledge ORDER BY display_order, category, question");
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: "Failed to load FAQ" });
    }
  });

  app.post("/api/restaurant/:id/hotel/concierge/faqs", authenticate, async (req: AuthRequest, res: Response) => {
    const checkRes = await ensureHotelEnabled(req.params.id);
    if (!checkRes.ok) return res.status(checkRes.status).json({ error: checkRes.error });
    try {
      const { question, answer, category, display_order } = req.body || {};
      if (!question || !answer) return res.status(400).json({ error: "question and answer required" });
      const tenantDb = await getTenantDb(req.params.id);
      await tenantDb.exec(`CREATE TABLE IF NOT EXISTS concierge_knowledge (
        id TEXT PRIMARY KEY, question TEXT NOT NULL, answer TEXT NOT NULL, category TEXT,
        is_active INT DEFAULT 1, display_order INT DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
      const fid = `FAQ-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await tenantDb.run(
        `INSERT INTO concierge_knowledge (id, question, answer, category, display_order) VALUES (?, ?, ?, ?, ?)`,
        [fid, question, answer, category || 'General', display_order || 99]
      );
      res.status(201).json(await tenantDb.get("SELECT * FROM concierge_knowledge WHERE id = ?", [fid]));
    } catch (err) {
      res.status(500).json({ error: "Failed to save FAQ" });
    }
  });

  app.patch("/api/restaurant/:id/hotel/concierge/faqs/:faqId", authenticate, async (req: AuthRequest, res: Response) => {
    const checkRes = await ensureHotelEnabled(req.params.id);
    if (!checkRes.ok) return res.status(checkRes.status).json({ error: checkRes.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      const { question, answer, category, is_active, display_order } = req.body || {};
      await tenantDb.run(
        `UPDATE concierge_knowledge SET
           question = COALESCE(?, question),
           answer = COALESCE(?, answer),
           category = COALESCE(?, category),
           is_active = COALESCE(?, is_active),
           display_order = COALESCE(?, display_order)
         WHERE id = ?`,
        [question ?? null, answer ?? null, category ?? null,
         is_active === undefined ? null : (is_active ? 1 : 0),
         display_order ?? null, req.params.faqId]
      );
      res.json(await tenantDb.get("SELECT * FROM concierge_knowledge WHERE id = ?", [req.params.faqId]));
    } catch (err) {
      res.status(500).json({ error: "Failed to update FAQ" });
    }
  });

  app.delete("/api/restaurant/:id/hotel/concierge/faqs/:faqId", authenticate, async (req: AuthRequest, res: Response) => {
    const checkRes = await ensureHotelEnabled(req.params.id);
    if (!checkRes.ok) return res.status(checkRes.status).json({ error: checkRes.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      await tenantDb.run("DELETE FROM concierge_knowledge WHERE id = ?", [req.params.faqId]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete FAQ" });
    }
  });

  // ─── ON-DEMAND SENTIMENT ANALYSIS (Phase 4) ──────────────────────────────
  app.post("/api/restaurant/:id/hotel/analytics/sentiment", authenticate, async (req: AuthRequest, res: Response) => {
    const checkRes = await ensureHotelEnabled(req.params.id);
    if (!checkRes.ok) return res.status(checkRes.status).json({ error: checkRes.error });
    try {
      const tenantDb = await getTenantDb(req.params.id);
      const rows: any[] = await tenantDb.query(
        `SELECT sr.id, sr.service_name, sr.guest_feedback, sr.guest_rating, sr.requested_at, sr.category, r.name AS room_name
         FROM service_requests sr LEFT JOIN rooms r ON r.id = sr.room_id
         WHERE sr.guest_feedback IS NOT NULL AND sr.guest_feedback <> ''
           AND sr.status = 'COMPLETED' AND sr.requested_at >= NOW() - INTERVAL '30 days'
         ORDER BY sr.requested_at DESC LIMIT 50`
      );
      if (rows.length === 0) {
        return res.json({ summary: "No guest feedback collected in the last 30 days yet.", items: [], patterns: [] });
      }
      const analysis = await analyzeSentiment({
        hotelName: checkRes.restaurant.name,
        feedbackItems: rows.map(r => ({
          id: r.id,
          serviceName: r.service_name,
          category: r.category,
          rating: r.guest_rating,
          roomName: r.room_name,
          feedback: r.guest_feedback,
          at: r.requested_at,
        })),
      });
      res.json(analysis);
    } catch (err: any) {
      console.error("Sentiment analysis error:", err);
      res.status(500).json({ error: err?.message || "Failed to analyze feedback" });
    }
  });

  // Update Restaurant Settings
  app.patch("/api/restaurant/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const {
        name, gst_number, gst_percentage, is_gst_enabled, template_id, table_count,
        upi_id, checkout_mode, logo_url, menu_display_mode, alerts_enabled,
        invoice_numbering_mode, invoice_number_prefix, invoice_yearly_reset,
      } = req.body;
      const allowedModes = ['PHOTO', 'CARD', 'COMPACT', 'MAGAZINE'];
      const menuMode = menu_display_mode !== undefined
        ? (allowedModes.includes(menu_display_mode) ? menu_display_mode : null)
        : null;
      const alertsVal = alerts_enabled === undefined ? null : (alerts_enabled ? 1 : 0);

      // Validate checkout_mode — only allow known values; default to postpaid.
      const allowedCheckoutModes = new Set(['postpaid', 'prepaid', 'cloud_kitchen']);
      const safeCheckoutMode = allowedCheckoutModes.has(String(checkout_mode || '').toLowerCase())
        ? String(checkout_mode).toLowerCase()
        : 'postpaid';

      // Invoice numbering — validate; only forward to UPDATE when fields provided.
      const allowedInvoiceModes = new Set(['RANDOM', 'SEQUENTIAL']);
      const safeInvoiceMode = invoice_numbering_mode === undefined
        ? null
        : (allowedInvoiceModes.has(String(invoice_numbering_mode || '').toUpperCase())
            ? String(invoice_numbering_mode).toUpperCase()
            : 'RANDOM');
      let safeInvoicePrefix: string | null = null;
      if (invoice_number_prefix !== undefined) {
        const trimmed = String(invoice_number_prefix || '').trim();
        if (trimmed && !INVOICE_PREFIX_RE.test(trimmed)) {
          return res.status(400).json({
            error: "Invalid invoice prefix. Allowed characters: A-Z a-z 0-9 - _ / . (1-12 chars)."
          });
        }
        safeInvoicePrefix = trimmed || 'INV-';
      }
      const safeYearlyReset = invoice_yearly_reset === undefined
        ? null
        : (invoice_yearly_reset ? 1 : 0);

      await centralDb.run(`
        UPDATE restaurants SET
          name = ?,
          gst_number = ?,
          gst_percentage = ?,
          is_gst_enabled = ?,
          template_id = ?,
          table_count = ?,
          upi_id = ?,
          checkout_mode = ?,
          logo_url = COALESCE(?, logo_url),
          menu_display_mode = COALESCE(?, menu_display_mode),
          alerts_enabled = COALESCE(?, alerts_enabled),
          invoice_numbering_mode = COALESCE(?, invoice_numbering_mode),
          invoice_number_prefix = COALESCE(?, invoice_number_prefix),
          invoice_yearly_reset = COALESCE(?, invoice_yearly_reset)
        WHERE id = ?
      `, [
        name,
        gst_number || null,
        gst_percentage != null ? Number(gst_percentage) : 0,
        is_gst_enabled ? 1 : 0,
        template_id || 'CLASSIC',
        table_count || 0,
        upi_id || null,
        checkout_mode || 'postpaid',
        logo_url !== undefined ? (logo_url || null) : null,
        menuMode,
        alertsVal,
        safeInvoiceMode,
        safeInvoicePrefix,
        safeYearlyReset,
        req.params.id
      ]);

      res.json({ success: true });
    } catch (err) {
      console.error("Update restaurant error:", err);
      return res.status(500).json({ error: "Failed to update restaurant" });
    }
  });

  // Phase 5: Logo upload endpoint (dedicated, uses multer)
  app.post("/api/restaurant/:id/logo", authenticate, upload.single('logo'), async (req: AuthRequest, res: Response) => {
    try {
      if (req.user?.restaurantId !== req.params.id && req.user?.role !== 'SUPER_ADMIN' && req.user?.role !== 'CTO') {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const logoUrl = `/uploads/${req.file.filename}`;
      await centralDb.run(`UPDATE restaurants SET logo_url = ? WHERE id = ?`, [logoUrl, req.params.id]);
      res.json({ success: true, logo_url: logoUrl });
    } catch (err) {
      console.error("Logo upload error:", err);
      res.status(500).json({ error: "Failed to upload logo" });
    }
  });

  // Phase 5: Remove logo
  app.delete("/api/restaurant/:id/logo", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      if (req.user?.restaurantId !== req.params.id && req.user?.role !== 'SUPER_ADMIN' && req.user?.role !== 'CTO') {
        return res.status(403).json({ error: "Forbidden" });
      }
      await centralDb.run(`UPDATE restaurants SET logo_url = NULL WHERE id = ?`, [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to remove logo" });
    }
  });

  // Tables: Public (no auth — customer QR scan uses this to resolve table name)
  app.get("/api/restaurant/:id/tables/public", async (req: Request, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const tables = await db.query("SELECT id, name, capacity, status FROM tables ORDER BY name");
      res.json(tables);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch tables" });
    }
  });

  // Sessions: Create or Resume (Postpaid mode)
  // POST /api/restaurant/:id/sessions
  // Body: { table_id, table_name, session_token? (for resume), customer_name?, customer_phone? }
  app.post("/api/restaurant/:id/sessions", async (req: Request, res: Response) => {
    try {
      const { table_id, table_name, session_token, customer_name, customer_phone } = req.body;
      const db = await getTenantDb(req.params.id);

      // Helper to load and return a session with its orders
      const returnSession = async (sess: any) => {
        const orders = await db.query(
          "SELECT * FROM orders WHERE session_id = ? ORDER BY round_number, created_at",
          [sess.id]
        );
        orders.forEach((o: any) => {
          if (typeof o.items === 'string') { try { o.items = JSON.parse(o.items); } catch { o.items = []; } }
        });
        return res.json({ ...sess, orders });
      };

      // ─── Stale-session guard (added 2026-04 after Naini-Corbett incident) ────
      // A session that was never explicitly closed by staff would stay 'open'
      // forever and be re-used by the next guest who scanned the same QR —
      // pre-filling that new guest with the old guest's name and printing
      // wrong KOTs (Order ORD-1777368391773 was reproduced this way: a
      // 4-day-old session was resumed and the new guest's order printed
      // 'rahul tamta', the original guest's name).
      //
      // A session is considered STALE if BOTH of these are true:
      //   • opened_at is older than 4 hours, AND
      //   • no orders have been placed in the last 2 hours.
      //
      // Conversely a session is FRESH (eligible for resume) if EITHER:
      //   • opened_at is within the last 4 hours, OR
      //   • it has at least one order in the last 2 hours.
      //
      // This preserves long-running but actively-used sessions (e.g. a 5-hour
      // celebration where guests order every 30 minutes) while killing
      // truly abandoned sessions that staff forgot to close.
      //
      // When the resume is refused, the request falls through to step 3
      // (create brand-new session), which means the new guest gets a clean
      // session with no stored customer info — they type their own name
      // once, the same as any first-time scan.
      const SESSION_FRESH_PREDICATE = `(
        ts.opened_at > NOW() - INTERVAL '4 hours'
        OR EXISTS (
          SELECT 1 FROM orders o
          WHERE o.session_id = ts.id
            AND o.created_at > NOW() - INTERVAL '2 hours'
        )
      )`;

      // 1. Try to resume an active session by stored token (open OR bill_requested)
      //    A customer who re-scans after requesting the bill should still see their session.
      //    Stale-guarded so a re-used / shared device can't resume someone else's old session.
      if (session_token) {
        const existingByToken = await db.get(
          `SELECT ts.* FROM table_sessions ts
           WHERE ts.session_token = ?
             AND ts.status IN ('open', 'bill_requested')
             AND ${SESSION_FRESH_PREDICATE}`,
          [session_token]
        );
        if (existingByToken) return returnSession(existingByToken);
      }

      // 2. Find the most-recent OPEN session for this table (fresh scan — no stored token).
      //    Only resumes 'open' sessions so that a new guest scanning after bill_requested
      //    gets a brand-new session (treated as second guest).
      //    Stale-guarded — see comment above.
      if (table_id) {
        const existingByTable = await db.get(
          `SELECT ts.* FROM table_sessions ts
           WHERE ts.table_id = ?
             AND ts.status = 'open'
             AND ${SESSION_FRESH_PREDICATE}
           ORDER BY ts.opened_at DESC LIMIT 1`,
          [table_id]
        );
        if (existingByTable) return returnSession(existingByTable);
      }

      // 3. Create a brand-new session
      const newId    = `SES-${Date.now()}`;
      const newToken = randomUUID().replace(/-/g, '');
      await db.run(
        `INSERT INTO table_sessions
           (id, session_token, table_id, table_name, customer_name, customer_phone, status, round_count, bill_amount)
         VALUES (?, ?, ?, ?, ?, ?, 'open', 0, 0)`,
        [newId, newToken, table_id || null, table_name || null, customer_name || null, customer_phone || null]
      );
      // Mark the physical table as OCCUPIED
      if (table_id) {
        await db.run("UPDATE tables SET status = 'OCCUPIED' WHERE id = ?", [table_id]).catch(() => {});
      }
      res.json({ id: newId, session_token: newToken, table_id, table_name, status: 'open', round_count: 0, bill_amount: 0, orders: [] });
    } catch (err) {
      console.error("Create session error:", err);
      res.status(500).json({ error: "Failed to create session" });
    }
  });

  // Sessions: Get by Token (Postpaid — customer re-scan / refresh)
  app.get("/api/restaurant/:id/sessions/:token", async (req: Request, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const session = await db.get(
        "SELECT * FROM table_sessions WHERE session_token = ?",
        [req.params.token]
      );
      if (!session) return res.status(404).json({ error: "Session not found" });

      const orders = await db.query(
        "SELECT * FROM orders WHERE session_id = ? ORDER BY round_number, created_at",
        [session.id]
      );
      orders.forEach((o: any) => {
        if (typeof o.items === 'string') { try { o.items = JSON.parse(o.items); } catch { o.items = []; } }
      });
      res.json({ ...session, orders });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch session" });
    }
  });

  // Sessions: Get active session for a specific table (owner/waiter use)
  app.get("/api/restaurant/:id/tables/:tableId/active-session", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const restaurant = await centralDb.get(
        "SELECT name, gst_percentage, is_gst_enabled, gst_number, city FROM restaurants WHERE id = ?", [req.params.id]
      );
      const session = await db.get(
        "SELECT * FROM table_sessions WHERE table_id = ? AND status IN ('open','bill_requested') ORDER BY opened_at DESC LIMIT 1",
        [req.params.tableId]
      );
      if (!session) return res.json({ session: null, restaurant });

      // Fetch table display name
      const tableRow = await db.get("SELECT name FROM tables WHERE id = ?", [session.table_id]).catch(() => null);

      const orders = await db.query(
        "SELECT * FROM orders WHERE session_id = ? ORDER BY round_number ASC, created_at ASC",
        [session.id]
      );
      orders.forEach((o: any) => {
        if (typeof o.items === 'string') { try { o.items = JSON.parse(o.items); } catch { o.items = []; } }
      });

      // Defaults: if gst_percent not set on session, use restaurant setting.
      // Important: a freshly-opened session has gst_percent stored as 0 (the
      // column default) — NOT null — so the previous `!= null` check
      // returned 0 and BillView showed "GST not added". The request-bill
      // endpoint is what populates gst_percent on the session row; until
      // that happens, the session's stored values are not authoritative.
      // Therefore: when status='open' (pre-bill-request), always use the
      // restaurant defaults. Once the customer requests the bill (status
      // becomes 'bill_requested'), the stored values are intentional and
      // we honour them as-is.
      const gstEnabled      = Boolean(restaurant?.is_gst_enabled);
      const defaultGstPct   = gstEnabled ? (Number(restaurant.gst_percentage) || 0) : 0;
      const defaultApplyGst = gstEnabled ? 1 : 0;
      const isPreBillRequest = String(session.status || '').toLowerCase() === 'open';
      const finalGstPercent = !gstEnabled
        ? 0
        : isPreBillRequest
          ? defaultGstPct
          : Number(session.gst_percent || 0);
      const finalApplyGst = !gstEnabled
        ? 0
        : isPreBillRequest
          ? defaultApplyGst
          : (session.apply_gst != null ? Number(session.apply_gst) : defaultApplyGst);

      res.json({
        session: {
          ...session,
          table_display_name: tableRow?.name || session.table_name || session.table_id,
          discount_amount:        Number(session.discount_amount || 0),
          service_charge_percent: Number(session.service_charge_percent || 0),
          gst_percent:  finalGstPercent,
          apply_gst:    finalApplyGst,
          orders,
        },
        restaurant,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch active session" });
    }
  });

  // Sessions: Save postpaid invoice adjustments (discount, service charge, GST)
  app.patch("/api/restaurant/:id/sessions/:sessionToken/invoice", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const { discount_amount = 0, service_charge_percent = 0, gst_percent = 0, apply_gst = 1, final_amount } = req.body;

      const hasFinal = final_amount !== undefined;
      await db.run(
        `UPDATE table_sessions
         SET discount_amount = ?, service_charge_percent = ?, gst_percent = ?, apply_gst = ?
             ${hasFinal ? ', bill_amount = ?, final_amount = ?' : ''}
         WHERE session_token = ?`,
        hasFinal
          ? [Number(discount_amount), Number(service_charge_percent), Number(gst_percent), apply_gst ? 1 : 0,
             Number(final_amount), Number(final_amount), req.params.sessionToken]
          : [Number(discount_amount), Number(service_charge_percent), Number(gst_percent), apply_gst ? 1 : 0,
             req.params.sessionToken]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("Session invoice PATCH error:", err);
      res.status(500).json({ error: "Failed to save invoice adjustments" });
    }
  });

  // Sessions: Owner — list all sessions for a restaurant
  app.get("/api/restaurant/:id/sessions", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const sessions = await db.query(
        "SELECT * FROM table_sessions ORDER BY opened_at DESC LIMIT 100"
      );
      res.json(sessions);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch sessions" });
    }
  });

  // Sessions: Request Bill (Customer triggers at end of postpaid meal)
  app.post("/api/restaurant/:id/sessions/:token/request-bill", async (req: Request, res: Response) => {
    try {
      const { payment_method } = req.body;
      const db = await getTenantDb(req.params.id);

      // Idempotent: accept sessions already in 'bill_requested' too. This
      // handles double-taps, customer adds-more-items-then-re-requests, and
      // network retries — any of which used to silently fail with 404 and
      // leave the session out of the owner's invoice list.
      const session = await db.get(
        "SELECT * FROM table_sessions WHERE session_token = ? AND status IN ('open','bill_requested')",
        [req.params.token]
      );
      if (!session) {
        console.warn(`[request-bill] Session ${req.params.token} not in open/bill_requested state for ${req.params.id}`);
        return res.status(404).json({ error: "Active session not found" });
      }

      // Aggregate bill from all orders in this session (subtotal + GST)
      const orderRows = await db.query(
        "SELECT total_amount, gst_amount FROM orders WHERE session_id = ? AND status != 'CANCELLED'",
        [session.id]
      );
      const billAmount = orderRows.reduce(
        (s: number, o: any) => s + Number(o.total_amount || 0) + Number(o.gst_amount || 0),
        0
      );

      // ── Persist GST fields on the session so the printed invoice can show
      //    the breakdown correctly. Without this, gst_percent stays at the
      //    column default (0) and buildInvoiceHTML recomputes total without
      //    GST → printed invoice shows subtotal as total.
      // Defensive: if the central-DB lookup fails, fall back to the existing
      //  session values so the bill-request always succeeds.
      let sessionGstPct = Number(session.gst_percent || 0);
      let sessionApplyGst = Number(session.apply_gst ?? 1);
      try {
        const restaurantSettings: any = await centralDb.get(
          "SELECT is_gst_enabled, gst_percentage FROM restaurants WHERE id = ?",
          [req.params.id]
        );
        const restGstEnabled = Boolean(restaurantSettings?.is_gst_enabled);
        const restGstPct = Number(restaurantSettings?.gst_percentage || 0);
        // Only override session values if they're still at column defaults
        // (so an admin's explicit override in close-session flow is preserved).
        const sessionUnconfigured = sessionGstPct === 0 && sessionApplyGst === 1;
        if (sessionUnconfigured) {
          sessionGstPct = restGstEnabled ? restGstPct : 0;
          sessionApplyGst = restGstEnabled ? 1 : 0;
        }
      } catch (settingsErr) {
        console.warn(`[request-bill] Failed to fetch GST settings for ${req.params.id}; keeping existing session values:`, settingsErr);
      }

      // Safety net: if SEQUENTIAL invoice numbering is enabled and the session
      // never got an invoice_number (because it was created via QR before the
      // feature deployed, OR because the orders-POST first-round assignment
      // path failed silently), assign one now at bill-request time. COALESCE
      // ensures we never overwrite an existing number.
      let assignedInvoiceNumber: string | null = null;
      if (!session.invoice_number) {
        assignedInvoiceNumber = await generateInvoiceNumberIfSequential(db, req.params.id);
      }

      await db.run(
        `UPDATE table_sessions
            SET status = 'bill_requested',
                bill_amount = ?,
                bill_requested_at = COALESCE(bill_requested_at, CURRENT_TIMESTAMP),
                payment_method = COALESCE(?, payment_method),
                gst_percent = ?,
                apply_gst = ?,
                invoice_number = COALESCE(invoice_number, ?)
          WHERE id = ?`,
        [billAmount, payment_method || null, sessionGstPct, sessionApplyGst, assignedInvoiceNumber, session.id]
      );

      console.log(`[request-bill] OK ${req.params.id}/${req.params.token} → bill_requested, amount=₹${billAmount.toFixed(2)}, gst=${sessionGstPct}%, apply_gst=${sessionApplyGst}, invoice_number=${session.invoice_number || assignedInvoiceNumber || '(none)'}`);

      // Notify owner + waiters (don't await — fire and forget)
      triggerNotification(req.params.id, 'ORDER_PLACED', {
        orderId:       session.id,
        tableNumber:   session.table_name || session.table_id,
        items:         [`Bill requested for ${session.table_name || 'Table'} — ₹${billAmount.toFixed(2)}`],
        total:         billAmount,
        customerPhone: session.customer_phone,
        customerEmail: null,
      }).catch((notifErr) => console.warn('[request-bill] notify failed:', notifErr));

      res.json({ success: true, bill_amount: billAmount, session_token: req.params.token });
    } catch (err) {
      console.error(`[request-bill] FATAL for ${req.params.id}/${req.params.token}:`, err);
      res.status(500).json({ error: "Failed to request bill" });
    }
  });

  // Sessions: Close (Owner/Manager confirms payment — accepts final_amount + payment_method override)
  app.patch("/api/restaurant/:id/sessions/:token/close", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const { payment_method, final_amount } = req.body || {};

      const updateParts: string[] = ["status = 'closed'", "closed_at = CURRENT_TIMESTAMP"];
      const updateParams: any[]   = [];
      if (payment_method) { updateParts.push("payment_method = ?"); updateParams.push(payment_method); }
      if (final_amount !== undefined) {
        updateParts.push("bill_amount = ?");
        updateParts.push("final_amount = ?");
        updateParams.push(Number(final_amount));
        updateParams.push(Number(final_amount));
      }
      // Final safety net: if SEQUENTIAL is enabled and the session never got an
      // invoice_number on either order-POST or request-bill, assign one now at
      // close-time. COALESCE preserves any existing value.
      const existingSess: any = await db.get(
        "SELECT invoice_number FROM table_sessions WHERE session_token = ?",
        [req.params.token]
      );
      if (existingSess && !existingSess.invoice_number) {
        const lateInv = await generateInvoiceNumberIfSequential(db, req.params.id);
        if (lateInv) {
          updateParts.push("invoice_number = COALESCE(invoice_number, ?)");
          updateParams.push(lateInv);
        }
      }
      updateParams.push(req.params.token);

      await db.run(`UPDATE table_sessions SET ${updateParts.join(', ')} WHERE session_token = ?`, updateParams);

      const session = await db.get("SELECT id, table_id FROM table_sessions WHERE session_token = ?", [req.params.token]);
      if (session) {
        // Mark all orders paid AND delivered so they leave the live kitchen view
        await db.run(
          "UPDATE orders SET payment_status = 'PAID', status = 'DELIVERED' WHERE session_id = ?",
          [session.id]
        );
        if (session.table_id) {
          await db.run("UPDATE tables SET status = 'AVAILABLE' WHERE id = ?", [session.table_id]).catch(() => {});
        }
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to close session" });
    }
  });

  // Orders: Get Orders
  app.get("/api/restaurant/:id/orders", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const orders = await db.query("SELECT * FROM orders ORDER BY created_at DESC");
      res.json(orders);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  });

  // Orders: Live Kitchen Orders (for owner/manager monitor dashboard — active orders only)
  app.get("/api/restaurant/:id/orders/live", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      // Ensure new columns exist
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS chef_id TEXT").catch(() => {});
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS chef_name TEXT").catch(() => {});
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS eta TEXT").catch(() => {});
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS kitchen_status TEXT DEFAULT 'queued'").catch(() => {});
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_status TEXT DEFAULT 'DRAFT'").catch(() => {});

      // Exclude orders whose invoice has been PRINTED — the bill is closed,
      // no further kitchen action is expected. This matters especially for
      // MANUAL invoices (id starts with MAN-): they INSERT with status
      // 'CONFIRMED' but never transition to DELIVERED, so without this guard
      // they'd stick in Live Kitchen Orders forever after printing.
      const orders = await db.query(
        `SELECT * FROM orders
         WHERE status NOT IN ('DELIVERED','CANCELLED')
           AND (kitchen_status IS NULL OR kitchen_status NOT IN ('held_for_payment'))
           AND (invoice_status IS NULL OR invoice_status <> 'PRINTED')
         ORDER BY
           CASE status WHEN 'READY' THEN 1 WHEN 'PREPARING' THEN 2 ELSE 3 END,
           created_at ASC`
      );
      // Parse items JSON for each order
      const parsed = orders.map((o: any) => {
        try { o.items = typeof o.items === 'string' ? JSON.parse(o.items) : o.items; } catch (_) {}
        return o;
      });
      res.json(parsed);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch live orders" });
    }
  });

  // ─── Invoice numbering helpers (RANDOM / SEQUENTIAL with prefix + yearly reset) ──
  // Allowed prefix charset — keeps audit logs / file paths safe.
  const INVOICE_PREFIX_RE = /^[A-Za-z0-9_\-./]{1,12}$/;

  // Compute the year in IST (Asia/Kolkata, UTC+05:30) — used for yearly-reset
  // counters. Uses pure offset math so it works regardless of the host's
  // system timezone.
  const getYearIST = (): number => {
    const istNowMs = Date.now() + (5.5 * 60 * 60 * 1000);
    return new Date(istNowMs).getUTCFullYear();
  };

  const formatInvoiceNumber = (prefix: string, n: number, year: number | null): string => {
    const padded = String(n).padStart(4, '0');
    return year !== null ? `${prefix}${year}-${padded}` : `${prefix}${padded}`;
  };

  // Returns a sequential invoice number string IF the tenant has SEQUENTIAL mode
  // enabled; returns null when the tenant is in RANDOM mode or settings can't be
  // read. Caller writes the returned value into the orders.invoice_number or
  // table_sessions.invoice_number column. Atomic counter via getNextTenantSequence.
  //
  // When `forceSequential = true` the caller is asserting that the order MUST get
  // a sequential number regardless of the tenant's RANDOM/SEQUENTIAL setting —
  // used for cloud_kitchen orders, which always need a sequential audit number
  // (delivery / GST / bookkeeping requirements).
  const generateInvoiceNumberIfSequential = async (
    tenantDb: DbInterface,
    restaurantId: string,
    forceSequential: boolean = false
  ): Promise<string | null> => {
    try {
      const r: any = await centralDb.get(
        `SELECT invoice_numbering_mode, invoice_number_prefix, invoice_yearly_reset
         FROM restaurants WHERE id = ?`,
        [restaurantId]
      );
      if (!r) return null;
      const mode = String(r.invoice_numbering_mode || 'RANDOM').toUpperCase();
      if (!forceSequential && mode !== 'SEQUENTIAL') return null;
      const rawPrefix = String(r.invoice_number_prefix || '').trim();
      const prefix = (rawPrefix && INVOICE_PREFIX_RE.test(rawPrefix)) ? rawPrefix : 'INV-';
      const yearlyReset = Number(r.invoice_yearly_reset || 0) === 1;
      const year = yearlyReset ? getYearIST() : null;
      const seqName = yearlyReset ? `invoice-${year}` : 'invoice';
      const n = await getNextTenantSequence(tenantDb, seqName);
      return formatInvoiceNumber(prefix, n, year);
    } catch (err) {
      console.warn(`[invoice-numbering] Failed to generate sequential number for ${restaurantId}; falling back to RANDOM:`, err);
      return null;
    }
  };

  // Helper to compute display_number consistently when serializing invoices.
  const computeDisplayNumber = (row: { id: any; invoice_number?: string | null }): string => {
    return row.invoice_number || `#${String(row.id || '').slice(-8).toUpperCase()}`;
  };

  // ─── Invoice Endpoints ─────────────────────────────────────────────────────

  // Invoices: consolidated list — SESSION invoices (postpaid, 1 per session) + ORDER invoices (prepaid/manual)
  app.get("/api/restaurant/:id/invoices", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);

      // Restaurant GST settings — used as a defensive fallback when a session's
      // gst_percent is at the column default (0) but GST is actually enabled
      // for the restaurant. Fixes printed-invoice GST line for historical
      // sessions created before the request-bill endpoint was patched.
      // Defensive: a failure here must NOT prevent the invoice list from rendering.
      let restGstEnabled = false;
      let restGstPct = 0;
      try {
        const restSettings: any = await centralDb.get(
          "SELECT is_gst_enabled, gst_percentage FROM restaurants WHERE id = ?",
          [req.params.id]
        );
        restGstEnabled = Boolean(restSettings?.is_gst_enabled);
        restGstPct = Number(restSettings?.gst_percentage || 0);
      } catch (settingsErr) {
        console.warn(`[invoices-list] GST settings lookup failed for ${req.params.id}; using defaults:`, settingsErr);
      }

      // ── 1. SESSION invoices (postpaid): one consolidated invoice per session ──
      // Include any session that has at least one non-cancelled order, regardless
      // of whether the bill has been formally requested. This eliminates a class
      // of bugs where the customer's request-bill call silently failed and the
      // session stayed in 'open', leaving the orders orphaned (visible in the
      // Orders tab but missing from Invoices). Owners can also manually finalise
      // a bill that the customer never explicitly requested.
      const sessions = await db.query(
        `SELECT ts.*,
                COALESCE(ts.invoice_status, 'DRAFT') as invoice_status,
                t.name as table_name
         FROM table_sessions ts
         LEFT JOIN tables t ON t.id = ts.table_id
         WHERE ts.status IN ('open', 'bill_requested', 'closed')
           AND EXISTS (
             SELECT 1 FROM orders o
              WHERE o.session_id = ts.id
                AND o.status != 'CANCELLED'
           )
         ORDER BY ts.opened_at DESC`
      );

      const sessionInvoices: any[] = [];
      for (const sess of sessions) {
        const orders = await db.query(
          `SELECT * FROM orders WHERE session_id = ? AND status != 'CANCELLED' ORDER BY round_number ASC, created_at ASC`,
          [sess.id]
        );
        // Parse items per order
        orders.forEach((o: any) => {
          if (typeof o.items === 'string') { try { o.items = JSON.parse(o.items); } catch { o.items = []; } }
        });
        // Combine all items across rounds
        const combinedItems: any[] = [];
        orders.forEach((o: any) => { combinedItems.push(...(Array.isArray(o.items) ? o.items : [])); });
        const rawSubtotal = combinedItems.reduce((s: number, it: any) => s + Number(it.price || 0) * Number(it.quantity || 1), 0);
        // Fallback for historical sessions where gst_percent stayed at the
        // default 0 even though the restaurant has GST enabled. Without this,
        // the printed invoice would recompute the total without GST.
        const sessGstPctRaw = Number(sess.gst_percent || 0);
        const sessApplyGstRaw = Number(sess.apply_gst ?? 1);
        const sessionUnconfigured = sessGstPctRaw === 0 && sessApplyGstRaw === 1;
        const effectiveGstPct = sessionUnconfigured && restGstEnabled ? restGstPct : sessGstPctRaw;
        const effectiveApplyGst = sessionUnconfigured && restGstEnabled ? 1 : sessApplyGstRaw;

        // Compute the GST-inclusive total the same way the print template does.
        // Used when the session is still ACTIVE / hasn't gone through Request
        // Bill yet, because bill_amount/final_amount are still 0 in that case.
        const sessDiscount = Number(sess.discount_amount || 0);
        const sessSvcPct = Number(sess.service_charge_percent || 0);
        const sessAfterDisc = Math.max(0, rawSubtotal - sessDiscount);
        const sessSvcAmt = sessAfterDisc * sessSvcPct / 100;
        const sessTaxable = sessAfterDisc + sessSvcAmt;
        const sessGstAmt = effectiveApplyGst ? sessTaxable * effectiveGstPct / 100 : 0;
        const sessComputedTotal = Number((sessTaxable + sessGstAmt).toFixed(2));

        sessionInvoices.push({
          id:                     sess.session_token,
          session_db_id:          sess.id,
          session_token:          sess.session_token,
          invoice_number:         sess.invoice_number || null,
          display_number:         sess.invoice_number || `#${String(sess.session_token || sess.id || '').slice(-8).toUpperCase()}`,
          invoice_type:           'SESSION',
          invoice_status:         sess.invoice_status,
          customer_name:          sess.customer_name || '',
          customer_phone:         sess.customer_phone || '',
          table_number:           sess.table_name || sess.table_id,
          created_at:             sess.opened_at,
          // Prefer the stored bill_amount (set on Request Bill) or final_amount
          // (set on Close). Fall back to the GST-inclusive computed total so
          // ACTIVE sessions show the correct ₹ in the list — matching the
          // print template instead of the raw subtotal.
          total_amount:           Number(sess.bill_amount || sess.final_amount || sessComputedTotal || 0),
          raw_subtotal:           rawSubtotal,
          discount_amount:        sessDiscount,
          service_charge_percent: sessSvcPct,
          gst_percent:            effectiveGstPct,
          apply_gst:              effectiveApplyGst,
          session_status:         sess.status,
          round_count:            orders.length,
          items:                  combinedItems,
          // Order IDs of every round in this session — surfaced so the owner
          // can search the invoice list by an order id (e.g. "ORD-1777265510243")
          // and still find the parent SESSION invoice.
          order_ids:              orders.map((o: any) => o.id),
          // Per-round data for thermal print (label + items)
          rounds:                 orders.map((o: any, idx: number) => ({
            label: orders.length > 1 ? `-- Round ${o.round_number || idx + 1} --` : undefined,
            order_id: o.id,
            items: (Array.isArray(o.items) ? o.items : []).map((it: any) => ({
              name:  it.name  || '',
              qty:   Number(it.quantity || 1),
              price: Number(it.price    || 0),
            })),
          })),
        });
      }

      // ── 2. ORDER invoices: every non-cancelled order whose session is NOT
      // already represented in the SESSION list above. This is the universal
      // catch-all — no order can ever be invisible regardless of what state
      // its parent session is in (deleted, missing, exotic status, etc.).
      // Conditions covered:
      //   • session_id NULL / empty                → show as ORDER
      //   • session_id points to non-existent row  → show as ORDER
      //   • session exists but status not in our visible IN-list → show as ORDER
      //   • session exists with valid status → already in SESSION list, NOT shown again here
      const standaloneOrders = await db.query(
        `SELECT o.*, COALESCE(o.invoice_status, 'DRAFT') as invoice_status, 'ORDER' as invoice_type
         FROM orders o
         WHERE o.status != 'CANCELLED'
           AND NOT EXISTS (
             SELECT 1 FROM table_sessions ts
              WHERE ts.id = o.session_id
                AND ts.status IN ('open', 'bill_requested', 'closed')
           )
         ORDER BY o.created_at DESC`
      );
      standaloneOrders.forEach((o: any) => {
        if (typeof o.items === 'string') { try { o.items = JSON.parse(o.items); } catch { o.items = []; } }
        // display_number — sequential value if present, otherwise legacy "#ABCD1234"
        o.display_number = computeDisplayNumber(o);
        // GST-inclusive total for the invoice list. Online / prepaid orders
        // store total_amount = subtotal and gst_amount separately, while
        // manual invoices store total_amount = grand (gst_amount = 0). Adding
        // both gives the GST-inclusive total in either case without affecting
        // the underlying DB column (used by reports/analytics, which read the
        // raw subtotal directly).
        o.total_amount = Number(o.total_amount || 0) + Number(o.gst_amount || 0);
      });

      // Merge and sort by date descending
      const allInvoices = [...sessionInvoices, ...standaloneOrders].sort(
        (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
      );

      console.log(`[invoices-list] ${req.params.id} → ${sessionInvoices.length} session + ${standaloneOrders.length} order = ${allInvoices.length} total`);
      res.json(allInvoices);
    } catch (err) {
      console.error(`[invoices-list] FATAL for ${req.params.id}:`, err);
      res.status(500).json({ error: "Failed to fetch invoices" });
    }
  });

  // Invoice status: update on individual ORDER
  app.patch("/api/orders/:id/invoice-status", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { invoice_status, restaurantId } = req.body;
      if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });
      const db = await getTenantDb(restaurantId);
      await db.run("UPDATE orders SET invoice_status = ? WHERE id = ?", [invoice_status, req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to update invoice status" });
    }
  });

  // Invoice status: update on SESSION invoice
  // When invoice_status transitions to PRINTED or PAID we also cascade the
  // status to every order in the session so the Live Kitchen Orders view
  // (which excludes invoice_status='PRINTED') drops them automatically.
  // Without this cascade, an owner who clicked Print in the BillView would
  // see the order keep cluttering Live Kitchen long after billing.
  app.patch("/api/restaurant/:id/sessions/:token/invoice-status", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { invoice_status } = req.body;
      const db = await getTenantDb(req.params.id);
      await db.run("UPDATE table_sessions SET invoice_status = ? WHERE session_token = ?", [invoice_status, req.params.token]);
      // Cascade to child orders for terminal-ish states
      const upper = String(invoice_status || '').toUpperCase();
      if (upper === 'PRINTED' || upper === 'PAID') {
        const sess = await db.get("SELECT id FROM table_sessions WHERE session_token = ?", [req.params.token]);
        if (sess?.id) {
          await db.run(
            "UPDATE orders SET invoice_status = ? WHERE session_id = ? AND status != 'CANCELLED'",
            [upper, sess.id]
          );
        }
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to update session invoice status" });
    }
  });

  app.post("/api/restaurant/:id/invoices/manual", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_status TEXT DEFAULT 'DRAFT'").catch(() => {});
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount FLOAT DEFAULT 0").catch(() => {});
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_charge_percent FLOAT DEFAULT 0").catch(() => {});
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS gst_percent FLOAT DEFAULT 0").catch(() => {});
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS apply_gst INTEGER DEFAULT 1").catch(() => {});
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_number TEXT").catch(() => {});
      const { customer_name, customer_phone, reference, items, discount_amount, service_charge_percent, gst_percent, apply_gst } = req.body;
      const id = `MAN-${Date.now()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
      const total = (items || []).reduce((s: number, it: any) => s + Number(it.price || 0) * Number(it.quantity || 1), 0);
      const after = Math.max(0, total - Number(discount_amount || 0));
      const svc = after * Number(service_charge_percent || 0) / 100;
      const taxable = after + svc;
      const gst = apply_gst ? taxable * Number(gst_percent || 0) / 100 : 0;
      const grand = taxable + gst;
      // Sequential invoice number IF the tenant has SEQUENTIAL mode enabled.
      // Returns null in RANDOM mode → frontend falls back to legacy "#ABCD1234".
      const invoiceNumber = await generateInvoiceNumberIfSequential(db, req.params.id);
      await db.run(
        `INSERT INTO orders (id, table_number, customer_name, customer_phone, items, total_amount, discount_amount, service_charge_percent, gst_percent, apply_gst, invoice_number, status, payment_status, invoice_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', 'PENDING', 'DRAFT', NOW())`,
        [id, reference || 'Manual', customer_name || '', customer_phone || '', JSON.stringify(items || []), grand,
         Number(discount_amount || 0), Number(service_charge_percent || 0), Number(gst_percent || 0), apply_gst ? 1 : 0, invoiceNumber]
      );
      const display_number = invoiceNumber || `#${id.slice(-8).toUpperCase()}`;
      res.json({ success: true, id, grand_total: grand, invoice_number: invoiceNumber, display_number });
    } catch (err) {
      res.status(500).json({ error: "Failed to create manual invoice" });
    }
  });

  // ─── Invoice deletion (per-tenant, gated by invoice_delete_enabled flag) ──
  // Hard-deletes an invoice from the tenant DB after writing a JSON snapshot
  // to central.invoice_deletion_audit. Reports auto-update because no cache
  // tables exist — all analytics queries hit the orders table directly.
  //
  // Auth gates (defense-in-depth):
  //   1. authenticate — must have a valid JWT
  //   2. role must be OWNER, SUPER_ADMIN, or CTO
  //   3. for OWNER, req.user.restaurantId must match req.params.id
  //   4. central.restaurants.invoice_delete_enabled = 1 for this tenant
  //   5. invoice must be in a deletable state (DELIVERED / CANCELLED / PRINTED)
  //
  // Body: { reason: string }   reason is required, min 10 chars, logged
  const ADMIN_ROLES_FOR_DELETE = new Set(['SUPER_ADMIN', 'CTO']);
  const isDeletableOrderRow = (o: any): boolean => {
    if (!o) return false;
    const s = String(o.status || '').toUpperCase();
    const inv = String(o.invoice_status || '').toUpperCase();
    if (s === 'DELIVERED' || s === 'CANCELLED') return true;
    if (inv === 'PRINTED') return true;
    return false;
  };

  // Helper — verifies all 5 auth gates above. Returns null if OK, or a {status, body} to send.
  const checkInvoiceDeleteGates = async (
    req: AuthRequest,
    reasonRaw: any
  ): Promise<{ status: number; body: any } | null> => {
    const role = req.user?.role || '';
    const isAdminRole = ADMIN_ROLES_FOR_DELETE.has(role);
    if (role !== 'OWNER' && !isAdminRole) {
      return { status: 403, body: { error: 'Forbidden — invoice deletion requires OWNER, SUPER_ADMIN or CTO role' } };
    }
    if (!isAdminRole && req.user?.restaurantId !== req.params.id) {
      return { status: 403, body: { error: 'Forbidden — cannot delete another restaurant\'s invoices' } };
    }
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
    if (reason.length < 10) {
      return { status: 400, body: { error: 'A deletion reason of at least 10 characters is required' } };
    }
    const flag: any = await centralDb.get(
      "SELECT COALESCE(invoice_delete_enabled, 0) AS f FROM restaurants WHERE id = ?",
      [req.params.id]
    );
    if (!flag || Number(flag.f || 0) !== 1) {
      return { status: 403, body: { error: 'Invoice deletion is not enabled for this restaurant' } };
    }
    return null;
  };

  // DELETE one ORDER invoice (standalone — no session_id)
  app.delete("/api/restaurant/:id/invoice/order/:orderId", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { reason } = (req.body || {}) as any;
      const gateFail = await checkInvoiceDeleteGates(req, reason);
      if (gateFail) return res.status(gateFail.status).json(gateFail.body);

      const db = await getTenantDb(req.params.id);
      const order: any = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.orderId]);
      if (!order) return res.status(404).json({ error: "Invoice not found" });
      if (!isDeletableOrderRow(order)) {
        return res.status(409).json({
          error: "Invoice is in active state and cannot be deleted",
          state: { status: order.status, invoice_status: order.invoice_status }
        });
      }

      // Snapshot before delete (includes any feedback rows)
      const feedbackRows = await db.query(
        "SELECT * FROM feedback WHERE order_id = ?",
        [req.params.orderId]
      ).catch(() => []);

      const snapshot = {
        order,
        feedback: feedbackRows,
      };

      const auditId = `IDA-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      await centralDb.run(
        `INSERT INTO invoice_deletion_audit
           (id, restaurant_id, invoice_type, invoice_id, customer_name, total_amount, gst_amount, reason, deleted_by_user_id, deleted_by_role, snapshot_json)
         VALUES (?, ?, 'ORDER', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          auditId,
          req.params.id,
          req.params.orderId,
          order.customer_name || null,
          Number(order.total_amount || 0),
          Number(order.gst_amount || 0),
          String(reason).trim(),
          req.user?.id || 'unknown',
          req.user?.role || 'unknown',
          JSON.stringify(snapshot),
        ]
      );

      // Cascade-delete child rows then the order itself
      await db.run("DELETE FROM feedback WHERE order_id = ?", [req.params.orderId]).catch(() => {});
      await db.run("DELETE FROM orders WHERE id = ?", [req.params.orderId]);

      console.log(`[invoice-delete] ORDER ${req.params.orderId} from ${req.params.id} by ${req.user?.id} (${req.user?.role}) — audit ${auditId}`);
      res.json({ success: true, audit_id: auditId });
    } catch (err) {
      console.error("[invoice-delete] order error:", err);
      res.status(500).json({ error: "Failed to delete invoice" });
    }
  });

  // DELETE one SESSION invoice — cascades through all child orders + session row
  app.delete("/api/restaurant/:id/invoice/session/:sessionId", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { reason } = (req.body || {}) as any;
      const gateFail = await checkInvoiceDeleteGates(req, reason);
      if (gateFail) return res.status(gateFail.status).json(gateFail.body);

      const db = await getTenantDb(req.params.id);
      const sessionId = req.params.sessionId;

      // Accept either DB id or public session_token in the URL
      const session: any = await db.get(
        "SELECT * FROM table_sessions WHERE id = ? OR session_token = ?",
        [sessionId, sessionId]
      );
      if (!session) return res.status(404).json({ error: "Session invoice not found" });

      const orders = await db.query(
        "SELECT * FROM orders WHERE session_id = ?",
        [session.id]
      );

      // All child orders must be deletable (or session must be closed)
      const sessionStatus = String(session.status || '').toLowerCase();
      const sessionDone = sessionStatus === 'closed' || sessionStatus === 'bill_requested';
      if (!sessionDone) {
        const undeletable = orders.find((o: any) => !isDeletableOrderRow(o));
        if (undeletable) {
          return res.status(409).json({
            error: "Session contains active orders and cannot be deleted",
            session_status: session.status,
            offending_order: { id: undeletable.id, status: undeletable.status }
          });
        }
      }

      const orderIds = orders.map((o: any) => o.id);
      const feedbackRows = orderIds.length > 0
        ? await db.query(
            `SELECT * FROM feedback WHERE order_id = ANY(?)`,
            [orderIds]
          ).catch(() => [])
        : [];

      const snapshot = {
        session,
        orders,
        feedback: feedbackRows,
      };

      const sessionTotal = Number(session.bill_amount || session.final_amount || 0);
      const auditId = `IDA-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      await centralDb.run(
        `INSERT INTO invoice_deletion_audit
           (id, restaurant_id, invoice_type, invoice_id, customer_name, total_amount, gst_amount, reason, deleted_by_user_id, deleted_by_role, snapshot_json)
         VALUES (?, ?, 'SESSION', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          auditId,
          req.params.id,
          session.session_token || session.id,
          session.customer_name || null,
          sessionTotal,
          0,
          String(reason).trim(),
          req.user?.id || 'unknown',
          req.user?.role || 'unknown',
          JSON.stringify(snapshot),
        ]
      );

      // Cascade — feedback → orders → session
      if (orderIds.length > 0) {
        await db.run("DELETE FROM feedback WHERE order_id = ANY(?)", [orderIds]).catch(() => {});
        await db.run("DELETE FROM orders WHERE session_id = ?", [session.id]);
      }
      await db.run("DELETE FROM table_sessions WHERE id = ?", [session.id]);

      console.log(`[invoice-delete] SESSION ${session.session_token || session.id} from ${req.params.id} by ${req.user?.id} (${req.user?.role}) — ${orderIds.length} orders + 1 session — audit ${auditId}`);
      res.json({ success: true, audit_id: auditId, deleted_orders: orderIds.length });
    } catch (err) {
      console.error("[invoice-delete] session error:", err);
      res.status(500).json({ error: "Failed to delete session invoice" });
    }
  });

  // ─── Waiter Calls ──────────────────────────────────────────────────────────

  const ensureWaiterCallsTable = async (db: any) => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS waiter_calls (
        id TEXT PRIMARY KEY,
        table_number TEXT NOT NULL,
        table_id TEXT,
        session_token TEXT,
        customer_name TEXT,
        status TEXT DEFAULT 'pending',
        assigned_waiter_id TEXT,
        assigned_waiter_name TEXT,
        note TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      )
    `).catch(() => {});
  };

  const broadcastWs = (type: string, data: any, restaurantId: string) => {
    const wss = (global as any).__wss;
    if (wss) {
      wss.clients.forEach((client: any) => {
        if (client.readyState === 1) {
          client.send(JSON.stringify({ type, data, restaurantId }));
        }
      });
    }
  };

  // POST /api/restaurant/:id/waiter-calls — Customer creates a call (no auth)
  app.post("/api/restaurant/:id/waiter-calls", async (req: Request, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      await ensureWaiterCallsTable(db);
      const { table_number, table_id, session_token, customer_name, note } = req.body;
      if (!table_number) return res.status(400).json({ error: "table_number required" });

      const id = `CALL-${Date.now()}`;
      await db.run(
        `INSERT INTO waiter_calls (id, table_number, table_id, session_token, customer_name, status, note, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, NOW())`,
        [id, table_number, table_id || null, session_token || null, customer_name || null, note || null]
      );
      const call = await db.get("SELECT * FROM waiter_calls WHERE id = ?", [id]);
      broadcastWs('WAITER_CALL', call, req.params.id);
      res.status(201).json(call);
    } catch (err) {
      res.status(500).json({ error: "Failed to create waiter call" });
    }
  });

  // GET /api/restaurant/:id/waiter-calls — All active calls (pending + acknowledged)
  app.get("/api/restaurant/:id/waiter-calls", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      await ensureWaiterCallsTable(db);
      const calls = await db.query(
        `SELECT * FROM waiter_calls WHERE status IN ('pending', 'acknowledged') ORDER BY created_at ASC`
      );
      res.json(calls);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch waiter calls" });
    }
  });

  // PATCH /api/restaurant/:id/waiter-calls/:callId — Assign or resolve a call
  app.patch("/api/restaurant/:id/waiter-calls/:callId", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      await ensureWaiterCallsTable(db);
      const { status, assigned_waiter_id, assigned_waiter_name } = req.body;

      let query = "UPDATE waiter_calls SET ";
      const params: any[] = [];
      if (status !== undefined)               { query += "status = ?, ";               params.push(status); }
      if (assigned_waiter_id !== undefined)   { query += "assigned_waiter_id = ?, ";   params.push(assigned_waiter_id); }
      if (assigned_waiter_name !== undefined) { query += "assigned_waiter_name = ?, "; params.push(assigned_waiter_name); }
      if (status === 'resolved')              { query += "resolved_at = NOW(), "; }
      if (params.length === 0) return res.status(400).json({ error: "Nothing to update" });
      query = query.slice(0, -2) + " WHERE id = ?";
      params.push(req.params.callId);
      await db.run(query, params);

      const call = await db.get("SELECT * FROM waiter_calls WHERE id = ?", [req.params.callId]);
      broadcastWs('WAITER_CALL_UPDATE', call, req.params.id);
      res.json(call);
    } catch (err) {
      res.status(500).json({ error: "Failed to update waiter call" });
    }
  });

  // Orders: Get Single Order
  app.get("/api/orders/:id", async (req: Request, res: Response) => {
    try {
      const restaurantId = req.query.restaurantId as string;
      if (!restaurantId) return res.status(400).json({ error: "Restaurant ID required" });
      
      const db = await getTenantDb(restaurantId);
      const order = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);
      
      if (!order) return res.status(404).json({ error: "Order not found" });
      
      // Parse items if it's a string
      if (typeof order.items === 'string') {
        try {
          order.items = JSON.parse(order.items);
        } catch (e) {
          order.items = [];
        }
      }
      
      res.json(order);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch order" });
    }
  });

  // Orders: Create Order (mode-aware: prepaid holds for payment, postpaid goes to KDS immediately)
  app.post("/api/restaurant/:id/orders", async (req: Request, res: Response) => {
    try {
      const {
        table_number, tableNumber,
        items,
        total_amount, totalAmount,
        gst_amount, gstAmount,
        customer_name, customerName,
        customer_phone, customerPhone,
        customer_email, customerEmail,
        payment_method, paymentMethod,
        // Postpaid session fields
        session_token, session_id,
        checkout_mode: bodyCheckoutMode,
        // Cloud-kitchen / online-delivery: structured customer address fields
        customer_address_line1, customerAddressLine1,
        customer_address_line2, customerAddressLine2,
        customer_city, customerCity,
        customer_pincode, customerPincode,
        customer_landmark, customerLandmark,
      } = req.body;

      const db = await getTenantDb(req.params.id);

      // Migration: Ensure new columns exist
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_email TEXT");
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS session_id TEXT");
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_mode TEXT DEFAULT 'postpaid'");
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS round_number INTEGER DEFAULT 1");
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS kitchen_status TEXT DEFAULT 'queued'");
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS chef_id TEXT");
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS chef_name TEXT");
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS eta TEXT");
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_number TEXT");
      await db.exec("ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS invoice_number TEXT");
      // Cloud-kitchen / online-delivery: structured address (idempotent)
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_address_line1 TEXT");
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_address_line2 TEXT");
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_city TEXT");
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_pincode TEXT");
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_landmark TEXT");
      // GST persistence on the ORDER row — the manual-invoice and invoice-edit
      // endpoints already migrate these, but a fresh tenant whose first traffic
      // is a customer order would hit a 500 because the columns referenced in
      // the INSERT below didn't exist yet. Adding them here closes that gap.
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS gst_percent FLOAT DEFAULT 0");
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS apply_gst INTEGER DEFAULT 1");
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_status TEXT DEFAULT 'DRAFT'");

      // Resolve restaurant checkout_mode (body overrides, then DB, then default)
      let checkoutMode = bodyCheckoutMode;
      if (!checkoutMode) {
        const resto = await centralDb.get("SELECT checkout_mode FROM restaurants WHERE id = ?", [req.params.id]);
        checkoutMode = resto?.checkout_mode || 'postpaid';
      }

      // Date.now() is 1-ms granular — N parallel requests in the same ms would
      // collide on PRIMARY KEY violation (caught us when 5+ cloud-kitchen orders
      // landed simultaneously, only the first INSERT succeeded). Append a 4-char
      // random suffix the same way manual invoices already do (server.ts:5008).
      const id = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

      const finalTableNumber  = table_number || tableNumber;
      const finalTotalAmount  = total_amount || totalAmount;
      const finalGstAmount    = gst_amount || gstAmount;
      const finalCustomerName = customer_name || customerName;
      const finalCustomerPhone= customer_phone || customerPhone;
      const finalCustomerEmail= customer_email || customerEmail;
      const finalPaymentMethod= payment_method || paymentMethod;
      // Cloud-kitchen structured address fields (snake_case wins over camelCase fallback)
      const finalAddrLine1    = customer_address_line1 || customerAddressLine1 || null;
      const finalAddrLine2    = customer_address_line2 || customerAddressLine2 || null;
      const finalCity         = customer_city || customerCity || null;
      const finalPincode      = customer_pincode || customerPincode || null;
      const finalLandmark     = customer_landmark || customerLandmark || null;

      // ── Resolve session for postpaid ──────────────────────────────────────
      let finalSessionId: string | null = session_id || null;
      let roundNumber = 1;

      if (checkoutMode === 'postpaid') {
        // Resolve session by token if provided
        if (session_token && !finalSessionId) {
          const sess = await db.get(
            "SELECT id FROM table_sessions WHERE session_token = ? AND status = 'open'",
            [session_token]
          );
          if (sess) finalSessionId = sess.id;
        }
        // Count existing rounds in the session
        if (finalSessionId) {
          const countRow = await db.get(
            "SELECT COUNT(*) as cnt FROM orders WHERE session_id = ?",
            [finalSessionId]
          );
          roundNumber = (Number(countRow?.cnt) || 0) + 1;

          // Update session customer info + round_count + (lazy) invoice_number.
          // Defensively re-create the sequences table inline (idempotent).
          await db.exec(`CREATE TABLE IF NOT EXISTS sequences (name TEXT PRIMARY KEY, current_value INTEGER NOT NULL DEFAULT 0)`).catch(() => {});
          const sessionInvoiceNumber = await generateInvoiceNumberIfSequential(db, req.params.id);
          await db.run(
            `UPDATE table_sessions
                SET customer_name  = COALESCE(customer_name, ?),
                    customer_phone = COALESCE(customer_phone, ?),
                    invoice_number = COALESCE(invoice_number, ?),
                    round_count    = ?
              WHERE id = ?`,
            [
              finalCustomerName || null,
              finalCustomerPhone || null,
              sessionInvoiceNumber,
              roundNumber,
              finalSessionId,
            ]
          );
          console.log(`[orders-post] session=${finalSessionId} round=${roundNumber} invoice_number_generated=${sessionInvoiceNumber || '(null)'}`);
        }
      }

      // ── kitchen_status depends on mode ───────────────────────────────────
      // Prepaid:        hold order until payment confirmed.
      // Postpaid:       queue immediately (paid at table later).
      // Cloud_kitchen:  auto-finalize — payment captured up-front by the customer
      //                 in the QR flow, kitchen starts cooking right away.
      const kitchenStatus = checkoutMode === 'prepaid' ? 'held_for_payment' : 'queued';
      const orderStatus   = checkoutMode === 'prepaid' ? 'PENDING' : 'CONFIRMED';

      // Cloud-kitchen orders are billed immediately on placement — invoice
      // is auto-generated, no waiter intervention. Mark invoice_status PRINTED
      // up-front so it shows up on the owner's invoice list and KOT prints.
      const invoiceStatus = checkoutMode === 'cloud_kitchen' ? 'PRINTED' : 'DRAFT';

      // Sequential invoice number for the ORDER row.
      //  • Standalone postpaid sessions assign at session level → null here.
      //  • Cloud_kitchen ALWAYS gets a sequential number (delivery + GST audit
      //    requirement) regardless of the tenant's RANDOM/SEQUENTIAL setting.
      //  • Prepaid / manual on-demand follow the tenant setting.
      const orderInvoiceNumber = !finalSessionId
        ? await generateInvoiceNumberIfSequential(
            db,
            req.params.id,
            checkoutMode === 'cloud_kitchen' /* forceSequential */
          )
        : null;

      // ── Persist gst_percent + apply_gst on the order ──────────────────────
      // Without this, the Edit Invoice modal reads gst_percent=0 (column
      // default) and the recomputed grand total drops the GST line — even
      // though gst_amount IS stored. Look up the restaurant's GST settings
      // and store them alongside so the modal renders correctly.
      // Defensive: a failure here must NOT block the order INSERT.
      let orderGstPercent = 0;
      let orderApplyGst = 0;
      try {
        const restGst: any = await centralDb.get(
          "SELECT is_gst_enabled, gst_percentage FROM restaurants WHERE id = ?",
          [req.params.id]
        );
        if (restGst?.is_gst_enabled) {
          orderGstPercent = Number(restGst.gst_percentage || 0);
          orderApplyGst = 1;
        }
      } catch (gstErr) {
        console.warn(`[orders-post] Failed to read GST settings for ${req.params.id}; storing defaults:`, gstErr);
      }

      await db.run(`
        INSERT INTO orders
          (id, table_number, items, total_amount, gst_amount, status, customer_name, customer_phone,
           customer_email, payment_method, session_id, checkout_mode, round_number, kitchen_status, invoice_number,
           gst_percent, apply_gst, invoice_status,
           customer_address_line1, customer_address_line2, customer_city, customer_pincode, customer_landmark)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        id,
        finalTableNumber || null,
        JSON.stringify(items),
        finalTotalAmount,
        finalGstAmount || 0,
        orderStatus,
        finalCustomerName || null,
        finalCustomerPhone || null,
        finalCustomerEmail || null,
        finalPaymentMethod || null,
        finalSessionId,
        checkoutMode,
        roundNumber,
        kitchenStatus,
        orderInvoiceNumber,
        orderGstPercent,
        orderApplyGst,
        invoiceStatus,
        finalAddrLine1,
        finalAddrLine2,
        finalCity,
        finalPincode,
        finalLandmark,
      ]);

      res.json({
        success: true,
        id,
        orderId: id,
        checkout_mode: checkoutMode,
        kitchen_status: kitchenStatus,
        invoice_number: orderInvoiceNumber,
        invoice_status: invoiceStatus,
      });

      // ── Inventory: auto-deduct ingredients per recipe (non-blocking) ─────
      // Fire-and-forget — must NEVER fail an order. If recipes don't exist for
      // an item, that's fine; we silently skip. If the deduction throws, the
      // order is already INSERTed and the response sent.
      deductIngredientsForOrder(db, id, items, req.params.id).catch(err => {
        console.warn(`[inventory] Deduction failed for order ${id}:`, err);
      });

      // ── Notifications (non-blocking) ─────────────────────────────────────
      const itemLabels = (items as any[]).map((i: any) =>
        `${i.name || i.item_name || 'Item'} x${i.quantity ?? 1}`
      );

      // Postpaid       → notify owner + waiters immediately (order is in kitchen)
      // Prepaid        → notify only after payment webhook confirms (handled in /payment endpoint)
      // Cloud_kitchen  → notify owner immediately with full delivery details (name + structured address)
      if (checkoutMode === 'postpaid') {
        triggerNotification(req.params.id, 'ORDER_PLACED', {
          orderId: id, tableNumber: finalTableNumber,
          items: itemLabels, total: finalTotalAmount,
          customerEmail: finalCustomerEmail, customerPhone: finalCustomerPhone,
        }).catch(() => {});
        if (finalCustomerEmail || finalCustomerPhone) {
          triggerNotification(req.params.id, 'CUSTOMER_ORDER_CONFIRMATION', {
            orderId: id, items: itemLabels, total: finalTotalAmount,
            customerEmail: finalCustomerEmail, customerPhone: finalCustomerPhone,
          }).catch(() => {});
        }
      } else if (checkoutMode === 'cloud_kitchen') {
        // Build a single human-readable delivery address from structured parts.
        const addressParts = [
          finalAddrLine1, finalAddrLine2, finalCity,
          finalPincode ? `PIN ${finalPincode}` : null,
          finalLandmark ? `Landmark: ${finalLandmark}` : null,
        ].filter(Boolean);
        const fullAddress = addressParts.join(', ');

        triggerNotification(req.params.id, 'ORDER_PLACED', {
          orderId: id,
          invoiceNumber: orderInvoiceNumber,
          tableNumber: 'Online (Cloud Kitchen)',
          items: itemLabels,
          itemsDetailed: items,
          total: finalTotalAmount,
          gstAmount: finalGstAmount || 0,
          paymentMethod: finalPaymentMethod || '—',
          customerName: finalCustomerName,
          customerEmail: finalCustomerEmail,
          customerPhone: finalCustomerPhone,
          customerAddress: fullAddress,
          customerAddressLine1: finalAddrLine1,
          customerAddressLine2: finalAddrLine2,
          customerCity: finalCity,
          customerPincode: finalPincode,
          customerLandmark: finalLandmark,
          orderType: 'cloud_kitchen',
        }).catch(() => {});

        if (finalCustomerEmail || finalCustomerPhone) {
          triggerNotification(req.params.id, 'CUSTOMER_ORDER_CONFIRMATION', {
            orderId: id,
            invoiceNumber: orderInvoiceNumber,
            items: itemLabels,
            total: finalTotalAmount,
            customerEmail: finalCustomerEmail,
            customerPhone: finalCustomerPhone,
            orderType: 'cloud_kitchen',
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.error("Create order error:", err);
      res.status(500).json({ error: "Failed to create order" });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ── Multi-platform Delivery: Phase 3 — Inbound webhook + createOrder ────
  // ═════════════════════════════════════════════════════════════════════════
  // Single endpoint receives orders / status updates from every delivery
  // platform. Channel-specific signature verification + payload parsing are
  // delegated to the registered DeliveryChannelAdapter for that channel.
  //
  // Defence layers (each fails closed):
  //   1. Adapter must be registered for this channel
  //   2. ATITHI_CREDENTIAL_KEY must be configured for credential decryption
  //   3. Idempotency key dedup via webhook_inbox (replay returns cached response)
  //   4. HMAC / Ed25519 / channel-specific signature verification
  //   5. Server-side price validation (recompute total from channel_prices)
  //   6. Item mapping resolution (unmapped items skipped + alert)

  /**
   * Build a per-call AdapterContext: loads the channel_settings row and
   * decrypts every active integration_credentials row for this (tenant, channel).
   */
  async function loadAdapterContext(
    db: DbInterface,
    restaurantId: string,
    channel: string,
  ): Promise<AdapterContext> {
    const cs: any = await db.get(
      "SELECT * FROM channel_settings WHERE channel = ?",
      [channel]
    );
    const channelSettings = cs ? {
      channel: channel as ChannelId,
      is_active: Number(cs.is_active || 0),
      default_markup_percent: Number(cs.default_markup_percent || 25),
      commission_percent: Number(cs.commission_percent || 25),
      packaging_charge: Number(cs.packaging_charge || 0),
      min_order_amount: Number(cs.min_order_amount || 0),
      prep_time_minutes: Number(cs.prep_time_minutes || 20),
      webhook_url_inbound: cs.webhook_url_inbound || null,
      brand_display_name: cs.brand_display_name || null,
      min_margin_floor_percent: Number(cs.min_margin_floor_percent || 5),
    } : {
      channel: channel as ChannelId,
      is_active: 0,
      default_markup_percent: 25,
      commission_percent: 25,
      packaging_charge: 0,
      min_order_amount: 0,
      prep_time_minutes: 20,
      webhook_url_inbound: null,
      brand_display_name: null,
      min_margin_floor_percent: 5,
    };

    const credentials: Record<string, string> = {};
    if (isCredentialKeyConfigured()) {
      const rows: any[] = await db.query(
        `SELECT credential_type, ciphertext, iv, auth_tag
           FROM integration_credentials
          WHERE channel = ? AND is_active = 1`,
        [channel]
      );
      for (const r of rows) {
        try {
          credentials[String(r.credential_type)] = decryptCredential({
            ciphertext: r.ciphertext, iv: r.iv, auth_tag: r.auth_tag,
          });
        } catch (err) {
          console.warn(`[integrations] Failed to decrypt ${channel} ${r.credential_type}:`, (err as any)?.message);
        }
      }
    }
    return { restaurantId, channelSettings, credentials };
  }

  /**
   * Resolve a platform's external item id to our local menu.id by reading
   * menu.external_ids JSONB. Returns null if no mapping exists.
   */
  async function resolveLocalMenuItemId(
    db: DbInterface,
    channel: string,
    externalItemId: string,
  ): Promise<string | null> {
    if (!externalItemId) return null;
    const row: any = await db.get(
      `SELECT id FROM menu WHERE external_ids->>? = ? LIMIT 1`,
      [channel, String(externalItemId)]
    ).catch(() => null);
    return row?.id || null;
  }

  /**
   * Compute the effective price for a (menu_item, channel) pair. Single
   * source of truth — mirrors the server.ts /channel-prices endpoint logic.
   */
  async function computeChannelEffectivePrice(
    db: DbInterface,
    menuItemId: string,
    channel: string,
  ): Promise<{ price: number; basePrice: number } | null> {
    const item: any = await db.get(
      "SELECT id, price, price_full FROM menu WHERE id = ?",
      [menuItemId]
    );
    if (!item) return null;
    const basePrice = Number(item.price_full ?? item.price ?? 0);
    const cp: any = await db.get(
      "SELECT * FROM channel_prices WHERE menu_item_id = ? AND channel = ?",
      [menuItemId, channel]
    );
    if (cp && Number(cp.is_listed) === 0) return { price: 0, basePrice };
    if (cp?.price_override != null) return { price: Number(cp.price_override), basePrice };
    if (cp?.markup_percent != null) {
      return { price: Math.round(basePrice * (1 + Number(cp.markup_percent) / 100) * 100) / 100, basePrice };
    }
    const cs: any = await db.get(
      "SELECT default_markup_percent FROM channel_settings WHERE channel = ?",
      [channel]
    );
    const markup = Number(cs?.default_markup_percent ?? 25);
    return { price: Math.round(basePrice * (1 + markup / 100) * 100) / 100, basePrice };
  }

  /**
   * Shared internal "create an order" helper. Used by the inbound webhook
   * handler. Mirrors the public POST /api/restaurant/:id/orders flow but
   * without auth and accepting pre-resolved external_platform fields.
   *
   * Returns the order id + invoice number on success. Caller responsible
   * for any HTTP response shape.
   */
  async function createOrderInternal(
    db: DbInterface,
    restaurantId: string,
    opts: {
      items: any[];
      total_amount: number;
      gst_amount: number;
      customer_name: string | null;
      customer_phone: string | null;
      customer_email: string | null;
      payment_method: string | null;
      address_line1: string | null;
      address_line2: string | null;
      city: string | null;
      pincode: string | null;
      landmark: string | null;
      // Platform-order specifics
      external_platform: ChannelId;
      external_order_id: string;
      external_id_hash: string;
      external_payload: any;
      commission_amount: number;
      net_payout_amount: number;
      gst_collected_by: 'RESTAURANT' | 'PLATFORM';
      rider_name: string | null;
      rider_phone: string | null;
    },
  ): Promise<{ id: string; invoice_number: string | null }> {
    // Generate a fresh order id (matches the existing public POST format)
    const id = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    // Cloud-kitchen mode auto-prints the invoice & sequential numbers
    const invoiceNumber = await generateInvoiceNumberIfSequential(db, restaurantId, /* forceSequential */ true);

    // Read GST settings for the order row (same pattern as public POST)
    let orderGstPercent = 0;
    let orderApplyGst = 0;
    try {
      const restGst: any = await centralDb.get(
        "SELECT is_gst_enabled, gst_percentage FROM restaurants WHERE id = ?",
        [restaurantId]
      );
      if (restGst?.is_gst_enabled) {
        orderGstPercent = Number(restGst.gst_percentage || 0);
        orderApplyGst = 1;
      }
    } catch { /* defaults remain 0 */ }

    await db.run(`
      INSERT INTO orders
        (id, table_number, items, total_amount, gst_amount, status, customer_name, customer_phone,
         customer_email, payment_method, session_id, checkout_mode, round_number, kitchen_status, invoice_number,
         gst_percent, apply_gst, invoice_status,
         customer_address_line1, customer_address_line2, customer_city, customer_pincode, customer_landmark,
         external_platform, external_order_id, external_id_hash, external_payload,
         commission_amount, net_payout_amount, gst_collected_by, rider_name, rider_phone)
      VALUES (?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?, NULL, 'cloud_kitchen', 1, 'queued', ?,
              ?, ?, 'PRINTED',
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?, ?, ?)
    `, [
      id,
      `Online (${opts.external_platform})`,
      JSON.stringify(opts.items),
      opts.total_amount,
      opts.gst_amount || 0,
      opts.customer_name,
      opts.customer_phone,
      opts.customer_email,
      opts.payment_method,
      invoiceNumber,
      orderGstPercent,
      orderApplyGst,
      opts.address_line1,
      opts.address_line2,
      opts.city,
      opts.pincode,
      opts.landmark,
      opts.external_platform,
      opts.external_order_id,
      opts.external_id_hash,
      JSON.stringify(opts.external_payload || null),
      opts.commission_amount,
      opts.net_payout_amount,
      opts.gst_collected_by,
      opts.rider_name,
      opts.rider_phone,
    ]);

    // Fire-and-forget inventory deduction (matches public POST behaviour)
    deductIngredientsForOrder(db, id, opts.items, restaurantId).catch(err => {
      console.warn(`[inventory] Deduction failed for platform order ${id}:`, err);
    });

    // Broadcast WS so KDS lights up
    try {
      broadcastWs('PLATFORM_ORDER_RECEIVED', {
        id,
        external_platform: opts.external_platform,
        external_order_id: opts.external_order_id,
        invoice_number: invoiceNumber,
        items: opts.items,
        total_amount: opts.total_amount,
        customer_name: opts.customer_name,
        customer_phone: opts.customer_phone,
      }, restaurantId);
    } catch { /* non-fatal */ }

    return { id, invoice_number: invoiceNumber };
  }

  // ─── Webhook endpoint ───────────────────────────────────────────────────
  //
  // POST /api/integrations/:channel/webhook/:restaurantId
  //   Headers: X-Signature (or platform-specific name normalised by adapter)
  //   Body:    raw JSON (kept as Buffer for HMAC verification — DO NOT JSON.parse before verifying)
  //   Query:   ?event=order|status|cancel  (default: order)
  //
  // Always responds 200 on successful processing — platforms retry on non-2xx.
  // 401 on signature failure, 422 on price-validation failure, 4xx on schema errors.
  app.post(
    "/api/integrations/:channel/webhook/:restaurantId",
    express.raw({ type: 'application/json', limit: '2mb' }),
    async (req: Request, res: Response) => {
      const tStart = Date.now();
      const channel = String(req.params.channel || '').toUpperCase();
      const restaurantId = String(req.params.restaurantId || '');
      const eventHint = String(req.query.event || 'order').toLowerCase();
      const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

      // Helper: write the final processing result to webhook_inbox before responding
      const finishInbox = async (db: DbInterface, idemKey: string, status: number, body: any, err?: string) => {
        try {
          await db.run(
            `UPDATE webhook_inbox
                SET processed_at = CURRENT_TIMESTAMP, result_status = ?, result_body = ?, error_message = ?
              WHERE idempotency_key = ?`,
            [status, JSON.stringify(body), err || null, idemKey]
          );
        } catch { /* swallow — inbox write must not fail the response */ }
      };

      try {
        // 1. Validate channel id
        if (!ALL_CHANNEL_IDS.includes(channel as ChannelId)) {
          return res.status(400).json({ error: `Unknown channel: ${channel}` });
        }

        // 2. Adapter must be registered
        const adapter = tryGetAdapter(channel as ChannelId);
        if (!adapter) {
          return res.status(404).json({
            error: `No adapter registered for ${channel}. Awaiting partner onboarding.`,
          });
        }

        // 3. Credential key must be configured (for any decryption the adapter needs)
        if (!isCredentialKeyConfigured()) {
          return res.status(503).json({
            error: 'Integration credential storage is not configured (missing ATITHI_CREDENTIAL_KEY env var).',
          });
        }

        const db = await getTenantDb(restaurantId);
        const ctx = await loadAdapterContext(db, restaurantId, channel);

        // 4. Compute idempotency key from signature header
        // Different platforms use different signature header names; normalise the most common ones.
        const sigHeader = String(
          req.headers['x-signature'] ||
          req.headers['x-hub-signature-256'] ||
          req.headers['x-mock-signature'] ||
          req.headers['x-zomato-signature'] ||
          req.headers['x-swiggy-signature'] ||
          req.headers['x-urbanpiper-signature'] ||
          ''
        );
        if (!sigHeader) {
          return res.status(400).json({ error: 'Missing signature header' });
        }
        const idempotencyKey = computeWebhookIdempotencyKey(channel, sigHeader);

        // 5. ON CONFLICT DO NOTHING — replay returns cached response
        const insertedRows: any[] = await db.query(
          `INSERT INTO webhook_inbox
             (idempotency_key, channel, event_type, raw_payload, signature_verified, received_at)
           VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING idempotency_key`,
          [idempotencyKey, channel, eventHint.toUpperCase(), rawBody.toString('utf8')]
        );
        if (insertedRows.length === 0) {
          // Already processed — return cached response
          const cached: any = await db.get(
            "SELECT result_status, result_body FROM webhook_inbox WHERE idempotency_key = ?",
            [idempotencyKey]
          );
          if (cached?.processed_at) {
            const status = Number(cached.result_status) || 200;
            try { return res.status(status).json(JSON.parse(cached.result_body || '{}')); }
            catch { return res.status(status).send(cached.result_body || ''); }
          }
          // Race: row exists but not yet processed → tell caller to retry
          return res.status(202).json({ status: 'processing', message: 'Webhook is already being processed; retry shortly.' });
        }

        // 6. Verify signature via the adapter
        try {
          await adapter.verifyWebhookSignature(rawBody, req.headers as Record<string, string>, ctx);
        } catch (sigErr: any) {
          await finishInbox(db, idempotencyKey, 401, { error: 'Signature verification failed' }, sigErr?.message);
          // Track repeated failures for the WEBHOOK_SIGNATURE_FAILURE alert
          const recent: any = await db.get(
            `SELECT COUNT(*) AS c FROM webhook_inbox
               WHERE channel = ? AND signature_verified = 0
                 AND received_at > NOW() - INTERVAL '10 minutes'`,
            [channel]
          ).catch(() => null);
          if (Number(recent?.c || 0) >= 5) {
            triggerNotification(restaurantId, 'WEBHOOK_SIGNATURE_FAILURE', {
              channel, count: Number(recent.c), windowMinutes: 10,
            }).catch(() => {});
          }
          return res.status(401).json({ error: 'Signature verification failed' });
        }

        // Signature OK — flag the row
        await db.run(
          "UPDATE webhook_inbox SET signature_verified = 1 WHERE idempotency_key = ?",
          [idempotencyKey]
        );

        // 7. Parse the JSON body
        let payload: any;
        try {
          payload = JSON.parse(rawBody.toString('utf8'));
        } catch (parseErr: any) {
          await finishInbox(db, idempotencyKey, 400, { error: 'Invalid JSON' }, parseErr?.message);
          return res.status(400).json({ error: 'Invalid JSON body' });
        }

        // 8. Route by event type
        if (eventHint === 'order') {
          // ─── ORDER_CREATED ─────────────────────────────────────────────
          const normalised: NormalizedOrder = await adapter.parseInboundOrder(payload, ctx);

          // Resolve every item's local menu id
          const unmappedItems: string[] = [];
          for (const it of normalised.items) {
            if (!it.localMenuItemId && it.externalItemId) {
              const localId = await resolveLocalMenuItemId(db, channel, it.externalItemId);
              if (localId) it.localMenuItemId = localId;
              else unmappedItems.push(`${it.name} (${it.externalItemId})`);
            }
          }
          if (unmappedItems.length > 0) {
            triggerNotification(restaurantId, 'ITEM_MAPPING_ALERT', {
              channel, externalOrderId: normalised.externalOrderId,
              unmappedItems,
            }).catch(() => {});
          }

          // Filter to only mapped items for the deduction path; keep raw line
          // entries in the order JSON so the receipt shows what the customer
          // actually paid for.
          const orderItemsForRow = normalised.items.map(it => ({
            id: it.localMenuItemId || null,
            external_item_id: it.externalItemId,
            name: it.name,
            quantity: it.quantity,
            size: it.size || 'FULL',
            price: it.unitPrice,
          }));

          // 9. Server-side price validation (≤ ₹1 tolerance per line)
          // Recompute expected total from channel_prices for items we can map.
          const validateMissingMaps = false; // Don't fail if some items unmapped — already alerted
          let recomputedSubtotal = 0;
          let mismatchDetail: string | null = null;
          for (const it of normalised.items) {
            if (!it.localMenuItemId) continue;
            const eff = await computeChannelEffectivePrice(db, it.localMenuItemId, channel);
            if (!eff) continue;
            const expectedLine = eff.price * Number(it.quantity || 1);
            recomputedSubtotal += expectedLine;
            const lineDelta = Math.abs(Number(it.totalPrice || 0) - expectedLine);
            if (lineDelta > 1) {
              mismatchDetail = `Item "${it.name}" platform price ₹${it.totalPrice} differs from server-recomputed ₹${expectedLine.toFixed(2)} (Δ ₹${lineDelta.toFixed(2)})`;
              break;
            }
          }
          if (mismatchDetail) {
            const body = {
              error: 'Server-side price validation failed',
              detail: mismatchDetail,
              externalOrderId: normalised.externalOrderId,
            };
            await finishInbox(db, idempotencyKey, 422, body, mismatchDetail);
            return res.status(422).json(body);
          }

          // 10. Compute external_id_hash (canonical key for dedup index)
          const externalIdHash = require('crypto')
            .createHash('sha256')
            .update(`${channel}:${normalised.externalOrderId}`)
            .digest('hex');

          // 11. Persist via shared helper
          let created: { id: string; invoice_number: string | null };
          try {
            created = await createOrderInternal(db, restaurantId, {
              items: orderItemsForRow,
              total_amount: Number(normalised.total || 0),
              gst_amount: Number(normalised.taxes || 0),
              customer_name: normalised.customerName || null,
              customer_phone: normalised.customerPhone || null,
              customer_email: null,
              payment_method: normalised.paymentMode === 'PREPAID' ? 'PREPAID' : 'COD',
              address_line1: normalised.customerAddress?.line1 || null,
              address_line2: normalised.customerAddress?.line2 || null,
              city: normalised.customerAddress?.city || null,
              pincode: normalised.customerAddress?.pincode || null,
              landmark: normalised.customerAddress?.landmark || null,
              external_platform: channel as ChannelId,
              external_order_id: normalised.externalOrderId,
              external_id_hash: externalIdHash,
              external_payload: normalised.rawPayload,
              commission_amount: Number(normalised.commissionAmount || 0),
              net_payout_amount: Number(normalised.netPayoutAmount || 0),
              gst_collected_by: normalised.gstCollectedBy,
              rider_name: normalised.rider?.name || null,
              rider_phone: normalised.rider?.phone || null,
            });
          } catch (insertErr: any) {
            // PG UNIQUE violation on external_id_hash → already exists. Treat as idempotent success.
            if (String(insertErr?.message || '').match(/duplicate|unique/i)) {
              const existing: any = await db.get(
                "SELECT id, invoice_number FROM orders WHERE external_id_hash = ?",
                [externalIdHash]
              );
              const body = {
                success: true, deduplicated: true,
                id: existing?.id, invoice_number: existing?.invoice_number,
              };
              await finishInbox(db, idempotencyKey, 200, body);
              return res.status(200).json(body);
            }
            await finishInbox(db, idempotencyKey, 500, { error: 'Order INSERT failed' }, insertErr?.message);
            console.error('[webhook] createOrderInternal error:', insertErr);
            return res.status(500).json({ error: 'Failed to persist order' });
          }

          // 12. Update webhook_inbox with the resolved external_order_id
          await db.run(
            "UPDATE webhook_inbox SET external_order_id = ? WHERE idempotency_key = ?",
            [normalised.externalOrderId, idempotencyKey]
          ).catch(() => {});

          // 13. Notification
          triggerNotification(restaurantId, 'NEW_PLATFORM_ORDER', {
            channel,
            externalOrderId: normalised.externalOrderId,
            orderId: created.id,
            invoiceNumber: created.invoice_number,
            items: orderItemsForRow.map(i => `${i.name} x${i.quantity}`),
            total: Number(normalised.total || 0),
            customerName: normalised.customerName,
            customerPhone: normalised.customerPhone,
            address: [normalised.customerAddress?.line1, normalised.customerAddress?.city, normalised.customerAddress?.pincode].filter(Boolean).join(', '),
            paymentMode: normalised.paymentMode,
            unmappedCount: unmappedItems.length,
          }).catch(() => {});

          const body = {
            success: true, id: created.id, invoice_number: created.invoice_number,
            unmapped_items: unmappedItems.length, ms: Date.now() - tStart,
          };
          await finishInbox(db, idempotencyKey, 200, body);
          return res.status(200).json(body);
        }

        if (eventHint === 'status' || eventHint === 'cancel') {
          // ─── STATUS_UPDATE / RIDER_ASSIGNED / ORDER_CANCELLED ──────────
          const upd = await adapter.parseInboundStatus(payload, ctx);
          const externalIdHash = require('crypto')
            .createHash('sha256')
            .update(`${channel}:${upd.externalOrderId}`)
            .digest('hex');

          const localOrder: any = await db.get(
            "SELECT id, status, inventory_reverted FROM orders WHERE external_id_hash = ?",
            [externalIdHash]
          );
          if (!localOrder) {
            const body = { error: 'Local order not found for external id', externalOrderId: upd.externalOrderId };
            await finishInbox(db, idempotencyKey, 404, body);
            return res.status(404).json(body);
          }

          const updates: Record<string, any> = { status: upd.newStatus };
          if (upd.rider?.name) updates.rider_name = upd.rider.name;
          if (upd.rider?.phone) updates.rider_phone = upd.rider.phone;
          if (upd.newStatus === 'DELIVERED') updates.kitchen_status = 'delivered';
          if (upd.newStatus === 'READY') updates.kitchen_status = 'ready';

          const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
          const params = [...Object.values(updates), localOrder.id];
          await db.run(`UPDATE orders SET ${setClause} WHERE id = ?`, params);

          // Cancellation → reuse existing reversal (idempotent via inventory_reverted flag)
          if (upd.newStatus === 'CANCELLED') {
            try {
              await revertIngredientsForOrder(db, localOrder.id);
            } catch (revertErr) {
              console.warn(`[webhook] Reversal failed for ${localOrder.id}:`, revertErr);
            }
            triggerNotification(restaurantId, 'PLATFORM_ORDER_CANCELLED', {
              channel, externalOrderId: upd.externalOrderId, orderId: localOrder.id,
            }).catch(() => {});
          } else if (upd.rider?.name || upd.rider?.phone) {
            triggerNotification(restaurantId, 'RIDER_ASSIGNED', {
              channel, externalOrderId: upd.externalOrderId, orderId: localOrder.id,
              riderName: upd.rider?.name, riderPhone: upd.rider?.phone,
            }).catch(() => {});
          }

          try {
            broadcastWs('PLATFORM_ORDER_UPDATE', {
              id: localOrder.id,
              external_platform: channel,
              external_order_id: upd.externalOrderId,
              status: upd.newStatus,
              rider_name: upd.rider?.name,
              rider_phone: upd.rider?.phone,
            }, restaurantId);
          } catch { /* non-fatal */ }

          const body = { success: true, id: localOrder.id, status: upd.newStatus, ms: Date.now() - tStart };
          await finishInbox(db, idempotencyKey, 200, body);
          return res.status(200).json(body);
        }

        // Unknown event hint — record + 400
        const body = { error: `Unsupported event: ${eventHint}` };
        await finishInbox(db, idempotencyKey, 400, body);
        return res.status(400).json(body);
      } catch (err: any) {
        console.error('[webhook] Unhandled error:', err);
        // Best effort to mark the inbox row failed (we may not have a key here)
        return res.status(500).json({ error: 'Unhandled webhook error', detail: err?.message });
      }
    }
  );

  // Orders: Update Status
  app.patch("/api/orders/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      // Ensure chef/eta columns exist (in case migration hasn't run yet for this tenant)
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS chef_id TEXT").catch(() => {});
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS chef_name TEXT").catch(() => {});
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS eta TEXT").catch(() => {});
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS kitchen_status TEXT DEFAULT 'queued'").catch(() => {});

      const { status, payment_status, payment_method, kitchen_status, chef_id, chef_name, eta } = req.body;

      let query = "UPDATE orders SET ";
      const params: any[] = [];
      if (status) {
        query += "status = ?, ";
        params.push(status);
      }
      if (payment_status) {
        query += "payment_status = ?, ";
        params.push(payment_status);
      }
      if (payment_method) {
        query += "payment_method = ?, ";
        params.push(payment_method);
      }
      if (kitchen_status) {
        query += "kitchen_status = ?, ";
        params.push(kitchen_status);
      }
      if (chef_id !== undefined) {
        query += "chef_id = ?, ";
        params.push(chef_id);
      }
      if (chef_name !== undefined) {
        query += "chef_name = ?, ";
        params.push(chef_name);
      }
      if (eta !== undefined) {
        query += "eta = ?, ";
        params.push(eta);
      }
      if (params.length === 0) return res.status(400).json({ error: "Nothing to update" });
      query = query.slice(0, -2) + " WHERE id = ?";
      params.push(req.params.id);

      await db.run(query, params);

      // ── Inventory: cancellation reversal (idempotent, non-blocking) ─────
      // If this PATCH transitioned the order to CANCELLED, restore the stock
      // that was deducted when the order was originally placed. Guarded by
      // orders.inventory_reverted so a second cancel is a no-op.
      if (status && String(status).toUpperCase() === 'CANCELLED') {
        revertIngredientsForOrder(db, req.params.id).catch(err => {
          console.warn(`[inventory] Reversal failed for order ${req.params.id}:`, err);
        });
      }

      // Broadcast ORDER_UPDATE via WebSocket so customers/monitors get live status
      const updatedOrder = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);
      if (updatedOrder) {
        try {
          if (typeof updatedOrder.items === 'string') updatedOrder.items = JSON.parse(updatedOrder.items);
        } catch (_) {}
        const wss = (global as any).__wss;
        if (wss) {
          wss.clients.forEach((client: any) => {
            if (client.readyState === 1) {
              client.send(JSON.stringify({ type: 'ORDER_UPDATE', data: updatedOrder, restaurantId: req.user!.restaurantId }));
            }
          });
        }
      }

      // ── Phase 4: enqueue STATUS_PUSH for platform-originated orders ──
      // If this order came from a delivery platform, queue a status push so
      // the platform's customer-facing tracker reflects the kitchen state.
      // Only PREPARING/READY/DELIVERED/CANCELLED map to platform-pushable
      // statuses; other transitions (queued/held_for_payment) stay local.
      try {
        if (updatedOrder?.external_platform && updatedOrder?.external_order_id && status) {
          const PUSHABLE: Record<string, string> = {
            PREPARING: 'PREPARING',
            READY: 'READY',
            DELIVERED: 'DELIVERED',
            CANCELLED: 'CANCELLED',
          };
          const target = PUSHABLE[String(status).toUpperCase()];
          if (target) {
            await enqueueSyncJob(db, 'STATUS_PUSH', String(updatedOrder.external_platform).toUpperCase() as ChannelId, {
              externalOrderId: updatedOrder.external_order_id,
              newStatus: target,
              orderId: updatedOrder.id,
            });
          }
        }
      } catch (qErr) {
        // Defensive: queue failure must NEVER fail the order PATCH response.
        console.warn(`[sync-queue] Failed to enqueue STATUS_PUSH for ${req.params.id}:`, (qErr as any)?.message);
      }

      res.json({ success: true, order: updatedOrder });

      // Notify on status transitions (non-blocking)
      if (status === 'READY' || status === 'CANCELLED') {
        db.get("SELECT * FROM orders WHERE id = ?", [req.params.id])
          .then((order: any) => {
            if (!order) return;
            const itemsParsed = JSON.parse(order.items || '[]');
            const itemLabels  = itemsParsed.map((i: any) =>
              `${i.name || i.item_name || 'Item'} x${i.quantity ?? 1}`
            );
            const eventName = status === 'READY' ? 'ORDER_READY' : 'ORDER_CANCELLED';
            triggerNotification(req.user!.restaurantId, eventName, {
              orderId: order.id, tableNumber: order.table_number,
              items: itemLabels, total: order.total_amount,
              customerEmail: order.customer_email, customerPhone: order.customer_phone,
            }).catch(() => {});
          }).catch(() => {});
      }
    } catch (err) {
      res.status(500).json({ error: "Failed to update order" });
    }
  });

  // Bookings: Get Bookings
  app.get("/api/restaurant/:id/bookings", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const bookings = await db.query("SELECT * FROM bookings ORDER BY booking_date, booking_time");
      res.json(bookings);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch bookings" });
    }
  });

  // Bookings: Create Booking (public — validates against reservation_day_config)
  app.post("/api/public/restaurants/:id/bookings", async (req: Request, res: Response) => {
    try {
      const {
        customer_name, customerName,
        customer_phone, customerPhone,
        customer_email, customerEmail,
        booking_date, bookingDate,
        booking_time, bookingTime,
        guests
      } = req.body;
      const finalName = customer_name || customerName;
      const finalPhone = customer_phone || customerPhone;
      const finalEmail = customer_email || customerEmail || null;
      const finalDate = booking_date || bookingDate;
      const finalTime = booking_time || bookingTime;
      const db = await getTenantDb(req.params.id);

      // Validate day config
      const config = await db.get(
        "SELECT * FROM reservation_day_config WHERE TO_CHAR(config_date, 'YYYY-MM-DD') = ?",
        [finalDate]
      );
      if (!config || !config.is_open) {
        return res.status(400).json({ error: "Reservations are not available for this date." });
      }

      // Check slot capacity
      const booked = await db.get(
        "SELECT COUNT(*) as count FROM bookings WHERE TO_CHAR(booking_date, 'YYYY-MM-DD') = ? AND TO_CHAR(booking_time, 'HH24:MI') = ? AND status != 'CANCELLED'",
        [finalDate, finalTime]
      );
      if (Number(booked?.count || 0) >= config.max_tables) {
        return res.status(400).json({ error: "This time slot is fully booked. Please choose another time." });
      }

      const id = randomUUID();
      await db.run(
        "INSERT INTO bookings (id, customer_name, customer_phone, customer_email, booking_date, booking_time, guests, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')",
        [id, finalName, finalPhone, finalEmail, finalDate, finalTime, guests]
      );
      res.json({ success: true, id });

      // Notify owner + customer (non-blocking)
      triggerNotification(req.params.id, 'TABLE_BOOKING', {
        bookingId: id, customerName: finalName, customerPhone: finalPhone,
        customerEmail: finalEmail, bookingDate: finalDate,
        bookingTime: finalTime, guests,
      }).catch(() => {});
    } catch (err) {
      console.error("Create booking error:", err);
      res.status(500).json({ error: "Failed to create booking" });
    }
  });

  // Fixed Registration Logic
  app.post("/api/auth/register", async (req: Request, res: Response) => {
    const { email, restaurantName, name, password, phone, state, city, sales_rep_id } = req.body;
    
    try {
      // Check if email already exists
      const existingUser = await centralDb.get("SELECT id FROM users WHERE email = ?", [email]);
      if (existingUser) {
        return res.status(400).json({ error: "This email address is already registered. Please use a different email or login." });
      }

      const seq = await getNextSequence('restaurant');
      const restaurantId = `RESTO-${1000 + seq}`;
      const loginId = `OWNER-${1000 + seq}`;
      
      const hashedPassword = await bcrypt.hash(password, 12);
      const userId = "user-" + randomUUID();

      const now = new Date().toISOString();
      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 1);

      // Generate unique slug for this restaurant (per-tenant subdomain)
      const repCreatedSlug = await generateUniqueSlug(restaurantName);

      await centralDb.run(`
        INSERT INTO restaurants (id, name, admin_id, state, city, is_active, sales_rep_id, registered_at, subscription_expires_at, slug)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `, [restaurantId, restaurantName, userId, state, city, sales_rep_id || null, now, expiresAt.toISOString(), repCreatedSlug]);

      await centralDb.run(`
        INSERT INTO users (id, login_id, name, email, phone, password, restaurant_id, role)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [userId, loginId, name, email, phone, hashedPassword, restaurantId, 'OWNER']);

      // Auto-provision Cloudflare DNS + Tunnel Public Hostname for the tenant
      // subdomain. Best-effort: if CF env vars aren't set or the API is down,
      // registration still succeeds and the operator can backfill later via
      // POST /api/admin/tenants/bulk-provision-dns.
      try {
        const cf = await provisionTenantSubdomain(repCreatedSlug);
        if (cf.skipped) {
          console.log(`[register-legacy] Cloudflare auto-provision skipped for ${repCreatedSlug} (CF not configured)`);
        } else if (cf.error) {
          console.error(`[register-legacy] CF provision failed for ${repCreatedSlug}:`, cf.error);
        } else {
          console.log(`[register-legacy] Cloudflare provisioned ${cf.hostname} (dns=${cf.dns_record_id}, tunnel=${cf.tunnel_config_updated})`);
        }
      } catch (cfErr) {
        console.error(`[register-legacy] CF provision threw for ${repCreatedSlug}:`, cfErr);
      }

      // Send welcome email with credentials — await so we can report success/failure
      let emailSent = false;
      if (email) {
        try {
          const { subject, text: textBody, html } = buildNotificationContent('BUSINESS_REGISTRATION', {
            restaurantName,
            restaurantId,
            loginId,
            password,
          });
          await sendEmail(email, subject, textBody, html);
          emailSent = true;
          console.log(`[Registration] Welcome email sent → ${email}`);
        } catch (err) {
          console.error('[Registration] Welcome email failed:', err);
        }
      }

      res.json({ success: true, loginId, restaurantId, emailSent });
    } catch (err: any) {
      console.error("Registration error:", err);
      if (err.code === '23505') {
        if (err.constraint?.includes('email')) {
          return res.status(400).json({ error: "This email address is already registered." });
        }
        if (err.constraint?.includes('login_id')) {
          return res.status(400).json({ error: "A user with this Login ID already exists." });
        }
        return res.status(400).json({ error: "A user with these details already exists." });
      }
      res.status(500).json({ error: "Registration failed. Please try again later." });
    }
  });

  // Watermark: Upload Watermark
  app.post("/api/restaurant/:id/watermark", authenticate, upload.single('image'), async (req: AuthRequest, res: Response) => {
    try {
      res.json({ success: true, url: req.file ? `/uploads/${req.file.filename}` : null });
    } catch (err) {
      res.status(500).json({ error: "Failed to upload watermark" });
    }
  });

  // UPI QR: Upload UPI QR
  app.post("/api/restaurant/:id/upi-qr", authenticate, upload.single('image'), async (req: AuthRequest, res: Response) => {
    try {
      res.json({ success: true, url: req.file ? `/uploads/${req.file.filename}` : null });
    } catch (err) {
      res.status(500).json({ error: "Failed to upload UPI QR" });
    }
  });

  // Bookings: Public — get reservation config for next 60 days (for calendar view)
  app.get("/api/public/restaurants/:id/reservation-config", async (req: Request, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const today = new Date().toISOString().split('T')[0];
      const end60 = new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0];

      // Fetch configs and all relevant booking counts in 2 queries (no N+1)
      const [configs, allCounts] = await Promise.all([
        db.query(
          "SELECT * FROM reservation_day_config WHERE TO_CHAR(config_date, 'YYYY-MM-DD') >= ? AND TO_CHAR(config_date, 'YYYY-MM-DD') <= ? ORDER BY config_date LIMIT 60",
          [today, end60]
        ),
        db.query(
          "SELECT TO_CHAR(booking_date, 'YYYY-MM-DD') as d, TO_CHAR(booking_time, 'HH24:MI') as t, COUNT(*) as count FROM bookings WHERE TO_CHAR(booking_date, 'YYYY-MM-DD') >= ? AND TO_CHAR(booking_date, 'YYYY-MM-DD') <= ? AND status != 'CANCELLED' GROUP BY d, t",
          [today, end60]
        )
      ]);

      // Build nested map: date → time → count (O(1) lookups below)
      const allCountsMap: Record<string, Record<string, number>> = {};
      for (const bc of allCounts) {
        if (!allCountsMap[bc.d]) allCountsMap[bc.d] = {};
        allCountsMap[bc.d][bc.t] = Number(bc.count);
      }

      const result = configs.map((c: any) => {
        const dateStr = String(c.config_date).slice(0, 10);
        const rawSlots = JSON.parse(c.time_slots || '[]');
        const slots = rawSlots.map((s: any) => typeof s === 'string' ? { time: s, max_tables: c.max_tables } : s);
        const countMap = allCountsMap[dateStr] || {};
        const hasAvailability = !!c.is_open && slots.some((s: any) => (countMap[s.time] || 0) < (s.max_tables ?? c.max_tables));
        return { config_date: dateStr, max_tables: c.max_tables, time_slots: c.time_slots, is_open: !!c.is_open, has_availability: hasAvailability };
      });
      res.json(result);
    } catch (err) {
      console.error("Reservation config error:", err);
      res.status(500).json({ error: "Failed to fetch reservation config" });
    }
  });

  // Bookings: Public — get available time slots for a specific date
  app.get("/api/public/restaurants/:id/slots", async (req: Request, res: Response) => {
    try {
      const date = String(req.query.date || '');
      if (!date) return res.status(400).json({ error: "date query param required" });
      const db = await getTenantDb(req.params.id);
      const config = await db.get(
        "SELECT * FROM reservation_day_config WHERE TO_CHAR(config_date, 'YYYY-MM-DD') = ?",
        [date]
      );
      if (!config || !config.is_open) return res.json({ is_open: false, slots: [] });
      const rawSlots = JSON.parse(config.time_slots || '[]');
      const parsedSlots = rawSlots.map((s: any) => typeof s === 'string' ? { time: s, max_tables: config.max_tables } : s);
      const countMap = await getSlotCountMap(db, date);
      const slotsWithAvail = parsedSlots.map((slot: { time: string; max_tables: number }) => {
        const slotMax = slot.max_tables ?? config.max_tables;
        return {
          time: slot.time,
          booked: countMap[slot.time] || 0,
          remaining: Math.max(0, slotMax - (countMap[slot.time] || 0)),
          available: (countMap[slot.time] || 0) < slotMax,
          max_tables: slotMax
        };
      });
      res.json({ is_open: true, max_tables: config.max_tables, slots: slotsWithAvail });
    } catch (err) {
      console.error("Slots error:", err);
      res.status(500).json({ error: "Failed to fetch slots" });
    }
  });

  // Reports: Full Analytics (date-range aware, roll-up aggregations)
  app.get("/api/restaurant/:id/reports", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);

      // Date range (default: last 30 days)
      const to   = (req.query.to   as string) || new Date().toISOString().slice(0, 10);
      const from = (req.query.from as string) || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);

      const allOrders = await db.query(
        `SELECT * FROM orders WHERE DATE(created_at) >= ? AND DATE(created_at) <= ? ORDER BY created_at DESC`,
        [from, to]
      );

      // ── KPI stats ──────────────────────────────────────────────────────────
      const totalRevenue = allOrders.reduce((s: number, o: any) => s + Number(o.total_amount || 0), 0);
      const paidRevenue  = allOrders
        .filter((o: any) => o.payment_status === 'PAID')
        .reduce((s: number, o: any) => s + Number(o.total_amount || 0), 0);
      const todayIST     = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).split(',')[0].trim();
      const todayOrders  = allOrders.filter((o: any) => {
        const d = new Date(o.created_at);
        return d.toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).split(',')[0].trim() === todayIST;
      });
      const todayRevenue = todayOrders.reduce((s: number, o: any) => s + Number(o.total_amount || 0), 0);

      // ── Rolling aggregation maps ───────────────────────────────────────────
      const dailyMap:   Record<string, { revenue: number; orders: number }> = {};
      const weeklyMap:  Record<string, { revenue: number; orders: number }> = {};
      const monthlyMap: Record<string, { revenue: number; orders: number }> = {};
      const categoryMap: Record<string, {
        revenue: number; count: number;
        items: Record<string, { revenue: number; count: number }>;
      }> = {};
      const paymentMap: Record<string, { count: number; revenue: number }> = {};
      const hourMap:    Record<number, number> = {};
      const statusMap:  Record<string, number> = {};

      // Build menu category lookup map for backward compat with orders that predate category tracking
      const menuItemsForCat = await db.query("SELECT id, category FROM menu");
      const menuCatMap: Record<string, string> = {};
      for (const mi of menuItemsForCat) if (mi.category) menuCatMap[mi.id] = mi.category;

      for (const o of allOrders) {
        const dt      = new Date(o.created_at);
        const dateStr = String(o.created_at).slice(0, 10);
        const rev     = Number(o.total_amount || 0);

        // Daily
        if (!dailyMap[dateStr]) dailyMap[dateStr] = { revenue: 0, orders: 0 };
        dailyMap[dateStr].revenue += rev;
        dailyMap[dateStr].orders++;

        // Weekly (week starting Monday)
        const ws = new Date(dt);
        ws.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
        const weekStr = ws.toISOString().slice(0, 10);
        if (!weeklyMap[weekStr]) weeklyMap[weekStr] = { revenue: 0, orders: 0 };
        weeklyMap[weekStr].revenue += rev;
        weeklyMap[weekStr].orders++;

        // Monthly
        const monthStr = String(o.created_at).slice(0, 7);
        if (!monthlyMap[monthStr]) monthlyMap[monthStr] = { revenue: 0, orders: 0 };
        monthlyMap[monthStr].revenue += rev;
        monthlyMap[monthStr].orders++;

        // Peak hours — use IST timezone for local business context
        const hour = parseInt(
          new Date(o.created_at).toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }),
          10
        );
        hourMap[isNaN(hour) ? 0 : hour] = (hourMap[isNaN(hour) ? 0 : hour] || 0) + 1;

        // Payment method
        const pm = (o.payment_method || 'Unknown').toUpperCase();
        if (!paymentMap[pm]) paymentMap[pm] = { count: 0, revenue: 0 };
        paymentMap[pm].count++;
        paymentMap[pm].revenue += rev;

        // Order status
        statusMap[o.status || 'UNKNOWN'] = (statusMap[o.status || 'UNKNOWN'] || 0) + 1;

        // Category & item breakdown (items stored as JSON TEXT)
        let items: any[] = [];
        try { items = typeof o.items === 'string' ? JSON.parse(o.items) : (Array.isArray(o.items) ? o.items : []); } catch { items = []; }
        for (const item of items) {
          const cat     = item.category || menuCatMap[item.id] || 'Uncategorised';
          const name    = item.name || 'Unknown Item';
          const qty     = Number(item.quantity || 1);
          const itemRev = Number(item.price || 0) * qty;

          if (!categoryMap[cat]) categoryMap[cat] = { revenue: 0, count: 0, items: {} };
          categoryMap[cat].revenue += itemRev;
          categoryMap[cat].count   += qty;

          if (!categoryMap[cat].items[name]) categoryMap[cat].items[name] = { revenue: 0, count: 0 };
          categoryMap[cat].items[name].revenue += itemRev;
          categoryMap[cat].items[name].count   += qty;
        }
      }

      // ── Format output arrays ───────────────────────────────────────────────
      const r2 = (v: number) => Math.round(v * 100) / 100;

      const dailySales   = Object.entries(dailyMap)  .map(([date,  v]) => ({ date,  revenue: r2(v.revenue), orders: v.orders })).sort((a, b) => a.date.localeCompare(b.date));
      const weeklySales  = Object.entries(weeklyMap) .map(([week,  v]) => ({ week,  revenue: r2(v.revenue), orders: v.orders })).sort((a, b) => a.week.localeCompare(b.week));
      const monthlySales = Object.entries(monthlyMap).map(([month, v]) => ({ month, revenue: r2(v.revenue), orders: v.orders })).sort((a, b) => a.month.localeCompare(b.month));

      const salesByCategory = Object.entries(categoryMap).map(([category, v]) => ({
        category,
        revenue: r2(v.revenue),
        count:   v.count,
        items: Object.entries(v.items)
          .map(([name, iv]) => ({ name, revenue: r2(iv.revenue), count: iv.count }))
          .sort((a, b) => b.count - a.count),
      })).sort((a, b) => b.revenue - a.revenue);

      // Top 10 items across all categories
      const allItemsMap: Record<string, { revenue: number; count: number }> = {};
      for (const cat of Object.values(categoryMap)) {
        for (const [name, iv] of Object.entries(cat.items)) {
          if (!allItemsMap[name]) allItemsMap[name] = { revenue: 0, count: 0 };
          allItemsMap[name].revenue += iv.revenue;
          allItemsMap[name].count   += iv.count;
        }
      }
      const topItems = Object.entries(allItemsMap)
        .map(([name, v]) => ({ name, revenue: r2(v.revenue), count: v.count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      const paymentBreakdown = Object.entries(paymentMap)
        .map(([method, v]) => ({ method, count: v.count, revenue: r2(v.revenue) }))
        .sort((a, b) => b.revenue - a.revenue);

      const peakHours = Array.from({ length: 24 }, (_, hour) => ({
        hour,
        label: `${String(hour).padStart(2, '0')}:00`,
        count: hourMap[hour] || 0,
      }));

      const orderStatusBreakdown = Object.entries(statusMap).map(([status, count]) => ({ status, count }));

      res.json({
        allOrders,
        kpi: {
          totalRevenue:  r2(totalRevenue),
          totalOrders:   allOrders.length,
          avgOrderValue: allOrders.length ? r2(totalRevenue / allOrders.length) : 0,
          todayRevenue:  r2(todayRevenue),
          todayOrders:   todayOrders.length,
          paidRevenue:   r2(paidRevenue),
        },
        dailySales,
        weeklySales,
        monthlySales,
        salesByCategory,
        topItems,
        paymentBreakdown,
        peakHours,
        orderStatusBreakdown,
        dateRange: { from, to },
      });
    } catch (err) {
      console.error("Reports error:", err);
      res.status(500).json({ error: "Failed to fetch reports" });
    }
  });

  // Roles allowed to manage staff inside a tenant. OWNER + MANAGER are the
  // tenant-side admins; SUPER_ADMIN / CTO get the same access via ?restaurantId=
  // for the cross-tenant Admin console.
  const STAFF_MGMT_ROLES = ['OWNER', 'MANAGER', 'SUPER_ADMIN', 'CTO'];

  // Staff: Get Staff
  app.get("/api/owner/staff", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      if (!STAFF_MGMT_ROLES.includes(req.user?.role ?? '')) {
        return res.status(403).json({ error: "Forbidden — staff management requires OWNER, MANAGER, SUPER_ADMIN or CTO role" });
      }
      const targetId = resolveTargetRestaurantId(req);
      if (!targetId) return res.status(400).json({ error: "restaurantId is required" });
      const db = await getTenantDb(targetId);
      const staff = await db.query("SELECT id, login_id, name, role, phone, email, is_active FROM attendance_staff ORDER BY name");
      res.json(staff);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch staff" });
    }
  });

  // Staff: Create Staff
  app.post("/api/owner/staff", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      if (!STAFF_MGMT_ROLES.includes(req.user?.role ?? '')) {
        return res.status(403).json({ error: "Forbidden — staff management requires OWNER, MANAGER, SUPER_ADMIN or CTO role" });
      }
      const targetId = resolveTargetRestaurantId(req);
      if (!targetId) return res.status(400).json({ error: "restaurantId is required" });
      const { name, role, phone, email, loginId, password } = req.body;
      const db = await getTenantDb(targetId);
      const id = randomUUID();

      if (loginId && password) {
        // Check for duplicate login_id in this tenant
        const existing = await db.get("SELECT id FROM attendance_staff WHERE login_id = ?", [loginId]);
        if (existing) {
          return res.status(400).json({ error: "A staff member with this Login ID already exists." });
        }
        const hashedPassword = await bcrypt.hash(password, 12);
        await db.run(
          "INSERT INTO attendance_staff (id, name, role, phone, email, login_id, password) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [id, name, role, phone || null, email || null, loginId, hashedPassword]
        );
      } else {
        await db.run(
          "INSERT INTO attendance_staff (id, name, role, phone, email) VALUES (?, ?, ?, ?, ?)",
          [id, name, role, phone || null, email || null]
        );
      }
      res.json({ success: true, id });
    } catch (err) {
      console.error("Create staff error:", err);
      res.status(500).json({ error: "Failed to create staff" });
    }
  });

  // Staff: Reset Password
  app.post("/api/owner/staff/:id/reset-password", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      if (!STAFF_MGMT_ROLES.includes(req.user?.role ?? '')) {
        return res.status(403).json({ error: "Forbidden — password reset requires OWNER, MANAGER, SUPER_ADMIN or CTO role" });
      }
      const targetId = resolveTargetRestaurantId(req);
      if (!targetId) return res.status(400).json({ error: "restaurantId is required" });
      const { newPassword } = req.body;
      if (!newPassword || String(newPassword).length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters" });
      }
      const db = await getTenantDb(targetId);
      const hashedPassword = await bcrypt.hash(newPassword, 12);
      await db.run("UPDATE attendance_staff SET password = ? WHERE id = ?", [hashedPassword, req.params.id]);
      res.json({ success: true });
    } catch (err) {
      console.error("Reset staff password error:", err);
      res.status(500).json({ error: "Failed to reset password" });
    }
  });

  // Attendance: Get Attendance
  // OWNER gets all records; CHEF/WAITER get only their own records
  app.get("/api/attendance", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { month } = req.query;
      const db = await getTenantDb(req.user!.restaurantId);
      const isOwner = req.user!.role === 'OWNER' || req.user!.role === 'MANAGER';
      const attendance = isOwner
        ? await db.query(
            `SELECT a.*, COALESCE(s.name, 'Unknown Staff') AS staff_name
             FROM attendance a
             LEFT JOIN attendance_staff s ON a.user_id = s.id
             WHERE TO_CHAR(a.date, 'YYYY-MM') = ?
             ORDER BY a.date`,
            [month]
          )
        : await db.query(
            "SELECT * FROM attendance WHERE TO_CHAR(date, 'YYYY-MM') = ? AND user_id = ? ORDER BY date",
            [month, req.user!.id]
          );
      res.json(attendance);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch attendance" });
    }
  });

  // Attendance: Log Attendance
  app.post("/api/attendance", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { date, hours, type, note } = req.body;
      const db = await getTenantDb(req.user!.restaurantId);
      const id = `ATT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      await db.run(`
        INSERT INTO attendance (id, user_id, date, hours, type, note, status)
        VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
        ON CONFLICT(user_id, date) DO UPDATE SET
          hours    = excluded.hours,
          type     = excluded.type,
          note     = excluded.note,
          status   = CASE
                       WHEN attendance.status = 'APPROVED' THEN 'APPROVED'
                       ELSE 'PENDING'
                     END
      `, [id, req.user!.id, date, hours, type, note]);
      
      res.json({ success: true });
    } catch (err) {
      console.error("Log attendance error:", err);
      res.status(500).json({ error: "Failed to log attendance" });
    }
  });

  // Feedback: Get Feedback
  app.get("/api/owner/feedback", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const feedback = await db.query("SELECT * FROM feedback ORDER BY created_at DESC");
      res.json(feedback);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch feedback" });
    }
  });

  // Staff: Update Staff
  app.patch("/api/owner/staff/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const updates = req.body;
      const keys = Object.keys(updates);
      const setClause = keys.map(k => `${k} = ?`).join(", ");
      const params = [...Object.values(updates), req.params.id];
      await db.run(`UPDATE attendance_staff SET ${setClause} WHERE id = ?`, params);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to update staff" });
    }
  });

  // Staff: Delete Staff
  app.delete("/api/owner/staff/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      await db.run("DELETE FROM attendance_staff WHERE id = ?", [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete staff" });
    }
  });

  // Attendance: Stats (per-staff monthly summary)
  app.get("/api/owner/attendance/stats", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { month } = req.query;
      const db = await getTenantDb(req.user!.restaurantId);
      const stats = await db.query(`
        SELECT a.user_id,
          COALESCE(s.name, pu.name, a.user_id) as name,
          s.role as staff_role,
          COALESCE(SUM(a.hours), 0) as total_hours,
          COUNT(*) as days_worked,
          COALESCE(s.default_hours, 8) as default_hours
        FROM attendance a
        LEFT JOIN attendance_staff s ON a.user_id = s.id
        LEFT JOIN public.users pu ON a.user_id = pu.id
        WHERE TO_CHAR(a.date, 'YYYY-MM') = ?
        GROUP BY a.user_id, s.name, s.role, pu.name, s.default_hours
        ORDER BY s.name, pu.name
      `, [month]);
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch attendance stats" });
    }
  });

  // Attendance: Update Record Status
  app.patch("/api/attendance/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { status } = req.body;
      const db = await getTenantDb(req.user!.restaurantId);
      await db.run("UPDATE attendance SET status = ? WHERE id = ?", [status, req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to update attendance" });
    }
  });

  // Staff: Update Settings (default hours)
  app.patch("/api/owner/staff/:id/settings", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { default_hours } = req.body;
      const db = await getTenantDb(req.user!.restaurantId);
      await db.exec("ALTER TABLE attendance_staff ADD COLUMN IF NOT EXISTS default_hours DOUBLE PRECISION DEFAULT 8");
      await db.run("UPDATE attendance_staff SET default_hours = ? WHERE id = ?", [default_hours, req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to update staff settings" });
    }
  });

  // Feedback: Request Feedback
  app.post("/api/orders/:id/request-feedback", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      // In a real app, send SMS/Email to customer
      res.json({ success: true, message: "Feedback request sent" });
    } catch (err) {
      res.status(500).json({ error: "Failed to request feedback" });
    }
  });

  // Tables: Rename Table
  app.patch("/api/restaurant/:id/tables/:tableId", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { name } = req.body;
      const db = await getTenantDb(req.params.id);
      await db.run("UPDATE tables SET name = ? WHERE id = ?", [name, req.params.tableId]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to update table" });
    }
  });

  // Tables: Live Monitoring View  (OWNER / MANAGER / WAITER)
  // Returns every table enriched with its active session data and waiter name.
  app.get("/api/restaurant/:id/tables/live", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);

      // All tables + assigned waiter name
      const tables = await db.query(
        `SELECT t.*, s.name AS assigned_waiter_name
         FROM tables t
         LEFT JOIN attendance_staff s ON s.id = t.assigned_waiter_id
         ORDER BY t.name`
      );

      // All currently open or bill-requested sessions (one per table)
      const activeSessions = await db.query(
        "SELECT * FROM table_sessions WHERE status IN ('open', 'bill_requested')"
      );
      const sessionByTable: Record<string, any> = {};
      for (const sess of activeSessions) {
        if (sess.table_id) sessionByTable[sess.table_id] = sess;
      }

      // Order counts per session
      const orderCounts = await db.query(
        `SELECT session_id, COUNT(*) AS cnt FROM orders
         WHERE session_id = ANY(ARRAY[${activeSessions.map(() => '?').join(',')}]::text[])
         GROUP BY session_id`,
        activeSessions.map((s: any) => s.id)
      ).catch(() => [] as any[]);
      const countBySession: Record<string, number> = {};
      for (const r of orderCounts) countBySession[r.session_id] = Number(r.cnt);

      const live = tables.map((t: any) => {
        const sess = sessionByTable[t.id];
        return {
          ...t,
          session_id:          sess?.id            ?? null,
          session_opened_at:   sess?.opened_at     ?? null,
          customer_name:       sess?.customer_name ?? null,
          customer_phone:      sess?.customer_phone ?? null,
          round_count:         sess?.round_count   ?? 0,
          bill_amount:         sess?.bill_amount   ?? 0,
          session_status:      sess?.status        ?? null,
          order_count:         sess ? (countBySession[sess.id] ?? 0) : 0,
        };
      });

      // Note: synthetic 'Online Order' and 'Cloud Kitchen' rows used to be
      // appended here. They've been removed in favour of dedicated panels in
      // the C&C view — postpaid online sessions surface via the existing
      // bill-requested banner when action is needed; cloud-kitchen orders
      // have their own /cloud-kitchen/active endpoint and panel below the
      // tables grid. The Tables grid is now exclusively for physical tables.

      res.json(live);
    } catch (err) {
      console.error("Live tables error:", err);
      res.status(500).json({ error: "Failed to fetch live table data" });
    }
  });

  // Cloud Kitchen: Active orders for the dedicated C&C panel
  // Returns rich per-order detail (customer, structured address, items count,
  // age in minutes, SLA breach flag). Frontend renders a dedicated panel
  // separate from the physical-tables grid so cloud-kitchen orders are not
  // shoehorned into a table-shaped UI where columns like Capacity / Rounds /
  // Waiter don't apply.
  //
  // SLA threshold: 30 min from order creation; rows past this are flagged so
  // the panel can render them red so the owner notices delivery delays.
  app.get("/api/restaurant/:id/cloud-kitchen/active", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const SLA_MINUTES = 30;
      const nowMs = Date.now();

      const rows: any[] = await db.query(`
        SELECT id, invoice_number, customer_name, customer_phone, customer_email,
               customer_address_line1, customer_address_line2, customer_city,
               customer_pincode, customer_landmark,
               items, total_amount, gst_amount,
               payment_method, kitchen_status, status, created_at
          FROM orders
         WHERE checkout_mode = 'cloud_kitchen'
           AND COALESCE(status, '') NOT IN ('CANCELLED')
           AND COALESCE(kitchen_status, 'queued') NOT IN ('delivered', 'served')
         ORDER BY created_at ASC
      `).catch(() => [] as any[]);

      let pending = 0;          // queued / accepted / preparing
      let awaitingDispatch = 0; // ready (cooked, awaiting handoff)
      let breachedCount = 0;
      let totalRevenue = 0;

      const orders = rows.map((o: any) => {
        // Parse items JSON (stored as TEXT)
        let items: any[] = [];
        try { items = typeof o.items === 'string' ? JSON.parse(o.items) : (Array.isArray(o.items) ? o.items : []); } catch {}

        const ks = String(o.kitchen_status || 'queued').toLowerCase();
        if (ks === 'ready') awaitingDispatch++;
        else                pending++;

        const createdMs = new Date(o.created_at || nowMs).getTime();
        const ageMin    = Math.max(0, Math.floor((nowMs - createdMs) / 60000));
        const slaBreached = ageMin > SLA_MINUTES;
        if (slaBreached) breachedCount++;

        const grand = Number(o.total_amount || 0) + Number(o.gst_amount || 0);
        totalRevenue += grand;

        return {
          id:                  o.id,
          invoice_number:      o.invoice_number || `#${String(o.id || '').slice(-8).toUpperCase()}`,
          customer_name:       o.customer_name || '—',
          customer_phone:      o.customer_phone || '',
          customer_email:      o.customer_email || '',
          address_line1:       o.customer_address_line1 || '',
          address_line2:       o.customer_address_line2 || '',
          city:                o.customer_city || '',
          pincode:             o.customer_pincode || '',
          landmark:            o.customer_landmark || '',
          items_count:         items.length,
          items_summary:       items.slice(0, 3).map((it: any) => `${it.name || it.item_name || 'Item'} ×${it.quantity ?? 1}`).join(', ') + (items.length > 3 ? ` +${items.length - 3} more` : ''),
          subtotal:            Number(o.total_amount || 0),
          gst_amount:          Number(o.gst_amount || 0),
          grand_total:         grand,
          payment_method:      o.payment_method || '—',
          kitchen_status:      ks,
          age_minutes:         ageMin,
          sla_breached:        slaBreached,
          created_at:          o.created_at,
        };
      });

      res.json({
        orders,
        summary: {
          total_active:      orders.length,
          pending,
          awaiting_dispatch: awaitingDispatch,
          breached:          breachedCount,
          total_revenue:     totalRevenue,
          sla_minutes:       SLA_MINUTES,
        },
      });
    } catch (err) {
      console.error("Cloud-kitchen active orders error:", err);
      res.status(500).json({ error: "Failed to fetch cloud-kitchen orders" });
    }
  });

  // Tables: Update Status (OWNER / MANAGER freely; WAITER only for their assigned table)
  app.patch("/api/restaurant/:id/tables/:tableId/status", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { status } = req.body;
      const allowed = ['AVAILABLE', 'OCCUPIED', 'NOT_AVAILABLE'];
      if (!allowed.includes(status)) {
        return res.status(400).json({ error: "Invalid status. Use AVAILABLE, OCCUPIED, or NOT_AVAILABLE." });
      }
      const db = await getTenantDb(req.params.id);
      const role = req.user!.role;

      if (role === 'WAITER') {
        // Waiter may only toggle their own assigned table
        const table = await db.get("SELECT assigned_waiter_id FROM tables WHERE id = ?", [req.params.tableId]);
        if (!table) return res.status(404).json({ error: "Table not found" });
        if (table.assigned_waiter_id !== req.user!.id) {
          return res.status(403).json({ error: "You are not assigned to this table." });
        }
      } else if (!['OWNER', 'MANAGER'].includes(role)) {
        return res.status(403).json({ error: "Access denied" });
      }

      await db.run("UPDATE tables SET status = ? WHERE id = ?", [status, req.params.tableId]);
      res.json({ success: true, status });
    } catch (err) {
      console.error("Update table status error:", err);
      res.status(500).json({ error: "Failed to update table status" });
    }
  });

  // Tables: Assign Waiter  (OWNER / MANAGER only)
  app.patch("/api/restaurant/:id/tables/:tableId/assign-waiter", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      if (!['OWNER', 'MANAGER'].includes(req.user!.role)) {
        return res.status(403).json({ error: "Access denied" });
      }
      const { waiter_id } = req.body; // null to unassign
      const db = await getTenantDb(req.params.id);
      await db.run(
        "UPDATE tables SET assigned_waiter_id = ? WHERE id = ?",
        [waiter_id || null, req.params.tableId]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("Assign waiter error:", err);
      res.status(500).json({ error: "Failed to assign waiter" });
    }
  });

  // Orders: Mark Payment
  app.patch("/api/orders/:id/payment", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { status, restaurantId: rId } = req.body;
      const tenantId = rId || req.user!.restaurantId;
      const db = await getTenantDb(tenantId);
      const order = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);

      const isPaid = (status === 'PAID' || !status);
      // For prepaid orders: release to kitchen when payment is confirmed
      if (order?.checkout_mode === 'prepaid' && isPaid) {
        await db.run(
          "UPDATE orders SET payment_status = 'PAID', kitchen_status = 'queued', status = 'CONFIRMED' WHERE id = ?",
          [req.params.id]
        );
      } else if (isPaid) {
        // For manual invoices and other non-prepaid orders: mark PAID + DELIVERED
        // so they leave the live KDS view immediately
        await db.run(
          "UPDATE orders SET payment_status = 'PAID', status = 'DELIVERED' WHERE id = ?",
          [req.params.id]
        );
      } else {
        await db.run("UPDATE orders SET payment_status = ? WHERE id = ?", [status, req.params.id]);
      }
      res.json({ success: true });

      // Notify owner on payment received (non-blocking)
      // For prepaid: also fire ORDER_PLACED so kitchen knows to start preparing
      if (order && isPaid) {
        if (order.checkout_mode === 'prepaid') {
          const itemsParsed = JSON.parse(order.items || '[]');
          triggerNotification(tenantId, 'ORDER_PLACED', {
            orderId: order.id, tableNumber: order.table_number,
            items: itemsParsed.map((i: any) => `${i.name || 'Item'} x${i.quantity ?? 1}`),
            total: order.total_amount,
            customerEmail: order.customer_email, customerPhone: order.customer_phone,
          }).catch(() => {});
        }
        triggerNotification(tenantId, 'PAYMENT_RECEIVED', {
          orderId:       order.id,
          tableNumber:   order.table_number,
          total:         order.total_amount,
          paymentMethod: order.payment_method,
          customerEmail: order.customer_email,
          customerPhone: order.customer_phone,
        }).catch(() => {});
      }
    } catch (err) {
      res.status(500).json({ error: "Failed to update payment status" });
    }
  });

  // ─── Invoice: GET full order detail (items parsed + discount + apply_gst)
  app.get("/api/restaurant/:id/orders/:orderId/invoice", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount FLOAT DEFAULT 0").catch(() => {});
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS apply_gst INTEGER DEFAULT 1").catch(() => {});
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_charge_percent FLOAT DEFAULT 0").catch(() => {});
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS gst_percent FLOAT DEFAULT 0").catch(() => {});
      const order = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.orderId]);
      if (!order) return res.status(404).json({ error: "Order not found" });
      let items = order.items;
      if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
      if (!Array.isArray(items)) items = [];

      // Backward-compat fallback: legacy online/prepaid orders were inserted
      // WITHOUT gst_percent and apply_gst (those columns defaulted to 0/1).
      // If gst_percent is 0 but the order has a non-zero gst_amount stored,
      // GST clearly WAS applied — back-fill the percent from restaurant
      // settings so the Edit modal renders the right grand total.
      let effectiveGstPercent = Number(order.gst_percent || 0);
      let effectiveApplyGst   = order.apply_gst === undefined ? 0 : Number(order.apply_gst);
      const hasGstAmount = Number(order.gst_amount || 0) > 0;
      if (effectiveGstPercent === 0 && hasGstAmount) {
        try {
          const restGst: any = await centralDb.get(
            "SELECT is_gst_enabled, gst_percentage FROM restaurants WHERE id = ?",
            [req.params.id]
          );
          if (restGst?.is_gst_enabled) {
            effectiveGstPercent = Number(restGst.gst_percentage || 0);
            effectiveApplyGst   = 1;
          }
        } catch (gstErr) {
          console.warn(`[invoice-get] GST settings lookup failed for ${req.params.id}; using stored values:`, gstErr);
        }
      }

      res.json({
        ...order,
        items,
        discount_amount: Number(order.discount_amount || 0),
        service_charge_percent: Number(order.service_charge_percent || 0),
        gst_percent: effectiveGstPercent,
        apply_gst:   effectiveApplyGst,
        display_number: computeDisplayNumber(order),
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch invoice" });
    }
  });

  // ─── Invoice: PATCH update items + discount + service charge + GST
  app.patch("/api/restaurant/:id/orders/:orderId/invoice", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount FLOAT DEFAULT 0").catch(() => {});
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS apply_gst INTEGER DEFAULT 1").catch(() => {});
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_charge_percent FLOAT DEFAULT 0").catch(() => {});
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS gst_percent FLOAT DEFAULT 0").catch(() => {});
      const { items, discount_amount = 0, service_charge_percent = 0, gst_percent = 0, apply_gst = 0 } = req.body;
      const rawSubtotal   = (items as any[]).reduce((s, it) => s + Number(it.price || 0) * Number(it.quantity || 1), 0);
      const afterDiscount = Math.max(0, rawSubtotal - Number(discount_amount));
      const svcAmt        = afterDiscount * Number(service_charge_percent) / 100;
      const taxable       = afterDiscount + svcAmt;
      const effGst        = apply_gst ? Number(gst_percent) : 0;
      const gstAmount     = taxable * effGst / 100;
      const total         = taxable + gstAmount;
      await db.run(
        "UPDATE orders SET items = ?, discount_amount = ?, service_charge_percent = ?, gst_percent = ?, apply_gst = ?, total_amount = ?, gst_amount = ? WHERE id = ?",
        [JSON.stringify(items), Number(discount_amount), Number(service_charge_percent), Number(gst_percent), apply_gst ? 1 : 0, total, gstAmount, req.params.orderId]
      );
      res.json({ success: true, subtotal: afterDiscount, discount_amount: Number(discount_amount), service_charge_amount: svcAmt, gst_amount: gstAmount, total });
    } catch (err: any) {
      console.error("Invoice update error:", err);
      res.status(500).json({ error: "Failed to update invoice" });
    }
  });

  // Owner: Get Bookings
  app.get("/api/owner/bookings", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const bookings = await db.query("SELECT * FROM bookings ORDER BY booking_date DESC, booking_time DESC");
      res.json(bookings);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch bookings" });
    }
  });

  // Owner: Update Booking Status
  app.post("/api/owner/bookings/:id/status", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { status } = req.body;
      const db = await getTenantDb(req.user!.restaurantId);
      // Fetch booking before update for notification data
      const booking = await db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id]);
      await db.run("UPDATE bookings SET status = ? WHERE id = ?", [status, req.params.id]);
      res.json({ success: true });

      // Notify customer on CONFIRMED / CANCELLED (non-blocking)
      if (booking && (status === 'CONFIRMED' || status === 'CANCELLED')) {
        const eventName = status === 'CONFIRMED' ? 'BOOKING_CONFIRMED' : 'BOOKING_CANCELLED';
        triggerNotification(req.user!.restaurantId, eventName, {
          bookingId:     booking.id,
          customerName:  booking.customer_name,
          customerPhone: booking.customer_phone,
          customerEmail: booking.customer_email,
          bookingDate:   String(booking.booking_date).slice(0, 10),
          bookingTime:   String(booking.booking_time).slice(0, 5),
          guests:        booking.guests,
        }).catch(() => {});
      }
    } catch (err) {
      res.status(500).json({ error: "Failed to update booking status" });
    }
  });

  // Owner: Cancel (soft-delete) a booking
  app.delete("/api/owner/bookings/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const booking = await db.get("SELECT * FROM bookings WHERE id = ?", [req.params.id]);
      await db.run("UPDATE bookings SET status = 'CANCELLED' WHERE id = ?", [req.params.id]);
      res.json({ success: true });

      if (booking) {
        triggerNotification(req.user!.restaurantId, 'BOOKING_CANCELLED', {
          bookingId:     booking.id,
          customerName:  booking.customer_name,
          customerPhone: booking.customer_phone,
          customerEmail: booking.customer_email,
          bookingDate:   String(booking.booking_date).slice(0, 10),
          bookingTime:   String(booking.booking_time).slice(0, 5),
          guests:        booking.guests,
        }).catch(() => {});
      }
    } catch (err) {
      res.status(500).json({ error: "Failed to cancel booking" });
    }
  });

  // Owner: Create booking on behalf of customer (auto-confirmed)
  app.post("/api/owner/bookings", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { customer_name, customer_phone, customer_email, booking_date, booking_time, guests, notes } = req.body;
      if (!customer_name || !customer_phone || !booking_date || !booking_time || !guests) {
        return res.status(400).json({ error: "customer_name, customer_phone, booking_date, booking_time and guests are required" });
      }
      const db = await getTenantDb(req.user!.restaurantId);
      const id = randomUUID();
      await db.run(
        "INSERT INTO bookings (id, customer_name, customer_phone, customer_email, booking_date, booking_time, guests, status, booked_by, notes) VALUES (?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?)",
        [id, customer_name, customer_phone, customer_email || null, booking_date, booking_time, guests, req.user!.id, notes || null]
      );
      res.json({ success: true, id });
    } catch (err) {
      res.status(500).json({ error: "Failed to create booking" });
    }
  });

  // Owner: Get reservation day config
  app.get("/api/owner/reservation-config", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const configs = await db.query("SELECT TO_CHAR(config_date, 'YYYY-MM-DD') as config_date, max_tables, time_slots, is_open, notes FROM reservation_day_config ORDER BY config_date");
      res.json(configs);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch reservation config" });
    }
  });

  // Owner: Upsert reservation day config for a specific date
  app.put("/api/owner/reservation-config/:date", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { max_tables, time_slots, is_open, notes } = req.body;
      const db = await getTenantDb(req.user!.restaurantId);
      const slotsJson = JSON.stringify(Array.isArray(time_slots) ? time_slots : []);
      await db.run(
        `INSERT INTO reservation_day_config (config_date, max_tables, time_slots, is_open, notes)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (config_date) DO UPDATE SET max_tables = EXCLUDED.max_tables, time_slots = EXCLUDED.time_slots, is_open = EXCLUDED.is_open, notes = EXCLUDED.notes`,
        [req.params.date, max_tables ?? 10, slotsJson, is_open ?? 1, notes || null]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("Save reservation config error:", err);
      res.status(500).json({ error: "Failed to save reservation config" });
    }
  });

  // Owner: Delete reservation day config for a specific date
  app.delete("/api/owner/reservation-config/:date", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      await db.run("DELETE FROM reservation_day_config WHERE TO_CHAR(config_date, 'YYYY-MM-DD') = ?", [req.params.date]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete reservation config" });
    }
  });

  // Owner: Bulk-apply availability config to a date range (with optional day-of-week filter)
  app.post("/api/owner/reservation-config/bulk", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { from_date, to_date, day_of_week, max_tables, time_slots, is_open, notes } = req.body;
      if (!from_date || !to_date) return res.status(400).json({ error: "from_date and to_date are required" });
      const db = await getTenantDb(req.user!.restaurantId);
      const slotsJson = JSON.stringify(Array.isArray(time_slots) ? time_slots : []);
      const allowedDays: number[] = Array.isArray(day_of_week) && day_of_week.length > 0
        ? day_of_week.map(Number)
        : [0, 1, 2, 3, 4, 5, 6]; // all days if none specified

      const start = new Date(from_date);
      const end = new Date(to_date);
      let count = 0;
      const cur = new Date(start);
      while (cur <= end) {
        if (allowedDays.includes(cur.getDay())) {
          const dateStr = cur.toISOString().split('T')[0];
          await db.run(
            `INSERT INTO reservation_day_config (config_date, max_tables, time_slots, is_open, notes)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (config_date) DO UPDATE SET max_tables = EXCLUDED.max_tables, time_slots = EXCLUDED.time_slots, is_open = EXCLUDED.is_open, notes = EXCLUDED.notes`,
            [dateStr, max_tables ?? 10, slotsJson, is_open ?? 1, notes || null]
          );
          count++;
        }
        cur.setDate(cur.getDate() + 1);
      }
      res.json({ success: true, days_updated: count });
    } catch (err) {
      console.error("Bulk reservation config error:", err);
      res.status(500).json({ error: "Failed to apply bulk availability" });
    }
  });

  // CTO: Onboarding Report (sales reps with restaurant counts)
  app.get("/api/cto/onboarding-report", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const reps = await centralDb.query(`
        SELECT u.id as sales_rep_id, u.name as sales_rep_name,
          COUNT(r.id) as total_restaurants,
          SUM(CASE WHEN r.is_active = 1 THEN 1 ELSE 0 END) as active_restaurants,
          SUM(CASE WHEN r.is_active = 0 THEN 1 ELSE 0 END) as pending_restaurants
        FROM users u
        LEFT JOIN restaurants r ON r.sales_rep_id = u.id
        WHERE u.role = 'SALES_REP'
        GROUP BY u.id, u.name
        ORDER BY u.name
      `);
      res.json(reps);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch onboarding report" });
    }
  });

  // CTO: Get Restaurants by Sales Rep
  app.get("/api/cto/sales-rep-restaurants/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const restaurants = await centralDb.query(
        "SELECT * FROM restaurants WHERE sales_rep_id = ? ORDER BY registered_at DESC",
        [req.params.id]
      );
      res.json(restaurants);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch restaurants" });
    }
  });

  // Admin: Get Subscription Prices
  app.get("/api/admin/subscription-prices", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const monthly = await centralDb.get("SELECT current_value FROM sequences WHERE name = 'price_monthly'");
      const annual = await centralDb.get("SELECT current_value FROM sequences WHERE name = 'price_annual'");
      res.json({
        monthly_price: monthly ? String(monthly.current_value) : '999',
        annual_price: annual ? String(annual.current_value) : '9999'
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch subscription prices" });
    }
  });

  // Admin: Save Subscription Prices
  app.post("/api/admin/subscription-prices", authenticate, isAdmin, async (req: AuthRequest, res: Response) => {
    try {
      const { monthly_price, annual_price } = req.body;
      await centralDb.run(`INSERT INTO sequences (name, current_value) VALUES ('price_monthly', ?) ON CONFLICT (name) DO UPDATE SET current_value = ?`, [monthly_price, monthly_price]);
      await centralDb.run(`INSERT INTO sequences (name, current_value) VALUES ('price_annual', ?) ON CONFLICT (name) DO UPDATE SET current_value = ?`, [annual_price, annual_price]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to save subscription prices" });
    }
  });

  // Admin: Renew Subscription
  app.post("/api/admin/restaurants/:id/renew-subscription", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { type } = req.body;
      const restaurant = await centralDb.get("SELECT subscription_expires_at FROM restaurants WHERE id = ?", [req.params.id]);
      const baseDate = restaurant?.subscription_expires_at ? new Date(restaurant.subscription_expires_at) : new Date();
      if (baseDate < new Date()) baseDate.setTime(new Date().getTime());
      if (type === 'ANNUALLY') {
        baseDate.setFullYear(baseDate.getFullYear() + 1);
      } else {
        baseDate.setMonth(baseDate.getMonth() + 1);
      }
      await centralDb.run("UPDATE restaurants SET subscription_expires_at = ? WHERE id = ?", [baseDate.toISOString(), req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to renew subscription" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // SUBSCRIPTION BILLING & ACCESS CONTROL (admin-driven, per-tenant)
  // ─────────────────────────────────────────────────────────────────────
  // Helper — compute days-until-due (negative when past due)
  const _daysUntilDue = (due: any): number | null => {
    if (!due) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(due);
    d.setHours(0, 0, 0, 0);
    return Math.round((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  };
  const _billingStatusOf = (row: any): string => {
    if (!row) return 'UNKNOWN';
    if (Number(row.access_revoked) === 1) return 'SUSPENDED';
    if (!row.subscription_due_date) return 'NO_DUE_DATE';
    const days = _daysUntilDue(row.subscription_due_date);
    if (days === null) return 'UNKNOWN';
    const grace = Number(row.grace_period_days ?? 7);
    if (days >= 0) return 'ACTIVE';
    if (Math.abs(days) <= grace) return 'OVERDUE_GRACE';
    return 'OVERDUE_PAST_GRACE';
  };

  // Admin: list all tenants with billing status
  app.get("/api/admin/tenants/billing", authenticate, isAdmin, async (_req: AuthRequest, res: Response) => {
    try {
      const rows: any[] = await centralDb.query(`
        SELECT id, name, slug, is_active,
               subscription_plan, subscription_due_date, grace_period_days,
               subscription_expires_at,
               access_revoked, access_revoked_at, access_revoked_by, access_revoked_reason,
               last_payment_date, last_payment_amount, last_payment_reference,
               billing_notes
          FROM restaurants
         WHERE id <> 'SYSTEM'
         ORDER BY
           CASE WHEN access_revoked = 1 THEN 0
                WHEN subscription_due_date IS NOT NULL AND subscription_due_date < CURRENT_DATE THEN 1
                ELSE 2 END,
           subscription_due_date ASC NULLS LAST,
           name ASC
      `);
      const enriched = rows.map((r: any) => ({
        ...r,
        days_until_due: _daysUntilDue(r.subscription_due_date),
        billing_status: _billingStatusOf(r),
      }));
      res.json(enriched);
    } catch (err) {
      console.error("List tenant billing error:", err);
      res.status(500).json({ error: "Failed to list tenant billing" });
    }
  });

  // Admin: set/update a tenant's billing fields. Pass only what you want to change.
  // Body shape (all optional):
  //   {
  //     subscription_plan: 'STARTER'|'PROFESSIONAL'|'MULTI_OUTLET'|...,
  //     subscription_due_date: 'YYYY-MM-DD' | null,
  //     grace_period_days: 7,
  //     last_payment_date: 'YYYY-MM-DD' | null,
  //     last_payment_amount: number | null,
  //     last_payment_reference: string | null,
  //     billing_notes: string | null
  //   }
  app.put("/api/admin/tenants/:id/billing", authenticate, isAdmin, async (req: AuthRequest, res: Response) => {
    try {
      const tenantId = req.params.id;
      if (tenantId === 'SYSTEM') return res.status(400).json({ error: "Cannot set billing on SYSTEM tenant" });
      const allowed = [
        'subscription_plan', 'subscription_due_date', 'grace_period_days',
        'last_payment_date', 'last_payment_amount', 'last_payment_reference',
        'billing_notes',
      ];
      const updates: Record<string, any> = {};
      for (const k of allowed) {
        if (k in req.body) updates[k] = req.body[k];
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid fields to update" });
      }
      // Validate grace period range
      if (updates.grace_period_days != null) {
        const g = Number(updates.grace_period_days);
        if (!Number.isFinite(g) || g < 0 || g > 90) {
          return res.status(400).json({ error: "grace_period_days must be in [0, 90]" });
        }
        updates.grace_period_days = Math.round(g);
      }
      // Validate amount
      if (updates.last_payment_amount != null) {
        const a = Number(updates.last_payment_amount);
        if (!Number.isFinite(a) || a < 0) {
          return res.status(400).json({ error: "last_payment_amount must be non-negative" });
        }
      }
      // Build SET clause
      const setParts: string[] = [];
      const params: any[] = [];
      for (const [k, v] of Object.entries(updates)) {
        setParts.push(`${k} = ?`);
        params.push(v === '' ? null : v);
      }
      params.push(tenantId);
      await centralDb.run(`UPDATE restaurants SET ${setParts.join(', ')} WHERE id = ?`, params);
      const updated: any = await centralDb.get(
        `SELECT id, name, subscription_plan, subscription_due_date, grace_period_days,
                access_revoked, last_payment_date, last_payment_amount,
                last_payment_reference, billing_notes
           FROM restaurants WHERE id = ?`,
        [tenantId]
      );
      res.json({
        success: true,
        ...updated,
        days_until_due: _daysUntilDue(updated?.subscription_due_date),
        billing_status: _billingStatusOf(updated),
      });
    } catch (err) {
      console.error("Update tenant billing error:", err);
      res.status(500).json({ error: "Failed to update billing" });
    }
  });

  // Admin: revoke a tenant's access (suspend service).
  // Body: { reason?: string }
  app.post("/api/admin/tenants/:id/revoke-access", authenticate, isAdmin, async (req: AuthRequest, res: Response) => {
    try {
      const tenantId = req.params.id;
      if (tenantId === 'SYSTEM') return res.status(400).json({ error: "Cannot revoke SYSTEM tenant" });
      const adminId = req.user?.id || req.user?.email || 'unknown-admin';
      const reason = String(req.body?.reason || 'Subscription payment overdue').slice(0, 500);
      await centralDb.run(
        `UPDATE restaurants
            SET access_revoked = 1,
                access_revoked_at = CURRENT_TIMESTAMP,
                access_revoked_by = ?,
                access_revoked_reason = ?
          WHERE id = ?`,
        [adminId, reason, tenantId]
      );
      res.json({ success: true, access_revoked: true });
    } catch (err) {
      console.error("Revoke access error:", err);
      res.status(500).json({ error: "Failed to revoke access" });
    }
  });

  // Admin: restore a tenant's access (resume service).
  app.post("/api/admin/tenants/:id/restore-access", authenticate, isAdmin, async (req: AuthRequest, res: Response) => {
    try {
      const tenantId = req.params.id;
      await centralDb.run(
        `UPDATE restaurants
            SET access_revoked = 0,
                access_revoked_at = NULL,
                access_revoked_by = NULL,
                access_revoked_reason = NULL
          WHERE id = ?`,
        [tenantId]
      );
      res.json({ success: true, access_revoked: false });
    } catch (err) {
      console.error("Restore access error:", err);
      res.status(500).json({ error: "Failed to restore access" });
    }
  });

  // Tenant-facing: fetch own billing status (called hourly by the banner).
  // Returns minimal info — no admin-only fields like revoked_by.
  app.get("/api/restaurant/:id/billing-status", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const tenantId = req.params.id;
      // Authorisation — anyone authenticated for this tenant or an admin can read.
      const role = req.user?.role;
      const ownTenant = req.user?.restaurantId;
      const isAdminRole = role === 'SUPER_ADMIN' || role === 'CTO';
      if (!isAdminRole && ownTenant !== tenantId) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const row: any = await centralDb.get(
        `SELECT id, name, subscription_plan, subscription_due_date, grace_period_days,
                access_revoked, access_revoked_at, access_revoked_reason,
                last_payment_date
           FROM restaurants WHERE id = ?`,
        [tenantId]
      );
      if (!row) return res.status(404).json({ error: "Tenant not found" });
      const days = _daysUntilDue(row.subscription_due_date);
      const status = _billingStatusOf(row);
      res.json({
        tenant_id: row.id,
        tenant_name: row.name,
        subscription_plan: row.subscription_plan,
        subscription_due_date: row.subscription_due_date,
        grace_period_days: row.grace_period_days ?? 7,
        days_until_due: days,
        last_payment_date: row.last_payment_date,
        access_revoked: Number(row.access_revoked) === 1,
        access_revoked_at: row.access_revoked_at,
        access_revoked_reason: row.access_revoked_reason,
        billing_status: status,
        billing_contact: {
          email: 'billing@atithi-setu.com',
          whatsapp: '+91 70111 89371',
        },
      });
    } catch (err) {
      console.error("Get billing status error:", err);
      res.status(500).json({ error: "Failed to get billing status" });
    }
  });

  // API 404 Handler - MUST be before SPA fallback
  app.use("/api/*", (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
  });

  // Static uploads route with Google Drive fallback
  app.get("/uploads/:filename", async (req, res) => {
    const filename = req.params.filename;
    const localPath = path.join(process.cwd(), "public", "uploads", filename);

    if (fs.existsSync(localPath)) {
      return res.sendFile(localPath);
    }

    // Attempt to download from Google Drive
    try {
      const success = await downloadFromDrive(filename, localPath);
      if (success && fs.existsSync(localPath)) {
        return res.sendFile(localPath);
      }
    } catch (err) {
      console.error(`Fallback download failed for ${filename}:`, err);
    }

    res.status(404).send("File not found");
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Serve static files in production
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const PORT = process.env.PORT || 4001;
  app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // ── Notification Scheduler ──────────────────────────────────────────────────
  // Runs every minute. For each tenant that has a schedule_time set on a
  // schedulable event (e.g. DAILY_REPORT), fires that notification with real data.
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      // Get all active restaurants
      const restaurants = await centralDb.query("SELECT id FROM restaurants WHERE id <> 'SYSTEM'");

      for (const restaurant of restaurants) {
        try {
          const db = await getTenantDb(restaurant.id);
          // Find any notification settings scheduled for right now
          const scheduled = await db.query(
            "SELECT * FROM notification_settings WHERE schedule_time = ? AND schedule_time <> ''",
            [currentTime]
          );

          for (const setting of scheduled) {
            console.log(`[Scheduler] Firing ${setting.event_name} for restaurant ${restaurant.id} at ${currentTime}`);

            let data: any = {};

            // Build real data payload for each schedulable event type
            if (setting.event_name === 'DAILY_REPORT') {
              const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

              // Total orders and revenue for today (exclude cancelled)
              const summary = await db.get(
                `SELECT COUNT(*) as order_count, COALESCE(SUM(total_amount), 0) as revenue
                 FROM orders
                 WHERE DATE(created_at) = ?
                   AND LOWER(status) <> 'cancelled'`,
                [today]
              );

              // Top-selling item for today
              let topItem = 'N/A';
              try {
                const itemRows = await db.query(
                  `SELECT items FROM orders
                   WHERE DATE(created_at) = ?
                     AND LOWER(status) <> 'cancelled'`,
                  [today]
                );
                const countMap: Record<string, number> = {};
                for (const row of itemRows) {
                  try {
                    const items = JSON.parse(row.items || '[]');
                    for (const item of items) {
                      const n = (item.name || '').replace(/\s*\(.*?\)\s*$/, '').trim(); // strip size suffix
                      countMap[n] = (countMap[n] || 0) + (item.quantity || 1);
                    }
                  } catch { /* skip malformed row */ }
                }
                const sorted = Object.entries(countMap).sort((a, b) => b[1] - a[1]);
                if (sorted.length > 0) topItem = sorted[0][0];
              } catch { /* fallback to N/A */ }

              data = {
                date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
                orderCount: parseInt(summary?.order_count ?? '0', 10),
                revenue: parseFloat(summary?.revenue ?? '0').toFixed(2),
                topItem,
              };

              console.log(`[Scheduler] DAILY_REPORT data: orders=${data.orderCount}, revenue=₹${data.revenue}, top="${data.topItem}"`);
            }

            await triggerNotification(restaurant.id, setting.event_name, data);
          }
        } catch (tenantErr) {
          console.error(`[Scheduler] Error processing restaurant ${restaurant.id}:`, tenantErr);
        }
      }
    } catch (err) {
      console.error('[Scheduler] Cron job error:', err);
    }
  });
  console.log('[Scheduler] Notification scheduler started — checking every minute');

  // ─── Hotel SLA watchdog cron (every 2 min) ──────────────────────────────
  cron.schedule('*/2 * * * *', async () => {
    try {
      const hotels: any[] = await centralDb.query(
        "SELECT id, name FROM restaurants WHERE property_type IN ('HOTEL', 'BOTH') AND is_active = 1"
      );
      for (const h of hotels) {
        try {
          const tdb = await getTenantDb(h.id);
          // Fetch active requests with SLA defined
          const rows: any[] = await tdb.query(
            `SELECT sr.*, s.sla_minutes, r.name AS room_name
             FROM service_requests sr
             LEFT JOIN services s ON s.id = sr.service_id
             LEFT JOIN rooms r ON r.id = sr.room_id
             WHERE sr.status IN ('PENDING', 'ACKNOWLEDGED', 'IN_PROGRESS')
               AND s.sla_minutes IS NOT NULL`
          );
          for (const r of rows) {
            const requested = new Date(r.requested_at).getTime();
            const elapsed = (Date.now() - requested) / 60000;
            const threshold = r.sla_minutes * 1.5;
            if (elapsed >= threshold && !r.sla_breach_notified_at) {
              try {
                await triggerNotification(h.id, 'SLA_BREACH', {
                  requestId: r.id,
                  roomName: r.room_name,
                  serviceName: r.service_name,
                  slaMinutes: r.sla_minutes,
                  elapsedMinutes: Math.round(elapsed),
                });
              } catch {}
              // Note: sla_breach_notified_at column isn't in schema yet — we'd repeat.
              // For now we skip the flag; duplicate notifications are acceptable until Phase 2.5.
            }
          }
        } catch (tenantErr) {
          console.error(`[SLA-watchdog] tenant ${h.id} error:`, tenantErr);
        }
      }
    } catch (err) {
      console.error('[SLA-watchdog] error:', err);
    }
  });
  console.log('[SLA-watchdog] Hotel SLA watchdog started — checking every 2 minutes');

  // ─── Pre-arrival upsell emails (Phase 4) ────────────────────────────────
  // Runs once per hour. Sends:
  //   • 7-day-before email: room upgrade / spa / tours upsell
  //   • 1-day-before email: confirmation + late checkout / airport pickup
  // Tracks sent state in booking.special_requests JSON to avoid duplicates
  // (we can migrate to a proper column later).
  cron.schedule('30 * * * *', async () => {
    try {
      const hotels: any[] = await centralDb.query(
        "SELECT id, name, city FROM restaurants WHERE property_type IN ('HOTEL', 'BOTH') AND is_active = 1"
      );
      const today = new Date();
      const in7Days = new Date(today); in7Days.setDate(in7Days.getDate() + 7);
      const in1Day = new Date(today); in1Day.setDate(in1Day.getDate() + 1);
      const iso7 = in7Days.toISOString().slice(0, 10);
      const iso1 = in1Day.toISOString().slice(0, 10);
      for (const h of hotels) {
        try {
          const tdb = await getTenantDb(h.id);
          // Ensure tracking column exists
          await tdb.exec(`ALTER TABLE room_bookings ADD COLUMN IF NOT EXISTS prearrival_stage TEXT;`).catch(() => {});
          // 7-day upsell candidates
          const seven: any[] = await tdb.query(
            `SELECT * FROM room_bookings
             WHERE status = 'BOOKED' AND DATE(check_in_date) = ?::date AND guest_email IS NOT NULL
               AND (prearrival_stage IS NULL OR prearrival_stage = '')`,
            [iso7]
          );
          for (const b of seven) {
            await sendPrearrivalEmail(h, b, 'upsell_7d', tdb);
          }
          // 1-day confirmation
          const one: any[] = await tdb.query(
            `SELECT * FROM room_bookings
             WHERE status = 'BOOKED' AND DATE(check_in_date) = ?::date AND guest_email IS NOT NULL
               AND (prearrival_stage IS NULL OR prearrival_stage NOT LIKE '%confirm_1d%')`,
            [iso1]
          );
          for (const b of one) {
            await sendPrearrivalEmail(h, b, 'confirm_1d', tdb);
          }
        } catch (err) {
          console.error(`[prearrival] tenant ${h.id}:`, err);
        }
      }
    } catch (err) {
      console.error('[prearrival] cron error:', err);
    }
  });
  console.log('[Prearrival-cron] Pre-arrival upsell cron started — hourly at :30');

  // ─── Stale session auto-close (added 2026-04 after Naini-Corbett incident) ──
  // Closes any session that should have been closed by staff but was forgotten.
  // Same staleness predicate as the scan-resume guard:
  //   • status = 'open'
  //   • opened_at older than 4 hours
  //   • no orders in the last 2 hours
  //
  // Schedule: every day at 04:00 Asia/Kolkata (4 AM IST). Restaurants and
  // hotels in India are reliably closed at this time so there's no risk
  // of closing a session while a customer is mid-flow.
  //
  // Safety choices:
  //   • Only sessions in status='open' are closed. status='bill_requested'
  //     means the customer explicitly requested billing — the manual close
  //     flow exists for that. We don't speculate on payment.
  //   • Orders' payment_status is NOT touched. Staff might have collected
  //     cash without clicking 'Close' — orders stay PENDING so the owner
  //     can reconcile in the invoice tab.
  //   • The physical table is freed (status = AVAILABLE) so the next guest
  //     gets a fresh session — same behavior as the manual close-session
  //     endpoint.
  cron.schedule('0 4 * * *', async () => {
    try {
      console.log('[stale-close] 4 AM IST cron starting — sweeping stale sessions across all tenants');
      const restaurants = await centralDb.query(
        "SELECT id FROM restaurants WHERE is_active = 1 AND id <> 'SYSTEM'"
      );
      let totalClosed = 0;
      for (const r of restaurants) {
        try {
          const db = await getTenantDb(r.id);
          const stale: any[] = await db.query(
            `SELECT ts.id, ts.table_id
             FROM table_sessions ts
             WHERE ts.status = 'open'
               AND ts.opened_at < NOW() - INTERVAL '4 hours'
               AND NOT EXISTS (
                 SELECT 1 FROM orders o
                 WHERE o.session_id = ts.id
                   AND o.created_at > NOW() - INTERVAL '2 hours'
               )`
          );
          if (stale.length === 0) continue;
          for (const s of stale) {
            await db.run(
              "UPDATE table_sessions SET status='closed', closed_at=CURRENT_TIMESTAMP WHERE id = ?",
              [s.id]
            );
            if (s.table_id) {
              await db.run(
                "UPDATE tables SET status='AVAILABLE' WHERE id = ?",
                [s.table_id]
              ).catch(() => {});
            }
            totalClosed++;
          }
          console.log(`[stale-close] ${r.id}: auto-closed ${stale.length} stale session(s)`);
        } catch (tenantErr) {
          console.error(`[stale-close] tenant ${r.id} error:`, tenantErr);
        }
      }
      console.log(`[stale-close] cron run complete — ${totalClosed} session(s) auto-closed across all tenants`);
    } catch (err) {
      console.error('[stale-close] cron error:', err);
    }
  }, { timezone: 'Asia/Kolkata' });
  console.log('[stale-close] Stale-session auto-close cron started — daily at 04:00 IST');

  // ─── Inventory: nightly forecast recompute (03:00 IST) ──────────────────
  // Walks every active tenant and refreshes their consumption_forecasts
  // cache. Day-of-week-aware rolling average over the last 28 days.
  // Per-tenant try/catch so one failure doesn't kill the whole sweep.
  cron.schedule('0 3 * * *', async () => {
    try {
      console.log('[inv-forecast] 03:00 IST — recomputing forecasts across all tenants');
      const restaurants = await centralDb.query(
        "SELECT id FROM restaurants WHERE is_active = 1 AND id <> 'SYSTEM'"
      );
      let totalIngredients = 0;
      for (const r of restaurants) {
        try {
          const db = await getTenantDb(r.id);
          const result = await recomputeForecastsForTenant(db);
          totalIngredients += result.updated;
        } catch (tenantErr) {
          console.error(`[inv-forecast] tenant ${r.id} error:`, tenantErr);
        }
      }
      console.log(`[inv-forecast] Done — ${totalIngredients} ingredient forecasts refreshed across ${restaurants.length} tenants`);
    } catch (err) {
      console.error('[inv-forecast] cron error:', err);
    }
  }, { timezone: 'Asia/Kolkata' });
  console.log('[inv-forecast] Forecast recompute cron started — daily at 03:00 IST');

  // ─── Inventory: morning stock-low scan (09:00 IST) ──────────────────────
  // Fires STOCK_LOW notification for ingredients that crossed below their
  // reorder_point. Limit one alert per ingredient per day to avoid spam.
  // STOCK_CRITICAL fires when days_of_cover < lead_time_days (will run out
  // before the next reorder physically arrives).
  cron.schedule('0 9 * * *', async () => {
    try {
      console.log('[inv-stocklow] 09:00 IST — scanning low-stock ingredients across all tenants');
      const restaurants = await centralDb.query(
        "SELECT id FROM restaurants WHERE is_active = 1 AND id <> 'SYSTEM'"
      );
      let totalAlerts = 0;
      let totalAutoPOs = 0;
      for (const r of restaurants) {
        try {
          const db = await getTenantDb(r.id);
          // Find ingredients below reorder + their daily forecast for days_of_cover
          const lowRows: any[] = await db.query(
            `SELECT i.id, i.name, i.unit, i.current_stock_qty, i.reorder_point, i.par_level,
                    i.default_unit_price, i.gst_percent, i.default_supplier_id,
                    COALESCE(f.forecast_qty, 0) AS daily_forecast,
                    s.name AS supplier_name, s.phone AS supplier_phone, s.lead_time_days
               FROM ingredients i
               LEFT JOIN consumption_forecasts f
                 ON f.ingredient_id = i.id AND f.horizon = 'daily'
               LEFT JOIN suppliers s ON s.id = i.default_supplier_id
              WHERE i.is_active = 1
                AND i.reorder_point > 0
                AND i.current_stock_qty <= i.reorder_point`
          );

          // ── Auto-PO generation ── group low-stock items by default supplier
          // and create ONE draft PO per supplier covering all their low items.
          // Skip ingredients already on an open PO (avoid duplicates) or
          // without a default supplier (owner must raise manually).
          const supplierGroups: Record<string, any[]> = {};
          const ingPOMap = new Map<string, string>();  // ing.id → existing po.id (for notification)
          for (const ing of lowRows) {
            // Check if this ingredient is already on an open PO
            const onOrder: any = await db.get(
              `SELECT po.id FROM purchase_order_items poi
                 JOIN purchase_orders po ON po.id = poi.po_id
                WHERE poi.ingredient_id = ?
                  AND po.status IN ('DRAFT', 'SENT', 'PARTIAL')
                  AND poi.is_fully_received = 0
                LIMIT 1`,
              [ing.id]
            ).catch(() => null);
            if (onOrder?.id) {
              ingPOMap.set(ing.id, onOrder.id);
              continue;  // already covered by an open PO
            }
            if (!ing.default_supplier_id) continue;  // no auto-PO without a default supplier
            (supplierGroups[ing.default_supplier_id] = supplierGroups[ing.default_supplier_id] || []).push(ing);
          }

          // Create DRAFT POs per supplier
          for (const [supplierId, items] of Object.entries(supplierGroups)) {
            let totalAmount = 0, gstAmount = 0;
            const lineItems: any[] = [];
            for (const ing of items) {
              const qty = Math.max(0, Number(ing.par_level || 0) - Number(ing.current_stock_qty));
              if (qty <= 0) continue;
              const price = Number(ing.default_unit_price || 0);
              const lineSub = qty * price;
              const lineGst = lineSub * (Number(ing.gst_percent || 0) / 100);
              totalAmount += lineSub;
              gstAmount += lineGst;
              lineItems.push({
                ingredient_id: ing.id,
                qty_ordered: qty,
                unit: ing.unit,
                unit_price: price,
              });
            }
            if (lineItems.length === 0) continue;

            const seq = await getNextTenantSequence(db, 'po');
            const poId = `PO-${String(seq).padStart(4, '0')}`;
            const grandTotal = totalAmount + gstAmount;
            // Default expected delivery = today + lead_time_days
            const lt = Number(items[0].lead_time_days || 1);
            const expectedDate = new Date(Date.now() + lt * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

            await db.run(
              `INSERT INTO purchase_orders
                (id, supplier_id, status, expected_delivery_date,
                 total_amount, gst_amount, grand_total, notes)
               VALUES (?, ?, 'DRAFT', ?, ?, ?, ?, ?)`,
              [
                poId, supplierId, expectedDate,
                totalAmount, gstAmount, grandTotal,
                `Auto-generated from low-stock alert (${lineItems.length} ingredients). Review and Send when ready.`,
              ]
            ).catch(() => {});
            for (const it of lineItems) {
              await db.run(
                `INSERT INTO purchase_order_items
                  (id, po_id, ingredient_id, qty_ordered, unit, unit_price)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                  `POI-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
                  poId, it.ingredient_id, it.qty_ordered, it.unit, it.unit_price,
                ]
              ).catch(() => {});
              ingPOMap.set(it.ingredient_id, poId);
            }
            totalAutoPOs++;
            console.log(`[inv-stocklow] ${r.id}: auto-created ${poId} for ${items[0].supplier_name} (${lineItems.length} items, ₹${grandTotal.toFixed(0)})`);
          }

          // Fire notifications — now with auto-PO id attached if applicable
          for (const ing of lowRows) {
            const daysOfCover = Number(ing.daily_forecast) > 0
              ? Number(ing.current_stock_qty) / Number(ing.daily_forecast)
              : null;
            const leadTime = Number(ing.lead_time_days || 0);
            const isCritical = daysOfCover != null && leadTime > 0 && daysOfCover < leadTime;
            const eventName = isCritical ? 'STOCK_CRITICAL' : 'STOCK_LOW';
            triggerNotification(r.id, eventName, {
              ingredientName: ing.name,
              currentStock: Number(ing.current_stock_qty),
              unit: ing.unit,
              reorderPoint: Number(ing.reorder_point),
              dailyForecast: Number(ing.daily_forecast),
              daysOfCover,
              supplierName: ing.supplier_name,
              supplierPhone: ing.supplier_phone,
              leadTimeDays: leadTime,
              suggestedOrderQty: Math.max(0, Number(ing.par_level || 0) - Number(ing.current_stock_qty)),
              autoPOId: ingPOMap.get(ing.id) || null,  // existing or just-created
            }).catch(() => {});
            totalAlerts++;
          }

          // ── Phase 5: stock-out auto-disable on every active platform ──
          // For ingredients that have actually hit zero (not just below
          // reorder), find every menu item that uses them and enqueue an
          // AVAILABILITY_PUSH(false) per active channel. Idempotent — even
          // if already pushed, the platform-side state converges.
          try {
            const zeroIngs = lowRows.filter((ig: any) => Number(ig.current_stock_qty) <= 0);
            if (zeroIngs.length > 0) {
              const zeroIds = zeroIngs.map((ig: any) => ig.id);
              const placeholders = zeroIds.map(() => '?').join(',');
              const affected: any[] = await db.query(
                `SELECT DISTINCT m.id, m.name, m.external_ids
                   FROM menu m
                   JOIN recipes rcp ON rcp.menu_item_id = m.id
                  WHERE rcp.ingredient_id IN (${placeholders})
                    AND (rcp.effective_to IS NULL OR rcp.effective_to > NOW())`,
                zeroIds
              ).catch(() => [] as any[]);
              if (affected.length > 0) {
                const activeChannels: any[] = await db.query(
                  "SELECT channel FROM channel_settings WHERE is_active = 1"
                ).catch(() => [] as any[]);
                for (const cr of activeChannels) {
                  const ch = String(cr.channel) as ChannelId;
                  const items = affected.map((m: any) => {
                    let extIds = m.external_ids;
                    if (typeof extIds === 'string') { try { extIds = JSON.parse(extIds); } catch { extIds = {}; } }
                    return {
                      externalItemId: extIds?.[ch],
                      isAvailable: false,
                    };
                  }).filter((it: any) => it.externalItemId);
                  if (items.length > 0) {
                    await enqueueSyncJob(db, 'AVAILABILITY_PUSH', ch, { items });
                    console.log(`[inv-stocklow] tenant ${r.id}: enqueued AVAILABILITY_PUSH(${items.length} items, false) for ${ch}`);
                  }
                }
              }
            }
          } catch (autoDisErr) {
            console.warn(`[inv-stocklow] tenant ${r.id} stock-out auto-disable error:`, (autoDisErr as any)?.message);
          }
        } catch (tenantErr) {
          console.error(`[inv-stocklow] tenant ${r.id} error:`, tenantErr);
        }
      }
      console.log(`[inv-stocklow] Done — ${totalAlerts} alerts fired, ${totalAutoPOs} DRAFT POs auto-generated`);
    } catch (err) {
      console.error('[inv-stocklow] cron error:', err);
    }
  }, { timezone: 'Asia/Kolkata' });
  console.log('[inv-stocklow] Stock-low scan cron started — daily at 09:00 IST');

  // ═════════════════════════════════════════════════════════════════════════
  // ── Phase 4 — Outbound delivery-platform sync queue worker ──────────────
  // ═════════════════════════════════════════════════════════════════════════
  // Drains pending_sync_jobs every 30 seconds. Walks every active tenant in
  // its own try/catch — one tenant's queue stuck on a dead platform doesn't
  // block other tenants. Up to 10 jobs claimed per cycle per tenant.
  cron.schedule('*/30 * * * * *', async () => {
    try {
      const restaurants = await centralDb.query(
        "SELECT id FROM restaurants WHERE is_active = 1 AND id <> 'SYSTEM'"
      );
      for (const r of restaurants) {
        try {
          const db = await getTenantDb(r.id);
          // Claim up to 10 due jobs and mark IN_PROGRESS atomically.
          // FOR UPDATE SKIP LOCKED is forward-compatible with multi-instance.
          const due: any[] = await db.query(
            `UPDATE pending_sync_jobs
                SET status = 'IN_PROGRESS', attempts = attempts + 1
              WHERE id IN (
                SELECT id FROM pending_sync_jobs
                 WHERE status IN ('PENDING','FAILED')
                   AND next_attempt_at <= NOW()
                 ORDER BY next_attempt_at ASC LIMIT 10
                 FOR UPDATE SKIP LOCKED
              )
              RETURNING *`
          ).catch(() => [] as any[]);
          for (const job of due as PendingJobRow[]) {
            try {
              const res = await processSyncJob(r.id, db, job);
              await db.run(
                "UPDATE pending_sync_jobs SET status='DONE', completed_at=CURRENT_TIMESTAMP, last_error=? WHERE id = ?",
                [res?.skipped || null, job.id]
              );
            } catch (err: any) {
              const dead = (job.attempts || 0) >= (job.max_attempts || 5);
              const backoff = backoffSeconds(job.attempts || 1);
              await db.run(
                `UPDATE pending_sync_jobs
                    SET status = ?, last_error = ?,
                        next_attempt_at = NOW() + INTERVAL '${backoff} seconds'
                  WHERE id = ?`,
                [dead ? 'DEAD' : 'FAILED', String(err?.message || err).slice(0, 1000), job.id]
              );
              if (dead) {
                triggerNotification(r.id, 'SYNC_JOB_DEAD', {
                  jobId: job.id, jobType: job.job_type, channel: job.channel, error: String(err?.message || err).slice(0, 200),
                }).catch(() => {});
              }
            }
          }
        } catch (tenantErr) {
          // Per-tenant try/catch — one tenant's failure doesn't block others.
          console.warn(`[sync-worker] tenant ${r.id} cycle error:`, (tenantErr as any)?.message);
        }
      }
    } catch (err) {
      console.error('[sync-worker] cron error:', err);
    }
  });
  console.log('[sync-worker] Sync queue worker cron started — every 30s');

  // ── Menu-dirty scanner ─────────────────────────────────────────────────
  // Every 15 minutes, find menu items with sync_dirty=1 across every active
  // tenant and enqueue ONE MENU_PUSH job per active channel containing the
  // dirty items' computed channel-prices. Clears the flag on enqueue.
  cron.schedule('*/15 * * * *', async () => {
    try {
      const restaurants = await centralDb.query(
        "SELECT id FROM restaurants WHERE is_active = 1 AND id <> 'SYSTEM'"
      );
      for (const r of restaurants) {
        try {
          const db = await getTenantDb(r.id);
          // Active channels for this tenant
          const activeChannels: any[] = await db.query(
            "SELECT channel, default_markup_percent FROM channel_settings WHERE is_active = 1"
          ).catch(() => [] as any[]);
          if (activeChannels.length === 0) continue;

          // Dirty menu items
          const dirtyItems: any[] = await db.query(
            `SELECT id, name, description, price, price_full, category, image_url, is_available, dietary_type, external_ids
               FROM menu WHERE sync_dirty = 1 LIMIT 200`
          ).catch(() => [] as any[]);
          if (dirtyItems.length === 0) continue;

          // Build per-channel MENU_PUSH job. Enqueue independently per channel
          // so a flaky platform doesn't block the others.
          for (const ch of activeChannels) {
            const channelId = String(ch.channel) as ChannelId;
            const defaultMarkup = Number(ch.default_markup_percent || 25);
            // Bulk-fetch overrides for this channel + these item ids
            const itemIds = dirtyItems.map(i => i.id);
            const placeholders = itemIds.map(() => '?').join(',');
            const overrides: any[] = await db.query(
              `SELECT * FROM channel_prices WHERE channel = ? AND menu_item_id IN (${placeholders})`,
              [channelId, ...itemIds]
            ).catch(() => [] as any[]);
            const overrideByItem: Record<string, any> = {};
            overrides.forEach((o: any) => { overrideByItem[o.menu_item_id] = o; });

            const pushItems = dirtyItems.map(it => {
              const basePrice = Number(it.price_full ?? it.price ?? 0);
              const cp = overrideByItem[it.id];
              if (cp && Number(cp.is_listed) === 0) return null; // hidden on this channel
              let price = basePrice * (1 + defaultMarkup / 100);
              if (cp?.price_override != null) price = Number(cp.price_override);
              else if (cp?.markup_percent != null) price = basePrice * (1 + Number(cp.markup_percent) / 100);
              const externalId = (it.external_ids && typeof it.external_ids === 'object')
                ? it.external_ids[channelId]
                : (() => { try { return JSON.parse(it.external_ids || '{}')[channelId]; } catch { return undefined; } })();
              return {
                localMenuItemId: it.id,
                externalItemId: externalId,
                name: it.name,
                description: it.description || undefined,
                price: Math.round(price * 100) / 100,
                category: it.category || 'Other',
                isAvailable: Number(it.is_available || 0) === 1,
                imageUrl: it.image_url || undefined,
                dietaryType: it.dietary_type || undefined,
              };
            }).filter(Boolean);
            if (pushItems.length === 0) continue;

            await enqueueSyncJob(db, 'MENU_PUSH', channelId, { items: pushItems });
          }

          // Clear dirty flag for the items we processed
          const clearIds = dirtyItems.map(i => i.id);
          if (clearIds.length > 0) {
            const cph = clearIds.map(() => '?').join(',');
            await db.run(
              `UPDATE menu SET sync_dirty = 0 WHERE id IN (${cph})`,
              clearIds
            ).catch(() => {});
          }
          if (dirtyItems.length > 0) {
            console.log(`[menu-dirty] tenant ${r.id}: enqueued ${activeChannels.length} MENU_PUSH job(s) covering ${dirtyItems.length} items`);
          }
        } catch (tenantErr) {
          console.warn(`[menu-dirty] tenant ${r.id} error:`, (tenantErr as any)?.message);
        }
      }
    } catch (err) {
      console.error('[menu-dirty] cron error:', err);
    }
  }, { timezone: 'Asia/Kolkata' });
  console.log('[menu-dirty] Menu sync-dirty scanner started — every 15 min');

  // ── Manual retry endpoint for DEAD jobs ───────────────────────────────
  app.post("/api/restaurant/:id/integrations/sync-jobs/:jobId/retry", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const job: any = await db.get("SELECT * FROM pending_sync_jobs WHERE id = ?", [req.params.jobId]);
      if (!job) return res.status(404).json({ error: "Job not found" });
      if (job.status === 'DONE') return res.status(409).json({ error: "Job already DONE — nothing to retry" });
      // Reset attempts + push next_attempt_at to NOW so the worker picks it up next cycle
      await db.run(
        `UPDATE pending_sync_jobs
            SET status = 'PENDING', attempts = 0,
                next_attempt_at = CURRENT_TIMESTAMP, last_error = NULL
          WHERE id = ?`,
        [req.params.jobId]
      );
      res.json({ success: true, message: "Job queued for immediate retry" });
    } catch (err) {
      console.error("Retry sync-job error:", err);
      res.status(500).json({ error: "Failed to retry job" });
    }
  });

  // List sync jobs (status filter, limit) — drives the future Sync Health UI
  app.get("/api/restaurant/:id/integrations/sync-jobs", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      const { status, channel } = req.query as any;
      const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
      const conds: string[] = [];
      const params: any[] = [];
      if (status) { conds.push("status = ?"); params.push(String(status).toUpperCase()); }
      if (channel) { conds.push("channel = ?"); params.push(String(channel).toUpperCase()); }
      const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const rows: any[] = await db.query(
        `SELECT id, job_type, channel, status, attempts, max_attempts,
                next_attempt_at, last_error, created_at, completed_at
           FROM pending_sync_jobs
           ${whereSql}
          ORDER BY created_at DESC LIMIT ${limit}`,
        params
      );
      const counts: any = await db.get(
        `SELECT
            COUNT(*) FILTER (WHERE status = 'PENDING') AS pending,
            COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
            COUNT(*) FILTER (WHERE status = 'DEAD') AS dead,
            COUNT(*) FILTER (WHERE status = 'DONE' AND completed_at > NOW() - INTERVAL '24 hours') AS done_24h
           FROM pending_sync_jobs`
      ).catch(() => null);
      res.json({ jobs: rows, counts: counts || {} });
    } catch (err) {
      console.error("List sync-jobs error:", err);
      res.status(500).json({ error: "Failed to list sync jobs" });
    }
  });
}

// Helper: send pre-arrival email and record which stage was sent
async function sendPrearrivalEmail(hotel: any, booking: any, stage: 'upsell_7d' | 'confirm_1d', tdb: DbInterface): Promise<void> {
  try {
    const isUpsell = stage === 'upsell_7d';
    const subject = isUpsell
      ? `Looking forward to your stay at ${hotel.name} — upgrade your visit`
      : `Your ${hotel.name} arrival tomorrow — confirmation & tips`;

    const text = isUpsell
      ? `Dear ${booking.guest_name},\n\n` +
        `We're delighted to confirm your upcoming stay at ${hotel.name}${hotel.city ? ` in ${hotel.city}` : ''} on ${new Date(booking.check_in_date).toLocaleDateString('en-IN')}.\n\n` +
        `Want to elevate your experience? Popular add-ons our guests love:\n` +
        `• Room upgrade (to Deluxe / Suite) — just ₹1,500-3,000 more per night\n` +
        `• Spa & wellness session — book in advance to reserve your slot\n` +
        `• Early check-in (12 noon) — ₹500\n` +
        `• Airport pickup — ₹1,200\n\n` +
        `Reply to this email or scan the in-room QR on arrival to add any of these.\n\n` +
        `See you soon!\n${hotel.name} Team`
      : `Dear ${booking.guest_name},\n\n` +
        `We're looking forward to welcoming you tomorrow at ${hotel.name}.\n\n` +
        `Your reservation\n` +
        `  Check-in:  ${new Date(booking.check_in_date).toLocaleDateString('en-IN')}\n` +
        `  Check-out: ${new Date(booking.check_out_date).toLocaleDateString('en-IN')}\n` +
        `  Guests:    ${booking.num_guests || 1}\n\n` +
        `Last-minute options:\n` +
        `• Late check-out (extend by 2 hours) — ₹500\n` +
        `• Airport pickup — ₹1,200 (reply to this email to arrange)\n\n` +
        `Safe travels — we'll have your room ready.\n\n${hotel.name} Team`;

    const html = isUpsell
      ? `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:auto;padding:24px;background:#faf7f2">
           <div style="background:linear-gradient(135deg,#cc5a16 0%,#a84612 100%);color:#fff;padding:24px;border-radius:24px 24px 0 0">
             <h1 style="font-family:Georgia,serif;margin:0;font-size:24px">Your stay awaits</h1>
             <p style="margin:6px 0 0;opacity:0.85">${hotel.name}</p>
           </div>
           <div style="background:#fff;padding:24px;border-radius:0 0 24px 24px">
             <p>Dear ${booking.guest_name},</p>
             <p>We're delighted to confirm your upcoming stay on <strong>${new Date(booking.check_in_date).toLocaleDateString('en-IN')}</strong>.</p>
             <p>Want to elevate your experience? Popular add-ons our guests love:</p>
             <ul style="line-height:1.8">
               <li>🛎 Room upgrade — from ₹1,500/night</li>
               <li>💆 Spa &amp; wellness session</li>
               <li>⏰ Early check-in (12 noon) — ₹500</li>
               <li>✈️ Airport pickup — ₹1,200</li>
             </ul>
             <p>Reply to this email or use the in-room QR to add any of these.</p>
             <p style="margin-top:24px">See you soon!<br/><strong>${hotel.name} Team</strong></p>
           </div>
         </div>`
      : `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:auto;padding:24px;background:#faf7f2">
           <div style="background:#0f766e;color:#fff;padding:24px;border-radius:24px 24px 0 0">
             <h1 style="font-family:Georgia,serif;margin:0;font-size:24px">See you tomorrow!</h1>
             <p style="margin:6px 0 0;opacity:0.85">${hotel.name}</p>
           </div>
           <div style="background:#fff;padding:24px;border-radius:0 0 24px 24px">
             <p>Dear ${booking.guest_name},</p>
             <p>We're looking forward to welcoming you tomorrow.</p>
             <table style="border-collapse:collapse;margin:12px 0">
               <tr><td style="padding:4px 12px 4px 0;color:#6b5d52">Check-in</td><td><strong>${new Date(booking.check_in_date).toLocaleDateString('en-IN')}</strong></td></tr>
               <tr><td style="padding:4px 12px 4px 0;color:#6b5d52">Check-out</td><td><strong>${new Date(booking.check_out_date).toLocaleDateString('en-IN')}</strong></td></tr>
               <tr><td style="padding:4px 12px 4px 0;color:#6b5d52">Guests</td><td><strong>${booking.num_guests || 1}</strong></td></tr>
             </table>
             <p><strong>Last-minute options:</strong></p>
             <ul style="line-height:1.8">
               <li>⏰ Late check-out (extend by 2 hours) — ₹500</li>
               <li>✈️ Airport pickup — ₹1,200 (reply to arrange)</li>
             </ul>
             <p style="margin-top:24px">Safe travels — we'll have your room ready.<br/><strong>${hotel.name} Team</strong></p>
           </div>
         </div>`;

    await sendEmail(booking.guest_email, subject, text, html);

    const prev = booking.prearrival_stage || '';
    const next = prev ? `${prev},${stage}` : stage;
    await tdb.run("UPDATE room_bookings SET prearrival_stage = ? WHERE id = ?", [next, booking.id]);
    console.log(`[prearrival] Sent ${stage} to ${booking.guest_email} for booking ${booking.id}`);
  } catch (err) {
    console.error(`[prearrival] send failed for ${booking.id}:`, err);
  }
}

startServer().catch(console.error);
