import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#authForm')).toBeVisible({ timeout: 15000 });
});

test('save status uses explicit safety states and feature errors stay separate', async ({ page }) => {
  const result = await page.evaluate(async () => {
    setSaveStatus('saved');
    const before = document.getElementById('syncStatus').textContent;
    window.VaultAssets = { ensure: async () => { throw new Error('asset offline'); } };
    const loaded = await ensureFeatureAsset('charts', 'Charts');
    const status = document.getElementById('syncStatus');
    return {
      loaded,
      before,
      after: status.textContent,
      saveState: status.dataset.saveState,
      featureError: document.getElementById('featureLoadError')?.textContent || '',
      live: document.getElementById('syncStatusLive').textContent
    };
  });

  expect(result.loaded).toBe(false);
  expect(result.before).toBe('Saved to cloud');
  expect(result.after).toBe('Saved to cloud');
  expect(result.saveState).toBe('saved');
  expect(result.live).toBe('Saved to cloud');
  expect(result.featureError).toContain('Charts could not load');
});

test('boot never changes a failed cloud pull into a synced claim', async ({ page }) => {
  const result = await page.evaluate(async () => {
    CloudSync.uid = '11111111-1111-4111-8111-111111111111';
    CloudSync.ready = true;
    CloudSync.pull = async () => {
      CloudSync.setStatus('Cloud unavailable - safe on this device', 'warning', 'local');
      return { ok: true, status: 'offline-local', localSafe: true, source: 'cache' };
    };
    await bootApp();
    return {
      account: document.getElementById('fileStatusText').textContent,
      status: document.getElementById('syncStatus').textContent,
      state: document.getElementById('syncStatus').dataset.saveState
    };
  });

  expect(result.account).toBe('Using safe device copy');
  expect(result.status).toBe('Cloud unavailable - safe on this device');
  expect(result.state).toBe('local');
  expect(result.account.toLowerCase()).not.toContain('synced');
});

test('missing attachment status opens an actionable recovery view', async ({ page }) => {
  const result = await page.evaluate(async () => {
    document.getElementById('appRoot').style.display = '';
    db = {
      version: 3, encrypted: false,
      firearms: [{
        id: 'firearm-one', make: 'Example', model: 'Carbine', images: ['photo-one'],
        receipt: '@media:receipt:firearm:firearm-one', receiptName: 'purchase.pdf',
        documents: [], tags: [], customFields: [], maintenanceLog: []
      }],
      ammo: [], accessories: [], wishlist: [], dealers: [], backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    const photo = CloudSync.describeMediaKey('photo-one');
    const receipt = CloudSync.describeMediaKey('receipt:firearm:firearm-one');
    CloudSync.missingMedia = [photo, receipt];
    setSaveStatus('degraded', CloudSync.mediaStatusText({ failures: CloudSync.missingMedia }));
    await openSyncCenter();
    return {
      status: document.getElementById('syncStatus').textContent,
      actionable: document.getElementById('syncStatus').dataset.actionable,
      summary: document.getElementById('syncCenterSummary').textContent,
      issues: [...document.querySelectorAll('#syncIssueList .sync-issue')].map(item => item.textContent),
      reattachButtons: [...document.querySelectorAll('#syncIssueList button')].filter(button => button.textContent === 'Reattach file').length,
      removeButtons: [...document.querySelectorAll('#syncIssueList button')].filter(button => button.textContent === 'Remove reference').length
    };
  });

  expect(result.status).toBe('Saved to cloud - 2 attachments need recovery');
  expect(result.actionable).toBe('true');
  expect(result.summary).toContain('2 attachments need recovery');
  expect(result.issues.join(' ')).toContain('Example Carbine');
  expect(result.issues.join(' ')).toContain('purchase.pdf');
  expect(result.reattachButtons).toBe(2);
  expect(result.removeButtons).toBe(2);
});

test('sync status, retry, close, and recovery buttons work through the CSP action bridge', async ({ page }) => {
  await page.evaluate(() => {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
    CloudSync.uid = 'csp-sync-test';
    CloudSync.ready = true;
    CloudSync.missingMedia = [];
    CloudSync.pendingConflict = null;
    CloudSync.syncNow = async () => ({ ok: true, status: 'synced' });
    setSaveStatus('saved');
  });

  await page.locator('#syncStatus').click();
  await expect(page.locator('#syncCenterModal')).toHaveClass(/open/);
  await page.getByRole('button', { name: 'Try sync again' }).click();
  await expect(page.locator('#syncCenterModal')).toHaveClass(/open/);
  await page.locator('#syncCenterModal .modal-footer').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('#syncCenterModal')).not.toHaveClass(/open/);

  await page.locator('#syncStatus').click();
  await page.getByRole('button', { name: 'Data & backups' }).click();
  await expect(page.locator('#syncCenterModal')).not.toHaveClass(/open/);
  await expect(page.locator('#backupModal')).toHaveClass(/open/);
});

