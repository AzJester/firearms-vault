import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#authForm')).toBeVisible({ timeout: 15000 });
});

test('late account-A media hydration cannot apply or cache bytes under account B', async ({ page }) => {
  await page.evaluate(async () => {
    const userA = 'a1000000-0000-4000-8000-000000000001';
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(userA);
    db = {
      version: 3, encrypted: false,
      firearms: [{ id: 'gun-a', make: 'A', model: 'A', images: ['shared-photo'], documents: [] }],
      ammo: [], accessories: [], wishlist: [], dealers: [], settings: {}, auditTrail: [], valueHistory: []
    };
    imagesDb = {};
    const cloudBytes = 'data:text/plain;base64,YWNjb3VudC1h';
    const metadata = await CloudSync.mediaMetadata(cloudBytes);
    window.__lateDownloadStarted = false;
    window.__lateDownload = new Promise(resolve => {
      window.__finishLateDownload = () => resolve({
        data: new Blob(['account-a'], { type: 'text/plain' }), error: null
      });
    });
    window.sbClient = {
      storage: { from: () => ({ download: () => { window.__lateDownloadStarted = true; return window.__lateDownload; } }) }
    };
    const context = CloudSync.accountContext();
    window.__lateHydration = CloudSync.downloadMedia({
      'shared-photo': { ...metadata, path: userA + '/shared-photo--' + metadata.sha256.slice(0, 32) }
    }, { context, keys: ['shared-photo'] });
  });
  await expect.poll(() => page.evaluate(() => window.__lateDownloadStarted)).toBe(true);

  const result = await page.evaluate(async () => {
    const userB = 'b1000000-0000-4000-8000-000000000002';
    const activated = await CloudSync.activateUser(userB);
    db = { version: 3, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [], settings: {}, auditTrail: [], valueHistory: [] };
    window.__finishLateDownload();
    const hydration = await window.__lateHydration;
    const scoped = await CloudSync.getScopedMedia(userB, 'shared-photo');
    const runtime = await idbGet('shared-photo');
    const outbox = await CloudSync.storeGet('outbox', userB);
    const cache = await CloudSync.storeGet('cache', userB);
    return {
      activated, hydration,
      memory: imagesDb['shared-photo'] || null,
      scoped: scoped && scoped.dataURL,
      runtime: runtime || null,
      outbox: outbox && outbox.data,
      cache: cache && cache.data
    };
  });

  expect(result.activated.ok).toBe(true);
  expect(result.hydration).toMatchObject({ status: 'account-changed', cancelled: true });
  expect(result).toMatchObject({ memory: null, scoped: null, runtime: null, outbox: null, cache: null });
});

test('an in-flight account-A upload cannot commit or mutate account B', async ({ page }) => {
  await page.evaluate(async () => {
    const userA = 'a1100000-0000-4000-8000-000000000011';
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(userA);
    CloudSync.ready = true;
    CloudSync._casRpcSupported = true;
    db = {
      version: 3, firearms: [{ id: 'gun-a', make: 'Private A', images: ['photo-a'], documents: [] }],
      ammo: [], accessories: [], wishlist: [], dealers: [], settings: {}, auditTrail: [], valueHistory: []
    };
    imagesDb = { 'photo-a': 'data:text/plain;base64,YWNjb3VudC1hLXB1c2g=' };
    const context = CloudSync.accountContext();
    const generation = ++CloudSync._mutationGeneration;
    await CloudSync.queueCurrentSnapshot('account-a', context, generation);
    window.__uploadCalls = [];
    window.__rpcCalls = [];
    window.__uploadGate = new Promise(resolve => {
      window.__finishUpload = () => resolve({ data: { path: 'a' }, error: null });
    });
    window.sbClient = {
      storage: { from: () => ({
        upload(path) { window.__uploadCalls.push(path); return window.__uploadGate; },
        async remove() { return { data: [], error: null }; }
      }) },
      async rpc(name, args) {
        window.__rpcCalls.push({ name, args });
        return { data: { status: 'saved', revision: 1, data: args.p_new_data, media_manifest: args.p_new_media_manifest }, error: null };
      }
    };
    window.__oldPush = CloudSync.push({
      capture: false, reason: 'race-test', queuePromise: Promise.resolve({ ok: true })
    }, context);
  });
  await expect.poll(() => page.evaluate(() => window.__uploadCalls.length)).toBe(1);

  const result = await page.evaluate(async () => {
    const userB = 'b1100000-0000-4000-8000-000000000012';
    const activated = await CloudSync.activateUser(userB);
    db = { version: 3, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [], settings: {}, auditTrail: [], valueHistory: [] };
    window.__finishUpload();
    const pushed = await window.__oldPush;
    return {
      activated, pushed, rpcCalls: window.__rpcCalls.length,
      bOutbox: await CloudSync.storeGet('outbox', userB),
      bCache: await CloudSync.storeGet('cache', userB),
      bMedia: await CloudSync.getUserMedia(userB),
      runtimeState: (await stateGet('db')) || null,
      runtimePhoto: (await idbGet('photo-a')) || null
    };
  });

  expect(result.activated.ok).toBe(true);
  expect(result.pushed).toMatchObject({ status: 'account-changed', cancelled: true });
  expect(result.rpcCalls).toBe(0);
  expect(result.bOutbox).toBeNull();
  expect(result.bCache).toBeNull();
  expect(result.bMedia).toEqual([]);
  expect(result.runtimeState).toBeNull();
  expect(result.runtimePhoto).toBeNull();
});

test('account switching cancels a snapshot paused in media hashing', async ({ page }) => {
  await page.evaluate(async () => {
    const userA = 'a1200000-0000-4000-8000-000000000021';
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(userA);
    CloudSync.ready = true;
    db = {
      version: 3, firearms: [{ id: 'gun-a', make: 'Hashing A', images: ['hash-photo'], documents: [] }],
      ammo: [], accessories: [], wishlist: [], dealers: [], settings: {}, auditTrail: [], valueHistory: []
    };
    imagesDb = { 'hash-photo': 'data:text/plain;base64,aGFzaGluZy1h' };
    const original = CloudSync.mediaMetadata.bind(CloudSync);
    window.__hashStarted = false;
    window.__hashGate = new Promise(resolve => { window.__finishHash = resolve; });
    CloudSync.mediaMetadata = async value => {
      window.__hashStarted = true;
      await window.__hashGate;
      return original(value);
    };
    const context = CloudSync.accountContext();
    const generation = ++CloudSync._mutationGeneration;
    window.__hashQueue = CloudSync.queueCurrentSnapshot('hash-race', context, generation);
  });
  await expect.poll(() => page.evaluate(() => window.__hashStarted)).toBe(true);

  const result = await page.evaluate(async () => {
    const userB = 'b1200000-0000-4000-8000-000000000022';
    const activated = await CloudSync.activateUser(userB);
    window.__finishHash();
    const queued = await window.__hashQueue;
    return {
      activated, queued,
      bOutbox: await CloudSync.storeGet('outbox', userB),
      bCache: await CloudSync.storeGet('cache', userB),
      bMedia: await CloudSync.getUserMedia(userB),
      memoryPhoto: imagesDb['hash-photo'] || null,
      runtimePhoto: (await idbGet('hash-photo')) || null
    };
  });

  expect(result.activated.ok).toBe(true);
  expect(result.queued).toMatchObject({ status: 'account-changed', cancelled: true });
  expect(result.bOutbox).toBeNull();
  expect(result.bCache).toBeNull();
  expect(result.bMedia).toEqual([]);
  expect(result.memoryPhoto).toBeNull();
  expect(result.runtimePhoto).toBeNull();
});

