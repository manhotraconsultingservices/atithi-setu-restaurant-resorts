import { useState, useEffect, useCallback } from 'react';

// ── Owner-facing configuration for the Configurable Checklist Templates feature.
// Categories → named templates → ordered steps → per-entity assignments. Staff
// execute the resulting jobs in the Housekeeping worklist; here the owner defines
// WHAT the checklists are, WHEN they trigger, and WHERE they apply.

type FacilityScope = 'ROOM' | 'EVENT' | 'ALL';
// facilityScope lets the same editor be mounted per module: hotel/OMS shows ROOM +
// GENERIC checklists, Events & Convention shows EVENT checklists. 'ALL' = owner/
// SuperAdmin view (everything). Defaults to 'ALL' for backward compatibility.
type Props = { restaurantId: string; token: string; facilityScope?: FacilityScope };

const scopeTypes = (scope: FacilityScope): string[] =>
  scope === 'ROOM' ? ['ROOM', 'GENERIC'] : scope === 'EVENT' ? ['EVENT'] : ['ROOM', 'EVENT', 'RESTAURANT', 'SPA', 'GENERIC'];

// The facility_type a scope maps categories to ('ALL' = the owner / all-modules view).
const scopeFacilityType = (scope: FacilityScope): string =>
  scope === 'EVENT' ? 'EVENT' : scope === 'ROOM' ? 'ROOM' : 'ALL';
// A category shows in a scope when it's cross-module ('ALL' / unset) or matches it —
// so PMS templates only offer PMS categories and Events only offers Event categories.
const catInScope = (c: any, scope: FacilityScope): boolean => {
  const s = scopeFacilityType(scope);
  if (s === 'ALL') return true;
  const cf = String(c?.facility_type || 'ALL').toUpperCase();
  return cf === 'ALL' || cf === s;
};

const TRIGGERS: { v: string; label: string; hint: string; ft: string[] }[] = [
  // Booking lifecycle (hotel rooms)
  { v: 'BOOKING_NEW', label: 'On new booking', hint: 'Raised the moment a booking is created — non-blocking', ft: ['ROOM'] },
  { v: 'BOOKING_ASSIGNED', label: 'On room assigned', hint: 'Raised when a room is assigned / reassigned to a booking — non-blocking', ft: ['ROOM'] },
  { v: 'CHECK_IN', label: 'On check-in', hint: 'Raised when a guest checks into the room', ft: ['ROOM'] },
  { v: 'CHECK_OUT', label: 'On check-out', hint: 'Raised when the room is checked out', ft: ['ROOM'] },
  { v: 'MID_STAY', label: 'Mid-stay / overstay (recurring)', hint: 'Every N nights of an in-house stay (owner cadence)', ft: ['ROOM'] },
  { v: 'CLEANING', label: 'Room cleaning (recurring)', hint: 'During a stay at the per-booking cadence the front desk sets at check-in', ft: ['ROOM'] },
  { v: 'DAILY', label: 'Daily (each morning)', hint: 'Auto-raised every morning per facility / module (if that module is enabled)', ft: ['ROOM', 'EVENT', 'RESTAURANT', 'SPA', 'GENERIC'] },
  { v: 'EVENT_COMPLETE', label: 'On event completion', hint: 'Raised when an event is marked complete', ft: ['EVENT'] },
  { v: 'MANUAL', label: 'Manual / on-demand', hint: 'Started by staff when needed (inspections, audits)', ft: ['ROOM', 'EVENT', 'RESTAURANT', 'SPA', 'GENERIC'] },
  // Room status changes — all NON-BLOCKING (never gate a business operation)
  { v: 'ROOM_VACANT', label: 'When room → Vacant', hint: 'Raised when the room becomes vacant / ready — non-blocking', ft: ['ROOM'] },
  { v: 'ROOM_OCCUPIED', label: 'When room → Occupied', hint: 'Raised when the room becomes occupied — non-blocking', ft: ['ROOM'] },
  { v: 'ROOM_CLEANING', label: 'When room → Cleaning', hint: 'Raised when the room goes to cleaning — non-blocking', ft: ['ROOM'] },
  { v: 'ROOM_MAINTENANCE', label: 'When room → Maintenance', hint: 'Raised when the room goes to maintenance — non-blocking', ft: ['ROOM'] },
  { v: 'ROOM_BLOCKED', label: 'When room → Blocked', hint: 'Raised when the room is blocked — non-blocking', ft: ['ROOM'] },
  // Event-hall status changes — all NON-BLOCKING
  { v: 'VENUE_VACANT', label: 'When hall → Vacant', hint: 'Raised when the hall becomes vacant / ready — non-blocking', ft: ['EVENT'] },
  { v: 'VENUE_OCCUPIED', label: 'When hall → Occupied', hint: 'Raised when the hall becomes occupied / in use — non-blocking', ft: ['EVENT'] },
  { v: 'VENUE_CLEANING', label: 'When hall → Cleaning', hint: 'Raised when the hall goes to cleaning — non-blocking', ft: ['EVENT'] },
  { v: 'VENUE_MAINTENANCE', label: 'When hall → Maintenance', hint: 'Raised when the hall goes to maintenance — non-blocking', ft: ['EVENT'] },
  { v: 'VENUE_BLOCKED', label: 'When hall → Blocked', hint: 'Raised when the hall is blocked — non-blocking', ft: ['EVENT'] },
];
const FTYPES = [{ v: 'ROOM', label: 'Hotel room' }, { v: 'EVENT', label: 'Event hall' }, { v: 'RESTAURANT', label: 'Restaurant' }, { v: 'SPA', label: 'Spa & Wellness' }, { v: 'GENERIC', label: 'Generic' }];
const trgLabel = (v: string) => TRIGGERS.find(t => t.v === v)?.label || v;

