import { test, expect } from '@playwright/test';

const validToken = '123e4567-e89b-42d3-a456-426614174000';

async function mockShareRpc(page, data) {
  await page.route('**/vendor/supabase.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `window.supabase={createClient:function(){return {rpc:async function(){return {data:${JSON.stringify(data)},error:null}}}}};`
  }));
}

test('missing share tokens show a branded recovery path', async ({ page }) => {
  await page.goto('/share.html?t=incomplete-token');
  await expect(page.locator('.sv-brand-name')).toHaveText('Firearms Vault');
  await expect(page.locator('#shareStateTitle')).toHaveText('This share link is incomplete');
  await expect(page.locator('.sv-state-help')).toContainText('ask the owner');
  await expect(page.getByRole('link', { name: 'Open Firearms Vault' }).last()).toHaveAttribute('href', './');
  await expect(page).toHaveURL(/\/share\.html$/);
});

test('share passcode prompt matches the 12-character owner requirement', async ({ page }) => {
  await mockShareRpc(page, { requiresCode: true, invalidCode: false });
  await page.goto('/share.html#t=' + validToken);

  const input = page.locator('#shareViewerCode');
  await expect(input).toHaveAttribute('minlength', '12');
  await expect(input).toHaveAttribute('maxlength', '72');
  await expect(page.locator('#shareCodeHelp')).toContainText('sent separately');
  await expect(input).toHaveAttribute('type', 'password');
  await page.locator('#showShareCode').click();
  await expect(input).toHaveAttribute('type', 'text');
  await expect(page.locator('#showShareCode')).toHaveAttribute('aria-pressed', 'true');
});

test('shared snapshots explain trust and privacy metadata without cropping images', async ({ page }) => {
  const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  await mockShareRpc(page, {
    snapshotVersion: 1,
    source: 'Firearms Vault',
    label: 'Insurance copy',
    generatedAt: '2026-07-20T12:00:00.000Z',
    includePhotos: true,
    includeSerials: false,
    totals: { firearms: 1, value: 1250, accessories: 0, rounds: 0 },
    firearms: [{ make: 'Example', model: 'Item', type: 'Rifle', caliber: 'Test', price: 1250, photo }],
    accessories: []
  });
  await page.goto('/share.html?t=' + validToken);

  await expect(page).toHaveURL(new RegExp('/share\\.html#t=' + validToken + '$'));
  await expect(page.locator('.sv-brand-name')).toHaveText('Firearms Vault');
  await expect(page.locator('.sv-trust-copy')).toContainText('cannot change the owner');
  await expect(page.locator('.sv-trust-badge')).toContainText(['Read-only', 'Values included', 'Serials excluded', 'Photos included']);
  await expect(page.locator('.sv-img')).toHaveCSS('object-fit', 'contain');
  await expect(page.locator('.sv-img')).toHaveCSS('object-position', '50% 50%');
});

test('owners get copy and revoke controls without a quota-consuming preview link', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate(token => {
    const row = {
      token,
      label: 'Insurance agent',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      max_views: 5,
      access_count: 1,
      last_accessed_at: null,
      has_access_code: true
    };
    window.sbClient = {
      from() {
        const chain = {
          delete() { return chain; },
          select() { return chain; },
          eq() { return chain; },
          lt() { return Promise.resolve({ data: null, error: null }); },
          order() { return Promise.resolve({ data: [row], error: null }); }
        };
        return chain;
      }
    };
    CloudSync.uid = 'owner-1';
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('appRoot').style.display = 'block';
    document.getElementById('shareModal').classList.add('open');
  }, validToken);

  await page.evaluate(() => renderSharesList());
  const shareRow = page.locator('.share-row');
  await expect(shareRow.locator('.share-row-label')).toHaveText('Insurance agent');
  await expect(shareRow.locator('.share-row-meta')).toContainText('passcode protected');
  await expect(shareRow.locator('.share-url')).toHaveText(/Private link ending 14174000/);
  await expect(shareRow.getByRole('link', { name: 'Preview' })).toHaveCount(0);
  const copy = shareRow.getByRole('button', { name: 'Copy' });
  await expect(copy).toBeVisible();
  await expect(shareRow.getByRole('button', { name: 'Revoke' })).toBeVisible();
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  await copy.click();
  await expect(shareRow.locator('.share-url')).toContainText('/share.html#t=' + validToken);
});

test('new snapshots record source and privacy settings for the viewer', async ({ page }) => {
  await page.goto('/index.html');
  const snapshot = await page.evaluate(() => buildShareSnapshot({
    label: 'Test snapshot',
    photos: false,
    serials: false
  }));
  expect(snapshot).toMatchObject({
    snapshotVersion: 1,
    source: 'Firearms Vault',
    includePhotos: false,
    includeSerials: false,
    label: 'Test snapshot'
  });
  expect(snapshot.appVersion).toMatch(/^\d+\.\d+\.\d+$/);
});
