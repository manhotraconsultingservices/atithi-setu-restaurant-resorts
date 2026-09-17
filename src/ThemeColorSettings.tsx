// ─────────────────────────────────────────────────────────────────────────────
// Settings → Business → Theme colour. A tenant replaces the peacock default
// with its own colour for everyone on the account. The colour is applied to the
// CSS variables every bg-brand / text-brand class reads (see applyThemeColor),
// and remembered on this device so the next load starts in it.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState } from 'react';
import { Check, Palette, RotateCcw } from 'lucide-react';
import { useT } from './i18n';
import { canWriteTab } from './perm';
import { cn } from './lib/utils';
import { DEFAULT_THEME_COLOR, checkThemeColor, darkerShade, normaliseHex } from '../tenantTheme';

const STORE_KEY = 'tenant:theme';

/** Apply a tenant colour to the whole app, or return to the default with null. */
export function applyThemeColor(color: string | null | undefined): void {
  const check = color ? checkThemeColor(color) : null;
  const root = document.documentElement;
  try {
    if (check && check.ok) {
      root.style.setProperty('--color-brand', check.hex);
      root.style.setProperty('--color-brand-dark', darkerShade(check.hex));
      localStorage.setItem(STORE_KEY, JSON.stringify({ brand: check.hex, dark: darkerShade(check.hex) }));
    } else {
      root.style.removeProperty('--color-brand');
      root.style.removeProperty('--color-brand-dark');
      localStorage.removeItem(STORE_KEY);
    }
  } catch { /* storage unavailable: the colour still applies for this visit */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', check && check.ok ? check.hex : DEFAULT_THEME_COLOR);
}

const PRESETS: { key: string; hex: string }[] = [
  { key: 'peacock', hex: '#0F6E78' },
  { key: 'royal', hex: '#1D4ED8' },
  { key: 'emerald', hex: '#047857' },
  { key: 'plum', hex: '#7E22CE' },
  { key: 'maroon', hex: '#9F1239' },
  { key: 'terracotta', hex: '#B4532A' },
  { key: 'saffron', hex: '#C2410C' },
  { key: 'charcoal', hex: '#334155' },
];

export function ThemeColorSettings({ restaurantId, token, current, onSaved }: { restaurantId: string; token: string; current: string | null | undefined; onSaved: () => void }) {
  const { t } = useT();
  const canEdit = canWriteTab('SETTINGS');
  const saved = normaliseHex(current) || DEFAULT_THEME_COLOR;
  const [pick, setPick] = useState(saved);
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { setPick(saved); setText(saved); }, [saved]);

  const check = checkThemeColor(pick);
  const dirty = pick !== saved;

  const choose = (hex: string) => {
    const h = normaliseHex(hex);
    setText(hex);
    if (h) setPick(h);
    setMsg(null);
  };

  const save = async (color: string | null) => {
    if (!canEdit) return;
    if (color && !checkThemeColor(color).ok) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/restaurant/${restaurantId}/settings/theme-color`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ theme_color: color }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error || t('theme.saveFailed'));
      applyThemeColor(b.theme_color);
      setMsg({ ok: true, text: t('theme.saved') });
      onSaved();
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  };

  const dark = check.ok ? darkerShade(check.hex) : '#000000';
  return (
    <div className="bg-white p-6 rounded-[24px] border border-brand/10 shadow-sm">
      <h3 className="text-xl font-bold font-serif flex items-center gap-2"><Palette size={20} className="text-brand" /> {t('theme.title')}</h3>
      <p className="text-xs text-[#6b5d52] mt-1 mb-4">{t('theme.hint')}</p>
      <div className="grid gap-5 md:grid-cols-[1fr_260px]">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map(p => (
              <button key={p.hex} type="button" disabled={!canEdit} onClick={() => choose(p.hex)} title={t(`theme.preset.${p.key}`)}
                className={cn('flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-xl border text-xs font-bold disabled:opacity-60',
                  pick === p.hex ? 'border-[#1a1208] bg-[#faf7f2]' : 'border-[#e8dccf] hover:border-[#1a1208]/40')}>
                <span className="w-6 h-6 rounded-lg flex items-center justify-center text-white" style={{ background: p.hex }}>{pick === p.hex && <Check size={13} />}</span>
                {t(`theme.preset.${p.key}`)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input type="color" disabled={!canEdit} value={normaliseHex(text) || pick} onChange={e => choose(e.target.value)} className="w-10 h-10 rounded-lg border border-[#e8dccf] cursor-pointer disabled:cursor-default" aria-label={t('theme.custom')} />
            <input disabled={!canEdit} value={text} onChange={e => choose(e.target.value)} maxLength={7} className="w-28 font-mono text-sm border border-[#e8dccf] rounded-xl px-3 py-2" aria-label={t('theme.custom')} />
            <span className="text-xs text-[#6b5d52]">{t('theme.custom')}</span>
          </div>
          {!check.ok && <p className="text-xs text-rose-700">{check.error}</p>}
          {msg && <p className={cn('text-xs', msg.ok ? 'text-emerald-700' : 'text-rose-700')}>{msg.text}</p>}
          {canEdit && (
            <div className="flex flex-wrap gap-2 pt-1">
              <button type="button" onClick={() => save(pick === DEFAULT_THEME_COLOR ? null : pick)} disabled={busy || !dirty || !check.ok}
                className="px-5 py-2 rounded-xl text-white text-sm font-bold disabled:opacity-40" style={{ background: check.ok ? check.hex : undefined }}>
                {busy ? t('theme.saving') : t('theme.save')}
              </button>
              {normaliseHex(current) && (
                <button type="button" onClick={() => save(null)} disabled={busy} className="px-4 py-2 rounded-xl text-sm font-bold bg-[#faf7f2] text-[#1a1208] flex items-center gap-1.5">
                  <RotateCcw size={14} /> {t('theme.reset')}
                </button>
              )}
            </div>
          )}
        </div>
        {/* Preview in the chosen colour, before saving */}
        <div className="rounded-2xl border border-[#e8dccf] overflow-hidden text-xs" aria-label={t('theme.preview')}>
          <div className="px-3 py-2 text-white font-bold" style={{ background: check.ok ? check.hex : '#999' }}>{t('theme.preview')}</div>
          <div className="p-3 space-y-2 bg-[#faf7f2]">
            <div className="flex gap-1.5">
              <span className="px-2.5 py-1 rounded-lg text-white font-bold" style={{ background: check.ok ? check.hex : '#999' }}>{t('theme.sampleButton')}</span>
              <span className="px-2.5 py-1 rounded-lg text-white font-bold" style={{ background: dark }}>{t('theme.sampleHover')}</span>
            </div>
            <span className="inline-block px-2 py-0.5 rounded-full font-bold" style={{ color: check.ok ? check.hex : '#999', background: check.ok ? `${check.hex}1A` : '#eee' }}>{t('theme.sampleBadge')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
