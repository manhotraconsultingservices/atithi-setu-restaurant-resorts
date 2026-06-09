// ═══════════════════════════════════════════════════════════════════════════
// offerLetterService.ts — Offer Letter PDF generator
// ═══════════════════════════════════════════════════════════════════════════
//
// Generates a professional offer-letter PDF. Two-page layout:
//   Page 1 — Cover letter body (template with placeholders interpolated)
//   Page 2 — CTC breakup table (monthly + annual columns)
//
// Templates are stored as HTML/markdown-flavoured plain text in
// offer_letter_templates.body_html with handlebars-style placeholders:
//   {{candidate_name}}, {{designation}}, {{ctc}}, {{joining_date}},
//   {{employer_name}}, {{department}}
//
// renderTemplate() does a simple string-replace — no template engine
// dependency needed for Phase 1 scope.
// ═══════════════════════════════════════════════════════════════════════════

import PDFKit from 'pdfkit';
import {
  PAGE_W, PAGE_H, M, INNER_W,
  INK, INK_SOFT, MUTED, HAIR, HIGHLIGHT,
  resolveLogoPath, rupee, fmtDate, amountInWords,
} from './invoiceServiceShared.ts';

const ACCENT = '#7c5e3c';

export type CtcBreakup = {
  basic: number;
  hra: number;
  special: number;
  conveyance: number;
  medical: number;
  other_allowances: number;
  pf_employer?: number;
  esi_employer?: number;
  gratuity?: number;
  total_monthly: number;
  total_annual: number;
};

export type OfferLetterData = {
  tenant: {
    name: string;
    address?: string;
    city?: string;
    state?: string;
    pincode?: string;
    logo_url?: string;
    website?: string;
    contact_email?: string;
    contact_phone?: string;
  };
  candidate: {
    name: string;
    email?: string;
    phone?: string;
    address?: string;
  };
  offer: {
    offer_number: string;
    designation: string;
    department?: string;
    joining_date: string;
    ctc: number;
    ctc_breakup: CtcBreakup;
    expires_at?: string;
    issued_date: string;
  };
  body_html: string;  // template content with placeholders already interpolated
};

export function renderTemplate(template: string, vars: Record<string, string>): string {
  let out = String(template || '');
  for (const [key, value] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), String(value ?? ''));
  }
  return out;
}

export const DEFAULT_OFFER_TEMPLATE = `Dear {{candidate_name}},

We are delighted to extend this offer of employment for the position of {{designation}} at {{employer_name}}. Your skills, experience and energy align well with what our team needs, and we are excited about the contribution you will make.

This letter sets out the principal terms of the offer.

1. Position
You will join {{employer_name}} as {{designation}} in the {{department}} team.

2. Start Date
Your tentative joining date is {{joining_date}}. Joining-day formalities will take approximately one hour.

3. Compensation
Your total cost-to-company (CTC) will be {{ctc_in_words}}. A detailed breakup of monthly and annual components is set out in Annexure A to this letter.

4. Place of Work
You will be based at the {{employer_name}} office in {{employer_city}}. From time to time, you may be required to work at other locations.

5. Probation & Confirmation
Your appointment will be subject to a probation period of six months, during which performance will be reviewed against agreed expectations. Confirmation will be communicated in writing.

6. Notice Period
Either party may terminate this employment by serving 30 days' notice during probation and 60 days' notice post-confirmation.

7. Conditions Precedent
This offer is subject to:
  (a) Verification of qualifications, prior employment and identity documents.
  (b) Completion of medical and background checks customary for the role.
  (c) Submission of relieving documents from your previous employer (if any).

8. Acceptance
Please indicate your acceptance by signing the duplicate copy of this letter and returning it to us by {{expires_at_label}}.

We look forward to welcoming you and to a rewarding association.

Warm regards,

Human Resources
{{employer_name}}
`;

