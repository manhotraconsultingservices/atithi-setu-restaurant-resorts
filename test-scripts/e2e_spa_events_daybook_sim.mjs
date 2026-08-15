/**
 * Spa & Events → Accounting / Day Book integration — deterministic offline GL sim.
 *
 * Mirrors the server logic touched by the `spa-events-daybook-integration` change:
 *   - spa folio payment: a receipt that does NOT clear the bill is recorded INTERIM
 *     and posted to the GL at receipt (Dr Cash/Bank, Cr 2100) so it shows same-day
 *   - spa full-settlement _postFolioGl: AR/revenue + advances (ADVANCE|INTERIM) applied
 *     via 2100, remaining cash legs booked — so interim cash is never double-counted
 *   - spa interim void (pre-settlement) reverses INTPAY
 *   - event advance (Dr Cash/Cr 2100 at receipt) + event settlement _postFolioGl
 *   - the frontend SOURCE_MODULE rollup (raw source_type → business module)
 *   - the whole ledger stays balanced (ΣDr = ΣCr)
 *
 * Run: node test-scripts/e2e_spa_events_daybook_sim.mjs
 */
let passed = 0, failed = 0;
const ok = (n, c, d = '') => { if (c) { passed++; console.log(`  ✅ ${n}${d ? ' | ' + d : ''}`); } else { failed++; console.error(`  ❌ ${n}${d ? ' | ' + d : ''}`); } };
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

const gl = [];
const post = (ref, src, lines) => { for (const l of lines) gl.push({ ref, src, acct: l.a, dr: r2(l.dr || 0), cr: r2(l.cr || 0) }); };
const bal = (a) => r2(gl.filter(e => e.acct === a).reduce((s, e) => s + e.dr - e.cr, 0));
const glAcct = (m) => (String(m).toUpperCase() === 'CASH' ? '1000' : '1010');
const has = (ref) => gl.some(e => e.ref === ref);

// mirror _reverseJournal: dated contra (Dr↔Cr swap), idempotent on reversalRef
const reverse = (origRef, revRef, src) => {
  if (has(revRef)) return;
  const orig = gl.filter(e => e.ref === origRef);
  post(revRef, src, orig.map(o => ({ a: o.acct, dr: o.cr, cr: o.dr })));
};

// mirror the spa folio payment endpoint's interim classification + INTPAY posting.
// Payment ids are globally unique on the server (FP-<ts>-<rand>); use a global
// sequence here so journal refs never collide across folios.
let PSEQ = 0;
const recordSpaPayment = (folio, { amount, method = 'CASH', reqType = 'FINAL' }) => {
  const settlesNow = reqType !== 'REFUND' && amount >= folio.outstanding - 0.01;
  const recordType = reqType === 'REFUND' ? 'REFUND' : (settlesNow ? 'FINAL' : 'INTERIM');
  const pid = `P${++PSEQ}`;
  folio.payments.push({ id: pid, amount: r2(amount), method, type: recordType, voided: false });
  folio.outstanding = r2(folio.outstanding - amount);
  if (recordType === 'INTERIM') {
    post(`INTPAY-${pid}`, 'SPA_INTERIM', [
      { a: glAcct(method), dr: amount }, { a: '2100', cr: amount },
    ]);
  }
  return pid;
};
const voidSpaPayment = (folio, pid) => {
  const p = folio.payments.find(x => x.id === pid); if (!p) return;
  p.voided = true; folio.outstanding = r2(folio.outstanding + p.amount);
  if (has(`INTPAY-${pid}`) && !has(`FOLIO-${folio.id}`)) reverse(`INTPAY-${pid}`, `INTPAY-VOID-${pid}`, 'SPA_INTERIM_REVERSAL');
};

