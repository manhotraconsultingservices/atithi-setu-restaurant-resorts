// ─────────────────────────────────────────────────────────────────────────────
// Online payments UI: the Payment Gateways settings page (connect the tenant's
// own gateway account, see every payment link and what the gateway told us) and
// the folio "Collect online" dialog (create a link, send it, watch it get paid).
// Server contract: /api/restaurant/:id/payments/* in server.ts.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Copy, CreditCard, ExternalLink, Link2, Mail,
  MessageCircle, RefreshCw, ShieldCheck, X,
} from 'lucide-react';
import { useToast } from './components/Toast';
import { useConfirm } from './components/ConfirmDialog';
import { canWriteTab, canDeleteTab } from './perm';

type Json = Record<string, any>;

const money = (n: any) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (v: any) => (v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');

function useApi(restaurantId: string, token: string) {
  return useCallback(async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`/api/restaurant/${restaurantId}/payments${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err: any = new Error(body?.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }, [restaurantId, token]);
}

const LINK_STATUS: Record<string, { label: string; cls: string }> = {
  CREATING:       { label: 'Creating',             cls: 'bg-slate-100 text-slate-600' },
  CREATED:        { label: 'Waiting for payment',  cls: 'bg-amber-100 text-amber-800' },
  PARTIALLY_PAID: { label: 'Part paid',            cls: 'bg-sky-100 text-sky-800' },
  PAID:           { label: 'Paid',                 cls: 'bg-emerald-100 text-emerald-800' },
  EXPIRED:        { label: 'Expired',              cls: 'bg-slate-100 text-slate-600' },
  CANCELLED:      { label: 'Cancelled',            cls: 'bg-slate-100 text-slate-600' },
  FAILED:         { label: 'Failed',               cls: 'bg-red-100 text-red-700' },
};
const RECORD_STATUS: Record<string, { label: string; cls: string }> = {
  RECORDED:     { label: 'Recorded',     cls: 'text-emerald-700' },
  PENDING:      { label: 'Recording…',   cls: 'text-amber-700' },
  NEEDS_REVIEW: { label: 'Needs review', cls: 'text-red-700 font-bold' },
  RESOLVED:     { label: 'Resolved',     cls: 'text-slate-600' },
};

function StatusPill({ status }: { status: string }) {
  const s = LINK_STATUS[status] || { label: status, cls: 'bg-slate-100 text-slate-600' };
  return <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${s.cls}`}>{s.label}</span>;
}

async function copyText(text: string, toast: any, what = 'Link') {
  try { await navigator.clipboard.writeText(text); toast.success(`${what} copied`); }
  catch { toast.error('Could not copy — select and copy it by hand.'); }
}

function waShareUrl(phone: string | null | undefined, text: string) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  const to = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}

function linkMessage(l: Json, property?: string) {
  return `Dear ${l.customer_name || 'Guest'},\n\nPlease pay ${money(l.amount)}${property ? ` to ${property}` : ''} for ${l.description || 'your bill'} using this secure link:\n${l.url}\n\nYou can pay by UPI, card or net banking.`;
}

const BRAND: Record<string, string> = { RAZORPAY: '#0c2451', PHONEPE: '#5f259f', PAYTM: '#00baf2' };

const input = 'w-full bg-[#faf7f2] border border-[#e8dccf] rounded-xl px-3 py-2 text-sm text-[#1a1208] focus:outline-none focus:ring-2 focus:ring-[#cc5a16]/30';
const label = 'block text-[11px] font-semibold uppercase tracking-wide text-[#6b5d52] mb-1';
const btn = 'inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed';

