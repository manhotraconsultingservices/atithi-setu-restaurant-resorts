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
import { chatWithConcierge, analyzeSentiment } from "./aiService.ts";
import { provisionTenantSubdomain, deprovisionTenantSubdomain, cloudflareIsConfigured } from "./cloudflareService.ts";
import { downloadFromDrive } from "./googleDriveService.ts";
import multer from "multer";
import cron from "node-cron";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

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

// Middleware
const authenticate = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token provided" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    req.user = decoded;
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

      const content = buildNotificationContent(eventName, data);
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

      const keys = Object.keys(updates);
      if (keys.length === 0) return res.status(400).json({ error: "No updates provided" });

      const setClause = keys.map(k => `${k} = ?`).join(", ");
      const params = [...Object.values(updates), req.params.id];

      await db.run(`UPDATE menu SET ${setClause} WHERE id = ?`, params);
      res.json({ success: true });
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

      // Wipe existing recipe rows for this menu item
      await db.run("DELETE FROM recipes WHERE menu_item_id = ?", [menuItemId]);

      const allowedSizes = new Set(['FULL', 'HALF', 'BOTH']);
      let inserted = 0;
      for (const it of items) {
        if (!it.ingredient_id || it.qty_per_serving == null) continue;
        const sizeVariant = allowedSizes.has(String(it.size_variant || 'BOTH').toUpperCase())
          ? String(it.size_variant || 'BOTH').toUpperCase()
          : 'BOTH';
        await db.run(
          `INSERT INTO recipes (id, menu_item_id, ingredient_id, qty_per_serving, unit, size_variant, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            `REC-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            menuItemId,
            it.ingredient_id,
            Number(it.qty_per_serving),
            String(it.unit || 'g').toLowerCase(),
            sizeVariant,
            it.notes || null,
          ]
        );
        inserted++;
      }
      res.json({ success: true, inserted });
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
      // TODO Phase 4: email PO PDF to supplier email if provided
      res.json({ success: true, status: 'SENT' });
    } catch (err) {
      res.status(500).json({ error: "Failed to send PO" });
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
        const lineTotal = qty * unitPrice;
        totalAmount += lineTotal;

        // Insert GRN line
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

        // Atomic stock increment + return new balance
        const updated: any[] = await db.query(
          `UPDATE ingredients
              SET current_stock_qty = current_stock_qty + ?,
                  default_unit_price = COALESCE(?, default_unit_price),
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          RETURNING current_stock_qty`,
          [qty, unitPrice > 0 ? unitPrice : null, it.ingredient_id]
        );
        const newBalance = Number(updated[0]?.current_stock_qty ?? ing.current_stock_qty + qty);

        // Audit log
        await db.run(
          `INSERT INTO stock_movements
            (id, ingredient_id, qty_delta, unit, movement_type, reference_type, reference_id,
             balance_after, unit_cost, recorded_by_user_id, notes)
           VALUES (?, ?, ?, ?, 'GRN', 'grn', ?, ?, ?, ?, ?)`,
          [
            `MOV-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            it.ingredient_id, qty, unit, grnId,
            newBalance, unitPrice || null, req.user!.id,
            condition !== 'GOOD' ? `Received condition: ${condition}` : null,
          ]
        );

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
      const recipeRows: any[] = await db.query(
        `SELECT r.ingredient_id, r.qty_per_serving, r.unit
           FROM recipes r
          WHERE r.menu_item_id = ?
            AND (r.size_variant = 'BOTH' OR r.size_variant = ?)`,
        [menuItemId, sizeKey === 'HALF' ? 'HALF' : 'FULL']
      ).catch(() => [] as any[]);

      for (const r of recipeRows) {
        const consumed = Number(r.qty_per_serving) * qty;
        if (!Number.isFinite(consumed) || consumed <= 0) continue;
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
        const unit = String(updated[0].unit || r.unit || 'unit');
        // Append to audit log
        await db.run(
          `INSERT INTO stock_movements
            (id, ingredient_id, qty_delta, unit, movement_type, reference_type, reference_id, balance_after)
           VALUES (?, ?, ?, ?, 'CONSUMPTION', 'order', ?, ?)`,
          [movId(), r.ingredient_id, -consumed, unit, orderId, balanceAfter]
        ).catch(() => {});
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

      const wid = `WAS-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await db.run(
        `INSERT INTO wastage_logs (id, ingredient_id, qty, unit, reason, notes, logged_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [wid, ingredient_id, wQty, wUnit, safeReason, notes || null, req.user!.id || null]
      );

      // Atomic stock decrement + audit
      const updated: any[] = await db.query(
        `UPDATE ingredients SET current_stock_qty = current_stock_qty - ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? RETURNING current_stock_qty`,
        [wQty, ingredient_id]
      );
      const balanceAfter = Number(updated[0]?.current_stock_qty || 0);
      await db.run(
        `INSERT INTO stock_movements
          (id, ingredient_id, qty_delta, unit, movement_type, reference_type, reference_id, balance_after, recorded_by_user_id, notes)
         VALUES (?, ?, ?, ?, 'WASTAGE', 'wastage', ?, ?, ?, ?)`,
        [movId(), ingredient_id, -wQty, wUnit, wid, balanceAfter, req.user!.id || null, `${safeReason}${notes ? ': ' + notes : ''}`]
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
