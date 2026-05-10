# Delivery Partner Integration Guide

Connect your Atithi-Setu tenant to **Swiggy · Zomato · Dunzo · Magicpin · ONDC · UrbanPiper**. Every order, status update, menu push, and settlement flows through the same Atithi-Setu dashboard — one place to manage everything.

---

## Table of contents

1. [What you get](#what-you-get)
2. [Choose your integration path](#choose-your-integration-path)
3. [One-time platform admin setup](#one-time-platform-admin-setup)
4. [Tenant-side onboarding (per outlet)](#tenant-side-onboarding-per-outlet)
5. [Map your menu items to platform ids](#map-your-menu-items-to-platform-ids)
6. [Verify the integration is live](#verify-the-integration-is-live)
7. [Daily / weekly / monthly operations](#daily--weekly--monthly-operations)
8. [Troubleshooting](#troubleshooting)
9. [Per-platform onboarding guide](#per-platform-onboarding-guide)
   - [UrbanPiper aggregator (recommended starting point)](#urbanpiper-aggregator-recommended-starting-point)
   - [Direct Swiggy POS Partner Program](#direct-swiggy-pos-partner-program)
   - [Direct Zomato Partner API](#direct-zomato-partner-api)
   - [ONDC Network](#ondc-network)
   - [Dunzo / Magicpin](#dunzo--magicpin)
10. [Security & compliance notes](#security--compliance-notes)

---

## What you get

After integration, every order placed on the connected platform flows into your Atithi-Setu KDS automatically. You'll see them on the **Delivery Partners → Live Orders** dashboard alongside in-house orders. Marking an order Ready in the kitchen pushes that status back to the platform's customer-facing tracker. Stock-outs auto-disable affected items on every active platform within 30 seconds. Weekly settlement CSVs auto-reconcile against your local order ledger and surface variances. The **Channel P&L** report tells you exactly how profitable each platform is after their commission and your food cost — answering the only question that actually matters: *is this channel making me money?*

---

## Choose your integration path

Swiggy and Zomato don't publish open APIs. Three real paths exist:

| Path | Coverage | Time to live | Cost | Best for |
|---|---|---|---|---|
| **UrbanPiper** (or Petpooja / Dotpe / Posist / Limetray) | Swiggy + Zomato + Dunzo + Magicpin (one contract) | 2–3 weeks | ₹2,000–5,000/outlet/month | Most owners |
| **Direct Swiggy / Zomato Partner API** | One platform per onboarding | 6–12 weeks per platform | ~Free, but needs business team | Enterprise chains, multi-outlet |
| **ONDC** | Pincode + Paytm + Magicpin + Mystore (open network) | 1–2 weeks | Free | Future-proof, mandatory trajectory |

**Our recommendation: start with UrbanPiper.** One integration covers four major platforms. Direct partner programs come later if you outgrow the aggregator's per-outlet fees. ONDC ships in parallel as a no-contract bonus.

---

## One-time platform admin setup

These steps happen once per Atithi-Setu deployment, not per tenant. Done by a developer or sysadmin.

### 1. Generate and set the credential master key

Atithi-Setu encrypts every API key / HMAC secret / store id at rest using AES-256-GCM. The master key lives only in the deploy environment.

```bash
# Generate a 32-byte base64 key (run on a machine with openssl):
openssl rand -base64 32
# Example output: 3qRZ9fT5tHkpQy8m6xA2nK4uVwL1bC7eYp+sJrW0DvE=

# Add to the deploy environment:
echo "ATITHI_CREDENTIAL_KEY=3qRZ9fT5tHkpQy8m6xA2nK4uVwL1bC7eYp+sJrW0DvE=" >> /path/to/.env
# Restart node_app
```

**Without this env var set, the credentials API and the inbound webhook return HTTP 503.** No integration features work until it's configured.

After setting it, verify by hitting any tenant's webhook endpoint:

```bash
curl -X POST "https://<your-app>/api/integrations/SWIGGY/webhook/RESTO-1003" \
  -H "x-mock-signature: deadbeef" -d '{}'
# Before: { "error": "Integration credential storage is not configured ..." }
# After:  { "error": "Signature verification failed" }   ← good, key is set
```

### 2. (Optional) Enable mock mode for staging / CI

```bash
# In the dev/staging .env only — never in production:
MOCK_INTEGRATIONS=1
```

This swaps the production `UrbanPiperAdapter` for `MockAdapter` so end-to-end tests can exercise the full pipeline without hitting UrbanPiper's sandbox.

---

## Tenant-side onboarding (per outlet)

Done by the **owner** for their restaurant. Takes 30–60 minutes the first time.

### Step 1 — Open Delivery Partners

1. Log into your Atithi-Setu owner dashboard at `https://<your-tenant-slug>.atithi-setu.com/`
2. Click the **Delivery Partners** tab in the main navigation (between *Inventory* and *Analytics & Reports*)
3. You'll land on the **Channels & Pricing** sub-tab

### Step 2 — Configure default markups per channel

You'll see 6 channel cards (Swiggy 🟧, Zomato 🟥, Dunzo 🟩, Magicpin 🟪, ONDC 🟦, UrbanPiper ⬛). For each platform you plan to use:

1. Set **Default markup %** — the percentage to add to your in-house menu prices when publishing on this channel. Typical values:
   - Swiggy: **+30%** (covers ~25% commission + buffer)
   - Zomato: **+25%**
   - Dunzo: **+20%**
   - Magicpin: **+18%**
   - ONDC: **+12%** (lower fees)
   - UrbanPiper: **+25%** (when used as aggregator)
2. Set **Commission %** — what the platform deducts from each order. Used to compute your true Net Payout.
3. Set **Min margin floor %** — guard rail (default 8%). The system blocks any per-item override that would price an item below `cost × (1 + floor%)`.
4. Click **Apply changes**

Leave **Active toggle OFF for now** — you'll flip it on after credentials are configured and tested.

### Step 3 — Click 🔑 Configure credentials on a channel card

A modal opens. The top of the modal shows your **Inbound Webhook URL** — something like:

```
https://<your-tenant>.atithi-setu.com/api/integrations/SWIGGY/webhook/RESTO-XXXXXX
```

Click **Copy** — you'll need this URL in the next step.

### Step 4 — Paste the webhook URL into the platform's partner dashboard

This step is platform-specific. See [Per-platform onboarding guide](#per-platform-onboarding-guide) below for exact navigation paths in each platform's UI:

- For **UrbanPiper**: their dashboard → Settings → Webhooks → New Webhook
- For **Swiggy**: Swiggy Partner Portal → Settings → Integrations → Webhook URL
- For **Zomato**: Zomato Partner App → Settings → POS Integration → Webhook
- For **Dunzo / Magicpin**: routed through UrbanPiper

While you're in their dashboard, **copy these three values** to bring back to Atithi-Setu:

| What to find | Where it usually lives |
|---|---|
| **API Key** | Settings → API Keys → Generate / Show |
| **HMAC Secret** | Settings → Webhooks → Signing secret |
| **Store ID** | Profile → Store details → Store / Outlet ID (numeric) |

### Step 5 — Paste the credentials back into Atithi-Setu

Back in the Atithi-Setu **Configure credentials** modal:

1. Paste the **API Key** in the API Key field
2. Paste the **HMAC Secret** in the HMAC Secret field
3. Paste the **Store ID** in the Store / Outlet ID field
4. Click **Save credentials**

The form clears immediately — Atithi-Setu never displays secrets back to you. The status pills above the inputs flip to ✓ once each credential is saved.

### Step 6 — Test the connection

Click **🧪 Test connection** in the modal footer. Atithi-Setu will:
1. Decrypt your credentials in-memory
2. Open and immediately close the store on the platform via their API
3. Show ✓ green if it succeeded, ✗ red with the platform's exact error if it didn't

Common failures and what they mean:
- *"401 Unauthorized"* → API key wrong or expired. Re-paste from the partner dashboard.
- *"403 Forbidden"* → Your account isn't onboarded yet — check with the platform.
- *"Invalid store_id"* → Wrong store id format. Try copy-pasting again, watching for whitespace.

### Step 7 — Toggle Active and watch your first order

Once Test connection is green:

1. Close the credentials modal
2. On the channel card, flip the **Active toggle** to ON
3. Click **Apply changes**

Within ~15 minutes the first menu push will reach the platform (the menu-dirty cron runs every 15 minutes). Or click **Force re-push everything** in *Menu Sync Health* (coming in a future build) to push immediately.

Place a small test order on the platform's customer app from a different phone. Within seconds it should appear in **Delivery Partners → Live Orders** with a "🔔 NEW_PLATFORM_ORDER" notification.

---

## Map your menu items to platform ids

For inbound orders to deduct the right ingredients (and for menu pushes to update the right items on the platform), Atithi-Setu needs to know which **platform item id** corresponds to which of your **local menu items**.

### Option A — Use the seeder (quick demo only)

```bash
node scripts/seed-delivery-vivek.cjs \
  --server https://<tenant>.atithi-setu.com \
  --admin-login <admin@atithi-setu.com> \
  --admin-password <pw> \
  --restaurant <RESTO-ID>
```

This stamps placeholder ids like `swg-XXXXXX-MOCK`. Useful for testing only — replace with real ids before going live.

### Option B — Bulk import from the platform's own menu CSV

Most platforms let you download a menu CSV from their dashboard. The CSV will have:
- Their internal item id (e.g. Swiggy item id `91234567`)
- Your dish name (e.g. "Butter Chicken")

Match them to your local `menu.id` (the `MENU-XXXX-YYYY` strings). Then for each item, PATCH the menu row with:

```json
{
  "external_ids": {
    "SWIGGY": "91234567",
    "ZOMATO": "zom-item-554",
    "DUNZO": "dnz-789"
  }
}
```

Either via the UI (Menu Management → edit item → there's no field today, but it's a backend column) or via direct DB update or via the bulk-update CSV admin tool.

### Option C — Map item-by-item via the future Menu Sync Health UI

(Roadmap — coming after first real platform onboarding lands.)

The **Menu Sync Health** sub-view inside Delivery Partners will list every menu item and show its mapping status per channel: ✓ synced · ⚠ unmapped · ✗ error. Click an unmapped item → modal opens to paste the platform's id.

### What happens when an item isn't mapped

- Inbound order arrives with that item → order is still created
- Item appears in the order's items JSON with `localMenuItemId: null`
- Inventory deduction silently skips that line (no recipe lookup possible)
- Owner gets one **`ITEM_MAPPING_ALERT`** notification listing the unmapped items
- The order itself is still acknowledged 200 to the platform — they don't see anything wrong

Map the items at your leisure; future orders for the same item will deduct correctly once mapped.

---

## Verify the integration is live

Run the validation script anytime — read-only, no writes:

```bash
node scripts/validate-delivery-integration.cjs \
  --server https://<your-tenant>.atithi-setu.com \
  --restaurant <RESTO-ID>
```

What you should see when fully wired:
```
✓ tenant DB reachable
✓ Unknown channel (FAKEPLATFORM) → 400 (allowlist working)
✓ Adapter registry: SWIGGY → 401 (signature verification working)
✓ URBANPIPER → 401 (credentials configured, signature failed on probe = correct)
✓ channels GET endpoint exists
✓ menu channel-prices endpoint exists
✓ integrations/orders endpoint exists
6 passed · 0 warnings · 0 failed
```

Any non-401 / non-200 response indicates a configuration issue — see [Troubleshooting](#troubleshooting) below.

---

## Daily / weekly / monthly operations

### Daily (5 minutes / day)
- **Delivery Partners → Live Orders** — confirm orders are flowing in. The 30-second auto-refresh keeps it current.
- **Inventory → Insights → Audit Log** filter by *Type: CONSUMPTION* to confirm inventory is deducting on platform orders.
- Address any **🟡 STOCK_LOW** notifications — the system has already auto-disabled affected items on platforms.

### Weekly (15 minutes / week)
- Download settlement CSV from each platform's partner dashboard.
- **Delivery Partners → Settlements** → Upload CSV → Pick channel → Upload.
- Review the auto-reconciliation output. Variances > ₹5 are flagged. *MISSING_LOCAL* lines = the platform issued a refund you didn't see; *MISSING_REMOTE* = an order the platform didn't process. Both are forensic clues.
- **Inventory → Physical Counts** — quick walk-around if it's been > 7 days.

### Monthly (30 minutes / month)
- **Delivery Partners → Channel P&L** → set range to last 30 days → review per-channel profit.
- If a channel's **₹/order profit is below ₹20–30**, the unit economics aren't working. Either raise that channel's markup, hide loss-making items via the Channel Pricing override, or pause the channel.
- **Inventory → Insights → COGS Report** → cross-check the food cost numbers feeding into Channel P&L.
- **Settings → Notification Templates** → tweak any wording owners want changed.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Webhook returns **HTTP 503** with *"ATITHI_CREDENTIAL_KEY not configured"* | Server-side master key not set | Add `ATITHI_CREDENTIAL_KEY` env var, restart server |
| Webhook returns **HTTP 401** with *"Signature verification failed"* | HMAC secret in Atithi-Setu doesn't match what the platform is signing with | Re-rotate the secret on the platform partner dashboard, paste the new value into Atithi-Setu credentials |
| Webhook returns **HTTP 400** with *"Unknown channel"* | Wrong URL — check the channel name in the URL is uppercase and matches one of: SWIGGY, ZOMATO, DUNZO, MAGICPIN, ONDC, URBANPIPER |
| Webhook returns **HTTP 422** with *"Server-side price validation failed"* | Platform's order total differs from what Atithi-Setu computes from `channel_prices` by more than ₹1 — usually means the platform's menu cache is stale | Force a menu re-push: edit any item and save (sets sync_dirty=1, re-pushes within 15 min) |
| Webhook returns **HTTP 404** with *"No adapter registered"* | Channel scaffold exists but no real adapter (Swiggy/Zomato direct require BD onboarding) | Use UrbanPiper aggregator path until partner onboarding signs off |
| **`ITEM_MAPPING_ALERT`** notification | One or more items in the inbound order have no matching `menu.external_ids[<channel>]` mapping | Add the mapping; the next order for that item will deduct correctly |
| **`SYNC_JOB_DEAD`** notification | A status push or menu push exhausted retries (5 attempts × exponential backoff up to 15 min) | Open *Delivery Partners → Sync Health* (future), inspect last_error, fix root cause, click *Retry* |
| **`WEBHOOK_SIGNATURE_FAILURE`** notification (5+ in 10 min) | Platform may have rotated its HMAC secret without you knowing, OR there's a misconfigured webhook URL forwarding to your tenant | Rotate credentials in Atithi-Setu and on the partner dashboard; verify the webhook URL hasn't been mistakenly pointed elsewhere |
| Live Orders dashboard shows nothing | Either no orders received, or `external_platform IS NULL` on the orders that did come in | Check the audit log — if recent webhook_inbox rows are signature_verified=1 but no order created, check error_message. If signature_verified=0, fix HMAC. |
| Status push doesn't reach platform | Either channel is is_active=0 OR the adapter scaffolds throws *"Not yet onboarded"* (Swiggy / Zomato direct) | Toggle Active in Channels & Pricing; or switch to UrbanPiper path |
| GST reporting wrong on platform orders | `gst_collected_by` defaults to PLATFORM for ECO-collected orders (Sec 9(5)) | Confirm with your CA before exporting books; the orders table preserves the actual collector via this column |

### Investigative tools

```bash
# Tail the server logs to see webhook_inbox + sync-worker output:
docker compose logs -f node_app | grep -E "\[webhook\]|\[sync-worker\]|\[reconcile\]"

# Look at recent webhook_inbox rows directly:
psql -d <tenant_db> -c "SELECT received_at, channel, event_type, signature_verified, result_status, error_message FROM webhook_inbox ORDER BY received_at DESC LIMIT 20;"

# See pending / failed / dead sync jobs:
psql -d <tenant_db> -c "SELECT id, job_type, channel, status, attempts, last_error FROM pending_sync_jobs WHERE status != 'DONE' ORDER BY next_attempt_at ASC LIMIT 50;"
```

---

## Per-platform onboarding guide

### UrbanPiper aggregator (recommended starting point)

**What you get from UrbanPiper:** Swiggy + Zomato + Dunzo + Magicpin + Foodpanda all behind one contract, one API. Their per-outlet monthly fee is the trade-off for not having to negotiate four separate partner contracts.

**Onboarding sequence:**

1. Sign up at `https://urbanpiper.com` → Request a demo / talk to sales.
2. Sign their **POS Partner Agreement** — usually 1-page, takes a day.
3. UrbanPiper provisions your outlet: assigns a `biz_id` (their internal store id), a sandbox API key, and an HMAC signing secret.
4. In their dashboard, navigate to **Settings → Webhooks → New Webhook**:
   - URL: paste the Atithi-Setu webhook URL you copied from the credentials modal
   - Events: subscribe to `order_created`, `order_status_update`, `order_cancelled`, `rider_assigned`
   - Save
5. Note down: **API Key**, **HMAC Secret**, **Biz ID** (the store id) — paste these into the Atithi-Setu credentials modal.
6. Test connection — should pass.
7. UrbanPiper will provision your menu on Swiggy/Zomato/Dunzo/Magicpin **from the menu Atithi-Setu pushes them**. Don't try to maintain menus on those platforms separately — UrbanPiper is the source of truth.
8. Toggle Active in Atithi-Setu → first menu push goes out within 15 minutes.

**Cost:** ₹2,000–5,000 per outlet per month depending on volume tier.

### Direct Swiggy POS Partner Program

**Who this is for:** Multi-outlet chains who can negotiate a master agreement and prefer not to pay UrbanPiper's per-outlet fee.

**Onboarding sequence:**

1. Email `partner.tech@swiggy.in` from your business email asking for POS Partner Program access.
2. They'll send a partnership questionnaire. Answer it. Wait 2–8 weeks for approval.
3. Once approved, they provision sandbox + production credentials. They'll give you:
   - **API Key** (their `X-Swiggy-API-Key`)
   - **HMAC Secret** (used to sign their webhook calls to you)
   - **Restaurant ID** (numeric, per outlet)
4. They'll ask for your webhook URL — paste the Atithi-Setu webhook URL.
5. Paste credentials into Atithi-Setu, test connection, toggle Active.

**Cost:** Free — but the BD time is the cost. Plan for 6–12 weeks per outlet.

**Status in Atithi-Setu:** The `SwiggyDirectAdapter` scaffold is committed — signature verification is implemented (so once Swiggy sends test webhooks, they'll be parsed). Outbound calls (menu push, status push) currently throw `"Not yet onboarded as Swiggy POS partner"` — the bodies of those methods need filling in once Swiggy provides the production endpoint shapes (which are NDA-gated until you sign their agreement).

### Direct Zomato Partner API

Same shape as Swiggy:

1. Email `partner.tech@zomato.com` requesting POS Partner Program access.
2. Approval cycle 4–10 weeks.
3. They provide API Key, HMAC Secret, `res_id` (numeric restaurant id).
4. Configure webhook URL on their partner portal.
5. Paste credentials into Atithi-Setu.

**Status in Atithi-Setu:** `ZomatoDirectAdapter` scaffold is committed with signature verification implemented. Outbound calls throw "Not yet onboarded" until Zomato shares production endpoints.

### ONDC Network

**Why bother:** No BD contract. Mandated trajectory in India — increasingly required for delivery aggregators. Open ecosystem (Pincode, Paytm, Magicpin, Mystore are all ONDC Buyer Apps).

**Onboarding sequence:**

1. Register as a **seller (BPP)** on `https://ondc.org/become-a-seller`.
2. Choose a **Seller App provider** — Mystore, Hubble, Paytm Seller, etc. They handle the network registration on your behalf.
3. The Seller App provider gives you:
   - **NP ID** (your network participant subscriber id)
   - **Ed25519 private key** (you store; signs your outbound messages)
   - **Public key id** (registered in the ONDC registry — buyers use this to verify your replies)
4. Atithi-Setu's `ONDCAdapter` accepts inbound BAP requests (search/select/init/confirm/status/update/cancel). The full BAP/BPP message flow is implemented for **inbound parse + signature verify**; outbound BPP responses (`on_search`, `on_select`, etc.) currently throw "not yet wired" — these get filled in alongside live ONDC partnership.

**Cost:** Free network registration. Some Seller App providers charge ₹500–2,000/month for their integration layer.

### Dunzo / Magicpin

**Both are accessed via UrbanPiper** in Atithi-Setu's current implementation. Direct partner programs exist but are typically harder to access for single outlets.

If you have a direct contract with either, you'd add a `DunzoDirectAdapter` / `MagicpinDirectAdapter` following the same pattern as `SwiggyDirectAdapter` — the architecture is fully pluggable.

---

## Security & compliance notes

### Credentials are encrypted at rest

Every API key, HMAC secret, and store id is stored in the `integration_credentials` table encrypted with AES-256-GCM. The encryption master key (`ATITHI_CREDENTIAL_KEY`) lives in the deploy environment only. The UI never displays secret material back to the owner — once saved, the form clears. To rotate, paste a new value and save.

If `ATITHI_CREDENTIAL_KEY` is rotated, **all existing credentials need to be re-entered** since the old ciphertext was encrypted with the old key. Do this on a maintenance window.

### Webhook signature verification

Every inbound webhook is verified using the platform-specific signing scheme:

- **UrbanPiper / Swiggy / Zomato direct**: HMAC-SHA256 over the raw request body, hex-encoded, with timestamp skew window of ±5 min to defend against replay
- **ONDC**: Ed25519 signature with `created`/`expires` timestamps in the Authorization header

Failures fire a `WEBHOOK_SIGNATURE_FAILURE` notification when 5+ failures occur in a 10-minute window — the typical sign that the platform rotated its HMAC secret without telling you.

### Idempotency

Every inbound webhook is deduplicated by `sha256(channel + ':' + signature_header)` stored in the `webhook_inbox.idempotency_key` column. Replays return the cached response without re-processing the order. Combined with the partial UNIQUE INDEX on `orders.external_id_hash`, double-processing is impossible even under network retries.

### GST under Sec 9(5) of CGST Act

For ECO (E-Commerce Operator) collected orders — which includes Swiggy, Zomato, Dunzo, etc. — the platform remits GST on the restaurant's behalf. Atithi-Setu records this on every order via the `gst_collected_by` column (`PLATFORM` or `RESTAURANT`).

Confirm with your CA before exporting books for monthly returns. The audit trail is intact — every platform order has the field set and the original webhook payload preserved in `external_payload` for forensic review.

### PCI / payment data

**Atithi-Setu never receives card data from platforms.** The platforms collect payment from the customer, take their commission, and remit your share via weekly settlement transfer. The settlement CSV upload (Delivery Partners → Settlements) is how you reconcile what they paid you against what you served.

---

**Plan reference:** `C:\Users\Admin\.claude\plans\i-need-to-setup-nifty-hammock.md`

**Validation:** `node scripts/validate-delivery-integration.cjs --server https://<tenant> --restaurant <id>`

**Demo seeder:** `node scripts/seed-delivery-vivek.cjs --help` (run with `--dry-run` first)

**Last updated:** 2026-05-10
