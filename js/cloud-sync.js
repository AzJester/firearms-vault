// =====================================================
// CloudSync - resilient, quiet synchronization for the Supabase edition.
//
// Data-safety guarantees provided here:
//   * every pending snapshot is persisted in a user-scoped IndexedDB outbox;
//   * media is uploaded before structured data is committed;
//   * cloud writes use compare-and-swap (revision RPC, or updated_at fallback);
//   * disjoint edits are merged in the background, never through a routine
//     conflict popup; genuinely overlapping edits remain safely queued;
//   * shared legacy app caches are cleared when accounts change.
//
// This replaces the legacy last-edit-wins behavior while preserving the
// existing CloudSync API used by app.js.
// =====================================================
(function () {
  'use strict';

  const SYNC_DB_NAME = 'FirearmsVault_Sync';
  const SYNC_DB_VERSION = 1;
  const ACTIVE_USER_KEY = 'firearms-vault-active-user-v1';
  const CHANNEL_NAME = 'firearms-vault-sync-v1';
  const RECORD_ARRAYS = new Set(['firearms', 'ammo', 'accessories', 'wishlist', 'dealers']);
  const APP_STATE_DB = { name: 'FirearmsDB_State', version: 1, store: 'state' };
  const APP_MEDIA_DB = { name: 'FirearmsDB_Images', version: 1, store: 'images' };

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (isPlainObject(value)) {
      return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    }
    return JSON.stringify(value);
  }

  function equal(a, b) {
    return canonical(a) === canonical(b);
  }

  function errorInfo(error) {
    if (!error) return { message: 'Unknown error' };
    return {
      message: error.message || String(error),
      code: error.code || null,
      status: error.status || null,
      details: error.details || null
    };
  }

  function missingCasRpc(error) {
    const text = ((error && error.message) || '') + ' ' + ((error && error.details) || '');
    return !!error && (
      error.code === 'PGRST202' || error.code === '42883' || error.status === 404 ||
      /save_collection_cas|schema cache|could not find the function/i.test(text)
    );
  }

  function missingRevisionColumns(error) {
    const text = ((error && error.message) || '') + ' ' + ((error && error.details) || '');
    return !!error && (
      error.code === '42703' || error.code === 'PGRST204' ||
      /revision|media_manifest|does not exist|schema cache/i.test(text)
    );
  }

  function openNamedDb(spec) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(spec.name, spec.version);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(spec.store)) database.createObjectStore(spec.store);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open ' + spec.name));
      request.onblocked = () => reject(new Error(spec.name + ' is blocked by another tab'));
    });
  }

  async function namedStoreAction(spec, mode, action) {
    const database = await openNamedDb(spec);
    try {
      return await new Promise((resolve, reject) => {
        const tx = database.transaction(spec.store, mode);
        const store = tx.objectStore(spec.store);
        let request;
        try { request = action(store); }
        catch (error) { reject(error); return; }
        tx.oncomplete = () => resolve(request && request.result);
        tx.onerror = () => reject(tx.error || (request && request.error) || new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      });
    } finally {
      database.close();
    }
  }

  async function runtimeGet(spec, key) {
    return namedStoreAction(spec, 'readonly', store => store.get(key));
  }

  async function runtimePut(spec, key, value) {
    await namedStoreAction(spec, 'readwrite', store => store.put(value, key));
  }

  async function runtimeGetAll(spec) {
    const database = await openNamedDb(spec);
    try {
      return await new Promise((resolve, reject) => {
        const tx = database.transaction(spec.store, 'readonly');
        const store = tx.objectStore(spec.store);
        const valuesRequest = store.getAll();
        const keysRequest = store.getAllKeys();
        tx.oncomplete = () => {
          const out = {};
          (keysRequest.result || []).forEach((key, index) => { out[key] = valuesRequest.result[index]; });
          resolve(out);
        };
        tx.onerror = () => reject(tx.error || new Error('Could not read runtime cache'));
      });
    } finally {
      database.close();
    }
  }

  async function runtimeClear(spec) {
    await namedStoreAction(spec, 'readwrite', store => store.clear());
  }

  function mergeArray(base, local, remote, path, conflicts) {
    const allHaveIds = [base, local, remote].every(list =>
      list.every(item => isPlainObject(item) && item.id !== undefined && item.id !== null));

    if (!allHaveIds) {
      // Append-only logs (audit/value history) are merged as a stable union.
      const seen = new Set();
      const out = [];
      [...remote, ...local].forEach(item => {
        const key = canonical(item);
        if (!seen.has(key)) { seen.add(key); out.push(clone(item)); }
      });
      return out;
    }

    const baseMap = new Map(base.map(item => [String(item.id), item]));
    const localMap = new Map(local.map(item => [String(item.id), item]));
    const remoteMap = new Map(remote.map(item => [String(item.id), item]));
    const order = [];
    [...remote, ...local, ...base].forEach(item => {
      const id = String(item.id);
      if (!order.includes(id)) order.push(id);
    });

    const out = [];
    for (const id of order) {
      const b = baseMap.get(id);
      const l = localMap.get(id);
      const r = remoteMap.get(id);
      const itemPath = path + '[' + id + ']';

      if (l === undefined && r === undefined) continue;
      if (b === undefined) {
        if (l === undefined) out.push(clone(r));
        else if (r === undefined || equal(l, r)) out.push(clone(l));
        else {
          conflicts.push(itemPath);
          out.push(clone(l));
        }
        continue;
      }

      if (l === undefined) {
        if (equal(r, b)) continue; // local deletion, remote unchanged
        conflicts.push(itemPath);
        continue;
      }
      if (r === undefined) {
        if (equal(l, b)) continue; // remote deletion, local unchanged
        conflicts.push(itemPath);
        out.push(clone(l));
        continue;
      }

      out.push(mergeValue(b, l, r, itemPath, conflicts));
    }
    return out;
  }

  function mergeValue(base, local, remote, path, conflicts) {
    if (equal(local, remote)) return clone(local);
    if (equal(local, base)) return clone(remote);
    if (equal(remote, base)) return clone(local);

    if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
      return mergeArray(base, local, remote, path, conflicts);
    }
    if (isPlainObject(base) && isPlainObject(local) && isPlainObject(remote)) {
      const out = {};
      const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
      for (const key of keys) {
        const bHas = Object.prototype.hasOwnProperty.call(base, key);
        const lHas = Object.prototype.hasOwnProperty.call(local, key);
        const rHas = Object.prototype.hasOwnProperty.call(remote, key);
        const keyPath = path ? path + '.' + key : key;

        if (!lHas && !rHas) continue;
        if (!bHas) {
          if (!lHas) out[key] = clone(remote[key]);
          else if (!rHas || equal(local[key], remote[key])) out[key] = clone(local[key]);
          else { conflicts.push(keyPath); out[key] = clone(local[key]); }
          continue;
        }
        if (!lHas) {
          if (!rHas || equal(remote[key], base[key])) continue;
          conflicts.push(keyPath);
          continue;
        }
        if (!rHas) {
          if (equal(local[key], base[key])) continue;
          conflicts.push(keyPath);
          out[key] = clone(local[key]);
          continue;
        }
        out[key] = mergeValue(base[key], local[key], remote[key], keyPath, conflicts);
      }
      return out;
    }

    conflicts.push(path || 'root');
    return clone(local);
  }

  const CloudSync = {
    ready: false,
    uid: null,
    hasCloudData: false,
    revision: 0,
    serverUpdatedAt: null,
    serverMediaManifest: {},
    syncedHashes: {},
    pushTimer: null,
    pushing: false,
    pendingPush: false,
    saveFailureNotified: false,
    lastResult: null,
    _syncDbPromise: null,
    _queuePromise: Promise.resolve({ ok: true, status: 'idle' }),
    _retryTimer: null,
    _listeners: new Set(),
    _broadcast: null,
    _shaCache: new Map(),
    _casRpcSupported: null,
    _lastCommittedData: null,

    // ---- observable state -----------------------------------------
    onStateChange(listener) {
      if (typeof listener !== 'function') return () => {};
      this._listeners.add(listener);
      return () => this._listeners.delete(listener);
    },

    emit(state, detail) {
      const payload = Object.assign({ state, uid: this.uid, at: new Date().toISOString() }, detail || {});
      this.lastResult = payload;
      this._listeners.forEach(listener => {
        try { listener(payload); } catch (error) { console.warn('Sync state listener failed', error); }
      });
      try { window.dispatchEvent(new CustomEvent('firearms-vault-sync-state', { detail: payload })); } catch (_) {}
      return payload;
    },

    setStatus(text, kind, state) {
      const el = document.getElementById('syncStatus');
      if (el) {
        el.textContent = text;
        el.dataset.kind = kind || '';
      }
      if (typeof window.setSaveStatus === 'function') {
        const mapped = state || (kind === 'ok' ? 'saved' : kind === 'syncing' ? 'saving' : 'failed');
        try { window.setSaveStatus(mapped, text); } catch (error) { console.warn('Save status UI failed', error); }
      }
    },

    // ---- sync IndexedDB -------------------------------------------
    openSyncDb() {
      if (this._syncDbPromise) return this._syncDbPromise;
      this._syncDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(SYNC_DB_NAME, SYNC_DB_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('outbox')) database.createObjectStore('outbox', { keyPath: 'uid' });
          if (!database.objectStoreNames.contains('cache')) database.createObjectStore('cache', { keyPath: 'uid' });
          if (!database.objectStoreNames.contains('media')) {
            const store = database.createObjectStore('media', { keyPath: 'id' });
            store.createIndex('uid', 'uid', { unique: false });
          }
          if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => { this._syncDbPromise = null; reject(request.error || new Error('Could not open sync storage')); };
        request.onblocked = () => { this._syncDbPromise = null; reject(new Error('Sync storage is blocked by another tab')); };
      });
      return this._syncDbPromise;
    },

    async storeGet(storeName, key) {
      const database = await this.openSyncDb();
      return new Promise((resolve, reject) => {
        const tx = database.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('Could not read ' + storeName));
      });
    },

    async storePut(storeName, value) {
      const database = await this.openSyncDb();
      return new Promise((resolve, reject) => {
        const tx = database.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(value);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error('Could not write ' + storeName));
        tx.onabort = () => reject(tx.error || new Error('Write to ' + storeName + ' was aborted'));
      });
    },

    async storeDelete(storeName, key) {
      const database = await this.openSyncDb();
      return new Promise((resolve, reject) => {
        const tx = database.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error('Could not delete from ' + storeName));
      });
    },

    mediaId(uid, key) { return uid + '\u0000' + key; },

    async getUserMedia(uid) {
      const database = await this.openSyncDb();
      return new Promise((resolve, reject) => {
        const tx = database.transaction('media', 'readonly');
        const index = tx.objectStore('media').index('uid');
        const request = index.getAll(IDBKeyRange.only(uid));
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error('Could not read cached media'));
      });
    },

    async putScopedMedia(uid, key, dataURL, meta) {
      return this.storePut('media', {
        id: this.mediaId(uid, key), uid, mediaKey: key, dataURL,
        sha256: meta.sha256 || null, mime: meta.mime || this.mimeOf(dataURL),
        size: meta.size || 0, path: meta.path || null, updatedAt: new Date().toISOString()
      });
    },

    async getScopedMedia(uid, key) {
      return this.storeGet('media', this.mediaId(uid, key));
    },

    // ---- account isolation ---------------------------------------
    async captureLegacyRuntime(uid) {
      try {
        const existing = await this.storeGet('cache', uid);
        if (existing) return { ok: true, captured: false };
        const state = await runtimeGet(APP_STATE_DB, 'db');
        if (!state || !isPlainObject(state)) return { ok: true, captured: false };
        await this.storePut('cache', {
          uid, data: clone(state), revision: 0, updatedAt: null,
          mediaManifest: {}, pending: false, cachedAt: new Date().toISOString(), legacy: true
        });
        const media = await runtimeGetAll(APP_MEDIA_DB);
        for (const [key, dataURL] of Object.entries(media)) {
          if (typeof dataURL === 'string') {
            await this.putScopedMedia(uid, key, dataURL, { sha256: null, mime: this.mimeOf(dataURL), size: dataURL.length });
          }
        }
        return { ok: true, captured: true };
      } catch (error) {
        return { ok: false, error: errorInfo(error) };
      }
    },

    async clearRuntimeCaches() {
      const failures = [];
      try { await runtimeClear(APP_STATE_DB); } catch (error) { failures.push({ store: 'state', error: errorInfo(error) }); }
      try { await runtimeClear(APP_MEDIA_DB); } catch (error) { failures.push({ store: 'media', error: errorInfo(error) }); }
      return { ok: failures.length === 0, failures };
    },

    async hydrateRuntime(uid) {
      try {
        const outbox = await this.storeGet('outbox', uid);
        const cached = await this.storeGet('cache', uid);
        let source = outbox ? outbox.data : cached && cached.data;
        if (!source && window.VaultDataSafety) {
          const safetyOutbox = await window.VaultDataSafety.listOutbox(uid);
          const safetyState = await window.VaultDataSafety.getState(uid);
          source = safetyOutbox.length ? safetyOutbox[safetyOutbox.length - 1].payload : safetyState && safetyState.data;
        }
        if (source) await runtimePut(APP_STATE_DB, 'db', clone(source));
        const media = await this.getUserMedia(uid);
        for (const item of media) await runtimePut(APP_MEDIA_DB, item.mediaKey, item.dataURL);
        return { ok: true, hydrated: !!source, media: media.length };
      } catch (error) {
        return { ok: false, error: errorInfo(error) };
      }
    },

    initBroadcast() {
      if (this._broadcast) { try { this._broadcast.close(); } catch (_) {} }
      this._broadcast = null;
      if (!('BroadcastChannel' in window) || !this.uid) return;
      try {
        this._broadcast = new BroadcastChannel(CHANNEL_NAME);
        this._broadcast.onmessage = async event => {
          const message = event.data || {};
          if (message.uid !== this.uid || message.source === this._sourceId) return;
          if (message.type === 'saved') {
            const pending = await this.storeGet('outbox', this.uid).catch(() => null);
            if (pending) this.schedulePush();
            else if (this.ready && Number(message.revision || 0) > Number(this.revision || 0)) {
              this.pull({ background: true }).catch(error => console.warn('Background sync pull failed', error));
            }
          }
        };
      } catch (error) {
        console.warn('Cross-tab sync coordination unavailable', error);
      }
    },

    async activateUser(uid) {
      if (!uid) return { ok: false, status: 'invalid-user', error: { message: 'A signed-in user is required.' } };
      try {
        await this.openSyncDb();
        const previous = localStorage.getItem(ACTIVE_USER_KEY);

        // A pre-upgrade cache belongs to the currently authenticated account.
        if (!previous) await this.captureLegacyRuntime(uid);

        if (previous && previous !== uid) {
          // The outgoing user's persistent outbox/cache remains locked under
          // their uid. Only the shared compatibility stores are cleared.
          const cleared = await this.clearRuntimeCaches();
          if (!cleared.ok) throw new Error('Could not isolate the previous account cache.');
        }

        this.uid = uid;
        this.ready = false;
        this.revision = 0;
        this.serverUpdatedAt = null;
        this.serverMediaManifest = {};
        this.syncedHashes = {};
        this._lastCommittedData = null;
        this._sourceId = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random());
        localStorage.setItem(ACTIVE_USER_KEY, uid);

        if (previous !== uid) {
          const hydrated = await this.hydrateRuntime(uid);
          if (!hydrated.ok) throw new Error(hydrated.error.message);
        }
        this.initBroadcast();
        this.emit('account-ready', { ok: true });
        return { ok: true, status: 'account-ready', changed: !!previous && previous !== uid };
      } catch (error) {
        this.emit('failed', { ok: false, operation: 'activate-account', error: errorInfo(error) });
        return { ok: false, status: 'activation-failed', error: errorInfo(error) };
      }
    },

    async deactivateUser(options) {
      const opts = options || {};
      const uid = this.uid;
      clearTimeout(this.pushTimer);
      clearTimeout(this._retryTimer);
      if (this._broadcast) { try { this._broadcast.close(); } catch (_) {} }
      this._broadcast = null;
      const cleared = opts.clearRuntime === false ? { ok: true, failures: [] } : await this.clearRuntimeCaches();
      // Keep the previous uid marker when runtime clearing failed. A later
      // account activation will then retry isolation instead of adopting the
      // uncleared compatibility cache as the new user's data.
      if (cleared.ok || opts.clearRuntime === false) {
        try { localStorage.removeItem(ACTIVE_USER_KEY); } catch (_) {}
      }
      this.ready = false;
      this.uid = null;
      this.emit('signed-out', { ok: cleared.ok, previousUid: uid, failures: cleared.failures });
      return { ok: cleared.ok, status: 'signed-out', failures: cleared.failures };
    },

    // ---- data and media helpers ----------------------------------
    safePath(key) {
      if (!this.uid) throw new Error('Cannot create a media path without an active user.');
      return this.uid + '/' + String(key).replace(/[^A-Za-z0-9._-]/g, '_');
    },

    contentPath(key, sha256) {
      return this.safePath(key) + '--' + String(sha256 || 'legacy').slice(0, 32);
    },

    // Fast in-memory fingerprint used only to avoid repeating SHA-256 work.
    hash(str) {
      let h = 5381;
      const step = str.length > 200000 ? 1499 : 1;
      for (let i = 0; i < str.length; i += step) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
      return (h >>> 0).toString(36) + '_' + str.length;
    },

    mimeOf(dataURL) {
      const match = /^data:([^;,]+)[;,]/.exec(dataURL || '');
      return (match && match[1]) || 'application/octet-stream';
    },

    async dataURLtoBlob(dataURL) {
      const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(String(dataURL || ''));
      if (!match) throw new Error('The media is not a valid data URL.');
      const mime = match[1] || 'application/octet-stream';
      try {
        if (match[2]) {
          const binary = atob(match[3].replace(/\s/g, ''));
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
          return new Blob([bytes], { type: mime });
        }
        return new Blob([decodeURIComponent(match[3])], { type: mime });
      } catch (_) {
        throw new Error('The media data URL could not be decoded.');
      }
    },

    blobToDataURL(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('Could not read media.'));
        reader.readAsDataURL(blob);
      });
    },

    async sha256Blob(blob) {
      if (!crypto.subtle || !crypto.subtle.digest) return 'weak:' + this.hash(await this.blobToDataURL(blob));
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('');
    },

    async mediaMetadata(dataURL) {
      const fast = this.hash(dataURL);
      const cached = this._shaCache.get(fast);
      if (cached) return clone(cached);
      const blob = await this.dataURLtoBlob(dataURL);
      const result = { sha256: await this.sha256Blob(blob), mime: blob.type || this.mimeOf(dataURL), size: blob.size };
      this._shaCache.set(fast, result);
      return clone(result);
    },

    referencedMediaKeys() {
      const keys = new Set();
      const refKey = value => (typeof value === 'string' && value.startsWith('@media:')) ? value.slice(7) : null;
      (db.firearms || []).forEach(firearm => {
        (firearm.images || []).forEach(id => keys.add(id));
        let key = refKey(firearm.receipt); if (key) keys.add(key);
        key = refKey(firearm.stampPdf); if (key) keys.add(key);
        (firearm.documents || []).forEach(document => keys.add('doc:' + firearm.id + ':' + document.id));
      });
      (db.ammo || []).forEach(ammo => { const key = refKey(ammo.receipt); if (key) keys.add(key); });
      (db.accessories || []).forEach(accessory => { const key = refKey(accessory.receipt); if (key) keys.add(key); });
      return [...keys];
    },

    applyMedia(key, dataURL) {
      if (key.indexOf(':') === -1) { imagesDb[key] = dataURL; return true; }
      const parts = key.split(':');
      if (parts[0] === 'doc') {
        const firearm = (db.firearms || []).find(item => item.id === parts[1]);
        const document = firearm && (firearm.documents || []).find(item => item.id === parts[2]);
        if (document) { document.data = dataURL; return true; }
        return false;
      }
      const type = parts[0];
      const kind = parts[1];
      const id = parts.slice(2).join(':');
      const records = kind === 'firearm' ? db.firearms : kind === 'ammo' ? db.ammo : kind === 'accessory' ? db.accessories : null;
      const record = records && records.find(item => item.id === id);
      if (!record) return false;
      if (type === 'receipt') record.receipt = dataURL;
      else if (type === 'stamp') record.stampPdf = dataURL;
      else return false;
      return true;
    },

    collectMedia() {
      const media = {};
      const isData = value => typeof value === 'string' && value.startsWith('data:');
      Object.entries(imagesDb || {}).forEach(([key, value]) => { if (isData(value)) media[key] = value; });
      const grabReceipt = (record, kind) => {
        if (isData(record.receipt)) media['receipt:' + kind + ':' + record.id] = record.receipt;
      };
      (db.firearms || []).forEach(firearm => {
        grabReceipt(firearm, 'firearm');
        if (isData(firearm.stampPdf)) media['stamp:firearm:' + firearm.id] = firearm.stampPdf;
        (firearm.documents || []).forEach(document => {
          if (isData(document.data)) media['doc:' + firearm.id + ':' + document.id] = document.data;
        });
      });
      (db.ammo || []).forEach(ammo => grabReceipt(ammo, 'ammo'));
      (db.accessories || []).forEach(accessory => grabReceipt(accessory, 'accessory'));
      return media;
    },

    buildStructured() {
      const structured = clone(db);
      delete structured.backups;
      const isData = value => typeof value === 'string' && value.startsWith('data:');
      const stripReceipt = (record, kind) => {
        if (isData(record.receipt)) record.receipt = '@media:receipt:' + kind + ':' + record.id;
      };
      (structured.firearms || []).forEach(firearm => {
        stripReceipt(firearm, 'firearm');
        if (isData(firearm.stampPdf)) firearm.stampPdf = '@media:stamp:firearm:' + firearm.id;
        (firearm.documents || []).forEach(document => { if (isData(document.data)) delete document.data; });
      });
      (structured.ammo || []).forEach(ammo => stripReceipt(ammo, 'ammo'));
      (structured.accessories || []).forEach(accessory => stripReceipt(accessory, 'accessory'));
      return window.VaultSecurity
        ? window.VaultSecurity.normalizeDatabase(structured, { regenerateInvalidIds: false, allowUnknownTopLevel: true }).data
        : structured;
    },

    applyStructured(structured) {
      const source = window.VaultSecurity
        ? window.VaultSecurity.normalizeDatabase(structured || {}, { regenerateInvalidIds: false, allowUnknownTopLevel: true }).data
        : (structured || {});
      ['firearms', 'ammo', 'accessories', 'wishlist', 'dealers', 'auditTrail', 'valueHistory']
        .forEach(key => { db[key] = Array.isArray(source[key]) ? clone(source[key]) : []; });
      db.settings = isPlainObject(source.settings) ? clone(source.settings) : {};
      db.version = source.version || db.version;
      db.encrypted = !!source.encrypted;
      db.firearms.forEach(firearm => {
        if (!firearm.tags) firearm.tags = [];
        if (!firearm.roundCount) firearm.roundCount = 0;
        if (!firearm.customFields) firearm.customFields = [];
        if (!firearm.maintenanceLog) firearm.maintenanceLog = [];
      });
      db.ammo.forEach(ammo => { if (!ammo.lowStock) ammo.lowStock = 0; });
      return db;
    },

    hasRecords(structured) {
      const source = structured || {};
      return ['firearms', 'ammo', 'accessories', 'wishlist', 'dealers']
        .some(key => Array.isArray(source[key]) && source[key].length > 0);
    },

    async prepareSnapshot() {
      const structured = this.buildStructured();
      const inline = this.collectMedia();
      const referenced = new Set(this.referencedMediaKeys());
      const manifest = {};

      for (const [key, dataURL] of Object.entries(inline)) {
        const metadata = await this.mediaMetadata(dataURL);
        metadata.path = this.contentPath(key, metadata.sha256);
        manifest[key] = metadata;
        await this.putScopedMedia(this.uid, key, dataURL, metadata);
      }

      // Preserve cloud/cached media when a binary is not currently resident in
      // memory. A structured commit must never delete or orphan that reference.
      for (const key of referenced) {
        if (manifest[key]) continue;
        const cached = await this.getScopedMedia(this.uid, key);
        if (cached && cached.dataURL) {
          const metadata = cached.sha256
            ? { sha256: cached.sha256, mime: cached.mime, size: cached.size, path: cached.path || this.contentPath(key, cached.sha256) }
            : await this.mediaMetadata(cached.dataURL);
          if (!metadata.path && metadata.sha256) metadata.path = this.contentPath(key, metadata.sha256);
          manifest[key] = metadata;
          if (!cached.sha256) await this.putScopedMedia(this.uid, key, cached.dataURL, metadata);
        } else if (this.serverMediaManifest[key]) {
          manifest[key] = clone(this.serverMediaManifest[key]);
        } else {
          // Legacy schemas have no manifest. Mark the reference as preserved;
          // cleanup deliberately skips entries whose digest is unknown.
          manifest[key] = { sha256: null, mime: null, size: null, preserved: true };
        }
      }
      return { structured, manifest };
    },

    async queueCurrentSnapshot(reason) {
      if (!this.uid) return { ok: false, status: 'no-user', error: { message: 'No active account.' } };
      try {
        const snapshot = await this.prepareSnapshot();
        const existing = await this.storeGet('outbox', this.uid);
        const cached = await this.storeGet('cache', this.uid);
        const baseData = existing ? existing.baseData : (this._lastCommittedData || (cached && cached.data) || {});
        const entry = {
          uid: this.uid,
          id: (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random()),
          data: snapshot.structured,
          mediaManifest: snapshot.manifest,
          baseData: clone(baseData),
          baseMediaManifest: existing ? clone(existing.baseMediaManifest || {}) : clone(this.serverMediaManifest || {}),
          baseRevision: existing ? existing.baseRevision : Number(this.revision || 0),
          baseUpdatedAt: existing ? existing.baseUpdatedAt : this.serverUpdatedAt,
          queuedAt: new Date().toISOString(),
          reason: reason || 'autosave',
          attempts: existing ? Number(existing.attempts || 0) : 0
        };
        if (window.VaultDataSafety) {
          const safetyState = await window.VaultDataSafety.putState(this.uid, entry.data, {
            revision: entry.baseRevision, pending: true, queuedAt: entry.queuedAt
          });
          const safetyOutbox = await window.VaultDataSafety.enqueue(this.uid, entry.data, entry.baseRevision);
          entry.vaultStateChecksum = safetyState.checksum;
          entry.vaultOutboxId = safetyOutbox.id;
        }
        await this.storePut('outbox', entry);
        await this.storePut('cache', {
          uid: this.uid, data: clone(entry.data), revision: entry.baseRevision,
          updatedAt: entry.baseUpdatedAt, mediaManifest: clone(entry.mediaManifest),
          pending: true, cachedAt: entry.queuedAt
        });
        if (typeof hasUnsavedChanges !== 'undefined') hasUnsavedChanges = false;
        this.emit('local-safe', { ok: true, queuedAt: entry.queuedAt, reason: entry.reason });
        return { ok: true, status: 'local-safe', outboxId: entry.id };
      } catch (error) {
        const safetyOutbox = this.uid && window.VaultDataSafety
          ? await window.VaultDataSafety.listOutbox(this.uid).catch(() => [])
          : [];
        const localSafe = safetyOutbox.length > 0;
        const result = {
          ok: false, status: localSafe ? 'local-safe-only' : 'local-save-failed',
          localSafe, error: errorInfo(error)
        };
        if (localSafe && typeof hasUnsavedChanges !== 'undefined') hasUnsavedChanges = false;
        this.emit(localSafe ? 'degraded' : 'failed', Object.assign({ operation: 'local-save' }, result));
        this.setStatus(
          localSafe ? 'Saved on this device - cloud queue needs retry' : 'Save failed - changes are not yet safe',
          'error', localSafe ? 'local' : 'failed'
        );
        return result;
      }
    },

    async cacheLocal(options) {
      const opts = options || {};
      const failures = [];
      const structured = opts.data || this.buildStructured();
      const manifest = opts.mediaManifest || this.serverMediaManifest || {};
      try {
        await this.storePut('cache', {
          uid: this.uid, data: clone(structured), revision: Number(opts.revision !== undefined ? opts.revision : this.revision || 0),
          updatedAt: opts.updatedAt !== undefined ? opts.updatedAt : this.serverUpdatedAt,
          mediaManifest: clone(manifest), pending: !!opts.pending, cachedAt: new Date().toISOString()
        });
      } catch (error) { failures.push({ store: 'scoped-state', error: errorInfo(error) }); }

      if (window.VaultDataSafety) {
        try {
          await window.VaultDataSafety.putState(this.uid, structured, {
            revision: Number(opts.revision !== undefined ? opts.revision : this.revision || 0),
            updatedAt: opts.updatedAt !== undefined ? opts.updatedAt : this.serverUpdatedAt,
            pending: !!opts.pending
          });
        } catch (error) { failures.push({ store: 'vault-data-safety', error: errorInfo(error) }); }
      }

      try {
        if (typeof statePut === 'function') await statePut('db', clone(structured));
        else await runtimePut(APP_STATE_DB, 'db', clone(structured));
      } catch (error) { failures.push({ store: 'runtime-state', error: errorInfo(error) }); }

      const inline = this.collectMedia();
      for (const [key, dataURL] of Object.entries(inline)) {
        try {
          const metadata = manifest[key] || await this.mediaMetadata(dataURL);
          await this.putScopedMedia(this.uid, key, dataURL, metadata);
          if (typeof idbPut === 'function') await idbPut(key, dataURL);
          else await runtimePut(APP_MEDIA_DB, key, dataURL);
        } catch (error) { failures.push({ store: 'media', key, error: errorInfo(error) }); }
      }

      return { ok: failures.length === 0, status: failures.length ? 'partial-cache' : 'cached', failures };
    },

    async loadCachedIntoMemory() {
      const outbox = await this.storeGet('outbox', this.uid).catch(() => null);
      const cached = await this.storeGet('cache', this.uid).catch(() => null);
      let source = outbox || cached;
      if (!source && window.VaultDataSafety) {
        const safetyOutbox = await window.VaultDataSafety.listOutbox(this.uid).catch(() => []);
        const safetyState = await window.VaultDataSafety.getState(this.uid).catch(() => null);
        if (safetyOutbox.length) source = { data: safetyOutbox[safetyOutbox.length - 1].payload, safety: true };
        else if (safetyState) source = { data: safetyState.data, safety: true };
      }
      if (source && source.data) this.applyStructured(source.data);
      const records = await this.getUserMedia(this.uid).catch(() => []);
      records.forEach(item => this.applyMedia(item.mediaKey, item.dataURL));
      return {
        ok: !!source,
        source: outbox ? 'outbox' : cached ? 'cache' : source && source.safety ? 'vault-data-safety' : 'memory',
        media: records.length, outbox
      };
    },

    // ---- cloud pull -----------------------------------------------
    async readCloudRow() {
      const sb = window.sbClient;
      let response = await sb.from('collections')
        .select('data, updated_at, revision, media_manifest')
        .eq('user_id', this.uid).maybeSingle();
      if (response.error && missingRevisionColumns(response.error)) {
        this._casRpcSupported = false;
        this.emit('degraded', {
          ok: true, operation: 'schema',
          message: 'Sync-safety migration is pending; timestamp compare-and-swap is active.'
        });
        response = await sb.from('collections')
          .select('data, updated_at').eq('user_id', this.uid).maybeSingle();
        if (response.error) throw response.error;
        return response.data ? Object.assign({ revision: 0, media_manifest: {}, modernSchema: false }, response.data) : null;
      }
      if (response.error) throw response.error;
      return response.data ? Object.assign({ modernSchema: true }, response.data) : null;
    },

    async downloadMedia(manifest) {
      const sb = window.sbClient;
      const keys = this.referencedMediaKeys();
      const failures = [];
      let loaded = 0;
      let cursor = 0;
      const loadNext = async () => {
        while (cursor < keys.length) {
          const key = keys[cursor++];
        try {
          const expected = manifest[key] || null;
          const cached = await this.getScopedMedia(this.uid, key);
          if (cached && cached.dataURL && (!expected || !expected.sha256 || cached.sha256 === expected.sha256)) {
            this.applyMedia(key, cached.dataURL);
            if (cached.sha256) this.syncedHashes[key] = cached.sha256;
            loaded++;
            continue;
          }
          const { data: blob, error } = await sb.storage.from('media').download((expected && expected.path) || this.safePath(key));
          if (error) throw error;
          if (!blob) throw new Error('The cloud returned no media data.');
          const sha256 = await this.sha256Blob(blob);
          if (expected && expected.sha256 && sha256 !== expected.sha256) throw new Error('Media checksum mismatch.');
          const dataURL = await this.blobToDataURL(blob);
          const metadata = {
            sha256, mime: blob.type || (expected && expected.mime), size: blob.size,
            path: (expected && expected.path) || this.safePath(key)
          };
          this.applyMedia(key, dataURL);
          await this.putScopedMedia(this.uid, key, dataURL, metadata);
          this.syncedHashes[key] = sha256;
          loaded++;
        } catch (error) {
          failures.push({ key, error: errorInfo(error) });
          console.warn('Media download failed:', key, error);
        }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, Math.max(1, keys.length)) }, () => loadNext()));
      return { ok: failures.length === 0, loaded, total: keys.length, failures };
    },

    async pull(options) {
      const opts = options || {};
      if (!this.uid) return { ok: false, status: 'no-user', error: { message: 'No active account.' } };
      this.setStatus('Syncing...', 'syncing', 'saving');
      this.emit('pulling', { ok: true, background: !!opts.background });
      let row;
      try {
        row = await this.readCloudRow();
      } catch (error) {
        const local = await this.loadCachedIntoMemory();
        this.ready = true;
        this.setStatus(local.ok ? 'Offline - saved on this device' : 'Offline - no saved copy available', 'error', local.ok ? 'local' : 'failed');
        const result = {
          ok: local.ok, status: local.ok ? 'offline-local' : 'offline-unavailable',
          source: local.source, localSafe: local.ok, error: errorInfo(error)
        };
        this.emit(local.ok ? 'local-safe' : 'failed', result);
        return result;
      }

      const cloudData = row && isPlainObject(row.data) ? row.data : {};
      this.revision = Number((row && row.revision) || 0);
      this.serverUpdatedAt = row ? row.updated_at : null;
      this.serverMediaManifest = clone((row && row.media_manifest) || {});
      this._lastCommittedData = clone(cloudData);
      this.hasCloudData = this.hasRecords(cloudData);

      const outbox = await this.storeGet('outbox', this.uid).catch(() => null);
      if (outbox) this.applyStructured(outbox.data);
      else this.applyStructured(cloudData);

      // Paint metadata and any device-cached media immediately. Full cloud
      // media hydrates in the background with bounded concurrency.
      const cachedMedia = await this.getUserMedia(this.uid).catch(() => []);
      cachedMedia.forEach(item => {
        if (item && item.mediaKey && item.dataURL) this.applyMedia(item.mediaKey, item.dataURL);
      });
      const cacheResult = await this.cacheLocal({
        data: outbox ? outbox.data : cloudData,
        mediaManifest: outbox ? outbox.mediaManifest : this.serverMediaManifest,
        revision: this.revision, updatedAt: this.serverUpdatedAt, pending: !!outbox
      });

      this.ready = true;
      const mediaManifest = outbox ? outbox.mediaManifest || {} : this.serverMediaManifest;
      const mediaKeys = this.referencedMediaKeys();
      const mediaPromise = this.downloadMedia(mediaManifest).then(async mediaResult => {
        if (typeof render === 'function') {
          try { render(); if (typeof buildThumbnails === 'function') buildThumbnails(); } catch (_) {}
        }
        this.emit(mediaResult.ok ? 'media-hydrated' : 'degraded', { ok: mediaResult.ok, operation: 'media', media: mediaResult });
        if (!outbox) {
          const pendingNow = await this.storeGet('outbox', this.uid).catch(() => null);
          if (!pendingNow) this.setStatus(
            this.hasCloudData ? 'Synced' : 'Synced (empty)',
            mediaResult.ok && cacheResult.ok ? 'ok' : 'error',
            mediaResult.ok && cacheResult.ok ? 'saved' : 'degraded'
          );
        }
        return mediaResult;
      });
      this._mediaHydrationPromise = mediaPromise;
      const mediaResult = (opts.awaitMedia || mediaKeys.length === 0)
        ? await mediaPromise
        : { ok: true, pending: true, loaded: cachedMedia.length, total: mediaKeys.length, failures: [] };

      if (outbox) {
        this.setStatus('Saved on this device - syncing...', 'syncing', 'local');
        const pushed = await this.push({ capture: false, reason: 'resume-outbox' });
        return Object.assign({ source: 'outbox', media: mediaResult, cache: cacheResult }, pushed);
      }

      const fullyOk = mediaResult.ok && cacheResult.ok;
      this.setStatus(
        mediaResult.pending ? 'Synced - loading media…' : (this.hasCloudData ? 'Synced' : 'Synced (empty)'),
        fullyOk ? 'ok' : 'error', fullyOk ? 'saved' : 'degraded'
      );
      const result = {
        ok: true, status: fullyOk ? 'synced' : 'synced-with-warnings', source: 'cloud',
        revision: this.revision, media: mediaResult, cache: cacheResult
      };
      this.emit(fullyOk ? 'saved' : 'degraded', result);
      return result;
    },

    // ---- autosave/outbox ------------------------------------------
    schedulePush() {
      if (!this.ready || !this.uid) return { ok: false, status: 'not-ready' };
      clearTimeout(this.pushTimer);
      this.setStatus('Saving...', 'syncing', 'saving');
      this.emit('saving', { ok: true, operation: 'queue' });
      this._queuePromise = this._queuePromise.then(() => this.queueCurrentSnapshot('autosave'));
      this.pushTimer = setTimeout(() => {
        this.push({ capture: false, reason: 'autosave' }).catch(error => {
          console.error('Scheduled cloud save failed', error);
        });
      }, 1800);
      return { ok: true, status: 'scheduled', persisted: this._queuePromise };
    },

    async uploadMedia(entry, options) {
      const opts = options || {};
      const sb = window.sbClient;
      const failures = [];
      const uploaded = [];
      const manifest = entry.mediaManifest || {};
      const changed = Object.keys(manifest).filter(key => {
        const local = manifest[key] || {};
        const remote = this.serverMediaManifest[key] || {};
        return !!local.sha256 && local.sha256 !== remote.sha256;
      });

      let completed = 0;
      for (const key of changed) {
        try {
          const cached = await this.getScopedMedia(this.uid, key);
          if (!cached || !cached.dataURL) throw new Error('The local media copy is missing; structured data was not committed.');
          const expected = manifest[key];
          if (!cached.sha256 || cached.sha256 !== expected.sha256) {
            const actual = await this.mediaMetadata(cached.dataURL);
            if (actual.sha256 !== expected.sha256) throw new Error('The local media checksum changed before upload.');
          }
          const blob = await this.dataURLtoBlob(cached.dataURL);
          const uploadPath = opts.legacy || this._casRpcSupported === false
            ? this.safePath(key)
            : (expected.path || this.contentPath(key, expected.sha256));
          const { error } = await sb.storage.from('media').upload(uploadPath, blob, {
            upsert: true,
            contentType: expected.mime || blob.type || this.mimeOf(cached.dataURL),
            cacheControl: '31536000',
            metadata: { sha256: expected.sha256 }
          });
          if (error) throw error;
          uploaded.push(key);
          completed++;
          if (changed.length > 1) this.setStatus('Uploading ' + completed + '/' + changed.length + '...', 'syncing', 'saving');
        } catch (error) {
          failures.push({ key, error: errorInfo(error) });
          break; // do not commit structured refs after any upload failure
        }
      }
      return { ok: failures.length === 0, uploaded, failures };
    },

    async saveStructuredCas(entry) {
      const sb = window.sbClient;
      if (this._casRpcSupported !== false) {
        const response = await sb.rpc('save_collection_cas', {
          p_expected_revision: Number(entry.baseRevision || 0),
          p_new_data: entry.data,
          p_new_media_manifest: entry.mediaManifest || {}
        });
        if (!response.error) {
          this._casRpcSupported = true;
          const value = Array.isArray(response.data) ? response.data[0] : response.data;
          return value || { status: 'error', message: 'The save RPC returned no result.' };
        }
        if (!missingCasRpc(response.error)) throw response.error;
        this._casRpcSupported = false;
        this.emit('degraded', { ok: true, operation: 'save', message: 'Using timestamp compare-and-swap until the sync migration is installed.' });
        // The legacy schema cannot persist content-addressed paths. Upload a
        // compatibility copy before committing its structured references.
        const legacyUploads = await this.uploadMedia(entry, { legacy: true });
        if (!legacyUploads.ok) throw new Error(legacyUploads.failures[0].error.message);
      }
      return this.saveStructuredTimestampCas(entry);
    },

    async saveStructuredTimestampCas(entry) {
      const sb = window.sbClient;
      const timestamp = new Date().toISOString();
      if (entry.baseUpdatedAt) {
        const update = await sb.from('collections')
          .update({ data: entry.data, updated_at: timestamp })
          .eq('user_id', this.uid).eq('updated_at', entry.baseUpdatedAt)
          .select('data, updated_at').maybeSingle();
        if (update.error) throw update.error;
        if (update.data) {
          return {
            status: 'saved', revision: Number(entry.baseRevision || 0) + 1,
            updated_at: update.data.updated_at, data: update.data.data,
            media_manifest: entry.mediaManifest || {}, fallback: true
          };
        }
      } else {
        const insert = await sb.from('collections')
          .insert({ user_id: this.uid, data: entry.data, updated_at: timestamp })
          .select('data, updated_at').maybeSingle();
        if (!insert.error && insert.data) {
          return {
            status: 'saved', revision: 1, updated_at: insert.data.updated_at,
            data: insert.data.data, media_manifest: entry.mediaManifest || {}, fallback: true
          };
        }
        if (insert.error && !/duplicate|unique|23505/i.test((insert.error.code || '') + ' ' + (insert.error.message || ''))) throw insert.error;
      }

      const current = await sb.from('collections')
        .select('data, updated_at').eq('user_id', this.uid).maybeSingle();
      if (current.error) throw current.error;
      return {
        status: 'conflict', revision: Number(entry.baseRevision || 0) + 1,
        updated_at: current.data && current.data.updated_at,
        data: (current.data && current.data.data) || {}, media_manifest: {}, fallback: true
      };
    },

    mergeStructured(base, local, remote) {
      const conflicts = [];
      const merged = mergeValue(base || {}, local || {}, remote || {}, '', conflicts);
      return { ok: conflicts.length === 0, merged, conflicts: [...new Set(conflicts)] };
    },

    mergeManifests(base, local, remote) {
      const conflicts = [];
      const merged = mergeValue(base || {}, local || {}, remote || {}, 'media', conflicts);
      return { ok: conflicts.length === 0, merged, conflicts: [...new Set(conflicts)] };
    },

    async rebaseConflict(entry, response) {
      const dataMerge = this.mergeStructured(entry.baseData || {}, entry.data || {}, response.data || {});
      const baseManifest = entry.baseMediaManifest || {};
      const manifestMerge = this.mergeManifests(baseManifest, entry.mediaManifest || {}, response.media_manifest || {});
      const conflicts = [...dataMerge.conflicts, ...manifestMerge.conflicts];
      if (conflicts.length) {
        const retained = Object.assign({}, entry, {
          attempts: Number(entry.attempts || 0) + 1,
          conflictAt: new Date().toISOString(),
          conflictPaths: conflicts,
          remoteRevision: Number(response.revision || 0),
          remoteUpdatedAt: response.updated_at || null
        });
        await this.storePut('outbox', retained);
        this.setStatus('Changes safe on this device - merge needs attention', 'error', 'conflict');
        const result = { ok: false, status: 'conflict', localSafe: true, conflicts, revision: response.revision };
        this.emit('conflict', result);
        return result;
      }

      const rebased = Object.assign({}, entry, {
        id: (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random()),
        data: dataMerge.merged,
        mediaManifest: manifestMerge.merged,
        baseData: clone(response.data || {}),
        baseMediaManifest: clone(response.media_manifest || {}),
        baseRevision: Number(response.revision || 0),
        baseUpdatedAt: response.updated_at || null,
        attempts: Number(entry.attempts || 0) + 1,
        rebasedAt: new Date().toISOString()
      });
      await this.storePut('outbox', rebased);
      this.serverMediaManifest = clone(response.media_manifest || {});
      return { ok: true, status: 'rebased', entry: rebased };
    },

    async cleanupDeletedMedia(previousManifest, currentManifest) {
      const paths = [];
      for (const [key, previous] of Object.entries(previousManifest || {})) {
        const current = (currentManifest || {})[key];
        const previousPath = (previous && previous.path) || this.safePath(key);
        const currentPath = current && ((current.path) || this.safePath(key));
        if (!current || previousPath !== currentPath) paths.push(previousPath);
      }
      if (!paths.length) return { ok: true, removed: [], failures: [] };
      // Content-addressed objects may still be referenced by one of the 50
      // server-side recovery revisions. Retain them; a future maintenance job
      // can remove only paths absent from both current and retained manifests.
      if (this._casRpcSupported !== false) {
        return { ok: true, removed: [], retainedForRecovery: [...new Set(paths)], failures: [] };
      }
      const { data, error } = await window.sbClient.storage.from('media').remove([...new Set(paths)]);
      if (error) return { ok: false, removed: [], failures: paths.map(path => ({ path, error: errorInfo(error) })) };
      return { ok: true, removed: paths, failures: [], data };
    },

    async cleanupOrphanMedia(options) {
      const opts = Object.assign({ dryRun: true }, options || {});
      if (!this.uid) return { ok: false, status: 'no-user', unused: [] };
      const keep = new Set();
      const addManifest = manifest => Object.values(manifest || {}).forEach(item => {
        if (item && item.path) keep.add(item.path);
      });
      addManifest(this.serverMediaManifest);
      const versions = await window.sbClient.from('collection_versions')
        .select('media_manifest').eq('user_id', this.uid).limit(50);
      if (versions.error) return { ok: false, status: 'history-unavailable', error: errorInfo(versions.error), unused: [] };
      (versions.data || []).forEach(row => addManifest(row.media_manifest));
      const listed = await window.sbClient.storage.from('media').list(this.uid, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
      if (listed.error) return { ok: false, status: 'list-failed', error: errorInfo(listed.error), unused: [] };
      const unused = (listed.data || []).filter(item => item && item.name && !item.name.endsWith('/'))
        .map(item => this.uid + '/' + item.name).filter(path => !keep.has(path));
      if (opts.dryRun || !unused.length) return { ok: true, status: 'scanned', unused, removed: [] };
      const removed = [];
      for (let index = 0; index < unused.length; index += 100) {
        const batch = unused.slice(index, index + 100);
        const response = await window.sbClient.storage.from('media').remove(batch);
        if (response.error) return { ok: false, status: 'remove-failed', unused, removed, error: errorInfo(response.error) };
        removed.push(...batch);
      }
      return { ok: true, status: 'cleaned', unused, removed };
    },

    async performPush(options) {
      const opts = options || {};
      if (opts.capture !== false) {
        const queued = await this.queueCurrentSnapshot(opts.reason || 'manual');
        if (!queued.ok) return queued;
      } else {
        const queueResult = await this._queuePromise;
        if (queueResult && queueResult.ok === false) return queueResult;
      }

      let entry = await this.storeGet('outbox', this.uid);
      if (!entry) {
        this.setStatus('Synced', 'ok', 'saved');
        const idle = { ok: true, status: 'already-synced', revision: this.revision };
        this.emit('saved', idle);
        return idle;
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        const uploads = await this.uploadMedia(entry);
        if (!uploads.ok) {
          const error = new Error(uploads.failures[0].error.message);
          error.syncDetails = uploads;
          throw error;
        }

        const previousManifest = clone(this.serverMediaManifest || {});
        const response = await this.saveStructuredCas(entry);
        if (response.status === 'conflict') {
          const rebased = await this.rebaseConflict(entry, response);
          if (!rebased.ok) return rebased;
          entry = rebased.entry;
          continue;
        }
        if (response.status !== 'saved') throw new Error(response.message || 'The cloud did not confirm the save.');

        this.revision = Number(response.revision || entry.baseRevision + 1);
        this.serverUpdatedAt = response.updated_at || new Date().toISOString();
        this.serverMediaManifest = clone(response.media_manifest || entry.mediaManifest || {});
        this._lastCommittedData = clone(entry.data);
        this.hasCloudData = this.hasRecords(entry.data);

        const postCommitWarnings = [];
        const currentOutbox = await this.storeGet('outbox', this.uid).catch(error => {
          postCommitWarnings.push({ operation: 'read-outbox-after-commit', error: errorInfo(error) });
          return null;
        });
        if (currentOutbox && currentOutbox.id === entry.id) {
          await this.storeDelete('outbox', this.uid).catch(error => {
            postCommitWarnings.push({ operation: 'clear-outbox-after-commit', error: errorInfo(error) });
          });
        }

        let safetyResult = { ok: true, removed: 0 };
        if (window.VaultDataSafety) {
          try {
            await window.VaultDataSafety.putState(this.uid, entry.data, {
              revision: this.revision, updatedAt: this.serverUpdatedAt, pending: false
            });
            const safetyOutbox = await window.VaultDataSafety.listOutbox(this.uid);
            const committedAt = entry.queuedAt || '';
            const removable = safetyOutbox.filter(item => !committedAt || item.queuedAt <= committedAt);
            for (const item of removable) await window.VaultDataSafety.removeOutbox(this.uid, item.id);
            await window.VaultDataSafety.createBackup(this.uid, entry.data, 'cloud-sync', {
              revision: this.revision, updatedAt: this.serverUpdatedAt
            });
            safetyResult.removed = removable.length;
          } catch (error) {
            safetyResult = { ok: false, error: errorInfo(error) };
            postCommitWarnings.push({ operation: 'vault-data-safety-after-commit', error: errorInfo(error) });
          }
        }

        const currentMemory = this.buildStructured();
        if (equal(currentMemory, entry.data)) this.applyStructured(entry.data);
        const cacheResult = await this.cacheLocal({
          data: entry.data, mediaManifest: this.serverMediaManifest,
          revision: this.revision, updatedAt: this.serverUpdatedAt, pending: false
        });
        const cleanup = await this.cleanupDeletedMedia(previousManifest, this.serverMediaManifest).catch(error => ({
          ok: false, removed: [], failures: [{ error: errorInfo(error) }]
        }));
        if (typeof hasUnsavedChanges !== 'undefined') hasUnsavedChanges = false;
        this.saveFailureNotified = false;
        clearTimeout(this._retryTimer);
        const postCommitOk = cleanup.ok && cacheResult.ok && safetyResult.ok && postCommitWarnings.length === 0;
        this.setStatus('Synced', postCommitOk ? 'ok' : 'error', postCommitOk ? 'saved' : 'degraded');
        const result = {
          ok: true, status: postCommitOk ? 'synced' : 'synced-with-warnings',
          revision: this.revision, updatedAt: this.serverUpdatedAt,
          uploaded: uploads.uploaded, cleanup, cache: cacheResult, safety: safetyResult,
          warnings: postCommitWarnings,
          usedFallback: !!response.fallback
        };
        this.emit(postCommitOk ? 'saved' : 'degraded', result);
        if (this._broadcast) {
          try { this._broadcast.postMessage({ type: 'saved', uid: this.uid, source: this._sourceId, revision: this.revision, updatedAt: this.serverUpdatedAt }); } catch (_) {}
        }
        return result;
      }
      throw new Error('Could not converge after three background merge attempts.');
    },

    async handlePushFailure(error) {
      console.error('Cloud save failed', error);
      const outbox = await this.storeGet('outbox', this.uid).catch(() => null);
      const safetyOutbox = !outbox && window.VaultDataSafety
        ? await window.VaultDataSafety.listOutbox(this.uid).catch(() => [])
        : [];
      if (outbox && outbox.vaultOutboxId && window.VaultDataSafety) {
        await window.VaultDataSafety.noteOutboxAttempt(this.uid, outbox.vaultOutboxId, error).catch(noteError => {
          console.warn('Could not record the outbox retry', noteError);
        });
      }
      const localSafe = !!outbox || safetyOutbox.length > 0;
      const offline = navigator.onLine === false;
      if (localSafe) {
        this.setStatus(offline ? 'Offline - changes saved on this device' : 'Cloud save failed - will retry', 'error', 'local');
        if (!offline) {
          clearTimeout(this._retryTimer);
          this._retryTimer = setTimeout(() => this.push({ capture: false, reason: 'retry' }), 8000);
        }
      } else {
        this.setStatus('Save failed - changes are not safe yet', 'error', 'failed');
      }
      if (!this.saveFailureNotified && window.toast) {
        const message = localSafe
          ? (offline
            ? 'Cloud save paused while offline. Your changes are safe on this device and will upload automatically when you reconnect.'
            : 'Cloud save failed. Your changes are safe on this device; the app will retry automatically.')
          : 'Save failed on this device and in the cloud. Keep this page open and retry.';
        window.toast(message, 'error', 8000);
        this.saveFailureNotified = true;
      }
      const result = { ok: false, status: localSafe ? (offline ? 'offline-local' : 'retrying') : 'unsafe', localSafe, error: errorInfo(error) };
      this.emit(localSafe ? 'local-safe' : 'failed', result);
      return result;
    },

    async push(options) {
      if (!this.ready || !this.uid) return { ok: false, status: 'not-ready' };
      if (this.pushing) {
        this.pendingPush = true;
        return { ok: true, status: 'queued-behind-active-save' };
      }
      this.pushing = true;
      this.setStatus('Saving...', 'syncing', 'saving');
      this.emit('saving', { ok: true, operation: 'cloud' });
      try {
        return await this.performPush(options);
      } catch (error) {
        return await this.handlePushFailure(error);
      } finally {
        this.pushing = false;
        if (this.pendingPush) {
          this.pendingPush = false;
          this.schedulePush();
        }
      }
    },

    async syncNow() {
      clearTimeout(this.pushTimer);
      const queued = await this.queueCurrentSnapshot('manual');
      if (!queued.ok) return queued;
      return this.push({ capture: false, reason: 'manual' });
    },

    async prepareForSignOut() {
      clearTimeout(this.pushTimer);
      let outbox = this.uid ? await this.storeGet('outbox', this.uid).catch(() => null) : null;
      const memoryDirty = typeof hasUnsavedChanges !== 'undefined' && hasUnsavedChanges;
      const noChanges = !memoryDirty && !outbox;
      const queued = this.ready && memoryDirty
        ? await this.queueCurrentSnapshot('sign-out')
        : { ok: true, status: outbox ? 'already-queued' : 'no-changes' };
      if (!outbox && queued.ok && queued.status !== 'no-changes') {
        outbox = await this.storeGet('outbox', this.uid).catch(() => null);
      }
      let cloud = outbox ? { ok: false, status: 'not-attempted' } : { ok: noChanges, status: noChanges ? 'already-synced' : 'not-attempted' };
      if (outbox && this.ready) cloud = await this.push({ capture: false, reason: 'sign-out' });
      outbox = this.uid ? await this.storeGet('outbox', this.uid).catch(() => null) : null;
      const safetyOutbox = !outbox && this.uid && window.VaultDataSafety
        ? await window.VaultDataSafety.listOutbox(this.uid).catch(() => [])
        : [];
      const localSafe = !!outbox || safetyOutbox.length > 0 || queued.status === 'local-safe';
      const cloudSafe = !!cloud.ok && cloud.status !== 'queued-behind-active-save';
      const ok = noChanges || localSafe || cloudSafe;
      const result = {
        ok, status: noChanges ? 'no-changes' : ok ? (cloudSafe ? 'cloud-safe' : 'local-safe') : 'unsafe',
        noChanges, localSafe, cloudSafe, cloud
      };
      this.emit(ok ? (cloudSafe ? 'saved' : 'local-safe') : 'failed', Object.assign({ operation: 'sign-out-check' }, result));
      return result;
    },

    // ---- backup restore -------------------------------------------
    async readBackupText(file) {
      const isZip = /\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
      if (!isZip) return file.text();
      if (!window.JSZip && window.VaultAssets && typeof window.VaultAssets.ensure === 'function') {
        try { await window.VaultAssets.ensure('zip'); } catch (_) {}
      }
      if (!window.JSZip) throw new Error('Zip reader not loaded - try the .json instead.');
      const zip = await window.JSZip.loadAsync(file);
      const entry = Object.values(zip.files).find(item => !item.dir && /\.json$/i.test(item.name));
      if (!entry) throw new Error('No .json file found inside that .zip.');
      return entry.async('string');
    },

    validateBackup(data) {
      const source = Array.isArray(data) ? { firearms: data } : data;
      if (window.VaultSecurity) {
        return window.VaultSecurity.normalizeDatabase(source, {
          regenerateInvalidIds: true,
          allowUnknownTopLevel: true
        }).data;
      }
      if (!isPlainObject(source) || !Array.isArray(source.firearms)) throw new Error('No firearms array was found in that file.');
      const arrays = ['firearms', 'ammo', 'accessories', 'wishlist', 'dealers', 'auditTrail', 'valueHistory'];
      arrays.forEach(key => {
        if (source[key] !== undefined && !Array.isArray(source[key])) throw new Error('The backup field "' + key + '" must be an array.');
      });
      if (source.images !== undefined && !isPlainObject(source.images)) throw new Error('The backup images field is invalid.');
      return source;
    },

    async restoreFromFile(file) {
      const text = await this.readBackupText(file);
      let parsed;
      try { parsed = JSON.parse(text); } catch (_) { throw new Error('That file is not valid JSON.'); }
      if (parsed && parsed.format === 'firearms-vault-backup' && window.VaultDataSafety) {
        if (parsed.encrypted) throw new Error('This encrypted backup must be opened from Data & backups with its password.');
        parsed = (await window.VaultDataSafety.importEnvelope(parsed, null)).data;
      }
      const data = this.validateBackup(parsed);
      this.applyStructured(Object.assign({ version: 3, encrypted: false }, data));
      db.backups = [];

      const images = data.images || {};
      for (const [key, value] of Object.entries(images)) {
        if (typeof value !== 'string' || !value.startsWith('data:')) continue;
        imagesDb[key] = value;
        const metadata = await this.mediaMetadata(value);
        await this.putScopedMedia(this.uid, key, value, metadata);
        if (typeof idbPut === 'function') await idbPut(key, value);
      }

      this.ready = true;
      if (typeof updateStats === 'function') updateStats();
      if (typeof render === 'function') render();
      if (typeof window.buildThumbnails === 'function') window.buildThumbnails();
      const queued = await this.queueCurrentSnapshot('restore');
      if (!queued.ok) throw new Error(queued.error.message);
      const cloud = await this.push({ capture: false, reason: 'restore' });
      return {
        firearms: db.firearms.length, ammo: db.ammo.length, accessories: db.accessories.length,
        images: Object.keys(images).length, cloud
      };
    }
  };

  window.CloudSync = CloudSync;

  window.addEventListener('online', () => {
    if (CloudSync.ready) {
      CloudSync.setStatus('Back online - syncing...', 'syncing', 'saving');
      CloudSync.push({ capture: false, reason: 'online' });
    }
  });
  window.addEventListener('offline', () => {
    if (CloudSync.ready) CloudSync.setStatus('Offline - changes saved on this device', 'error', 'local');
  });
})();
