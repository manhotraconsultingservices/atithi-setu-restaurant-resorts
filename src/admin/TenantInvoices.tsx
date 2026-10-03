// Platform console — the "Invoices" node of a tenant's side panel. Everything
// PLM Pundits bills this tenant for: its negotiated rate card and add-ons, and
// every invoice — system-generated renewals and admin on-demand invoices alike —
// with Generate, Share (email / WhatsApp), PDF, Copy link, Mark paid and Cancel.
// Calls /api/admin/tenants/:id/rate-card, /addons, /platform-invoices.
import React, { useCallback, useEffect, useState } from 'react';
import { FileText, Send, Link2, Plus, Trash2, CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
import { useToast } from '../components/Toast';
import { usePaymentDialog } from '../components/PaymentDialog';

type Api = (p: string, i?: RequestInit) => Promise<any>;
const CYCLES: [string, string][] = [['MONTHLY', 'Monthly'], ['QUARTERLY', 'Quarterly'], ['YEARLY', 'Yearly']];
const inr = (n: any) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt = (s: any) => { if (!s) return '—'; const d = new Date(String(s).length === 10 ? `${s}T00:00:00` : s); return isNaN(d.getTime()) ? String(s) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); };
const STATUS: Record<string, string> = { ISSUED: 'bg-amber-50 text-amber-800', PAID: 'bg-emerald-50 text-emerald-700', CANCELLED: 'bg-slate-100 text-slate-500' };
const STATUS_LABEL: Record<string, string> = { ISSUED: 'Payment due', PAID: 'Paid', CANCELLED: 'Cancelled' };
const SOURCE_LABEL: Record<string, string> = { AUTO: 'System', ADMIN: 'Admin', TENANT: 'Tenant' };
const INPUT = 'w-full h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-[13px] outline-none focus:border-brand disabled:bg-slate-50';

