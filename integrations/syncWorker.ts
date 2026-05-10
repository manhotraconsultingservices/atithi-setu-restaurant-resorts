/**
 * Atithi-Setu — Outbound sync queue worker (Phase 4)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Table-backed queue (`pending_sync_jobs`) drained by a 30-second cron.
 * Reliable status push, menu push, availability push, and store toggles to
 * delivery platforms via the registered DeliveryChannelAdapter for each
 * channel. Exponential backoff up to 15 min, max 5 attempts before DEAD.
 *
 *   enqueueSyncJob(db, jobType, channel, payload)
 *     Used by:
 *       - server.ts PATCH /orders/:id  → enqueue STATUS_PUSH
 *       - inventory stock-low cron     → enqueue AVAILABILITY_PUSH(false)
 *       - GRN POST                     → enqueue AVAILABILITY_PUSH(true)
 *       - menu-dirty scanner cron      → enqueue MENU_PUSH
 *       - smoke-test endpoint          → enqueue STORE_OPEN/STORE_CLOSE
 *
 *   processSyncJob(restaurantId, db, job)
 *     Called by the worker cron. Resolves the adapter, builds the
 *     AdapterContext, and dispatches to the right pushXxx() method.
 *     Throws on adapter failure — caller increments attempts + schedules
 *     retry with exponential backoff.
 */

import type {
  AdapterContext,
  AvailabilityPushItem,
  ChannelId,
  LocalOrderStatus,
  MenuPushItem,
  SyncJobType,
} from './types';
import { getAdapter, tryGetAdapter } from './registry';
import { decryptCredential, isCredentialKeyConfigured } from './security';

// `DbInterface` — duck-typed to match the existing helpers in db.ts.  Avoids
// pulling in the full DbInterface type chain (and its pg pool deps).
export interface QueueDb {
  run(sql: string, params?: any[]): Promise<any>;
  get(sql: string, params?: any[]): Promise<any>;
  query(sql: string, params?: any[]): Promise<any[]>;
}

export interface PendingJobRow {
  id: string;
  job_type: SyncJobType;
  channel: ChannelId;
  payload: any;             // already JSONB-decoded by db driver, or string
  status: 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'FAILED' | 'DEAD';
  attempts: number;
  max_attempts: number;
}

const newId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

/**
 * Enqueue a sync job. Returns the job id. Caller is non-blocking — the
 * worker cron picks up within 30 seconds.
 *
 * Defensive: never throws into the caller's path. The whole point of the
 * queue is that the live request flow (e.g. order PATCH) doesn't depend
 * on platform reachability.
 */
export async function enqueueSyncJob(
  db: QueueDb,
  jobType: SyncJobType,
  channel: ChannelId,
  payload: any,
  opts: { maxAttempts?: number } = {},
): Promise<string | null> {
  try {
    const id = newId('JOB');
    await db.run(
      `INSERT INTO pending_sync_jobs (id, job_type, channel, payload, status, max_attempts)
       VALUES (?, ?, ?, ?, 'PENDING', ?)`,
      [id, jobType, channel, JSON.stringify(payload || {}), Math.max(1, opts.maxAttempts ?? 5)]
    );
    return id;
  } catch (err: any) {
    console.warn(`[sync-queue] Enqueue failed (${jobType}/${channel}):`, err?.message);
    return null;
  }
}

/**
 * Build the AdapterContext for a (tenant, channel) pair, mirroring the
 * webhook handler's loadAdapterContext but local to the queue worker.
 */
