/**
 * Atithi Setu — Form C (FRRO) PDF generator
 *
 * Generates a fillable Form C for foreign national registration as required by
 * Indian law (Foreigners Regional Registration Office). Data fields follow the
 * official FRRO Form C template used by hotels / guest houses.
 *
 * Usage:
 *   import { generateFormCPdf } from './formCService.ts';
 *   const buffer = await generateFormCPdf({ hotel, booking });
 *   res.setHeader('Content-Type', 'application/pdf');
 *   res.send(buffer);
 */

import PDFDocument from 'pdfkit';

export interface FormCData {
  hotel: {
    name: string;
    address?: string;
    city?: string;
    state?: string;
    gstNumber?: string;
    contactPhone?: string;
    contactEmail?: string;
  };
  booking: {
    guest_name: string;
    guest_phone?: string;
    guest_email?: string;
    guest_nationality: string;
    guest_id_proof?: string;    // passport number
    visa_number?: string;       // optional — not always captured
    visa_type?: string;         // optional
    port_of_arrival?: string;   // optional
    arrival_date?: string;      // optional
    purpose?: string;           // 'Tourism' default
    room_name?: string;
    num_guests?: number;
    check_in_date: string;
    check_out_date: string;
    actual_checkin_at?: string;
  };
  referenceNumber?: string;     // Form-C log ID
}

/**
 * Returns a Buffer containing the generated Form-C PDF.
 */
