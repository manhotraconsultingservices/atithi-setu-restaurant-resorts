// ════════════════════════════════════════════════════════════════════════
// ObjectDetail — the reusable "object detail with tree menu" shell.
//
// Implements the mandatory CLAUDE.md convention: every business-document object
// (Sales Invoice / Folio, Quotation, Booking) opens into a left tree rail with
// three nodes — Overview, Audit History, Where Used. Each module drops its
// object's existing detail content in as `overview`; the shell fetches + renders
// Audit and Where-Used from the endpoints the module provides. Deep-links in
// Where-Used call `onOpenObject(objectType, objectId)` so navigation stays
// inside one shell across modules.
//
// This component is intentionally module-agnostic — do NOT fork it per module.
// ════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect } from 'react';
import { FileText, History, Link2, ChevronRight, ArrowLeft } from 'lucide-react';

type Node = 'OVERVIEW' | 'AUDIT' | 'WHERE_USED';

export interface ObjectDetailProps {
  title: string;
  subtitle?: string;
  statusPill?: React.ReactNode;
  onBack?: () => void;
  backLabel?: string;
  overview: React.ReactNode;
  token: string;
  /** Full API paths (relative to origin) returning the audit array / where-used groups. */
  auditUrl: string;
  whereUsedUrl: string;
  /** Called when a Where-Used item with a link is clicked. */
  onOpenObject?: (objectType: string, objectId: string) => void;
  /** Bump to force Audit/Where-Used to refetch (e.g. after an action on the object). */
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

// ── Audit History node ───────────────────────────────────────────────────────
function AuditView({ url, token, nonce }: { url: string; token: string; nonce?: number }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { setRows(null); setErr(''); apiGet(url, token).then(setRows).catch(e => setErr(e.message)); }, [url, nonce]);

  if (err) return <div className={CARD}><p className="text-sm text-rose-600">{err}</p></div>;
  if (!rows) return <div className={CARD}><p className="text-sm text-[#6b5d52]">Loading…</p></div>;
  if (rows.length === 0) return <div className={CARD}><p className="text-sm text-[#9d8b7e]">No audit history yet.</p></div>;

  return (
    <div className={CARD}>
      <div className="relative pl-5">
        <div className="absolute left-1.5 top-1 bottom-1 w-px bg-[#e8dccf]" />
        {rows.map((r: any) => {
          const hasDiff = r.before_json || r.after_json;
          return (
            <div key={r.id} className="relative pb-4 last:pb-0">
              <div className="absolute -left-[13px] top-1 w-2.5 h-2.5 rounded-full bg-[#cc5a16] border-2 border-white" />
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-bold text-[#14110c]">{r.action}</span>
                <span className="text-[10px] text-[#9d8b7e] whitespace-nowrap">{timeAgo(r.created_at)}</span>
              </div>
              {r.summary && <div className="text-xs text-[#3d3128] mt-0.5">{r.summary}</div>}
              <div className="text-[10px] text-[#9d8b7e] mt-0.5">{r.actor_email || 'system'}{r.actor_role ? ` · ${r.actor_role}` : ''}</div>
              {hasDiff && (
                <button className="text-[10px] text-[#cc5a16] font-semibold mt-1" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  {open === r.id ? 'Hide changes' : 'View changes'}
                </button>
              )}
              {open === r.id && hasDiff && (
                <pre className="mt-1 p-2 rounded-lg bg-[#faf7f2] border border-[#e8dccf] text-[10px] overflow-x-auto whitespace-pre-wrap">
                  {r.before_json ? `before: ${r.before_json}\n` : ''}{r.after_json ? `after:  ${r.after_json}` : ''}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Where Used node ──────────────────────────────────────────────────────────
function WhereUsedView({ url, token, onOpenObject, nonce }: { url: string; token: string; onOpenObject?: (t: string, i: string) => void; nonce?: number }) {
  const [data, setData] = useState<any | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { setData(null); setErr(''); apiGet(url, token).then(setData).catch(e => setErr(e.message)); }, [url, nonce]);

  if (err) return <div className={CARD}><p className="text-sm text-rose-600">{err}</p></div>;
  if (!data) return <div className={CARD}><p className="text-sm text-[#6b5d52]">Loading…</p></div>;
  const groups = data.groups || [];
  if (groups.length === 0) return <div className={CARD}><p className="text-sm text-[#9d8b7e]">Not referenced anywhere yet.</p></div>;

  return (
    <div className="space-y-3">
      {groups.map((g: any, gi: number) => (
        <div key={gi} className={CARD}>
          <h3 className="text-xs font-bold text-[#6b5d52] uppercase tracking-wide mb-2">{g.group}</h3>
          <div className="space-y-1">
            {(g.items || []).map((it: any, ii: number) => {
              const clickable = it.link && onOpenObject;
              return (
                <button
                  key={ii}
                  disabled={!clickable}
                  onClick={() => clickable && onOpenObject!(it.link.objectType, it.link.objectId)}
                  className={`w-full text-left flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-xl border ${clickable ? 'border-[#e8dccf] hover:bg-[#faf7f2] cursor-pointer' : 'border-transparent cursor-default'}`}
                >
                  <span className="min-w-0">
                    <span className="text-xs font-semibold text-[#14110c]">{it.label}</span>
                    {it.sublabel && <span className="block text-[10px] text-[#9d8b7e] truncate">{it.sublabel}</span>}
                  </span>
                  {clickable && <ChevronRight size={14} className="text-[#cc5a16] shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Shell ────────────────────────────────────────────────────────────────────
export function ObjectDetail(props: ObjectDetailProps) {
  const { title, subtitle, statusPill, onBack, backLabel, overview, token, auditUrl, whereUsedUrl, onOpenObject, refreshNonce } = props;
  const [node, setNode] = useState<Node>('OVERVIEW');

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
      <div className="flex items-center justify-between mb-4">
        {onBack ? <button className="px-3 py-2 rounded-xl text-xs font-bold bg-[#faf7f2] border border-[#e8dccf] text-[#3d3128] hover:bg-[#f0e9df] flex items-center gap-1.5" onClick={onBack}><ArrowLeft size={14} />{backLabel || 'Back'}</button> : <span />}
        {statusPill}
      </div>

      <div className="mb-4">
        <h2 className="text-xl font-bold font-serif text-[#14110c]">{title}</h2>
        {subtitle && <p className="text-xs text-[#6b5d52]">{subtitle}</p>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-4">
        {/* Tree rail */}
        <nav className="md:sticky md:top-4 self-start bg-white rounded-2xl border border-[#e8dccf] p-2 space-y-1">
          {railItem('OVERVIEW', <FileText size={15} />, 'Overview')}
          {railItem('AUDIT', <History size={15} />, 'Audit History')}
          {railItem('WHERE_USED', <Link2 size={15} />, 'Where Used')}
        </nav>

        {/* Node content */}
        <div className="min-w-0">
          {node === 'OVERVIEW' && overview}
          {node === 'AUDIT' && <AuditView url={auditUrl} token={token} nonce={refreshNonce} />}
          {node === 'WHERE_USED' && <WhereUsedView url={whereUsedUrl} token={token} onOpenObject={onOpenObject} nonce={refreshNonce} />}
        </div>
      </div>
    </div>
  );
}
