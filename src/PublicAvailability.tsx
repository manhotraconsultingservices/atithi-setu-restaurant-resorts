// ════════════════════════════════════════════════════════════════════════
// Public venue availability (Events, opt-in per property).
// A calendar on the public events page showing, per venue and day (per session
// where the hall sells sessions), Available / On hold / Booked / Closed. The
// server decides every status and sends no booking detail. Tapping an available
// day fills the venue, date and session into the enquiry form.
// ════════════════════════════════════════════════════════════════════════
import React, { useEffect, useState } from 'react';
import { useT } from './i18n';
import { todayIST } from './lib/utils';
import { CalendarCheck } from 'lucide-react';

const CARD = 'bg-white rounded-2xl border border-[#e8dccf] p-5';

// ── Settings card (Events → Public Page Settings) ──────────────────────────
export function PublicAvailabilitySettingsCard({ restaurantId, token, canEdit }: { restaurantId: string; token: string; canEdit: boolean }) {
  const { t } = useT();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const url = `/api/restaurant/${restaurantId}/events/public-availability/settings`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  useEffect(() => { fetch(url, { headers }).then(r => r.ok ? r.json() : null).then(r => setEnabled(!!r?.enabled)).catch(() => setEnabled(false)); }, []);
  const save = async (next: boolean) => {
    if (!canEdit) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ enabled: next }) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
      setEnabled(!!b.enabled); setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  if (enabled === null) return null;
  return (
    <div className={`${CARD} mb-4`}>
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-[#faf7f2] border border-[#e8dccf] flex items-center justify-center text-brand shrink-0"><CalendarCheck size={18} /></div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-[#14110c]">{t('events.avail.settingsTitle')}</div>
          <p className="text-xs text-[#6b5d52] mt-0.5">{t('events.avail.settingsSub')}</p>
          <label className="flex items-center gap-2 mt-3 text-sm font-semibold text-[#3d3128]">
            <input type="checkbox" checked={enabled} disabled={!canEdit || busy} onChange={e => save(e.target.checked)} />
            {t('events.avail.enable')}
          </label>
          {saved && <div className="text-xs text-emerald-700 font-semibold mt-2">✓ {t('common.saved')}</div>}
          {err && <div className="text-xs text-rose-600 mt-2">{err}</div>}
        </div>
      </div>
    </div>
  );
}

// ── Public calendar ────────────────────────────────────────────────────────
type Slot = 'FREE' | 'HOLD' | 'BOOKED' | 'CLOSED';
const TONE: Record<Slot, { bg: string; border: string; fg: string }> = {
  FREE: { bg: '#ecfdf5', border: '#a7f3d0', fg: '#047857' },
  HOLD: { bg: '#fffbeb', border: '#fcd34d', fg: '#b45309' },
  BOOKED: { bg: '#fef2f2', border: '#fecaca', fg: '#b91c1c' },
  CLOSED: { bg: '#f3f4f6', border: '#e5e7eb', fg: '#6b7280' },
};
const DAY_MS = 86400000;
const toMs = (s: string) => Date.parse(s + 'T00:00:00Z');
const fromMs = (n: number) => new Date(n).toISOString().slice(0, 10);
const addDays = (s: string, n: number) => fromMs(toMs(s) + n * DAY_MS);
const monthStart = (s: string) => s.slice(0, 8) + '01';
const shiftMonth = (s: string, n: number) => { const d = new Date(toMs(monthStart(s))); d.setUTCMonth(d.getUTCMonth() + n); return fromMs(d.getTime()); };
const monthEnd = (s: string) => fromMs(toMs(shiftMonth(s, 1)) - DAY_MS);
const monIndex = (s: string) => (new Date(toMs(s)).getUTCDay() + 6) % 7;
const locale = (lang: string) => (lang && lang !== 'en' ? lang : 'en-IN');

