/**
 * Atithi-Setu — MockAdapter for E2E tests
 * ════════════════════════════════════════════════════════════════════════
 *
 * Synthetic adapter that mirrors the DeliveryChannelAdapter contract without
 * calling any external service. Use it to exercise the full inbound webhook
 * → KDS → status push pipeline in CI and local dev without depending on
 * Swiggy / Zomato / UrbanPiper sandbox availability.
 *
 * Signature verification uses a simple HMAC-SHA256 with `MOCK_SECRET` so we
 * can replay the realistic verify-then-process flow.
 */

import type {
  AdapterContext,
  AvailabilityPushItem,
  DeliveryChannelAdapter,
  LocalOrderStatus,
  MenuPushItem,
  NormalizedOrder,
  NormalizedStatusUpdate,
} from '../types';
import { verifyHmacSha256 } from '../security';

const MOCK_SECRET_DEFAULT = 'mock-secret-do-not-use-in-prod';

/**
 * In-memory log of every outbound call. Tests assert against this.
 */
export interface MockAdapterCallLog {
  type: 'pushMenu' | 'pushItemAvailability' | 'pushOrderStatus' | 'pushStoreOpenClose';
  payload: any;
  at: Date;
}

export class MockAdapter implements DeliveryChannelAdapter {
  // The mock pretends to be URBANPIPER so the existing channel registry can
  // resolve it. Tests re-register the real UrbanPiperAdapter to swap.
  readonly channel = 'URBANPIPER' as const;

  private readonly secret: string;
  public readonly callLog: MockAdapterCallLog[] = [];

  constructor(opts: { secret?: string } = {}) {
    this.secret = opts.secret || MOCK_SECRET_DEFAULT;
  }

  // ── Inbound ──

  async verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string>,
    _ctx: AdapterContext,
  ): Promise<void> {
    const sig = headers['x-mock-signature'] || headers['X-Mock-Signature'] || '';
    const ok = verifyHmacSha256(rawBody, sig, this.secret, 'sha256');
    if (!ok) throw new Error('MockAdapter signature verification failed');
  }

  async parseInboundOrder(
    payload: any,
    _ctx: AdapterContext,
  ): Promise<NormalizedOrder> {
    // Expected mock payload shape: { externalOrderId, items[], customer, totals }
    return {
      externalPlatform: 'URBANPIPER',
      externalOrderId: String(payload.externalOrderId || `MOCK-${Date.now()}`),
      placedAt: payload.placedAt ? new Date(payload.placedAt) : new Date(),
      items: (payload.items || []).map((it: any) => ({
        externalItemId: String(it.externalItemId || it.id),
        localMenuItemId: it.localMenuItemId,
        name: String(it.name || 'Mock Item'),
        quantity: Number(it.quantity || 1),
        size: it.size,
        unitPrice: Number(it.unitPrice || it.price || 0),
        totalPrice: Number(it.totalPrice || (Number(it.unitPrice || 0) * Number(it.quantity || 1))),
        modifiers: it.modifiers,
      })),
      customerName: String(payload.customer?.name || 'Mock Customer'),
      customerPhone: String(payload.customer?.phone || '9999999999'),
      customerAddress: payload.customer?.address || {
        line1: '123 Mock Street', city: 'Mock City', pincode: '110001',
      },
      subtotal: Number(payload.totals?.subtotal || 0),
      taxes: Number(payload.totals?.taxes || 0),
      packaging: Number(payload.totals?.packaging || 0),
      delivery: Number(payload.totals?.delivery || 0),
      total: Number(payload.totals?.total || 0),
      paymentMode: (payload.paymentMode || 'PREPAID') as 'PREPAID' | 'COD',
      gstCollectedBy: (payload.gstCollectedBy || 'PLATFORM') as 'RESTAURANT' | 'PLATFORM',
      commissionAmount: payload.commissionAmount,
      netPayoutAmount: payload.netPayoutAmount,
      rider: payload.rider,
      rawPayload: payload,
    };
  }

  async parseInboundStatus(
    payload: any,
    _ctx: AdapterContext,
  ): Promise<NormalizedStatusUpdate> {
    return {
      externalOrderId: String(payload.externalOrderId),
      newStatus: String(payload.newStatus).toUpperCase() as LocalOrderStatus,
      rider: payload.rider,
    };
  }

  // ── Outbound ──

  async pushMenu(
    items: MenuPushItem[],
    _ctx: AdapterContext,
  ): Promise<{ pushedCount: number }> {
    this.callLog.push({ type: 'pushMenu', payload: { items }, at: new Date() });
    return { pushedCount: items.length };
  }

  async pushItemAvailability(
    items: AvailabilityPushItem[],
    _ctx: AdapterContext,
  ): Promise<void> {
    this.callLog.push({ type: 'pushItemAvailability', payload: { items }, at: new Date() });
  }

  async pushOrderStatus(
    externalOrderId: string,
    status: LocalOrderStatus,
    _ctx: AdapterContext,
  ): Promise<void> {
    this.callLog.push({
      type: 'pushOrderStatus',
      payload: { externalOrderId, status },
      at: new Date(),
    });
  }

  async pushStoreOpenClose(
    open: boolean,
    _ctx: AdapterContext,
  ): Promise<void> {
    this.callLog.push({ type: 'pushStoreOpenClose', payload: { open }, at: new Date() });
  }

  /** Test helper — clear the call log between assertions. */
  clearCallLog(): void {
    this.callLog.length = 0;
  }
}