test('stable-key H1 to H2 replacement verifies cached bytes and downloads H2', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const uid = 'c2000000-0000-4000-8000-000000000003';
    await CloudSync.activateUser(uid);
    const h1Data = 'data:text/plain;base64,b2xkLWJ5dGVz';
    const h2Data = 'data:text/plain;base64,bmV3LWJ5dGVz';
    const h1 = await CloudSync.mediaMetadata(h1Data);
    const h2 = await CloudSync.mediaMetadata(h2Data);
    db = {
      version: 3, firearms: [{ id: 'gun', images: ['stable-photo'], documents: [] }],
      ammo: [], accessories: [], wishlist: [], dealers: [], settings: {}, auditTrail: [], valueHistory: []
    };
    imagesDb = { 'stable-photo': h1Data };
    // Deliberately corrupt the label to reproduce the historical H1-as-H2 bug.
    await CloudSync.putScopedMedia(uid, 'stable-photo', h1Data, { ...h2, path: uid + '/h2' });
    let downloads = 0;
    window.sbClient = {
      storage: { from: () => ({
        async download() { downloads++; return { data: new Blob(['new-bytes'], { type: 'text/plain' }), error: null }; }
      }) }
    };
    const hydrated = await CloudSync.downloadMedia({ 'stable-photo': { ...h2, path: uid + '/h2' } }, {
      context: CloudSync.accountContext(), keys: ['stable-photo']
    });
    const cached = await CloudSync.getScopedMedia(uid, 'stable-photo');
    return {
      hydrated, downloads, h1: h1.sha256, h2: h2.sha256,
      memoryHash: (await CloudSync.mediaMetadata(imagesDb['stable-photo'])).sha256,
      cachedHash: cached.sha256,
      cachedActual: (await CloudSync.mediaMetadata(cached.dataURL)).sha256
    };
  });

  expect(result.downloads).toBe(1);
  expect(result.hydrated.ok).toBe(true);
  expect(result.h1).not.toBe(result.h2);
  expect(result.memoryHash).toBe(result.h2);
  expect(result.cachedHash).toBe(result.h2);
  expect(result.cachedActual).toBe(result.h2);
});

test('a slower same-account pull cannot overwrite a newer cloud revision', async ({ page }) => {
  await page.evaluate(async () => {
    const uid = 'c2100000-0000-4000-8000-000000000013';
    await openStateDB();
    await CloudSync.activateUser(uid);
    window.__readCount = 0;
    window.__oldRead = new Promise(resolve => { window.__finishOldRead = resolve; });
    const row = (revision, make) => ({
      data: { version: 3, firearms: [{ id: 'gun', make, images: [], documents: [] }], ammo: [], accessories: [], wishlist: [], dealers: [], settings: {}, auditTrail: [], valueHistory: [] },
      revision, updated_at: `2026-07-20T00:00:0${revision}.000Z`, media_manifest: {}
    });
    window.__newRow = row(2, 'New cloud value');
    window.__oldRow = row(1, 'Old cloud value');
    window.sbClient = {
      from() {
        return {
          select() { return this; }, eq() { return this; },
          maybeSingle() {
            window.__readCount += 1;
            return window.__readCount === 1 ? window.__oldRead : Promise.resolve({ data: window.__newRow, error: null });
          }
        };
      },
      storage: { from: () => ({ async download() { return { data: null, error: new Error('unexpected') }; } }) }
    };
    window.__slowPull = CloudSync.pull({ awaitMedia: true });
  });
  await expect.poll(() => page.evaluate(() => window.__readCount)).toBe(1);

  const result = await page.evaluate(async () => {
    const fast = await CloudSync.pull({ awaitMedia: true });
    window.__finishOldRead({ data: window.__oldRow, error: null });
    const slow = await window.__slowPull;
    const cache = await CloudSync.storeGet('cache', CloudSync.uid);
    return { fast, slow, revision: CloudSync.revision, make: db.firearms[0].make, cachedMake: cache.data.firearms[0].make };
  });

  expect(result.fast.ok).toBe(true);
  expect(result.slow).toMatchObject({ status: 'account-changed', cancelled: true });
  expect(result.revision).toBe(2);
  expect(result.make).toBe('New cloud value');
  expect(result.cachedMake).toBe('New cloud value');
});

test('a local stable-key replacement wins over a late same-account download', async ({ page }) => {
  await page.evaluate(async () => {
    const uid = 'd3000000-0000-4000-8000-000000000004';
    await CloudSync.activateUser(uid);
    db = {
      version: 3, firearms: [{ id: 'gun', images: ['photo'], documents: [] }],
      ammo: [], accessories: [], wishlist: [], dealers: [], settings: {}, auditTrail: [], valueHistory: []
    };
    imagesDb = {};
    const cloud = 'data:text/plain;base64,Y2xvdWQtdmVyc2lvbg==';
    window.__cloudMeta = await CloudSync.mediaMetadata(cloud);
    window.__hydrationGate = new Promise(resolve => {
      window.__finishHydration = () => resolve({ data: new Blob(['cloud-version'], { type: 'text/plain' }), error: null });
    });
    window.sbClient = { storage: { from: () => ({ download: () => window.__hydrationGate }) } };
    window.__sameAccountHydration = CloudSync.downloadMedia({ photo: { ...window.__cloudMeta, path: uid + '/photo' } }, {
      context: CloudSync.accountContext(), keys: ['photo']
    });
  });

  const result = await page.evaluate(async () => {
    const local = 'data:text/plain;base64,bG9jYWwtcmVwbGFjZW1lbnQ=';
    imagesDb.photo = local;
    hasUnsavedChanges = true;
    CloudSync._mutationGeneration += 1;
    window.__finishHydration();
    const hydrated = await window.__sameAccountHydration;
    const cached = await CloudSync.getScopedMedia(CloudSync.uid, 'photo');
    return {
      hydrated,
      memoryHash: (await CloudSync.mediaMetadata(imagesDb.photo)).sha256,
      localHash: (await CloudSync.mediaMetadata(local)).sha256,
      cloudHash: window.__cloudMeta.sha256,
      cached: cached && cached.dataURL
    };
  });

  expect(result.memoryHash).toBe(result.localHash);
  expect(result.memoryHash).not.toBe(result.cloudHash);
  expect(result.hydrated.skipped).toContain('photo');
  expect(result.cached).toBeNull();
});

