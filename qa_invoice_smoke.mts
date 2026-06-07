#!/usr/bin/env tsx
// Smoke test: render both Classic and Boutique PDFs from a fixture
// folio. Writes two .pdf files to qa_tmp/ so we can visually verify in
// any PDF reader. Exit code 0 = both rendered without throwing.
//
//   npx tsx qa_invoice_smoke.mts

import { generateInvoicePdf } from './invoiceService.js';
import type { InvoiceData } from './invoiceServiceShared.js';
import { writeFileSync, mkdirSync } from 'fs';

const fixture = (templateMode: 'CLASSIC' | 'BOUTIQUE'): InvoiceData => ({
  hotel: {
    name: 'Hotel Xanadu Goa',
    address: '14 Beach Road',
    city: 'Calangute',
    state: 'Goa',
    pincode: '403516',
    gstin: '30AABCU9603R1ZX',
    phone: '+91 832 555 0100',
    email: 'hello@hotelxanadu.in',
    website: 'https://hotelxanadu.in',
    fssai: '23420045000123',
    fssaiValidUntil: '2027-12-31',
  },
  guest: {
    name: 'Arjun Sharma',
    phone: '+91 98765 43210',
    email: 'arjun@example.com',
    address: '14 Lodhi Road, New Delhi 110003',
    nationality: 'Indian',
    state: 'Delhi',
  },
  stay: {
    roomName: 'Deluxe Garden View',
    bookingId: 'BK-2026-0612',
    checkInDate: '2026-06-05',
    checkOutDate: '2026-06-07',
    actualCheckInAt: '2026-06-05T14:00:00+05:30',
    actualCheckOutAt: '2026-06-07T11:00:00+05:30',
    numGuests: 2,
  },
  folio: {
    id: 'F-2026-0612-A',
    invoiceNumber: 'INV-2026-0142',
    invoiceDate: '2026-06-07',
    subtotal: 10450,
    discount: 500,
    gstAmount: 1194,
    grandTotal: 11144,
    paymentMethod: 'Card ending 4521',
    settledAt: '2026-06-07T15:42:00+05:30',
    status: 'settled',
  },
  entries: [
    { description: 'Deluxe Garden View — Night 1', entryType: 'ROOM_CHARGE',
      quantity: 1, unitPrice: 4000, amount: 4000, gstRate: 12, gstAmount: 480, hsnCode: '996311' },
    { description: 'Deluxe Garden View — Night 2', entryType: 'ROOM_CHARGE',
      quantity: 1, unitPrice: 4000, amount: 4000, gstRate: 12, gstAmount: 480, hsnCode: '996311' },
    { description: 'Dinner — room service', entryType: 'F&B',
      quantity: 1, unitPrice: 1250, amount: 1250, gstRate: 5, gstAmount: 62.5, hsnCode: '996331' },
    { description: 'Breakfast (incl. service)', entryType: 'F&B',
      quantity: 1, unitPrice: 1200, amount: 1200, gstRate: 5, gstAmount: 60, hsnCode: '996331' },
    { description: 'Spa massage — 45 min', entryType: 'SERVICE',
      quantity: 1, unitPrice: 600, amount: 600, gstRate: 18, gstAmount: 108, hsnCode: '999721' },
  ],
  placeOfSupply: 'Goa',
  bilingual: true,
  tenant: {
    country: 'IN',
    currency_code: 'INR',
    currency_symbol: '₹',
    locale: 'en-IN',
    invoice_template: templateMode,
  },
  roundToRupee: false,
});

async function main() {
  mkdirSync('qa_tmp', { recursive: true });
  const classicPdf = await generateInvoicePdf(fixture('CLASSIC'));
  const boutiquePdf = await generateInvoicePdf(fixture('BOUTIQUE'));
  writeFileSync('qa_tmp/invoice_classic.pdf', classicPdf);
  writeFileSync('qa_tmp/invoice_boutique.pdf', boutiquePdf);
  console.log(`Classic  → qa_tmp/invoice_classic.pdf  (${classicPdf.length} bytes)`);
  console.log(`Boutique → qa_tmp/invoice_boutique.pdf (${boutiquePdf.length} bytes)`);
  if (Math.abs(classicPdf.length - boutiquePdf.length) < 50) {
    console.warn('⚠ Suspicious — Classic and Boutique sizes nearly equal; check dispatcher.');
  }
  console.log('Both rendered without error.');
}

main().catch(err => { console.error('SMOKE FAIL:', err); process.exit(1); });