export async function generateOfferLetterPdf(data: OfferLetterData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFKit({ size: 'A4', margin: 0, info: { Title: `Offer Letter — ${data.candidate.name}` } });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ── Page 1: Header + Body ───────────────────────────────────────
      let y = M;
      const logoPath = resolveLogoPath(data.tenant.logo_url);
      if (logoPath) {
        try { doc.image(logoPath, M, y, { fit: [70, 50] }); } catch { /* ignore */ }
      }
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(15).text(data.tenant.name, M + 80, y + 4, { width: INNER_W - 80 });
      const addrParts = [data.tenant.address, data.tenant.city, data.tenant.state, data.tenant.pincode].filter(Boolean);
      doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(addrParts.join(', '), M + 80, y + 26, { width: INNER_W - 80 });
      const contact: string[] = [];
      if (data.tenant.contact_email) contact.push(data.tenant.contact_email);
      if (data.tenant.contact_phone) contact.push(data.tenant.contact_phone);
      if (data.tenant.website) contact.push(data.tenant.website);
      doc.text(contact.join('  •  '), M + 80, y + 38, { width: INNER_W - 80 });

      y += 72;
      doc.strokeColor(HAIR).lineWidth(0.5).moveTo(M, y).lineTo(M + INNER_W, y).stroke();
      y += 12;

      // Letter metadata band (Ref + Date)
      doc.fillColor(MUTED).font('Helvetica').fontSize(9)
         .text(`Ref: ${data.offer.offer_number}`, M, y, { width: INNER_W / 2 })
         .text(`Date: ${fmtDate(data.offer.issued_date)}`, M + INNER_W / 2, y, { width: INNER_W / 2, align: 'right' });
      y += 18;

      // To: candidate
      doc.fillColor(INK).font('Helvetica').fontSize(10).text(`To,`, M, y);
      y += 13;
      doc.font('Helvetica-Bold').text(data.candidate.name, M, y);
      y += 13;
      doc.font('Helvetica').fontSize(9.5).fillColor(INK_SOFT);
      if (data.candidate.address) {
        doc.text(data.candidate.address, M, y, { width: INNER_W });
        y += 24;
      }
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(`Subject: Letter of Offer — ${data.offer.designation}`, M, y, { width: INNER_W });
      y += 22;

      // Body
      doc.fillColor(INK).font('Helvetica').fontSize(10);
      const body = data.body_html;
      doc.text(body, M, y, { width: INNER_W, align: 'justify' });

      // ── Page 2: CTC Breakup ─────────────────────────────────────────
      doc.addPage();
      y = M;
      doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(16)
         .text('ANNEXURE A — CTC BREAKUP', M, y, { width: INNER_W, align: 'center' });
      y += 22;
      doc.fillColor(MUTED).font('Helvetica').fontSize(9)
         .text(`${data.candidate.name}  •  ${data.offer.designation}  •  ${fmtDate(data.offer.joining_date)}`,
               M, y, { width: INNER_W, align: 'center' });
      y += 28;

      // Table
      const colW = INNER_W / 3;
      doc.fillColor(ACCENT).rect(M, y, INNER_W, 22).fill();
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10)
         .text('Component', M + 8, y + 6, { width: colW })
         .text('Monthly (₹)', M + colW, y + 6, { width: colW, align: 'right' })
         .text('Annual (₹)', M + colW * 2, y + 6, { width: colW - 8, align: 'right' });
      y += 24;
      const row = (label: string, monthly: number, opts?: { highlight?: boolean; bold?: boolean; group?: string }) => {
        if (opts?.highlight) doc.fillColor(HIGHLIGHT).rect(M, y, INNER_W, 20).fill();
        if (opts?.group) {
          doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text(opts.group, M + 8, y + 6, { width: colW });
          y += 20;
          return;
        }
        doc.fillColor(INK).font(opts?.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5)
           .text(label, M + 8, y + 6, { width: colW })
           .text(rupee(monthly), M + colW, y + 6, { width: colW, align: 'right' })
           .text(rupee(monthly * 12), M + colW * 2, y + 6, { width: colW - 8, align: 'right' });
        y += 20;
      };

      const b = data.offer.ctc_breakup;
      row('Earnings', 0, { group: 'EARNINGS' });
      if (b.basic) row('Basic Salary', b.basic, { highlight: true });
      if (b.hra) row('House Rent Allowance', b.hra);
      if (b.special) row('Special Allowance', b.special, { highlight: true });
      if (b.conveyance) row('Conveyance', b.conveyance);
      if (b.medical) row('Medical Allowance', b.medical, { highlight: true });
      if (b.other_allowances) row('Other Allowances', b.other_allowances);
      if (b.pf_employer || b.esi_employer || b.gratuity) {
        row('Statutory Contributions (Employer)', 0, { group: 'STATUTORY CONTRIBUTIONS' });
        if (b.pf_employer) row("Provident Fund (Employer's share)", b.pf_employer, { highlight: true });
        if (b.esi_employer) row("ESI (Employer's share)", b.esi_employer);
        if (b.gratuity) row('Gratuity (Statutory)', b.gratuity, { highlight: true });
      }

      // Totals
      doc.fillColor(INK_SOFT).rect(M, y, INNER_W, 24).fill();
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11)
         .text('TOTAL COST TO COMPANY (CTC)', M + 8, y + 7, { width: colW * 1.5 })
         .text(rupee(b.total_monthly), M + colW, y + 7, { width: colW, align: 'right' })
         .text(rupee(b.total_annual), M + colW * 2, y + 7, { width: colW - 8, align: 'right' });
      y += 32;

      // CTC in words
      doc.fillColor(INK_SOFT).font('Helvetica').fontSize(9)
         .text(`Total annual CTC: ${amountInWords(b.total_annual, { currency_code: 'INR', currency_symbol: '₹' } as any)}`,
               M, y, { width: INNER_W });
      y += 16;
      doc.fillColor(MUTED).fontSize(8.5)
         .text('Note: Variable / performance components, if any, are detailed in the appointment letter. Statutory contributions are governed by applicable Indian laws as in force from time to time. CTC components and percentages may be revised in accordance with revised policies.',
               M, y, { width: INNER_W });

      // Acceptance band at bottom
      doc.fillColor(ACCENT).rect(M, PAGE_H - 100, INNER_W, 60).fill();
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text('ACCEPTANCE', M + 14, PAGE_H - 92);
      doc.font('Helvetica').fontSize(9).fillColor('#f1e3cf')
         .text(`I, ${data.candidate.name}, accept the terms set out in this Letter of Offer and Annexure A.`,
               M + 14, PAGE_H - 76, { width: INNER_W - 28 });
      doc.text(`Signature: __________________________     Date: __________________`,
               M + 14, PAGE_H - 56, { width: INNER_W - 28 });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/** Derive a balanced CTC breakup from the gross monthly figure.
 *  Standard Indian PMS allocation: 50% basic, 25% HRA, balance into special. */
export function buildDefaultCtcBreakup(grossMonthly: number): CtcBreakup {
  const basic = Math.round(grossMonthly * 0.5);
  const hra = Math.round(grossMonthly * 0.25);
  const special = grossMonthly - basic - hra;
  const pf_employer = Math.round(Math.min(basic, 15000) * 0.12);
  return {
    basic,
    hra,
    special,
    conveyance: 0,
    medical: 0,
    other_allowances: 0,
    pf_employer,
    esi_employer: 0,
    gratuity: 0,
    total_monthly: grossMonthly,
    total_annual: grossMonthly * 12,
  };
}
