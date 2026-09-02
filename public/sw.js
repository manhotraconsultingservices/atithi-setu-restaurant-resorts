/**
 * Atithi Setu — Service Worker  (v2 — self-purging pass-through)
 *
 * WHY THIS EXISTS
 *   The previous worker cached JS/CSS "cache-first" into a cache
 *   ('atithi-setu-v1') that was NEVER invalidated across deploys, and it
 *   pre-cached the HTML shell '/' once at install. Result: clients could keep
 *   loading an OLD app bundle even after a hard reload, so freshly-deployed
 *   fixes (RBAC, nav visibility, …) never reached them and the same bug got
 *   re-reported. This is a frequently-deployed online ERP — an app-shell cache
 *   is a liability, not a feature.
 *
 * STRATEGY (safe by design)
 *   - Fetch: PASS-THROUGH. We never call respondWith, so every request goes to
 *     the network with normal HTTP-cache semantics. Hash-named assets stay
 *     cacheable via their headers; index.html (max-age=0) is always fresh.
 *     The worker can no longer serve a stale bundle.
 *   - Activate: purge EVERY cache (removes the poisoned 'atithi-setu-v1'), and
 *     for any client that still had a cache, force one clean reload so it lands
 *     on current code immediately instead of needing a second manual refresh.
 *     Clients with no cache (already migrated) are never force-reloaded.
 *
 *   The worker stays registered (PWA installability intact) but is inert for
 *   fetches. Future sw.js changes won't force-reload anyone because a
 *   pass-through worker creates no caches — only the one-time migration off the
 *   old cache triggers a reload.
 */

self.addEventListener('install', () => {
  // Take over as soon as possible so the purge below runs on this navigation.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const hadPoison = keys.length > 0;          // old worker left a cache behind
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();

    if (hadPoison) {
      // One-time: clients still holding the stale cache get a clean reload so
      // they immediately run current code. Runs at most once per client
      // (a pass-through worker never creates a cache again).
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        try { client.navigate(client.url); } catch (_) { /* best effort */ }
      }
    }
  })());
});

// No 'fetch' handler → the browser handles every request normally (network +
// HTTP cache). Nothing is served from a worker cache, so nothing goes stale.