test('removing an unavailable reference keeps its inventory record', async ({ page }) => {
  const result = await page.evaluate(() => {
    db = {
      version: 3, encrypted: false,
      firearms: [{
        id: 'firearm-one', make: 'Example', model: 'Carbine', images: ['photo-one'],
        receipt: '@media:receipt:firearm:firearm-one', receiptName: 'purchase.pdf',
        documents: [{ id: 'doc-one', name: 'form.pdf' }], tags: [], customFields: [], maintenanceLog: []
      }],
      ammo: [], accessories: [], wishlist: [], dealers: [], backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    imagesDb = {};
    CloudSync.missingMedia = [
      CloudSync.describeMediaKey('photo-one'),
      CloudSync.describeMediaKey('receipt:firearm:firearm-one'),
      CloudSync.describeMediaKey('doc:firearm-one:doc-one')
    ];
    const photo = CloudSync.removeMediaReference('photo-one');
    const receipt = CloudSync.removeMediaReference('receipt:firearm:firearm-one');
    const document = CloudSync.removeMediaReference('doc:firearm-one:doc-one');
    return {
      ok: [photo.ok, receipt.ok, document.ok],
      firearmCount: db.firearms.length,
      images: db.firearms[0].images,
      receipt: db.firearms[0].receipt,
      documents: db.firearms[0].documents,
      missing: CloudSync.missingMedia.length
    };
  });

  expect(result.ok).toEqual([true, true, true]);
  expect(result.firearmCount).toBe(1);
  expect(result.images).toEqual([]);
  expect(result.receipt).toBeNull();
  expect(result.documents).toEqual([]);
  expect(result.missing).toBe(0);
});

test('explicit conflict choices preserve unrelated edits from both devices', async ({ page }) => {
  const result = await page.evaluate(() => {
    const base = {
      firearms: [
        { id: 'one', make: 'Original', model: 'A' },
        { id: 'two', make: 'Original', model: 'B' }
      ]
    };
    const local = structuredClone(base);
    local.firearms[0].make = 'Device choice';
    local.firearms[1].model = 'Local-only edit';
    const remote = structuredClone(base);
    remote.firearms[0].make = 'Cloud choice';
    remote.firearms[0].model = 'Remote-only edit';

    const device = CloudSync.mergeStructured(base, local, remote, 'local').merged.firearms;
    const cloud = CloudSync.mergeStructured(base, local, remote, 'remote').merged.firearms;
    return { device, cloud };
  });

  expect(result.device.find(item => item.id === 'one')).toMatchObject({ make: 'Device choice', model: 'Remote-only edit' });
  expect(result.cloud.find(item => item.id === 'one')).toMatchObject({ make: 'Cloud choice', model: 'Remote-only edit' });
  expect(result.device.find(item => item.id === 'two').model).toBe('Local-only edit');
  expect(result.cloud.find(item => item.id === 'two').model).toBe('Local-only edit');
});

test('overlapping edits wait quietly in the sync center for an explicit choice', async ({ page }) => {
  const result = await page.evaluate(async () => {
    document.getElementById('appRoot').style.display = '';
    db = {
      version: 3, encrypted: false,
      firearms: [{ id: 'one', make: 'Example', model: 'Carbine', images: [], tags: [], customFields: [], maintenanceLog: [] }],
      ammo: [], accessories: [], wishlist: [], dealers: [], backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    CloudSync.pendingConflict = { paths: ['firearms[one].make'], at: new Date().toISOString() };
    setSaveStatus('conflict');
    await openSyncCenter();
    return {
      status: document.getElementById('syncStatus').textContent,
      issue: document.querySelector('.sync-conflict-item')?.textContent || '',
      actionsVisible: getComputedStyle(document.getElementById('syncConflictActions')).display,
      actionLabels: [...document.querySelectorAll('#syncConflictActions button')].map(button => button.textContent)
    };
  });

  expect(result.status).toBe('Sync needs review');
  expect(result.issue).toContain('Example Carbine - Make');
  expect(result.issue).toContain('nothing will be overwritten automatically');
  expect(result.actionsVisible).not.toBe('none');
  expect(result.actionLabels).toEqual(['Use this device for listed fields', 'Use cloud for listed fields']);
});

test('reviewing a pending conflict rebases the durable outbox before upload', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const uid = '22222222-2222-4222-8222-222222222222';
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uid);
    const base = { version: 3, firearms: [{ id: 'one', make: 'Original', model: 'Original' }], ammo: [], accessories: [], wishlist: [], dealers: [] };
    const local = structuredClone(base);
    local.firearms[0].make = 'Device choice';
    local.firearms[0].model = 'Device-only model';
    const remote = structuredClone(base);
    remote.firearms[0].make = 'Cloud choice';
    await CloudSync.storePut('outbox', {
      uid, id: 'pending-one', data: local, mediaManifest: {}, baseData: base, baseMediaManifest: {},
      baseRevision: 1, baseUpdatedAt: '2026-07-20T00:00:00.000Z', queuedAt: '2026-07-20T00:01:00.000Z',
      conflictAt: '2026-07-20T00:02:00.000Z', conflictPaths: ['firearms[one].make'],
      remoteRevision: 2, remoteUpdatedAt: '2026-07-20T00:02:00.000Z',
      conflictRemoteData: remote, conflictRemoteMediaManifest: {}
    });
    CloudSync.ready = true;
    const originalPush = CloudSync.push;
    CloudSync.push = async () => ({ ok: true, status: 'upload-stub' });
    const resolved = await CloudSync.resolvePendingConflict('cloud');
    const outbox = await CloudSync.storeGet('outbox', uid);
    CloudSync.push = originalPush;
    return {
      resolved,
      data: outbox.data.firearms[0],
      base: outbox.baseData.firearms[0],
      baseRevision: outbox.baseRevision,
      conflictPaths: outbox.conflictPaths || null,
      reason: outbox.reason
    };
  });

  expect(result.resolved.ok).toBe(true);
  expect(result.data).toMatchObject({ make: 'Cloud choice', model: 'Device-only model' });
  expect(result.base).toMatchObject({ make: 'Cloud choice', model: 'Original' });
  expect(result.baseRevision).toBe(2);
  expect(result.conflictPaths).toBeNull();
  expect(result.reason).toBe('conflict-resolution-cloud');
});

