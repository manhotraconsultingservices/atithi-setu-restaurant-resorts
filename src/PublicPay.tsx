// ─────────────────────────────────────────────────────────────────────────────
// Online payment on public guest pages, through the tenant's own gateway
// (Razorpay / PhonePe / Paytm). The server issues a signed pay token for the
// guest's own booking, order or bill; these components only ever send that
// token. Server contract: /api/public/restaurant/:id/payments/{options,start,status}.
//
// Flow: Pay online opens the gateway in a new tab (or this tab when pop-ups are
// blocked) and this page watches the payment. The gateway sends the guest back
// to /?pay_result=<token> (Razorpay), which shows the result on its own.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CreditCard, Loader2, AlertTriangle, ShieldCheck } from 'lucide-react';
import { useT } from './i18n';

type PayStatus = 'IDLE' | 'STARTING' | 'WAITING' | 'PAID' | 'NOT_COMPLETED' | 'ERROR';

const rupees = (paise: number | null | undefined) =>
  `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Whether this property takes online payments on its public pages. */
export function usePublicPayOptions(restaurantId: string | null | undefined): { online: boolean; gateway: string | null } {
  const [opts, setOpts] = useState<{ online: boolean; gateway: string | null }>({ online: false, gateway: null });
  useEffect(() => {
    if (!restaurantId) return;
    let alive = true;
    fetch(`/api/public/restaurant/${encodeURIComponent(restaurantId)}/payments/options`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive && d) setOpts({ online: !!d.online, gateway: d.gateway || null }); })
      .catch(() => {});
    return () => { alive = false; };
  }, [restaurantId]);
  return opts;
}

/** The tenant inside a pay token (tenant|type|id|amount|expiry, base64url). */
export function tenantFromPayToken(token: string): string | null {
  try {
    let b64 = String(token || '').split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return atob(b64).split('|')[0] || null;
  } catch { return null; }
}

async function fetchStatus(restaurantId: string, token: string): Promise<any> {
  const r = await fetch(`/api/public/restaurant/${encodeURIComponent(restaurantId)}/payments/status?t=${encodeURIComponent(token)}`);
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || 'Could not check the payment.');
  return b;
}

/** Watches a payment until it is paid, fails, or the time runs out. */
function usePaymentWatch(restaurantId: string, token: string | null, active: boolean, onPaid?: () => void) {
  const [status, setStatus] = useState<any>(null);
  const paidRef = useRef(false);
  const check = useCallback(async () => {
    if (!token || paidRef.current) return;
    try {
      const s = await fetchStatus(restaurantId, token);
      setStatus(s);
      if (s.status === 'PAID' && !paidRef.current) { paidRef.current = true; onPaid?.(); }
    } catch { /* keep watching */ }
  }, [restaurantId, token, onPaid]);
  useEffect(() => {
    if (!active || !token) return;
    check();
    const started = Date.now();
    const h = setInterval(() => { if (Date.now() - started < 30 * 60 * 1000) check(); }, 4000);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(h); document.removeEventListener('visibilitychange', onVisible); };
  }, [active, token, check]);
  return status;
}

export function PayOnlineButton({ restaurantId, token, label, amountPaise, customer, onPaid, className }: {
  restaurantId: string;
  token: string;
  label?: string;
  amountPaise?: number | null;
  customer?: { name?: string; phone?: string; email?: string };
  onPaid?: () => void;
  className?: string;
}) {
  const { t } = useT();
  const storeKey = `pubpay:${token.slice(-24)}`;
  const [state, setState] = useState<PayStatus>(() => {
    try { return sessionStorage.getItem(storeKey) ? 'WAITING' : 'IDLE'; } catch { return 'IDLE'; }
  });
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');
  const watched = usePaymentWatch(restaurantId, token, state === 'WAITING', () => {
    setState('PAID');
    try { sessionStorage.removeItem(storeKey); } catch { /* ignore */ }
    onPaid?.();
  });
  useEffect(() => {
    if (state === 'WAITING' && watched && ['EXPIRED', 'CANCELLED', 'FAILED'].includes(watched.status)) {
      setState('NOT_COMPLETED');
      try { sessionStorage.removeItem(storeKey); } catch { /* ignore */ }
    }
  }, [watched, state, storeKey]);

  const start = async () => {
    setState('STARTING'); setError('');
    try {
      const r = await fetch(`/api/public/restaurant/${encodeURIComponent(restaurantId)}/payments/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: token, ...(customer || {}) }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok || !b.url) {
        if (b.closed) { setState('PAID'); onPaid?.(); return; }
        throw new Error(b.error || t('pay.startFailed'));
      }
      setUrl(b.url);
      try { sessionStorage.setItem(storeKey, '1'); } catch { /* ignore */ }
      // No 'noopener' feature string: with it window.open returns null even
      // when the tab opens, which would look like a blocked pop-up.
      const w = window.open(b.url, '_blank');
      if (!w) { window.location.href = b.url; return; }
      try { w.opener = null; } catch { /* cross-origin already */ }
      setState('WAITING');
    } catch (e: any) {
      setError(e.message || t('pay.startFailed'));
      setState('ERROR');
    }
  };

  if (state === 'PAID') {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 text-sm font-bold">
        <CheckCircle2 size={18} /> {t('pay.paid')}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {state === 'WAITING' ? (
        <div className="rounded-2xl border border-brand/20 bg-brand/5 px-4 py-3 text-sm text-[#1a1208] space-y-1.5">
          <p className="flex items-center justify-center gap-2 font-bold"><Loader2 size={16} className="animate-spin" /> {t('pay.waiting')}</p>
          <p className="text-xs text-[#6b5d52] text-center">{t('pay.waitingHint')}</p>
          <div className="flex justify-center gap-3 text-xs font-bold">
            {url && <a href={url} target="_blank" rel="noopener noreferrer" className="text-brand underline">{t('pay.reopen')}</a>}
            <button type="button" onClick={() => { setState('IDLE'); try { sessionStorage.removeItem(storeKey); } catch { /* ignore */ } }} className="text-[#6b5d52] underline">{t('pay.cancel')}</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={start} disabled={state === 'STARTING'}
          className={className || 'w-full flex items-center justify-center gap-2 bg-brand text-white py-4 rounded-2xl font-bold hover:bg-brand-dark transition-all disabled:opacity-60'}>
          {state === 'STARTING' ? <Loader2 size={18} className="animate-spin" /> : <CreditCard size={18} />}
          {label || t('pay.payOnline')}{amountPaise ? ` · ${rupees(amountPaise)}` : ''}
        </button>
      )}
      {state === 'NOT_COMPLETED' && <p className="text-xs text-amber-700 text-center">{t('pay.notCompleted')}</p>}
      {state === 'ERROR' && <p className="text-xs text-rose-700 text-center">{error}</p>}
      <p className="flex items-center justify-center gap-1 text-[10px] text-[#9c8e85]"><ShieldCheck size={11} /> {t('pay.secure')}</p>
    </div>
  );
}

