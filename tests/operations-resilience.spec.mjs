import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const projectRoot = process.cwd();
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function runNode(script, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: projectRoot,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr, output: stdout + stderr }));
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}/`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, headers);
  response.end(body);
}

function healthCanaryFixture(options = {}) {
  const userId = '00000000-0000-4000-8000-000000000001';
  const objects = new Map();
  const requests = [];
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://probe.local');
      requests.push(`${request.method} ${url.pathname}`);
      if (request.method === 'GET' && url.pathname === '/auth/v1/settings') {
        return send(response, 200, '{}', { 'content-type': 'application/json' });
      }
      if (request.method === 'GET' && url.pathname === '/rest/v1/collections') {
        return send(response, 200, '[]', { 'content-type': 'application/json' });
      }
      if (request.method === 'POST' && url.pathname === '/auth/v1/token') {
        return send(response, 200, JSON.stringify({ access_token: 'test-access-token', user: { id: userId } }), { 'content-type': 'application/json' });
      }
      if (request.method === 'POST' && url.pathname === '/rest/v1/rpc/run_health_check_canary') {
        return send(response, 200, JSON.stringify({ ok: true, deleted: 1 }), { 'content-type': 'application/json' });
      }
      if (url.pathname.startsWith('/storage/v1/object/public/media/')) {
        const objectPath = decodeURIComponent(url.pathname.slice('/storage/v1/object/public/media/'.length));
        if (request.method === 'GET' && options.publicLeak && objects.has(objectPath)) {
          return send(response, 200, objects.get(objectPath), { 'content-type': 'text/plain' });
        }
        if (request.method === 'GET') return send(response, 404, JSON.stringify({ message: 'Object not found' }), { 'content-type': 'application/json' });
      }
      if (url.pathname.startsWith('/storage/v1/object/media/')) {
        const objectPath = decodeURIComponent(url.pathname.slice('/storage/v1/object/media/'.length));
        if (request.method === 'POST') {
          objects.set(objectPath, await requestBody(request));
          return send(response, 200, JSON.stringify({ Key: `media/${objectPath}` }), { 'content-type': 'application/json' });
        }
        const authorization = String(request.headers.authorization || '');
        const allowed = authorization === 'Bearer test-access-token' || (options.anonLeak && authorization === 'Bearer test-anon-key');
        if (request.method === 'GET' && allowed && objects.has(objectPath)) return send(response, 200, objects.get(objectPath), { 'content-type': 'text/plain' });
        if (request.method === 'GET' && objects.has(objectPath)) return send(response, 403, JSON.stringify({ message: 'Access denied' }), { 'content-type': 'application/json' });
        if (request.method === 'GET') return send(response, 404, JSON.stringify({ message: 'Object not found' }), { 'content-type': 'application/json' });
      }
      if (request.method === 'DELETE' && url.pathname === '/storage/v1/object/media') {
        const body = JSON.parse((await requestBody(request)).toString('utf8'));
        body.prefixes.forEach((prefix) => objects.delete(prefix));
        return send(response, 200, '[]', { 'content-type': 'application/json' });
      }
      send(response, 404, 'not found');
    } catch (error) {
      send(response, 500, String(error && error.message));
    }
  });
  return { server, userId, objects, requests };
}

const productionHealthEnvironment = (baseUrl) => ({
  SUPABASE_URL: baseUrl,
  SUPABASE_ANON_KEY: 'test-anon-key',
  HEALTH_CHECK_MODE: 'production',
  HEALTH_REQUEST_TIMEOUT_MS: '5000',
  CANARY_EMAIL: 'canary@example.test',
  CANARY_PASSWORD: 'test-password-not-a-secret',
  CANARY_STORAGE_BUCKET: 'media',
  ALLOW_INSECURE_SUPABASE: 'true',
  GITHUB_ACTIONS: 'false'
});

test('production Supabase health mode performs database and private Storage round trips', async () => {
  const { server, userId, objects, requests } = healthCanaryFixture();
  const baseUrl = await listen(server);
  try {
    const result = await runNode('scripts/check-supabase-health.mjs', productionHealthEnvironment(baseUrl));
    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain('CHECK_OK stage=database write=passed delete=passed');
    expect(result.stdout).toContain('storage_public_http=404 storage_anon_http=403 visible_objects=0');
    expect(result.stdout).toContain('privacy=passed upload=passed download=passed checksum=passed delete=passed');
    expect(result.stdout).toContain('CHECK_COMPLETE status=healthy');
    expect(objects.size).toBe(0);
    expect(requests.some((entry) => entry.startsWith(`POST /storage/v1/object/media/${userId}/health-canary/`))).toBeTruthy();
    expect(requests.some((entry) => entry.startsWith(`GET /storage/v1/object/public/media/${userId}/health-canary/`))).toBeTruthy();
    expect(requests).toContain('DELETE /storage/v1/object/media');
  } finally {
    await close(server);
  }
});

for (const [exposure, fixtureOptions, expectedMessage] of [
  ['public bucket route', { publicLeak: true }, 'downloadable through the public bucket route'],
  ['anonymous Supabase session', { anonLeak: true }, 'downloadable by an anonymous Supabase session']
]) {
  test(`production Supabase health mode fails when Storage leaks through the ${exposure}`, async () => {
    const { server, objects } = healthCanaryFixture(fixtureOptions);
    const baseUrl = await listen(server);
    try {
      const result = await runNode('scripts/check-supabase-health.mjs', productionHealthEnvironment(baseUrl));
      expect(result.code, result.output).toBe(4);
      expect(result.output).toContain('CHECK_FAILED stage=privacy code=4');
      expect(result.output).toContain(expectedMessage);
      expect(objects.size).toBe(0);
    } finally {
      await close(server);
    }
  });
}

test('production Supabase health mode fails closed when canary credentials are absent', async () => {
  const result = await runNode('scripts/check-supabase-health.mjs', {
    SUPABASE_URL: 'http://127.0.0.1:9/',
    SUPABASE_ANON_KEY: 'test-anon-key',
    HEALTH_CHECK_MODE: 'production',
    CANARY_EMAIL: '',
    CANARY_PASSWORD: '',
    ALLOW_INSECURE_SUPABASE: 'true',
    GITHUB_ACTIONS: 'false'
  });
  expect(result.code).toBe(2);
  expect(result.output).toContain('CHECK_FAILED stage=configuration code=2');
  expect(result.output).toContain('refusing to report a reachability-only check as healthy');
});

test('deployment workflows use the hardened production and Supabase probes', async () => {
  const keepalive = await fs.readFile(path.join(projectRoot, '.github/workflows/supabase-keepalive.yml'), 'utf8');
  expect(keepalive).toContain('HEALTH_CHECK_MODE: basic');
  expect(keepalive).toContain('HEALTH_CHECK_MODE: production');
  expect(keepalive.match(/node scripts\/check-supabase-health\.mjs/g) || []).toHaveLength(2);
  expect(keepalive).toContain('secrets.SUPABASE_CANARY_EMAIL');
  expect(keepalive).toContain('secrets.SUPABASE_CANARY_PASSWORD');
  expect(keepalive).toContain('CANARY_STORAGE_BUCKET: media');
  expect(keepalive).toContain('node scripts/check-supabase-health.mjs');
  expect(keepalive).toContain("cron: '17 9 * * *'");
  expect(keepalive).toContain('repository-activity-heartbeat:');
  expect(keepalive).toContain('contents: write');
  expect(keepalive).toContain('.github/supabase-monitor-heartbeat');

  const deploy = await fs.readFile(path.join(projectRoot, '.github/workflows/deploy.yml'), 'utf8');
  expect(deploy).toContain('node scripts/check-production.mjs');
  expect(deploy).toContain('EXPECTED_REVISION: ${{ github.sha }}');
  expect(deploy).toContain("vars.SECURITY_HEADER_POLICY || 'report'");
});

function productionFixture(revision = 'abcdef123456') {
  const buildInfo = Buffer.from(JSON.stringify({
    name: 'firearms-db',
    version: '2.1.0',
    revision,
    buildId: `2.1.0-${revision}`,
    builtAt: new Date().toISOString()
  }));
  const files = {
    'index.html': Buffer.from('<!doctype html><form id="authForm"></form><div id="appRoot"></div>'),
    'build-info.json': buildInfo,
    'sw.js': Buffer.from("const BUILD_ID = '2.1.0-abcdef123456';"),
    'js/config.js': Buffer.from("window.SUPABASE_URL = 'https://example.supabase.co';"),
    'css/styles.css': Buffer.from(':root { color-scheme: light; }'),
    'css/vault-ui.css': Buffer.from('.vault-shell { display: grid; }'),
    'js/app.js': Buffer.from('window.FirearmsVault = {};'),
    'js/auth.js': Buffer.from('window.Auth = {};'),
    'js/cloud-sync.js': Buffer.from('window.CloudSync = {};'),
    'js/action-runtime.js': Buffer.from('window.VaultActions = {};'),
    'js/security.js': Buffer.from('window.VaultSecurity = {};'),
    'js/data-safety.js': Buffer.from('window.DataSafety = {};'),
    'js/ui-shell.js': Buffer.from('window.VaultUI = {};'),
    'js/pwa-register.js': Buffer.from('window.VaultPWA = {};')
  };
  const manifest = {
    build: JSON.parse(buildInfo.toString('utf8')),
    files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, { bytes: body.length, sha256: sha256(body) }]))
  };
  return { files, integrity: Buffer.from(JSON.stringify(manifest)) };
}

test('production probe verifies revision, artifact hashes, and enforceable headers', async () => {
  const fixture = productionFixture();
  const rootHeaders = {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
    'strict-transport-security': 'max-age=31536000',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'geolocation=()',
    'cross-origin-opener-policy': 'same-origin',
    'x-robots-tag': 'noindex, nofollow'
  };
  const noCache = 'no-cache, no-store, must-revalidate';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://probe.local');
    if (url.pathname === '/') return send(response, 200, fixture.files['index.html'], rootHeaders);
    if (url.pathname === '/build-info.json') return send(response, 200, fixture.files['build-info.json'], { 'content-type': 'application/json', 'cache-control': noCache });
    if (url.pathname === '/integrity-manifest.json') return send(response, 200, fixture.integrity, { 'content-type': 'application/json' });
    if (url.pathname === '/sw.js') return send(response, 200, fixture.files['sw.js'], { 'content-type': 'application/javascript', 'cache-control': noCache });
    if (url.pathname === '/js/config.js') return send(response, 200, fixture.files['js/config.js'], { 'content-type': 'application/javascript', 'cache-control': noCache });
    const assetName = url.pathname.replace(/^\//, '');
    if (fixture.files[assetName]) {
      const contentType = assetName.endsWith('.css') ? 'text/css' : 'application/javascript';
      return send(response, 200, fixture.files[assetName], { 'content-type': contentType });
    }
    send(response, 404, 'not found');
  });
  const baseUrl = await listen(server);
  try {
    const result = await runNode('scripts/check-production.mjs', {
      PRODUCTION_URL: baseUrl,
      ALLOW_INSECURE_PROBE: 'true',
      EXPECTED_REVISION: 'abcdef1234567890abcdef1234567890abcdef12',
      SECURITY_HEADER_POLICY: 'required',
      PROBE_ATTEMPTS: '1',
      PROBE_RETRY_MS: '0',
      GITHUB_ACTIONS: 'false'
    });
    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain('PROBE_OK build=2.1.0-abcdef123456 integrity=verified header_gaps=0');
  } finally {
    await close(server);
  }
});

test('cached application shell wins over a transient navigation 5xx', async () => {
  const source = await fs.readFile(path.join(projectRoot, 'sw.js'), 'utf8');
  const cachedShell = new Response('cached vault shell', { status: 200, headers: { 'content-type': 'text/html' } });
  const context = vm.createContext({
    URL,
    Request,
    Response,
    Promise,
    console,
    fetch: async () => new Response('temporary upstream failure', { status: 503 }),
    caches: {
      open: async () => ({ put: async () => {} }),
      keys: async () => [],
      delete: async () => true,
      match: async (value) => value === './index.html' ? cachedShell.clone() : null
    },
    self: {
      location: { origin: 'https://vault.example.test' },
      clients: { claim: async () => {} },
      addEventListener: () => {},
      skipWaiting: async () => {}
    }
  });
  vm.runInContext(source, context);
  const networkFirst = vm.runInContext('networkFirst', context);
  const response = await networkFirst(new Request('https://vault.example.test/index.html'), './index.html');
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('cached vault shell');
});

test('PWA update pauses reload until pending changes and open forms are safe', async ({ page, request }) => {
  const source = await (await request.get('/js/pwa-register.js')).text();
  await page.goto('/robots.txt');
  await page.evaluate(async (scriptSource) => {
    document.body.innerHTML = '';
    window.hasUnsavedChanges = true;
    window.__canUpdateSafely = false;
    window.__workerMessages = [];
    window.__updateChecks = 0;
    window.CloudSync = {
      ready: true,
      prepareForSignOut: async () => ({ ok: window.__canUpdateSafely })
    };
    const waiting = {
      state: 'installed',
      postMessage: (message) => window.__workerMessages.push(message),
      addEventListener: () => {}
    };
    const registration = {
      waiting,
      installing: null,
      update: async () => { window.__updateChecks += 1; },
      addEventListener: () => {}
    };
    const serviceWorker = {
      controller: {},
      register: async () => registration,
      addEventListener: () => {}
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });

    const loadCallbacks = [];
    const originalAddEventListener = window.addEventListener;
    window.addEventListener = function (type, listener, options) {
      if (type === 'load') loadCallbacks.push(listener);
      else return originalAddEventListener.call(window, type, listener, options);
    };
    new Function(scriptSource)();
    window.addEventListener = originalAddEventListener;
    await loadCallbacks[0]();
    await Promise.resolve();
  }, source);

  await expect(page.locator('#updateBanner')).toBeVisible();
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await expect.poll(() => page.evaluate(() => window.__updateChecks)).toBe(1);
  await page.getByRole('button', { name: 'Update now' }).click();
  await expect(page.getByRole('button', { name: 'Retry update' })).toBeEnabled();
  await expect(page.locator('#updateBanner')).toContainText('could not be saved safely');
  expect(await page.evaluate(() => window.__workerMessages)).toEqual([]);

  await page.evaluate(() => {
    window.__canUpdateSafely = true;
    const dirtyDialog = document.createElement('div');
    dirtyDialog.id = 'dirtyEditDialog';
    dirtyDialog.className = 'modal-overlay open';
    dirtyDialog.dataset.dirty = 'true';
    document.body.appendChild(dirtyDialog);
  });
  await page.getByRole('button', { name: 'Retry update' }).click();
  await expect(page.getByRole('button', { name: 'Retry update' })).toBeEnabled();
  await expect(page.locator('#updateBanner')).toContainText('Finish, save, or close the open form');
  expect(await page.evaluate(() => window.__workerMessages)).toEqual([]);

  await page.evaluate(() => { document.getElementById('dirtyEditDialog').dataset.dirty = 'false'; });
  await page.getByRole('button', { name: 'Retry update' }).click();
  await expect(page.locator('#updateBanner')).toContainText('Applying the update');
  expect(await page.evaluate(() => window.__workerMessages)).toEqual([{ type: 'SKIP_WAITING' }]);
});
