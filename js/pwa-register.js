(function registerVaultServiceWorker() {
  'use strict';
  if (!('serviceWorker' in navigator)) return;
  let updateClicked = false;
  let reloading = false;

  function showUpdateBanner(worker) {
    if (!worker || document.getElementById('updateBanner')) return;
    const bar = document.createElement('div');
    bar.id = 'updateBanner'; bar.className = 'update-banner';
    const message = document.createElement('span'); message.textContent = 'A new version is available.';
    const reload = document.createElement('button'); reload.type = 'button'; reload.className = 'update-banner-reload'; reload.textContent = 'Reload';
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'update-banner-x'; dismiss.setAttribute('aria-label', 'Dismiss'); dismiss.innerHTML = '&times;';
    bar.append(message, reload, dismiss); document.body.appendChild(bar);
    reload.addEventListener('click', () => {
      reload.textContent = 'Updating…'; reload.disabled = true; updateClicked = true;
      worker.postMessage('SKIP_WAITING');
    });
    dismiss.addEventListener('click', () => bar.remove());
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateClicked || reloading) return;
    reloading = true; location.reload();
  });

  addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(registration => {
      if (registration.waiting && navigator.serviceWorker.controller) showUpdateBanner(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(worker);
        });
      });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) registration.update().catch(() => {}); });
    }).catch(error => console.warn('Service worker registration failed', error));
  });
})();