export function PublicAvailabilityCalendar({ tenantId, mahurat, onPick }: {
  tenantId: string; mahurat?: any;
  onPick: (venueId: string, date: string, session: 'AM' | 'PM' | null) => void;
}) {
  const { t, lang } = useT();
  const today = todayIST();
  const [month, setMonth] = useState(monthStart(today));
  const [data, setData] = useState<any>(null);
  const [venueId, setVenueId] = useState('');
  const [err, setErr] = useState(false);
  const maxMonth = shiftMonth(monthStart(today), 5);

  useEffect(() => {
    let dead = false;
    const from = month < today ? today : month;
    fetch(`/api/public/restaurant/${encodeURIComponent(tenantId)}/events/availability?from=${from}&to=${monthEnd(month)}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => { if (dead) return; setData(d); setErr(false); if (!venueId && d.venues?.[0]) setVenueId(d.venues[0].id); })
      .catch(() => { if (!dead) setErr(true); });
    return () => { dead = true; };
  }, [tenantId, month]);

  if (err && !data) return null;
  const venue = (data?.venues || []).find((v: any) => v.id === venueId) || data?.venues?.[0];
  const highlightOn = (day: string) => (mahurat?.seasons || []).find((s: any) => s.kind === 'HIGHLIGHT'
    && (s.days || []).some((d: any) => d.start_date <= day && d.end_date >= day));
  const cells: (string | null)[] = Array(monIndex(month)).fill(null);
  for (let d = month; d <= monthEnd(month); d = addDays(d, 1)) cells.push(d);
  const weekdays = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale(lang), { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + i))));
  const label: Record<Slot, string> = { FREE: t('events.avail.free'), HOLD: t('events.avail.hold'), BOOKED: t('events.avail.booked'), CLOSED: t('events.avail.closed') };
  const btn = (disabled: boolean): React.CSSProperties => ({ padding: '6px 12px', borderRadius: 10, border: '1px solid #e8dccf', background: disabled ? '#f5f5f4' : '#fff', color: disabled ? '#a8a29e' : '#3d3128', cursor: disabled ? 'default' : 'pointer', fontWeight: 700 });

  const half = (day: string, s: Slot, session: 'AM' | 'PM', text: string) => (
    <button key={session} type="button" disabled={s !== 'FREE'} onClick={() => onPick(venue.id, day, session)} title={`${text}: ${label[s]}`}
      style={{ flex: 1, border: 'none', borderRadius: 6, background: TONE[s].bg, color: TONE[s].fg, fontSize: 10, fontWeight: 700, cursor: s === 'FREE' ? 'pointer' : 'default', padding: '2px 0' }}>
      {text.slice(0, 1)}
    </button>
  );

  return (
    <div id="availability" style={{ background: '#fff', border: '1px solid #ece3d7', borderRadius: 22, padding: 24, margin: '20px 0', boxShadow: '0 4px 20px rgba(20,17,12,0.06)' }}>
      <h2 style={{ fontSize: 22, fontWeight: 800, marginBottom: 4 }}>{t('events.avail.title')}</h2>
      <p style={{ fontSize: 14, color: '#6b5d52', marginBottom: 14 }}>{t('events.avail.sub')}</p>
      {!data ? <div style={{ fontSize: 13, color: '#6b5d52' }}>{t('common.loading')}</div> : !venue ? null : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {data.venues.map((v: any) => (
              <button key={v.id} type="button" onClick={() => setVenueId(v.id)}
                style={{ padding: '6px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: `1px solid ${v.id === venue.id ? '#3d3128' : '#e8dccf'}`, background: v.id === venue.id ? '#3d3128' : '#fff', color: v.id === venue.id ? '#fff' : '#3d3128' }}>
                {v.name}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <button type="button" style={btn(month <= monthStart(today))} disabled={month <= monthStart(today)} onClick={() => setMonth(shiftMonth(month, -1))} aria-label={t('events.mahurat.prev')}>‹</button>
            <div style={{ fontWeight: 800 }}>{new Intl.DateTimeFormat(locale(lang), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(toMs(month)))}</div>
            <button type="button" style={btn(month >= maxMonth)} disabled={month >= maxMonth} onClick={() => setMonth(shiftMonth(month, 1))} aria-label={t('events.mahurat.next')}>›</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 }}>
            {weekdays.map(w => <div key={w} style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, color: '#9d8b7e', textTransform: 'uppercase' }}>{w}</div>)}
            {cells.map((day, i) => {
              if (!day) return <div key={`b${i}`} />;
              const past = day < today;
              const info = venue.days?.[day];
              const hl = highlightOn(day);
              const day1: Slot = past ? 'CLOSED' : (info?.s && info.s !== 'PARTIAL' ? info.s : 'FREE');
              const tone = TONE[past ? 'CLOSED' : (info?.s === 'PARTIAL' ? 'FREE' : day1)];
              return (
                <div key={day} style={{ position: 'relative', minHeight: 54, borderRadius: 10, border: `1px solid ${tone.border}`, background: past ? '#fafaf9' : tone.bg, opacity: past ? 0.5 : 1, padding: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {hl && !past && <span title={hl.name} style={{ position: 'absolute', top: 4, right: 4, width: 7, height: 7, borderRadius: 999, background: hl.color }} />}
                  {!past && !venue.sessions && day1 === 'FREE' ? (
                    <button type="button" onClick={() => onPick(venue.id, day, null)} style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexDirection: 'column', height: '100%' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#3d3128' }}>{Number(day.slice(8))}</span>
                    </button>
                  ) : (
                    <span style={{ fontSize: 12, fontWeight: 700, color: past ? '#a8a29e' : '#3d3128' }}>{Number(day.slice(8))}</span>
                  )}
                  {!past && !venue.sessions && day1 !== 'FREE' && <span style={{ fontSize: 9, fontWeight: 700, color: tone.fg, lineHeight: 1.1 }}>{label[day1]}</span>}
                  {!past && venue.sessions && (
                    <div style={{ display: 'flex', gap: 2, marginTop: 'auto' }}>
                      {half(day, (info?.am || 'FREE') as Slot, 'AM', t('events.avail.morning'))}
                      {half(day, (info?.pm || 'FREE') as Slot, 'PM', t('events.avail.evening'))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12, fontSize: 12, color: '#6b5d52' }}>
            {(['FREE', 'HOLD', 'BOOKED', 'CLOSED'] as Slot[]).map(s => (
              <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: TONE[s].bg, border: `1px solid ${TONE[s].border}` }} />{label[s]}
              </span>
            ))}
            {venue.sessions && venue.am && venue.pm && (
              <span>{t('events.avail.sessionsKey', { am: `${venue.am.start}–${venue.am.end}`, pm: `${venue.pm.start}–${venue.pm.end}` })}</span>
            )}
          </div>
          <p style={{ fontSize: 12, color: '#9d8b7e', marginTop: 8 }}>{t('events.avail.tapHint')}</p>
        </>
      )}
    </div>
  );
}
