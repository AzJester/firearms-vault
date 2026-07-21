import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test.use({ serviceWorkers: 'block' });

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const receipt = 'data:application/pdf;base64,JVBERi0xLjQKJSByZWNvdmVyeSB0ZXN0Cg==';

async function showTestApp(page) {
  await page.evaluate(() => {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('firstRunPanel').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
  });
}

test('an edited firearm and its unsaved photo survive runtime clearing and a real page reload', async ({ page }) => {
  const uid = '11111111-1111-4111-8111-111111111111';
  await page.goto('/index.html');
  await showTestApp(page);

  const captured = await page.evaluate(async ({ uid, pixel }) => {
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uid);
    db = {
      version: 3, encrypted: false,
      firearms: [{
        id: 'firearm-one', make: 'Original', model: 'Cloud model', serial: 'A1',
        type: 'Rifle', condition: 'New', status: 'Active', images: [], tags: [],
        documents: [], customFields: [], maintenanceLog: []
      }],
      ammo: [], accessories: [], wishlist: [], dealers: [], backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    imagesDb = {};
    openEditModal('firearm-one');
    document.getElementById('fModel').value = 'Recovered local model';
    document.getElementById('fNotes').innerHTML = '<b>Recovered note</b><img src=x onerror="window.__recoveryPwned=1">';
    imagesDb['edit-only-photo'] = pixel;
    await idbPut('edit-only-photo', pixel);
    tempImages = ['edit-only-photo'];
    _firearmDraftOwnedImages.add('edit-only-photo');
    renderImageGallery();
    const modal = document.getElementById('formModal');
    modal.dataset.dirty = 'true';

    const result = await window.preserveOpenDirtyFormSession(uid);
    const key = window.openFormRecoveryKey(uid);
    const stored = await CloudSync.storeGet('meta', key);
    await CloudSync.deactivateUser({ clearRuntime: true });
    return { result, storedUid: stored && stored.uid, innerUid: stored && stored.value && stored.value.uid };
  }, { uid, pixel });

  expect(captured.result).toMatchObject({ ok: true, captured: true, attachmentsComplete: true });
  expect(captured.storedUid).toBe(uid);
  expect(captured.innerUid).toBe(uid);

  await page.reload();
  const restored = await page.evaluate(async uid => {
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uid);
    db = {
      version: 3, encrypted: false,
      firearms: [{
        id: 'firearm-one', make: 'Original', model: 'Newer cloud model', serial: 'A1',
        type: 'Rifle', condition: 'New', status: 'Active', images: [], tags: [],
        documents: [], customFields: [], maintenanceLog: []
      }],
      ammo: [], accessories: [], wishlist: [], dealers: [], backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    imagesDb = {};
    const result = await window.restoreOpenDirtyFormSession(uid);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      result,
      editingId,
      model: document.getElementById('fModel').value,
      notes: document.getElementById('fNotes').innerHTML,
      dirty: document.getElementById('formModal').dataset.dirty,
      open: document.getElementById('formModal').classList.contains('open'),
      tempImages: [...tempImages],
      owned: [..._firearmDraftOwnedImages],
      photo: imagesDb['edit-only-photo'],
      remaining: await window.hasOpenFormRecoveryForUser(uid),
      pwned: window.__recoveryPwned
    };
  }, uid);

  expect(restored.result).toMatchObject({ restored: true, restoredAsNew: false, retained: true });
  expect(restored.editingId).toBe('firearm-one');
  expect(restored.model).toBe('Recovered local model');
  expect(restored.notes).toContain('Recovered note');
  expect(restored.notes).not.toContain('<img');
  expect(restored.open).toBe(true);
  expect(restored.dirty).toBe('true');
  expect(restored.tempImages).toEqual(['edit-only-photo']);
  expect(restored.owned).toContain('edit-only-photo');
  expect(restored.photo).toBe(pixel);
  expect(restored.remaining).toBe(true);
  expect(restored.pwned).toBeUndefined();

  await page.evaluate(() => {
    const model = document.getElementById('fModel');
    model.value = 'Recovery copy refreshed';
    model.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(async () => page.evaluate(async uid => {
    const stored = await CloudSync.storeGet('meta', window.openFormRecoveryKey(uid));
    const control = stored && stored.value.controls.find(item => item.id === 'fModel');
    return control && control.value;
  }, uid)).toBe('Recovery copy refreshed');

  await page.evaluate(() => removeImage(0));
  await expect.poll(() => page.evaluate(async uid => {
    const stored = await CloudSync.storeGet('meta', window.openFormRecoveryKey(uid));
    return stored && stored.value.extras.images.length;
  }, uid)).toBe(0);

  const saved = await page.evaluate(async uid => {
    saveData = async () => true;
    const result = await saveFirearm();
    return {
      result,
      open: document.getElementById('formModal').classList.contains('open'),
      remaining: await window.hasOpenFormRecoveryForUser(uid),
      savedModel: db.firearms.find(item => item.id === 'firearm-one').model
    };
  }, uid);
  expect(saved).toEqual({ result: true, open: false, remaining: false, savedModel: 'Recovery copy refreshed' });
});

test('an ammunition receipt is recovered only for its owning account', async ({ page }) => {
  const uidA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const uidB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await page.goto('/index.html');
  await showTestApp(page);

  const result = await page.evaluate(async ({ uidA, uidB, receipt }) => {
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uidA);
    db = {
      version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    openAddAmmoModal();
    document.getElementById('aCaliber').value = '9mm recovery';
    document.getElementById('aNotes').innerHTML = '<i>same owner only</i>';
    tempReceipts.a = receipt;
    tempReceipts.aName = 'ammo-receipt.pdf';
    showReceiptInUploadArea('a', tempReceipts.a, tempReceipts.aName);
    document.getElementById('ammoModal').dataset.dirty = 'true';
    const captured = await window.preserveOpenDirtyFormSession(uidA);
    closeAmmoModal();

    await CloudSync.activateUser(uidB);
    const otherUser = await window.restoreOpenDirtyFormSession(uidB);
    const aStillSaved = await CloudSync.storeGet('meta', window.openFormRecoveryKey(uidA));

    await CloudSync.activateUser(uidA);
    const owner = await window.restoreOpenDirtyFormSession(uidA);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      captured,
      otherUser,
      aStillSaved: !!aStillSaved,
      owner,
      caliber: document.getElementById('aCaliber').value,
      notes: document.getElementById('aNotes').innerHTML,
      receipt: tempReceipts.a,
      receiptName: tempReceipts.aName,
      open: document.getElementById('ammoModal').classList.contains('open'),
      dirty: document.getElementById('ammoModal').dataset.dirty
    };
  }, { uidA, uidB, receipt });

  expect(result.captured.ok).toBe(true);
  expect(result.otherUser).toMatchObject({ restored: false, status: 'none' });
  expect(result.aStillSaved).toBe(true);
  expect(result.owner.restored).toBe(true);
  expect(result.caliber).toBe('9mm recovery');
  expect(result.notes).toContain('same owner only');
  expect(result.receipt).toBe(receipt);
  expect(result.receiptName).toBe('ammo-receipt.pdf');
  expect(result.open).toBe(true);
  expect(result.dirty).toBe('true');

  await page.evaluate(() => removeReceipt('a'));
  await expect.poll(() => page.evaluate(async uid => {
    const stored = await CloudSync.storeGet('meta', window.openFormRecoveryKey(uid));
    return stored && stored.value.extras.receipt;
  }, uidA)).toBeNull();

  const discarded = await page.evaluate(async uid => {
    confirmDialog = async () => true;
    const closed = await window.requestModalClose(document.getElementById('ammoModal'));
    return {
      closed,
      open: document.getElementById('ammoModal').classList.contains('open'),
      remaining: await window.hasOpenFormRecoveryForUser(uid)
    };
  }, uidA);
  expect(discarded).toEqual({ closed: true, open: false, remaining: false });
});

