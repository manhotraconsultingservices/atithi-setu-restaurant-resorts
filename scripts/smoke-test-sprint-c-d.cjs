#!/usr/bin/env node
'use strict';
const https = require('https');

const HOST = 'app.atithi-setu.com';
const RID  = 'RESTO-1003';

const endpoints = [
  ['GET',  '/api/version', null],
  ['GET',  `/api/restaurant/${RID}/hotel/booking-groups`, '401 (auth required = wired)'],
  ['POST', `/api/restaurant/${RID}/hotel/booking-groups/G1/cancel`, '401'],
  ['GET',  `/api/restaurant/${RID}/hotel/booking-groups/G1/invoice-pdf`, '401'],
  ['GET',  `/api/restaurant/${RID}/hotel/ical/property.ics`, 'public — expect 200 or 403'],
  ['GET',  `/api/restaurant/${RID}/hotel/ical/room/R1.ics`, 'public'],
  ['POST', `/api/restaurant/${RID}/hotel/folios/F1/apply-promo`, '401'],
  ['GET',  `/api/restaurant/${RID}/hotel/reports/pickup-pace?days=7`, '401'],
  ['GET',  `/api/public/restaurant/${RID}/hotel/checkin/B1`, 'public — expect 404 (no booking)'],
  ['POST', `/api/public/restaurant/${RID}/hotel/checkin/B1`, 'public — expect 404 or 400'],
  ['GET',  `/api/restaurant/${RID}/hotel/yield-rules`, '401'],
  ['POST', `/api/restaurant/${RID}/hotel/yield-rules`, '401'],
  ['GET',  `/api/restaurant/${RID}/hotel/yield-suggest?room_id=R1&date=2026-06-01`, '401'],
  ['GET',  `/api/public/restaurant/${RID}/hotel`, 'public — expect 200 or 403'],
  ['GET',  `/api/public/restaurant/${RID}/hotel/availability?start=2026-06-01&end=2026-06-03&guests=2`, 'public'],
  ['POST', `/api/public/restaurant/${RID}/hotel/booking`, 'public — expect 400 (no body)'],
  ['GET',  `/api/restaurant/${RID}/hotel/channel-credentials`, '401'],
  ['POST', `/api/restaurant/${RID}/hotel/channel-credentials`, '401'],
  ['GET',  `/api/restaurant/${RID}/hotel/rate-overrides`, '401'],
  ['POST', `/api/restaurant/${RID}/hotel/rate-overrides`, '401'],
  ['GET',  `/api/restaurant/${RID}/hotel/rate-preview?room_id=R1&start=2026-06-01&end=2026-06-03`, '401'],
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
      res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 100) }));
    });
    req.on('error', () => resolve({ status: 'ERR', body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT', body: '' }); });
    req.end();
  });
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  Sprint C + D + P2 — Production Endpoint Smoke Test');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  for (const [method, path, hint] of endpoints) {
    const r = await hit(method, path);
    const tag = r.status === 200 ? '✓' :
                r.status === 401 ? '🔒' :
                r.status === 403 ? '🚫' :
                r.status === 404 ? '⚠' :
                r.status === 400 ? '✓ (validates)' :
                '✗';
    console.log(`  ${tag.padEnd(13)} ${String(method).padEnd(5)} ${String(r.status).padEnd(8)} ${path}`);
  }
})();
