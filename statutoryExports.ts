// ═══════════════════════════════════════════════════════════════════════════
// statutoryExports.ts — Form 16, Form 24Q, EPF ECR generators
// ═══════════════════════════════════════════════════════════════════════════
//
// Indian statutory filings:
//   • Form 16  — annual TDS certificate per employee (PART A + PART B)
//   • Form 24Q — quarterly TDS return for salaries (statement)
//   • EPF ECR  — Electronic Challan-cum-Return text upload for EPFO
//
// PDFs follow the same boutique aesthetic as payslipService.ts (shared
// invoiceServiceShared helpers). The Phase 1 PDFs hold the right SHAPE
// and SIGNIFICANT NUMBERS — they're not pixel-perfect IT-department
// templates (those need stamping anyway). Tenants who want a perfect
// Form 16 can run it through their CA's TRACES portal; this one is for
// employee handover.
// ═══════════════════════════════════════════════════════════════════════════

import PDFKit from 'pdfkit';
import {
  PAGE_W, PAGE_H, M, INNER_W,
  INK, INK_SOFT, MUTED, HAIR, HIGHLIGHT,
  HAS_HINDI_FONT, HINDI_REG, HINDI_BOLD,
  resolveLogoPath, rupee, fmtDate,
} from './invoiceServiceShared.ts';

const ACCENT = '#7c5e3c';

export type Form16Data = {
  tenant: {
    name: string;
    address?: string;
    pan?: string;
    tan?: string;
    gstin?: string;
  };
  employee: {
    name: string;
    pan?: string;
    designation?: string;
    department?: string;
    joining_date?: string;
    address?: string;
  };
  fy: string;                  // '2025-26'
  assessment_year: string;     // '2026-27'
  regime: 'OLD' | 'NEW';
  // PART A — quarterly summary
  quarters: Array<{
    quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4';
    receipt_no?: string;       // TRACES receipt number; usually blank for our MVP
    period: string;            // 'Apr-Jun 2025'
    amount_paid: number;
    tds_deducted: number;
    tds_deposited: number;
  }>;
  // PART B — annual computation
  gross_salary: number;
  exempt_allowances: number;   // HRA / LTA / others
  standard_deduction: number;  // 50000 default
  professional_tax_annual: number;
  net_taxable_salary: number;
  chapter_via_80c: number;
  chapter_via_other: number;
  total_taxable_income: number;
  tax_on_total_income: number;
  surcharge: number;
  cess: number;
  total_tax: number;
  relief_section_89: number;
  net_tax_payable: number;
  total_tax_deducted: number;
};

