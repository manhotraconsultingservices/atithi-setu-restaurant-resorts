# Atithi-Setu - Project Specification

## Core Value Proposition
A comprehensive, multi-tenant restaurant management ecosystem focusing on frictionless customer ordering, real-time kitchen coordination, and deep owner analytics.


## Target Customers
* **Quick-Service Kiosks & Food Carts**
* **Casual Dining & Family Restaurants**
* **Specialty Coffee Shops & Cafés**
* **Food Courts & Multi-Vendor Hubs**
* **"Dark" Kitchens & Delivery-Only Outlets**


---

## Key Features

### Smart Menu Management
* **Dynamic Pricing:** Create and update your digital menu with half/full pricing options.
* **Dietary Markers:** Include markers for veg, non-veg, and vegan items.
* **Availability:** Real-time toggles for menu items and daily specials.
* **Media:** High-quality images with automated backups to Google Drive.

### QR Code Generating & Ordering
* **Table-Specific QR:** Unique QR codes generated per table.
* **App-less Experience:** Customers scan, browse, and order directly from their mobile browser.
* **Frictionless Flow:** Designed for the smoothest possible customer journey.
* **Postpaid Session Flow:** Customers place multiple rounds of orders within a single session; bill is consolidated and requested at end.

### Live Kitchen Display (KDS)
* **Real-Time Tickets:** Orders flow directly to kitchen screens.
* **Time Tracking:** Monitor elapsed time per order for efficiency.
* **One-Tap Updates:** Chefs mark items ready to instantly alert floor staff.

### Real-Time Table Monitor (Command Center)
* **Dark Glassmorphism UI:** Navy gradient background with semi-transparent cards and per-status colored glows (amber = occupied, rose = unavailable, emerald = available).
* **Live Stats Bar:** Five real-time metrics — Available, Occupied, N/A, Bill Requests, and Live Revenue.
* **Urgent Bill Alert Banner:** Auto-displays whenever any table has a pending `bill_requested` session.
* **Live Clock & LIVE Badge:** Per-second ticking clock with animated pulse indicator.
* **Waiter Assignment:** Assign/reassign waiters to tables directly from the monitor.
* **Status Toggles:** One-click status changes with glowing active-state buttons.
* **Elapsed Timers:** Per-table session duration counters that tick every second.
* **30-Second Auto-Refresh:** Table data polls every 30 seconds automatically.

### 360° Owner Analytics
* **Visual Trends:** Interactive charts for daily and weekly sales.
* **Performance Metrics:** Analysis of most popular items and peak hours.
* **Financial Breakdowns:** Detailed reporting on payment methods.

### GST-Ready Billing
* **Automated Tax:** Configurable GST rates and automated calculations.
* **Status Tracking:** Monitor "Pending" vs "Paid" status.
* **Multi-Payment Support:** Track Cash, Card, and UPI transactions.

### Table Reservations
* **Customer Portal:** Guests book tables in advance online.
* **Optimization:** Manage upcoming reservations to reduce walk-in wait times and optimize seating.

### Staff & Attendance
* **Directory:** Complete records for chefs, waiters, and administrative staff (including Manager role).
* **Time Logs:** Track daily attendance, working hours, and shift types in one location.

### Multi-Channel Notifications
* **Automated Alerts:** Triggers for Email, SMS, and WhatsApp.
* **Granular Config:** Set specific triggers for owners, staff, and customers.

### Multi-Tenant Security
* **Isolated Environments:** Each restaurant operates in a fully isolated digital environment.
* **Schema Isolation:** PostgreSQL schema-based isolation ensures total data privacy across the shared infrastructure.

---

## User Roles
| Role | Description |
|------|-------------|
| `OWNER` | Full access to all dashboards, settings, analytics, and staff management. |
| `MANAGER` | Same dashboard access as OWNER (purple theme in staff directory). |
| `CHEF` | Kitchen Display System — views and updates order status. |
| `WAITER` | Sees live table assignments and their own tables via JWT-decoded ID. |
| `CUSTOMER` | App-less QR-scan ordering interface. Triggered by `?r=` URL param. |
| `SUPER_ADMIN` | Platform-level admin across all restaurants. |
| `SALES_REP` | Sales representative dashboard. |
| `CTO` | Technical overview dashboard. |

---

## Postpaid Session Flow (Table Ordering)
1. Customer scans table QR → `?r={restaurantId}&table={tableId}` URL loads.
2. `initSession()` POSTs to `/api/restaurant/:id/sessions` — creates or resumes an open session.
3. Customer browses menu, adds items to cart, fills name/phone on first order.
4. "Add to Bill" places the order and links it to the active session.
5. Customer can place multiple rounds of orders within the same session.
6. "Request Bill" button appears when `session.status === 'open'` and at least one order exists.
7. Customer selects payment method → `POST /sessions/:token/request-bill` → session status → `bill_requested`.
8. Full itemized invoice shown to customer. Staff notified to collect payment.
9. Owner/Manager marks session closed after payment.

**Key bug fixed (2026-03-15):** The Request Bill modal (`showBillRequestModal`) was mistakenly placed inside the menu branch of the `activeCustomerTab` ternary. Since the button lives in the `MY_ORDERS` branch, the modal never mounted when needed. Fix: moved the `<AnimatePresence>` block for the modal outside the ternary to the top-level of the outer container.

---

## Technical Stack
* **Frontend:** React 19 + Vite + Tailwind CSS + Framer Motion
* **Backend:** Node.js (Express) + TypeScript
* **Database:** PostgreSQL (multi-tenant via `tenant_{restaurantId}` schemas)
* **Real-Time:** WebSocket (`useSocket` hook) for live order/payment updates
* **Deployment:** Docker Compose (postgres_db + node_app containers)
* **QR Codes:** `qrcode.react` (QRCodeSVG / QRCodeCanvas)
* **Charts:** Recharts (BarChart, PieChart, ComposedChart)
* **Icons:** Lucide React

---

## Project Structure
```
src/
  App.tsx          — Entire frontend (single-file SPA): all components, hooks, state
  types.ts         — Shared TypeScript types (MenuItem, Order, TableSession, etc.)
  lib/
    socket.ts      — useSocket hook for WebSocket real-time updates
    utils.ts       — cn() utility (clsx + tailwind-merge)
server.ts          — Express API server (all endpoints)
docker-compose.yml — Container orchestration
Dockerfile         — Multi-stage build (Vite build → Node serve)
```

## Key Architecture Notes

### Rendering / Role Switching
- `role` state is initialized from `localStorage.getItem('role')` on mount.
- When URL contains `?r={restaurantId}`, a `useEffect` overrides role to `'CUSTOMER'` — this enables QR scan flow without requiring login.
- Role-based rendering in `App` component:
  ```tsx
  {(role === 'OWNER' || role === 'MANAGER') && <OwnerDashboard ... />}
  {role === 'CUSTOMER' && <CustomerInterface restaurantId={restaurantId!} />}
  ```

### Session Token Storage
- Session tokens are stored in localStorage under key `session_{restaurantId}_{tableId}`.
- On re-scan, the stored token is sent to the server to resume the existing session.

### Table Monitor Polling
- `fetchLiveTables()` is called every 30 seconds when the MONITOR tab is active.
- A separate `setInterval` ticks `liveNow` every second to drive elapsed-time counters.
- Both intervals are cleared in the `useEffect` cleanup to prevent memory leaks.

### JWT Decoding (Waiter Dashboard)
- Waiter's own ID is extracted client-side: `JSON.parse(atob(token.split('.')[1])).id`
- Used to filter "My Tables" from the live table list without an extra API call.
