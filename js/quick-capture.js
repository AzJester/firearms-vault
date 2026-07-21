// Mobile Quick Capture: local-only camera/file OCR with an explicit hand-off to
// the existing Add Firearm review form. This module never commits a record.
(function initQuickCapture(global) {
  'use strict';

  const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
  const IMAGE_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/gif'
  ]);
  const CAPTURE_CATEGORIES = new Set(['firearm', 'serial', 'receipt', 'tax-stamp']);
  const COMMON_MAKES = [
    'Smith & Wesson', 'Springfield Armory', 'Sig Sauer', 'Heckler & Koch',
    'Daniel Defense', 'Maxim Defense', 'Century Arms', 'Beretta', 'Browning',
    'Bushmaster', 'Canik', 'Charter Arms', 'Chiappa', 'Colt', 'CZ', 'FN',
    'Glock', 'Henry', 'Heritage', 'Hi-Point', 'Kimber', 'Kel-Tec', 'Mossberg',
    'Palmetto State Armory', 'Remington', 'Ruger', 'Savage', 'Taurus',
    'Walther', 'Winchester', 'Wilson Combat', 'Staccato'
  ];
  const SERIAL_STOP_WORDS = new Set([
    'SERIAL', 'NUMBER', 'MODEL', 'CALIBER', 'CALIBRE', 'GAUGE', 'WARNING',
    'READ', 'MANUAL', 'BEFORE', 'USING', 'MADE', 'IMPORT', 'IMPORTED',
    'PISTOL', 'RIFLE', 'REVOLVER', 'SHOTGUN', 'SUPPRESSOR', 'SILENCER',
    'FIREARM', 'FIREARMS', 'AUTO', 'AUTOMATIC', 'SEMI', 'NATO', 'ACP'
  ]);

  const state = {
    stream: null,
    imageDataURL: '',
    imageFile: null,
    captures: [],
    category: 'serial',
    analysis: null,
    rawText: '',
    recognizing: false,
    operation: 0
  };

  function element(id) { return document.getElementById(id); }

  function notify(message, type, timeout) {
    if (typeof global.toast === 'function') global.toast(message, type, timeout);
    else if (message) console.warn('[Quick Capture]', message);
  }

  function setStatus(message, kind) {
    const status = element('quickCaptureStatus');
    if (!status) return;
    status.textContent = String(message || '');
    status.dataset.kind = kind || '';
    status.hidden = !message;
  }

  function setBusy(busy) {
    state.recognizing = Boolean(busy);
    const modal = element('quickCaptureModal');
    if (modal) modal.setAttribute('aria-busy', busy ? 'true' : 'false');
    ['quickCaptureAnalyzeBtn', 'quickCaptureCaptureBtn', 'quickCaptureApproveBtn']
      .forEach(id => { const button = element(id); if (button) button.disabled = Boolean(busy); });
  }

  function stopCamera() {
    const video = element('quickCaptureVideo');
    const stream = state.stream || (video && video.srcObject);
    if (stream && typeof stream.getTracks === 'function') {
      stream.getTracks().forEach(track => { try { track.stop(); } catch (_) {} });
    }
    state.stream = null;
    if (video) {
      try { video.pause(); } catch (_) {}
      video.srcObject = null;
      video.hidden = false;
    }
  }

  function clearResult() {
    state.analysis = null;
    state.rawText = '';
    ['quickCaptureRawText', 'quickCaptureSerial', 'quickCaptureMake',
      'quickCaptureModel', 'quickCaptureCaliber', 'quickCaptureType']
      .forEach(id => { const control = element(id); if (control) control.value = ''; });
    const result = element('quickCaptureResult');
    if (result) result.hidden = true;
    const duplicate = element('quickCaptureDuplicate');
    if (duplicate) { duplicate.hidden = true; duplicate.textContent = ''; }
  }

  function reset() {
    stopCamera();
    state.operation += 1;
    state.imageDataURL = '';
    state.imageFile = null;
    state.captures = [];
    state.category = captureCategory();
    setBusy(false);
    clearResult();
    setStatus('', '');
    const preview = element('quickCapturePreview');
    if (preview) { preview.removeAttribute('src'); preview.hidden = true; }
    const filename = element('quickCaptureFileName');
    if (filename) { filename.textContent = ''; filename.hidden = true; }
    const count = element('quickCaptureArtifactCount');
    if (count) count.textContent = 'No captures yet';
    const fileInput = element('quickCaptureFile');
    if (fileInput) fileInput.value = '';
    ['quickCaptureFirearmFile', 'quickCaptureSerialFile', 'quickCaptureReceiptFile', 'quickCaptureTaxStampFile']
      .forEach(id => { const input = element(id); if (input) input.value = ''; });
    const progress = element('quickCaptureProgress');
    if (progress) { progress.value = 0; progress.hidden = true; }
  }

  async function open() {
    reset();
    const modal = element('quickCaptureModal');
    if (!modal) throw new Error('The Quick Capture dialog is unavailable.');
    modal.classList.add('open');
    const video = element('quickCaptureVideo');
    if (!video || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      setStatus('Live camera is unavailable here. Choose a photo instead.', 'warning');
      const fileInput = element('quickCaptureFile');
      if (fileInput) fileInput.focus();
      return { ok: true, camera: false };
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      });
      if (!modal.classList.contains('open')) {
        stream.getTracks().forEach(track => track.stop());
        return { ok: false, status: 'closed' };
      }
      state.stream = stream;
      video.srcObject = stream;
      video.hidden = false;
      try { await video.play(); } catch (_) {}
      const category = captureCategory();
      const target = category === 'firearm' ? 'firearm'
        : category === 'serial' ? 'serial number'
          : category === 'receipt' ? 'receipt'
            : 'tax stamp';
      setStatus('Center the ' + target + ' in the frame, then capture.', 'info');
      return { ok: true, camera: true };
    } catch (error) {
      stopCamera();
      const denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      setStatus(denied
        ? 'Camera permission was not granted. Choose an existing photo instead.'
        : 'The live camera could not start. Choose an existing photo instead.', 'warning');
      return { ok: true, camera: false, error };
    }
  }

  function close() {
    state.operation += 1;
    stopCamera();
    setBusy(false);
    const modal = element('quickCaptureModal');
    if (modal) modal.classList.remove('open');
    state.imageDataURL = '';
    state.imageFile = null;
    state.captures = [];
    state.analysis = null;
    state.rawText = '';
  }

  function readAsDataURL(file) {
    if (typeof global.readFileAsDataURL === 'function') return global.readFileAsDataURL(file);
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('The selected image could not be read.'));
      reader.readAsDataURL(file);
    });
  }

  function normalizeCategory(value) {
    const category = String(value || '').trim().toLowerCase().replace(/_/g, '-');
    if (category === 'photo' || category === 'item') return 'firearm';
    if (category === 'taxstamp' || category === 'stamp') return 'tax-stamp';
    return CAPTURE_CATEGORIES.has(category) ? category : 'serial';
  }

  function captureCategory(input, explicit) {
    if (explicit) return normalizeCategory(explicit);
    const source = input && input.target ? input.target : input;
    if (source && source.dataset && (source.dataset.captureCategory || source.dataset.captureType)) {
      return normalizeCategory(source.dataset.captureCategory || source.dataset.captureType);
    }
    if (source && source.id) {
      if (/firearm/i.test(source.id)) return 'firearm';
      if (/receipt/i.test(source.id)) return 'receipt';
      if (/tax.?stamp|stamp/i.test(source.id)) return 'tax-stamp';
      if (/serial/i.test(source.id)) return 'serial';
    }
    const select = element('quickCaptureCategory');
    return normalizeCategory(select ? select.value : state.category);
  }

  function setCategory(value) {
    state.category = normalizeCategory(value || captureCategory());
    const select = element('quickCaptureCategory');
    if (select && select.value !== state.category) select.value = state.category;
    const label = state.category === 'firearm' ? 'firearm photo'
      : state.category === 'serial' ? 'serial-number close-up'
        : state.category === 'receipt' ? 'receipt'
          : 'tax stamp';
    setStatus('Capture or choose a ' + label + '. It will be handed to the Add Firearm review form.', 'info');
    if (state.stream) {
      const video = element('quickCaptureVideo');
      const preview = element('quickCapturePreview');
      const filename = element('quickCaptureFileName');
      if (video) video.hidden = false;
      if (preview) preview.hidden = true;
      if (filename) filename.hidden = true;
    }
    return state.category;
  }

  function captureName(category, file) {
    const extension = file && file.type === 'application/pdf' ? '.pdf'
      : file && file.type === 'image/png' ? '.png'
        : file && file.type === 'image/webp' ? '.webp'
          : '.jpg';
    const fallback = category === 'tax-stamp' ? 'quick-capture-tax-stamp'
      : category === 'receipt' ? 'quick-capture-receipt'
        : category === 'serial' ? 'quick-capture-serial'
          : 'quick-capture-firearm';
    return String(file && file.name || fallback + extension);
  }

  function addCapture(category, dataURL, file) {
    const capture = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      category: normalizeCategory(category),
      dataURL: String(dataURL || ''),
      file: file || null,
      name: captureName(category, file),
      mime: String(file && file.type || (/^data:([^;,]+)/.exec(String(dataURL || '')) || [])[1] || 'application/octet-stream')
    };
    state.captures.push(capture);
    state.category = capture.category;
    state.imageDataURL = capture.dataURL;
    state.imageFile = capture.file;
    const count = element('quickCaptureArtifactCount');
    if (count) count.textContent = state.captures.length + ' capture' + (state.captures.length === 1 ? '' : 's') + ' ready';
    return capture;
  }

  function showPreview(dataURL) {
    const preview = element('quickCapturePreview');
    if (!preview) return;
    preview.src = dataURL;
    preview.hidden = false;
    const video = element('quickCaptureVideo');
    if (video && state.stream) video.hidden = true;
    const filename = element('quickCaptureFileName');
    if (filename) { filename.hidden = true; filename.textContent = ''; }
  }

  function filesFromInput(input) {
    if (input instanceof File || input instanceof Blob) return [input];
    if (input && input.target && input.target.files) return Array.from(input.target.files);
    if (input && input.files) return Array.from(input.files);
    return [];
  }

  async function handleFile(input, explicitCategory) {
    const files = filesFromInput(input);
    const category = captureCategory(input, explicitCategory);
    if (input && input.target) input.target.value = '';
    if (!files.length) return { ok: false, status: 'no-file' };
    const added = [];
    for (const file of files) {
      const type = String(file.type || '').toLowerCase();
      const pdfAllowed = type === 'application/pdf' && (category === 'receipt' || category === 'tax-stamp');
      if (!IMAGE_TYPES.has(type) && !pdfAllowed) {
        notify(category === 'receipt' || category === 'tax-stamp'
          ? 'Choose a PDF, JPEG, PNG, WebP, or GIF file.'
          : 'Choose a JPEG, PNG, WebP, or GIF image.', 'error');
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        notify('Choose a file smaller than 20 MB.', 'error');
        continue;
      }
      try {
        const dataURL = await readAsDataURL(file);
        const capture = addCapture(category, dataURL, file);
        added.push(capture);
        if (type.startsWith('image/')) showPreview(dataURL);
        else {
          const preview = element('quickCapturePreview');
          if (preview) { preview.removeAttribute('src'); preview.hidden = true; }
          const video = element('quickCaptureVideo');
          if (video && state.stream) video.hidden = true;
          const filename = element('quickCaptureFileName');
          if (filename) { filename.hidden = false; filename.textContent = file.name; }
        }
        if (type.startsWith('image/') && (category === 'serial' || category === 'firearm')) {
          clearResult();
          await analyzeImage(dataURL);
        }
      } catch (error) {
        notify('That file could not be opened: ' + (error.message || error), 'error');
      }
    }
    if (added.length && category !== 'serial' && category !== 'firearm') {
      setStatus(added.length + ' ' + (category === 'receipt' ? 'receipt' : 'tax-stamp') + ' capture' + (added.length === 1 ? '' : 's') + ' ready for review.', 'success');
    }
    return { ok: added.length > 0, status: added.length ? 'ready' : 'rejected', captures: added };
  }

  function canvasBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The camera frame could not be captured.')), 'image/jpeg', 0.9);
    });
  }

  async function captureSnapshot() {
    const video = element('quickCaptureVideo');
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      notify('The camera is still starting. Wait a moment and try again.', 'warning');
      return { ok: false, status: 'camera-not-ready' };
    }
    const canvas = element('quickCaptureCanvas') || document.createElement('canvas');
    const maxWidth = 2000;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Camera capture is unavailable in this browser.');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await canvasBlob(canvas);
    const category = captureCategory();
    const file = new File([blob], captureName(category, null), { type: 'image/jpeg' });
    const dataURL = canvas.toDataURL('image/jpeg', 0.9);
    addCapture(category, dataURL, file);
    showPreview(state.imageDataURL);
    setTimeout(() => {
      const modal = element('quickCaptureModal');
      const preview = element('quickCapturePreview');
      const liveVideo = element('quickCaptureVideo');
      if (state.stream && modal && modal.classList.contains('open')) {
        if (preview) preview.hidden = true;
        if (liveVideo) liveVideo.hidden = false;
      }
    }, 1000);
    if (category === 'serial' || category === 'firearm') return analyzeImage(state.imageDataURL);
    setStatus((category === 'receipt' ? 'Receipt' : 'Tax-stamp') + ' photo ready for review.', 'success');
    return { ok: true, status: 'ready', capture: state.captures[state.captures.length - 1] };
  }

  function lookupKey(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function inventory() {
    try {
      if (typeof db !== 'undefined' && db && Array.isArray(db.firearms)) return db.firearms;
    } catch (_) {}
    return global.db && Array.isArray(global.db.firearms) ? global.db.firearms : [];
  }

  function exactDuplicate(serial, firearms) {
    const key = lookupKey(serial);
    if (!key) return null;
    return (firearms || inventory()).find(item => lookupKey(item && item.serial) === key) || null;
  }

  function addSerialCandidate(candidates, raw, score, reason, labeled) {
    const value = String(raw || '').toUpperCase().replace(/^[^A-Z0-9]+|[^A-Z0-9-]+$/g, '').replace(/\s+/g, '');
    const key = lookupKey(value);
    if (key.length < 4 || key.length > 24) return;
    if (!/[0-9]/.test(key)) return;
    if (!labeled && !/[A-Z]/.test(key) && key.length < 6) return;
    if (!labeled && SERIAL_STOP_WORDS.has(key)) return;
    const existing = candidates.get(key);
    const candidate = { value, score, reason, labeled: Boolean(labeled) };
    if (!existing || candidate.score > existing.score) candidates.set(key, candidate);
  }

  function detectMake(text, firearms) {
    const source = lookupKey(text);
    const makes = new Map();
    COMMON_MAKES.forEach(make => makes.set(lookupKey(make), make));
    (firearms || []).forEach(item => {
      const make = String(item && item.make || '').trim();
      if (make) makes.set(lookupKey(make), make);
    });
    return [...makes.entries()]
      .filter(([key]) => key.length >= 2 && source.includes(key))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1] || '';
  }

  function detectModel(text, make, firearms) {
    const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
      const match = /\bMODEL\s*(?:NO\.?|NUMBER|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9 .\/-]{1,30})/i.exec(line);
      if (match) return match[1].trim().replace(/\s{2,}/g, ' ');
    }
    const source = lookupKey(text);
    const models = new Map();
    (firearms || []).forEach(item => {
      if (make && lookupKey(item && item.make) !== lookupKey(make)) return;
      const model = String(item && item.model || '').trim();
      if (model) models.set(lookupKey(model), model);
    });
    return [...models.entries()]
      .filter(([key]) => key.length >= 2 && source.includes(key))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1] || '';
  }

  function detectCaliber(text) {
    const source = String(text || '').toUpperCase().replace(/,/g, '.');
    const patterns = [
      /\b(\d{1,2}(?:\.\d+)?\s*[X×]\s*\d{2,3}(?:R)?)\b/,
      /\b(\d\.\d{2,3}(?:\s*NATO)?)\b/,
      /\b(\d{1,2}(?:\.\d+)?\s*MM)\b/,
      /\b(\d{2,3}\s*(?:ACP|AUTO|NATO|MAGNUM|MAG|SPECIAL|SPL))\b/,
      /(?:^|\s)(\.\d{2,3})(?:\s|$)/,
      /\b(\d{2}\s*(?:GAUGE|GA))\b/,
      /\b(410\s*(?:BORE|GAUGE|GA))\b/
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(source);
      if (match) return match[1].replace(/\s+/g, ' ').replace(/×/g, 'x').trim();
    }
    return '';
  }

  function detectType(text) {
    const source = String(text || '').toUpperCase();
    if (/\b(SUPPRESSOR|SILENCER)\b/.test(source)) return 'Silencer';
    if (/\bSHOTGUN\b/.test(source)) return 'Shotgun';
    if (/\bREVOLVER\b/.test(source)) return 'Revolver';
    if (/\bPISTOL\b/.test(source)) return 'Pistol';
    if (/\bRIFLE\b/.test(source)) return 'Rifle';
    return '';
  }

  function analyzeText(text, records) {
    const raw = String(text || '').replace(/[–—]/g, '-').replace(/\u0000/g, '');
    const firearms = Array.isArray(records) ? records : inventory();
    const candidates = new Map();
    const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

    lines.forEach(line => {
      const labeled = /(?:\bSERIAL(?:\s*(?:NO\.?|NUMBER|#))?|\bSER\.?\s*NO\.?|\bS\s*\/\s*N|\bSN)\s*[:#.-]*\s*([A-Z0-9][A-Z0-9 -]{2,24})/i.exec(line);
      if (labeled) {
        const value = labeled[1].trim().split(/\s{2,}|\s+(?=(?:CAL|MODEL|MADE|WARNING|PISTOL|RIFLE|REVOLVER|SHOTGUN|SUPPRESSOR|SILENCER)\b)/i)[0];
        addSerialCandidate(candidates, value, 90, 'Found after a serial-number label', true);
      }
      (line.toUpperCase().match(/\b[A-Z0-9][A-Z0-9-]{3,23}\b/g) || []).forEach(token => {
        let score = 35;
        if (/[A-Z]/.test(token) && /[0-9]/.test(token)) score += 20;
        if (token.length >= 5 && token.length <= 16) score += 10;
        addSerialCandidate(candidates, token, score, 'Possible identifier in the image', false);
      });
    });

    const ranked = [...candidates.values()].map(candidate => {
      const duplicate = exactDuplicate(candidate.value, firearms);
      return Object.assign({}, candidate, {
        score: candidate.score + (duplicate ? 15 : 0),
        duplicate: duplicate ? { id: duplicate.id, make: duplicate.make || '', model: duplicate.model || '', serial: duplicate.serial || '' } : null
      });
    }).sort((a, b) => b.score - a.score || a.value.localeCompare(b.value)).slice(0, 5);

    const serial = ranked[0]?.value || '';
    const duplicate = exactDuplicate(serial, firearms);
    const make = detectMake(raw, firearms);
    return {
      rawText: raw.trim(),
      serial,
      serialCandidates: ranked,
      make,
      model: detectModel(raw, make, firearms),
      caliber: detectCaliber(raw),
      type: detectType(raw),
      duplicate: duplicate ? { id: duplicate.id, make: duplicate.make || '', model: duplicate.model || '', serial: duplicate.serial || '' } : null
    };
  }

  function writeValue(id, value) {
    const control = element(id);
    if (control) control.value = value || '';
  }

  function renderAnalysis(analysis) {
    writeValue('quickCaptureRawText', analysis.rawText);
    writeValue('quickCaptureSerial', analysis.serial);
    writeValue('quickCaptureMake', analysis.make);
    writeValue('quickCaptureModel', analysis.model);
    writeValue('quickCaptureCaliber', analysis.caliber);
    writeValue('quickCaptureType', analysis.type);
    const result = element('quickCaptureResult');
    if (result) result.hidden = false;
    const duplicate = element('quickCaptureDuplicate');
    if (duplicate) {
      duplicate.hidden = !analysis.duplicate;
      duplicate.textContent = analysis.duplicate
        ? 'Already in the vault: ' + [analysis.duplicate.make, analysis.duplicate.model].filter(Boolean).join(' ') + ' (' + analysis.duplicate.serial + ')'
        : '';
    }
  }

  async function ensureOCR() {
    if (typeof global.ensureFeatureAsset === 'function') {
      return global.ensureFeatureAsset('ocr', 'Mobile Quick Capture');
    }
    if (global.VaultAssets && typeof global.VaultAssets.ensure === 'function') {
      await global.VaultAssets.ensure('ocr');
      return true;
    }
    return Boolean(global.Tesseract);
  }

  async function analyzeImage(source) {
    const image = source || state.imageDataURL;
    if (!image) {
      notify('Capture or choose a photo first.', 'warning');
      return { ok: false, status: 'no-image' };
    }
    if (state.recognizing) return { ok: false, status: 'busy' };
    const operation = ++state.operation;
    setBusy(true);
    setStatus('Loading the on-device text scanner…', 'info');
    const progress = element('quickCaptureProgress');
    if (progress) { progress.hidden = false; progress.max = 1; progress.value = 0; }
    try {
      if (!await ensureOCR() || !global.Tesseract || typeof global.Tesseract.recognize !== 'function') {
        throw new Error('The local OCR library is unavailable.');
      }
      if (operation !== state.operation) return { ok: false, status: 'cancelled' };
      const result = await global.Tesseract.recognize(image, 'eng', {
        workerPath: 'vendor/tesseract/worker.min.js',
        corePath: 'vendor/tesseract',
        langPath: 'vendor/tesseract/lang',
        workerBlobURL: false,
        gzip: true,
        logger(message) {
          if (operation !== state.operation) return;
          if (progress && Number.isFinite(message.progress)) progress.value = message.progress;
          if (message.status) setStatus('Scanning locally: ' + message.status, 'info');
        }
      });
      if (operation !== state.operation) return { ok: false, status: 'cancelled' };
      const analysis = analyzeText(result && result.data && result.data.text || '');
      analysis.ocrConfidence = Number(result && result.data && result.data.confidence) || 0;
      state.rawText = analysis.rawText;
      state.analysis = analysis;
      renderAnalysis(analysis);
      setStatus(analysis.serial
        ? 'Review the suggested details. Nothing is saved until you approve and then save the firearm form.'
        : 'No clear serial number was found. Edit the suggestions or try a closer photo.', analysis.serial ? 'success' : 'warning');
      return { ok: true, analysis };
    } catch (error) {
      if (operation === state.operation) {
        setStatus('Text scanning failed. Try a sharper, closer photo with less glare.', 'error');
        notify('Quick Capture OCR failed: ' + (error.message || error), 'error', 8000);
      }
      return { ok: false, status: 'ocr-failed', error };
    } finally {
      if (operation === state.operation) setBusy(false);
      if (progress) progress.hidden = true;
    }
  }

  function candidateFromUI() {
    const value = (id, fallback) => {
      const control = element(id);
      return String(control ? control.value : fallback || '').trim();
    };
    const analysis = state.analysis || {};
    return {
      serial: value('quickCaptureSerial', analysis.serial),
      make: value('quickCaptureMake', analysis.make),
      model: value('quickCaptureModel', analysis.model),
      caliber: value('quickCaptureCaliber', analysis.caliber),
      type: value('quickCaptureType', analysis.type)
    };
  }

  function dispatchReviewEvent(control, type) {
    if (!control) return;
    control.dispatchEvent(new Event(type || 'input', { bubbles: true }));
  }

  function fillReviewForm(candidate) {
    const mapping = [
      ['fMake', 'make'], ['fModel', 'model'], ['fSerial', 'serial'], ['fCaliber', 'caliber']
    ];
    const primaryWasEmpty = mapping.every(([id]) => {
      const control = element(id);
      return !control || !String(control.value || '').trim();
    });
    const applied = [];
    const preserved = [];
    mapping.forEach(([id, key]) => {
      const control = element(id);
      const value = String(candidate[key] || '').trim();
      if (!control || !value) return;
      if (String(control.value || '').trim()) { preserved.push(key); return; }
      control.value = value;
      dispatchReviewEvent(control, 'input');
      applied.push(key);
    });
    const type = element('fType');
    if (type && candidate.type && primaryWasEmpty) {
      const valid = Array.from(type.options || []).some(option => option.value === candidate.type);
      if (valid) { type.value = candidate.type; dispatchReviewEvent(type, 'change'); applied.push('type'); }
    }
    if (typeof global.checkDuplicateSerial === 'function') global.checkDuplicateSerial();
    return { applied, preserved };
  }

  async function attachReviewPhoto(dataURL, file) {
    if (!dataURL) return null;
    if (typeof global.queueFirearmImage === 'function') {
      let upload = file;
      if (!upload) {
        const response = await fetch(dataURL);
        const blob = await response.blob();
        upload = new File([blob], 'quick-capture.jpg', { type: blob.type || 'image/jpeg' });
      }
      return global.queueFirearmImage(upload);
    }
    // Compatibility fallback for builds where queueFirearmImage is not exposed.
    if (typeof imagesDb === 'undefined' || typeof tempImages === 'undefined' || typeof idbPut !== 'function') return null;
    const id = typeof global.generateId === 'function'
      ? global.generateId()
      : Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const compressed = typeof global.compressImage === 'function'
      ? await global.compressImage(dataURL, 1600, 0.8)
      : dataURL;
    imagesDb[id] = compressed;
    await idbPut(id, compressed);
    tempImages.push(id);
    if (typeof global.renderImageGallery === 'function') global.renderImageGallery();
    if (typeof global.saveFirearmDraftSoon === 'function') global.saveFirearmDraftSoon();
    return id;
  }

  function newReviewId() {
    return typeof global.generateId === 'function'
      ? global.generateId()
      : Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function addReviewDocument(capture, name) {
    try {
      if (typeof tempDocs === 'undefined' || !Array.isArray(tempDocs)) return false;
      tempDocs.push({
        id: newReviewId(),
        name: String(name || capture.name || 'Quick Capture attachment'),
        type: capture.mime || '',
        data: capture.dataURL
      });
      if (typeof global.renderDocList === 'function') global.renderDocList();
      return true;
    } catch (_) { return false; }
  }

  function setReviewReceipt(capture) {
    try {
      if (typeof tempReceipts === 'undefined' || !tempReceipts) return false;
      tempReceipts.f = capture.dataURL;
      tempReceipts.fName = capture.name || 'quick-capture-receipt';
      if (typeof global.showReceiptInUploadArea === 'function') {
        global.showReceiptInUploadArea('f', tempReceipts.f, tempReceipts.fName);
      }
      return true;
    } catch (_) { return false; }
  }

  function imageDimensions(dataURL) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height, image });
      image.onerror = () => reject(new Error('The tax-stamp image could not be prepared for review.'));
      image.src = dataURL;
    });
  }

  async function taxStampPDF(capture) {
    if (capture.mime === 'application/pdf' || /^data:application\/pdf/i.test(capture.dataURL)) {
      return { data: capture.dataURL, name: capture.name || 'quick-capture-tax-stamp.pdf' };
    }
    if (typeof global.ensureFeatureAsset === 'function') {
      const ready = await global.ensureFeatureAsset('pdf', 'Tax-stamp photo review');
      if (!ready) throw new Error('The tax-stamp PDF converter is unavailable.');
    } else if (global.VaultAssets && typeof global.VaultAssets.ensure === 'function') {
      await global.VaultAssets.ensure('pdf');
    }
    const PDF = global.jspdf && global.jspdf.jsPDF;
    if (!PDF) throw new Error('The tax-stamp PDF converter is unavailable.');
    const dimensions = await imageDimensions(capture.dataURL);
    const landscape = dimensions.width > dimensions.height;
    const doc = new PDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'pt', format: 'letter' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const scale = Math.min((pageWidth - 48) / dimensions.width, (pageHeight - 48) / dimensions.height);
    const width = dimensions.width * scale;
    const height = dimensions.height * scale;
    let imageData = capture.dataURL;
    let format = capture.mime === 'image/png' ? 'PNG' : 'JPEG';
    if (!['image/png', 'image/jpeg'].includes(capture.mime)) {
      const canvas = document.createElement('canvas');
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      canvas.getContext('2d', { alpha: false }).drawImage(dimensions.image, 0, 0);
      imageData = canvas.toDataURL('image/jpeg', 0.92);
      format = 'JPEG';
    }
    doc.addImage(imageData, format, (pageWidth - width) / 2, (pageHeight - height) / 2, width, height);
    const bytes = new Uint8Array(doc.output('arraybuffer'));
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
    }
    return {
      data: 'data:application/pdf;base64,' + btoa(binary),
      name: String(capture.name || 'quick-capture-tax-stamp').replace(/\.[^.]+$/, '') + '.pdf'
    };
  }

  async function setReviewTaxStamp(capture) {
    const prepared = await taxStampPDF(capture);
    try {
      if (typeof tempStampPdf === 'undefined' || typeof tempStampPdfName === 'undefined') return false;
      tempStampPdf = prepared.data;
      tempStampPdfName = prepared.name;
      const nfa = element('fIsNFA');
      if (nfa && !nfa.checked) { nfa.checked = true; dispatchReviewEvent(nfa, 'change'); }
      if (typeof global.toggleNFAFields === 'function') global.toggleNFAFields();
      if (typeof global.showStampInUploadArea === 'function') global.showStampInUploadArea(tempStampPdf, tempStampPdfName);
      return true;
    } catch (_) { return false; }
  }

  async function handoffCaptures(captures, attachPhotos) {
    const result = { photos: [], receipt: false, taxStamp: false, documents: 0, failures: [] };
    for (const capture of captures) {
      try {
        if (capture.category === 'firearm' || capture.category === 'serial') {
          if (attachPhotos && capture.mime.startsWith('image/')) {
            const id = await attachReviewPhoto(capture.dataURL, capture.file);
            if (id) result.photos.push(id);
          }
        } else if (capture.category === 'receipt') {
          if (!result.receipt && setReviewReceipt(capture)) result.receipt = true;
          else if (addReviewDocument(capture, 'Additional receipt - ' + capture.name)) result.documents += 1;
          else throw new Error('The receipt could not be attached to the review form.');
        } else if (capture.category === 'tax-stamp') {
          if (!result.taxStamp && await setReviewTaxStamp(capture)) result.taxStamp = true;
          else if (addReviewDocument(capture, 'Additional tax stamp - ' + capture.name)) result.documents += 1;
          else throw new Error('The tax stamp could not be attached to the review form.');
        }
      } catch (error) {
        result.failures.push({ category: capture.category, name: capture.name, error: error.message || String(error) });
      }
    }
    if ((result.receipt || result.taxStamp || result.documents) && typeof global.saveFirearmDraftSoon === 'function') {
      global.saveFirearmDraftSoon();
    }
    return result;
  }

  async function approveToReview() {
    const candidate = candidateFromUI();
    if (!candidate.serial && !candidate.make && !candidate.model && !candidate.caliber && !state.captures.length) {
      notify('Capture an item, serial number, receipt, or tax stamp first.', 'warning');
      return { ok: false, status: 'empty' };
    }
    const duplicate = candidate.serial && exactDuplicate(candidate.serial);
    if (duplicate) {
      state.analysis = Object.assign({}, state.analysis || {}, {
        duplicate: { id: duplicate.id, make: duplicate.make || '', model: duplicate.model || '', serial: duplicate.serial || '' }
      });
      renderAnalysis(Object.assign({ rawText: state.rawText, serialCandidates: [] }, state.analysis, candidate));
      setStatus('That serial number already exists. Open the existing item instead of creating a duplicate.', 'error');
      return { ok: false, status: 'duplicate', duplicate };
    }
    if (typeof global.openAddModal !== 'function') throw new Error('The Add Firearm form is unavailable.');
    const captures = state.captures.map(capture => Object.assign({}, capture));
    // Preserve compatibility with callers that supplied one image before the
    // multi-artifact capture contract was introduced.
    if (!captures.length && state.imageDataURL) {
      captures.push({
        id: newReviewId(), category: state.category || 'serial', dataURL: state.imageDataURL,
        file: state.imageFile, name: captureName(state.category || 'serial', state.imageFile),
        mime: String(state.imageFile && state.imageFile.type || 'image/jpeg')
      });
    }
    const attachControl = element('quickCaptureAttachPhoto');
    const attachPhoto = attachControl ? Boolean(attachControl.checked) : true;
    close();
    await global.openAddModal();
    const merged = fillReviewForm(candidate);
    const artifacts = await handoffCaptures(captures, attachPhoto);
    if (artifacts.failures.length) {
      notify('The captured details are ready, but ' + artifacts.failures.length + ' artifact' + (artifacts.failures.length === 1 ? '' : 's') + ' could not be attached. Keep the form open and review it.', 'error', 9000);
    }
    const focus = element(candidate.serial ? 'fSerial' : candidate.make ? 'fMake' : 'fModel');
    if (focus) focus.focus();
    if (merged.preserved.length) {
      notify('Quick Capture opened the review form without replacing an existing draft. Review the preserved fields before saving.', 'warning', 8000);
    } else {
      notify('Quick Capture details are ready for review. Save the firearm form when everything is correct.', 'success', 6500);
    }
    state.imageDataURL = '';
    state.imageFile = null;
    state.captures = [];
    return { ok: true, candidate, applied: merged.applied, preserved: merged.preserved, artifacts };
  }

  function openExistingMatch() {
    const duplicate = state.analysis && state.analysis.duplicate;
    if (!duplicate || !duplicate.id || typeof global.openDetail !== 'function') return false;
    close();
    global.openDetail(duplicate.id);
    return true;
  }

  global.QuickCapture = Object.freeze({
    open,
    close,
    reset,
    handleFile,
    setCategory,
    captureSnapshot,
    analyzeImage,
    analyzeText,
    approveToReview,
    openExistingMatch,
    getState: () => ({
      hasImage: Boolean(state.imageDataURL),
      category: state.category,
      captures: state.captures.map(capture => ({ id: capture.id, category: capture.category, name: capture.name, mime: capture.mime })),
      recognizing: state.recognizing,
      analysis: state.analysis ? structuredClone(state.analysis) : null
    })
  });

  // Narrow global aliases for declarative controls and the command palette.
  global.openQuickCaptureModal = open;
  global.closeQuickCaptureModal = close;
  global.resetQuickCapture = reset;
  global.handleQuickCaptureFile = handleFile;
  global.setQuickCaptureCategory = setCategory;
  global.captureQuickCaptureSnapshot = captureSnapshot;
  global.analyzeQuickCaptureImage = analyzeImage;
  global.approveQuickCaptureToReview = approveToReview;
  global.openQuickCaptureExistingMatch = openExistingMatch;

  global.addEventListener('pagehide', stopCamera);
})(window);
