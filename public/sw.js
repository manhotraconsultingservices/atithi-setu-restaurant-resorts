/**
 * Atithi Setu — Service Worker
 *
 * Strategy:
 *   - Static assets (JS, CSS, fonts, images): cache-first with background revalidation
 *   - API calls (/api/*): network-first, never cached
 *   - Navigation (HTML): network-first, fall back to cached shell
 */

const CACHE_NAME = 'atithi-setu-v1';
const SHELL_URL  = '/';

// Assets we pre-cache at install time (the app shell)
const PRECACHE_URLS = [
  '/',
  '/favicon.svg',
  '/manifest.json',
  '/icon-192x192.png',
  '/icon-512x512.png',
  '/apple-touch-icon.png',
];

// ── Install: pre-cache the shell ──────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// ── Activate: remove old caches ───────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: route-based strategy ───────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // API: always network-first, never cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // Static assets (.js, .css, images, fonts): cache-first
  if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf|ico|webp)(\?.*)?$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const networkFetch = fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        });
        return cached || networkFetch;
      })
    );
    return;
  }

  // Navigation (HTML pages): network-first, fall back to shell
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(SHELL_URL).then((r) => r || caches.match('/'))
      )
    );
    return;
  }
});
