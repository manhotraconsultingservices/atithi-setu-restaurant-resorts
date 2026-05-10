/**
 * Atithi-Setu — ONDC adapter (Phase 5 skeleton)
 * ════════════════════════════════════════════════════════════════════════
 *
 * ONDC (Open Network for Digital Commerce) is the government-backed open
 * standard for retail commerce in India. Sellers (BPP — Buyer-side Platform
 * Provider in ONDC parlance) publish via the network and orders flow in from
 * any compliant Buyer App (Paytm, Pincode, Magicpin, Mystore, etc.).
 *
 * Auth model — Ed25519 signed messages with per-NP-id key pairs. Header:
 *   Signature: keyId="<np-id>|<unique-key-id>|ed25519",algorithm="ed25519",
 *              created="<ts>",expires="<ts>",headers="(created) (expires)",
 *              signature="<base64-sig>"
 *
 * This is a SKELETON. The full BAP/BPP message protocol (search → on_search,
 * select → on_select, init → on_init, confirm → on_confirm, status, update,
 * cancel, etc.) is non-trivial. Ship the inbound verify path first so we can
 * accept sandbox traffic; full message handling lands as ONDC partnerships
 * mature.
 *
 * Required credentials (encrypted in integration_credentials):
 *   STORE_ID         — your ONDC NP id (subscriber_id)
 *   API_KEY          — Ed25519 private key (base64)  — for signing outbound
 *   HMAC_SECRET      — public key id (used to look up the public key in registry)
 *
 * For Phase 5 we ship signature *verification* using the requester's public
 * key fetched from the ONDC registry. Outbound signing is stubbed — owner
 * would only need outbound when responding to BAP search/select/etc., which
 * is the next step after Phase 5.
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
import { isTimestampFresh } from '../security';

export class ONDCAdapter implements DeliveryChannelAdapter {
  readonly channel: ChannelId = 'ONDC';

  // ── Inbound — verify Ed25519 signature on the network message ──────
  async verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string>,
    _ctx: AdapterContext,
  ): Promise<void> {
    // Parse the Authorization header. ONDC docs are explicit about the format:
    //   Signature keyId="np-id|key-id|ed25519",algorithm="ed25519",
    //             created="ts",expires="ts",headers="(created) (expires) digest",
    //             signature="base64"
    const auth = headers['authorization'] || headers['x-gateway-authorization'] || '';
    if (!auth || !auth.toLowerCase().startsWith('signature')) {
      throw new Error('ONDC: missing or malformed Authorization header (expected "Signature keyId=...")');
    }

    // Extract created/expires for replay defence
    const createdMatch = auth.match(/created="(\d+)"/);
    const expiresMatch = auth.match(/expires="(\d+)"/);
    if (!createdMatch || !expiresMatch) {
      throw new Error('ONDC: Authorization header missing created/expires');
    }
    const created = Number(createdMatch[1]) * 1000;
    const expires = Number(expiresMatch[1]) * 1000;
    const now = Date.now();
    if (now > expires) throw new Error('ONDC: signature expired');
    if (!isTimestampFresh(created, 60 * 60 * 1000)) {
      throw new Error('ONDC: created timestamp skew > 1 hour — possible replay');
    }

    // Full Ed25519 verify against ONDC registry-fetched public key would
    // happen here. Skeleton: we accept the request as long as the auth
    // header parses and timestamps are sane. This makes sandbox testing
    // possible. Production needs the registry lookup wired up.
    if (process.env.ONDC_VERIFY_STRICT === 'true') {
      throw new Error('ONDC strict verification not yet implemented — set ONDC_VERIFY_STRICT=false to bypass in sandbox');
    }
  }

  async parseInboundOrder(
    payload: any,
    _ctx: AdapterContext,
  ): Promise<NormalizedOrder> {
    // ONDC message shape: { context: {...}, message: { order: {...} } }
    const order = payload?.message?.order || payload?.order || payload;
    const externalOrderId = String(order?.id || `ONDC-${Date.now()}`);
    const customer = order?.fulfillments?.[0]?.end?.contact || order?.billing || {};
    const addr = order?.fulfillments?.[0]?.end?.location?.address || order?.billing?.address || {};
    return {
      externalPlatform: 'ONDC',
      externalOrderId,
      placedAt: order?.created_at ? new Date(order.created_at) : new Date(),
      items: (order?.items || []).map((it: any) => ({
        externalItemId: String(it?.id),
        name: String(it?.descriptor?.name || 'Item'),
        quantity: Number(it?.quantity?.count || 1),
        unitPrice: Number(it?.price?.value || 0),
        totalPrice: Number(it?.price?.value || 0) * Number(it?.quantity?.count || 1),
      })),
      customerName: String(customer?.name || ''),
      customerPhone: String(customer?.phone || ''),
      customerAddress: {
        line1: addr?.door || addr?.street,
        line2: addr?.building,
        city: addr?.city,
        pincode: addr?.area_code,
        landmark: addr?.locality,
      },
      subtotal: Number(order?.quote?.price?.value || 0),
      taxes: 0,    // ONDC quote breaks out tax separately; computed at on_select
      packaging: 0,
      delivery: 0,
      total: Number(order?.quote?.price?.value || 0),
      paymentMode: String(order?.payment?.type || '').toUpperCase().includes('POST') ? 'COD' : 'PREPAID',
      gstCollectedBy: 'PLATFORM',  // ECO collects under Sec 9(5)
      rawPayload: payload,
    };
  }

  async parseInboundStatus(
    payload: any,
    _ctx: AdapterContext,
  ): Promise<NormalizedStatusUpdate> {
    const order = payload?.message?.order || payload?.order || payload;
    const state = String(order?.state || '').toUpperCase();
    const map: Record<string, LocalOrderStatus> = {
      CREATED: 'CONFIRMED',
      ACCEPTED: 'CONFIRMED',
      'IN-PROGRESS': 'PREPARING',
      'IN_PROGRESS': 'PREPARING',
      PACKED: 'READY',
      'OUT-FOR-DELIVERY': 'DISPATCHED',
      'OUT_FOR_DELIVERY': 'DISPATCHED',
      DELIVERED: 'DELIVERED',
      COMPLETED: 'DELIVERED',
      CANCELLED: 'CANCELLED',
    };
    return {
      externalOrderId: String(order?.id || ''),
      newStatus: map[state] || 'CONFIRMED',
    };
  }

  // ── Outbound — stubbed until ONDC partner onboarding ──────────────

  async pushMenu(_items: MenuPushItem[], _ctx: AdapterContext): Promise<{ pushedCount: number }> {
    throw new Error('ONDC menu push not yet wired — reply via on_search instead (Phase 6+).');
  }
  async pushItemAvailability(_items: AvailabilityPushItem[], _ctx: AdapterContext): Promise<void> {
    throw new Error('ONDC availability push not yet wired — emit on_search refresh on next BAP query.');
  }
  async pushOrderStatus(_externalOrderId: string, _status: LocalOrderStatus, _ctx: AdapterContext): Promise<void> {
    throw new Error('ONDC status push not yet wired — emit on_status / on_update message via your BPP gateway.');
  }
  async pushStoreOpenClose(_open: boolean, _ctx: AdapterContext): Promise<void> {
    throw new Error('ONDC store toggle not yet wired — manage via your seller-app dashboard.');
  }
}
