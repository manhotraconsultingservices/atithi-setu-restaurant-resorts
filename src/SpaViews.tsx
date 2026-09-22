// ════════════════════════════════════════════════════════════════════════
// Spa & Wellness — frontend views (gated by spa_enabled; mirrors hotel pages)
// Single import surface for App.tsx: <SpaModule tab={activeTab} .../> dispatches
// to the right view. Public booking page exported separately.
// ════════════════════════════════════════════════════════════════════════
import { BRAND, BRAND_DARK } from './theme';
import React, { useState, useEffect } from 'react';
import { DataTable } from './components/DataTable';
import { ObjectDetail, buildObjectResolver } from './components/ObjectDetail';
import {
  Calendar, Clock, Plus, Trash2, Check, X, User, Package, Award,
  TrendingUp, RefreshCw, FileText, Scissors, DoorOpen, IndianRupee, Tag, ReceiptText, History, Link2, Send, Ban, BadgePercent,
  CalendarCheck, LogIn, Play, UserX, ClipboardList,
} from 'lucide-react';
// RBAC — shared frontend gates (View=1, Edit=2, Full=3) reading the tab_perms
// map App.tsx mirrors into localStorage. These detached Spa views hide write
// controls a role can't use; the backend remains the security boundary.
import { canWriteTab, canDeleteTab } from './perm';
import { useToast } from './components/Toast';
import { useConfirm } from './components/ConfirmDialog';
import { usePaymentDialog } from './components/PaymentDialog';
import { QRCodeCanvas } from 'qrcode.react';
import { CollectOnlineDialog } from './PaymentLinks';
import { DateRangeBar, StatusTiles, defaultDateRange, dayInRange, type DateRange } from './components/ListFilters';
import { moduleOn } from './tenantModules';
import { RowActions } from './components/RowActions';
import { useBuyerGstEditor } from './components/BuyerGstEditor';
import { useT } from './i18n';
import { PayOnlineButton, usePublicPayOptions, PayChoicePicker, HoldCountdown } from './PublicPay';

// ── Spa History overlay — audit log (who changed what) for an appointment or
// folio, via the reusable ObjectDetail shell. Opened by a "History" button. ──
const SPA_RECORD_LABEL: Record<string, string> = { SPA_SERVICE: 'Treatment', SPA_THERAPIST: 'Therapist', SPA_CABIN: 'Cabin', SPA_SKILL: 'Skill', SPA_CABIN_TYPE: 'Cabin type', SPA_CLIENT: 'Guest' };
function SpaHistoryOverlay({ kind, id, meta, onClose, restaurantId, token }: {
  kind: 'SPA_APPOINTMENT' | 'SPA_FOLIO' | 'SPA_SERVICE' | 'SPA_THERAPIST' | 'SPA_CABIN' | 'SPA_SKILL' | 'SPA_CABIN_TYPE' | 'SPA_CLIENT'; id: string; meta?: any; onClose: () => void; restaurantId: string; token: string;
}) {
  const isAppt = kind === 'SPA_APPOINTMENT';
  // The spa's own records share one history and where-used route.
  const recordLabel = SPA_RECORD_LABEL[kind];
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 overflow-y-auto p-4 sm:p-8" onClick={onClose}>
      <div className="max-w-3xl mx-auto bg-[#faf7f2] rounded-2xl shadow-2xl p-5" onClick={e => e.stopPropagation()}>
        <ObjectDetail
          token={token}
          title={meta?.title || id}
          subtitle={meta?.subtitle || recordLabel || (isAppt ? 'Spa appointment' : 'Spa invoice')}
          overviewLabel={recordLabel || (isAppt ? 'Appointment' : 'Invoice')}
          onBack={onClose}
          backLabel="Close"
          auditUrl={recordLabel ? `/api/restaurant/${restaurantId}/spa/records/${kind}/${id}/audit` : `/api/restaurant/${restaurantId}/spa/${isAppt ? 'appointments' : 'folios'}/${id}/audit`}
          whereUsedUrl={recordLabel ? `/api/restaurant/${restaurantId}/spa/records/${kind}/${id}/where-used` : isAppt ? `/api/restaurant/${restaurantId}/spa/appointments/${id}/where-used` : undefined}
          // Documents apply only to the appointment itself — a booking — not
          // to a master record (Treatment/Therapist/Cabin/Skill) or a folio.
          documentsUrl={isAppt ? `/api/restaurant/${restaurantId}/spa/appointments/${id}/documents` : undefined}
          canManageDocuments={canWriteTab('SPA_APPOINTMENTS')}
          resolveLink={buildObjectResolver(restaurantId, token)}
          overview={
            <div className="bg-white rounded-2xl border border-[#e8dccf] p-5">
              <div className="grid grid-cols-2 gap-3 text-[12px]">
                {(meta?.facts || []).map(([k, v]: [string, any], i: number) => (
                  <div key={i}><span className="text-[#9c8e85]">{k}</span><div className="font-semibold text-[#14110c] break-words">{v == null || v === '' ? '—' : String(v)}</div></div>
                ))}
              </div>
              <p className="text-[11px] text-[#9c8e85] mt-3">Open the <b>Audit log</b> tab to see who changed this {recordLabel ? recordLabel.toLowerCase() : isAppt ? 'appointment' : 'invoice'} and what changed (before → after) — so an accidental edit is easy to spot.</p>
            </div>
          }
        />
      </div>
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
      // The status and body ride along, for a screen that acts on an error's code.
      const err: any = new Error((b && b.error) || `HTTP ${r.status}`);
      err.status = r.status; err.body = b;
      throw err;
    }
    return b;
  };
}

