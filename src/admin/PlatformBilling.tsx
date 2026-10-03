// Platform console — PLM Pundits' own billing: the seller identity printed on
// every tenant invoice, its Razorpay account (keys write-only), bank details for
// offline payment, and the register of every invoice raised to every tenant.
// GET/PUT /api/admin/platform-billing/settings, POST …/settings/test,
// GET /api/admin/platform-invoices (?format=csv).
import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Download, CheckCircle2, AlertTriangle, Copy } from 'lucide-react';
import { useToast } from '../components/Toast';
import { DataTable, type ColDef } from '../components/DataTable';

const INPUT = 'w-full h-9 rounded-lg border border-slate-300 bg-white px-2.5 text-[13.5px] text-slate-900 placeholder:text-slate-400 outline-none focus:border-brand focus:ring-1 focus:ring-brand disabled:bg-slate-50 disabled:text-slate-600';
const inr = (n: any) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const STATUS_LABEL: Record<string, string> = { ISSUED: 'Payment due', PAID: 'Paid', CANCELLED: 'Cancelled' };

function useApi(token: string) {
  return async (path: string, init: RequestInit = {}) => {
    const r = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b?.error || `Request failed (${r.status})`);
    return b;
  };
}

export function PlatformBillingSettings({ token, canEdit }: { token: string; canEdit: boolean }) {
  const toast = useToast();
  const api = useApi(token);
  const [s, setS] = useState<any>(null);
  const [f, setF] = useState<any>({});
  const [tab, setTab] = useState<'COMPANY' | 'INVOICING' | 'GATEWAYS' | 'BANK'>('COMPANY');
  const [busy, setBusy] = useState(false);
  const [gws, setGws] = useState<any[]>([]);
  const [gwSel, setGwSel] = useState('RAZORPAY');
  const [gwForm, setGwForm] = useState<Record<string, string>>({});

  const loadGws = async (keepSel = true) => {
    try {
      const d = await api('/api/admin/platform-billing/gateways');
      setGws(d.gateways || []);
      const cur = (d.gateways || []).find((g: any) => g.id === (keepSel ? gwSel : '')) || (d.gateways || [])[0];
      if (cur) { setGwSel(cur.id); setGwForm(Object.fromEntries(cur.fields.map((x: any) => [x.key, x.value || '']))); }
    } catch (e: any) { toast.error(e.message); }
  };
  const load = async () => { try { const d = await api('/api/admin/platform-billing/settings'); setS(d); setF({ ...d }); } catch (e: any) { toast.error(e.message); } };
  useEffect(() => { load(); loadGws(false); }, [token]);

  const save = async () => {
    setBusy(true);
    try { const d = await api('/api/admin/platform-billing/settings', { method: 'PUT', body: JSON.stringify(f) }); setS(d); setF({ ...d }); toast.success('Saved.'); }
    catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };
  const pickGw = (g: any) => { setGwSel(g.id); setGwForm(Object.fromEntries(g.fields.map((x: any) => [x.key, x.value || '']))); };
  const saveGw = async (extra: any = {}) => {
    setBusy(true);
    try {
      const d = await api(`/api/admin/platform-billing/gateways/${gwSel}`, { method: 'PUT', body: JSON.stringify({ fields: gwForm, ...extra }) });
      toast.success(d.detail || 'Gateway saved.');
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); await loadGws(); }
  };
  const testGw = async () => {
    setBusy(true);
    try { const d = await api(`/api/admin/platform-billing/gateways/${gwSel}/test`, { method: 'POST' }); toast.success(d.detail || 'Connection works.'); }
    catch (e: any) { toast.error(e.message); } finally { setBusy(false); await loadGws(); }
  };

  if (!s) return <div className="text-sm text-slate-600">Loading…</div>;
  const g = gws.find(x => x.id === gwSel);
  const onCount = gws.filter(x => x.enabled).length;
  const field = (k: string, label: string, opts: any = {}) => (
    <label key={k} className={`flex flex-col gap-1 ${opts.wide ? 'sm:col-span-2' : ''}`}>
      <span className="text-[12.5px] font-semibold text-slate-800">{label}</span>
      <input type={opts.type || 'text'} disabled={!canEdit} placeholder={opts.placeholder || ''} value={f[k] ?? ''} onChange={e => setF({ ...f, [k]: e.target.value })} className={INPUT} />
      {opts.hint && <span className="text-[12px] text-slate-600">{opts.hint}</span>}
    </label>
  );
  const TABS: [typeof tab, string, string][] = [
    ['COMPANY', 'Company', s.missing?.length ? `${s.missing.length} missing` : 'Complete'],
    ['INVOICING', 'Invoicing', `${f.invoice_prefix || 'PLM'} · GST ${f.gst_rate ?? 18}%`],
    ['GATEWAYS', 'Payment gateways', onCount ? `${onCount} on` : 'None on'],
    ['BANK', 'Bank details', f.bank_account_number || f.upi_vpa ? 'Set' : 'Not set'],
  ];
  const saveBar = canEdit && tab !== 'GATEWAYS' && (
    <div className="flex justify-end pt-3 border-t border-slate-200">
      <button type="button" disabled={busy} onClick={save} className="h-9 px-5 rounded-lg bg-brand text-white text-[13px] font-semibold disabled:opacity-40">Save changes</button>
    </div>
  );

  return (
    <div className="space-y-4 text-slate-900">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-[22px] font-semibold tracking-tight text-slate-900">Platform billing</h2>
          <p className="text-[13.5px] text-slate-700">How PLM Pundits invoices tenants and how they pay. Printed on every tenant invoice.</p>
        </div>
        {s.missing?.length > 0 && (
          <div className="flex gap-2 items-center bg-amber-50 border border-amber-300 text-amber-900 rounded-lg px-3 py-1.5 text-[12.5px] font-medium">
            <AlertTriangle size={14} />Invoices can't be raised until the company details are complete
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        {/* Section rail: each section fits one screen, no long scroll. */}
        <nav className="flex lg:flex-col gap-1 overflow-x-auto" role="tablist">
          {TABS.map(([id, label, sub]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={`text-left rounded-lg px-3 py-2 border whitespace-nowrap ${tab === id ? 'bg-white border-brand ring-1 ring-brand' : 'bg-white border-slate-200 hover:border-slate-300'}`}>
              <div className="text-[13.5px] font-semibold text-slate-900">{label}</div>
              <div className={`text-[12px] ${id === 'COMPANY' && s.missing?.length ? 'text-amber-700 font-medium' : 'text-slate-600'}`}>{sub}</div>
            </button>
          ))}
        </nav>

        <section className="bg-white border border-slate-300 rounded-xl p-4 sm:p-5 space-y-4 min-w-0">
          {tab === 'COMPANY' && (<>
            <h3 className="text-[15px] font-semibold text-slate-900">Seller on the GST tax invoice</h3>
            {s.missing?.length > 0 && <p className="text-[13px] text-amber-800">Still needed: <b>{s.missing.map((m: string) => m.replace('_', ' ')).join(', ')}</b>.</p>}
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {field('legal_name', 'Legal name', { placeholder: 'PLM Pundits' })}
              {field('brand_name', 'Brand', { placeholder: 'Atithi-Setu' })}
              {field('gstin', 'GSTIN', { placeholder: '06ABCDE1234F1Z5', hint: 'First two digits decide CGST+SGST or IGST.' })}
              {field('pan', 'PAN')}
              {field('address', 'Registered address', { wide: true })}
              {field('city', 'City')}
              {field('state', 'State', { placeholder: 'Haryana' })}
              {field('pincode', 'PIN code')}
              {field('email', 'Billing email')}
              {field('phone', 'Billing phone')}
            </div>
            {saveBar}
          </>)}

          {tab === 'INVOICING' && (<>
            <h3 className="text-[15px] font-semibold text-slate-900">Numbering, tax and timing</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {field('invoice_prefix', 'Number prefix', { hint: `Next looks like ${f.invoice_prefix || 'PLM'}/2026-27/0001` })}
              {field('sac_code', 'SAC code', { hint: 'Confirm with your CA.' })}
              {field('gst_rate', 'GST %', { type: 'number' })}
              {field('auto_invoice_lead_days', 'Raise renewals this many days before due', { type: 'number' })}
              {field('link_expiry_days', 'Payment link valid for (days)', { type: 'number' })}
            </div>
            {saveBar}
          </>)}

          {tab === 'BANK' && (<>
            <h3 className="text-[15px] font-semibold text-slate-900">Bank transfer details</h3>
            <p className="text-[13px] text-slate-700">Printed on invoices and the invoice page for tenants who pay offline.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {field('bank_account_name', 'Account name')}
              {field('bank_account_number', 'Account number')}
              {field('bank_ifsc', 'IFSC')}
              {field('bank_name', 'Bank')}
              {field('upi_vpa', 'UPI ID')}
            </div>
            {saveBar}
          </>)}

          {tab === 'GATEWAYS' && (
            <div className="grid gap-4 md:grid-cols-[200px_1fr]">
              <div className="flex md:flex-col gap-2">
                {gws.map(x => (
                  <button key={x.id} type="button" onClick={() => pickGw(x)}
                    className={`text-left rounded-lg px-3 py-2 border flex-1 md:flex-none ${gwSel === x.id ? 'border-brand ring-1 ring-brand bg-white' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13.5px] font-semibold text-slate-900">{x.label}</span>
                      {x.is_default && <span className="text-[10.5px] font-bold uppercase tracking-wide text-brand">Default</span>}
                    </div>
                    <div className={`text-[12px] font-medium ${x.enabled ? 'text-emerald-700' : x.last_error ? 'text-rose-700' : 'text-slate-600'}`}>
                      {x.enabled ? `On · ${x.mode === 'LIVE' ? 'live' : x.mode === 'TEST' ? 'test' : 'connected'}` : x.last_error ? 'Needs attention' : 'Off'}
                    </div>
                  </button>
                ))}
                <p className="hidden md:block text-[12px] text-slate-600 mt-1">With more than one on, tenants choose on the invoice page. Links in emails use the default.</p>
              </div>
              {g && (
                <div className="space-y-3 min-w-0">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <h3 className="text-[15px] font-semibold text-slate-900">{g.label}</h3>
                    {g.verified_at && <span className="text-[12.5px] text-emerald-700 font-medium inline-flex items-center gap-1"><CheckCircle2 size={14} />Verified</span>}
                  </div>
                  {g.legacy && <p className="text-[12.5px] text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">Using the Razorpay keys saved earlier. Save here once to manage them with the other gateways.</p>}
                  {g.last_error && <p className="text-[12.5px] text-rose-800 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{g.last_error}</p>}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {g.fields.map((x: any) => (
                      <label key={x.key} className="flex flex-col gap-1">
                        <span className="text-[12.5px] font-semibold text-slate-800">{x.label}{x.required ? '' : ' (optional)'}</span>
                        {x.options ? (
                          <select disabled={!canEdit} value={gwForm[x.key] || ''} onChange={e => setGwForm({ ...gwForm, [x.key]: e.target.value })} className={INPUT}>
                            <option value="">Choose…</option>{x.options.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        ) : (
                          <input type={x.secret ? 'password' : 'text'} disabled={!canEdit} value={gwForm[x.key] || ''} placeholder={x.secret && x.saved ? 'Saved — leave blank to keep' : ''}
                            onChange={e => setGwForm({ ...gwForm, [x.key]: e.target.value })} className={INPUT} autoComplete="off" />
                        )}
                        {x.help && <span className="text-[12px] text-slate-600">{x.help}</span>}
                      </label>
                    ))}
                  </div>
                  <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 space-y-1">
                    <div className="text-[12.5px] font-semibold text-slate-800">Webhook / notification URL</div>
                    <div className="flex gap-1">
                      <input readOnly value={g.webhook_url} className={`${INPUT} font-mono text-[12px]`} />
                      <button type="button" aria-label="Copy webhook URL" onClick={() => { navigator.clipboard?.writeText(g.webhook_url); toast.success('Copied.'); }} className="h-9 w-9 shrink-0 rounded-lg border border-slate-300 bg-white grid place-items-center text-slate-700"><Copy size={14} /></button>
                    </div>
                    <ul className="list-disc pl-4 text-[12px] text-slate-700 space-y-0.5">{g.setup_steps.map((t: string, i: number) => <li key={i}>{t}</li>)}</ul>
                  </div>
                  {canEdit && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <button type="button" disabled={busy} onClick={() => saveGw({ is_enabled: true })} className="h-9 px-4 rounded-lg bg-brand text-white text-[13px] font-semibold disabled:opacity-40">{g.enabled ? 'Save' : 'Save & switch on'}</button>
                      {g.enabled && !g.is_default && <button type="button" disabled={busy} onClick={() => saveGw({ is_enabled: true, is_default: true })} className="h-9 px-4 rounded-lg border border-slate-300 bg-white text-[13px] font-semibold text-slate-800">Make default</button>}
                      {g.complete && <button type="button" disabled={busy} onClick={testGw} className="h-9 px-4 rounded-lg border border-slate-300 bg-white text-[13px] font-semibold text-slate-800">Test connection</button>}
                      {g.enabled && <button type="button" disabled={busy} onClick={() => saveGw({ is_enabled: false })} className="h-9 px-4 rounded-lg border border-rose-200 bg-rose-50 text-[13px] font-semibold text-rose-800">Switch off</button>}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// The register: every invoice raised to every tenant. Opening a row's tenant
// panel happens from the directory; this is the accounts view (and GSTR-1 CSV).
export function PlatformInvoiceRegister({ token, onOpenTenant }: { token: string; onOpenTenant?: (id: string) => void }) {
  const toast = useToast();
  const api = useApi(token);
  const [rows, setRows] = useState<any[] | null>(null);
  const load = async () => { try { const d = await api('/api/admin/platform-invoices'); setRows(d.invoices || []); } catch (e: any) { toast.error(e.message); setRows([]); } };
  useEffect(() => { load(); }, [token]);
  const totals = useMemo(() => {
    const r = rows || [];
    const sum = (st: string) => r.filter(x => x.status === st).reduce((s, x) => s + Number(x.total || 0), 0);
    return { due: sum('ISSUED'), paid: sum('PAID'), count: r.length };
  }, [rows]);
  const csv = async () => {
    try {
      const r = await fetch('/api/admin/platform-invoices?format=csv', { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`Export failed (${r.status})`);
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a'); a.href = url; a.download = `platform-invoices.csv`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e: any) { toast.error(e.message); }
  };
  const columns: ColDef<any>[] = [
    { key: 'invoice_number', label: 'Invoice', sortable: true, searchable: true, render: (r: any) => <span className="font-mono">{r.invoice_number}</span> },
    { key: 'issue_date', label: 'Date', sortable: true },
    { key: 'tenant_name', label: 'Tenant', sortable: true, searchable: true, render: (r: any) => onOpenTenant ? <button type="button" className="text-brand hover:underline text-left" onClick={() => onOpenTenant(r.restaurant_id)}>{r.buyer?.business || r.tenant_name}</button> : (r.buyer?.business || r.tenant_name) },
    { key: 'kind', label: 'Kind', sortable: true, filterable: true, filterType: 'select', filterOptions: [{ value: 'RENEWAL', label: 'Renewal' }, { value: 'ON_DEMAND', label: 'On-demand' }], render: (r: any) => r.kind === 'RENEWAL' ? `Renewal · ${r.cycle_label || ''}` : 'On-demand' },
    { key: 'source', label: 'Raised by', sortable: true, hideable: true, render: (r: any) => ({ AUTO: 'System', ADMIN: 'Admin', TENANT: 'Tenant' } as any)[r.source] || r.source },
    { key: 'subtotal', label: 'Taxable', sortable: true, align: 'right', hideable: true, defaultHidden: true, render: (r: any) => inr(r.subtotal) },
    { key: 'total', label: 'Total', sortable: true, align: 'right', render: (r: any) => inr(r.total) },
    { key: 'status', label: 'Status', sortable: true, filterable: true, filterType: 'select', filterOptions: Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })), render: (r: any) => STATUS_LABEL[r.status] || r.status },
    { key: 'due_date', label: 'Due', sortable: true, hideable: true },
    { key: 'payment_ref', label: 'Payment ref', hideable: true, defaultHidden: true },
  ];
  return (
    <div className="space-y-4 text-slate-900">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-[22px] font-semibold tracking-tight">Tenant invoices</h2>
          <p className="text-[13.5px] text-slate-700">Every invoice PLM Pundits has raised. To raise or share one, open the tenant and use its Invoices tab.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={load} className="h-9 px-3 rounded-lg border border-slate-200 bg-white text-[13px] inline-flex items-center gap-1.5"><RefreshCw size={13} />Refresh</button>
          <button type="button" onClick={csv} className="h-9 px-3 rounded-lg border border-slate-200 bg-white text-[13px] inline-flex items-center gap-1.5"><Download size={13} />CSV for GSTR-1</button>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 max-w-xl">
        {[['Invoices', String(totals.count)], ['Awaiting payment', inr(totals.due)], ['Collected', inr(totals.paid)]].map(([k, v]) => (
          <div key={k} className="bg-white border border-slate-200 rounded-xl px-3 py-2"><div className="text-[12px] font-medium text-slate-700">{k}</div><div className="font-mono text-[16px] text-slate-900">{v}</div></div>
        ))}
      </div>
      {!rows ? <div className="text-sm text-slate-600">Loading…</div> : (
        <DataTable data={rows} rowKey={(r: any) => r.id} columns={columns} columnChooser columnFilters tableId="platform-invoice-register" exportFilename="platform-invoices" />
      )}
    </div>
  );
}
