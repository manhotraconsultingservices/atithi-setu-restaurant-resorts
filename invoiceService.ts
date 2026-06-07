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
  ROUND_OFF:   { en: 'Round-off',                hi: 'राशि समायोजन' },
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
    fssai?: string | null;        // R-2 — 14-digit FSSAI licence (food-safety mandatory in India)
    fssaiValidUntil?: string | null;
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
  // Phase 2 — multi-currency + configurable tax. Optional. When absent we
  // default to the existing INR / GST behaviour so every Indian tenant
  // sees byte-identical output. Pass these from the server when the tenant
  // has switched country.
  tenant?: {
    country?: string;            // 'IN' | 'US' | 'CA' | 'AU' | ...
    currency_code?: string;      // 'INR' | 'USD' | ...
    currency_symbol?: string;    // '₹' | '$' | ...
    locale?: string;             // 'en-IN' | 'en-US' | ...
  };
  // If provided, replaces the auto CGST/SGST/IGST rendering with the
  // explicit list. Each line is rendered as a single row in the totals
  // panel. Indian intrastate tenants typically leave this undefined and
  // rely on the CGST/SGST split derived from gstAmount; international
  // tenants populate it with e.g. [{label:'Sales Tax', rate:8.875, amount:...}].
  taxLines?: Array<{ label: string; rate: number; amount: number }>;
  // M-6 (BCG follow-up) — round-off mode. When true, the PDF emits an
  // explicit "Round-off (±0.XX)" line and the grand total snaps to the
  // nearest whole rupee. Off by default — preserves current byte-for-byte
  // output for tenants who haven't opted in.
  roundToRupee?: boolean;
  // R-3 (BCG follow-up) — GST E-Invoice. When IRN is present, the PDF
  // renders the IRN string + the signed QR (base64-decoded into an
  // image block). Until the GSP returns IRN we render an "IRN PENDING"
  // marker so staff knows the invoice isn't yet a valid GST document.
  irn?: {
    irn?: string | null;            // 64-char hex hash from IRP
    ackNo?: string | null;          // IRP acknowledgement number
    ackDate?: string | null;        // ISO date
    signedQrCode?: string | null;   // base64 PNG (preferred) or signed payload
    status?: string | null;         // PENDING | GENERATED | CANCELLED | FAILED
    eInvoiceMandatory?: boolean;    // tenant ≥₹5cr threshold → must show
  };
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
      // PDF-FIX (client report: "Grand Total getting trimmed"): A4 page
      // height is 842 but the footer renders at PAGE_H-40 = 802. After
      // M-5 (per-rate CGST/SGST), M-6 (round-off), R-2 (FSSAI line),
      // and R-3 (IRN block, +86px) the totals + payment-status + signature
      // block can spill past 802 and PDFKit silently CLIPS it (manual
      // y-positioned drawings do NOT auto-paginate — only doc.text with
      // no explicit y does). Result: client sees Grand Total clipped or
      // amount-in-words missing on folios with > ~10 line items.
      //
      // Fix: keep a single content-bottom budget and force-break before
      // each major block when remaining space < needed.
      const CONTENT_BOTTOM = PAGE_H - 60; // 60px reserved for footer + padding
      const ensureSpace = (needed: number) => {
        if (y + needed > CONTENT_BOTTOM) {
          doc.addPage();
          // Repaint the brand strip on continuation pages and reset y.
          doc.rect(0, 0, PAGE_W, 6).fill(ACCENT);
          y = 30;
        }
      };

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
        // R-2 (BCG follow-up) — FSSAI licence is mandatory on every Indian
        // food-business invoice. Sec 31 FSS Act, 2006 + Sec 7(3) FSS
        // (Licensing & Registration) Regulations, 2011. Render directly
        // below the GSTIN so an inspector can see both in one glance.
        data.hotel.fssai ? `FSSAI Lic: ${data.hotel.fssai}${data.hotel.fssaiValidUntil ? ` (valid until ${data.hotel.fssaiValidUntil})` : ''}` : null,
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
      // COLUMN-FIT (client report: "Rate column overflowing"):
      // Old layout had a 50 px RATE column which couldn't hold
      // "INR 1,500.00" (~62 px at fontSize 9) → wrapped to two lines.
      // Two changes together solve it:
      //   1) Drop the currency code from per-row values (use
      //      moneyNumeric instead of money). Currency stays explicit
      //      on TOTALS where it belongs.
      //   2) Slightly redistribute columns so RATE + AMOUNT both have
      //      breathing room for 5-digit Indian numbers like
      //      "1,24,500.00" and DESCRIPTION gets a bit more space too.
      // Currency-symbol-aware header labels make it crystal-clear
      // what currency the numbers are in even when staff scan only
      // the table.
      const currencySym = data.tenant?.currency_symbol || '₹';
      const colPositions = {
        num:  M,
        desc: M + 28,
        hsn:  M + INNER_W - 270,   // was -280 (5 px more for desc)
        qty:  M + INNER_W - 215,   // was -220
        rate: M + INNER_W - 170,   // unchanged
        tax:  M + INNER_W - 100,   // was -110
        amt:  M + INNER_W - 60,    // unchanged
      };

      doc.rect(M, y, INNER_W, 22).fill(INK);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
      doc.text('#',                          colPositions.num  + 4, y + 8);
      doc.text(label('DESC').en,             colPositions.desc + 4, y + 8);
      doc.text(label('HSN').en,              colPositions.hsn,      y + 8);
      doc.text(label('QTY').en,              colPositions.qty,      y + 8, { width: 40, align: 'right' });
      doc.text(`${label('RATE').en} (${currencySym})`,   colPositions.rate, y + 8, { width: 65, align: 'right' });
      doc.text(label('TAX_PCT').en,          colPositions.tax,      y + 8, { width: 40, align: 'right' });
      doc.text(`${label('AMOUNT').en} (${currencySym})`, colPositions.amt - 20, y + 8, { width: 80, align: 'right' });
      y += 22;

      const sign = data.isCreditNote ? -1 : 1;
      const billableEntries = data.entries.filter(e => !['TAX', 'DISCOUNT', 'PAYMENT'].includes(e.entryType));
      doc.font('Helvetica').fontSize(9).fillColor(INK_SOFT);
      billableEntries.forEach((e, i) => {
        // PDF-FIX: paginate if this row + a sensible-sized totals/IRN/payment
        // tail wouldn't fit. We reserve ~280px for the post-items section
        // (totals + amount-in-words + IRN + payment + terms/signature). If
        // the next 22px row would breach the bottom budget, break here so
        // the totals always land on a page with enough room.
        ensureSpace(22);
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
        // COLUMN-FIT: numeric-only (no currency prefix) — fits cleanly
        // in the 65/80 px columns. Currency is shown in the header label
        // "(₹)" and again on every TOTALS row, so no info is lost.
        doc.text(moneyNumeric(data.tenant, e.unitPrice * sign), colPositions.rate, rowY + 6, { width: 65, align: 'right' });
        doc.text(`${e.gstRate ?? 0}%`,                          colPositions.tax,  rowY + 6, { width: 40, align: 'right' });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
           .text(moneyNumeric(data.tenant, e.amount * sign),    colPositions.amt - 20, rowY + 6, { width: 80, align: 'right' });
        y += 22;
      });

      doc.moveTo(M, y).lineTo(PAGE_W - M, y).lineWidth(0.5).strokeColor(HAIR).stroke();
      y += 14;

      // ────────────── TOTALS ──────────────
      const totalsX = M + INNER_W - 240;
      const totalsW = 240;
      const labelW = 140;
      const valueW = 90;

      // Phase 2: country-aware tax rendering. India keeps the existing
      // CGST/SGST/IGST split exactly — every Indian tenant sees identical
      // numeric and label output. Non-India tenants emit a generic loop
      // driven by data.taxLines (populated by the server from tax_config).
      const tenantCountry = (data.tenant?.country || 'IN').toUpperCase();
      const isIndia = tenantCountry === 'IN';
      let sameState: boolean;
      if (data.sameStateGst !== undefined) sameState = data.sameStateGst;
      else if (data.guest.state && data.hotel.state) {
        sameState = normaliseState(data.guest.state) === normaliseState(data.hotel.state);
      } else sameState = true; // default conservative

      // ─── M-5 (BCG follow-up) — per-rate GST rendering ────────────────
      // Hotel stays that cross slab boundaries (night 1 at ₹6,000 → 12%,
      // night 2 at ₹8,000 → 18%) used to render with a single averaged
      // rate — numerically the totals were right, but reading the PDF
      // looked wrong ("GST @ 14.4%" is not a real slab). Now we group
      // billable entries by their actual gst_rate and emit one CGST/SGST
      // (or IGST) pair per distinct rate. Single-rate stays render
      // byte-identically to before.
      type RateGroup = { rate: number; taxable: number; gst: number };
      const rateGroups: RateGroup[] = (() => {
        // Pull only entries that carry a gst_rate. If every entry shares
        // the same rate (or rate metadata is missing), fall back to the
        // legacy folio-level rate so we don't change output for the 90%
        // of stays that don't cross a boundary.
        const groups = new Map<number, { taxable: number; gst: number }>();
        let withRate = 0;
        for (const e of billableEntries) {
          if (e.gstRate == null) continue;
          withRate++;
          const r = Math.round(Number(e.gstRate) * 100) / 100;
          const g = groups.get(r) || { taxable: 0, gst: 0 };
          g.taxable += Number(e.amount || 0);
          g.gst     += Number(e.gstAmount || 0);
          groups.set(r, g);
        }
        if (withRate === 0 || groups.size <= 1) return [];
        return [...groups.entries()].map(([rate, v]) => ({ rate, taxable: v.taxable, gst: v.gst }))
          .sort((a, b) => a.rate - b.rate);
      })();
      const useMultiRate = rateGroups.length > 1;

      const gstPct = data.folio.subtotal > 0 ? (data.folio.gstAmount / data.folio.subtotal) * 100 : 0;
      const cgst = (isIndia && sameState) ? data.folio.gstAmount / 2 : 0;
      const sgst = (isIndia && sameState) ? data.folio.gstAmount / 2 : 0;
      const igst = (isIndia && !sameState) ? data.folio.gstAmount : 0;

      const drawTotalRow = (text: string, value: string, bold: boolean = false, accent: boolean = false) => {
        // PDF-FIX: never let the GRAND TOTAL bold row clip. Bold rows
        // (GRAND_TOTAL is the prime example) draw a 22px accent rect at
        // y-3 — if we're near the bottom edge, page-break first so the
        // entire row sits on the new page intact rather than ribboned.
        ensureSpace(bold ? 25 : 16);
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

      // Phase 2: format every line via money(tenant, n). For Indian tenants
      // this resolves to "INR <num>" exactly as rupee() did before — see
      // the rupee() function at the bottom which is now a thin wrapper.
      const m = (n: number) => money(data.tenant, n);
      drawTotalRow(label('SUBTOTAL').en, m(data.folio.subtotal * sign));
      if (data.folio.discount > 0) {
        drawTotalRow(label('DISCOUNT').en, `− ${m(data.folio.discount * sign)}`, false, true);
      }
      if (isIndia) {
        if (useMultiRate) {
          // M-5 — emit one CGST+SGST (or IGST) pair per distinct slab,
          // so readers see e.g. "CGST @ 6% ₹360 · SGST @ 6% ₹360 ·
          // CGST @ 9% ₹720 · SGST @ 9% ₹720" instead of a fictional
          // averaged rate.
          for (const g of rateGroups) {
            const r = g.rate;
            if (sameState) {
              const half = Math.round((g.gst / 2) * 100) / 100;
              if (half > 0) drawTotalRow(`CGST @ ${(r / 2).toFixed(1)}%`, m(half * sign));
              if (half > 0) drawTotalRow(`SGST @ ${(r / 2).toFixed(1)}%`, m(half * sign));
            } else {
              if (g.gst > 0) drawTotalRow(`IGST @ ${r.toFixed(1)}%`, m(g.gst * sign));
            }
          }
        } else {
          if (cgst > 0) drawTotalRow(`CGST @ ${(gstPct / 2).toFixed(1)}%`, m(cgst * sign));
          if (sgst > 0) drawTotalRow(`SGST @ ${(gstPct / 2).toFixed(1)}%`, m(sgst * sign));
          if (igst > 0) drawTotalRow(`IGST @ ${gstPct.toFixed(1)}%`,       m(igst * sign));
        }
      } else if (data.taxLines && data.taxLines.length > 0) {
        for (const line of data.taxLines) {
          drawTotalRow(`${line.label} @ ${Number(line.rate || 0).toFixed(1)}%`, m(line.amount * sign));
        }
      } else if (data.folio.gstAmount > 0) {
        // Non-India tenant with no explicit taxLines — fall back to a
        // single generic Tax row using the country's likely label.
        const fallbackLabel = tenantCountry === 'US' ? 'Sales Tax'
                            : tenantCountry === 'AU' ? 'GST'
                            : 'Tax';
        drawTotalRow(`${fallbackLabel} @ ${gstPct.toFixed(1)}%`, m(data.folio.gstAmount * sign));
      }
      y += 3;
      // M-6 — optional round-off line. Tenant opts in via
      // `restaurants.round_invoice_to_rupee`. When enabled, the grand
      // total snaps to the nearest whole rupee and the delta is shown
      // explicitly so accountants can reconcile. Default off — preserves
      // existing byte-identical output for tenants who haven't opted in.
      const rawGrand = Number(data.folio.grandTotal || 0);
      let displayedGrand = rawGrand;
      if (data.roundToRupee) {
        const rounded = Math.round(rawGrand);
        const roundOff = Math.round((rounded - rawGrand) * 100) / 100;
        if (Math.abs(roundOff) >= 0.01) {
          const prefix = roundOff >= 0 ? '+ ' : '− ';
          drawTotalRow(label('ROUND_OFF').en, `${prefix}${m(Math.abs(roundOff) * sign)}`, false, true);
        }
        displayedGrand = rounded;
      }
      drawTotalRow(label('GRAND_TOTAL').en, m(displayedGrand * sign), true);

      y += 10;

      // Amount in words
      // PDF-FIX: keep the words box on the same page as enough to follow.
      const _amtBoxH = drawBilingual ? 34 : 26;
      ensureSpace(_amtBoxH + 10);
      const amtLbl = label('AMT_WORDS');
      doc.roundedRect(M, y, INNER_W, _amtBoxH, 4).fill(HIGHLIGHT);
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5)
         .text(amtLbl.en, M + 12, y + 5, { characterSpacing: 1.2 });
      if (amtLbl.hi) {
        doc.font('Hindi-Bold').fontSize(6.5)
           .text(amtLbl.hi, M + 12, y + 13);
      }
      // M-6 — when round-to-rupee was applied above, the amount-in-words
      // must reflect the displayed (rounded) grand, not the raw value.
      doc.fillColor(INK).font('Helvetica-BoldOblique').fontSize(10)
         .text(amountInWords(Math.abs(displayedGrand), data.tenant), M + 12, y + (amtLbl.hi ? 20 : 14), { width: INNER_W - 24 });
      y += (drawBilingual ? 44 : 36);

      // ────────────── R-3: GST E-INVOICE (IRN) ──────────────
      // Per Notification 13/2020 read with 10/2023, every B2B invoice
      // issued by a tenant ≥₹5cr aggregate turnover MUST carry the IRN
      // and signed QR returned by the IRP. We render:
      //   • IRN string + ACK number (machine-readable text)
      //   • Signed QR as an image (PNG bytes, expected base64-encoded)
      //   • Or "IRN PENDING" notice when the GSP hasn't responded yet
      const irn = data.irn;
      if (irn && (irn.eInvoiceMandatory || irn.irn || irn.status)) {
        const isGenerated = String(irn.status || '').toUpperCase() === 'GENERATED' && irn.irn;
        const irnBoxH = isGenerated ? 86 : 44;
        // PDF-FIX: the IRN box is the biggest single contributor that pushed
        // grand-total / amount-in-words off the page on long folios. Force
        // a page break when there isn't room for the whole box + trailer.
        ensureSpace(irnBoxH + 12);
        const irnBg = isGenerated ? '#f0f7f3' : '#fff5e6';
        const irnBorder = isGenerated ? '#2d7d5a' : '#cc5a16';
        doc.roundedRect(M, y, INNER_W, irnBoxH, 4).fillAndStroke(irnBg, irnBorder);
        doc.fillColor(irnBorder).font('Helvetica-Bold').fontSize(8.5)
           .text(isGenerated ? 'GST E-INVOICE (IRN)' : 'GST E-INVOICE — IRN PENDING',
                 M + 12, y + 7, { characterSpacing: 0.8 });
        if (isGenerated) {
          // Left column: IRN + ACK text
          doc.fillColor(INK_SOFT).font('Helvetica').fontSize(7.5)
             .text('IRN', M + 12, y + 22);
          doc.fillColor(INK).font('Helvetica-Bold').fontSize(7.5)
             .text(String(irn.irn || '').slice(0, 64), M + 12, y + 32, { width: INNER_W - 110 });
          if (irn.ackNo) {
            doc.fillColor(INK_SOFT).font('Helvetica').fontSize(7.5)
               .text(`ACK ${irn.ackNo}${irn.ackDate ? ' · ' + irn.ackDate : ''}`,
                     M + 12, y + 56);
          }
          // Right side: signed QR as embedded image when present.
          if (irn.signedQrCode) {
            try {
              // Accept either a raw base64 PNG or a data: URL. The IRP
              // returns the QR as base64 of a PNG (or as a signed
              // payload that the GSP renders into a PNG on our behalf).
              let qrBytes: Buffer | null = null;
              const raw = String(irn.signedQrCode);
              if (raw.startsWith('data:image/')) {
                const comma = raw.indexOf(',');
                if (comma > 0) qrBytes = Buffer.from(raw.slice(comma + 1), 'base64');
              } else if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length > 200) {
                qrBytes = Buffer.from(raw.replace(/\s+/g, ''), 'base64');
              }
              if (qrBytes) {
                doc.image(qrBytes, PAGE_W - M - 78, y + 6, { fit: [70, 70] } as any);
              } else {
                doc.fillColor(MUTED).font('Helvetica').fontSize(6.5)
                   .text('QR not previewable here — scan the source.', PAGE_W - M - 130, y + 60, { width: 120 });
              }
            } catch {
              // ignore image failure — text IRN is still legally sufficient
            }
          }
        } else {
          // PENDING / FAILED state — surface it loudly so staff know to follow up.
          doc.fillColor(INK_SOFT).font('Helvetica').fontSize(8.5)
             .text(
               irn.eInvoiceMandatory
                 ? 'This invoice will be replaced by an IRN-stamped version after the GSP returns IRP confirmation. Per Sec 31(1) CGST Rules, an e-invoice without IRN is not a valid tax invoice for B2B sales.'
                 : 'IRN registration pending.',
               M + 12, y + 22, { width: INNER_W - 24 }
             );
        }
        y += irnBoxH + 12;
      }

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

      // PDF-FIX: payment status banner is 40px + 16px gap; force-break if tight.
      ensureSpace(56);
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
      // PDF-FIX: ~80px for terms+signature block; force-break if tight.
      ensureSpace(80);
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

