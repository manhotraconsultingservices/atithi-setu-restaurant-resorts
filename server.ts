import express, { Request, Response, NextFunction } from "express";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure required directories exist for deployment
const dbsDir = path.join(process.cwd(), "dbs");
if (!fs.existsSync(dbsDir)) {
  fs.mkdirSync(dbsDir, { recursive: true });
}

const centralDb = new Database(path.join(__dirname, "central.db"));
centralDb.pragma('journal_mode = WAL');

// Initialize central schema
centralDb.exec(`
  CREATE TABLE IF NOT EXISTS restaurants (
    id TEXT PRIMARY KEY,
    name TEXT,
    admin_id TEXT,
    state TEXT,
    city TEXT,
    is_active INTEGER DEFAULT 0,
    sales_rep_id TEXT,
    registered_at DATETIME,
    subscription_expires_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    login_id TEXT UNIQUE,
    name TEXT,
    email TEXT UNIQUE,
    phone TEXT,
    password TEXT,
    restaurant_id TEXT,
    role TEXT
  );
`);

const JWT_SECRET = process.env.JWT_SECRET || "fallback-secret-atithi-setu-2024";

// Extended Request Interface for TypeScript
interface AuthRequest extends Request {
  user?: any;
}

const dbCache = new Map<string, Database.Database>();
const MAX_TENANTS_IN_MEMORY = 100;

function getTenantDb(restaurantId: string) {
  if (dbCache.has(restaurantId)) return dbCache.get(restaurantId)!;

  if (dbCache.size >= MAX_TENANTS_IN_MEMORY) {
    const oldestKey = dbCache.keys().next().value;
    dbCache.get(oldestKey)?.close();
    dbCache.delete(oldestKey);
  }

  const dbPath = path.join(dbsDir, `${restaurantId}.db`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  
  // Initialize tenant schema if new
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      table_number TEXT,
      items TEXT,
      total_amount REAL,
      status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  dbCache.set(restaurantId, db);
  return db;
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // Login Logic
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const { loginId, password, restaurantId, role } = req.body;
    try {
      const user = centralDb.prepare("SELECT * FROM users WHERE login_id = ?").get(loginId) as any;
      if (!user) return res.status(401).json({ error: "Invalid credentials" });

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
  app.get("/api/restaurant/:id", (req: Request, res: Response) => {
    try {
      const restaurant = centralDb.prepare("SELECT * FROM restaurants WHERE id = ?").get(req.params.id) as any;
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
      const loginId = "OWNER-" + randomUUID().split('-')[0].toUpperCase();
      const hashedPassword = await bcrypt.hash(password, 12);
      const restaurantId = "resto-" + randomUUID();
      const userId = "user-" + randomUUID();

      const now = new Date().toISOString();
      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 1);

      centralDb.prepare(`
        INSERT INTO restaurants (id, name, admin_id, state, city, is_active, sales_rep_id, registered_at, subscription_expires_at) 
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(restaurantId, restaurantName, userId, state, city, sales_rep_id || null, now, expiresAt.toISOString());

      centralDb.prepare(`
        INSERT INTO users (id, login_id, name, email, phone, password, restaurant_id, role) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(userId, loginId, name, email, phone, hashedPassword, restaurantId, 'OWNER');

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
