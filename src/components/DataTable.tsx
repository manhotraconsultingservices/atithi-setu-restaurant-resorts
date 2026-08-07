import React, { useMemo, useState } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown, Download, Search, X, ChevronLeft, ChevronRight, SlidersHorizontal, Check } from 'lucide-react';
import { cn } from '../lib/utils';

export interface ColDef<T = any> {
  key: string;
  label: string;
  sortable?: boolean;
  getValue?: (row: T) => any;
  render?: (row: T) => React.ReactNode;
  exportValue?: (row: T) => string;
  noExport?: boolean;
  className?: string;
  headerClassName?: string;
  align?: 'left' | 'right' | 'center';
  searchable?: boolean;
  hidden?: boolean;              // hard-hidden (responsive etc.) — never shown, not in the chooser
  hideable?: boolean;           // default true; when false the column can't be toggled off in the gear chooser
  defaultHidden?: boolean;      // start hidden in the chooser (user can re-enable)
  filterable?: boolean;         // show a per-column filter control (needs columnFilters on the table)
  filterType?: 'text' | 'select';
  filterOptions?: { value: string; label: string }[]; // for select; derived from data when omitted
}

interface DataTableProps<T = any> {
  data: T[];
  columns: ColDef<T>[];
  rowKey: (row: T, i: number) => string | number;
  searchPlaceholder?: string;
  exportFilename?: string;
  pageSize?: number;
  emptyMessage?: string;
  loading?: boolean;
  toolbarLeft?: React.ReactNode;
  toolbarRight?: React.ReactNode;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string;
  renderExpanded?: (row: T) => React.ReactNode;
  isExpanded?: (row: T) => boolean;
  containerClassName?: string;
  compact?: boolean;
  hideSearch?: boolean;
  hideExport?: boolean;
  hidePagination?: boolean;
  columnChooser?: boolean;      // show a gear that adds/removes columns
  columnFilters?: boolean;      // show a per-column filter row
  tableId?: string;             // localStorage key so the column choice sticks per user
}

function getVal<T>(row: T, col: ColDef<T>): any {
  if (col.getValue) return col.getValue(row);
  return (row as any)[col.key];
}