const CARD = "bg-white rounded-2xl border border-[#e8dccf] p-5";
const BTN = "px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors";
const BTN_PRIMARY = `${BTN} bg-brand text-white hover:bg-[#b34f12]`;
const BTN_GHOST = `${BTN} bg-[#faf7f2] border border-[#e8dccf] text-[#3d3128] hover:bg-[#f0e9df]`;
const INPUT = "w-full px-3 py-2 rounded-xl border border-[#e8dccf] text-sm bg-white focus:outline-none focus:border-brand";
const LABEL = "text-xs font-semibold text-[#6b5d52] mb-1 block";
const money = (n: any) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
// Today in India. `new Date().toISOString()` is UTC, so before 05:30 IST the
// appointment screens opened on yesterday.
const istToday = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

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
        <div className="w-9 h-9 rounded-xl bg-[#faf7f2] border border-[#e8dccf] flex items-center justify-center text-brand">{icon}</div>
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
  const toast = useToast();
  const confirmDlg = useConfirm();
  const [history, setHistory] = useState<any>(null); // History window for a treatment
  const canEdit = canWriteTab('SPA_CATALOG');
  const canDel = canDeleteTab('SPA_CATALOG');
  const [services, setServices] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const blank = { name: '', category: 'MASSAGE', duration_min: '60', buffer_after_min: '10', price: '', gst_percent: '18', requires_room: true, requires_therapist: true, therapists_required: '1', image_url: '', description: '' };
  const [form, setForm] = useState<any>(blank);
  // Deactivated treatments stay on file but out of the way until asked for.
  const [showInactive, setShowInactive] = useState(false);
  const inactiveServices = services.filter((s: any) => Number(s.is_active ?? 1) !== 1);
  // What a treatment needs: skills at a minimum level and a cabin type. Saved
  // only when changed, so an ordinary edit adds no audit entry.
  const [skillList, setSkillList] = useState<any[]>([]);
  const [cabinTypes, setCabinTypes] = useState<any[]>([]);
  const [conditions, setConditions] = useState<any[]>([]);
  const emptyReq = { skills: [] as { skill_id: string; min_level: string }[], cabin_type_id: '', gender_rule: 'ANY', requires_consent: false, contraindications: [] as string[] };
  const [req, setReq] = useState(emptyReq);
  const [reqLoaded, setReqLoaded] = useState(JSON.stringify(emptyReq));
  useEffect(() => {
    (async () => {
      try { setSkillList(await api('/spa/skills')); } catch { /* */ }
      try { setCabinTypes(await api('/spa/cabin-types')); } catch { /* */ }
      try { setConditions((await api('/spa/clinical/conditions')).conditions || []); } catch { /* */ }
    })();
  }, []);
  const openReq = async (sid: string | null) => {
    setReq(emptyReq); setReqLoaded(JSON.stringify(emptyReq));
    if (!sid) return;
    try {
      const r = await api(`/spa/services/${sid}/requirements`);
      const v = { skills: (r.skills || []).map((s: any) => ({ skill_id: s.skill_id, min_level: s.min_level || 'QUALIFIED' })), cabin_type_id: r.cabin_type_id || '', gender_rule: r.gender_rule || 'ANY',
        requires_consent: !!r.requires_consent, contraindications: Array.isArray(r.contraindications) ? r.contraindications : [] };
      setReq(v); setReqLoaded(JSON.stringify(v));
    } catch { /* */ }
  };

  const load = async () => { setLoading(true); try { setServices(await api('/spa/services')); } catch (e: any) { toast.error(`Could not load the treatments: ${e.message}`); } finally { setLoading(false); } };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!canEdit) { toast.error('View-only access — you cannot change the service menu.'); return; }
    if (!form.name) return;
    // Cabin type and gender rule belong to the requirements save below, not the treatment row.
    const { cabin_type_id: _cabinType, gender_rule: _genderRule, ...formFields } = form;
    const body = { ...formFields, duration_min: Number(form.duration_min || 60), buffer_after_min: Number(form.buffer_after_min || 10), price: Number(form.price || 0), gst_percent: Number(form.gst_percent || 18), therapists_required: Math.max(1, Math.min(4, Number(form.therapists_required || 1))) };
    try {
      let sid: string | null = edit?.id || null;
      if (edit) await api(`/spa/services/${edit.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else { const created = await api('/spa/services', { method: 'POST', body: JSON.stringify(body) }); sid = created?.id || null; }
      if (sid && JSON.stringify(req) !== reqLoaded) {
        await api(`/spa/services/${sid}/requirements`, { method: 'PUT', body: JSON.stringify({ ...req, skills: req.skills.filter(s => s.skill_id), cabin_type_id: req.cabin_type_id || null }) });
      }
      setShowForm(false); setEdit(null); setForm(blank); await load();
    } catch (e: any) { toast.error(e.message); }
  };
  const remove = async (id: string) => { if (!canDel) { toast.error('View-only access — you cannot deactivate services.'); return; } if (!(await confirmDlg({ title: 'Deactivate this treatment?', body: 'It comes off the menu for new bookings. Past bookings and invoices keep it.', confirmLabel: 'Deactivate', danger: true }))) return; try { await api(`/spa/services/${id}`, { method: 'DELETE' }); await load(); } catch (e: any) { toast.error(e.message); } };

  return (
    <div>
      <SectionHeader icon={<Scissors size={18} />} title="Service Menu" sub="Treatments, durations, pricing & tax"
        action={<div className="flex gap-2 flex-wrap">
          {inactiveServices.length > 0 && <button className={BTN_GHOST} onClick={() => setShowInactive(v => !v)}>{showInactive ? 'Hide inactive' : `Show inactive (${inactiveServices.length})`}</button>}
          {canEdit && <button className={BTN_PRIMARY} onClick={() => { setEdit(null); setForm(blank); openReq(null); setShowForm(true); }}><Plus size={14} /> Add Service</button>}
        </div>} />
      <div className={CARD}>
        <DataTable
          data={showInactive ? services : services.filter((s: any) => Number(s.is_active ?? 1) === 1)}
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
                <button className={BTN_GHOST} title="Who changed this treatment, and where it is used" onClick={() => setHistory({ id: r.id, meta: { title: r.name, facts: [['Duration', `${r.duration_min} min`], ['Price', money(r.price)], ['GST', `${r.gst_percent}%`], ['Status', r.is_active ? 'Active' : 'Inactive']] } })}><History size={12} /> History</button>
                {canEdit && <button className={BTN_GHOST} onClick={() => { setEdit(r); setForm({ ...blank, ...r, duration_min: String(r.duration_min), buffer_after_min: String(r.buffer_after_min), price: String(r.price), gst_percent: String(r.gst_percent), requires_room: !!r.requires_room, requires_therapist: !!r.requires_therapist, therapists_required: String(r.therapists_required ?? 1) }); openReq(r.id); setShowForm(true); }}>Edit</button>}
                {canDel && <button className={`${BTN} bg-rose-50 text-rose-600 hover:bg-rose-100`} onClick={() => remove(r.id)}><Trash2 size={13} /></button>}
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
              <div className="col-span-2 rounded-xl border border-[#e8dccf] bg-[#faf7f2] p-3">
                <div className="text-xs font-bold text-[#3d3128] mb-1">Who gives it, and where</div>
                <p className="text-[11px] text-[#6b5d52] mb-2">Name the skills this therapy needs and it is offered only with therapists who hold them. With no skills named, the therapists ticked for it under Therapists & Cabins are offered.</p>
                {req.skills.map((s, i) => (
                  <div key={i} className="grid grid-cols-[1fr_auto_auto] gap-2 mb-1.5">
                    <select className={INPUT} value={s.skill_id} onChange={e => setReq({ ...req, skills: req.skills.map((x, j) => j === i ? { ...x, skill_id: e.target.value } : x) })}>
                      <option value="">Choose a skill</option>
                      {skillList.filter((k: any) => Number(k.is_active ?? 1) === 1 || k.id === s.skill_id).map((k: any) => <option key={k.id} value={k.id}>{k.name}</option>)}
                    </select>
                    <select className={INPUT} value={s.min_level} onChange={e => setReq({ ...req, skills: req.skills.map((x, j) => j === i ? { ...x, min_level: e.target.value } : x) })}>
                      <option value="TRAINEE">Trainee or above</option>
                      <option value="QUALIFIED">Qualified or above</option>
                      <option value="SENIOR">Senior</option>
                    </select>
                    <button className={`${BTN} bg-rose-50 text-rose-600 hover:bg-rose-100`} aria-label="Remove skill" onClick={() => setReq({ ...req, skills: req.skills.filter((_, j) => j !== i) })}><X size={13} /></button>
                  </div>
                ))}
                {skillList.some((k: any) => Number(k.is_active ?? 1) === 1)
                  ? <button className={BTN_GHOST} onClick={() => setReq({ ...req, skills: [...req.skills, { skill_id: '', min_level: 'QUALIFIED' }] })}><Plus size={13} /> Add a skill</button>
                  : <p className="text-[11px] text-[#9c8e85]">No skills on file yet — add them under Therapists & Cabins → Skills & Cabin Types.</p>}
                {form.requires_therapist && (
                  <div className="mt-2">
                    <label className={LABEL}>Therapists who give it together</label>
                    <select className={INPUT} value={String(form.therapists_required || '1')} onChange={e => setForm({ ...form, therapists_required: e.target.value })}>
                      <option value="1">One therapist</option>
                      <option value="2">Two therapists (four hands)</option>
                      <option value="3">Three therapists</option>
                      <option value="4">Four therapists</option>
                    </select>
                  </div>
                )}
                <div className="mt-2">
                  <label className={LABEL}>Therapist gender</label>
                  <select className={INPUT} value={req.gender_rule} onChange={e => setReq({ ...req, gender_rule: e.target.value })}>
                    <option value="ANY">Any therapist</option>
                    <option value="SAME_GENDER">Same gender as the guest</option>
                  </select>
                  {req.gender_rule === 'SAME_GENDER' && <p className="text-[11px] text-[#6b5d52] mt-1">A booking then needs the guest's gender, and only therapists with their gender recorded are offered.</p>}
                </div>
                <div className="mt-3 pt-3 border-t border-[#e8dccf]">
                  <label className="flex items-center gap-2 text-xs font-semibold text-[#3d3128]"><input type="checkbox" checked={req.requires_consent} onChange={e => setReq({ ...req, requires_consent: e.target.checked })} /> Needs a signed consent and a health intake before check-in</label>
                  <label className={`${LABEL} mt-2`}>Not advised with</label>
                  <div className="flex flex-wrap gap-1">
                    {conditions.map((c: any) => { const on = req.contraindications.includes(c.code); return (
                      <button key={c.code} type="button" onClick={() => setReq({ ...req, contraindications: on ? req.contraindications.filter((x: string) => x !== c.code) : [...req.contraindications, c.code] })}
                        className={`px-2 py-0.5 rounded-md text-[10px] font-semibold border ${on ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-white text-[#6b5d52] border-[#e8dccf]'}`}>{c.label}</button>); })}
                  </div>
                  {req.contraindications.length > 0 && <p className="text-[11px] text-[#6b5d52] mt-1">Where consent and intake are required, check-in is held when the guest's latest intake records one of these, until a clinician gives a reason.</p>}
                </div>
                {form.requires_room && (
                  <div className="mt-2">
                    <label className={LABEL}>Cabin type</label>
                    <select className={INPUT} value={req.cabin_type_id} onChange={e => setReq({ ...req, cabin_type_id: e.target.value })}>
                      <option value="">Any cabin</option>
                      {cabinTypes.filter((c: any) => Number(c.is_active ?? 1) === 1 || c.id === req.cabin_type_id).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                )}
              </div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.requires_room} onChange={e => setForm({ ...form, requires_room: e.target.checked })} /> Requires cabin</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.requires_therapist} onChange={e => setForm({ ...form, requires_therapist: e.target.checked })} /> Requires therapist</label>
            </div>
            {edit && <SpaServiceSupplies restaurantId={restaurantId} token={token} serviceId={edit.id} />}
            <div className="flex justify-end gap-2 mt-5">
              <button className={BTN_GHOST} onClick={() => setShowForm(false)}>Cancel</button>
              <button className={BTN_PRIMARY} onClick={save}>Save</button>
            </div>
          </div>
        </div>
      )}
      {history && <SpaHistoryOverlay kind="SPA_SERVICE" id={history.id} meta={history.meta} onClose={() => setHistory(null)} restaurantId={restaurantId} token={token} />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// RESOURCES (cabins + therapists + schedules + skills)
// ════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════
// TREATMENT RECORD (Phase 3) — add-ons and consumables of a treatment, finishing
// a treatment, its record, and tracing a batch to the guests who received it.
// ════════════════════════════════════════════════════════════════════════
const SPA_OUTCOME_LABEL: Record<string, string> = { IMPROVED: 'Improved', NO_CHANGE: 'No change', WORSE: 'Worse', NOT_ASSESSED: 'Not assessed' };
const spaTs = (v: any) => (v ? String(v).slice(0, 16).replace('T', ' ') : '—');

/** A treatment's add-ons and the items it uses, edited in place. */
function SpaServiceSupplies({ restaurantId, token, serviceId }: { restaurantId: string; token: string; serviceId: string }) {
  const api = makeApi(restaurantId, token);
  const canEdit = canWriteTab('SPA_CATALOG');
  const canDel = canDeleteTab('SPA_CATALOG');
  const [addons, setAddons] = useState<any[]>([]);
  const [cons, setCons] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [newAddon, setNewAddon] = useState({ name: '', extra_duration_min: '', extra_price: '' });
  const [newCon, setNewCon] = useState({ ingredient_id: '', qty_per_service: '', is_variable: false, addon_id: '' });
  const [err, setErr] = useState('');
  const load = async () => {
    try { setAddons(await api(`/spa/services/${serviceId}/addons`)); } catch (e: any) { setErr(e.message); }
    try { setCons(await api(`/spa/services/${serviceId}/consumables`)); } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); (async () => { try { setItems(await api('/spa/inventory')); } catch { /* the add form shows no items */ } })(); }, [serviceId]);
  const run = async (fn: () => Promise<any>) => { setErr(''); try { await fn(); await load(); } catch (e: any) { setErr(e.message); } };
  const addAddon = () => run(async () => {
    if (!newAddon.name.trim()) throw new Error('Give the add-on a name.');
    await api(`/spa/services/${serviceId}/addons`, { method: 'POST', body: JSON.stringify({ name: newAddon.name.trim(), extra_duration_min: Number(newAddon.extra_duration_min || 0), extra_price: Number(newAddon.extra_price || 0) }) });
    setNewAddon({ name: '', extra_duration_min: '', extra_price: '' });
  });
  const addCon = () => run(async () => {
    if (!newCon.ingredient_id) throw new Error('Choose the item used.');
    await api(`/spa/services/${serviceId}/consumables`, { method: 'POST', body: JSON.stringify({ ingredient_id: newCon.ingredient_id, qty_per_service: Number(newCon.qty_per_service || 0), is_variable: newCon.is_variable, addon_id: newCon.addon_id || null }) });
    setNewCon({ ingredient_id: '', qty_per_service: '', is_variable: false, addon_id: '' });
  });
  const unitOf = (id: string) => items.find((i: any) => i.id === id)?.unit || '';
  return (
    <div className="mt-5 space-y-4">
      {err && <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{err}</p>}
      <div className="rounded-xl border border-[#e8dccf] p-3">
        <div className="text-xs font-bold text-[#3d3128] mb-2">Add-ons</div>
        {addons.map((a: any) => (
          <div key={a.id} className="flex items-center justify-between gap-2 py-1 text-xs border-b border-[#f0e9df] last:border-0">
            <span><b>{a.name}</b> · +{a.extra_duration_min} min · +{money(a.extra_price)}</span>
            {canEdit && <button className={BTN_GHOST} onClick={() => run(() => api(`/spa/addons/${a.id}`, { method: 'PATCH', body: JSON.stringify({ is_active: 0 }) }))}>Remove</button>}
          </div>
        ))}
        {!addons.length && <p className="text-[11px] text-[#9c8e85]">No add-ons.</p>}
        {canEdit && (
          <div className="grid grid-cols-[1fr_5rem_5rem_auto] gap-2 mt-2">
            <input className={INPUT} placeholder="Add-on, e.g. Herbal steam" value={newAddon.name} onChange={e => setNewAddon({ ...newAddon, name: e.target.value })} />
            <input className={INPUT} type="number" min={0} placeholder="+min" value={newAddon.extra_duration_min} onChange={e => setNewAddon({ ...newAddon, extra_duration_min: e.target.value })} />
            <input className={INPUT} type="number" min={0} placeholder="+₹" value={newAddon.extra_price} onChange={e => setNewAddon({ ...newAddon, extra_price: e.target.value })} />
            <button className={BTN_GHOST} onClick={addAddon}><Plus size={13} /></button>
          </div>
        )}
      </div>
      <div className="rounded-xl border border-[#e8dccf] p-3">
        <div className="text-xs font-bold text-[#3d3128] mb-1">Consumables</div>
        <p className="text-[11px] text-[#6b5d52] mb-2">Pre-filled at Finish for the therapist to confirm. Mark an item as varying when the amount has to be entered every time.</p>
        {cons.map((c: any) => (
          <div key={c.id} className="grid grid-cols-[1fr_6rem_auto_auto] gap-2 items-center py-1 text-xs border-b border-[#f0e9df] last:border-0">
            <span><b>{c.ingredient_name || c.ingredient_id}</b>{c.addon_name ? <span className="text-[#6b5d52]"> · with {c.addon_name}</span> : null}</span>
            {canEdit
              ? <input className={INPUT} type="number" min={0} step="any" defaultValue={c.qty_per_service} disabled={!!c.is_variable}
                  onBlur={e => { const v = Number(e.target.value); if (v !== Number(c.qty_per_service)) run(() => api(`/spa/consumables/${c.id}`, { method: 'PATCH', body: JSON.stringify({ qty_per_service: v }) })); }} />
              : <span className="tabular-nums">{c.is_variable ? 'varies' : `${c.qty_per_service} ${c.unit || c.ingredient_unit || ''}`}</span>}
            <label className="flex items-center gap-1 text-[11px]"><input type="checkbox" disabled={!canEdit} checked={!!c.is_variable}
              onChange={e => run(() => api(`/spa/consumables/${c.id}`, { method: 'PATCH', body: JSON.stringify({ is_variable: e.target.checked ? 1 : 0, ...(e.target.checked ? {} : { qty_per_service: Number(c.qty_per_service) > 0 ? Number(c.qty_per_service) : 1 }) }) }))} /> varies</label>
            {canDel ? <button className={`${BTN} bg-rose-50 text-rose-600 hover:bg-rose-100`} aria-label="Remove item" onClick={() => run(() => api(`/spa/consumables/${c.id}`, { method: 'DELETE' }))}><Trash2 size={12} /></button> : <span />}
          </div>
        ))}
        {!cons.length && <p className="text-[11px] text-[#9c8e85]">No consumables — Finish will draw no stock for this treatment.</p>}
        {canEdit && (
          <div className="grid grid-cols-2 sm:grid-cols-[1fr_6rem_auto_1fr_auto] gap-2 mt-2 items-center">
            <select className={INPUT} value={newCon.ingredient_id} onChange={e => setNewCon({ ...newCon, ingredient_id: e.target.value })}>
              <option value="">Item used…</option>
              {items.map((i: any) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}
            </select>
            <input className={INPUT} type="number" min={0} step="any" placeholder={newCon.is_variable ? 'varies' : `qty ${unitOf(newCon.ingredient_id)}`} disabled={newCon.is_variable} value={newCon.qty_per_service} onChange={e => setNewCon({ ...newCon, qty_per_service: e.target.value })} />
            <label className="flex items-center gap-1 text-[11px]"><input type="checkbox" checked={newCon.is_variable} onChange={e => setNewCon({ ...newCon, is_variable: e.target.checked })} /> varies</label>
            <select className={INPUT} value={newCon.addon_id} onChange={e => setNewCon({ ...newCon, addon_id: e.target.value })}>
              <option value="">For the treatment</option>
              {addons.map((a: any) => <option key={a.id} value={a.id}>With {a.name}</option>)}
            </select>
            <button className={BTN_GHOST} onClick={addCon}><Plus size={13} /></button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Finishing a treatment: who performed it, the cabin used, what it used —
 *  pre-filled from the treatment's standard, with the batch to draw first — and
 *  notes, outcome and follow-up. Used by Appointments and the therapist's dashboard. */
export function SpaFinishDialog({ restaurantId, token, appt, onClose, onDone }: { restaurantId: string; token: string; appt: any; onClose: () => void; onDone: () => void }) {
  const api = makeApi(restaurantId, token);
  const [plan, setPlan] = useState<any>(null);
  const [loadError, setLoadError] = useState('');
  const [therapists, setTherapists] = useState<any[]>([]);
  const [cabins, setCabins] = useState<any[]>([]);
  const [performers, setPerformers] = useState<string[]>([]);
  const [resourceId, setResourceId] = useState('');
  const [lines, setLines] = useState<Record<string, { qty: string; batch_id: string }>>({});
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [followDate, setFollowDate] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const p = await api(`/spa/appointments/${appt.id}/finish-plan`);
        setPlan(p);
        setPerformers(p.booked_therapist_ids || []);
        setResourceId(p.booked_resource_id || '');
        setLines(Object.fromEntries((p.consumables || []).map((c: any) => [c.ingredient_id, { qty: c.is_variable ? '' : String(c.standard_qty), batch_id: '' }])));
      } catch (e: any) { setLoadError(e.message || 'This treatment could not be loaded.'); }
      try { setTherapists(await api('/spa/therapists')); } catch { /* booked therapists still named */ }
      try { setCabins(await api('/spa/resources')); } catch { /* cabin list stays empty */ }
    })();
  }, [appt.id]);
  const shown = therapists.filter((t: any) => Number(t.is_active ?? 1) === 1 || performers.includes(t.id));
  const toggle = (id: string) => setPerformers(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);
  const submit = async () => {
    setError('');
    if (!performers.length) { setError('Choose at least one therapist who performed the treatment.'); return; }
    for (const c of (plan?.consumables || [])) {
      if (c.is_variable && !(lines[c.ingredient_id]?.qty ?? '').toString().trim()) { setError(`Enter how much ${c.name} was used.`); return; }
    }
    setBusy(true);
    try {
      await api(`/spa/appointments/${appt.id}/complete`, { method: 'POST', body: JSON.stringify({
        performers, resource_id: resourceId || null, outcome: outcome || null, notes, follow_up: followUp, follow_up_date: followDate || null,
        consumables: (plan?.consumables || []).map((c: any) => {
          const l = lines[c.ingredient_id] || { qty: '', batch_id: '' };
          return { ingredient_id: c.ingredient_id, qty: String(l.qty).trim() === '' ? undefined : Number(l.qty), batch_id: l.batch_id || undefined };
        }),
      }) });
      onDone();
    } catch (e: any) { setError(e.message || 'The treatment could not be finished.'); } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <h3 className="text-xl font-bold font-serif mb-1 text-[#14110c]">Finish treatment</h3>
        <p className="text-xs text-[#6b5d52] mb-4">{appt.service_name} · {appt.client_name || 'Guest'}{plan?.started_at ? ` · started ${spaTs(plan.started_at).slice(11)}` : ''}</p>
        {loadError ? <p className="text-sm text-rose-700 mb-3">{loadError}</p> : !plan ? <p className="text-sm text-[#6b5d52] mb-3">Loading…</p> : (
          <>
            <label className={LABEL}>Performed by</label>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {shown.map((t: any) => (
                <button key={t.id} type="button" onClick={() => toggle(t.id)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border ${performers.includes(t.id) ? 'bg-brand text-white border-brand' : 'bg-white border-[#e8dccf] text-[#3d3128]'}`}>{t.display_name}</button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div><label className={LABEL}>Cabin used</label>
                <select className={INPUT} value={resourceId} onChange={e => setResourceId(e.target.value)}>
                  <option value="">No cabin</option>
                  {cabins.filter((c: any) => Number(c.is_active ?? 1) === 1 || c.id === resourceId).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select></div>
              <div><label className={LABEL}>Outcome</label>
                <select className={INPUT} value={outcome} onChange={e => setOutcome(e.target.value)}>
                  <option value="">Not recorded</option>
                  {Object.entries(SPA_OUTCOME_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select></div>
            </div>
            <label className={LABEL}>Consumables used</label>
            {!(plan.consumables || []).length ? <p className="text-[11px] text-[#9c8e85] mb-3">This treatment has no consumables set up, so no stock is drawn.</p> : (
              <div className="overflow-x-auto mb-3">
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-[#6b5d52] border-b border-[#e8dccf]"><th className="py-1.5 pr-2">Item</th><th className="py-1.5 pr-2 text-right">Standard</th><th className="py-1.5 pr-2">Used</th><th className="py-1.5">Draw first from</th></tr></thead>
                  <tbody>
                    {plan.consumables.map((c: any) => {
                      const l = lines[c.ingredient_id] || { qty: '', batch_id: '' };
                      return (
                        <tr key={c.ingredient_id} className="border-b border-[#f0e9df] align-top">
                          <td className="py-1.5 pr-2 font-semibold">{c.name}
                            {c.is_variable && <span className="block text-[10px] font-normal text-amber-700">varies — enter the amount</span>}
                            {c.unit_problem && <span className="block text-[10px] font-normal text-rose-700">{c.unit_problem}</span>}</td>
                          <td className="py-1.5 pr-2 text-right tabular-nums whitespace-nowrap">{c.is_variable && !c.standard_qty ? '—' : `${c.standard_qty} ${c.unit}`}</td>
                          <td className="py-1.5 pr-2"><div className="flex items-center gap-1">
                            <input className={`${INPUT} w-24`} type="number" min={0} step="any" value={l.qty} onChange={e => setLines({ ...lines, [c.ingredient_id]: { ...l, qty: e.target.value } })} />
                            <span className="text-[#6b5d52]">{c.unit}</span></div></td>
                          <td className="py-1.5">
                            <select className={INPUT} value={l.batch_id} onChange={e => setLines({ ...lines, [c.ingredient_id]: { ...l, batch_id: e.target.value } })}>
                              <option value="">{(c.batches || []).length ? 'Oldest batch first' : 'No batch in stock'}</option>
                              {(c.batches || []).map((bt: any) => <option key={bt.id} value={bt.id}>{bt.batch_number || 'Batch'} · {Number(bt.remaining_qty)} {c.unit} left{bt.expiry_date ? ` · exp ${String(bt.expiry_date).slice(0, 10)}` : ''}</option>)}
                            </select></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <label className={LABEL}>Notes</label>
            <textarea className={`${INPUT} mb-3`} rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="How the treatment went; anything to note for next time" />
            <div className="grid grid-cols-3 gap-3 mb-3">
              <div className="col-span-2"><label className={LABEL}>Follow-up advice</label><input className={INPUT} value={followUp} onChange={e => setFollowUp(e.target.value)} placeholder="e.g. Rest; repeat in 3 days" /></div>
              <div><label className={LABEL}>Follow-up on</label><input className={INPUT} type="date" value={followDate} onChange={e => setFollowDate(e.target.value)} /></div>
            </div>
          </>
        )}
        {error && <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mb-3">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className={BTN_GHOST} onClick={onClose}>Cancel</button>
          <button className={BTN_PRIMARY} disabled={busy || !plan} onClick={submit}><Check size={14} /> {busy ? 'Finishing…' : 'Finish treatment'}</button>
        </div>
      </div>
    </div>
  );
}

/** The record of a finished treatment; its notes, outcome and follow-up can be put right. */
function SpaSessionDialog({ restaurantId, token, appt, onClose }: { restaurantId: string; token: string; appt: any; onClose: () => void }) {
  const api = makeApi(restaurantId, token);
  const canEdit = canWriteTab('SPA_APPOINTMENTS');
  const [s, setS] = useState<any>(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({ notes: '', outcome: '', follow_up: '', follow_up_date: '' });
  const [note, setNote] = useState('');
  const load = async () => {
    try {
      const r = await api(`/spa/appointments/${appt.id}/session`);
      setS(r); setForm({ notes: r.notes || '', outcome: r.outcome || '', follow_up: r.follow_up || '', follow_up_date: r.follow_up_date || '' });
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, [appt.id]);
  const save = async () => {
    setErr(''); setNote('');
    try { await api(`/spa/appointments/${appt.id}/session`, { method: 'PUT', body: JSON.stringify({ ...form, outcome: form.outcome || null, follow_up_date: form.follow_up_date || null }) }); setNote('Saved'); await load(); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <h3 className="text-xl font-bold font-serif mb-1 text-[#14110c]">Treatment record</h3>
        <p className="text-xs text-[#6b5d52] mb-4">{appt.service_name} · {appt.client_name || 'Guest'}</p>
        {!s ? <p className="text-sm text-[#6b5d52]">{err || 'Loading…'}</p> : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[12px] mb-4">
              <div><span className="text-[#9c8e85] block">Started</span><b>{spaTs(s.started_at)}</b></div>
              <div><span className="text-[#9c8e85] block">Finished</span><b>{spaTs(s.finished_at)}</b></div>
              <div><span className="text-[#9c8e85] block">Cabin used</span><b>{s.resource_name || '—'}</b></div>
              <div><span className="text-[#9c8e85] block">Performed by</span><b>{(s.performers || []).map((p: any) => `${p.display_name || p.therapist_id}${p.role === 'ASSIST' ? ' (assisting)' : ''}`).join(', ') || '—'}</b></div>
            </div>
            <div className="text-xs font-bold text-[#3d3128] mb-1">Consumables used</div>
            {!(s.consumables || []).length ? <p className="text-[11px] text-[#9c8e85] mb-4">None.</p> : (
              <div className="overflow-x-auto mb-4">
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-[#6b5d52] border-b border-[#e8dccf]"><th className="py-1.5 pr-2">Item</th><th className="py-1.5 pr-2 text-right">Standard</th><th className="py-1.5 pr-2 text-right">Used</th><th className="py-1.5">Batches</th></tr></thead>
                  <tbody>
                    {s.consumables.map((c: any) => (
                      <tr key={c.ingredient_id} className="border-b border-[#f0e9df]">
                        <td className="py-1.5 pr-2 font-semibold">{c.ingredient_name || c.ingredient_id}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{Number(c.standard_qty)} {c.unit}</td>
                        <td className={`py-1.5 pr-2 text-right tabular-nums ${Number(c.actual_qty) !== Number(c.standard_qty) ? 'text-amber-700 font-semibold' : ''}`}>{Number(c.actual_qty)} {c.unit}</td>
                        <td className="py-1.5 text-[#6b5d52]">{(c.batches || []).map((b: any) => `${b.batch_number || (b.batch_id ? 'batch' : 'no batch')} ${Number(b.qty)}`).join(' · ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(s.tips || []).length > 0 && <p className="text-xs text-[#3d3128] mb-4">Tip shared: {s.tips.map((t: any) => `${t.display_name || t.therapist_id} ${money(t.amount)}`).join(' · ')}</p>}
            <label className={LABEL}>Notes</label>
            <textarea className={`${INPUT} mb-3`} rows={2} disabled={!canEdit} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
              <div><label className={LABEL}>Outcome</label>
                <select className={INPUT} disabled={!canEdit} value={form.outcome} onChange={e => setForm({ ...form, outcome: e.target.value })}>
                  <option value="">Not recorded</option>
                  {Object.entries(SPA_OUTCOME_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select></div>
              <div className="sm:col-span-2"><label className={LABEL}>Follow-up advice</label><input className={INPUT} disabled={!canEdit} value={form.follow_up} onChange={e => setForm({ ...form, follow_up: e.target.value })} /></div>
              <div><label className={LABEL}>Follow-up on</label><input className={INPUT} type="date" disabled={!canEdit} value={form.follow_up_date} onChange={e => setForm({ ...form, follow_up_date: e.target.value })} /></div>
            </div>
            {err && <p className="text-xs text-rose-700 mb-2">{err}</p>}
          </>
        )}
        <div className="flex justify-end items-center gap-2">
          {note && <span className="text-[11px] font-semibold text-emerald-700 mr-auto">{note}</span>}
          <button className={BTN_GHOST} onClick={onClose}>Close</button>
          {s && canEdit && <button className={BTN_PRIMARY} onClick={save}><Check size={14} /> Save</button>}
        </div>
      </div>
    </div>
  );
}

/** Trace a batch of a spa item to every treatment and guest it went into. */
function SpaBatchTrace({ restaurantId, token, items }: { restaurantId: string; token: string; items: any[] }) {
  const api = makeApi(restaurantId, token);
  const [itemId, setItemId] = useState('');
  const [batches, setBatches] = useState<any[]>([]);
  const [trace, setTrace] = useState<any>(null);
  const [err, setErr] = useState('');
  const pickItem = async (id: string) => {
    setItemId(id); setTrace(null); setErr(''); setBatches([]);
    if (!id) return;
    try { const r = await api(`/spa/batch-trace?ingredient_id=${id}`); setBatches(r.batches || []); } catch (e: any) { setErr(e.message); }
  };
  const openBatch = async (bid: string) => { setErr(''); try { setTrace(await api(`/spa/batch-trace?batch_id=${bid}`)); } catch (e: any) { setErr(e.message); } };
  return (
    <div className={`${CARD} mt-4`}>
      <h3 className="font-bold text-[#14110c] mb-1">Trace a batch</h3>
      <p className="text-xs text-[#6b5d52] mb-3">Pick an item to see its batches, then open a batch to list every treatment and guest it went into — for a recall or a guest's reaction.</p>
      <select className={`${INPUT} max-w-md mb-3`} value={itemId} onChange={e => pickItem(e.target.value)}>
        <option value="">Choose an item…</option>
        {items.map((i: any) => <option key={i.id} value={i.id}>{i.name}</option>)}
      </select>
      {err && <p className="text-xs text-rose-700 mb-2">{err}</p>}
      {itemId && (
        <DataTable data={batches} rowKey={(r: any) => r.id} exportFilename="spa-item-batches" emptyMessage="No batches received for this item."
          columns={[
            { key: 'batch_number', label: 'Batch', render: (r: any) => <span className="font-semibold">{r.batch_number || '—'}</span> },
            { key: 'supplier_name', label: 'Supplier' },
            { key: 'received_at', label: 'Received', render: (r: any) => String(r.received_at || '').slice(0, 10), exportValue: (r: any) => String(r.received_at || '').slice(0, 10) },
            { key: 'expiry_date', label: 'Expiry', render: (r: any) => r.expiry_date ? String(r.expiry_date).slice(0, 10) : '—', exportValue: (r: any) => r.expiry_date ? String(r.expiry_date).slice(0, 10) : '' },
            { key: 'qty_received', label: 'Received qty', render: (r: any) => `${Number(r.qty_received)} ${r.unit}` },
            { key: 'remaining_qty', label: 'Left', render: (r: any) => `${Number(r.remaining_qty)} ${r.unit}` },
            { key: 'used_on_treatments', label: 'Used on treatments', render: (r: any) => `${Number(r.used_on_treatments)} ${r.unit}` },
            { key: 'treatments', label: 'Treatments' },
            { key: '_t', label: '', noExport: true, render: (r: any) => <button className={BTN_GHOST} onClick={() => openBatch(r.id)}>Trace</button> },
          ]} />
      )}
      {trace && (
        <div className="mt-4">
          <p className="text-sm font-semibold text-[#14110c] mb-2">Batch {trace.batch?.batch_number || trace.batch?.id} of {trace.batch?.ingredient_name}: {trace.treatments} treatment(s), {trace.guests} guest(s)</p>
          <DataTable data={trace.uses || []} rowKey={(r: any, i: number) => `${r.appointment_id}-${i}`} exportFilename={`batch-trace-${trace.batch?.batch_number || trace.batch?.id}`} emptyMessage="No treatment has used this batch."
            columns={[
              { key: 'start_at', label: 'When', render: (r: any) => spaTs(r.start_at), exportValue: (r: any) => spaTs(r.start_at) },
              { key: 'client_name', label: 'Guest', render: (r: any) => <span className="font-semibold">{r.client_name || 'Guest'}</span> },
              { key: 'client_phone', label: 'Phone' },
              { key: 'service_name', label: 'Treatment' },
              { key: 'therapist_name', label: 'Therapist' },
              { key: 'qty', label: 'Used', render: (r: any) => `${Number(r.qty)} ${trace.batch?.ingredient_unit || ''}` },
              { key: 'status', label: 'Status', render: (r: any) => <Pill status={r.status} /> },
            ]} />
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// GUEST RECORD (Phase 4) — details, consent, packages; the timeline of every
// treatment and purchase; and the health record for clinical staff.
// ════════════════════════════════════════════════════════════════════════
const SPA_EVENT_LABEL: Record<string, string> = {
  TREATMENT: 'Treatment', PACKAGE_BOUGHT: 'Package bought', PACKAGE_REDEEMED: 'Package session used', MEMBERSHIP: 'Membership',
  PURCHASE: 'Purchase', CONSENT: 'Consent', INTAKE: 'Health intake', ASSESSMENT: 'Assessment', COURSE_PLAN: 'Course plan', CLINICAL_NOTE: 'Clinical note',
};
const spaConstitutionLabel = (c: string) => c === 'TRIDOSHIC' ? 'Tridoshic' : String(c || '').split('_').map(x => x ? x[0] + x.slice(1).toLowerCase() : x).join('–');

/** The health record: intake, assessment, course plans, clinical notes and who read it. */
function SpaHealthRecord({ restaurantId, token, clientId }: { restaurantId: string; token: string; clientId: string }) {
  const api = makeApi(restaurantId, token);
  const [rec, setRec] = useState<any>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [services, setServices] = useState<any[]>([]);
  const [intake, setIntake] = useState({ conditions: [] as string[], allergies: '', medications: '', notes: '' });
  const [asm, setAsm] = useState({ constitution: '', notes: '' });
  const blankPlan = { title: '', start_date: '', end_date: '', items: [{ service_id: '', sessions_prescribed: '3', frequency_note: '' }] };
  const [plan, setPlan] = useState<any>(blankPlan);
  const [soap, setSoap] = useState({ soap_subjective: '', soap_objective: '', soap_assessment: '', soap_plan: '' });
  const load = async () => { try { setRec(await api(`/spa/clients/${clientId}/clinical`)); } catch (e: any) { setErr(e.message); } };
  useEffect(() => { load(); (async () => { try { setServices(await api('/spa/services')); } catch { /* the plan form lists none */ } })(); }, [clientId]);
  const run = async (fn: () => Promise<any>, done: string) => { setErr(''); setNote(''); try { await fn(); setNote(done); await load(); } catch (e: any) { setErr(e.message); } };
  if (!rec) return <p className="text-sm text-[#6b5d52] py-4">{err || 'Loading…'}</p>;
  const condLabel = (c: string) => (rec.conditions || []).find((x: any) => x.code === c)?.label || c;
  const latestIntake = (rec.forms || []).find((f: any) => f.form_type === 'INTAKE' || f.form_type === 'MEDICAL_HISTORY');
  const canWrite = !!rec.can_write;
  return (
    <div className="space-y-4">
      {err && <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{err}</p>}
      {note && <p className="text-xs text-emerald-700">{note}</p>}
      <p className="text-[11px] text-[#9c8e85]">Health information. Your viewing is logged.</p>

      <section>
        <h4 className="text-sm font-bold mb-1">Health intake</h4>
        {latestIntake ? (
          <div className="text-xs rounded-lg border border-[#e8dccf] p-2.5 mb-2">
            <div className="text-[#9c8e85] mb-1">Recorded {spaTs(latestIntake.created_at)}</div>
            <div><b>Conditions:</b> {(latestIntake.responses?.conditions || []).map(condLabel).join(', ') || 'none recorded'}</div>
            {latestIntake.responses?.allergies && <div><b>Allergies:</b> {latestIntake.responses.allergies}</div>}
            {latestIntake.responses?.medications && <div><b>Medications:</b> {latestIntake.responses.medications}</div>}
            {latestIntake.responses?.notes && <div><b>Notes:</b> {latestIntake.responses.notes}</div>}
          </div>
        ) : <p className="text-xs text-[#9c8e85] mb-2">No intake on file.</p>}
        {canWrite && (
          <div className="rounded-lg border border-dashed border-[#e8dccf] p-2.5">
            <div className="flex flex-wrap gap-1 mb-2">
              {(rec.conditions || []).map((c: any) => { const on = intake.conditions.includes(c.code); return (
                <button key={c.code} type="button" onClick={() => setIntake({ ...intake, conditions: on ? intake.conditions.filter(x => x !== c.code) : [...intake.conditions, c.code] })}
                  className={`px-2 py-0.5 rounded-md text-[10px] font-semibold border ${on ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-white text-[#6b5d52] border-[#e8dccf]'}`}>{c.label}</button>); })}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input className={INPUT} placeholder="Allergies" value={intake.allergies} onChange={e => setIntake({ ...intake, allergies: e.target.value })} />
              <input className={INPUT} placeholder="Medications" value={intake.medications} onChange={e => setIntake({ ...intake, medications: e.target.value })} />
              <input className={`${INPUT} col-span-2`} placeholder="Other notes" value={intake.notes} onChange={e => setIntake({ ...intake, notes: e.target.value })} />
            </div>
            <div className="flex justify-end mt-2"><button className={BTN_PRIMARY} onClick={() => run(async () => { await api(`/spa/clients/${clientId}/forms`, { method: 'POST', body: JSON.stringify({ form_type: 'INTAKE', responses: intake }) }); setIntake({ conditions: [], allergies: '', medications: '', notes: '' }); }, 'Intake recorded')}>Record intake</button></div>
          </div>
        )}
      </section>

      <section>
        <h4 className="text-sm font-bold mb-1">Constitution</h4>
        {(rec.assessments || []).slice(0, 3).map((a: any) => <div key={a.id} className="text-xs"><b>{spaConstitutionLabel(a.constitution)}</b> · {spaTs(a.assessed_at)}{a.notes ? ` · ${a.notes}` : ''}</div>)}
        {!(rec.assessments || []).length && <p className="text-xs text-[#9c8e85]">Not assessed.</p>}
        {canWrite && (
          <div className="grid grid-cols-[10rem_1fr_auto] gap-2 mt-2">
            <select className={INPUT} value={asm.constitution} onChange={e => setAsm({ ...asm, constitution: e.target.value })}>
              <option value="">Constitution…</option>
              {(rec.constitutions || []).map((c: string) => <option key={c} value={c}>{spaConstitutionLabel(c)}</option>)}
            </select>
            <input className={INPUT} placeholder="Observations" value={asm.notes} onChange={e => setAsm({ ...asm, notes: e.target.value })} />
            <button className={BTN_GHOST} disabled={!asm.constitution} onClick={() => run(async () => { await api(`/spa/clients/${clientId}/assessments`, { method: 'POST', body: JSON.stringify(asm) }); setAsm({ constitution: '', notes: '' }); }, 'Assessment recorded')}>Record</button>
          </div>
        )}
      </section>

      <section>
        <h4 className="text-sm font-bold mb-1">Course plans</h4>
        {(rec.plans || []).map((p: any) => (
          <div key={p.id} className="text-xs rounded-lg border border-[#e8dccf] p-2.5 mb-2">
            <div className="flex items-center justify-between gap-2">
              <span><b>{p.title}</b> · {p.start_date || '—'}{p.end_date ? ` to ${p.end_date}` : ''} · <span className="uppercase text-[10px]">{p.status}</span></span>
              {canWrite && p.status === 'ACTIVE' && <button className={BTN_GHOST} onClick={() => run(() => api(`/spa/course-plans/${p.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'COMPLETED' }) }), 'Course plan completed')}>Mark completed</button>}
            </div>
            {(p.items || []).map((it: any) => <div key={it.id} className="text-[#3d3128]">{it.service_name}: {Number(it.sessions_done)} of {it.sessions_prescribed} done{Number(it.sessions_booked) ? `, ${Number(it.sessions_booked)} booked` : ''}{it.frequency_note ? ` · ${it.frequency_note}` : ''}</div>)}
          </div>
        ))}
        {!(rec.plans || []).length && <p className="text-xs text-[#9c8e85] mb-2">No course plans.</p>}
        {canWrite && (
          <div className="rounded-lg border border-dashed border-[#e8dccf] p-2.5">
            <div className="grid grid-cols-3 gap-2 mb-2">
              <input className={`${INPUT} col-span-3`} placeholder="Plan title, e.g. 7-day Abhyanga course" value={plan.title} onChange={e => setPlan({ ...plan, title: e.target.value })} />
              <input className={INPUT} type="date" value={plan.start_date} onChange={e => setPlan({ ...plan, start_date: e.target.value })} />
              <input className={INPUT} type="date" value={plan.end_date} onChange={e => setPlan({ ...plan, end_date: e.target.value })} />
            </div>
            {plan.items.map((it: any, i: number) => (
              <div key={i} className="grid grid-cols-[1fr_5rem_1fr_auto] gap-2 mb-1.5">
                <select className={INPUT} value={it.service_id} onChange={e => setPlan({ ...plan, items: plan.items.map((x: any, j: number) => j === i ? { ...x, service_id: e.target.value } : x) })}>
                  <option value="">Treatment…</option>
                  {services.filter((s: any) => Number(s.is_active ?? 1) === 1).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input className={INPUT} type="number" min={1} max={60} value={it.sessions_prescribed} onChange={e => setPlan({ ...plan, items: plan.items.map((x: any, j: number) => j === i ? { ...x, sessions_prescribed: e.target.value } : x) })} />
                <input className={INPUT} placeholder="How often" value={it.frequency_note} onChange={e => setPlan({ ...plan, items: plan.items.map((x: any, j: number) => j === i ? { ...x, frequency_note: e.target.value } : x) })} />
                <button className={`${BTN} bg-rose-50 text-rose-600`} aria-label="Remove treatment" onClick={() => setPlan({ ...plan, items: plan.items.filter((_: any, j: number) => j !== i) })}><X size={12} /></button>
              </div>
            ))}
            <div className="flex justify-between mt-2">
              <button className={BTN_GHOST} onClick={() => setPlan({ ...plan, items: [...plan.items, { service_id: '', sessions_prescribed: '3', frequency_note: '' }] })}><Plus size={12} /> Treatment</button>
              <button className={BTN_PRIMARY} onClick={() => run(async () => { await api(`/spa/clients/${clientId}/course-plans`, { method: 'POST', body: JSON.stringify({ ...plan, start_date: plan.start_date || null, end_date: plan.end_date || null, items: plan.items.map((x: any) => ({ ...x, sessions_prescribed: Number(x.sessions_prescribed) })) }) }); setPlan(blankPlan); }, 'Course plan prescribed')}>Prescribe plan</button>
            </div>
          </div>
        )}
      </section>

      <section>
        <h4 className="text-sm font-bold mb-1">Clinical notes</h4>
        {(rec.notes || []).map((n: any) => (
          <div key={n.id} className="text-xs rounded-lg border border-[#e8dccf] p-2.5 mb-2">
            <div className="flex items-center justify-between gap-2 text-[#9c8e85] mb-1">
              <span>{spaTs(n.created_at)}{n.service_name ? ` · ${n.service_name}` : ''}{n.locked_at ? ' · locked' : ''}</span>
              {canWrite && !n.locked_at && <button className={BTN_GHOST} onClick={() => run(() => api(`/spa/clinical-notes/${n.id}/lock`, { method: 'POST' }), 'Note locked')}>Lock</button>}
            </div>
            {n.soap_subjective && <div><b>S:</b> {n.soap_subjective}</div>}
            {n.soap_objective && <div><b>O:</b> {n.soap_objective}</div>}
            {n.soap_assessment && <div><b>A:</b> {n.soap_assessment}</div>}
            {n.soap_plan && <div><b>P:</b> {n.soap_plan}</div>}
          </div>
        ))}
        {!(rec.notes || []).length && <p className="text-xs text-[#9c8e85] mb-2">No clinical notes.</p>}
        {canWrite && (
          <div className="rounded-lg border border-dashed border-[#e8dccf] p-2.5 grid grid-cols-2 gap-2">
            <textarea className={INPUT} rows={2} placeholder="Subjective — what the guest reports" value={soap.soap_subjective} onChange={e => setSoap({ ...soap, soap_subjective: e.target.value })} />
            <textarea className={INPUT} rows={2} placeholder="Objective — what you observed" value={soap.soap_objective} onChange={e => setSoap({ ...soap, soap_objective: e.target.value })} />
            <textarea className={INPUT} rows={2} placeholder="Assessment" value={soap.soap_assessment} onChange={e => setSoap({ ...soap, soap_assessment: e.target.value })} />
            <textarea className={INPUT} rows={2} placeholder="Plan" value={soap.soap_plan} onChange={e => setSoap({ ...soap, soap_plan: e.target.value })} />
            <div className="col-span-2 flex justify-end"><button className={BTN_PRIMARY} onClick={() => run(async () => { await api(`/spa/clients/${clientId}/clinical-notes`, { method: 'POST', body: JSON.stringify(soap) }); setSoap({ soap_subjective: '', soap_objective: '', soap_assessment: '', soap_plan: '' }); }, 'Note added')}>Add note</button></div>
          </div>
        )}
      </section>

      {Array.isArray(rec.access_log) && (
        <section>
          <h4 className="text-sm font-bold mb-1">Who has read this record</h4>
          <div className="max-h-40 overflow-auto text-[11px]">
            {rec.access_log.map((l: any) => <div key={l.id} className="py-0.5 border-b border-[#f0e9df]">{spaTs(l.created_at)} · {l.actor_email || l.actor_id || 'unknown'} ({l.actor_role || '—'}) · {String(l.section || '').toLowerCase().replace(/_/g, ' ')}</div>)}
            {!rec.access_log.length && <p className="text-[#9c8e85]">No reads logged yet.</p>}
          </div>
        </section>
      )}
    </div>
  );
}

/** The guest record: details and consent, the timeline, and the health record. */
function SpaClientRecord({ restaurantId, token, clientId, packages, memberships, onClose }: { restaurantId: string; token: string; clientId: string; packages: any[]; memberships: any[]; onClose: () => void }) {
  const api = makeApi(restaurantId, token);
  const canEdit = canWriteTab('SPA_CLIENTS');
  const [tab, setTab] = useState<'OVERVIEW' | 'TIMELINE' | 'HEALTH'>('OVERVIEW');
  const [profile, setProfile] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  const [editLoaded, setEditLoaded] = useState<any>(null);
  const [consent, setConsent] = useState({ signed_by_name: '', agreed: false });
  const [timeline, setTimeline] = useState<any>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const load = async () => {
    try {
      const p = await api(`/spa/clients/${clientId}`);
      setProfile(p);
      // Gender is stored as F, M, FEMALE or MALE; shown as Female or Male.
      const g = String(p.client.gender || '').toUpperCase();
      const v = { name: p.client.name || '', phone: p.client.phone || '', email: p.client.email || '',
        gender: g === 'F' || g === 'FEMALE' ? 'FEMALE' : g === 'M' || g === 'MALE' ? 'MALE' : '',
        dob: String(p.client.dob || '').slice(0, 10), preferences: p.client.preferences || '', notes: p.client.notes || '' };
      setEdit(v); setEditLoaded(v);
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, [clientId]);
  const run = async (fn: () => Promise<any>, done: string) => { setErr(''); setNote(''); try { await fn(); setNote(done); await load(); } catch (e: any) { setErr(e.message); } };
  const openTimeline = async () => { setTab('TIMELINE'); setErr(''); try { setTimeline(await api(`/spa/clients/${clientId}/timeline`)); } catch (e: any) { setErr(e.message); } };
  const printTimeline = () => {
    if (!timeline) return;
    const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (c: string) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);
    const rows = (timeline.events || []).map((e: any) => {
      const s = e.session;
      const who = s ? (s.performers || []).map((p: any) => p.display_name).join(', ') : (e.booked?.therapist || '');
      const used = s ? (s.consumables || []).map((c: any) => `${c.item} ${Number(c.actual_qty)} ${c.unit || ''}${(c.batches || []).length ? ` (batch ${c.batches.map((b: any) => b.batch_number || '—').join(', ')})` : ''}`).join('; ') : '';
      return `<tr><td>${esc(spaTs(e.at))}</td><td>${esc(SPA_EVENT_LABEL[e.kind] || e.kind)}</td><td><b>${esc(e.title)}</b>${who ? `<br>${esc(who)}${s?.cabin ? ` · ${esc(s.cabin)}` : ''}` : ''}${used ? `<br>${esc(used)}` : ''}${s?.follow_up ? `<br>Follow-up: ${esc(s.follow_up)}` : ''}${e.detail ? `<br>${esc(e.detail)}` : ''}</td><td>${esc(e.invoice?.invoice_number || e.invoice_number || '')}</td></tr>`;
    }).join('');
    const w = window.open('', '_blank');
    if (!w) { setErr('Allow pop-ups for this site to print the timeline.'); return; }
    w.document.write(`<html><head><title>${esc(timeline.client?.name)} — treatment history</title><style>body{font:12px system-ui,sans-serif;margin:24px;color:#14110c}h2{margin:0 0 4px}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}th{font-size:11px;color:#6b5d52}</style></head><body><h2>${esc(timeline.client?.name)}</h2><div>${esc(timeline.client?.phone || '')} ${esc(timeline.client?.email || '')}</div><table><thead><tr><th>When</th><th>What</th><th>Details</th><th>Invoice</th></tr></thead><tbody>${rows}</tbody></table></body></html>`);
    w.document.close(); w.focus(); w.print();
  };
  const sell = (path: string, body: any, done: string) => run(() => api(`/spa/clients/${clientId}/${path}`, { method: 'POST', body: JSON.stringify(body) }), done);
  // Only what changed is sent, so a field nobody touched is never rewritten.
  const saveDetails = () => {
    const changed: any = {};
    for (const k of Object.keys(edit || {})) if (edit[k] !== editLoaded?.[k]) changed[k] = edit[k] === '' ? null : edit[k];
    if (!Object.keys(changed).length) { setErr(''); setNote('Nothing has changed.'); return; }
    if (changed.name !== undefined && !String(changed.name || '').trim()) { setNote(''); setErr("Enter the guest's name."); return; }
    run(() => api(`/spa/clients/${clientId}`, { method: 'PATCH', body: JSON.stringify(changed) }), 'Details saved');
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 w-full max-w-3xl max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        {!profile ? <p className="text-sm text-[#6b5d52]">{err || 'Loading…'}</p> : (
          <>
            <h3 className="text-xl font-bold font-serif text-[#14110c]">{profile.client.name}</h3>
            <p className="text-xs text-[#6b5d52] mb-3">{profile.client.phone || 'no phone'}{profile.client.email ? ` · ${profile.client.email}` : ''}</p>
            <div className="flex gap-2 mb-4 flex-wrap">
              <button className={tab === 'OVERVIEW' ? BTN_PRIMARY : BTN_GHOST} onClick={() => setTab('OVERVIEW')}>Overview</button>
              <button className={tab === 'TIMELINE' ? BTN_PRIMARY : BTN_GHOST} onClick={openTimeline}>Timeline</button>
              {profile.clinical_access && <button className={tab === 'HEALTH' ? BTN_PRIMARY : BTN_GHOST} onClick={() => setTab('HEALTH')}>Health record</button>}
            </div>
            {err && <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mb-3">{err}</p>}
            {note && <p className="text-xs text-emerald-700 mb-3">{note}</p>}

            {tab === 'OVERVIEW' && edit && (
              <div className="grid sm:grid-cols-2 gap-5">
                <div>
                  <h4 className="text-sm font-bold mb-2">Details</h4>
                  <div className="grid grid-cols-2 gap-2">
                    <input className={`${INPUT} col-span-2`} disabled={!canEdit} value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} placeholder="Name" />
                    <input className={INPUT} disabled={!canEdit} value={edit.phone} onChange={e => setEdit({ ...edit, phone: e.target.value })} placeholder="Phone" />
                    <input className={INPUT} disabled={!canEdit} value={edit.email} onChange={e => setEdit({ ...edit, email: e.target.value })} placeholder="Email" />
                    <select className={INPUT} disabled={!canEdit} value={edit.gender} onChange={e => setEdit({ ...edit, gender: e.target.value })}>
                      <option value="">Gender not recorded</option><option value="FEMALE">Female</option><option value="MALE">Male</option>
                    </select>
                    <input className={INPUT} type="date" disabled={!canEdit} value={edit.dob} onChange={e => setEdit({ ...edit, dob: e.target.value })} />
                    <input className={`${INPUT} col-span-2`} disabled={!canEdit} value={edit.preferences} onChange={e => setEdit({ ...edit, preferences: e.target.value })} placeholder="Preferences, e.g. light pressure, warm oil" />
                    <input className={`${INPUT} col-span-2`} disabled={!canEdit} value={edit.notes} onChange={e => setEdit({ ...edit, notes: e.target.value })} placeholder="Notes" />
                  </div>
                  {canEdit && <div className="flex justify-end mt-2"><button className={BTN_PRIMARY} onClick={saveDetails}><Check size={13} /> Save</button></div>}
                  <h4 className="text-sm font-bold mt-4 mb-1">Consent and intake</h4>
                  <div className="text-xs space-y-0.5">
                    <div>Consent: {profile.forms_summary?.consent_on ? `signed ${spaTs(profile.forms_summary.consent_on)}${profile.forms_summary.consent_signed_by ? ` by ${profile.forms_summary.consent_signed_by}` : ''}` : <span className="text-amber-700">not signed</span>}</div>
                    <div>Health intake: {profile.forms_summary?.intake_on ? `recorded ${spaTs(profile.forms_summary.intake_on)}` : <span className="text-amber-700">not on file</span>}</div>
                  </div>
                  {canEdit && (
                    <div className="rounded-lg border border-dashed border-[#e8dccf] p-2.5 mt-2">
                      <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={consent.agreed} onChange={e => setConsent({ ...consent, agreed: e.target.checked })} /> The guest has read the treatment information and agrees to the treatments, including warm oil and herbal preparations.</label>
                      <div className="flex gap-2 mt-2">
                        <input className={INPUT} placeholder="Name of the person signing" value={consent.signed_by_name} onChange={e => setConsent({ ...consent, signed_by_name: e.target.value })} />
                        <button className={BTN_GHOST} disabled={!consent.agreed || !consent.signed_by_name.trim()} onClick={() => run(async () => { await api(`/spa/clients/${clientId}/forms`, { method: 'POST', body: JSON.stringify({ form_type: 'CONSENT', signed_by_name: consent.signed_by_name.trim(), responses: { agreed: true } }) }); setConsent({ signed_by_name: '', agreed: false }); }, 'Consent recorded')}>Record consent</button>
                      </div>
                    </div>
                  )}
                </div>
                <div>
                  <h4 className="text-sm font-bold mb-2">Packages</h4>
                  <div className="space-y-1.5 mb-2">
                    {profile.packages.map((p: any) => <div key={p.id} className="text-xs rounded-lg border border-[#e8dccf] p-2">{p.package_name} — {p.sessions_remaining}/{p.sessions_total} left <span className="text-[10px]">({p.status})</span></div>)}
                    {!profile.packages.length && <p className="text-xs text-[#6b5d52]">None.</p>}
                  </div>
                  {canWriteTab('SPA_PACKAGES') && <select className={INPUT} onChange={e => e.target.value && sell('packages', { package_id: e.target.value, payment_method: 'CASH' }, 'Package sold')} value="">
                    <option value="">+ Sell a package…</option>
                    {packages.map((p: any) => <option key={p.id} value={p.id}>{p.name} — {money(p.price)}</option>)}
                  </select>}
                  <h4 className="text-sm font-bold mb-2 mt-3">Memberships</h4>
                  <div className="space-y-1.5 mb-2">
                    {profile.memberships.map((m: any) => <div key={m.id} className="text-xs rounded-lg border border-[#e8dccf] p-2">{m.plan_name} <span className="text-[10px]">({m.status})</span></div>)}
                    {!profile.memberships.length && <p className="text-xs text-[#6b5d52]">None.</p>}
                  </div>
                  {canWriteTab('SPA_PACKAGES') && <select className={INPUT} onChange={e => e.target.value && sell('memberships', { plan_id: e.target.value, payment_method: 'CASH' }, 'Membership started')} value="">
                    <option value="">+ Subscribe membership…</option>
                    {memberships.map((m: any) => <option key={m.id} value={m.id}>{m.name} — {money(m.monthly_fee)}/mo</option>)}
                  </select>}
                  <h4 className="text-sm font-bold mb-2 mt-3">Recent visits</h4>
                  <div className="space-y-1.5 max-h-40 overflow-auto">
                    {profile.history.slice(0, 10).map((h: any) => <div key={h.id} className="text-xs rounded-lg border border-[#e8dccf] p-2">{spaTs(h.start_at)} · {h.service_name} <Pill status={h.status} /></div>)}
                    {!profile.history.length && <p className="text-xs text-[#6b5d52]">No visits yet.</p>}
                  </div>
                </div>
              </div>
            )}

            {tab === 'TIMELINE' && (
              !timeline ? <p className="text-sm text-[#6b5d52]">Loading…</p> : (
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <p className="text-[11px] text-[#9c8e85]">Treatment records start from when treatments were first finished through the Finish screen.</p>
                    <button className={BTN_GHOST} onClick={printTimeline}><FileText size={12} /> Print</button>
                  </div>
                  <div className="space-y-2">
                    {(timeline.events || []).map((e: any, i: number) => (
                      <div key={i} className="rounded-lg border border-[#e8dccf] p-2.5 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span><span className="text-[10px] uppercase tracking-wide text-[#9c8e85] mr-2">{SPA_EVENT_LABEL[e.kind] || e.kind}</span><b>{e.title}</b></span>
                          <span className="text-[#6b5d52] whitespace-nowrap">{spaTs(e.at)}</span>
                        </div>
                        {e.kind === 'TREATMENT' && (
                          <div className="mt-1 text-[#3d3128] space-y-0.5">
                            <div>{e.session ? `Performed by ${(e.session.performers || []).map((p: any) => `${p.display_name}${p.role === 'ASSIST' ? ' (assisting)' : ''}`).join(', ') || '—'}` : `Booked with ${e.booked?.therapist || '—'}`}{(e.session?.cabin || e.booked?.cabin) ? ` · ${e.session?.cabin || e.booked?.cabin}` : ''} · <Pill status={e.status} /></div>
                            {e.session && <div>{spaTs(e.session.started_at)} to {spaTs(e.session.finished_at)}{e.session.outcome ? ` · ${SPA_OUTCOME_LABEL[e.session.outcome] || e.session.outcome}` : ''}</div>}
                            {e.session?.consumables?.length > 0 && <div>Used: {e.session.consumables.map((c: any) => `${c.item} ${Number(c.actual_qty)} ${c.unit || ''}${(c.batches || []).length ? ` (batch ${c.batches.map((b: any) => b.batch_number || '—').join(', ')})` : ''}`).join('; ')}</div>}
                            {e.session?.follow_up && <div>Follow-up: {e.session.follow_up}{e.session.follow_up_date ? ` on ${e.session.follow_up_date}` : ''}</div>}
                            {e.session?.notes && <div className="text-[#6b5d52]">Notes: {e.session.notes}</div>}
                            {e.invoice && <div>Invoice {e.invoice.invoice_number} · {money(e.invoice.grand_total)}</div>}
                            {e.charged_to_room && <div>Charged to the room bill</div>}
                          </div>
                        )}
                        {e.kind !== 'TREATMENT' && (e.detail || e.invoice_number || e.amount) && <div className="mt-1 text-[#3d3128]">{[e.detail, e.amount ? money(e.amount) : null, e.invoice_number ? `Invoice ${e.invoice_number}` : null].filter(Boolean).join(' · ')}</div>}
                      </div>
                    ))}
                    {!(timeline.events || []).length && <p className="text-sm text-[#6b5d52]">Nothing yet.</p>}
                  </div>
                </div>
              )
            )}

            {tab === 'HEALTH' && profile.clinical_access && <SpaHealthRecord restaurantId={restaurantId} token={token} clientId={clientId} />}
          </>
        )}
        <div className="flex justify-end mt-5"><button className={BTN_GHOST} onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

const SPA_LEVEL_LABEL: Record<string, string> = { TRAINEE: 'Trainee', QUALIFIED: 'Qualified', SENIOR: 'Senior' };
const SPA_LEVEL_RANK: Record<string, number> = { TRAINEE: 1, QUALIFIED: 2, SENIOR: 3 };
const SPA_GENDER_LABEL: Record<string, string> = { FEMALE: 'Female', MALE: 'Male', OTHER: 'Other' };
const CABIN_STATUS: Record<string, { label: string; cls: string }> = {
  AVAILABLE: { label: 'Available', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  CLEANING: { label: 'Cleaning', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  MAINTENANCE: { label: 'Maintenance', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  OUT_OF_ORDER: { label: 'Out of order', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
};
const SPA_IMPORT_HELP: Record<'therapists' | 'cabins', { head: string; note: string; example: string }> = {
  therapists: {
    head: 'name,gender,phone,languages,skills',
    note: 'Skills as Name:level, separated by semicolons — level is trainee, qualified or senior.',
    example: 'name,gender,phone,languages,skills\nLakshmi Nair,female,9800000001,"Malayalam, English",Abhyanga:senior;Shirodhara:qualified',
  },
  cabins: {
    head: 'name,type,capacity,turnaround,equipment',
    note: 'Type as a cabin type code or name; turnaround in minutes.',
    example: 'name,type,capacity,turnaround,equipment\nDroni Room 1,ABHYANGA_DRONI,1,15,Teak droni and oil warmer',
  },
};

/** Reads pasted CSV into rows keyed by the header row. Quoted fields may hold
 *  commas and doubled quotes. */
function parseSpaCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  const src = String(text || '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const filled = rows.filter(r => r.some(x => x.trim() !== ''));
  if (filled.length < 2) return [];
  const head = filled[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return filled.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** A held skill that does not count today: the certificate has expired, or the
 *  skill needs a certificate and none is on file. Mirrors the slot engine. */
const skillLapsed = (s: any, today: string) =>
  (!!s?.valid_until && String(s.valid_until).slice(0, 10) < today) || (Number(s?.requires_certification) === 1 && !s?.certified_on);

function SpaResources({ restaurantId, token }: Props) {
  const api = makeApi(restaurantId, token);
  const toast = useToast();
  const confirmDlg = useConfirm();
  const [history, setHistory] = useState<any>(null); // History window for a therapist or cabin
  const canEdit = canWriteTab('SPA_RESOURCES');
  const canDel = canDeleteTab('SPA_RESOURCES');
  const [tab, setTab] = useState<'CABINS' | 'THERAPISTS' | 'SETUP'>('CABINS');
  const [resources, setResources] = useState<any[]>([]);
  const [therapists, setTherapists] = useState<any[]>([]);
  const [services, setServices] = useState<any[]>([]);
  const [skillList, setSkillList] = useState<any[]>([]);
  const [cabinTypes, setCabinTypes] = useState<any[]>([]);
  const [staffOptions, setStaffOptions] = useState<any[]>([]);
  const [newCabin, setNewCabin] = useState('');
  const [newTher, setNewTher] = useState('');
  const [schedTher, setSchedTher] = useState<any>(null);
  const [schedules, setSchedules] = useState<any[]>([]);
  // Treatments a therapist is ticked for — used for a treatment that names no skills.
  const [svcSkills, setSvcSkills] = useState<string[]>([]);
  // Skills the therapist holds: skill id → level and certificate dates.
  const [held, setHeld] = useState<Record<string, any>>({});
  const [heldAtOpen, setHeldAtOpen] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const blankShift = { weekday: '1', start_time: '09:00', end_time: '18:00', break_start: '', break_end: '', effective_from: '', effective_to: '' };
  const [sched, setSched] = useState<any>(blankShift);
  const [profile, setProfile] = useState<any>(null);
  const [cabinEdit, setCabinEdit] = useState<any>(null);
  // Finding a therapist: by name, a skill (at a minimum level), gender and language.
  const [find, setFind] = useState({ q: '', skill: '', level: '', gender: '', lang: '' });
  const [newSkill, setNewSkill] = useState({ name: '', requires_certification: false });
  const [newType, setNewType] = useState({ name: '', description: '' });
  const [starter, setStarter] = useState<any>(null);
  const [importKind, setImportKind] = useState<'therapists' | 'cabins'>('therapists');
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<any>(null);
  // Deactivated cabins and therapists are hidden until asked for, and marked when shown.
  const [showInactive, setShowInactive] = useState(false);
  const isOn = (x: any) => Number(x?.is_active ?? 1) === 1;
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = istToday();
  const viewOnly = (what: string) => { toast.error(`View-only access — you cannot ${what}.`); };

  const load = async () => {
    const fail = (what: string, e: any) => toast.error(`Could not load ${what}: ${e?.message || 'error'}`);
    try { setResources(await api('/spa/resources')); } catch (e: any) { fail('the cabins', e); }
    try { setTherapists(await api('/spa/therapists')); } catch (e: any) { fail('the therapists', e); }
    try { setServices(await api('/spa/services')); } catch (e: any) { fail('the treatments', e); }
    try { setSkillList(await api('/spa/skills')); } catch (e: any) { fail('the skills', e); }
    try { setCabinTypes(await api('/spa/cabin-types')); } catch (e: any) { fail('the cabin types', e); }
  };
  useEffect(() => { load(); }, []);

  const addCabin = async () => { if (!canEdit) { viewOnly('add cabins'); return; } if (!newCabin) return; try { await api('/spa/resources', { method: 'POST', body: JSON.stringify({ name: newCabin }) }); setNewCabin(''); await load(); } catch (e: any) { toast.error(e.message); } };
  const addTher = async () => { if (!canEdit) { viewOnly('add therapists'); return; } if (!newTher) return; try { await api('/spa/therapists', { method: 'POST', body: JSON.stringify({ display_name: newTher }) }); setNewTher(''); await load(); } catch (e: any) { toast.error(e.message); } };

  const openSched = async (t: any) => {
    setSchedTher(t); setSched(blankShift); setNote('');
    try { setSchedules(await api(`/spa/therapists/${t.id}/schedules`)); } catch { setSchedules([]); }
    try { const sk = await api(`/spa/therapists/${t.id}/services`); setSvcSkills(sk.map((x: any) => x.service_id)); } catch { setSvcSkills([]); }
    try {
      const hs = await api(`/spa/therapists/${t.id}/skills`);
      setHeld(Object.fromEntries(hs.map((h: any) => [h.skill_id, { level: h.level || 'QUALIFIED', certified_on: h.certified_on || '', valid_until: h.valid_until || '' }])));
      setHeldAtOpen(hs.map((h: any) => String(h.skill_id)));
    } catch { setHeld({}); setHeldAtOpen([]); }
  };
  const addSched = async () => {
    if (!canEdit) { viewOnly('change schedules'); return; }
    const body: any = { weekday: Number(sched.weekday), start_time: sched.start_time, end_time: sched.end_time };
    for (const k of ['break_start', 'break_end', 'effective_from', 'effective_to']) if (sched[k]) body[k] = sched[k];
    try {
      await api(`/spa/therapists/${schedTher.id}/schedules`, { method: 'POST', body: JSON.stringify(body) });
      setSchedules(await api(`/spa/therapists/${schedTher.id}/schedules`));
    } catch (e: any) { toast.error(e.message); }
  };
  const removeSched = async (id: string) => {
    if (!canDel) { viewOnly('remove shifts'); return; }
    if (!(await confirmDlg({ title: 'Remove this shift?', confirmLabel: 'Remove', danger: true }))) return;
    try { await api(`/spa/schedules/${id}`, { method: 'DELETE' }); setSchedules(await api(`/spa/therapists/${schedTher.id}/schedules`)); } catch (e: any) { toast.error(e.message); }
  };
  const toggleSvc = async (sid: string) => {
    if (!canEdit) { viewOnly('change the treatments a therapist delivers'); return; }
    const next = svcSkills.includes(sid) ? svcSkills.filter(s => s !== sid) : [...svcSkills, sid];
    setSvcSkills(next);
    try { await api(`/spa/therapists/${schedTher.id}/services`, { method: 'POST', body: JSON.stringify({ service_ids: next }) }); } catch (e: any) { toast.error(e.message); }
  };
  const saveHeld = async () => {
    if (!canEdit) { viewOnly('change skills'); return; }
    const skills = Object.entries(held).map(([skill_id, h]: [string, any]) => ({ skill_id, level: h.level, certified_on: h.certified_on || null, valid_until: h.valid_until || null }));
    try {
      await api(`/spa/therapists/${schedTher.id}/skills`, { method: 'PUT', body: JSON.stringify({ skills }) });
      setNote('Skills saved');
      await load();
    } catch (e: any) { setNote(''); toast.error(e.message); }
  };

  const openProfile = async (t: any) => {
    setProfile({ id: t.id, display_name: t.display_name || '', gender: t.gender || '', languages: t.languages || '', phone: t.phone || '', photo_url: t.photo_url || '', staff_id: t.staff_id || '', bio: t.bio || '', max_treatments_per_day: t.max_treatments_per_day == null ? '' : String(t.max_treatments_per_day), is_active: isOn(t) });
    if (!staffOptions.length) { try { setStaffOptions(await api('/spa/staff-options')); } catch { /* */ } }
  };
  const saveProfile = async () => {
    if (!canEdit) { viewOnly('change therapist profiles'); return; }
    if (!String(profile.display_name).trim()) { toast.error('Give the therapist a name.'); return; }
    const { id, ...body } = profile;
    try {
      await api(`/spa/therapists/${id}`, { method: 'PATCH', body: JSON.stringify({ ...body, display_name: String(body.display_name).trim(), staff_id: body.staff_id || null, is_active: body.is_active ? 1 : 0 }) });
      setProfile(null); await load();
    } catch (e: any) { toast.error(e.message); }
  };

  const openCabin = (r: any) => setCabinEdit({
    id: r.id, name: r.name || '', cabin_type_id: r.cabin_type_id || '', equipment: r.equipment || '', capacity: String(r.capacity ?? 1),
    turnaround_min: String(r.turnaround_min ?? 0), gender_designation: String(r.gender_designation || 'ANY').toUpperCase(), status: String(r.status || 'AVAILABLE').toUpperCase(), status_reason: r.status_reason || '', notes: r.notes || '', is_active: isOn(r),
  });
  const saveCabin = async () => {
    if (!canEdit) { viewOnly('change cabins'); return; }
    if (!String(cabinEdit.name).trim()) { toast.error('Give the cabin a name.'); return; }
    const { id, ...body } = cabinEdit;
    try {
      await api(`/spa/resources/${id}`, { method: 'PATCH', body: JSON.stringify({
        ...body, name: String(body.name).trim(), capacity: Number(body.capacity || 1), turnaround_min: Number(body.turnaround_min || 0),
        status_reason: body.status === 'AVAILABLE' ? '' : body.status_reason, is_active: body.is_active ? 1 : 0,
      }) });
      setCabinEdit(null); await load();
    } catch (e: any) { toast.error(e.message); }
  };

  const previewStarter = async () => { try { setStarter(await api('/spa/setup/ayurveda-starter', { method: 'POST', body: JSON.stringify({ dry_run: true }) })); } catch (e: any) { toast.error(e.message); } };
  const applyStarter = async () => {
    if (!canEdit) { viewOnly('add the starter pack'); return; }
    try { const r = await api('/spa/setup/ayurveda-starter', { method: 'POST', body: JSON.stringify({ dry_run: false }) }); setStarter(r); await load(); } catch (e: any) { toast.error(e.message); }
  };
  const addSkill = async () => {
    if (!canEdit) { viewOnly('add skills'); return; }
    if (newSkill.name.trim().length < 2) return;
    try { await api('/spa/skills', { method: 'POST', body: JSON.stringify({ ...newSkill, name: newSkill.name.trim() }) }); setNewSkill({ name: '', requires_certification: false }); await load(); } catch (e: any) { toast.error(e.message); }
  };
  const patchSkill = async (id: string, body: any) => { if (!canEdit) { viewOnly('change skills'); return; } try { await api(`/spa/skills/${id}`, { method: 'PATCH', body: JSON.stringify(body) }); await load(); } catch (e: any) { toast.error(e.message); } };
  const addType = async () => {
    if (!canEdit) { viewOnly('add cabin types'); return; }
    if (newType.name.trim().length < 2) return;
    try { await api('/spa/cabin-types', { method: 'POST', body: JSON.stringify({ ...newType, name: newType.name.trim() }) }); setNewType({ name: '', description: '' }); await load(); } catch (e: any) { toast.error(e.message); }
  };
  const patchType = async (id: string, body: any) => { if (!canEdit) { viewOnly('change cabin types'); return; } try { await api(`/spa/cabin-types/${id}`, { method: 'PATCH', body: JSON.stringify(body) }); await load(); } catch (e: any) { toast.error(e.message); } };
  const runImport = async (dry: boolean) => {
    if (!canEdit) { viewOnly('import'); return; }
    const rows = parseSpaCsv(csv);
    if (!rows.length) { toast.error('Paste a header row and at least one row below it.'); return; }
    try { const r = await api(`/spa/import/${importKind}`, { method: 'POST', body: JSON.stringify({ rows, dry_run: dry }) }); setPreview(r); if (!dry) await load(); } catch (e: any) { toast.error(e.message); }
  };

  const shownTherapists = therapists.filter(t => showInactive || isOn(t)).filter(t => {
    if (find.q && !String(t.display_name || '').toLowerCase().includes(find.q.trim().toLowerCase())) return false;
    if (find.gender && String(t.gender || '') !== find.gender) return false;
    if (find.lang && !String(t.languages || '').toLowerCase().includes(find.lang.trim().toLowerCase())) return false;
    if (find.skill) {
      const h = (t.skills || []).find((s: any) => s.skill_id === find.skill);
      if (!h || skillLapsed(h, today)) return false;
      if (find.level && (SPA_LEVEL_RANK[String(h.level).toUpperCase()] || 0) < SPA_LEVEL_RANK[find.level]) return false;
    }
    return true;
  });
  const statusOf = (r: any) => CABIN_STATUS[String(r.status || 'AVAILABLE').toUpperCase()] || CABIN_STATUS.AVAILABLE;
  // What Show inactive counts and reveals on the tab in view.
  const inactivePool: any[] = tab === 'CABINS' ? resources : tab === 'THERAPISTS' ? therapists : [...skillList, ...cabinTypes];
  const shownSkills = skillList.filter(s => showInactive || isOn(s));
  const shownTypes = cabinTypes.filter(c => showInactive || isOn(c));
  // Skills in a therapist's window: active ones, and any they held when it opened.
  const modalSkills = skillList.filter(s => isOn(s) || !!held[s.id] || heldAtOpen.includes(String(s.id)));

  return (
    <div>
      <SectionHeader icon={<DoorOpen size={18} />} title="Therapists & Cabins" sub="Who can give which therapy, in which cabin, and when" />
      <div className="flex gap-2 mb-4 flex-wrap">
        {([['CABINS', 'Treatment Cabins'], ['THERAPISTS', 'Therapists'], ['SETUP', 'Skills & Cabin Types']] as const).map(([k, label]) => (
          <button key={k} className={tab === k ? BTN_PRIMARY : BTN_GHOST} onClick={() => setTab(k)}>{label}</button>
        ))}
        {inactivePool.some(x => !isOn(x)) && (
          <button className={`${BTN_GHOST} ml-auto`} onClick={() => setShowInactive(v => !v)}>
            {showInactive ? 'Hide inactive' : `Show inactive (${inactivePool.filter(x => !isOn(x)).length})`}
          </button>
        )}
      </div>

      {tab === 'CABINS' && (
        <div className={CARD}>
          {canEdit && <div className="flex gap-2 mb-4">
            <input className={INPUT} placeholder="New cabin name" value={newCabin} onChange={e => setNewCabin(e.target.value)} />
            <button className={BTN_PRIMARY} onClick={addCabin}><Plus size={14} /> Add</button>
          </div>}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {resources.filter(r => showInactive || isOn(r)).map(r => (
              <div key={r.id} className={`rounded-xl border border-[#e8dccf] p-3 flex flex-col gap-1.5 ${isOn(r) ? '' : 'opacity-60'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-sm break-words">{r.name}</div>
                    <div className="text-[11px] text-[#6b5d52]">{r.cabin_type_name || 'No cabin type'}{Number(r.turnaround_min || 0) > 0 ? ` · ${r.turnaround_min} min turnaround` : ''}{String(r.gender_designation || '').toUpperCase() === 'FEMALE' ? ' · female guests only' : String(r.gender_designation || '').toUpperCase() === 'MALE' ? ' · male guests only' : ''}</div>
                  </div>
                  {isOn(r)
                    ? <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap ${statusOf(r).cls}`}>{statusOf(r).label}</span>
                    : <span className="text-[10px] text-[#6b5d52]">Inactive</span>}
                </div>
                {isOn(r) && r.status_reason && String(r.status || 'AVAILABLE').toUpperCase() !== 'AVAILABLE' && <div className="text-[11px] text-[#6b5d52]">{r.status_reason}</div>}
                {r.equipment && <div className="text-[11px] text-[#3d3128]">{r.equipment}</div>}
                <div className="flex justify-end gap-2 mt-auto"><button className={BTN_GHOST} title="Who changed this cabin, and what is booked in it" onClick={() => setHistory({ kind: 'SPA_CABIN', id: r.id, meta: { title: r.name } })}><History size={13} /> History</button>{canEdit && <button className={BTN_GHOST} onClick={() => openCabin(r)}>Edit</button>}</div>
              </div>
            ))}
            {!resources.filter(r => showInactive || isOn(r)).length && <p className="text-sm text-[#6b5d52] col-span-full">No cabins yet.</p>}
          </div>
        </div>
      )}

      {tab === 'THERAPISTS' && (
        <div className={CARD}>
          {canEdit && <div className="flex gap-2 mb-4">
            <input className={INPUT} placeholder="New therapist name" value={newTher} onChange={e => setNewTher(e.target.value)} />
            <button className={BTN_PRIMARY} onClick={addTher}><Plus size={14} /> Add</button>
          </div>}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
            <input className={INPUT} placeholder="Search by name" value={find.q} onChange={e => setFind({ ...find, q: e.target.value })} />
            <select className={INPUT} value={find.skill} onChange={e => setFind({ ...find, skill: e.target.value, level: e.target.value ? find.level : '' })}>
              <option value="">Any skill</option>
              {skillList.filter(isOn).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select className={INPUT} value={find.level} disabled={!find.skill} onChange={e => setFind({ ...find, level: e.target.value })}>
              <option value="">Any level</option>
              <option value="QUALIFIED">Qualified or senior</option>
              <option value="SENIOR">Senior only</option>
            </select>
            <select className={INPUT} value={find.gender} onChange={e => setFind({ ...find, gender: e.target.value })}>
              <option value="">Any gender</option>
              <option value="FEMALE">Female</option>
              <option value="MALE">Male</option>
              <option value="OTHER">Other</option>
            </select>
            <input className={INPUT} placeholder="Language" value={find.lang} onChange={e => setFind({ ...find, lang: e.target.value })} />
          </div>
          <div className="space-y-2">
            {shownTherapists.map(t => (
              <div key={t.id} className={`rounded-xl border border-[#e8dccf] p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${isOn(t) ? '' : 'opacity-60'}`}>
                <div className="min-w-0">
                  <div className="font-semibold text-sm flex items-center gap-2 flex-wrap">
                    <User size={14} className="text-brand" /> {t.display_name}
                    {t.gender && <span className="text-[10px] font-normal text-[#6b5d52]">{SPA_GENDER_LABEL[t.gender] || t.gender}</span>}
                    {t.languages && <span className="text-[10px] font-normal text-[#6b5d52]">· {t.languages}</span>}
                    {Number(t.max_treatments_per_day || 0) > 0 && <span className="text-[10px] font-normal text-[#6b5d52]">· up to {t.max_treatments_per_day} a day</span>}
                    {!isOn(t) && <span className="text-[10px] font-normal text-[#6b5d52]">Inactive</span>}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {(t.skills || []).map((s: any) => {
                      const lapsed = skillLapsed(s, today);
                      const why = !lapsed ? undefined : (s.valid_until && String(s.valid_until).slice(0, 10) < today ? `Certificate expired ${String(s.valid_until).slice(0, 10)}` : 'Needs a certificate on file');
                      return (
                        <span key={s.skill_id} title={why}
                          className={`px-2 py-0.5 rounded-md text-[10px] font-semibold border ${lapsed ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-[#faf7f2] text-[#3d3128] border-[#e8dccf]'}`}>
                          {s.name} · {SPA_LEVEL_LABEL[String(s.level).toUpperCase()] || s.level}{lapsed ? ' · not valid' : ''}
                        </span>
                      );
                    })}
                    {!(t.skills || []).length && <span className="text-[11px] text-[#9c8e85]">No skills recorded</span>}
                  </div>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button className={BTN_GHOST} onClick={() => openProfile(t)}><User size={13} /> Profile</button>
                  <button className={BTN_GHOST} onClick={() => openSched(t)}><Clock size={13} /> Schedule & Skills</button>
                  <button className={BTN_GHOST} title="Who changed this therapist, and where they are booked" onClick={() => setHistory({ kind: 'SPA_THERAPIST', id: t.id, meta: { title: t.display_name } })}><History size={13} /> History</button>
                </div>
              </div>
            ))}
            {!shownTherapists.length && <p className="text-sm text-[#6b5d52]">{therapists.some(t => showInactive || isOn(t)) ? 'No therapist matches these filters.' : 'No therapists yet.'}</p>}
          </div>
        </div>
      )}

      {tab === 'SETUP' && (
        <div className="space-y-4">
          {canEdit && (
            <div className={CARD}>
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div>
                  <h3 className="font-bold text-[#14110c] flex items-center gap-2"><Award size={16} className="text-brand" /> Ayurveda starter pack</h3>
                  <p className="text-xs text-[#6b5d52] mt-1 max-w-xl">Thirteen therapy skills — Abhyanga, Pizhichil, Njavarakizhi, Shirodhara, Udvartana and more — and seven cabin types, from the droni cabin to the herbal steam room. Skills and cabin types already on file are kept as they are.</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button className={BTN_GHOST} onClick={previewStarter}>Preview</button>
                  {starter?.dry_run && (Number(starter.skills_created) + Number(starter.cabin_types_created)) > 0 && <button className={BTN_PRIMARY} onClick={applyStarter}><Plus size={14} /> Add them</button>}
                </div>
              </div>
              {starter && (
                <p className="text-xs mt-3 text-[#3d3128]">
                  {!starter.dry_run
                    ? `Added ${starter.skills_created} skills and ${starter.cabin_types_created} cabin types.`
                    : (Number(starter.skills_created) + Number(starter.cabin_types_created)) > 0
                      ? `Adds ${starter.skills_created} skills and ${starter.cabin_types_created} cabin types. ${Number(starter.skills_existing) + Number(starter.cabin_types_existing)} already on file stay as they are.`
                      : 'Everything in the starter pack is already on file.'}
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className={CARD}>
              <h3 className="font-bold text-[#14110c] mb-3">Skills</h3>
              {canEdit && (
                <div className="mb-3">
                  <div className="flex gap-2">
                    <input className={INPUT} placeholder="Skill name, e.g. Kati Dhara" value={newSkill.name} onChange={e => setNewSkill({ ...newSkill, name: e.target.value })} />
                    <button className={BTN_PRIMARY} onClick={addSkill}><Plus size={14} /> Add</button>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-[#3d3128] mt-2"><input type="checkbox" checked={newSkill.requires_certification} onChange={e => setNewSkill({ ...newSkill, requires_certification: e.target.checked })} /> A therapist needs a certificate on file for this skill</label>
                </div>
              )}
              <div className="divide-y divide-[#f0e9df]">
                {shownSkills.map(s => (
                  <div key={s.id} className={`py-2 flex items-center justify-between gap-2 ${isOn(s) ? '' : 'opacity-60'}`}>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold break-words">{s.name}</div>
                      <div className="text-[10px] text-[#6b5d52]">{s.code}{Number(s.requires_certification) === 1 ? ' · certificate needed' : ''}{isOn(s) ? '' : ' · inactive'}</div>
                    </div>
                    {canEdit && (
                      <div className="flex gap-1.5 shrink-0">
                        <button className={BTN_GHOST} onClick={() => patchSkill(s.id, { requires_certification: Number(s.requires_certification) === 1 ? 0 : 1 })}>{Number(s.requires_certification) === 1 ? 'No certificate' : 'Needs certificate'}</button>
                        <button className={BTN_GHOST} onClick={() => patchSkill(s.id, { is_active: isOn(s) ? 0 : 1 })}>{isOn(s) ? 'Deactivate' : 'Activate'}</button>
                      </div>
                    )}
                  </div>
                ))}
                {!shownSkills.length && <p className="text-sm text-[#6b5d52] py-2">No skills yet — add the starter pack or your own.</p>}
              </div>
            </div>

            <div className={CARD}>
              <h3 className="font-bold text-[#14110c] mb-3">Cabin types</h3>
              {canEdit && (
                <div className="mb-3 space-y-2">
                  <div className="flex gap-2">
                    <input className={INPUT} placeholder="Cabin type, e.g. Kizhi cabin" value={newType.name} onChange={e => setNewType({ ...newType, name: e.target.value })} />
                    <button className={BTN_PRIMARY} onClick={addType}><Plus size={14} /> Add</button>
                  </div>
                  <input className={INPUT} placeholder="What it has (optional)" value={newType.description} onChange={e => setNewType({ ...newType, description: e.target.value })} />
                </div>
              )}
              <div className="divide-y divide-[#f0e9df]">
                {shownTypes.map(c => (
                  <div key={c.id} className={`py-2 flex items-center justify-between gap-2 ${isOn(c) ? '' : 'opacity-60'}`}>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold break-words">{c.name}</div>
                      <div className="text-[10px] text-[#6b5d52]">{c.code}{c.description ? ` · ${c.description}` : ''}{isOn(c) ? '' : ' · inactive'}</div>
                    </div>
                    {canEdit && <button className={`${BTN_GHOST} shrink-0`} onClick={() => patchType(c.id, { is_active: isOn(c) ? 0 : 1 })}>{isOn(c) ? 'Deactivate' : 'Activate'}</button>}
                  </div>
                ))}
                {!shownTypes.length && <p className="text-sm text-[#6b5d52] py-2">No cabin types yet — add the starter pack or your own.</p>}
              </div>
            </div>
          </div>

          {canEdit && (
            <div className={CARD}>
              <h3 className="font-bold text-[#14110c] mb-1 flex items-center gap-2"><FileText size={16} className="text-brand" /> Import from a spreadsheet</h3>
              <p className="text-xs text-[#6b5d52] mb-3">Paste CSV with a header row. A row whose name matches a therapist or cabin on file updates it; any other row is added. Preview first — nothing is saved until you import.</p>
              <div className="flex gap-2 mb-2">
                {(['therapists', 'cabins'] as const).map(k => (
                  <button key={k} className={importKind === k ? BTN_PRIMARY : BTN_GHOST} onClick={() => { setImportKind(k); setPreview(null); }}>{k === 'therapists' ? 'Therapists' : 'Cabins'}</button>
                ))}
              </div>
              <p className="text-[11px] text-[#6b5d52] mb-1">Columns: <code className="text-[#3d3128]">{SPA_IMPORT_HELP[importKind].head}</code> — {SPA_IMPORT_HELP[importKind].note}</p>
              <textarea className={`${INPUT} font-mono text-xs`} rows={6} value={csv} placeholder={SPA_IMPORT_HELP[importKind].example} onChange={e => { setCsv(e.target.value); setPreview(null); }} />
              <div className="flex gap-2 mt-2">
                <button className={BTN_GHOST} onClick={() => runImport(true)}>Preview</button>
                {preview?.dry_run && (Number(preview.created) + Number(preview.updated)) > 0 && (
                  <button className={BTN_PRIMARY} onClick={() => runImport(false)}>Import {Number(preview.created) + Number(preview.updated)} row(s)</button>
                )}
              </div>
              {preview && (
                <div className="mt-3">
                  <p className="text-xs font-semibold text-[#3d3128] mb-2">
                    {preview.dry_run ? `Preview: ${preview.created} to add, ${preview.updated} to update, ${preview.skipped} skipped` : `Imported: ${preview.created} added, ${preview.updated} updated, ${preview.skipped} skipped`}
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead><tr className="text-left text-[#6b5d52] border-b border-[#e8dccf]"><th className="py-1.5 pr-3">Row</th><th className="py-1.5 pr-3">Name</th><th className="py-1.5 pr-3">Action</th><th className="py-1.5">Notes</th></tr></thead>
                      <tbody>
                        {(preview.rows || []).map((r: any) => (
                          <tr key={r.row} className="border-b border-[#f0e9df] align-top">
                            <td className="py-1.5 pr-3 tabular-nums">{r.row}</td>
                            <td className="py-1.5 pr-3 font-semibold">{r.name || '—'}</td>
                            <td className={`py-1.5 pr-3 font-bold ${r.action === 'SKIP' ? 'text-rose-600' : r.action === 'CREATE' ? 'text-emerald-700' : 'text-[#3d3128]'}`}>{r.action === 'CREATE' ? 'Add' : r.action === 'UPDATE' ? 'Update' : 'Skip'}</td>
                            <td className="py-1.5 text-[#6b5d52]">{[...(r.skills || []), ...(r.issues || [])].join(' · ') || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {schedTher && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setSchedTher(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-bold font-serif mb-1">{schedTher.display_name}</h3>
            <p className="text-xs text-[#6b5d52] mb-4">Weekly shifts, therapy skills, and the treatments they give</p>

            <h4 className="text-sm font-bold mb-2">Shifts</h4>
            {canEdit && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2 items-end">
                <div><label className={LABEL}>Day</label><select className={INPUT} value={sched.weekday} onChange={e => setSched({ ...sched, weekday: e.target.value })}>{DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}</select></div>
                <div><label className={LABEL}>From</label><input className={INPUT} type="time" value={sched.start_time} onChange={e => setSched({ ...sched, start_time: e.target.value })} /></div>
                <div><label className={LABEL}>To</label><input className={INPUT} type="time" value={sched.end_time} onChange={e => setSched({ ...sched, end_time: e.target.value })} /></div>
                <div><label className={LABEL}>Break from</label><input className={INPUT} type="time" value={sched.break_start} onChange={e => setSched({ ...sched, break_start: e.target.value })} /></div>
                <div><label className={LABEL}>Break to</label><input className={INPUT} type="time" value={sched.break_end} onChange={e => setSched({ ...sched, break_end: e.target.value })} /></div>
                <div><label className={LABEL}>Starts on</label><input className={INPUT} type="date" value={sched.effective_from} onChange={e => setSched({ ...sched, effective_from: e.target.value })} /></div>
                <div><label className={LABEL}>Ends on</label><input className={INPUT} type="date" value={sched.effective_to} onChange={e => setSched({ ...sched, effective_to: e.target.value })} /></div>
                <button className={BTN_PRIMARY} onClick={addSched}><Plus size={14} /> Add shift</button>
              </div>
            )}
            <div className="flex flex-wrap gap-1.5 mb-5">
              {schedules.map(s => (
                <span key={s.id} className="px-2 py-1 rounded-lg bg-[#faf7f2] border border-[#e8dccf] text-[11px] flex items-center gap-1.5">
                  {DOW[s.weekday]} {s.start_time}–{s.end_time}
                  {s.break_start ? ` · break ${s.break_start}–${s.break_end}` : ''}
                  {(s.effective_from || s.effective_to) ? ` · ${s.effective_from || 'from the start'} to ${s.effective_to || 'no end'}` : ''}
                  {canDel && <button onClick={() => removeSched(s.id)} className="text-rose-600 hover:text-rose-800" aria-label="Remove shift"><X size={11} /></button>}
                </span>
              ))}
              {!schedules.length && <span className="text-[11px] text-[#9c8e85]">No shifts — no slots are offered with this therapist.</span>}
            </div>

            <h4 className="text-sm font-bold mb-1">Therapy skills</h4>
            <p className="text-[11px] text-[#6b5d52] mb-2">A treatment that names skills is offered only with therapists who hold every one at the level it asks, with any certificate in date.</p>
            {modalSkills.length > 0 && <div className="hidden sm:grid grid-cols-4 gap-2 text-[10px] font-semibold text-[#9c8e85] uppercase tracking-wide pb-1"><span>Skill</span><span>Level</span><span>Certified on</span><span>Valid until</span></div>}
            <div className="divide-y divide-[#f0e9df] mb-2">
              {modalSkills.map(s => {
                const h = held[s.id];
                return (
                  <div key={s.id} className="py-1.5 grid grid-cols-2 sm:grid-cols-4 gap-2 items-center">
                    <label className="flex items-center gap-2 text-xs font-semibold text-[#3d3128]">
                      <input type="checkbox" disabled={!canEdit} checked={!!h} onChange={e => { const on = e.target.checked; setNote(''); setHeld(prev => { const n = { ...prev }; if (on) n[s.id] = { level: 'QUALIFIED', certified_on: '', valid_until: '' }; else delete n[s.id]; return n; }); }} />
                      <span>{s.name}{Number(s.requires_certification) === 1 && <span className="block text-[10px] font-normal text-[#9c8e85]">certificate needed</span>}</span>
                    </label>
                    {h ? (
                      <>
                        <select className={INPUT} disabled={!canEdit} value={h.level} onChange={e => { setNote(''); setHeld({ ...held, [s.id]: { ...h, level: e.target.value } }); }}>
                          {Object.entries(SPA_LEVEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                        <input className={INPUT} type="date" disabled={!canEdit} aria-label="Certified on" value={h.certified_on} onChange={e => { setNote(''); setHeld({ ...held, [s.id]: { ...h, certified_on: e.target.value } }); }} />
                        <input className={INPUT} type="date" disabled={!canEdit} aria-label="Valid until" value={h.valid_until} onChange={e => { setNote(''); setHeld({ ...held, [s.id]: { ...h, valid_until: e.target.value } }); }} />
                      </>
                    ) : <span className="sm:col-span-3" />}
                  </div>
                );
              })}
              {!modalSkills.length && <p className="text-[11px] text-[#9c8e85] py-1">No skills on file yet — add them under Skills & Cabin Types.</p>}
            </div>
            {canEdit && modalSkills.length > 0 && (
              <div className="flex items-center gap-2 mb-5">
                <button className={BTN_PRIMARY} onClick={saveHeld}><Check size={14} /> Save skills</button>
                {note && <span className="text-[11px] font-semibold text-emerald-700">{note}</span>}
              </div>
            )}

            <h4 className="text-sm font-bold mb-1">Treatments they give</h4>
            <p className="text-[11px] text-[#6b5d52] mb-2">Used for a treatment that names no skills.</p>
            <div className="flex flex-wrap gap-1.5">
              {/* Active treatments, plus any inactive one still assigned so it can be taken off. */}
              {services.filter(s => isOn(s) || svcSkills.includes(s.id)).map(s => (
                <button key={s.id} onClick={() => toggleSvc(s.id)} disabled={!canEdit}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border disabled:opacity-60 ${svcSkills.includes(s.id) ? 'bg-brand text-white border-brand' : 'bg-white border-[#e8dccf] text-[#3d3128]'}`}>
                  {s.name}{isOn(s) ? '' : ' (inactive)'}
                </button>
              ))}
            </div>
            <div className="flex justify-end mt-5"><button className={BTN_GHOST} onClick={() => setSchedTher(null)}>Done</button></div>
          </div>
        </div>
      )}

      {profile && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setProfile(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-bold font-serif mb-4">Therapist profile</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2"><label className={LABEL}>Name</label><input className={INPUT} disabled={!canEdit} value={profile.display_name} onChange={e => setProfile({ ...profile, display_name: e.target.value })} /></div>
              <div><label className={LABEL}>Gender</label>
                <select className={INPUT} disabled={!canEdit} value={profile.gender} onChange={e => setProfile({ ...profile, gender: e.target.value })}>
                  <option value="">Not recorded</option><option value="FEMALE">Female</option><option value="MALE">Male</option><option value="OTHER">Other</option>
                </select></div>
              <div><label className={LABEL}>Phone</label><input className={INPUT} disabled={!canEdit} value={profile.phone} onChange={e => setProfile({ ...profile, phone: e.target.value })} /></div>
              <div className="col-span-2"><label className={LABEL}>Languages</label><input className={INPUT} disabled={!canEdit} placeholder="Malayalam, Hindi, English" value={profile.languages} onChange={e => setProfile({ ...profile, languages: e.target.value })} /></div>
              <div className="col-span-2"><label className={LABEL}>Most treatments in a day <span className="font-normal text-[#9d8b7e]">(blank for no limit)</span></label><input className={INPUT} type="number" min={1} max={50} disabled={!canEdit} value={profile.max_treatments_per_day} onChange={e => setProfile({ ...profile, max_treatments_per_day: e.target.value })} /></div>
              <div className="col-span-2"><label className={LABEL}>Staff record <span className="font-normal text-[#9d8b7e]">(links attendance, payroll and their login)</span></label>
                <select className={INPUT} disabled={!canEdit} value={profile.staff_id} onChange={e => setProfile({ ...profile, staff_id: e.target.value })}>
                  <option value="">Not linked</option>
                  {staffOptions.map(s => <option key={s.id} value={s.id}>{s.name}{s.role ? ` · ${s.role}` : ''}</option>)}
                  {profile.staff_id && !staffOptions.some(s => s.id === profile.staff_id) && <option value={profile.staff_id}>Linked staff record (inactive or not listed)</option>}
                </select></div>
              <div className="col-span-2"><label className={LABEL}>Photo URL</label><input className={INPUT} disabled={!canEdit} value={profile.photo_url} onChange={e => setProfile({ ...profile, photo_url: e.target.value })} /></div>
              <div className="col-span-2"><label className={LABEL}>About</label><textarea className={INPUT} rows={2} disabled={!canEdit} value={profile.bio} onChange={e => setProfile({ ...profile, bio: e.target.value })} /></div>
              <label className="flex items-center gap-2 text-sm col-span-2"><input type="checkbox" disabled={!canEdit} checked={profile.is_active} onChange={e => setProfile({ ...profile, is_active: e.target.checked })} /> Active — offered for bookings</label>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button className={BTN_GHOST} onClick={() => setProfile(null)}>{canEdit ? 'Cancel' : 'Close'}</button>
              {canEdit && <button className={BTN_PRIMARY} onClick={saveProfile}>Save</button>}
            </div>
          </div>
        </div>
      )}

      {cabinEdit && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setCabinEdit(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-bold font-serif mb-4">Edit cabin</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2"><label className={LABEL}>Name</label><input className={INPUT} value={cabinEdit.name} onChange={e => setCabinEdit({ ...cabinEdit, name: e.target.value })} /></div>
              <div className="col-span-2"><label className={LABEL}>Cabin type</label>
                <select className={INPUT} value={cabinEdit.cabin_type_id} onChange={e => setCabinEdit({ ...cabinEdit, cabin_type_id: e.target.value })}>
                  <option value="">No cabin type</option>
                  {cabinTypes.filter(c => isOn(c) || c.id === cabinEdit.cabin_type_id).map(c => <option key={c.id} value={c.id}>{c.name}{isOn(c) ? '' : ' (inactive)'}</option>)}
                </select></div>
              <div><label className={LABEL}>Capacity</label><input className={INPUT} type="number" min={1} value={cabinEdit.capacity} onChange={e => setCabinEdit({ ...cabinEdit, capacity: e.target.value })} /></div>
              <div><label className={LABEL}>Turnaround (min)</label><input className={INPUT} type="number" min={0} value={cabinEdit.turnaround_min} onChange={e => setCabinEdit({ ...cabinEdit, turnaround_min: e.target.value })} /></div>
              <p className="col-span-2 -mt-2 text-[11px] text-[#6b5d52]">Minutes kept clear before and after every booking, for cleaning and resetting the cabin.</p>
              <div className="col-span-2"><label className={LABEL}>Kept for</label>
                <select className={INPUT} value={cabinEdit.gender_designation} onChange={e => setCabinEdit({ ...cabinEdit, gender_designation: e.target.value })}>
                  <option value="ANY">All guests</option><option value="FEMALE">Female guests only</option><option value="MALE">Male guests only</option>
                </select></div>
              <div className={cabinEdit.status === 'AVAILABLE' ? 'col-span-2' : ''}><label className={LABEL}>Status</label>
                <select className={INPUT} value={cabinEdit.status} onChange={e => setCabinEdit({ ...cabinEdit, status: e.target.value })}>
                  {Object.entries(CABIN_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select></div>
              {cabinEdit.status !== 'AVAILABLE' && <div><label className={LABEL}>Reason</label><input className={INPUT} placeholder="e.g. droni being re-oiled" value={cabinEdit.status_reason} onChange={e => setCabinEdit({ ...cabinEdit, status_reason: e.target.value })} /></div>}
              {(cabinEdit.status === 'MAINTENANCE' || cabinEdit.status === 'OUT_OF_ORDER') && <p className="col-span-2 -mt-2 text-[11px] text-amber-700">No new booking goes into this cabin until it is available again. Existing bookings stay as they are.</p>}
              <div className="col-span-2"><label className={LABEL}>Equipment</label><textarea className={INPUT} rows={2} placeholder="Teak droni, oil warmer, dhara stand" value={cabinEdit.equipment} onChange={e => setCabinEdit({ ...cabinEdit, equipment: e.target.value })} /></div>
              <div className="col-span-2"><label className={LABEL}>Notes</label><input className={INPUT} value={cabinEdit.notes} onChange={e => setCabinEdit({ ...cabinEdit, notes: e.target.value })} /></div>
              <label className="flex items-center gap-2 text-sm col-span-2"><input type="checkbox" checked={cabinEdit.is_active} onChange={e => setCabinEdit({ ...cabinEdit, is_active: e.target.checked })} /> Active</label>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button className={BTN_GHOST} onClick={() => setCabinEdit(null)}>Cancel</button>
              <button className={BTN_PRIMARY} onClick={saveCabin}>Save</button>
            </div>
          </div>
        </div>
      )}
      {history && <SpaHistoryOverlay kind={history.kind} id={history.id} meta={history.meta} onClose={() => setHistory(null)} restaurantId={restaurantId} token={token} />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// APPOINTMENTS + CALENDAR + booking + checkout
// ════════════════════════════════════════════════════════════════════════
function SpaAppointments({ restaurantId, token, calendar }: Props & { calendar?: boolean }) {
  const { t } = useT();
  const api = makeApi(restaurantId, token);
  const toast = useToast();
  const confirmDlg = useConfirm();
  const canEdit = canWriteTab('SPA_APPOINTMENTS');
  const [appts, setAppts] = useState<any[]>([]);
  const [services, setServices] = useState<any[]>([]);
  const [therapists, setTherapists] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [day, setDay] = useState(istToday());
  const [search, setSearch] = useState('');

  // booking modal
  const [showBook, setShowBook] = useState(false);
  const blankBk = { service_id: '', date: istToday(), client_id: '', client_name: '', client_phone: '', client_gender: '', therapist_gender_pref: '', room_booking_id: '' };
  const [bk, setBk] = useState<any>(blankBk);
  // A guest on file, the gender question, and the therapist and cabin picked for the slot.
  const [clientQ, setClientQ] = useState('');
  const [clientHits, setClientHits] = useState<any[]>([]);
  const [clientSearched, setClientSearched] = useState(false);
  const [needsGender, setNeedsGender] = useState(false);
  const [suggest, setSuggest] = useState<any[]>([]);
  const [cabins, setCabins] = useState<any[]>([]);
  const [pick, setPick] = useState({ therapist_id: '', resource_id: '' });
  const [ruleProblems, setRuleProblems] = useState<any[]>([]);
  const [overrideReason, setOverrideReason] = useState('');
  const [slots, setSlots] = useState<any[]>([]);
  const [slotLoading, setSlotLoading] = useState(false);
  const [chosenSlot, setChosenSlot] = useState<any>(null);

  // checkout modal
  const [coAppt, setCoAppt] = useState<any>(null);
  const [coState, setCoState] = useState<any>({ use_package: false, apply_membership: false, tip_amount: '', payment_method: 'CASH' });
  const [coResult, setCoResult] = useState<any>(null);
  const [history, setHistory] = useState<any>(null); // appointment History (audit log) overlay
  // Finishing a treatment, and the record of a finished one.
  const [finishAppt, setFinishAppt] = useState<any>(null);
  const [sessionAppt, setSessionAppt] = useState<any>(null);
  // Check-in held by the guest's health record: a clinician can go ahead with a reason.
  const [checkinBlock, setCheckinBlock] = useState<any>(null);
  const [overrideText, setOverrideText] = useState('');
  // Guests checked in to a room: a treatment can be linked to the stay and
  // charged to the room bill.
  const [inHouse, setInHouse] = useState<any[]>([]);
  const lastTen = (p: any) => String(p || '').replace(/\D/g, '').slice(-10);
  const stayForPhone = (phone: any) => (lastTen(phone).length === 10 ? inHouse.find((g: any) => lastTen(g.guest_phone) === lastTen(phone)) : undefined);

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
    } catch (e: any) { toast.error(`Could not load the appointments: ${e.message}`); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [day]);
  useEffect(() => { (async () => { try { setServices(await api('/spa/services')); } catch {} try { setTherapists(await api('/spa/therapists')); } catch {} if (calendar) { try { setCabins(await api('/spa/resources')); } catch {} } try { setInHouse((await api('/spa/in-house-guests')).guests || []); } catch {} })(); }, []);

  const genderQs = () => `${bk.client_gender ? `&guest_gender=${bk.client_gender}` : ''}${bk.therapist_gender_pref ? `&therapist_gender=${bk.therapist_gender_pref}` : ''}`;
  const searchSlots = async () => {
    if (!bk.service_id || !bk.date) return;
    setSlotLoading(true); setChosenSlot(null); setSuggest([]); setRuleProblems([]); setOverrideReason('');
    try {
      const r = await api(`/spa/availability?service_id=${bk.service_id}&date=${bk.date}${genderQs()}`);
      setSlots(r.slots || []); setNeedsGender(!!r.needs_guest_gender);
    } catch (e: any) { toast.error(e.message); setSlots([]); } finally { setSlotLoading(false); }
  };
  const findClients = async () => {
    const q = clientQ.trim();
    if (q.length < 2) { setClientHits([]); setClientSearched(false); return; }
    try { setClientHits((await api(`/spa/clients?search=${encodeURIComponent(q)}`)).slice(0, 8)); } catch { setClientHits([]); }
    setClientSearched(true);
  };
  const pickClient = (c: any) => {
    const g = String(c.gender || '').toUpperCase();
    setBk({ ...bk, client_id: c.id, client_name: c.name || '', client_phone: c.phone || '', client_gender: g === 'FEMALE' || g === 'MALE' ? g : bk.client_gender,
      room_booking_id: bk.room_booking_id || stayForPhone(c.phone)?.booking_id || '' });
    setClientHits([]); setClientQ(''); setClientSearched(false); setSlots([]); setChosenSlot(null);
  };
  // A slot fills in its therapist and cabin, and lists who else could give the
  // treatment then — and why the others cannot.
  const chooseSlot = async (s: any) => {
    setChosenSlot(s); setPick({ therapist_id: s.therapist_id || '', resource_id: s.resource_id || '' }); setRuleProblems([]); setOverrideReason('');
    try {
      const r = await api(`/spa/therapist-search?service_id=${bk.service_id}&start_at=${encodeURIComponent(String(s.start_at).slice(0, 16))}${genderQs()}`);
      setSuggest(r.therapists || []);
    } catch { setSuggest([]); }
    if (!cabins.length) { try { setCabins(await api('/spa/resources')); } catch { /* */ } }
  };
  const book = async (withReason: boolean, confirmShift = false) => {
    if (!canEdit) { toast.error('View-only access — you cannot book appointments.'); return; }
    if (!chosenSlot || !bk.client_name) { toast.error('Pick a slot and enter client name'); return; }
    try {
      await api('/spa/appointments', { method: 'POST', body: JSON.stringify({
        service_id: bk.service_id, start_at: chosenSlot.start_at, therapist_id: pick.therapist_id || null,
        resource_id: pick.resource_id || null, client_id: bk.client_id || undefined, client_name: bk.client_name, client_phone: bk.client_phone,
        assistant_ids: Array.isArray(chosenSlot.assistant_ids) ? chosenSlot.assistant_ids.filter((x: string) => x !== pick.therapist_id) : undefined,
        client_gender: bk.client_gender || undefined, therapist_gender_pref: bk.therapist_gender_pref || undefined,
        room_booking_id: bk.room_booking_id || undefined,
        override_reason: withReason ? overrideReason.trim() : undefined,
        confirm_outside_shift: confirmShift || undefined,
      }) });
      setShowBook(false); setSlots([]); setChosenSlot(null); setRuleProblems([]); setOverrideReason(''); setBk({ ...blankBk, date: day });
      await load();
    } catch (e: any) {
      // Outside the treatment's rules: show why, and let a reason be given.
      if (e?.status === 409 && e?.body?.code === 'ASSIGNMENT_RULES') { setRuleProblems(e.body.problems || []); return; }
      // Outside the therapist's roster: booked only if staff confirm, to be confirmed.
      if (e?.status === 409 && e?.body?.code === 'OUTSIDE_SHIFT') {
        if (await confirmDlg({ title: 'Book outside the roster?', body: `${e.body.error} It will show as To be confirmed until the appointment is confirmed or the guest checks in.`, confirmLabel: 'Book, to be confirmed', cancelLabel: 'Choose another time' })) await book(withReason, true);
        return;
      }
      toast.error(e.message);
    }
  };
  const transition = async (a: any, action: string) => {
    if (!canEdit) { toast.error('View-only access — you cannot change appointment status.'); return; }
    if (action === 'cancel' && !(await confirmDlg({ title: `Cancel ${a.client_name || 'this guest'}'s ${a.service_name || 'appointment'}?`, confirmLabel: 'Cancel appointment', cancelLabel: 'Keep it', danger: true }))) return;
    if (action === 'no-show' && !(await confirmDlg({ title: `Mark ${a.client_name || 'this guest'} as a no-show?`, confirmLabel: 'Mark no-show', cancelLabel: 'Back', danger: true }))) return;
    try {
      if (action === 'cancel') await api(`/spa/appointments/${a.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'Cancelled by staff' }) });
      else await api(`/spa/appointments/${a.id}/${action}`, { method: 'POST' });
      await load();
    } catch (e: any) {
      if (action === 'check-in' && e?.status === 409 && e?.body?.code === 'CONTRAINDICATED' && e?.body?.overridable) { setOverrideText(''); setCheckinBlock({ appt: a, message: e.message }); return; }
      toast.error(e.message);
    }
  };
  const checkInWithReason = async () => {
    if (!checkinBlock) return;
    try {
      await api(`/spa/appointments/${checkinBlock.appt.id}/check-in`, { method: 'POST', body: JSON.stringify({ clinical_override_reason: overrideText.trim() }) });
      setCheckinBlock(null); await load();
    } catch (e: any) { toast.error(e.message); }
  };
  const openCheckout = (r: any) => {
    const linked = r.room_booking_id && inHouse.some((g: any) => g.booking_id === r.room_booking_id) ? r.room_booking_id : '';
    const stay = linked || stayForPhone(r.client_phone)?.booking_id || '';
    setCoAppt(r); setCoResult(null);
    setCoState({ use_package: false, apply_membership: false, tip_amount: '', discount: '', promo_code: '', payment_method: 'CASH', charge_to_room: !!stay, room_booking_id: stay });
  };
  const doCheckout = async () => {
    if (!canEdit) { toast.error('View-only access — you cannot check out appointments.'); return; }
    // Charged to the room: added to the room bill, paid at hotel check-out.
    if (coState.charge_to_room) {
      if (!coState.room_booking_id) { toast.error('Choose the room to charge.'); return; }
      try {
        const r = await api(`/spa/appointments/${coAppt.id}/checkout`, { method: 'POST', body: JSON.stringify({
          charge_to_room: true, room_booking_id: coState.room_booking_id,
          use_package: coState.use_package, apply_membership: coState.apply_membership, tip_amount: Number(coState.tip_amount || 0),
          discount: Number(coState.discount || 0),
        }) });
        setCoResult({ ...r, charged_to_room: true });
        await load();
      } catch (e: any) { toast.error(e.message); }
      return;
    }
    try {
      const r = await api(`/spa/appointments/${coAppt.id}/checkout`, { method: 'POST', body: JSON.stringify({
        use_package: coState.use_package, apply_membership: coState.apply_membership, tip_amount: Number(coState.tip_amount || 0),
        discount: Number(coState.discount || 0),
      }) });
      const folioId = r.folio?.id;
      let outstanding = Number(r.outstanding || 0);
      // Apply a promo code (reduces the invoice further, before we take payment).
      const promo = String(coState.promo_code || '').trim().toUpperCase();
      if (promo && folioId) {
        try { const pr = await api(`/spa/folios/${folioId}/apply-promo`, { method: 'POST', body: JSON.stringify({ code: promo }) }); outstanding = Number(pr.outstanding ?? outstanding); }
        catch (e: any) { toast.error(`Invoice created, but the promo could not be applied: ${e.message}`); }
      }
      // collect payment for the (possibly discounted) outstanding
      if (folioId && outstanding > 0) {
        await api(`/spa/folios/${folioId}/payments`, { method: 'POST', body: JSON.stringify({ amount: outstanding, payment_method: coState.payment_method, payment_type: 'FINAL' }) });
      }
      setCoResult({ ...r, outstanding, paid: true });
      await load();
    } catch (e: any) { toast.error(e.message); }
  };

  const fmtTime = (ts: string) => String(ts || '').slice(11, 16);
  // Only active treatments can be booked. The calendar shows active therapists,
  // plus any inactive one who still has appointments on the day shown.
  const activeServices = services.filter((s: any) => Number(s.is_active ?? 1) === 1);
  // A treatment shows under every therapist on it, leading or assisting.
  const onAppt = (a: any, tid: string) => a.therapist_id === tid || (a.assistant_ids || []).includes(tid);
  const calTherapists = therapists.filter((t: any) => Number(t.is_active ?? 1) === 1 || appts.some((a: any) => onAppt(a, t.id)));

  // ── The calendar as a time grid ─────────────────────────────────────────────
  const [calView, setCalView] = useState<'THERAPIST' | 'CABIN'>('THERAPIST');
  const [dragInfo, setDragInfo] = useState<{ id: string; fromCol: string; grabMin: number } | null>(null);
  const [moveRules, setMoveRules] = useState<any>(null);
  const [moveReason, setMoveReason] = useState('');
  const PX = 1.2; // pixels per minute
  const minsOfTs = (ts: any) => Number(String(ts || '').slice(11, 13)) * 60 + Number(String(ts || '').slice(14, 16));
  // Cancelled and no-show treatments hold no time, so they stay off the grid.
  const dayAppts = appts.filter((a: any) => !['CANCELLED', 'NO_SHOW'].includes(a.status));
  const hiddenCount = appts.length - dayAppts.length;
  const gridStart = Math.floor(Math.min(8 * 60, ...dayAppts.map((a: any) => minsOfTs(a.start_at))) / 60) * 60;
  const gridEnd = Math.min(24 * 60, Math.ceil(Math.max(20 * 60, ...dayAppts.map((a: any) => minsOfTs(a.end_at))) / 60) * 60);
  const gridHours = Array.from({ length: Math.floor((gridEnd - gridStart) / 60) + 1 }, (_, i) => Math.floor(gridStart / 60) + i);
  const calCols: { id: string; name: string; inactive: boolean; items: any[] }[] = calView === 'THERAPIST'
    ? calTherapists.map((t: any) => ({ id: t.id, name: t.display_name, inactive: Number(t.is_active ?? 1) !== 1, items: dayAppts.filter((a: any) => onAppt(a, t.id)) }))
    : cabins.filter((c: any) => Number(c.is_active ?? 1) === 1 || dayAppts.some((a: any) => a.resource_id === c.id))
        .map((c: any) => ({ id: c.id, name: c.name, inactive: Number(c.is_active ?? 1) !== 1, items: dayAppts.filter((a: any) => a.resource_id === c.id) }));
  const hhmmOfMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  // A treatment dragged to a new time, therapist or cabin. The server re-checks it
  // as a reschedule; a move outside the treatment's rules asks for a reason.
  const dropAppt = async (a: any, fromCol: string, toCol: string, startMin: number, reason?: string, confirmShift = false) => {
    if (!canEdit) { toast.error('View-only access — you cannot reschedule appointments.'); return; }
    const body: any = { start_at: `${day} ${hhmmOfMin(startMin)}` };
    if (toCol !== fromCol) {
      if (calView === 'THERAPIST') {
        if (a.therapist_id !== fromCol) { toast.error("Drag the lead therapist's card to give this treatment to another therapist."); return; }
        if ((a.assistant_ids || []).includes(toCol)) { toast.error('That therapist is already assisting on this treatment.'); return; }
        body.therapist_id = toCol;
      } else {
        body.resource_id = toCol;
      }
    } else if (hhmmOfMin(startMin) === fmtTime(a.start_at)) {
      return;
    }
    if (reason) body.override_reason = reason;
    if (confirmShift) body.confirm_outside_shift = true;
    try {
      await api(`/spa/appointments/${a.id}`, { method: 'PUT', body: JSON.stringify(body) });
      setMoveRules(null); setMoveReason('');
      await load();
    } catch (e: any) {
      if (e?.status === 409 && e?.body?.code === 'ASSIGNMENT_RULES') { setMoveReason(''); setMoveRules({ appt: a, fromCol, toCol, startMin, problems: e.body.problems || [] }); return; }
      if (e?.status === 409 && e?.body?.code === 'OUTSIDE_SHIFT') {
        if (await confirmDlg({ title: 'Move outside the roster?', body: `${e.body.error} It will show as To be confirmed until the appointment is confirmed or the guest checks in.`, confirmLabel: 'Move, to be confirmed', cancelLabel: 'Keep it where it was' })) await dropAppt(a, fromCol, toCol, startMin, reason, true);
        return;
      }
      toast.error(e.message);
    }
  };
  // A click on an empty time opens booking for that time; the matching slot is
  // picked once slots are found.
  const [slotHint, setSlotHint] = useState<{ hhmm: string; therapistId: string | null } | null>(null);
  const openBookingAt = (startMin: number, therapistId: string | null) => {
    setBk({ ...blankBk, service_id: activeServices[0]?.id || '', date: day }); setSlots([]); setChosenSlot(null); setRuleProblems([]); setOverrideReason('');
    setClientHits([]); setClientQ(''); setClientSearched(false); setNeedsGender(false);
    setSlotHint({ hhmm: hhmmOfMin(startMin), therapistId }); setShowBook(true);
  };
  useEffect(() => {
    if (!slotHint || !slots.length || chosenSlot) return;
    const s = slots.find((x: any) => String(x.start_at).slice(11, 16) === slotHint.hhmm && (!slotHint.therapistId || x.therapist_id === slotHint.therapistId))
      || slots.find((x: any) => String(x.start_at).slice(11, 16) === slotHint.hhmm);
    if (s) chooseSlot(s);
  }, [slots]);

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
          {canEdit && <button className={BTN_PRIMARY} onClick={() => { setBk({ ...blankBk, service_id: activeServices[0]?.id || '', date: day }); setSlots([]); setChosenSlot(null); setRuleProblems([]); setOverrideReason(''); setClientHits([]); setClientQ(''); setClientSearched(false); setNeedsGender(false); setSlotHint(null); setShowBook(true); }}><Plus size={14} /> New Appointment</button>}
        </div>} />

      {calendar ? (
        <div className={CARD}>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            {(['THERAPIST', 'CABIN'] as const).map(v => (
              <button key={v} className={calView === v ? BTN_PRIMARY : BTN_GHOST}
                onClick={() => { setCalView(v); if (v === 'CABIN' && !cabins.length) api('/spa/resources').then(setCabins).catch(() => {}); }}>
                {v === 'THERAPIST' ? 'By therapist' : 'By cabin'}
              </button>
            ))}
            <span className="text-[11px] text-[#6b5d52] ml-auto">{canEdit ? 'Drag a treatment to move it · click an empty time to book' : 'View only'}</span>
          </div>
          {search.trim() ? (
            <p className="text-sm text-[#6b5d52]">Clear the search to see the day as a grid.</p>
          ) : !calCols.length ? (
            <p className="text-sm text-[#6b5d52]">{calView === 'THERAPIST' ? 'Add therapists first (Therapists & Cabins).' : 'Add cabins first (Therapists & Cabins).'}</p>
          ) : (
            <div className="overflow-x-auto">
              <div className="flex min-w-max">
                <div className="w-14 shrink-0">
                  <div className="h-8" />
                  <div className="relative" style={{ height: (gridEnd - gridStart) * PX }}>
                    {gridHours.map(h => (
                      <div key={h} className="absolute right-2 text-[10px] text-[#9c8e85] tabular-nums" style={{ top: Math.max(0, (h * 60 - gridStart) * PX - 6) }}>{String(h).padStart(2, '0')}:00</div>
                    ))}
                  </div>
                </div>
                {calCols.map(col => (
                  <div key={col.id} className="w-44 shrink-0 border-l border-[#f0e9df]">
                    <div className="h-8 px-2 flex items-center text-xs font-bold truncate" title={col.name}>{col.name}{col.inactive ? ' (inactive)' : ''}</div>
                    <div className={`relative ${canEdit ? 'cursor-pointer' : ''}`}
                      style={{ height: (gridEnd - gridStart) * PX, backgroundImage: `repeating-linear-gradient(to bottom, #f0e9df 0, #f0e9df 1px, transparent 1px, transparent ${30 * PX}px)` }}
                      onDragOver={e => { if (dragInfo) e.preventDefault(); }}
                      onDrop={e => {
                        e.preventDefault();
                        const info = dragInfo; setDragInfo(null);
                        const a = info ? dayAppts.find((x: any) => x.id === info.id) : null;
                        if (!info || !a) return;
                        const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
                        const startMin = Math.max(gridStart, Math.round((gridStart + y / PX - info.grabMin) / 15) * 15);
                        dropAppt(a, info.fromCol, col.id, startMin);
                      }}
                      onClick={e => {
                        if (!canEdit || e.target !== e.currentTarget) return;
                        const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
                        openBookingAt(Math.floor((gridStart + y / PX) / 30) * 30, calView === 'THERAPIST' ? col.id : null);
                      }}>
                      {col.items.map((a: any) => {
                        const top = (minsOfTs(a.start_at) - gridStart) * PX;
                        const height = Math.max(18, (minsOfTs(a.end_at) - minsOfTs(a.start_at)) * PX);
                        const movable = canEdit && ['BOOKED', 'CONFIRMED', 'CHECKED_IN'].includes(a.status);
                        const assisting = calView === 'THERAPIST' && a.therapist_id !== col.id;
                        return (
                          <div key={a.id} draggable={movable}
                            onDragStart={e => { const r = e.currentTarget.getBoundingClientRect(); setDragInfo({ id: a.id, fromCol: col.id, grabMin: (e.clientY - r.top) / PX }); e.dataTransfer.effectAllowed = 'move'; }}
                            onDragEnd={() => setDragInfo(null)}
                            title={`${fmtTime(a.start_at)}–${fmtTime(a.end_at)} · ${a.service_name || ''} · ${a.client_name || 'Guest'}${assisting ? ' · assisting' : ''}`}
                            className={`absolute left-1 right-1 rounded-lg border px-1.5 py-1 text-[10px] leading-tight overflow-hidden ${STATUS_COLOR[a.status] || 'bg-gray-50 text-gray-700 border-gray-200'} ${movable ? 'cursor-move' : 'cursor-default'} ${assisting ? 'border-dashed' : ''}`}
                            style={{ top, height }}>
                            <div className="font-bold tabular-nums">{fmtTime(a.start_at)}–{fmtTime(a.end_at)}</div>
                            <div className="truncate">{a.client_name || 'Guest'}</div>
                            <div className="truncate opacity-80">{a.service_name}{assisting ? ' · assisting' : ''}</div>
                            {a.shift_note && <div className="truncate font-semibold text-amber-700" title={a.shift_note}>To be confirmed</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {hiddenCount > 0 && !search.trim() && <p className="text-[11px] text-[#9c8e85] mt-2">{hiddenCount} cancelled or no-show appointment(s) are not on the grid; the Appointments list shows them.</p>}
          {moveRules && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 mt-3">
              <p className="text-xs font-bold text-amber-800 mb-1">Moving {moveRules.appt.client_name || 'this treatment'} breaks the treatment's rules</p>
              <ul className="list-disc pl-4 text-[11px] text-amber-800 space-y-0.5 mb-2">{moveRules.problems.map((p: any, i: number) => <li key={i}>{p.message}</li>)}</ul>
              <label className={LABEL}>Reason for moving it anyway <span className="font-normal text-[#9d8b7e]">(kept on the appointment and in its audit log)</span></label>
              <textarea className={INPUT} rows={2} value={moveReason} onChange={e => setMoveReason(e.target.value)} />
              <div className="flex justify-end gap-2 mt-2">
                <button className={BTN_GHOST} onClick={() => { setMoveRules(null); setMoveReason(''); }}>Keep it where it was</button>
                <button className={BTN_PRIMARY} disabled={moveReason.trim().length < 5}
                  onClick={() => dropAppt(moveRules.appt, moveRules.fromCol, moveRules.toCol, moveRules.startMin, moveReason.trim())}>Move with this reason</button>
              </div>
            </div>
          )}
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
              { key: 'therapist_name', label: 'Therapist', render: (r: any) => (r.assistant_names?.length ? `${r.therapist_name || '—'} + ${r.assistant_names.join(', ')}` : (r.therapist_name || '—')), exportValue: (r: any) => [r.therapist_name, ...(r.assistant_names || [])].filter(Boolean).join(' + ') },
              { key: 'resource_name', label: 'Cabin' },
              { key: 'status', label: 'Status', render: (r: any) => <Pill status={r.status} /> },
              { key: '_a', label: t('common.actions'), noExport: true, render: (r: any) => {
                const st = String(r.status || '');
                const downloadInvoice = async () => {
                  try {
                    const res = await fetch(`/api/restaurant/${restaurantId}/spa/folios/${r.folio_id}/invoice.pdf`, { headers: { Authorization: `Bearer ${token}` } });
                    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error || 'Download failed'); }
                    const blob = await res.blob(); const url = URL.createObjectURL(blob); const el = document.createElement('a');
                    el.href = url; el.download = `SpaInvoice-${r.folio_id}.pdf`; document.body.appendChild(el); el.click();
                    setTimeout(() => { URL.revokeObjectURL(url); el.remove(); }, 1000);
                  } catch (err: any) { toast.error(err.message); }
                };
                return (
                  <div className="flex items-center justify-end gap-1.5 flex-wrap">
                    {r.shift_note && <span className="px-2 py-1 rounded-lg text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200" title={r.shift_note}>To be confirmed</span>}
                    {r.room_folio_id && <span className="px-2 py-1 rounded-lg text-[10px] font-bold bg-sky-50 text-sky-700 border border-sky-200" title="On the room bill, paid at hotel check-out">Charged to room {r.room_number || ''}</span>}
                    {!r.room_folio_id && r.room_booking_id && r.room_number && <span className="px-2 py-1 rounded-lg text-[10px] font-semibold bg-sky-50 text-sky-700" title="Staying with us">Room {r.room_number}</span>}
                    <RowActions moreLabel={t('actions.more')} actions={[
                      // The next step for this appointment, inline. A treatment starts only once
                      // the guest has checked in, and completes only after that.
                      { key: 'confirm', label: t('actions.confirm'), icon: CalendarCheck, inline: true, hidden: !canEdit || st !== 'BOOKED', onClick: () => transition(r, 'confirm') },
                      { key: 'checkin', label: t('actions.checkIn'), icon: LogIn, inline: true, tone: 'success', hidden: !canEdit || !['BOOKED', 'CONFIRMED'].includes(st), onClick: () => transition(r, 'check-in') },
                      { key: 'start', label: t('actions.startTreatment'), icon: Play, inline: true, tone: 'primary', hidden: !canEdit || st !== 'CHECKED_IN', onClick: () => transition(r, 'start') },
                      { key: 'finish', label: t('actions.finish'), icon: Check, inline: true, tone: 'success', hidden: !canEdit || !['CHECKED_IN', 'IN_PROGRESS'].includes(st), onClick: () => setFinishAppt(r) },
                      { key: 'checkout', label: t('actions.checkout'), icon: IndianRupee, inline: true, tone: 'primary', hidden: !canEdit || st !== 'COMPLETED' || !!r.folio_id || !!r.room_folio_id, onClick: () => openCheckout(r) },
                      { key: 'invoice', label: t('actions.invoicePdf'), icon: FileText, inline: true, hidden: !r.folio_id, onClick: downloadInvoice },
                      // The rest in the "…" menu.
                      { key: 'noshow', label: t('actions.noShow'), icon: UserX, hidden: !canEdit || !['BOOKED', 'CONFIRMED'].includes(st), onClick: () => transition(r, 'no-show') },
                      { key: 'record', label: t('actions.treatmentRecord'), icon: ClipboardList, hidden: st !== 'COMPLETED', onClick: () => setSessionAppt(r) },
                      { key: 'history', label: t('actions.history'), icon: History, onClick: () => setHistory({ id: r.id, meta: { title: r.service_name || r.id, subtitle: [r.status, r.client_name].filter(Boolean).join(' · '), facts: [['Service', r.service_name], ['Status', r.status], ['Client', r.client_name], ['Time', `${fmtTime(r.start_at)}–${fmtTime(r.end_at)}`], ['Therapist', r.therapist_name], ['Cabin', r.resource_name]] } }) },
                      { key: 'cancel', label: t('actions.cancelAppointment'), icon: Ban, tone: 'danger', hidden: !canEdit || !['BOOKED', 'CONFIRMED', 'CHECKED_IN'].includes(st), onClick: () => transition(r, 'cancel') },
                    ]} />
                  </div>
                );
              } },
            ]}
          />
        </div>
      )}

      {history && <SpaHistoryOverlay kind="SPA_APPOINTMENT" id={history.id} meta={history.meta} onClose={() => setHistory(null)} restaurantId={restaurantId} token={token} />}

      {/* Booking modal */}
      {showBook && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setShowBook(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-bold font-serif mb-4">New Appointment</h3>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div className="col-span-2"><label className={LABEL}>Service</label>
                <select className={INPUT} value={bk.service_id} onChange={e => { setBk({ ...bk, service_id: e.target.value }); setSlots([]); setChosenSlot(null); }}>
                  <option value="">Select…</option>
                  {activeServices.map(s => <option key={s.id} value={s.id}>{s.name} · {s.duration_min}min · {money(s.price)}</option>)}
                </select></div>
              <div className="col-span-2">
                <label className={LABEL}>Guest on file <span className="font-normal text-[#9d8b7e]">(search by name or phone, or type a new guest below)</span></label>
                <div className="flex gap-2">
                  <input className={INPUT} placeholder="Name or phone" value={clientQ} onChange={e => setClientQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') findClients(); }} />
                  <button className={BTN_GHOST} onClick={findClients}>Find</button>
                </div>
                {clientHits.length > 0 && (
                  <div className="mt-1.5 rounded-xl border border-[#e8dccf] divide-y divide-[#f0e9df] max-h-40 overflow-auto">
                    {clientHits.map(c => (
                      <button key={c.id} className="w-full text-left px-3 py-2 text-xs hover:bg-[#faf7f2]" onClick={() => pickClient(c)}>
                        <span className="font-semibold">{c.name}</span> · {c.phone || 'no phone'}{c.gender ? ` · ${String(c.gender).toLowerCase()}` : ''}
                      </button>
                    ))}
                  </div>
                )}
                {clientSearched && clientHits.length === 0 && <p className="text-[11px] text-[#9c8e85] mt-1">No guest on file matches — type the guest's details below.</p>}
                {bk.client_id && <p className="text-[11px] text-emerald-700 mt-1">Booking for a guest on file. <button className="underline" onClick={() => setBk({ ...bk, client_id: '' })}>Book as a new guest instead</button></p>}
              </div>
              <div><label className={LABEL}>Client Name</label><input className={INPUT} value={bk.client_name} onChange={e => setBk({ ...bk, client_name: e.target.value })} /></div>
              <div><label className={LABEL}>Client Phone</label><input className={INPUT} value={bk.client_phone} onChange={e => setBk({ ...bk, client_phone: e.target.value })} /></div>
              {inHouse.length > 0 && (
                <div><label className={LABEL}>Staying with us</label>
                  <select className={INPUT} value={bk.room_booking_id} onChange={e => {
                    const g = inHouse.find((x: any) => x.booking_id === e.target.value);
                    setBk({ ...bk, room_booking_id: e.target.value, client_name: bk.client_name || g?.guest_name || '', client_phone: bk.client_phone || g?.guest_phone || '' });
                  }}>
                    <option value="">Not staying in a room</option>
                    {inHouse.map((g: any) => <option key={g.booking_id} value={g.booking_id}>Room {g.room_number || g.room_name} — {g.guest_name}</option>)}
                  </select></div>
              )}
              <div><label className={LABEL}>Guest gender</label>
                <select className={INPUT} value={bk.client_gender} onChange={e => { setBk({ ...bk, client_gender: e.target.value }); setSlots([]); setChosenSlot(null); }}>
                  <option value="">Not recorded</option><option value="FEMALE">Female</option><option value="MALE">Male</option>
                </select></div>
              <div><label className={LABEL}>Therapist preference</label>
                <select className={INPUT} value={bk.therapist_gender_pref} onChange={e => { setBk({ ...bk, therapist_gender_pref: e.target.value }); setSlots([]); setChosenSlot(null); }}>
                  <option value="">No preference</option><option value="FEMALE">Female therapist</option><option value="MALE">Male therapist</option>
                </select></div>
              <div><label className={LABEL}>Date</label><input className={INPUT} type="date" value={bk.date} onChange={e => { setBk({ ...bk, date: e.target.value }); setSlots([]); setChosenSlot(null); }} /></div>
              <div className="flex items-end"><button className={BTN_PRIMARY} onClick={searchSlots} disabled={!bk.service_id}>{slotLoading ? 'Searching…' : 'Find Slots'}</button></div>
            </div>
            {slotHint && (
              <p className="text-[11px] text-[#3d3128] bg-[#faf7f2] border border-[#e8dccf] rounded-lg px-3 py-2 mb-3">From the calendar: {slotHint.hhmm}. Choose the treatment and find slots — that time is picked when it is free.</p>
            )}
            {needsGender && !bk.client_gender && (
              <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">This treatment, or a cabin it can use, is arranged by gender. Choose the guest's gender and find slots again to see the right therapists and cabins.</p>
            )}
            {slots.length > 0 && (
              <div className="mb-3">
                <label className={LABEL}>Available slots (therapist + cabin)</label>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5 max-h-44 overflow-auto">
                  {slots.map((s, i) => (
                    <button key={i} onClick={() => chooseSlot(s)}
                      className={`px-2 py-1.5 rounded-lg text-[11px] border ${chosenSlot === s ? 'bg-brand text-white border-brand' : 'bg-white border-[#e8dccf]'}`}>
                      {s.start_at.slice(11, 16)}<br /><span className="opacity-70">{s.therapist_name}{s.assistant_names?.length ? ` + ${s.assistant_names.join(', ')}` : ''}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {slots.length === 0 && !slotLoading && bk.service_id && <p className="text-xs text-[#6b5d52] mb-3">Click "Find Slots" to see availability.</p>}
            {chosenSlot && (
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div><label className={LABEL}>Therapist</label>
                  <select className={INPUT} value={pick.therapist_id} onChange={e => { setPick({ ...pick, therapist_id: e.target.value }); setRuleProblems([]); }}>
                    {pick.therapist_id && !suggest.some(t => t.id === pick.therapist_id) && <option value={pick.therapist_id}>{chosenSlot.therapist_name}</option>}
                    {suggest.map(t => <option key={t.id} value={t.id}>{t.display_name}{t.eligible ? '' : ` — ${t.reasons[0]}`}</option>)}
                  </select>
                  {(() => { const t = suggest.find(x => x.id === pick.therapist_id); return t && !t.eligible ? <p className="text-[11px] text-amber-800 mt-1">{t.reasons.join(' · ')}</p> : null; })()}
                </div>
                <div><label className={LABEL}>Cabin</label>
                  <select className={INPUT} value={pick.resource_id} onChange={e => { setPick({ ...pick, resource_id: e.target.value }); setRuleProblems([]); }}>
                    {!pick.resource_id && <option value="">No cabin</option>}
                    {pick.resource_id && !cabins.some(c => c.id === pick.resource_id) && <option value={pick.resource_id}>{chosenSlot.resource_name}</option>}
                    {cabins.filter(c => Number(c.is_active ?? 1) === 1 || c.id === pick.resource_id).map(c => {
                      const st = String(c.status || 'AVAILABLE').toUpperCase();
                      return <option key={c.id} value={c.id}>{c.name}{c.cabin_type_name ? ` · ${c.cabin_type_name}` : ''}{st === 'MAINTENANCE' ? ' — under maintenance' : st === 'OUT_OF_ORDER' ? ' — out of order' : ''}</option>;
                    })}
                  </select></div>
              </div>
            )}
            {chosenSlot?.assistant_names?.length > 0 && (
              <p className="text-[11px] text-[#3d3128] mb-3">Given together with {chosenSlot.assistant_names.join(', ')}.</p>
            )}
            {ruleProblems.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 mb-3">
                <p className="text-xs font-bold text-amber-800 mb-1">This booking is outside the treatment's rules</p>
                <ul className="list-disc pl-4 text-[11px] text-amber-800 space-y-0.5 mb-2">{ruleProblems.map((p, i) => <li key={i}>{p.message}</li>)}</ul>
                <label className={LABEL}>Reason for booking it anyway <span className="font-normal text-[#9d8b7e]">(kept on the appointment and in its audit log)</span></label>
                <textarea className={INPUT} rows={2} value={overrideReason} onChange={e => setOverrideReason(e.target.value)} placeholder="e.g. Guest asked for this therapist by name" />
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button className={BTN_GHOST} onClick={() => setShowBook(false)}>Cancel</button>
              {ruleProblems.length > 0
                ? <button className={BTN_PRIMARY} onClick={() => book(true)} disabled={overrideReason.trim().length < 5}>Book with this reason</button>
                : <button className={BTN_PRIMARY} onClick={() => book(false)} disabled={!chosenSlot}>Book Appointment</button>}
            </div>
          </div>
        </div>
      )}

      {checkinBlock && (
        <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={() => setCheckinBlock(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold font-serif mb-2 text-[#14110c]">Health caution</h3>
            <p className="text-sm text-rose-700 mb-3">{checkinBlock.message}</p>
            <label className={LABEL}>Clinical reason to check in anyway</label>
            <textarea className={INPUT} rows={3} value={overrideText} onChange={e => setOverrideText(e.target.value)} placeholder="e.g. Reviewed with the guest; blood pressure normal today; pressure reduced" />
            <div className="flex justify-end gap-2 mt-4">
              <button className={BTN_GHOST} onClick={() => setCheckinBlock(null)}>Do not check in</button>
              <button className={BTN_PRIMARY} disabled={overrideText.trim().length < 5} onClick={checkInWithReason}>Check in with this reason</button>
            </div>
          </div>
        </div>
      )}
      {finishAppt && <SpaFinishDialog restaurantId={restaurantId} token={token} appt={finishAppt} onClose={() => setFinishAppt(null)} onDone={() => { setFinishAppt(null); load(); }} />}
      {sessionAppt && <SpaSessionDialog restaurantId={restaurantId} token={token} appt={sessionAppt} onClose={() => setSessionAppt(null)} />}

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
                  <div className="grid grid-cols-2 gap-2">
                    <div><label className={LABEL}>Discount (₹)</label><input className={INPUT} type="number" min={0} value={coState.discount} onChange={e => setCoState({ ...coState, discount: e.target.value })} placeholder="0" /></div>
                    <div><label className={LABEL}>Tip (₹) <span className="font-normal text-[#9d8b7e]">shared by the therapists</span></label><input className={INPUT} type="number" min={0} value={coState.tip_amount} onChange={e => setCoState({ ...coState, tip_amount: e.target.value })} placeholder="0" /></div>
                  </div>
                  {inHouse.length > 0 && (
                    <div className="rounded-xl border border-[#e8dccf] p-2.5">
                      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!coState.charge_to_room} onChange={e => setCoState({ ...coState, charge_to_room: e.target.checked })} /> Charge to the guest&apos;s room</label>
                      {coState.charge_to_room && (
                        <>
                          <select className={`${INPUT} mt-2`} value={coState.room_booking_id || ''} onChange={e => setCoState({ ...coState, room_booking_id: e.target.value })}>
                            <option value="">Choose the room…</option>
                            {inHouse.map((g: any) => <option key={g.booking_id} value={g.booking_id}>Room {g.room_number || g.room_name} — {g.guest_name}</option>)}
                          </select>
                          <p className="text-[11px] text-[#6b5d52] mt-1">Added to the room bill and paid at hotel check-out. No spa invoice is raised.</p>
                        </>
                      )}
                    </div>
                  )}
                  {!coState.charge_to_room && (
                    <>
                      <div><label className={LABEL}>Promo code (optional)</label><input className={`${INPUT} uppercase`} value={coState.promo_code} onChange={e => setCoState({ ...coState, promo_code: e.target.value.toUpperCase() })} placeholder="e.g. WELCOME10" /></div>
                      <div><label className={LABEL}>Payment method</label>
                        <select className={INPUT} value={coState.payment_method} onChange={e => setCoState({ ...coState, payment_method: e.target.value })}>
                          {['CASH', 'CARD', 'UPI', 'BANK_TRANSFER'].map(m => <option key={m}>{m}</option>)}
                        </select></div>
                    </>
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <button className={BTN_GHOST} onClick={() => setCoAppt(null)}>Cancel</button>
                  <button className={BTN_PRIMARY} onClick={doCheckout}>{coState.charge_to_room ? 'Charge to room' : 'Generate Invoice & Pay'}</button>
                </div>
              </>
            ) : (
              <div className="text-center py-4">
                <Check size={40} className="mx-auto text-emerald-500 mb-2" />
                {coResult.charged_to_room ? (
                  <>
                    <p className="font-bold">Charged to room {coResult.room_number || ''}</p>
                    <p className="text-sm text-[#6b5d52] mb-1">{coResult.guest_name ? `${coResult.guest_name} · ` : ''}{money(Number(coResult.service_amount || 0) + Number(coResult.gst_amount || 0) + Number(coResult.tip || 0))} added to the room bill</p>
                    <p className="text-xs text-emerald-600 mb-4">Paid at hotel check-out</p>
                  </>
                ) : (
                  <>
                    <p className="font-bold">Invoice {coResult.invoice_number}</p>
                    <p className="text-sm text-[#6b5d52] mb-1">Total {money(coResult.folio?.grand_total)}</p>
                    <p className="text-xs text-emerald-600 mb-4">Paid in full</p>
                  </>
                )}
                {!coResult.charged_to_room && (<button className={BTN_PRIMARY + ' inline-flex'} onClick={async () => { try { const res = await fetch(`/api/restaurant/${restaurantId}/spa/folios/${coResult.folio?.id}/invoice.pdf`, { headers: { Authorization: `Bearer ${token}` } }); if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error || 'Download failed'); } const blob = await res.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `SpaInvoice-${coResult.invoice_number || coResult.folio?.id}.pdf`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000); } catch (err: any) { toast.error(err.message); } }}><FileText size={13} /> Download Invoice</button>)}
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
  const toast = useToast();
  const [history, setHistory] = useState<any>(null); // History window for a guest
  const canEdit = canWriteTab('SPA_CLIENTS');
  const [clients, setClients] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '' });
  const [profile, setProfile] = useState<any>(null);
  const [packages, setPackages] = useState<any[]>([]);
  const [memberships, setMemberships] = useState<any[]>([]);

  const load = async () => { try { setClients(await api(`/spa/clients${search ? `?search=${encodeURIComponent(search)}` : ''}`)); } catch (e: any) { toast.error(`Could not load the guests: ${e.message}`); } };
  useEffect(() => { load(); }, []);
  useEffect(() => { (async () => { try { setPackages(await api('/spa/packages')); } catch {} try { setMemberships(await api('/spa/memberships')); } catch {} })(); }, []);

  const addClient = async () => { if (!canEdit) { toast.error('View-only access — you cannot add clients.'); return; } if (!form.name) return; try { await api('/spa/clients', { method: 'POST', body: JSON.stringify(form) }); setShowForm(false); setForm({ name: '', phone: '', email: '' }); await load(); } catch (e: any) { toast.error(e.message); } };
  // The guest record opens in its own window, which loads and edits the guest.
  const openProfile = (c: any) => setProfile({ id: c.id });

  return (
    <div>
      <SectionHeader icon={<User size={18} />} title="Clients" sub="Profiles, history, packages & memberships"
        action={canEdit ? <button className={BTN_PRIMARY} onClick={() => setShowForm(true)}><Plus size={14} /> Add Client</button> : null} />
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
            { key: '_a', label: '', render: (r: any) => (
              <div className="flex gap-2 justify-end">
                <button className={BTN_GHOST} onClick={() => openProfile(r)}>View</button>
                <button className={BTN_GHOST} title="Who changed this guest record" onClick={() => setHistory({ id: r.id, meta: { title: r.name, facts: [['Phone', r.phone], ['Email', r.email]] } })}><History size={12} /> History</button>
              </div>
            ) },
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

      {profile && <SpaClientRecord restaurantId={restaurantId} token={token} clientId={profile.id} packages={packages} memberships={memberships} onClose={() => { setProfile(null); load(); }} />}
      {history && <SpaHistoryOverlay kind="SPA_CLIENT" id={history.id} meta={history.meta} onClose={() => setHistory(null)} restaurantId={restaurantId} token={token} />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// PACKAGES & MEMBERSHIPS (templates management)
// ════════════════════════════════════════════════════════════════════════
function SpaPackages({ restaurantId, token }: Props) {
  const api = makeApi(restaurantId, token);
  const toast = useToast();
  const canEdit = canWriteTab('SPA_PACKAGES');
  const [packages, setPackages] = useState<any[]>([]);
  const [memberships, setMemberships] = useState<any[]>([]);
  const [pkgForm, setPkgForm] = useState({ name: '', total_sessions: '5', price: '', gst_percent: '18', validity_days: '180' });
  const [memForm, setMemForm] = useState({ name: '', monthly_fee: '', discount_pct: '10', gst_percent: '18' });

  const load = async () => {
    try { setPackages(await api('/spa/packages')); } catch (e: any) { toast.error(`Could not load the packages: ${e.message}`); }
    try { setMemberships(await api('/spa/memberships')); } catch (e: any) { toast.error(`Could not load the memberships: ${e.message}`); }
  };
  useEffect(() => { load(); }, []);
  const addPkg = async () => { if (!canEdit) { toast.error('View-only access — you cannot add packages.'); return; } if (!pkgForm.name) return; try { await api('/spa/packages', { method: 'POST', body: JSON.stringify({ ...pkgForm, total_sessions: Number(pkgForm.total_sessions), price: Number(pkgForm.price || 0), gst_percent: Number(pkgForm.gst_percent), validity_days: Number(pkgForm.validity_days) }) }); setPkgForm({ name: '', total_sessions: '5', price: '', gst_percent: '18', validity_days: '180' }); await load(); } catch (e: any) { toast.error(e.message); } };
  const addMem = async () => { if (!canEdit) { toast.error('View-only access — you cannot add memberships.'); return; } if (!memForm.name) return; try { await api('/spa/memberships', { method: 'POST', body: JSON.stringify({ name: memForm.name, monthly_fee: Number(memForm.monthly_fee || 0), gst_percent: Number(memForm.gst_percent), benefits: { discount_pct: Number(memForm.discount_pct || 0) } }) }); setMemForm({ name: '', monthly_fee: '', discount_pct: '10', gst_percent: '18' }); await load(); } catch (e: any) { toast.error(e.message); } };

  return (
    <div>
      <SectionHeader icon={<Award size={18} />} title="Packages & Memberships" sub="Prepaid series + recurring tiers" />
      <div className="grid sm:grid-cols-2 gap-4">
        <div className={CARD}>
          <h4 className="font-bold mb-3 flex items-center gap-1.5"><Package size={15} className="text-brand" /> Packages</h4>
          <div className="space-y-1.5 mb-4">
            {packages.map(p => <div key={p.id} className="text-sm rounded-lg border border-[#e8dccf] p-2 flex justify-between"><span>{p.name}</span><span className="text-[#6b5d52]">{p.total_sessions} × · {money(p.price)}</span></div>)}
            {!packages.length && <p className="text-xs text-[#6b5d52]">No packages yet.</p>}
          </div>
          {canEdit && <><div className="grid grid-cols-2 gap-2">
            <input className={INPUT} placeholder="Name" value={pkgForm.name} onChange={e => setPkgForm({ ...pkgForm, name: e.target.value })} />
            <input className={INPUT} type="number" placeholder="Sessions" value={pkgForm.total_sessions} onChange={e => setPkgForm({ ...pkgForm, total_sessions: e.target.value })} />
            <input className={INPUT} type="number" placeholder="Price ₹" value={pkgForm.price} onChange={e => setPkgForm({ ...pkgForm, price: e.target.value })} />
            <input className={INPUT} type="number" placeholder="Validity days" value={pkgForm.validity_days} onChange={e => setPkgForm({ ...pkgForm, validity_days: e.target.value })} />
          </div>
          <button className={BTN_PRIMARY + ' mt-2'} onClick={addPkg}><Plus size={14} /> Add Package</button></>}
        </div>
        <div className={CARD}>
          <h4 className="font-bold mb-3 flex items-center gap-1.5"><Award size={15} className="text-brand" /> Memberships</h4>
          <div className="space-y-1.5 mb-4">
            {memberships.map(m => <div key={m.id} className="text-sm rounded-lg border border-[#e8dccf] p-2 flex justify-between"><span>{m.name}</span><span className="text-[#6b5d52]">{money(m.monthly_fee)}/mo</span></div>)}
            {!memberships.length && <p className="text-xs text-[#6b5d52]">No memberships yet.</p>}
          </div>
          {canEdit && <><div className="grid grid-cols-2 gap-2">
            <input className={INPUT} placeholder="Name" value={memForm.name} onChange={e => setMemForm({ ...memForm, name: e.target.value })} />
            <input className={INPUT} type="number" placeholder="Monthly fee ₹" value={memForm.monthly_fee} onChange={e => setMemForm({ ...memForm, monthly_fee: e.target.value })} />
            <input className={INPUT} type="number" placeholder="Discount %" value={memForm.discount_pct} onChange={e => setMemForm({ ...memForm, discount_pct: e.target.value })} />
          </div>
          <button className={BTN_PRIMARY + ' mt-2'} onClick={addMem}><Plus size={14} /> Add Membership</button></>}
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
  const toast = useToast();
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const daysBack = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(daysBack(29));
  const [to, setTo] = useState(today);
  const [range, setRange] = useState<any>(null);
  const [loadingR, setLoadingR] = useState(false);
  const [rev, setRev] = useState<any[]>([]);
  const [rebook, setRebook] = useState<any>(null);
  const [tips, setTips] = useState<any>(null);
  const loadRange = async () => {
    setLoadingR(true);
    try { setRange(await api(`/spa/reports/range?from=${from}&to=${to}`)); }
    catch (e: any) { toast.error(`Could not load the reports: ${e.message}`); }
    try { setTips(await api(`/spa/reports/tips?from=${from}&to=${to}`)); }
    catch (e: any) { toast.error(`Could not load the tips: ${e.message}`); }
    finally { setLoadingR(false); }
  };
  useEffect(() => { loadRange(); (async () => {
    try { setRev(await api('/spa/reports/revenue-per-treatment')); } catch (e: any) { toast.error(`Could not load revenue per treatment: ${e.message}`); }
    try { setRebook(await api('/spa/reports/rebooking-rate')); } catch (e: any) { toast.error(`Could not load the rebooking rate: ${e.message}`); }
  })(); }, []);
  const exportCsv = async (kind: 'treatments' | 'tips') => {
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/spa/reports/${kind}.csv?from=${from}&to=${to}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error || 'The export failed.'); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `spa-${kind}-${from}-to-${to}.csv`;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    } catch (e: any) { toast.error(e.message); }
  };
  const pct = (v: any) => (v == null ? '—' : `${v}%`);
  const s = range?.summary;
  return (
    <div>
      <SectionHeader icon={<TrendingUp size={18} />} title="Spa Reports" sub={range ? `${range.from} to ${range.to}` : 'Choose the dates'} />
      <div className={`${CARD} mb-4`}>
        <div className="flex flex-wrap items-end gap-3">
          <div><label className={LABEL}>From</label><input type="date" className={INPUT} value={from} max={to} onChange={e => setFrom(e.target.value)} /></div>
          <div><label className={LABEL}>To</label><input type="date" className={INPUT} value={to} min={from} onChange={e => setTo(e.target.value)} /></div>
          <button className={BTN_PRIMARY} onClick={loadRange} disabled={loadingR}>{loadingR ? 'Loading…' : 'Show'}</button>
          <button className={BTN_GHOST} onClick={() => exportCsv('treatments')}><FileText size={13} /> Export treatments (CSV)</button>
        </div>
        {s && (
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 mt-4">
            {([['Appointments', s.appointments], ['Completed', s.completed], ['Cancelled', s.cancelled], ['No-shows', `${s.no_shows}${s.no_show_rate_pct != null ? ` (${s.no_show_rate_pct}%)` : ''}`], ['Treatment value', money(s.service_value)], ['Tips', money(s.tips)]] as [string, any][]).map(([k, v]) => (
              <div key={k}><div className="text-[11px] text-[#6b5d52]">{k}</div><div className="text-lg font-bold text-[#14110c] tabular-nums">{v}</div></div>
            ))}
          </div>
        )}
      </div>
      {range && (
        <div className="space-y-4">
          <div className={CARD}>
            <h4 className="font-bold mb-1">Therapists</h4>
            <p className="text-[11px] text-[#6b5d52] mb-3">Available time is rostered shifts less breaks and blocked time. Booked time includes treatments a therapist assisted on. {range.notes?.commission}</p>
            <DataTable data={range.therapists} rowKey={(r: any) => r.therapist_id} columns={[
              { key: 'display_name', label: 'Therapist' },
              { key: 'available_minutes', label: 'Available min' },
              { key: 'booked_minutes', label: 'Booked min' },
              { key: 'utilisation_pct', label: 'Utilisation', render: (r: any) => pct(r.utilisation_pct) },
              { key: 'completed', label: 'Completed' },
              { key: 'no_shows', label: 'No-shows', render: (r: any) => `${r.no_shows}${r.no_show_rate_pct != null ? ` (${r.no_show_rate_pct}%)` : ''}` },
              { key: 'service_value', label: 'Value', render: (r: any) => money(r.service_value) },
              { key: 'commission', label: 'Commission', render: (r: any) => money(r.commission) },
              { key: 'tips', label: 'Tips', render: (r: any) => money(r.tips) },
            ]} />
          </div>
          <div className={CARD}>
            <h4 className="font-bold mb-1">Cabins</h4>
            <p className="text-[11px] text-[#6b5d52] mb-3">{range.notes?.cabins}</p>
            <DataTable data={range.cabins} rowKey={(r: any) => r.cabin_id} columns={[
              { key: 'name', label: 'Cabin' },
              { key: 'treatments', label: 'Treatments' },
              { key: 'booked_minutes', label: 'Booked min' },
              { key: 'turnaround_minutes', label: 'Turnaround min' },
              { key: 'blocked_minutes', label: 'Blocked min' },
            ]} />
          </div>
          <div className={CARD}>
            <h4 className="font-bold mb-1">Consumables against standard</h4>
            <p className="text-[11px] text-[#6b5d52] mb-3">From treatments finished through the Finish screen. A positive variance means more was used than the standard.</p>
            <DataTable data={range.consumption} rowKey={(r: any) => `${r.service_id}-${r.ingredient_id}-${r.unit}`} columns={[
              { key: 'service_name', label: 'Treatment' },
              { key: 'item', label: 'Item' },
              { key: 'treatments', label: 'Treatments' },
              { key: 'standard_qty', label: 'Standard', render: (r: any) => `${r.standard_qty} ${r.unit || ''}` },
              { key: 'actual_qty', label: 'Used', render: (r: any) => `${r.actual_qty} ${r.unit || ''}` },
              { key: 'variance', label: 'Variance', render: (r: any) => <span className={Number(r.variance) > 0 ? 'text-rose-700 font-semibold' : Number(r.variance) < 0 ? 'text-emerald-700' : ''}>{Number(r.variance) > 0 ? '+' : ''}{r.variance} {r.unit || ''}{r.variance_pct != null ? ` (${r.variance_pct}%)` : ''}</span> },
              { key: 'cost', label: 'Cost', render: (r: any) => money(r.cost) },
            ]} />
          </div>
        </div>
      )}
      {tips && (
        <div className={`${CARD} mt-4`}>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
            <h4 className="font-bold">Tips to pay</h4>
            <button className={BTN_GHOST} onClick={() => exportCsv('tips')}><FileText size={13} /> Export tips (CSV)</button>
          </div>
          <p className="text-[11px] text-[#6b5d52] mb-3">{tips.note}</p>
          <DataTable data={tips.therapists} rowKey={(r: any) => r.therapist_id} columns={[
            { key: 'therapist', label: 'Therapist' },
            { key: 'collected', label: 'To pay (collected)', render: (r: any) => <span className="font-semibold">{money(r.collected)}</span> },
            { key: 'pending', label: 'Pending', render: (r: any) => money(r.pending) },
            { key: 'reversed', label: 'Reversed', render: (r: any) => money(r.reversed) },
            { key: 'shares', label: 'Treatments' },
          ]} />
          {(tips.lines || []).length > 0 && (
            <div className="mt-4">
              <h5 className="text-sm font-bold mb-2">Each share</h5>
              <DataTable data={tips.lines} rowKey={(r: any) => r.id} columns={[
                { key: 'therapist', label: 'Therapist' },
                { key: 'at', label: 'When' },
                { key: 'guest', label: 'Guest' },
                { key: 'treatment', label: 'Treatment' },
                { key: 'bill', label: 'Bill' },
                { key: 'status', label: 'Status', render: (r: any) => <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${r.status === 'COLLECTED' ? 'bg-emerald-50 text-emerald-700' : r.status === 'PENDING' ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>{r.status === 'COLLECTED' ? 'Collected' : r.status === 'PENDING' ? 'Pending' : 'Reversed'}</span> },
                { key: 'amount', label: 'Share', render: (r: any) => money(r.amount) },
              ]} />
            </div>
          )}
        </div>
      )}
      <div className="grid sm:grid-cols-2 gap-4 mt-4">
        <div className={CARD}>
          <h4 className="font-bold mb-3">Revenue per Treatment <span className="text-[11px] font-normal text-[#6b5d52]">all time</span></h4>
          <DataTable data={rev} rowKey={(r: any) => r.service_id || r.service_name} columns={[
            { key: 'service_name', label: 'Service' },
            { key: 'times_sold', label: 'Sold' },
            { key: 'revenue', label: 'Revenue', render: (r: any) => money(r.revenue) },
          ]} />
        </div>
        <div className={CARD}>
          <h4 className="font-bold mb-3">Rebooking Rate</h4>
          {rebook ? (
            <div className="text-center py-4">
              <div className="text-4xl font-bold text-brand">{rebook.rebooking_pct}%</div>
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
      <SpaBatchTrace restaurantId={restaurantId} token={token} items={items} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// SPA SETTINGS — public page hero, tagline, offers bulletin
// ════════════════════════════════════════════════════════════════════════
function SpaSettings({ restaurantId, token }: Props) {
  const api = makeApi(restaurantId, token);
  const toast = useToast();
  const canEdit = canWriteTab('SPA_SETTINGS');
  const [profile, setProfile] = useState<any>({ hero_image_url: '', tagline: '', offers: [] });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const blankOffer = { badge: '', title: '', description: '', valid_until: '' };

  useEffect(() => { (async () => {
    try {
      const p = await api('/spa/profile');
      // Accept the offers as a list or as stored JSON text: reading text as "no
      // offers" is how a save used to erase them.
      let offers: any = p.offers;
      if (typeof offers === 'string') { try { offers = JSON.parse(offers); } catch { offers = []; } }
      setProfile({ ...p, offers: Array.isArray(offers) ? offers : [] });
    }
    catch { /* */ }
  })(); }, []);

  const save = async () => {
    if (!canEdit) { toast.error('View-only access — you cannot change the public page.'); return; }
    setSaving(true); setSaved(false);
    try {
      await api('/spa/profile', { method: 'PUT', body: JSON.stringify({ ...profile, module_label: String(profile.module_label || '').trim() }) });
      setSaved(true); setTimeout(() => setSaved(false), 2500);
      // The menu reads the name from the property record: have it reloaded.
      window.dispatchEvent(new Event('atithi:restaurant-changed'));
    }
    catch (e: any) { toast.error(e.message); } finally { setSaving(false); }
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
  // The QR code is drawn in the app, so the booking link is not sent to another site.
  const downloadQr = () => {
    const c = document.getElementById('spa-booking-qr') as HTMLCanvasElement | null;
    if (!c) { toast.error('The QR code is not ready yet.'); return; }
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png'); a.download = 'spa-booking-qr.png';
    document.body.appendChild(a); a.click(); a.remove();
  };

  return (
    <div className="space-y-6">
      <SectionHeader icon={<Calendar size={18} />} title="Public Page Settings" sub="What guests see at your online booking page" />

      {/* The module's name for this property — the menu, settings, reports and the public page use it. */}
      <div className={CARD}>
        <label className={LABEL}>Module name</label>
        <input className={INPUT} maxLength={40} placeholder="Spa & Wellness" value={profile.module_label || ''}
          onChange={e => setProfile((p: any) => ({ ...p, module_label: e.target.value }))} disabled={!canEdit} />
        <p className="text-[11px] text-[#6b5d52] mt-1">For example Ayurvedic Wellness. Leave blank to use Spa &amp; Wellness.</p>
      </div>

      {/* Consent and a health intake before every treatment. */}
      <div className={CARD}>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" disabled={!canEdit} checked={Number(profile.require_intake_consent || 0) === 1}
            onChange={e => setProfile((p: any) => ({ ...p, require_intake_consent: e.target.checked ? 1 : 0 }))} />
          <span><b>Require a signed consent and a health intake before check-in</b>
            <span className="block text-[11px] text-[#6b5d52]">For every treatment. A treatment can also require it on its own, in the Service Menu. Save to apply.</span></span>
        </label>
      </div>

      {/* public link */}
      <div className={CARD}>
        <p className="text-xs font-semibold text-[#6b5d52] mb-1">Your public booking link</p>
        <div className="flex items-center gap-2">
          <a href={publicUrl} target="_blank" rel="noreferrer" className="flex-1 text-sm text-brand underline break-all">{publicUrl}</a>
          <button className={BTN_GHOST} onClick={() => navigator.clipboard.writeText(publicUrl).then(() => toast.success('Link copied'), () => toast.error('The link could not be copied.'))}>Copy</button>
        </div>
      </div>

      {/* QR code */}
      <div className={CARD}>
        <p className="text-xs font-semibold text-[#6b5d52] mb-3">QR Code</p>
        <div className="flex items-start gap-4">
          <QRCodeCanvas id="spa-booking-qr" value={publicUrl} size={512} marginSize={2} title="Booking QR code" style={{ width: 128, height: 128 }} className="rounded-xl border border-[#e8dccf] flex-shrink-0 bg-white" />
          <div className="flex-1 space-y-2">
            <p className="text-xs text-[#9d8b7e]">Guests scan this with any mobile camera to open your online booking page. Print it on menus, tent cards, reception desk, or social media.</p>
            <button className={BTN_GHOST} onClick={downloadQr}>Download QR</button>
          </div>
        </div>
      </div>

      {/* hero + tagline */}
      <div className={CARD}>
        <p className="text-sm font-bold text-[#14110c] mb-3">Hero Banner</p>
        <div className="space-y-3">
          <div>
            <label className={LABEL}>Background Photo URL</label>
            <input className={INPUT} disabled={!canEdit} value={profile.hero_image_url || ''} onChange={e => setProfile((p: any) => ({ ...p, hero_image_url: e.target.value }))}
              placeholder="https://example.com/spa-hero.jpg — paste any image URL" />
            <p className="text-[11px] text-[#9d8b7e] mt-1">Use a high-quality landscape photo (1920×600px works well). Free options: Unsplash, Pexels.</p>
            {profile.hero_image_url && (
              <img src={profile.hero_image_url} alt="Hero preview" className="mt-2 w-full h-32 object-cover rounded-xl border border-[#e8dccf]"
                onError={e => (e.currentTarget.style.display = 'none')} onLoad={e => (e.currentTarget.style.display = '')} />
            )}
          </div>
          <div>
            <label className={LABEL}>Tagline <span className="font-normal text-[#9d8b7e]">(short phrase below spa name)</span></label>
            <input className={INPUT} disabled={!canEdit} value={profile.tagline || ''} onChange={e => setProfile((p: any) => ({ ...p, tagline: e.target.value }))}
              placeholder="e.g. Unwind. Restore. Glow." maxLength={80} />
          </div>
        </div>
      </div>

      {/* offers */}
      <div className={CARD}>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-bold text-[#14110c]">Offers & Promotions</p>
          {canEdit && <button className={BTN_GHOST} onClick={addOffer}><Plus size={13} /> Add Offer</button>}
        </div>
        {(profile.offers || []).length === 0 && (
          <p className="text-xs text-[#9d8b7e] py-3 text-center">No offers yet. Add one to show a promotional banner on the public page.</p>
        )}
        <div className="space-y-4">
          {(profile.offers || []).map((o: any, i: number) => (
            <div key={i} className="rounded-xl border border-[#e8dccf] p-4 relative">
              {canEdit && <button className="absolute top-3 right-3 text-rose-400 hover:text-rose-600" onClick={() => removeOffer(i)}><X size={14} /></button>}
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
                <div className="mt-3 rounded-xl px-3 py-2 text-white text-xs" style={{ background: `linear-gradient(135deg, ${BRAND}, #8b3a0f)` }}>
                  {o.badge && <span className="bg-white text-brand rounded-full px-1.5 py-0.5 text-[9px] font-bold mr-1">{o.badge}</span>}
                  <span className="font-semibold">{o.title}</span>
                  {o.description && <span className="opacity-70 ml-1">— {o.description}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        {canEdit && <button className={BTN_PRIMARY} onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save Changes'}
        </button>}
        {saved && <span className="text-xs text-emerald-600 font-semibold flex items-center gap-1"><Check size={13} /> Saved</span>}
        <a href={publicUrl} target="_blank" rel="noreferrer" className={BTN_GHOST}>Preview Public Page</a>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Dispatcher
// ════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════
// INVOICES & PAYMENTS — every spa invoice (paid + unpaid) with per-invoice
// record-payment and apply-promo. This is the operational billing workspace
// (the old SPA_BILLING screen was a settled-only accounting report).
// ════════════════════════════════════════════════════════════════════════
function SpaFolios({ restaurantId, token }: Props) {
  const api = makeApi(restaurantId, token);
  const toast = useToast();
  const promptDlg = usePaymentDialog();
  const canEdit = canWriteTab('SPA_BILLING');
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'unpaid' | 'paid'>('all');
  // Invoice date filter (settled or created date); opens on today.
  const [dateRange, setDateRange] = useState<DateRange>(defaultDateRange);
  const [payFor, setPayFor] = useState<any>(null);
  const [promoFor, setPromoFor] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [payForm, setPayForm] = useState({ amount: '', method: 'CASH' });
  const [promoCode, setPromoCode] = useState('');
  const [history, setHistory] = useState<any>(null); // folio History (audit log) overlay
  const [linkFor, setLinkFor] = useState<any>(null); // send a gateway payment link
  const editGst = useBuyerGstEditor(restaurantId, token);
  const { t } = useT();
  // Recording a spa payment needs Edit on Spa Appointments (the server's gate).
  const canSendLink = canWriteTab('SPA_APPOINTMENTS');

  const load = async () => {
    setLoading(true);
    try { setRows(await api('/spa/folios')); } catch (e: any) { setRows([]); toast.error(`Could not load the invoices: ${e.message}`); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // Cancel an invoice — reverses the spa settlement in the GL (never deletes it).
  const cancelFolio = async (f: any) => {
    if (!canEdit) { toast.error('View-only access — you cannot cancel invoices.'); return; }
    const got = await promptDlg({
      title: 'Cancel this invoice?',
      body: 'This reverses it in the accounts (spa revenue, GST and cash). It is not deleted: a cancelled invoice is kept for audit.',
      fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, placeholder: 'Why is this invoice being cancelled?' }],
      confirmLabel: 'Cancel invoice',
    });
    if (!got) return;
    const reason = String(got.reason || '');
    if (reason.trim().length < 3) { toast.error('A cancellation reason is required.'); return; }
    setBusy(true);
    try { await api(`/folios/${f.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) }); await load(); }
    catch (e: any) { toast.error('Cancel failed: ' + (e?.message || 'error')); }
    finally { setBusy(false); }
  };
  const canCancelSpa = ['OWNER', 'MANAGER', 'SUPER_ADMIN', 'CTO'].includes((localStorage.getItem('role') || '').toUpperCase());

  const dOnly = (v: any) => v ? new Date(v).toLocaleDateString('en-IN') : '—';
  const outOf = (f: any) => Math.max(0, Number(f.outstanding || 0));
  const statusOf = (f: any) => f.status === 'closed' || outOf(f) <= 0.01 ? 'PAID' : (Number(f.paid_amount || 0) > 0 ? 'PART-PAID' : 'UNPAID');
  const stColor = (s: string) => s === 'PAID' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : s === 'PART-PAID' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-rose-50 text-rose-700 border-rose-200';

  const inDates = rows.filter(f => dayInRange(f.settled_at || f.created_at, dateRange));
  const filtered = inDates.filter(f => filter === 'all' ? true : filter === 'paid' ? outOf(f) <= 0.01 : outOf(f) > 0.01);
  const totPaid = inDates.reduce((s, f) => s + Number(f.paid_amount || 0), 0);
  const totOut = inDates.reduce((s, f) => s + outOf(f), 0);

  const downloadPdf = async (f: any) => {
    try {
      const r = await fetch(`/api/restaurant/${restaurantId}/spa/folios/${f.id}/invoice.pdf`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j?.error || 'Download failed'); }
      const blob = await r.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `SpaInvoice-${f.invoice_number || f.id}.pdf`; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    } catch (e: any) { toast.error(e.message); }
  };
  const openPay = (f: any) => { setPayForm({ amount: String(outOf(f)), method: 'CASH' }); setPayFor(f); };
  const savePayment = async () => {
    if (!canEdit) { toast.error('View-only access — you cannot record payments.'); return; }
    const amount = Math.round(Number(payForm.amount || 0) * 100) / 100;
    if (!(amount > 0)) { toast.error('Enter an amount greater than 0'); return; }
    setBusy(true);
    try { await api(`/spa/folios/${payFor.id}/payments`, { method: 'POST', body: JSON.stringify({ amount, payment_method: payForm.method, payment_type: 'FINAL' }) }); setPayFor(null); await load(); }
    catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };
  const openPromo = (f: any) => { setPromoCode(''); setPromoFor(f); };
  const savePromo = async () => {
    if (!canEdit) { toast.error('View-only access — you cannot apply promos.'); return; }
    const code = promoCode.trim();
    if (!code) { toast.error('Enter a promo code'); return; }
    setBusy(true);
    try { const r = await api(`/spa/folios/${promoFor.id}/apply-promo`, { method: 'POST', body: JSON.stringify({ code }) }); setPromoFor(null); await load(); toast.success(`Promo applied — ${money(r.discount)} off. New balance ${money(r.outstanding)}.`); }
    catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  const tile = (label: string, val: string, accent: string) => (
    <div className="bg-white rounded-2xl border border-[#e8dccf] p-4">
      <p className="text-[9px] font-bold uppercase tracking-widest text-[#9c8e85]">{label}</p>
      <p className={`text-2xl font-bold mt-1 tabular-nums ${accent}`}>{val}</p>
    </div>
  );

  return (
    <div>
      <SectionHeader icon={<ReceiptText size={18} />} title="Invoices & Payments"
        sub="Every spa invoice — record payments and apply promo codes / discounts."
        action={<button className={BTN_GHOST} onClick={load}><RefreshCw size={13} /> Refresh</button>} />

      <div className="space-y-3 mb-4">
        <DateRangeBar value={dateRange} onChange={setDateRange} label={t('listFilter.invoiceDate')} />
        <StatusTiles active={filter} allValue="all" onSelect={f => setFilter(f as any)} tiles={[
          { filter: 'unpaid', label: t('listFilter.unpaid'), value: inDates.filter(f => outOf(f) > 0.01).length, tone: 'bg-amber-50 border-amber-200 text-amber-700' },
          { filter: 'paid', label: t('listFilter.paid'), value: inDates.filter(f => outOf(f) <= 0.01).length, tone: 'bg-green-50 border-green-200 text-green-700' },
          { label: t('listFilter.collected'), value: money(totPaid), tone: 'bg-brand/5 border-brand/20 text-brand' },
          { label: t('listFilter.outstanding'), value: money(totOut), tone: 'bg-rose-50 border-rose-200 text-rose-700' },
        ]} />
      </div>

      <div className="flex items-center gap-1.5 mb-3">
        {(['all', 'unpaid', 'paid'] as const).map(k => (
          <button key={k} onClick={() => setFilter(k)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold capitalize ${filter === k ? 'bg-brand text-white' : 'bg-[#faf7f2] border border-[#e8dccf] text-[#6b5d52]'}`}>{k}</button>
        ))}
        <span className="text-[11px] text-[#9c8e85] ml-1">{filtered.length} shown</span>
      </div>

      <div className={`${CARD} p-0 overflow-x-auto`}>
        {loading ? <p className="text-sm text-[#6b5d52] p-5">Loading…</p> : filtered.length === 0 ? (
          <p className="text-sm text-[#9c8e85] italic p-5">No invoices{filter !== 'all' ? ` (${filter})` : ''} yet. Invoices are created when you check out a completed appointment.</p>
        ) : (
          <table className="w-full text-sm border-collapse min-w-[720px]">
            <thead><tr className="bg-[#faf7f2] text-[#6b5d52] text-[11px] uppercase tracking-wider">
              <th className="text-left px-3 py-3">Invoice</th>
              <th className="text-left px-3 py-3">Date</th>
              <th className="text-left px-3 py-3">Client / Service</th>
              <th className="text-right px-3 py-3">Total</th>
              <th className="text-right px-3 py-3">Paid</th>
              <th className="text-right px-3 py-3">Outstanding</th>
              <th className="text-center px-3 py-3">Status</th>
              <th className="px-3 py-3"></th>
            </tr></thead>
            <tbody>
              {filtered.map(f => {
                const st = statusOf(f); const open = outOf(f) > 0.01;
                return (
                  <tr key={f.id} className="border-t border-[#f0ebe4] hover:bg-[#faf7f2]">
                    <td className="px-3 py-2 font-mono text-xs text-[#1a1208]">{f.invoice_number || '—'}</td>
                    <td className="px-3 py-2 text-[#6b5d52] text-xs">{dOnly(f.settled_at || f.created_at)}</td>
                    <td className="px-3 py-2"><div className="font-medium text-[#1a1208]">{f.client_name || '—'}</div><div className="text-[10px] text-[#9c8e85]">{f.service_name || ''}</div></td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-[#1a1208]">{money(f.grand_total)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{money(f.paid_amount)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-bold text-rose-600">{open ? money(outOf(f)) : '—'}</td>
                    <td className="px-3 py-2 text-center"><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${stColor(st)}`}>{st}</span></td>
                    <td className="px-3 py-2">
                      <RowActions moreLabel={t('actions.more')} actions={[
                        { key: 'pay', label: t('actions.recordPayment'), icon: IndianRupee, inline: true, tone: 'success', hidden: !open || !canEdit, onClick: () => openPay(f) },
                        { key: 'link', label: t('actions.sendLink'), icon: Send, inline: true, tone: 'primary', hidden: !open || !canSendLink || !moduleOn('online_payments'), onClick: () => setLinkFor(f) },
                        { key: 'pdf', label: t('actions.invoicePdf'), icon: FileText, inline: true, onClick: () => downloadPdf(f) },
                        { key: 'promo', label: t('actions.applyPromo'), icon: Tag, hidden: !open || !canEdit, onClick: () => openPromo(f) },
                        { key: 'gst', label: f.customer_gstin ? t('actions.gstEdit') : t('actions.gstAdd'), icon: BadgePercent, marked: !!f.customer_gstin, hidden: !canEdit || ['voided', 'cancelled'].includes(String(f.status || '').toLowerCase()), onClick: () => editGst({ kind: 'SPA_FOLIO', id: f.id }, { gstin: f.customer_gstin, address: f.customer_address }, () => load()) },
                        { key: 'history', label: t('actions.history'), icon: History, onClick: () => setHistory({ id: f.id, meta: { title: f.invoice_number || f.id, subtitle: [statusOf(f), f.client_name].filter(Boolean).join(' · '), facts: [['Invoice #', f.invoice_number], ['Client', f.client_name], ['Service', f.service_name], ['Total', money(f.grand_total)], ['Paid', money(f.paid_amount)], ['Outstanding', open ? money(outOf(f)) : '—']] } }) },
                        { key: 'cancel', label: t('actions.cancelInvoice'), icon: Ban, tone: 'danger', disabled: busy, hidden: !canCancelSpa || !canEdit || ['voided', 'cancelled'].includes(String(f.status || '').toLowerCase()), onClick: () => cancelFolio(f) },
                      ]} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {linkFor && (
        <CollectOnlineDialog
          restaurantId={restaurantId} token={token}
          folio={{ id: linkFor.id, guest_name: linkFor.client_name, guest_phone: linkFor.client_phone, guest_email: linkFor.client_email }}
          payable={{ objectType: 'SPA_FOLIO', permTab: 'SPA_APPOINTMENTS', objectId: linkFor.id, outstanding: outOf(linkFor), subtitle: t('spa.pay.linkSubtitle', { id: linkFor.invoice_number || linkFor.id }), presets: [{ label: t('events.pay.linkFull'), amount: outOf(linkFor) }] }}
          onClose={() => { setLinkFor(null); load(); }}
          onRecorded={() => load()}
        />
      )}

      {history && <SpaHistoryOverlay kind="SPA_FOLIO" id={history.id} meta={history.meta} onClose={() => setHistory(null)} restaurantId={restaurantId} token={token} />}

      {/* Record payment */}
      {payFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPayFor(null)}>
          <div className="w-full max-w-sm bg-white rounded-2xl border border-[#e8dccf] p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold font-serif mb-1">Record payment</h3>
            <p className="text-xs text-[#6b5d52] mb-3">{payFor.invoice_number} · outstanding <b className="text-rose-600">{money(outOf(payFor))}</b></p>
            <label className={LABEL}>Amount (₹)</label>
            <input type="number" min={0} max={outOf(payFor)} className={INPUT} value={payForm.amount} onChange={e => setPayForm({ ...payForm, amount: e.target.value })} />
            <label className={`${LABEL} mt-2`}>Method</label>
            <select className={INPUT} value={payForm.method} onChange={e => setPayForm({ ...payForm, method: e.target.value })}>
              {['CASH', 'UPI', 'CARD', 'BANK', 'CHEQUE'].map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <div className="flex justify-end gap-2 mt-4">
              <button className={BTN_GHOST} onClick={() => setPayFor(null)} disabled={busy}>Cancel</button>
              <button className={BTN_PRIMARY} onClick={savePayment} disabled={busy}>Record payment</button>
            </div>
          </div>
        </div>
      )}

      {/* Apply promo */}
      {promoFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPromoFor(null)}>
          <div className="w-full max-w-sm bg-white rounded-2xl border border-[#e8dccf] p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold font-serif mb-1">Apply promo code</h3>
            <p className="text-xs text-[#6b5d52] mb-3">{promoFor.invoice_number} · bill {money(promoFor.subtotal)}</p>
            <label className={LABEL}>Promo code</label>
            <input className={`${INPUT} uppercase`} value={promoCode} onChange={e => setPromoCode(e.target.value.toUpperCase())} placeholder="e.g. WELCOME10" autoFocus />
            <p className="text-[11px] text-[#9c8e85] mt-1.5">Uses your shared promo codes (Loyalty → Promo Codes). Discount applies to this invoice.</p>
            <div className="flex justify-end gap-2 mt-4">
              <button className={BTN_GHOST} onClick={() => setPromoFor(null)} disabled={busy}>Cancel</button>
              <button className={BTN_PRIMARY} onClick={savePromo} disabled={busy}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function SpaModule({ restaurantId, token, tab }: Props & { tab: string }) {
  switch (tab) {
    case 'SPA_CALENDAR': return <SpaAppointments restaurantId={restaurantId} token={token} calendar />;
    case 'SPA_APPOINTMENTS': return <SpaAppointments restaurantId={restaurantId} token={token} />;
    case 'SPA_CATALOG': return <SpaCatalog restaurantId={restaurantId} token={token} />;
    case 'SPA_RESOURCES': return <SpaResources restaurantId={restaurantId} token={token} />;
    case 'SPA_CLIENTS': return <SpaClients restaurantId={restaurantId} token={token} />;
    case 'SPA_PACKAGES': return <SpaPackages restaurantId={restaurantId} token={token} />;
    case 'SPA_REPORTS': return <SpaReports restaurantId={restaurantId} token={token} />;
    case 'SPA_BILLING': return <SpaFolios restaurantId={restaurantId} token={token} />;
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
  MASSAGE: '#b45309', FACIAL: '#7c3aed', BODY: '#047857', SAUNA: '#dc2626', SALON: '#db2777', WELLNESS: '#0284c7', DEFAULT: BRAND,
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
  const [date, setDate] = useState(istToday());
  const [slots, setSlots] = useState<any[]>([]);
  const [slot, setSlot] = useState<any>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [guest, setGuest] = useState({ client_name: '', client_phone: '', client_email: '' });
  // A therapist preference, and the guest's gender where a treatment or room is arranged by gender.
  const [genderPick, setGenderPick] = useState({ guest_gender: '', therapist_gender: '' });
  const [needsGender, setNeedsGender] = useState(false);
  const [done, setDone] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [failedImages, setFailedImages] = useState<Set<number>>(new Set());
  // Pay online through the property's gateway (owner's choices), or at the property.
  const { t: tPay } = useT();
  const payOptions = usePublicPayOptions(restaurantId);
  const [payChoice, setPayChoice] = useState<string>('');
  const [apptPaid, setApptPaid] = useState(false);
  const effectivePayChoice = !payOptions.online ? 'AT_PROPERTY'
    : payChoice || (payOptions.pay_full !== false ? 'FULL' : Number(payOptions.pay_advance_pct) > 0 ? 'ADVANCE' : 'AT_PROPERTY');

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
    const gq = `${genderPick.guest_gender ? `&guest_gender=${genderPick.guest_gender}` : ''}${genderPick.therapist_gender ? `&therapist_gender=${genderPick.therapist_gender}` : ''}`;
    fetch(`/api/public/restaurant/${restaurantId}/spa/availability?service_id=${service.id}&date=${date}${gq}`)
      .then(r => r.json()).then(b => { setSlots(b.slots || []); setNeedsGender(!!b.needs_guest_gender); }).catch(() => setSlots([])).finally(() => setSlotsLoading(false));
  }, [step, service, date, restaurantId, genderPick.guest_gender, genderPick.therapist_gender]);

  const submit = async () => {
    if (!slot || !guest.client_name || !guest.client_phone) return;
    setBusy(true); setError('');
    try {
      const r = await fetch(`/api/public/restaurant/${restaurantId}/spa/booking`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service_id: service.id, start_at: slot.start_at, therapist_id: slot.therapist_id, resource_id: slot.resource_id, assistant_ids: slot.assistant_ids, ...guest,
          client_gender: genderPick.guest_gender || undefined, therapist_gender_pref: genderPick.therapist_gender || undefined,
          pay_option: effectivePayChoice }),
      });
      const b = await r.json();
      if (!r.ok) {
        // The time went while the guest was filling in their details: back to the
        // times, which reload, saying which are still free.
        if (r.status === 409 && b.code === 'SLOT_UNAVAILABLE') {
          const alts: string[] = Array.isArray(b.alternatives) ? b.alternatives : [];
          setError(alts.length ? `That time was just taken. Still free that day: ${alts.join(', ')}.` : 'That time was just taken, and nothing else is free that day. Please choose another date.');
          setStep(2);
          return;
        }
        setError(b.error || 'Booking failed. Please try again.'); return;
      }
      setApptPaid(false);
      setDone(b);
    } catch { setError('Network error. Please check your connection.'); } finally { setBusy(false); }
  };

  // ── Palette & helpers ─────────────────────────────────────────────────────
  const SPA_DARK  = '#0d1f18';
  const SPA_GOLD  = '#c9a96e';
  const SPA_CREAM = '#f9f5ef';
  const SPA_BRAND = BRAND;
  const SERIF: React.CSSProperties = { fontFamily: "'Playfair Display', Georgia, serif" };
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtTime = (iso: string) => iso.slice(11, 16);
  const today = istToday();
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

  const resetFlow = () => { setDone(null); setStep(1); setService(null); setSlot(null); setSlots([]); setGuest({ client_name: '', client_phone: '', client_email: '' }); setGenderPick({ guest_gender: '', therapist_gender: '' }); setNeedsGender(false); setError(''); };

  // ── Confirmation screen ──────────────────────────────────────────────────
  if (done) return (
    <div style={{ minHeight: '100vh', background: SPA_CREAM, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ ...heroStyle, paddingTop: 56, paddingBottom: 72, textAlign: 'center', color: '#fff' }}>
        <div style={{ position: 'relative', height: 4, background: `linear-gradient(90deg, transparent, ${SPA_GOLD}, transparent)`, marginBottom: 0 }} />
        {data.property?.logo_url && <img src={data.property.logo_url} alt="" style={{ height: 48, margin: '0 auto 14px', borderRadius: 12, objectFit: 'contain', filter: 'brightness(0) invert(1)', opacity: 0.9 }} />}
        <h1 style={{ ...SERIF, fontSize: 26, fontWeight: 700, letterSpacing: -0.3 }}>{data.property?.name}</h1>
        <p style={{ color: SPA_GOLD, fontSize: 10, letterSpacing: 3, textTransform: 'uppercase', marginTop: 8, fontWeight: 600 }}>{data.property?.module_label || 'Spa & Wellness'}</p>
      </div>
      <div style={{ maxWidth: 440, margin: '-52px auto 0', padding: '0 16px 48px' }}>
        <div style={{ background: '#fff', borderRadius: 28, boxShadow: '0 20px 60px rgba(0,0,0,0.15)', overflow: 'hidden' }}>
          <div style={{ height: 4, background: `linear-gradient(90deg, ${SPA_GOLD}, #e8c07a, ${SPA_GOLD})` }} />
          <div style={{ padding: '32px 28px', textAlign: 'center' }}>
            <div style={{ width: 72, height: 72, borderRadius: '50%', background: '#f0faf5', border: '3px solid #d1f0e0', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
              <Check size={32} style={{ color: '#22a05a' }} />
            </div>
            <h2 style={{ ...SERIF, fontSize: 24, fontWeight: 700, color: '#0d1a14', marginBottom: 6 }}>
              {done.pay_token && !apptPaid ? tPay('pay.heldTitle') : 'Booking Confirmed!'}
            </h2>
            <p style={{ color: '#6b5d52', fontSize: 13 }}>
              {done.pay_token && !apptPaid ? tPay('pay.heldHintSpa') : done.pay_token ? tPay('pay.confirmedPaidHintSpa') : 'Your appointment has been received.'}
            </p>
            {done.pay_token && (
              <div style={{ marginTop: 16, textAlign: 'center' }} className="space-y-2">
                {!apptPaid && done.hold_until && <HoldCountdown until={done.hold_until} />}
                <PayOnlineButton
                  restaurantId={restaurantId}
                  token={done.pay_token}
                  label={done.pay_option === 'ADVANCE' ? tPay('pay.payAdvance') : tPay('pay.payFull')}
                  amountPaise={done.pay_amount_paise}
                  customer={{ name: guest.client_name, phone: guest.client_phone, email: guest.client_email }}
                  onPaid={() => setApptPaid(true)}
                />
              </div>
            )}
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
            <p style={{ fontSize: 10, opacity: 0.42, letterSpacing: 3, textTransform: 'uppercase', paddingTop: 16 }}>{data.property?.name} · {profile.tagline || data.property?.module_label || 'Spa & Wellness'}</p>
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
        {step === 2 && error && <div style={{ padding: '12px 16px', borderRadius: 12, background: '#fff5f5', border: '1px solid #fecaca', color: '#c0392b', fontSize: 12, marginBottom: 16 }}>{error}</div>}
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

            <div style={{ display: 'grid', gridTemplateColumns: needsGender || genderPick.guest_gender ? '1fr 1fr' : '1fr', gap: 8, marginBottom: 14 }}>
              <label style={{ display: 'block' }}>
                <span style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#5a4535', marginBottom: 4 }}>Therapist</span>
                <select value={genderPick.therapist_gender} onChange={e => { setGenderPick({ ...genderPick, therapist_gender: e.target.value }); setSlot(null); }} style={{ width: '100%', padding: '10px 12px', borderRadius: 12, border: '1.5px solid #ede5d8', background: '#fff', fontSize: 13, color: '#0d1a14', outline: 'none' }}>
                  <option value="">No preference</option><option value="FEMALE">Female therapist</option><option value="MALE">Male therapist</option>
                </select>
              </label>
              {(needsGender || genderPick.guest_gender) && (
                <label style={{ display: 'block' }}>
                  <span style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#5a4535', marginBottom: 4 }}>You are <span style={{ color: SPA_BRAND }}>*</span></span>
                  <select value={genderPick.guest_gender} onChange={e => { setGenderPick({ ...genderPick, guest_gender: e.target.value }); setSlot(null); }} style={{ width: '100%', padding: '10px 12px', borderRadius: 12, border: '1.5px solid #ede5d8', background: '#fff', fontSize: 13, color: '#0d1a14', outline: 'none' }}>
                    <option value="">Choose</option><option value="FEMALE">Female</option><option value="MALE">Male</option>
                  </select>
                </label>
              )}
            </div>
            {needsGender && !genderPick.guest_gender && (
              <p style={{ fontSize: 11, color: '#7a4f12', background: '#fdf6e9', border: '1px solid #f0dfbf', borderRadius: 10, padding: '8px 12px', marginBottom: 14 }}>
                Some of our therapies and rooms are arranged by gender. Tell us yours to see the times open to you.
              </p>
            )}

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
                {slot && !(needsGender && !genderPick.guest_gender) && (
                  <button onClick={() => { setError(''); setStep(3); }} style={{ width: '100%', marginTop: 20, padding: '15px 0', borderRadius: 18, color: SPA_GOLD, fontWeight: 700, fontSize: 14, background: `linear-gradient(135deg, ${SPA_DARK} 0%, #1a3828 100%)`, border: 'none', cursor: 'pointer', boxShadow: '0 4px 16px rgba(13,31,24,0.3)', letterSpacing: 0.3 }}>
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

            {payOptions.online && service && (
              <div style={{ marginBottom: 16 }}>
                <PayChoicePicker options={payOptions} value={effectivePayChoice} onChange={setPayChoice}
                  totalPaise={Math.round(Number(service.price || 0) * (1 + Number(service.gst_percent ?? 18) / 100) * 100)} />
              </div>
            )}

            {error && <div style={{ padding: '12px 16px', borderRadius: 12, background: '#fff5f5', border: '1px solid #fecaca', color: '#c0392b', fontSize: 12, marginBottom: 16 }}>{error}</div>}

            <button onClick={submit} disabled={busy || !guest.client_name || !guest.client_phone}
              style={{ width: '100%', marginTop: 8, padding: '15px 0', borderRadius: 18, fontWeight: 700, fontSize: 14, border: 'none', cursor: busy || !guest.client_name || !guest.client_phone ? 'not-allowed' : 'pointer', transition: 'all 0.2s', background: busy || !guest.client_name || !guest.client_phone ? '#d6c9be' : `linear-gradient(135deg, ${SPA_DARK} 0%, #1a3828 100%)`, color: busy || !guest.client_name || !guest.client_phone ? '#a09080' : SPA_GOLD, boxShadow: busy || !guest.client_name || !guest.client_phone ? 'none' : '0 4px 16px rgba(13,31,24,0.28)', letterSpacing: 0.3 }}>
              {busy ? 'Booking your appointment…' : effectivePayChoice === 'AT_PROPERTY' ? '✦ Confirm Booking' : `✦ ${tPay('pay.continueToPayment')}`}
            </button>
            {effectivePayChoice === 'AT_PROPERTY' && <p style={{ textAlign: 'center', fontSize: 11, color: '#b0a090', marginTop: 12 }}>No payment required today. Cancellation policy applies.</p>}
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
