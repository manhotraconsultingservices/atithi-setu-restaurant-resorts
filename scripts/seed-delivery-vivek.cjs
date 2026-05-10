#!/usr/bin/env node
/**
 * Atithi-Setu — Delivery Integration seeder (any tenant)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Production-grade demo data for the DELIVERY tab. Layers on top of an
 * existing tenant. Idempotent — safe to re-run.
 *
 * What it seeds (in order):
 *   1. channel_settings for 6 channels with realistic Indian restaurant markups:
 *        Swiggy +30%, Zomato +25%, Dunzo +20%, Magicpin +18%, ONDC +12%, UrbanPiper +25%
 *      All with min-margin floor 8%. is_active stays 0 — owner toggles in UI.
 *
 *   2. channel_prices per-item overrides on the top-N most expensive menu items
 *      (Swiggy +25%, Zomato +20% — competitive positioning on premium dishes).
 *
 *   3. menu.external_ids placeholder ids on those items for Phase 3 webhook E2E.
 *
 *   4. Mock platform orders (default 30, spread over last 14 days).  Calls
 *      POST /integrations/dev/seed-mock-orders.  external_order_id is
 *      always prefixed "MOCK-" — easy to identify and clean up later.
 *      Default channel mix: SWIGGY/ZOMATO/DUNZO.  Skips inventory deduction
 *      so real stock is never affected.
 *
 *   5. Synthetic settlement CSV per channel (built from the mock orders'
 *      external_order_id + amounts) uploaded via the standard /settlements
 *      endpoint.  Every line auto-reconciles to its mock order.
 *
 *   6. Read-back verification — prints what's now visible in each
 *      DELIVERY sub-tab (Channels · Live Orders · Settlements · Channel P&L).
 *
 * Flags:
 *   --dry-run            Print the full plan without making any writes
 *   --orders <N>         Number of mock orders to generate (default 30, 0 to skip)
 *   --order-days <N>     Spread orders over last N days (default 14)
 *   --skip-settlement    Skip the synthetic settlement CSV upload
 *   --notify             Fire ONE bulk-summary NEW_PLATFORM_ORDER notification
 *   --top-n <N>          Top-N items for per-item price overrides (default 10)
 *
 * SAFETY:
 *   • --dry-run shows the full plan without writes
 *   • Idempotent — reruns converge to the same end-state
 *   • Channels stay is_active=0 — owner explicit toggle required
 *   • Mock orders never deduct inventory or fire individual notifications
 *   • Mock external_order_ids start with "MOCK-" — trivially identifiable
 *   • The dev/seed-mock-orders endpoint is admin-only (OWNER on this tenant
 *     OR SUPER_ADMIN/CTO)
 *
 * Usage examples:
 *
 *   # Dry run for Vivek's Cafe:
 *   node scripts/seed-delivery-vivek.cjs \
 *     --server https://rishu-kitchen.atithi-setu.com \
 *     --admin-login <super-admin-email> \
 *     --admin-password <password> \
 *     --restaurant RESTO-1003 \
 *     --dry-run
 *
 *   # Real run for Vivek's Cafe with 50 orders over 21 days:
 *   node scripts/seed-delivery-vivek.cjs \
 *     --server https://rishu-kitchen.atithi-setu.com \
 *     --admin-login <super-admin-email> \
 *     --admin-password <password> \
 *     --restaurant RESTO-1003 \
 *     --orders 50 --order-days 21
 *
 *   # Cloud Kitchen tenant — replace --restaurant id and --server slug:
 *   node scripts/seed-delivery-vivek.cjs \
 *     --server https://cloud-kitchen.atithi-setu.com \
 *     --admin-login <super-admin-email> \
 *     --admin-password <password> \
 *     --restaurant <CLOUD_KITCHEN_RESTO_ID>
 *
 *   # Owner login alternative (skip --admin-login + --admin-password):
 *   node scripts/seed-delivery-vivek.cjs \
 *     --server https://<slug>.atithi-setu.com \
 *     --email <owner-email> --password <pw>
 */

