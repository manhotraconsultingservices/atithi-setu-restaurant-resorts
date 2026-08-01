// Housekeeping — configurable cleaning checklists, an enforced worklist, and a
// cleaning log. A cleaning job is raised on room checkout / event completion;
// the facility can't be re-booked until the mandatory tasks are done (managers
// may override). One checklist per facility type (Room + Event).
import { useEffect, useState } from 'react';
import {
  Sparkles, Check, X, Plus, RefreshCw, ListChecks, History, ShieldAlert, DoorOpen, Building2, ClipboardList,
} from 'lucide-react';

const CARD = 'bg-white rounded-2xl border border-[#e8dccf] p-5';
const BTN = 'px-3 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-1.5 transition-colors';
const BTN_PRIMARY = `${BTN} bg-[#cc5a16] text-white hover:bg-[#b34f12] disabled:opacity-50`;
const BTN_GHOST = `${BTN} bg-[#faf7f2] border border-[#e8dccf] text-[#3d3128] hover:bg-[#f0e9df]`;
const INPUT = 'w-full px-3 py-2 rounded-xl border border-[#e8dccf] text-sm bg-white focus:outline-none focus:border-[#cc5a16]';
const dt = (v: any) => v ? new Date(v).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

// scope='EVENT' → a focused view for the Events module (event venues only);
// 'ROOM' → rooms only; 'ALL' (default) → the full hotel-side view (rooms + events).
type HkScope = 'ALL' | 'ROOM' | 'EVENT';
export function HousekeepingModule({ restaurantId, token, scope = 'ALL' }: { restaurantId: string; token: string; scope?: HkScope }) {
  const [view, setView] = useState<'WORKLIST' | 'CHECKLIST' | 'LOG'>('WORKLIST');
  const api = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`/api/restaurant/${restaurantId}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((b && b.error) || `HTTP ${r.status}`);
    return b;
  };
  const tabBtn = (k: typeof view, label: string, icon: any) => (
    <button onClick={() => setView(k)} className={`${BTN} ${view === k ? 'bg-[#cc5a16] text-white' : 'bg-[#faf7f2] border border-[#e8dccf] text-[#6b5d52]'}`}>{icon}{label}</button>
  );
  const title = scope === 'EVENT' ? 'Event Housekeeping' : scope === 'ROOM' ? 'Room Housekeeping' : 'Housekeeping';
  const subtitle = scope === 'EVENT'
    ? 'Cleaning checklist, worklist & log for event venues.'
    : scope === 'ROOM' ? 'Cleaning checklist, worklist & log for guest rooms.'
    : 'Cleaning checklists, worklist & log — rooms and event venues.';
  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="grid place-items-center w-9 h-9 rounded-xl bg-[#fbeee3] text-[#cc5a16]"><Sparkles size={18} /></div>
          <div>
            <h2 className="text-xl font-bold text-[#14110c] leading-tight">{title}</h2>
            <p className="text-xs text-[#9c8e85]">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {tabBtn('WORKLIST', 'Worklist', <ListChecks size={13} />)}
          {tabBtn('CHECKLIST', 'Checklists', <ClipboardList size={13} />)}
          {tabBtn('LOG', 'Cleaning Log', <History size={13} />)}
        </div>
      </div>
      {view === 'WORKLIST' && <Worklist api={api} scope={scope} />}
      {view === 'CHECKLIST' && <ChecklistConfig api={api} scope={scope} />}
      {view === 'LOG' && <CleaningLog api={api} scope={scope} />}
    </div>
  );
}

// ── Worklist — open cleaning jobs, tick tasks, complete / override ────────────
function Worklist({ api, scope = 'ALL' }: { api: (p: string, i?: RequestInit) => Promise<any>; scope?: 'ALL' | 'ROOM' | 'EVENT' }) {
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [openJob, setOpenJob] = useState<any>(null); // {..., tasks}
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const all = await api('/housekeeping/jobs?status=OPEN');
      setJobs(scope === 'ALL' ? all : (all || []).filter((j: any) => j.facility_type === scope));
    } catch { setJobs([]); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  const openDetail = async (j: any) => { try { setOpenJob(await api(`/housekeeping/jobs/${j.id}`)); } catch (e: any) { alert(e.message); } };
  const toggle = async (t: any) => {
    try {
      await api(`/housekeeping/jobs/${openJob.id}/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ is_done: !t.is_done }) });
      setOpenJob(await api(`/housekeeping/jobs/${openJob.id}`));
    } catch (e: any) { alert(e.message); }
  };
  const complete = async () => {
    setBusy(true);
    try { await api(`/housekeeping/jobs/${openJob.id}/complete`, { method: 'POST', body: '{}' }); setOpenJob(null); await load(); }
    catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };
  const override = async () => {
    const reason = prompt('Manager override — reason for releasing before the checklist is complete:');
    if (reason === null) return;
    setBusy(true);
    try { await api(`/housekeeping/jobs/${openJob.id}/override`, { method: 'POST', body: JSON.stringify({ reason }) }); setOpenJob(null); await load(); }
    catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };
  const pendMand = (openJob?.tasks || []).filter((t: any) => t.is_mandatory && !t.is_done).length;

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <button className={BTN_GHOST} onClick={load}><RefreshCw size={13} /> Refresh</button>
        <span className="text-[11px] text-[#9c8e85]">{jobs.length} facilities awaiting cleaning</span>
      </div>
      {loading ? <p className="text-sm text-[#6b5d52] p-4">Loading…</p> : jobs.length === 0 ? (
        <div className={`${CARD} text-center text-[#9c8e85]`}><Check size={24} className="mx-auto mb-2 text-emerald-500" />All clean — no pending cleaning jobs.</div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {jobs.map(j => {
            const pct = j.task_count ? Math.round((j.done_count / j.task_count) * 100) : 0;
            return (
              <button key={j.id} onClick={() => openDetail(j)} className={`${CARD} text-left hover:border-[#cc5a16] transition-colors`}>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#fbeee3] text-[#cc5a16]">
                    {j.facility_type === 'EVENT' ? <Building2 size={11} /> : <DoorOpen size={11} />}{j.facility_type}
                  </span>
                  {j.pending_mandatory > 0
                    ? <span className="text-[10px] font-bold text-rose-600">{j.pending_mandatory} mandatory left</span>
                    : <span className="text-[10px] font-bold text-emerald-600">ready to close</span>}
                </div>
                <div className="font-bold text-[#14110c]">{j.facility_label || j.facility_id}</div>
                <div className="text-[11px] text-[#9c8e85]">{j.guest_label ? `after ${j.guest_label} · ` : ''}{dt(j.created_at)}</div>
                <div className="mt-2 h-1.5 rounded-full bg-[#f0e9df] overflow-hidden"><div className="h-full bg-[#cc5a16]" style={{ width: `${pct}%` }} /></div>
                <div className="text-[10px] text-[#9c8e85] mt-1">{j.done_count}/{j.task_count} tasks</div>
              </button>
            );
          })}
        </div>
      )}

      {openJob && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpenJob(null)}>
          <div className="w-full max-w-md bg-white rounded-2xl border border-[#e8dccf] p-5 shadow-xl max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-2 mb-1">
              <div>
                <h3 className="text-lg font-bold text-[#14110c]">{openJob.facility_label}</h3>
                <p className="text-[11px] text-[#9c8e85]">{openJob.facility_type} cleaning{openJob.guest_label ? ` · after ${openJob.guest_label}` : ''}</p>
              </div>
              <button onClick={() => setOpenJob(null)}><X size={18} className="text-[#9c8e85]" /></button>
            </div>
            <div className="flex flex-col gap-1.5 my-3">
              {(openJob.tasks || []).map((t: any) => (
                <button key={t.id} onClick={() => toggle(t)} className={`flex items-center gap-2.5 text-left px-3 py-2 rounded-xl border transition-colors ${t.is_done ? 'bg-emerald-50 border-emerald-200' : 'bg-[#faf7f2] border-[#e8dccf] hover:border-[#cc5a16]'}`}>
                  <span className={`w-5 h-5 rounded-md grid place-items-center shrink-0 ${t.is_done ? 'bg-emerald-500 text-white' : 'border border-[#cbb9a8]'}`}>{t.is_done && <Check size={13} />}</span>
                  <span className={`text-sm flex-1 ${t.is_done ? 'line-through text-[#9c8e85]' : 'text-[#3d3128]'}`}>{t.label}</span>
                  {!t.is_mandatory && <span className="text-[9px] font-bold text-[#b9a897] uppercase">optional</span>}
                </button>
              ))}
            </div>
            {pendMand > 0 && <p className="flex items-center gap-1 text-[11px] text-amber-700 mb-2"><ShieldAlert size={12} />{pendMand} mandatory task(s) must be done to release this facility.</p>}
            <div className="flex justify-end gap-2">
              <button className={BTN_GHOST} onClick={override} disabled={busy}><ShieldAlert size={13} /> Override</button>
              <button className={BTN_PRIMARY} onClick={complete} disabled={busy || pendMand > 0}><Check size={13} /> Mark cleaned &amp; release</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Checklist config — owner-configured tasks per facility type ───────────────
