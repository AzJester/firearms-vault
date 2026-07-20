// Durable, user-scoped local state, pending changes, and recovery points.
(function initVaultDataSafety(global) {
  'use strict';

  const DB_NAME = 'firearms-vault-safety-v1';
  const DB_VERSION = 1;
  const STORES = ['state', 'outbox', 'backups', 'metadata'];
  const BACKUP_LIMIT = 30;

  let openPromise = null;

  function requireUID(uid) {
    const value = String(uid || '').trim();
    if (!/^[A-Za-z0-9-]{8,128}$/.test(value)) throw new Error('A valid signed-in user is required.');
    return value;
  }

  function openDB() {
    if (openPromise) return openPromise;
    openPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        STORES.forEach((name) => {
          if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, { keyPath: 'key' });
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Unable to open secure local storage.'));
    });
    return openPromise;
  }

  async function transact(storeName, mode, operation) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let result;
      try { result = operation(store); } catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error('Local storage transaction failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Local storage transaction was cancelled.'));
    });
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Local storage request failed.'));
    });
  }

  function scopedKey(uid, suffix) {
    return requireUID(uid) + ':' + suffix;
  }

  async function digestText(value) {
    const bytes = new TextEncoder().encode(String(value));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function putState(uid, data, metadata) {
    const key = scopedKey(uid, 'current');
    const normalized = global.VaultSecurity
      ? global.VaultSecurity.normalizeDatabase(data, { regenerateInvalidIds: false, allowUnknownTopLevel: true }).data
      : structuredClone(data);
    const savedAt = new Date().toISOString();
    const checksum = await digestText(JSON.stringify(normalized));
    const record = { key, uid: requireUID(uid), data: normalized, checksum, savedAt, metadata: metadata || {} };
    await transact('state', 'readwrite', (store) => store.put(record));
    return record;
  }

  async function getState(uid) {
    return requestResult((await openDB()).transaction('state', 'readonly').objectStore('state').get(scopedKey(uid, 'current')));
  }

  async function clearState(uid) {
    const user = requireUID(uid);
    await Promise.all(STORES.map(async (storeName) => {
      const database = await openDB();
      const records = await requestResult(database.transaction(storeName, 'readonly').objectStore(storeName).getAll());
      const keys = records.filter((record) => record.uid === user || String(record.key).startsWith(user + ':')).map((record) => record.key);
      if (!keys.length) return;
      await transact(storeName, 'readwrite', (store) => keys.forEach((key) => store.delete(key)));
    }));
  }

  async function enqueue(uid, data, baseRevision) {
    const user = requireUID(uid);
    const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
    const key = scopedKey(user, 'change:' + id);
    const queuedAt = new Date().toISOString();
    const payload = global.VaultSecurity
      ? global.VaultSecurity.normalizeDatabase(data, { regenerateInvalidIds: false, allowUnknownTopLevel: true }).data
      : structuredClone(data);
    const checksum = await digestText(JSON.stringify(payload));
    const record = { key, id, uid: user, payload, checksum, baseRevision: Number(baseRevision) || 0, queuedAt, attempts: 0 };
    await transact('outbox', 'readwrite', (store) => store.put(record));
    return record;
  }

  async function listOutbox(uid) {
    const user = requireUID(uid);
    const database = await openDB();
    const records = await requestResult(database.transaction('outbox', 'readonly').objectStore('outbox').getAll());
    return records.filter((record) => record.uid === user).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  }

  async function removeOutbox(uid, id) {
    return transact('outbox', 'readwrite', (store) => store.delete(scopedKey(uid, 'change:' + id)));
  }

  async function noteOutboxAttempt(uid, id, error) {
    const key = scopedKey(uid, 'change:' + id);
    const database = await openDB();
    const record = await requestResult(database.transaction('outbox', 'readonly').objectStore('outbox').get(key));
    if (!record) return;
    record.attempts = (record.attempts || 0) + 1;
    record.lastAttemptAt = new Date().toISOString();
    record.lastError = String(error && error.message ? error.message : error || '').slice(0, 500);
    await transact('outbox', 'readwrite', (store) => store.put(record));
  }

  async function createBackup(uid, data, reason, metadata) {
    const user = requireUID(uid);
    const createdAt = new Date().toISOString();
    const id = createdAt.replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 7);
    const key = scopedKey(user, 'backup:' + id);
    const normalized = global.VaultSecurity
      ? global.VaultSecurity.normalizeDatabase(data, { regenerateInvalidIds: false, allowUnknownTopLevel: true }).data
      : structuredClone(data);
    const checksum = await digestText(JSON.stringify(normalized));
    const counts = {};
    ['firearms', 'ammo', 'accessories', 'wishlist', 'dealers'].forEach((collection) => {
      counts[collection] = Array.isArray(normalized[collection]) ? normalized[collection].length : 0;
    });
    const record = {
      key, id, uid: user, createdAt, reason: String(reason || 'automatic'),
      schemaVersion: normalized.version || 3, checksum, counts,
      data: normalized, metadata: metadata || {}
    };
    await transact('backups', 'readwrite', (store) => store.put(record));
    const backups = await listBackups(user);
    if (backups.length > BACKUP_LIMIT) {
      const expired = backups.slice(BACKUP_LIMIT);
      await transact('backups', 'readwrite', (store) => expired.forEach((item) => store.delete(item.key)));
    }
    return record;
  }

  async function listBackups(uid) {
    const user = requireUID(uid);
    const database = await openDB();
    const records = await requestResult(database.transaction('backups', 'readonly').objectStore('backups').getAll());
    return records.filter((record) => record.uid === user).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function getBackup(uid, id) {
    return requestResult((await openDB()).transaction('backups', 'readonly').objectStore('backups').get(scopedKey(uid, 'backup:' + id)));
  }

  async function verifyBackup(record) {
    if (!record || !record.data || !record.checksum) return false;
    return (await digestText(JSON.stringify(record.data))) === record.checksum;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function deriveKey(password, salt, usages) {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 310000 },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      usages
    );
  }

  async function exportEnvelope(uid, data, password) {
    const normalized = global.VaultSecurity
      ? global.VaultSecurity.normalizeDatabase(data, { regenerateInvalidIds: false, allowUnknownTopLevel: true }).data
      : structuredClone(data);
    const payload = JSON.stringify({
      format: 'firearms-vault-backup', formatVersion: 1,
      createdAt: new Date().toISOString(), schemaVersion: normalized.version || 3,
      data: normalized
    });
    const checksum = await digestText(payload);
    if (!password) return { format: 'firearms-vault-backup', formatVersion: 1, encrypted: false, checksum, payload: JSON.parse(payload) };
    if (String(password).length < 12) throw new Error('Use a backup password with at least 12 characters.');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(String(password), salt, ['encrypt']);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(payload));
    return {
      format: 'firearms-vault-backup', formatVersion: 1, encrypted: true,
      algorithm: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations: 310000,
      salt: bytesToBase64(salt), iv: bytesToBase64(iv), checksum,
      ciphertext: bytesToBase64(new Uint8Array(ciphertext))
    };
  }

  async function importEnvelope(envelope, password) {
    if (!envelope || envelope.format !== 'firearms-vault-backup' || envelope.formatVersion !== 1) {
      throw new Error('This is not a supported Firearms Vault backup.');
    }
    let payload;
    if (envelope.encrypted) {
      if (!password) throw new Error('This backup requires its password.');
      const salt = base64ToBytes(envelope.salt);
      const iv = base64ToBytes(envelope.iv);
      const key = await deriveKey(String(password), salt, ['decrypt']);
      let plaintext;
      try {
        plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, base64ToBytes(envelope.ciphertext));
      } catch (_) {
        throw new Error('The backup password is incorrect or the file is damaged.');
      }
      payload = new TextDecoder().decode(plaintext);
    } else {
      payload = JSON.stringify(envelope.payload);
    }
    if ((await digestText(payload)) !== envelope.checksum) throw new Error('Backup integrity check failed.');
    const decoded = JSON.parse(payload);
    const rawData = decoded.data || decoded;
    return global.VaultSecurity
      ? global.VaultSecurity.normalizeDatabase(rawData, { regenerateInvalidIds: false, allowUnknownTopLevel: true })
      : { data: rawData, warnings: [] };
  }

  global.VaultDataSafety = Object.freeze({
    putState,
    getState,
    clearState,
    enqueue,
    listOutbox,
    removeOutbox,
    noteOutboxAttempt,
    createBackup,
    listBackups,
    getBackup,
    verifyBackup,
    exportEnvelope,
    importEnvelope,
    digestText
  });
})(window);
