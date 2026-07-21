// Small, versioned application-shell cache. Optional OCR/export libraries are
// cached only after the feature requests them; they are never part of install.
const BUILD_ID = '__VAULT_BUILD_ID__';
const CORE_CACHE = `firearms-vault-core-${BUILD_ID}`;
const RUNTIME_CACHE = `firearms-vault-runtime-${BUILD_ID}`;
const CACHE_PREFIX = 'firearms-vault-';
const CORE_SHELL = [
  './', './index.html', './share.html',
  './css/fonts.css', './css/styles.css', './css/vault-ui.css',
  './js/config.js', './js/security.js', './js/data-safety.js', './js/asset-loader.js', './js/data-quality.js',
  './js/supabase-client.js', './js/app.js', './js/cloud-sync.js', './js/auth.js', './js/action-runtime.js', './js/ui-shell.js',
  './js/pwa-register.js', './js/share.js',
  './vendor/supabase.js', './vendor/fonts/InterVariable.woff2',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'
];

async function cacheCore() {
  const cache = await caches.open(CORE_CACHE);
  const results = await Promise.allSettled(CORE_SHELL.map(async (url) => {
    const response = await fetch(new Request(url, { cache: 'reload' }));
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    await cache.put(url, response);
  }));
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length) {
    // Never activate a new worker with a partial shell: keep the last complete
    // version in control and discard this incomplete cache.
    await caches.delete(CORE_CACHE);
    throw new Error(`Vault shell install failed for ${failed.length} required entries.`);
  }
}

self.addEventListener('install', (event) => event.waitUntil(cacheCore()));

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && ![CORE_CACHE, RUNTIME_CACHE].includes(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  const message = event.data;
  if (message === 'SKIP_WAITING' || (message && message.type === 'SKIP_WAITING')) self.skipWaiting();
  if (message && message.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'VAULT_VERSION', buildId: BUILD_ID });
  }
});

async function networkFirst(request, fallback) {
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    if (response.ok) {
      (await caches.open(RUNTIME_CACHE)).put(request, response.clone()).catch(() => {});
      return response;
    }
    // A transient origin/CDN 5xx must not replace a previously complete app
    // shell. Preserve normal 4xx responses so a genuinely missing route is not
    // disguised as the vault.
    if (response.status >= 500 && response.status <= 599) {
      return (await caches.match(request)) || (fallback ? await caches.match(fallback) : null) || response;
    }
    return response;
  } catch (_) {
    return (await caches.match(request)) || (fallback ? await caches.match(fallback) : null) || new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const update = fetch(request)
    .then(async (response) => {
      if (response.ok) await (await caches.open(RUNTIME_CACHE)).put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || await update || new Response('Asset unavailable offline', { status: 504 });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    const fallback = url.pathname.endsWith('/share.html') ? './share.html' : './index.html';
    event.respondWith(networkFirst(request, fallback));
    return;
  }

  if (url.pathname.endsWith('/js/config.js') || url.pathname.endsWith('/sw.js') || url.pathname.endsWith('/build-info.json')) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (['script', 'style', 'font', 'image'].includes(request.destination) || /\.(?:wasm|gz|json)$/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
