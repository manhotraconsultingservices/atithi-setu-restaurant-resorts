# ATITHI SETU
## Multi-Tenant Restaurant Management System
### COMPREHENSIVE USER MANUAL
**Version 1.0 | March 2026**

---

A frictionless customer ordering system with real-time kitchen coordination, advanced analytics, and multi-channel notifications.

---

## Table of Contents

1. [Introduction & System Overview](#1-introduction--system-overview)
2. [Getting Started](#2-getting-started)
3. [User Roles & Permissions](#3-user-roles--permissions)
4. [Digital Menu Management](#4-digital-menu-management)
5. [QR Code & Customer Ordering](#5-qr-code--customer-ordering)
6. [Kitchen Display System (KDS)](#6-kitchen-display-system-kds)
7. [Table Reservations](#7-table-reservations)
8. [Staff Management & Attendance](#8-staff-management--attendance)
9. [Invoicing & Billing (with GST)](#9-invoicing--billing-with-gst)
10. [Reporting & Analytics](#10-reporting--analytics)
11. [Multi-Channel Notifications](#11-multi-channel-notifications)
12. [Troubleshooting & FAQ](#12-troubleshooting--faq)
13. [Appendix & Configuration](#13-appendix--configuration)

---

## 1. Introduction & System Overview

Atithi Setu (meaning 'Guest Bridge' in Sanskrit) is a comprehensive, cloud-based restaurant management platform designed for quick-service kiosks, casual dining establishments, specialty coffee shops, food courts, and dark kitchens. It seamlessly integrates customer ordering, kitchen operations, table management, staff coordination, and advanced analytics into one intuitive system.

### 1.1 Key Features at a Glance

- **Digital Menu Management:** Create and update digital menus with half/full pricing options
- **QR Code Ordering:** App-less customer experience - scan and order directly
- **Live Kitchen Display System (KDS):** Real-time order tracking for chefs
- **Table Reservations:** Customer portal for advance table bookings
- **GST-Ready Invoicing & Billing:** Automated tax calculation and multi-payment support
- **360° Owner Analytics:** Visual trends, sales metrics, and performance insights
- **Staff Directory:** Complete attendance tracking and shift management
- **Multi-Channel Notifications:** Email, SMS, WhatsApp alerts for customers and staff
- **Multi-Tenant Architecture:** Complete data isolation between restaurants

### 1.2 System Architecture

Atithi Setu operates on a multi-tenant model, ensuring complete data isolation between restaurants. Each restaurant operates in a fully isolated digital environment with PostgreSQL schema-based isolation, guaranteeing data privacy and security across the shared infrastructure.

---

## 2. Getting Started

### 2.1 Accessing Atithi Setu

Atithi Setu is accessed through a web browser. No app installation is required (except for the Kitchen Display System, which may run on a dedicated tablet or kiosk).

**Steps to Access:**
1. Open your web browser (Chrome, Firefox, Safari, or Edge recommended)
2. Navigate to your restaurant's Atithi Setu portal URL
3. Log in with your credentials
4. The Dashboard will load automatically

### 2.2 Initial Setup Checklist

- Create your restaurant profile
- Add menu items and categories
- Generate table-specific QR codes
- Configure GST settings (if applicable)
- Set up staff accounts and roles
- Enable multi-channel notifications
- Test kitchen display system

### 2.3 System Requirements

| Component | Specification |
|-----------|---------------|
| Internet Connection | Minimum 5 Mbps for smooth operation |
| Supported Browsers | Chrome (recommended), Firefox, Safari, Edge |
| Devices | Desktop, Laptop, Tablet (iPad/Android), or Kiosk for KDS |

---

## 3. User Roles & Permissions

Atithi Setu supports multiple user roles, each with specific permissions. This section explains who can do what in the system.

### 3.1 Role Hierarchy

| Role | Access Level | Key Modules | Can Edit Menu? |
|------|--------------|-------------|----------------|
| **Super Admin** | Full System | All | Yes |
| **Restaurant Admin** | Restaurant Only | Most | Yes |
| **Manager** | Operations | KDS, Billing, Reports | Limited |
| **Chef** | Kitchen Only | KDS Only | No |
| **Waiter/Staff** | Service Only | Billing, Status | No |
| **Customer** | Public | Ordering, Reservations | No |

### 3.2 Role Descriptions

#### Super Admin
The Super Admin has unrestricted access to all system features across all restaurants.
- Create and manage multiple restaurants
- View all analytics and reports
- Manage all user accounts
- Configure system-wide settings

#### Restaurant Admin
The Restaurant Admin is the owner or primary manager of a restaurant.
- View and edit menu items
- View all analytics for their restaurant
- Manage staff accounts
- Configure GST and billing settings
- Cannot access other restaurants' data

#### Manager
Managers oversee daily operations.
- View live kitchen display
- Process customer bills and payments
- View operational reports
- Cannot modify menu or staff roles

#### Chef
Chefs receive orders in the kitchen display system.
- View live kitchen orders
- Mark items as ready
- Cannot place orders or modify menus

#### Waiter/Staff
Waiters serve customers and manage table operations.
- Process customer orders at billing
- View table status
- Call for assistance
- Cannot access back-office reports

#### Customer
Customers interact with the public-facing system.
- Scan QR code and browse menu
- Place orders
- Make reservations
- Receive order status updates

### 3.3 Multi-Tenant Data Isolation

A critical feature of Atithi Setu is complete data isolation between restaurants:
- A staff member from Restaurant A cannot see any data from Restaurant B
- Each restaurant's analytics are isolated
- Customer orders are stored separately per restaurant
- Billing and GST data are never shared between restaurants

---

## 4. Digital Menu Management

Your digital menu is the cornerstone of the customer ordering experience. Atithi Setu allows you to create dynamic menus with real-time availability, pricing options, and dietary markers.

### 4.1 Menu Structure

Menus are organized hierarchically:
- Restaurant → Categories → Items → Variants (Half/Full, Toppings, etc.)
- Example: Restaurant > Beverages > Coffee > Variants (Small, Medium, Large)

### 4.2 Creating Menu Categories

1. Log in as Restaurant Admin or Menu Manager
2. Navigate to Menu > Categories
3. Click 'Add New Category'
4. Enter category name (e.g., 'Appetizers', 'Main Course')
5. Set display order (e.g., 1 for first, 2 for second)
6. Click 'Save'

### 4.3 Adding Menu Items

1. Navigate to Menu > Items
2. Click 'Add New Item'
3. Fill in the following fields:
   - Item Name (e.g., 'Butter Chicken')
   - Category (select from dropdown)
   - Description (visible to customers)
   - Dietary Markers (Veg, Non-Veg, Vegan)
   - Base Price (for full portion)
   - Half Price (optional; if enabled, shows two portion options)
   - Images (upload high-quality images; automatically backed up to Google Drive)
4. Enable 'Available' toggle
5. Click 'Save'

### 4.4 Dietary Markers

| Marker | Definition |
|--------|-----------|
| **Veg** | Contains no meat, poultry, or seafood |
| **Non-Veg** | Contains meat, poultry, or seafood |
| **Vegan** | No animal products (no meat, poultry, seafood, eggs, or dairy) |

### 4.5 Dynamic Pricing: Half vs. Full

Atithi Setu supports portion-based pricing:
- **Full Price:** Standard portion
- **Half Price:** Smaller portion at reduced cost (optional)

When you enable 'Half' pricing, customers can choose:
- Full portion at Full Price
- Half portion at Half Price

*Example: Butter Chicken - Full: ₹350, Half: ₹190*

### 4.6 Real-Time Availability

Control which items are available at any moment:
1. Navigate to Menu > Items
2. Find the item you want to manage
3. Toggle the 'Available' switch
4. Unavailable items are:
   - Hidden from the customer menu view
   - Cannot be ordered by new customers
   - Show as greyed out in history (if viewed)

#### What Happens to Orders in Progress?

If an item is marked unavailable while orders are in the kitchen:
- Orders already placed will proceed normally
- Kitchen will complete the order as normal
- Customers will not be affected

### 4.7 Media Management

High-quality images are crucial for customer engagement.

#### Uploading Images:
1. Navigate to Menu > Items > [Your Item]
2. Click 'Upload Image'
3. Select a high-resolution image (JPG, PNG recommended)
4. Image is automatically backed up to Google Drive

#### Google Drive Auto-Backup:
- All menu images are automatically backed up
- Backups occur in real-time as images are uploaded
- If Google Drive sync fails, you'll see a notification
- You can manually download and export images from the backup

---

## 5. QR Code & Customer Ordering

Atithi Setu's frictionless QR ordering system lets customers scan a code, browse the menu, and place orders directly from their mobile device—no app required.

### 5.1 QR Code Generation

Each table has a unique QR code linked to that specific table.

#### Generating Table-Specific QR Codes:
1. Log in as Restaurant Admin
2. Navigate to Operations > Tables
3. Click 'Generate QR Code' for the desired table
4. A unique QR code is created for Table #
5. Download, print, and laminate the QR code
6. Place at the table

#### QR Code Regeneration:
- Old QR codes become invalid immediately
- New QR code is created
- Customers must scan the new code
- A notification can be sent to customers if the QR code changes

### 5.2 Customer Ordering Flow

**Step 1: Scan QR Code**
Customer scans the table-specific QR code using their phone's camera.

**Step 2: Browse Menu**
The menu loads in their browser. Customers can:
- See all available items
- Filter by dietary markers (Veg, Non-Veg, Vegan)
- View item descriptions and prices
- See high-quality images
- Check portion sizes (Half/Full if available)

**Step 3: Place Order**
Customer adds items to cart and proceeds to checkout:
- Select quantity for each item
- Add special instructions (e.g., 'No onions')
- Choose portion size if available
- Review total (including applicable taxes)
- Submit order

**Step 4: Kitchen Display**
Order is immediately sent to the Kitchen Display System.

**Step 5: Order Status Notifications**
Customer receives real-time updates:
- Order received & confirmed
- Order is being prepared
- Items are ready

Notifications are sent via SMS, Email, or WhatsApp (based on restaurant configuration).

**Step 6: Payment**
When the order is ready:
- Customer is notified that food is ready
- Staff brings order to table
- Staff initiates payment (see Invoicing section)
- Customer pays via Cash, Card, or UPI

### 5.3 Order Modification & Cancellation

#### Can Customers Modify Orders?
Once an order has been submitted and is being prepared:
- Modification window: First 2 minutes only
- After 2 minutes, modification is NOT allowed (order is in progress)
- Customers can request special instructions at checkout

#### Can Customers Cancel Orders?
Cancellation policy:
- Cancellation allowed: Before order enters kitchen (within 1 minute of submission)
- After order is in kitchen: Cancellation requires Manager approval
- Full refund: If cancelled before preparation starts
- Partial refund: At Manager discretion if cancelled mid-preparation

### 5.4 Edge Cases & Troubleshooting

#### Invalid/Old QR Code
**Customer:** 'I scanned the QR code but got an error.'

**Solution:**
- Verify the QR code has not been replaced
- Ensure QR code is not damaged (test scan with another phone)
- Check internet connection
- Provide new QR code or verify table mapping

#### Multiple Customers at Same Table
Assumption: Multiple customers can place separate orders from the same table.

Each order is tracked independently:
- All orders appear on KDS for the same table
- Customers receive separate notifications
- Billing can be combined or separate (per restaurant preference)

#### Kitchen Rejects an Order
**Scenario:** Chef marks an order as 'Unable to Fulfill' (e.g., item out of stock).

**Response:**
- Order status changes to 'Rejected'
- Customer is notified immediately via SMS/Email/WhatsApp
- Refund is initiated
- Manager can modify order or offer alternatives

---

## 6. Kitchen Display System (KDS)

The Kitchen Display System is the chef's command center. Orders flow directly from the ordering system to the KDS, showing real-time status, prep time, and item readiness.

### 6.1 KDS Overview

The KDS displays:
- All incoming orders in real-time
- Items grouped by type (Appetizer, Main Course, Dessert, Beverage)
- Time elapsed since order was placed
- Table number for each order
- Special instructions for each item
- Item status (New, In Progress, Ready)

### 6.2 KDS Workflow

#### 1. Order Received
When a customer submits an order:
- Order appears on KDS immediately
- Ring/beep alert notifies kitchen
- Order is highlighted in the 'New' column

#### 2. Chef Starts Preparation
Chef marks item as 'In Progress':
1. Tap on the order item
2. Select 'Mark as In Progress'
3. Item moves to the 'In Progress' column

#### 3. Item Ready
Once item is prepared, chef marks it ready:
1. Tap on the order item
2. Select 'Ready'
3. Item moves to 'Ready' column
4. Server is notified (visual + audio alert)
5. Item is highlighted for pickup

#### 4. Order Complete
Once all items for an order are ready:
- Entire order moves to 'Complete'
- Customer is notified order is ready
- Server picks up from counter

### 6.3 KDS Priorities & Ordering

Orders are displayed in the following priority:
- **FIFO (First In, First Out):** Orders are processed in submission order
- **Time-based highlighting:** Older orders are highlighted to indicate urgency
- **By table:** Orders can be sorted by table number if needed

### 6.4 Multiple Items Per Order

When a customer orders multiple items:
- Each item appears as a separate line on the KDS
- Items can be prepared independently
- Chef can mark individual items as ready
- Order is only 'Complete' when ALL items are ready

### 6.5 KDS Edge Cases

#### Kitchen Goes Offline
If the KDS loses internet connection:
- Pending orders are cached locally
- When connection is restored, orders sync automatically
- No orders are lost
- Admin receives notification of outage

#### Multiple Chefs on Same Order
Assumption: Multiple chefs can work on different items of the same order.

Example: One chef prepares Butter Chicken, another prepares Rice.
- Each chef taps 'In Progress' on their assigned item
- Items move independently through workflow
- System supports this workflow natively

#### Chef Cannot Fulfill Item
If an item cannot be prepared (e.g., out of stock):
1. Chef taps on the item
2. Selects 'Unable to Fulfill' / 'Reject Item'
3. Item status changes to 'Rejected'
4. Manager is alerted
5. Customer is notified
6. Refund is processed

#### KDS Display Freezes
If the KDS screen becomes unresponsive:
- Force refresh: Press Ctrl+Shift+R (Windows) or Cmd+Shift+R (Mac)
- Reload browser tab
- Orders are never lost; they persist in the system
- Contact IT support if issue persists

---

## 7. Table Reservations

Atithi Setu includes a customer-facing table reservation system, allowing guests to book tables in advance and reducing wait times.

### 7.1 Customer Reservation Portal

Customers can book tables through a dedicated portal:

#### Accessing the Portal:
- Customers visit the restaurant's reservation URL
- Browse available tables and time slots
- Select preferred date and time
- Enter party size and contact details
- Submit reservation
- Confirmation sent via Email/SMS/WhatsApp

### 7.2 Managing Reservations (Staff)

#### Viewing All Reservations:
1. Log in as Manager, Admin, or Staff
2. Navigate to Reservations > Calendar
3. View all upcoming reservations
4. Color-coded by status (Confirmed, Checked-In, No-Show, Cancelled)

#### Manually Creating a Reservation:
1. Click 'Add Reservation'
2. Enter customer name
3. Select date and time
4. Select table number
5. Enter party size
6. Add contact information
7. Save

#### Modifying a Reservation:
1. Find reservation in calendar
2. Click 'Edit'
3. Modify date, time, or table
4. Click 'Update'
5. Customer receives update notification

#### Cancelling a Reservation:
1. Find reservation
2. Click 'Cancel'
3. Add cancellation reason (optional)
4. Click 'Confirm Cancel'
5. Customer is notified

Note: Cancellation reason is used for analytics (e.g., 'Customer requested', 'System adjustment').

### 7.3 Reservation Edge Cases

#### Reserved Table Not Occupied by Reservation Time
Assumption: Restaurant has a grace period of 15 minutes.

After 15 minutes:
- Reservation status changes to 'Awaiting Customer'
- Manager can release the table for walk-ins
- After 30 minutes, reservation marked as 'No-Show'
- No-Show is recorded for analytics

#### Customer Wants to Modify Reservation
Customers can modify reservations:
- Via portal: Up to 24 hours before reservation time
- After 24 hours: Contact restaurant directly or request Manager modification

#### Walk-In Customer, but All Tables Reserved
If all tables are reserved:
- Customer is informed of estimated wait time
- Can book a reservation for later time
- Or waitlist for cancellations

### 7.4 Analytics & Optimization

Reservations data helps optimize seating:
- Identify peak reservation times
- Track no-show rates
- Forecast walk-in capacity
- Optimize table turnover time

---

## 8. Staff Management & Attendance

Comprehensive staff directory and attendance tracking ensures smooth operations and accurate payroll.

### 8.1 Staff Directory

#### Adding Staff Members:
1. Log in as Admin
2. Navigate to Staff > Directory
3. Click 'Add New Staff'
4. Enter the following information:
   - Full Name
   - Role (Chef, Waiter, Manager, etc.)
   - Email Address
   - Phone Number
   - Date of Joining
   - Shift Type (Morning, Evening, Flexible)
5. Assign system login credentials (email + temporary password)
6. Click 'Save'

Staff member receives login credentials via email.

#### Managing Staff Roles:
1. Navigate to Staff > Roles
2. Select a staff member
3. Modify their role (with permission confirmation)
4. Role changes are effective immediately
5. Previous permissions are revoked

#### Deactivating Staff:
1. Navigate to Staff > Directory
2. Find staff member
3. Click 'Deactivate'
   - Staff account is disabled
   - Historical records are preserved
   - Cannot be reactivated (for audit purposes)
   - Final attendance and payment records remain accessible

### 8.2 Attendance & Time Tracking

#### Clock In/Clock Out:
Staff members can clock in/out via the app:
1. Staff navigates to 'My Attendance'
2. Clicks 'Clock In'
3. System records time and location (if enabled)
4. At end of shift, clicks 'Clock Out'
5. Daily hours are calculated automatically

#### Manual Attendance Entry:
Managers can manually log attendance:
1. Navigate to Staff > Attendance
2. Select date and staff member
3. Enter clock-in and clock-out times
4. Add notes if needed (e.g., 'Left early for appointment')
5. Save

### 8.3 Shift Management

#### Defining Shifts:
1. Navigate to Staff > Shifts
2. Click 'Add New Shift'
3. Enter shift details:
   - Shift Name (Morning, Afternoon, Evening)
   - Start Time
   - End Time
   - Break Duration (minutes)
4. Assign staff to shifts
5. Save

#### Shift Types:

| Shift Type | Typical Hours | Notes |
|-----------|---|---|
| Morning | 6:00 AM - 2:00 PM | Breakfast & early lunch |
| Afternoon | 2:00 PM - 6:00 PM | Lunch-to-dinner transition |
| Evening | 6:00 PM - 11:00 PM | Dinner service |
| Flexible | As assigned | Variable hours |

### 8.4 Attendance Reports

#### Viewing Attendance Reports:
1. Navigate to Reports > Staff Attendance
2. Select date range
3. Filter by staff member or department
4. View metrics:
   - Total hours worked
   - Attendance percentage
   - Late arrivals (count and total minutes)
   - Early departures
   - Overtime hours
5. Export to CSV/Excel if needed

#### Key Metrics:
- **Attendance %:** (Days present / Total working days) × 100
- **Overtime:** Hours worked beyond standard shift time
- **Late Arrivals:** # of times clocked in after shift start

---

## 9. Invoicing & Billing (with GST)

Atithi Setu includes a comprehensive billing system with automatic GST calculation, support for multiple payment methods, and complete invoice tracking.

### 9.1 GST Configuration

#### Setting Up GST:
1. Log in as Admin
2. Navigate to Settings > Billing > GST Configuration
3. Enable/Disable GST
4. Set default GST rate(s):
   - 5% - For most food items
   - 0% - For certain exempted items (varies by region)
   - 18% - For premium/processed items
5. Configure item-specific GST rates (optional)
6. Save

#### Item-Level GST:
Some items may have different GST rates:
- **Dine-in:** Standard rate (5-18%)
- **Takeaway:** May have different rate depending on jurisdiction
- **Beverages:** Often taxed at 5% or 0%

Configure these during menu item creation.

### 9.2 Invoice Generation

#### Automatic Invoice Creation:
When a customer completes an order and requests payment:
1. System generates an invoice automatically
2. Invoice includes:
   - Order ID and timestamp
   - Table number
   - Itemized list with prices
   - Subtotal
   - GST amount (calculated automatically)
   - Grand Total
   - Restaurant details (name, address, GSTIN)
3. Invoice is sent to customer via SMS/Email/WhatsApp

#### Invoice Status:

| Status | Meaning | Next Step |
|--------|---------|-----------|
| Pending | Invoice generated but not paid | Await payment |
| Paid | Payment received in full | Invoice closed |
| Partial | Partial payment received | Accept remaining payment |
| Cancelled | Invoice voided (refund) | Closed (audit trail kept) |

### 9.3 Payment Methods

#### Cash
Traditional payment method:
1. Waiter initiates payment
2. Customer pays cash
3. Waiter enters amount received
4. System calculates change
5. Invoice marked as Paid

Cash transactions are recorded in the till and can be reconciled at end of day.

#### Card (Debit/Credit)
Electronic payment:
1. Waiter initiates payment
2. Point of Sale (POS) device processes card
3. Payment authorization is received
4. Invoice automatically marked as Paid

Failed card payments: Invoice remains Pending; customer must retry or use another method.

#### UPI (Unified Payments Interface)
India-specific mobile payment:
1. Waiter displays UPI QR code
2. Customer scans with their UPI app
3. Confirms payment
4. Invoice marked as Paid

### 9.4 GST Calculation Examples

#### Example 1: Simple Meal (5% GST)

| Item | Amount |
|------|--------|
| Butter Chicken | ₹300 |
| Basmati Rice | ₹120 |
| **Subtotal** | **₹420** |
| GST (5%) | ₹21 |
| **Total** | **₹441** |

### 9.5 Billing Edge Cases

#### Partial Payments
Customer wants to pay part now, part later:
1. Waiter initiates payment for ₹250 of ₹500
2. System records as 'Partial'
3. Remaining balance: ₹250
4. Customer returns later to complete payment
5. System marks as 'Paid' once full amount received

#### Card Payment Failure
Card is declined:
- Payment fails and is not processed
- Invoice remains 'Pending'
- Customer can retry with same card or another method
- No GST is charged until payment succeeds

#### GST Rate Changes Mid-Month
Rare scenario where GST rates change during a billing period:
- Existing 'Pending' invoices retain their original GST rate
- New orders use new GST rate
- Historical invoices show the rate at time of transaction
- For audit, both rates are tracked separately

#### Refund Processing
Customer requests refund:
1. Waiter navigates to invoice
2. Clicks 'Process Refund'
3. Selects refund reason (e.g., 'Item not acceptable', 'Customer request')
4. System calculates GST reversal
5. Refund is issued to original payment method
6. Invoice marked as 'Cancelled'
7. Audit trail preserved

---

## 10. Reporting & Analytics

Atithi Setu provides comprehensive analytics and reporting tools to help restaurant owners understand their business performance.

### 10.1 Dashboard Overview

The main analytics dashboard displays:
- Daily/Weekly/Monthly sales trends
- Total revenue and number of orders
- Top-selling menu items
- Peak ordering hours
- Payment method breakdown (Cash, Card, UPI)
- Table utilization rates
- Staff performance metrics

### 10.2 Sales Reports

#### Viewing Sales Data:
1. Navigate to Reports > Sales
2. Select date range (Today, This Week, This Month, Custom)
3. Choose granularity (Hourly, Daily, Weekly)
4. View metrics:
   - Total orders
   - Total revenue
   - Average order value
   - Number of paid invoices
   - Number of pending invoices
5. Export to CSV/Excel/PDF

### 10.3 Menu Item Analytics

#### Most Popular Items:
1. Navigate to Reports > Menu Performance
2. View ranking of menu items by:
   - Quantity ordered
   - Revenue generated
   - Profit margin
3. Filter by date range and category
4. Identify best-sellers and slow-movers

### 10.4 Peak Hours Analysis

Understand customer traffic patterns:
- Orders by hour (identifies peak times)
- Average preparation time (identifies bottlenecks)
- Table occupancy rates
- Staff efficiency during peak hours

Use this data to:
- Schedule more staff during peak hours
- Plan inventory and prep
- Optimize table management

### 10.5 Payment Method Breakdown

#### Payment Analytics:
1. Navigate to Reports > Payments
2. View breakdown by payment method:
   - Cash: Total amount and number of transactions
   - Card: Total amount and number of transactions
   - UPI: Total amount and number of transactions
3. Compare trends over time
4. Cash reconciliation with till

### 10.6 Financial Reports

#### Revenue vs. Expenses:
View profit analysis:
- Total revenue
- Cost of goods sold (COGS)
- Gross profit
- Operating expenses (staff payroll, utilities, etc.)
- Net profit

#### GST Breakdown:
1. Navigate to Reports > GST
2. View GST collected by rate:
   - GST at 5%: ₹X
   - GST at 18%: ₹Y
   - Total GST collected: ₹Z
3. Export for tax filing

### 10.7 Reservation Analytics

Analyze table reservation patterns:
- Reservation rate (% of bookings vs. walk-ins)
- No-show rate
- Average party size
- Peak reservation times
- Table turnover time

### 10.8 Staff Performance Reports

#### Individual Staff Metrics:
1. Navigate to Reports > Staff Performance
2. View per-staff metrics:
   - Orders processed
   - Total billing amount
   - Payment success rate
   - Average order value
   - Customer feedback/ratings

#### Attendance & Payroll:
1. Navigate to Reports > Attendance & Payroll
2. View:
   - Total hours worked
   - Overtime hours
   - Attendance rate
   - Late arrivals
   - Estimated payroll amount

---

## 11. Multi-Channel Notifications

Atithi Setu sends automated notifications via Email, SMS, and WhatsApp to keep customers and staff informed.

### 11.1 Notification Channels

#### Email
Professional, detailed notifications
- Order confirmation
- Order status updates
- Invoice/receipt
- Reservation confirmation

#### SMS
Quick, concise text messages
- Order placed: 'Your order #123 is received'
- Ready for pickup: 'Your order is ready!'
- Reservation confirmed: 'Table reserved for 2 people at 7:00 PM'

#### WhatsApp
Rich, interactive messages
- Order status with estimated time
- Special promotions and offers
- Table reservation reminders

### 11.2 Configuring Notifications

#### Admin Settings:
1. Log in as Admin
2. Navigate to Settings > Notifications
3. Configure for each event:
   - Order Placed: Enable/Disable; Choose channels (Email, SMS, WhatsApp)
   - Order Ready: Enable/Disable; Choose channels
   - Order Complete: Enable/Disable; Choose channels
   - Reservation Confirmed: Enable/Disable; Choose channels
   - Reservation Reminder (24 hours before): Enable/Disable
4. Customize message templates (optional)
5. Save

### 11.3 Notification Triggers

#### For Customers:

| Event | Trigger | Default Channels |
|-------|---------|------------------|
| Order Placed | Customer submits order | SMS, Email |
| In Preparation | Chef marks item as 'In Progress' | WhatsApp (optional) |
| Order Ready | All items marked 'Ready' | SMS, WhatsApp |
| Payment Processed | Invoice marked as 'Paid' | Email |
| Reservation Confirmation | Customer books table | SMS, Email, WhatsApp |
| Reservation Reminder | 24 hours before reservation | SMS, WhatsApp |

#### For Staff:

| Event | Recipient | Method |
|-------|-----------|--------|
| New Order Arrived | Chef | KDS beep/visual |
| Item Ready for Pickup | Waiter/Server | Visual + audio alert |
| Staff Shift Alert | Manager | Email, SMS |

---

## 12. Troubleshooting & FAQ

### 12.1 Common Issues

#### Problem: Customer Cannot Scan QR Code
**Issue:** Customer scans QR code but page doesn't load.

**Solutions:**
- Check internet connection on customer's phone
- Ensure QR code is not damaged or blurry
- Try a different QR code (regenerate if needed)
- Test QR code with another device
- Clear browser cache and try again

#### Problem: KDS Not Displaying Orders
**Issue:** Kitchen display is blank or not showing new orders.

**Solutions:**
- Refresh browser (F5 or Ctrl+R)
- Check internet connection
- Restart KDS browser/application
- Verify KDS device has correct permissions
- Contact IT support if persists

#### Problem: Payment Declined (Card)
**Issue:** Customer's card payment is rejected.

**Solutions:**
- Verify card details are correct
- Check if card is expired
- Ensure sufficient funds on card
- Try a different card
- Use Cash or UPI as alternative

#### Problem: GST Not Calculated Correctly
**Issue:** Invoice shows incorrect GST amount.

**Solutions:**
- Verify GST rate is configured correctly in Settings
- Check if item has custom GST rate
- Recalculate invoice manually to verify
- Contact admin if discrepancy persists

#### Problem: Staff Cannot Log In
**Issue:** Staff member receives 'Invalid credentials' error.

**Solutions:**
- Verify staff account is active (not deactivated)
- Reset password via forgot password link
- Check if role has been modified (permissions may have changed)
- Contact admin to re-enable account

#### Problem: Notification Not Received
**Issue:** Customer doesn't receive order status update.

**Solutions:**
- Verify notification is enabled in Settings
- Check customer phone number/email is correct
- Verify SMS/Email/WhatsApp gateway is active
- Check spam folder for email
- Resend notification manually

### 12.2 FAQ

**Q: Can I use Atithi Setu on mobile?**
A: Yes, Atithi Setu is fully responsive. Access it from any mobile browser.

**Q: What happens if a customer loses their order ID?**
A: Customers can ask staff, or staff can look up the order by table number and timestamp.

**Q: Can I modify menu items after they're ordered?**
A: You can add new items and hide unavailable items. Orders already placed are unaffected.

**Q: How do I export sales data for accounting?**
A: Navigate to Reports > Sales, select date range, and click 'Export to CSV/Excel'.

**Q: Are there limits on the number of menu items I can have?**
A: No hard limits, but we recommend keeping menus under 100 items for optimal performance.

**Q: How do I calculate staff payroll?**
A: Use Reports > Attendance & Payroll. It shows total hours worked and overtime calculations.

**Q: What's the difference between 'Half' and 'Full' pricing?**
A: Half is a smaller portion at reduced price. Both options are available to customers.

**Q: Can customers modify orders after placing them?**
A: Only within the first 2 minutes. After that, they must cancel and reorder.

**Q: How are multi-tenant restaurants separated?**
A: Each restaurant has its own PostgreSQL schema. Data is completely isolated.

**Q: Can I download menu images from Google Drive?**
A: Yes, images are backed up automatically. Contact admin if you need to retrieve them.

**Q: What if GST requirements change in my region?**
A: Admin can update GST rates in Settings anytime. It applies to new invoices immediately.

---

## 13. Appendix & Configuration

### 13.1 Keyboard Shortcuts

| Action | Windows | Mac |
|--------|---------|-----|
| Refresh Page | Ctrl+R | Cmd+R |
| Clear Cache | Ctrl+Shift+R | Cmd+Shift+R |
| Developer Tools | F12 | Cmd+Option+I |
| Print | Ctrl+P | Cmd+P |

### 13.2 Browser Compatibility

| Browser | Support | Min Version | Notes |
|---------|---------|-------------|-------|
| Chrome | Recommended | v90+ | Best performance |
| Firefox | Supported | v88+ | Full support |
| Safari | Supported | v14+ | iOS/Mac |
| Edge | Supported | v90+ | Chromium-based |

### 13.3 Contact & Support

For technical issues, feature requests, or general support:
- **Email:** support@atithisetu.com
- **Phone:** +91-XXXX-XXXXXX
- **Website:** www.atithisetu.com
- **Documentation:** docs.atithisetu.com

### 13.4 Data Backup & Recovery

Atithi Setu automatically backs up all data daily. In case of data loss:
- Contact support with invoice/order ID
- Restoration can typically be done within 24-48 hours
- All backup data is encrypted and secure

### 13.5 Glossary

- **GST:** Goods and Services Tax (India's value-added tax)
- **KDS:** Kitchen Display System (chef's order screen)
- **QR Code:** Quick Response Code (scannable barcode)
- **UPI:** Unified Payments Interface (mobile payment method in India)
- **Tenant:** Individual restaurant in a multi-tenant system
- **Invoice:** Itemized bill for a customer order
- **Reservation:** Table booking by a customer
- **SKU:** Stock Keeping Unit (unique identifier for menu items)
- **API:** Application Programming Interface (system integration)

---

## Document Information

- **Title:** Atithi Setu - Comprehensive User Manual
- **Version:** 1.0
- **Date:** March 2026
- **Audience:** Restaurant Owners, Managers, Staff, Customers

This manual covers all features of the Atithi Setu restaurant management platform. For the latest updates and feature announcements, visit www.atithisetu.com.

---

**© 2026 Atithi Setu. All rights reserved.**
