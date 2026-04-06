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

    case 'ORDER_PLACED':
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

    /* ── Business Registration ────────────────────────────────────────── */

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
export async function sendEmail(
  to:       string,
  subject:  string,
  text:     string,
  html?:    string
): Promise<void> {
  if (!mailTransporter) {
    console.warn('[Notification] SMTP not configured — skipping email.');
    return;
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
    });
    console.log(`[Notification] Email sent → ${to}${bcc ? ` (bcc: ${bcc})` : ''}`);
  } catch (err) {
    console.error('[Notification] Email send failed:', err);
  }
}
