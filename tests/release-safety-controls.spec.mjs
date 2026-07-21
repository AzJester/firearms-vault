import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await expect.poll(() => page.evaluate(() => typeof window.getReferencedFirearmImages)).toBe('function');
  await page.evaluate(() => {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('firstRunPanel').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
  });
});

test('downloaded recovery backups include only images referenced by saved firearms', async ({ page }) => {
  const result = await page.evaluate(async () => {
    db = {
      version: 3, encrypted: false, backups: [], settings: {}, auditTrail: [], valueHistory: [],
      firearms: [{ id: 'saved-firearm', make: 'Example', model: 'Saved', images: ['saved-photo'] }],
      ammo: [], accessories: [], wishlist: [], dealers: []
    };
    imagesDb = {
      'saved-photo': 'data:image/png;base64,c2F2ZWQ=',
      'draft-photo': 'data:image/png;base64,ZHJhZnQ=',
      'unrelated-photo': 'data:image/png;base64,b3RoZXI='
    };
    CloudSync.uid = 'backup-owner';
    window.confirmDialog = async () => true;
    window.downloadBlobFile = () => {};
    window.saveToLocalStorage = async () => true;
    window.openBackupModal = async () => {};
    window.VaultDataSafety = {
      createBackup: async (_uid, _data, _reason, meta) => { window.__backupMeta = meta; },
      exportEnvelope: async (_uid, data) => { window.__backupPayload = data; return { format: 'test' }; }
    };
    await downloadRecoveryBackup(false);
    return {
      imageKeys: Object.keys(window.__backupPayload.images),
      mediaCount: window.__backupMeta.mediaCount
    };
  });

  expect(result.imageKeys).toEqual(['saved-photo']);
  expect(result.mediaCount).toBe(1);
});

test('full recovery backup waits for background media hydration before exporting', async ({ page }) => {
  const result = await page.evaluate(async () => {
    db = {
      version: 3, encrypted: false, backups: [], settings: {}, auditTrail: [], valueHistory: [],
      firearms: [{ id: 'hydrating-firearm', make: 'Example', model: 'Hydrating', images: ['slow-photo'] }],
      ammo: [], accessories: [], wishlist: [], dealers: []
    };
    imagesDb = {};
    CloudSync.uid = 'backup-owner';
    CloudSync._mediaHydrationPromise = new Promise(resolve => {
      setTimeout(() => {
        imagesDb['slow-photo'] = 'data:image/png;base64,aHlkcmF0ZWQ=';
        window.__hydratedAt = performance.now();
        resolve({ ok: true });
      }, 60);
    });
    CloudSync.pull = async () => { window.__unexpectedPull = true; return { ok: false }; };
    window.confirmDialog = async () => true;
    window.downloadBlobFile = () => { window.__downloaded = true; };
    window.saveToLocalStorage = async () => true;
    window.openBackupModal = async () => {};
    window.VaultDataSafety = {
      createBackup: async () => {},
      exportEnvelope: async (_uid, data) => {
        window.__exportedAt = performance.now();
        window.__backupPayload = data;
        return { format: 'test' };
      }
    };
    await downloadRecoveryBackup(false);
    return {
      image: window.__backupPayload && window.__backupPayload.images['slow-photo'],
      waited: window.__exportedAt >= window.__hydratedAt,
      downloaded: !!window.__downloaded,
      unexpectedPull: !!window.__unexpectedPull
    };
  });

  expect(result.image).toContain('data:image/png');
  expect(result.waited).toBe(true);
  expect(result.downloaded).toBe(true);
  expect(result.unexpectedPull).toBe(false);
});

test('full backup and connected-file writes do not emit incomplete media', async ({ page }) => {
  const result = await page.evaluate(async () => {
    db = {
      version: 3, encrypted: false, backups: [], settings: {}, auditTrail: [], valueHistory: [],
      firearms: [{ id: 'missing-firearm', make: 'Example', model: 'Missing', images: ['missing-photo'] }],
      ammo: [], accessories: [], wishlist: [], dealers: []
    };
    imagesDb = {};
    CloudSync.uid = 'backup-owner';
    CloudSync._mediaHydrationPromise = Promise.resolve({ ok: false });
    CloudSync.pull = async () => ({ ok: false, status: 'offline' });
    window.confirmDialog = async () => true;
    window.__warnings = [];
    window.toast = message => window.__warnings.push(String(message));
    window.__backupExported = false;
    window.__downloaded = false;
    window.downloadBlobFile = () => { window.__downloaded = true; };
    window.saveToLocalStorage = async () => true;
    window.VaultDataSafety = {
      createBackup: async () => { window.__backupExported = true; },
      exportEnvelope: async () => { window.__backupExported = true; return { format: 'test' }; }
    };
    await downloadRecoveryBackup(false);

    window.__writerOpened = false;
    fileHandle = {
      name: 'existing.json',
      async createWritable() {
        window.__writerOpened = true;
        return { write: async () => {}, close: async () => {} };
      }
    };
    const wrote = await writeToDisk({ manual: false });
    return {
      backupExported: window.__backupExported,
      downloaded: window.__downloaded,
      writerOpened: window.__writerOpened,
      wrote,
      warning: window.__warnings.join(' ')
    };
  });

  expect(result.backupExported).toBe(false);
  expect(result.downloaded).toBe(false);
  expect(result.writerOpened).toBe(false);
  expect(result.wrote).toBe(false);
  expect(result.warning).toMatch(/not available|not overwritten/i);
});

