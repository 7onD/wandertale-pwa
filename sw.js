const CACHE_NAME = 'wandertale-v2';

const APP_SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/manifest.json',
];

// ── Install: cache the app shell ──────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL);
    })
  );
  self.skipWaiting();
});

// ── Activate: remove old caches ───────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: network-only for external, cache-first for same-origin ────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always pass external requests (API calls) directly to network
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request));
    return;
  }

  // For same-origin requests — serve from cache, fallback to network
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
