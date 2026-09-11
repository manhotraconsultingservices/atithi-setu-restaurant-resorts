/**
 * Atithi Setu - Bank Reconciliation Statement PDF
 *
 * The document an auditor asks for, and the worksheet properties currently keep
 * on paper. It states the reconciliation in the conventional direction: start at
 * what the bank says, adjust for the items the bank has not seen yet, and arrive
 * at what the books say.
 *
 *     Balance as per bank statement            X
 *     Add:  deposits in transit               +A     (banked, not yet credited)
 *     Less: cheques not yet presented         -B     (issued, not yet debited)
 *     -----------------------------------------
 *     Balance as per books                    =C
 *     Balance per general ledger                D
 *     Difference                                C-D  -> must be nil
 *
 * Every figure is derived from the ledger and the saved clearing state. This
 * module stores nothing, reads nothing and posts nothing: it is handed a model
 * and returns bytes.
 *
 * LANDMINE: PDFKit built-in Helvetica has no Unicode rupee glyph (U+20B9).
 * Emitting a bare rupee sign throws and takes the whole route down with a 500.
 * Money is formatted with the ASCII "Rs." prefix, the same fix the hotel invoice
 * and event quotation templates use. Do not reintroduce the rupee glyph here.
 */

import PDFDocument from 'pdfkit';

export interface BankRecStatementItem {
  entry_date: string;
  journal_ref: string | null;
  narration: string | null;
  amount: number;
}

export interface BankRecStatementSection {
  count: number;
  total: number;
  truncated: boolean;
  items: BankRecStatementItem[];
}

export interface BankRecStatementData {
  property_name: string;
  property_gstin: string | null;

  account_code: string;
  account_label: string | null;

  statement_date: string;
  window_from: string;
  window_to: string;

  /** Null when no statement balance has been entered and saved yet. */
  statement_closing_balance: number | null;
  deposits_in_transit: BankRecStatementSection;
  outstanding_cheques: BankRecStatementSection;
  book_balance: number;
  /** statement + deposits in transit - outstanding cheques. */
  computed_book_balance: number | null;
  /** computed_book_balance - book_balance. Nil means reconciled. */
  difference: number | null;
  reconciled: boolean;

  status: string;
  prepared_by: string | null;
  prepared_on: string | null;
  generated_at: string;
}

const ORANGE = '#cc5a16';
const DARK = '#1a1208';
const MUTED = '#6b5d52';
const LIGHT = '#9c8e85';
const RULE = '#e5d3c3';
const GREEN = '#047857';
const RUST = '#a0522d';

/** "Rs. 1,23,456.78". Never the U+20B9 glyph - see the note at the top. */
const money = (n: number | null | undefined): string => {
  if (n == null) return '-';
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? '-Rs. ' : 'Rs. ') + s;
};

const prettyDate = (d: string | null | undefined): string => {
  if (!d) return '-';
  try {
    const dt = new Date(String(d).slice(0, 10) + 'T00:00:00');
    if (isNaN(dt.getTime())) return String(d).slice(0, 10);
    return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return String(d).slice(0, 10); }
};

