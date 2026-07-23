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
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text(data.tenant.name, M, 24, { width: INNER - 160 });
      doc.font('Helvetica').fontSize(9).fillColor(MUTED);
      let hy = 48;
      if (data.tenant.address) { doc.text(data.tenant.address, M, hy, { width: INNER - 170 }); hy += 12; }
      const contactBits = [data.tenant.phone, data.tenant.email].filter(Boolean).join('  ·  ');
      if (contactBits) { doc.text(contactBits, M, hy, { width: INNER - 170 }); hy += 12; }
      if (data.tenant.gstin) doc.text(`GSTIN: ${data.tenant.gstin}`, M, hy, { width: INNER - 170 });

      // Quotation title block (right)
      doc.font('Helvetica-Bold').fontSize(16).fillColor(ACCENT).text('QUOTATION', M, 24, { width: INNER, align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor(INK);
      doc.text(`No: ${data.quotation.quote_number}  (v${data.quotation.version})`, M, 48, { width: INNER, align: 'right' });
      const issued = (data.quotation.created_at || new Date().toISOString()).slice(0, 10);
      doc.text(`Date: ${issued}`, M, 60, { width: INNER, align: 'right' });
      if (data.quotation.valid_until) doc.text(`Valid until: ${String(data.quotation.valid_until).slice(0, 10)}`, M, 72, { width: INNER, align: 'right' });

      y = 118;

      // ── Customer + event details ─────────────────────────────────────────
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('Prepared For', M, y);
      doc.font('Helvetica-Bold').fontSize(10).text('Event Details', M + INNER / 2, y);
      y += 15;
      doc.font('Helvetica').fontSize(9).fillColor(INK);
      const leftLines = [
        data.booking.customer_name,
        data.booking.customer_phone || '',
        data.booking.customer_email || '',
      ].filter(Boolean);
      const b = data.booking;
      const dateStr = b.event_date ? (b.end_date && b.end_date !== b.event_date ? `${b.event_date} → ${b.end_date}` : b.event_date) : '';
      const rightLines = [
        b.venue_name ? `Venue: ${b.venue_name}` : '',
        b.event_type ? `Type: ${b.event_type}` : '',
        dateStr ? `Date: ${dateStr}` : '',
        (b.start_time || b.end_time) ? `Time: ${b.start_time || ''}–${b.end_time || ''}` : '',
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
        const descH = doc.heightOfString(ln.description || '', { width: 220 });
        const rowH = Math.max(18, descH + 8);
        if (y + rowH > 720) { doc.addPage(); y = M; }
        doc.fillColor(MUTED).fontSize(7.5).text(lineTypeLabel(ln.line_type), cols.type + 4, y + 5, { width: 64 });
        doc.fillColor(INK).fontSize(8.5).text(ln.description || '', cols.desc, y + 5, { width: 220 });
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
        doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('Notes', M, y);
        y += 13;
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(data.quotation.notes, M, y, { width: INNER });
        y += doc.heightOfString(data.quotation.notes, { width: INNER }) + 12;
      }
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED).text(
        'This is a quotation, not a tax invoice. Prices are indicative and subject to availability at time of confirmation.',
        M, Math.max(y, 770), { width: INNER, align: 'center' }
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
