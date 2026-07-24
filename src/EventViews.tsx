// ════════════════════════════════════════════════════════════════════════
// Events & Convention Center — frontend views (gated by events_enabled).
// Mirrors the Spa module's structure: <EventsModule tab=… /> dispatches to the
// right sub-view; the public inquiry page is exported separately. Strings run
// through the i18n t() so the whole module is translatable.
// ════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect } from 'react';
import { DataTable } from './components/DataTable';
import { ObjectDetail } from './components/ObjectDetail';
import { useT, LANGUAGE_NAMES, SECONDARY_LANGUAGE_OPTIONS } from './i18n';
import {
  CalendarRange, Plus, Trash2, Check, X, Building2, Sofa, Users, FileText,
  RefreshCw, Send, IndianRupee, ClipboardList, Hotel, Utensils,
  AlertTriangle, Mail, Phone,
} from 'lucide-react';

// ── shared fetch helper ─────────────────────────────────────────────────────
function makeApi(restaurantId: string, token: string) {
  return async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`/api/restaurant/${restaurantId}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((b && b.error) || `HTTP ${r.status}`);
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
function SendQuoteDialog({ restaurantId, token, quotationId, defaultEmail, onClose, onSent }:
  { restaurantId: string; token: string; quotationId: string; defaultEmail?: string; onClose: () => void; onSent: (to: string) => void }) {
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
      await api(`/events/quotations/${quotationId}/send`, { method: 'POST', body: JSON.stringify({ email: email.trim() }) });
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
  const blank = { name: '', category: 'BANQUET', ac_type: 'AC', min_occupancy: '', max_occupancy: '', floor_area: '', hourly_rate: '', half_day_rate: '', daily_rate: '', amenities: '' };
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
            <div><label className={LABEL}>{t('events.venues.hourlyRate')}</label><input type="number" className={INPUT} value={form.hourly_rate} onChange={e => setForm({ ...form, hourly_rate: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.venues.halfDayRate')}</label><input type="number" className={INPUT} value={form.half_day_rate} onChange={e => setForm({ ...form, half_day_rate: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.venues.dailyRate')}</label><input type="number" className={INPUT} value={form.daily_rate} onChange={e => setForm({ ...form, daily_rate: e.target.value })} /></div>
            <div className="col-span-2 md:col-span-3"><label className={LABEL}>{t('events.venues.amenities')}</label><input className={INPUT} value={form.amenities} onChange={e => setForm({ ...form, amenities: e.target.value })} placeholder="Stage, projector, parking, green room" /></div>
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
        columns={[
          { key: 'name', label: t('events.venues.name') },
          { key: 'category', label: t('common.category') },
          { key: 'ac_type', label: t('events.venues.acType'), render: (r: any) => r.ac_type === 'AC' ? t('events.venues.ac') : t('events.venues.nonAc') },
          { key: 'max_occupancy', label: t('events.venues.occupancy'), render: (r: any) => `${r.min_occupancy || 0}–${r.max_occupancy || 0}` },
          { key: 'daily_rate', label: t('events.venues.dailyRate'), render: (r: any) => money(r.daily_rate) },
          { key: '_a', label: t('common.actions'), render: (r: any) => (
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
  const blank = { name: '', category: 'FURNITURE', unit: 'piece', quantity_owned: '', rent_hourly: '', rent_daily: '', rent_weekly: '', deposit: '' };
  const [form, setForm] = useState<any>(blank);

  const load = async () => { try { setRows(await api('/events/rental-items')); } catch { /* */ } };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!form.name) return;
    const body = { ...form, quantity_owned: Number(form.quantity_owned || 0), rent_hourly: Number(form.rent_hourly || 0), rent_daily: Number(form.rent_daily || 0), rent_weekly: Number(form.rent_weekly || 0), deposit: Number(form.deposit || 0) };
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
        columns={[
          { key: 'name', label: t('common.name') },
          { key: 'category', label: t('common.category') },
          { key: 'quantity_owned', label: t('events.rentals.qtyOwned') },
          { key: 'rent_hourly', label: t('events.rentals.rentHourly'), render: (r: any) => money(r.rent_hourly) },
          { key: 'rent_daily', label: t('events.rentals.rentDaily'), render: (r: any) => money(r.rent_daily) },
          { key: 'rent_weekly', label: t('events.rentals.rentWeekly'), render: (r: any) => money(r.rent_weekly) },
          { key: '_a', label: t('common.actions'), render: (r: any) => (
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
  const blank = { name: '', category: 'STAFF', pricing_type: 'PER_EVENT', rate: '' };
  const [form, setForm] = useState<any>(blank);

  const load = async () => { try { setRows(await api('/events/services')); } catch { /* */ } };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!form.name) return;
    try {
      const body = { ...form, rate: Number(form.rate || 0) };
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
        columns={[
          { key: 'name', label: t('common.name') },
          { key: 'category', label: t('common.category') },
          { key: 'pricing_type', label: t('events.services.pricingType') },
          { key: 'rate', label: t('events.services.rate'), render: (r: any) => money(r.rate) },
          { key: '_a', label: t('common.actions'), render: (r: any) => (
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
  const blank = { name: '', package_type: 'BUFFET', price_per_plate: '', gst_percent: '5', description: '', sections: [{ name: '', optionsText: '' }] };
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
    const body = { name: form.name, package_type: form.package_type, price_per_plate: Number(form.price_per_plate || 0), gst_percent: Number(form.gst_percent || 5), description: form.description, menu_json: menu };
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
        columns={[
          { key: 'name', label: t('common.name') },
          { key: 'package_type', label: t('events.catering.type'), render: (r: any) => r.package_type === 'PLATED' ? t('events.catering.plated') : t('events.catering.buffet') },
          { key: 'price_per_plate', label: t('events.catering.pricePerPlate'), render: (r: any) => money(r.price_per_plate) },
          { key: 'menu_json', label: t('events.catering.sections'), render: (r: any) => { try { const m = JSON.parse(r.menu_json || '[]'); return (m || []).map((s: any) => s.section).join(', ') || '—'; } catch { return '—'; } } },
          { key: '_a', label: t('common.actions'), render: (r: any) => (
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
  const blank = { customer_name: '', customer_phone: '', customer_email: '', event_type: 'WEDDING', venue_id: '', event_date: new Date().toISOString().slice(0, 10), end_date: '', start_time: '10:00', end_time: '22:00', venue_rate_basis: 'DAILY', guest_count: '' };
  const [form, setForm] = useState<any>(blank);

  const load = async () => { try { setRows(await api('/events/bookings')); } catch { /* */ } };
  const loadVenues = async () => { try { setVenues(await api('/events/venues')); } catch { /* */ } };
  useEffect(() => { load(); loadVenues(); }, []);

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
            <div><label className={LABEL}>{t('events.bookings.startTime')}</label><input type="time" className={INPUT} value={form.start_time} onChange={e => setForm({ ...form, start_time: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.bookings.endTime')}</label><input type="time" className={INPUT} value={form.end_time} onChange={e => setForm({ ...form, end_time: e.target.value })} /></div>
            <div><label className={LABEL}>{t('events.bookings.rateBasis')}</label>
              <select className={INPUT} value={form.venue_rate_basis} onChange={e => setForm({ ...form, venue_rate_basis: e.target.value })}>
                {['DAILY', 'HALF_DAY', 'HOURLY'].map(c => <option key={c} value={c}>{c}</option>)}
              </select></div>
            <div><label className={LABEL}>{t('events.bookings.guests')}</label><input type="number" className={INPUT} value={form.guest_count} onChange={e => setForm({ ...form, guest_count: e.target.value })} /></div>
          </div>
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
        columns={[
          { key: 'customer_name', label: t('events.bookings.customer') },
          { key: 'venue_name', label: t('events.bookings.venue'), render: (r: any) => r.venue_name || '—' },
          { key: 'event_date', label: t('events.bookings.eventDate'), render: (r: any) => { const s = String(r.event_date || '').slice(0, 10); const e = String(r.end_date || '').slice(0, 10); return e && e > s ? `${s} → ${e}` : s; } },
          { key: 'guest_count', label: t('events.bookings.guests') },
          { key: 'total_amount', label: t('common.total'), render: (r: any) => money(r.total_amount) },
          { key: 'status', label: t('common.status'), render: (r: any) => <Pill status={r.status} /> },
          { key: '_a', label: t('common.actions'), render: (r: any) => <button className={BTN_GHOST} onClick={() => setObjStack([{ type: 'EVENT_BOOKING', id: r.id }])}>{t('common.edit')}</button> },
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
function PaymentPanel({ restaurantId, token, booking, editable, onChanged }: Props & { booking: any; editable: boolean; onChanged: () => void }) {
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
  useEffect(() => { load(); }, [bid]);

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
          {editable && <button className={BTN_PRIMARY} onClick={() => openPay()}><Plus size={12} />{t('events.pay.record')}</button>}
        </div>
      </div>

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
            {editable && s.status !== 'PAID' && <button className={BTN_GHOST} onClick={() => openPay(s)}>{t('events.pay.pay')}</button>}
            {editable && <button onClick={() => delSched(s.id)}><X size={12} className="text-rose-500" /></button>}
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

// ── Cancel-with-reason dialog (lost-reason capture) ──────────────────────────
function CancelEventDialog({ restaurantId, token, bookingId, onClose, onCancelled }: Props & { bookingId: string; onClose: () => void; onCancelled: () => void }) {
  const { t } = useT();
  const api = makeApi(restaurantId, token);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const REASONS = ['Price too high', 'Date unavailable', 'Went with competitor', 'Event postponed', 'Customer unresponsive', 'Other'];
  const submit = async () => {
    if (!reason) { alert(t('events.cancel.pickReason')); return; }
    setBusy(true);
    try { await api(`/events/bookings/${bookingId}/cancel`, { method: 'POST', body: JSON.stringify({ reason, note }) }); onCancelled(); onClose(); }
    catch (e: any) { alert(e.message); setBusy(false); }
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
          <button className={BTN_DANGER} onClick={submit} disabled={busy || !reason}>{t('events.bookings.cancel')}</button>
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
  const [caterPkgs, setCaterPkgs] = useState<any[]>([]);
  const [nonce, setNonce] = useState(0);

  const load = async () => { try { setBk(await api(`/events/bookings/${bookingId}`)); setNonce(n => n + 1); } catch (e: any) { alert(e.message); } };
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
    // Clamp to [0, subtotal] so the discount can never exceed the bill. subtotal
    // is the pre-discount total: total_amount is already net of the old discount,
    // so subtotal = total_amount + current discount.
    const sub = Number(bk.total_amount || 0) + Number(bk.discount || 0);
    const num = Math.min(sub, Math.max(0, Number(value) || 0));
    if (Number(bk.discount || 0) === num) return;
    await api(`/events/bookings/${bookingId}`, { method: 'PUT', body: JSON.stringify({ discount: num }) });
    await load();
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

  const act = async (path: string, okMsg?: string) => {
    setBusy(true);
    try { const r = await api(`/events/bookings/${bookingId}/${path}`, { method: 'POST', body: JSON.stringify({}) }); if (r?.warning) alert(r.warning); else if (okMsg) alert(okMsg); await load(); }
    catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };
  const genQuote = async () => {
    setBusy(true);
    try { const q = await api(`/events/bookings/${bookingId}/quotations`, { method: 'POST', body: JSON.stringify({}) }); await openAuthedPdf(`/api/restaurant/${restaurantId}/events/quotations/${q.id}/pdf`, token); await load(); }
    catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };

  if (!bk) return <div className="text-sm text-[#6b5d52]">{t('common.loading')}</div>;
  const editable = bk.status !== 'COMPLETED' && bk.status !== 'CANCELLED';
  // Bill ledger figures. total_amount is already net of discount (server-side),
  // so the pre-discount subtotal = total_amount + discount.
  const evDiscount = Number(bk.discount || 0);
  const evSubtotal = Number(bk.total_amount || 0) + evDiscount;
  const evPct = evSubtotal > 0 ? Math.round((evDiscount / evSubtotal) * 100) : 0;
  const hasEmail = !!(bk.customer_email && String(bk.customer_email).trim());

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
            <div className="flex items-center justify-between text-xs text-[#6b5d52] mb-1.5">
              <span>{t('events.bookings.subtotal')}</span>
              <span className="tabular-nums">{money(evSubtotal)}</span>
            </div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-[#6b5d52]">{t('events.bookings.discount')}</span>
              {editable ? (
                <span className="flex items-center gap-1">
                  <span className="text-xs text-rose-500">− ₹</span>
                  <input type="number" min={0} max={evSubtotal} defaultValue={evDiscount} onBlur={e => commitDiscount(e.target.value)}
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
            <div className="h-px bg-[#e8dccf] my-1.5" />
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold text-[#14110c]">{t('events.bookings.grandTotal')}</span>
              <span className="text-2xl font-bold text-[#cc5a16] tabular-nums">{money(bk.total_amount)}</span>
            </div>
            <p className="mt-1.5 text-[10px] text-[#9d8b7e] text-right">{t('events.bookings.gstNote')}</p>
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
              <span className="flex-1 min-w-0 truncate">{it.name_snapshot} <span className="text-[#9d8b7e]">({it.rate_basis})</span></span>
              {editable ? (
                <>
                  <input type="number" min={0} defaultValue={it.quantity} title="Qty" onBlur={e => commitLine('items', i, 'quantity', e.target.value)} className="w-11 px-1 py-0.5 rounded border border-[#e8dccf] text-right" />
                  <span className="text-[#9d8b7e]">×₹</span>
                  <input type="number" min={0} defaultValue={it.unit_rate} title="Unit price" onBlur={e => commitLine('items', i, 'unit_rate', e.target.value)} className="w-16 px-1 py-0.5 rounded border border-[#e8dccf] text-right" />
                </>
              ) : <span className="text-[#9d8b7e]">{it.quantity} × {money(it.unit_rate)}</span>}
              <span className="w-16 text-right font-semibold">{money(it.line_total)}</span>
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
              <span className="flex-1 min-w-0 truncate">{sv.name_snapshot}</span>
              {editable ? (
                <>
                  <input type="number" min={0} defaultValue={sv.quantity} title="Qty" onBlur={e => commitLine('services', i, 'quantity', e.target.value)} className="w-11 px-1 py-0.5 rounded border border-[#e8dccf] text-right" />
                  <span className="text-[#9d8b7e]">×₹</span>
                  <input type="number" min={0} defaultValue={sv.unit_rate} title="Unit price" onBlur={e => commitLine('services', i, 'unit_rate', e.target.value)} className="w-16 px-1 py-0.5 rounded border border-[#e8dccf] text-right" />
                </>
              ) : <span className="text-[#9d8b7e]">{sv.quantity} × {money(sv.unit_rate)}</span>}
              <span className="w-16 text-right font-semibold">{money(sv.line_total)}</span>
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
      <PaymentPanel restaurantId={restaurantId} token={token} booking={bk} editable={editable} onChanged={load} />

      {/* Lifecycle actions */}
      <div className="flex flex-wrap gap-2 mt-4">
        <button className={BTN_GHOST} disabled={busy} onClick={genQuote}><FileText size={13} />{t('events.bookings.generateQuote')}</button>
        {(bk.status === 'INQUIRY' || bk.status === 'QUOTED') && <button className={BTN_PRIMARY} disabled={busy} onClick={() => act('confirm')}><Check size={13} />{t('events.bookings.confirm')}</button>}
        {(bk.status === 'CONFIRMED' || bk.status === 'IN_PROGRESS') && <button className={BTN_PRIMARY} disabled={busy} onClick={() => act('checkout')}><IndianRupee size={13} />{t('events.bookings.checkout')}</button>}
        {(bk.status === 'CONFIRMED' || bk.status === 'IN_PROGRESS') && <button className={BTN_GHOST} disabled={busy} onClick={() => act('complete')}>{t('events.bookings.complete')}</button>}
        {editable && <button className={BTN_DANGER} disabled={busy} onClick={() => setShowCancel(true)}>{t('events.bookings.cancel')}</button>}
      </div>

      {showCancel && (
        <CancelEventDialog restaurantId={restaurantId} token={token} bookingId={bookingId}
          onClose={() => setShowCancel(false)} onCancelled={() => load()} />
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
  const cellFor = (venueId: string, date: string) => {
    const blocked = (data?.blocks || []).some((b: any) => b.venue_id === venueId && String(b.from_date).slice(0, 10) <= date && String(b.to_date).slice(0, 10) >= date);
    if (blocked) return { title: t('events.calendar.blocked'), sty: EV_CAL.BLOCKED, booking: null as any, isStart: false };
    const booked = (data?.bookings || []).find((b: any) => b.venue_id === venueId && covers(b, date) && ['CONFIRMED', 'IN_PROGRESS'].includes(b.status));
    if (booked) return { title: `${booked.customer_name} · ${booked.status}`, sty: EV_CAL.CONFIRMED, booking: booked, isStart: String(booked.event_date).slice(0, 10) === date };
    const tentative = (data?.bookings || []).find((b: any) => b.venue_id === venueId && covers(b, date) && ['INQUIRY', 'QUOTED'].includes(b.status));
    if (tentative) return { title: `${tentative.customer_name} · ${tentative.status}`, sty: EV_CAL.TENTATIVE, booking: tentative, isStart: String(tentative.event_date).slice(0, 10) === date };
    return { title: t('events.calendar.free'), sty: EV_CAL.FREE, booking: null as any, isStart: false };
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
                          <button type="button" onClick={() => setObjStack([{ type: 'EVENT_BOOKING', id: c.booking.id }])}
                            className="block w-full text-[9px] font-semibold px-0.5 py-1.5 truncate cursor-pointer hover:brightness-95 hover:underline focus:outline-none"
                            style={{ background: c.sty.bg, color: c.sty.fg }}>{label}</button>
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
        columns={[
          { key: 'quote_number', label: t('events.quotes.number') },
          { key: 'customer_name', label: t('events.bookings.customer') },
          { key: 'grand_total', label: t('common.total'), render: (r: any) => money(r.grand_total) },
          { key: 'valid_until', label: t('events.quotes.validUntil'), render: (r: any) => String(r.valid_until || '').slice(0, 10) },
          { key: 'status', label: t('common.status'), render: (r: any) => <Pill status={r.status} /> },
          { key: '_a', label: t('common.actions'), render: (r: any) => (
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

  const top = objStack[objStack.length - 1];
  if (top) return (
    <EventObjectRouter restaurantId={restaurantId} token={token} obj={top} venues={[]}
      onOpenObject={(type, id) => setObjStack(s => [...s, { type, id }])}
      onBack={() => setObjStack(s => s.slice(0, -1))} />
  );

  const k = data?.kpis;
  const tile = (label: string, value: string, sub?: string, accent = '#cc5a16') => (
    <div className={CARD}>
      <div className="text-[10px] font-bold uppercase tracking-wide text-[#9d8b7e]">{label}</div>
      <div className="text-2xl font-bold mt-0.5 tabular-nums" style={{ color: accent }}>{value}</div>
      {sub && <div className="text-[11px] text-[#6b5d52] mt-0.5">{sub}</div>}
    </div>
  );
  const openLeads = data ? ((data.funnel.find((f: any) => f.status === 'INQUIRY')?.count || 0) + (data.funnel.find((f: any) => f.status === 'QUOTED')?.count || 0)) : 0;
  const maxMonth = Math.max(1, ...((data?.revenueByMonth || []).map((m: any) => m.revenue)));
  const maxFunnel = Math.max(1, ...((data?.funnel || []).map((f: any) => f.count)));

  return (
    <div>
      <SectionHeader icon={<IndianRupee size={18} />} title={t('events.dash.title')} sub={t('events.dash.sub')} />
      <PeriodBar from={from} to={to} setFrom={setFrom} setTo={setTo} />
      {loading || !data ? <p className="text-sm text-[#6b5d52]">{t('common.loading')}</p> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            {tile(t('events.dash.confirmedRevenue'), money(k.confirmedRevenue), `${k.wonCount} ${t('events.dash.wonEvents')}`)}
            {tile(t('events.dash.pipeline'), money(k.pipelineRevenue), `${openLeads} ${t('events.dash.openLeads')}`, '#2563eb')}
            {tile(t('events.dash.winRate'), `${k.winRate}%`, `${k.wonCount} ${t('common.of')} ${k.wonCount + k.lostCount}`, '#059669')}
            {tile(t('events.dash.avgValue'), money(k.avgBookingValue), t('events.dash.perEvent'), '#7c3aed')}
            {tile(t('events.dash.outstanding'), money(k.outstanding), Number(k.overdue) > 0 ? `${t('events.dash.overdueLabel')} ${money(k.overdue)}` : `${t('events.dash.advance')} ${money(k.advanceCollected)}`, '#dc2626')}
            {tile(t('events.dash.covers'), String(k.totalCovers), t('events.dash.guestsServed'))}
            {tile(t('events.dash.catering'), money(k.cateringRevenue), `${k.cateringCovers} ${t('events.dash.plates')}`, '#b45309')}
            {tile(t('events.dash.discount'), money(k.discountGiven), t('events.dash.givenWon'), '#9ca3af')}
          </div>

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
    rows.push([], ['RECEIVABLES'], ['Customer', 'Event date', 'Total', 'Advance', 'Outstanding']);
    data.receivables.forEach((v: any) => rows.push([v.customer_name, v.event_date, v.total_amount, v.advance_amount, v.outstanding]));
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
          {table(t('events.dash.receivables'), [t('events.bookings.customer'), t('events.bookings.eventDate'), t('common.total'), t('events.bookings.advance'), t('events.dash.outstanding')],
            data.receivables.map((v: any) => [v.customer_name, v.event_date, money(v.total_amount), money(v.advance_amount), money(v.outstanding)]))}
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
  useEffect(() => { api('/events/profile').then((p) => { if (p && p.id) setForm({ ...p, is_published: Number(p.is_published) !== 0 }); }).catch(() => {}); }, []);
  useEffect(() => { api('/settings/language').then((r) => setSecLang(r.secondary_language || '')).catch(() => {}); }, []);
  const save = async () => { try { await api('/events/profile', { method: 'PUT', body: JSON.stringify(form) }); setSaved(true); setTimeout(() => setSaved(false), 1500); } catch (e: any) { alert(e.message); } };
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
      </div>

      <div className={`${CARD} space-y-3`}>
        <div><label className={LABEL}>{t('events.settings.heroTitle')}</label><input className={INPUT} value={form.hero_title || ''} onChange={e => setForm({ ...form, hero_title: e.target.value })} /></div>
        <div><label className={LABEL}>{t('events.settings.tagline')}</label><input className={INPUT} value={form.tagline || ''} onChange={e => setForm({ ...form, tagline: e.target.value })} /></div>
        <div><label className={LABEL}>{t('events.settings.description')}</label><textarea className={INPUT} rows={3} value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} /></div>
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
  return (
    <div style={{ minHeight: '100vh', background: '#faf7f2', color: '#14110c' }}>
      {/* Hero */}
      <div style={{ background: 'linear-gradient(135deg, #cc5a16, #7c3aed)', color: '#fff', padding: '48px 20px', textAlign: 'center' }}>
        <h1 style={{ fontSize: 34, fontWeight: 800, margin: 0 }}>{p.hero_title || property.name || t('public.events.enquire')}</h1>
        {p.tagline && <p style={{ opacity: 0.9, marginTop: 8 }}>{p.tagline}</p>}
      </div>

      <div style={{ maxWidth: 960, margin: '0 auto', padding: 20 }}>
        {p.description && <p style={{ color: '#6b5d52', textAlign: 'center', marginBottom: 24 }}>{p.description}</p>}

        {/* Venues */}
        {(data.venues || []).length > 0 && (
          <div style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}>{t('public.events.venues')}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
              {(data.venues || []).map((v: any) => (
                <div key={v.id} style={{ background: '#fff', border: '1px solid #e8dccf', borderRadius: 16, padding: 16 }}>
                  <div style={{ fontWeight: 700 }}>{v.name}</div>
                  <div style={{ fontSize: 12, color: '#6b5d52' }}>{v.category} · {v.ac_type === 'AC' ? t('events.venues.ac') : t('events.venues.nonAc')}</div>
                  <div style={{ fontSize: 12, color: '#6b5d52' }}>{t('public.events.capacity')}: {v.min_occupancy}–{v.max_occupancy}</div>
                  <div style={{ marginTop: 6, fontWeight: 700, color: '#cc5a16' }}>{money(v.daily_rate)}<span style={{ fontSize: 11, fontWeight: 400 }}> / day</span></div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Inquiry form */}
        <div style={{ background: '#fff', border: '1px solid #e8dccf', borderRadius: 20, padding: 24 }}>
          <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 16 }}>{t('public.events.enquire')}</h2>
          {done ? (
            <div style={{ textAlign: 'center', padding: 24, color: '#047857', fontWeight: 600 }}>{t('public.events.thankYou')}</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <input className={INPUT} placeholder={t('public.events.yourName')} value={form.customer_name} onChange={e => setForm({ ...form, customer_name: e.target.value })} />
              <input className={INPUT} placeholder={t('public.events.yourPhone')} value={form.customer_phone} onChange={e => setForm({ ...form, customer_phone: e.target.value })} />
              <input className={INPUT} placeholder={t('public.events.yourEmail')} value={form.customer_email} onChange={e => setForm({ ...form, customer_email: e.target.value })} />
              <select className={INPUT} value={form.event_type} onChange={e => setForm({ ...form, event_type: e.target.value })}>
                {['WEDDING', 'RECEPTION', 'CONFERENCE', 'BIRTHDAY', 'CORPORATE', 'OTHER'].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <select className={INPUT} value={form.venue_id} onChange={e => setForm({ ...form, venue_id: e.target.value })}>
                <option value="">{t('events.bookings.venue')} —</option>
                {(data.venues || []).map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <input type="date" className={INPUT} value={form.event_date} onChange={e => setForm({ ...form, event_date: e.target.value })} />
              <input type="number" className={INPUT} placeholder={t('public.events.guests')} value={form.guest_count} onChange={e => setForm({ ...form, guest_count: e.target.value })} />
              <textarea className={INPUT} style={{ gridColumn: '1 / -1' }} rows={3} placeholder={t('public.events.message')} value={form.special_requests} onChange={e => setForm({ ...form, special_requests: e.target.value })} />
              {error && <div style={{ gridColumn: '1 / -1', color: '#dc2626', fontSize: 13 }}>{error}</div>}
              <button className={BTN_PRIMARY} style={{ gridColumn: '1 / -1', justifyContent: 'center', padding: 12 }} disabled={busy} onClick={submit}>
                {busy ? t('public.events.submitting') : t('public.events.submit')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
