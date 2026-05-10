#!/usr/bin/env node
/**
 * Atithi-Setu — Delivery Integration seeder for Vivek's Cafe
 * ════════════════════════════════════════════════════════════════════════
 *
 * Production-grade demo data for the DELIVERY tab. Layers on top of an
 * existing tenant (default: RESTO-1003 Vivek's Cafe). Idempotent — safe
 * to re-run.
 *
 * What it seeds:
 *   1. channel_settings for 6 channels with realistic Indian restaurant markups:
 *        Swiggy +30%, Zomato +25%, Dunzo +20%, Magicpin +18%, ONDC +12%, UrbanPiper +25%
 *      Each with: commission %, prep time, min-margin floor 8%
 *      is_active stays 0 by default — owner toggles via DELIVERY → Channels card
 *
 *   2. channel_prices overrides on the top N most-expensive menu items
 *        (e.g. premium dishes get a smaller markup to stay competitive)
 *
 *   3. menu.external_ids placeholder ids on the same items so Phase 3
 *      webhook tests can resolve them. Format: SWIGGY → "swg-{itemId}-MOCK"
 *      (clearly fake, replace with real platform ids when onboarded)
 *
 * SAFETY:
 *   • --dry-run shows the plan without making any writes
 *   • Idempotent: reruns produce the same end-state
 *   • Does NOT activate any channel (is_active stays 0) — owner explicit toggle
 *   • Does NOT touch any existing menu pricing fields (price, price_full, price_half)
 *   • Only adds rows to channel_prices and merges JSONB into menu.external_ids
 *
 * Usage:
 *   # Dry run first to see what will be seeded:
 *   node scripts/seed-delivery-vivek.cjs \
 *     --server https://rishu-kitchen.atithi-setu.com \
 *     --admin-login <admin-email> \
 *     --admin-password <password> \
 *     --restaurant RESTO-1003 \
 *     --dry-run
 *
 *   # Real run (drops --dry-run):
 *   node scripts/seed-delivery-vivek.cjs \
 *     --server https://rishu-kitchen.atithi-setu.com \
 *     --admin-login <admin-email> \
 *     --admin-password <password> \
 *     --restaurant RESTO-1003
 *
 *   # Owner login alternative:
 *   node scripts/seed-delivery-vivek.cjs \
 *     --server <slug>.atithi-setu.com \
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

  // ─── 4. Read-back verification ─────────────────────────────────────
  if (!DRY_RUN) {
    head('Step 4 — verify by read-back');
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
    } catch (err) {
      bad(`Read-back failed: ${err.message.slice(0, 120)}`);
    }
  }

  console.log(`\n\x1b[1m═══ Done ═══\x1b[0m`);
  if (DRY_RUN) {
    console.log(`\nThis was a dry run. To apply, drop the \x1b[1m--dry-run\x1b[0m flag.\n`);
  } else {
    console.log(`\n\x1b[32m✅ Vivek's Cafe is now seeded for delivery integration.\x1b[0m`);
    console.log(`\nNext: open \x1b[1mDelivery Partners\x1b[0m tab in the owner dashboard to:`);
    console.log(`  • Review the 6 channel cards and toggle is_active when ready`);
    console.log(`  • Verify per-item Channel Pricing on the top-${TOP_N} items in Menu Management`);
    console.log(`  • Watch the Live Orders dashboard once a platform connection (or Phase 3 mock test) lands`);
  }
}

run().catch(err => {
  console.error(`\n\x1b[31m❌ Seed failed:\x1b[0m`, err.message || err);
  if (err.stack && process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