test('deleted and discarded firearm images are excluded from snapshots and recovery state', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const uid = 'e4000000-0000-4000-8000-000000000005';
    await CloudSync.activateUser(uid);
    CloudSync.ready = true;
    CloudSync.serverMediaManifest = {};
    db = {
      version: 3, firearms: [{ id: 'gun', images: [], documents: [] }],
      ammo: [], accessories: [], wishlist: [], dealers: [], settings: {}, auditTrail: [], valueHistory: []
    };
    imagesDb = { orphan: 'data:text/plain;base64,b3JwaGFu' };
    CloudSync.missingMedia = [{ key: 'orphan', label: 'Deleted photo' }];
    const generation = ++CloudSync._mutationGeneration;
    const queued = await CloudSync.queueCurrentSnapshot('delete-test', CloudSync.accountContext(), generation);
    const outbox = await CloudSync.storeGet('outbox', uid);
    return {
      queued, collected: Object.keys(CloudSync.collectMedia()),
      manifest: Object.keys(outbox.mediaManifest), missing: CloudSync.missingMedia.length
    };
  });

  expect(result.queued.ok).toBe(true);
  expect(result.collected).toEqual([]);
  expect(result.manifest).toEqual([]);
  expect(result.missing).toBe(0);
});

test('primitive arrays honor three-way deletions and media refs cannot outlive the manifest', async ({ page }) => {
  const result = await page.evaluate(() => {
    const base = { settings: { tags: ['keep', 'delete'] }, firearms: [{ id: 'gun', images: ['keep-photo', 'delete-photo'] }] };
    const local = structuredClone(base);
    local.settings.tags = ['keep'];
    local.firearms[0].images = ['keep-photo'];
    const remote = structuredClone(base);
    remote.settings.tags = ['keep', 'delete', 'remote-add'];
    remote.firearms[0].images = ['keep-photo', 'delete-photo', 'remote-photo'];
    const merged = CloudSync.mergeStructured(base, local, remote).merged;
    const reconciled = CloudSync.reconcileStructuredManifest({
      firearms: [{
        id: 'gun', images: ['keep-photo', 'ghost-photo'],
        receipt: '@media:receipt:firearm:gun', stampPdf: '@media:stamp:firearm:gun',
        documents: [{ id: 'kept-doc' }, { id: 'ghost-doc' }]
      }], ammo: [], accessories: []
    }, {
      'keep-photo': { sha256: 'a' },
      'receipt:firearm:gun': { sha256: 'b' },
      'doc:gun:kept-doc': { sha256: 'c' }
    });
    return { merged, reconciled: reconciled.firearms[0] };
  });

  expect(result.merged.settings.tags).toEqual(['keep', 'remote-add']);
  expect(result.merged.firearms[0].images).toEqual(['keep-photo', 'remote-photo']);
  expect(result.reconciled.images).toEqual(['keep-photo']);
  expect(result.reconciled.receipt).toBe('@media:receipt:firearm:gun');
  expect(result.reconciled.stampPdf).toBeNull();
  expect(result.reconciled.documents).toEqual([{ id: 'kept-doc' }]);
});

test('serialized snapshot writes cannot let an older generation replace newer durable state', async ({ page }) => {
  await page.evaluate(async () => {
    const uid = 'f5000000-0000-4000-8000-000000000006';
    await CloudSync.activateUser(uid);
    CloudSync.ready = true;
    db = {
      version: 3, firearms: [{ id: 'gun', make: 'Before', images: ['photo'], documents: [] }],
      ammo: [], accessories: [], wishlist: [], dealers: [], settings: {}, auditTrail: [], valueHistory: []
    };
    imagesDb = { photo: 'data:text/plain;base64,b2xk' };
    const original = CloudSync.mediaMetadata.bind(CloudSync);
    window.__metadataStarted = false;
    window.__metadataGate = new Promise(resolve => { window.__releaseMetadata = resolve; });
    let first = true;
    CloudSync.mediaMetadata = async value => {
      if (first) {
        first = false;
        window.__metadataStarted = true;
        await window.__metadataGate;
      }
      return original(value);
    };
    CloudSync._mutationGeneration = 1;
    hasUnsavedChanges = true;
    window.__oldQueue = CloudSync.queueCurrentSnapshot('old-edit', CloudSync.accountContext(), 1);
  });
  await expect.poll(() => page.evaluate(() => window.__metadataStarted)).toBe(true);

  const result = await page.evaluate(async () => {
    db.firearms[0].make = 'Newer edit';
    imagesDb.photo = 'data:text/plain;base64,bmV3ZXI=';
    CloudSync._mutationGeneration = 2;
    hasUnsavedChanges = true;
    const newerQueue = CloudSync.queueCurrentSnapshot('newer-edit', CloudSync.accountContext(), 2);
    window.__releaseMetadata();
    const oldQueued = await window.__oldQueue;
    const newQueued = await newerQueue;
    const outbox = await CloudSync.storeGet('outbox', CloudSync.uid);
    const safetyState = await VaultDataSafety.getState(CloudSync.uid);
    const safetyOutbox = await VaultDataSafety.listOutbox(CloudSync.uid);
    return {
      oldQueued, newQueued, dirty: hasUnsavedChanges,
      queuedMake: outbox.data.firearms[0].make,
      safetyMake: safetyState.data.firearms[0].make,
      latestSafetyMake: safetyOutbox.at(-1).payload.firearms[0].make,
      memoryMake: db.firearms[0].make
    };
  });

  expect(result.oldQueued).toMatchObject({ ok: false, status: 'superseded', cancelled: true });
  expect(result.newQueued.ok).toBe(true);
  expect(result.dirty).toBe(false);
  expect(result.queuedMake).toBe('Newer edit');
  expect(result.safetyMake).toBe('Newer edit');
  expect(result.latestSafetyMake).toBe('Newer edit');
  expect(result.memoryMake).toBe('Newer edit');
});