test('photo sharing stops before the RPC when a selected photo is unavailable', async ({ page }) => {
  const result = await page.evaluate(async () => {
    db = {
      version: 3, encrypted: false, backups: [], settings: {}, auditTrail: [], valueHistory: [],
      firearms: [{ id: 'share-firearm', make: 'Example', model: 'Share', status: 'Active', images: ['missing-share-photo'] }],
      ammo: [], accessories: [], wishlist: [], dealers: []
    };
    imagesDb = {};
    CloudSync.uid = 'share-owner';
    CloudSync._mediaHydrationPromise = Promise.resolve({ ok: false });
    CloudSync.pull = async () => ({ ok: false, status: 'offline' });
    window.confirmDialog = async () => true;
    window.__shareRpcCalled = false;
    window.__warnings = [];
    window.toast = message => window.__warnings.push(String(message));
    window.sbClient = {
      rpc: async () => { window.__shareRpcCalled = true; return { data: 'token', error: null }; }
    };
    document.getElementById('sharePhotos').checked = true;
    document.getElementById('shareSerials').checked = false;
    document.getElementById('shareExpiry').value = '7';
    document.getElementById('shareCode').value = '';
    document.getElementById('shareMaxViews').value = '';
    await createShare();
    return {
      rpcCalled: window.__shareRpcCalled,
      warning: window.__warnings.join(' '),
      buttonDisabled: document.getElementById('createShareBtn').disabled
    };
  });

  expect(result.rpcCalled).toBe(false);
  expect(result.warning).toMatch(/photo sharing stopped|not available/i);
  expect(result.buttonDisabled).toBe(false);
});

test('clearing a new-firearm draft deletes only its unreferenced images', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await openImageDB();
    db.firearms = [{ id: 'saved-firearm', make: 'Example', model: 'Saved', images: ['shared-photo'] }];
    imagesDb = {
      'draft-only-photo': 'data:image/png;base64,ZHJhZnQ=',
      'shared-photo': 'data:image/png;base64,c2hhcmVk',
      'unrelated-photo': 'data:image/png;base64,b3RoZXI='
    };
    await idbPut('draft-only-photo', imagesDb['draft-only-photo']);
    await idbPut('shared-photo', imagesDb['shared-photo']);
    await idbPut('unrelated-photo', imagesDb['unrelated-photo']);
    tempImages = ['shared-photo'];
    editingId = null;
    CloudSync.uid = null;
    CloudSync.storeGet = async () => ({ value: { images: ['shared-photo'], ownedImages: ['draft-only-photo', 'shared-photo'] } });
    CloudSync.storeDelete = async () => true;
    await clearFirearmDraftForUser();
    return {
      memory: Object.keys(imagesDb).sort(),
      draftInIdb: await idbGet('draft-only-photo'),
      sharedInIdb: await idbGet('shared-photo'),
      unrelatedInIdb: await idbGet('unrelated-photo')
    };
  });

  expect(result.memory).toEqual(['shared-photo', 'unrelated-photo']);
  expect(result.draftInIdb).toBeUndefined();
  expect(result.sharedInIdb).toContain('data:image/png');
  expect(result.unrelatedInIdb).toContain('data:image/png');
});

