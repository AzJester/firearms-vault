// Durable, user-scoped local state, pending changes, and recovery points.
(function initVaultDataSafety(global) {
  'use strict';

  const DB_NAME = 'firearms-vault-safety-v1';
  const DB_VERSION = 1;
  const STORES = ['state', 'outbox', 'backups', 'metadata'];
  const BACKUP_LIMIT = 30;
  const ARTIFACT_FORMAT_VERSION = 2;
  const ARTIFACT_KEY_PREFIX = 'artifact-key:';
  const ARTIFACT_KDF_ITERATIONS = 310000;

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

  function requireMetadataName(name) {
    const value = String(name || '').trim();
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw new Error('A valid metadata name is required.');
    return value;
  }

  async function putMetadata(uid, name, value) {
    const user = requireUID(uid);
    const metadataName = requireMetadataName(name);
    const record = {
      key: scopedKey(user, 'metadata:' + metadataName),
      uid: user,
      name: metadataName,
      value,
      updatedAt: new Date().toISOString()
    };
    await transact('metadata', 'readwrite', (store) => store.put(record));
    return record;
  }

  async function getMetadata(uid, name) {
    const user = requireUID(uid);
    const metadataName = requireMetadataName(name);
    const database = await openDB();
    const record = await requestResult(database.transaction('metadata', 'readonly')
      .objectStore('metadata').get(scopedKey(user, 'metadata:' + metadataName)));
    return record ? record.value : null;
  }

  async function deleteMetadata(uid, name) {
    const metadataName = requireMetadataName(name);
    return transact('metadata', 'readwrite', (store) =>
      store.delete(scopedKey(uid, 'metadata:' + metadataName)));
  }

  async function listMetadata(uid, prefix) {
    const user = requireUID(uid);
    const namePrefix = prefix == null ? '' : String(prefix);
    const database = await openDB();
    const records = await requestResult(database.transaction('metadata', 'readonly').objectStore('metadata').getAll());
    return records.filter((record) => record.uid === user && (!namePrefix || String(record.name || '').startsWith(namePrefix)));
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

  function validIterations(value, fallback) {
    const iterations = Number(value == null ? fallback : value);
    if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) {
      throw new Error('Encrypted backup key parameters are invalid.');
    }
    return iterations;
  }

  async function deriveKey(password, salt, usages, iterations) {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: validIterations(iterations, ARTIFACT_KDF_ITERATIONS) },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      usages
    );
  }

  function requireArtifactNamespace(namespace) {
    const value = String(namespace || '').trim();
    if (!/^[A-Za-z0-9_.:-]{1,96}$/.test(value)) throw new Error('A valid encrypted-artifact namespace is required.');
    return value;
  }

  function artifactKeyMetadataName(namespace) {
    return ARTIFACT_KEY_PREFIX + requireArtifactNamespace(namespace);
  }

  function jsonClone(value) {
    if (value == null) return {};
    return JSON.parse(JSON.stringify(value));
  }

  function canonicalJSON(value) {
    if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJSON(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
  }

  function decodeSizedBase64(value, expectedLength, label, minimumLength) {
    let bytes;
    try { bytes = base64ToBytes(String(value || '')); }
    catch (_) { throw new Error((label || 'Encrypted backup value') + ' is invalid.'); }
    if (expectedLength && bytes.length !== expectedLength) throw new Error((label || 'Encrypted backup value') + ' is invalid.');
    if (minimumLength && bytes.length < minimumLength) throw new Error((label || 'Encrypted backup value') + ' is invalid.');
    return bytes;
  }

  function keyWrapHeader(wrapped) {
    return {
      format: 'firearms-vault-key-wrap',
      formatVersion: 1,
      algorithm: 'AES-256-GCM',
      kdf: 'PBKDF2-SHA256',
      iterations: validIterations(wrapped && wrapped.iterations, ARTIFACT_KDF_ITERATIONS),
      keyId: String(wrapped && wrapped.keyId || ''),
      namespace: requireArtifactNamespace(wrapped && wrapped.namespace)
    };
  }

  function artifactHeader(envelope) {
    return {
      format: String(envelope && envelope.format || 'firearms-vault-encrypted-artifact'),
      formatVersion: Number(envelope && envelope.formatVersion),
      encrypted: true,
      artifactType: String(envelope && envelope.artifactType || 'encrypted-artifact'),
      namespace: requireArtifactNamespace(envelope && envelope.namespace),
      keyId: String(envelope && envelope.keyId || ''),
      createdAt: String(envelope && envelope.createdAt || ''),
      schemaVersion: Number(envelope && envelope.schemaVersion || 0),
      algorithm: 'AES-256-GCM',
      plaintextType: String(envelope && envelope.plaintextType || 'text'),
      checksum: String(envelope && envelope.checksum || ''),
      accountTag: String(envelope && envelope.accountTag || ''),
      metadata: jsonClone(envelope && envelope.metadata)
    };
  }

  async function provisionArtifactKey(uid, namespace, password) {
    const user = requireUID(uid);
    const scope = requireArtifactNamespace(namespace);
    const passphrase = String(password || '');
    if (passphrase.length < 12) throw new Error('Use a recovery password with at least 12 characters.');

    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const keyId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
    const wrapSalt = crypto.getRandomValues(new Uint8Array(16));
    const wrapIv = crypto.getRandomValues(new Uint8Array(12));
    const wrappedHeader = {
      format: 'firearms-vault-key-wrap', formatVersion: 1,
      algorithm: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations: ARTIFACT_KDF_ITERATIONS,
      keyId, namespace: scope
    };
    try {
      const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      const wrappingKey = await deriveKey(passphrase, wrapSalt, ['encrypt'], ARTIFACT_KDF_ITERATIONS);
      const wrappedBytes = await crypto.subtle.encrypt({
        name: 'AES-GCM', iv: wrapIv,
        additionalData: new TextEncoder().encode(canonicalJSON(wrappedHeader))
      }, wrappingKey, rawKey);
      const createdAt = new Date().toISOString();
      const wrappedKey = Object.assign({}, wrappedHeader, {
        salt: bytesToBase64(wrapSalt), iv: bytesToBase64(wrapIv),
        ciphertext: bytesToBase64(new Uint8Array(wrappedBytes))
      });
      const record = { version: 1, uid: user, namespace: scope, keyId, createdAt, cryptoKey, wrappedKey };
      await putMetadata(user, artifactKeyMetadataName(scope), record);
      return record;
    } finally {
      rawKey.fill(0);
    }
  }

  async function getArtifactKey(uid, namespace) {
    const record = await getMetadata(uid, artifactKeyMetadataName(namespace));
    if (!record || !record.cryptoKey || !record.wrappedKey || !record.keyId) return null;
    return record;
  }

  async function deleteArtifactKey(uid, namespace) {
    return deleteMetadata(uid, artifactKeyMetadataName(namespace));
  }

  async function unwrapArtifactKey(wrappedKey, password) {
    const passphrase = String(password || '');
    if (!passphrase) throw new Error('This encrypted backup requires its recovery password.');
    if (!wrappedKey || wrappedKey.format !== 'firearms-vault-key-wrap' || Number(wrappedKey.formatVersion) !== 1 ||
        wrappedKey.algorithm !== 'AES-256-GCM' || wrappedKey.kdf !== 'PBKDF2-SHA256') {
      throw new Error('Encrypted backup key metadata is invalid.');
    }
    const header = keyWrapHeader(wrappedKey);
    if (!header.keyId) throw new Error('Encrypted backup key metadata is invalid.');
    const salt = decodeSizedBase64(wrappedKey && wrappedKey.salt, 16, 'Encrypted backup key salt');
    const iv = decodeSizedBase64(wrappedKey && wrappedKey.iv, 12, 'Encrypted backup key IV');
    const ciphertext = decodeSizedBase64(wrappedKey && wrappedKey.ciphertext, null, 'Encrypted backup wrapped key', 16);
    const wrappingKey = await deriveKey(passphrase, salt, ['decrypt'], header.iterations);
    let raw;
    try {
      raw = new Uint8Array(await crypto.subtle.decrypt({
        name: 'AES-GCM', iv,
        additionalData: new TextEncoder().encode(canonicalJSON(header))
      }, wrappingKey, ciphertext));
      if (raw.length !== 32) throw new Error('Encrypted backup key length is invalid.');
      return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    } catch (error) {
      if (error && /length is invalid/i.test(error.message || '')) throw error;
      throw new Error('The recovery password is incorrect or the encrypted key is damaged.');
    } finally {
      if (raw) raw.fill(0);
    }
  }

  async function encryptArtifact(uid, namespace, value, options) {
    const user = requireUID(uid);
    const scope = requireArtifactNamespace(namespace);
    const opts = options || {};
    const keyRecord = await getArtifactKey(user, scope);
    if (!keyRecord) throw new Error('The automatic backup encryption key is unavailable. Set up encrypted backups again.');
    const plaintextType = typeof value === 'string' ? 'text' : 'json';
    const plaintext = plaintextType === 'text' ? value : JSON.stringify(value);
    const createdAt = opts.createdAt ? new Date(opts.createdAt).toISOString() : new Date().toISOString();
    const checksum = await digestText(plaintext);
    const header = {
      format: String(opts.format || 'firearms-vault-encrypted-artifact'),
      formatVersion: ARTIFACT_FORMAT_VERSION,
      encrypted: true,
      artifactType: String(opts.artifactType || 'encrypted-artifact'),
      namespace: scope,
      keyId: keyRecord.keyId,
      createdAt,
      schemaVersion: Number(opts.schemaVersion || 0),
      algorithm: 'AES-256-GCM',
      plaintextType,
      checksum,
      accountTag: String(opts.accountTag || ''),
      metadata: jsonClone(opts.metadata)
    };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({
      name: 'AES-GCM', iv,
      additionalData: new TextEncoder().encode(canonicalJSON(header))
    }, keyRecord.cryptoKey, new TextEncoder().encode(plaintext));
    return Object.assign({}, header, {
      iv: bytesToBase64(iv),
      keyWrap: jsonClone(keyRecord.wrappedKey),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext))
    });
  }

  async function decryptArtifact(envelope, options) {
    const opts = typeof options === 'string' ? { password: options } : (options || {});
    if (!envelope || Number(envelope.formatVersion) !== ARTIFACT_FORMAT_VERSION || envelope.encrypted !== true) {
      throw new Error('This is not a supported encrypted artifact.');
    }
    const header = artifactHeader(envelope);
    if (!header.keyId || !header.createdAt || !/^[a-f0-9]{64}$/i.test(header.checksum)) {
      throw new Error('Encrypted artifact metadata is invalid.');
    }
    if (envelope.algorithm !== 'AES-256-GCM') throw new Error('Encrypted artifact algorithm is not supported.');
    if (!envelope.keyWrap || envelope.keyWrap.keyId !== header.keyId || envelope.keyWrap.namespace !== header.namespace) {
      throw new Error('Encrypted artifact recovery key metadata does not match this backup.');
    }
    const iv = decodeSizedBase64(envelope.iv, 12, 'Encrypted artifact IV');
    const ciphertext = decodeSizedBase64(envelope.ciphertext, null, 'Encrypted artifact ciphertext', 16);

    let key = null;
    if (opts.uid && opts.namespace) {
      const stored = await getArtifactKey(opts.uid, opts.namespace);
      if (stored && stored.keyId === header.keyId) key = stored.cryptoKey;
    }
    if (!key) key = await unwrapArtifactKey(envelope.keyWrap, opts.password);

    let plaintext;
    try {
      const bytes = await crypto.subtle.decrypt({
        name: 'AES-GCM', iv,
        additionalData: new TextEncoder().encode(canonicalJSON(header))
      }, key, ciphertext);
      plaintext = new TextDecoder().decode(bytes);
    } catch (_) {
      throw new Error('The encrypted artifact is damaged or its key is incorrect.');
    }
    if ((await digestText(plaintext)) !== header.checksum) throw new Error('Encrypted artifact integrity check failed.');
    let value = plaintext;
    if (header.plaintextType === 'json') {
      try { value = JSON.parse(plaintext); }
      catch (_) { throw new Error('The encrypted artifact contains invalid JSON.'); }
    }
    return { plaintext, value, header };
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
    if (!envelope || envelope.format !== 'firearms-vault-backup' || ![1, ARTIFACT_FORMAT_VERSION].includes(Number(envelope.formatVersion))) {
      throw new Error('This is not a supported Firearms Vault backup.');
    }
    if (Number(envelope.formatVersion) === ARTIFACT_FORMAT_VERSION) {
      const artifact = await decryptArtifact(envelope, { password });
      const decoded = artifact.header.plaintextType === 'json' ? artifact.value : JSON.parse(artifact.plaintext);
      const rawData = decoded && (decoded.data || decoded);
      return global.VaultSecurity
        ? global.VaultSecurity.normalizeDatabase(rawData, { regenerateInvalidIds: false, allowUnknownTopLevel: true })
        : { data: rawData, warnings: [] };
    }
    let payload;
    if (envelope.encrypted) {
      if (!password) throw new Error('This backup requires its password.');
      if (envelope.algorithm !== 'AES-256-GCM' || envelope.kdf !== 'PBKDF2-SHA256') {
        throw new Error('This backup uses unsupported encryption settings.');
      }
      const salt = decodeSizedBase64(envelope.salt, 16, 'Encrypted backup salt');
      const iv = decodeSizedBase64(envelope.iv, 12, 'Encrypted backup IV');
      const ciphertext = decodeSizedBase64(envelope.ciphertext, null, 'Encrypted backup ciphertext', 16);
      const key = await deriveKey(String(password), salt, ['decrypt'], envelope.iterations);
      let plaintext;
      try {
        plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
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
    putMetadata,
    getMetadata,
    deleteMetadata,
    listMetadata,
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
    provisionArtifactKey,
    getArtifactKey,
    deleteArtifactKey,
    encryptArtifact,
    decryptArtifact,
    digestText
  });
})(window);
