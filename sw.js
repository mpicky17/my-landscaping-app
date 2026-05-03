// sw.js — Service Worker for My Landscaping PWA
// Cache-first for assets, network-first for HTML.
// Bump CACHE_NAME (and APP_VERSION in index.html) to invalidate cache on updates.

const CACHE_NAME = 'my-landscaping-v11';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './sw.js',
  './icon-192.png',
  './icon-512.png',
];

// ── Install: pre-cache all assets ────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

// ── Activate: delete stale caches from previous versions ─────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  // Skip external requests (tile servers, APIs) — let browser handle them
  if (!event.request.url.startsWith(self.location.origin)) return;

  // Network-first for HTML navigation AND app.js (ensures version badge updates on normal refresh)
  if (event.request.mode === 'navigate' || event.request.url.endsWith('/app.js')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for all other assets
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      });
    })
  );
});