test('new-firearm draft photos survive runtime-cache clearing and restore from scoped draft storage', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const uid = 'd6000000-0000-4000-8000-000000000006';
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uid);
    await openAddModal();
    const photo = 'data:image/png;base64,ZHJhZnQtcGhvdG8=';
    imagesDb['draft-photo'] = photo;
    await idbPut('draft-photo', photo);
    tempImages = ['draft-photo'];
    _firearmDraftOwnedImages.add('draft-photo');
    document.getElementById('fMake').value = 'Draft maker';
    saveFirearmDraftSoon();
    const saved = await flushFirearmDraft();
    const stored = await CloudSync.storeGet('meta', firearmDraftKey(uid));

    await CloudSync.clearRuntimeCaches({ preserveAccount: true });
    delete imagesDb['draft-photo'];
    tempImages = [];
    _firearmDraftOwnedImages.clear();
    document.getElementById('fMake').value = '';
    await restoreFirearmDraft();
    return {
      saved,
      storedBytes: stored && stored.value && stored.value.imageData && stored.value.imageData['draft-photo'],
      restoredBytes: imagesDb['draft-photo'],
      restoredRuntime: await idbGet('draft-photo'),
      restoredImages: [...tempImages],
      restoredMake: document.getElementById('fMake').value
    };
  });

  expect(result.saved).toBe(true);
  expect(result.storedBytes).toContain('data:image/png');
  expect(result.restoredBytes).toBe(result.storedBytes);
  expect(result.restoredRuntime).toBe(result.storedBytes);
  expect(result.restoredImages).toEqual(['draft-photo']);
  expect(result.restoredMake).toBe('Draft maker');
});

test('two tabs keep distinct Add Firearm drafts when the second opens after the first saved', async ({ page, context }) => {
  const uid = 'd6100000-0000-4000-8000-000000000061';
  await page.evaluate(async uid => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    await window.clearFirearmDraftForUser(uid);
    db = { version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: [] };
  }, uid);
  const first = await page.evaluate(async uid => {
    await openAddModal();
    document.getElementById('fMake').value = 'Tab A Arms';
    document.getElementById('fModel').value = 'Alpha';
    saveFirearmDraftSoon();
    await flushFirearmDraft();
    return { key: firearmDraftKey(uid), make: document.getElementById('fMake').value };
  }, uid);
  const secondPromise = context.waitForEvent('page');
  await page.evaluate(() => window.open('/index.html', '_blank'));
  const second = await secondPromise;
  await second.waitForLoadState('domcontentloaded');
  await second.evaluate(() => {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('firstRunPanel').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
  });
  const secondSaved = await second.evaluate(async uid => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    db = { version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: [] };
    await openAddModal();
    const before = document.getElementById('fMake').value;
    document.getElementById('fMake').value = 'Tab B Works';
    document.getElementById('fModel').value = 'Bravo';
    saveFirearmDraftSoon();
    await flushFirearmDraft();
    const key = firearmDraftKey(uid);
    const records = (await CloudSync.storeGetAll('meta')).filter(record =>
      record.uid === uid && String(record.key).startsWith('fv:firearm-form-draft:' + uid + ':'));
    return { before, key, keys: records.map(record => record.key).sort() };
  }, uid);
  expect(secondSaved.before).toBe('');
  expect(secondSaved.key).not.toBe(first.key);
  expect(secondSaved.keys).toEqual([first.key, secondSaved.key].sort());

  await page.reload();
  await second.reload();
  const restoredA = await page.evaluate(async uid => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    db = { version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: [] };
    await openAddModal();
    return { make: document.getElementById('fMake').value, model: document.getElementById('fModel').value,
      key: document.getElementById('formModal').dataset.firearmDraftKey };
  }, uid);
  const restoredB = await second.evaluate(async uid => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    db = { version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: [] };
    await openAddModal();
    return { make: document.getElementById('fMake').value, model: document.getElementById('fModel').value,
      key: document.getElementById('formModal').dataset.firearmDraftKey };
  }, uid);
  expect(restoredA).toEqual({ make: 'Tab A Arms', model: 'Alpha', key: first.key });
  expect(restoredB).toEqual({ make: 'Tab B Works', model: 'Bravo', key: secondSaved.key });

  await page.evaluate(() => clearFirearmDraft(undefined, { committed: true }));
  const sibling = await second.evaluate(async ({ ownKey, removedKey }) => ({
    own: !!(await CloudSync.storeGet('meta', ownKey)),
    removed: !!(await CloudSync.storeGet('meta', removedKey))
  }), { ownKey: secondSaved.key, removedKey: first.key });
  expect(sibling).toEqual({ own: true, removed: false });
  await second.close();
});

