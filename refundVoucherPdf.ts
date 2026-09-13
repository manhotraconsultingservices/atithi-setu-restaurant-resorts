/**
 * Atithi Setu — Refund Voucher PDF (Rule 51, CGST Rules 2017)
 *
 * An advance was received and a receipt voucher issued, but no supply was made
 * and no tax invoice raised for it, and the money went back to the customer.
 * The refund is evidenced by a refund voucher. Rule 51 prescribes what it
 * carries: the supplier, a serial number and date, the recipient, the number
 * and date of the receipt voucher, the service, the amount refunded, the rate
 * and the tax paid on it, whether tax is payable on reverse charge, and a
 * signature. Every one of those is printed below from the record behind it.
 *
 * Amounts are printed as "Rs." — PDFKit's built-in Helvetica has no rupee glyph.
 */

import PDFDocument from 'pdfkit';

export interface RefundVoucherPdfData {
  rfv_number: string;
  refund_date: string;
  module: string;                  // HOTEL | EVENTS
  seller: {
    name: string; address?: string; city?: string; state?: string; pincode?: string;
    gstin?: string; phone?: string; email?: string;
  };
  customer: { name: string | null; address: string | null; gstin: string | null };
  rv_number: string;
  rv_date: string;
  description: string;
  amount: number;
  taxable_value: number;
  gst_rate: number;
  cgst: number;
  sgst: number;
  igst: number;
  place_of_supply: string | null;
  payment_method: string | null;
  reference: string | null;
  reason: string | null;
  booking_ref: string | null;
}

const money = (n: number) =>
  'Rs. ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function generateRefundVoucherPdf(d: RefundVoucherPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 44 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const INK = '#1a1208';
      const MUTED = '#6b5d52';
      const RULE = '#d8cdbd';
      const left = 44;
      const right = doc.page.width - 44;
      const width = right - left;

      // ── Supplier ───────────────────────────────────────────────────────────
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(15).text(d.seller.name || 'Supplier', left, 44, { width });
      doc.font('Helvetica').fontSize(9).fillColor(MUTED);
      const sellerLines = [
        d.seller.address,
        [d.seller.city, d.seller.state, d.seller.pincode].filter(Boolean).join(', '),
        d.seller.gstin ? `GSTIN: ${d.seller.gstin}` : 'Not registered under GST',
        [d.seller.phone, d.seller.email].filter(Boolean).join('  ·  '),
      ].filter(Boolean) as string[];
      for (const l of sellerLines) doc.text(l, { width });

      // ── Title ─────────────────────────────────────────────────────────────
      doc.moveDown(0.8);
      const titleY = doc.y;
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text('REFUND VOUCHER', left, titleY, { width: width * 0.6 });
      const afterTitleY = doc.y;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK)
        .text(d.rfv_number, left + width * 0.6, titleY, { width: width * 0.4, align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor(MUTED)
        .text(`Date: ${d.refund_date}`, left + width * 0.6, doc.y, { width: width * 0.4, align: 'right' });
      doc.y = Math.max(doc.y, afterTitleY);
      doc.moveDown(1.2);
      doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(RULE).lineWidth(1).stroke();
      doc.moveDown(0.6);

      // ── Recipient ─────────────────────────────────────────────────────────
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('REFUNDED TO', left, doc.y, { width });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(d.customer.name || 'Guest', { width });
      doc.font('Helvetica').fontSize(9).fillColor(INK);
      if (d.customer.address) doc.text(d.customer.address, { width });
      doc.text(d.customer.gstin ? `GSTIN / UIN: ${d.customer.gstin}` : 'GSTIN / UIN: Not provided (unregistered recipient)', { width });

      doc.moveDown(0.8);

      // ── The refund ────────────────────────────────────────────────────────
      const row = (label: string, value: string, bold = false) => {
        const y = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(INK)
          .text(label, left, y, { width: width * 0.62 });
        const h1 = doc.y - y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(INK)
          .text(value, left + width * 0.62, y, { width: width * 0.38, align: 'right' });
        const h2 = doc.y - y;
        doc.y = y + Math.max(h1, h2) + 4;
      };
      doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(RULE).stroke();
      doc.moveDown(0.4);
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('DESCRIPTION OF SERVICE', left, doc.y, { width });
      doc.fillColor(INK).font('Helvetica').fontSize(10).text(d.description, { width });
      doc.moveDown(0.5);

      row('Receipt voucher', `${d.rv_number} dated ${d.rv_date}`);
      row('Amount refunded', money(d.amount), true);
      if (d.gst_rate > 0) {
        row('Value refunded (excluding tax)', money(d.taxable_value));
        row('Rate of tax', `${Number(d.gst_rate).toFixed(2)}%`);
        if (d.igst > 0) row('Integrated tax (IGST) paid on the advance', money(d.igst));
        if (d.cgst > 0) row(`Central tax (CGST @ ${(Number(d.gst_rate) / 2).toFixed(2)}%) paid on the advance`, money(d.cgst));
        if (d.sgst > 0) row(`State tax (SGST @ ${(Number(d.gst_rate) / 2).toFixed(2)}%) paid on the advance`, money(d.sgst));
        row('Total tax paid on the advance', money(d.cgst + d.sgst + d.igst), true);
      } else {
        row('Tax paid on the advance', 'Nil');
      }
      row('Place of supply', d.place_of_supply || '—');
      row('Tax payable on reverse charge', 'No');
      if (d.payment_method) row('Refunded by', `${String(d.payment_method).replace(/_/g, ' ')}${d.reference ? ` · ${d.reference}` : ''}`);

      doc.moveDown(0.4);
      doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(RULE).stroke();
      doc.moveDown(0.6);

      // ── Traceability ──────────────────────────────────────────────────────
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('TRACEABILITY', left, doc.y, { width });
      doc.fillColor(INK).font('Helvetica').fontSize(9);
      doc.text(`Advance received against ${d.module === 'EVENTS' ? 'event booking' : 'booking'} ${d.booking_ref || '—'} under receipt voucher ${d.rv_number}.`, { width });
      if (d.reason) doc.text(`Reason for refund: ${d.reason}`, { width });

      doc.moveDown(2.2);
      doc.fillColor(INK).font('Helvetica').fontSize(9)
        .text(`For ${d.seller.name || 'the supplier'}`, left + width * 0.55, doc.y, { width: width * 0.45, align: 'right' });
      doc.moveDown(2);
      doc.text('Authorised signatory', left + width * 0.55, doc.y, { width: width * 0.45, align: 'right' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
