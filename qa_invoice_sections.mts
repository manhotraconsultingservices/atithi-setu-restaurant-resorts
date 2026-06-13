// Visual smoke test for the classic hotel invoice section bands (Room /
// Restaurant / Services). Generates a real PDF so the section headers can be
// eyeballed. Run: npx tsx qa_invoice_sections.mts  →  qa_invoice_sample.pdf
import { generateInvoicePdf } from './invoiceService.ts';
import { writeFileSync } from 'fs';

const data: any = {
  hotel: {
    name: 'Viveks Cafe & Resort', address: '123 MG Road', city: 'Bengaluru',
    state: 'Karnataka', pincode: '560001', gstin: '29ABCDE1234F1Z5',
    phone: '+91 98765 43210', email: 'stay@viveks.example',
  },
  guest: { name: 'Pappu Singh', phone: '+91 90000 00000', state: 'Karnataka' },
  stay: {
    roomName: 'Room 303 · Superior Room with View', bookingId: 'BK-TEST-001',
    checkInDate: '2026-06-13', checkOutDate: '2026-06-15',
    actualCheckInAt: '2026-06-13T08:30:00Z', actualCheckOutAt: '2026-06-15T06:00:00Z',
    numGuests: 2,
  },
  folio: {
    id: 'F-TEST', invoiceNumber: 'INV-TEST-001', invoiceDate: '2026-06-15',
    subtotal: 3040, discount: 0, gstAmount: 390.8, grandTotal: 3430.8,
    paymentMethod: 'CASH', status: 'settled', amountPaid: 3430.8, balanceDue: 0,
  },
  entries: [
    { description: 'Room charge · 2026-06-13 · MAP1 · Room + Breakfast & Dinner (B+D)', entryType: 'ROOM_CHARGE', quantity: 1, unitPrice: 2400, amount: 2400, gstRate: 12 },
    { description: 'Basket of Bread (Served with Butter and Jam, 4 Pcs)', entryType: 'F_AND_B', quantity: 1, unitPrice: 70, amount: 70, gstRate: 18 },
    { description: 'Choice of Cereal with Hot and Cold Milk', entryType: 'F_AND_B', quantity: 1, unitPrice: 70, amount: 70, gstRate: 18 },
    { description: 'Airport Pickup (Sedan)', entryType: 'SERVICE', quantity: 1, unitPrice: 500, amount: 500, gstRate: 18 },
  ],
};

const buf = await generateInvoicePdf(data);
writeFileSync('qa_invoice_sample.pdf', buf);
console.log('PDF written:', buf.length, 'bytes → qa_invoice_sample.pdf');
