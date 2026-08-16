// ════════════════════════════════════════════════════════════════════════
// ObjectDetail — the reusable "object detail with tree menu" shell.
//
// Implements the mandatory CLAUDE.md convention: every business-document object
// (Sales Invoice / Folio, Quotation, Booking, Room, Checklist) opens into a left
// tree rail — Overview, Audit log, Checklist (optional), Where Used. Each module
// drops its object's detail content in as `overview`; the shell fetches + renders
// the other nodes from the endpoints the module provides.
//
// Two behaviours are load-bearing here:
//   1. Every list node (Audit / Checklist / Where-Used) is a SMART TABLE
//      (sortable, per-column filters, gear column chooser, search, CSV) via the
//      shared DataTable — no bespoke lists.
//   2. Where-Used hyperlinks DRILL IN-PLACE. Clicking one resolves the linked
//      object (via `resolveLink`) and pushes it onto an internal stack rendered
//      in the SAME frame with a Back button — never a new pop-up. Falls back to
//      the legacy `onOpenObject` callback when no resolver is supplied.
//
// This component is intentionally module-agnostic — do NOT fork it per module.
// ════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect } from 'react';
import { FileText, History, Link2, ListChecks, ChevronRight, ArrowLeft } from 'lucide-react';
import { DataTable, type ColDef } from './DataTable';

type Node = 'OVERVIEW' | 'AUDIT' | 'CHECKLIST' | 'WHERE_USED';

/** Hint carried from a Where-Used row into the resolver so a drilled object can
 *  show a sensible title/subtitle even before (or without) a fetch. */
export interface LinkHint { label?: string; subtitle?: string }

export interface ObjectDetailProps {
  title: string;
  subtitle?: string;
  statusPill?: React.ReactNode;
  onBack?: () => void;
  backLabel?: string;
  overview: React.ReactNode;
  /** Label for the first (overview) rail node. Defaults to "Overview". */
  overviewLabel?: string;
  token: string;
  /** Full API paths (relative to origin) returning the audit array / where-used groups. */
  auditUrl: string;
  whereUsedUrl: string;
  /** Optional: full API path returning { jobs: [...] } — enables the Checklist node. */
  checklistUrl?: string;
  /** Legacy: called when a Where-Used item with a link is clicked and no `resolveLink` is set. */
  onOpenObject?: (objectType: string, objectId: string) => void;
  /** Preferred: resolve a Where-Used link into a child detail rendered in the same frame. */
  resolveLink?: (objectType: string, objectId: string, hint?: LinkHint) => ObjectDetailProps | Promise<ObjectDetailProps | null> | null;
  /** Bump to force Audit/Where-Used/Checklist to refetch (e.g. after an action on the object). */
  refreshNonce?: number;
}

const CARD = 'bg-white rounded-2xl border border-[#e8dccf] p-5';
const RAIL_BTN = 'w-full text-left px-3 py-2 rounded-xl text-sm font-semibold flex items-center gap-2 transition-colors';

async function apiGet(url: string, token: string) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((b && b.error) || `HTTP ${r.status}`);
  return b;
}

function timeAgo(iso: string): string {
  return String(iso || '').replace('T', ' ').slice(0, 16);
}