test('a cloud pull waits for an in-flight local snapshot before applying or caching cloud data', async ({ page }) => {
  await page.evaluate(async () => {
    const uid = 'f5100000-0000-4000-8000-000000000016';
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uid);
    CloudSync.ready = true;
    CloudSync.revision = 0;
    CloudSync.serverUpdatedAt = null;
    CloudSync.serverMediaManifest = {};
    CloudSync._lastCommittedData = null;
    CloudSync._casRpcSupported = true;
    db = {
      version: 3, firearms: [{ id: 'race-gun', make: 'Before', images: [], documents: [] }],
      ammo: [], accessories: [], wishlist: [], dealers: [], settings: {}, auditTrail: [], valueHistory: []
    };
    imagesDb = {};

    window.__cloudReadStarted = false;
    window.__cloudReadGate = new Promise(resolve => { window.__finishCloudRead = resolve; });
    window.__snapshotPrepareStarted = false;
    window.__snapshotPrepareGate = new Promise(resolve => { window.__finishSnapshotPrepare = resolve; });
    const originalPrepare = CloudSync.prepareSnapshot.bind(CloudSync);
    let blockFirstPrepare = true;
    CloudSync.prepareSnapshot = async (...args) => {
      const snapshot = await originalPrepare(...args);
      if (blockFirstPrepare) {
        blockFirstPrepare = false;
        window.__snapshotPrepareStarted = true;
        await window.__snapshotPrepareGate;
      }
      return snapshot;
    };

    window.__rpcWrites = [];
    window.sbClient = {
      from() {
        return {
          select() { return this; }, eq() { return this; },
          maybeSingle() {
            window.__cloudReadStarted = true;
            return window.__cloudReadGate;
          }
        };
      },
      storage: { from: () => ({
        async upload() { return { data: {}, error: null }; },
        async download() { return { data: null, error: new Error('unexpected download') }; },
        async remove() { return { data: [], error: null }; }
      }) },
      async rpc(name, args) {
        window.__rpcWrites.push(args.p_new_data.firearms[0].make);
        return { data: {
          status: 'saved', revision: 2, updated_at: '2026-07-20T00:00:02.000Z',
          data: args.p_new_data, media_manifest: args.p_new_media_manifest
        }, error: null };
      }
    };
    window.__racingPull = CloudSync.pull({ awaitMedia: true });
  });
  await expect.poll(() => page.evaluate(() => window.__cloudReadStarted)).toBe(true);

  await page.evaluate(() => {
    db.firearms[0].make = 'Local edit';
    hasUnsavedChanges = true;
    const scheduled = CloudSync.schedulePush();
    window.__racingLocalQueue = scheduled.persisted;
  });
  await expect.poll(() => page.evaluate(() => window.__snapshotPrepareStarted)).toBe(true);

  await page.evaluate(() => {
    window.__finishCloudRead({
      data: {
        data: {
          version: 3, firearms: [{ id: 'race-gun', make: 'Cloud edit', images: [], documents: [] }],
          ammo: [], accessories: [], wishlist: [], dealers: [], settings: {}, auditTrail: [], valueHistory: []
        },
        revision: 1,
        updated_at: '2026-07-20T00:00:01.000Z',
        media_manifest: {}
      },
      error: null
    });
  });
  await page.waitForTimeout(50);

  const result = await page.evaluate(async () => {
    window.__finishSnapshotPrepare();
    const queued = await window.__racingLocalQueue;
    const pulled = await window.__racingPull;
    clearTimeout(CloudSync.pushTimer);
    const outbox = await CloudSync.storeGet('outbox', CloudSync.uid);
    const cache = await CloudSync.storeGet('cache', CloudSync.uid);
    return {
      queued, pulled, outbox,
      memoryMake: db.firearms[0].make,
      cachedMake: cache.data.firearms[0].make,
      rpcWrites: window.__rpcWrites
    };
  });

  expect(result.queued.ok).toBe(true);
  expect(result.pulled.ok).toBe(true);
  expect(result.outbox).toBeNull();
  expect(result.memoryMake).toBe('Local edit');
  expect(result.cachedMake).toBe('Local edit');
  expect(result.rpcWrites).toEqual(['Local edit']);
});

test('an older cloud commit never reports a newer queued edit as fully saved', async ({ page }) => {
  await page.evaluate(async () => {
    const uid = 'f5200000-0000-4000-8000-000000000026';
    await CloudSync.activateUser(uid);
    CloudSync.ready = true;
    CloudSync._casRpcSupported = true;
    db = {
      version: 3, firearms: [{ id: 'status-gun', make: 'First edit', images: [], documents: [] }],
      ammo: [], accessories: [], wishlist: [], dealers: [], settings: {}, auditTrail: [], valueHistory: []
    };
    imagesDb = {};
    hasUnsavedChanges = true;
    const generation = ++CloudSync._mutationGeneration;
    await CloudSync.queueCurrentSnapshot('first-edit', CloudSync.accountContext(), generation);

    window.__commitStarted = false;
    window.__commitGate = new Promise(resolve => { window.__finishCommit = resolve; });
    window.sbClient = {
      storage: { from: () => ({
        async upload() { return { data: {}, error: null }; },
        async remove() { return { data: [], error: null }; }
      }) },
      rpc() {
        window.__commitStarted = true;
        return window.__commitGate;
      }
    };
    window.__olderPush = CloudSync.push({
      capture: false, reason: 'status-race', queuePromise: Promise.resolve({ ok: true })
    }, CloudSync.accountContext());
  });
  await expect.poll(() => page.evaluate(() => window.__commitStarted)).toBe(true);

  const result = await page.evaluate(async () => {
    db.firearms[0].make = 'Newer edit';
    hasUnsavedChanges = true;
    const scheduled = CloudSync.schedulePush();
    const queued = await scheduled.persisted;
    clearTimeout(CloudSync.pushTimer);
    window.__finishCommit({
      data: {
        status: 'saved', revision: 1, updated_at: '2026-07-20T00:00:03.000Z',
        data: {
          version: 3, firearms: [{ id: 'status-gun', make: 'First edit', images: [], documents: [] }],
          ammo: [], accessories: [], wishlist: [], dealers: [], settings: {}, auditTrail: [], valueHistory: []
        },
        media_manifest: {}
      },
      error: null
    });
    const pushed = await window.__olderPush;
    const outbox = await CloudSync.storeGet('outbox', CloudSync.uid);
    const status = document.getElementById('syncStatus');
    return {
      queued, pushed,
      queuedMake: outbox && outbox.data.firearms[0].make,
      statusText: status && status.textContent,
      statusKind: status && status.dataset.kind,
      saveState: status && status.dataset.saveState,
      lastState: CloudSync.lastResult && CloudSync.lastResult.state,
      dirty: hasUnsavedChanges
    };
  });

  expect(result.queued.ok).toBe(true);
  expect(result.pushed).toMatchObject({ ok: true, status: 'pending-newer-changes', pendingNewerChanges: true });
  expect(result.queuedMake).toBe('Newer edit');
  expect(result.statusText).toContain('syncing latest changes');
  expect(result.statusKind).toBe('warning');
  expect(result.saveState).toBe('local');
  expect(result.lastState).toBe('local-safe');
  expect(result.dirty).toBe(false);
});

