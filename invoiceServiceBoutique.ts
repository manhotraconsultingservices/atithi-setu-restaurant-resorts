/**
 * Atithi Setu — Hotel Folio Invoice PDF generator — BOUTIQUE TEMPLATE
 * ─────────────────────────────────────────────────────────────────────────────
 * BCG Phase 1 (7 Jun 2026). Premium-grade invoice template inspired by Indian
 * hospitality leaders (Taj / ITC / Oberoi / Vivanta) and shipped alongside the
 * existing "Classic" template. Tenants opt in via Settings → Invoice Style
 * (DB column `restaurants.invoice_template = 'BOUTIQUE'`).
 *
 * What's different from Classic:
 *   • Header is a two-zone band: logo lock-up + serif hotel name on the left,
 *     PAID/UNPAID stamp + folio meta on the right. Replaces Classic's
 *     monochrome name + sans-serif title pill.
 *   • Bill-To is a bordered card on the left, Stay-Details a sibling card on
 *     the right — both at the same visual weight. Classic stacks them with
 *     uneven prominence.
 *   • Summary band BEFORE the line items: per-category totals
 *     (Accommodation / Food & Beverage / Services) plus subtotal,
 *     discount, tax, and a boxed Grand Total — answers "what do I owe?"
 *     in a single glance.
 *   • Line items table is RETAINED from Classic (Phase 2 will introduce
 *     category grouping). All tax math, HSN/SAC handling, round-off,
 *     amount-in-words, IRN box, payment status, terms, and footer behave
 *     identically to Classic.
 *
 * Compliance: every legally required element from Classic is preserved
 * (GSTIN, HSN/SAC per line, CGST/SGST split or IGST, place of supply,
 * IRN + signed QR, FSSAI, amount-in-words, signature). Boutique is a
 * pure rendering variant — no schema, no math, no logic changes.
 *
 * Safety: this file is invoked ONLY when tenant.invoice_template === 'BOUTIQUE'.
 * Existing tenants stay on Classic by default. A bug here cannot regress
 * any tenant who hasn't opted in.
 */

import PDFDocument from 'pdfkit';
import {
  HINDI_REG, HINDI_BOLD, HAS_HINDI_FONT, L,
  PAGE_W, PAGE_H, M, INNER_W, CONTENT_BOTTOM,
  INK, INK_SOFT, MUTED, HAIR, HIGHLIGHT,
  resolveLogoPath,
  money, moneyNumeric,
  fmtDate, fmtDateTime, computeNights,
  entryTypeLabel, hsnForEntry, normaliseState,
  amountInWords,
  categoryForEntry, categoryLabel, type EntryCategory,
  type InvoiceData,
  type LabelKey,
} from './invoiceServiceShared.js';

