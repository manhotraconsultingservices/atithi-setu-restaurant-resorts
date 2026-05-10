/**
 * Atithi-Setu — Swiggy Direct Partner adapter (Phase 5 scaffold)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Swiggy POS Partner Program. Requires the restaurant to be onboarded
 * directly with Swiggy (not via UrbanPiper) — months of BD per outlet.
 * Until that onboarding lands, all methods throw a clear "not onboarded"
 * error so the queue worker dead-letters them with a useful message.
 *
 * Required credentials when onboarded:
 *   API_KEY      — Swiggy partner API key
 *   HMAC_SECRET  — webhook signing secret
 *   STORE_ID     — Swiggy restaurant id (numeric)
 *
 * The signature-verification path is implemented (so sandbox testing works
 * once Swiggy provisions us a sandbox account); the outbound calls remain
 * scaffolded.
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
  new Error(`Swiggy direct adapter: ${op} not yet onboarded as a Swiggy POS partner. Use UrbanPiper aggregator path until BD signs off.`);

export class SwiggyDirectAdapter implements DeliveryChannelAdapter {
  readonly channel: ChannelId = 'SWIGGY';

  async verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string>,
    ctx: AdapterContext,
  ): Promise<void> {
    const sig = headers['x-swiggy-signature'] || headers['x-signature'];
    const ts = headers['x-swiggy-timestamp'] || headers['x-timestamp'];
    if (!sig) throw new Error('Swiggy: missing X-Swiggy-Signature header');
    if (ts && !isTimestampFresh(Number(ts) * (String(ts).length <= 10 ? 1000 : 1))) {
      throw new Error('Swiggy: timestamp skew > 5 min');
    }
    const secret = ctx.credentials?.HMAC_SECRET;
    if (!secret) throw new Error('Swiggy: HMAC_SECRET not configured');
    if (!verifyHmacSha256(rawBody, String(sig), secret, 'sha256')) {
      throw new Error('Swiggy: HMAC verification failed');
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