test('saving an existing firearm does not delete a parked new-firearm draft', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const uid = 'd6100000-0000-4000-8000-000000000016';
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uid);
    db.firearms = [{ id: 'existing-gun', make: 'Existing', model: 'Before', images: [], documents: [], tags: [], customFields: [], maintenanceLog: [] }];
    await openAddModal();
    document.getElementById('fMake').value = 'Parked draft';
    const draftPhoto = 'data:image/png;base64,cGFya2Vk';
    imagesDb['parked-photo'] = draftPhoto;
    await idbPut('parked-photo', draftPhoto);
    tempImages = ['parked-photo'];
    _firearmDraftOwnedImages.add('parked-photo');
    saveFirearmDraftSoon();
    await flushFirearmDraft();
    closeModal();

    openEditModal('existing-gun');
    document.getElementById('fModel').value = 'After';
    const originalSave = saveData;
    saveData = async () => true;
    try { await saveFirearm(); }
    finally { saveData = originalSave; }
    const stored = await CloudSync.storeGet('meta', firearmDraftKey(uid));
    return {
      model: db.firearms.find(item => item.id === 'existing-gun').model,
      draftMake: stored && stored.value && stored.value.values && stored.value.values.fMake,
      draftPhoto: stored && stored.value && stored.value.imageData && stored.value.imageData['parked-photo'],
      runtimePhoto: await idbGet('parked-photo')
    };
  });

  expect(result.model).toBe('After');
  expect(result.draftMake).toBe('Parked draft');
  expect(result.draftPhoto).toContain('cGFya2Vk');
  expect(result.runtimePhoto).toContain('cGFya2Vk');
});

test('a committed new firearm never returns as a duplicate draft when draft deletion fails', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const uid = 'd7100000-0000-4000-8000-000000000071';
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uid);
    await clearFirearmDraftForUser(uid);
    db = {
      version: 3, encrypted: false, backups: [], settings: {},
      auditTrail: [], valueHistory: [], firearms: [], ammo: [], accessories: [], wishlist: [], dealers: []
    };
    await openAddModal();
    document.getElementById('fMake').value = 'Committed Arms';
    document.getElementById('fModel').value = 'Only Once';
    saveFirearmDraftSoon();
    await flushFirearmDraft();

    const originalSave = saveData;
    const originalDelete = CloudSync.storeDelete;
    saveData = async () => true;
    CloudSync.storeDelete = async function(storeName, key) {
      if (storeName === 'meta' && key === firearmDraftKey(uid)) throw new Error('simulated draft delete failure');
      return originalDelete.call(this, storeName, key);
    };
    let saved;
    try { saved = await saveFirearm(); }
    finally {
      saveData = originalSave;
      CloudSync.storeDelete = originalDelete;
    }

    const staleBeforeReopen = await CloudSync.storeGet('meta', firearmDraftKey(uid));
    await openAddModal();
    const staleAfterReopen = await CloudSync.storeGet('meta', firearmDraftKey(uid));
    return {
      saved,
      records: db.firearms.map(item => item.model),
      staleBeforeReopen: !!staleBeforeReopen,
      staleAfterReopen: !!staleAfterReopen,
      restoredMake: document.getElementById('fMake').value,
      restoredModel: document.getElementById('fModel').value,
      draftStatus: document.getElementById('formDraftStatus').textContent,
      marker: readFirearmDraftResolution(uid)
    };
  });

  expect(result.saved).toBe(true);
  expect(result.records).toEqual(['Only Once']);
  expect(result.staleBeforeReopen).toBe(true);
  expect(result.staleAfterReopen).toBe(false);
  expect(result.restoredMake).toBe('');
  expect(result.restoredModel).toBe('');
  expect(result.draftStatus).not.toContain('restored');
  expect(result.marker).toBeNull();
});

test('a confirmed Add Firearm discard cannot return when draft deletion fails', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const uid = 'd7200000-0000-4000-8000-000000000072';
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uid);
    await clearFirearmDraftForUser(uid);
    await openAddModal();
    document.getElementById('fMake').value = 'Discarded Arms';
    saveFirearmDraftSoon();
    await flushFirearmDraft();
    const key = document.getElementById('formModal').dataset.firearmDraftKey;
    document.getElementById('formModal').dataset.dirty = 'true';

    const originalPut = CloudSync.storePut;
    const originalDelete = CloudSync.storeDelete;
    const originalConfirm = confirmDialog;
    CloudSync.storePut = async function(storeName, value) {
      if (storeName === 'meta' && value && value.key === key) throw new Error('simulated draft write failure');
      return originalPut.call(this, storeName, value);
    };
    CloudSync.storeDelete = async function(storeName, targetKey) {
      if (storeName === 'meta' && targetKey === key) throw new Error('simulated draft delete failure');
      return originalDelete.call(this, storeName, targetKey);
    };
    confirmDialog = async () => true;
    let closed;
    try { closed = await ModalAccessibility.requestClose(document.getElementById('formModal')); }
    finally {
      CloudSync.storePut = originalPut;
      CloudSync.storeDelete = originalDelete;
      confirmDialog = originalConfirm;
    }

    const staleBeforeReopen = await CloudSync.storeGet('meta', key);
    const markerBeforeReopen = readFirearmDraftResolution(uid, key);
    await openAddModal();
    const staleAfterReopen = await CloudSync.storeGet('meta', key);
    return {
      closed,
      staleBeforeReopen: !!staleBeforeReopen,
      markerBeforeReopen: !!markerBeforeReopen,
      staleAfterReopen: !!staleAfterReopen,
      restoredMake: document.getElementById('fMake').value,
      draftStatus: document.getElementById('formDraftStatus').textContent,
      markerAfterReopen: readFirearmDraftResolution(uid, key)
    };
  });

  expect(result.closed).toBe(true);
  expect(result.staleBeforeReopen).toBe(true);
  expect(result.markerBeforeReopen).toBe(true);
  expect(result.staleAfterReopen).toBe(false);
  expect(result.restoredMake).toBe('');
  expect(result.draftStatus).not.toContain('restored');
  expect(result.markerAfterReopen).toBeNull();
});

