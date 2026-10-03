/**
 * Platform tax invoice — PLM Pundits (brand Atithi-Setu) billing a tenant for
 * its subscription. A GST tax invoice under Rule 46: supplier and recipient
 * with GSTIN, a consecutive serial, date, SAC, taxable value, the CGST+SGST or
 * IGST split, place of supply and "Reverse charge: No".
 *
 * Rendered only from the invoice row's own snapshots (seller_json/buyer_json and
 * its lines), so a reprint never changes and rendering never mints a number.
 *
 * NO-OVERFLOW rules: every text has an explicit width, the right-hand block has
 * its own column, rows advance by their measured height, amounts are "Rs."
 * (Helvetica has no rupee glyph). A row that would cross the bottom margin
 * starts a new page.
 */

import PDFDocument from 'pdfkit';

export interface PlatformInvoicePdfData {
  invoice_number: string;
  issue_date: string;
  due_date?: string | null;
  status: string;                // ISSUED | PAID | CANCELLED
  brand_name?: string | null;
  seller: { name: string; address?: string | null; city?: string | null; state?: string | null; pincode?: string | null; gstin?: string | null; pan?: string | null; phone?: string | null; email?: string | null };
  buyer: { name: string; business?: string | null; address?: string | null; state?: string | null; gstin?: string | null; email?: string | null; phone?: string | null; tenant_id?: string | null };
  lines: { description: string; sac?: string | null; qty: number; rate: number; amount: number }[];
  subtotal: number;
  gst_rate: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  place_of_supply?: string | null;
  period_from?: string | null;
  period_to?: string | null;
  paid_at?: string | null;
  payment_ref?: string | null;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  pay_url?: string | null;
  amount_in_words?: string | null;
  bank?: { account_name?: string | null; account_number?: string | null; ifsc?: string | null; bank_name?: string | null; upi_vpa?: string | null } | null;
}

const money = (n: number) => 'Rs. ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = (n: number) => Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(2);

