// On a hotel booking made for an EVENT, the room is paid on the event's invoice,
// not at the hotel. Shown in place of the hotel "Advance paid / Outstanding" rows,
// so the desk never sees the room price as owed when the event has been paid.
import React, { useEffect, useState } from 'react';
import { useT } from './i18n';

export function EventRoomBilling({ restaurantId, token, bookingId }: { restaurantId: string; token: string; bookingId: string }) {
  const { t } = useT();
  const [ev, setEv] = useState<any>(undefined);
  useEffect(() => {
    let alive = true;
    fetch(`/api/restaurant/${restaurantId}/hotel/bookings/${encodeURIComponent(bookingId)}/event-billing`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : { event: null }))
      .then(d => { if (alive) setEv(d?.event || null); })
      .catch(() => { if (alive) setEv(null); });
    return () => { alive = false; };
  }, [restaurantId, token, bookingId]);
  const inr = (n: any) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  return (
    <>
      <div className="px-4 py-2 text-[12px] bg-indigo-50/60">
        <span className="font-bold text-indigo-900">{t('hotel.eventBilling.title')}</span>
        {ev && <span className="text-indigo-800"> · {ev.customer_name}{ev.event_type ? ` (${ev.event_type})` : ''}</span>}
        <div className="text-[11px] text-indigo-800/80">{t('hotel.eventBilling.sub')}</div>
      </div>
      {ev && (
        <>
          <div className="flex justify-between px-4 py-2 text-[12px]"><span className="text-[#6b5d52]">{t('hotel.eventBilling.total')}</span><span className="font-mono font-bold">{inr(ev.total)}</span></div>
          <div className="flex justify-between px-4 py-2 text-[12px]"><span className="text-[#6b5d52]">{t('hotel.eventBilling.paid')}</span><span className="font-mono font-bold text-emerald-700">{inr(ev.paid)}</span></div>
          <div className="flex justify-between px-4 py-2 text-[12px]"><span className="text-[#6b5d52]">{t('hotel.eventBilling.balance')}</span><span className={`font-mono font-bold ${ev.balance > 0 ? 'text-rose-600' : 'text-emerald-700'}`}>{inr(ev.balance)}</span></div>
        </>
      )}
    </>
  );
}
