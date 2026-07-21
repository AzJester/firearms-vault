import { test, expect } from '@playwright/test';

async function loadSafetyRuntime(page) {
  await page.goto('/robots.txt');
  await page.addScriptTag({ url: '/js/security.js' });
  await page.addScriptTag({ url: '/js/data-safety.js' });
}

async function loadBackupRuntime(page) {
  await loadSafetyRuntime(page);
  await page.evaluate(() => {
    if (typeof window.showDirectoryPicker !== 'function') window.showDirectoryPicker = async () => null;
  });
  await page.addScriptTag({ url: '/js/backup-vault.js' });
}

test('v2 artifact is independently recoverable and rejects wrong keys or changed bytes', async ({ page }) => {
  await loadSafetyRuntime(page);
  const result = await page.evaluate(async () => {
    const uid = 'b1000000-0000-4000-8000-000000000001';
    const namespace = 'independent-weekly-backup';
    const password = 'river-cobalt-canyon-lantern';
    const data = {
      version: 3,
      firearms: [{ id: 'record-1', make: 'Example', model: 'Recovery' }],
      ammo: [], accessories: [], wishlist: [], dealers: [], backups: [],
      settings: {}, auditTrail: [], valueHistory: []
    };
    await VaultDataSafety.clearState(uid);
    const provisioned = await VaultDataSafety.provisionArtifactKey(uid, namespace, password);
    const payload = { format: 'firearms-vault-backup-payload', formatVersion: 2, data };
    const options = {
      format: 'firearms-vault-backup', artifactType: 'independent-weekly-backup',
      createdAt: '2026-07-21T12:00:00.000Z', schemaVersion: 3,
      accountTag: '0123456789abcdefabcd', metadata: { mediaCount: 0 }
    };
    const first = await VaultDataSafety.encryptArtifact(uid, namespace, payload, options);
    const second = await VaultDataSafety.encryptArtifact(uid, namespace, payload, options);
    const local = await VaultDataSafety.decryptArtifact(first, { uid, namespace });
    const keyBeforeDelete = await VaultDataSafety.getArtifactKey(uid, namespace);
    await VaultDataSafety.deleteArtifactKey(uid, namespace);
    const imported = await VaultDataSafety.importEnvelope(first, password);

    let wrongPassword = '';
    try { await VaultDataSafety.importEnvelope(first, 'wrong-password-for-recovery'); }
    catch (error) { wrongPassword = error.message; }

    const changed = structuredClone(first);
    const bytes = Uint8Array.from(atob(changed.ciphertext), character => character.charCodeAt(0));
    bytes[0] ^= 1;
    changed.ciphertext = btoa(String.fromCharCode(...bytes));
    let tampered = '';
    try { await VaultDataSafety.importEnvelope(changed, password); }
    catch (error) { tampered = error.message; }

    return {
      formatVersion: first.formatVersion,
      encrypted: first.encrypted,
      differentIv: first.iv !== second.iv,
      differentCiphertext: first.ciphertext !== second.ciphertext,
      keyExtractable: provisioned.cryptoKey.extractable,
      storedKeyExtractable: keyBeforeDelete.cryptoKey.extractable,
      localModel: local.value.data.firearms[0].model,
      importedModel: imported.data.firearms[0].model,
      embeddedWrap: !!(first.keyWrap && first.keyWrap.ciphertext),
      wrongPassword,
      tampered
    };
  });

  expect(result).toMatchObject({
    formatVersion: 2,
    encrypted: true,
    differentIv: true,
    differentCiphertext: true,
    keyExtractable: false,
    storedKeyExtractable: false,
    localModel: 'Recovery',
    importedModel: 'Recovery',
    embeddedWrap: true
  });
  expect(result.wrongPassword).toMatch(/incorrect|damaged/i);
  expect(result.tampered).toMatch(/damaged|integrity|incorrect/i);
});