export async function generateBankRecStatementPdf(data: BankRecStatementData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        info: {
          Title: `Bank Reconciliation Statement ${data.account_code} ${data.statement_date}`,
          Author: data.property_name,
          Subject: `Bank reconciliation as at ${data.statement_date}`,
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = 40;
      const R = doc.page.width - 40;
      const W = R - L;
      const BOTTOM = doc.page.height - 70;
      const amtX = R - 128;
      const amtW = 120;

      let y = 0;

      /**
       * Cut a string to fit a column, in points, against the font currently
       * selected on `doc`. PDFKit's own `ellipsis` option does NOT truncate
       * here — it wrapped instead, and the second line printed on top of the
       * row below. Set the font before calling.
       */
      const clip = (text: string, maxW: number): string => {
        let t = String(text == null ? '' : text);
        if (doc.widthOfString(t) <= maxW) return t;
        // One proportional guess, then walk the last few characters off.
        const per = doc.widthOfString(t) / Math.max(1, t.length);
        t = t.slice(0, Math.max(1, Math.floor(maxW / Math.max(0.01, per))));
        while (t.length > 1 && doc.widthOfString(t + '...') > maxW) t = t.slice(0, -1);
        return t.replace(/\s+$/, '') + '...';
      };

      /** Start a new page when the next block will not fit. */
      const need = (h: number) => {
        if (y + h <= BOTTOM) return;
        doc.addPage();
        y = 50;
      };

      const rule = (yy: number, colour = RULE) => {
        doc.moveTo(L, yy).lineTo(R, yy).strokeColor(colour).lineWidth(0.5).stroke();
      };

      // -- Header ----------------------------------------------------------
      doc.fillColor(ORANGE).rect(0, 0, doc.page.width, 6).fill();

      const TITLE = 'BANK RECONCILIATION STATEMENT';
      doc.font('Helvetica-Bold').fontSize(17);
      const TITLE_W = doc.widthOfString(TITLE);
      doc.fillColor(DARK).text(TITLE, L, 26, { lineBreak: false });
      doc.fillColor(MUTED).font('Helvetica').fontSize(10)
        .text(clip(data.property_name, W * 0.6), L, 50, { lineBreak: false });
      if (data.property_gstin) {
        doc.fillColor(LIGHT).fontSize(8).text(`GSTIN ${data.property_gstin}`, L, 64, { width: W * 0.62 });
      }

      // Whatever the title leaves, minus a gap. The label is property data and
      // can be long; the title is fixed, so it is the one that gets measured.
      doc.fillColor(ORANGE).font('Helvetica-Bold').fontSize(11.5);
      doc.text(clip(`${data.account_code}  ${data.account_label || ''}`.trim(), Math.max(90, W - TITLE_W - 16)),
        0, 29, { align: 'right', width: R, lineBreak: false });
      doc.fillColor(DARK).font('Helvetica-Bold').fontSize(10)
        .text(`As at ${prettyDate(data.statement_date)}`, 0, 46, { align: 'right', width: R });
      const signedOff = String(data.status || 'DRAFT').toUpperCase() === 'FINAL';
      doc.fillColor(signedOff ? GREEN : LIGHT).font('Helvetica-Bold').fontSize(8)
        .text(signedOff ? 'SIGNED OFF' : 'DRAFT', 0, 62, { align: 'right', width: R });

      y = 84;
      rule(y);
      y += 16;

      // -- The reconciliation ----------------------------------------------
      // The whole point of the document. Everything below it is evidence.
      const row = (
        label: string,
        value: number | null,
        opts?: { bold?: boolean; sign?: string; note?: string; shade?: boolean; colour?: string },
      ) => {
        need(22);
        if (opts && opts.shade) doc.fillColor('#fdfaf5').rect(L, y - 5, W, 22).fill();
        const bold = !!(opts && opts.bold);
        doc.fillColor(bold ? DARK : MUTED).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
        doc.text(label, L + 8, y, { width: W - 150, lineBreak: false });
        if (opts && opts.note) {
          const after = L + 8 + doc.widthOfString(label) + 8;
          doc.fillColor(LIGHT).font('Helvetica').fontSize(7.5);
          doc.text(clip(opts.note, Math.max(40, amtX - after - 12)), after, y + 2, { lineBreak: false });
        }
        const shown = value == null ? '-' : ((opts && opts.sign ? opts.sign + ' ' : '') + money(value));
        doc.fillColor((opts && opts.colour) || (bold ? DARK : MUTED))
          .font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10)
          .text(shown, amtX, y, { width: amtW, align: 'right', lineBreak: false });
        y += 22;
      };

      doc.fillColor(LIGHT).font('Helvetica-Bold').fontSize(8).text('THE RECONCILIATION', L, y);
      y += 16;
      const boxTop = y - 6;

      const dep = data.deposits_in_transit;
      const chq = data.outstanding_cheques;

      row('Balance as per bank statement', data.statement_closing_balance, { bold: true });
      row('Add: deposits in transit', dep.total, {
        sign: '+', colour: GREEN,
        note: `${dep.count} item${dep.count === 1 ? '' : 's'} banked, not yet credited`,
      });
      row('Less: cheques not yet presented', chq.total, {
        sign: '-', colour: RUST,
        note: `${chq.count} item${chq.count === 1 ? '' : 's'} issued, not yet debited`,
      });
      rule(y - 6);
      row('Balance as per books', data.computed_book_balance, { bold: true, shade: true });
      row('Balance per general ledger', data.book_balance, { bold: true });
      rule(y - 6);
      row('Difference', data.difference, { bold: true, colour: data.reconciled ? GREEN : RUST });

      doc.rect(L, boxTop, W, y - boxTop - 4).strokeColor(RULE).lineWidth(0.8).stroke();
      y += 8;

      need(30);
      if (data.statement_closing_balance == null) {
        doc.fillColor(RUST).font('Helvetica-Bold').fontSize(9)
          .text('No bank statement balance has been recorded for this date, so the reconciliation is incomplete.', L, y, { width: W });
      } else if (data.reconciled) {
        doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(9)
          .text('Reconciled. The gap between the bank and the books is fully explained by the items listed below.', L, y, { width: W });
      } else {
        doc.fillColor(RUST).font('Helvetica-Bold').fontSize(9)
          .text(`Not reconciled. ${money(Math.abs(Number(data.difference || 0)))} of the gap is still unexplained.`, L, y, { width: W });
      }
      y += 28;

      // -- The evidence ----------------------------------------------------
      const itemTable = (title: string, subtitle: string, sec: BankRecStatementSection) => {
        need(64);
        doc.fillColor(LIGHT).font('Helvetica-Bold').fontSize(8).text(title.toUpperCase(), L, y, { lineBreak: false });
        doc.fillColor(LIGHT).font('Helvetica').fontSize(7.5)
          .text(subtitle, 0, y + 0.5, { align: 'right', width: R, lineBreak: false });
        y += 14;

        if (!sec.items.length) {
          doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9).text('None.', L + 8, y);
          y += 22;
          return;
        }

        const cDate = L + 8, cRef = L + 82, cNar = L + 186;
        const header = () => {
          doc.fillColor('#f5f0e8').rect(L, y - 4, W, 18).fill();
          doc.fillColor(DARK).font('Helvetica-Bold').fontSize(8);
          doc.text('Date', cDate, y, { lineBreak: false });
          doc.text('Journal', cRef, y, { lineBreak: false });
          doc.text('Narration', cNar, y, { lineBreak: false });
          doc.text('Amount', amtX, y, { width: amtW, align: 'right', lineBreak: false });
          y += 18;
        };
        header();

        for (const it of sec.items) {
          if (y + 16 > BOTTOM) { doc.addPage(); y = 50; header(); }
          doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
          doc.text(clip(prettyDate(it.entry_date), 70), cDate, y, { lineBreak: false });
          doc.text(clip(String(it.journal_ref || '-'), 98), cRef, y, { lineBreak: false });
          doc.text(clip(String(it.narration || '-'), Math.max(40, amtX - cNar - 14)), cNar, y, { lineBreak: false });
          doc.fillColor(DARK).text(money(it.amount), amtX, y, { width: amtW, align: 'right', lineBreak: false });
          y += 15;
          doc.moveTo(L, y - 3).lineTo(R, y - 3).strokeColor('#f0e8d8').lineWidth(0.3).stroke();
        }

        if (sec.truncated) {
          need(18);
          doc.fillColor(RUST).font('Helvetica-Oblique').fontSize(7.5)
            .text(`Only the ${sec.items.length} most recent of ${sec.count} items are listed. The total below covers all of them.`, cDate, y, { width: W - 20 });
          y += 16;
        }

        need(20);
        doc.fillColor(DARK).font('Helvetica-Bold').fontSize(9);
        doc.text(`Total - ${sec.count} item${sec.count === 1 ? '' : 's'}`, cDate, y, { lineBreak: false });
        doc.text(money(sec.total), amtX, y, { width: amtW, align: 'right', lineBreak: false });
        y += 26;
      };

      itemTable('Deposits in transit', 'In the books by the statement date; not yet credited by the bank', dep);
      itemTable('Cheques not yet presented', 'In the books by the statement date; not yet debited by the bank', chq);

      // -- Sign-off --------------------------------------------------------
      need(100);
      rule(y);
      y += 12;

      doc.fillColor(LIGHT).font('Helvetica').fontSize(7.5)
        .text(`Movements listed for ${prettyDate(data.window_from)} to ${prettyDate(data.window_to)}. Outstanding items are counted across the whole history of the account, not only that window.`, L, y, { width: W });
      y += 22;

      doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
        .text(`Prepared by ${data.prepared_by || '-'}${data.prepared_on ? '  on ' + prettyDate(data.prepared_on) : ''}`, L, y, { width: W * 0.6 });
      y += 34;

      const sigW = (W - 40) / 2;
      doc.moveTo(L, y).lineTo(L + sigW, y).strokeColor(LIGHT).lineWidth(0.5).stroke();
      doc.moveTo(L + sigW + 40, y).lineTo(R, y).strokeColor(LIGHT).lineWidth(0.5).stroke();
      doc.fillColor(LIGHT).font('Helvetica').fontSize(8);
      doc.text('Prepared by', L, y + 4, { width: sigW, lineBreak: false });
      doc.text('Reviewed by', L + sigW + 40, y + 4, { width: sigW, lineBreak: false });
      y += 28;

      doc.fillColor(LIGHT).font('Helvetica-Oblique').fontSize(7.5)
        .text(`Generated by Atithi Setu on ${data.generated_at}. This statement reads the ledger; it does not post to it.`, L, y, { width: W });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
