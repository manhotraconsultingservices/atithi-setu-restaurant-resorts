/**
 * Atithi Setu — Invoice rendering — SHARED HELPERS
 * ─────────────────────────────────────────────────────────────────────────────
 * BCG Phase 0 (7 Jun 2026). The original invoiceService.ts had grown to ~970
 * lines mixing pure helpers (money formatting, date formatting, HSN lookup,
 * amount-in-words, label dictionary) with PDF-drawing logic. Phase 1 ships a
 * second template ("Boutique") alongside the existing "Classic" — both need
 * the same helpers. This file is the shared base that BOTH templates import.
 *
 * What lives here:
 *   • The bilingual label dictionary (L)
 *   • The InvoiceData interface (contract with the server)
 *   • Pure helpers: money, moneyNumeric, rupee, fmtDate, fmtDateTime,
 *     computeNights, entryTypeLabel, hsnForEntry, normaliseState,
 *     amountInWords, numberToIndianWords
 *   • PDF page constants (PAGE_W, PAGE_H, INNER_W, design tokens for ink /
 *     accent / hair / highlight colours)
 *   • Hindi font path resolution + the `HAS_HINDI_FONT` runtime flag
 *   • resolveLogoPath(): web-path-or-absolute-path → safe abs path for PDFKit
 *
 * What does NOT live here:
 *   • Any rendering logic (header, line items, totals, footer) — that stays
 *     in invoiceService.ts (Classic) and invoiceServiceBoutique.ts.
 *   • Tax math / RateGroup computation — currently still inline in Classic
 *     because the Boutique scope for Phase 1 reuses Classic's totals logic
 *     verbatim. Phase 2 (category grouping) will extract that.
 *
 * Backwards compatibility:
 *   Every export was previously a private definition inside invoiceService.ts.
 *   This refactor moves the source of truth here and has invoiceService.ts
 *   re-import; the externally observable PDF output is byte-identical for
 *   every tenant in production. There is NO new code path until Phase 1
 *   adds the dispatcher.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ─────────────────────────────────────────────────────────────────────
// Hindi font resolution (Devanagari labels for the bilingual variant)
// ─────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

export const HINDI_REG  = path.join(__dirname, 'assets', 'fonts', 'NotoSansDevanagari-Regular.ttf');
export const HINDI_BOLD = path.join(__dirname, 'assets', 'fonts', 'NotoSansDevanagari-Bold.ttf');

export const HAS_HINDI_FONT: boolean = (() => {
  try { return fs.existsSync(HINDI_REG) && fs.existsSync(HINDI_BOLD); } catch { return false; }
})();

// ─────────────────────────────────────────────────────────────────────
// Bilingual label dictionary (English + Devanagari)
// ─────────────────────────────────────────────────────────────────────

export const L = {
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
export type LabelKey = keyof typeof L;

// ─────────────────────────────────────────────────────────────────────
// InvoiceData — the public contract between server.ts and the renderers
// ─────────────────────────────────────────────────────────────────────

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
    // BCG Phase 1 (7 Jun 2026) — invoice template selector. 'CLASSIC' is
    // the historical layout; 'BOUTIQUE' is the new opt-in design with
    // logo lock-up + paid/unpaid stamp + summary band + boxed grand total.
    // Server reads this from restaurants.invoice_template; when omitted
    // (legacy callers, headless tools) the dispatcher defaults to CLASSIC
    // so production invoices stay byte-identical until an owner switches.
    invoice_template?: 'CLASSIC' | 'BOUTIQUE' | null;
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

// ─────────────────────────────────────────────────────────────────────
// Page & design constants (A4 portrait, with the design tokens shared
// across Classic and Boutique). Boutique may override ACCENT or add its
// own tokens, but the page geometry stays uniform.
// ─────────────────────────────────────────────────────────────────────

export const PAGE_W = 595;     // A4 portrait width in PDF points
export const PAGE_H = 842;     // A4 portrait height in PDF points
export const M = 40;           // outer margin (all four sides)
export const INNER_W = PAGE_W - M * 2; // = 515
// PDF-FIX (client report: "Grand Total getting trimmed"): A4 height is 842
// but the footer renders at PAGE_H-40 = 802. After M-5 (per-rate CGST/SGST),
// M-6 (round-off), R-2 (FSSAI line), and R-3 (IRN block, +86px) the totals
// + payment-status + signature block can spill past 802 and PDFKit silently
// CLIPS it (manual y-positioned drawings do NOT auto-paginate — only doc.text
// with no explicit y does). Both templates share the same content-bottom
// budget and the same ensureSpace() pattern.
export const CONTENT_BOTTOM = PAGE_H - 60;

// Brand / ink tokens. Classic uses these directly; Boutique extends them
// with a serif display face mapping (loaded inside the Boutique renderer).
export const INK       = '#14110c';   // primary text
export const INK_SOFT  = '#3d3128';   // secondary text
export const MUTED     = '#6b5d52';   // tertiary / labels / footers
export const HAIR      = '#e8dccf';   // hairline borders + dividers
export const HIGHLIGHT = '#faf7f2';   // zebra band / amount-words background

// Accent depends on whether this is an invoice or a credit note — the
// classic ochre vs the safety red. Helper rather than constant so each
// renderer can pass in their data.
export function accentFor(isCreditNote?: boolean): string {
  return isCreditNote ? '#c13b3b' : '#cc5a16';
}

// ─────────────────────────────────────────────────────────────────────
// resolveLogoPath: tolerate "/uploads/foo.png" web paths and absolute
// filesystem paths interchangeably. Returns null if not readable / wrong
// extension. PDFKit's image() supports PNG + JPG only.
// ─────────────────────────────────────────────────────────────────────

export function resolveLogoPath(p?: string): string | null {
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
      if (['.png', '.jpg', '.jpeg'].includes(ext)) return abs;
    }
  } catch { /* swallow */ }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Currency formatting
