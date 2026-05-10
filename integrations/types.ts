/**
 * Atithi-Setu — Multi-platform delivery integration: shared types
 * ════════════════════════════════════════════════════════════════════════
 *
 * Pure-data interfaces, no Express / DB imports. Adapter implementations
 * are pluggable; one concrete adapter per delivery platform consumes these
 * types and is registered in `integrations/registry.ts` at server boot.
 *
 * The orders table extension columns these types map to:
 *   external_platform   → ChannelId
 *   external_order_id   → string
 *   external_id_hash    → sha256(platform || ':' || external_order_id)
 *   external_payload    → NormalizedOrder.rawPayload (JSONB)
 *   commission_amount   → NormalizedOrder.commissionAmount
 *   net_payout_amount   → NormalizedOrder.netPayoutAmount
 *   gst_collected_by    → NormalizedOrder.gstCollectedBy
 *   rider_name/phone    → NormalizedOrder.rider.{name, phone}
 */

export type ChannelId =
  | 'SWIGGY'
  | 'ZOMATO'
  | 'DUNZO'
  | 'MAGICPIN'
  | 'ONDC'
  | 'URBANPIPER';

/** All valid channel ids — runtime-iterable mirror of the type union. */
export const ALL_CHANNEL_IDS: readonly ChannelId[] = [
  'SWIGGY', 'ZOMATO', 'DUNZO', 'MAGICPIN', 'ONDC', 'URBANPIPER',
] as const;

export type LocalOrderStatus =
  | 'CONFIRMED'
  | 'PREPARING'
  | 'READY'
  | 'DISPATCHED'
  | 'DELIVERED'
  | 'CANCELLED';

export type GstCollector = 'RESTAURANT' | 'PLATFORM';

export type PaymentMode = 'PREPAID' | 'COD';

// ─── Inbound: order ingestion ─────────────────────────────────────────────

export interface NormalizedOrderItem {
  /** Platform's id for this item (Swiggy item id, etc.). Required. */
  externalItemId: string;
  /**
   * Resolved by the inbound webhook handler from menu.external_ids.
   * Adapters MAY pre-resolve if convenient, but it's not required.
   * Items where this stays undefined trigger an ITEM_MAPPING_ALERT.
   */
  localMenuItemId?: string;
  name: string;
  quantity: number;
  size?: 'HALF' | 'FULL';
  unitPrice: number;
  totalPrice: number;
  modifiers?: Array<{ name: string; price: number }>;
}

export interface NormalizedOrderAddress {
  line1?: string;
  line2?: string;
  city?: string;
  pincode?: string;
  landmark?: string;
  lat?: number;
  lng?: number;
}

export interface NormalizedOrderRider {
  name?: string;
  phone?: string;
}

export interface NormalizedOrder {
  externalPlatform: ChannelId;
  externalOrderId: string;
  placedAt: Date;
  items: NormalizedOrderItem[];
  customerName: string;
  customerPhone: string;
  customerAddress: NormalizedOrderAddress;
  /** Pre-tax pre-delivery total. */
  subtotal: number;
  /** Total taxes collected on the bill. */
  taxes: number;
  packaging: number;
  delivery: number;
  /** Customer-paid total. */
  total: number;
  paymentMode: PaymentMode;
  /**
   * Sec 9(5) of CGST Act — for ECO-collected orders the platform remits GST
   * on the restaurant's behalf, so the books need to treat that revenue line
   * differently. Adapters should set this based on the platform contract.
   */
  gstCollectedBy: GstCollector;
  /** Platform's commission cut on this order, in INR. */
  commissionAmount?: number;
  /** Net payout the restaurant will receive after commission. */
  netPayoutAmount?: number;
  rider?: NormalizedOrderRider;
  /** The raw inbound payload — persisted to orders.external_payload for forensics. */
  rawPayload: any;
}

// ─── Inbound: status update ───────────────────────────────────────────────

export interface NormalizedStatusUpdate {
  externalOrderId: string;
  newStatus: LocalOrderStatus;
  rider?: NormalizedOrderRider;
}

// ─── Outbound: menu push ──────────────────────────────────────────────────