// mirror _postFolioGl (settlement): AR/revenue + advances via 2100 + cash legs
const postFolioGl = (folio, revenueCode, sourceType) => {
  const ref = `FOLIO-${folio.id}`; if (has(ref)) return;
  const subtotal = r2(folio.subtotal), gstAmt = r2(folio.gst), discount = r2(folio.discount);
  const grand = r2(subtotal + gstAmt - discount);
  const cgst = r2(gstAmt / 2), sgst = r2(gstAmt - cgst);
  const pay = folio.payments.filter(p => !p.voided);
  const advances = pay.filter(p => p.type === 'ADVANCE' || p.type === 'INTERIM');
  const advTotal = r2(advances.reduce((s, p) => s + p.amount, 0));
  const nonAdv = pay.filter(p => p.type !== 'ADVANCE' && p.type !== 'INTERIM');
  const lines = [];
  if (subtotal + gstAmt > 0) {
    lines.push({ a: '1100', dr: r2(subtotal + gstAmt - discount) });
    lines.push({ a: revenueCode, cr: subtotal });
    if (discount > 0) lines.push({ a: '4900', dr: discount });
    if (cgst > 0) lines.push({ a: '2200', cr: cgst });
    if (sgst > 0) lines.push({ a: '2210', cr: sgst });
  }
  if (advTotal > 0) {
    const applied = r2(Math.min(advTotal, grand > 0 ? grand : advTotal));
    lines.push({ a: '2100', dr: applied }); lines.push({ a: '1100', cr: applied });
  }
  for (const p of nonAdv) { if (p.amount <= 0) continue; lines.push({ a: glAcct(p.method), dr: p.amount }); lines.push({ a: '1100', cr: p.amount }); }
  post(ref, sourceType, lines);
};

console.log('\n── Spa & Events → Day Book — offline simulation ──\n');

// 1) Spa, same-day full pay (₹3,000 cash, no GST): one FINAL, no INTPAY, cash same-day.
const s1 = { id: 'S1', subtotal: 3000, gst: 0, discount: 0, outstanding: 3000, payments: [] };
const s1p = recordSpaPayment(s1, { amount: 3000, method: 'CASH', reqType: 'FINAL' });
ok('Spa same-day pay does NOT create an interim journal', !has(`INTPAY-${s1p}`));
postFolioGl(s1, '4040', 'SPA_SETTLEMENT');
ok('Spa full pay → Cash 3000 same-day', bal('1000') === 3000, `1000=${bal('1000')}`);
ok('Spa full pay → Spa Revenue 3000', bal('4040') === -3000, `4040=${bal('4040')}`);

// 2) Spa multi-day deposit: ₹1,000 cash on day-1 (open) + ₹2,000 on day-5 (settles).
const cashBefore = bal('1000');
const s2 = { id: 'S2', subtotal: 3000, gst: 0, discount: 0, outstanding: 3000, payments: [] };
const s2d = recordSpaPayment(s2, { amount: 1000, method: 'CASH', reqType: 'FINAL' }); // partial → reclassified INTERIM
ok('Spa deposit recorded as INTERIM (not FINAL)', s2.payments[0].type === 'INTERIM');
ok('Spa deposit posts INTPAY at receipt (day-1 cash visible)', has(`INTPAY-${s2d}`));
ok('Day-1 cash rose by the deposit immediately', bal('1000') === r2(cashBefore + 1000), `1000=${bal('1000')}`);
recordSpaPayment(s2, { amount: 2000, method: 'CASH', reqType: 'FINAL' }); // settles
ok('Final receipt stays FINAL', s2.payments[1].type === 'FINAL');
postFolioGl(s2, '4040', 'SPA_SETTLEMENT');
ok('Spa deposit not double-counted: total cash = 3000 + 3000', bal('1000') === r2(cashBefore + 3000), `1000=${bal('1000')}`);
ok('Spa 2100 nets to zero after settlement', bal('2100') === 0, `2100=${bal('2100')}`);
ok('Spa AR (1100) nets to zero', bal('1100') === 0, `1100=${bal('1100')}`);

// 3) Spa interim void before settlement removes the day-1 cash.
const s3 = { id: 'S3', subtotal: 5000, gst: 0, discount: 0, outstanding: 5000, payments: [] };
const cash3 = bal('1000');
const p3 = recordSpaPayment(s3, { amount: 1500, method: 'CASH', reqType: 'FINAL' });
ok('Spa interim posted before void', bal('1000') === r2(cash3 + 1500));
voidSpaPayment(s3, p3);
ok('Voiding a pre-settlement spa interim reverses the cash', bal('1000') === cash3, `1000=${bal('1000')}`);
ok('Voided spa interim leaves 2100 flat', bal('2100') === 0, `2100=${bal('2100')}`);

