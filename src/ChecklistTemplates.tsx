import { useState, useEffect, useCallback } from 'react';

// ── Owner-facing configuration for the Configurable Checklist Templates feature.
// Categories → named templates → ordered steps → per-entity assignments. Staff
// execute the resulting jobs in the Housekeeping worklist; here the owner defines
// WHAT the checklists are, WHEN they trigger, and WHERE they apply.

type Props = { restaurantId: string; token: string };

const TRIGGERS: { v: string; label: string; hint: string }[] = [
  { v: 'CHECK_IN', label: 'On check-in', hint: 'Raised when a guest checks into the room' },
  { v: 'CHECK_OUT', label: 'On check-out', hint: 'Raised when the room is checked out' },
  { v: 'MID_STAY', label: 'Mid-stay (recurring)', hint: 'Every N nights of an in-house stay' },
  { v: 'DAILY', label: 'Daily (each morning)', hint: 'Auto-raised every morning per facility' },
  { v: 'EVENT_COMPLETE', label: 'On event completion', hint: 'Raised when an event is marked complete' },
  { v: 'MANUAL', label: 'Manual / on-demand', hint: 'Started by staff when needed (inspections, audits)' },
];
const FTYPES = [{ v: 'ROOM', label: 'Hotel room' }, { v: 'EVENT', label: 'Event hall' }, { v: 'GENERIC', label: 'Generic' }];
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