test('a concurrent unrelated edit preserves both the chosen cloud winner and the newer edit', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const uid = '23232323-2323-4323-8323-232323232323';
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    await VaultDataSafety.clearState(uid);
    await CloudSync.storeDelete('outbox', uid); await CloudSync.storeDelete('cache', uid);
    const base = {
      version: 3, encrypted: false,
      firearms: [{ id: 'one', make: 'Original', model: 'Original', images: [], documents: [] }],
      ammo: [], accessories: [], wishlist: [], dealers: [], backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    const local = structuredClone(base);
    local.firearms[0].make = 'Device choice';
    local.firearms[0].model = 'Device-only model';
    const remote = structuredClone(base);
    remote.firearms[0].make = 'Cloud choice';
    db = structuredClone(local); imagesDb = {}; hasUnsavedChanges = false;
    await CloudSync.storePut('outbox', {
      uid, id: 'pending-concurrent', data: local, mediaManifest: {}, baseData: base, baseMediaManifest: {},
      baseRevision: 1, baseUpdatedAt: '2026-07-20T00:00:00.000Z', queuedAt: '2026-07-20T00:01:00.000Z',
      sourceId: CloudSync._sourceId, mutationGeneration: CloudSync._mutationGeneration,
      conflictAt: '2026-07-20T00:02:00.000Z', conflictPaths: ['firearms[one].make'],
      conflictSource: 'cloud', remoteRevision: 2, remoteUpdatedAt: '2026-07-20T00:02:00.000Z',
      conflictRemoteData: remote, conflictRemoteMediaManifest: {}
    });
    CloudSync.ready = true;
    const originalPush = CloudSync.push;
    CloudSync.push = async () => ({ ok: true, status: 'upload-stub' });
    const originalSafety = window.VaultDataSafety;
    let release;
    let started = false;
    const gate = new Promise(resolve => { release = resolve; });
    window.VaultDataSafety = Object.assign({}, originalSafety, {
      putState: async (...args) => {
        if (!started) { started = true; await gate; }
        return originalSafety.putState(...args);
      }
    });
    const resolving = CloudSync.resolvePendingConflict('cloud');
    while (!started) await new Promise(resolve => setTimeout(resolve, 0));
    db.settings.concurrentNote = 'newer edit';
    hasUnsavedChanges = true;
    const generation = ++CloudSync._mutationGeneration;
    const queued = CloudSync.queueCurrentSnapshot('concurrent-after-choice', CloudSync.accountContext(), generation);
    release();
    const resolved = await resolving;
    await queued.catch(() => null);
    const outbox = await CloudSync.storeGet('outbox', uid);
    window.VaultDataSafety = originalSafety;
    CloudSync.push = originalPush;
    return {
      resolved,
      firearm: outbox.data.firearms[0],
      note: outbox.data.settings.concurrentNote,
      conflicts: outbox.conflictPaths || null
    };
  });

  expect(result.resolved.ok).toBe(true);
  expect(result.firearm).toMatchObject({ make: 'Cloud choice', model: 'Device-only model' });
  expect(result.note).toBe('newer edit');
  expect(result.conflicts).toBeNull();
});