/** Where the gateway sends the guest back to: /?pay_result=<token>. */
export function PaymentResultPage({ token }: { token: string }) {
  const { t } = useT();
  const restaurantId = tenantFromPayToken(token) || '';
  const [done, setDone] = useState(false);
  const status = usePaymentWatch(restaurantId, token, !!restaurantId && !done, () => setDone(true));
  const [waited, setWaited] = useState(false);
  useEffect(() => { const h = setTimeout(() => setWaited(true), 45000); return () => clearTimeout(h); }, []);
  const paid = status?.status === 'PAID';
  const failed = status && ['EXPIRED', 'CANCELLED', 'FAILED'].includes(status.status);
  return (
    <div className="min-h-screen bg-[#faf7f2] flex items-center justify-center p-6">
      <div className="bg-white rounded-[32px] shadow-xl border border-brand/10 w-full max-w-sm p-8 text-center space-y-4">
        {!restaurantId ? (
          <><AlertTriangle size={40} className="mx-auto text-amber-500" /><p className="font-bold">{t('pay.invalid')}</p></>
        ) : paid ? (
          <>
            <CheckCircle2 size={48} className="mx-auto text-emerald-600" />
            <h1 className="text-2xl font-bold font-serif">{t('pay.thankYou')}</h1>
            <p className="text-sm text-[#6b5d52]">{t('pay.receivedAmount', { amount: rupees(status.paid_paise || status.amount_paise) })}</p>
            {status.purpose && <p className="text-xs text-[#9c8e85]">{status.purpose}</p>}
            <p className="text-xs text-[#6b5d52]">{t('pay.closeTab')}</p>
          </>
        ) : failed || (waited && !paid) ? (
          <>
            <AlertTriangle size={44} className="mx-auto text-amber-500" />
            <h1 className="text-xl font-bold font-serif">{failed ? t('pay.notCompletedTitle') : t('pay.stillChecking')}</h1>
            <p className="text-sm text-[#6b5d52]">{failed ? t('pay.notCompleted') : t('pay.stillCheckingHint')}</p>
          </>
        ) : (
          <>
            <Loader2 size={40} className="mx-auto text-brand animate-spin" />
            <h1 className="text-xl font-bold font-serif">{t('pay.confirming')}</h1>
            <p className="text-sm text-[#6b5d52]">{t('pay.confirmingHint')}</p>
          </>
        )}
      </div>
    </div>
  );
}
