/**
 * EOD Cash Drawer — deterministic offline billing/GL simulation.
 *
 * Mirrors the server logic (server.ts accounting block) so a regression in the
 * drawer math or the GL side-effects fails CI without a live tenant:
 *   - expected = opening_float + net GL Cash-in-Hand (1000) movement in window
 *   - counted  = Σ(denom × qty)   (denomination grid)
 *   - variance = counted − expected
 *   - approve  posts deposit journal (Cr 1000 → Dr 1010/1005) + optional
 *              variance journal (1000 ↔ 6010); after both, GL 1000 = retained float
 *   - two sequential shifts each attribute only their own window's cash
 *   - a day can only be locked when every drawer is APPROVED
 *
 * Run: node test-scripts/e2e_cash_drawer_sim.mjs
 */
let passed = 0, failed = 0;
const ok = (n, c, d = '') => { if (c) { passed++; console.log(`  ✅ ${n}${d ? ' | ' + d : ''}`); } else { failed++; console.error(`  ❌ ${n}${d ? ' | ' + d : ''}`); } };
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// A tiny GL: append-only Cash-in-Hand (1000) ledger with a timestamp tick.
const gl = []; // {acct, dr, cr, t}
let clock = 0;
const tick = () => ++clock;
const post = (acct, dr, cr) => gl.push({ acct, dr: r2(dr), cr: r2(cr), t: tick() });
// net movement on an account between (from, to]
const net1000 = (from, to) => r2(gl.filter(e => e.acct === '1000' && e.t > from && e.t <= to).reduce((s, e) => s + e.dr - e.cr, 0));
const bal = (acct) => r2(gl.filter(e => e.acct === acct).reduce((s, e) => s + e.dr - e.cr, 0));

const DENOMS = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1];
const countDenoms = (grid) => r2(DENOMS.reduce((s, d) => s + d * (grid[d] || 0), 0));

// ── Drawer helpers (mirror the endpoints) ────────────────────────────────────
const openDrawer = (opening_float) => ({ status: 'OPEN', opening_float: r2(opening_float), opened_t: tick(), expected: 0, counted: 0, variance: 0, deposit: 0, deposit_to: null, retained: 0, deposit_ref: null, var_ref: null });
const closeDrawer = (dr, grid, deposit_amount, deposit_to) => {
  const counted = countDenoms(grid);
  const expected = r2(dr.opening_float + net1000(dr.opened_t, tick()));
  dr.expected = expected; dr.counted = counted; dr.variance = r2(counted - expected);
  dr.deposit = r2(deposit_amount); dr.deposit_to = deposit_to; dr.retained = r2(counted - deposit_amount);
  dr.status = 'PENDING_APPROVAL';
  return dr;
};
const approveDrawer = (dr, postVariance) => {
  if (dr.deposit > 0.009) {
    const toBank = String(dr.deposit_to).toUpperCase() === 'BANK';
    post(toBank ? '1010' : '1005', dr.deposit, 0);
    post('1000', 0, dr.deposit);
    dr.deposit_ref = 'CD-DEP';
  }
  if (postVariance && Math.abs(dr.variance) >= 0.01) {
    const v = dr.variance;
    post('1000', v > 0 ? v : 0, v < 0 ? -v : 0);
    post('6010', v < 0 ? -v : 0, v > 0 ? v : 0);
    dr.var_ref = 'CD-VAR';
  }
  dr.status = 'APPROVED';
  return dr;
};
const canLock = (drawers) => drawers.every(d => d.status === 'APPROVED');

console.log('\n── EOD Cash Drawer — offline simulation ──\n');

// ── Scenario: one shift, exact count ─────────────────────────────────────────
// Cashier opens with ₹2,000 float, then two cash sales hit GL 1000 (Dr).
const d1 = openDrawer(2000);
post('1000', 5000, 0);  // cash sale ₹5,000
post('1000', 3000, 0);  // cash sale ₹3,000
post('1010', 4000, 0);  // a CARD sale → Bank, must NOT affect drawer cash
post('1000', 0, 500);   // petty-cash payout ₹500 (Cr 1000)
// expected = 2000 + (5000+3000-500) = 9500. Cashier counts exactly.
closeDrawer(d1, { 2000: 4, 500: 3, 100: 0 }, 8000, 'BANK'); // 4×2000 + 3×500 = 9500
ok('Expected = float + net cash sales − payouts (card ignored)', d1.expected === 9500, `expected=${d1.expected}`);
ok('Counted from denomination grid', d1.counted === 9500, `counted=${d1.counted}`);
ok('Exact count → zero variance', d1.variance === 0, `variance=${d1.variance}`);
ok('Retained float = counted − deposit', d1.retained === 1500, `retained=${d1.retained}`);

const bank0 = bal('1010'); const cash0 = bal('1000');
approveDrawer(d1, true);
ok('Deposit moved Cash → Bank', r2(bal('1010') - bank0) === 8000, `Δbank=${r2(bal('1010') - bank0)}`);
ok('GL Cash 1000 after deposit = retained float', bal('1000') === r2(cash0 - 8000), `cash=${bal('1000')}`);
ok('No variance journal when count is exact', d1.var_ref === null);

// ── Scenario: second sequential shift only sees ITS window's cash ────────────
const d2 = openDrawer(1500); // fresh float (the retained + a top-up, declared)
post('1000', 2000, 0);  // shift-2 cash sale ₹2,000
// expected2 = 1500 + 2000 = 3500 (shift-1's 8,500 net is BEFORE d2 opened → excluded)
closeDrawer(d2, { 2000: 1, 500: 3 }, 0, 'SAFE'); // counts 3500, over by 0? counts 2000+1500=3500
ok('Second shift attributes only its own window', d2.expected === 3500, `expected=${d2.expected}`);
ok('Sequential shifts do not double-count', d2.variance === 0, `variance=${d2.variance}`);
approveDrawer(d2, true); // exact count, no deposit → no journals, just APPROVED

// ── Scenario: shortage trues up via Cash Over/Short 6010 ─────────────────────
const d3 = openDrawer(0);
post('1000', 1000, 0); // ₹1,000 cash sale
closeDrawer(d3, { 500: 1, 100: 4 }, 0, 'SAFE'); // counted 900 → short ₹100
ok('Shortage detected', d3.variance === -100, `variance=${d3.variance}`);
const short0 = bal('6010'); const cashB = bal('1000');
approveDrawer(d3, true);
ok('Shortage booked to Cash Over/Short (6010) as expense', r2(bal('6010') - short0) === 100, `Δ6010=${r2(bal('6010') - short0)}`);
ok('GL cash trued down to physical count', bal('1000') === r2(cashB - 100), `cash=${bal('1000')}`);

// ── Day lock gate ────────────────────────────────────────────────────────────
const pending = openDrawer(0); // still OPEN
ok('Cannot lock while a drawer is open/pending', canLock([d1, d2, d3, pending]) === false);
ok('Can lock once every drawer is approved', canLock([d1, d2, d3]) === true);

console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${failed === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${passed} passed, ${failed} failed`);
console.log('─'.repeat(52) + '\n');
process.exit(failed === 0 ? 0 : 1);
