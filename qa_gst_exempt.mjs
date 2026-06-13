// ════════════════════════════════════════════════════════════════════════
//  qa_gst_exempt.mjs — GST-at-checkout (waive / re-apply) wiring audit
//
//  Mirrors the server.ts logic so the money is provably correct without a DB:
//    • recomputeFolioTotals: gst = gst_exempt ? 0 : SUM(entries.gst_amount);
//      grand = max(0, subtotal + gst − discount).
//    • getFolioOutstanding: outstanding = max(0, grand − net_paid).
//    • invoice PDF: when gst_exempt, every line item renders with gst 0 so the
//      line items match the (zeroed) summary.
//    • toggling is reversible — re-applying restores the original GST exactly
//      because the per-entry gst_amount rows are never mutated in the DB.
// ════════════════════════════════════════════════════════════════════════
const C = { g: '\x1b[32m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' };
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) pass++; else { fail++; console.log(`  ${C.r}✗${C.x} ${label}`); } };
const r2 = (n) => Math.round(n * 100) / 100;

// ── Mirror of recomputeFolioTotals ──
function recompute(entries, { discount = 0, gst_exempt = 0 } = {}) {
  const subtotal = r2(entries.reduce((s, e) => s + Number(e.amount || 0), 0));
  const gstSum   = r2(entries.reduce((s, e) => s + Number(e.gst_amount || 0), 0));
  const gst      = Number(gst_exempt) === 1 ? 0 : gstSum;
  const grand    = Math.max(0, r2(subtotal + gst - Number(discount || 0)));
  return { subtotal, gst, grand };
}
// ── Mirror of getFolioOutstanding ──
const outstanding = (grand, paid) => Math.max(0, r2(grand - paid));
// ── Mirror of the invoice per-entry GST zeroing when exempt ──
const invoiceEntries = (entries, gst_exempt) =>
  Number(gst_exempt) === 1 ? entries.map(e => ({ ...e, gst_amount: 0, gst_rate: 0 })) : entries.map(e => ({ ...e }));

console.log(`${C.b}\n═══ GST waive / re-apply at checkout ═══${C.x}`);

// A folio: 2 room nights @ 5000 (12% = 600 each) + 1 F&B @ 1000 (5% = 50).
const entries = [
  { entry_type: 'ROOM_CHARGE', amount: 5000, gst_amount: 600, gst_rate: 12 },
  { entry_type: 'ROOM_CHARGE', amount: 5000, gst_amount: 600, gst_rate: 12 },
  { entry_type: 'F_AND_B',     amount: 1000, gst_amount: 50,  gst_rate: 5  },
];

// 1) Normal (GST applied): grand = 11000 + 1250.
const normal = recompute(entries, { gst_exempt: 0 });
ok(normal.subtotal === 11000, 'subtotal sums the line amounts (11000)');
ok(normal.gst === 1250, 'GST applied = sum of entry GST (1250)');
ok(normal.grand === 12250, 'grand = subtotal + GST (12250)');

// 2) GST waived: gst → 0, grand = subtotal.
const waived = recompute(entries, { gst_exempt: 1 });
ok(waived.gst === 0, 'GST waived → folio GST is 0');
ok(waived.grand === 11000, 'grand drops to the pre-tax subtotal (11000)');

// 3) Outstanding follows the waiver (no advance paid).
ok(outstanding(normal.grand, 0) === 12250, 'outstanding with GST = 12250');
ok(outstanding(waived.grand, 0) === 11000, 'outstanding after waiver = 11000 (guest pays no GST)');

// 4) With a 2000 advance already paid, the waiver reduces what is due now.
ok(outstanding(normal.grand, 2000) === 10250, 'GST + 2000 advance → 10250 due');
ok(outstanding(waived.grand, 2000) === 9000,  'waived + 2000 advance → 9000 due');

// 5) Waiver + discount stack: grand = max(0, subtotal − discount), GST still 0.
const waivedDisc = recompute(entries, { gst_exempt: 1, discount: 1000 });
ok(waivedDisc.grand === 10000, 'waived + 1000 discount → 10000');

// 6) Invoice line items render with zero GST when waived (match the summary).
const invWaived = invoiceEntries(entries, 1);
ok(invWaived.every(e => e.gst_amount === 0 && e.gst_rate === 0), 'invoice line items show 0 GST when waived');
ok(invWaived.reduce((s, e) => s + e.amount, 0) === 11000, 'invoice line amounts unchanged (only tax zeroed)');

// 7) Re-applying GST restores the ORIGINAL totals exactly (entries never mutated).
const reapplied = recompute(entries, { gst_exempt: 0 });
ok(reapplied.gst === 1250 && reapplied.grand === 12250, 're-applying GST restores 1250 / 12250 exactly');
const invReapplied = invoiceEntries(entries, 0);
ok(invReapplied[0].gst_amount === 600 && invReapplied[2].gst_amount === 50, 'invoice line GST restored after re-apply');

console.log(`${C.b}\n═══════════════════════════════════════════════════════════════${C.x}`);
console.log(`  ${C.g}✓ Passed:${C.x} ${pass}`);
console.log(`  ${fail ? C.r : C.g}✗ Failed:${C.x} ${fail}`);
console.log(`${C.b}═══════════════════════════════════════════════════════════════${C.x}`);
process.exit(fail > 0 ? 1 : 0);