// ─────────────────────────────────────────────────────────────────────

// Phase 2 currency formatter. Returns "<CODE> <amount>" using the tenant's
// configured locale & code; falls back to the exact "INR <amount>" format
// (en-IN locale) when no tenant context is supplied — preserving the
// pre-Phase-2 byte output for every Indian invoice in production.
export function money(tenant: InvoiceData['tenant'] | undefined, n: number): string {
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

// COLUMN-FIT (client report: "Rate column overflowing"): numeric-only variant
// of money() used inside the line-items table. The RATE column is narrow —
// "INR 1,500.00" wraps to two lines, ribboning the row. Industry-standard
// invoice convention is to show currency ONCE in the column header and
// numeric-only values in the table cells (Tally, QuickBooks, Stripe, Zoho
// all do this). The totals section keeps using money() so the currency
// stays explicit there.
export function moneyNumeric(tenant: InvoiceData['tenant'] | undefined, n: number): string {
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

// Backwards-compatible alias retained for any remaining call sites that
// still call rupee(n). Equivalent to money(undefined, n).
export function rupee(n: number): string { return money(undefined, n); }

// ─────────────────────────────────────────────────────────────────────
// Date formatting (Indian locale by default)
// ─────────────────────────────────────────────────────────────────────

export function fmtDate(val: string | undefined): string {
  if (!val) return '—';
  const d = new Date(val);
  if (isNaN(d.getTime())) return val;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateTime(val: string | undefined): string {
  if (!val) return '—';
  const d = new Date(val);
  if (isNaN(d.getTime())) return val;
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function computeNights(checkIn: string, checkOut: string): number {
  const a = new Date(checkIn).getTime();
  const b = new Date(checkOut).getTime();
  return Math.max(1, Math.ceil((b - a) / 86400000));
}

// ─────────────────────────────────────────────────────────────────────
// Entry-type metadata (human label + Indian GST HSN/SAC code)
// ─────────────────────────────────────────────────────────────────────

export function entryTypeLabel(t: string): string {
  switch (t) {
    case 'ROOM_CHARGE':    return 'Accommodation';
    case 'SERVICE':        return 'Service charge';
    case 'SERVICE_CHARGE': return 'Service charge';   // Phase H2 — per-night charge on rooms
    case 'F&B':            return 'Food & Beverage';
    default:               return t.replace(/_/g, ' ');
  }
}

export function hsnForEntry(t: string): string {
  switch (t) {
    case 'ROOM_CHARGE':    return '996311';
    case 'F&B':            return '996331';
    case 'SERVICE':        return '999799';
    case 'SERVICE_CHARGE': return '996311';  // Bundled with the room — same accommodation HSN
    default:               return '996311';
  }
}

// BCG Phase 1: bucket entryType into a Boutique-friendly category for the
// summary band ("Accommodation / Food & Beverage / Services / Other"). Used
// only by the Boutique renderer — Classic still emits one row per entry.
export type EntryCategory = 'ACCOMMODATION' | 'FNB' | 'SERVICE' | 'OTHER';
export function categoryForEntry(t: string): EntryCategory {
  switch (t) {
    case 'ROOM_CHARGE':
    case 'SERVICE_CHARGE': // bundled with room
      return 'ACCOMMODATION';
    case 'F&B':            return 'FNB';
    case 'SERVICE':        return 'SERVICE';
    default:               return 'OTHER';
  }
}

export function categoryLabel(c: EntryCategory): string {
  switch (c) {
    case 'ACCOMMODATION': return 'Accommodation';
    case 'FNB':           return 'Food & Beverage';
    case 'SERVICE':       return 'Services';
    case 'OTHER':         return 'Other charges';
  }
}

// ─────────────────────────────────────────────────────────────────────
// Indian state normalisation (CGST/SGST same-state determination)
// ─────────────────────────────────────────────────────────────────────

// Normalise Indian state names for comparison ("Haryana", "HARYANA ", "haryana")
export function normaliseState(s: string): string {
  return String(s || '').toLowerCase().trim().replace(/[\s\-_]+/g, '');
}

// ─────────────────────────────────────────────────────────────────────
// Amount-in-words (Indian numbering: Lakh / Crore)
// ─────────────────────────────────────────────────────────────────────

// Phase 2: tenant-aware "amount in words" renderer. India keeps the exact
// "Rupees ... Only" output; other currencies use a generic format. The
// minor-unit word ("Paise" / "Cents" / "Pence") is picked per code.
export function amountInWords(amount: number, tenant: InvoiceData['tenant'] | undefined): string {
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

// Backwards-compatible legacy alias.
export function rupeesInWords(amount: number): string {
  return amountInWords(amount, undefined);
}

export function numberToIndianWords(num: number): string {
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
