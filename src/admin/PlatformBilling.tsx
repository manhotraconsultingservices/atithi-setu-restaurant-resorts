// Platform console — PLM Pundits' own billing: the seller identity printed on
// every tenant invoice, its Razorpay account (keys write-only), bank details for
// offline payment, and the register of every invoice raised to every tenant.
// GET/PUT /api/admin/platform-billing/settings, POST …/settings/test,
// GET /api/admin/platform-invoices (?format=csv).
import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Download, CheckCircle2, AlertTriangle, Copy } from 'lucide-react';
import { useToast } from '../components/Toast';
import { DataTable, type ColDef } from '../components/DataTable';

const INPUT = 'w-full h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-[13px] outline-none focus:border-brand disabled:bg-slate-50';
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
  const [busy, setBusy] = useState(false);
  const load = async () => { try { const d = await api('/api/admin/platform-billing/settings'); setS(d); setF({ ...d, rzp_key_secret: '', rzp_webhook_secret: '' }); } catch (e: any) { toast.error(e.message); } };
  useEffect(() => { load(); }, [token]);
  const webhookUrl = `${window.location.origin}/api/public/platform-billing/webhook/razorpay`;

  const save = async () => {
    setBusy(true);
    try { const d = await api('/api/admin/platform-billing/settings', { method: 'PUT', body: JSON.stringify(f) }); setS(d); setF({ ...d, rzp_key_secret: '', rzp_webhook_secret: '' }); toast.success('Platform billing saved.'); }
    catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true);
    try { const d = await api('/api/admin/platform-billing/settings/test', { method: 'POST' }); toast.success(`Razorpay accepted the keys (${d.mode || 'mode unknown'}).`); await load(); }
    catch (e: any) { toast.error(e.message); await load(); } finally { setBusy(false); }
  };
  if (!s) return <div className="text-sm text-slate-400">Loading…</div>;
  const field = (k: string, label: string, opts: any = {}) => (
    <label key={k} className={`flex flex-col gap-1 text-[12px] text-slate-500 ${opts.wide ? 'sm:col-span-2' : ''}`}>{label}
      <input type={opts.type || 'text'} disabled={!canEdit} placeholder={opts.placeholder || ''} value={f[k] ?? ''} onChange={e => setF({ ...f, [k]: e.target.value })} className={INPUT} />
      {opts.hint && <span className="text-[11px] text-slate-400">{opts.hint}</span>}
    </label>
  );
  return (
    <div className="space-y-5 text-slate-900 max-w-3xl">
      <div>
        <h2 className="text-[22px] font-semibold tracking-tight">Platform billing</h2>
        <p className="text-[13px] text-slate-500">The company that invoices tenants, the account they pay into, and how invoices are numbered. Printed on every tenant invoice.</p>
      </div>
      {s.missing?.length > 0 && (
        <div className="flex gap-2 items-start bg-amber-50 border border-amber-200 text-amber-900 rounded-xl px-3 py-2 text-[12.5px]">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" />
          <span>Invoices cannot be raised until these are filled in: <b>{s.missing.map((m: string) => m.replace('_', ' ')).join(', ')}</b>.</span>
        </div>
      )}
      <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[.08em] text-slate-400">Seller (GST tax invoice)</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {field('legal_name', 'Legal name', { placeholder: 'PLM Pundits' })}
          {field('brand_name', 'Brand', { placeholder: 'Atithi-Setu' })}
          {field('gstin', 'GSTIN', { placeholder: '06ABCDE1234F1Z5', hint: 'Its first two digits decide CGST+SGST vs IGST for each tenant.' })}
          {field('pan', 'PAN')}
          {field('address', 'Registered address', { wide: true })}
          {field('city', 'City')}
          {field('state', 'State', { placeholder: 'Haryana' })}
          {field('pincode', 'PIN code')}
          {field('email', 'Billing email')}
          {field('phone', 'Billing phone')}
        </div>
      </section>
      <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[.08em] text-slate-400">Invoicing</h3>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {field('invoice_prefix', 'Number prefix', { hint: 'e.g. PLM/2026-27/0001' })}
          {field('sac_code', 'SAC code', { hint: 'Confirm with your CA' })}
          {field('gst_rate', 'GST %', { type: 'number' })}
          {field('auto_invoice_lead_days', 'Auto-invoice days before due', { type: 'number' })}
          {field('link_expiry_days', 'Payment link valid (days)', { type: 'number' })}
        </div>
      </section>
      <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-[11px] font-semibold uppercase tracking-[.08em] text-slate-400">Razorpay (PLM Pundits' own account)</h3>
          {s.verified_at
            ? <span className="text-[12px] text-emerald-700 inline-flex items-center gap-1"><CheckCircle2 size={13} />Verified · {s.rzp_mode}</span>
            : s.rzp_key_id ? <span className="text-[12px] text-amber-700">Not verified{s.last_test_detail ? ` — ${s.last_test_detail}` : ''}</span> : <span className="text-[12px] text-slate-400">Not connected</span>}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {field('rzp_key_id', 'Key ID', { placeholder: 'rzp_test_… or rzp_live_…' })}
          {field('rzp_key_secret', 'Key Secret', { type: 'password', placeholder: s.rzp_key_secret_saved ? 'Saved — leave blank to keep' : '' })}
          {field('rzp_webhook_secret', 'Webhook secret', { type: 'password', placeholder: s.rzp_webhook_secret_saved ? 'Saved — leave blank to keep' : '', hint: 'Set the same secret on the webhook in Razorpay.' })}
          <div className="flex flex-col gap-1 text-[12px] text-slate-500">Webhook URL (event payment_link.paid)
            <div className="flex gap-1"><input readOnly value={webhookUrl} className={`${INPUT} font-mono text-[11.5px]`} />
              <button type="button" aria-label="Copy webhook URL" onClick={() => { navigator.clipboard?.writeText(webhookUrl); toast.success('Webhook URL copied.'); }} className="h-9 w-9 shrink-0 rounded-lg border border-slate-200 grid place-items-center"><Copy size={13} /></button></div>
          </div>
        </div>
      </section>
      <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[.08em] text-slate-400">Bank details for offline payment (printed on the invoice)</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {field('bank_account_name', 'Account name')}
          {field('bank_account_number', 'Account number')}
          {field('bank_ifsc', 'IFSC')}
          {field('bank_name', 'Bank')}
          {field('upi_vpa', 'UPI ID')}
        </div>
      </section>
      {canEdit && (
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={save} className="h-9 px-4 rounded-lg bg-brand text-white text-[13px] font-medium disabled:opacity-40">Save</button>
          <button type="button" disabled={busy || !s.rzp_key_id} onClick={test} className="h-9 px-4 rounded-lg border border-slate-200 bg-white text-[13px] font-medium disabled:opacity-40">Test Razorpay connection</button>
        </div>
      )}
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
          <p className="text-[13px] text-slate-500">Every invoice PLM Pundits has raised. To raise or share one, open the tenant and use its Invoices tab.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={load} className="h-9 px-3 rounded-lg border border-slate-200 bg-white text-[13px] inline-flex items-center gap-1.5"><RefreshCw size={13} />Refresh</button>
          <button type="button" onClick={csv} className="h-9 px-3 rounded-lg border border-slate-200 bg-white text-[13px] inline-flex items-center gap-1.5"><Download size={13} />CSV for GSTR-1</button>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 max-w-xl">
        {[['Invoices', String(totals.count)], ['Awaiting payment', inr(totals.due)], ['Collected', inr(totals.paid)]].map(([k, v]) => (
          <div key={k} className="bg-white border border-slate-200 rounded-xl px-3 py-2"><div className="text-[11.5px] text-slate-500">{k}</div><div className="font-mono text-[16px]">{v}</div></div>
        ))}
      </div>
      {!rows ? <div className="text-sm text-slate-400">Loading…</div> : (
        <DataTable data={rows} rowKey={(r: any) => r.id} columns={columns} columnChooser columnFilters tableId="platform-invoice-register" exportFilename="platform-invoices" />
      )}
    </div>
  );
}