// ═════════════════════════════════════════════════════════════════════════════
// Payment Gateways page
// ═════════════════════════════════════════════════════════════════════════════
export function PaymentGatewaysPage({ restaurantId, token }: { restaurantId: string; token: string }) {
  const api = useApi(restaurantId, token);
  const toast = useToast();
  const confirm = useConfirm();
  const canEdit = canWriteTab('PAYMENT_GATEWAYS');
  const canDisconnect = canDeleteTab('PAYMENT_GATEWAYS');
  const [data, setData] = useState<Json | null>(null);
  const [loadError, setLoadError] = useState('');
  const [links, setLinks] = useState<Json[]>([]);
  const [filter, setFilter] = useState<'ALL' | 'OPEN' | 'PAID' | 'NEEDS_REVIEW'>('ALL');
  const [events, setEvents] = useState<Json[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState<string>('');

  const load = useCallback(async () => {
    try {
      setData(await api('/gateways'));
      setLoadError('');
    } catch (e: any) { setLoadError(e.message); }
  }, [api]);
  const loadLinks = useCallback(async () => {
    try {
      const q = filter === 'ALL' ? '' : `&status=${filter}`;
      setLinks((await api(`/links?limit=200${q}`)).links || []);
    } catch (e: any) { toast.error(e.message); }
  }, [api, filter, toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadLinks(); }, [loadLinks]);

  const setField = (gw: string, key: string, v: string) => setDrafts(d => ({ ...d, [gw]: { ...(d[gw] || {}), [key]: v } }));

  const save = async (g: Json, enable?: boolean) => {
    setBusy(`${g.gateway}:save`);
    try {
      const body: Json = { fields: drafts[g.gateway] || {} };
      if (enable !== undefined) body.is_enabled = enable;
      const out = await api(`/gateways/${g.gateway}`, { method: 'PUT', body: JSON.stringify(body) });
      setDrafts(d => ({ ...d, [g.gateway]: {} }));
      toast.success(enable === true ? `${g.label} is on. ${out.detail || ''}` : enable === false ? `${g.label} is off.` : `${g.label} settings saved.`);
    } catch (e: any) {
      toast.error(e.message);
      if (e.body?.gateway) setDrafts(d => ({ ...d, [g.gateway]: {} }));
    } finally {
      setBusy('');
      load();
    }
  };

  const chooseDefault = async (gateway: string) => {
    setBusy('default');
    try {
      await api('/default-gateway', { method: 'PUT', body: JSON.stringify({ gateway }) });
      toast.success(`Payment links now go through ${(data?.gateways || []).find((g: Json) => g.gateway === gateway)?.label || gateway}.`);
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(''); load(); }
  };

  const test = async (g: Json) => {
    setBusy(`${g.gateway}:test`);
    try { const out = await api(`/gateways/${g.gateway}/test`, { method: 'POST' }); toast.success(out.detail || 'Connection works.'); }
    catch (e: any) { toast.error(e.message); }
    finally { setBusy(''); load(); }
  };

  const disconnect = async (g: Json) => {
    const ok = await confirm({ title: `Disconnect ${g.label}?`, body: 'The saved keys are deleted. Links already paid stay recorded; you cannot send new links until you connect again.', confirmLabel: 'Disconnect', danger: true });
    if (!ok) return;
    setBusy(`${g.gateway}:delete`);
    try { await api(`/gateways/${g.gateway}`, { method: 'DELETE' }); toast.success(`${g.label} disconnected.`); }
    catch (e: any) { toast.error(e.message); }
    finally { setBusy(''); load(); }
  };

  const refreshLink = async (l: Json) => {
    setBusy(`link:${l.id}`);
    try {
      const out = await api(`/links/${l.id}/refresh`, { method: 'POST' });
      if (out.recorded) toast.success(`${out.recorded} payment(s) recorded.`);
      else toast.info(`Status:${(LINK_STATUS[out.link.status]?.label || out.link.status).toLowerCase()}.`);
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(''); loadLinks(); load(); }
  };

  const cancelLink = async (l: Json) => {
    const ok = await confirm({ title: 'Cancel this payment link?', body: `${money(l.amount)} for ${l.description || l.object_id}. The customer will no longer be able to pay with it.`, confirmLabel: 'Cancel link', danger: true });
    if (!ok) return;
    setBusy(`link:${l.id}`);
    try { await api(`/links/${l.id}/cancel`, { method: 'POST' }); toast.success('Link cancelled.'); }
    catch (e: any) { toast.error(e.message); }
    finally { setBusy(''); loadLinks(); }
  };

  const resolve = async (p: Json) => {
    const note = window.prompt('What was done with this money? (e.g. "Refunded in Razorpay on 18 Sep" or "Applied to booking B-102")');
    if (!note) return;
    try { await api(`/link-payments/${p.id}/resolve`, { method: 'POST', body: JSON.stringify({ note }) }); toast.success('Marked as resolved.'); }
    catch (e: any) { toast.error(e.message); }
    finally { loadLinks(); load(); }
  };

  const loadEvents = async () => {
    try { setEvents((await api('/webhook-events')).events || []); }
    catch (e: any) { toast.error(e.message); }
  };

  if (loadError) {
    return <div className="bg-white border border-red-200 rounded-3xl p-6 text-sm text-red-700">{loadError}</div>;
  }
  if (!data) return <div className="text-sm text-[#6b5d52] p-6">Loading payment gateways…</div>;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h2 className="text-3xl font-bold font-serif text-[#1a1208]">Payment Gateways</h2>
        <p className="text-sm text-[#6b5d52] mt-1 max-w-3xl">
          Connect your own gateway account. Guests pay by UPI, card or net banking through a link your staff send on WhatsApp or email,
          and each payment is recorded against the bill automatically. Money settles from the gateway straight to your bank.
        </p>
      </div>

      {data.key_source === null && (
        <div className="flex gap-2 items-start bg-red-50 border border-red-200 rounded-2xl p-4 text-sm text-red-800">
          <AlertTriangle size={16} className="mt-0.5 flex-none" />
          The server has no encryption key, so gateway secrets cannot be saved. Ask your administrator to set ATITHI_CREDENTIAL_KEY.
        </div>
      )}
      {data.key_source === 'JWT_DERIVED' && (
        <div className="flex gap-2 items-start bg-amber-50 border border-amber-200 rounded-2xl p-4 text-xs text-amber-900">
          <ShieldCheck size={15} className="mt-0.5 flex-none" />
          Secrets are stored encrypted with a key derived from the server's sign-in secret. For stronger separation, your administrator can set a dedicated ATITHI_CREDENTIAL_KEY; saved secrets move to it the next time you save.
        </div>
      )}
      {Number(data.needs_review) > 0 && (
        <button onClick={() => setFilter('NEEDS_REVIEW')} className="w-full text-left flex gap-2 items-start bg-red-50 border border-red-200 rounded-2xl p-4 text-sm text-red-800 hover:bg-red-100">
          <AlertTriangle size={16} className="mt-0.5 flex-none" />
          <span><strong>{data.needs_review} online payment(s) need review.</strong> The money was received but could not be applied automatically (for example, paid after checkout). Open the list below to resolve them.</span>
        </button>
      )}

      {(() => {
        const on = (data.gateways || []).filter((g: Json) => g.is_enabled);
        if (on.length === 0) return null;
        if (on.length === 1) {
          return <div className="text-sm text-[#3d3128] bg-white border border-[#e8dccf] rounded-2xl px-4 py-3">Payment links go through <strong>{on[0].label}</strong>{on[0].mode === 'TEST' ? ' (test mode)' : ''}.</div>;
        }
        return (
          <div className="bg-white border border-[#e8dccf] rounded-2xl px-4 py-3 flex items-center gap-3 flex-wrap">
            <label className="text-sm font-semibold text-[#1a1208]" htmlFor="pg-default">Payment links go through</label>
            <select id="pg-default" disabled={!canEdit || busy === 'default'} className={`${input} w-auto`} value={data.default_gateway || ''} onChange={e => e.target.value && chooseDefault(e.target.value)}>
              {!data.default_gateway && <option value="">Choose a gateway…</option>}
              {on.map((g: Json) => <option key={g.gateway} value={g.gateway}>{g.label}{g.mode === 'TEST' ? ' (test mode)' : ''}</option>)}
            </select>
            {!data.default_gateway && <span className="text-xs text-red-700">Staff cannot send payment links until you choose one.</span>}
            <span className="text-[11px] text-[#9c8e85] w-full">Staff do not choose a gateway; every new link uses this one. Links already sent keep their gateway until paid or cancelled.</span>
          </div>
        );
      })()}

      {(data.gateways || []).map((g: Json) => {
        const draft = drafts[g.gateway] || {};
        const dirty = Object.values(draft).some(v => String(v).trim() !== '');
        return (
          <div key={g.gateway} className="bg-white border border-[#e8dccf] rounded-3xl p-6 space-y-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-2xl text-white flex items-center justify-center" style={{ background: BRAND[g.gateway] || '#1a1208' }}><CreditCard size={20} /></div>
                <div>
                  <div className="text-lg font-bold text-[#1a1208]">{g.label}{g.is_enabled && g.gateway === data.default_gateway && (data.gateways || []).filter((x: Json) => x.is_enabled).length > 1 && <span className="ml-2 align-middle text-[10px] font-bold uppercase tracking-wide bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">Used for links</span>}</div>
                  <div className="text-xs text-[#6b5d52]">
                    {g.is_enabled
                      ? <span className="text-emerald-700 font-semibold">On{g.mode ? ` · ${g.mode === 'LIVE' ? 'live payments' : 'test mode, no real money'}` : ''}</span>
                      : g.connected ? 'Off' : 'Not connected'}
                    {g.verified_at && <span> · keys checked {when(g.verified_at)}</span>}
                  </div>
                </div>
              </div>
              {canEdit && (
                <div className="flex gap-2 flex-wrap">
                  {g.connected && <button disabled={!!busy} onClick={() => test(g)} className={`${btn} border border-[#e8dccf] text-[#3d3128] hover:bg-[#faf7f2]`}><RefreshCw size={13} /> Test connection</button>}
                  {g.is_enabled
                    ? <button disabled={!!busy} onClick={() => save(g, false)} className={`${btn} border border-[#e8dccf] text-[#3d3128] hover:bg-[#faf7f2]`}>Switch off</button>
                    : <button disabled={!!busy} onClick={() => save(g, true)} className={`${btn} bg-[#cc5a16] text-white hover:bg-[#a84612]`}>{busy === `${g.gateway}:save` ? 'Checking keys…' : 'Save & switch on'}</button>}
                </div>
              )}
            </div>

            {g.last_error && (
              <div className="flex gap-2 items-start bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-800">
                <AlertTriangle size={14} className="mt-0.5 flex-none" /> {g.last_error}
              </div>
            )}
            {g.mode === 'TEST' && g.is_enabled && (
              <div className="text-xs bg-sky-50 border border-sky-200 text-sky-900 rounded-xl p-3">
                Test credentials: links work end to end but no real money moves. Switch to live credentials before sending links to guests.
              </div>
            )}

            <div className="grid md:grid-cols-3 gap-4">
              {g.fields.map((f: Json) => (
                <div key={f.key}>
                  <label className={label}>{f.label}{f.required ? ' *' : ''}</label>
                  {f.options ? (
                    <select disabled={!canEdit} className={input} value={draft[f.key] ?? (f.value || '')} onChange={e => setField(g.gateway, f.key, e.target.value)}>
                      <option value="">Choose…</option>
                      {f.options.map((o: Json) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                  <input
                    type={f.secret ? 'password' : 'text'}
                    autoComplete="off"
                    disabled={!canEdit}
                    className={input}
                    value={draft[f.key] ?? (f.secret ? '' : f.value || '')}
                    placeholder={f.secret ? (f.saved ? (f.unreadable ? 'Saved but unreadable — enter again' : 'Saved — leave blank to keep') : 'Not saved') : ''}
                    onChange={e => setField(g.gateway, f.key, e.target.value)}
                  />
                  )}
                  {f.help && <p className="text-[10px] text-[#9c8e85] mt-1 leading-snug">{f.help}</p>}
                </div>
              ))}
            </div>

            <div className="bg-[#faf7f2] rounded-2xl p-4 space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-[#6b5d52]">Webhook — so payments record themselves</div>
              <div className="flex gap-2 items-center">
                <code className="flex-1 min-w-0 truncate text-xs bg-white border border-[#e8dccf] rounded-lg px-2 py-1.5">{g.webhook_url}</code>
                <button onClick={() => copyText(g.webhook_url, toast, 'Webhook URL')} className={`${btn} border border-[#e8dccf] bg-white`}><Copy size={13} /> Copy</button>
              </div>
              {Array.isArray(g.setup_steps) && g.setup_steps.length > 0 && (
                <ol className="text-xs text-[#6b5d52] list-decimal pl-4 space-y-0.5 break-words">
                  {g.setup_steps.map((step: string, i: number) => <li key={i}>{step}</li>)}
                </ol>
              )}
              {g.requires_customer_phone && <p className="text-[10px] text-[#9c8e85]">{g.label} needs the guest's phone number on every link.</p>}
              <p className="text-[10px] text-[#9c8e85]">If a webhook is missed, open links are still checked with {g.label} every few minutes.</p>
            </div>

            {canEdit && (
              <div className="flex gap-2 flex-wrap justify-between">
                <button disabled={!dirty || !!busy} onClick={() => save(g)} className={`${btn} bg-[#1a1208] text-white hover:bg-black`}>Save changes</button>
                {g.connected && canDisconnect && <button disabled={!!busy} onClick={() => disconnect(g)} className={`${btn} text-red-700 hover:bg-red-50`}>Disconnect</button>}
              </div>
            )}
          </div>
        );
      })}

      <div className="bg-white border border-[#e8dccf] rounded-3xl p-6 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-lg font-bold text-[#1a1208]">Payment links</h3>
            <p className="text-xs text-[#6b5d52]">Every link sent from a bill, what the customer paid, and how it was recorded.</p>
          </div>
          <div className="flex gap-1.5">
            {(['ALL', 'OPEN', 'PAID', 'NEEDS_REVIEW'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)} className={`px-3 py-1.5 rounded-full text-xs font-bold ${filter === f ? 'bg-[#1a1208] text-white' : 'bg-[#faf7f2] text-[#3d3128]'}`}>
                {f === 'ALL' ? 'All' : f === 'OPEN' ? 'Open' : f === 'PAID' ? 'Paid' : 'Needs review'}
              </button>
            ))}
          </div>
        </div>
        {links.length === 0 ? (
          <p className="text-sm text-[#9c8e85] py-6 text-center">No payment links{filter !== 'ALL' ? ' in this view' : ' yet. Send one from a guest folio with "Collect online"'}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-[#9c8e85] border-b border-[#e8dccf]">
                  <th className="py-2 pr-3">Created</th><th className="pr-3">Customer / bill</th><th className="pr-3 text-right">Amount</th>
                  <th className="pr-3">Status</th><th className="pr-3">Payments</th><th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {links.map(l => (
                  <tr key={l.id} className="border-b border-[#f3ece0] align-top">
                    <td className="py-2.5 pr-3 whitespace-nowrap">{when(l.created_at)}<div className="text-[10px] text-[#9c8e85]">{l.created_by_name || ''}</div></td>
                    <td className="pr-3"><div className="font-semibold text-[#1a1208]">{l.customer_name || '—'}</div><div className="text-[10px] text-[#9c8e85]">{l.object_id} · {l.id}</div></td>
                    <td className="pr-3 text-right whitespace-nowrap">{money(l.amount)}{Number(l.amount_paid) > 0 && <div className="text-[10px] text-emerald-700">paid {money(l.amount_paid)}</div>}</td>
                    <td className="pr-3"><StatusPill status={l.status} />{l.mode === 'TEST' && <div className="text-[10px] text-sky-700 mt-0.5">test</div>}{l.last_error && <div className="text-[10px] text-red-700 mt-0.5 max-w-[180px]">{l.last_error}</div>}</td>
                    <td className="pr-3">
                      {(l.payments || []).map((p: Json) => (
                        <div key={p.id} className="mb-1">
                          {money(p.amount)} {p.method ? `· ${p.method}` : ''}{p.fee != null ? ` · fee ${money(p.fee)}` : ''}
                          <span className={`ml-1 ${RECORD_STATUS[p.record_status]?.cls || ''}`}>{RECORD_STATUS[p.record_status]?.label || p.record_status}</span>
                          {p.record_error && <div className="text-[10px] text-red-700 max-w-[220px]">{p.record_error}</div>}
                          {p.resolution_note && <div className="text-[10px] text-[#6b5d52] max-w-[220px]">“{p.resolution_note}”</div>}
                          {p.record_status === 'NEEDS_REVIEW' && canEdit && <button onClick={() => resolve(p)} className="text-[10px] font-bold text-[#cc5a16] underline">Resolve</button>}
                        </div>
                      ))}
                    </td>
                    <td className="text-right whitespace-nowrap space-x-1">
                      {l.url && <button title="Copy link" onClick={() => copyText(l.url, toast)} className="p-1.5 rounded-lg hover:bg-[#faf7f2]"><Copy size={13} /></button>}
                      {l.status !== 'FAILED' && <button title="Check status" disabled={busy === `link:${l.id}`} onClick={() => refreshLink(l)} className="p-1.5 rounded-lg hover:bg-[#faf7f2]"><RefreshCw size={13} className={busy === `link:${l.id}` ? 'animate-spin' : ''} /></button>}
                      {['CREATED', 'PARTIALLY_PAID'].includes(l.status) && <button title="Cancel link" onClick={() => cancelLink(l)} className="p-1.5 rounded-lg hover:bg-red-50 text-red-700"><X size={13} /></button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-white border border-[#e8dccf] rounded-3xl p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-[#1a1208]">Recent webhook calls</h3>
            <p className="text-xs text-[#6b5d52]">What the gateway sent. A run of “bad signature” means the webhook secret here does not match the gateway's.</p>
          </div>
          <button onClick={loadEvents} className={`${btn} border border-[#e8dccf]`}><RefreshCw size={13} /> {events ? 'Refresh' : 'Show'}</button>
        </div>
        {events && (events.length === 0
          ? <p className="text-xs text-[#9c8e85] mt-3">No calls received yet.</p>
          : <table className="w-full text-xs mt-3">
              <tbody>
                {events.map(e => (
                  <tr key={e.id} className="border-b border-[#f3ece0]">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{when(e.received_at)}</td>
                    <td className="pr-3">{e.event_type || '—'}</td>
                    <td className={`pr-3 font-semibold ${e.outcome === 'PROCESSED' ? 'text-emerald-700' : e.outcome === 'BAD_SIGNATURE' || e.outcome === 'FAILED' ? 'text-red-700' : 'text-[#6b5d52]'}`}>{String(e.outcome).replace(/_/g, ' ').toLowerCase()}</td>
                    <td className="text-[#6b5d52]">{e.detail || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>)}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Collect online — from a guest folio
// ═════════════════════════════════════════════════════════════════════════════
export function CollectOnlineDialog({ restaurantId, token, folio, propertyName, onClose, onRecorded }: {
  restaurantId: string;
  token: string;
  folio: Json;
  propertyName?: string;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const api = useApi(restaurantId, token);
  const toast = useToast();
  const confirm = useConfirm();
  const canCollect = canWriteTab('FOLIOS');
  const [outstanding, setOutstanding] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState(folio.guest_phone || '');
  const [email, setEmail] = useState(folio.guest_email || '');
  const [hours, setHours] = useState('72');
  const [links, setLinks] = useState<Json[]>([]);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [active, setActive] = useState<Json | null>(null);

  const loadLinks = useCallback(async () => {
    try {
      const out = await api(`/links?object_type=HOTEL_FOLIO&object_id=${encodeURIComponent(folio.id)}&limit=20`);
      setLinks(out.links || []);
    } catch (e: any) { setNotice({ tone: 'error', text: e.message }); }
  }, [api, folio.id]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/restaurant/${restaurantId}/hotel/folios/${folio.id}/outstanding`, { headers: { Authorization: `Bearer ${token}` } });
        const b = await r.json().catch(() => ({}));
        if (r.ok) {
          const o = Number(b.outstanding ?? 0);
          setOutstanding(o);
          if (o > 0) setAmount(o.toFixed(2));
        }
      } catch { /* the amount field still works */ }
    })();
    api('/active-gateway').then(setActive).catch(() => setActive({ gateway: null, reason: 'Could not check the payment gateway.' }));
    loadLinks();
  }, [restaurantId, token, folio.id, loadLinks, api]);

  const open = useMemo(() => links.find(l => ['CREATED', 'PARTIALLY_PAID'].includes(l.status)) || null, [links]);

  // While a link is waiting, check it every 30 seconds so the bill updates the
  // moment the guest pays (the webhook usually gets there first).
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => { refresh(open, true); }, 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.id]);

  const create = async (channel: 'NONE' | 'WHATSAPP' | 'EMAIL') => {
    if (open) {
      const ok = await confirm({ title: 'Replace the open link?', body: `A link for ${money(open.amount)} is still waiting. It will be cancelled so the guest cannot pay twice.`, confirmLabel: 'Replace it' });
      if (!ok) return;
    }
    setBusy(`create:${channel}`);
    setNotice(null);
    try {
      const out = await api('/links', {
        method: 'POST',
        body: JSON.stringify({ object_type: 'HOTEL_FOLIO', object_id: folio.id, amount, customer_phone: phone, customer_email: email, customer_name: folio.guest_name, expires_in_hours: Number(hours), channel }),
      });
      if (channel === 'NONE') setNotice({ tone: 'ok', text: 'Link created. Copy it or share it on WhatsApp below.' });
      else if (out.sent?.length) setNotice({ tone: out.errors ? 'warn' : 'ok', text: `Sent on ${out.sent.join(' and ').toLowerCase()}.${out.errors ? ` ${out.errors.join(' ')}` : ''}` });
      else setNotice({ tone: 'warn', text: `Link created but not sent: ${(out.errors || []).join(' ')} Use Copy or Share on WhatsApp below.` });
    } catch (e: any) {
      setNotice({ tone: 'error', text: e.message });
    } finally {
      setBusy('');
      loadLinks();
    }
  };

  const send = async (l: Json, channel: 'WHATSAPP' | 'EMAIL') => {
    setBusy(`send:${channel}`);
    try {
      const out = await api(`/links/${l.id}/send`, { method: 'POST', body: JSON.stringify({ channel, customer_phone: phone, customer_email: email }) });
      setNotice({ tone: out.errors ? 'warn' : 'ok', text: `Sent on ${out.sent.join(' and ').toLowerCase()}.${out.errors ? ` ${out.errors.join(' ')}` : ''}` });
    } catch (e: any) { setNotice({ tone: 'error', text: e.message }); }
    finally { setBusy(''); loadLinks(); }
  };

  const refresh = async (l: Json, quiet = false) => {
    if (!quiet) setBusy(`refresh:${l.id}`);
    try {
      const out = await api(`/links/${l.id}/refresh`, { method: 'POST' });
      if (out.recorded > 0) {
        toast.success(`${money(out.link.amount_paid)} received online and recorded on the folio.`);
        onRecorded();
      }
      if (out.needs_review > 0) setNotice({ tone: 'warn', text: 'A payment arrived but could not be applied to this folio. See Payment Gateways → Needs review.' });
    } catch (e: any) { if (!quiet) setNotice({ tone: 'error', text: e.message }); }
    finally { if (!quiet) setBusy(''); loadLinks(); }
  };

  const cancel = async (l: Json) => {
    const ok = await confirm({ title: 'Cancel this payment link?', body: 'The guest will no longer be able to pay with it.', confirmLabel: 'Cancel link', danger: true });
    if (!ok) return;
    setBusy(`cancel:${l.id}`);
    try { await api(`/links/${l.id}/cancel`, { method: 'POST' }); setNotice({ tone: 'ok', text: 'Link cancelled.' }); }
    catch (e: any) { setNotice({ tone: 'error', text: e.message }); }
    finally { setBusy(''); loadLinks(); }
  };

  const toneCls = { ok: 'bg-emerald-50 border-emerald-200 text-emerald-900', warn: 'bg-amber-50 border-amber-200 text-amber-900', error: 'bg-red-50 border-red-200 text-red-800' };

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between px-6 pt-5 pb-3 border-b border-[#f3ece0]">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-[#cc5a16]">Collect online</div>
            <h3 className="text-lg font-bold font-serif text-[#1a1208]">{folio.guest_name || 'Guest'}</h3>
            <p className="text-xs text-[#6b5d52]">Folio {folio.id}{outstanding != null ? ` · balance due ${money(outstanding)}` : ''}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-xl hover:bg-[#faf7f2] text-[#9c8e85]"><X size={18} /></button>
        </div>

        <div className="p-6 space-y-5">
          {notice && <div className={`border rounded-xl p-3 text-xs ${toneCls[notice.tone]}`}>{notice.text}</div>}

          {canCollect && active && !active.gateway && (
            <div className="border rounded-xl p-3 text-xs bg-amber-50 border-amber-200 text-amber-900">{active.reason || 'No payment gateway is switched on.'}</div>
          )}
          {canCollect && active?.gateway && (
            <div className="space-y-3">
              <div className="text-[11px] text-[#6b5d52]">Link via <strong className="text-[#1a1208]">{active.label}</strong>{active.mode === 'TEST' ? <span className="ml-1 text-sky-700">(test mode, no real money)</span> : null}</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={label}>Amount (₹)</label>
                  <input className={input} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder={outstanding ? outstanding.toFixed(2) : 'e.g. 5000'} />
                  {outstanding === 0 && <p className="text-[10px] text-[#9c8e85] mt-1">Nothing charged yet — enter the advance to collect.</p>}
                </div>
                <div>
                  <label className={label}>Link valid for</label>
                  <select className={input} value={hours} onChange={e => setHours(e.target.value)}>
                    <option value="24">24 hours</option>
                    <option value="72">3 days</option>
                    <option value="168">7 days</option>
                    <option value="720">30 days</option>
                  </select>
                </div>
                <div>
                  <label className={label}>Guest phone{active?.requires_customer_phone ? ' *' : ''}</label>
                  <input className={input} value={phone} onChange={e => setPhone(e.target.value)} placeholder="+91…" />
                </div>
                <div>
                  <label className={label}>Guest email</label>
                  <input className={input} value={email} onChange={e => setEmail(e.target.value)} placeholder="guest@example.com" />
                </div>
              </div>
              <div className="flex gap-2 flex-wrap">
                <button disabled={!!busy || !phone} onClick={() => create('WHATSAPP')} className={`${btn} bg-[#128c7e] text-white hover:bg-[#0e6f64]`}><MessageCircle size={13} /> {busy === 'create:WHATSAPP' ? 'Sending…' : 'Send on WhatsApp'}</button>
                <button disabled={!!busy || !email || (active?.requires_customer_phone && !phone)} onClick={() => create('EMAIL')} className={`${btn} bg-[#1e3a5f] text-white hover:bg-[#162c49]`}><Mail size={13} /> {busy === 'create:EMAIL' ? 'Sending…' : 'Send by email'}</button>
                <button disabled={!!busy || (active?.requires_customer_phone && !phone)} onClick={() => create('NONE')} className={`${btn} border border-[#e8dccf] text-[#3d3128] hover:bg-[#faf7f2]`}><Link2 size={13} /> {busy === 'create:NONE' ? 'Creating…' : 'Create link only'}</button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[#6b5d52]">Links for this folio</div>
            {links.length === 0 && <p className="text-xs text-[#9c8e85]">None yet.</p>}
            {links.map(l => (
              <div key={l.id} className={`rounded-2xl border p-3 space-y-2 ${['CREATED', 'PARTIALLY_PAID'].includes(l.status) ? 'border-amber-200 bg-amber-50/40' : 'border-[#e8dccf]'}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-bold text-[#1a1208]">{money(l.amount)} <StatusPill status={l.status} />{l.mode === 'TEST' && <span className="ml-1 text-[10px] text-sky-700">test</span>}</div>
                  <div className="text-[10px] text-[#9c8e85]">{when(l.created_at)}</div>
                </div>
                {l.url && ['CREATED', 'PARTIALLY_PAID'].includes(l.status) && (
                  <div className="flex gap-1.5 flex-wrap items-center">
                    <a href={l.url} target="_blank" rel="noreferrer" className="text-xs text-[#1e3a5f] underline truncate max-w-[220px] inline-flex items-center gap-1">{l.url} <ExternalLink size={11} /></a>
                    <button onClick={() => copyText(l.url, toast)} className={`${btn} py-1 border border-[#e8dccf] bg-white`}><Copy size={12} /> Copy</button>
                    <a href={waShareUrl(phone || l.customer_phone, linkMessage(l, propertyName))} target="_blank" rel="noreferrer" className={`${btn} py-1 border border-[#128c7e]/30 text-[#128c7e] bg-white`}><MessageCircle size={12} /> Share on WhatsApp</a>
                    {canCollect && <button disabled={!!busy || !email} onClick={() => send(l, 'EMAIL')} className={`${btn} py-1 border border-[#e8dccf] bg-white`}><Mail size={12} /> Email again</button>}
                  </div>
                )}
                {(l.payments || []).map((p: Json) => (
                  <div key={p.id} className="text-xs text-[#3d3128] flex items-center gap-1">
                    <CheckCircle2 size={12} className="text-emerald-600" /> {money(p.amount)} {p.method ? `by ${p.method}` : ''} · {when(p.paid_at)}
                    <span className={`ml-1 ${RECORD_STATUS[p.record_status]?.cls || ''}`}>{RECORD_STATUS[p.record_status]?.label || p.record_status}</span>
                  </div>
                ))}
                {l.last_error && l.status === 'FAILED' && <div className="text-[11px] text-red-700">{l.last_error}</div>}
                <div className="flex gap-2">
                  {l.status !== 'FAILED' && <button disabled={!!busy} onClick={() => refresh(l)} className="text-[11px] font-bold text-[#cc5a16] inline-flex items-center gap-1"><RefreshCw size={11} className={busy === `refresh:${l.id}` ? 'animate-spin' : ''} /> Check status</button>}
                  {canCollect && ['CREATED', 'PARTIALLY_PAID'].includes(l.status) && <button disabled={!!busy} onClick={() => cancel(l)} className="text-[11px] font-bold text-red-700">Cancel link</button>}
                </div>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-[#9c8e85] leading-snug">
            When the guest pays, the payment is added to this folio automatically — as an advance before check-in (with its GST receipt voucher) or an interim payment during the stay — and the gateway's fee is booked to Card &amp; UPI Charges.
          </p>
        </div>
      </div>
    </div>
  );
}
