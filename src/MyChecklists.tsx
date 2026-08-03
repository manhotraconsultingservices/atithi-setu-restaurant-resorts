import { useState, useEffect, useCallback, useMemo } from 'react';
import { ObjectDetail, buildObjectResolver } from './components/ObjectDetail';
import { DataTable, type ColDef } from './components/DataTable';

// ── "My Checklist" — the personal work queue of checklist INSTANCES assigned to
// the current user or their role. A checklist instance = a job with real tasks,
// attached to a room / booking / hall / event. Distinct from "Checklist Templates"
// (the master definitions). Table form; each checklist opens a tree menu (Summary
// with per-task remarks + Audit log + Where-Used / Related objects).

type Props = { restaurantId: string; token: string };

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

const TRIGGER_LABEL: Record<string, string> = {
  CHECK_IN: 'Check-in', CHECK_OUT: 'Check-out', MID_STAY: 'Mid-stay',
  DAILY: 'Daily', EVENT_COMPLETE: 'Event', MANUAL: 'Inspection',
};
const ROLE_LABEL: Record<string, string> = {
  FRONT_DESK: 'Front Desk', HOUSEKEEPING: 'Housekeeping', MAINTENANCE: 'Maintenance',
  CONCIERGE: 'Concierge', EVENTS_MANAGER: 'Events', MANAGER: 'Manager',
};
const fmtWhen = (iso: string) => String(iso || '').replace('T', ' ').slice(0, 16);
const BTN = 'px-3 py-1.5 bg-[#a0522d] text-white text-sm rounded hover:bg-[#8b4513] disabled:opacity-40';