export async function generatePlatformInvoicePdf(d: PlatformInvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 44 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const INK = '#1a1208', MUTED = '#6b5d52', RULE = '#d8cdbd', RED = '#b42318', GREEN = '#067647';
      const left = 44, right = doc.page.width - 44, width = right - left;
      const bottom = doc.page.height - 60;
      const RCOL = 210;                       // reserved right column for number / date / status
      const LCOL = width - RCOL - 16;         // left column, with a gutter

      const ensure = (h: number) => { if (doc.y + h > bottom) { doc.addPage(); doc.y = 44; } };

      // ── Supplier (left) + document block (right, own column) ─────────────
      const topY = 44;
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(15).text(d.seller.name || 'PLM Pundits', left, topY, { width: LCOL });
      if (d.brand_name) doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`Brand: ${d.brand_name}`, left, doc.y, { width: LCOL });
      doc.font('Helvetica').fontSize(9).fillColor(MUTED);
      const sellerLines = [
        d.seller.address,
        [d.seller.city, d.seller.state, d.seller.pincode].filter(Boolean).join(', '),
        d.seller.gstin ? `GSTIN: ${d.seller.gstin}` : null,
        d.seller.pan ? `PAN: ${d.seller.pan}` : null,
        [d.seller.phone, d.seller.email].filter(Boolean).join('  ·  '),
      ].filter(Boolean) as string[];
      for (const l of sellerLines) doc.text(l, left, doc.y, { width: LCOL });
      const leftEnd = doc.y;

      const rx = right - RCOL;
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(17).text('TAX INVOICE', rx, topY, { width: RCOL, align: 'right' });
      doc.font('Helvetica-Bold').fontSize(10).text(d.invoice_number, rx, doc.y + 2, { width: RCOL, align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`Invoice date: ${d.issue_date}`, rx, doc.y, { width: RCOL, align: 'right' });
      if (d.due_date) doc.text(`Due date: ${d.due_date}`, rx, doc.y, { width: RCOL, align: 'right' });
      const statusLabel = d.status === 'PAID' ? 'PAID' : d.status === 'CANCELLED' ? 'CANCELLED' : 'PAYMENT DUE';
      doc.font('Helvetica-Bold').fontSize(10).fillColor(d.status === 'PAID' ? GREEN : d.status === 'CANCELLED' ? RED : INK)
        .text(statusLabel, rx, doc.y + 2, { width: RCOL, align: 'right' });
      const rightEnd = doc.y;

      doc.y = Math.max(leftEnd, rightEnd) + 14;
      doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(RULE).lineWidth(1).stroke();
      doc.y += 10;

      // ── Bill to (left) + supply details (right) ─────────────────────────
      const billY = doc.y;
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('BILL TO', left, billY, { width: LCOL });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(d.buyer.business || d.buyer.name || 'Customer', left, doc.y, { width: LCOL });
      doc.font('Helvetica').fontSize(9).fillColor(INK);
      if (d.buyer.business && d.buyer.name && d.buyer.name !== d.buyer.business) doc.text(`Attn: ${d.buyer.name}`, left, doc.y, { width: LCOL });
      if (d.buyer.address) doc.text(d.buyer.address, left, doc.y, { width: LCOL });
      if (d.buyer.state) doc.text(`State: ${d.buyer.state}`, left, doc.y, { width: LCOL });
      doc.text(d.buyer.gstin ? `GSTIN: ${d.buyer.gstin}` : 'GSTIN: Not provided (unregistered recipient)', left, doc.y, { width: LCOL });
      if (d.buyer.tenant_id) doc.fillColor(MUTED).text(`Account: ${d.buyer.tenant_id}`, left, doc.y, { width: LCOL });
      const billEnd = doc.y;

      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('SUPPLY DETAILS', rx, billY, { width: RCOL, align: 'right' });
      doc.fillColor(INK).font('Helvetica').fontSize(9);
      doc.text(`Place of supply: ${d.place_of_supply || d.buyer.state || '—'}`, rx, doc.y, { width: RCOL, align: 'right' });
      if (d.period_from && d.period_to) doc.text(`Service period: ${d.period_from} to ${d.period_to}`, rx, doc.y, { width: RCOL, align: 'right' });
      doc.text('Reverse charge: No', rx, doc.y, { width: RCOL, align: 'right' });
      const supEnd = doc.y;

      doc.y = Math.max(billEnd, supEnd) + 14;

      // ── Lines table ──────────────────────────────────────────────────────
      // # | Description | SAC | Qty | Rate | Amount — fixed column widths that sum to `width`.
      const C = { no: 22, sac: 58, qty: 40, rate: 82, amt: 92 };
      const descW = width - C.no - C.sac - C.qty - C.rate - C.amt;
      const xs = { no: left, desc: left + C.no, sac: left + C.no + descW, qty: left + C.no + descW + C.sac, rate: left + C.no + descW + C.sac + C.qty, amt: right - C.amt };
      const header = () => {
        const y = doc.y;
        doc.rect(left, y - 3, width, 18).fill('#f5f0e8');
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8);
        doc.text('#', xs.no + 2, y + 2, { width: C.no - 4 });
        doc.text('DESCRIPTION', xs.desc, y + 2, { width: descW - 6 });
        doc.text('SAC', xs.sac, y + 2, { width: C.sac - 4 });
        doc.text('QTY', xs.qty, y + 2, { width: C.qty - 4, align: 'right' });
        doc.text('RATE', xs.rate, y + 2, { width: C.rate - 4, align: 'right' });
        doc.text('AMOUNT', xs.amt, y + 2, { width: C.amt, align: 'right' });
        doc.y = y + 20;
      };
      header();
      d.lines.forEach((l, i) => {
        doc.font('Helvetica').fontSize(9);
        const h = Math.max(doc.heightOfString(l.description, { width: descW - 6 }), 11);
        if (doc.y + h + 6 > bottom) { doc.addPage(); doc.y = 44; header(); }
        const y = doc.y;
        doc.fillColor(INK).font('Helvetica').fontSize(9);
        doc.text(String(i + 1), xs.no + 2, y, { width: C.no - 4 });
        doc.text(l.description, xs.desc, y, { width: descW - 6 });
        doc.text(l.sac || '', xs.sac, y, { width: C.sac - 4 });
        doc.text(qtyFmt(l.qty), xs.qty, y, { width: C.qty - 4, align: 'right' });
        doc.text(money(l.rate), xs.rate, y, { width: C.rate - 4, align: 'right' });
        doc.text(money(l.amount), xs.amt, y, { width: C.amt, align: 'right' });
        doc.y = y + h + 6;
        doc.moveTo(left, doc.y - 3).lineTo(right, doc.y - 3).strokeColor('#eee6da').lineWidth(0.5).stroke();
      });

      // ── Totals (own right column, measured rows) ─────────────────────────
      const TW = 260, tx = right - TW, labelW = TW - 110;
      const trow = (label: string, value: string, bold = false, color = INK) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10.5 : 9.5);
        const h = Math.max(doc.heightOfString(label, { width: labelW }), doc.heightOfString(value, { width: 110 }));
        ensure(h + 6);
        const y = doc.y;
        doc.fillColor(color).text(label, tx, y, { width: labelW });
        doc.fillColor(color).text(value, tx + labelW, y, { width: 110, align: 'right' });
        doc.y = y + h + 5;
      };
      doc.y += 6;
      ensure(120);
      trow('Taxable value', money(d.subtotal));
      const half = (Number(d.gst_rate) / 2).toFixed(2).replace(/\.00$/, '');
      if (d.igst > 0) trow(`IGST @ ${Number(d.gst_rate).toString()}%`, money(d.igst));
      if (d.cgst > 0) trow(`CGST @ ${half}%`, money(d.cgst));
      if (d.sgst > 0) trow(`SGST @ ${half}%`, money(d.sgst));
      if (!(d.igst > 0 || d.cgst > 0 || d.sgst > 0)) trow('GST', 'Nil');
      doc.moveTo(tx, doc.y).lineTo(right, doc.y).strokeColor(RULE).lineWidth(1).stroke();
      doc.y += 5;
      trow('Total payable', money(d.total), true);
      if (d.amount_in_words) {
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED);
        const h = doc.heightOfString(d.amount_in_words, { width });
        ensure(h + 6);
        doc.text(d.amount_in_words, left, doc.y + 2, { width });
      }

      // ── Status / how to pay ──────────────────────────────────────────────
      doc.y += 12;
      const note = (txt: string, color = INK, bold = false) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(color);
        const h = doc.heightOfString(txt, { width });
        ensure(h + 4);
        doc.text(txt, left, doc.y, { width });
        doc.y += 2;
      };
      if (d.status === 'PAID') note(`Paid${d.paid_at ? ` on ${d.paid_at}` : ''}${d.payment_ref ? ` · Ref ${d.payment_ref}` : ''}. Thank you.`, GREEN, true);
      else if (d.status === 'CANCELLED') note(`Cancelled${d.cancelled_at ? ` on ${d.cancelled_at}` : ''}${d.cancel_reason ? ` — ${d.cancel_reason}` : ''}. Nothing is payable on this invoice.`, RED, true);
      else {
        if (d.pay_url) {
          note('Pay online (UPI, card or net banking):', INK, true);
          note(d.pay_url, '#1d4ed8');
        }
        const b = d.bank || {};
        const bankBits = [
          b.account_name ? `Account name: ${b.account_name}` : null,
          b.account_number ? `Account no.: ${b.account_number}` : null,
          b.ifsc ? `IFSC: ${b.ifsc}` : null,
          b.bank_name ? `Bank: ${b.bank_name}` : null,
          b.upi_vpa ? `UPI: ${b.upi_vpa}` : null,
        ].filter(Boolean) as string[];
        if (bankBits.length) {
          doc.y += 4;
          note(d.pay_url ? 'Or pay by bank transfer, quoting the invoice number:' : 'Pay by bank transfer, quoting the invoice number:', INK, true);
          note(bankBits.join('   ·   '), MUTED);
        }
      }

      // ── Signature (own right column) ─────────────────────────────────────
      ensure(70);
      doc.y += 26;
      doc.fillColor(INK).font('Helvetica').fontSize(9).text(`For ${d.seller.name || 'PLM Pundits'}`, right - 220, doc.y, { width: 220, align: 'right' });
      doc.y += 28;
      doc.text('Authorised signatory', right - 220, doc.y, { width: 220, align: 'right' });
      doc.y += 16;
      doc.fillColor(MUTED).fontSize(7.5).text('This is a computer-generated invoice.', left, doc.y, { width });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
