// ─────────────────────────────────────────────────────────────────────────────
// Online payments UI: the Payment Gateways settings page (connect the tenant's
// own gateway account, see every payment link and what the gateway told us) and
// the folio "Collect online" dialog (create a link, send it, watch it get paid).
// Server contract: /api/restaurant/:id/payments/* in server.ts.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Copy, CreditCard, ExternalLink, Info, Link2, Mail,
  MessageCircle, RefreshCw, X,
} from 'lucide-react';
import { useToast } from './components/Toast';
import { DataTable, type ColDef } from './components/DataTable';
import { useT } from './i18n';
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

const LINK_STATUS_CLS: Record<string, string> = {
  CREATING:       'bg-slate-100 text-slate-600',
  CREATED:        'bg-amber-100 text-amber-800',
  PARTIALLY_PAID: 'bg-sky-100 text-sky-800',
  PAID:           'bg-emerald-100 text-emerald-800',
  EXPIRED:        'bg-slate-100 text-slate-600',
  CANCELLED:      'bg-slate-100 text-slate-600',
  FAILED:         'bg-red-100 text-red-700',
};
const RECORD_STATUS_CLS: Record<string, string> = {
  RECORDED:     'text-emerald-700',
  PENDING:      'text-amber-700',
  NEEDS_REVIEW: 'text-red-700 font-bold',
  RESOLVED:     'text-slate-600',
};
const OUTCOME_CLS: Record<string, string> = {
  PROCESSED: 'text-emerald-700',
  BAD_SIGNATURE: 'text-red-700',
  FAILED: 'text-red-700',
};
const GATEWAY_LABEL: Record<string, string> = { RAZORPAY: 'Razorpay', PHONEPE: 'PhonePe', PAYTM: 'Paytm' };

// A status word from the dictionary, or the raw code when a new one appears.
function statusWord(t: (k: string) => string, prefix: string, code: string): string {
  const key = `${prefix}.${code}`;
  const word = t(key);
  return word === key ? String(code || '').replace(/_/g, ' ').toLowerCase() : word;
}

function StatusPill({ status }: { status: string }) {
  const { t } = useT();
  return (
    <span className={`inline-block whitespace-nowrap px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${LINK_STATUS_CLS[status] || 'bg-slate-100 text-slate-600'}`}>
      {statusWord(t, 'pg.linkStatus', status)}
    </span>
  );
}