const taskCounts = (job: any) => {
  const t = job.tasks || [];
  return {
    total: job.task_count ?? t.length,
    done: job.done_count ?? t.filter((x: any) => Number(x.is_done) === 1).length,
    pendMand: job.pending_mandatory ?? t.filter((x: any) => Number(x.is_mandatory) === 1 && Number(x.is_done) === 0).length,
  };
};
const statePill = (s: string) => {
  const st = String(s || '').toUpperCase();
  const cls = st === 'COMPLETE' ? 'bg-emerald-50 text-emerald-700' : st === 'DRAFT' ? 'bg-stone-100 text-stone-600' : 'bg-amber-50 text-amber-700';
  return <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${cls}`}>{st || 'ASSIGNED'}</span>;
};
// Due date cell — highlights overdue (past due & not complete) in red with a clock.
const dueCell = (due: any, complete: boolean) => {
  const d = String(due || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return <span className="text-[#c9bcae]">—</span>;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = !complete && d < today;
  return <span className={`text-[11px] whitespace-nowrap ${overdue ? 'text-rose-600 font-bold' : 'text-[#6b5d52]'}`}>{d}{overdue ? ' ⏰' : ''}</span>;
};

export function MyChecklists({ restaurantId, token }: Props) {
  const api = useCallback(makeApi(restaurantId, token), [restaurantId, token]);
  const [tab, setTab] = useState<'ASSIGNED' | 'COMPLETE'>('ASSIGNED');
  const [jobs, setJobs] = useState<any[]>([]);
  const [isManager, setIsManager] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [detail, setDetail] = useState<any | null>(null); // the checklist instance whose tree menu is open

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const r = await api(`/checklists/my?state=${tab}`);
      setJobs(Array.isArray(r?.jobs) ? r.jobs : []);
      setIsManager(!!r?.is_manager);
    } catch (e: any) { setErr(e?.message || 'Failed to load'); }
    finally { setLoading(false); }
  }, [api, tab]);
  useEffect(() => { load(); }, [load]);

  const pendingCount = jobs.filter(j => j.workflow_state === 'ASSIGNED').length;

  const columns = useMemo<ColDef<any>[]>(() => [
    {
      key: 'name', label: 'Checklist', sortable: true, searchable: true, hideable: false,
      getValue: (j) => j.template_name || TRIGGER_LABEL[j.trigger_event] || 'Checklist',
      render: (j) => (
        <div className="flex items-center gap-2">
          <button onClick={() => setDetail(j)} className="font-semibold text-blue-600 hover:text-blue-800 hover:underline text-left">
            {j.template_name || TRIGGER_LABEL[j.trigger_event] || 'Checklist'}
          </button>
          {Number(j.blocks_release) === 1 && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-600 whitespace-nowrap">blocks release</span>}
        </div>
      ),
      exportValue: (j) => j.template_name || TRIGGER_LABEL[j.trigger_event] || 'Checklist',
    },
    {
      key: 'facility', label: 'For', sortable: true, filterable: true, filterType: 'text',
      getValue: (j) => `${j.facility_label || j.facility_id || j.facility_type || ''}${j.guest_label ? ` · ${j.guest_label}` : ''}`,
    },
    {
      key: 'trigger', label: 'Trigger', sortable: true, filterable: true, filterType: 'select',
      getValue: (j) => TRIGGER_LABEL[j.trigger_event] || j.trigger_event || '',
    },
    ...(isManager ? [{
      key: 'assignee', label: 'Assigned to', sortable: true, filterable: true, filterType: 'select',
      getValue: (j: any) => j.assigned_to_user || ROLE_LABEL[j.assigned_to_role] || j.assigned_to_role || '',
    } as ColDef<any>] : []),
    {
      key: 'progress', label: 'Progress', sortable: true, align: 'center', searchable: false,
      getValue: (j) => { const c = taskCounts(j); return c.total ? c.done / c.total : 0; },
      render: (j) => { const { total, done, pendMand } = taskCounts(j); return <span className="tabular-nums whitespace-nowrap">{done}/{total}{pendMand > 0 ? <span className="text-[11px] text-rose-600"> · {pendMand} req</span> : ''}</span>; },
      exportValue: (j) => { const { total, done } = taskCounts(j); return `${done}/${total}`; },
    },
    {
      key: 'due', label: 'Due', sortable: true, align: 'center', searchable: false,
      getValue: (j) => j.due_date || '',
      render: (j) => dueCell(j.due_date, j.workflow_state === 'COMPLETE'),
      exportValue: (j) => j.due_date || '',
    },
    {
      key: 'status', label: 'Status', sortable: true, align: 'center', filterable: true, filterType: 'select',
      getValue: (j) => String(j.workflow_state || 'ASSIGNED').toUpperCase(),
      render: (j) => statePill(j.workflow_state),
    },
  ], [isManager]);

  // Every hook is above this line. The detail-view early return MUST come after
  // all hooks so the hook count stays identical between the list and detail
  // renders — otherwise React throws "Rendered fewer hooks than expected".
  if (detail) {
    return <ChecklistDetail restaurantId={restaurantId} token={token} job={detail} onBack={() => { setDetail(null); load(); }} />;
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-3xl font-bold font-serif text-[#1a1208]">My Checklist</h2>
        <p className="text-sm text-[#6b5d52] mt-1">
          {isManager ? 'Every checklist assigned across the team.' : 'Checklists assigned to you or your role.'} Click a checklist to complete its tasks, add remarks and see where it applies.
        </p>
      </div>

      <div className="flex gap-0 border-b border-[#e8ded0]">
        {(['ASSIGNED', 'COMPLETE'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t ? 'border-[#a0522d] text-[#a0522d]' : 'border-transparent text-[#6b5d52] hover:text-[#a0522d]'}`}>
            {t === 'ASSIGNED' ? `To do${pendingCount ? ` (${pendingCount})` : ''}` : 'Completed'}
          </button>
        ))}
      </div>

      {err && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">{err}</div>}

      <DataTable
        data={jobs}
        columns={columns}
        rowKey={(j) => j.id}
        loading={loading}
        compact
        columnChooser
        columnFilters
        tableId={`my-checklist-${isManager ? 'mgr' : 'self'}`}
        searchPlaceholder="Search checklists…"
        exportFilename={`my-checklist-${tab.toLowerCase()}`}
        emptyMessage={tab === 'ASSIGNED' ? 'Nothing on your checklist right now. Great work!' : 'No completed checklists yet.'}
        onRowClick={(j) => setDetail(j)}
      />
    </div>
  );
}

