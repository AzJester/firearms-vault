// =====================================================
// CloudSync — keeps the in-memory database in sync with Supabase.
//
//  * Structured records (firearms / ammo / accessories / wishlist / dealers /
//    audit / value history / settings) live in the `collections` table as a
//    single JSON document, with binaries replaced by "@media:<key>" refs.
//  * Binaries (photos, receipts, stamp PDFs) live in the private `media`
//    Storage bucket, one object per key under the user's own folder.
//
// The in-memory shape the rest of the app sees (db + imagesDb, with inline
// data: URLs) is reconstructed on pull and deconstructed on push, so none of
// the original 160+ app functions had to change.
// =====================================================
const CloudSync = {
  ready: false,
  uid: null,
  hasCloudData: false,
  serverUpdatedAt: null,
  syncedHashes: {},      // media key -> hash currently in the cloud
  pushTimer: null,
  pushing: false,
  pendingPush: false,

  // ---- status pill -------------------------------------------------
  setStatus(text, kind) {
    const el = document.getElementById('syncStatus');
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind || '';
  },

  // ---- helpers -----------------------------------------------------
  safePath(key) {
    return this.uid + '/' + String(key).replace(/[^A-Za-z0-9._-]/g, '_');
  },

  // Cheap change-detector: length + sampled char codes (handles replaced files)
  hash(str) {
    let h = 5381;
    const step = str.length > 200000 ? 1499 : 1;
    for (let i = 0; i < str.length; i += step) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36) + '_' + str.length;
  },

  mimeOf(dataURL) {
    const m = /^data:([^;,]+)[;,]/.exec(dataURL);
    return (m && m[1]) || 'application/octet-stream';
  },

  async dataURLtoBlob(dataURL) {
    const res = await fetch(dataURL);
    return await res.blob();
  },

  blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  },

  // Which media keys are referenced by the current data?
  referencedMediaKeys() {
    const keys = new Set();
    const refKey = (v) => (typeof v === 'string' && v.startsWith('@media:')) ? v.slice(7) : null;
    (db.firearms || []).forEach(f => {
      (f.images || []).forEach(id => keys.add(id));
      let k = refKey(f.receipt); if (k) keys.add(k);
      k = refKey(f.stampPdf);    if (k) keys.add(k);
      (f.documents || []).forEach(d => keys.add('doc:' + f.id + ':' + d.id));
    });
    (db.ammo || []).forEach(a => { const k = refKey(a.receipt); if (k) keys.add(k); });
    (db.accessories || []).forEach(a => { const k = refKey(a.receipt); if (k) keys.add(k); });
    return [...keys];
  },

  // Put a downloaded media data: URL back where the app expects it.
  applyMedia(key, dataURL) {
    if (key.indexOf(':') === -1) { imagesDb[key] = dataURL; return; } // photo
    const parts = key.split(':');                                     // type:kind:id
    if (parts[0] === 'doc') {                                         // doc:firearmId:docId
      const fr = (db.firearms || []).find(x => x.id === parts[1]);
      const doc = fr && (fr.documents || []).find(d => d.id === parts[2]);
      if (doc) doc.data = dataURL;
      return;
    }
    const type = parts[0], kind = parts[1], id = parts.slice(2).join(':');
    const arr = kind === 'firearm' ? db.firearms
              : kind === 'ammo' ? db.ammo
              : kind === 'accessory' ? db.accessories : null;
    if (!arr) return;
    const rec = arr.find(r => r.id === id);
    if (!rec) return;
    if (type === 'receipt') rec.receipt = dataURL;
    else if (type === 'stamp') rec.stampPdf = dataURL;
  },

  // Gather every inline binary in memory: key -> data: URL
  collectMedia() {
    const media = {};
    const isData = (v) => typeof v === 'string' && v.startsWith('data:');
    for (const [k, v] of Object.entries(imagesDb || {})) {
      if (isData(v)) media[k] = v;
    }
    const grab = (rec, kind) => {
      if (isData(rec.receipt)) media['receipt:' + kind + ':' + rec.id] = rec.receipt;
    };
    (db.firearms || []).forEach(f => {
      grab(f, 'firearm');
      if (isData(f.stampPdf)) media['stamp:firearm:' + f.id] = f.stampPdf;
      (f.documents || []).forEach(d => { if (isData(d.data)) media['doc:' + f.id + ':' + d.id] = d.data; });
    });
    (db.ammo || []).forEach(a => grab(a, 'ammo'));
    (db.accessories || []).forEach(a => grab(a, 'accessory'));
    return media;
  },

  // Copy of db with binaries stripped to refs (what we store in Postgres)
  buildStructured() {
    const s = JSON.parse(JSON.stringify(db));
    delete s.backups;
    const isData = (v) => typeof v === 'string' && v.startsWith('data:');
    const strip = (rec, kind) => {
      if (isData(rec.receipt)) rec.receipt = '@media:receipt:' + kind + ':' + rec.id;
    };
    (s.firearms || []).forEach(f => {
      strip(f, 'firearm');
      if (isData(f.stampPdf)) f.stampPdf = '@media:stamp:firearm:' + f.id;
      (f.documents || []).forEach(d => { if (isData(d.data)) delete d.data; });
    });
    (s.ammo || []).forEach(a => strip(a, 'ammo'));
    (s.accessories || []).forEach(a => strip(a, 'accessory'));
    return s;
  },

  async cacheLocal() {
    try {
      const saveObj = Object.assign({}, db);
      delete saveObj.backups;
      await statePut('db', saveObj);
      for (const [k, v] of Object.entries(imagesDb)) {
        if (typeof v === 'string') await idbPut(k, v);
      }
    } catch (e) { console.warn('Local cache write failed', e); }
  },

  // ---- PULL: cloud -> memory --------------------------------------
  async pull() {
    const sb = window.sbClient;
    this.setStatus('Syncing…', 'syncing');

    let cloud = null;
    try {
      const { data: row, error } = await sb
        .from('collections').select('data, updated_at').eq('user_id', this.uid).maybeSingle();
      if (error) throw error;
      cloud = row && row.data;
      this.serverUpdatedAt = row ? row.updated_at : null;
    } catch (e) {
      console.warn('Cloud read failed — using local copy (offline?).', e);
      try { Object.assign(imagesDb, (await idbGetAll()) || {}); } catch (_) {}
      this.ready = true;
      this.setStatus('Offline — local copy', 'error');
      return;
    }

    this.hasCloudData = !!(cloud && (
      (cloud.firearms && cloud.firearms.length) ||
      (cloud.ammo && cloud.ammo.length) ||
      (cloud.accessories && cloud.accessories.length)));

    if (cloud && Object.keys(cloud).length) {
      ['firearms', 'ammo', 'accessories', 'wishlist', 'dealers', 'auditTrail', 'valueHistory']
        .forEach(k => { db[k] = Array.isArray(cloud[k]) ? cloud[k] : []; });
      db.settings = cloud.settings || {};
      db.version = cloud.version || db.version;
      db.encrypted = !!cloud.encrypted;
      db.firearms.forEach(f => {
        if (!f.tags) f.tags = [];
        if (!f.roundCount) f.roundCount = 0;
        if (!f.customFields) f.customFields = [];
        if (!f.maintenanceLog) f.maintenanceLog = [];
      });
      db.ammo.forEach(a => { if (!a.lowStock) a.lowStock = 0; });
    }

    // Download referenced binaries
    const keys = this.referencedMediaKeys();
    let ok = 0;
    for (const key of keys) {
      try {
        const { data: blob, error } = await sb.storage.from('media').download(this.safePath(key));
        if (error || !blob) { console.warn('Media missing in cloud:', key, error && error.message); continue; }
        const dataURL = await this.blobToDataURL(blob);
        this.applyMedia(key, dataURL);
        this.syncedHashes[key] = this.hash(dataURL);
        ok++;
      } catch (e) { console.warn('Media download failed:', key, e); }
    }

    await this.cacheLocal();
    this.ready = true;
    this.setStatus(this.hasCloudData ? 'Synced' : 'Synced (empty)', 'ok');
    console.log('CloudSync pull complete. media ' + ok + '/' + keys.length);
  },

  // ---- PUSH: memory -> cloud --------------------------------------
  schedulePush() {
    if (!this.ready) return;
    clearTimeout(this.pushTimer);
    this.setStatus('Saving…', 'syncing');
    this.pushTimer = setTimeout(() => this.push(), 1800);
  },

  async push() {
    if (!this.ready) return;
    if (this.pushing) { this.pendingPush = true; return; }
    this.pushing = true;
    this.setStatus('Saving…', 'syncing');
    const sb = window.sbClient;
    try {
      // Conflict check: did another device change the cloud since we last synced?
      try {
        const { data: cur } = await sb.from('collections')
          .select('updated_at').eq('user_id', this.uid).maybeSingle();
        if (cur && this.serverUpdatedAt && cur.updated_at !== this.serverUpdatedAt) {
          const overwrite = (typeof confirmDialog === 'function')
            ? await confirmDialog('Your collection was changed on another device since this one loaded it. Overwrite the cloud with THIS device’s version? (Cancel keeps the other device’s version — reload this page to see it.)', { title: 'Sync conflict', okText: 'Overwrite cloud', cancelText: 'Keep other version', danger: true })
            : confirm('Your collection was changed on another device since this one loaded it.\n\nOK = overwrite the cloud with THIS device’s version.\nCancel = keep the other device’s version (reload this page to see it).');
          if (!overwrite) {
            this.setStatus('Save paused — reload to sync', 'error');
            this.pushing = false;
            return;
          }
        }
      } catch (e) { /* if the check fails, proceed with the save */ }

      const ts = new Date().toISOString();
      const structured = this.buildStructured();
      const { error } = await sb.from('collections')
        .upsert({ user_id: this.uid, data: structured, updated_at: ts },
                { onConflict: 'user_id' });
      if (error) throw error;
      this.serverUpdatedAt = ts;

      const media = this.collectMedia();
      const currentKeys = new Set(Object.keys(media));

      // upload new / changed (with progress)
      const toUpload = [...currentKeys].filter(k => this.syncedHashes[k] !== this.hash(media[k]));
      let done = 0;
      for (const key of toUpload) {
        const blob = await this.dataURLtoBlob(media[key]);
        const { error: upErr } = await sb.storage.from('media')
          .upload(this.safePath(key), blob, { upsert: true, contentType: this.mimeOf(media[key]) });
        if (upErr) throw upErr;
        this.syncedHashes[key] = this.hash(media[key]);
        done++;
        if (toUpload.length > 1) this.setStatus('Uploading ' + done + '/' + toUpload.length + '…', 'syncing');
      }

      // remove deleted
      for (const key of Object.keys(this.syncedHashes)) {
        if (!currentKeys.has(key)) {
          await sb.storage.from('media').remove([this.safePath(key)]);
          delete this.syncedHashes[key];
        }
      }

      this.hasCloudData = (db.firearms.length || db.ammo.length || db.accessories.length) > 0;
      hasUnsavedChanges = false;
      this.setStatus('Synced', 'ok');
    } catch (e) {
      console.error('Cloud save failed', e);
      // Changes are already saved on this device (IndexedDB); they upload later.
      if (navigator.onLine === false) {
        this.setStatus('Offline — changes saved on this device', 'error');
        // a retry is triggered by the 'online' event listener below
      } else {
        this.setStatus('Save failed — will retry', 'error');
        clearTimeout(this._retryTimer);
        this._retryTimer = setTimeout(() => this.push(), 8000);
      }
    } finally {
      this.pushing = false;
      if (this.pendingPush) { this.pendingPush = false; this.schedulePush(); }
    }
  },

  async syncNow() {
    clearTimeout(this.pushTimer);
    await this.push();
  },

  // Read a backup file's JSON text, transparently unzipping .zip archives.
  async readBackupText(file) {
    const isZip = /\.zip$/i.test(file.name) || file.type === 'application/zip' ||
                  file.type === 'application/x-zip-compressed';
    if (!isZip) return await file.text();
    if (!window.JSZip) throw new Error('Zip reader not loaded — try the .json instead.');
    const zip = await window.JSZip.loadAsync(file);
    const entry = Object.values(zip.files).find(f => !f.dir && /\.json$/i.test(f.name));
    if (!entry) throw new Error('No .json file found inside that .zip.');
    return await entry.async('string');
  },

  // ---- one-time restore from a full backup file -------------------
  // Accepts the app's own backup format: {..db, images:{...}} or a bare
  // firearms array, as a .json or a .zip containing one. Loads everything
  // into memory, then pushes to the cloud.
  async restoreFromFile(file) {
    const text = await this.readBackupText(file);
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error('That file is not valid JSON.'); }

    if (Array.isArray(data)) data = { firearms: data };
    if (!data.firearms || !Array.isArray(data.firearms)) {
      throw new Error('No firearms found in that file.');
    }

    db.version = data.version || 3;
    db.encrypted = false;
    db.firearms = data.firearms || [];
    db.ammo = data.ammo || [];
    db.accessories = data.accessories || [];
    db.wishlist = data.wishlist || [];
    db.dealers = data.dealers || [];
    db.auditTrail = data.auditTrail || [];
    db.valueHistory = data.valueHistory || [];
    db.settings = data.settings || {};
    db.backups = [];
    db.firearms.forEach(f => {
      if (!f.tags) f.tags = [];
      if (!f.roundCount) f.roundCount = 0;
      if (!f.customFields) f.customFields = [];
      if (!f.maintenanceLog) f.maintenanceLog = [];
    });
    db.ammo.forEach(a => { if (!a.lowStock) a.lowStock = 0; });

    const imgs = data.images || {};
    for (const [k, v] of Object.entries(imgs)) {
      imagesDb[k] = v;
      try { await idbPut(k, v); } catch (_) {}
    }

    this.ready = true;
    if (typeof updateStats === 'function') updateStats();
    if (typeof render === 'function') render();
    if (window.buildThumbnails) buildThumbnails();
    await this.cacheLocal();
    // Upload to the cloud in the background so the UI is not blocked while
    // large photos/PDFs transfer. Progress shows in the sync pill.
    this.setStatus('Uploading…', 'syncing');
    this.push().catch(e => {
      console.error('Background upload after restore failed', e);
      if (window.toast) toast('Cloud upload error — it will retry automatically.', 'error');
    });
    return { firearms: db.firearms.length, ammo: db.ammo.length, accessories: db.accessories.length, images: Object.keys(imgs).length };
  }
};

window.CloudSync = CloudSync;

// Flush pending changes as soon as the connection returns; reflect offline state.
window.addEventListener('online', () => {
  if (CloudSync.ready) { CloudSync.setStatus('Back online — syncing…', 'syncing'); CloudSync.push(); }
});
window.addEventListener('offline', () => {
  if (CloudSync.ready) CloudSync.setStatus('Offline — changes saved on this device', 'error');
});
