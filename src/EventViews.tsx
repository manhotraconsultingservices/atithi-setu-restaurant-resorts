// ════════════════════════════════════════════════════════════════════════
// Events & Convention Center — frontend views (gated by events_enabled).
// Mirrors the Spa module's structure: <EventsModule tab=… /> dispatches to the
// right sub-view; the public inquiry page is exported separately. Strings run
// through the i18n t() so the whole module is translatable.
// ════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useRef } from 'react';
import { DataTable } from './components/DataTable';
import { ObjectDetail } from './components/ObjectDetail';
import { useT, LANGUAGE_NAMES, SECONDARY_LANGUAGE_OPTIONS } from './i18n';
import {
  CalendarRange, Plus, Trash2, Check, X, Building2, Sofa, Users, FileText,
  RefreshCw, Send, IndianRupee, ClipboardList, Hotel, Utensils,
  AlertTriangle, Mail, Phone, Upload, Image as ImageIcon,
} from 'lucide-react';

// ── Image upload (public-page pictures) — mirrors the Hotel upload flow so an
// events-only tenant can add photos by file, not just paste a URL. ──────────
async function uploadEventImage(restaurantId: string, token: string, file: File): Promise<string> {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch(`/api/restaurant/${restaurantId}/events/upload-image`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'Upload failed'); }
  const { url } = await r.json();
  if (!url) throw new Error('Upload returned no URL');
  return url;
}

// A single image slot: preview + upload button + remove, with an optional
// "paste a URL instead" fallback. Used for the hero image and venue photos.
function SingleImagePicker({ restaurantId, token, value, onChange, allowUrl = true, aspect = 'h-24 w-full max-w-md' }: { restaurantId: string; token: string; value: string; onChange: (url: string) => void; allowUrl?: boolean; aspect?: string }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const pick = async (f?: File) => {
    if (!f) return; setBusy(true);
    try { onChange(await uploadEventImage(restaurantId, token, f)); } catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };
  return (
    <div>
      <div className="flex items-start gap-3 flex-wrap">
        {value
          ? <img src={value} alt="" className={`${aspect} object-cover rounded-xl border border-[#e8dccf]`} />
          : <div className={`${aspect} rounded-xl border border-dashed border-[#d9cbbb] bg-[#faf7f2] grid place-items-center text-[#b9a897]`}><ImageIcon size={22} /></div>}
        <div className="flex flex-col gap-1.5">
          <input ref={ref} type="file" accept="image/*" className="hidden" onChange={e => { pick(e.target.files?.[0]); e.currentTarget.value = ''; }} />
          <button type="button" className={BTN_GHOST} disabled={busy} onClick={() => ref.current?.click()}><Upload size={13} />{busy ? '…' : t('events.settings.uploadImage')}</button>
          {value && <button type="button" className="text-[11px] text-rose-600 hover:underline text-left" onClick={() => onChange('')}>{t('common.delete')}</button>}
        </div>
      </div>
      {allowUrl && <input className={`${INPUT} mt-2`} value={value || ''} onChange={e => onChange(e.target.value)} placeholder={t('events.settings.orPasteUrl')} />}
    </div>
  );
}

// A gallery grid: thumbnails with remove + an "add photo" upload tile.
function GalleryPicker({ restaurantId, token, images, onChange }: { restaurantId: string; token: string; images: string[]; onChange: (imgs: string[]) => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const add = async (f?: File) => {
    if (!f) return; setBusy(true);
    try { onChange([...images, await uploadEventImage(restaurantId, token, f)]); } catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((src, i) => (
        <div key={i} className="relative">
          <img src={src} alt="" className="h-20 w-28 object-cover rounded-xl border border-[#e8dccf]" />
          <button type="button" onClick={() => onChange(images.filter((_, idx) => idx !== i))}
            className="absolute -top-1.5 -right-1.5 bg-white border border-[#e8dccf] rounded-full w-5 h-5 grid place-items-center shadow text-rose-500 hover:bg-rose-50"><X size={12} /></button>
        </div>
      ))}
      <input ref={ref} type="file" accept="image/*" className="hidden" onChange={e => { add(e.target.files?.[0]); e.currentTarget.value = ''; }} />
      <button type="button" disabled={busy} onClick={() => ref.current?.click()}
        className="h-20 w-28 rounded-xl border border-dashed border-[#d9cbbb] bg-[#faf7f2] grid place-items-center text-[#b9a897] hover:bg-[#f3ece1] transition-colors">
        <span className="flex flex-col items-center gap-0.5 text-[10px] font-semibold">{busy ? '…' : <><Plus size={16} />{t('events.settings.addPhoto')}</>}</span>
      </button>
    </div>
  );
}

