const CACHE_NAME = 'wandertale-v4';

const FILES_TO_CACHE = [
  '/wandertale-pwa/',
  '/wandertale-pwa/index.html',
  '/wandertale-pwa/app.js',
  '/wandertale-pwa/manifest.json'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(FILES_TO_CACHE))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// No fetch handler — let all requests go directly to network
