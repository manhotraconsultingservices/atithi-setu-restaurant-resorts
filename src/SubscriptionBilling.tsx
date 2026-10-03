// Owner's Subscription tab — renew and pay the Atithi-Setu subscription.
// Shows the price for each cycle (with GST) at this property's negotiated rate,
// raises the invoice for the cycle the owner picks and sends them to the public
// invoice page to pay, and lists the invoice history.
// GET/POST /api/restaurant/:id/subscription[/invoices], GET …/invoices/:id/pdf.
import React, { useEffect, useState } from 'react';
import { FileText, CreditCard, Loader2, CheckCircle2 } from 'lucide-react';
import { useT } from './i18n';
import { useToast } from './components/Toast';
import { canWriteTab } from './perm';
import { cn } from './lib/utils';

const inr = (n: any) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt = (s: any) => { if (!s) return '—'; const d = new Date(String(s).length === 10 ? `${s}T00:00:00` : s); return isNaN(d.getTime()) ? String(s) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); };

export function SubscriptionBilling({ restaurantId, token }: { restaurantId: string; token: string }) {
  const { t } = useT();
  const toast = useToast();
  const [d, setD] = useState<any>(null);
  const [cycle, setCycle] = useState('MONTHLY');
  const [busy, setBusy] = useState(false);
  const canWrite = canWriteTab('SUBSCRIPTION');
  const base = `/api/restaurant/${encodeURIComponent(restaurantId)}/subscription`;

  const load = async () => {
    try {
      const r = await fetch(base, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Could not load the subscription.');
      setD(j);
      setCycle(j.preferred_cycle || 'MONTHLY');
    } catch (e: any) { toast.error(e.message); setD({ error: true }); }
  };
  useEffect(() => { if (restaurantId) load(); }, [restaurantId]);

  const generate = async () => {
    if (!canWrite) return;
    setBusy(true);
    try {
      const r = await fetch(`${base}/invoices`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ cycle }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Could not raise the invoice.');
      toast.success(t('sub.raised', { number: j.invoice?.invoice_number || '' }));
      window.location.href = j.page_url;
    } catch (e: any) { toast.error(e.message); setBusy(false); }
  };
  const pdf = async (inv: any) => {
    try {
      const r = await fetch(`${base}/invoices/${inv.id}/pdf`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`PDF ${r.status}`);
      const url = URL.createObjectURL(await r.blob());
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e: any) { toast.error(e.message); }
  };

  if (!d) return <div className="py-8 text-center text-[#9c8e85]"><Loader2 className="mx-auto animate-spin" size={22} /></div>;
  if (d.error) return null;
  const STATUS: Record<string, [string, string]> = { ISSUED: [t('sub.due'), 'bg-amber-100 text-amber-800'], PAID: [t('sub.paid'), 'bg-green-100 text-green-700'], CANCELLED: [t('sub.cancelled'), 'bg-gray-100 text-gray-500'] };
  const contact = [d.seller?.email, d.seller?.phone].filter(Boolean).join(' · ') || 'billing@atithi-setu.com';

  return (
    <div className="space-y-6">
      {d.open_invoice && (
        <div className="p-5 rounded-3xl border-2 border-amber-200 bg-amber-50 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-amber-700">{t('sub.open')}</p>
            <p className="font-bold text-[#1a1208] mt-0.5"><span className="font-mono">{d.open_invoice.invoice_number}</span> · {inr(d.open_invoice.total)}</p>
            <p className="text-xs text-[#6b5d52]">{d.open_invoice.period_from ? t('sub.covers', { from: fmt(d.open_invoice.period_from), to: fmt(d.open_invoice.period_to) }) : ''}{d.open_invoice.due_date ? ` · ${t('sub.dueOn', { date: fmt(d.open_invoice.due_date) })}` : ''}</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => pdf(d.open_invoice)} className="h-10 px-4 rounded-xl border border-amber-300 bg-white text-sm font-semibold inline-flex items-center gap-1.5"><FileText size={15} />{t('sub.pdf')}</button>
            <a href={d.open_invoice.page_url} className="h-10 px-4 rounded-xl bg-brand text-white text-sm font-bold inline-flex items-center gap-1.5"><CreditCard size={15} />{t('sub.payNow')}</a>
          </div>
        </div>
      )}

      {!d.billing_ready ? (
        <div className="p-5 rounded-3xl bg-blue-50 border border-blue-100 text-xs text-blue-700">{t('sub.notReady', { contact })}</div>
      ) : (
        <div className="p-6 rounded-3xl border border-brand/10 space-y-4">
          <div>
            <p className="font-bold text-[#1a1208]">{t('sub.choose')}</p>
            <p className="text-xs text-[#6b5d52]">{t('sub.chooseHint')}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {(d.cycles || []).map((c: any) => (
              <button key={c.cycle} type="button" disabled={!canWrite} onClick={() => setCycle(c.cycle)}
                className={cn('text-left p-4 rounded-2xl border transition-colors', cycle === c.cycle ? 'border-brand bg-brand/5 ring-1 ring-brand' : 'border-brand/10 bg-white hover:border-brand/30', !canWrite && 'cursor-default')}>
                <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">{t(`sub.cycle.${c.cycle}`)}</p>
                <p className="text-xl font-bold text-[#1a1208] mt-1">{inr(c.total)}</p>
                <p className="text-[11px] text-[#9c8e85]">{t('sub.inclGst')} · {inr(c.subtotal)} + {inr(c.gst)}</p>
                <p className="text-[11px] text-[#6b5d52] mt-1">{t('sub.covers', { from: fmt(c.period.from), to: fmt(c.period.to) })}</p>
              </button>
            ))}
          </div>
          {d.addons?.length > 0 && <p className="text-xs text-[#6b5d52]">{t('sub.addons')}: {d.addons.map((a: any) => a.description).join(', ')}</p>}
          {canWrite ? (
            <button type="button" disabled={busy} onClick={generate} className="h-11 px-6 rounded-2xl bg-brand text-white font-bold inline-flex items-center gap-2 disabled:opacity-50">
              {busy ? <Loader2 size={16} className="animate-spin" /> : <CreditCard size={16} />}{t('sub.generate')}
            </button>
          ) : <p className="text-xs text-[#9c8e85]">{t('sub.viewOnly')}</p>}
        </div>
      )}

      <div>
        <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-2">{t('sub.history')}</p>
        {(d.invoices || []).length === 0 ? <p className="text-sm text-[#9c8e85]">{t('sub.none')}</p> : (
          <ul className="divide-y divide-brand/10 border border-brand/10 rounded-2xl">
            {d.invoices.map((inv: any) => {
              const [label, cls] = STATUS[inv.status] || [inv.status, ''];
              return (
                <li key={inv.id} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold"><span className="font-mono">{inv.invoice_number}</span> <span className={cn('ml-1 px-2 py-0.5 rounded-full text-[10px] font-bold', cls)}>{label}</span></p>
                    <p className="text-[11px] text-[#9c8e85]">{fmt(inv.issue_date)}{inv.period_from ? ` · ${t('sub.covers', { from: fmt(inv.period_from), to: fmt(inv.period_to) })}` : ''}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">{inr(inv.total)}</span>
                    {inv.status === 'PAID' && <CheckCircle2 size={15} className="text-green-600" />}
                    <button type="button" onClick={() => pdf(inv)} className="h-8 px-3 rounded-lg border border-brand/10 text-xs font-semibold inline-flex items-center gap-1"><FileText size={13} />{t('sub.pdf')}</button>
                    {inv.status === 'ISSUED' && inv.page_url && <a href={inv.page_url} className="h-8 px-3 rounded-lg bg-brand text-white text-xs font-bold inline-flex items-center">{t('sub.payNow')}</a>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