export function exportToCsv<T>(data: T[], cols: ColDef<T>[], filename: string) {
  const visible = cols.filter(c => !c.hidden && !c.noExport);
  const header = visible.map(c => `"${c.label.replace(/"/g, '""')}"`).join(',');
  const rows = data.map(row =>
    visible.map(c => {
      let v = '';
      if (c.exportValue) {
        v = c.exportValue(row);
      } else {
        const raw = getVal(row, c);
        v = raw == null ? '' : String(raw);
      }
      return `"${v.replace(/"/g, '""')}"`;
    }).join(',')
  );
  const csv = [header, ...rows].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const PAGE_SIZES = [25, 50, 100] as const;

export function DataTable<T = any>({
  data,
  columns,
  rowKey,
  searchPlaceholder = 'Search…',
  exportFilename = 'export',
  pageSize: defaultPageSize = 25,
  emptyMessage = 'No records found.',
  loading = false,
  toolbarLeft,
  toolbarRight,
  onRowClick,
  rowClassName,
  renderExpanded,
  isExpanded,
  containerClassName = '',
  compact = false,
  hideSearch = false,
  hideExport = false,
  hidePagination = false,
  columnChooser = false,
  columnFilters = false,
  tableId,
}: DataTableProps<T>) {
  const [query, setQuery] = useState('');
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  const [chooserOpen, setChooserOpen] = useState(false);

  const storageKey = tableId ? `dt:cols:${tableId}` : null;
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => {
    if (storageKey && typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(storageKey);
        if (raw) return new Set<string>(JSON.parse(raw));
      } catch { /* ignore */ }
    }
    return new Set(columns.filter(c => c.defaultHidden).map(c => c.key));
  });

  const toggleCol = (key: string) => {
    setHiddenKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      if (storageKey && typeof window !== 'undefined') {
        try { window.localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* ignore */ }
      }
      return next;
    });
  };

  const visible = useMemo(
    () => columns.filter(c => !c.hidden && !hiddenKeys.has(c.key)),
    [columns, hiddenKeys],
  );

  // distinct values for select-type column filters (only when we actually filter)
  const selectOptions = useMemo(() => {
    if (!columnFilters) return {} as Record<string, { value: string; label: string }[]>;
    const out: Record<string, { value: string; label: string }[]> = {};
    columns.forEach(col => {
      if (!col.filterable || col.filterType !== 'select') return;
      if (col.filterOptions) { out[col.key] = col.filterOptions; return; }
      const seen = new Set<string>();
      const opts: { value: string; label: string }[] = [];
      data.forEach(row => {
        const raw = getVal(row, col);
        const s = raw == null ? '' : String(raw);
        if (s && !seen.has(s)) { seen.add(s); opts.push({ value: s, label: s }); }
      });
      opts.sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true, sensitivity: 'base' }));
      out[col.key] = opts;
    });
    return out;
  }, [columns, data, columnFilters]);

  const activeFilters = useMemo<[string, string][]>(
    () => (Object.entries(colFilters) as [string, string][]).filter(([, v]) => Boolean(v && String(v).trim())),
    [colFilters],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q && activeFilters.length === 0) return data;
    return data.filter(row => {
      if (q) {
        const hit = visible.some(col => {
          if (col.searchable === false) return false;
          return String(getVal(row, col) ?? '').toLowerCase().includes(q);
        });
        if (!hit) return false;
      }
      for (const [key, val] of activeFilters) {
        const col = columns.find(c => c.key === key);
        if (!col) continue;
        const cell = String(getVal(row, col) ?? '').toLowerCase();
        const v = val.trim().toLowerCase();
        if (col.filterType === 'select') { if (cell !== v) return false; }
        else if (!cell.includes(v)) return false;
      }
      return true;
    });
  }, [data, query, visible, activeFilters, columns]);

  const sorted = useMemo(() => {
    if (!sortCol) return filtered;
    const col = columns.find(c => c.key === sortCol);
    if (!col?.sortable) return filtered;
    return [...filtered].sort((a, b) => {
      const va = getVal(a, col);
      const vb = getVal(b, col);
      const isNum = typeof va === 'number' && typeof vb === 'number';
      const cmp = isNum ? va - vb : String(va ?? '').localeCompare(String(vb ?? ''), 'en', { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortCol, sortDir, columns]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginated = hidePagination ? sorted : sorted.slice((safePage - 1) * pageSize, safePage * pageSize);

  const handleSort = (key: string) => {
    if (sortCol === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(key); setSortDir('asc'); }
    setPage(1);
  };

  const setFilter = (key: string, val: string) => {
    setColFilters(f => ({ ...f, [key]: val }));
    setPage(1);
  };

  const cellPad = compact ? 'px-3 py-2' : 'px-4 py-3';
  const headPad = compact ? 'px-3 py-2' : 'px-4 py-3';
  const showToolbar = !hideSearch || !hideExport || columnChooser || toolbarLeft || toolbarRight;
  const chooserCols = columns.filter(c => !c.hidden);

  return (
    <div className={cn('overflow-hidden rounded-2xl border border-[#cc5a16]/10 bg-white', containerClassName)}>
      {showToolbar && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-[#cc5a16]/10 bg-[#faf7f2]/50">
          {toolbarLeft}
          {!hideSearch && (
            <div className="relative flex-1 min-w-[160px] max-w-xs">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#9c8e85] pointer-events-none" />
              <input
                type="text"
                value={query}
                onChange={e => { setQuery(e.target.value); setPage(1); }}
                placeholder={searchPlaceholder}
                className="w-full bg-white border border-[#e8dccf] rounded-xl pl-8 pr-7 py-1.5 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20 transition"
              />
              {query && (
                <button onClick={() => { setQuery(''); setPage(1); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#9c8e85] hover:text-[#cc5a16] transition-colors">
                  <X size={12} />
                </button>
              )}
            </div>
          )}
          <span className="text-xs text-[#9c8e85] hidden sm:inline tabular-nums">
            {query || activeFilters.length ? `${filtered.length} of ${data.length}` : `${data.length} record${data.length !== 1 ? 's' : ''}`}
          </span>
          {toolbarRight}
          {columnChooser && (
            <div className="relative">
              <button
                onClick={() => setChooserOpen(o => !o)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#6b5d52] bg-white border border-[#e8dccf] rounded-xl hover:border-[#cc5a16]/50 hover:text-[#cc5a16] transition-colors"
                title="Choose columns"
              >
                <SlidersHorizontal size={13} />
                Columns
              </button>
              {chooserOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setChooserOpen(false)} />
                  <div className="absolute right-0 mt-1 z-30 w-56 bg-white border border-[#e8dccf] rounded-xl shadow-lg p-1.5">
                    <p className="px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-[#9c8e85]">Show columns</p>
                    <div className="max-h-72 overflow-y-auto">
                      {chooserCols.map(c => {
                        const shown = !hiddenKeys.has(c.key);
                        const locked = c.hideable === false;
                        return (
                          <button
                            key={c.key}
                            onClick={() => { if (!locked) toggleCol(c.key); }}
                            disabled={locked}
                            className={cn(
                              'w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-lg text-left transition-colors',
                              locked ? 'text-[#c4b8ab] cursor-default' : 'text-[#3d3128] hover:bg-[#faf7f2]',
                            )}
                          >
                            <span className={cn('w-4 h-4 rounded border flex items-center justify-center shrink-0', shown ? 'bg-[#cc5a16] border-[#cc5a16] text-white' : 'border-[#d4c4a8] bg-white')}>
                              {shown && <Check size={11} strokeWidth={3} />}
                            </span>
                            {c.label}{locked && <span className="ml-auto text-[9px] uppercase tracking-wide text-[#c4b8ab]">fixed</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          {!hideExport && (
            <button
              onClick={() => exportToCsv(sorted, visible, exportFilename)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#6b5d52] bg-white border border-[#e8dccf] rounded-xl hover:border-[#cc5a16]/50 hover:text-[#cc5a16] transition-colors"
              title="Export to CSV"
            >
              <Download size={13} />
              Export
            </button>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left border-collapse">
          <thead>
            <tr className="bg-[#faf7f2]/70 border-b border-[#cc5a16]/10">
              {visible.map(col => (
                <th
                  key={col.key}
                  onClick={col.sortable ? () => handleSort(col.key) : undefined}
                  className={cn(
                    headPad,
                    'text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] whitespace-nowrap',
                    col.sortable && 'cursor-pointer hover:text-[#cc5a16] select-none transition-colors',
                    col.align === 'right' && 'text-right',
                    col.align === 'center' && 'text-center',
                    col.headerClassName
                  )}
                >
                  <span className={cn('inline-flex items-center gap-1', col.align === 'right' && 'justify-end', col.align === 'center' && 'justify-center')}>
                    {col.label}
                    {col.sortable && (
                      sortCol === col.key
                        ? sortDir === 'asc'
                          ? <ChevronUp size={12} className="text-[#cc5a16] shrink-0" />
                          : <ChevronDown size={12} className="text-[#cc5a16] shrink-0" />
                        : <ChevronsUpDown size={12} className="opacity-25 shrink-0" />
                    )}
                  </span>
                </th>
              ))}
            </tr>
            {columnFilters && (
              <tr className="bg-white border-b border-[#f0ebe4]">
                {visible.map(col => (
                  <th key={col.key} className={cn(compact ? 'px-3 pb-2 pt-0' : 'px-4 pb-2.5 pt-0', 'align-top')}>
                    {col.filterable ? (
                      col.filterType === 'select' ? (
                        <select
                          value={colFilters[col.key] || ''}
                          onChange={e => setFilter(col.key, e.target.value)}
                          className="w-full text-xs border border-[#e8dccf] rounded-lg px-1.5 py-1 bg-white outline-none focus:ring-2 ring-[#cc5a16]/20 font-normal normal-case tracking-normal"
                        >
                          <option value="">All</option>
                          {(selectOptions[col.key] || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      ) : (
                        <div className="relative">
                          <input
                            value={colFilters[col.key] || ''}
                            onChange={e => setFilter(col.key, e.target.value)}
                            placeholder="Filter…"
                            className="w-full text-xs border border-[#e8dccf] rounded-lg px-1.5 py-1 pr-5 bg-white outline-none focus:ring-2 ring-[#cc5a16]/20 font-normal normal-case tracking-normal"
                          />
                          {colFilters[col.key] && (
                            <button onClick={() => setFilter(col.key, '')} className="absolute right-1 top-1/2 -translate-y-1/2 text-[#9c8e85] hover:text-[#cc5a16]"><X size={11} /></button>
                          )}
                        </div>
                      )
                    ) : null}
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody className="divide-y divide-[#f0ebe4]">
            {loading ? (
              <tr>
                <td colSpan={visible.length} className="py-14 text-center text-[#9c8e85] italic">
                  <div className="flex justify-center items-center gap-2">
                    <div className="w-4 h-4 border-2 border-[#cc5a16]/30 border-t-[#cc5a16] rounded-full animate-spin" />
                    Loading…
                  </div>
                </td>
              </tr>
            ) : paginated.length === 0 ? (
              <tr>
                <td colSpan={visible.length} className="py-14 text-center text-[#9c8e85] italic">{emptyMessage}</td>
              </tr>
            ) : paginated.map((row, i) => (
              <React.Fragment key={rowKey(row, (safePage - 1) * pageSize + i)}>
                <tr
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    'hover:bg-[#faf7f2]/60 transition-colors',
                    onRowClick && 'cursor-pointer',
                    rowClassName?.(row)
                  )}
                >
                  {visible.map(col => (
                    <td
                      key={col.key}
                      className={cn(
                        cellPad,
                        col.align === 'right' && 'text-right',
                        col.align === 'center' && 'text-center',
                        col.className
                      )}
                    >
                      {col.render ? col.render(row) : (() => { const v = getVal(row, col); return v == null || v === '' ? <span className="text-[#9c8e85]">—</span> : String(v); })()}
                    </td>
                  ))}
                </tr>
                {renderExpanded && isExpanded?.(row) && (
                  <tr className="bg-[#faf7f2]/40">
                    <td colSpan={visible.length} className="px-4 py-3">
                      {renderExpanded(row)}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Keep the bar (and its Rows-per-page selector) visible once the user has
          changed the page size, even if the larger size now fits on one page —
          otherwise the control that changed it disappears and can't be reverted. */}
      {!hidePagination && (totalPages > 1 || pageSize !== defaultPageSize) && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-[#f0ebe4] bg-[#faf7f2]/30 text-xs text-[#6b5d52]">
          <div className="flex items-center gap-2">
            <span className="text-[#9c8e85]">Rows per page:</span>
            <select
              value={pageSize}
              onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}
              className="bg-white border border-[#e8dccf] rounded-lg px-2 py-0.5 text-xs outline-none focus:ring-2 ring-[#cc5a16]/20"
            >
              {PAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[#9c8e85] mr-1">{(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, sorted.length)} of {sorted.length}</span>
            <button onClick={() => setPage(1)} disabled={safePage === 1} className="p-1 rounded hover:bg-[#e8dccf] disabled:opacity-30 transition-colors" title="First page">«</button>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={safePage === 1} className="p-1 rounded hover:bg-[#e8dccf] disabled:opacity-30 transition-colors">
              <ChevronLeft size={14} />
            </button>
            <span className="px-2 font-semibold">{safePage} / {totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={safePage === totalPages} className="p-1 rounded hover:bg-[#e8dccf] disabled:opacity-30 transition-colors">
              <ChevronRight size={14} />
            </button>
            <button onClick={() => setPage(totalPages)} disabled={safePage === totalPages} className="p-1 rounded hover:bg-[#e8dccf] disabled:opacity-30 transition-colors" title="Last page">»</button>
          </div>
        </div>
      )}
    </div>
  );
}
