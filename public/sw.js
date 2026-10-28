// Wyticle service worker: offline fallback only. Updates must always win over the cache.
// - Pages and every non-hashed file: network first (always fresh), cache used only when offline.
// - /assets/* (Vite hashed filenames, content never changes for a given name): cache first.
// - /api/*: never touched.
const VERSION = 'v2';
const SHELL_CACHE = `wyticle-shell-${VERSION}`;
const ASSET_CACHE = `wyticle-assets-${VERSION}`;
const KEEP = new Set([SHELL_CACHE, ASSET_CACHE]);
const SHELL = ['./manifest.webmanifest', './wyticle-icon.svg', './favicon.png', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('wyticle-') && !KEEP.has(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => { if (event.data === 'SKIP_WAITING') self.skipWaiting(); });

const networkFirst = (request, cacheKey) =>
  fetch(request, { cache: 'no-store' })
    .then(response => {
      if (response.ok) { const copy = response.clone(); caches.open(SHELL_CACHE).then(cache => cache.put(cacheKey || request, copy)); }
      return response;
    })
    .catch(async () => (await caches.match(cacheKey || request)) || (await caches.match('./index.html')) || Response.error());

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') { event.respondWith(networkFirst(request, './index.html')); return; }
  if (url.pathname.includes('/assets/')) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) { const copy = response.clone(); caches.open(ASSET_CACHE).then(cache => cache.put(request, copy)); }
      return response;
    })));
    return;
  }
  event.respondWith(networkFirst(request));
});
