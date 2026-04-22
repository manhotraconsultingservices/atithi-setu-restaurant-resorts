/**
 * Atithi Setu — Hotel Folio Invoice PDF generator
 *
 * Industry-standard Tax Invoice layout modelled after Indian hospitality best
 * practice (Oberoi / Taj / Marriott-style). Fully compliant with Indian GST
 * invoice requirements:
 *   • GSTIN disclosure
 *   • HSN/SAC codes per line
 *   • CGST + SGST split (intra-state) OR IGST (inter-state) — auto-chosen from guest state
 *   • Invoice number, invoice date, place of supply
 *   • Amount in words (Indian convention)
 *   • Signature block
 *   • Optional hotel logo (PNG/JPG)
 *   • Bilingual English + Hindi labels (Devanagari font)
 *   • Credit-note variant for refunds/cancellations
 */

import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve TTF paths relative to this file so it works in Docker & dev
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const HINDI_REG  = path.join(__dirname, 'assets', 'fonts', 'NotoSansDevanagari-Regular.ttf');
const HINDI_BOLD = path.join(__dirname, 'assets', 'fonts', 'NotoSansDevanagari-Bold.ttf');
const HAS_HINDI_FONT = (() => { try { return fs.existsSync(HINDI_REG) && fs.existsSync(HINDI_BOLD); } catch { return false; } })();

// Bilingual labels (label shown in English; sublabel in Hindi)
const L = {
  TAX_INVOICE: { en: 'TAX INVOICE',              hi: 'कर चालान' },
  CREDIT_NOTE: { en: 'CREDIT NOTE',              hi: 'क्रेडिट नोट' },
  ORIGINAL:    { en: 'Original for Recipient',   hi: 'प्राप्तकर्ता के लिए मूल' },
  BILL_TO:     { en: 'BILL TO',                  hi: 'बिल प्राप्तकर्ता' },
  INVOICE_NO:  { en: 'Invoice No',               hi: 'चालान क्रमांक' },
  INVOICE_DT:  { en: 'Invoice Date',             hi: 'चालान दिनांक' },
  BOOKING_REF: { en: 'Booking Ref',              hi: 'बुकिंग संदर्भ' },
  FOLIO_ID:    { en: 'Folio ID',                 hi: 'फोलियो आईडी' },
  POS:         { en: 'Place of Supply',          hi: 'आपूर्ति का स्थान' },
  ROOM:        { en: 'ROOM',                     hi: 'कमरा' },
  CHECK_IN:    { en: 'CHECK-IN',                 hi: 'चेक-इन' },
  CHECK_OUT:   { en: 'CHECK-OUT',                hi: 'चेक-आउट' },
  NIGHTS:      { en: 'NIGHTS',                   hi: 'रातें' },
  GUESTS:      { en: 'GUESTS',                   hi: 'अतिथि' },
  DESC:        { en: 'DESCRIPTION',              hi: 'विवरण' },
  HSN:         { en: 'HSN/SAC',                  hi: 'HSN/SAC' },
  QTY:         { en: 'QTY',                      hi: 'मात्रा' },
  RATE:        { en: 'RATE',                     hi: 'दर' },
  TAX_PCT:     { en: 'TAX %',                    hi: 'कर %' },
  AMOUNT:      { en: 'AMOUNT',                   hi: 'राशि' },
  SUBTOTAL:    { en: 'Subtotal',                 hi: 'उप-योग' },
  DISCOUNT:    { en: 'Discount',                 hi: 'छूट' },
  GRAND_TOTAL: { en: 'GRAND TOTAL',              hi: 'कुल राशि' },
  AMT_WORDS:   { en: 'AMOUNT IN WORDS',          hi: 'राशि शब्दों में' },
  PAY_STATUS:  { en: 'PAYMENT STATUS',           hi: 'भुगतान स्थिति' },
  METHOD:      { en: 'Method',                   hi: 'माध्यम' },
  SETTLED_ON:  { en: 'Settled On',               hi: 'निपटाया गया' },
  AUTH_SIG:    { en: 'Authorised Signatory',     hi: 'अधिकृत हस्ताक्षरकर्ता' },
  TERMS:       { en: 'TERMS & CONDITIONS',       hi: 'नियम एवं शर्तें' },
  THANK:       { en: 'Thank you for your stay.', hi: 'आपकी ठहरने के लिए धन्यवाद।' },
  REASON:      { en: 'Reason',                   hi: 'कारण' },
};