export async function generateBoutiqueInvoicePdf(data: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 0,
        info: {
          Title: `${data.isCreditNote ? 'Credit Note' : 'Tax Invoice'} — ${data.folio.invoiceNumber}`,
          Author: data.hotel.name,
          Subject: `Folio ${data.folio.id}`,
          Keywords: 'invoice,hotel,folio,GST,boutique' + (data.isCreditNote ? ',credit-note' : ''),
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ─── Bilingual font registration (same as Classic) ─────────────
      const bilingual = data.bilingual !== false;
      const hindiAvailable = HAS_HINDI_FONT && bilingual;
      if (hindiAvailable) {
        try { doc.registerFont('Hindi',      HINDI_REG);  } catch (e) { console.warn('Hindi font register failed:', e); }
        try { doc.registerFont('Hindi-Bold', HINDI_BOLD); } catch (e) { console.warn('Hindi bold register failed:', e); }
      }
      const drawBilingual = hindiAvailable;
      const label = (key: LabelKey): { en: string; hi: string | null } => {
        const v = L[key];
        return { en: v.en, hi: drawBilingual ? v.hi : null };
      };

      // ─── Boutique design tokens ────────────────────────────────────
      // Slightly richer than Classic — adds a deep accent for the
      // grand-total box and a stamp color for the PAID/UNPAID badge.
      const ACCENT      = data.isCreditNote ? '#c13b3b' : '#cc5a16';
      const ACCENT_DARK = data.isCreditNote ? '#7a2727' : '#7a3409';   // for boxed totals
      const STAMP_OK    = '#2d7d5a';   // green for PAID
      const STAMP_WARN  = '#b96b0f';   // amber for UNPAID / PENDING
      const STAMP_BAD   = '#c13b3b';   // red for VOIDED / REFUNDED

      const ensureSpace = (needed: number) => {
        if (y + needed > CONTENT_BOTTOM) {
          doc.addPage();
          // Repaint the brand strip + side rule on continuation pages.
          drawSideRule();
          y = 30;
        }
      };

      // ─── Side rule (vertical accent strip, full page height) ───────
      // Boutique's most identifiable chrome. ~6 px wide, runs from y=0
      // to y=PAGE_H along the left margin.
      const drawSideRule = () => {
        doc.rect(0, 0, 6, PAGE_H).fill(ACCENT);
      };
      drawSideRule();
      let y = 30;

      // ═══ HEADER ═════════════════════════════════════════════════════
      // Three zones (left to right): logo lock-up, hotel identity, status
      // stamp + invoice meta.
      //
      // Layout:
      //   ┌──────┬─────────────────────────────────┬───────────────┐
      //   │ LOGO │ HOTEL NAME (serif display)      │ PAID / DATE   │
      //   │ 60²  │ Address · GSTIN · FSSAI         │ Card ··4521   │
      //   │      │                                 │ INV-2026-0142 │
      //   └──────┴─────────────────────────────────┴───────────────┘

      const HEADER_H = 84;
      const stampW = 142;
      const stampX = PAGE_W - M - stampW;
      const logoBoxX = M + 4; // 4 px past the side-rule
      const logoBoxSize = 60;
      const identityX = logoBoxX + logoBoxSize + 14;
      const identityW = stampX - identityX - 12;

      // Logo (PNG/JPG only — PDFKit can't do SVG natively)
      const logoAbs = resolveLogoPath(data.hotel.logoPath);
      if (logoAbs) {
        try {
          // Subtle bordered frame around the logo so it doesn't sit naked.
          doc.roundedRect(logoBoxX, y, logoBoxSize, logoBoxSize, 6)
             .lineWidth(0.5).strokeColor(HAIR).stroke();
          doc.image(logoAbs, logoBoxX + 4, y + 4, { fit: [logoBoxSize - 8, logoBoxSize - 8] } as any);
        } catch (e) {
          console.warn('Boutique header logo failed:', e);
        }
      } else {
        // No logo → render a monogram placeholder using the first letter of
        // the hotel name. Keeps the layout visually balanced.
        doc.roundedRect(logoBoxX, y, logoBoxSize, logoBoxSize, 6).fill(ACCENT);
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(28)
           .text((data.hotel.name || 'A').trim().charAt(0).toUpperCase(),
                 logoBoxX, y + 12, { width: logoBoxSize, align: 'center' });
      }

      // Hotel name — boutique uses a serif display face for warmth. PDFKit
      // ships Times-Roman & Times-Bold; Times-Bold reads as "serif display"
      // at 18pt which is a meaningful upgrade from Classic's Helvetica-Bold.
      doc.fillColor(INK).font('Times-Bold').fontSize(20)
         .text(data.hotel.name, identityX, y, { width: identityW });

      // Sub-tag line under the name. Boutique convention.
      const subTag = [data.hotel.city, 'India'].filter(Boolean).join(', ');
      if (subTag) {
        doc.fillColor(MUTED).font('Times-Italic').fontSize(9)
           .text(subTag, identityX, y + 24, { width: identityW });
      }

      // Compliance strip (single line, comma-separated for compactness)
      const complianceParts: string[] = [];
      if (data.hotel.gstin) complianceParts.push(`GSTIN ${data.hotel.gstin}`);
      if (data.hotel.fssai)
        complianceParts.push(`FSSAI ${data.hotel.fssai}${data.hotel.fssaiValidUntil ? ` (valid ${data.hotel.fssaiValidUntil})` : ''}`);
      if (data.hotel.phone) complianceParts.push(data.hotel.phone);
      if (complianceParts.length) {
        doc.fillColor(INK_SOFT).font('Helvetica').fontSize(8)
           .text(complianceParts.join(' · '), identityX, y + 40, { width: identityW });
      }
      const addr = [data.hotel.address, data.hotel.state, data.hotel.pincode].filter(Boolean).join(' · ');
      if (addr) {
        doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
           .text(addr, identityX, y + 52, { width: identityW });
      }

      // ─── Status stamp (top-right) ─────────────────────────────────
      // Big, scannable. "PAID" in green / "UNPAID" in amber / "REFUNDED"
      // in red — visible from the email thumbnail, which is the only
      // view many guests ever see before opening the PDF.
      const isCreditNote = !!data.isCreditNote;
      const statusUpper = (data.folio.status || '').toLowerCase();
      const stampText = isCreditNote
        ? 'REFUNDED'
        : statusUpper === 'settled' ? 'PAID'
        : statusUpper === 'voided'  ? 'VOIDED'
        : 'UNPAID';
      const stampColor = isCreditNote ? STAMP_BAD
        : statusUpper === 'settled' ? STAMP_OK
        : statusUpper === 'voided'  ? MUTED
        : STAMP_WARN;
      const stampBg = isCreditNote ? '#fdf0f0'
        : statusUpper === 'settled' ? '#edf7f2'
        : statusUpper === 'voided'  ? '#f0ebe4'
        : '#fef6e7';

      doc.roundedRect(stampX, y, stampW, 36, 4).fillAndStroke(stampBg, stampColor);
      doc.fillColor(stampColor).font('Helvetica-Bold').fontSize(16)
         .text(stampText, stampX, y + 9, { width: stampW, align: 'center', characterSpacing: 1.5 });

      // Meta strip below the stamp — invoice no + date, plus payment
      // method when settled.
      let stY = y + 42;
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(10)
         .text(data.folio.invoiceNumber, stampX, stY, { width: stampW, align: 'center' });
      stY += 13;
      doc.fillColor(MUTED).font('Helvetica').fontSize(8)
         .text(fmtDate(data.folio.invoiceDate), stampX, stY, { width: stampW, align: 'center' });
      if (data.folio.paymentMethod && stampText === 'PAID') {
        stY += 11;
        doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
           .text(`via ${data.folio.paymentMethod}`, stampX, stY, { width: stampW, align: 'center' });
      }

      y += HEADER_H;

      // ─── Document title strip ──────────────────────────────────────
      // Small, secondary — the brand block above already commands the eye.
      const titleLbl = isCreditNote ? label('CREDIT_NOTE') : label('TAX_INVOICE');
      doc.fillColor(ACCENT_DARK).font('Helvetica-Bold').fontSize(11)
         .text(titleLbl.en, M + 8, y, { characterSpacing: 1.5 });
      if (titleLbl.hi) {
        doc.fillColor(MUTED).font('Hindi-Bold').fontSize(8)
           .text(titleLbl.hi, M + 8, y + 12);
      }
      y += titleLbl.hi ? 26 : 18;

      // Credit-note "Against original" line — same as Classic
      if (isCreditNote && data.parentInvoiceNumber) {
        doc.roundedRect(M, y, INNER_W, 24, 4).fillAndStroke('#fdf0f0', '#c13b3b');
        doc.fillColor('#c13b3b').font('Helvetica-Bold').fontSize(9)
           .text(`Against original invoice: ${data.parentInvoiceNumber}${data.creditNoteReason ? ` · Reason: ${data.creditNoteReason}` : ''}`,
                 M + 10, y + 8, { width: INNER_W - 20 });
        y += 32;
      }

      doc.moveTo(M, y).lineTo(PAGE_W - M, y).lineWidth(0.5).strokeColor(HAIR).stroke();
      y += 14;

      // ═══ BILL TO  /  STAY DETAILS ══════════════════════════════════
      // Two equal-weight bordered cards side-by-side. Left = Bill-To
      // (the legally required party block), Right = Stay-Details (the
      // booking context).
      const cardGap = 12;
      const cardW = (INNER_W - cardGap) / 2;
      const cardX1 = M;
      const cardX2 = M + cardW + cardGap;
      const cardPad = 12;

      const billLabelHi = label('BILL_TO').hi;
      const guestLines = [
        data.guest.address,
        data.guest.phone,
        data.guest.email,
        data.guest.state ? `State: ${data.guest.state}` : null,
        data.guest.nationality ? `Nationality: ${data.guest.nationality}` : null,
        data.guest.gstin ? `GSTIN: ${data.guest.gstin}` : null,
      ].filter(Boolean) as string[];
      // Pre-compute card height: header (15px) + hi-label (10px if any) + name (18px) + each detail line (12px) + bottom pad (10px)
      const billCardH = 15 + (billLabelHi ? 10 : 0) + 22 + guestLines.length * 12 + 10;

      const nights = computeNights(data.stay.checkInDate, data.stay.checkOutDate);
      const stayRows: Array<[string, string]> = [
        ['Folio',     data.folio.id || '—'],
        ['Booking',   data.stay.bookingId || '—'],
        ['Room',      data.stay.roomName || '—'],
        // Actual check-in / check-out timestamp (date + hh:mm) once it happens;
        // scheduled date (date-only) until then.
        ['Check-in',  data.stay.actualCheckInAt  ? fmtDateTime(data.stay.actualCheckInAt)  : fmtDate(data.stay.checkInDate)],
        ['Check-out', data.stay.actualCheckOutAt ? fmtDateTime(data.stay.actualCheckOutAt) : fmtDate(data.stay.checkOutDate)],
        ['Nights',    `${nights}  ·  Guests ${data.stay.numGuests || 1}`],
        ['Place',     data.placeOfSupply || data.hotel.state || '—'],
      ];
      const stayCardH = 15 + (label('ROOM').hi ? 10 : 0) + 8 + stayRows.length * 14 + 10;
      const cardH = Math.max(billCardH, stayCardH);

      // Bill-To card
      doc.roundedRect(cardX1, y, cardW, cardH, 6).lineWidth(0.5).strokeColor(HAIR).stroke();
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8)
         .text('BILL TO', cardX1 + cardPad, y + cardPad, { characterSpacing: 1.5 });
      if (billLabelHi) {
        doc.font('Hindi-Bold').fontSize(7).fillColor(MUTED)
           .text(billLabelHi, cardX1 + cardPad, y + cardPad + 10);
      }
      const guestNameY = y + cardPad + (billLabelHi ? 22 : 12);
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(13)
         .text(data.guest.name || '—', cardX1 + cardPad, guestNameY, { width: cardW - cardPad * 2 });
      let gY = guestNameY + 20;
      doc.fillColor(INK_SOFT).font('Helvetica').fontSize(9);
      for (const ln of guestLines) {
        doc.text(ln, cardX1 + cardPad, gY, { width: cardW - cardPad * 2 });
        gY += 12;
      }

      // Stay-Details card
      doc.roundedRect(cardX2, y, cardW, cardH, 6).lineWidth(0.5).strokeColor(HAIR).stroke();
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8)
         .text('STAY DETAILS', cardX2 + cardPad, y + cardPad, { characterSpacing: 1.5 });
      let sY = y + cardPad + 20;
      const sLabelX = cardX2 + cardPad;
      const sValueX = cardX2 + cardW / 2;
      const sValueW = cardW / 2 - cardPad;
      for (const [k, v] of stayRows) {
        doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
           .text(k, sLabelX, sY, { width: cardW / 2 - cardPad });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
           .text(v || '—', sValueX, sY - 1, { width: sValueW, align: 'right' });
        sY += 14;
      }

      y += cardH + 18;

      // ═══ SUMMARY BAND ══════════════════════════════════════════════
      // Per-category totals + subtotal/discount/tax + boxed grand total.
      // This is the answer the guest came for — placed BEFORE the
      // line items so they don't have to scroll-then-add.

      const sign = isCreditNote ? -1 : 1;
      const billableEntries = data.entries.filter(
        e => !['TAX', 'DISCOUNT', 'PAYMENT'].includes(e.entryType)
      );

      // Bucket entries by category
      const categoryTotals = new Map<EntryCategory, number>();
      for (const e of billableEntries) {
        const c = categoryForEntry(e.entryType);
        categoryTotals.set(c, (categoryTotals.get(c) || 0) + Number(e.amount || 0));
      }
      // Display order
      const orderedCats: EntryCategory[] = ['ACCOMMODATION', 'FNB', 'SERVICE', 'OTHER'];
      const presentCats = orderedCats.filter(c => (categoryTotals.get(c) || 0) > 0);

      // Layout: category breakdown on the left (~60% width), boxed Grand
      // Total on the right (~40%).
      const summaryH = 24 + presentCats.length * 16 + 10;  // category lines
      const totalsExtraH = (data.folio.discount > 0 ? 16 : 0)
                         + 16   // tax row
                         + (data.roundToRupee ? 16 : 0);
      const summaryFullH = Math.max(summaryH + totalsExtraH, 110);   // grand total box needs space

      ensureSpace(summaryFullH);

      const sumLeftX = M;
      const sumLeftW = INNER_W * 0.58;
      const sumRightX = M + sumLeftW + 12;
      const sumRightW = INNER_W - sumLeftW - 12;

      // ── Left column: category breakdown ──
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8)
         .text('SUMMARY', sumLeftX, y, { characterSpacing: 1.5 });
      let sumY = y + 16;
      doc.font('Helvetica').fontSize(10);
      for (const c of presentCats) {
        const val = (categoryTotals.get(c) || 0) * sign;
        doc.fillColor(INK_SOFT).font('Helvetica').fontSize(10)
           .text(categoryLabel(c), sumLeftX, sumY, { width: sumLeftW * 0.6 });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(10)
           .text(money(data.tenant, val), sumLeftX + sumLeftW * 0.6, sumY, {
             width: sumLeftW * 0.4 - 8, align: 'right',
           });
        sumY += 16;
      }
      // Subtotal/discount/tax mini-block
      sumY += 4;
      doc.moveTo(sumLeftX, sumY).lineTo(sumLeftX + sumLeftW - 8, sumY)
         .lineWidth(0.5).strokeColor(HAIR).stroke();
      sumY += 6;
      const drawMiniRow = (lbl: string, value: string, accent = false) => {
        doc.fillColor(accent ? ACCENT : MUTED).font(accent ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
           .text(lbl, sumLeftX, sumY, { width: sumLeftW * 0.6 });
        doc.fillColor(accent ? ACCENT : INK_SOFT).font('Helvetica').fontSize(9)
           .text(value, sumLeftX + sumLeftW * 0.6, sumY, { width: sumLeftW * 0.4 - 8, align: 'right' });
        sumY += 14;
      };
      drawMiniRow('Subtotal', money(data.tenant, data.folio.subtotal * sign));
      if (data.folio.discount > 0) {
        drawMiniRow('Discount', `− ${money(data.tenant, data.folio.discount * sign)}`, true);
      }
      drawMiniRow('Tax', money(data.tenant, data.folio.gstAmount * sign));

      // Round-off
      const rawGrand = Number(data.folio.grandTotal || 0);
      let displayedGrand = rawGrand;
      if (data.roundToRupee) {
        const rounded = Math.round(rawGrand);
        const roundOff = Math.round((rounded - rawGrand) * 100) / 100;
        if (Math.abs(roundOff) >= 0.01) {
          const prefix = roundOff >= 0 ? '+ ' : '− ';
          drawMiniRow('Round-off', `${prefix}${money(data.tenant, Math.abs(roundOff) * sign)}`, true);
        }
        displayedGrand = rounded;
      }

      // Paid + Balance Due (hotel folio). Itemise each payment/advance when
      // the ledger is supplied so the guest sees the full receipt trail
      // (advance at check-in, interim, final, refund); else fall back to the
      // lumped "Paid" total. Skipped for credit notes.
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
            drawMiniRow(`${tl}${method}${dt}`, `${isRefund ? '+ ' : '− '}${money(data.tenant, amt)}`);
          }
        } else if (data.folio.amountPaid != null && data.folio.amountPaid > 0) {
          drawMiniRow('Paid', `− ${money(data.tenant, data.folio.amountPaid)}`);
        }
        if (data.folio.balanceDue != null) {
          drawMiniRow('Balance Due', money(data.tenant, data.folio.balanceDue), true);
        }
      }

      // ── Right column: BOXED GRAND TOTAL ──
      // The signature element of the Boutique template. Big, framed,
      // unmissable from any distance.
      const gtBoxH = 92;
      doc.roundedRect(sumRightX, y, sumRightW, gtBoxH, 8).fillAndStroke(ACCENT, ACCENT);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9)
         .text('GRAND TOTAL', sumRightX, y + 14, { width: sumRightW, align: 'center', characterSpacing: 1.8 });
      const gtHi = label('GRAND_TOTAL').hi;
      if (gtHi) {
        doc.fillColor('#ffffff').font('Hindi-Bold').fontSize(7.5)
           .text(gtHi, sumRightX, y + 27, { width: sumRightW, align: 'center' });
      }
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20)
         .text(money(data.tenant, displayedGrand * sign), sumRightX, y + (gtHi ? 42 : 38), {
           width: sumRightW, align: 'center',
         });
      // Currency sub-line for very long Indian rupee strings (already in
      // money() but reinforced here as a smaller label for clarity).
      doc.fillColor('#ffffffcc').font('Helvetica').fontSize(7.5)
         .text(
           data.tenant?.currency_code || 'INR',
           sumRightX, y + gtBoxH - 16,
           { width: sumRightW, align: 'center', characterSpacing: 1.5 }
         );

      y = Math.max(sumY, y + gtBoxH) + 16;

      // ═══ AMOUNT IN WORDS ═══════════════════════════════════════════
      const _amtBoxH = drawBilingual ? 34 : 26;
      ensureSpace(_amtBoxH + 10);
      const amtLbl = label('AMT_WORDS');
      doc.roundedRect(M, y, INNER_W, _amtBoxH, 4).fill(HIGHLIGHT);
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5)
         .text(amtLbl.en, M + 12, y + 5, { characterSpacing: 1.2 });
      if (amtLbl.hi) {
        doc.font('Hindi-Bold').fontSize(6.5).fillColor(MUTED)
           .text(amtLbl.hi, M + 12, y + 13);
      }
      doc.fillColor(INK).font('Helvetica-BoldOblique').fontSize(10)
         .text(amountInWords(Math.abs(displayedGrand), data.tenant), M + 12, y + (amtLbl.hi ? 20 : 14), { width: INNER_W - 24 });
      y += (drawBilingual ? 44 : 36);

      // ═══ LINE ITEMS (reused from Classic) ══════════════════════════
      // For Phase 1 we render the standard Classic line-items table. Phase
      // 2 will replace this with category-grouped sections.
      const currencyCode = data.tenant?.currency_code || 'INR';
      const ROW_H = 28;
      const colPositions = {
        num:  M,
        desc: M + 28,
        hsn:  M + INNER_W - 230,
        qty:  M + INNER_W - 188,
        rate: M + INNER_W - 160,
        tax:  M + INNER_W - 90,
        amt:  M + INNER_W - 60,
      };

      doc.rect(M, y, INNER_W, ROW_H).fill(INK);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
      const headerTextY = y + (ROW_H - 9) / 2;
      doc.text('#',                          colPositions.num  + 4, headerTextY);
      doc.text(label('DESC').en,             colPositions.desc + 4, headerTextY);
      doc.text(label('HSN').en,              colPositions.hsn,      headerTextY);
      doc.text(label('QTY').en,              colPositions.qty,      headerTextY, { width: 28, align: 'right' });
      doc.text(`${label('RATE').en} (${currencyCode})`,   colPositions.rate, headerTextY, { width: 65, align: 'right' });
      doc.text(label('TAX_PCT').en,          colPositions.tax,      headerTextY, { width: 30, align: 'right' });
      doc.text(`${label('AMOUNT').en} (${currencyCode})`, colPositions.amt - 20, headerTextY, { width: 80, align: 'right' });
      y += ROW_H;

      doc.font('Helvetica').fontSize(9).fillColor(INK_SOFT);
      billableEntries.forEach((e, i) => {
        // PDF-FIX (description overflow): wrap the description + grow the row
        // so long lines (e.g. room charge incl. extra-person breakdown) show
        // fully instead of clipping into the next column / row.
        const descW = colPositions.hsn - colPositions.desc - 8;
        doc.font('Helvetica-Bold').fontSize(9);
        const descH = doc.heightOfString(String(e.description || ''), { width: descW });
        const rowH = Math.max(ROW_H, Math.ceil(descH) + 18);
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
        doc.text(moneyNumeric(data.tenant, e.unitPrice * sign), colPositions.rate, rowY + 7, { width: 65, align: 'right' });
        doc.text(`${e.gstRate ?? 0}%`,                          colPositions.tax,  rowY + 7, { width: 30, align: 'right' });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
           .text(moneyNumeric(data.tenant, e.amount * sign),    colPositions.amt - 20, rowY + 7, { width: 80, align: 'right' });
        y += rowH;
      });

      doc.moveTo(M, y).lineTo(PAGE_W - M, y).lineWidth(0.5).strokeColor(HAIR).stroke();
      y += 14;

      // ═══ HSN/SAC TAX SUMMARY ═══════════════════════════════════════
      // A compact table per the GST audit format: HSN | taxable | rate
      // | CGST | SGST | IGST | total. Indian B2B accountants love this
      // — they reconcile their ITC against it directly.

      const tenantCountry = (data.tenant?.country || 'IN').toUpperCase();
      const isIndia = tenantCountry === 'IN';
      let sameState: boolean;
      if (data.sameStateGst !== undefined) sameState = data.sameStateGst;
      else if (data.guest.state && data.hotel.state) {
        sameState = normaliseState(data.guest.state) === normaliseState(data.hotel.state);
      } else sameState = true;

      if (isIndia) {
        // Group entries by (HSN, rate) for the tax summary
        type HsnSummaryRow = { hsn: string; rate: number; taxable: number; cgst: number; sgst: number; igst: number };
        const hsnGroups = new Map<string, HsnSummaryRow>();
        for (const e of billableEntries) {
          const hsn = e.hsnCode || hsnForEntry(e.entryType);
          const rate = Number(e.gstRate || 0);
          const key = `${hsn}@${rate}`;
          const row = hsnGroups.get(key) || { hsn, rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
          row.taxable += Number(e.amount || 0);
          const gst = Number(e.gstAmount || 0);
          if (sameState) {
            row.cgst += Math.round((gst / 2) * 100) / 100;
            row.sgst += Math.round((gst / 2) * 100) / 100;
          } else {
            row.igst += gst;
          }
          hsnGroups.set(key, row);
        }
        const hsnRows = [...hsnGroups.values()].sort((a, b) => a.hsn.localeCompare(b.hsn));
        if (hsnRows.length > 0) {
          ensureSpace(28 + hsnRows.length * 16 + 8);
          doc.rect(M, y, INNER_W, 22).fill(INK);
          doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
          const htY = y + (22 - 9) / 2;
          doc.text('HSN/SAC',                M + 12,                htY);
          doc.text('Taxable',                M + 100,               htY, { width: 70, align: 'right' });
          doc.text('Rate',                   M + 180,               htY, { width: 50, align: 'right' });
          if (sameState) {
            doc.text('CGST',                 M + 240,               htY, { width: 60, align: 'right' });
            doc.text('SGST',                 M + 310,               htY, { width: 60, align: 'right' });
          } else {
            doc.text('IGST',                 M + 240,               htY, { width: 130, align: 'right' });
          }
          doc.text('Total Tax',              M + INNER_W - 80,      htY, { width: 70, align: 'right' });
          y += 22;
          doc.fillColor(INK_SOFT).font('Helvetica').fontSize(9);
          for (const r of hsnRows) {
            const total = r.cgst + r.sgst + r.igst;
            doc.fillColor(INK).font('Helvetica').fontSize(9)
               .text(r.hsn, M + 12, y + 4);
            doc.text(moneyNumeric(data.tenant, r.taxable), M + 100, y + 4, { width: 70, align: 'right' });
            doc.text(`${r.rate.toFixed(1)}%`,              M + 180, y + 4, { width: 50, align: 'right' });
            if (sameState) {
              doc.text(moneyNumeric(data.tenant, r.cgst),  M + 240, y + 4, { width: 60, align: 'right' });
              doc.text(moneyNumeric(data.tenant, r.sgst),  M + 310, y + 4, { width: 60, align: 'right' });
            } else {
              doc.text(moneyNumeric(data.tenant, r.igst),  M + 240, y + 4, { width: 130, align: 'right' });
            }
            doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
               .text(moneyNumeric(data.tenant, total),     M + INNER_W - 80, y + 4, { width: 70, align: 'right' });
            doc.fillColor(INK_SOFT).font('Helvetica').fontSize(9);
            y += 16;
          }
          y += 8;
        }
      } else if (data.taxLines && data.taxLines.length > 0) {
        // Non-India fallback — render a simpler taxlines table.
        ensureSpace(28 + data.taxLines.length * 16 + 8);
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8)
           .text('TAX SUMMARY', M, y, { characterSpacing: 1.2 });
        y += 14;
        doc.fillColor(INK).font('Helvetica').fontSize(9);
        for (const line of data.taxLines) {
          doc.text(`${line.label} @ ${Number(line.rate || 0).toFixed(1)}%`, M, y, { width: INNER_W - 100 });
          doc.text(moneyNumeric(data.tenant, line.amount * sign), M + INNER_W - 100, y, { width: 100, align: 'right' });
          y += 14;
        }
        y += 8;
      }

      // ═══ IRN BOX (R-3) ═════════════════════════════════════════════
      // Render ONLY when a real IRN was GENERATED. The "IRN PENDING" notice
      // was removed per owner request (cluttered non-e-invoicing tenants).
      const irn = data.irn;
      const irnGenerated = !!(irn && String(irn.status || '').toUpperCase() === 'GENERATED' && irn.irn);
      if (irnGenerated) {
        const irnBoxH = 86;
        ensureSpace(irnBoxH + 12);
        doc.roundedRect(M, y, INNER_W, irnBoxH, 4).fillAndStroke('#f0f7f3', '#2d7d5a');
        doc.fillColor('#2d7d5a').font('Helvetica-Bold').fontSize(8.5)
           .text('GST E-INVOICE (IRN)', M + 12, y + 7, { characterSpacing: 0.8 });
        doc.fillColor(INK_SOFT).font('Helvetica').fontSize(7.5)
           .text('IRN', M + 12, y + 22);
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(7.5)
           .text(String(irn!.irn || '').slice(0, 64), M + 12, y + 32, { width: INNER_W - 110 });
        if (irn!.ackNo) {
          doc.fillColor(INK_SOFT).font('Helvetica').fontSize(7.5)
             .text(`ACK ${irn!.ackNo}${irn!.ackDate ? ' · ' + irn!.ackDate : ''}`,
                   M + 12, y + 56);
        }
        if (irn!.signedQrCode) {
          try {
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

      // ═══ TERMS + SIGNATURE ═════════════════════════════════════════
      ensureSpace(72);
      const termsLbl = label('TERMS');
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8)
         .text(termsLbl.en, M, y, { characterSpacing: 1 });
      doc.fillColor(INK_SOFT).font('Helvetica').fontSize(7.5);
      const terms = isCreditNote ? [
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

      // ═══ FOOTER (3-zone: compliance / brand / next-stay) ═══════════
      const footerY = PAGE_H - 40;
      doc.moveTo(M, footerY - 8).lineTo(PAGE_W - M, footerY - 8)
         .lineWidth(0.5).strokeColor(HAIR).stroke();

      // Zone 1: compliance reminder (left third)
      const fZoneW = INNER_W / 3;
      doc.fillColor(MUTED).font('Helvetica').fontSize(7)
         .text(
           [data.hotel.gstin ? `GSTIN ${data.hotel.gstin}` : null,
            data.hotel.fssai ? `FSSAI ${data.hotel.fssai}` : null].filter(Boolean).join(' · ') || '—',
           M, footerY,
           { width: fZoneW, align: 'left' }
         );
      // Zone 2: brand voice (centre third)
      doc.fillColor(ACCENT).font('Helvetica-BoldOblique').fontSize(8)
         .text(label('THANK').en, M + fZoneW, footerY, { width: fZoneW, align: 'center' });
      // Zone 3: app attribution (right third)
      doc.fillColor(MUTED).font('Helvetica').fontSize(7)
         .text('Generated by Atithi Setu™ · Manhotra Consulting',
               M + fZoneW * 2, footerY + 2, { width: fZoneW, align: 'right' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
