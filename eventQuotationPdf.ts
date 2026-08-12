/**
 * Atithi Setu — Events & Convention quotation (BEO) PDF generator.
 *
 * Self-contained pdfkit renderer for an event quotation. Deliberately kept
 * independent of the hotel invoice templates so it carries zero coupling to the
 * hotel billing module — a single clean A4 quotation the tenant emails to a
 * prospective customer.
 */

import PDFDocument from 'pdfkit';
import { existsSync } from 'fs';
import path from 'path';

// Resolve a "/uploads/foo.png" web path or an absolute FS path to a readable
// PNG/JPG for pdfkit's doc.image (which supports PNG + JPG only). Kept local so
// this renderer stays decoupled from the hotel invoice module.
function resolveEventLogoPath(p?: string): string | null {
  if (!p) return null;
  try {
    let abs: string;
    if (p.startsWith('/uploads/')) abs = path.join(process.cwd(), 'public', p.replace(/^\//, ''));
    else if (path.isAbsolute(p)) abs = p;
    else abs = path.join(process.cwd(), p);
    if (existsSync(abs) && ['.png', '.jpg', '.jpeg'].includes(path.extname(abs).toLowerCase())) return abs;
  } catch { /* swallow */ }
  return null;
}

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
  tenant: { name: string; address?: string; gstin?: string; phone?: string; email?: string; currency?: string; logoPath?: string };
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
  // Owner-authored policy blocks printed on the quotation AND the invoice.
  policies?: { cancellation?: string; terms?: string; payment?: string };
  lang2?: string;      // regional language code (hi/ta/te/kn/…), from tenant state
  langMode?: string;   // EN | REGIONAL | BOTH — how to print fixed labels
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

/**
 * Largest font size in [minSize, maxSize] at which `text` fits within `width` in
 * at most `maxLines` lines. Lets a long business name AUTO-SHRINK so a very long
 * legal name (e.g. "PARANDHAYYA'S CONVENTION CENTER PVT LTD") stays inside its
 * column in ≤ 2 lines instead of overflowing / stacking at a fixed 18pt.
 */
function fitFontSize(doc: any, text: string, width: number, maxSize: number, minSize: number, maxLines: number, font = 'Helvetica-Bold'): number {
  if (!text || width <= 0) return maxSize;
  doc.font(font);
  for (let s = maxSize; s >= minSize; s -= 0.5) {
    doc.fontSize(s);
    // heightOfString of N lines ≈ N × size × ~1.15; allow a little slack.
    if (doc.heightOfString(text, { width }) <= maxLines * s * 1.2 + 1) return s;
  }
  return minSize;
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

// Regional-script Noto fonts shipped with the VPS (fonts-noto package). Used to
// print invoice labels in the tenant state's language. Missing file → English.
const NOTO_DIR = '/usr/share/fonts/truetype/noto/';
const NOTO_SCRIPT: Record<string, string> = {
  hi: 'NotoSansDevanagari-Regular.ttf', mr: 'NotoSansDevanagari-Regular.ttf',
  ta: 'NotoSansTamil-Regular.ttf', te: 'NotoSansTelugu-Regular.ttf',
  kn: 'NotoSansKannada-Regular.ttf', ml: 'NotoSansMalayalam-Regular.ttf',
  bn: 'NotoSansBengali-Regular.ttf', gu: 'NotoSansGujarati-Regular.ttf',
  pa: 'NotoSansGurmukhi-Regular.ttf', or: 'NotoSansOriya-Regular.ttf',
};
// Fixed invoice labels per script. Any missing key falls back to English.
const INV_LABELS: Record<string, Record<string, string>> = {
  hi: { taxInvoice: 'कर चालान', invoice: 'चालान', quotation: 'कोटेशन', preparedFor: 'प्राप्तकर्ता', eventDetails: 'कार्यक्रम विवरण', subtotal: 'उप-योग', discount: 'छूट', cgst: 'सीजीएसटी', sgst: 'एसजीएसटी', grandTotal: 'कुल योग', notes: 'टिप्पणियाँ', gstin: 'जीएसटीआईएन' },
  ta: { taxInvoice: 'வரி விலைப்பட்டியல்', invoice: 'விலைப்பட்டியல்', quotation: 'விலைப்புள்ளி', preparedFor: 'பெறுநர்', eventDetails: 'நிகழ்வு விவரம்', subtotal: 'கூட்டுத்தொகை', discount: 'தள்ளுபடி', cgst: 'சிஜிஎஸ்டி', sgst: 'எஸ்ஜிஎஸ்டி', grandTotal: 'மொத்தத் தொகை', notes: 'குறிப்புகள்', gstin: 'ஜிஎஸ்டிஐஎன்' },
  te: { taxInvoice: 'పన్ను ఇన్‌వాయిస్', invoice: 'ఇన్‌వాయిస్', quotation: 'కొటేషన్', preparedFor: 'గ్రహీత', eventDetails: 'ఈవెంట్ వివరాలు', subtotal: 'ఉప మొత్తం', discount: 'తగ్గింపు', cgst: 'సీజీఎస్టీ', sgst: 'ఎస్జీఎస్టీ', grandTotal: 'మొత్తం', notes: 'గమనికలు', gstin: 'జీఎస్టీఐఎన్' },
  kn: { taxInvoice: 'ತೆರಿಗೆ ಸರಕುಪಟ್ಟಿ', invoice: 'ಸರಕುಪಟ್ಟಿ', quotation: 'ದರಪಟ್ಟಿ', preparedFor: 'ಗ್ರಾಹಕ', eventDetails: 'ಕಾರ್ಯಕ್ರಮ ವಿವರ', subtotal: 'ಉಪಮೊತ್ತ', discount: 'ರಿಯಾಯಿತಿ', cgst: 'ಸಿಜಿಎಸ್ಟಿ', sgst: 'ಎಸ್ಜಿಎಸ್ಟಿ', grandTotal: 'ಒಟ್ಟು ಮೊತ್ತ', notes: 'ಟಿಪ್ಪಣಿಗಳು', gstin: 'ಜಿಎಸ್ಟಿಐಎನ್' },
};

export async function generateEventQuotationPdf(data: EventQuotationData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      // Title-case the document type from docLabel so the browser-tab title (which
      // reads the PDF Title metadata) matches the document — "Tax Invoice INV-…"
      // for an invoice, not "Quotation INV-…".
      const docTitleType = (data.docLabel || 'QUOTATION').replace(/\b\w+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
      const doc = new PDFDocument({
        size: 'A4',
        margin: 0,
        info: {
          Title: `${docTitleType} ${data.quotation.quote_number}`,
          Author: data.tenant.name,
          Subject: `Event ${docTitleType.toLowerCase()} for ${data.booking.customer_name}`,
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      const cur = data.tenant.currency || 'INR';
      const PAGE_W = 595.28;
      const M = 42;

      // Bilingual label support. Register the tenant state's Noto font if present;
      // if the font is missing we silently stay English (never render .notdef boxes).
      const lang2 = String(data.lang2 || '').toLowerCase();
      const langMode = String(data.langMode || 'EN').toUpperCase();
      let regionalOk = false;
      if (lang2 && langMode !== 'EN' && NOTO_SCRIPT[lang2]) {
        try { const fp = NOTO_DIR + NOTO_SCRIPT[lang2]; if (existsSync(fp)) { doc.registerFont('regional', fp); doc.font('regional'); doc.font('Helvetica'); regionalOk = true; } } catch { regionalOk = false; }
      }
      const dict = INV_LABELS[lang2] || {};
      // L(en, key) → { t, f }: t is the string to draw, f is the font to use for it
      // ('regional' when the string carries regional script, else null = caller's Latin font).
      const L = (en: string, key: string): { t: string; f: string | null } => {
        if (!regionalOk || langMode === 'EN') return { t: en, f: null };
        const reg = dict[key];
        if (!reg) return { t: en, f: null };
        if (langMode === 'REGIONAL') return { t: reg, f: 'regional' };
        return { t: `${en} / ${reg}`, f: 'regional' };
      };
      const INNER = PAGE_W - M * 2;
      let y = M;

      // ── Header band — height grows to fit the identity block, and each line
      // advances by its MEASURED height so a long (wrapping) address never
      // overlaps the contact / GSTIN lines or pushes the GSTIN out of the band.
      const TOP = 22;
      // Two hard-bounded columns so NOTHING in the header can overflow into its
      // neighbour, whatever the language or the length of the name / invoice no:
      //   • left  = business identity, wrapped within idW
      //   • right = doc title + meta, wrapped within RIGHT_W (its own column)
      // A GUTTER keeps a gap between them; the band grows to the taller column.
      const RIGHT_W = 182;            // reserved right column for the doc-title + meta
      const GUTTER = 14;              // gap between the identity block and the right column
      const logoAbs = resolveEventLogoPath(data.tenant.logoPath);
      const idX = M + (logoAbs ? 66 : 0);
      const idW = INNER - RIGHT_W - GUTTER - (idX - M);
      const rx = PAGE_W - M - RIGHT_W; // left edge of the right column
      const nameStr = waSafe(data.tenant.name);
      const addrStr = data.tenant.address ? waSafe(data.tenant.address) : '';
      const contactStr = [data.tenant.phone, data.tenant.email].filter(Boolean).join('  ·  ');
      const gstStr = data.tenant.gstin ? `${L('GSTIN', 'gstin').t}: ${data.tenant.gstin}` : '';

      // Measure the LEFT identity block (each line wraps within idW).
      // Auto-shrink the business name (18 → 11pt) so a very long legal name
      // (e.g. "PARANDHAYYA'S CONVENTION CENTER PVT LTD") fits in ≤ 2 lines inside
      // its column instead of overflowing / stacking at a fixed 18pt.
      const nameSize = fitFontSize(doc, nameStr, idW, 18, 11, 2);
      const nameH = doc.font('Helvetica-Bold').fontSize(nameSize).heightOfString(nameStr, { width: idW });
      doc.font('Helvetica').fontSize(9);
      const addrH = addrStr ? doc.heightOfString(addrStr, { width: idW }) : 0;
      const contactH = contactStr ? doc.heightOfString(contactStr, { width: idW }) : 0;
      const gstH = gstStr ? doc.heightOfString(gstStr, { width: idW }) : 0;
      const idH = nameH + 4 + (addrH ? addrH + 2 : 0) + (contactH ? contactH + 2 : 0) + gstH;

      // Measure the RIGHT doc-title block (bounded to RIGHT_W so a bilingual
      // title or a long invoice number wraps inside the column instead of
      // spilling left over the business name — the reported header overlap).
      const docKey = data.docLabel === 'TAX INVOICE' ? 'taxInvoice' : data.docLabel === 'INVOICE' ? 'invoice' : 'quotation';
      const docL = L(data.docLabel || 'QUOTATION', docKey);
      const noStr = `No: ${data.quotation.quote_number}  (v${data.quotation.version})`;
      const issued = ymd(data.quotation.created_at) || new Date().toISOString().slice(0, 10);
      const docDateStr = `Date: ${issued}`;
      const validStr = data.quotation.valid_until ? `Valid until: ${ymd(data.quotation.valid_until)}` : '';
      const titleH = doc.font(docL.f || 'Helvetica-Bold').fontSize(16).heightOfString(docL.t, { width: RIGHT_W });
      doc.font('Helvetica').fontSize(9);
      const noH = doc.heightOfString(noStr, { width: RIGHT_W });
      const dateH = doc.heightOfString(docDateStr, { width: RIGHT_W });
      const validH = validStr ? doc.heightOfString(validStr, { width: RIGHT_W }) : 0;
      const rightH = titleH + 6 + noH + 2 + dateH + (validH ? 2 + validH : 0);

      const bandH = Math.max(96, TOP + Math.max(idH, rightH) + 12);
      doc.rect(0, 0, PAGE_W, bandH).fill(BAND);
      if (logoAbs) { try { doc.image(logoAbs, M, TOP, { fit: [54, 54] }); } catch { /* unreadable image — skip */ } }

      // Identity (left) — advance each line by its MEASURED height.
      let ty = TOP;
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(nameSize).text(nameStr, idX, ty, { width: idW }); ty += nameH + 4;
      doc.font('Helvetica').fontSize(9).fillColor(MUTED);
      if (addrStr) { doc.text(addrStr, idX, ty, { width: idW }); ty += addrH + 2; }
      if (contactStr) { doc.text(contactStr, idX, ty, { width: idW }); ty += contactH + 2; }
      if (gstStr) { const gL = L('GSTIN', 'gstin'); doc.font(gL.f || 'Helvetica').fontSize(9).fillColor(MUTED).text(gstStr, idX, ty, { width: idW }); doc.font('Helvetica'); }

      // Doc-title block (right) — bounded to the right column, measured advance.
      let ry = TOP + 2;
      doc.font(docL.f || 'Helvetica-Bold').fontSize(16).fillColor(ACCENT).text(docL.t, rx, ry, { width: RIGHT_W, align: 'right' }); ry += titleH + 6;
      doc.font('Helvetica').fontSize(9).fillColor(INK);
      doc.text(noStr, rx, ry, { width: RIGHT_W, align: 'right' }); ry += noH + 2;
      doc.text(docDateStr, rx, ry, { width: RIGHT_W, align: 'right' }); ry += dateH + 2;
      if (validStr) doc.text(validStr, rx, ry, { width: RIGHT_W, align: 'right' });

      y = bandH + 20;

      // ── Customer + event details ─────────────────────────────────────────
      const pfL = L('Prepared For', 'preparedFor'); const edL = L('Event Details', 'eventDetails');
      doc.font(pfL.f || 'Helvetica-Bold').fontSize(10).fillColor(INK).text(pfL.t, M, y, { width: INNER / 2 - 10 });
      doc.font(edL.f || 'Helvetica-Bold').fontSize(10).fillColor(INK).text(edL.t, M + INNER / 2, y);
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
      const totalRow = (en: string, key: string, val: string, bold = false) => {
        const lbl = L(en, key);
        doc.font(lbl.f || (bold ? 'Helvetica-Bold' : 'Helvetica')).fontSize(bold ? 10.5 : 9).fillColor(INK);
        doc.text(lbl.t, totX, y, { width: totW - 90, lineBreak: false });
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
        doc.text(val, totX + totW - 90, y, { width: 90, align: 'right' });
        y += bold ? 18 : 14;
      };
      totalRow('Subtotal', 'subtotal', fmtMoney(data.subtotal, cur));
      if (data.discount > 0) totalRow('Discount', 'discount', `- ${fmtMoney(data.discount, cur)}`);
      // GST-compliant tax presentation: split into CGST + SGST (intra-state) when
      // GST is charged; a zero-GST invoice shows no tax line.
      if (data.tax_amount > 0) {
        const cgst = Math.round((data.tax_amount / 2) * 100) / 100;
        const sgst = Math.round((data.tax_amount - cgst) * 100) / 100;
        totalRow('CGST', 'cgst', fmtMoney(cgst, cur));
        totalRow('SGST', 'sgst', fmtMoney(sgst, cur));
      }
      doc.moveTo(totX, y + 2).lineTo(totX + totW, y + 2).lineWidth(1).strokeColor(ACCENT).stroke();
      y += 6;
      totalRow('Grand Total', 'grandTotal', fmtMoney(data.grand_total, cur), true);

      // ── Notes + footer ───────────────────────────────────────────────────
      y += 18;
      if (data.quotation.notes) {
        const notes = waSafe(data.quotation.notes);
        const notesL = L('Notes', 'notes');
        doc.font(notesL.f || 'Helvetica-Bold').fontSize(9).fillColor(INK).text(notesL.t, M, y);
        y += 13;
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(notes, M, y, { width: INNER });
        y += doc.heightOfString(notes, { width: INNER }) + 12;
      }
      // ── Policies (Cancellation / Terms / Payment) — owner-authored, printed on
      // every quotation AND invoice. Page-break when a long block would overflow.
      const pol = data.policies || {};
      const polSections = ([
        ['Cancellation Policy', pol.cancellation],
        ['Terms & Conditions', pol.terms],
        ['Payment Terms', pol.payment],
      ] as [string, string | undefined][]).filter((s): s is [string, string] => !!(s[1] && String(s[1]).trim()));
      for (const [ph, body] of polSections) {
        const txt = waSafe(String(body).trim());
        const bodyH = doc.font('Helvetica').fontSize(8.5).heightOfString(txt, { width: INNER });
        if (y + bodyH + 26 > 812) { doc.addPage(); y = M; }
        doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(ph, M, y); y += 13;
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(txt, M, y, { width: INNER }); y += bodyH + 12;
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
