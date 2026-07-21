import { test, expect } from '@playwright/test';

// Boots the real app in a browser and proves every app script loaded and ran
// its top-level code without throwing (something static checks can't verify).
test('app boots and shows the login screen', async ({ page }) => {
  const ownErrors = [];
  page.on('pageerror', (e) => {
    const s = (e && e.stack) || String(e);
    if (/\/js\/(app|auth|cloud-sync|supabase-client|config|security|data-safety|action-runtime|ui-shell|pwa-register)\.js/.test(s)) ownErrors.push(s);
  });

  await page.goto('/index.html');

  // The login gate should be visible (no session in a fresh browser).
  await expect(page.locator('#authForm')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#appRoot')).toBeHidden();

  // All our scripts defined their globals => they parsed and executed cleanly.
  const globals = await page.evaluate(() => ({
    bootApp: typeof window.bootApp,
    CloudSync: typeof window.CloudSync,
    toast: typeof window.toast,
    openShareModal: typeof window.openShareModal,
    changeCloudPassword: typeof window.changeCloudPassword,
    VaultUI: typeof window.VaultUI,
    VaultActions: typeof window.VaultActions
  }));
  expect(globals.bootApp).toBe('function');
  expect(globals.CloudSync).toBe('object');
  expect(globals.toast).toBe('function');
  expect(globals.openShareModal).toBe('function');
  expect(globals.changeCloudPassword).toBe('function');
  expect(globals.VaultUI).toBe('object');
  expect(globals.VaultActions).toBe('object');

  expect(ownErrors, 'No runtime errors from app scripts:\n' + ownErrors.join('\n')).toHaveLength(0);
});

test('share viewer page loads and handles a missing token', async ({ page }) => {
  await page.goto('/share.html');
  // With no ?t= token it should render a friendly message, not crash.
  await expect(page.locator('.sv-msg')).toBeVisible({ timeout: 15000 });
});

test('private build self-hosts executable dependencies', async ({ page }) => {
  await page.goto('/index.html');
  const remoteAssets = await page.locator('script[src^="http"], link[rel="stylesheet"][href^="http"]').count();
  expect(remoteAssets).toBe(0);

  const requiredAssets = [
    '/vendor/supabase.js',
    '/vendor/tesseract/worker.min.js',
    '/vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
    '/vendor/tesseract/tesseract-core-lstm.wasm.js',
    '/vendor/tesseract/lang/eng.traineddata.gz',
    '/vendor/fonts/InterVariable.woff2'
  ];
  for (const asset of requiredAssets) {
    const response = await page.request.get(asset);
    expect(response.ok(), `${asset} should be served locally`).toBeTruthy();
  }
});

test('cloud edits autosave without a conflict confirmation', async ({ page }) => {
  const response = await page.request.get('/js/cloud-sync.js');
  expect(response.ok()).toBeTruthy();
  const source = await response.text();
  expect(source).not.toContain('Sync conflict');
  expect(source).not.toContain('Overwrite cloud');
  expect(source).toContain('last-edit-wins');
  expect(source).toContain('Cloud unavailable - safe on this device; retrying');
  expect(source).not.toContain("window.toast('Cloud save failed. Your changes are safe on this device");
});

test('an edit is marked unsafe before asynchronous saving and clears after a durable local commit', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#authForm')).toBeVisible({ timeout: 15000 });

  const state = await page.evaluate(async () => {
    await openStateDB();
    CloudSync.ready = false;
    hasUnsavedChanges = false;
    const saving = saveData();
    const unsafeWhileSaving = hasUnsavedChanges;
    const saved = await saving;
    return { unsafeWhileSaving, safeAfterCommit: !hasUnsavedChanges, saved };
  });

  expect(state.unsafeWhileSaving).toBe(true);
  expect(state.safeAfterCommit).toBe(true);
});

// The standalone, sellable local-only build: no login, no Supabase, no network
// sync — it must boot straight into the app on its own runtime (local-store.js).
const localEditionTest = process.env.TEST_SITE_DIR === 'dist' ? test.skip : test;
localEditionTest('local edition boots with no login and no app-script errors', async ({ page }) => {
  const ownErrors = [];
  page.on('pageerror', (e) => {
    const s = (e && e.stack) || String(e);
    if (/\/local-edition\/js\/(app|local-store)\.js/.test(s)) ownErrors.push(s);
  });

  await page.goto('/local-edition/index.html');

  // No auth gate — the app shell is shown immediately.
  await expect(page.locator('#appRoot')).toBeVisible({ timeout: 15000 });
  // Fresh profile => the first-run sample-data prompt appears.
  await expect(page.locator('#localFirstRun')).toBeVisible({ timeout: 15000 });

  const globals = await page.evaluate(() => ({
    bootApp: typeof window.bootApp,
    loadSampleData: typeof window.loadSampleData,
    restoreLocalBackup: typeof window.restoreLocalBackup,
    CloudSync: typeof window.CloudSync
  }));
  expect(globals.bootApp).toBe('function');
  expect(globals.loadSampleData).toBe('function');
  expect(globals.restoreLocalBackup).toBe('function');
  expect(globals.CloudSync).toBe('object');

  expect(ownErrors, 'No runtime errors from local-edition scripts:\n' + ownErrors.join('\n')).toHaveLength(0);
});
