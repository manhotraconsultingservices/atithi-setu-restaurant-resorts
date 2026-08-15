/**
 * Folio cash TIMING fix — deterministic offline sim.
 *
 * Proves the change that posts INTERIM hotel receipts to the GL at receipt time
 * (Dr Cash / Cr 2100 Advances) and applies ADVANCE+INTERIM against AR at
 * settlement:
 *   - interim cash appears in the ledger the DAY IT IS RECEIVED (not at checkout)
 *   - it is NEVER double-counted (settlement does not Dr cash for it again)
 *   - the books stay balanced (ΣDr = ΣCr) and AR + Advances net to zero when paid
 *
 * Run: node test-scripts/e2e_folio_cash_timing_sim.mjs
 */
let passed = 0, failed = 0;
const ok = (n, c, d = '') => { if (c) { passed++; console.log(`  ✅ ${n}${d ? ' | ' + d : ''}`); } else { failed++; console.error(`  ❌ ${n}${d ? ' | ' + d : ''}`); } };
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

const gl = [];                              // {acct, dr, cr, day}
const post = (acct, dr, cr, day) => gl.push({ acct, dr: r2(dr), cr: r2(cr), day });
const bal = (a) => r2(gl.filter(e => e.acct === a).reduce((s, e) => s + e.dr - e.cr, 0));
const cashInOn = (a, day) => r2(gl.filter(e => e.acct === a && e.day === day).reduce((s, e) => s + e.dr, 0));
const _gl = (m) => (m === 'CASH' ? '1000' : '1010');   // _glAccountForPaymentMethod

// ── receipt-time postings (POST /folios/:id/payments) ────────────────────────
const recordPayment = (type, amount, method, day) => {
  if (type === 'ADVANCE') { post(_gl(method), amount, 0, day); post('2100', 0, amount, day); }       // ADV-<id>
  else if (type === 'INTERIM') { post(_gl(method), amount, 0, day); post('2100', 0, amount, day); }  // INTPAY-<id>  (the fix)
  // FINAL / REFUND post at settlement, not here
};
// ── settlement (settleFolioForBooking / _postFolioGl / group) ────────────────
const settle = (folio, payments, day) => {
  const subtotal = folio.subtotal, gst = folio.gst, discount = folio.discount || 0;
  const grand = r2(subtotal + gst - discount);
  // advances pool = ADVANCE + INTERIM (the fix); cash-leg = everything else (FINAL…)
  const advPool = payments.filter(p => p.type === 'ADVANCE' || p.type === 'INTERIM');
  const advTotal = r2(advPool.reduce((s, p) => s + p.amount, 0));
  const cashLeg = payments.filter(p => p.type !== 'ADVANCE' && p.type !== 'INTERIM');
  // bill
  post('1100', subtotal + gst - discount, 0, day);
  post('4000', 0, subtotal, day);
  if (discount > 0) post('4900', discount, 0, day);
  if (gst > 0) post('2200', 0, gst, day);
  // apply advances+interim against AR
  if (advTotal > 0) { const applied = r2(Math.min(advTotal, grand)); post('2100', applied, 0, day); post('1100', 0, applied, day); }
  // cash leg (FINAL at checkout)
  for (const p of cashLeg) { post(_gl(p.method), p.amount, 0, day); post('1100', 0, p.amount, day); }
};

console.log('\n── Folio cash timing — offline simulation ──\n');

// Bill ₹10,000 (9,000 + ₹1,000 GST). Advance ₹2,000 (day 1, cash), interim
// ₹3,000 (day 2, cash), final ₹5,000 (day 3 checkout, card).
const folio = { subtotal: 9000, gst: 1000, discount: 0 };
recordPayment('ADVANCE', 2000, 'CASH', 'D1');
recordPayment('INTERIM', 3000, 'CASH', 'D2');   // <-- the fix: posts on D2, not at checkout

ok('Interim cash appears on the day received (D2), before checkout', cashInOn('1000', 'D2') === 3000, `cashIn(D2)=${cashInOn('1000', 'D2')}`);
ok('Advance cash appeared on D1', cashInOn('1000', 'D1') === 2000);

const payments = [
  { type: 'ADVANCE', amount: 2000, method: 'CASH' },
  { type: 'INTERIM', amount: 3000, method: 'CASH' },
  { type: 'FINAL',   amount: 5000, method: 'CARD' },
];
settle(folio, payments, 'D3');

// No double count: cash on D3 (checkout) must NOT include the interim again.
ok('Interim NOT re-debited to cash at checkout (no double count)', cashInOn('1000', 'D3') === 0, `cashIn(D3)=${cashInOn('1000', 'D3')}`);
ok('Total cash 1000 = advance + interim only (₹5,000)', bal('1000') === 5000, `cash=${bal('1000')}`);
ok('Bank 1010 = final card ₹5,000', bal('1010') === 5000, `bank=${bal('1010')}`);
ok('Advances 2100 nets to zero after settlement', bal('2100') === 0, `2100=${bal('2100')}`);
ok('Accounts Receivable 1100 nets to zero (fully paid)', bal('1100') === 0, `AR=${bal('1100')}`);
ok('Revenue 4000 = ₹9,000', bal('4000') === -9000, `rev=${bal('4000')}`);
ok('GST 2200 = ₹1,000', bal('2200') === -1000, `gst=${bal('2200')}`);

// The load-bearing invariant: the whole ledger balances.
const totDr = r2(gl.reduce((s, e) => s + e.dr, 0));
const totCr = r2(gl.reduce((s, e) => s + e.cr, 0));
ok('Trial balance: total Dr = total Cr', totDr === totCr, `Dr=${totDr} Cr=${totCr}`);

// Case B: a single interim covering the whole bill still balances + nets AR/2100 to 0.
const gl2start = gl.length;
const f2 = { subtotal: 900, gst: 100, discount: 0 };
recordPayment('INTERIM', 1000, 'CASH', 'E1');
settle(f2, [{ type: 'INTERIM', amount: 1000, method: 'CASH' }], 'E1');
const dr2 = r2(gl.slice(gl2start).reduce((s, e) => s + e.dr, 0));
const cr2 = r2(gl.slice(gl2start).reduce((s, e) => s + e.cr, 0));
ok('Interim-only folio also balances (Dr=Cr)', dr2 === cr2, `Dr=${dr2} Cr=${cr2}`);

console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${failed === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${passed} passed, ${failed} failed`);
console.log('─'.repeat(52) + '\n');
process.exit(failed === 0 ? 0 : 1);