export async function generateForm16Pdf(data: Form16Data): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFKit({ size: 'A4', margin: 0, info: { Title: `Form 16 — ${data.employee.name} — FY ${data.fy}` } });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      if (HAS_HINDI_FONT) {
        try { doc.registerFont('Hindi-Regular', HINDI_REG); doc.registerFont('Hindi-Bold', HINDI_BOLD); } catch { /* ignore */ }
      }

      let y = M;
      // Header
      doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(16).text('FORM 16', M, y, { width: INNER_W, align: 'center' });
      y += 18;
      doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
         .text('Certificate under section 203 of the Income-tax Act, 1961, for tax deducted at source on salary', M, y, { width: INNER_W, align: 'center' });
      y += 14;
      doc.text(`FY ${data.fy}  •  Assessment Year ${data.assessment_year}  •  ${data.regime} REGIME`, M, y, { width: INNER_W, align: 'center' });
      y += 18;

      // PART A
      doc.fillColor(ACCENT).rect(M, y, INNER_W, 18).fill();
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10)
         .text('PART A — Details of tax deducted and deposited', M + 8, y + 5);
      y += 24;

      // Employer + Employee block
      const halfW = (INNER_W - 16) / 2;
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('EMPLOYER (Deductor)', M, y);
      doc.text('EMPLOYEE (Deductee)', M + halfW + 16, y);
      y += 11;
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(data.tenant.name, M, y, { width: halfW });
      doc.text(data.employee.name, M + halfW + 16, y, { width: halfW });
      y += 14;
      doc.fillColor(INK_SOFT).font('Helvetica').fontSize(9);
      if (data.tenant.address) { doc.text(data.tenant.address, M, y, { width: halfW }); }
      if (data.employee.address) { doc.text(data.employee.address, M + halfW + 16, y, { width: halfW }); }
      y += 24;
      doc.fillColor(INK_SOFT).font('Helvetica').fontSize(9);
      const empLines: string[] = [];
      if (data.tenant.pan) empLines.push(`PAN: ${data.tenant.pan}`);
      if (data.tenant.tan) empLines.push(`TAN: ${data.tenant.tan}`);
      doc.text(empLines.join('  •  '), M, y, { width: halfW });
      const eeLines: string[] = [];
      if (data.employee.pan) eeLines.push(`PAN: ${data.employee.pan}`);
      if (data.employee.designation) eeLines.push(`Designation: ${data.employee.designation}`);
      doc.text(eeLines.join('  •  '), M + halfW + 16, y, { width: halfW });
      y += 16;

      // Quarterly table
      const colWQ = INNER_W / 5;
      doc.fillColor(INK_SOFT).rect(M, y, INNER_W, 20).fill();
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9)
         .text('Quarter', M + 4, y + 6, { width: colWQ })
         .text('Period', M + colWQ + 4, y + 6, { width: colWQ })
         .text('Amount Paid', M + colWQ * 2 + 4, y + 6, { width: colWQ, align: 'right' })
         .text('Tax Deducted', M + colWQ * 3 + 4, y + 6, { width: colWQ, align: 'right' })
         .text('Tax Deposited', M + colWQ * 4 + 4, y + 6, { width: colWQ - 8, align: 'right' });
      y += 22;
      let totPaid = 0, totDed = 0, totDep = 0;
      data.quarters.forEach((q, i) => {
        if (i % 2 === 1) {
          doc.fillColor(HIGHLIGHT).rect(M, y, INNER_W, 18).fill();
        }
        doc.fillColor(INK).font('Helvetica').fontSize(9)
           .text(q.quarter, M + 4, y + 4, { width: colWQ })
           .text(q.period, M + colWQ + 4, y + 4, { width: colWQ })
           .text(rupee(q.amount_paid), M + colWQ * 2 + 4, y + 4, { width: colWQ, align: 'right' })
           .text(rupee(q.tds_deducted), M + colWQ * 3 + 4, y + 4, { width: colWQ, align: 'right' })
           .text(rupee(q.tds_deposited), M + colWQ * 4 + 4, y + 4, { width: colWQ - 8, align: 'right' });
        totPaid += q.amount_paid; totDed += q.tds_deducted; totDep += q.tds_deposited;
        y += 18;
      });
      // Totals row
      doc.fillColor(INK_SOFT).rect(M, y, INNER_W, 20).fill();
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9.5)
         .text('TOTAL', M + 4, y + 6, { width: colWQ * 2 })
         .text(rupee(totPaid), M + colWQ * 2 + 4, y + 6, { width: colWQ, align: 'right' })
         .text(rupee(totDed), M + colWQ * 3 + 4, y + 6, { width: colWQ, align: 'right' })
         .text(rupee(totDep), M + colWQ * 4 + 4, y + 6, { width: colWQ - 8, align: 'right' });
      y += 28;

      // PART B
      doc.fillColor(ACCENT).rect(M, y, INNER_W, 18).fill();
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10).text('PART B — Computation of total income', M + 8, y + 5);
      y += 24;

      const row = (label: string, value: number, opts?: { highlight?: boolean; bold?: boolean }) => {
        if (opts?.highlight) doc.fillColor(HIGHLIGHT).rect(M, y, INNER_W, 18).fill();
        doc.fillColor(INK).font(opts?.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5)
           .text(label, M + 8, y + 4, { width: INNER_W - 80 })
           .text(rupee(value), M + INNER_W - 80, y + 4, { width: 72, align: 'right' });
        y += 18;
      };

      row('1. Gross salary', data.gross_salary, { bold: true });
      row('2. Less: Allowances exempt under section 10', data.exempt_allowances, { highlight: true });
      row('3. Total (Net salary)', data.gross_salary - data.exempt_allowances, { bold: true });
      row('4. Less: Standard deduction u/s 16(ia)', data.standard_deduction, { highlight: true });
      row('5. Less: Professional Tax u/s 16(iii)', data.professional_tax_annual);
      row('6. Net taxable salary', data.net_taxable_salary, { bold: true, highlight: true });
      row('7. Less: Chapter VI-A — 80C', data.chapter_via_80c);
      row('8. Less: Chapter VI-A — Other', data.chapter_via_other);
      row('9. Total taxable income', data.total_taxable_income, { bold: true, highlight: true });
      row('10. Tax on total income', data.tax_on_total_income);
      row('11. Surcharge', data.surcharge);
      row('12. Health & Education Cess @ 4%', data.cess);
      row('13. Total tax payable', data.total_tax, { bold: true });
      row('14. Less: Relief u/s 89', data.relief_section_89);
      row('15. Net tax payable', data.net_tax_payable, { bold: true, highlight: true });
      row('16. Total tax deducted (PART A)', data.total_tax_deducted, { bold: true });

      const balance = data.net_tax_payable - data.total_tax_deducted;
      doc.fillColor(balance > 0 ? '#b85c2c' : ACCENT).rect(M, y, INNER_W, 26).fill();
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11)
         .text(balance > 0 ? `Net tax still payable: ${rupee(balance)}` : balance < 0 ? `Refund due: ${rupee(-balance)}` : 'Tax fully discharged',
               M + 8, y + 8, { width: INNER_W - 16 });
      y += 36;

      // Verification
      doc.fillColor(INK_SOFT).font('Helvetica').fontSize(8.5)
         .text(`I, on behalf of ${data.tenant.name}, certify that the information provided is true, correct and complete and is based on the books of accounts, salary payment records, and tax deducted at source as filed in the TDS statements.`,
               M, y, { width: INNER_W });
      y += 38;
      doc.text(`Signature of person responsible (Deductor)`, M, y, { width: INNER_W / 2 });
      doc.text(`Place: ___________________`, M + INNER_W / 2, y, { width: INNER_W / 2 });
      y += 14;
      doc.text(`Date: ${new Date().toISOString().slice(0, 10)}`, M + INNER_W / 2, y, { width: INNER_W / 2 });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Form 24Q — Quarterly TDS Return Statement