test('confirmed discard waits for an in-flight recovery refresh so a late write cannot resurrect it', async ({ page }) => {
  const uid = '44444444-4444-4444-8444-444444444444';
  await page.goto('/index.html');
  await showTestApp(page);

  await page.evaluate(async uid => {
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uid);
    db = {
      version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    openDealerModal();
    document.getElementById('dName').value = 'Recovered dealer';
    document.getElementById('dealerModal').dataset.dirty = 'true';
    await window.preserveOpenDirtyFormSession(uid);
    closeDealerModal();
    await window.restoreOpenDirtyFormSession(uid);

    const originalPut = CloudSync.storePut.bind(CloudSync);
    let release;
    window.__refreshGate = new Promise(resolve => { release = resolve; });
    window.__releaseRefresh = release;
    window.__refreshStarted = false;
    window.__originalRecoveryPut = originalPut;
    CloudSync.storePut = async (store, value) => {
      if (store === 'meta' && value && value.key === window.openFormRecoveryKey(uid) && !window.__refreshStarted) {
        window.__refreshStarted = true;
        await window.__refreshGate;
      }
      return originalPut(store, value);
    };
    const input = document.getElementById('dName');
    input.value = 'Newest recovered dealer';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, uid);

  await expect.poll(() => page.evaluate(() => window.__refreshStarted)).toBe(true);
  await page.evaluate(() => {
    confirmDialog = async () => true;
    window.__discardFinished = false;
    window.__discardPromise = window.requestModalClose(document.getElementById('dealerModal')).then(result => {
      window.__discardFinished = result;
      return result;
    });
  });
  await expect.poll(() => page.evaluate(() => window.__discardFinished)).toBe(false);
  await page.evaluate(() => window.__releaseRefresh());
  await expect.poll(() => page.evaluate(() => window.__discardFinished)).toBe(true);

  const result = await page.evaluate(async uid => {
    CloudSync.storePut = window.__originalRecoveryPut;
    return {
      open: document.getElementById('dealerModal').classList.contains('open'),
      remaining: await window.hasOpenFormRecoveryForUser(uid),
      stored: await CloudSync.storeGet('meta', window.openFormRecoveryKey(uid))
    };
  }, uid);
  expect(result).toEqual({ open: false, remaining: false, stored: null });
});

test('credential, security, and share dialogs are deliberately excluded from recovery', async ({ page }) => {
  const uid = '22222222-2222-4222-8222-222222222222';
  await page.goto('/index.html');
  await showTestApp(page);

  const result = await page.evaluate(async uid => {
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uid);
    const key = window.openFormRecoveryKey(uid);

    const settings = document.getElementById('settingsModal');
    settings.classList.add('open');
    settings.dataset.dirty = 'true';
    document.getElementById('acctNewPassword').value = 'never-persist-this-password';
    const settingsResult = await window.preserveOpenDirtyFormSession(uid);
    settings.classList.remove('open');

    const share = document.getElementById('shareModal');
    share.classList.add('open');
    share.dataset.dirty = 'true';
    document.getElementById('shareCode').value = 'never-persist-this-passcode';
    const shareResult = await window.preserveOpenDirtyFormSession(uid);
    const stored = await CloudSync.storeGet('meta', key);
    let fallback = null;
    try { fallback = sessionStorage.getItem(key); } catch (_) {}
    return { settingsResult, shareResult, stored, fallback };
  }, uid);

  expect(result.settingsResult).toMatchObject({ ok: true, captured: false, status: 'no-open-form' });
  expect(result.shareResult).toMatchObject({ ok: true, captured: false, status: 'no-open-form' });
  expect(result.stored).toBeNull();
  expect(result.fallback).toBeNull();
});

