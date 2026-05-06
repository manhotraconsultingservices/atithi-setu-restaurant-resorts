/**
 * Atithi Setu — Purchase Order PDF generator
 *
 * Generates a clean, single-page PO PDF that the owner can email to a
 * supplier. Format is intentionally simpler than the Hotel Folio Invoice —
 * suppliers don't need HSN per line, bilingual labels, or "place of supply"
 * — but it stays GST-aware for tax-deductible procurement.
 */

import PDFDocument from 'pdfkit';

export interface POPdfData {
  // PO header
  po_id: string;
  status: string;
  raised_at: Date | string;
  expected_delivery_date: string | null;
  notes: string | null;

  // Restaurant (buyer)
  restaurant_name: string;
  restaurant_address: string | null;
  restaurant_phone: string | null;
  restaurant_email: string | null;
  restaurant_gstin: string | null;

  // Supplier
  supplier_name: string;
  supplier_contact_name: string | null;
  supplier_phone: string | null;
  supplier_email: string | null;
  supplier_address: string | null;
  supplier_gstin: string | null;
  supplier_lead_time_days: number | null;
  supplier_payment_terms: string | null;

  // Line items + totals
  items: Array<{
    ingredient_name: string;
    qty_ordered: number;
    unit: string;
    unit_price: number;
    line_total: number;
    gst_percent: number;
  }>;
  total_amount: number;
  gst_amount: number;
  grand_total: number;
}

/**
 * Generates a PO PDF and returns a Buffer (suitable for email attachment
 * or HTTP download). Pure function — no I/O side effects.
 */
