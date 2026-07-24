import { useEffect, useState } from 'react';

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

export function StaffPayrollGrid({ token }: { restaurantId: string; token: string }) {
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<{ period: string; rows: Row[]; totals: any } | null>(null);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [adv, setAdv] = useState({ staff_id: '', amount: '', advance_date: new Date().toISOString().slice(0, 10), note: '' });

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
      setAdvOpen(false); setAdv({ staff_id: '', amount: '', advance_date: new Date().toISOString().slice(0, 10), note: '' }); await load();
    } catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };

  const finalize = async () => {
    if (!data) return;
    if (!window.confirm(`Finalize payroll for ${data.period} and mark all PAID? Outstanding advances will be recovered.`)) return;
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

  const totalGross = data ? data.rows.reduce((s, r) => s + r.gross, 0) : 0;
  const totalDed = data ? data.rows.reduce((s, r) => s + ded(r), 0) : 0;
  const totalNet = data ? data.rows.reduce((s, r) => s + net(r), 0) : 0;
  const finalized = !!data && data.rows.length > 0 && data.rows.every(r => r.status === 'PAID');
  const inp = 'px-2 py-1 rounded border border-gray-300 text-sm bg-white';

  return (
    <div className="p-1">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <h2 className="text-xl font-bold mr-2">Staff Payroll</h2>
        <input type="month" className={inp} value={month} onChange={e => setMonth(e.target.value)} />
        <button className="px-3 py-1.5 rounded-lg bg-gray-100 border text-sm" onClick={() => setAdvOpen(v => !v)}>+ Record advance</button>
        <button className="px-3 py-1.5 rounded-lg bg-gray-100 border text-sm" onClick={exportCsv}>Export CSV</button>
        <button className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold disabled:opacity-50" disabled={busy || finalized || !data?.rows.length} onClick={finalize}>
          {finalized ? 'Finalized ✓' : 'Finalize & mark paid'}
        </button>
      </div>

      {advOpen && (
        <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200 flex flex-wrap items-end gap-2">
          <div><label className="block text-xs font-semibold text-gray-600">Staff</label>
            <select className={inp} value={adv.staff_id} onChange={e => setAdv({ ...adv, staff_id: e.target.value })}>
              <option value="">—</option>{(data?.rows || []).map(r => <option key={r.staff_id} value={r.staff_id}>{r.name}</option>)}
            </select></div>
          <div><label className="block text-xs font-semibold text-gray-600">Amount ₹</label><input type="number" className={inp} value={adv.amount} onChange={e => setAdv({ ...adv, amount: e.target.value })} /></div>
          <div><label className="block text-xs font-semibold text-gray-600">Date</label><input type="date" className={inp} value={adv.advance_date} onChange={e => setAdv({ ...adv, advance_date: e.target.value })} /></div>
          <div className="flex-1 min-w-[140px]"><label className="block text-xs font-semibold text-gray-600">Note</label><input className={`${inp} w-full`} value={adv.note} onChange={e => setAdv({ ...adv, note: e.target.value })} /></div>
          <button className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-sm" disabled={busy} onClick={recordAdvance}>Save advance</button>
          <button className="px-3 py-1.5 rounded-lg bg-white border text-sm" onClick={() => setAdvOpen(false)}>Cancel</button>
        </div>
      )}

      {loading ? <p className="text-sm text-gray-500">Loading…</p> : !data ? <p className="text-sm text-gray-500">No data — payroll needs staff management access.</p> : (
        <div className="overflow-x-auto border rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-left">
              <tr>
                <th className="p-2">Name</th><th className="p-2">Type</th><th className="p-2 text-right">Rate</th>
                <th className="p-2 text-right">Days</th><th className="p-2 text-right">Hours</th>
                <th className="p-2 text-right">Gross</th><th className="p-2 text-right">Advance</th>
                <th className="p-2 text-right">Net pay</th><th className="p-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? <tr><td colSpan={9} className="p-3 text-gray-500">No active staff.</td></tr> : data.rows.map(r => {
                const isFull = r.pay_type === 'FULL_TIME';
                return (
                  <tr key={r.staff_id} className="border-t">
                    <td className="p-2"><div className="font-medium">{r.name}</div><div className="text-xs text-gray-400">{r.role || ''}</div></td>
                    <td className="p-2">
                      <select className={`${inp} text-xs`} disabled={finalized} value={r.pay_type} onChange={e => patchStaff(r.staff_id, { pay_type: e.target.value })}>
                        <option value="HOURLY">Hourly</option><option value="FULL_TIME">Full-time</option>
                      </select>
                    </td>
                    <td className="p-2 text-right">
                      <input type="number" min={0} className={`${inp} w-24 text-right`} disabled={finalized} defaultValue={r.rate}
                        onBlur={e => { const v = Number(e.target.value); if (v !== r.rate) patchStaff(r.staff_id, isFull ? { monthly_wage: v } : { hourly_rate: v }); }} />
                      <div className="text-[10px] text-gray-400">{isFull ? '/month' : '/hour'}</div>
                    </td>
                    <td className="p-2 text-right tabular-nums">{r.days}</td>
                    <td className="p-2 text-right tabular-nums">{r.hours}</td>
                    <td className="p-2 text-right tabular-nums font-semibold">{money(r.gross)}</td>
                    <td className="p-2 text-right">
                      <input type="number" min={0} max={r.gross} className={`${inp} w-24 text-right`} disabled={finalized} value={ded(r)}
                        onChange={e => setEdits({ ...edits, [r.staff_id]: Math.max(0, Math.min(Number(e.target.value) || 0, r.gross)) })} />
                      {r.advance_outstanding > 0 && <div className="text-[10px] text-rose-500">{money(r.advance_outstanding)} due</div>}
                    </td>
                    <td className="p-2 text-right tabular-nums font-bold text-emerald-700">{money(net(r))}</td>
                    <td className="p-2"><span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${r.status === 'PAID' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'}`}>{r.status}</span></td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-gray-50 font-semibold">
              <tr className="border-t">
                <td className="p-2" colSpan={5}>Total ({data.rows.length} staff)</td>
                <td className="p-2 text-right tabular-nums">{money(totalGross)}</td>
                <td className="p-2 text-right tabular-nums">{money(totalDed)}</td>
                <td className="p-2 text-right tabular-nums text-emerald-700">{money(totalNet)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="text-xs text-gray-400 mt-2">
        Hourly wages are summed from the timesheet (actual hours × rate). Full-time staff earn their fixed monthly wage. Advances shown are deducted here and recovered when you finalize. Covers staff across Hotel, Spa, Restaurant &amp; Events.
      </p>
    </div>
  );
}