test('reachable empty cloud migrates the legacy device collection instead of erasing it', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const uid = '16000000-0000-4000-8000-000000000007';
    await openImageDB();
    await openStateDB();
    localStorage.removeItem('firearms-vault-active-user-v1');
    const legacy = {
      version: 3, encrypted: false,
      firearms: [{ id: 'legacy-gun', make: 'Legacy', model: 'Preserved', images: ['legacy-photo'], documents: [] }],
      ammo: [], accessories: [], wishlist: [], dealers: [], backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    await statePut('db', legacy);
    await idbPut('legacy-photo', 'data:text/plain;base64,bGVnYWN5LXBob3Rv');
    const activated = await CloudSync.activateUser(uid);
    const calls = [];
    window.sbClient = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() { return { data: null, error: null }; }
        };
      },
      storage: { from: () => ({
        async upload(path) { calls.push({ type: 'upload', path }); return { data: { path }, error: null }; },
        async download() { return { data: null, error: { message: 'unexpected download' } }; },
        async remove() { return { data: [], error: null }; }
      }) },
      async rpc(name, args) {
        calls.push({ type: 'rpc', name, data: args.p_new_data });
        return { data: {
          status: 'saved', revision: 1, updated_at: '2026-07-20T00:00:00.000Z',
          data: args.p_new_data, media_manifest: args.p_new_media_manifest
        }, error: null };
      }
    };
    CloudSync._casRpcSupported = true;
    const pulled = await CloudSync.pull({ awaitMedia: true });
    const outbox = await CloudSync.storeGet('outbox', uid);
    return {
      activated, pulled, calls, outbox,
      firearms: db.firearms.map(item => ({ id: item.id, make: item.make, model: item.model })),
      photoPresent: !!imagesDb['legacy-photo']
    };
  });

  expect(result.activated.ok).toBe(true);
  expect(result.pulled.ok).toBe(true);
  expect(result.firearms).toEqual([{ id: 'legacy-gun', make: 'Legacy', model: 'Preserved' }]);
  expect(result.photoPresent).toBe(true);
  expect(result.calls.some(call => call.type === 'upload' && call.path.startsWith('16000000-'))).toBe(true);
  expect(result.calls.find(call => call.type === 'rpc').data.firearms[0].id).toBe('legacy-gun');
  expect(result.outbox).toBeNull();
});

test('same-user crash recovery promotes a newer safety state over older primary and secondary records', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const uid = '17000000-0000-4000-8000-000000000017';
    const empty = {
      version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    const older = structuredClone(empty);
    older.firearms = [{ id: 'older-copy', make: 'Older', model: 'Queued', images: [], documents: [] }];
    const newer = structuredClone(empty);
    newer.firearms = [{ id: 'newer-copy', make: 'Newer', model: 'State', images: [], documents: [] }];

    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uid);
    await VaultDataSafety.clearState(uid);
    await CloudSync.storeDelete('outbox', uid);
    await CloudSync.storeDelete('cache', uid);
    await CloudSync.storePut('outbox', {
      uid, id: 'older-primary', data: older, mediaManifest: {}, baseData: empty,
      baseMediaManifest: {}, baseRevision: 0, baseUpdatedAt: null,
      queuedAt: '2020-01-01T00:00:00.000Z', reason: 'older-primary', attempts: 0,
      mediaFingerprints: {}
    });
    await CloudSync.storePut('cache', {
      uid, data: older, revision: 0, updatedAt: null, mediaManifest: {},
      pending: false, cachedAt: '2020-01-01T00:00:00.000Z'
    });
    await VaultDataSafety.enqueue(uid, older, 0);
    await new Promise(resolve => setTimeout(resolve, 5));
    await VaultDataSafety.putState(uid, newer, {
      pending: true, queuedAt: new Date().toISOString(), baseRevision: 0,
      baseUpdatedAt: null, baseData: older, baseMediaManifest: {},
      mediaManifest: {}, mediaFingerprints: {}, mutationGeneration: 1
    });

    await statePut('db', empty);
    const reactivated = await CloudSync.activateUser(uid);
    const runtimeAfterActivation = await stateGet('db');
    const promotedOutbox = await CloudSync.storeGet('outbox', uid);
    const promotedCache = await CloudSync.storeGet('cache', uid);

    db = structuredClone(empty);
    const loaded = await CloudSync.loadCachedIntoMemory(CloudSync.accountContext(), CloudSync._mutationGeneration);
    const loadedId = db.firearms[0] && db.firearms[0].id;

    await statePut('db', empty);
    const hydrated = await CloudSync.hydrateRuntime(uid, CloudSync.accountContext());
    const runtime = await stateGet('db');
    return {
      reactivated,
      activationRuntimeId: runtimeAfterActivation && runtimeAfterActivation.firearms[0] && runtimeAfterActivation.firearms[0].id,
      promotedOutboxId: promotedOutbox && promotedOutbox.data.firearms[0] && promotedOutbox.data.firearms[0].id,
      promotedReason: promotedOutbox && promotedOutbox.reason,
      promotedCacheId: promotedCache && promotedCache.data.firearms[0] && promotedCache.data.firearms[0].id,
      promotedCachePending: promotedCache && promotedCache.pending,
      loaded, loadedId, hydrated,
      runtimeId: runtime && runtime.firearms[0] && runtime.firearms[0].id
    };
  });

  expect(result.reactivated.ok).toBe(true);
  expect(result.activationRuntimeId).toBe('newer-copy');
  expect(result.promotedOutboxId).toBe('newer-copy');
  expect(result.promotedReason).toBe('secondary-recovery');
  expect(result.promotedCacheId).toBe('newer-copy');
  expect(result.promotedCachePending).toBe(true);
  expect(result.loaded.ok).toBe(true);
  expect(result.loadedId).toBe('newer-copy');
  expect(result.hydrated.ok).toBe(true);
  expect(result.runtimeId).toBe('newer-copy');
});

