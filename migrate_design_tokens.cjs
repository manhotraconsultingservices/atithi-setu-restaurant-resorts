/**
 * Atithi Setu — Design Token Migration Script
 *
 * Mechanically replaces legacy design values in src/App.tsx with the new
 * design-token-based classes defined in index.html :root and src/index.css @theme.
 *
 * Phases covered:
 *   Phase 3 — Text contrast: opacity-based text → named color tokens
 *   Phase 4 — Border-radius: arbitrary px values → Tailwind tokens
 *   Phase 4 — Borders: invisible 5% opacity → readable subtle borders
 *
 * Safety:
 *   - Dry run by default. Pass --apply to write changes.
 *   - Prints a change summary by category.
 *   - Creates a .bak backup before writing.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'src', 'App.tsx');
const BACKUP = FILE + '.bak_' + Date.now();
const APPLY = process.argv.includes('--apply');

if (!fs.existsSync(FILE)) {
  console.error('File not found:', FILE);
  process.exit(1);
}

let src = fs.readFileSync(FILE, 'utf8');
const originalLength = src.length;

// ---------------------------------------------------------------------------
// Replacement rules (ordered — longer patterns first to avoid partial matches)
// ---------------------------------------------------------------------------
const rules = [

  // ============ PHASE 3: Text contrast — opacity tiers on #0d0a07 ============
  // These opacity-based text colors all fail WCAG AA. Replace with named tokens.
  { pattern: /text-\[#0d0a07\]\/85/g,  replacement: 'text-[#1a1208]',              label: 'text/85  → heading'    },
  { pattern: /text-\[#0d0a07\]\/75/g,  replacement: 'text-[#3d3128]',              label: 'text/75  → body'       },
  { pattern: /text-\[#0d0a07\]\/70/g,  replacement: 'text-[#3d3128]',              label: 'text/70  → body'       },
  { pattern: /text-\[#0d0a07\]\/65/g,  replacement: 'text-[#6b5d52]',              label: 'text/65  → secondary'  },
  { pattern: /text-\[#0d0a07\]\/60/g,  replacement: 'text-[#6b5d52]',              label: 'text/60  → secondary'  },
  { pattern: /text-\[#0d0a07\]\/55/g,  replacement: 'text-[#6b5d52]',              label: 'text/55  → secondary'  },
  { pattern: /text-\[#0d0a07\]\/50/g,  replacement: 'text-[#6b5d52]',              label: 'text/50  → secondary'  },
  { pattern: /text-\[#0d0a07\]\/45/g,  replacement: 'text-[#9c8e85]',              label: 'text/45  → muted'      },
  { pattern: /text-\[#0d0a07\]\/40/g,  replacement: 'text-[#9c8e85]',              label: 'text/40  → muted'      },
  { pattern: /text-\[#0d0a07\]\/35/g,  replacement: 'text-[#9c8e85]',              label: 'text/35  → muted'      },
  { pattern: /text-\[#0d0a07\]\/30/g,  replacement: 'text-[#9c8e85]',              label: 'text/30  → muted'      },
  { pattern: /text-\[#0d0a07\]\/25/g,  replacement: 'text-[#c5b9b2]',              label: 'text/25  → disabled'   },
  { pattern: /text-\[#0d0a07\]\/20/g,  replacement: 'text-[#c5b9b2]',              label: 'text/20  → disabled'   },
  { pattern: /text-\[#0d0a07\](?!\/)/g, replacement: 'text-[#1a1208]',             label: 'text full → heading'   },

  // Placeholders followed the same opacity scheme
  { pattern: /placeholder:text-\[#0d0a07\]\/50/g, replacement: 'placeholder:text-[#9c8e85]', label: 'placeholder/50 → muted' },
  { pattern: /placeholder:text-\[#0d0a07\]\/40/g, replacement: 'placeholder:text-[#9c8e85]', label: 'placeholder/40 → muted' },
  { pattern: /placeholder:text-\[#0d0a07\]\/30/g, replacement: 'placeholder:text-[#c5b9b2]', label: 'placeholder/30 → disabled' },

  // Microscopic font sizes (WCAG SC 1.4.4 violations)
  { pattern: /text-\[8px\]/g,  replacement: 'text-[11px]', label: 'text-[8px]  → 11px (label min)' },
  { pattern: /text-\[9px\]/g,  replacement: 'text-[11px]', label: 'text-[9px]  → 11px (label min)' },
  { pattern: /text-\[10px\]/g, replacement: 'text-[11px]', label: 'text-[10px] → 11px (label min)' },

  // ============ PHASE 4: Border radius standardisation ============
  { pattern: /rounded-\[40px\]/g, replacement: 'rounded-[32px]', label: 'radius 40px → 32px' },
  { pattern: /rounded-\[28px\]/g, replacement: 'rounded-3xl',    label: 'radius 28px → 3xl (24px)' },
  { pattern: /rounded-\[24px\]/g, replacement: 'rounded-3xl',    label: 'radius 24px → 3xl' },
  // Note: rounded-[32px] is kept as-is (hero/modal sizing)

  // ============ PHASE 4: Invisible borders ============
  // 5% opacity orange on white is ~#fdf6f2 — not useful as a border.
  // Bump to 10% for visible but subtle hierarchy.
  { pattern: /border-\[#e8721c\]\/5(?!0)/g, replacement: 'border-[#e8721c]/10', label: 'border/5 → border/10' },
];

// ---------------------------------------------------------------------------
// Apply rules and collect statistics
// ---------------------------------------------------------------------------
const stats = [];
let totalReplacements = 0;

for (const rule of rules) {
  const matches = src.match(rule.pattern);
  const count = matches ? matches.length : 0;
  if (count > 0) {
    src = src.replace(rule.pattern, rule.replacement);
    stats.push({ label: rule.label, count });
    totalReplacements += count;
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log('\n=== Atithi Setu Design Token Migration ===');
console.log(`File: ${FILE}`);
console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN (use --apply to write)'}`);
console.log(`\nReplacements by rule:`);
console.log('─'.repeat(60));

stats.sort((a, b) => b.count - a.count);
for (const s of stats) {
  console.log(`  ${String(s.count).padStart(5)}  ${s.label}`);
}

console.log('─'.repeat(60));
console.log(`  Total replacements: ${totalReplacements}`);
console.log(`  Original file size: ${originalLength} chars`);
console.log(`  New file size:      ${src.length} chars`);
console.log(`  Delta:              ${src.length - originalLength} chars`);

if (APPLY) {
  // Create backup
  fs.copyFileSync(FILE, BACKUP);
  console.log(`\n✓ Backup saved: ${BACKUP}`);

  // Write new content
  fs.writeFileSync(FILE, src, 'utf8');
  console.log(`✓ File updated: ${FILE}`);
  console.log('\nNext step: review changes with `git diff src/App.tsx` then rebuild the container.');
} else {
  console.log('\nNo files were modified. Re-run with --apply to execute.');
}
