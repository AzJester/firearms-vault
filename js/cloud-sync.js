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

  function mergeArray(base, local, remote, path, conflicts, conflictWinner) {
    const preferRemote = conflictWinner === 'remote';
    const allPrimitive = [base, local, remote].every(list =>
      list.every(item => item === null || (typeof item !== 'object' && typeof item !== 'function')));

    if (allPrimitive) {
      // Primitive lists (tags, image ids, etc.) are three-way sets. An item
      // that existed in the base survives only when both devices kept it;
      // otherwise a deletion on either device would be silently resurrected.
      // Independent additions still merge as a stable union.
      const baseKeys = new Set(base.map(canonical));
      const localKeys = new Set(local.map(canonical));
      const remoteKeys = new Set(remote.map(canonical));
      const seen = new Set();
      const out = [];
      [...remote, ...local, ...base].forEach(item => {
        const key = canonical(item);
        if (seen.has(key)) return;
        seen.add(key);
        const present = baseKeys.has(key)
          ? localKeys.has(key) && remoteKeys.has(key)
          : localKeys.has(key) || remoteKeys.has(key);
        if (present) out.push(clone(item));
      });
      return out;
    }
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
          out.push(clone(preferRemote ? r : l));
        }
        continue;
      }

      if (l === undefined) {
        if (equal(r, b)) continue; // local deletion, remote unchanged
        conflicts.push(itemPath);
        if (preferRemote) out.push(clone(r));
        continue;
      }
      if (r === undefined) {
        if (equal(l, b)) continue; // remote deletion, local unchanged
        conflicts.push(itemPath);
        if (!preferRemote) out.push(clone(l));
        continue;
      }

      out.push(mergeValue(b, l, r, itemPath, conflicts, conflictWinner));
    }
    return out;
  }

  function mergeValue(base, local, remote, path, conflicts, conflictWinner) {
    const preferRemote = conflictWinner === 'remote';
    if (equal(local, remote)) return clone(local);
    if (equal(local, base)) return clone(remote);
    if (equal(remote, base)) return clone(local);

    if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
      return mergeArray(base, local, remote, path, conflicts, conflictWinner);
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
          // A brand-new collection can legitimately have a sparse `{}` cloud
          // base. Treat independently populated arrays/objects as changes
          // from their canonical empty value so disjoint first edits from two
          // tabs merge by record/field instead of conflicting on the entire
          // top-level property.
          else if (Array.isArray(local[key]) && Array.isArray(remote[key])) {
            out[key] = mergeValue([], local[key], remote[key], keyPath, conflicts, conflictWinner);
          } else if (isPlainObject(local[key]) && isPlainObject(remote[key])) {
            out[key] = mergeValue({}, local[key], remote[key], keyPath, conflicts, conflictWinner);
          }
          else { conflicts.push(keyPath); out[key] = clone(preferRemote ? remote[key] : local[key]); }
          continue;
        }
        if (!lHas) {
          if (!rHas || equal(remote[key], base[key])) continue;
          conflicts.push(keyPath);
          if (preferRemote) out[key] = clone(remote[key]);
          continue;
        }
        if (!rHas) {
          if (equal(local[key], base[key])) continue;
          conflicts.push(keyPath);
          if (!preferRemote) out[key] = clone(local[key]);
          continue;
        }
        out[key] = mergeValue(base[key], local[key], remote[key], keyPath, conflicts, conflictWinner);
      }
      return out;
    }

    conflicts.push(path || 'root');
    return clone(preferRemote ? remote : local);
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
    missingMedia: [],
    pendingConflict: null,
    _accountEpoch: 0,
    _pullGeneration: 0,
    _mutationGeneration: 0,
    _runtimeWrites: new Set(),
    _mediaHydrationPromise: null,
    _activePushPromise: null,
    _runtimeWritesBlocked: false,

    accountContext(uid) {
      return { uid: uid || this.uid, epoch: this._accountEpoch };
    },

    contextActive(context) {
      return !!context && !!context.uid && context.uid === this.uid && context.epoch === this._accountEpoch &&
        (context.pullGeneration === undefined || context.pullGeneration === this._pullGeneration);
    },

    staleResult(operation) {
      return { ok: false, status: 'account-changed', cancelled: true, operation: operation || 'sync' };
    },

    beginAccountTransition(uid) {
      clearTimeout(this.pushTimer);
      clearTimeout(this._retryTimer);
      if (this._broadcast) { try { this._broadcast.close(); } catch (_) {} }
      this._broadcast = null;
      this._accountEpoch += 1;
      this.uid = uid || null;
      // app.js compatibility-store wrappers consult this synchronously. Block
      // new writes as soon as sign-out/account teardown begins; activation for
      // a concrete uid explicitly re-enables them.
      this._runtimeWritesBlocked = !uid;
      this.ready = false;
      this.pushing = false;
      this.pendingPush = false;
      this._queuePromise = Promise.resolve({ ok: true, status: 'queue-reset' });
      this._mediaHydrationPromise = null;
      this._activePushPromise = null;
      this._mutationGeneration = 0;
      this._pullGeneration = 0;
      return this.accountContext(uid);
    },

    async quiesceRuntimeWrites() {
      const writes = [...this._runtimeWrites];
      if (writes.length) await Promise.allSettled(writes);
    },

    async writeRuntime(context, writer) {
      if (!this.contextActive(context)) return false;
      let operation;
      try { operation = Promise.resolve().then(writer); }
      catch (error) { throw error; }
      this._runtimeWrites.add(operation);
      try {
        await operation;
        return this.contextActive(context);
      } finally {
        this._runtimeWrites.delete(operation);
      }
    },

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

    mediaStatusText(mediaResult) {
      const unavailable = Number(((mediaResult && mediaResult.failures) || []).length);
      if (unavailable) {
        return 'Saved to cloud - ' + unavailable + ' attachment' + (unavailable === 1 ? '' : 's') + ' need' + (unavailable === 1 ? 's' : '') + ' recovery';
      }
      return this.hasCloudData ? 'Saved to cloud' : 'Saved to cloud (empty)';
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

    async storeGetAll(storeName) {
      const database = await this.openSyncDb();
      return new Promise((resolve, reject) => {
        const tx = database.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error('Could not read all records from ' + storeName));
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

    async storeDeleteIfId(storeName, key, expectedId) {
      const database = await this.openSyncDb();
      return new Promise((resolve, reject) => {
        const tx = database.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = store.get(key);
        let current = null;
        let deleted = false;
        request.onsuccess = () => {
          current = request.result || null;
          if (current && current.id === expectedId) {
            store.delete(key);
            deleted = true;
          }
        };
        tx.oncomplete = () => resolve({ deleted, current });
        tx.onerror = () => reject(tx.error || new Error('Could not conditionally delete from ' + storeName));
        tx.onabort = () => reject(tx.error || new Error('Conditional delete from ' + storeName + ' was aborted'));
      });
    },

    async storeReplaceIfId(storeName, key, expectedId, value) {
      const database = await this.openSyncDb();
      return new Promise((resolve, reject) => {
        const tx = database.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = store.get(key);
        let current = null;
        let replaced = false;
        request.onsuccess = () => {
          current = request.result || null;
          if (current && current.id === expectedId) {
            store.put(value);
            replaced = true;
          }
        };
        tx.oncomplete = () => resolve({ replaced, current });
        tx.onerror = () => reject(tx.error || new Error('Could not conditionally replace ' + storeName));
        tx.onabort = () => reject(tx.error || new Error('Conditional replace of ' + storeName + ' was aborted'));
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

    async clearRuntimeCaches(options) {
      const opts = options || {};
      // Public callers use this immediately before auth sign-out. Invalidate
      // old continuations before clearing so a late pull cannot repopulate the
      // just-cleared compatibility cache. Account activation passes preserve.
      if (!opts.preserveAccount && this.uid) {
        this.beginAccountTransition(null);
        await this.quiesceRuntimeWrites();
      }
      const failures = [];
      try { await runtimeClear(APP_STATE_DB); } catch (error) { failures.push({ store: 'state', error: errorInfo(error) }); }
      try { await runtimeClear(APP_MEDIA_DB); } catch (error) { failures.push({ store: 'media', error: errorInfo(error) }); }
      return { ok: failures.length === 0, failures };
    },

    clearMemoryMedia() {
      Object.keys(imagesDb || {}).forEach(key => { delete imagesDb[key]; });
      (db.firearms || []).forEach(firearm => {
        if (typeof firearm.receipt === 'string' && firearm.receipt.startsWith('data:')) firearm.receipt = null;
        if (typeof firearm.stampPdf === 'string' && firearm.stampPdf.startsWith('data:')) firearm.stampPdf = null;
        (firearm.documents || []).forEach(document => { if (document.data) delete document.data; });
      });
      [...(db.ammo || []), ...(db.accessories || [])].forEach(record => {
        if (typeof record.receipt === 'string' && record.receipt.startsWith('data:')) record.receipt = null;
      });
    },

    localRecordTime(record) {
      if (!record) return 0;
      const metadata = isPlainObject(record.metadata) ? record.metadata : {};
      return [
        record.queuedAt, record.cachedAt, record.savedAt, record.updatedAt,
        record.rebasedAt, record.conflictAt, metadata.queuedAt,
        metadata.updatedAt, metadata.rebasedAt, metadata.conflictAt
      ].reduce((latest, value) => {
        const parsed = Date.parse(String(value || ''));
        return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
      }, 0);
    },

    newestSafetyRecovery(safetyOutbox, safetyState) {
      const entries = Array.isArray(safetyOutbox) ? safetyOutbox : [];
      const latestOutbox = entries.length ? entries[entries.length - 1] : null;
      const stateRecovery = safetyState ? {
        data: safetyState.data,
        mediaManifest: clone((safetyState.metadata && safetyState.metadata.mediaManifest) || {}),
        metadata: clone(safetyState.metadata || {}),
        checksum: safetyState.checksum || null,
        savedAt: safetyState.savedAt || null,
        safety: true,
        safetySource: 'state'
      } : null;
      const outboxRecovery = latestOutbox ? {
        data: latestOutbox.payload,
        mediaManifest: clone((latestOutbox.metadata && latestOutbox.metadata.mediaManifest) || {}),
        metadata: Object.assign({ pending: true, baseRevision: latestOutbox.baseRevision }, clone(latestOutbox.metadata || {})),
        checksum: latestOutbox.checksum || null,
        savedAt: latestOutbox.queuedAt || null,
        safetyOutboxId: latestOutbox.id || null,
        safety: true,
        safetySource: 'outbox'
      } : null;
      // A state record is written immediately before its matching secondary
      // outbox entry. Keep the state's richer manifest/base metadata when both
      // checksums describe the same exact snapshot.
      if (stateRecovery && outboxRecovery && stateRecovery.checksum && stateRecovery.checksum === outboxRecovery.checksum) {
        stateRecovery.savedAt = this.localRecordTime(outboxRecovery) >= this.localRecordTime(stateRecovery)
          ? outboxRecovery.savedAt : stateRecovery.savedAt;
        stateRecovery.safetyOutboxId = outboxRecovery.safetyOutboxId;
        return stateRecovery;
      }
      // putState runs before enqueue. If enqueue fails, the state mirror is
      // newer than every older queued entry and must win crash recovery.
      if (stateRecovery && (!outboxRecovery || this.localRecordTime(stateRecovery) >= this.localRecordTime(outboxRecovery))) return stateRecovery;
      if (outboxRecovery) return outboxRecovery;
      return null;
    },

    selectLocalRecovery(outbox, cached, safetyRecovery) {
      const primary = outbox
        ? Object.assign({ localSource: 'outbox' }, outbox)
        : cached ? Object.assign({ localSource: 'cache' }, cached) : null;
      if (!safetyRecovery) return primary;
      if (!primary) return safetyRecovery;
      const sameData = equal(primary.data || {}, safetyRecovery.data || {});
      const sameManifest = equal(primary.mediaManifest || {}, safetyRecovery.mediaManifest || {});
      if (sameData && sameManifest) return primary;
      const safetyPending = safetyRecovery.safetySource === 'outbox' ||
        !!(safetyRecovery.metadata && safetyRecovery.metadata.pending);
      // A pending recovery snapshot must not be hidden by a later read of an
      // older non-pending cache. A genuinely newer primary outbox still wins.
      if (safetyPending && primary.localSource === 'cache' && !primary.pending) return safetyRecovery;
      const primaryGeneration = Number(primary.recoveredFromSafety
        ? primary.recoveredMutationGeneration || 0
        : primary.mutationGeneration || 0);
      const safetyGeneration = Number(safetyRecovery.metadata && safetyRecovery.metadata.mutationGeneration || 0);
      const primarySource = String(primary.sourceId || '');
      const safetySource = String(safetyRecovery.metadata && safetyRecovery.metadata.sourceId || '');
      const sameRuntimeSource = !!primarySource && primarySource === safetySource;
      if (sameRuntimeSource && safetyPending && safetyGeneration > primaryGeneration) return safetyRecovery;
      if (sameRuntimeSource && primaryGeneration > safetyGeneration) return primary;
      // Prefer primary on a true tie. Rebase/conflict timestamps above let a
      // newer primary win even though its original queuedAt is unchanged.
      return this.localRecordTime(safetyRecovery) > this.localRecordTime(primary) ? safetyRecovery : primary;
    },

    isPendingSafetyRecovery(recovery) {
      return !!(recovery && (recovery.safetySource === 'outbox' ||
        !!(recovery.metadata && recovery.metadata.pending)));
    },

    withOutboxLock(context, operation) {
      const account = context || this.accountContext();
      if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
        return navigator.locks.request('firearms-vault-outbox-v1:' + account.uid, { mode: 'exclusive' }, operation);
      }
      return Promise.resolve().then(operation);
    },

    ensurePrimaryPendingOutbox(context) {
      const account = context || this.accountContext();
      return this.withOutboxLock(account, () => this.ensurePrimaryPendingOutboxUnlocked(account));
    },

    async ensurePrimaryPendingOutboxUnlocked(context) {
      const account = context || this.accountContext();
      if (!this.contextActive(account)) return this.staleResult('recover-pending-outbox');
      let outbox = null;
      let cached = null;
      let safetyRecovery = null;
      try {
        outbox = await this.storeGet('outbox', account.uid);
        if (!this.contextActive(account)) return this.staleResult('recover-pending-outbox');
        cached = await this.storeGet('cache', account.uid);
        if (!this.contextActive(account)) return this.staleResult('recover-pending-outbox');
        if (window.VaultDataSafety) {
          const safetyOutbox = await window.VaultDataSafety.listOutbox(account.uid);
          if (!this.contextActive(account)) return this.staleResult('recover-pending-outbox');
          const safetyState = await window.VaultDataSafety.getState(account.uid);
          if (!this.contextActive(account)) return this.staleResult('recover-pending-outbox');
          safetyRecovery = this.newestSafetyRecovery(safetyOutbox, safetyState);
        }
        let selected = this.selectLocalRecovery(outbox, cached, safetyRecovery);
        if (selected && selected.safety && this.isPendingSafetyRecovery(selected)) {
          try {
            outbox = await this.promoteSafetyRecovery(account.uid, selected, outbox, cached, account);
          } catch (error) {
            // Promotion writes the primary outbox before its cache. A cache
            // failure must not hide a successfully recovered retry entry.
            outbox = await this.storeGet('outbox', account.uid).catch(() => null);
            if (!outbox) {
              return { ok: false, status: 'secondary-recovery-pending', localSafe: true,
                secondaryPending: true, safetyRecovery: selected, selected, cached, error: errorInfo(error) };
            }
          }
          if (!this.contextActive(account)) return this.staleResult('recover-pending-outbox');
          selected = outbox;
        }
        return {
          ok: true, status: outbox ? 'outbox-ready' : 'no-outbox', outbox,
          secondaryPending: this.isPendingSafetyRecovery(safetyRecovery), safetyRecovery,
          selected: selected || outbox || cached || null, cached
        };
      } catch (error) {
        if (!this.contextActive(account)) return this.staleResult('recover-pending-outbox');
        return { ok: false, status: 'recovery-read-failed', localSafe: this.isPendingSafetyRecovery(safetyRecovery),
          secondaryPending: this.isPendingSafetyRecovery(safetyRecovery), safetyRecovery,
          selected: safetyRecovery || outbox || cached || null, cached, error: errorInfo(error) };
      }
    },

    async promoteSafetyRecovery(uid, recovery, outbox, cached, context) {
      const account = context || this.accountContext(uid);
      if (!this.contextActive(account)) return this.staleResult('promote-safety-recovery');
      const metadata = isPlainObject(recovery && recovery.metadata) ? recovery.metadata : {};
      const pendingData = metadata.pendingEntryData || recovery.data || {};
      const fallbackManifest = clone((outbox && outbox.mediaManifest) || (cached && cached.mediaManifest) || {});
      const manifest = clone(recovery.mediaManifest || metadata.mediaManifest || {});
      const fingerprints = clone(metadata.mediaFingerprints || {});
      for (const key of this.referencedMediaKeys(pendingData)) {
        let scoped = null;
        try { scoped = await this.getScopedMedia(uid, key); } catch (_) {}
        if (!this.contextActive(account)) return this.staleResult('promote-safety-recovery');
        if (scoped && scoped.dataURL) {
          const actual = await this.mediaMetadata(scoped.dataURL);
          if (!this.contextActive(account)) return this.staleResult('promote-safety-recovery');
          if (!manifest[key] || !manifest[key].sha256 || manifest[key].sha256 !== actual.sha256) {
            manifest[key] = {
              sha256: actual.sha256,
              mime: actual.mime,
              size: actual.size,
              path: scoped.sha256 === actual.sha256 && scoped.path
                ? scoped.path
                : this.contentPath(key, actual.sha256, uid)
            };
          }
          if (!fingerprints[key]) fingerprints[key] = this.mediaFingerprint(scoped.dataURL);
        } else if (!manifest[key] && fallbackManifest[key]) {
          manifest[key] = clone(fallbackManifest[key]);
        } else if (!manifest[key]) {
          manifest[key] = { sha256: null, mime: null, size: null, preserved: true };
        }
      }
      const baseData = metadata.baseData || (outbox && outbox.baseData) || (cached && cached.data) || {};
      const baseManifest = metadata.baseMediaManifest || (outbox && outbox.baseMediaManifest) || fallbackManifest;
      const entry = {
        uid,
        id: metadata.entryId || (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random()),
        data: clone(pendingData),
        mediaManifest: manifest,
        baseData: clone(baseData),
        baseMediaManifest: clone(baseManifest || {}),
        baseRevision: Number(metadata.baseRevision !== undefined ? metadata.baseRevision : (outbox ? outbox.baseRevision : cached && cached.revision) || 0),
        baseUpdatedAt: metadata.baseUpdatedAt !== undefined ? metadata.baseUpdatedAt : (outbox ? outbox.baseUpdatedAt : cached && cached.updatedAt) || null,
        queuedAt: recovery.savedAt || metadata.queuedAt || new Date().toISOString(),
        reason: 'secondary-recovery',
        attempts: Number(metadata.attempts || 0),
        // This is a freshly promoted entry for the current runtime epoch. A
        // generation copied from the crashed session would make a successful
        // cloud commit look as though newer unsaved work still existed.
        mutationGeneration: Number(this._mutationGeneration || 0),
        recoveredMutationGeneration: Number(metadata.mutationGeneration || 0),
        sourceId: metadata.sourceId || this._sourceId,
        crossTabMerged: !!metadata.crossTabMerged,
        mediaFingerprints: fingerprints,
        vaultStateChecksum: recovery.checksum || null,
        vaultOutboxId: recovery.safetyOutboxId || null,
        recoveredFromSafety: true
      };
      if (Array.isArray(metadata.conflictPaths) && metadata.conflictPaths.length) {
        entry.conflictPaths = [...new Set(metadata.conflictPaths.map(String))];
        entry.conflictAt = metadata.conflictAt || entry.queuedAt;
        entry.conflictSource = metadata.conflictSource || 'recovery';
        entry.remoteRevision = Number(metadata.remoteRevision || entry.baseRevision);
        entry.remoteUpdatedAt = metadata.remoteUpdatedAt || entry.baseUpdatedAt;
        entry.conflictRemoteData = clone(metadata.conflictRemoteData || {});
        entry.conflictRemoteMediaManifest = clone(metadata.conflictRemoteMediaManifest || {});
        entry.conflictRemoteSourceId = metadata.conflictRemoteSourceId || null;
        entry.conflictLocalSourceId = metadata.conflictLocalSourceId || null;
        entry.conflictSourceSnapshots = clone(metadata.conflictSourceSnapshots || {});
      }
      await this.storePut('outbox', entry);
      if (!this.contextActive(account)) return this.staleResult('promote-safety-recovery');
      await this.storePut('cache', {
        uid, data: clone(entry.data), revision: entry.baseRevision,
        updatedAt: entry.baseUpdatedAt, mediaManifest: clone(entry.mediaManifest),
        pending: true, cachedAt: entry.queuedAt, recoveredFromSafety: true
      });
      if (!this.contextActive(account)) return this.staleResult('promote-safety-recovery');
      return entry;
    },

    async hydrateRuntime(uid, context) {
      const account = context || this.accountContext(uid);
      try {
        const reconciled = await this.ensurePrimaryPendingOutbox(account);
        if (!this.contextActive(account)) return this.staleResult('hydrate-runtime');
        if (!reconciled.ok && !reconciled.selected) throw new Error((reconciled.error && reconciled.error.message) || 'Could not read the device recovery copy.');
        const sourceEntry = reconciled.selected || reconciled.outbox || reconciled.cached;
        const sourceManifest = sourceEntry && sourceEntry.mediaManifest || {};
        const source = sourceEntry && sourceEntry.data;
        if (source) {
          const written = await this.writeRuntime(account, () => runtimePut(APP_STATE_DB, 'db', clone(source)));
          if (!written) return this.staleResult('hydrate-runtime');
        }
        const media = await this.getUserMedia(uid);
        if (!this.contextActive(account)) return this.staleResult('hydrate-runtime');
        for (const item of media) {
          const expected = sourceManifest[item.mediaKey] || null;
          const actual = await this.mediaMetadata(item.dataURL).catch(() => null);
          if (!this.contextActive(account)) return this.staleResult('hydrate-runtime');
          if (!actual || (expected && expected.sha256 && actual.sha256 !== expected.sha256)) continue;
          const written = await this.writeRuntime(account, () => runtimePut(APP_MEDIA_DB, item.mediaKey, item.dataURL));
          if (!written) return this.staleResult('hydrate-runtime');
        }
        return { ok: true, hydrated: !!source, media: media.length };
      } catch (error) {
        if (!this.contextActive(account)) return this.staleResult('hydrate-runtime');
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
          const account = this.accountContext();
          const message = event.data || {};
          if (!this.contextActive(account) || message.uid !== account.uid || message.source === this._sourceId) return;
          if (message.type === 'saved') {
            const pending = await this.storeGet('outbox', account.uid).catch(() => null);
            if (!this.contextActive(account)) return;
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
      const previousUid = this.uid;
      const account = this.beginAccountTransition(uid);
      try {
        // Account transitions invalidate every old async continuation first.
        // Wait only for already-started shared runtime writes; hashing/network
        // work is safely detached and cannot write after its epoch changes.
        await this.quiesceRuntimeWrites();
        if (!this.contextActive(account)) return this.staleResult('activate-account');
        await this.openSyncDb();
        if (!this.contextActive(account)) return this.staleResult('activate-account');
        const previous = localStorage.getItem(ACTIVE_USER_KEY);

        // A pre-upgrade cache belongs to the currently authenticated account.
        if (!previous && !previousUid) {
          const captured = await this.captureLegacyRuntime(uid);
          if (!this.contextActive(account)) return this.staleResult('activate-account');
          if (!captured.ok) throw new Error(captured.error.message || 'Could not preserve the existing device copy.');
        }

        if ((previous && previous !== uid) || (previousUid && previousUid !== uid)) {
          // The outgoing user's persistent outbox/cache remains locked under
          // their uid. Only the shared compatibility stores are cleared.
          const cleared = await this.clearRuntimeCaches({ preserveAccount: true });
          if (!this.contextActive(account)) return this.staleResult('activate-account');
          if (!cleared.ok) throw new Error('Could not isolate the previous account cache.');
          this.clearMemoryMedia();
        }

        this.revision = 0;
        this.serverUpdatedAt = null;
        this.serverMediaManifest = {};
        this.syncedHashes = {};
        this.missingMedia = [];
        this.pendingConflict = null;
        this._lastCommittedData = null;
        this._sourceId = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random());
        localStorage.setItem(ACTIVE_USER_KEY, uid);

        // Always reconcile the uid-scoped primary stores with the secondary
        // recovery mirror. A reload normally keeps the same uid marker, but a
        // failed primary outbox write can leave a newer exact snapshot only in
        // VaultDataSafety. Skipping hydration for that common same-user path
        // would make the newer recovery unreachable.
        const hydrated = await this.hydrateRuntime(uid, account);
        if (!this.contextActive(account)) return this.staleResult('activate-account');
        if (!hydrated.ok) throw new Error(hydrated.error.message);
        this.initBroadcast();
        this.emit('account-ready', { ok: true });
        return { ok: true, status: 'account-ready', changed: !!previous && previous !== uid };
      } catch (error) {
        if (!this.contextActive(account)) return this.staleResult('activate-account');
        this.emit('failed', { ok: false, operation: 'activate-account', error: errorInfo(error) });
        return { ok: false, status: 'activation-failed', error: errorInfo(error) };
      }
    },

    async deactivateUser(options) {
      const opts = options || {};
      const uid = this.uid;
      this.beginAccountTransition(null);
      if (this._broadcast) { try { this._broadcast.close(); } catch (_) {} }
      this._broadcast = null;
      await this.quiesceRuntimeWrites();
      const cleared = opts.clearRuntime === false ? { ok: true, failures: [] } : await this.clearRuntimeCaches();
      // Keep the previous uid marker when runtime clearing failed. A later
      // account activation will then retry isolation instead of adopting the
      // uncleared compatibility cache as the new user's data.
      if (cleared.ok || opts.clearRuntime === false) {
        try { localStorage.removeItem(ACTIVE_USER_KEY); } catch (_) {}
      }
      this.ready = false;
      this.missingMedia = [];
      this.pendingConflict = null;
      this.emit('signed-out', { ok: cleared.ok, previousUid: uid, failures: cleared.failures });
      return { ok: cleared.ok, status: 'signed-out', failures: cleared.failures };
    },

    // ---- data and media helpers ----------------------------------
    safePath(key, uid) {
      const owner = uid || this.uid;
      if (!owner) throw new Error('Cannot create a media path without an active user.');
      return owner + '/' + String(key).replace(/[^A-Za-z0-9._-]/g, '_');
    },

    contentPath(key, sha256, uid) {
      return this.safePath(key, uid) + '--' + String(sha256 || 'legacy').slice(0, 32);
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

    referencedMediaKeys(source) {
      const database = source || db;
      const keys = new Set();
      const refKey = value => (typeof value === 'string' && value.startsWith('@media:')) ? value.slice(7) : null;
      (database.firearms || []).forEach(firearm => {
        (firearm.images || []).forEach(id => keys.add(id));
        let key = refKey(firearm.receipt); if (key) keys.add(key);
        key = refKey(firearm.stampPdf); if (key) keys.add(key);
        (firearm.documents || []).forEach(document => keys.add('doc:' + firearm.id + ':' + document.id));
      });
      (database.ammo || []).forEach(ammo => { const key = refKey(ammo.receipt); if (key) keys.add(key); });
      (database.accessories || []).forEach(accessory => {
        (Array.isArray(accessory.images) ? accessory.images : []).forEach(id => keys.add(id));
        const key = refKey(accessory.receipt); if (key) keys.add(key);
      });
      return [...keys];
    },

    residentMedia(key) {
      const mediaKey = String(key || '');
      if (!mediaKey.includes(':')) return (imagesDb || {})[mediaKey] || null;
      const parts = mediaKey.split(':');
      if (parts[0] === 'doc') {
        const firearm = (db.firearms || []).find(item => String(item.id) === String(parts[1]));
        const documentId = parts.slice(2).join(':');
        const document = firearm && (firearm.documents || []).find(item => String(item.id) === documentId);
        return document && document.data || null;
      }
      const type = parts[0];
      const kind = parts[1];
      const id = parts.slice(2).join(':');
      const records = kind === 'firearm' ? db.firearms : kind === 'ammo' ? db.ammo : kind === 'accessory' ? db.accessories : [];
      const record = (records || []).find(item => String(item.id) === id);
      if (!record) return null;
      return type === 'receipt' ? record.receipt : type === 'stamp' ? record.stampPdf : null;
    },

    mediaFingerprint(value) {
      return typeof value === 'string' && value.startsWith('data:') ? this.hash(value) : null;
    },

    reconcileMissingMedia(recoveredKeys) {
      const referenced = new Set(this.referencedMediaKeys().map(String));
      const recovered = new Set((recoveredKeys || []).map(String));
      this.missingMedia = (this.missingMedia || []).filter(item => {
        const key = String(item && item.key || '');
        return referenced.has(key) && !recovered.has(key);
      });
      return this.missingMedia.length;
    },

    describeMediaKey(key) {
      const mediaKey = String(key || '');
      const nameOf = record => {
        if (!record) return 'Unknown record';
        const firearmName = [record.make, record.model].filter(Boolean).join(' ').trim();
        return firearmName || record.name || record.description || record.caliber || 'Untitled record';
      };
      const recordInfo = (kind, id) => {
        const collection = kind === 'firearm' ? db.firearms : kind === 'ammo' ? db.ammo : kind === 'accessory' ? db.accessories : [];
        const record = (collection || []).find(item => String(item.id) === String(id));
        return { record, recordId: id, recordName: nameOf(record), recordKind: kind };
      };

      if (!mediaKey.includes(':')) {
        const firearm = (db.firearms || []).find(item => (item.images || []).some(id => String(id) === mediaKey));
        const accessory = firearm ? null : (db.accessories || []).find(item =>
          (Array.isArray(item.images) ? item.images : []).some(id => String(id) === mediaKey));
        const record = firearm || accessory;
        const position = record
          ? (Array.isArray(record.images) ? record.images : []).findIndex(id => String(id) === mediaKey) + 1
          : 0;
        return {
          key: mediaKey, type: 'photo', recordKind: firearm ? 'firearm' : accessory ? 'accessory' : null,
          recordId: record && record.id, recordName: nameOf(record),
          filename: position ? 'Photo ' + position : 'Inventory photo',
          label: 'Photo for ' + nameOf(record), accept: 'image/jpeg,image/png,image/webp,image/gif'
        };
      }

      const parts = mediaKey.split(':');
      if (parts[0] === 'doc') {
        const firearmId = parts[1];
        const documentId = parts.slice(2).join(':');
        const firearm = (db.firearms || []).find(item => String(item.id) === String(firearmId));
        const document = firearm && (firearm.documents || []).find(item => String(item.id) === String(documentId));
        return {
          key: mediaKey, type: 'document', recordKind: 'firearm', recordId: firearmId, documentId,
          recordName: nameOf(firearm), filename: (document && document.name) || 'Document',
          label: ((document && document.name) || 'Document') + ' for ' + nameOf(firearm),
          accept: 'application/pdf,image/jpeg,image/png,image/webp,image/gif'
        };
      }

      const type = parts[0];
      const kind = parts[1];
      const id = parts.slice(2).join(':');
      const info = recordInfo(kind, id);
      if (type === 'receipt') {
        return Object.assign(info, {
          key: mediaKey, type: 'receipt', filename: (info.record && info.record.receiptName) || 'Receipt',
          label: 'Receipt for ' + info.recordName,
          accept: 'application/pdf,image/jpeg,image/png,image/webp,image/gif'
        });
      }
      if (type === 'stamp') {
        return Object.assign(info, {
          key: mediaKey, type: 'stamp', filename: (info.record && info.record.stampPdfName) || 'Tax stamp PDF',
          label: 'Tax stamp for ' + info.recordName, accept: 'application/pdf'
        });
      }
      return { key: mediaKey, type: 'attachment', recordName: 'Unknown record', filename: 'Attachment', label: 'Attachment', accept: 'application/pdf,image/*' };
    },

    markMediaRecovered(key) {
      return this.reconcileMissingMedia([key]);
    },

    removeMediaReference(key) {
      const detail = this.describeMediaKey(key);
      let changed = false;
      if (detail.type === 'photo') {
        (db.firearms || []).forEach(firearm => {
          const before = (firearm.images || []).length;
          firearm.images = (firearm.images || []).filter(id => String(id) !== String(key));
          if (firearm.images.length !== before) changed = true;
        });
        (db.accessories || []).forEach(accessory => {
          const images = Array.isArray(accessory.images) ? accessory.images : [];
          const before = images.length;
          accessory.images = images.filter(id => String(id) !== String(key));
          if (accessory.images.length !== before) changed = true;
        });
        if (Object.prototype.hasOwnProperty.call(imagesDb || {}, key)) { delete imagesDb[key]; changed = true; }
      } else if (detail.type === 'document') {
        const firearm = (db.firearms || []).find(item => String(item.id) === String(detail.recordId));
        if (firearm) {
          const before = (firearm.documents || []).length;
          firearm.documents = (firearm.documents || []).filter(item => String(item.id) !== String(detail.documentId));
          changed = firearm.documents.length !== before;
        }
      } else if (detail.type === 'receipt' || detail.type === 'stamp') {
        const collection = detail.recordKind === 'firearm' ? db.firearms : detail.recordKind === 'ammo' ? db.ammo : detail.recordKind === 'accessory' ? db.accessories : [];
        const record = (collection || []).find(item => String(item.id) === String(detail.recordId));
        if (record) {
          if (detail.type === 'receipt') { record.receipt = null; record.receiptName = null; }
          else { record.stampPdf = null; record.stampPdfName = null; }
          changed = true;
        }
      }
      if (changed) this.markMediaRecovered(key);
      return { ok: changed, detail };
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
      const referencedImages = new Set();
      (db.firearms || []).forEach(firearm => (firearm.images || []).forEach(id => referencedImages.add(String(id))));
      (db.accessories || []).forEach(accessory =>
        (Array.isArray(accessory.images) ? accessory.images : []).forEach(id => referencedImages.add(String(id))));
      Object.entries(imagesDb || {}).forEach(([key, value]) => {
        if (referencedImages.has(String(key)) && isData(value)) media[key] = value;
      });
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

    snapshotFingerprints(structured, inline) {
      const media = {};
      Object.entries(inline || {}).forEach(([key, value]) => { media[key] = this.mediaFingerprint(value); });
      return { structured: clone(structured), media };
    },

    snapshotStillCurrent(snapshot) {
      if (!snapshot || !equal(snapshot.structured, this.buildStructured())) return false;
      const current = this.collectMedia();
      const currentKeys = Object.keys(current).sort();
      const savedKeys = Object.keys(snapshot.media || {}).sort();
      if (!equal(currentKeys, savedKeys)) return false;
      return currentKeys.every(key => this.mediaFingerprint(current[key]) === snapshot.media[key]);
    },

    entryStillCurrent(entry) {
      if (!entry || !equal(entry.data, this.buildStructured())) return false;
      const current = this.collectMedia();
      const saved = entry.mediaFingerprints || {};
      const currentKeys = Object.keys(current).sort();
      const savedKeys = Object.keys(saved).sort();
      return equal(currentKeys, savedKeys) && currentKeys.every(key => this.mediaFingerprint(current[key]) === saved[key]);
    },

    async prepareSnapshot(context, mutationGeneration) {
      const account = context || this.accountContext();
      if (!this.contextActive(account)) return this.staleResult('prepare-snapshot');
      const structured = this.buildStructured();
      const inline = this.collectMedia();
      const fingerprint = this.snapshotFingerprints(structured, inline);
      const referenced = new Set(this.referencedMediaKeys(structured));
      const serverManifest = clone(this.serverMediaManifest || {});
      const baseRevision = Number(this.revision || 0);
      const baseUpdatedAt = this.serverUpdatedAt;
      const lastCommittedData = clone(this._lastCommittedData);
      const manifest = {};

      for (const [key, dataURL] of Object.entries(inline)) {
        const metadata = await this.mediaMetadata(dataURL);
        if (!this.contextActive(account)) return this.staleResult('prepare-snapshot');
        metadata.path = this.contentPath(key, metadata.sha256, account.uid);
        manifest[key] = metadata;
        await this.putScopedMedia(account.uid, key, dataURL, metadata);
        if (!this.contextActive(account)) return this.staleResult('prepare-snapshot');
        this.markMediaRecovered(key);
      }

      // Preserve cloud/cached media when a binary is not currently resident in
      // memory. A structured commit must never delete or orphan that reference.
      for (const key of referenced) {
        if (manifest[key]) continue;
        const cached = await this.getScopedMedia(account.uid, key);
        if (!this.contextActive(account)) return this.staleResult('prepare-snapshot');
        if (cached && cached.dataURL) {
          // Never trust a cached hash label. Verify the bytes before using it
          // to build a manifest or a stable-key replacement can relabel H1 as H2.
          const actual = await this.mediaMetadata(cached.dataURL);
          if (!this.contextActive(account)) return this.staleResult('prepare-snapshot');
          const serverExpected = serverManifest[key] || null;
          const metadata = {
            sha256: actual.sha256, mime: actual.mime, size: actual.size,
            path: cached.sha256 === actual.sha256 && cached.path
              ? cached.path
              : this.contentPath(key, actual.sha256, account.uid)
          };
          manifest[key] = serverExpected && serverExpected.sha256 && serverExpected.sha256 !== actual.sha256
            ? clone(serverExpected)
            : metadata;
          if (cached.sha256 !== actual.sha256 || cached.path !== metadata.path) {
            await this.putScopedMedia(account.uid, key, cached.dataURL, metadata);
            if (!this.contextActive(account)) return this.staleResult('prepare-snapshot');
          }
        } else if (serverManifest[key]) {
          manifest[key] = clone(serverManifest[key]);
        } else {
          // Legacy schemas have no manifest. Mark the reference as preserved;
          // cleanup deliberately skips entries whose digest is unknown.
          manifest[key] = { sha256: null, mime: null, size: null, preserved: true };
        }
      }
      this.reconcileMissingMedia(Object.keys(inline));
      return {
        ok: true, structured, manifest, fingerprint, mutationGeneration: Number(mutationGeneration || 0),
        serverManifest, baseRevision, baseUpdatedAt, lastCommittedData
      };
    },

    async persistCurrentSnapshot(reason, context, mutationGeneration) {
      const account = context || this.accountContext();
      if (!this.contextActive(account)) return this.staleResult('queue-snapshot');
      let currentSafetyState = null;
      let currentSafetyOutbox = null;
      let primaryOutboxCommitted = false;
      try {
        const generation = mutationGeneration === undefined ? this._mutationGeneration : mutationGeneration;
        // Reconcile an exact snapshot that may exist only in the secondary
        // safety mirror before writing anything newer. Without this step, a
        // second tab could overwrite a state-only recovery after the first
        // tab's primary/enqueue writes failed.
        const recoveredBeforeQueue = await this.ensurePrimaryPendingOutboxUnlocked(account);
        if (!this.contextActive(account)) return this.staleResult('queue-snapshot');
        if (!recoveredBeforeQueue.ok) {
          return {
            ok: false, status: recoveredBeforeQueue.status || 'recovery-read-failed',
            localSafe: !!recoveredBeforeQueue.localSafe,
            error: recoveredBeforeQueue.error || { message: 'Could not reconcile pending device changes.' }
          };
        }
        const snapshot = await this.prepareSnapshot(account, generation);
        if (!snapshot.ok || !this.contextActive(account)) return this.staleResult('queue-snapshot');
        // A newer mutation may have been scheduled while media was being
        // hashed. Its queued snapshot will run immediately after this one, so
        // do not persist an already superseded version in the meantime.
        if (generation !== this._mutationGeneration) {
          return { ok: false, status: 'superseded', cancelled: true, mutationGeneration: generation };
        }
        const existing = recoveredBeforeQueue.outbox || await this.storeGet('outbox', account.uid);
        if (!this.contextActive(account)) return this.staleResult('queue-snapshot');
        const cached = await this.storeGet('cache', account.uid);
        if (!this.contextActive(account)) return this.staleResult('queue-snapshot');
        if (generation !== this._mutationGeneration) {
          return { ok: false, status: 'superseded', cancelled: true, mutationGeneration: generation };
        }
        const baseData = existing ? existing.baseData : (snapshot.lastCommittedData || (cached && cached.data) || {});
        let queuedData = snapshot.structured;
        let queuedManifest = snapshot.manifest;
        let crossTabConflicts = [];
        const mergeExisting = !!(existing && (existing.crossTabMerged || !existing.sourceId || existing.sourceId !== this._sourceId));
        const existingCrossTabConflict = !!(existing && existing.conflictSource === 'cross-tab' &&
          Array.isArray(existing.conflictPaths) && existing.conflictPaths.length);
        const existingConflictRemoteSource = existingCrossTabConflict
          ? (existing.conflictRemoteSourceId || existing.sourceId || null) : null;
        const existingConflictLocalSource = existingCrossTabConflict
          ? (existing.conflictLocalSourceId ||
            (existing.sourceId && existing.sourceId !== existingConflictRemoteSource ? existing.sourceId : null))
          : null;
        const snapshotIsExistingConflictRemote = !!existingCrossTabConflict &&
          existingConflictRemoteSource === this._sourceId;
        const snapshotIsExistingConflictLocal = !!existingCrossTabConflict &&
          existingConflictLocalSource === this._sourceId;
        if (mergeExisting) {
          // Do not collapse an unresolved A/B conflict when B queues B2. Keep
          // A in entry.data and refresh the separately stored B alternative.
          const snapshotWinsConflicts = snapshotIsExistingConflictLocal
            ? 'remote'
            : (!existingCrossTabConflict && existing.sourceId === this._sourceId && existing.crossTabMerged
              ? 'remote' : undefined);
          const dataMerge = this.mergeStructured(baseData || {}, existing.data || {}, snapshot.structured || {}, snapshotWinsConflicts);
          const manifestMerge = this.mergeManifests(
            existing.baseMediaManifest || {}, existing.mediaManifest || {}, snapshot.manifest || {}, snapshotWinsConflicts
          );
          queuedManifest = manifestMerge.merged;
          queuedData = this.reconcileStructuredManifest(dataMerge.merged, queuedManifest);
          crossTabConflicts = snapshotWinsConflicts
            ? []
            : [...new Set([...dataMerge.conflicts, ...manifestMerge.conflicts])];
        }
        const entry = {
          uid: account.uid,
          id: (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random()),
          data: queuedData,
          mediaManifest: queuedManifest,
          baseData: clone(baseData),
          baseMediaManifest: existing ? clone(existing.baseMediaManifest || {}) : clone(snapshot.serverManifest || {}),
          baseRevision: existing ? existing.baseRevision : snapshot.baseRevision,
          baseUpdatedAt: existing ? existing.baseUpdatedAt : snapshot.baseUpdatedAt,
          queuedAt: new Date().toISOString(),
          reason: reason || 'autosave',
          attempts: existing ? Number(existing.attempts || 0) : 0,
          mutationGeneration: generation,
          sourceId: this._sourceId,
          crossTabMerged: mergeExisting,
          mediaFingerprints: mergeExisting
            ? Object.assign({}, clone(existing && existing.mediaFingerprints || {}), clone(snapshot.fingerprint.media))
            : clone(snapshot.fingerprint.media)
        };
        if (existingCrossTabConflict) {
          [
            'conflictAt', 'conflictSource', 'remoteRevision', 'remoteUpdatedAt',
            'conflictRemoteData', 'conflictRemoteMediaManifest', 'conflictRemoteSourceId',
            'conflictLocalSourceId', 'conflictSourceSnapshots'
          ].forEach(key => { if (existing[key] !== undefined) entry[key] = clone(existing[key]); });
          entry.conflictPaths = [...new Set([...(existing.conflictPaths || []), ...crossTabConflicts])];
          const sourceSnapshots = clone(existing.conflictSourceSnapshots || {});
          if (existingConflictLocalSource && !sourceSnapshots[existingConflictLocalSource]) {
            sourceSnapshots[existingConflictLocalSource] = {
              data: clone(existing.data || {}),
              mediaManifest: clone(existing.mediaManifest || {}),
              queuedAt: existing.queuedAt || null
            };
          }
          if (existingConflictRemoteSource && !sourceSnapshots[existingConflictRemoteSource]) {
            sourceSnapshots[existingConflictRemoteSource] = {
              data: clone(existing.conflictRemoteData || {}),
              mediaManifest: clone(existing.conflictRemoteMediaManifest || {}),
              queuedAt: existing.conflictAt || existing.queuedAt || null
            };
          }
          sourceSnapshots[this._sourceId] = {
            data: clone(snapshot.structured || {}),
            mediaManifest: clone(snapshot.manifest || {}),
            queuedAt: entry.queuedAt
          };
          entry.conflictSourceSnapshots = sourceSnapshots;
          entry.conflictLocalSourceId = existingConflictLocalSource;
          if (snapshotIsExistingConflictRemote) {
            entry.conflictAt = entry.queuedAt;
            entry.conflictRemoteData = clone(snapshot.structured || {});
            entry.conflictRemoteMediaManifest = clone(snapshot.manifest || {});
            entry.conflictRemoteSourceId = this._sourceId;
          }
        } else if (crossTabConflicts.length) {
          entry.conflictPaths = crossTabConflicts;
          entry.conflictAt = entry.queuedAt;
          entry.conflictSource = 'cross-tab';
          entry.remoteRevision = entry.baseRevision;
          entry.remoteUpdatedAt = entry.baseUpdatedAt;
          entry.conflictRemoteData = clone(snapshot.structured || {});
          entry.conflictRemoteMediaManifest = clone(snapshot.manifest || {});
          entry.conflictRemoteSourceId = this._sourceId;
          entry.conflictLocalSourceId = existing && existing.sourceId || null;
          entry.conflictSourceSnapshots = {};
          if (entry.conflictLocalSourceId) {
            entry.conflictSourceSnapshots[entry.conflictLocalSourceId] = {
              data: clone(existing.data || {}),
              mediaManifest: clone(existing.mediaManifest || {}),
              queuedAt: existing.queuedAt || null
            };
          }
          entry.conflictSourceSnapshots[this._sourceId] = {
            data: clone(snapshot.structured || {}),
            mediaManifest: clone(snapshot.manifest || {}),
            queuedAt: entry.queuedAt
          };
        } else if (existing && Array.isArray(existing.conflictPaths) && existing.conflictPaths.length) {
          [
            'conflictPaths', 'conflictAt', 'conflictSource', 'remoteRevision',
            'remoteUpdatedAt', 'conflictRemoteData', 'conflictRemoteMediaManifest', 'conflictRemoteSourceId',
            'conflictLocalSourceId', 'conflictSourceSnapshots'
          ].forEach(key => { if (existing[key] !== undefined) entry[key] = clone(existing[key]); });
        }
        if (window.VaultDataSafety) {
          const recoveryMetadata = {
            revision: entry.baseRevision,
            pending: true,
            queuedAt: entry.queuedAt,
            entryId: entry.id,
            baseRevision: entry.baseRevision,
            baseUpdatedAt: entry.baseUpdatedAt,
            baseData: clone(entry.baseData),
            baseMediaManifest: clone(entry.baseMediaManifest),
            mediaManifest: clone(entry.mediaManifest),
            mediaFingerprints: clone(entry.mediaFingerprints),
            mutationGeneration: entry.mutationGeneration,
            sourceId: entry.sourceId,
            crossTabMerged: entry.crossTabMerged,
            attempts: entry.attempts,
            conflictPaths: clone(entry.conflictPaths || []),
            conflictAt: entry.conflictAt || null,
            conflictSource: entry.conflictSource || null,
            remoteRevision: entry.remoteRevision,
            remoteUpdatedAt: entry.remoteUpdatedAt,
            conflictRemoteData: clone(entry.conflictRemoteData || {}),
            conflictRemoteMediaManifest: clone(entry.conflictRemoteMediaManifest || {}),
            conflictRemoteSourceId: entry.conflictRemoteSourceId || null,
            conflictLocalSourceId: entry.conflictLocalSourceId || null,
            conflictSourceSnapshots: clone(entry.conflictSourceSnapshots || {})
          };
          const crossTabRecovery = entry.conflictSource === 'cross-tab' &&
            Array.isArray(entry.conflictPaths) && entry.conflictPaths.length;
          if (crossTabRecovery) recoveryMetadata.pendingEntryData = clone(entry.data);
          // During a cross-tab conflict the canonical queue can intentionally
          // keep the other side in entry.data. Store this writer's exact
          // snapshot as the checksummed safety payload, while metadata retains
          // the full canonical conflict entry for promotion.
          const safetyData = crossTabRecovery ? clone(snapshot.structured || {}) : entry.data;
          currentSafetyState = await window.VaultDataSafety.putState(account.uid, safetyData, recoveryMetadata);
          if (!this.contextActive(account)) return this.staleResult('queue-snapshot');
          currentSafetyOutbox = await window.VaultDataSafety.enqueue(account.uid, safetyData, entry.baseRevision);
          if (!this.contextActive(account)) return this.staleResult('queue-snapshot');
          entry.vaultStateChecksum = currentSafetyState.checksum;
          entry.vaultOutboxId = currentSafetyOutbox.id;
        }
        await this.storePut('outbox', entry);
        primaryOutboxCommitted = true;
        if (!this.contextActive(account)) return this.staleResult('queue-snapshot');
        await this.storePut('cache', {
          uid: account.uid, data: clone(entry.data), revision: entry.baseRevision,
          updatedAt: entry.baseUpdatedAt, mediaManifest: clone(entry.mediaManifest),
          pending: true, cachedAt: entry.queuedAt
        });
        if (!this.contextActive(account)) return this.staleResult('queue-snapshot');
        if (typeof hasUnsavedChanges !== 'undefined' && generation === this._mutationGeneration && this.snapshotStillCurrent(snapshot.fingerprint)) {
          hasUnsavedChanges = false;
        }
        this.emit('local-safe', { ok: true, queuedAt: entry.queuedAt, reason: entry.reason });
        return { ok: true, status: 'local-safe', outboxId: entry.id };
      } catch (error) {
        if (!this.contextActive(account)) return this.staleResult('queue-snapshot');
        // Only a write produced by this exact snapshot can make the current
        // edit durable. The safety state now carries the complete base and
        // manifest metadata required to synthesize a primary retry entry, so
        // it is sufficient even when its companion enqueue fails. Likewise,
        // a committed primary outbox remains safe when only the cache write
        // fails afterward.
        const localSafe = !!currentSafetyState || primaryOutboxCommitted;
        const result = {
          ok: false, status: localSafe ? 'local-safe-only' : 'local-save-failed',
          localSafe,
          recoverySource: primaryOutboxCommitted ? 'primary-outbox'
            : currentSafetyOutbox ? 'secondary-outbox'
              : currentSafetyState ? 'secondary-state' : null,
          vaultStateChecksum: currentSafetyState && currentSafetyState.checksum,
          vaultOutboxId: currentSafetyOutbox && currentSafetyOutbox.id,
          error: errorInfo(error)
        };
        this.emit(localSafe ? 'degraded' : 'failed', Object.assign({ operation: 'local-save' }, result));
        this.setStatus(
          localSafe ? 'Saved on this device - cloud queue needs retry' : 'Save failed - changes are not yet safe',
          localSafe ? 'warning' : 'error', localSafe ? 'local' : 'failed'
        );
        return result;
      }
    },

    queueCurrentSnapshot(reason, context, mutationGeneration) {
      const account = context || this.accountContext();
      const generation = mutationGeneration === undefined ? this._mutationGeneration : mutationGeneration;
      const run = () => {
        if (!this.contextActive(account)) return this.staleResult('queue-snapshot');
        const operation = () => this.persistCurrentSnapshot(reason, account, generation);
        return this.withOutboxLock(account, operation);
      };
      // Every writer of the primary and secondary durable outboxes shares one
      // queue. This prevents a slow older snapshot from completing after a
      // newer one and replacing the newer durable state.
      const operation = this._queuePromise.then(run, run);
      this._queuePromise = operation;
      return operation;
    },

    async stableQueuedOutbox(context) {
      const account = context || this.accountContext();
      while (this.contextActive(account)) {
        const barrier = this._queuePromise;
        const queueResult = await barrier.catch(error => ({ ok: false, status: 'queue-failed', error: errorInfo(error) }));
        if (!this.contextActive(account)) return this.staleResult('pull-queue');
        const generation = this._mutationGeneration;
        const recovered = await this.ensurePrimaryPendingOutbox(account);
        if (!this.contextActive(account)) return this.staleResult('pull-queue');
        if (!recovered.ok && !(queueResult && queueResult.localSafe)) {
          const result = {
            ok: false, status: recovered.status || 'outbox-read-failed', localSafe: false,
            error: recovered.error || { message: 'Could not verify pending changes.' }
          };
          this.setStatus('Could not verify pending changes - nothing was overwritten', 'error', 'failed');
          this.emit('failed', Object.assign({ operation: 'pull-queue' }, result));
          return result;
        }
        const outbox = recovered.outbox || null;
        // A mutation can schedule another queue while the IndexedDB read is in
        // flight. Repeat until the barrier, generation, and outbox are from one
        // stable point in time.
        if (barrier !== this._queuePromise || generation !== this._mutationGeneration) continue;
        const secondaryOnly = !recovered.ok && !!(queueResult && queueResult.localSafe);
        const dirty = (typeof hasUnsavedChanges !== 'undefined' && hasUnsavedChanges) || secondaryOnly;
        if (recovered.ok && queueResult && queueResult.ok === false && queueResult.localSafe &&
            !outbox && !recovered.secondaryPending && barrier === this._queuePromise) {
          this._queuePromise = Promise.resolve({ ok: true, status: 'recovery-already-synced' });
        }
        return { ok: true, outbox, generation, dirty, queueResult, secondaryPending: !!recovered.secondaryPending };
      }
      return this.staleResult('pull-queue');
    },

    async cacheLocal(options, context) {
      const opts = options || {};
      const account = context || this.accountContext();
      if (!this.contextActive(account)) return this.staleResult('cache-local');
      const mutationActive = () => opts.expectedMutationGeneration === undefined ||
        Number(opts.expectedMutationGeneration) === this._mutationGeneration;
      const mutationChanged = () => ({ ok: false, status: 'local-mutation-preserved', cancelled: true, operation: 'cache-local' });
      if (!mutationActive()) return mutationChanged();
      const failures = [];
      const structured = opts.data || this.buildStructured();
      const manifest = opts.mediaManifest || this.serverMediaManifest || {};
      try {
        if (!mutationActive()) return mutationChanged();
        await this.storePut('cache', {
          uid: account.uid, data: clone(structured), revision: Number(opts.revision !== undefined ? opts.revision : this.revision || 0),
          updatedAt: opts.updatedAt !== undefined ? opts.updatedAt : this.serverUpdatedAt,
          mediaManifest: clone(manifest), pending: !!opts.pending, cachedAt: new Date().toISOString()
        });
      } catch (error) { failures.push({ store: 'scoped-state', error: errorInfo(error) }); }
      if (!this.contextActive(account)) return this.staleResult('cache-local');
      if (!mutationActive()) return mutationChanged();

      if (window.VaultDataSafety) {
        try {
          if (!mutationActive()) return mutationChanged();
          await window.VaultDataSafety.putState(account.uid, structured, {
            revision: Number(opts.revision !== undefined ? opts.revision : this.revision || 0),
            updatedAt: opts.updatedAt !== undefined ? opts.updatedAt : this.serverUpdatedAt,
            pending: !!opts.pending,
            mediaManifest: clone(manifest)
          });
        } catch (error) { failures.push({ store: 'vault-data-safety', error: errorInfo(error) }); }
      }
      if (!this.contextActive(account)) return this.staleResult('cache-local');
      if (!mutationActive()) return mutationChanged();

      if (opts.runtime !== false) {
        try {
          if (!mutationActive()) return mutationChanged();
          const written = await this.writeRuntime(account, () => {
            if (typeof statePut === 'function') return statePut('db', clone(structured));
            return runtimePut(APP_STATE_DB, 'db', clone(structured));
          });
          if (!written) return this.staleResult('cache-local');
        } catch (error) { failures.push({ store: 'runtime-state', error: errorInfo(error) }); }
      }
      if (!mutationActive()) return mutationChanged();

      const inline = opts.media === false ? {} : this.collectMedia();
      for (const [key, dataURL] of Object.entries(inline)) {
        try {
          if (!mutationActive()) return mutationChanged();
          const actual = await this.mediaMetadata(dataURL);
          if (!this.contextActive(account)) return this.staleResult('cache-local');
          if (!mutationActive()) return mutationChanged();
          const expected = manifest[key] || null;
          // The binary is authoritative for its own label. Only reuse a
          // manifest path when its checksum matches these exact bytes.
          const metadata = {
            sha256: actual.sha256, mime: actual.mime, size: actual.size,
            path: expected && expected.sha256 === actual.sha256 && expected.path
              ? expected.path
              : this.contentPath(key, actual.sha256, account.uid)
          };
          await this.putScopedMedia(account.uid, key, dataURL, metadata);
          if (!this.contextActive(account)) return this.staleResult('cache-local');
          if (!mutationActive()) return mutationChanged();
          if (opts.runtime !== false) {
            const written = await this.writeRuntime(account, () => {
              if (typeof idbPut === 'function') return idbPut(key, dataURL);
              return runtimePut(APP_MEDIA_DB, key, dataURL);
            });
            if (!written) return this.staleResult('cache-local');
          }
        } catch (error) { failures.push({ store: 'media', key, error: errorInfo(error) }); }
      }

      return { ok: failures.length === 0, status: failures.length ? 'partial-cache' : 'cached', failures };
    },

    async loadCachedIntoMemory(context, expectedMutationGeneration) {
      const account = context || this.accountContext();
      if (!this.contextActive(account)) return this.staleResult('load-cache');
      const mutationActive = () => expectedMutationGeneration === undefined ||
        Number(expectedMutationGeneration) === this._mutationGeneration;
      const mutationChanged = () => ({ ok: false, status: 'local-mutation-preserved', cancelled: true, source: 'memory' });
      if (!mutationActive()) return mutationChanged();
      const reconciled = await this.ensurePrimaryPendingOutbox(account);
      if (!this.contextActive(account)) return this.staleResult('load-cache');
      if (!mutationActive()) return mutationChanged();
      const outbox = reconciled.outbox || null;
      const source = reconciled.selected || outbox || reconciled.cached || null;
      if (!reconciled.ok && !source) return {
        ok: false, status: reconciled.status || 'device-copy-unavailable', source: 'memory',
        error: reconciled.error
      };
      if (!mutationActive()) return mutationChanged();
      if (source && source.data) this.applyStructured(source.data);
      const records = await this.getUserMedia(account.uid).catch(() => []);
      if (!this.contextActive(account)) return this.staleResult('load-cache');
      if (!mutationActive()) return mutationChanged();
      for (const item of records) {
        const expected = (source && source.mediaManifest && source.mediaManifest[item.mediaKey]) || null;
        const actual = await this.mediaMetadata(item.dataURL).catch(() => null);
        if (!this.contextActive(account)) return this.staleResult('load-cache');
        if (!mutationActive()) return mutationChanged();
        if (actual && (!expected || !expected.sha256 || actual.sha256 === expected.sha256)) this.applyMedia(item.mediaKey, item.dataURL);
      }
      return {
        ok: !!source,
        source: source && source.recoveredFromSafety ? 'recovered-outbox'
          : source && source.localSource ? source.localSource
            : source && source.safety ? 'vault-data-safety' : 'memory',
        media: records.length, outbox
      };
    },

    // ---- cloud pull -----------------------------------------------
    async readCloudRow(context) {
      const account = context || this.accountContext();
      if (!this.contextActive(account)) return null;
      const sb = window.sbClient;
      let response = await sb.from('collections')
        .select('data, updated_at, revision, media_manifest')
        .eq('user_id', account.uid).maybeSingle();
      if (!this.contextActive(account)) return null;
      if (response.error && missingRevisionColumns(response.error)) {
        this._casRpcSupported = false;
        this.emit('degraded', {
          ok: true, operation: 'schema',
          message: 'Sync-safety migration is pending; timestamp compare-and-swap is active.'
        });
        response = await sb.from('collections')
          .select('data, updated_at').eq('user_id', account.uid).maybeSingle();
        if (!this.contextActive(account)) return null;
        if (response.error) throw response.error;
        return response.data ? Object.assign({ revision: 0, media_manifest: {}, modernSchema: false }, response.data) : null;
      }
      if (response.error) throw response.error;
      return response.data ? Object.assign({ modernSchema: true }, response.data) : null;
    },

    async downloadMedia(manifest, options) {
      const opts = options || {};
      const account = opts.context || this.accountContext();
      if (!this.contextActive(account)) return this.staleResult('download-media');
      const sb = window.sbClient;
      const keys = (opts.keys || this.referencedMediaKeys()).map(String);
      const failures = [];
      const recovered = [];
      const skipped = [];
      let loaded = 0;
      let cursor = 0;
      const loadNext = async () => {
        while (cursor < keys.length) {
          const key = keys[cursor++];
          if (!this.contextActive(account)) return;
          const baseline = this.mediaFingerprint(this.residentMedia(key));
          try {
          const expected = manifest[key] || null;
          const cached = await this.getScopedMedia(account.uid, key);
          if (!this.contextActive(account)) return;
          if (cached && cached.dataURL) {
            const actual = await this.mediaMetadata(cached.dataURL);
            if (!this.contextActive(account)) return;
            const valid = !expected || !expected.sha256 || actual.sha256 === expected.sha256;
            if (valid) {
              const current = this.mediaFingerprint(this.residentMedia(key));
              const stillReferenced = this.referencedMediaKeys().map(String).includes(key);
              if (current === baseline && stillReferenced) {
                this.applyMedia(key, cached.dataURL);
                this.syncedHashes[key] = actual.sha256;
                const metadata = {
                  sha256: actual.sha256, mime: actual.mime, size: actual.size,
                  path: expected && expected.sha256 === actual.sha256 && expected.path
                    ? expected.path
                    : (cached.path || this.contentPath(key, actual.sha256, account.uid))
                };
                if (cached.sha256 !== actual.sha256 || cached.path !== metadata.path) {
                  await this.putScopedMedia(account.uid, key, cached.dataURL, metadata);
                  if (!this.contextActive(account)) return;
                }
              } else {
                skipped.push(key);
              }
              recovered.push(key);
              loaded++;
              continue;
            }
          }
          const { data: blob, error } = await sb.storage.from('media').download((expected && expected.path) || this.safePath(key, account.uid));
          if (!this.contextActive(account)) return;
          if (error) throw error;
          if (!blob) throw new Error('The cloud returned no media data.');
          const sha256 = await this.sha256Blob(blob);
          if (!this.contextActive(account)) return;
          if (expected && expected.sha256 && sha256 !== expected.sha256) throw new Error('Media checksum mismatch.');
          const dataURL = await this.blobToDataURL(blob);
          if (!this.contextActive(account)) return;
          const metadata = {
            sha256, mime: blob.type || (expected && expected.mime), size: blob.size,
            path: (expected && expected.path) || this.safePath(key, account.uid)
          };
          // A local replacement under the same stable key wins over a late
          // hydration result. Do not apply or cache the old cloud bytes.
          if (this.mediaFingerprint(this.residentMedia(key)) !== baseline) {
            skipped.push(key);
            recovered.push(key);
            continue;
          }
          if (!this.referencedMediaKeys().map(String).includes(key)) {
            skipped.push(key);
            recovered.push(key);
            continue;
          }
          this.applyMedia(key, dataURL);
          await this.putScopedMedia(account.uid, key, dataURL, metadata);
          if (!this.contextActive(account)) return;
          this.syncedHashes[key] = sha256;
          recovered.push(key);
          loaded++;
        } catch (error) {
          if (!this.contextActive(account)) return;
          failures.push(Object.assign(this.describeMediaKey(key), { error: errorInfo(error), detectedAt: new Date().toISOString() }));
          console.warn('Media download failed:', key, error);
        }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, Math.max(1, keys.length)) }, () => loadNext()));
      if (!this.contextActive(account)) return this.staleResult('download-media');
      const failedKeys = new Set(failures.map(item => String(item.key)));
      const untouchedExisting = (this.missingMedia || []).filter(item =>
        !keys.includes(String(item.key)) && this.referencedMediaKeys().map(String).includes(String(item.key)));
      this.missingMedia = [...untouchedExisting, ...failures.map(item => clone(item))];
      this.reconcileMissingMedia(recovered.filter(key => !failedKeys.has(String(key))));
      return { ok: failures.length === 0, loaded, total: keys.length, failures, skipped };
    },

    async pull(options) {
      const opts = options || {};
      const baseAccount = opts.context || this.accountContext();
      if (!this.contextActive(baseAccount)) return { ok: false, status: 'no-user', error: { message: 'No active account.' } };
      const account = Object.assign({}, baseAccount, { pullGeneration: ++this._pullGeneration });
      if (!this.contextActive(account)) return { ok: false, status: 'no-user', error: { message: 'No active account.' } };
      this.setStatus('Syncing...', 'syncing', 'saving');
      this.emit('pulling', { ok: true, background: !!opts.background });
      const deferForLocalMutation = outbox => {
        const result = {
          ok: true, status: 'local-mutation-preserved', source: 'memory',
          deferred: true, localSafe: !!outbox
        };
        this.emit('saving', Object.assign({ operation: 'pull-deferred' }, result));
        return result;
      };
      let row;
      let cloudReadError = null;
      try {
        row = await this.readCloudRow(account);
        if (!this.contextActive(account)) return this.staleResult('pull');
      } catch (error) {
        if (!this.contextActive(account)) return this.staleResult('pull');
        cloudReadError = error;
      }

      // A local save can start while the cloud request is in flight. Wait for
      // the complete serialized snapshot queue and read the outbox from the
      // same stable mutation generation before applying any cloud/cache copy.
      const queuedState = await this.stableQueuedOutbox(account);
      if (!queuedState.ok || !this.contextActive(account)) return queuedState;
      if (queuedState.dirty) return deferForLocalMutation(queuedState.outbox);
      let outbox = queuedState.outbox;
      let stableMutationGeneration = queuedState.generation;

      if (cloudReadError) {
        const local = await this.loadCachedIntoMemory(account, stableMutationGeneration);
        if (!this.contextActive(account)) return this.staleResult('pull');
        if (local.status === 'local-mutation-preserved' ||
            stableMutationGeneration !== this._mutationGeneration ||
            (typeof hasUnsavedChanges !== 'undefined' && hasUnsavedChanges)) {
          return deferForLocalMutation(outbox);
        }
        this.ready = true;
        const offline = navigator.onLine === false;
        const text = local.ok
          ? (offline ? 'Offline - safe on this device' : 'Cloud unavailable - safe on this device')
          : (offline ? 'Offline - no saved copy available' : 'Cloud unavailable - no saved copy available');
        this.setStatus(text, local.ok ? 'warning' : 'error', local.ok ? (offline ? 'offline' : 'local') : 'failed');
        const result = {
          ok: local.ok, status: local.ok ? 'offline-local' : 'offline-unavailable',
          source: local.source, localSafe: local.ok, error: errorInfo(cloudReadError)
        };
        this.emit(local.ok ? 'local-safe' : 'failed', result);
        return result;
      }

      const cloudData = row && isPlainObject(row.data) ? row.data : {};
      const incomingRevision = Number((row && row.revision) || 0);
      const incomingUpdatedAt = row && row.updated_at ? Date.parse(row.updated_at) : 0;
      const currentUpdatedAt = this.serverUpdatedAt ? Date.parse(this.serverUpdatedAt) : 0;
      if (row && (incomingRevision < Number(this.revision || 0) ||
          (incomingRevision === Number(this.revision || 0) && incomingUpdatedAt && currentUpdatedAt && incomingUpdatedAt < currentUpdatedAt))) {
        return { ok: true, status: 'stale-cloud-snapshot-ignored', revision: this.revision };
      }
      this.revision = incomingRevision;
      this.serverUpdatedAt = row ? row.updated_at : null;
      this.serverMediaManifest = clone((row && row.media_manifest) || {});
      this._lastCommittedData = clone(cloudData);
      this.hasCloudData = this.hasRecords(cloudData);

      if (!row && !outbox) {
        const cached = await this.storeGet('cache', account.uid).catch(() => null);
        if (!this.contextActive(account)) return this.staleResult('pull');
        if (cached && cached.legacy && this.hasRecords(cached.data)) {
          const restored = await this.loadCachedIntoMemory(account, stableMutationGeneration);
          if (!this.contextActive(account)) return this.staleResult('pull');
          if (restored.status === 'local-mutation-preserved' ||
              stableMutationGeneration !== this._mutationGeneration ||
              (typeof hasUnsavedChanges !== 'undefined' && hasUnsavedChanges)) {
            return deferForLocalMutation(outbox);
          }
          if (!restored.ok) throw new Error('Could not restore the legacy device collection for migration.');
          this.ready = true;
          const generation = ++this._mutationGeneration;
          const queued = await this.queueCurrentSnapshot('legacy-migration', account, generation);
          if (!queued.ok || !this.contextActive(account)) return queued;
          outbox = await this.storeGet('outbox', account.uid);
          if (!this.contextActive(account)) return this.staleResult('pull');
          stableMutationGeneration = this._mutationGeneration;
        }
      }
      this.pendingConflict = outbox && Array.isArray(outbox.conflictPaths) && outbox.conflictPaths.length
        ? { paths: [...outbox.conflictPaths], at: outbox.conflictAt || outbox.queuedAt || null, canResolve: !!outbox.conflictRemoteData }
        : null;
      if (outbox) this.applyStructured(outbox.data);
      else this.applyStructured(cloudData);

      // Paint metadata and any device-cached media immediately. Full cloud
      // media hydrates in the background with bounded concurrency.
      const cachedMedia = await this.getUserMedia(account.uid).catch(() => []);
      if (!this.contextActive(account)) return this.staleResult('pull');
      if (stableMutationGeneration !== this._mutationGeneration ||
          (typeof hasUnsavedChanges !== 'undefined' && hasUnsavedChanges)) {
        return deferForLocalMutation(outbox);
      }
      const guardedCache = await this.withOutboxLock(account, async () => {
        const latest = await this.ensurePrimaryPendingOutboxUnlocked(account);
        if (!latest.ok) return { deferred: true, latest };
        const latestOutbox = latest.outbox || null;
        const samePending = (!outbox && !latestOutbox) ||
          (!!outbox && !!latestOutbox && outbox.id === latestOutbox.id);
        if (!samePending || (!outbox && latest.secondaryPending)) return { deferred: true, latest };
        const cacheResult = await this.cacheLocal({
          data: outbox ? outbox.data : cloudData,
          mediaManifest: outbox ? outbox.mediaManifest : this.serverMediaManifest,
          revision: this.revision, updatedAt: this.serverUpdatedAt, pending: !!outbox,
          media: false, expectedMutationGeneration: stableMutationGeneration
        }, account);
        return { deferred: false, cacheResult };
      });
      if (guardedCache.deferred) return deferForLocalMutation(guardedCache.latest && guardedCache.latest.outbox);
      const cacheResult = guardedCache.cacheResult;
      if (!this.contextActive(account)) return this.staleResult('pull');
      if (cacheResult.status === 'local-mutation-preserved' ||
          stableMutationGeneration !== this._mutationGeneration ||
          (typeof hasUnsavedChanges !== 'undefined' && hasUnsavedChanges)) {
        return deferForLocalMutation(outbox);
      }

      this.ready = true;
      const mediaManifest = outbox ? outbox.mediaManifest || {} : this.serverMediaManifest;
      const mediaKeys = this.referencedMediaKeys();
      const mediaPromise = this.downloadMedia(mediaManifest, { context: account, keys: mediaKeys }).then(async mediaResult => {
        if (!this.contextActive(account)) return this.staleResult('pull-media');
        if (typeof render === 'function') {
          try { render(); if (typeof buildThumbnails === 'function') buildThumbnails(); } catch (_) {}
        }
        this.emit(mediaResult.ok ? 'media-hydrated' : 'degraded', { ok: mediaResult.ok, operation: 'media', media: mediaResult });
        if (!outbox) {
          const pendingNow = await this.storeGet('outbox', account.uid).catch(() => null);
          if (!this.contextActive(account)) return this.staleResult('pull-media');
          if (!pendingNow) {
            this.setStatus(
              this.mediaStatusText(mediaResult),
              mediaResult.ok && cacheResult.ok ? 'ok' : 'warning',
              mediaResult.ok && cacheResult.ok ? 'saved' : 'degraded'
            );
          }
        }
        return mediaResult;
      });
      if (this.contextActive(account)) this._mediaHydrationPromise = mediaPromise;
      const mediaResult = (opts.awaitMedia || mediaKeys.length === 0)
        ? await mediaPromise
        : { ok: true, pending: true, loaded: cachedMedia.length, total: mediaKeys.length, failures: [] };
      if (stableMutationGeneration !== this._mutationGeneration ||
          (typeof hasUnsavedChanges !== 'undefined' && hasUnsavedChanges)) {
        return deferForLocalMutation(outbox);
      }

      if (outbox) {
        this.setStatus('Saved on this device - syncing...', 'syncing', 'local');
        const pushed = await this.push({ capture: false, reason: 'resume-outbox' }, account);
        return Object.assign({ source: 'outbox', media: mediaResult, cache: cacheResult }, pushed);
      }

      const fullyOk = mediaResult.ok && cacheResult.ok;
      this.setStatus(
        mediaResult.pending ? 'Saved to cloud - loading attachments…' : this.mediaStatusText(mediaResult),
        fullyOk ? 'ok' : 'warning', fullyOk ? 'saved' : 'degraded'
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
      const account = this.accountContext();
      const mutationGeneration = ++this._mutationGeneration;
      clearTimeout(this.pushTimer);
      this.setStatus('Saving...', 'syncing', 'saving');
      this.emit('saving', { ok: true, operation: 'queue' });
      const persisted = this.queueCurrentSnapshot('autosave', account, mutationGeneration);
      this.pushTimer = setTimeout(() => {
        if (!this.contextActive(account)) return;
        this.push({ capture: false, reason: 'autosave' }, account).catch(error => {
          console.error('Scheduled cloud save failed', error);
        });
      }, 1800);
      return { ok: true, status: 'scheduled', persisted };
    },

    async uploadMedia(entry, options, context) {
      const opts = options || {};
      const account = context || this.accountContext(entry && entry.uid);
      if (!this.contextActive(account) || !entry || entry.uid !== account.uid) return this.staleResult('upload-media');
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
        if (!this.contextActive(account)) return this.staleResult('upload-media');
        try {
          const cached = await this.getScopedMedia(account.uid, key);
          if (!this.contextActive(account)) return this.staleResult('upload-media');
          if (!cached || !cached.dataURL) throw new Error('The local media copy is missing; structured data was not committed.');
          const expected = manifest[key];
          const actual = await this.mediaMetadata(cached.dataURL);
          if (!this.contextActive(account)) return this.staleResult('upload-media');
          if (actual.sha256 !== expected.sha256) throw new Error('The local media checksum changed before upload.');
          const blob = await this.dataURLtoBlob(cached.dataURL);
          if (!this.contextActive(account)) return this.staleResult('upload-media');
          const uploadPath = opts.legacy || this._casRpcSupported === false
            ? this.safePath(key, account.uid)
            : (expected.path || this.contentPath(key, expected.sha256, account.uid));
          const { error } = await sb.storage.from('media').upload(uploadPath, blob, {
            upsert: true,
            contentType: expected.mime || blob.type || this.mimeOf(cached.dataURL),
            cacheControl: '31536000',
            metadata: { sha256: expected.sha256 }
          });
          if (!this.contextActive(account)) return this.staleResult('upload-media');
          if (error) throw error;
          uploaded.push(key);
          this.markMediaRecovered(key);
          completed++;
          if (changed.length > 1) this.setStatus('Uploading ' + completed + '/' + changed.length + '...', 'syncing', 'saving');
        } catch (error) {
          failures.push({ key, error: errorInfo(error) });
          break; // do not commit structured refs after any upload failure
        }
      }
      return { ok: failures.length === 0, uploaded, failures };
    },

    async saveStructuredCas(entry, context) {
      const account = context || this.accountContext(entry && entry.uid);
      if (!this.contextActive(account) || !entry || entry.uid !== account.uid) return this.staleResult('save-structured');
      const sb = window.sbClient;
      if (this._casRpcSupported !== false) {
        const response = await sb.rpc('save_collection_cas', {
          p_expected_revision: Number(entry.baseRevision || 0),
          p_new_data: entry.data,
          p_new_media_manifest: entry.mediaManifest || {}
        });
        if (!this.contextActive(account)) return this.staleResult('save-structured');
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
        const legacyUploads = await this.uploadMedia(entry, { legacy: true }, account);
        if (!legacyUploads.ok) throw new Error(legacyUploads.failures[0].error.message);
      }
      return this.saveStructuredTimestampCas(entry, account);
    },

    async saveStructuredTimestampCas(entry, context) {
      const account = context || this.accountContext(entry && entry.uid);
      if (!this.contextActive(account) || !entry || entry.uid !== account.uid) return this.staleResult('save-timestamp');
      const sb = window.sbClient;
      const timestamp = new Date().toISOString();
      if (entry.baseUpdatedAt) {
        const update = await sb.from('collections')
          .update({ data: entry.data, updated_at: timestamp })
          .eq('user_id', account.uid).eq('updated_at', entry.baseUpdatedAt)
          .select('data, updated_at').maybeSingle();
        if (!this.contextActive(account)) return this.staleResult('save-timestamp');
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
          .insert({ user_id: account.uid, data: entry.data, updated_at: timestamp })
          .select('data, updated_at').maybeSingle();
        if (!this.contextActive(account)) return this.staleResult('save-timestamp');
        if (!insert.error && insert.data) {
          return {
            status: 'saved', revision: 1, updated_at: insert.data.updated_at,
            data: insert.data.data, media_manifest: entry.mediaManifest || {}, fallback: true
          };
        }
        if (insert.error && !/duplicate|unique|23505/i.test((insert.error.code || '') + ' ' + (insert.error.message || ''))) throw insert.error;
      }

      const current = await sb.from('collections')
        .select('data, updated_at').eq('user_id', account.uid).maybeSingle();
      if (!this.contextActive(account)) return this.staleResult('save-timestamp');
      if (current.error) throw current.error;
      return {
        status: 'conflict', revision: Number(entry.baseRevision || 0) + 1,
        updated_at: current.data && current.data.updated_at,
        data: (current.data && current.data.data) || {}, media_manifest: {}, fallback: true
      };
    },

    mergeStructured(base, local, remote, conflictWinner) {
      const conflicts = [];
      const merged = mergeValue(base || {}, local || {}, remote || {}, '', conflicts, conflictWinner);
      return { ok: conflicts.length === 0, merged, conflicts: [...new Set(conflicts)] };
    },

    mergeManifests(base, local, remote, conflictWinner) {
      const conflicts = [];
      const merged = mergeValue(base || {}, local || {}, remote || {}, 'media', conflicts, conflictWinner);
      return { ok: conflicts.length === 0, merged, conflicts: [...new Set(conflicts)] };
    },

    reconcileStructuredManifest(structured, manifest) {
      const data = clone(structured || {});
      const available = new Set(Object.keys(manifest || {}).map(String));
      const keepRef = value => {
        if (typeof value !== 'string' || !value.startsWith('@media:')) return value;
        return available.has(value.slice(7)) ? value : null;
      };
      (data.firearms || []).forEach(firearm => {
        firearm.images = (firearm.images || []).filter(id => available.has(String(id)));
        firearm.receipt = keepRef(firearm.receipt);
        firearm.stampPdf = keepRef(firearm.stampPdf);
        firearm.documents = (firearm.documents || []).filter(document =>
          available.has('doc:' + firearm.id + ':' + document.id));
      });
      (data.ammo || []).forEach(ammo => { ammo.receipt = keepRef(ammo.receipt); });
      (data.accessories || []).forEach(accessory => {
        accessory.images = (Array.isArray(accessory.images) ? accessory.images : [])
          .filter(id => available.has(String(id)));
        accessory.receipt = keepRef(accessory.receipt);
      });
      return data;
    },

    async rebaseConflict(entry, response, context) {
      const account = context || this.accountContext(entry && entry.uid);
      if (!this.contextActive(account) || !entry || entry.uid !== account.uid) return this.staleResult('rebase');
      const dataMerge = this.mergeStructured(entry.baseData || {}, entry.data || {}, response.data || {});
      const baseManifest = entry.baseMediaManifest || {};
      const manifestMerge = this.mergeManifests(baseManifest, entry.mediaManifest || {}, response.media_manifest || {});
      const conflicts = [...dataMerge.conflicts, ...manifestMerge.conflicts];
      if (conflicts.length) {
        const retained = Object.assign({}, entry, {
          attempts: Number(entry.attempts || 0) + 1,
          conflictAt: new Date().toISOString(),
          conflictPaths: conflicts,
          conflictSource: 'cloud',
          conflictRemoteSourceId: null,
          remoteRevision: Number(response.revision || 0),
          remoteUpdatedAt: response.updated_at || null,
          conflictRemoteData: clone(response.data || {}),
          conflictRemoteMediaManifest: clone(response.media_manifest || {})
        });
        const retainedWrite = await this.storeReplaceIfId('outbox', account.uid, entry.id, retained);
        if (!this.contextActive(account)) return this.staleResult('rebase');
        if (!retainedWrite.replaced) {
          return { ok: false, status: 'superseded-by-newer-outbox', localSafe: true,
            entry: retainedWrite.current || null };
        }
        this.pendingConflict = { paths: [...conflicts], at: retained.conflictAt, canResolve: true };
        this.setStatus('Changes safe on this device - merge needs attention', 'error', 'conflict');
        const result = { ok: false, status: 'conflict', localSafe: true, conflicts, revision: response.revision };
        this.emit('conflict', result);
        return result;
      }

      const rebased = Object.assign({}, entry, {
        id: (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random()),
        data: this.reconcileStructuredManifest(dataMerge.merged, manifestMerge.merged),
        mediaManifest: manifestMerge.merged,
        baseData: clone(response.data || {}),
        baseMediaManifest: clone(response.media_manifest || {}),
        baseRevision: Number(response.revision || 0),
        baseUpdatedAt: response.updated_at || null,
        attempts: Number(entry.attempts || 0) + 1,
        rebasedAt: new Date().toISOString()
      });
      const rebasedWrite = await this.storeReplaceIfId('outbox', account.uid, entry.id, rebased);
      if (!this.contextActive(account)) return this.staleResult('rebase');
      if (!rebasedWrite.replaced) {
        return { ok: false, status: 'superseded-by-newer-outbox', localSafe: true,
          entry: rebasedWrite.current || null };
      }
      this.serverMediaManifest = clone(response.media_manifest || {});
      return { ok: true, status: 'rebased', entry: rebased };
    },

    async resolvePendingConflict(preference) {
      const requestedWinner = preference === 'cloud' ? 'remote' : preference === 'device' ? 'local' : null;
      if (!requestedWinner || !this.uid) return { ok: false, status: 'invalid-resolution' };
      const account = this.accountContext();
      const prepared = await this.withOutboxLock(account, async () => {
        const entry = await this.storeGet('outbox', account.uid);
        if (!this.contextActive(account)) return this.staleResult('resolve-conflict');
        if (!entry || !Array.isArray(entry.conflictPaths) || !entry.conflictPaths.length || !entry.conflictRemoteData) {
          return { ok: false, status: 'no-pending-conflict' };
        }
        const crossTab = entry.conflictSource === 'cross-tab';
        let dataMerge;
        let manifestMerge;
        if (crossTab) {
          // Every tab that edits while a conflict is unresolved keeps an exact
          // durable alternative. This avoids treating a third tab (or a
          // reloaded tab with a new runtime id) as though it were one of the
          // original two writers.
          const alternatives = entry.conflictSourceSnapshots || {};
          const exactDevice = alternatives[this._sourceId] || null;
          const remoteSource = entry.conflictRemoteSourceId || entry.sourceId || null;
          const localSource = entry.conflictLocalSourceId || null;
          const deviceIsRemote = remoteSource === this._sourceId;
          const deviceIsLocal = localSource === this._sourceId;
          const canonicalLocal = {
            data: entry.data || {}, manifest: entry.mediaManifest || {}
          };
          const canonicalRemote = {
            data: entry.conflictRemoteData || {}, manifest: entry.conflictRemoteMediaManifest || {}
          };
          const canonicalUnion = (!deviceIsRemote && !deviceIsLocal)
            ? {
                data: this.mergeStructured(
                  entry.baseData || {}, canonicalRemote.data, canonicalLocal.data, 'remote'
                ).merged,
                manifest: this.mergeManifests(
                  entry.baseMediaManifest || {}, canonicalRemote.manifest, canonicalLocal.manifest, 'remote'
                ).merged
              }
            : null;
          const device = exactDevice
            ? { data: exactDevice.data || {}, manifest: exactDevice.mediaManifest || {} }
            : (deviceIsRemote ? canonicalRemote : canonicalLocal);
          const other = deviceIsRemote
            ? canonicalLocal
            : (deviceIsLocal ? canonicalRemote : canonicalUnion);
          const preferred = preference === 'device' ? device : other;
          const secondary = preference === 'device' ? other : device;
          dataMerge = this.mergeStructured(entry.baseData || {}, secondary.data, preferred.data, 'remote');
          manifestMerge = this.mergeManifests(
            entry.baseMediaManifest || {}, secondary.manifest, preferred.manifest, 'remote'
          );
        } else {
          dataMerge = this.mergeStructured(
            entry.baseData || {}, entry.data || {}, entry.conflictRemoteData || {}, requestedWinner
          );
          manifestMerge = this.mergeManifests(
            entry.baseMediaManifest || {}, entry.mediaManifest || {},
            entry.conflictRemoteMediaManifest || {}, requestedWinner
          );
        }
        const resolved = Object.assign({}, entry, {
          id: (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random()),
          data: this.reconcileStructuredManifest(dataMerge.merged, manifestMerge.merged),
          mediaManifest: manifestMerge.merged,
          // A server conflict rebases onto the fetched cloud snapshot. A
          // cross-tab conflict has not contacted the server, so retain the
          // original cloud base used by both device snapshots.
          baseData: clone(crossTab ? (entry.baseData || {}) : (entry.conflictRemoteData || {})),
          baseMediaManifest: clone(crossTab
            ? (entry.baseMediaManifest || {})
            : (entry.conflictRemoteMediaManifest || {})),
          baseRevision: Number(crossTab ? entry.baseRevision || 0 : entry.remoteRevision || 0),
          baseUpdatedAt: crossTab ? (entry.baseUpdatedAt || null) : (entry.remoteUpdatedAt || null),
          queuedAt: new Date().toISOString(),
          reason: 'conflict-resolution-' + preference,
          attempts: Number(entry.attempts || 0) + 1,
          sourceId: this._sourceId,
          mutationGeneration: ++this._mutationGeneration
        });
        delete resolved.conflictAt;
        delete resolved.conflictPaths;
        delete resolved.conflictSource;
        delete resolved.remoteRevision;
        delete resolved.remoteUpdatedAt;
        delete resolved.conflictRemoteData;
        delete resolved.conflictRemoteMediaManifest;
        delete resolved.conflictRemoteSourceId;
        delete resolved.conflictLocalSourceId;
        delete resolved.conflictSourceSnapshots;

        if (window.VaultDataSafety) {
          const safetyState = await window.VaultDataSafety.putState(account.uid, resolved.data, {
            revision: resolved.baseRevision, pending: true, queuedAt: resolved.queuedAt,
            entryId: resolved.id, baseRevision: resolved.baseRevision,
            baseUpdatedAt: resolved.baseUpdatedAt, baseData: clone(resolved.baseData),
            baseMediaManifest: clone(resolved.baseMediaManifest), mediaManifest: clone(resolved.mediaManifest),
            mediaFingerprints: clone(resolved.mediaFingerprints || {}), mutationGeneration: resolved.mutationGeneration,
            sourceId: resolved.sourceId, crossTabMerged: !!resolved.crossTabMerged
          });
          const safetyOutbox = await window.VaultDataSafety.enqueue(account.uid, resolved.data, resolved.baseRevision);
          resolved.vaultStateChecksum = safetyState.checksum;
          resolved.vaultOutboxId = safetyOutbox.id;
        }
        const replaced = await this.storeReplaceIfId('outbox', account.uid, entry.id, resolved);
        if (!replaced.replaced) return { ok: false, status: 'superseded-by-newer-outbox', localSafe: true };
        await this.storePut('cache', {
          uid: account.uid, data: clone(resolved.data), revision: resolved.baseRevision,
          updatedAt: resolved.baseUpdatedAt, mediaManifest: clone(resolved.mediaManifest),
          pending: true, cachedAt: resolved.queuedAt
        });
        return {
          ok: true,
          resolved,
          originalData: clone(entry.data || {}),
          originalMediaManifest: clone(entry.mediaManifest || {})
        };
      });
      if (!this.contextActive(account)) return this.staleResult('resolve-conflict');
      if (!prepared.ok) return prepared;
      let resolved = prepared.resolved;
      // A form can be saved while the resolution's safety mirrors are being
      // written. Overlay only the delta from the pre-resolution device copy
      // onto the chosen winner. This preserves cloud fields the user chose,
      // while a genuinely newer edit wins if it touched the same field.
      for (let attempt = 0; attempt < 5; attempt++) {
        const resolutionStillCurrent = Number(resolved.mutationGeneration || 0) === this._mutationGeneration &&
          !(typeof hasUnsavedChanges !== 'undefined' && hasUnsavedChanges);
        if (resolutionStillCurrent) break;

        const barrier = this._queuePromise;
        await barrier.catch(() => null);
        if (!this.contextActive(account)) return this.staleResult('resolve-conflict-latest');
        const overlaid = await this.withOutboxLock(account, async () => {
          const generation = this._mutationGeneration;
          const snapshot = await this.prepareSnapshot(account, generation);
          if (!snapshot.ok || !this.contextActive(account)) return this.staleResult('resolve-conflict-latest');
          if (generation !== this._mutationGeneration) return { ok: false, status: 'superseded', retry: true };
          const latest = await this.storeGet('outbox', account.uid);
          if (!this.contextActive(account)) return this.staleResult('resolve-conflict-latest');

          const durableData = latest ? latest.data : prepared.originalData;
          const durableManifest = latest ? latest.mediaManifest : prepared.originalMediaManifest;
          const latestData = this.mergeStructured(
            prepared.originalData || {}, durableData || {}, snapshot.structured || {}, 'remote'
          ).merged;
          const latestManifest = this.mergeManifests(
            prepared.originalMediaManifest || {}, durableManifest || {}, snapshot.manifest || {}, 'remote'
          ).merged;
          const dataMerge = this.mergeStructured(
            prepared.originalData || {}, resolved.data || {}, latestData || {}, 'remote'
          );
          const manifestMerge = this.mergeManifests(
            prepared.originalMediaManifest || {}, resolved.mediaManifest || {}, latestManifest || {}, 'remote'
          );
          const queuedAt = new Date().toISOString();
          const combined = Object.assign({}, latest || resolved, {
            id: (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random()),
            data: this.reconcileStructuredManifest(dataMerge.merged, manifestMerge.merged),
            mediaManifest: manifestMerge.merged,
            baseData: clone(resolved.baseData || {}),
            baseMediaManifest: clone(resolved.baseMediaManifest || {}),
            baseRevision: Number(resolved.baseRevision || 0),
            baseUpdatedAt: resolved.baseUpdatedAt || null,
            queuedAt,
            reason: resolved.reason + '-with-latest',
            sourceId: this._sourceId,
            mutationGeneration: generation,
            crossTabMerged: !!(resolved.crossTabMerged || (latest && latest.crossTabMerged)),
            mediaFingerprints: Object.assign({}, clone(latest && latest.mediaFingerprints || {}), clone(snapshot.fingerprint.media || {}))
          });
          [
            'conflictAt', 'conflictPaths', 'conflictSource', 'remoteRevision',
            'remoteUpdatedAt', 'conflictRemoteData', 'conflictRemoteMediaManifest', 'conflictRemoteSourceId',
            'conflictLocalSourceId', 'conflictSourceSnapshots'
          ].forEach(key => { delete combined[key]; });

          if (window.VaultDataSafety) {
            const safetyState = await window.VaultDataSafety.putState(account.uid, combined.data, {
              revision: combined.baseRevision, pending: true, queuedAt,
              entryId: combined.id, baseRevision: combined.baseRevision,
              baseUpdatedAt: combined.baseUpdatedAt, baseData: clone(combined.baseData),
              baseMediaManifest: clone(combined.baseMediaManifest), mediaManifest: clone(combined.mediaManifest),
              mediaFingerprints: clone(combined.mediaFingerprints || {}), mutationGeneration: generation,
              sourceId: combined.sourceId, crossTabMerged: !!combined.crossTabMerged
            });
            const safetyOutbox = await window.VaultDataSafety.enqueue(account.uid, combined.data, combined.baseRevision);
            combined.vaultStateChecksum = safetyState.checksum;
            combined.vaultOutboxId = safetyOutbox.id;
          }
          let stored = { replaced: true };
          if (latest) stored = await this.storeReplaceIfId('outbox', account.uid, latest.id, combined);
          else await this.storePut('outbox', combined);
          if (!stored.replaced) return { ok: false, status: 'superseded', retry: true };
          await this.storePut('cache', {
            uid: account.uid, data: clone(combined.data), revision: combined.baseRevision,
            updatedAt: combined.baseUpdatedAt, mediaManifest: clone(combined.mediaManifest),
            pending: true, cachedAt: queuedAt
          });
          if (generation === this._mutationGeneration && this.snapshotStillCurrent(snapshot.fingerprint) &&
              typeof hasUnsavedChanges !== 'undefined') hasUnsavedChanges = false;
          return { ok: true, resolved: combined };
        });
        if (!this.contextActive(account)) return this.staleResult('resolve-conflict-latest');
        if (overlaid.ok) resolved = overlaid.resolved;
        if (!overlaid.ok && !overlaid.retry) return overlaid;
      }
      if (Number(resolved.mutationGeneration || 0) !== this._mutationGeneration ||
          (typeof hasUnsavedChanges !== 'undefined' && hasUnsavedChanges)) {
        this.pendingConflict = null;
        this.setStatus('Latest changes are safe on this device - cloud save will retry', 'warning', 'local');
        return { ok: false, status: 'resolution-pending-latest-edit', localSafe: true };
      }
      this.applyStructured(resolved.data);
      this.serverMediaManifest = clone(resolved.baseMediaManifest);
      this.revision = resolved.baseRevision;
      this.serverUpdatedAt = resolved.baseUpdatedAt;
      this.pendingConflict = null;
      this.setStatus('Saving reviewed changes...', 'syncing', 'saving');
      if (typeof updateStats === 'function') updateStats();
      if (typeof render === 'function') render();
      return this.push({ capture: false, reason: resolved.reason, queuePromise: Promise.resolve({ ok: true }) }, account);
    },

    async cleanupDeletedMedia(previousManifest, currentManifest, context) {
      const account = context || this.accountContext();
      if (!this.contextActive(account)) return this.staleResult('cleanup-media');
      const paths = [];
      for (const [key, previous] of Object.entries(previousManifest || {})) {
        const current = (currentManifest || {})[key];
        const previousPath = (previous && previous.path) || this.safePath(key, account.uid);
        const currentPath = current && ((current.path) || this.safePath(key, account.uid));
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
      if (!this.contextActive(account)) return this.staleResult('cleanup-media');
      if (error) return { ok: false, removed: [], failures: paths.map(path => ({ path, error: errorInfo(error) })) };
      return { ok: true, removed: paths, failures: [], data };
    },

    async cleanupOrphanMedia(options) {
      const opts = Object.assign({ dryRun: true }, options || {});
      const account = this.accountContext();
      if (!this.contextActive(account)) return { ok: false, status: 'no-user', unused: [] };
      const keep = new Set();
      const addManifest = manifest => Object.values(manifest || {}).forEach(item => {
        if (item && item.path) keep.add(item.path);
      });
      addManifest(this.serverMediaManifest);
      const versions = await window.sbClient.from('collection_versions')
        .select('media_manifest').eq('user_id', account.uid).limit(50);
      if (!this.contextActive(account)) return this.staleResult('cleanup-orphans');
      if (versions.error) return { ok: false, status: 'history-unavailable', error: errorInfo(versions.error), unused: [] };
      (versions.data || []).forEach(row => addManifest(row.media_manifest));
      const listed = await window.sbClient.storage.from('media').list(account.uid, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
      if (!this.contextActive(account)) return this.staleResult('cleanup-orphans');
      if (listed.error) return { ok: false, status: 'list-failed', error: errorInfo(listed.error), unused: [] };
      const unused = (listed.data || []).filter(item => item && item.name && !item.name.endsWith('/'))
        .map(item => account.uid + '/' + item.name).filter(path => !keep.has(path));
      if (opts.dryRun || !unused.length) return { ok: true, status: 'scanned', unused, removed: [] };
      const removed = [];
      for (let index = 0; index < unused.length; index += 100) {
        const batch = unused.slice(index, index + 100);
        const response = await window.sbClient.storage.from('media').remove(batch);
        if (!this.contextActive(account)) return this.staleResult('cleanup-orphans');
        if (response.error) return { ok: false, status: 'remove-failed', unused, removed, error: errorInfo(response.error) };
        removed.push(...batch);
      }
      return { ok: true, status: 'cleaned', unused, removed };
    },

    async performPush(options, context) {
      const opts = options || {};
      const account = context || this.accountContext();
      let recoveredQueueBarrier = null;
      if (!this.contextActive(account)) return this.staleResult('push');
      if (opts.capture !== false) {
        const generation = ++this._mutationGeneration;
        const queued = await this.queueCurrentSnapshot(opts.reason || 'manual', account, generation);
        if (!queued.ok) return queued;
      } else {
        const queueBarrier = opts.queuePromise || this._queuePromise;
        const queueResult = await queueBarrier;
        if (!this.contextActive(account)) return this.staleResult('push');
        if (queueResult && queueResult.ok === false) {
          if (!queueResult.localSafe) return queueResult;
          // The exact snapshot may exist only in VaultDataSafety (primary
          // outbox failure), or the primary outbox may be present while only
          // its cache write failed. Recover/verify the retry entry now so the
          // same session can reach the cloud without requiring a reload.
          recoveredQueueBarrier = queueBarrier;
          const recovered = await this.ensurePrimaryPendingOutbox(account);
          if (!this.contextActive(account)) return this.staleResult('push');
          if (!recovered.ok || !recovered.outbox) {
            if (!recovered.secondaryPending && recoveredQueueBarrier === this._queuePromise &&
                equal(this._lastCommittedData || {}, this.buildStructured())) {
              this._queuePromise = Promise.resolve({ ok: true, status: 'recovery-already-synced' });
            } else {
              return queueResult;
            }
          }
        }
      }

      let entry = await this.storeGet('outbox', account.uid);
      if (!this.contextActive(account)) return this.staleResult('push');
      if (entry && entry.uid !== account.uid) return this.staleResult('push');
      if (entry && entry.conflictSource === 'cross-tab' &&
          Array.isArray(entry.conflictPaths) && entry.conflictPaths.length) {
        this.pendingConflict = {
          paths: [...entry.conflictPaths], at: entry.conflictAt || entry.queuedAt || null,
          canResolve: !!entry.conflictRemoteData
        };
        this.setStatus('Changes safe on this device - another tab needs review', 'error', 'conflict');
        const conflict = { ok: false, status: 'conflict', localSafe: true,
          conflicts: [...entry.conflictPaths], source: 'cross-tab' };
        this.emit('conflict', conflict);
        return conflict;
      }
      if (!entry) {
        if (recoveredQueueBarrier && recoveredQueueBarrier === this._queuePromise) {
          this._queuePromise = Promise.resolve({ ok: true, status: 'recovery-already-synced' });
        }
        this.pendingConflict = null;
        const unresolvedMedia = (this.missingMedia || []).length;
        this.setStatus(
          unresolvedMedia ? this.mediaStatusText({ failures: this.missingMedia }) : 'Saved to cloud',
          unresolvedMedia ? 'warning' : 'ok', unresolvedMedia ? 'degraded' : 'saved'
        );
        const idle = { ok: true, status: unresolvedMedia ? 'already-synced-with-warnings' : 'already-synced', revision: this.revision, missingMedia: unresolvedMedia };
        this.emit(unresolvedMedia ? 'degraded' : 'saved', idle);
        return idle;
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        const uploads = await this.uploadMedia(entry, {}, account);
        if (!this.contextActive(account) || uploads.cancelled) return this.staleResult('push');
        if (!uploads.ok) {
          const error = new Error(uploads.failures[0].error.message);
          error.syncDetails = uploads;
          throw error;
        }

        const previousManifest = clone(this.serverMediaManifest || {});
        const response = await this.saveStructuredCas(entry, account);
        if (!this.contextActive(account) || response.cancelled) return this.staleResult('push');
        if (response.status === 'conflict') {
          const rebased = await this.rebaseConflict(entry, response, account);
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
        let currentOutbox = null;
        let newerOutboxExists = false;
        let entryCurrent = false;
        let mergedCommitReconciled = false;
        let safetyResult = { ok: true, removed: 0 };
        let cacheResult = { ok: true, status: 'newer-state-retained', failures: [] };
        await this.withOutboxLock(account, async () => {
          const conditional = await this.storeDeleteIfId('outbox', account.uid, entry.id);
          currentOutbox = conditional.current || null;
          if (!this.contextActive(account)) return;
          entryCurrent = this.entryStillCurrent(entry);
          const mergedCommitCanReconcile = !!entry.crossTabMerged && conditional.deleted &&
            !(typeof hasUnsavedChanges !== 'undefined' && hasUnsavedChanges);
          if (!entryCurrent && mergedCommitCanReconcile) {
            this.applyStructured(entry.data);
            entryCurrent = true;
            mergedCommitReconciled = true;
          }
          let newerSafetyPending = false;
          let safetyOutbox = [];
          if (window.VaultDataSafety) {
            try {
              safetyOutbox = await window.VaultDataSafety.listOutbox(account.uid);
              const safetyState = await window.VaultDataSafety.getState(account.uid);
              const safetyRecovery = this.newestSafetyRecovery(safetyOutbox, safetyState);
              const selected = this.selectLocalRecovery(entry, null, safetyRecovery);
              newerSafetyPending = !!(selected && selected.safety && this.isPendingSafetyRecovery(selected));
            } catch (error) {
              newerSafetyPending = true;
              postCommitWarnings.push({ operation: 'verify-safety-after-commit', error: errorInfo(error) });
            }
          }
          newerOutboxExists = !!(currentOutbox && currentOutbox.id !== entry.id) || newerSafetyPending;
          const newerRuntimeState = newerOutboxExists || !entryCurrent ||
            (!mergedCommitReconciled && Number(entry.mutationGeneration || 0) !== this._mutationGeneration);

          if (window.VaultDataSafety && !newerRuntimeState) {
            try {
              await window.VaultDataSafety.putState(account.uid, entry.data, {
                revision: this.revision, updatedAt: this.serverUpdatedAt, pending: false,
                mediaManifest: clone(this.serverMediaManifest || entry.mediaManifest || {})
              });
              const committedAt = entry.queuedAt || '';
              const removable = safetyOutbox.filter(item =>
                item.id === entry.vaultOutboxId ||
                (!!entry.vaultStateChecksum && item.checksum === entry.vaultStateChecksum) ||
                !committedAt || item.queuedAt <= committedAt);
              for (const item of removable) await window.VaultDataSafety.removeOutbox(account.uid, item.id);
              await window.VaultDataSafety.createBackup(account.uid, entry.data, 'cloud-sync', {
                revision: this.revision, updatedAt: this.serverUpdatedAt
              });
              safetyResult.removed = removable.length;
            } catch (error) {
              safetyResult = { ok: false, error: errorInfo(error) };
              postCommitWarnings.push({ operation: 'vault-data-safety-after-commit', error: errorInfo(error) });
            }
          }
          if (!newerRuntimeState) {
            cacheResult = await this.cacheLocal({
              data: entry.data, mediaManifest: this.serverMediaManifest,
              revision: this.revision, updatedAt: this.serverUpdatedAt, pending: false,
              runtime: true, expectedMutationGeneration: entry.mutationGeneration
            }, account);
          }
        });
        if (!this.contextActive(account)) return this.staleResult('push');
        // A normal commit already matches the live structured state. Reapplying
        // entry.data here would replace that richer live state with the
        // media-stripped cloud payload, making resident documents, receipts,
        // and tax stamps appear unavailable immediately after a successful save.
        if (mergedCommitReconciled && typeof render === 'function') {
          try { render(); } catch (_) {}
        }
        const cleanup = newerOutboxExists
          ? { ok: true, removed: [], retainedForNewerState: true, failures: [] }
          : await this.cleanupDeletedMedia(previousManifest, this.serverMediaManifest, account).catch(error => ({
              ok: false, removed: [], failures: [{ error: errorInfo(error) }]
            }));
        if (!this.contextActive(account)) return this.staleResult('push');
        this.reconcileMissingMedia(uploads.uploaded || []);
        if (typeof hasUnsavedChanges !== 'undefined' &&
            (mergedCommitReconciled || Number(entry.mutationGeneration || 0) === this._mutationGeneration) && entryCurrent) {
          hasUnsavedChanges = false;
        }
        this.pendingConflict = newerOutboxExists && Array.isArray(currentOutbox.conflictPaths) && currentOutbox.conflictPaths.length
          ? {
            paths: [...currentOutbox.conflictPaths],
            at: currentOutbox.conflictAt || currentOutbox.queuedAt || null,
            canResolve: !!currentOutbox.conflictRemoteData
          }
          : null;
        this.saveFailureNotified = false;
        clearTimeout(this._retryTimer);
        if (recoveredQueueBarrier && recoveredQueueBarrier === this._queuePromise && !newerOutboxExists) {
          this._queuePromise = Promise.resolve({ ok: true, status: 'secondary-recovery-committed' });
        }
        const postCommitOk = cleanup.ok && cacheResult.ok && safetyResult.ok && postCommitWarnings.length === 0;
        const unresolvedMedia = (this.missingMedia || []).length;
        // The request that just committed can finish after another edit has
        // already changed memory or replaced the outbox. Report the committed
        // revision, but never label the latest UI state as cloud-saved until
        // that newer generation commits too.
        const pendingNewerChanges = newerOutboxExists || !entryCurrent ||
          (!mergedCommitReconciled && Number(entry.mutationGeneration || 0) !== this._mutationGeneration) ||
          (typeof hasUnsavedChanges !== 'undefined' && hasUnsavedChanges);
        const cleanSave = postCommitOk && unresolvedMedia === 0 && !pendingNewerChanges;
        if (pendingNewerChanges) {
          this.setStatus(
            newerOutboxExists ? 'Saved on this device - syncing latest changes...' : 'Saving latest changes...',
            'syncing', newerOutboxExists ? 'local' : 'saving'
          );
        } else {
          this.setStatus(
            unresolvedMedia ? this.mediaStatusText({ failures: this.missingMedia })
              : (postCommitOk ? 'Saved to cloud' : 'Saved to cloud - device verification needs attention'),
            cleanSave ? 'ok' : 'warning',
            cleanSave ? 'saved' : 'degraded'
          );
        }
        const result = {
          ok: true, status: pendingNewerChanges ? 'pending-newer-changes' : (cleanSave ? 'synced' : 'synced-with-warnings'),
          revision: this.revision, updatedAt: this.serverUpdatedAt,
          uploaded: uploads.uploaded, cleanup, cache: cacheResult, safety: safetyResult,
          warnings: postCommitWarnings, missingMedia: unresolvedMedia, pendingNewerChanges,
          usedFallback: !!response.fallback
        };
        this.emit(
          pendingNewerChanges ? (newerOutboxExists ? 'local-safe' : 'saving') : (cleanSave ? 'saved' : 'degraded'),
          result
        );
        if (this._broadcast) {
          try { this._broadcast.postMessage({ type: 'saved', uid: account.uid, source: this._sourceId, revision: this.revision, updatedAt: this.serverUpdatedAt }); } catch (_) {}
        }
        return result;
      }
      throw new Error('Could not converge after three background merge attempts.');
    },

    async handlePushFailure(error, context) {
      const account = context || this.accountContext();
      if (!this.contextActive(account)) return this.staleResult('push-failure');
      console.error('Cloud save failed', error);
      const outbox = await this.storeGet('outbox', account.uid).catch(() => null);
      if (!this.contextActive(account)) return this.staleResult('push-failure');
      if (outbox && outbox.vaultOutboxId && window.VaultDataSafety) {
        await window.VaultDataSafety.noteOutboxAttempt(account.uid, outbox.vaultOutboxId, error).catch(noteError => {
          console.warn('Could not record the outbox retry', noteError);
        });
      }
      let secondarySafe = false;
      if (!outbox && window.VaultDataSafety) {
        try {
          const [safetyOutbox, safetyState] = await Promise.all([
            window.VaultDataSafety.listOutbox(account.uid),
            window.VaultDataSafety.getState(account.uid)
          ]);
          if (!this.contextActive(account)) return this.staleResult('push-failure');
          const recovery = this.newestSafetyRecovery(safetyOutbox, safetyState);
          secondarySafe = !!(recovery && (recovery.safetySource === 'outbox' ||
            !!(recovery.metadata && recovery.metadata.pending)));
        } catch (_) {}
      }
      const localSafe = !!outbox || secondarySafe;
      const offline = navigator.onLine === false;
      if (localSafe) {
        this.setStatus(
          offline ? 'Offline - safe on this device' : 'Cloud unavailable - safe on this device; retrying',
          'warning', offline ? 'offline' : 'local'
        );
        if (!offline) {
          clearTimeout(this._retryTimer);
          this._retryTimer = setTimeout(() => {
            if (this.contextActive(account)) this.push({ capture: false, reason: 'retry' }, account);
          }, 8000);
        }
      } else {
        this.setStatus('Save failed - changes are not safe yet', 'error', 'failed');
      }
      if (!localSafe && !this.saveFailureNotified && window.toast) {
        window.toast('Save failed on this device and in the cloud. Keep this page open and retry.', 'error', 8000);
        this.saveFailureNotified = true;
      }
      const result = { ok: false, status: localSafe ? (offline ? 'offline-local' : 'retrying') : 'unsafe', localSafe, error: errorInfo(error) };
      this.emit(localSafe ? 'local-safe' : 'failed', result);
      return result;
    },

    async push(options, context) {
      const account = context || this.accountContext();
      if (!this.ready || !this.contextActive(account)) return { ok: false, status: 'not-ready' };
      if (this.pushing) {
        this.pendingPush = true;
        return { ok: true, status: 'queued-behind-active-save' };
      }
      this.pushing = true;
      this.setStatus('Saving...', 'syncing', 'saving');
      this.emit('saving', { ok: true, operation: 'cloud' });
      const operation = (async () => {
        try {
          return await this.performPush(options, account);
        } catch (error) {
          return await this.handlePushFailure(error, account);
        }
      })();
      this._activePushPromise = operation;
      try {
        return await operation;
      } finally {
        if (this.contextActive(account)) {
          this.pushing = false;
          if (this.pendingPush) {
            this.pendingPush = false;
            this.schedulePush();
          }
        }
      }
    },

    async syncNow() {
      const account = this.accountContext();
      if (!this.contextActive(account)) return { ok: false, status: 'not-ready' };
      const generation = ++this._mutationGeneration;
      clearTimeout(this.pushTimer);
      const queued = await this.queueCurrentSnapshot('manual', account, generation);
      if (!queued.ok && !queued.localSafe) return queued;
      return this.push({ capture: false, reason: 'manual', queuePromise: Promise.resolve(queued) }, account);
    },

    async prepareForSignOut() {
      const account = this.accountContext();
      if (!this.contextActive(account)) return { ok: true, status: 'no-user', noChanges: true, localSafe: false, cloudSafe: true };
      clearTimeout(this.pushTimer);
      let recovered = await this.ensurePrimaryPendingOutbox(account);
      if (!this.contextActive(account)) return this.staleResult('sign-out-check');
      let outbox = recovered.outbox || null;
      let secondaryPending = !!recovered.secondaryPending;
      const memoryDirty = typeof hasUnsavedChanges !== 'undefined' && hasUnsavedChanges;
      const noChanges = !!recovered.ok && !memoryDirty && !outbox && !secondaryPending;
      const generation = memoryDirty ? ++this._mutationGeneration : this._mutationGeneration;
      const queued = this.ready && memoryDirty
        ? await this.queueCurrentSnapshot('sign-out', account, generation)
        : outbox ? { ok: true, status: 'already-queued' }
          : secondaryPending ? { ok: false, status: 'secondary-recovery-pending', localSafe: true }
            : { ok: true, status: 'no-changes' };
      if (!this.contextActive(account)) return this.staleResult('sign-out-check');
      if (memoryDirty && !queued.ok && !queued.localSafe) {
        const result = {
          ok: false, status: 'unsafe', noChanges: false, localSafe: false, cloudSafe: false,
          cloud: { ok: false, status: 'not-attempted' }, queue: queued
        };
        this.emit('failed', Object.assign({ operation: 'sign-out-check' }, result));
        return result;
      }
      if (queued.ok && queued.status !== 'no-changes') {
        recovered = await this.ensurePrimaryPendingOutbox(account);
        if (!this.contextActive(account)) return this.staleResult('sign-out-check');
        outbox = recovered.outbox || null;
        secondaryPending = !!recovered.secondaryPending;
      }
      let cloud = outbox ? { ok: false, status: 'not-attempted' } : { ok: noChanges, status: noChanges ? 'already-synced' : 'not-attempted' };
      if ((outbox || secondaryPending || queued.localSafe) && this.ready) cloud = await this.push({
        capture: false, reason: 'sign-out', queuePromise: Promise.resolve(queued)
      }, account);
      if (!this.contextActive(account)) return this.staleResult('sign-out-check');
      recovered = await this.ensurePrimaryPendingOutbox(account);
      if (!this.contextActive(account)) return this.staleResult('sign-out-check');
      outbox = recovered.outbox || null;
      secondaryPending = !!recovered.secondaryPending;
      const secondaryEntry = recovered.safetyRecovery ? {
        data: recovered.safetyRecovery.data,
        mediaFingerprints: clone(recovered.safetyRecovery.metadata && recovered.safetyRecovery.metadata.mediaFingerprints || {})
      } : null;
      const localSafe = (!!outbox && this.entryStillCurrent(outbox)) ||
        (secondaryPending && !!secondaryEntry && this.entryStillCurrent(secondaryEntry));
      const cloudSafe = !!recovered.ok && !outbox && !secondaryPending && !!cloud.ok &&
        cloud.status !== 'queued-behind-active-save' && !cloud.pendingNewerChanges &&
        equal(this._lastCommittedData || {}, this.buildStructured());
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
      const account = this.accountContext();
      if (!this.contextActive(account)) throw new Error('Sign in before restoring a backup.');
      const text = await this.readBackupText(file);
      if (!this.contextActive(account)) return this.staleResult('restore');
      let parsed;
      try { parsed = JSON.parse(text); } catch (_) { throw new Error('That file is not valid JSON.'); }
      if (parsed && parsed.format === 'firearms-vault-backup' && window.VaultDataSafety) {
        if (parsed.encrypted) throw new Error('This encrypted backup must be opened from Data & backups with its password.');
        parsed = (await window.VaultDataSafety.importEnvelope(parsed, null)).data;
      }
      const data = this.validateBackup(parsed);
      if (!this.contextActive(account)) return this.staleResult('restore');
      this.applyStructured(Object.assign({ version: 3, encrypted: false }, data));
      db.backups = [];

      const images = data.images || {};
      for (const [key, value] of Object.entries(images)) {
        if (typeof value !== 'string' || !value.startsWith('data:')) continue;
        imagesDb[key] = value;
        const metadata = await this.mediaMetadata(value);
        if (!this.contextActive(account)) return this.staleResult('restore');
        await this.putScopedMedia(account.uid, key, value, metadata);
        if (!this.contextActive(account)) return this.staleResult('restore');
        const written = await this.writeRuntime(account, () => {
          if (typeof idbPut === 'function') return idbPut(key, value);
          return runtimePut(APP_MEDIA_DB, key, value);
        });
        if (!written) return this.staleResult('restore');
      }

      this.ready = true;
      if (typeof updateStats === 'function') updateStats();
      if (typeof render === 'function') render();
      if (typeof window.buildThumbnails === 'function') window.buildThumbnails();
      const generation = ++this._mutationGeneration;
      const queued = await this.queueCurrentSnapshot('restore', account, generation);
      if (queued.cancelled) return queued;
      if (!queued.ok) throw new Error(queued.error.message);
      const cloud = await this.push({
        capture: false, reason: 'restore', queuePromise: Promise.resolve(queued)
      }, account);
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
    if (CloudSync.ready) CloudSync.setStatus('Offline - safe on this device', 'warning', 'offline');
  });
})();
