/**
 * Atithi Setu — Receipt Voucher PDF (Rule 50, CGST Rules 2017)
 *
 * A registered supplier who receives an ADVANCE for a supply of services must
 * issue a receipt voucher (Section 31(3)(d) of the CGST Act), and tax on that
 * advance falls due on receipt (Section 13(2)) — it is not deferred to the
 * invoice. Rule 50 prescribes what the voucher carries; every one of those
 * particulars is printed below, and nothing is printed that is not true of the
 * record behind it.
 *
 * Traceability: the voucher names the booking it was taken against and, once
 * the bill is raised, the tax invoice it was adjusted against — so a guest, an
 * auditor or the tax officer can follow the money from receipt to invoice.
 *
 * Amounts are printed as "Rs." rather than the rupee glyph: PDFKit's built-in
 * Helvetica has no glyph for it.
 */

import PDFDocument from 'pdfkit';

export interface ReceiptVoucherPdfData {
  rv_number: string;
  receipt_date: string;
  status: string;                  // ISSUED | ADJUSTED | CANCELLED | REFUNDED
  module: string;                  // HOTEL | EVENTS
  seller: {
    name: string; address?: string; city?: string; state?: string; pincode?: string;
    gstin?: string; phone?: string; email?: string;
  };
  customer: { name: string | null; address: string | null; gstin: string | null };
  description: string;
  amount: number;
  taxable_value: number;
  gst_rate: number;
  cgst: number;
  sgst: number;
  igst: number;
  rate_basis: string | null;
  place_of_supply: string | null;
  payment_method: string | null;
  reference: string | null;
  booking_ref: string | null;
  adjusted_invoice_number: string | null;
  adjusted_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  refund_voucher_number?: string | null;
  refunded_at?: string | null;
  // Every refund voucher issued against this advance, oldest first (part refunds).
  refunds?: { rfv_number: string; refund_date: string; amount: number }[];
}

const money = (n: number) =>
  'Rs. ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function generateReceiptVoucherPdf(d: ReceiptVoucherPdfData): Promise<Buffer> {
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
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text('RECEIPT VOUCHER', left, titleY, { width: width * 0.6 });
      const afterTitleY = doc.y;

      // Number / date / status, right-aligned beside the title.
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK)
        .text(d.rv_number, left + width * 0.6, titleY, { width: width * 0.4, align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor(MUTED)
        .text(`Date: ${d.receipt_date}`, left + width * 0.6, doc.y, { width: width * 0.4, align: 'right' });
      const refunds = d.refunds || [];
      const refundedTotal = Math.round(refunds.reduce((s, r) => s + Number(r.amount || 0), 0) * 100) / 100;
      const stillHeld = Math.max(0, Math.round((Number(d.amount || 0) - refundedTotal) * 100) / 100);
      const statusLabel = d.status === 'ADJUSTED' ? 'Adjusted against invoice'
        : d.status === 'CANCELLED' ? 'CANCELLED'
        : d.status === 'REFUNDED' ? 'Refunded'
        : refundedTotal > 0 ? 'Advance held — part refunded' : 'Advance held';
      doc.font('Helvetica-Bold').fontSize(9).fillColor(d.status === 'CANCELLED' ? '#b42318' : INK)
        .text(statusLabel, left + width * 0.6, doc.y, { width: width * 0.4, align: 'right' });

      doc.y = Math.max(doc.y, afterTitleY);
      doc.moveDown(1.2);
      doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(RULE).lineWidth(1).stroke();
      doc.moveDown(0.6);

      // ── Recipient ─────────────────────────────────────────────────────────
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('RECEIVED FROM', left, doc.y, { width });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(d.customer.name || 'Guest', { width });
      doc.font('Helvetica').fontSize(9).fillColor(INK);
      if (d.customer.address) doc.text(d.customer.address, { width });
      doc.text(d.customer.gstin ? `GSTIN / UIN: ${d.customer.gstin}` : 'GSTIN / UIN: Not provided (unregistered recipient)', { width });

      doc.moveDown(0.8);

      // ── The advance ───────────────────────────────────────────────────────
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

      row('Amount of advance received', money(d.amount), true);
      if (d.gst_rate > 0) {
        row('Value of advance (excluding tax)', money(d.taxable_value));
        row('Rate of tax', `${Number(d.gst_rate).toFixed(2)}%`);
        if (d.igst > 0) row('Integrated tax (IGST)', money(d.igst));
        if (d.cgst > 0) row(`Central tax (CGST @ ${(Number(d.gst_rate) / 2).toFixed(2)}%)`, money(d.cgst));
        if (d.sgst > 0) row(`State tax (SGST @ ${(Number(d.gst_rate) / 2).toFixed(2)}%)`, money(d.sgst));
        row('Total tax on this advance', money(d.cgst + d.sgst + d.igst), true);
      } else {
        row('Tax on this advance', 'Nil');
      }
      row('Place of supply', d.place_of_supply || '—');
      row('Tax payable on reverse charge', 'No');
      if (d.payment_method) row('Received by', `${String(d.payment_method).replace(/_/g, ' ')}${d.reference ? ` · ${d.reference}` : ''}`);

      doc.moveDown(0.4);
      doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(RULE).stroke();
      doc.moveDown(0.6);

      // ── Traceability ──────────────────────────────────────────────────────
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('TRACEABILITY', left, doc.y, { width });
      doc.fillColor(INK).font('Helvetica').fontSize(9);
      doc.text(`Taken against ${d.module === 'EVENTS' ? 'event booking' : 'booking'}: ${d.booking_ref || '—'}`, { width });
      for (const r of refunds) doc.text(`${money(r.amount)} refunded under refund voucher ${r.rfv_number} on ${r.refund_date}.`, { width });
      if (d.status === 'ADJUSTED') {
        doc.text(refundedTotal > 0
          ? `The remaining ${money(stillHeld)} was adjusted against tax invoice ${d.adjusted_invoice_number || '—'} on ${d.adjusted_at || '—'}.`
          : `Adjusted against tax invoice ${d.adjusted_invoice_number || '—'} on ${d.adjusted_at || '—'}.`, { width });
      } else if (d.status === 'REFUNDED') {
        if (!refunds.length) doc.text(`Refunded under refund voucher ${d.refund_voucher_number || '—'} on ${d.refunded_at || '—'}.`, { width });
      } else if (d.status === 'CANCELLED') {
        doc.fillColor('#b42318').text(`Cancelled on ${d.cancelled_at || '—'}${d.cancel_reason ? ` — ${d.cancel_reason}` : ''}.`, { width });
        doc.fillColor(INK);
      } else if (refundedTotal > 0) {
        doc.text(`${money(stillHeld)} is still held — it will be set against the tax invoice when the bill is raised.`, { width });
      } else {
        doc.text('Not yet adjusted — it will be set against the tax invoice when the bill is raised.', { width });
      }

      doc.moveDown(1.2);
      // Printed only where it explains a figure on this voucher: how the rate was set.
      if (d.gst_rate > 0 && d.rate_basis === 'NOT_DETERMINABLE_RULE_50') {
        doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(
          'The rate of tax could not be determined when the advance was received, so it has been charged at eighteen per cent under the proviso to Rule 50.',
          { width },
        );
      }

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
