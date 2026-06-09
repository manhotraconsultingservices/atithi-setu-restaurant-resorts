// ═══════════════════════════════════════════════════════════════════════════
// payslipService.ts — Atithi-Setu monthly payslip PDF
// ═══════════════════════════════════════════════════════════════════════════
//
// Boutique-style layout matching invoiceServiceBoutique aesthetic:
//   • Header band with company info + period
//   • Two-column staff snapshot (Identity / Statutory IDs)
//   • Earnings × Deductions side-by-side tables
//   • Net pay band with amount-in-words
//   • Statutory employer contributions (info-only) footer
//   • Optional bilingual labels (Hindi via HINDI_REG / HAS_HINDI_FONT)
//
// Pure function — no DB calls. The caller passes a fully-resolved
// PayslipData payload, this returns a Buffer.
// ═══════════════════════════════════════════════════════════════════════════

import PDFKit from 'pdfkit';
import {
  PAGE_W, PAGE_H, M, INNER_W,
  INK, INK_SOFT, MUTED, HAIR, HIGHLIGHT,
  HAS_HINDI_FONT, HINDI_REG, HINDI_BOLD,
  resolveLogoPath, rupee, fmtDate, amountInWords,
} from './invoiceServiceShared.ts';

export type PayslipLineItem = {
  label: string;
  type: 'EARNING' | 'DEDUCTION';
  amount: number;
};

export type PayslipData = {
  tenant: {
    name: string;
    address?: string;
    city?: string;
    state?: string;
    pincode?: string;
    gstin?: string;
    pan?: string;
    tan?: string;
    logo_url?: string;
    currency_symbol?: string;
    currency_code?: string;
  };
  payslip: {
    payslip_number: string;
    pay_period_start: string;   // YYYY-MM-DD
    pay_period_end: string;     // YYYY-MM-DD
    work_days: number;
    paid_days: number;
    lop_days: number;
    gross_earnings: number;
    gross_deductions: number;
    net_pay: number;
    pf_employer_eps: number;
    pf_employer_epf: number;
    esi_employer: number;
    line_items: PayslipLineItem[];
  };
  employee: {
    name: string;
    designation?: string;
    department?: string;
    joining_date?: string;
    pan?: string;
    uan?: string;
    esic_number?: string;
    bank_account?: string;
    bank_ifsc?: string;
    bank_name?: string;
  };
};

const ACCENT = '#7c5e3c'; // boutique mocha
const ROW_H = 18;

function periodLabel(start: string, end: string): string {
  // Render as "October 2026" if it's a single calendar month
  try {
    const s = new Date(start + 'T00:00:00Z');
    const e = new Date(end + 'T00:00:00Z');
    if (s.getUTCFullYear() === e.getUTCFullYear() && s.getUTCMonth() === e.getUTCMonth()) {
      return s.toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    }
    return `${fmtDate(start)} – ${fmtDate(end)}`;
  } catch {
    return `${start} – ${end}`;
  }
}