function ModeBadge({ mode }: { mode: string | null | undefined }) {
  const { t } = useT();
  if (!mode) return null;
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider ${mode === 'LIVE' ? 'bg-emerald-100 text-emerald-800' : 'bg-sky-100 text-sky-800'}`}>
      {t(`pg.mode.${mode}`)}
    </span>
  );
}

// Help text lives behind an icon, not in the page.
function Hint({ text }: { text?: string | null }) {
  if (!text) return null;
  return (
    <span title={text} aria-label={text} role="img" className="inline-flex align-middle ml-1 text-[#9c8e85] hover:text-[#6b5d52] cursor-help">
      <Info size={12} />
    </span>
  );
}

async function copyText(text: string, toast: any, message: string, failMessage: string) {
  try { await navigator.clipboard.writeText(text); toast.success(message); }
  catch { toast.error(failMessage); }
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
// Payment Gateways page — three sub-tabs: Gateways · Payment links · Webhook log
// ═════════════════════════════════════════════════════════════════════════════
type PgTab = 'GATEWAYS' | 'LINKS' | 'WEBHOOKS';
type LinkFilter = 'ALL' | 'OPEN' | 'PAID' | 'NEEDS_REVIEW';

export function PaymentGatewaysPage({ restaurantId, token }: { restaurantId: string; token: string }) {
  const api = useApi(restaurantId, token);
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useT();
  const canEdit = canWriteTab('PAYMENT_GATEWAYS');
  const canDisconnect = canDeleteTab('PAYMENT_GATEWAYS');
  const [tab, setTab] = useState<PgTab>('GATEWAYS');
  const [data, setData] = useState<Json | null>(null);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<string>('');
  const [links, setLinks] = useState<Json[]>([]);
  const [linksLoading, setLinksLoading] = useState(false);
  const [filter, setFilter] = useState<LinkFilter>('ALL');
  const [events, setEvents] = useState<Json[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState<string>('');
  const [resolving, setResolving] = useState<Json | null>(null);
  const [resolveNote, setResolveNote] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api('/gateways'));
      setLoadError('');
    } catch (e: any) { setLoadError(e.message); }
  }, [api]);
  const loadLinks = useCallback(async () => {
    setLinksLoading(true);
    try {
      const q = filter === 'ALL' ? '' : `&status=${filter}`;
      setLinks((await api(`/links?limit=500${q}`)).links || []);
    } catch (e: any) { toast.error(e.message); }
    finally { setLinksLoading(false); }
  }, [api, filter, toast]);
  const loadEvents = useCallback(async () => {
    try { setEvents((await api('/webhook-events')).events || []); }
    catch (e: any) { toast.error(e.message); }
  }, [api, toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (tab === 'LINKS') loadLinks(); }, [tab, loadLinks]);
  useEffect(() => { if (tab === 'WEBHOOKS') loadEvents(); }, [tab, loadEvents]);

  // Open on the gateway in use, else the first connected one, else the first.
  useEffect(() => {
    const all: Json[] = data?.gateways || [];
    if (!all.length || all.some(g => g.gateway === selected)) return;
    const pick = all.find(g => g.gateway === data?.default_gateway) || all.find(g => g.connected) || all[0];
    setSelected(pick.gateway);
  }, [data, selected]);

  const setField = (gw: string, key: string, v: string) => setDrafts(d => ({ ...d, [gw]: { ...(d[gw] || {}), [key]: v } }));

  const save = async (g: Json, enable?: boolean) => {
    setBusy(`${g.gateway}:save`);
    try {
      const body: Json = { fields: drafts[g.gateway] || {} };
      if (enable !== undefined) body.is_enabled = enable;
      await api(`/gateways/${g.gateway}`, { method: 'PUT', body: JSON.stringify(body) });
      setDrafts(d => ({ ...d, [g.gateway]: {} }));
      toast.success(t(enable === true ? 'pg.toast.on' : enable === false ? 'pg.toast.off' : 'pg.toast.saved', { name: g.label }));
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
      toast.success(t('pg.default.changed', { name: GATEWAY_LABEL[gateway] || gateway }));
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(''); load(); }
  };

  const test = async (g: Json) => {
    setBusy(`${g.gateway}:test`);
    try { const out = await api(`/gateways/${g.gateway}/test`, { method: 'POST' }); toast.success(out.detail || t('pg.toast.connectionOk')); }
    catch (e: any) { toast.error(e.message); }
    finally { setBusy(''); load(); }
  };

  const disconnect = async (g: Json) => {
    const ok = await confirm({ title: t('pg.disconnect.title', { name: g.label }), body: t('pg.disconnect.body'), confirmLabel: t('pg.disconnect'), danger: true });
    if (!ok) return;
    setBusy(`${g.gateway}:delete`);
    try { await api(`/gateways/${g.gateway}`, { method: 'DELETE' }); toast.success(t('pg.toast.disconnected', { name: g.label })); }
    catch (e: any) { toast.error(e.message); }
    finally { setBusy(''); load(); }
  };

  const refreshLink = async (l: Json) => {
    setBusy(`link:${l.id}`);
    try {
      const out = await api(`/links/${l.id}/refresh`, { method: 'POST' });
      if (out.recorded) toast.success(t('pg.toast.recorded', { n: out.recorded }));
      else toast.info(t('pg.toast.status', { status: statusWord(t, 'pg.linkStatus', out.link.status) }));
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(''); loadLinks(); load(); }
  };

  const cancelLink = async (l: Json) => {
    const ok = await confirm({ title: t('pg.cancel.title'), body: `${money(l.amount)} · ${l.description || l.object_id}`, confirmLabel: t('pg.action.cancel'), danger: true });
    if (!ok) return;
    setBusy(`link:${l.id}`);
    try { await api(`/links/${l.id}/cancel`, { method: 'POST' }); toast.success(t('pg.toast.cancelled')); }
    catch (e: any) { toast.error(e.message); }
    finally { setBusy(''); loadLinks(); }
  };

  const submitResolve = async () => {
    if (!resolving) return;
    setBusy('resolve');
    try {
      await api(`/link-payments/${resolving.id}/resolve`, { method: 'POST', body: JSON.stringify({ note: resolveNote }) });
      toast.success(t('pg.toast.resolved'));
      setResolving(null);
      setResolveNote('');
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(''); loadLinks(); load(); }
  };

  const linkColumns = useMemo<ColDef<Json>[]>(() => [
    {
      key: 'created_at', label: t('pg.col.created'), sortable: true,
      getValue: (l) => l.created_at ? new Date(l.created_at).getTime() : 0,
      exportValue: (l) => when(l.created_at),
      render: (l) => <div className="whitespace-nowrap">{when(l.created_at)}<div className="text-[10px] text-[#9c8e85]">{l.created_by_name || ''}</div></div>,
    },
    {
      key: 'customer_name', label: t('pg.col.customer'), sortable: true, searchable: true,
      render: (l) => <div><div className="font-semibold text-[#1a1208]">{l.customer_name || '—'}</div><div className="text-[10px] text-[#9c8e85] max-w-[220px] truncate">{l.description || ''}</div></div>,
    },
    { key: 'object_id', label: t('pg.col.bill'), searchable: true, render: (l) => <span className="font-mono text-[11px] whitespace-nowrap">{l.object_id}</span> },
    { key: 'id', label: t('pg.col.link'), searchable: true, defaultHidden: true, render: (l) => <span className="font-mono text-[11px] whitespace-nowrap">{l.id}</span> },
    {
      key: 'gateway', label: t('pg.col.gateway'), sortable: true, filterable: true, filterType: 'select', defaultHidden: true,
      exportValue: (l) => GATEWAY_LABEL[l.gateway] || l.gateway,
      render: (l) => <span className="whitespace-nowrap">{GATEWAY_LABEL[l.gateway] || l.gateway} <ModeBadge mode={l.mode === 'TEST' ? 'TEST' : null} /></span>,
    },
    {
      key: 'amount', label: t('pg.col.amount'), sortable: true, align: 'right',
      getValue: (l) => Number(l.amount || 0), exportValue: (l) => String(l.amount),
      render: (l) => <div className="whitespace-nowrap">{money(l.amount)}{Number(l.amount_paid) > 0 && <div className="text-[10px] text-emerald-700">{t('pg.paidAmount', { amount: money(l.amount_paid) })}</div>}</div>,
    },
    {
      key: 'status', label: t('pg.col.status'), sortable: true, filterable: true, filterType: 'select',
      exportValue: (l) => l.status,
      render: (l) => <div><StatusPill status={l.status} />{l.mode === 'TEST' && <span className="ml-1"><ModeBadge mode="TEST" /></span>}{l.last_error && <div className="text-[10px] text-red-700 mt-0.5 max-w-[180px]">{l.last_error}</div>}</div>,
    },
    {
      key: 'payments', label: t('pg.col.payments'),
      exportValue: (l) => (l.payments || []).map((p: Json) => `${p.amount} ${p.method || ''} ${p.record_status}`).join('; '),
      render: (l) => (
        <div className="space-y-1 min-w-[200px]">
          {(l.payments || []).map((p: Json) => (
            <div key={p.id} className="text-[11px]">
              {money(p.amount)}{p.method ? ` · ${p.method}` : ''}{p.fee != null ? ` · ${t('pg.fee', { amount: money(p.fee) })}` : ''}
              <span className={`ml-1 ${RECORD_STATUS_CLS[p.record_status] || ''}`}>{statusWord(t, 'pg.recordStatus', p.record_status)}</span>
              {p.record_error && <div className="text-[10px] text-red-700 max-w-[220px]">{p.record_error}</div>}
              {p.resolution_note && <div className="text-[10px] text-[#6b5d52] max-w-[220px]">“{p.resolution_note}”</div>}
              {p.record_status === 'NEEDS_REVIEW' && canEdit && (
                <button onClick={() => { setResolving(p); setResolveNote(''); }} className="text-[10px] font-bold text-[#cc5a16] underline">{t('pg.action.resolve')}</button>
              )}
            </div>
          ))}
        </div>
      ),
    },
    {
      key: 'actions', label: '', noExport: true, hideable: false, align: 'right',
      render: (l) => (
        <div className="whitespace-nowrap space-x-1">
          {l.url && <button title={t('pg.action.copy')} aria-label={t('pg.action.copy')} onClick={() => copyText(l.url, toast, t('pg.toast.copied'), t('pg.toast.copyFailed'))} className="p-1.5 rounded-lg hover:bg-[#faf7f2]"><Copy size={13} /></button>}
          {l.status !== 'FAILED' && <button title={t('pg.action.check')} aria-label={t('pg.action.check')} disabled={busy === `link:${l.id}`} onClick={() => refreshLink(l)} className="p-1.5 rounded-lg hover:bg-[#faf7f2]"><RefreshCw size={13} className={busy === `link:${l.id}` ? 'animate-spin' : ''} /></button>}
          {canEdit && ['CREATED', 'PARTIALLY_PAID'].includes(l.status) && <button title={t('pg.action.cancel')} aria-label={t('pg.action.cancel')} onClick={() => cancelLink(l)} className="p-1.5 rounded-lg hover:bg-red-50 text-red-700"><X size={13} /></button>}
        </div>
      ),
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, busy, canEdit, toast]);

  const eventColumns = useMemo<ColDef<Json>[]>(() => [
    {
      key: 'received_at', label: t('pg.col.received'), sortable: true,
      getValue: (e) => e.received_at ? new Date(e.received_at).getTime() : 0,
      exportValue: (e) => when(e.received_at),
      render: (e) => <span className="whitespace-nowrap">{when(e.received_at)}</span>,
    },
    { key: 'gateway', label: t('pg.col.gateway'), sortable: true, filterable: true, filterType: 'select', render: (e) => GATEWAY_LABEL[e.gateway] || e.gateway },
    { key: 'event_type', label: t('pg.col.event'), searchable: true, render: (e) => e.event_type || '—' },
    {
      key: 'outcome', label: t('pg.col.outcome'), sortable: true, filterable: true, filterType: 'select',
      render: (e) => <span className={`font-semibold ${OUTCOME_CLS[e.outcome] || 'text-[#6b5d52]'}`}>{statusWord(t, 'pg.outcome', e.outcome)}</span>,
    },
    { key: 'detail', label: t('pg.col.detail'), searchable: true, render: (e) => <span className="text-[#6b5d52]">{e.detail || ''}</span> },
  ], [t]);

  if (loadError) {
    return <div className="bg-white border border-red-200 rounded-3xl p-6 text-sm text-red-700">{loadError}</div>;
  }
  if (!data) return <div className="text-sm text-[#6b5d52] p-6">{t('common.loading')}</div>;

  const gateways: Json[] = data.gateways || [];
  const enabled = gateways.filter(g => g.is_enabled);
  const g = gateways.find(x => x.gateway === selected) || gateways[0];
  const needsReview = Number(data.needs_review) || 0;

  const tabBtn = (id: PgTab, text: string, badge?: number) => (
    <button
      key={id}
      onClick={() => setTab(id)}
      className={`px-5 py-2.5 text-sm font-semibold rounded-t-xl whitespace-nowrap ${tab === id ? 'bg-white border border-b-white border-[#e8e0d8] text-[#cc5a16] -mb-px' : 'text-[#6b5d52] hover:text-[#1a1208] hover:bg-[#f5f0ea]'}`}
    >
      {text}
      {badge ? <span className="ml-2 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold">{badge}</span> : null}
    </button>
  );

  return (
    <div className="space-y-4 max-w-5xl">
      <h2 className="text-3xl font-bold font-serif text-[#1a1208]">{t('pg.title')}</h2>

      {data.key_source === null && (
        <div className="flex gap-2 items-center bg-red-50 border border-red-200 rounded-2xl px-4 py-3 text-sm text-red-800">
          <AlertTriangle size={16} className="flex-none" /> {t('pg.noKey')}
        </div>
      )}

      <div className="flex gap-1 border-b border-[#e8e0d8] overflow-x-auto overflow-y-hidden">
        {tabBtn('GATEWAYS', t('pg.tab.gateways'))}
        {tabBtn('LINKS', t('pg.tab.links'), needsReview)}
        {tabBtn('WEBHOOKS', t('pg.tab.webhooks'))}
      </div>

      {tab === 'GATEWAYS' && (
        <div className="space-y-4">
          <div className="bg-white border border-[#e8dccf] rounded-2xl px-5 py-3 flex items-center gap-3 flex-wrap">
            <label className="text-sm font-bold text-[#1a1208]" htmlFor="pg-default">{t('pg.default')}</label>
            <select
              id="pg-default"
              disabled={!canEdit || busy === 'default' || enabled.length === 0}
              className="bg-[#faf7f2] border border-[#e8dccf] rounded-xl px-3 py-2 text-sm text-[#1a1208] focus:outline-none focus:ring-2 focus:ring-[#cc5a16]/30 min-w-[240px] disabled:opacity-60"
              value={data.default_gateway || ''}
              onChange={e => e.target.value && chooseDefault(e.target.value)}
            >
              {!data.default_gateway && <option value="">{enabled.length ? t('pg.default.choose') : t('pg.default.switchOnFirst')}</option>}
              {gateways.map((x: Json) => (
                <option key={x.gateway} value={x.gateway} disabled={!x.is_enabled}>
                  {x.label}{x.is_enabled ? (x.mode === 'TEST' ? ` (${t('pg.mode.TEST')})` : '') : ` (${t('pg.status.off')})`}
                </option>
              ))}
            </select>
            {enabled.length > 1 && !data.default_gateway && <span className="text-xs text-red-700 font-semibold">{t('pg.default.required')}</span>}
          </div>

          <div className="inline-flex flex-wrap bg-white rounded-2xl p-1 border border-[#e8dccf]" role="tablist">
            {gateways.map((x: Json) => {
              const dot = x.is_enabled ? 'bg-emerald-500' : x.connected ? 'bg-amber-400' : 'bg-slate-300';
              const active = g && x.gateway === g.gateway;
              return (
                <button
                  key={x.gateway}
                  role="tab"
                  aria-selected={!!active}
                  onClick={() => setSelected(x.gateway)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold ${active ? 'bg-[#1a1208] text-white' : 'text-[#3d3128] hover:bg-[#faf7f2]'}`}
                >
                  <span className={`w-2 h-2 rounded-full ${dot}`} />
                  {x.label}
                </button>
              );
            })}
          </div>

          {g && (() => {
            const draft = drafts[g.gateway] || {};
            const dirty = Object.values(draft).some(v => String(v).trim() !== '');
            const statusText = g.is_enabled ? t('pg.status.on') : g.connected ? t('pg.status.off') : t('pg.status.notConnected');
            return (
              <div className="bg-white border border-[#e8dccf] rounded-3xl p-6 space-y-5">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl text-white flex items-center justify-center" style={{ background: BRAND[g.gateway] || '#1a1208' }}><CreditCard size={18} /></div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-lg font-bold text-[#1a1208]">{g.label}</span>
                      <span
                        title={g.verified_at ? t('pg.keysChecked', { when: when(g.verified_at) }) : undefined}
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${g.is_enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}
                      >{statusText}</span>
                      {g.is_enabled && <ModeBadge mode={g.mode} />}
                    </div>
                  </div>
                  {canEdit && (
                    <div className="flex gap-2 flex-wrap">
                      {g.connected && <button disabled={!!busy} onClick={() => test(g)} className={`${btn} border border-[#e8dccf] text-[#3d3128] hover:bg-[#faf7f2]`}><RefreshCw size={13} className={busy === `${g.gateway}:test` ? 'animate-spin' : ''} /> {t('pg.test')}</button>}
                      {g.is_enabled
                        ? <button disabled={!!busy} onClick={() => save(g, false)} className={`${btn} border border-[#e8dccf] text-[#3d3128] hover:bg-[#faf7f2]`}>{t('pg.switchOff')}</button>
                        : <button disabled={!!busy} onClick={() => save(g, true)} className={`${btn} bg-[#cc5a16] text-white hover:bg-[#a84612]`}>{busy === `${g.gateway}:save` ? t('pg.switchingOn') : t('pg.switchOn')}</button>}
                    </div>
                  )}
                </div>

                {g.last_error && (
                  <div className="flex gap-2 items-start bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-800">
                    <AlertTriangle size={14} className="mt-0.5 flex-none" /> {g.last_error}
                  </div>
                )}

                <div className="grid md:grid-cols-3 gap-4">
                  {g.fields.map((f: Json) => (
                    <div key={f.key}>
                      <label className={label} htmlFor={`pg-${g.gateway}-${f.key}`}>{f.label}{f.required ? ' *' : ''}<Hint text={f.help} /></label>
                      {f.options ? (
                        <select id={`pg-${g.gateway}-${f.key}`} disabled={!canEdit} className={input} value={draft[f.key] ?? (f.value || '')} onChange={e => setField(g.gateway, f.key, e.target.value)}>
                          <option value="">{t('pg.field.choose')}</option>
                          {f.options.map((o: Json) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      ) : (
                        <input
                          id={`pg-${g.gateway}-${f.key}`}
                          type={f.secret ? 'password' : 'text'}
                          autoComplete="off"
                          disabled={!canEdit}
                          className={input}
                          value={draft[f.key] ?? (f.secret ? '' : f.value || '')}
                          placeholder={f.secret ? (f.saved ? (f.unreadable ? t('pg.field.unreadable') : t('pg.field.saved')) : t('pg.field.notSaved')) : ''}
                          onChange={e => setField(g.gateway, f.key, e.target.value)}
                        />
                      )}
                    </div>
                  ))}
                </div>

                <div className="bg-[#faf7f2] rounded-2xl p-4 space-y-2">
                  <div className="flex gap-2 items-center">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-[#6b5d52] whitespace-nowrap">{t('pg.webhookUrl')}</span>
                    <code className="flex-1 min-w-0 truncate text-xs bg-white border border-[#e8dccf] rounded-lg px-2 py-1.5" title={g.webhook_url}>{g.webhook_url}</code>
                    <button onClick={() => copyText(g.webhook_url, toast, t('pg.toast.copied'), t('pg.toast.copyFailed'))} className={`${btn} border border-[#e8dccf] bg-white`}><Copy size={13} /> {t('pg.copy')}</button>
                  </div>
                  {Array.isArray(g.setup_steps) && g.setup_steps.length > 0 && (
                    <details className="text-xs text-[#6b5d52]">
                      <summary className="cursor-pointer font-semibold text-[#3d3128] select-none">{t('pg.setupGuide')}</summary>
                      <ol className="list-decimal pl-4 space-y-0.5 mt-2 break-words">
                        {g.setup_steps.map((step: string, i: number) => <li key={i}>{step}</li>)}
                      </ol>
                    </details>
                  )}
                </div>

                {canEdit && (
                  <div className="flex gap-2 flex-wrap justify-between">
                    <button disabled={!dirty || !!busy} onClick={() => save(g)} className={`${btn} bg-[#1a1208] text-white hover:bg-black`}>{t('pg.saveChanges')}</button>
                    {g.connected && canDisconnect && <button disabled={!!busy} onClick={() => disconnect(g)} className={`${btn} text-red-700 hover:bg-red-50`}>{t('pg.disconnect')}</button>}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {tab === 'LINKS' && (
        <DataTable
          data={links}
          columns={linkColumns}
          rowKey={(l) => l.id}
          loading={linksLoading}
          emptyMessage={t('pg.links.empty')}
          exportFilename="payment-links"
          columnChooser
          columnFilters
          tableId="payment-links"
          toolbarLeft={
            <div className="flex gap-1.5 flex-wrap">
              {(['ALL', 'OPEN', 'PAID', 'NEEDS_REVIEW'] as LinkFilter[]).map(f => (
                <button key={f} onClick={() => setFilter(f)} className={`px-3 py-1.5 rounded-full text-xs font-bold ${filter === f ? 'bg-[#1a1208] text-white' : 'bg-[#faf7f2] text-[#3d3128]'}`}>
                  {t(`pg.links.filter.${f}`)}{f === 'NEEDS_REVIEW' && needsReview ? ` (${needsReview})` : ''}
                </button>
              ))}
            </div>
          }
          toolbarRight={<button onClick={loadLinks} className={`${btn} border border-[#e8dccf] bg-white`}><RefreshCw size={13} /> {t('pg.refresh')}</button>}
        />
      )}

      {tab === 'WEBHOOKS' && (
        <DataTable
          data={events || []}
          columns={eventColumns}
          rowKey={(e) => e.id}
          loading={events === null}
          emptyMessage={t('pg.events.empty')}
          exportFilename="payment-webhook-log"
          columnChooser
          columnFilters
          tableId="payment-webhook-log"
          toolbarRight={<button onClick={loadEvents} className={`${btn} border border-[#e8dccf] bg-white`}><RefreshCw size={13} /> {t('pg.refresh')}</button>}
        />
      )}

      {resolving && (
        <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/40 p-4" onClick={() => setResolving(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="pg-resolve-title" className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <h3 id="pg-resolve-title" className="text-lg font-bold text-[#1a1208]">{t('pg.resolve.title')}</h3>
              <button onClick={() => setResolving(null)} aria-label={t('common.close')} className="p-1.5 rounded-xl hover:bg-[#faf7f2] text-[#9c8e85]"><X size={16} /></button>
            </div>
            <div className="text-sm text-[#3d3128]">{money(resolving.amount)}{resolving.method ? ` · ${resolving.method}` : ''} · <span className="font-mono text-xs">{resolving.gateway_payment_id}</span></div>
            <div>
              <label className={label} htmlFor="pg-resolve-note">{t('pg.resolve.note')}</label>
              <textarea id="pg-resolve-note" rows={3} className={input} value={resolveNote} placeholder={t('pg.resolve.placeholder')} onChange={e => setResolveNote(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setResolving(null)} className={`${btn} border border-[#e8dccf]`}>{t('common.cancel')}</button>
              <button disabled={resolveNote.trim().length < 5 || busy === 'resolve'} onClick={submitResolve} className={`${btn} bg-[#cc5a16] text-white hover:bg-[#a84612]`}>{t('pg.action.resolve')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Collect online — from a guest folio, or (with `payable`) from an event booking
// ═════════════════════════════════════════════════════════════════════════════
export interface OnlinePayable {
  objectType: 'EVENT_BOOKING';
  objectId: string;
  outstanding: number;
  subtitle: string;
  presets?: { label: string; amount: number }[];
}

export function CollectOnlineDialog({ restaurantId, token, folio, payable, propertyName, onClose, onRecorded }: {
  restaurantId: string;
  token: string;
  folio: Json;
  payable?: OnlinePayable;
  propertyName?: string;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const api = useApi(restaurantId, token);
  const toast = useToast();
  const { t } = useT();
  const confirm = useConfirm();
  const objectType = payable?.objectType || 'HOTEL_FOLIO';
  const objectId = payable?.objectId || folio.id;
  const canCollect = canWriteTab(payable ? 'EVENTS_BOOKINGS' : 'FOLIOS');
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
      const out = await api(`/links?object_type=${objectType}&object_id=${encodeURIComponent(objectId)}&limit=20`);
      setLinks(out.links || []);
    } catch (e: any) { setNotice({ tone: 'error', text: e.message }); }
  }, [api, objectType, objectId]);

  useEffect(() => {
    (async () => {
      if (payable) {
        // The event panel already holds the balance; no folio to ask.
        setOutstanding(payable.outstanding);
        if (payable.outstanding > 0) setAmount(payable.outstanding.toFixed(2));
        return;
      }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        body: JSON.stringify({ object_type: objectType, object_id: objectId, amount, customer_phone: phone, customer_email: email, customer_name: folio.guest_name, expires_in_hours: Number(hours), channel }),
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
        toast.success(payable
          ? t('pg.collect.recordedBooking', { amount: money(out.link.amount_paid) })
          : `${money(out.link.amount_paid)} received online and recorded on the folio.`);
        onRecorded();
      }
      if (out.needs_review > 0) setNotice({ tone: 'warn', text: payable ? t('pg.collect.reviewBooking') : 'A payment arrived but could not be applied to this folio. See Payment Gateways → Needs review.' });
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
            <p className="text-xs text-[#6b5d52]">{payable ? payable.subtitle : `Folio ${folio.id}`}{outstanding != null ? ` · ${payable ? t('pg.collect.balanceDue', { amount: money(outstanding) }) : `balance due ${money(outstanding)}`}` : ''}</p>
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
                  {!!payable?.presets?.length && (
                    <div className="flex gap-1.5 flex-wrap mt-1.5">
                      {payable.presets.map(p => (
                        <button key={p.label} type="button" onClick={() => setAmount(p.amount.toFixed(2))}
                          className={`text-[10px] font-semibold px-2 py-1 rounded-lg border ${Math.abs(Number(amount) - p.amount) < 0.005 ? 'border-[#cc5a16] bg-[#cc5a16]/10 text-[#cc5a16]' : 'border-[#e8dccf] text-[#6b5d52] hover:bg-[#faf7f2]'}`}>
                          {p.label} · {money(p.amount)}
                        </button>
                      ))}
                    </div>
                  )}
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
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[#6b5d52]">{payable ? t('pg.collect.linksBooking') : 'Links for this folio'}</div>
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
                    <button onClick={() => copyText(l.url, toast, t('pg.toast.copied'), t('pg.toast.copyFailed'))} className={`${btn} py-1 border border-[#e8dccf] bg-white`}><Copy size={12} /> Copy</button>
                    <a href={waShareUrl(phone || l.customer_phone, linkMessage(l, propertyName))} target="_blank" rel="noreferrer" className={`${btn} py-1 border border-[#128c7e]/30 text-[#128c7e] bg-white`}><MessageCircle size={12} /> Share on WhatsApp</a>
                    {canCollect && <button disabled={!!busy || !email} onClick={() => send(l, 'EMAIL')} className={`${btn} py-1 border border-[#e8dccf] bg-white`}><Mail size={12} /> Email again</button>}
                  </div>
                )}
                {(l.payments || []).map((p: Json) => (
                  <div key={p.id} className="text-xs text-[#3d3128] flex items-center gap-1">
                    <CheckCircle2 size={12} className="text-emerald-600" /> {money(p.amount)} {p.method ? `by ${p.method}` : ''} · {when(p.paid_at)}
                    <span className={`ml-1 ${RECORD_STATUS_CLS[p.record_status] || ''}`}>{statusWord(t, 'pg.recordStatus', p.record_status)}</span>
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
        </div>
      </div>
    </div>
  );
}
