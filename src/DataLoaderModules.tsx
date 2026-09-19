// Super-admin Data Loader — the Ayurvedic & Spa and Events modules, beside the
// hotel bookings loader in App.tsx. Each lists the tenant's records, deletes the
// selected ones (the server skips anything billed or carrying business / clinical
// records and says why), and imports from CSV with a review step. Events import
// reuses the Events migration engine rather than a second copy of it.
import React, { useEffect, useRef, useState } from 'react';
import { Trash2, Upload, Download, RefreshCw } from 'lucide-react';
import { EventMigration } from './EventViews';

const CARD = 'bg-white rounded-[32px] border border-brand/10 shadow-sm p-6';
const BTN = 'px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors disabled:opacity-40';
const PAGE = 250;

function parseCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out.map(s => s.trim());
}
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const head = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));
  return lines.slice(1).map(l => { const v = parseCsvLine(l); const r: Record<string, string> = {}; head.forEach((h, i) => { r[h] = v[i] ?? ''; }); return r; });
}
function download(name: string, text: string) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; a.click();
}
const d10 = (v: any) => (v ? String(v).replace('T', ' ').slice(0, 16) : '—');
const inr = (v: any) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

type Col = { key: string; label: string; render?: (r: any) => React.ReactNode };

// List + select + guarded delete, shared by both modules.
function RecordList({ tenantId, token, path, noun, cols }: { tenantId: string; token: string; path: string; noun: string; cols: Col[] }) {
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ ok: boolean; text: string; skipped?: any[] } | null>(null);
  const load = async (p = page) => {
    setLoading(true); setSel(new Set());
    try {
      const r = await fetch(`/api/admin/data-migration/${path}?tenantId=${encodeURIComponent(tenantId)}&page=${p}&limit=${PAGE}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      setRows(d.rows || []); setTotal(Number(d.total || 0)); setPage(d.page || p); setMissing(!!d.module_missing);
    } catch { setRows([]); setTotal(0); } finally { setLoading(false); }
  };
  useEffect(() => { setMsg(null); load(1); }, [tenantId, path]);
  const del = async () => {
    if (!sel.size) return;
    if (!window.confirm(`Permanently delete ${sel.size} ${noun}(s)?\n\nAnything billed, paid for, or carrying records the property must keep is skipped automatically and listed. This cannot be undone.`)) return;
    try {
      const r = await fetch(`/api/admin/data-migration/${path}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ tenantId, ids: [...sel] }) });
      const d = await r.json();
      if (!r.ok) setMsg({ ok: false, text: d.error || 'Delete failed' });
      else setMsg({ ok: true, text: `Deleted ${d.deleted}. ${d.skipped?.length ? `Skipped ${d.skipped.length}:` : ''}`, skipped: d.skipped || [] });
      await load(page);
    } catch { setMsg({ ok: false, text: 'Network error' }); }
  };
  const pages = Math.max(1, Math.ceil(total / PAGE));
  return (
    <div className={CARD}>
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <h3 className="text-lg font-bold">{noun[0].toUpperCase() + noun.slice(1)}s {!loading && <span className="text-sm font-normal text-[#9c8e85]">({rows.length} of {total} total)</span>}</h3>
        <div className="flex items-center gap-2">
          {total > PAGE && <>
            <button className={`${BTN} bg-[#faf7f2] border-[#e8dccf]`} disabled={page <= 1} onClick={() => load(page - 1)}>‹</button>
            <span className="text-xs tabular-nums">p.{page} / {pages}</span>
            <button className={`${BTN} bg-[#faf7f2] border-[#e8dccf]`} disabled={page >= pages} onClick={() => load(page + 1)}>›</button>
          </>}
          <button className={`${BTN} bg-[#faf7f2] border-[#e8dccf] text-[#6b5d52]`} disabled={loading} onClick={() => load(page)}><RefreshCw size={12} className="inline mr-1" />{loading ? 'Loading…' : 'Refresh'}</button>
          {sel.size > 0 && <button onClick={del} className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-red-600 text-white text-sm font-bold hover:bg-red-700"><Trash2 size={14} /> Delete {sel.size} selected</button>}
        </div>
      </div>
      {msg && (
        <div className={`mb-4 px-4 py-2 rounded-xl text-sm ${msg.ok ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          <div className="flex items-center gap-2"><span className="flex-1">{msg.text}</span><button onClick={() => setMsg(null)} className="font-bold">×</button></div>
          {!!msg.skipped?.length && <ul className="mt-1 text-xs text-amber-800 list-disc pl-5 max-h-32 overflow-y-auto">{msg.skipped.map((s: any) => <li key={s.id}><span className="font-mono">{s.id}</span> — {s.reason}</li>)}</ul>}
        </div>
      )}
      {missing ? <div className="py-10 text-center text-[#9c8e85] italic">This module is not set up for this tenant yet.</div>
        : loading ? <div className="flex justify-center py-10"><div className="w-8 h-8 border-2 border-brand/30 border-t-brand rounded-full animate-spin" /></div>
        : rows.length === 0 ? <div className="py-10 text-center text-[#9c8e85] italic">No {noun}s found for this tenant.</div>
        : (
          <div className="overflow-x-auto rounded-2xl border border-[#e8dccf] max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 bg-[#faf7f2]">
                <tr className="text-left text-[11px] uppercase text-[#6b5d52]">
                  <th className="p-2"><input type="checkbox" checked={sel.size === rows.length} onChange={e => setSel(e.target.checked ? new Set(rows.map(r => r.id)) : new Set())} /></th>
                  {cols.map(c => <th key={c.key} className="p-2 whitespace-nowrap">{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className="border-t border-[#f0ebe4] hover:bg-[#fdfbf8]">
                    <td className="p-2"><input type="checkbox" checked={sel.has(r.id)} onChange={e => { const n = new Set(sel); e.target.checked ? n.add(r.id) : n.delete(r.id); setSel(n); }} /></td>
                    {cols.map(c => <td key={c.key} className="p-2 whitespace-nowrap text-xs">{c.render ? c.render(r) : (r[c.key] ?? '—')}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

const SPA_TEMPLATE = 'client_name,client_phone,client_email,service,date,time,duration_min,therapist,status,price,notes\n' +
  'Anita Rao,9876543210,anita@example.com,Abhyanga Massage,2026-08-14,10:30,60,Meera,COMPLETED,2500,Migrated from old system\n';

function SpaImport({ tenantId, token }: { tenantId: string; token: string }) {
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const file = useRef<HTMLInputElement>(null);
  const onFile = async (f: File) => {
    setErr(''); setResult(null);
    const parsed = parseCsv(await f.text());
    if (!parsed.length) { setErr('The file has no rows. Use the template: a header row, then one appointment per row.'); return; }
    const need = ['client_name', 'service'];
    const miss = need.filter(k => !(k in parsed[0]) && !(k === 'service' && ('service_name' in parsed[0] || 'service_id' in parsed[0])));
    if (miss.length) { setErr(`Missing column(s): ${miss.join(', ')}. Download the template to see every column.`); return; }
    setRows(parsed);
  };
  const run = async () => {
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/admin/data-migration/spa-appointments/import', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ tenantId, rows }) });
      const d = await r.json();
      if (!r.ok) setErr(d.error || 'Import failed'); else { setResult(d); setRows([]); }
    } catch { setErr('Network error'); } finally { setBusy(false); }
  };
  return (
    <div className={CARD}>
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <h3 className="text-lg font-bold flex items-center gap-2"><Upload size={18} className="text-brand" /> CSV Import — appointments</h3>
        <button className={`${BTN} bg-[#faf7f2] border-[#e8dccf] text-[#6b5d52]`} onClick={() => download('spa-appointments-template.csv', SPA_TEMPLATE)}><Download size={12} className="inline mr-1" />Template</button>
      </div>
      <p className="text-xs text-[#6b5d52] mb-3">One appointment per row. <b>service</b> must match a treatment on the menu by name; <b>therapist</b> (optional) by display name. <b>date</b> is YYYY-MM-DD and <b>time</b> HH:MM. Status defaults to COMPLETED, price and GST to the menu&apos;s. Imported rows are marked source MIGRATION and raise no bill.</p>
      {err && <div className="mb-3 px-4 py-2 rounded-xl text-sm bg-red-50 text-red-700 border border-red-200">{err}</div>}
      {!rows.length && !result && (
        <button onClick={() => file.current?.click()} className="w-full border-2 border-dashed border-[#e8dccf] rounded-2xl py-8 text-sm font-semibold text-[#6b5d52] hover:border-brand/50">Click to upload CSV file</button>
      )}
      <input ref={file} type="file" accept=".csv,text/csv" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      {rows.length > 0 && (
        <>
          <p className="text-sm mb-2"><b>Step 1 — review:</b> {rows.length} row(s) read. Check the first rows, then import.</p>
          <div className="overflow-x-auto rounded-2xl border border-[#e8dccf] max-h-64 overflow-y-auto mb-3">
            <table className="w-full text-xs"><thead className="bg-[#faf7f2] sticky top-0"><tr>{Object.keys(rows[0]).map(k => <th key={k} className="p-2 text-left">{k}</th>)}</tr></thead>
              <tbody>{rows.slice(0, 50).map((r, i) => <tr key={i} className="border-t border-[#f0ebe4]">{Object.keys(rows[0]).map(k => <td key={k} className="p-2 whitespace-nowrap">{r[k]}</td>)}</tr>)}</tbody></table>
          </div>
          <div className="flex gap-2">
            <button disabled={busy} onClick={run} className="px-4 py-2 rounded-xl bg-brand text-white text-sm font-bold disabled:opacity-50">{busy ? 'Importing…' : `Step 2 — import ${rows.length} appointment(s)`}</button>
            <button onClick={() => setRows([])} className={`${BTN} bg-[#faf7f2] border-[#e8dccf]`}>Cancel</button>
          </div>
        </>
      )}
      {result && (
        <div className="mt-2 text-sm">
          <p className="font-bold text-emerald-700">Imported {result.succeeded} of {result.total}. {result.failed ? <span className="text-red-700">{result.failed} failed:</span> : null}</p>
          {result.failed > 0 && <ul className="text-xs text-red-700 list-disc pl-5 max-h-40 overflow-y-auto">{result.results.filter((x: any) => x.error).map((x: any) => <li key={x.index}>Row {x.index + 2}: {x.error}</li>)}</ul>}
          <button onClick={() => setResult(null)} className={`${BTN} mt-2 bg-[#faf7f2] border-[#e8dccf]`}>Import another file</button>
        </div>
      )}
    </div>
  );
}

export function DataLoaderSpa({ tenantId, token }: { tenantId: string; token: string }) {
  return (
    <div className="space-y-6">
      <RecordList tenantId={tenantId} token={token} path="spa-appointments" noun="appointment" cols={[
        { key: 'start_at', label: 'When', render: r => d10(r.start_at) },
        { key: 'client_name', label: 'Client' },
        { key: 'client_phone', label: 'Phone' },
        { key: 'service_name', label: 'Treatment' },
        { key: 'therapist', label: 'Therapist' },
        { key: 'status', label: 'Status' },
        { key: 'price_snapshot', label: 'Price', render: r => inr(r.price_snapshot) },
        { key: 'booking_source', label: 'Source' },
        { key: 'folio_id', label: 'Billed', render: r => (r.folio_id ? 'Yes' : '—') },
      ]} />
      <SpaImport tenantId={tenantId} token={token} />
    </div>
  );
}

export function DataLoaderEvents({ tenantId, token }: { tenantId: string; token: string }) {
  return (
    <div className="space-y-6">
      <RecordList tenantId={tenantId} token={token} path="event-bookings" noun="event booking" cols={[
        { key: 'event_date', label: 'Event date', render: r => `${String(r.event_date || '').slice(0, 10)}${r.end_date && String(r.end_date).slice(0, 10) !== String(r.event_date).slice(0, 10) ? ` → ${String(r.end_date).slice(0, 10)}` : ''}` },
        { key: 'customer_name', label: 'Customer' },
        { key: 'customer_phone', label: 'Phone' },
        { key: 'event_type', label: 'Type' },
        { key: 'venue_name', label: 'Hall' },
        { key: 'status', label: 'Status' },
        { key: 'total_amount', label: 'Total', render: r => inr(r.total_amount) },
        { key: 'advance_amount', label: 'Paid', render: r => inr(r.advance_amount) },
        { key: 'booking_source', label: 'Source' },
      ]} />
      <div className={CARD}>
        <h3 className="text-lg font-bold mb-1 flex items-center gap-2"><Upload size={18} className="text-brand" /> Import — bookings, invoices, rental items, add-on services</h3>
        <p className="text-xs text-[#6b5d52] mb-4">The Events migration engine: download a template per record type, upload, review the checks, then commit. Duplicates are skipped.</p>
        <EventMigration restaurantId={tenantId} token={token} />
      </div>
    </div>
  );
}