test('firearm Save waits for a selected photo to finish processing', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await openImageDB();
    db = {
      version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    await openAddModal();
    document.getElementById('fMake').value = 'Waited maker';
    const originalRead = readFileAsDataURL;
    const originalCompress = compressImage;
    const originalSave = saveData;
    let release;
    let durableCalls = 0;
    readFileAsDataURL = () => new Promise(resolve => { release = resolve; });
    compressImage = async value => value;
    saveData = async () => { durableCalls++; return true; };
    try {
      const photo = queueFirearmImage(new File(['photo'], 'photo.png', { type: 'image/png' }));
      const saving = saveFirearm();
      await new Promise(resolve => setTimeout(resolve, 20));
      const callsBeforePhoto = durableCalls;
      release('data:image/png;base64,d2FpdGVk');
      await photo;
      await saving;
      return {
        callsBeforePhoto,
        durableCalls,
        images: db.firearms[0] && db.firearms[0].images,
        open: document.getElementById('formModal').classList.contains('open')
      };
    } finally {
      readFileAsDataURL = originalRead;
      compressImage = originalCompress;
      saveData = originalSave;
    }
  });

  expect(result.callsBeforePhoto).toBe(0);
  expect(result.durableCalls).toBe(1);
  expect(result.images).toHaveLength(1);
  expect(result.open).toBe(false);
});

test('discarding an edited crop preserves the saved photo and removes the edit-only copy', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await openImageDB();
    const original = 'data:image/jpeg;base64,b3JpZ2luYWw=';
    const cropped = 'data:image/jpeg;base64,Y3JvcHBlZA==';
    db.firearms = [{
      id: 'crop-gun', make: 'Example', model: 'Original', images: ['saved-photo'], documents: [],
      tags: [], customFields: [], maintenanceLog: []
    }];
    imagesDb = { 'saved-photo': original };
    await idbPut('saved-photo', original);
    openEditModal('crop-gun');
    cropImageId = 'saved-photo';
    document.getElementById('cropCanvas').toDataURL = () => cropped;
    await applyCrop();
    const replacementId = tempImages[0];
    const dirtyBeforeDiscard = document.getElementById('formModal').dataset.dirty;
    window.confirmDialog = async () => true;
    await ModalAccessibility.requestClose(document.getElementById('formModal'));
    return {
      replacementId,
      dirtyBeforeDiscard,
      savedReference: db.firearms[0].images[0],
      originalMemory: imagesDb['saved-photo'],
      originalRuntime: await idbGet('saved-photo'),
      replacementMemory: imagesDb[replacementId] || null,
      replacementRuntime: (await idbGet(replacementId)) || null
    };
  });

  expect(result.replacementId).not.toBe('saved-photo');
  expect(result.dirtyBeforeDiscard).toBe('true');
  expect(result.savedReference).toBe('saved-photo');
  expect(result.originalMemory).toContain('b3JpZ2luYWw=');
  expect(result.originalRuntime).toContain('b3JpZ2luYWw=');
  expect(result.replacementMemory).toBeNull();
  expect(result.replacementRuntime).toBeNull();
});

test('a failed durable save keeps the firearm form and draft open without mutating the collection', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await openImageDB();
    await openStateDB();
    db = {
      version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    await openAddModal();
    document.getElementById('fMake').value = 'Unsaved maker';
    document.getElementById('fModel').value = 'Unsaved model';
    const originalSave = saveToLocalStorage;
    saveToLocalStorage = async () => false;
    try {
      await saveFirearm();
      return {
        records: db.firearms.length,
        open: document.getElementById('formModal').classList.contains('open'),
        dirty: document.getElementById('formModal').dataset.dirty,
        make: document.getElementById('fMake').value,
        status: document.getElementById('syncStatus').textContent
      };
    } finally {
      saveToLocalStorage = originalSave;
    }
  });

  expect(result.records).toBe(0);
  expect(result.open).toBe(true);
  expect(result.dirty).toBe('true');
  expect(result.make).toBe('Unsaved maker');
  expect(result.status).toContain('not saved');
});