test('weekly directory backup verifies restore, retains two owned files, and preserves unrelated files', async ({ page }) => {
  await loadBackupRuntime(page);
  const result = await page.evaluate(async () => {
    const uid = 'b2000000-0000-4000-8000-000000000002';
    const password = 'granite-orchid-compass-sunrise';
    await VaultDataSafety.clearState(uid);
    window.imagesDb = { photo1: 'data:image/png;base64,cGhvdG8=' };
    window.db = {
      version: 3, encrypted: false, backups: [{ reason: 'not-recursive' }],
      settings: { theme: 'dark' }, auditTrail: [], valueHistory: [],
      firearms: [{
        id: 'firearm1', make: 'Example', model: 'Complete', images: ['photo1'],
        receipt: 'data:application/pdf;base64,cmVjZWlwdA==',
        stampPdf: 'data:application/pdf;base64,c3RhbXA=',
        documents: [{ id: 'doc1', name: 'Document', data: 'data:application/pdf;base64,ZG9j' }]
      }],
      ammo: [{ id: 'ammo1', receipt: 'data:image/png;base64,YW1tbw==' }],
      accessories: [{ id: 'accessory1', receipt: 'data:image/png;base64,YWNj' }],
      wishlist: [], dealers: []
    };
    window.CloudSync = {
      uid,
      revision: 14,
      residentMedia(key) {
        if (!String(key).includes(':')) return window.imagesDb[key] || null;
        const parts = String(key).split(':');
        if (parts[0] === 'doc') {
          const firearm = window.db.firearms.find(item => item.id === parts[1]);
          const document = firearm && firearm.documents.find(item => item.id === parts.slice(2).join(':'));
          return document && document.data || null;
        }
        const records = parts[1] === 'firearm' ? window.db.firearms
          : parts[1] === 'ammo' ? window.db.ammo : window.db.accessories;
        const record = records.find(item => item.id === parts.slice(2).join(':'));
        return record && (parts[0] === 'stamp' ? record.stampPdf : record.receipt) || null;
      }
    };
    window.waitForActiveFormSave = async () => ({ ok: true, active: false });
    window.flushPendingVaultOperations = async () => true;
    window.ensureReferencedMediaReady = async () => ({ ok: true, missing: [] });

    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('backup-vault-' + crypto.randomUUID(), { create: true });
    const note = await directory.getFileHandle('notes.txt', { create: true });
    const noteWriter = await note.createWritable();
    await noteWriter.write('do not delete');
    await noteWriter.close();

    const configured = await IndependentBackupVault.setup({
      uid, password, confirmPassword: password, retention: 2,
      directoryHandle: directory, runInitial: false
    });
    const config = await VaultDataSafety.getMetadata(uid, IndependentBackupVault.configName);
    const lookalikeName = 'firearms-vault-' + config.installationTag + '-weekly-2000-01-01T00-00-00-000Z-outsider.fvbackup';
    const lookalike = await directory.getFileHandle(lookalikeName, { create: true });
    const lookalikeWriter = await lookalike.createWritable();
    await lookalikeWriter.write('not created by the vault ledger');
    await lookalikeWriter.close();
    const runs = [];
    for (const now of ['2026-07-01T12:00:00.000Z', '2026-07-08T12:00:00.000Z', '2026-07-15T12:00:00.000Z']) {
      runs.push(await IndependentBackupVault.runNow({ uid, manual: true, force: true, now }));
    }

    const names = [];
    for await (const [name] of directory.entries()) names.push(name);
    names.sort();
    const backups = names.filter(name => name.endsWith('.fvbackup'));
    const vaultBackups = backups.filter(name => name !== lookalikeName);
    const newestHandle = await directory.getFileHandle(vaultBackups.at(-1));
    const newestEnvelope = JSON.parse(await (await newestHandle.getFile()).text());
    await VaultDataSafety.deleteArtifactKey(uid, IndependentBackupVault.namespace);
    const restored = await VaultDataSafety.importEnvelope(newestEnvelope, password);
    const beforeDisable = await IndependentBackupVault.status({ uid });
    const disabled = await IndependentBackupVault.disable({ uid });
    const namesAfterDisable = [];
    for await (const [name] of directory.entries()) namesAfterDisable.push(name);

    return {
      configured,
      runStatuses: runs.map(item => item.status),
      backupCount: vaultBackups.length,
      unrelatedPreserved: names.includes('notes.txt'),
      lookalikePreserved: names.includes(lookalikeName),
      restoredModel: restored.data.firearms[0].model,
      restoredPhoto: restored.data.images.photo1,
      restoredMediaCount: newestEnvelope.metadata.mediaCount,
      backupsExcluded: !Object.prototype.hasOwnProperty.call(restored.data, 'backups') || restored.data.backups.length === 0,
      lastVerifiedAt: beforeDisable.lastVerifiedAt,
      lastSuccessfulAt: beforeDisable.lastSuccessfulAt,
      limitation: beforeDisable.limitations.join(' '),
      disabled,
      externalFilesPreserved: vaultBackups.every(name => namesAfterDisable.includes(name)) && namesAfterDisable.includes(lookalikeName)
    };
  });

  expect(result.configured.status).toBe('configured');
  expect(result.runStatuses).toEqual(['saved', 'saved', 'saved']);
  expect(result.backupCount).toBe(2);
  expect(result.unrelatedPreserved).toBe(true);
  expect(result.lookalikePreserved).toBe(true);
  expect(result.restoredModel).toBe('Complete');
  expect(result.restoredPhoto).toContain('data:image/png');
  expect(result.restoredMediaCount).toBe(6);
  expect(result.backupsExcluded).toBe(true);
  expect(result.lastVerifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(result.lastSuccessfulAt).toBe('2026-07-15T12:00:00.000Z');
  expect(result.limitation).toMatch(/vault is open/i);
  expect(result.disabled).toMatchObject({ ok: true, externalFilesPreserved: true });
  expect(result.externalFilesPreserved).toBe(true);
});

test('missing referenced media blocks the file before any partial backup is written', async ({ page }) => {
  await loadBackupRuntime(page);
  const result = await page.evaluate(async () => {
    const uid = 'b3000000-0000-4000-8000-000000000003';
    const password = 'harbor-violet-keystone-forest';
    await VaultDataSafety.clearState(uid);
    window.imagesDb = {};
    window.db = {
      version: 3, encrypted: false, backups: [], settings: {}, auditTrail: [], valueHistory: [],
      firearms: [{ id: 'firearm1', make: 'Example', model: 'Missing', images: ['missing-photo'] }],
      ammo: [], accessories: [], wishlist: [], dealers: []
    };
    window.CloudSync = { uid, revision: 1, residentMedia: () => null };
    window.waitForActiveFormSave = async () => ({ ok: true, active: false });
    window.flushPendingVaultOperations = async () => true;
    window.ensureReferencedMediaReady = async () => ({ ok: false, missing: ['missing-photo'] });
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('backup-vault-missing-' + crypto.randomUUID(), { create: true });
    await IndependentBackupVault.setup({ uid, password, directoryHandle: directory, runInitial: false });
    const run = await IndependentBackupVault.runNow({ uid, manual: true, force: true });
    const names = [];
    for await (const [name] of directory.entries()) names.push(name);
    return { run: { ok: run.ok, status: run.status, message: run.message }, names };
  });

  expect(result.run.ok).toBe(false);
  expect(result.run.status).toBe('failed');
  expect(result.run.message).toMatch(/unavailable|partial backup/i);
  expect(result.names.filter(name => name.endsWith('.fvbackup'))).toHaveLength(0);
});

test('existing downloaded-file restore accepts the independent v2 backup envelope', async ({ page }) => {
  await page.goto('/index.html');
  await expect.poll(() => page.evaluate(() => typeof window.restoreDownloadedBackup)).toBe('function');
  const password = 'meadow-copper-archive-starlight';
  const envelopeText = await page.evaluate(async password => {
    const uid = 'b4000000-0000-4000-8000-000000000004';
    const namespace = 'independent-weekly-backup';
    await VaultDataSafety.clearState(uid);
    await VaultDataSafety.provisionArtifactKey(uid, namespace, password);
    const data = {
      version: 3,
      firearms: [{ id: 'restored1', make: 'Verified', model: 'From v2', images: ['restored-photo'] }],
      images: { 'restored-photo': 'data:image/png;base64,cmVzdG9yZWQ=' },
      ammo: [], accessories: [], wishlist: [], dealers: [], backups: [],
      settings: {}, auditTrail: [], valueHistory: []
    };
    const envelope = await VaultDataSafety.encryptArtifact(uid, namespace, {
      format: 'firearms-vault-backup-payload', formatVersion: 2, data
    }, {
      format: 'firearms-vault-backup', artifactType: 'independent-weekly-backup',
      schemaVersion: 3, accountTag: 'fedcba9876543210fedc', metadata: { mediaCount: 1 }
    });
    await VaultDataSafety.deleteArtifactKey(uid, namespace);
    return JSON.stringify(envelope);
  }, password);

  await page.locator('#recoveryBackupFile').setInputFiles({
    name: 'independent-weekly.fvbackup',
    mimeType: 'application/json',
    buffer: Buffer.from(envelopeText)
  });
  const restored = await page.evaluate(async password => {
    CloudSync.uid = 'b4000000-0000-4000-8000-000000000004';
    document.getElementById('backupPassword').value = password;
    window.confirmDialog = async () => true;
    CloudSync.restoreFromFile = async file => {
      window.__restoredIndependentBackup = JSON.parse(await file.text());
      return { ok: true, cloud: { ok: true } };
    };
    await restoreDownloadedBackup();
    return window.__restoredIndependentBackup;
  }, password);

  expect(restored.firearms[0]).toMatchObject({ make: 'Verified', model: 'From v2' });
  expect(restored.images['restored-photo']).toContain('data:image/png');
});
