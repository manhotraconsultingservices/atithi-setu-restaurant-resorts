// Platform console — tenant directory (phase 1 of the admin redesign).
// A searchable, filterable, sortable table paged on the server
// (GET /api/admin/tenants/directory) with a side panel per tenant
// (GET /api/admin/tenants/:id/overview). Every per-tenant action that used to
// sit on a tile lives in the panel and calls the same endpoints as before.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Copy, ExternalLink, ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { usePaymentDialog } from '../components/PaymentDialog';
import { todayIST } from '../lib/utils';

type TRow = any;
const CHIPS: [string, string][] = [
  ['ALL', 'All'], ['PENDING', 'Needs approval'], ['ACTIVE', 'Active'], ['OVERDUE', 'Overdue'], ['SUSPENDED', 'Suspended'],
  ['INACTIVE', 'Inactive'], ['SPA', 'Spa'], ['EVENTS', 'Events'], ['QUIET', 'Quiet 30+ days'],
];
const MODS: [string, string, string, string][] = [
  ['spa', 'SP', 'Spa & Wellness', 'Treatments, therapists, cabins and the spa booking page.'],
  ['events', 'EV', 'Events & Convention', 'Halls, event bookings, quotations and event invoices.'],
  ['payments', 'PY', 'Online payments', 'Payment links and online payment on public pages.'],
  ['whatsapp', 'WA', 'WhatsApp', 'Guest and staff messages from the shared WhatsApp sender.'],
  ['accounts', 'AC', 'Accounts', 'Ledger, P&L, GST summary and receivables.'],
  ['people', 'PE', 'People', 'Attendance, roster, timesheets and payroll.'],
];
const MOD_ROUTE: Record<string, string> = { spa: 'spa/enable', events: 'events/enable', payments: 'modules/online-payments/enable', whatsapp: 'modules/whatsapp/enable', accounts: 'modules/accounts/enable', people: 'modules/people/enable' };
const BILL: Record<string, [string, string]> = {
  SUSPENDED: ['Suspended', 'crit'], OVERDUE_PAST_GRACE: ['Overdue', 'crit'], OVERDUE_GRACE: ['In grace', 'warn'],
  DUE_SOON: ['Due soon', 'info'], ACTIVE: ['Paid up', 'ok'], NO_DUE_DATE: ['No due date', 'mute'],
};
const TONE: Record<string, string> = {
  ok: 'bg-emerald-50 text-emerald-700', warn: 'bg-amber-50 text-amber-800', crit: 'bg-rose-50 text-rose-700',
  info: 'bg-sky-50 text-sky-700', mute: 'bg-slate-100 text-slate-600',
};
const TYPE_LABEL: Record<string, string> = { RESTAURANT: 'Restaurant', HOTEL: 'Hotel', BOTH: 'Hotel + Restaurant' };
const PLANS = [['', '—'], ['STARTER', 'Starter'], ['PROFESSIONAL', 'Professional'], ['MULTI_OUTLET', 'Multi-outlet'], ['BOUTIQUE', 'Boutique'], ['RESORT', 'Resort']];

