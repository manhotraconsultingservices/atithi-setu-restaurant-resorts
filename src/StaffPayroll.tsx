import { useEffect, useState, type ReactNode } from 'react';
import {
  Wallet, Users, TrendingDown, IndianRupee, ChevronLeft, ChevronRight,
  Download, CheckCircle2, Plus, Lock, Clock, CalendarDays,
} from 'lucide-react';

// Cross-module operational payroll (Hotel / Spa / Restaurant / Events) built on
// the shared attendance_staff roster. Hourly wages come from the timesheet
// (actual hours × rate); full-time staff earn a fixed monthly wage. Advances are
// deducted here and recovered when the run is finalized.
type Row = {
  staff_id: string; name: string; role: string; pay_type: string;
  units: number; rate: number; days: number; hours: number;
  gross: number; advance_outstanding: number; advance_deducted: number; net: number; status: string;
};

const money = (n: any) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const r2 = (n: number) => Math.round(n * 100) / 100;

// Human month label, e.g. "July 2026", from a YYYY-MM string (TZ-safe).
const monthLabel = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  if (!y || !mo) return m;
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const shiftMonth = (m: string, delta: number) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, (mo - 1) + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export function StaffPayrollGrid({ token }: { restaurantId: string; token: string }) {
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [data, setData] = useState<{ period: string; rows: Row[]; totals: any } | null>(null);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [adv, setAdv] = useState({ staff_id: '', amount: '', advance_date: new Date().toISOString().slice(0, 10), note: '', payment_method: 'CASH', payment_reference: '' });

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/owner/payroll?month=${month}`, { headers: auth });
      const d = await r.json();
      setData(r.ok ? d : null); setEdits({});
    } catch { setData(null); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [month]);

  const patchStaff = async (staff_id: string, body: any) => {
    try { await fetch(`/api/owner/staff/${staff_id}/settings`, { method: 'PATCH', headers: auth, body: JSON.stringify(body) }); await load(); }
    catch { /* */ }
  };
  const ded = (row: Row) => (edits[row.staff_id] !== undefined ? edits[row.staff_id] : row.advance_deducted);
  const net = (row: Row) => Math.max(0, r2(row.gross - ded(row)));

  const recordAdvance = async () => {
    const amount = Number(adv.amount || 0);
    if (!adv.staff_id || !(amount > 0)) { alert('Pick a staff member and enter an amount'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/owner/staff-advances', { method: 'POST', headers: auth, body: JSON.stringify({ ...adv, amount }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'Failed'); }
      setAdvOpen(false); setAdv({ staff_id: '', amount: '', advance_date: new Date().toISOString().slice(0, 10), note: '', payment_method: 'CASH', payment_reference: '' }); await load();
    } catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };

  const finalize = async () => {
    if (!data) return;
    if (!window.confirm(`Finalize payroll for ${monthLabel(month)} and mark all PAID? Outstanding advances will be recovered.`)) return;
    setBusy(true);
    try {
      const rows = data.rows.map(r => ({ staff_id: r.staff_id, pay_type: r.pay_type, units: r.units, rate: r.rate, gross: r.gross, advance_deducted: ded(r) }));
      const r = await fetch('/api/owner/payroll/finalize', { method: 'POST', headers: auth, body: JSON.stringify({ month, rows }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'Failed'); }
      await load();
    } catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };

  const exportCsv = () => {
    if (!data) return;
    const head = ['Name', 'Role', 'Type', 'Rate', 'Days', 'Hours', 'Gross', 'Advance', 'Net', 'Status'];
    const body = data.rows.map(r => [r.name, r.role || '', r.pay_type, r.rate, r.days, r.hours, r.gross, ded(r), net(r), r.status]);
    const esc = (v: any) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [head, ...body].map(r => r.map(esc).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' }); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `payroll-${month}.csv`; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
  };

  const rows = data?.rows || [];
  const totalGross = rows.reduce((s, r) => s + r.gross, 0);
  const totalDed = rows.reduce((s, r) => s + ded(r), 0);
  const totalNet = rows.reduce((s, r) => s + net(r), 0);
  const totalOutstanding = rows.reduce((s, r) => s + Number(r.advance_outstanding || 0), 0);
  const finalized = rows.length > 0 && rows.every(r => r.status === 'PAID');

  const inp = 'px-2.5 py-1.5 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400';
  const btn = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors';

  return (
    <div className="p-1">
      {/* ── Header + controls ────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="grid place-items-center w-9 h-9 rounded-xl bg-indigo-50 text-indigo-600"><Wallet size={18} /></div>
          <div>
            <h2 className="text-xl font-bold text-gray-900 leading-tight">Staff Payroll</h2>
            <p className="text-xs text-gray-500">Hotel · Spa · Restaurant · Events — one monthly run</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Month stepper */}
          <div className="inline-flex items-center rounded-lg border border-gray-300 bg-white overflow-hidden">
            <button className="px-2 py-1.5 hover:bg-gray-50 text-gray-500" title="Previous month" onClick={() => setMonth(m => shiftMonth(m, -1))}><ChevronLeft size={16} /></button>
            <input type="month" className="px-2 py-1.5 text-sm border-x border-gray-200 focus:outline-none w-[9.5rem]" value={month} onChange={e => setMonth(e.target.value)} />
            <button className="px-2 py-1.5 hover:bg-gray-50 text-gray-500" title="Next month" onClick={() => setMonth(m => shiftMonth(m, 1))}><ChevronRight size={16} /></button>
          </div>
          {month !== thisMonth && <button className={`${btn} bg-gray-100 text-gray-700 hover:bg-gray-200`} onClick={() => setMonth(thisMonth)}>This month</button>}
          <button className={`${btn} bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100`} onClick={() => setAdvOpen(v => !v)}><Plus size={15} />Record advance</button>
          <button className={`${btn} bg-white text-gray-700 border border-gray-300 hover:bg-gray-50`} onClick={exportCsv}><Download size={15} />Export</button>
          <button className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm disabled:opacity-50`} disabled={busy || finalized || !rows.length} onClick={finalize}>
            <CheckCircle2 size={15} />{finalized ? 'Finalized' : 'Finalize & pay'}
          </button>
        </div>
      </div>

      {/* ── KPI summary band ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Kpi icon={<Users size={16} />} tone="slate" label="Headcount" value={String(rows.length)}
          sub={`${rows.filter(r => r.pay_type === 'FULL_TIME').length} full-time · ${rows.filter(r => r.pay_type !== 'FULL_TIME').length} hourly`} />
        <Kpi icon={<IndianRupee size={16} />} tone="indigo" label="Gross wages" value={money(totalGross)} sub={monthLabel(month)} />
        <Kpi icon={<TrendingDown size={16} />} tone="amber" label="Advances recovered" value={money(totalDed)}
          sub={totalOutstanding > 0 ? `${money(totalOutstanding)} still outstanding` : 'No dues carried'} />
        <Kpi icon={<Wallet size={16} />} tone="emerald" label="Net payout" value={money(totalNet)}
          sub={finalized ? 'Paid ✓' : 'Draft — not yet paid'} />
      </div>

      {/* ── Record-advance inline form ───────────────────────────────────── */}
      {advOpen && (
        <div className="mb-4 p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex flex-wrap items-end gap-2.5">
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Staff</label>
            <select className={inp} value={adv.staff_id} onChange={e => setAdv({ ...adv, staff_id: e.target.value })}>
              <option value="">—</option>{rows.map(r => <option key={r.staff_id} value={r.staff_id}>{r.name}</option>)}
            </select></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Amount ₹</label><input type="number" className={`${inp} w-32`} value={adv.amount} onChange={e => setAdv({ ...adv, amount: e.target.value })} /></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Date</label><input type="date" className={inp} value={adv.advance_date} onChange={e => setAdv({ ...adv, advance_date: e.target.value })} /></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">Mode</label>
            <select className={inp} value={adv.payment_method} onChange={e => setAdv({ ...adv, payment_method: e.target.value })}>
              <option value="CASH">Cash</option>
              <option value="UPI">UPI</option>
              <option value="ONLINE">Online</option>
              <option value="OTHERS">Others</option>
            </select></div>
          {adv.payment_method !== 'CASH' && (
            <div><label className="block text-xs font-semibold text-gray-600 mb-1">Ref no.</label><input className={`${inp} w-36`} value={adv.payment_reference} placeholder="txn / ref (optional)" onChange={e => setAdv({ ...adv, payment_reference: e.target.value })} /></div>
          )}
          <div className="flex-1 min-w-[140px]"><label className="block text-xs font-semibold text-gray-600 mb-1">Note</label><input className={`${inp} w-full`} value={adv.note} onChange={e => setAdv({ ...adv, note: e.target.value })} /></div>
          <button className={`${btn} bg-amber-600 text-white hover:bg-amber-700`} disabled={busy} onClick={recordAdvance}>Save advance</button>
          <button className={`${btn} bg-white text-gray-600 border border-gray-300`} onClick={() => setAdvOpen(false)}>Cancel</button>
        </div>
      )}

      {finalized && !loading && (
        <div className="mb-3 flex items-center gap-2 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          <Lock size={14} /> <span>Payroll for <b>{monthLabel(month)}</b> is finalized and locked. Advances were recovered.</span>
        </div>
      )}

      {/* ── Grid ─────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="border border-gray-200 rounded-xl p-8 text-center text-sm text-gray-400">
          <div className="inline-block w-5 h-5 border-2 border-gray-300 border-t-indigo-500 rounded-full animate-spin mb-2" />
          <div>Loading payroll…</div>
        </div>
      ) : !data ? (
        <div className="border border-gray-200 rounded-xl p-8 text-center text-sm text-gray-500">
          <Users size={22} className="mx-auto mb-2 text-gray-300" />
          Payroll needs staff-management access. Ask an owner or manager to open this screen.
        </div>
      ) : (
        <div className="overflow-x-auto border border-gray-200 rounded-xl shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-left sticky top-0 z-10">
              <tr className="border-b border-gray-200">
                <th className="p-2.5 font-semibold">Staff</th>
                <th className="p-2.5 font-semibold">Type</th>
                <th className="p-2.5 font-semibold text-right">Rate</th>
                <th className="p-2.5 font-semibold text-right">Days</th>
                <th className="p-2.5 font-semibold text-right">Hours</th>
                <th className="p-2.5 font-semibold text-right">Gross</th>
                <th className="p-2.5 font-semibold text-right">Advance</th>
                <th className="p-2.5 font-semibold text-right">Net pay</th>
                <th className="p-2.5 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={9} className="p-6 text-center text-gray-400">No active staff on the roster.</td></tr>
              ) : rows.map((r, i) => {
                const isFull = r.pay_type === 'FULL_TIME';
                return (
                  <tr key={r.staff_id} className={`border-t border-gray-100 ${i % 2 ? 'bg-gray-50/40' : ''} hover:bg-indigo-50/40 transition-colors`}>
                    <td className="p-2.5">
                      <div className="font-medium text-gray-900">{r.name}</div>
                      {r.role && <div className="text-xs text-gray-400">{r.role}</div>}
                    </td>
                    <td className="p-2.5">
                      <div className="inline-flex items-center gap-1.5">
                        <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded ${isFull ? 'bg-slate-100 text-slate-600' : 'bg-indigo-100 text-indigo-600'}`}>
                          {isFull ? <CalendarDays size={10} /> : <Clock size={10} />}{isFull ? 'Full-time' : 'Hourly'}
                        </span>
                        <select className="text-xs bg-transparent text-gray-400 hover:text-gray-700 focus:outline-none cursor-pointer disabled:cursor-default disabled:text-gray-300"
                          disabled={finalized} value={r.pay_type} onChange={e => patchStaff(r.staff_id, { pay_type: e.target.value })} title="Change pay type">
                          <option value="HOURLY">↻ Hourly</option><option value="FULL_TIME">↻ Full-time</option>
                        </select>
                      </div>
                    </td>
                    <td className="p-2.5 text-right">
                      <input type="number" min={0} className={`${inp} w-24 text-right py-1`} disabled={finalized} defaultValue={r.rate}
                        onBlur={e => { const v = Number(e.target.value); if (v !== r.rate) patchStaff(r.staff_id, isFull ? { monthly_wage: v } : { hourly_rate: v }); }} />
                      <div className="text-[10px] text-gray-400 mt-0.5">{isFull ? 'per month' : 'per hour'}</div>
                    </td>
                    <td className="p-2.5 text-right tabular-nums text-gray-700">{r.days}</td>
                    <td className="p-2.5 text-right tabular-nums text-gray-700">{isFull ? <span className="text-gray-300">—</span> : r.hours}</td>
                    <td className="p-2.5 text-right tabular-nums font-semibold text-gray-900">{money(r.gross)}</td>
                    <td className="p-2.5 text-right">
                      <input type="number" min={0} max={r.gross} className={`${inp} w-24 text-right py-1`} disabled={finalized} value={ded(r)}
                        onChange={e => setEdits({ ...edits, [r.staff_id]: Math.max(0, Math.min(Number(e.target.value) || 0, r.gross)) })} />
                      {r.advance_outstanding > 0 && <div className="text-[10px] text-rose-500 mt-0.5">{money(r.advance_outstanding)} due</div>}
                    </td>
                    <td className="p-2.5 text-right tabular-nums font-bold text-emerald-700">{money(net(r))}</td>
                    <td className="p-2.5">
                      <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${r.status === 'PAID' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                        {r.status === 'PAID' ? <><CheckCircle2 size={10} />Paid</> : 'Draft'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-gray-50 font-semibold text-gray-800">
              <tr className="border-t-2 border-gray-200">
                <td className="p-2.5" colSpan={5}>Total · {rows.length} staff</td>
                <td className="p-2.5 text-right tabular-nums">{money(totalGross)}</td>
                <td className="p-2.5 text-right tabular-nums text-amber-700">{money(totalDed)}</td>
                <td className="p-2.5 text-right tabular-nums text-emerald-700">{money(totalNet)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-400 mt-3 leading-relaxed">
        Hourly wages are summed from the timesheet (actual hours × rate). Full-time staff earn their fixed monthly wage.
        Advances shown are deducted here and recovered when you finalize. One run covers staff across Hotel, Spa, Restaurant &amp; Events.
      </p>
    </div>
  );
}

// ── KPI card ─────────────────────────────────────────────────────────────
function Kpi({ icon, label, value, sub, tone }: { icon: ReactNode; label: string; value: string; sub?: string; tone: 'slate' | 'indigo' | 'amber' | 'emerald' }) {
  const tones: Record<string, string> = {
    slate: 'bg-slate-50 text-slate-600',
    indigo: 'bg-indigo-50 text-indigo-600',
    amber: 'bg-amber-50 text-amber-600',
    emerald: 'bg-emerald-50 text-emerald-600',
  };
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3.5 shadow-sm">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`grid place-items-center w-7 h-7 rounded-lg ${tones[tone]}`}>{icon}</span>
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">{label}</span>
      </div>
      <div className="text-xl font-bold text-gray-900 tabular-nums leading-tight">{value}</div>
      {sub && <div className="text-[11px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}
