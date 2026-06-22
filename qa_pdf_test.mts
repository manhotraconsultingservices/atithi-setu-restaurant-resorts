// Quick smoke test for HR PDF generation
import { generatePayslipPdf } from './payslipService.ts';
import { generateOfferLetterPdf, buildDefaultCtcBreakup } from './offerLetterService.ts';
import { generateForm16Pdf } from './statutoryExports.ts';

async function run() {
  console.log('--- Testing payslip PDF ---');
  try {
    const buf = await generatePayslipPdf({
      tenant: { name: 'Viveks Cafe', currency_code: 'INR', currency_symbol: '₹' },
      payslip: {
        payslip_number: 'PSLIP-TEST-001',
        pay_period_start: '2025-01-01',
        pay_period_end: '2025-01-31',
        work_days: 26, paid_days: 24, lop_days: 2,
        gross_earnings: 42000, gross_deductions: 7200, net_pay: 34800,
        pf_employer_eps: 1250, pf_employer_epf: 550, esi_employer: 0,
        line_items: [
          { label: 'Basic', type: 'EARNING', amount: 21000 },
          { label: 'HRA', type: 'EARNING', amount: 10500 },
          { label: 'Special Allowance', type: 'EARNING', amount: 10500 },
          { label: 'PF (Employee)', type: 'DEDUCTION', amount: 1800 },
          { label: 'Professional Tax', type: 'DEDUCTION', amount: 200 },
          { label: 'TDS', type: 'DEDUCTION', amount: 5200 },
        ],
      },
      employee: { name: 'Rahul Sharma', designation: 'Receptionist', department: 'Front Desk', pan: 'ABCDE1234F', uan: '100123456789' },
    });
    console.log('  PASS: payslip PDF generated', buf.length, 'bytes');
  } catch (err: any) {
    console.error('  FAIL:', err.message);
    console.error(err.stack);
  }

  console.log('--- Testing offer letter PDF ---');
  try {
    const ctcBreakup = buildDefaultCtcBreakup(42000);
    const buf = await generateOfferLetterPdf({
      tenant: { name: 'Viveks Cafe', address: '123 MG Road', city: 'Bengaluru', state: 'Karnataka' },
      candidate: { name: 'Priya Patel', email: 'priya@example.com' },
      offer: {
        offer_number: 'OL-TEST-001',
        designation: 'Senior Receptionist',
        department: 'Front Desk',
        joining_date: '2025-02-01',
        ctc: 504000,
        ctc_breakup: ctcBreakup,
        issued_date: '2025-01-15',
      },
      body_html: 'Dear Priya, We are pleased to offer you the position of Senior Receptionist.',
    });
    console.log('  PASS: offer letter PDF generated', buf.length, 'bytes');
  } catch (err: any) {
    console.error('  FAIL:', err.message);
    console.error(err.stack);
  }

  console.log('--- Testing Form 16 PDF ---');
  try {
    const buf = await generateForm16Pdf({
      tenant: { name: 'Viveks Cafe', pan: 'ABCDE1234F', tan: 'BANG01234B' },
      employee: { name: 'Rahul Sharma', pan: 'XYZAB5678C', designation: 'Receptionist' },
      fy: '2025-26',
      assessment_year: '2026-27',
      regime: 'NEW',
      quarters: [{ quarter: 'Q1', period: 'Apr-Jun 2025', amount_paid: 126000, tds_deducted: 15600, tds_deposited: 15600 }],
      gross_salary: 504000,
      exempt_allowances: 0,
      standard_deduction: 50000,
      professional_tax_annual: 2400,
      net_taxable_salary: 451600,
      chapter_via_80c: 0,
      chapter_via_other: 0,
      total_taxable_income: 451600,
      tax_on_total_income: 10080,
      surcharge: 0,
      cess: 403,
      total_tax: 10483,
      relief_section_89: 0,
      net_tax_payable: 10483,
      total_tax_deducted: 10483,
    });
    console.log('  PASS: Form 16 PDF generated', buf.length, 'bytes');
  } catch (err: any) {
    console.error('  FAIL:', err.message);
    console.error(err.stack);
  }
}

run().then(() => { console.log('Done.'); process.exit(0); }).catch(e => { console.error('Fatal:', e); process.exit(1); });