test('a late photo read cannot attach to a different reopened firearm form', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await openImageDB();
    await openAddModal();
    const firstToken = document.getElementById('formModal').dataset.attachmentSession;
    const originalRead = readFileAsDataURL;
    let release;
    readFileAsDataURL = () => new Promise(resolve => { release = resolve; });
    try {
      const pending = queueFirearmImage(new File(['photo'], 'photo.png', { type: 'image/png' }));
      closeModal();
      await openAddModal();
      const secondToken = document.getElementById('formModal').dataset.attachmentSession;
      release('data:image/png;base64,cGhvdG8=');
      const loaded = await pending;
      return {
        firstToken, secondToken, loaded,
        tempImages: [...tempImages],
        memoryImages: Object.keys(imagesDb)
      };
    } finally {
      readFileAsDataURL = originalRead;
    }
  });

  expect(result.firstToken).not.toBe(result.secondToken);
  expect(result.loaded).toBeNull();
  expect(result.tempImages).toEqual([]);
  expect(result.memoryImages).toEqual([]);
});

test('runtime cache clearing waits for in-flight app writes and blocks later writes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const uid = 'e7000000-0000-4000-8000-000000000007';
    await openImageDB();
    await CloudSync.activateUser(uid);
    const realImageStore = imageStore;
    let request;
    imageStore = {
      transaction() {
        return { objectStore: () => ({ put: () => (request = {}) }) };
      }
    };
    const inFlight = idbPut('late-photo', 'data:image/png;base64,bGF0ZQ==').then(
      () => ({ ok: true }),
      error => ({ ok: false, message: error.message })
    );
    while (!request) await new Promise(resolve => setTimeout(resolve, 0));
    let clearSettled = false;
    const clearing = CloudSync.clearRuntimeCaches().then(value => { clearSettled = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 30));
    const waited = !clearSettled;
    request.onsuccess();
    const writeResult = await inFlight;
    const clearResult = await clearing;
    imageStore = realImageStore;
    let blockedMessage = '';
    try { await idbPut('after-signout', 'data:image/png;base64,YmxvY2tlZA=='); }
    catch (error) { blockedMessage = error.message; }
    return { waited, writeResult, clearResult, blockedMessage, blocked: CloudSync._runtimeWritesBlocked };
  });

  expect(result.waited).toBe(true);
  expect(result.writeResult.ok).toBe(false);
  expect(result.clearResult.ok).toBe(true);
  expect(result.blocked).toBe(true);
  expect(result.blockedMessage).toContain('paused');
});

test('reminders, dashboard alerts, and highlights are native keyboard controls', async ({ page }) => {
  await page.evaluate(() => {
    db = {
      version: 3, encrypted: false, backups: [], settings: {}, auditTrail: [], valueHistory: [],
      firearms: [{
        id: 'alert-firearm', make: 'Example', model: 'Carbine', serial: 'ONE', caliber: '5.56',
        type: 'Rifle', condition: 'New', status: 'Active', price: '1200', images: [], tags: [],
        documents: [], customFields: [], maintenanceLog: [], isNFA: true, nfaType: 'SBR',
        stampStatus: 'Pending', dateSubmitted: '2026-01-01'
      }],
      ammo: [],
      accessories: [], wishlist: [], dealers: []
    };
    _dashboardChartLoadStarted = true;
    openReminders();
    renderDashboard();
  });

  for (const selector of ['.reminder-item', '.dash-alert', '.dash-highlight']) {
    const control = page.locator(selector).first();
    await expect(control).toHaveJSProperty('tagName', 'BUTTON');
    await expect(control).toHaveAttribute('type', 'button');
  }

  const reminder = page.locator('.reminder-item').first();
  await reminder.focus();
  await reminder.press('Enter');
  await expect(page.locator('#detailView')).toHaveClass(/open/);
});

