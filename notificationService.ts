/**
 * Atithi-Setu — Notification Service
 *
 * Channels:
 *   • WhatsApp  — Meta Cloud API (Business Messaging)
 *   • SMS       — Twilio
 *   • Email     — SMTP / Nodemailer
 *   • Telegram  — Telegram Bot API
 *
 * Required environment variables:
 *   META_WA_ACCESS_TOKEN     — Permanent / long-lived token from Meta Business Manager
 *   META_WA_PHONE_NUMBER_ID  — Phone Number ID (NOT the phone number itself)
 *   TWILIO_ACCOUNT_SID       — Twilio account SID
 *   TWILIO_AUTH_TOKEN        — Twilio auth token
 *   TWILIO_PHONE_NUMBER      — Twilio SMS-capable number (e.g. +14155551234)
 *   SMTP_HOST                — e.g. smtp.gmail.com
 *   SMTP_PORT                — e.g. 587
 *   SMTP_SECURE              — "true" for port 465, "false" for STARTTLS
 *   SMTP_USER                — SMTP username / email
 *   SMTP_PASS                — SMTP password / app-password
 *   SMTP_FROM                — Sender display string (e.g. "Atithi-Setu <no-reply@example.com>")
 *   TELEGRAM_BOT_TOKEN       — Token from @BotFather (e.g. 123456:ABC-DEF...)
 *   TELEGRAM_DEFAULT_CHAT_ID — Default chat/group/channel ID to send to (optional fallback)
 */

import twilio from 'twilio';
import nodemailer from 'nodemailer';

// ── Twilio client (SMS only) ──────────────────────────────────────────────────
const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

// ── SMTP transporter (Email) ──────────────────────────────────────────────────
const mailTransporter = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    })
  : null;

// ── Meta Cloud API config (WhatsApp) ─────────────────────────────────────────
const META_WA_PHONE_NUMBER_ID = process.env.META_WA_PHONE_NUMBER_ID;
const META_WA_ACCESS_TOKEN    = process.env.META_WA_ACCESS_TOKEN;
const META_GRAPH_VERSION      = 'v20.0';

// ── Telegram Bot API config ───────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_DEFAULT_CHAT_ID = process.env.TELEGRAM_DEFAULT_CHAT_ID;