// ── Checklist instance detail — tree menu (Summary / Audit log / Where-Used) ──
export function ChecklistDetail({ restaurantId, token, job: initial, onBack }: { restaurantId: string; token: string; job: any; onBack: () => void }) {
  const api = useCallback(makeApi(restaurantId, token), [restaurantId, token]);
  const [tasks, setTasks] = useState<any[]>((initial.tasks || []).map((t: any) => ({ ...t })));
  const [state, setState] = useState<string>(initial.workflow_state || 'ASSIGNED');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const isComplete = state === 'COMPLETE';
  const done = tasks.filter(t => Number(t.is_done) === 1).length;
  const pendMand = tasks.filter(t => Number(t.is_mandatory) === 1 && Number(t.is_done) === 0).length;

  const tick = async (task: any, next: boolean) => {
    setBusy(task.id);
    setTasks(ts => ts.map(t => t.id === task.id ? { ...t, is_done: next ? 1 : 0 } : t));
    try { await api(`/checklists/my/jobs/${initial.id}/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ is_done: next }) }); }
    catch (e: any) { setErr(e?.message || 'Failed'); setTasks(ts => ts.map(t => t.id === task.id ? { ...t, is_done: next ? 0 : 1 } : t)); }
    finally { setBusy(''); }
  };
  const saveRemark = async (task: any, remark: string) => {
    if ((task.remark || '') === remark) return;
    setTasks(ts => ts.map(t => t.id === task.id ? { ...t, remark } : t));
    try { await api(`/checklists/my/jobs/${initial.id}/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ remark }) }); }
    catch (e: any) { setErr(e?.message || 'Failed to save remark'); }
  };
  const complete = async () => {
    setBusy('__complete'); setErr('');
    try { await api(`/checklists/my/jobs/${initial.id}/complete`, { method: 'POST', body: JSON.stringify({}) }); setState('COMPLETE'); }
    catch (e: any) { setErr(e?.data?.error || e?.message || 'Cannot complete yet'); }
    finally { setBusy(''); }
  };

  const summary = (
    <div className="space-y-3">
      {err && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">{err}</div>}
      <div className="rounded-2xl border border-[#e8dccf] bg-white p-4 grid grid-cols-2 gap-3 text-[12px]">
        <div><span className="text-[#9c8e85]">For</span><div className="font-semibold text-[#14110c]">{initial.facility_label || initial.facility_id || initial.facility_type}</div></div>
        <div><span className="text-[#9c8e85]">Trigger</span><div className="font-semibold text-[#14110c]">{TRIGGER_LABEL[initial.trigger_event] || initial.trigger_event}</div></div>
        <div><span className="text-[#9c8e85]">Assigned to</span><div className="font-semibold text-[#14110c]">{initial.assigned_to_user || ROLE_LABEL[initial.assigned_to_role] || initial.assigned_to_role || '—'}</div></div>
        <div><span className="text-[#9c8e85]">Assigned</span><div className="font-semibold text-[#14110c]">{initial.assigned_at ? fmtWhen(initial.assigned_at) : '—'}</div></div>
      </div>

      <div className="rounded-2xl border border-[#e8dccf] bg-white p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-semibold text-[#14110c]">Tasks</p>
          <span className="text-[11px] text-[#9c8e85]">{done}/{tasks.length} done{pendMand > 0 ? ` · ${pendMand} required left` : ''}</span>
        </div>
        <ul className="space-y-2">
          {tasks.map(t => (
            <li key={t.id} className="border-b border-[#f0e8d8] pb-2 last:border-0 last:pb-0">
              <label className={`flex items-start gap-2 text-sm ${isComplete ? '' : 'cursor-pointer'}`}>
                <input type="checkbox" className="mt-0.5 accent-[#a0522d]" checked={Number(t.is_done) === 1} disabled={isComplete || busy === t.id} onChange={e => tick(t, e.target.checked)} />
                <span className={Number(t.is_done) === 1 ? 'text-[#9c8e85] line-through' : 'text-[#3d3128]'}>{t.label}{Number(t.is_mandatory) === 1 ? '' : <span className="text-[11px] text-[#9c8e85]"> (optional)</span>}</span>
              </label>
              {isComplete ? (
                t.remark ? <p className="mt-1 ml-6 text-[12px] text-[#6b5d52] italic">“{t.remark}”</p> : null
              ) : (
                <input defaultValue={t.remark || ''} onBlur={e => saveRemark(t, e.target.value)} placeholder="Add remark…"
                  className="mt-1 ml-6 w-[calc(100%-1.5rem)] text-[12px] border border-[#e8dccf] rounded px-2 py-1 bg-[#faf7f2] focus:outline-none focus:border-[#a0522d]" />
              )}
              {t.done_by && Number(t.is_done) === 1 && <p className="mt-0.5 ml-6 text-[10px] text-[#9d8b7e]">done by {t.done_by}{t.done_at ? ` · ${fmtWhen(t.done_at)}` : ''}</p>}
            </li>
          ))}
        </ul>
        {!isComplete && (
          <button onClick={complete} disabled={busy === '__complete' || pendMand > 0} className={BTN + ' mt-3'}
            title={pendMand > 0 ? `${pendMand} required task(s) still pending` : 'Mark this checklist complete'}>
            {busy === '__complete' ? 'Saving…' : 'Mark checklist complete'}
          </button>
        )}
        {isComplete && <p className="mt-3 text-[12px] font-bold text-emerald-700">✓ Completed{initial.completed_by ? ` · ${initial.completed_by}` : ''}</p>}
      </div>
    </div>
  );

  return (
    <ObjectDetail
      title={initial.template_name || TRIGGER_LABEL[initial.trigger_event] || 'Checklist'}
      subtitle={`${TRIGGER_LABEL[initial.trigger_event] || initial.trigger_event} · ${initial.facility_label || initial.facility_id || initial.facility_type}`}
      statusPill={statePill(state)}
      onBack={onBack}
      backLabel="My Checklist"
      token={token}
      overviewLabel="Summary"
      overview={summary}
      auditUrl={`/api/restaurant/${restaurantId}/checklists/jobs/${initial.id}/audit`}
      whereUsedUrl={`/api/restaurant/${restaurantId}/checklists/jobs/${initial.id}/where-used`}
      resolveLink={buildObjectResolver(restaurantId, token)}
    />
  );
}
