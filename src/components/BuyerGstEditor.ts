// Buyer GST details (GSTIN + registered address) for a guest or company claiming
// input tax credit. One editor for every bill: restaurant invoices, PMS guest
// bills, event bookings, wellness invoices. The server applies the same rules
// on every route (_readBuyerGstDetails): a malformed GSTIN or a GSTIN without an
// address is refused; clearing the GSTIN turns the bill back into a B2C one.
import { usePaymentDialog } from './PaymentDialog';
import { useToast } from './Toast';
import { useT } from '../i18n';

export type BuyerGstTarget =
  | { kind: 'RESTAURANT_SESSION'; token: string }
  | { kind: 'RESTAURANT_ORDER'; id: string }
  | { kind: 'HOTEL_FOLIO'; id: string }
  | { kind: 'SPA_FOLIO'; id: string }
  | { kind: 'EVENT_BOOKING'; id: string };

function urlFor(restaurantId: string, t: BuyerGstTarget): string {
  const base = `/api/restaurant/${restaurantId}`;
  switch (t.kind) {
    case 'RESTAURANT_SESSION': return `${base}/invoices/session/${encodeURIComponent(t.token)}/gst-details`;
    case 'RESTAURANT_ORDER': return `${base}/invoices/order/${encodeURIComponent(t.id)}/gst-details`;
    case 'HOTEL_FOLIO': return `${base}/hotel/folios/${encodeURIComponent(t.id)}/gst-details`;
    case 'SPA_FOLIO': return `${base}/spa/folios/${encodeURIComponent(t.id)}/gst-details`;
    case 'EVENT_BOOKING': return `${base}/events/bookings/${encodeURIComponent(t.id)}/gst-details`;
  }
}

/** Returns edit(target, current, onSaved): prompts, saves, toasts. */
export function useBuyerGstEditor(restaurantId: string, token: string) {
  const prompt = usePaymentDialog();
  const toast = useToast();
  const { t } = useT();
  return async (target: BuyerGstTarget, current: { gstin?: string | null; address?: string | null }, onSaved?: () => void) => {
    const r = await prompt({
      title: current.gstin ? t('gst.editTitle') : t('gst.addTitle'),
      body: t('gst.body'),
      fields: [
        { name: 'gstin', label: t('gst.gstin'), type: 'text', placeholder: '27AAPFU0939F1ZV', defaultValue: current.gstin || '' },
        { name: 'address', label: t('gst.address'), type: 'textarea', placeholder: t('gst.addressPlaceholder'), defaultValue: current.address || '' },
      ],
      confirmLabel: t('gst.save'),
    });
    if (!r) return;
    try {
      const res = await fetch(urlFor(restaurantId, target), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ customer_gstin: String(r.gstin || '').trim().toUpperCase(), customer_address: String(r.address || '').trim() }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d?.error || t('gst.saveFailed'));
      toast.success(d.customer_gstin ? t('gst.saved', { gstin: d.customer_gstin }) : t('gst.cleared'));
      onSaved?.();
    } catch (err: any) { toast.error(err.message); }
  };
}