export interface InvoiceData {
  hotel: {
    name: string;
    address?: string;
    city?: string;
    state?: string;
    pincode?: string;
    gstin?: string;
    phone?: string;
    email?: string;
    website?: string;
    logoPath?: string;      // absolute path or /uploads/... path — we'll resolve
  };
  guest: {
    name: string;
    phone?: string;
    email?: string;
    address?: string;
    nationality?: string;
    state?: string;          // Indian state for GST place-of-supply determination
    gstin?: string;
  };
  stay: {
    roomName: string;
    bookingId: string;
    checkInDate: string;
    checkOutDate: string;
    actualCheckInAt?: string;
    actualCheckOutAt?: string;
    numGuests?: number;
  };
  folio: {
    id: string;
    invoiceNumber: string;
    invoiceDate: string;
    subtotal: number;
    discount: number;
    gstAmount: number;
    grandTotal: number;
    paymentMethod?: string;
    settledAt?: string;
    status: string;
  };
  entries: Array<{
    description: string;
    entryType: string;
    quantity: number;
    unitPrice: number;
    amount: number;
    gstRate?: number;
    gstAmount?: number;
    hsnCode?: string;
  }>;
  placeOfSupply?: string;
  sameStateGst?: boolean;       // optional manual override; if unset, auto-derived from guest.state vs hotel.state
  // Phase 5: Credit note variant
  isCreditNote?: boolean;
  parentInvoiceNumber?: string; // shown on credit notes as "Against Invoice #..."
  creditNoteReason?: string;
  bilingual?: boolean;          // default true — include Hindi sub-labels
}

/**
 * Resolves a logo path that might be "/uploads/xxx.png" (web path) to an absolute
 * filesystem path inside the container. Returns null if not readable.
 */