// ── Audit change diff — render before/after as a readable field-wise table
// (Field · Before · After) instead of a raw single-line JSON blob. Falls back to
// pretty-printed JSON when the payload isn't a plain object. ──────────────────
const auditPrettyKey = (k: string): string => k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const auditFmtVal = (v: any): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
};
function AuditChangeDiff({ beforeJson, afterJson }: { beforeJson?: string; afterJson?: string }) {
  const isObj = (o: any) => !!o && typeof o === 'object' && !Array.isArray(o);
  let before: any = null, after: any = null, parseFail = false;
  try { before = beforeJson ? JSON.parse(beforeJson) : null; } catch { parseFail = true; }
  try { after = afterJson ? JSON.parse(afterJson) : null; } catch { parseFail = true; }
  if (parseFail || (!isObj(before) && !isObj(after))) {
    const pretty = (s?: string) => { if (!s) return ''; try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };
    return (
      <pre className="p-2 rounded-lg bg-[#faf7f2] border border-[#e8dccf] text-[10px] overflow-x-auto whitespace-pre-wrap">{beforeJson ? `before:\n${pretty(beforeJson)}${afterJson ? '\n\n' : ''}` : ''}{afterJson ? `after:\n${pretty(afterJson)}` : ''}</pre>
    );
  }
  const b = before || {}, a = after || {};
  const bothPresent = isObj(before) && isObj(after);
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)])).sort();
  const rows = keys.filter(k => !bothPresent || JSON.stringify(b[k]) !== JSON.stringify(a[k]));
  if (rows.length === 0) return <div className="text-[11px] text-[#9d8b7e] px-2 py-1.5">No field-level changes.</div>;
  const valueHeader = bothPresent ? 'After' : (isObj(after) ? 'Value' : 'Removed value');
  return (
    <div className="p-2 rounded-lg bg-[#faf7f2] border border-[#e8dccf] overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead><tr className="text-left text-[#9d8b7e] border-b border-[#e8dccf]">
          <th className="py-1 pr-4 font-semibold">Field</th>
          {bothPresent && <th className="py-1 pr-4 font-semibold">Before</th>}
          <th className="py-1 pr-4 font-semibold">{valueHeader}</th>
        </tr></thead>
        <tbody>
          {rows.map(k => (
            <tr key={k} className="border-b border-[#f4efe8] align-top">
              <td className="py-1 pr-4 font-medium text-[#3d3128] whitespace-nowrap">{auditPrettyKey(k)}</td>
              {bothPresent && <td className="py-1 pr-4 text-rose-600 break-all">{auditFmtVal(b[k])}</td>}
              <td className="py-1 pr-4 text-emerald-700 break-all">{auditFmtVal(bothPresent ? a[k] : (isObj(after) ? a[k] : b[k]))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Audit log node (smart table) ─────────────────────────────────────────────
function AuditView({ url, token, nonce }: { url: string; token: string; nonce?: number }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    setRows(null); setErr(''); setOpenId(null);
    apiGet(url, token).then((r) => setRows(Array.isArray(r) ? r : (r?.rows || []))).catch(e => setErr(e.message));
  }, [url, nonce]);

  if (err) return <div className={CARD}><p className="text-sm text-rose-600">{err}</p></div>;

  const columns: ColDef<any>[] = [
    { key: 'when', label: 'When', sortable: true, getValue: r => r.created_at || '', render: r => <span className="text-[11px] text-[#6b5d52] whitespace-nowrap">{timeAgo(r.created_at)}</span> },
    { key: 'action', label: 'Action', sortable: true, filterable: true, filterType: 'select', getValue: r => r.action || '', render: r => <span className="text-xs font-bold text-[#14110c]">{r.action}</span> },
    { key: 'summary', label: 'Details', sortable: true, searchable: true, getValue: r => r.summary || '', render: r => <span className="text-xs text-[#3d3128]">{r.summary || '—'}</span> },
    { key: 'actor', label: 'By', sortable: true, filterable: true, filterType: 'text', getValue: r => r.actor_email || 'system', render: r => <span className="text-[11px] text-[#6b5d52]">{r.actor_email || 'system'}{r.actor_role ? ` · ${r.actor_role}` : ''}</span> },
    { key: 'changes', label: 'Changes', searchable: false, noExport: true, render: r => (r.before_json || r.after_json) ? <button className="text-[11px] text-[#cc5a16] font-semibold" onClick={() => setOpenId(openId === r.id ? null : r.id)}>{openId === r.id ? 'Hide' : 'View'}</button> : <span className="text-[#c9bcae]">—</span> },
  ];

  return (
    <DataTable
      data={rows || []} columns={columns} rowKey={(r, i) => r.id || i} loading={rows === null}
      compact columnChooser columnFilters tableId="od-audit"
      searchPlaceholder="Search audit…" exportFilename="audit-log" emptyMessage="No audit history yet."
      isExpanded={(r) => openId === r.id}
      renderExpanded={(r) => (r.before_json || r.after_json) ? (
        <pre className="p-2 rounded-lg bg-[#faf7f2] border border-[#e8dccf] text-[10px] overflow-x-auto whitespace-pre-wrap">{r.before_json ? `before: ${r.before_json}\n` : ''}{r.after_json ? `after:  ${r.after_json}` : ''}</pre>
      ) : null}
    />
  );
}

// ── Checklist node (smart table — one row per task, across all jobs) ──────────
function ChecklistView({ url, token, nonce }: { url: string; token: string; nonce?: number }) {
  const [data, setData] = useState<any | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { setData(null); setErr(''); apiGet(url, token).then(setData).catch(e => setErr(e.message)); }, [url, nonce]);

  if (err) return <div className={CARD}><p className="text-sm text-rose-600">{err}</p></div>;

  const jobs = data?.jobs || [];
  const rows = jobs.flatMap((j: any) => {
    const tasks = j.tasks || [];
    const jobName = j.template_name || j.trigger_event || 'Checklist';
    const blocks = Number(j.blocks_release) === 1;
    if (!tasks.length) return [{ _k: `${j.id}:none`, checklist: jobName, blocks, task: '(no tasks)', required: '', status: String(j.status || 'OPEN').toUpperCase() === 'DONE' ? 'Done' : 'Pending', remark: '' }];
    return tasks.map((t: any) => ({
      _k: `${j.id}:${t.id}`, checklist: jobName, blocks,
      task: t.label, required: Number(t.is_mandatory) === 1 ? 'Required' : 'Optional',
      status: Number(t.is_done) === 1 ? 'Done' : 'Pending', remark: t.remark || '',
    }));
  });

  const badge = (txt: string, cls: string) => <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${cls}`}>{txt}</span>;
  const columns: ColDef<any>[] = [
    { key: 'checklist', label: 'Checklist', sortable: true, filterable: true, filterType: 'select', getValue: r => r.checklist, render: r => <span className="inline-flex items-center gap-1.5"><span className="font-semibold text-[#14110c]">{r.checklist}</span>{r.blocks && badge('blocks', 'bg-rose-50 text-rose-600')}</span> },
    { key: 'task', label: 'Task', sortable: true, searchable: true, getValue: r => r.task },
    { key: 'required', label: 'Required', sortable: true, align: 'center', filterable: true, filterType: 'select', getValue: r => r.required, render: r => r.required ? badge(r.required, r.required === 'Required' ? 'bg-rose-50 text-rose-600' : 'bg-[#f0e9df] text-[#6b5d52]') : <span className="text-[#c9bcae]">—</span> },
    { key: 'status', label: 'Status', sortable: true, align: 'center', filterable: true, filterType: 'select', getValue: r => r.status, render: r => badge(r.status, r.status === 'Done' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700') },
    { key: 'remark', label: 'Remark', searchable: true, getValue: r => r.remark, render: r => r.remark ? <span className="text-xs text-[#3d3128] italic">“{r.remark}”</span> : <span className="text-[#c9bcae]">—</span> },
  ];

  return (
    <DataTable
      data={rows} columns={columns} rowKey={(r) => r._k} loading={data === null}
      compact columnChooser columnFilters tableId="od-checklist"
      searchPlaceholder="Search tasks…" exportFilename="checklist" emptyMessage="No checklists raised yet."
    />
  );
}

// ── Where Used node (smart table — flat across all groups; links drill in) ────
function WhereUsedView({ url, token, onOpen, nonce }: { url: string; token: string; onOpen: (t: string, i: string, hint?: LinkHint) => void; nonce?: number }) {
  const [data, setData] = useState<any | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { setData(null); setErr(''); apiGet(url, token).then(setData).catch(e => setErr(e.message)); }, [url, nonce]);

  if (err) return <div className={CARD}><p className="text-sm text-rose-600">{err}</p></div>;

  const groups = data?.groups || [];
  const rows = groups.flatMap((g: any, gi: number) => (g.items || []).map((it: any, ii: number) => ({
    _k: `${gi}:${ii}`, group: g.group, type: it.type || '', label: it.label, sublabel: it.sublabel || '', link: it.link || null,
  })));

  const columns: ColDef<any>[] = [
    { key: 'group', label: 'Group', sortable: true, filterable: true, filterType: 'select', getValue: r => r.group },
    {
      key: 'label', label: 'Reference', sortable: true, searchable: true, getValue: r => r.label,
      render: r => r.link
        ? <button onClick={() => onOpen(r.link.objectType, r.link.objectId, { label: r.label, subtitle: r.sublabel })} className="font-semibold text-blue-600 hover:text-blue-800 hover:underline text-left inline-flex items-center gap-1">{r.label}<ChevronRight size={12} className="shrink-0" /></button>
        : <span className="font-semibold text-[#14110c]">{r.label}</span>,
    },
    { key: 'sublabel', label: 'Detail', sortable: true, searchable: true, getValue: r => r.sublabel, render: r => r.sublabel ? <span className="text-[11px] text-[#6b5d52]">{r.sublabel}</span> : <span className="text-[#c9bcae]">—</span> },
    { key: 'type', label: 'Type', sortable: true, filterable: true, filterType: 'select', getValue: r => r.type },
  ];

  return (
    <DataTable
      data={rows} columns={columns} rowKey={(r) => r._k} loading={data === null}
      compact columnChooser columnFilters tableId="od-whereused"
      searchPlaceholder="Search related…" exportFilename="where-used" emptyMessage="Not referenced anywhere yet."
    />
  );
}

// ── Shared link resolver factory ─────────────────────────────────────────────
// Builds a `resolveLink` for the hotel/events object graph so Where-Used links
// drill in the same frame. Reused by App.tsx (room/booking) and the checklist
// detail. Returns null for types it doesn't own → the shell falls back to
// `onOpenObject` (e.g. FOLIO → open the folio page).
export function buildObjectResolver(restaurantId: string, token: string) {
  const base = `/api/restaurant/${restaurantId}`;
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const facts = (typeLabel: string, objectId: string, extra: [string, any][] = []): React.ReactNode => (
    <div className={CARD}>
      <div className="grid grid-cols-2 gap-3 text-[12px]">
        {([['Type', typeLabel], ['Reference', objectId], ...extra] as [string, any][]).map(([k, v], i) => (
          <div key={i}><span className="text-[#9c8e85]">{k}</span><div className="font-semibold text-[#14110c] break-words">{v == null || v === '' ? '—' : String(v)}</div></div>
        ))}
      </div>
    </div>
  );
  const mk = (o: { title: string; subtitle?: string; auditUrl: string; whereUsedUrl: string; checklistUrl?: string; overview: React.ReactNode }): ObjectDetailProps => ({ token, backLabel: 'Back', ...o });

  return async (objectType: string, objectId: string, hint?: LinkHint): Promise<ObjectDetailProps | null> => {
    switch (objectType) {
      case 'ROOM_BOOKING': {
        let b: any = {};
        try { const r = await fetch(`${base}/hotel/bookings/${objectId}`, auth); if (r.ok) { const j = await r.json(); b = j?.booking || j || {}; } } catch { /* best-effort */ }
        return mk({
          title: b.guest_name || hint?.label || objectId,
          subtitle: [objectId, b.guest_phone].filter(Boolean).join(' · ') || hint?.subtitle,
          auditUrl: `${base}/hotel/bookings/${objectId}/audit`,
          whereUsedUrl: `${base}/hotel/bookings/${objectId}/where-used`,
          checklistUrl: `${base}/hotel/bookings/${objectId}/checklist`,
          overview: facts('Room booking', objectId, [
            ['Guest', b.guest_name], ['Status', b.status], ['Room', b.room_name || b.room_id],
            ['Check-in', String(b.check_in_date || '').slice(0, 10)], ['Check-out', String(b.check_out_date || '').slice(0, 10)],
            ['Total', b.total_amount != null ? `₹${Number(b.total_amount).toLocaleString('en-IN')}` : null],
          ]),
        });
      }
      case 'ROOM':
        return mk({
          title: hint?.label || `Room ${objectId}`, subtitle: hint?.subtitle || 'Room',
          auditUrl: `${base}/hotel/rooms/${objectId}/audit`,
          whereUsedUrl: `${base}/hotel/rooms/${objectId}/where-used`,
          checklistUrl: `${base}/hotel/rooms/${objectId}/checklist`,
          overview: facts('Room', objectId, [['Room', hint?.label]]),
        });
      case 'EVENT_BOOKING':
        return mk({
          title: hint?.label || objectId, subtitle: hint?.subtitle || 'Event booking',
          auditUrl: `${base}/events/bookings/${objectId}/audit`,
          whereUsedUrl: `${base}/events/bookings/${objectId}/where-used`,
          overview: facts('Event booking', objectId),
        });
      case 'EVENT_QUOTATION':
        return mk({
          title: hint?.label || objectId, subtitle: hint?.subtitle || 'Quotation',
          auditUrl: `${base}/events/quotations/${objectId}/audit`,
          whereUsedUrl: `${base}/events/quotations/${objectId}/where-used`,
          overview: facts('Quotation', objectId),
        });
      case 'FOLIO': {
        let f: any = {};
        try { const r = await fetch(`${base}/hotel/folios/${objectId}/outstanding`, auth); if (r.ok) { const j = await r.json(); f = j?.folio || j || {}; } } catch { /* best-effort */ }
        return mk({
          title: f.invoice_number || hint?.label || objectId,
          subtitle: hint?.subtitle || [f.doc_type, f.status].filter(Boolean).join(' · ') || 'Invoice / Folio',
          auditUrl: `${base}/hotel/folios/${objectId}/audit`,
          whereUsedUrl: `${base}/hotel/folios/${objectId}/where-used`,
          overview: facts('Invoice / Folio', objectId, [
            ['Invoice #', f.invoice_number], ['Status', f.status], ['Doc type', f.doc_type],
            ['Grand total', f.grand_total != null ? `₹${Number(f.grand_total).toLocaleString('en-IN')}` : null],
            ['Outstanding', f.outstanding != null ? `₹${Number(f.outstanding).toLocaleString('en-IN')}` : null],
          ]),
        });
      }
      default:
        return null; // unknown types → shell falls back to onOpenObject
    }
  };
}

// ── Shell ────────────────────────────────────────────────────────────────────
export function ObjectDetail(rootProps: ObjectDetailProps) {
  // Internal drill-down stack: root at the bottom, each Where-Used drill pushes.
  const [stack, setStack] = useState<ObjectDetailProps[]>([]);
  const [node, setNode] = useState<Node>('OVERVIEW');
  const [resolving, setResolving] = useState(false);
  const cur = stack.length ? stack[stack.length - 1] : rootProps;

  // Reset to Overview whenever we move between root and this specific frame.
  // (Audit/Where-Used/Checklist refetch on their own url change.)
  useEffect(() => { setNode('OVERVIEW'); }, [stack.length, rootProps.auditUrl]);

  const openLink = async (objectType: string, objectId: string, hint?: LinkHint) => {
    if (rootProps.resolveLink) {
      setResolving(true);
      try {
        const child = await rootProps.resolveLink(objectType, objectId, hint);
        if (child) { setStack(s => [...s, child]); if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
      } catch { /* fall through to legacy */ }
      finally { setResolving(false); }
    }
    (cur.onOpenObject || rootProps.onOpenObject)?.(objectType, objectId);
  };

  const goBack = () => {
    if (stack.length) setStack(s => s.slice(0, -1));
    else rootProps.onBack?.();
  };
  const prevTitle = stack.length ? (stack.length > 1 ? stack[stack.length - 2].title : rootProps.title) : null;
  const backLabel = stack.length ? `Back to ${prevTitle}` : (rootProps.backLabel || 'Back');
  const canBack = stack.length > 0 || !!rootProps.onBack;

  const railItem = (key: Node, icon: React.ReactNode, label: string) => (
    <button
      onClick={() => setNode(key)}
      className={`${RAIL_BTN} ${node === key ? 'bg-[#cc5a16] text-white' : 'text-[#3d3128] hover:bg-[#f0e9df]'}`}
    >
      {icon}{label}
    </button>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3">
        {canBack ? <button className="px-3 py-2 rounded-xl text-xs font-bold bg-[#faf7f2] border border-[#e8dccf] text-[#3d3128] hover:bg-[#f0e9df] flex items-center gap-1.5 min-w-0" onClick={goBack}><ArrowLeft size={14} className="shrink-0" /><span className="truncate max-w-[220px]">{backLabel}</span></button> : <span />}
        {cur.statusPill}
      </div>

      <div className="mb-4">
        <h2 className="text-xl font-bold font-serif text-[#14110c]">{cur.title}</h2>
        {cur.subtitle && <p className="text-xs text-[#6b5d52]">{cur.subtitle}</p>}
        {resolving && <p className="text-[11px] text-[#cc5a16] mt-1">Opening…</p>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-4">
        {/* Tree rail */}
        <nav className="md:sticky md:top-4 self-start bg-white rounded-2xl border border-[#e8dccf] p-2 space-y-1">
          {railItem('OVERVIEW', <FileText size={15} />, cur.overviewLabel || 'Overview')}
          {railItem('AUDIT', <History size={15} />, 'Audit log')}
          {cur.checklistUrl && railItem('CHECKLIST', <ListChecks size={15} />, 'Checklist')}
          {railItem('WHERE_USED', <Link2 size={15} />, 'Where Used')}
        </nav>

        {/* Node content */}
        <div className="min-w-0">
          {node === 'OVERVIEW' && cur.overview}
          {node === 'AUDIT' && <AuditView url={cur.auditUrl} token={cur.token} nonce={cur.refreshNonce} />}
          {node === 'CHECKLIST' && cur.checklistUrl && <ChecklistView url={cur.checklistUrl} token={cur.token} nonce={cur.refreshNonce} />}
          {node === 'WHERE_USED' && <WhereUsedView url={cur.whereUsedUrl} token={cur.token} onOpen={openLink} nonce={cur.refreshNonce} />}
        </div>
      </div>
    </div>
  );
}
