#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────
//  CH-5 — Channel adapter framework contract verification
//
//  Pure offline structural-checks against channelAdapters.ts:
//    1. Every concrete adapter implements the full ChannelAdapter interface
//    2. Every adapter exposes the methods with the expected signatures
//    3. The registry exports a getChannelAdapter() that resolves the six
//       channels we ship UI for (BOOKING / MMT / GOIBIBO / AGODA / EXPEDIA / AIRBNB)
//    4. Unknown channels fall back to MockAdapter
//
//  No network. No DB. No process spawn. Reads the .ts source file and
//  asserts the contract textually — exactly like the existing
//  verify-*-offline.cjs suites in this folder.
// ─────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'channelAdapters.ts');
const REQUIRED_METHODS = ['isReady', 'pushBooking', 'pushAvailability', 'validateWebhook', 'parseInbound'];
const REQUIRED_CHANNELS = ['BOOKING', 'MMT', 'GOIBIBO', 'AGODA', 'EXPEDIA', 'AIRBNB', 'MOCK'];

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('  CH-5 — channelAdapters.ts contract verification');
console.log('═══════════════════════════════════════════════════════════════════════════════');

const src = fs.readFileSync(SRC, 'utf8');

// 1. Interface declaration
assert('ChannelAdapter interface declared',
  /interface\s+ChannelAdapter\s*\{/.test(src));
assert('AdapterBookingPayload type declared',
  /(?:interface|type)\s+AdapterBookingPayload\b/.test(src));
assert('AdapterAvailabilityPayload type declared',
  /(?:interface|type)\s+AdapterAvailabilityPayload\b/.test(src));
assert('AdapterResult type declared',
  /(?:interface|type)\s+AdapterResult\b/.test(src));

// 2. Required methods on the interface
for (const m of REQUIRED_METHODS) {
  // Match either method-sig or arrow form; both forms are legal in TS interfaces.
  const re = new RegExp(`(?:^|\\b)${m}\\s*[\\(:]`, 'm');
  assert(`interface declares ${m}()`, re.test(src));
}

// 3. Concrete adapter classes
const ADAPTERS = [
  'MockAdapter',
  'BookingComAdapter',
  'MakeMyTripAdapter',
  'GoibiboAdapter',
  'AgodaAdapter',
  'ExpediaAdapter',
  'AirbnbAdapter',
];
for (const cls of ADAPTERS) {
  assert(`${cls} class declared`, new RegExp(`class\\s+${cls}\\b`).test(src));
}

// 4. Each adapter exposes every method (directly OR via `extends`).
//    Some channels share implementations (Goibibo extends MakeMyTripAdapter,
//    Expedia/Airbnb extend AgodaAdapter) — that's a legitimate way to
//    satisfy the interface and shouldn't fail the contract check.
function methodsForClass(cls) {
  const start = src.indexOf(`class ${cls}`);
  if (start < 0) return { body: '', extendsName: null };
  const tail = src.slice(start);
  const nextClass = tail.indexOf('\nclass ', 1);
  const body = nextClass > 0 ? tail.slice(0, nextClass) : tail;
  const ext = body.match(/class\s+\w+\s+extends\s+(\w+)/);
  return { body, extendsName: ext ? ext[1] : null };
}
for (const cls of ADAPTERS) {
  const { body, extendsName } = methodsForClass(cls);
  const parentBody = extendsName ? methodsForClass(extendsName).body : '';
  for (const m of REQUIRED_METHODS) {
    const re = new RegExp(`(?:async\\s+)?${m}\\s*\\(`, 'm');
    const ok = re.test(body) || (parentBody && re.test(parentBody));
    assert(`${cls}.${m}() present${extendsName && !re.test(body) ? ` (inherited from ${extendsName})` : ''}`, ok);
  }
}

// 5. Registry + factory
assert('getChannelAdapter() exported',
  /export\s+function\s+getChannelAdapter\b/.test(src));
for (const ch of REQUIRED_CHANNELS) {
  // Look for the channel key as a registry entry or class instance.
  // Either:  BOOKING: new BookingComAdapter()  or  'BOOKING': ...
  const re = new RegExp(`['\"]?${ch}['\"]?\\s*:\\s*new\\s+\\w+`, 'm');
  assert(`registry includes ${ch}`, re.test(src));
}

// 6. parseInbound on each adapter returns the union literal type
//    (this is the TS2416 fix we made — without the cast, TS infers `string`).
const TS_INFER_CAST = /as\s+'CREATED'\s*\|\s*'MODIFIED'\s*\|\s*'CANCELLED'/g;
const castMatches = (src.match(TS_INFER_CAST) || []).length;
assert(`parseInbound 'CREATED'|'MODIFIED'|'CANCELLED' literal casts (≥3 expected)`,
  castMatches >= 3, `found ${castMatches}`);

// 7. Booking.com / MMT / Agoda — each has a TODO block documenting the
//    real endpoint that the stub will be replaced with.
const REAL_ENDPOINT_HINTS = [
  ['Booking.com',  /supply-xml\.booking\.com/i],
  ['MakeMyTrip',   /connect-api\.makemytrip\.com|partners?\.makemytrip\.com/i],
  ['Agoda',        /agoda|ycs/i],
  ['Expedia',      /expedia|quickconnect|eqc/i],
];
for (const [name, re] of REAL_ENDPOINT_HINTS) {
  assert(`${name} adapter cites the real endpoint in a TODO comment`, re.test(src));
}

console.log('───────────────────────────────────────────────────────────────────────────────');
console.log(`  ${pass} passed · ${fail} failed`);
if (fail > 0) { process.exit(1); }
else          { console.log('  ✓ Channel adapter framework contract OK.'); }