function ChecklistConfig({ api, scope = 'ALL' }: { api: (p: string, i?: RequestInit) => Promise<any>; scope?: 'ALL' | 'ROOM' | 'EVENT' }) {
  const [data, setData] = useState<{ ROOM: any[]; EVENT: any[] }>({ ROOM: [], EVENT: [] });
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Record<string, string>>({ ROOM: '', EVENT: '' });
  const load = async () => { setLoading(true); try { setData(await api('/housekeeping/checklist')); } catch { /* */ } finally { setLoading(false); } };
  useEffect(() => { load(); }, []);
  const add = async (ft: 'ROOM' | 'EVENT') => {
    const label = (draft[ft] || '').trim(); if (!label) return;
    try { await api('/housekeeping/checklist/tasks', { method: 'POST', body: JSON.stringify({ facility_type: ft, label, is_mandatory: true }) }); setDraft({ ...draft, [ft]: '' }); await load(); }
    catch (e: any) { alert(e.message); }
  };
  const patch = async (t: any, body: any) => { try { await api(`/housekeeping/checklist/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify(body) }); await load(); } catch (e: any) { alert(e.message); } };
  const del = async (t: any) => { if (!confirm(`Remove "${t.label}"?`)) return; try { await api(`/housekeeping/checklist/tasks/${t.id}`, { method: 'DELETE' }); await load(); } catch (e: any) { alert(e.message); } };

  const col = (ft: 'ROOM' | 'EVENT', title: string, icon: any) => (
    <div className={CARD}>
      <h3 className="font-bold text-sm flex items-center gap-1.5 mb-1 text-[#14110c]">{icon}{title} checklist</h3>
      <p className="text-[11px] text-[#9c8e85] mb-3">Runs after every {ft === 'ROOM' ? 'room checkout' : 'completed event'}. Mandatory tasks must be ticked before the {ft === 'ROOM' ? 'room' : 'venue'} is released.</p>
      <div className="flex flex-col gap-1.5 mb-3">
        {(data[ft] || []).length === 0 ? <p className="text-xs text-[#9c8e85]">No tasks yet.</p> : (data[ft] || []).map((t: any) => (
          <div key={t.id} className={`flex items-center gap-2 px-3 py-2 rounded-xl border ${t.is_active ? 'border-[#e8dccf]' : 'border-dashed border-[#e0d4c5] opacity-60'}`}>
            <span className="text-sm flex-1 text-[#3d3128]">{t.label}</span>
            <button onClick={() => patch(t, { is_mandatory: !t.is_mandatory })}
              className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${t.is_mandatory ? 'bg-rose-50 text-rose-600' : 'bg-[#f0e9df] text-[#9c8e85]'}`}
              title="Toggle mandatory / optional">{t.is_mandatory ? 'MANDATORY' : 'OPTIONAL'}</button>
            <button onClick={() => del(t)} title="Remove"><X size={14} className="text-rose-400 hover:text-rose-600" /></button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input className={INPUT} value={draft[ft]} onChange={e => setDraft({ ...draft, [ft]: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') add(ft); }} placeholder="Add a task…" />
        <button className={BTN_PRIMARY} onClick={() => add(ft)}><Plus size={13} /> Add</button>
      </div>
    </div>
  );
  if (loading) return <p className="text-sm text-[#6b5d52] p-4">Loading…</p>;
  if (scope === 'EVENT') return <div className="max-w-2xl">{col('EVENT', 'Event', <Building2 size={15} />)}</div>;
  if (scope === 'ROOM') return <div className="max-w-2xl">{col('ROOM', 'Room', <DoorOpen size={15} />)}</div>;
  return <div className="grid md:grid-cols-2 gap-4">{col('ROOM', 'Room', <DoorOpen size={15} />)}{col('EVENT', 'Event', <Building2 size={15} />)}</div>;
}

// ── Cleaning log — history + per-facility counts ─────────────────────────────
function CleaningLog({ api, scope = 'ALL' }: { api: (p: string, i?: RequestInit) => Promise<any>; scope?: 'ALL' | 'ROOM' | 'EVENT' }) {
  const [data, setData] = useState<{ log: any[]; by_facility: any[] }>({ log: [], by_facility: [] });
  const [loading, setLoading] = useState(true);
  useEffect(() => { (async () => { setLoading(true); try { const q = scope !== 'ALL' ? `?facility_type=${scope}` : ''; setData(await api(`/housekeeping/log${q}`)); } catch { /* */ } finally { setLoading(false); } })(); }, [scope]);
  if (loading) return <p className="text-sm text-[#6b5d52] p-4">Loading…</p>;
  // The log rows are already filtered server-side; the per-facility rollup is not, so scope it here.
  const byFacility = scope === 'ALL' ? data.by_facility : data.by_facility.filter((f: any) => f.facility_type === scope);
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <div className={`${CARD} p-0 overflow-hidden`}>
        <h3 className="font-bold text-sm p-4 pb-2 text-[#14110c]">Times cleaned per facility</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="bg-[#faf7f2] text-[#6b5d52] text-[11px] uppercase"><th className="text-left px-4 py-2">Facility</th><th className="text-right px-4 py-2">Times</th><th className="text-left px-4 py-2">Last cleaned</th></tr></thead>
            <tbody>
              {byFacility.length === 0 ? <tr><td colSpan={3} className="p-4 text-[#9c8e85] text-center">No cleaning recorded yet.</td></tr> : byFacility.map((f: any, i: number) => (
                <tr key={i} className="border-t border-[#f0ebe4]">
                  <td className="px-4 py-2"><span className="text-[9px] font-bold text-[#b9a897] mr-1">{f.facility_type}</span>{f.facility_label || f.facility_id}</td>
                  <td className="px-4 py-2 text-right font-bold tabular-nums">{f.times_cleaned}</td>
                  <td className="px-4 py-2 text-[#6b5d52] text-xs">{dt(f.last_cleaned)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className={`${CARD} p-0 overflow-hidden`}>
        <h3 className="font-bold text-sm p-4 pb-2 text-[#14110c]">Recent cleaning history</h3>
        <div className="max-h-[60vh] overflow-y-auto">
          {data.log.length === 0 ? <p className="p-4 text-[#9c8e85] text-sm">Nothing logged yet.</p> : data.log.map((j: any) => (
            <div key={j.id} className="flex items-center gap-2 px-4 py-2 border-t border-[#f0ebe4] text-sm">
              <span className="flex-1 min-w-0"><span className="font-medium text-[#14110c]">{j.facility_label || j.facility_id}</span>
                <span className="block text-[10px] text-[#9c8e85]">{dt(j.completed_at)}{j.completed_by ? ` · ${j.completed_by}` : ''}</span></span>
              <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${j.status === 'OVERRIDDEN' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>{j.status === 'OVERRIDDEN' ? 'OVERRIDE' : 'CLEANED'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
