import { test, expect } from '@playwright/test';

test('sign-out safety check allows a cloud failure only after the pending snapshot is durable locally', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#authForm')).toBeVisible({ timeout: 15000 });

  const result = await page.evaluate(async () => {
    const uid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uid);
    db = {
      version: 3, encrypted: false,
      firearms: [{ id: 'pending-one', make: 'Pending', model: 'Save', images: [], tags: [], customFields: [], maintenanceLog: [] }],
      ammo: [], accessories: [], wishlist: [], dealers: [], backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    imagesDb = {};
    CloudSync.ready = true;
    CloudSync.revision = 4;
    CloudSync.serverUpdatedAt = '2026-07-20T00:00:00.000Z';
    CloudSync.serverMediaManifest = {};
    CloudSync._lastCommittedData = { version: 3, firearms: [] };
    CloudSync._casRpcSupported = true;
    hasUnsavedChanges = true;

    window.sbClient = {
      storage: {
        from() {
          return {
            async upload() { return { data: null, error: null }; },
            async remove() { return { data: [], error: null }; }
          };
        }
      },
      async rpc() { return { data: null, error: { message: 'simulated cloud outage', code: '503' } }; }
    };

    const safety = await CloudSync.prepareForSignOut();
    const outbox = await CloudSync.storeGet('outbox', uid);
    const secondaryOutbox = await VaultDataSafety.listOutbox(uid);
    clearTimeout(CloudSync._retryTimer);
    return { safety, hasPrimaryOutbox: !!outbox, secondaryCount: secondaryOutbox.length, dirty: hasUnsavedChanges };
  });

  expect(result.safety.ok).toBe(true);
  expect(result.safety.cloudSafe).toBe(false);
  expect(result.safety.localSafe).toBe(true);
  expect(result.hasPrimaryOutbox).toBe(true);
  expect(result.secondaryCount).toBeGreaterThan(0);
  expect(result.dirty).toBe(false);
});
