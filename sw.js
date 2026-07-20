// Service worker: offline app shell with a network-first strategy so online
// users always get the latest code, and offline users still get the app.
// Cross-origin requests (Supabase API/Storage, CDN libraries) are never
// intercepted — they always go straight to the network.
//
// Update flow: a new worker does NOT skip waiting on its own. It waits until
// the page tells it to (postMessage 'SKIP_WAITING' from the "Reload" banner),
// then activates and claims clients so the page can reload onto fresh code.
const CACHE = 'firearms-vault-v35';
const SHELL = [
  './',
  './index.html',
  './css/fonts.css',
  './css/styles.css',
  './js/config.js',
  './js/supabase-client.js',
  './js/app.js',
  './js/cloud-sync.js',
  './js/auth.js',
  './js/share.js',
  './share.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/xlsx.full.min.js',
  './vendor/jspdf.umd.min.js',
  './vendor/jspdf.plugin.autotable.min.js',
  './vendor/qrcode.min.js',
  './vendor/supabase.js',
  './vendor/jszip.min.js',
  './vendor/chart.umd.js',
  './vendor/fonts/InterVariable.woff2',
  './vendor/tesseract/tesseract.min.js',
  './vendor/tesseract/worker.min.js',
  './vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
  './vendor/tesseract/tesseract-core-lstm.wasm.js',
  './vendor/tesseract/lang/eng.traineddata.gz'
];

self.addEventListener('install', (e) => {
  // Precache with cache:'reload' so the shell is fetched from the network,
  // never from a stale HTTP cache.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The page asks the waiting worker to take over immediately.
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING' || (e.data && e.data.type === 'SKIP_WAITING')) self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let CDN + Supabase pass through

  // Network-first, bypassing the browser HTTP cache so a reload always pulls
  // fresh code; fall back to the cached shell when offline.
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
