import { useState, useEffect, useCallback, useMemo, type FC } from 'react';

// ── Status Board — an at-a-glance grid of every room (and event hall) with its
// current status, flippable inline. Changing a status hits the same endpoints
// the rest of the app uses, so it also fires any ROOM_<status> / VENUE_<status>
// checklist the owner configured. Rooms link into the room tree menu.

type Props = { restaurantId: string; token: string; isEventsEnabled?: boolean; onOpenRoom?: (room: any) => void };

function makeApi(restaurantId: string, token: string) {
  return async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`/api/restaurant/${restaurantId}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { const err: any = new Error((b && b.error) || `HTTP ${r.status}`); err.status = r.status; err.data = b; throw err; }
    return b;
  };
}

const ROOM_STATUSES = ['VACANT', 'OCCUPIED', 'CLEANING', 'MAINTENANCE', 'BLOCKED'];
const META: Record<string, { label: string; dot: string; tile: string; sel: string }> = {
  VACANT: { label: 'Vacant', dot: 'bg-emerald-500', tile: 'bg-emerald-50 border-emerald-200', sel: 'text-emerald-800 border-emerald-300' },
  OCCUPIED: { label: 'Occupied', dot: 'bg-blue-500', tile: 'bg-blue-50 border-blue-200', sel: 'text-blue-800 border-blue-300' },
  CLEANING: { label: 'Cleaning', dot: 'bg-amber-500', tile: 'bg-amber-50 border-amber-200', sel: 'text-amber-800 border-amber-300' },
  MAINTENANCE: { label: 'Maintenance', dot: 'bg-stone-500', tile: 'bg-stone-100 border-stone-300', sel: 'text-stone-700 border-stone-300' },
  BLOCKED: { label: 'Blocked', dot: 'bg-rose-500', tile: 'bg-rose-50 border-rose-200', sel: 'text-rose-800 border-rose-300' },
};
const norm = (s: any) => { const u = String(s || 'VACANT').toUpperCase(); return META[u] ? u : 'VACANT'; };

export function StatusBoard({ restaurantId, token, isEventsEnabled, onOpenRoom }: Props) {
  const api = useCallback(makeApi(restaurantId, token), [restaurantId, token]);
  const [rooms, setRooms] = useState<any[]>([]);
  const [venues, setVenues] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const [r, v] = await Promise.all([
        api('/hotel/rooms').catch(() => []),
        isEventsEnabled ? api('/events/venues').catch(() => []) : Promise.resolve([]),
      ]);
      setRooms(Array.isArray(r) ? r : []);
      setVenues(Array.isArray(v) ? v.filter((x: any) => Number(x.is_active) !== 0) : []);
    } catch (e: any) { setErr(e?.message || 'Failed to load'); }
    finally { setLoading(false); }
  }, [api, isEventsEnabled]);
  useEffect(() => { load(); }, [load]);

  const change = async (kind: 'room' | 'venue', item: any, status: string) => {
    setBusy(item.id); setErr('');
    const setter = kind === 'room' ? setRooms : setVenues;
    setter((xs: any[]) => xs.map(x => x.id === item.id ? { ...x, status } : x)); // optimistic
    try {
      const path = kind === 'room' ? `/hotel/rooms/${item.id}/status` : `/events/venues/${item.id}/status`;
      await api(path, { method: 'PATCH', body: JSON.stringify({ status }) });
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Could not change status'); await load();
    } finally { setBusy(''); }
  };

  const roomsByFloor = useMemo(() => {
    const g: Record<string, any[]> = {};
    for (const rm of rooms) { const f = rm.floor == null || rm.floor === '' ? '—' : String(rm.floor); (g[f] = g[f] || []).push(rm); }
    return Object.entries(g).sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }));
  }, [rooms]);

  const roomCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const rm of rooms) { const s = norm(rm.status); c[s] = (c[s] || 0) + 1; }
    return c;
  }, [rooms]);

  const Tile: FC<{ kind: 'room' | 'venue'; item: any; sub: string }> = ({ kind, item, sub }) => {
    const s = norm(item.status); const m = META[s];
    const name = kind === 'room' ? (item.name || (item.room_number ? `Room ${item.room_number}` : item.id)) : (item.name || item.id);
    return (
      <div className={`rounded-xl border p-2.5 flex flex-col gap-1.5 ${m.tile} ${busy === item.id ? 'opacity-60' : ''}`}>
        <div className="flex items-start justify-between gap-1">
          {kind === 'room' && onOpenRoom
            ? <button onClick={() => onOpenRoom(item)} className="text-[13px] font-bold text-[#14110c] hover:underline text-left leading-tight">{name}</button>
            : <span className="text-[13px] font-bold text-[#14110c] leading-tight">{name}</span>}
          <span className={`w-2.5 h-2.5 rounded-full shrink-0 mt-1 ${m.dot}`} />
        </div>
        {sub && <div className="text-[10px] text-[#6b5d52] truncate">{sub}</div>}
        <select value={s} disabled={busy === item.id} onChange={e => change(kind, item, e.target.value)}
          className={`mt-auto text-[11px] font-semibold rounded-lg px-1.5 py-1 bg-white border outline-none focus:ring-2 ring-[#cc5a16]/20 ${m.sel}`}>
          {ROOM_STATUSES.map(st => <option key={st} value={st}>{META[st].label}</option>)}
        </select>
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-3xl font-bold font-serif text-[#1a1208]">Status Board</h2>
        <p className="text-sm text-[#6b5d52] mt-1">Every room{isEventsEnabled ? ' and event hall' : ''} at a glance. Change a status inline — it also raises any status checklist you've configured.</p>
      </div>

      {/* Legend + counts */}
      <div className="flex items-center gap-2 flex-wrap">
        {ROOM_STATUSES.map(s => (
          <span key={s} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${META[s].tile}`}>
            <span className={`w-2 h-2 rounded-full ${META[s].dot}`} />{META[s].label}
            <span className="tabular-nums text-[#6b5d52]">{roomCounts[s] || 0}</span>
          </span>
        ))}
        <button onClick={load} className="ml-auto px-3 py-1.5 border border-[#e8dccf] text-sm rounded-xl hover:border-[#cc5a16]/50 hover:text-[#cc5a16] transition-colors">Refresh</button>
      </div>

      {err && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">{err}</div>}

      {loading ? (
        <p className="text-sm text-[#6b5d52]">Loading…</p>
      ) : rooms.length === 0 && venues.length === 0 ? (
        <div className="text-center py-16"><p className="text-4xl mb-2">🏨</p><p className="text-sm text-[#6b5d52]">No rooms or halls to show.</p></div>
      ) : (
        <>
          {roomsByFloor.map(([floor, list]) => (
            <div key={floor}>
              <h3 className="text-xs font-bold uppercase tracking-widest text-[#9c8e85] mb-2">Floor {floor} <span className="text-[#c4b8ab]">· {list.length}</span></h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5">
                {list.map(rm => <Tile key={rm.id} kind="room" item={rm} sub={`${rm.type || rm.type_id || 'Room'}`} />)}
              </div>
            </div>
          ))}

          {isEventsEnabled && venues.length > 0 && (
            <div>
              <h3 className="text-xs font-bold uppercase tracking-widest text-[#9c8e85] mb-2">Event halls <span className="text-[#c4b8ab]">· {venues.length}</span></h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5">
                {venues.map(v => <Tile key={v.id} kind="venue" item={v} sub={`${v.category || 'Hall'}`} />)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