export async function generatePayslipPdf(data: PayslipData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFKit({ size: 'A4', margin: 0, info: { Title: `Payslip ${data.payslip.payslip_number}` } });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      if (HAS_HINDI_FONT) {
        try { doc.registerFont('Hindi-Regular', HINDI_REG); doc.registerFont('Hindi-Bold', HINDI_BOLD); } catch { /* ignore */ }
      }

      let y = M;

      // ── Header band ────────────────────────────────────────────────
      const logoPath = resolveLogoPath(data.tenant.logo_url);
      if (logoPath) {
        try { doc.image(logoPath, M, y, { fit: [80, 60] }); } catch { /* ignore */ }
      }
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(18)
         .text(data.tenant.name, M + 90, y + 4, { width: INNER_W - 90 });
      const addrParts = [data.tenant.address, data.tenant.city, data.tenant.state, data.tenant.pincode].filter(Boolean);
      doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(addrParts.join(', '), M + 90, y + 28, { width: INNER_W - 90 });
      const idsParts: string[] = [];
      if (data.tenant.pan) idsParts.push(`PAN: ${data.tenant.pan}`);
      if (data.tenant.tan) idsParts.push(`TAN: ${data.tenant.tan}`);
      if (data.tenant.gstin) idsParts.push(`GSTIN: ${data.tenant.gstin}`);
      doc.text(idsParts.join('  •  '), M + 90, y + 42, { width: INNER_W - 90 });

      // PAY SLIP title block (right-justified pair: title + period + slip no)
      doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(13).text('PAY SLIP', M, y + 4, { width: INNER_W, align: 'right' });
      doc.fillColor(INK_SOFT).font('Helvetica').fontSize(10)
         .text(periodLabel(data.payslip.pay_period_start, data.payslip.pay_period_end),
               M, y + 22, { width: INNER_W, align: 'right' });
      doc.fillColor(MUTED).fontSize(8.5).text(data.payslip.payslip_number, M, y + 36, { width: INNER_W, align: 'right' });

      y += 78;
      // Divider
      doc.strokeColor(HAIR).lineWidth(0.5).moveTo(M, y).lineTo(M + INNER_W, y).stroke();
      y += 10;

      // ── Employee block (2 columns) ─────────────────────────────────
      const colW = INNER_W / 2;
      const startY = y;

      // Left column: Identity
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('EMPLOYEE', M, y);
      y += 12;
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(data.employee.name || '—', M, y);
      y += 14;
      doc.fillColor(INK_SOFT).font('Helvetica').fontSize(9);
      if (data.employee.designation) { doc.text(data.employee.designation, M, y); y += 11; }
      if (data.employee.department) { doc.text(`Department: ${data.employee.department}`, M, y); y += 11; }
      if (data.employee.joining_date) { doc.text(`Joined: ${fmtDate(data.employee.joining_date)}`, M, y); y += 11; }

      // Right column: Statutory + bank
      let yR = startY;
      const rightX = M + colW + 10;
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('STATUTORY / BANK', rightX, yR);
      yR += 12;
      doc.fillColor(INK_SOFT).font('Helvetica').fontSize(9);
      if (data.employee.pan) { doc.text(`PAN: ${data.employee.pan}`, rightX, yR); yR += 11; }
      if (data.employee.uan) { doc.text(`UAN: ${data.employee.uan}`, rightX, yR); yR += 11; }
      if (data.employee.esic_number) { doc.text(`ESIC: ${data.employee.esic_number}`, rightX, yR); yR += 11; }
      if (data.employee.bank_account) {
        const masked = String(data.employee.bank_account).replace(/.(?=.{4})/g, '•');
        doc.text(`A/C: ${masked}`, rightX, yR); yR += 11;
      }
      if (data.employee.bank_ifsc) { doc.text(`IFSC: ${data.employee.bank_ifsc}`, rightX, yR); yR += 11; }
      if (data.employee.bank_name) { doc.text(`Bank: ${data.employee.bank_name}`, rightX, yR); yR += 11; }

      y = Math.max(y, yR) + 8;

      // Attendance band
      doc.fillColor(HIGHLIGHT).rect(M, y, INNER_W, 22).fill();
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9);
      const attendW = INNER_W / 3;
      doc.text(`Work Days: ${data.payslip.work_days}`, M + 8, y + 7, { width: attendW });
      doc.text(`Paid Days: ${data.payslip.paid_days}`, M + 8 + attendW, y + 7, { width: attendW });
      doc.fillColor(data.payslip.lop_days > 0 ? '#b85c2c' : INK).text(`LOP: ${data.payslip.lop_days}`, M + 8 + attendW * 2, y + 7, { width: attendW });
      y += 30;

      // ── Earnings / Deductions side-by-side ──────────────────────────
      const tableTop = y;
      const earnings = data.payslip.line_items.filter((l) => l.type === 'EARNING');
      const deductions = data.payslip.line_items.filter((l) => l.type === 'DEDUCTION');
      const tableW = (INNER_W - 16) / 2;

      // Earnings header
      doc.fillColor(ACCENT).rect(M, y, tableW, 20).fill();
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9.5).text('EARNINGS', M + 8, y + 6);
      doc.text('₹', M + tableW - 36, y + 6, { width: 28, align: 'right' });
      // Deductions header
      doc.fillColor(ACCENT).rect(M + tableW + 16, y, tableW, 20).fill();
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9.5).text('DEDUCTIONS', M + tableW + 24, y + 6);
      doc.text('₹', M + tableW + 16 + tableW - 36, y + 6, { width: 28, align: 'right' });
      y += 22;

      const rowsCount = Math.max(earnings.length, deductions.length);
      for (let i = 0; i < rowsCount; i++) {
        if (i % 2 === 1) {
          doc.fillColor(HIGHLIGHT).rect(M, y, tableW, ROW_H).fill();
          doc.fillColor(HIGHLIGHT).rect(M + tableW + 16, y, tableW, ROW_H).fill();
        }
        if (earnings[i]) {
          doc.fillColor(INK).font('Helvetica').fontSize(9.5).text(earnings[i].label, M + 8, y + 5, { width: tableW - 50 });
          doc.font('Helvetica-Bold').text(rupee(earnings[i].amount), M + tableW - 60, y + 5, { width: 52, align: 'right' });
        }
        if (deductions[i]) {
          doc.fillColor(INK).font('Helvetica').fontSize(9.5).text(deductions[i].label, M + tableW + 24, y + 5, { width: tableW - 50 });
          doc.font('Helvetica-Bold').text(rupee(deductions[i].amount), M + tableW + 16 + tableW - 60, y + 5, { width: 52, align: 'right' });
        }
        y += ROW_H;
      }

      // Subtotal row
      doc.fillColor(INK_SOFT).rect(M, y, tableW, 22).fill();
      doc.fillColor(INK_SOFT).rect(M + tableW + 16, y, tableW, 22).fill();
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10)
         .text('Gross Earnings', M + 8, y + 7)
         .text(rupee(data.payslip.gross_earnings), M + tableW - 60, y + 7, { width: 52, align: 'right' })
         .text('Gross Deductions', M + tableW + 24, y + 7)
         .text(rupee(data.payslip.gross_deductions), M + tableW + 16 + tableW - 60, y + 7, { width: 52, align: 'right' });
      y += 30;

      // ── Net Pay band ───────────────────────────────────────────────
      doc.fillColor(ACCENT).rect(M, y, INNER_W, 40).fill();
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text('NET PAY', M + 14, y + 8);
      doc.fontSize(20).text(rupee(data.payslip.net_pay), M + 14, y + 8, { width: INNER_W - 28, align: 'right' });
      doc.font('Helvetica').fontSize(8.5).fillColor('#f1e3cf')
         .text(amountInWords(data.payslip.net_pay, data.tenant), M + 14, y + 28, { width: INNER_W - 28, align: 'right' });
      y += 50;

      // ── Employer contributions (informational) ──────────────────────
      if (
        data.payslip.pf_employer_eps + data.payslip.pf_employer_epf + data.payslip.esi_employer > 0
      ) {
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('EMPLOYER CONTRIBUTIONS (info)', M, y);
        y += 12;
        doc.fillColor(INK_SOFT).font('Helvetica').fontSize(9);
        const items: string[] = [];
        if (data.payslip.pf_employer_eps) items.push(`PF (EPS): ${rupee(data.payslip.pf_employer_eps)}`);
        if (data.payslip.pf_employer_epf) items.push(`PF (EPF): ${rupee(data.payslip.pf_employer_epf)}`);
        if (data.payslip.esi_employer) items.push(`ESI: ${rupee(data.payslip.esi_employer)}`);
        doc.text(items.join('   •   '), M, y, { width: INNER_W });
        y += 14;
      }

      // Footer
      doc.fillColor(MUTED).font('Helvetica').fontSize(8)
         .text(
           'This is a computer-generated payslip. No signature required.',
           M, PAGE_H - 50, { width: INNER_W, align: 'center' }
         );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