export async function generateFormCPdf(data: FormCData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        info: {
          Title: `Form C — ${data.booking.guest_name}`,
          Author: 'Atithi Setu',
          Subject: 'Foreigner Registration Form C',
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const LEFT = 40;
      const RIGHT = 555;
      const FIELD_LABEL_COLOR = '#1a1208';
      const FIELD_VALUE_COLOR = '#2d2418';
      const BORDER = '#1a1208';

      // ── HEADER ─────────────────────────────────────────────────────────
      doc.lineWidth(1.5).strokeColor(BORDER).rect(LEFT, 40, RIGHT - LEFT, 60).stroke();
      doc.fontSize(9).fillColor('#6b5d52')
         .text('GOVERNMENT OF INDIA · MINISTRY OF HOME AFFAIRS',
               LEFT + 10, 50, { width: RIGHT - LEFT - 20, align: 'center' });
      doc.fontSize(16).fillColor(FIELD_LABEL_COLOR).font('Helvetica-Bold')
         .text('FORM C', LEFT + 10, 63, { width: RIGHT - LEFT - 20, align: 'center' });
      doc.fontSize(9).fillColor('#6b5d52').font('Helvetica')
         .text('Arrival Report — Foreign National (Rule 14 of Registration of Foreigners Rules, 1992)',
               LEFT + 10, 83, { width: RIGHT - LEFT - 20, align: 'center' });

      // Reference bar
      let y = 115;
      doc.fontSize(9).fillColor('#6b5d52')
         .text(`Ref: ${data.referenceNumber || '—'}`, LEFT, y)
         .text(`Generated: ${new Date().toLocaleDateString('en-IN')}`, RIGHT - 150, y);
      y += 20;

      // ── SECTION 1: Hotel particulars ────────────────────────────────────
      y = drawSectionHeader(doc, 'A. Accommodation Provider (Hotel / Guest House)', LEFT, RIGHT, y);
      y = drawField(doc, 'Name of Establishment', data.hotel.name, LEFT, RIGHT, y);
      y = drawField(doc, 'Address', [data.hotel.address, data.hotel.city, data.hotel.state].filter(Boolean).join(', ') || '—', LEFT, RIGHT, y);
      y = drawField(doc, 'GST Number', data.hotel.gstNumber || '—', LEFT, RIGHT, y, 0.5);
      y = drawField(doc, 'Phone / Email', [data.hotel.contactPhone, data.hotel.contactEmail].filter(Boolean).join(' · ') || '—', LEFT, RIGHT, y, 0.5, true);
      y += 10;

      // ── SECTION 2: Foreign guest particulars ────────────────────────────
      y = drawSectionHeader(doc, 'B. Particulars of Foreign National', LEFT, RIGHT, y);
      y = drawField(doc, 'Full Name', data.booking.guest_name, LEFT, RIGHT, y);
      y = drawField(doc, 'Nationality', data.booking.guest_nationality, LEFT, RIGHT, y, 0.5);
      y = drawField(doc, 'Purpose of Visit', data.booking.purpose || 'Tourism', LEFT, RIGHT, y, 0.5, true);
      y = drawField(doc, 'Passport Number', data.booking.guest_id_proof || '—', LEFT, RIGHT, y, 0.5);
      y = drawField(doc, 'Visa Number', data.booking.visa_number || '—', LEFT, RIGHT, y, 0.5, true);
      y = drawField(doc, 'Visa Type', data.booking.visa_type || '—', LEFT, RIGHT, y, 0.5);
      y = drawField(doc, 'Port of Arrival', data.booking.port_of_arrival || '—', LEFT, RIGHT, y, 0.5, true);
      y = drawField(doc, 'Date of Arrival (in India)', fmt(data.booking.arrival_date) || '—', LEFT, RIGHT, y, 0.5);
      y = drawField(doc, 'No. of Accompanying Guests', String((data.booking.num_guests || 1) - 1), LEFT, RIGHT, y, 0.5, true);
      y = drawField(doc, 'Phone', data.booking.guest_phone || '—', LEFT, RIGHT, y, 0.5);
      y = drawField(doc, 'Email', data.booking.guest_email || '—', LEFT, RIGHT, y, 0.5, true);
      y += 10;

      // ── SECTION 3: Stay details ─────────────────────────────────────────
      y = drawSectionHeader(doc, 'C. Stay Details', LEFT, RIGHT, y);
      y = drawField(doc, 'Room / Unit', data.booking.room_name || '—', LEFT, RIGHT, y, 0.5);
      y = drawField(doc, 'Date of Check-in at Hotel', fmt(data.booking.actual_checkin_at || data.booking.check_in_date), LEFT, RIGHT, y, 0.5, true);
      y = drawField(doc, 'Scheduled Check-out', fmt(data.booking.check_out_date), LEFT, RIGHT, y);
      y += 15;

      // ── SECTION 4: Declaration ──────────────────────────────────────────
      y = drawSectionHeader(doc, 'D. Declaration & Signatures', LEFT, RIGHT, y);
      doc.fontSize(9).fillColor(FIELD_VALUE_COLOR).font('Helvetica')
         .text(
           'I certify that the above information is true and has been recorded at the time of check-in. ' +
           'This form will be submitted to the jurisdictional FRRO / FRO within 24 hours of the foreign national\'s arrival ' +
           'in accordance with the Registration of Foreigners Rules, 1992.',
           LEFT + 10, y, { width: RIGHT - LEFT - 20, lineGap: 2 }
         );
      y += 55;

      // Signature boxes
      const sigWidth = (RIGHT - LEFT - 20) / 2;
      doc.lineWidth(0.5).strokeColor('#9c8e85')
         .moveTo(LEFT + 10, y + 30).lineTo(LEFT + 10 + sigWidth - 10, y + 30).stroke()
         .moveTo(LEFT + 10 + sigWidth + 10, y + 30).lineTo(RIGHT - 10, y + 30).stroke();
      doc.fontSize(8).fillColor('#6b5d52')
         .text('Signature of Foreign National', LEFT + 10, y + 35, { width: sigWidth - 10, align: 'left' })
         .text('Signature of Authorised Hotel Officer', LEFT + 10 + sigWidth + 10, y + 35, { width: sigWidth - 10, align: 'left' });
      y += 60;

      // Footer
      doc.fontSize(7).fillColor('#9c8e85')
         .text(
           'This Form C was generated by Atithi Setu — a multi-tenant hospitality management platform by Manhotra Consulting.',
           LEFT, 800, { width: RIGHT - LEFT, align: 'center' }
         );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ─── Helper: section header bar ──────────────────────────────────────────
function drawSectionHeader(doc: PDFKit.PDFDocument, title: string, left: number, right: number, y: number): number {
  doc.lineWidth(0.8).strokeColor('#1a1208').fillColor('#faf7f2')
     .rect(left, y, right - left, 18).fillAndStroke('#faf7f2', '#1a1208');
  doc.fontSize(10).fillColor('#1a1208').font('Helvetica-Bold')
     .text(title, left + 8, y + 4, { width: right - left - 16 });
  return y + 22;
}

// ─── Helper: render a labelled field, optionally split across 2 columns ───
function drawField(
  doc: PDFKit.PDFDocument, label: string, value: string,
  left: number, right: number, y: number,
  width: number = 1.0, isSecondColumn: boolean = false
): number {
  const colWidth = (right - left - 10) / (width < 1 ? 2 : 1);
  const x = isSecondColumn ? left + colWidth + 10 : left;
  doc.fontSize(8).fillColor('#6b5d52').font('Helvetica-Bold')
     .text(label.toUpperCase(), x + 4, y + 2, { width: colWidth - 8 });
  doc.fontSize(10).fillColor('#1a1208').font('Helvetica')
     .text(value || '—', x + 4, y + 13, { width: colWidth - 8 });
  doc.lineWidth(0.4).strokeColor('#c5b9b2').rect(x, y, colWidth, 28).stroke();
  return isSecondColumn ? y + 30 : (width < 1 ? y : y + 30);
}

// ─── Helper: format dates ─────────────────────────────────────────────────
function fmt(val: string | undefined): string {
  if (!val) return '—';
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return val;
    return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: '2-digit' });
  } catch {
    return val;
  }
}
