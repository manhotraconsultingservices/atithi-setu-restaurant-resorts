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
// BCG Phase 0 (7 Jun 2026): pure helpers, label dictionary, interface, page
// constants, Hindi fonts, and logo resolver now live in invoiceServiceShared.ts
// so the new Boutique template (invoiceServiceBoutique.ts) can reuse them.
// This file (invoiceService.ts) keeps the historical "Classic" rendering
// logic — output is byte-identical for every existing tenant.
import {
  HINDI_REG, HINDI_BOLD, HAS_HINDI_FONT, L,
  PAGE_W, PAGE_H, M, INNER_W, CONTENT_BOTTOM,
  INK, INK_SOFT, MUTED, HAIR, HIGHLIGHT, accentFor,
  resolveLogoPath,
  money, moneyNumeric,
  fmtDate, fmtDateTime, computeNights,
  entryTypeLabel, hsnForEntry, normaliseState,
  amountInWords,
} from './invoiceServiceShared.js';
// Re-export the interface so existing `import { InvoiceData } from './invoiceService'`
// consumers (server.ts) keep working without an edit.
export type { InvoiceData } from './invoiceServiceShared.js';
import type { InvoiceData } from './invoiceServiceShared.js';


// BCG Phase 1 (7 Jun 2026) — template dispatcher.
//
// generateInvoicePdf() is the PUBLIC entry point that every caller in the
// codebase already uses (server.ts hotel folio download, group invoice,
// email-invoice, etc.). To preserve that contract we keep the same
// function name + signature here and route INTERNALLY to either the
// Classic renderer (this file's generateClassicInvoicePdf below — the
// original code) or the Boutique renderer (invoiceServiceBoutique.ts).
//
// The dispatch key is tenant.invoice_template, which the server reads
// from restaurants.invoice_template and passes through in InvoiceData.
// Default is 'CLASSIC' so any tenant who hasn't opted in (= all tenants
// currently in production) sees byte-identical output to before Phase 1.
import { generateBoutiqueInvoicePdf } from './invoiceServiceBoutique.js';

export async function generateInvoicePdf(data: InvoiceData): Promise<Buffer> {
  const tpl = (data.tenant?.invoice_template || 'CLASSIC').toUpperCase();
  if (tpl === 'BOUTIQUE') {
    return generateBoutiqueInvoicePdf(data);
  }
  return generateClassicInvoicePdf(data);
}

