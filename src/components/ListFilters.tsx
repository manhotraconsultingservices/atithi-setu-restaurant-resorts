// ─────────────────────────────────────────────────────────────────────────────
// Shared list filters for bill and booking lists (Restaurant Invoices, PMS
// Guest Bills, Events bookings, Wellness invoices):
//   • DateRangeBar — Today (default) / Yesterday / Last 7 days / This month /
//     All / Custom range.
//   • StatusTiles  — number tiles that double as filters: click one to show
//     only those rows, click it again to show everything.
// Dates compare as local calendar days (YYYY-MM-DD), the day staff see.
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react';
import { CalendarDays } from 'lucide-react';
import { useT } from '../i18n';

export type DatePreset = 'TODAY' | 'YESTERDAY' | 'LAST_7' | 'THIS_MONTH' | 'ALL' | 'CUSTOM';
export interface DateRange { preset: DatePreset; from: string; to: string }

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function rangeFor(preset: DatePreset, custom?: { from: string; to: string }): DateRange {
  const now = new Date();
  const today = ymd(now);
  switch (preset) {
    case 'TODAY': return { preset, from: today, to: today };
    case 'YESTERDAY': { const y = new Date(now); y.setDate(y.getDate() - 1); const s = ymd(y); return { preset, from: s, to: s }; }
    case 'LAST_7': { const s = new Date(now); s.setDate(s.getDate() - 6); return { preset, from: ymd(s), to: today }; }
    case 'THIS_MONTH': return { preset, from: `${today.slice(0, 8)}01`, to: today };
    case 'ALL': return { preset, from: '', to: '' };
    default: return { preset: 'CUSTOM', from: custom?.from || today, to: custom?.to || today };
  }
}

/** Today, the default for every list. */
export const defaultDateRange = (): DateRange => rangeFor('TODAY');

/** The local calendar day of a date or timestamp value, or '' when there is none. */
export function localDay(v: any): string {
  if (!v) return '';
  const s = String(v);
  // A plain date (YYYY-MM-DD) is already a calendar day; don't shift it by time zone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d.getTime()) ? s.slice(0, 10) : ymd(d);
}

/** Does a single day fall in the range? An empty range (All) matches everything. */
export function dayInRange(v: any, r: DateRange): boolean {
  if (!r.from && !r.to) return true;
  const day = localDay(v);
  if (!day) return false;
  return (!r.from || day >= r.from) && (!r.to || day <= r.to);
}

/** Does a span (e.g. a stay or a multi-day event) overlap the range? */
export function spanInRange(start: any, end: any, r: DateRange): boolean {
  if (!r.from && !r.to) return true;
  const s = localDay(start);
  const e = localDay(end) || s;
  if (!s) return false;
  return (!r.to || s <= r.to) && (!r.from || e >= r.from);
}

export function DateRangeBar({ value, onChange, label }: { value: DateRange; onChange: (r: DateRange) => void; label?: string }) {
  const { t } = useT();
  const presets: DatePreset[] = ['TODAY', 'YESTERDAY', 'LAST_7', 'THIS_MONTH', 'ALL', 'CUSTOM'];
  const input = 'px-2.5 py-1.5 text-xs rounded-lg border border-brand/15 bg-[#faf7f2] focus:outline-none focus:ring-1 ring-brand/30';
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[10px] font-bold uppercase tracking-widest text-[#9c8e85] inline-flex items-center gap-1 shrink-0">
        <CalendarDays size={12} /> {label || t('listFilter.date')}
      </span>
      <div className="flex gap-1 bg-[#faf7f2] rounded-xl p-1 border border-brand/10 flex-wrap">
        {presets.map(p => (
          <button key={p} type="button"
            onClick={() => onChange(rangeFor(p, { from: value.from, to: value.to }))}
            className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all ${value.preset === p ? 'bg-brand text-white shadow' : 'text-[#6b5d52] hover:bg-white'}`}>
            {t(`listFilter.${p}`)}
          </button>
        ))}
      </div>
      {value.preset === 'CUSTOM' && (
        <span className="inline-flex items-center gap-1.5">
          <input type="date" className={input} value={value.from} max={value.to || undefined}
            onChange={e => onChange({ preset: 'CUSTOM', from: e.target.value, to: value.to })} aria-label={t('listFilter.from')} />
          <span className="text-[10px] text-[#9c8e85]">{t('listFilter.to')}</span>
          <input type="date" className={input} value={value.to} min={value.from || undefined}
            onChange={e => onChange({ preset: 'CUSTOM', from: value.from, to: e.target.value })} aria-label={t('listFilter.to')} />
        </span>
      )}
    </div>
  );
}

export interface StatusTile {
  /** Filter value this tile selects; omit for a tile that only shows a figure. */
  filter?: string;
  label: string;
  value: React.ReactNode;
  /** Tailwind colour classes for the tile, e.g. 'bg-amber-50 border-amber-200 text-amber-700'. */
  tone: string;
}

export function StatusTiles({ tiles, active, onSelect, allValue = 'ALL' }: {
  tiles: StatusTile[]; active: string; onSelect: (filter: string) => void; allValue?: string;
}) {
  const { t } = useT();
  return (
    <div className={`grid grid-cols-2 gap-3 ${tiles.length >= 4 ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
      {tiles.map(tile => {
        const clickable = !!tile.filter;
        const on = clickable && active === tile.filter;
        const body = (
          <>
            <p className="font-bold text-lg leading-none">{tile.value}</p>
            <p className="text-[11px] uppercase tracking-widest mt-1 opacity-70">{tile.label}</p>
          </>
        );
        return clickable ? (
          <button key={tile.label} type="button" aria-pressed={on}
            title={on ? t('listFilter.showAll') : t('listFilter.showOnly', { label: tile.label })}
            onClick={() => onSelect(on ? allValue : tile.filter!)}
            className={`rounded-2xl border p-3 text-center transition-all hover:shadow-md cursor-pointer ${tile.tone} ${on ? 'ring-2 ring-brand ring-offset-2 shadow-md' : ''}`}>
            {body}
          </button>
        ) : (
          <div key={tile.label} className={`rounded-2xl border p-3 text-center ${tile.tone}`}>{body}</div>
        );
      })}
    </div>
  );
}
