// Independent, encrypted recovery files written to a user-chosen directory.
// This is deliberately best-effort scheduling: a browser page cannot promise
// an exact closed-browser weekly job or silently regain revoked folder access.
(function initIndependentBackupVault(global) {
  'use strict';

  const NAMESPACE = 'independent-weekly-backup';
  const CONFIG_NAME = 'independent-backup-config-v1';
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const DEFAULT_RETENTION = 12;
  const MIN_RETENTION = 2;
  const MAX_RETENTION = 52;
  const STATUS_RECHECK_MS = 30 * 60 * 1000;
  const FILE_PREFIX = 'firearms-vault-';
  const FILE_SUFFIX = '.fvbackup';
  let activeRun = null;
  let autoTimer = null;
  let eventTimer = null;
  let lastAutomaticWarning = { signature: '', at: 0 };

  function supportDetails() {
    const directoryPicker = typeof global.showDirectoryPicker === 'function';
    const webCrypto = !!(global.crypto && global.crypto.subtle);
    const indexedDBAvailable = !!global.indexedDB;
    const supported = directoryPicker && webCrypto && indexedDBAvailable;
    const limitations = [];
    if (!directoryPicker) {
      limitations.push('Automatic folder backups are unavailable in this browser. Use the manual encrypted download instead; directory automation currently requires a compatible Chromium browser.');
    }
    if (!webCrypto) limitations.push('This browser cannot create the required AES-256-GCM encrypted backup.');
    if (!indexedDBAvailable) limitations.push('This browser cannot retain the encrypted key and folder selection on this device.');
    if (supported) {
      limitations.push('Weekly backups run when the vault is open; browser scheduling cannot guarantee an exact time while every vault window is closed.');
      limitations.push('The browser may require folder permission again after all vault windows close or access is revoked.');
    }
    return { supported, directoryPicker, webCrypto, indexedDB: indexedDBAvailable, limitations };
  }

  function requireSafetyRuntime() {
    if (!global.VaultDataSafety || typeof global.VaultDataSafety.encryptArtifact !== 'function') {
      throw new Error('The independent backup safety module is unavailable.');
    }
    return global.VaultDataSafety;
  }

  function currentUid(required) {
    const value = String(global.CloudSync && global.CloudSync.uid || '').trim();
    if (required && !value) throw new Error('Sign in before configuring independent backups.');
    return value || null;
  }

  function retentionValue(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_RETENTION;
    return Math.max(MIN_RETENTION, Math.min(MAX_RETENTION, parsed));
  }

  function isoTime(value) {
    const date = value instanceof Date ? value : new Date(value == null ? Date.now() : value);
    if (!Number.isFinite(date.getTime())) throw new Error('Backup time is invalid.');
    return date.toISOString();
  }

  function installationTag() {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function safeTag(value) {
    const tag = String(value || '').toLowerCase();
    if (!/^[a-f0-9]{20}$/.test(tag)) throw new Error('Backup installation identity is invalid.');
    return tag;
  }

  function backupFilename(tag, createdAt) {
    const stamp = String(createdAt).replace(/[:.]/g, '-');
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return FILE_PREFIX + safeTag(tag) + '-weekly-' + stamp + '-' + nonce + FILE_SUFFIX;
  }

  function ownedFilename(config, name) {
    const prefix = FILE_PREFIX + safeTag(config.installationTag) + '-weekly-';
    return typeof name === 'string' && name.startsWith(prefix) && name.endsWith(FILE_SUFFIX) &&
      /^[A-Za-z0-9_.-]+$/.test(name);
  }

  async function getConfig(uid) {
    return requireSafetyRuntime().getMetadata(uid, CONFIG_NAME);
  }

  async function putConfig(uid, config) {
    config.updatedAt = new Date().toISOString();
    await requireSafetyRuntime().putMetadata(uid, CONFIG_NAME, config);
    return config;
  }

  async function permissionState(handle, request) {
    if (!handle || handle.kind !== 'directory') return 'missing';
    if (typeof handle.queryPermission !== 'function') return 'granted';
    let state;
    try { state = await handle.queryPermission({ mode: 'readwrite' }); }
    catch (_) { return 'unknown'; }
    if (state === 'prompt' && request && typeof handle.requestPermission === 'function') {
      try { state = await handle.requestPermission({ mode: 'readwrite' }); }
      catch (_) { state = 'denied'; }
    }
    return state || 'unknown';
  }

  function formatWhen(value) {
    if (!value) return 'Not yet';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unknown';
  }

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  }

  function setVisible(id, visible) {
    const element = document.getElementById(id);
    if (element) element.hidden = !visible;
  }

  function renderStatus(status) {
    const main = document.getElementById('independentBackupStatus');
    if (main) {
      main.dataset.state = status.state || '';
      main.textContent = status.message;
    }
    setText('independentBackupDirectory', status.directoryName || 'No folder connected');
    setText('independentBackupLastRun', formatWhen(status.lastSuccessfulAt));
    setText('independentBackupLastVerified', formatWhen(status.lastVerifiedAt));
    setText('independentBackupNextRun', status.nextDueAt ? formatWhen(status.nextDueAt) : (status.enabled && status.due ? 'Due now' : 'After setup'));
    setText('independentBackupRetentionStatus', status.retention ? String(status.retention) + ' weekly files' : 'Not configured');
    setText('independentBackupLimitations', (status.limitations || []).join(' '));
    setText('independentBackupError', status.lastError || '');
    setVisible('independentBackupRunBtn', !!status.enabled);
    setVisible('independentBackupReconnectBtn', !!status.enabled);
    setVisible('independentBackupDisableBtn', !!status.enabled);
    return status;
  }

  async function status(options) {
    const opts = options || {};
    const support = supportDetails();
    const uid = opts.uid || currentUid(false);
    if (!support.supported) {
      return renderStatus({
        ok: true, supported: false, enabled: false, state: 'unsupported',
        message: 'Automatic independent backups are unavailable in this browser.',
        limitations: support.limitations
      });
    }
    if (!uid) {
      return renderStatus({
        ok: true, supported: true, enabled: false, state: 'signed-out',
        message: 'Sign in to view this device\'s independent backup status.',
        limitations: support.limitations
      });
    }
    let config;
    try { config = await getConfig(uid); }
    catch (error) {
      return renderStatus({
        ok: false, supported: true, enabled: false, state: 'error',
        message: 'Independent backup settings could not be read.', lastError: error.message || String(error),
        limitations: support.limitations
      });
    }
    if (!config || config.enabled !== true) {
      return renderStatus({
        ok: true, supported: true, enabled: false, state: 'disabled',
        message: 'Independent weekly backup is not set up on this device.',
        limitations: support.limitations
      });
    }
    const keyRecord = await requireSafetyRuntime().getArtifactKey(uid, NAMESPACE).catch(() => null);
    const permission = await permissionState(config.directoryHandle, false);
    const last = Date.parse(String(config.lastSuccessfulAt || ''));
    const next = Number.isFinite(last) ? new Date(last + WEEK_MS).toISOString() : null;
    const due = !next || Date.now() >= Date.parse(next);
    let state = config.lastError ? 'warning' : due ? 'due' : 'protected';
    let message = config.lastError ? 'The latest independent backup needs attention.'
      : due ? 'Independent backup is due and will run while this vault is open.'
        : 'Independent weekly backup is current.';
    if (!keyRecord) {
      state = 'setup-required';
      message = 'Set up independent backup again because this device no longer has its encryption key.';
    } else if (permission !== 'granted') {
      state = 'reconnect';
      message = 'Reconnect the backup folder to continue automatic backups.';
    }
    return renderStatus({
      ok: true, supported: true, enabled: true, state, message, due,
      permission, directoryName: config.directoryHandle && config.directoryHandle.name,
      retention: retentionValue(config.retention), lastSuccessfulAt: config.lastSuccessfulAt || null,
      lastVerifiedAt: config.lastVerifiedAt || null, lastAttemptAt: config.lastAttemptAt || null,
      lastError: config.lastError || '', nextDueAt: next,
      verifiedFiles: Array.isArray(config.verifiedFiles) ? config.verifiedFiles.length : 0,
      keyAvailable: !!keyRecord,
      limitations: support.limitations
    });
  }

  function activeDatabase() {
    if (typeof db === 'undefined' || !db || typeof db !== 'object') throw new Error('The collection is not loaded yet.');
    return db;
  }

  function residentMedia(key) {
    const value = global.CloudSync && typeof global.CloudSync.residentMedia === 'function'
      ? global.CloudSync.residentMedia(String(key)) : null;
    return typeof value === 'string' && value.startsWith('data:') ? value : null;
  }

  function hydrateBackupMedia(snapshot) {
    snapshot.images = {};
    const keys = [];
    (snapshot.firearms || []).forEach((firearm) => {
      (firearm.images || []).forEach((imageId) => {
        const key = String(imageId);
        const data = residentMedia(key);
        if (!data) throw new Error('A referenced photo is unavailable on this device.');
        snapshot.images[key] = data;
        keys.push(key);
      });
      if (firearm.receipt) {
        const key = 'receipt:firearm:' + firearm.id;
        const data = residentMedia(key);
        if (!data) throw new Error('A firearm receipt is unavailable on this device.');
        firearm.receipt = data;
        keys.push(key);
      }
      if (firearm.stampPdf) {
        const key = 'stamp:firearm:' + firearm.id;
        const data = residentMedia(key);
        if (!data) throw new Error('A tax stamp is unavailable on this device.');
        firearm.stampPdf = data;
        keys.push(key);
      }
      (firearm.documents || []).forEach((documentRecord) => {
        const key = 'doc:' + firearm.id + ':' + documentRecord.id;
        const data = residentMedia(key);
        if (!data) throw new Error('A firearm document is unavailable on this device.');
        documentRecord.data = data;
        keys.push(key);
      });
    });
    (snapshot.ammo || []).forEach((record) => {
      if (!record.receipt) return;
      const key = 'receipt:ammo:' + record.id;
      const data = residentMedia(key);
      if (!data) throw new Error('An ammunition receipt is unavailable on this device.');
      record.receipt = data;
      keys.push(key);
    });
    (snapshot.accessories || []).forEach((record) => {
      (Array.isArray(record.images) ? record.images : []).forEach((imageId) => {
        const key = String(imageId);
        const data = residentMedia(key);
        if (!data) throw new Error('A referenced accessory photo is unavailable on this device.');
        snapshot.images[key] = data;
        keys.push(key);
      });
      if (record.receipt) {
        const key = 'receipt:accessory:' + record.id;
        const data = residentMedia(key);
        if (!data) throw new Error('An accessory receipt is unavailable on this device.');
        record.receipt = data;
        keys.push(key);
      }
    });
    return [...new Set(keys)].sort();
  }

  async function settleSnapshot(manual) {
    if (typeof global.waitForActiveFormSave === 'function') {
      const settled = await global.waitForActiveFormSave(12000);
      if (!settled || settled.ok !== true) throw new Error('A form save is still running. Keep the vault open and retry.');
    }
    if (document.querySelector('.modal-overlay.open[data-dirty="true"]:not(.app-dialog)')) {
      throw new Error('Save or discard the open form before creating the independent backup.');
    }
    if (typeof global.flushPendingVaultOperations === 'function') {
      const complete = await global.flushPendingVaultOperations();
      if (!complete) throw new Error('An attachment is still processing or failed to finish.');
    }
    if (typeof global.ensureReferencedMediaReady !== 'function') {
      throw new Error('Attachment verification is unavailable.');
    }
    const readiness = await global.ensureReferencedMediaReady({ retry: !!manual });
    if (!readiness || !readiness.ok) {
      const count = readiness && readiness.missing ? readiness.missing.length : 0;
      throw new Error((count || 'One or more') + ' referenced attachment' + (count === 1 ? ' is' : 's are') + ' unavailable. No partial backup was written.');
    }
    return readiness;
  }

  function buildSnapshot(createdAt) {
    const source = structuredClone(activeDatabase());
    delete source.backups;
    const mediaKeys = hydrateBackupMedia(source);
    const normalized = global.VaultSecurity
      ? global.VaultSecurity.normalizeDatabase(source, { regenerateInvalidIds: false, allowUnknownTopLevel: true }).data
      : source;
    return {
      data: normalized,
      mediaKeys,
      payload: {
        format: 'firearms-vault-backup-payload', formatVersion: 2,
        createdAt, schemaVersion: Number(normalized.version || 3), data: normalized
      }
    };
  }

  function collectionCounts(data) {
    const counts = {};
    ['firearms', 'ammo', 'accessories', 'wishlist', 'dealers'].forEach((name) => {
      counts[name] = Array.isArray(data && data[name]) ? data[name].length : 0;
    });
    return counts;
  }

  async function writeFile(directoryHandle, filename, text) {
    const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(text);
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch (_) {}
      throw error;
    }
    return fileHandle;
  }

  async function removeExactWrittenFile(directoryHandle, filename, expectedText) {
    try {
      const handle = await directoryHandle.getFileHandle(filename);
      const file = await handle.getFile();
      const [actual, expected] = await Promise.all([
        requireSafetyRuntime().digestText(await file.text()),
        requireSafetyRuntime().digestText(expectedText)
      ]);
      if (actual === expected) await directoryHandle.removeEntry(filename);
    } catch (_) {}
  }

  async function verifyWrittenFile(uid, config, fileHandle, expectedText, expectedSnapshotChecksum, expectedMediaCount) {
    const file = await fileHandle.getFile();
    const text = await file.text();
    const expectedFileChecksum = await requireSafetyRuntime().digestText(expectedText);
    const fileChecksum = await requireSafetyRuntime().digestText(text);
    if (fileChecksum !== expectedFileChecksum) throw new Error('The backup file did not match the bytes that were written.');
    let envelope;
    try { envelope = JSON.parse(text); }
    catch (_) { throw new Error('The backup file could not be read back as JSON.'); }
    if (envelope.accountTag !== config.installationTag || envelope.artifactType !== 'independent-weekly-backup') {
      throw new Error('The backup file identity could not be verified.');
    }
    const decrypted = await requireSafetyRuntime().decryptArtifact(envelope, { uid, namespace: NAMESPACE });
    const payload = decrypted.value;
    if (!payload || !payload.data) throw new Error('The backup file payload is incomplete.');
    const restoreCandidate = global.VaultSecurity
      ? global.VaultSecurity.normalizeDatabase(payload.data, {
        regenerateInvalidIds: false, allowUnknownTopLevel: true
      }).data
      : payload.data;
    const actualSnapshotChecksum = await requireSafetyRuntime().digestText(JSON.stringify(restoreCandidate));
    if (actualSnapshotChecksum !== expectedSnapshotChecksum) throw new Error('The restored collection checksum did not match the snapshot.');
    if (!envelope.metadata || envelope.metadata.snapshotChecksum !== expectedSnapshotChecksum) {
      throw new Error('The backup file restore checksum metadata did not match the snapshot.');
    }
    const mediaCount = hydrateBackupMediaCount(restoreCandidate);
    if (mediaCount !== expectedMediaCount) throw new Error('The backup attachment count did not match the verified snapshot.');
    if (Number(envelope.metadata.mediaCount) !== mediaCount) {
      throw new Error('The backup file restore attachment metadata did not match the snapshot.');
    }
    return { fileChecksum, size: file.size, counts: collectionCounts(restoreCandidate), mediaCount };
  }

  function hydrateBackupMediaCount(data) {
    let count = Object.keys(data && data.images || {}).length;
    (data && data.firearms || []).forEach((firearm) => {
      if (typeof firearm.receipt === 'string' && firearm.receipt.startsWith('data:')) count++;
      if (typeof firearm.stampPdf === 'string' && firearm.stampPdf.startsWith('data:')) count++;
      count += (firearm.documents || []).filter((item) => typeof item.data === 'string' && item.data.startsWith('data:')).length;
    });
    [...(data && data.ammo || []), ...(data && data.accessories || [])].forEach((record) => {
      if (typeof record.receipt === 'string' && record.receipt.startsWith('data:')) count++;
    });
    return count;
  }

  async function pruneRetention(config, newest) {
    const warnings = [];
    const ledger = [newest, ...(Array.isArray(config.verifiedFiles) ? config.verifiedFiles : [])]
      .filter((item, index, all) => item && item.name && all.findIndex((candidate) => candidate && candidate.name === item.name) === index)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const keep = retentionValue(config.retention);
    const retained = ledger.slice(0, keep);
    for (const expired of ledger.slice(keep)) {
      try {
        if (!expired.verified || !ownedFilename(config, expired.name) || !/^[a-f0-9]{64}$/i.test(expired.fileChecksum || '')) {
          retained.push(expired);
          warnings.push('An older file was retained because its ownership record was incomplete.');
          continue;
        }
        const handle = await config.directoryHandle.getFileHandle(expired.name);
        const file = await handle.getFile();
        const checksum = await requireSafetyRuntime().digestText(await file.text());
        if (checksum !== expired.fileChecksum) {
          retained.push(expired);
          warnings.push(expired.name + ' was retained because it changed outside the vault.');
          continue;
        }
        await config.directoryHandle.removeEntry(expired.name);
      } catch (error) {
        if (error && error.name === 'NotFoundError') continue;
        retained.push(expired);
        warnings.push(expired.name + ' could not be removed during retention cleanup.');
      }
    }
    config.verifiedFiles = retained.slice(0, 200);
    return warnings;
  }

  async function executeRun(uid, options) {
    const opts = options || {};
    const manual = !!opts.manual;
    const config = await getConfig(uid);
    if (!config || config.enabled !== true) return { ok: false, status: 'disabled', message: 'Independent backup is not configured.' };
    const permission = await permissionState(config.directoryHandle, manual);
    if (permission !== 'granted') {
      config.lastAttemptAt = new Date().toISOString();
      config.lastError = 'Backup folder permission is ' + permission + '. Reconnect the folder to continue.';
      await putConfig(uid, config);
      return { ok: false, status: 'reconnect-required', permission, requiresUserAction: true, message: config.lastError };
    }

    const last = Date.parse(String(config.lastSuccessfulAt || ''));
    if (!opts.force && Number.isFinite(last) && Date.now() < last + WEEK_MS) {
      return { ok: true, status: 'not-due', skipped: true, lastSuccessfulAt: config.lastSuccessfulAt };
    }

    const createdAt = isoTime(opts.now);
    config.lastAttemptAt = new Date().toISOString();
    config.lastError = '';
    await putConfig(uid, config);
    try {
      await settleSnapshot(manual);
      const snapshot = buildSnapshot(createdAt);
      const snapshotChecksum = await requireSafetyRuntime().digestText(JSON.stringify(snapshot.data));
      const counts = collectionCounts(snapshot.data);
      const envelope = await requireSafetyRuntime().encryptArtifact(uid, NAMESPACE, snapshot.payload, {
        format: 'firearms-vault-backup', artifactType: 'independent-weekly-backup',
        createdAt, schemaVersion: Number(snapshot.data.version || 3), accountTag: config.installationTag,
        metadata: {
          appVersion: typeof APP_VERSION === 'undefined' ? null : APP_VERSION,
          sourceRevision: Number(global.CloudSync && global.CloudSync.revision || 0),
          snapshotChecksum, mediaCount: snapshot.mediaKeys.length, counts
        }
      });
      const text = JSON.stringify(envelope, null, 2);
      const filename = backupFilename(config.installationTag, createdAt);
      let fileHandle;
      try { fileHandle = await writeFile(config.directoryHandle, filename, text); }
      catch (error) {
        try { await config.directoryHandle.removeEntry(filename); } catch (_) {}
        throw error;
      }
      let verified;
      try {
        verified = await verifyWrittenFile(uid, config, fileHandle, text, snapshotChecksum, snapshot.mediaKeys.length);
      } catch (error) {
        await removeExactWrittenFile(config.directoryHandle, filename, text);
        throw error;
      }
      const ledgerRecord = {
        name: filename, createdAt, verifiedAt: new Date().toISOString(), verified: true,
        fileChecksum: verified.fileChecksum, snapshotChecksum, size: verified.size,
        mediaCount: verified.mediaCount, counts: verified.counts
      };
      const warnings = await pruneRetention(config, ledgerRecord);
      config.lastSuccessfulAt = createdAt;
      config.lastVerifiedAt = ledgerRecord.verifiedAt;
      config.lastFilename = filename;
      config.lastError = '';
      config.lastWarnings = warnings;
      await putConfig(uid, config);
      return { ok: true, status: warnings.length ? 'saved-with-warnings' : 'saved', filename, createdAt, verified, warnings };
    } catch (error) {
      config.lastError = error && error.message ? error.message : String(error);
      config.lastWarnings = [];
      await putConfig(uid, config).catch(() => {});
      return { ok: false, status: 'failed', message: config.lastError, error };
    }
  }

  async function withCrossTabLock(uid, operation) {
    const locks = navigator.locks;
    if (!locks || typeof locks.request !== 'function') return operation();
    return locks.request('firearms-vault-independent-backup:' + uid, { mode: 'exclusive', ifAvailable: true }, (lock) => {
      if (!lock) return { ok: false, status: 'busy', message: 'Another vault tab is updating the independent backup.' };
      return operation();
    });
  }

  async function exclusiveOperation(uid, operation) {
    if (activeRun) return { ok: false, status: 'busy', message: 'An independent backup operation is already running in this tab.' };
    activeRun = withCrossTabLock(uid, operation);
    try { return await activeRun; }
    finally {
      activeRun = null;
      await status({ uid }).catch(() => {});
    }
  }

  async function runNow(options) {
    const opts = Object.assign({ manual: true, force: true }, options || {});
    const support = supportDetails();
    if (!support.supported) return { ok: false, status: 'unsupported', limitations: support.limitations, requiresManualDownload: true };
    const uid = opts.uid || currentUid(true);
    return exclusiveOperation(uid, () => executeRun(uid, opts));
  }

  async function setup(options) {
    const opts = options || {};
    const support = supportDetails();
    if (!support.supported) return { ok: false, status: 'unsupported', limitations: support.limitations, requiresManualDownload: true };
    const uid = opts.uid || currentUid(true);
    const password = String(opts.password || '');
    const confirmation = opts.confirmPassword == null ? password : String(opts.confirmPassword);
    if (password.length < 12) throw new Error('Use a recovery password with at least 12 characters.');
    if (password !== confirmation) throw new Error('Recovery passwords do not match.');
    const directoryHandle = opts.directoryHandle || await global.showDirectoryPicker({
      id: 'firearms-vault-independent-backup', mode: 'readwrite', startIn: 'documents'
    });
    const permission = await permissionState(directoryHandle, true);
    if (permission !== 'granted') return { ok: false, status: 'permission-denied', permission, requiresUserAction: true };
    return exclusiveOperation(uid, async () => {
      const previous = await getConfig(uid).catch(() => null);
      const previousKey = await requireSafetyRuntime().getArtifactKey(uid, NAMESPACE).catch(() => null);
      await requireSafetyRuntime().provisionArtifactKey(uid, NAMESPACE, password);
      const config = {
        version: 1, uid, enabled: true, directoryHandle,
        directoryName: directoryHandle.name || 'Backup folder',
        installationTag: previous && previous.installationTag ? previous.installationTag : installationTag(),
        retention: retentionValue(opts.retention == null ? previous && previous.retention : opts.retention),
        intervalMs: WEEK_MS, createdAt: previous && previous.createdAt || new Date().toISOString(),
        lastSuccessfulAt: previous && previous.lastSuccessfulAt || null,
        lastVerifiedAt: previous && previous.lastVerifiedAt || null,
        lastAttemptAt: null, lastError: '', lastWarnings: [],
        verifiedFiles: previous && Array.isArray(previous.verifiedFiles) ? previous.verifiedFiles : []
      };
      try { await putConfig(uid, config); }
      catch (error) {
        if (previousKey) {
          await requireSafetyRuntime().putMetadata(uid, 'artifact-key:' + NAMESPACE, previousKey).catch(() => {});
        } else {
          await requireSafetyRuntime().deleteArtifactKey(uid, NAMESPACE).catch(() => {});
        }
        throw error;
      }
      if (opts.runInitial === false) return { ok: true, status: 'configured', directoryName: config.directoryName };
      const initial = await executeRun(uid, { manual: true, force: true });
      return Object.assign({ configured: true, directoryName: config.directoryName }, initial);
    });
  }

  async function reconnect(options) {
    const opts = options || {};
    const support = supportDetails();
    if (!support.supported) return { ok: false, status: 'unsupported', limitations: support.limitations, requiresManualDownload: true };
    const uid = opts.uid || currentUid(true);
    const directoryHandle = opts.directoryHandle || await global.showDirectoryPicker({
      id: 'firearms-vault-independent-backup', mode: 'readwrite', startIn: 'documents'
    });
    const permission = await permissionState(directoryHandle, true);
    if (permission !== 'granted') return { ok: false, status: 'permission-denied', permission, requiresUserAction: true };
    return exclusiveOperation(uid, async () => {
      const config = await getConfig(uid);
      const key = await requireSafetyRuntime().getArtifactKey(uid, NAMESPACE);
      if (!config || !key) return { ok: false, status: 'setup-required', message: 'Set up encrypted independent backup again.' };
      config.directoryHandle = directoryHandle;
      config.directoryName = directoryHandle.name || 'Backup folder';
      config.lastError = '';
      await putConfig(uid, config);
      if (opts.runAfterReconnect === false) return { ok: true, status: 'reconnected', directoryName: config.directoryName };
      return executeRun(uid, { manual: true, force: true });
    });
  }

  async function disable(options) {
    const opts = options || {};
    const uid = opts.uid || currentUid(true);
    return exclusiveOperation(uid, async () => {
      await requireSafetyRuntime().deleteMetadata(uid, CONFIG_NAME);
      await requireSafetyRuntime().deleteArtifactKey(uid, NAMESPACE);
      return { ok: true, status: 'disabled', externalFilesPreserved: true };
    });
  }

  function inputValue(id) {
    const element = document.getElementById(id);
    return element ? element.value : '';
  }

  function notifyResult(result, successMessage) {
    if (!global.toast) return;
    if (result && result.ok) global.toast(successMessage || 'Independent backup updated.', 'success', 7000);
    else global.toast(result && (result.message || (result.limitations || []).join(' ')) || 'Independent backup could not be completed.', 'error', 9000);
  }

  async function setupFromUI() {
    try {
      const result = await setup({
        password: inputValue('independentBackupPassword'),
        confirmPassword: inputValue('independentBackupPasswordConfirm'),
        retention: inputValue('independentBackupRetention')
      });
      if (result && (result.ok || result.configured)) {
        const password = document.getElementById('independentBackupPassword');
        const confirmation = document.getElementById('independentBackupPasswordConfirm');
        if (password) password.value = '';
        if (confirmation) confirmation.value = '';
      }
      notifyResult(result, result.ok ? 'Independent encrypted weekly backup is set up.' : null);
      return result;
    } catch (error) {
      const result = { ok: false, status: 'failed', message: error.message || String(error) };
      notifyResult(result);
      return result;
    }
  }

  async function runFromUI() {
    const result = await runNow({ manual: true, force: true }).catch((error) => ({ ok: false, status: 'failed', message: error.message || String(error) }));
    notifyResult(result, result.ok ? 'Independent encrypted backup verified.' : null);
    return result;
  }

  async function reconnectFromUI() {
    const result = await reconnect({ runAfterReconnect: true }).catch((error) => ({ ok: false, status: 'failed', message: error.message || String(error) }));
    notifyResult(result, result.ok ? 'Backup folder reconnected and verified.' : null);
    return result;
  }

  async function disableFromUI() {
    let approved = true;
    if (typeof global.confirmDialog === 'function') {
      approved = await global.confirmDialog('Disable automatic independent backup on this device? Existing backup files will stay in the selected folder.', {
        title: 'Disable independent backup', okText: 'Disable on this device', danger: true
      });
    } else if (typeof global.confirm === 'function') {
      approved = global.confirm('Disable automatic independent backup on this device? Existing backup files will not be deleted.');
    }
    if (!approved) return { ok: false, status: 'cancelled', cancelled: true };
    const result = await disable().catch((error) => ({ ok: false, status: 'failed', message: error.message || String(error) }));
    notifyResult(result, result.ok ? 'Independent backup disabled. Existing files were not deleted.' : null);
    return result;
  }

  async function maybeRunDue() {
    if (document.visibilityState === 'hidden' || activeRun) return;
    const uid = currentUid(false);
    if (!uid) return status();
    const current = await status({ uid });
    if (!current.enabled || !current.due) return current;
    if (!current.keyAvailable || current.permission !== 'granted') {
      warnAutomaticFailure(current.message || 'Independent backup needs attention.');
      return current;
    }
    const result = await runNow({ uid, manual: false, force: false });
    if (!result.ok && result.status !== 'busy' && result.status !== 'not-due') {
      warnAutomaticFailure(result.message || 'Independent backup could not save.');
    }
    return result;
  }

  function warnAutomaticFailure(message) {
    if (typeof global.toast !== 'function') return;
    const signature = String(message || 'Independent backup could not save.');
    const now = Date.now();
    if (signature === lastAutomaticWarning.signature && now - lastAutomaticWarning.at < 24 * 60 * 60 * 1000) return;
    lastAutomaticWarning = { signature, at: now };
    global.toast('Independent backup did not save: ' + signature + ' Open Sync & Recovery to fix it.', 'error', 10000);
  }

  function scheduleDueCheck(delay) {
    clearTimeout(eventTimer);
    eventTimer = setTimeout(() => { maybeRunDue().catch(() => {}); }, Math.max(0, Number(delay) || 0));
  }

  function initializeScheduling() {
    if (autoTimer) return;
    autoTimer = setInterval(() => scheduleDueCheck(0), STATUS_RECHECK_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleDueCheck(250);
    });
    global.addEventListener('focus', () => scheduleDueCheck(250));
    global.addEventListener('firearms-vault-sync-state', (event) => {
      const state = event && event.detail && event.detail.state;
      if (state === 'account-ready' || state === 'saved' || state === 'local-safe') scheduleDueCheck(500);
    });
    scheduleDueCheck(1500);
  }

  const api = Object.freeze({
    namespace: NAMESPACE,
    configName: CONFIG_NAME,
    supportDetails,
    status,
    setup,
    runNow,
    reconnect,
    disable,
    maybeRunDue,
    refreshStatus: status
  });
  global.IndependentBackupVault = api;
  global.setupIndependentBackup = setupFromUI;
  global.runIndependentBackupNow = runFromUI;
  global.refreshIndependentBackupStatus = status;
  global.getIndependentBackupStatus = status;
  global.reconnectIndependentBackup = reconnectFromUI;
  global.disableIndependentBackup = disableFromUI;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeScheduling, { once: true });
  else initializeScheduling();
})(window);
