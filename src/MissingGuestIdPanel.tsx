// Event guests who were checked in automatically without an ID document on
// file. Shown to the front desk on Hotel Bookings until every ID is collected;
// renders nothing when the list is empty.
import React, { useEffect, useState } from 'react';
import { DataTable } from './components/DataTable';
import { useT } from './i18n';

export function MissingGuestIdPanel({ restaurantId, token }: { restaurantId: string; token: string }) {
  const { t } = useT();
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    let alive = true;
    fetch(`/api/restaurant/${restaurantId}/hotel/reports/missing-guest-id`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : { rows: [] }))
      .then(d => { if (alive) setRows(Array.isArray(d?.rows) ? d.rows : []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [restaurantId, token]);
  if (!rows.length) return null;
  return (
    <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between text-left">
        <span className="font-bold text-sm text-amber-900">{t('hotel.missingId.title', { n: rows.length })}</span>
        <span className="text-xs text-amber-800">{open ? '▲' : '▼'}</span>
      </button>
      <p className="text-xs text-amber-800 mt-1">{t('hotel.missingId.sub')}</p>
      {open && (
        <div className="mt-3 bg-white rounded-xl">
          <DataTable
            data={rows}
            rowKey={(r: any) => r.id}
            columnChooser columnFilters tableId="hotel-missing-guest-id"
            exportFilename="event-guests-missing-id"
            columns={[
              { key: 'room_name', label: t('hotel.missingId.room'), sortable: true, searchable: true, getValue: (r: any) => r.room_name || (r.room_number ? `Room ${r.room_number}` : '—') },
              { key: 'guest_name', label: t('hotel.missingId.guest'), sortable: true, searchable: true },
              { key: 'guest_phone', label: t('hotel.missingId.phone'), searchable: true, hideable: true },
              { key: 'event_customer', label: t('hotel.missingId.event'), sortable: true, filterable: true, filterType: 'select',
                filterOptions: [...new Set(rows.map((r: any) => r.event_customer || '—'))].sort().map((v: any) => ({ value: v, label: v })),
                getValue: (r: any) => r.event_customer || '—' },
              { key: 'check_in_date', label: t('hotel.missingId.checkIn'), sortable: true },
              { key: 'check_out_date', label: t('hotel.missingId.checkOut'), sortable: true, hideable: true },
            ]}
          />
        </div>
      )}
    </div>
  );
}
