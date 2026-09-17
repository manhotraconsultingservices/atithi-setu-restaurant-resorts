// Brand colour for places a CSS class cannot reach: chart strokes and fills,
// computed inline colours. Read from the CSS variables defined once in
// src/index.css (@theme), so changing the brand is a change there only.
function cssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch { return fallback; }
}

export const BRAND = cssVar('--color-brand', '#0F6E78');
export const BRAND_DARK = cssVar('--color-brand-dark', '#0B5961');
