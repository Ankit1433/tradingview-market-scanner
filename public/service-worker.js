const CACHE_NAME = 'market-scanner-shell-v2';
const APP_SHELL = [
  '/app',
  '/manifest.webmanifest',
  '/icons/market-scanner-192.png',
  '/icons/market-scanner-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith('market-scanner-shell-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Live scanner data and event streams must always come from the network.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate' && (url.pathname === '/app' || url.pathname === '/app/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (!response.ok) return response;
          return caches.open(CACHE_NAME)
            .then((cache) => cache.put('/app', response.clone()))
            .then(() => response)
            .catch(() => response);
        })
        .catch(async () => (await caches.match('/app')) || Response.error()),
    );
    return;
  }

  if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request)),
    );
  }
});