test('cross-tab Keep device follows the tab making the choice', async ({ page, context }) => {
  const uid = '24242424-2424-4424-8424-242424242424';
  const second = await context.newPage();
  await second.goto('/index.html');
  await expect(second.locator('#authForm')).toBeVisible({ timeout: 15000 });
  const sourceA = await page.evaluate(async uid => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    return CloudSync._sourceId;
  }, uid);
  const sourceB = await second.evaluate(async uid => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    return CloudSync._sourceId;
  }, uid);
  expect(sourceB).not.toBe(sourceA);

  const base = {
    version: 3, encrypted: false,
    firearms: [{ id: 'one', make: 'Original', model: 'Shared', images: [], documents: [] }],
    ammo: [], accessories: [], wishlist: [], dealers: [], backups: [], settings: {}, auditTrail: [], valueHistory: []
  };
  const local = structuredClone(base); local.firearms[0].make = 'Tab A choice';
  const remote = structuredClone(base); remote.firearms[0].make = 'Tab B choice';
  const install = async (target, id) => target.evaluate(async ({ uid, id, base, local, remote, sourceB }) => {
    await VaultDataSafety.clearState(uid);
    await CloudSync.storePut('outbox', {
      uid, id, data: local, mediaManifest: {}, baseData: base, baseMediaManifest: {}, baseRevision: 0,
      baseUpdatedAt: null, queuedAt: new Date().toISOString(), sourceId: sourceB, crossTabMerged: true,
      conflictAt: new Date().toISOString(), conflictPaths: ['firearms[one].make'], conflictSource: 'cross-tab',
      remoteRevision: 0, remoteUpdatedAt: null, conflictRemoteData: remote, conflictRemoteMediaManifest: {}
    });
  }, { uid, id, base, local, remote, sourceB });

  await install(page, 'choice-in-b');
  const inB = await second.evaluate(async ({ uid, remote }) => {
    db = structuredClone(remote); imagesDb = {}; hasUnsavedChanges = false; CloudSync.ready = true;
    const originalPush = CloudSync.push; CloudSync.push = async () => ({ ok: true, status: 'stub' });
    const result = await CloudSync.resolvePendingConflict('device');
    const outbox = await CloudSync.storeGet('outbox', uid);
    CloudSync.push = originalPush;
    return { result, make: outbox.data.firearms[0].make };
  }, { uid, remote });
  expect(inB.result.ok).toBe(true);
  expect(inB.make).toBe('Tab B choice');

  await install(page, 'choice-in-a');
  const inA = await page.evaluate(async ({ uid, local }) => {
    db = structuredClone(local); imagesDb = {}; hasUnsavedChanges = false; CloudSync.ready = true;
    const originalPush = CloudSync.push; CloudSync.push = async () => ({ ok: true, status: 'stub' });
    const result = await CloudSync.resolvePendingConflict('device');
    const outbox = await CloudSync.storeGet('outbox', uid);
    CloudSync.push = originalPush;
    return { result, make: outbox.data.firearms[0].make };
  }, { uid, local });
  expect(inA.result.ok).toBe(true);
  expect(inA.make).toBe('Tab A choice');
  await second.close();
});

