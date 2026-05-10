/**
 * Atithi-Setu — Zomato Direct Partner adapter (Phase 5 scaffold)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Zomato POS Partner API. Requires direct Zomato Partner onboarding for
 * the outlet. Until onboarded, methods throw a clear "not onboarded" error
 * so the queue dead-letters with useful guidance.
 *
 * Required credentials when onboarded:
 *   API_KEY      — Zomato partner API key
 *   HMAC_SECRET  — webhook signing secret
 *   STORE_ID     — Zomato res_id (numeric)
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

const NOT_ONBOARDED = (op: string) =>
  new Error(`Zomato direct adapter: ${op} not yet onboarded as a Zomato Partner. Use UrbanPiper aggregator path until BD signs off.`);

export class ZomatoDirectAdapter implements DeliveryChannelAdapter {
  readonly channel: ChannelId = 'ZOMATO';

  async verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string>,
    ctx: AdapterContext,
  ): Promise<void> {
    const sig = headers['x-zomato-signature'] || headers['x-signature'];
    const ts = headers['x-zomato-timestamp'] || headers['x-timestamp'];
    if (!sig) throw new Error('Zomato: missing X-Zomato-Signature header');
    if (ts && !isTimestampFresh(Number(ts) * (String(ts).length <= 10 ? 1000 : 1))) {
      throw new Error('Zomato: timestamp skew > 5 min');
    }
    const secret = ctx.credentials?.HMAC_SECRET;
    if (!secret) throw new Error('Zomato: HMAC_SECRET not configured');
    if (!verifyHmacSha256(rawBody, String(sig), secret, 'sha256')) {
      throw new Error('Zomato: HMAC verification failed');
    }
  }

  async parseInboundOrder(_payload: any, _ctx: AdapterContext): Promise<NormalizedOrder> {
    throw NOT_ONBOARDED('parseInboundOrder');
  }
  async parseInboundStatus(_payload: any, _ctx: AdapterContext): Promise<NormalizedStatusUpdate> {
    throw NOT_ONBOARDED('parseInboundStatus');
  }
  async pushMenu(_items: MenuPushItem[], _ctx: AdapterContext): Promise<{ pushedCount: number }> {
    throw NOT_ONBOARDED('pushMenu');
  }
  async pushItemAvailability(_items: AvailabilityPushItem[], _ctx: AdapterContext): Promise<void> {
    throw NOT_ONBOARDED('pushItemAvailability');
  }
  async pushOrderStatus(_externalOrderId: string, _status: LocalOrderStatus, _ctx: AdapterContext): Promise<void> {
    throw NOT_ONBOARDED('pushOrderStatus');
  }
  async pushStoreOpenClose(_open: boolean, _ctx: AdapterContext): Promise<void> {
    throw NOT_ONBOARDED('pushStoreOpenClose');
  }
}
