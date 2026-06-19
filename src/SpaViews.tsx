// ════════════════════════════════════════════════════════════════════════
// Spa & Wellness — frontend views (gated by spa_enabled; mirrors hotel pages)
// Single import surface for App.tsx: <SpaModule tab={activeTab} .../> dispatches
// to the right view. Public booking page exported separately.
// ════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect } from 'react';
import { DataTable } from './components/DataTable';
import {
  Sparkles, Calendar, Clock, Plus, Trash2, Check, X, User, Package, Award,
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
  const blank = { name: '', category: 'MASSAGE', duration_min: '60', buffer_after_min: '10', price: '', gst_percent: '18', requires_room: true, requires_therapist: true };
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
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-bold font-serif mb-4">{edit ? 'Edit' : 'Add'} Service</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2"><label className={LABEL}>Name</label><input className={INPUT} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
              <div><label className={LABEL}>Category</label>
                <select className={INPUT} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                  {['MASSAGE', 'FACIAL', 'BODY', 'SAUNA', 'SALON', 'WELLNESS'].map(c => <option key={c}>{c}</option>)}
                </select></div>
              <div><label className={LABEL}>Duration (min)</label><input className={INPUT} type="number" value={form.duration_min} onChange={e => setForm({ ...form, duration_min: e.target.value })} /></div>
              <div><label className={LABEL}>Buffer after (min)</label><input className={INPUT} type="number" value={form.buffer_after_min} onChange={e => setForm({ ...form, buffer_after_min: e.target.value })} /></div>
              <div><label className={LABEL}>Price (₹)</label><input className={INPUT} type="number" value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} /></div>
              <div><label className={LABEL}>GST %</label><input className={INPUT} type="number" value={form.gst_percent} onChange={e => setForm({ ...form, gst_percent: e.target.value })} /></div>
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

  const load = async () => {
    setLoading(true);
    try {
      const from = `${day} 00:00:00`, to = `${day} 23:59:59`;
      setAppts(await api(`/spa/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`));
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
        action={<div className="flex gap-2">
          <input className={INPUT} type="date" value={day} onChange={e => setDay(e.target.value)} style={{ width: 'auto' }} />
          <button className={BTN_GHOST} onClick={load}><RefreshCw size={13} /></button>
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
            columns={[
              { key: 'time', label: 'Time', render: (r: any) => `${fmtTime(r.start_at)}–${fmtTime(r.end_at)}` },
              { key: 'service_name', label: 'Service' },
              { key: 'client_name', label: 'Client' },
              { key: 'therapist_name', label: 'Therapist' },
              { key: 'resource_name', label: 'Cabin' },
              { key: 'status', label: 'Status', render: (r: any) => <Pill status={r.status} /> },
              { key: '_a', label: 'Actions', render: (r: any) => (
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
    default: return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// PUBLIC booking page (unauthenticated) — /spa/:slug resolves restaurantId first
// ════════════════════════════════════════════════════════════════════════
export function SpaBookingPage({ tenantId }: { tenantId: string }) {
  const [data, setData] = useState<any>(null);
  const [restaurantId, setRestaurantId] = useState<string>(tenantId);
  const [step, setStep] = useState(1);
  const [service, setService] = useState<any>(null);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [slots, setSlots] = useState<any[]>([]);
  const [slot, setSlot] = useState<any>(null);
  const [guest, setGuest] = useState({ client_name: '', client_phone: '', client_email: '' });
  const [done, setDone] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  // Resolve a friendly slug → real tenant id (same pattern as the hotel page).
  useEffect(() => { (async () => {
    try {
      let id = tenantId;
      let r = await fetch(`/api/public/restaurant/${encodeURIComponent(id)}/spa`);
      if (r.status === 404) {
        const r2 = await fetch(`/api/public/restaurant/by-slug/${encodeURIComponent(tenantId)}`);
        if (r2.ok) { const j = await r2.json(); if (j.tenantId) { id = j.tenantId; r = await fetch(`/api/public/restaurant/${encodeURIComponent(id)}/spa`); } }
      }
      if (r.ok) { setRestaurantId(id); setData(await r.json()); } else setData({ error: true });
    } catch { setData({ error: true }); }
  })(); }, [tenantId]);

  const findSlots = async () => {
    setBusy(true); setSlot(null);
    try { const r = await fetch(`/api/public/restaurant/${restaurantId}/spa/availability?service_id=${service.id}&date=${date}`); const b = await r.json(); setSlots(b.slots || []); }
    catch { setSlots([]); } finally { setBusy(false); }
  };
  const submit = async () => {
    if (!slot || !guest.client_name || !guest.client_phone) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/public/restaurant/${restaurantId}/spa/booking`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service_id: service.id, start_at: slot.start_at, therapist_id: slot.therapist_id, resource_id: slot.resource_id, ...guest }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || 'Failed');
      setDone(b);
    } catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };

  if (!data) return <div className="min-h-screen flex items-center justify-center text-[#6b5d52]">Loading…</div>;
  if (data.error) return <div className="min-h-screen flex items-center justify-center text-[#6b5d52]">Spa booking is not available.</div>;
  const cur = data.property?.currency_symbol || '₹';

  return (
    <div className="min-h-screen bg-[#faf7f2] py-10 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-8">
          {data.property?.logo_url && <img src={data.property.logo_url} alt="" className="h-14 mx-auto mb-3" />}
          <h1 className="text-3xl font-bold font-serif text-[#14110c] flex items-center justify-center gap-2"><Sparkles size={24} className="text-[#cc5a16]" /> {data.property?.name} Spa</h1>
          <p className="text-sm text-[#6b5d52]">Book your wellness treatment online</p>
        </div>

        {done ? (
          <div className="bg-white rounded-2xl border border-[#e8dccf] p-8 text-center">
            <Check size={48} className="mx-auto text-emerald-500 mb-3" />
            <h2 className="text-xl font-bold font-serif mb-1">Booking Confirmed!</h2>
            <p className="text-sm text-[#6b5d52]">{service.name} on {done.start_at?.slice(0, 16)}</p>
            <p className="text-xs text-[#6b5d52] mt-2">We'll see you soon, {guest.client_name}.</p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-[#e8dccf] p-6">
            {/* step indicator */}
            <div className="flex items-center justify-center gap-2 mb-6">
              {[1, 2, 3].map(n => <div key={n} className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${step >= n ? 'bg-[#cc5a16] text-white' : 'bg-[#f0e9df] text-[#6b5d52]'}`}>{n}</div>)}
            </div>

            {step === 1 && (
              <div>
                <h3 className="font-bold mb-3">Choose a treatment</h3>
                <div className="space-y-2">
                  {data.services?.map((s: any) => (
                    <button key={s.id} onClick={() => { setService(s); setStep(2); }}
                      className="w-full text-left rounded-xl border border-[#e8dccf] p-3 hover:border-[#cc5a16] transition-colors flex justify-between items-center">
                      <div><div className="font-semibold">{s.name}</div><div className="text-xs text-[#6b5d52]">{s.category} · {s.duration_min} min</div></div>
                      <div className="font-bold text-[#cc5a16]">{cur}{Number(s.price).toLocaleString('en-IN')}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {step === 2 && (
              <div>
                <button className="text-xs text-[#cc5a16] mb-3" onClick={() => setStep(1)}>← Change treatment</button>
                <h3 className="font-bold mb-1">{service.name}</h3>
                <p className="text-xs text-[#6b5d52] mb-3">Pick a date & time</p>
                <div className="flex gap-2 mb-3">
                  <input className="flex-1 px-3 py-2 rounded-xl border border-[#e8dccf] text-sm" type="date" value={date} onChange={e => setDate(e.target.value)} />
                  <button className="px-4 py-2 rounded-xl bg-[#cc5a16] text-white text-xs font-bold" onClick={findSlots}>{busy ? '…' : 'Find Times'}</button>
                </div>
                <div className="grid grid-cols-4 gap-1.5 max-h-48 overflow-auto">
                  {slots.map((s, i) => <button key={i} onClick={() => setSlot(s)} className={`px-2 py-2 rounded-lg text-xs border ${slot === s ? 'bg-[#cc5a16] text-white border-[#cc5a16]' : 'border-[#e8dccf]'}`}>{s.start_at.slice(11, 16)}</button>)}
                </div>
                {slot && <button className="w-full mt-4 px-4 py-2.5 rounded-xl bg-[#cc5a16] text-white text-sm font-bold" onClick={() => setStep(3)}>Continue</button>}
                {!slots.length && !busy && <p className="text-xs text-[#6b5d52] mt-2">Select a date and tap "Find Times".</p>}
              </div>
            )}

            {step === 3 && (
              <div>
                <button className="text-xs text-[#cc5a16] mb-3" onClick={() => setStep(2)}>← Change time</button>
                <h3 className="font-bold mb-1">Your details</h3>
                <p className="text-xs text-[#6b5d52] mb-3">{service.name} · {slot?.start_at?.slice(0, 16)}</p>
                <div className="space-y-3">
                  <input className="w-full px-3 py-2 rounded-xl border border-[#e8dccf] text-sm" placeholder="Full name" value={guest.client_name} onChange={e => setGuest({ ...guest, client_name: e.target.value })} />
                  <input className="w-full px-3 py-2 rounded-xl border border-[#e8dccf] text-sm" placeholder="Phone" value={guest.client_phone} onChange={e => setGuest({ ...guest, client_phone: e.target.value })} />
                  <input className="w-full px-3 py-2 rounded-xl border border-[#e8dccf] text-sm" placeholder="Email (optional)" value={guest.client_email} onChange={e => setGuest({ ...guest, client_email: e.target.value })} />
                </div>
                <button className="w-full mt-4 px-4 py-2.5 rounded-xl bg-[#cc5a16] text-white text-sm font-bold disabled:opacity-50" disabled={busy || !guest.client_name || !guest.client_phone} onClick={submit}>{busy ? 'Booking…' : 'Confirm Booking'}</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
