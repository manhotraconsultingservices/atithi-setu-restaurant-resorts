/**
 * Atithi Setu — Events & Convention quotation (BEO) PDF generator.
 *
 * Self-contained pdfkit renderer for an event quotation. Deliberately kept
 * independent of the hotel invoice templates so it carries zero coupling to the
 * hotel billing module — a single clean A4 quotation the tenant emails to a
 * prospective customer.
 */

import PDFDocument from 'pdfkit';

export interface EventQuotationLine {
  line_type: string;
  description: string;
  quantity: number;
  unit_rate: number;
  amount: number;
  gst_rate: number;
  gst_amount: number;
}

export interface EventQuotationData {
  tenant: { name: string; address?: string; gstin?: string; phone?: string; email?: string; currency?: string };
  quotation: { quote_number: string; version: number; valid_until?: string; notes?: string; created_at?: string };
  docLabel?: string;  // header label; defaults to 'QUOTATION'. Pass 'TAX INVOICE' to render an invoice.
  booking: {
    customer_name: string; customer_phone?: string; customer_email?: string;
    event_type?: string; event_date?: string; end_date?: string;
    start_time?: string; end_time?: string; guest_count?: number; venue_name?: string;
  };
  lines: EventQuotationLine[];
  subtotal: number;
  tax_amount: number;
  discount: number;
  grand_total: number;
}

const INK = '#1f2937';
const MUTED = '#6b7280';
const HAIR = '#e5e7eb';
const ACCENT = '#7c3aed';
const BAND = '#f5f3ff';

function fmtMoney(n: number, cur = 'INR'): string {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const s = v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // NOTE: pdfkit's standard Helvetica uses WinAnsi encoding, which has NO ₹
  // (U+20B9) glyph — emitting it throws and the whole PDF 500s. Use the ASCII
  // "Rs." prefix (same fix the hotel invoice templates use). Do not reintroduce ₹.
  return `${cur === 'INR' ? 'Rs. ' : cur + ' '}${s}`;
}

/**
 * Normalize any date-like value to a YYYY-MM-DD string.
 * CRITICAL: pg returns DATE/TIMESTAMP columns (event dates, created_at,
 * valid_until) as JS **Date objects**, which have no `.slice` — calling
 * `.slice(0,10)` on one throws `TypeError: .slice is not a function` and 500s
 * the whole quotation PDF. Always route date values through this helper before
 * rendering.
 */