test('concurrent form saves create only one record', async ({ page }) => {
  const result = await page.evaluate(async () => {
    db = {
      version: 3, encrypted: false, backups: [], settings: {},
      auditTrail: [], valueHistory: [], firearms: [], ammo: [],
      accessories: [], wishlist: [], dealers: []
    };
    openWishlistModal();
    document.getElementById('wMake').value = 'Example Arms';
    document.getElementById('wModel').value = 'One Record';

    const originalSave = saveData;
    let releaseSave;
    const saveGate = new Promise(resolve => { releaseSave = resolve; });
    let durableCalls = 0;
    saveData = async () => {
      durableCalls++;
      await saveGate;
      return true;
    };

    try {
      const first = saveWishlistItem();
      while (durableCalls < 1) await new Promise(resolve => setTimeout(resolve, 0));
      const second = saveWishlistItem();
      await new Promise(resolve => setTimeout(resolve, 20));
      const button = document.getElementById('saveWishlistBtn');
      const whileSaving = {
        records: db.wishlist.length,
        durableCalls,
        disabled: button.disabled,
        label: button.textContent
      };
      releaseSave();
      const results = await Promise.all([first, second]);
      return {
        whileSaving, results,
        records: db.wishlist.length,
        durableCalls,
        creates: db.auditTrail.filter(entry => entry.action === 'create' && entry.itemType === 'wishlist').length,
        buttonDisabledAfter: button.disabled
      };
    } finally {
      releaseSave();
      saveData = originalSave;
    }
  });

  expect(result.whileSaving.records).toBe(1);
  expect(result.whileSaving.durableCalls).toBe(1);
  expect(result.whileSaving.disabled).toBe(true);
  expect(result.whileSaving.label).toMatch(/Saving/);
  expect(result.results[1]).toBe(false);
  expect(result.records).toBe(1);
  expect(result.durableCalls).toBe(1);
  expect(result.creates).toBe(1);
  expect(result.buttonDisabledAfter).toBe(false);
});

test('a save in one form blocks another form save and prevents closing the in-flight form', async ({ page }) => {
  const result = await page.evaluate(async () => {
    db = {
      version: 3, encrypted: false, backups: [], settings: {},
      auditTrail: [], valueHistory: [], firearms: [], ammo: [],
      accessories: [], wishlist: [], dealers: []
    };
    openWishlistModal();
    document.getElementById('wMake').value = 'Queued Arms';
    document.getElementById('wModel').value = 'First';

    const originalSave = saveData;
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    let durableCalls = 0;
    saveData = async () => {
      durableCalls++;
      if (durableCalls === 1) await firstGate;
      return true;
    };

    try {
      const first = saveWishlistItem();
      while (durableCalls < 1) await new Promise(resolve => setTimeout(resolve, 0));
      const closeWhileSaving = await ModalAccessibility.requestClose(document.getElementById('wishlistModal'));

      openDealerModal();
      document.getElementById('dName').value = 'Later Dealer';
      const blockedDealerSave = await saveDealer();
      const beforeRelease = {
        wishlistOpen: document.getElementById('wishlistModal').classList.contains('open'),
        dealerRecords: db.dealers.length,
        durableCalls
      };

      releaseFirst();
      const firstSaved = await first;
      const dealerSaved = await saveDealer();
      return {
        closeWhileSaving, blockedDealerSave, beforeRelease,
        firstSaved, dealerSaved, durableCalls,
        wishlistRecords: db.wishlist.length,
        dealerRecords: db.dealers.length
      };
    } finally {
      releaseFirst();
      saveData = originalSave;
    }
  });

  expect(result.closeWhileSaving).toBe(false);
  expect(result.blockedDealerSave).toBe(false);
  expect(result.beforeRelease.wishlistOpen).toBe(true);
  expect(result.beforeRelease.dealerRecords).toBe(0);
  expect(result.beforeRelease.durableCalls).toBe(1);
  expect(result.firstSaved).toBe(true);
  expect(result.dealerSaved).toBe(true);
  expect(result.durableCalls).toBe(2);
  expect(result.wishlistRecords).toBe(1);
  expect(result.dealerRecords).toBe(1);
});

test('a clean draft modal cannot close while its save is still in flight', async ({ page }) => {
  const result = await page.evaluate(async () => {
    db = {
      version: 3, encrypted: false, backups: [], settings: {},
      auditTrail: [], valueHistory: [], firearms: [], ammo: [],
      accessories: [], wishlist: [], dealers: []
    };
    await openAddModal();
    document.getElementById('fMake').value = 'Draft Safe';
    document.getElementById('fModel').value = 'Close Guard';
    const modal = document.getElementById('formModal');
    modal.dataset.dirty = 'false';

    const originalSave = saveData;
    let releaseSave;
    saveData = () => new Promise(resolve => { releaseSave = () => resolve(false); });
    try {
      const pending = saveFirearm();
      while (!releaseSave) await new Promise(resolve => setTimeout(resolve, 0));
      modal.querySelector('.modal-close').click();
      await new Promise(resolve => setTimeout(resolve, 20));
      const whileSaving = {
        open: modal.classList.contains('open'),
        saving: modal.dataset.saving,
        make: document.getElementById('fMake').value
      };
      releaseSave();
      const saved = await pending;
      return {
        whileSaving, saved,
        openAfterFailure: modal.classList.contains('open'),
        dirtyAfterFailure: modal.dataset.dirty,
        makeAfterFailure: document.getElementById('fMake').value,
        records: db.firearms.length
      };
    } finally {
      if (releaseSave) releaseSave();
      saveData = originalSave;
    }
  });

  expect(result.whileSaving.open).toBe(true);
  expect(result.whileSaving.saving).toBe('true');
  expect(result.whileSaving.make).toBe('Draft Safe');
  expect(result.saved).toBe(false);
  expect(result.openAfterFailure).toBe(true);
  expect(result.dirtyAfterFailure).toBe('true');
  expect(result.makeAfterFailure).toBe('Draft Safe');
  expect(result.records).toBe(0);
});

