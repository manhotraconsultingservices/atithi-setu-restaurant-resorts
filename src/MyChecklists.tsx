import { useState, useEffect, useCallback } from 'react';
import { ObjectDetail } from './components/ObjectDetail';

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

  if (detail) {
    return <ChecklistDetail restaurantId={restaurantId} token={token} job={detail} onBack={() => { setDetail(null); load(); }} />;
  }

  const pendingCount = jobs.filter(j => j.workflow_state === 'ASSIGNED').length;

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

      {loading ? (
        <p className="text-sm text-[#6b5d52]">Loading…</p>
      ) : jobs.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-4xl mb-2">{tab === 'ASSIGNED' ? '✅' : '🗂️'}</p>
          <p className="text-sm text-[#6b5d52]">{tab === 'ASSIGNED' ? 'Nothing on your checklist right now. Great work!' : 'No completed checklists yet.'}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[#e8ded0]">
          <table className="w-full text-sm border-collapse">
            <thead><tr className="bg-[#f5f0e8] text-left">
              <th className="px-3 py-2 font-semibold text-[#1a1208]">Checklist</th>
              <th className="px-3 py-2 font-semibold text-[#1a1208]">For</th>
              <th className="px-3 py-2 font-semibold text-[#1a1208]">Trigger</th>
              {isManager && <th className="px-3 py-2 font-semibold text-[#1a1208]">Assigned to</th>}
              <th className="px-3 py-2 font-semibold text-[#1a1208] text-center">Progress</th>
              <th className="px-3 py-2 font-semibold text-[#1a1208] text-center">Status</th>
            </tr></thead>
            <tbody>
              {jobs.map(job => {
                const { total, done, pendMand } = taskCounts(job);
                return (
                  <tr key={job.id} className="border-t border-[#f0e8d8] hover:bg-[#fdf8f0]">
                    <td className="px-3 py-2">
                      <button onClick={() => setDetail(job)} className="font-semibold text-blue-600 hover:text-blue-800 hover:underline text-left">
                        {job.template_name || TRIGGER_LABEL[job.trigger_event] || 'Checklist'}
                      </button>
                      {Number(job.blocks_release) === 1 && <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-600">blocks release</span>}
                    </td>
                    <td className="px-3 py-2 text-[#6b5d52]">{job.facility_label || job.facility_id || job.facility_type}{job.guest_label ? ` · ${job.guest_label}` : ''}</td>
                    <td className="px-3 py-2 text-[#6b5d52]">{TRIGGER_LABEL[job.trigger_event] || job.trigger_event}</td>
                    {isManager && <td className="px-3 py-2 text-[#6b5d52]">{job.assigned_to_user || ROLE_LABEL[job.assigned_to_role] || job.assigned_to_role || '—'}</td>}
                    <td className="px-3 py-2 text-center tabular-nums whitespace-nowrap">{done}/{total}{pendMand > 0 ? <span className="text-[11px] text-rose-600"> · {pendMand} req</span> : ''}</td>
                    <td className="px-3 py-2 text-center">{statePill(job.workflow_state)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Checklist instance detail — tree menu (Summary / Audit log / Where-Used) ──
function ChecklistDetail({ restaurantId, token, job: initial, onBack }: { restaurantId: string; token: string; job: any; onBack: () => void }) {
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
    />
  );
}
