// Platform console — what PLM Pundits bills one tenant.
//  • TenantInvoices (the "Invoices" node): a summary strip (next due, amount
//    outstanding, whether renewals raise themselves and why not), the invoice
//    table, and Renewal / Ad-hoc invoice creation.
//  • TenantRateCard (inside the "Billing" node): the tenant's negotiated prices,
//    automatic-invoicing switch, bill-to details and recurring add-ons.
// Calls /api/admin/tenants/:id/rate-card, /addons, /platform-invoices.
import React, { useCallback, useEffect, useState } from 'react';
import { FileText, Send, Link2, Plus, Trash2, CheckCircle2, XCircle, RefreshCw, CreditCard, Mail, MessageCircle, AlertTriangle, Zap } from 'lucide-react';
import { useToast } from '../components/Toast';
import { usePaymentDialog } from '../components/PaymentDialog';
import { DataTable, type ColDef } from '../components/DataTable';

type Api = (p: string, i?: RequestInit) => Promise<any>;
const CYCLES: [string, string][] = [['MONTHLY', 'Monthly'], ['QUARTERLY', 'Quarterly'], ['YEARLY', 'Yearly']];
const inr = (n: any) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt = (s: any) => { if (!s) return '—'; const d = new Date(String(s).length === 10 ? `${s}T00:00:00` : s); return isNaN(d.getTime()) ? String(s) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); };
const STATUS: Record<string, string> = { ISSUED: 'bg-amber-100 text-amber-900', PAID: 'bg-emerald-100 text-emerald-800', CANCELLED: 'bg-slate-200 text-slate-700' };
const STATUS_LABEL: Record<string, string> = { ISSUED: 'Payment due', PAID: 'Paid', CANCELLED: 'Cancelled' };
const SOURCE_LABEL: Record<string, string> = { AUTO: 'System', ADMIN: 'Admin', TENANT: 'Tenant' };
const INPUT = 'w-full h-9 rounded-lg border border-slate-300 bg-white px-2.5 text-[13.5px] text-slate-900 placeholder:text-slate-400 outline-none focus:border-brand focus:ring-1 focus:ring-brand disabled:bg-slate-50 disabled:text-slate-600';
const LABEL = 'text-[12.5px] font-semibold text-slate-800';
// Rate-card override field → the tenant-profile field it falls back to.
const BILL_TO_KEYS: [string, string][] = [['bill_to_name', 'name'], ['bill_to_gstin', 'gstin'], ['bill_to_address', 'address'], ['bill_to_state', 'state'], ['bill_email', 'email'], ['bill_phone', 'phone']];

function useLoad(tenantId: string, api: Api) {
  const toast = useToast();
  const [card, setCard] = useState<any>(null);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, l] = await Promise.all([api(`/api/admin/tenants/${tenantId}/rate-card`), api(`/api/admin/tenants/${tenantId}/platform-invoices`)]);
      setCard(c); setInvoices(l.invoices || []);
    } catch (e: any) { toast.error(e.message); }
    finally { setLoading(false); }
  }, [tenantId, api]);
  useEffect(() => { load(); }, [load]);
  return { card, invoices, loading, load };
}