test('a delayed failed form save never rolls back a newer database mutation', async ({ page }) => {
  const result = await page.evaluate(async () => {
    db = {
      version: 3, encrypted: false, backups: [], settings: {},
      auditTrail: [], valueHistory: [], firearms: [], ammo: [],
      accessories: [], wishlist: [], dealers: []
    };
    openWishlistModal();
    document.getElementById('wMake').value = 'Pending Arms';
    document.getElementById('wModel').value = 'Unconfirmed';

    const originalSave = saveData;
    let releaseSave;
    saveData = () => new Promise(resolve => { releaseSave = () => resolve(false); });
    try {
      const pending = saveWishlistItem();
      while (!releaseSave) await new Promise(resolve => setTimeout(resolve, 0));
      db.dealers.push({ id: 'newer-dealer', name: 'Preserved Dealer' });
      releaseSave();
      const saved = await pending;
      return {
        saved,
        wishlistIds: db.wishlist.map(item => item.id),
        dealerIds: db.dealers.map(item => item.id),
        open: document.getElementById('wishlistModal').classList.contains('open'),
        dirty: document.getElementById('wishlistModal').dataset.dirty
      };
    } finally {
      if (releaseSave) releaseSave();
      saveData = originalSave;
    }
  });

  expect(result.saved).toBe(false);
  expect(result.wishlistIds).toHaveLength(1);
  expect(result.dealerIds).toEqual(['newer-dealer']);
  expect(result.open).toBe(true);
  expect(result.dirty).toBe('true');
});

test('beforeunload blocks an open dirty form even when global data is clean', async ({ page }) => {
  await page.evaluate(() => {
    hasUnsavedChanges = false;
    openWishlistModal();
  });
  await expect(page.locator('#wishlistModal')).toHaveAttribute('data-dirty', 'false');
  await page.locator('#wMake').fill('Unsaved manufacturer');
  await expect(page.locator('#wishlistModal')).toHaveAttribute('data-dirty', 'true');

  const result = await page.evaluate(() => {
    hasUnsavedChanges = false;
    const event = new Event('beforeunload', { cancelable: true });
    const dispatchResult = window.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, dispatchResult };
  });
  expect(result.defaultPrevented).toBe(true);
  expect(result.dispatchResult).toBe(false);
});

test('removing ammo and accessory receipts marks their forms dirty', async ({ page }) => {
  await page.evaluate(() => {
    db = {
      version: 3, encrypted: false, backups: [], settings: {}, auditTrail: [], valueHistory: [],
      firearms: [],
      ammo: [{ id: 'ammo-receipt', caliber: '9mm', brand: 'Example', receipt: 'data:application/pdf;base64,YW1tbw==', receiptName: 'ammo.pdf' }],
      accessories: [{ id: 'accessory-receipt', name: 'Example optic', category: 'Optic', condition: 'New', receipt: 'data:application/pdf;base64,YWNj', receiptName: 'accessory.pdf' }],
      wishlist: [], dealers: []
    };
    editAmmo('ammo-receipt');
  });

  await expect(page.locator('#ammoModal')).toHaveAttribute('data-dirty', 'false');
  await page.locator('#aReceiptRemove').click();
  await expect(page.locator('#ammoModal')).toHaveAttribute('data-dirty', 'true');
  expect(await page.evaluate(() => tempReceipts.a)).toBeNull();

  await page.evaluate(() => {
    closeAmmoModal();
    openAccessoryModal('accessory-receipt');
  });
  await expect(page.locator('#accessoryModal')).toHaveAttribute('data-dirty', 'false');
  await page.locator('#accReceiptRemove').click();
  await expect(page.locator('#accessoryModal')).toHaveAttribute('data-dirty', 'true');
  expect(await page.evaluate(() => tempReceipts.acc)).toBeNull();
});