function makeApi(restaurantId: string, token: string) {
  return async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`/api/restaurant/${restaurantId}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { const err: any = new Error((b && b.error) || `HTTP ${r.status}`); err.status = r.status; err.data = b; throw err; }
    return b;
  };
}

const BTN = 'px-3 py-1.5 bg-[#a0522d] text-white text-sm rounded hover:bg-[#8b4513] disabled:opacity-40';
const GHOST = 'px-3 py-1.5 border border-[#d4c4a8] text-sm rounded hover:bg-[#f5f0e8]';
const INPUT = 'text-sm border border-[#d4c4a8] rounded px-2 py-1.5 bg-white focus:outline-none focus:border-[#a0522d]';

// The "small setting": per-module on/off toggles so the owner decides which
// modules run checklists — no code change. Only shows modules this tenant runs.
const MODULE_META: { key: string; label: string; desc: string }[] = [
  { key: 'RESTAURANT', label: 'Restaurant', desc: 'Opening / closing & inspection checklists for the outlet' },
  { key: 'HOTEL', label: 'Hotel', desc: 'Room check-in / out, daily & mid-stay checklists' },
  { key: 'SPA', label: 'Spa & Wellness', desc: 'Daily upkeep & inspection checklists for the spa' },
  { key: 'EVENTS', label: 'Events', desc: 'Venue daily & post-event handover checklists' },
];
function ModuleToggles({ api }: { api: (p: string, i?: RequestInit) => Promise<any> }) {
  const [settings, setSettings] = useState<Record<string, boolean> | null>(null);
  const [present, setPresent] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState('');
  useEffect(() => { api('/checklists/settings').then((d: any) => { setSettings(d.settings || {}); setPresent(d.present || {}); }).catch(() => {}); }, [api]);
  const toggle = async (m: string) => {
    if (!settings) return;
    const next = !settings[m];
    setBusy(m); setSettings({ ...settings, [m]: next });
    try { const d = await api('/checklists/settings', { method: 'PATCH', body: JSON.stringify({ [m]: next }) }); setSettings(d.settings || {}); }
    catch { setSettings({ ...settings, [m]: !next }); }
    finally { setBusy(''); }
  };
  if (!settings) return null;
  const mods = MODULE_META.filter(m => present[m.key]);
  if (mods.length === 0) return null;
  return (
    <div className="rounded-xl border border-[#e8ded0] bg-[#faf7f2] p-4">
      <p className="text-xs font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Where checklists run</p>
      <p className="text-[12px] text-[#9c8e85] mb-3">Turn checklists on or off per module. Off = no daily or on-demand checklists are raised for that module.</p>
      <div className="grid sm:grid-cols-2 gap-2">
        {mods.map(m => (
          <div key={m.key} className="flex items-start gap-3 rounded-lg border border-[#e8ded0] bg-white px-3 py-2.5">
            <button type="button" onClick={() => toggle(m.key)} disabled={busy === m.key} aria-label={`Toggle ${m.label} checklists`}
              className={`mt-0.5 relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${settings[m.key] ? 'bg-[#a0522d]' : 'bg-[#d4c4a8]'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings[m.key] ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </button>
            <span>
              <span className="text-sm font-semibold text-[#1a1208]">{m.label}</span>
              <span className={`ml-2 text-[10px] font-bold ${settings[m.key] ? 'text-emerald-700' : 'text-[#9c8e85]'}`}>{settings[m.key] ? 'ON' : 'OFF'}</span>
              <span className="block text-[11px] text-[#9c8e85] mt-0.5">{m.desc}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChecklistTemplates({ restaurantId, token, facilityScope = 'ALL' }: Props) {
  const api = useCallback(makeApi(restaurantId, token), [restaurantId, token]);
  const [tab, setTab] = useState<'TEMPLATES' | 'CATEGORIES'>('TEMPLATES');
  const [cats, setCats] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<any | null>(null); // full template (with steps/assignments) or a NEW blank
  const [err, setErr] = useState('');

  const allowed = scopeTypes(facilityScope);
  const shown = templates.filter(t => allowed.includes(String(t.facility_type)));
  const defaultFType = facilityScope === 'EVENT' ? 'EVENT' : 'ROOM';
  const defaultTrigger = facilityScope === 'EVENT' ? 'EVENT_COMPLETE' : 'CHECK_OUT';
  const heading = facilityScope === 'EVENT' ? 'Event Checklist Templates'
    : facilityScope === 'ROOM' ? 'Hotel Checklist Templates' : 'Checklist Templates';
  const subheading = facilityScope === 'EVENT'
    ? 'Checklists for event halls & venues — setup, daily upkeep, and post-event handover. Staff run them from the Events cleaning worklist.'
    : facilityScope === 'ROOM'
      ? 'Checklists for hotel rooms & general facilities — check-in, housekeeping, mid-stay, and inspections. Staff run them from Housekeeping.'
      : 'Define reusable checklists, when they trigger, and where they apply. Staff run them from Housekeeping.';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, t] = await Promise.all([api('/checklists/categories'), api('/checklists/templates')]);
      setCats(Array.isArray(c) ? c : []);
      setTemplates(Array.isArray(t) ? t : []);
    } catch (e: any) { setErr(e?.message || 'Failed to load'); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const catName = (id: string) => cats.find(c => c.id === id)?.name || '—';
  // Active categories relevant to this module (PMS vs Event) — used as defaults.
  const inScopeActiveCats = cats.filter(c => Number(c.is_active) === 1 && catInScope(c, facilityScope));

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-3xl font-bold font-serif text-[#1a1208]">{heading}</h2>
        <p className="text-sm text-[#6b5d52] mt-1">{subheading}</p>
      </div>

      {facilityScope === 'ALL' && <ModuleToggles api={api} />}

      <div className="flex gap-0 border-b border-[#e8ded0]">
        {(['TEMPLATES', 'CATEGORIES'] as const).map(t => (
          <button key={t} onClick={() => { setTab(t); setEditing(null); }}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t ? 'border-[#a0522d] text-[#a0522d]' : 'border-transparent text-[#6b5d52] hover:text-[#a0522d]'}`}>
            {t === 'TEMPLATES' ? 'Templates' : 'Categories'}
          </button>
        ))}
      </div>

      {err && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">{err}</div>}

      {tab === 'CATEGORIES' && <CategoriesPanel api={api} cats={cats} reload={load} facilityScope={facilityScope} />}

      {tab === 'TEMPLATES' && !editing && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-[#6b5d52]">{shown.length} template{shown.length === 1 ? '' : 's'}</p>
            <button onClick={() => setEditing({ __new: true, name: '', category_id: inScopeActiveCats[0]?.id || '', facility_type: defaultFType, trigger_event: defaultTrigger, blocks_release: 0, recurrence_nights: 1, steps: [], assignments: [] })} className={BTN}>+ New template</button>
          </div>
          {loading ? <p className="text-sm text-[#6b5d52]">Loading…</p> : shown.length === 0 ? (
            <p className="text-sm text-[#6b5d52] italic">No templates yet. Create one, or the default check-out checklists will show here.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-[#e8ded0]">
              <table className="w-full text-sm border-collapse">
                <thead><tr className="bg-[#f5f0e8] text-left">
                  <th className="px-3 py-2 font-semibold text-[#1a1208]">Template</th>
                  <th className="px-3 py-2 font-semibold text-[#1a1208]">Category</th>
                  <th className="px-3 py-2 font-semibold text-[#1a1208]">Applies to</th>
                  <th className="px-3 py-2 font-semibold text-[#1a1208]">Trigger</th>
                  <th className="px-3 py-2 font-semibold text-[#1a1208] text-center">Steps</th>
                  <th className="px-3 py-2 font-semibold text-[#1a1208] text-center">Blocks release</th>
                  <th className="px-3 py-2 font-semibold text-[#1a1208] text-center">Status</th>
                  <th className="px-3 py-2"></th>
                </tr></thead>
                <tbody>
                  {shown.map(t => (
                    <tr key={t.id} className={`border-t border-[#f0e8d8] hover:bg-[#fdf8f0] ${Number(t.is_active) === 0 ? 'opacity-50' : ''}`}>
                      <td className="px-3 py-2 font-medium">{t.name}{t.is_system ? <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-[#f0e8d8] text-[#6b5d52]">system</span> : null}</td>
                      <td className="px-3 py-2 text-[#6b5d52]">{catName(t.category_id)}</td>
                      <td className="px-3 py-2">{FTYPES.find(f => f.v === t.facility_type)?.label || t.facility_type}{Number(t.assignment_count) > 0 ? <span className="ml-1 text-[11px] text-[#a0522d]">· {t.assignment_count} specific</span> : <span className="ml-1 text-[11px] text-[#9c8e85]">· all</span>}</td>
                      <td className="px-3 py-2 text-[#6b5d52]">{trgLabel(t.trigger_event)}{t.trigger_event === 'MID_STAY' ? ` (every ${t.recurrence_nights}n)` : ''}</td>
                      <td className="px-3 py-2 text-center tabular-nums">{t.step_count}</td>
                      <td className="px-3 py-2 text-center">{Number(t.blocks_release) === 1 ? <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-50 text-rose-600">YES</span> : <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#f0e8d8] text-[#6b5d52]">no</span>}</td>
                      <td className="px-3 py-2 text-center">{Number(t.is_active) === 0
                        ? <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-stone-100 text-stone-500">Inactive</span>
                        : <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">Active</span>}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button onClick={async () => { try { setEditing(await api(`/checklists/templates/${t.id}`)); } catch (e: any) { setErr(e?.message); } }} className="text-xs px-2 py-1 border border-[#d4c4a8] rounded hover:bg-[#f5f0e8]">Edit</button>
                        {/* Activate / Deactivate — only ACTIVE templates are ever triggered. Works for
                            system templates too (deactivate to stop the default checklist firing). */}
                        <button onClick={async () => { try { await api(`/checklists/templates/${t.id}`, { method: 'PATCH', body: JSON.stringify({ is_active: Number(t.is_active) === 0 ? 1 : 0 }) }); load(); } catch (e: any) { setErr(e?.message); } }}
                          className={`ml-1 text-xs px-2 py-1 border rounded ${Number(t.is_active) === 0 ? 'border-emerald-300 text-emerald-700 hover:bg-emerald-50' : 'border-[#d4c4a8] text-[#6b5d52] hover:bg-[#f5f0e8]'}`}>
                          {Number(t.is_active) === 0 ? 'Activate' : 'Deactivate'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'TEMPLATES' && editing && (
        <TemplateEditor api={api} cats={cats} restaurantId={restaurantId} token={token} facilityScope={facilityScope}
          initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} onError={setErr} />
      )}
    </div>
  );
}

// ── Categories ─────────────────────────────────────────────────────────────
function CategoriesPanel({ api, cats, reload, facilityScope = 'ALL' }: { api: any; cats: any[]; reload: () => void; facilityScope?: FacilityScope }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const shownCats = cats.filter(c => catInScope(c, facilityScope)); // only this module's categories
  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    // New categories are scoped to the module they're created in (PMS vs Event).
    try { await api('/checklists/categories', { method: 'POST', body: JSON.stringify({ name: name.trim(), facility_type: scopeFacilityType(facilityScope) }) }); setName(''); reload(); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-end gap-2">
        <div className="flex-1"><label className="text-xs text-[#6b5d52] block">New category</label><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Kitchen / Pool / Safety" className={INPUT + ' w-full'} /></div>
        <button onClick={add} disabled={busy || !name.trim()} className={BTN}>Add</button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-[#e8ded0]">
        <table className="w-full text-sm border-collapse">
          <thead><tr className="bg-[#f5f0e8] text-left"><th className="px-3 py-2 font-semibold text-[#1a1208]">Category</th><th className="px-3 py-2 font-semibold text-[#1a1208]">Status</th><th className="px-3 py-2"></th></tr></thead>
          <tbody>
            {shownCats.map(c => (
              <tr key={c.id} className="border-t border-[#f0e8d8]">
                <td className="px-3 py-2 font-medium">{c.name}{c.is_system ? <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-[#f0e8d8] text-[#6b5d52]">system</span> : null}</td>
                <td className="px-3 py-2">{Number(c.is_active) === 1 ? <span className="text-emerald-700 text-xs">Active</span> : <span className="text-[#9c8e85] text-xs">Inactive</span>}</td>
                <td className="px-3 py-2 text-right">{!c.is_system && Number(c.is_active) === 1 && <button onClick={async () => { await api(`/checklists/categories/${c.id}`, { method: 'DELETE' }); reload(); }} className="text-xs px-2 py-1 border border-rose-200 text-rose-600 rounded hover:bg-rose-50">Deactivate</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Template editor (fields + steps + assignments) ───────────────────────────
function TemplateEditor({ api, cats, restaurantId, token, facilityScope = 'ALL', initial, onClose, onSaved, onError }:
  { api: any; cats: any[]; restaurantId: string; token: string; facilityScope?: FacilityScope; initial: any; onClose: () => void; onSaved: () => void; onError: (s: string) => void }) {
  const isNew = !!initial.__new;
  const ftypeOpts = FTYPES.filter(f => scopeTypes(facilityScope).includes(f.v));
  const [form, setForm] = useState<any>({
    name: initial.name || '', category_id: initial.category_id || (cats.filter(c => catInScope(c, facilityScope))[0]?.id || ''),
    facility_type: initial.facility_type || (facilityScope === 'EVENT' ? 'EVENT' : 'ROOM'), trigger_event: initial.trigger_event || 'CHECK_OUT',
    blocks_release: Number(initial.blocks_release) === 1, recurrence_nights: Number(initial.recurrence_nights) || 1,
    notes: initial.notes || '',
  });
  const [steps, setSteps] = useState<any[]>(initial.steps ? initial.steps.map((s: any) => ({ ...s })) : []);
  const [assignments, setAssignments] = useState<any[]>(initial.assignments || []);
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  const tid = initial.id;

  const addStep = () => setSteps(s => [...s, { __local: Math.random().toString(36).slice(2), label: '', is_mandatory: 1, sort_order: s.length }]);
  const setStep = (i: number, k: string, v: any) => setSteps(s => s.map((x, idx) => idx === i ? { ...x, [k]: v } : x));
  const rmStep = async (i: number) => {
    const st = steps[i];
    if (tid && st.id) { try { await api(`/checklists/templates/${tid}/steps/${st.id}`, { method: 'DELETE' }); } catch (e: any) { onError(e?.message); return; } }
    setSteps(s => s.filter((_, idx) => idx !== i));
  };

  const save = async () => {
    if (!form.name.trim()) { onError('Template name is required'); return; }
    const cleanSteps = steps.filter(s => String(s.label || '').trim()).map((s, i) => ({ label: String(s.label).trim(), is_mandatory: s.is_mandatory ? true : false, sort_order: i }));
    setSaving(true);
    try {
      if (isNew) {
        await api('/checklists/templates', { method: 'POST', body: JSON.stringify({ ...form, blocks_release: form.blocks_release, recurrence_nights: form.recurrence_nights, steps: cleanSteps }) });
      } else {
        await api(`/checklists/templates/${tid}`, { method: 'PATCH', body: JSON.stringify({ name: form.name, category_id: form.category_id, facility_type: form.facility_type, trigger_event: form.trigger_event, blocks_release: form.blocks_release, recurrence_nights: form.recurrence_nights, notes: form.notes }) });
        // Sync steps: existing rows PATCH, new rows POST (deletes handled inline).
        for (let i = 0; i < steps.length; i++) {
          const s = steps[i]; const label = String(s.label || '').trim(); if (!label) continue;
          if (s.id) await api(`/checklists/templates/${tid}/steps/${s.id}`, { method: 'PATCH', body: JSON.stringify({ label, is_mandatory: !!s.is_mandatory, sort_order: i }) });
          else await api(`/checklists/templates/${tid}/steps`, { method: 'POST', body: JSON.stringify({ label, is_mandatory: !!s.is_mandatory, sort_order: i }) });
        }
      }
      onSaved();
    } catch (e: any) { onError(e?.message || 'Failed to save'); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-center justify-between">
        <h3 className="text-xl font-bold text-[#1a1208]">{isNew ? 'New template' : `Edit — ${initial.name}`}</h3>
        <button onClick={onClose} className={GHOST}>← Back</button>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div><label className="text-xs text-[#6b5d52] block mb-1">Name</label><input value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. PMS - Check-Out" className={INPUT + ' w-full'} /></div>
        <div><label className="text-xs text-[#6b5d52] block mb-1">Category</label><select value={form.category_id} onChange={e => set('category_id', e.target.value)} className={INPUT + ' w-full'}>{cats.filter(c => Number(c.is_active) === 1 && catInScope(c, facilityScope)).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div><label className="text-xs text-[#6b5d52] block mb-1">Facility type</label><select value={form.facility_type} onChange={e => set('facility_type', e.target.value)} disabled={!!initial.is_system} className={INPUT + ' w-full disabled:bg-[#f5f0e8]'}>{ftypeOpts.map(f => <option key={f.v} value={f.v}>{f.label}</option>)}</select></div>
        <div><label className="text-xs text-[#6b5d52] block mb-1">Trigger</label><select value={form.trigger_event} onChange={e => set('trigger_event', e.target.value)} disabled={!!initial.is_system} className={INPUT + ' w-full disabled:bg-[#f5f0e8]'}>{TRIGGERS.filter(t => t.ft.includes(form.facility_type)).map(t => <option key={t.v} value={t.v}>{t.label}</option>)}</select><p className="text-[11px] text-[#9c8e85] mt-1">{TRIGGERS.find(t => t.v === form.trigger_event)?.hint}</p></div>
        {form.trigger_event === 'MID_STAY' && (
          <div><label className="text-xs text-[#6b5d52] block mb-1">Repeat every (nights)</label><input type="number" min={1} value={form.recurrence_nights} onChange={e => set('recurrence_nights', Math.max(1, Number(e.target.value) || 1))} className={INPUT + ' w-full'} /></div>
        )}
        <div className="flex items-end"><label className="flex items-center gap-2 text-sm text-[#6b5d52]"><input type="checkbox" checked={form.blocks_release} onChange={e => set('blocks_release', e.target.checked)} /> Blocks facility release until complete</label></div>
      </div>

      {/* Steps */}
      <div className="rounded-lg border border-[#e8ded0] bg-white p-4">
        <div className="flex items-center justify-between mb-2"><p className="text-sm font-semibold text-[#1a1208]">Checklist steps</p><button onClick={addStep} className={GHOST}>+ Add step</button></div>
        {steps.length === 0 ? <p className="text-sm text-[#9c8e85] italic">No steps yet — add the tasks staff must tick off.</p> : (
          <div className="space-y-2">
            {steps.map((s, i) => (
              <div key={s.id || s.__local || i} className="flex items-center gap-2">
                <span className="text-xs text-[#9c8e85] w-6 text-right tabular-nums">{i + 1}.</span>
                <input value={s.label} onChange={e => setStep(i, 'label', e.target.value)} placeholder="Step description" className={INPUT + ' flex-1'} />
                <label className="flex items-center gap-1 text-xs text-[#6b5d52] whitespace-nowrap"><input type="checkbox" checked={!!s.is_mandatory} onChange={e => setStep(i, 'is_mandatory', e.target.checked ? 1 : 0)} /> mandatory</label>
                <button onClick={() => rmStep(i)} className="text-rose-600 text-sm px-2">✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Assignments (only meaningful once the template exists) */}
      {!isNew && (
        <AssignmentsPanel api={api} restaurantId={restaurantId} token={token} facilityScope={facilityScope} template={initial} assignments={assignments} setAssignments={setAssignments} onError={onError} />
      )}

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving} className={BTN}>{saving ? 'Saving…' : (isNew ? 'Create template' : 'Save changes')}</button>
        <button onClick={onClose} className={GHOST}>Cancel</button>
        {isNew && <span className="text-[11px] text-[#9c8e85]">Save first, then you can target specific rooms / halls.</span>}
      </div>
    </div>
  );
}

// ── Assignments (per-entity targeting) ───────────────────────────────────────
// "Applies to" is either ALL facilities of the template's type (no assignment
// rows = the default), OR a specific set. Owners can multi-select several rooms /
// halls at once, or revert to "all" with one click. Target types are scoped to
// the template's facility_type (event templates target venues only, etc.).
function AssignmentsPanel({ api, restaurantId, token, facilityScope = 'ALL', template, assignments, setAssignments, onError }:
  { api: any; restaurantId: string; token: string; facilityScope?: FacilityScope; template: any; assignments: any[]; setAssignments: (a: any[]) => void; onError: (s: string) => void }) {
  const ftype = String(template.facility_type || (facilityScope === 'EVENT' ? 'EVENT' : 'ROOM'));
  const targetTypes = ftype === 'EVENT' ? ['VENUE'] : ftype === 'ROOM' ? ['ROOM', 'ROOM_TYPE'] : ['ROOM', 'ROOM_TYPE', 'VENUE'];
  const TARGET_LABEL: Record<string, string> = { ROOM: 'Specific rooms', ROOM_TYPE: 'Room types', VENUE: 'Event halls' };
  const facilityNoun = ftype === 'EVENT' ? 'event halls' : ftype === 'ROOM' ? 'rooms' : 'facilities';
  const [scope, setScope] = useState(targetTypes[0]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [rooms, setRooms] = useState<any[]>([]);
  const [types, setTypes] = useState<any[]>([]);
  const [venues, setVenues] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const api2 = makeApi(restaurantId, token);

  useEffect(() => {
    (async () => {
      try { const r = await api2('/hotel/rooms'); setRooms(Array.isArray(r) ? r : (r?.rooms || [])); } catch { /* hotel may be off */ }
      try { const t = await api2('/hotel/room-types'); setTypes(Array.isArray(t) ? t : (t?.types || [])); } catch { /* */ }
      try { const v = await api2('/events/venues'); setVenues(Array.isArray(v) ? v : (v?.venues || [])); } catch { /* events may be off */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const poolFor = (s: string) => s === 'ROOM' ? rooms : s === 'ROOM_TYPE' ? types : venues;
  const optLabel = (s: string, x: any) => x.name || (s === 'ROOM' && x.room_number ? `Room ${x.room_number}` : x.id);
  const opts = poolFor(scope).map((x: any) => ({ id: x.id, label: optLabel(scope, x) }));
  const assignedIds = new Set(assignments.filter(a => a.scope === scope).map(a => a.scope_id));
  const selectable = opts.filter((o: any) => !assignedIds.has(o.id));
  const labelFor = (a: any) => { const hit = poolFor(a.scope).find((x: any) => x.id === a.scope_id); return hit ? optLabel(a.scope, hit) : a.scope_id; };

  const toggle = (id: string) => setChecked(c => { const n = new Set(c); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSel = selectable.length > 0 && selectable.every((o: any) => checked.has(o.id));
  const toggleAll = () => setChecked(c => { const n = new Set(c); if (allSel) selectable.forEach((o: any) => n.delete(o.id)); else selectable.forEach((o: any) => n.add(o.id)); return n; });
  const pickedCount = [...checked].filter(id => selectable.some((o: any) => o.id === id)).length;

  const addSelected = async () => {
    const ids = selectable.filter((o: any) => checked.has(o.id)).map((o: any) => o.id);
    if (!ids.length) return;
    setBusy(true);
    try {
      const added: any[] = [];
      for (const scope_id of ids) added.push(await api(`/checklists/assignments`, { method: 'POST', body: JSON.stringify({ template_id: template.id, scope, scope_id }) }));
      setAssignments([...assignments.filter(a => !added.some(r => r.id === a.id)), ...added]);
      setChecked(new Set());
    } catch (e: any) { onError(e?.message); }
    finally { setBusy(false); }
  };
  const remove = async (aid: string) => { try { await api(`/checklists/assignments/${aid}`, { method: 'DELETE' }); setAssignments(assignments.filter(a => a.id !== aid)); } catch (e: any) { onError(e?.message); } };
  const clearAll = async () => {
    if (!assignments.length) return;
    if (!window.confirm(`Apply this checklist to ALL ${facilityNoun}? This removes the ${assignments.length} specific target${assignments.length === 1 ? '' : 's'} below.`)) return;
    setBusy(true);
    try { for (const a of assignments) await api(`/checklists/assignments/${a.id}`, { method: 'DELETE' }); setAssignments([]); }
    catch (e: any) { onError(e?.message); }
    finally { setBusy(false); }
  };
  const isAll = assignments.length === 0;

  return (
    <div className="rounded-lg border border-[#e8ded0] bg-white p-4">
      <p className="text-sm font-semibold text-[#1a1208]">Applies to</p>
      <div className="flex items-center gap-2 mt-2 mb-3 flex-wrap">
        <span className={`text-xs px-2 py-1 rounded-full ${isAll ? 'bg-emerald-50 text-emerald-700 font-semibold' : 'bg-[#f0e8d8] text-[#6b5d52]'}`}>
          {isAll ? `✓ All ${facilityNoun} of this type` : `${assignments.length} specific target${assignments.length === 1 ? '' : 's'}`}
        </span>
        {!isAll && <button onClick={clearAll} disabled={busy} className="text-xs px-2 py-1 border border-[#d4c4a8] rounded hover:bg-[#f5f0e8]">Apply to all instead</button>}
      </div>

      {assignments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {assignments.map(a => (
            <span key={a.id} className="inline-flex items-center gap-1 text-xs bg-[#f0e8d8] text-[#6b5d52] rounded-full px-2 py-1">
              {a.scope === 'ROOM' ? 'Room' : a.scope === 'ROOM_TYPE' ? 'Type' : 'Hall'}: {labelFor(a)}
              <button onClick={() => remove(a.id)} className="text-rose-600 ml-1">✕</button>
            </span>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-[#6b5d52]">Add specific</label>
          {targetTypes.length > 1 ? (
            <select value={scope} onChange={e => { setScope(e.target.value); setChecked(new Set()); }} className={INPUT}>
              {targetTypes.map(tt => <option key={tt} value={tt}>{TARGET_LABEL[tt]}</option>)}
            </select>
          ) : <span className="text-xs font-medium text-[#1a1208]">{TARGET_LABEL[scope]}</span>}
          {selectable.length > 0 && <button onClick={toggleAll} className="text-[11px] text-[#a0522d] underline">{allSel ? 'Clear' : 'Select all'}</button>}
        </div>
        {selectable.length === 0 ? (
          <p className="text-xs text-[#9c8e85] italic">{opts.length === 0 ? 'None available (module may be off, or none created yet).' : 'All already assigned.'}</p>
        ) : (
          <div className="max-h-44 overflow-y-auto rounded border border-[#e8ded0] divide-y divide-[#f0e8d8]">
            {selectable.map((o: any) => (
              <label key={o.id} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-[#fdf8f0] cursor-pointer">
                <input type="checkbox" checked={checked.has(o.id)} onChange={() => toggle(o.id)} /> {o.label}
              </label>
            ))}
          </div>
        )}
        <button onClick={addSelected} disabled={busy || pickedCount === 0} className={GHOST}>Add selected{pickedCount ? ` (${pickedCount})` : ''}</button>
      </div>
    </div>
  );
}
