# RestoFlow ERP - User Manual & Feature Guide

## 1. Introduction
RestoFlow ERP is a comprehensive, multi-tenant restaurant management system designed to streamline operations from order placement to final payment. This manual provides a detailed guide for all user roles: Super Admin, Restaurant Owner, Chef, Waiter, and Customer.

---

## 2. User Roles & Access

### 2.1. Super Admin
The Super Admin is the platform owner who manages the entire SaaS ecosystem.
*   **Approval Workflow**: Review and approve new restaurant registrations.
*   **Business Management**: Activate or deactivate business partners.
*   **Security**: Reset owner passwords if requested.

### 2.2. Restaurant Owner (Dashboard)
The central hub for managing a single restaurant's operations.
*   **Menu Management**: Add/edit/delete menu items, upload images, set dietary types (Veg/Non-Veg/Egg), and manage "Daily Specials."
*   **Staff Management**: Create login credentials for Chefs and Waiters.
*   **Analytics & Reports**: Real-time sales data, daily revenue charts, and detailed order history.
*   **QR Management**: Generate and download unique QR codes for every table in the restaurant.
*   **Payment Management**: Track all orders and verify UPI payments.
*   **Attendance Approval**: Review and approve staff attendance logs and monthly timesheets.
*   **Brand Settings**: Customize the restaurant's name, GST details, UPI ID for payments, and digital menu templates.

### 2.3. Chef (Kitchen Queue)
A real-time interface for the kitchen staff to manage incoming orders.
*   **Live Kitchen Queue**: Instant notification of new orders with sound alerts.
*   **Order Tracking**: Update order status from "Pending" to "Preparing" (with ETA) and then to "Ready."
*   **Attendance**: Log daily work hours and view personal monthly timesheets.

### 2.4. Waiter (Service Dashboard)
Designed for mobile use by floor staff.
*   **Ready for Pickup**: Instant alerts when the Chef marks an order as "Ready."
*   **Delivery Tracking**: Mark orders as "Delivered" once served to the table.
*   **Payment Status**: View whether an order is "Paid" or "Unpaid" before serving.
*   **Attendance**: Log daily work hours.

### 2.5. Customer (Digital Menu & Ordering)
A frictionless, QR-based interface for diners.
*   **Digital Menu**: Browse categories, filter by dietary preferences, and search for items.
*   **Self-Ordering**: Add items to the cart and place orders directly from the table.
*   **UPI Payments**: Pay via Dynamic QR (pre-filled amount) or Basic QR.
*   **Real-Time Status**: Track order preparation status and payment verification in real-time.

---

## 3. Key Features & Workflows

### 3.1. The Ordering Workflow
1.  **Customer** scans the Table QR code.
2.  **Customer** selects items and places the order.
3.  **Chef** receives a "New Order" alert and starts preparation.
4.  **Chef** marks the order as "Ready."
5.  **Waiter** receives a "Ready for Pickup" alert and serves the food.
6.  **Waiter** marks the order as "Delivered."

### 3.2. Payment Verification (UPI)
1.  **Customer** pays via the UPI QR code on their phone.
2.  **Customer** clicks "I have paid" to notify the restaurant.
3.  **Owner** sees the "Pending" payment in the **Payments** tab.
4.  **Owner** verifies the bank credit and marks the order as **"Paid."**
5.  **Customer** and **Staff** dashboards update instantly to show "Payment Successful."

### 3.3. Attendance & Timesheets
*   **Daily Logging**: Staff can log their hours for any past day (future dates are blocked).
*   **Bulk Submission**: Staff can select multiple dates from their monthly timesheet and submit them at once.
*   **Approval**: Owners must approve these logs for them to be finalized in the system.

---

## 4. Technical Reliability
*   **Real-Time Sync**: The application uses WebSockets for instant updates across all dashboards.
*   **Auto-Refresh**: Critical pages (Kitchen Queue, Payments) auto-refresh every 60 seconds as a fallback.
*   **Database Resilience**: Uses Write-Ahead Logging (WAL) to ensure the system remains fast and responsive even during peak hours.

---

## 5. Support & Configuration
For any issues, please contact the Super Admin or refer to the **Brand & Settings** tab in your Owner Dashboard to ensure your UPI ID and GST details are correctly configured.
