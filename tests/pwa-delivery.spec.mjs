import { test, expect } from '@playwright/test';

test('service worker keeps optional multi-megabyte feature assets out of the install shell', async ({ request }) => {
  const response = await request.get('/sw.js');
  expect(response.ok()).toBeTruthy();
  const source = await response.text();
  const core = source.match(/const CORE_SHELL = \[([\s\S]*?)\];/)?.[1] || '';
  expect(core).not.toMatch(/tesseract-core|traineddata|xlsx|jspdf|chart\.umd|jszip/i);
  expect(source).toContain("request.mode === 'navigate'");
  expect(source).toContain("new Response('Asset unavailable offline', { status: 504 })");
  expect(source).toContain('await caches.delete(CORE_CACHE)');
  expect(source).toContain('Vault shell install failed');
});

test('installed application shell can navigate while offline', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage();
  await page.goto('/index.html');
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#authForm')).toBeVisible({ timeout: 15000 });
  await context.close();
});

test('build and vendor integrity manifests are present in the deployment artifact', async ({ request }) => {
  const build = await request.get('/build-info.json');
  // Source-tree tests do not have build-info.json; artifact tests in CI do.
  if (process.env.TEST_SITE_DIR === 'dist') {
    expect(build.ok()).toBeTruthy();
    const buildInfo = await build.json();
    expect(buildInfo.version).toMatch(/^2\./);
    expect(buildInfo.buildId).toContain(buildInfo.version);

    const vendor = await request.get('/vendor/manifest.json');
    expect(vendor.ok()).toBeTruthy();
    const manifest = await vendor.json();
    expect(manifest.vendors.length).toBeGreaterThanOrEqual(9);
    for (const entry of manifest.vendors) expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);

    const integrity = await request.get('/integrity-manifest.json');
    expect(integrity.ok()).toBeTruthy();
    expect(Object.keys((await integrity.json()).files).length).toBeGreaterThan(20);
  } else {
    expect([200, 404]).toContain(build.status());
  }
});

test('optional libraries load only when requested', async ({ page }) => {
  const optionalRequests = [];
  page.on('request', (request) => {
    if (/xlsx|jspdf|tesseract|qrcode|jszip|chart\.umd/.test(request.url())) optionalRequests.push(request.url());
  });
  await page.goto('/robots.txt');
  await page.addScriptTag({ url: '/js/asset-loader.js' });
  expect(optionalRequests).toHaveLength(0);
  await page.evaluate(() => VaultAssets.ensure('qr'));
  expect(optionalRequests.some((url) => url.endsWith('/vendor/qrcode.min.js'))).toBe(true);
  expect(await page.evaluate(() => typeof window.QRCode)).toBe('function');
});