// ── shared fetch helper ─────────────────────────────────────────────────────
function makeApi(restaurantId: string, token: string) {
  return async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`/api/restaurant/${restaurantId}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Preserve the structured body + status so callers can react to typed
      // errors (e.g. the housekeeping override gate on event confirm).
      const err: any = new Error((b && b.error) || `HTTP ${r.status}`);
      err.status = r.status; err.data = b;
      throw err;
    }
    return b;
  };
}

// Open an authenticated PDF endpoint. A bare window.open() navigation carries
// no Authorization header (and sessions using the localStorage token have no
// cookie either) → the endpoint 401s. Fetch with the Bearer token, then open
// the resulting blob. Mirrors how the hotel/folio invoices are opened.
async function openAuthedPdf(url: string, token: string) {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b?.error || `HTTP ${r.status}`); }
    const blob = await r.blob();
    const objUrl = URL.createObjectURL(blob);
    window.open(objUrl, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
  } catch (e: any) { alert(e?.message || 'Failed to open PDF'); }
}

const CARD = 'bg-white rounded-2xl border border-[#e8dccf] p-5';
const BTN = 'px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors';
const BTN_PRIMARY = `${BTN} bg-[#cc5a16] text-white hover:bg-[#b34f12]`;
const BTN_GHOST = `${BTN} bg-[#faf7f2] border border-[#e8dccf] text-[#3d3128] hover:bg-[#f0e9df]`;
const BTN_DANGER = `${BTN} bg-rose-50 border border-rose-200 text-rose-700 hover:bg-rose-100`;
const INPUT = 'w-full px-3 py-2 rounded-xl border border-[#e8dccf] text-sm bg-white focus:outline-none focus:border-[#cc5a16]';
const LABEL = 'text-xs font-semibold text-[#6b5d52] mb-1 block';
const money = (n: any) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// Send-quotation dialog. Lets the user confirm or type an ad-hoc recipient email
// at send time (defaulting to the customer's email when one is on file). The
// /send endpoint accepts { email } as an override — email is never mandatory on
// the booking itself, so this is the point where a recipient is chosen.
function SendQuoteDialog({ restaurantId, token, quotationId, sendUrl, defaultEmail, onClose, onSent }:
  { restaurantId: string; token: string; quotationId?: string; sendUrl?: string; defaultEmail?: string; onClose: () => void; onSent: (to: string) => void }) {
  const { t } = useT();
  const api = makeApi(restaurantId, token);
  const [email, setEmail] = useState(defaultEmail || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const send = async () => {
    if (!valid) { setErr(t('events.quotes.invalidEmail')); return; }
    setBusy(true); setErr('');
    try {
      await api(sendUrl || `/events/quotations/${quotationId}/send`, { method: 'POST', body: JSON.stringify({ email: email.trim() }) });
      onSent(email.trim());
      onClose();
    } catch (e: any) { setErr(e?.message || 'Failed to send'); setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm bg-white rounded-2xl border border-[#e8dccf] p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-sm flex items-center gap-1.5 text-[#14110c]"><Mail size={15} />{t('events.quotes.sendTitle')}</h3>
          <button onClick={onClose} aria-label={t('common.cancel')}><X size={16} className="text-[#9d8b7e]" /></button>
        </div>
        <label className="block text-xs text-[#6b5d52] mb-1">{t('events.quotes.recipientEmail')}</label>
        <input type="email" autoFocus value={email} onChange={e => { setEmail(e.target.value); setErr(''); }}
          onKeyDown={e => { if (e.key === 'Enter' && valid && !busy) send(); }}
          placeholder="name@email.com" className={INPUT} />
        <p className="mt-1.5 text-[11px] text-[#9d8b7e]">{t('events.quotes.sendHint')}</p>
        {err && <p className="mt-2 text-xs text-rose-600">{err}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <button className={BTN_GHOST} onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button className={BTN_PRIMARY} onClick={send} disabled={busy || !valid}><Send size={13} />{busy ? t('events.quotes.sending') : t('events.quotes.send')}</button>
        </div>
      </div>
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  INQUIRY: 'bg-slate-50 text-slate-700 border-slate-200',
  QUOTED: 'bg-blue-50 text-blue-700 border-blue-200',
  CONFIRMED: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  IN_PROGRESS: 'bg-amber-50 text-amber-700 border-amber-200',
  COMPLETED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  CANCELLED: 'bg-gray-100 text-gray-500 border-gray-200',
};
function Pill({ status }: { status: string }) {
  return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${STATUS_COLOR[status] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>{status}</span>;
}

// ── Payment status of a booking's bill ───────────────────────────────────────
// Derived from the bill's grand total vs. what has been received (paid =
// advance_amount, which the payment endpoint keeps in sync with the sum of
// event_payments). Drives the Paid / Partially paid / Pending pill on the
// bookings (invoice) table and the Outstanding-by-Invoice report.
type PayStatus = 'PAID' | 'PARTIAL' | 'PENDING' | 'NONE';
function evPayStatus(total: any, paid: any): PayStatus {
  const tot = Number(total || 0), p = Number(paid || 0);
  if (tot <= 0) return 'NONE';            // nothing billed yet
  if (p >= tot - 0.01) return 'PAID';     // penny tolerance for rounding
  if (p > 0) return 'PARTIAL';
  return 'PENDING';
}
function evPayLabel(t: any, total: any, paid: any): string {
  const s = evPayStatus(total, paid);
  return s === 'PAID' ? t('events.pay.paid') : s === 'PARTIAL' ? t('events.pay.partial') : s === 'PENDING' ? t('events.pay.pending') : '—';
}
const PAY_COLOR: Record<PayStatus, string> = {
  PAID:    'bg-emerald-50 text-emerald-700 border-emerald-200',
  PARTIAL: 'bg-amber-50 text-amber-700 border-amber-200',
  PENDING: 'bg-rose-50 text-rose-700 border-rose-200',
  NONE:    'bg-gray-100 text-gray-500 border-gray-200',
};
function PaymentPill({ total, paid }: { total: any; paid: any }) {
  const { t } = useT();
  const s = evPayStatus(total, paid);
  const label = s === 'NONE' ? '—' : evPayLabel(t, total, paid);
  return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${PAY_COLOR[s]}`}>{label}</span>;
}

function SectionHeader({ icon, title, sub, action }: { icon: React.ReactNode; title: string; sub?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
      <div className="flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-xl bg-[#faf7f2] border border-[#e8dccf] flex items-center justify-center text-[#cc5a16]">{icon}</div>
        <div>
          <h2 className="text-2xl font-bold font-serif text-[#14110c]">{title}</h2>
          {sub && <p className="text-xs text-[#6b5d52]">{sub}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

type Props = { restaurantId: string; token: string };

// ════════════════════════════════════════════════════════════════════════
// VENUES
// ════════════════════════════════════════════════════════════════════════
function EventVenues({ restaurantId, token }: Props) {
  const { t } = useT();
  const api = makeApi(restaurantId, token);
  const [rows, setRows] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const blank = { name: '', category: 'BANQUET', ac_type: 'AC', min_occupancy: '', max_occupancy: '', floor_area: '', hourly_rate: '', half_day_rate: '', daily_rate: '', amenities: '', image_url: '' };
  const [form, setForm] = useState<any>(blank);

  const load = async () => { try { setRows(await api('/events/venues')); } catch { /* */ } };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!form.name) return;
    const body = { ...form, min_occupancy: Number(form.min_occupancy || 0), max_occupancy: Number(form.max_occupancy || 0), hourly_rate: Number(form.hourly_rate || 0), half_day_rate: Number(form.half_day_rate || 0), daily_rate: Number(form.daily_rate || 0) };
    try {
      if (edit) await api(`/events/venues/${edit.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await api('/events/venues', { method: 'POST', body: JSON.stringify(body) });
      setShowForm(false); setEdit(null); setForm(blank); await load();
    } catch (e: any) { alert(e.message); }
  };
  const remove = async (id: string) => { if (!window.confirm('Deactivate this venue?')) return; try { await api(`/events/venues/${id}`, { method: 'DELETE' }); await load(); } catch (e: any) { alert(e.message); } };
  // Manual hall status board — setting it raises the matching VENUE_<status> checklist (non-blocking).
  const setStatus = async (id: string, status: string) => {
    setRows(rs => rs.map(r => r.id === id ? { ...r, status } : r));
    try { await api(`/events/venues/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); }
    catch (e: any) { alert(e.message); await load(); }
  };
  const VENUE_STATUSES = ['VACANT', 'OCCUPIED', 'CLEANING', 'MAINTENANCE', 'BLOCKED'];
  // Right-aligned money column that sorts/filters on the numeric value and shows
  // "—" for a blank rate. Used for every price-matrix cell in the table.
  const rateCol = (key: string, label: string, opts: any = {}): any => ({
    key, label, sortable: true, align: 'right' as const,
    getValue: (r: any) => Number(r[key] || 0),
    render: (r: any) => (r[key] != null && r[key] !== '') ? money(r[key]) : '—',
    exportValue: (r: any) => (r[key] != null && r[key] !== '') ? String(r[key]) : '',
    ...opts,
  });

  return (
    <div>
      <SectionHeader icon={<Building2 size={18} />} title={t('events.venues.title')} sub={t('events.venues.sub')}
        action={<button className={BTN_PRIMARY} onClick={() => { setEdit(null); setForm(blank); setShowForm(true); }}><Plus size={14} />{t('events.venues.add')}</button>} />

      {showForm && (
        <div className={`${CARD} mb-4`}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div className="col-span-2 md:col-span-1"><label className={LABEL}>{t('events.venues.name')}</label><input className={INPUT} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
            <div><label className={LABEL}>{t('common.category')}</label>
              <select className={INPUT} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                {['BANQUET', 'LAWN', 'CONFERENCE', 'PARTY_HALL', 'OPEN_GROUND'].map(c => <option key={c} value={c}>{c}</option>)}
              </select></div>
            <div><label className={LABEL}>{t('events.venues.acType')}</label>
              <select className={INPUT} value={form.ac_type} onChange={e => setForm({ ...form, ac_type: e.target.value })}>
                <option value="AC">{t('events.venues.ac')}</option><option value="NON_AC">{t('events.venues.nonAc')}</option>
              </select></div>
            <div><label className={LABEL}>{t('events.venues.minOccupancy')}</label><input type="number" className={INPUT} value={form.min_occupancy} onChange={e => setForm({ ...form, min_occupancy: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.venues.maxOccupancy')}</label><input type="number" className={INPUT} value={form.max_occupancy} onChange={e => setForm({ ...form, max_occupancy: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.venues.floorArea')}</label><input className={INPUT} value={form.floor_area} onChange={e => setForm({ ...form, floor_area: e.target.value })} placeholder="5000 sq ft" /></div>
            {/* Price matrix — rate basis × weekday/weekend. Blank weekend = same as weekday. */}
            <div className="col-span-2 md:col-span-3">
              <label className={LABEL}>Price matrix (₹) — leave Weekend blank to reuse the weekday rate</label>
              <div className="overflow-x-auto">
                <table className="w-full text-sm border border-[#e8dccf] rounded-lg">
                  <thead><tr className="bg-[#faf6f1] text-[11px] uppercase tracking-wide text-[#6b5d52]">
                    <th className="text-left px-2 py-1.5">Basis</th><th className="px-2 py-1.5 text-left">Weekday</th><th className="px-2 py-1.5 text-left">Weekend / Peak</th>
                  </tr></thead>
                  <tbody>
                    {[
                      { label: 'Hourly', wk: 'hourly_rate', we: 'weekend_hourly_rate' },
                      { label: 'Half-day · AM', wk: 'half_day_am_rate', we: 'weekend_half_day_am_rate' },
                      { label: 'Half-day · PM', wk: 'half_day_pm_rate', we: 'weekend_half_day_pm_rate' },
                      { label: 'Daily', wk: 'daily_rate', we: 'weekend_daily_rate' },
                    ].map(row => (
                      <tr key={row.wk} className="border-t border-[#efe6db]">
                        <td className="px-2 py-1 font-semibold text-[#3d2e22] whitespace-nowrap">{row.label}</td>
                        <td className="px-1 py-1"><input type="number" className={`${INPUT} py-1`} value={form[row.wk] ?? ''} onChange={e => setForm({ ...form, [row.wk]: e.target.value })} /></td>
                        <td className="px-1 py-1"><input type="number" className={`${INPUT} py-1`} placeholder="same as weekday" value={form[row.we] ?? ''} onChange={e => setForm({ ...form, [row.we]: e.target.value })} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-[#9d8b7e] mt-1">Half-day AM/PM fall back to the legacy half-day rate if blank. Hotel rooms attached to an event are priced by the Hotel settings, not this matrix.</p>
            </div>
            <div><label className={LABEL}>Hourly — min hours</label><input type="number" className={INPUT} value={form.hourly_min_hours ?? ''} onChange={e => setForm({ ...form, hourly_min_hours: e.target.value })} placeholder="e.g. 4" /></div>
            <div><label className={LABEL}>Turnaround / prep (min)</label><input type="number" className={INPUT} value={form.turnaround_min ?? ''} onChange={e => setForm({ ...form, turnaround_min: e.target.value })} placeholder="house default" /></div>
            <div><label className={LABEL}>{t('events.venues.costPerDay')}</label><input type="number" className={INPUT} value={form.cost_per_day ?? ''} onChange={e => setForm({ ...form, cost_per_day: e.target.value })} placeholder="0" title={t('events.venues.costPerDayHint')} /></div>
            <div className="col-span-2 md:col-span-3">
              <label className={LABEL}>Half-day windows (blank = house default) — the gap between AM end & PM start is the guaranteed prep time</label>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <div><span className="text-[11px] text-[#9d8b7e]">AM start</span><input type="time" className={INPUT} value={form.hd_am_start ?? ''} onChange={e => setForm({ ...form, hd_am_start: e.target.value })} /></div>
                <div><span className="text-[11px] text-[#9d8b7e]">AM end</span><input type="time" className={INPUT} value={form.hd_am_end ?? ''} onChange={e => setForm({ ...form, hd_am_end: e.target.value })} /></div>
                <div><span className="text-[11px] text-[#9d8b7e]">PM start</span><input type="time" className={INPUT} value={form.hd_pm_start ?? ''} onChange={e => setForm({ ...form, hd_pm_start: e.target.value })} /></div>
                <div><span className="text-[11px] text-[#9d8b7e]">PM end</span><input type="time" className={INPUT} value={form.hd_pm_end ?? ''} onChange={e => setForm({ ...form, hd_pm_end: e.target.value })} /></div>
              </div>
            </div>
            <div className="col-span-2 md:col-span-3"><label className={LABEL}>{t('events.venues.amenities')}</label><input className={INPUT} value={form.amenities} onChange={e => setForm({ ...form, amenities: e.target.value })} placeholder="Stage, projector, parking, green room" /></div>
            <div className="col-span-2 md:col-span-4"><label className={LABEL}>{t('events.venues.image')}</label>
              <SingleImagePicker restaurantId={restaurantId} token={token} value={form.image_url || ''} onChange={(url) => setForm({ ...form, image_url: url })} aspect="h-24 w-40" /></div>
          </div>
          <div className="flex gap-2 mt-3">
            <button className={BTN_PRIMARY} onClick={save}>{t('common.save')}</button>
            <button className={BTN_GHOST} onClick={() => { setShowForm(false); setEdit(null); }}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      <DataTable
        data={rows}
        rowKey={(r: any) => r.id}
        emptyMessage={t('events.venues.empty')}
        columnChooser
        columnFilters
        tableId="events-venues"
        exportFilename="venues"
        columns={[
          { key: 'name', label: t('events.venues.name'), sortable: true, searchable: true, filterable: true },
          { key: 'category', label: t('common.category'), sortable: true, filterable: true, filterType: 'select' },
          { key: 'ac_type', label: t('events.venues.acType'), sortable: true, filterable: true, filterType: 'select', getValue: (r: any) => r.ac_type, render: (r: any) => r.ac_type === 'AC' ? t('events.venues.ac') : t('events.venues.nonAc') },
          { key: 'max_occupancy', label: t('events.venues.occupancy'), sortable: true, align: 'right', getValue: (r: any) => Number(r.max_occupancy || 0), render: (r: any) => `${r.min_occupancy || 0}–${r.max_occupancy || 0}`, exportValue: (r: any) => `${r.min_occupancy || 0}-${r.max_occupancy || 0}` },
          { key: 'floor_area', label: t('events.venues.floorArea'), sortable: true, defaultHidden: true, render: (r: any) => r.floor_area || '—' },
          rateCol('hourly_rate', t('events.venues.hourlyRate')),
          rateCol('half_day_am_rate', 'Half-day AM'),
          rateCol('half_day_pm_rate', 'Half-day PM'),
          rateCol('daily_rate', t('events.venues.dailyRate')),
          rateCol('weekend_hourly_rate', 'Wknd Hourly', { defaultHidden: true }),
          rateCol('weekend_half_day_am_rate', 'Wknd Half-day AM', { defaultHidden: true }),
          rateCol('weekend_half_day_pm_rate', 'Wknd Half-day PM', { defaultHidden: true }),
          rateCol('weekend_daily_rate', 'Wknd Daily', { defaultHidden: true }),
          { key: 'hourly_min_hours', label: 'Min hrs', sortable: true, align: 'right', defaultHidden: true, getValue: (r: any) => Number(r.hourly_min_hours || 0), render: (r: any) => r.hourly_min_hours || '—' },
          { key: 'turnaround_min', label: 'Turnaround (min)', sortable: true, align: 'right', defaultHidden: true, getValue: (r: any) => Number(r.turnaround_min || 0), render: (r: any) => (r.turnaround_min != null && r.turnaround_min !== '') ? r.turnaround_min : '—' },
          { key: 'status', label: 'Status', filterable: true, filterType: 'select', getValue: (r: any) => String(r.status || 'VACANT').toUpperCase(), render: (r: any) => (
            <select value={String(r.status || 'VACANT').toUpperCase()} onChange={e => setStatus(r.id, e.target.value)}
              className="text-xs border border-[#e8dccf] rounded-lg px-1.5 py-1 bg-white outline-none focus:ring-2 ring-[#cc5a16]/20">
              {VENUE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          ) },
          { key: '_a', label: t('common.actions'), hideable: false, noExport: true, render: (r: any) => (
            <div className="flex gap-1">
              <button className={BTN_GHOST} onClick={() => { setEdit(r); setForm({ ...r }); setShowForm(true); }}>{t('common.edit')}</button>
              <button className={BTN_DANGER} onClick={() => remove(r.id)}><Trash2 size={13} /></button>
            </div>
          ) },
        ]}
      />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// RENTAL INVENTORY
// ════════════════════════════════════════════════════════════════════════
function EventRentals({ restaurantId, token }: Props) {
  const { t } = useT();
  const api = makeApi(restaurantId, token);
  const [rows, setRows] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const blank = { name: '', category: 'FURNITURE', unit: 'piece', quantity_owned: '', rent_hourly: '', rent_daily: '', rent_weekly: '', deposit: '', cost_price: '' };
  const [form, setForm] = useState<any>(blank);

  const load = async () => { try { setRows(await api('/events/rental-items')); } catch { /* */ } };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!form.name) return;
    const body = { ...form, quantity_owned: Number(form.quantity_owned || 0), rent_hourly: Number(form.rent_hourly || 0), rent_daily: Number(form.rent_daily || 0), rent_weekly: Number(form.rent_weekly || 0), deposit: Number(form.deposit || 0), cost_price: Number(form.cost_price || 0) };
    try {
      if (edit) await api(`/events/rental-items/${edit.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await api('/events/rental-items', { method: 'POST', body: JSON.stringify(body) });
      setShowForm(false); setEdit(null); setForm(blank); await load();
    } catch (e: any) { alert(e.message); }
  };
  const remove = async (id: string) => { if (!window.confirm('Deactivate this item?')) return; try { await api(`/events/rental-items/${id}`, { method: 'DELETE' }); await load(); } catch (e: any) { alert(e.message); } };

  return (
    <div>
      <SectionHeader icon={<Sofa size={18} />} title={t('events.rentals.title')} sub={t('events.rentals.sub')}
        action={<button className={BTN_PRIMARY} onClick={() => { setEdit(null); setForm(blank); setShowForm(true); }}><Plus size={14} />{t('events.rentals.add')}</button>} />

      {showForm && (
        <div className={`${CARD} mb-4`}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="col-span-2 md:col-span-1"><label className={LABEL}>{t('common.name')}</label><input className={INPUT} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
            <div><label className={LABEL}>{t('common.category')}</label>
              {(() => {
                const base = ['FURNITURE', 'KITCHEN', 'DECOR', 'AV', 'UTILITY', 'OTHER'];
                const custom = Array.from(new Set(rows.map((r: any) => r.category).filter((c: string) => c && !base.includes(c))));
                const all = [...base, ...custom];
                const isCustom = form.category === '__custom__' || (form.category && !all.includes(form.category));
                return (
                  <>
                    <select className={INPUT} value={isCustom ? '__custom__' : form.category}
                      onChange={e => setForm({ ...form, category: e.target.value === '__custom__' ? '' : e.target.value })}>
                      {all.map(c => <option key={c} value={c}>{c}</option>)}
                      <option value="__custom__">{t('events.rentals.newCategory')}</option>
                    </select>
                    {isCustom && <input className={`${INPUT} mt-1`} autoFocus value={form.category === '__custom__' ? '' : form.category}
                      placeholder={t('events.rentals.enterCategory')} onChange={e => setForm({ ...form, category: e.target.value })} />}
                  </>
                );
              })()}
            </div>
            <div><label className={LABEL}>{t('events.rentals.unit')}</label>
              <select className={INPUT} value={form.unit} onChange={e => setForm({ ...form, unit: e.target.value })}>
                {['piece', 'set', 'pair'].map(u => <option key={u} value={u}>{u}</option>)}
              </select></div>
            <div><label className={LABEL}>{t('events.rentals.qtyOwned')}</label><input type="number" className={INPUT} value={form.quantity_owned} onChange={e => setForm({ ...form, quantity_owned: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.rentals.rentHourly')}</label><input type="number" className={INPUT} value={form.rent_hourly} onChange={e => setForm({ ...form, rent_hourly: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.rentals.rentDaily')}</label><input type="number" className={INPUT} value={form.rent_daily} onChange={e => setForm({ ...form, rent_daily: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.rentals.rentWeekly')}</label><input type="number" className={INPUT} value={form.rent_weekly} onChange={e => setForm({ ...form, rent_weekly: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.rentals.deposit')}</label><input type="number" className={INPUT} value={form.deposit} onChange={e => setForm({ ...form, deposit: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.cost.costPrice')}</label><input type="number" className={INPUT} value={form.cost_price ?? ''} onChange={e => setForm({ ...form, cost_price: e.target.value })} placeholder={t('events.cost.costHint')} /></div>
            <div className="col-span-2 md:col-span-4"><label className={LABEL}>{t('common.description')}</label><input className={INPUT} value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Pulled into booking, quote & invoice" /></div>
          </div>
          <div className="flex gap-2 mt-3">
            <button className={BTN_PRIMARY} onClick={save}>{t('common.save')}</button>
            <button className={BTN_GHOST} onClick={() => { setShowForm(false); setEdit(null); }}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      <DataTable
        data={rows}
        rowKey={(r: any) => r.id}
        emptyMessage={t('events.rentals.empty')}
        columnChooser columnFilters tableId="events-rentals" exportFilename="rental-inventory"
        columns={[
          { key: 'name', label: t('common.name'), sortable: true, searchable: true, filterable: true },
          { key: 'category', label: t('common.category'), sortable: true, filterable: true, filterType: 'select' },
          { key: 'quantity_owned', label: t('events.rentals.qtyOwned'), sortable: true, align: 'right', getValue: (r: any) => Number(r.quantity_owned || 0) },
          { key: 'rent_hourly', label: t('events.rentals.rentHourly'), sortable: true, align: 'right', getValue: (r: any) => Number(r.rent_hourly || 0), render: (r: any) => money(r.rent_hourly) },
          { key: 'rent_daily', label: t('events.rentals.rentDaily'), sortable: true, align: 'right', getValue: (r: any) => Number(r.rent_daily || 0), render: (r: any) => money(r.rent_daily) },
          { key: 'rent_weekly', label: t('events.rentals.rentWeekly'), sortable: true, align: 'right', getValue: (r: any) => Number(r.rent_weekly || 0), render: (r: any) => money(r.rent_weekly) },
          { key: '_a', label: t('common.actions'), hideable: false, noExport: true, render: (r: any) => (
            <div className="flex gap-1">
              <button className={BTN_GHOST} onClick={() => { setEdit(r); setForm({ ...r }); setShowForm(true); }}>{t('common.edit')}</button>
              <button className={BTN_DANGER} onClick={() => remove(r.id)}><Trash2 size={13} /></button>
            </div>
          ) },
        ]}
      />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// ADD-ON SERVICES
// ════════════════════════════════════════════════════════════════════════
function EventServices({ restaurantId, token }: Props) {
  const { t } = useT();
  const api = makeApi(restaurantId, token);
  const [rows, setRows] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const blank = { name: '', category: 'STAFF', pricing_type: 'PER_EVENT', rate: '', cost_price: '' };
  const [form, setForm] = useState<any>(blank);

  const load = async () => { try { setRows(await api('/events/services')); } catch { /* */ } };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!form.name) return;
    try {
      const body = { ...form, rate: Number(form.rate || 0), cost_price: Number(form.cost_price || 0) };
      if (edit) await api(`/events/services/${edit.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await api('/events/services', { method: 'POST', body: JSON.stringify(body) });
      setShowForm(false); setEdit(null); setForm(blank); await load();
    } catch (e: any) { alert(e.message); }
  };
  const remove = async (id: string) => { if (!window.confirm('Deactivate this service?')) return; try { await api(`/events/services/${id}`, { method: 'DELETE' }); await load(); } catch (e: any) { alert(e.message); } };

  return (
    <div>
      <SectionHeader icon={<Users size={18} />} title={t('events.services.title')} sub={t('events.services.sub')}
        action={<button className={BTN_PRIMARY} onClick={() => { setEdit(null); setForm(blank); setShowForm(true); }}><Plus size={14} />{t('events.services.add')}</button>} />

      {showForm && (
        <div className={`${CARD} mb-4`}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="col-span-2 md:col-span-1"><label className={LABEL}>{t('common.name')}</label><input className={INPUT} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
            <div><label className={LABEL}>{t('common.category')}</label>
              <select className={INPUT} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                {['STAFF', 'SECURITY', 'PARKING', 'DECORATION', 'CATERING', 'AV', 'OTHER'].map(c => <option key={c} value={c}>{c}</option>)}
              </select></div>
            <div><label className={LABEL}>{t('events.services.pricingType')}</label>
              <select className={INPUT} value={form.pricing_type} onChange={e => setForm({ ...form, pricing_type: e.target.value })}>
                {['PER_EVENT', 'PER_HOUR', 'PER_DAY', 'PER_PERSON', 'PER_UNIT'].map(c => <option key={c} value={c}>{c}</option>)}
              </select></div>
            <div><label className={LABEL}>{t('events.services.rate')}</label><input type="number" className={INPUT} value={form.rate} onChange={e => setForm({ ...form, rate: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.cost.costPrice')}</label><input type="number" className={INPUT} value={form.cost_price ?? ''} onChange={e => setForm({ ...form, cost_price: e.target.value })} placeholder={t('events.cost.costHint')} /></div>
            <div className="col-span-2 md:col-span-4"><label className={LABEL}>{t('common.description')}</label><input className={INPUT} value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Pulled into booking, quote & invoice" /></div>
          </div>
          <div className="flex gap-2 mt-3">
            <button className={BTN_PRIMARY} onClick={save}>{t('common.save')}</button>
            <button className={BTN_GHOST} onClick={() => { setShowForm(false); setEdit(null); }}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      <DataTable
        data={rows}
        rowKey={(r: any) => r.id}
        emptyMessage={t('events.services.empty')}
        columnChooser columnFilters tableId="events-services" exportFilename="event-services"
        columns={[
          { key: 'name', label: t('common.name'), sortable: true, searchable: true, filterable: true },
          { key: 'category', label: t('common.category'), sortable: true, filterable: true, filterType: 'select' },
          { key: 'pricing_type', label: t('events.services.pricingType'), sortable: true, filterable: true, filterType: 'select' },
          { key: 'rate', label: t('events.services.rate'), sortable: true, align: 'right', getValue: (r: any) => Number(r.rate || 0), render: (r: any) => money(r.rate) },
          { key: '_a', label: t('common.actions'), hideable: false, noExport: true, render: (r: any) => (
            <div className="flex gap-1">
              <button className={BTN_GHOST} onClick={() => { setEdit(r); setForm({ ...r }); setShowForm(true); }}>{t('common.edit')}</button>
              <button className={BTN_DANGER} onClick={() => remove(r.id)}><Trash2 size={13} /></button>
            </div>
          ) },
        ]}
      />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// CATERING MENUS (Buffet / Plated packages with configurable menu sections)
// ════════════════════════════════════════════════════════════════════════
function EventCatering({ restaurantId, token }: Props) {
  const { t } = useT();
  const api = makeApi(restaurantId, token);
  const [rows, setRows] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const blank = { name: '', package_type: 'BUFFET', price_per_plate: '', gst_percent: '5', cost_price: '', description: '', sections: [{ name: '', optionsText: '' }] };
  const [form, setForm] = useState<any>(blank);

  const load = async () => { try { setRows(await api('/events/catering-packages')); } catch { /* */ } };
  useEffect(() => { load(); }, []);

  const openEdit = (r: any) => {
    let sections = [{ name: '', optionsText: '' }];
    try { const m = r.menu_json ? JSON.parse(r.menu_json) : []; if (Array.isArray(m) && m.length) sections = m.map((s: any) => ({ name: s.section || '', optionsText: (s.options || []).join(', ') })); } catch { /* */ }
    setEdit(r); setForm({ ...r, sections }); setShowForm(true);
  };
  const save = async () => {
    if (!form.name) return;
    const menu = (form.sections || []).filter((s: any) => s.name).map((s: any) => ({ section: s.name, options: String(s.optionsText || '').split(',').map((x: string) => x.trim()).filter(Boolean) }));
    const body = { name: form.name, package_type: form.package_type, price_per_plate: Number(form.price_per_plate || 0), gst_percent: Number(form.gst_percent || 5), cost_price: Number(form.cost_price || 0), description: form.description, menu_json: menu };
    try {
      if (edit) await api(`/events/catering-packages/${edit.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await api('/events/catering-packages', { method: 'POST', body: JSON.stringify(body) });
      setShowForm(false); setEdit(null); setForm(blank); await load();
    } catch (e: any) { alert(e.message); }
  };
  const remove = async (id: string) => { if (!window.confirm('Deactivate this package?')) return; try { await api(`/events/catering-packages/${id}`, { method: 'DELETE' }); await load(); } catch (e: any) { alert(e.message); } };

  const setSection = (i: number, field: string, value: string) => {
    const s = [...(form.sections || [])]; s[i] = { ...s[i], [field]: value }; setForm({ ...form, sections: s });
  };

  return (
    <div>
      <SectionHeader icon={<Sofa size={18} />} title={t('events.catering.title')} sub={t('events.catering.sub')}
        action={<button className={BTN_PRIMARY} onClick={() => { setEdit(null); setForm(blank); setShowForm(true); }}><Plus size={14} />{t('events.catering.add')}</button>} />

      {showForm && (
        <div className={`${CARD} mb-4`}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="col-span-2 md:col-span-1"><label className={LABEL}>{t('common.name')}</label><input className={INPUT} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.catering.type')}</label>
              <select className={INPUT} value={form.package_type} onChange={e => setForm({ ...form, package_type: e.target.value })}>
                <option value="BUFFET">{t('events.catering.buffet')}</option><option value="PLATED">{t('events.catering.plated')}</option>
              </select></div>
            <div><label className={LABEL}>{t('events.catering.pricePerPlate')}</label><input type="number" className={INPUT} value={form.price_per_plate} onChange={e => setForm({ ...form, price_per_plate: e.target.value })} /></div>
            <div><label className={LABEL}>GST %</label><input type="number" className={INPUT} value={form.gst_percent} onChange={e => setForm({ ...form, gst_percent: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.cost.costPrice')}</label><input type="number" className={INPUT} value={form.cost_price ?? ''} onChange={e => setForm({ ...form, cost_price: e.target.value })} placeholder={t('events.cost.costHint')} /></div>
            <div className="col-span-2 md:col-span-4"><label className={LABEL}>{t('common.description')}</label><input className={INPUT} value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Pulled into booking, quote & invoice" /></div>
          </div>

          <div className="mt-3">
            <label className={LABEL}>{t('events.catering.sections')}</label>
            {(form.sections || []).map((s: any, i: number) => (
              <div key={i} className="flex items-center gap-2 mb-1.5">
                <input className={`${INPUT} md:w-56`} placeholder={t('events.catering.sectionName')} value={s.name} onChange={e => setSection(i, 'name', e.target.value)} />
                <input className={INPUT} placeholder={t('events.catering.options')} value={s.optionsText} onChange={e => setSection(i, 'optionsText', e.target.value)} />
                <button className={BTN_DANGER} onClick={() => setForm({ ...form, sections: form.sections.filter((_: any, j: number) => j !== i) })}><Trash2 size={13} /></button>
              </div>
            ))}
            <button className={BTN_GHOST} onClick={() => setForm({ ...form, sections: [...(form.sections || []), { name: '', optionsText: '' }] })}>{t('events.catering.addSection')}</button>
          </div>

          <div className="flex gap-2 mt-3">
            <button className={BTN_PRIMARY} onClick={save}>{t('common.save')}</button>
            <button className={BTN_GHOST} onClick={() => { setShowForm(false); setEdit(null); }}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      <DataTable
        data={rows}
        rowKey={(r: any) => r.id}
        emptyMessage={t('events.catering.empty')}
        columnChooser columnFilters tableId="events-catering" exportFilename="catering-packages"
        columns={[
          { key: 'name', label: t('common.name'), sortable: true, searchable: true, filterable: true },
          { key: 'package_type', label: t('events.catering.type'), sortable: true, filterable: true, filterType: 'select', getValue: (r: any) => r.package_type, render: (r: any) => r.package_type === 'PLATED' ? t('events.catering.plated') : t('events.catering.buffet') },
          { key: 'price_per_plate', label: t('events.catering.pricePerPlate'), sortable: true, align: 'right', getValue: (r: any) => Number(r.price_per_plate || 0), render: (r: any) => money(r.price_per_plate) },
          { key: 'menu_json', label: t('events.catering.sections'), render: (r: any) => { try { const m = JSON.parse(r.menu_json || '[]'); return (m || []).map((s: any) => s.section).join(', ') || '—'; } catch { return '—'; } } },
          { key: '_a', label: t('common.actions'), hideable: false, noExport: true, render: (r: any) => (
            <div className="flex gap-1">
              <button className={BTN_GHOST} onClick={() => openEdit(r)}>{t('common.edit')}</button>
              <button className={BTN_DANGER} onClick={() => remove(r.id)}><Trash2 size={13} /></button>
            </div>
          ) },
        ]}
      />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// BOOKINGS (list + detail)
// ════════════════════════════════════════════════════════════════════════
function EventBookings({ restaurantId, token }: Props) {
  const { t } = useT();
  const api = makeApi(restaurantId, token);
  const [rows, setRows] = useState<any[]>([]);
  const [venues, setVenues] = useState<any[]>([]);
  const [objStack, setObjStack] = useState<Array<{ type: string; id: string }>>([]);
  const [showNew, setShowNew] = useState(false);
  const blank = { customer_name: '', customer_phone: '', customer_email: '', event_type: 'WEDDING', venue_id: '', event_date: new Date().toISOString().slice(0, 10), end_date: '', start_time: '10:00', end_time: '22:00', venue_rate_basis: 'DAILY', half_day_slot: 'AM', venue_rate: '', guest_count: '' };
  const [form, setForm] = useState<any>(blank);
  const [avail, setAvail] = useState<{ available: boolean; reason: string; rate: number } | null>(null);

  const load = async () => { try { setRows(await api('/events/bookings')); } catch { /* */ } };
  const loadVenues = async () => { try { setVenues(await api('/events/venues')); } catch { /* */ } };
  useEffect(() => { load(); loadVenues(); }, []);

  // Live venue availability + matrix rate for the new-booking form. Re-runs when
  // the hall / date / basis / slot / time change; auto-fills the venue rate (still
  // editable as a per-booking override).
  useEffect(() => {
    if (!showNew || !form.venue_id || !form.event_date) { setAvail(null); return; }
    const qs = new URLSearchParams({ basis: form.venue_rate_basis, date: form.event_date });
    if (form.end_date) qs.set('end_date', form.end_date);
    if (form.venue_rate_basis === 'HALF_DAY') qs.set('slot', form.half_day_slot || 'AM');
    else { qs.set('start', form.start_time || '10:00'); qs.set('end', form.end_time || '22:00'); }
    let cancelled = false;
    api(`/events/venues/${form.venue_id}/availability-check?${qs.toString()}`)
      .then((r: any) => { if (cancelled) return; setAvail(r); setForm((f: any) => ({ ...f, venue_rate: r.rate })); })
      .catch(() => { if (!cancelled) setAvail(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showNew, form.venue_id, form.event_date, form.end_date, form.venue_rate_basis, form.half_day_slot, form.start_time, form.end_time]);

  const create = async () => {
    if (!form.customer_name || !form.event_date) { alert('Customer name and event date are required'); return; }
    try {
      const body = { ...form, guest_count: Number(form.guest_count || 0) };
      const created = await api('/events/bookings', { method: 'POST', body: JSON.stringify(body) });
      setShowNew(false); setForm(blank); await load(); setObjStack([{ type: 'EVENT_BOOKING', id: created.id }]);
    } catch (e: any) { alert(e.message); }
  };

  const top = objStack[objStack.length - 1];
  if (top) return (
    <EventObjectRouter
      restaurantId={restaurantId} token={token} obj={top} venues={venues}
      onOpenObject={(type, id) => setObjStack(s => [...s, { type, id }])}
      onBack={() => { setObjStack(s => s.slice(0, -1)); load(); }}
    />
  );

  return (
    <div>
      <SectionHeader icon={<CalendarRange size={18} />} title={t('events.bookings.title')} sub={t('events.bookings.sub')}
        action={<div className="flex gap-2"><button className={BTN_GHOST} onClick={load}><RefreshCw size={13} /></button><button className={BTN_PRIMARY} onClick={() => { setForm(blank); setShowNew(true); }}><Plus size={14} />{t('events.bookings.new')}</button></div>} />

      {showNew && (
        <div className={`${CARD} mb-4`}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div><label className={LABEL}>{t('common.name')}</label><input className={INPUT} value={form.customer_name} onChange={e => setForm({ ...form, customer_name: e.target.value })} /></div>
            <div><label className={LABEL}>{t('common.phone')}</label><input className={INPUT} value={form.customer_phone} onChange={e => setForm({ ...form, customer_phone: e.target.value })} /></div>
            <div><label className={LABEL}>{t('common.email')}</label><input className={INPUT} value={form.customer_email} onChange={e => setForm({ ...form, customer_email: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.bookings.eventType')}</label>
              <select className={INPUT} value={form.event_type} onChange={e => setForm({ ...form, event_type: e.target.value })}>
                {['WEDDING', 'RECEPTION', 'CONFERENCE', 'BIRTHDAY', 'CORPORATE', 'OTHER'].map(c => <option key={c} value={c}>{c}</option>)}
              </select></div>
            <div><label className={LABEL}>{t('events.bookings.venue')}</label>
              <select className={INPUT} value={form.venue_id} onChange={e => setForm({ ...form, venue_id: e.target.value })}>
                <option value="">—</option>
                {venues.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select></div>
            <div><label className={LABEL}>{t('events.bookings.eventDate')}</label><input type="date" className={INPUT} value={form.event_date} onChange={e => setForm({ ...form, event_date: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.bookings.endDate')}</label>
              <input type="date" className={INPUT} min={form.event_date} value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })} />
              <p className="text-[10px] text-[#9d8b7e] mt-0.5">{t('events.bookings.endDateHint')}</p></div>
            <div><label className={LABEL}>{t('events.bookings.rateBasis')}</label>
              <select className={INPUT} value={form.venue_rate_basis} onChange={e => setForm({ ...form, venue_rate_basis: e.target.value })}>
                <option value="DAILY">Daily / Multi-day</option>
                <option value="HALF_DAY">Half-day</option>
                <option value="HOURLY">Hourly</option>
              </select></div>
            {form.venue_rate_basis === 'HALF_DAY' ? (
              <div><label className={LABEL}>Slot</label>
                <select className={INPUT} value={form.half_day_slot || 'AM'} onChange={e => setForm({ ...form, half_day_slot: e.target.value })}>
                  <option value="AM">Morning (AM)</option><option value="PM">Evening (PM)</option>
                </select>
                <p className="text-[10px] text-[#9d8b7e] mt-0.5">Time comes from the hall's AM/PM window.</p></div>
            ) : (<>
              <div><label className={LABEL}>{t('events.bookings.startTime')}</label><input type="time" className={INPUT} value={form.start_time} onChange={e => setForm({ ...form, start_time: e.target.value })} /></div>
              <div><label className={LABEL}>{t('events.bookings.endTime')}</label><input type="time" className={INPUT} value={form.end_time} onChange={e => setForm({ ...form, end_time: e.target.value })} /></div>
            </>)}
            <div><label className={LABEL}>{t('events.bookings.guests')}</label><input type="number" className={INPUT} value={form.guest_count} onChange={e => setForm({ ...form, guest_count: e.target.value })} /></div>
          </div>
          {form.venue_id && avail && (
            <div className={`mt-3 flex flex-wrap items-center gap-3 px-3 py-2 rounded-lg border ${avail.available ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
              <span className={`text-sm font-bold ${avail.available ? 'text-emerald-700' : 'text-red-700'}`}>{avail.available ? '✓ Hall available' : '✗ Not available'}</span>
              <span className="text-xs text-[#6b5d52]">{avail.reason}</span>
              <label className="flex items-center gap-1.5 text-xs ml-auto">Venue rate ₹<input type="number" className={`${INPUT} w-28 py-1`} value={form.venue_rate ?? ''} onChange={e => setForm({ ...form, venue_rate: e.target.value })} /></label>
              {form.venue_rate_basis === 'DAILY' && form.end_date && form.end_date > form.event_date && (
                <span className="w-full text-right text-[10px] text-[#9d8b7e] tabular-nums">
                  {Math.max(1, Math.round((Date.parse(form.end_date + 'T00:00:00Z') - Date.parse(form.event_date + 'T00:00:00Z')) / 86400000) + 1)} days × daily rate = {money(Number(avail.rate) || 0)}
                </span>
              )}
            </div>
          )}
          <div className="flex gap-2 mt-3">
            <button className={BTN_PRIMARY} onClick={create}>{t('common.save')}</button>
            <button className={BTN_GHOST} onClick={() => setShowNew(false)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      <DataTable
        data={rows}
        rowKey={(r: any) => r.id}
        emptyMessage={t('events.bookings.empty')}
        columnChooser
        columnFilters
        tableId="events-bookings"
        exportFilename="event-bookings"
        columns={[
          {
            key: 'id', label: t('events.bookings.bookingId'), sortable: true, searchable: true, hideable: false,
            // Booking ID is a hyperlink → opens the ObjectDetail tree menu (Overview / Audit / Where-Used),
            // mirroring the PMS booking-ID drill-down.
            render: (r: any) => <button onClick={() => setObjStack([{ type: 'EVENT_BOOKING', id: r.id }])} className="font-semibold text-blue-600 hover:text-blue-800 hover:underline text-left">{r.id}</button>,
            exportValue: (r: any) => r.id,
          },
          { key: 'customer_name', label: t('events.bookings.customer'), sortable: true, searchable: true, filterable: true, filterType: 'text' },
          { key: 'venue_name', label: t('events.bookings.venue'), sortable: true, filterable: true, filterType: 'select', getValue: (r: any) => r.venue_name || '—', render: (r: any) => r.venue_name || '—' },
          { key: 'event_date', label: t('events.bookings.eventDate'), sortable: true, getValue: (r: any) => String(r.event_date || '').slice(0, 10), render: (r: any) => { const s = String(r.event_date || '').slice(0, 10); const e = String(r.end_date || '').slice(0, 10); return e && e > s ? `${s} → ${e}` : s; } },
          { key: 'guest_count', label: t('events.bookings.guests'), sortable: true, align: 'right' },
          { key: 'total_amount', label: t('common.total'), sortable: true, align: 'right', getValue: (r: any) => Number(r.total_amount || 0), render: (r: any) => money(r.total_amount), exportValue: (r: any) => String(r.total_amount ?? '') },
          { key: 'advance_amount', label: t('events.bookings.advance'), sortable: true, align: 'right', getValue: (r: any) => Number(r.advance_amount || 0), render: (r: any) => money(r.advance_amount), exportValue: (r: any) => String(r.advance_amount ?? '') },
          { key: 'outstanding', label: t('events.dash.outstanding'), sortable: true, align: 'right', getValue: (r: any) => Math.max(0, Number(r.total_amount || 0) - Number(r.advance_amount || 0)), render: (r: any) => money(Math.max(0, Number(r.total_amount || 0) - Number(r.advance_amount || 0))), exportValue: (r: any) => String(Math.max(0, Number(r.total_amount || 0) - Number(r.advance_amount || 0))) },
          { key: 'pay_status', label: t('events.bookings.payment'), sortable: true, filterable: true, filterType: 'select', getValue: (r: any) => evPayLabel(t, r.total_amount, r.advance_amount), render: (r: any) => <PaymentPill total={r.total_amount} paid={r.advance_amount} />, exportValue: (r: any) => evPayLabel(t, r.total_amount, r.advance_amount) },
          { key: 'status', label: t('common.status'), sortable: true, filterable: true, filterType: 'select', getValue: (r: any) => r.status, render: (r: any) => <Pill status={r.status} /> },
          { key: '_a', label: t('common.actions'), noExport: true, render: (r: any) => <button className={BTN_GHOST} onClick={() => setObjStack([{ type: 'EVENT_BOOKING', id: r.id }])}>{t('common.edit')}</button> },
        ]}
      />
    </div>
  );
}

// ── Hotel-room add row: pick rooms + rate before attaching to the event ──────
function HotelRoomAddRow({ rt, onAdd }: { rt: any; onAdd: (rate: number, rooms: number) => void }) {
  const { t } = useT();
  const [rate, setRate] = useState<string>(rt.rate ? String(rt.rate) : '');
  const [rooms, setRooms] = useState<string>('1');
  return (
    <div className="flex items-center gap-1.5 text-xs py-1">
      <span className="flex-1 min-w-0 truncate">{rt.name} <span className="text-[#9d8b7e]">({rt.available}/{rt.total} free)</span></span>
      <input type="number" min={1} value={rooms} onChange={e => setRooms(e.target.value)} title="Rooms" className="w-11 px-1 py-0.5 rounded border border-[#e8dccf] text-right" />
      <span className="text-[#9d8b7e]">×₹</span>
      <input type="number" min={0} value={rate} onChange={e => setRate(e.target.value)} placeholder="rate/night" title="Rate / night" className="w-20 px-1 py-0.5 rounded border border-[#e8dccf] text-right" />
      <button className={BTN_GHOST} onClick={() => onAdd(Number(rate) || 0, Number(rooms) || 1)}>{t('common.add')}</button>
    </div>
  );
}

// ── Booking detail: lines, hotel rooms, quotation, lifecycle ────────────────
// ── Payment schedule + receipts (Sprint 1: cash & revenue integrity) ─────────
// `editable` gates ledger restructuring + deletion (locked once the booking is
// COMPLETED). `canRecord` gates money-in actions (record payment / pay an
// instalment) and stays true for any non-cancelled booking — so a customer who
// pays AFTER the event is complete can still be receipted, matching the backend
// which blocks new receipts only for CANCELLED bookings.
function PaymentPanel({ restaurantId, token, booking, editable, canRecord, onChanged }: Props & { booking: any; editable: boolean; canRecord: boolean; onChanged: () => void }) {
  const { t } = useT();
  const api = makeApi(restaurantId, token);
  const bid = booking.id;
  const [sched, setSched] = useState<any[]>([]);
  const [pay, setPay] = useState<any>({ payments: [], paid: 0, total: 0, balance: 0 });
  const [form, setForm] = useState<{ open: boolean; schedule_id: string | null; amount: string; method: string; paid_at: string; reference: string }>({ open: false, schedule_id: null, amount: '', method: 'UPI', paid_at: new Date().toISOString().slice(0, 10), reference: '' });
  const today = new Date().toISOString().slice(0, 10);
  const dOnly = (v: any) => String(v || '').slice(0, 10);

  const load = async () => {
    try { setSched(await api(`/events/bookings/${bid}/schedule`)); } catch { setSched([]); }
    try { setPay(await api(`/events/bookings/${bid}/payments`)); } catch { /* */ }
  };
  // Re-fetch when the booking's grand total or discount changes (not just the id)
  // so the Paid/Balance figures refresh immediately after a discount edit — the
  // server balance is total_amount − paid, and total_amount moves with discount.
  useEffect(() => { load(); }, [bid, booking.total_amount, booking.discount]);

  const genSchedule = async () => { try { await api(`/events/bookings/${bid}/schedule/generate`, { method: 'POST', body: JSON.stringify({}) }); await load(); } catch (e: any) { alert(e.message); } };
  const delSched = async (sid: string) => { try { await api(`/events/schedule/${sid}`, { method: 'DELETE' }); await load(); } catch (e: any) { alert(e.message); } };
  const openPay = (row?: any) => setForm({ open: true, schedule_id: row?.id || null, amount: row ? String(Math.max(0, Number(row.amount || 0) - Number(row.paid_amount || 0))) : '', method: 'UPI', paid_at: today, reference: '' });
  const savePay = async () => {
    const amount = Number(form.amount || 0);
    if (!(amount > 0)) { alert(t('events.pay.enterAmount')); return; }
    try { await api(`/events/bookings/${bid}/payments`, { method: 'POST', body: JSON.stringify({ amount, method: form.method, paid_at: form.paid_at, reference: form.reference, schedule_id: form.schedule_id }) }); setForm({ ...form, open: false }); await load(); onChanged(); }
    catch (e: any) { alert(e.message); }
  };
  const delPay = async (pid: string) => { try { await api(`/events/payments/${pid}`, { method: 'DELETE' }); await load(); onChanged(); } catch (e: any) { alert(e.message); } };
  const METHODS = ['UPI', 'CASH', 'CARD', 'BANK', 'CHEQUE'];

  return (
    <div className={`${CARD} mb-4`}>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h3 className="font-bold text-sm flex items-center gap-1.5"><IndianRupee size={15} />{t('events.pay.title')}</h3>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-[#6b5d52]">{t('events.pay.paid')} <b className="text-emerald-700 tabular-nums">{money(pay.paid)}</b></span>
          <span className="text-[#6b5d52]">{t('events.pay.balance')} <b className="text-rose-600 tabular-nums">{money(pay.balance)}</b></span>
          {canRecord && <button className={BTN_PRIMARY} onClick={() => openPay()}><Plus size={12} />{t('events.pay.record')}</button>}
        </div>
      </div>
      {!editable && canRecord && Number(pay.balance) > 0.01 && (
        <p className="text-[11px] text-[#9d8b7e] -mt-1 mb-2">{t('events.pay.afterEvent')}</p>
      )}

      <div className="flex items-center justify-between mt-1 mb-1">
        <span className="text-[11px] font-bold uppercase tracking-wide text-[#9d8b7e]">{t('events.pay.schedule')}</span>
        {editable && <button className={BTN_GHOST} onClick={genSchedule}>{t('events.pay.generate')}</button>}
      </div>
      {sched.length === 0 ? <p className="text-xs text-[#9d8b7e]">{t('events.pay.noSchedule')}</p> : sched.map((s: any) => {
        const overdue = s.status !== 'PAID' && dOnly(s.due_date) && dOnly(s.due_date) < today;
        return (
          <div key={s.id} className="flex items-center gap-2 text-xs py-1 border-b border-[#f0e9df]">
            <span className="flex-1 min-w-0 truncate">{s.label}{s.percent != null ? ` (${s.percent}%)` : ''}</span>
            <span className={`w-24 text-right ${overdue ? 'text-rose-600 font-semibold' : 'text-[#6b5d52]'}`}>{dOnly(s.due_date) || '—'}</span>
            <span className="w-20 text-right tabular-nums font-semibold">{money(s.amount)}</span>
            <span className="w-16 text-center">
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${overdue ? 'bg-rose-100 text-rose-700' : s.status === 'PAID' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                {overdue ? t('events.pay.overdue') : s.status === 'PAID' ? t('events.pay.paidStatus') : t('events.pay.due')}
              </span>
            </span>
            {canRecord && s.status !== 'PAID' && Number(pay.balance) > 0.01 && <button className={BTN_GHOST} onClick={() => openPay(s)}>{t('events.pay.pay')}</button>}
            {/* A paid instalment can't be deleted — that would orphan the row while
                the receipt stays recorded. Only unpaid (DUE) rows are removable. */}
            {editable && s.status !== 'PAID' && Number(s.paid_amount || 0) <= 0 && <button onClick={() => delSched(s.id)}><X size={12} className="text-rose-500" /></button>}
          </div>
        );
      })}

      {(pay.payments || []).length > 0 && <div className="text-[11px] font-bold uppercase tracking-wide text-[#9d8b7e] mt-3 mb-1">{t('events.pay.receipts')}</div>}
      {(pay.payments || []).map((p: any) => (
        <div key={p.id} className="flex items-center gap-2 text-xs py-1 border-b border-[#f0e9df]">
          <span className="flex-1 min-w-0 truncate">{dOnly(p.paid_at)} · {p.method}{p.reference ? ` · ${p.reference}` : ''}</span>
          <span className="w-20 text-right tabular-nums font-semibold text-emerald-700">{money(p.amount)}</span>
          {editable && <button onClick={() => delPay(p.id)}><X size={12} className="text-rose-500" /></button>}
        </div>
      ))}

      {form.open && (
        <div className="mt-3 p-3 rounded-xl bg-[#faf7f2] border border-[#e8dccf]">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div><label className={LABEL}>{t('events.pay.amount')}</label><input type="number" min={0} className={INPUT} value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.pay.method')}</label><select className={INPUT} value={form.method} onChange={e => setForm({ ...form, method: e.target.value })}>{METHODS.map(m => <option key={m} value={m}>{m}</option>)}</select></div>
            <div><label className={LABEL}>{t('events.pay.date')}</label><input type="date" className={INPUT} value={form.paid_at} onChange={e => setForm({ ...form, paid_at: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.pay.reference')}</label><input className={INPUT} value={form.reference} onChange={e => setForm({ ...form, reference: e.target.value })} /></div>
          </div>
          <div className="flex gap-2 mt-2">
            <button className={BTN_PRIMARY} onClick={savePay}>{t('common.save')}</button>
            <button className={BTN_GHOST} onClick={() => setForm({ ...form, open: false })}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Staff rostering: assign the shared roster to the event per working date ──
function StaffPanel({ restaurantId, token, booking, editable, onChanged }: Props & { booking: any; editable: boolean; onChanged: () => void }) {
  const { t } = useT();
  const api = makeApi(restaurantId, token);
  const bid = booking.id;
  const dOnly = (v: any) => String(v || '').slice(0, 10);
  const startDate = dOnly(booking.event_date) || new Date().toISOString().slice(0, 10);
  const blank = () => ({ open: false, staff_id: '', assigned_date: startDate, shift_start: booking.start_time || '', shift_end: booking.end_time || '', note: '' });
  const [roster, setRoster] = useState<any[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [form, setForm] = useState<{ open: boolean; staff_id: string; assigned_date: string; shift_start: string; shift_end: string; note: string }>(blank());

  const load = async () => { try { const r = await api(`/events/bookings/${bid}/staff`); setRows(r.assignments || []); } catch { setRows([]); } };
  const loadRoster = async () => { try { const r = await api(`/events/roster-staff`); setRoster(r.staff || []); } catch { setRoster([]); } };
  useEffect(() => { load(); loadRoster(); }, [bid]);

  const save = async (force = false): Promise<void> => {
    if (!form.staff_id) { alert(t('events.staff.pickStaff')); return; }
    try {
      await api(`/events/bookings/${bid}/staff`, { method: 'POST', body: JSON.stringify({ ...form, force }) });
      setForm(blank()); await load(); onChanged();
    } catch (e: any) {
      // Cross-event double-booking → offer to override; other errors just surface.
      if (!force && /rostered|already/i.test(e.message || '')) {
        if (confirm(`${e.message}\n\n${t('events.staff.assignAnyway')}`)) return save(true);
      } else { alert(e.message); }
    }
  };
  const remove = async (id: string) => { try { await api(`/events/staff/${id}`, { method: 'DELETE' }); await load(); onChanged(); } catch (e: any) { alert(e.message); } };

  return (
    <div className={`${CARD} mb-4`}>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h3 className="font-bold text-sm flex items-center gap-1.5"><Users size={15} />{t('events.staff.title')}</h3>
        {editable && <button className={BTN_PRIMARY} onClick={() => setForm({ ...blank(), open: true })}><Plus size={12} />{t('events.staff.assign')}</button>}
      </div>
      {rows.length === 0 ? <p className="text-xs text-[#9d8b7e]">{t('events.staff.none')}</p> : rows.map((r: any) => (
        <div key={r.id} className="flex items-center gap-2 text-xs py-1 border-b border-[#f0e9df]">
          <span className="flex-1 min-w-0 truncate font-medium">{r.staff_name || r.staff_name_snapshot}
            {(r.staff_role || r.role_snapshot) ? <span className="text-[#9d8b7e]"> · {r.staff_role || r.role_snapshot}</span> : null}</span>
          <span className="w-24 text-right text-[#6b5d52] tabular-nums">{dOnly(r.assigned_date)}</span>
          <span className="w-24 text-right text-[#9d8b7e] tabular-nums">{r.shift_start && r.shift_end ? `${r.shift_start}–${r.shift_end}` : ''}</span>
          {editable && <button onClick={() => remove(r.id)} title={t('common.delete')}><X size={12} className="text-rose-500" /></button>}
        </div>
      ))}
      {form.open && (
        <div className="mt-3 p-3 rounded-xl bg-[#faf7f2] border border-[#e8dccf]">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div><label className={LABEL}>{t('events.staff.staff')}</label>
              <select className={INPUT} value={form.staff_id} onChange={e => setForm({ ...form, staff_id: e.target.value })} autoFocus>
                <option value="">—</option>
                {roster.map((s: any) => <option key={s.id} value={s.id}>{s.name}{s.role ? ` (${s.role})` : ''}</option>)}
              </select>
            </div>
            <div><label className={LABEL}>{t('events.staff.date')}</label><input type="date" className={INPUT} value={form.assigned_date} onChange={e => setForm({ ...form, assigned_date: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.staff.shiftStart')}</label><input type="time" className={INPUT} value={form.shift_start} onChange={e => setForm({ ...form, shift_start: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.staff.shiftEnd')}</label><input type="time" className={INPUT} value={form.shift_end} onChange={e => setForm({ ...form, shift_end: e.target.value })} /></div>
          </div>
          {roster.length === 0 && <p className="text-[11px] text-amber-700 mt-2">{t('events.staff.noRoster')}</p>}
          <div className="flex gap-2 mt-2">
            <button className={BTN_PRIMARY} onClick={() => save(false)}>{t('common.save')}</button>
            <button className={BTN_GHOST} onClick={() => setForm({ ...form, open: false })}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Cancel-with-reason dialog (lost-reason capture) ──────────────────────────
function CancelEventDialog({ restaurantId, token, bookingId, onClose, onCancelled }: Props & { bookingId: string; onClose: () => void; onCancelled: () => void }) {
  const { t } = useT();
  const api = makeApi(restaurantId, token);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const REASONS = ['Price too high', 'Date unavailable', 'Went with competitor', 'Event postponed', 'Customer unresponsive', 'Other'];
  const submit = async (acknowledgeRefund = false) => {
    if (!reason) { alert(t('events.cancel.pickReason')); return; }
    setBusy(true);
    try {
      await api(`/events/bookings/${bookingId}/cancel`, { method: 'POST', body: JSON.stringify({ reason, note, acknowledge_refund: acknowledgeRefund }) });
      onCancelled(); onClose();
    } catch (e: any) {
      // Booking has money collected — confirm the manual refund/reversal, then retry.
      if (e?.data?.requires_refund_ack && !acknowledgeRefund) {
        setBusy(false);
        if (window.confirm(`${e.data.error}\n\nProceed with cancellation?`)) { await submit(true); }
        return;
      }
      alert(e.message); setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm bg-white rounded-2xl border border-[#e8dccf] p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <h3 className="font-bold text-sm mb-3 text-[#14110c]">{t('events.cancel.title')}</h3>
        <label className={LABEL}>{t('events.cancel.reason')}</label>
        <select className={INPUT} value={reason} onChange={e => setReason(e.target.value)} autoFocus>
          <option value="">—</option>{REASONS.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <label className={`${LABEL} mt-2`}>{t('events.cancel.note')}</label>
        <textarea className={INPUT} rows={2} value={note} onChange={e => setNote(e.target.value)} />
        <div className="flex justify-end gap-2 mt-4">
          <button className={BTN_GHOST} onClick={onClose} disabled={busy}>{t('events.cancel.keep')}</button>
          <button className={BTN_DANGER} onClick={() => submit()} disabled={busy || !reason}>{t('events.bookings.cancel')}</button>
        </div>
      </div>
    </div>
  );
}

function EventBookingDetail({ restaurantId, token, bookingId, venues, onBack, onOpenObject }: Props & { bookingId: string; venues: any[]; onBack: () => void; onOpenObject?: (t: string, i: string) => void }) {
  const { t } = useT();
  const api = makeApi(restaurantId, token);
  const [bk, setBk] = useState<any>(null);
  const [rentals, setRentals] = useState<any[]>([]);
  const [services, setServices] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [hotelRooms, setHotelRooms] = useState<any[]>([]);
  const [showHotel, setShowHotel] = useState(false);
  const [sendQuote, setSendQuote] = useState<{ id: string; email: string } | null>(null);
  const [showCancel, setShowCancel] = useState(false);
  const [emailInvoice, setEmailInvoice] = useState(false);
  const [caterPkgs, setCaterPkgs] = useState<any[]>([]);
  const [nonce, setNonce] = useState(0);
  // Venue options for the change-venue selector. Prefer the list passed in; when
  // opened via a drill-down that doesn't pass one (e.g. the dashboard), fetch it.
  const [venueOpts, setVenueOpts] = useState<any[]>(venues || []);
  useEffect(() => {
    if (venues && venues.length) { setVenueOpts(venues); return; }
    api('/events/venues').then((r: any) => setVenueOpts(Array.isArray(r) ? r : [])).catch(() => {});
  }, [venues]);

  const load = async () => { try { setBk(await api(`/events/bookings/${bookingId}${gstReady ? gstQuery() : ''}`)); setNonce(n => n + 1); } catch (e: any) { alert(e.message); } };
  useEffect(() => { load(); api('/events/rental-items').then(setRentals).catch(() => {}); api('/events/services').then(setServices).catch(() => {}); api('/events/catering-packages').then(setCaterPkgs).catch(() => {}); }, [bookingId]);

  // Catering line helpers (parallel to rentals/services). pax defaults to the
  // booking's guest_count for a sensible starting quantity.
  const cateringArray = () => (bk.catering || []).map((x: any) => ({ package_id: x.package_id, pax: x.pax, price_per_plate: x.price_per_plate }));
  const addCatering = async (pkgId: string) => {
    const p = caterPkgs.find(x => x.id === pkgId); if (!p) return;
    const arr = cateringArray();
    arr.push({ package_id: pkgId, pax: Number(bk.guest_count || 0) || 1, price_per_plate: p.price_per_plate });
    await api(`/events/bookings/${bookingId}`, { method: 'PUT', body: JSON.stringify({ catering: arr }) });
    await load();
  };
  const commitCatering = async (idx: number, field: string, value: string) => {
    const arr = cateringArray(); if (!arr[idx]) return;
    const num = Math.max(0, Number(value) || 0);
    if (Number(arr[idx][field]) === num) return;
    arr[idx] = { ...arr[idx], [field]: num };
    await api(`/events/bookings/${bookingId}`, { method: 'PUT', body: JSON.stringify({ catering: arr }) });
    await load();
  };
  const removeCatering = async (idx: number) => {
    const arr = cateringArray(); arr.splice(idx, 1);
    await api(`/events/bookings/${bookingId}`, { method: 'PUT', body: JSON.stringify({ catering: arr }) });
    await load();
  };

  const addRental = async (itemId: string) => {
    const it = rentals.find(r => r.id === itemId); if (!it) return;
    const items = (bk.items || []).map((x: any) => ({ rental_item_id: x.rental_item_id, quantity: x.quantity, rate_basis: x.rate_basis, unit_rate: x.unit_rate, duration_units: x.duration_units }));
    items.push({ rental_item_id: itemId, quantity: 1, rate_basis: 'DAILY', unit_rate: it.rent_daily, duration_units: 1 });
    await api(`/events/bookings/${bookingId}`, { method: 'PUT', body: JSON.stringify({ items }) });
    await load();
  };
  const addService = async (svcId: string) => {
    const sv = services.find(s => s.id === svcId); if (!sv) return;
    const svc = (bk.services || []).map((x: any) => ({ service_id: x.service_id, quantity: x.quantity, unit_rate: x.unit_rate }));
    svc.push({ service_id: svcId, quantity: 1, unit_rate: sv.rate });
    await api(`/events/bookings/${bookingId}`, { method: 'PUT', body: JSON.stringify({ services: svc }) });
    await load();
  };
  const removeLine = async (kind: 'items' | 'services', idx: number) => {
    const src = kind === 'items'
      ? (bk.items || []).map((x: any) => ({ rental_item_id: x.rental_item_id, quantity: x.quantity, rate_basis: x.rate_basis, unit_rate: x.unit_rate, duration_units: x.duration_units }))
      : (bk.services || []).map((x: any) => ({ service_id: x.service_id, quantity: x.quantity, unit_rate: x.unit_rate }));
    src.splice(idx, 1);
    await api(`/events/bookings/${bookingId}`, { method: 'PUT', body: JSON.stringify({ [kind]: src }) });
    await load();
  };
  // Inline-edit a rental/service line's quantity or unit price (owner override).
  const commitLine = async (kind: 'items' | 'services', idx: number, field: string, value: string) => {
    const src = kind === 'items'
      ? (bk.items || []).map((x: any) => ({ rental_item_id: x.rental_item_id, quantity: x.quantity, rate_basis: x.rate_basis, unit_rate: x.unit_rate, duration_units: x.duration_units }))
      : (bk.services || []).map((x: any) => ({ service_id: x.service_id, quantity: x.quantity, unit_rate: x.unit_rate }));
    if (!src[idx]) return;
    const num = Math.max(0, Number(value) || 0);
    if (Number(src[idx][field]) === num) return; // no-op, avoids a PUT on every blur
    src[idx] = { ...src[idx], [field]: num };
    await api(`/events/bookings/${bookingId}`, { method: 'PUT', body: JSON.stringify({ [kind]: src }) });
    await load();
  };
  const commitDiscount = async (value: string) => {
    // Clamp to [0, subtotal] so the discount can never exceed the bill. The
    // pre-tax subtotal comes from the backend bill breakdown (falls back to
    // deriving it from total_amount for older API responses).
    const sub = Number(bk.bill?.subtotal ?? (Number(bk.total_amount || 0) + Number(bk.discount || 0)));
    const num = Math.min(sub, Math.max(0, Number(value) || 0));
    if (Number(bk.discount || 0) === num) return;
    // The server enforces a hard below-cost guard; surface a rejection and revert.
    try {
      await api(`/events/bookings/${bookingId}`, { method: 'PUT', body: JSON.stringify({ discount: num }) });
      await load();
    } catch (e: any) { alert(e.message); await load(); }
  };
  // Inline-edit a customer contact field (name / phone / email / GSTIN). The
  // booking PUT already whitelists these; capturing the email here is what lets
  // the tenant email the quotation & invoice to the customer.
  const commitContact = async (field: string, value: string) => {
    const v = value.trim();
    if (String(bk[field] || '') === v) return;
    await api(`/events/bookings/${bookingId}`, { method: 'PUT', body: JSON.stringify({ [field]: v }) });
    await load();
  };
  // Change the venue after creation — the backend re-resolves the venue charge for
  // the new hall (and re-runs the conflict check for held bookings). Surfaces a
  // 409 (double-booked / blocked) instead of failing silently.
  const commitVenue = async (venueId: string) => {
    if (String(bk.venue_id || '') === String(venueId || '')) return;
    try {
      await api(`/events/bookings/${bookingId}`, { method: 'PUT', body: JSON.stringify({ venue_id: venueId || null }) });
      await load();
    } catch (e: any) { alert(e.message); await load(); }
  };

  const loadHotel = async () => {
    try { const r = await api(`/events/bookings/${bookingId}/hotel-availability`); setHotelRooms(r?.room_types || []); setShowHotel(true); if (!r.hotel_enabled) alert('Hotel module is not enabled for this property.'); }
    catch (e: any) { alert(e.message); }
  };
  const addRoom = async (roomTypeId: string | null, name: string, rate: number, rooms: number) => {
    await api(`/events/bookings/${bookingId}/rooms`, { method: 'POST', body: JSON.stringify({ room_type_id: roomTypeId, room_type_snapshot: name, quoted_rate: Number(rate) || 0, num_rooms: Math.max(1, Number(rooms) || 1) }) });
    await load();
  };
  const updateRoom = async (rid: string, patch: any) => {
    try { await api(`/events/bookings/${bookingId}/rooms/${rid}`, { method: 'PUT', body: JSON.stringify(patch) }); await load(); } catch (e: any) { alert(e.message); }
  };
  const removeRoom = async (rid: string) => { try { await api(`/events/bookings/${bookingId}/rooms/${rid}`, { method: 'DELETE' }); await load(); } catch (e: any) { alert(e.message); } };
  const dOnly = (v: any) => String(v || '').slice(0, 10);

  // Per-document GST override for THIS quotation / invoice. Defaults to the
  // tenant's Event GST setting; the user can disable GST or change the % for just
  // this document. Hotel rooms always keep their hotel-GST snapshot.
  const [docGst, setDocGst] = useState<{ enabled: boolean; pct: number }>({ enabled: true, pct: 18 });
  // gstReady flips once the tenant default has loaded — until then the bill fetch
  // sends NO override so the ledger shows the true default, not the {enabled,18}
  // placeholder above.
  const [gstReady, setGstReady] = useState(false);
  useEffect(() => { api('/events/gst-settings').then((r: any) => { setDocGst({ enabled: Number(r.gst_enabled ?? 1) !== 0, pct: Number(r.gst_percent ?? 18) }); setGstReady(true); }).catch(() => setGstReady(true)); }, []);
  // Re-fetch the bill whenever the Invoice-GST toggle changes so the ledger
  // (GST line + grand total) live-previews exactly what will be invoiced.
  useEffect(() => { if (gstReady) load(); }, [gstReady, docGst.enabled, docGst.pct]); // eslint-disable-line react-hooks/exhaustive-deps
  const gstBody = () => ({ gst_enabled: docGst.enabled, gst_percent: docGst.pct });
  const gstQuery = () => `?gst_enabled=${docGst.enabled ? 1 : 0}&gst_percent=${docGst.pct}`;

  const runAct = async (path: string, body: any, okMsg?: string) => {
    const r = await api(`/events/bookings/${bookingId}/${path}`, { method: 'POST', body: JSON.stringify(body) });
    if (r?.warning) alert(r.warning); else if (okMsg) alert(okMsg);
    await load();
  };
  const act = async (path: string, okMsg?: string, extraBody?: any) => {
    setBusy(true);
    try {
      await runAct(path, { ...(extraBody || {}) }, okMsg);
    } catch (e: any) {
      const d = e?.data;
      // Housekeeping gate: the venue still has an open cleaning job from a prior
      // event. A manager/owner may override — re-send confirm with override_cleaning.
      if (d?.housekeeping_blocked && d?.can_override) {
        if (window.confirm(`${d.error}\n\nConfirm this booking anyway and override the venue's pending housekeeping?`)) {
          try { await runAct(path, { ...(extraBody || {}), override_cleaning: true }, okMsg); }
          catch (e2: any) { alert(e2.message); }
        }
      } else if (d?.housekeeping_blocked) {
        alert(`${d.error}\n\nOpen Housekeeping → Worklist (or Events → Cleaning Checklist) to finish the venue's cleaning, then confirm again.`);
      } else {
        alert(e.message);
      }
    } finally { setBusy(false); }
  };
  const genQuote = async () => {
    setBusy(true);
    try { const q = await api(`/events/bookings/${bookingId}/quotations`, { method: 'POST', body: JSON.stringify(gstBody()) }); await openAuthedPdf(`/api/restaurant/${restaurantId}/events/quotations/${q.id}/pdf`, token); await load(); }
    catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };

  if (!bk) return <div className="text-sm text-[#6b5d52]">{t('common.loading')}</div>;
  const editable = bk.status !== 'COMPLETED' && bk.status !== 'CANCELLED';
  // Payments stay collectable after the event is over (customers often settle the
  // balance post-event); only a cancelled booking freezes money-in, matching the
  // backend payment guard.
  const canRecordPayment = bk.status !== 'CANCELLED';
  // Bill ledger figures come from the backend breakdown (subtotal / GST / discount
  // / grand). total_amount is now the tax-inclusive grand total; older responses
  // without `bill` fall back to deriving from total_amount (treated as pre-tax).
  const bill = bk.bill || { subtotal: Number(bk.total_amount || 0) + Number(bk.discount || 0), tax: 0, discount: Number(bk.discount || 0), grand: Number(bk.total_amount || 0) };
  const evSubtotal = Number(bill.subtotal || 0);
  const evTax = Number(bill.tax || 0);
  const evDiscount = Number(bill.discount || 0);
  const evGrand = Number(bill.grand ?? bk.total_amount ?? 0);
  const evPct = evSubtotal > 0 ? Math.round((evDiscount / evSubtotal) * 100) : 0;
  const hasEmail = !!(bk.customer_email && String(bk.customer_email).trim());
  // Multi-day venue breakdown — when a DAILY booking spans more than one day, show
  // the day count (and the per-day rate when it divides evenly) so the venue total
  // reads as rate × days rather than an opaque lump sum.
  const evDays = (() => { const s = dOnly(bk.event_date); const e = bk.end_date ? dOnly(bk.end_date) : s; if (!e || e <= s) return 1; return Math.max(1, Math.round((Date.parse(e + 'T00:00:00Z') - Date.parse(s + 'T00:00:00Z')) / 86400000) + 1); })();
  const evVenueRate = Number(bk.venue_rate || 0);
  const evPerDay = evDays > 0 ? evVenueRate / evDays : evVenueRate;
  const evUniform = Math.abs(evPerDay * evDays - evVenueRate) < 0.5;
  // Event span multiplier — mirrors the backend eventUnits(): rentals + services
  // bill per hour (HOURLY) / per day (DAILY multi-day), so the itemized lines
  // reconcile with the bill subtotal. HALF_DAY / single-day → 1.
  const evUnits = (() => {
    const basis = String(bk.venue_rate_basis || 'DAILY').toUpperCase();
    if (basis === 'HALF_DAY') return 1;
    if (basis === 'HOURLY') { const m = (t: any) => { const [h, mm] = String(t ?? '').split(':'); const H = Number(h), M = Number(mm); return (isFinite(H) ? H : 0) * 60 + (isFinite(M) ? M : 0); }; const mins = m(bk.end_time) - m(bk.start_time); return mins > 0 ? Math.max(1, Math.round(mins / 60)) : 1; }
    return evDays;
  })();
  const rentalUnitsFor = (it: any) => { const d = Number(it.duration_units || 1); return d > 1 ? d : Math.max(1, evUnits); };
  const spanWord = String(bk.venue_rate_basis || 'DAILY').toUpperCase() === 'HOURLY' ? 'hr' : 'day';
  const spanNote = (n: number) => n > 1 ? ` × ${n} ${spanWord}${n === 1 ? '' : 's'}` : '';

  return (
    <ObjectDetail
      title={bk.customer_name}
      subtitle={`${bk.venue_name || '—'} · ${dOnly(bk.event_date)}${bk.end_date && dOnly(bk.end_date) > dOnly(bk.event_date) ? ` → ${dOnly(bk.end_date)}` : ''} · ${bk.start_time}–${bk.end_time} · ${bk.guest_count} ${t('events.bookings.guests').toLowerCase()}`}
      statusPill={<Pill status={bk.status} />}
      onBack={onBack}
      backLabel={t('events.bookings.title')}
      token={token}
      auditUrl={`/api/restaurant/${restaurantId}/events/bookings/${bookingId}/audit`}
      whereUsedUrl={`/api/restaurant/${restaurantId}/events/bookings/${bookingId}/where-used`}
      onOpenObject={onOpenObject}
      refreshNonce={nonce}
      overview={
      <div>
      <div className={`${CARD} mb-4`}>
        <div className="grid md:grid-cols-[1fr_16rem] gap-4 items-start">
          {/* Customer + editable contact — the email captured here is the recipient
              for the emailed quotation & invoice. */}
          <div>
            <h3 className="text-lg font-bold text-[#14110c]">{bk.customer_name}</h3>
            {editable ? (
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-md">
                <label className="block">
                  <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[#9d8b7e]"><Phone size={11} />{t('events.bookings.phone')}</span>
                  <input defaultValue={bk.customer_phone || ''} onBlur={e => commitContact('customer_phone', e.target.value)} placeholder="+91 ..."
                    className="mt-0.5 w-full px-2 py-1 rounded-lg border border-[#e8dccf] text-xs" />
                </label>
                <label className="block">
                  <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[#9d8b7e]"><Mail size={11} />{t('events.bookings.email')}</span>
                  <input type="email" defaultValue={bk.customer_email || ''} onBlur={e => commitContact('customer_email', e.target.value)} placeholder="name@email.com"
                    className={`mt-0.5 w-full px-2 py-1 rounded-lg border text-xs ${hasEmail ? 'border-[#e8dccf]' : 'border-amber-300 bg-amber-50'}`} />
                </label>
                {/* Venue is editable after creation — changing it recalculates the venue charge. */}
                <label className="block sm:col-span-2">
                  <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[#9d8b7e]"><Building2 size={11} />{t('events.bookings.venue')}</span>
                  <select value={bk.venue_id || ''} onChange={e => commitVenue(e.target.value)}
                    className="mt-0.5 w-full px-2 py-1 rounded-lg border border-[#e8dccf] text-xs bg-white">
                    <option value="">—</option>
                    {venueOpts.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                  <span className="mt-0.5 block text-[10px] text-[#9d8b7e]">{t('events.bookings.venueEditHint')}</span>
                </label>
              </div>
            ) : (
              <p className="text-xs text-[#6b5d52]">{bk.customer_phone || '—'}{bk.customer_email ? ` · ${bk.customer_email}` : ''}</p>
            )}
            {editable && !hasEmail && (
              <p className="mt-1.5 flex items-center gap-1 text-[11px] text-amber-700">
                <AlertTriangle size={12} />{t('events.bookings.emailHint')}
              </p>
            )}
          </div>

          {/* Bill summary ledger — makes subtotal, discount and grand total legible. */}
          <div className="rounded-xl bg-[#faf7f2] border border-[#e8dccf] p-3">
            {/* Venue rent line — for a multi-day DAILY booking, spell out rate × days. */}
            {evVenueRate > 0 && (
              <div className="flex items-center justify-between text-xs text-[#6b5d52] mb-0.5">
                <span>{t('events.bookings.venue')}{bk.venue_rate_basis === 'DAILY' && evDays > 1 ? ` · ${evDays} days` : bk.venue_rate_basis === 'HALF_DAY' ? ` · ${bk.half_day_slot || 'AM'}` : bk.venue_rate_basis === 'HOURLY' ? ' · hourly' : ''}</span>
                <span className="tabular-nums">{money(evVenueRate)}</span>
              </div>
            )}
            {evVenueRate > 0 && bk.venue_rate_basis === 'DAILY' && evDays > 1 && (
              <div className="text-[10px] text-[#9d8b7e] text-right mb-1.5 tabular-nums">{evUniform ? `${money(evPerDay)} × ${evDays} days` : `across ${evDays} days`}</div>
            )}
            <div className="flex items-center justify-between text-xs text-[#6b5d52] mb-1.5">
              <span>{t('events.bookings.subtotal')}</span>
              <span className="tabular-nums">{money(evSubtotal)}</span>
            </div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-[#6b5d52]">{t('events.bookings.discount')}</span>
              {editable ? (
                <span className="flex items-center gap-1">
                  <span className="text-xs text-rose-500">− ₹</span>
                  {/* key remounts the uncontrolled input when the persisted discount
                      changes (e.g. after a below-cost rejection reverts it). */}
                  <input key={`disc-${evDiscount}`} type="number" min={0} max={evSubtotal} defaultValue={evDiscount} onBlur={e => commitDiscount(e.target.value)}
                    className="w-20 px-1.5 py-0.5 rounded-lg border border-[#e8dccf] text-right text-xs tabular-nums" />
                </span>
              ) : (
                <span className="text-xs text-rose-500 tabular-nums">{evDiscount > 0 ? `− ${money(evDiscount)}` : money(0)}</span>
              )}
            </div>
            {evDiscount > 0 && (
              <div className="flex items-center justify-end gap-1 text-[10px] text-emerald-700 mb-1.5">
                <Check size={11} />{t('events.bookings.saved', { amount: money(evDiscount), pct: evPct })}
              </div>
            )}
            {/* GST line — shown only when tax applies. Booking total now matches
                the quotation/invoice (subtotal + GST − discount). */}
            {evTax > 0 && (
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-[#6b5d52]">{t('events.bookings.gst')}</span>
                <span className="text-xs text-[#6b5d52] tabular-nums">+ {money(evTax)}</span>
              </div>
            )}
            <div className="h-px bg-[#e8dccf] my-1.5" />
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold text-[#14110c]">{t('events.bookings.grandTotal')}</span>
              <span className="text-2xl font-bold text-[#cc5a16] tabular-nums">{money(evGrand)}</span>
            </div>
            <p className="mt-1.5 text-[10px] text-[#9d8b7e] text-right">{evTax > 0 ? t('events.bookings.gstInclNote') : t('events.bookings.gstNote')}</p>
          </div>
        </div>
      </div>

      {editable && (
        <div className={`${CARD} mb-4`}>
          <h3 className="font-bold text-sm flex items-center gap-1.5 mb-2 text-[#14110c]"><CalendarRange size={15} />{t('events.bookings.schedule')}</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div><label className={LABEL}>{t('events.bookings.eventDate')}</label>
              <input type="date" className={INPUT} defaultValue={dOnly(bk.event_date)} onBlur={e => commitContact('event_date', e.target.value)} /></div>
            <div><label className={LABEL}>{t('events.bookings.endDate')}</label>
              <input type="date" className={INPUT} min={dOnly(bk.event_date)} defaultValue={bk.end_date ? dOnly(bk.end_date) : ''} onBlur={e => commitContact('end_date', e.target.value)} />
              <p className="text-[10px] text-[#9d8b7e] mt-0.5">{t('events.bookings.endDateHint')}</p></div>
            <div><label className={LABEL}>{t('events.bookings.startTime')}</label>
              <input type="time" className={INPUT} defaultValue={bk.start_time || ''} onBlur={e => commitContact('start_time', e.target.value)} /></div>
            <div><label className={LABEL}>{t('events.bookings.endTime')}</label>
              <input type="time" className={INPUT} defaultValue={bk.end_time || ''} onBlur={e => commitContact('end_time', e.target.value)} /></div>
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {/* Rentals */}
        <div className={CARD}>
          <div className="flex items-center justify-between mb-2"><h3 className="font-bold text-sm flex items-center gap-1.5"><Sofa size={15} />{t('events.bookings.rentals')}</h3>
            {editable && <select className={`${INPUT} w-auto text-xs`} value="" onChange={e => e.target.value && addRental(e.target.value)}>
              <option value="">+ {t('common.add')}</option>{rentals.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>}</div>
          {(bk.items || []).length === 0 ? <p className="text-xs text-[#9d8b7e]">—</p> : (bk.items || []).map((it: any, i: number) => (
            <div key={it.id} className="flex items-center gap-1.5 text-xs py-1 border-b border-[#f0e9df]">
              <span className="flex-1 min-w-0 truncate">{it.name_snapshot} <span className="text-[#9d8b7e]">({it.rate_basis}{spanNote(rentalUnitsFor(it))})</span></span>
              {editable ? (
                <>
                  <input type="number" min={0} defaultValue={it.quantity} title="Qty" onBlur={e => commitLine('items', i, 'quantity', e.target.value)} className="w-11 px-1 py-0.5 rounded border border-[#e8dccf] text-right" />
                  <span className="text-[#9d8b7e]">×₹</span>
                  <input type="number" min={0} defaultValue={it.unit_rate} title="Unit price" onBlur={e => commitLine('items', i, 'unit_rate', e.target.value)} className="w-16 px-1 py-0.5 rounded border border-[#e8dccf] text-right" />
                </>
              ) : <span className="text-[#9d8b7e]">{it.quantity} × {money(it.unit_rate)}{spanNote(rentalUnitsFor(it))}</span>}
              <span className="w-16 text-right font-semibold">{money(Number(it.unit_rate || 0) * Number(it.quantity || 1) * rentalUnitsFor(it))}</span>
              {editable && <button onClick={() => removeLine('items', i)}><X size={12} className="text-rose-500" /></button>}
            </div>
          ))}
        </div>

        {/* Services */}
        <div className={CARD}>
          <div className="flex items-center justify-between mb-2"><h3 className="font-bold text-sm flex items-center gap-1.5"><Users size={15} />{t('events.bookings.services')}</h3>
            {editable && <select className={`${INPUT} w-auto text-xs`} value="" onChange={e => e.target.value && addService(e.target.value)}>
              <option value="">+ {t('common.add')}</option>{services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>}</div>
          {(bk.services || []).length === 0 ? <p className="text-xs text-[#9d8b7e]">—</p> : (bk.services || []).map((sv: any, i: number) => (
            <div key={sv.id} className="flex items-center gap-1.5 text-xs py-1 border-b border-[#f0e9df]">
              <span className="flex-1 min-w-0 truncate">{sv.name_snapshot}{evUnits > 1 ? <span className="text-[#9d8b7e]"> ({spanNote(evUnits).trim()})</span> : null}</span>
              {editable ? (
                <>
                  <input type="number" min={0} defaultValue={sv.quantity} title="Qty" onBlur={e => commitLine('services', i, 'quantity', e.target.value)} className="w-11 px-1 py-0.5 rounded border border-[#e8dccf] text-right" />
                  <span className="text-[#9d8b7e]">×₹</span>
                  <input type="number" min={0} defaultValue={sv.unit_rate} title="Unit price" onBlur={e => commitLine('services', i, 'unit_rate', e.target.value)} className="w-16 px-1 py-0.5 rounded border border-[#e8dccf] text-right" />
                </>
              ) : <span className="text-[#9d8b7e]">{sv.quantity} × {money(sv.unit_rate)}{spanNote(evUnits)}</span>}
              <span className="w-16 text-right font-semibold">{money(Number(sv.unit_rate || 0) * Number(sv.quantity || 1) * Math.max(1, evUnits))}</span>
              {editable && <button onClick={() => removeLine('services', i)}><X size={12} className="text-rose-500" /></button>}
            </div>
          ))}
        </div>

        {/* Catering */}
        <div className={`${CARD} md:col-span-2`}>
          <div className="flex items-center justify-between mb-2"><h3 className="font-bold text-sm flex items-center gap-1.5"><Utensils size={15} />{t('events.bookings.catering')}</h3>
            {editable && <select className={`${INPUT} w-auto text-xs`} value="" onChange={e => e.target.value && addCatering(e.target.value)}>
              <option value="">+ {t('common.add')}</option>{caterPkgs.map(p => <option key={p.id} value={p.id}>{p.name} ({p.package_type})</option>)}
            </select>}</div>
          {(bk.catering || []).length === 0 ? <p className="text-xs text-[#9d8b7e]">—</p> : (bk.catering || []).map((c: any, i: number) => (
            <div key={c.id} className="flex items-center gap-1.5 text-xs py-1 border-b border-[#f0e9df]">
              <span className="flex-1 min-w-0 truncate">{c.name_snapshot} <span className="text-[#9d8b7e]">({c.package_type_snapshot})</span></span>
              {editable ? (
                <>
                  <input type="number" min={0} defaultValue={c.pax} title={t('events.catering.pax')} onBlur={e => commitCatering(i, 'pax', e.target.value)} className="w-14 px-1 py-0.5 rounded border border-[#e8dccf] text-right" />
                  <span className="text-[#9d8b7e]">×₹</span>
                  <input type="number" min={0} defaultValue={c.price_per_plate} title={t('events.catering.pricePerPlate')} onBlur={e => commitCatering(i, 'price_per_plate', e.target.value)} className="w-16 px-1 py-0.5 rounded border border-[#e8dccf] text-right" />
                </>
              ) : <span className="text-[#9d8b7e]">{c.pax} × {money(c.price_per_plate)}</span>}
              <span className="w-16 text-right font-semibold">{money(c.line_total)}</span>
              {editable && <button onClick={() => removeCatering(i)}><X size={12} className="text-rose-500" /></button>}
            </div>
          ))}
        </div>

        {/* Hotel rooms */}
        <div className={`${CARD} md:col-span-2`}>
          <div className="flex items-center justify-between mb-2"><h3 className="font-bold text-sm flex items-center gap-1.5"><Hotel size={15} />{t('events.bookings.hotelRooms')}</h3>
            {editable && <button className={BTN_GHOST} onClick={loadHotel}><Plus size={13} />{t('events.bookings.addHotelRooms')}</button>}</div>
          {(bk.rooms || []).length === 0 ? <p className="text-xs text-[#9d8b7e]">—</p> : (bk.rooms || []).map((rm: any) => {
            const roomEditable = editable && rm.status !== 'BOOKED';
            return (
              <div key={rm.id} className="flex items-center gap-1.5 text-xs py-1 border-b border-[#f0e9df]">
                <span className="flex-1 min-w-0 truncate">{rm.room_type_snapshot} <span className="text-[#9d8b7e]">({dOnly(rm.check_in_date)} → {dOnly(rm.check_out_date)})</span> <Pill status={rm.status} /></span>
                {roomEditable ? (
                  <>
                    <input type="number" min={1} defaultValue={rm.num_rooms} title="Rooms" onBlur={e => updateRoom(rm.id, { num_rooms: Number(e.target.value) })} className="w-11 px-1 py-0.5 rounded border border-[#e8dccf] text-right" />
                    <span className="text-[#9d8b7e]">×₹</span>
                    <input type="number" min={0} defaultValue={rm.quoted_rate} title="Rate / night" onBlur={e => updateRoom(rm.id, { quoted_rate: Number(e.target.value) })} className="w-16 px-1 py-0.5 rounded border border-[#e8dccf] text-right" />
                  </>
                ) : <span className="text-[#9d8b7e]">{rm.num_rooms} × {money(rm.quoted_rate)}</span>}
                <span className="w-16 text-right font-semibold">{money(rm.line_total)}</span>
                {roomEditable && <button onClick={() => removeRoom(rm.id)}><X size={12} className="text-rose-500" /></button>}
              </div>
            );
          })}
          {showHotel && (
            <div className="mt-2 p-2 rounded-xl bg-[#faf7f2] border border-[#e8dccf]">
              {hotelRooms.length === 0
                ? <p className="text-xs text-[#9d8b7e]">No hotel rooms available. Is the Hotel module enabled with rooms set up for these dates?</p>
                : hotelRooms.map((rt: any, idx: number) => (
                  <div key={rt.room_type_id || idx}>
                    <HotelRoomAddRow rt={rt} onAdd={(rate, rooms) => addRoom(rt.room_type_id, rt.name, rate, rooms)} />
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>

      {/* Payment schedule + receipts */}
      <PaymentPanel restaurantId={restaurantId} token={token} booking={bk} editable={editable} canRecord={canRecordPayment} onChanged={load} />

      {/* Staff rostering — assign roster staff to the event per working date */}
      <StaffPanel restaurantId={restaurantId} token={token} booking={bk} editable={editable} onChanged={load} />

      {/* GST override for the quotation / invoice generated next */}
      <div className="flex flex-wrap items-center gap-3 mt-4 mb-1 px-3 py-2 rounded-lg bg-[#faf6f1] border border-[#efe6db]">
        <span className="text-[11px] font-bold text-[#6b5d52] uppercase tracking-wide">Invoice GST</span>
        <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={docGst.enabled} onChange={e => setDocGst({ ...docGst, enabled: e.target.checked })} />Charge GST</label>
        <label className="flex items-center gap-1.5 text-xs">%<input type="number" min={0} max={28} step={0.5} disabled={!docGst.enabled} className={`${INPUT} w-20 py-1`} value={docGst.pct} onChange={e => setDocGst({ ...docGst, pct: Number(e.target.value) })} /></label>
        <span className="text-[10px] text-[#9d8b7e]">Applies to the quotation / invoice you generate next. Hotel rooms follow Hotel GST.</span>
      </div>

      {/* Lifecycle actions */}
      <div className="flex flex-wrap gap-2 mt-1">
        <button className={BTN_GHOST} disabled={busy} onClick={genQuote}><FileText size={13} />{t('events.bookings.generateQuote')}</button>
        <button className={BTN_GHOST} onClick={() => openAuthedPdf(`/api/restaurant/${restaurantId}/events/bookings/${bookingId}/beo.pdf`, token)}><ClipboardList size={13} />{t('events.bookings.beo')}</button>
        <button className={BTN_GHOST} onClick={() => openAuthedPdf(`/api/restaurant/${restaurantId}/events/bookings/${bookingId}/invoice.pdf${gstQuery()}`, token)}><FileText size={13} />{t('events.bookings.invoice')}</button>
        <button className={BTN_GHOST} onClick={() => setEmailInvoice(true)}><Send size={13} />{t('events.bookings.emailInvoice')}</button>
        {(bk.status === 'INQUIRY' || bk.status === 'QUOTED') && <button className={BTN_PRIMARY} disabled={busy} onClick={() => act('confirm')}><Check size={13} />{t('events.bookings.confirm')}</button>}
        {(bk.status === 'CONFIRMED' || bk.status === 'IN_PROGRESS') && <button className={BTN_PRIMARY} disabled={busy} onClick={() => act('checkout', undefined, gstBody())}><IndianRupee size={13} />{t('events.bookings.checkout')}</button>}
        {(bk.status === 'CONFIRMED' || bk.status === 'IN_PROGRESS') && <button className={BTN_GHOST} disabled={busy} onClick={() => act('complete')}>{t('events.bookings.complete')}</button>}
        {editable && <button className={BTN_DANGER} disabled={busy} onClick={() => setShowCancel(true)}>{t('events.bookings.cancel')}</button>}
      </div>

      {showCancel && (
        <CancelEventDialog restaurantId={restaurantId} token={token} bookingId={bookingId}
          onClose={() => setShowCancel(false)} onCancelled={() => load()} />
      )}

      {emailInvoice && (
        <SendQuoteDialog restaurantId={restaurantId} token={token} sendUrl={`/events/bookings/${bookingId}/invoice/send`} defaultEmail={bk.customer_email || ''}
          onClose={() => setEmailInvoice(false)} onSent={(to) => alert(`${t('events.quotes.sent')} ${to}`)} />
      )}

      {(bk.quotations || []).length > 0 && (
        <div className={`${CARD} mt-4`}>
          <h3 className="font-bold text-sm mb-2 flex items-center gap-1.5"><ClipboardList size={15} />{t('events.quotes.title')}</h3>
          {(bk.quotations || []).map((q: any) => (
            <div key={q.id} className="flex items-center justify-between text-xs py-1 border-b border-[#f0e9df]">
              <span>{q.quote_number} (v{q.version}) — {money(q.grand_total)} <Pill status={q.status} /></span>
              <span className="flex gap-1">
                {onOpenObject && <button className={BTN_GHOST} onClick={() => onOpenObject('EVENT_QUOTATION', q.id)}>Open</button>}
                <button className={BTN_GHOST} onClick={() => openAuthedPdf(`/api/restaurant/${restaurantId}/events/quotations/${q.id}/pdf`, token)}>{t('events.quotes.viewPdf')}</button>
                <button className={BTN_PRIMARY} onClick={() => setSendQuote({ id: q.id, email: bk.customer_email || '' })}><Send size={12} />{t('events.quotes.send')}</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {sendQuote && (
        <SendQuoteDialog restaurantId={restaurantId} token={token} quotationId={sendQuote.id} defaultEmail={sendQuote.email}
          onClose={() => setSendQuote(null)} onSent={(to) => { alert(`${t('events.quotes.sent')} ${to}`); load(); }} />
      )}
      </div>
      }
    />
  );
}

// ── Quotation detail (ObjectDetail Overview + Audit + Where Used) ────────────
function EventQuotationDetail({ restaurantId, token, quotationId, onBack, onOpenObject }: Props & { quotationId: string; onBack: () => void; onOpenObject?: (t: string, i: string) => void }) {
  const { t } = useT();
  const api = makeApi(restaurantId, token);
  const [q, setQ] = useState<any>(null);
  useEffect(() => { api(`/events/quotations/${quotationId}`).then(setQ).catch((e: any) => alert(e.message)); }, [quotationId]);
  if (!q) return <div className="text-sm text-[#6b5d52]">{t('common.loading')}</div>;
  return (
    <ObjectDetail
      title={`${t('events.quotes.number')} ${q.quote_number}`}
      subtitle={`v${q.version} · ${t('events.quotes.validUntil')} ${String(q.valid_until || '').slice(0, 10)}`}
      statusPill={<Pill status={q.status} />}
      onBack={onBack}
      backLabel={t('events.quotes.title')}
      token={token}
      auditUrl={`/api/restaurant/${restaurantId}/events/quotations/${quotationId}/audit`}
      whereUsedUrl={`/api/restaurant/${restaurantId}/events/quotations/${quotationId}/where-used`}
      onOpenObject={onOpenObject}
      overview={
        <div>
          <div className={`${CARD} mb-4 flex items-center justify-between`}>
            <div className="text-sm">
              <div className="font-bold">{q.quote_number} <span className="text-[#9d8b7e] font-normal">v{q.version}</span></div>
              <div className="text-xs text-[#6b5d52]">Subtotal {money(q.subtotal)} · GST {money(q.tax_amount)}{Number(q.discount) > 0 ? ` · Disc ${money(q.discount)}` : ''}</div>
            </div>
            <div className="text-right"><div className="text-2xl font-bold text-[#cc5a16]">{money(q.grand_total)}</div></div>
          </div>
          <div className={CARD}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-bold text-sm">Line items</h3>
              <button className={BTN_GHOST} onClick={() => openAuthedPdf(`/api/restaurant/${restaurantId}/events/quotations/${quotationId}/pdf`, token)}>{t('events.quotes.viewPdf')}</button>
            </div>
            {(q.lines || []).map((l: any) => (
              <div key={l.id} className="flex items-center justify-between text-xs py-1 border-b border-[#f0e9df]">
                <span>{l.description} <span className="text-[#9d8b7e]">({l.line_type})</span></span>
                <span>{money(l.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      }
    />
  );
}

// ── Event folio (invoice) detail (ObjectDetail Overview + Audit + Where Used) ─
function EventFolioDetail({ restaurantId, token, folioId, onBack, onOpenObject }: Props & { folioId: string; onBack: () => void; onOpenObject?: (t: string, i: string) => void }) {
  const { t } = useT();
  const api = makeApi(restaurantId, token);
  const [f, setF] = useState<any>(null);
  useEffect(() => { api(`/events/folios/${folioId}`).then(setF).catch((e: any) => alert(e.message)); }, [folioId]);
  if (!f) return <div className="text-sm text-[#6b5d52]">{t('common.loading')}</div>;
  return (
    <ObjectDetail
      title={f.invoice_number || folioId}
      subtitle={`Event invoice · ${String(f.created_at || '').slice(0, 10)}`}
      statusPill={<Pill status={f.status} />}
      onBack={onBack}
      backLabel="Invoices"
      token={token}
      auditUrl={`/api/restaurant/${restaurantId}/events/folios/${folioId}/audit`}
      whereUsedUrl={`/api/restaurant/${restaurantId}/events/folios/${folioId}/where-used`}
      onOpenObject={onOpenObject}
      overview={
        <div>
          <div className={`${CARD} mb-4 flex items-start justify-between`}>
            <div>
              <div className="text-sm font-bold">{f.invoice_number || folioId}</div>
              {f.customer_name && (
                <div className="mt-1.5 text-xs text-[#6b5d52]">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-[#9d8b7e]">{t('events.folio.billTo')}</div>
                  <div className="font-semibold text-[#14110c]">{f.customer_name}</div>
                  {(f.customer_phone || f.customer_email) && <div>{f.customer_phone || ''}{f.customer_email ? ` · ${f.customer_email}` : ''}</div>}
                  {f.customer_gstin && <div>GSTIN: {f.customer_gstin}</div>}
                  <div className="mt-0.5 text-[#9d8b7e]">{f.venue_name || '—'}{f.event_date ? ` · ${String(f.event_date).slice(0, 10)}` : ''}</div>
                </div>
              )}
            </div>
            <div className="text-right"><div className="text-2xl font-bold text-[#cc5a16]">{money(f.grand_total)}</div><div className="text-xs text-[#6b5d52]">{t('events.bookings.grandTotal')}</div></div>
          </div>
          <div className={CARD}>
            <h3 className="font-bold text-sm mb-2">Line items</h3>
            {(f.entries || []).map((e: any) => (
              <div key={e.id} className="flex items-center justify-between text-xs py-1 border-b border-[#f0e9df]">
                <span>{e.description} <span className="text-[#9d8b7e]">({e.entry_type})</span></span>
                <span>{money(e.amount)}</span>
              </div>
            ))}
            {(f.payments || []).length > 0 && <h3 className="font-bold text-sm mt-3 mb-2">Payments</h3>}
            {(f.payments || []).map((p: any) => (
              <div key={p.id} className="flex items-center justify-between text-xs py-1 border-b border-[#f0e9df]">
                <span>{p.payment_type} · {p.payment_method}</span>
                <span>{money(p.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      }
    />
  );
}

// ── Router: opens the right ObjectDetail for a {type,id} across event objects ─
function EventObjectRouter({ restaurantId, token, obj, venues, onOpenObject, onBack }: Props & { obj: { type: string; id: string }; venues: any[]; onOpenObject: (t: string, i: string) => void; onBack: () => void }) {
  if (obj.type === 'EVENT_BOOKING') return <EventBookingDetail restaurantId={restaurantId} token={token} bookingId={obj.id} venues={venues} onBack={onBack} onOpenObject={onOpenObject} />;
  if (obj.type === 'EVENT_QUOTATION') return <EventQuotationDetail restaurantId={restaurantId} token={token} quotationId={obj.id} onBack={onBack} onOpenObject={onOpenObject} />;
  if (obj.type === 'FOLIO') return <EventFolioDetail restaurantId={restaurantId} token={token} folioId={obj.id} onBack={onBack} onOpenObject={onOpenObject} />;
  // ROOM_BOOKING and any other type live in another module — surface a note.
  return (
    <div>
      <button className={BTN_GHOST} onClick={onBack}>← Back</button>
      <div className={`${CARD} mt-4`}>
        <p className="text-sm text-[#6b5d52]">This record ({obj.type}) lives in another module. Open it from that module: <span className="font-mono text-xs">{obj.id}</span></p>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// CALENDAR (venue × date grid)
// ════════════════════════════════════════════════════════════════════════
// Status palette mirroring the Hotel availability calendar (Indian-PMS convention).
const EV_CAL = {
  CONFIRMED: { bg: '#fde2e7', fg: '#9f1239', border: '#f9a8b8' },   // assigned / held (coral)
  TENTATIVE: { bg: '#fef3c7', fg: '#92400e', border: '#fbbf24' },   // inquiry / quoted (amber)
  BLOCKED:   { bg: '#e5e7eb', fg: '#374151', border: '#9ca3af' },   // maintenance / hold (grey)
  FREE:      { bg: '#f7faf7', fg: '#1f513f', border: '#dcecdf' },   // available (green tint)
};
const WD = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const todayIso = () => new Date().toISOString().slice(0, 10);

function EventCalendar({ restaurantId, token }: Props) {
  const { t } = useT();
  const api = makeApi(restaurantId, token);
  const [data, setData] = useState<any>(null);
  const [start, setStart] = useState(todayIso());
  const [objStack, setObjStack] = useState<Array<{ type: string; id: string }>>([]);
  // When a venue has >1 booking on a day, clicking opens this chooser so the user
  // can drill into any of them (a single grid cell can't show them all at once).
  const [chooser, setChooser] = useState<{ venueName: string; date: string; bookings: any[] } | null>(null);
  const shift = (n: number) => setStart(new Date(new Date(start + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10));

  const load = async () => {
    try {
      const to = new Date(new Date(start + 'T00:00:00Z').getTime() + 13 * 86400000).toISOString().slice(0, 10);
      setData(await api(`/events/availability?from=${start}&to=${to}`));
    } catch { /* */ }
  };
  useEffect(() => { load(); }, [start]);

  // A booking covers `date` when event_date <= date <= end_date (end_date falls
  // back to event_date for single-day events). This is what makes multi-day and
  // overnight events span across the grid.
  const covers = (b: any, date: string) => {
    const s = String(b.event_date).slice(0, 10);
    const e = b.end_date ? String(b.end_date).slice(0, 10) : s;
    const end = e > s ? e : s;
    return s <= date && date <= end;
  };
  // All active (non-cancelled/completed) bookings covering a venue on a date, with
  // confirmed/in-progress ranked ahead of tentative inquiries/quotes. Returning the
  // full list (not just the first) is what fixes multiple-bookings-per-day.
  const CONFIRMED_ST = ['CONFIRMED', 'IN_PROGRESS'];
  const coveringBookings = (venueId: string, date: string) => (data?.bookings || [])
    .filter((b: any) => b.venue_id === venueId && covers(b, date) && [...CONFIRMED_ST, 'INQUIRY', 'QUOTED'].includes(b.status))
    .sort((a: any, b: any) => (CONFIRMED_ST.includes(a.status) ? 0 : 1) - (CONFIRMED_ST.includes(b.status) ? 0 : 1));
  const cellFor = (venueId: string, date: string) => {
    const blocked = (data?.blocks || []).some((b: any) => b.venue_id === venueId && String(b.from_date).slice(0, 10) <= date && String(b.to_date).slice(0, 10) >= date);
    if (blocked) return { title: t('events.calendar.blocked'), sty: EV_CAL.BLOCKED, booking: null as any, all: [] as any[], isStart: false, count: 0 };
    const all = coveringBookings(venueId, date);
    if (all.length === 0) return { title: t('events.calendar.free'), sty: EV_CAL.FREE, booking: null as any, all, isStart: false, count: 0 };
    const primary = all[0];
    const isConfirmed = CONFIRMED_ST.includes(primary.status);
    const extra = all.length > 1 ? ` (+${all.length - 1} ${t('events.calendar.more')})` : '';
    return { title: `${primary.customer_name} · ${primary.status}${extra}`, sty: isConfirmed ? EV_CAL.CONFIRMED : EV_CAL.TENTATIVE, booking: primary, all, isStart: String(primary.event_date).slice(0, 10) === date, count: all.length };
  };
  const cellName = (b: any) => b.customer_name?.split(' ')[0]?.slice(0, 9) || t('events.calendar.booked');

  // Clicking a booking in the grid drills into its detail (hyperlink behaviour).
  const top = objStack[objStack.length - 1];
  if (top) return (
    <EventObjectRouter
      restaurantId={restaurantId} token={token} obj={top} venues={data?.venues || []}
      onOpenObject={(type, id) => setObjStack(s => [...s, { type, id }])}
      onBack={() => { setObjStack(s => s.slice(0, -1)); load(); }}
    />
  );

  // KPI strip over the visible window.
  const bookings = data?.bookings || [];
  const kConfirmed = bookings.filter((b: any) => ['CONFIRMED', 'IN_PROGRESS'].includes(b.status)).length;
  const kTentative = bookings.filter((b: any) => ['INQUIRY', 'QUOTED'].includes(b.status)).length;
  const kBlocked = (data?.blocks || []).length;
  const kpi = (label: string, value: number, sty: any) => (
    <div className="rounded-xl border px-3 py-2 min-w-[92px]" style={{ background: sty.bg, borderColor: sty.border }}>
      <div className="text-lg font-bold" style={{ color: sty.fg }}>{value}</div>
      <div className="text-[10px]" style={{ color: sty.fg }}>{label}</div>
    </div>
  );
  const dot = (sty: any, label: string) => (
    <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block border" style={{ background: sty.bg, borderColor: sty.border }} />{label}</span>
  );

  return (
    <div>
      <SectionHeader icon={<CalendarRange size={18} />} title={t('events.calendar.title')} sub={t('events.calendar.sub')}
        action={<div className="flex items-center gap-1.5">
          <button className={BTN_GHOST} onClick={() => shift(-14)}>◀</button>
          <button className={BTN_GHOST} onClick={() => setStart(todayIso())}>{t('common.date') === 'Date' ? 'Today' : t('common.date')}</button>
          <input type="date" className={INPUT} value={start} onChange={e => setStart(e.target.value)} />
          <button className={BTN_GHOST} onClick={() => shift(14)}>▶</button>
        </div>} />

      {/* KPI strip */}
      <div className="flex flex-wrap gap-2 mb-3">
        {kpi(t('events.calendar.booked'), kConfirmed, EV_CAL.CONFIRMED)}
        {kpi(t('events.reports.inquiries'), kTentative, EV_CAL.TENTATIVE)}
        {kpi(t('events.calendar.blocked'), kBlocked, EV_CAL.BLOCKED)}
      </div>

      <div className={`${CARD} overflow-x-auto p-0`}>
        {!data ? <p className="text-sm text-[#6b5d52] p-4">{t('common.loading')}</p> : (
          <table className="text-xs border-collapse w-full">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-[#faf7f2] p-2.5 text-left border-b-2 border-[#e8dccf] min-w-[150px]">{t('events.bookings.venue')}</th>
                {(data.dates || []).map((d: string) => {
                  const dow = new Date(d + 'T00:00:00Z').getUTCDay();
                  const isToday = d === todayIso();
                  const weekend = dow === 0 || dow === 6;
                  return (
                    <th key={d} className={`p-1 border-b-2 border-[#e8dccf] min-w-[44px] ${weekend ? 'bg-[#f5efe6]' : 'bg-[#faf7f2]'}`}>
                      <div className={`text-[9px] font-semibold ${weekend ? 'text-[#b5651d]' : 'text-[#9d8b7e]'}`}>{WD[dow]}</div>
                      <div className={`text-[11px] font-bold ${isToday ? 'text-white bg-[#cc5a16] rounded-full w-5 h-5 leading-5 mx-auto' : 'text-[#3d3128]'}`}>{d.slice(8, 10)}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {(data.venues || []).length === 0 ? (
                <tr><td colSpan={(data.dates || []).length + 1} className="p-4 text-center text-[#9d8b7e]">{t('events.venues.empty')}</td></tr>
              ) : (data.venues || []).map((v: any) => (
                <tr key={v.id} className="hover:bg-[#fbf8f3]">
                  <td className="sticky left-0 z-10 bg-white p-2.5 whitespace-nowrap border-b border-[#f0e9df]">
                    <div className="font-bold text-[#14110c]">{v.name}</div>
                    <div className="text-[10px] text-[#9d8b7e]">{v.category} · {v.ac_type === 'AC' ? t('events.venues.ac') : t('events.venues.nonAc')}</div>
                  </td>
                  {(data.dates || []).map((d: string) => {
                    const c = cellFor(v.id, d);
                    const label = c.booking ? (c.isStart ? cellName(c.booking) : '') : (c.sty === EV_CAL.BLOCKED ? '⛔' : '');
                    return (
                      <td key={d} title={c.title} className="border border-[#f0e9df] text-center align-middle p-0">
                        {c.booking ? (
                          <button type="button"
                            onClick={() => c.count > 1
                              ? setChooser({ venueName: v.name, date: d, bookings: c.all })
                              : setObjStack([{ type: 'EVENT_BOOKING', id: c.booking.id }])}
                            className="relative block w-full text-[9px] font-semibold px-0.5 py-1.5 truncate cursor-pointer hover:brightness-95 hover:underline focus:outline-none"
                            style={{ background: c.sty.bg, color: c.sty.fg }}>
                            {label || (c.count > 1 ? '•' : '')}
                            {c.count > 1 && (
                              <span className="absolute top-0 right-0 min-w-[13px] text-[8px] font-bold leading-[13px] bg-[#cc5a16] text-white rounded-bl-md px-[3px]">{c.count}</span>
                            )}
                          </button>
                        ) : (
                          <div className="text-[9px] font-semibold px-0.5 py-1.5 truncate" style={{ background: c.sty.bg, color: c.sty.fg }}>{label || '·'}</div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex flex-wrap gap-3 mt-3 text-[10px] text-[#6b5d52]">
        {dot(EV_CAL.CONFIRMED, t('events.calendar.booked'))}
        {dot(EV_CAL.TENTATIVE, t('events.reports.inquiries'))}
        {dot(EV_CAL.BLOCKED, t('events.calendar.blocked'))}
        {dot(EV_CAL.FREE, t('events.calendar.free'))}
      </div>

      {/* Multiple bookings on one venue+day — pick which one to open. */}
      {chooser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setChooser(null)}>
          <div className="w-full max-w-sm bg-white rounded-2xl border border-[#e8dccf] p-4 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-sm text-[#14110c]">{chooser.venueName}</h3>
            <p className="text-[11px] text-[#9d8b7e] mb-3">{chooser.date} · {chooser.bookings.length} {t('events.calendar.onDay')}</p>
            <div className="flex flex-col gap-1.5 max-h-[60vh] overflow-y-auto">
              {chooser.bookings.map((b: any) => (
                <button key={b.id} onClick={() => { setObjStack([{ type: 'EVENT_BOOKING', id: b.id }]); setChooser(null); }}
                  className="flex items-center justify-between gap-2 text-left px-3 py-2 rounded-xl border border-[#e8dccf] hover:bg-[#faf7f2]">
                  <span className="min-w-0">
                    <span className="font-semibold text-[#14110c] block truncate">{b.customer_name}</span>
                    <span className="text-[10px] text-[#9d8b7e]">{String(b.start_time || '').slice(0, 5)}–{String(b.end_time || '').slice(0, 5)}{b.event_type ? ` · ${b.event_type}` : ''}</span>
                  </span>
                  <Pill status={b.status} />
                </button>
              ))}
            </div>
            <button className={`${BTN_GHOST} mt-3 w-full justify-center`} onClick={() => setChooser(null)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// QUOTATIONS (all bookings)
// ════════════════════════════════════════════════════════════════════════
function EventQuotations({ restaurantId, token }: Props) {
  const { t } = useT();
  const api = makeApi(restaurantId, token);
  const [rows, setRows] = useState<any[]>([]);
  const [sendQuote, setSendQuote] = useState<{ id: string; email: string } | null>(null);

  const load = async () => {
    try {
      const bookings = await api('/events/bookings');
      const all: any[] = [];
      for (const b of bookings) {
        const full = await api(`/events/bookings/${b.id}`);
        for (const q of (full.quotations || [])) all.push({ ...q, customer_name: b.customer_name, customer_email: b.customer_email });
      }
      all.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      setRows(all);
    } catch { /* */ }
  };
  useEffect(() => { load(); }, []);

  return (
    <div>
      <SectionHeader icon={<FileText size={18} />} title={t('events.quotes.title')} sub={t('events.quotes.sub')}
        action={<button className={BTN_GHOST} onClick={load}><RefreshCw size={13} /></button>} />
      <DataTable
        data={rows}
        rowKey={(r: any) => r.id}
        emptyMessage={t('events.quotes.empty')}
        columnChooser columnFilters tableId="events-quotations" exportFilename="event-quotations"
        columns={[
          { key: 'quote_number', label: t('events.quotes.number'), sortable: true, searchable: true, filterable: true },
          { key: 'customer_name', label: t('events.bookings.customer'), sortable: true, searchable: true, filterable: true },
          { key: 'grand_total', label: t('common.total'), sortable: true, align: 'right', getValue: (r: any) => Number(r.grand_total || 0), render: (r: any) => money(r.grand_total) },
          { key: 'valid_until', label: t('events.quotes.validUntil'), sortable: true, getValue: (r: any) => String(r.valid_until || '').slice(0, 10), render: (r: any) => String(r.valid_until || '').slice(0, 10) },
          { key: 'status', label: t('common.status'), sortable: true, filterable: true, filterType: 'select', getValue: (r: any) => r.status, render: (r: any) => <Pill status={r.status} /> },
          { key: '_a', label: t('common.actions'), hideable: false, noExport: true, render: (r: any) => (
            <div className="flex gap-1">
              <button className={BTN_GHOST} onClick={() => openAuthedPdf(`/api/restaurant/${restaurantId}/events/quotations/${r.id}/pdf`, token)}>{t('events.quotes.viewPdf')}</button>
              <button className={BTN_PRIMARY} onClick={() => setSendQuote({ id: r.id, email: r.customer_email || '' })}><Send size={12} />{t('events.quotes.send')}</button>
            </div>
          ) },
        ]}
      />
      {sendQuote && (
        <SendQuoteDialog restaurantId={restaurantId} token={token} quotationId={sendQuote.id} defaultEmail={sendQuote.email}
          onClose={() => setSendQuote(null)} onSent={(to) => { alert(`${t('events.quotes.sent')} ${to}`); load(); }} />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// DASHBOARD & REPORTS
// ════════════════════════════════════════════════════════════════════════

// Download rows as a CSV file (client-side, no server round-trip).
function downloadCsv(filename: string, rows: (string | number)[][]) {
  const esc = (v: any) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = rows.map(r => r.map(esc).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
}

// Minimal RFC-4180-ish CSV parser (handles quotes, escaped quotes, embedded
// commas + newlines). Returns an array of string-cell rows; blank rows dropped.
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let inQ = false;
  const src = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { rows.push(row); row = []; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') { inQ = true; }
    else if (ch === ',') pushField();
    else if (ch === '\n') { pushField(); pushRow(); }
    else field += ch;
  }
  if (field.length || row.length) { pushField(); pushRow(); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

// Shared analytics fetch over a selectable period window.
function useEventAnalytics(restaurantId: string, token: string) {
  const api = makeApi(restaurantId, token);
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const [from, setFrom] = useState(iso(Date.now() - 180 * 86400000));
  const [to, setTo] = useState(iso(Date.now() + 180 * 86400000));
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { (async () => {
    setLoading(true);
    try { setData(await api(`/events/analytics?from=${from}&to=${to}`)); } catch { setData(null); } finally { setLoading(false); }
  })(); }, [from, to]);
  return { data, loading, from, to, setFrom, setTo };
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  INQUIRY: { label: 'Inquiry', color: '#64748b' },
  QUOTED: { label: 'Quoted', color: '#2563eb' },
  CONFIRMED: { label: 'Confirmed', color: '#6366f1' },
  IN_PROGRESS: { label: 'In progress', color: '#d97706' },
  COMPLETED: { label: 'Completed', color: '#059669' },
  CANCELLED: { label: 'Cancelled', color: '#9ca3af' },
};

function PeriodBar({ from, to, setFrom, setTo, onExport }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void; onExport?: () => void }) {
  const { t } = useT();
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const preset = (back: number, fwd: number) => { setFrom(iso(Date.now() - back * 86400000)); setTo(iso(Date.now() + fwd * 86400000)); };
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <input type="date" className={`${INPUT} w-auto`} value={from} onChange={e => setFrom(e.target.value)} />
      <span className="text-[#9d8b7e]">→</span>
      <input type="date" className={`${INPUT} w-auto`} value={to} onChange={e => setTo(e.target.value)} />
      <button className={BTN_GHOST} onClick={() => preset(30, 0)}>{t('events.dash.last30')}</button>
      <button className={BTN_GHOST} onClick={() => preset(90, 90)}>{t('events.dash.quarter')}</button>
      <button className={BTN_GHOST} onClick={() => preset(365, 90)}>{t('events.dash.year')}</button>
      {onExport && <button className={BTN_GHOST} onClick={onExport}><FileText size={13} />{t('common.exportCsv')}</button>}
    </div>
  );
}

function EventDashboard({ restaurantId, token }: Props) {
  const { t } = useT();
  const { data, loading, from, to, setFrom, setTo } = useEventAnalytics(restaurantId, token);
  const [objStack, setObjStack] = useState<Array<{ type: string; id: string }>>([]);
  const [segMode, setSegMode] = useState<'type' | 'venue'>('type');

  const top = objStack[objStack.length - 1];
  if (top) return (
    <EventObjectRouter restaurantId={restaurantId} token={token} obj={top} venues={[]}
      onOpenObject={(type, id) => setObjStack(s => [...s, { type, id }])}
      onBack={() => setObjStack(s => s.slice(0, -1))} />
  );

  const k = data?.kpis;
  // Period-over-period badge: ▲/▼ vs the previous equal-length window. `pp` renders a
  // percentage-point change (for rates); otherwise a percent change. `goodUp` flips the
  // colour when down-is-good. null base (no prior activity) renders nothing.
  const deltaBadge = (d: number | null | undefined, kind: 'pct' | 'pp' = 'pct', goodUp = true) => {
    if (d === null || d === undefined) return null;
    if (d === 0) return <span className="text-[10px] font-semibold text-[#9d8b7e]">±0</span>;
    const up = d > 0, good = up === goodUp;
    return <span className="text-[10px] font-bold" style={{ color: good ? '#059669' : '#dc2626' }}>{up ? '▲' : '▼'}{Math.abs(d)}{kind === 'pp' ? 'pp' : '%'}</span>;
  };
  const tile = (label: string, value: string, sub?: string, accent = '#cc5a16', delta?: React.ReactNode) => (
    <div className={CARD}>
      <div className="text-[10px] font-bold uppercase tracking-wide text-[#9d8b7e]">{label}</div>
      <div className="flex items-baseline gap-1.5 mt-0.5">
        <span className="text-2xl font-bold tabular-nums" style={{ color: accent }}>{value}</span>
        {delta}
      </div>
      {sub && <div className="text-[11px] text-[#6b5d52] mt-0.5">{sub}</div>}
    </div>
  );
  const openLeads = data ? ((data.funnel.find((f: any) => f.status === 'INQUIRY')?.count || 0) + (data.funnel.find((f: any) => f.status === 'QUOTED')?.count || 0)) : 0;
  const maxMonth = Math.max(1, ...((data?.revenueByMonth || []).map((m: any) => m.revenue)));
  const maxFunnel = Math.max(1, ...((data?.funnel || []).map((f: any) => f.count)));
  const maxPace = Math.max(1, ...((data?.bookingPaceByMonth || []).map((m: any) => m.inquiries)));
  const maxReceipt = Math.max(1, ...((data?.receiptsByMonth || []).map((m: any) => m.amount)));
  const alerts: any[] = data?.alerts || [];
  const tg = data?.targets;

  return (
    <div>
      <SectionHeader icon={<IndianRupee size={18} />} title={t('events.dash.title')} sub={t('events.dash.sub')} />
      <PeriodBar from={from} to={to} setFrom={setFrom} setTo={setTo} />
      {loading || !data ? <p className="text-sm text-[#6b5d52]">{t('common.loading')}</p> : (
        <>
          {/* Action alerts — overdue cash + under-deposited upcoming events. */}
          {alerts.length > 0 && (
            <div className="mb-4 space-y-2">
              {alerts.map((a: any, i: number) => (
                <div key={i} className="rounded-2xl border border-rose-200 bg-rose-50 p-3">
                  <div className="flex items-center gap-2 text-sm font-bold text-rose-700">
                    <AlertTriangle size={15} />
                    {a.type === 'OVERDUE'
                      ? `${t('events.dash.alertOverdue')} — ${money(a.amount)}`
                      : `${t('events.dash.alertLowDeposit', { count: a.count })} — ${t('events.dash.shortfall')} ${money(a.amount)}`}
                  </div>
                  {a.type === 'LOW_DEPOSIT' && Array.isArray(a.items) && (
                    <div className="mt-1.5 space-y-0.5">
                      {a.items.slice(0, 6).map((it: any) => (
                        <button key={it.id} onClick={() => setObjStack([{ type: 'EVENT_BOOKING', id: it.id }])}
                          className="w-full flex items-center justify-between text-xs text-rose-800 hover:bg-rose-100 rounded px-1.5 py-0.5 text-left">
                          <span className="min-w-0 truncate">{it.customer_name} <span className="text-rose-500">· {it.event_date} · {t('events.dash.inDays', { n: it.daysToEvent })}</span></span>
                          <span className="shrink-0 tabular-nums">{it.collectedPct}% · {money(it.shortfall)}</span>
                        </button>
                      ))}
                      {a.items.length > 6 && <div className="text-[11px] text-rose-500 px-1.5">+{a.items.length - 6} {t('common.more')}</div>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Target vs actual — this calendar month (only when a target is set). */}
          {tg && (tg.monthlyRevenueTarget > 0 || tg.occupancyTargetPct > 0) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              {tg.monthlyRevenueTarget > 0 && (() => {
                const pct = Math.min(100, tg.revenueAttainmentPct);
                const col = tg.revenueAttainmentPct >= 100 ? '#059669' : tg.revenueAttainmentPct >= 70 ? '#d97706' : '#dc2626';
                return (
                  <div className={CARD}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="font-bold">{t('events.dash.revenueTarget')}</span>
                      <span className="tabular-nums text-[#6b5d52]">{money(tg.currentMonthRevenue)} / {money(tg.monthlyRevenueTarget)}</span>
                    </div>
                    <div className="h-3 rounded bg-[#f0e9df] overflow-hidden"><div className="h-full rounded" style={{ width: `${pct}%`, background: col }} /></div>
                    <div className="text-right text-lg font-bold mt-0.5 tabular-nums" style={{ color: col }}>{tg.revenueAttainmentPct}%</div>
                  </div>
                );
              })()}
              {tg.occupancyTargetPct > 0 && (() => {
                const pct = Math.min(100, tg.occupancyAttainmentPct);
                const col = tg.occupancyAttainmentPct >= 100 ? '#059669' : tg.occupancyAttainmentPct >= 70 ? '#d97706' : '#dc2626';
                return (
                  <div className={CARD}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="font-bold">{t('events.dash.occupancyTarget')}</span>
                      <span className="tabular-nums text-[#6b5d52]">{tg.occupancyPct}% / {tg.occupancyTargetPct}%</span>
                    </div>
                    <div className="h-3 rounded bg-[#f0e9df] overflow-hidden"><div className="h-full rounded" style={{ width: `${pct}%`, background: col }} /></div>
                    <div className="text-right text-lg font-bold mt-0.5 tabular-nums" style={{ color: col }}>{tg.occupancyAttainmentPct}%</div>
                  </div>
                );
              })()}
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-1">
            {tile(t('events.dash.confirmedRevenue'), money(k.confirmedRevenue), `${k.wonCount} ${t('events.dash.wonEvents')}`, '#cc5a16', deltaBadge(data.deltas?.confirmedRevenue))}
            {tile(t('events.dash.pipeline'), money(k.pipelineRevenue), `${openLeads} ${t('events.dash.openLeads')}`, '#2563eb', deltaBadge(data.deltas?.pipelineRevenue))}
            {tile(t('events.dash.winRate'), `${k.winRate}%`, `${k.wonCount} ${t('common.of')} ${k.wonCount + k.lostCount}`, '#059669', deltaBadge(data.deltas?.winRatePp, 'pp'))}
            {tile(t('events.dash.avgValue'), money(k.avgBookingValue), t('events.dash.perEvent'), '#7c3aed', deltaBadge(data.deltas?.avgBookingValue))}
            {tile(t('events.dash.margin'), money(k.margin || 0), `${k.marginPct || 0}% · ${t('events.dash.afterCost')}`, Number(k.margin) >= 0 ? '#059669' : '#dc2626', deltaBadge(data.deltas?.marginPctPp, 'pp'))}
            {tile(t('events.dash.outstanding'), money(k.outstanding), Number(k.overdue) > 0 ? `${t('events.dash.overdueLabel')} ${money(k.overdue)}` : `${t('events.dash.advance')} ${money(k.advanceCollected)}`, '#dc2626')}
            {tile(t('events.dash.covers'), String(k.totalCovers), t('events.dash.guestsServed'))}
            {tile(t('events.dash.catering'), money(k.cateringRevenue), `${k.cateringCovers} ${t('events.dash.plates')}`, '#b45309')}
            {tile(t('events.dash.discount'), money(k.discountGiven), t('events.dash.givenWon'), '#9ca3af')}
          </div>
          <p className="text-[10px] text-[#9d8b7e] mb-4 flex items-center gap-1"><span className="text-emerald-600">▲</span>/<span className="text-rose-600">▼</span> {t('events.dash.vsPrior')}</p>

          {/* Cash, space-yield and sales-effectiveness KPIs. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            {tile(t('events.dash.depositPct'), `${k.depositCollectionPct || 0}%`, t('events.dash.ofContract'), '#0891b2')}
            {tile(t('events.dash.spaceYield'), money(k.revPerAvailableDay || 0), `${k.spaceOccupancyPct || 0}% ${t('events.dash.spaceOcc')}`, '#6366f1')}
            {tile(t('events.dash.quoteAccept'), `${k.quoteAcceptanceRate || 0}%`, `${t('events.dash.avgQuoteIn')} ${k.avgDaysToQuote || 0}${t('events.dash.dShort')}`, '#059669')}
            {tile(t('events.dash.repeatClients'), `${k.repeatCustomerPct || 0}%`, `${k.repeatCustomers || 0} ${t('common.of')} ${k.distinctCustomers || 0}`, '#7c3aed')}
          </div>

          {/* Profit-by-segment + customer concentration — where the money is made
              and where the risk sits. This is the "manage profitably" view. */}
          <div className="grid md:grid-cols-2 gap-4 mb-4">
            <div className={CARD}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-sm">{t('events.dash.profitBy')}</h3>
                <div className="flex gap-1">
                  {(['type', 'venue'] as const).map(m => (
                    <button key={m} onClick={() => setSegMode(m)}
                      className={`px-2 py-0.5 rounded-lg text-[11px] font-bold border ${segMode === m ? 'bg-[#cc5a16] text-white border-[#cc5a16]' : 'bg-white text-[#6b5d52] border-[#e8dccf]'}`}>
                      {m === 'type' ? t('events.dash.byType') : t('events.dash.byVenue')}
                    </button>
                  ))}
                </div>
              </div>
              {(() => {
                const seg = (segMode === 'type' ? data.segmentByType : data.segmentByVenue) || [];
                if (!seg.length) return <p className="text-xs text-[#9d8b7e]">—</p>;
                const maxRev = Math.max(1, ...seg.map((s: any) => s.revenue));
                return seg.slice(0, 8).map((s: any) => (
                  <div key={s.key} className="mb-2">
                    <div className="flex items-center justify-between text-xs mb-0.5 gap-2">
                      <span className="font-medium truncate min-w-0">{s.key} <span className="text-[#9d8b7e]">· {s.events} {t('events.dash.evShort')}</span></span>
                      <span className="tabular-nums text-[#6b5d52] shrink-0">{money(s.revenue)} · <b style={{ color: s.marginPct >= 0 ? '#059669' : '#dc2626' }}>{s.marginPct}%</b></span>
                    </div>
                    <div className="h-2.5 rounded bg-[#f0e9df] overflow-hidden flex" title={`${t('events.dash.marginShort')} ${money(s.margin)} · ${t('events.dash.costShort')} ${money(s.cost)}`}>
                      <div className="h-full" style={{ width: `${Math.round(Math.max(0, s.margin) / maxRev * 100)}%`, background: '#059669' }} />
                      <div className="h-full" style={{ width: `${Math.round(Math.max(0, s.revenue - Math.max(0, s.margin)) / maxRev * 100)}%`, background: '#f59e0b' }} />
                    </div>
                  </div>
                ));
              })()}
              <p className="text-[10px] text-[#9d8b7e] mt-1"><span className="text-emerald-600">■</span> {t('events.dash.marginShort')} · <span className="text-amber-500">■</span> {t('events.dash.costShort')} · {t('events.dash.profitNote')}</p>
            </div>

            <div className={CARD}>
              <h3 className="font-bold text-sm mb-3 flex items-center justify-between">{t('events.dash.concentration')}
                <span className="text-xs font-normal text-[#6b5d52]">{t('events.dash.top5')} <b className={(data.concentration?.top5SharePct || 0) >= 60 ? 'text-rose-600' : ''}>{data.concentration?.top5SharePct || 0}%</b></span></h3>
              {(() => {
                const c = data.concentration || {};
                const nr = Number(c.newRevenue || 0), rr = Number(c.repeatRevenue || 0), tot = Math.max(1, nr + rr);
                return (
                  <div className="mb-3">
                    <div className="h-3 rounded overflow-hidden flex bg-[#f0e9df]">
                      <div className="h-full" style={{ width: `${Math.round(rr / tot * 100)}%`, background: '#7c3aed' }} />
                      <div className="h-full" style={{ width: `${Math.round(nr / tot * 100)}%`, background: '#c4b5fd' }} />
                    </div>
                    <div className="flex items-center justify-between text-[11px] mt-1">
                      <span className="text-[#7c3aed]">{t('events.dash.repeatRev')} · {money(rr)}</span>
                      <span className="text-[#9d8b7e]">{t('events.dash.newRev')} · {money(nr)}</span>
                    </div>
                  </div>
                );
              })()}
              {(data.concentration?.topCustomers || []).length === 0 ? <p className="text-xs text-[#9d8b7e]">—</p> : data.concentration.topCustomers.slice(0, 6).map((c: any, i: number) => (
                <div key={i} className="flex items-center justify-between text-xs py-1 border-b border-[#f0e9df]">
                  <span className="min-w-0 truncate">{c.name} <span className="text-[#9d8b7e]">· {c.events} {t('events.dash.evShort')}</span></span>
                  <span className="tabular-nums font-semibold shrink-0">{money(c.revenue)}</span>
                </div>
              ))}
              <p className="text-[10px] text-[#9d8b7e] mt-1">{t('events.dash.concentrationNote')}</p>
            </div>
          </div>

          {/* AR aging + On-the-books (forward book & cash at risk). */}
          {(() => {
            const ag = data.aging || { notDue: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0 };
            const buckets = [
              { key: 'notDue', label: t('events.dash.agingNotDue'), val: Number(ag.notDue || 0), color: '#94a3b8', past: false },
              { key: 'd0_30', label: '0–30', val: Number(ag.d0_30 || 0), color: '#22c55e', past: true },
              { key: 'd31_60', label: '31–60', val: Number(ag.d31_60 || 0), color: '#eab308', past: true },
              { key: 'd61_90', label: '61–90', val: Number(ag.d61_90 || 0), color: '#f97316', past: true },
              { key: 'd90plus', label: '90+', val: Number(ag.d90plus || 0), color: '#dc2626', past: true },
            ];
            const maxB = Math.max(1, ...buckets.map(b => b.val));
            return (
              <div className="grid md:grid-cols-2 gap-4 mb-4">
                <div className={CARD}>
                  <h3 className="font-bold text-sm mb-3 flex items-center justify-between">{t('events.dash.arAging')}
                    <span className="text-xs font-normal text-[#6b5d52] tabular-nums">{money(ag.total)}</span></h3>
                  {buckets.map(b => (
                    <div key={b.key} className="mb-2">
                      <div className="flex items-center justify-between text-xs mb-0.5">
                        <span style={{ color: b.color }}>{b.label}{b.past ? ` ${t('events.dash.daysPastEvent')}` : ''}</span>
                        <span className="tabular-nums text-[#6b5d52]">{money(b.val)}</span>
                      </div>
                      <div className="h-2 rounded bg-[#f0e9df] overflow-hidden">
                        <div className="h-full rounded" style={{ width: `${Math.round(b.val / maxB * 100)}%`, background: b.color }} />
                      </div>
                    </div>
                  ))}
                  <p className="text-[10px] text-[#9d8b7e] mt-1">{t('events.dash.agingNote')}</p>
                </div>
                <div className={CARD}>
                  <h3 className="font-bold text-sm mb-3">{t('events.dash.onTheBooks')}</h3>
                  <div className="space-y-2 text-xs">
                    <div className="flex items-center justify-between"><span className="text-[#6b5d52]">{t('events.dash.deliveredRev')}</span><span className="tabular-nums font-semibold">{money(k.deliveredRevenue || 0)}</span></div>
                    <div className="flex items-center justify-between"><span className="text-[#6b5d52]">{t('events.dash.forwardRev')}</span><span className="tabular-nums font-semibold text-[#2563eb]">{money(k.forwardRevenue || 0)}</span></div>
                    <div className="flex items-center justify-between"><span className="text-[#6b5d52]">{t('events.dash.valueAtRisk')}</span><span className="tabular-nums font-semibold text-rose-600">{money(k.valueAtRisk || 0)}</span></div>
                    <div className="flex items-center justify-between"><span className="text-[#6b5d52]">{t('events.dash.avgLead')}</span><span className="tabular-nums font-semibold">{k.avgLeadTimeDays || 0} {t('events.dash.days')}</span></div>
                    <div className="flex items-center justify-between"><span className="text-[#6b5d52]">{t('events.dash.cancelRate')}</span><span className="tabular-nums font-semibold">{k.cancellationRate || 0}%</span></div>
                    <div className="flex items-center justify-between"><span className="text-[#6b5d52]">{t('events.dash.avgRatePerDay')}</span><span className="tabular-nums font-semibold">{money(k.avgRatePerBookedDay || 0)}</span></div>
                  </div>
                  <p className="text-[10px] text-[#9d8b7e] mt-2">{t('events.dash.onBooksNote')}</p>
                </div>
              </div>
            );
          })()}

          <div className="grid md:grid-cols-2 gap-4 mb-4">
            <div className={CARD}>
              <h3 className="font-bold text-sm mb-3">{t('events.dash.funnel')}</h3>
              {data.funnel.map((f: any) => (
                <div key={f.status} className="mb-2">
                  <div className="flex items-center justify-between text-xs mb-0.5">
                    <span style={{ color: STATUS_META[f.status]?.color }}>{STATUS_META[f.status]?.label || f.status}</span>
                    <span className="tabular-nums text-[#6b5d52]">{f.count} · {money(f.value)}</span>
                  </div>
                  <div className="h-2 rounded bg-[#f0e9df] overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${Math.round(f.count / maxFunnel * 100)}%`, background: STATUS_META[f.status]?.color }} />
                  </div>
                </div>
              ))}
            </div>
            <div className={CARD}>
              <h3 className="font-bold text-sm mb-3">{t('events.dash.revenueTrend')}</h3>
              {data.revenueByMonth.length === 0 ? <p className="text-xs text-[#9d8b7e]">—</p> : data.revenueByMonth.map((m: any) => (
                <div key={m.month} className="mb-2">
                  <div className="flex items-center justify-between text-xs mb-0.5">
                    <span>{m.month}</span><span className="tabular-nums text-[#6b5d52]">{money(m.revenue)} · {m.events} {t('events.dash.evShort')}</span>
                  </div>
                  <div className="h-2 rounded bg-[#f0e9df] overflow-hidden">
                    <div className="h-full rounded bg-[#cc5a16]" style={{ width: `${Math.round(m.revenue / maxMonth * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className={`${CARD} mb-4`}>
            <h3 className="font-bold text-sm mb-3">{t('events.dash.venueUtil')} <span className="font-normal text-[#9d8b7e]">({data.window.days} {t('events.dash.days')})</span></h3>
            {data.venueUtilization.length === 0 ? <p className="text-xs text-[#9d8b7e]">—</p> : data.venueUtilization.map((v: any) => (
              <div key={v.venue_id} className="flex items-center gap-3 text-xs py-1.5 border-b border-[#f0e9df]">
                <span className="w-40 truncate font-medium">{v.name}</span>
                <div className="flex-1 h-2.5 rounded bg-[#f0e9df] overflow-hidden"><div className="h-full rounded bg-[#6366f1]" style={{ width: `${v.utilizationPct}%` }} /></div>
                <span className="w-10 text-right tabular-nums">{v.utilizationPct}%</span>
                <span className="w-14 text-right tabular-nums text-[#9d8b7e]">{v.events} {t('events.dash.evShort')}</span>
                <span className="w-24 text-right tabular-nums font-semibold">{money(v.revenue)}</span>
              </div>
            ))}
          </div>

          {/* Booking pace (demand inflow) + Cash collected (actual receipts). */}
          <div className="grid md:grid-cols-2 gap-4 mb-4">
            <div className={CARD}>
              <h3 className="font-bold text-sm mb-3">{t('events.dash.bookingPace')}</h3>
              {(data.bookingPaceByMonth || []).length === 0 ? <p className="text-xs text-[#9d8b7e]">—</p> : data.bookingPaceByMonth.map((m: any) => (
                <div key={m.month} className="mb-2">
                  <div className="flex items-center justify-between text-xs mb-0.5">
                    <span>{m.month}</span><span className="tabular-nums text-[#6b5d52]">{m.inquiries} {t('events.dash.inquiriesShort')} · {m.won} {t('events.dash.wonShort')}</span>
                  </div>
                  <div className="h-2 rounded bg-[#f0e9df] overflow-hidden">
                    <div className="h-full rounded bg-[#0891b2]" style={{ width: `${Math.round(m.inquiries / maxPace * 100)}%` }} />
                  </div>
                </div>
              ))}
              <p className="text-[10px] text-[#9d8b7e] mt-1">{t('events.dash.paceNote')}</p>
            </div>
            <div className={CARD}>
              <h3 className="font-bold text-sm mb-3 flex items-center justify-between">{t('events.dash.cashCollected')}
                <span className="text-xs font-normal text-[#6b5d52] tabular-nums">{money(k.receiptsTotal || 0)}</span></h3>
              {(data.receiptsByMonth || []).length === 0 ? <p className="text-xs text-[#9d8b7e]">—</p> : data.receiptsByMonth.map((m: any) => (
                <div key={m.month} className="mb-2">
                  <div className="flex items-center justify-between text-xs mb-0.5">
                    <span>{m.month}</span><span className="tabular-nums text-[#6b5d52]">{money(m.amount)}</span>
                  </div>
                  <div className="h-2 rounded bg-[#f0e9df] overflow-hidden">
                    <div className="h-full rounded bg-[#059669]" style={{ width: `${Math.round(m.amount / maxReceipt * 100)}%` }} />
                  </div>
                </div>
              ))}
              <p className="text-[10px] text-[#9d8b7e] mt-1">{t('events.dash.cashNote')}</p>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div className={CARD}>
              <h3 className="font-bold text-sm mb-2">{t('events.dash.upcoming')}</h3>
              {data.upcoming.length === 0 ? <p className="text-xs text-[#9d8b7e]">—</p> : data.upcoming.map((r: any) => (
                <button key={r.id} onClick={() => setObjStack([{ type: 'EVENT_BOOKING', id: r.id }])}
                  className="w-full flex items-center justify-between text-xs py-1.5 border-b border-[#f0e9df] hover:bg-[#faf7f2] text-left">
                  <span className="min-w-0 truncate"><span className="font-semibold">{r.customer_name}</span> <span className="text-[#9d8b7e]">· {r.venue_name || '—'}</span></span>
                  <span className="flex items-center gap-2 shrink-0"><span className="text-[#6b5d52]">{r.event_date}</span><Pill status={r.status} /></span>
                </button>
              ))}
            </div>
            <div className={CARD}>
              <h3 className="font-bold text-sm mb-2 flex items-center justify-between">{t('events.dash.receivables')}
                <span className="text-xs font-normal text-rose-600 tabular-nums">{money(k.outstanding)}</span></h3>
              {data.receivables.length === 0 ? <p className="text-xs text-[#9d8b7e]">{t('events.dash.allSettled')}</p> : data.receivables.slice(0, 12).map((r: any) => (
                <button key={r.id} onClick={() => setObjStack([{ type: 'EVENT_BOOKING', id: r.id }])}
                  className="w-full flex items-center justify-between text-xs py-1.5 border-b border-[#f0e9df] hover:bg-[#faf7f2] text-left">
                  <span className="min-w-0 truncate"><span className="font-semibold">{r.customer_name}</span> <span className="text-[#9d8b7e]">· {r.event_date}</span></span>
                  <span className="tabular-nums font-semibold text-rose-600 shrink-0">{money(r.outstanding)}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Reports & exports — tabular breakdowns with per-table and full CSV download.
function EventReports({ restaurantId, token }: Props) {
  const { t } = useT();
  const { data, loading, from, to, setFrom, setTo } = useEventAnalytics(restaurantId, token);

  const exportAll = () => {
    if (!data) return;
    const rows: (string | number)[][] = [['Events & Convention report', `${from} to ${to}`], []];
    rows.push(['BOOKING FUNNEL'], ['Status', 'Count', 'Value']);
    data.funnel.forEach((f: any) => rows.push([f.status, f.count, f.value]));
    rows.push([], ['VENUE UTILIZATION'], ['Venue', 'Events', 'Booked days', 'Utilization %', 'Revenue']);
    data.venueUtilization.forEach((v: any) => rows.push([v.name, v.events, v.bookedDays, v.utilizationPct, v.revenue]));
    rows.push([], ['EVENT TYPE MIX'], ['Type', 'Count', 'Revenue']);
    data.eventTypeMix.forEach((v: any) => rows.push([v.type, v.count, v.revenue]));
    rows.push([], ['LEAD SOURCES'], ['Source', 'Leads', 'Won', 'Win %', 'Revenue']);
    data.leadSources.forEach((v: any) => rows.push([v.source, v.count, v.won, v.winRate, v.revenue]));
    rows.push([], ['REVENUE BY MONTH'], ['Month', 'Events', 'Covers', 'Revenue']);
    data.revenueByMonth.forEach((v: any) => rows.push([v.month, v.events, v.covers, v.revenue]));
    rows.push([], ['CATERING'], ['Package', 'Type', 'Covers', 'Revenue']);
    data.cateringByPackage.forEach((v: any) => rows.push([v.name, v.package_type, v.covers, v.revenue]));
    rows.push([], ['OUTSTANDING BY INVOICE'], ['Invoice / Booking', 'Customer', 'Venue', 'Event date', 'Total', 'Paid', 'Outstanding', 'Payment status']);
    [...data.receivables].sort((a: any, b: any) => Number(b.outstanding || 0) - Number(a.outstanding || 0))
      .forEach((v: any) => rows.push([v.id, v.customer_name, v.venue_name || '', v.event_date, v.total_amount, v.advance_amount, v.outstanding, evPayLabel(t, v.total_amount, v.advance_amount)]));
    if (data.aging) {
      const a = data.aging;
      rows.push([], ['RECEIVABLES AGING'], ['Bucket', 'Amount'],
        ['Not yet due', a.notDue], ['0-30 past event', a.d0_30], ['31-60', a.d31_60], ['61-90', a.d61_90], ['90+', a.d90plus], ['Total', a.total]);
    }
    if (data.bookingPaceByMonth) {
      rows.push([], ['BOOKING PACE (by created month)'], ['Month', 'Inquiries', 'Won']);
      data.bookingPaceByMonth.forEach((v: any) => rows.push([v.month, v.inquiries, v.won]));
    }
    if (data.quoteStats) {
      const q = data.quoteStats;
      rows.push([], ['QUOTATION EFFECTIVENESS'], ['Metric', 'Value'],
        ['Bookings quoted', q.quoted], ['Quotes sent', q.sent], ['Accepted', q.accepted],
        ['Acceptance %', q.acceptanceRate], ['Avg versions', q.avgVersions], ['Avg days to quote', q.avgDaysToQuote]);
    }
    const kk = data.kpis || {};
    rows.push([], ['BUSINESS KPIs'], ['Metric', 'Value'],
      ['Deposit collected %', kk.depositCollectionPct], ['Cancellation rate %', kk.cancellationRate],
      ['Repeat customer %', kk.repeatCustomerPct], ['Forward (contracted) revenue', kk.forwardRevenue],
      ['Delivered revenue', kk.deliveredRevenue], ['Uncollected on upcoming', kk.valueAtRisk],
      ['RevPAR / available hall-day', kk.revPerAvailableDay], ['Avg rate / booked day', kk.avgRatePerBookedDay],
      ['Space occupancy %', kk.spaceOccupancyPct], ['Avg lead time (days)', kk.avgLeadTimeDays]);
    downloadCsv(`events-report-${from}_${to}.csv`, rows);
  };

  const table = (title: string, cols: string[], rows: any[][]) => (
    <div className={`${CARD} mb-4`}>
      <h3 className="font-bold text-sm mb-2">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-[#9d8b7e] border-b border-[#e8dccf]">{cols.map((c, i) => <th key={c} className={`py-1.5 pr-3 font-semibold ${i === 0 ? '' : 'text-right'}`}>{c}</th>)}</tr></thead>
          <tbody>{rows.length === 0 ? <tr><td colSpan={cols.length} className="py-2 text-[#9d8b7e]">—</td></tr> : rows.map((r, i) => (
            <tr key={i} className="border-b border-[#f0e9df]">{r.map((c, j) => <td key={j} className={`py-1.5 pr-3 ${j === 0 ? '' : 'tabular-nums text-right'}`}>{c}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div>
      <SectionHeader icon={<FileText size={18} />} title={t('events.reports.title')} sub={t('events.reports.sub')} />
      <PeriodBar from={from} to={to} setFrom={setFrom} setTo={setTo} onExport={exportAll} />
      {loading || !data ? <p className="text-sm text-[#6b5d52]">{t('common.loading')}</p> : (
        <>
          {table(t('events.dash.venueUtil'), [t('events.bookings.venue'), t('events.dash.events'), t('events.dash.bookedDays'), t('events.dash.utilPct'), t('common.total')],
            data.venueUtilization.map((v: any) => [v.name, v.events, v.bookedDays, `${v.utilizationPct}%`, money(v.revenue)]))}
          {table(t('events.dash.eventTypeMix'), [t('events.bookings.eventType'), t('events.dash.events'), t('common.total')],
            data.eventTypeMix.map((v: any) => [v.type, v.count, money(v.revenue)]))}
          {table(t('events.dash.leadSources'), [t('events.dash.source'), t('events.dash.leads'), t('events.dash.won'), t('events.dash.winRate'), t('common.total')],
            data.leadSources.map((v: any) => [v.source, v.count, v.won, `${v.winRate}%`, money(v.revenue)]))}
          {table(t('events.dash.revenueTrend'), [t('events.dash.month'), t('events.dash.events'), t('events.dash.covers'), t('common.total')],
            data.revenueByMonth.map((v: any) => [v.month, v.events, v.covers, money(v.revenue)]))}
          {table(t('events.dash.catering'), [t('events.dash.package'), t('events.dash.covers'), t('common.total')],
            data.cateringByPackage.map((v: any) => [`${v.name} (${v.package_type})`, v.covers, money(v.revenue)]))}
          {(() => {
            // Outstanding by invoice — one row per contracted booking (each is an
            // invoice/bill), sorted by what's still owed. Total / Paid / Outstanding
            // + a Paid/Partial/Pending status, with a grand-total footer.
            const rec = [...(data.receivables || [])].sort((a: any, b: any) => Number(b.outstanding || 0) - Number(a.outstanding || 0));
            const tBill = rec.reduce((s: number, r: any) => s + Number(r.total_amount || 0), 0);
            const tPaid = rec.reduce((s: number, r: any) => s + Number(r.advance_amount || 0), 0);
            const tOut = rec.reduce((s: number, r: any) => s + Number(r.outstanding || 0), 0);
            return (
              <div className={`${CARD} mb-4`}>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-bold text-sm">{t('events.reports.outstandingByInvoice')}</h3>
                  <span className="text-xs text-[#9d8b7e]">{t('events.dash.outstanding')}: <strong className="text-[#b45309]">{money(tOut)}</strong></span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="text-left text-[#9d8b7e] border-b border-[#e8dccf]">
                      <th className="py-1.5 pr-3 font-semibold">{t('events.bookings.bookingId')}</th>
                      <th className="py-1.5 pr-3 font-semibold">{t('events.bookings.customer')}</th>
                      <th className="py-1.5 pr-3 font-semibold">{t('events.bookings.venue')}</th>
                      <th className="py-1.5 pr-3 font-semibold">{t('events.bookings.eventDate')}</th>
                      <th className="py-1.5 pr-3 font-semibold text-right">{t('common.total')}</th>
                      <th className="py-1.5 pr-3 font-semibold text-right">{t('events.bookings.advance')}</th>
                      <th className="py-1.5 pr-3 font-semibold text-right">{t('events.dash.outstanding')}</th>
                      <th className="py-1.5 pr-3 font-semibold">{t('events.bookings.payment')}</th>
                    </tr></thead>
                    <tbody>{rec.length === 0 ? <tr><td colSpan={8} className="py-2 text-[#9d8b7e]">—</td></tr> : rec.map((r: any) => (
                      <tr key={r.id} className="border-b border-[#f0e9df]">
                        <td className="py-1.5 pr-3 font-mono text-[11px]">{r.id}</td>
                        <td className="py-1.5 pr-3">{r.customer_name}</td>
                        <td className="py-1.5 pr-3">{r.venue_name || '—'}</td>
                        <td className="py-1.5 pr-3">{String(r.event_date || '').slice(0, 10)}</td>
                        <td className="py-1.5 pr-3 tabular-nums text-right">{money(r.total_amount)}</td>
                        <td className="py-1.5 pr-3 tabular-nums text-right">{money(r.advance_amount)}</td>
                        <td className="py-1.5 pr-3 tabular-nums text-right font-semibold">{money(r.outstanding)}</td>
                        <td className="py-1.5 pr-3"><PaymentPill total={r.total_amount} paid={r.advance_amount} /></td>
                      </tr>
                    ))}</tbody>
                    {rec.length > 0 && <tfoot><tr className="border-t-2 border-[#e8dccf] font-bold">
                      <td className="py-1.5 pr-3" colSpan={4}>{t('common.total')}</td>
                      <td className="py-1.5 pr-3 tabular-nums text-right">{money(tBill)}</td>
                      <td className="py-1.5 pr-3 tabular-nums text-right">{money(tPaid)}</td>
                      <td className="py-1.5 pr-3 tabular-nums text-right text-[#b45309]">{money(tOut)}</td>
                      <td></td>
                    </tr></tfoot>}
                  </table>
                </div>
              </div>
            );
          })()}
          {table(t('events.dash.lostReasons'), [t('events.cancel.reason'), t('events.dash.events')],
            (data.lostReasons || []).map((v: any) => [v.reason, v.count]))}
        </>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// PUBLIC PAGE SETTINGS
// ════════════════════════════════════════════════════════════════════════
function EventSettings({ restaurantId, token }: Props) {
  const { t } = useT();
  const api = makeApi(restaurantId, token);
  const [form, setForm] = useState<any>({ hero_title: '', tagline: '', description: '', contact_phone: '', contact_email: '', is_published: true });
  const [saved, setSaved] = useState(false);
  const [secLang, setSecLang] = useState<string>('');
  const [gst, setGst] = useState<{ gst_percent: number; gst_enabled: boolean; gst_number: string; invoice_lang_mode: string; suggested_language: string }>({ gst_percent: 18, gst_enabled: true, gst_number: '', invoice_lang_mode: 'BOTH', suggested_language: '' });
  const [gstSaved, setGstSaved] = useState(false);
  // Business targets + cash-risk alert thresholds (Sprint 4). Shares the
  // gst-settings endpoint (both live on event_profile).
  const [biz, setBiz] = useState<{ monthly_revenue_target: number; occupancy_target_pct: number; min_deposit_pct: number; deposit_due_days: number }>({ monthly_revenue_target: 0, occupancy_target_pct: 0, min_deposit_pct: 25, deposit_due_days: 14 });
  const [bizSaved, setBizSaved] = useState(false);
  // Owner-configurable payment-schedule split (the "Generate schedule" stages).
  const [splits, setSplits] = useState<Array<{ label: string; percent: number; offsetDays: number }>>([
    { label: 'Booking deposit', percent: 25, offsetDays: 0 },
    { label: 'Interim payment', percent: 50, offsetDays: -30 },
    { label: 'Balance', percent: 25, offsetDays: -7 },
  ]);
  const [splitsSaved, setSplitsSaved] = useState(false);
  const splitTotal = splits.reduce((a, s) => a + (Number(s.percent) || 0), 0);
  useEffect(() => { api('/events/profile').then((p) => { if (p && p.id) { let gl: string[] = []; try { const g = JSON.parse(p.gallery || '[]'); if (Array.isArray(g)) gl = g.filter(Boolean); } catch { /* */ } setForm({ ...p, is_published: Number(p.is_published) !== 0, gallery_list: gl }); } }).catch(() => {}); }, []);
  useEffect(() => { api('/settings/language').then((r) => setSecLang(r.secondary_language || '')).catch(() => {}); }, []);
  useEffect(() => { api('/events/gst-settings').then((r) => {
    setGst({ gst_percent: Number(r.gst_percent ?? 18), gst_enabled: Number(r.gst_enabled ?? 1) !== 0, gst_number: r.gst_number || '', invoice_lang_mode: r.invoice_lang_mode || 'BOTH', suggested_language: r.suggested_language || '' });
    setBiz({ monthly_revenue_target: Number(r.monthly_revenue_target ?? 0), occupancy_target_pct: Number(r.occupancy_target_pct ?? 0), min_deposit_pct: Number(r.min_deposit_pct ?? 25), deposit_due_days: Number(r.deposit_due_days ?? 14) });
    if (Array.isArray(r.payment_schedule_splits) && r.payment_schedule_splits.length) setSplits(r.payment_schedule_splits.map((s: any) => ({ label: String(s.label || ''), percent: Number(s.percent) || 0, offsetDays: Math.round(Number(s.offsetDays) || 0) })));
  }).catch(() => {}); }, []);
  const saveGst = async () => {
    try {
      await api('/events/gst-settings', { method: 'PUT', body: JSON.stringify({ gst_percent: Number(gst.gst_percent) || 0, gst_enabled: gst.gst_enabled, gst_number: gst.gst_number.trim(), invoice_lang_mode: gst.invoice_lang_mode }) });
      setGstSaved(true); setTimeout(() => setGstSaved(false), 1500);
    } catch (e: any) { alert(e.message); }
  };
  const saveBiz = async () => {
    try {
      await api('/events/gst-settings', { method: 'PUT', body: JSON.stringify({ monthly_revenue_target: Number(biz.monthly_revenue_target) || 0, occupancy_target_pct: Number(biz.occupancy_target_pct) || 0, min_deposit_pct: Number(biz.min_deposit_pct) || 0, deposit_due_days: Number(biz.deposit_due_days) || 0 }) });
      setBizSaved(true); setTimeout(() => setBizSaved(false), 1500);
    } catch (e: any) { alert(e.message); }
  };
  const setSplit = (i: number, patch: Partial<{ label: string; percent: number; offsetDays: number }>) => setSplits(s => s.map((x, idx) => idx === i ? { ...x, ...patch } : x));
  const addSplit = () => setSplits(s => [...s, { label: `Instalment ${s.length + 1}`, percent: 0, offsetDays: -7 }]);
  const delSplit = (i: number) => setSplits(s => s.filter((_, idx) => idx !== i));
  const saveSplits = async () => {
    if (Math.abs(splitTotal - 100) > 0.5) { alert(t('events.settings.scheduleTotalErr', { n: Math.round(splitTotal) })); return; }
    try {
      await api('/events/gst-settings', { method: 'PUT', body: JSON.stringify({ payment_schedule_splits: splits }) });
      setSplitsSaved(true); setTimeout(() => setSplitsSaved(false), 1500);
    } catch (e: any) { alert(e.message); }
  };
  const [vr, setVr] = useState<any>({ default_turnaround_min: 120, hd_am_start: '08:00', hd_am_end: '14:00', hd_pm_start: '17:00', hd_pm_end: '23:00', weekend_days: '0,6' });
  const [vrSaved, setVrSaved] = useState(false);
  useEffect(() => { api('/events/venue-settings').then((r: any) => setVr({ default_turnaround_min: Number(r.default_turnaround_min ?? 120), hd_am_start: r.hd_am_start || '08:00', hd_am_end: r.hd_am_end || '14:00', hd_pm_start: r.hd_pm_start || '17:00', hd_pm_end: r.hd_pm_end || '23:00', weekend_days: r.weekend_days || '0,6' })).catch(() => {}); }, []);
  const saveVr = async () => {
    try {
      await api('/events/venue-settings', { method: 'PUT', body: JSON.stringify(vr) });
      setVrSaved(true); setTimeout(() => setVrSaved(false), 1500);
    } catch (e: any) { alert(e.message); }
  };
  const save = async () => {
    try {
      const gallery = JSON.stringify((form.gallery_list || []).map((s: string) => String(s).trim()).filter(Boolean));
      const { gallery_list, ...rest } = form;
      await api('/events/profile', { method: 'PUT', body: JSON.stringify({ ...rest, gallery }) });
      setSaved(true); setTimeout(() => setSaved(false), 1500);
    } catch (e: any) { alert(e.message); }
  };
  const saveLang = async (l: string) => {
    setSecLang(l);
    try { await api('/settings/language', { method: 'PUT', body: JSON.stringify({ secondary_language: l || null }) }); window.location.reload(); } catch (e: any) { alert(e.message); }
  };
  const publicUrl = `${window.location.origin}/events/${restaurantId}`;

  return (
    <div>
      <SectionHeader icon={<Building2 size={18} />} title={t('events.settings.title')} sub={t('events.settings.sub')} />

      {/* App-wide secondary language (i18n) */}
      <div className={`${CARD} mb-4`}>
        <label className={LABEL}>{t('common.language')} — secondary (app-wide)</label>
        <div className="flex items-center gap-2">
          <select className={`${INPUT} max-w-xs`} value={secLang} onChange={e => saveLang(e.target.value)}>
            <option value="">English only</option>
            {SECONDARY_LANGUAGE_OPTIONS.map(l => <option key={l} value={l}>{LANGUAGE_NAMES[l] || l}</option>)}
          </select>
          <span className="text-xs text-[#9d8b7e]">Staff can toggle English ↔ this language.</span>
        </div>
        {!secLang && gst.suggested_language && (
          <p className="text-[11px] text-[#9d8b7e] mt-1.5">Suggested for your state: <strong>{LANGUAGE_NAMES[gst.suggested_language] || gst.suggested_language}</strong> — <button className="text-[#cc5a16] font-semibold hover:underline" onClick={() => saveLang(gst.suggested_language)}>Use this</button></p>
        )}
      </div>

      {/* Event & Convention — Invoice GST (owner-configurable default) */}
      <div className={`${CARD} mb-4 space-y-3`}>
        <div className="flex items-center gap-2">
          <FileText size={16} className="text-[#cc5a16]" />
          <div>
            <div className="text-sm font-bold text-[#3d2e22]">Invoice GST — Event &amp; Convention</div>
            <div className="text-[11px] text-[#9d8b7e]">Default GST applied to event quotations &amp; invoices (venue, rentals, services, catering). Hotel rooms always follow the Hotel GST slab settings.</div>
          </div>
        </div>
        <div>
          <label className={LABEL}>GSTIN (business GST number)</label>
          <input className={`${INPUT} max-w-md font-mono`} value={gst.gst_number} placeholder="e.g. 27ABCDE1234F1Z5"
            onChange={e => setGst({ ...gst, gst_number: e.target.value.toUpperCase() })} />
          <p className="text-[11px] text-[#9d8b7e] mt-1">{gst.gst_number ? 'Prints on every event quotation & tax invoice.' : 'Required for a GST-compliant tax invoice — without it the invoice shows no GSTIN.'}</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={gst.gst_enabled} onChange={e => setGst({ ...gst, gst_enabled: e.target.checked })} />
          Charge GST on event invoices
        </label>
        <div className="flex items-end gap-3">
          <div>
            <label className={LABEL}>Default GST %</label>
            <input type="number" min={0} max={28} step={0.5} className={`${INPUT} max-w-[120px]`} value={gst.gst_percent}
              disabled={!gst.gst_enabled}
              onChange={e => setGst({ ...gst, gst_percent: Number(e.target.value) })} />
          </div>
          <button className={BTN_PRIMARY} onClick={saveGst}>{t('common.save')}</button>
          {gstSaved && <span className="text-xs text-emerald-600 font-semibold flex items-center gap-1"><Check size={13} />{t('common.saved')}</span>}
        </div>
        <div>
          <label className={LABEL}>Invoice language</label>
          <select className={`${INPUT} max-w-xs`} value={gst.invoice_lang_mode} onChange={e => setGst({ ...gst, invoice_lang_mode: e.target.value })}>
            <option value="EN">English only</option>
            <option value="REGIONAL">Regional only</option>
            <option value="BOTH">English + Regional</option>
          </select>
          <p className="text-[11px] text-[#9d8b7e] mt-1">Regional = your state&apos;s language{gst.suggested_language ? ` (${LANGUAGE_NAMES[gst.suggested_language] || gst.suggested_language})` : ''}. Regional / Both print regional script once the font is enabled; until then they fall back to English.</p>
        </div>
        <p className="text-[11px] text-[#9d8b7e]">You can still override this per document when generating a quotation or invoice.</p>
      </div>

      {/* Event & Convention — Venue booking rules (house defaults) */}
      <div className={`${CARD} mb-4 space-y-3`}>
        <div className="flex items-center gap-2">
          <CalendarRange size={16} className="text-[#cc5a16]" />
          <div>
            <div className="text-sm font-bold text-[#3d2e22]">Venue booking rules — house defaults</div>
            <div className="text-[11px] text-[#9d8b7e]">Half-day AM/PM windows, turnaround/prep buffer, and peak days. Individual halls can override these in the Venues master.</div>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div><label className={LABEL}>Turnaround / prep (min)</label><input type="number" min={0} className={INPUT} value={vr.default_turnaround_min} onChange={e => setVr({ ...vr, default_turnaround_min: Number(e.target.value) })} /></div>
          <div><label className={LABEL}>Morning (AM) window</label><div className="flex items-center gap-1"><input type="time" className={INPUT} value={vr.hd_am_start} onChange={e => setVr({ ...vr, hd_am_start: e.target.value })} /><span className="text-xs">–</span><input type="time" className={INPUT} value={vr.hd_am_end} onChange={e => setVr({ ...vr, hd_am_end: e.target.value })} /></div></div>
          <div><label className={LABEL}>Evening (PM) window</label><div className="flex items-center gap-1"><input type="time" className={INPUT} value={vr.hd_pm_start} onChange={e => setVr({ ...vr, hd_pm_start: e.target.value })} /><span className="text-xs">–</span><input type="time" className={INPUT} value={vr.hd_pm_end} onChange={e => setVr({ ...vr, hd_pm_end: e.target.value })} /></div></div>
        </div>
        <div>
          <label className={LABEL}>Weekend / peak days</label>
          <div className="flex flex-wrap gap-1.5">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => {
              const set = String(vr.weekend_days || '').split(',').map((s: string) => s.trim()).filter(Boolean);
              const on = set.includes(String(i));
              return <button key={d} type="button" onClick={() => { const s = new Set(set); if (on) s.delete(String(i)); else s.add(String(i)); setVr({ ...vr, weekend_days: Array.from(s).sort().join(',') }); }}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border ${on ? 'bg-[#cc5a16] text-white border-[#cc5a16]' : 'bg-white text-[#6b5d52] border-[#e8dccf]'}`}>{d}</button>;
            })}
          </div>
          <p className="text-[11px] text-[#9d8b7e] mt-1">Selected days use the Weekend/Peak column of each hall's price matrix.</p>
        </div>
        <div className="flex items-center gap-3">
          <button className={BTN_PRIMARY} onClick={saveVr}>{t('common.save')}</button>
          {vrSaved && <span className="text-xs text-emerald-600 font-semibold flex items-center gap-1"><Check size={13} />{t('common.saved')}</span>}
        </div>
      </div>

      {/* Business targets + cash-risk alerts (drives dashboard attainment + alerts) */}
      <div className={`${CARD} mb-4 space-y-3`}>
        <div className="flex items-center gap-2">
          <IndianRupee size={16} className="text-[#cc5a16]" />
          <div>
            <div className="text-sm font-bold text-[#3d2e22]">{t('events.settings.targetsTitle')}</div>
            <div className="text-[11px] text-[#9d8b7e]">{t('events.settings.targetsSub')}</div>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div><label className={LABEL}>{t('events.settings.monthlyRevenueTarget')} (₹)</label><input type="number" min={0} className={INPUT} value={biz.monthly_revenue_target} onChange={e => setBiz({ ...biz, monthly_revenue_target: Number(e.target.value) })} placeholder="0 = no target" /></div>
          <div><label className={LABEL}>{t('events.settings.occupancyTarget')} (%)</label><input type="number" min={0} max={100} className={INPUT} value={biz.occupancy_target_pct} onChange={e => setBiz({ ...biz, occupancy_target_pct: Number(e.target.value) })} placeholder="0 = no target" /></div>
          <div><label className={LABEL}>{t('events.settings.minDeposit')} (%)</label><input type="number" min={0} max={100} className={INPUT} value={biz.min_deposit_pct} onChange={e => setBiz({ ...biz, min_deposit_pct: Number(e.target.value) })} /></div>
          <div><label className={LABEL}>{t('events.settings.depositDueDays')}</label><input type="number" min={0} className={INPUT} value={biz.deposit_due_days} onChange={e => setBiz({ ...biz, deposit_due_days: Number(e.target.value) })} /></div>
        </div>
        <p className="text-[11px] text-[#9d8b7e]">{t('events.settings.targetsNote')}</p>
        <div className="flex items-center gap-3">
          <button className={BTN_PRIMARY} onClick={saveBiz}>{t('common.save')}</button>
          {bizSaved && <span className="text-xs text-emerald-600 font-semibold flex items-center gap-1"><Check size={13} />{t('common.saved')}</span>}
        </div>
      </div>

      {/* Payment schedule split — the stages the "Generate schedule" button creates. */}
      <div className={`${CARD} space-y-3`}>
        <div>
          <div className="text-sm font-bold text-[#3d2e22]">{t('events.settings.scheduleTitle')}</div>
          <div className="text-[11px] text-[#9d8b7e]">{t('events.settings.scheduleSub')}</div>
        </div>
        <div className="space-y-2">
          <div className="hidden md:flex items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-[#9d8b7e] px-1">
            <span className="flex-1">{t('events.settings.scheduleStage')}</span>
            <span className="w-20 text-right">%</span>
            <span className="w-28 text-right">{t('events.settings.scheduleDaysBefore')}</span>
            <span className="w-6" />
          </div>
          {splits.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className={`${INPUT} flex-1`} value={s.label} onChange={e => setSplit(i, { label: e.target.value })} placeholder={t('events.settings.scheduleStage')} />
              <input type="number" min={0} max={100} className={`${INPUT} w-20 text-right`} value={s.percent} onChange={e => setSplit(i, { percent: Number(e.target.value) || 0 })} />
              <input type="number" min={0} className={`${INPUT} w-28 text-right`} value={-s.offsetDays} onChange={e => setSplit(i, { offsetDays: -(Number(e.target.value) || 0) })} title={t('events.settings.scheduleDaysBeforeHint')} />
              <button onClick={() => delSplit(i)} className="w-6 text-rose-400 hover:text-rose-600" title={t('common.delete')} disabled={splits.length <= 1}><X size={14} /></button>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between">
          <button className={BTN_GHOST} onClick={addSplit}><Plus size={13} />{t('events.settings.scheduleAddStage')}</button>
          <span className={`text-xs font-bold tabular-nums ${Math.abs(splitTotal - 100) < 0.5 ? 'text-emerald-600' : 'text-rose-600'}`}>{t('events.settings.scheduleTotal')}: {Math.round(splitTotal)}%</span>
        </div>
        <p className="text-[11px] text-[#9d8b7e]">{t('events.settings.scheduleNote')}</p>
        <div className="flex items-center gap-3">
          <button className={BTN_PRIMARY} onClick={saveSplits} disabled={Math.abs(splitTotal - 100) > 0.5}>{t('common.save')}</button>
          {splitsSaved && <span className="text-xs text-emerald-600 font-semibold flex items-center gap-1"><Check size={13} />{t('common.saved')}</span>}
        </div>
      </div>

      <div className={`${CARD} space-y-3`}>
        <div><label className={LABEL}>{t('events.settings.heroTitle')}</label><input className={INPUT} value={form.hero_title || ''} onChange={e => setForm({ ...form, hero_title: e.target.value })} /></div>
        <div><label className={LABEL}>{t('events.settings.tagline')}</label><input className={INPUT} value={form.tagline || ''} onChange={e => setForm({ ...form, tagline: e.target.value })} /></div>
        <div><label className={LABEL}>{t('events.settings.description')}</label><textarea className={INPUT} rows={3} value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} /></div>
        <div><label className={LABEL}>{t('events.settings.heroImage')}</label>
          <SingleImagePicker restaurantId={restaurantId} token={token} value={form.hero_image_url || ''} onChange={(url) => setForm({ ...form, hero_image_url: url })} /></div>
        <div><label className={LABEL}>{t('events.settings.gallery')}</label>
          <GalleryPicker restaurantId={restaurantId} token={token} images={form.gallery_list || []} onChange={(imgs) => setForm({ ...form, gallery_list: imgs })} />
          <p className="text-[11px] text-[#9d8b7e] mt-1.5">{t('events.settings.galleryHint')}</p></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={LABEL}>{t('common.phone')}</label><input className={INPUT} value={form.contact_phone || ''} onChange={e => setForm({ ...form, contact_phone: e.target.value })} /></div>
          <div><label className={LABEL}>{t('common.email')}</label><input className={INPUT} value={form.contact_email || ''} onChange={e => setForm({ ...form, contact_email: e.target.value })} /></div>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!form.is_published} onChange={e => setForm({ ...form, is_published: e.target.checked })} />{t('events.settings.published')}</label>
        <div className="flex items-center gap-3">
          <button className={BTN_PRIMARY} onClick={save}>{t('common.save')}</button>
          {saved && <span className="text-xs text-emerald-600 font-semibold flex items-center gap-1"><Check size={13} />{t('common.saved')}</span>}
          <a href={publicUrl} target="_blank" rel="noreferrer" className={BTN_GHOST}>{t('events.settings.preview')}</a>
        </div>
      </div>
    </div>
  );
}

// ── Language toggle (shows only when the tenant configured a secondary lang) ──
function LanguageToggle() {
  const { lang, secondary, setLang } = useT();
  if (!secondary) return null;
  return (
    <div className="flex items-center gap-1 mb-3">
      {['en', secondary].map(l => (
        <button key={l} onClick={() => setLang(l)}
          className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border ${lang === l ? 'bg-[#cc5a16] text-white border-[#cc5a16]' : 'bg-white text-[#6b5d52] border-[#e8dccf]'}`}>
          {LANGUAGE_NAMES[l] || l}
        </button>
      ))}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Dispatcher
// ════════════════════════════════════════════════════════════════════════
// ── Data Migration utility — owner-only bulk CSV import with server validation,
// duplicate detection, and an editable fix-it grid. Download a template, upload a
// filled CSV, fix any flagged cells inline, then migrate only the OK rows. ──────
function EventMigration({ restaurantId, token }: Props) {
  const { t } = useT();
  const api = makeApi(restaurantId, token);
  const [specs, setSpecs] = useState<any[]>([]);
  const [entity, setEntity] = useState<string>('RENTAL_ITEM');
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [val, setVal] = useState<any[] | null>(null);
  const [summary, setSummary] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { api('/events/migration/spec').then((r: any) => setSpecs(r.entities || [])).catch(() => {}); }, []);
  const spec = specs.find(s => s.id === entity);
  const cols: any[] = spec?.columns || [];

  const clearAll = () => { setRows([]); setVal(null); setSummary(null); setDirty(false); if (fileRef.current) fileRef.current.value = ''; };
  const pickEntity = (e: string) => { setEntity(e); clearAll(); };
  const template = () => { if (cols.length) downloadCsv(`migration-${entity.toLowerCase()}-template.csv`, [cols.map((c: any) => c.key)]); };

  const validate = async (data: Record<string, string>[]) => {
    if (!data.length) { setVal(null); return; }
    setBusy(true);
    try { const r = await api('/events/migration/validate', { method: 'POST', body: JSON.stringify({ entity, rows: data }) }); setVal(r.rows || []); setDirty(false); }
    catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };
  const onFile = async (f?: File) => {
    if (!f) return; setSummary(null);
    try {
      const grid = parseCsv(await f.text());
      if (grid.length < 2) { alert(t('events.mig.needRows')); return; }
      const headers = grid[0].map(h => String(h).trim());
      const objs = grid.slice(1).map(r => { const o: Record<string, string> = {}; headers.forEach((h, i) => { o[h] = r[i] !== undefined ? String(r[i]) : ''; }); return o; });
      setRows(objs); await validate(objs);
    } catch (e: any) { alert(e.message); }
  };
  const setCell = (i: number, key: string, v: string) => { setRows(rs => rs.map((r, idx) => idx === i ? { ...r, [key]: v } : r)); setDirty(true); };
  const addRow = () => { setRows(rs => [...rs, Object.fromEntries(cols.map((c: any) => [c.key, '']))]); setDirty(true); };
  const delRow = (i: number) => { setRows(rs => rs.filter((_, idx) => idx !== i)); setVal(v => (v ? v.filter((_, idx) => idx !== i) : v)); };
  const migrate = async () => {
    if (!rows.length || !window.confirm(t('events.mig.confirm', { n: rows.length }))) return;
    setBusy(true);
    try { const r = await api('/events/migration/commit', { method: 'POST', body: JSON.stringify({ entity, rows }) }); setSummary(r); await validate(rows); }
    catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };

  const meta: Record<string, { label: string; color: string; bg: string }> = {
    OK: { label: t('events.mig.ready'), color: '#059669', bg: '#e9f7ef' },
    DUPLICATE: { label: t('events.mig.duplicate'), color: '#b45309', bg: '#fef3e2' },
    ERROR: { label: t('events.mig.error'), color: '#dc2626', bg: '#fdecec' },
  };
  const counts = val ? { ok: val.filter(v => v.status === 'OK').length, dup: val.filter(v => v.status === 'DUPLICATE').length, err: val.filter(v => v.status === 'ERROR').length } : null;

  return (
    <div>
      <SectionHeader icon={<Upload size={18} />} title={t('events.mig.title')} sub={t('events.mig.sub')} />
      <div className={`${CARD} mb-4`}>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className={LABEL}>{t('events.mig.entity')}</label>
            <select className={`${INPUT} w-auto`} value={entity} onChange={e => pickEntity(e.target.value)}>
              {(specs.length ? specs : [{ id: entity, label: entity }]).map((s: any) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
          <button className={BTN_GHOST} onClick={template}><FileText size={13} />{t('events.mig.downloadTemplate')}</button>
          <button className={BTN_GHOST} onClick={() => fileRef.current?.click()}><Upload size={13} />{t('events.mig.upload')}</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={e => onFile(e.target.files?.[0])} />
          {rows.length > 0 && <button className={BTN_GHOST} onClick={clearAll}><X size={13} />{t('events.mig.clear')}</button>}
        </div>
        <p className="text-[11px] text-[#9d8b7e] mt-2">{t('events.mig.help')}</p>
      </div>

      {summary && (
        <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          <strong>{t('events.mig.done')}</strong> — {t('events.mig.created', { n: summary.created })} · {t('events.mig.skippedDup', { n: summary.skipped })} · {t('events.mig.failed', { n: summary.failed })}
        </div>
      )}

      {rows.length > 0 && (
        <div className={`${CARD} mb-4`}>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2 text-xs flex-wrap">
              {counts && <>
                <span className="px-2 py-0.5 rounded-full font-bold" style={{ background: '#e9f7ef', color: '#059669' }}>{counts.ok} {t('events.mig.ready')}</span>
                <span className="px-2 py-0.5 rounded-full font-bold" style={{ background: '#fef3e2', color: '#b45309' }}>{counts.dup} {t('events.mig.duplicate')}</span>
                <span className="px-2 py-0.5 rounded-full font-bold" style={{ background: '#fdecec', color: '#dc2626' }}>{counts.err} {t('events.mig.error')}</span>
              </>}
              {dirty && <span className="text-[#b45309] font-semibold">{t('events.mig.dirty')}</span>}
            </div>
            <div className="flex items-center gap-2">
              <button className={BTN_GHOST} onClick={addRow}><Plus size={13} />{t('events.mig.addRow')}</button>
              <button className={BTN_GHOST} disabled={busy} onClick={() => validate(rows)}><RefreshCw size={13} className={busy ? 'animate-spin' : ''} />{t('events.mig.validate')}</button>
              <button className={BTN_PRIMARY} disabled={busy || dirty || !counts || counts.ok === 0} onClick={migrate}><Check size={13} />{t('events.mig.migrate', { n: counts?.ok || 0 })}</button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="text-xs border-collapse">
              <thead>
                <tr className="text-left text-[#9d8b7e] border-b border-[#e8dccf]">
                  <th className="py-1.5 pr-2">{t('events.mig.status')}</th>
                  {cols.map((c: any) => <th key={c.key} className="py-1.5 px-2 whitespace-nowrap font-semibold">{c.label}{c.required ? ' *' : ''}</th>)}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const rv = val && !dirty ? val[i] : null;
                  const m = rv?.status ? meta[rv.status] : null;
                  return (
                    <tr key={i} className="border-b border-[#f0e9df] align-top">
                      <td className="py-1 pr-2">{m ? <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap" style={{ background: m.bg, color: m.color }}>{m.label}</span> : <span className="text-[#c9bcae]">—</span>}</td>
                      {cols.map((c: any) => {
                        const err = rv?.errors?.[c.key]; const warn = rv?.warnings?.[c.key];
                        return (
                          <td key={c.key} className="py-1 px-1">
                            <input value={r[c.key] ?? ''} onChange={e => setCell(i, c.key, e.target.value)} title={err || warn || c.hint || ''}
                              className={`w-full min-w-[7rem] px-1.5 py-1 rounded border text-xs ${err ? 'border-rose-400 bg-rose-50' : warn ? 'border-amber-300 bg-amber-50' : 'border-[#e8dccf]'}`} />
                          </td>
                        );
                      })}
                      <td className="py-1 pl-1"><button onClick={() => delRow(i)} title={t('events.mig.removeRow')}><Trash2 size={13} className="text-rose-400" /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {val && !dirty && ((counts?.err || 0) + (counts?.dup || 0)) > 0 && <p className="text-[11px] text-[#9d8b7e] mt-2">{t('events.mig.note')}</p>}
        </div>
      )}
    </div>
  );
}

function EventsModuleInner({ restaurantId, token, tab }: Props & { tab: string }) {
  switch (tab) {
    case 'EVENTS_DASHBOARD': return <EventDashboard restaurantId={restaurantId} token={token} />;
    case 'EVENTS_CALENDAR': return <EventCalendar restaurantId={restaurantId} token={token} />;
    case 'EVENTS_BOOKINGS': return <EventBookings restaurantId={restaurantId} token={token} />;
    case 'EVENTS_VENUES': return <EventVenues restaurantId={restaurantId} token={token} />;
    case 'EVENTS_RENTALS': return <EventRentals restaurantId={restaurantId} token={token} />;
    case 'EVENTS_SERVICES': return <EventServices restaurantId={restaurantId} token={token} />;
    case 'EVENTS_CATERING': return <EventCatering restaurantId={restaurantId} token={token} />;
    case 'EVENTS_QUOTATIONS': return <EventQuotations restaurantId={restaurantId} token={token} />;
    case 'EVENTS_REPORTS': return <EventReports restaurantId={restaurantId} token={token} />;
    case 'EVENTS_SETTINGS': return <EventSettings restaurantId={restaurantId} token={token} />;
    case 'EVENTS_MIGRATION': return <EventMigration restaurantId={restaurantId} token={token} />;
    default: return null;
  }
}

export function EventsModule(props: Props & { tab: string }) {
  return (
    <div>
      <LanguageToggle />
      <EventsModuleInner {...props} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// PUBLIC events page (unauthenticated) — /events/:tenantId
// ════════════════════════════════════════════════════════════════════════
export function EventBookingPage({ tenantId }: { tenantId: string }) {
  const { t } = useT();
  const [data, setData] = useState<any>(null);
  const [form, setForm] = useState<any>({ customer_name: '', customer_phone: '', customer_email: '', event_type: 'WEDDING', venue_id: '', event_date: '', guest_count: '', special_requests: '' });
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { (async () => {
    try {
      const r = await fetch(`/api/public/restaurant/${encodeURIComponent(tenantId)}/events`);
      if (r.ok) setData(await r.json()); else setData({ error: true });
    } catch { setData({ error: true }); }
  })(); }, [tenantId]);

  const submit = async () => {
    setError('');
    if (!form.customer_name || !form.customer_phone || !form.event_date) { setError('Name, phone and date are required'); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/public/restaurant/${encodeURIComponent(tenantId)}/events/inquiry`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, guest_count: Number(form.guest_count || 0) }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { setError(b.error || 'Failed to submit'); return; }
      setDone(true);
    } catch { setError('Network error'); } finally { setBusy(false); }
  };

  if (!data) return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{t('common.loading')}</div>;
  if (data.error) return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Events page not available.</div>;

  const p = data.profile || {};
  const property = data.property || {};
  let gallery: string[] = [];
  try { const g = p.gallery ? JSON.parse(p.gallery) : []; if (Array.isArray(g)) gallery = g.filter(Boolean); } catch { /* */ }
  const heroImg = p.hero_image_url || gallery[0] || '';
  const venues = data.venues || [];
  const capMin = venues.length ? Math.min(...venues.map((v: any) => Number(v.min_occupancy || 0)).filter((n: number) => n > 0)) : 0;
  const capMax = venues.length ? Math.max(...venues.map((v: any) => Number(v.max_occupancy || 0))) : 0;
  const heroBg = heroImg
    ? `linear-gradient(180deg, rgba(20,17,12,0.35) 0%, rgba(20,17,12,0.75) 100%), url("${heroImg}") center/cover no-repeat`
    : 'linear-gradient(135deg, #cc5a16, #7c3aed)';

  return (
    <div style={{ minHeight: '100vh', background: '#faf7f2', color: '#14110c', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section style={{ background: heroBg, color: '#fff', minHeight: heroImg ? '68vh' : 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '64px 20px' }}>
        <div style={{ maxWidth: 760 }}>
          {property.logo_url && <img src={property.logo_url} alt="" style={{ height: 54, marginBottom: 18, borderRadius: 10 }} />}
          <h1 style={{ fontSize: 'clamp(30px, 6vw, 52px)', fontWeight: 800, margin: 0, lineHeight: 1.08, letterSpacing: '-0.02em', textShadow: heroImg ? '0 2px 16px rgba(0,0,0,0.4)' : 'none' }}>
            {p.hero_title || property.name || t('public.events.enquire')}
          </h1>
          {p.tagline && <p style={{ fontSize: 'clamp(15px, 2.4vw, 20px)', opacity: 0.95, marginTop: 14, textShadow: heroImg ? '0 1px 8px rgba(0,0,0,0.4)' : 'none' }}>{p.tagline}</p>}
          <a href="#enquire" style={{ display: 'inline-block', marginTop: 26, background: '#fff', color: '#7c3aed', fontWeight: 700, padding: '13px 30px', borderRadius: 999, textDecoration: 'none', boxShadow: '0 8px 24px rgba(0,0,0,0.18)' }}>
            {t('public.events.enquire')}
          </a>
          {(capMax > 0 || venues.length > 0) && (
            <div style={{ marginTop: 30, display: 'flex', gap: 28, justifyContent: 'center', flexWrap: 'wrap', fontSize: 13, opacity: 0.95 }}>
              {venues.length > 0 && <span><b style={{ fontSize: 22, display: 'block' }}>{venues.length}</b>{t('public.events.venues')}</span>}
              {capMax > 0 && <span><b style={{ fontSize: 22, display: 'block' }}>{capMin || '—'}–{capMax}</b>{t('public.events.capacity')}</span>}
            </div>
          )}
        </div>
      </section>

      <div style={{ maxWidth: 1040, margin: '0 auto', padding: '0 20px' }}>
        {p.description && <p style={{ color: '#4b423a', textAlign: 'center', fontSize: 17, lineHeight: 1.6, maxWidth: 720, margin: '40px auto 8px' }}>{p.description}</p>}

        {/* ── Gallery ────────────────────────────────────────────────────── */}
        {gallery.length > 0 && (
          <div style={{ margin: '36px 0' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10, gridAutoRows: 150 }}>
              {gallery.slice(0, 8).map((src, i) => (
                <div key={i} style={{ background: `url("${src}") center/cover no-repeat`, borderRadius: 14, gridColumn: i === 0 ? 'span 2' : 'auto', gridRow: i === 0 ? 'span 2' : 'auto', border: '1px solid #e8dccf' }} />
              ))}
            </div>
          </div>
        )}

        {/* ── Venues ─────────────────────────────────────────────────────── */}
        {venues.length > 0 && (
          <div style={{ margin: '44px 0' }}>
            <h2 style={{ fontSize: 26, fontWeight: 800, marginBottom: 4, letterSpacing: '-0.01em' }}>{t('public.events.venues')}</h2>
            <div style={{ width: 48, height: 3, background: '#cc5a16', borderRadius: 2, marginBottom: 22 }} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 18 }}>
              {venues.map((v: any) => (
                <div key={v.id} style={{ background: '#fff', border: '1px solid #ece3d7', borderRadius: 18, overflow: 'hidden', boxShadow: '0 2px 12px rgba(20,17,12,0.05)' }}>
                  <div style={{ height: 172, background: v.image_url ? `url("${v.image_url}") center/cover no-repeat` : 'linear-gradient(135deg, #efe7fb, #fbe6da)', position: 'relative' }}>
                    <span style={{ position: 'absolute', top: 12, left: 12, background: 'rgba(255,255,255,0.92)', color: '#7c3aed', fontWeight: 700, fontSize: 11, padding: '4px 10px', borderRadius: 999 }}>
                      {v.ac_type === 'AC' ? t('events.venues.ac') : t('events.venues.nonAc')}
                    </span>
                  </div>
                  <div style={{ padding: 16 }}>
                    <div style={{ fontWeight: 700, fontSize: 17 }}>{v.name}</div>
                    <div style={{ fontSize: 13, color: '#6b5d52', marginTop: 2 }}>{v.category} · {t('public.events.capacity')} {v.min_occupancy}–{v.max_occupancy}</div>
                    {v.amenities && <div style={{ fontSize: 12, color: '#9d8b7e', marginTop: 8, lineHeight: 1.4 }}>{String(v.amenities).split(',').slice(0, 4).map((a: string) => a.trim()).filter(Boolean).join(' · ')}</div>}
                    <div style={{ marginTop: 12, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                      <span style={{ fontWeight: 800, color: '#cc5a16', fontSize: 19 }}>{money(v.daily_rate)}<span style={{ fontSize: 12, fontWeight: 400, color: '#9d8b7e' }}> / day</span></span>
                      <a href="#enquire" onClick={() => setForm((f: any) => ({ ...f, venue_id: v.id }))} style={{ fontSize: 13, fontWeight: 700, color: '#7c3aed', textDecoration: 'none' }}>{t('public.events.enquire')} →</a>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Inquiry form ───────────────────────────────────────────────── */}
        <div id="enquire" style={{ scrollMarginTop: 20, background: '#fff', border: '1px solid #ece3d7', borderRadius: 22, padding: 28, margin: '20px 0 56px', boxShadow: '0 4px 20px rgba(20,17,12,0.06)' }}>
          <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>{t('public.events.enquire')}</h2>
          <p style={{ fontSize: 14, color: '#6b5d52', marginBottom: 18 }}>{t('public.events.formSub')}</p>
          {done ? (
            <div style={{ textAlign: 'center', padding: 32, color: '#047857', fontWeight: 700, fontSize: 17 }}>✓ {t('public.events.thankYou')}</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              <input className={INPUT} placeholder={t('public.events.yourName')} value={form.customer_name} onChange={e => setForm({ ...form, customer_name: e.target.value })} />
              <input className={INPUT} placeholder={t('public.events.yourPhone')} value={form.customer_phone} onChange={e => setForm({ ...form, customer_phone: e.target.value })} />
              <input className={INPUT} placeholder={t('public.events.yourEmail')} value={form.customer_email} onChange={e => setForm({ ...form, customer_email: e.target.value })} />
              <select className={INPUT} value={form.event_type} onChange={e => setForm({ ...form, event_type: e.target.value })}>
                {['WEDDING', 'RECEPTION', 'CONFERENCE', 'BIRTHDAY', 'CORPORATE', 'OTHER'].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <select className={INPUT} value={form.venue_id} onChange={e => setForm({ ...form, venue_id: e.target.value })}>
                <option value="">{t('events.bookings.venue')} —</option>
                {venues.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <input type="date" className={INPUT} value={form.event_date} onChange={e => setForm({ ...form, event_date: e.target.value })} />
              <input type="number" className={INPUT} placeholder={t('public.events.guests')} value={form.guest_count} onChange={e => setForm({ ...form, guest_count: e.target.value })} />
              <textarea className={INPUT} style={{ gridColumn: '1 / -1' }} rows={3} placeholder={t('public.events.message')} value={form.special_requests} onChange={e => setForm({ ...form, special_requests: e.target.value })} />
              {error && <div style={{ gridColumn: '1 / -1', color: '#dc2626', fontSize: 13 }}>{error}</div>}
              <button className={BTN_PRIMARY} style={{ gridColumn: '1 / -1', justifyContent: 'center', padding: 14, fontSize: 15 }} disabled={busy} onClick={submit}>
                {busy ? t('public.events.submitting') : t('public.events.submit')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer style={{ background: '#14110c', color: '#d8cfc4', textAlign: 'center', padding: '28px 20px', fontSize: 13 }}>
        <div style={{ fontWeight: 700, color: '#fff', fontSize: 15 }}>{property.name}</div>
        <div style={{ marginTop: 6 }}>
          {[property.city, property.state].filter(Boolean).join(', ')}
          {(p.contact_phone || property.phone) ? `  ·  ${p.contact_phone || property.phone}` : ''}
          {p.contact_email ? `  ·  ${p.contact_email}` : ''}
        </div>
      </footer>
    </div>
  );
}