// Top-level on purpose: defined inside a component they would be a new type on
// every render and React would remount every table row each time.
function SentCell({ inv }: { inv: any }) {
  if (!inv.last_send?.length) return <span className="text-[12px] text-slate-500">Not sent</span>;
  return (
    <span className="flex gap-1.5">
      {inv.last_send.map((x: any) => (
        <span key={x.channel} title={x.ok ? `${x.channel === 'EMAIL' ? 'Email' : 'WhatsApp'} sent${inv.last_send_at ? ` ${fmt(inv.last_send_at)}` : ''}` : `${x.channel === 'EMAIL' ? 'Email' : 'WhatsApp'}: ${x.error || 'failed'}`}
          className={`inline-flex items-center gap-0.5 text-[11.5px] font-semibold px-1.5 h-[20px] rounded ${x.ok ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>
          {x.channel === 'EMAIL' ? <Mail size={11} /> : <MessageCircle size={11} />}{x.ok ? '✓' : '✗'}
        </span>
      ))}
    </span>
  );
}
function Act({ onClick, icon, label, tone = '', off = false }: { onClick: () => void; icon: any; label: string; tone?: string; off?: boolean }) {
  return (
    <button type="button" title={label} aria-label={label} disabled={off} onClick={e => { e.stopPropagation(); onClick(); }}
      className={`w-7 h-7 rounded-md border grid place-items-center disabled:opacity-40 ${tone === 'danger' ? 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100' : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400'}`}>{icon}</button>
  );
}

// ── Invoices node ───────────────────────────────────────────────────────────
export function TenantInvoices({ tenantId, token, api, isSuper, onOpenBilling }: { tenantId: string; token: string; api: Api; isSuper: boolean; onOpenBilling?: () => void }) {
  const toast = useToast();
  const prompt = usePaymentDialog();
  const { card, invoices, loading, load } = useLoad(tenantId, api);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'' | 'RENEWAL' | 'ON_DEMAND'>('');
  const [renewCycle, setRenewCycle] = useState('');
  const [lines, setLines] = useState<any[]>([{ description: '', qty: 1, rate: '' }]);
  const [extendsSub, setExtendsSub] = useState(false);
  const [odCycle, setOdCycle] = useState('MONTHLY');
  const [sendNow, setSendNow] = useState<string[]>(['EMAIL', 'WHATSAPP']);

  const act = async (fn: () => Promise<any>, ok?: string) => {
    setBusy(true);
    try { const r = await fn(); if (ok) toast.success(ok); await load(); return r; }
    catch (e: any) { toast.error(e.message); return null; }
    finally { setBusy(false); }
  };
  const sentSummary = (sent: any[]) => (sent || []).map((s: any) => `${s.channel === 'EMAIL' ? 'Email' : 'WhatsApp'}: ${s.ok ? `sent${s.to ? ` to ${s.to}` : ''}` : (s.error || 'failed')}`).join(' · ');

  const generate = async () => {
    const cycle = renewCycle || card?.preferred_cycle || 'MONTHLY';
    const body: any = mode === 'RENEWAL'
      ? { kind: 'RENEWAL', cycle, send: sendNow }
      : { kind: 'ON_DEMAND', lines: lines.filter(l => l.description.trim()).map(l => ({ description: l.description, qty: Number(l.qty) || 1, rate: Number(l.rate) || 0 })), extends_subscription: extendsSub, cycle: extendsSub ? odCycle : undefined, send: sendNow };
    const r = await act(() => api(`/api/admin/tenants/${tenantId}/platform-invoices`, { method: 'POST', body: JSON.stringify(body) }));
    if (!r) return;
    if (r.existing) toast.info(`An invoice for this period already exists: ${r.invoice.invoice_number}.`);
    else (r.sent || []).some((x: any) => !x.ok) ? toast.error(`Invoice ${r.invoice.invoice_number} raised · ${sentSummary(r.sent)}`) : toast.success(`Invoice ${r.invoice.invoice_number} raised${r.sent?.length ? ` · ${sentSummary(r.sent)}` : ''}.`);
    setMode(''); setLines([{ description: '', qty: 1, rate: '' }]); setExtendsSub(false);
  };
  const openPdf = async (inv: any) => {
    try {
      const r = await fetch(`/api/admin/platform-invoices/${inv.id}/pdf`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`Could not open the PDF (${r.status})`);
      const url = URL.createObjectURL(await r.blob());
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e: any) { toast.error(e.message); }
  };
  const share = async (inv: any) => {
    const email = inv.buyer?.email, phone = inv.buyer?.phone;
    const v = await prompt({ title: `Share ${inv.invoice_number}`,
      body: `Email: ${email || 'none on file'} · WhatsApp: ${phone || 'none on file — add a billing phone in Billing → Rate card'}`,
      fields: [{ name: 'via', label: 'Send by', type: 'select', defaultValue: phone ? 'BOTH' : 'EMAIL', options: [{ value: 'BOTH', label: 'Email and WhatsApp' }, { value: 'EMAIL', label: 'Email only' }, { value: 'WHATSAPP', label: 'WhatsApp only' }] }], confirmLabel: 'Send' });
    if (!v) return;
    const channels = v.via === 'BOTH' ? ['EMAIL', 'WHATSAPP'] : [v.via];
    const r = await act(() => api(`/api/admin/platform-invoices/${inv.id}/send`, { method: 'POST', body: JSON.stringify({ channels }) }));
    if (r) (r.sent || []).some((s: any) => !s.ok) ? toast.error(sentSummary(r.sent)) : toast.success(sentSummary(r.sent));
  };
  const copyLink = async (inv: any) => {
    try { const d = await api(`/api/admin/platform-invoices/${inv.id}`); await navigator.clipboard.writeText(d.page_url); toast.success('Invoice link copied — the owner can view and pay from it.'); }
    catch (e: any) { toast.error(e.message || 'Could not copy the link.'); }
  };
  const copyPayLink = async (inv: any) => {
    const r = await act(() => api(`/api/admin/platform-invoices/${inv.id}/payment-link`, { method: 'POST' }));
    if (!r?.url) return;
    try { await navigator.clipboard.writeText(r.url); toast.success('Payment link copied.'); } catch { toast.info(r.url); }
  };
  const checkPayment = async (inv: any) => {
    const r = await act(() => api(`/api/admin/platform-invoices/${inv.id}/refresh`, { method: 'POST' }));
    if (r?.invoice) r.invoice.status === 'PAID' ? toast.success(`${inv.invoice_number} is paid.`) : toast.info('No payment has reached the gateway for this invoice yet.');
  };
  const markPaid = async (inv: any) => {
    const v = await prompt({ title: `Record payment for ${inv.invoice_number}`, body: `${inr(inv.total)} received outside the payment link.${inv.extends_subscription && inv.period_to ? ` The next due date moves to ${fmt(inv.period_to)}.` : ' This invoice does not move the due date.'}`,
      fields: [
        { name: 'method', label: 'Paid by', type: 'select', defaultValue: 'BANK', options: [{ value: 'BANK', label: 'Bank transfer' }, { value: 'UPI', label: 'UPI' }, { value: 'CHEQUE', label: 'Cheque' }, { value: 'CASH', label: 'Cash' }, { value: 'OTHER', label: 'Other' }] },
        { name: 'reference', label: 'Reference (UTR / cheque no.)', type: 'text' },
        { name: 'paid_on', label: 'Paid on (YYYY-MM-DD)', type: 'text', defaultValue: new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10) },
      ], confirmLabel: 'Mark paid' });
    if (!v) return;
    act(() => api(`/api/admin/platform-invoices/${inv.id}/mark-paid`, { method: 'POST', body: JSON.stringify(v) }), 'Marked paid. A receipt is on its way to the owner.');
  };
  const cancel = async (inv: any) => {
    const v = await prompt({ title: `Cancel ${inv.invoice_number}?`, body: 'The invoice stays on record as cancelled and its payment link stops working. Its number is never reused.', fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }], confirmLabel: 'Cancel invoice' });
    if (!v?.reason) return;
    act(() => api(`/api/admin/platform-invoices/${inv.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: v.reason }) }), 'Invoice cancelled.');
  };

  if (loading && !card) return <div className="py-10 text-center text-slate-500"><RefreshCw size={20} className="mx-auto animate-spin" /></div>;
  if (!card) return null;
  const outstanding = invoices.filter(i => i.status === 'ISSUED').reduce((s, i) => s + Number(i.total || 0), 0);
  const auto = card.auto || {};
  const cycleSel = renewCycle || card.preferred_cycle || 'MONTHLY';
  const odTotal = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0);

  const columns: ColDef<any>[] = [
    { key: 'invoice_number', label: 'Invoice', sortable: true, searchable: true, hideable: false,
      render: (r: any) => <div><div className="font-mono text-[13px] font-semibold text-slate-900">{r.invoice_number}</div><div className="text-[11.5px] text-slate-600">{r.kind === 'RENEWAL' ? `Renewal · ${r.cycle_label || ''}` : 'Ad-hoc'} · {SOURCE_LABEL[r.source] || r.source}</div></div> },
    { key: 'issue_date', label: 'Issued', sortable: true, render: (r: any) => <span className="text-slate-800 whitespace-nowrap">{fmt(r.issue_date)}</span> },
    { key: 'period_from', label: 'Covers', sortable: true, render: (r: any) => r.period_from
      ? <div className="text-slate-800 whitespace-nowrap">{fmt(r.period_from)} – {fmt(r.period_to)}<div className={`text-[11.5px] ${r.status === 'PAID' ? 'text-emerald-700' : 'text-slate-600'}`}>{r.extends_subscription ? (r.status === 'PAID' ? `Due date moved to ${fmt(r.period_to)}` : `Paying moves due date to ${fmt(r.period_to)}`) : ''}</div></div>
      : <span className="text-[12px] text-slate-500">Does not move the due date</span> },
    { key: 'total', label: 'Amount', sortable: true, align: 'right', render: (r: any) => <div className="text-right"><div className="font-mono font-semibold text-slate-900">{inr(r.total)}</div><div className="text-[11px] text-slate-500">incl. GST</div></div> },
    { key: 'status', label: 'Status', sortable: true, filterable: true, filterType: 'select', filterOptions: Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })),
      render: (r: any) => <div><span className={`inline-flex h-[22px] items-center px-2 rounded-full text-[11.5px] font-semibold ${STATUS[r.status] || ''}`}>{STATUS_LABEL[r.status] || r.status}</span>
        <div className="text-[11.5px] text-slate-600 mt-0.5 whitespace-nowrap">{r.status === 'ISSUED' && r.due_date ? `due ${fmt(r.due_date)}` : r.status === 'PAID' ? `paid ${fmt(r.paid_at)}` : r.cancel_reason || ''}</div></div> },
    { key: 'last_send', label: 'Sent', noExport: true, render: (r: any) => <SentCell inv={r} /> },
    { key: 'payment_ref', label: 'Payment ref', hideable: true, defaultHidden: true },
    { key: 'actions', label: '', noExport: true, hideable: false, render: (r: any) => (
      <div className="flex gap-1 justify-end">
        <Act off={busy} onClick={() => openPdf(r)} icon={<FileText size={14} />} label="Open PDF" />
        {r.status !== 'CANCELLED' && <Act off={busy} onClick={() => copyLink(r)} icon={<Link2 size={14} />} label="Copy invoice link" />}
        {r.status !== 'CANCELLED' && isSuper && <Act off={busy} onClick={() => share(r)} icon={<Send size={14} />} label={r.status === 'PAID' ? 'Send again' : 'Share by email / WhatsApp'} />}
        {r.status === 'ISSUED' && isSuper && <Act off={busy} onClick={() => copyPayLink(r)} icon={<CreditCard size={14} />} label="Copy payment link" />}
        {r.status === 'ISSUED' && isSuper && <Act off={busy} onClick={() => checkPayment(r)} icon={<RefreshCw size={14} />} label="Check payment now" />}
        {r.status === 'ISSUED' && isSuper && <Act off={busy} onClick={() => markPaid(r)} icon={<CheckCircle2 size={14} />} label="Mark paid (offline)" />}
        {r.status === 'ISSUED' && isSuper && <Act off={busy} onClick={() => cancel(r)} icon={<XCircle size={14} />} label="Cancel invoice" tone="danger" />}
      </div>
    ) },
  ];

  return (
    <div className="space-y-4 text-slate-900">
      {/* Summary strip */}
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="border border-slate-300 rounded-xl px-3 py-2"><div className="text-[12px] font-medium text-slate-700">Next due date</div><div className="text-[16px] font-semibold">{fmt(card.due_date)}</div></div>
        <div className="border border-slate-300 rounded-xl px-3 py-2"><div className="text-[12px] font-medium text-slate-700">Outstanding</div><div className={`text-[16px] font-semibold font-mono ${outstanding ? 'text-amber-800' : ''}`}>{inr(outstanding)}</div></div>
        <div className="border border-slate-300 rounded-xl px-3 py-2"><div className="text-[12px] font-medium text-slate-700">Rate card</div><div className="text-[13.5px] font-semibold">{inr(card.rate_monthly)}/mo · bills {(CYCLES.find(c => c[0] === card.preferred_cycle)?.[1] || 'Monthly').toLowerCase()}</div>
          {onOpenBilling && <button type="button" onClick={onOpenBilling} className="text-[12px] font-semibold text-brand">Edit in Billing</button>}</div>
      </div>
      <div className={`flex gap-2 items-start rounded-xl px-3 py-2.5 text-[13px] border ${auto.active ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-amber-50 border-amber-300 text-amber-950'}`}>
        {auto.active ? <Zap size={15} className="shrink-0 mt-0.5" /> : <AlertTriangle size={15} className="shrink-0 mt-0.5" />}
        <div>
          {auto.active
            ? (auto.already_raised
              ? <>Automatic invoicing is on. The renewal for the current due date is already raised ({auto.already_raised}).</>
              : <>Automatic invoicing is on. The next renewal invoice is raised and sent on <b>{fmt(auto.next_run)}</b> ({auto.lead_days} days before the due date).</>)
            : <>Renewals are <b>not</b> raised automatically for this tenant: {auto.reasons?.join('; ')}.</>}
          <div className="mt-0.5 text-[12.5px]">Sends to: email {auto.channels?.email ? <b>{card.bill_to?.email}</b> : <b className="text-rose-700">none</b>} · WhatsApp {auto.channels?.whatsapp ? <b>{card.bill_to?.phone}</b> : <b className="text-rose-700">none — add a billing phone in Billing → Rate card</b>}</div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-[15px] font-semibold">Invoices</h3>
        {isSuper && (
          <div className="flex gap-1.5">
            <button type="button" disabled={busy} onClick={() => setMode(mode === 'RENEWAL' ? '' : 'RENEWAL')} className="h-9 px-3 rounded-lg border border-slate-300 bg-white text-[13px] font-semibold text-slate-800 inline-flex items-center gap-1"><Plus size={14} />Renewal invoice</button>
            <button type="button" disabled={busy} onClick={() => setMode(mode === 'ON_DEMAND' ? '' : 'ON_DEMAND')} className="h-9 px-3 rounded-lg bg-brand text-white text-[13px] font-semibold inline-flex items-center gap-1"><Plus size={14} />Ad-hoc invoice</button>
          </div>
        )}
      </div>

      {mode && (
        <div className="border border-slate-300 rounded-xl p-3 space-y-3 bg-slate-50">
          {mode === 'RENEWAL' ? (
            <>
              <div className="text-[13px] text-slate-800">Bills the next subscription period at this tenant's rate card, with its add-ons. Paying it moves the due date to the end of the period.</div>
              <div className="grid grid-cols-3 gap-2">
                {(card.preview || []).map((p: any) => (
                  <button key={p.cycle} type="button" onClick={() => setRenewCycle(p.cycle)}
                    className={`text-left rounded-lg border px-3 py-2 bg-white ${cycleSel === p.cycle ? 'border-brand ring-1 ring-brand' : 'border-slate-300'}`}>
                    <div className="text-[12.5px] font-semibold text-slate-800">{p.label}</div>
                    <div className="font-mono text-[14px] font-semibold text-slate-900">{inr(p.total)}</div>
                    <div className="text-[11.5px] text-slate-600">{fmt(p.period.from)} – {fmt(p.period.to)}</div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_64px_110px_28px] gap-1.5 text-[12px] font-semibold text-slate-700"><span>Description</span><span>Qty</span><span>Rate (before GST)</span><span /></div>
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-[1fr_64px_110px_28px] gap-1.5">
                  <input aria-label="Description" placeholder="e.g. Onboarding and data migration" value={l.description} onChange={e => setLines(lines.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} className={INPUT} />
                  <input aria-label="Quantity" type="number" min={1} value={l.qty} onChange={e => setLines(lines.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} className={INPUT} />
                  <input aria-label="Rate before GST" type="number" min={0} placeholder="₹" value={l.rate} onChange={e => setLines(lines.map((x, j) => j === i ? { ...x, rate: e.target.value } : x))} className={INPUT} />
                  <button type="button" aria-label="Remove line" onClick={() => setLines(lines.length > 1 ? lines.filter((_, j) => j !== i) : [{ description: '', qty: 1, rate: '' }])} className="text-slate-500 hover:text-rose-700"><Trash2 size={15} /></button>
                </div>
              ))}
              <button type="button" onClick={() => setLines([...lines, { description: '', qty: 1, rate: '' }])} className="text-[12.5px] text-brand font-semibold">+ Add line</button>
              <label className="flex items-center gap-2 text-[13px] text-slate-800 flex-wrap">
                <input type="checkbox" checked={extendsSub} onChange={e => setExtendsSub(e.target.checked)} />
                This pays for subscription time — paying it moves the due date by
                <select disabled={!extendsSub} value={odCycle} onChange={e => setOdCycle(e.target.value)} className="h-8 rounded-md border border-slate-300 px-1.5 text-[12.5px]">{CYCLES.map(([v, l]) => <option key={v} value={v}>{l === 'Monthly' ? 'a month' : l === 'Quarterly' ? 'a quarter' : 'a year'}</option>)}</select>
              </label>
              <div className="text-[12.5px] text-slate-700">Before GST: <b className="font-mono text-slate-900">{inr(odTotal)}</b> · GST is added on the invoice.</div>
            </>
          )}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-3 text-[12.5px] text-slate-800 font-medium">
              Send now:
              {[['EMAIL', 'Email'], ['WHATSAPP', 'WhatsApp']].map(([c, l]) => (
                <label key={c} className="flex items-center gap-1"><input type="checkbox" checked={sendNow.includes(c)} onChange={e => setSendNow(e.target.checked ? [...sendNow, c] : sendNow.filter(x => x !== c))} />{l}</label>
              ))}
            </div>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => setMode('')} className="h-9 px-3 rounded-lg border border-slate-300 bg-white text-[13px] font-medium text-slate-800">Close</button>
              <button type="button" disabled={busy} onClick={generate} className="h-9 px-4 rounded-lg bg-brand text-white text-[13px] font-semibold disabled:opacity-40">Generate invoice</button>
            </div>
          </div>
        </div>
      )}

      {invoices.length === 0
        ? <div className="text-[13px] text-slate-700 border border-dashed border-slate-300 rounded-xl px-3 py-6 text-center">No invoices yet.</div>
        : <DataTable data={invoices} rowKey={(r: any) => r.id} columns={columns} columnChooser columnFilters tableId={`tenant-platform-invoices`} exportFilename={`invoices-${tenantId}`} />}
    </div>
  );
}

