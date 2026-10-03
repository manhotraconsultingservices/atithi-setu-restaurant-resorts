// Public page for a PLM Pundits (Atithi-Setu) subscription invoice, opened from
// the email / WhatsApp link: /?billing_invoice=<signed token>. No login. Shows
// the invoice, downloads the PDF, and pays online through Razorpay; after paying
// Razorpay sends the owner back here with &paid=1 and the page waits for the
// payment to be confirmed.
import React, { useEffect, useRef, useState } from 'react';
import { FileText, CheckCircle2, XCircle, Loader2, CreditCard, Building2 } from 'lucide-react';

const inr = (n: any) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt = (s: any) => { if (!s) return '—'; const d = new Date(String(s).length === 10 ? `${s}T00:00:00` : s); return isNaN(d.getTime()) ? String(s) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); };

export default function PlatformInvoicePage({ token }: { token: string }) {
  const [inv, setInv] = useState<any>(null);
  const [err, setErr] = useState('');
  const [paying, setPaying] = useState(false);
  const [waiting, setWaiting] = useState(() => new URLSearchParams(window.location.search).get('paid') === '1');
  const tries = useRef(0);
  const base = `/api/public/platform-billing/invoice/${encodeURIComponent(token)}`;

  const load = async () => {
    try {
      const r = await fetch(base);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'This invoice could not be loaded.');
      setInv(d);
      return d;
    } catch (e: any) { setErr(e.message); return null; }
  };
  useEffect(() => { load(); }, [token]);

  // After Razorpay returns the owner: ask the server to re-read the gateway until paid.
  useEffect(() => {
    if (!waiting) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      tries.current++;
      try {
        const d = await fetch(`${base}/status`).then(r => r.json());
        if (d.status === 'PAID') { await load(); setWaiting(false); return; }
      } catch { /* keep trying */ }
      if (tries.current < 30) setTimeout(tick, 4000); else setWaiting(false);
    };
    tick();
    return () => { stop = true; };
  }, [waiting]);

  const pay = async () => {
    setPaying(true); setErr('');
    try {
      const r = await fetch(`${base}/pay`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Online payment could not be started.');
      window.location.href = d.url;
    } catch (e: any) { setErr(e.message); setPaying(false); }
  };

  if (err && !inv) return <Shell><div className="text-center py-16"><XCircle className="mx-auto text-rose-500" size={36} /><p className="mt-3 text-slate-700">{err}</p></div></Shell>;
  if (!inv) return <Shell><div className="text-center py-16 text-slate-400"><Loader2 className="mx-auto animate-spin" size={28} /></div></Shell>;

  const paid = inv.status === 'PAID', cancelled = inv.status === 'CANCELLED';
  return (
    <Shell brand={inv.seller?.brand}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[12px] uppercase tracking-[.12em] text-slate-400">Tax invoice</div>
          <h1 className="text-[22px] font-semibold text-slate-900 font-mono">{inv.invoice_number}</h1>
          <div className="text-[13px] text-slate-500 mt-0.5">Issued {fmt(inv.issue_date)}{!paid && !cancelled && inv.due_date ? ` · due ${fmt(inv.due_date)}` : ''}</div>
        </div>
        <span className={`h-7 px-3 rounded-full text-[12.5px] font-semibold inline-flex items-center gap-1.5 ${paid ? 'bg-emerald-50 text-emerald-700' : cancelled ? 'bg-slate-100 text-slate-500' : 'bg-amber-50 text-amber-800'}`}>
          {paid ? <><CheckCircle2 size={14} />Paid</> : cancelled ? 'Cancelled' : 'Payment due'}
        </span>
      </div>

      <div className="grid sm:grid-cols-2 gap-4 mt-5 text-[13px]">
        <div><div className="text-[11px] uppercase tracking-wider text-slate-400">From</div><div className="font-medium text-slate-800">{inv.seller?.name}</div>{inv.seller?.gstin && <div className="text-slate-500">GSTIN {inv.seller.gstin}</div>}</div>
        <div><div className="text-[11px] uppercase tracking-wider text-slate-400">Billed to</div><div className="font-medium text-slate-800">{inv.buyer?.business}</div>{inv.buyer?.gstin && <div className="text-slate-500">GSTIN {inv.buyer.gstin}</div>}</div>
      </div>
      {inv.period_from && <div className="mt-3 text-[13px] text-slate-600">Subscription period: <b>{fmt(inv.period_from)}</b> to <b>{fmt(inv.period_to)}</b></div>}

      <div className="mt-5 border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-[13px]">
          <tbody>
            {(inv.lines || []).map((l: any, i: number) => (
              <tr key={i} className="border-b border-slate-100"><td className="px-3 py-2 text-slate-700">{l.description}</td><td className="px-3 py-2 text-right font-mono whitespace-nowrap">{inr(l.amount)}</td></tr>
            ))}
            <tr className="border-b border-slate-100 text-slate-500"><td className="px-3 py-1.5">Taxable value</td><td className="px-3 py-1.5 text-right font-mono">{inr(inv.subtotal)}</td></tr>
            {inv.igst > 0 && <tr className="text-slate-500"><td className="px-3 py-1.5">IGST {inv.gst_rate}%</td><td className="px-3 py-1.5 text-right font-mono">{inr(inv.igst)}</td></tr>}
            {inv.cgst > 0 && <tr className="text-slate-500"><td className="px-3 py-1.5">CGST {inv.gst_rate / 2}%</td><td className="px-3 py-1.5 text-right font-mono">{inr(inv.cgst)}</td></tr>}
            {inv.sgst > 0 && <tr className="text-slate-500"><td className="px-3 py-1.5">SGST {inv.gst_rate / 2}%</td><td className="px-3 py-1.5 text-right font-mono">{inr(inv.sgst)}</td></tr>}
            <tr className="bg-slate-50"><td className="px-3 py-2.5 font-semibold text-slate-900">Total</td><td className="px-3 py-2.5 text-right font-mono font-semibold text-[15px] text-slate-900">{inr(inv.total)}</td></tr>
          </tbody>
        </table>
      </div>

      {waiting && !paid && <div className="mt-4 flex items-center gap-2 text-[13px] text-sky-800 bg-sky-50 rounded-lg px-3 py-2"><Loader2 size={14} className="animate-spin" />Confirming your payment with the bank — this takes a few seconds.</div>}
      {paid && <div className="mt-4 text-[13px] text-emerald-800 bg-emerald-50 rounded-lg px-3 py-2">Thank you — payment received{inv.paid_at ? ` on ${fmt(inv.paid_at)}` : ''}. A receipt has been sent to you.</div>}
      {err && <div className="mt-4 text-[13px] text-rose-700 bg-rose-50 rounded-lg px-3 py-2">{err}</div>}

      <div className="mt-5 flex flex-wrap gap-2">
        {!paid && !cancelled && inv.online_available && (
          <button type="button" onClick={pay} disabled={paying || waiting} className="h-11 px-5 rounded-xl bg-[#0E7490] text-white font-semibold inline-flex items-center gap-2 disabled:opacity-50">
            {paying ? <Loader2 size={16} className="animate-spin" /> : <CreditCard size={16} />}Pay {inr(inv.total)} online
          </button>
        )}
        <a href={`${base}/pdf`} target="_blank" rel="noreferrer" className="h-11 px-5 rounded-xl border border-slate-200 bg-white text-slate-800 font-medium inline-flex items-center gap-2"><FileText size={16} />Download PDF</a>
      </div>
      {!paid && !cancelled && inv.bank && (
        <div className="mt-5 border border-slate-200 rounded-xl px-4 py-3 text-[13px] text-slate-600">
          <div className="flex items-center gap-1.5 font-medium text-slate-800 mb-1"><Building2 size={14} />{inv.online_available ? 'Or pay by bank transfer' : 'Pay by bank transfer'}</div>
          {inv.bank.account_name && <div>Account name: <b>{inv.bank.account_name}</b></div>}
          {inv.bank.account_number && <div>Account no.: <b className="font-mono">{inv.bank.account_number}</b></div>}
          {inv.bank.ifsc && <div>IFSC: <b className="font-mono">{inv.bank.ifsc}</b>{inv.bank.bank_name ? ` · ${inv.bank.bank_name}` : ''}</div>}
          {inv.bank.upi_vpa && <div>UPI: <b className="font-mono">{inv.bank.upi_vpa}</b></div>}
          <div className="text-[12px] text-slate-400 mt-1">Quote {inv.invoice_number} as the reference. It is marked paid once the transfer is matched.</div>
        </div>
      )}
      <div className="mt-6 text-[12px] text-slate-400">Questions? {[inv.seller?.email, inv.seller?.phone].filter(Boolean).join(' · ')}</div>
    </Shell>
  );
}

function Shell({ children, brand }: { children: any; brand?: string }) {
  return (
    <div className="min-h-screen bg-[#f6f7f9] px-4 py-8">
      <div className="max-w-xl mx-auto">
        <div className="text-[14px] font-semibold text-slate-700 mb-3">{brand || 'Atithi-Setu'}</div>
        <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 shadow-sm">{children}</div>
      </div>
    </div>
  );
}
