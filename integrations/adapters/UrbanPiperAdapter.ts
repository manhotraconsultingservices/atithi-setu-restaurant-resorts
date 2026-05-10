/**
 * Atithi-Setu — UrbanPiper adapter (Phase 5)
 * ════════════════════════════════════════════════════════════════════════
 *
 * UrbanPiper is the POS-aggregator middleware that ships with contracts
 * already negotiated for Swiggy / Zomato / Dunzo / Magicpin / Foodpanda /
 * etc. One integration, all platforms — at the cost of UrbanPiper's
 * per-outlet monthly fee for the restaurant.
 *
 *   Inbound:  Webhooks signed with HMAC-SHA256 on header "X-Up-Signature"
 *             Body shape: UrbanPiper unified order schema (NOT raw Swiggy).
 *   Outbound: REST API at https://api.urbanpiper.com (or staging variant).
 *             Auth: Bearer <api-key> + biz_id + location_id.
 *
 * Required credentials (stored encrypted in integration_credentials):
 *   API_KEY      — UrbanPiper API key from their merchant portal
 *   HMAC_SECRET  — webhook signing secret
 *   STORE_ID     — UrbanPiper's location/biz_id for this outlet
 *
 * NOTE: This implementation is calibrated against the public UrbanPiper
 * docs as of late 2025 / 2026. UrbanPiper may version their API; if a
 * new version ships, version-pin via the API_KEY metadata field rather
 * than mutating this file.
 */

import type {
  AdapterContext,
  AvailabilityPushItem,
  ChannelId,
  DeliveryChannelAdapter,
  LocalOrderStatus,
  MenuPushItem,
  NormalizedOrder,
  NormalizedStatusUpdate,
} from '../types';
import { verifyHmacSha256, isTimestampFresh } from '../security';

const URBANPIPER_BASE_URL_DEFAULT = 'https://api.urbanpiper.com';

export class UrbanPiperAdapter implements DeliveryChannelAdapter {
  readonly channel: ChannelId = 'URBANPIPER';

  private baseUrl(ctx: AdapterContext): string {
    return process.env.URBANPIPER_BASE_URL || URBANPIPER_BASE_URL_DEFAULT;
  }

  private requireCred(ctx: AdapterContext, key: 'API_KEY' | 'HMAC_SECRET' | 'STORE_ID'): string {
    const v = ctx.credentials?.[key];
    if (!v) throw new Error(`UrbanPiper: missing credential ${key} (configure under Settings → Integrations → UrbanPiper)`);
    return v;
  }

  private async upFetch(
    ctx: AdapterContext,
    path: string,
    init: { method: string; body?: any } = { method: 'GET' },
  ): Promise<any> {
    const apiKey = this.requireCred(ctx, 'API_KEY');
    const url = `${this.baseUrl(ctx)}${path}`;
    const res = await fetch(url, {
      method: init.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `apikey ${apiKey}`,
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let body: any; try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) {
      const msg = typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200);
      throw new Error(`UrbanPiper ${init.method} ${path} → ${res.status}: ${msg}`);
    }
    return body;
  }

  // ── Inbound ─────────────────────────────────────────────────────────

