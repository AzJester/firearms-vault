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

test('sign-out stops before sync cleanup when an edited form is still open', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#authForm')).toBeVisible({ timeout: 15000 });

  const result = await page.evaluate(async () => {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
    editingId = 'existing-firearm';
    const modal = document.getElementById('formModal');
    modal.classList.add('open');
    modal.dataset.dirty = 'true';
    window.confirmDialog = async () => true;
    let prepared = 0;
    const original = CloudSync.prepareForSignOut;
    CloudSync.prepareForSignOut = async () => { prepared++; return { ok: true }; };
    try {
      const signOut = await window.Auth.signOut();
      return { signOut, prepared, stillOpen: modal.classList.contains('open'), dirty: modal.dataset.dirty };
    } finally {
      CloudSync.prepareForSignOut = original;
    }
  });

  expect(result.signOut).toMatchObject({ ok: false, status: 'open-form' });
  expect(result.prepared).toBe(0);
  expect(result.stillOpen).toBe(true);
  expect(result.dirty).toBe('true');
});

test('an unrelated older recovery entry cannot make the current failed snapshot safe to sign out', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#authForm')).toBeVisible({ timeout: 15000 });

  const result = await page.evaluate(async () => {
    const uid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uid);
    CloudSync.ready = true;
    const old = {
      version: 3, firearms: [{ id: 'old', make: 'Old recovery', images: [], documents: [] }],
      ammo: [], accessories: [], wishlist: [], dealers: [], settings: {}, auditTrail: [], valueHistory: []
    };
    await VaultDataSafety.enqueue(uid, old, 0);
    db = {
      version: 3, encrypted: false,
      firearms: [{ id: 'current', make: 'Current edit', images: ['current-photo'], documents: [] }],
      ammo: [], accessories: [], wishlist: [], dealers: [], settings: {}, auditTrail: [], valueHistory: []
    };
    imagesDb = { 'current-photo': 'data:image/png;base64,Y3VycmVudA==' };
    hasUnsavedChanges = true;
    const originalMetadata = CloudSync.mediaMetadata;
    CloudSync.mediaMetadata = async () => { throw new Error('simulated current snapshot failure'); };
    try {
      const safety = await CloudSync.prepareForSignOut();
      const recoveryEntries = await VaultDataSafety.listOutbox(uid);
      return { safety, recoveryEntries: recoveryEntries.length, dirty: hasUnsavedChanges };
    } finally {
      CloudSync.mediaMetadata = originalMetadata;
    }
  });

  expect(result.recoveryEntries).toBeGreaterThan(0);
  expect(result.safety).toMatchObject({ ok: false, status: 'unsafe', localSafe: false, cloudSafe: false });
  expect(result.dirty).toBe(true);
});