export async function generatePOPdf(data: POPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        info: {
          Title: `Purchase Order ${data.po_id}`,
          Author: data.restaurant_name,
          Subject: `Purchase Order ${data.po_id} — ${data.supplier_name}`,
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Layout helpers
      const PAGE_W = doc.page.width - 80;          // content width
      const COL_LEFT = 40;
      const COL_RIGHT = doc.page.width - 40;
      const ORANGE = '#cc5a16';
      const DARK = '#1a1208';
      const MUTED = '#6b5d52';
      const LIGHT = '#9c8e85';

      const fmtINR = (n: number) =>
        '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      // ── HEADER STRIP ────────────────────────────────────────────────────────
      doc.fillColor(ORANGE)
         .rect(0, 0, doc.page.width, 6)
         .fill();

      doc.fillColor(DARK)
         .font('Helvetica-Bold')
         .fontSize(22)
         .text('PURCHASE ORDER', COL_LEFT, 24);

      doc.fillColor(MUTED)
         .font('Helvetica')
         .fontSize(10)
         .text(`Status: ${data.status}`, COL_LEFT, 50);

      // PO id + date — right-aligned
      doc.fillColor(ORANGE)
         .font('Helvetica-Bold')
         .fontSize(16)
         .text(data.po_id, 0, 24, { align: 'right', width: COL_RIGHT });

      const raisedAtStr = (() => {
        try {
          const d = new Date(data.raised_at);
          return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        } catch { return ''; }
      })();
      doc.fillColor(MUTED)
         .font('Helvetica')
         .fontSize(10)
         .text(`Raised on  ${raisedAtStr}`, 0, 46, { align: 'right', width: COL_RIGHT });
      if (data.expected_delivery_date) {
        doc.fillColor(MUTED)
           .text(`Expected   ${data.expected_delivery_date}`, 0, 60, { align: 'right', width: COL_RIGHT });
      }

      // Divider
      doc.moveTo(COL_LEFT, 84).lineTo(COL_RIGHT, 84).strokeColor('#e5d3c3').lineWidth(0.5).stroke();

      // ── BUYER + SUPPLIER side-by-side ───────────────────────────────────────
      const blockTop = 100;
      const colWidth = (PAGE_W - 20) / 2;
      const colLeftX = COL_LEFT;
      const colRightX = COL_LEFT + colWidth + 20;

      const drawParty = (
        x: number,
        title: string,
        name: string,
        contact: string | null,
        phone: string | null,
        email: string | null,
        address: string | null,
        gstin: string | null,
      ) => {
        doc.fillColor(LIGHT)
           .font('Helvetica-Bold')
           .fontSize(8)
           .text(title.toUpperCase(), x, blockTop, { width: colWidth });
        doc.fillColor(DARK)
           .font('Helvetica-Bold')
           .fontSize(13)
           .text(name, x, blockTop + 12, { width: colWidth });
        let y = blockTop + 30;
        const line = (label: string, value: string | null) => {
          if (!value) return;
          doc.fillColor(MUTED).font('Helvetica').fontSize(9)
             .text(`${label}: ${value}`, x, y, { width: colWidth });
          y += 13;
        };
        line('Contact', contact);
        line('Phone', phone);
        line('Email', email);
        line('Address', address);
        line('GSTIN', gstin);
      };
      drawParty(
        colLeftX, 'BILL FROM (Buyer)',
        data.restaurant_name, null, data.restaurant_phone,
        data.restaurant_email, data.restaurant_address, data.restaurant_gstin,
      );
      drawParty(
        colRightX, 'BILL TO (Supplier)',
        data.supplier_name, data.supplier_contact_name, data.supplier_phone,
        data.supplier_email, data.supplier_address, data.supplier_gstin,
      );

      // Lead time + payment terms strip
      let metaY = blockTop + 110;
      if (data.supplier_lead_time_days != null || data.supplier_payment_terms) {
        const parts: string[] = [];
        if (data.supplier_lead_time_days != null) parts.push(`Lead time: ${data.supplier_lead_time_days} day${data.supplier_lead_time_days !== 1 ? 's' : ''}`);
        if (data.supplier_payment_terms) parts.push(`Payment: ${data.supplier_payment_terms}`);
        doc.fillColor(MUTED).font('Helvetica').fontSize(9)
           .text(parts.join('   ·   '), COL_LEFT, metaY);
        metaY += 14;
      }

      // ── ITEMS TABLE ────────────────────────────────────────────────────────
      const tableTop = metaY + 14;
      const cols = {
        sno:    { x: COL_LEFT,        w: 25,  align: 'left'  as const },
        item:   { x: COL_LEFT + 25,   w: 240, align: 'left'  as const },
        qty:    { x: COL_LEFT + 265,  w: 60,  align: 'right' as const },
        unit:   { x: COL_LEFT + 325,  w: 40,  align: 'left'  as const },
        rate:   { x: COL_LEFT + 365,  w: 70,  align: 'right' as const },
        total:  { x: COL_LEFT + 435,  w: 80,  align: 'right' as const },
      };
      // Header row
      doc.fillColor(ORANGE).rect(COL_LEFT, tableTop, PAGE_W, 22).fill();
      doc.fillColor('white').font('Helvetica-Bold').fontSize(9);
      doc.text('#',     cols.sno.x   + 4, tableTop + 7, { width: cols.sno.w });
      doc.text('ITEM',  cols.item.x  + 4, tableTop + 7, { width: cols.item.w });
      doc.text('QTY',                      cols.qty.x, tableTop + 7, { width: cols.qty.w, align: 'right' });
      doc.text('UNIT',                     cols.unit.x + 4, tableTop + 7, { width: cols.unit.w });
      doc.text('RATE',                     cols.rate.x, tableTop + 7, { width: cols.rate.w, align: 'right' });
      doc.text('LINE TOTAL',               cols.total.x, tableTop + 7, { width: cols.total.w, align: 'right' });

      // Body rows
      let rowY = tableTop + 26;
      doc.font('Helvetica').fontSize(10).fillColor(DARK);
      data.items.forEach((it, idx) => {
        if (rowY > doc.page.height - 180) {
          doc.addPage();
          rowY = 50;
        }
        // Zebra striping
        if (idx % 2 === 0) {
          doc.fillColor('#faf7f2').rect(COL_LEFT, rowY - 4, PAGE_W, 22).fill();
          doc.fillColor(DARK);
        }
        doc.text(String(idx + 1), cols.sno.x + 4, rowY, { width: cols.sno.w });
        doc.text(it.ingredient_name, cols.item.x + 4, rowY, { width: cols.item.w });
        doc.text(Number(it.qty_ordered).toFixed(2), cols.qty.x, rowY, { width: cols.qty.w, align: 'right' });
        doc.text(it.unit, cols.unit.x + 4, rowY, { width: cols.unit.w });
        doc.text(fmtINR(it.unit_price), cols.rate.x, rowY, { width: cols.rate.w, align: 'right' });
        doc.text(fmtINR(it.line_total), cols.total.x, rowY, { width: cols.total.w, align: 'right' });
        rowY += 18;
      });

      // ── TOTALS BLOCK ───────────────────────────────────────────────────────
      const totalsY = rowY + 16;
      const totalsX = COL_LEFT + 300;
      const totalsW = PAGE_W - 300;
      doc.fillColor(MUTED).font('Helvetica').fontSize(10);
      doc.text('Subtotal', totalsX, totalsY,           { width: totalsW * 0.55, align: 'right' });
      doc.fillColor(DARK).text(fmtINR(data.total_amount), totalsX, totalsY, { width: totalsW, align: 'right' });
      doc.fillColor(MUTED).text('GST',          totalsX, totalsY + 16, { width: totalsW * 0.55, align: 'right' });
      doc.fillColor(DARK).text(fmtINR(data.gst_amount), totalsX, totalsY + 16, { width: totalsW, align: 'right' });
      // Grand total — bold + box
      doc.strokeColor('#e5d3c3').lineWidth(0.5)
         .moveTo(totalsX, totalsY + 36).lineTo(totalsX + totalsW, totalsY + 36).stroke();
      doc.fillColor(ORANGE).font('Helvetica-Bold').fontSize(12);
      doc.text('GRAND TOTAL', totalsX, totalsY + 44,    { width: totalsW * 0.55, align: 'right' });
      doc.text(fmtINR(data.grand_total), totalsX, totalsY + 44, { width: totalsW, align: 'right' });

      // ── NOTES ──────────────────────────────────────────────────────────────
      if (data.notes && data.notes.trim()) {
        doc.fillColor(LIGHT).font('Helvetica-Bold').fontSize(8)
           .text('NOTES', COL_LEFT, totalsY + 80);
        doc.fillColor(MUTED).font('Helvetica').fontSize(9)
           .text(data.notes, COL_LEFT, totalsY + 94, { width: PAGE_W * 0.6 });
      }

      // ── FOOTER — signature block ──────────────────────────────────────────
      const footerY = doc.page.height - 90;
      doc.fillColor(LIGHT).font('Helvetica').fontSize(8)
         .text(`This is a system-generated purchase order from ${data.restaurant_name}.`,
               COL_LEFT, footerY, { width: PAGE_W, align: 'center' });
      doc.text(`Please confirm receipt by replying to this email${data.supplier_email ? ' (' + data.supplier_email + ')' : ''}.`,
               COL_LEFT, footerY + 12, { width: PAGE_W, align: 'center' });

      // Authorised signatory block
      const sigY = footerY - 50;
      doc.strokeColor('#cccccc').lineWidth(0.5)
         .moveTo(COL_RIGHT - 200, sigY).lineTo(COL_RIGHT, sigY).stroke();
      doc.fillColor(MUTED).font('Helvetica').fontSize(8)
         .text('Authorised Signatory', COL_RIGHT - 200, sigY + 4, { width: 200, align: 'center' });
      doc.fillColor(DARK).font('Helvetica-Bold').fontSize(9)
         .text(data.restaurant_name, COL_RIGHT - 200, sigY + 16, { width: 200, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Plain-text + HTML email body for the PO. Used by the email-PO endpoint.
 */
export function buildPOEmailBody(data: POPdfData): { subject: string; text: string; html: string } {
  const fmtINR = (n: number) =>
    '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const subject = `Purchase Order ${data.po_id} from ${data.restaurant_name}`;
  const itemsList = data.items.map(it => `  • ${it.ingredient_name}: ${it.qty_ordered} ${it.unit} @ ${fmtINR(it.unit_price)} = ${fmtINR(it.line_total)}`).join('\n');
  const text =
    `Hello ${data.supplier_name},\n\n` +
    `Please find attached our Purchase Order ${data.po_id}.\n\n` +
    `Items requested:\n${itemsList}\n\n` +
    `Subtotal: ${fmtINR(data.total_amount)}\n` +
    `GST:      ${fmtINR(data.gst_amount)}\n` +
    `TOTAL:    ${fmtINR(data.grand_total)}\n\n` +
    (data.expected_delivery_date ? `Expected delivery: ${data.expected_delivery_date}\n\n` : '') +
    `Please confirm receipt of this PO and acknowledge expected delivery date.\n\n` +
    `Regards,\n${data.restaurant_name}` +
    (data.restaurant_phone ? `\n${data.restaurant_phone}` : '') +
    (data.restaurant_email ? `\n${data.restaurant_email}` : '');
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:auto">` +
    `<h2 style="color:#cc5a16">Purchase Order ${data.po_id}</h2>` +
    `<p>Hello <strong>${data.supplier_name}</strong>,</p>` +
    `<p>Please find attached our Purchase Order. Summary below — full details in the PDF.</p>` +
    `<table cellpadding="6" style="border-collapse:collapse;border:1px solid #e5d3c3;font-size:14px;width:100%">` +
    `<thead><tr style="background:#cc5a16;color:white">` +
    `<th align="left">Item</th><th align="right">Qty</th><th align="right">Rate</th><th align="right">Total</th>` +
    `</tr></thead><tbody>` +
    data.items.map(it => `<tr style="border-bottom:1px solid #f0e6d8"><td>${it.ingredient_name}</td><td align="right">${it.qty_ordered} ${it.unit}</td><td align="right">${fmtINR(it.unit_price)}</td><td align="right">${fmtINR(it.line_total)}</td></tr>`).join('') +
    `</tbody></table>` +
    `<table cellpadding="4" style="margin-left:auto;margin-top:12px;font-size:14px">` +
    `<tr><td style="color:#6b5d52">Subtotal</td><td align="right">${fmtINR(data.total_amount)}</td></tr>` +
    `<tr><td style="color:#6b5d52">GST</td><td align="right">${fmtINR(data.gst_amount)}</td></tr>` +
    `<tr><td style="color:#cc5a16;font-weight:bold;font-size:16px">GRAND TOTAL</td><td align="right" style="color:#cc5a16;font-weight:bold;font-size:16px">${fmtINR(data.grand_total)}</td></tr>` +
    `</table>` +
    (data.expected_delivery_date ? `<p>Expected delivery: <strong>${data.expected_delivery_date}</strong></p>` : '') +
    `<p>Please confirm receipt and expected delivery date.</p>` +
    `<p style="margin-top:24px;color:#6b5d52">Regards,<br/><strong>${data.restaurant_name}</strong>` +
    (data.restaurant_phone ? `<br/>${data.restaurant_phone}` : '') +
    (data.restaurant_email ? `<br/>${data.restaurant_email}` : '') +
    `</p></div>`;
  return { subject, text, html };
}