function resolveLogoPath(p?: string): string | null {
  if (!p) return null;
  try {
    let abs: string;
    if (p.startsWith('/uploads/')) {
      abs = path.join(process.cwd(), 'public', p.replace(/^\//, ''));
    } else if (path.isAbsolute(p)) {
      abs = p;
    } else {
      abs = path.join(process.cwd(), p);
    }
    if (fs.existsSync(abs)) {
      const ext = path.extname(abs).toLowerCase();
      // pdfkit.image supports PNG and JPG
      if (['.png', '.jpg', '.jpeg'].includes(ext)) return abs;
    }
  } catch { /* swallow */ }
  return null;
}

export async function generateInvoicePdf(data: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 0,
        info: {
          Title: `${data.isCreditNote ? 'Credit Note' : 'Tax Invoice'} — ${data.folio.invoiceNumber}`,
          Author: data.hotel.name,
          Subject: `Folio ${data.folio.id}`,
          Keywords: 'invoice,hotel,folio,GST' + (data.isCreditNote ? ',credit-note' : ''),
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Register Hindi fonts if available
      const bilingual = data.bilingual !== false;
      const hindiAvailable = HAS_HINDI_FONT && bilingual;
      if (hindiAvailable) {
        try { doc.registerFont('Hindi',      HINDI_REG);  } catch (e) { console.warn('Hindi font register failed:', e); }
        try { doc.registerFont('Hindi-Bold', HINDI_BOLD); } catch (e) { console.warn('Hindi bold register failed:', e); }
      }
      const drawBilingual = hindiAvailable;
      const label = (key: keyof typeof L): { en: string; hi: string | null } => {
        const v = L[key];
        return { en: v.en, hi: drawBilingual ? v.hi : null };
      };

      // ────────────── Design tokens ──────────────
      const PAGE_W = 595;
      const PAGE_H = 842;
      const M = 40;
      const INNER_W = PAGE_W - M * 2;
      const ACCENT = data.isCreditNote ? '#c13b3b' : '#cc5a16';
      const INK = '#14110c';
      const INK_SOFT = '#3d3128';
      const MUTED = '#6b5d52';
      const HAIR = '#e8dccf';
      const HIGHLIGHT = '#faf7f2';

      // Brand strip
      doc.rect(0, 0, PAGE_W, 6).fill(ACCENT);
      let y = 30;

      // ────────────── HEADER (logo + branding left, title right) ──────────────
      const logoAbs = resolveLogoPath(data.hotel.logoPath);
      let logoW = 0;
      if (logoAbs) {
        try {
          doc.image(logoAbs, M, y, { fit: [56, 56] } as any);
          logoW = 66;
        } catch (e) {
          console.warn('Logo image failed:', e);
        }
      }
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(22)
         .text(data.hotel.name.toUpperCase(), M + logoW, y, { width: INNER_W * 0.6 - logoW });
      const hotelAddrLines = [
        data.hotel.address,
        [data.hotel.city, data.hotel.state, data.hotel.pincode].filter(Boolean).join(' · '),
        [data.hotel.phone, data.hotel.email].filter(Boolean).join(' · '),
        data.hotel.website,
        data.hotel.gstin ? `GSTIN: ${data.hotel.gstin}` : null,
      ].filter(Boolean) as string[];
      doc.fillColor(MUTED).font('Helvetica').fontSize(8.5);
      let hY = y + 28;
      for (const line of hotelAddrLines) {
        doc.text(line, M + logoW, hY, { width: INNER_W * 0.6 - logoW });
        hY += 11;
      }

      // Title box (right) — TAX INVOICE or CREDIT NOTE
      const titleLabel = data.isCreditNote ? label('CREDIT_NOTE') : label('TAX_INVOICE');
      doc.roundedRect(PAGE_W - M - 150, y, 150, 32, 4).fillAndStroke(ACCENT, ACCENT);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(13)
         .text(titleLabel.en, PAGE_W - M - 150, y + 6, { width: 150, align: 'center' });
      if (titleLabel.hi) {
        doc.font('Hindi-Bold').fontSize(10)
           .text(titleLabel.hi, PAGE_W - M - 150, y + 20, { width: 150, align: 'center' });
      }
      const orig = label('ORIGINAL');
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
         .text(orig.en, PAGE_W - M - 150, y + 36, { width: 150, align: 'center', characterSpacing: 0.8 });
      if (orig.hi) {
        doc.font('Hindi').fontSize(7)
           .text(orig.hi, PAGE_W - M - 150, y + 46, { width: 150, align: 'center' });
      }

      y = Math.max(hY, y + (orig.hi ? 58 : 50)) + 18;

      // Divider
      doc.moveTo(M, y).lineTo(PAGE_W - M, y).lineWidth(0.5).strokeColor(HAIR).stroke();
      y += 16;

      // Credit-note sub-banner
      if (data.isCreditNote && data.parentInvoiceNumber) {
        doc.roundedRect(M, y, INNER_W, 24, 4).fillAndStroke('#fdf0f0', '#c13b3b');
        doc.fillColor('#c13b3b').font('Helvetica-Bold').fontSize(9)
           .text(`Against original invoice: ${data.parentInvoiceNumber}${data.creditNoteReason ? ` · Reason: ${data.creditNoteReason}` : ''}`,
                 M + 10, y + 8, { width: INNER_W - 20 });
        y += 34;
      }

      // ────────────── Bill To / Invoice Info (two-column) ──────────────
      const metaCol1X = M;
      const metaCol2X = M + INNER_W / 2 + 10;
      const metaColW  = INNER_W / 2 - 10;

      // Bill To
      const billToLbl = label('BILL_TO');
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8)
         .text(billToLbl.en, metaCol1X, y, { characterSpacing: 1.2 });
      if (billToLbl.hi) {
        doc.font('Hindi-Bold').fontSize(7)
           .text(billToLbl.hi, metaCol1X, y + 9, { characterSpacing: 0.6 });
      }
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(12)
         .text(data.guest.name, metaCol1X, y + (billToLbl.hi ? 22 : 13), { width: metaColW });
      let billY = y + (billToLbl.hi ? 38 : 30);
      doc.fillColor(INK_SOFT).font('Helvetica').fontSize(9);
      const guestLines = [
        data.guest.address,
        data.guest.phone,
        data.guest.email,
        data.guest.state ? `State: ${data.guest.state}` : null,
        data.guest.nationality ? `Nationality: ${data.guest.nationality}` : null,
        data.guest.gstin ? `GSTIN: ${data.guest.gstin}` : null,
      ].filter(Boolean) as string[];
      for (const line of guestLines) {
        doc.text(line, metaCol1X, billY, { width: metaColW });
        billY += 12;
      }

      // Invoice meta box (right)
      const metaRows: Array<[keyof typeof L, string]> = [
        ['INVOICE_NO',  data.folio.invoiceNumber],
        ['INVOICE_DT',  fmtDate(data.folio.invoiceDate)],
        ['BOOKING_REF', data.stay.bookingId || '—'],
        ['FOLIO_ID',    data.folio.id],
        ['POS',         data.placeOfSupply || data.hotel.state || 'N/A'],
      ];
      let metaY = y;
      const rowH = drawBilingual ? 18 : 15;
      doc.roundedRect(metaCol2X, y, metaColW, 10 + metaRows.length * rowH, 4)
         .lineWidth(0.5).strokeColor(HAIR).stroke();
      metaY += 6;
      for (const [key, value] of metaRows) {
        const lbl = label(key);
        doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
           .text(lbl.en, metaCol2X + 10, metaY, { width: metaColW / 2 - 10 });
        if (lbl.hi) {
          doc.font('Hindi').fontSize(7)
             .text(lbl.hi, metaCol2X + 10, metaY + 9, { width: metaColW / 2 - 10 });
        }
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
           .text(value || '—', metaCol2X + metaColW / 2, metaY - 1, {
             width: metaColW / 2 - 10, align: 'right',
           });
        metaY += rowH;
      }

      y = Math.max(billY, metaY) + 18;

      // ────────────── Stay details strip ──────────────
      const stayCols: Array<{ labelKey: keyof typeof L; value: string }> = [
        { labelKey: 'ROOM',      value: data.stay.roomName },
        { labelKey: 'CHECK_IN',  value: fmtDate(data.stay.actualCheckInAt || data.stay.checkInDate) },
        { labelKey: 'CHECK_OUT', value: fmtDate(data.stay.actualCheckOutAt || data.stay.checkOutDate) },
        { labelKey: 'NIGHTS',    value: String(computeNights(data.stay.checkInDate, data.stay.checkOutDate)) },
        { labelKey: 'GUESTS',    value: String(data.stay.numGuests || 1) },
      ];
      const stripH = drawBilingual ? 56 : 44;
      doc.roundedRect(M, y, INNER_W, stripH, 4).fill(HIGHLIGHT);
      const colW = INNER_W / stayCols.length;
      stayCols.forEach((c, i) => {
        const cx = M + i * colW;
        const lbl = label(c.labelKey);
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7)
           .text(lbl.en, cx + 12, y + 8, { width: colW - 20, characterSpacing: 1 });
        if (lbl.hi) {
          doc.font('Hindi-Bold').fontSize(6.5)
             .text(lbl.hi, cx + 12, y + 16, { width: colW - 20 });
        }
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(10)
           .text(c.value, cx + 12, y + (lbl.hi ? 28 : 22), { width: colW - 20 });
      });
      y += stripH + 16;

      // ────────────── LINE ITEMS TABLE ──────────────
      const colPositions = {
        num:  M,
        desc: M + 28,
        hsn:  M + INNER_W - 280,
        qty:  M + INNER_W - 220,
        rate: M + INNER_W - 170,
        tax:  M + INNER_W - 110,
        amt:  M + INNER_W - 60,
      };

      doc.rect(M, y, INNER_W, 22).fill(INK);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
      doc.text('#',                          colPositions.num  + 4, y + 8);
      doc.text(label('DESC').en,             colPositions.desc + 4, y + 8);
      doc.text(label('HSN').en,              colPositions.hsn,      y + 8);
      doc.text(label('QTY').en,              colPositions.qty,      y + 8, { width: 40, align: 'right' });
      doc.text(label('RATE').en,             colPositions.rate,     y + 8, { width: 50, align: 'right' });
      doc.text(label('TAX_PCT').en,          colPositions.tax,      y + 8, { width: 40, align: 'right' });
      doc.text(label('AMOUNT').en,           colPositions.amt - 20, y + 8, { width: 80, align: 'right' });
      y += 22;

      const sign = data.isCreditNote ? -1 : 1;
      const billableEntries = data.entries.filter(e => !['TAX', 'DISCOUNT', 'PAYMENT'].includes(e.entryType));
      doc.font('Helvetica').fontSize(9).fillColor(INK_SOFT);
      billableEntries.forEach((e, i) => {
        const rowY = y;
        const hsn = e.hsnCode || hsnForEntry(e.entryType);
        if (i % 2 === 1) {
          doc.rect(M, y - 2, INNER_W, 22).fill(HIGHLIGHT);
        }
        doc.fillColor(INK_SOFT).font('Helvetica').fontSize(9);
        doc.text(String(i + 1), colPositions.num + 4, rowY + 6, { width: 20 });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
           .text(e.description, colPositions.desc + 4, rowY + 6, { width: colPositions.hsn - colPositions.desc - 8, ellipsis: true });
        doc.fillColor(INK_SOFT).font('Helvetica').fontSize(8)
           .text(entryTypeLabel(e.entryType), colPositions.desc + 4, rowY + 16);
        doc.fillColor(INK_SOFT).font('Helvetica').fontSize(9);
        doc.text(hsn,                      colPositions.hsn,      rowY + 6);
        doc.text(String(e.quantity),       colPositions.qty,      rowY + 6, { width: 40, align: 'right' });
        doc.text(rupee(e.unitPrice * sign),colPositions.rate,     rowY + 6, { width: 50, align: 'right' });
        doc.text(`${e.gstRate ?? 0}%`,     colPositions.tax,      rowY + 6, { width: 40, align: 'right' });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
           .text(rupee(e.amount * sign),   colPositions.amt - 20, rowY + 6, { width: 80, align: 'right' });
        y += 22;
      });

      doc.moveTo(M, y).lineTo(PAGE_W - M, y).lineWidth(0.5).strokeColor(HAIR).stroke();
      y += 14;

      // ────────────── TOTALS ──────────────
      const totalsX = M + INNER_W - 240;
      const totalsW = 240;
      const labelW = 140;
      const valueW = 90;

      // Auto-determine GST split if sameStateGst not explicitly set:
      //   Indian hotel — if guest is in the same state as hotel → CGST + SGST, else → IGST
      let sameState: boolean;
      if (data.sameStateGst !== undefined) sameState = data.sameStateGst;
      else if (data.guest.state && data.hotel.state) {
        sameState = normaliseState(data.guest.state) === normaliseState(data.hotel.state);
      } else sameState = true; // default conservative
      const gstPct = data.folio.subtotal > 0 ? (data.folio.gstAmount / data.folio.subtotal) * 100 : 0;
      const cgst = sameState ? data.folio.gstAmount / 2 : 0;
      const sgst = sameState ? data.folio.gstAmount / 2 : 0;
      const igst = !sameState ? data.folio.gstAmount : 0;

      const drawTotalRow = (text: string, value: string, bold: boolean = false, accent: boolean = false) => {
        if (bold) {
          doc.rect(totalsX, y - 3, totalsW, 22).fill(ACCENT);
          doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11);
        } else {
          doc.fillColor(accent ? ACCENT : INK_SOFT)
             .font(accent ? 'Helvetica-Bold' : 'Helvetica')
             .fontSize(9.5);
        }
        doc.text(text, totalsX + 10, y + (bold ? 3 : 0), { width: labelW, align: 'left' });
        doc.text(value, totalsX + 10 + labelW, y + (bold ? 3 : 0), { width: valueW - 20, align: 'right' });
        y += bold ? 25 : 16;
      };

      drawTotalRow(label('SUBTOTAL').en, rupee(data.folio.subtotal * sign));
      if (data.folio.discount > 0) {
        drawTotalRow(label('DISCOUNT').en, `− ${rupee(data.folio.discount * sign)}`, false, true);
      }
      if (cgst > 0) drawTotalRow(`CGST @ ${(gstPct / 2).toFixed(1)}%`, rupee(cgst * sign));
      if (sgst > 0) drawTotalRow(`SGST @ ${(gstPct / 2).toFixed(1)}%`, rupee(sgst * sign));
      if (igst > 0) drawTotalRow(`IGST @ ${gstPct.toFixed(1)}%`,       rupee(igst * sign));
      y += 3;
      drawTotalRow(label('GRAND_TOTAL').en, rupee(data.folio.grandTotal * sign), true);

      y += 10;

      // Amount in words
      const amtLbl = label('AMT_WORDS');
      doc.roundedRect(M, y, INNER_W, drawBilingual ? 34 : 26, 4).fill(HIGHLIGHT);
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5)
         .text(amtLbl.en, M + 12, y + 5, { characterSpacing: 1.2 });
      if (amtLbl.hi) {
        doc.font('Hindi-Bold').fontSize(6.5)
           .text(amtLbl.hi, M + 12, y + 13);
      }
      doc.fillColor(INK).font('Helvetica-BoldOblique').fontSize(10)
         .text(rupeesInWords(Math.abs(data.folio.grandTotal)), M + 12, y + (amtLbl.hi ? 20 : 14), { width: INNER_W - 24 });
      y += (drawBilingual ? 44 : 36);

      // ────────────── PAYMENT STATUS ──────────────
      const statusText = data.isCreditNote
        ? 'REFUNDED / REVERSED'
        : data.folio.status.toUpperCase();
      const statusColor = data.isCreditNote ? '#c13b3b'
        : data.folio.status === 'settled' ? '#2d7d5a'
        : data.folio.status === 'voided'   ? '#6b5d52' : '#b96b0f';
      const statusBg    = data.isCreditNote ? '#fdf0f0'
        : data.folio.status === 'settled' ? '#edf7f2'
        : data.folio.status === 'voided'   ? '#f0ebe4' : '#fef6e7';

      doc.roundedRect(M, y, INNER_W, 40, 4).fillAndStroke(statusBg, statusColor);
      const paySLbl = label('PAY_STATUS');
      doc.fillColor(statusColor).font('Helvetica-Bold').fontSize(9)
         .text(paySLbl.en, M + 14, y + 6, { characterSpacing: 1 });
      if (paySLbl.hi) {
        doc.font('Hindi-Bold').fontSize(7)
           .text(paySLbl.hi, M + 14, y + 15);
      }
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(12)
         .text(statusText, M + 14, y + 22);
      if (data.folio.paymentMethod) {
        const mLbl = label('METHOD');
        doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
           .text(mLbl.en, M + INNER_W / 2, y + 10, { width: 80 });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(10)
           .text(data.folio.paymentMethod, M + INNER_W / 2, y + 22, { width: 80 });
      }
      if (data.folio.settledAt) {
        const sLbl = label('SETTLED_ON');
        doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
           .text(sLbl.en, M + INNER_W / 2 + 90, y + 10, { width: 120 });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(10)
           .text(fmtDateTime(data.folio.settledAt), M + INNER_W / 2 + 90, y + 22, { width: 120 });
      }
      y += 56;

      // ────────────── Terms + Signature ──────────────
      const termsLbl = label('TERMS');
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8)
         .text(termsLbl.en, M, y, { characterSpacing: 1 });
      doc.fillColor(INK_SOFT).font('Helvetica').fontSize(7.5);
      const terms = data.isCreditNote ? [
        '• This credit note reverses all or part of the original invoice.',
        '• Refund, if any, will be processed via the original payment method.',
        '• Retain this document for your records and GST filings.',
      ] : [
        '• Please retain this invoice as proof of payment.',
        '• Taxes are charged as per applicable Indian GST law.',
        '• For any discrepancy, contact the hotel within 7 days of check-out.',
        '• Subject to local jurisdiction.',
      ];
      let termY = y + 14;
      for (const t of terms) {
        doc.text(t, M, termY, { width: INNER_W * 0.55 });
        termY += 11;
      }

      // Signature
      doc.moveTo(PAGE_W - M - 150, y + 46)
         .lineTo(PAGE_W - M - 10,  y + 46)
         .lineWidth(0.5).strokeColor(INK).stroke();
      doc.fillColor(MUTED).font('Helvetica').fontSize(8)
         .text(label('AUTH_SIG').en, PAGE_W - M - 150, y + 50, { width: 140, align: 'center' });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
         .text(`For ${data.hotel.name}`, PAGE_W - M - 150, y + 12, { width: 140, align: 'center' });

      // ────────────── Footer ──────────────
      const footerY = PAGE_H - 40;
      doc.moveTo(M, footerY - 8).lineTo(PAGE_W - M, footerY - 8)
         .lineWidth(0.5).strokeColor(HAIR).stroke();
      doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(9)
         .text(label('THANK').en, M, footerY, { width: INNER_W / 2, align: 'left' });
      doc.fillColor(MUTED).font('Helvetica').fontSize(7)
         .text('Generated by Atithi Setu™ · Manhotra Consulting',
               M + INNER_W / 2, footerY + 2, { width: INNER_W / 2, align: 'right' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ─────────────────────────── Helpers ────────────────────────────

function rupee(n: number): string {
  const isNeg = n < 0;
  const abs = Math.abs(n || 0);
  const formatted = abs.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${isNeg ? '-' : ''}INR ${formatted}`;
}
function fmtDate(val: string | undefined): string {
  if (!val) return '—';
  const d = new Date(val);
  if (isNaN(d.getTime())) return val;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateTime(val: string | undefined): string {
  if (!val) return '—';
  const d = new Date(val);
  if (isNaN(d.getTime())) return val;
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function computeNights(checkIn: string, checkOut: string): number {
  const a = new Date(checkIn).getTime();
  const b = new Date(checkOut).getTime();
  return Math.max(1, Math.ceil((b - a) / 86400000));
}
function entryTypeLabel(t: string): string {
  switch (t) {
    case 'ROOM_CHARGE': return 'Accommodation';
    case 'SERVICE':     return 'Service charge';
    case 'F&B':         return 'Food & Beverage';
    default:            return t.replace(/_/g, ' ');
  }
}
function hsnForEntry(t: string): string {
  switch (t) {
    case 'ROOM_CHARGE': return '996311';
    case 'F&B':         return '996331';
    case 'SERVICE':     return '999799';
    default:            return '996311';
  }
}
// Normalise Indian state names for comparison ("Haryana", "HARYANA ", "haryana")
function normaliseState(s: string): string {
  return String(s || '').toLowerCase().trim().replace(/[\s\-_]+/g, '');
}
function rupeesInWords(amount: number): string {
  const n = Math.round(amount);
  const paise = Math.round((amount - n) * 100);
  const words = numberToIndianWords(n);
  const paiseWords = paise > 0 ? ` and ${numberToIndianWords(paise)} Paise` : '';
  return `Rupees ${words}${paiseWords} Only`;
}
function numberToIndianWords(num: number): string {
  if (num === 0) return 'Zero';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const twoDigit = (n: number): string => {
    if (n < 20) return ones[n];
    return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
  };
  const threeDigit = (n: number): string => {
    const h = Math.floor(n / 100);
    const rem = n % 100;
    return (h ? ones[h] + ' Hundred' + (rem ? ' ' : '') : '') + (rem ? twoDigit(rem) : '');
  };
  const crore = Math.floor(num / 10000000);
  num %= 10000000;
  const lakh = Math.floor(num / 100000);
  num %= 100000;
  const thousand = Math.floor(num / 1000);
  num %= 1000;
  const hundred = num;
  let out = '';
  if (crore)    out += twoDigit(crore)   + ' Crore ';
  if (lakh)     out += twoDigit(lakh)    + ' Lakh ';
  if (thousand) out += twoDigit(thousand) + ' Thousand ';
  if (hundred)  out += threeDigit(hundred);
  return out.trim();
}
