// ════════════════════════════════════════════════════════════════════════
// Calendar Mahurat View (Events, opt-in per property).
// A separate page so the existing Event Calendar, bookings and public page are
// untouched: owner-defined, religion-agnostic seasons tint the calendar, a BLOCK
// season stops new events on its dates for its venues (server-enforced, owner
// override recorded on the booking), and bookings show on top.
// Everything here stays hidden until the property switches the feature on in
// Events → Public Page Settings.
// ════════════════════════════════════════════════════════════════════════
import React, { useEffect, useMemo, useState } from 'react';
import { useT } from './i18n';
import { DataTable } from './components/DataTable';
import { useConfirm } from './components/ConfirmDialog';
import { todayIST } from './lib/utils';
import { canWriteTab, canDeleteTab } from './perm';
import { CalendarHeart, ChevronLeft, ChevronRight, Plus, Pencil, Trash2, X, Lock, Sparkles, AlertTriangle } from 'lucide-react';

const CARD = 'bg-white rounded-2xl border border-[#e8dccf] p-5';
const BTN = 'px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors';
const BTN_PRIMARY = `${BTN} bg-brand text-white hover:bg-[#b34f12] disabled:opacity-50`;
const BTN_GHOST = `${BTN} bg-[#faf7f2] border border-[#e8dccf] text-[#3d3128] hover:bg-[#f0e9df]`;
const INPUT = 'w-full px-3 py-2 rounded-xl border border-[#e8dccf] text-sm bg-white focus:outline-none focus:border-brand';
const LABEL = 'text-xs font-semibold text-[#6b5d52] mb-1 block';
const PRESET_COLORS = ['#f59e0b', '#dc2626', '#16a34a', '#2563eb', '#7c3aed', '#db2777', '#0d9488', '#6b7280'];
const STATUS_COLORS: Record<string, string> = {
  INQUIRY: '#9ca3af', QUOTED: '#d97706', CONFIRMED: '#15803d', IN_PROGRESS: '#2563eb', COMPLETED: '#475569',
};

type Day = { id?: string; start_date: string; end_date: string; note?: string | null };
type Season = { id: string; name: string; color: string; kind: 'HIGHLIGHT' | 'BLOCK'; venue_ids: string[] | null; show_public: boolean; notes?: string | null; days: Day[] };

// ── date helpers (plain YYYY-MM-DD strings, UTC arithmetic) ─────────────────
const DAY_MS = 86400000;
const toMs = (s: string) => Date.parse(s + 'T00:00:00Z');
const fromMs = (n: number) => new Date(n).toISOString().slice(0, 10);
const addDays = (s: string, n: number) => fromMs(toMs(s) + n * DAY_MS);
const monIndex = (s: string) => (new Date(toMs(s)).getUTCDay() + 6) % 7; // Monday = 0
const monthStart = (s: string) => s.slice(0, 8) + '01';
const monthEnd = (s: string) => { const d = new Date(toMs(monthStart(s))); d.setUTCMonth(d.getUTCMonth() + 1); return fromMs(d.getTime() - DAY_MS); };
const shiftMonth = (s: string, n: number) => { const d = new Date(toMs(monthStart(s))); d.setUTCMonth(d.getUTCMonth() + n); return fromMs(d.getTime()); };
const locale = (lang: string) => (lang && lang !== 'en' ? lang : 'en-IN');
const fmtMonth = (s: string, lang: string) => new Intl.DateTimeFormat(locale(lang), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(toMs(s)));
const fmtShortMonth = (s: string, lang: string) => new Intl.DateTimeFormat(locale(lang), { month: 'short', timeZone: 'UTC' }).format(new Date(toMs(s)));
const fmtDay = (s: string, lang: string) => new Intl.DateTimeFormat(locale(lang), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(toMs(s)));
const weekdayNames = (lang: string) => Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale(lang), { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + i))));
const tint = (hex: string, alpha: number) => {
  const h = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#f59e0b';
  const n = parseInt(h.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};
const covers = (s: Season, day: string) => s.days.some(d => d.start_date <= day && d.end_date >= day);
const appliesToVenue = (s: Season, venueId: string) => !venueId || !s.venue_ids || s.venue_ids.includes(venueId);

// Paste box: "2026-11-14", "14-11-2026", "2026-11-14 to 2026-11-18, note".
const DATE_TOKEN = String.raw`(\d{4}-\d{2}-\d{2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})`;
const PASTE_RE = new RegExp(`^\\s*${DATE_TOKEN}(?:\\s*(?:to|until|till|–|—|-)\\s*${DATE_TOKEN})?\\s*(?:[,;|]\\s*(.*))?$`, 'i');
const normDate = (tok: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) return tok;
  const m = tok.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
};
export function parseMahuratPaste(text: string): { days: Day[]; bad: string[] } {
  const days: Day[] = []; const bad: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(PASTE_RE);
    const a = m ? normDate(m[1]) : '';
    const b = m && m[2] ? normDate(m[2]) : a;
    if (!a || !b || isNaN(toMs(a)) || isNaN(toMs(b)) || b < a) { bad.push(line); continue; }
    days.push({ start_date: a, end_date: b, note: m && m[3] ? m[3].trim().slice(0, 120) : '' });
  }
  return { days, bad };
}

