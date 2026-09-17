// ─────────────────────────────────────────────────────────────────────────────
// Tenant theme colour: shared by the server (validation) and the app (applying
// it). Peacock is the platform default, defined in src/index.css; a tenant may
// pick its own, saved on restaurants.theme_color. The darker hover/pressed shade
// is derived, so a tenant chooses one colour.
// Pure functions only, no DOM or database, like upiLink.ts and tenantHost.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_THEME_COLOR = '#0F6E78';

const HEX = /^#[0-9a-fA-F]{6}$/;

export function normaliseHex(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const h = s.startsWith('#') ? s : `#${s}`;
  return HEX.test(h) ? h.toUpperCase() : null;
}

const channel = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };

/** WCAG contrast ratio of white text on this colour. */
export function contrastWithWhite(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
  return 1.05 / (lum + 0.05);
}

/** Buttons, the header and badges carry white text on the brand colour, so a
 *  colour too pale to read white text on is refused (WCAG 3:1, bold UI text). */
export const MIN_CONTRAST = 3;

// A flat shape (not a union): this project's tsconfig does not narrow on ok.
export function checkThemeColor(v: unknown): { ok: boolean; hex: string; error: string } {
  const hex = normaliseHex(v);
  if (!hex) return { ok: false, hex: '', error: 'Use a colour code like #0F6E78.' };
  if (contrastWithWhite(hex) < MIN_CONTRAST) return { ok: false, hex, error: 'This colour is too light: white text on it would be hard to read. Pick a darker shade.' };
  return { ok: true, hex, error: '' };
}

/** The hover / pressed shade: the same colour, 20% darker. */
export function darkerShade(hex: string, amount = 0.2): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.round(c * (1 - amount))).toString(16).padStart(2, '0');
  return `#${f((n >> 16) & 255)}${f((n >> 8) & 255)}${f(n & 255)}`.toUpperCase();
}