test('the originating tab can update its unresolved alternative before choosing Keep device', async ({ page, context }) => {
  const uid = '25252525-2525-4525-8525-252525252525';
  const second = await context.newPage();
  await second.goto('/index.html');
  await expect(second.locator('#authForm')).toBeVisible({ timeout: 15000 });
  const base = {
    version: 3, encrypted: false,
    firearms: [{ id: 'one', make: 'Original', model: 'Shared', images: [], documents: [] }],
    ammo: [], accessories: [], wishlist: [], dealers: [], backups: [], settings: {}, auditTrail: [], valueHistory: []
  };
  await page.evaluate(async ({ uid, base }) => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    await VaultDataSafety.clearState(uid); await CloudSync.storeDelete('outbox', uid); await CloudSync.storeDelete('cache', uid);
    CloudSync._lastCommittedData = structuredClone(base);
    await CloudSync.storePut('cache', { uid, data: base, revision: 0, updatedAt: null, mediaManifest: {}, pending: false });
    db = structuredClone(base); db.firearms[0].make = 'Tab A'; imagesDb = {}; hasUnsavedChanges = true;
    const generation = ++CloudSync._mutationGeneration;
    await CloudSync.queueCurrentSnapshot('tab-a-conflict', CloudSync.accountContext(), generation);
  }, { uid, base });
  const result = await second.evaluate(async ({ uid, base }) => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    CloudSync._lastCommittedData = structuredClone(base);
    db = structuredClone(base); db.firearms[0].make = 'Tab B1'; imagesDb = {}; hasUnsavedChanges = true;
    let generation = ++CloudSync._mutationGeneration;
    await CloudSync.queueCurrentSnapshot('tab-b-conflict-1', CloudSync.accountContext(), generation);
    db.firearms[0].make = 'Tab B2'; hasUnsavedChanges = true;
    generation = ++CloudSync._mutationGeneration;
    await CloudSync.queueCurrentSnapshot('tab-b-conflict-2', CloudSync.accountContext(), generation);
    const before = await CloudSync.storeGet('outbox', uid);
    CloudSync.ready = true;
    const originalPush = CloudSync.push; CloudSync.push = async () => ({ ok: true, status: 'stub' });
    const resolved = await CloudSync.resolvePendingConflict('device');
    const after = await CloudSync.storeGet('outbox', uid);
    CloudSync.push = originalPush;
    return {
      resolved,
      beforeDevice: before.data.firearms[0].make,
      beforeAlternative: before.conflictRemoteData.firearms[0].make,
      provenance: before.conflictRemoteSourceId,
      source: CloudSync._sourceId,
      after: after.data.firearms[0].make
    };
  }, { uid, base });
  expect(result.beforeDevice).toBe('Tab A');
  expect(result.beforeAlternative).toBe('Tab B2');
  expect(result.provenance).toBe(result.source);
  expect(result.resolved.ok).toBe(true);
  expect(result.after).toBe('Tab B2');
  await second.close();
});

