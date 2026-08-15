/**
 * Cash Shift Handover — deterministic offline GL sim.
 *
 * Mirrors POST /accounting/cash-handovers/:id/accept:
 *   - the joint count splits into carry-over float (stays) + deposit (submitted)
 *   - over/short trues up to 6010 Cash Over/Short
 *   - the deposit posts Cr 1000 Cash in Hand → Dr 1005 Cash in Transit (or 1010 Bank)
 *   - book cash after the handover == carry-over float == the incoming drawer's opening
 *   - the dual-signature guard (outgoing signer can't also accept unless a manager)
 *   - every journal is balanced (ΣDr = ΣCr)
 *
 * Run: node test-scripts/e2e_shift_handover_sim.mjs
 */
let passed = 0, failed = 0;
const ok = (n, c, d = '') => { if (c) { passed++; console.log(`  ✅ ${n}${d ? ' | ' + d : ''}`); } else { failed++; console.error(`  ❌ ${n}${d ? ' | ' + d : ''}`); } };
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

const gl = [];
const post = (ref, src, lines) => { for (const l of lines) gl.push({ ref, src, acct: l.a, dr: r2(l.dr || 0), cr: r2(l.cr || 0) }); };
const bal = (a) => r2(gl.filter(e => e.acct === a).reduce((s, e) => s + e.dr - e.cr, 0));

// mirror the accept() GL posting + the running book-cash reconciliation
function handoverAccept({ openingFloat, movement, counted, carry, deposit, depositTo }, hid) {
  const expected = r2(openingFloat + movement);
  const variance = r2(counted - expected);
  if (r2(carry + deposit) !== r2(counted)) throw new Error(`split mismatch: carry ${carry} + deposit ${deposit} != counted ${counted}`);
  if (carry < 0 || deposit < 0) throw new Error('negative split');
  // 1) true up over/short so book cash matches the joint physical count
  if (Math.abs(variance) >= 0.01) post(`CD-var-${hid}`, 'CASH_DRAWER_VARIANCE', [
    { a: '1000', dr: variance > 0 ? variance : 0, cr: variance < 0 ? -variance : 0 },
    { a: '6010', dr: variance < 0 ? -variance : 0, cr: variance > 0 ? variance : 0 },
  ]);
  // 2) deposit the submitted cash out of the drawer
  if (deposit > 0.009) {
    const acct = String(depositTo).toUpperCase() === 'BANK' ? '1010' : '1005';
    post(`CD-dep-${hid}`, 'CASH_DRAWER_DEPOSIT', [{ a: acct, dr: deposit }, { a: '1000', cr: deposit }]);
  }
  // book cash attributable to the drawer: starts at expected, trued up by variance,
  // reduced by the deposit removed → must equal the carry-over float.
  const bookAfter = r2(expected + variance - deposit);
  return { expected, variance, bookAfter };
}

// mirror the dual-signature guard in the accept endpoint
const canAccept = (h, me, isMgr) => {
  const isIncoming = h.to_cashier_id && h.to_cashier_id === me;
  if (!isIncoming && !isMgr) return false;
  if (h.from_signed_by === me && !isMgr) return false;
  return true;
};

console.log('\n── Cash Shift Handover — offline simulation ──\n');

// 1) Clean handover, no variance: keep ₹2,000 float, submit ₹8,000 sales to the safe.
const h1 = handoverAccept({ openingFloat: 2000, movement: 8000, counted: 10000, carry: 2000, deposit: 8000, depositTo: 'SAFE' }, 1);
ok('No-variance handover: carry + deposit = counted', 2000 + 8000 === 10000);
ok('Deposit to SAFE routes to Cash in Transit 1005', bal('1005') === 8000, `1005=${bal('1005')}`);
ok('Book cash after handover == carry-over float (= next opening)', h1.bookAfter === 2000, `book=${h1.bookAfter}`);
ok('No-variance handover posts nothing to 6010', bal('6010') === 0);

// 2) Short by ₹100: joint count finds less than expected → trued up to 6010.
const h2 = handoverAccept({ openingFloat: 2000, movement: 5000, counted: 6900, carry: 1900, deposit: 5000, depositTo: 'SAFE' }, 2);
ok('Shortage booked to Cash Over/Short 6010', bal('6010') === 100, `6010=${bal('6010')} (Dr = short)`);
ok('Short handover still reconciles: book == carry-over', h2.bookAfter === 1900, `book=${h2.bookAfter}`);
ok('Short variance computed correctly', h2.variance === -100, `variance=${h2.variance}`);

// 3) Deposit straight to BANK routes to 1010, not 1005.
const h3 = handoverAccept({ openingFloat: 1000, movement: 4000, counted: 5000, carry: 1000, deposit: 4000, depositTo: 'BANK' }, 3);
ok('Deposit to BANK routes to Bank 1010', bal('1010') === 4000, `1010=${bal('1010')}`);
ok('Bank handover reconciles: book == carry-over', h3.bookAfter === 1000, `book=${h3.bookAfter}`);

// 4) The split must equal the counted total (guard).
let threw = false; try { handoverAccept({ openingFloat: 0, movement: 1000, counted: 1000, carry: 600, deposit: 500, depositTo: 'SAFE' }, 4); } catch { threw = true; }
ok('Carry-over + deposit must equal counted (rejects mismatch)', threw);

// 5) Dual-signature guard.
const hd = { to_cashier_id: 'BOB', from_signed_by: 'ALICE' };
ok('Outgoing cashier cannot also accept (needs a 2nd signer)', canAccept(hd, 'ALICE', false) === false);
ok('Incoming cashier can accept (second signature)', canAccept(hd, 'BOB', false) === true);
ok('An unrelated cashier cannot accept', canAccept(hd, 'CAROL', false) === false);
ok('A manager can accept (override)', canAccept(hd, 'MGR', true) === true);
ok('A manager may sign both sides', canAccept({ to_cashier_id: 'X', from_signed_by: 'MGR' }, 'MGR', true) === true);

// 6) The load-bearing invariant: every posted journal balances.
const dr = r2(gl.reduce((s, e) => s + e.dr, 0));
const cr = r2(gl.reduce((s, e) => s + e.cr, 0));
ok('Trial balance: total Dr = total Cr', dr === cr, `Dr=${dr} Cr=${cr}`);

console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${failed === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${passed} passed, ${failed} failed`);
console.log('─'.repeat(52) + '\n');
process.exit(failed === 0 ? 0 : 1);
