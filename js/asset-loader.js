// Loads optional, self-hosted feature libraries only when the user invokes the
// corresponding feature. Nothing here contacts a third-party CDN.
(function initVaultAssets(global) {
  'use strict';

  const pending = new Map();
  const groups = {
    charts: [
      { src: 'vendor/chart.umd.js', ready: () => Boolean(global.Chart) }
    ],
    excel: [
      { src: 'vendor/xlsx.full.min.js', ready: () => Boolean(global.XLSX) }
    ],
    pdf: [
      { src: 'vendor/jspdf.umd.min.js', ready: () => Boolean(global.jspdf && global.jspdf.jsPDF) },
      { src: 'vendor/jspdf.plugin.autotable.min.js', ready: () => Boolean(global.jspdf && global.jspdf.jsPDF && global.jspdf.jsPDF.API.autoTable) }
    ],
    ocr: [
      { src: 'vendor/tesseract/tesseract.min.js', ready: () => Boolean(global.Tesseract) }
    ],
    qr: [
      { src: 'vendor/qrcode.min.js', ready: () => Boolean(global.QRCode) }
    ],
    zip: [
      { src: 'vendor/jszip.min.js', ready: () => Boolean(global.JSZip) }
    ]
  };

  function loadScript(asset) {
    if (asset.ready()) return Promise.resolve();
    if (pending.has(asset.src)) return pending.get(asset.src);
    const promise = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-vault-asset="${asset.src}"]`);
      if (existing) {
        existing.addEventListener('load', () => asset.ready() ? resolve() : reject(new Error(`Feature library did not initialize: ${asset.src}`)), { once: true });
        existing.addEventListener('error', () => reject(new Error(`Unable to load ${asset.src}`)), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = asset.src;
      script.async = true;
      script.dataset.vaultAsset = asset.src;
      script.addEventListener('load', () => asset.ready() ? resolve() : reject(new Error(`Feature library did not initialize: ${asset.src}`)), { once: true });
      script.addEventListener('error', () => reject(new Error(`Unable to load ${asset.src}`)), { once: true });
      document.head.appendChild(script);
    }).catch((error) => {
      pending.delete(asset.src);
      throw error;
    });
    pending.set(asset.src, promise);
    return promise;
  }

  async function ensure(group) {
    const assets = groups[group];
    if (!assets) throw new Error(`Unknown optional feature library: ${group}`);
    // Preserve dependency order (the AutoTable plugin must follow jsPDF).
    for (const asset of assets) await loadScript(asset);
  }

  function isReady(group) {
    return Boolean(groups[group] && groups[group].every((asset) => asset.ready()));
  }

  global.VaultAssets = Object.freeze({ ensure, isReady });
})(window);