test('an exact secondary save finishes the form and is promoted after a primary outbox failure', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const uid = '18000000-0000-4000-8000-000000000018';
    const empty = {
      version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uid);
    await VaultDataSafety.clearState(uid);
    await CloudSync.storeDelete('outbox', uid);
    await CloudSync.storeDelete('cache', uid);
    db = structuredClone(empty);
    CloudSync.ready = true;

    openWishlistModal();
    document.getElementById('wMake').value = 'Recovery Arms';
    document.getElementById('wModel').value = 'Durable Secondary';

    const originalStorePut = CloudSync.storePut;
    let failedPrimaryOutbox = false;
    CloudSync.storePut = async function(storeName, record) {
      if (storeName === 'outbox' && !failedPrimaryOutbox) {
        failedPrimaryOutbox = true;
        throw new Error('simulated primary outbox failure');
      }
      return originalStorePut.call(this, storeName, record);
    };
    let saved;
    try {
      saved = await saveWishlistItem();
    } finally {
      CloudSync.storePut = originalStorePut;
      clearTimeout(CloudSync.pushTimer);
    }
    const secondary = await VaultDataSafety.listOutbox(uid);
    const primaryBeforeReload = await CloudSync.storeGet('outbox', uid);
    const closedAfterSave = !document.getElementById('wishlistModal').classList.contains('open');
    const dirtyAfterSave = hasUnsavedChanges;

    db = structuredClone(empty);
    await statePut('db', empty);
    const reactivated = await CloudSync.activateUser(uid);
    const runtime = await stateGet('db');
    const primaryAfterReload = await CloudSync.storeGet('outbox', uid);
    db = structuredClone(runtime);
    CloudSync.ready = true;
    CloudSync._casRpcSupported = true;
    window.sbClient = {
      storage: { from: () => ({
        async upload() { return { data: {}, error: null }; },
        async remove() { return { data: [], error: null }; }
      }) },
      async rpc(name, args) {
        return { data: {
          status: 'saved', revision: 1, updated_at: '2026-07-20T00:00:00.000Z',
          data: args.p_new_data, media_manifest: args.p_new_media_manifest
        }, error: null };
      }
    };
    const pushed = await CloudSync.push({
      capture: false, reason: 'promoted-recovery', queuePromise: Promise.resolve({ ok: true })
    }, CloudSync.accountContext());
    const primaryAfterPush = await CloudSync.storeGet('outbox', uid);
    return {
      saved, failedPrimaryOutbox, secondaryCount: secondary.length,
      primaryBeforeReload: !!primaryBeforeReload, closedAfterSave, dirtyAfterSave,
      reactivated,
      runtimeWishlist: runtime && runtime.wishlist.map(item => item.model),
      promotedWishlist: primaryAfterReload && primaryAfterReload.data.wishlist.map(item => item.model),
      promotedReason: primaryAfterReload && primaryAfterReload.reason,
      promotedGeneration: primaryAfterReload && primaryAfterReload.mutationGeneration,
      recoveredGeneration: primaryAfterReload && primaryAfterReload.recoveredMutationGeneration,
      currentGeneration: CloudSync._mutationGeneration,
      pushed, primaryAfterPush: !!primaryAfterPush
    };
  });

  expect(result.saved).toBe(true);
  expect(result.failedPrimaryOutbox).toBe(true);
  expect(result.secondaryCount).toBeGreaterThan(0);
  expect(result.primaryBeforeReload).toBe(false);
  expect(result.closedAfterSave).toBe(true);
  expect(result.dirtyAfterSave).toBe(false);
  expect(result.reactivated.ok).toBe(true);
  expect(result.runtimeWishlist).toEqual(['Durable Secondary']);
  expect(result.promotedWishlist).toEqual(['Durable Secondary']);
  expect(result.promotedReason).toBe('secondary-recovery');
  expect(result.promotedGeneration).toBe(result.currentGeneration);
  expect(result.recoveredGeneration).toBeGreaterThan(0);
  expect(result.pushed).toMatchObject({ ok: true, pendingNewerChanges: false });
  expect(result.primaryAfterPush).toBe(false);
});

test('newer safety media wins across a reset runtime even when structured checksums match', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const uid = '19000000-0000-4000-8000-000000000019';
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uid);
    const data = {
      version: 3, encrypted: false,
      firearms: [{ id: 'stable-media-gun', make: 'Stable', model: 'Media', images: ['stable-photo'], documents: [] }],
      ammo: [], accessories: [], wishlist: [], dealers: [], backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    const h2Bytes = 'data:image/png;base64,aDI=';
    const h2 = await CloudSync.mediaMetadata(h2Bytes);
    h2.path = CloudSync.contentPath('stable-photo', h2.sha256, uid);
    await CloudSync.putScopedMedia(uid, 'stable-photo', h2Bytes, h2);
    const primary = {
      uid, id: 'old-primary', data, mediaManifest: { 'stable-photo': { sha256: 'h1', path: uid + '/old-h1' } },
      baseData: {}, baseMediaManifest: {}, baseRevision: 0, queuedAt: '2020-01-01T00:00:00.000Z',
      mutationGeneration: 50, sourceId: 'old-runtime', mediaFingerprints: {}, vaultStateChecksum: 'same-structured-checksum'
    };
    const safety = {
      data, mediaManifest: { 'stable-photo': h2 }, checksum: 'same-structured-checksum',
      savedAt: '2026-07-20T12:00:00.000Z', safety: true, safetySource: 'state',
      metadata: {
        pending: true, queuedAt: '2026-07-20T12:00:00.000Z', mutationGeneration: 1,
        sourceId: 'new-runtime', mediaManifest: { 'stable-photo': h2 },
        mediaFingerprints: { 'stable-photo': CloudSync.mediaFingerprint(h2Bytes) },
        baseData: {}, baseMediaManifest: {}
      }
    };
    const selected = CloudSync.selectLocalRecovery(primary, null, safety);
    const promoted = await CloudSync.withOutboxLock(CloudSync.accountContext(), () =>
      CloudSync.promoteSafetyRecovery(uid, selected, primary, null, CloudSync.accountContext()));
    return {
      selectedSafety: !!selected.safety,
      promotedSha: promoted.mediaManifest['stable-photo'].sha256,
      promotedPath: promoted.mediaManifest['stable-photo'].path,
      h2Sha: h2.sha256,
      recoveredGeneration: promoted.recoveredMutationGeneration
    };
  });

  expect(result.selectedSafety).toBe(true);
  expect(result.promotedSha).toBe(result.h2Sha);
  expect(result.promotedPath).toContain(result.h2Sha.slice(0, 32));
  expect(result.recoveredGeneration).toBe(1);
});

