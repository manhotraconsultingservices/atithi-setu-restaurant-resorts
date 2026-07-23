// ════════════════════════════════════════════════════════════════════════
// Lightweight runtime i18n layer (app-wide, non-invasive).
//
// Design goals:
//   • Zero broken screens during a partial rollout. t(key) resolves
//     dict[lang][key] → dict.en[key] → key, so any string that isn't wrapped
//     yet, or isn't translated yet, renders correct English.
//   • Tenant picks a secondary language (restaurants.secondary_language). The
//     header toggle flips between English and that language only.
//   • English is the complete source of truth; regional dictionaries start as
//     stubs a translator fills over time.
// ════════════════════════════════════════════════════════════════════════
import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { en } from './locales/en';
import { ta } from './locales/ta';
import { hi } from './locales/hi';
import { kn } from './locales/kn';
import { te } from './locales/te';
import { pa } from './locales/pa';

export type Dict = Record<string, string>;

// English is authoritative; regional dictionaries override per-key when present.
export const dictionaries: Record<string, Dict> = { en, ta, hi, kn, te, pa };

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

interface LangCtxShape {
  lang: string;
  secondary: string | null;
  setLang: (l: string) => void;
  t: (key: string, vars?: Record<string, any>) => string;
}

const LangCtx = createContext<LangCtxShape>({
  lang: 'en',
  secondary: null,
  setLang: () => {},
  t: (key: string, vars?: Record<string, any>) => translate('en', key, vars),
});

const STORAGE_KEY = 'appLang';

export function LanguageProvider({ secondary, children }: { secondary?: string | null; children: ReactNode }) {
  const sec = secondary || null;
  const [lang, setLangState] = useState<string>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && (stored === 'en' || stored === sec)) return stored;
    return 'en';
  });

  // If the tenant's secondary language changes (or clears), keep the active
  // language valid — never leave the UI stuck on a language the tenant dropped.
  useEffect(() => {
    if (lang !== 'en' && lang !== sec) {
      setLangState('en');
      localStorage.setItem(STORAGE_KEY, 'en');
    }
  }, [sec]); // eslint-disable-line react-hooks/exhaustive-deps

  const setLang = (l: string) => {
    setLangState(l);
    localStorage.setItem(STORAGE_KEY, l);
  };

  const t = (key: string, vars?: Record<string, any>) => translate(lang, key, vars);

  return React.createElement(LangCtx.Provider, { value: { lang, secondary: sec, setLang, t } }, children);
}

/** Hook: const { t, lang, secondary, setLang } = useT(). */
export function useT(): LangCtxShape {
  return useContext(LangCtx);
}
