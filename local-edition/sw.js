// Service worker for the Local Edition: offline app shell, network-first so an
// online reload always gets the latest code, with a cached fallback offline.
// Only same-origin requests are intercepted; CDN libraries pass straight
// through to the network (and the browser's own HTTP cache).
const CACHE = 'firearms-vault-local-v2';
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './css/fonts.css',
  './js/app.js',
  './js/local-store.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/chart.umd.js',
  './vendor/xlsx.full.min.js',
  './vendor/jspdf.umd.min.js',
  './vendor/jspdf.plugin.autotable.min.js',
  './vendor/qrcode.min.js',
  './vendor/jszip.min.js',
  './vendor/fonts/InterVariable.woff2'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING' || (e.data && e.data.type === 'SKIP_WAITING')) self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let CDN libraries pass through

  e.respondWith(
    fetch(req, { cache: 'no-store' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
  );
});