// ═══════════════════════════════════════════════════════════════════════════
export type Form24QData = {
  tenant: {
    name: string;
    pan?: string;
    tan?: string;
    address?: string;
  };
  fy: string;
  quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  period_start: string;
  period_end: string;
  deductees: Array<{
    employee_name: string;
    pan: string;
    section_code: string;        // '192' for salaries
    amount_paid: number;
    tds_deducted: number;
    bsr_code?: string;            // Bank/Branch Code where challan paid
    challan_serial?: string;
    deposit_date?: string;
  }>;
};

export async function generate24QPdf(data: Form24QData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFKit({ size: 'A4', margin: 0, layout: 'landscape', info: { Title: `Form 24Q ${data.quarter} ${data.fy}` } });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const PW = 842; const PH = 595;
      const m = 30;
      const innerW = PW - m * 2;

      let y = m;
      doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(16)
         .text('FORM 24Q', m, y, { width: innerW, align: 'center' });
      y += 18;
      doc.fillColor(MUTED).font('Helvetica').fontSize(9)
         .text(`Quarterly statement of tax deducted at source from salaries — ${data.quarter} ${data.fy} (${data.period_start} to ${data.period_end})`,
               m, y, { width: innerW, align: 'center' });
      y += 22;

      // Employer block
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(data.tenant.name, m, y);
      y += 14;
      doc.fillColor(INK_SOFT).font('Helvetica').fontSize(9);
      const ids: string[] = [];
      if (data.tenant.pan) ids.push(`PAN: ${data.tenant.pan}`);
      if (data.tenant.tan) ids.push(`TAN: ${data.tenant.tan}`);
      doc.text(ids.join('  •  '), m, y);
      y += 12;
      if (data.tenant.address) { doc.text(data.tenant.address, m, y, { width: innerW }); y += 12; }
      y += 6;

      // Table
      const cols = [
        { label: 'Sl', w: 30 },
        { label: 'Name', w: 130 },
        { label: 'PAN', w: 75 },
        { label: 'Sec', w: 35 },
        { label: 'Amount Paid', w: 80, num: true },
        { label: 'TDS Deducted', w: 80, num: true },
        { label: 'BSR', w: 70 },
        { label: 'Challan #', w: 90 },
        { label: 'Deposit Date', w: 80 },
      ];
      let x = m;
      doc.fillColor(INK_SOFT).rect(m, y, innerW, 20).fill();
      cols.forEach((c) => {
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9)
           .text(c.label, x + 4, y + 6, { width: c.w - 8, align: (c as any).num ? 'right' : 'left' });
        x += c.w;
      });
      y += 22;
      let totPaid = 0, totTds = 0;
      data.deductees.forEach((d, i) => {
        if (i % 2 === 1) doc.fillColor(HIGHLIGHT).rect(m, y, innerW, 18).fill();
        x = m;
        const cells = [
          String(i + 1),
          d.employee_name,
          d.pan,
          d.section_code,
          rupee(d.amount_paid),
          rupee(d.tds_deducted),
          d.bsr_code || '—',
          d.challan_serial || '—',
          d.deposit_date ? fmtDate(d.deposit_date) : '—',
        ];
        cells.forEach((cell, idx) => {
          doc.fillColor(INK).font('Helvetica').fontSize(9)
             .text(cell, x + 4, y + 4, { width: cols[idx].w - 8, align: (cols[idx] as any).num ? 'right' : 'left' });
          x += cols[idx].w;
        });
        totPaid += d.amount_paid; totTds += d.tds_deducted;
        y += 18;
      });
      // Totals
      doc.fillColor(INK_SOFT).rect(m, y, innerW, 22).fill();
      x = m;
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10);
      doc.text('TOTAL', x + 4, y + 7, { width: cols[0].w + cols[1].w + cols[2].w + cols[3].w - 8 });
      x += cols[0].w + cols[1].w + cols[2].w + cols[3].w;
      doc.text(rupee(totPaid), x + 4, y + 7, { width: cols[4].w - 8, align: 'right' });
      x += cols[4].w;
      doc.text(rupee(totTds), x + 4, y + 7, { width: cols[5].w - 8, align: 'right' });
      y += 30;

      doc.fillColor(INK_SOFT).font('Helvetica').fontSize(8.5)
         .text(`Total deductees: ${data.deductees.length}  •  Verification: I, on behalf of ${data.tenant.name}, declare that the above information is true and correct.`,
               m, y, { width: innerW });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// EPF ECR — Electronic Challan-cum-Return (EPFO Unified Portal upload)
