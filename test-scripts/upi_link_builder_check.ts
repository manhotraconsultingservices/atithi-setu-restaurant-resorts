// Unit test for the shared NPCI UPI deep-link builder (upiLink.ts).
// Run:  npx tsx test-scripts/upi_link_builder_check.ts
//
// Guards the correctness rules that make a 0%-commission UPI link actually open
// in every app — above all: the payee VPA `pa` must stay RAW (never %40).

import { buildUpiUri, isValidVpa } from '../upiLink.ts';

let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('UPI link builder — invariants');

// 1. The '@' in the VPA must NOT be percent-encoded (the core bug being fixed).
const link = buildUpiUri({ pa: 'hotel@okhdfcbank', pn: 'Grand Hotel', am: 2160, tn: 'Booking BK-AIO-1', tr: 'BK-AIO-1-F6IK' });
check('pa keeps the raw @ (no %40)', link.includes('pa=hotel@okhdfcbank') && !link.includes('%40'), link);
check('scheme is upi://pay', link.startsWith('upi://pay?'), link);

// 2. Amount is fixed to 2 decimals.
check('am formatted to 2 decimals', link.includes('am=2160.00'), link);

// 3. Currency defaults to INR.
check('cu defaults to INR', link.includes('cu=INR'), link);

// 4. Payee name is URL-encoded (space → %20).
check('pn is URL-encoded', link.includes('pn=Grand%20Hotel'), link);

// 5. tr is sanitised to alphanumeric (hyphens stripped), capped at 35.
check('tr stripped to alphanumeric', link.includes('tr=BKAIO1F6IK'), link);

// 6. A basic QR (no amount) omits am so the payer types it in.
const basic = buildUpiUri({ pa: 'hotel@okhdfcbank', pn: 'Grand Hotel' });
check('am omitted when <= 0', !basic.includes('am='), basic);

// 7. Invalid / missing VPAs return '' (never a dead link).
check('empty VPA → ""', buildUpiUri({ pa: '' }) === '');
check('no-@ VPA → ""', buildUpiUri({ pa: 'notavpa' }) === '');
check('double-@ VPA → ""', buildUpiUri({ pa: 'a@b@c' }) === '');
check('spaces in VPA → ""', buildUpiUri({ pa: 'bad vpa@bank' }) === '');

// 8. isValidVpa helper.
check('isValidVpa accepts a good VPA', isValidVpa('vivekscafe@okhdfcbank'));
check('isValidVpa accepts a numeric handle', isValidVpa('9876543210@ybl'));
check('isValidVpa rejects junk', !isValidVpa('nope'));

// 9. tn is capped at 50 chars (encoded).
const longTn = buildUpiUri({ pa: 'aa@bank', pn: 'X', tn: 'x'.repeat(200) });
const tnPart = (longTn.split('tn=')[1] || '');
check('tn capped at 50 chars', tnPart.length > 0 && tnPart.length <= 50, `len=${tnPart.length}`);

if (failed > 0) { console.error(`\nUPI builder: ${failed} check(s) FAILED`); process.exit(1); }
console.log('\nUPI builder: all checks passed');