// ─────────────────────────────────────────────────────────────────────────────
// Utility: normalise a phone string to E.164 format expected by Meta & Twilio
//   "9876543210"      → "+919876543210"  (10-digit Indian mobile — adds +91)
//   "919876543210"    → "+919876543210"
//   "+919876543210"   → "+919876543210"  (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
function toE164(phone: string, defaultCountryCode = '91'): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10)   return `+${defaultCountryCode}${digits}`;
  return `+${digits}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Notification content builder — per-event rich templates
// Returns { subject, text (plain / WhatsApp), html (email) }
// ─────────────────────────────────────────────────────────────────────────────
export interface NotificationContent {
  subject: string;
  text:    string;   // plain text for SMS & WhatsApp
  html:    string;   // rich HTML for email
}

export function buildNotificationContent(
  eventName: string,
  data: Record<string, any>
): NotificationContent {
  const r = data.restaurantName || 'Atithi-Setu';

  switch (eventName) {

    /* ── Kitchen & Orders ─────────────────────────────────────────────── */

    case 'ORDER_PLACED': {
      // Cloud-kitchen orders carry full delivery details — render an enriched
      // template so the owner can dispatch from the notification alone.
      const isCloudKitchen = data.orderType === 'cloud_kitchen';
      const invLine = data.invoiceNumber ? `Invoice: ${data.invoiceNumber}\n` : '';
      const invHtml = data.invoiceNumber
        ? `<p>Invoice: <strong>${data.invoiceNumber}</strong></p>` : '';

      // Build itemized list (one line per item) when itemsDetailed is provided.
      const itemized = Array.isArray(data.itemsDetailed) && data.itemsDetailed.length
        ? (data.itemsDetailed as any[]).map((i: any) => {
            const name = i.name || i.item_name || 'Item';
            const qty  = i.quantity ?? 1;
            const price = (i.price != null) ? ` — ₹${i.price}` : '';
            return `• ${name} x${qty}${price}`;
          }).join('\n')
        : ((data.items as string[] | undefined)?.join(', ') || '—');

      const itemizedHtml = Array.isArray(data.itemsDetailed) && data.itemsDetailed.length
        ? `<ul>${(data.itemsDetailed as any[]).map((i: any) => {
            const name = i.name || i.item_name || 'Item';
            const qty  = i.quantity ?? 1;
            const price = (i.price != null) ? ` — ₹${i.price}` : '';
            return `<li>${name} × ${qty}${price}</li>`;
          }).join('')}</ul>`
        : `<p>Items: ${(data.items as string[] | undefined)?.join(', ') || '—'}</p>`;

      if (isCloudKitchen) {
        const cust = data.customerName || '—';
        const phone = data.customerPhone || '—';
        const addr = data.customerAddress || '—';
        const pay  = data.paymentMethod || '—';
        const gstLine = (data.gstAmount != null && Number(data.gstAmount) > 0)
          ? `GST: ₹${data.gstAmount}\n` : '';
        const gstHtml = (data.gstAmount != null && Number(data.gstAmount) > 0)
          ? `<p>GST: <strong>₹${data.gstAmount}</strong></p>` : '';

        return {
          subject: `📦 Online Order ${data.invoiceNumber || `#${data.orderId}`} — ${r}`,
          text:
            `📦 *New Online Order (Cloud Kitchen)*\n` +
            `Order: #${data.orderId}\n` +
            invLine +
            `Customer: ${cust}\n` +
            `Phone: ${phone}\n` +
            `Address: ${addr}\n` +
            `Payment: ${pay}\n` +
            `Items:\n${itemized}\n` +
            gstLine +
            `Total: ₹${data.total ?? '—'}`,
          html:
            `<h2 style="color:#0E7490">📦 New Online Order (Cloud Kitchen)</h2>` +
            `<p>Order <strong>#${data.orderId}</strong></p>` +
            invHtml +
            `<p>Customer: <strong>${cust}</strong></p>` +
            `<p>Phone: <strong>${phone}</strong></p>` +
            `<p>Delivery Address:<br/><strong>${addr}</strong></p>` +
            `<p>Payment: <strong>${pay}</strong></p>` +
            itemizedHtml +
            gstHtml +
            `<p>Total: <strong>₹${data.total ?? '—'}</strong></p>`,
        };
      }

      return {
        subject: `🍽️ New Order #${data.orderId} — ${r}`,
        text:
          `🍽️ *New Order Received!*\n` +
          `Order: #${data.orderId}\n` +
          `Table: ${data.tableNumber || 'Takeaway'}\n` +
          `Items: ${(data.items as string[] | undefined)?.join(', ') || '—'}\n` +
          `Total: ₹${data.total ?? '—'}`,
        html:
          `<h2 style="color:#5A5A40">🍽️ New Order Received</h2>` +
          `<p>Order <strong>#${data.orderId}</strong></p>` +
          `<p>Table: <strong>${data.tableNumber || 'Takeaway'}</strong></p>` +
          `<p>Items: ${(data.items as string[] | undefined)?.join(', ') || '—'}</p>` +
          `<p>Total: <strong>₹${data.total ?? '—'}</strong></p>`,
      };
    }

    case 'STOCK_LOW':
    case 'STOCK_CRITICAL': {
      const isCritical = eventName === 'STOCK_CRITICAL';
      const days = data.daysOfCover != null
        ? `${Number(data.daysOfCover).toFixed(1)} days of cover`
        : 'no recent consumption';
      const supplierLine = data.supplierName
        ? `${data.supplierName}${data.supplierPhone ? ' · ' + data.supplierPhone : ''} (lead time ${data.leadTimeDays || '?'} days)`
        : 'No default supplier set';
      const suggested = data.suggestedOrderQty
        ? `Suggested order: ${Number(data.suggestedOrderQty).toFixed(2)} ${data.unit}`
        : '';
      const autoPOLine = data.autoPOId
        ? `📋 DRAFT PO ${data.autoPOId} ready — review and Send to supplier.`
        : '';
      const icon = isCritical ? '🚨' : '⚠️';
      const title = isCritical ? 'STOCK CRITICAL' : 'Stock Low';
      const subtitle = isCritical
        ? `Will run out before next reorder arrives (${data.leadTimeDays}d lead time vs ${days})`
        : `Below reorder point — schedule purchase`;
      return {
        subject: `${icon} ${title}: ${data.ingredientName} — ${r}`,
        text:
          `${icon} *${title}* — ${r}\n` +
          `Ingredient: ${data.ingredientName}\n` +
          `Current stock: ${Number(data.currentStock).toFixed(2)} ${data.unit}\n` +
          `Reorder point: ${Number(data.reorderPoint).toFixed(2)} ${data.unit}\n` +
          `Daily use:     ${Number(data.dailyForecast).toFixed(2)} ${data.unit}/day · ${days}\n` +
          `Supplier:      ${supplierLine}\n` +
          (suggested ? suggested + '\n' : '') +
          (autoPOLine ? '\n' + autoPOLine + '\n' : '') +
          (isCritical ? '\n⚠️ Order TODAY to avoid stock-out.' : ''),
        html:
          `<h2 style="color:${isCritical ? '#dc2626' : '#d97706'}">${icon} ${title}</h2>` +
          `<p>${subtitle}</p>` +
          `<table cellpadding="6" style="border-collapse:collapse;font-size:14px;">` +
          `<tr><td style="color:#6b5d52">Ingredient</td><td><strong>${data.ingredientName}</strong></td></tr>` +
          `<tr><td style="color:#6b5d52">Current stock</td><td><strong>${Number(data.currentStock).toFixed(2)} ${data.unit}</strong></td></tr>` +
          `<tr><td style="color:#6b5d52">Reorder point</td><td>${Number(data.reorderPoint).toFixed(2)} ${data.unit}</td></tr>` +
          `<tr><td style="color:#6b5d52">Daily forecast</td><td>${Number(data.dailyForecast).toFixed(2)} ${data.unit}/day · ${days}</td></tr>` +
          `<tr><td style="color:#6b5d52">Supplier</td><td>${supplierLine}</td></tr>` +
          (suggested ? `<tr><td style="color:#6b5d52">Suggested order</td><td><strong>${Number(data.suggestedOrderQty).toFixed(2)} ${data.unit}</strong></td></tr>` : '') +
          (autoPOLine ? `<tr><td style="color:#6b5d52">Auto-PO</td><td><strong style="color:#0E7490">📋 ${data.autoPOId} ready — review &amp; Send</strong></td></tr>` : '') +
          `</table>` +
          (isCritical ? `<p style="color:#dc2626;font-weight:bold;margin-top:12px">Order TODAY to avoid stock-out.</p>` : ''),
      };
    }

    case 'ORDER_READY':
      return {
        subject: `✅ Order #${data.orderId} Ready — ${r}`,
        text:
          `✅ *Order Ready to Serve!*\n` +
          `Order #${data.orderId} is ready.\n` +
          `Table: ${data.tableNumber || 'Takeaway'}`,
        html:
          `<h2 style="color:#059669">✅ Order Ready to Serve</h2>` +
          `<p>Order <strong>#${data.orderId}</strong> is ready for the table.</p>` +
          `<p>Table: <strong>${data.tableNumber || 'Takeaway'}</strong></p>`,
      };

    case 'ORDER_CANCELLED':
      return {
        subject: `❌ Order #${data.orderId} Cancelled — ${r}`,
        text:
          `❌ *Order Cancelled*\n` +
          `Order #${data.orderId} has been cancelled.\n` +
          `Table: ${data.tableNumber || '—'}`,
        html:
          `<h2 style="color:#DC2626">❌ Order Cancelled</h2>` +
          `<p>Order <strong>#${data.orderId}</strong> has been cancelled.</p>` +
          `<p>Table: ${data.tableNumber || '—'}</p>`,
      };

    case 'CUSTOMER_ORDER_CONFIRMATION':
      return {
        subject: `🎉 Order Confirmed — ${r}`,
        text:
          `🎉 *Your order is confirmed!*\n` +
          `Order: #${data.orderId}\n` +
          `Items: ${(data.items as string[] | undefined)?.join(', ') || '—'}\n` +
          `Total: ₹${data.total ?? '—'}\n` +
          `Estimated time: 20–30 min\n` +
          `Thank you for ordering from ${r}!`,
        html:
          `<h2 style="color:#5A5A40">🎉 Your Order is Confirmed!</h2>` +
          `<p>Order <strong>#${data.orderId}</strong></p>` +
          `<p>Items: ${(data.items as string[] | undefined)?.join(', ') || '—'}</p>` +
          `<p>Total: <strong>₹${data.total ?? '—'}</strong></p>` +
          `<p>Estimated preparation time: 20–30 minutes.</p>` +
          `<p>Thank you for ordering from <strong>${r}</strong>!</p>`,
      };

    case 'CUSTOMER_INVOICE':
      return {
        subject: `🧾 Invoice — Order #${data.orderId} — ${r}`,
        text:
          `🧾 *Invoice for Order #${data.orderId}*\n` +
          `Subtotal: ₹${data.subtotal ?? '—'}\n` +
          `GST: ₹${data.gst ?? '—'}\n` +
          `Total: ₹${data.total ?? '—'}\n` +
          `Payment: ${data.paymentMethod || 'N/A'}\n` +
          `Thank you for dining with us!`,
        html:
          `<h2 style="color:#5A5A40">🧾 Your Invoice</h2>` +
          `<p>Order <strong>#${data.orderId}</strong></p>` +
          `<table border="0" cellpadding="6" style="border-collapse:collapse">` +
          `<tr><td>Subtotal</td><td>₹${data.subtotal ?? '—'}</td></tr>` +
          `<tr><td>GST</td><td>₹${data.gst ?? '—'}</td></tr>` +
          `<tr><td><strong>Total</strong></td><td><strong>₹${data.total ?? '—'}</strong></td></tr>` +
          `</table>` +
          `<p>Payment Method: <strong>${data.paymentMethod || 'N/A'}</strong></p>` +
          `<p>Thank you for dining with <strong>${r}</strong>!</p>`,
      };

    /* ── Payments ─────────────────────────────────────────────────────── */

    case 'PAYMENT_RECEIVED':
      return {
        subject: `💰 Payment Received — ₹${data.total ?? '—'} — ${r}`,
        text:
          `💰 *Payment Received*\n` +
          `Order #${data.orderId}\n` +
          `Amount: ₹${data.total ?? '—'}\n` +
          `Method: ${data.paymentMethod || 'N/A'}`,
        html:
          `<h2 style="color:#5A5A40">💰 Payment Received</h2>` +
          `<p>Order <strong>#${data.orderId}</strong></p>` +
          `<p>Amount: <strong>₹${data.total ?? '—'}</strong></p>` +
          `<p>Payment Method: ${data.paymentMethod || 'N/A'}</p>`,
      };

    /* ── Table Bookings ───────────────────────────────────────────────── */

    case 'TABLE_BOOKING':
      return {
        subject: `📅 New Booking — ${data.customerName || 'Guest'} — ${r}`,
        text:
          `📅 *New Table Booking!*\n` +
          `Customer: ${data.customerName || 'N/A'}\n` +
          `Phone: ${data.customerPhone || 'N/A'}\n` +
          `Date: ${data.bookingDate || 'N/A'} at ${data.bookingTime || 'N/A'}\n` +
          `Guests: ${data.guests || 'N/A'}`,
        html:
          `<h2 style="color:#5A5A40">📅 New Table Booking</h2>` +
          `<p>Customer: <strong>${data.customerName || 'N/A'}</strong></p>` +
          `<p>Phone: ${data.customerPhone || 'N/A'}</p>` +
          `<p>Date: <strong>${data.bookingDate || 'N/A'}</strong> at <strong>${data.bookingTime || 'N/A'}</strong></p>` +
          `<p>Guests: ${data.guests || 'N/A'}</p>`,
      };

    case 'BOOKING_CONFIRMED':
      return {
        subject: `✅ Booking Confirmed — ${r}`,
        text:
          `✅ *Your booking is confirmed!*\n` +
          `Restaurant: ${r}\n` +
          `Date: ${data.bookingDate || 'N/A'} at ${data.bookingTime || 'N/A'}\n` +
          `Guests: ${data.guests || 'N/A'}\n` +
          `We look forward to welcoming you!`,
        html:
          `<h2 style="color:#059669">✅ Booking Confirmed!</h2>` +
          `<p>Your table at <strong>${r}</strong> is confirmed.</p>` +
          `<p>Date: <strong>${data.bookingDate || 'N/A'}</strong> at <strong>${data.bookingTime || 'N/A'}</strong></p>` +
          `<p>Guests: ${data.guests || 'N/A'}</p>` +
          `<p>We look forward to welcoming you! 🙏</p>`,
      };

    case 'BOOKING_CANCELLED':
      return {
        subject: `❌ Booking Cancelled — ${r}`,
        text:
          `❌ *Booking Cancelled*\n` +
          `Your booking on ${data.bookingDate || 'N/A'} at ${data.bookingTime || 'N/A'} has been cancelled.\n` +
          `Please contact us to rebook or for any queries.`,
        html:
          `<h2 style="color:#DC2626">❌ Booking Cancelled</h2>` +
          `<p>Your booking at <strong>${r}</strong> on <strong>${data.bookingDate || 'N/A'}</strong> at <strong>${data.bookingTime || 'N/A'}</strong> has been cancelled.</p>` +
          `<p>Please contact us to rebook or for any queries.</p>`,
      };

    /* ── Feedback ─────────────────────────────────────────────────────── */

    case 'NEW_FEEDBACK': {
      const stars = '⭐'.repeat(Math.min(5, parseInt(String(data.rating || '0'), 10)));
      return {
        subject: `⭐ New Feedback (${data.rating}/5) — ${r}`,
        text:
          `⭐ *New Customer Feedback!*\n` +
          `From: ${data.customerName || 'Anonymous'}\n` +
          `Rating: ${stars} (${data.rating}/5)\n` +
          `"${data.comment || 'No comment'}"`,
        html:
          `<h2 style="color:#5A5A40">⭐ New Customer Feedback</h2>` +
          `<p>From: <strong>${data.customerName || 'Anonymous'}</strong></p>` +
          `<p>Rating: ${stars} (${data.rating}/5)</p>` +
          `<blockquote style="border-left:4px solid #5A5A40;padding:8px 16px;color:#333">"${data.comment || 'No comment'}"</blockquote>`,
      };
    }

    /* ── Daily Report ─────────────────────────────────────────────────── */

    case 'DAILY_REPORT':
      return {
        subject: `📊 Daily Sales Report — ${data.date || 'Today'} — ${r}`,
        text:
          `📊 *Daily Sales Summary — ${data.date || 'Today'}*\n` +
          `Total Orders: ${data.orderCount ?? 0}\n` +
          `Revenue: ₹${data.revenue ?? '0'}\n` +
          `Top Item: ${data.topItem || 'N/A'}`,
        html:
          `<h2 style="color:#5A5A40">📊 Daily Sales Report — ${data.date || 'Today'}</h2>` +
          `<table border="0" cellpadding="6">` +
          `<tr><td>Total Orders</td><td><strong>${data.orderCount ?? 0}</strong></td></tr>` +
          `<tr><td>Revenue</td><td><strong>₹${data.revenue ?? '0'}</strong></td></tr>` +
          `<tr><td>Top Item</td><td>${data.topItem || 'N/A'}</td></tr>` +
          `</table>`,
      };

    /* ── Staff Attendance ─────────────────────────────────────────────── */

    case 'STAFF_ATTENDANCE':
      return {
        subject: `👤 Staff ${data.type === 'CHECK_IN' ? 'Check-In' : 'Check-Out'} — ${r}`,
        text:
          `👤 *Staff Attendance*\n` +
          `${data.staffName || 'Staff member'} has ${data.type === 'CHECK_IN' ? 'checked in' : 'checked out'}.\n` +
          `Time: ${data.time || new Date().toLocaleTimeString()}`,
        html:
          `<h2 style="color:#5A5A40">👤 Staff Attendance</h2>` +
          `<p><strong>${data.staffName || 'Staff member'}</strong> has ${data.type === 'CHECK_IN' ? 'checked in' : 'checked out'}.</p>` +
          `<p>Time: ${data.time || new Date().toLocaleTimeString()}</p>`,
      };

    /* ── Hospitality module (Phase 2) ───────────────────────────────── */

    case 'HOUSEKEEPING_REQUESTED':
      return {
        subject: `🧹 ${data.category || 'Service'} request — Room ${data.roomId || '?'} — ${r}`,
        text:
          `🧹 *New guest request*\n` +
          `Room: ${data.roomId}\n` +
          `Service: ${data.serviceName}\n` +
          `Category: ${data.category}\n` +
          (data.priority && data.priority !== 'NORMAL' ? `Priority: ${data.priority}\n` : '') +
          `Ref: ${data.requestId}`,
        html:
          `<h2 style="color:#cc5a16">🧹 New guest request</h2>` +
          `<p>Room: <strong>${data.roomId}</strong></p>` +
          `<p>Service: <strong>${data.serviceName}</strong></p>` +
          `<p>Category: ${data.category}</p>` +
          (data.priority && data.priority !== 'NORMAL' ? `<p>Priority: <strong>${data.priority}</strong></p>` : '') +
          `<p style="color:#9c8e85">Ref: ${data.requestId}</p>`,
      };

    case 'SERVICE_REQUEST_COMPLETED':
      return {
        subject: `✅ Your request is complete — ${r}`,
        text:
          `✅ *Request complete!*\n` +
          `${data.serviceName} for Room ${data.roomId}\n` +
          `How did we do? Rate your experience in the app.`,
        html:
          `<h2 style="color:#0f766e">✅ Your request is complete</h2>` +
          `<p><strong>${data.serviceName}</strong> for Room ${data.roomId}</p>` +
          `<p>How did we do? Rate your experience in the app.</p>`,
      };

    case 'SLA_BREACH':
      return {
        subject: `⚠️ SLA breach — ${data.serviceName} — ${r}`,
        text:
          `⚠️ *SLA Breach*\n` +
          `Request: ${data.serviceName}\n` +
          `Room: ${data.roomName}\n` +
          `SLA: ${data.slaMinutes} min · Elapsed: ${data.elapsedMinutes} min\n` +
          `Ref: ${data.requestId}`,
        html:
          `<h2 style="color:#c13b3b">⚠️ SLA Breach</h2>` +
          `<p>Request: <strong>${data.serviceName}</strong></p>` +
          `<p>Room: <strong>${data.roomName}</strong></p>` +
          `<p>SLA: ${data.slaMinutes} min — <span style="color:#c13b3b">elapsed ${data.elapsedMinutes} min</span></p>` +
          `<p style="color:#9c8e85">Ref: ${data.requestId}</p>`,
      };

    case 'BOOKING_CREATED':
      return {
        subject: `📅 New booking — ${data.guestName} — ${r}`,
        text:
          `📅 *New booking*\n` +
          `Guest: ${data.guestName}\n` +
          `Check-in: ${data.checkIn}\n` +
          `Check-out: ${data.checkOut}\n` +
          `Ref: ${data.bookingId}`,
        html:
          `<h2 style="color:#cc5a16">📅 New booking</h2>` +
          `<p>Guest: <strong>${data.guestName}</strong></p>` +
          `<p>Check-in: ${data.checkIn}</p>` +
          `<p>Check-out: ${data.checkOut}</p>` +
          `<p style="color:#9c8e85">Ref: ${data.bookingId}</p>`,
      };

    case 'GUEST_CHECKED_IN':
      return {
        subject: `🛎 Guest checked in — Room ${data.roomId} — ${r}`,
        text:
          `🛎 *Guest checked in*\n` +
          `Guest: ${data.guestName}\n` +
          `Room: ${data.roomId}`,
        html:
          `<h2 style="color:#b8860b">🛎 Guest checked in</h2>` +
          `<p>Guest: <strong>${data.guestName}</strong></p>` +
          `<p>Room: <strong>${data.roomId}</strong></p>`,
      };

    case 'GUEST_CHECKED_OUT':
      return {
        subject: `👋 Guest checked out — Room ${data.roomId} — ${r}`,
        text:
          `👋 *Guest checked out*\n` +
          `Guest: ${data.guestName}\n` +
          `Room: ${data.roomId} · prepare for cleaning`,
        html:
          `<h2 style="color:#6b5d52">👋 Guest checked out</h2>` +
          `<p>Guest: <strong>${data.guestName}</strong></p>` +
          `<p>Room <strong>${data.roomId}</strong> — prepare for cleaning.</p>`,
      };

    /* ── Self-Registration Received (new owner self-registers) ──────── */

    case 'REGISTRATION_RECEIVED':
      return {
        subject: `✅ Registration Received — ${data.restaurantName || 'Your Restaurant'} | Atithi-Setu`,
        text:
          `Hello ${data.ownerName || 'there'},\n\n` +
          `Thank you for registering "${data.restaurantName || 'your restaurant'}" on Atithi-Setu!\n\n` +
          `📋 Your Registration Details:\n` +
          `Restaurant : ${data.restaurantName || '—'}\n` +
          `Restaurant ID: ${data.restaurantId || '—'}\n` +
          `Email      : ${data.email || '—'}\n\n` +
          `⏳ What happens next?\n` +
          `Our team will review your registration and activate your account within 24 hours.\n` +
          `You will receive another email with confirmation once your account is approved and ready to use.\n\n` +
          `For any questions, reply to this email.\n\n` +
          `— The Atithi-Setu Team`,
        html:
          `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">` +
          `<h2 style="color:#5A5A40;margin-top:0">✅ Registration Received!</h2>` +
          `<p>Hello <strong>${data.ownerName || 'there'}</strong>,</p>` +
          `<p>Thank you for registering <strong>${data.restaurantName || 'your restaurant'}</strong> on Atithi-Setu! Your registration has been received and is under review.</p>` +
          `<table style="border-collapse:collapse;width:100%;margin:16px 0">` +
          `<tr style="background:#f9fafb"><td style="padding:10px 14px;border:1px solid #e5e7eb;font-weight:600;width:40%">Restaurant</td><td style="padding:10px 14px;border:1px solid #e5e7eb">${data.restaurantName || '—'}</td></tr>` +
          `<tr><td style="padding:10px 14px;border:1px solid #e5e7eb;font-weight:600">Restaurant ID</td><td style="padding:10px 14px;border:1px solid #e5e7eb;font-family:monospace">${data.restaurantId || '—'}</td></tr>` +
          `<tr style="background:#f9fafb"><td style="padding:10px 14px;border:1px solid #e5e7eb;font-weight:600">Email</td><td style="padding:10px 14px;border:1px solid #e5e7eb">${data.email || '—'}</td></tr>` +
          `</table>` +
          `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:14px;margin:16px 0">` +
          `<strong>⏳ Pending Approval</strong><br>` +
          `<span style="color:#1e40af">Our team will review and activate your account within 24 hours. You will receive a confirmation email once approved.</span>` +
          `</div>` +
          `<p style="color:#6b7280;font-size:13px">For any questions, simply reply to this email.</p>` +
          `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">` +
          `<p style="color:#9ca3af;font-size:12px;margin:0">— The Atithi-Setu Team</p>` +
          `</div>`,
      };

    /* ── Account Approved (admin activates a pending registration) ───── */

    case 'ACCOUNT_APPROVED':
      return {
        subject: `🎉 Your Account is Approved — ${data.restaurantName || 'Your Restaurant'} is Live on Atithi-Setu!`,
        text:
          `Hello ${data.ownerName || 'there'},\n\n` +
          `Great news! Your Atithi-Setu account has been reviewed and approved.\n\n` +
          `🚀 You can now log in and start managing your restaurant:\n` +
          `Login URL: https://dev-erp.atithi-setu.com\n` +
          `Email    : ${data.email || '—'}\n` +
          `Restaurant: ${data.restaurantName || '—'}\n` +
          `Restaurant ID: ${data.restaurantId || '—'}\n\n` +
          `Use the email and password you set during registration to log in.\n\n` +
          `Welcome aboard! If you need any help getting started, reply to this email.\n\n` +
          `— The Atithi-Setu Team`,
        html:
          `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">` +
          `<h2 style="color:#5A5A40;margin-top:0">🎉 You're Approved!</h2>` +
          `<p>Hello <strong>${data.ownerName || 'there'}</strong>,</p>` +
          `<p>Great news — your Atithi-Setu account has been approved! Your restaurant is now live on the platform.</p>` +
          `<table style="border-collapse:collapse;width:100%;margin:16px 0">` +
          `<tr style="background:#f9fafb"><td style="padding:10px 14px;border:1px solid #e5e7eb;font-weight:600;width:40%">Restaurant</td><td style="padding:10px 14px;border:1px solid #e5e7eb">${data.restaurantName || '—'}</td></tr>` +
          `<tr><td style="padding:10px 14px;border:1px solid #e5e7eb;font-weight:600">Restaurant ID</td><td style="padding:10px 14px;border:1px solid #e5e7eb;font-family:monospace">${data.restaurantId || '—'}</td></tr>` +
          `<tr style="background:#f9fafb"><td style="padding:10px 14px;border:1px solid #e5e7eb;font-weight:600">Login Email</td><td style="padding:10px 14px;border:1px solid #e5e7eb">${data.email || '—'}</td></tr>` +
          `</table>` +
          `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:14px;margin:16px 0">` +
          `<strong>🚀 Ready to Go!</strong><br>` +
          `<span style="color:#166534">Log in with your registered email and password at </span>` +
          `<a href="https://dev-erp.atithi-setu.com" style="color:#166534">dev-erp.atithi-setu.com</a>` +
          `</div>` +
          `<p style="color:#6b7280;font-size:13px">Welcome to Atithi-Setu! We're excited to help you grow your restaurant business. If you need any assistance, reply to this email.</p>` +
          `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">` +
          `<p style="color:#9ca3af;font-size:12px;margin:0">— The Atithi-Setu Team</p>` +
          `</div>`,
      };

    /* ── Business Registration (admin-created accounts) ──────────────── */

    case 'BUSINESS_REGISTRATION':
      return {
        subject: `🎉 Welcome to Atithi-Setu — Your Restaurant Account is Ready!`,
        text:
          `🎉 *Welcome to Atithi-Setu!*\n\n` +
          `Your restaurant account has been successfully created.\n\n` +
          `📋 *Your Login Credentials:*\n` +
          `Restaurant: ${data.restaurantName || '—'}\n` +
          `Restaurant ID: ${data.restaurantId || '—'}\n` +
          `Login ID: ${data.loginId || '—'}\n` +
          `Password: ${data.password || '—'}\n\n` +
          `⚠️ Your account is pending activation. Our team will review and activate it shortly.\n\n` +
          `Once activated, you can log in at your dashboard and start managing your restaurant.\n\n` +
          `For support, reply to this email or contact us.\n\n` +
          `— The Atithi-Setu Team`,
        html:
          `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">` +
          `<h2 style="color:#5A5A40;margin-top:0">🎉 Welcome to Atithi-Setu!</h2>` +
          `<p>Your restaurant account has been successfully created. Here are your login credentials:</p>` +
          `<table style="border-collapse:collapse;width:100%;margin:16px 0">` +
          `<tr style="background:#f9fafb"><td style="padding:10px 14px;border:1px solid #e5e7eb;font-weight:600;width:40%">Restaurant</td><td style="padding:10px 14px;border:1px solid #e5e7eb">${data.restaurantName || '—'}</td></tr>` +
          `<tr><td style="padding:10px 14px;border:1px solid #e5e7eb;font-weight:600">Restaurant ID</td><td style="padding:10px 14px;border:1px solid #e5e7eb;font-family:monospace">${data.restaurantId || '—'}</td></tr>` +
          `<tr style="background:#f9fafb"><td style="padding:10px 14px;border:1px solid #e5e7eb;font-weight:600">Login ID</td><td style="padding:10px 14px;border:1px solid #e5e7eb;font-family:monospace">${data.loginId || '—'}</td></tr>` +
          `<tr><td style="padding:10px 14px;border:1px solid #e5e7eb;font-weight:600">Password</td><td style="padding:10px 14px;border:1px solid #e5e7eb;font-family:monospace">${data.password || '—'}</td></tr>` +
          `</table>` +
          `<div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:14px;margin:16px 0">` +
          `<strong>⚠️ Pending Activation</strong><br>` +
          `<span style="color:#92400e">Your account is currently pending activation. Our team will review it and activate it shortly. You will be able to log in once activated.</span>` +
          `</div>` +
          `<p style="color:#6b7280;font-size:13px">Please keep your credentials safe and do not share them. For support, reply to this email.</p>` +
          `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">` +
          `<p style="color:#9ca3af;font-size:12px;margin:0">— The Atithi-Setu Team</p>` +
          `</div>`,
      };

    /* ── Multi-platform Delivery Integration ──────────────────────────── */

    case 'NEW_PLATFORM_ORDER': {
      const items = (data.items as string[] | undefined)?.join(', ') || '—';
      const channel = data.channel || 'PLATFORM';
      const orderRef = data.invoiceNumber || data.orderId;
      const unmappedLine = Number(data.unmappedCount || 0) > 0
        ? `\n⚠️ ${data.unmappedCount} item(s) had no recipe mapping — see Inventory tab.`
        : '';
      return {
        subject: `🍱 ${channel} order ${orderRef} — ${r}`,
        text:
          `🍱 *New ${channel} Order*\n` +
          `Order: ${orderRef}\n` +
          `Customer: ${data.customerName || '—'} · ${data.customerPhone || '—'}\n` +
          `Address: ${data.address || '—'}\n` +
          `Items: ${items}\n` +
          `Total: ₹${data.total ?? '—'}\n` +
          `Payment: ${data.paymentMode || '—'}` +
          unmappedLine,
        html:
          `<h2 style="color:#cc5a16">🍱 New ${channel} Order</h2>` +
          `<table cellpadding="6" style="border-collapse:collapse;font-size:14px;">` +
          `<tr><td style="color:#6b5d52">Order</td><td><strong>${orderRef}</strong></td></tr>` +
          `<tr><td style="color:#6b5d52">Customer</td><td>${data.customerName || '—'} · ${data.customerPhone || '—'}</td></tr>` +
          `<tr><td style="color:#6b5d52">Address</td><td>${data.address || '—'}</td></tr>` +
          `<tr><td style="color:#6b5d52">Items</td><td>${items}</td></tr>` +
          `<tr><td style="color:#6b5d52">Total</td><td><strong>₹${data.total ?? '—'}</strong></td></tr>` +
          `<tr><td style="color:#6b5d52">Payment</td><td>${data.paymentMode || '—'}</td></tr>` +
          `</table>` +
          (Number(data.unmappedCount || 0) > 0
            ? `<p style="color:#d97706"><strong>⚠️ ${data.unmappedCount} item(s) had no recipe mapping</strong> — open the Inventory tab to map them.</p>`
            : ''),
      };
    }

    case 'PLATFORM_ORDER_CANCELLED':
      return {
        subject: `❌ ${data.channel || 'Platform'} order ${data.externalOrderId} cancelled — ${r}`,
        text:
          `❌ *${data.channel || 'Platform'} Order Cancelled*\n` +
          `External order: ${data.externalOrderId}\n` +
          `Local order: ${data.orderId}\n` +
          `Stock has been auto-restored.`,
        html:
          `<h2 style="color:#dc2626">❌ ${data.channel || 'Platform'} Order Cancelled</h2>` +
          `<p>External order <strong>${data.externalOrderId}</strong> (local <code>${data.orderId}</code>) cancelled.</p>` +
          `<p>Stock has been auto-restored to the inventory.</p>`,
      };

    case 'RIDER_ASSIGNED':
      return {
        subject: `🛵 Rider assigned for ${data.channel || 'platform'} order ${data.externalOrderId} — ${r}`,
        text:
          `🛵 *Rider Assigned*\n` +
          `${data.channel || 'Platform'} order: ${data.externalOrderId}\n` +
          `Rider: ${data.riderName || '—'}${data.riderPhone ? ' · ' + data.riderPhone : ''}\n` +
          `Hand over the order when they arrive.`,
        html:
          `<h2 style="color:#0E7490">🛵 Rider Assigned</h2>` +
          `<p>${data.channel || 'Platform'} order <strong>${data.externalOrderId}</strong></p>` +
          `<p>Rider: <strong>${data.riderName || '—'}</strong>${data.riderPhone ? ` · <a href="tel:${data.riderPhone}">${data.riderPhone}</a>` : ''}</p>`,
      };

    case 'ITEM_MAPPING_ALERT':
      return {
        subject: `⚠️ Unmapped items on ${data.channel || 'platform'} order — ${r}`,
        text:
          `⚠️ *Some items had no local mapping*\n` +
          `Channel: ${data.channel || '—'}\n` +
          `External order: ${data.externalOrderId || '—'}\n\n` +
          `Unmapped items:\n${(data.unmappedItems || []).map((s: string) => `  • ${s}`).join('\n')}\n\n` +
          `These items will not deduct ingredient stock. Map them in the Inventory tab → Recipes.`,
        html:
          `<h2 style="color:#d97706">⚠️ Unmapped Platform Items</h2>` +
          `<p>Channel: <strong>${data.channel || '—'}</strong>${data.externalOrderId ? ` · order <code>${data.externalOrderId}</code>` : ''}</p>` +
          `<p>The following items were received from the platform but have no matching menu item:</p>` +
          `<ul>${(data.unmappedItems || []).map((s: string) => `<li>${s}</li>`).join('')}</ul>` +
          `<p>Stock will not deduct for these items. Map them in <strong>Inventory → Recipes</strong>.</p>`,
      };

    case 'SYNC_JOB_DEAD':
      return {
        subject: `🔴 Sync to ${data.channel || 'platform'} failed (${data.jobType || 'job'}) — ${r}`,
        text:
          `🔴 *Outbound sync to ${data.channel || 'platform'} exhausted retries*\n` +
          `Job type: ${data.jobType || '—'}\n` +
          `Channel: ${data.channel || '—'}\n` +
          `Job id: ${data.jobId || '—'}\n` +
          `Last error: ${data.error || 'unknown'}\n\n` +
          `What to do:\n` +
          `  • Open Delivery Partners → Sync Health\n` +
          `  • Inspect the error and check the platform's status page\n` +
          `  • Click Retry once the platform is back, or rotate credentials if it's an auth error.`,
        html:
          `<h2 style="color:#dc2626">🔴 Outbound sync exhausted retries</h2>` +
          `<table cellpadding="6" style="border-collapse:collapse;font-size:14px;">` +
          `<tr><td style="color:#6b5d52">Channel</td><td><strong>${data.channel}</strong></td></tr>` +
          `<tr><td style="color:#6b5d52">Job type</td><td>${data.jobType}</td></tr>` +
          `<tr><td style="color:#6b5d52">Job id</td><td><code>${data.jobId}</code></td></tr>` +
          `<tr><td style="color:#6b5d52">Last error</td><td>${data.error || '—'}</td></tr>` +
          `</table>` +
          `<p>Open <strong>Delivery Partners → Sync Health</strong> and Retry once resolved, or rotate credentials if it's an auth error.</p>`,
      };

    case 'WEBHOOK_SIGNATURE_FAILURE':
      return {
        subject: `🛡️ Webhook signature failures on ${data.channel || 'platform'} — ${r}`,
        text:
          `🛡️ *Repeated webhook signature failures*\n` +
          `${data.count || '?'} failures on ${data.channel || 'platform'} in the last ${data.windowMinutes || '?'} minutes.\n\n` +
          `Possible causes:\n` +
          `  • HMAC secret was rotated by the platform — update credentials\n` +
          `  • Misconfigured webhook URL or wrong tenant id\n` +
          `  • Replay attack (less likely; requires a leaked secret)\n\n` +
          `Open Settings → Integrations → ${data.channel} to rotate credentials.`,
        html:
          `<h2 style="color:#dc2626">🛡️ Webhook Signature Failures</h2>` +
          `<p><strong>${data.count}</strong> failures on <strong>${data.channel}</strong> in the last ${data.windowMinutes} min.</p>` +
          `<p>Likely causes: rotated HMAC secret, misconfigured webhook URL, or replay attack.</p>` +
          `<p><a href="#" style="color:#cc5a16">Open Settings → Integrations → ${data.channel} to rotate credentials.</a></p>`,
      };

    /* ── Loyalty (tier-based) ─────────────────────────────────────────── */

    case 'LOYALTY_TIER_UPGRADED': {
      // Customer just crossed a tier threshold. WhatsApp + email.
      const name = data.customerName || data.name || 'Valued customer';
      const tier = data.tierName || 'a new tier';
      const pct = Number(data.discountPercent || 0);
      const totalSpent = Number(data.totalSpent || 0);
      return {
        subject: `🎉 Welcome to ${tier} at ${r}!`,
        text:
          `Hi ${name},\n\n` +
          `Great news — you've just been upgraded to ${tier} at ${r}.\n\n` +
          (pct > 0 ? `From your next visit, you'll automatically save ${pct}% on every order. ` : ``) +
          (data.perks ? `Plus: ${data.perks}\n\n` : `\n\n`) +
          `Lifetime spend so far: ₹${totalSpent.toLocaleString('en-IN')}\n\n` +
          `Thank you for being a loyal customer — see you again soon.\n` +
          `— The ${r} team`,
        html:
          `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">` +
          `<h2 style="color:#cc5a16;margin-top:0">🎉 Welcome to ${tier}!</h2>` +
          `<p>Hi <strong>${name}</strong>,</p>` +
          `<p>You've just been upgraded to <strong>${tier}</strong> at <strong>${r}</strong>.</p>` +
          (pct > 0 ? `<div style="background:#fef0e4;border:1px solid #fcd34d;border-radius:8px;padding:14px;margin:16px 0;text-align:center"><strong style="color:#cc5a16;font-size:22px">${pct}% OFF</strong><br><span style="color:#3d3128">automatically applied to every order, forever.</span></div>` : ``) +
          (data.perks ? `<p style="background:#f9fafb;padding:12px;border-radius:6px;color:#3d3128"><strong>Perks:</strong> ${data.perks}</p>` : ``) +
          `<p style="color:#6b5d52;font-size:13px">Lifetime spend so far: <strong>₹${totalSpent.toLocaleString('en-IN')}</strong></p>` +
          `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">` +
          `<p style="color:#9ca3af;font-size:12px;margin:0">Thank you for being a loyal customer — see you again soon.<br>— The ${r} team</p>` +
          `</div>`,
      };
    }

    case 'LOYALTY_REWARD_AVAILABLE': {
      // Generic "you have a discount ready" reminder. Used by phase 1.5
      // birthday rewards / re-engagement campaigns; safe to leave unused
      // until the owner wires up a custom trigger via notification_settings.
      const name = data.customerName || data.name || 'Valued customer';
      const tier = data.tierName || 'Loyalty';
      const pct = Number(data.discountPercent || 0);
      return {
        subject: `${tier} reward ready at ${r}`,
        text:
          `Hi ${name},\n\n` +
          (pct > 0
            ? `Your ${tier} discount of ${pct}% is ready to use on your next order at ${r}.\n\n`
            : `Your ${tier} reward is ready to use on your next visit to ${r}.\n\n`) +
          (data.message || `Just visit us — the discount is applied automatically when you order.`) +
          `\n\n— The ${r} team`,
        html:
          `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">` +
          `<h2 style="color:#cc5a16;margin-top:0">${tier} reward ready</h2>` +
          `<p>Hi <strong>${name}</strong>,</p>` +
          (pct > 0
            ? `<p>Your <strong>${tier} discount of ${pct}%</strong> is ready to use on your next order at <strong>${r}</strong>.</p>`
            : `<p>Your <strong>${tier} reward</strong> is ready to use on your next visit to <strong>${r}</strong>.</p>`) +
          `<p style="background:#f0fdf4;border:1px solid #d1fae5;border-radius:6px;padding:12px;color:#065f46;font-size:14px">${data.message || `Just visit us — the discount is applied automatically when you order.`}</p>` +
          `<p style="color:#9ca3af;font-size:12px;margin:0">— The ${r} team</p>` +
          `</div>`,
      };
    }

    /* ── Staff roster / shift events (Phase 3) ────────────────────────── */

    case 'SHIFT_ASSIGNED': {
      // Sent to the affected staff member when a new shift is published.
      const name = data.staff_name || 'Team';
      const date = data.shift_date
        ? new Date(data.shift_date).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })
        : 'an upcoming date';
      return {
        subject: `Shift assigned: ${date} at ${r}`,
        text:
          `Hi ${name},\n\n` +
          `You have a new shift scheduled at ${r}.\n\n` +
          `Date: ${date}\nTime: ${data.start_time}–${data.end_time}\n` +
          (data.notes ? `Notes: ${data.notes}\n` : '') +
          `\nSee you then!\n— ${r}`,
        html:
          `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">` +
          `<h2 style="color:#cc5a16;margin-top:0">New shift assigned</h2>` +
          `<p>Hi <strong>${name}</strong>,</p>` +
          `<p>You have a new shift scheduled at <strong>${r}</strong>.</p>` +
          `<table style="margin:12px 0"><tr><td><b>Date:</b></td><td>${date}</td></tr>` +
          `<tr><td><b>Time:</b></td><td>${data.start_time} – ${data.end_time}</td></tr>` +
          (data.notes ? `<tr><td><b>Notes:</b></td><td>${data.notes}</td></tr>` : '') +
          `</table>` +
          `<p style="color:#6b7280;font-size:12px">— ${r}</p>` +
          `</div>`,
      };
    }

    case 'SHIFT_UPDATED': {
      const name = data.staff_name || 'Team';
      const date = data.shift_date
        ? new Date(data.shift_date).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })
        : 'an upcoming date';
      return {
        subject: `Shift changed: ${date} at ${r}`,
        text:
          `Hi ${name},\n\n` +
          `Your shift at ${r} has been updated.\n\n` +
          `Date: ${date}\nNew time: ${data.start_time}–${data.end_time}\n` +
          `\nReply if you cannot make the new timing.\n— ${r}`,
        html:
          `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">` +
          `<h2 style="color:#cc5a16;margin-top:0">Shift updated</h2>` +
          `<p>Hi <strong>${name}</strong>,</p>` +
          `<p>Your shift at <strong>${r}</strong> has been updated.</p>` +
          `<table style="margin:12px 0"><tr><td><b>Date:</b></td><td>${date}</td></tr>` +
          `<tr><td><b>New time:</b></td><td>${data.start_time} – ${data.end_time}</td></tr></table>` +
          `<p style="color:#dc2626;font-size:13px"><b>Please reply if you cannot make the new timing.</b></p>` +
          `<p style="color:#6b7280;font-size:12px">— ${r}</p>` +
          `</div>`,
      };
    }

    case 'SHIFT_CANCELLED': {
      const name = data.staff_name || 'Team';
      const date = data.shift_date
        ? new Date(data.shift_date).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })
        : 'the scheduled date';
      return {
        subject: `Shift cancelled: ${date} at ${r}`,
        text:
          `Hi ${name},\n\n` +
          `Your shift on ${date} (${data.start_time}–${data.end_time}) at ${r} has been cancelled.\n\n` +
          `You don't need to come in.\n\n— ${r}`,
        html:
          `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">` +
          `<h2 style="color:#6b7280;margin-top:0">Shift cancelled</h2>` +
          `<p>Hi <strong>${name}</strong>,</p>` +
          `<p>Your shift on <strong>${date}</strong> (${data.start_time}–${data.end_time}) at <strong>${r}</strong> has been cancelled. You don't need to come in.</p>` +
          `<p style="color:#6b7280;font-size:12px">— ${r}</p>` +
          `</div>`,
      };
    }

    case 'SHIFT_REMINDER': {
      // Daily 8am IST cron — staff get a reminder of shifts in the next 12 hours.
      const name = data.staff_name || 'Team';
      const date = data.shift_date
        ? new Date(data.shift_date).toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'short' })
        : 'today';
      return {
        subject: `Reminder: shift today at ${r}`,
        text:
          `Hi ${name},\n\nQuick reminder — you're scheduled at ${r} today.\n\n` +
          `Date: ${date}\nTime: ${data.start_time}–${data.end_time}\n\nSee you soon!\n— ${r}`,
        html:
          `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">` +
          `<h2 style="color:#cc5a16;margin-top:0">Shift reminder</h2>` +
          `<p>Hi <strong>${name}</strong>,</p>` +
          `<p>Quick reminder — you're scheduled at <strong>${r}</strong> today.</p>` +
          `<p><b>${date}</b> · ${data.start_time} – ${data.end_time}</p>` +
          `<p style="color:#6b7280;font-size:12px">— ${r}</p>` +
          `</div>`,
      };
    }

    /* ── Loyalty v2 — birthdays, near-upgrade nudges ─────────────────── */

    case 'LOYALTY_BIRTHDAY_REWARD': {
      // Fired by the daily 09:00 IST birthday cron for every loyalty
      // customer whose DOB matches today. Soft promotional message —
      // owner can soft-couple this with a special promo code via
      // data.promo_code if they want (interpolated only when present).
      const name = data.customerName || data.name || 'Friend';
      const tier = data.tierName || 'Loyalty';
      const pct = Number(data.discountPercent || 0);
      const code = data.promo_code ? String(data.promo_code) : null;
      return {
        subject: `🎂 Happy birthday from ${r}!`,
        text:
          `Happy birthday, ${name}! 🎂\n\n` +
          `As one of our valued ${tier} customers, we wanted to wish you a wonderful day at ${r}.\n\n` +
          (pct > 0 ? `Your tier already gives you ${pct}% off every order — birthdays are always sweeter with that.\n\n` : '') +
          (code ? `For today, use code ${code} for an extra treat on us.\n\n` : '') +
          `See you soon!\n— The ${r} team`,
        html:
          `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #fde68a;border-radius:12px;background:#fffbeb">` +
          `<h2 style="color:#cc5a16;margin-top:0">🎂 Happy birthday, ${name}!</h2>` +
          `<p>As one of our valued <strong>${tier}</strong> customers, we wanted to wish you a wonderful day at <strong>${r}</strong>.</p>` +
          (pct > 0 ? `<p>Your tier already gives you <strong>${pct}% off</strong> every order — birthdays are always sweeter with that.</p>` : '') +
          (code ? `<p style="background:#fef3c7;border-radius:8px;padding:12px;font-size:15px"><b>Today's gift:</b> use code <strong style="font-family:monospace;font-size:16px">${code}</strong> at checkout.</p>` : '') +
          `<p style="margin-top:24px">See you soon!<br/><em>— The ${r} team</em></p>` +
          `</div>`,
      };
    }

    case 'LOYALTY_NEAR_UPGRADE': {
      // Sent weekly to customers within 20% of their next tier threshold.
      // Drives more spend by making the upgrade feel close.
      const name = data.customerName || data.name || 'Friend';
      const currentTier = data.currentTierName || data.tierName || 'Bronze';
      const nextTier = data.nextTierName || 'the next tier';
      const remaining = Number(data.spendRemaining || 0);
      const nextPct = Number(data.nextDiscountPercent || 0);
      const fmtAmt = remaining.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
      return {
        subject: `You're almost ${nextTier} at ${r}!`,
        text:
          `Hi ${name},\n\n` +
          `You're currently a ${currentTier} customer at ${r} — and just ₹${fmtAmt} away from reaching ${nextTier}.\n\n` +
          (nextPct > 0 ? `${nextTier} members get ${nextPct}% off every order, automatically.\n\n` : '') +
          `Drop by soon — we'd love to bump you up.\n\n— The ${r} team`,
        html:
          `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">` +
          `<h2 style="color:#cc5a16;margin-top:0">You're almost ${nextTier}!</h2>` +
          `<p>Hi <strong>${name}</strong>,</p>` +
          `<p>You're currently a <strong>${currentTier}</strong> customer at <strong>${r}</strong> — and just <strong>₹${fmtAmt}</strong> away from reaching <strong>${nextTier}</strong>.</p>` +
          (nextPct > 0 ? `<p style="background:#f0fdf4;border:1px solid #d1fae5;border-radius:8px;padding:12px;color:#065f46">${nextTier} members get <strong>${nextPct}% off</strong> every order, automatically.</p>` : '') +
          `<p>Drop by soon — we'd love to bump you up.</p>` +
          `<p style="color:#9ca3af;font-size:12px;margin:0">— The ${r} team</p>` +
          `</div>`,
      };
    }

    /* ── Subscription billing ─────────────────────────────────────────── */

    case 'PAYMENT_DUE_SOON': {
      // Sent N days before due date (typically 3). Friendly, no urgency.
      const dueDate = data.subscription_due_date
        ? new Date(data.subscription_due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
        : 'soon';
      const daysAhead = Number(data.days_until_due ?? 3);
      const amount = data.amount_due ? `₹${Number(data.amount_due).toLocaleString('en-IN')}` : 'your subscription fee';
      return {
        subject: `Subscription renewal due ${daysAhead === 0 ? 'today' : `in ${daysAhead} day${daysAhead === 1 ? '' : 's'}`} — ${r}`,
        text:
          `Hi ${r} team,\n\n` +
          `This is a friendly reminder that your Atithi-Setu subscription renewal is due ${daysAhead === 0 ? 'today' : `on ${dueDate}`}.\n\n` +
          `Amount due: ${amount}\n` +
          `Due date: ${dueDate}\n\n` +
          `To avoid any service interruption, please complete payment by the due date.\n\n` +
          `Need help or have questions?\n` +
          `📧 billing@atithi-setu.com\n` +
          `💬 WhatsApp +91 70111 89371\n\n` +
          `Thank you for being part of Atithi-Setu.\n— The Atithi-Setu Billing Team`,
        html:
          `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">` +
          `<h2 style="color:#0f766e;margin-top:0">Subscription renewal reminder</h2>` +
          `<p>Hi <strong>${r}</strong> team,</p>` +
          `<p>This is a friendly reminder that your Atithi-Setu subscription renewal is due ${daysAhead === 0 ? 'today' : `in <strong>${daysAhead} day${daysAhead === 1 ? '' : 's'}</strong>`}.</p>` +
          `<table style="border-collapse:collapse;width:100%;margin:16px 0">` +
          `<tr style="background:#f0fdf4"><td style="padding:10px 14px;border:1px solid #d1fae5;font-weight:600">Amount due</td><td style="padding:10px 14px;border:1px solid #d1fae5">${amount}</td></tr>` +
          `<tr><td style="padding:10px 14px;border:1px solid #d1fae5;font-weight:600">Due date</td><td style="padding:10px 14px;border:1px solid #d1fae5">${dueDate}</td></tr>` +
          `</table>` +
          `<p>To avoid any service interruption, please complete payment by the due date.</p>` +
          `<div style="background:#f0fdf4;border:1px solid #d1fae5;border-radius:6px;padding:14px;margin:16px 0">` +
          `<strong>Need help?</strong><br>` +
          `📧 <a href="mailto:billing@atithi-setu.com">billing@atithi-setu.com</a><br>` +
          `💬 WhatsApp <a href="https://wa.me/917011189371">+91 70111 89371</a>` +
          `</div>` +
          `<p style="color:#9ca3af;font-size:12px;margin:0">— The Atithi-Setu Billing Team</p>` +
          `</div>`,
      };
    }

    case 'PAYMENT_OVERDUE': {
      // Sent daily once payment is past due but not yet revoked.
      const dueDate = data.subscription_due_date
        ? new Date(data.subscription_due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
        : 'a recent date';
      const daysPast = Number(data.days_past_due ?? 0);
      const daysUntilSuspension = Number(data.days_until_suspension ?? 0);
      const isFinalNotice = daysUntilSuspension <= 1;
      return {
        subject: isFinalNotice
          ? `Final notice — service will be limited to read-only soon (${r})`
          : `Payment overdue — please complete payment to avoid service interruption (${r})`,
        text:
          `Hi ${r} team,\n\n` +
          (isFinalNotice
            ? `Final notice: your subscription payment was due on ${dueDate} and is now ${daysPast} days past due.\n\n` +
              `If payment is not received within the next ${Math.max(daysUntilSuspension, 0)} day${daysUntilSuspension === 1 ? '' : 's'}, your account will be moved to read-only mode. ` +
              `You will still be able to view, export and download your data, but creating, editing and deleting will be paused until payment is received.\n\n`
            : `Our records show your subscription payment was due on ${dueDate} and is now ${daysPast} day${daysPast === 1 ? '' : 's'} past due.\n\n` +
              `Service is continuing uninterrupted while we wait for payment. After ${daysUntilSuspension} more day${daysUntilSuspension === 1 ? '' : 's'}, the account may be moved to read-only mode.\n\n`) +
          `Your data is safe and will remain accessible throughout.\n\n` +
          `Please complete payment or contact us:\n` +
          `📧 billing@atithi-setu.com\n` +
          `💬 WhatsApp +91 70111 89371\n\n` +
          `Thank you,\n— The Atithi-Setu Billing Team`,
        html:
          `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">` +
          `<h2 style="color:${isFinalNotice ? '#b91c1c' : '#b45309'};margin-top:0">${isFinalNotice ? 'Final notice — subscription overdue' : 'Subscription payment overdue'}</h2>` +
          `<p>Hi <strong>${r}</strong> team,</p>` +
          `<p>${isFinalNotice
            ? `Final notice: your subscription payment was due on <strong>${dueDate}</strong> and is now <strong>${daysPast} days past due</strong>.`
            : `Our records show your subscription payment was due on <strong>${dueDate}</strong> and is now <strong>${daysPast} day${daysPast === 1 ? '' : 's'} past due</strong>.`}</p>` +
          `<div style="background:${isFinalNotice ? '#fef2f2' : '#fffbeb'};border:1px solid ${isFinalNotice ? '#fecaca' : '#fcd34d'};border-radius:6px;padding:14px;margin:16px 0">` +
          (isFinalNotice
            ? `<strong>What happens next:</strong><br>If payment is not received within the next <strong>${Math.max(daysUntilSuspension, 0)} day${daysUntilSuspension === 1 ? '' : 's'}</strong>, your account will be moved to <strong>read-only mode</strong>. You'll still be able to view, export and download your data; creating, editing and deleting will be paused until payment is received. <strong>Your data is safe.</strong>`
            : `Service is continuing uninterrupted. After <strong>${daysUntilSuspension} more day${daysUntilSuspension === 1 ? '' : 's'}</strong> the account may be moved to read-only mode. Your data remains safe and accessible.`) +
          `</div>` +
          `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:14px;margin:16px 0">` +
          `<strong>To complete payment or get help:</strong><br>` +
          `📧 <a href="mailto:billing@atithi-setu.com">billing@atithi-setu.com</a><br>` +
          `💬 WhatsApp <a href="https://wa.me/917011189371">+91 70111 89371</a>` +
          `</div>` +
          `<p style="color:#9ca3af;font-size:12px;margin:0">— The Atithi-Setu Billing Team</p>` +
          `</div>`,
      };
    }

    case 'ACCESS_REVOKED': {
      // Sent when admin manually revokes access (read-only mode begins).
      const reason = data.reason || 'Subscription payment overdue';
      return {
        subject: `Your account is now in read-only mode — ${r}`,
        text:
          `Hi ${r} team,\n\n` +
          `Your Atithi-Setu account has been moved to read-only mode while we process your subscription payment.\n\n` +
          `What this means:\n` +
          `✓ You can still view, export and download all your data\n` +
          `✓ Reports and historical data remain accessible\n` +
          `⏸ Creating, editing and deleting are paused\n\n` +
          `Your data is safe. The moment payment is received, full access resumes — nothing is deleted or hidden.\n\n` +
          `Reason: ${reason}\n\n` +
          `To restore service, please reach out:\n` +
          `📧 billing@atithi-setu.com\n` +
          `💬 WhatsApp +91 70111 89371\n\n` +
          `We typically respond within 2 hours during IST business hours.\n\n` +
          `— The Atithi-Setu Billing Team`,
        html:
          `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">` +
          `<h2 style="color:#b91c1c;margin-top:0">Account moved to read-only mode</h2>` +
          `<p>Hi <strong>${r}</strong> team,</p>` +
          `<p>Your Atithi-Setu account has been moved to <strong>read-only mode</strong> while we process your subscription payment.</p>` +
          `<table style="border-collapse:collapse;width:100%;margin:16px 0">` +
          `<tr style="background:#f0fdf4"><td style="padding:10px 14px;border:1px solid #d1fae5;width:60%">✓ View all data</td><td style="padding:10px 14px;border:1px solid #d1fae5;color:#059669;font-weight:600">Available</td></tr>` +
          `<tr style="background:#f0fdf4"><td style="padding:10px 14px;border:1px solid #d1fae5">✓ Export &amp; download data</td><td style="padding:10px 14px;border:1px solid #d1fae5;color:#059669;font-weight:600">Available</td></tr>` +
          `<tr style="background:#f0fdf4"><td style="padding:10px 14px;border:1px solid #d1fae5">✓ Reports and historical data</td><td style="padding:10px 14px;border:1px solid #d1fae5;color:#059669;font-weight:600">Available</td></tr>` +
          `<tr style="background:#fef2f2"><td style="padding:10px 14px;border:1px solid #fecaca">⏸ Create / edit / delete</td><td style="padding:10px 14px;border:1px solid #fecaca;color:#b91c1c;font-weight:600">Paused</td></tr>` +
          `</table>` +
          `<div style="background:#f0fdf4;border:1px solid #d1fae5;border-radius:6px;padding:14px;margin:16px 0">` +
          `<strong style="color:#059669">Your data is safe.</strong> The moment payment is received, full access resumes — nothing is deleted or hidden.` +
          `</div>` +
          `<p style="background:#f9fafb;padding:10px 14px;border-radius:6px;color:#6b7280;font-size:13px"><strong>Reason:</strong> ${reason}</p>` +
          `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:14px;margin:16px 0">` +
          `<strong>To restore service:</strong><br>` +
          `📧 <a href="mailto:billing@atithi-setu.com">billing@atithi-setu.com</a><br>` +
          `💬 WhatsApp <a href="https://wa.me/917011189371">+91 70111 89371</a><br>` +
          `<span style="color:#6b7280;font-size:13px;margin-top:6px;display:inline-block">We typically respond within 2 hours during IST business hours.</span>` +
          `</div>` +
          `<p style="color:#9ca3af;font-size:12px;margin:0">— The Atithi-Setu Billing Team</p>` +
          `</div>`,
      };
    }

    case 'ACCESS_RESTORED': {
      // Sent the moment admin clicks "Restore access".
      const restoredAt = data.restored_at
        ? new Date(data.restored_at).toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' })
        : new Date().toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' });
      return {
        subject: `Welcome back — your account is fully active again (${r})`,
        text:
          `Hi ${r} team,\n\n` +
          `Good news — your Atithi-Setu account is fully active again.\n\n` +
          `Restored at: ${restoredAt}\n\n` +
          `All features are now available. You can create, edit and manage your operations as normal. ` +
          `Thank you for completing your payment and for being part of Atithi-Setu.\n\n` +
          `Tip: keep your billing email and WhatsApp up to date in Settings → Account so you receive future reminders before due date.\n\n` +
          `Questions or feedback?\n` +
          `📧 billing@atithi-setu.com\n` +
          `💬 WhatsApp +91 70111 89371\n\n` +
          `— The Atithi-Setu Billing Team`,
        html:
          `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">` +
          `<h2 style="color:#059669;margin-top:0">Welcome back — account fully active</h2>` +
          `<p>Hi <strong>${r}</strong> team,</p>` +
          `<p>Good news — your Atithi-Setu account is <strong>fully active again</strong>. All features are available immediately.</p>` +
          `<div style="background:#f0fdf4;border:1px solid #d1fae5;border-radius:6px;padding:14px;margin:16px 0">` +
          `<strong style="color:#059669">Restored at:</strong> ${restoredAt}<br>` +
          `<span style="color:#065f46">You can create, edit and manage your operations as normal.</span>` +
          `</div>` +
          `<p>Thank you for completing your payment and for being part of Atithi-Setu.</p>` +
          `<p style="background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:12px 14px;color:#92400e;font-size:13px"><strong>Tip:</strong> keep your billing email and WhatsApp up to date in <em>Settings → Account</em> so you receive future reminders before the due date.</p>` +
          `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:14px;margin:16px 0">` +
          `<strong>Questions or feedback:</strong><br>` +
          `📧 <a href="mailto:billing@atithi-setu.com">billing@atithi-setu.com</a><br>` +
          `💬 WhatsApp <a href="https://wa.me/917011189371">+91 70111 89371</a>` +
          `</div>` +
          `<p style="color:#9ca3af;font-size:12px;margin:0">— The Atithi-Setu Billing Team</p>` +
          `</div>`,
      };
    }

    /* ── Default fallback ─────────────────────────────────────────────── */

    default:
      return {
        subject: `📢 ${r}: ${eventName.replace(/_/g, ' ')}`,
        text:    `Event: ${eventName}\n${JSON.stringify(data, null, 2)}`,
        html:    `<h2>${eventName.replace(/_/g, ' ')}</h2><pre>${JSON.stringify(data, null, 2)}</pre>`,
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// sendSMS  — Twilio
// ─────────────────────────────────────────────────────────────────────────────
export async function sendSMS(to: string, message: string): Promise<void> {
  if (!twilioClient) {
    console.warn('[Notification] Twilio not configured — skipping SMS.');
    return;
  }
  try {
    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to:   toE164(to),
    });
    console.log(`[Notification] SMS sent → ${to}`);
  } catch (err) {
    console.error('[Notification] SMS send failed:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// sendWhatsApp  — Meta Cloud API
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages
// ─────────────────────────────────────────────────────────────────────────────
export async function sendWhatsApp(to: string, message: string): Promise<void> {
  if (!META_WA_ACCESS_TOKEN || !META_WA_PHONE_NUMBER_ID) {
    console.warn('[Notification] Meta WhatsApp API not configured — skipping WhatsApp.');
    return;
  }
  try {
    const phone = toE164(to);
    const url   = `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_WA_PHONE_NUMBER_ID}/messages`;

    const response = await fetch(url, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${META_WA_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to:                phone,
        type:              'text',
        text: { preview_url: false, body: message },
      }),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      console.error('[Notification] Meta WhatsApp API error:', JSON.stringify(errBody));
    } else {
      console.log(`[Notification] WhatsApp sent → ${phone} (Meta Cloud API)`);
    }
  } catch (err) {
    console.error('[Notification] WhatsApp (Meta) send failed:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// sendTelegram  — Telegram Bot API
// Docs: https://core.telegram.org/bots/api#sendmessage
// chatId can be a numeric user/group ID or a public channel username (@mychannel)
// ─────────────────────────────────────────────────────────────────────────────
export async function sendTelegram(chatId: string | null | undefined, message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('[Notification] Telegram bot token not configured — skipping.');
    return;
  }
  const targetChatId = chatId || TELEGRAM_DEFAULT_CHAT_ID;
  if (!targetChatId) {
    console.warn('[Notification] No Telegram chat ID specified — skipping.');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    targetChatId,
        text:       message,
        parse_mode: 'Markdown',
      }),
    });
    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      console.error('[Notification] Telegram API error:', JSON.stringify(errBody));
    } else {
      console.log(`[Notification] Telegram message sent → chat ${targetChatId}`);
    }
  } catch (err) {
    console.error('[Notification] Telegram send failed:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// sendEmail  — SMTP / Nodemailer
// ─────────────────────────────────────────────────────────────────────────────
export interface EmailAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

export async function sendEmail(
  to:          string,
  subject:     string,
  text:        string,
  html?:       string,
  attachments?: EmailAttachment[]
): Promise<boolean> {
  if (!mailTransporter) {
    console.warn('[Notification] SMTP not configured — skipping email.');
    return false;
  }
  try {
    // Always BCC the configured SMTP account so the owner gets a copy of every notification.
    // Skip BCC if the recipient is already the SMTP user (avoid duplicate).
    const smtpUser = process.env.SMTP_USER;
    const bcc = smtpUser && smtpUser.toLowerCase() !== to.toLowerCase() ? smtpUser : undefined;
    await mailTransporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      bcc,
      subject,
      text,
      html,
      attachments: attachments && attachments.length > 0
        ? attachments.map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType }))
        : undefined,
    });
    console.log(`[Notification] Email sent → ${to}${bcc ? ` (bcc: ${bcc})` : ''}${attachments?.length ? ` +${attachments.length} attachment(s)` : ''}`);
    return true;
  } catch (err) {
    console.error('[Notification] Email send failed:', err);
    return false;
  }
}
