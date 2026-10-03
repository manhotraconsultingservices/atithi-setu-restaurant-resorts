/**
 * Platform tax invoice — PLM Pundits (brand Atithi-Setu) billing a tenant for
 * its subscription. A GST tax invoice under Rule 46: supplier and recipient
 * with GSTIN and state code, a consecutive serial, date, SAC, taxable value per
 * line, the CGST+SGST or IGST split, place of supply, "Reverse charge: No",
 * amount in words and an authorised signatory.
 *
 * Rendered only from the invoice row's own snapshots (seller_json/buyer_json and
 * its lines), so a reprint never changes and rendering never mints a number.
 *
 * NO-OVERFLOW rules: every text has an explicit width, right-hand blocks own
 * their column, rows and boxes grow by measured height, amounts are "Rs."
 * (Helvetica has no rupee glyph). Rows that would cross the bottom margin start
 * a new page with the table header repeated; every page gets the footer.
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

// GST state codes (first two digits of a GSTIN).
const STATE_CODES: Record<string, string> = {
  'jammu and kashmir': '01', 'himachal pradesh': '02', 'punjab': '03', 'chandigarh': '04', 'uttarakhand': '05', 'haryana': '06', 'delhi': '07',
  'rajasthan': '08', 'uttar pradesh': '09', 'bihar': '10', 'sikkim': '11', 'arunachal pradesh': '12', 'nagaland': '13', 'manipur': '14',
  'mizoram': '15', 'tripura': '16', 'meghalaya': '17', 'assam': '18', 'west bengal': '19', 'jharkhand': '20', 'odisha': '21', 'chhattisgarh': '22',
  'madhya pradesh': '23', 'gujarat': '24', 'dadra and nagar haveli and daman and diu': '26', 'maharashtra': '27', 'karnataka': '29', 'goa': '30',
  'lakshadweep': '31', 'kerala': '32', 'tamil nadu': '33', 'puducherry': '34', 'andaman and nicobar islands': '35', 'telangana': '36',
  'andhra pradesh': '37', 'ladakh': '38',
};
const stateCode = (state?: string | null, gstin?: string | null) => {
  const g = String(gstin || '').trim().match(/^(\d{2})[A-Z0-9]{13}$/i);
  if (g) return g[1];
  return STATE_CODES[String(state || '').toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ').trim()] || '';
};
const withCode = (state?: string | null, gstin?: string | null) => { const c = stateCode(state, gstin); return state ? `${state}${c ? ` (${c})` : ''}` : (c ? `State code ${c}` : '—'); };
const money = (n: number) => 'Rs. ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num2 = (n: number) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = (n: number) => Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(2);
const fmtDate = (s?: string | null) => {
  if (!s) return '—';
  const d = new Date(String(s).length === 10 ? `${s}T00:00:00` : String(s));
  return isNaN(d.getTime()) ? String(s) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

export async function generatePlatformInvoicePdf(d: PlatformInvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const BRAND = '#0E5E73', BRAND_SOFT = '#E7F2F5', INK = '#111827', BODY = '#1F2937', MUTED = '#4B5563', RULE = '#CBD5E1', ZEBRA = '#F8FAFC';
      const RED = '#B42318', GREEN = '#067647', AMBER = '#B54708';
      const L = 36, R = doc.page.width - 36, W = R - L;
      const BOTTOM = doc.page.height - 56;
      const intra = d.cgst > 0 || d.sgst > 0;
      const half = (Number(d.gst_rate) / 2);
      const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)}%`;
      const newPage = () => { doc.addPage(); doc.y = 40; };
      const ensure = (h: number) => { if (doc.y + h > BOTTOM) newPage(); };

      // ── Header band (grows to fit a long legal name) ─────────────────────
      const RCOL = 190, LCOL = W - RCOL - 24;
      doc.font('Helvetica-Bold').fontSize(18);
      const nameH = doc.heightOfString(d.seller.name || 'PLM Pundits', { width: LCOL });
      const bandH = Math.max(66, 16 + nameH + 18 + 14);
      doc.rect(0, 0, doc.page.width, bandH + 20).fill(BRAND);
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(18).text(d.seller.name || 'PLM Pundits', L, 22, { width: LCOL });
      doc.font('Helvetica').fontSize(9.5).fillColor('#D7ECF1').text(d.brand_name ? `${d.brand_name} · Hotel & restaurant software` : 'Software subscription', L, 22 + nameH + 4, { width: LCOL });
      doc.font('Helvetica-Bold').fontSize(17).fillColor('#FFFFFF').text('TAX INVOICE', R - RCOL, 22, { width: RCOL, align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor('#D7ECF1').text('Original for recipient', R - RCOL, 44, { width: RCOL, align: 'right' });
      doc.y = bandH + 20 + 14;

      // ── Key facts grid (two rows of four cells) ──────────────────────────
      const statusLabel = d.status === 'PAID' ? 'PAID' : d.status === 'CANCELLED' ? 'CANCELLED' : 'PAYMENT DUE';
      const statusColor = d.status === 'PAID' ? GREEN : d.status === 'CANCELLED' ? RED : AMBER;
      const cells: [string, string, string?][] = [
        ['Invoice no.', d.invoice_number], ['Invoice date', fmtDate(d.issue_date)],
        ['Due date', d.status === 'ISSUED' ? fmtDate(d.due_date) : '—'], ['Status', statusLabel, statusColor],
        ['Place of supply', withCode(d.place_of_supply || d.buyer.state, d.buyer.gstin)], ['Reverse charge', 'No'],
        ['Service period', d.period_from && d.period_to ? `${fmtDate(d.period_from)} – ${fmtDate(d.period_to)}` : '—'], ['Account', d.buyer.tenant_id || '—'],
      ];
      const cw = W / 4;
      for (let row = 0; row < 2; row++) {
        const y0 = doc.y;
        let h = 0;
        doc.font('Helvetica-Bold').fontSize(9.5);
        for (let c = 0; c < 4; c++) h = Math.max(h, doc.heightOfString(cells[row * 4 + c][1], { width: cw - 16 }));
        const cellH = 12 + 11 + h + 8;
        doc.rect(L, y0, W, cellH).lineWidth(0.6).strokeColor(RULE).stroke();
        for (let c = 0; c < 4; c++) {
          const [k, v, col] = cells[row * 4 + c];
          const x = L + c * cw;
          if (c) doc.moveTo(x, y0).lineTo(x, y0 + cellH).strokeColor(RULE).stroke();
          doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(k.toUpperCase(), x + 8, y0 + 8, { width: cw - 16, characterSpacing: 0.4 });
          doc.font('Helvetica-Bold').fontSize(9.5).fillColor(col || INK).text(v, x + 8, y0 + 20, { width: cw - 16 });
        }
        doc.y = y0 + cellH;
      }
      doc.y += 12;

      // ── Billed by / Billed to (equal-height boxes) ───────────────────────
      const bw = (W - 12) / 2;
      const party = (title: string, name: string, lines: string[]) => ({ title, name, lines: lines.filter(Boolean) });
      // A buyer GSTIN in the wrong format (e.g. a test value saved on an older
      // invoice) is not a GSTIN: print the buyer as unregistered.
      const buyerGstin = /^\d{2}[A-Z0-9]{13}$/i.test(String(d.buyer.gstin || '').trim()) ? String(d.buyer.gstin).trim().toUpperCase() : null;
      const seller = party('BILLED BY', d.seller.name || 'PLM Pundits', [
        d.seller.address || '', [d.seller.city, d.seller.pincode].filter(Boolean).join(' '), `State: ${withCode(d.seller.state, d.seller.gstin)}`,
        d.seller.gstin ? `GSTIN: ${d.seller.gstin}` : '', d.seller.pan ? `PAN: ${d.seller.pan}` : '', [d.seller.email, d.seller.phone].filter(Boolean).join('  ·  '),
      ]);
      const buyer = party('BILLED TO', d.buyer.business || d.buyer.name || 'Customer', [
        d.buyer.business && d.buyer.name && d.buyer.name !== d.buyer.business ? `Attn: ${d.buyer.name}` : '',
        d.buyer.address || '', `State: ${withCode(d.buyer.state, d.buyer.gstin)}`,
        buyerGstin ? `GSTIN: ${buyerGstin}` : 'GSTIN: Unregistered', [d.buyer.email, d.buyer.phone].filter(Boolean).join('  ·  '),
      ]);
      const partyH = (p: any) => {
        doc.font('Helvetica-Bold').fontSize(10.5); let h = 22 + doc.heightOfString(p.name, { width: bw - 20 }) + 4;
        doc.font('Helvetica').fontSize(9); for (const l of p.lines) h += doc.heightOfString(l, { width: bw - 20 }) + 1.5;
        return h + 10;
      };
      const boxH = Math.max(partyH(seller), partyH(buyer));
      ensure(boxH + 10);
      const by = doc.y;
      [seller, buyer].forEach((p, i) => {
        const x = L + i * (bw + 12);
        doc.rect(x, by, bw, boxH).fill(i === 0 ? '#FFFFFF' : BRAND_SOFT);
        doc.rect(x, by, bw, boxH).lineWidth(0.6).strokeColor(RULE).stroke();
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(BRAND).text(p.title, x + 10, by + 9, { width: bw - 20, characterSpacing: 0.6 });
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(p.name, x + 10, by + 22, { width: bw - 20 });
        let y = doc.y + 3;
        doc.font('Helvetica').fontSize(9).fillColor(BODY);
        for (const l of p.lines) { doc.text(l, x + 10, y, { width: bw - 20 }); y = doc.y + 1.5; }
      });
      doc.y = by + boxH + 14;

      // ── Lines table ──────────────────────────────────────────────────────
      // # | Description (SAC) | Qty | Rate | Taxable | GST % | GST amt | Amount
      const C = { no: 22, qty: 32, rate: 64, tax: 68, gp: 36, ga: 60, amt: 74 };
      const descW = W - C.no - C.qty - C.rate - C.tax - C.gp - C.ga - C.amt;
      const X = { no: L, desc: L + C.no, qty: 0, rate: 0, tax: 0, gp: 0, ga: 0, amt: 0 } as any;
      X.qty = X.desc + descW; X.rate = X.qty + C.qty; X.tax = X.rate + C.rate; X.gp = X.tax + C.tax; X.ga = X.gp + C.gp; X.amt = X.ga + C.ga;
      const head = () => {
        const y = doc.y;
        doc.rect(L, y, W, 22).fill(BRAND);
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF');
        const t = (s: string, x: number, w: number, a: any = 'left') => doc.text(s, x + 4, y + 7, { width: w - 8, align: a });
        t('#', X.no, C.no); t('DESCRIPTION OF SERVICE', X.desc, descW); t('QTY', X.qty, C.qty, 'right'); t('RATE', X.rate, C.rate, 'right');
        t('TAXABLE', X.tax, C.tax, 'right'); t('GST', X.gp, C.gp, 'right'); t('GST AMT', X.ga, C.ga, 'right'); t('AMOUNT', X.amt, C.amt, 'right');
        doc.y = y + 22;
      };
      head();
      d.lines.forEach((l, i) => {
        const gstAmt = Math.round(Number(l.amount) * Number(d.gst_rate)) / 100;
        doc.font('Helvetica').fontSize(9);
        const dh = doc.heightOfString(l.description, { width: descW - 8 });
        const sacLine = l.sac ? `SAC ${l.sac}` : '';
        const rowH = 8 + dh + (sacLine ? 11 : 0) + 7;
        if (doc.y + rowH > BOTTOM) { newPage(); head(); }
        const y = doc.y;
        if (i % 2 === 1) doc.rect(L, y, W, rowH).fill(ZEBRA);
        doc.fillColor(BODY).font('Helvetica').fontSize(9);
        const n = (s: string, x: number, w: number) => doc.text(s, x + 4, y + 8, { width: w - 8, align: 'right' });
        doc.text(String(i + 1), X.no + 4, y + 8, { width: C.no - 8 });
        doc.fillColor(INK).text(l.description, X.desc + 4, y + 8, { width: descW - 8 });
        if (sacLine) doc.fillColor(MUTED).fontSize(7.5).text(sacLine, X.desc + 4, y + 8 + dh + 1, { width: descW - 8 });
        doc.fillColor(BODY).fontSize(9);
        n(qtyFmt(l.qty), X.qty, C.qty); n(num2(l.rate), X.rate, C.rate); n(num2(l.amount), X.tax, C.tax);
        n(pct(Number(d.gst_rate)), X.gp, C.gp); n(num2(gstAmt), X.ga, C.ga);
        doc.font('Helvetica-Bold').fillColor(INK); n(num2(Number(l.amount) + gstAmt), X.amt, C.amt);
        doc.y = y + rowH;
        doc.moveTo(L, doc.y).lineTo(R, doc.y).lineWidth(0.4).strokeColor(RULE).stroke();
      });
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text('All amounts in Indian Rupees (INR).', L, doc.y + 4, { width: W });
      doc.y += 16;

      // ── Tax summary (left) + totals (right, own column) ──────────────────
      const TW = 230, TX = R - TW, SW = W - TW - 18;
      ensure(130);
      const top = doc.y;
      // tax summary table
      const sumCols: [string, string][] = intra
        ? [['Taxable value', num2(d.subtotal)], [`CGST ${pct(half)}`, num2(d.cgst)], [`SGST ${pct(half)}`, num2(d.sgst)], ['Total tax', num2(d.cgst + d.sgst)]]
        : [['Taxable value', num2(d.subtotal)], [`IGST ${pct(Number(d.gst_rate))}`, num2(d.igst)], ['Total tax', num2(d.igst)]];
      doc.font('Helvetica-Bold').fontSize(8).fillColor(BRAND).text('TAX SUMMARY', L, top, { width: SW, characterSpacing: 0.5 });
      const sy = top + 14, scw = SW / sumCols.length;
      doc.rect(L, sy, SW, 36).lineWidth(0.6).strokeColor(RULE).stroke();
      sumCols.forEach(([k, v], i) => {
        const x = L + i * scw;
        if (i) doc.moveTo(x, sy).lineTo(x, sy + 36).strokeColor(RULE).stroke();
        doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(k, x + 6, sy + 6, { width: scw - 12 });
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(v, x + 6, sy + 19, { width: scw - 12 });
      });
      let leftEnd = sy + 36 + 10;
      if (d.amount_in_words) {
        doc.font('Helvetica-Bold').fontSize(8).fillColor(BRAND).text('AMOUNT IN WORDS', L, leftEnd, { width: SW, characterSpacing: 0.5 });
        doc.font('Helvetica-Oblique').fontSize(9).fillColor(BODY).text(d.amount_in_words, L, leftEnd + 12, { width: SW });
        leftEnd = doc.y + 4;
      }
      // totals box
      const trows: [string, string][] = [['Taxable value', money(d.subtotal)], ...(intra
        ? [[`CGST @ ${pct(half)}`, money(d.cgst)], [`SGST @ ${pct(half)}`, money(d.sgst)]] as [string, string][]
        : [[`IGST @ ${pct(Number(d.gst_rate))}`, money(d.igst)]] as [string, string][])];
      let ty = top;
      for (const [k, v] of trows) {
        doc.font('Helvetica').fontSize(9.5).fillColor(BODY).text(k, TX + 10, ty + 4, { width: TW - 120 });
        doc.text(v, TX + TW - 110, ty + 4, { width: 100, align: 'right' });
        ty += 18;
      }
      doc.rect(TX, ty + 2, TW, 30).fill(BRAND);
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#FFFFFF').text('TOTAL PAYABLE', TX + 10, ty + 12, { width: TW - 130 });
      doc.fontSize(12).text(money(d.total), TX + TW - 120, ty + 11, { width: 110, align: 'right' });
      ty += 32;
      doc.y = Math.max(leftEnd, ty) + 14;

      // ── Payment (or settlement) box ──────────────────────────────────────
      const b = d.bank || {};
      const bankBits = [
        b.account_name ? ['Account name', b.account_name] : null, b.account_number ? ['Account no.', b.account_number] : null,
        b.ifsc ? ['IFSC', b.ifsc] : null, b.bank_name ? ['Bank', b.bank_name] : null, b.upi_vpa ? ['UPI ID', b.upi_vpa] : null,
      ].filter(Boolean) as [string, string][];
      if (d.status === 'PAID' || d.status === 'CANCELLED') {
        const msg = d.status === 'PAID'
          ? `Paid in full${d.paid_at ? ` on ${fmtDate(d.paid_at)}` : ''}${d.payment_ref ? `  ·  Payment reference ${d.payment_ref}` : ''}. Thank you.`
          : `Cancelled${d.cancelled_at ? ` on ${fmtDate(d.cancelled_at)}` : ''}${d.cancel_reason ? ` — ${d.cancel_reason}` : ''}. Nothing is payable on this invoice.`;
        doc.font('Helvetica-Bold').fontSize(9.5);
        const h = doc.heightOfString(msg, { width: W - 24 }) + 16;
        ensure(h + 8);
        const y = doc.y;
        doc.rect(L, y, W, h).fill(d.status === 'PAID' ? '#ECFDF3' : '#FEF3F2');
        doc.fillColor(d.status === 'PAID' ? GREEN : RED).text(msg, L + 12, y + 8, { width: W - 24 });
        doc.y = y + h + 12;
      } else if (d.pay_url || bankBits.length) {
        const colW = (W - 36) / 2;
        doc.font('Helvetica').fontSize(8.5);
        const urlH = d.pay_url ? doc.heightOfString(d.pay_url, { width: colW }) : 0;
        const bankH = bankBits.length * 13;
        const h = 22 + Math.max(d.pay_url ? 14 + urlH + 26 : 0, bankBits.length ? 14 + bankH : 0) + 8;
        ensure(h + 8);
        const y = doc.y;
        doc.rect(L, y, W, h).lineWidth(0.8).strokeColor(BRAND).stroke();
        doc.font('Helvetica-Bold').fontSize(9).fillColor(BRAND).text(`HOW TO PAY  ·  ${money(d.total)} due ${fmtDate(d.due_date)}`, L + 12, y + 9, { width: W - 24 });
        let x = L + 12;
        if (d.pay_url) {
          doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('Pay online (UPI, card, net banking)', x, y + 26, { width: colW });
          doc.font('Helvetica').fontSize(8.5).fillColor('#1D4ED8').text(d.pay_url, x, y + 40, { width: colW, link: d.pay_url, underline: true });
          x = L + 24 + colW;
        }
        if (bankBits.length) {
          doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(d.pay_url ? 'Or bank transfer (quote the invoice no.)' : 'Bank transfer (quote the invoice no.)', x, y + 26, { width: colW });
          let yy = y + 40;
          for (const [k, v] of bankBits) {
            doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(k, x, yy, { width: 72 });
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(v, x + 74, yy, { width: colW - 74 });
            yy += 13;
          }
        }
        doc.y = y + h + 12;
      }

      // ── Declaration + signature (signature in its own right column) ──────
      ensure(80);
      const dy = doc.y;
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(
        'We declare that this invoice shows the actual price of the services described and that all particulars are true and correct. Tax is not payable on reverse charge basis.',
        L, dy, { width: W - 220 });
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(`For ${d.seller.name || 'PLM Pundits'}`, R - 200, dy, { width: 200, align: 'right' });
      doc.moveTo(R - 150, dy + 46).lineTo(R, dy + 46).lineWidth(0.6).strokeColor(RULE).stroke();
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text('Authorised signatory', R - 200, dy + 50, { width: 200, align: 'right' });

      // ── Stamp + footer on every page ─────────────────────────────────────
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        // Footer and stamp sit in the bottom margin: without this PDFKit treats
        // text there as overflow and adds a blank page for each.
        doc.page.margins.bottom = 0;
        if (d.status === 'PAID' || d.status === 'CANCELLED') {
          doc.save();
          doc.rotate(-24, { origin: [doc.page.width / 2, doc.page.height / 2] });
          doc.font('Helvetica-Bold').fontSize(86).fillColor(d.status === 'PAID' ? GREEN : RED).opacity(0.07)
            .text(d.status, 0, doc.page.height / 2 - 50, { width: doc.page.width, align: 'center', lineBreak: false });
          doc.restore();
          doc.opacity(1);
        }
        const fy = doc.page.height - 36;
        doc.moveTo(L, fy - 8).lineTo(R, fy - 8).lineWidth(0.4).strokeColor(RULE).stroke();
        doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
          .text(`${d.seller.name || 'PLM Pundits'}${d.seller.gstin ? `  ·  GSTIN ${d.seller.gstin}` : ''}  ·  ${d.invoice_number}  ·  Computer-generated invoice`, L, fy, { width: W - 80, lineBreak: false });
        doc.text(`Page ${i - range.start + 1} of ${range.count}`, R - 80, fy, { width: 80, align: 'right', lineBreak: false });
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