test('the first tab can revise its unresolved alternative without a false local-safe result', async ({ page, context }) => {
  const uid = '26262626-2626-4626-8626-262626262626';
  const second = await context.newPage();
  await second.goto('/index.html');
  await expect(second.locator('#authForm')).toBeVisible({ timeout: 15000 });
  const base = {
    version: 3, encrypted: false,
    firearms: [{ id: 'one', make: 'Original', model: 'Shared', images: [], documents: [] }],
    ammo: [], accessories: [], wishlist: [], dealers: [], backups: [], settings: {}, auditTrail: [], valueHistory: []
  };
  const sourceA = await page.evaluate(async ({ uid, base }) => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    await VaultDataSafety.clearState(uid); await CloudSync.storeDelete('outbox', uid); await CloudSync.storeDelete('cache', uid);
    CloudSync._lastCommittedData = structuredClone(base);
    await CloudSync.storePut('cache', { uid, data: base, revision: 0, updatedAt: null, mediaManifest: {}, pending: false });
    db = structuredClone(base); db.firearms[0].make = 'Tab A1'; imagesDb = {}; hasUnsavedChanges = true;
    await CloudSync.queueCurrentSnapshot('tab-a-conflict-1', CloudSync.accountContext(), ++CloudSync._mutationGeneration);
    return CloudSync._sourceId;
  }, { uid, base });
  const sourceB = await second.evaluate(async ({ uid, base }) => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    CloudSync._lastCommittedData = structuredClone(base);
    db = structuredClone(base); db.firearms[0].make = 'Tab B1'; imagesDb = {}; hasUnsavedChanges = true;
    await CloudSync.queueCurrentSnapshot('tab-b-conflict-1', CloudSync.accountContext(), ++CloudSync._mutationGeneration);
    return CloudSync._sourceId;
  }, { uid, base });

  const result = await page.evaluate(async ({ uid }) => {
    db.firearms[0].make = 'Tab A2'; hasUnsavedChanges = true;
    const queued = await CloudSync.queueCurrentSnapshot('tab-a-conflict-2', CloudSync.accountContext(), ++CloudSync._mutationGeneration);
    const before = await CloudSync.storeGet('outbox', uid);
    CloudSync.ready = true;
    const originalPush = CloudSync.push; CloudSync.push = async () => ({ ok: true, status: 'stub' });
    const resolved = await CloudSync.resolvePendingConflict('device');
    const after = await CloudSync.storeGet('outbox', uid);
    CloudSync.push = originalPush;
    return {
      queued,
      dirty: hasUnsavedChanges,
      beforeDevice: before.data.firearms[0].make,
      beforeAlternative: before.conflictRemoteData.firearms[0].make,
      exact: before.conflictSourceSnapshots[CloudSync._sourceId].data.firearms[0].make,
      localSource: before.conflictLocalSourceId,
      remoteSource: before.conflictRemoteSourceId,
      resolved,
      after: after.data.firearms[0].make
    };
  }, { uid });
  expect(result.queued).toMatchObject({ ok: true, status: 'local-safe' });
  expect(result.dirty).toBe(false);
  expect(result.beforeDevice).toBe('Tab A2');
  expect(result.beforeAlternative).toBe('Tab B1');
  expect(result.exact).toBe('Tab A2');
  expect(result.localSource).toBe(sourceA);
  expect(result.remoteSource).toBe(sourceB);
  expect(result.resolved.ok).toBe(true);
  expect(result.after).toBe('Tab A2');
  await second.close();
});

