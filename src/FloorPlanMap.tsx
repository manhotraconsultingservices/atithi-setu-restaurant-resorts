import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Floor Plan (Phase 2) — spatial table map for the Command Centre.
 *
 * View mode: section tabs + tiles that snap to their saved (pos_x, pos_y).
 *   Falls back to an auto-flow grid when nothing has been arranged yet, so a
 *   fresh tenant sees a usable board instead of a blank canvas.
 * Arrange mode (owner only): drag tiles on a fixed canvas (grid-snapped),
 *   manage sections, set per-tile section + shape, then save the whole layout
 *   in one PUT. Tiles carry live status colour throughout.
 *
 * Data rides on the existing /tables/live feed (server spreads t.* so
 * pos_x/pos_y/section_id/shape arrive for free); sections + layout have their
 * own owner-gated endpoints.
 */

type Section = { id: string; name: string; sort_order?: number };
type Tile = any; // a /tables/live row (…t + session fields)

interface FloorPlanMapProps {
  tables: Tile[];
  restaurantId: string;
  token: string;
  isOwner: boolean;
  statusFilter: string;   // 'ALL' | 'AVAILABLE' | 'OCCUPIED' | 'NOT_AVAILABLE' | 'BILL_REQUESTED'
  search: string;
  now: number;            // parent's liveNow (ms)
  onTileClick: (t: { id: string; name: string }) => void;
  onRefetch: () => void;  // reload the live feed after a layout/section change
}

const CANVAS_W = 1280;
const CANVAS_H = 680;
const TILE_W = 128;
const TILE_H = 84;
const GRID = 20;

const SECTION_TINTS = ['#cc5a16', '#2563eb', '#059669', '#7c3aed', '#db2777', '#0891b2', '#ca8a04', '#dc2626'];

function cx(...parts: (string | false | null | undefined)[]) { return parts.filter(Boolean).join(' '); }
function snap(n: number) { return Math.round(n / GRID) * GRID; }
function natCmp(a: any, b: any) {
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });
}