const d10 = (v: any) => (v ? String(v).slice(0, 10) : '');
const fmtDate = (v: any) => { const s = d10(v); if (!s) return '—'; const d = new Date(s + 'T00:00:00'); return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); };
const ago = (v: any) => {
  if (!v) return 'Never';
  const days = Math.floor((Date.now() - new Date(v).getTime()) / 864e5);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago`;
};
const statusOf = (r: TRow): [string, string] => Number(r.access_revoked) === 1 ? ['Suspended', 'crit']
  : Number(r.is_active) === 1 ? ['Active', 'ok'] : Number(r.is_active) === 2 ? ['Inactive', 'mute'] : ['Needs approval', 'warn'];
const Pill = ({ label, tone }: { label: string; tone: string }) => (
  <span className={`inline-flex items-center gap-1.5 h-[22px] px-2 rounded-full text-[11.5px] font-medium whitespace-nowrap ${TONE[tone] || TONE.mute}`}>
    <span className="w-1.5 h-1.5 rounded-full bg-current" />{label}
  </span>
);
const Mods = ({ r }: { r: TRow }) => (
  <span className="flex gap-1">{MODS.map(([k, a, l]) => (
    <span key={k} title={`${l}: ${Number(r[k]) ? 'on' : 'off'}`}
      className={`w-[22px] h-[22px] rounded-md grid place-items-center text-[9.5px] font-bold font-mono ${Number(r[k]) ? 'bg-brand/10 text-brand' : 'bg-slate-100 text-slate-400 border border-slate-200'}`}>{a}</span>
  ))}</span>
);

export type ConsoleTool = 'DATA_LOADER' | 'SQL' | 'ROLE_ACCESS';
export function TenantDirectory({ token, role, fixedChip, heading, blurb, openRequest, onTool }: {
  token: string; role: string;
  /** Pins the list to one filter (Approvals = PENDING) and hides the filter chips. */
  fixedChip?: string;
  heading?: string; blurb?: string;
  /** Opens this tenant's panel; n changes on every request so the same id can be reopened. */
  openRequest?: { id: string; n: number } | null;
  /** Opens a console tool already scoped to the tenant (Maintenance tab). */
  onTool?: (tool: ConsoleTool, tenantId: string, module?: 'HOTEL' | 'SPA' | 'EVENTS') => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePaymentDialog();
  const isSuper = role === 'SUPER_ADMIN';
  const [chip, setChip] = useState<string>(() => { if (fixedChip) return fixedChip; try { return localStorage.getItem('adm:dir:chip') || 'ALL'; } catch { return 'ALL'; } });
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [type, setType] = useState('');
  const [rep, setRep] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'joined', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ rows: TRow[]; total: number; counts: any; reps: any[] }>({ rows: [], total: 0, counts: {}, reps: [] });
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const LIMIT = 50;

  const api = useCallback(async (path: string, init: RequestInit = {}) => {
    const r = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b?.error || `Request failed (${r.status})`);
    return b;
  }, [token]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ chip, q, sort: sort.key, dir: sort.dir, page: String(page), limit: String(LIMIT) });
      if (type) p.set('type', type);
      if (rep) p.set('rep', rep);
      const d = await api(`/api/admin/tenants/directory?${p}`);
      setData({ rows: d.rows || [], total: Number(d.total || 0), counts: d.counts || {}, reps: d.reps || [] });
    } catch (e: any) { toast.error(e.message); }
    finally { setLoading(false); }
  }, [api, chip, q, sort, page, type, rep]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setTimeout(() => { setQ(qLive.trim()); setPage(1); }, 250); return () => clearTimeout(t); }, [qLive]);
  useEffect(() => { if (fixedChip) return; try { localStorage.setItem('adm:dir:chip', chip); } catch { /* private mode */ } }, [chip, fixedChip]);
  useEffect(() => { if (openRequest?.id) setOpenId(openRequest.id); }, [openRequest?.n]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && openId) setOpenId(null);
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [openId]);

  const pages = Math.max(1, Math.ceil(data.total / LIMIT));
  const setChipTo = (c: string) => { setChip(c); setPage(1); setSel(new Set()); };
  const sortBy = (key: string) => setSort(s => ({ key, dir: s.key === key ? (s.dir === 'asc' ? 'desc' : 'asc') : (key === 'active' ? 'desc' : 'asc') }));
  const c = data.counts || {};
  const kpis: [string, number, string, string][] = [
    ['Tenants', c.ALL, '', 'ALL'], ['Active', c.ACTIVE, '', 'ACTIVE'], ['Needs approval', c.PENDING, 'text-amber-700', 'PENDING'],
    ['Overdue billing', c.OVERDUE, 'text-rose-700', 'OVERDUE'], ['Suspended', c.SUSPENDED, 'text-rose-700', 'SUSPENDED'],
  ];

  const exportCsv = (rows: TRow[]) => {
    const cols = ['id', 'name', 'city', 'state', 'property_type', 'owner_name', 'owner_email', 'owner_phone', 'subscription_plan', 'subscription_due_date', 'billing_status', 'sales_rep_name', 'last_active_at', 'is_active'];
    const esc = (v: any) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.join(','), ...rows.map(r => cols.map(k => esc(r[k])).join(','))].join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `tenants-${todayIST()}.csv`; a.click();
  };
  const selectedRows = data.rows.filter(r => sel.has(r.id));
  const bulkApprove = async () => {
    const pending = selectedRows.filter(r => !Number(r.is_active));
    if (!pending.length) { toast.info('None of the selected tenants is waiting for approval.'); return; }
    if (!await confirm({ title: `Approve ${pending.length} tenant(s)?`, body: 'They can sign in straight away.', confirmLabel: 'Approve' })) return;
    let ok = 0;
    for (const r of pending) { try { await api(`/api/admin/restaurants/${r.id}/toggle-status`, { method: 'POST', body: JSON.stringify({ is_active: 1 }) }); ok++; } catch { /* reported below */ } }
    toast.success(`Approved ${ok} of ${pending.length}.`); setSel(new Set()); load();
  };
  const bulkRep = async () => {
    const r = await prompt({ title: `Assign a sales rep to ${sel.size} tenant(s)`, fields: [{ name: 'rep', label: 'Sales rep', type: 'select', required: true, options: [{ value: '', label: 'Unassigned' }, ...data.reps.map((x: any) => ({ value: x.id, label: x.name }))] }], confirmLabel: 'Assign' });
    if (!r) return;
    let ok = 0;
    for (const id of sel) { try { await api(`/api/admin/restaurants/${id}/sales-rep`, { method: 'PATCH', body: JSON.stringify({ sales_rep_id: r.rep || null }) }); ok++; } catch { /* */ } }
    toast.success(`Updated ${ok} tenant(s).`); setSel(new Set()); load();
  };


  return (
    <div className="space-y-4 text-slate-900">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[22px] font-semibold tracking-tight">{heading || 'Tenant directory'}</h2>
          <p className="text-[13px] text-slate-500">{blurb || 'Every property on the platform. Click a row to manage it.'}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => exportCsv(data.rows)} className="h-9 px-3 rounded-lg border border-slate-200 bg-white text-[13px] font-medium inline-flex items-center gap-1.5 hover:border-slate-300"><Download size={14} /> Export page</button>
        </div>
      </div>

      {!fixedChip && <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-slate-200 border border-slate-200 rounded-xl overflow-hidden">
        {kpis.map(([l, v, cls, ch]) => (
          <button key={l} type="button" onClick={() => setChipTo(ch)} className={`bg-white px-4 py-3 text-left hover:bg-slate-50 ${chip === ch ? 'ring-2 ring-inset ring-brand/40' : ''}`}>
            <div className="text-[11.5px] text-slate-500">{l}</div>
            <div className={`font-mono text-[21px] tabular-nums ${cls}`}>{Number(v || 0).toLocaleString('en-IN')}</div>
          </button>
        ))}
      </div>}

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative flex-1 min-w-[220px] max-w-[520px]">
          <Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
          <input ref={searchRef} id="tenant-search" value={qLive} onChange={e => setQLive(e.target.value)}
            placeholder="Search name, ID, owner, email, phone, city"
            className="w-full h-9 pl-9 pr-3 rounded-lg border border-slate-200 bg-white text-[13.5px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/15" />
        </label>
        <select id="tenant-type" value={type} onChange={e => { setType(e.target.value); setPage(1); }} className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-[13px] text-slate-600">
          <option value="">All types</option><option value="HOTEL">Hotel</option><option value="RESTAURANT">Restaurant</option><option value="BOTH">Hotel + Restaurant</option>
        </select>
        {role !== 'SALES_REP' && (
          <select id="tenant-rep" value={rep} onChange={e => { setRep(e.target.value); setPage(1); }} className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-[13px] text-slate-600">
            <option value="">All sales reps</option><option value="UNASSIGNED">Unassigned</option>
            {data.reps.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        )}
      </div>

      {!fixedChip && <div className="flex flex-wrap gap-1.5">
        {CHIPS.map(([k, l]) => (
          <button key={k} type="button" aria-pressed={chip === k} onClick={() => setChipTo(k)}
            className={`h-[30px] px-3 rounded-full border text-[12.5px] inline-flex items-center gap-1.5 ${chip === k ? 'bg-slate-900 border-slate-900 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'}`}>
            {l}<span className={`font-mono text-[11px] ${chip === k ? 'text-white/70' : 'text-slate-400'}`}>{Number(c[k] || 0).toLocaleString('en-IN')}</span>
          </button>
        ))}
      </div>}

      {sel.size > 0 && isSuper && (
        <div className="flex flex-wrap items-center gap-2 bg-slate-900 text-white rounded-xl px-4 py-2 text-[13px]">
          <span>{sel.size} selected</span><span className="flex-1" />
          <button type="button" onClick={bulkApprove} className="h-8 px-3 rounded-lg border border-white/25 hover:bg-white/10">Approve</button>
          <button type="button" onClick={bulkRep} className="h-8 px-3 rounded-lg border border-white/25 hover:bg-white/10">Assign sales rep</button>
          <button type="button" onClick={() => exportCsv(selectedRows)} className="h-8 px-3 rounded-lg border border-white/25 hover:bg-white/10">Export</button>
          <button type="button" onClick={() => setSel(new Set())} className="h-8 px-3 rounded-lg border border-white/25 hover:bg-white/10">Clear</button>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full min-w-[1040px] border-collapse">
            <thead className="bg-slate-50 text-[11px] font-semibold text-slate-500 border-b border-slate-200">
              <tr>
                <th className="w-9 px-3">{isSuper && <input type="checkbox" aria-label="Select all on this page" className="accent-brand"
                  checked={data.rows.length > 0 && data.rows.every(r => sel.has(r.id))}
                  onChange={e => setSel(e.target.checked ? new Set(data.rows.map(r => r.id)) : new Set())} />}</th>
                <SortTh k="name" sort={sort} onSort={sortBy}>Business</SortTh>
                <th className="px-3 py-2.5 text-left uppercase tracking-wider">Type</th>
                <th className="px-3 py-2.5 text-left uppercase tracking-wider">Modules</th>
                <SortTh k="owner" sort={sort} onSort={sortBy}>Owner</SortTh>
                <SortTh k="due" sort={sort} onSort={sortBy}>Plan · due</SortTh>
                <SortTh k="billing" sort={sort} onSort={sortBy}>Billing</SortTh>
                <SortTh k="rep" sort={sort} onSort={sortBy}>Sales rep</SortTh>
                <SortTh k="active" sort={sort} onSort={sortBy}>Last active</SortTh>
                <SortTh k="status" sort={sort} onSort={sortBy}>Status</SortTh>
              </tr>
            </thead>
            <tbody className="text-[13px]">
              {loading && !data.rows.length ? (
                <tr><td colSpan={10} className="py-14 text-center text-slate-400">Loading…</td></tr>
              ) : !data.rows.length ? (
                <tr><td colSpan={10} className="py-14 text-center text-slate-500">No tenant matches. Try a shorter search or another filter.</td></tr>
              ) : data.rows.map(r => {
                const [sl, st] = statusOf(r); const [bl, bt] = BILL[r.billing_status] || ['—', 'mute'];
                return (
                  <tr key={r.id} onClick={() => setOpenId(r.id)} className={`border-b border-slate-100 last:border-0 cursor-pointer hover:bg-slate-50 ${sel.has(r.id) ? 'bg-brand/5' : ''} ${openId === r.id ? 'bg-brand/5' : ''}`}>
                    <td className="px-3" onClick={e => e.stopPropagation()}>{isSuper && <input type="checkbox" className="accent-brand" aria-label={`Select ${r.name}`} checked={sel.has(r.id)}
                      onChange={e => { const n = new Set(sel); e.target.checked ? n.add(r.id) : n.delete(r.id); setSel(n); }} />}</td>
                    <td className="px-3 py-2.5"><div className="font-semibold">{r.name}</div><div className="text-[12px] text-slate-500">{[r.city, r.state].filter(Boolean).join(', ') || '—'}</div><div className="font-mono text-[11px] text-slate-400">{r.id}</div></td>
                    <td className="px-3"><span className="text-[11.5px] border border-slate-200 rounded-md px-1.5 py-0.5 text-slate-600 whitespace-nowrap">{TYPE_LABEL[r.property_type] || r.property_type}</span></td>
                    <td className="px-3"><Mods r={r} /></td>
                    <td className="px-3"><div className="font-medium">{r.owner_name || '—'}</div><div className="text-[12px] text-slate-500">{r.owner_email || ''}</div></td>
                    <td className="px-3"><div className="font-medium">{PLANS.find(p => p[0] === r.subscription_plan)?.[1] || r.subscription_plan || '—'}</div><div className="font-mono text-[12px] text-slate-500">{fmtDate(r.subscription_due_date)}</div></td>
                    <td className="px-3"><Pill label={bl} tone={bt} /></td>
                    <td className="px-3">{r.sales_rep_name || <span className="text-slate-400">Unassigned</span>}</td>
                    <td className="px-3 font-mono text-[12px] text-slate-600">{ago(r.last_active_at)}</td>
                    <td className="px-3"><Pill label={sl} tone={st} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="md:hidden divide-y divide-slate-100">
          {data.rows.map(r => { const [sl, st] = statusOf(r); const [bl, bt] = BILL[r.billing_status] || ['—', 'mute']; return (
            <button key={r.id} type="button" onClick={() => setOpenId(r.id)} className="w-full text-left px-4 py-3 grid grid-cols-[1fr_auto] gap-1">
              <div><div className="font-semibold">{r.name}</div><div className="text-[12px] text-slate-500">{r.city || '—'} · {TYPE_LABEL[r.property_type] || r.property_type}</div></div>
              <Pill label={sl} tone={st} />
              <div className="col-span-2 flex flex-wrap items-center gap-2"><span className="font-mono text-[11px] text-slate-400">{r.id}</span><Pill label={bl} tone={bt} /><Mods r={r} /></div>
            </button>
          ); })}
          {!data.rows.length && <div className="py-10 text-center text-slate-500 text-sm">{loading ? 'Loading…' : 'No tenant matches.'}</div>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 border-t border-slate-200 text-[12.5px] text-slate-500">
          <span>{data.total ? `Showing ${((page - 1) * LIMIT + 1).toLocaleString('en-IN')}–${Math.min(data.total, page * LIMIT).toLocaleString('en-IN')} of ${data.total.toLocaleString('en-IN')}` : 'No results'}</span>
          <div className="flex items-center gap-2">
            <button type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="h-8 px-2.5 rounded-lg border border-slate-200 bg-white disabled:opacity-40 inline-flex items-center"><ChevronLeft size={14} />Previous</button>
            <span className="font-mono">{page} / {pages}</span>
            <button type="button" disabled={page >= pages} onClick={() => setPage(p => p + 1)} className="h-8 px-2.5 rounded-lg border border-slate-200 bg-white disabled:opacity-40 inline-flex items-center">Next<ChevronRight size={14} /></button>
          </div>
        </div>
      </div>

      {openId && <TenantPanel id={openId} api={api} role={role} reps={data.reps} onClose={() => setOpenId(null)} onChanged={load} onTool={onTool} />}
    </div>
  );
}

// ── Side panel for one tenant ────────────────────────────────────────────────
const TABS = ['Overview', 'Modules', 'Owner & access', 'Billing', 'Maintenance'] as const;
function TenantPanel({ id, api, role, reps, onClose, onChanged, onTool }: { id: string; api: (p: string, i?: RequestInit) => Promise<any>; role: string; reps: any[]; onClose: () => void; onChanged: () => void; onTool?: (tool: ConsoleTool, tenantId: string, module?: 'HOTEL' | 'SPA' | 'EVENTS') => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePaymentDialog();
  const isSuper = role === 'SUPER_ADMIN';
  const isRep = role === 'SALES_REP';
  const [t, setT] = useState<any>(null);
  const [tab, setTab] = useState<typeof TABS[number]>('Overview');
  const [busy, setBusy] = useState(false);
  const [bill, setBill] = useState<any>({});
  const load = useCallback(async () => {
    try { const d = await api(`/api/admin/tenants/${encodeURIComponent(id)}/overview`); setT(d); setBill({}); }
    catch (e: any) { toast.error(e.message); onClose(); }
  }, [id, api]);
  useEffect(() => { setT(null); setTab('Overview'); load(); }, [load]);

  const run = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); await load(); onChanged(); }
    catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  };
  if (!t) return (
    <Shell onClose={onClose} title="Loading…"><div className="p-6 text-sm text-slate-400">Loading…</div></Shell>
  );
  const [sl, st] = statusOf(t);
  const [bl, bt] = BILL[t.billing_status] || ['—', 'mute'];
  const apex = typeof window !== 'undefined' && /atithi-setu\.com$/.test(window.location.hostname) ? 'atithi-setu.com' : 'atithi-setu.com';
  const setActive = (v: number, label: string) => run(() => api(`/api/admin/restaurants/${t.id}/toggle-status`, { method: 'POST', body: JSON.stringify({ is_active: v }) }), label);
  const off = busy || !isSuper;
  // A sales rep may approve a business of theirs that is waiting, and load the
  // demo tariff into one that is not live yet. The server enforces both.
  const pending = !Number(t.is_active);
  const approveOff = busy || !(isSuper || (isRep && pending));
  const isHotel = t.property_type === 'HOTEL' || t.property_type === 'BOTH';
  const seedOff = busy || !(isSuper || (isRep && Number(t.is_active) !== 1));
  const seedTariff = async () => {
    if (!await confirm({ title: `Load the demo tariff into ${t.name}?`, body: 'Creates or refreshes 3 room categories, 27 sample rooms, 4 seasons and 24 rate cells, and switches the property to matrix pricing. Safe to run again.', confirmLabel: 'Load demo tariff' })) return;
    run(() => api(`/api/admin/tenants/${t.id}/seed-bcg-tariff`, { method: 'POST' }), 'Demo tariff loaded.');
  };

  const toggleModule = async (k: string, label: string, on: boolean) => {
    if (!await confirm({ title: `${on ? 'Switch on' : 'Switch off'} ${label}?`, body: `${t.name} ${on ? 'gets' : 'loses'} ${label} straight away.${on ? '' : ' Its records are kept.'}`, confirmLabel: on ? 'Switch on' : 'Switch off', danger: !on })) return;
    run(() => api(`/api/restaurant/${t.id}/${MOD_ROUTE[k]}`, { method: 'POST', body: JSON.stringify({ enabled: on }) }), `${label} ${on ? 'on' : 'off'}.`);
  };
  const setType = async (v: string) => {
    if (v === t.property_type) return;
    if (!await confirm({ title: `Make ${t.name} ${TYPE_LABEL[v].toLowerCase()}?`, body: v === 'RESTAURANT' ? 'Hotel screens are hidden. Hotel data is kept.' : 'Confirm the property is on a hotel-tier subscription first.', confirmLabel: 'Change type' })) return;
    const body: any = v === 'RESTAURANT' ? { enabled: false } : { enabled: true, type: v };
    run(() => api(`/api/restaurant/${t.id}/hotel/enable`, { method: 'POST', body: JSON.stringify(body) }), 'Business type updated.');
  };
  const editIdentity = async () => {
    const r = await prompt({ title: 'Business name and address', fields: [
      { name: 'name', label: 'Business name', type: 'text', required: true, defaultValue: t.name },
      { name: 'slug', label: `Subdomain (…${apex})`, type: 'text', required: true, defaultValue: t.slug || '' },
    ], confirmLabel: 'Save' });
    if (!r) return;
    const slug = String(r.slug).toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (slug !== (t.slug || '') && !await confirm({ title: `Change the address to ${slug}.${apex}?`, body: `The old address (${t.slug || '—'}.${apex}) stops working once its DNS is removed. Bookmarks and QR codes on it break.`, confirmLabel: 'Change address', danger: true })) return;
    run(() => api(`/api/admin/restaurants/${t.id}/identity`, { method: 'PATCH', body: JSON.stringify({ name: String(r.name).trim(), slug }) }), 'Saved.');
  };
  const editOwner = async () => {
    const r = await prompt({ title: 'Owner', fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, defaultValue: t.owner_name || '' },
      { name: 'email', label: 'Email', type: 'text', required: true, defaultValue: t.owner_email || '' },
      { name: 'phone', label: 'Phone', type: 'text', defaultValue: t.owner_phone || '' },
    ], confirmLabel: 'Save owner' });
    if (!r) return;
    setBusy(true);
    try {
      const d = await api(`/api/admin/owner/${t.id}`, { method: 'PATCH', body: JSON.stringify({ name: r.name, email: r.email, phone: r.phone }) });
      toast.success(d?.isNew ? `Owner account created. Login ${d.loginId}, temporary password ${d.tempPassword} — share it with the owner.` : 'Owner saved.');
      await load(); onChanged();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };
  const resetPassword = async () => {
    const r = await prompt({ title: `New password for ${t.owner_name || 'the owner'}`, fields: [{ name: 'pass', label: 'New password', type: 'password', required: true }], confirmLabel: 'Reset password' });
    if (!r?.pass) return;
    run(() => api('/api/admin/reset-owner-password', { method: 'POST', body: JSON.stringify({ restaurantId: t.id, newPassword: r.pass }) }), 'Password reset. Share it with the owner.');
  };
  const saveBilling = () => {
    const allowed = ['subscription_plan', 'subscription_due_date', 'grace_period_days', 'last_payment_date', 'last_payment_amount', 'last_payment_reference', 'billing_notes'];
    const body: any = {}; for (const k of allowed) if (bill[k] !== undefined) body[k] = bill[k] === '' ? null : bill[k];
    if (!Object.keys(body).length) { toast.info('Nothing changed.'); return; }
    run(() => api(`/api/admin/tenants/${t.id}/billing`, { method: 'PUT', body: JSON.stringify(body) }), 'Billing saved.');
  };
  const suspend = async () => {
    const r = await prompt({ title: `Suspend ${t.name}?`, body: 'Every sign-in at the property is blocked until access is restored.', fields: [{ name: 'reason', label: 'Reason (shown in the audit)', type: 'textarea', required: true }], confirmLabel: 'Suspend' });
    if (!r?.reason) return;
    run(() => api(`/api/admin/tenants/${t.id}/revoke-access`, { method: 'POST', body: JSON.stringify({ reason: r.reason }) }), 'Access suspended.');
  };
  const bv = (k: string) => (bill[k] !== undefined ? bill[k] : (k.endsWith('_date') ? d10(t[k]) : (t[k] ?? '')));

  return (
    <Shell onClose={onClose} title={t.name} sub={<><Pill label={sl} tone={st} /><span className="font-mono">{t.id}</span><span>{[t.city, t.state].filter(Boolean).join(', ')}</span></>}
      actions={<>
        <button type="button" onClick={() => { navigator.clipboard?.writeText(t.id); toast.success('Tenant ID copied.'); }} className="h-8 px-3 rounded-lg border border-slate-200 bg-white text-[12.5px] inline-flex items-center gap-1.5"><Copy size={13} />Copy ID</button>
        {t.slug && <a href={`https://${t.slug}.${apex}`} target="_blank" rel="noreferrer" className="h-8 px-3 rounded-lg border border-slate-200 bg-white text-[12.5px] inline-flex items-center gap-1.5"><ExternalLink size={13} />Open site</a>}
        {isHotel && <a href={`/book/${t.booking_slug || t.id}`} target="_blank" rel="noreferrer" className="h-8 px-3 rounded-lg border border-slate-200 bg-white text-[12.5px] inline-flex items-center gap-1.5"><ExternalLink size={13} />Booking page</a>}
      </>}
      tabs={<div className="flex gap-1 border-b border-slate-200 px-3 overflow-x-auto" role="tablist">{TABS.map(x => (
        <button key={x} type="button" role="tab" aria-selected={tab === x} onClick={() => setTab(x)}
          className={`px-2 py-2.5 text-[13px] border-b-2 whitespace-nowrap ${tab === x ? 'border-brand text-slate-900 font-semibold' : 'border-transparent text-slate-500'}`}>{x}</button>
      ))}</div>}>
      {!isSuper && <div className="text-[12px] bg-slate-50 text-slate-600 rounded-lg px-3 py-2">{isRep ? 'You can approve a business that is waiting and load the demo tariff before it goes live. Other changes are made by a super admin.' : 'View only — changes are made by a super admin.'}</div>}

      {tab === 'Overview' && (<>
        <div className="grid grid-cols-3 gap-2">
          {[['Staff logins', t.counts?.staff_logins], ['Rooms', t.counts?.rooms], ['Halls', t.counts?.halls]].map(([l, v]) => (
            <div key={l as string} className="border border-slate-200 rounded-lg px-3 py-2"><div className="text-[11.5px] text-slate-500">{l}</div><div className="font-mono text-[17px]">{v ?? '—'}</div></div>
          ))}
        </div>
        <Section title="Business" action={isSuper && <button type="button" onClick={editIdentity} className="text-[12px] text-brand font-medium">Edit name or address</button>}>
          <KV k="Tenant ID" v={<span className="font-mono">{t.id}</span>} />
          <KV k="Type" v={TYPE_LABEL[t.property_type] || t.property_type} />
          <KV k="Address" v={<span className="font-mono">{t.slug ? `${t.slug}.${apex}` : '—'}</span>} />
          <KV k="GSTIN" v={t.gst_number || 'None on file — GST cannot be charged'} />
          <KV k="Joined" v={fmtDate(t.registered_at)} />
          <KV k="Last active" v={ago(t.last_active_at)} />
        </Section>
        <Section title="Owner">
          <KV k="Name" v={t.owner_name || '—'} /><KV k="Email" v={t.owner_email || '—'} /><KV k="Phone" v={t.owner_phone || '—'} /><KV k="Sales rep" v={t.sales_rep_name || 'Unassigned'} />
        </Section>
      </>)}

      {tab === 'Modules' && (<>
        <div className="text-[12px] bg-slate-50 text-slate-600 rounded-lg px-3 py-2">A change takes effect for the property straight away. Online payments, WhatsApp, Accounts and People are paid add-ons.</div>
        <div className="border border-slate-200 rounded-xl">
          <Row title="Business type" sub="Which of Hotel and Restaurant the property sees.">
            <span className="inline-flex border border-slate-200 rounded-lg overflow-hidden">
              {['RESTAURANT', 'HOTEL', 'BOTH'].map(v => (
                <button key={v} type="button" disabled={busy || !isSuper} aria-pressed={t.property_type === v} onClick={() => setType(v)}
                  className={`px-2.5 py-1.5 text-[12px] ${t.property_type === v ? 'bg-slate-900 text-white' : 'bg-white text-slate-600'} disabled:opacity-60`}>{v === 'BOTH' ? 'Both' : TYPE_LABEL[v]}</button>
              ))}
            </span>
          </Row>
          {MODS.map(([k, , l, sub]) => <Row key={k} title={l} sub={sub}><Switch off={off} on={!!Number(t[k])} label={l} onToggle={() => toggleModule(k, l, !Number(t[k]))} /></Row>)}
        </div>
      </>)}

      {tab === 'Owner & access' && (
        <div className="border border-slate-200 rounded-xl">
          <Row title="Account status" sub={Number(t.is_active) === 1 ? 'The property can sign in.' : Number(t.is_active) === 2 ? 'Deactivated — nobody at the property can sign in.' : 'Signed up and waiting for approval.'}>
            {Number(t.is_active) === 1
              ? <Btn off={off} onClick={async () => { if (await confirm({ title: `Deactivate ${t.name}?`, body: 'Nobody at the property can sign in until it is re-activated. Records are kept.', confirmLabel: 'Deactivate', danger: true })) setActive(2, 'Deactivated.'); }}>Deactivate</Btn>
              : <Btn off={Number(t.is_active) === 2 ? off : approveOff} tone="primary" onClick={() => setActive(1, Number(t.is_active) === 2 ? 'Re-activated.' : 'Approved and activated.')}>{Number(t.is_active) === 2 ? 'Re-activate' : 'Approve & activate'}</Btn>}
          </Row>
          <Row title="Owner" sub={t.owner_email || 'No owner account yet'}><Btn off={off} onClick={editOwner}>{t.owner_email ? 'Edit owner' : 'Create owner'}</Btn></Row>
          <Row title="Reset owner password" sub="You set a new password and share it with the owner."><Btn off={off} onClick={resetPassword}>Reset</Btn></Row>
          <Row title="Welcome email" sub="Sends the sign-in link and getting-started guide again."><Btn off={off} onClick={() => run(() => api(`/api/admin/restaurants/${t.id}/resend-welcome-email`, { method: 'POST' }), 'Welcome email sent.')}>Resend</Btn></Row>
          <Row title="Sales rep" sub="Who looks after this account.">
            <select id="panel-rep" disabled={busy || !isSuper} value={t.sales_rep_id || ''} onChange={e => run(() => api(`/api/admin/restaurants/${t.id}/sales-rep`, { method: 'PATCH', body: JSON.stringify({ sales_rep_id: e.target.value || null }) }), 'Sales rep updated.')}
              className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-[12.5px]">
              <option value="">Unassigned</option>{reps.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </Row>
        </div>
      )}

      {tab === 'Maintenance' && (<>
        <div className="border border-slate-200 rounded-xl">
          {isSuper && onTool && (<>
            <Row title="Data loader" sub="List, import and clean up this tenant's bookings, opened on this tenant.">
              <span className="flex flex-wrap justify-end gap-1.5">
                {isHotel && <Btn off={busy} onClick={() => onTool('DATA_LOADER', t.id, 'HOTEL')}>Hotel</Btn>}
                {!!Number(t.spa) && <Btn off={busy} onClick={() => onTool('DATA_LOADER', t.id, 'SPA')}>Spa</Btn>}
                {!!Number(t.events) && <Btn off={busy} onClick={() => onTool('DATA_LOADER', t.id, 'EVENTS')}>Events</Btn>}
                {!isHotel && !Number(t.spa) && !Number(t.events) && <span className="text-[12px] text-slate-400">No bookings modules</span>}
              </span>
            </Row>
            <Row title="SQL console" sub="Read-only queries, already pointed at this tenant."><Btn off={busy} onClick={() => onTool('SQL', t.id)}>Open</Btn></Row>
            <Row title="Role access" sub="What each staff role at the property can see and change."><Btn off={busy} onClick={() => onTool('ROLE_ACCESS', t.id)}>Open</Btn></Row>
          </>)}
          {isHotel && <Row title="Demo tariff" sub={Number(t.is_active) === 1 && !isSuper ? 'Only before the business goes live.' : 'Loads sample room categories, rooms and rates for a sales demo. Safe to run again.'}><Btn off={seedOff} onClick={seedTariff}>Load demo tariff</Btn></Row>}
          <Row title="Provision DNS" sub={`Creates ${t.slug || '…'}.${apex} if it is missing.`}><Btn off={off} onClick={() => run(() => api(`/api/admin/restaurants/${t.id}/provision-dns`, { method: 'POST' }), 'DNS record requested.')}>Provision</Btn></Row>
          <Row title="Invoice deletion" sub="Legacy switch. Leave off — invoices are cancelled, never deleted.">
            <Switch off={off} on={!!Number(t.invoice_delete_enabled)} label="Invoice deletion" onToggle={async () => {
              const on = !Number(t.invoice_delete_enabled);
              if (on && !await confirm({ title: 'Allow invoice deletion?', body: 'Deletion skips the ledger reversal. Cancel is the supported way to void an invoice.', confirmLabel: 'Allow', danger: true })) return;
              run(() => api(`/api/admin/restaurants/${t.id}/invoice-delete-flag`, { method: 'PATCH', body: JSON.stringify({ enabled: on }) }), `Invoice deletion ${on ? 'on' : 'off'}.`);
            }} />
          </Row>
        </div>
        {isSuper && Number(t.is_active) === 1 && (
          <div className="border border-rose-100 rounded-xl px-4 py-3 space-y-2">
            <div className="text-[13.5px] font-medium text-rose-700">Danger zone</div>
            <div className="text-[12.5px] text-slate-500">Deactivating stops every sign-in at the property. Its records, invoices and ledger are kept.</div>
            <Btn off={off} tone="danger" onClick={async () => { if (await confirm({ title: `Deactivate ${t.name}?`, body: 'Nobody at the property can sign in until it is re-activated. Records are kept.', confirmLabel: 'Deactivate', danger: true })) setActive(2, 'Deactivated.'); }}>Deactivate tenant</Btn>
          </div>
        )}
      </>)}

      {tab === 'Billing' && (<>
        <div className="flex items-center gap-2"><Pill label={bl} tone={bt} />{Number(t.access_revoked) === 1 && t.access_revoked_reason && <span className="text-[12px] text-slate-500">Reason: {t.access_revoked_reason}</span>}</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Plan"><select id="bill-plan" disabled={!isSuper} value={bv('subscription_plan')} onChange={e => setBill({ ...bill, subscription_plan: e.target.value })} className={INPUT}>{PLANS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Next due"><input id="bill-due" type="date" disabled={!isSuper} value={bv('subscription_due_date')} onChange={e => setBill({ ...bill, subscription_due_date: e.target.value })} className={INPUT} /></Field>
          <Field label="Grace period (days)"><input id="bill-grace" type="number" min={0} disabled={!isSuper} value={bv('grace_period_days')} onChange={e => setBill({ ...bill, grace_period_days: e.target.value })} className={INPUT} /></Field>
          <Field label="Last payment date"><input id="bill-paid-on" type="date" disabled={!isSuper} value={bv('last_payment_date')} onChange={e => setBill({ ...bill, last_payment_date: e.target.value })} className={INPUT} /></Field>
          <Field label="Last payment amount (₹)"><input id="bill-paid-amt" type="number" min={0} disabled={!isSuper} value={bv('last_payment_amount')} onChange={e => setBill({ ...bill, last_payment_amount: e.target.value })} className={INPUT} /></Field>
          <Field label="Payment reference"><input id="bill-ref" disabled={!isSuper} value={bv('last_payment_reference')} onChange={e => setBill({ ...bill, last_payment_reference: e.target.value })} className={INPUT} /></Field>
        </div>
        <Field label="Notes"><textarea id="bill-notes" rows={2} disabled={!isSuper} value={bv('billing_notes')} onChange={e => setBill({ ...bill, billing_notes: e.target.value })} className={`${INPUT} h-auto py-2`} /></Field>
        <div className="flex flex-wrap gap-2">
          <Btn off={off} tone="primary" onClick={saveBilling}>Save billing</Btn>
          {Number(t.access_revoked) === 1
            ? <Btn off={off} onClick={async () => { if (await confirm({ title: `Restore access for ${t.name}?`, body: 'The property can sign in again straight away.', confirmLabel: 'Restore' })) run(() => api(`/api/admin/tenants/${t.id}/restore-access`, { method: 'POST' }), 'Access restored.'); }}>Restore access</Btn>
            : <Btn off={off} tone="danger" onClick={suspend}>Suspend access</Btn>}
        </div>
      </>)}
    </Shell>
  );
}