test('a third tab keeps an exact durable conflict alternative for Keep device', async ({ page, context }) => {
  const uid = '27272727-2727-4727-8727-272727272727';
  const second = await context.newPage();
  const third = await context.newPage();
  await Promise.all([second.goto('/index.html'), third.goto('/index.html')]);
  await Promise.all([
    expect(second.locator('#authForm')).toBeVisible({ timeout: 15000 }),
    expect(third.locator('#authForm')).toBeVisible({ timeout: 15000 })
  ]);
  const base = {
    version: 3, encrypted: false,
    firearms: [{ id: 'one', make: 'Original', model: 'Shared', images: [], documents: [] }],
    ammo: [], accessories: [], wishlist: [], dealers: [], backups: [],
    settings: { tabA: '', tabB: '' }, auditTrail: [], valueHistory: []
  };
  await page.evaluate(async ({ uid, base }) => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    await VaultDataSafety.clearState(uid); await CloudSync.storeDelete('outbox', uid); await CloudSync.storeDelete('cache', uid);
    CloudSync._lastCommittedData = structuredClone(base);
    await CloudSync.storePut('cache', { uid, data: base, revision: 0, updatedAt: null, mediaManifest: {}, pending: false });
    db = structuredClone(base); db.firearms[0].make = 'Tab A1'; db.settings.tabA = 'A-only'; imagesDb = {}; hasUnsavedChanges = true;
    await CloudSync.queueCurrentSnapshot('tab-a', CloudSync.accountContext(), ++CloudSync._mutationGeneration);
  }, { uid, base });
  await second.evaluate(async ({ uid, base }) => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    CloudSync._lastCommittedData = structuredClone(base);
    db = structuredClone(base); db.firearms[0].make = 'Tab B1'; db.settings.tabB = 'B-only'; imagesDb = {}; hasUnsavedChanges = true;
    await CloudSync.queueCurrentSnapshot('tab-b', CloudSync.accountContext(), ++CloudSync._mutationGeneration);
  }, { uid, base });
  const result = await third.evaluate(async ({ uid, base }) => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    CloudSync._lastCommittedData = structuredClone(base);
    db = structuredClone(base); db.firearms[0].make = 'Tab C1'; db.settings.tabA = 'A-only'; imagesDb = {}; hasUnsavedChanges = true;
    const queued = await CloudSync.queueCurrentSnapshot('tab-c', CloudSync.accountContext(), ++CloudSync._mutationGeneration);
    const before = await CloudSync.storeGet('outbox', uid);
    const exact = before.conflictSourceSnapshots[CloudSync._sourceId];
    CloudSync.ready = true;
    const originalPush = CloudSync.push; CloudSync.push = async () => ({ ok: true, status: 'stub' });
    const resolved = await CloudSync.resolvePendingConflict('device');
    const after = await CloudSync.storeGet('outbox', uid);
    CloudSync.push = originalPush;
    return {
      queued,
      dirty: hasUnsavedChanges,
      exactMake: exact.data.firearms[0].make,
      resolved,
      make: after.data.firearms[0].make,
      tabA: after.data.settings.tabA,
      tabB: after.data.settings.tabB
    };
  }, { uid, base });
  expect(result.queued).toMatchObject({ ok: true, status: 'local-safe' });
  expect(result.dirty).toBe(false);
  expect(result.exactMake).toBe('Tab C1');
  expect(result.resolved.ok).toBe(true);
  expect(result.make).toBe('Tab C1');
  expect(result.tabA).toBe('A-only');
  expect(result.tabB).toBe('B-only');
  await Promise.all([second.close(), third.close()]);
});

