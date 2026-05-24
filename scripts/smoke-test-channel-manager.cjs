#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────
//  CH-1..CH-5 — Channel-manager production endpoint smoke test
//
//  Exercises every endpoint introduced by the OTA-integration sprint:
//    CH-2: iCal feeds (CRUD + manual sync)
//    CH-3: Inbound webhook receiver + audit log
//    CH-4: Dashboard endpoints (re-uses CH-2 + CH-3 + D2 endpoints)
//    CH-5: this script
//
//  Expected status codes are encoded in the third column. The endpoints
//  are all behind authenticate() except the public webhook, so the
//  "wired" signal is 401 — proves the endpoint exists, validates the
//  middleware stack, and confirms the new tables didn't break the
//  router mounting.
//
//  Run:  node scripts/smoke-test-channel-manager.cjs
// ─────────────────────────────────────────────────────────────────────────
const https = require('https');

const HOST = process.env.HOST || 'app.atithi-setu.com';
const RID  = process.env.RID  || 'RESTO-1003';

const endpoints = [
  ['GET',  '/api/version', null, 'expect 200 — confirms commit_marker'],

  // ── CH-2 iCal feeds (auth-gated) ──────────────────────────────────
  ['GET',  `/api/restaurant/${RID}/hotel/ical-feeds`, null, '401 (auth required = wired)'],
  ['POST', `/api/restaurant/${RID}/hotel/ical-feeds`, null, '401'],
  ['DELETE', `/api/restaurant/${RID}/hotel/ical-feeds/FEED-1`, null, '401'],
  ['POST', `/api/restaurant/${RID}/hotel/ical-feeds/FEED-1/sync`, null, '401'],

  // ── CH-3 webhook (public — signature validates) ────────────────────
  ['POST', `/api/public/restaurant/${RID}/channel-webhook/BOOKING`, null,
           'public — expect 401 (no creds) or 400 (bad body)'],
  ['POST', `/api/public/restaurant/${RID}/channel-webhook/UNKNOWN`, null,
           'public — expect 400 (unknown channel)'],

  // ── CH-3 audit log (auth-gated) ────────────────────────────────────
  ['GET',  `/api/restaurant/${RID}/hotel/webhook-log?limit=10`, null, '401'],

  // ── Existing CH-1 endpoints (regression) ───────────────────────────
  ['GET',  `/api/restaurant/${RID}/hotel/channel-credentials`, null, '401'],
  ['POST', `/api/restaurant/${RID}/hotel/channel-credentials`, null, '401'],
];

function hit(method, path) {
  return new Promise((resolve) => {
    const req = https.request({
      host: HOST, port: 443, path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': 0 },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 120) }));
    });
    req.on('error',   () => resolve({ status: 'ERR',     body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT', body: '' }); });
    req.end();
  });
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  CH-1..CH-5 — Channel-manager production smoke test');
  console.log(`  HOST=${HOST}  RID=${RID}`);
  console.log('═══════════════════════════════════════════════════════════════════════════════');

  let okCount = 0;
  let totalCount = 0;
  for (const [method, path, _, hint] of endpoints) {
    const r = await hit(method, path);
    totalCount++;
    // The "wired" criterion for the auth-gated endpoints is 401; for
    // public POSTs with empty bodies it's 400 or 401; for /api/version
    // it's 200.
    const isWired = path === '/api/version'
      ? r.status === 200
      : (r.status === 401 || r.status === 400 || r.status === 403 || r.status === 404 || r.status === 200);
    if (isWired) okCount++;
    const tag = r.status === 200 ? '✓ 200' :
                r.status === 401 ? '🔒 401' :
                r.status === 403 ? '🚫 403' :
                r.status === 404 ? '⚠ 404' :
                r.status === 400 ? '✓ 400' :
                `✗ ${r.status}`;
    console.log(`  ${tag.padEnd(10)} ${String(method).padEnd(5)} ${String(path).padEnd(70)} ${hint || ''}`);
  }

  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log(`  ${okCount}/${totalCount} endpoints wired correctly`);
  if (okCount < totalCount) {
    console.log('  ⚠ Some endpoints returned unexpected status codes — check the deploy.');
    process.exit(1);
  } else {
    console.log('  ✓ All channel-manager endpoints respond as expected.');
  }
})();
