import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import multer from "multer";
import fs from "fs";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import twilio from 'twilio';
import nodemailer from 'nodemailer';
import axios from 'axios';
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const centralDb = new Database("central.db");
centralDb.pragma('journal_mode = WAL');
centralDb.pragma('busy_timeout = 5000');
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-key";

const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN 
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) 
  : null;

// Notification Engine
const emailTransporter = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
}) : null;

async function sendEmail(to: string, subject: string, text: string) {
  if (!emailTransporter) {
    console.log("Email not configured. Message would have been:", text);
    return;
  }
  try {
    await emailTransporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      text,
    });
    console.log(`Email sent to ${to}`);
  } catch (err) {
    console.error("Failed to send email:", err);
  }
}

async function sendSMS(to: string, message: string) {
  if (!twilioClient) {
    console.log("Twilio not configured for SMS. Message would have been:", message);
    return;
  }
  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER, // Need to add this to .env
      to,
      body: message
    });
    console.log(`SMS sent to ${to}`);
  } catch (err) {
    console.error("Failed to send SMS:", err);
  }
}

async function sendWhatsAppMeta(to: string, message: string) {
  const accessToken = process.env.META_WA_ACCESS_TOKEN;
  const phoneNumberId = process.env.META_WA_PHONE_NUMBER_ID;
  
  if (!accessToken || !phoneNumberId) {
    console.log("Meta WhatsApp not configured. Falling back to Twilio if available.");
    return false;
  }

  try {
    const cleanNumber = to.replace(/\D/g, '');
    await axios.post(
      `https://graph.facebook.com/v17.0/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to: cleanNumber,
        type: "text",
        text: { body: message }
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log(`Meta WhatsApp sent to ${to}`);
    return true;
  } catch (err: any) {
    console.error("Failed to send Meta WhatsApp:", err.response?.data || err.message);
    return false;
  }
}

async function sendWhatsApp(to: string, message: string) {
  // Try Meta first, then fallback to Twilio
  const metaSuccess = await sendWhatsAppMeta(to, message);
  if (metaSuccess) return;

  if (!twilioClient || !process.env.TWILIO_WHATSAPP_FROM) {
    console.log("Twilio WhatsApp not configured. Message would have been:", message);
    return;
  }
  try {
    const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: formattedTo,
      body: message
    });
    console.log(`Twilio WhatsApp sent to ${formattedTo}`);
  } catch (err) {
    console.error("Failed to send Twilio WhatsApp:", err);
  }
}

async function notify(restaurantId: string, eventName: string, recipient: { phone?: string, email?: string }, data: { subject?: string, message: string }) {
  const settings = centralDb.prepare("SELECT * FROM notification_settings WHERE restaurant_id = ? AND event_name = ?").get(restaurantId) as any;
  if (!settings) return;

  if (settings.whatsapp_enabled && recipient.phone) {
    await sendWhatsApp(recipient.phone, data.message);
  }
  if (settings.sms_enabled && recipient.phone) {
    await sendSMS(recipient.phone, data.message);
  }
  if (settings.email_enabled && recipient.email) {
    await sendEmail(recipient.email, data.subject || "Notification", data.message);
  }
}

// Ensure directories exist
const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const dbsDir = path.join(process.cwd(), "dbs");
if (!fs.existsSync(dbsDir)) fs.mkdirSync(dbsDir);

// Initialize Central Database
centralDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    login_id TEXT NOT NULL,
    email TEXT,
    password TEXT NOT NULL,
    restaurant_id TEXT,
    role TEXT DEFAULT 'OWNER',
    UNIQUE(login_id, restaurant_id)
  );

  CREATE TABLE IF NOT EXISTS restaurants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    admin_id TEXT NOT NULL,
    gst_number TEXT,
    gst_percentage REAL DEFAULT 0,
    is_gst_enabled INTEGER DEFAULT 0,
    template_id TEXT DEFAULT 'CLASSIC',
    table_count INTEGER DEFAULT 0,
    watermark_image TEXT
  );

  CREATE TABLE IF NOT EXISTS notification_settings (
    restaurant_id TEXT,
    event_name TEXT,
    whatsapp_enabled INTEGER DEFAULT 0,
    sms_enabled INTEGER DEFAULT 0,
    email_enabled INTEGER DEFAULT 0,
    PRIMARY KEY (restaurant_id, event_name)
  );
`);

// Migrations for Central Database
try {
  centralDb.exec("ALTER TABLE users ADD COLUMN name TEXT;");
} catch (e) {}
try {
  centralDb.exec("ALTER TABLE users ADD COLUMN email TEXT;");
} catch (e) {}
try {
  centralDb.exec("ALTER TABLE users ADD COLUMN phone TEXT;");
} catch (e) {}
try {
  centralDb.exec("ALTER TABLE restaurants ADD COLUMN is_active INTEGER DEFAULT 0;");
} catch (e) {}
try {
  centralDb.exec("ALTER TABLE restaurants ADD COLUMN state TEXT;");
} catch (e) {}
try {
  centralDb.exec("ALTER TABLE restaurants ADD COLUMN city TEXT;");
} catch (e) {}
try {
  centralDb.exec("ALTER TABLE restaurants ADD COLUMN watermark_image TEXT;");
} catch (e) {}

try {
  centralDb.exec("ALTER TABLE restaurants ADD COLUMN upi_id TEXT;");
} catch (e) {}
try {
  centralDb.exec("ALTER TABLE restaurants ADD COLUMN upi_qr_image TEXT;");
} catch (e) {}
try {
  centralDb.exec("ALTER TABLE users ADD COLUMN default_hours REAL DEFAULT 8;");
} catch (e) {}

// Migration to fix unique constraint on login_id (make it unique per restaurant)
try {
  const indexList = centralDb.prepare("PRAGMA index_list(users)").all() as any[];
  // Check if there's a unique index that is NOT the composite one we want
  // In SQLite, an implicit unique constraint often doesn't show up as a named index we can easily distinguish without looking at columns
  // But we can check if a composite unique index exists
  const hasCompositeUnique = indexList.some(idx => {
    const info = centralDb.prepare(`PRAGMA index_info('${idx.name}')`).all() as any[];
    return info.length === 2 && info.some(c => c.name === 'login_id') && info.some(c => c.name === 'restaurant_id');
  });

  if (!hasCompositeUnique) {
    console.log("Migrating users table to composite unique constraint...");
    centralDb.transaction(() => {
      // 1. Create new table with correct constraints
      centralDb.exec(`
        CREATE TABLE users_new (
          id TEXT PRIMARY KEY,
          login_id TEXT NOT NULL,
          email TEXT,
          password TEXT NOT NULL,
          restaurant_id TEXT,
          role TEXT DEFAULT 'OWNER',
          name TEXT,
          phone TEXT,
          default_hours REAL DEFAULT 8,
          UNIQUE(login_id, restaurant_id)
        )
      `);
      // 2. Copy data (using INSERT OR IGNORE in case there are already duplicates that would violate the new constraint, 
      // though unlikely if the old one was more restrictive)
      centralDb.exec(`
        INSERT INTO users_new (id, login_id, email, password, restaurant_id, role, name, phone, default_hours)
        SELECT id, login_id, email, password, restaurant_id, role, name, phone, default_hours FROM users
      `);
      // 3. Swap tables
      centralDb.exec("DROP TABLE users");
      centralDb.exec("ALTER TABLE users_new RENAME TO users");
    })();
    console.log("Users table migration completed.");
  }
} catch (e) {
  console.error("Migration error (users unique constraint):", e);
}

// Ensure demo restaurant is active
try {
  centralDb.prepare("UPDATE restaurants SET is_active = 1 WHERE id = 'resto-1'").run();
} catch (e) {}

const dbCache = new Map<string, Database.Database>();

// Configure multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

function getTenantDb(restaurantId: string) {
  if (dbCache.has(restaurantId)) return dbCache.get(restaurantId)!;

  const dbPath = path.join(dbsDir, `${restaurantId}.db`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  
  // Initialize Tenant Schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      price_half REAL,
      price_full REAL,
      category TEXT,
      image TEXT,
      available INTEGER DEFAULT 1,
      is_daily_special INTEGER DEFAULT 0,
      dietary_type TEXT DEFAULT 'VEG'
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      table_number TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      customer_email TEXT,
      total_amount REAL NOT NULL,
      gst_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'PENDING',
      payment_status TEXT DEFAULT 'PENDING',
      payment_method TEXT,
      eta TEXT,
      feedback_requested INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      menu_item_id TEXT NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      quantity INTEGER NOT NULL,
      size TEXT DEFAULT 'FULL',
      FOREIGN KEY(order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS tables (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      hours REAL NOT NULL,
      status TEXT DEFAULT 'PENDING',
      type TEXT DEFAULT 'WORK',
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      customer_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(order_id) REFERENCES orders(id)
    );
  `);

  // Migrations for Tenant Database
  try {
    db.exec("ALTER TABLE orders ADD COLUMN feedback_requested INTEGER DEFAULT 0;");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE orders ADD COLUMN customer_email TEXT;");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE tables ADD COLUMN assigned_waiter_id TEXT;");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE menu_items ADD COLUMN price_half REAL;");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE menu_items ADD COLUMN price_full REAL;");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE menu_items ADD COLUMN dietary_type TEXT DEFAULT 'VEG';");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE order_items ADD COLUMN size TEXT DEFAULT 'FULL';");
  } catch (e) {}

  dbCache.set(restaurantId, db);
  return db;
}

// Seed initial data if empty
const rowCount = centralDb.prepare("SELECT count(*) as count FROM users WHERE role = 'SUPER_ADMIN'").get() as { count: number };
if (rowCount.count === 0) {
  // Seed SUPER ADMIN
  const superAdminId = "super-admin-1";
  const superAdminLogin = "SUPERADMIN";
  const superAdminPass = bcrypt.hashSync("admin123", 10);
  centralDb.prepare("INSERT INTO users (id, login_id, name, password, role) VALUES (?, ?, ?, ?, ?)").run(superAdminId, superAdminLogin, "ERP Super Admin", superAdminPass, "SUPER_ADMIN");

  const restaurantId = "resto-1";
  const userId = "user-1";
  const loginId = "OWNER-DEMO";
  const password = "password123";
  const hashedPassword = bcrypt.hashSync(password, 10);

  centralDb.prepare("INSERT INTO restaurants (id, name, admin_id, is_active) VALUES (?, ?, ?, 1)").run(restaurantId, "The Gourmet Kitchen", userId, 1);
  centralDb.prepare("INSERT INTO users (id, login_id, name, password, restaurant_id, role) VALUES (?, ?, ?, ?, ?, ?)").run(userId, loginId, "Restaurant Owner", hashedPassword, restaurantId, 'OWNER');
  
  // Seed a Chef user
  const chefId = "chef-1";
  const chefLoginId = "CHEF-DEMO";
  const chefPassword = "password123";
  const hashedChefPassword = bcrypt.hashSync(chefPassword, 10);
  centralDb.prepare("INSERT INTO users (id, login_id, name, password, restaurant_id, role) VALUES (?, ?, ?, ?, ?, ?)").run(chefId, chefLoginId, "Demo Chef", hashedChefPassword, restaurantId, 'CHEF');

  const tenantDb = getTenantDb(restaurantId);
  const items = [
    ["Burger", "Juicy beef patty with cheese", 12.99, "Mains"],
    ["Pasta", "Creamy alfredo with chicken", 14.50, "Mains"],
    ["Salad", "Fresh garden greens", 8.99, "Starters"],
    ["Fries", "Crispy golden potatoes", 4.50, "Sides"],
    ["Coke", "Refreshing soda", 2.50, "Drinks"]
  ];
  
  const insertItem = tenantDb.prepare("INSERT INTO menu_items (id, name, description, price, category) VALUES (?, ?, ?, ?, ?)");
  items.forEach(item => insertItem.run(Math.random().toString(36).substr(2, 9), ...item));
}

async function startServer() {
  console.log("Starting server...");
  const app = express();
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });
  const PORT = 3000;

  app.use(express.json());
  app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

  app.get("/api/health", (req, res) => {
    console.log("Health check requested");
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Meta WhatsApp Webhook Verification
  app.get("/api/webhooks/whatsapp", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token) {
      if (mode === "subscribe" && token === process.env.META_WA_VERIFY_TOKEN) {
        console.log("WEBHOOK_VERIFIED");
        res.status(200).send(challenge);
      } else {
        res.sendStatus(403);
      }
    }
  });

  app.post("/api/webhooks/whatsapp", (req, res) => {
    // Handle incoming messages if needed
    console.log("WhatsApp Webhook Received:", JSON.stringify(req.body, null, 2));
    res.sendStatus(200);
  });

  // Auth Middleware
  const authenticate = (req: any, res: any, next: any) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      req.user = decoded;
      next();
    } catch (err) {
      res.status(401).json({ error: "Invalid token" });
    }
  };

  // Auth Routes
  app.post("/api/auth/register", async (req, res) => {
    const { email, restaurantName, name, password, phone, state, city } = req.body;
    try {
      const loginId = "OWNER-" + Math.random().toString(36).substr(2, 4).toUpperCase();
      const hashedPassword = await bcrypt.hash(password || Math.random().toString(36).substr(2, 8), 10);
      const restaurantId = "resto-" + Math.random().toString(36).substr(2, 6);
      const userId = "user-" + Math.random().toString(36).substr(2, 6);

      centralDb.prepare("INSERT INTO restaurants (id, name, admin_id, state, city, is_active) VALUES (?, ?, ?, ?, ?, 0)").run(restaurantId, restaurantName, userId, state, city);
      centralDb.prepare("INSERT INTO users (id, login_id, name, email, phone, password, restaurant_id, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(userId, loginId, name, email, phone, hashedPassword, restaurantId, 'OWNER');

      getTenantDb(restaurantId);

      res.json({ 
        success: true, 
        loginId, 
        restaurantId 
      });
    } catch (err: any) {
      console.error("Registration error:", err);
      res.status(400).json({ error: "Failed to register restaurant" });
    }
  });

  app.get("/api/public/restaurants", (req, res) => {
    const restaurants = centralDb.prepare("SELECT id, name FROM restaurants WHERE is_active = 1").all();
    res.json(restaurants);
  });

  app.post("/api/auth/login", async (req, res) => {
    const { loginId, password, restaurantId, role } = req.body;
    
    let query = "SELECT * FROM users WHERE LOWER(login_id) = LOWER(?)";
    let params = [loginId];

    if (role && role !== 'SUPER_ADMIN') {
      query += " AND role = ? AND LOWER(restaurant_id) = LOWER(?)";
      params.push(role, restaurantId);
    } else if (role === 'SUPER_ADMIN') {
      query += " AND role = 'SUPER_ADMIN'";
    }

    const user = centralDb.prepare(query).get(...params) as any;
    
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Check if restaurant is active for non-super-admins
    if (user.role !== 'SUPER_ADMIN' && user.restaurant_id) {
      const restaurant = centralDb.prepare("SELECT is_active FROM restaurants WHERE id = ?").get(user.restaurant_id) as any;
      if (!restaurant || restaurant.is_active !== 1) {
        const statusMsg = restaurant?.is_active === 0 
          ? "Your business account is pending approval." 
          : "Your business account is currently inactive. Please contact support.";
        return res.status(403).json({ error: statusMsg });
      }
    }

    const token = jwt.sign({ userId: user.id, restaurantId: user.restaurant_id, role: user.role }, JWT_SECRET);
    res.json({ token, restaurantId: user.restaurant_id, userId: user.id, role: user.role, name: user.name });
  });

  app.get("/api/me", authenticate, (req: any, res) => {
    const user = centralDb.prepare("SELECT id, name, login_id, email, phone, role, restaurant_id, default_hours FROM users WHERE id = ?").get(req.user.userId) as any;
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  });

  // --- SUPER ADMIN ROUTES ---
  const isSuperAdmin = (req: any, res: any, next: any) => {
    if (req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ error: "Forbidden" });
    next();
  };

  app.get("/api/admin/restaurants", authenticate, isSuperAdmin, (req, res) => {
    const restaurants = centralDb.prepare(`
      SELECT r.*, u.login_id as owner_login_id, u.name as owner_name, u.email as owner_email, u.phone as owner_phone
      FROM restaurants r 
      JOIN users u ON r.id = u.restaurant_id 
      WHERE u.role = 'OWNER'
    `).all();
    res.json(restaurants);
  });

  app.post("/api/admin/restaurants/:id/toggle-status", authenticate, isSuperAdmin, (req, res) => {
    const { is_active } = req.body;
    centralDb.prepare("UPDATE restaurants SET is_active = ? WHERE id = ?").run(is_active, req.params.id);
    res.json({ success: true });
  });

  app.post("/api/admin/reset-owner-password", authenticate, isSuperAdmin, async (req: any, res) => {
    try {
      const { restaurantId, newPassword } = req.body;
      if (!restaurantId || !newPassword) {
        return res.status(400).json({ error: "Missing restaurantId or newPassword" });
      }
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      const result = centralDb.prepare("UPDATE users SET password = ? WHERE restaurant_id = ? AND role = 'OWNER'").run(hashedPassword, restaurantId);
      
      if (result.changes === 0) {
        return res.status(404).json({ error: "Owner not found for this restaurant" });
      }
      
      res.json({ success: true });
    } catch (err: any) {
      console.error("Reset password error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/admin/restaurants/:id", authenticate, isSuperAdmin, (req, res) => {
    centralDb.prepare("DELETE FROM restaurants WHERE id = ?").run(req.params.id);
    centralDb.prepare("DELETE FROM users WHERE restaurant_id = ?").run(req.params.id);
    res.json({ success: true });
  });

  // --- OWNER ROUTES ---
  const isOwner = (req: any, res: any, next: any) => {
    if (req.user.role !== 'OWNER') return res.status(403).json({ error: "Forbidden" });
    next();
  };

  app.get("/api/owner/staff", authenticate, isOwner, (req: any, res) => {
    const staff = centralDb.prepare("SELECT id, login_id, name, role, phone FROM users WHERE restaurant_id = ? AND role IN ('CHEF', 'WAITER')").all(req.user.restaurantId);
    res.json(staff);
  });

  app.get("/api/owner/notification-settings", authenticate, isOwner, (req: any, res) => {
    const settings = centralDb.prepare("SELECT * FROM notification_settings WHERE restaurant_id = ?").all(req.user.restaurantId);
    res.json(settings);
  });

  app.post("/api/owner/notification-settings", authenticate, isOwner, (req: any, res) => {
    const { event_name, whatsapp_enabled, sms_enabled, email_enabled } = req.body;
    centralDb.prepare(`
      INSERT INTO notification_settings (restaurant_id, event_name, whatsapp_enabled, sms_enabled, email_enabled)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(restaurant_id, event_name) DO UPDATE SET
        whatsapp_enabled = excluded.whatsapp_enabled,
        sms_enabled = excluded.sms_enabled,
        email_enabled = excluded.email_enabled
    `).run(req.user.restaurantId, event_name, whatsapp_enabled ? 1 : 0, sms_enabled ? 1 : 0, email_enabled ? 1 : 0);
    res.json({ success: true });
  });

  app.post("/api/owner/staff", authenticate, isOwner, async (req: any, res) => {
    const { loginId, name, password, role, phone, email } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const id = "staff-" + Math.random().toString(36).substr(2, 6);
    try {
      centralDb.prepare("INSERT INTO users (id, login_id, name, password, restaurant_id, role, phone, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, loginId, name, hashedPassword, req.user.restaurantId, role, phone, email);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: "Login ID already exists" });
    }
  });

  app.delete("/api/owner/staff/:id", authenticate, isOwner, (req: any, res) => {
    centralDb.prepare("DELETE FROM users WHERE id = ? AND restaurant_id = ? AND role IN ('CHEF', 'WAITER')").run(req.params.id, req.user.restaurantId);
    res.json({ success: true });
  });

  app.post("/api/owner/reset-staff-password", authenticate, isOwner, async (req: any, res) => {
    const { staffId, newPassword } = req.body;
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    centralDb.prepare("UPDATE users SET password = ? WHERE id = ? AND restaurant_id = ?").run(hashedPassword, staffId, req.user.restaurantId);
    res.json({ success: true });
  });

  app.patch("/api/owner/staff/:id/settings", authenticate, isOwner, (req: any, res) => {
    const { default_hours } = req.body;
    centralDb.prepare("UPDATE users SET default_hours = ? WHERE id = ? AND restaurant_id = ?").run(default_hours, req.params.id, req.user.restaurantId);
    res.json({ success: true });
  });

  // --- ATTENDANCE ROUTES ---
  app.post("/api/attendance", authenticate, (req: any, res) => {
    const { date, hours, type, note } = req.body;
    const db = getTenantDb(req.user.restaurantId);
    const id = Math.random().toString(36).substr(2, 9);
    
    const today = new Date().toISOString().slice(0, 10);
    if (date > today) {
      return res.status(400).json({ error: "Cannot log attendance for future dates" });
    }

    // Check if already exists for this date
    const existing = db.prepare("SELECT id FROM attendance WHERE user_id = ? AND date = ?").get(req.user.userId, date);
    if (existing) {
      db.prepare("UPDATE attendance SET hours = ?, type = ?, note = ?, status = 'PENDING' WHERE id = ?").run(hours, type, note, (existing as any).id);
      return res.json({ success: true, id: (existing as any).id });
    }

    db.prepare("INSERT INTO attendance (id, user_id, date, hours, type, note) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, req.user.userId, date, hours, type || 'WORK', note || '');
    res.json({ success: true, id });
  });

  app.get("/api/attendance", authenticate, (req: any, res) => {
    const { month, userId } = req.query;
    const db = getTenantDb(req.user.restaurantId);
    
    let query = "SELECT * FROM attendance WHERE 1=1";
    const params: any[] = [];

    if (req.user.role === 'OWNER') {
      if (userId) {
        query += " AND user_id = ?";
        params.push(userId);
      }
    } else {
      query += " AND user_id = ?";
      params.push(req.user.userId);
    }

    if (month) {
      query += " AND date LIKE ?";
      params.push(`${month}%`);
    }

    query += " ORDER BY date DESC";
    const logs = db.prepare(query).all(...params);
    res.json(logs);
  });

  app.patch("/api/attendance/:id", authenticate, isOwner, (req: any, res) => {
    const { status } = req.body;
    const db = getTenantDb(req.user.restaurantId);
    db.prepare("UPDATE attendance SET status = ? WHERE id = ?").run(status, req.params.id);
    res.json({ success: true });
  });

  app.get("/api/owner/attendance/stats", authenticate, isOwner, (req: any, res) => {
    const { month } = req.query;
    const db = getTenantDb(req.user.restaurantId);
    
    const stats = db.prepare(`
      SELECT user_id, SUM(hours) as total_hours, COUNT(*) as days_worked
      FROM attendance
      WHERE date LIKE ? AND status = 'APPROVED' AND type = 'WORK'
      GROUP BY user_id
    `).all(`${month}%`);

    // Join with user names from central DB
    const statsWithNames = stats.map((stat: any) => {
      const user = centralDb.prepare("SELECT name, default_hours FROM users WHERE id = ?").get(stat.user_id) as any;
      return {
        ...stat,
        name: user?.name || 'Unknown',
        default_hours: user?.default_hours || 8
      };
    });

    res.json(statsWithNames);
  });

  // WebSocket connection handling
  const clients = new Set<{ ws: WebSocket, role: string, restaurantId: string }>();

  wss.on("connection", (ws) => {
    let clientInfo: { ws: WebSocket, role: string, restaurantId: string } | null = null;

    ws.on("message", (message) => {
      const data = JSON.parse(message.toString());
      if (data.type === "AUTH") {
        clientInfo = { ws, role: data.role, restaurantId: data.restaurantId };
        clients.add(clientInfo);
      }
    });

    ws.on("close", () => {
      if (clientInfo) clients.delete(clientInfo);
    });
  });

  const broadcastToRole = (restaurantId: string, role: string, data: any) => {
    clients.forEach(client => {
      if (client.restaurantId === restaurantId && client.role === role && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(data));
      }
    });
  };

  // API Routes
  app.get("/api/restaurant/:id", (req, res) => {
    const id = req.params.id;
    if (!id || id === 'null' || id === 'undefined' || id === '[object Object]') {
      return res.status(400).json({ error: "Invalid restaurant ID" });
    }
    // Try finding by restaurant ID first
    let restaurant = centralDb.prepare("SELECT * FROM restaurants WHERE LOWER(id) = LOWER(?)").get(id) as any;
    
    // If not found, try finding by owner's login ID
    if (!restaurant) {
      const user = centralDb.prepare("SELECT restaurant_id FROM users WHERE LOWER(login_id) = LOWER(?) AND role = 'OWNER'").get(id) as any;
      if (user && user.restaurant_id) {
        restaurant = centralDb.prepare("SELECT * FROM restaurants WHERE id = ?").get(user.restaurant_id) as any;
      }
    }

    if (!restaurant) {
      return res.status(404).json({ error: "Restaurant not found" });
    }
    restaurant.is_gst_enabled = !!restaurant.is_gst_enabled;
    res.json(restaurant);
  });

  app.post("/api/restaurant/:id/watermark", authenticate, upload.single("watermark"), (req: any, res) => {
    if (req.user.restaurantId !== req.params.id) return res.status(403).json({ error: "Forbidden" });
    const watermark_image = req.file ? `/uploads/${req.file.filename}` : null;
    if (watermark_image) {
      centralDb.prepare("UPDATE restaurants SET watermark_image = ? WHERE id = ?").run(watermark_image, req.params.id);
    }
    res.json({ watermark_image });
  });

  app.patch("/api/restaurant/:id", authenticate, (req: any, res) => {
    if (req.user.restaurantId !== req.params.id) return res.status(403).json({ error: "Forbidden" });
    try {
      const { name, gst_number, gst_percentage, is_gst_enabled, template_id, table_count, upi_id } = req.body;
      if (name) centralDb.prepare("UPDATE restaurants SET name = ? WHERE id = ?").run(name, req.params.id);
      if (gst_number !== undefined) centralDb.prepare("UPDATE restaurants SET gst_number = ? WHERE id = ?").run(gst_number, req.params.id);
      if (gst_percentage !== undefined) centralDb.prepare("UPDATE restaurants SET gst_percentage = ? WHERE id = ?").run(gst_percentage, req.params.id);
      if (is_gst_enabled !== undefined) centralDb.prepare("UPDATE restaurants SET is_gst_enabled = ? WHERE id = ?").run(is_gst_enabled ? 1 : 0, req.params.id);
      if (template_id) centralDb.prepare("UPDATE restaurants SET template_id = ? WHERE id = ?").run(template_id, req.params.id);
      if (table_count !== undefined) centralDb.prepare("UPDATE restaurants SET table_count = ? WHERE id = ?").run(table_count, req.params.id);
      if (upi_id !== undefined) centralDb.prepare("UPDATE restaurants SET upi_id = ? WHERE id = ?").run(upi_id, req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to update settings" });
    }
  });

  app.post("/api/restaurant/:id/upi-qr", authenticate, upload.single("upi_qr"), (req: any, res) => {
    if (req.user.restaurantId !== req.params.id) return res.status(403).json({ error: "Forbidden" });
    const upi_qr_image = req.file ? `/uploads/${req.file.filename}` : null;
    if (upi_qr_image) {
      centralDb.prepare("UPDATE restaurants SET upi_qr_image = ? WHERE id = ?").run(upi_qr_image, req.params.id);
    }
    res.json({ upi_qr_image });
  });

  app.get("/api/restaurant/:id/menu", (req, res) => {
    const db = getTenantDb(req.params.id);
    const items = db.prepare("SELECT * FROM menu_items").all() as any[];
    const itemsWithId = items.map(item => ({ ...item, restaurantId: req.params.id, available: !!item.available, is_daily_special: !!item.is_daily_special }));
    res.json(itemsWithId);
  });

  app.get("/api/restaurant/:id/tables", authenticate, (req: any, res) => {
    if (req.user.restaurantId !== req.params.id) return res.status(403).json({ error: "Forbidden" });
    const db = getTenantDb(req.params.id);
    const tables = db.prepare("SELECT * FROM tables WHERE is_active = 1").all();
    res.json(tables);
  });

  app.get("/api/restaurant/:id/tables/public", (req, res) => {
    const db = getTenantDb(req.params.id);
    const tables = db.prepare("SELECT id, name FROM tables WHERE is_active = 1").all();
    res.json(tables);
  });

  app.patch("/api/restaurant/:id/tables/:tableId", authenticate, (req: any, res) => {
    if (req.user.restaurantId !== req.params.id) return res.status(403).json({ error: "Forbidden" });
    const { name } = req.body;
    const db = getTenantDb(req.params.id);
    db.prepare("UPDATE tables SET name = ? WHERE id = ?").run(name, req.params.tableId);
    res.json({ success: true });
  });

  app.post("/api/restaurant/:id/tables/sync", authenticate, (req: any, res) => {
    if (req.user.restaurantId !== req.params.id) return res.status(403).json({ error: "Forbidden" });
    const { count } = req.body;
    const db = getTenantDb(req.params.id);
    
    const existingTables = db.prepare("SELECT * FROM tables").all() as any[];
    
    if (existingTables.length < count) {
      // Add more tables
      for (let i = existingTables.length + 1; i <= count; i++) {
        db.prepare("INSERT INTO tables (id, name) VALUES (?, ?)").run(i.toString(), `Table ${i}`);
      }
    } else if (existingTables.length > count) {
      // Deactivate extra tables
      db.prepare("UPDATE tables SET is_active = 0 WHERE CAST(id AS INTEGER) > ?").run(count);
      db.prepare("UPDATE tables SET is_active = 1 WHERE CAST(id AS INTEGER) <= ?").run(count);
    } else {
      db.prepare("UPDATE tables SET is_active = 1").run();
    }
    
    res.json({ success: true });
  });

  app.post("/api/restaurant/:id/menu", authenticate, upload.single("image"), (req: any, res) => {
    if (req.user.restaurantId !== req.params.id) return res.status(403).json({ error: "Forbidden" });
    const { name, description, price, price_half, price_full, category, dietary_type, is_daily_special } = req.body;
    const image = req.file ? `/uploads/${req.file.filename}` : null;
    const id = Math.random().toString(36).substr(2, 9);
    const db = getTenantDb(req.params.id);
    
    // If this is a daily special, unset others
    if (is_daily_special === 'true' || is_daily_special === true) {
      db.prepare("UPDATE menu_items SET is_daily_special = 0").run();
    }

    db.prepare("INSERT INTO menu_items (id, name, description, price, price_half, price_full, category, image, dietary_type, is_daily_special) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, name, description, price || price_full, price_half || null, price_full || price, category, image, dietary_type || 'VEG', (is_daily_special === 'true' || is_daily_special === true) ? 1 : 0);
    res.json({ id, name, description, price, price_half, price_full, category, image, dietary_type, is_daily_special });
  });

  app.delete("/api/menu/:id", authenticate, (req: any, res) => {
    const db = getTenantDb(req.user.restaurantId);
    db.prepare("DELETE FROM menu_items WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  });

  app.patch("/api/menu/:id", authenticate, (req: any, res) => {
    const db = getTenantDb(req.user.restaurantId);
    const { name, price, price_half, price_full, available, is_daily_special, dietary_type } = req.body;
    if (name !== undefined) {
      db.prepare("UPDATE menu_items SET name = ? WHERE id = ?").run(name, req.params.id);
    }
    if (price !== undefined) {
      db.prepare("UPDATE menu_items SET price = ? WHERE id = ?").run(price, req.params.id);
    }
    if (price_half !== undefined) {
      db.prepare("UPDATE menu_items SET price_half = ? WHERE id = ?").run(price_half, req.params.id);
    }
    if (price_full !== undefined) {
      db.prepare("UPDATE menu_items SET price_full = ? WHERE id = ?").run(price_full, req.params.id);
    }
    if (dietary_type !== undefined) {
      db.prepare("UPDATE menu_items SET dietary_type = ? WHERE id = ?").run(dietary_type, req.params.id);
    }
    if (available !== undefined) {
      db.prepare("UPDATE menu_items SET available = ? WHERE id = ?").run(available ? 1 : 0, req.params.id);
    }
    if (is_daily_special !== undefined) {
      if (is_daily_special) {
        db.prepare("UPDATE menu_items SET is_daily_special = 0").run();
      }
      db.prepare("UPDATE menu_items SET is_daily_special = ? WHERE id = ?").run(is_daily_special ? 1 : 0, req.params.id);
    }
    res.json({ success: true });
  });

  app.post("/api/orders", (req, res) => {
    try {
      const { restaurantId, tableNumber, customerName, customerPhone, customerEmail, items, totalAmount, gstAmount, paymentMethod } = req.body;
      const orderId = "ORD-" + Math.random().toString(36).substr(2, 6).toUpperCase();
      
      const db = getTenantDb(restaurantId);
      const insertOrder = db.prepare("INSERT INTO orders (id, table_number, customer_name, customer_phone, customer_email, total_amount, gst_amount, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      insertOrder.run(orderId, tableNumber, customerName, customerPhone, customerEmail, totalAmount, gstAmount || 0, paymentMethod);

      const insertItem = db.prepare("INSERT INTO order_items (id, order_id, menu_item_id, name, price, quantity, size) VALUES (?, ?, ?, ?, ?, ?, ?)");
      items.forEach((item: any) => {
        insertItem.run(Math.random().toString(36).substr(2, 9), orderId, item.id, item.name, item.price, item.quantity, item.size || 'FULL');
      });

      // Notify Chef
      broadcastToRole(restaurantId, "CHEF", { type: "NEW_ORDER", orderId });
      
      // WhatsApp Notification for Owner and Chefs
      try {
        const staffToNotify = centralDb.prepare("SELECT phone, email FROM users WHERE restaurant_id = ? AND (role = 'OWNER' OR role = 'CHEF')").all(restaurantId) as any[];
        staffToNotify.forEach((staff: any) => {
          notify(restaurantId, 'ORDER_PLACED', { phone: staff.phone, email: staff.email }, {
            subject: `New Order Received - ${orderId}`,
            message: `🔔 *New Order Received!*\n\nOrder ID: ${orderId}\nTable: ${tableNumber}\nCustomer: ${customerName}\nTotal: ₹${totalAmount}\n\nPlease check the dashboard.`
          });
        });
      } catch (err) {
        console.error("Notification error:", err);
      }

      // Notify Customer
      try {
        notify(restaurantId, 'CUSTOMER_ORDER_CONFIRMATION', { phone: customerPhone, email: customerEmail }, {
          subject: `Order Confirmed - ${orderId}`,
          message: `✅ *Order Confirmed!*\n\nHi ${customerName},\n\nYour order ${orderId} has been successfully placed at Table ${tableNumber}.\nTotal Amount: ₹${totalAmount}\n\nThank you for dining with us!`
        });
      } catch (err) {
        console.error("Customer notification error:", err);
      }
      
      res.json({ orderId });
    } catch (error: any) {
      console.error("Server error creating order:", error);
      res.status(500).json({ error: error.message || "Failed to create order" });
    }
  });

  app.patch("/api/orders/:id/payment", authenticate, (req: any, res) => {
    const { status, restaurantId } = req.body;
    if (req.user.restaurantId !== restaurantId) return res.status(403).json({ error: "Forbidden" });
    
    try {
      const db = getTenantDb(restaurantId);
      db.prepare("UPDATE orders SET payment_status = ? WHERE id = ?").run(status, req.params.id);
      
      const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id) as any;
      
      // Notify Customer
      broadcastToRole(restaurantId, "CUSTOMER", { type: "PAYMENT_UPDATE", orderId: req.params.id, status });
      
      if (status === 'PAID' && order) {
        // Notify Customer with Invoice
        try {
          notify(restaurantId, 'CUSTOMER_INVOICE', { phone: order.customer_phone, email: order.customer_email }, {
            subject: `Invoice for Order ${order.id}`,
            message: `🧾 *Invoice - Order ${order.id}*\n\nHi ${order.customer_name},\n\nThank you for your payment! Your order has been settled.\n\nTotal: ₹${order.total_amount}\nGST: ₹${order.gst_amount}\nGrand Total: ₹${(order.total_amount + order.gst_amount).toFixed(2)}\n\nWe hope you enjoyed your meal!`
          });
        } catch (err) {
          console.error("Customer invoice notification error:", err);
        }

        // Notify Owner
        try {
          const owner = centralDb.prepare("SELECT phone, email FROM users WHERE restaurant_id = ? AND role = 'OWNER'").get(restaurantId) as any;
          if (owner) {
            notify(restaurantId, 'PAYMENT_RECEIVED', { phone: owner.phone, email: owner.email }, {
              subject: `Payment Received - Order ${req.params.id}`,
              message: `💰 *Payment Confirmed!*\n\nOrder ID: ${req.params.id}\nStatus: PAID\n\nThe customer payment has been verified.`
            });
          }
        } catch (err) {
          console.error("Owner notification error:", err);
        }
      }
      
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/orders/:id/request-feedback", authenticate, isOwner, (req: any, res) => {
    try {
      const db = getTenantDb(req.user.restaurantId);
      db.prepare("UPDATE orders SET feedback_requested = 1 WHERE id = ?").run(req.params.id);
      
      // Notify Customer via WebSocket
      broadcastToRole(req.user.restaurantId, "CUSTOMER", { 
        type: "FEEDBACK_REQUESTED", 
        orderId: req.params.id 
      });

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/orders/:id/feedback", (req, res) => {
    const { rating, comment, restaurantId, customerName } = req.body;
    const orderId = req.params.id;
    const id = Math.random().toString(36).substr(2, 9);
    
    try {
      const db = getTenantDb(restaurantId);
      db.prepare("INSERT INTO feedback (id, order_id, rating, comment, customer_name) VALUES (?, ?, ?, ?, ?)").run(id, orderId, rating, comment, customerName);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/owner/feedback", authenticate, isOwner, (req: any, res) => {
    try {
      const db = getTenantDb(req.user.restaurantId);
      const feedback = db.prepare("SELECT * FROM feedback ORDER BY created_at DESC").all();
      res.json(feedback);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/restaurant/:id/orders", authenticate, (req: any, res) => {
    if (req.user.restaurantId !== req.params.id) return res.status(403).json({ error: "Forbidden" });
    const db = getTenantDb(req.params.id);
    const orders = db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all();
    const ordersWithItems = orders.map((order: any) => {
      const items = db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(order.id);
      return { 
        ...order, 
        items, 
        restaurantId: req.params.id,
        tableNumber: order.table_number,
        customerName: order.customer_name,
        customerPhone: order.customer_phone,
        totalAmount: order.total_amount,
        gstAmount: order.gst_amount,
        paymentStatus: order.payment_status,
        paymentMethod: order.payment_method,
        feedbackRequested: !!order.feedback_requested,
        createdAt: order.created_at
      };
    });
    res.json(ordersWithItems);
  });

  app.patch("/api/orders/:id", authenticate, (req: any, res) => {
    const db = getTenantDb(req.user.restaurantId);
    const { status, eta, paymentStatus } = req.body;
    if (status) db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, req.params.id);
    if (eta) db.prepare("UPDATE orders SET eta = ? WHERE id = ?").run(eta, req.params.id);
    if (paymentStatus) db.prepare("UPDATE orders SET payment_status = ? WHERE id = ?").run(paymentStatus, req.params.id);
    
    // WhatsApp Notification for Waiters when order is READY
    if (status === 'READY') {
      try {
        const order = db.prepare("SELECT table_number FROM orders WHERE id = ?").get(req.params.id) as any;
        const waiters = centralDb.prepare("SELECT phone, email FROM users WHERE restaurant_id = ? AND role = 'WAITER'").all(req.user.restaurantId) as any[];
        waiters.forEach((waiter: any) => {
          notify(req.user.restaurantId, 'ORDER_READY', { phone: waiter.phone, email: waiter.email }, {
            subject: `Order Ready for Table ${order?.table_number || 'N/A'}`,
            message: `👨‍🍳 *Order Ready!*\n\nOrder ID: ${req.params.id}\nTable: ${order?.table_number || 'N/A'}\n\nPlease serve it to the customer.`
          });
        });
      } catch (err) {
        console.error("Notification error:", err);
      }
    }

    broadcastToRole(req.user.restaurantId, "CUSTOMER", { type: "ORDER_UPDATE", orderId: req.params.id, status, eta });
    res.json({ success: true });
  });

  app.get("/api/orders/:id", (req, res) => {
    // This is a bit tricky since we don't have the restaurantId in the URL
    // For now, we'll assume the client provides it or we search (inefficient)
    // Better: include restaurantId in the request or URL
    const restaurantId = req.query.restaurantId as string;
    if (!restaurantId) return res.status(400).json({ error: "Restaurant ID required" });
    
    const db = getTenantDb(restaurantId);
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id) as any;
    if (!order) return res.status(404).json({ error: "Order not found" });
    const items = db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(order.id);
    res.json({ 
      ...order, 
      items,
      feedbackRequested: !!order.feedback_requested,
      tableNumber: order.table_number,
      customerName: order.customer_name,
      customerPhone: order.customer_phone,
      totalAmount: order.total_amount,
      gstAmount: order.gst_amount,
      paymentStatus: order.payment_status,
      paymentMethod: order.payment_method,
      createdAt: order.created_at
    });
  });

  app.get("/api/restaurant/:id/reports", authenticate, (req: any, res) => {
    if (req.user.restaurantId !== req.params.id) return res.status(403).json({ error: "Forbidden" });
    const db = getTenantDb(req.params.id);
    const salesByCategory = db.prepare(`
      SELECT m.category, SUM(oi.price * oi.quantity) as total
      FROM order_items oi
      JOIN menu_items m ON oi.menu_item_id = m.id
      JOIN orders o ON oi.order_id = o.id
      GROUP BY m.category
    `).all();

    const dailySales = db.prepare(`
      SELECT date(created_at) as date, SUM(total_amount) as total
      FROM orders
      GROUP BY date(created_at)
      LIMIT 7
    `).all();

    const allOrders = db.prepare(`
      SELECT * FROM orders ORDER BY created_at DESC
    `).all();

    res.json({ salesByCategory, dailySales, allOrders });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    try {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
      console.log("Vite middleware initialized");
    } catch (err) {
      console.error("Failed to initialize Vite middleware:", err);
    }
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
