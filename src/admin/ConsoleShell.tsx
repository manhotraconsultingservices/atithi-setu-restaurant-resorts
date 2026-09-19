// Platform console frame (phases 2–3 of the admin redesign): a left menu
// grouped Tenants / Platform / Operations / Tools, and a Ctrl K jump box that
// finds any tenant from the server directory and opens it. The Super Admin,
// Sales Rep and CTO consoles all render inside this one frame.
import React, { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';

export interface ConsoleItem { key: string; label: string; count?: number | null; tone?: 'warn' | 'crit' }
export interface ConsoleGroup { label: string; items: ConsoleItem[] }

export function ConsoleShell({ title, subtitle, groups, active, onSelect, token, onJump, children }: {
  title: string;
  subtitle: string;
  groups: ConsoleGroup[];
  active: string;
  onSelect: (key: string) => void;
  token: string;
  /** When given, Ctrl K opens a tenant finder and this is called with the chosen id. */
  onJump?: (tenantId: string) => void;
  children: any;
}) {
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    if (!onJump) return;
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); }
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [onJump]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[228px_minmax(0,1fr)] gap-4 lg:gap-6 text-slate-900">
      <nav aria-label="Console" className="lg:sticky lg:top-4 lg:self-start bg-white border border-slate-200 rounded-xl p-2 lg:p-3 flex lg:flex-col gap-1 lg:gap-4 overflow-x-auto">
        <div className="hidden lg:block px-2 pt-1">
          <div className="text-[14px] font-semibold">{title}</div>
          <div className="text-[11.5px] text-slate-500">{subtitle}</div>
        </div>
        {onJump && (
          <button type="button" onClick={() => setPalette(true)}
            className="hidden lg:flex items-center gap-2 h-9 px-2.5 rounded-lg border border-slate-200 bg-slate-50 text-[12.5px] text-slate-500 hover:border-slate-300">
            <Search size={14} /><span className="flex-1 text-left">Find a tenant</span>
            <span className="font-mono text-[10.5px] border border-slate-200 rounded px-1 bg-white">Ctrl K</span>
          </button>
        )}
        {groups.map(g => (
          <div key={g.label} className="flex lg:flex-col gap-0.5 shrink-0">
            <div className="hidden lg:block px-2.5 pb-1 text-[10.5px] font-semibold uppercase tracking-[.09em] text-slate-400">{g.label}</div>
            {g.items.map(it => (
              <button key={it.key} type="button" onClick={() => onSelect(it.key)} aria-current={active === it.key ? 'page' : undefined}
                className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-[13.5px] text-left whitespace-nowrap ${active === it.key ? 'bg-brand/10 text-brand font-semibold' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}>
                {it.label}
                {it.count != null && it.count > 0 && (
                  <span className={`font-mono text-[11px] ${it.tone === 'warn' ? 'text-amber-700' : it.tone === 'crit' ? 'text-rose-700' : 'text-slate-400'}`}>{it.count.toLocaleString('en-IN')}</span>
                )}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="min-w-0">{children}</div>
      {palette && onJump && <TenantFinder token={token} onClose={() => setPalette(false)} onPick={id => { setPalette(false); onJump(id); }} />}
    </div>
  );
}

// Top-level on purpose (a component defined inside another remounts on every render).
function TenantFinder({ token, onClose, onPick }: { token: string; onClose: () => void; onPick: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<any[]>([]);
  const [act, setAct] = useState(0);
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => { inp.current?.focus(); }, []);
  useEffect(() => {
    let dead = false;
    const t = setTimeout(async () => {
      try {
        const p = new URLSearchParams({ q: q.trim(), limit: '10', sort: q.trim() ? 'name' : 'active', dir: q.trim() ? 'asc' : 'desc' });
        const r = await fetch(`/api/admin/tenants/directory?${p}`, { headers: { Authorization: `Bearer ${token}` } });
        const d = r.ok ? await r.json() : { rows: [] };
        if (!dead) { setHits((d.rows || []).slice(0, 10)); setAct(0); }
      } catch { if (!dead) setHits([]); }
    }, 180);
    return () => { dead = true; clearTimeout(t); };
  }, [q, token]);
  return (
    <div className="fixed inset-0 z-[60] bg-slate-900/30 flex justify-center px-4 pt-[12vh]" onClick={onClose}>
      <div className="w-full max-w-[560px] self-start bg-white border border-slate-200 rounded-xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Find a tenant">
        <input ref={inp} id="console-finder" value={q} onChange={e => setQ(e.target.value)} placeholder="Go to a tenant — name, ID, owner, phone, city" autoComplete="off"
          onKeyDown={e => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') { e.preventDefault(); setAct(a => Math.min(a + 1, hits.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setAct(a => Math.max(a - 1, 0)); }
            if (e.key === 'Enter' && hits[act]) onPick(hits[act].id);
          }}
          className="w-full border-0 border-b border-slate-200 px-4 py-3.5 text-[15px] outline-none" />
        <ul className="max-h-[50vh] overflow-auto p-1.5">
          {hits.map((h, i) => (
            <li key={h.id}>
              <button type="button" onClick={() => onPick(h.id)} onMouseEnter={() => setAct(i)}
                className={`w-full flex items-center justify-between gap-3 px-2.5 py-2 rounded-lg text-left ${i === act ? 'bg-slate-100' : ''}`}>
                <span className="min-w-0"><span className="font-semibold text-[13.5px]">{h.name}</span> <span className="text-[12.5px] text-slate-500">· {h.city || '—'}</span></span>
                <span className="font-mono text-[11px] text-slate-400 truncate max-w-[45%]">{h.id}</span>
              </button>
            </li>
          ))}
          {!hits.length && <li className="px-3 py-3 text-[13px] text-slate-500">No tenant matches.</li>}
        </ul>
      </div>
    </div>
  );
}