  async verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string>,
    ctx: AdapterContext,
  ): Promise<void> {
    const sig = headers['x-up-signature'] || headers['x-urbanpiper-signature'] || headers['x-signature'];
    if (!sig) throw new Error('UrbanPiper: missing X-Up-Signature header');
    const ts = headers['x-up-timestamp'] || headers['x-timestamp'];
    if (ts) {
      const tsMs = Number(ts) * (String(ts).length <= 10 ? 1000 : 1);
      if (!isTimestampFresh(tsMs)) {
        throw new Error('UrbanPiper: timestamp skew > 5 min — possible replay');
      }
    }
    const secret = this.requireCred(ctx, 'HMAC_SECRET');
    if (!verifyHmacSha256(rawBody, String(sig), secret, 'sha256')) {
      throw new Error('UrbanPiper: HMAC verification failed');
    }
  }

  async parseInboundOrder(
    payload: any,
    _ctx: AdapterContext,
  ): Promise<NormalizedOrder> {
    // UrbanPiper unified order shape — see their docs. We map the parts we
    // care about and pass the rest through in rawPayload.
    const order = payload?.order || payload;
    const externalOrderId = String(order?.id || order?.order_id || `UP-${Date.now()}`);
    // Source platform (SWIGGY / ZOMATO / DUNZO / etc.) lives in order.channel
    // — but we still attribute the order to URBANPIPER as the integration channel.
    return {
      externalPlatform: 'URBANPIPER',
      externalOrderId,
      placedAt: order?.placed_time ? new Date(order.placed_time) : new Date(),
      items: (order?.items || []).map((it: any) => ({
        externalItemId: String(it?.id || it?.item_id),
        name: String(it?.title || it?.name || 'Item'),
        quantity: Number(it?.quantity || 1),
        size: it?.size?.toUpperCase?.() === 'HALF' ? 'HALF' : 'FULL',
        unitPrice: Number(it?.price || 0),
        totalPrice: Number(it?.total || (Number(it?.price || 0) * Number(it?.quantity || 1))),
        modifiers: Array.isArray(it?.modifiers)
          ? it.modifiers.map((m: any) => ({ name: String(m?.name || ''), price: Number(m?.price || 0) }))
          : undefined,
      })),
      customerName: String(order?.customer?.name || order?.customer_name || ''),
      customerPhone: String(order?.customer?.phone || order?.customer_phone || ''),
      customerAddress: {
        line1: order?.delivery_address?.line_1 || order?.delivery_address?.line1,
        line2: order?.delivery_address?.line_2 || order?.delivery_address?.line2,
        city: order?.delivery_address?.city,
        pincode: order?.delivery_address?.zipcode || order?.delivery_address?.pincode,
        landmark: order?.delivery_address?.landmark,
        lat: order?.delivery_address?.latitude || order?.delivery_address?.lat,
        lng: order?.delivery_address?.longitude || order?.delivery_address?.lng,
      },
      subtotal: Number(order?.sub_total || order?.subtotal || 0),
      taxes: Number(order?.taxes || order?.tax || 0),
      packaging: Number(order?.packaging_charges || 0),
      delivery: Number(order?.delivery_charges || 0),
      total: Number(order?.order_total || order?.total || 0),
      paymentMode: String(order?.payment_mode || '').toUpperCase().includes('PREPAID') ? 'PREPAID' : 'COD',
      // Sec 9(5): aggregator collects GST on customer's behalf
      gstCollectedBy: 'PLATFORM',
      commissionAmount: Number(order?.commission_amount || 0),
      netPayoutAmount: Number(order?.net_payout || 0),
      rider: order?.rider ? { name: order.rider.name, phone: order.rider.phone } : undefined,
      rawPayload: payload,
    };
  }

  async parseInboundStatus(
    payload: any,
    _ctx: AdapterContext,
  ): Promise<NormalizedStatusUpdate> {
    const externalOrderId = String(payload?.order_id || payload?.id || '');
    const raw = String(payload?.status || payload?.new_status || '').toUpperCase();
    // UrbanPiper status enum → our LocalOrderStatus
    const map: Record<string, LocalOrderStatus> = {
      PLACED: 'CONFIRMED',
      ACCEPTED: 'CONFIRMED',
      ACKNOWLEDGED: 'CONFIRMED',
      FOOD_READY: 'READY',
      READY: 'READY',
      OUT_FOR_DELIVERY: 'DISPATCHED',
      DISPATCHED: 'DISPATCHED',
      DELIVERED: 'DELIVERED',
      COMPLETED: 'DELIVERED',
      CANCELLED: 'CANCELLED',
      CANCELED: 'CANCELLED',
    };
    const newStatus = map[raw] || 'CONFIRMED';
    return {
      externalOrderId,
      newStatus,
      rider: payload?.rider ? { name: payload.rider.name, phone: payload.rider.phone } : undefined,
    };
  }

  // ── Outbound ────────────────────────────────────────────────────────

  async pushMenu(items: MenuPushItem[], ctx: AdapterContext): Promise<{ pushedCount: number }> {
    const storeId = this.requireCred(ctx, 'STORE_ID');
    // UrbanPiper accepts batched menu updates. Map our internal MenuPushItem
    // to their item schema. They use "ref_id" for the merchant's stable id.
    const body = {
      biz_id: storeId,
      items: items.map(it => ({
        ref_id: it.localMenuItemId,           // our menu.id — stable
        title: it.name,
        description: it.description || '',
        price: it.price,
        category: it.category,
        available: !!it.isAvailable,
        image_url: it.imageUrl || undefined,
        food_type: it.dietaryType === 'NON_VEG' ? 'non_vegetarian'
                : it.dietaryType === 'VEGAN'   ? 'vegan'
                : 'vegetarian',
        external_id: it.externalItemId || undefined,  // UrbanPiper's id if known
      })),
    };
    await this.upFetch(ctx, `/external/api/v1/inventory/items/`, { method: 'POST', body });
    return { pushedCount: items.length };
  }

  async pushItemAvailability(items: AvailabilityPushItem[], ctx: AdapterContext): Promise<void> {
    const storeId = this.requireCred(ctx, 'STORE_ID');
    const body = {
      biz_id: storeId,
      items: items.map(it => ({
        ref_id: it.externalItemId,
        available: !!it.isAvailable,
      })),
    };
    await this.upFetch(ctx, `/external/api/v1/inventory/availability/`, { method: 'POST', body });
  }

  async pushOrderStatus(externalOrderId: string, status: LocalOrderStatus, ctx: AdapterContext): Promise<void> {
    const storeId = this.requireCred(ctx, 'STORE_ID');
    // Inverse mapping: our status → UrbanPiper enum
    const map: Record<LocalOrderStatus, string> = {
      CONFIRMED: 'Acknowledged',
      PREPARING: 'Food Ready',     // UrbanPiper doesn't always have a separate PREPARING
      READY: 'Food Ready',
      DISPATCHED: 'Dispatched',
      DELIVERED: 'Completed',
      CANCELLED: 'Cancelled',
    };
    await this.upFetch(ctx, `/external/api/v1/orders/${externalOrderId}/status/`, {
      method: 'POST',
      body: {
        biz_id: storeId,
        new_status: map[status],
      },
    });
  }

  async pushStoreOpenClose(open: boolean, ctx: AdapterContext): Promise<void> {
    const storeId = this.requireCred(ctx, 'STORE_ID');
    await this.upFetch(ctx, `/external/api/v1/store/${storeId}/`, {
      method: 'PATCH',
      body: { is_active: open },
    });
  }
}
