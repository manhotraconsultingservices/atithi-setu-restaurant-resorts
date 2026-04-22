/**
 * Heritage Premium palette migration.
 * Replaces the current saffron #e8721c throughout App.tsx with the deeper
 * Heritage saffron #cc5a16, and the cream #faf5ee with warm ivory #faf7f2.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'src', 'App.tsx');
const APPLY = process.argv.includes('--apply');

let src = fs.readFileSync(FILE, 'utf8');
const rules = [
  // Primary saffron: deeper, more refined
  { pattern: /#e8721c/gi, replacement: '#cc5a16', label: 'primary saffron → deeper #cc5a16' },
  // Hover darker saffron
  { pattern: /#c9592a/gi, replacement: '#a84612', label: 'primary hover → #a84612' },
  // Cream background → warm ivory
  { pattern: /#faf5ee/gi, replacement: '#faf7f2', label: 'cream bg → warm ivory #faf7f2' },
];

const stats = [];
for (const rule of rules) {
  const matches = src.match(rule.pattern);
  const count = matches ? matches.length : 0;
  if (count > 0) {
    src = src.replace(rule.pattern, rule.replacement);
    stats.push({ label: rule.label, count });
  }
}

console.log('\n=== Heritage Premium Palette Migration ===');
console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);
for (const s of stats) console.log(`  ${String(s.count).padStart(5)}  ${s.label}`);
const total = stats.reduce((a, b) => a + b.count, 0);
console.log(`\n  Total: ${total}`);

if (APPLY) {
  const backup = FILE + '.bak_heritage_' + Date.now();
  fs.copyFileSync(FILE, backup);
  fs.writeFileSync(FILE, src, 'utf8');
  console.log(`\n✓ Backup: ${backup}`);
  console.log(`✓ Written: ${FILE}`);
}