export function FloorPlanMap(props: FloorPlanMapProps) {
  const { tables, restaurantId, token, isOwner, statusFilter, search, now, onTileClick, onRefetch } = props;

  const api = (path: string, opts: RequestInit = {}) =>
    fetch(`/api/restaurant/${restaurantId}${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    });

  const [sections, setSections] = useState<Section[]>([]);
  const [activeSection, setActiveSection] = useState<string>('ALL'); // 'ALL' | sectionId | 'NONE'
  const [arrange, setArrange] = useState(false);
  const [busy, setBusy] = useState(false);
  // Per-tenant turn-time thresholds (minutes): amber past warn, red past alert.
  const [warnMins, setWarnMins] = useState(45);
  const [alertMins, setAlertMins] = useState(90);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/restaurant/${restaurantId}`);
        if (r.ok) {
          const d = await r.json();
          setWarnMins(Number.isFinite(+d.turn_warn_mins) ? Number(d.turn_warn_mins) : 45);
          setAlertMins(Number.isFinite(+d.turn_alert_mins) ? Number(d.turn_alert_mins) : 90);
        }
      } catch { /* keep defaults */ }
    })();
  }, [restaurantId]);

  const loadSections = async () => {
    try {
      const r = await api('/tables/sections');
      if (r.ok) setSections(await r.json());
    } catch { /* ignore — tabs simply won't show */ }
  };
  useEffect(() => { loadSections(); /* eslint-disable-next-line */ }, [restaurantId]);

  const sectionColor = (id?: string | null) => {
    if (!id) return '#9c8e85';
    const i = sections.findIndex(s => s.id === id);
    return SECTION_TINTS[(i < 0 ? 0 : i) % SECTION_TINTS.length];
  };
  const sectionName = (id?: string | null) => sections.find(s => s.id === id)?.name || 'Unsectioned';

  // ── filtering shared by both modes ────────────────────────────────────────
  const filtered = useMemo(() => {
    let rows = [...tables];
    if (statusFilter !== 'ALL') {
      rows = rows.filter(t => statusFilter === 'BILL_REQUESTED'
        ? t.session_status === 'bill_requested'
        : t.status === statusFilter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(t =>
        t.name?.toLowerCase().includes(q) ||
        t.customer_name?.toLowerCase().includes(q) ||
        (t.customer_phone || '').toLowerCase().includes(q));
    }
    return rows;
  }, [tables, statusFilter, search]);

  const bySection = (rows: Tile[]) => {
    if (activeSection === 'ALL') return rows;
    if (activeSection === 'NONE') return rows.filter(t => !t.section_id);
    return rows.filter(t => t.section_id === activeSection);
  };

  const tileStatus = (t: Tile) => {
    const occ = t.status === 'OCCUPIED';
    const bill = t.session_status === 'bill_requested';
    const unavail = t.status === 'NOT_AVAILABLE';
    const mins = t.session_opened_at ? Math.floor((now - new Date(t.session_opened_at).getTime()) / 60000) : 0;
    const over = occ && alertMins > 0 && mins >= alertMins;          // red — slow turn
    const warn = occ && !over && warnMins > 0 && mins >= warnMins;   // amber — watch
    const covers = Number(t.covers || 0);
    const cls = bill ? 'border-orange-400 bg-orange-50 text-orange-900'
      : over ? 'border-rose-400 bg-rose-50 text-rose-900'
      : warn ? 'border-amber-400 bg-amber-50 text-amber-900'
      : occ ? 'border-[#cc5a16]/55 bg-[#cc5a16]/8 text-[#1a1208]'
      : unavail ? 'border-zinc-200 bg-zinc-50 text-zinc-400'
      : 'border-dashed border-[#cc5a16]/25 bg-white text-[#9c8e85]';
    return { occ, bill, unavail, over, warn, mins, covers, cls, pulse: bill || over };
  };

  const shapeRadius = (shape?: string) =>
    shape === 'circle' ? '9999px' : shape === 'rect' ? '10px' : '16px';

  // Tile inner content (shared by view + arrange).
  const TileBody = ({ t, compact }: { t: Tile; compact?: boolean }) => {
    const s = tileStatus(t);
    return (
      <>
        <div className="flex items-center justify-between gap-1.5">
          <span className="font-bold text-[14px] tracking-tight leading-none truncate">{t.name}</span>
          <div className="flex items-center gap-1 shrink-0">
            {s.covers > 0 && <span className="font-mono text-[10px] font-bold px-1 rounded bg-black/5 leading-none py-0.5" title={`${s.covers} guests`}>{s.covers}p</span>}
            {s.occ && <span className="font-mono text-[10px] opacity-70">{s.mins}m</span>}
          </div>
        </div>
        {!compact && (s.occ || s.bill ? (
          <div>
            <div className="font-mono font-bold text-[15px] text-[#1a1208] leading-none">₹{Number(t.bill_amount || 0).toFixed(0)}</div>
            <div className="flex items-center gap-1.5 mt-1 font-mono text-[10px] opacity-75 truncate">
              {t.order_count ? <span>{t.order_count} KOT</span> : null}
              {t.assigned_waiter_name ? <span className="truncate">· {t.assigned_waiter_name}</span> : null}
              {s.bill ? <span className="font-bold">· BILL</span> : s.over ? <span className="font-bold">· SLOW</span> : null}
            </div>
          </div>
        ) : (
          <div className="font-mono text-[10px] opacity-70 uppercase tracking-widest">{s.unavail ? 'N / A' : 'Vacant'}</div>
        ))}
      </>
    );
  };

  // ══════════════════════════════════════════════════════════════════════════
  //  VIEW MODE
  // ══════════════════════════════════════════════════════════════════════════
  const anyPlaced = tables.some(t => (Number(t.pos_x) || 0) || (Number(t.pos_y) || 0));

  const SectionTabs = () => {
    const noneCount = filtered.filter(t => !t.section_id).length;
    const tabs: { id: string; label: string; tint?: string }[] = [{ id: 'ALL', label: 'All' }];
    for (const s of sections) tabs.push({ id: s.id, label: s.name, tint: sectionColor(s.id) });
    if (noneCount > 0 && sections.length > 0) tabs.push({ id: 'NONE', label: 'Unsectioned' });
    if (tabs.length <= 1 && !arrange) return null;
    return (
      <div className="flex items-center gap-1.5 flex-wrap px-4 pt-3">
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveSection(tab.id)}
            className={cx(
              'px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-widest transition-all border',
              activeSection === tab.id
                ? 'bg-[#cc5a16] text-white border-[#cc5a16] shadow-sm'
                : 'bg-[#faf7f2] text-[#6b5d52] border-[#cc5a16]/10 hover:bg-[#cc5a16]/5')}>
            {tab.tint && <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ background: tab.tint }} />}
            {tab.label}
          </button>
        ))}
        {isOwner && (
          <button onClick={() => enterArrange()}
            className="ml-auto px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-widest border border-[#cc5a16]/30 text-[#cc5a16] hover:bg-[#cc5a16]/5 transition-all">
            ✎ Arrange
          </button>
        )}
      </div>
    );
  };

  const viewRows = bySection(filtered);

  const ViewMode = () => {
    if (viewRows.length === 0) {
      return (
        <div className="py-16 text-center text-[#9c8e85] text-sm italic">
          {tables.length === 0 ? 'No tables found · Add tables in QR Management first' : 'No tables match your search / filter'}
        </div>
      );
    }

    // Fresh tenant (nothing arranged) → auto-flow grid, exactly like Phase 1.
    if (!anyPlaced) {
      const rank = (t: any) => t.session_status === 'bill_requested' ? 0 : t.status === 'OCCUPIED' ? 1 : t.status === 'NOT_AVAILABLE' ? 2 : 3;
      const rows = [...viewRows].sort((a, b) => (rank(a) - rank(b)) || natCmp(a.name, b.name));
      return (
        <div className="p-4 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
          {rows.map(t => {
            const s = tileStatus(t);
            return (
              <button key={t.id} onClick={() => onTileClick({ id: t.id, name: t.name })}
                className={cx('text-left border-2 p-3 min-h-[94px] flex flex-col justify-between transition-transform hover:-translate-y-0.5 hover:shadow-md', s.cls, s.pulse && 'alert-pulse')}
                style={{ borderRadius: shapeRadius(t.shape) }}>
                <TileBody t={t} />
              </button>
            );
          })}
        </div>
      );
    }

    // Arranged → positioned canvas; unplaced tables spill into a strip below.
    const placed = viewRows.filter(t => (Number(t.pos_x) || 0) || (Number(t.pos_y) || 0));
    const unplaced = viewRows.filter(t => !((Number(t.pos_x) || 0) || (Number(t.pos_y) || 0)));
    const maxX = Math.max(CANVAS_W, ...placed.map(t => (Number(t.pos_x) || 0) + TILE_W + 24));
    const maxY = Math.max(CANVAS_H, ...placed.map(t => (Number(t.pos_y) || 0) + TILE_H + 24));
    return (
      <div className="p-4">
        <div className="overflow-auto rounded-2xl border border-[#cc5a16]/10 bg-[#faf7f2]/40"
          style={{ backgroundImage: 'radial-gradient(#cc5a1618 1px, transparent 1px)', backgroundSize: `${GRID}px ${GRID}px` }}>
          <div className="relative" style={{ width: maxX, height: maxY }}>
            {placed.map(t => {
              const s = tileStatus(t);
              return (
                <button key={t.id} onClick={() => onTileClick({ id: t.id, name: t.name })}
                  className={cx('absolute text-left border-2 p-2.5 flex flex-col justify-between transition-transform hover:-translate-y-0.5 hover:shadow-md', s.cls, s.pulse && 'alert-pulse')}
                  style={{ left: Number(t.pos_x) || 0, top: Number(t.pos_y) || 0, width: TILE_W, height: TILE_H, borderRadius: shapeRadius(t.shape) }}>
                  <TileBody t={t} />
                  {t.section_id && <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full border-2 border-white" style={{ background: sectionColor(t.section_id) }} title={sectionName(t.section_id)} />}
                </button>
              );
            })}
          </div>
        </div>
        {unplaced.length > 0 && (
          <div className="mt-4">
            <div className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-2">Not placed on map</div>
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
              {unplaced.map(t => {
                const s = tileStatus(t);
                return (
                  <button key={t.id} onClick={() => onTileClick({ id: t.id, name: t.name })}
                    className={cx('text-left border-2 p-3 min-h-[94px] flex flex-col justify-between transition-transform hover:-translate-y-0.5 hover:shadow-md', s.cls, s.pulse && 'alert-pulse')}
                    style={{ borderRadius: shapeRadius(t.shape) }}>
                    <TileBody t={t} />
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  // ══════════════════════════════════════════════════════════════════════════
  //  ARRANGE MODE (owner)
  // ══════════════════════════════════════════════════════════════════════════
  type Draft = Record<string, { pos_x: number; pos_y: number; section_id: string | null; shape: string }>;
  const [draft, setDraft] = useState<Draft>({});
  const [selId, setSelId] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);

  const enterArrange = () => {
    const d: Draft = {};
    let auto = 0;
    for (const t of [...tables].sort((a, b) => natCmp(a.name, b.name))) {
      let px = Number(t.pos_x) || 0, py = Number(t.pos_y) || 0;
      if (!px && !py) { // lay unplaced tables out on a starter grid
        const perRow = Math.floor((CANVAS_W - 24) / (TILE_W + 20)) || 1;
        px = 24 + (auto % perRow) * (TILE_W + 20);
        py = 24 + Math.floor(auto / perRow) * (TILE_H + 20);
        auto++;
      }
      d[t.id] = { pos_x: px, pos_y: py, section_id: t.section_id || null, shape: t.shape || 'square' };
    }
    setDraft(d);
    setSelId(null);
    setArrange(true);
  };

  const onTilePointerDown = (e: React.PointerEvent, id: string) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cur = draft[id] || { pos_x: 0, pos_y: 0 };
    dragRef.current = { id, dx: e.clientX - rect.left - cur.pos_x, dy: e.clientY - rect.top - cur.pos_y, moved: false };
    setSelId(id);
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* older browsers */ }
    e.preventDefault();
  };
  const onCanvasPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d) return;
    const rect = canvasRef.current?.getBoundingClientRect(); if (!rect) return;
    let x = snap(e.clientX - rect.left - d.dx);
    let y = snap(e.clientY - rect.top - d.dy);
    x = Math.max(0, Math.min(CANVAS_W - TILE_W, x));
    y = Math.max(0, Math.min(CANVAS_H - TILE_H, y));
    d.moved = true;
    setDraft(prev => ({ ...prev, [d.id]: { ...prev[d.id], pos_x: x, pos_y: y } }));
  };
  const onCanvasPointerUp = () => { dragRef.current = null; };

  const saveLayout = async () => {
    setBusy(true);
    try {
      const payload = { tables: Object.keys(draft).map(id => ({ id, ...draft[id] })) };
      const r = await api('/tables/layout', { method: 'PUT', body: JSON.stringify(payload) });
      if (!r.ok) throw new Error(await r.text());
      setArrange(false);
      onRefetch();
    } catch (e: any) {
      alert(`Could not save layout: ${e?.message || e}`);
    } finally { setBusy(false); }
  };

  const addSection = async () => {
    const name = window.prompt('New section name (e.g. Ground Floor, Terrace, AC Hall)')?.trim();
    if (!name) return;
    setBusy(true);
    try {
      const r = await api('/tables/sections', { method: 'POST', body: JSON.stringify({ name, sort_order: sections.length }) });
      if (r.ok) { const s = await r.json(); setSections(p => [...p, s]); }
    } finally { setBusy(false); }
  };
  const renameSection = async (s: Section) => {
    const name = window.prompt('Rename section', s.name)?.trim();
    if (!name || name === s.name) return;
    setBusy(true);
    try {
      const r = await api(`/tables/sections/${s.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      if (r.ok) setSections(p => p.map(x => x.id === s.id ? { ...x, name } : x));
    } finally { setBusy(false); }
  };
  const deleteSection = async (s: Section) => {
    if (!window.confirm(`Delete section "${s.name}"? Its tables become Unsectioned (tables are not deleted).`)) return;
    setBusy(true);
    try {
      const r = await api(`/tables/sections/${s.id}`, { method: 'DELETE' });
      if (r.ok) {
        setSections(p => p.filter(x => x.id !== s.id));
        setDraft(prev => {
          const next = { ...prev };
          for (const k of Object.keys(next)) if (next[k].section_id === s.id) next[k] = { ...next[k], section_id: null };
          return next;
        });
      }
    } finally { setBusy(false); }
  };

  const sel = selId ? draft[selId] : null;
  const selTable = selId ? tables.find(t => t.id === selId) : null;

  const ArrangeMode = () => (
    <div className="p-4">
      {/* toolbar */}
      <div className="flex items-center gap-2 flex-wrap mb-3 p-3 rounded-2xl bg-[#faf7f2] border border-[#cc5a16]/10">
        <span className="text-[11px] font-bold uppercase tracking-widest text-[#cc5a16]">Arrange Floor</span>
        <span className="text-[11px] text-[#9c8e85] hidden sm:inline">· drag tiles to position · click a tile to set its section &amp; shape</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={addSection} disabled={busy}
            className="px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-widest border border-[#cc5a16]/25 text-[#6b5d52] hover:bg-white transition-all">+ Section</button>
          <button onClick={() => setArrange(false)} disabled={busy}
            className="px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] hover:text-[#6b5d52] transition-all">Cancel</button>
          <button onClick={saveLayout} disabled={busy}
            className="px-4 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-widest bg-[#cc5a16] text-white shadow-sm hover:bg-[#b34e12] transition-all disabled:opacity-50">
            {busy ? 'Saving…' : 'Save Layout'}
          </button>
        </div>
      </div>

      {/* sections chips (rename / delete) */}
      {sections.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap mb-3">
          {sections.map(s => (
            <span key={s.id} className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full bg-white border text-[11px] font-semibold"
              style={{ borderColor: sectionColor(s.id) + '55' }}>
              <span className="w-2 h-2 rounded-full" style={{ background: sectionColor(s.id) }} />
              {s.name}
              <button onClick={() => renameSection(s)} className="ml-0.5 px-1 text-[#9c8e85] hover:text-[#6b5d52]" title="Rename">✎</button>
              <button onClick={() => deleteSection(s)} className="px-1 text-[#9c8e85] hover:text-red-500" title="Delete">✕</button>
            </span>
          ))}
        </div>
      )}

      <div className="relative">
        {/* inspector for the selected tile */}
        {sel && selTable && (
          <div className="absolute z-20 top-2 right-2 w-60 rounded-2xl bg-white border border-[#cc5a16]/15 shadow-lg p-3 space-y-2.5">
            <div className="text-[13px] font-bold text-[#1a1208] truncate">{selTable.name}</div>
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-widest text-[#9c8e85]">Section</span>
              <select value={sel.section_id || ''} onChange={e => setDraft(p => ({ ...p, [selId!]: { ...p[selId!], section_id: e.target.value || null } }))}
                className="mt-1 w-full text-sm border border-[#cc5a16]/15 rounded-lg px-2 py-1.5 bg-white">
                <option value="">Unsectioned</option>
                {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-widest text-[#9c8e85]">Shape</span>
              <select value={sel.shape} onChange={e => setDraft(p => ({ ...p, [selId!]: { ...p[selId!], shape: e.target.value } }))}
                className="mt-1 w-full text-sm border border-[#cc5a16]/15 rounded-lg px-2 py-1.5 bg-white">
                <option value="square">Square</option>
                <option value="rect">Rectangle</option>
                <option value="circle">Round</option>
              </select>
            </label>
            <button onClick={() => setSelId(null)} className="w-full text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] hover:text-[#6b5d52] pt-1">Done</button>
          </div>
        )}

        <div ref={canvasRef} onPointerMove={onCanvasPointerMove} onPointerUp={onCanvasPointerUp} onPointerLeave={onCanvasPointerUp}
          className="overflow-auto rounded-2xl border border-[#cc5a16]/15 bg-[#faf7f2]/50 select-none"
          style={{ touchAction: 'none' }}>
          <div className="relative" style={{ width: CANVAS_W, height: CANVAS_H, backgroundImage: 'radial-gradient(#cc5a1622 1px, transparent 1px)', backgroundSize: `${GRID}px ${GRID}px` }}>
            {[...tables].sort((a, b) => natCmp(a.name, b.name)).map(t => {
              const d = draft[t.id]; if (!d) return null;
              const s = tileStatus(t);
              const isSel = selId === t.id;
              return (
                <div key={t.id} onPointerDown={e => onTilePointerDown(e, t.id)}
                  className={cx('absolute border-2 p-2 flex flex-col justify-between cursor-grab active:cursor-grabbing', s.cls, isSel && 'ring-2 ring-[#cc5a16] ring-offset-1')}
                  style={{ left: d.pos_x, top: d.pos_y, width: TILE_W, height: TILE_H, borderRadius: shapeRadius(d.shape) }}>
                  <TileBody t={t} compact />
                  <span className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 rounded-full border-2 border-white" style={{ background: sectionColor(d.section_id) }} title={sectionName(d.section_id)} />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div>
      {!arrange && <SectionTabs />}
      {arrange ? <ArrangeMode /> : <ViewMode />}
    </div>
  );
}

export default FloorPlanMap;
