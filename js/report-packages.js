// Privacy-first insurance/theft report packages. Redacted reports are ordinary
// ZIP files; full reports are always wrapped in an authenticated AES-GCM
// envelope and can be decrypted locally without uploading their contents.
(function initReportPackages(global) {
  'use strict';

  const OUTER_FORMAT = 'firearms-vault-report-package';
  const INNER_FORMAT = 'firearms-vault-evidence-report';
  const FORMAT_VERSION = 1;
  const ITERATIONS = 310000;
  const MAX_PASSWORD_BYTES = 72;
  const MAX_PACKAGE_BYTES = 150 * 1024 * 1024;
  const ALLOWED_MEDIA = new Set([
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'
  ]);
  const MIME_EXTENSIONS = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif'
  };

  function element(id) { return document.getElementById(id); }

  function notify(message, type, timeout) {
    if (typeof global.toast === 'function') global.toast(message, type, timeout);
    else if (message) console.warn('[Report Packages]', message);
  }

  function setStatus(message, kind) {
    const status = element('reportPackageStatus');
    if (!status) return;
    status.textContent = String(message || '');
    status.dataset.kind = kind || '';
    status.hidden = !message;
  }

  function setBusy(busy) {
    const modal = element('reportPackageModal');
    if (modal) modal.setAttribute('aria-busy', busy ? 'true' : 'false');
    ['reportPackageGenerateBtn', 'reportPackageDecryptBtn'].forEach(id => {
      const button = element(id);
      if (button) button.disabled = Boolean(busy);
    });
  }

  function database() {
    try {
      if (typeof db !== 'undefined' && db && Array.isArray(db.firearms)) return db;
    } catch (_) {}
    return global.db || { firearms: [], accessories: [] };
  }

  function selectedIdSet() {
    let ids = [];
    try {
      if (typeof bulkSelected !== 'undefined' && bulkSelected && typeof bulkSelected.forEach === 'function') {
        bulkSelected.forEach(id => ids.push(String(id)));
      }
    } catch (_) {}
    if (!ids.length && global.bulkSelected && typeof global.bulkSelected.forEach === 'function') {
      global.bulkSelected.forEach(id => ids.push(String(id)));
    }
    const valid = new Set((database().firearms || []).map(item => String(item.id)));
    return new Set(ids.filter(id => valid.has(id)));
  }

  function selectedIds() { return [...selectedIdSet()]; }

  function plainText(value) {
    const source = String(value == null ? '' : value);
    if (!/[<&]/.test(source)) return source.trim();
    // Strip markup before decoding entities so attachment-like HTML cannot
    // create active DOM nodes merely because a report is being generated.
    const stripped = source.replace(/<[^>]*>/g, ' ');
    const decoder = document.createElement('textarea');
    decoder.innerHTML = stripped;
    return decoder.value.replace(/\s+/g, ' ').trim();
  }

  function numberOrNull(value) {
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeSerialMode(value, mode, purpose) {
    const candidate = String(value || '').toLowerCase();
    if (['omit', 'last4', 'full'].includes(candidate)) return candidate;
    if (mode === 'full' || purpose === 'theft') return 'full';
    return 'omit';
  }

  function normalizeOptions(options) {
    const source = options || {};
    const purpose = source.purpose === 'theft' ? 'theft' : 'insurance';
    const mode = source.mode === 'full' ? 'full' : 'redacted';
    const currentSelection = selectedIds();
    const scope = source.scope || (currentSelection.length ? 'selected' : 'active');
    const serialMode = normalizeSerialMode(source.serialMode, mode, purpose);
    const encrypt = mode === 'full' ? true : Boolean(source.encrypt);
    return {
      purpose,
      mode,
      scope,
      ids: Array.isArray(source.ids) ? source.ids.map(String) : null,
      includeDisposed: Boolean(source.includeDisposed),
      serialMode,
      encrypt,
      password: String(source.password || ''),
      includeValues: source.includeValues !== undefined ? Boolean(source.includeValues) : true,
      includePhotos: source.includePhotos !== undefined ? Boolean(source.includePhotos) : mode === 'full',
      includeReceipts: source.includeReceipts !== undefined ? Boolean(source.includeReceipts) : mode === 'full',
      includeDocuments: source.includeDocuments !== undefined ? Boolean(source.includeDocuments) : mode === 'full',
      includeTaxStamps: source.includeTaxStamps !== undefined ? Boolean(source.includeTaxStamps) : mode === 'full',
      includeAccessories: source.includeAccessories !== undefined ? Boolean(source.includeAccessories) : true,
      includeNotes: mode === 'full' && Boolean(source.includeNotes),
      includeCustomFields: mode === 'full' && Boolean(source.includeCustomFields),
      includeDisposition: mode === 'full' && Boolean(source.includeDisposition),
      includeExactDates: mode === 'full' || Boolean(source.includeExactDates),
      title: String(source.title || (purpose === 'theft' ? 'Theft / Loss Identification Report' : 'Insurance Inventory Report')).trim(),
      download: source.download !== false,
      filename: source.filename ? String(source.filename) : '',
      allowSensitiveUnencrypted: Boolean(source.allowSensitiveUnencrypted)
    };
  }

  function recordsForOptions(options, sourceDb) {
    const opts = normalizeOptions(options);
    const data = sourceDb || database();
    const firearms = Array.isArray(data.firearms) ? data.firearms : [];
    let idSet = null;
    if (opts.ids) idSet = new Set(opts.ids);
    else if (opts.scope === 'selected') idSet = selectedIdSet();
    let records = idSet ? firearms.filter(item => idSet.has(String(item.id))) : firearms.slice();
    if (opts.scope === 'active' || (!opts.includeDisposed && opts.scope !== 'selected')) {
      records = records.filter(item => !item.status || item.status === 'Active');
    }
    return records;
  }

  function redactSerial(serial, mode) {
    const value = String(serial || '').trim();
    if (!value || mode === 'omit') return '';
    if (mode === 'full') return value;
    const normalized = value.replace(/\s+/g, '');
    if (normalized.length <= 4) return 'Ending ' + normalized;
    return 'Ending ' + normalized.slice(-4);
  }

  function acquisitionDate(record, exact) {
    const value = String(record && record.dateAcquired || '').trim();
    if (!value) return '';
    if (exact) return value;
    const match = /^(\d{4})/.exec(value);
    return match ? match[1] : '';
  }

  function itemSnapshot(record, index, options) {
    const opts = normalizeOptions(options);
    const item = {
      itemKey: 'item-' + String(index + 1).padStart(3, '0'),
      make: String(record.make || '').trim(),
      model: String(record.model || '').trim(),
      caliber: String(record.caliber || '').trim(),
      type: String(record.type || '').trim(),
      barrel: String(record.barrel || '').trim(),
      condition: String(record.condition || '').trim(),
      status: String(record.status || 'Active').trim(),
      acquired: acquisitionDate(record, opts.includeExactDates),
      isNFA: Boolean(record.isNFA)
    };
    const serial = redactSerial(record.serial, opts.serialMode);
    if (serial) item.serial = serial;
    if (opts.includeValues) item.documentedValue = numberOrNull(record.price);
    if (record.isNFA) item.nfaType = String(record.nfaType || '').trim();
    if (opts.mode === 'full') {
      item.formType = String(record.formType || '').trim();
      item.stampStatus = String(record.stampStatus || '').trim();
      item.registrationType = String(record.regType || '').trim();
      item.dateSubmitted = String(record.dateSubmitted || '').trim();
      item.dateApproved = String(record.dateApproved || '').trim();
      item.roundCount = Number.parseInt(record.roundCount, 10) || 0;
      item.warrantyExpiration = String(record.warrantyExp || '').trim();
      item.tags = Array.isArray(record.tags) ? record.tags.map(value => String(value)).filter(Boolean) : [];
      if (opts.includeNotes) item.notes = plainText(record.notes);
      if (opts.includeCustomFields) {
        item.customFields = (Array.isArray(record.customFields) ? record.customFields : [])
          .map(field => ({ name: String(field.name || '').trim(), value: String(field.value || '').trim() }))
          .filter(field => field.name || field.value);
      }
      if (opts.includeDisposition && record.status && record.status !== 'Active') {
        item.disposition = {
          date: String(record.dispDate || '').trim(),
          buyer: String(record.dispBuyer || '').trim(),
          price: numberOrNull(record.dispPrice),
          dealer: String(record.dispFFL || '').trim(),
          notes: plainText(record.dispNotes)
        };
      }
    }
    return item;
  }

  function accessorySnapshot(accessory, itemKey, includeValues) {
    const result = {
      itemKey,
      name: String(accessory.name || '').trim(),
      category: String(accessory.category || '').trim(),
      brand: String(accessory.brand || '').trim(),
      model: String(accessory.model || '').trim()
    };
    if (includeValues) result.documentedValue = numberOrNull(accessory.price);
    return result;
  }

  function buildSnapshot(records, options, sourceDb) {
    const opts = normalizeOptions(options);
    const data = sourceDb || database();
    const originalRecords = Array.isArray(records) ? records : recordsForOptions(opts, data);
    const items = originalRecords.map((record, index) => itemSnapshot(record, index, opts));
    const itemKeys = new Map(originalRecords.map((record, index) => [String(record.id), items[index].itemKey]));
    const accessories = opts.includeAccessories
      ? (Array.isArray(data.accessories) ? data.accessories : [])
        .filter(accessory => itemKeys.has(String(accessory.firearmId)))
        .map(accessory => accessorySnapshot(accessory, itemKeys.get(String(accessory.firearmId)), opts.includeValues))
      : [];
    const firearmValue = items.reduce((sum, item) => sum + (Number(item.documentedValue) || 0), 0);
    const accessoryValue = accessories.reduce((sum, item) => sum + (Number(item.documentedValue) || 0), 0);
    return {
      format: INNER_FORMAT,
      formatVersion: FORMAT_VERSION,
      generatedAt: new Date().toISOString(),
      source: 'Firearms Vault',
      appVersion: (() => {
        try { if (typeof APP_VERSION !== 'undefined') return String(APP_VERSION); } catch (_) {}
        return typeof global.APP_VERSION === 'string' ? global.APP_VERSION : '';
      })(),
      title: opts.title,
      purpose: opts.purpose,
      profile: opts.mode,
      privacy: {
        serialNumbers: opts.serialMode,
        exactDates: opts.includeExactDates,
        values: opts.includeValues,
        photos: opts.includePhotos,
        receipts: opts.includeReceipts,
        documents: opts.includeDocuments,
        taxStamps: opts.includeTaxStamps,
        photosMayContainVisibleIdentifiers: opts.includePhotos
      },
      totals: {
        firearms: items.length,
        accessories: accessories.length,
        documentedValue: Math.round((firearmValue + accessoryValue) * 100) / 100
      },
      items,
      accessories
    };
  }

  function mediaDescriptors(records, options) {
    const opts = normalizeOptions(options);
    const descriptors = [];
    records.forEach((record, index) => {
      const itemKey = 'item-' + String(index + 1).padStart(3, '0');
      if (opts.includePhotos) {
        (Array.isArray(record.images) ? record.images : []).forEach((id, photoIndex) => {
          descriptors.push({
            key: String(id),
            itemKey,
            kind: 'photo',
            basePath: 'media/' + itemKey + '/photo-' + String(photoIndex + 1).padStart(2, '0'),
            fallbackData: null
          });
        });
      }
      if (opts.includeReceipts && record.receipt) {
        const key = String(record.receipt).startsWith('@media:')
          ? String(record.receipt).slice(7)
          : 'receipt:firearm:' + record.id;
        descriptors.push({ key, itemKey, kind: 'receipt', basePath: 'media/' + itemKey + '/receipt', fallbackData: String(record.receipt).startsWith('data:') ? record.receipt : null });
      }
      if (opts.includeDocuments) {
        (Array.isArray(record.documents) ? record.documents : []).forEach((documentRecord, documentIndex) => {
          descriptors.push({
            key: 'doc:' + record.id + ':' + documentRecord.id,
            itemKey,
            kind: 'document',
            basePath: 'media/' + itemKey + '/document-' + String(documentIndex + 1).padStart(2, '0'),
            fallbackData: documentRecord.data || null,
            originalName: documentRecord.name || ''
          });
        });
      }
      if (opts.includeTaxStamps && record.stampPdf) {
        const key = String(record.stampPdf).startsWith('@media:')
          ? String(record.stampPdf).slice(7)
          : 'stamp:firearm:' + record.id;
        descriptors.push({ key, itemKey, kind: 'tax-stamp', basePath: 'media/' + itemKey + '/tax-stamp', fallbackData: String(record.stampPdf).startsWith('data:') ? record.stampPdf : null });
      }
    });
    return descriptors;
  }

  function residentMedia(descriptor, records) {
    if (global.CloudSync && typeof global.CloudSync.residentMedia === 'function') {
      const value = global.CloudSync.residentMedia(descriptor.key);
      if (typeof value === 'string' && value.startsWith('data:')) return value;
    }
    if (descriptor.fallbackData && String(descriptor.fallbackData).startsWith('data:')) return descriptor.fallbackData;
    if (!descriptor.key.includes(':')) {
      try {
        if (typeof imagesDb !== 'undefined' && imagesDb && imagesDb[descriptor.key]) return imagesDb[descriptor.key];
      } catch (_) {}
      if (global.imagesDb && global.imagesDb[descriptor.key]) return global.imagesDb[descriptor.key];
    }
    const record = (records || []).find(item => String(item.id) === String(descriptor.key.split(':')[2] || ''));
    if (!record) return null;
    if (descriptor.kind === 'receipt') return record.receipt;
    if (descriptor.kind === 'tax-stamp') return record.stampPdf;
    return null;
  }

  function dataURLToBlob(dataURL) {
    const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(String(dataURL || ''));
    if (!match) throw new Error('An attachment is not stored in a supported format.');
    const mime = String(match[1] || '').toLowerCase();
    if (!ALLOWED_MEDIA.has(mime)) throw new Error('Only PDF and common image attachments can be packaged.');
    let bytes;
    try {
      if (match[2]) {
        const binary = atob(match[3].replace(/\s/g, ''));
        bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      } else bytes = new TextEncoder().encode(decodeURIComponent(match[3]));
    } catch (_) {
      throw new Error('An attachment is damaged or incomplete.');
    }
    if (bytes.byteLength > 75 * 1024 * 1024) throw new Error('An individual attachment is too large to package safely.');
    return new Blob([bytes], { type: mime });
  }

  function safeFilename(value) {
    const cleaned = String(value || 'file')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\.\.+/g, '.')
      .replace(/^\.+|\.+$/g, '')
      .trim()
      .slice(0, 96);
    return cleaned || 'file';
  }

  function bytesToHex(bytes) {
    return Array.from(bytes).map(value => value.toString(16).padStart(2, '0')).join('');
  }

  async function sha256(value) {
    const bytes = value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(await value.arrayBuffer());
    return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const encoded = String(value || '');
    if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('The secure package encoding is invalid.');
    let binary;
    try { binary = atob(encoded); } catch (_) { throw new Error('The secure package encoding is invalid.'); }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function passwordBytes(password) { return new TextEncoder().encode(String(password || '')).byteLength; }

  function validatePassword(password) {
    const value = String(password || '');
    if (value.length < 12) throw new Error('Use a package password with at least 12 characters.');
    if (passwordBytes(value) > MAX_PASSWORD_BYTES) throw new Error('A package password cannot exceed 72 bytes.');
    return value;
  }

  async function deriveKey(password, salt, iterations, usages) {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      usages
    );
  }

  function authenticatedHeader(iterations) {
    return new TextEncoder().encode(JSON.stringify({
      format: OUTER_FORMAT,
      formatVersion: FORMAT_VERSION,
      algorithm: 'AES-256-GCM',
      kdf: 'PBKDF2-SHA256',
      iterations
    }));
  }

  async function encryptBytes(bytes, password) {
    const plaintext = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (plaintext.byteLength > MAX_PACKAGE_BYTES) throw new Error('The report package is too large to encrypt safely in this browser.');
    const secret = validatePassword(password);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(secret, salt, ITERATIONS, ['encrypt']);
    const ciphertext = await crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv,
      additionalData: authenticatedHeader(ITERATIONS),
      tagLength: 128
    }, key, plaintext);
    return {
      format: OUTER_FORMAT,
      formatVersion: FORMAT_VERSION,
      encrypted: true,
      algorithm: 'AES-256-GCM',
      kdf: 'PBKDF2-SHA256',
      iterations: ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext))
    };
  }

  async function decryptEnvelope(envelope, password) {
    if (!envelope || envelope.format !== OUTER_FORMAT || envelope.formatVersion !== FORMAT_VERSION || !envelope.encrypted) {
      throw new Error('This is not a supported Firearms Vault secure report package.');
    }
    if (envelope.algorithm !== 'AES-256-GCM' || envelope.kdf !== 'PBKDF2-SHA256') {
      throw new Error('This secure package uses unsupported encryption settings.');
    }
    const iterations = Number(envelope.iterations);
    if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) {
      throw new Error('This secure package has invalid key-derivation settings.');
    }
    const salt = base64ToBytes(envelope.salt);
    const iv = base64ToBytes(envelope.iv);
    const ciphertext = base64ToBytes(envelope.ciphertext);
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 17 || ciphertext.length > MAX_PACKAGE_BYTES + 16) {
      throw new Error('This secure package is damaged or too large.');
    }
    const secret = validatePassword(password);
    const key = await deriveKey(secret, salt, iterations, ['decrypt']);
    try {
      const plaintext = await crypto.subtle.decrypt({
        name: 'AES-GCM',
        iv,
        additionalData: authenticatedHeader(iterations),
        tagLength: 128
      }, key, ciphertext);
      return new Uint8Array(plaintext);
    } catch (_) {
      throw new Error('The package password is incorrect or the file has been changed.');
    }
  }

  async function ensureAsset(group, label) {
    if (typeof global.ensureFeatureAsset === 'function') {
      const ready = await global.ensureFeatureAsset(group, label);
      if (!ready) throw new Error(label + ' is unavailable.');
      return;
    }
    if (!global.VaultAssets || typeof global.VaultAssets.ensure !== 'function') throw new Error(label + ' is unavailable.');
    await global.VaultAssets.ensure(group);
  }

  function money(value) {
    const number = Number(value);
    return Number.isFinite(number)
      ? number.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
      : '—';
  }

  async function buildPdf(snapshot) {
    await ensureAsset('pdf', 'PDF report export');
    const PDF = global.jspdf && global.jspdf.jsPDF;
    if (!PDF) throw new Error('The PDF report library did not initialize.');
    const doc = new PDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
    doc.setFontSize(17);
    doc.text(snapshot.title || 'Firearms Vault Report', 40, 42);
    doc.setFontSize(9);
    doc.setFont(undefined, 'normal');
    doc.text('Generated ' + new Date(snapshot.generatedAt).toLocaleString() + ' · ' + snapshot.profile + ' ' + snapshot.purpose + ' package', 40, 60);
    const headers = ['Make / Model'];
    if (snapshot.privacy.serialNumbers !== 'omit') headers.push(snapshot.privacy.serialNumbers === 'last4' ? 'Serial (last 4)' : 'Serial');
    headers.push('Caliber', 'Type', 'Condition', snapshot.privacy.exactDates ? 'Acquired' : 'Acquired year');
    if (snapshot.privacy.values) headers.push('Documented value');
    const body = snapshot.items.map(item => {
      const row = [[item.make, item.model].filter(Boolean).join(' ') || 'Untitled item'];
      if (snapshot.privacy.serialNumbers !== 'omit') row.push(item.serial || '—');
      row.push(item.caliber || '—', item.type || '—', item.condition || '—', item.acquired || '—');
      if (snapshot.privacy.values) row.push(money(item.documentedValue));
      return row;
    });
    doc.autoTable({
      head: [headers], body, startY: 76, theme: 'grid',
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [26, 58, 92] }
    });
    const y = Math.min(570, (doc.lastAutoTable && doc.lastAutoTable.finalY || 76) + 20);
    doc.setFontSize(10);
    doc.setFont(undefined, 'bold');
    doc.text('Items: ' + snapshot.totals.firearms + (snapshot.privacy.values ? '   Documented total: ' + money(snapshot.totals.documentedValue) : ''), 40, y);
    doc.setFontSize(8);
    doc.setFont(undefined, 'normal');
    const notes = [];
    if (snapshot.privacy.serialNumbers === 'omit') notes.push('Serial numbers are omitted.');
    else if (snapshot.privacy.serialNumbers === 'last4') notes.push('Only the last four serial-number characters are shown.');
    if (snapshot.privacy.photos) notes.push('Review included photos separately; visible markings in a photo are not automatically redacted.');
    if (notes.length) doc.text(notes.join(' '), 40, y + 16, { maxWidth: 700 });
    return new Uint8Array(doc.output('arraybuffer'));
  }

  function readme(snapshot) {
    const lines = [
      snapshot.title,
      '',
      'Created locally by Firearms Vault on ' + snapshot.generatedAt + '.',
      'Purpose: ' + snapshot.purpose,
      'Privacy profile: ' + snapshot.profile,
      'Serial numbers: ' + snapshot.privacy.serialNumbers,
      '',
      'report.pdf is the human-readable report.',
      'inventory.json contains the same allowlisted structured data.',
      'manifest.json lists every packaged file and its SHA-256 digest.'
    ];
    if (snapshot.privacy.photos) {
      lines.push('', 'Important: photos can contain visible serial numbers or other identifying marks. They are not automatically blurred.');
    }
    return lines.join('\r\n') + '\r\n';
  }

  async function verifySelectedMedia(descriptors) {
    if (!descriptors.length) return;
    const keys = descriptors.map(item => item.key);
    if (typeof global.ensureReferencedMediaReady === 'function') {
      const readiness = await global.ensureReferencedMediaReady({ keys, retry: true });
      if (!readiness.ok) {
        const error = new Error('The report stopped because ' + readiness.missing.length + ' selected attachment' + (readiness.missing.length === 1 ? ' is' : 's are') + ' unavailable on this device.');
        error.code = 'MEDIA_INCOMPLETE';
        error.mediaReadiness = readiness;
        throw error;
      }
    }
  }

  async function buildZip(records, options, sourceDb) {
    const opts = normalizeOptions(options);
    await ensureAsset('zip', 'ZIP report export');
    if (!global.JSZip) throw new Error('The ZIP report library did not initialize.');
    const snapshot = buildSnapshot(records, opts, sourceDb);
    const descriptors = mediaDescriptors(records, opts);
    await verifySelectedMedia(descriptors);
    const zip = new global.JSZip();
    const files = [];

    async function add(path, value, mime) {
      const bytes = typeof value === 'string'
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array(await value.arrayBuffer());
      zip.file(path, bytes, { binary: true, createFolders: true });
      files.push({ path, mime, bytes: bytes.byteLength, sha256: await sha256(bytes) });
    }

    setStatus('Building the report…', 'info');
    await add('report.pdf', await buildPdf(snapshot), 'application/pdf');
    await add('inventory.json', JSON.stringify(snapshot, null, 2) + '\n', 'application/json');
    await add('README.txt', readme(snapshot), 'text/plain');

    for (const descriptor of descriptors) {
      const dataURL = residentMedia(descriptor, records);
      if (!dataURL || !String(dataURL).startsWith('data:')) {
        const error = new Error('A selected attachment became unavailable while the report was being built.');
        error.code = 'MEDIA_INCOMPLETE';
        throw error;
      }
      const blob = dataURLToBlob(dataURL);
      const extension = MIME_EXTENSIONS[blob.type] || 'bin';
      const path = safeFilename(descriptor.basePath) + '.' + extension;
      await add(path, blob, blob.type);
    }

    const manifest = {
      format: INNER_FORMAT,
      formatVersion: FORMAT_VERSION,
      generatedAt: snapshot.generatedAt,
      purpose: snapshot.purpose,
      profile: snapshot.profile,
      itemCount: snapshot.items.length,
      privacy: snapshot.privacy,
      files
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
    setStatus('Compressing the package…', 'info');
    const bytes = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      platform: 'DOS'
    });
    if (bytes.byteLength > MAX_PACKAGE_BYTES) throw new Error('The report package is too large. Export fewer photos or items.');
    return { bytes, snapshot, manifest };
  }

  function timestampName() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }

  function download(value, filename, type) {
    const blob = value instanceof Blob ? value : new Blob([value], { type: type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = safeFilename(filename);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function generate(options) {
    const opts = normalizeOptions(options);
    if (opts.mode === 'full' && !opts.encrypt) throw new Error('Full report packages must be encrypted.');
    if (!opts.encrypt && (opts.serialMode === 'full' || opts.includeReceipts || opts.includeDocuments || opts.includeTaxStamps) && !opts.allowSensitiveUnencrypted) {
      throw new Error('Serial numbers and private documents require an encrypted package.');
    }
    if (opts.encrypt) validatePassword(opts.password);
    const records = recordsForOptions(opts);
    if (!records.length) {
      throw new Error(opts.scope === 'selected' ? 'Select at least one firearm before creating this package.' : 'There are no firearms to include.');
    }
    const built = await buildZip(records, opts, database());
    const date = timestampName();
    if (opts.encrypt) {
      setStatus('Encrypting locally…', 'info');
      const envelope = await encryptBytes(built.bytes, opts.password);
      const payload = JSON.stringify(envelope);
      const filename = opts.filename || 'firearms-vault-secure-report-' + date + '.fvpackage';
      if (opts.download) download(payload, filename, 'application/vnd.firearms-vault.package+json');
      return Object.assign({ encrypted: true, envelope, payload, filename, records: records.length }, built);
    }
    const filename = opts.filename || 'firearms-vault-redacted-report-' + date + '.zip';
    if (opts.download) download(built.bytes, filename, 'application/zip');
    return Object.assign({ encrypted: false, filename, records: records.length }, built);
  }

  function controlValue(id, fallback) {
    const control = element(id);
    return control ? control.value : fallback;
  }

  function controlChecked(id, fallback) {
    const control = element(id);
    return control ? Boolean(control.checked) : Boolean(fallback);
  }

  function optionsFromDOM() {
    const purpose = controlValue('reportPackagePurpose', 'insurance');
    const mode = controlValue('reportPackageMode', purpose === 'theft' ? 'full' : 'redacted');
    return normalizeOptions({
      purpose,
      mode,
      scope: controlValue('reportPackageScope', selectedIds().length ? 'selected' : 'active'),
      serialMode: controlValue('reportPackageSerialMode', mode === 'full' || purpose === 'theft' ? 'full' : 'omit'),
      encrypt: controlChecked('reportPackageEncrypt', mode === 'full'),
      password: controlValue('reportPackagePassword', ''),
      includeDisposed: controlChecked('reportPackageIncludeDisposed', false),
      includeValues: controlChecked('reportPackageIncludeValues', true),
      includePhotos: controlChecked('reportPackageIncludePhotos', mode === 'full'),
      includeReceipts: controlChecked('reportPackageIncludeReceipts', mode === 'full'),
      includeDocuments: controlChecked('reportPackageIncludeDocuments', mode === 'full'),
      includeTaxStamps: controlChecked('reportPackageIncludeTaxStamps', mode === 'full'),
      includeAccessories: controlChecked('reportPackageIncludeAccessories', true),
      includeNotes: controlChecked('reportPackageIncludeNotes', false),
      includeCustomFields: controlChecked('reportPackageIncludeCustomFields', false),
      includeDisposition: controlChecked('reportPackageIncludeDisposition', false),
      includeExactDates: controlChecked('reportPackageIncludeExactDates', mode === 'full'),
      title: controlValue('reportPackageTitle', '')
    });
  }

  async function generateFromModal() {
    const opts = optionsFromDOM();
    const confirmation = element('reportPackagePasswordConfirm');
    if (opts.encrypt && confirmation && opts.password !== confirmation.value) {
      notify('Package passwords do not match.', 'error');
      return { ok: false, status: 'password-mismatch' };
    }
    if (!opts.encrypt && opts.mode === 'full') {
      notify('Full packages must be encrypted.', 'error');
      return { ok: false, status: 'encryption-required' };
    }
    if (opts.includePhotos && opts.serialMode !== 'full' && typeof global.confirmDialog === 'function') {
      const approved = await global.confirmDialog('Photos can show serial numbers or other identifying marks. Firearms Vault does not blur markings inside photos. Continue with these photos?', {
        title: 'Review photo privacy', okText: 'Include photos'
      });
      if (!approved) return { ok: false, status: 'cancelled' };
    }
    setBusy(true);
    try {
      const result = await generate(opts);
      ['reportPackagePassword', 'reportPackagePasswordConfirm'].forEach(id => {
        const input = element(id);
        if (input) input.value = '';
      });
      setStatus(result.encrypted ? 'Encrypted report package downloaded.' : 'Redacted ZIP report downloaded.', 'success');
      notify(result.encrypted ? 'Encrypted report package downloaded.' : 'Redacted report ZIP downloaded.', 'success');
      return { ok: true, result };
    } catch (error) {
      setStatus(error.message || String(error), 'error');
      notify('Report package failed: ' + (error.message || error), 'error', 9000);
      return { ok: false, status: error.code || 'failed', error };
    } finally {
      setBusy(false);
    }
  }

  async function generateFullEncrypted(options) {
    return generate(Object.assign({}, options || {}, { mode: 'full', encrypt: true, serialMode: 'full' }));
  }

  async function generateRedactedZip(options) {
    const source = Object.assign({}, options || {}, { mode: 'redacted', encrypt: false });
    if (!source.serialMode) source.serialMode = 'omit';
    return generate(source);
  }

  async function readEnvelopeInput(input) {
    if (input && typeof input === 'object' && input.format === OUTER_FORMAT) return input;
    if (input instanceof Blob) {
      if (input.size > MAX_PACKAGE_BYTES * 1.5) throw new Error('The secure package is too large to open safely.');
      input = await input.text();
    }
    if (typeof input !== 'string') throw new Error('Choose a .fvpackage file first.');
    try { return JSON.parse(input); }
    catch (_) { throw new Error('This secure package is not valid JSON.'); }
  }

  async function inspectZip(bytes) {
    await ensureAsset('zip', 'Secure package reader');
    const zip = await global.JSZip.loadAsync(bytes);
    const manifestEntry = zip.file('manifest.json');
    if (!manifestEntry) throw new Error('The decrypted package does not contain its manifest.');
    const manifestText = await manifestEntry.async('string');
    if (manifestText.length > 1024 * 1024) throw new Error('The decrypted package manifest is too large.');
    let manifest;
    try { manifest = JSON.parse(manifestText); }
    catch (_) { throw new Error('The decrypted package manifest is invalid.'); }
    if (manifest.format !== INNER_FORMAT || manifest.formatVersion !== FORMAT_VERSION || !Array.isArray(manifest.files)) {
      throw new Error('The decrypted package manifest is unsupported.');
    }
    if (manifest.files.length > 10000) throw new Error('The decrypted package contains too many files.');
    const listedPaths = new Set();
    let verifiedBytes = 0;
    for (const record of manifest.files) {
      const path = String(record && record.path || '');
      if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
        throw new Error('The decrypted package contains an unsafe file path.');
      }
      if (listedPaths.has(path)) throw new Error('The decrypted package manifest lists a file more than once.');
      listedPaths.add(path);
      const entry = zip.file(path);
      if (!entry || entry.dir) throw new Error('A file listed in the package manifest is missing.');
      const fileBytes = await entry.async('uint8array');
      verifiedBytes += fileBytes.byteLength;
      if (verifiedBytes > MAX_PACKAGE_BYTES) throw new Error('The decrypted package expands beyond the safe size limit.');
      if (Number(record.bytes) !== fileBytes.byteLength || !/^[a-f0-9]{64}$/i.test(String(record.sha256 || '')) || await sha256(fileBytes) !== String(record.sha256).toLowerCase()) {
        throw new Error('A file in the decrypted package failed its integrity check.');
      }
    }
    for (const [path, entry] of Object.entries(zip.files)) {
      if (!entry.dir && path !== 'manifest.json' && !listedPaths.has(path)) {
        throw new Error('The decrypted package contains an unlisted file.');
      }
    }
    return manifest;
  }

  async function decrypt(input, password, options) {
    const opts = options || {};
    const envelope = await readEnvelopeInput(input);
    const bytes = await decryptEnvelope(envelope, password);
    const manifest = opts.inspect === false ? null : await inspectZip(bytes);
    const filename = opts.filename || 'firearms-vault-decrypted-report-' + timestampName() + '.zip';
    if (opts.download) download(bytes, filename, 'application/zip');
    return { bytes, blob: new Blob([bytes], { type: 'application/zip' }), manifest, filename };
  }

  async function decryptFromModal() {
    const input = element('reportPackageDecryptFile');
    const file = input && input.files && input.files[0];
    const password = controlValue('reportPackageDecryptPassword', '');
    if (!file) { notify('Choose a .fvpackage file first.', 'error'); return { ok: false, status: 'no-file' }; }
    setBusy(true);
    setStatus('Decrypting locally…', 'info');
    try {
      const result = await decrypt(file, password, { download: true });
      setStatus('Package verified and decrypted ZIP downloaded.', 'success');
      notify('Secure package verified and decrypted.', 'success');
      if (input) input.value = '';
      const passwordInput = element('reportPackageDecryptPassword');
      if (passwordInput) passwordInput.value = '';
      const summary = element('reportPackageDecryptSummary');
      if (summary && result.manifest) {
        summary.hidden = false;
        summary.textContent = result.manifest.itemCount + ' item' + (result.manifest.itemCount === 1 ? '' : 's') + ' · ' + result.manifest.profile + ' ' + result.manifest.purpose + ' report';
      }
      return { ok: true, result };
    } catch (error) {
      setStatus(error.message || String(error), 'error');
      notify('Package could not be opened: ' + (error.message || error), 'error', 9000);
      return { ok: false, status: 'failed', error };
    } finally {
      setBusy(false);
    }
  }

  function setChecked(id, checked, disabled) {
    const control = element(id);
    if (!control) return;
    control.checked = Boolean(checked);
    if (disabled !== undefined) control.disabled = Boolean(disabled);
  }

  function applyModePreset() {
    const purpose = controlValue('reportPackagePurpose', 'insurance');
    const mode = element('reportPackageMode');
    const serialMode = element('reportPackageSerialMode');
    const encrypt = element('reportPackageEncrypt');
    const forcedFull = purpose === 'theft';
    if (forcedFull && mode) mode.value = 'full';
    if (mode) mode.disabled = forcedFull;
    const modeValue = mode ? mode.value : (forcedFull ? 'full' : 'redacted');
    const full = forcedFull || modeValue === 'full';
    if (full) {
      if (serialMode) { serialMode.value = 'full'; serialMode.disabled = forcedFull; }
      if (encrypt) { encrypt.checked = true; encrypt.disabled = true; }
      setChecked('reportPackageIncludePhotos', true, false);
      setChecked('reportPackageIncludeReceipts', true, false);
      setChecked('reportPackageIncludeDocuments', true, false);
      setChecked('reportPackageIncludeTaxStamps', true, false);
      setChecked('reportPackageIncludeExactDates', true, false);
    } else {
      if (serialMode) { serialMode.value = 'omit'; serialMode.disabled = false; }
      if (encrypt) { encrypt.checked = false; encrypt.disabled = false; }
      setChecked('reportPackageIncludeReceipts', false, true);
      setChecked('reportPackageIncludeDocuments', false, true);
      setChecked('reportPackageIncludeTaxStamps', false, true);
      setChecked('reportPackageIncludeExactDates', false, false);
    }
    return { purpose, mode: full ? 'full' : 'redacted', forcedFull };
  }

  function applyPurposePreset() {
    const purpose = controlValue('reportPackagePurpose', 'insurance');
    const mode = element('reportPackageMode');
    if (mode) mode.value = purpose === 'theft' ? 'full' : 'redacted';
    return applyModePreset();
  }

  function open() {
    const modal = element('reportPackageModal');
    if (!modal) throw new Error('The report package dialog is unavailable.');
    const selection = selectedIds();
    const count = element('reportPackageSelectionCount');
    if (count) count.textContent = selection.length
      ? selection.length + ' selected firearm' + (selection.length === 1 ? '' : 's')
      : 'No bulk selection — active firearms will be used';
    const scope = element('reportPackageScope');
    if (scope) scope.value = selection.length ? 'selected' : 'active';
    applyModePreset();
    setStatus('', '');
    modal.classList.add('open');
    return { selected: selection.length };
  }

  function close() {
    const modal = element('reportPackageModal');
    if (modal) modal.classList.remove('open');
    ['reportPackagePassword', 'reportPackagePasswordConfirm', 'reportPackageDecryptPassword'].forEach(id => {
      const input = element(id);
      if (input) input.value = '';
    });
    setBusy(false);
  }

  global.ReportPackages = Object.freeze({
    open,
    close,
    selectedIds,
    normalizeOptions,
    recordsForOptions,
    redactSerial,
    buildSnapshot,
    mediaDescriptors,
    buildZip,
    encryptBytes,
    decryptEnvelope,
    generate,
    generateFullEncrypted,
    generateRedactedZip,
    decrypt,
    inspectZip,
    optionsFromDOM,
    generateFromModal,
    decryptFromModal,
    applyPurposePreset,
    applyModePreset
  });

  // Narrow global aliases for declarative controls and command-palette actions.
  global.openReportPackageModal = open;
  global.closeReportPackageModal = close;
  global.updateReportPackagePreset = applyPurposePreset;
  global.updateReportPackageModePreset = applyModePreset;
  global.generateReportPackage = generateFromModal;
  global.generateFullEncryptedReportPackage = generateFullEncrypted;
  global.generateRedactedReportZip = generateRedactedZip;
  global.decryptReportPackage = decryptFromModal;
})(window);