test('a conflict alternative survives when only the secondary safety state can accept it', async ({ page, context }) => {
  const uid = '28282828-2828-4828-8828-282828282828';
  const second = await context.newPage();
  await second.goto('/index.html');
  await expect(second.locator('#authForm')).toBeVisible({ timeout: 15000 });
  const base = {
    version: 3, encrypted: false,
    firearms: [{ id: 'one', make: 'Original', model: 'Shared', images: [], documents: [] }],
    ammo: [], accessories: [], wishlist: [], dealers: [], backups: [], settings: {}, auditTrail: [], valueHistory: []
  };
  await page.evaluate(async ({ uid, base }) => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    await VaultDataSafety.clearState(uid); await CloudSync.storeDelete('outbox', uid); await CloudSync.storeDelete('cache', uid);
    CloudSync._lastCommittedData = structuredClone(base);
    await CloudSync.storePut('cache', { uid, data: base, revision: 0, updatedAt: null, mediaManifest: {}, pending: false });
    db = structuredClone(base); db.firearms[0].make = 'Tab A1'; imagesDb = {}; hasUnsavedChanges = true;
    await CloudSync.queueCurrentSnapshot('tab-a', CloudSync.accountContext(), ++CloudSync._mutationGeneration);
  }, { uid, base });
  const result = await second.evaluate(async ({ uid, base }) => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    CloudSync._lastCommittedData = structuredClone(base);
    db = structuredClone(base); db.firearms[0].make = 'Tab B1'; imagesDb = {}; hasUnsavedChanges = true;
    await CloudSync.queueCurrentSnapshot('tab-b-1', CloudSync.accountContext(), ++CloudSync._mutationGeneration);

    db.firearms[0].make = 'Tab B2'; hasUnsavedChanges = true;
    const originalPut = CloudSync.storePut;
    CloudSync.storePut = async function(storeName, value) {
      if (storeName === 'outbox') throw new Error('simulated primary outbox failure');
      return originalPut.call(this, storeName, value);
    };
    let queued;
    try {
      queued = await CloudSync.queueCurrentSnapshot('tab-b-2-secondary-only', CloudSync.accountContext(), ++CloudSync._mutationGeneration);
    } finally {
      CloudSync.storePut = originalPut;
    }
    const stalePrimary = await CloudSync.storeGet('outbox', uid);
    const recovered = await CloudSync.ensurePrimaryPendingOutbox(CloudSync.accountContext());
    const promoted = await CloudSync.storeGet('outbox', uid);
    CloudSync.ready = true;
    const originalPush = CloudSync.push; CloudSync.push = async () => ({ ok: true, status: 'stub' });
    const resolved = await CloudSync.resolvePendingConflict('device');
    const after = await CloudSync.storeGet('outbox', uid);
    CloudSync.push = originalPush;
    return {
      queued,
      staleAlternative: stalePrimary.conflictRemoteData.firearms[0].make,
      recovered: recovered.ok,
      promotedAlternative: promoted.conflictRemoteData.firearms[0].make,
      promotedExact: promoted.conflictSourceSnapshots[CloudSync._sourceId].data.firearms[0].make,
      resolved,
      after: after.data.firearms[0].make
    };
  }, { uid, base });
  expect(result.queued).toMatchObject({ ok: false, status: 'local-safe-only', localSafe: true });
  expect(result.staleAlternative).toBe('Tab B1');
  expect(result.recovered).toBe(true);
  expect(result.promotedAlternative).toBe('Tab B2');
  expect(result.promotedExact).toBe('Tab B2');
  expect(result.resolved.ok).toBe(true);
  expect(result.after).toBe('Tab B2');
  await second.close();
});