export interface MenuPushItem {
  /** menu.id in our DB. */
  localMenuItemId: string;
  /** Platform's existing id for this item (from menu.external_ids), if known. */
  externalItemId?: string;
  name: string;
  description?: string;
  /** Already-marked-up channel price (computed at enqueue time). */
  price: number;
  category: string;
  isAvailable: boolean;
  imageUrl?: string;
  dietaryType?: 'VEG' | 'VEGAN' | 'NON_VEG';
}

export interface AvailabilityPushItem {
  externalItemId: string;
  isAvailable: boolean;
}

// ─── Adapter context ──────────────────────────────────────────────────────

/**
 * Per-call context passed to every adapter method. Built freshly on each
 * call site so credentials are decrypted just-in-time and never linger.
 */
export interface AdapterContext {
  restaurantId: string;
  /** Row from channel_settings (default markup, commission %, etc.). */
  channelSettings: {
    channel: ChannelId;
    is_active: number;
    default_markup_percent: number;
    commission_percent: number;
    packaging_charge: number;
    min_order_amount: number;
    prep_time_minutes: number;
    webhook_url_inbound: string | null;
    brand_display_name: string | null;
    min_margin_floor_percent: number;
  };
  /**
   * Decrypted credentials, keyed by credential_type.
   * e.g. { API_KEY: '...', HMAC_SECRET: '...', STORE_ID: '...' }.
   * The webhook handler decrypts via integrations/security.ts before
   * constructing this context.
   */
  credentials: Record<string, string>;
}

// ─── Adapter contract ─────────────────────────────────────────────────────

export interface DeliveryChannelAdapter {
  readonly channel: ChannelId;

  // ── Inbound ──

  /**
   * Verify the HMAC / JWT / Ed25519 / channel-specific signature on the raw
   * webhook body. Throws on failure (caller catches and 401s the response).
   * Should also reject timestamp skew > 5 min where the platform supports it.
   */
  verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string>,
    ctx: AdapterContext,
  ): Promise<void>;

  /**
   * Translate platform-specific order payload to our NormalizedOrder shape.
   * Adapter MAY pre-resolve localMenuItemId via menu.external_ids; the
   * webhook handler will resolve any items the adapter left undefined.
   */
  parseInboundOrder(
    payload: any,
    ctx: AdapterContext,
  ): Promise<NormalizedOrder>;

  /**
   * Translate a status / rider / cancellation webhook into our normalised shape.
   */
  parseInboundStatus(
    payload: any,
    ctx: AdapterContext,
  ): Promise<NormalizedStatusUpdate>;

  // ── Outbound ──

  /** Push the full menu (called when many items go dirty at once). */
  pushMenu(
    items: MenuPushItem[],
    ctx: AdapterContext,
  ): Promise<{ pushedCount: number }>;

  /** Toggle availability for one or more items (e.g. when stock hits zero). */
  pushItemAvailability(
    items: AvailabilityPushItem[],
    ctx: AdapterContext,
  ): Promise<void>;

  /** Notify the platform that the order has progressed (READY, DELIVERED, …). */
  pushOrderStatus(
    externalOrderId: string,
    status: LocalOrderStatus,
    ctx: AdapterContext,
  ): Promise<void>;

  /** Open / close the store on the platform. */
  pushStoreOpenClose(
    open: boolean,
    ctx: AdapterContext,
  ): Promise<void>;
}

// ─── Sync queue job shapes ────────────────────────────────────────────────

export type SyncJobType =
  | 'MENU_PUSH'
  | 'AVAILABILITY_PUSH'
  | 'STATUS_PUSH'
  | 'PRICE_PUSH'
  | 'STORE_OPEN'
  | 'STORE_CLOSE';

export interface MenuPushJobPayload {
  items: MenuPushItem[];
}

export interface AvailabilityPushJobPayload {
  items: AvailabilityPushItem[];
}

export interface StatusPushJobPayload {
  externalOrderId: string;
  newStatus: LocalOrderStatus;
  orderId: string;
}

export interface StoreTogglePayload {
  open: boolean;
}
