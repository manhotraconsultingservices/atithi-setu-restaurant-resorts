/**
 * Expenses & Payments + Loans/EMI — deterministic offline GL sim.
 *
 * Mirrors POST /accounting/expense-payments and /accounting/loans:
 *   - each category posts a BALANCED journal (Dr expense/advance/loan, Cr Cash/Bank)
 *   - Cash vs Bank chosen by payment method
 *   - EMI splits principal (Dr Loan Payable 2700) + interest (Dr 5460), and the
 *     loan outstanding decrements by principal, closing at zero
 *   - the whole ledger stays balanced (ΣDr = ΣCr)
 *
 * Run: node test-scripts/e2e_expense_payment_sim.mjs
 */
let passed = 0, failed = 0;
const ok = (n, c, d = '') => { if (c) { passed++; console.log(`  ✅ ${n}${d ? ' | ' + d : ''}`); } else { failed++; console.error(`  ❌ ${n}${d ? ' | ' + d : ''}`); } };
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

const gl = [];
const post = (lines) => { for (const l of lines) gl.push({ acct: l.a, dr: r2(l.dr || 0), cr: r2(l.cr || 0) }); };
const bal = (a) => r2(gl.filter(e => e.acct === a).reduce((s, e) => s + e.dr - e.cr, 0));
const glAcct = (m) => (String(m).toUpperCase() === 'CASH' ? '1000' : '1010');

// mirror of _glAccountForExpenseCategory (relevant subset + the new RENT/INTEREST)
const expAcct = (c) => {
  c = String(c).toUpperCase();
  if (/RENT|LEASE/.test(c)) return '5250';
  if (/ELECTRIC|POWER/.test(c)) return '5400';
  if (/WATER|UTILITY/.test(c)) return '5410';
  if (/SALARY|WAGE|STAFF/.test(c)) return '5100';
  if (/INTEREST/.test(c)) return '5460';
  return '5800';
};

const loans = {};
const createLoan = (id, principal, funding) => {
  if (funding === 'OPENING') post([{ a: '3200', dr: principal }, { a: '2700', cr: principal }]);
  else post([{ a: glAcct(funding), dr: principal }, { a: '2700', cr: principal }]);
  loans[id] = { outstanding: r2(principal), status: 'ACTIVE' };
};
// the endpoint's expense-payment logic
const pay = ({ category, method = 'CASH', amount = 0, loan_id, principal = 0, interest = 0 }) => {
  const cat = String(category).toUpperCase();
  const debit = [];
  let total = r2(amount);
  if (cat === 'EMI') {
    total = r2(principal + interest);
    if (principal > 0) debit.push({ a: '2700', dr: principal });
    if (interest > 0) debit.push({ a: '5460', dr: interest });
  } else if (cat === 'STAFF_ADVANCE') {
    debit.push({ a: '1210', dr: total });
  } else {
    debit.push({ a: expAcct(cat), dr: total });
  }
  post([...debit, { a: glAcct(method), cr: total }]);
  if (cat === 'EMI' && loan_id && principal > 0) {
    loans[loan_id].outstanding = r2(Math.max(0, loans[loan_id].outstanding - principal));
    if (loans[loan_id].outstanding <= 0.01) loans[loan_id].status = 'CLOSED';
  }
  return total;
};

console.log('\n── Expenses & Payments + Loans/EMI — offline simulation ──\n');

// Rent by cash → Dr Rent 5250, Cr Cash 1000
pay({ category: 'RENT', method: 'CASH', amount: 25000 });
ok('Rent (cash) → Rent expense debited', bal('5250') === 25000, `5250=${bal('5250')}`);
ok('Rent (cash) → Cash credited', bal('1000') === -25000, `1000=${bal('1000')}`);

// Electricity by bank → Dr 5400, Cr Bank 1010 (NOT cash)
pay({ category: 'ELECTRICITY', method: 'BANK', amount: 8000 });
ok('Electricity (bank) hits Bank not Cash', bal('1010') === -8000 && bal('1000') === -25000, `bank=${bal('1010')} cash=${bal('1000')}`);
ok('Electricity expense booked', bal('5400') === 8000);

// Staff advance by cash → Dr 1210 (asset), Cr Cash
pay({ category: 'STAFF_ADVANCE', method: 'CASH', amount: 5000 });
ok('Staff advance → recoverable asset 1210 (not an expense)', bal('1210') === 5000, `1210=${bal('1210')}`);

// A loan (opening balance ₹1,20,000) then two EMIs (principal 10k + interest 1k)
createLoan('L1', 120000, 'OPENING');
ok('Loan opening balance → Loan Payable 2700 credit', bal('2700') === -120000, `2700=${bal('2700')}`);
ok('Loan outstanding initialised', loans.L1.outstanding === 120000);

pay({ category: 'EMI', method: 'BANK', loan_id: 'L1', principal: 10000, interest: 1000 });
ok('EMI splits principal + interest', bal('5460') === 1000 && bal('2700') === -110000, `interest=${bal('5460')} loan=${bal('2700')}`);
ok('Loan outstanding reduced by principal only', loans.L1.outstanding === 110000, `outstanding=${loans.L1.outstanding}`);

pay({ category: 'EMI', method: 'BANK', loan_id: 'L1', principal: 10000, interest: 900 });
ok('Second EMI reduces loan further', loans.L1.outstanding === 100000, `outstanding=${loans.L1.outstanding}`);

// Small loan fully repaid closes it
createLoan('L2', 5000, 'OPENING');
pay({ category: 'EMI', method: 'CASH', loan_id: 'L2', principal: 5000, interest: 250 });
ok('Loan closes when outstanding hits zero', loans.L2.outstanding === 0 && loans.L2.status === 'CLOSED');

// The load-bearing invariant: everything balances.
const dr = r2(gl.reduce((s, e) => s + e.dr, 0));
const cr = r2(gl.reduce((s, e) => s + e.cr, 0));
ok('Trial balance: total Dr = total Cr', dr === cr, `Dr=${dr} Cr=${cr}`);

console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${failed === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${passed} passed, ${failed} failed`);
console.log('─'.repeat(52) + '\n');
process.exit(failed === 0 ? 0 : 1);
