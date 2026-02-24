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

const centralDb = new Database("central.db");
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-key";

// Ensure directories exist
const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const dbsDir = path.join(process.cwd(), "dbs");
if (!fs.existsSync(dbsDir)) fs.mkdirSync(dbsDir);

// Initialize Central Database
centralDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    login_id TEXT UNIQUE NOT NULL,
    email TEXT,
    password TEXT NOT NULL,
    restaurant_id TEXT,
    role TEXT DEFAULT 'OWNER'
  );

  CREATE TABLE IF NOT EXISTS restaurants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    admin_id TEXT NOT NULL,
    gst_number TEXT,
    gst_percentage REAL DEFAULT 0,
    is_gst_enabled INTEGER DEFAULT 0,
    template_id TEXT DEFAULT 'CLASSIC',
    table_count INTEGER DEFAULT 0
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
  
  // Initialize Tenant Schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      category TEXT,
      image TEXT,
      available INTEGER DEFAULT 1,
      is_daily_special INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      table_number TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      total_amount REAL NOT NULL,
      gst_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'PENDING',
      payment_status TEXT DEFAULT 'PENDING',
      payment_method TEXT,
      eta TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      menu_item_id TEXT NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      quantity INTEGER NOT NULL,
      FOREIGN KEY(order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS tables (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_active INTEGER DEFAULT 1
    );
  `);

  // Migrations for Tenant Database
  try {
    db.exec("ALTER TABLE tables ADD COLUMN assigned_waiter_id TEXT;");
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

  centralDb.prepare("INSERT INTO restaurants (id, name, admin_id) VALUES (?, ?, ?)").run(restaurantId, "The Gourmet Kitchen", userId);
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
  const app = express();
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });
  const PORT = 3000;

  app.use(express.json());
  app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

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
    
    let query = "SELECT * FROM users WHERE login_id = ?";
    let params = [loginId];

    if (role && role !== 'SUPER_ADMIN') {
      query += " AND role = ? AND restaurant_id = ?";
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
    const staff = centralDb.prepare("SELECT id, login_id, name, role FROM users WHERE restaurant_id = ? AND role IN ('CHEF', 'WAITER')").all(req.user.restaurantId);
    res.json(staff);
  });

  app.post("/api/owner/staff", authenticate, isOwner, async (req: any, res) => {
    const { loginId, name, password, role } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const id = "staff-" + Math.random().toString(36).substr(2, 6);
    try {
      centralDb.prepare("INSERT INTO users (id, login_id, name, password, restaurant_id, role) VALUES (?, ?, ?, ?, ?, ?)").run(id, loginId, name, hashedPassword, req.user.restaurantId, role);
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
    const restaurant = centralDb.prepare("SELECT * FROM restaurants WHERE id = ?").get(req.params.id) as any;
    if (!restaurant) {
      return res.status(404).json({ error: "Restaurant not found" });
    }
    restaurant.is_gst_enabled = !!restaurant.is_gst_enabled;
    res.json(restaurant);
  });

  app.patch("/api/restaurant/:id", authenticate, (req: any, res) => {
    if (req.user.restaurantId !== req.params.id) return res.status(403).json({ error: "Forbidden" });
    try {
      const { name, gst_number, gst_percentage, is_gst_enabled, template_id, table_count } = req.body;
      if (name) centralDb.prepare("UPDATE restaurants SET name = ? WHERE id = ?").run(name, req.params.id);
      if (gst_number !== undefined) centralDb.prepare("UPDATE restaurants SET gst_number = ? WHERE id = ?").run(gst_number, req.params.id);
      if (gst_percentage !== undefined) centralDb.prepare("UPDATE restaurants SET gst_percentage = ? WHERE id = ?").run(gst_percentage, req.params.id);
      if (is_gst_enabled !== undefined) centralDb.prepare("UPDATE restaurants SET is_gst_enabled = ? WHERE id = ?").run(is_gst_enabled ? 1 : 0, req.params.id);
      if (template_id) centralDb.prepare("UPDATE restaurants SET template_id = ? WHERE id = ?").run(template_id, req.params.id);
      if (table_count !== undefined) centralDb.prepare("UPDATE restaurants SET table_count = ? WHERE id = ?").run(table_count, req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to update settings" });
    }
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
    const { name, description, price, category } = req.body;
    const image = req.file ? `/uploads/${req.file.filename}` : null;
    const id = Math.random().toString(36).substr(2, 9);
    const db = getTenantDb(req.params.id);
    db.prepare("INSERT INTO menu_items (id, name, description, price, category, image) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, name, description, price, category, image);
    res.json({ id, name, description, price, category, image });
  });

  app.delete("/api/menu/:id", authenticate, (req: any, res) => {
    const db = getTenantDb(req.user.restaurantId);
    db.prepare("DELETE FROM menu_items WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  });

  app.patch("/api/menu/:id", authenticate, (req: any, res) => {
    const db = getTenantDb(req.user.restaurantId);
    const { price, available, is_daily_special } = req.body;
    if (price !== undefined) {
      db.prepare("UPDATE menu_items SET price = ? WHERE id = ?").run(price, req.params.id);
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
      const { restaurantId, tableNumber, customerName, customerPhone, items, totalAmount, gstAmount, paymentMethod } = req.body;
      const orderId = "ORD-" + Math.random().toString(36).substr(2, 6).toUpperCase();
      
      const db = getTenantDb(restaurantId);
      const insertOrder = db.prepare("INSERT INTO orders (id, table_number, customer_name, customer_phone, total_amount, gst_amount, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?)");
      insertOrder.run(orderId, tableNumber, customerName, customerPhone, totalAmount, gstAmount || 0, paymentMethod);

      const insertItem = db.prepare("INSERT INTO order_items (id, order_id, menu_item_id, name, price, quantity) VALUES (?, ?, ?, ?, ?, ?)");
      items.forEach((item: any) => {
        insertItem.run(Math.random().toString(36).substr(2, 9), orderId, item.id, item.name, item.price, item.quantity);
      });

      // Notify Chef
      broadcastToRole(restaurantId, "CHEF", { type: "NEW_ORDER", orderId });
      
      res.json({ orderId });
    } catch (error: any) {
      console.error("Server error creating order:", error);
      res.status(500).json({ error: error.message || "Failed to create order" });
    }
  });

  app.get("/api/restaurant/:id/orders", authenticate, (req: any, res) => {
    if (req.user.restaurantId !== req.params.id) return res.status(403).json({ error: "Forbidden" });
    const db = getTenantDb(req.params.id);
    const orders = db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all();
    const ordersWithItems = orders.map((order: any) => {
      const items = db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(order.id);
      return { ...order, items, restaurantId: req.params.id };
    });
    res.json(ordersWithItems);
  });

  app.patch("/api/orders/:id", authenticate, (req: any, res) => {
    const db = getTenantDb(req.user.restaurantId);
    const { status, eta, paymentStatus } = req.body;
    if (status) db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, req.params.id);
    if (eta) db.prepare("UPDATE orders SET eta = ? WHERE id = ?").run(eta, req.params.id);
    if (paymentStatus) db.prepare("UPDATE orders SET payment_status = ? WHERE id = ?").run(paymentStatus, req.params.id);
    
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
    res.json({ ...order, items });
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
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
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

startServer();