// Phase 2 currency formatter. Returns "<CODE> <amount>" using the tenant's
// configured locale & code; falls back to the exact "INR <amount>" format
// (en-IN locale) when no tenant context is supplied — preserving the
// pre-Phase-2 byte output for every Indian invoice in production.
function money(
  tenant: InvoiceData['tenant'] | undefined,
  n: number,
): string {
  const isNeg = n < 0;
  const abs = Math.abs(n || 0);
  const code   = tenant?.currency_code || 'INR';
  const locale = tenant?.locale        || 'en-IN';
  let formatted: string;
  try {
    formatted = abs.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    formatted = abs.toFixed(2);
  }
  return `${isNeg ? '-' : ''}${code} ${formatted}`;
}

// COLUMN-FIT (client report: "Rate column overflowing"): numeric-only
// variant of money() used inside the line-items table. The RATE column
// is 50 px wide — "INR 1,500.00" (~62 px at Helvetica 9) wraps to two
// lines, ribboning the row. Industry-standard invoice convention is to
// show currency ONCE on the totals section and numeric-only values in
// the table itself (Tally, QuickBooks, Stripe, Zoho all do this). The
// totals section keeps using money() so the currency stays explicit.
function moneyNumeric(
  tenant: InvoiceData['tenant'] | undefined,
  n: number,
): string {
  const isNeg = n < 0;
  const abs = Math.abs(n || 0);
  const locale = tenant?.locale || 'en-IN';
  let formatted: string;
  try {
    formatted = abs.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    formatted = abs.toFixed(2);
  }
  return `${isNeg ? '-' : ''}${formatted}`;
}
// Backwards-compatible alias retained for the few remaining call sites
// (amount-in-words, etc.). Equivalent to money(undefined, n).
function rupee(n: number): string { return money(undefined, n); }
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
    case 'ROOM_CHARGE':    return 'Accommodation';
    case 'SERVICE':        return 'Service charge';
    case 'SERVICE_CHARGE': return 'Service charge';   // Phase H2 — per-night charge on rooms
    case 'F&B':            return 'Food & Beverage';
    default:               return t.replace(/_/g, ' ');
  }
}
function hsnForEntry(t: string): string {
  switch (t) {
    case 'ROOM_CHARGE':    return '996311';
    case 'F&B':            return '996331';
    case 'SERVICE':        return '999799';
    case 'SERVICE_CHARGE': return '996311';  // Bundled with the room — same accommodation HSN
    default:               return '996311';
  }
}
// Normalise Indian state names for comparison ("Haryana", "HARYANA ", "haryana")
function normaliseState(s: string): string {
  return String(s || '').toLowerCase().trim().replace(/[\s\-_]+/g, '');
}
function rupeesInWords(amount: number): string {
  // Kept for backwards compatibility — equivalent to the tenant-less call.
  return amountInWords(amount, undefined);
}
// Phase 2: tenant-aware "amount in words" renderer. India keeps the exact
// "Rupees ... Only" output; other currencies use a generic format. The
// minor-unit word ("Paise" / "Cents" / "Pence") is picked per code.
function amountInWords(amount: number, tenant: InvoiceData['tenant'] | undefined): string {
  const code = (tenant?.currency_code || 'INR').toUpperCase();
  const n = Math.round(amount);
  const minor = Math.round((amount - n) * 100);
  const words = numberToIndianWords(n);
  if (code === 'INR') {
    const paiseWords = minor > 0 ? ` and ${numberToIndianWords(minor)} Paise` : '';
    return `Rupees ${words}${paiseWords} Only`;
  }
  const minorUnit =
    code === 'USD' || code === 'CAD' || code === 'AUD' ? 'Cents'
    : code === 'GBP' ? 'Pence'
    : code === 'EUR' ? 'Cents'
    : 'Minor';
  const noun =
    code === 'USD' ? 'US Dollars'
    : code === 'CAD' ? 'Canadian Dollars'
    : code === 'AUD' ? 'Australian Dollars'
    : code === 'GBP' ? 'Pounds'
    : code === 'EUR' ? 'Euros'
    : code;
  const minorWords = minor > 0 ? ` and ${numberToIndianWords(minor)} ${minorUnit}` : '';
  return `${noun} ${words}${minorWords} Only`;
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
