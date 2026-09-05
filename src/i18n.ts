// ════════════════════════════════════════════════════════════════════════
// Lightweight runtime i18n layer (app-wide, non-invasive).
//
// Design goals:
//   • Zero broken screens during a partial rollout. t(key) resolves
//     dict[lang][key] → dict.en[key] → key, so any string that isn't wrapped
//     yet, or isn't translated yet, renders correct English.
//   • Tenant picks a language (restaurants.secondary_language). That becomes the
//     app's DEFAULT UI language; each user can still toggle to English (their
//     choice persists per-browser). English is always available as a fallback.
//   • The language lives in a MODULE-LEVEL store (not a React context), so any
//     component — the header switcher, Settings, every module — reads/sets it via
//     useT() without needing to sit inside a provider. LanguageProvider is kept as
//     a thin store-seeder for backward compatibility.
//   • English is the complete source of truth; regional dictionaries start as
//     stubs a translator fills over time.
// ════════════════════════════════════════════════════════════════════════
import { useState, useEffect, ReactNode } from 'react';
import { en } from './locales/en';
import { ta } from './locales/ta';
import { hi } from './locales/hi';
import { kn } from './locales/kn';
import { te } from './locales/te';
import { pa } from './locales/pa';
import { mr } from './locales/mr';
import { bn } from './locales/bn';
import { gu } from './locales/gu';

export type Dict = Record<string, string>;

// English is authoritative; regional dictionaries override per-key when present.
export const dictionaries: Record<string, Dict> = { en, ta, hi, kn, te, pa, mr, bn, gu };

// Human-readable names for the tenant's language picker. Covers the common
// Indian regional languages; extend freely — an unknown code still works, it
// just falls back to English strings until a dictionary is added.
export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ta: 'தமிழ் · Tamil',
  hi: 'हिन्दी · Hindi',
  kn: 'ಕನ್ನಡ · Kannada',
  te: 'తెలుగు · Telugu',
  pa: 'ਪੰਜਾਬੀ · Punjabi',
  mr: 'मराठी · Marathi',
  bn: 'বাংলা · Bengali',
  gu: 'ગુજરાતી · Gujarati',
  ml: 'മലയാളം · Malayalam',
};

// Short badges for the compact header toggle.
export const LANGUAGE_SHORT: Record<string, string> = {
  en: 'EN', ta: 'த', hi: 'हि', kn: 'ಕ', te: 'తె', pa: 'ਪੰ', mr: 'मरा', bn: 'বাং', gu: 'ગુ', ml: 'മ',
};

export const SECONDARY_LANGUAGE_OPTIONS = ['ta', 'hi', 'kn', 'te', 'pa', 'mr', 'bn', 'gu', 'ml'];

/** Pure resolver: dict[lang][key] → en[key] → key, with {var} interpolation. */
export function translate(lang: string, key: string, vars?: Record<string, any>): string {
  const d = dictionaries[lang];
  let s = (d && d[key] != null ? d[key] : undefined) ?? (en[key] != null ? en[key] : key);
  if (vars) {
    for (const k of Object.keys(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(vars[k]));
    }
  }
  return s;
}

// ── Module-level store (provider-free) ──────────────────────────────────────
const STORAGE_KEY = 'appLang';
const _subs = new Set<() => void>();
const _notify = () => { _subs.forEach((fn) => { try { fn(); } catch { /* */ } }); };

let _secondary: string | null = null;
// Seed the active language from the user's last explicit choice (per browser).
// It gets validated against the tenant's secondary the moment that is known.
let _lang = 'en';
try { const s = localStorage.getItem(STORAGE_KEY); if (s) _lang = s; } catch { /* */ }

/** Tell the store which language the TENANT chose (restaurants.secondary_language).
 *  Sets the app's default: user's explicit override wins, otherwise the tenant
 *  language. Called by App when the restaurant loads (and by LanguageProvider). */
export function setSecondaryLanguage(sec: string | null): void {
  const next = sec || null;
  const changed = next !== _secondary;
  _secondary = next;
  let stored: string | null = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* */ }
  let resolved: string;
  if (stored === 'en') resolved = 'en';                      // user explicitly chose English
  else if (stored && stored === _secondary) resolved = stored; // user chose this language
  else resolved = _secondary || 'en';                        // default to the tenant language
  if (resolved !== _lang || changed) { _lang = resolved; _notify(); }
}

/** Set the ACTIVE UI language for this user (persists per-browser). */
export function setAppLanguage(l: string): void {
  _lang = l;
  try { localStorage.setItem(STORAGE_KEY, l); } catch { /* */ }
  _notify();
}

export function getAppLanguage(): string { return _lang; }
export function getSecondaryLanguage(): string | null { return _secondary; }

interface LangApi {
  lang: string;
  secondary: string | null;
  setLang: (l: string) => void;
  t: (key: string, vars?: Record<string, any>) => string;
}

/** Hook: const { t, lang, secondary, setLang } = useT(). Re-renders on change.
 *  Reads the module store — works in ANY component, no provider required. */
export function useT(): LangApi {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((x) => (x + 1) % 1e9);
    _subs.add(fn);
    return () => { _subs.delete(fn); };
  }, []);
  return {
    lang: _lang,
    secondary: _secondary,
    setLang: setAppLanguage,
    t: (key: string, vars?: Record<string, any>) => translate(_lang, key, vars),
  };
}

/** Backward-compatible thin wrapper: seeds the store from its `secondary` prop.
 *  (No longer a React context provider — useT() reads the module store.) */
export function LanguageProvider({ secondary, children }: { secondary?: string | null; children: ReactNode }) {
  useEffect(() => { setSecondaryLanguage(secondary || null); }, [secondary]);
  return children as any;
}