export function TenantInvoices({ tenantId, token, api, isSuper }: { tenantId: string; token: string; api: Api; isSuper: boolean }) {
  const toast = useToast();
  const prompt = usePaymentDialog();
  const [card, setCard] = useState<any>(null);
  const [form, setForm] = useState<any>({});
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'' | 'RENEWAL' | 'ON_DEMAND'>('');
  const [renewCycle, setRenewCycle] = useState('MONTHLY');
  const [lines, setLines] = useState<any[]>([{ description: '', qty: 1, rate: '' }]);
  const [extendsSub, setExtendsSub] = useState(false);
  const [odCycle, setOdCycle] = useState('MONTHLY');
  const [sendNow, setSendNow] = useState<string[]>(['EMAIL', 'WHATSAPP']);
  const [showBillTo, setShowBillTo] = useState(false);
  const [addon, setAddon] = useState({ description: '', monthly_amount: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, l] = await Promise.all([api(`/api/admin/tenants/${tenantId}/rate-card`), api(`/api/admin/tenants/${tenantId}/platform-invoices`)]);
      setCard(c);
      setForm({ rate_monthly: c.rate_monthly, rate_quarterly: c.rate_quarterly, rate_yearly: c.rate_yearly, preferred_cycle: c.preferred_cycle, auto_invoice: c.auto_invoice, ...c.overrides });
      setRenewCycle(c.preferred_cycle || 'MONTHLY');
      setInvoices(l.invoices || []);
    } catch (e: any) { toast.error(e.message); }
    finally { setLoading(false); }
  }, [tenantId, api]);
  useEffect(() => { load(); }, [load]);

  const act = async (fn: () => Promise<any>, ok?: string) => {
    setBusy(true);
    try { const r = await fn(); if (ok) toast.success(ok); await load(); return r; }
    catch (e: any) { toast.error(e.message); return null; }
    finally { setBusy(false); }
  };
  const off = busy || !isSuper;

  const saveCard = () => act(() => api(`/api/admin/tenants/${tenantId}/rate-card`, { method: 'PUT', body: JSON.stringify(form) }), 'Rate card saved.');
  const addAddon = () => {
    if (!addon.description.trim() || !(Number(addon.monthly_amount) > 0)) { toast.error('Give the add-on a description and a monthly amount.'); return; }
    act(() => api(`/api/admin/tenants/${tenantId}/addons`, { method: 'POST', body: JSON.stringify(addon) }), 'Add-on added.').then(r => { if (r) setAddon({ description: '', monthly_amount: '' }); });
  };
  const sentSummary = (sent: any[]) => (sent || []).map((s: any) => `${s.channel === 'EMAIL' ? 'Email' : 'WhatsApp'}: ${s.ok ? 'sent' : (s.error || 'failed')}`).join(' · ');

  const generate = async () => {
    const body: any = mode === 'RENEWAL'
      ? { kind: 'RENEWAL', cycle: renewCycle, send: sendNow }
      : { kind: 'ON_DEMAND', lines: lines.filter(l => l.description.trim()).map(l => ({ description: l.description, qty: Number(l.qty) || 1, rate: Number(l.rate) || 0 })), extends_subscription: extendsSub, cycle: extendsSub ? odCycle : undefined, send: sendNow };
    const r = await act(() => api(`/api/admin/tenants/${tenantId}/platform-invoices`, { method: 'POST', body: JSON.stringify(body) }));
    if (!r) return;
    if (r.existing) toast.info(`An invoice for this period already exists: ${r.invoice.invoice_number}.`);
    else toast.success(`Invoice ${r.invoice.invoice_number} raised${r.sent?.length ? ` · ${sentSummary(r.sent)}` : ''}.`);
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
    const v = await prompt({ title: `Share ${inv.invoice_number}`, body: `Sends the invoice and its payment link to ${inv.buyer?.email || 'no email on file'} / ${inv.buyer?.phone || 'no phone on file'}.`,
      fields: [{ name: 'via', label: 'Send by', type: 'select', defaultValue: 'BOTH', options: [{ value: 'BOTH', label: 'Email and WhatsApp' }, { value: 'EMAIL', label: 'Email only' }, { value: 'WHATSAPP', label: 'WhatsApp only' }] }], confirmLabel: 'Send' });
    if (!v) return;
    const channels = v.via === 'BOTH' ? ['EMAIL', 'WHATSAPP'] : [v.via];
    const r = await act(() => api(`/api/admin/platform-invoices/${inv.id}/send`, { method: 'POST', body: JSON.stringify({ channels }) }));
    if (r) (r.sent || []).some((s: any) => !s.ok) ? toast.error(sentSummary(r.sent)) : toast.success(sentSummary(r.sent));
  };
  const copyLink = async (inv: any) => {
    try {
      const d = await api(`/api/admin/platform-invoices/${inv.id}`);
      await navigator.clipboard.writeText(d.page_url);
      toast.success('Invoice link copied — the owner can view and pay from it.');
    } catch (e: any) { toast.error(e.message || 'Could not copy the link.'); }
  };
  const markPaid = async (inv: any) => {
    const v = await prompt({ title: `Record payment for ${inv.invoice_number}`, body: `${inr(inv.total)} received outside the payment link.${inv.extends_subscription && inv.period_to ? ` The subscription moves to ${fmt(inv.period_to)}.` : ''}`,
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

  if (loading && !card) return <div className="py-10 text-center text-slate-400"><RefreshCw size={20} className="mx-auto animate-spin" /></div>;
  if (!card) return null;
  const odTotal = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0);

  return (
    <div className="space-y-5">
      {/* Invoices first: it is what this node is opened for. */}
      <section>
        <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
          <h3 className="text-[11px] font-semibold uppercase tracking-[.08em] text-slate-400">Invoices</h3>
          {isSuper && (
            <div className="flex gap-1.5">
              <button type="button" disabled={busy} onClick={() => setMode(mode === 'RENEWAL' ? '' : 'RENEWAL')} className="h-8 px-3 rounded-lg border border-slate-200 bg-white text-[12.5px] font-medium inline-flex items-center gap-1"><Plus size={13} />Renewal invoice</button>
              <button type="button" disabled={busy} onClick={() => setMode(mode === 'ON_DEMAND' ? '' : 'ON_DEMAND')} className="h-8 px-3 rounded-lg bg-brand text-white text-[12.5px] font-medium inline-flex items-center gap-1"><Plus size={13} />On-demand invoice</button>
            </div>
          )}
        </div>

        {mode && (
          <div className="border border-slate-200 rounded-xl p-3 mb-3 space-y-3 bg-slate-50/60">
            {mode === 'RENEWAL' ? (
              <>
                <div className="text-[12.5px] text-slate-600">Bills the next subscription period at this tenant's rate card, with its add-ons.{!card.due_date && ' No due date is set, so the period starts today.'}</div>
                <div className="grid grid-cols-3 gap-2">
                  {(card.preview || []).map((p: any) => (
                    <button key={p.cycle} type="button" onClick={() => setRenewCycle(p.cycle)}
                      className={`text-left rounded-lg border px-2.5 py-2 ${renewCycle === p.cycle ? 'border-brand bg-white ring-1 ring-brand' : 'border-slate-200 bg-white'}`}>
                      <div className="text-[12px] font-semibold">{p.label}</div>
                      <div className="font-mono text-[13px]">{inr(p.total)}</div>
                      <div className="text-[10.5px] text-slate-500">{fmt(p.period.from)} – {fmt(p.period.to)}</div>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  {lines.map((l, i) => (
                    <div key={i} className="grid grid-cols-[1fr_56px_96px_28px] gap-1.5">
                      <input aria-label="Description" placeholder="Description, e.g. Onboarding and data migration" value={l.description} onChange={e => setLines(lines.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} className={INPUT} />
                      <input aria-label="Quantity" type="number" min={1} value={l.qty} onChange={e => setLines(lines.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} className={INPUT} />
                      <input aria-label="Rate before GST" type="number" min={0} placeholder="Rate ₹" value={l.rate} onChange={e => setLines(lines.map((x, j) => j === i ? { ...x, rate: e.target.value } : x))} className={INPUT} />
                      <button type="button" aria-label="Remove line" onClick={() => setLines(lines.length > 1 ? lines.filter((_, j) => j !== i) : [{ description: '', qty: 1, rate: '' }])} className="text-slate-400 hover:text-rose-600"><Trash2 size={14} /></button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setLines([...lines, { description: '', qty: 1, rate: '' }])} className="text-[12px] text-brand font-medium">+ Add line</button>
                </div>
                <label className="flex items-center gap-2 text-[12.5px] text-slate-600">
                  <input type="checkbox" checked={extendsSub} onChange={e => setExtendsSub(e.target.checked)} />
                  Paying this extends the subscription by
                  <select disabled={!extendsSub} value={odCycle} onChange={e => setOdCycle(e.target.value)} className="h-7 rounded-md border border-slate-200 px-1 text-[12px]">{CYCLES.map(([v, l]) => <option key={v} value={v}>{l === 'Monthly' ? 'a month' : l === 'Quarterly' ? 'a quarter' : 'a year'}</option>)}</select>
                </label>
                <div className="text-[12px] text-slate-500">Before GST: <b className="font-mono">{inr(odTotal)}</b> · GST is added on the invoice.</div>
              </>
            )}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-3 text-[12px] text-slate-600">
                Send now:
                {[['EMAIL', 'Email'], ['WHATSAPP', 'WhatsApp']].map(([c, l]) => (
                  <label key={c} className="flex items-center gap-1"><input type="checkbox" checked={sendNow.includes(c)} onChange={e => setSendNow(e.target.checked ? [...sendNow, c] : sendNow.filter(x => x !== c))} />{l}</label>
                ))}
              </div>
              <div className="flex gap-1.5">
                <button type="button" onClick={() => setMode('')} className="h-8 px-3 rounded-lg border border-slate-200 bg-white text-[12.5px]">Close</button>
                <button type="button" disabled={busy} onClick={generate} className="h-8 px-3 rounded-lg bg-brand text-white text-[12.5px] font-medium disabled:opacity-40">Generate invoice</button>
              </div>
            </div>
          </div>
        )}

        {invoices.length === 0 ? (
          <div className="text-[12.5px] text-slate-500 border border-dashed border-slate-200 rounded-xl px-3 py-6 text-center">No invoices yet. Renewal invoices are raised automatically 7 days before the due date once a rate card and due date are set.</div>
        ) : (
          <ul className="border border-slate-200 rounded-xl divide-y divide-slate-100">
            {invoices.map(inv => (
              <li key={inv.id} className="px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-[13px] font-semibold">{inv.invoice_number}</span>
                      <span className={`h-[20px] px-2 rounded-full text-[11px] font-medium inline-flex items-center ${STATUS[inv.status] || ''}`}>{STATUS_LABEL[inv.status] || inv.status}</span>
                      <span className="text-[11px] text-slate-500">{inv.kind === 'RENEWAL' ? `Renewal · ${inv.cycle_label || ''}` : 'On-demand'} · {SOURCE_LABEL[inv.source] || inv.source}</span>
                    </div>
                    <div className="text-[11.5px] text-slate-500 mt-0.5">
                      {fmt(inv.issue_date)}{inv.period_from ? ` · covers ${fmt(inv.period_from)} – ${fmt(inv.period_to)}` : ''}
                      {inv.status === 'ISSUED' && inv.due_date ? ` · due ${fmt(inv.due_date)}` : ''}
                      {inv.status === 'PAID' ? ` · paid ${fmt(inv.paid_at)}${inv.payment_ref ? ` (${inv.payment_ref})` : ''}` : ''}
                      {inv.status === 'CANCELLED' && inv.cancel_reason ? ` · ${inv.cancel_reason}` : ''}
                    </div>
                  </div>
                  <div className="text-right shrink-0"><div className="font-mono text-[13.5px]">{inr(inv.total)}</div><div className="text-[10.5px] text-slate-400">incl. GST</div></div>
                </div>
                <div className="flex flex-wrap gap-1 mt-2">
                  <IconBtn onClick={() => openPdf(inv)} icon={<FileText size={13} />} label="PDF" />
                  {inv.status !== 'CANCELLED' && <IconBtn onClick={() => copyLink(inv)} icon={<Link2 size={13} />} label="Copy link" />}
                  {inv.status !== 'CANCELLED' && isSuper && <IconBtn off={busy} onClick={() => share(inv)} icon={<Send size={13} />} label={inv.status === 'PAID' ? 'Send again' : 'Share'} />}
                  {inv.status === 'ISSUED' && isSuper && <IconBtn off={busy} onClick={() => markPaid(inv)} icon={<CheckCircle2 size={13} />} label="Mark paid" />}
                  {inv.status === 'ISSUED' && isSuper && <IconBtn off={busy} tone="danger" onClick={() => cancel(inv)} icon={<XCircle size={13} />} label="Cancel" />}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Rate card */}
      <section className="space-y-2">
        <div className="flex items-center justify-between"><h3 className="text-[11px] font-semibold uppercase tracking-[.08em] text-slate-400">Rate card (before GST)</h3>
          <span className="text-[11px] text-slate-400">{card.negotiated ? 'Negotiated' : 'List prices — save to fix them for this tenant'}</span></div>
        <div className="grid grid-cols-3 gap-2">
          {[['rate_monthly', 'Monthly'], ['rate_quarterly', 'Quarterly'], ['rate_yearly', 'Yearly']].map(([k, l]) => (
            <label key={k} className="flex flex-col gap-1 text-[12px] text-slate-500">{l} (₹)
              <input type="number" min={0} disabled={off} value={form[k] ?? ''} onChange={e => setForm({ ...form, [k]: e.target.value })} className={INPUT} />
            </label>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-[12px] text-slate-500">Bills automatically every
            <select disabled={off} value={form.preferred_cycle || 'MONTHLY'} onChange={e => setForm({ ...form, preferred_cycle: e.target.value })} className={INPUT}>{CYCLES.map(([v, l]) => <option key={v} value={v}>{l === 'Monthly' ? 'month' : l === 'Quarterly' ? 'quarter' : 'year'}</option>)}</select>
          </label>
          <label className="flex items-center gap-2 text-[12.5px] text-slate-600 mt-5">
            <input type="checkbox" disabled={off} checked={!!Number(form.auto_invoice ?? 1)} onChange={e => setForm({ ...form, auto_invoice: e.target.checked ? 1 : 0 })} />
            Raise and send renewal invoices automatically
          </label>
        </div>
        <button type="button" onClick={() => setShowBillTo(!showBillTo)} className="text-[12px] text-brand font-medium">{showBillTo ? 'Hide' : 'Edit'} bill-to details</button>
        {showBillTo && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {[['bill_to_name', 'Bill-to name', card.bill_to?.name], ['bill_to_gstin', 'GSTIN', card.bill_to?.gstin], ['bill_to_address', 'Address', card.bill_to?.address], ['bill_to_state', 'State', card.bill_to?.state], ['bill_email', 'Billing email', card.bill_to?.email], ['bill_phone', 'Billing WhatsApp / phone', card.bill_to?.phone]].map(([k, l, ph]) => (
              <label key={k as string} className="flex flex-col gap-1 text-[12px] text-slate-500">{l}
                <input disabled={off} placeholder={ph || ''} value={form[k as string] ?? ''} onChange={e => setForm({ ...form, [k as string]: e.target.value })} className={INPUT} />
              </label>
            ))}
            <div className="sm:col-span-2 text-[11px] text-slate-400">Left blank, each falls back to the business and owner details shown in grey.</div>
          </div>
        )}
        {isSuper && <button type="button" disabled={busy} onClick={saveCard} className="h-8 px-3 rounded-lg bg-brand text-white text-[12.5px] font-medium disabled:opacity-40">Save rate card</button>}
      </section>

      {/* Add-ons */}
      <section className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[.08em] text-slate-400">Recurring add-ons (per month, before GST)</h3>
        {(card.addons || []).filter((a: any) => a.is_active).length === 0 && <div className="text-[12px] text-slate-500">None. Add-ons appear on every renewal invoice, charged for each month of the cycle.</div>}
        <ul className="space-y-1">
          {(card.addons || []).filter((a: any) => a.is_active).map((a: any) => (
            <li key={a.id} className="flex items-center justify-between gap-2 text-[13px] border border-slate-200 rounded-lg px-2.5 py-1.5">
              <span className="min-w-0 truncate">{a.description}</span>
              <span className="flex items-center gap-2 shrink-0"><span className="font-mono">{inr(a.monthly_amount)}/mo</span>
                {isSuper && <button type="button" aria-label={`Remove ${a.description}`} disabled={busy} onClick={() => act(() => api(`/api/admin/tenants/${tenantId}/addons/${a.id}`, { method: 'DELETE' }), 'Add-on removed.')} className="text-slate-400 hover:text-rose-600"><Trash2 size={14} /></button>}
              </span>
            </li>
          ))}
        </ul>
        {isSuper && (
          <div className="grid grid-cols-[1fr_110px_auto] gap-1.5">
            <input placeholder="e.g. WhatsApp messaging" value={addon.description} onChange={e => setAddon({ ...addon, description: e.target.value })} className={INPUT} />
            <input type="number" min={0} placeholder="₹ / month" value={addon.monthly_amount} onChange={e => setAddon({ ...addon, monthly_amount: e.target.value })} className={INPUT} />
            <button type="button" disabled={busy} onClick={addAddon} className="h-9 px-3 rounded-lg border border-slate-200 bg-white text-[12.5px] font-medium">Add</button>
          </div>
        )}
      </section>
    </div>
  );
}

function IconBtn({ onClick, icon, label, tone = '', off = false }: { onClick: () => void; icon: any; label: string; tone?: string; off?: boolean }) {
  return (
    <button type="button" disabled={off} onClick={onClick}
      className={`h-7 px-2 rounded-md border text-[12px] inline-flex items-center gap-1 disabled:opacity-40 ${tone === 'danger' ? 'border-rose-100 bg-rose-50 text-rose-700' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'}`}>{icon}{label}</button>
  );
}