test('forced SIGNED_OUT captures once, flushes, deactivates, and bypasses the dirty unload guard', async ({ page }) => {
  await page.route('**/vendor/supabase.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `window.supabase={createClient:function(){return {auth:{
      getSession:async function(){return {data:{session:null},error:null}},
      onAuthStateChange:function(callback){window.__authStateListener=callback;return {data:{subscription:{unsubscribe:function(){}}}}}
    }}}};`
  }));
  await page.goto('/index.html');
  await expect(page.locator('#authForm')).toBeVisible();

  await page.evaluate(() => {
    const record = step => {
      const current = JSON.parse(sessionStorage.getItem('forced-signout-order') || '[]');
      current.push(step);
      sessionStorage.setItem('forced-signout-order', JSON.stringify(current));
    };
    CloudSync.uid = 'forced-owner';
    document.getElementById('formModal').classList.add('open');
    document.getElementById('formModal').dataset.dirty = 'true';
    window.preserveOpenDirtyFormSession = async uid => { record('preserve:' + uid); return { ok: true }; };
    window.flushFirearmDraft = async () => { record('draft'); return true; };
    CloudSync.deactivateUser = async () => { record('deactivate'); return { ok: true }; };
    const allow = window.allowForcedPageTeardown;
    window.allowForcedPageTeardown = () => { record('allow-teardown'); allow(); };
  });

  const navigated = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.__authStateListener('SIGNED_OUT', null);
    window.__authStateListener('SIGNED_OUT', null);
  });
  await navigated;
  const order = await page.evaluate(() => JSON.parse(sessionStorage.getItem('forced-signout-order') || '[]'));
  expect(order).toEqual(['preserve:forced-owner', 'draft', 'deactivate', 'allow-teardown']);
});

test('forced SIGNED_OUT waits for an active Add save and does not recover the committed record as another Add', async ({ page }) => {
  await page.route('**/vendor/supabase.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `window.supabase={createClient:function(){return {auth:{
      getSession:async function(){return {data:{session:null},error:null}},
      onAuthStateChange:function(callback){window.__authStateListener=callback;return {data:{subscription:{unsubscribe:function(){}}}}}
    }}}};`
  }));
  await page.goto('/index.html');
  await expect(page.locator('#authForm')).toBeVisible();
  await showTestApp(page);

  await page.evaluate(async () => {
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser('active-save-owner');
    db = {
      version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    openAddAmmoModal();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.getElementById('aCaliber').value = '10mm committed once';
    document.getElementById('ammoModal').dataset.dirty = 'true';

    let release;
    window.__activeSaveGate = new Promise(resolve => { release = resolve; });
    window.__releaseActiveSave = release;
    saveData = async () => {
      await window.__activeSaveGate;
      sessionStorage.setItem('active-save-record-count', String(db.ammo.length));
      return true;
    };
    const preserve = window.preserveOpenDirtyFormSession;
    window.preserveOpenDirtyFormSession = async uid => {
      const result = await preserve(uid);
      sessionStorage.setItem('active-save-recovery-result', JSON.stringify(result));
      return result;
    };
    CloudSync.deactivateUser = async () => ({ ok: true });
    window.__activeSavePromise = saveAmmo();
    window.__authStateListener('SIGNED_OUT', null);
  });

  await expect.poll(() => page.evaluate(() => document.getElementById('ammoModal').dataset.saving)).toBe('true');
  const navigated = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.__releaseActiveSave());
  await navigated;

  const result = await page.evaluate(async () => {
    const recovery = JSON.parse(sessionStorage.getItem('active-save-recovery-result') || 'null');
    await CloudSync.openSyncDb();
    return {
      recordCount: Number(sessionStorage.getItem('active-save-record-count')),
      recovery,
      stored: await CloudSync.storeGet('meta', window.openFormRecoveryKey('active-save-owner'))
    };
  });
  expect(result.recordCount).toBe(1);
  expect(result.recovery).toMatchObject({ ok: true, captured: false, status: 'no-open-form' });
  expect(result.stored).toBeNull();
});

test('close buttons cannot dismiss a clean-looking form while its save is still running', async ({ page }) => {
  await page.goto('/index.html');
  await showTestApp(page);

  await page.evaluate(() => {
    db = {
      version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    openAddAmmoModal();
    const modal = document.getElementById('ammoModal');
    modal.dataset.dirty = 'false';
    modal.dataset.saving = 'true';
  });

  await page.locator('#ammoModal .modal-close').click();
  await expect(page.locator('#ammoModal')).toHaveClass(/\bopen\b/);
  await expect(page.locator('#toastHost')).toContainText('save is still finishing');

  await page.evaluate(() => { document.getElementById('ammoModal').dataset.saving = 'false'; });
  await page.locator('#ammoModal .modal-close').click();
  await expect(page.locator('#ammoModal')).not.toHaveClass(/\bopen\b/);
});

test('failed forced-sign-out capture keeps the dirty form and runtime intact without reloading', async ({ page }) => {
  await page.route('**/vendor/supabase.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `window.supabase={createClient:function(){return {auth:{
      getSession:async function(){return {data:{session:null},error:null}},
      onAuthStateChange:function(callback){window.__authStateListener=callback;return {data:{subscription:{unsubscribe:function(){}}}}}
    }}}};`
  }));
  await page.goto('/index.html');
  await expect(page.locator('#authForm')).toBeVisible();

  await page.evaluate(() => {
    window.__failedCaptureCalls = { preserve: 0, draft: 0, deactivate: 0, allow: 0 };
    CloudSync.uid = 'forced-owner';
    const modal = document.getElementById('ammoModal');
    modal.classList.add('open');
    modal.dataset.dirty = 'true';
    document.getElementById('aCaliber').value = 'must survive';
    window.preserveOpenDirtyFormSession = async () => {
      window.__failedCaptureCalls.preserve++;
      return { ok: false, status: 'failed' };
    };
    window.flushFirearmDraft = async () => { window.__failedCaptureCalls.draft++; return true; };
    CloudSync.deactivateUser = async () => { window.__failedCaptureCalls.deactivate++; return { ok: true }; };
    window.allowForcedPageTeardown = () => { window.__failedCaptureCalls.allow++; };
    window.__authStateListener('SIGNED_OUT', null);
  });

  await expect.poll(() => page.evaluate(() => window.__failedCaptureCalls && window.__failedCaptureCalls.preserve)).toBe(1);
  await expect(page.locator('#authError')).toContainText('Keep this tab open and sign back in to the same account');
  await expect.poll(() => page.evaluate(() => document.getElementById('ammoModal').dataset.dirty)).toBe('true');
  const first = await page.evaluate(() => ({
    calls: window.__failedCaptureCalls,
    uid: CloudSync.uid,
    open: document.getElementById('ammoModal').classList.contains('open'),
    dirty: document.getElementById('ammoModal').dataset.dirty,
    caliber: document.getElementById('aCaliber').value,
    unloadSuppressed: suppressUnsavedUnloadWarning
  }));
  expect(first).toEqual({
    calls: { preserve: 1, draft: 0, deactivate: 0, allow: 0 },
    uid: 'forced-owner', open: true, dirty: 'true', caliber: 'must survive', unloadSuppressed: false
  });

  // The failure releases the in-progress guard so a later auth event can retry.
  await page.evaluate(() => window.__authStateListener('SIGNED_OUT', null));
  await expect.poll(() => page.evaluate(() => window.__failedCaptureCalls.preserve)).toBe(2);
  expect(await page.evaluate(() => window.__failedCaptureCalls)).toEqual({ preserve: 2, draft: 0, deactivate: 0, allow: 0 });
});

test('forced SIGNED_OUT fails closed while a photo or document recovery read is incomplete', async ({ page }) => {
  await page.route('**/vendor/supabase.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `window.supabase={createClient:function(){return {auth:{
      getSession:async function(){return {data:{session:null},error:null}},
      onAuthStateChange:function(callback){window.__authStateListener=callback;return {data:{subscription:{unsubscribe:function(){}}}}}
    }}}};`
  }));
  await page.goto('/index.html');
  await expect(page.locator('#authForm')).toBeVisible();
  await showTestApp(page);

  await page.evaluate(async () => {
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser('attachment-owner');
    await openAddModal();
    const modal = document.getElementById('formModal');
    modal.dataset.dirty = 'true';
    document.getElementById('fMake').value = 'Attachment must survive';
    window.waitForRecoveryAttachments = async () => ({ complete: false, ok: false });
    window.__attachmentSignOut = { deactivate: 0, allow: 0 };
    CloudSync.deactivateUser = async () => {
      window.__attachmentSignOut.deactivate++;
      return { ok: true };
    };
    window.allowForcedPageTeardown = () => { window.__attachmentSignOut.allow++; };
    window.__authStateListener('SIGNED_OUT', null);
  });

  await expect(page.locator('#authError')).toContainText('unfinished form could not be saved');
  await expect.poll(() => page.evaluate(() => document.getElementById('formModal').dataset.dirty)).toBe('true');
  const result = await page.evaluate(async () => {
    const key = window.openFormRecoveryKey('attachment-owner');
    const stored = await CloudSync.storeGet('meta', key);
    return {
      calls: window.__attachmentSignOut,
      uid: CloudSync.uid,
      open: document.getElementById('formModal').classList.contains('open'),
      dirty: document.getElementById('formModal').dataset.dirty,
      make: document.getElementById('fMake').value,
      storedComplete: stored && stored.value && stored.value.attachmentsComplete,
      unloadSuppressed: suppressUnsavedUnloadWarning
    };
  });
  expect(result).toEqual({
    calls: { deactivate: 0, allow: 0 }, uid: 'attachment-owner', open: true,
    dirty: 'true', make: 'Attachment must survive', storedComplete: false,
    unloadSuppressed: false
  });
});

test('two tabs preserve and restore their own unfinished forms without overwriting a sibling', async ({ page, context }) => {
  const uid = '55555555-5555-4555-8555-555555555555';
  await page.goto('/index.html');
  await showTestApp(page);

  const firstCapture = await page.evaluate(async uid => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    await window.clearOpenFormRecoveryForUser(uid);
    db = { version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: [] };
    openAddAmmoModal();
    document.getElementById('aCaliber').value = 'Tab A 10mm';
    document.getElementById('ammoModal').dataset.dirty = 'true';
    const result = await window.preserveOpenDirtyFormSession(uid);
    return { result, key: window.openFormRecoveryKey(uid) };
  }, uid);
  const secondPromise = context.waitForEvent('page');
  await page.evaluate(() => window.open('/index.html', '_blank'));
  const second = await secondPromise;
  await second.waitForLoadState('domcontentloaded');
  await expect(second.locator('#authForm')).toBeVisible({ timeout: 15000 });
  await showTestApp(second);
  const secondCapture = await second.evaluate(async uid => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    db = { version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: [] };
    openDealerModal();
    document.getElementById('dName').value = 'Tab B Dealer';
    document.getElementById('dealerModal').dataset.dirty = 'true';
    const result = await window.preserveOpenDirtyFormSession(uid);
    const records = (await CloudSync.storeGetAll('meta')).filter(record =>
      record.uid === uid && String(record.key).startsWith('fv:open-form-recovery:' + uid + ':'));
    return { result, key: window.openFormRecoveryKey(uid), keys: records.map(record => record.key).sort() };
  }, uid);

  expect(firstCapture.result.ok).toBe(true);
  expect(secondCapture.result.ok).toBe(true);
  expect(secondCapture.key).not.toBe(firstCapture.key);
  expect(secondCapture.keys).toEqual([firstCapture.key, secondCapture.key].sort());

  await page.reload();
  await second.reload();
  const firstRestore = await page.evaluate(async uid => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    db = { version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: [] };
    const restored = await window.restoreOpenDirtyFormSession(uid);
    return { restored, value: document.getElementById('aCaliber').value,
      key: document.getElementById('ammoModal').dataset.recoveryKey };
  }, uid);
  const secondRestore = await second.evaluate(async uid => {
    await openImageDB(); await openStateDB(); await CloudSync.activateUser(uid);
    db = { version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: [] };
    const restored = await window.restoreOpenDirtyFormSession(uid);
    return { restored, value: document.getElementById('dName').value,
      key: document.getElementById('dealerModal').dataset.recoveryKey };
  }, uid);
  expect(firstRestore).toMatchObject({ restored: { restored: true, modalId: 'ammoModal' }, value: 'Tab A 10mm', key: firstCapture.key });
  expect(secondRestore).toMatchObject({ restored: { restored: true, modalId: 'dealerModal' }, value: 'Tab B Dealer', key: secondCapture.key });

  await page.evaluate(() => window.resolveRecoveredFormSession('ammoModal'));
  const remaining = await second.evaluate(async ({ uid, ownKey, removedKey }) => ({
    own: !!(await CloudSync.storeGet('meta', ownKey)),
    removed: !!(await CloudSync.storeGet('meta', removedKey)),
    any: await window.hasOpenFormRecoveryForUser(uid)
  }), { uid, ownKey: secondCapture.key, removedKey: firstCapture.key });
  expect(remaining).toEqual({ own: true, removed: false, any: true });
  await second.close();
});

test('forget-this-device cleanup includes and verifies unfinished form recovery', async ({ page }) => {
  const uid = '33333333-3333-4333-8333-333333333333';
  await page.goto('/index.html');
  const result = await page.evaluate(async uid => {
    await CloudSync.openSyncDb();
    const key = window.openFormRecoveryKey(uid);
    const snapshot = { version: 1, uid, savedAt: new Date().toISOString(), modalId: 'dealerModal', mode: 'add', recordId: null, controls: [], extras: {} };
    await CloudSync.storePut('meta', { key, uid, value: snapshot, updatedAt: snapshot.savedAt });
    sessionStorage.setItem(key, JSON.stringify(snapshot));
    const before = await window.hasOpenFormRecoveryForUser(uid);
    await window.clearOpenFormRecoveryForUser(uid);
    const after = await window.hasOpenFormRecoveryForUser(uid);
    return { before, after };
  }, uid);
  expect(result).toEqual({ before: true, after: false });

  const authSource = fs.readFileSync('js/auth.js', 'utf8');
  const appSource = fs.readFileSync('js/app.js', 'utf8');
  expect(authSource).toContain("attempt('unfinished form recovery'");
  expect(authSource).toContain('hasOpenFormRecoveryForUser(uid)');
  for (const modalId of ['formModal', 'ammoModal', 'accessoryModal', 'maintenanceModal', 'wishlistModal', 'dealerModal']) {
    expect(appSource).toContain(`resolveRecoveredFormSession('${modalId}')`);
  }
  expect(appSource).toContain("el.dataset.recoveredForm === 'true' && !await resolveRecoveredFormSession(el.id)");
});