// ═══════════════════════════════════════════════════════════════════════════
// Format: pipe-delimited text file with 11 fields per line.
//   UAN | MEMBER_NAME | GROSS_WAGES | EPF_WAGES | EPS_WAGES |
//     EDLI_WAGES | EPF_CONTRIB_REMITTED | EPS_CONTRIB_REMITTED |
//     EPF_EPS_DIFF_REMITTED | NCP_DAYS | REFUND_OF_ADVANCES
//
// Reference: EPFO ECR Help File v2.0 (2017+). The format has been
// stable since 2017 — we re-validate on each release against the
// EPFO portal's online validator.

export type EpfEcrRow = {
  uan: string;                         // 12-digit UAN
  member_name: string;                 // upto 85 chars, uppercase, no special chars except space + period
  gross_wages: number;                 // PF base × 12 worked days etc — passed in by caller
  epf_wages: number;                   // min(basic, ceiling), pro-rated
  eps_wages: number;                   // same as EPF for wages ≤ ceiling
  edli_wages: number;                  // EDLI base — same as EPF wages
  epf_contrib_remitted: number;        // employer EPF (12% basic - eps)
  eps_contrib_remitted: number;        // 8.33% capped
  epf_eps_diff_remitted: number;       // employer 12% − eps
  ncp_days: number;                    // non-contributory period (LOP)
  refund_of_advances: number;
};

export function generateEpfEcr(rows: EpfEcrRow[]): string {
  const sanitize = (s: string) =>
    String(s || '').toUpperCase().replace(/[^A-Z0-9. ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 85);
  const lines: string[] = [];
  for (const r of rows) {
    const fields = [
      String(r.uan || '').replace(/\D/g, '').padStart(12, '0').slice(-12),
      sanitize(r.member_name),
      Math.max(0, Math.round(Number(r.gross_wages) || 0)),
      Math.max(0, Math.round(Number(r.epf_wages) || 0)),
      Math.max(0, Math.round(Number(r.eps_wages) || 0)),
      Math.max(0, Math.round(Number(r.edli_wages) || 0)),
      Math.max(0, Math.round(Number(r.epf_contrib_remitted) || 0)),
      Math.max(0, Math.round(Number(r.eps_contrib_remitted) || 0)),
      Math.max(0, Math.round(Number(r.epf_eps_diff_remitted) || 0)),
      Math.max(0, Math.round(Number(r.ncp_days) || 0)),
      Math.max(0, Math.round(Number(r.refund_of_advances) || 0)),
    ];
    lines.push(fields.join('#~#'));
  }
  return lines.join('\n');
}
