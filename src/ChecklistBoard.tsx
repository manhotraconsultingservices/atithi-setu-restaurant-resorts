import { useState, useEffect, useCallback, useMemo } from 'react';
import { ChecklistDetail } from './MyChecklists';
import { DataTable, type ColDef } from './components/DataTable';

// ── Checklist Board — the manager/owner cockpit over EVERY checklist instance in
// the property: what's pending, who owns it, how old it is. It's a smart table
// (sort / per-column filter / column chooser / export) and rows deep-link into the
// same instance tree menu (tick / remark / complete) used in My Checklist.

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

const ageOf = (iso: string): { label: string; hours: number } => {
  if (!iso) return { label: '—', hours: 0 };
  const ms = Date.now() - new Date(String(iso).replace(' ', 'T')).getTime();
  if (isNaN(ms)) return { label: '—', hours: 0 };
  const h = ms / 3_600_000;
  if (h < 1) return { label: `${Math.max(1, Math.round(ms / 60000))}m`, hours: h };
  if (h < 24) return { label: `${Math.round(h)}h`, hours: h };
  return { label: `${Math.round(h / 24)}d`, hours: h };
};
const statePill = (s: string) => {
  const st = String(s || '').toUpperCase();
  const cls = st === 'COMPLETE' ? 'bg-emerald-50 text-emerald-700' : st === 'DRAFT' ? 'bg-stone-100 text-stone-600' : 'bg-amber-50 text-amber-700';
  return <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${cls}`}>{st || 'ASSIGNED'}</span>;
};
const taskCounts = (job: any) => {
  const t = job.tasks || [];
  return {
    total: job.task_count ?? t.length,
    done: job.done_count ?? t.filter((x: any) => Number(x.is_done) === 1).length,
    pendMand: job.pending_mandatory ?? t.filter((x: any) => Number(x.is_mandatory) === 1 && Number(x.is_done) === 0).length,
  };
};

export function ChecklistBoard({ restaurantId, token }: Props) {
  const api = useCallback(makeApi(restaurantId, token), [restaurantId, token]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [status, setStatus] = useState<'OPEN' | 'ALL'>('OPEN');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [detail, setDetail] = useState<any | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const r = await api(`/checklists/board?status=${status}`);
      setJobs(Array.isArray(r?.jobs) ? r.jobs : []);
    } catch (e: any) { setErr(e?.message || 'Failed to load'); }
    finally { setLoading(false); }
  }, [api, status]);
  useEffect(() => { load(); }, [load]);

  const columns = useMemo<ColDef<any>[]>(() => [
    {
      key: 'name', label: 'Checklist', sortable: true, searchable: true, hideable: false,
      getValue: (j) => j.template_name || TRIGGER_LABEL[j.trigger_event] || 'Checklist',
      render: (j) => (
        <div className="flex items-center gap-2">
          <button onClick={() => setDetail(j)} className="font-semibold text-blue-600 hover:text-blue-800 hover:underline text-left">
            {j.template_name || TRIGGER_LABEL[j.trigger_event] || 'Checklist'}
          </button>
          {Number(j.blocks_release) === 1 && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-600 whitespace-nowrap">blocks</span>}
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
    {
      key: 'assignee', label: 'Assigned to', sortable: true, filterable: true, filterType: 'select',
      getValue: (j) => j.assigned_to_user || ROLE_LABEL[j.assigned_to_role] || j.assigned_to_role || '',
    },
    {
      key: 'age', label: 'Age', sortable: true, align: 'center', searchable: false,
      getValue: (j) => ageOf(j.created_at).hours,
      render: (j) => { const a = ageOf(j.created_at); return <span className={`tabular-nums ${a.hours >= 24 ? 'text-amber-700 font-bold' : ''}`}>{a.label}</span>; },
      exportValue: (j) => ageOf(j.created_at).label,
    },
    {
      key: 'progress', label: 'Progress', sortable: true, align: 'center', searchable: false,
      getValue: (j) => { const c = taskCounts(j); return c.total ? c.done / c.total : 0; },
      render: (j) => { const { total, done, pendMand } = taskCounts(j); return <span className="tabular-nums whitespace-nowrap">{done}/{total}{pendMand > 0 ? <span className="text-[11px] text-rose-600"> · {pendMand} req</span> : ''}</span>; },
      exportValue: (j) => { const { total, done } = taskCounts(j); return `${done}/${total}`; },
    },
    {
      key: 'status', label: 'Status', sortable: true, align: 'center', filterable: true, filterType: 'select',
      getValue: (j) => String(j.workflow_state || 'ASSIGNED').toUpperCase(),
      render: (j) => statePill(j.workflow_state),
    },
  ], []);

  if (detail) {
    return <ChecklistDetail restaurantId={restaurantId} token={token} job={detail} onBack={() => { setDetail(null); load(); }} />;
  }

  const open = jobs.filter(j => j.status === 'OPEN');
  const blocking = open.filter(j => Number(j.blocks_release) === 1).length;
  const overdue = open.filter(j => ageOf(j.created_at).hours >= 24).length;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-3xl font-bold font-serif text-[#1a1208]">Checklist Board</h2>
        <p className="text-sm text-[#6b5d52] mt-1">Every checklist across the property — what's pending, who owns it, and how long it's been open. Sort or filter any column, choose which columns to show, and click a checklist to open its tasks, remarks and related objects.</p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-3 max-w-xl">
        <div className="rounded-2xl border border-[#e8ded0] bg-white p-3"><p className="text-[10px] uppercase tracking-widest text-[#9c8e85]">Open</p><p className="text-2xl font-bold text-[#1a1208] tabular-nums">{open.length}</p></div>
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-3"><p className="text-[10px] uppercase tracking-widest text-rose-500">Blocking release</p><p className="text-2xl font-bold text-rose-700 tabular-nums">{blocking}</p></div>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3"><p className="text-[10px] uppercase tracking-widest text-amber-600">Open &gt; 24h</p><p className="text-2xl font-bold text-amber-700 tabular-nums">{overdue}</p></div>
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
        tableId="checklist-board"
        searchPlaceholder="Search checklists…"
        exportFilename="checklist-board"
        emptyMessage="No checklists match these filters."
        toolbarLeft={
          <div className="flex items-center gap-1.5">
            <select value={status} onChange={e => setStatus(e.target.value as any)} className="text-sm border border-[#e8dccf] rounded-xl px-2 py-1.5 bg-white outline-none focus:ring-2 ring-[#cc5a16]/20">
              <option value="OPEN">Open only</option>
              <option value="ALL">All checklists</option>
            </select>
            <button onClick={load} className="px-3 py-1.5 border border-[#e8dccf] text-sm rounded-xl hover:border-[#cc5a16]/50 hover:text-[#cc5a16] transition-colors">Refresh</button>
          </div>
        }
      />
    </div>
  );
}