async function buildContext(
  db: QueueDb,
  restaurantId: string,
  channel: ChannelId,
): Promise<AdapterContext> {
  const cs: any = await db.get("SELECT * FROM channel_settings WHERE channel = ?", [channel]);
  const channelSettings = cs ? {
    channel,
    is_active: Number(cs.is_active || 0),
    default_markup_percent: Number(cs.default_markup_percent || 25),
    commission_percent: Number(cs.commission_percent || 25),
    packaging_charge: Number(cs.packaging_charge || 0),
    min_order_amount: Number(cs.min_order_amount || 0),
    prep_time_minutes: Number(cs.prep_time_minutes || 20),
    webhook_url_inbound: cs.webhook_url_inbound || null,
    brand_display_name: cs.brand_display_name || null,
    min_margin_floor_percent: Number(cs.min_margin_floor_percent || 5),
  } : {
    channel,
    is_active: 0,
    default_markup_percent: 25,
    commission_percent: 25,
    packaging_charge: 0,
    min_order_amount: 0,
    prep_time_minutes: 20,
    webhook_url_inbound: null,
    brand_display_name: null,
    min_margin_floor_percent: 5,
  };

  const credentials: Record<string, string> = {};
  if (isCredentialKeyConfigured()) {
    const rows: any[] = await db.query(
      `SELECT credential_type, ciphertext, iv, auth_tag
         FROM integration_credentials
        WHERE channel = ? AND is_active = 1`,
      [channel]
    ).catch(() => [] as any[]);
    for (const r of rows) {
      try {
        credentials[String(r.credential_type)] = decryptCredential({
          ciphertext: r.ciphertext, iv: r.iv, auth_tag: r.auth_tag,
        });
      } catch (e) {
        console.warn(`[sync-queue] decrypt ${channel}.${r.credential_type} failed:`, (e as any)?.message);
      }
    }
  }
  return { restaurantId, channelSettings, credentials };
}

/**
 * Run a single sync job. Throws on failure — caller decides retry vs DEAD.
 *
 * Skips silently (returns OK) when:
 *   - The channel isn't active (operator may have disabled mid-flight)
 *   - No adapter is registered (e.g. SwiggyDirect pre-onboarding)
 */
export async function processSyncJob(
  restaurantId: string,
  db: QueueDb,
  job: PendingJobRow,
): Promise<{ skipped?: string; ok: boolean }> {
  const adapter = tryGetAdapter(job.channel);
  if (!adapter) {
    return { ok: true, skipped: `No adapter registered for ${job.channel}` };
  }
  const ctx = await buildContext(db, restaurantId, job.channel);
  if (!ctx.channelSettings.is_active) {
    return { ok: true, skipped: `Channel ${job.channel} not active` };
  }

  // Payload may be JSONB (object) or TEXT (needs parse) depending on driver
  let payload: any = job.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { payload = {}; }
  }

  switch (job.job_type) {
    case 'STATUS_PUSH': {
      const externalOrderId = String(payload?.externalOrderId || '');
      const newStatus = String(payload?.newStatus || '').toUpperCase() as LocalOrderStatus;
      if (!externalOrderId || !newStatus) {
        throw new Error(`STATUS_PUSH missing required fields: ${JSON.stringify(payload).slice(0, 100)}`);
      }
      await adapter.pushOrderStatus(externalOrderId, newStatus, ctx);
      break;
    }
    case 'AVAILABILITY_PUSH': {
      const items = Array.isArray(payload?.items) ? payload.items as AvailabilityPushItem[] : [];
      if (items.length === 0) return { ok: true, skipped: 'No items' };
      await adapter.pushItemAvailability(items, ctx);
      break;
    }
    case 'MENU_PUSH': {
      const items = Array.isArray(payload?.items) ? payload.items as MenuPushItem[] : [];
      if (items.length === 0) return { ok: true, skipped: 'No items' };
      await adapter.pushMenu(items, ctx);
      break;
    }
    case 'STORE_OPEN':
      await adapter.pushStoreOpenClose(true, ctx);
      break;
    case 'STORE_CLOSE':
      await adapter.pushStoreOpenClose(false, ctx);
      break;
    case 'PRICE_PUSH':
      // Handled as part of MENU_PUSH for now.  Reserved for future granular updates.
      return { ok: true, skipped: 'PRICE_PUSH reserved for future granular updates' };
    default:
      throw new Error(`Unknown job_type: ${(job as any).job_type}`);
  }
  return { ok: true };
}

/**
 * Compute the next-attempt delay in seconds for a failed job.
 * Exponential backoff: 30s · 60s · 120s · 240s · 480s · cap at 900s (15 min).
 */
export function backoffSeconds(attemptNumber: number): number {
  return Math.min(900, Math.pow(2, Math.max(0, attemptNumber - 1)) * 30);
}
