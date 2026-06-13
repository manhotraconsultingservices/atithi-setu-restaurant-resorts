// ════════════════════════════════════════════════════════════════════════
//  qa_season_resolution.mjs — getSeasonForDate "narrowest period wins" audit
//
//  Mirrors the server.ts getSeasonForDate selection: among all ACTIVE season
//  periods that cover a stay date, the MOST SPECIFIC (narrowest date span)
//  wins, so a specific PEAK window overrides a broad OFF / default catch-all
//  regardless of display_order. This is the fix for "off-season rate applied
//  on a peak date" when seasons overlap.
// ════════════════════════════════════════════════════════════════════════
const C = { g: '\x1b[32m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' };
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) pass++; else { fail++; console.log(`  ${C.r}✗${C.x} ${label}`); } };

// Mirror of the selection logic (rows already filtered to those covering the date).
function pickSeason(rows) {
  if (!rows || rows.length === 0) return null;
  if (rows.length === 1) return rows[0].season_id;
  const span = (r) => {
    const s = Date.parse(`${String(r.start_date).slice(0, 10)}T00:00:00Z`);
    const e = Date.parse(`${String(r.end_date).slice(0, 10)}T00:00:00Z`);
    return (Number.isFinite(s) && Number.isFinite(e) && e >= s) ? (e - s) : Number.MAX_SAFE_INTEGER;
  };
  rows.sort((a, b) => {
    const da = span(a), db = span(b);
    if (da !== db) return da - db;
    return Number(a.display_order || 0) - Number(b.display_order || 0);
  });
  return rows[0].season_id;
}
// Filter to periods covering the date (mirrors the SQL BETWEEN).
const covering = (periods, date) => periods.filter(p => date >= p.start_date && date <= p.end_date);

console.log(`${C.b}\n═══ Season resolution — narrowest period wins ═══${C.x}`);

// Config: OFF is a year-long catch-all (display_order 0); PEAK is a specific
// window (display_order 1). This is exactly the setup that previously made
// off-season rates apply on peak dates (ORDER BY display_order picked OFF).
const periods = [
  { season_id: 'OFF',  start_date: '2026-01-01', end_date: '2026-12-31', display_order: 0 },
  { season_id: 'PEAK', start_date: '2026-04-15', end_date: '2026-06-30', display_order: 1 },
  { season_id: 'XMAS', start_date: '2026-12-20', end_date: '2026-12-31', display_order: 2 },
];

// A date inside the PEAK window → PEAK wins over the year-long OFF.
ok(pickSeason(covering(periods, '2026-06-13')) === 'PEAK', 'peak-window date resolves to PEAK (not the broad OFF catch-all)');
ok(pickSeason(covering(periods, '2026-05-01')) === 'PEAK', 'another in-peak date resolves to PEAK');
// A date only in OFF → OFF.
ok(pickSeason(covering(periods, '2026-02-10')) === 'OFF',  'off-window date resolves to OFF');
// A date in OFF + XMAS (narrow) → the narrow XMAS wins.
ok(pickSeason(covering(periods, '2026-12-25')) === 'XMAS', 'overlapping OFF + narrow XMAS resolves to XMAS');
// A date covered by nothing → null (caller falls back to legacy base rate).
ok(pickSeason(covering(periods, '2025-11-01')) === null,   'uncovered date resolves to null (legacy fallback)');
// Single match → that season.
ok(pickSeason([{ season_id: 'PEAK', start_date: '2026-04-15', end_date: '2026-06-30', display_order: 1 }]) === 'PEAK', 'single covering period returns that season');

console.log(`${C.b}\n═══════════════════════════════════════════════════════════════${C.x}`);
console.log(`  ${C.g}✓ Passed:${C.x} ${pass}`);
console.log(`  ${fail ? C.r : C.g}✗ Failed:${C.x} ${fail}`);
console.log(`${C.b}═══════════════════════════════════════════════════════════════${C.x}`);
process.exit(fail > 0 ? 1 : 0);
