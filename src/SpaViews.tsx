// ════════════════════════════════════════════════════════════════════════
// Spa & Wellness — frontend views (gated by spa_enabled; mirrors hotel pages)
// Single import surface for App.tsx: <SpaModule tab={activeTab} .../> dispatches
// to the right view. Public booking page exported separately.
// ════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect } from 'react';
import { DataTable } from './components/DataTable';
import {
  Calendar, Clock, Plus, Trash2, Check, X, User, Package, Award,
  TrendingUp, RefreshCw, FileText, Scissors, DoorOpen,
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

const CARD = "bg-white rounded-2xl border border-[#e8dccf] p-5";
const BTN = "px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors";
const BTN_PRIMARY = `${BTN} bg-[#cc5a16] text-white hover:bg-[#b34f12]`;
const BTN_GHOST = `${BTN} bg-[#faf7f2] border border-[#e8dccf] text-[#3d3128] hover:bg-[#f0e9df]`;
const INPUT = "w-full px-3 py-2 rounded-xl border border-[#e8dccf] text-sm bg-white focus:outline-none focus:border-[#cc5a16]";
const LABEL = "text-xs font-semibold text-[#6b5d52] mb-1 block";
const money = (n: any) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const STATUS_COLOR: Record<string, string> = {
  BOOKED: 'bg-blue-50 text-blue-700 border-blue-200',
  CONFIRMED: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  CHECKED_IN: 'bg-amber-50 text-amber-700 border-amber-200',
  IN_PROGRESS: 'bg-amber-50 text-amber-700 border-amber-200',
  COMPLETED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  CANCELLED: 'bg-gray-100 text-gray-500 border-gray-200',
  NO_SHOW: 'bg-rose-50 text-rose-700 border-rose-200',
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
// CATALOG
// ════════════════════════════════════════════════════════════════════════
function SpaCatalog({ restaurantId, token }: Props) {
  const api = makeApi(restaurantId, token);
  const [services, setServices] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const blank = { name: '', category: 'MASSAGE', duration_min: '60', buffer_after_min: '10', price: '', gst_percent: '18', requires_room: true, requires_therapist: true, image_url: '', description: '' };
  const [form, setForm] = useState<any>(blank);

  const load = async () => { setLoading(true); try { setServices(await api('/spa/services')); } catch { /* */ } finally { setLoading(false); } };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!form.name) return;
    const body = { ...form, duration_min: Number(form.duration_min || 60), buffer_after_min: Number(form.buffer_after_min || 10), price: Number(form.price || 0), gst_percent: Number(form.gst_percent || 18) };
    try {
      if (edit) await api(`/spa/services/${edit.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await api('/spa/services', { method: 'POST', body: JSON.stringify(body) });
      setShowForm(false); setEdit(null); setForm(blank); await load();
    } catch (e: any) { alert(e.message); }
  };
  const remove = async (id: string) => { if (!window.confirm('Deactivate this service?')) return; try { await api(`/spa/services/${id}`, { method: 'DELETE' }); await load(); } catch (e: any) { alert(e.message); } };

  return (
    <div>
      <SectionHeader icon={<Scissors size={18} />} title="Service Menu" sub="Treatments, durations, pricing & tax"
        action={<button className={BTN_PRIMARY} onClick={() => { setEdit(null); setForm(blank); setShowForm(true); }}><Plus size={14} /> Add Service</button>} />
      <div className={CARD}>
        <DataTable
          data={services}
          loading={loading}
          rowKey={(r: any) => r.id}
          columns={[
            { key: 'name', label: 'Service', render: (r: any) => <span className="font-semibold">{r.name}</span> },
            { key: 'category', label: 'Category' },
            { key: 'duration_min', label: 'Duration', render: (r: any) => `${r.duration_min} min` },
            { key: 'price', label: 'Price', render: (r: any) => money(r.price) },
            { key: 'gst_percent', label: 'GST %', render: (r: any) => `${r.gst_percent}%` },
            { key: 'is_active', label: 'Status', render: (r: any) => r.is_active ? <span className="text-emerald-600 text-xs font-bold">Active</span> : <span className="text-gray-400 text-xs">Inactive</span> },
            { key: '_a', label: '', render: (r: any) => (
              <div className="flex gap-1.5">
                <button className={BTN_GHOST} onClick={() => { setEdit(r); setForm({ ...blank, ...r, duration_min: String(r.duration_min), buffer_after_min: String(r.buffer_after_min), price: String(r.price), gst_percent: String(r.gst_percent), requires_room: !!r.requires_room, requires_therapist: !!r.requires_therapist }); setShowForm(true); }}>Edit</button>
                <button className={`${BTN} bg-rose-50 text-rose-600 hover:bg-rose-100`} onClick={() => remove(r.id)}><Trash2 size={13} /></button>
              </div>
            ) },
          ]}
        />
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-bold font-serif mb-4">{edit ? 'Edit' : 'Add'} Service</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2"><label className={LABEL}>Name</label><input className={INPUT} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
              <div className="col-span-2"><label className={LABEL}>Description <span className="font-normal text-[#9d8b7e]">(shown on public page)</span></label><textarea className={INPUT} rows={2} value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Brief description guests will see when booking" /></div>
              <div><label className={LABEL}>Category</label>
                <select className={INPUT} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                  {['MASSAGE', 'FACIAL', 'BODY', 'SAUNA', 'SALON', 'WELLNESS'].map(c => <option key={c}>{c}</option>)}
                </select></div>
              <div><label className={LABEL}>Duration (min)</label><input className={INPUT} type="number" value={form.duration_min} onChange={e => setForm({ ...form, duration_min: e.target.value })} /></div>
              <div><label className={LABEL}>Buffer after (min)</label><input className={INPUT} type="number" value={form.buffer_after_min} onChange={e => setForm({ ...form, buffer_after_min: e.target.value })} /></div>
              <div><label className={LABEL}>Price (₹)</label><input className={INPUT} type="number" value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} /></div>
              <div><label className={LABEL}>GST %</label><input className={INPUT} type="number" value={form.gst_percent} onChange={e => setForm({ ...form, gst_percent: e.target.value })} /></div>
              <div className="col-span-2">
                <label className={LABEL}>Photo URL <span className="font-normal text-[#9d8b7e]">(shown on public booking page)</span></label>
                <input className={INPUT} value={form.image_url || ''} onChange={e => setForm({ ...form, image_url: e.target.value })} placeholder="https://example.com/swedish-massage.jpg" />
                {form.image_url && (
                  <img src={form.image_url} alt="preview" className="mt-2 h-24 w-full object-cover rounded-xl border border-[#e8dccf]" onError={e => (e.currentTarget.style.display = 'none')} />
                )}
              </div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.requires_room} onChange={e => setForm({ ...form, requires_room: e.target.checked })} /> Requires cabin</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.requires_therapist} onChange={e => setForm({ ...form, requires_therapist: e.target.checked })} /> Requires therapist</label>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button className={BTN_GHOST} onClick={() => setShowForm(false)}>Cancel</button>
              <button className={BTN_PRIMARY} onClick={save}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// RESOURCES (cabins + therapists + schedules + skills)
// ════════════════════════════════════════════════════════════════════════
function SpaResources({ restaurantId, token }: Props) {
  const api = makeApi(restaurantId, token);
  const [tab, setTab] = useState<'CABINS' | 'THERAPISTS'>('CABINS');
  const [resources, setResources] = useState<any[]>([]);
  const [therapists, setTherapists] = useState<any[]>([]);
  const [services, setServices] = useState<any[]>([]);
  const [newCabin, setNewCabin] = useState('');
  const [newTher, setNewTher] = useState('');
  const [schedTher, setSchedTher] = useState<any>(null);
  const [schedules, setSchedules] = useState<any[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [sched, setSched] = useState({ weekday: '1', start_time: '09:00', end_time: '18:00' });
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const load = async () => {
    try { setResources(await api('/spa/resources')); } catch { /* */ }
    try { setTherapists(await api('/spa/therapists')); } catch { /* */ }
    try { setServices(await api('/spa/services')); } catch { /* */ }
  };
  useEffect(() => { load(); }, []);

  const addCabin = async () => { if (!newCabin) return; try { await api('/spa/resources', { method: 'POST', body: JSON.stringify({ name: newCabin }) }); setNewCabin(''); await load(); } catch (e: any) { alert(e.message); } };
  const addTher = async () => { if (!newTher) return; try { await api('/spa/therapists', { method: 'POST', body: JSON.stringify({ display_name: newTher }) }); setNewTher(''); await load(); } catch (e: any) { alert(e.message); } };

  const openSched = async (t: any) => {
    setSchedTher(t);
    try { setSchedules(await api(`/spa/therapists/${t.id}/schedules`)); } catch { setSchedules([]); }
    try { const sk = await api(`/spa/therapists/${t.id}/services`); setSkills(sk.map((x: any) => x.service_id)); } catch { setSkills([]); }
  };
  const addSched = async () => {
    try { await api(`/spa/therapists/${schedTher.id}/schedules`, { method: 'POST', body: JSON.stringify({ weekday: Number(sched.weekday), start_time: sched.start_time, end_time: sched.end_time }) }); setSchedules(await api(`/spa/therapists/${schedTher.id}/schedules`)); } catch (e: any) { alert(e.message); }
  };
  const toggleSkill = async (sid: string) => {
    const next = skills.includes(sid) ? skills.filter(s => s !== sid) : [...skills, sid];
    setSkills(next);
    try { await api(`/spa/therapists/${schedTher.id}/services`, { method: 'POST', body: JSON.stringify({ service_ids: next }) }); } catch (e: any) { alert(e.message); }
  };

  return (
    <div>
      <SectionHeader icon={<DoorOpen size={18} />} title="Therapists & Cabins" sub="Resources the booking engine schedules against" />
      <div className="flex gap-2 mb-4">
        {(['CABINS', 'THERAPISTS'] as const).map(t => (
          <button key={t} className={tab === t ? BTN_PRIMARY : BTN_GHOST} onClick={() => setTab(t)}>{t === 'CABINS' ? 'Treatment Cabins' : 'Therapists'}</button>
        ))}
      </div>

      {tab === 'CABINS' ? (
        <div className={CARD}>
          <div className="flex gap-2 mb-4">
            <input className={INPUT} placeholder="New cabin name" value={newCabin} onChange={e => setNewCabin(e.target.value)} />
            <button className={BTN_PRIMARY} onClick={addCabin}><Plus size={14} /> Add</button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {resources.map(r => (
              <div key={r.id} className="rounded-xl border border-[#e8dccf] p-3 flex items-center justify-between">
                <span className="font-semibold text-sm">{r.name}</span>
                <span className="text-[10px] text-[#6b5d52]">{r.resource_type}</span>
              </div>
            ))}
            {!resources.length && <p className="text-sm text-[#6b5d52] col-span-3">No cabins yet.</p>}
          </div>
        </div>
      ) : (
        <div className={CARD}>
          <div className="flex gap-2 mb-4">
            <input className={INPUT} placeholder="New therapist name" value={newTher} onChange={e => setNewTher(e.target.value)} />
            <button className={BTN_PRIMARY} onClick={addTher}><Plus size={14} /> Add</button>
          </div>
          <div className="space-y-2">
            {therapists.map(t => (
              <div key={t.id} className="rounded-xl border border-[#e8dccf] p-3 flex items-center justify-between">
                <span className="font-semibold text-sm flex items-center gap-2"><User size={14} className="text-[#cc5a16]" /> {t.display_name}</span>
                <button className={BTN_GHOST} onClick={() => openSched(t)}><Clock size={13} /> Schedule & Skills</button>
              </div>
            ))}
            {!therapists.length && <p className="text-sm text-[#6b5d52]">No therapists yet.</p>}
          </div>
        </div>
      )}

      {schedTher && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setSchedTher(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-bold font-serif mb-1">{schedTher.display_name}</h3>
            <p className="text-xs text-[#6b5d52] mb-4">Weekly availability + services they can deliver</p>
            <h4 className="text-sm font-bold mb-2">Schedule</h4>
            <div className="flex gap-2 mb-2 items-end">
              <div><label className={LABEL}>Day</label><select className={INPUT} value={sched.weekday} onChange={e => setSched({ ...sched, weekday: e.target.value })}>{DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}</select></div>
              <div><label className={LABEL}>From</label><input className={INPUT} type="time" value={sched.start_time} onChange={e => setSched({ ...sched, start_time: e.target.value })} /></div>
              <div><label className={LABEL}>To</label><input className={INPUT} type="time" value={sched.end_time} onChange={e => setSched({ ...sched, end_time: e.target.value })} /></div>
              <button className={BTN_PRIMARY} onClick={addSched}><Plus size={14} /></button>
            </div>
            <div className="flex flex-wrap gap-1.5 mb-4">
              {schedules.map(s => <span key={s.id} className="px-2 py-1 rounded-lg bg-[#faf7f2] border border-[#e8dccf] text-[11px]">{DOW[s.weekday]} {s.start_time}–{s.end_time}</span>)}
            </div>
            <h4 className="text-sm font-bold mb-2">Services (skills)</h4>
            <div className="flex flex-wrap gap-1.5">
              {services.map(s => (
                <button key={s.id} onClick={() => toggleSkill(s.id)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border ${skills.includes(s.id) ? 'bg-[#cc5a16] text-white border-[#cc5a16]' : 'bg-white border-[#e8dccf] text-[#3d3128]'}`}>
                  {s.name}
                </button>
              ))}
            </div>
            <div className="flex justify-end mt-5"><button className={BTN_GHOST} onClick={() => setSchedTher(null)}>Done</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// APPOINTMENTS + CALENDAR + booking + checkout