'use strict';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const has = (name) => args.includes(`--${name}`);

const SERVER = (flag('server') || 'http://localhost:3001').replace(/\/$/, '');
const RESTAURANT_OPT = flag('restaurant') || 'RESTO-1003';
const DRY_RUN = has('dry-run');
const TOP_N = Math.max(0, Math.min(50, Number(flag('top-n')) || 10));

const log   = (m) => console.log(m);
const ok    = (m) => log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad   = (m) => log(`  \x1b[31m✗\x1b[0m ${m}`);
const warn  = (m) => log(`  \x1b[33m!\x1b[0m ${m}`);
const dim   = (m) => log(`    \x1b[2m${m}\x1b[0m`);
const head  = (m) => log(`\n\x1b[1m▶ ${m}\x1b[0m`);

async function api(method, path, body, token) {
  const init = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${SERVER}${path}`, init);
  let data; try { data = await res.json(); } catch { data = await res.text(); }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data).slice(0, 200)}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function getAuth() {
  const TOKEN_OPT  = flag('token');
  const ADMIN_LOGIN = flag('admin-login');
  const ADMIN_PW    = flag('admin-password');
  const EMAIL       = flag('email');
  const PASSWORD    = flag('password');

  if (TOKEN_OPT && RESTAURANT_OPT) return { token: TOKEN_OPT, restaurantId: RESTAURANT_OPT };
  if (ADMIN_LOGIN && ADMIN_PW && RESTAURANT_OPT) {
    const r = await api('POST', '/api/auth/import-token', {
      loginId: ADMIN_LOGIN, password: ADMIN_PW, restaurantId: RESTAURANT_OPT,
    });
    return { token: r.token, restaurantId: RESTAURANT_OPT };
  }
  if (EMAIL && PASSWORD) {
    const r = await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
    return { token: r.token, restaurantId: r.user?.restaurantId || r.restaurantId || RESTAURANT_OPT };
  }
  throw new Error('Provide --email + --password OR --token + --restaurant OR --admin-login + --admin-password + --restaurant');
}

// ─── Channel-settings seed plan ─────────────────────────────────────────
const CHANNEL_SEED = [
  { channel: 'SWIGGY',     default_markup_percent: 30, commission_percent: 25, prep_time_minutes: 22, min_margin_floor_percent: 8 },
  { channel: 'ZOMATO',     default_markup_percent: 25, commission_percent: 22, prep_time_minutes: 22, min_margin_floor_percent: 8 },
  { channel: 'DUNZO',      default_markup_percent: 20, commission_percent: 18, prep_time_minutes: 20, min_margin_floor_percent: 8 },
  { channel: 'MAGICPIN',   default_markup_percent: 18, commission_percent: 18, prep_time_minutes: 25, min_margin_floor_percent: 8 },
  { channel: 'ONDC',       default_markup_percent: 12, commission_percent: 8,  prep_time_minutes: 25, min_margin_floor_percent: 8 },
  { channel: 'URBANPIPER', default_markup_percent: 25, commission_percent: 0,  prep_time_minutes: 22, min_margin_floor_percent: 8 },
];

async function run() {
  console.log(`\n\x1b[1m═══ Delivery Integration seeder ═══\x1b[0m`);
  console.log(`Server:    ${SERVER}`);
  console.log(`Tenant:    ${RESTAURANT_OPT}`);
  console.log(`Mode:      ${DRY_RUN ? '\x1b[33mDRY RUN (no writes)\x1b[0m' : '\x1b[32mLIVE WRITE\x1b[0m'}`);
  console.log(`Top items: ${TOP_N}`);

  const { token, restaurantId } = await getAuth();
  ok(`Authenticated · restaurantId = ${restaurantId}`);

  // ─── 1. Channel settings ────────────────────────────────────────────
  head(`Step 1 — channel_settings (${CHANNEL_SEED.length} channels)`);
  if (DRY_RUN) {
    CHANNEL_SEED.forEach(c => dim(`  ${c.channel.padEnd(11)} markup ${c.default_markup_percent}% · commission ${c.commission_percent}% · prep ${c.prep_time_minutes}min · floor ${c.min_margin_floor_percent}%`));
    warn(`would PUT /api/restaurant/${restaurantId}/integrations/:channel/settings × ${CHANNEL_SEED.length}`);
  } else {
    let updated = 0;
    for (const c of CHANNEL_SEED) {
      try {
        await api('PUT', `/api/restaurant/${restaurantId}/integrations/${c.channel}/settings`, {
          // Crucially: do NOT set is_active here — owner toggles in UI
          default_markup_percent: c.default_markup_percent,
          commission_percent: c.commission_percent,
          prep_time_minutes: c.prep_time_minutes,
          min_margin_floor_percent: c.min_margin_floor_percent,
        }, token);
        ok(`${c.channel.padEnd(11)} configured (markup ${c.default_markup_percent}%, floor ${c.min_margin_floor_percent}%)`);
        updated++;
      } catch (err) {
        bad(`${c.channel}: ${err.message.slice(0, 120)}`);
      }
    }
    dim(`${updated}/${CHANNEL_SEED.length} channels configured`);
  }

  // ─── 2. Per-item overrides on top-N items ──────────────────────────
  head(`Step 2 — channel_prices overrides on top-${TOP_N} most expensive menu items`);
  let menu = [];
  try {
    menu = await api('GET', `/api/restaurant/${restaurantId}/menu`, undefined, token);
  } catch (err) {
    bad(`menu fetch failed: ${err.message.slice(0, 120)}`);
    return;
  }
  ok(`Loaded ${menu.length} menu items`);

  // Sort by price descending, take top N
  const topItems = [...menu]
    .filter(m => Number(m.price_full ?? m.price ?? 0) > 0)
    .sort((a, b) => Number(b.price_full ?? b.price ?? 0) - Number(a.price_full ?? a.price ?? 0))
    .slice(0, TOP_N);

  if (topItems.length === 0) {
    warn('No menu items with valid prices — skipping per-item overrides');
  } else {
    dim(`Top item: ${topItems[0]?.name} @ ₹${topItems[0]?.price_full ?? topItems[0]?.price}`);
    dim(`Bottom of top-${topItems.length}: ${topItems[topItems.length - 1]?.name} @ ₹${topItems[topItems.length - 1]?.price_full ?? topItems[topItems.length - 1]?.price}`);

    if (DRY_RUN) {
      warn(`would set per-item Zomato markup at +20% (vs +25% default) on ${topItems.length} premium items`);
      warn(`would set Swiggy markup at +25% (vs +30% default) on the same items`);
      warn(`would PUT /channel-prices × ${topItems.length * 2} = ${topItems.length * 2} requests`);
    } else {
      let appliedSwiggy = 0, appliedZomato = 0, blocked = 0;
      for (const item of topItems) {
        // Premium items: smaller markup to stay competitive
        try {
          await api('PUT', `/api/restaurant/${restaurantId}/menu/${item.id}/channel-prices`, {
            channel: 'SWIGGY', markup_percent: 25,
          }, token);
          appliedSwiggy++;
        } catch (err) {
          if (err.status === 422) blocked++;
          else dim(`Swiggy override on ${item.name}: ${err.message.slice(0, 80)}`);
        }
        try {
          await api('PUT', `/api/restaurant/${restaurantId}/menu/${item.id}/channel-prices`, {
            channel: 'ZOMATO', markup_percent: 20,
          }, token);
          appliedZomato++;
        } catch (err) {
          if (err.status === 422) blocked++;
          else dim(`Zomato override on ${item.name}: ${err.message.slice(0, 80)}`);
        }
      }
      ok(`Applied Swiggy +25% on ${appliedSwiggy}/${topItems.length} items`);
      ok(`Applied Zomato +20% on ${appliedZomato}/${topItems.length} items`);
      if (blocked > 0) warn(`${blocked} overrides blocked by min-margin floor (expected for items priced near cost)`);
    }
  }

  // ─── 3. Optional placeholder external_ids on the same top items ────
  head(`Step 3 — placeholder menu.external_ids (for Phase 3 webhook E2E testing)`);
  if (topItems.length === 0) {
    warn('No items to seed external_ids on');
  } else if (DRY_RUN) {
    warn(`would PATCH ${topItems.length} menu items with synthetic external_ids JSONB:`);
    topItems.slice(0, 3).forEach(it => {
      dim(`  ${it.id.slice(0, 12)}... → { SWIGGY: "swg-${it.id.slice(-6)}-MOCK", ZOMATO: "zom-${it.id.slice(-6)}-MOCK" }`);
    });
    if (topItems.length > 3) dim(`  …and ${topItems.length - 3} more`);
  } else {
    let stamped = 0;
    for (const item of topItems) {
      try {
        // Note: PATCH /api/menu/:id accepts arbitrary fields, but external_ids is JSONB
        // and must be passed as a JS object. The endpoint stringifies it via Object.values.
        // We send the JSON-encoded object string so it lands as JSONB.
        await api('PATCH', `/api/menu/${item.id}`, {
          external_ids: JSON.stringify({
            SWIGGY: `swg-${item.id.slice(-6)}-MOCK`,
            ZOMATO: `zom-${item.id.slice(-6)}-MOCK`,
            DUNZO:  `dnz-${item.id.slice(-6)}-MOCK`,
          }),
        }, token);
        stamped++;
      } catch (err) {
        dim(`external_ids on ${item.name}: ${err.message.slice(0, 80)}`);
      }
    }
    ok(`Stamped synthetic external_ids on ${stamped}/${topItems.length} items`);
    dim('Format: { SWIGGY:"swg-XXXXXX-MOCK", ZOMATO:"zom-XXXXXX-MOCK", DUNZO:"dnz-XXXXXX-MOCK" }');
    dim('Replace with real platform ids when onboarding signs off');
  }

  // ─── 4. Mock platform orders (for the DELIVERY → Live Orders dashboard) ─
  const ORDER_COUNT = Math.max(0, Math.min(200, Number(flag('orders')) || 30));
  const ORDER_DAYS  = Math.max(1, Math.min(90, Number(flag('order-days')) || 14));
  let mockOrders = [];
  if (ORDER_COUNT === 0) {
    head('Step 4 — mock platform orders (--orders 0, skipped)');
  } else {
    head(`Step 4 — mock platform orders (${ORDER_COUNT} orders across last ${ORDER_DAYS} days)`);
    if (DRY_RUN) {
      warn(`would POST /integrations/dev/seed-mock-orders ×1 with count=${ORDER_COUNT}, days=${ORDER_DAYS}`);
      dim(`Channels: SWIGGY (40%) · ZOMATO (40%) · DUNZO (20%)`);
      dim(`Status mix: 60% DELIVERED · 20% READY · 10% PREPARING · 10% CANCELLED`);
      dim(`Inventory deduction: OFF (mock orders never touch real stock)`);
      dim(`Notifications: OFF (single bulk-summary notification optional via --notify)`);
    } else {
      try {
        const r = await api('POST', `/api/restaurant/${restaurantId}/integrations/dev/seed-mock-orders`, {
          count: ORDER_COUNT,
          days: ORDER_DAYS,
          channels: ['SWIGGY', 'ZOMATO', 'DUNZO'],
          deduct_inventory: false,
          fire_notifications: !!has('notify'),
        }, token);
        ok(`Inserted ${r.inserted} mock orders` + (r.skipped_duplicates > 0 ? ` (${r.skipped_duplicates} duplicates skipped)` : ''));
        mockOrders = (await api('GET', `/api/restaurant/${restaurantId}/integrations/orders?limit=200`, undefined, token))?.orders || [];
        dim(`Live orders feed now has ${mockOrders.length} entries`);
      } catch (err) {
        bad(`Mock-orders endpoint failed: ${err.message.slice(0, 200)}`);
        dim(`Hint: this endpoint requires OWNER (with matching restaurantId) or SUPER_ADMIN/CTO role.`);
      }
    }
  }

  // ─── 5. Synthetic settlement CSV (for Settlements + Channel P&L tabs) ──
  const SKIP_SETTLEMENT = has('skip-settlement');
  if (SKIP_SETTLEMENT || mockOrders.length === 0) {
    head('Step 5 — settlement CSV (skipped: ' + (SKIP_SETTLEMENT ? '--skip-settlement' : 'no mock orders to reconcile') + ')');
  } else {
    head('Step 5 — synthetic settlement CSV (uploads via /integrations/:channel/settlements)');
    // One settlement CSV per active channel that has mock orders
    const ordersByChannel = {};
    mockOrders.forEach(o => {
      const ch = String(o.external_platform || '').toUpperCase();
      if (!ch) return;
      if (!ordersByChannel[ch]) ordersByChannel[ch] = [];
      ordersByChannel[ch].push(o);
    });

    if (DRY_RUN) {
      Object.entries(ordersByChannel).forEach(([ch, orders]) => {
        warn(`would generate + upload CSV for ${ch} with ${orders.length} rows`);
      });
    } else {
      // Manual multipart implementation — no extra deps needed for this one CSV.
      // CSV format matches Swiggy/Zomato/UrbanPiper aggregator exports:
      //   order_id, gross_amount, commission, net_payout, order_date
      for (const [channel, orders] of Object.entries(ordersByChannel)) {
        try {
          const lines = ['order_id,gross_amount,commission,net_payout,order_date'];
          for (const o of orders) {
            lines.push([
              o.external_order_id,
              Number(o.total_amount || 0).toFixed(2),
              Number(o.commission_amount || 0).toFixed(2),
              Number(o.net_payout_amount || 0).toFixed(2),
              new Date(o.created_at).toISOString().slice(0, 10),
            ].join(','));
          }
          const csv = lines.join('\n');

          // Build multipart body manually
          const boundary = '----vivek-seed-' + Math.random().toString(36).slice(2);
          const head = Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="${channel.toLowerCase()}-mock-settlement.csv"\r\n` +
            `Content-Type: text/csv\r\n\r\n`
          );
          const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
          const body = Buffer.concat([head, Buffer.from(csv, 'utf8'), tail]);
          const res = await fetch(`${SERVER}/api/restaurant/${restaurantId}/integrations/${channel}/settlements`, {
            method: 'POST',
            headers: {
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
              Authorization: `Bearer ${token}`,
            },
            body,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            bad(`${channel}: settlement upload failed (${res.status}): ${JSON.stringify(data).slice(0, 150)}`);
          } else {
            ok(`${channel}: ${data.rows} rows · ${data.matched} matched · ${data.missing_local} missing · ${data.variance_count} variances · reconciled=${data.reconciled}`);
          }
        } catch (err) {
          bad(`${channel}: settlement upload error: ${err.message.slice(0, 120)}`);
        }
      }
    }
  }

  // ─── 6. Read-back verification ─────────────────────────────────────
  if (!DRY_RUN) {
    head('Step 6 — verify by read-back');
    try {
      const channels = await api('GET', `/api/restaurant/${restaurantId}/integrations/channels`, undefined, token);
      const seeded = channels.filter(c => CHANNEL_SEED.some(s => s.channel === c.channel));
      ok(`channels GET returned ${seeded.length}/${CHANNEL_SEED.length} expected channels`);

      const cprices = await api('GET', `/api/restaurant/${restaurantId}/menu/channel-prices`, undefined, token);
      const expectedRows = topItems.length * 2; // Swiggy + Zomato
      if (cprices.length >= expectedRows * 0.8) {
        ok(`channel_prices has ${cprices.length} rows (expected ≥ ${Math.floor(expectedRows * 0.8)})`);
      } else {
        warn(`channel_prices has only ${cprices.length} rows — expected ≥ ${Math.floor(expectedRows * 0.8)} (some may have been blocked by min-margin floor)`);
      }

      // Live orders feed
      const liveOrders = await api('GET', `/api/restaurant/${restaurantId}/integrations/orders?limit=200`, undefined, token);
      ok(`Live orders feed: ${liveOrders.summary?.total || 0} platform orders · ₹${Math.round(liveOrders.summary?.today_gross || 0).toLocaleString('en-IN')} today`);
      if (liveOrders.summary?.by_platform) {
        Object.entries(liveOrders.summary.by_platform).forEach(([ch, v]) => {
          dim(`  ${ch.padEnd(11)} ${String(v.count).padStart(3)} orders · ₹${Math.round(v.gross).toLocaleString('en-IN')} gross`);
        });
      }

      // Settlements
      const setts = await api('GET', `/api/restaurant/${restaurantId}/integrations/settlements`, undefined, token);
      ok(`Settlements: ${setts.length} uploaded`);
      setts.slice(0, 5).forEach(s => {
        dim(`  ${String(s.channel).padEnd(11)} ${String(s.period_from).slice(0, 10)} → ${String(s.period_to).slice(0, 10)} · ₹${Math.round(s.net_payout).toLocaleString('en-IN')} net · ${s.reconciled ? '✓ reconciled' : '○ open'}`);
      });

      // Channel P&L
      const pnl = await api('GET', `/api/restaurant/${restaurantId}/integrations/analytics/channel-pnl?from=${new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`, undefined, token);
      ok(`Channel P&L (last 30 days): ₹${Math.round(pnl.totals?.gross || 0).toLocaleString('en-IN')} gross · ${pnl.totals?.profit_pct || 0}% margin · ${pnl.by_channel?.length || 0} channels`);
      (pnl.by_channel || []).forEach(row => {
        const sign = row.profit >= 0 ? '+' : '';
        dim(`  ${String(row.channel).padEnd(11)} ${String(row.order_count).padStart(3)} orders · gross ₹${Math.round(row.gross).toLocaleString('en-IN')} · profit ${sign}₹${Math.round(row.profit).toLocaleString('en-IN')} (${row.profit_pct}%)`);
      });
    } catch (err) {
      bad(`Read-back failed: ${err.message.slice(0, 120)}`);
    }
  }

  console.log(`\n\x1b[1m═══ Done ═══\x1b[0m`);
  if (DRY_RUN) {
    console.log(`\nThis was a dry run. To apply, drop the \x1b[1m--dry-run\x1b[0m flag.\n`);
    console.log(`To seed only channels (no mock orders), pass \x1b[1m--orders 0\x1b[0m.`);
    console.log(`To skip the settlement CSV upload, pass \x1b[1m--skip-settlement\x1b[0m.\n`);
  } else {
    console.log(`\n\x1b[32m✅ Tenant ${restaurantId} is now seeded.\x1b[0m`);
    console.log(`\nNext: open \x1b[1mDelivery Partners\x1b[0m tab in the owner dashboard to see:`);
    console.log(`  • \x1b[1mChannels & Pricing\x1b[0m  — 6 channel cards configured (toggle Active when ready)`);
    console.log(`  • \x1b[1mLive Orders\x1b[0m       — ${ORDER_COUNT} mock platform orders across SWIGGY/ZOMATO/DUNZO`);
    console.log(`  • \x1b[1mSettlements\x1b[0m       — auto-reconciled mock CSVs per channel`);
    console.log(`  • \x1b[1mChannel P&L\x1b[0m       — per-channel profit & ₹/order metrics`);
    console.log(`\nMock orders are tagged with external_order_id starting "MOCK-" — easy to identify and clean up.\n`);
  }
}

run().catch(err => {
  console.error(`\n\x1b[31m❌ Seed failed:\x1b[0m`, err.message || err);
  if (err.stack && process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
