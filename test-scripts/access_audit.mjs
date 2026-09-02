/**
 * ACCESS AUDIT — validate every access/RBAC concern in ONE command, so we never
 * get surprised in front of a client again.
 *
 * It runs, sequentially (never in parallel — concurrent runs overload the
 * Cloudflare tunnel), the full access-control stack and prints one verdict:
 *
 *   1. Nav visibility (headless, no server)  — the EXACT set of tabs each role
 *      renders, including the derived/cross-permission leaks a pure API check
 *      can't see (e.g. Events "Cleaning Checklist" borrowing the Housekeeping
 *      permission). This is the class clients keep reporting.
 *   2. RBAC isolation (server)               — staff must NOT reach modules they
 *      weren't granted; /my-permissions returns EXACTLY the granted tabs.
 *   3. (--full) Manager grants + Senior-review sweeps — every "granted role must
 *      be able to do its job" check across all 11 historical bug areas.
 *
 * Usage:
 *   node test-scripts/access_audit.mjs                 # nav + isolation on the .env tenant
 *   node test-scripts/access_audit.mjs --tenant=RESTO-1003
 *   node test-scripts/access_audit.mjs --full          # also run manager + review
 *   node test-scripts/access_audit.mjs --quick         # nav visibility only (no server)
 *
 * Exit 0 = everything green (safe to demo). Non-zero = a leak or denial exists.
 */
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load .env.local so a bare run has BASE_URL / OWNER_* / RESTAURANT_ID.
(function loadEnv() {
  for (const f of [process.env.SMOKE_ENV_FILE, join(__dirname, '.env.local')].filter(Boolean)) {
    let t; try { t = readFileSync(f, 'utf8'); } catch { continue; }
    for (const raw of t.split(/\r?\n/)) {
      const l = raw.trim(); if (!l || l.startsWith('#')) continue;
      const e = l.indexOf('='); if (e < 0) continue;
      const k = l.slice(0, e).trim(); let v = l.slice(e + 1).trim();
      if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
    break;
  }
})();

const args = process.argv.slice(2);
const tenantArg = (args.find(a => a.startsWith('--tenant=')) || '').split('=')[1];
const FULL = args.includes('--full');
const QUICK = args.includes('--quick');
const TENANT = tenantArg || process.env.RESTAURANT_ID || '';
const BASE = process.env.BASE_URL || 'https://erp.atithi-setu.com';

// suite = { name, run: [cmd, ...args], server }
const suites = [
  { name: 'Nav visibility (headless)', run: ['npx', 'tsx', 'test-scripts/nav_visibility_audit.ts'], server: false },
];
if (!QUICK) {
  suites.push({ name: 'RBAC isolation (staff cannot see other modules)', run: ['node', 'test-scripts/rbac_isolation_validation.mjs'], server: true });
  if (FULL) {
    suites.push({ name: 'Manager grants (all 11 bug areas)', run: ['node', 'test-scripts/rbac_manager_validation.mjs'], server: true });
    suites.push({ name: 'Senior-review sweep (hardcoded-role hunt)', run: ['node', 'test-scripts/rbac_review_validation.mjs'], server: true });
  }
}

console.log('\n' + '#'.repeat(74));
console.log('#  ACCESS AUDIT — one-shot access/RBAC validation');
console.log(`#  tenant : ${TENANT || '(none — headless suites only)'}`);
console.log(`#  base   : ${BASE}`);
console.log(`#  mode   : ${QUICK ? 'quick (nav only)' : FULL ? 'full (nav + isolation + manager + review)' : 'standard (nav + isolation)'}`);
console.log('#'.repeat(74));

const childEnv = { ...process.env };
if (TENANT) childEnv.RESTAURANT_ID = TENANT;

const verdicts = [];
for (const s of suites) {
  if (s.server && !TENANT) { verdicts.push({ name: s.name, code: 'SKIP', note: 'no tenant configured' }); continue; }
  if (s.server && !(process.env.OWNER_EMAIL && process.env.OWNER_PASSWORD)) {
    verdicts.push({ name: s.name, code: 'SKIP', note: 'no owner credentials (.env.local)' }); continue;
  }
  console.log(`\n${'─'.repeat(74)}\n▶  ${s.name}\n${'─'.repeat(74)}`);
  const [cmd, ...rest] = s.run;
  const r = spawnSync(cmd, rest, { cwd: ROOT, env: childEnv, stdio: 'inherit', shell: true });
  verdicts.push({ name: s.name, code: r.status === 0 ? 'PASS' : 'FAIL' });
}

console.log('\n' + '='.repeat(74));
console.log('  ACCESS AUDIT — SUMMARY');
console.log('='.repeat(74));
for (const v of verdicts) {
  const icon = v.code === 'PASS' ? '✅' : v.code === 'SKIP' ? '⚠️ ' : '❌';
  console.log(`  ${icon} ${v.code.padEnd(4)}  ${v.name}${v.note ? '  (' + v.note + ')' : ''}`);
}
const failed = verdicts.filter(v => v.code === 'FAIL').length;
console.log('='.repeat(74));
console.log(failed === 0
  ? '  ✅ ALL CLEAR — no access leaks or denials. Safe to demo.'
  : `  ❌ ${failed} suite(s) FAILED — fix before demoing (see details above).`);
console.log('='.repeat(74) + '\n');
process.exit(failed > 0 ? 1 : 0);