test('state-only durability survives an immediate stale-cloud pull and reaches the cloud', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const uid = '1a000000-0000-4000-8000-00000000001a';
    const empty = {
      version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uid);
    await VaultDataSafety.clearState(uid);
    await CloudSync.storeDelete('outbox', uid);
    await CloudSync.storeDelete('cache', uid);
    db = structuredClone(empty);
    CloudSync.ready = true;
    CloudSync._casRpcSupported = true;
    openWishlistModal();
    document.getElementById('wMake').value = 'State Only';
    document.getElementById('wModel').value = 'Preserved';

    const originalSafety = window.VaultDataSafety;
    let enqueueFailed = false;
    window.VaultDataSafety = Object.assign({}, originalSafety, {
      enqueue: async () => {
        enqueueFailed = true;
        throw new Error('simulated secondary enqueue failure');
      }
    });
    const saved = await saveWishlistItem();
    window.VaultDataSafety = originalSafety;
    clearTimeout(CloudSync.pushTimer);

    const primaryBeforePull = await CloudSync.storeGet('outbox', uid);
    const stateBeforePull = await VaultDataSafety.getState(uid);
    const rpcWrites = [];
    window.sbClient = {
      from() {
        return {
          select() { return this; }, eq() { return this; },
          async maybeSingle() {
            return { data: { data: empty, revision: 0, updated_at: '2026-07-20T00:00:00.000Z', media_manifest: {} }, error: null };
          }
        };
      },
      storage: { from: () => ({
        async upload() { return { data: {}, error: null }; },
        async download() { return { data: null, error: new Error('unexpected download') }; },
        async remove() { return { data: [], error: null }; }
      }) },
      async rpc(name, args) {
        rpcWrites.push(args.p_new_data.wishlist.map(item => item.model));
        return { data: {
          status: 'saved', revision: 1, updated_at: '2026-07-20T00:00:01.000Z',
          data: args.p_new_data, media_manifest: args.p_new_media_manifest
        }, error: null };
      }
    };
    const pulled = await CloudSync.pull({ awaitMedia: true });
    const primaryAfterPull = await CloudSync.storeGet('outbox', uid);
    const stateAfterPull = await VaultDataSafety.getState(uid);
    return {
      saved, enqueueFailed, primaryBeforePull: !!primaryBeforePull,
      statePendingBefore: !!(stateBeforePull && stateBeforePull.metadata.pending),
      pulled, rpcWrites, memoryModels: db.wishlist.map(item => item.model),
      primaryAfterPull: !!primaryAfterPull,
      statePendingAfter: !!(stateAfterPull && stateAfterPull.metadata.pending)
    };
  });

  expect(result.saved).toBe(true);
  expect(result.enqueueFailed).toBe(true);
  expect(result.primaryBeforePull).toBe(false);
  expect(result.statePendingBefore).toBe(true);
  expect(result.pulled.ok).toBe(true);
  expect(result.rpcWrites).toEqual([['Preserved']]);
  expect(result.memoryModels).toEqual(['Preserved']);
  expect(result.primaryAfterPull).toBe(false);
  expect(result.statePendingAfter).toBe(false);
});

test('same-session secondary promotion commits once and clears the failed queue barrier', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const uid = '1b000000-0000-4000-8000-00000000001b';
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uid);
    await VaultDataSafety.clearState(uid);
    await CloudSync.storeDelete('outbox', uid);
    await CloudSync.storeDelete('cache', uid);
    db = {
      version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    CloudSync.ready = true;
    CloudSync._casRpcSupported = true;
    const rpcWrites = [];
    window.sbClient = {
      storage: { from: () => ({
        async upload() { return { data: {}, error: null }; },
        async remove() { return { data: [], error: null }; }
      }) },
      async rpc(name, args) {
        rpcWrites.push(args.p_new_data.wishlist.map(item => item.model));
        return { data: {
          status: 'saved', revision: rpcWrites.length, updated_at: '2026-07-20T00:00:02.000Z',
          data: args.p_new_data, media_manifest: args.p_new_media_manifest
        }, error: null };
      }
    };
    openWishlistModal();
    document.getElementById('wMake').value = 'Retry Arms';
    document.getElementById('wModel').value = 'One Commit';
    const originalPut = CloudSync.storePut;
    let failed = false;
    CloudSync.storePut = async function(storeName, record) {
      if (storeName === 'outbox' && !failed) { failed = true; throw new Error('primary outbox unavailable'); }
      return originalPut.call(this, storeName, record);
    };
    const saved = await saveWishlistItem();
    CloudSync.storePut = originalPut;
    clearTimeout(CloudSync.pushTimer);
    const firstPush = await CloudSync.push({ capture: false, reason: 'same-session-recovery' }, CloudSync.accountContext());
    const secondPush = await CloudSync.push({ capture: false, reason: 'online-repeat' }, CloudSync.accountContext());
    const outbox = await CloudSync.storeGet('outbox', uid);
    const safetyState = await VaultDataSafety.getState(uid);
    const safetyOutbox = await VaultDataSafety.listOutbox(uid);
    return { saved, failed, firstPush, secondPush, rpcWrites, outbox: !!outbox,
      safetyPending: !!(safetyState && safetyState.metadata.pending), safetyOutbox: safetyOutbox.length };
  });

  expect(result.saved).toBe(true);
  expect(result.failed).toBe(true);
  expect(result.firstPush).toMatchObject({ ok: true, pendingNewerChanges: false });
  expect(result.secondPush).toMatchObject({ ok: true, status: 'already-synced' });
  expect(result.rpcWrites).toEqual([['One Commit']]);
  expect(result.outbox).toBe(false);
  expect(result.safetyPending).toBe(false);
  expect(result.safetyOutbox).toBe(0);
});

