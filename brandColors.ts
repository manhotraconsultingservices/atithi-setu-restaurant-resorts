// ─────────────────────────────────────────────────────────────────────────────
// Brand colour for everything the SERVER renders: emails, PDFs (invoices,
// purchase orders, bank reconciliation) and the small public HTML pages.
//
// The colour is defined once, in src/index.css (@theme --color-brand and
// --color-brand-dark), which the app's screens also use. This module reads it
// from there at startup, so changing the brand is still a single edit. The
// fallbacks only apply if that file cannot be read.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';

const FALLBACK = { brand: '#0F6E78', dark: '#0B5961' };

function readBrand(): { brand: string; dark: string } {
  try {
    const css = fs.readFileSync(path.join(process.cwd(), 'src', 'index.css'), 'utf8');
    const pick = (name: string) => (css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`)) || [])[1];
    return { brand: pick('--color-brand') || FALLBACK.brand, dark: pick('--color-brand-dark') || FALLBACK.dark };
  } catch {
    return FALLBACK;
  }
}

const colors = readBrand();

/** Brand colour, e.g. headings, buttons, table headers. */
export const BRAND_HEX = colors.brand;
/** Darker brand shade, e.g. the second stop of a gradient. */
export const BRAND_DARK_HEX = colors.dark;
