(function registerVaultServiceWorker() {
  'use strict';
  if (!('serviceWorker' in navigator)) return;

  const UPDATE_INTERVAL_MS = 30 * 60 * 1000;
  const MIN_UPDATE_CHECK_SPACING_MS = 5 * 60 * 1000;
  const dismissedWorkers = new WeakSet();
  let updateClicked = false;
  let reloading = false;
  let lastUpdateCheckAt = 0;
  let updateCheckPromise = null;

  function hasMemoryChanges() {
    try { return typeof hasUnsavedChanges !== 'undefined' && Boolean(hasUnsavedChanges); } catch (_) { return true; }
  }

  async function makeChangesSafeForReload() {
    if (typeof window.flushFirearmDraft === 'function') {
      const draftSafe = await window.flushFirearmDraft();
      if (!draftSafe) throw new Error('The open firearm draft could not be saved safely on this device.');
    }
    const dirtyDialog = document.querySelector('.modal-overlay.open[data-dirty="true"]:not(.app-dialog)');
    if (dirtyDialog) {
      throw new Error('Finish, save, or close the open form before updating. Its unsaved changes are still on this page.');
    }
    const memoryDirty = hasMemoryChanges();
    if (window.CloudSync && typeof window.CloudSync.prepareForSignOut === 'function') {
      const safety = await window.CloudSync.prepareForSignOut();
      if (!safety || safety.ok !== true) {
        throw new Error('The latest changes could not be saved safely on this device.');
      }
      return safety;
    }
    if (memoryDirty) throw new Error('The latest changes have not been saved safely yet.');
    return { ok: true, status: 'no-cloud-session' };
  }

  function showUpdateBanner(worker) {
    if (!worker || dismissedWorkers.has(worker) || document.getElementById('updateBanner')) return;
    const bar = document.createElement('div');
    bar.id = 'updateBanner';
    bar.className = 'update-banner';
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    const message = document.createElement('span');
    message.textContent = 'A new version is ready.';
    const update = document.createElement('button');
    update.type = 'button';
    update.className = 'update-banner-reload';
    update.textContent = 'Update now';
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'update-banner-x';
    dismiss.setAttribute('aria-label', 'Dismiss update');
    dismiss.innerHTML = '&times;';
    bar.append(message, update, dismiss);
    document.body.appendChild(bar);

    update.addEventListener('click', async () => {
      if (update.disabled) return;
      update.disabled = true;
      update.textContent = 'Securing changes…';
      message.textContent = 'Preparing the vault update safely.';
      try {
        await makeChangesSafeForReload();
        if (worker.state === 'redundant') throw new Error('That update is no longer available. Check again.');
        updateClicked = true;
        update.textContent = 'Updating…';
        message.textContent = 'Applying the update. The vault will reload once.';
        worker.postMessage({ type: 'SKIP_WAITING' });
      } catch (error) {
        updateClicked = false;
        update.disabled = false;
        update.textContent = 'Retry update';
        message.textContent = `${error && error.message ? error.message : 'The update was paused.'} Keep this page open and retry.`;
      }
    });
    dismiss.addEventListener('click', () => {
      dismissedWorkers.add(worker);
      bar.remove();
    });
  }

  async function checkForUpdate(registration, force) {
    if (!registration || document.hidden || !navigator.onLine) return;
    const now = Date.now();
    if (!force && now - lastUpdateCheckAt < MIN_UPDATE_CHECK_SPACING_MS) return;
    if (updateCheckPromise) return updateCheckPromise;
    lastUpdateCheckAt = now;
    updateCheckPromise = registration.update()
      .then(() => {
        if (registration.waiting && navigator.serviceWorker.controller) showUpdateBanner(registration.waiting);
      })
      .catch((error) => console.warn('Service worker update check failed', error))
      .finally(() => { updateCheckPromise = null; });
    return updateCheckPromise;
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateClicked || reloading) return;
    reloading = true;
    location.reload();
  });

  addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((registration) => {
      if (registration.waiting && navigator.serviceWorker.controller) showUpdateBanner(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(worker);
        });
      });

      setTimeout(() => checkForUpdate(registration, true), 60 * 1000);
      setInterval(() => checkForUpdate(registration, false), UPDATE_INTERVAL_MS);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) checkForUpdate(registration, false);
      });
      addEventListener('focus', () => checkForUpdate(registration, false));
      addEventListener('online', () => checkForUpdate(registration, true));
    }).catch((error) => console.warn('Service worker registration failed', error));
  });
})();