function useApi(restaurantId: string, token: string) {
  return async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`/api/restaurant/${restaurantId}${path}`, {
      ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { const e: any = new Error((b && b.error) || `HTTP ${r.status}`); e.status = r.status; e.data = b; throw e; }
    return b;
  };
}

// ════════════════════════════════════════════════════════════════════════
// Settings card (rendered inside Events → Public Page Settings)
// ════════════════════════════════════════════════════════════════════════
export function MahuratSettingsCard({ restaurantId, token, canEdit }: { restaurantId: string; token: string; canEdit: boolean }) {
  const { t } = useT();
  const api = useApi(restaurantId, token);
  const [enabled, setEnabled] = useState(false);
  const [title, setTitle] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [err, setErr] = useState('');
  useEffect(() => { api('/events/mahurat/settings').then((r: any) => { setEnabled(!!r.enabled); setTitle(r.title || ''); setLoaded(true); }).catch(() => setLoaded(true)); }, []);
  const save = async (next: { enabled: boolean; title: string }) => {
    if (!canEdit) return;
    setErr(''); setState('saving');
    try {
      const r = await api('/events/mahurat/settings', { method: 'PUT', body: JSON.stringify(next) });
      setEnabled(!!r.enabled); setTitle(r.title || '');
      // The nav entry follows restaurants.event_mahurat_enabled — refresh it.
      window.dispatchEvent(new Event('atithi:restaurant-changed'));
      setState('saved'); setTimeout(() => setState('idle'), 2000);
    } catch (e: any) { setErr(e.message); setState('idle'); }
  };
  if (!loaded) return null;
  return (
    <div className={`${CARD} mb-4`}>
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-[#faf7f2] border border-[#e8dccf] flex items-center justify-center text-brand shrink-0"><CalendarHeart size={18} /></div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-[#14110c]">{t('events.mahurat.settingsTitle')}</div>
          <p className="text-xs text-[#6b5d52] mt-0.5">{t('events.mahurat.settingsSub')}</p>
          <label className="flex items-center gap-2 mt-3 text-sm font-semibold text-[#3d3128]">
            <input type="checkbox" checked={enabled} disabled={!canEdit || state === 'saving'} onChange={e => save({ enabled: e.target.checked, title })} />
            {t('events.mahurat.enable')}
          </label>
          {enabled && (
            <div className="mt-3 flex flex-col sm:flex-row sm:items-end gap-2 max-w-xl">
              <div className="flex-1"><label className={LABEL}>{t('events.mahurat.titleLabel')}</label>
                <input className={INPUT} maxLength={40} value={title} disabled={!canEdit} placeholder={t('events.mahurat.titlePlaceholder')} onChange={e => setTitle(e.target.value)} /></div>
              {canEdit && <button className={BTN_PRIMARY} disabled={state === 'saving'} onClick={() => save({ enabled, title })}>{state === 'saving' ? t('common.saving') : t('common.save')}</button>}
            </div>
          )}
          {state === 'saved' && <div className="text-xs text-emerald-700 font-semibold mt-2">✓ {t('common.saved')}</div>}
          {err && <div className="text-xs text-rose-600 mt-2">{err}</div>}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// The page
// ════════════════════════════════════════════════════════════════════════
export function MahuratCalendar({ restaurantId, token }: { restaurantId: string; token: string }) {
  const { t, lang } = useT();
  const api = useApi(restaurantId, token);
  const confirm = useConfirm();
  const canEdit = canWriteTab('EVENTS_MAHURAT');
  const canDelete = canDeleteTab('EVENTS_MAHURAT');
  const today = todayIST();
  const [view, setView] = useState<'MONTH' | 'YEAR'>('MONTH');
  const [cursor, setCursor] = useState(monthStart(today));
  const [venue, setVenue] = useState('');
  const [feed, setFeed] = useState<any>(null);
  const [allSeasons, setAllSeasons] = useState<Season[]>([]);
  const [picked, setPicked] = useState<string>(today);
  const [editing, setEditing] = useState<Season | 'NEW' | null>(null);
  const [warning, setWarning] = useState<any[]>([]);
  const [error, setError] = useState('');

  const range = useMemo(() => view === 'MONTH'
    ? { from: addDays(monthStart(cursor), -monIndex(monthStart(cursor))), to: addDays(monthEnd(cursor), 6 - monIndex(monthEnd(cursor))) }
    : { from: cursor.slice(0, 4) + '-01-01', to: cursor.slice(0, 4) + '-12-31' }, [view, cursor]);

  const load = async () => {
    setError('');
    try {
      const [f, s] = await Promise.all([
        api(`/events/mahurat/calendar?from=${range.from}&to=${range.to}`),
        api('/events/mahurat/seasons'),
      ]);
      setFeed(f); setAllSeasons(Array.isArray(s) ? s : []);
    } catch (e: any) { setError(e.message); }
  };
  useEffect(() => { load(); }, [range.from, range.to]);

  const seasons: Season[] = feed?.seasons || [];
  const venues: any[] = feed?.venues || [];
  const bookings: any[] = feed?.bookings || [];
  const venueName = (id: string) => venues.find(v => String(v.id) === String(id))?.name || id;

  // Per-day summary for the visible range.
  const dayInfo = (day: string) => {
    const on = seasons.filter(s => covers(s, day) && appliesToVenue(s, venue));
    const highlights = on.filter(s => s.kind === 'HIGHLIGHT');
    const blocks = on.filter(s => s.kind === 'BLOCK');
    const fullBlock = blocks.some(s => !s.venue_ids || (venue && s.venue_ids.includes(venue)));
    const partBlock = !fullBlock && blocks.length > 0;
    const bks = bookings.filter(b => b.event_date <= day && (b.end_date || b.event_date) >= day && (!venue || String(b.venue_id) === venue));
    return { highlights, blocks, fullBlock, partBlock, bookings: bks, colour: (highlights[0] || blocks[0])?.color || null };
  };

  const title = feed?.settings?.title || t('events.mahurat.title');

  const remove = async (s: Season) => {
    if (!canDelete) return;
    const ok = await confirm({ title: t('events.mahurat.deleteTitle'), body: t('events.mahurat.deleteConfirm', { name: s.name }), confirmLabel: t('common.delete'), danger: true });
    if (!ok) return;
    try { await api(`/events/mahurat/seasons/${s.id}`, { method: 'DELETE' }); await load(); } catch (e: any) { alert(e.message); }
  };

  const nextDate = (s: Season) => {
    const d = s.days.filter(x => x.end_date >= today).sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
    return d ? (d.start_date < today ? today : d.start_date) : '';
  };

  const legend = (
    <div className="flex flex-wrap gap-2 mb-3">
      {allSeasons.map(s => (
        <span key={s.id} className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border border-[#e8dccf] bg-white">
          <span className="w-3 h-3 rounded-sm" style={{ background: s.kind === 'BLOCK' ? `repeating-linear-gradient(45deg, ${s.color}, ${s.color} 3px, ${tint(s.color, 0.25)} 3px, ${tint(s.color, 0.25)} 6px)` : s.color }} />
          {s.kind === 'BLOCK' && <Lock size={10} />}{s.name}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border border-[#e8dccf] bg-white">
        <span className="w-2 h-2 rounded-full" style={{ background: STATUS_COLORS.CONFIRMED }} />{t('events.mahurat.bookingDot')}
      </span>
    </div>
  );

  const monthGrid = () => {
    const cells: string[] = [];
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) cells.push(d);
    return (
      <div className="overflow-x-auto">
        <div className="grid grid-cols-7 gap-1 min-w-[560px]">
          {weekdayNames(lang).map(w => <div key={w} className="text-[11px] font-bold text-[#9d8b7e] uppercase tracking-wide text-center py-1">{w}</div>)}
          {cells.map(day => {
            const info = dayInfo(day);
            const inMonth = day.slice(0, 7) === cursor.slice(0, 7);
            const bg = info.fullBlock && info.colour
              ? `repeating-linear-gradient(45deg, ${tint(info.colour, 0.28)}, ${tint(info.colour, 0.28)} 6px, ${tint(info.colour, 0.1)} 6px, ${tint(info.colour, 0.1)} 12px)`
              : info.colour ? tint(info.colour, 0.2) : '#fff';
            return (
              <button key={day} type="button" onClick={() => setPicked(day)}
                className={`text-left rounded-xl border p-1.5 min-h-[88px] flex flex-col gap-1 transition-shadow hover:shadow ${picked === day ? 'ring-2 ring-brand' : ''} ${inMonth ? '' : 'opacity-45'}`}
                style={{ background: bg, borderColor: day === today ? '#b34f12' : '#e8dccf' }}>
                <div className="flex items-center justify-between">
                  <span className={`text-xs font-bold ${day === today ? 'text-brand' : 'text-[#3d3128]'}`}>{Number(day.slice(8))}</span>
                  {info.fullBlock && <Lock size={11} className="text-[#7f1d1d]" />}
                  {info.partBlock && <Lock size={11} className="text-[#b45309] opacity-70" />}
                </div>
                {(info.highlights[0] || info.blocks[0]) && (
                  <div className="text-[10px] font-semibold leading-tight truncate" style={{ color: '#3d3128' }}>{(info.highlights[0] || info.blocks[0]).name}</div>
                )}
                {info.fullBlock && <div className="text-[10px] font-bold text-[#7f1d1d]">{t('events.mahurat.blocked')}</div>}
                {info.partBlock && <div className="text-[10px] font-semibold text-[#b45309]">{t('events.mahurat.partBlocked')}</div>}
                <div className="mt-auto flex flex-col gap-0.5">
                  {info.bookings.slice(0, 2).map(b => (
                    <span key={b.id} className="text-[10px] leading-tight truncate px-1 py-0.5 rounded bg-white/85 border-l-2" style={{ borderColor: STATUS_COLORS[b.status] || '#9ca3af' }}>{b.customer_name}</span>
                  ))}
                  {info.bookings.length > 2 && <span className="text-[10px] text-[#6b5d52] font-semibold">+{info.bookings.length - 2}</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const yearGrid = () => {
    const year = cursor.slice(0, 4);
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {Array.from({ length: 12 }, (_, m) => {
          const ms = `${year}-${String(m + 1).padStart(2, '0')}-01`;
          const me = monthEnd(ms);
          const days: (string | null)[] = Array(monIndex(ms)).fill(null);
          for (let d = ms; d <= me; d = addDays(d, 1)) days.push(d);
          return (
            <div key={ms} className="border border-[#e8dccf] rounded-xl p-2 bg-white">
              <button type="button" className="text-xs font-bold text-[#3d3128] mb-1 hover:text-brand" onClick={() => { setCursor(ms); setView('MONTH'); }}>{fmtMonth(ms, lang)}</button>
              <div className="grid grid-cols-7 gap-0.5">
                {weekdayNames(lang).map(w => <div key={w} className="text-[9px] text-center text-[#9d8b7e]">{w.slice(0, 2)}</div>)}
                {days.map((day, i) => {
                  if (!day) return <div key={`b${i}`} />;
                  const info = dayInfo(day);
                  const bg = info.fullBlock && info.colour
                    ? `repeating-linear-gradient(45deg, ${tint(info.colour, 0.45)}, ${tint(info.colour, 0.45)} 2px, ${tint(info.colour, 0.12)} 2px, ${tint(info.colour, 0.12)} 4px)`
                    : info.colour ? tint(info.colour, 0.35) : 'transparent';
                  return (
                    <button key={day} type="button" title={[...info.highlights, ...info.blocks].map(s => s.name).join(', ')}
                      onClick={() => setPicked(day)}
                      className={`relative h-6 rounded text-[10px] ${picked === day ? 'ring-1 ring-brand' : ''} ${day === today ? 'font-bold text-brand' : 'text-[#3d3128]'}`}
                      style={{ background: bg }}>
                      {Number(day.slice(8))}
                      {info.bookings.length > 0 && <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full" style={{ background: STATUS_COLORS[info.bookings[0].status] || '#15803d' }} />}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const pickedInfo = picked >= range.from && picked <= range.to ? dayInfo(picked) : null;
  const dayPanel = (
    <div className={`${CARD} lg:sticky lg:top-4`}>
      <div className="text-sm font-bold text-[#14110c]">{fmtDay(picked, lang)}</div>
      {!pickedInfo ? <p className="text-xs text-[#6b5d52] mt-2">{t('events.mahurat.pickDay')}</p> : (
        <div className="mt-2 space-y-3">
          <div>
            <div className={LABEL}>{t('events.mahurat.seasons')}</div>
            {[...pickedInfo.highlights, ...pickedInfo.blocks].length === 0 ? <p className="text-xs text-[#9d8b7e]">{t('events.mahurat.noSeasonsDay')}</p> : (
              <div className="space-y-1.5">
                {[...pickedInfo.highlights, ...pickedInfo.blocks].map(s => {
                  const note = s.days.find(d => d.start_date <= picked && d.end_date >= picked)?.note;
                  return (
                    <div key={s.id} className="flex items-start gap-2 text-xs">
                      <span className="w-3 h-3 rounded-sm mt-0.5 shrink-0" style={{ background: s.color }} />
                      <div>
                        <div className="font-semibold text-[#3d3128] flex items-center gap-1">{s.kind === 'BLOCK' ? <Lock size={10} /> : <Sparkles size={10} />}{s.name}</div>
                        <div className="text-[#6b5d52]">{s.kind === 'BLOCK' ? t('events.mahurat.blockedFor', { venues: s.venue_ids ? s.venue_ids.map(venueName).join(', ') : t('events.mahurat.venuesAll') }) : t('events.mahurat.kindHighlightShort')}</div>
                        {note && <div className="text-[#9d8b7e] italic">{note}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div>
            <div className={LABEL}>{t('events.mahurat.bookingsN', { n: pickedInfo.bookings.length })}</div>
            {pickedInfo.bookings.length === 0 ? <p className="text-xs text-[#9d8b7e]">{t('events.mahurat.noBookings')}</p> : (
              <div className="space-y-1.5">
                {pickedInfo.bookings.map(b => (
                  <div key={b.id} className="text-xs border-l-4 pl-2 py-0.5" style={{ borderColor: STATUS_COLORS[b.status] || '#9ca3af' }}>
                    <div className="font-semibold text-[#3d3128]">{b.customer_name}</div>
                    <div className="text-[#6b5d52]">{[b.event_type, b.venue_name || (b.venue_id ? venueName(b.venue_id) : ''), b.status, b.guest_count ? `${b.guest_count} ${t('events.mahurat.guests')}` : ''].filter(Boolean).join(' · ')}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );

  if (feed && feed.settings && !feed.settings.enabled) {
    return <div className={CARD}><p className="text-sm text-[#6b5d52]">{t('events.mahurat.disabledNote')}</p></div>;
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-[#faf7f2] border border-[#e8dccf] flex items-center justify-center text-brand"><CalendarHeart size={18} /></div>
          <div>
            <h2 className="text-2xl font-bold font-serif text-[#14110c]">{title}</h2>
            <p className="text-xs text-[#6b5d52]">{t('events.mahurat.sub')}</p>
          </div>
        </div>
        {canEdit && <button className={BTN_PRIMARY} onClick={() => setEditing('NEW')}><Plus size={13} />{t('events.mahurat.newSeason')}</button>}
      </div>

      {error && <div className="mb-3 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">{error}</div>}
      {warning.length > 0 && (
        <div className="mb-3 text-sm bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2"><AlertTriangle size={15} className="text-amber-600 mt-0.5 shrink-0" />
              <div><div className="font-semibold text-amber-900">{t('events.mahurat.warnBookings')}</div>
                <ul className="mt-1 text-xs text-amber-900 list-disc pl-4">{warning.map(b => <li key={b.id}>{b.customer_name} · {b.venue_name || ''} · {b.event_date} · {b.status}</li>)}</ul></div></div>
            <button className="text-amber-700" onClick={() => setWarning([])}><X size={14} /></button>
          </div>
        </div>
      )}

      <div className={`${CARD} mb-4`}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <button className={BTN_GHOST} aria-label={t('events.mahurat.prev')} onClick={() => setCursor(view === 'MONTH' ? shiftMonth(cursor, -1) : `${Number(cursor.slice(0, 4)) - 1}-01-01`)}><ChevronLeft size={14} /></button>
          <div className="text-base font-bold text-[#14110c] min-w-[10rem] text-center">{view === 'MONTH' ? fmtMonth(cursor, lang) : cursor.slice(0, 4)}</div>
          <button className={BTN_GHOST} aria-label={t('events.mahurat.next')} onClick={() => setCursor(view === 'MONTH' ? shiftMonth(cursor, 1) : `${Number(cursor.slice(0, 4)) + 1}-01-01`)}><ChevronRight size={14} /></button>
          <button className={BTN_GHOST} onClick={() => { setCursor(monthStart(today)); setPicked(today); }}>{t('events.mahurat.today')}</button>
          <div className="flex rounded-xl border border-[#e8dccf] overflow-hidden ml-auto">
            {(['MONTH', 'YEAR'] as const).map(v => (
              <button key={v} className={`px-3 py-1.5 text-xs font-bold ${view === v ? 'bg-brand text-white' : 'bg-white text-[#3d3128]'}`} onClick={() => setView(v)}>{v === 'MONTH' ? t('events.mahurat.month') : t('events.mahurat.year')}</button>
            ))}
          </div>
          <select className={`${INPUT} w-auto`} value={venue} onChange={e => setVenue(e.target.value)}>
            <option value="">{t('events.mahurat.allVenues')}</option>
            {venues.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
        {legend}
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_18rem] gap-4 items-start">
          <div>{!feed ? <p className="text-sm text-[#6b5d52]">{t('common.loading')}</p> : view === 'MONTH' ? monthGrid() : yearGrid()}</div>
          {dayPanel}
        </div>
      </div>

      <div className={CARD}>
        <div className="font-bold text-[#14110c] mb-3">{t('events.mahurat.seasons')}</div>
        <DataTable
          data={allSeasons}
          rowKey={(r: Season) => r.id}
          columnChooser columnFilters tableId="events-mahurat-seasons" exportFilename="mahurat-seasons"
          emptyMessage={t('events.mahurat.noSeasons')}
          columns={[
            { key: 'name', label: t('events.mahurat.colName'), sortable: true, searchable: true,
              render: (r: Season) => <span className="inline-flex items-center gap-2"><span className="w-3 h-3 rounded-sm" style={{ background: r.color }} />{r.name}</span> },
            { key: 'kind', label: t('events.mahurat.colKind'), sortable: true, filterable: true, filterType: 'select',
              filterOptions: [{ value: 'HIGHLIGHT', label: t('events.mahurat.kindHighlightShort') }, { value: 'BLOCK', label: t('events.mahurat.blocked') }],
              render: (r: Season) => r.kind === 'BLOCK' ? <span className="inline-flex items-center gap-1 text-rose-700 font-semibold"><Lock size={11} />{t('events.mahurat.blocked')}</span> : t('events.mahurat.kindHighlightShort'),
              exportValue: (r: Season) => r.kind },
            { key: 'venues', label: t('events.mahurat.colVenues'), getValue: (r: Season) => r.venue_ids ? r.venue_ids.map(venueName).join(', ') : t('events.mahurat.venuesAll') },
            { key: 'dates', label: t('events.mahurat.colDates'), sortable: true, align: 'right', getValue: (r: Season) => r.days.length },
            { key: 'next', label: t('events.mahurat.colNext'), sortable: true, getValue: (r: Season) => nextDate(r), render: (r: Season) => nextDate(r) ? fmtDay(nextDate(r), lang) : '—' },
            { key: 'show_public', label: t('events.mahurat.colPublic'), sortable: true, hideable: true, getValue: (r: Season) => r.show_public ? t('events.mahurat.yes') : t('events.mahurat.no') },
            { key: 'notes', label: t('events.mahurat.notes'), hideable: true, defaultHidden: true, getValue: (r: Season) => r.notes || '' },
            { key: 'actions', label: '', render: (r: Season) => (
              <div className="flex gap-1 justify-end">
                {canEdit ? <button className={BTN_GHOST} onClick={() => setEditing(r)} aria-label={t('common.edit')}><Pencil size={12} /></button> : <span className="text-[11px] text-[#9d8b7e]">{t('events.mahurat.viewOnly')}</span>}
                {canDelete && <button className={BTN_GHOST} onClick={() => remove(r)} aria-label={t('common.delete')}><Trash2 size={12} /></button>}
              </div>
            ) },
          ] as any}
        />
      </div>

      {editing && (
        <SeasonEditor
          season={editing === 'NEW' ? null : editing} venues={venues}
          onClose={() => setEditing(null)}
          onSave={async (body: any) => {
            const isNew = editing === 'NEW';
            const r = await api(isNew ? '/events/mahurat/seasons' : `/events/mahurat/seasons/${(editing as Season).id}`, { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(body) });
            setEditing(null);
            setWarning(Array.isArray(r?.bookings_on_blocked_days) ? r.bookings_on_blocked_days : []);
            await load();
          }}
        />
      )}
    </div>
  );
}

function SeasonEditor({ season, venues, onClose, onSave }: { season: Season | null; venues: any[]; onClose: () => void; onSave: (body: any) => Promise<void> }) {
  const { t } = useT();
  const [name, setName] = useState(season?.name || '');
  const [color, setColor] = useState(season?.color || PRESET_COLORS[0]);
  const [kind, setKind] = useState<'HIGHLIGHT' | 'BLOCK'>(season?.kind || 'HIGHLIGHT');
  const [allVenues, setAllVenues] = useState(!season?.venue_ids);
  const [venueIds, setVenueIds] = useState<string[]>(season?.venue_ids || []);
  const [showPublic, setShowPublic] = useState(season ? season.show_public : true);
  const [notes, setNotes] = useState(season?.notes || '');
  const [days, setDays] = useState<Day[]>(season?.days?.length ? season.days.map(d => ({ ...d, note: d.note || '' })) : [{ start_date: '', end_date: '', note: '' }]);
  const [paste, setPaste] = useState('');
  const [pasteMsg, setPasteMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const applyPaste = () => {
    const { days: got, bad } = parseMahuratPaste(paste);
    const kept = days.filter(d => d.start_date);
    setDays([...kept, ...got].length ? [...kept, ...got] : [{ start_date: '', end_date: '', note: '' }]);
    setPasteMsg(bad.length ? t('events.mahurat.pasteBad', { lines: bad.slice(0, 5).join(' · ') }) : '');
    if (!bad.length) setPaste('');
  };
  const submit = async () => {
    setErr('');
    const clean = days.filter(d => d.start_date).map(d => ({ start_date: d.start_date, end_date: d.end_date || d.start_date, note: (d.note || '').trim() || null }));
    if (!name.trim()) { setErr(t('events.mahurat.needName')); return; }
    if (!clean.length) { setErr(t('events.mahurat.needDates')); return; }
    if (!allVenues && !venueIds.length) { setErr(t('events.mahurat.needVenue')); return; }
    setBusy(true);
    try {
      await onSave({ name: name.trim(), color, kind, venue_ids: allVenues ? null : venueIds, show_public: showPublic, notes: notes.trim() || null, days: clean });
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-2xl my-8 p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="text-lg font-bold text-[#14110c]">{season ? t('events.mahurat.editSeason') : t('events.mahurat.newSeason')}</div>
          <button onClick={onClose} className="text-[#6b5d52]" aria-label={t('common.close')}><X size={18} /></button>
        </div>
        <div className="space-y-4">
          <div><label className={LABEL}>{t('events.mahurat.name')}</label>
            <input className={INPUT} maxLength={80} value={name} placeholder={t('events.mahurat.namePlaceholder')} onChange={e => setName(e.target.value)} /></div>
          <div><label className={LABEL}>{t('events.mahurat.color')}</label>
            <div className="flex flex-wrap items-center gap-2">
              {PRESET_COLORS.map(c => <button key={c} type="button" onClick={() => setColor(c)} className={`w-7 h-7 rounded-full border-2 ${color === c ? 'border-[#14110c]' : 'border-white'} shadow`} style={{ background: c }} aria-label={c} />)}
              <input type="color" value={color} onChange={e => setColor(e.target.value)} className="w-9 h-7 rounded cursor-pointer" />
            </div></div>
          <div><label className={LABEL}>{t('events.mahurat.kind')}</label>
            <div className="grid sm:grid-cols-2 gap-2">
              {(['HIGHLIGHT', 'BLOCK'] as const).map(k => (
                <label key={k} className={`flex items-start gap-2 p-3 rounded-xl border cursor-pointer text-sm ${kind === k ? 'border-brand bg-[#faf7f2]' : 'border-[#e8dccf]'}`}>
                  <input type="radio" checked={kind === k} onChange={() => setKind(k)} className="mt-0.5" />
                  <span>{k === 'HIGHLIGHT' ? t('events.mahurat.kindHighlight') : t('events.mahurat.kindBlock')}</span>
                </label>
              ))}
            </div></div>
          <div><label className={LABEL}>{t('events.mahurat.venues')}</label>
            <div className="flex gap-4 text-sm mb-2">
              <label className="flex items-center gap-1.5"><input type="radio" checked={allVenues} onChange={() => setAllVenues(true)} />{t('events.mahurat.venuesAll')}</label>
              <label className="flex items-center gap-1.5"><input type="radio" checked={!allVenues} onChange={() => setAllVenues(false)} />{t('events.mahurat.venuesSome')}</label>
            </div>
            {!allVenues && (
              <div className="flex flex-wrap gap-2">
                {venues.map(v => (
                  <label key={v.id} className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border border-[#e8dccf]">
                    <input type="checkbox" checked={venueIds.includes(String(v.id))} onChange={e => setVenueIds(e.target.checked ? [...venueIds, String(v.id)] : venueIds.filter(x => x !== String(v.id)))} />{v.name}
                  </label>
                ))}
              </div>
            )}</div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showPublic} onChange={e => setShowPublic(e.target.checked)} />{t('events.mahurat.showPublic')}</label>
          <div>
            <label className={LABEL}>{t('events.mahurat.dates')}</label>
            <div className="space-y-2">
              {days.map((d, i) => (
                <div key={i} className="grid grid-cols-2 sm:grid-cols-[1fr_1fr_1.4fr_auto] gap-2 items-center">
                  <input type="date" className={INPUT} value={d.start_date} aria-label={t('events.mahurat.from')} onChange={e => setDays(days.map((x, j) => j === i ? { ...x, start_date: e.target.value, end_date: x.end_date && x.end_date >= e.target.value ? x.end_date : e.target.value } : x))} />
                  <input type="date" className={INPUT} value={d.end_date} min={d.start_date} aria-label={t('events.mahurat.to')} onChange={e => setDays(days.map((x, j) => j === i ? { ...x, end_date: e.target.value } : x))} />
                  <input className={INPUT} value={d.note || ''} maxLength={120} placeholder={t('events.mahurat.note')} onChange={e => setDays(days.map((x, j) => j === i ? { ...x, note: e.target.value } : x))} />
                  <button type="button" className="justify-self-start text-[#9d8b7e] hover:text-rose-600" aria-label={t('common.delete')} onClick={() => setDays(days.length > 1 ? days.filter((_, j) => j !== i) : [{ start_date: '', end_date: '', note: '' }])}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
            <button type="button" className={`${BTN_GHOST} mt-2`} onClick={() => setDays([...days, { start_date: '', end_date: '', note: '' }])}><Plus size={12} />{t('events.mahurat.addDate')}</button>
            <details className="mt-3">
              <summary className="text-xs font-semibold text-brand cursor-pointer">{t('events.mahurat.paste')}</summary>
              <p className="text-[11px] text-[#6b5d52] mt-1">{t('events.mahurat.pasteHint')}</p>
              <textarea className={`${INPUT} mt-1 font-mono text-xs`} rows={5} value={paste} onChange={e => setPaste(e.target.value)} placeholder={'2026-11-14, Dev Uthani\n2026-11-20 to 2026-11-24\n05-12-2026'} />
              <button type="button" className={`${BTN_GHOST} mt-1`} disabled={!paste.trim()} onClick={applyPaste}>{t('events.mahurat.pasteApply')}</button>
              {pasteMsg && <p className="text-[11px] text-rose-600 mt-1">{pasteMsg}</p>}
            </details>
          </div>
          <div><label className={LABEL}>{t('events.mahurat.notes')}</label>
            <textarea className={INPUT} rows={2} maxLength={500} value={notes} onChange={e => setNotes(e.target.value)} /></div>
          {err && <div className="text-sm text-rose-700">{err}</div>}
          <div className="flex justify-end gap-2">
            <button className={BTN_GHOST} onClick={onClose}>{t('common.cancel')}</button>
            <button className={BTN_PRIMARY} disabled={busy} onClick={submit}>{busy ? t('common.saving') : t('common.save')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Public events page: the chosen date's season + upcoming special dates.
// Only rendered when the server sent `mahurat` (feature on, public seasons).
// ════════════════════════════════════════════════════════════════════════
export function publicMahuratBlock(m: any, venueId: string, date: string): any | null {
  if (!m || !date) return null;
  return (m.seasons || []).find((s: any) => s.kind === 'BLOCK' && covers(s, date)
    && (!s.venue_ids || (venueId && s.venue_ids.includes(String(venueId))))) || null;
}

export function PublicMahuratHint({ mahurat, venueId, date, onPick }: { mahurat: any; venueId: string; date: string; onPick: (d: string) => void }) {
  const { t, lang } = useT();
  if (!mahurat || !Array.isArray(mahurat.seasons) || !mahurat.seasons.length) return null;
  const today = todayIST();
  const blocked = publicMahuratBlock(mahurat, venueId, date);
  const onDate = date ? mahurat.seasons.filter((s: any) => s.kind === 'HIGHLIGHT' && covers(s, date)) : [];
  const upcoming: { date: string; end: string; season: any; note: string }[] = [];
  for (const s of mahurat.seasons) {
    if (s.kind !== 'HIGHLIGHT') continue;
    for (const d of s.days || []) {
      if (d.end_date < today) continue;
      upcoming.push({ date: d.start_date < today ? today : d.start_date, end: d.end_date, season: s, note: d.note || '' });
    }
  }
  upcoming.sort((a, b) => a.date.localeCompare(b.date));
  const fmt = (s: string) => `${Number(s.slice(8))} ${fmtShortMonth(s, lang)}`;
  return (
    <div style={{ gridColumn: '1 / -1', fontSize: 13 }}>
      {blocked && <div style={{ color: '#b91c1c', fontWeight: 600, marginBottom: 6 }}>{t('events.mahurat.publicUnavailable')}</div>}
      {!blocked && onDate.length > 0 && (
        <div style={{ color: '#3d3128', marginBottom: 6 }}>
          <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: onDate[0].color, marginRight: 6 }} />
          {t('events.mahurat.publicSeason', { season: onDate.map((s: any) => s.name).join(', ') })}
        </div>
      )}
      {upcoming.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#6b5d52', marginBottom: 6 }}>{mahurat.title || t('events.mahurat.publicUpcoming')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {upcoming.slice(0, 10).map((u, i) => (
              <button key={i} type="button" onClick={() => onPick(u.date)} title={u.note || u.season.name}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 999, border: `1px solid ${tint(u.season.color, 0.6)}`, background: tint(u.season.color, date === u.date ? 0.35 : 0.12), fontSize: 12, color: '#3d3128', cursor: 'pointer' }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: u.season.color }} />
                {u.end > u.date ? `${fmt(u.date)} – ${fmt(u.end)}` : fmt(u.date)} · {u.season.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