// ════════════════════════════════════════════════════════════════════════
function SpaAppointments({ restaurantId, token, calendar }: Props & { calendar?: boolean }) {
  const api = makeApi(restaurantId, token);
  const [appts, setAppts] = useState<any[]>([]);
  const [services, setServices] = useState<any[]>([]);
  const [therapists, setTherapists] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [search, setSearch] = useState('');

  // booking modal
  const [showBook, setShowBook] = useState(false);
  const [bk, setBk] = useState<any>({ service_id: '', date: new Date().toISOString().slice(0, 10), client_name: '', client_phone: '' });
  const [slots, setSlots] = useState<any[]>([]);
  const [slotLoading, setSlotLoading] = useState(false);
  const [chosenSlot, setChosenSlot] = useState<any>(null);

  // checkout modal
  const [coAppt, setCoAppt] = useState<any>(null);
  const [coState, setCoState] = useState<any>({ use_package: false, apply_membership: false, tip_amount: '', payment_method: 'CASH' });
  const [coResult, setCoResult] = useState<any>(null);

  const load = async (q?: string) => {
    setLoading(true);
    try {
      const activeSearch = q !== undefined ? q : search;
      if (activeSearch.trim()) {
        setAppts(await api(`/spa/appointments?q=${encodeURIComponent(activeSearch.trim())}`));
      } else {
        const from = `${day} 00:00:00`, to = `${day} 23:59:59`;
        setAppts(await api(`/spa/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`));
      }
    } catch { /* */ } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [day]);
  useEffect(() => { (async () => { try { setServices(await api('/spa/services')); } catch {} try { setTherapists(await api('/spa/therapists')); } catch {} })(); }, []);

  const searchSlots = async () => {
    if (!bk.service_id || !bk.date) return;
    setSlotLoading(true); setChosenSlot(null);
    try { const r = await api(`/spa/availability?service_id=${bk.service_id}&date=${bk.date}`); setSlots(r.slots || []); }
    catch (e: any) { alert(e.message); setSlots([]); } finally { setSlotLoading(false); }
  };
  const book = async () => {
    if (!chosenSlot || !bk.client_name) { alert('Pick a slot and enter client name'); return; }
    try {
      await api('/spa/appointments', { method: 'POST', body: JSON.stringify({
        service_id: bk.service_id, start_at: chosenSlot.start_at, therapist_id: chosenSlot.therapist_id,
        resource_id: chosenSlot.resource_id, client_name: bk.client_name, client_phone: bk.client_phone,
      }) });
      setShowBook(false); setSlots([]); setChosenSlot(null); setBk({ service_id: '', date: day, client_name: '', client_phone: '' });
      await load();
    } catch (e: any) { alert(e.message); }
  };
  const transition = async (a: any, action: string) => {
    try {
      if (action === 'cancel') await api(`/spa/appointments/${a.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'Cancelled by staff' }) });
      else await api(`/spa/appointments/${a.id}/${action}`, { method: 'POST' });
      await load();
    } catch (e: any) { alert(e.message); }
  };
  const doCheckout = async () => {
    try {
      const r = await api(`/spa/appointments/${coAppt.id}/checkout`, { method: 'POST', body: JSON.stringify({
        use_package: coState.use_package, apply_membership: coState.apply_membership, tip_amount: Number(coState.tip_amount || 0),
      }) });
      // collect payment for outstanding
      if (r.folio && Number(r.outstanding) > 0) {
        await api(`/spa/folios/${r.folio.id}/payments`, { method: 'POST', body: JSON.stringify({ amount: r.outstanding, payment_method: coState.payment_method, payment_type: 'FINAL' }) });
      }
      setCoResult({ ...r, paid: true });
      await load();
    } catch (e: any) { alert(e.message); }
  };

  const fmtTime = (ts: string) => String(ts || '').slice(11, 16);

  return (
    <div>
      <SectionHeader icon={<Calendar size={18} />} title={calendar ? 'Appointment Calendar' : 'Appointments'} sub="Dual-resource scheduling — therapist + cabin"
        action={<div className="flex gap-2 flex-wrap">
          <input className={INPUT} placeholder="Search name / phone…" value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') load(search); if (e.key === 'Escape') { setSearch(''); load(''); } }}
            style={{ width: 180 }} />
          {!search.trim() && <input className={INPUT} type="date" value={day} onChange={e => setDay(e.target.value)} style={{ width: 'auto' }} />}
          <button className={BTN_GHOST} onClick={() => load(search)}><RefreshCw size={13} /></button>
          <button className={BTN_PRIMARY} onClick={() => { setBk({ service_id: services[0]?.id || '', date: day, client_name: '', client_phone: '' }); setShowBook(true); }}><Plus size={14} /> New Appointment</button>
        </div>} />

      {calendar ? (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.max(1, therapists.length)}, minmax(180px, 1fr))` }}>
          {therapists.map(t => (
            <div key={t.id} className={CARD}>
              <h4 className="font-bold text-sm mb-2 flex items-center gap-1.5"><User size={13} className="text-[#cc5a16]" /> {t.display_name}</h4>
              <div className="space-y-1.5">
                {appts.filter(a => a.therapist_id === t.id).sort((a, b) => a.start_at.localeCompare(b.start_at)).map(a => (
                  <div key={a.id} className="rounded-lg border border-[#e8dccf] p-2 text-xs">
                    <div className="font-semibold">{fmtTime(a.start_at)}–{fmtTime(a.end_at)}</div>
                    <div className="text-[#6b5d52]">{a.service_name} · {a.client_name}</div>
                    <Pill status={a.status} />
                  </div>
                ))}
                {!appts.filter(a => a.therapist_id === t.id).length && <p className="text-[11px] text-[#6b5d52]">No appointments.</p>}
              </div>
            </div>
          ))}
          {!therapists.length && <p className="text-sm text-[#6b5d52]">Add therapists first (Therapists & Cabins).</p>}
        </div>
      ) : (
        <div className={CARD}>
          <DataTable
            data={appts} loading={loading} rowKey={(r: any) => r.id}
            exportFilename="appointments"
            columns={[
              { key: 'time', label: 'Time', render: (r: any) => `${fmtTime(r.start_at)}–${fmtTime(r.end_at)}`, exportValue: (r: any) => `${fmtTime(r.start_at)}-${fmtTime(r.end_at)}` },
              { key: 'service_name', label: 'Service' },
              { key: 'client_name', label: 'Client' },
              { key: 'client_phone', label: 'Phone' },
              { key: 'therapist_name', label: 'Therapist' },
              { key: 'resource_name', label: 'Cabin' },
              { key: 'status', label: 'Status', render: (r: any) => <Pill status={r.status} /> },
              { key: '_a', label: 'Actions', noExport: true, render: (r: any) => (
                <div className="flex gap-1 flex-wrap">
                  {r.status === 'BOOKED' && <button className={BTN_GHOST} onClick={() => transition(r, 'confirm')}>Confirm</button>}
                  {['BOOKED', 'CONFIRMED'].includes(r.status) && <button className={BTN_GHOST} onClick={() => transition(r, 'check-in')}>Check-in</button>}
                  {['CHECKED_IN', 'IN_PROGRESS', 'CONFIRMED', 'BOOKED'].includes(r.status) && <button className={BTN_GHOST} onClick={() => transition(r, 'complete')}><Check size={12} /> Complete</button>}
                  {r.status === 'COMPLETED' && !r.folio_id && <button className={BTN_PRIMARY} onClick={() => { setCoAppt(r); setCoResult(null); setCoState({ use_package: false, apply_membership: false, tip_amount: '', payment_method: 'CASH' }); }}>Checkout</button>}
                  {r.folio_id && <a className={BTN_GHOST} href={`/api/restaurant/${restaurantId}/spa/folios/${r.folio_id}/invoice.pdf`} target="_blank" rel="noreferrer"><FileText size={12} /> Invoice</a>}
                  {!['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(r.status) && <button className={`${BTN} bg-rose-50 text-rose-600`} onClick={() => transition(r, 'cancel')}><X size={12} /></button>}
                </div>
              ) },
            ]}
          />
        </div>
      )}

      {/* Booking modal */}
      {showBook && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setShowBook(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[88vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-bold font-serif mb-4">New Appointment</h3>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div className="col-span-2"><label className={LABEL}>Service</label>
                <select className={INPUT} value={bk.service_id} onChange={e => { setBk({ ...bk, service_id: e.target.value }); setSlots([]); }}>
                  <option value="">Select…</option>
                  {services.map(s => <option key={s.id} value={s.id}>{s.name} · {s.duration_min}min · {money(s.price)}</option>)}
                </select></div>
              <div><label className={LABEL}>Date</label><input className={INPUT} type="date" value={bk.date} onChange={e => { setBk({ ...bk, date: e.target.value }); setSlots([]); }} /></div>
              <div className="flex items-end"><button className={BTN_PRIMARY} onClick={searchSlots} disabled={!bk.service_id}>{slotLoading ? 'Searching…' : 'Find Slots'}</button></div>
              <div><label className={LABEL}>Client Name</label><input className={INPUT} value={bk.client_name} onChange={e => setBk({ ...bk, client_name: e.target.value })} /></div>
              <div><label className={LABEL}>Client Phone</label><input className={INPUT} value={bk.client_phone} onChange={e => setBk({ ...bk, client_phone: e.target.value })} /></div>
            </div>
            {slots.length > 0 && (
              <div className="mb-3">
                <label className={LABEL}>Available slots (therapist + cabin)</label>
                <div className="grid grid-cols-3 gap-1.5 max-h-44 overflow-auto">
                  {slots.map((s, i) => (
                    <button key={i} onClick={() => setChosenSlot(s)}
                      className={`px-2 py-1.5 rounded-lg text-[11px] border ${chosenSlot === s ? 'bg-[#cc5a16] text-white border-[#cc5a16]' : 'bg-white border-[#e8dccf]'}`}>
                      {s.start_at.slice(11, 16)}<br /><span className="opacity-70">{s.therapist_name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {slots.length === 0 && !slotLoading && bk.service_id && <p className="text-xs text-[#6b5d52] mb-3">Click "Find Slots" to see availability.</p>}
            <div className="flex justify-end gap-2">
              <button className={BTN_GHOST} onClick={() => setShowBook(false)}>Cancel</button>
              <button className={BTN_PRIMARY} onClick={book} disabled={!chosenSlot}>Book Appointment</button>
            </div>
          </div>
        </div>
      )}

      {/* Checkout modal */}
      {coAppt && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setCoAppt(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-bold font-serif mb-1">Checkout</h3>
            <p className="text-xs text-[#6b5d52] mb-4">{coAppt.service_name} · {coAppt.client_name}</p>
            {!coResult ? (
              <>
                <div className="space-y-2.5 mb-4">
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={coState.use_package} onChange={e => setCoState({ ...coState, use_package: e.target.checked })} /> Redeem a prepaid package session</label>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={coState.apply_membership} onChange={e => setCoState({ ...coState, apply_membership: e.target.checked })} /> Apply membership discount</label>
                  <div><label className={LABEL}>Tip (₹)</label><input className={INPUT} type="number" value={coState.tip_amount} onChange={e => setCoState({ ...coState, tip_amount: e.target.value })} /></div>
                  <div><label className={LABEL}>Payment method</label>
                    <select className={INPUT} value={coState.payment_method} onChange={e => setCoState({ ...coState, payment_method: e.target.value })}>
                      {['CASH', 'CARD', 'UPI', 'BANK_TRANSFER'].map(m => <option key={m}>{m}</option>)}
                    </select></div>
                </div>
                <div className="flex justify-end gap-2">
                  <button className={BTN_GHOST} onClick={() => setCoAppt(null)}>Cancel</button>
                  <button className={BTN_PRIMARY} onClick={doCheckout}>Generate Invoice & Pay</button>
                </div>
              </>
            ) : (
              <div className="text-center py-4">
                <Check size={40} className="mx-auto text-emerald-500 mb-2" />
                <p className="font-bold">Invoice {coResult.invoice_number}</p>
                <p className="text-sm text-[#6b5d52] mb-1">Total {money(coResult.folio?.grand_total)}</p>
                <p className="text-xs text-emerald-600 mb-4">Paid in full</p>
                <a className={BTN_PRIMARY + ' inline-flex'} href={`/api/restaurant/${restaurantId}/spa/folios/${coResult.folio?.id}/invoice.pdf`} target="_blank" rel="noreferrer"><FileText size={13} /> Download Invoice</a>
                <div className="mt-3"><button className={BTN_GHOST + ' mx-auto'} onClick={() => setCoAppt(null)}>Close</button></div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// CLIENTS (CRM) — list + profile + package purchase + membership subscribe
// ════════════════════════════════════════════════════════════════════════
function SpaClients({ restaurantId, token }: Props) {
  const api = makeApi(restaurantId, token);
  const [clients, setClients] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '' });
  const [profile, setProfile] = useState<any>(null);
  const [packages, setPackages] = useState<any[]>([]);
  const [memberships, setMemberships] = useState<any[]>([]);

  const load = async () => { try { setClients(await api(`/spa/clients${search ? `?search=${encodeURIComponent(search)}` : ''}`)); } catch {} };
  useEffect(() => { load(); }, []);
  useEffect(() => { (async () => { try { setPackages(await api('/spa/packages')); } catch {} try { setMemberships(await api('/spa/memberships')); } catch {} })(); }, []);

  const addClient = async () => { if (!form.name) return; try { await api('/spa/clients', { method: 'POST', body: JSON.stringify(form) }); setShowForm(false); setForm({ name: '', phone: '', email: '' }); await load(); } catch (e: any) { alert(e.message); } };
  const openProfile = async (c: any) => { try { setProfile(await api(`/spa/clients/${c.id}`)); } catch (e: any) { alert(e.message); } };
  const buyPackage = async (pkgId: string) => { try { await api(`/spa/clients/${profile.client.id}/packages`, { method: 'POST', body: JSON.stringify({ package_id: pkgId, payment_method: 'CASH' }) }); await openProfile(profile.client); } catch (e: any) { alert(e.message); } };
  const subscribe = async (planId: string) => { try { await api(`/spa/clients/${profile.client.id}/memberships`, { method: 'POST', body: JSON.stringify({ plan_id: planId, payment_method: 'CASH' }) }); await openProfile(profile.client); } catch (e: any) { alert(e.message); } };

  return (
    <div>
      <SectionHeader icon={<User size={18} />} title="Clients" sub="Profiles, history, packages & memberships"
        action={<button className={BTN_PRIMARY} onClick={() => setShowForm(true)}><Plus size={14} /> Add Client</button>} />
      <div className={CARD}>
        <div className="flex gap-2 mb-4">
          <input className={INPUT} placeholder="Search by name / phone / email" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && load()} />
          <button className={BTN_GHOST} onClick={load}>Search</button>
        </div>
        <DataTable
          data={clients} rowKey={(r: any) => r.id}
          columns={[
            { key: 'name', label: 'Name', render: (r: any) => <span className="font-semibold">{r.name}</span> },
            { key: 'phone', label: 'Phone' },
            { key: 'email', label: 'Email' },
            { key: '_a', label: '', render: (r: any) => <button className={BTN_GHOST} onClick={() => openProfile(r)}>View</button> },
          ]}
        />
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-bold font-serif mb-4">Add Client</h3>
            <div className="space-y-3">
              <div><label className={LABEL}>Name</label><input className={INPUT} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
              <div><label className={LABEL}>Phone</label><input className={INPUT} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></div>
              <div><label className={LABEL}>Email</label><input className={INPUT} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></div>
            </div>
            <div className="flex justify-end gap-2 mt-5"><button className={BTN_GHOST} onClick={() => setShowForm(false)}>Cancel</button><button className={BTN_PRIMARY} onClick={addClient}>Save</button></div>
          </div>
        </div>
      )}

      {profile && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setProfile(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-2xl max-h-[88vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-bold font-serif">{profile.client.name}</h3>
            <p className="text-xs text-[#6b5d52] mb-4">{profile.client.phone} · {profile.client.email}</p>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <h4 className="text-sm font-bold mb-2">Visit History</h4>
                <div className="space-y-1.5 max-h-40 overflow-auto">
                  {profile.history.map((h: any) => <div key={h.id} className="text-xs rounded-lg border border-[#e8dccf] p-2">{h.start_at?.slice(0, 16)} · {h.service_name} <Pill status={h.status} /></div>)}
                  {!profile.history.length && <p className="text-xs text-[#6b5d52]">No visits yet.</p>}
                </div>
              </div>
              <div>
                <h4 className="text-sm font-bold mb-2">Packages</h4>
                <div className="space-y-1.5 mb-2">
                  {profile.packages.map((p: any) => <div key={p.id} className="text-xs rounded-lg border border-[#e8dccf] p-2">{p.package_name} — {p.sessions_remaining}/{p.sessions_total} left <span className="text-[10px]">({p.status})</span></div>)}
                  {!profile.packages.length && <p className="text-xs text-[#6b5d52]">None.</p>}
                </div>
                <select className={INPUT} onChange={e => e.target.value && buyPackage(e.target.value)} value="">
                  <option value="">+ Sell a package…</option>
                  {packages.map(p => <option key={p.id} value={p.id}>{p.name} — {money(p.price)}</option>)}
                </select>
                <h4 className="text-sm font-bold mb-2 mt-3">Memberships</h4>
                <div className="space-y-1.5 mb-2">
                  {profile.memberships.map((m: any) => <div key={m.id} className="text-xs rounded-lg border border-[#e8dccf] p-2">{m.plan_name} <span className="text-[10px]">({m.status})</span></div>)}
                  {!profile.memberships.length && <p className="text-xs text-[#6b5d52]">None.</p>}
                </div>
                <select className={INPUT} onChange={e => e.target.value && subscribe(e.target.value)} value="">
                  <option value="">+ Subscribe membership…</option>
                  {memberships.map(m => <option key={m.id} value={m.id}>{m.name} — {money(m.monthly_fee)}/mo</option>)}
                </select>
              </div>
            </div>
            <div className="flex justify-end mt-5"><button className={BTN_GHOST} onClick={() => setProfile(null)}>Close</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// PACKAGES & MEMBERSHIPS (templates management)
// ════════════════════════════════════════════════════════════════════════
function SpaPackages({ restaurantId, token }: Props) {
  const api = makeApi(restaurantId, token);
  const [packages, setPackages] = useState<any[]>([]);
  const [memberships, setMemberships] = useState<any[]>([]);
  const [pkgForm, setPkgForm] = useState({ name: '', total_sessions: '5', price: '', gst_percent: '18', validity_days: '180' });
  const [memForm, setMemForm] = useState({ name: '', monthly_fee: '', discount_pct: '10', gst_percent: '18' });

  const load = async () => { try { setPackages(await api('/spa/packages')); } catch {} try { setMemberships(await api('/spa/memberships')); } catch {} };
  useEffect(() => { load(); }, []);
  const addPkg = async () => { if (!pkgForm.name) return; try { await api('/spa/packages', { method: 'POST', body: JSON.stringify({ ...pkgForm, total_sessions: Number(pkgForm.total_sessions), price: Number(pkgForm.price || 0), gst_percent: Number(pkgForm.gst_percent), validity_days: Number(pkgForm.validity_days) }) }); setPkgForm({ name: '', total_sessions: '5', price: '', gst_percent: '18', validity_days: '180' }); await load(); } catch (e: any) { alert(e.message); } };
  const addMem = async () => { if (!memForm.name) return; try { await api('/spa/memberships', { method: 'POST', body: JSON.stringify({ name: memForm.name, monthly_fee: Number(memForm.monthly_fee || 0), gst_percent: Number(memForm.gst_percent), benefits: { discount_pct: Number(memForm.discount_pct || 0) } }) }); setMemForm({ name: '', monthly_fee: '', discount_pct: '10', gst_percent: '18' }); await load(); } catch (e: any) { alert(e.message); } };

  return (
    <div>
      <SectionHeader icon={<Award size={18} />} title="Packages & Memberships" sub="Prepaid series + recurring tiers" />
      <div className="grid sm:grid-cols-2 gap-4">
        <div className={CARD}>
          <h4 className="font-bold mb-3 flex items-center gap-1.5"><Package size={15} className="text-[#cc5a16]" /> Packages</h4>
          <div className="space-y-1.5 mb-4">
            {packages.map(p => <div key={p.id} className="text-sm rounded-lg border border-[#e8dccf] p-2 flex justify-between"><span>{p.name}</span><span className="text-[#6b5d52]">{p.total_sessions} × · {money(p.price)}</span></div>)}
            {!packages.length && <p className="text-xs text-[#6b5d52]">No packages yet.</p>}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input className={INPUT} placeholder="Name" value={pkgForm.name} onChange={e => setPkgForm({ ...pkgForm, name: e.target.value })} />
            <input className={INPUT} type="number" placeholder="Sessions" value={pkgForm.total_sessions} onChange={e => setPkgForm({ ...pkgForm, total_sessions: e.target.value })} />
            <input className={INPUT} type="number" placeholder="Price ₹" value={pkgForm.price} onChange={e => setPkgForm({ ...pkgForm, price: e.target.value })} />
            <input className={INPUT} type="number" placeholder="Validity days" value={pkgForm.validity_days} onChange={e => setPkgForm({ ...pkgForm, validity_days: e.target.value })} />
          </div>
          <button className={BTN_PRIMARY + ' mt-2'} onClick={addPkg}><Plus size={14} /> Add Package</button>
        </div>
        <div className={CARD}>
          <h4 className="font-bold mb-3 flex items-center gap-1.5"><Award size={15} className="text-[#cc5a16]" /> Memberships</h4>
          <div className="space-y-1.5 mb-4">
            {memberships.map(m => <div key={m.id} className="text-sm rounded-lg border border-[#e8dccf] p-2 flex justify-between"><span>{m.name}</span><span className="text-[#6b5d52]">{money(m.monthly_fee)}/mo</span></div>)}
            {!memberships.length && <p className="text-xs text-[#6b5d52]">No memberships yet.</p>}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input className={INPUT} placeholder="Name" value={memForm.name} onChange={e => setMemForm({ ...memForm, name: e.target.value })} />
            <input className={INPUT} type="number" placeholder="Monthly fee ₹" value={memForm.monthly_fee} onChange={e => setMemForm({ ...memForm, monthly_fee: e.target.value })} />
            <input className={INPUT} type="number" placeholder="Discount %" value={memForm.discount_pct} onChange={e => setMemForm({ ...memForm, discount_pct: e.target.value })} />
          </div>
          <button className={BTN_PRIMARY + ' mt-2'} onClick={addMem}><Plus size={14} /> Add Membership</button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// REPORTS
// ════════════════════════════════════════════════════════════════════════
function SpaReports({ restaurantId, token }: Props) {
  const api = makeApi(restaurantId, token);
  const [util, setUtil] = useState<any[]>([]);
  const [rev, setRev] = useState<any[]>([]);
  const [prod, setProd] = useState<any[]>([]);
  const [rebook, setRebook] = useState<any>(null);
  useEffect(() => { (async () => {
    try { setUtil(await api('/spa/reports/utilization')); } catch {}
    try { setRev(await api('/spa/reports/revenue-per-treatment')); } catch {}
    try { setProd(await api('/spa/reports/therapist-productivity')); } catch {}
    try { setRebook(await api('/spa/reports/rebooking-rate')); } catch {}
  })(); }, []);
  return (
    <div>
      <SectionHeader icon={<TrendingUp size={18} />} title="Spa Reports" sub="Last 30 days" />
      <div className="grid sm:grid-cols-2 gap-4">
        <div className={CARD}>
          <h4 className="font-bold mb-3">Therapist Utilisation</h4>
          <DataTable data={util} rowKey={(r: any) => r.therapist_id} columns={[
            { key: 'display_name', label: 'Therapist' },
            { key: 'appointments', label: 'Appts' },
            { key: 'booked_minutes', label: 'Booked min' },
          ]} />
        </div>
        <div className={CARD}>
          <h4 className="font-bold mb-3">Revenue per Treatment</h4>
          <DataTable data={rev} rowKey={(r: any) => r.service_id || r.service_name} columns={[
            { key: 'service_name', label: 'Service' },
            { key: 'times_sold', label: 'Sold' },
            { key: 'revenue', label: 'Revenue', render: (r: any) => money(r.revenue) },
          ]} />
        </div>
        <div className={CARD}>
          <h4 className="font-bold mb-3">Therapist Productivity</h4>
          <DataTable data={prod} rowKey={(r: any) => r.therapist_id} columns={[
            { key: 'display_name', label: 'Therapist' },
            { key: 'completed', label: 'Completed' },
            { key: 'no_shows', label: 'No-shows' },
            { key: 'service_value', label: 'Value', render: (r: any) => money(r.service_value) },
          ]} />
        </div>
        <div className={CARD}>
          <h4 className="font-bold mb-3">Rebooking Rate</h4>
          {rebook ? (
            <div className="text-center py-4">
              <div className="text-4xl font-bold text-[#cc5a16]">{rebook.rebooking_pct}%</div>
              <p className="text-xs text-[#6b5d52] mt-1">{rebook.returning_clients} of {rebook.clients} clients returned</p>
            </div>
          ) : <p className="text-xs text-[#6b5d52]">No data.</p>}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// SPA INVENTORY (read-only view of SPA_PRODUCT / SPA_RETAIL ingredients)
// ════════════════════════════════════════════════════════════════════════
function SpaInventory({ restaurantId, token }: Props) {
  const api = makeApi(restaurantId, token);
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => { (async () => { try { setItems(await api('/spa/inventory')); } catch {} })(); }, []);
  return (
    <div>
      <SectionHeader icon={<Package size={18} />} title="Spa Inventory" sub="Back-bar consumables & retail — purchased via Procurement & AP" />
      <div className={CARD}>
        <DataTable data={items} rowKey={(r: any) => r.id} columns={[
          { key: 'name', label: 'Item', render: (r: any) => <span className="font-semibold">{r.name}</span> },
          { key: 'item_type', label: 'Type', render: (r: any) => <span className="text-[11px]">{r.item_type === 'SPA_RETAIL' ? 'Retail' : 'Back-bar'}</span> },
          { key: 'current_stock_qty', label: 'In stock', render: (r: any) => `${r.current_stock_qty} ${r.unit}` },
          { key: 'reorder_point', label: 'Reorder at' },
          { key: 'default_unit_price', label: 'Unit ₹', render: (r: any) => money(r.default_unit_price) },
        ]} />
        <p className="text-xs text-[#6b5d52] mt-3">Spa products flow through the shared Supply Chain — raise a PO under <b>Procurement &amp; AP</b> to restock.</p>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// SPA SETTINGS — public page hero, tagline, offers bulletin
// ════════════════════════════════════════════════════════════════════════
function SpaSettings({ restaurantId, token }: Props) {
  const api = makeApi(restaurantId, token);
  const [profile, setProfile] = useState<any>({ hero_image_url: '', tagline: '', offers: [] });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const blankOffer = { badge: '', title: '', description: '', valid_until: '' };

  useEffect(() => { (async () => {
    try { const p = await api('/spa/profile'); setProfile({ ...p, offers: Array.isArray(p.offers) ? p.offers : [] }); }
    catch { /* */ }
  })(); }, []);

  const save = async () => {
    setSaving(true); setSaved(false);
    try { await api('/spa/profile', { method: 'PUT', body: JSON.stringify(profile) }); setSaved(true); setTimeout(() => setSaved(false), 2500); }
    catch (e: any) { alert(e.message); } finally { setSaving(false); }
  };

  const addOffer = () => setProfile((p: any) => ({ ...p, offers: [...(p.offers || []), { ...blankOffer }] }));
  const updateOffer = (i: number, field: string, val: string) => setProfile((p: any) => {
    const offers = [...(p.offers || [])];
    offers[i] = { ...offers[i], [field]: val };
    return { ...p, offers };
  });
  const removeOffer = (i: number) => setProfile((p: any) => ({ ...p, offers: (p.offers || []).filter((_: any, idx: number) => idx !== i) }));

  const slug = profile.booking_slug || restaurantId;
  const publicUrl = `${window.location.origin}/spa/${slug}`;
  const qrImgUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(publicUrl)}&format=png`;

  return (
    <div className="space-y-6">
      <SectionHeader icon={<Calendar size={18} />} title="Public Page Settings" sub="What guests see at your online booking page" />

      {/* public link */}
      <div className={CARD}>
        <p className="text-xs font-semibold text-[#6b5d52] mb-1">Your public booking link</p>
        <div className="flex items-center gap-2">
          <a href={publicUrl} target="_blank" rel="noreferrer" className="flex-1 text-sm text-[#cc5a16] underline break-all">{publicUrl}</a>
          <button className={BTN_GHOST} onClick={() => navigator.clipboard.writeText(publicUrl)}>Copy</button>
        </div>
      </div>

      {/* QR code */}
      <div className={CARD}>
        <p className="text-xs font-semibold text-[#6b5d52] mb-3">QR Code</p>
        <div className="flex items-start gap-4">
          <img src={qrImgUrl} alt="Booking QR Code" className="w-32 h-32 rounded-xl border border-[#e8dccf] flex-shrink-0" />
          <div className="flex-1 space-y-2">
            <p className="text-xs text-[#9d8b7e]">Guests scan this with any mobile camera to open your online booking page. Print it on menus, tent cards, reception desk, or social media.</p>
            <a href={qrImgUrl} download="spa-booking-qr.png" className={BTN_GHOST} style={{ display: 'inline-flex' }}>Download QR</a>
          </div>
        </div>
      </div>

      {/* hero + tagline */}
      <div className={CARD}>
        <p className="text-sm font-bold text-[#14110c] mb-3">Hero Banner</p>
        <div className="space-y-3">
          <div>
            <label className={LABEL}>Background Photo URL</label>
            <input className={INPUT} value={profile.hero_image_url || ''} onChange={e => setProfile((p: any) => ({ ...p, hero_image_url: e.target.value }))}
              placeholder="https://example.com/spa-hero.jpg — paste any image URL" />
            <p className="text-[11px] text-[#9d8b7e] mt-1">Use a high-quality landscape photo (1920×600px works well). Free options: Unsplash, Pexels.</p>
            {profile.hero_image_url && (
              <img src={profile.hero_image_url} alt="Hero preview" className="mt-2 w-full h-32 object-cover rounded-xl border border-[#e8dccf]"
                onError={e => (e.currentTarget.style.display = 'none')} onLoad={e => (e.currentTarget.style.display = '')} />
            )}
          </div>
          <div>
            <label className={LABEL}>Tagline <span className="font-normal text-[#9d8b7e]">(short phrase below spa name)</span></label>
            <input className={INPUT} value={profile.tagline || ''} onChange={e => setProfile((p: any) => ({ ...p, tagline: e.target.value }))}
              placeholder="e.g. Unwind. Restore. Glow." maxLength={80} />
          </div>
        </div>
      </div>

      {/* offers */}
      <div className={CARD}>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-bold text-[#14110c]">Offers & Promotions</p>
          <button className={BTN_GHOST} onClick={addOffer}><Plus size={13} /> Add Offer</button>
        </div>
        {(profile.offers || []).length === 0 && (
          <p className="text-xs text-[#9d8b7e] py-3 text-center">No offers yet. Add one to show a promotional banner on the public page.</p>
        )}
        <div className="space-y-4">
          {(profile.offers || []).map((o: any, i: number) => (
            <div key={i} className="rounded-xl border border-[#e8dccf] p-4 relative">
              <button className="absolute top-3 right-3 text-rose-400 hover:text-rose-600" onClick={() => removeOffer(i)}><X size={14} /></button>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={LABEL}>Badge <span className="font-normal text-[#9d8b7e]">(e.g. SALE, NEW)</span></label>
                  <input className={INPUT} value={o.badge || ''} onChange={e => updateOffer(i, 'badge', e.target.value)} placeholder="SALE" maxLength={12} />
                </div>
                <div>
                  <label className={LABEL}>Valid Until <span className="font-normal text-[#9d8b7e]">(optional)</span></label>
                  <input className={INPUT} type="date" value={o.valid_until || ''} onChange={e => updateOffer(i, 'valid_until', e.target.value)} />
                </div>
                <div className="col-span-2">
                  <label className={LABEL}>Offer Title *</label>
                  <input className={INPUT} value={o.title || ''} onChange={e => updateOffer(i, 'title', e.target.value)} placeholder="e.g. 20% off all massages this weekend" />
                </div>
                <div className="col-span-2">
                  <label className={LABEL}>Description <span className="font-normal text-[#9d8b7e]">(optional)</span></label>
                  <input className={INPUT} value={o.description || ''} onChange={e => updateOffer(i, 'description', e.target.value)} placeholder="Use code RELAX20 at booking — valid Sat & Sun" />
                </div>
              </div>
              {/* mini preview */}
              {o.title && (
                <div className="mt-3 rounded-xl px-3 py-2 text-white text-xs" style={{ background: 'linear-gradient(135deg, #cc5a16, #8b3a0f)' }}>
                  {o.badge && <span className="bg-white text-[#cc5a16] rounded-full px-1.5 py-0.5 text-[9px] font-bold mr-1">{o.badge}</span>}
                  <span className="font-semibold">{o.title}</span>
                  {o.description && <span className="opacity-70 ml-1">— {o.description}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button className={BTN_PRIMARY} onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
        {saved && <span className="text-xs text-emerald-600 font-semibold flex items-center gap-1"><Check size={13} /> Saved</span>}
        <a href={publicUrl} target="_blank" rel="noreferrer" className={BTN_GHOST}>Preview Public Page</a>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Dispatcher
// ════════════════════════════════════════════════════════════════════════
export function SpaModule({ restaurantId, token, tab }: Props & { tab: string }) {
  switch (tab) {
    case 'SPA_CALENDAR': return <SpaAppointments restaurantId={restaurantId} token={token} calendar />;
    case 'SPA_APPOINTMENTS': return <SpaAppointments restaurantId={restaurantId} token={token} />;
    case 'SPA_CATALOG': return <SpaCatalog restaurantId={restaurantId} token={token} />;
    case 'SPA_RESOURCES': return <SpaResources restaurantId={restaurantId} token={token} />;
    case 'SPA_CLIENTS': return <SpaClients restaurantId={restaurantId} token={token} />;
    case 'SPA_PACKAGES': return <SpaPackages restaurantId={restaurantId} token={token} />;
    case 'SPA_REPORTS': return <SpaReports restaurantId={restaurantId} token={token} />;
    case 'SPA_INVENTORY': return <SpaInventory restaurantId={restaurantId} token={token} />;
    case 'SPA_SETTINGS': return <SpaSettings restaurantId={restaurantId} token={token} />;
    default: return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// PUBLIC booking page (unauthenticated) — /spa/:slug resolves restaurantId first
// ════════════════════════════════════════════════════════════════════════

const CATEGORY_ICON: Record<string, string> = {
  MASSAGE: '💆', FACIAL: '✨', BODY: '🌿', SAUNA: '🔥', SALON: '💅', WELLNESS: '🧘', DEFAULT: '🌸',
};
const CATEGORY_COLOR: Record<string, string> = {
  MASSAGE: '#b45309', FACIAL: '#7c3aed', BODY: '#047857', SAUNA: '#dc2626', SALON: '#db2777', WELLNESS: '#0284c7', DEFAULT: '#cc5a16',
};

// Repeating mandala/lotus SVG pattern — overlaid on hero at 8% opacity
function SpaHeroPattern() {
  return (
    <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.08, pointerEvents: 'none' }}
      viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
      <defs>
        <pattern id="spa-mp" x="0" y="0" width="120" height="120" patternUnits="userSpaceOnUse">
          <g transform="translate(60,60)">
            <ellipse rx="7" ry="24" fill="none" stroke="#c9a96e" strokeWidth="0.7" />
            <ellipse rx="7" ry="24" fill="none" stroke="#c9a96e" strokeWidth="0.7" transform="rotate(45)" />
            <ellipse rx="7" ry="24" fill="none" stroke="#c9a96e" strokeWidth="0.7" transform="rotate(90)" />
            <ellipse rx="7" ry="24" fill="none" stroke="#c9a96e" strokeWidth="0.7" transform="rotate(135)" />
            <ellipse rx="7" ry="24" fill="none" stroke="#c9a96e" strokeWidth="0.7" transform="rotate(180)" />
            <ellipse rx="7" ry="24" fill="none" stroke="#c9a96e" strokeWidth="0.7" transform="rotate(225)" />
            <ellipse rx="7" ry="24" fill="none" stroke="#c9a96e" strokeWidth="0.7" transform="rotate(270)" />
            <ellipse rx="7" ry="24" fill="none" stroke="#c9a96e" strokeWidth="0.7" transform="rotate(315)" />
            <circle r="6" fill="none" stroke="#c9a96e" strokeWidth="0.7" />
            <circle r="2" fill="#c9a96e" opacity="0.6" />
            <circle cx="42" cy="0" r="2" fill="#c9a96e" opacity="0.5" />
            <circle cx="-42" cy="0" r="2" fill="#c9a96e" opacity="0.5" />
            <circle cx="0" cy="42" r="2" fill="#c9a96e" opacity="0.5" />
            <circle cx="0" cy="-42" r="2" fill="#c9a96e" opacity="0.5" />
            <circle cx="30" cy="30" r="1.2" fill="#c9a96e" opacity="0.35" />
            <circle cx="-30" cy="30" r="1.2" fill="#c9a96e" opacity="0.35" />
            <circle cx="30" cy="-30" r="1.2" fill="#c9a96e" opacity="0.35" />
            <circle cx="-30" cy="-30" r="1.2" fill="#c9a96e" opacity="0.35" />
          </g>
        </pattern>
      </defs>
      <rect width="400" height="300" fill="url(#spa-mp)" />
    </svg>
  );
}

export function SpaBookingPage({ tenantId }: { tenantId: string }) {
  const [data, setData] = useState<any>(null);
  const [restaurantId, setRestaurantId] = useState<string>(tenantId);
  const [step, setStep] = useState(1);
  const [service, setService] = useState<any>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [slots, setSlots] = useState<any[]>([]);
  const [slot, setSlot] = useState<any>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [guest, setGuest] = useState({ client_name: '', client_phone: '', client_email: '' });
  const [done, setDone] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [failedImages, setFailedImages] = useState<Set<number>>(new Set());

  // Resolve slug → real tenant id
  useEffect(() => { (async () => {
    try {
      let id = tenantId;
      let r = await fetch(`/api/public/restaurant/${encodeURIComponent(id)}/spa`);
      if (r.status === 404) {
        const r2 = await fetch(`/api/public/restaurant/by-slug/${encodeURIComponent(tenantId)}`);
        if (r2.ok) { const j = await r2.json(); const resolved = j.tenantId || j.id; if (resolved) { id = resolved; r = await fetch(`/api/public/restaurant/${encodeURIComponent(id)}/spa`); } }
      }
      if (r.ok) { setRestaurantId(id); setData(await r.json()); } else setData({ error: true });
    } catch { setData({ error: true }); }
  })(); }, [tenantId]);

  // Auto-load slots when service+date are ready in step 2
  useEffect(() => {
    if (step !== 2 || !service || !date) return;
    setSlotsLoading(true); setSlot(null); setSlots([]);
    fetch(`/api/public/restaurant/${restaurantId}/spa/availability?service_id=${service.id}&date=${date}`)
      .then(r => r.json()).then(b => setSlots(b.slots || [])).catch(() => setSlots([])).finally(() => setSlotsLoading(false));
  }, [step, service, date, restaurantId]);

  const submit = async () => {
    if (!slot || !guest.client_name || !guest.client_phone) return;
    setBusy(true); setError('');
    try {
      const r = await fetch(`/api/public/restaurant/${restaurantId}/spa/booking`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service_id: service.id, start_at: slot.start_at, therapist_id: slot.therapist_id, resource_id: slot.resource_id, ...guest }),
      });
      const b = await r.json();
      if (!r.ok) { setError(b.error || 'Booking failed. Please try again.'); return; }
      setDone(b);
    } catch { setError('Network error. Please check your connection.'); } finally { setBusy(false); }
  };

  // ── Palette & helpers ─────────────────────────────────────────────────────
  const SPA_DARK  = '#0d1f18';
  const SPA_GOLD  = '#c9a96e';
  const SPA_CREAM = '#f9f5ef';
  const SPA_BRAND = '#cc5a16';
  const SERIF: React.CSSProperties = { fontFamily: "'Playfair Display', Georgia, serif" };
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtTime = (iso: string) => iso.slice(11, 16);
  const today = new Date().toISOString().slice(0, 10);
  const addDays = (iso: string, n: number) => { const d = new Date(iso); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

  // ── Loading ──────────────────────────────────────────────────────────────
  if (!data) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0d1f18' }}>
      <div style={{ textAlign: 'center', color: '#fff' }}>
        <div style={{ width: 48, height: 48, borderRadius: '50%', border: '2px solid rgba(201,169,110,0.2)', borderTop: '2px solid #c9a96e', animation: 'spin 1.2s linear infinite', margin: '0 auto 16px' }} />
        <p style={{ fontSize: 11, letterSpacing: 3, textTransform: 'uppercase', opacity: 0.5 }}>Preparing your experience</p>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    </div>
  );
  if (data.error) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0d1f18', padding: '0 24px' }}>
      <div style={{ textAlign: 'center', color: '#fff', maxWidth: 320 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🌿</div>
        <h2 style={{ ...SERIF, fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Not Available</h2>
        <p style={{ fontSize: 13, opacity: 0.55, lineHeight: 1.6 }}>Online booking is not available at this time. Please contact the spa directly.</p>
      </div>
    </div>
  );

  const cur = data.property?.currency_symbol || '₹';
  const profile = data.profile || {};
  const offers: any[] = Array.isArray(profile.offers) ? profile.offers : [];
  const allCats: string[] = Array.from(new Set<string>((data.services || []).map((s: any): string => String(s.category))));
  const categories: string[] = ['ALL', ...allCats];
  const filteredServices = categoryFilter === 'ALL' ? (data.services || []) : (data.services || []).filter((s: any) => s.category === categoryFilter);

  const heroStyle: React.CSSProperties = profile.hero_image_url
    ? { backgroundImage: `linear-gradient(to bottom, rgba(13,31,24,0.5) 0%, rgba(13,31,24,0.88) 100%), url(${profile.hero_image_url})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { background: `linear-gradient(145deg, ${SPA_DARK} 0%, #1a3828 50%, #0d2318 100%)` };

  const resetFlow = () => { setDone(null); setStep(1); setService(null); setSlot(null); setSlots([]); setGuest({ client_name: '', client_phone: '', client_email: '' }); setError(''); };

  // ── Confirmation screen ──────────────────────────────────────────────────
  if (done) return (
    <div style={{ minHeight: '100vh', background: SPA_CREAM, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ ...heroStyle, paddingTop: 56, paddingBottom: 72, textAlign: 'center', color: '#fff' }}>
        <div style={{ position: 'relative', height: 4, background: `linear-gradient(90deg, transparent, ${SPA_GOLD}, transparent)`, marginBottom: 0 }} />
        {data.property?.logo_url && <img src={data.property.logo_url} alt="" style={{ height: 48, margin: '0 auto 14px', borderRadius: 12, objectFit: 'contain', filter: 'brightness(0) invert(1)', opacity: 0.9 }} />}
        <h1 style={{ ...SERIF, fontSize: 26, fontWeight: 700, letterSpacing: -0.3 }}>{data.property?.name}</h1>
        <p style={{ color: SPA_GOLD, fontSize: 10, letterSpacing: 3, textTransform: 'uppercase', marginTop: 8, fontWeight: 600 }}>Spa & Wellness</p>
      </div>
      <div style={{ maxWidth: 440, margin: '-52px auto 0', padding: '0 16px 48px' }}>
        <div style={{ background: '#fff', borderRadius: 28, boxShadow: '0 20px 60px rgba(0,0,0,0.15)', overflow: 'hidden' }}>
          <div style={{ height: 4, background: `linear-gradient(90deg, ${SPA_GOLD}, #e8c07a, ${SPA_GOLD})` }} />
          <div style={{ padding: '32px 28px', textAlign: 'center' }}>
            <div style={{ width: 72, height: 72, borderRadius: '50%', background: '#f0faf5', border: '3px solid #d1f0e0', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
              <Check size={32} style={{ color: '#22a05a' }} />
            </div>
            <h2 style={{ ...SERIF, fontSize: 24, fontWeight: 700, color: '#0d1a14', marginBottom: 6 }}>Booking Confirmed!</h2>
            <p style={{ color: '#6b5d52', fontSize: 13 }}>Your appointment has been received.</p>
            <div style={{ marginTop: 24, borderRadius: 18, padding: 20, textAlign: 'left', background: '#f9f5ef', border: '1px solid #ede5d8' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div>
                  <p style={{ fontWeight: 600, fontSize: 14, color: '#0d1a14' }}>{service?.name}</p>
                  <p style={{ fontSize: 12, color: '#9d8b7e', marginTop: 2 }}>{service?.duration_min} min · {service?.category}</p>
                </div>
                <p style={{ fontWeight: 700, fontSize: 14, color: SPA_BRAND }}>{cur}{Number(service?.price).toLocaleString('en-IN')}</p>
              </div>
              <div style={{ height: 1, background: '#ede5d8', marginBottom: 12 }} />
              <p style={{ fontSize: 11, fontWeight: 700, color: '#9d8b7e', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 }}>Date & Time</p>
              <p style={{ fontSize: 13, fontWeight: 600, color: '#0d1a14' }}>{fmtDate(done.start_at?.slice(0, 10) || today)} · {done.start_at ? fmtTime(done.start_at) : ''}</p>
              <div style={{ height: 1, background: '#ede5d8', margin: '12px 0' }} />
              <p style={{ fontSize: 11, fontWeight: 700, color: '#9d8b7e', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 }}>Guest</p>
              <p style={{ fontSize: 13, fontWeight: 600, color: '#0d1a14' }}>{guest.client_name}</p>
              <p style={{ fontSize: 12, color: '#9d8b7e' }}>{guest.client_phone}</p>
            </div>
            <p style={{ fontSize: 11, color: '#9d8b7e', marginTop: 16, lineHeight: 1.6 }}>Our team will call to confirm your appointment. Please arrive 10 minutes early.</p>
            {data.property?.phone && (
              <a href={`tel:${data.property.phone}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 16, padding: '12px 20px', borderRadius: 18, background: '#f0faf5', color: '#1a7a45', border: '1px solid #d1f0e0', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
                📞 Call {data.property.name}
              </a>
            )}
            <button onClick={resetFlow} style={{ marginTop: 12, fontSize: 12, color: SPA_BRAND, textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', width: '100%', padding: '8px 0' }}>
              Book another treatment
            </button>
          </div>
        </div>
        <p style={{ textAlign: 'center', fontSize: 10, opacity: 0.3, marginTop: 20, color: '#5a4535' }}>Powered by Atithi-Setu</p>
      </div>
    </div>
  );

  // ── Step progress bar ────────────────────────────────────────────────────
  const StepBar = () => (
    <div style={{ display: 'flex', alignItems: 'center', padding: '14px 20px', background: '#fff', borderBottom: '1px solid #f0e9df' }}>
      {['Treatment', 'Date & Time', 'Your Details'].map((label, i) => {
        const n = i + 1; const active = step === n; const past = step > n;
        return (
          <React.Fragment key={n}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, background: past ? '#22a05a' : active ? SPA_DARK : '#f0e9df', color: past || active ? '#fff' : '#9d8b7e', transition: 'all 0.2s' }}>
                {past ? <Check size={13} /> : n}
              </div>
              <span style={{ marginTop: 4, fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: active ? SPA_DARK : '#b0a090' }}>{label}</span>
            </div>
            {i < 2 && <div style={{ flex: 1, height: 1, margin: '0 8px 14px', background: step > n ? '#22a05a' : '#e8dccf', transition: 'background 0.2s' }} />}
          </React.Fragment>
        );
      })}
    </div>
  );

  // ── Main layout ──────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100vh', background: SPA_CREAM, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Inter:wght@300;400;500;600&display=swap');`}</style>

      {/* ── Hero ── */}
      <div style={{ ...heroStyle, position: 'relative', minHeight: step === 1 ? 360 : 120, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', paddingBottom: 36, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, transparent, ${SPA_GOLD}, transparent)` }} />
        <SpaHeroPattern />
        <div style={{ position: 'relative', zIndex: 1, textAlign: 'center', color: '#fff', padding: '0 20px' }}>
          {step === 1 && data.property?.logo_url && (
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16, marginTop: 56 }}>
              <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'rgba(255,255,255,0.12)', border: '1.5px solid rgba(201,169,110,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backdropFilter: 'blur(4px)' }}>
                <img src={data.property.logo_url} alt="" style={{ width: 56, height: 56, objectFit: 'contain' }} />
              </div>
            </div>
          )}
          {step === 1 ? (
            <>
              <h1 style={{ ...SERIF, fontSize: 36, fontWeight: 700, letterSpacing: -0.5, textShadow: '0 2px 20px rgba(0,0,0,0.65)', marginTop: data.property?.logo_url ? 0 : 56, lineHeight: 1.12, margin: data.property?.logo_url ? '0' : '56px 0 0' }}>{data.property?.name}</h1>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 14 }}>
                <div style={{ height: 1, width: 48, background: 'rgba(201,169,110,0.55)' }} />
                <span style={{ color: SPA_GOLD, fontSize: 13, lineHeight: 1 }}>✦</span>
                <p style={{ color: SPA_GOLD, fontSize: 10, letterSpacing: 4.5, textTransform: 'uppercase', fontWeight: 700, margin: 0 }}>{profile.tagline || 'Spa & Wellness'}</p>
                <span style={{ color: SPA_GOLD, fontSize: 13, lineHeight: 1 }}>✦</span>
                <div style={{ height: 1, width: 48, background: 'rgba(201,169,110,0.55)' }} />
              </div>
              {data.property?.city && <p style={{ fontSize: 11, opacity: 0.38, marginTop: 10, letterSpacing: 2, textTransform: 'uppercase' }}>{data.property.city}{data.property.state ? ` · ${data.property.state}` : ''}</p>}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 20, flexWrap: 'wrap' }}>
                {(profile.features?.length ? profile.features : ['Expert Therapists', 'Premium Products', 'Private Cabins']).slice(0, 3).map((f: string) => (
                  <span key={f} style={{ fontSize: 10, padding: '5px 16px', borderRadius: 20, border: '1px solid rgba(201,169,110,0.3)', color: 'rgba(255,255,255,0.72)', letterSpacing: 0.5, background: 'rgba(0,0,0,0.2)' }}>{f}</span>
                ))}
              </div>
              {(data.services?.length || 0) > 0 && (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 18, padding: '6px 18px', borderRadius: 24, background: 'rgba(201,169,110,0.1)', border: '1px solid rgba(201,169,110,0.22)' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80', display: 'inline-block', flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.72)', letterSpacing: 0.4 }}>{data.services.length} treatment{data.services.length !== 1 ? 's' : ''} · Online booking open</span>
                </div>
              )}
            </>
          ) : (
            <p style={{ fontSize: 10, opacity: 0.42, letterSpacing: 3, textTransform: 'uppercase', paddingTop: 16 }}>{data.property?.name} · {profile.tagline || 'Spa & Wellness'}</p>
          )}
        </div>
      </div>

      {/* ── Offers strip (step 1 only) ── */}
      {step === 1 && offers.length > 0 && (
        <div style={{ background: SPA_DARK, overflowX: 'auto', padding: '14px 16px' }}>
          <div style={{ display: 'flex', gap: 12, minWidth: 'max-content' }}>
            {offers.map((o: any, i: number) => (
              <div key={i} style={{ flexShrink: 0, borderRadius: 16, border: `1px solid rgba(201,169,110,0.25)`, background: 'rgba(255,255,255,0.06)', minWidth: 200, maxWidth: 250, padding: '12px 16px', color: '#fff' }}>
                {o.badge && <span style={{ fontSize: 9, fontWeight: 700, background: SPA_GOLD, color: SPA_DARK, borderRadius: 20, padding: '2px 10px', letterSpacing: 1.5, textTransform: 'uppercase' }}>{o.badge}</span>}
                <p style={{ fontWeight: 600, fontSize: 13, marginTop: 8, lineHeight: 1.35 }}>{o.title}</p>
                {o.description && <p style={{ fontSize: 11, marginTop: 4, opacity: 0.6, lineHeight: 1.5 }}>{o.description}</p>}
                {o.valid_until && <p style={{ fontSize: 10, marginTop: 8, color: SPA_GOLD, opacity: 0.8 }}>Valid till {o.valid_until}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      <StepBar />

      {/* ── Content ── */}
      <div style={{ maxWidth: 580, margin: '0 auto', padding: '24px 16px 96px' }}>

        {/* ════ Step 1: Choose treatment ════ */}
        {step === 1 && (
          <div>
            <h2 style={{ ...SERIF, fontSize: 22, fontWeight: 700, color: '#0d1a14', marginBottom: 4 }}>Choose a Treatment</h2>
            <p style={{ fontSize: 13, color: '#8a7060', marginBottom: 20 }}>Select from our curated wellness menu</p>

            {allCats.length > 1 && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 20, overflowX: 'auto', paddingBottom: 4, scrollbarWidth: 'none' }}>
                {categories.map(cat => {
                  const active = categoryFilter === cat;
                  return (
                    <button key={cat} onClick={() => setCategoryFilter(cat)} style={{ flexShrink: 0, padding: '6px 16px', borderRadius: 24, fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s', background: active ? SPA_DARK : '#fff', color: active ? SPA_GOLD : '#6b5d52', border: `1px solid ${active ? SPA_DARK : '#e8dccf'}` }}>
                      {CATEGORY_ICON[cat] || '🌸'} {cat === 'ALL' ? 'All' : cat.charAt(0) + cat.slice(1).toLowerCase()}
                    </button>
                  );
                })}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {filteredServices.map((s: any) => (
                <button key={s.id} onClick={() => { setService(s); setStep(2); }}
                  style={{ width: '100%', textAlign: 'left', background: '#fff', border: '1px solid #ede5d8', borderRadius: 20, overflow: 'hidden', cursor: 'pointer', boxShadow: '0 2px 12px rgba(0,0,0,0.04)', transition: 'all 0.2s' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 8px 28px rgba(0,0,0,0.1)'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 12px rgba(0,0,0,0.04)'; (e.currentTarget as HTMLElement).style.transform = 'none'; }}>
                  {s.image_url && !failedImages.has(s.id) ? (
                    <div style={{ position: 'relative', height: 160, overflow: 'hidden' }}>
                      <img src={s.image_url} alt={s.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        onError={() => setFailedImages(prev => { const next = new Set(prev); next.add(s.id); return next; })} />
                      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(13,31,24,0.82) 0%, transparent 55%)' }} />
                      <div style={{ position: 'absolute', bottom: 12, left: 16, right: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                        <span style={{ fontSize: 10, background: `${CATEGORY_COLOR[s.category] || SPA_BRAND}dd`, color: '#fff', borderRadius: 20, padding: '2px 10px', fontWeight: 600 }}>{s.category}</span>
                        <span style={{ ...SERIF, fontWeight: 700, fontSize: 18, color: '#fff', textShadow: '0 1px 4px rgba(0,0,0,0.5)' }}>{cur}{Number(s.price).toLocaleString('en-IN')}</span>
                      </div>
                    </div>
                  ) : (
                    <div style={{ position: 'relative', height: 120, overflow: 'hidden', borderBottom: `1px solid ${CATEGORY_COLOR[s.category] || SPA_BRAND}18`, background: `linear-gradient(135deg, ${CATEGORY_COLOR[s.category] || SPA_BRAND}1e 0%, ${CATEGORY_COLOR[s.category] || SPA_BRAND}07 60%, rgba(249,245,239,0.4) 100%)` }}>
                      <div style={{ position: 'absolute', right: -36, top: -36, width: 140, height: 140, borderRadius: '50%', border: `1px solid ${CATEGORY_COLOR[s.category] || SPA_BRAND}18` }} />
                      <div style={{ position: 'absolute', right: 22, bottom: -24, width: 90, height: 90, borderRadius: '50%', border: `1px solid ${CATEGORY_COLOR[s.category] || SPA_BRAND}10` }} />
                      <span style={{ position: 'absolute', left: 16, bottom: 8, fontSize: 54, lineHeight: 1, filter: 'drop-shadow(0 3px 8px rgba(0,0,0,0.08))' }}>{CATEGORY_ICON[s.category] || '🌸'}</span>
                      <div style={{ position: 'absolute', top: 12, right: 12, background: '#fff', borderRadius: 22, padding: '5px 14px', boxShadow: '0 2px 12px rgba(0,0,0,0.09)' }}>
                        <span style={{ ...SERIF, fontWeight: 700, fontSize: 15, color: SPA_BRAND }}>{cur}{Number(s.price).toLocaleString('en-IN')}</span>
                      </div>
                      <span style={{ position: 'absolute', top: 14, left: 12, fontSize: 10, background: `${CATEGORY_COLOR[s.category] || SPA_BRAND}20`, color: CATEGORY_COLOR[s.category] || SPA_BRAND, borderRadius: 20, padding: '3px 10px', fontWeight: 700 }}>{s.category}</span>
                    </div>
                  )}
                  <div style={{ padding: '14px 16px' }}>
                    <p style={{ ...SERIF, fontWeight: 600, fontSize: 16, color: '#0d1a14', lineHeight: 1.3, marginBottom: 4 }}>{s.name}</p>
                    {s.description && <p style={{ fontSize: 12, color: '#8a7060', lineHeight: 1.5 }}>{s.description}</p>}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
                      <span style={{ fontSize: 12, color: '#8a7060', display: 'flex', alignItems: 'center', gap: 4 }}><Clock size={12} /> {s.duration_min} min</span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: SPA_DARK, background: `rgba(201,169,110,0.15)`, border: `1px solid rgba(201,169,110,0.3)`, padding: '4px 14px', borderRadius: 20 }}>Select →</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>

            {filteredServices.length === 0 && (
              <div style={{ textAlign: 'center', padding: '48px 0', borderRadius: 18, border: '1px dashed #ede5d8', background: '#fff', color: '#9d8b7e', fontSize: 13 }}>No services in this category.</div>
            )}

            <div style={{ marginTop: 32, borderRadius: 18, padding: '20px 24px', background: SPA_DARK, textAlign: 'center' }}>
              <p style={{ color: SPA_GOLD, fontSize: 10, letterSpacing: 2.5, textTransform: 'uppercase', fontWeight: 700, marginBottom: 8 }}>Prefer to call?</p>
              {data.property?.phone
                ? <a href={`tel:${data.property.phone}`} style={{ color: '#fff', fontSize: 15, fontWeight: 600, textDecoration: 'none' }}>📞 {data.property.phone}</a>
                : <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>Contact the spa reception directly.</p>}
            </div>
          </div>
        )}

        {/* ════ Step 2: Date & Time ════ */}
        {step === 2 && (
          <div>
            <button onClick={() => { setStep(1); setSlots([]); setSlot(null); }} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: SPA_BRAND, background: 'none', border: 'none', cursor: 'pointer', marginBottom: 20, padding: 0 }}>
              ← Back to treatments
            </button>

            <div style={{ background: '#fff', border: '1px solid #ede5d8', borderRadius: 18, marginBottom: 20, overflow: 'hidden' }}>
              <div style={{ background: SPA_DARK, padding: '10px 18px' }}>
                <p style={{ color: SPA_GOLD, fontSize: 9, letterSpacing: 3, textTransform: 'uppercase', fontWeight: 700 }}>Selected Treatment</p>
              </div>
              <div style={{ display: 'flex', gap: 14, padding: 16 }}>
                {service.image_url
                  ? <img src={service.image_url} alt={service.name} style={{ width: 56, height: 56, borderRadius: 12, objectFit: 'cover', flexShrink: 0 }} />
                  : <div style={{ width: 56, height: 56, borderRadius: 12, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, background: 'linear-gradient(135deg, #f9f5ef, #ede5d8)' }}>{CATEGORY_ICON[service.category] || '🌸'}</div>}
                <div>
                  <p style={{ ...SERIF, fontWeight: 600, fontSize: 15, color: '#0d1a14' }}>{service.name}</p>
                  <p style={{ fontSize: 12, color: '#8a7060', marginTop: 3 }}>{service.duration_min} min · <strong style={{ color: SPA_BRAND }}>{cur}{Number(service.price).toLocaleString('en-IN')}</strong></p>
                </div>
              </div>
            </div>

            <h2 style={{ ...SERIF, fontSize: 22, fontWeight: 700, color: '#0d1a14', marginBottom: 4 }}>Choose Date & Time</h2>
            <p style={{ fontSize: 13, color: '#8a7060', marginBottom: 18 }}>Select a date to see available slots</p>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <button onClick={() => { const d = addDays(date, -1); if (d >= today) { setDate(d); setSlot(null); } }} disabled={date <= today}
                style={{ width: 40, height: 42, borderRadius: 12, border: '1px solid #ede5d8', background: '#fff', fontSize: 18, cursor: date <= today ? 'not-allowed' : 'pointer', opacity: date <= today ? 0.3 : 1, flexShrink: 0, color: '#4a3728' }}>‹</button>
              <input type="date" value={date} min={today} onChange={e => { setDate(e.target.value); setSlot(null); }}
                style={{ flex: 1, padding: '11px 14px', borderRadius: 12, border: '1.5px solid #ede5d8', background: '#fff', fontSize: 13, fontWeight: 600, textAlign: 'center', color: '#0d1a14', outline: 'none' }} />
              <button onClick={() => { setDate(addDays(date, 1)); setSlot(null); }}
                style={{ width: 40, height: 42, borderRadius: 12, border: '1px solid #ede5d8', background: '#fff', fontSize: 18, cursor: 'pointer', flexShrink: 0, color: '#4a3728' }}>›</button>
            </div>
            <p style={{ fontSize: 12, textAlign: 'center', color: '#9d8b7e', marginBottom: 20 }}>{fmtDate(date)}</p>

            {slotsLoading ? (
              <div style={{ textAlign: 'center', padding: '48px 0' }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', border: '2px solid rgba(201,169,110,0.25)', borderTop: '2px solid #c9a96e', animation: 'spin 1.2s linear infinite', margin: '0 auto 12px' }} />
                <p style={{ fontSize: 12, color: '#9d8b7e' }}>Finding available slots…</p>
              </div>
            ) : slots.length > 0 ? (
              <div>
                <p style={{ fontSize: 12, fontWeight: 600, color: '#6b5d52', marginBottom: 12 }}>{slots.length} time{slots.length !== 1 ? 's' : ''} available</p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                  {slots.map((s, i) => {
                    const sel = slot === s;
                    return (
                      <button key={i} onClick={() => setSlot(s)} style={{ padding: '12px 4px', borderRadius: 14, display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', transition: 'all 0.15s', background: sel ? SPA_DARK : '#fff', border: `1px solid ${sel ? SPA_DARK : '#ede5d8'}`, boxShadow: sel ? '0 4px 14px rgba(13,31,24,0.2)' : 'none' }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: sel ? SPA_GOLD : '#0d1a14' }}>{fmtTime(s.start_at)}</span>
                        {s.therapist_name && <span style={{ fontSize: 9, color: sel ? 'rgba(201,169,110,0.7)' : '#9d8b7e', marginTop: 3, maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.therapist_name.split(' ')[0]}</span>}
                      </button>
                    );
                  })}
                </div>
                {slot && (
                  <button onClick={() => setStep(3)} style={{ width: '100%', marginTop: 20, padding: '15px 0', borderRadius: 18, color: SPA_GOLD, fontWeight: 700, fontSize: 14, background: `linear-gradient(135deg, ${SPA_DARK} 0%, #1a3828 100%)`, border: 'none', cursor: 'pointer', boxShadow: '0 4px 16px rgba(13,31,24,0.3)', letterSpacing: 0.3 }}>
                    Continue with {fmtTime(slot.start_at)} →
                  </button>
                )}
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '40px 20px', borderRadius: 18, border: '1px dashed #ede5d8', background: '#fff' }}>
                <p style={{ fontSize: 24, marginBottom: 12 }}>🌿</p>
                <p style={{ fontWeight: 600, fontSize: 14, color: '#4a3728', marginBottom: 6 }}>No slots available for this date</p>
                <p style={{ fontSize: 12, color: '#9d8b7e', marginBottom: 16 }}>Try another date, or contact us directly.</p>
                {data.property?.phone && (
                  <a href={`tel:${data.property.phone}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 20px', borderRadius: 14, background: SPA_DARK, color: SPA_GOLD, fontSize: 12, fontWeight: 600, textDecoration: 'none' }}>📞 Call to Book</a>
                )}
              </div>
            )}
          </div>
        )}

        {/* ════ Step 3: Guest details ════ */}
        {step === 3 && (
          <div>
            <button onClick={() => setStep(2)} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: SPA_BRAND, background: 'none', border: 'none', cursor: 'pointer', marginBottom: 20, padding: 0 }}>
              ← Change time
            </button>

            <div style={{ background: SPA_DARK, borderRadius: 18, marginBottom: 24, overflow: 'hidden' }}>
              <div style={{ padding: '10px 18px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                <p style={{ color: SPA_GOLD, fontSize: 9, letterSpacing: 3, textTransform: 'uppercase', fontWeight: 700 }}>Your Appointment</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 16 }}>
                <div style={{ width: 48, height: 48, borderRadius: 12, background: 'rgba(201,169,110,0.12)', border: `1px solid rgba(201,169,110,0.25)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>{CATEGORY_ICON[service.category] || '🌸'}</div>
                <div style={{ flex: 1 }}>
                  <p style={{ ...SERIF, fontWeight: 600, fontSize: 15, color: '#fff' }}>{service.name}</p>
                  <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 3 }}>{fmtDate(date)} · {slot && fmtTime(slot.start_at)}</p>
                  {slot?.therapist_name && <p style={{ fontSize: 11, color: SPA_GOLD, marginTop: 2 }}>with {slot.therapist_name}</p>}
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <p style={{ ...SERIF, fontWeight: 700, fontSize: 16, color: SPA_GOLD }}>{cur}{Number(service.price).toLocaleString('en-IN')}</p>
                  <p style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', marginTop: 2 }}>+ GST</p>
                </div>
              </div>
            </div>

            <h2 style={{ ...SERIF, fontSize: 22, fontWeight: 700, color: '#0d1a14', marginBottom: 4 }}>Your Details</h2>
            <p style={{ fontSize: 13, color: '#8a7060', marginBottom: 22 }}>We'll use these to confirm your appointment</p>

            {[
              { label: 'Full Name', key: 'client_name', type: 'text', placeholder: 'e.g. Priya Sharma', req: true },
              { label: 'Phone Number', key: 'client_phone', type: 'tel', placeholder: '+91 98765 43210', req: true },
              { label: 'Email Address', key: 'client_email', type: 'email', placeholder: 'your@email.com', req: false },
            ].map(({ label, key, type, placeholder, req }) => (
              <div key={key} style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#5a4535', marginBottom: 6 }}>
                  {label} {req ? <span style={{ color: SPA_BRAND }}>*</span> : <span style={{ fontWeight: 400, color: '#b0a090' }}>(optional)</span>}
                </label>
                <input type={type} placeholder={placeholder} value={(guest as any)[key]} onChange={e => setGuest({ ...guest, [key]: e.target.value })}
                  style={{ width: '100%', padding: '12px 16px', borderRadius: 14, border: '1.5px solid #ede5d8', background: '#fff', fontSize: 13, color: '#0d1a14', outline: 'none', boxSizing: 'border-box', transition: 'border-color 0.15s' }}
                  onFocus={e => e.target.style.borderColor = SPA_DARK} onBlur={e => e.target.style.borderColor = '#ede5d8'} />
              </div>
            ))}

            {error && <div style={{ padding: '12px 16px', borderRadius: 12, background: '#fff5f5', border: '1px solid #fecaca', color: '#c0392b', fontSize: 12, marginBottom: 16 }}>{error}</div>}

            <button onClick={submit} disabled={busy || !guest.client_name || !guest.client_phone}
              style={{ width: '100%', marginTop: 8, padding: '15px 0', borderRadius: 18, fontWeight: 700, fontSize: 14, border: 'none', cursor: busy || !guest.client_name || !guest.client_phone ? 'not-allowed' : 'pointer', transition: 'all 0.2s', background: busy || !guest.client_name || !guest.client_phone ? '#d6c9be' : `linear-gradient(135deg, ${SPA_DARK} 0%, #1a3828 100%)`, color: busy || !guest.client_name || !guest.client_phone ? '#a09080' : SPA_GOLD, boxShadow: busy || !guest.client_name || !guest.client_phone ? 'none' : '0 4px 16px rgba(13,31,24,0.28)', letterSpacing: 0.3 }}>
              {busy ? 'Booking your appointment…' : '✦ Confirm Booking'}
            </button>
            <p style={{ textAlign: 'center', fontSize: 11, color: '#b0a090', marginTop: 12 }}>No payment required today. Cancellation policy applies.</p>
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <div style={{ background: SPA_DARK, borderTop: '1px solid rgba(255,255,255,0.06)', padding: '28px 16px', textAlign: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginBottom: 8 }}>
          <div style={{ height: 1, width: 28, background: 'rgba(201,169,110,0.35)' }} />
          <p style={{ ...SERIF, color: SPA_GOLD, fontSize: 13, fontWeight: 600 }}>{data.property?.name}</p>
          <div style={{ height: 1, width: 28, background: 'rgba(201,169,110,0.35)' }} />
        </div>
        {data.property?.phone && <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>📞 {data.property.phone}</p>}
        {data.property?.city && <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', marginTop: 4 }}>{data.property.city}{data.property.state ? `, ${data.property.state}` : ''}</p>}
        <p style={{ fontSize: 9, color: 'rgba(255,255,255,0.15)', marginTop: 14, letterSpacing: 2 }}>POWERED BY ATITHI-SETU</p>
      </div>
    </div>
  );
}