// 4) Events: advance ₹5,000 at receipt (Dr Cash/Cr 2100) + settlement (revenue 4050).
const cash4 = bal('1000');
post('EVENT-PAY-E1', 'EVENT_ADVANCE', [{ a: '1000', dr: 5000 }, { a: '2100', cr: 5000 }]);
ok('Event advance shows cash same-day', bal('1000') === r2(cash4 + 5000));
const ev = { id: 'E1', subtotal: 20000, gst: 0, discount: 0, outstanding: 20000, payments: [{ id: 'EA', amount: 5000, method: 'CASH', type: 'ADVANCE', voided: false }] };
postFolioGl(ev, '4050', 'EVENT_SETTLEMENT');
ok('Event revenue recognised 20000', bal('4050') === -20000, `4050=${bal('4050')}`);
ok('Event advance cleared: 2100 back to zero', bal('2100') === 0, `2100=${bal('2100')}`);

// 5) Module rollup (mirror the frontend SOURCE_MODULE map).
const SOURCE_MODULE = {
  FNB_ORDER: 'Restaurant',
  FOLIO_SETTLEMENT: 'Hotel', FOLIO_ADVANCE: 'Hotel', FOLIO_PAYMENT: 'Hotel', BOOKING_CANCEL: 'Hotel',
  SPA_SETTLEMENT: 'Spa', SPA_SALE: 'Spa', SPA_INTERIM: 'Spa', SPA_INTERIM_REVERSAL: 'Spa',
  EVENT_SETTLEMENT: 'Events', EVENT_ADVANCE: 'Events', EVENT_CANCEL_REVERSAL: 'Events', EVENT_ADVANCE_REVERSAL: 'Events',
  EXPENSE_PAYMENT: 'Overheads',
};
const srcModule = (s) => SOURCE_MODULE[s] || 'Other';
const rollupByModule = (rows) => {
  const acc = {};
  for (const r of rows) { const m = srcModule(r.source_type); if (!acc[m]) acc[m] = { in: 0, out: 0 }; acc[m].in += r.in || 0; acc[m].out += r.out || 0; }
  return acc;
};
const roll = rollupByModule([
  { source_type: 'FNB_ORDER', in: 1000, out: 0 },
  { source_type: 'SPA_SETTLEMENT', in: 2000, out: 0 },
  { source_type: 'SPA_INTERIM', in: 500, out: 0 },
  { source_type: 'EVENT_ADVANCE', in: 5000, out: 0 },
  { source_type: 'EVENT_SETTLEMENT', in: 0, out: 0 },
  { source_type: 'FOLIO_SETTLEMENT', in: 3000, out: 0 },
  { source_type: 'EXPENSE_PAYMENT', in: 0, out: 800 },
]);
ok('Rollup: Spa groups both spa sources (2000 + 500)', r2(roll.Spa.in) === 2500, `Spa.in=${roll.Spa && roll.Spa.in}`);
ok('Rollup: Events groups advance + settlement', r2(roll.Events.in) === 5000, `Events.in=${roll.Events && roll.Events.in}`);
ok('Rollup: Restaurant / Hotel / Overheads attributed', r2(roll.Restaurant.in) === 1000 && r2(roll.Hotel.in) === 3000 && r2(roll.Overheads.out) === 800);

// 6) The load-bearing invariant: the whole ledger balances.
const dr = r2(gl.reduce((s, e) => s + e.dr, 0));
const cr = r2(gl.reduce((s, e) => s + e.cr, 0));
ok('Trial balance: total Dr = total Cr', dr === cr, `Dr=${dr} Cr=${cr}`);

console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${failed === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${passed} passed, ${failed} failed`);
console.log('─'.repeat(52) + '\n');
process.exit(failed === 0 ? 0 : 1);