async function generateClassicInvoicePdf(data: InvoiceData): Promise<Buffer> {
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
        // Show the ACTUAL check-in / check-out timestamp (date + hh:mm) when the
        // guest has been checked in / out; fall back to the scheduled date
        // (date-only) before that happens.
        { labelKey: 'CHECK_IN',  value: data.stay.actualCheckInAt  ? fmtDateTime(data.stay.actualCheckInAt)  : fmtDate(data.stay.checkInDate) },
        { labelKey: 'CHECK_OUT', value: data.stay.actualCheckOutAt ? fmtDateTime(data.stay.actualCheckOutAt) : fmtDate(data.stay.checkOutDate) },
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
      // CURRENCY-FIX (client report: "₹" rendering as superscript "¹"
      // and clipping the closing paren): the standard PDFKit Helvetica
      // font does NOT include the Unicode rupee glyph ₹ (U+20B9) — it
      // falls back to a stubby Latin-1 char that visually looks like a
      // superscript 1, and the missing-glyph width math then pushes the
      // closing ")" past the column edge. Same hazard for any non-ASCII
      // currency symbol on any tenant.
      //
      // Fix: use the ISO 4217 currency CODE (INR / USD / EUR / GBP …)
      // in the header parenthetical instead of the symbol. Codes are
      // pure ASCII — render in any font, on any locale, without
      // glyph-fallback or width drift. Symbols still appear on TOTALS
      // (where the locale formatter handles font fallback gracefully)
      // and in the formatted amount-in-words line.
      const currencyCode = data.tenant?.currency_code || 'INR';
      // ROW-HEIGHT-FIX (client report: Accommodation subtitle bleeds into
      // next row): each data row paints a 22-px highlight band but the
      // description body (rowY+6 at 9pt) PLUS the entry-type subtitle
      // (rowY+16 at 8pt with ~9px line height) reaches rowY+25 — well past
      // the band's bottom at rowY+20. Visually the subtitle clips into the
      // next zebra band ("Accommodation" half-eaten by the row 2 fill).
      // Raise both the header and data row heights from 22 → 28 and push
      // the subtitle baseline from +16 → +17 for slightly tighter coupling.
      const ROW_H = 28;
      // COL-FIT (client report: Description overflows / column proportions
      // wrong): HSN is always a 6-digit SAC code (e.g. 996311 ≈ 32 px), QTY
      // is always 1-2 digits (≈ 12 px), TAX% is always 1-3 chars + "%"
      // (≈ 20 px). Previous layout reserved 55/45/40 px for them, starving
      // Description (≈ 209 px) on hotel rows like "[Deluxe Room 401] Room
      // charge · 2026-06-07" (≈ 230 px at 9pt bold) — which then ellipsised.
      // New widths: HSN 42, QTY 28, TAX 30 → frees 40 px back to Description
      // (now ≈ 249 px), enough for the longest realistic hotel/F&B row
      // before ellipsis kicks in.
      const colPositions = {
        num:  M,
        desc: M + 28,
        hsn:  M + INNER_W - 230,   // was -270; +40 px to Description
        qty:  M + INNER_W - 188,   // was -215; HSN now 42 px wide
        rate: M + INNER_W - 160,   // was -170; QTY now 28 px wide
        tax:  M + INNER_W - 90,    // was -100; RATE stays 70 px wide
        amt:  M + INNER_W - 60,    // unchanged (right edge anchored)
      };

      doc.rect(M, y, INNER_W, ROW_H).fill(INK);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
      // Header text vertically centred at row mid-height (was y+8 in a 22px
      // band ≈ 36 % from top; (ROW_H-9)/2 keeps the same visual centring).
      const headerTextY = y + (ROW_H - 9) / 2;
      doc.text('#',                          colPositions.num  + 4, headerTextY);
      doc.text(label('DESC').en,             colPositions.desc + 4, headerTextY);
      doc.text(label('HSN').en,              colPositions.hsn,      headerTextY);
      doc.text(label('QTY').en,              colPositions.qty,      headerTextY, { width: 28, align: 'right' });
      doc.text(`${label('RATE').en} (${currencyCode})`,   colPositions.rate, headerTextY, { width: 65, align: 'right' });
      doc.text(label('TAX_PCT').en,          colPositions.tax,      headerTextY, { width: 30, align: 'right' });
      doc.text(`${label('AMOUNT').en} (${currencyCode})`, colPositions.amt - 20, headerTextY, { width: 80, align: 'right' });
      y += ROW_H;

      const sign = data.isCreditNote ? -1 : 1;
      const billableEntries = data.entries.filter(e => !['TAX', 'DISCOUNT', 'PAYMENT'].includes(e.entryType));
      doc.font('Helvetica').fontSize(9).fillColor(INK_SOFT);
      billableEntries.forEach((e, i) => {
        // PDF-FIX: paginate if this row + a sensible-sized totals/IRN/payment
        // tail wouldn't fit. We reserve ~280px for the post-items section
        // (totals + amount-in-words + IRN + payment + terms/signature). If
        // the next ROW_H row would breach the bottom budget, break here so
        // the totals always land on a page with enough room.
        // PDF-FIX (description overflow): the description column WRAPS now —
        // measure its rendered height and grow the row so long descriptions
        // (e.g. "Room charge · DATE · MAP · incl. 1 adult, 2 children w/mat")
        // are fully visible instead of clipping into the next column / row.
        const descW = colPositions.hsn - colPositions.desc - 8;
        doc.font('Helvetica-Bold').fontSize(9);
        const descH = doc.heightOfString(String(e.description || ''), { width: descW });
        const rowH = Math.max(ROW_H, Math.ceil(descH) + 18); // + entry-type sub-line + padding
        ensureSpace(rowH);
        const rowY = y;
        const hsn = e.hsnCode || hsnForEntry(e.entryType);
        if (i % 2 === 1) {
          doc.rect(M, y - 2, INNER_W, rowH).fill(HIGHLIGHT);
        }
        doc.fillColor(INK_SOFT).font('Helvetica').fontSize(9);
        doc.text(String(i + 1), colPositions.num + 4, rowY + 7, { width: 20 });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
           .text(String(e.description || ''), colPositions.desc + 4, rowY + 6, { width: descW });
        doc.fillColor(INK_SOFT).font('Helvetica').fontSize(8)
           .text(entryTypeLabel(e.entryType), colPositions.desc + 4, rowY + 6 + Math.ceil(descH) + 1);
        doc.fillColor(INK_SOFT).font('Helvetica').fontSize(9);
        doc.text(hsn,                      colPositions.hsn,      rowY + 7);
        doc.text(String(e.quantity),       colPositions.qty,      rowY + 7, { width: 28, align: 'right' });
        // COLUMN-FIT: numeric-only (no currency prefix) — fits cleanly
        // in the 65/80 px columns. Currency is shown in the header label
        // "(INR)" and again on every TOTALS row, so no info is lost.
        doc.text(moneyNumeric(data.tenant, e.unitPrice * sign), colPositions.rate, rowY + 7, { width: 65, align: 'right' });
        doc.text(`${e.gstRate ?? 0}%`,                          colPositions.tax,  rowY + 7, { width: 30, align: 'right' });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
           .text(moneyNumeric(data.tenant, e.amount * sign),    colPositions.amt - 20, rowY + 7, { width: 80, align: 'right' });
        y += rowH;
      });

      doc.moveTo(M, y).lineTo(PAGE_W - M, y).lineWidth(0.5).strokeColor(HAIR).stroke();
      y += 14;

      // ────────────── TOTALS ──────────────
      // GRAND-TOTAL-FIX (client report: Grand Total trimmed): the bold 11pt
      // GRAND TOTAL row renders "INR 8,000.00" (≈ 88 px at 11pt bold) in a
      // value slot that was effectively 70 px wide (valueW=90 minus the
      // 20 px right-edge padding). The number was being soft-clipped at the
      // hundreds digit — readers saw "8,0" then a cliff.
      //
      // Two-part fix:
      //   1. Widen the totals box to 270 (was 240) — fits the longest
      //      realistic Indian grand-total ("INR 99,99,999.00", 17 chars).
      //   2. Rebalance: labelW 140 → 130 (still fits "GRAND TOTAL"), valueW
      //      90 → 140 → effective text width grows from 70 px to 120 px.
      const totalsX = M + INNER_W - 270;
      const totalsW = 270;
      const labelW = 130;
      const valueW = 140;

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

      // Paid + Balance Due (hotel folio). When the per-payment ledger is
      // supplied, itemise every receipt (advance at check-in, interim, final,
      // refund) as its own line so the guest sees the full payment trail and
      // exactly how the balance was reached — not just a lumped "Paid" total.
      // Skipped for credit notes.
      if (!data.isCreditNote) {
        const pays = (data.folio.payments || []).filter(p => Math.abs(Number(p.amount || 0)) > 0);
        if (pays.length > 0) {
          for (const p of pays) {
            const isRefund = String(p.payment_type || '').toUpperCase() === 'REFUND';
            const raw = String(p.payment_type || 'PAYMENT');
            const tl = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
            const method = p.payment_method ? ` · ${p.payment_method}` : '';
            const dt = p.recorded_at ? ` · ${String(p.recorded_at).slice(0, 10)}` : '';
            const amt = Math.abs(Number(p.amount || 0));
            drawTotalRow(`${tl}${method}${dt}`, `${isRefund ? '+ ' : '− '}${m(amt)}`);
          }
        } else if (data.folio.amountPaid != null && data.folio.amountPaid > 0) {
          drawTotalRow('Paid', `− ${m(data.folio.amountPaid)}`);
        }
        if (data.folio.balanceDue != null) {
          drawTotalRow('Balance Due', m(data.folio.balanceDue), true);
        }
      }

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
      // Render the IRN stamp + signed QR ONLY when a real IRN has been
      // GENERATED by the IRP. The "IRN PENDING" notice was removed per owner
      // request — it cluttered invoices for tenants who don't use GST
      // e-invoicing. (A generated IRN still prints for those who do.)
      const irn = data.irn;
      const irnGenerated = !!(irn && String(irn.status || '').toUpperCase() === 'GENERATED' && irn.irn);
      if (irnGenerated) {
        const irnBoxH = 86;
        // PDF-FIX: force a page break when there isn't room for the whole box.
        ensureSpace(irnBoxH + 12);
        doc.roundedRect(M, y, INNER_W, irnBoxH, 4).fillAndStroke('#f0f7f3', '#2d7d5a');
        doc.fillColor('#2d7d5a').font('Helvetica-Bold').fontSize(8.5)
           .text('GST E-INVOICE (IRN)', M + 12, y + 7, { characterSpacing: 0.8 });
        // Left column: IRN + ACK text
        doc.fillColor(INK_SOFT).font('Helvetica').fontSize(7.5)
           .text('IRN', M + 12, y + 22);
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(7.5)
           .text(String(irn!.irn || '').slice(0, 64), M + 12, y + 32, { width: INNER_W - 110 });
        if (irn!.ackNo) {
          doc.fillColor(INK_SOFT).font('Helvetica').fontSize(7.5)
             .text(`ACK ${irn!.ackNo}${irn!.ackDate ? ' · ' + irn!.ackDate : ''}`,
                   M + 12, y + 56);
        }
        // Right side: signed QR as embedded image when present.
        if (irn!.signedQrCode) {
          try {
            // Accept either a raw base64 PNG or a data: URL.
            let qrBytes: Buffer | null = null;
            const raw = String(irn!.signedQrCode);
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