// ── Rate card (Billing node) ────────────────────────────────────────────────
export function TenantRateCard({ tenantId, api, isSuper }: { tenantId: string; api: Api; isSuper: boolean }) {
  const toast = useToast();
  const { card, load } = useLoad(tenantId, api);
  const [form, setForm] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const [addon, setAddon] = useState({ description: '', monthly_amount: '' });
  useEffect(() => {
    if (!card) return;
    const filled: any = {};
    for (const [k, dk] of BILL_TO_KEYS) filled[k] = (card.overrides || {})[k] || (card.defaults || {})[dk] || '';
    setForm({ rate_monthly: card.rate_monthly, rate_quarterly: card.rate_quarterly, rate_yearly: card.rate_yearly, preferred_cycle: card.preferred_cycle, auto_invoice: card.auto_invoice, ...filled });
  }, [card]);
  const act = async (fn: () => Promise<any>, ok?: string) => {
    setBusy(true);
    try { const r = await fn(); if (ok) toast.success(ok); await load(); return r; }
    catch (e: any) { toast.error(e.message); return null; }
    finally { setBusy(false); }
  };
  const off = busy || !isSuper;
  // A bill-to value equal to the tenant's own detail is not an override: send it
  // blank so the invoice keeps following the profile when the tenant updates it.
  const saveCard = () => {
    const body: any = { ...form };
    for (const [k, dk] of BILL_TO_KEYS) if (String(body[k] || '').trim() === String((card?.defaults || {})[dk] || '').trim()) body[k] = '';
    return act(() => api(`/api/admin/tenants/${tenantId}/rate-card`, { method: 'PUT', body: JSON.stringify(body) }), 'Rate card saved.');
  };
  const addAddon = () => {
    if (!addon.description.trim() || !(Number(addon.monthly_amount) > 0)) { toast.error('Give the add-on a description and a monthly amount.'); return; }
    act(() => api(`/api/admin/tenants/${tenantId}/addons`, { method: 'POST', body: JSON.stringify(addon) }), 'Add-on added.').then(r => { if (r) setAddon({ description: '', monthly_amount: '' }); });
  };
  if (!card) return <div className="py-4 text-slate-500 text-[13px]">Loading rate card…</div>;
  return (
    <div className="space-y-4 text-slate-900 border-t border-slate-200 pt-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-[15px] font-semibold">Rate card <span className="text-[12.5px] font-normal text-slate-600">— before GST</span></h3>
        <span className={`text-[12px] font-semibold px-2 h-[22px] inline-flex items-center rounded-full ${card.negotiated ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'}`}>{card.negotiated ? 'Saved for this tenant' : 'List prices — not saved yet'}</span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[['rate_monthly', 'Monthly (₹)'], ['rate_quarterly', 'Quarterly (₹)'], ['rate_yearly', 'Yearly (₹)']].map(([k, l]) => (
          <label key={k} className="flex flex-col gap-1"><span className={LABEL}>{l}</span>
            <input type="number" min={0} disabled={off} value={form[k] ?? ''} onChange={e => setForm({ ...form, [k]: e.target.value })} className={INPUT} />
          </label>
        ))}
      </div>
      <div className="grid sm:grid-cols-2 gap-3 items-end">
        <label className="flex flex-col gap-1"><span className={LABEL}>Bills automatically every</span>
          <select disabled={off} value={form.preferred_cycle || 'MONTHLY'} onChange={e => setForm({ ...form, preferred_cycle: e.target.value })} className={INPUT}>{CYCLES.map(([v, l]) => <option key={v} value={v}>{l === 'Monthly' ? 'month' : l === 'Quarterly' ? 'quarter' : 'year'}</option>)}</select>
        </label>
        <label className="flex items-center gap-2 text-[13px] text-slate-800 font-medium h-9">
          <input type="checkbox" disabled={off} checked={!!Number(form.auto_invoice ?? 1)} onChange={e => setForm({ ...form, auto_invoice: e.target.checked ? 1 : 0 })} />
          Raise and send renewal invoices automatically
        </label>
      </div>
      <div className="space-y-2">
        <div className={LABEL}>Bill to <span className="font-normal text-slate-600">— filled from the tenant profile; change a field only to bill differently</span></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {([['bill_to_name', 'Bill-to name'], ['bill_to_gstin', 'GSTIN'], ['bill_to_address', 'Address'], ['bill_to_state', 'State'], ['bill_email', 'Billing email'], ['bill_phone', 'Billing WhatsApp / phone']] as [string, string][]).map(([k, l]) => {
            const dk = (BILL_TO_KEYS.find(x => x[0] === k) || [k, k])[1];
            const def = String((card.defaults || {})[dk] || '');
            const fromProfile = !!def && String(form[k] || '').trim() === def.trim();
            const missing = !form[k];
            return (
              <label key={k} className="flex flex-col gap-1">
                <span className="flex items-center justify-between gap-2"><span className={LABEL}>{l}</span>
                  {fromProfile ? <span className="text-[11px] font-medium text-slate-600">from tenant profile</span>
                    : missing && (k === 'bill_phone' || k === 'bill_email') ? <span className="text-[11px] font-semibold text-rose-700">needed to send invoices</span>
                    : (form[k] && def ? <button type="button" className="text-[11px] font-semibold text-brand" onClick={() => setForm({ ...form, [k]: def })}>Use profile value</button> : null)}</span>
                <input disabled={off} placeholder={def ? '' : 'Not on the tenant profile'} value={form[k] ?? ''} onChange={e => setForm({ ...form, [k]: e.target.value })} className={`${INPUT} ${missing && (k === 'bill_phone' || k === 'bill_email') ? 'border-rose-300' : ''}`} />
              </label>
            );
          })}
        </div>
      </div>
      {isSuper && <button type="button" disabled={busy} onClick={saveCard} className="h-9 px-4 rounded-lg bg-brand text-white text-[13px] font-semibold disabled:opacity-40">Save rate card</button>}

      <div className="space-y-2 pt-2 border-t border-slate-200">
        <div className={LABEL}>Recurring add-ons <span className="font-normal text-slate-600">— per month before GST, on every renewal invoice</span></div>
        {(card.addons || []).filter((a: any) => a.is_active).length === 0 && <div className="text-[13px] text-slate-700">None.</div>}
        <ul className="space-y-1">
          {(card.addons || []).filter((a: any) => a.is_active).map((a: any) => (
            <li key={a.id} className="flex items-center justify-between gap-2 text-[13.5px] border border-slate-300 rounded-lg px-3 py-1.5">
              <span className="min-w-0 truncate">{a.description}</span>
              <span className="flex items-center gap-2 shrink-0"><span className="font-mono font-semibold">{inr(a.monthly_amount)}/mo</span>
                {isSuper && <button type="button" aria-label={`Remove ${a.description}`} disabled={busy} onClick={() => act(() => api(`/api/admin/tenants/${tenantId}/addons/${a.id}`, { method: 'DELETE' }), 'Add-on removed.')} className="text-slate-500 hover:text-rose-700"><Trash2 size={15} /></button>}
              </span>
            </li>
          ))}
        </ul>
        {isSuper && (
          <div className="grid grid-cols-[1fr_120px_auto] gap-1.5">
            <input placeholder="e.g. WhatsApp messaging" value={addon.description} onChange={e => setAddon({ ...addon, description: e.target.value })} className={INPUT} />
            <input type="number" min={0} placeholder="₹ / month" value={addon.monthly_amount} onChange={e => setAddon({ ...addon, monthly_amount: e.target.value })} className={INPUT} />
            <button type="button" disabled={busy} onClick={addAddon} className="h-9 px-3 rounded-lg border border-slate-300 bg-white text-[13px] font-semibold text-slate-800">Add</button>
          </div>
        )}
      </div>
    </div>
  );
}