export function ChecklistTemplates({ restaurantId, token }: Props) {
  const api = useCallback(makeApi(restaurantId, token), [restaurantId, token]);
  const [tab, setTab] = useState<'TEMPLATES' | 'CATEGORIES'>('TEMPLATES');
  const [cats, setCats] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<any | null>(null); // full template (with steps/assignments) or a NEW blank
  const [err, setErr] = useState('');

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

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-3xl font-bold font-serif text-[#1a1208]">Checklist Templates</h2>
        <p className="text-sm text-[#6b5d52] mt-1">Define reusable checklists, when they trigger, and where they apply. Staff run them from Housekeeping.</p>
      </div>

      <div className="flex gap-0 border-b border-[#e8ded0]">
        {(['TEMPLATES', 'CATEGORIES'] as const).map(t => (
          <button key={t} onClick={() => { setTab(t); setEditing(null); }}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t ? 'border-[#a0522d] text-[#a0522d]' : 'border-transparent text-[#6b5d52] hover:text-[#a0522d]'}`}>
            {t === 'TEMPLATES' ? 'Templates' : 'Categories'}
          </button>
        ))}
      </div>

      {err && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">{err}</div>}

      {tab === 'CATEGORIES' && <CategoriesPanel api={api} cats={cats} reload={load} />}

      {tab === 'TEMPLATES' && !editing && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-[#6b5d52]">{templates.length} template{templates.length === 1 ? '' : 's'}</p>
            <button onClick={() => setEditing({ __new: true, name: '', category_id: cats[0]?.id || '', facility_type: 'ROOM', trigger_event: 'CHECK_OUT', blocks_release: 0, recurrence_nights: 1, steps: [], assignments: [] })} className={BTN}>+ New template</button>
          </div>
          {loading ? <p className="text-sm text-[#6b5d52]">Loading…</p> : templates.length === 0 ? (
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
                  <th className="px-3 py-2"></th>
                </tr></thead>
                <tbody>
                  {templates.map(t => (
                    <tr key={t.id} className={`border-t border-[#f0e8d8] hover:bg-[#fdf8f0] ${Number(t.is_active) === 0 ? 'opacity-50' : ''}`}>
                      <td className="px-3 py-2 font-medium">{t.name}{t.is_system ? <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-[#f0e8d8] text-[#6b5d52]">system</span> : null}</td>
                      <td className="px-3 py-2 text-[#6b5d52]">{catName(t.category_id)}</td>
                      <td className="px-3 py-2">{FTYPES.find(f => f.v === t.facility_type)?.label || t.facility_type}{Number(t.assignment_count) > 0 ? <span className="ml-1 text-[11px] text-[#a0522d]">· {t.assignment_count} specific</span> : <span className="ml-1 text-[11px] text-[#9c8e85]">· all</span>}</td>
                      <td className="px-3 py-2 text-[#6b5d52]">{trgLabel(t.trigger_event)}{t.trigger_event === 'MID_STAY' ? ` (every ${t.recurrence_nights}n)` : ''}</td>
                      <td className="px-3 py-2 text-center tabular-nums">{t.step_count}</td>
                      <td className="px-3 py-2 text-center">{Number(t.blocks_release) === 1 ? <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-50 text-rose-600">YES</span> : <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#f0e8d8] text-[#6b5d52]">no</span>}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button onClick={async () => { try { setEditing(await api(`/checklists/templates/${t.id}`)); } catch (e: any) { setErr(e?.message); } }} className="text-xs px-2 py-1 border border-[#d4c4a8] rounded hover:bg-[#f5f0e8]">Edit</button>
                        {!t.is_system && <button onClick={async () => { if (!window.confirm(`Delete template "${t.name}"?`)) return; try { await api(`/checklists/templates/${t.id}`, { method: 'DELETE' }); load(); } catch (e: any) { setErr(e?.message); } }} className="ml-1 text-xs px-2 py-1 border border-rose-200 text-rose-600 rounded hover:bg-rose-50">Delete</button>}
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
        <TemplateEditor api={api} cats={cats} restaurantId={restaurantId} token={token}
          initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} onError={setErr} />
      )}
    </div>
  );
}

// ── Categories ─────────────────────────────────────────────────────────────
function CategoriesPanel({ api, cats, reload }: { api: any; cats: any[]; reload: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await api('/checklists/categories', { method: 'POST', body: JSON.stringify({ name: name.trim() }) }); setName(''); reload(); } finally { setBusy(false); }
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
            {cats.map(c => (
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
function TemplateEditor({ api, cats, restaurantId, token, initial, onClose, onSaved, onError }:
  { api: any; cats: any[]; restaurantId: string; token: string; initial: any; onClose: () => void; onSaved: () => void; onError: (s: string) => void }) {
  const isNew = !!initial.__new;
  const [form, setForm] = useState<any>({
    name: initial.name || '', category_id: initial.category_id || (cats[0]?.id || ''),
    facility_type: initial.facility_type || 'ROOM', trigger_event: initial.trigger_event || 'CHECK_OUT',
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
        <div><label className="text-xs text-[#6b5d52] block mb-1">Category</label><select value={form.category_id} onChange={e => set('category_id', e.target.value)} className={INPUT + ' w-full'}>{cats.filter(c => Number(c.is_active) === 1).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div><label className="text-xs text-[#6b5d52] block mb-1">Applies to</label><select value={form.facility_type} onChange={e => set('facility_type', e.target.value)} disabled={!!initial.is_system} className={INPUT + ' w-full disabled:bg-[#f5f0e8]'}>{FTYPES.map(f => <option key={f.v} value={f.v}>{f.label}</option>)}</select></div>
        <div><label className="text-xs text-[#6b5d52] block mb-1">Trigger</label><select value={form.trigger_event} onChange={e => set('trigger_event', e.target.value)} disabled={!!initial.is_system} className={INPUT + ' w-full disabled:bg-[#f5f0e8]'}>{TRIGGERS.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}</select><p className="text-[11px] text-[#9c8e85] mt-1">{TRIGGERS.find(t => t.v === form.trigger_event)?.hint}</p></div>
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
        <AssignmentsPanel api={api} restaurantId={restaurantId} token={token} template={initial} assignments={assignments} setAssignments={setAssignments} onError={onError} />
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
function AssignmentsPanel({ api, restaurantId, token, template, assignments, setAssignments, onError }:
  { api: any; restaurantId: string; token: string; template: any; assignments: any[]; setAssignments: (a: any[]) => void; onError: (s: string) => void }) {
  const [scope, setScope] = useState(template.facility_type === 'EVENT' ? 'VENUE' : 'ROOM');
  const [scopeId, setScopeId] = useState('');
  const [rooms, setRooms] = useState<any[]>([]);
  const [types, setTypes] = useState<any[]>([]);
  const [venues, setVenues] = useState<any[]>([]);
  const api2 = makeApi(restaurantId, token);

  useEffect(() => {
    (async () => {
      try { const r = await api2('/hotel/rooms'); setRooms(Array.isArray(r) ? r : (r?.rooms || [])); } catch { /* hotel may be off */ }
      try { const t = await api2('/hotel/room-types'); setTypes(Array.isArray(t) ? t : (t?.types || [])); } catch { /* */ }
      try { const v = await api2('/events/venues'); setVenues(Array.isArray(v) ? v : (v?.venues || [])); } catch { /* events may be off */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const opts = scope === 'ROOM' ? rooms.map((r: any) => ({ id: r.id, label: r.name || (r.room_number ? `Room ${r.room_number}` : r.id) }))
    : scope === 'ROOM_TYPE' ? types.map((t: any) => ({ id: t.id, label: t.name || t.id }))
      : venues.map((v: any) => ({ id: v.id, label: v.name || v.id }));
  const labelFor = (a: any) => {
    const pool = a.scope === 'ROOM' ? rooms : a.scope === 'ROOM_TYPE' ? types : venues;
    const hit = pool.find((x: any) => x.id === a.scope_id);
    return hit ? (hit.name || (hit.room_number ? `Room ${hit.room_number}` : hit.id)) : a.scope_id;
  };

  const add = async () => {
    if (!scopeId) return;
    try {
      const row = await api(`/checklists/assignments`, { method: 'POST', body: JSON.stringify({ template_id: template.id, scope, scope_id: scopeId }) });
      setAssignments([...assignments.filter(a => a.id !== row.id), row]);
      setScopeId('');
    } catch (e: any) { onError(e?.message); }
  };
  const remove = async (aid: string) => { try { await api(`/checklists/assignments/${aid}`, { method: 'DELETE' }); setAssignments(assignments.filter(a => a.id !== aid)); } catch (e: any) { onError(e?.message); } };

  return (
    <div className="rounded-lg border border-[#e8ded0] bg-white p-4">
      <p className="text-sm font-semibold text-[#1a1208]">Applies to</p>
      <p className="text-[11px] text-[#9c8e85] mb-3">{assignments.length === 0 ? 'Currently applies to ALL facilities of its type (default). Add a specific target below to restrict it.' : 'Restricted to the specific targets below. Remove all to revert to “all facilities”.'}</p>
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
      <div className="flex items-end gap-2 flex-wrap">
        <div><label className="text-xs text-[#6b5d52] block mb-1">Target</label>
          <select value={scope} onChange={e => { setScope(e.target.value); setScopeId(''); }} className={INPUT}>
            <option value="ROOM">Specific room</option>
            <option value="ROOM_TYPE">Room type</option>
            <option value="VENUE">Event hall</option>
          </select>
        </div>
        <div className="flex-1 min-w-[12rem]"><label className="text-xs text-[#6b5d52] block mb-1">&nbsp;</label>
          <select value={scopeId} onChange={e => setScopeId(e.target.value)} className={INPUT + ' w-full'}>
            <option value="">Select…</option>
            {opts.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
        <button onClick={add} disabled={!scopeId} className={GHOST}>Assign</button>
      </div>
    </div>
  );
}
