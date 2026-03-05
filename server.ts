import express, { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { centralDb, getTenantDb, initDb, getNextSequence } from "./db.ts";
import { sendEmail, sendSMS, sendWhatsApp } from "./notificationService.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure required directories exist for deployment
const dbsDir = path.join(process.cwd(), "dbs");
if (!fs.existsSync(dbsDir)) {
  fs.mkdirSync(dbsDir, { recursive: true });
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

      const message = `Notification: ${eventName}\nData: ${JSON.stringify(data, null, 2)}`;

      for (const recipient of recipients) {
        if (setting.email_enabled && recipient.includes('@')) {
          await sendEmail(recipient, `RestoFlow: ${eventName}`, message);
        }
        if (setting.sms_enabled && !recipient.includes('@')) {
          await sendSMS(recipient, message);
        }
        if (setting.whatsapp_enabled && !recipient.includes('@')) {
          await sendWhatsApp(recipient, message);
        }
      }
    }
  } catch (err) {
    console.error(`Failed to trigger notification for ${eventName}:`, err);
  }
}

async function startServer() {
  await initDb();

  // Create default super admin if none exists
  const adminExists = await centralDb.get("SELECT * FROM users WHERE role = 'SUPER_ADMIN'");
  if (!adminExists) {
    const hashedPassword = await bcrypt.hash("admin123", 12);
    await centralDb.run(`
      INSERT INTO users (id, login_id, name, email, phone, password, restaurant_id, role, is_active) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [randomUUID(), "ADMIN-ANKUSH", "Ankush Admin", "ankushmanhotra@gmail.com", "0000000000", hashedPassword, "SYSTEM", "SUPER_ADMIN", 1]);
    console.log("Default SUPER_ADMIN created: ADMIN-ANKUSH / admin123");
  }

  const app = express();
  app.use(express.json());

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
      let query = "SELECT * FROM restaurants";
      let params: any[] = [];
      if (req.user?.role === 'SALES_REP') {
        query += " WHERE sales_rep_id = ?";
        params.push(req.user.id);
      }
      const restaurants = await centralDb.query(query, params);
      res.json(restaurants);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch restaurants" });
    }
  });

  // Admin: Assign Sales Rep
  app.patch("/api/admin/restaurants/:id/sales-rep", authenticate, isAdmin, async (req: AuthRequest, res: Response) => {
    const { salesRepId } = req.body;
    try {
      await centralDb.run("UPDATE restaurants SET sales_rep_id = ? WHERE id = ?", [salesRepId, req.params.id]);
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

      await centralDb.run("UPDATE restaurants SET is_active = ? WHERE id = ?", [is_active, req.params.id]);
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

  // Public: Get Sales Reps
  app.get("/api/public/sales-reps", async (req: Request, res: Response) => {
    try {
      const reps = await centralDb.query("SELECT id, name FROM users WHERE role = 'SALES_REP' AND is_active = 1");
      res.json(reps);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch sales reps" });
    }
  });

  // Auth: Get Me
  app.get("/api/me", authenticate, async (req: AuthRequest, res: Response) => {
    try {
      const user = await centralDb.get("SELECT id, login_id, name, email, phone, role, restaurant_id FROM users WHERE id = ?", [req.user?.id]);
      if (!user) return res.status(404).json({ error: "User not found" });
      res.json(user);
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
          INSERT INTO notification_settings (event_name, role, email_enabled, sms_enabled, whatsapp_enabled, recipients)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(event_name, role) DO UPDATE SET
            email_enabled = excluded.email_enabled,
            sms_enabled = excluded.sms_enabled,
            whatsapp_enabled = excluded.whatsapp_enabled,
            recipients = excluded.recipients
        `, [s.event_name, s.role, s.email_enabled ? 1 : 0, s.sms_enabled ? 1 : 0, s.whatsapp_enabled ? 1 : 0, s.recipients || '']);
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

  // Login Logic
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const { loginId, password, restaurantId, role } = req.body;
    try {
      const user = await centralDb.get("SELECT * FROM users WHERE login_id = ?", [loginId]);
      if (!user) return res.status(401).json({ error: "Invalid credentials" });
      if (user.is_active === 0) return res.status(403).json({ error: "Account is deactivated" });

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });

      const token = jwt.sign({ id: user.id, restaurantId: user.restaurant_id, role: user.role }, JWT_SECRET, { expiresIn: "24h" });
      res.json({ 
        token, 
        restaurantId: user.restaurant_id, 
        role: user.role, 
        name: user.name 
      });
    } catch (err) {
      console.error("Login error:", err);
      res.status(500).json({ error: "Login failed" });
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

  // Fixed Registration Logic
  app.post("/api/auth/register", async (req: Request, res: Response) => {
    const { email, restaurantName, name, password, phone, state, city, sales_rep_id } = req.body;
    
    try {
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

      res.json({ success: true, loginId, restaurantId });
    } catch (err) {
      console.error("Registration error:", err);
      res.status(500).json({ error: "Registration failed. Email or Login ID might already exist." });
    }
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

  const PORT = 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);
