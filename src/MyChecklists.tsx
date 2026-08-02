import { useState, useEffect, useCallback } from 'react';

// ── "My Checklist" — the personal work queue of checklist INSTANCES assigned to
// the current user or their role (a checklist instance = a job with real tasks,
// attached to a room / booking / hall / event). Distinct from "Checklist
// Templates" (the master definitions). Pull model: staff see what's theirs to do,
// tick each task, and mark the checklist complete — quality assurance that the
// process was actually followed.

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

export function MyChecklists({ restaurantId, token }: Props) {
  const api = useCallback(makeApi(restaurantId, token), [restaurantId, token]);
  const [tab, setTab] = useState<'ASSIGNED' | 'COMPLETE'>('ASSIGNED');
  const [jobs, setJobs] = useState<any[]>([]);
  const [isManager, setIsManager] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string>('');
  const [err, setErr] = useState('');

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

  const toggleTask = async (job: any, task: any, next: boolean) => {
    setBusy(task.id);
    // optimistic
    setJobs(js => js.map(j => j.id !== job.id ? j : {
      ...j,
      tasks: j.tasks.map((t: any) => t.id === task.id ? { ...t, is_done: next ? 1 : 0 } : t),
    }));
    try {
      await api(`/checklists/my/jobs/${job.id}/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ is_done: next }) });
    } catch (e: any) { setErr(e?.message || 'Failed to update'); await load(); }
    finally { setBusy(''); }
  };

  const complete = async (job: any) => {
    setBusy(job.id); setErr('');
    try {
      await api(`/checklists/my/jobs/${job.id}/complete`, { method: 'POST', body: JSON.stringify({}) });
      setJobs(js => js.filter(j => j.id !== job.id));
    } catch (e: any) { setErr(e?.data?.error || e?.message || 'Cannot complete yet'); }
    finally { setBusy(''); }
  };

  const pendingCount = jobs.filter(j => j.workflow_state === 'ASSIGNED').length;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-3xl font-bold font-serif text-[#1a1208]">My Checklist</h2>
        <p className="text-sm text-[#6b5d52] mt-1">
          {isManager ? 'Every checklist assigned across the team.' : 'Checklists assigned to you or your role.'} Tick each task as you complete it, then mark the checklist done.
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
        <div className="grid gap-4 sm:grid-cols-2">
          {jobs.map(job => {
            const total = job.task_count ?? (job.tasks || []).length;
            const done = job.done_count ?? (job.tasks || []).filter((t: any) => Number(t.is_done) === 1).length;
            const pendMand = job.pending_mandatory ?? (job.tasks || []).filter((t: any) => Number(t.is_mandatory) === 1 && Number(t.is_done) === 0).length;
            const isComplete = job.workflow_state === 'COMPLETE';
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            return (
              <div key={job.id} className="rounded-2xl border border-[#e8ded0] bg-white p-4 flex flex-col">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-[#1a1208] truncate">{job.template_name || TRIGGER_LABEL[job.trigger_event] || 'Checklist'}</p>
                    <p className="text-[11px] text-[#9c8e85] truncate">{job.facility_label || job.facility_id || job.facility_type}{job.guest_label ? ` · ${job.guest_label}` : ''}</p>
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#f0e8d8] text-[#6b5d52] whitespace-nowrap">{TRIGGER_LABEL[job.trigger_event] || job.trigger_event}</span>
                </div>
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  {job.assigned_to_role && <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#eef4ff] text-[#3a5ba0]">{ROLE_LABEL[job.assigned_to_role] || job.assigned_to_role}</span>}
                  {Number(job.blocks_release) === 1 && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-50 text-rose-600">blocks release</span>}
                  {job.assigned_at && <span className="text-[10px] text-[#9c8e85]">assigned {fmtWhen(job.assigned_at)}</span>}
                </div>

                {/* progress bar */}
                <div className="h-1.5 rounded-full bg-[#f0e8d8] mb-2 overflow-hidden">
                  <div className="h-full bg-[#a0522d]" style={{ width: `${pct}%` }} />
                </div>

                <ul className="space-y-1 mb-3">
                  {(job.tasks || []).map((t: any) => (
                    <li key={t.id}>
                      <label className={`flex items-start gap-2 text-sm ${isComplete ? 'cursor-default' : 'cursor-pointer'}`}>
                        <input type="checkbox" className="mt-0.5 accent-[#a0522d]" checked={Number(t.is_done) === 1}
                          disabled={isComplete || busy === t.id}
                          onChange={e => toggleTask(job, t, e.target.checked)} />
                        <span className={Number(t.is_done) === 1 ? 'text-[#9c8e85] line-through' : 'text-[#3d3128]'}>
                          {t.label}{Number(t.is_mandatory) === 1 ? '' : <span className="text-[#9c8e85] text-[11px]"> (optional)</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>

                <div className="mt-auto flex items-center justify-between">
                  <span className="text-[11px] text-[#9c8e85]">{done}/{total} done{pendMand > 0 ? ` · ${pendMand} required left` : ''}</span>
                  {isComplete ? (
                    <span className="text-[11px] font-bold text-emerald-700">✓ Completed{job.completed_by ? ` · ${job.completed_by}` : ''}</span>
                  ) : (
                    <button onClick={() => complete(job)} disabled={busy === job.id || pendMand > 0} className={BTN}
                      title={pendMand > 0 ? `${pendMand} required task(s) still pending` : 'Mark this checklist complete'}>
                      {busy === job.id ? 'Saving…' : 'Mark complete'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
