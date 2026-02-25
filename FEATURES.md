# RestoFlow ERP - Features Documentation

RestoFlow ERP is a comprehensive, multi-tenant restaurant management system designed to streamline operations from customer ordering to kitchen management and business analytics.

## 1. Core Architecture
- **Multi-Tenant System**: Isolated SQLite databases for each restaurant ensure data privacy and security.
- **Real-Time Updates**: WebSocket integration provides live updates for orders across all staff interfaces.
- **Responsive Design**: Mobile-first approach for customer ordering and tablet-optimized dashboards for staff.

## 2. User Roles & Access Control
- **Super Admin**: 
  - System-wide dashboard.
  - Manage restaurant registrations.
  - Toggle restaurant active/inactive status.
  - Reset owner passwords.
- **Restaurant Owner**:
  - Full control over restaurant settings (GST, Name, Templates).
  - Menu management (Categories, Dietary types, Pricing).
  - Staff management (Add/Remove Chefs and Waiters).
  - Table management and QR code generation.
  - Sales reports and analytics.
- **Chef**:
  - Live kitchen queue.
  - Update order status (Preparing, Ready).
  - Set estimated preparation times (ETA).
- **Waiter**:
  - View active orders and table assignments.
  - Mark orders as delivered.
- **Customer**:
  - QR-code based menu access.
  - Self-service ordering.
  - Real-time order status tracking.

## 3. Menu Management
- **Categorization**: Organize items into Starters, Mains, Sides, Drinks, and Desserts.
- **Dietary Indicators**: Clear icons for **Veg** (Green dot), **Vegan** (Green leaf), and **Non-Veg** (Red dot).
- **Flexible Pricing**: Support for **Half** and **Full** portion sizes with independent pricing.
- **Daily Specials**: Highlight featured dishes at the top of the menu.
- **Visual Appeal**: Image upload support for every menu item.
- **Search & Filter**: Customers can easily find dishes by name or dietary preference.

## 4. Ordering & Kitchen Workflow
- **QR Ordering**: Each table has a unique QR code that automatically identifies the table number.
- **Live Queue**: Orders appear instantly on the Chef's dashboard.
- **Status Tracking**: 
  - `PENDING`: New order received.
  - `PREPARING`: Chef has started working on the order.
  - `READY`: Food is ready for pickup.
  - `DELIVERED`: Waiter has served the food.
- **Digital Invoices**: Automatic generation of invoices with GST calculation and printable format.

## 5. Restaurant Customization
- **Menu Templates**: Choose from three professional designs:
  - **Classic**: Traditional grid layout with images.
  - **Modern**: Large, bold cards with focus on imagery.
  - **Editorial**: Elegant, typography-focused layout reminiscent of high-end magazines.
- **Watermarking**: Upload a custom logo to appear as a subtle watermark on the digital menu.
- **GST Compliance**: Toggle GST on/off, set custom percentages, and include GSTIN on invoices.

## 6. Analytics & Insights
- **Sales by Category**: Visual breakdown of which food categories are performing best.
- **Daily Sales Trends**: Track revenue over the past week.
- **Order History**: Comprehensive log of all past transactions for auditing.

## 7. Table Management
- **Dynamic Scaling**: Add or remove tables as the restaurant grows.
- **QR Generation**: Generate and download high-quality QR codes for physical tables.
- **Waiter Assignment**: (In progress) Assign specific waiters to tables for better service management.