function ymd(v: any): string {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/**
 * Make a string safe to render with Helvetica's WinAnsi (Windows-1252) encoding.
 * Characters outside Latin-1 render as `.notdef` boxes (and, in some pdfkit
 * builds, can throw). We only ship a Latin font here, so map the few non-Latin
 * glyphs our own composed descriptions can contain to ASCII equivalents.
 */
function waSafe(s: any): string {
  return String(s ?? '')
    .replace(/→/g, ' to ')  // → arrow (hotel-room date ranges)
    .replace(/₹/g, 'Rs.');  // ₹ (belt-and-suspenders; fmtMoney already avoids it)
}

function lineTypeLabel(t: string): string {
  switch (t) {
    case 'VENUE': return 'Venue';
    case 'RENTAL': return 'Rental';
    case 'SERVICE': return 'Service';
    case 'HOTEL_ROOM': return 'Hotel Room';
    case 'FNB': return 'Food & Beverage';
    default: return 'Item';
  }
}

export async function generateEventQuotationPdf(data: EventQuotationData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 0,
        info: {
          Title: `Quotation ${data.quotation.quote_number}`,
          Author: data.tenant.name,
          Subject: `Event quotation for ${data.booking.customer_name}`,
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      const cur = data.tenant.currency || 'INR';
      const PAGE_W = 595.28;
      const M = 42;
      const INNER = PAGE_W - M * 2;
      let y = M;

      // ── Header band ──────────────────────────────────────────────────────
      doc.rect(0, 0, PAGE_W, 96).fill(BAND);
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text(waSafe(data.tenant.name), M, 24, { width: INNER - 160 });
      doc.font('Helvetica').fontSize(9).fillColor(MUTED);
      let hy = 48;
      if (data.tenant.address) { doc.text(waSafe(data.tenant.address), M, hy, { width: INNER - 170 }); hy += 12; }
      const contactBits = [data.tenant.phone, data.tenant.email].filter(Boolean).join('  ·  ');
      if (contactBits) { doc.text(contactBits, M, hy, { width: INNER - 170 }); hy += 12; }
      if (data.tenant.gstin) doc.text(`GSTIN: ${data.tenant.gstin}`, M, hy, { width: INNER - 170 });

      // Quotation title block (right)
      doc.font('Helvetica-Bold').fontSize(16).fillColor(ACCENT).text(waSafe(data.docLabel || 'QUOTATION'), M, 24, { width: INNER, align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor(INK);
      doc.text(`No: ${data.quotation.quote_number}  (v${data.quotation.version})`, M, 48, { width: INNER, align: 'right' });
      const issued = ymd(data.quotation.created_at) || new Date().toISOString().slice(0, 10);
      doc.text(`Date: ${issued}`, M, 60, { width: INNER, align: 'right' });
      if (data.quotation.valid_until) doc.text(`Valid until: ${ymd(data.quotation.valid_until)}`, M, 72, { width: INNER, align: 'right' });

      y = 118;

      // ── Customer + event details ─────────────────────────────────────────
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('Prepared For', M, y);
      doc.font('Helvetica-Bold').fontSize(10).text('Event Details', M + INNER / 2, y);
      y += 15;
      doc.font('Helvetica').fontSize(9).fillColor(INK);
      const leftLines = [
        waSafe(data.booking.customer_name),
        data.booking.customer_phone || '',
        data.booking.customer_email || '',
      ].filter(Boolean);
      const b = data.booking;
      const evStart = ymd(b.event_date);
      const evEnd = ymd(b.end_date);
      const dateStr = evStart ? (evEnd && evEnd !== evStart ? `${evStart} to ${evEnd}` : evStart) : '';
      const rightLines = [
        b.venue_name ? `Venue: ${waSafe(b.venue_name)}` : '',
        b.event_type ? `Type: ${waSafe(b.event_type)}` : '',
        dateStr ? `Date: ${dateStr}` : '',
        (b.start_time || b.end_time) ? `Time: ${b.start_time || ''}-${b.end_time || ''}` : '',
        b.guest_count ? `Guests: ${b.guest_count}` : '',
      ].filter(Boolean);
      const rowsCount = Math.max(leftLines.length, rightLines.length);
      for (let i = 0; i < rowsCount; i++) {
        if (leftLines[i]) doc.text(leftLines[i], M, y + i * 12, { width: INNER / 2 - 10 });
        if (rightLines[i]) doc.text(rightLines[i], M + INNER / 2, y + i * 12, { width: INNER / 2 });
      }
      y += rowsCount * 12 + 16;

      // ── Line-item table ──────────────────────────────────────────────────
      const cols = { type: M, desc: M + 70, qty: M + 300, rate: M + 350, amt: M + 430 };
      doc.rect(M, y, INNER, 20).fill(ACCENT);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5);
      doc.text('TYPE', cols.type + 4, y + 6);
      doc.text('DESCRIPTION', cols.desc, y + 6);
      doc.text('QTY', cols.qty, y + 6, { width: 40, align: 'right' });
      doc.text('RATE', cols.rate, y + 6, { width: 70, align: 'right' });
      doc.text('AMOUNT', cols.amt, y + 6, { width: INNER - (cols.amt - M) - 4, align: 'right' });
      y += 20;

      doc.font('Helvetica').fontSize(8.5).fillColor(INK);
      for (const ln of data.lines) {
        const desc = waSafe(ln.description || '');
        const descH = doc.heightOfString(desc, { width: 220 });
        const rowH = Math.max(18, descH + 8);
        if (y + rowH > 720) { doc.addPage(); y = M; }
        doc.fillColor(MUTED).fontSize(7.5).text(lineTypeLabel(ln.line_type), cols.type + 4, y + 5, { width: 64 });
        doc.fillColor(INK).fontSize(8.5).text(desc, cols.desc, y + 5, { width: 220 });
        doc.text(String(ln.quantity ?? 1), cols.qty, y + 5, { width: 40, align: 'right' });
        doc.text(fmtMoney(ln.unit_rate, cur), cols.rate, y + 5, { width: 70, align: 'right' });
        doc.text(fmtMoney(ln.amount, cur), cols.amt, y + 5, { width: INNER - (cols.amt - M) - 4, align: 'right' });
        y += rowH;
        doc.moveTo(M, y).lineTo(M + INNER, y).lineWidth(0.5).strokeColor(HAIR).stroke();
      }

      // ── Totals ───────────────────────────────────────────────────────────
      y += 10;
      const totX = M + INNER - 220;
      const totW = 220;
      const totalRow = (label: string, val: string, bold = false) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10.5 : 9).fillColor(INK);
        doc.text(label, totX, y, { width: totW - 90 });
        doc.text(val, totX + totW - 90, y, { width: 90, align: 'right' });
        y += bold ? 18 : 14;
      };
      totalRow('Subtotal', fmtMoney(data.subtotal, cur));
      if (data.discount > 0) totalRow('Discount', `- ${fmtMoney(data.discount, cur)}`);
      totalRow('GST', fmtMoney(data.tax_amount, cur));
      doc.moveTo(totX, y + 2).lineTo(totX + totW, y + 2).lineWidth(1).strokeColor(ACCENT).stroke();
      y += 6;
      totalRow('Grand Total', fmtMoney(data.grand_total, cur), true);

      // ── Notes + footer ───────────────────────────────────────────────────
      y += 18;
      if (data.quotation.notes) {
        const notes = waSafe(data.quotation.notes);
        doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('Notes', M, y);
        y += 13;
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(notes, M, y, { width: INNER });
        y += doc.heightOfString(notes, { width: INNER }) + 12;
      }
      const isInvoice = /INVOICE/i.test(data.docLabel || '');
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED).text(
        isInvoice
          ? 'Thank you for your business.'
          : 'This is a quotation, not a tax invoice. Prices are indicative and subject to availability at time of confirmation.',
        M, Math.max(y, 770), { width: INNER, align: 'center' }
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Banquet Event Order (BEO) / function sheet — the operations run-sheet handed
// to the kitchen / venue team. Distinct from the customer quotation: it focuses
// on WHAT to set up and WHO owes WHAT, not on selling.
// ─────────────────────────────────────────────────────────────────────────────
export interface EventBEOData {
  tenant: { name: string; phone?: string; email?: string };
  booking: {
    id: string; status?: string; customer_name: string; customer_phone?: string; customer_email?: string;
    event_type?: string; event_date?: any; end_date?: any; start_time?: string; end_time?: string;
    guest_count?: number; venue_name?: string; special_requests?: string;
  };
  catering: Array<{ name: string; package_type?: string; pax?: number; menu?: Array<{ section: string; options: string[] }> }>;
  rentals: Array<{ name: string; quantity?: number; rate_basis?: string }>;
  services: Array<{ name: string; quantity?: number }>;
  rooms: Array<{ room_type: string; num_rooms?: number; check_in?: any; check_out?: any }>;
  schedule: Array<{ label: string; due_date?: any; amount?: number; status?: string }>;
  totals: { grand_total: number; paid: number; balance: number };
}

export async function generateEventBEOPdf(data: EventBEOData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `BEO ${data.booking.id}`, Author: data.tenant.name } });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      const PAGE_W = 595.28;
      const M = 42;
      const INNER = PAGE_W - M * 2;
      let y = M;

      const b = data.booking;
      // Header
      doc.rect(0, 0, PAGE_W, 88).fill(BAND);
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text(waSafe(data.tenant.name), M, 22, { width: INNER - 150 });
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text([data.tenant.phone, data.tenant.email].filter(Boolean).join('  ·  '), M, 46, { width: INNER - 150 });
      doc.font('Helvetica-Bold').fontSize(15).fillColor(ACCENT).text('BANQUET EVENT ORDER', M, 24, { width: INNER, align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor(INK).text(`Ref: ${b.id}`, M, 48, { width: INNER, align: 'right' });
      if (b.status) doc.text(`Status: ${b.status}`, M, 60, { width: INNER, align: 'right' });
      y = 104;

      const sectionTitle = (t: string) => {
        if (y > 760) { doc.addPage(); y = M; }
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(ACCENT).text(waSafe(t), M, y); y += 15;
        doc.moveTo(M, y - 2).lineTo(M + INNER, y - 2).lineWidth(0.5).strokeColor(HAIR).stroke();
      };
      const kv = (k: string, v: string) => {
        doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(waSafe(k), M, y, { width: 110, continued: false });
        doc.font('Helvetica').fontSize(9).fillColor(INK).text(waSafe(v || '—'), M + 115, y, { width: INNER - 115 });
        y += 14;
      };
      const bullet = (t: string) => {
        if (y > 780) { doc.addPage(); y = M; }
        doc.font('Helvetica').fontSize(9).fillColor(INK).text(`•  ${waSafe(t)}`, M + 6, y, { width: INNER - 12 });
        y += 13;
      };

      // Event summary
      sectionTitle('Event Summary');
      const dateStr = ymd(b.event_date) + (b.end_date && ymd(b.end_date) > ymd(b.event_date) ? ` to ${ymd(b.end_date)}` : '');
      kv('Customer', b.customer_name);
      kv('Contact', [b.customer_phone, b.customer_email].filter(Boolean).join('  ·  '));
      kv('Event type', b.event_type || '—');
      kv('Date', dateStr);
      kv('Time', `${b.start_time || ''}-${b.end_time || ''}`);
      kv('Venue', b.venue_name || '—');
      kv('Guests', String(b.guest_count ?? '—'));
      y += 6;

      // Catering
      if (data.catering.length) {
        sectionTitle('Catering');
        for (const c of data.catering) {
          doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(`${waSafe(c.name)} (${c.package_type || 'BUFFET'}) — ${c.pax ?? 0} pax`, M, y); y += 13;
          for (const s of (c.menu || [])) bullet(`${s.section}: ${(s.options || []).join(', ')}`);
          y += 4;
        }
      }

      // Rentals
      if (data.rentals.length) {
        sectionTitle('Rentals / Equipment');
        for (const r of data.rentals) bullet(`${r.name} × ${r.quantity ?? 1}${r.rate_basis ? ` (${r.rate_basis})` : ''}`);
        y += 4;
      }

      // Services
      if (data.services.length) {
        sectionTitle('Services / Staffing');
        for (const s of data.services) bullet(`${s.name} × ${s.quantity ?? 1}`);
        y += 4;
      }

      // Hotel rooms
      if (data.rooms.length) {
        sectionTitle('Hotel Rooms');
        for (const rm of data.rooms) bullet(`${rm.room_type} × ${rm.num_rooms ?? 1} (${ymd(rm.check_in)} to ${ymd(rm.check_out)})`);
        y += 4;
      }

      // Special requests
      if (b.special_requests) {
        sectionTitle('Special Requests');
        doc.font('Helvetica').fontSize(9).fillColor(INK).text(waSafe(b.special_requests), M, y, { width: INNER });
        y += doc.heightOfString(waSafe(b.special_requests), { width: INNER }) + 8;
      }

      // Payment status
      sectionTitle('Payment Status');
      kv('Grand total', fmtMoney(data.totals.grand_total));
      kv('Received', fmtMoney(data.totals.paid));
      kv('Balance', fmtMoney(data.totals.balance));
      for (const s of data.schedule) {
        bullet(`${s.label} — ${fmtMoney(Number(s.amount || 0))} due ${ymd(s.due_date) || '—'} [${s.status || 'DUE'}]`);
      }

      doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED).text('Operations run-sheet — internal use.', M, Math.max(y + 10, 800), { width: INNER, align: 'center' });
      doc.end();
    } catch (err) { reject(err); }
  });
}
