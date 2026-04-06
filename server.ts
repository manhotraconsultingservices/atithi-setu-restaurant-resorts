import express from "express";
import type { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { centralDb, getTenantDb, initDb, seedLocations, getNextSequence, DbInterface } from "./db.ts";
import { sendEmail, sendSMS, sendWhatsApp, sendTelegram, buildNotificationContent } from "./notificationService.ts";
import { downloadFromDrive } from "./googleDriveService.ts";
import multer from "multer";
import cron from "node-cron";

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), "public", "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const JWT_SECRET = process.env.JWT_SECRET || "fallback-secret-atithi-setu-2024";

// Extended Request Interface for TypeScript
interface AuthRequest extends Request {
  user?: {
    id: string;
    restaurantId: string;
    role: string;
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
  app.post("/api/admin/reset-owner-password", authenticate, isAdmin, async (req: AuthRequest, res: Response) => {
    const { restaurantId, newPassword } = req.body;
    try {
      const hashedPassword = await bcrypt.hash(newPassword, 12);
      await centralDb.run("UPDATE users SET password = ? WHERE restaurant_id = ? AND role = 'OWNER'", [hashedPassword, restaurantId]);
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

      // Insert into legacy restaurants table — is_active=0 (pending admin approval)
      await centralDb.run(
        `INSERT INTO restaurants (id, name, admin_id, state, city, is_active, registered_at)
         VALUES (?, ?, ?, ?, ?, 0, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [restaurantId, restaurant_name.trim(), email.toLowerCase(), 'N/A', location_city.trim()]
      );

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
          `SELECT id, name, city FROM restaurants WHERE id = ?`,
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
                COALESCE(r.is_active, 0) AS is_active
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
  app.post("/api/restaurant/:id/menu", authenticate, upload.single('image'), async (req: AuthRequest, res: Response) => {
    try {
      const { name, description, price, price_half, price_full, category, dietary_type, is_daily_special, drive_url } = req.body;
      const db = await getTenantDb(req.params.id);
      const id = randomUUID();
      let imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
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
  app.patch("/api/menu/:id", authenticate, upload.single('image'), async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const updates: Record<string, any> = { ...req.body };

      // If a new image file was uploaded, replace image_url
      if (req.file) {
        updates['image_url'] = `/uploads/${req.file.filename}`;
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

  // Update Restaurant Settings
  app.patch("/api/restaurant/:id", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { name, gst_number, gst_percentage, is_gst_enabled, template_id, table_count, upi_id, checkout_mode } = req.body;

      await centralDb.run(`
        UPDATE restaurants SET
          name = ?,
          gst_number = ?,
          gst_percentage = ?,
          is_gst_enabled = ?,
          template_id = ?,
          table_count = ?,
          upi_id = ?,
          checkout_mode = ?
        WHERE id = ?
      `, [
        name,
        gst_number || null,
        gst_percentage || 5,
        is_gst_enabled ? 1 : 0,
        template_id || 'CLASSIC',
        table_count || 0,
        upi_id || null,
        checkout_mode || 'postpaid',
        req.params.id
      ]);

      res.json({ success: true });
    } catch (err) {
      console.error("Update restaurant error:", err);
      res.status(500).json({ error: "Failed to update restaurant settings" });
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

      // 1. Try to resume an active session by stored token (open OR bill_requested)
      //    A customer who re-scans after requesting the bill should still see their session.
      if (session_token) {
        const existingByToken = await db.get(
          "SELECT * FROM table_sessions WHERE session_token = ? AND status IN ('open', 'bill_requested')",
          [session_token]
        );
        if (existingByToken) return returnSession(existingByToken);
      }

      // 2. Find the most-recent OPEN session for this table (fresh scan — no stored token)
      //    Only resumes 'open' sessions so that a new guest scanning after bill_requested
      //    gets a brand-new session (treated as second guest).
      if (table_id) {
        const existingByTable = await db.get(
          "SELECT * FROM table_sessions WHERE table_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1",
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

      // Defaults: if gst_percent not set on session, use restaurant setting
      const defaultGstPct  = restaurant?.is_gst_enabled ? (Number(restaurant.gst_percentage) || 5) : 0;
      const defaultApplyGst = restaurant?.is_gst_enabled ? 1 : 0;

      res.json({
        session: {
          ...session,
          table_display_name: tableRow?.name || session.table_name || session.table_id,
          discount_amount:        Number(session.discount_amount || 0),
          service_charge_percent: Number(session.service_charge_percent || 0),
          gst_percent:  (session.gst_percent != null && Number(session.gst_percent) > 0)
                          ? Number(session.gst_percent) : defaultGstPct,
          apply_gst:    session.apply_gst != null ? Number(session.apply_gst) : defaultApplyGst,
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

      const session = await db.get(
        "SELECT * FROM table_sessions WHERE session_token = ? AND status = 'open'",
        [req.params.token]
      );
      if (!session) return res.status(404).json({ error: "Open session not found" });

      // Aggregate bill from all orders in this session (subtotal + GST)
      const orderRows = await db.query(
        "SELECT total_amount, gst_amount FROM orders WHERE session_id = ?",
        [session.id]
      );
      const billAmount = orderRows.reduce(
        (s: number, o: any) => s + Number(o.total_amount || 0) + Number(o.gst_amount || 0),
        0
      );

      await db.run(
        `UPDATE table_sessions
            SET status = 'bill_requested', bill_amount = ?, bill_requested_at = CURRENT_TIMESTAMP, payment_method = ?
          WHERE id = ?`,
        [billAmount, payment_method || null, session.id]
      );

      // Notify owner + waiters
      triggerNotification(req.params.id, 'ORDER_PLACED', {
        orderId:       session.id,
        tableNumber:   session.table_name || session.table_id,
        items:         [`Bill requested for ${session.table_name || 'Table'} — ₹${billAmount.toFixed(2)}`],
        total:         billAmount,
        customerPhone: session.customer_phone,
        customerEmail: null,
      }).catch(() => {});

      res.json({ success: true, bill_amount: billAmount, session_token: req.params.token });
    } catch (err) {
      console.error("Request bill error:", err);
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

      const orders = await db.query(
        `SELECT * FROM orders
         WHERE status NOT IN ('DELIVERED','CANCELLED')
           AND (kitchen_status IS NULL OR kitchen_status NOT IN ('held_for_payment'))
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

  // ─── Invoice Endpoints ─────────────────────────────────────────────────────

  // Invoices: consolidated list — SESSION invoices (postpaid, 1 per session) + ORDER invoices (prepaid/manual)
  app.get("/api/restaurant/:id/invoices", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);

      // ── 1. SESSION invoices (postpaid): one consolidated invoice per session ──
      const sessions = await db.query(
        `SELECT ts.*,
                COALESCE(ts.invoice_status, 'DRAFT') as invoice_status,
                t.name as table_name
         FROM table_sessions ts
         LEFT JOIN tables t ON t.id = ts.table_id
         WHERE ts.status IN ('bill_requested', 'closed')
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
        sessionInvoices.push({
          id:                     sess.session_token,
          session_db_id:          sess.id,
          session_token:          sess.session_token,
          invoice_type:           'SESSION',
          invoice_status:         sess.invoice_status,
          customer_name:          sess.customer_name || '',
          customer_phone:         sess.customer_phone || '',
          table_number:           sess.table_name || sess.table_id,
          created_at:             sess.opened_at,
          total_amount:           Number(sess.bill_amount || sess.final_amount || rawSubtotal || 0),
          raw_subtotal:           rawSubtotal,
          discount_amount:        Number(sess.discount_amount || 0),
          service_charge_percent: Number(sess.service_charge_percent || 0),
          gst_percent:            Number(sess.gst_percent || 0),
          apply_gst:              Number(sess.apply_gst ?? 1),
          session_status:         sess.status,
          round_count:            orders.length,
          items:                  combinedItems,
          // Per-round data for thermal print (label + items)
          rounds:                 orders.map((o: any, idx: number) => ({
            label: orders.length > 1 ? `-- Round ${o.round_number || idx + 1} --` : undefined,
            items: (Array.isArray(o.items) ? o.items : []).map((it: any) => ({
              name:  it.name  || '',
              qty:   Number(it.quantity || 1),
              price: Number(it.price    || 0),
            })),
          })),
        });
      }

      // ── 2. ORDER invoices: prepaid + manual (no session_id) ──
      const standaloneOrders = await db.query(
        `SELECT *, COALESCE(invoice_status, 'DRAFT') as invoice_status, 'ORDER' as invoice_type
         FROM orders
         WHERE (session_id IS NULL OR session_id = '')
           AND status != 'CANCELLED'
         ORDER BY created_at DESC`
      );
      standaloneOrders.forEach((o: any) => {
        if (typeof o.items === 'string') { try { o.items = JSON.parse(o.items); } catch { o.items = []; } }
      });

      // Merge and sort by date descending
      const allInvoices = [...sessionInvoices, ...standaloneOrders].sort(
        (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
      );

      res.json(allInvoices);
    } catch (err) {
      console.error("Failed to fetch invoices:", err);
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
  app.patch("/api/restaurant/:id/sessions/:token/invoice-status", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { invoice_status } = req.body;
      const db = await getTenantDb(req.params.id);
      await db.run("UPDATE table_sessions SET invoice_status = ? WHERE session_token = ?", [invoice_status, req.params.token]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to update session invoice status" });
    }
  });

  app.post("/api/restaurant/:id/invoices/manual", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.params.id);
      await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_status TEXT DEFAULT 'DRAFT'").catch(() => {});
      const { customer_name, customer_phone, reference, items, discount_amount, service_charge_percent, gst_percent, apply_gst } = req.body;
      const id = `MAN-${Date.now()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
      const total = (items || []).reduce((s: number, it: any) => s + Number(it.price || 0) * Number(it.quantity || 1), 0);
      const after = Math.max(0, total - Number(discount_amount || 0));
      const svc = after * Number(service_charge_percent || 0) / 100;
      const taxable = after + svc;
      const gst = apply_gst ? taxable * Number(gst_percent || 0) / 100 : 0;
      const grand = taxable + gst;
      await db.run(
        `INSERT INTO orders (id, table_number, customer_name, customer_phone, items, total_amount, status, payment_status, invoice_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'CONFIRMED', 'PENDING', 'DRAFT', NOW())`,
        [id, reference || 'Manual', customer_name || '', customer_phone || '', JSON.stringify(items || []), grand]
      );
      res.json({ success: true, id, grand_total: grand });
    } catch (err) {
      res.status(500).json({ error: "Failed to create manual invoice" });
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

      // Resolve restaurant checkout_mode (body overrides, then DB, then default)
      let checkoutMode = bodyCheckoutMode;
      if (!checkoutMode) {
        const resto = await centralDb.get("SELECT checkout_mode FROM restaurants WHERE id = ?", [req.params.id]);
        checkoutMode = resto?.checkout_mode || 'postpaid';
      }

      const id = `ORD-${Date.now()}`;

      const finalTableNumber  = table_number || tableNumber;
      const finalTotalAmount  = total_amount || totalAmount;
      const finalGstAmount    = gst_amount || gstAmount;
      const finalCustomerName = customer_name || customerName;
      const finalCustomerPhone= customer_phone || customerPhone;
      const finalCustomerEmail= customer_email || customerEmail;
      const finalPaymentMethod= payment_method || paymentMethod;

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

          // Update session customer info + round_count on first round
          if (roundNumber === 1) {
            await db.run(
              `UPDATE table_sessions SET customer_name = COALESCE(customer_name, ?), customer_phone = COALESCE(customer_phone, ?) WHERE id = ?`,
              [finalCustomerName || null, finalCustomerPhone || null, finalSessionId]
            );
          }
          await db.run(
            "UPDATE table_sessions SET round_count = ? WHERE id = ?",
            [roundNumber, finalSessionId]
          );
        }
      }

      // ── kitchen_status depends on mode ───────────────────────────────────
      // Prepaid: hold order until payment confirmed; Postpaid: queue immediately
      const kitchenStatus = checkoutMode === 'prepaid' ? 'held_for_payment' : 'queued';
      const orderStatus   = checkoutMode === 'prepaid' ? 'PENDING' : 'CONFIRMED';

      await db.run(`
        INSERT INTO orders
          (id, table_number, items, total_amount, gst_amount, status, customer_name, customer_phone,
           customer_email, payment_method, session_id, checkout_mode, round_number, kitchen_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      ]);

      res.json({ success: true, id, orderId: id, checkout_mode: checkoutMode, kitchen_status: kitchenStatus });

      // ── Notifications (non-blocking) ─────────────────────────────────────
      const itemLabels = (items as any[]).map((i: any) =>
        `${i.name || i.item_name || 'Item'} x${i.quantity ?? 1}`
      );

      // Postpaid → notify owner + waiters immediately (order is in kitchen)
      // Prepaid  → notify only after payment webhook confirms (handled in /payment endpoint)
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

      await centralDb.run(`
        INSERT INTO restaurants (id, name, admin_id, state, city, is_active, sales_rep_id, registered_at, subscription_expires_at) 
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
      `, [restaurantId, restaurantName, userId, state, city, sales_rep_id || null, now, expiresAt.toISOString()]);

      await centralDb.run(`
        INSERT INTO users (id, login_id, name, email, phone, password, restaurant_id, role)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [userId, loginId, name, email, phone, hashedPassword, restaurantId, 'OWNER']);

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

  // Staff: Get Staff
  app.get("/api/owner/staff", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const db = await getTenantDb(req.user!.restaurantId);
      const staff = await db.query("SELECT id, login_id, name, role, phone, email, is_active FROM attendance_staff ORDER BY name");
      res.json(staff);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch staff" });
    }
  });

  // Staff: Create Staff
  app.post("/api/owner/staff", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const { name, role, phone, email, loginId, password } = req.body;
      const db = await getTenantDb(req.user!.restaurantId);
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
      const { newPassword } = req.body;
      const db = await getTenantDb(req.user!.restaurantId);
      const hashedPassword = await bcrypt.hash(newPassword, 12);
      await db.run("UPDATE attendance_staff SET password = ? WHERE id = ?", [hashedPassword, req.params.id]);
      res.json({ success: true });
    } catch (err) {
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
      res.json(live);
    } catch (err) {
      console.error("Live tables error:", err);
      res.status(500).json({ error: "Failed to fetch live table data" });
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
      } else {
        await db.run("UPDATE orders SET payment_status = ? WHERE id = ?", [status || 'PAID', req.params.id]);
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
      res.json({ ...order, items, discount_amount: Number(order.discount_amount || 0), service_charge_percent: Number(order.service_charge_percent || 0), gst_percent: Number(order.gst_percent || 0), apply_gst: order.apply_gst === undefined ? 1 : Number(order.apply_gst) });
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
      const { items, discount_amount = 0, service_charge_percent = 0, gst_percent = 5, apply_gst = 1 } = req.body;
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
}

startServer().catch(console.error);