test('a second tab merges a prior state-only recovery before writing its own snapshot', async ({ page, context }) => {
  const uid = '1d000000-0000-4000-8000-00000000001d';
  const second = await context.newPage();
  await second.goto('/index.html');
  await expect(second.locator('#authForm')).toBeVisible({ timeout: 15000 });
  const empty = {
    version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
    backups: [], settings: {}, auditTrail: [], valueHistory: []
  };
  await page.evaluate(async ({ uid, empty }) => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    await VaultDataSafety.clearState(uid);
    await CloudSync.storeDelete('outbox', uid); await CloudSync.storeDelete('cache', uid);
    db = structuredClone(empty);
  }, { uid, empty });
  await second.evaluate(async ({ uid, empty }) => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    db = structuredClone(empty);
  }, { uid, empty });

  await page.evaluate(async ({ uid, empty }) => {
    const first = structuredClone(empty);
    first.firearms = [{ id: 'state-only-a', make: 'Recovered A', model: 'First', images: [], documents: [] }];
    await VaultDataSafety.putState(uid, first, {
      pending: true, queuedAt: '2026-07-20T00:00:00.000Z', entryId: 'state-only-a',
      baseRevision: 0, baseData: empty, baseMediaManifest: {}, mediaManifest: {},
      mutationGeneration: 1, sourceId: CloudSync._sourceId
    });
  }, { uid, empty });

  const result = await second.evaluate(async ({ uid, empty }) => {
    db = structuredClone(empty);
    db.firearms = [{ id: 'tab-b-after-state', make: 'Tab B', model: 'Second', images: [], documents: [] }];
    imagesDb = {}; hasUnsavedChanges = true;
    const generation = ++CloudSync._mutationGeneration;
    const queued = await CloudSync.queueCurrentSnapshot('after-state-only', CloudSync.accountContext(), generation);
    const outbox = await CloudSync.storeGet('outbox', uid);
    const state = await VaultDataSafety.getState(uid);
    return {
      queued,
      primary: outbox.data.firearms.map(item => item.id).sort(),
      safety: state.data.firearms.map(item => item.id).sort(),
      merged: !!outbox.crossTabMerged
    };
  }, { uid, empty });

  expect(result.queued).toMatchObject({ ok: true, status: 'local-safe' });
  expect(result.primary).toEqual(['state-only-a', 'tab-b-after-state']);
  expect(result.safety).toEqual(result.primary);
  expect(result.merged).toBe(true);
  await second.close();
});

test('cross-tab queues coalesce disjoint edits and later same-tab edits before one settled commit', async ({ page, context }) => {
  const uid = '1c000000-0000-4000-8000-00000000001c';
  const second = await context.newPage();
  await second.goto('/index.html');
  await expect(second.locator('#authForm')).toBeVisible({ timeout: 15000 });
  const empty = {
    version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
    backups: [], settings: {}, auditTrail: [], valueHistory: []
  };
  const tabA = await page.evaluate(async ({ uid, empty }) => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    await VaultDataSafety.clearState(uid); await CloudSync.storeDelete('outbox', uid); await CloudSync.storeDelete('cache', uid);
    db = structuredClone(empty);
    db.firearms = [{ id: 'tab-a', make: 'Tab A', model: 'First', images: [], documents: [] }];
    imagesDb = {}; hasUnsavedChanges = true;
    const generation = ++CloudSync._mutationGeneration;
    await CloudSync.queueCurrentSnapshot('tab-a', CloudSync.accountContext(), generation);
    const outbox = await CloudSync.storeGet('outbox', uid);
    return { runtimeSource: CloudSync._sourceId, outboxSource: outbox && outbox.sourceId,
      records: outbox && outbox.data.firearms.map(item => [item.id, item.model]).sort() };
  }, { uid, empty });
  const tabB = await second.evaluate(async ({ uid, empty }) => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    const before = await CloudSync.storeGet('outbox', uid);
    db = structuredClone(empty);
    db.firearms = [{ id: 'tab-b', make: 'Tab B', model: 'First', images: [], documents: [] }];
    imagesDb = {}; hasUnsavedChanges = true;
    let generation = ++CloudSync._mutationGeneration;
    await CloudSync.queueCurrentSnapshot('tab-b-first', CloudSync.accountContext(), generation);
    db.firearms[0].model = 'Second';
    hasUnsavedChanges = true;
    generation = ++CloudSync._mutationGeneration;
    await CloudSync.queueCurrentSnapshot('tab-b-second', CloudSync.accountContext(), generation);
    const after = await CloudSync.storeGet('outbox', uid);
    return {
      runtimeSource: CloudSync._sourceId,
      beforeSource: before && before.sourceId,
      beforeRecords: before && before.data.firearms.map(item => [item.id, item.model]).sort(),
      afterSource: after && after.sourceId,
      afterMerged: !!(after && after.crossTabMerged),
      afterRecords: after && after.data.firearms.map(item => [item.id, item.model]).sort()
    };
  }, { uid, empty });

  expect(tabA.records).toEqual([['tab-a', 'First']]);
  expect(tabB.beforeRecords).toEqual(tabA.records);
  expect(tabB.runtimeSource).not.toBe(tabA.runtimeSource);
  expect(tabB.beforeSource).toBe(tabA.outboxSource);
  expect(tabB.afterMerged).toBe(true);

  const queued = await second.evaluate(async uid => {
    const outbox = await CloudSync.storeGet('outbox', uid);
    return outbox.data.firearms.map(item => [item.id, item.model]).sort();
  }, uid);
  expect(queued).toEqual([['tab-a', 'First'], ['tab-b', 'Second']]);

  // The older tab, not the source of the final merged entry, performs the
  // cloud write. It must still reconcile AB and clear every safety mirror.
  const committed = await page.evaluate(async uid => {
    CloudSync.ready = true;
    CloudSync._casRpcSupported = true;
    window.__crossTabCloud = null;
    window.sbClient = {
      storage: { from: () => ({ async upload() { return { data: {}, error: null }; }, async remove() { return { data: [], error: null }; } }) },
      async rpc(name, args) {
        window.__crossTabCloud = structuredClone(args.p_new_data);
        return { data: { status: 'saved', revision: 1, updated_at: '2026-07-20T00:00:03.000Z',
          data: args.p_new_data, media_manifest: args.p_new_media_manifest }, error: null };
      }
    };
    const pushed = await CloudSync.push({ capture: false, reason: 'cross-tab', queuePromise: Promise.resolve({ ok: true }) }, CloudSync.accountContext());
    const outbox = await CloudSync.storeGet('outbox', uid);
    const state = await VaultDataSafety.getState(uid);
    const safetyOutbox = await VaultDataSafety.listOutbox(uid);
    return {
      pushed, outbox: !!outbox,
      memory: db.firearms.map(item => [item.id, item.model]).sort(),
      cloud: window.__crossTabCloud.firearms.map(item => [item.id, item.model]).sort(),
      safetyPending: !!(state && state.metadata.pending), safetyOutbox: safetyOutbox.length
    };
  }, uid);
  expect(committed.pushed).toMatchObject({ ok: true, pendingNewerChanges: false });
  expect(committed.outbox).toBe(false);
  expect(committed.memory).toEqual([['tab-a', 'First'], ['tab-b', 'Second']]);
  expect(committed.cloud).toEqual(committed.memory);
  expect(committed.safetyPending).toBe(false);
  expect(committed.safetyOutbox).toBe(0);

  const third = await context.newPage();
  await third.goto('/index.html');
  const restored = await third.evaluate(async uid => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    const runtime = await stateGet('db');
    return runtime.firearms.map(item => [item.id, item.model]).sort();
  }, uid);
  expect(restored).toEqual(committed.cloud);
  await third.close();
  await second.close();
});
