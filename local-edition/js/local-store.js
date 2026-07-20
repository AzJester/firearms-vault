// =====================================================
// LOCAL EDITION RUNTIME
// =====================================================
// This file replaces the cloud stack (config.js + supabase-client.js +
// cloud-sync.js + auth.js) used by the online edition. In this build there is
// no account, no login, and no network sync: everything you enter is stored
// only in this browser/app via IndexedDB and never leaves your device.
//
// app.js is shared, unmodified, with the online edition. It already persists
// every change to IndexedDB on its own (saveToLocalStorage), and only *also*
// pushes to the cloud when CloudSync.ready is true — so by providing an inert
// CloudSync below, the exact same app runs fully offline and local-only.

(function () {
  'use strict';

  // ---- Inert cloud layer -------------------------------------------------
  // app.js guards every cloud call with `window.CloudSync && CloudSync.<x>`.
  //  - uid is null  => bootApp() skips the cloud pull entirely
  //  - ready false  => saveToLocalStorage() never schedules a network push
  window.CloudSync = {
    uid: null,
    ready: false,
    hasCloudData: false,
    pull: async function () {},
    push: async function () {},
    schedulePush: function () {},
    syncNow: function () {
      if (window.toast) toast('This is the local edition — your data is saved on this device. There is no cloud to sync to.', 'info', 5000);
    }
  };

  // Auth has no meaning offline; keep a stub so any stray reference is safe.
  window.Auth = { signOut: function () {} };

  // ---- Cloud-only features that remain referenced in shared code ----------
  // Read-only share links require the server, so make them a friendly no-op.
  window.openShareModal = function () {
    if (window.toast) toast('Share links are an online-edition feature. To share a copy locally, use Tools → Export (Excel/JSON) or “Save to File”.', 'info', 6000);
  };
  window.changeCloudPassword = function () {};

  // ---- About dialog ------------------------------------------------------
  window.openAbout = function () {
    var m = document.getElementById('aboutModal');
    if (m) m.classList.add('open');
  };
  window.closeAbout = function () {
    var m = document.getElementById('aboutModal');
    if (m) m.classList.remove('open');
  };

  // ---- First-run sample data --------------------------------------------
  var ONBOARDED_KEY = 'fdb_local_onboarded';
  function newId() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 6); }
  function today(offsetDays) {
    var d = new Date();
    if (offsetDays) d.setDate(d.getDate() - offsetDays);
    return d.toISOString().slice(0, 10);
  }

  // A few realistic, fictional entries so a new buyer sees a populated app.
  // No real serial numbers — placeholders the user is meant to overwrite.
  function sampleFirearms() {
    return [
      {
        id: newId(), make: 'Smith & Wesson', model: 'M&P15 Sport II', serial: 'SAMPLE-0001',
        caliber: '5.56 NATO', type: 'Rifle', barrel: '16"', condition: 'Excellent',
        price: 749.99, dateAcquired: today(420), status: 'Active',
        tags: ['range', 'AR-15'], images: [], isNFA: false,
        notes: '<p>Sample entry — edit or delete me. Great first AR platform.</p>'
      },
      {
        id: newId(), make: 'Glock', model: '19 Gen 5', serial: 'SAMPLE-0002',
        caliber: '9mm', type: 'Pistol', barrel: '4.02"', condition: 'New',
        price: 539.0, dateAcquired: today(180), status: 'Active',
        tags: ['carry'], images: [], isNFA: false,
        notes: '<p>Sample entry — daily carry pistol.</p>'
      },
      {
        id: newId(), make: 'Ruger', model: '10/22 Carbine', serial: 'SAMPLE-0003',
        caliber: '22 LR', type: 'Rifle', barrel: '18.5"', condition: 'Good',
        price: 329.0, dateAcquired: today(900), status: 'Active',
        tags: ['plinking', 'rimfire'], images: [], isNFA: false,
        notes: '<p>Sample entry — classic rimfire plinker.</p>'
      }
    ];
  }

  window.loadSampleData = async function () {
    sampleFirearms().forEach(function (f) { db.firearms.push(f); });
    if (Array.isArray(db.ammo)) {
      db.ammo.push({
        id: newId(), brand: 'Federal American Eagle', caliber: '5.56 NATO',
        quantity: 400, purchaseDate: today(120), pricePerRound: 0.42,
        location: 'Safe — ammo can A', lowStock: 100, notes: ''
      });
    }
    localStorage.setItem(ONBOARDED_KEY, '1');
    hideFirstRun();
    await saveData();
    if (typeof render === 'function') render();
    if (window.toast) toast('Loaded sample data. Edit or delete it any time — it’s just to show you around.', 'success', 5000);
  };

  function hideFirstRun() {
    var fr = document.getElementById('localFirstRun');
    if (fr) fr.style.display = 'none';
  }
  window.dismissFirstRun = function () {
    localStorage.setItem(ONBOARDED_KEY, '1');
    hideFirstRun();
  };

  // ---- Local full-backup restore ----------------------------------------
  // The online edition restored backups through the cloud; here we load a
  // backup file (as written by "Backup Now" / "Save to File") straight back
  // into this device's IndexedDB. Symmetric, fully offline.
  async function restoreLocalBackup(file) {
    var parsed;
    try { parsed = JSON.parse(await file.text()); }
    catch (e) { if (window.toast) toast('That file isn’t a valid backup (.json).', 'error'); return; }
    if (!parsed || typeof parsed !== 'object') { if (window.toast) toast('That file isn’t a recognized backup.', 'error'); return; }

    var ok = (typeof confirmDialog === 'function')
      ? await confirmDialog('Replace your ENTIRE current collection with “' + file.name + '”? This overwrites everything currently stored on this device. (Tip: use “Save to File” first if you want a safety copy.)',
          { title: 'Restore from file', okText: 'Replace everything', danger: true })
      : confirm('Replace your entire collection with ' + file.name + '?');
    if (!ok) return;

    try {
      db.firearms = parsed.firearms || [];
      db.ammo = parsed.ammo || [];
      db.accessories = parsed.accessories || [];
      db.wishlist = parsed.wishlist || [];
      db.dealers = parsed.dealers || [];
      db.valueHistory = parsed.valueHistory || [];
      db.auditTrail = parsed.auditTrail || [];
      db.settings = parsed.settings || {};
      db.firearms.forEach(function (f) { if (!f.tags) f.tags = []; });

      var imgs = parsed.images || {};
      imagesDb = {};
      for (var k in imgs) {
        if (!Object.prototype.hasOwnProperty.call(imgs, k)) continue;
        imagesDb[k] = imgs[k];
        try { await idbPut(k, imgs[k]); } catch (e) { /* keep in-memory copy */ }
      }

      await saveData();
      if (typeof buildThumbnails === 'function') buildThumbnails();
      if (typeof render === 'function') render();
      if (window.toast) toast('Restored ' + db.firearms.length + ' firearms from backup.', 'success', 5000);
    } catch (e) {
      if (window.toast) toast('Restore failed: ' + e.message, 'error', 6000);
    }
  }
  window.restoreLocalBackup = restoreLocalBackup;

  // ---- Boot --------------------------------------------------------------
  async function boot() {
    var appRoot = document.getElementById('appRoot');
    if (appRoot) appRoot.style.display = '';

    if (typeof window.bootApp === 'function') {
      try { await window.bootApp(); }
      catch (e) { console.error('bootApp failed', e); }
    }

    // Re-label the status bar for a local, no-account build.
    var dot = document.getElementById('statusDot');
    if (dot) dot.className = 'file-status-dot connected';
    var st = document.getElementById('fileStatusText');
    if (st) st.textContent = 'Saved on this device';

    // Wire "Restore from File" to the local restore (the cloud build did this
    // in auth.js, which this edition doesn't load).
    var rf = document.getElementById('restoreFile');
    if (rf) rf.addEventListener('change', function (e) {
      var f = e.target.files[0];
      e.target.value = '';
      if (f) restoreLocalBackup(f);
    });

    // Offer sample data on the very first run with an empty collection.
    try {
      var empty = (db.firearms.length + db.ammo.length + db.accessories.length) === 0;
      if (empty && !localStorage.getItem(ONBOARDED_KEY)) {
        var fr = document.getElementById('localFirstRun');
        if (fr) fr.style.display = 'flex';
      }
    } catch (e) { /* db not ready — skip onboarding */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
