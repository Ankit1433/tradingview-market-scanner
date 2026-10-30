const CACHE_NAME = 'market-scanner-shell-v9';
const APP_SHELL = [
  '/assets/workspace.css',
  '/assets/workspace.js',
  '/assets/pages.css',
  '/assets/pages.js',
  '/assets/accounts.css',
  '/assets/accounts.js',
  '/assets/symbol-chart.js',
  '/icons/market-scanner-192.png',
  '/icons/market-scanner-512.png'
];
self.addEventListener('install', event => event.waitUntil(
  caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
));
self.addEventListener('activate', event => event.waitUntil(
  caches.keys().then(keys => Promise.all(
    keys.filter(k => k.startsWith('market-scanner-shell-') && k !== CACHE_NAME).map(k => caches.delete(k))
  )).then(() => self.clients.claim())
));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !APP_SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