// Panel building blocks. Top-level on purpose: defined inside a component they
// would be a new type on every render and React would remount them each time.
function SortTh({ k, children, sort, onSort }: { k: string; children: any; sort: { key: string; dir: string }; onSort: (k: string) => void }) {
  return (
    <th className="px-3 py-2.5 text-left">
      <button type="button" onClick={() => onSort(k)} className={`inline-flex items-center gap-1 uppercase tracking-wider ${sort.key === k ? 'text-slate-900' : ''}`}>
        {children}{sort.key === k ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  );
}
function Row({ title, sub, children }: { title: string; sub?: string; children: any; key?: any }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 border-b border-slate-100 last:border-0">
      <div className="min-w-0"><div className="text-[13.5px] font-medium">{title}</div>{sub && <div className="text-[12px] text-slate-500 max-w-[42ch]">{sub}</div>}</div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
function Btn({ onClick, children, tone = '', off }: { onClick: () => void; children: any; tone?: string; off: boolean }) {
  return (
    <button type="button" disabled={off} onClick={onClick}
      className={`h-8 px-3 rounded-lg border text-[12.5px] font-medium disabled:opacity-40 ${tone === 'primary' ? 'bg-brand border-brand text-white' : tone === 'danger' ? 'bg-rose-50 border-rose-100 text-rose-700' : 'bg-white border-slate-200 hover:border-slate-300'}`}>{children}</button>
  );
}
function Switch({ on, label, onToggle, off }: { on: boolean; label: string; onToggle: () => void; off: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={off} onClick={onToggle}
      className={`relative w-[38px] h-[22px] rounded-full transition-colors disabled:opacity-40 ${on ? 'bg-brand' : 'bg-slate-300'}`}>
      <span className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : ''}`} />
    </button>
  );
}

const INPUT = 'w-full h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-[13px] outline-none focus:border-brand disabled:bg-slate-50';
function Field({ label, children }: { label: string; children: any }) {
  return <label className="flex flex-col gap-1 text-[12px] text-slate-500">{label}{children}</label>;
}
function Section({ title, action, children }: { title: string; action?: any; children: any }) {
  return (
    <section>
      <div className="flex items-center justify-between mb-1.5"><h3 className="text-[11px] font-semibold uppercase tracking-[.08em] text-slate-400">{title}</h3>{action}</div>
      <dl className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-x-3 gap-y-1.5 text-[13px]">{children}</dl>
    </section>
  );
}
function KV({ k, v }: { k: string; v: any }) {
  return <><dt className="text-slate-500">{k}</dt><dd className="m-0 min-w-0 break-words">{v}</dd></>;
}
function Shell({ title, sub, actions, tabs, onClose, children }: { title: string; sub?: any; actions?: any; tabs?: any; onClose: () => void; children: any }) {
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label={title} className="absolute top-0 right-0 bottom-0 w-full max-w-[580px] bg-white border-l border-slate-200 shadow-2xl flex flex-col text-slate-900">
        <div className="px-5 pt-5 space-y-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0"><h2 className="text-[19px] font-semibold leading-tight">{title}</h2>{sub && <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12.5px] text-slate-500">{sub}</div>}</div>
            <button type="button" onClick={onClose} aria-label="Close" className="w-8 h-8 rounded-lg border border-slate-200 grid place-items-center text-slate-500 shrink-0"><X size={16} /></button>
          </div>
          {actions && <div className="flex flex-wrap gap-1.5">{actions}</div>}
        </div>
        {tabs && <div className="mt-3">{tabs}</div>}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">{children}</div>
      </aside>
    </div>
  );
}
